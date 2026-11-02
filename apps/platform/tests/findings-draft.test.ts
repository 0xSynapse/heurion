import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { buildApi } from '../src/http/api.ts'
import { FindingsDraftService, sortNodules } from '../src/imaging/findings-draft.ts'
import { BUILTIN_TEMPLATE, escapeMarkdown, parseSentence, parseTemplate, PLACEHOLDERS, renderSentence } from '../src/imaging/findings-template.ts'
import { ImagingReviewService } from '../src/imaging/review.ts'
import { risPlainText } from '../src/imaging/ris-text.ts'
import { ImagingStudyService } from '../src/imaging/studies.ts'
import { MeasurementService } from '../src/measurements/service.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { parseBlocks, plainText, serializeBlock } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { dicom, FakeOrthanc } from './imaging-fakes.ts'

/**
 * 结构化所见草稿（T2.6：W4.1 科室模板、W4.4 自由编辑与按轮撤销、W4.5 一期 RIS 纯文本）：
 * 模板语法与注入、只用已确认的非影子结节、确定性、测量原子、重复生成不覆盖医生修改、来源变化后的核对、RIS 纯文本、权限与接口。
 * 随访对比相关（新发 / 增大 / 稳定 / 消失、随访派生测量）见 findings-draft-followup.test.ts。
 */

const STUDY = '1.2.840.113619.2.55.3.7001'
const SERIES = `${STUDY}.2`
const N1 = { long_axis_mm: 9.1, short_axis_mm: 7.3, mean_diameter_mm: 8.2, volume_mm3: 288.4, mean_hu: -12, nodule_type: 'solid', segmentation: 'vista3d' }
const N2 = { long_axis_mm: 5.5, short_axis_mm: 5.5, mean_diameter_mm: 5.5, volume_mm3: null, nodule_type: null, segmentation: 'failed' }

const code = (fn: () => unknown): string | null => {
  try { fn(); return null } catch (err) { return (err as { code?: string }).code ?? String(err) }
}

function env() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-draft-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const user = (username: string, display_name: string, role: 'admin' | 'member' = 'member') => store.createUser({ username, display_name, password_hash: 'x', tenant: { id: hosp.id, role } }).id
  const admin = user('admin_li', '李主任', 'admin')
  const dr = user('dr_wang', '王医生')
  const rev = user('dr_chen', '陈主任')
  const outsider = user('dr_zhao', '赵医生')
  const orthanc = new FakeOrthanc()
  const svc = new ImagingStudyService(patients, orthanc)
  const review = new ImagingReviewService(patients, u => store.getUser(u)?.display_name ?? null)
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  review.setReadingRole(as(admin), rev, 'reviewer', (u, tid) => store.getUser(u)?.tenant_id === tid)
  const drafts = new FindingsDraftService(store, docs, ops, patients)
  return { store, docs, ops, tenants, patients, hosp, admin, dr, rev, outsider, orthanc, svc, review, as, drafts, A: as(dr) }
}

/** 一位患者、一个检查、一次完成的分析：AI 检出 2 个（结节 1 右上叶、结节 2 左下叶分割失败）+ 1 个被否决的 + 1 个影子检出 */
async function seeded(opts: { confirm?: boolean } = {}) {
  const t = env()
  const p = t.patients.create(t.A, { sex: 'M', birth_year: 1958 })
  t.patients.addMember(t.A, p.id, t.rev)
  const study = (await t.svc.importDicom(t.A, p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])).studies[0]!
  const run = t.svc.startRun(t.A, study.id, { task: 'lung_nodule', model_id: 'lung_nodule_pipeline' })
  t.svc.setRunStatus(t.A, run.id, 'done', null, { summary: { found: 3 } })
  // 左下叶的先建：排序要按肺叶而不是建立顺序
  const n2 = t.svc.addLesion(t.A, study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', label: '结节 2', location: 'LLL', metrics: N2 })
  const n1 = t.svc.addLesion(t.A, study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', label: '结节 1', location: 'RUL', metrics: N1 })
  const n3 = t.svc.addLesion(t.A, study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', label: '结节 3', location: 'RML', metrics: { mean_diameter_mm: 3.1 } })
  const shadowRun = t.svc.startRun(t.A, study.id, { task: 'lung_nodule', model_id: 'lung_nodule_pipeline', visibility: 'shadow' })
  const shadow = t.svc.addLesion(t.A, study.id, { run_id: shadowRun.id, kind: 'lung_nodule', source: 'ai', label: '影子结节', location: 'RUL', metrics: { mean_diameter_mm: 12.5, volume_mm3: 900 } })
  if (opts.confirm !== false) {
    t.svc.reviewLesion(t.A, n1.id, { status: 'confirmed' })
    t.svc.reviewLesion(t.A, n2.id, { status: 'confirmed' })
    t.svc.reviewLesion(t.A, n3.id, { status: 'rejected', reason: '血管断面' })
  }
  return { ...t, p, study, run, n1, n2, n3, shadow }
}

const topText = (t: { docs: Documents }, docId: string) => { const out: string[] = []; t.docs.get(docId).forEach(n => out.push(plainText(n))); return out }
/** 正文文字（测量原子替换为当前显示值） */
function shown(t: { docs: Documents; store: Store; patients: PatientService }, docId: string, viewer: Actor): string[] {
  const views = new MeasurementService(t.store, t.patients).views(t.store.getDoc(docId)!, viewer)
  return topText(t, docId).map(s => s.replace(/\[@m:([a-z0-9]+)\]/g, (_, id) => views.get(id)?.text ?? '??'))
}

describe('模板语法（纯函数）', () => {
  it('内置模板可解析；可选片段在没有值时整段省略，{名称|缺省} 在没有值时用缺省文字', () => {
    const tpl = parseTemplate(BUILTIN_TEMPLATE)
    const parts = renderSentence(tpl.nodule.default!, { 序号: '1', 位置: null, 密度: '实性', 平均径: { atom: 'a' }, 体积: null })
    expect(parts).toEqual([{ text: '1. 肺内见实性结节，平均径 ' }, { atom: 'a' }, { text: '。' }])
    const withVol = renderSentence(tpl.nodule.default!, { 序号: '2', 位置: '右肺上叶', 密度: null, 平均径: { atom: 'a' }, 体积: { atom: 'b' } })
    expect(withVol).toEqual([{ text: '2. 右肺上叶见结节，平均径 ' }, { atom: 'a' }, { text: '，体积 ' }, { atom: 'b' }, { text: '。' }])
  })

  it('语法错误、未知占位符、超长、换行、模板里写测量数字一律拒绝并指出哪一句', () => {
    const err = (body: unknown) => { try { parseTemplate(body); return null } catch (e) { return (e as Error).message } }
    expect(err({ ...BUILTIN_TEMPLATE, nodule: { default: '{位置}见{大小}结节' } })).toMatch(/nodule\.default.*不认识的占位符「\{大小\}」/)
    expect(err({ ...BUILTIN_TEMPLATE, nodule: { default: '{位置见结节' } })).toMatch(/没有配对的「\}」/)
    expect(err({ ...BUILTIN_TEMPLATE, nodule: { default: '见结节}' } })).toMatch(/没有配对的「\{」/)
    expect(err({ ...BUILTIN_TEMPLATE, nodule: { default: '[a[{位置}]]' } })).toMatch(/不能嵌套/)
    expect(err({ ...BUILTIN_TEMPLATE, nodule: { default: '[，体积]' } })).toMatch(/至少要有一个占位符/)
    expect(err({ ...BUILTIN_TEMPLATE, nodule: { default: '第一句\n第二句' } })).toMatch(/换行/)
    expect(err({ ...BUILTIN_TEMPLATE, nodule: { default: 'x'.repeat(401) } })).toMatch(/太长/)
    expect(err({ ...BUILTIN_TEMPLATE, nodule: { default: '{位置}见结节，约 8 mm。' } })).toMatch(/模板文字里不能写测量数字（8mm）/)
    expect(err({ ...BUILTIN_TEMPLATE, nodule: { default: '{平均径|5 mm}' } })).toMatch(/不能写缺省文字/)
    expect(err({ ...BUILTIN_TEMPLATE, none: '与{平均径}' })).toMatch(/none.*不认识的占位符/)
    expect(err({ ...BUILTIN_TEMPLATE, extra: 1 })).toMatch(/不认识的字段「extra」/)
    expect(err({ ...BUILTIN_TEMPLATE, nodule: { default: 'ok', bigger: 'x' } })).toMatch(/不认识的情况「bigger」/)
    expect(err({ ...BUILTIN_TEMPLATE, title: '' })).toMatch(/标题不能为空/)
    expect(err('{"title":1}')).toMatch(/应为 JSON 对象/)
    // 指南阈值（比较词）可以写
    expect(err({ ...BUILTIN_TEMPLATE, closing: '≥ 6 mm 的实性结节建议随访。' })).toBeNull()
    // 字面量转义
    expect(renderSentence(parseSentence('\\{位置\\} \\[x\\] a\\|b \\\\', 't', PLACEHOLDERS.nodule), {})).toEqual([{ text: '{位置} [x] a|b \\' }])
  })

  it('注入：模板与位置里的 markdown / HTML / 原子记号转义后按字面显示，不变成格式、原子、标题或块 id', () => {
    const evil = '# **粗体** <u>下划线</u> <script>x</script> [@m:mabc1234] {#abc123} [链接](http://x) 1. 列表 `代码` &lt; \\'
    const nodes = parseBlocks(escapeMarkdown(evil))
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.type.name).toBe('paragraph')
    expect(plainText(nodes[0]!)).toBe(evil)
    let atoms = 0, marks = 0
    nodes[0]!.descendants(n => { if (n.type.name === 'measurement') atoms++; if (n.marks.length) marks++; return true })
    expect([atoms, marks]).toEqual([0, 0])
  })

  it('结节排序：肺叶（右上→左下，未定位在后）→ 平均径从大到小 → 编号，稳定可重复', () => {
    const L = (id: string, location: string | null, d: number, label: string) => ({ id, location, label, metrics: { mean_diameter_mm: d } })
    const list = [L('e', null, 20, '结节 5'), L('d', 'LLL', 6, '结节 4'), L('c', '右肺上叶', 4, '结节 3'), L('b', 'RUL', 9, '结节 10'), L('a', 'RUL', 9, '结节 2')]
    expect(sortNodules(list).map(x => x.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(sortNodules([...list].reverse()).map(x => x.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('生成所见草稿', () => {
  it('只写已确认的非影子结节，按肺叶排序；测量都是绑定已确认病灶的 [@m:]；正文没有裸测量数字；标注未定稿', async () => {
    const t = await seeded()
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    expect(r.created).toBe(true)
    expect(r.nodules).toBe(2)
    expect(r.template).toMatchObject({ source: 'builtin', version: 1 })
    expect(r.review_state).toBe('reading')
    expect(shown(t, r.doc_id, t.A)).toEqual([
      '影像所见',
      '〔草稿〕本检查尚未定稿：以下所见据当前已确认的结节生成，定稿前可能变化。',
      '无前片可供比较。',
      '1. 右肺上叶见实性结节，平均径 8.2 mm，体积 288 mm³。',
      '2. 左下叶见结节，平均径 5.5 mm。'.replace('左下叶', '左肺下叶'),
    ])
    const text = topText(t, r.doc_id).join('\n')
    expect(text).not.toContain('结节 3')
    expect(text).not.toContain('12.5')
    // 测量登记只指向已确认病灶，影子 / 否决的不在其中
    const rows = t.store.listMeasurements(r.doc_id)
    expect(new Set(rows.map(m => m.source_id))).toEqual(new Set([t.n1.id, t.n2.id]))
    expect(rows.map(m => m.field).sort()).toEqual(['mean_diameter_mm', 'mean_diameter_mm', 'volume_mm3'])
    expect(r.warnings).toContain('结节 2分割失败：没有体积，径线取检出框')
    // 文档关联到患者（所见草稿），标题只用代号
    const row = t.store.getDoc(r.doc_id)!
    expect(JSON.parse(row.context!)).toMatchObject({ kind: 'patient', patient_id: t.p.id, doc_kind: 'findings' })
    expect(row.title).toBe(`${t.p.code} 胸部 CT 所见草稿 · 2026-10-20`)
    // 写入记为 AI（经操作层与守卫），不是医生的修改
    expect(t.store.lastChangeBy(r.doc_id, t.docs.get(r.doc_id).child(3).attrs.id as string, 'user')).toBe(0)
    expect(r.elapsed_ms).toBeLessThan(10_000)
  })

  it('有待确认的 AI 检出时拒绝（pending_lesions）；影子检出不算待确认', async () => {
    const t = await seeded({ confirm: false })
    expect(code(() => t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null }))).toBe('pending_lesions')
    expect(t.store.listDocs(t.dr).length + t.patients.read(t.A, t.p.id).documents.length).toBe(0)
    t.svc.reviewLesion(t.A, t.n1.id, { status: 'confirmed' })
    t.svc.reviewLesion(t.A, t.n2.id, { status: 'rejected', reason: '伪影' })
    t.svc.reviewLesion(t.A, t.n3.id, { status: 'rejected', reason: '伪影' })
    // 影子检出（12.5 mm）仍是 proposed，但不可见、不挡生成、不进草稿
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    expect(r.nodules).toBe(1)
    expect(shown(t, r.doc_id, t.A).join('\n')).not.toMatch(/12\.5|900/)
  })

  it('没有已确认结节：分析完成且都否决了 → 「双肺未见明确结节」；没有分析也没有定稿 → 拒绝（not_read）；影子模式另有说明', async () => {
    const t = await seeded({ confirm: false })
    for (const l of [t.n1, t.n2, t.n3]) t.svc.reviewLesion(t.A, l.id, { status: 'rejected', reason: '伪影' })
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    expect(topText(t, r.doc_id).slice(2)).toEqual(['无前片可供比较。', '双肺未见明确结节。'])
    expect(t.store.listMeasurements(r.doc_id)).toEqual([])

    const u = env()
    const p = u.patients.create(u.A, {})
    const st = (await u.svc.importDicom(u.A, p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])).studies[0]!
    expect(code(() => u.drafts.generate(u.A, p.id, { study_id: st.id }, { turnId: null }))).toBe('not_read')
    // 影子模式：只有影子运行，结果不可见
    u.tenants.update(u.admin, { settings: { imaging_ai_visibility: 'shadow' } })
    const sr = u.svc.startRun(u.A, st.id, { task: 'lung_nodule', model_id: 'x', visibility: 'shadow' })
    u.svc.setRunStatus(u.A, sr.id, 'done')
    u.svc.addLesion(u.A, st.id, { run_id: sr.id, kind: 'lung_nodule', source: 'ai', label: '影子', location: 'RUL', metrics: { mean_diameter_mm: 9 } })
    let msg = ''
    try { u.drafts.generate(u.A, p.id, { study_id: st.id }, { turnId: null }) } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('影子模式')
    // 医生在阅片器里补充的结节（直接为已确认）照常进草稿
    u.svc.addLesion(u.A, st.id, { kind: 'lung_nodule', source: 'manual', label: '医生补充 1', location: 'LUL', metrics: { mean_diameter_mm: 6.1 } })
    const r2 = u.drafts.generate(u.A, p.id, { study_id: st.id }, { turnId: null })
    expect(shown(u, r2.doc_id, u.A)[3]).toBe('1. 左肺上叶见结节，平均径 6.1 mm。')
  })

  it('定稿后生成：状态行写明定稿版本；定稿为「未见结节」也可以生成', async () => {
    const t = await seeded()
    t.review.submitRead(t.A, t.study.id)
    const V = t.as(t.rev)
    t.review.finalize(V, t.study.id, { expected_revision: t.review.view(V, t.study.id).revision })
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    expect(r).toMatchObject({ review_state: 'finalized', signoff_version: 1 })
    expect(topText(t, r.doc_id)[1]).toMatch(/^〔草稿〕据本检查第 1 版定稿（\d{4}-\d{2}-\d{2}）的结节生成。$/)

    const u = env()
    const p = u.patients.create(u.A, {})
    u.patients.addMember(u.A, p.id, u.rev)
    const st = (await u.svc.importDicom(u.A, p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])).studies[0]!
    u.review.submitRead(u.A, st.id)
    u.review.finalize(u.as(u.rev), st.id, { expected_revision: u.review.view(u.as(u.rev), st.id).revision })
    expect(topText(u, u.drafts.generate(u.A, p.id, { study_id: st.id }, { turnId: null }).doc_id).at(-1)).toBe('双肺未见明确结节。')
  })

  it('确定性：同样的输入同样的输出；结节没有位置时用缺省文字', async () => {
    const t = await seeded()
    t.svc.editLesion(t.A, t.n2.id, { location: null })
    const a = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    const b = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id, new: true }, { turnId: null })
    expect(shown(t, a.doc_id, t.A)).toEqual(shown(t, b.doc_id, t.A))
    expect(shown(t, a.doc_id, t.A)[4]).toBe('2. 肺内见结节，平均径 5.5 mm。')
    expect(a.warnings).toContain('结节 2没有肺叶定位')
  })
})

describe('重复生成与医生的修改', () => {
  it('已有草稿时拒绝（draft_exists 带 doc_id）；带 doc_id 更新：没变化时一块也不改', async () => {
    const t = await seeded()
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    let extra: Record<string, unknown> = {}
    try { t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null }) } catch (e) { extra = { code: (e as { code: string }).code, ...(e as { extra: object }).extra } }
    expect(extra).toMatchObject({ code: 'draft_exists', doc_id: r.doc_id })
    const rev = t.docs.rev(r.doc_id)
    const again = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id, doc_id: r.doc_id }, { turnId: null })
    expect(again).toMatchObject({ created: false, rev })
    expect(again.blocks.written).toEqual([])
    expect(again.blocks.unchanged.length).toBe(5)
    expect(t.drafts.getDraft(r.doc_id)!.generations).toBe(2)
  })

  it('医生改过的段落原样保留；新确认的结节插在排序位置；被否决的结节：没人改过的句子删除，改过的保留并提示', async () => {
    const t = await seeded()
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    const ids = () => { const out: string[] = []; t.docs.get(r.doc_id).forEach(n => out.push(n.attrs.id as string)); return out }
    const [, , , b1, b2] = ids()
    // 医生改了结节 1 的句子（加了描述）
    t.ops.edit({ doc_id: r.doc_id, base_rev: t.docs.rev(r.doc_id), mode: 'apply', ops: [{ op: 'replace_text', id: b1!, find: '实性结节', replace: '实性结节，边缘见分叶' }] }, { actor: 'user', turnId: null, user: t.dr })
    const edited = serializeBlock(t.docs.get(r.doc_id).child(3), {}, '')
    // 来源变化：结节 1 重测并改了密度分型（重新生成的句子与上次不同）、补充一个右中叶结节、结节 2 被撤销确认（否决）
    t.svc.editLesion(t.A, t.n1.id, { metrics: { ...N1, mean_diameter_mm: 8.6, nodule_type: 'part_solid' } })
    t.svc.addLesion(t.A, t.study.id, { kind: 'lung_nodule', source: 'manual', label: '医生补充 1', location: 'RML', metrics: { mean_diameter_mm: 4.2, nodule_type: 'pure_ggo' } })
    t.svc.reviewLesion(t.A, t.n2.id, { status: 'rejected', reason: '纤维灶 / 瘢痕' })
    // 核对：结节 2 已不是确认状态（block）、有新结节
    const views = new MeasurementService(t.store, t.patients).views(t.store.getDoc(r.doc_id)!, t.A)
    const chk = t.drafts.check(t.A, t.store.getDoc(r.doc_id)!, views)
    expect(chk.issues.map(i => [i.code, i.severity])).toEqual(expect.arrayContaining([['nodule_removed', 'block'], ['nodule_added', 'warn'], ['measurement_invalid', 'block']]))
    const u = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id, doc_id: r.doc_id }, { turnId: null })
    expect(u.blocks.kept).toEqual([{ key: `nodule:${t.n1.id}`, block_id: b1, reason: 'edited' }])
    expect(u.blocks.removed).toEqual([`nodule:${t.n2.id}`])
    expect(serializeBlock(t.docs.get(r.doc_id).child(3), {}, '')).toBe(edited)
    expect(ids()).not.toContain(b2)
    // 医生改过的句子里，测量原子仍随病灶更新
    expect(shown(t, r.doc_id, t.A).slice(3)).toEqual(['1. 右肺上叶见实性结节，边缘见分叶，平均径 8.6 mm，体积 288 mm³。', '2. 右肺中叶见磨玻璃结节，平均径 4.2 mm。'])
    // 再生成一次：医生改过的块依旧不动
    const v = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id, doc_id: r.doc_id }, { turnId: null })
    expect(v.blocks.kept).toEqual([{ key: `nodule:${t.n1.id}`, block_id: b1, reason: 'edited' }])
    expect(v.blocks.written).toEqual([])
  })

  it('改过的句子对应的结节被否决：句子保留并在核对里标出；医生删掉的段落不会被补回', async () => {
    const t = await seeded()
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    const b2 = t.docs.get(r.doc_id).child(4).attrs.id as string
    const cmp = t.docs.get(r.doc_id).child(2).attrs.id as string
    t.ops.edit({ doc_id: r.doc_id, base_rev: t.docs.rev(r.doc_id), mode: 'apply', ops: [{ op: 'replace_text', id: b2, find: '见结节', replace: '见小结节' }, { op: 'delete', ids: [cmp] }] }, { actor: 'user', turnId: null, user: t.dr })
    t.svc.reviewLesion(t.A, t.n2.id, { status: 'rejected', reason: '伪影' })
    const u = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id, doc_id: r.doc_id }, { turnId: null })
    expect(u.blocks.kept).toEqual(expect.arrayContaining([{ key: 'comparison', block_id: null, reason: 'deleted' }, { key: `nodule:${t.n2.id}`, block_id: b2, reason: 'edited_obsolete' }]))
    expect(topText(t, r.doc_id).some(s => s.startsWith('无前片'))).toBe(false)
    expect(topText(t, r.doc_id).some(s => s.includes('见小结节'))).toBe(true)
    const ris = t.drafts.risText(t.A, t.store.getDoc(r.doc_id)!, new MeasurementService(t.store, t.patients).views(t.store.getDoc(r.doc_id)!, t.A))
    expect(ris.text).toContain('5.5 mm〔来源病灶已被否决〕')
    expect(ris.issues.filter(i => i.severity === 'block').map(i => i.code)).toEqual(expect.arrayContaining(['measurement_invalid', 'nodule_removed']))
    // 之后再生成两次：保留的句子一直不动，核对一直标出
    for (let k = 0; k < 2; k++) {
      const again = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id, doc_id: r.doc_id }, { turnId: null })
      expect(again.blocks.removed).toEqual([])
      expect(topText(t, r.doc_id).some(s => s.includes('见小结节'))).toBe(true)
      expect(t.drafts.check(t.A, t.store.getDoc(r.doc_id)!, new Map()).issues.some(i => i.code === 'nodule_removed' && i.block_id === b2)).toBe(true)
    }
  })

  it('AI 触发的生成记在回合上：doc_revert_turn 撤销生成的内容，医生期间的修改保留', async () => {
    const t = await seeded()
    const r = t.drafts.generate(t.as(t.dr, 'ai'), t.p.id, { study_id: t.study.id }, { turnId: 'turn-1' })
    const last = t.docs.get(r.doc_id).child(t.docs.get(r.doc_id).childCount - 1).attrs.id as string
    t.ops.edit({ doc_id: r.doc_id, base_rev: t.docs.rev(r.doc_id), mode: 'apply', ops: [{ op: 'insert_after', anchor_id: last, markdown: '印象：双肺结节，建议随访。' }] }, { actor: 'user', turnId: null, user: t.dr })
    expect(t.docs.canRevertTurn(r.doc_id, 'turn-1')).toBe(true)
    t.docs.revertTurn(r.doc_id, 'turn-1')
    expect(topText(t, r.doc_id).filter(Boolean)).toEqual(['印象：双肺结节，建议随访。'])
    expect(t.drafts.getDraft(r.doc_id)!.generated_via).toBe('ai')
  })
})

describe('写入经操作层与守卫', () => {
  it('病灶位置文字里带测量数字：生成的内容被写前守卫拒绝（bare_measurement），不留下空文档', async () => {
    const t = await seeded()
    t.svc.editLesion(t.A, t.n1.id, { location: '右上叶近胸膜 12 mm 处' })
    expect(code(() => t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null }))).toBe('bare_measurement')
    expect(t.patients.read(t.A, t.p.id).documents).toEqual([])
    expect(t.store.listDocs(t.dr)).toEqual([])
  })

  it('模板里的 markdown / HTML 注入按字面写入；草稿的段落不出现格式、原子以外的结构', async () => {
    const t = await seeded()
    const evil = { ...BUILTIN_TEMPLATE, title: '# 所见 **重要**', nodule: { default: '{序号}. <b>{位置}</b> **{密度}** \\[@m:mfake1234\\] \\{#abc123\\} 结节，平均径 {平均径}。' } }
    t.drafts.templates.save(t.as(t.admin), 'org', evil, null)
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    const doc = t.docs.get(r.doc_id)
    expect(doc.child(0).type.name).toBe('heading')
    expect(plainText(doc.child(0))).toBe('# 所见 **重要**')
    // 字面量的「[@m:mfake1234]」是文字，不是测量原子（未登记的 id 也没被守卫当成原子拒绝）
    expect(topText(t, r.doc_id)[3]).toMatch(/^1\. <b>右肺上叶<\/b> \*\*实性\*\* \[@m:mfake1234\] \{#abc123\} 结节，平均径 \[@m:(?!mfake)[a-z0-9]+\]。$/)
    let marks = 0, atoms = 0
    doc.descendants(n => { if (n.marks.length) marks++; if (n.type.name === 'measurement') atoms++; return true })
    expect(marks).toBe(0)
    expect(atoms).toBe(2)
    // RIS 纯文本里字面量的内部记号也去掉
    const ris = t.drafts.risText(t.A, t.store.getDoc(r.doc_id)!, new MeasurementService(t.store, t.patients).views(t.store.getDoc(r.doc_id)!, t.A))
    expect(ris.text).not.toContain('[@m:')
    expect(ris.notes.join()).toContain('内部记号')
  })
})

describe('RIS 纯文本', () => {
  it('测量展开为「数值 单位」；没有标题、〔草稿〕状态行、markdown 记号与内部 id；未定稿时提示', async () => {
    const t = await seeded()
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    const row = t.store.getDoc(r.doc_id)!
    const views = new MeasurementService(t.store, t.patients).views(row, t.A)
    const ris = t.drafts.risText(t.A, row, views)
    expect(ris.text).toBe('无前片可供比较。\n1. 右肺上叶见实性结节，平均径 8.2 mm，体积 288 mm³。\n2. 左肺下叶见结节，平均径 5.5 mm。')
    expect(ris.text).not.toMatch(/[#*_`<>{}]|\[@|草稿|影像所见/)
    for (const m of t.store.listMeasurements(r.doc_id)) expect(ris.text).not.toContain(m.id)
    for (const l of [t.n1, t.n2]) expect(ris.text).not.toContain(l.id)
    expect(ris.issues.map(i => i.code)).toEqual(['not_finalized'])
    expect(ris.draft).toMatchObject({ study_id: t.study.id, template: { id: 'builtin', version: 1 }, review_state: 'reading', generations: 1 })
  })

  it('纯函数：列表、表格、换行、图、引用的处理', () => {
    const doc = parseBlocks('## 所见\n\n第一行<br>第二行 **粗**\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![图](asset:a1 "图注")')
    const { schema } = { schema: doc[0]!.type.schema }
    const r = risPlainText(schema.node('doc', null, doc))
    expect(r.text).toBe('所见\n第一行\n第二行 粗\n· 甲\n· 乙\n1. 一\n2. 二\na  b\n1  2')
    expect(r.notes.join('；')).toMatch(/表格.*；图不进入/)
  })

  it('读者没有该患者权限：测量显示绑定时的快照并提示，不透露来源现状', async () => {
    const t = await seeded()
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    t.svc.reviewLesion(t.A, t.n1.id, { status: 'rejected', reason: '伪影' })
    const row = t.store.getDoc(r.doc_id)!
    const O = t.as(t.outsider)
    const ris = t.drafts.risText(O, row, new MeasurementService(t.store, t.patients).views(row, O))
    expect(ris.text).toContain('平均径 8.2 mm')
    expect(ris.text).not.toContain('否决')
    expect(ris.issues.map(i => i.code)).toEqual(expect.arrayContaining(['measurement_no_access', 'source_unavailable']))
  })
})

describe('科室所见模板', () => {
  it('机构管理员维护机构默认模板；本科室的审核医师维护科室模板；普通成员与 AI 不能改；只追加、带版本', async () => {
    const t = await seeded()
    const dept = t.store.addDepartment(t.hosp.id, '放射科')
    const other = t.store.addDepartment(t.hosp.id, '胸外科')
    t.store.setDepartmentMembers(dept.id, [t.rev, t.dr])
    t.store.setDepartmentMembers(other.id, [t.dr])
    const body = { ...BUILTIN_TEMPLATE, title: '胸部 CT 所见' }
    expect(code(() => t.drafts.templates.save(t.A, 'org', body, null))).toBe('forbidden')
    expect(code(() => t.drafts.templates.save(t.as(t.admin, 'ai'), 'org', body, null))).toBe('forbidden')
    expect(code(() => t.drafts.templates.save(t.A, `dept:${dept.id}`, body, null))).toBe('forbidden') // 王医生不是审核医师
    expect(code(() => t.drafts.templates.save(t.as(t.rev), `dept:${other.id}`, body, null))).toBe('forbidden') // 不在胸外科
    expect(code(() => t.drafts.templates.save(t.as(t.admin), 'dept:nope', body, null))).toBe('not_found')
    expect(code(() => t.drafts.templates.save(t.as(t.admin), 'org', { ...body, nodule: { default: '{x}' } }, null))).toBe('template_invalid')
    expect(t.drafts.templates.save(t.as(t.admin), 'org', body, '首版').version).toBe(1)
    expect(t.drafts.templates.save(t.as(t.admin), 'org', { ...body, title: '胸部 CT 所见（修订）' }, null).version).toBe(2)
    const d1 = t.drafts.templates.save(t.as(t.rev), `dept:${dept.id}`, { ...body, title: '放射科所见' }, null)
    expect(d1).toMatchObject({ source: 'department', department_name: '放射科', version: 1 })
    expect(t.drafts.templates.history(t.A, 'org').map(v => v.version)).toEqual([2, 1])
    expect(() => t.store.db.prepare('UPDATE findings_templates SET body = ? WHERE id = ?').run('{}', d1.id)).toThrow(/只追加/)
    // 生成时：王医生只在一个有模板的科室 → 用放射科模板；草稿记下模板与版本
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    expect(r.template).toMatchObject({ id: d1.id, source: 'department', version: 1 })
    expect(topText(t, r.doc_id)[0]).toBe('放射科所见')
    expect(t.drafts.getDraft(r.doc_id)).toMatchObject({ template_id: d1.id, template_version: 1, template_scope: `dept:${dept.id}` })
    // 胸外科也有了模板：在两个有模板的科室 → 须指定
    t.drafts.templates.save(t.as(t.admin), `dept:${other.id}`, { ...body, title: '胸外科所见' }, null)
    expect(code(() => t.drafts.generate(t.A, t.p.id, { study_id: t.study.id, new: true }, { turnId: null }))).toBe('department_required')
    const r2 = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id, new: true, department_id: other.id }, { turnId: null })
    expect(topText(t, r2.doc_id)[0]).toBe('胸外科所见')
    expect(code(() => t.drafts.generate(t.as(t.rev), t.p.id, { study_id: t.study.id, department_id: other.id }, { turnId: null }))).toBe('not_in_department')
    // 模板有新版本：核对时提示
    t.drafts.templates.save(t.as(t.rev), `dept:${dept.id}`, { ...body, title: '放射科所见 v2' }, null)
    const row = t.store.getDoc(r.doc_id)!
    expect(t.drafts.check(t.A, row, new Map()).issues.map(i => i.code)).toContain('template_updated')
    // 列表：我能改哪些、我的默认模板
    const list = t.drafts.templates.list(t.as(t.rev))
    expect(list.can_edit_org).toBe(false)
    expect(list.departments.map(d => [d.name, d.can_edit])).toEqual([['放射科', true], ['胸外科', false]])
  })
})

describe('权限与空间', () => {
  it('不在诊疗组 / 知家个人空间 / 机构禁止外部模型时的 AI / 文档关联另一位患者 / 不是草稿的文档 → 拒绝', async () => {
    const t = await seeded()
    expect(code(() => t.drafts.generate(t.as(t.outsider), t.p.id, { study_id: t.study.id }, { turnId: null }))).toBe('not_found')
    expect(code(() => t.drafts.generate({ userId: t.dr, via: 'user', space: 'personal' }, t.p.id, { study_id: t.study.id }, { turnId: null }))).toBe('personal_space')
    t.tenants.update(t.admin, { settings: { external_model_for_patients: false } })
    expect(code(() => t.drafts.generate(t.as(t.dr, 'ai'), t.p.id, { study_id: t.study.id }, { turnId: 't' }))).toBe('external_model_off')
    t.tenants.update(t.admin, { settings: { external_model_for_patients: true } })
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    const p2 = t.patients.create(t.A, {})
    expect(code(() => t.drafts.generate(t.A, p2.id, { study_id: t.study.id, doc_id: r.doc_id }, { turnId: null }))).toBe('doc_other_patient')
    const plain = t.docs.create({ owner: t.dr, title: '病例报告' })
    t.patients.linkDoc(t.A, t.p.id, plain.id)
    expect(code(() => t.drafts.generate(t.A, t.p.id, { study_id: t.study.id, doc_id: plain.id }, { turnId: null }))).toBe('not_a_draft')
    // 别人的草稿：当不存在
    t.patients.addMember(t.A, t.p.id, t.outsider)
    expect(code(() => t.drafts.generate(t.as(t.outsider), t.p.id, { study_id: t.study.id, doc_id: r.doc_id }, { turnId: null }))).toBe('not_found')
  })

  it('性能：30 个结节的检查生成远低于 10 秒', async () => {
    const t = await seeded()
    for (let i = 0; i < 30; i++) t.svc.addLesion(t.A, t.study.id, { kind: 'lung_nodule', source: 'manual', label: `医生补充 ${i + 1}`, location: ['RUL', 'RML', 'RLL', 'LUL', 'LLL'][i % 5]!, metrics: { mean_diameter_mm: 3 + i / 10, volume_mm3: 20 + i } })
    const r = t.drafts.generate(t.A, t.p.id, { study_id: t.study.id }, { turnId: null })
    expect(r.nodules).toBe(32)
    expect(r.elapsed_ms).toBeLessThan(2000)
  })
})

describe('接口与 MCP', () => {
  it('REST：生成（201 / 409 draft_exists / 200 更新）、RIS 纯文本、模板读写（成员 403、AI 无写工具）', async () => {
    const t = await seeded()
    const app = buildApi({
      docs: t.docs, ops: t.ops, turns: {} as never, postcheck: new PostCheck(t.docs), crossref: {} as never,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'draft-r-'))), accounts: new Accounts(t.store, { secret: 'test-secret', devMode: false, devToken: 'dev', devUser: 'dev' }),
      devMode: false, devUser: 'dev', patients: t.patients, orthanc: t.orthanc, imagingPipeline: null, imagingInteractive: null, imagingFollowup: null,
    })
    const tok = (u: string) => `Bearer ${issueToken('test-secret', { u, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: t.store.getUser(u)!.token_version })}`
    const H = { Authorization: tok(t.dr), 'Content-Type': 'application/json' }
    const url = `/api/patients/${t.p.id}/imaging/studies/${t.study.id}/findings-draft`
    const made = await app.request(url, { method: 'POST', headers: H, body: '{}' })
    expect(made.status).toBe(201)
    const r = await made.json() as { doc_id: string; nodules: number }
    expect(r.nodules).toBe(2)
    const dup = await app.request(url, { method: 'POST', headers: H, body: '{}' })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toMatchObject({ code: 'draft_exists', doc_id: r.doc_id })
    expect((await app.request(url, { method: 'POST', headers: H, body: JSON.stringify({ doc_id: r.doc_id }) })).status).toBe(200)
    const ris = await (await app.request(`/api/docs/${r.doc_id}/ris-text`, { headers: H })).json() as { text: string; issues: Array<{ code: string }> }
    expect(ris.text).toContain('平均径 8.2 mm')
    expect(ris.issues.map(i => i.code)).toEqual(['not_finalized'])
    expect((await app.request(`/api/docs/${r.doc_id}/ris-text`, { headers: { Authorization: tok(t.outsider) } })).status).toBe(404)
    const notTeam = await app.request(url, { method: 'POST', headers: { ...H, Authorization: tok(t.outsider) }, body: '{}' })
    expect(notTeam.status).toBe(404)
    const tpl = await (await app.request('/api/imaging/findings-templates', { headers: H })).json() as { builtin: { version: number }; can_edit_org: boolean }
    expect(tpl).toMatchObject({ builtin: { version: 1 }, can_edit_org: false })
    expect((await app.request('/api/imaging/findings-templates', { method: 'PUT', headers: H, body: JSON.stringify({ scope: 'org', body: BUILTIN_TEMPLATE }) })).status).toBe(403)
    const saved = await app.request('/api/imaging/findings-templates', { method: 'PUT', headers: { ...H, Authorization: tok(t.admin) }, body: JSON.stringify({ scope: 'org', body: { ...BUILTIN_TEMPLATE, none: '未见结节 5 mm。' } }) })
    expect(saved.status).toBe(422)
    expect(await saved.json()).toMatchObject({ code: 'template_invalid', where: 'none' })
  })

  it('MCP：AI 读模板、生成草稿（记在回合上）、核对 / 取 RIS 纯文本；没有改模板的工具', async () => {
    const t = await seeded()
    const registry = new TurnRegistry()
    const claims = verifyToken('s', issueToken('s', { u: t.dr, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const server = buildMcpServer({
      docs: t.docs, ops: t.ops, turns: registry, secret: 's', claims: new ClaimService(t.docs, {} as PubMedClient), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'draft-m-'))),
      pubmed: {} as PubMedClient, crossref: {} as CrossrefClient, workspaceDir: () => tmpdir(), isLiveSession: () => true, patients: t.patients,
    }, claims)
    const [x, y] = InMemoryTransport.createLinkedPair()
    await server.connect(x)
    const client = new Client({ name: 't', version: '0' })
    await client.connect(y)
    const names = (await client.listTools()).tools.map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining(['imaging_findings_templates', 'imaging_findings_draft', 'imaging_findings_draft_check']))
    expect(names.filter(n => /findings.*(save|update|edit)/.test(n))).toEqual([])
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean }
      return { err: !!res.isError, body: JSON.parse(res.content[0]!.text) }
    }
    expect((await call('imaging_findings_templates', {})).body.builtin.version).toBe(1)
    const g = await call('imaging_findings_draft', { patient_id: t.p.id, imaging_study_id: t.study.id })
    expect(g.err).toBe(false)
    expect(g.body).toMatchObject({ created: true, nodules: 2 })
    expect((await call('imaging_findings_draft', { patient_id: t.p.id, imaging_study_id: t.study.id })).body.code).toBe('draft_exists')
    const c = await call('imaging_findings_draft_check', { doc_id: g.body.doc_id })
    expect(c.body.text).toContain('右肺上叶见实性结节')
    expect(c.body.draft.generated_via).toBe('ai')
  })
})
