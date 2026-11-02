import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { extractClaims } from '../src/claims/extract.ts'
import { docxFor, pptxFor } from '../src/convert/exports.ts'
import { ImagingStudyService } from '../src/imaging/studies.ts'
import { MeasurementError, MeasurementService } from '../src/measurements/service.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { duplicateDoc } from '../src/model/duplicate.ts'
import { parseBlocks, parseInline, serializeBlocks } from '../src/model/markdown.ts'
import { findBareMeasurements, measureExportText } from '../src/model/measurements.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { newTemplateDeck } from '../src/ops/deck.ts'
import { OpService } from '../src/ops/service.ts'
import { OpError } from '../src/ops/types.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientError, PatientService, type Actor } from '../src/tenancy/patients.ts'
import { exportMarkdown, renderHtml } from '../src/views/render.ts'
import { read } from '../src/views/read.ts'
import { dicom, FakeOrthanc } from './imaging-fakes.ts'
import { ids, setup } from './helpers.ts'

/**
 * 测量原子 [@m:id]（PRD W4.2 / T2.5）：markdown 方言、写前守卫（未登记 / 裸测量数字 / 保留）、
 * 绑定规则（只绑定已确认病灶、影子病灶不可见、跨患者）、渲染时取当前值（医生重测后同步）、权限（无权读者只看快照）、
 * 导出（HTML / markdown / docx / pptx）、复制文档、AI 读视图与 MCP 工具。
 */

const STUDY = '1.2.840.113619.2.55.3.5001'
const SERIES = `${STUDY}.2`
const METRICS = { long_axis_mm: 9.1, short_axis_mm: 7.3, mean_diameter_mm: 8.2, volume_mm3: 288.4, mean_hu: -12, nodule_type: 'solid' }

async function env() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const tenants = new TenantService(store, { devMode: false })
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-measure-')), tenants, new TenantKeys(store, kekFrom({ secret: 'test-secret' })), store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const dr = store.createUser({ username: 'dr_wang', display_name: '王医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const other = store.createUser({ username: 'dr_zhao', display_name: '赵医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const svc = new ImagingStudyService(patients, new FakeOrthanc())
  const a: Actor = { userId: dr, via: 'user' }
  const ai: Actor = { userId: dr, via: 'ai' }
  const p = patients.create(a, { sex: 'M', birth_year: 1958 })
  const study = (await svc.importDicom(a, p.id, [{ name: 'IM1', bytes: dicom(STUDY, SERIES, '1') }])).studies[0]!
  const manual = svc.addLesion(a, study.id, { kind: 'lung_nodule', source: 'manual', label: '医生补充 1', location: '右上叶', metrics: METRICS })
  const measure = new MeasurementService(store, patients)
  const doc = (markdown = '影像所见：') => docs.create({ owner: dr, title: '胸部 CT 报告', content: schema.node('doc', null, parseBlocks(markdown)) })
  return { store, docs, ops, tenants, patients, hosp, dr, other, svc, a, ai, p, study, manual, measure, doc }
}

const code = (fn: () => unknown): string | null => {
  try { fn(); return null } catch (err) { return (err as { code?: string }).code ?? String(err) }
}

describe('markdown 方言', () => {
  it('[@m:id] 解析为测量原子并原样写回；字面量 \\[@m: 转义', () => {
    const blocks = parseBlocks('结节大小 [@m:mabc1234]，较前增大。')
    const para = blocks[0]!
    expect(para.child(1).type.name).toBe('measurement')
    expect(para.child(1).attrs.m_id).toBe('mabc1234')
    expect(serializeBlocks(blocks)).toBe('结节大小 [@m:mabc1234]，较前增大。')
    const literal = schema.node('paragraph', null, schema.text('写法 [@m:x123] 是标记'))
    expect(serializeBlocks([literal])).toBe('写法 \\[@m:x123] 是标记')
    expect(parseInline(serializeBlocks([literal]))[0]!.isText).toBe(true)
  })
})

describe('裸测量数字识别', () => {
  it('带测量单位的数字算，测量原子、采集参数、阈值、范围、日期年龄序号百分比不算', () => {
    expect(findBareMeasurements('右上叶结节 8.2 mm，体积 288 mm³，CT 值 -12 HU，长径 0.91cm')).toEqual(['8.2mm', '288mm³', '-12HU', '0.91cm'])
    expect(findBareMeasurements('结节 [@m:mabc1234]，体积 [@m:mdef5678]')).toEqual([])
    // 全角数字与单位符号不能绕过
    expect(findBareMeasurements('结节约１２ mm，体积 ２８８ ㎣，长径 ８㎜')).toEqual(['12mm', '288mm³', '8mm'])
    expect(findBareMeasurements('层厚 1.25 mm 重建；肺窗窗位 -600 HU')).toEqual([])
    expect(findBareMeasurements('≥ 6 mm 的实性结节建议随访；直径大于 8 mm 者；4 mm 以下')).toEqual([])
    expect(findBareMeasurements('6–8 mm 结节；6 mm 至 8 mm')).toEqual([])
    expect(findBareMeasurements('2026-10-20 检查，患者 65 岁，第 3 个结节，阳性率 30%，血压 120/80 mmHg，PEEP 5 cmH2O')).toEqual([])
  })
})

describe('写前守卫（AI）', () => {
  it('未登记的 [@m:任意] 拒绝（unbound_measurement）；用户写入不拦', () => {
    const t = setup('影像所见：')
    const [id] = ids(t.docs, t.docId)
    const batch = { doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply' as const, ops: [{ op: 'replace_block' as const, id: id!, markdown: '结节 [@m:mfake123]。' }] }
    expect(code(() => t.ops.edit(batch, { actor: 'ai', turnId: null }))).toBe('unbound_measurement')
    expect(code(() => t.ops.edit(batch, { actor: 'user', turnId: null }))).toBeNull()
  })

  it('严格模式：有测量登记的文档里 AI 不能新写裸测量数字（bare_measurement），原文已有的可保留；用户可关闭', () => {
    const t = setup('结节 8.2 mm（外院报告）。\n\n印象：')
    const [first, second] = ids(t.docs, t.docId)
    const ai = { actor: 'ai' as const, turnId: null }
    const edit = (ops: unknown[]) => t.ops.edit({ doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply', ops: ops as never }, ai)
    // 没有测量登记：不严格
    expect(code(() => edit([{ op: 'replace_block', id: second, markdown: '印象：结节 9 mm。' }]))).toBeNull()
    const m = t.store.upsertMeasurement({ doc_id: t.docId, source_kind: 'imaging_lesion', source_id: 'le1', field: 'mean_diameter_mm', unit: 'mm', decimals: 1, tenant_id: null, patient_id: 'p1', bound_version: 1, bound_value: 8.2, bound_label: '病灶 1 · 平均径', bound_by: 'u1' })
    let err: unknown
    try { edit([{ op: 'insert_after', anchor_id: second, markdown: '右下叶新发结节 5.5 mm。' }]) } catch (e) { err = e }
    expect(err).toBeInstanceOf(OpError)
    expect((err as OpError).code).toBe('bare_measurement')
    expect((err as OpError).extra.hint).toContain('insert_measurement')
    expect((err as OpError).extra.current).toEqual({ bare: ['5.5mm'] })
    // 用测量原子写：通过
    expect(code(() => edit([{ op: 'insert_after', anchor_id: second, markdown: `右下叶新发结节 [@m:${m.id}]。` }]))).toBeNull()
    // 改写原文已有裸数字的段落：保留原数字可以，新增不行
    expect(code(() => edit([{ op: 'replace_text', id: first, find: '（外院报告）', replace: '（外院 CT 报告）' }]))).toBeNull()
    expect(code(() => edit([{ op: 'replace_block', id: first, markdown: '外院报告结节 8.2 mm。' }]))).toBeNull()
    expect(code(() => edit([{ op: 'replace_block', id: first, markdown: '外院报告结节 8.2 mm，现 7.9 mm。' }]))).toBe('bare_measurement')
    // 用户关闭严格模式后不再拦
    t.store.setMeasurementStrict(t.docId, false, 'u1')
    expect(code(() => edit([{ op: 'replace_block', id: first, markdown: '外院报告结节 8.2 mm，现 7.9 mm。' }]))).toBeNull()
    // 显式开启：没有登记的文档也严格
    const t2 = setup('印象：')
    t2.store.setMeasurementStrict(t2.docId, true, 'u1')
    const [only] = ids(t2.docs, t2.docId)
    expect(code(() => t2.ops.edit({ doc_id: t2.docId, base_rev: t2.docs.rev(t2.docId), mode: 'apply', ops: [{ op: 'replace_block', id: only!, markdown: '结节 6 mm。' }] }, ai))).toBe('bare_measurement')
  })

  it('保留守卫：改写段落丢掉已有的 [@m:] 拒绝（measurement_lost）；保留标记的改写通过', () => {
    const t = setup('印象：')
    const m = t.store.upsertMeasurement({ doc_id: t.docId, source_kind: 'imaging_lesion', source_id: 'le1', field: 'mean_diameter_mm', unit: 'mm', decimals: 1, tenant_id: null, patient_id: 'p1', bound_version: 1, bound_value: 8.2, bound_label: '病灶 1 · 平均径', bound_by: 'u1' })
    const [id] = ids(t.docs, t.docId)
    t.ops.edit({ doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply', ops: [{ op: 'replace_block', id: id!, markdown: `右上叶结节 [@m:${m.id}]，边缘光整。` }] }, { actor: 'ai', turnId: null })
    const edit = (ops: unknown[]) => t.ops.edit({ doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply', ops: ops as never }, { actor: 'ai', turnId: null })
    t.store.setMeasurementStrict(t.docId, false, 'u1') // 只看保留守卫
    expect(code(() => edit([{ op: 'replace_block', id: id!, markdown: '右上叶结节，边缘光整。' }]))).toBe('measurement_lost')
    expect(code(() => edit([{ op: 'replace_text', id: id!, find: `结节 [@m:${m.id}]`, replace: '结节 8.2 mm' }]))).toBe('measurement_lost')
    expect(code(() => edit([{ op: 'replace_text', id: id!, find: '边缘光整', replace: '边缘光整，未见分叶' }]))).toBeNull()
    // replace_text 里原样写出测量标记：保留
    expect(code(() => edit([{ op: 'replace_text', id: id!, find: `右上叶结节 [@m:${m.id}]`, replace: `右上叶实性结节 [@m:${m.id}]` }]))).toBeNull()
    expect(serializeBlocks([t.docs.get(t.docId).child(0)])).toBe(`右上叶实性结节 [@m:${m.id}]，边缘光整，未见分叶。`)
  })

  it('现有的引用守卫不受影响：未登记引用、手写 DOI 照旧拒绝', () => {
    const t = setup('正文')
    const [id] = ids(t.docs, t.docId)
    const edit = (markdown: string) => t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: id!, markdown }] }, { actor: 'ai', turnId: null })
    expect(code(() => edit('见 [@c:cnope12]'))).toBe('citation_unknown')
    expect(code(() => edit('见 10.1000/xyz123'))).toBe('citation_not_registered')
  })
})

describe('绑定与取值（影像病灶测量）', () => {
  it('绑定已确认病灶；医生重测后渲染为新值（状态 updated），文档本身不变；同一测量多次出现取同一值', async () => {
    const t = await env()
    const row = t.doc()
    const r = t.measure.bind(t.ai, row, { source_id: t.manual.id, field: 'mean_diameter_mm' })
    expect(r.view).toMatchObject({ text: '8.2 mm', status: 'ok', bound_text: '8.2 mm', source_label: '病灶 医生补充 1 · 右上叶 · 平均径' })
    // 再次绑定同一字段、单位：同一个 id
    expect(t.measure.bind(t.ai, row, { source_id: t.manual.id, field: 'mean_diameter_mm' }).row.id).toBe(r.row.id)
    const [first] = ids(t.docs, row.id)
    t.ops.edit({ doc_id: row.id, base_rev: t.docs.rev(row.id), mode: 'apply', ops: [{ op: 'replace_block', id: first!, markdown: `右上叶结节 [@m:${r.row.id}]；复测仍为 [@m:${r.row.id}]。` }] }, { actor: 'ai', turnId: 'turn1' })
    const rev = t.docs.rev(row.id)

    t.svc.editLesion(t.a, t.manual.id, { metrics: { ...METRICS, mean_diameter_mm: 9.04 } })
    const v = t.measure.views(row, t.a).get(r.row.id)!
    expect(v).toMatchObject({ text: '9.0 mm', status: 'updated', bound_text: '8.2 mm', source_version: 2, bound_version: 1 })
    expect(v.note).toContain('8.2 mm')
    expect(t.docs.rev(row.id)).toBe(rev) // 不产生修订：按轮撤销照常
    const html = renderHtml(t.docs.get(row.id), [], () => '', t.measure.views(row, t.a))
    expect(html.match(/9\.0 mm/g)).toHaveLength(2)
    expect(t.docs.revertTurn(row.id, 'turn1')?.event).toBeTruthy()
    expect(t.docs.get(row.id).textContent).toBe('影像所见：')

    // 重新绑定 = 刷新快照（确认更新）
    expect(t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'mean_diameter_mm' }).view).toMatchObject({ status: 'ok', bound_text: '9.0 mm' })
  })

  it('单位换算与小数位：mm³ ↔ cm³、mm ↔ cm；字段缺值、单位不合法拒绝', async () => {
    const t = await env()
    const row = t.doc()
    expect(t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'volume_mm3' }).view.text).toBe('288 mm³')
    expect(t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'volume_mm3', unit: 'cm3' }).view.text).toBe('0.29 cm³')
    expect(t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'long_axis_mm', unit: 'cm', decimals: 1 }).view.text).toBe('0.9 cm')
    expect(t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'mean_hu' }).view.text).toBe('-12 HU')
    expect(code(() => t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'volume_mm3', unit: 'mm' }))).toBe('measurement_unit_invalid')
    expect(code(() => t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'solid_core_diameter_mm' }))).toBe('measurement_field_missing')
    expect(code(() => t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'patient_name' }))).toBe('measurement_field_unknown')
  })

  it('只绑定已确认病灶；否决 / 撤销后显示快照并醒目注明，导出也注明', async () => {
    const t = await env()
    const row = t.doc()
    const run = t.svc.startRun(t.a, t.study.id, { task: 'lung_nodule', model_id: 'm' })
    const ai = t.svc.addLesion(t.a, t.study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', label: '结节 1', metrics: { mean_diameter_mm: 5.5 } })
    let err: unknown
    try { t.measure.bind(t.ai, row, { source_id: ai.id, field: 'mean_diameter_mm' }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(MeasurementError)
    expect((err as MeasurementError).code).toBe('lesion_not_confirmed')
    t.svc.reviewLesion(t.a, ai.id, { status: 'confirmed' })
    const bound = t.measure.bind(t.ai, row, { source_id: ai.id, field: 'mean_diameter_mm' })
    const manual = t.measure.bind(t.ai, row, { source_id: t.manual.id, field: 'mean_diameter_mm' })
    t.svc.reviewLesion(t.a, ai.id, { status: 'rejected', reason: '血管断面' })
    t.svc.withdrawLesion(t.a, t.manual.id)
    const views = t.measure.views(row, t.a)
    expect(views.get(bound.row.id)).toMatchObject({ status: 'rejected', text: '5.5 mm' })
    expect(views.get(manual.row.id)).toMatchObject({ status: 'withdrawn', text: '8.2 mm' })
    expect(measureExportText(views.get(bound.row.id), bound.row.id)).toBe('5.5 mm〔来源病灶已被否决〕')
    expect(measureExportText(undefined, 'mzzz')).toBe('〔未登记的测量〕')
    expect(code(() => t.measure.bind(t.ai, row, { source_id: ai.id, field: 'mean_diameter_mm' }))).toBe('lesion_not_confirmed')
  })

  it('影子模式的病灶不能绑定（当不存在）', async () => {
    const t = await env()
    const run = t.svc.startRun(t.a, t.study.id, { task: 'lung_nodule', model_id: 'm', visibility: 'shadow' })
    const shadow = t.svc.addLesion(t.a, t.study.id, { run_id: run.id, kind: 'lung_nodule', source: 'ai', metrics: { mean_diameter_mm: 6 } })
    // 绕过界面直接确认（影子结果本不可见，这里只为证明即使状态是 confirmed 也绑不上）
    t.patients.imagingLookup(t.a).db.prepare("UPDATE imaging_lesions SET status = 'confirmed' WHERE id = ?").run(shadow.id)
    let err: unknown
    try { t.measure.bind(t.ai, t.doc(), { source_id: shadow.id, field: 'mean_diameter_mm' }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(PatientError)
    expect((err as PatientError).code).toBe('not_found')
  })

  it('权限：没有该患者权限的读者只看到绑定时的快照，不透露来源的当前值；无权限者不能绑定', async () => {
    const t = await env()
    const row = t.doc()
    const r = t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'mean_diameter_mm' })
    t.svc.editLesion(t.a, t.manual.id, { metrics: { ...METRICS, mean_diameter_mm: 10.4 } })
    const otherView = t.measure.views(row, { userId: t.other, via: 'user' }).get(r.row.id)!
    expect(otherView).toMatchObject({ status: 'no_access', text: '8.2 mm', source_version: null, source_label: '病灶 医生补充 1 · 右上叶 · 平均径' })
    expect(JSON.stringify(otherView)).not.toContain('10.4')
    expect(t.measure.views(row, null).get(r.row.id)).toMatchObject({ status: 'no_access', text: '8.2 mm' })
    expect(t.measure.views(row, t.a).get(r.row.id)).toMatchObject({ status: 'updated', text: '10.4 mm' })
    expect(code(() => t.measure.bind({ userId: t.other, via: 'user' }, row, { source_id: t.manual.id, field: 'mean_diameter_mm' }))).toBe('not_found')
    // 机构不允许把患者数据交给外部模型：AI 读来源失败 → 只有快照
    t.tenants.update(t.store.createUser({ username: 'admin', display_name: '管理员', password_hash: 'x', tenant: { id: t.hosp.id, role: 'admin' } }).id, { settings: { external_model_for_patients: false } })
    expect(t.measure.views(row, t.ai).get(r.row.id)).toMatchObject({ status: 'no_access', text: '8.2 mm' })
  })

  it('跨患者：文档关联了患者时只能绑定该患者；未关联的文档里也不能混入两位患者', async () => {
    const t = await env()
    const q = t.patients.create(t.a, { sex: 'F', birth_year: 1970 })
    const qStudy = (await t.svc.importDicom(t.a, q.id, [{ name: 'IM9', bytes: dicom(`${STUDY}9`, `${STUDY}9.2`, '1') }])).studies[0]!
    const qLesion = t.svc.addLesion(t.a, qStudy.id, { kind: 'lung_nodule', source: 'manual', metrics: { mean_diameter_mm: 4 } })
    const linked = t.doc()
    t.patients.linkDoc(t.a, t.p.id, linked.id, 'case_report')
    const linkedRow = t.store.getDoc(linked.id)!
    expect(code(() => t.measure.bind(t.a, linkedRow, { source_id: qLesion.id, field: 'mean_diameter_mm' }))).toBe('measurement_patient_mismatch')
    expect(code(() => t.measure.bind(t.a, linkedRow, { source_id: t.manual.id, field: 'mean_diameter_mm' }))).toBeNull()
    const loose = t.doc()
    t.measure.bind(t.a, loose, { source_id: t.manual.id, field: 'mean_diameter_mm' })
    expect(code(() => t.measure.bind(t.a, loose, { source_id: qLesion.id, field: 'mean_diameter_mm' }))).toBe('measurement_patient_mismatch')
  })
})

describe('导出、复制、读视图与 MCP', () => {
  it('HTML / markdown / docx 导出与界面同一个值（医生重测后导出随之更新）', async () => {
    const t = await env()
    const row = t.doc()
    const r = t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'mean_diameter_mm' })
    const [first] = ids(t.docs, row.id)
    t.ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: first!, markdown: `右上叶结节 [@m:${r.row.id}]。` }] }, { actor: 'ai', turnId: null })
    const docxText = () => strFromU8(unzipSync(docxFor(t.docs, row.id, t.measure.views(row, t.a)).bytes)['word/document.xml']!)
    expect(docxText()).toContain('8.2 mm')
    expect(exportMarkdown(t.docs.get(row.id), [], t.measure.views(row, t.a))).toBe('右上叶结节 8.2 mm。\n')
    t.svc.editLesion(t.a, t.manual.id, { metrics: { ...METRICS, mean_diameter_mm: 11 } })
    expect(docxText()).toContain('11.0 mm')
    expect(docxText()).not.toContain('8.2 mm')
    expect(renderHtml(t.docs.get(row.id), [], () => '', t.measure.views(row, t.a))).toContain('>11.0 mm</span>')
    // 导出时不给取值（例如旧调用方）：注明未登记，不会输出一个没有出处的数字
    expect(exportMarkdown(t.docs.get(row.id), [])).toBe('右上叶结节 〔未登记的测量〕。\n')
  })

  it('幻灯片：[@m:] 写入形状，pptx 导出为当前值', async () => {
    const t = await env()
    const deck = t.docs.create({ owner: t.dr, title: '病例汇报', kind: 'deck', content: newTemplateDeck('病例汇报') })
    const r = t.measure.bind(t.a, deck, { source_id: t.manual.id, field: 'volume_mm3', unit: 'cm3' })
    const slide = t.docs.get(deck.id).child(0)
    let shapeId = ''
    slide.descendants(n => { if (!shapeId && n.type.name === 'shape' && n.attrs.ph) shapeId = n.attrs.id as string; return !shapeId })
    t.ops.edit({ doc_id: deck.id, base_rev: t.docs.rev(deck.id), mode: 'apply', ops: [{ op: 'set_text', shape_id: shapeId, markdown: `结节体积 [@m:${r.row.id}]` }] as never }, { actor: 'ai', turnId: null })
    const files = unzipSync(pptxFor(t.docs, deck.id, t.measure.views(deck, t.a)).bytes)
    const slides = Object.keys(files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).map(f => strFromU8(files[f]!)).join('')
    expect(slides).toContain('0.29 cm³')
  })

  it('复制文档：测量登记换新 id，正文标记跟着改，取值不变', async () => {
    const t = await env()
    const row = t.doc()
    const r = t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'mean_diameter_mm' })
    const [first] = ids(t.docs, row.id)
    t.ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: first!, markdown: `结节 [@m:${r.row.id}]` }] }, { actor: 'ai', turnId: null })
    const copy = duplicateDoc(t.docs, t.store.getDoc(row.id)!, t.dr)
    const copied = t.store.listMeasurements(copy.id)
    expect(copied).toHaveLength(1)
    expect(copied[0]!.id).not.toBe(r.row.id)
    expect(serializeBlocks([t.docs.get(copy.id).child(0)])).toBe(`结节 [@m:${copied[0]!.id}]`)
    expect(t.measure.views(copy, t.a).get(copied[0]!.id)).toMatchObject({ text: '8.2 mm', status: 'ok' })
  })

  it('读视图末尾列出测量的值与状态；论断抽取把测量当作有出处的数字', async () => {
    const t = await env()
    const row = t.doc()
    const r = t.measure.bind(t.a, row, { source_id: t.manual.id, field: 'mean_diameter_mm' })
    const [first] = ids(t.docs, row.id)
    t.ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id: first!, markdown: `右上叶结节 [@m:${r.row.id}]，较前增大。` }] }, { actor: 'ai', turnId: null })
    const view = read({ doc: t.docs.get(row.id), docId: row.id, rev: t.docs.rev(row.id), comments: [], measurements: t.measure.views(row, t.ai) })
    expect(view).toContain(`- [@m:${r.row.id}] = 8.2 mm（病灶 医生补充 1 · 右上叶 · 平均径；与来源一致）`)
    const { claims, unsourced } = extractClaims(t.docs.get(row.id), new Map(), new Map([[r.row.id, '8.2 mm']]))
    expect(claims).toHaveLength(0)
    expect(unsourced).toHaveLength(0)
  })

  it('MCP：insert_measurement 绑定、list_measurements 查看，doc_read 带测量图例；伪造标记被守卫拒绝', async () => {
    const t = await env()
    const row = t.doc()
    const claims = verifyToken('s', issueToken('s', { u: t.dr, d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const server = buildMcpServer({
      docs: t.docs, ops: t.ops, turns: new TurnRegistry(), secret: 's', claims: new ClaimService(t.docs, {} as never), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-m-r-'))),
      pubmed: {} as never, crossref: {} as never, workspaceDir: () => tmpdir(), isLiveSession: () => true, patients: t.patients,
    }, claims)
    const [x, y] = InMemoryTransport.createLinkedPair()
    await server.connect(x)
    const client = new Client({ name: 'm', version: '0' })
    await client.connect(y)
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> }
      return { error: !!res.isError, body: JSON.parse(res.content[0]!.text) as Record<string, any> }
    }
    const bound = await call('insert_measurement', { doc_id: row.id, lesion_id: t.manual.id, field: 'long_axis_mm' })
    expect(bound.error).toBe(false)
    expect(bound.body).toMatchObject({ text: '9.1 mm', marker: `[@m:${bound.body.m_id}]` })
    const shadowless = await call('insert_measurement', { doc_id: row.id, lesion_id: 'lenotexist00', field: 'long_axis_mm' })
    expect(shadowless).toMatchObject({ error: true, body: { code: 'not_found' } })
    const [first] = ids(t.docs, row.id)
    const fake = await call('doc_edit', { doc_id: row.id, base_rev: t.docs.rev(row.id), ops: [{ op: 'replace_block', id: first, markdown: '长径 [@m:mforged1]。' }] })
    expect(fake).toMatchObject({ error: true, body: { code: 'unbound_measurement' } })
    const bare = await call('doc_edit', { doc_id: row.id, base_rev: t.docs.rev(row.id), ops: [{ op: 'replace_block', id: first, markdown: '长径 9.1 mm。' }] })
    expect(bare).toMatchObject({ error: true, body: { code: 'bare_measurement' } })
    const ok = await call('doc_edit', { doc_id: row.id, base_rev: t.docs.rev(row.id), ops: [{ op: 'replace_block', id: first, markdown: `长径 ${bound.body.marker}。` }] })
    expect(ok.error).toBe(false)
    const res = await client.callTool({ name: 'doc_read', arguments: { doc_id: row.id } }) as { content: Array<{ text: string }> }
    expect(res.content[0]!.text).toContain(`[@m:${bound.body.m_id}] = 9.1 mm`)
    const list = await call('list_measurements', { doc_id: row.id })
    expect(list.body).toMatchObject({ strict: true, measurements: [{ m_id: bound.body.m_id, field: 'long_axis_mm', text: '9.1 mm', status: 'ok', used: true }] })
  })
})
