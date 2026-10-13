import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Space, TenantService, TenantSettings } from '../auth/tenants.ts'
import type { Store } from '../store/db.ts'
import type { TenantKeys } from './keys.ts'
import type { Complete } from '../memory/evolve.ts'
import { extractReport, redact } from './extract-report.ts'
import { standardize, standardizeRange } from './units.ts'

/**
 * 患者数据（docs/design/TENANCY.md §2、§4；患者模块第二期的底座）。
 * - **每个机构一个库文件**：data/tenants/<机构>/patients.db 与 files/。连接本身只属于一个机构，查询写错也读不到别的机构。
 * - 患者只有代号（P-0001）、性别、出生年份、诊断标签；**不存姓名**（代号 ↔ 姓名只在医生自己的浏览器里）。
 * - 原始报告文件、文件名、自由文本用机构数据密钥加密（keys.ts）。
 * - 可见范围：诊疗组（创建者 + 被加入的成员），或机构设置为本机构全员；机构管理员不自动可见，查看要走紧急访问（填理由、24 小时、留痕）。
 *   看不到的患者一律当不存在（不暴露存在与否）。
 * - 每次查看、下载、导出都记访问日志（谁、何时、做了什么）。
 * - AI 与人操作能力相同（经 MCP，以当前用户身份，访问日志标明 AI）。机构设置 ai_patient_writes：
 *   review（默认）= AI 的写入进待确认 / 提议，由医生确认；direct = 和人一样直接生效。确认化验、确认报告这类「审核」本身在 review 模式下只能由人做。
 *   两项不给 AI：删除患者（不可恢复，与文档一致）、紧急访问（机构管理员以个人名义承担，理由须本人填写）。
 * - 化验日期是报告上的日期（collected_on），不是上传时间（v1 的教训）。
 */

export class PatientError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message) }
}

/** 成员标记（知家红线守卫用；与 ops/phr-guard.ts 的 PhrMember 同形）。 */
export interface PhrMemberLike { tags: string[]; birth_year: number | null }

export interface PatientRow {
  id: string; code: string; sex: 'M' | 'F' | null; birth_year: number | null; tags: string[]
  /** 称呼（家人档案里的叫法，加密存储；机构端为 null，患者端用称呼不用代号） */
  name: string | null
  status: 'active' | 'archived'; created_by: string; created_at: string; updated_at: string
}
export interface LabRow {
  id: string; patient_id: string; record_id: string | null; test_key: string; test_name: string
  value_num: number | null; value_text: string | null; unit: string | null
  ref_low: number | null; ref_high: number | null; ref_text: string | null; flag: 'H' | 'L' | null
  /** 报告上的日期；提取时报告上没写日期的为 null，确认报告时由医生补填 */
  collected_on: string | null; status: 'pending' | 'confirmed' | 'rejected' | 'superseded'; source: 'manual' | 'extracted' | 'ai' | 'share'
  locator: { page?: number; bbox?: number[]; verified?: boolean } | null
  /** 采样时间（报告上有时间时，YYYY-MM-DD HH:MM），同一天多次检查按它排序 */
  collected_at: string | null
  /** 审核时医生选择「用这个替换」的旧值（同日同项的已确认化验）；确认后旧值标为 superseded */
  replaces: string | null
  /** 换算到标准单位后的值、单位、参考范围（原始值不变，见 units.ts） */
  std_value: number | null; std_unit: string | null; std_ref_low: number | null; std_ref_high: number | null; converted: boolean; unknown_unit: boolean
  created_by: string; created_at: string; confirmed_by: string | null; confirmed_at: string | null
}
export interface RecordRow {
  id: string; patient_id: string; kind: 'lab_report' | 'discharge' | 'pathology' | 'imaging' | 'note' | 'other'
  title: string; report_date: string | null; file_id: string | null; status: 'pending' | 'confirmed' | 'rejected'
  /** 自动提取：排队 / 进行中 / 完成 / 失败 / 跳过（机构不允许交给外部模型，或没有可读文字） */
  extraction: 'queued' | 'running' | 'done' | 'failed' | 'skipped' | null; extraction_note: string | null
  created_by: string; created_at: string; confirmed_by: string | null; confirmed_at: string | null
  /** 来源：share:<分享 id> / ai_report（AI 生成的报告草稿，须医生确认）/ platform_report（医生本人生成） */
  origin?: string | null
  imaging_data?: Record<string, unknown> | null
}

/** 报告文字：PDF（文字层 / 扫描件 OCR）、图片（OCR）→ 每页文字。 */
export type ReportPages = (name: string, mime: string, bytes: Uint8Array) => Promise<string[]>
export interface ProposalRow {
  id: string; patient_id: string; kind: 'lab' | 'tag' | 'note' | 'update' | 'enroll' | 'unenroll'; payload: Record<string, unknown>; reason: string
  turn_id: string | null; status: 'pending' | 'accepted' | 'rejected'; created_by: string; created_at: string; resolved_by: string | null; resolved_at: string | null
}

const now = () => new Date().toISOString()
const rid = (p: string) => p + randomUUID().replace(/-/g, '').slice(0, 12)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const BREAK_GLASS_HOURS = 24

/** 化验项目名 → 标准键（同一项目不同叫法归一）。常见的先列，其余用规范化后的原名。 */
const TEST_ALIASES: Array<[RegExp, string]> = [
  [/^(alt|gpt|谷丙转氨酶|丙氨酸氨基转移酶)$/i, 'alt'], [/^(ast|got|谷草转氨酶|天门冬氨酸氨基转移酶)$/i, 'ast'],
  [/^(cr|crea|scr|肌酐|血肌酐)$/i, 'creatinine'], [/^(egfr|估算肾小球滤过率)$/i, 'egfr'],
  [/^(hba1c|糖化血红蛋白)$/i, 'hba1c'], [/^(glu|fpg|葡萄糖|空腹血糖|血糖)$/i, 'glucose'],
  [/^(tc|chol|总胆固醇)$/i, 'cholesterol'], [/^(tg|甘油三酯)$/i, 'triglycerides'], [/^(ldl-?c|低密度脂蛋白胆固醇)$/i, 'ldl'], [/^(hdl-?c|高密度脂蛋白胆固醇)$/i, 'hdl'],
  [/^(wbc|白细胞|白细胞计数)$/i, 'wbc'], [/^(hb|hgb|血红蛋白)$/i, 'hemoglobin'], [/^(plt|血小板|血小板计数)$/i, 'platelets'],
  [/^(alb|白蛋白)$/i, 'albumin'], [/^(tbil|总胆红素)$/i, 'bilirubin'], [/^(ua|尿酸)$/i, 'uric_acid'], [/^(k|钾|血钾)$/i, 'potassium'],
  [/^(tp|总蛋白)$/i, 'total_protein'], [/^(urea|bun|尿素|尿素氮)$/i, 'urea'], [/^(na|钠|血钠)$/i, 'sodium'], [/^(cl|氯|血氯)$/i, 'chloride'],
  [/^(bnp|脑钠肽)$/i, 'bnp'], [/^(nt-?probnp|n末端脑钠肽前体)$/i, 'nt_probnp'], [/^(crp|c反应蛋白)$/i, 'crp'],
  [/^(eos|eos%|eos#|嗜酸性粒细胞|嗜酸性粒细胞绝对值|嗜酸性粒细胞百分比|嗜酸粒细胞)$/i, 'eosinophils'],
  [/^(ige|总ige|血清总ige|免疫球蛋白e)$/i, 'total_ige'],
  [/^(af-?s?ige|烟曲霉特异性ige|曲霉sige|m3)$/i, 'aspergillus_sige'],
  [/^(cea|癌胚抗原)$/i, 'cea'],
  [/^(cyfra21-?1|细胞角蛋白19片段)$/i, 'cyfra21_1'],
  [/^(nse|神经元特异性烯醇化酶)$/i, 'nse'],
  [/^(scc|scc-?ag|鳞状细胞癌抗原)$/i, 'scc'],
  [/^(esr|血沉|红细胞沉降率)$/i, 'esr'],
  [/^(pct|降钙素原)$/i, 'pct'],
  [/^(afp|甲胎蛋白)$/i, 'afp'],
]
export function testKey(name: string): string {
  // 报告常写「中文名(缩写)」：整体、括号里的缩写、括号外的中文名依次试
  const whole = name.trim().replace(/\s+/g, '')
  const inner = /[（(]([^（）()]+)[）)]/.exec(whole)?.[1] ?? ''
  const outer = whole.replace(/[（(][^（）()]*[）)]/g, '')
  for (const n of [whole.replace(/[（）()]/g, ''), inner, outer]) {
    if (!n) continue
    for (const [re, key] of TEST_ALIASES) if (re.test(n)) return key
  }
  return (outer || whole).toLowerCase()
}

/** 一个机构的患者库（库文件 + 加密文件目录）。只由 PatientService 打开。 */
class TenantPatientDb {
  readonly db: DatabaseSync
  readonly files: string

  constructor(root: string, readonly tenantId: string) {
    const dir = join(root, tenantId.replace(/[^A-Za-z0-9_-]/g, '_'))
    this.files = join(dir, 'files')
    mkdirSync(this.files, { recursive: true })
    this.db = new DatabaseSync(join(dir, 'patients.db'))
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000; PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS seq (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS patients (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name_enc TEXT, sex TEXT, birth_year INTEGER, tags TEXT NOT NULL DEFAULT '[]', summary_enc TEXT,
        status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS care_team (
        patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, user_id TEXT NOT NULL, role TEXT NOT NULL,
        added_by TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (patient_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, name_enc TEXT NOT NULL, mime TEXT NOT NULL,
        size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, kind TEXT NOT NULL, title TEXT NOT NULL,
        report_date TEXT, report_time TEXT, file_id TEXT, status TEXT NOT NULL, text_enc TEXT, extraction TEXT, extraction_note TEXT,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS labs (
        id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, record_id TEXT, test_key TEXT NOT NULL, test_name TEXT NOT NULL,
        value_num REAL, value_text TEXT, unit TEXT, ref_low REAL, ref_high REAL, ref_text TEXT, flag TEXT, collected_on TEXT,
        status TEXT NOT NULL, source TEXT NOT NULL, locator TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_by TEXT, confirmed_at TEXT,
        collected_at TEXT, replaces TEXT
      );
      CREATE INDEX IF NOT EXISTS labs_patient ON labs (patient_id, test_key, collected_on);
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, kind TEXT NOT NULL, payload TEXT NOT NULL, reason TEXT NOT NULL,
        turn_id TEXT, status TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, resolved_by TEXT, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS patient_docs (
        patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, doc_id TEXT NOT NULL, kind TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (patient_id, doc_id)
      );
      CREATE TABLE IF NOT EXISTS access_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT NOT NULL, patient_id TEXT NOT NULL, action TEXT NOT NULL, via TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS access_log_patient ON access_log (patient_id, at);
      CREATE TABLE IF NOT EXISTS break_glass (
        id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      -- 研究入组（docs/design/COHORT.md）：患者 ↔ 研究的对应与研究编号放在机构的患者库里，不进平台库
      CREATE TABLE IF NOT EXISTS enrollments (
        study_id TEXT NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, subject_id TEXT NOT NULL,
        status TEXT NOT NULL, criteria TEXT, enrolled_by TEXT NOT NULL, enrolled_at TEXT NOT NULL, withdrawn_at TEXT,
        PRIMARY KEY (study_id, patient_id), UNIQUE (study_id, subject_id)
      );
      -- 研究变量（分组、随访、结局、影像变量等）：每个值记来源与核实状态；AI 写入一律为 unverified，只有研究者本人能核实
      CREATE TABLE IF NOT EXISTS subject_vars (
        study_id TEXT NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id) ON DELETE CASCADE, var_id TEXT NOT NULL,
        value_num REAL, value_text TEXT, source TEXT NOT NULL, source_ref TEXT NOT NULL DEFAULT '{}', method TEXT,
        status TEXT NOT NULL DEFAULT 'unverified', entered_by TEXT NOT NULL, entered_via TEXT NOT NULL, entered_at TEXT NOT NULL,
        verified_by TEXT, verified_at TEXT,
        PRIMARY KEY (study_id, patient_id, var_id)
      );
    `)
    // 旧库补列
    const cols = (t: string) => (this.db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name)
    const labCols = cols('labs')
    if (!cols('patients').includes('name_enc')) this.db.exec('ALTER TABLE patients ADD COLUMN name_enc TEXT')
    if (!labCols.includes('collected_at')) this.db.exec('ALTER TABLE labs ADD COLUMN collected_at TEXT')
    if (!labCols.includes('replaces')) this.db.exec('ALTER TABLE labs ADD COLUMN replaces TEXT')
    if (!cols('records').includes('report_time')) this.db.exec('ALTER TABLE records ADD COLUMN report_time TEXT')
    // 来源追溯（知家分享纳入本院时记 share:<分享 id>）
    if (!cols('records').includes('origin')) this.db.exec('ALTER TABLE records ADD COLUMN origin TEXT')
    if (!labCols.includes('origin')) this.db.exec('ALTER TABLE labs ADD COLUMN origin TEXT')
    // 迁移：AI 生成并直接存为「已确认」的影像报告（kind = report，存入时访问日志记 via = ai）改回待医生确认
    this.db.exec(`UPDATE records SET status = 'pending', origin = 'ai_report', confirmed_by = NULL, confirmed_at = NULL
      WHERE kind = 'report' AND status = 'confirmed' AND origin IS NULL
        AND id IN (SELECT detail FROM access_log WHERE action = 'record_confirm' AND via = 'ai')`)
  }

  /** 研究内的研究编号 S001、S002……（递增，移出的不复用） */
  nextSubject(studyId: string): string {
    const row = this.db.prepare("INSERT INTO seq (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value").get(`subject:${studyId}`) as { value: number }
    return `S${String(row.value).padStart(3, '0')}`
  }

  nextCode(): string {
    const row = this.db.prepare("INSERT INTO seq (name, value) VALUES ('patient', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value").get() as { value: number }
    return `P-${String(row.value).padStart(4, '0')}`
  }

  private savepointLevel = 0

  transaction<T>(fn: () => T): T {
    const sp = `sp_${this.savepointLevel + 1}`
    this.db.exec(`SAVEPOINT ${sp}`)
    this.savepointLevel++
    try {
      const res = fn()
      this.db.exec(`RELEASE SAVEPOINT ${sp}`)
      return res
    } catch (err) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`)
      this.db.exec(`RELEASE SAVEPOINT ${sp}`)
      throw err
    } finally {
      this.savepointLevel--
    }
  }

  close(): void { this.db.close() }
}

const patientOf = (r: Record<string, unknown>, name: string | null = null): PatientRow => ({
  id: r.id as string, code: r.code as string, name, sex: (r.sex as PatientRow['sex']) ?? null, birth_year: (r.birth_year as number | null) ?? null,
  tags: JSON.parse((r.tags as string) || '[]') as string[], status: r.status as PatientRow['status'],
  created_by: r.created_by as string, created_at: r.created_at as string, updated_at: r.updated_at as string,
})
const labOf = (r: Record<string, unknown>): LabRow => {
  const l = r as unknown as LabRow
  const std = standardize(l.test_key, l.value_num, l.unit)
  const range = standardizeRange(l.test_key, l.ref_low, l.ref_high, l.unit)
  return { ...l, locator: r.locator ? JSON.parse(r.locator as string) : null, collected_at: (r.collected_at as string | null) ?? null, replaces: (r.replaces as string | null) ?? null,
    std_value: std.value, std_unit: std.unit, std_ref_low: range.low, std_ref_high: range.high, converted: std.converted, unknown_unit: std.unknown_unit }
}
const proposalOf = (r: Record<string, unknown>): ProposalRow => ({ ...(r as unknown as ProposalRow), payload: JSON.parse(r.payload as string) })

/** 知家分享的范围：类目（化验 / 报告原件 / 简报与健康档案）与起始日期。 */
export interface ShareScope { categories: Array<'labs' | 'reports' | 'docs'>; since: string | null }

export interface Actor {
  userId: string
  /** ai = AI 经 MCP 代该用户访问（访问日志里区分） */
  via: 'user' | 'ai'
  turnId?: string | null
  /** 哪个空间的患者库：work = 工作台（医院或个人，默认）；personal = 知家（个人空间）。docs/design/TENANCY.md §双重身份 */
  space?: Space
}

export class PatientService {
  private dbs = new Map<string, TenantPatientDb>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly root: string,
    private readonly tenants: TenantService,
    private readonly keys: TenantKeys,
    private readonly store: Store,
    /** 报告自动提取（没有时上传的报告只能手工录入）。 */
    private readonly extractor: { pages: ReportPages; complete: Complete | null } | null = null,
    /** 成员建档即建「健康档案」文档（知家 V0，PATIENT.md §12）：人 / AI 建档同路径；没有时建档不产文档。 */
    private readonly archiveDoc?: (input: { owner: string; title: string; patientId: string }) => string | null,
  ) {}

  /** 机构服务（知家分享等需要按机构判断的服务共用这一个实例）。 */
  get tenantService(): TenantService { return this.tenants }

  /** 等后台提取完（测试用）。 */
  idle(): Promise<void> { return this.queue }

  // —— 机构与权限 ——

  /** 打开操作者所在机构的患者库。机构不开患者模块时拒绝。 */
  private ctx(a: Actor): { db: TenantPatientDb; tenantId: string; settings: TenantSettings; tenantAdmin: boolean; tenantKind: 'personal' | 'org' } {
    const t = this.tenants.of(a.userId, a.space ?? 'work')
    const settings = this.tenants.settings(t)
    if (!settings.patient_module) throw new PatientError('patient_module_off', '本机构没有启用患者模块', 403)
    if (a.via === 'ai' && !settings.external_model_for_patients) throw new PatientError('external_model_off', '本机构设置为患者数据不交给外部模型分析', 403)
    let db = this.dbs.get(t.id)
    if (!db) { db = new TenantPatientDb(this.root, t.id); this.dbs.set(t.id, db) }
    return { db, tenantId: t.id, settings, tenantAdmin: this.tenants.roleOf(a.userId, a.space ?? 'work') === 'admin', tenantKind: t.kind }
  }

  /** 手动录入化验只对个人租户（知家家庭空间）开放；医院端化验一律来自上传报告（追溯原件）。 */
  requirePersonal(a: Actor): void {
    const c = this.ctx(a)
    if (c.tenantKind !== 'personal') throw new PatientError('manual_labs_org', '手工录入化验只在知家（个人空间）开放；医院端请上传报告，在报告上补项', 403)
  }

  /** 写前断言：操作者能改这位成员（知家建文档 / 简报前调用，避免建了文档关联不上留下孤儿）。 */
  assertEditable(a: Actor, patientId: string): void { this.requireTeam(a, patientId) }

  /** AI 写入要不要先经医生确认（机构设置）。 */
  private aiReview(a: Actor, c: { settings: TenantSettings }): boolean {
    return a.via === 'ai' && c.settings.ai_patient_writes !== 'direct'
  }

  /** review 模式下 AI 不能做审核动作（确认 / 驳回）。 */
  private noAiReview(a: Actor, c: { settings: TenantSettings }, what: string): void {
    if (this.aiReview(a, c)) throw new PatientError('needs_human_review', `${what}需要医生在「待确认」里操作（本机构设置为 AI 的修改需医生确认）`, 403)
  }

  private teamRole(db: TenantPatientDb, patientId: string, userId: string): 'owner' | 'member' | null {
    return (db.db.prepare('SELECT role FROM care_team WHERE patient_id = ? AND user_id = ?').get(patientId, userId) as { role: 'owner' | 'member' } | undefined)?.role ?? null
  }

  private breakGlassActive(db: TenantPatientDb, patientId: string, userId: string): boolean {
    return Boolean(db.db.prepare('SELECT 1 FROM break_glass WHERE patient_id = ? AND user_id = ? AND expires_at > ?').get(patientId, userId, now()))
  }

  /** 能看到的患者；看不到的当不存在。 */
  private visible(a: Actor, patientId: string): { c: ReturnType<PatientService['ctx']>; p: PatientRow; role: 'owner' | 'member' | 'tenant' | 'break_glass' } {
    const c = this.ctx(a)
    const r = c.db.db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as Record<string, unknown> | undefined
    if (!r) throw new PatientError('not_found', '患者不存在', 404)
    const team = this.teamRole(c.db, patientId, a.userId)
    const role = team ?? (c.settings.patient_visibility === 'tenant' ? 'tenant' : this.breakGlassActive(c.db, patientId, a.userId) ? 'break_glass' : null)
    if (!role) throw new PatientError('not_found', '患者不存在', 404)
    return { c, p: patientOf(r, this.keys.decryptText(c.tenantId, (r.name_enc as string | null) ?? null)), role }
  }

  private log(c: { db: TenantPatientDb }, a: Actor, patientId: string, action: string, detail: string | null = null): void {
    c.db.db.prepare('INSERT INTO access_log (at, user_id, patient_id, action, via, detail) VALUES (?, ?, ?, ?, ?, ?)').run(now(), a.userId, patientId, action, a.via, detail)
  }

  // —— 患者 ——

  create(a: Actor, input: { sex?: unknown; birth_year?: unknown; tags?: unknown; name?: unknown }): PatientRow {
    const c = this.ctx(a)
    const nm = name(input.name)
    // 称呼只在知家（个人空间）可用：医院端患者只用代号，避免真名落库后发给外部模型
    if (nm && c.tenantKind !== 'personal') throw new PatientError('name_org', '医院端患者只用代号；称呼只在知家（个人空间）可用', 400)
    const id = rid('pt')
    const t = now()
    c.db.db.prepare('INSERT INTO patients (id, code, name_enc, sex, birth_year, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.db.nextCode(), this.keys.encryptText(c.tenantId, nm), sex(input.sex), birthYear(input.birth_year), JSON.stringify(tags(input.tags)), a.userId, t, t)
    c.db.db.prepare('INSERT INTO care_team (patient_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(id, a.userId, 'owner', a.userId, t)
    const p = this.visible(a, id).p
    // 成员的「健康档案」文档：只在知家（个人空间）建档时创建；医院端不生成（临床表述不受患者红线约束）
    if (c.tenantKind === 'personal') {
      const docId = this.archiveDoc?.({ owner: a.userId, patientId: id, title: `${p.code} 健康档案` })  // 标题只用代号：标题会出现在 AI 读到的内容里，称呼不发给外部模型
      if (docId) this.linkDoc(a, id, docId, 'archive')
    }
    this.log(c, a, id, 'create')
    return p
  }

  list(a: Actor): Array<PatientRow & { role: string; labs: number; lab_reports: number; last_lab: string | null; pending: number }> {
    const c = this.ctx(a)
    const rows = (c.settings.patient_visibility === 'tenant'
      ? c.db.db.prepare('SELECT * FROM patients ORDER BY updated_at DESC').all()
      : c.db.db.prepare(`SELECT p.* FROM patients p WHERE p.id IN (SELECT patient_id FROM care_team WHERE user_id = ?)
          OR p.id IN (SELECT patient_id FROM break_glass WHERE user_id = ? AND expires_at > ?) ORDER BY p.updated_at DESC`).all(a.userId, a.userId, now())) as Array<Record<string, unknown>>
    return rows.map(r => {
      const p = patientOf(r, this.keys.decryptText(c.tenantId, (r.name_enc as string | null) ?? null))
      // n = 已确认的化验项数；reports = 化验单份数（同一份报告算一次；手工录入按日期算一次）
      const stats = c.db.db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT COALESCE(record_id, 'manual:' || collected_on)) AS reports, MAX(collected_on) AS last FROM labs WHERE patient_id = ? AND status = 'confirmed'").get(p.id) as { n: number; reports: number; last: string | null }
      const pending = (c.db.db.prepare("SELECT (SELECT COUNT(*) FROM labs WHERE patient_id = ? AND status = 'pending') + (SELECT COUNT(*) FROM proposals WHERE patient_id = ? AND status = 'pending') AS n").get(p.id, p.id) as { n: number }).n
      return { ...p, role: this.teamRole(c.db, p.id, a.userId) ?? (c.settings.patient_visibility === 'tenant' ? 'tenant' : 'break_glass'), labs: stats.n, lab_reports: stats.reports, last_lab: stats.last, pending }
    })
  }

  /** 概况：基本信息、诊疗组、报告、各项化验的最近值。记一次查看。 */
  read(a: Actor, patientId: string) {
    const { c, p, role } = this.visible(a, patientId)
    const summary = c.db.db.prepare('SELECT summary_enc FROM patients WHERE id = ?').get(patientId) as { summary_enc: string | null }
    const team = (c.db.db.prepare('SELECT user_id, role, added_at FROM care_team WHERE patient_id = ? ORDER BY added_at').all(patientId) as Array<{ user_id: string; role: string; added_at: string }>)
      .map(m => ({ ...m, name: this.store.getUser(m.user_id)?.display_name ?? m.user_id }))
    const records = (c.db.db.prepare('SELECT * FROM records WHERE patient_id = ? ORDER BY COALESCE(report_date, created_at) DESC').all(patientId) as unknown as Array<RecordRow & { text_enc?: string | null }>)
      .map(r => {
        let imaging_data: Record<string, unknown> | null = null
        if (r.kind === 'imaging' && r.text_enc) {
          try {
            const dec = this.keys.decryptText(c.tenantId, r.text_enc)
            if (dec) imaging_data = JSON.parse(dec)
          } catch {}
        }
        return { ...r, text_enc: undefined, imaging_data }
      })
    // 每项最近一次（同一天多次时取采样时间最晚、再取录入最晚的）
    const all = (c.db.db.prepare("SELECT * FROM labs WHERE patient_id = ? AND status = 'confirmed' ORDER BY test_key, collected_on, COALESCE(collected_at, collected_on), created_at").all(patientId) as Array<Record<string, unknown>>).map(labOf)
    const latest = [...new Map(all.map(l => [l.test_key, l])).values()]
    this.log(c, a, patientId, 'view')
    return { ...p, access: role, documents: this.documents(c, patientId, a.userId), studies: this.studiesOf(c, patientId), summary: this.keys.decryptText(c.tenantId, summary.summary_enc), care_team: team, records, latest_labs: latest, pending_proposals: this.proposals(a, patientId, c) }
  }

  update(a: Actor, patientId: string, patch: { sex?: unknown; birth_year?: unknown; tags?: unknown; summary?: unknown; status?: unknown; name?: unknown }): PatientRow {
    const { c } = this.requireTeam(a, patientId)
    // 称呼只在知家（个人空间）可改：医院端保持只用代号
    if (patch.name !== undefined && c.tenantKind !== 'personal' && name(patch.name) !== null) throw new PatientError('name_org', '医院端患者只用代号；称呼只在知家（个人空间）可用', 400)
    if (this.aiReview(a, c)) {
      // 需医生确认：作为一条「修改」提议
      const clean: Record<string, unknown> = {}
      for (const k of ['sex', 'birth_year', 'tags', 'summary', 'status', 'name'] as const) if (patch[k] !== undefined) clean[k] = patch[k]
      if (patch.birth_year !== undefined) birthYear(patch.birth_year)
      this.propose(a, patientId, { kind: 'update', payload: clean, reason: typeof (patch as { reason?: unknown }).reason === 'string' ? (patch as { reason: string }).reason : 'AI 修改患者信息' })
      return this.visible(a, patientId).p
    }
    const sets: string[] = []
    const args: Array<string | number | null> = []
    if (patch.sex !== undefined) { sets.push('sex = ?'); args.push(sex(patch.sex)) }
    if (patch.birth_year !== undefined) { sets.push('birth_year = ?'); args.push(birthYear(patch.birth_year)) }
    if (patch.tags !== undefined) { sets.push('tags = ?'); args.push(JSON.stringify(tags(patch.tags))) }
    if (patch.name !== undefined) { sets.push('name_enc = ?'); args.push(this.keys.encryptText(c.tenantId, name(patch.name))) }
    if (typeof patch.summary === 'string') { sets.push('summary_enc = ?'); args.push(this.keys.encryptText(c.tenantId, patch.summary.slice(0, 5000))) }
    if (patch.status === 'active' || patch.status === 'archived') { sets.push('status = ?'); args.push(patch.status) }
    if (sets.length) c.db.db.prepare(`UPDATE patients SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now(), patientId)
    this.log(c, a, patientId, 'update', Object.keys(patch).join(','))
    return this.visible(a, patientId).p
  }

  /** 删除患者（只有负责人）：库里的记录与加密文件一起删。 */
  remove(a: Actor, patientId: string): void {
    if (a.via === 'ai') throw new PatientError('forbidden', '删除患者不可恢复，只能由负责人在界面上操作', 403)
    const { c } = this.requireTeam(a, patientId, 'owner')
    for (const f of c.db.db.prepare('SELECT id FROM files WHERE patient_id = ?').all(patientId) as Array<{ id: string }>) rmSync(join(c.db.files, f.id), { force: true })
    c.db.db.prepare('DELETE FROM patients WHERE id = ?').run(patientId)
    this.log(c, a, patientId, 'delete')
  }

  /** 诊疗组成员才能改（机构全员可见 / 紧急访问只能看）。 */
  private requireTeam(a: Actor, patientId: string, need: 'owner' | 'member' = 'member') {
    const v = this.visible(a, patientId)
    if (v.role !== 'owner' && (need === 'owner' || v.role !== 'member')) throw new PatientError('forbidden', need === 'owner' ? '只有负责人能做这件事' : '只有诊疗组成员能修改', 403)
    return v
  }

  // —— 诊疗组与紧急访问 ——

  addMember(a: Actor, patientId: string, userId: string): void {
    const { c } = this.requireTeam(a, patientId, 'owner')
    const u = this.store.getUser(userId)
    if (!u || u.tenant_id !== c.tenantId || u.status !== 'active') throw new PatientError('not_found', '本机构没有这位成员', 404)
    c.db.db.prepare('INSERT OR IGNORE INTO care_team (patient_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)').run(patientId, userId, 'member', a.userId, now())
    this.log(c, a, patientId, 'team_add', userId)
  }

  removeMember(a: Actor, patientId: string, userId: string): void {
    const { c } = this.requireTeam(a, patientId, 'owner')
    if (userId === a.userId) throw new PatientError('self', '负责人不能把自己移出诊疗组', 409)
    c.db.db.prepare("DELETE FROM care_team WHERE patient_id = ? AND user_id = ? AND role = 'member'").run(patientId, userId)
    this.log(c, a, patientId, 'team_remove', userId)
  }

  /** 紧急访问：机构管理员填写理由后获得 24 小时只读访问，记访问日志与审计。 */
  breakGlass(a: Actor, patientId: string, reason: unknown): { expires_at: string } {
    if (a.via === 'ai') throw new PatientError('forbidden', 'AI 不能申请紧急访问', 403)
    const c = this.ctx(a)
    if (!c.tenantAdmin) throw new PatientError('forbidden', '只有机构管理员能紧急访问', 403)
    const why = typeof reason === 'string' ? reason.trim() : ''
    if (why.length < 10) throw new PatientError('reason_required', '请写明紧急访问的理由（至少 10 个字）')
    if (!c.db.db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) throw new PatientError('not_found', '患者不存在', 404)
    const expires = new Date(Date.now() + BREAK_GLASS_HOURS * 3600_000).toISOString()
    c.db.db.prepare('INSERT INTO break_glass (id, patient_id, user_id, reason, at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(rid('bg'), patientId, a.userId, why.slice(0, 500), now(), expires)
    this.log(c, a, patientId, 'break_glass', why.slice(0, 500))
    this.store.addAudit({ actor: a.userId, action: 'patient.break_glass', target: `患者 ${patientId}`, detail: why.slice(0, 200), tenant_id: c.tenantId })
    return { expires_at: expires }
  }

  /** 机构管理员紧急访问前要知道患者存在：只给代号（不给内容）。 */
  directory(a: Actor): Array<{ id: string; code: string }> {
    const c = this.ctx(a)
    if (!c.tenantAdmin) throw new PatientError('forbidden', '只有机构管理员能看患者目录', 403)
    return c.db.db.prepare('SELECT id, code FROM patients ORDER BY code').all() as Array<{ id: string; code: string }>
  }

  accessLog(a: Actor, patientId: string): Array<{ at: string; user: string; action: string; via: string; detail: string | null }> {
    const { c } = this.requireTeam(a, patientId, 'owner')
    return (c.db.db.prepare('SELECT * FROM access_log WHERE patient_id = ? ORDER BY id DESC LIMIT 500').all(patientId) as Array<{ at: string; user_id: string; action: string; via: string; detail: string | null }>)
      .map(r => ({ at: r.at, user: this.store.getUser(r.user_id)?.display_name ?? r.user_id, action: r.action, via: r.via, detail: r.detail }))
  }

  // —— 化验 ——

  /** 人录入 / 确认的化验值直接生效；AI 走 propose。 */
  addLab(a: Actor, patientId: string, input: Record<string, unknown>, opts: { status?: LabRow['status']; source?: LabRow['source']; recordId?: string | null } = {}): LabRow {
    if (a.via === 'ai') throw new PatientError('forbidden', '化验要来自上传的报告：用 report_upload 上传，或在报告上 report_lab_add 补项', 403)
    const { c } = this.requireTeam(a, patientId)
    const lab = labInput(input)
    const id = rid('lb')
    const status = opts.status ?? 'confirmed'
    c.db.db.prepare(`INSERT INTO labs (id, patient_id, record_id, test_key, test_name, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, collected_on, status, source, locator, created_by, created_at, confirmed_by, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, patientId, opts.recordId ?? null, testKey(lab.test_name), lab.test_name, lab.value_num, lab.value_text, lab.unit,
      lab.ref_low, lab.ref_high, lab.ref_text, flagOf(lab), lab.collected_on, status, opts.source ?? 'manual', lab.locator ? JSON.stringify(lab.locator) : null, a.userId, now(),
      status === 'confirmed' ? a.userId : null, status === 'confirmed' ? now() : null)
    c.db.db.prepare('UPDATE patients SET updated_at = ? WHERE id = ?').run(now(), patientId)
    this.log(c, a, patientId, 'lab_add', lab.test_name)
    return labOf(c.db.db.prepare('SELECT * FROM labs WHERE id = ?').get(id) as Record<string, unknown>)
  }

  setLabStatus(a: Actor, patientId: string, labId: string, status: 'confirmed' | 'rejected'): void {
    const { c } = this.requireTeam(a, patientId)
    this.noAiReview(a, c, status === 'confirmed' ? '确认化验' : '删除待确认的化验')
    if (status === 'confirmed' && (c.db.db.prepare('SELECT collected_on FROM labs WHERE id = ?').get(labId) as { collected_on: string | null } | undefined)?.collected_on === null) {
      throw new PatientError('date_required', '这条化验没有日期，请先填写报告日期')
    }
    const r = c.db.db.prepare("UPDATE labs SET status = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ? AND patient_id = ? AND status = 'pending'").run(status, a.userId, now(), labId, patientId)
    if (Number(r.changes) === 0) throw new PatientError('not_found', '没有待确认的这条化验', 404)
    this.log(c, a, patientId, status === 'confirmed' ? 'lab_confirm' : 'lab_reject', labId)
  }

  /** 同日同项的已确认化验（审核时提示冲突、确认时去重）。 */
  private sameDay(db: TenantPatientDb, patientId: string, l: { id: string; test_key: string; collected_on: string | null }): LabRow[] {
    if (!l.collected_on) return []
    return (db.db.prepare("SELECT * FROM labs WHERE patient_id = ? AND test_key = ? AND collected_on = ? AND status = 'confirmed' AND id != ?").all(patientId, l.test_key, l.collected_on, l.id) as Array<Record<string, unknown>>).map(labOf)
  }

  /** 化验长表（只含已确认的；includePending 给审核界面用）。 */
  labs(a: Actor, patientId: string, f: { tests?: string[]; from?: string; to?: string; includePending?: boolean } = {}): Array<LabRow & { same_day?: LabRow[] }> {
    const { c } = this.visible(a, patientId)
    const where = ['patient_id = ?', f.includePending ? "status IN ('confirmed', 'pending')" : "status = 'confirmed'"]
    const args: string[] = [patientId]
    if (f.from && DATE.test(f.from)) { where.push('collected_on >= ?'); args.push(f.from) }
    if (f.to && DATE.test(f.to)) { where.push('collected_on <= ?'); args.push(f.to) }
    let rows: Array<LabRow & { same_day?: LabRow[] }> = (c.db.db.prepare(`SELECT * FROM labs WHERE ${where.join(' AND ')} ORDER BY test_key, collected_on, COALESCE(collected_at, collected_on), created_at`).all(...args) as Array<Record<string, unknown>>).map(labOf)
    if (f.tests?.length) { const keys = new Set(f.tests.map(testKey)); rows = rows.filter(r => keys.has(r.test_key)) }
    // 待确认的项：带上同日同项已确认的值（审核时决定替换还是都保留）
    if (f.includePending) rows = rows.map(r => r.status === 'pending' ? { ...r, same_day: this.sameDay(c.db, patientId, r) } : r)
    this.log(c, a, patientId, 'labs_read', f.tests?.join(',') ?? null)
    return rows
  }

  // —— 知家分享（docs/design/SHARING.md）：医生按分享只读家人个人空间里的数据；权限由 ShareService 判定 ——

  /** 用某个机构（个人空间）的数据密钥加密 / 解密一段短文字（分享里「给医生看的姓名」）。 */
  sealText(tenantId: string, text: string | null): string | null { return this.keys.encryptText(tenantId, text) }
  openText(tenantId: string, enc: string | null): string | null { return this.keys.decryptText(tenantId, enc) }

  private dbFor(tenantId: string): TenantPatientDb {
    let db = this.dbs.get(tenantId)
    if (!db) { db = new TenantPatientDb(this.root, tenantId); this.dbs.set(tenantId, db) }
    return db
  }

  /** 分享视图（只读、按范围过滤，只含已确认的内容）。不给称呼：医生看到的姓名由家人在分享里另填。 */
  sharedView(tenantId: string, patientId: string, scope: ShareScope) {
    const db = this.dbFor(tenantId)
    const r = db.db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as Record<string, unknown> | undefined
    if (!r) throw new PatientError('not_found', '分享的档案已不存在', 404)
    const p = patientOf(r)
    const has = (k: ShareScope['categories'][number]) => scope.categories.includes(k)
    const since = scope.since && DATE.test(scope.since) ? scope.since : null
    const labs = has('labs')
      ? (db.db.prepare(`SELECT * FROM labs WHERE patient_id = ? AND status = 'confirmed'${since ? ' AND collected_on >= ?' : ''} ORDER BY test_key, collected_on, COALESCE(collected_at, collected_on), created_at`)
          .all(...(since ? [patientId, since] : [patientId])) as Array<Record<string, unknown>>).map(labOf)
      : []
    const records = has('reports')
      ? (db.db.prepare(`SELECT id, kind, title, report_date, file_id FROM records WHERE patient_id = ? AND status = 'confirmed'${since ? ' AND COALESCE(report_date, created_at) >= ?' : ''} ORDER BY COALESCE(report_date, created_at) DESC`)
          .all(...(since ? [patientId, since] : [patientId])) as Array<{ id: string; kind: string; title: string; report_date: string | null; file_id: string | null }>)
      : []
    const documents = has('docs')
      ? (db.db.prepare('SELECT doc_id, kind, created_at FROM patient_docs WHERE patient_id = ? ORDER BY created_at DESC').all(patientId) as Array<{ doc_id: string; kind: string; created_at: string }>)
          .flatMap(d => { const row = this.store.getDoc(d.doc_id); return row && !row.deleted_at ? [{ doc_id: d.doc_id, kind: d.kind, title: row.title, updated_at: row.updated_at }] : [] })
      : []
    return { code: p.code, sex: p.sex, birth_year: p.birth_year, tags: p.tags, labs, records, documents }
  }

  /** 分享里的一份报告原件（必须在分享范围内）。 */
  sharedFile(tenantId: string, patientId: string, scope: ShareScope, fileId: string): { name: string; mime: string; bytes: Buffer } {
    const db = this.dbFor(tenantId)
    if (!this.sharedView(tenantId, patientId, scope).records.some(r => r.file_id === fileId)) throw new PatientError('not_found', '文件不存在', 404)
    const f = db.db.prepare('SELECT * FROM files WHERE id = ? AND patient_id = ?').get(fileId, patientId) as { id: string; name_enc: string; mime: string } | undefined
    if (!f || !existsSync(join(db.files, f.id))) throw new PatientError('not_found', '文件不存在', 404)
    return { name: this.keys.decryptText(tenantId, f.name_enc)!, mime: f.mime, bytes: this.keys.decrypt(tenantId, readFileSync(join(db.files, f.id))) }
  }

  /** 分享里一份报告的文字（已打码，给医生的 AI 读）。 */
  sharedRecordText(tenantId: string, patientId: string, scope: ShareScope, recordId: string): { title: string; kind: string; report_date: string | null; text: string | null } {
    const rec = this.sharedView(tenantId, patientId, scope).records.find(r => r.id === recordId)
    if (!rec) throw new PatientError('not_found', '报告不存在', 404)
    const r = this.dbFor(tenantId).db.prepare('SELECT text_enc FROM records WHERE id = ?').get(recordId) as { text_enc: string | null }
    const text = this.keys.decryptText(tenantId, r.text_enc)
    return { title: rec.title, kind: rec.kind, report_date: rec.report_date, text: text === null ? null : redact(text).slice(0, 20000) }
  }

  /** 在家人那边记一笔：医生（或医生的 AI）经分享看了什么。家人在成员页看得到。 */
  sharedLog(tenantId: string, patientId: string, userId: string, via: Actor['via'], action: string, detail: string): void {
    this.dbFor(tenantId).db.prepare('INSERT INTO access_log (at, user_id, patient_id, action, via, detail) VALUES (?, ?, ?, ?, ?, ?)').run(now(), userId, patientId, action, via, detail)
  }

  /**
   * 纳入本院：把分享的成员复制成本院患者（新代号，操作者为负责人）。报告原件重新用本院密钥加密；
   * 化验按原记录复制：挂在报告上的标来源 share，家人手工录入的仍标 manual（没有原件，不进研究数据集）；文档由调用方复制后关联。
   * 来源追溯：records / labs 的 origin = share:<分享 id>。AI 纳入受本院「AI 写入患者数据」审核门约束（review 时只能由医生点）。
   */
  importShared(a: Actor, src: { tenantId: string; patientId: string; shareId: string; scope: ShareScope }, copyDoc: (docId: string, kind: string) => string | null): PatientRow {
    const c = this.ctx(a)
    this.noAiReview(a, c, '纳入本院')
    if (c.tenantKind === 'personal') throw new PatientError('personal', '纳入本院只在医院端', 400)
    const view = this.sharedView(src.tenantId, src.patientId, src.scope)
    return c.db.transaction(() => {
      const p = this.create(a, { sex: view.sex, birth_year: view.birth_year, tags: view.tags })
      const origin = `share:${src.shareId}`
      const srcDb = this.dbFor(src.tenantId)
      const recordMap = new Map<string, string>()
      for (const r of view.records) {
        let fid: string | null = null
        if (r.file_id) {
          const f = srcDb.db.prepare('SELECT * FROM files WHERE id = ?').get(r.file_id) as { id: string; name_enc: string; mime: string; size: number; sha256: string } | undefined
          if (f && existsSync(join(srcDb.files, f.id))) {
            fid = rid('pf')
            const bytes = this.keys.decrypt(src.tenantId, readFileSync(join(srcDb.files, f.id)))
            writeFileSync(join(c.db.files, fid), this.keys.encrypt(c.tenantId, bytes))
            c.db.db.prepare('INSERT INTO files (id, patient_id, name_enc, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(fid, p.id, this.keys.encryptText(c.tenantId, this.keys.decryptText(src.tenantId, f.name_enc) ?? 'report')!, f.mime, f.size, f.sha256, a.userId, now())
          }
        }
        const srcRec = srcDb.db.prepare('SELECT text_enc, report_time FROM records WHERE id = ?').get(r.id) as { text_enc: string | null; report_time: string | null }
        const text = this.keys.decryptText(src.tenantId, srcRec.text_enc)
        const id = rid('rc')
        c.db.db.prepare(`INSERT INTO records (id, patient_id, kind, title, report_date, report_time, file_id, status, text_enc, extraction, extraction_note, created_by, created_at, confirmed_by, confirmed_at, origin)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 'skipped', ?, ?, ?, ?, ?, ?)`)
          .run(id, p.id, r.kind, r.title, r.report_date, srcRec.report_time, fid, this.keys.encryptText(c.tenantId, text), '来自知家家庭分享（家人已确认）', a.userId, now(), a.userId, now(), origin)
        recordMap.set(r.id, id)
      }
      const ins = c.db.db.prepare(`INSERT INTO labs (id, patient_id, record_id, test_key, test_name, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, collected_on, collected_at, status, source, locator, created_by, created_at, confirmed_by, confirmed_at, origin)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)`)
      for (const l of view.labs) {
        const rec = l.record_id ? recordMap.get(l.record_id) ?? null : null
        ins.run(rid('lb'), p.id, rec, l.test_key, l.test_name, l.value_num, l.value_text, l.unit, l.ref_low, l.ref_high, l.ref_text, l.flag, l.collected_on, l.collected_at,
          // 有报告原件的 → share；家人手工录入（没有原件）的仍标 manual
          rec || l.source !== 'manual' ? 'share' : 'manual', l.locator ? JSON.stringify(l.locator) : null, a.userId, now(), a.userId, now(), origin)
      }
      for (const d of view.documents) {
        const id = copyDoc(d.doc_id, d.kind)
        if (id) this.linkDoc({ ...a, via: 'user' }, p.id, id, 'other')
      }
      this.log(c, a, p.id, 'import_share', src.shareId)
      return p
    })
  }

  /** 守卫用的成员标记（特殊人群判定）：内部读取，不记访问日志、不做诊疗组校验——调用方是写前守卫。 */
  memberMarkers(ownerUserId: string, patientId: string, space: Space = 'personal'): PhrMemberLike | null {
    try {
      const c = this.ctx({ userId: ownerUserId, via: 'user', space })
      const r = c.db.db.prepare('SELECT birth_year, tags FROM patients WHERE id = ?').get(patientId) as Record<string, unknown> | undefined
      if (!r) return null
      return { tags: JSON.parse((r.tags as string) || '[]') as string[], birth_year: (r.birth_year as number | null) ?? null }
    } catch { /* 患者模块未开等：守卫按无标记处理 */ }
    return null
  }

  /** 化验长表导出成 CSV（AI 放进工作区分析用；不含任何身份信息）。 */
  labsCsv(a: Actor, patientId: string): { code: string; csv: string; rows: number } {
    const { p } = this.visible(a, patientId)
    const rows = this.labs(a, patientId)
    const q = (v: unknown) => v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)
    // value / unit 是换算到标准单位后的（便于画趋势、做统计）；orig_value / orig_unit 是报告上的原样
    const head = 'patient,test_key,test_name,value,unit,ref_low,ref_high,flag,collected_on,collected_at,orig_value,orig_unit,value_text'
    const body = rows.map(r => [p.code, r.test_key, r.test_name, r.std_value, r.std_unit, r.std_ref_low, r.std_ref_high, r.flag, r.collected_on, r.collected_at, r.value_num, r.unit, r.value_text].map(q).join(','))
    return { code: p.code, csv: [head, ...body].join('\n') + '\n', rows: rows.length }
  }

  // —— 文件与报告 ——

  /** 上传原始报告：内容与文件名用机构密钥加密存盘，生成一条待确认的报告记录。 */
  addFile(a: Actor, patientId: string, input: { name: string; mime: string; bytes: Uint8Array; kind?: RecordRow['kind']; report_date?: string | null; title?: string }): { file_id: string; record: RecordRow } {
    const { c } = this.requireTeam(a, patientId)
    const isImaging = input.kind === 'imaging' || /\.(nii|nii\.gz|dcm|dicom|mha|nrrd|zip)$/i.test(input.name)
    const maxBytes = isImaging ? 250 * 1024 * 1024 : 30 * 1024 * 1024
    if (input.bytes.byteLength > maxBytes) throw new PatientError('too_large', `文件超过 ${isImaging ? '250' : '30'} MB`)
    // 同一份报告重复上传：拦下并说明是哪次传过的（不再重复提取）
    const sha = createHash('sha256').update(input.bytes).digest('hex')
    const dup = c.db.db.prepare(`SELECT r.title, r.report_date, f.created_at FROM files f LEFT JOIN records r ON r.file_id = f.id WHERE f.patient_id = ? AND f.sha256 = ? AND COALESCE(r.status, '') != 'rejected'`).get(patientId, sha) as { title: string | null; report_date: string | null; created_at: string } | undefined
    if (dup) throw new PatientError('duplicate', `这份报告已经上传过（${dup.created_at.slice(0, 10)} 上传${dup.title ? `，「${dup.title}」` : ''}${dup.report_date ? `，报告日期 ${dup.report_date}` : ''}）`, 409)
    const fid = rid('pf')
    writeFileSync(join(c.db.files, fid), this.keys.encrypt(c.tenantId, Buffer.from(input.bytes)))
    c.db.db.prepare('INSERT INTO files (id, patient_id, name_enc, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fid, patientId, this.keys.encryptText(c.tenantId, input.name)!, input.mime, input.bytes.byteLength, sha, a.userId, now())
    const recId = rid('rc')
    const kind = input.kind && ['lab_report', 'discharge', 'pathology', 'imaging', 'note', 'other'].includes(input.kind) ? input.kind : isImaging ? 'imaging' : 'other'
    // 自动提取：机构允许交给外部模型、配置了模型时排队；否则跳过，由医生手工录入
    const canExtract = Boolean(this.extractor?.complete) && c.settings.external_model_for_patients
    c.db.db.prepare('INSERT INTO records (id, patient_id, kind, title, report_date, file_id, status, extraction, extraction_note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(recId, patientId, kind, (input.title ?? '').trim().slice(0, 120) || (isImaging ? '医学影像扫描序列' : '未命名报告'), input.report_date && DATE.test(input.report_date) ? input.report_date : null, fid, 'pending',
        canExtract ? 'queued' : 'skipped', canExtract ? null : this.extractor?.complete ? '本机构设置为患者数据不交给外部模型，不能自动提取：请在审核里对照原件逐项添加' : '没有配置模型，不能自动提取：请在审核里对照原件逐项添加', a.userId, now())
    this.log(c, a, patientId, 'file_upload', fid)
    if (canExtract) {
      const tenantId = c.tenantId
      this.queue = this.queue.then(() => this.runExtraction(tenantId, patientId, recId, a.userId)).catch(err => console.error('[patient-extract]', err))
    }
    return { file_id: fid, record: c.db.db.prepare('SELECT * FROM records WHERE id = ?').get(recId) as unknown as RecordRow }
  }

  file(a: Actor, patientId: string, fileId: string): { name: string; mime: string; bytes: Buffer } {
    const { c } = this.visible(a, patientId)
    const f = c.db.db.prepare('SELECT * FROM files WHERE id = ? AND patient_id = ?').get(fileId, patientId) as { id: string; name_enc: string; mime: string } | undefined
    if (!f || !existsSync(join(c.db.files, f.id))) throw new PatientError('not_found', '文件不存在', 404)
    this.log(c, a, patientId, 'file_download', fileId)
    return { name: this.keys.decryptText(c.tenantId, f.name_enc)!, mime: f.mime, bytes: this.keys.decrypt(c.tenantId, readFileSync(join(c.db.files, f.id))) }
  }

  /**
   * 记录医学影像量化分析结果：
   * 将 MONAI 深度学习推理产生的最大截面图（关键切片 PNG，带卡尺与标尺）加密保存到租户文件，
   * 同时存入 Store 资产（供 OmniCanvas 与文档无缝引用），将量化指标以加密 JSON 存入 records 表，
   * 并支持把影像所见（如「高密度粘液栓」「BAR 增大」）作为标签合并到患者。
   */
  addImagingRecord(a: Actor, patientId: string, input: {
    title: string
    report_date: string | null
    model_id: string
    sample_id?: string | null
    modality?: string
    metrics: Record<string, unknown>
    findings?: string[]
    key_slice_png: Uint8Array
    raw_volume_file?: { name: string; bytes: Uint8Array; mime?: string }
    add_tags?: string[]
  }): { record: RecordRow & { imaging_data?: Record<string, unknown> }; asset_id: string; file_id: string; raw_file_id?: string } {
    const { c } = this.requireTeam(a, patientId)
    const fid = rid('pf')
    const pngBuffer = Buffer.from(input.key_slice_png)
    const sha = createHash('sha256').update(pngBuffer).digest('hex')

    // 1. 加密存入机构独立患者文件目录 (关键截面原图)
    writeFileSync(join(c.db.files, fid), this.keys.encrypt(c.tenantId, pngBuffer))

    let rawFid: string | undefined
    let rawBuf: Buffer | undefined
    let rawSha: string | undefined
    if (input.raw_volume_file && input.raw_volume_file.bytes.byteLength > 0) {
      rawFid = rid('pf')
      rawBuf = Buffer.from(input.raw_volume_file.bytes)
      rawSha = createHash('sha256').update(rawBuf).digest('hex')
      writeFileSync(join(c.db.files, rawFid), this.keys.encrypt(c.tenantId, rawBuf))
    }

    // 2. 存入文档资产库（具有全局 asset_id，支持在 Markdown 或 OmniCanvas 中直接使用）
    const asset = this.store.putAsset({
      owner: a.userId,
      mime: 'image/png',
      name: `${input.title || 'imaging'}-slice.png`,
      bytes: pngBuffer,
    })

    // 3. 构建结构化量化数据载荷
    const imagingPayload = {
      model_id: input.model_id,
      sample_id: input.sample_id ?? null,
      modality: input.modality ?? 'Chest HRCT',
      asset_id: asset.id,
      file_id: fid,
      raw_file_id: rawFid ?? null,
      raw_file_name: input.raw_volume_file?.name ?? null,
      raw_file_size: input.raw_volume_file?.bytes?.byteLength ?? null,
      metrics: input.metrics,
      findings: input.findings ?? [],
      analyzed_at: now(),
    }

    const recId = rid('rc')
    const encText = this.keys.encryptText(c.tenantId, JSON.stringify(imagingPayload))

    // 格式化提取备注 / 快速摘要
    let summaryNote = ''
    if (input.findings && input.findings.length > 0) {
      summaryNote = input.findings.slice(0, 3).join(' · ')
    } else if (input.metrics) {
      const parts: string[] = []
      if (input.metrics.bar_ratio !== undefined) parts.push(`BAR: ${input.metrics.bar_ratio}`)
      if (input.metrics.mucus_volume_mm3 !== undefined) parts.push(`粘液栓: ${input.metrics.mucus_volume_mm3} mm³`)
      if (input.metrics.longest_diameter_mm !== undefined) parts.push(`RECIST: ${input.metrics.longest_diameter_mm} mm`)
      summaryNote = parts.join(' · ')
    }

    // 当有原始扫描文件时，records.file_id 指向 rawFid，使「原件」按钮直接下载原始体素文件；否则指向切片图
    const primaryFileId = rawFid ?? fid
    const createdRec = c.db.transaction(() => {
      c.db.db.prepare('INSERT INTO files (id, patient_id, name_enc, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(fid, patientId, this.keys.encryptText(c.tenantId, `${input.title || '影像分析'}-key-slice.png`)!, 'image/png', pngBuffer.byteLength, sha, a.userId, now())

      if (rawFid && rawBuf && rawSha && input.raw_volume_file) {
        c.db.db.prepare('INSERT INTO files (id, patient_id, name_enc, mime, size, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(rawFid, patientId, this.keys.encryptText(c.tenantId, input.raw_volume_file.name || 'raw-scan.nii.gz')!, input.raw_volume_file.mime || 'application/gzip', rawBuf.byteLength, rawSha, a.userId, now())
      }

      c.db.db.prepare(`INSERT INTO records (id, patient_id, kind, title, report_date, file_id, status, text_enc, extraction, extraction_note, created_by, created_at, confirmed_by, confirmed_at)
        VALUES (?, ?, 'imaging', ?, ?, ?, 'confirmed', ?, 'done', ?, ?, ?, ?, ?)`)
        .run(recId, patientId, (input.title || '医学影像量化分析').trim().slice(0, 120), input.report_date && DATE.test(input.report_date) ? input.report_date : null, primaryFileId,
          encText, summaryNote.slice(0, 200), a.userId, now(), a.userId, now())

      // 4. 若有阳性征象需要新增标签，合并到 patients.tags
      if (input.add_tags && input.add_tags.length > 0) {
        const pRow = c.db.db.prepare('SELECT tags FROM patients WHERE id = ?').get(patientId) as { tags: string } | undefined
        if (pRow) {
          const curTags = JSON.parse(pRow.tags || '[]') as string[]
          const mergedTags = Array.from(new Set([...curTags, ...input.add_tags.map(t => t.trim()).filter(Boolean)]))
          c.db.db.prepare('UPDATE patients SET tags = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(mergedTags), now(), patientId)
        }
      }

      c.db.db.prepare('UPDATE patients SET updated_at = ? WHERE id = ?').run(now(), patientId)
      this.log(c, a, patientId, 'imaging_analyze', recId)

      return c.db.db.prepare('SELECT * FROM records WHERE id = ?').get(recId) as unknown as RecordRow
    })

    return {
      record: { ...createdRec, text_enc: undefined, imaging_data: imagingPayload } as any,
      asset_id: asset.id,
      file_id: fid,
      raw_file_id: rawFid,
    }
  }

  /**
   * 多期随访影像测量对比：基线与随访的长径、体积、粘液栓等测值变化。
   * RECIST 1.1 分类只在基线有 ≥ 10 mm 靶病灶、随访有对应测值、两次测量方法一致时输出（见 assessRecist），
   * 否则为「不适用」并说明原因；不给诊断结论与处置建议。可选择把对比结果存为新的病历记录。
   */
  compareImaging(a: Actor, patientId: string, input?: {
    baseline_record_id?: string
    followup_record_id?: string
    save_as_record?: boolean
  }): {
    ok: boolean
    patient_id: string
    patient_code: string
    is_single_baseline?: boolean
    message?: string
    baseline?: any
    followup?: any
    interval_days?: number
    recist?: {
      target_type: 'tumor_lesion' | 'bronchiectasis_mucus' | 'general'
      baseline_ld_mm?: number
      followup_ld_mm?: number
      diff_ld_mm?: number
      percent_change_ld?: number
      baseline_volume_cm3?: number
      followup_volume_cm3?: number
      diff_volume_cm3?: number
      percent_change_volume?: number
      vdt?: any
      category: RecistCategory
      category_name: string
      /** category 为 NA 时的原因 */
      na_reason: string | null
      /** 「按 RECIST 1.1 阈值计算，未经阅片确认」 */
      recist_note: string
      interpretation: string
      academic_statement: string
    }
    summary_markdown: string
    record_id?: string
  } {
    const { c, p } = this.visible(a, patientId)
    const rows = (c.db.db.prepare("SELECT * FROM records WHERE patient_id = ? AND kind = 'imaging' ORDER BY COALESCE(report_date, created_at) ASC").all(patientId) as unknown as Array<RecordRow & { text_enc?: string | null }>)
      .map(r => {
        let imaging_data: Record<string, any> | null = null
        if (r.text_enc) {
          try {
            const dec = this.keys.decryptText(c.tenantId, r.text_enc)
            if (dec) imaging_data = JSON.parse(dec)
          } catch {}
        }
        return { ...r, text_enc: undefined, imaging_data }
      })

    const validRows = rows.filter(r => r.imaging_data && r.status !== 'rejected' && r.imaging_data.model_id !== 'recist_longitudinal_comparator')
    if (validRows.length === 0) {
      throw new PatientError('no_imaging_records', '该患者尚无已记录的医学影像量化分析数据', 400)
    }

    if (validRows.length === 1) {
      const single = validRows[0]!
      const singleDate = single.report_date || single.created_at.slice(0, 10)
      const sm = single.imaging_data?.metrics || {}
      return {
        ok: true,
        patient_id: patientId,
        patient_code: p.code,
        is_single_baseline: true,
        message: `患者当前仅有 1 份基线影像（${single.title}，${singleDate}），尚无随访对比时间点。已建立基线肿瘤负荷指标，待后续复查时自动计算 RECIST 1.1 疗效评估。`,
        baseline: {
          record_id: single.id,
          title: single.title,
          date: singleDate,
          modality: single.imaging_data?.modality || 'CT',
          metrics: sm,
          asset_id: single.imaging_data?.asset_id,
          slice_file_id: single.imaging_data?.file_id,
          file_id: single.imaging_data?.file_id || (single.file_id !== single.imaging_data?.raw_file_id ? single.file_id : undefined),
          raw_file_id: single.imaging_data?.raw_file_id,
        },
        summary_markdown: `# 患者 ${p.code} 基线影像指标存档\n\n- **检查日期**: ${singleDate}\n- **检查项目**: ${single.title}\n- **状态**: 单期基线，待后续随访对比。`,
      }
    }

    let baseline = input?.baseline_record_id
      ? validRows.find(r => r.id === input.baseline_record_id)
      : validRows[0]!
    let followup = input?.followup_record_id
      ? validRows.find(r => r.id === input.followup_record_id)
      : validRows[validRows.length - 1]!

    if (!baseline) throw new PatientError('baseline_not_found', '未找到指定的基线影像记录', 404)
    if (!followup) throw new PatientError('followup_not_found', '未找到指定的随访影像记录', 404)
    if (baseline.id === followup.id) {
      throw new PatientError('invalid_comparison_points', '随访对比需要选择两个不同时期的影像记录', 400)
    }

    // 确保时间顺序：若用户选反了，自动纠正为 baseline 早于 followup
    const bDate = baseline.report_date || baseline.created_at.slice(0, 10)
    const fDate = followup.report_date || followup.created_at.slice(0, 10)
    if (new Date(bDate).getTime() > new Date(fDate).getTime()) {
      const tmp = baseline
      baseline = followup
      followup = tmp
    }

    const baseDateStr = baseline.report_date || baseline.created_at.slice(0, 10)
    const followDateStr = followup.report_date || followup.created_at.slice(0, 10)
    const intervalDays = Math.max(0, Math.round(Math.abs(new Date(followDateStr).getTime() - new Date(baseDateStr).getTime()) / (1000 * 60 * 60 * 24)))

    const bm = baseline.imaging_data?.metrics || {}
    const fm = followup.imaging_data?.metrics || {}

    const bModel = String(baseline.imaging_data?.model_id || '')
    const fModel = String(followup.imaging_data?.model_id || '')
    const isBronch = bModel.includes('bronchiectasis') || fModel.includes('bronchiectasis') || baseline.title.includes('支气管') || followup.title.includes('支气管')

    const round = (n: number, d = 1) => {
      const f = Math.pow(10, d)
      return Math.round(n * f) / f
    }

    const bLd = Number(bm.longest_diameter_mm || bm.bronchus_caliber_mm || 0)
    const fLd = Number(fm.longest_diameter_mm || fm.bronchus_caliber_mm || 0)
    const bVol = Number(bm.total_volume_cm3 || bm.total_mucus_volume_cm3 || 0)
    const fVol = Number(fm.total_volume_cm3 || fm.total_mucus_volume_cm3 || 0)

    const bMucus = Number(bm.total_mucus_volume_cm3 ?? bm.mucus_plug_volume_mm3 ?? 0)
    const fMucus = Number(fm.total_mucus_volume_cm3 ?? fm.mucus_plug_volume_mm3 ?? 0)
    const bHam = Number(bm.high_attenuation_mucus_cm3 ?? 0)
    const fHam = Number(fm.high_attenuation_mucus_cm3 ?? 0)
    const bBar = bm.bar_ratio !== undefined ? Number(bm.bar_ratio) : undefined
    const fBar = fm.bar_ratio !== undefined ? Number(fm.bar_ratio) : undefined

    const diffLd = round(fLd - bLd, 1)
    const pctLd = bLd > 0 ? round((diffLd / bLd) * 100, 1) : 0
    const diffVol = round(fVol - bVol, 2)
    const pctVol = bVol > 0 ? round((diffVol / bVol) * 100, 1) : 0

    // RECIST 1.1 分类收紧：只有满足可测量与方法一致等前提时才输出 CR / PR / SD / PD，否则为「不适用」并说明原因
    let category: RecistCategory = 'NA'
    let categoryName = '不适用'
    let naReason: string | null = null
    let interpretation = ''
    let targetType: 'tumor_lesion' | 'bronchiectasis_mucus' | 'general' = 'general'

    if (isBronch && (bMucus > 0 || fMucus > 0 || bBar !== undefined)) {
      targetType = 'bronchiectasis_mucus'
      const diffMucus = round(fMucus - bMucus, 2)
      const pctMucus = bMucus > 0 ? round((diffMucus / bMucus) * 100, 1) : 0
      naReason = '气道粘液栓不是 RECIST 1.1 靶病灶，不做疗效分类'
      interpretation = `粘液栓总体积由 ${bMucus} cm³ 变为 ${fMucus} cm³（${pctMucus > 0 ? '+' : ''}${pctMucus}%）；高密度粘液栓体积由 ${bHam} cm³ 变为 ${fHam} cm³。`
    } else {
      targetType = 'tumor_lesion'
      const r = assessRecist(bm, fm, baseline.imaging_data ?? {}, followup.imaging_data ?? {})
      category = r.category
      categoryName = r.name
      naReason = r.reason
      interpretation = r.detail
    }

    const signLd = pctLd > 0 ? `+${pctLd}%` : `${pctLd}%`
    const signVol = pctVol > 0 ? `+${pctVol}%` : `${pctVol}%`

    // 计算肿瘤体积倍增时间 (Schwartz VDT 动力学评估)
    let vdt: {
      days: number | null
      category: 'rapid_growth' | 'intermediate_growth' | 'indolent_growth' | 'stable' | 'regressed' | 'indeterminate'
      risk_level: 'critical_high' | 'medium_warning' | 'low_indolent' | 'low' | 'none'
      label: string
      description: string
      clinical_alert: boolean
      recommendation: string
    } = {
      days: null,
      category: 'indeterminate',
      risk_level: 'none',
      label: '无法计算 (数据不足)',
      description: '需至少两次有效体积测定且随访间隔大于0天',
      clinical_alert: false,
      recommendation: '',
    }

    if (bVol > 0 && fVol > 0 && intervalDays > 0) {
      if (fVol <= bVol) {
        if (fVol <= bVol * 0.75) {
          vdt = {
            days: null,
            category: 'regressed',
            risk_level: 'low',
            label: `体积显著缩小 (缩小 ${Math.abs(pctVol)}%)`,
            description: `病灶体积较基线缩小 ${Math.abs(pctVol)}%。`,
            clinical_alert: false,
            recommendation: '',
          }
        } else {
          vdt = {
            days: null,
            category: 'stable',
            risk_level: 'low',
            label: '体积相对稳定',
            description: `病灶体积变化在标准测量误差范围内 (${pctVol > 0 ? '+' : ''}${pctVol}%)，未见明确增大。`,
            clinical_alert: false,
            recommendation: '',
          }
        }
      } else {
        const vdtDays = round((intervalDays * Math.LN2) / Math.log(fVol / bVol), 1)
        if (vdtDays < 400.0) {
          vdt = {
            days: vdtDays,
            category: 'rapid_growth',
            risk_level: 'critical_high',
            label: `${vdtDays} 天（< 400 天）`,
            description: `体积倍增时间 ${vdtDays} 天，体积增大 +${pctVol}%。`,
            clinical_alert: true,
            recommendation: '',
          }
        } else if (vdtDays <= 600.0) {
          vdt = {
            days: vdtDays,
            category: 'intermediate_growth',
            risk_level: 'medium_warning',
            label: `${vdtDays} 天（400–600 天）`,
            description: `体积倍增时间 ${vdtDays} 天，体积增大 +${pctVol}%。`,
            clinical_alert: false,
            recommendation: '',
          }
        } else {
          vdt = {
            days: vdtDays,
            category: 'indolent_growth',
            risk_level: 'low_indolent',
            label: `${vdtDays} 天（> 600 天）`,
            description: `体积倍增时间 ${vdtDays} 天，体积增大 +${pctVol}%。`,
            clinical_alert: false,
            recommendation: '',
          }
        }
      }
    }

    const academicStatement = targetType === 'bronchiectasis_mucus'
      ? `依据气道与粘液栓容积量化标准，患者 ${p.code} 随访对比（${intervalDays === 0 ? '同日复核分析，非跨期随访' : `间隔 ${intervalDays} 天`}）：支气管粘液栓 3D 总体积由基线 ${bMucus} cm³ 变化至 ${fMucus} cm³（${signVol}），高密度粘液栓 (HAM) 由 ${bHam} cm³ 变化至 ${fHam} cm³。RECIST 1.1 分类：不适用（${naReason}）。`
      : `患者 ${p.code} 随访对比（间隔 ${intervalDays} 天）：靶病灶最大长径由基线 ${bLd} mm 变化至 ${fLd} mm（${signLd}），3D 总体积由 ${bVol} cm³ 变化至 ${fVol} cm³（${signVol}），体积倍增时间 (VDT): ${vdt.days !== null ? `${vdt.days} 天` : vdt.label}。RECIST 1.1 分类：${category === 'NA' ? `不适用（${naReason}）` : `${categoryName}（${RECIST_NOTE}）`}。`

    const baseAssetId = baseline.imaging_data?.asset_id
    const followAssetId = followup.imaging_data?.asset_id

    const summaryMd = `# 影像多期随访测量对比

**患者代号**: \`${p.code}\`  
**基线检查**: ${baseline.title} (\`${baseDateStr}\`)  
**随访检查**: ${followup.title} (\`${followDateStr}\`)  
**随访间隔**: **${intervalDays}** 天  

---

### 一、 测量变化
> **RECIST 1.1 分类**: ${category === 'NA' ? `不适用 — ${naReason}` : `${categoryName}（${RECIST_NOTE}）`}  
> **测量说明**: ${interpretation}  
> **汇总**: ${academicStatement}

---

### 二、 靶病灶与量化指标演变对比表
| 测量指标 | 基线 (Baseline: ${baseDateStr}) | 随访 (Follow-up: ${followDateStr}) | 绝对差值 (Δ) | 变化率 (Δ%) | 评估标准 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **最大截面长径 (LD)** | ${bLd} mm | ${fLd} mm | ${diffLd > 0 ? '+' : ''}${diffLd} mm | **${signLd}** | RECIST 1.1 靶病灶标准 |
| **3D 总体积 (Volume)** | ${bVol} cm³ | ${fVol} cm³ | ${diffVol > 0 ? '+' : ''}${diffVol} cm³ | **${signVol}** | 3D MONAI 深度学习测量 |
${bBar !== undefined || fBar !== undefined ? `| **支气管伴行动脉比 (BAR)** | ${bBar ?? '--'} | ${fBar ?? '--'} | ${fBar !== undefined && bBar !== undefined ? round(fBar - bBar, 2) : '--'} | -- | 印戒征 (>1.10) |` : ''}
${bMucus > 0 || fMucus > 0 ? `| **粘液栓体积** | ${bMucus} cm³ | ${fMucus} cm³ | ${round(fMucus - bMucus, 2)} cm³ | ${bMucus > 0 ? round(((fMucus - bMucus) / bMucus) * 100, 1) + '%' : '--'} | 气道嵌顿负荷 |` : ''}
${bHam > 0 || fHam > 0 ? `| **高密度粘液栓 (HAM)** | ${bHam} cm³ | ${fHam} cm³ | ${round(fHam - bHam, 2)} cm³ | -- | 高密度粘液栓体积 |` : ''}
| **体积倍增时间 (VDT)** | -- | -- | ${vdt.days !== null ? `${vdt.days} 天` : '--'} | **${vdt.label}** | Schwartz 公式 |

---

### 三、 体积倍增时间 (Schwartz VDT)
> **倍增时间**: **${vdt.days !== null ? `${vdt.days} 天` : '未计算'}**（${vdt.label}）  
> **说明**: ${vdt.description}

---

### 四、 双期关键截面影像对照
${baseAssetId ? `- **基线关键切片**: ![基线关键切片](asset:${baseAssetId} "基线影像 (${baseDateStr})")` : ''}
${followAssetId ? `- **随访关键切片**: ![随访关键切片](asset:${followAssetId} "随访影像 (${followDateStr})")` : ''}

---

### 五、 说明
上述所见需结合临床与实验室检查判断。本报告只列出测量值及其变化，不包含诊断结论与治疗建议。
`

    let savedRecordId: string | undefined
    if (input?.save_as_record) {
      this.requireTeam(a, patientId)
      savedRecordId = rid('rc')
      const comparisonPayload = {
        model_id: 'recist_longitudinal_comparator',
        sample_id: null,
        modality: baseline.imaging_data?.modality || followup.imaging_data?.modality || 'CT',
        baseline_record_id: baseline.id,
        followup_record_id: followup.id,
        interval_days: intervalDays,
        recist: {
          category,
          category_name: categoryName,
          diff_ld_mm: diffLd,
          percent_change_ld: pctLd,
          diff_volume_cm3: diffVol,
          percent_change_volume: pctVol,
          vdt,
          interpretation,
          academic_statement: academicStatement,
        },
        metrics: {
          longest_diameter_mm: fLd,
          total_volume_cm3: fVol,
          recist_category: category,
          recist_category_name: categoryName,
          percent_change_ld: pctLd,
          percent_change_volume: pctVol,
          baseline_ld_mm: bLd,
          followup_ld_mm: fLd,
          diff_ld_mm: diffLd,
          baseline_volume_cm3: bVol,
          followup_volume_cm3: fVol,
          diff_volume_cm3: diffVol,
          vdt,
        },
        findings: [
          `RECIST 1.1 分类: ${category === 'NA' ? `不适用（${naReason}）` : `${categoryName}（${RECIST_NOTE}）`}`,
          `长径变化: ${signLd} (${bLd} mm → ${fLd} mm)`,
          `体积变化: ${signVol} (${bVol} cm³ → ${fVol} cm³)`,
          `体积倍增时间 (VDT): ${vdt.days !== null ? `${vdt.days} 天` : vdt.label}`,
        ],
        asset_id: followAssetId || baseAssetId,
        slice_file_id: followup.imaging_data?.file_id || baseline.imaging_data?.file_id || null,
        file_id: followup.imaging_data?.file_id || baseline.imaging_data?.file_id || null,
        raw_file_id: followup.imaging_data?.raw_file_id || followup.file_id || null,
        analyzed_at: now(),
      }
      const encText = this.keys.encryptText(c.tenantId, JSON.stringify(comparisonPayload))
      const summaryNote = `${category} · ${categoryName} · 长径 ${signLd} · 体积 ${signVol}`
      c.db.db.prepare(`INSERT INTO records (id, patient_id, kind, title, report_date, file_id, status, text_enc, extraction, extraction_note, created_by, created_at, confirmed_by, confirmed_at)
        VALUES (?, ?, 'imaging', ?, ?, ?, 'confirmed', ?, 'done', ?, ?, ?, ?, ?)`)
        .run(savedRecordId, patientId, `多期影像随访 RECIST 1.1 疗效评估 (${category})`, followDateStr, followup.file_id || baseline.file_id,
          encText, summaryNote.slice(0, 200), a.userId, now(), a.userId, now())
      c.db.db.prepare('UPDATE patients SET updated_at = ? WHERE id = ?').run(now(), patientId)
      this.log(c, a, patientId, 'imaging_compare', savedRecordId)
    }

    return {
      ok: true,
      patient_id: patientId,
      patient_code: p.code,
      is_single_baseline: false,
      baseline: {
        record_id: baseline.id,
        title: baseline.title,
        date: baseDateStr,
        modality: baseline.imaging_data?.modality || 'CT',
        metrics: bm,
        asset_id: baseAssetId,
        slice_file_id: baseline.imaging_data?.file_id,
        file_id: baseline.imaging_data?.file_id || (baseline.file_id !== baseline.imaging_data?.raw_file_id ? baseline.file_id : undefined),
        raw_file_id: baseline.imaging_data?.raw_file_id,
      },
      followup: {
        record_id: followup.id,
        title: followup.title,
        date: followDateStr,
        modality: followup.imaging_data?.modality || 'CT',
        metrics: fm,
        asset_id: followAssetId,
        slice_file_id: followup.imaging_data?.file_id,
        file_id: followup.imaging_data?.file_id || (followup.file_id !== followup.imaging_data?.raw_file_id ? followup.file_id : undefined),
        raw_file_id: followup.imaging_data?.raw_file_id,
      },
      interval_days: intervalDays,
      recist: {
        target_type: targetType,
        baseline_ld_mm: bLd,
        followup_ld_mm: fLd,
        diff_ld_mm: diffLd,
        percent_change_ld: pctLd,
        baseline_volume_cm3: bVol,
        followup_volume_cm3: fVol,
        diff_volume_cm3: diffVol,
        percent_change_volume: pctVol,
        vdt,
        category,
        category_name: categoryName,
        na_reason: naReason,
        recist_note: RECIST_NOTE,
        interpretation,
        academic_statement: academicStatement,
      },
      summary_markdown: summaryMd,
      record_id: savedRecordId,
    }
  }

  /**
   * 影像测值与化验指标对照：把影像量化测值（BAR、高密度粘液栓、结节长径 / 体积等）与化验指标、病史标签
   * 对照所列参考阈值，输出「达到 / 未达到 / 缺少数据」与化验相对参考区间的方向。
   * 对外不给诊断结论与检查 / 处置建议（syndrome 只是主题名，diagnostic_impression 为中性说明，suggested_workup 为空）。
   */
  getEvidenceChain(a: Actor, patientId: string, input?: {
    record_id?: string
    baseline_record_id?: string
    followup_record_id?: string
  }): {
    ok: boolean
    patient_id: string
    patient_code: string
    record_id: string
    record_title: string
    syndrome: string
    syndrome_key: 'abpa_bronchiectasis' | 'lung_neoplasm_recist' | 'copd_emphysema' | 'abdominal_organ' | 'general'
    match_summary: string
    criteria_table: Array<{
      criterion: string
      category: 'imaging' | 'lab' | 'history'
      status: 'positive' | 'negative' | 'missing'
      evidence_value: string
      reference_guideline: string
    }>
    matched_labs: Array<{
      test_key: string
      test_name: string
      value: string
      unit: string
      flag: string | null
      date: string
      clinical_significance: string
    }>
    suggested_workup: string[]
    diagnostic_impression: string
    summary_markdown: string
  } {
    const { c, p } = this.visible(a, patientId)
    const recRows = c.db.db.prepare('SELECT * FROM records WHERE patient_id = ? ORDER BY COALESCE(report_date, created_at) DESC').all(patientId) as any[]

    const imagingRecs = recRows.filter(r => r.kind === 'imaging').map(r => {
      let imaging_data: Record<string, any> | null = null
      if (r.text_enc) {
        try {
          const dec = this.keys.decryptText(c.tenantId, r.text_enc)
          if (dec) imaging_data = JSON.parse(dec)
        } catch {}
      }
      return { ...r, imaging_data }
    })

    if (imagingRecs.length === 0) {
      throw new PatientError('imaging_record_not_found', '该患者尚无医学影像量化分析记录', 404)
    }

    const scanRecs = imagingRecs.filter(r => r.imaging_data && r.imaging_data.model_id !== 'recist_longitudinal_comparator')
    const pool = scanRecs.length > 0 ? scanRecs : imagingRecs

    // 解析目标记录
    let targetRec = pool[0]!
    if (input?.record_id) {
      const found = imagingRecs.find(r => r.id === input.record_id)
      if (found) targetRec = found
    } else if (input?.followup_record_id) {
      const found = imagingRecs.find(r => r.id === input.followup_record_id)
      if (found) targetRec = found
    } else if (input?.baseline_record_id) {
      const found = imagingRecs.find(r => r.id === input.baseline_record_id)
      if (found) targetRec = found
    }

    // 读取该患者所有已确认的化验记录
    const confirmedLabs = (c.db.db.prepare("SELECT * FROM labs WHERE patient_id = ? AND status = 'confirmed' ORDER BY collected_on DESC, created_at DESC").all(patientId) as any[]).map(labOf)
    const summaryRow = c.db.db.prepare('SELECT summary_enc FROM patients WHERE id = ?').get(patientId) as { summary_enc: string | null } | undefined
    const patientSummary = (summaryRow?.summary_enc ? this.keys.decryptText(c.tenantId, summaryRow.summary_enc) : null) ?? ''
    const tags: string[] = Array.isArray(p.tags) ? p.tags : []

    const m = (targetRec.imaging_data?.metrics || {}) as Record<string, any>
    const modelId = String(targetRec.imaging_data?.model_id || '')
    const recTitle = String(targetRec.title || '')

    // 综合判定临床病征类别
    const isBronchiectasis = modelId === 'bronchiectasis_mucus_analyzer' ||
      recTitle.includes('支气管') ||
      m.bar_ratio !== undefined ||
      m.total_mucus_volume_cm3 !== undefined ||
      tags.some((t: string) => t.includes('支气管') || t.includes('ABPA'))

    const isNoduleRecist = !isBronchiectasis && (
      modelId.includes('nodule') ||
      m.longest_diameter_mm !== undefined ||
      recTitle.includes('RECIST')
    )

    const isAbdominal = !isBronchiectasis && !isNoduleRecist && (
      modelId.includes('spleen') ||
      modelId.includes('liver') ||
      recTitle.includes('腹部') ||
      recTitle.includes('脾')
    )

    // 查找特定检验项目的辅助闭包
    const findLab = (keys: string[]) => {
      for (const k of keys) {
        const found = confirmedLabs.find(l => l.test_key === k || k.includes(l.test_key))
        if (found) return found
      }
      return null
    }

    let syndromeKey: 'abpa_bronchiectasis' | 'lung_neoplasm_recist' | 'abdominal_organ' | 'general' = 'general'
    const criteriaTable: Array<{
      criterion: string
      category: 'imaging' | 'lab' | 'history'
      status: 'positive' | 'negative' | 'missing'
      evidence_value: string
      reference_guideline: string
    }> = []
    const matchedLabs: Array<{
      test_key: string
      test_name: string
      value: string
      unit: string
      flag: string | null
      date: string
      clinical_significance: string
    }> = []

    if (isBronchiectasis) {
      syndromeKey = 'abpa_bronchiectasis'

      // 1. 基础疾病史 (Asthma or Bronchiectasis)
      const hasPredisposing = tags.some((t: string) => t.includes('支气管') || t.includes('哮喘') || t.includes('咳嗽')) || patientSummary.includes('支气管')
      criteriaTable.push({
        criterion: '基础呼吸系统疾病 (哮喘或支气管扩张)',
        category: 'history',
        status: hasPredisposing ? 'positive' : 'missing',
        evidence_value: hasPredisposing ? `病史标签: ${tags.filter((t: string) => t.includes('支气管') || t.includes('哮喘') || t.includes('咳嗽')).join('、') || '慢性咳嗽'}` : '既往病史未明确记录典型哮喘或支扩',
        reference_guideline: 'ISHAM 2013 / 2024 标准所列条件（阈值出处）',
      })

      // 2. 影像学中心性支扩 (BAR > 1.10 印戒征)
      const barVal = m.bar_ratio !== undefined ? Number(m.bar_ratio) : null
      const barPos = barVal !== null ? barVal > 1.10 : (m.signet_ring_sign === true)
      criteriaTable.push({
        criterion: 'HRCT 中心性支气管扩张 (BAR 印戒征阳性)',
        category: 'imaging',
        status: barPos ? 'positive' : barVal !== null ? 'negative' : 'positive',
        evidence_value: barVal !== null ? `BAR ${barVal}（${barPos ? '> 1.10' : '≤ 1.10'}）` : '未测得 BAR',
        reference_guideline: 'BAR > 1.10（阈值出处：Fleischner 学会）',
      })

      // 3. 高密度粘液栓 (HAM)
      const hamVal = m.high_attenuation_mucus_cm3 !== undefined ? Number(m.high_attenuation_mucus_cm3) : null
      const hamPos = (hamVal !== null && hamVal > 0) || m.high_attenuation_mucus_ham === true || m.high_attenuation_mucus === true || (m.ham_max_hu !== undefined && Number(m.ham_max_hu) > 70)
      criteriaTable.push({
        criterion: '高密度粘液栓 (High-Attenuation Mucus, HAM)',
        category: 'imaging',
        status: hamPos ? 'positive' : 'negative',
        evidence_value: hamPos ? `可见${hamVal !== null ? `（${hamVal} cm³）` : ''}` : '未测得高密度粘液栓',
        reference_guideline: '粘液栓 CT 值高于椎旁肌（阈值出处：ISHAM 2024）',
      })

      // 4. 血清总 IgE
      const igeLab = findLab(['total_ige', 'ige'])
      if (igeLab) {
        const val = igeLab.std_value ?? igeLab.value_num ?? 0
        const isPos = val > 1000 || val > 416
        criteriaTable.push({
          criterion: '血清总 IgE 显著升高 (> 1000 IU/mL 或 > 416 IU/mL)',
          category: 'lab',
          status: isPos ? 'positive' : 'negative',
          evidence_value: `${val} ${igeLab.std_unit || igeLab.unit || 'IU/mL'} (${isPos ? '显著升高 ↑' : '未达门限'})`,
          reference_guideline: '总 IgE > 1000 IU/mL 或 > 416 kU/L（阈值出处：ISHAM）',
        })
        matchedLabs.push({
          test_key: 'total_ige',
          test_name: igeLab.test_name || '血清总 IgE',
          value: String(val),
          unit: igeLab.std_unit || igeLab.unit || 'IU/mL',
          flag: isPos ? 'H' : null,
          date: igeLab.collected_on || '近期',
          clinical_significance: '',
        })
      } else {
        criteriaTable.push({
          criterion: '血清总 IgE 显著升高 (> 1000 IU/mL)',
          category: 'lab',
          status: 'missing',
          evidence_value: '未检测',
          reference_guideline: 'ISHAM 必备检验项',
        })
      }

      // 5. 外周血嗜酸性粒细胞 (EOS#)
      const eosLab = findLab(['eosinophils', 'eos'])
      if (eosLab) {
        const val = eosLab.std_value ?? eosLab.value_num ?? 0
        const isPos = val > 0.5 || eosLab.flag === 'H'
        criteriaTable.push({
          criterion: '外周血嗜酸性粒细胞绝对值升高 (> 0.5 × 10⁹/L)',
          category: 'lab',
          status: isPos ? 'positive' : 'negative',
          evidence_value: `${val} ${eosLab.std_unit || eosLab.unit || '×10⁹/L'} (${isPos ? '嗜酸粒细胞增高 ↑' : '正常'})`,
          reference_guideline: 'ISHAM 次要支持指标 (> 500 / μL)',
        })
        matchedLabs.push({
          test_key: 'eosinophils',
          test_name: eosLab.test_name || '嗜酸性粒细胞绝对值',
          value: String(val),
          unit: eosLab.std_unit || eosLab.unit || '×10⁹/L',
          flag: isPos ? 'H' : null,
          date: eosLab.collected_on || '近期',
          clinical_significance: '',
        })
      } else {
        criteriaTable.push({
          criterion: '外周血嗜酸性粒细胞绝对值升高 (> 0.5 × 10⁹/L)',
          category: 'lab',
          status: 'missing',
          evidence_value: '近期未查血常规五分类 (CBC + Diff)',
          reference_guideline: '支持条件',
        })
      }

      // 6. 烟曲霉特异性 IgE (sIgE)
      const sigeLab = findLab(['aspergillus_sige', 'af_ige'])
      if (sigeLab) {
        const val = sigeLab.std_value ?? sigeLab.value_num ?? 0
        const isPos = val >= 0.35 || sigeLab.flag === 'H'
        criteriaTable.push({
          criterion: '烟曲霉特异性 IgE (sIgE ≥ 0.35 kUA/L) 或皮试阳性',
          category: 'lab',
          status: isPos ? 'positive' : 'negative',
          evidence_value: `${val} ${sigeLab.std_unit || sigeLab.unit || 'kUA/L'} (${isPos ? '特异性致敏阳性 ↑' : '阴性'})`,
          reference_guideline: 'sIgE ≥ 0.35 kUA/L（阈值出处：ISHAM）',
        })
        matchedLabs.push({
          test_key: 'aspergillus_sige',
          test_name: sigeLab.test_name || '烟曲霉特异性 sIgE',
          value: String(val),
          unit: sigeLab.std_unit || sigeLab.unit || 'kUA/L',
          flag: isPos ? 'H' : null,
          date: sigeLab.collected_on || '近期',
          clinical_significance: '',
        })
      } else {
        criteriaTable.push({
          criterion: '烟曲霉特异性 IgE (sIgE ≥ 0.35 kUA/L)',
          category: 'lab',
          status: 'missing',
          evidence_value: '未检测',
          reference_guideline: 'ISHAM 必备检验项',
        })
      }

      // 7. 炎症指标 (CRP / ESR)
      const crpLab = findLab(['crp', 'esr'])
      if (crpLab) {
        matchedLabs.push({
          test_key: crpLab.test_key,
          test_name: crpLab.test_name,
          value: String(crpLab.std_value ?? crpLab.value_num ?? ''),
          unit: crpLab.std_unit || crpLab.unit || '',
          flag: crpLab.flag,
          date: crpLab.collected_on || '近期',
          clinical_significance: '',
        })
      }


    } else if (isNoduleRecist) {
      syndromeKey = 'lung_neoplasm_recist'

      const ld = m.longest_diameter_mm !== undefined ? Number(m.longest_diameter_mm) : null
      const vol = m.total_volume_cm3 !== undefined ? Number(m.total_volume_cm3) : null
      const hasNodule = ld !== null && ld > 0

      criteriaTable.push({
        criterion: 'RECIST 1.1 / Fleischner 靶病灶解剖学长径',
        category: 'imaging',
        status: hasNodule && ld >= 10 ? 'positive' : 'negative',
        evidence_value: hasNodule ? `最大截面长径 ${ld} mm (短径 ${m.short_axis_mm ?? '--'} mm)` : '算法未检出可测量结节',
        reference_guideline: 'RECIST 1.1 / Fleischner 肺结节测量指引',
      })

      if (hasNodule && vol !== null) {
        criteriaTable.push({
          criterion: '3D 肿瘤立体病灶总体积',
          category: 'imaging',
          status: 'positive',
          evidence_value: `${vol} cm³${m.key_slice_index !== undefined && m.key_slice_index !== null ? ` (关键截面第 #${m.key_slice_index} 层)` : ''}`,
          reference_guideline: '影像分析记录中的体积测值',
        })
      }

      // 肿瘤标志物查找
      const ceaLab = findLab(['cea', 'cyfra21_1', 'nse', 'scc'])
      if (ceaLab) {
        const val = ceaLab.std_value ?? ceaLab.value_num ?? 0
        const isPos = ceaLab.flag === 'H'
        criteriaTable.push({
          criterion: `肿瘤生物标志物 (${ceaLab.test_name})`,
          category: 'lab',
          status: isPos ? 'positive' : 'negative',
          evidence_value: `${val} ${ceaLab.std_unit || ceaLab.unit || ''} (${isPos ? '异常升高 ↑' : '正常范围'})`,
          reference_guideline: 'NCCN 肺部肿瘤血清学生物标志物监测',
        })
        matchedLabs.push({
          test_key: ceaLab.test_key,
          test_name: ceaLab.test_name,
          value: String(val),
          unit: ceaLab.std_unit || ceaLab.unit || '',
          flag: ceaLab.flag,
          date: ceaLab.collected_on || '近期',
          clinical_significance: '',
        })
      } else {
        criteriaTable.push({
          criterion: '血清肿瘤标志物五项 (CEA / CYFRA21-1 / NSE / SCC)',
          category: 'lab',
          status: 'missing',
          evidence_value: '近期未查血清肿瘤标志物',
          reference_guideline: '建议补充送检',
        })
      }

      // 炎症标志物
      const crpLab = findLab(['crp', 'wbc'])
      if (crpLab) {
        matchedLabs.push({
          test_key: crpLab.test_key,
          test_name: crpLab.test_name,
          value: String(crpLab.std_value ?? crpLab.value_num ?? ''),
          unit: crpLab.std_unit || crpLab.unit || '',
          flag: crpLab.flag,
          date: crpLab.collected_on || '近期',
          clinical_significance: '',
        })
      }

    } else {
      syndromeKey = isAbdominal ? 'abdominal_organ' : 'general'

      // 提取通用化验
      const genLabs = confirmedLabs.slice(0, 4)
      for (const l of genLabs) {
        matchedLabs.push({
          test_key: l.test_key,
          test_name: l.test_name,
          value: String(l.std_value ?? l.value_num ?? ''),
          unit: l.std_unit || l.unit || '',
          flag: l.flag,
          date: l.collected_on || '近期',
          clinical_significance: '',
        })
      }
      criteriaTable.push({
        criterion: '影像三维量化测量完成',
        category: 'imaging',
        status: 'positive',
        evidence_value: `项目: ${targetRec.title}`,
        reference_guideline: 'MONAI 3D 卷积重建',
      })
    }

    // 对外只给事实对照：指标是否达到所列参考阈值、化验相对参考区间的方向；不给诊断结论与处置建议
    const TOPIC: Record<string, string> = {
      abpa_bronchiectasis: '气道与粘液栓影像测值及相关化验',
      lung_neoplasm_recist: '肺部结节 / 占位测量及相关化验',
      copd_emphysema: '肺实质低衰减区测量',
      abdominal_organ: '腹部脏器容积测量及相关化验',
      general: '影像量化测值及相关化验',
    }
    const topic = TOPIC[syndromeKey] ?? TOPIC.general!
    const neutralImpression = '上述所见需结合临床与实验室检查判断。'
    for (const l of matchedLabs) l.clinical_significance = l.flag === 'H' ? '高于参考区间' : l.flag === 'L' ? '低于参考区间' : '未超出参考区间或未标注'
    const posCount = criteriaTable.filter(c => c.status === 'positive').length
    const totalCount = criteriaTable.length
    const matchSummary = `共对照 ${totalCount} 项指标，其中 ${posCount} 项达到所列参考阈值，${criteriaTable.filter(c => c.status === 'missing').length} 项缺少数据。对照结果不构成诊断。`

    let summaryMd = `### ${topic} · 指标对照\n\n`
    summaryMd += `- **目标影像**: ${targetRec.title} (${targetRec.report_date || '日期未记录'})\n`
    summaryMd += `- **说明**: ${neutralImpression}\n\n`
    summaryMd += `#### 指标与参考阈值对照（不构成诊断）\n\n`
    summaryMd += `| 指标 | 证据类型 | 是否达到阈值 | 实测值 | 阈值出处 |\n`
    summaryMd += `| :--- | :--- | :---: | :--- | :--- |\n`
    for (const row of criteriaTable) {
      const stBadge = row.status === 'positive' ? '达到' : row.status === 'negative' ? '未达到' : '缺少数据'
      const catText = row.category === 'imaging' ? '医学影像' : row.category === 'lab' ? '实验室化验' : '既往病史'
      summaryMd += `| ${row.criterion} | ${catText} | ${stBadge} | ${row.evidence_value} | ${row.reference_guideline} |\n`
    }
    if (matchedLabs.length > 0) {
      summaryMd += `\n#### 相关化验\n\n`
      summaryMd += `| 化验项目 | 检测数值 | 相对参考区间 | 采样日期 |\n`
      summaryMd += `| :--- | :--- | :---: | :--- |\n`
      for (const lab of matchedLabs) {
        summaryMd += `| ${lab.test_name} | ${lab.value} ${lab.unit} | ${lab.flag === 'H' ? '↑ 高于' : lab.flag === 'L' ? '↓ 低于' : '未超出 / 未标注'} | ${lab.date} |\n`
      }
    }

    this.log(c, a, patientId, 'imaging_evidence_chain', targetRec.id)

    return {
      ok: true,
      patient_id: patientId,
      patient_code: p.code,
      record_id: targetRec.id,
      record_title: targetRec.title,
      syndrome: topic,
      syndrome_key: syndromeKey,
      match_summary: matchSummary,
      criteria_table: criteriaTable,
      matched_labs: matchedLabs,
      // 不给检查 / 诊疗建议
      suggested_workup: [] as string[],
      diagnostic_impression: neutralImpression,
      summary_markdown: summaryMd,
    }
  }

  /**
   * 导出标准医学数据交换格式：
   * - fhir: HL7 FHIR R4 DiagnosticReport + ImagingStudy + Observations Bundle
   * - dicom-sr: DICOM Structured Reporting (SOP Class 1.2.840.10008.5.1.4.1.1.88.22, TID 1500)
   */
  exportImagingStandard(
    a: Actor,
    patientId: string,
    input: { record_id?: string; format: 'fhir' | 'dicom-sr' }
  ): {
    format: 'fhir' | 'dicom-sr'
    mime: string
    filename: string
    data: Record<string, any>
  } {
    const { c, p } = this.visible(a, patientId)
    const recRows = c.db.db.prepare('SELECT * FROM records WHERE patient_id = ? ORDER BY COALESCE(report_date, created_at) DESC').all(patientId) as any[]

    const imagingRecs = recRows.filter(r => r.kind === 'imaging').map(r => {
      let imaging_data: Record<string, any> | null = null
      if (r.text_enc) {
        try {
          const dec = this.keys.decryptText(c.tenantId, r.text_enc)
          if (dec) imaging_data = JSON.parse(dec)
        } catch {}
      }
      return { ...r, imaging_data }
    })

    if (imagingRecs.length === 0) {
      throw new PatientError('imaging_record_not_found', '该患者尚无医学影像量化分析记录', 404)
    }

    let targetRec = imagingRecs[0]!
    if (input.record_id) {
      const found = imagingRecs.find(r => r.id === input.record_id)
      if (found) targetRec = found
    }

    const m = (targetRec.imaging_data?.metrics || {}) as Record<string, any>
    const reportDate = targetRec.report_date || new Date().toISOString().slice(0, 10)
    const modality = targetRec.imaging_data?.modality || 'CT'
    const organ = targetRec.imaging_data?.organ || '胸部'
    const title = targetRec.title || 'CT 影像量化分析'

    if (input.format === 'dicom-sr') {
      const studyUid = `1.2.826.0.1.3680043.9.7128.${Date.now()}`
      const seriesUid = `${studyUid}.1`
      const sopInstanceUid = `${studyUid}.1.1`

      const dicomSr = {
        SOPClassUID: '1.2.840.10008.5.1.4.1.1.88.22', // Enhanced SR Storage
        SOPInstanceUID: sopInstanceUid,
        StudyInstanceUID: studyUid,
        SeriesInstanceUID: seriesUid,
        Modality: 'SR',
        Manufacturer: 'Heurion Medical Systems',
        SoftwareVersions: '2.0.0-MONAI',
        ContentDate: reportDate.replace(/-/g, ''),
        ContentTime: '120000',
        PatientID: p.code,
        PatientSex: p.sex || 'O',
        PatientBirthDate: p.birth_year ? `${p.birth_year}0101` : '19800101',
        StudyDescription: `${organ} ${modality} Quantitative Evaluation`,
        SeriesDescription: 'Heurion MONAI 3D Quantitative Analysis SR',
        DocumentTitle: {
          CodeValue: '126000',
          CodingSchemeDesignator: 'DCM',
          CodeMeaning: 'Imaging Measurement Report',
        },
        Language: {
          CodeValue: 'zh',
          CodingSchemeDesignator: 'RFC5646',
          CodeMeaning: 'Chinese',
        },
        TemplateID: 'TID 1500',
        ContentTemplateSequence: [{
          TemplateIdentifier: '1500',
          MappingResource: 'DCMR',
        }],
        FindingsGroup: {
          TargetRegion: organ,
          ImagingModality: modality,
          Measurements: [
            ...(m.longest_diameter_mm !== undefined ? [{
              ConceptName: { CodeValue: '21889-1', CodingSchemeDesignator: 'LN', CodeMeaning: 'Distance/Longest Dimension' },
              Value: m.longest_diameter_mm,
              Unit: { CodeValue: 'mm', CodingSchemeDesignator: 'UCUM', CodeMeaning: 'millimeter' },
              Derivation: 'RECIST 1.1 Maximum In-Plane Diameter',
            }] : []),
            ...(m.short_axis_mm !== undefined ? [{
              ConceptName: { CodeValue: '121207', CodingSchemeDesignator: 'DCM', CodeMeaning: 'Perpendicular Dimension' },
              Value: m.short_axis_mm,
              Unit: { CodeValue: 'mm', CodingSchemeDesignator: 'UCUM', CodeMeaning: 'millimeter' },
            }] : []),
            ...(m.total_volume_cm3 !== undefined ? [{
              ConceptName: { CodeValue: '121216', CodingSchemeDesignator: 'DCM', CodeMeaning: 'Volume measurement' },
              Value: m.total_volume_cm3,
              Unit: { CodeValue: 'cm3', CodingSchemeDesignator: 'UCUM', CodeMeaning: 'cubic centimeter' },
              Derivation: 'MONAI 3D Voxel Summation',
            }] : []),
            ...(m.bar_ratio !== undefined ? [{
              ConceptName: { CodeValue: 'HEURION-001', CodingSchemeDesignator: '99HEURION', CodeMeaning: 'Broncho-Arterial Ratio (BAR)' },
              Value: m.bar_ratio,
              Unit: { CodeValue: '1', CodingSchemeDesignator: 'UCUM', CodeMeaning: 'ratio' },
            }] : []),
            ...(m.ham_density_confirmed !== undefined ? [{
              ConceptName: { CodeValue: 'HEURION-002', CodingSchemeDesignator: '99HEURION', CodeMeaning: 'High Attenuation Mucus Presence' },
              Value: m.ham_density_confirmed ? 'Positive' : 'Negative',
              PeakHU: m.max_hu ?? null,
            }] : []),
          ],
          QualitativeEvaluations: [
            { ConceptName: 'Assessment Note', Value: targetRec.extraction_note || 'Quantitative analysis completed' },
            { ConceptName: 'Key Slice Index', Value: m.key_slice_index ?? 0 },
          ],
        },
      }

      return {
        format: 'dicom-sr',
        mime: 'application/json',
        filename: `${p.code}_${reportDate}_DICOM_SR.json`,
        data: dicomSr,
      }
    }

    // Default: HL7 FHIR R4 DiagnosticReport
    const fhirReport = {
      resourceType: 'DiagnosticReport',
      id: `report-${targetRec.id}`,
      meta: {
        profile: ['http://hl7.org/fhir/StructureDefinition/DiagnosticReport'],
        lastUpdated: new Date().toISOString(),
      },
      status: 'final',
      category: [{
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
          code: 'RAD',
          display: 'Radiology',
        }],
      }],
      code: {
        coding: [{
          system: 'http://loinc.org',
          code: '24627-2',
          display: `${organ} ${modality} Scan`,
        }],
        text: title,
      },
      subject: {
        reference: `Patient/${p.id}`,
        identifier: { system: 'urn:heurion:patient:code', value: p.code },
        display: `Patient ${p.code}`,
      },
      effectiveDateTime: reportDate,
      issued: new Date().toISOString(),
      performer: [{
        display: 'Heurion AI Diagnostics & MONAI Imaging Worker',
      }],
      resultsInterpreter: [{
        display: 'Heurion Platform Clinical Decision Support Engine',
      }],
      conclusion: targetRec.extraction_note || '3D Quantitative Analysis completed under RECIST 1.1 / Fleischner Criteria',
      contained: [
        ...(m.longest_diameter_mm !== undefined ? [{
          resourceType: 'Observation',
          id: 'obs-longest-diameter',
          status: 'final',
          code: {
            coding: [{ system: 'http://loinc.org', code: '21889-1', display: 'Size.maximum dimension' }],
            text: 'RECIST 1.1 靶病灶最大长径',
          },
          valueQuantity: {
            value: m.longest_diameter_mm,
            unit: 'mm',
            system: 'http://unitsofmeasure.org',
            code: 'mm',
          },
        }] : []),
        ...(m.total_volume_cm3 !== undefined ? [{
          resourceType: 'Observation',
          id: 'obs-3d-volume',
          status: 'final',
          code: {
            coding: [{ system: 'http://loinc.org', code: '82810-3', display: 'Volume of body structure' }],
            text: '病灶 3D 三维体素体积',
          },
          valueQuantity: {
            value: m.total_volume_cm3,
            unit: 'cm3',
            system: 'http://unitsofmeasure.org',
            code: 'cm3',
          },
        }] : []),
        ...(m.bar_ratio !== undefined ? [{
          resourceType: 'Observation',
          id: 'obs-bar-ratio',
          status: 'final',
          code: {
            coding: [{ system: 'urn:heurion:codes', code: 'BAR', display: 'Broncho-Arterial Ratio' }],
            text: '支气管-伴行动脉径比 (BAR)',
          },
          valueQuantity: {
            value: m.bar_ratio,
            unit: 'ratio',
          },
          interpretation: [{
            coding: [{
              system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
              code: m.bar_ratio > 1.10 ? 'A' : 'N',
              display: m.bar_ratio > 1.10 ? 'Abnormal (Bronchiectasis Signet Ring)' : 'Normal',
            }],
          }],
        }] : []),
      ],
    }

    return {
      format: 'fhir',
      mime: 'application/json',
      filename: `${p.code}_${reportDate}_FHIR_DiagnosticReport.json`,
      data: fhirReport,
    }
  }

  /**
   * 影像量化所见报告
   * 自动汇聚 MONAI 3D 病灶量化、RECIST 1.1 靶病灶长短径、CT值分布、关键截面切片、
   * 协同实验室化验（总 IgE、嗜酸粒细胞、肿瘤标志物等）及既往病史，
   * 生成影像量化所见报告（检查方法只写影像元数据里有的参数；所见只列实测值；不给诊断结论与治疗建议），
   * 并支持自动保存入患者病历档案 (kind='report')。
   */
  generateComprehensiveReport(
    a: Actor,
    patientId: string,
    input: {
      record_id?: string
      save_to_records?: boolean
      title?: string
    } = {}
  ): {
    ok: true
    patient_id: string
    patient_code: string
    title: string
    exam_date: string
    modality: string
    findings: string
    impression: string
    recommendations: string
    full_report_markdown: string
    saved_record_id?: string
    /** 存入病历后的状态：AI 生成为 pending（待医生确认），医生本人生成为 confirmed */
    saved_status?: 'pending' | 'confirmed'
    metrics: Record<string, any>
    evidence: Record<string, any>
  } {
    const { c, p } = this.visible(a, patientId)
    const recRows = c.db.db.prepare('SELECT * FROM records WHERE patient_id = ? ORDER BY COALESCE(report_date, created_at) DESC').all(patientId) as any[]

    const imagingRecs = recRows.filter(r => r.kind === 'imaging').map(r => {
      let imaging_data: Record<string, any> | null = null
      if (r.text_enc) {
        try {
          const dec = this.keys.decryptText(c.tenantId, r.text_enc)
          if (dec) imaging_data = JSON.parse(dec)
        } catch {}
      }
      return { ...r, imaging_data }
    })

    if (imagingRecs.length === 0) {
      throw new PatientError('no_imaging', '患者尚无医学影像分析记录，无法生成影像量化所见报告', 400)
    }

    const targetRec = input.record_id ? imagingRecs.find(r => r.id === input.record_id) : imagingRecs[0]
    if (!targetRec) {
      throw new PatientError('not_found', '指定的医学影像记录不存在', 404)
    }

    const imgData = (targetRec.imaging_data || {}) as Record<string, any>
    const recist = imgData.recist_metrics || {}
    const rawMetrics = imgData.raw_metrics || imgData.metrics || {}
    const examDate = targetRec.report_date || targetRec.created_at.slice(0, 10)
    const modality = String(imgData.modality || rawMetrics.modality || '未记录')

    // 化验对照（只列数值与参考区间方向，不做诊断解读）
    const evidence = this.getEvidenceChain(a, patientId, { record_id: targetRec.id })

    // —— 实测值：缺失保持 null，报告里不写 ——
    const pick = (...vals: unknown[]): number | null => {
      for (const v of vals) { if (v === null || v === undefined || v === '') continue; const n = Number(v); if (Number.isFinite(n)) return n }
      return null
    }
    const ld = pick(recist.longest_diameter_mm, rawMetrics.longest_diameter_mm)
    const sd = pick(recist.short_axis_mm, rawMetrics.short_axis_mm)
    const vol = pick(recist.total_volume_cm3, rawMetrics.total_volume_cm3, rawMetrics.total_mucus_volume_cm3)
    const keySlice = pick(recist.slice_index, rawMetrics.key_slice_index)
    const hamClusters: any[] = Array.isArray(rawMetrics.mucus_nodule_locations) ? rawMetrics.mucus_nodule_locations : []
    const hamMeanHu = pick(rawMetrics.mucus_mean_hu, hamClusters.length ? Math.round(hamClusters.reduce((acc: number, x: any) => acc + (Number(x.mean_hu) || 0), 0) / hamClusters.length * 10) / 10 : null)
    const hamMaxHu = pick(rawMetrics.ham_max_hu, hamClusters.length ? Math.max(...hamClusters.map((x: any) => Number(x.max_hu) || 0)) : null)
    const isHAM = Boolean(rawMetrics.high_attenuation_mucus || rawMetrics.high_attenuation_mucus_ham || (hamMaxHu !== null && hamMaxHu > 70) || (hamMeanHu !== null && hamMeanHu > 60))
    const barMax = pick(rawMetrics.bar_ratio, rawMetrics.broncho_arterial_ratio, rawMetrics.bar_max)
    const bronchusCaliber = pick(rawMetrics.bronchus_caliber_mm)
    const arteryCaliber = pick(rawMetrics.artery_caliber_mm)
    const solidCoreLd = pick(recist.solid_core_diameter_mm, rawMetrics.solid_core_diameter_mm)
    const ctr = pick(recist.consolidation_tumor_ratio, rawMetrics.consolidation_tumor_ratio)
    const noduleType = recist.nodule_type_zh || rawMetrics.nodule_type_zh
    const qc = (recist as any).quality_control || (rawMetrics as any).quality_control || {}
    const emphysema = (recist as any).emphysema || (rawMetrics as any).emphysema || null
    const bc = rawMetrics.body_composition || {}
    const spacing = Array.isArray(imgData.voxel_spacing_mm) ? imgData.voxel_spacing_mm : Array.isArray(rawMetrics.voxel_spacing_mm) ? rawMetrics.voxel_spacing_mm : null
    const fmt = (v: number | null, unit = '') => v === null ? null : `${v}${unit ? ` ${unit}` : ''}`

    // 1. 检查方法：只写影像元数据里有的参数，没有就不写
    const techLines: string[] = []
    techLines.push(`- 设备模态：${modality}`)
    const thickness = pick(qc.slice_thickness_mm, imgData.slice_thickness_mm, rawMetrics.slice_thickness_mm)
    if (thickness !== null) techLines.push(`- 重建层厚：${thickness} mm`)
    if (spacing) techLines.push(`- 体素间距：${spacing.join(' × ')} mm`)
    if (imgData.model_id) techLines.push(`- 量化分析模型：${imgData.model_id}`)
    if (imgData.analyzed_at) techLines.push(`- 分析时间：${imgData.analyzed_at}`)
    if (qc.warning) techLines.push(`- 质控提示：${qc.warning}`)
    const techMethod = techLines.join('\n')

    // 2. 影像所见：只列量化记录里的实测值
    const items: string[] = []
    const add = (label: string, value: string | null) => { if (value !== null) items.push(`- **${label}**：${value}`) }
    add('病灶类型（算法标注）', noduleType ? String(noduleType) : null)
    add('最大长径', fmt(ld, 'mm'))
    add('垂直短径', fmt(sd, 'mm'))
    add('三维体积', fmt(vol, 'cm³'))
    add('实性成分长径', solidCoreLd !== null && solidCoreLd > 0 ? fmt(solidCoreLd, 'mm') : null)
    add('实性成分占比 (CTR)', ctr !== null ? `${Math.round(ctr * 100)}%` : null)
    add('关键层面', keySlice !== null ? `第 #${keySlice} 层` : null)
    add('支气管内径', fmt(bronchusCaliber, 'mm'))
    add('伴行动脉内径', fmt(arteryCaliber, 'mm'))
    add('支气管 / 伴行动脉径比 (BAR)', fmt(barMax))
    add('粘液栓平均 CT 值', fmt(hamMeanHu, 'HU'))
    add('粘液栓最高 CT 值', fmt(hamMaxHu, 'HU'))
    if (isHAM) items.push(`- **高密度粘液栓**：可见${hamMaxHu !== null ? `（最高 ${hamMaxHu} HU）` : ''}`)
    add('受累分布（算法标注）', rawMetrics.distribution_summary ? String(rawMetrics.distribution_summary) : null)
    if (emphysema) {
      add('双肺总容积', fmt(pick(emphysema.total_lung_volume_liters), 'L'))
      add('低衰减区 (≤ -950 HU) 容积', fmt(pick(emphysema.emphysema_volume_liters), 'L'))
      add('LAA-950%', fmt(pick(emphysema.laa_percent), '%'))
      add('双肺平均 CT 值', fmt(pick(emphysema.mean_lung_attenuation_hu), 'HU'))
    }
    add('L3 骨骼肌面积', fmt(pick(bc.skeletal_muscle_area_cm2), 'cm²'))
    add('L3 骨骼肌指数 (SMI)', fmt(pick(bc.skeletal_muscle_index_cm2_m2), 'cm²/m²'))
    add('内脏脂肪面积', fmt(pick(bc.visceral_adipose_cm2), 'cm²'))
    add('皮下脂肪面积', fmt(pick(bc.subcutaneous_adipose_cm2), 'cm²'))
    add('VAT/SAT', fmt(pick(bc.vat_to_sat_ratio)))
    const findings = items.length ? items.join('\n') : '- 该影像记录没有可用的量化测值。'

    // 3. 不给诊断结论与处置建议
    const impression = '上述所见需结合临床与实验室检查判断。'
    const recommendations = ''

    const reportTitle = input.title || `影像量化所见 · ${targetRec.title}`
    const rptId = `RPT-${p.code}-${examDate.replace(/-/g, '')}-01`

    let fullReportMd = `# 影像量化所见报告\n\n`
    fullReportMd += `**患者代号**: \`${p.code}\`  |  **性别/出生年份**: ${p.sex || '--'} / ${p.birth_year || '--'}  |  **检查日期**: ${examDate}  |  **报告流水号**: \`${rptId}\`\n`
    fullReportMd += `**检查项目**: ${targetRec.title}\n\n`
    fullReportMd += `---\n\n`
    fullReportMd += `### 一、 检查方法 (Technique)\n${techMethod}\n\n`
    fullReportMd += `### 二、 影像所见 (Findings)\n${findings}\n\n`
    if (evidence.matched_labs && evidence.matched_labs.length > 0) {
      fullReportMd += `### 三、 相关化验 (Laboratory)\n`
      fullReportMd += `| 项目 | 数值 | 相对参考区间 | 采样日期 |\n`
      fullReportMd += `| :--- | :--- | :---: | :--- |\n`
      for (const lab of evidence.matched_labs) {
        fullReportMd += `| ${lab.test_name} | ${lab.value} ${lab.unit} | ${lab.flag === 'H' ? '↑ 高于' : lab.flag === 'L' ? '↓ 低于' : '未超出 / 未标注'} | ${lab.date} |\n`
      }
      fullReportMd += `\n`
    }
    fullReportMd += `### ${evidence.matched_labs?.length ? '四' : '三'}、 说明\n${impression}\n\n`
    fullReportMd += `---\n`
    fullReportMd += `> 本报告只列出影像量化算法记录的实测值与化验数值，不包含诊断结论与治疗建议；量化结果由算法生成，须由执业医师结合临床审阅。\n`

    let savedRecordId: string | undefined
    if (input.save_to_records !== false) {
      const { c: teamCtx } = this.requireTeam(a, patientId)
      const newRecId = rid('rc')
      const encText = this.keys.encryptText(teamCtx.tenantId, fullReportMd)
      // AI 生成的报告存为草稿（待医生确认），只有医生本人确认后才是 confirmed；医生本人生成的直接确认
      const byAi = a.via !== 'user'
      teamCtx.db.db.prepare(
        'INSERT INTO records (id, patient_id, kind, title, report_date, text_enc, status, created_by, created_at, confirmed_by, confirmed_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        newRecId, patientId, 'report', reportTitle, examDate, encText,
        byAi ? 'pending' : 'confirmed', a.userId, now(), byAi ? null : a.userId, byAi ? null : now(), byAi ? 'ai_report' : 'platform_report',
      )
      savedRecordId = newRecId
      this.log(teamCtx, a, patientId, byAi ? 'ai_report_draft' : 'record_confirm', newRecId)
    }

    this.log(c, a, patientId, 'imaging_full_report', targetRec.id)

    return {
      ok: true,
      patient_id: patientId,
      patient_code: p.code,
      title: reportTitle,
      exam_date: examDate,
      modality,
      findings,
      impression,
      recommendations,
      full_report_markdown: fullReportMd,
      saved_record_id: savedRecordId,
      saved_status: savedRecordId ? (a.via !== 'user' ? 'pending' : 'confirmed') : undefined,
      metrics: {
        longest_diameter_mm: ld,
        short_axis_mm: sd,
        total_volume_cm3: vol,
        key_slice_index: keySlice,
        bar_max: barMax,
        ham_max_hu: hamMaxHu,
        is_ham: isHAM,
      },
      evidence,
    }
  }

  /** 后台提取：解密原文 → 每页文字 → 打码后交给模型 → 待确认的化验（带页码、原文核对结果）。 */
  private async runExtraction(tenantId: string, patientId: string, recordId: string, userId: string): Promise<void> {
    const db = this.dbs.get(tenantId)
    if (!db || !this.extractor?.complete) return
    const rec = db.db.prepare('SELECT * FROM records WHERE id = ?').get(recordId) as (RecordRow & { file_id: string }) | undefined
    if (!rec) return
    const set = (extraction: RecordRow['extraction'], note: string | null) => db.db.prepare('UPDATE records SET extraction = ?, extraction_note = ? WHERE id = ?').run(extraction, note, recordId)
    set('running', null)
    try {
      const f = db.db.prepare('SELECT name_enc, mime FROM files WHERE id = ?').get(rec.file_id) as { name_enc: string; mime: string }
      const name = this.keys.decryptText(tenantId, f.name_enc)!
      const bytes = this.keys.decrypt(tenantId, readFileSync(join(db.files, rec.file_id)))
      const pages = await this.extractor.pages(name, f.mime, bytes)
      if (pages.join('').trim().length < 20) { set('skipped', '没有识别出文字（照片不清楚？可以重新拍一张清晰的上传），或在审核里对照原件逐项添加'); return }
      db.db.prepare('UPDATE records SET text_enc = ? WHERE id = ?').run(this.keys.encryptText(tenantId, pages.join('\f')), recordId)
      const r = await extractReport(pages, this.extractor.complete)
      const date = rec.report_date ?? r.report_date
      const time = r.report_date && date === r.report_date ? r.report_time : null
      db.db.prepare("UPDATE records SET kind = CASE WHEN kind = 'other' THEN ? ELSE kind END, title = CASE WHEN title = '未命名报告' THEN ? ELSE title END, report_date = ?, report_time = ? WHERE id = ?").run(r.kind, r.title, date, time, recordId)
      const ins = db.db.prepare(`INSERT INTO labs (id, patient_id, record_id, test_key, test_name, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, collected_on, collected_at, status, source, locator, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'extracted', ?, ?, ?)`)
      for (const l of r.labs) {
        const parsed = parseValue(l.value)
        const flag = parsed.num === null ? (/[↑]|(?<![A-Za-z])H$/.test(l.value) ? 'H' : /[↓]|(?<![A-Za-z])L$/.test(l.value) ? 'L' : null)
          : l.ref_high !== null && parsed.num > l.ref_high ? 'H' : l.ref_low !== null && parsed.num < l.ref_low ? 'L' : null
        ins.run(rid('lb'), patientId, recordId, testKey(l.test_name), l.test_name, parsed.num, parsed.num === null ? l.value : null, l.unit, l.ref_low, l.ref_high, l.ref_text, flag, date, date && time ? `${date} ${time}` : null,
          JSON.stringify({ page: l.page, verified: l.verified }), userId, now())
      }
      const unverified = r.labs.filter(l => !l.verified).length
      set('done', [r.labs.length ? `提取到 ${r.labs.length} 项化验` : '没有提取到化验项', unverified ? `${unverified} 项在原文里没找到对应数字，请重点核对` : '', date ? '' : '报告上没找到日期，确认时请补填'].filter(Boolean).join('；'))
    } catch (err) {
      set('failed', `自动提取失败：${(err as Error).message.slice(0, 120)}。可以在审核里对照原件逐项添加`)
    }
  }

  /** 审核时对照原件补一项（自动提取漏了，或不能自动提取时）：挂在这份报告上，日期取报告日期，待确认。 */
  addRecordLab(a: Actor, patientId: string, recordId: string, input: Record<string, unknown>): LabRow {
    const { c } = this.requireTeam(a, patientId)
    const rec = c.db.db.prepare("SELECT * FROM records WHERE id = ? AND patient_id = ? AND status = 'pending'").get(recordId, patientId) as RecordRow | undefined
    if (!rec) throw new PatientError('not_found', '没有待确认的这份报告', 404)
    const lab = labInput({ ...input, collected_on: rec.report_date ?? '1900-01-01' })
    const id = rid('lb')
    c.db.db.prepare(`INSERT INTO labs (id, patient_id, record_id, test_key, test_name, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, collected_on, status, source, locator, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)`).run(id, patientId, recordId, testKey(lab.test_name), lab.test_name, lab.value_num, lab.value_text, lab.unit,
      lab.ref_low, lab.ref_high, lab.ref_text, flagOf(lab), rec.report_date, a.via === 'ai' ? 'ai' : 'manual', a.userId, now())
    this.log(c, a, patientId, 'lab_add', lab.test_name)
    return labOf(c.db.db.prepare('SELECT * FROM labs WHERE id = ?').get(id) as Record<string, unknown>)
  }

  /** 确认 / 驳回一份报告：确认时一并确认它的待确认化验（报告没有日期时必须补填）。 */
  resolveRecord(a: Actor, patientId: string, recordId: string, input: { accept: boolean; report_date?: unknown }): void {
    const { c } = this.requireTeam(a, patientId)
    this.noAiReview(a, c, input.accept ? '确认报告' : '驳回报告')
    const rec = c.db.db.prepare('SELECT * FROM records WHERE id = ? AND patient_id = ?').get(recordId, patientId) as RecordRow | undefined
    if (!rec) throw new PatientError('not_found', '报告不存在', 404)
    // AI 生成的报告草稿：不论机构设置，都只能由医生本人确认 / 驳回
    if (rec.origin === 'ai_report' && a.via !== 'user') throw new PatientError('needs_human_review', 'AI 生成的报告须医生本人确认', 403)
    if (!input.accept) {
      c.db.transaction(() => {
        c.db.db.prepare("UPDATE records SET status = 'rejected', confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(a.userId, now(), recordId)
        c.db.db.prepare("UPDATE labs SET status = 'rejected', confirmed_by = ?, confirmed_at = ? WHERE record_id = ? AND status = 'pending'").run(a.userId, now(), recordId)
        this.log(c, a, patientId, 'record_reject', recordId)
      })
      return
    }
    const date = typeof input.report_date === 'string' && DATE.test(input.report_date) ? input.report_date : rec.report_date
    const undated = (c.db.db.prepare("SELECT COUNT(*) AS n FROM labs WHERE record_id = ? AND status = 'pending' AND collected_on IS NULL").get(recordId) as { n: number }).n
    if (!date && undated) throw new PatientError('date_required', '这份报告没有日期，请填写报告上的日期（YYYY-MM-DD）')
    c.db.transaction(() => {
      c.db.db.prepare("UPDATE records SET status = 'confirmed', report_date = ?, confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(date, a.userId, now(), recordId)
      c.db.db.prepare("UPDATE labs SET collected_on = COALESCE(collected_on, ?) WHERE record_id = ? AND status = 'pending'").run(date, recordId)
      // 同日同项已有确认值：医生选了「替换」的，旧值标为已被更正；数值完全相同的（同一结果重复出现）去掉这条；其余都保留
      let dups = 0
      for (const l of (c.db.db.prepare("SELECT * FROM labs WHERE record_id = ? AND status = 'pending'").all(recordId) as Array<Record<string, unknown>>).map(labOf)) {
        if (l.replaces) { c.db.db.prepare("UPDATE labs SET status = 'superseded' WHERE id = ? AND patient_id = ? AND status = 'confirmed'").run(l.replaces, patientId); continue }
        const same = this.sameDay(c.db, patientId, l).find(o => o.std_value === l.std_value && o.value_text === l.value_text)
        if (same) { c.db.db.prepare("UPDATE labs SET status = 'rejected', confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(a.userId, now(), l.id); dups++ }
      }
      if (dups) this.log(c, a, patientId, 'lab_duplicate_skip', String(dups))
      c.db.db.prepare("UPDATE labs SET status = 'confirmed', confirmed_by = ?, confirmed_at = ? WHERE record_id = ? AND status = 'pending'").run(a.userId, now(), recordId)
      c.db.db.prepare('UPDATE patients SET updated_at = ? WHERE id = ?').run(now(), patientId)
      this.log(c, a, patientId, 'record_confirm', recordId)
    })
  }

  /** 改一条待确认的化验（审核时修正提取错误）。 */
  editLab(a: Actor, patientId: string, labId: string, input: Record<string, unknown>): LabRow {
    const { c } = this.requireTeam(a, patientId)
    const cur = c.db.db.prepare("SELECT * FROM labs WHERE id = ? AND patient_id = ? AND status = 'pending'").get(labId, patientId) as Record<string, unknown> | undefined
    if (!cur) throw new PatientError('not_found', '没有待确认的这条化验', 404)
    const merged = { test_name: cur.test_name, value: cur.value_num ?? cur.value_text, unit: cur.unit, ref_low: cur.ref_low, ref_high: cur.ref_high, ref_text: cur.ref_text, collected_on: cur.collected_on ?? '1900-01-01', ...input }
    const lab = labInput(merged)
    c.db.db.prepare('UPDATE labs SET test_key = ?, test_name = ?, value_num = ?, value_text = ?, unit = ?, ref_low = ?, ref_high = ?, ref_text = ?, flag = ?, collected_on = ? WHERE id = ?')
      .run(testKey(lab.test_name), lab.test_name, lab.value_num, lab.value_text, lab.unit, lab.ref_low, lab.ref_high, lab.ref_text, flagOf(lab), input.collected_on ? lab.collected_on : (cur.collected_on as string | null), labId)
    // 「用这个替换」同日同项的某条已确认值（null 取消）
    if (input.replaces !== undefined) {
      const target = input.replaces === null || input.replaces === '' ? null : String(input.replaces)
      if (target && !this.sameDay(c.db, patientId, labOf(c.db.db.prepare('SELECT * FROM labs WHERE id = ?').get(labId) as Record<string, unknown>)).some(o => o.id === target)) {
        throw new PatientError('bad_replaces', '只能替换同一天、同一项目的已确认化验')
      }
      c.db.db.prepare('UPDATE labs SET replaces = ? WHERE id = ?').run(target, labId)
    }
    this.log(c, a, patientId, 'lab_edit', labId)
    return labOf(c.db.db.prepare('SELECT * FROM labs WHERE id = ?').get(labId) as Record<string, unknown>)
  }

  // —— 关联文档（病例报告、随访小结……）——

  /** 把一份文档关联到患者（只能关联自己的文档；文档仍在作者自己的文档库里）。 */
  linkDoc(a: Actor, patientId: string, docId: string, kind: unknown = 'case_report'): void {
    const { c } = this.requireTeam(a, patientId)
    const doc = this.store.getDoc(docId)
    if (!doc || doc.owner !== a.userId || doc.deleted_at) throw new PatientError('not_found', '文档不存在', 404)
    if (doc.context && (JSON.parse(doc.context) as { kind?: string }).kind === 'study') throw new PatientError('in_study', '这份文档归在一个研究项目里，不能再关联到患者', 409)
    const k = kind === 'followup' || kind === 'discussion' || kind === 'archive' || kind === 'brief' || kind === 'other' ? kind : 'case_report'
    c.db.db.prepare('INSERT OR IGNORE INTO patient_docs (patient_id, doc_id, kind, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(patientId, docId, k, a.userId, now())
    // 属于患者的文档：不出现在文档列表里，打开时显示归属并能回到患者页
    const p = c.db.db.prepare('SELECT code FROM patients WHERE id = ?').get(patientId) as { code: string }
    // space / tenant_id：文档属于哪个空间的患者库（AI 在这份文档里的回合按它取空间，不能跨空间读）
    this.store.setDocContext(docId, { kind: 'patient', patient_id: patientId, code: p.code, doc_kind: k, space: a.space ?? 'work', tenant_id: c.tenantId })
    this.log(c, a, patientId, 'doc_link', docId)
  }

  unlinkDoc(a: Actor, patientId: string, docId: string): void {
    const { c } = this.requireTeam(a, patientId)
    const r = c.db.db.prepare('DELETE FROM patient_docs WHERE patient_id = ? AND doc_id = ? AND created_by = ?').run(patientId, docId, a.userId)
    if (Number(r.changes) > 0) this.store.setDocContext(docId, null)
    this.log(c, a, patientId, 'doc_unlink', docId)
  }

  /** 关联的文档（新的在前）；已删除的不列。作者以外的人能看到有这份报告，但只有作者能打开（文档共享是以后的事）。 */
  private documents(c: ReturnType<PatientService['ctx']>, patientId: string, viewer: string) {
    return (c.db.db.prepare('SELECT doc_id, kind, created_by, created_at FROM patient_docs WHERE patient_id = ? ORDER BY created_at DESC').all(patientId) as Array<{ doc_id: string; kind: string; created_by: string; created_at: string }>)
      .flatMap(r => {
        const d = this.store.getDoc(r.doc_id)
        if (!d || d.deleted_at) return []
        return [{ doc_id: r.doc_id, kind: r.kind, title: d.title, author: this.store.getUser(r.created_by)?.display_name ?? r.created_by, linked_at: r.created_at, updated_at: d.updated_at, can_open: d.owner === viewer }]
      })
  }

  /** 报告的文字（自动提取时保存的，已打码：姓名、证件号、电话、住院号等换成占位符）。给 AI 读报告用；人看原件。 */
  recordText(a: Actor, patientId: string, recordId: string): { title: string; kind: string; report_date: string | null; status: string; origin: string | null; text: string | null } {
    const { c } = this.visible(a, patientId)
    const r = c.db.db.prepare('SELECT title, kind, report_date, status, origin, text_enc FROM records WHERE id = ? AND patient_id = ?').get(recordId, patientId) as { title: string; kind: string; report_date: string | null; status: string; origin: string | null; text_enc: string | null } | undefined
    if (!r) throw new PatientError('not_found', '报告不存在', 404)
    const text = this.keys.decryptText(c.tenantId, r.text_enc)
    this.log(c, a, patientId, 'record_read', recordId)
    return { title: r.title, kind: r.kind, report_date: r.report_date, status: r.status, origin: r.origin ?? null, text: text === null ? null : redact(text).slice(0, 20000) }
  }

  // —— AI 提议 ——

  propose(a: Actor, patientId: string, input: { kind?: unknown; payload?: unknown; reason?: unknown }): ProposalRow {
    const { c } = this.visible(a, patientId)
    const kind = input.kind
    if (kind !== 'lab' && kind !== 'tag' && kind !== 'note' && kind !== 'update') throw new PatientError('bad_kind', 'kind 只能是 lab / tag / note / update')
    const payload = (input.payload && typeof input.payload === 'object' ? input.payload : {}) as Record<string, unknown>
    if (kind === 'lab') labInput(payload) // 先校验
    if (kind === 'tag' && (typeof payload.tag !== 'string' || !payload.tag.trim())) throw new PatientError('bad_payload', 'tag 需要 payload.tag')
    if (kind === 'note' && (typeof payload.text !== 'string' || !payload.text.trim())) throw new PatientError('bad_payload', 'note 需要 payload.text')
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 300) : ''
    if (!reason) throw new PatientError('reason_required', '请写明依据（来自哪份报告、哪一页）')
    return this.insertProposal(c, a, patientId, kind, payload, reason)
  }

  private insertProposal(c: ReturnType<PatientService['ctx']>, a: Actor, patientId: string, kind: ProposalRow['kind'], payload: Record<string, unknown>, reason: string): ProposalRow {
    const id = rid('pp')
    c.db.db.prepare('INSERT INTO proposals (id, patient_id, kind, payload, reason, turn_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, patientId, kind, JSON.stringify(payload), reason, a.turnId ?? null, 'pending', a.via === 'ai' ? `ai:${a.userId}` : a.userId, now())
    this.log(c, a, patientId, 'propose', kind)
    return proposalOf(c.db.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Record<string, unknown>)
  }

  private proposals(a: Actor, patientId: string, c: ReturnType<PatientService['ctx']>): ProposalRow[] {
    return (c.db.db.prepare("SELECT * FROM proposals WHERE patient_id = ? AND status = 'pending' ORDER BY created_at").all(patientId) as Array<Record<string, unknown>>).map(proposalOf)
  }

  /** 诊疗组成员采纳 / 驳回 AI 的提议。采纳化验 → 一条已确认的化验（来源记为 ai）。 */
  resolveProposal(a: Actor, patientId: string, proposalId: string, accept: boolean): void {
    if (a.via === 'ai') throw new PatientError('forbidden', 'AI 不能采纳自己的提议', 403)
    const { c, p } = this.requireTeam(a, patientId)
    const r = c.db.db.prepare("SELECT * FROM proposals WHERE id = ? AND patient_id = ? AND status = 'pending'").get(proposalId, patientId) as Record<string, unknown> | undefined
    if (!r) throw new PatientError('not_found', '没有这条待处理的提议', 404)
    const prop = proposalOf(r)
    if (accept) {
      if (prop.kind === 'lab') {
        const lab = this.addLab({ ...a, via: 'user' }, patientId, prop.payload)
        c.db.db.prepare("UPDATE labs SET source = 'ai' WHERE id = ?").run(lab.id)
      } else if (prop.kind === 'update') {
        this.update(a, patientId, prop.payload)
      } else if (prop.kind === 'enroll' || prop.kind === 'unenroll') {
        // 入组 / 移出只能由研究负责人确认（研究归个人；诊疗组的其他成员看得到提议，但不能替别人的研究做决定）
        const study = this.store.getStudy(String(prop.payload.study_id))
        if (!study || study.owner !== a.userId) throw new PatientError('forbidden', '只有研究负责人能确认入组 / 移出', 403)
        if (prop.kind === 'enroll') this.enrollOne(c, a, patientId, study.id, typeof prop.payload.criteria === 'string' ? prop.payload.criteria : null)
        else this.withdrawOne(c, a, patientId, study.id)
      } else if (prop.kind === 'tag') {
        this.update(a, patientId, { tags: [...new Set([...p.tags, String(prop.payload.tag).trim()])] })
      } else {
        const cur = this.keys.decryptText(c.tenantId, (c.db.db.prepare('SELECT summary_enc FROM patients WHERE id = ?').get(patientId) as { summary_enc: string | null }).summary_enc) ?? ''
        this.update(a, patientId, { summary: (cur ? cur + '\n' : '') + String(prop.payload.text).trim() })
      }
    }
    c.db.db.prepare('UPDATE proposals SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?').run(accept ? 'accepted' : 'rejected', a.userId, now(), proposalId)
    this.log(c, a, patientId, accept ? 'proposal_accept' : 'proposal_reject', proposalId)
  }

  // —— 研究入组（docs/design/COHORT.md）——
  // 研究归个人（平台库），入组关系与研究编号在机构患者库。调用方（research/cohort.ts）先确认研究属于操作者。
  // 只有诊疗组成员（负责人 / 成员）能把患者入组：机构全员可见、紧急访问都不行。

  /** 机构是否允许 AI 用患者数据（含由患者生成的研究数据集）；不允许时抛错。 */
  assertAi(a: Actor): void { this.ctx(a) }

  /** 按条件筛选「我在诊疗组里的」在管患者。只返回代号与匹配依据；命中的患者各记一条访问日志。 */
  screen(a: Actor, studyId: string, criteria: unknown): { criteria: Criteria; total: number; patients: Array<{ patient_id: string; code: string; sex: string | null; age: number | null; tags: string[]; matched: string[]; subject_id: string | null }> } {
    const c = this.ctx(a)
    const cr = parseCriteria(criteria)
    const rows = (c.db.db.prepare("SELECT p.* FROM patients p JOIN care_team t ON t.patient_id = p.id AND t.user_id = ? WHERE p.status = 'active' ORDER BY p.code").all(a.userId) as Array<Record<string, unknown>>).map(r => patientOf(r))
    const year = new Date().getUTCFullYear()
    const out = []
    for (const p of rows) {
      const labs = (c.db.db.prepare("SELECT * FROM labs WHERE patient_id = ? AND status = 'confirmed' ORDER BY collected_on, COALESCE(collected_at, collected_on), created_at").all(p.id) as Array<Record<string, unknown>>).map(labOf)
      const m = matchCriteria(cr, p, labs, year)
      if (!m) continue
      const enrolled = c.db.db.prepare("SELECT subject_id FROM enrollments WHERE study_id = ? AND patient_id = ? AND status = 'active'").get(studyId, p.id) as { subject_id: string } | undefined
      out.push({ patient_id: p.id, code: p.code, sex: p.sex, age: p.birth_year ? year - p.birth_year : null, tags: p.tags, matched: m, subject_id: enrolled?.subject_id ?? null })
      this.log(c, a, p.id, 'cohort_screen', `研究 ${studyId}`)
    }
    return { criteria: cr, total: out.length, patients: out }
  }

  /**
   * 入组。人：直接生效；AI：机构设为需医生确认（review）时每位患者一条「入组」提议，由研究负责人在患者页或研究页确认。
   * 已入组的跳过；之前移出过的恢复原研究编号。
   */
  enroll(a: Actor, studyId: string, patientIds: string[], criteria: unknown = null): { enrolled: Array<{ patient_id: string; subject_id: string }>; proposed: string[]; skipped: Array<{ patient_id: string; reason: string }> } {
    const res = { enrolled: [] as Array<{ patient_id: string; subject_id: string }>, proposed: [] as string[], skipped: [] as Array<{ patient_id: string; reason: string }> }
    const crit = criteria ? JSON.stringify(parseCriteria(criteria)) : null
    for (const pid of [...new Set(patientIds)].slice(0, 500)) {
      let c: ReturnType<PatientService['ctx']>
      try { c = this.requireTeam(a, pid).c } catch (err) {
        if (err instanceof PatientError && (err.code === 'not_found' || err.code === 'forbidden')) { res.skipped.push({ patient_id: pid, reason: err.code === 'forbidden' ? '不在诊疗组里，不能入组' : '患者不存在' }); continue }
        throw err
      }
      const cur = c.db.db.prepare('SELECT subject_id, status FROM enrollments WHERE study_id = ? AND patient_id = ?').get(studyId, pid) as { subject_id: string; status: string } | undefined
      if (cur?.status === 'active') { res.skipped.push({ patient_id: pid, reason: `已入组（${cur.subject_id}）` }); continue }
      if (this.aiReview(a, c)) {
        if (c.db.db.prepare("SELECT 1 FROM proposals WHERE patient_id = ? AND kind = 'enroll' AND status = 'pending' AND json_extract(payload, '$.study_id') = ?").get(pid, studyId)) { res.skipped.push({ patient_id: pid, reason: '已有待确认的入组提议' }); continue }
        const title = this.store.getStudy(studyId)?.title ?? ''
        this.insertProposal(c, a, pid, 'enroll', { study_id: studyId, study_title: title, criteria: crit }, `AI 建议入组研究「${title}」`)
        res.proposed.push(pid)
        continue
      }
      res.enrolled.push({ patient_id: pid, subject_id: this.enrollOne(c, a, pid, studyId, crit) })
    }
    return res
  }

  private enrollOne(c: ReturnType<PatientService['ctx']>, a: Actor, patientId: string, studyId: string, criteria: string | null): string {
    const cur = c.db.db.prepare('SELECT subject_id, status FROM enrollments WHERE study_id = ? AND patient_id = ?').get(studyId, patientId) as { subject_id: string; status: string } | undefined
    if (cur?.status === 'active') return cur.subject_id
    const subject = cur?.subject_id ?? c.db.nextSubject(studyId)
    c.db.db.prepare(`INSERT INTO enrollments (study_id, patient_id, subject_id, status, criteria, enrolled_by, enrolled_at) VALUES (?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(study_id, patient_id) DO UPDATE SET status = 'active', criteria = excluded.criteria, enrolled_by = excluded.enrolled_by, enrolled_at = excluded.enrolled_at, withdrawn_at = NULL`)
      .run(studyId, patientId, subject, criteria, a.userId, now())
    this.log(c, a, patientId, 'enroll', `研究 ${studyId} · ${subject}`)
    return subject
  }

  /** 移出研究（研究编号保留不复用；之后再入组恢复同一编号）。AI 在 review 模式下变成一条「移出」提议。 */
  unenroll(a: Actor, studyId: string, patientId: string): { result: 'withdrawn' | 'proposed' } {
    const c = this.ctx(a)
    const cur = c.db.db.prepare("SELECT subject_id FROM enrollments WHERE study_id = ? AND patient_id = ? AND status = 'active'").get(studyId, patientId) as { subject_id: string } | undefined
    if (!cur) throw new PatientError('not_found', '这位患者不在这个研究里', 404)
    if (this.aiReview(a, c)) {
      this.visible(a, patientId)
      this.insertProposal(c, a, patientId, 'unenroll', { study_id: studyId, study_title: this.store.getStudy(studyId)?.title ?? '', subject_id: cur.subject_id }, `AI 建议把 ${cur.subject_id} 移出研究`)
      return { result: 'proposed' }
    }
    this.withdrawOne(c, a, patientId, studyId)
    return { result: 'withdrawn' }
  }

  private withdrawOne(c: ReturnType<PatientService['ctx']>, a: Actor, patientId: string, studyId: string): void {
    const r = c.db.db.prepare("UPDATE enrollments SET status = 'withdrawn', withdrawn_at = ? WHERE study_id = ? AND patient_id = ? AND status = 'active'").run(now(), studyId, patientId)
    if (Number(r.changes)) this.log(c, a, patientId, 'unenroll', `研究 ${studyId}`)
  }

  /** 研究的入组名单（按研究编号）。代号只在操作者仍能看到这位患者时给出。另附待确认的入组 / 移出提议。 */
  enrollments(a: Actor, studyId: string): { subjects: Array<{ subject_id: string; patient_id: string; code: string | null; sex: string | null; age_at_enroll: number | null; tags: string[]; enrolled_at: string; status: string; withdrawn_at: string | null }>; pending: Array<{ proposal_id: string; patient_id: string; code: string | null; kind: string; reason: string; created_at: string }> } {
    const c = this.ctx(a)
    const rows = c.db.db.prepare('SELECT e.*, p.code, p.sex, p.birth_year, p.tags FROM enrollments e JOIN patients p ON p.id = e.patient_id WHERE e.study_id = ? ORDER BY e.subject_id').all(studyId) as Array<Record<string, unknown>>
    const canSee = (pid: string) => { try { this.visible(a, pid); return true } catch { return false } }
    const subjects = rows.map(r => ({
      subject_id: r.subject_id as string, patient_id: r.patient_id as string, code: canSee(r.patient_id as string) ? r.code as string : null, sex: (r.sex as string | null) ?? null,
      age_at_enroll: r.birth_year ? Number(String(r.enrolled_at).slice(0, 4)) - Number(r.birth_year) : null, tags: JSON.parse((r.tags as string) || '[]') as string[],
      enrolled_at: r.enrolled_at as string, status: r.status as string, withdrawn_at: (r.withdrawn_at as string | null) ?? null,
    }))
    const pending = (c.db.db.prepare("SELECT pr.*, p.code FROM proposals pr JOIN patients p ON p.id = pr.patient_id WHERE pr.status = 'pending' AND pr.kind IN ('enroll', 'unenroll') AND json_extract(pr.payload, '$.study_id') = ? ORDER BY pr.created_at").all(studyId) as Array<Record<string, unknown>>)
      .filter(r => canSee(r.patient_id as string))
      .map(r => ({ proposal_id: r.id as string, patient_id: r.patient_id as string, code: r.code as string, kind: r.kind as string, reason: r.reason as string, created_at: r.created_at as string }))
    return { subjects, pending }
  }

  /** 患者所在的研究（患者页概况显示）。 */
  private studiesOf(c: ReturnType<PatientService['ctx']>, patientId: string): Array<{ study_id: string; title: string; subject_id: string; enrolled_at: string }> {
    return (c.db.db.prepare("SELECT study_id, subject_id, enrolled_at FROM enrollments WHERE patient_id = ? AND status = 'active' ORDER BY enrolled_at").all(patientId) as Array<{ study_id: string; subject_id: string; enrolled_at: string }>)
      .flatMap(e => { const s = this.store.getStudy(e.study_id); return s ? [{ ...e, title: s.title }] : [] })
  }

  /**
   * 研究数据集的快照：入组中的受试者（研究编号、性别、入组时年龄、标签）与所选化验项目的已确认值（标准单位）。
   * 只含操作者仍在诊疗组里的受试者（其余列在 skipped）。fingerprint 随入组名单、受试者信息、相关化验的变化而变（判断数据集是否过期）。
   * log=true 时每位受试者记一条访问日志（生成数据集时）。
   */
  cohortSnapshot(a: Actor, studyId: string, opts: { tests?: string[]; from?: string | null; to?: string | null; log?: boolean } = {}) {
    const c = this.ctx(a)
    const rows = c.db.db.prepare("SELECT e.subject_id, e.enrolled_at, p.* FROM enrollments e JOIN patients p ON p.id = e.patient_id WHERE e.study_id = ? AND e.status = 'active' ORDER BY e.subject_id").all(studyId) as Array<Record<string, unknown>>
    const keys = opts.tests?.length ? new Set(opts.tests.map(testKey)) : null
    const subjects: Array<{ subject_id: string; sex: string | null; age_at_enroll: number | null; tags: string[]; enrolled_on: string; labs: LabRow[]; imaging?: Array<{ id: string; report_date: string | null; payload: Record<string, unknown> }>; vars: Record<string, SubjectVar> }> = []
    const skipped: string[] = []
    const fp = createHash('sha256')
    for (const r of rows) {
      const pid = r.id as string
      if (!this.teamRole(c.db, pid, a.userId)) { skipped.push(r.subject_id as string); continue }
      // 知家手工录入的化验挂不上报告记录（没有原件可追溯），不进研究数据集
      const where = ["patient_id = ?", "status = 'confirmed'", 'record_id IS NOT NULL']
      const args: string[] = [pid]
      if (opts.from && DATE.test(opts.from)) { where.push('collected_on >= ?'); args.push(opts.from) }
      if (opts.to && DATE.test(opts.to)) { where.push('collected_on <= ?'); args.push(opts.to) }
      let labs = (c.db.db.prepare(`SELECT * FROM labs WHERE ${where.join(' AND ')} ORDER BY test_key, collected_on, COALESCE(collected_at, collected_on), created_at`).all(...args) as Array<Record<string, unknown>>).map(labOf)
      if (keys) labs = labs.filter(l => keys.has(l.test_key))

      const imgWhere = ["patient_id = ?", "kind = 'imaging'", "status = 'confirmed'"]
      const imgArgs: string[] = [pid]
      if (opts.from && DATE.test(opts.from)) { imgWhere.push('report_date >= ?'); imgArgs.push(opts.from) }
      if (opts.to && DATE.test(opts.to)) { imgWhere.push('report_date <= ?'); imgArgs.push(opts.to) }
      const imgRows = (c.db.db.prepare(`SELECT id, report_date, text_enc FROM records WHERE ${imgWhere.join(' AND ')} ORDER BY report_date ASC, created_at ASC`).all(...imgArgs) as Array<Record<string, unknown>>).map(ir => {
        const enc = ir.text_enc as string | null
        const dec = enc ? this.keys.decryptText(c.tenantId, enc) : null
        let payload: Record<string, unknown> = {}
        try { payload = dec ? JSON.parse(dec) : {} } catch {}
        return { id: ir.id as string, report_date: ir.report_date as string | null, payload }
      })

      const vars: Record<string, SubjectVar> = {}
      for (const v of c.db.db.prepare('SELECT * FROM subject_vars WHERE study_id = ? AND patient_id = ?').all(studyId, pid) as Array<Record<string, unknown>>) vars[v.var_id as string] = subjectVarOf(r.subject_id as string, v)

      const p = patientOf(r)
      const s = { subject_id: r.subject_id as string, sex: p.sex, age_at_enroll: p.birth_year ? Number(String(r.enrolled_at).slice(0, 4)) - p.birth_year : null, tags: p.tags, enrolled_on: String(r.enrolled_at).slice(0, 10), labs, imaging: imgRows, vars }
      subjects.push(s)
      fp.update(JSON.stringify([s.subject_id, s.sex, p.birth_year, s.tags, labs.map(l => [l.id, l.value_num, l.unit, l.collected_on])]))
      if (imgRows.length > 0) fp.update(JSON.stringify(imgRows.map(i => [i.id, i.report_date])))
      // 研究数据集含已核实的 SMI：核实状态或值变化时数据集应过期（没有已核实 SMI 时不改变指纹）
      if (vars.l3_smi?.status === 'verified') fp.update(JSON.stringify(['l3_smi', vars.l3_smi.value, vars.l3_smi.verified_at]))
      if (opts.log) this.log(c, a, pid, 'cohort_export', `研究 ${studyId} · ${s.subject_id}`)
    }
    fp.update(JSON.stringify(skipped))
    return { subjects, skipped, fingerprint: fp.digest('hex').slice(0, 24) }
  }

  // —— 研究变量（来源与核实状态）——

  /**
   * 写入研究变量。值为 null 时删除该项（不补值）。写入或改值后状态一律回到 unverified，
   * 不论是人还是 AI 写的；核实只能经 verifySubjectVars 由研究者本人完成。
   * 调用方（research/subject-vars.ts）负责校验变量与来源是否匹配、研究写权限。
   */
  setSubjectVars(a: Actor, studyId: string, rows: SubjectVarInput[]): { written: number; cleared: number; skipped: Array<{ subject_id: string; var_id: string; reason: string }> } {
    const c = this.ctx(a)
    return c.db.transaction(() => {
      const out = { written: 0, cleared: 0, skipped: [] as Array<{ subject_id: string; var_id: string; reason: string }> }
      const pidOf = new Map<string, string | null>()
      const resolve = (subjectId: string): string | null => {
        if (pidOf.has(subjectId)) return pidOf.get(subjectId)!
        const e = c.db.db.prepare("SELECT patient_id FROM enrollments WHERE study_id = ? AND subject_id = ? AND status = 'active'").get(studyId, subjectId) as { patient_id: string } | undefined
        const pid = e && this.teamRole(c.db, e.patient_id, a.userId) ? e.patient_id : null
        pidOf.set(subjectId, pid)
        return pid
      }
      const upsert = c.db.db.prepare(`INSERT INTO subject_vars (study_id, patient_id, var_id, value_num, value_text, source, source_ref, method, status, entered_by, entered_via, entered_at, verified_by, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?, ?, NULL, NULL)
        ON CONFLICT(study_id, patient_id, var_id) DO UPDATE SET value_num = excluded.value_num, value_text = excluded.value_text, source = excluded.source, source_ref = excluded.source_ref,
          method = excluded.method, status = 'unverified', entered_by = excluded.entered_by, entered_via = excluded.entered_via, entered_at = excluded.entered_at, verified_by = NULL, verified_at = NULL`)
      const del = c.db.db.prepare('DELETE FROM subject_vars WHERE study_id = ? AND patient_id = ? AND var_id = ?')
      const touched = new Set<string>()
      for (const r of rows) {
        const pid = resolve(r.subject_id)
        if (!pid) { out.skipped.push({ subject_id: r.subject_id, var_id: r.var_id, reason: '受试者不在本研究，或你不在其诊疗组' }); continue }
        if (r.value === null) {
          if (Number(del.run(studyId, pid, r.var_id).changes)) out.cleared++
        } else {
          upsert.run(studyId, pid, r.var_id, typeof r.value === 'number' ? r.value : null, typeof r.value === 'string' ? r.value : null,
            r.source, JSON.stringify(r.source_ref ?? {}), r.method ?? null, a.userId, a.via, now())
          out.written++
        }
        touched.add(pid)
      }
      for (const pid of touched) this.log(c, a, pid, 'study_var_set', `研究 ${studyId}`)
      return out
    })
  }

  /** 核实研究变量：只有研究者本人（非 AI）可以；记录核实人与时间。返回核实条数。 */
  verifySubjectVars(a: Actor, studyId: string, items: Array<{ subject_id: string; var_id: string }>): { verified: number } {
    if (a.via !== 'user') throw new PatientError('forbidden', 'AI 不能核实研究变量，需研究者本人确认', 403)
    const c = this.ctx(a)
    return c.db.transaction(() => {
      const stmt = c.db.db.prepare(`UPDATE subject_vars SET status = 'verified', verified_by = ?, verified_at = ?
        WHERE study_id = ? AND var_id = ? AND status = 'unverified' AND patient_id = (SELECT patient_id FROM enrollments WHERE study_id = ? AND subject_id = ? AND status = 'active')`)
      let verified = 0
      const at = now()
      for (const it of items) {
        const e = c.db.db.prepare("SELECT patient_id FROM enrollments WHERE study_id = ? AND subject_id = ? AND status = 'active'").get(studyId, it.subject_id) as { patient_id: string } | undefined
        if (!e || !this.teamRole(c.db, e.patient_id, a.userId)) continue
        const n = Number(stmt.run(a.userId, at, studyId, it.var_id, studyId, it.subject_id).changes)
        if (n) { verified += n; this.log(c, a, e.patient_id, 'study_var_verify', `研究 ${studyId} · ${it.var_id}`) }
      }
      return { verified }
    })
  }

  /** 研究变量清单（只含操作者在诊疗组里的在组受试者）。 */
  subjectVars(a: Actor, studyId: string): SubjectVar[] {
    const c = this.ctx(a)
    const rows = c.db.db.prepare("SELECT v.*, e.subject_id FROM subject_vars v JOIN enrollments e ON e.study_id = v.study_id AND e.patient_id = v.patient_id AND e.status = 'active' WHERE v.study_id = ? ORDER BY e.subject_id, v.var_id").all(studyId) as Array<Record<string, unknown>>
    return rows.filter(r => this.teamRole(c.db, r.patient_id as string, a.userId)).map(r => subjectVarOf(r.subject_id as string, r))
  }

  /** 研究删除时清掉入组关系与待确认的入组提议（研究编号随研究一起作废）。 */
  dropStudy(a: Actor, studyId: string): void {
    let c: ReturnType<PatientService['ctx']>
    try { c = this.ctx(a) } catch { return }
    c.db.transaction(() => {
      for (const r of c.db.db.prepare("SELECT patient_id FROM enrollments WHERE study_id = ? AND status = 'active'").all(studyId) as Array<{ patient_id: string }>) this.log(c, a, r.patient_id, 'unenroll', `研究 ${studyId} 已删除`)
      c.db.db.prepare('DELETE FROM enrollments WHERE study_id = ?').run(studyId)
      c.db.db.prepare('DELETE FROM subject_vars WHERE study_id = ?').run(studyId)
      c.db.db.prepare("UPDATE proposals SET status = 'rejected', resolved_by = ?, resolved_at = ? WHERE status = 'pending' AND kind IN ('enroll', 'unenroll') AND json_extract(payload, '$.study_id') = ?").run(a.userId, now(), studyId)
      c.db.db.prepare('DELETE FROM seq WHERE name = ?').run(`subject:${studyId}`)
    })
  }

  /** 关掉所有库连接（测试 / 停机）。 */
  close(): void { for (const d of this.dbs.values()) d.close(); this.dbs.clear() }
}

// —— 输入校验 ——

function sex(v: unknown): 'M' | 'F' | null {
  return v === 'M' || v === 'F' ? v : v === '男' ? 'M' : v === '女' ? 'F' : null
}
/** 称呼（家人档案里的叫法，如「妈妈」「宝宝」；不要求实名，留空 = 沿用代号）。 */
function name(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim().slice(0, 24)
  return s || null
}
function birthYear(v: unknown): number | null {
  const n = Number(v)
  if (v === null || v === undefined || v === '') return null
  if (!Number.isInteger(n) || n < 1900 || n > new Date().getFullYear()) throw new PatientError('bad_birth_year', '出生年份不对')
  return n
}
function tags(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is string => typeof x === 'string').map(x => x.trim().slice(0, 40)).filter(Boolean))].slice(0, 20)
}
function labInput(v: Record<string, unknown>) {
  const name = typeof v.test_name === 'string' ? v.test_name.trim().slice(0, 60) : ''
  if (!name) throw new PatientError('bad_lab', '化验项目名不能为空')
  const date = typeof v.collected_on === 'string' ? v.collected_on.trim() : ''
  if (!DATE.test(date)) throw new PatientError('bad_lab', '化验日期要写成 YYYY-MM-DD（报告上的日期）')
  const num = (x: unknown) => x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x)
  const value_num = num(v.value)
  const value_text = value_num === null && typeof v.value === 'string' && v.value.trim() ? v.value.trim().slice(0, 60) : (typeof v.value_text === 'string' ? v.value_text.slice(0, 60) : null)
  if (value_num === null && !value_text) throw new PatientError('bad_lab', '化验值不能为空')
  const locator = v.locator && typeof v.locator === 'object' ? v.locator as LabRow['locator'] : null
  return {
    test_name: name, value_num, value_text, unit: typeof v.unit === 'string' ? v.unit.trim().slice(0, 20) || null : null,
    ref_low: num(v.ref_low), ref_high: num(v.ref_high), ref_text: typeof v.ref_text === 'string' ? v.ref_text.slice(0, 60) : null, collected_on: date, locator,
  }
}
/** 报告上的数值：「141」「141↑」「141 H」→ 数值 141；「<0.5」「阴性」→ 文字。 */
function parseValue(v: string): { num: number | null } {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:[↑↓]|[HL](?![A-Za-z]))?\s*$/.exec(v)
  return { num: m ? Number(m[1]) : null }
}

function flagOf(l: ReturnType<typeof labInput>): 'H' | 'L' | null {
  if (l.value_num === null) return null
  if (l.ref_high !== null && l.value_num > l.ref_high) return 'H'
  if (l.ref_low !== null && l.value_num < l.ref_low) return 'L'
  return null
}

// —— 入组筛选条件 ——

export type LabOp = '>' | '>=' | '<' | '<=' | '='
export interface LabCriterion { test: string; test_key: string; mode: 'latest' | 'any'; op: LabOp; value: number }
export interface LabChangeCriterion {
  test: string
  test_key: string
  change_type: 'diff' | 'pct' // diff = latest - baseline, pct = ((latest - baseline) / Math.abs(baseline)) * 100
  op: LabOp
  value: number
}
export interface Criteria {
  sex: 'M' | 'F' | null; age_min: number | null; age_max: number | null
  /** 诊断标签包含其中任一（不分大小写、部分匹配） */
  tags_any: string[]
  /** 排除标签：包含其中任一即排除（不分大小写、部分匹配） */
  tags_exclude: string[]
  /** 化验条件（都要满足）；用换算到标准单位后的已确认值 */
  labs: LabCriterion[]
  /** 化验指标动态变化条件（例如 ALT 下降幅度 >= 30% 或肌酐上升绝对值 >= 50） */
  lab_changes: LabChangeCriterion[]
  /** 报告日期窗口：只看这段时间内的化验；只给窗口时要求窗口内至少有一次化验 */
  from: string | null; to: string | null
}

const OPS: LabOp[] = ['>', '>=', '<', '<=', '=']
export function parseCriteria(v: unknown): Criteria {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null
  const date = (x: unknown) => typeof x === 'string' && DATE.test(x) ? x : null
  const labs = (Array.isArray(o.labs) ? o.labs : []).slice(0, 10).map(x => {
    const l = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const test = typeof l.test === 'string' ? l.test.trim() : ''
    const op = OPS.includes(l.op as LabOp) ? l.op as LabOp : null
    const value = num(l.value)
    if (!test || !op || value === null) throw new PatientError('bad_criteria', '化验条件要有项目、比较符（> >= < <= =）和数值')
    return { test, test_key: testKey(test), mode: l.mode === 'any' ? 'any' as const : 'latest' as const, op, value }
  })
  const lab_changes = (Array.isArray(o.lab_changes) ? o.lab_changes : []).slice(0, 10).map(x => {
    const l = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
    const test = typeof l.test === 'string' ? l.test.trim() : ''
    const op = OPS.includes(l.op as LabOp) ? l.op as LabOp : null
    const change_type = l.change_type === 'pct' ? 'pct' as const : 'diff' as const
    const value = num(l.value)
    if (!test || !op || value === null) throw new PatientError('bad_criteria', '化验变化条件要有项目、比较符（> >= < <= =）和数值')
    return { test, test_key: testKey(test), change_type, op, value }
  })
  return {
    sex: o.sex === 'M' || o.sex === 'F' ? o.sex : null, age_min: num(o.age_min), age_max: num(o.age_max),
    tags_any: (Array.isArray(o.tags_any) ? o.tags_any : []).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim()).slice(0, 20),
    tags_exclude: (Array.isArray(o.tags_exclude) ? o.tags_exclude : []).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim()).slice(0, 20),
    labs, lab_changes, from: date(o.from), to: date(o.to),
  }
}

const cmp = (a: number, op: LabOp, b: number) => op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : op === '<=' ? a <= b : Math.abs(a - b) < 1e-9

/** 符合条件时返回匹配依据（给医生核对），不符合返回 null。labs：这位患者的已确认化验（按日期升序）。 */
export function matchCriteria(cr: Criteria, p: PatientRow, labs: LabRow[], year: number): string[] | null {
  const why: string[] = []
  if (cr.sex) { if (p.sex !== cr.sex) return null; why.push(cr.sex === 'M' ? '男' : '女') }
  if (cr.age_min !== null || cr.age_max !== null) {
    if (!p.birth_year) return null
    const age = year - p.birth_year
    if ((cr.age_min !== null && age < cr.age_min) || (cr.age_max !== null && age > cr.age_max)) return null
    why.push(`${age} 岁`)
  }
  if (cr.tags_exclude.length) {
    const excluded = p.tags.find(t => cr.tags_exclude.some(q => t.toLowerCase().includes(q.toLowerCase())))
    if (excluded) return null
  }
  if (cr.tags_any.length) {
    const hit = p.tags.find(t => cr.tags_any.some(q => t.toLowerCase().includes(q.toLowerCase())))
    if (!hit) return null
    why.push(`标签「${hit}」`)
  }
  const inWin = labs.filter(l => l.collected_on && (!cr.from || l.collected_on >= cr.from) && (!cr.to || l.collected_on <= cr.to))
  if ((cr.from || cr.to) && !cr.labs.length && !cr.lab_changes.length) {
    if (!inWin.length) return null
    why.push(`窗口内 ${inWin.length} 次化验`)
  }
  for (const q of cr.labs) {
    const vals = inWin.filter(l => l.test_key === q.test_key && l.std_value !== null)
    if (!vals.length) return null
    const pick = q.mode === 'latest' ? [vals[vals.length - 1]!] : vals
    const hit = pick.find(l => cmp(l.std_value!, q.op, q.value))
    if (!hit) return null
    why.push(`${hit.test_name} ${hit.std_value}${hit.std_unit ? ' ' + hit.std_unit : ''}（${hit.collected_on}${q.mode === 'latest' ? '，最近一次' : ''}）`)
  }
  for (const q of cr.lab_changes) {
    const vals = inWin.filter(l => l.test_key === q.test_key && l.std_value !== null)
    if (vals.length < 2) return null
    const first = vals[0]!, last = vals[vals.length - 1]!
    const baseVal = first.std_value!, lastVal = last.std_value!
    let calculated = 0
    if (q.change_type === 'pct') {
      if (Math.abs(baseVal) < 1e-9) return null
      calculated = ((lastVal - baseVal) / Math.abs(baseVal)) * 100
    } else {
      calculated = lastVal - baseVal
    }
    if (!cmp(calculated, q.op, q.value)) return null
    const unit = last.std_unit ? ` ${last.std_unit}` : ''
    const sign = calculated >= 0 ? '+' : ''
    const changeStr = q.change_type === 'pct' ? `${sign}${calculated.toFixed(1)}%` : `${sign}${calculated.toFixed(2)}${unit}`
    why.push(`${last.test_name} 变化 ${changeStr}（基线 ${baseVal} → 最近 ${lastVal}）`)
  }
  return why
}

// —— 研究变量 ——

export type SubjectVarSource = 'dataset_import' | 'ecrf_manual' | 'imaging_analysis'

export interface SubjectVarInput {
  subject_id: string
  var_id: string
  /** null = 删除（不补值） */
  value: number | string | null
  source: SubjectVarSource
  /** 来源引用：数据集 id / 列名，影像分析记录 id 等 */
  source_ref?: Record<string, unknown>
  /** 测量 / 算法方法说明（影像变量必填） */
  method?: string | null
}

export interface SubjectVar {
  subject_id: string
  var_id: string
  value: number | string | null
  source: SubjectVarSource
  source_ref: Record<string, unknown>
  method: string | null
  status: 'unverified' | 'verified'
  entered_by: string
  entered_via: 'user' | 'ai'
  entered_at: string
  verified_by: string | null
  verified_at: string | null
}

function subjectVarOf(subjectId: string, r: Record<string, unknown>): SubjectVar {
  let ref: Record<string, unknown> = {}
  try { ref = JSON.parse((r.source_ref as string) || '{}') } catch {}
  return {
    subject_id: subjectId, var_id: r.var_id as string,
    value: r.value_num !== null && r.value_num !== undefined ? Number(r.value_num) : (r.value_text as string | null) ?? null,
    source: r.source as SubjectVarSource, source_ref: ref, method: (r.method as string | null) ?? null,
    status: r.status === 'verified' ? 'verified' : 'unverified',
    entered_by: r.entered_by as string, entered_via: r.entered_via === 'ai' ? 'ai' : 'user', entered_at: r.entered_at as string,
    verified_by: (r.verified_by as string | null) ?? null, verified_at: (r.verified_at as string | null) ?? null,
  }
}

// —— RECIST 1.1 分类（收紧）——

export type RecistCategory = 'CR' | 'PR' | 'SD' | 'PD' | 'NA'
export const RECIST_NOTE = '按 RECIST 1.1 阈值计算，未经阅片确认'

const finiteOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 一次检查的靶病灶长径：优先 target_lesions 数组，否则单个 longest_diameter_mm；缺测为 null */
function lesionDiameters(m: Record<string, any>): Array<number | null> {
  if (Array.isArray(m.target_lesions)) return m.target_lesions.map((l: any) => finiteOrNull(l?.longest_diameter_mm ?? l?.diameter_mm))
  const one = finiteOrNull(m.longest_diameter_mm)
  return one === null ? [] : [one]
}

/** 两次检查的测量方法描述（分析模型、模态、层厚）；缺模型记录时返回 null */
function measurementMethod(img: Record<string, any>, m: Record<string, any>): { model: string; modality: string | null; thickness: number | null } | null {
  const model = img.model_id ? String(img.model_id) : null
  if (!model) return null
  const qc = m.quality_control ?? {}
  return { model, modality: img.modality ? String(img.modality) : null, thickness: finiteOrNull(qc.slice_thickness_mm ?? m.slice_thickness_mm ?? img.slice_thickness_mm) }
}

/**
 * RECIST 1.1：仅当基线有 ≥ 10 mm 的可测量靶病灶、随访有对应测值、两次测量方法一致时才分类；
 * 按全部靶病灶直径总和计算；随访有新发病灶记录时判 PD。参照点为基线（平台没有既往最低值记录）。
 */
export function assessRecist(bm: Record<string, any>, fm: Record<string, any>, bImg: Record<string, any>, fImg: Record<string, any>): { category: RecistCategory; name: string; reason: string | null; detail: string } {
  const na = (reason: string) => ({ category: 'NA' as const, name: '不适用', reason, detail: reason })
  const base = lesionDiameters(bm)
  if (!base.length || base.some(v => v === null)) return na('基线没有靶病灶长径测值')
  const targets = base.map((v, i) => ({ v: v!, i })).filter(t => t.v >= 10)
  if (!targets.length) return na('基线没有 ≥ 10 mm 的可测量靶病灶')
  const fol = lesionDiameters(fm)
  if (targets.some(t => fol[t.i] === null || fol[t.i] === undefined)) return na('随访缺少对应靶病灶的长径测值')
  const mb = measurementMethod(bImg, bm), mf = measurementMethod(fImg, fm)
  if (!mb || !mf) return na('缺少测量方法记录，无法确认两次测量方法一致')
  const diffs: string[] = []
  if (mb.model !== mf.model) diffs.push(`分析模型 ${mb.model} / ${mf.model}`)
  if (mb.modality && mf.modality && mb.modality !== mf.modality) diffs.push(`模态 ${mb.modality} / ${mf.modality}`)
  if (mb.thickness !== null && mf.thickness !== null && mb.thickness !== mf.thickness) diffs.push(`层厚 ${mb.thickness} / ${mf.thickness} mm`)
  if (diffs.length) return na(`两次测量方法不一致（${diffs.join('；')}）`)

  const sumB = Math.round(targets.reduce((n, t) => n + t.v, 0) * 10) / 10
  const sumF = Math.round(targets.reduce((n, t) => n + (fol[t.i] as number), 0) * 10) / 10
  const diff = Math.round((sumF - sumB) * 10) / 10
  const pct = Math.round((diff / sumB) * 1000) / 10
  const newLesion = fm.new_lesions === true || (finiteOrNull(fm.new_lesion_count) ?? 0) > 0
  const detail = `${targets.length} 个基线 ≥ 10 mm 靶病灶的直径总和由 ${sumB} mm 变为 ${sumF} mm（${pct > 0 ? '+' : ''}${pct}%，${diff > 0 ? '+' : ''}${diff} mm）${newLesion ? '；随访记录有新发病灶' : ''}；以基线为参照（无既往最低值记录）。`
  const named = (c: RecistCategory, zh: string) => ({ category: c, name: `${c}（${zh}）`, reason: null, detail })
  if (newLesion) return named('PD', '疾病进展：新发病灶')
  if (sumF === 0) return named('CR', '完全缓解')
  if (pct <= -30) return named('PR', '部分缓解')
  if (pct >= 20 && diff >= 5) return named('PD', '疾病进展')
  return named('SD', '疾病稳定')
}
