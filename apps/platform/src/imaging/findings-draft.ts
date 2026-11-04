import { randomUUID } from 'node:crypto'
import type { Node as PMNode } from 'prosemirror-model'
import { MeasurementError, MeasurementService, measureSpace } from '../measurements/service.ts'
import { parseBlocks, plainText, serializeBlock } from '../model/markdown.ts'
import { measureExportText, type MeasureLookup, type MeasureUnit } from '../model/measurements.ts'
import type { Documents } from '../model/runtime.ts'
import type { OpService } from '../ops/service.ts'
import { OpError, type DocOp } from '../ops/types.ts'
import type { DocRow, Store } from '../store/db.ts'
import { PatientError, type Actor, type PatientService } from '../tenancy/patients.ts'
import { sharedFollowup, type ChangeKind, type FollowupItem, type FollowupView, type ImagingFollowup } from './followup.ts'
import {
  BUILTIN_TEMPLATE, BUILTIN_VERSION, PLACEHOLDERS, TEMPLATE_KIND, TemplateError, parseTemplate, partsToMarkdown, partsToPlain, renderSentence,
  type FindingsTemplateBody, type NoduleCase, type ParsedTemplate, type Part, type Value,
} from './findings-template.ts'
import { evaluateNoduleGuidelines, GUIDELINE_PROVENANCE_LABEL, type NoduleGuidelineSummary } from './guideline-rules.ts'
import { ensureReviewSchema, ImagingReviewService, type ReviewSummary } from './review.ts'
import { risPlainText } from './ris-text.ts'
import { ImagingStudyService, type LesionRow } from './studies.ts'

/**
 * 结构化所见草稿（PRD W4.1 / W4.4 / W4.5 一期，T2.6；docs/design/IMAGING_STUDIES.md「所见草稿（T2.6）」）。
 *
 * - 模板（FindingsTemplates）：按机构 / 科室存在平台库，只追加、带版本；机构管理员维护机构默认模板，科室的审核医师维护本科室模板；AI 只能读。
 * - 生成（FindingsDraftService.generate）：一次检查 → 每个已确认的非影子肺结节一句（位置、密度、大小、随访变化），确定性。
 *   测量数字一律先经 MeasurementService.bind 绑定再写 [@m:id]（随访差值、VDT 用 imaging_followup 来源）。
 *   写入只经操作层（OpService.edit），按 AI 写入对待（actor = ai）：所有写前守卫照常生效——没有绕过守卫的写入口；
 *   AI 在对话里触发时带回合 id，doc_revert_turn 可单独撤销。
 * - 重复生成：同一检查已有草稿时默认拒绝（draft_exists），由人选「更新这份」或「新建一份」。更新只改「自上次生成后没人动过」的块，
 *   医生（或 AI 润色）改过、删掉的块原样保留；操作层的冲突守卫兜底。
 * - 核对与 RIS 纯文本（check / risText）：草稿依据的检查是否已变（新确认 / 被否决的结节、随访变化、定稿状态），测量是否失效；
 *   纯文本里测量展开为「数值 单位」，没有 markdown 记号与内部 id。
 */

const KIND = 'lung_nodule'
const LOBE: Record<string, string> = { RUL: '右肺上叶', RML: '右肺中叶', RLL: '右肺下叶', LUL: '左肺上叶', LLL: '左肺下叶' }
/** 肺叶的排序：右上、右中、右下、左上、左下；中文写法同样认 */
const LOBE_ORDER: Array<[RegExp, number]> = [
  [/^(RUL|右肺?上叶)$/, 1], [/^(RML|右肺?中叶)$/, 2], [/^(RLL|右肺?下叶)$/, 3], [/^(LUL|左肺?上叶)$/, 4], [/^(LLL|左肺?下叶)$/, 5],
]
const DENSITY: Record<string, string> = { solid: '实性', part_solid: '部分实性', pure_ggo: '磨玻璃' }
const CHANGE_TEXT: Record<ChangeKind, string> = { new: '新发', enlarged: '较前增大', shrunk: '较前缩小', stable: '较前相仿', disappeared: '本次未见' }
/** 病灶测量占位符 → 字段、单位 */
const LESION_ATOMS: Record<string, { field: string; unit: MeasureUnit }> = {
  平均径: { field: 'mean_diameter_mm', unit: 'mm' }, 长径: { field: 'long_axis_mm', unit: 'mm' }, 短径: { field: 'short_axis_mm', unit: 'mm' },
  体积: { field: 'volume_mm3', unit: 'mm3' }, CT值: { field: 'mean_hu', unit: 'HU' }, 实性成分: { field: 'solid_core_diameter_mm', unit: 'mm' }, CTR: { field: 'ctr', unit: 'ratio' },
}
const FOLLOWUP_ATOMS: Record<string, { field: string; unit: MeasureUnit }> = {
  平均径变化: { field: 'delta_mean_diameter_mm', unit: 'mm' }, 体积变化: { field: 'delta_volume_mm3', unit: 'mm3' },
  体积变化率: { field: 'delta_volume_pct', unit: 'pct' }, VDT: { field: 'vdt_days', unit: 'day' },
}

const now = () => new Date().toISOString()
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
// eslint-disable-next-line no-control-regex
const cleanText = (s: string | null | undefined, max = 40) => (s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const lobeName = (loc: string | null) => { const s = cleanText(loc); return LOBE[s] ?? s }
const lobeRank = (loc: string | null) => { const s = cleanText(loc); return LOBE_ORDER.find(([re]) => re.test(s))?.[1] ?? 9 }
const labelNo = (label: string | null) => { const m = /(\d+)\s*$/.exec(label ?? ''); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER }
/** 可比较的体积（分割失败时没有体积，与随访对比一致） */
const volumeOk = (m: Record<string, unknown>) => { const v = num(m.volume_mm3); return v !== null && v > 0 && m.segmentation !== 'failed' }

/** 结节的稳定顺序：肺叶（右上→左下，未定位的在后）→ 平均径从大到小 → 编号 → id */
export function sortNodules<T extends { location: string | null; metrics: Record<string, unknown>; label: string | null; id: string }>(list: T[]): T[] {
  return [...list].sort((x, y) => lobeRank(x.location) - lobeRank(y.location)
    || (num(y.metrics.mean_diameter_mm) ?? -1) - (num(x.metrics.mean_diameter_mm) ?? -1)
    || labelNo(x.label) - labelNo(y.label)
    || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
}

export class DraftError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 422 | 500 = 400, readonly extra: Record<string, unknown> = {}) { super(message) }
}

// —— 存储（平台库；模板与草稿登记都不含患者标识） ——

export function ensureDraftSchema(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS findings_templates (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL,
      body TEXT NOT NULL, note TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (tenant_id, scope, kind, version)
    );
    CREATE TRIGGER IF NOT EXISTS findings_templates_append_only BEFORE UPDATE ON findings_templates
      BEGIN SELECT RAISE(ABORT, 'findings_templates 只追加：改模板请保存新版本'); END;
    CREATE TABLE IF NOT EXISTS findings_drafts (
      doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL, patient_id TEXT NOT NULL, study_id TEXT NOT NULL,
      template_id TEXT NOT NULL, template_scope TEXT NOT NULL, template_version INTEGER NOT NULL,
      review_state TEXT NOT NULL, signoff_version INTEGER, prior_study_id TEXT, prior_reference TEXT,
      blocks TEXT NOT NULL, rev INTEGER NOT NULL, generations INTEGER NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL, generated_by TEXT NOT NULL, generated_via TEXT NOT NULL, generated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS findings_drafts_study ON findings_drafts (study_id);
  `)
}

export interface TemplateView {
  /** builtin = 内置；其余为模板行 id（每个版本一行） */
  id: string
  source: 'builtin' | 'org' | 'department'
  scope: string
  department_id: string | null
  department_name: string | null
  version: number
  body: FindingsTemplateBody
  note: string | null
  created_by: string | null
  created_by_name: string | null
  created_at: string | null
}

interface TemplateRow { id: string; tenant_id: string; scope: string; kind: string; version: number; body: string; note: string | null; created_by: string; created_at: string }

/** 草稿里一个块的登记：块 key、块 id、最近一次生成写下的内容（判断「之后有没有人改过」） */
export interface DraftBlock { key: string; id: string; md: string; lesion_id?: string; case?: NoduleCase | null; change?: ChangeKind | null; label?: string | null }
export interface DraftRow {
  doc_id: string; tenant_id: string; patient_id: string; study_id: string
  template_id: string; template_scope: string; template_version: number
  review_state: string; signoff_version: number | null; prior_study_id: string | null; prior_reference: string | null
  blocks: DraftBlock[]; rev: number; generations: number
  created_by: string; created_at: string; generated_by: string; generated_via: string; generated_at: string
}

const draftOf = (r: Record<string, unknown>): DraftRow => ({ ...(r as unknown as DraftRow), blocks: JSON.parse(r.blocks as string) as DraftBlock[] })

/**
 * 科室所见模板：按机构隔离；scope = org（机构默认）或 dept:<科室 id>。只追加：每次保存是一个新版本，旧版本保留（草稿记下用的是哪个版本）。
 * 没有自己的模板时用内置模板（BUILTIN_TEMPLATE）。
 */
export class FindingsTemplates {
  constructor(private readonly store: Store, private readonly patients: PatientService) { ensureDraftSchema(store) }

  private tenantOf(a: Actor): { id: string; kind: 'personal' | 'org' } {
    const t = this.patients.tenantService.of(a.userId, a.space ?? 'work')
    return { id: t.id, kind: t.kind }
  }

  private isAdmin(a: Actor): boolean { return this.patients.tenantService.roleOf(a.userId, a.space ?? 'work') === 'admin' }

  private departments(tenantId: string) { return this.store.listDepartments(tenantId) }

  /** 审核医师（影像阅片角色，机构患者库 imaging_reading_roles） */
  private isReviewer(a: Actor): boolean {
    try {
      const db = this.patients.imagingLookup(a).db
      ensureReviewSchema(db)
      return (db.prepare('SELECT role FROM imaging_reading_roles WHERE user_id = ?').get(a.userId) as { role: string } | undefined)?.role === 'reviewer'
    } catch { return false }
  }

  private view(r: TemplateRow | null, tenantId: string): TemplateView {
    if (!r) return { id: 'builtin', source: 'builtin', scope: 'builtin', department_id: null, department_name: null, version: BUILTIN_VERSION, body: BUILTIN_TEMPLATE, note: null, created_by: null, created_by_name: null, created_at: null }
    const dept = r.scope.startsWith('dept:') ? r.scope.slice(5) : null
    return {
      id: r.id, source: dept ? 'department' : 'org', scope: r.scope, department_id: dept,
      department_name: dept ? this.departments(tenantId).find(d => d.id === dept)?.name ?? null : null,
      version: r.version, body: JSON.parse(r.body) as FindingsTemplateBody, note: r.note, created_by: r.created_by,
      created_by_name: this.store.getUser(r.created_by)?.display_name ?? null, created_at: r.created_at,
    }
  }

  private latest(tenantId: string, scope: string): TemplateRow | null {
    return (this.store.db.prepare('SELECT * FROM findings_templates WHERE tenant_id = ? AND scope = ? AND kind = ? ORDER BY version DESC LIMIT 1').get(tenantId, scope, TEMPLATE_KIND) as TemplateRow | undefined) ?? null
  }

  /** 模板的某个版本（草稿核对用）；builtin 为内置模板 */
  byId(tenantId: string, id: string): TemplateView | null {
    if (id === 'builtin') return this.view(null, tenantId)
    const r = this.store.db.prepare('SELECT * FROM findings_templates WHERE id = ? AND tenant_id = ?').get(id, tenantId) as TemplateRow | undefined
    return r ? this.view(r, tenantId) : null
  }

  /** 某个 scope 现在的最新版本号（没有自己的模板为 null） */
  latestVersion(tenantId: string, scope: string): number | null { return this.latest(tenantId, scope)?.version ?? null }

  /** 能否维护某个 scope 的模板：机构默认 = 机构管理员；科室 = 机构管理员，或该科室成员里的审核医师。AI 一律不能。 */
  canEdit(a: Actor, scope: string): boolean {
    if (a.via === 'ai') return false
    if (this.isAdmin(a)) return true
    if (!scope.startsWith('dept:')) return false
    const dept = scope.slice(5)
    return this.store.departmentsOfUser(a.userId).includes(dept) && this.isReviewer(a)
  }

  /** 本机构的模板概况：机构默认、各科室、内置模板、我能改哪些、语法与占位符说明 */
  list(a: Actor): {
    org: TemplateView | null; departments: Array<{ id: string; name: string; mine: boolean; template: TemplateView | null; can_edit: boolean }>
    builtin: TemplateView; can_edit_org: boolean; placeholders: typeof PLACEHOLDERS; my_default: TemplateView | { error: string; departments: string[] }
  } {
    const t = this.tenantOf(a)
    const mine = new Set(this.store.departmentsOfUser(a.userId))
    const org = this.latest(t.id, 'org')
    let myDefault: TemplateView | { error: string; departments: string[] }
    try { myDefault = this.resolve(a, null) } catch (err) { myDefault = { error: (err as Error).message, departments: ((err as DraftError).extra?.departments as string[]) ?? [] } }
    return {
      org: org ? this.view(org, t.id) : null,
      departments: this.departments(t.id).map(d => {
        const r = this.latest(t.id, `dept:${d.id}`)
        return { id: d.id, name: d.name, mine: mine.has(d.id), template: r ? this.view(r, t.id) : null, can_edit: this.canEdit(a, `dept:${d.id}`) }
      }),
      builtin: this.view(null, t.id), can_edit_org: this.canEdit(a, 'org'), placeholders: PLACEHOLDERS, my_default: myDefault,
    }
  }

  /** 一个 scope 的全部版本（新的在前） */
  history(a: Actor, scope: string): TemplateView[] {
    const t = this.tenantOf(a)
    this.checkScope(t.id, scope)
    return (this.store.db.prepare('SELECT * FROM findings_templates WHERE tenant_id = ? AND scope = ? AND kind = ? ORDER BY version DESC').all(t.id, scope, TEMPLATE_KIND) as unknown as TemplateRow[]).map(r => this.view(r, t.id))
  }

  private checkScope(tenantId: string, scope: string): void {
    if (scope === 'org') return
    if (!scope.startsWith('dept:') || !this.departments(tenantId).some(d => d.id === scope.slice(5))) throw new DraftError('not_found', '科室不存在', 404)
  }

  /** 保存新版本（校验语法；旧版本保留） */
  save(a: Actor, scope: string, body: unknown, note: unknown): TemplateView {
    if (a.via === 'ai') throw new DraftError('forbidden', '所见模板由科室维护（机构管理员或本科室的审核医师），AI 不能修改', 403)
    if (a.space === 'personal') throw new DraftError('personal_space', '知家（个人空间）里没有所见模板', 403)
    const t = this.tenantOf(a)
    this.checkScope(t.id, scope)
    if (!this.canEdit(a, scope)) throw new DraftError('forbidden', scope === 'org' ? '机构默认模板只有机构管理员能修改' : '科室模板由机构管理员或本科室的审核医师维护', 403)
    let parsed: ParsedTemplate
    try { parsed = parseTemplate(body) } catch (err) {
      if (err instanceof TemplateError) throw new DraftError('template_invalid', err.message, 422, { where: err.where })
      throw err
    }
    const n = typeof note === 'string' ? cleanText(note, 200) || null : null
    const version = (this.latest(t.id, scope)?.version ?? 0) + 1
    const id = 'ft' + randomUUID().replace(/-/g, '').slice(0, 12)
    this.store.db.prepare('INSERT INTO findings_templates (id, tenant_id, scope, kind, version, body, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, t.id, scope, TEMPLATE_KIND, version, JSON.stringify(parsed.body), n, a.userId, now())
    return this.byId(t.id, id)!
  }

  /**
   * 生成时用哪份模板：指定科室 → 该科室的模板（没有则退到机构默认、再退到内置）；没指定 → 我所在的有模板的科室只有一个时用它，
   * 多个时须指定（department_required），一个都没有时用机构默认或内置。
   */
  resolve(a: Actor, departmentId: string | null | undefined): TemplateView {
    const t = this.tenantOf(a)
    const depts = this.departments(t.id)
    const mine = this.store.departmentsOfUser(a.userId).filter(id => depts.some(d => d.id === id))
    if (departmentId) {
      if (!depts.some(d => d.id === departmentId)) throw new DraftError('not_found', '科室不存在', 404)
      if (!mine.includes(departmentId) && !this.isAdmin(a)) throw new DraftError('not_in_department', '你不在这个科室，不能用它的模板', 403)
      const r = this.latest(t.id, `dept:${departmentId}`) ?? this.latest(t.id, 'org')
      return this.view(r, t.id)
    }
    const withTpl = mine.filter(id => this.latest(t.id, `dept:${id}`))
    if (withTpl.length > 1) {
      throw new DraftError('department_required', `你在 ${withTpl.length} 个有所见模板的科室，请选择用哪个科室的模板`, 409, { departments: withTpl.map(id => `${id}（${depts.find(d => d.id === id)!.name}）`) })
    }
    const r = (withTpl[0] ? this.latest(t.id, `dept:${withTpl[0]}`) : null) ?? this.latest(t.id, 'org')
    return this.view(r, t.id)
  }
}

// —— 生成 ——

interface AtomRef { source: 'imaging_lesion' | 'imaging_followup'; source_id: string; field: string; unit: MeasureUnit }
interface PlanBlock {
  key: string
  kind: 'title' | 'status' | 'comparison' | 'nodule' | 'disappeared' | 'none' | 'impression' | 'guideline_reference' | 'closing'
  parts: Part[]
  lesion_id?: string
  case?: NoduleCase | null
  change?: ChangeKind | null
  label?: string | null
}
export interface DraftGuidelineReference extends NoduleGuidelineSummary {
  dominant_lesion_id: string | null
  dominant_lesion_label: string | null
  confirmed_into_draft: boolean
  reference_sentence: string
}
interface Plan {
  blocks: PlanBlock[]
  atoms: Map<string, AtomRef>
  review: ReviewSummary
  followup: FollowupView
  guidelineReference: DraftGuidelineReference
  warnings: string[]
  nodules: number
  pending: number
}

export interface DraftOutcome {
  doc_id: string
  rev: number
  created: boolean
  template: { id: string; source: TemplateView['source']; department_id: string | null; department_name: string | null; version: number }
  review_state: ReviewSummary['state']
  signoff_version: number | null
  nodules: number
  /** W4.3 二期（T3.5）：Lung-RADS v2022 与 Fleischner 2017 规则推算参考（默认不写进草稿正文，仅在医生显式确认 confirm_guideline_reference=true 时写入） */
  guideline_reference: DraftGuidelineReference
  /** 写入 / 未变 / 保留（医生或 AI 改过、医生删掉的）/ 删除（结节已不是确认状态且块没人改过）的块 */
  blocks: { written: string[]; unchanged: string[]; kept: Array<{ key: string; block_id: string | null; reason: 'edited' | 'deleted' | 'edited_obsolete' }>; removed: string[] }
  warnings: string[]
  elapsed_ms: number
}

export interface DraftIssue { code: string; severity: 'block' | 'warn'; message: string; block_id?: string | null }

export interface DraftMeta {
  study_id: string; patient_id: string
  template: { id: string; source: string; version: number; department_name: string | null; latest_version: number | null }
  review_state: string; signoff_version: number | null; prior_reference: string | null
  generated_at: string; generated_by: string; generated_by_name: string | null; generated_via: string; generations: number
}

/** 草稿里的每个块都是一段（标题为一级标题）；块之间空一行 */
function blockMarkdown(b: PlanBlock, atomId: (key: string) => string): string {
  const body = partsToMarkdown(b.parts, atomId)
  return b.kind === 'title' ? `# ${body}` : body
}

export class FindingsDraftService {
  readonly templates: FindingsTemplates
  private readonly followup: ImagingFollowup

  constructor(
    private readonly store: Store,
    private readonly docs: Documents,
    private readonly ops: OpService,
    private readonly patients: PatientService,
    opts: { followup?: ImagingFollowup | null; templates?: FindingsTemplates } = {},
  ) {
    ensureDraftSchema(store)
    this.templates = opts.templates ?? new FindingsTemplates(store, patients)
    this.followup = opts.followup ?? sharedFollowup(patients)
  }

  getDraft(docId: string): DraftRow | null {
    const r = this.store.db.prepare('SELECT * FROM findings_drafts WHERE doc_id = ?').get(docId) as Record<string, unknown> | undefined
    return r ? draftOf(r) : null
  }

  /** 这位用户为某检查生成过、还没删的草稿（新的在前） */
  draftsOf(userId: string, studyId: string): DraftRow[] {
    return (this.store.db.prepare(`SELECT f.* FROM findings_drafts f JOIN docs d ON d.id = f.doc_id WHERE f.study_id = ? AND f.created_by = ? AND d.deleted_at IS NULL ORDER BY f.created_at DESC`)
      .all(studyId, userId) as Array<Record<string, unknown>>).map(draftOf)
  }

  /**
   * 按检查与模板算出草稿的每一块（只读，不写任何东西）。读权限 = 操作者对患者的读权限；影子检出、被否决 / 撤销 / 待确认的病灶一律不进。
   * strict = 生成时的规则（有待确认检出、没读过片就拒绝）；核对时为 false，只把情况写进 warnings。
   */
  private plan(
    a: Actor,
    patientId: string,
    studyId: string,
    tpl: ParsedTemplate,
    strict: boolean,
    opts: { confirmGuidelineReference?: boolean; riskLevel?: 'low' | 'high'; isScreening?: boolean } = {},
  ): Plan {
    const studies = new ImagingStudyService(this.patients, null)
    const study = studies.listStudies(a, patientId).find(s => s.id === studyId)
    if (!study) throw new PatientError('not_found', '影像检查不存在', 404)
    const all = studies.listLesions(a, studyId).filter(l => l.kind === KIND)
    const pending = all.filter(l => l.status === 'proposed').length
    const confirmed = sortNodules(all.filter(l => l.status === 'confirmed'))
    const review = new ImagingReviewService(this.patients).summary(a, studyId)
    const warnings: string[] = []
    if (pending) {
      if (strict) throw new DraftError('pending_lesions', `还有 ${pending} 个 AI 检出待确认或否决：处理完再生成所见草稿（草稿只写已确认的结节，有待确认的检出时生成会漏掉它们）`, 409, { pending })
      warnings.push(`本检查现有 ${pending} 个 AI 检出待确认`)
    }
    const doneRun = study.runs.some(r => r.task === KIND && r.status === 'done')
    if (!confirmed.length && !doneRun && review.state !== 'finalized' && review.state !== 'amending') {
      // 「未见明确结节」是结论：必须有完成的（可见的）肺结节分析且已逐个处理，或医生已定稿；否则不能凭空写
      if (strict) {
        throw new DraftError('not_read', study.ai_shadow
          ? '本检查没有已确认的结节：影像 AI 处于影子模式（结果不显示），请先在阅片器里阅片标注，或定稿后再生成（定稿为「未见结节」即可生成未见结节的草稿）'
          : '本检查还没有完成肺结节分析，也没有已确认的结节或定稿：不能生成「未见明确结节」的草稿', 409)
      }
      warnings.push('本检查没有完成的肺结节分析，也没有定稿')
    }
    const busy = study.runs[0] && (study.runs[0].status === 'queued' || study.runs[0].status === 'running')
    if (busy) warnings.push('本检查有正在进行的 AI 分析，完成后可能有新的检出，届时请核对或重新生成')

    const fu = this.followup.view(a, studyId)
    if (fu.run && (fu.run.status === 'queued' || fu.run.status === 'running')) warnings.push('随访对比正在计算，完成后请核对或重新生成')
    const itemOf = new Map(fu.items.filter(i => i.lesion_id).map(i => [i.lesion_id!, i]))
    const atoms = new Map<string, AtomRef>()
    const atom = (source: AtomRef['source'], sourceId: string, field: string, unit: MeasureUnit): Value => {
      const key = `${source}:${sourceId}:${field}`
      atoms.set(key, { source, source_id: sourceId, field, unit })
      return { atom: key }
    }
    const studyValues: Record<string, Value> = {
      检查日期: study.study_date ?? null,
      前片日期: fu.prior?.study_date ?? null,
      间隔: fu.prior?.interval_days != null && fu.prior.interval_days > 0 ? `${fu.prior.interval_days} 天` : null,
    }
    const blocks: PlanBlock[] = []
    blocks.push({ key: 'title', kind: 'title', parts: [{ text: tpl.title }] })
    blocks.push({ key: 'status', kind: 'status', parts: [{ text: statusText(review) }] })
    const compCase = !fu.prior ? 'none' : fu.prior.reference === 'finalized' ? 'finalized' : 'unfinalized'
    const comp = tpl.comparison[compCase]
    if (comp) blocks.push({ key: 'comparison', kind: 'comparison', parts: renderSentence(comp, studyValues) })
    if (fu.prior?.reference === 'confirmed') warnings.push(`前片（${fu.prior.study_date ?? '日期未知'}）尚未定稿：随访对比按前片已确认的结节`)

    confirmed.forEach((l, i) => {
      const it = itemOf.get(l.id) ?? null
      const c = noduleCase(fu, it)
      const values = this.noduleValues(l, i, it, studyValues, atom, warnings)
      const pieces = tpl.nodule[c] ?? tpl.nodule.default!
      if (it?.needs_review) warnings.push(`${l.label ?? '结节'}的随访对应需医生核对（${[...it.notes].join('；') || '配准不可靠或有歧义'}）`)
      blocks.push({ key: `nodule:${l.id}`, kind: 'nodule', parts: renderSentence(pieces, values), lesion_id: l.id, case: c, change: it?.change ?? null, label: l.label })
    })
    if (!confirmed.length) blocks.push({ key: 'none', kind: 'none', parts: renderSentence(tpl.none, studyValues) })
    // 前片有、本次没有的结节
    const gone = sortNodules(fu.items.filter(i => !i.lesion_id && i.prior_lesion && i.change === 'disappeared').map(i => ({ ...i.prior_lesion!, metrics: { mean_diameter_mm: i.prior_lesion!.mean_diameter_mm }, item: i })))
    const notCompared = fu.items.filter(i => !i.lesion_id && i.change === null).length
    if (notCompared) warnings.push(`前片有 ${notCompared} 个结节尚未与本次对比（请重新匹配）`)
    if (tpl.disappeared) {
      gone.forEach((g, i) => {
        if (g.item.needs_review) warnings.push(`前片${g.label ?? '结节'}按「消失」写入：${g.item.notes.join('；') || '请核对'}`)
        blocks.push({
          key: `gone:${g.id}`, kind: 'disappeared', change: 'disappeared', label: g.label,
          parts: renderSentence(tpl.disappeared!, { ...studyValues, 序号: String(i + 1), 前片编号: cleanText(g.label), 前片位置: lobeName(g.location) || null }),
        })
      })
    } else if (gone.length) warnings.push(`前片有 ${gone.length} 个结节本次未见，模板没有「消失」的句子，未写入`)
    const impPieces = confirmed.length ? tpl.impression.default : tpl.impression.none
    if (impPieces) {
      const impValues = this.impressionValues(confirmed, gone.length, fu, itemOf, studyValues, atom)
      blocks.push({ key: 'impression', kind: 'impression', parts: renderSentence(impPieces, impValues) })
    }
    const guidelineReference = this.computeGuidelineReference(a, patientId, confirmed, fu, itemOf, opts)
    if (opts.confirmGuidelineReference) {
      blocks.push({
        key: 'guideline_reference',
        kind: 'guideline_reference',
        parts: [{ text: guidelineReference.reference_sentence }],
      })
    }
    if (tpl.closing) blocks.push({ key: 'closing', kind: 'closing', parts: renderSentence(tpl.closing, studyValues) })
    // 只登记正文里真正用到的测量（模板没用到的字段不绑定）
    const kept = blocks.filter(b => b.parts.length)
    const used = new Set(kept.flatMap(b => b.parts.flatMap(p => 'atom' in p ? [p.atom] : [])))
    for (const k of [...atoms.keys()]) if (!used.has(k)) atoms.delete(k)
    return { blocks: kept, atoms, review, followup: fu, guidelineReference, warnings, nodules: confirmed.length, pending }
  }

  private computeGuidelineReference(
    a: Actor,
    patientId: string,
    confirmed: LesionRow[],
    fu: FollowupView,
    itemOf: Map<string, FollowupItem>,
    opts: { confirmGuidelineReference?: boolean; riskLevel?: 'low' | 'high'; isScreening?: boolean },
  ): DraftGuidelineReference {
    const top = [...confirmed].sort((x, y) => (num(y.metrics.mean_diameter_mm) ?? -1) - (num(x.metrics.mean_diameter_mm) ?? -1)
      || lobeRank(x.location) - lobeRank(y.location)
      || labelNo(x.label) - labelNo(y.label)
      || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0] ?? null

    let ageYears: number | null = null
    try {
      const p = this.patients.read(a, patientId)
      if (typeof p.birth_year === 'number' && Number.isFinite(p.birth_year)) {
        ageYears = new Date().getUTCFullYear() - p.birth_year
      }
    } catch { /* ignore if patient demographic unavailable */ }

    const topItem = top ? (itemOf.get(top.id) ?? null) : null
    const summary = evaluateNoduleGuidelines({
      nodule_type: top ? (String(top.metrics.nodule_type ?? '') || undefined) : 'none',
      mean_diameter_mm: top ? num(top.metrics.mean_diameter_mm) : null,
      solid_core_diameter_mm: top ? num(top.metrics.solid_core_diameter_mm) : null,
      scan_context: fu.prior ? 'followup' : 'baseline',
      is_new: topItem?.change === 'new',
      delta_mean_diameter_mm: topItem?.metrics?.delta_mean_diameter_mm ?? null,
      multiplicity: confirmed.length > 1 ? 'multiple' : 'single',
      risk_level: opts.riskLevel ?? 'low',
      age_years: ageYears,
      is_screening: opts.isScreening ?? false,
    })

    const lr = summary.lung_rads_2022
    const fl = summary.fleischner_2017
    const flClauseClean = fl.clause_citation.replace(/\s*\(MacMahon[^)]*\)/g, '')
    const confirmedIntoDraft = Boolean(opts.confirmGuidelineReference)
    const referenceSentence = [
      `指南分类参考（${GUIDELINE_PROVENANCE_LABEL}${confirmedIntoDraft ? ' · 医生已确认采纳' : ''}）：`,
      `ACR Lung-RADS v2022 ${lr.category_label_zh}，建议${lr.recommendation_zh}（依据：${lr.clause_citation}）；`,
      `Fleischner 2017 建议${fl.recommendation_zh}（依据：${flClauseClean}）。`,
    ].join('')

    return {
      ...summary,
      dominant_lesion_id: top?.id ?? null,
      dominant_lesion_label: top?.label ?? null,
      confirmed_into_draft: confirmedIntoDraft,
      reference_sentence: referenceSentence,
    }
  }

  private impressionValues(
    confirmed: LesionRow[],
    goneCount: number,
    fu: FollowupView,
    itemOf: Map<string, FollowupItem>,
    studyValues: Record<string, Value>,
    atom: (s: AtomRef['source'], id: string, f: string, u: MeasureUnit) => Value,
  ): Record<string, Value> {
    const top = [...confirmed].sort((x, y) => (num(y.metrics.mean_diameter_mm) ?? -1) - (num(x.metrics.mean_diameter_mm) ?? -1)
      || lobeRank(x.location) - lobeRank(y.location)
      || labelNo(x.label) - labelNo(y.label)
      || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0] ?? null
    let followupSummary: string | null = null
    if (fu.prior) {
      const counts = { new: 0, enlarged: 0, shrunk: 0, stable: 0 }
      let anyReview = false
      for (const l of confirmed) {
        const it = itemOf.get(l.id)
        if (!it || it.change === null) continue
        if (it.needs_review) { anyReview = true; continue }
        if (it.change in counts) counts[it.change as keyof typeof counts]++
      }
      if (!anyReview) {
        if (counts.stable === confirmed.length && confirmed.length > 0 && goneCount === 0) {
          followupSummary = '较前相仿'
        } else {
          const parts = [
            counts.new ? `新发 ${counts.new} 枚` : '',
            counts.enlarged ? `较前增大 ${counts.enlarged} 枚` : '',
            counts.shrunk ? `较前缩小 ${counts.shrunk} 枚` : '',
            counts.stable ? `较前相仿 ${counts.stable} 枚` : '',
            goneCount ? `前片所见 ${goneCount} 枚本次未见` : '',
          ].filter(Boolean)
          if (parts.length) followupSummary = parts.join('，')
        }
      }
    }
    const tm = top?.metrics ?? {}
    return {
      ...studyValues,
      结节数: confirmed.length ? String(confirmed.length) : null,
      最大结节编号: top ? cleanText(top.label) || null : null,
      最大结节位置: top ? lobeName(top.location) || null : null,
      最大结节密度: top ? DENSITY[String(tm.nodule_type ?? '')] ?? null : null,
      最大结节平均径: top && num(tm.mean_diameter_mm) !== null ? atom('imaging_lesion', top.id, 'mean_diameter_mm', 'mm') : null,
      最大结节长径: top && num(tm.long_axis_mm) !== null ? atom('imaging_lesion', top.id, 'long_axis_mm', 'mm') : null,
      最大结节体积: top && volumeOk(tm) ? atom('imaging_lesion', top.id, 'volume_mm3', 'mm3') : null,
      随访概况: followupSummary,
    }
  }

  private noduleValues(l: LesionRow, i: number, it: FollowupItem | null, studyValues: Record<string, Value>, atom: (s: AtomRef['source'], id: string, f: string, u: MeasureUnit) => Value, warnings: string[]): Record<string, Value> {
    const m = l.metrics
    const v: Record<string, Value> = {
      ...studyValues,
      序号: String(i + 1), 编号: cleanText(l.label) || null, 位置: lobeName(l.location) || null,
      密度: DENSITY[String(m.nodule_type ?? '')] ?? null,
    }
    for (const [name, def] of Object.entries(LESION_ATOMS)) {
      const ok = name === '体积' ? volumeOk(m) : num(m[def.field]) !== null
      v[name] = ok ? atom('imaging_lesion', l.id, def.field, def.unit) : null
    }
    if (m.segmentation === 'failed') warnings.push(`${l.label ?? '结节'}分割失败：没有体积，径线取检出框`)
    if (!l.location) warnings.push(`${l.label ?? '结节'}没有肺叶定位`)
    const paired = !!(it && it.metrics && it.prior_lesion_id && it.lesion_id && it.change && it.change !== 'new' && !it.needs_review)
    v.变化 = it?.change && !it.needs_review ? CHANGE_TEXT[it.change] : null
    v.前片编号 = it?.prior_lesion ? cleanText(it.prior_lesion.label) || null : null
    v.误差说明 = paired && it!.metrics!.within_error ? '变化在测量误差范围内' : null
    for (const [name, def] of Object.entries(FOLLOWUP_ATOMS)) {
      const raw = paired ? num((it!.metrics as unknown as Record<string, unknown>)[def.field]) : null
      // VDT 只在体积增大且超出测量误差时写（误差内的 VDT 不可靠，见随访对比）
      const usable = raw !== null && (name !== 'VDT' || !it!.metrics!.within_error)
      v[name] = usable ? atom('imaging_followup', l.id, def.field, def.unit) : null
    }
    return v
  }

  /**
   * 生成所见草稿。input.doc_id = 更新这份草稿（只改没人动过的块）；input.new = 已有草稿时仍新建一份。
   * input.confirm_guideline_reference = 医生本人确认将 Lung-RADS v2022 / Fleischner 2017 指南分类参考写入草稿（默认 false 不进入草稿；AI 禁止代确认）。
   * meta.turnId：AI 在对话里触发时的回合（doc_revert_turn 可撤销）；界面按钮触发时为 null。
   */
  generate(
    a: Actor,
    patientId: string,
    input: {
      study_id: string
      doc_id?: string | null
      new?: boolean
      department_id?: string | null
      confirm_guideline_reference?: boolean
      risk_level?: 'low' | 'high'
      is_screening?: boolean
    },
    meta: { turnId: string | null },
  ): DraftOutcome {
    const t0 = Date.now()
    if (a.space === 'personal') throw new DraftError('personal_space', '知家（个人空间）里不生成影像所见草稿；请在工作台的患者页生成', 403)
    if (input.confirm_guideline_reference && a.via === 'ai') {
      throw new DraftError('guideline_confirmation_human_only', '指南分类与随访建议属「规则推算，待医生确认」，只能由医生本人确认后写入草稿，AI 不能代为确认', 403)
    }
    // 写权限（诊疗组成员）：没有就当不存在 / 403，与其它影像写操作一致
    this.patients.imagingScope(a, patientId, 'write')
    const tplView = this.templates.resolve(a, input.department_id)
    let tpl: ParsedTemplate
    try { tpl = parseTemplate(tplView.body) } catch (err) {
      if (err instanceof TemplateError) throw new DraftError('template_invalid', `所用模板（v${tplView.version}）有错：${err.message}`, 422, { where: err.where })
      throw err
    }
    let existingDoc: DocRow | null = null
    let record: DraftRow | null = null
    if (input.doc_id) {
      const doc = this.store.getDoc(input.doc_id)
      if (!doc || doc.deleted_at || doc.owner !== a.userId) throw new DraftError('not_found', '文档不存在', 404)
      record = this.getDraft(doc.id)
      if (!record) throw new DraftError('not_a_draft', '这份文档不是所见草稿，不能在里面生成（草稿只能写进由「生成所见草稿」新建的文档）', 409)
      const ctx = docContext(doc)
      if (ctx?.kind !== 'patient' || ctx.patient_id !== patientId) throw new DraftError('doc_other_patient', '这份文档关联的是另一位患者', 409)
      if (record.study_id !== input.study_id) throw new DraftError('draft_other_study', '这份草稿是另一次检查的；请为本检查新建草稿', 409, { study_id: record.study_id })
      existingDoc = doc
    }
    const hadConfirmedGuideline = Boolean(record?.blocks.some(b => b.key === 'guideline_reference'))
    const confirmGuideline = input.confirm_guideline_reference !== undefined ? Boolean(input.confirm_guideline_reference) : hadConfirmedGuideline
    const plan = this.plan(a, patientId, input.study_id, tpl, true, {
      confirmGuidelineReference: confirmGuideline,
      riskLevel: input.risk_level,
      isScreening: input.is_screening,
    })
    const tenantId = this.patients.tenantService.of(a.userId, a.space ?? 'work').id

    let row: DocRow
    let created = false
    if (existingDoc) {
      row = existingDoc
    } else {
      const existing = this.draftsOf(a.userId, input.study_id)
      if (existing.length && !input.new) {
        throw new DraftError('draft_exists', '这次检查已经有你生成的所见草稿：选择更新那份（只改没人动过的段落），或新建一份', 409, { doc_id: existing[0]!.doc_id, doc_ids: existing.map(d => d.doc_id) })
      }
      row = this.docs.create({ owner: a.userId, title: '所见草稿' })
      created = true
      try {
        this.patients.linkDoc(a, patientId, row.id, 'findings')
        const ctx = docContext(this.store.getDoc(row.id)!)
        const study = new ImagingStudyService(this.patients, null).listStudies(a, patientId).find(s => s.id === input.study_id)
        this.store.renameDoc(row.id, `${ctx?.code ?? ''} 胸部 CT 所见草稿 · ${study?.study_date ?? '检查日期未知'}`.trim())
        row = this.store.getDoc(row.id)!
      } catch (err) { this.discard(row.id); throw err }
    }

    try {
      // 1) 绑定测量（同一来源、字段、单位在同一文档里 id 不变：重复生成时正文标记不变）
      const ms = new MeasurementService(this.store, this.patients)
      const ids = new Map<string, string>()
      for (const [key, ref] of plan.atoms) {
        try { ids.set(key, ms.bind(a, row, { source: ref.source, source_id: ref.source_id, field: ref.field, unit: ref.unit }).row.id) } catch (err) {
          if (err instanceof MeasurementError) throw new DraftError(err.code, `绑定测量失败：${err.message}`, err.status === 422 ? 422 : 409)
          throw err
        }
      }
      const atomId = (key: string) => ids.get(key)!
      const md = new Map(plan.blocks.map(b => [b.key, blockMarkdown(b, atomId)]))
      // 写进去之前核对往返：转义后的 markdown 解析回来必须与预期文字完全一致（模板 / 位置里的记号不会变成格式或原子）
      for (const b of plan.blocks) {
        const nodes = parseBlocks(md.get(b.key)!)
        const expect = partsToPlain(b.parts, atomId)
        if (nodes.length !== 1 || plainText(nodes[0]!) !== expect || (b.kind === 'title') !== (nodes[0]!.type.name === 'heading')) {
          throw new DraftError('draft_render_mismatch', `草稿第「${b.key}」块渲染后与预期不一致`, 500)
        }
      }
      const out = this.write(a, row.id, record, plan, md, meta)
      const blocks: DraftBlock[] = plan.blocks.map(b => {
        const id = out.idOf.get(b.key) ?? null
        const keptOld = record?.blocks.find(x => x.key === b.key)
        const node = id ? findNode(this.docs.get(row.id), id) : null
        const kept = out.kept.find(k => k.key === b.key)
        return {
          key: b.key, id: id ?? keptOld?.id ?? '', md: kept ? keptOld?.md ?? '' : node ? serializeBlock(node, {}, '') : '',
          ...(b.lesion_id ? { lesion_id: b.lesion_id } : {}), case: b.case ?? null, change: b.change ?? null, label: b.label ?? null,
        }
      })
      // 已不在计划里、但医生改过而保留的块：仍登记（下次生成同样不动它）
      for (const k of out.kept.filter(k => k.reason === 'edited_obsolete')) {
        const old = record?.blocks.find(x => x.key === k.key)
        if (old) blocks.push({ ...old, key: `${old.key}#kept` })
      }
      // 以前就保留下来的块：还在文档里就继续登记（核对时仍标出），结节重新确认后已另写新句的不再登记
      const after = this.docs.get(row.id)
      for (const o of record?.blocks ?? []) {
        if (o.key.endsWith('#kept') && o.id && findNode(after, o.id) && !blocks.some(b => b.key === o.key || b.id === o.id)) blocks.push(o)
      }
      const rev = this.docs.rev(row.id)
      const t = now()
      const signoff = plan.review.latest_signoff?.version ?? null
      if (record) {
        this.store.db.prepare(`UPDATE findings_drafts SET template_id = ?, template_scope = ?, template_version = ?, review_state = ?, signoff_version = ?, prior_study_id = ?, prior_reference = ?,
          blocks = ?, rev = ?, generations = generations + 1, generated_by = ?, generated_via = ?, generated_at = ? WHERE doc_id = ?`)
          .run(tplView.id, tplView.scope, tplView.version, plan.review.state, signoff, plan.followup.prior?.study_id ?? null, plan.followup.prior?.reference ?? null, JSON.stringify(blocks), rev, a.userId, a.via, t, row.id)
      } else {
        this.store.db.prepare(`INSERT INTO findings_drafts (doc_id, tenant_id, patient_id, study_id, template_id, template_scope, template_version, review_state, signoff_version, prior_study_id, prior_reference,
          blocks, rev, generations, created_by, created_at, generated_by, generated_via, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
          .run(row.id, tenantId, patientId, input.study_id, tplView.id, tplView.scope, tplView.version, plan.review.state, signoff, plan.followup.prior?.study_id ?? null, plan.followup.prior?.reference ?? null,
            JSON.stringify(blocks), rev, a.userId, t, a.userId, a.via, t)
      }
      this.patients.imagingScope(a, patientId, 'read').log('imaging_findings_draft', `${input.study_id}:${row.id}`)
      return {
        doc_id: row.id, rev, created,
        template: { id: tplView.id, source: tplView.source, department_id: tplView.department_id, department_name: tplView.department_name, version: tplView.version },
        review_state: plan.review.state, signoff_version: signoff, nodules: plan.nodules,
        guideline_reference: plan.guidelineReference,
        blocks: { written: out.written, unchanged: out.unchanged, kept: out.kept, removed: out.removed },
        warnings: [...new Set(plan.warnings)], elapsed_ms: Date.now() - t0,
      }
    } catch (err) {
      if (created) this.discard(row.id, a, patientId)
      throw err
    }
  }

  /** 新建失败时删掉文档与关联（不留下空草稿） */
  private discard(docId: string, a?: Actor, patientId?: string): void {
    try { if (a && patientId) this.patients.unlinkDoc(a, patientId, docId) } catch { /* 尽力而为 */ }
    this.store.deleteDoc(docId)
    this.docs.unload(docId)
  }

  /**
   * 写入：只经操作层，actor = ai（守卫全开）。新文档：整份写进第一个空段落。已有草稿：
   * - 计划里的块上次写下的内容（md）与现在一致 → 没人动过，可以替换；不一致 → 医生（或 AI 润色）改过，保留；不在了 → 医生删掉的，不再补回；
   * - 新增的块插在计划里前一个仍在的块之后；不再需要的块（结节被否决 / 撤销）没人动过就删除，改过就保留并提示。
   * 冲突守卫兜底：某个操作被 conflict_user_edited 拦下时去掉它（当作保留）再提交。
   */
  private write(a: Actor, docId: string, record: DraftRow | null, plan: Plan, md: Map<string, string>, meta: { turnId: string | null }): {
    idOf: Map<string, string>; written: string[]; unchanged: string[]; kept: DraftOutcome['blocks']['kept']; removed: string[]
  } {
    const idOf = new Map<string, string>()
    const written: string[] = [], unchanged: string[] = [], removed: string[] = []
    const kept: DraftOutcome['blocks']['kept'] = []
    this.docs.flush(docId)
    if (!record) {
      const first = this.docs.get(docId).child(0).attrs.id as string
      this.ops.edit({ doc_id: docId, base_rev: this.docs.rev(docId), mode: 'apply', ops: [{ op: 'replace_block', id: first, markdown: plan.blocks.map(b => md.get(b.key)!).join('\n\n') }] }, { actor: 'ai', turnId: meta.turnId, user: a.userId })
      const doc = this.docs.get(docId)
      plan.blocks.forEach((b, i) => { idOf.set(b.key, doc.child(i).attrs.id as string); written.push(b.key) })
      return { idOf, written, unchanged, kept, removed }
    }
    const doc = this.docs.get(docId)
    const old = new Map(record.blocks.map(b => [b.key, b]))
    const present = (id: string) => findNode(doc, id)
    type Pending = { op: DocOp; keys: string[]; kind: 'replace' | 'delete' | 'insert' }
    const pending: Pending[] = []
    /** 计划里的块在文档里的落点（已有且仍在的块） */
    const anchorOf = new Map<string, string>()
    for (const b of plan.blocks) {
      const o = old.get(b.key)
      if (!o) continue
      const node = o.id ? present(o.id) : null
      if (!node) { kept.push({ key: b.key, block_id: null, reason: 'deleted' }); continue }
      anchorOf.set(b.key, o.id)
      idOf.set(b.key, o.id)
      if (serializeBlock(node, {}, '') !== o.md) { kept.push({ key: b.key, block_id: o.id, reason: 'edited' }); continue }
      if (o.md === md.get(b.key) || serializeBlock(parseBlocks(md.get(b.key)!)[0]!, {}, '') === o.md) { unchanged.push(b.key); continue }
      pending.push({ op: { op: 'replace_block', id: o.id, markdown: md.get(b.key)! }, keys: [b.key], kind: 'replace' })
    }
    for (const o of record.blocks) {
      if (plan.blocks.some(b => b.key === o.key) || o.key.endsWith('#kept')) continue
      const node = o.id ? present(o.id) : null
      if (!node) continue
      if (serializeBlock(node, {}, '') !== o.md) { kept.push({ key: o.key, block_id: o.id, reason: 'edited_obsolete' }); continue }
      pending.push({ op: { op: 'delete', ids: [o.id] }, keys: [o.key], kind: 'delete' })
    }
    // 新块：按计划顺序分组，插在前一个仍在的块之后（没有就插在后一个之前，再没有就追加到文末）
    const fresh = plan.blocks.filter(b => !old.has(b.key))
    let i = 0
    while (i < fresh.length) {
      const start = plan.blocks.indexOf(fresh[i]!)
      const group = [fresh[i]!]
      while (i + 1 < fresh.length && plan.blocks.indexOf(fresh[i + 1]!) === plan.blocks.indexOf(group[group.length - 1]!) + 1) group.push(fresh[++i]!)
      i++
      const before = plan.blocks.slice(0, start).reverse().find(b => anchorOf.has(b.key))
      const after = plan.blocks.slice(start + group.length).find(b => anchorOf.has(b.key))
      const markdown = group.map(b => md.get(b.key)!).join('\n\n')
      const last = doc.child(doc.childCount - 1).attrs.id as string
      const op: DocOp = before ? { op: 'insert_after', anchor_id: anchorOf.get(before.key)!, markdown }
        : after ? { op: 'insert_before', anchor_id: anchorOf.get(after.key)!, markdown }
          : { op: 'insert_after', anchor_id: last, markdown }
      pending.push({ op, keys: group.map(b => b.key), kind: 'insert' })
    }
    let batch = [...pending.filter(p => p.kind === 'replace'), ...pending.filter(p => p.kind === 'delete'), ...pending.filter(p => p.kind === 'insert')]
    for (let attempt = 0; batch.length && attempt < 20; attempt++) {
      try {
        const res = this.ops.edit({ doc_id: docId, base_rev: Math.min(record.rev, this.docs.rev(docId)), mode: 'apply', ops: batch.map(p => p.op) }, { actor: 'ai', turnId: meta.turnId, user: a.userId })
        batch.forEach((p, k) => {
          if (p.kind === 'replace') written.push(...p.keys)
          else if (p.kind === 'delete') removed.push(...p.keys)
          else {
            const ids = res.results.find(r => r.op_index === k)?.ids ?? []
            p.keys.forEach((key, j) => { if (ids[j]) idOf.set(key, ids[j]!); written.push(key) })
          }
        })
        break
      } catch (err) {
        if (!(err instanceof OpError) || err.code !== 'conflict_user_edited' || err.extra.op_index === undefined) throw err
        const p = batch[err.extra.op_index]!
        for (const key of p.keys) kept.push({ key, block_id: p.op.op === 'replace_block' ? p.op.id : p.op.op === 'delete' ? p.op.ids[0]! : null, reason: p.kind === 'delete' ? 'edited_obsolete' : 'edited' })
        batch = batch.filter((_, k) => k !== err.extra.op_index)
      }
    }
    return { idOf, written, unchanged, kept, removed }
  }

  // —— 核对与 RIS 纯文本 ——

  private meta(record: DraftRow): DraftMeta {
    const tpl = this.templates.byId(record.tenant_id, record.template_id)
    return {
      study_id: record.study_id, patient_id: record.patient_id,
      template: { id: record.template_id, source: tpl?.source ?? 'builtin', version: record.template_version, department_name: tpl?.department_name ?? null, latest_version: record.template_scope === 'builtin' ? BUILTIN_VERSION : this.templates.latestVersion(record.tenant_id, record.template_scope) },
      review_state: record.review_state, signoff_version: record.signoff_version, prior_reference: record.prior_reference,
      generated_at: record.generated_at, generated_by: record.generated_by, generated_by_name: this.store.getUser(record.generated_by)?.display_name ?? null,
      generated_via: record.generated_via, generations: record.generations,
    }
  }

  /**
   * 草稿是否还与来源一致（读者本人的权限）：定稿状态、新确认 / 已否决的结节、随访变化。不是草稿的文档只核对测量。
   */
  check(viewer: Actor | null, doc: DocRow, measurements: MeasureLookup): { draft: DraftMeta | null; issues: DraftIssue[] } {
    const issues: DraftIssue[] = []
    const used = new Set<string>()
    this.docs.get(doc.id).descendants(n => { if (n.type.name === 'measurement') used.add(String(n.attrs.m_id)); return true })
    for (const id of used) {
      const v = measurements.get(id)
      const text = measureExportText(v, id)
      if (!v || ['rejected', 'withdrawn', 'unconfirmed', 'field_missing', 'unknown'].includes(v.status)) {
        issues.push({ code: 'measurement_invalid', severity: 'block', message: `测量「${v?.source_label ?? '未登记'}」${text.includes('〔') ? text.slice(text.indexOf('〔')) : ''}：来源已失效，复制前请核对或删改这句` })
      } else if (v.status === 'no_access') {
        issues.push({ code: 'measurement_no_access', severity: 'warn', message: `你没有查看「${v.source_label}」来源的权限：显示的是绑定时的值，可能不是最新` })
      }
    }
    const record = this.getDraft(doc.id)
    if (!record) return { draft: null, issues }
    const meta = this.meta(record)
    if (meta.template.latest_version !== null && meta.template.latest_version > record.template_version) {
      issues.push({ code: 'template_updated', severity: 'warn', message: `所用模板已有新版本（v${record.template_version} → v${meta.template.latest_version}），需要时可重新生成` })
    }
    if (!viewer) return { draft: meta, issues }
    let plan: Plan
    try {
      const tpl = this.templates.byId(record.tenant_id, record.template_id)
      plan = this.plan({ ...viewer, space: measureSpace(doc) }, record.patient_id, record.study_id, parseTemplate(tpl?.body ?? BUILTIN_TEMPLATE), false)
    } catch (err) {
      issues.push({ code: 'source_unavailable', severity: 'warn', message: `无法核对草稿依据的检查是否有变化：${(err as Error).message}` })
      return { draft: meta, issues }
    }
    const st = plan.review
    if (st.state !== 'finalized') {
      issues.push({ code: 'not_finalized', severity: 'warn', message: st.state === 'amending' ? `本检查第 ${st.latest_signoff?.version} 版定稿后又有修改、尚未再次定稿` : '本检查尚未定稿：草稿依据的结节与测量还可能变化' })
    } else if (record.signoff_version !== st.latest_signoff?.version) {
      issues.push({ code: 'signoff_changed', severity: 'warn', message: `草稿生成时${record.signoff_version ? `依据第 ${record.signoff_version} 版定稿` : '检查尚未定稿'}，现在是第 ${st.latest_signoff?.version} 版定稿：请重新生成或核对` })
    }
    if (plan.pending) issues.push({ code: 'pending_lesions', severity: 'warn', message: `本检查现有 ${plan.pending} 个 AI 检出待确认` })
    const was = new Map(record.blocks.filter(b => b.lesion_id).map(b => [b.key, b]))
    const cur = new Map(plan.blocks.filter(b => b.kind === 'nodule').map(b => [b.key, b]))
    const docNow = this.docs.get(doc.id)
    for (const [key, b] of was) {
      if (key.endsWith('#kept')) {
        if (b.id && findNode(docNow, b.id) && !cur.has(key.slice(0, -5))) issues.push({ code: 'nodule_removed', severity: 'block', block_id: b.id, message: `「${b.label ?? '结节'}」已不是已确认的结节，这句因被修改过而保留：请删改这句` })
        continue
      }
      if (!cur.has(key)) issues.push({ code: 'nodule_removed', severity: 'block', block_id: b.id || null, message: `草稿里的「${b.label ?? '结节'}」已不是已确认的结节（被否决、撤销或取代）：请删改这句` })
      else if ((cur.get(key)!.case ?? null) !== (b.case ?? null)) issues.push({ code: 'change_changed', severity: 'warn', block_id: b.id || null, message: `「${b.label ?? '结节'}」的随访情况已变（${caseText(b.case)} → ${caseText(cur.get(key)!.case)}）：请重新生成或手改` })
    }
    const added = [...cur.values()].filter(b => !was.has(b.key))
    if (added.length) issues.push({ code: 'nodule_added', severity: 'warn', message: `有 ${added.length} 个已确认的结节不在草稿里（${added.map(b => b.label ?? '结节').join('、')}）：请重新生成（只补新段落，不动你改过的）` })
    const gone = new Set(plan.blocks.filter(b => b.kind === 'disappeared').map(b => b.key))
    const goneWas = record.blocks.filter(b => b.key.startsWith('gone:'))
    if (goneWas.some(b => !gone.has(b.key)) || [...gone].some(k => !goneWas.some(b => b.key === k))) issues.push({ code: 'disappeared_changed', severity: 'warn', message: '前片「本次未见」的结节有变化：请重新生成或核对' })
    for (const w of plan.warnings.filter(w => w.includes('需医生核对'))) issues.push({ code: 'followup_review', severity: 'warn', message: w })
    return { draft: meta, issues }
  }

  /** 复制为 RIS 纯文本：不含草稿标题与〔草稿〕状态行；测量按读者权限取当前值 */
  risText(viewer: Actor | null, doc: DocRow, measurements: MeasureLookup): { text: string; notes: string[]; issues: DraftIssue[]; draft: DraftMeta | null } {
    const record = this.getDraft(doc.id)
    const exclude = new Set(record?.blocks.filter(b => b.key === 'title' || b.key === 'status').map(b => b.id).filter(Boolean) ?? [])
    this.docs.flush(doc.id)
    const { text, notes } = risPlainText(this.docs.get(doc.id), { exclude, measurements })
    const { issues, draft } = this.check(viewer, doc, measurements)
    return { text, notes, issues, draft }
  }
}

function noduleCase(fu: FollowupView, it: FollowupItem | null): NoduleCase {
  if (!fu.prior) return 'no_prior'
  if (!it || it.change === null) return 'default'
  if (it.needs_review) return 'review'
  return it.change === 'disappeared' ? 'default' : it.change
}

const CASE_TEXT: Record<string, string> = { default: '未对比', new: '新发', enlarged: '增大', shrunk: '缩小', stable: '稳定', review: '待核对', no_prior: '无前片' }
const caseText = (c: NoduleCase | null | undefined) => CASE_TEXT[c ?? 'default'] ?? String(c)

/** 草稿状态行（平台写的，不来自模板；不进 RIS 纯文本） */
function statusText(r: ReviewSummary): string {
  const so = r.latest_signoff
  if (r.state === 'finalized' && so) return `〔草稿〕据本检查第 ${so.version} 版定稿（${so.signed_at.slice(0, 10)}）的结节生成。`
  if (r.state === 'amending' && so) return `〔草稿〕本检查第 ${so.version} 版定稿后又有修改、尚未再次定稿：以下所见据当前已确认的结节生成。`
  return '〔草稿〕本检查尚未定稿：以下所见据当前已确认的结节生成，定稿前可能变化。'
}

function docContext(doc: DocRow): { kind?: string; patient_id?: string; code?: string; space?: string } | null {
  try { return doc.context ? JSON.parse(doc.context) : null } catch { return null }
}

function findNode(doc: PMNode, id: string): PMNode | null {
  let hit: PMNode | null = null
  doc.forEach(n => { if (!hit && n.attrs.id === id) hit = n })
  return hit
}

