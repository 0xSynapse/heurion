import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cleanBibText } from '../literature/format.ts'

/**
 * 平台存储（PLATFORM.md §3 存储层）：
 * - docs.state：当前 Yjs 状态（每次提交后整体写回；P0 文档规模下足够）
 * - op_log / node_changes：只增的操作日志与节点级变更索引（冲突守卫用）
 * - versions：用户可见的版本快照（Yjs 状态）
 * - node_src：导入时保留的原始 OOXML（修补式导出用）
 */

export type DocKind = 'doc' | 'deck'
export type Actor = 'ai' | 'user' | 'system'
export type VersionSource = 'create' | 'import' | 'turn' | 'user' | 'restore'

/** AI 发起、等用户确认的操作（高风险：不可恢复的删除、权限与安全设置、以机构身份对外的标识）。 */
export interface PendingActionRow {
  id: string; user_id: string; tool: string; action: string; method: string; path: string
  /** JSON：请求体（文件类为 {file: {path, name, mime}}） */
  body: string | null
  summary: string; reason: string | null
  /** JSON：确认时用户可以改的字段（例如紧急访问理由） */
  editable: string | null
  doc_id: string | null; turn_id: string | null
  status: 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'expired'
  result: string | null; created_at: string; decided_at: string | null; decided_by: string | null
}

export interface UserRow {
  id: string
  username: string
  display_name: string
  password_hash: string
  role: 'user' | 'admin'
  status: 'active' | 'disabled'
  /** 令牌版本：停用、改密码、强制下线时加一，旧令牌立即失效。 */
  token_version: number
  created_at: string
  last_login_at: string | null
  /** 从 1.0 导入时的原用户 id。 */
  imported_from: string | null
  /** 已验证的邮箱（找回密码用）；未绑定为 null。 */
  email: string | null
  /** 专属工作邮箱前缀（如 hz -> hz@heurion.org）；未设置为 null。 */
  work_email_prefix: string | null
  /** 工作空间（机构）：加入了医院就是医院，否则是个人空间。工作台（/app）的患者、研究、科室、机构模板按它走。 */
  tenant_id: string | null
  /** 个人空间（知家的家人档案所在）。加入医院后保留；为 null 时知家用到再建（纯医院账号）。docs/design/TENANCY.md §双重身份 */
  personal_tenant_id: string | null
  /** 在租户里的角色：admin 机构管理员 / member 成员。role=admin 是平台运营（与租户角色无关）。 */
  tenant_role: 'admin' | 'member'
}

/** 租户（机构）：医院、科室、课题组；个人注册的用户各有一个个人租户。设计见 docs/design/TENANCY.md。 */
export interface TenantRow {
  id: string; name: string; kind: 'personal' | 'org'; status: 'active' | 'suspended'
  /** 机构设置（JSON）：见 TenantSettings */
  settings: string
  created_at: string; created_by: string | null
}

export interface MailAttachment {
  id: string
  name: string
  size: number
  mime: string
  data_base64?: string
  url?: string
}

export interface MailMessageRow {
  id: string
  user_id: string
  tenant_id: string | null
  sender: string
  sender_name: string
  recipient: string
  subject: string
  body: string
  category: 'followup' | 'research' | 'notification' | 'general'
  patient_id: string | null
  patient_code: string | null
  study_id: string | null
  study_title: string | null
  read: number
  starred: number
  calendar_event_id: string | null
  folder: 'inbox' | 'sent' | 'trash'
  delivery_status: 'delivered' | 'external_sent' | 'simulated' | 'failed' | null
  delivery_note: string | null
  thread_id?: string | null
  in_reply_to?: string | null
  attachments?: string | null
  created_at: string
}


export interface CalendarEventRow {
  id: string
  user_id: string
  tenant_id: string | null
  title: string
  description: string | null
  start_time: string
  end_time: string
  all_day: number
  category: 'followup' | 'research' | 'meeting' | 'general'
  status: 'scheduled' | 'completed' | 'cancelled'
  patient_id: string | null
  patient_code: string | null
  study_id: string | null
  study_title: string | null
  location: string | null
  mail_id: string | null
  created_at: string
  updated_at: string
}

export interface TenantInviteRow {
  code: string; tenant_id: string; role: 'admin' | 'member'; email: string | null; created_by: string
  /** 按用户名邀请的已有账户（只有这个人能接受）；链接邀请为 null */
  target_user_id: string | null
  created_at: string; expires_at: string; used_by: string | null; used_at: string | null; revoked_at: string | null
}

export interface DocRow {
  id: string
  owner: string
  title: string
  kind: DocKind
  rev: number
  created_at: string
  updated_at: string
  /** 所在项目（文件夹）；null 为未分组。 */
  project_id: string | null
  /** 进了回收站的时间；null 为正常文档。 */
  deleted_at: string | null
  /** 归属（JSON）：属于某位患者的文档（病例报告等）为 {"kind":"patient","patient_id","code"}，不出现在文档列表与文档搜索里；null 为普通文档。 */
  context: string | null
}

export type KbStatus = 'pending' | 'extracting' | 'ocr' | 'embedding' | 'ready' | 'failed'

/** 参考资料库里的一份资料（R2）。 */
export interface KbFileRow {
  id: string
  owner: string
  project_id: string | null
  name: string
  mime: string
  size: number
  sha256: string
  status: KbStatus
  /** 失败原因 / 提示（扫描件没有文字层等）。 */
  note: string | null
  pages: number
  chunks: number
  /** 已向量化的块数（嵌入服务不可用时为 0，仍可关键词检索）。 */
  embedded: number
  doi: string | null
  pmid: string | null
  created_at: string
}

export type MemoryKind = 'preference' | 'fact' | 'style' | 'term'
export type MemoryStatus = 'proposed' | 'active' | 'rejected' | 'archived'

/** R3 记忆：一条用户偏好 / 事实 / 写法 / 术语。 */
export interface MemoryRow {
  id: string
  owner: string
  scope: 'global' | 'project'
  project_id: string | null
  kind: MemoryKind
  content: string
  /** AI 提议时给的理由。 */
  reason: string | null
  source: 'turn' | 'comment' | 'manual' | 'import' | 'review'
  source_doc_id: string | null
  source_turn_id: string | null
  status: MemoryStatus
  /** 用户在对话里明确要求记住（直接生效）。 */
  explicit: number
  created_at: string
  updated_at: string
  /** 被注入回合 / 被检索命中的次数与最近一次时间（记忆演进：长期不用的提议归档）。 */
  use_count: number
  last_used_at: string | null
}

/** 数据集（大样本表格）：上传 → 隔离环境里解析与概况 → 疑似身份信息的列由用户确认删除 → 可用。 */
export interface DatasetRow {
  id: string; owner: string; name: string; filename: string; format: string; size: number; sha256: string
  status: 'processing' | 'review' | 'ready' | 'failed'
  rows: number; cols: number
  /** profile.json（列类型、缺失、摘要、疑似身份信息） */
  profile: string | null
  /** 用户给列起的标签 {列名: 标签} */
  labels: string
  error: string | null; version: number; created_at: string; updated_at: string
  /** 平台生成的数据集的来源（JSON；如研究队列快照：研究、条件、生成时间、指纹）；用户上传的为 null */
  origin: string | null
}

/** 临床研究项目：方案、数据集、分析、稿件放在一起（文档与数据集经 study_items 归入，各自只属于一个研究）。 */
export interface StudyRow {
  id: string; owner: string; title: string
  /** 研究所属机构（建研究时负责人的机构；成员必须同机构）。开发模式等没有机构的用户为 null，只能自己用。 */
  tenant_id: string | null
  design: 'retrospective_cohort' | 'prospective_cohort' | 'rct' | 'case_control' | 'cross_sectional' | 'other' | null
  status: 'planning' | 'ongoing' | 'completed'; summary: string | null; created_at: string; updated_at: string
}
/** 机构幻灯片模板：机构管理员维护（院徽、机构名称、标准色），只有本机构成员能用；deck 里的模板 key 是 org_<id>。 */
/** 机构内的科室（知家分享的落点：分享给某医院的某科室，该科室的医生都能看）。 */
export interface DepartmentRow { id: string; tenant_id: string; name: string; created_at: string }

/** 知家家人把一位成员的档案分享给医院科室（docs/design/SHARING.md）。 */
export interface PhrShareRow {
  id: string
  /** 家人账号与其个人空间（数据所在的租户） */
  owner: string; source_tenant_id: string; patient_id: string
  /** 目标医院、科室，可选指定医生 */
  tenant_id: string; department_id: string; doctor_id: string | null
  /** JSON：{ categories: ('labs'|'reports'|'docs')[], since: 'YYYY-MM-DD' | null } */
  scope: string
  allow_import: number
  /** 给医生看的姓名（家人个人空间的密钥加密；只给被授权医生的界面显示） */
  display_name_enc: string | null
  expires_at: string; status: 'active' | 'revoked'
  created_at: string; revoked_at: string | null
  imported_at: string | null; imported_by: string | null; imported_patient_id: string | null
}

export interface TenantTemplateRow {
  id: string; tenant_id: string; label: string; description: string; org_name: string; footer: string
  /** 版式与装饰骨架沿用的内置模板 */
  base: string
  /** JSON：bg / surface / soft / title / body / muted / accent / accent2（6 位十六进制） */
  colors: string
  /** JSON：titleFont / bodyFont / serif */
  fonts: string
  logo: Uint8Array | null; logo_mime: string | null
  created_by: string; created_at: string; updated_at: string
}
export interface StudyItemRow { study_id: string; kind: 'doc' | 'dataset'; ref_id: string; role: string; added_at: string }
/** 研究成员（GCP 临床试验与研究协作角色）：PI (owner) 全局管理；Sub-I/CRC/统计师/DM/放射医师可写；CRA/Auditor/viewer 只读监查。 */
export type StudyRole =
  | 'owner'
  | 'sub_i'
  | 'cra'
  | 'crc'
  | 'statistician'
  | 'data_manager'
  | 'radiologist'
  | 'auditor'
  | 'editor'
  | 'viewer'
export interface StudyMemberRow { study_id: string; user_id: string; role: StudyRole; added_by: string; added_at: string }

/** 记忆演进的信号：用户改写了 AI 写的段落（edit_ai）、拒绝了 AI 的修订（reject）。整理时交给模型总结规律。 */
export interface MemorySignalRow {
  id: string; owner: string; doc_id: string; node_id: string | null; kind: 'edit_ai' | 'reject'
  /** edit_ai：AI 写的原文；reject：被拒的 AI 版本 */
  ai_text: string
  /** reject：用户保留的原文；edit_ai 为空，整理时取段落当前文字 */
  user_text: string | null
  ai_rev: number; at: string; consumed_at: string | null
}

/** 执行与自演进信号：写前守卫拦截、回合被用户回滚、工具执行失败等 */
export interface ExecutionSignalRow {
  id: string
  owner: string
  doc_id: string
  turn_id: string | null
  kind: 'guard_reject' | 'turn_revert' | 'tool_error'
  code: string
  detail: string | null
  consumed_at: string | null
  at: string
}

/** 程序性策略经验（Harness 避坑与调度规则）：系统从执行信号与元进化中沉淀的执行策略 */
export interface HarnessRuleRow {
  id: string
  scope: 'global' | 'user' | 'project'
  owner: string
  project_id: string | null
  category: 'guard' | 'tool' | 'subagent' | 'format'
  trigger_pattern: string
  rule: string
  evidence_count: number
  status: 'active' | 'archived'
  created_at: string
  updated_at: string
}

/** 记忆整理建议（合并 / 改写 / 归档），用户采纳后才生效。新总结出的规律直接作为「待确认」记忆，不走这里。 */
export interface MemoryChangeRow {
  id: string; owner: string; action: 'merge' | 'update' | 'archive'
  target_ids: string[]; content: string | null; reason: string
  status: 'pending' | 'applied' | 'dismissed'; created_at: string; resolved_at: string | null
}

export interface MemoryEventRow { id: string; memory_id: string; owner: string; action: string; actor: 'user' | 'ai' | 'system'; before: string | null; after: string | null; at: string }

export interface KbChunkHit {
  chunk_id: string
  file_id: string
  file_name: string
  page: number
  text: string
  doi: string | null
  pmid: string | null
  score: number
}

export interface ProjectRow {
  id: string
  owner: string
  name: string
  created_at: string
}

export interface SearchHit {
  doc_id: string
  title: string
  kind: DocKind
  project_id: string | null
  updated_at: string
  /** 命中处前后的文字（命中词用 [ ] 括起）。 */
  snippet: string
}

export interface VersionRow {
  doc_id: string
  seq: number
  rev: number
  source: VersionSource
  turn_id: string | null
  note: string
  created_at: string
}

export interface CitationRow {
  id: string
  doc_id: string
  doi: string
  pmid: string | null
  formatted: string
  url: string | null
  created_at: string
}

export interface CommentRow {
  id: string
  doc_id: string
  node_id: string
  snippet: string
  status: 'open' | 'resolved'
  resolved_by: Actor | null
  created_at: string
  /** 导入的 Word 批注：`word:<批注 id>:<导入的回复条数>`；平台里新建的为 null。 */
  source_ref: string | null
  replies: ReplyRow[]
}

export interface ReplyRow {
  id: string
  comment_id: string
  role: 'user' | 'ai'
  text: string
  turn_id: string | null
  created_at: string
  /** 原作者（导入的 Word 批注与回复）；平台里写的为 null。 */
  author: string | null
}

export interface PhrClaimRow {
  id: string
  code: string
  tenant_id: string
  patient_id: string
  created_by: string
  expires_at: string
  status: 'active' | 'requested' | 'confirmed' | 'revoked' | 'expired'
  claimant_user_id: string | null
  claimant_patient_id: string | null
  requested_at: string | null
  confirmed_by: string | null
  confirmed_at: string | null
  revoked_by: string | null
  revoked_at: string | null
  created_at: string
}

export interface PersonLinkRow {
  id: string
  tenant_id: string
  hospital_patient_id: string
  claimant_user_id: string
  claimant_patient_id: string
  claim_id: string | null
  verified_by: string
  verified_at: string
  status: 'active' | 'revoked'
  revoked_by: string | null
  revoked_at: string | null
  created_at: string
}

export type ClaimVerdict = 'supported' | 'unsupported' | 'unclear' | 'missing_citation' | 'exempted'

export interface ClaimCheckRow {
  doc_id: string
  claim_id: string
  node_id: string
  sentence: string
  verdict: ClaimVerdict
  reason: string
  comment_id: string | null
  rev: number
  created_at: string
}

export interface AssetRow {
  id: string
  owner: string
  mime: string
  name: string
  size: number
  created_at: string
}

/** 分析来源：AI 用哪段代码、哪些数据集（哪个版本）生成了这张图。 */
export interface AssetProvenance {
  code: string | null
  code_path: string | null
  datasets: Array<{ id: string; name: string; version: number; rows: number }>
  turn_id: string | null
  at: string
}

export interface TurnRow {
  id: string
  user_id: string
  doc_id: string | null
  message: string
  status: 'running' | 'done' | 'error' | 'cancelled' | 'interrupted' | 'timeout'
  started_at: string
  ended_at: string | null
  /** 未正常完成时的原因（报错文字 / 超时 / 取消说明）。 */
  error: string | null
  /** 回合选项（TurnOptions 的 JSON：修订模式、回答的评论），重试时沿用。 */
  opts: string
}

export interface QueuedJobRow {
  id: string
  user_id: string
  doc_id: string
  message: string
  /** TurnOptions 的 JSON。 */
  opts: string
  enqueued_at: string
}

export interface MessageRow {
  id: string
  doc_id: string
  role: 'user' | 'assistant'
  text: string
  turn_id: string | null
  created_at: string
}

const now = () => new Date().toISOString()
/** 评论线程 id（导入 Word 批注时需要在建文档之前先分配，因此单独导出）。 */
export const newCommentId = (): string => 't' + randomUUID().replace(/-/g, '').slice(0, 7)
const userKey = (username: string) => username.normalize('NFKC').toLowerCase()

export class Store {
  readonly db: DatabaseSync
  private savepointLevel = 0

  /**
   * 事务执行块：基于 SQLite SAVEPOINT 支持安全多层嵌套。
   * 顶层事务或内层保存点在异常时自动 ROLLBACK 并抛出，成功时 RELEASE。
   */
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

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000; PRAGMA synchronous = NORMAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, username_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
        token_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_login_at TEXT, imported_from TEXT, email TEXT
      );
      CREATE TABLE IF NOT EXISTS verification_codes (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, purpose TEXT NOT NULL, code_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, ip TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS verification_codes_target ON verification_codes (target, purpose, created_at);
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 0, state BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(doc_id UNINDEXED, owner UNINDEXED, title, body, tokenize = 'trigram');
      CREATE TABLE IF NOT EXISTS kb_files (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, project_id TEXT, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, status TEXT NOT NULL, note TEXT, pages INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0,
        embedded INTEGER NOT NULL DEFAULT 0, doi TEXT, pmid TEXT, bytes BLOB NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (owner, sha256)
      );
      CREATE TABLE IF NOT EXISTS kb_chunks (
        id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES kb_files(id) ON DELETE CASCADE, owner TEXT NOT NULL,
        seq INTEGER NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL, embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS kb_chunks_file ON kb_chunks (file_id, seq);
      CREATE INDEX IF NOT EXISTS kb_chunks_owner ON kb_chunks (owner);
      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(chunk_id UNINDEXED, owner UNINDEXED, text, tokenize = 'trigram');
      CREATE TABLE IF NOT EXISTS op_log (
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, rev INTEGER NOT NULL,
        actor TEXT NOT NULL, turn_id TEXT, ops TEXT NOT NULL, affected TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, rev)
      );
      CREATE TABLE IF NOT EXISTS node_changes (
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, rev INTEGER NOT NULL,
        node_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS node_changes_idx ON node_changes (doc_id, node_id, actor, rev);
      CREATE TABLE IF NOT EXISTS versions (
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, rev INTEGER NOT NULL,
        source TEXT NOT NULL, turn_id TEXT, note TEXT NOT NULL, state BLOB NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (doc_id, seq)
      );
      CREATE TABLE IF NOT EXISTS node_src (
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, node_id TEXT NOT NULL, xml TEXT NOT NULL,
        PRIMARY KEY (doc_id, node_id)
      );
      CREATE TABLE IF NOT EXISTS citation_fulltexts (
        doi TEXT PRIMARY KEY, source TEXT, url TEXT, license TEXT, text TEXT, fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS citation_abstracts (
        doi TEXT PRIMARY KEY, pmid TEXT, abstract TEXT, fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claim_checks (
        doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, claim_id TEXT NOT NULL, node_id TEXT NOT NULL,
        sentence TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT NOT NULL, comment_id TEXT, rev INTEGER NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY (doc_id, claim_id)
      );
      CREATE TABLE IF NOT EXISTS turn_bases (
        turn_id TEXT NOT NULL, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        state BLOB NOT NULL, reverted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (turn_id, doc_id)
      );
      CREATE TABLE IF NOT EXISTS doc_packages (
        doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE, kind TEXT NOT NULL, bytes BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL,
        size INTEGER NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS citations (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, doi TEXT NOT NULL,
        pmid TEXT, formatted TEXT NOT NULL, url TEXT, created_at TEXT NOT NULL, UNIQUE (doc_id, doi)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, node_id TEXT NOT NULL,
        snippet TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolved_by TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comment_replies (
        id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        role TEXT NOT NULL, text TEXT NOT NULL, turn_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, doc_id TEXT, message TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, error TEXT, opts TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS turn_queue (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        message TEXT NOT NULL, opts TEXT NOT NULL, enqueued_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, scope TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL,
        norm TEXT NOT NULL, reason TEXT, source TEXT NOT NULL, source_doc_id TEXT, source_turn_id TEXT, status TEXT NOT NULL,
        explicit INTEGER NOT NULL DEFAULT 0, embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_owner ON memories (owner, status);
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
        before TEXT, after TEXT, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_events_memory ON memory_events (memory_id, at);
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, filename TEXT NOT NULL, format TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, status TEXT NOT NULL, rows INTEGER NOT NULL DEFAULT 0, cols INTEGER NOT NULL DEFAULT 0, profile TEXT,
        labels TEXT NOT NULL DEFAULT '{}', error TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (owner, sha256)
      );
      CREATE TABLE IF NOT EXISTS studies (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, design TEXT, status TEXT NOT NULL DEFAULT 'planning', summary TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tenant_templates (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', org_name TEXT NOT NULL,
        footer TEXT NOT NULL DEFAULT '', base TEXT NOT NULL, colors TEXT NOT NULL, fonts TEXT NOT NULL, logo BLOB, logo_mime TEXT,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tenant_templates_tenant ON tenant_templates (tenant_id);
      CREATE TABLE IF NOT EXISTS study_items (
        study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE, kind TEXT NOT NULL, ref_id TEXT NOT NULL, role TEXT NOT NULL, added_at TEXT NOT NULL,
        PRIMARY KEY (study_id, kind, ref_id), UNIQUE (kind, ref_id)
      );
      CREATE TABLE IF NOT EXISTS study_members (
        study_id TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE, user_id TEXT NOT NULL, role TEXT NOT NULL,
        added_by TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (study_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS study_members_user ON study_members (user_id);
      CREATE TABLE IF NOT EXISTS memory_signals (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, doc_id TEXT NOT NULL, node_id TEXT, kind TEXT NOT NULL,
        ai_text TEXT NOT NULL, user_text TEXT, ai_rev INTEGER NOT NULL, at TEXT NOT NULL, consumed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memory_signals_once ON memory_signals (doc_id, node_id, kind, ai_rev);
      CREATE INDEX IF NOT EXISTS memory_signals_owner ON memory_signals (owner, consumed_at);
      CREATE TABLE IF NOT EXISTS memory_changes (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, action TEXT NOT NULL, target_ids TEXT NOT NULL, content TEXT, reason TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS memory_changes_owner ON memory_changes (owner, status);
      CREATE TABLE IF NOT EXISTS execution_signals (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, doc_id TEXT NOT NULL, turn_id TEXT,
        kind TEXT NOT NULL, code TEXT NOT NULL, detail TEXT, consumed_at TEXT, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS execution_signals_owner ON execution_signals (owner, consumed_at);
      CREATE TABLE IF NOT EXISTS harness_rules (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner TEXT NOT NULL, project_id TEXT,
        category TEXT NOT NULL, trigger_pattern TEXT NOT NULL, rule TEXT NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS harness_rules_lookup ON harness_rules (owner, category, status);
      CREATE TABLE IF NOT EXISTS user_settings (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
      CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
        settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, created_by TEXT
      );
      CREATE TABLE IF NOT EXISTS tenant_invites (
        code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role TEXT NOT NULL, email TEXT, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_by TEXT, used_at TEXT, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, status INTEGER
      );
      CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events (at);
      CREATE TABLE IF NOT EXISTS sandbox_uids (user_id TEXT PRIMARY KEY, uid INTEGER NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE, role TEXT NOT NULL,
        text TEXT NOT NULL, turn_id TEXT, created_at TEXT NOT NULL
      );
    `)
    // 旧库补列：回合失败 / 超时 / 取消的原因
    const turnCols = (this.db.prepare('PRAGMA table_info(turns)').all() as Array<{ name: string }>).map(c => c.name)
    if (!turnCols.includes('error')) this.db.exec('ALTER TABLE turns ADD COLUMN error TEXT')
    if (!turnCols.includes('opts')) this.db.exec("ALTER TABLE turns ADD COLUMN opts TEXT NOT NULL DEFAULT '{}'")
    const docCols = (this.db.prepare('PRAGMA table_info(docs)').all() as Array<{ name: string }>).map(c => c.name)
    if (!docCols.includes('project_id')) this.db.exec('ALTER TABLE docs ADD COLUMN project_id TEXT')
    if (!docCols.includes('deleted_at')) this.db.exec('ALTER TABLE docs ADD COLUMN deleted_at TEXT')
    if (!docCols.includes('context')) this.db.exec('ALTER TABLE docs ADD COLUMN context TEXT')
    const userCols = (this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map(c => c.name)
    if (!userCols.includes('email')) this.db.exec('ALTER TABLE users ADD COLUMN email TEXT')
    if (!userCols.includes('tenant_id')) this.db.exec('ALTER TABLE users ADD COLUMN tenant_id TEXT')
    const tenantCols = (this.db.prepare('PRAGMA table_info(tenants)').all() as Array<{ name: string }>).map(c => c.name)
    if (!tenantCols.includes('dek')) this.db.exec('ALTER TABLE tenants ADD COLUMN dek TEXT')
    // 导入的 Word 批注：来源（word:<批注 id>:<导入的回复条数>）与每条回复的原作者
    const commentCols = (this.db.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>).map(c => c.name)
    if (!commentCols.includes('source_ref')) this.db.exec('ALTER TABLE comments ADD COLUMN source_ref TEXT')
    const replyCols = (this.db.prepare('PRAGMA table_info(comment_replies)').all() as Array<{ name: string }>).map(c => c.name)
    if (!replyCols.includes('author')) this.db.exec('ALTER TABLE comment_replies ADD COLUMN author TEXT')
    if (!userCols.includes('tenant_role')) this.db.exec("ALTER TABLE users ADD COLUMN tenant_role TEXT NOT NULL DEFAULT 'member'")
    // 双重身份：个人空间单独记一列；老账户在个人租户里的，个人空间就是它
    if (!userCols.includes('personal_tenant_id')) {
      this.db.exec('ALTER TABLE users ADD COLUMN personal_tenant_id TEXT')
      this.db.exec("UPDATE users SET personal_tenant_id = tenant_id WHERE tenant_id IN (SELECT id FROM tenants WHERE kind = 'personal')")
    }
    if (!userCols.includes('work_email_prefix')) {
      this.db.exec('ALTER TABLE users ADD COLUMN work_email_prefix TEXT')
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_work_email_prefix ON users (work_email_prefix) WHERE work_email_prefix IS NOT NULL')
    }
    const inviteCols = (this.db.prepare('PRAGMA table_info(tenant_invites)').all() as Array<{ name: string }>).map(c => c.name)
    if (!inviteCols.includes('target_user_id')) this.db.exec('ALTER TABLE tenant_invites ADD COLUMN target_user_id TEXT')
    const auditCols = (this.db.prepare('PRAGMA table_info(audit_events)').all() as Array<{ name: string }>).map(c => c.name)
    if (!auditCols.includes('tenant_id')) this.db.exec('ALTER TABLE audit_events ADD COLUMN tenant_id TEXT')
    // AI 代表用户操作：via = ai（AI 直接做的）/ ai-confirmed（AI 发起、用户确认后执行的），confirmed_by = 确认人
    if (!auditCols.includes('via')) this.db.exec('ALTER TABLE audit_events ADD COLUMN via TEXT')
    if (!auditCols.includes('confirmed_by')) this.db.exec('ALTER TABLE audit_events ADD COLUMN confirmed_by TEXT')
    // AI 发起、等用户确认的高风险操作（docs/design/AI_PERMISSIONS.md）
    this.db.exec(`CREATE TABLE IF NOT EXISTS pending_actions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tool TEXT NOT NULL, action TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
      body TEXT, summary TEXT NOT NULL, reason TEXT, editable TEXT, doc_id TEXT, turn_id TEXT, status TEXT NOT NULL,
      result TEXT, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
    );
    CREATE INDEX IF NOT EXISTS pending_actions_user ON pending_actions (user_id, status);
    CREATE INDEX IF NOT EXISTS idx_comments_doc_status ON comments (doc_id, status);
    CREATE INDEX IF NOT EXISTS idx_comment_replies_comment ON comment_replies (comment_id);
    CREATE INDEX IF NOT EXISTS idx_messages_doc_created ON messages (doc_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_turns_doc_status ON turns (doc_id, status);
    CREATE INDEX IF NOT EXISTS idx_op_log_turn ON op_log (turn_id);
    CREATE INDEX IF NOT EXISTS idx_turn_queue_user ON turn_queue (user_id);
    CREATE INDEX IF NOT EXISTS idx_docs_owner_deleted ON docs (owner, deleted_at);`)
    this.db.exec('CREATE INDEX IF NOT EXISTS users_tenant ON users (tenant_id)')
    this.cleanLegacyCitations()
    // 科室与知家分享（docs/design/SHARING.md）
    this.db.exec(`CREATE TABLE IF NOT EXISTS tenant_departments (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tenant_departments_tenant ON tenant_departments (tenant_id);
    CREATE TABLE IF NOT EXISTS department_members (
      department_id TEXT NOT NULL REFERENCES tenant_departments(id) ON DELETE CASCADE, user_id TEXT NOT NULL, added_at TEXT NOT NULL,
      PRIMARY KEY (department_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS department_members_user ON department_members (user_id);
    CREATE TABLE IF NOT EXISTS phr_shares (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, source_tenant_id TEXT NOT NULL, patient_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL, department_id TEXT NOT NULL, doctor_id TEXT, scope TEXT NOT NULL, allow_import INTEGER NOT NULL DEFAULT 0,
      display_name_enc TEXT, expires_at TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT,
      imported_at TEXT, imported_by TEXT, imported_patient_id TEXT
    );
    CREATE INDEX IF NOT EXISTS phr_shares_target ON phr_shares (tenant_id, status);
    CREATE INDEX IF NOT EXISTS phr_shares_owner ON phr_shares (owner, patient_id);
    CREATE TABLE IF NOT EXISTS phr_claims (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, patient_id TEXT NOT NULL,
      created_by TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL,
      claimant_user_id TEXT, claimant_patient_id TEXT, requested_at TEXT,
      confirmed_by TEXT, confirmed_at TEXT, revoked_by TEXT, revoked_at TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS phr_claims_code ON phr_claims (code);
    CREATE INDEX IF NOT EXISTS phr_claims_target ON phr_claims (tenant_id, patient_id);
    CREATE TABLE IF NOT EXISTS person_links (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, hospital_patient_id TEXT NOT NULL,
      claimant_user_id TEXT NOT NULL, claimant_patient_id TEXT NOT NULL,
      claim_id TEXT, verified_by TEXT NOT NULL, verified_at TEXT NOT NULL,
      status TEXT NOT NULL, revoked_by TEXT, revoked_at TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS person_links_hospital ON person_links (tenant_id, hospital_patient_id);
    CREATE INDEX IF NOT EXISTS person_links_claimant ON person_links (claimant_user_id, claimant_patient_id);`)
    // 研究团队协作之前的研究：负责人补成成员表里的 owner；研究记下所属机构（负责人当时的机构）
    const studyCols = (this.db.prepare('PRAGMA table_info(studies)').all() as Array<{ name: string }>).map(c => c.name)
    if (!studyCols.includes('tenant_id')) this.db.exec('ALTER TABLE studies ADD COLUMN tenant_id TEXT')
    this.db.exec(`INSERT OR IGNORE INTO study_members (study_id, user_id, role, added_by, added_at) SELECT id, owner, 'owner', owner, created_at FROM studies`)
    // 租户上线前的用户：各自一个个人租户，本人为机构管理员
    for (const u of this.db.prepare('SELECT id, display_name FROM users WHERE tenant_id IS NULL').all() as Array<{ id: string; display_name: string }>) {
      const t = this.createTenant({ name: `${u.display_name}（个人）`, kind: 'personal', created_by: u.id })
      this.db.prepare("UPDATE users SET tenant_id = ?, tenant_role = 'admin' WHERE id = ?").run(t.id, u.id)
    }
    this.db.exec('UPDATE studies SET tenant_id = (SELECT tenant_id FROM users WHERE users.id = studies.owner) WHERE tenant_id IS NULL')
    const assetCols = (this.db.prepare('PRAGMA table_info(assets)').all() as Array<{ name: string }>).map(c => c.name)
    if (!assetCols.includes('provenance')) this.db.exec('ALTER TABLE assets ADD COLUMN provenance TEXT')
    const dsCols = (this.db.prepare('PRAGMA table_info(datasets)').all() as Array<{ name: string }>).map(c => c.name)
    if (!dsCols.includes('origin')) this.db.exec('ALTER TABLE datasets ADD COLUMN origin TEXT')
    const memCols = (this.db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map(c => c.name)
    if (!memCols.includes('use_count')) this.db.exec('ALTER TABLE memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0')
    if (!memCols.includes('last_used_at')) this.db.exec('ALTER TABLE memories ADD COLUMN last_used_at TEXT')
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL')

    // 邮件与日历（随访计划、科研项目进度与排期）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_messages (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT, sender TEXT NOT NULL, sender_name TEXT NOT NULL,
        recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL,
        patient_id TEXT, patient_code TEXT, study_id TEXT, study_title TEXT,
        read INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0, calendar_event_id TEXT,
        folder TEXT NOT NULL DEFAULT 'inbox', delivery_status TEXT, delivery_note TEXT, thread_id TEXT, in_reply_to TEXT, attachments TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_messages_user ON mail_messages (user_id, folder, category, read);

      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT, title TEXT NOT NULL, description TEXT,
        start_time TEXT NOT NULL, end_time TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0,
        category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
        patient_id TEXT, patient_code TEXT, study_id TEXT, study_title TEXT,
        location TEXT, mail_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS calendar_events_user ON calendar_events (user_id, start_time);
    `)

    const mailCols = (this.db.prepare('PRAGMA table_info(mail_messages)').all() as Array<{ name: string }>).map(c => c.name)
    if (!mailCols.includes('folder')) {
      this.db.exec("ALTER TABLE mail_messages ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox'")
      this.db.exec("UPDATE mail_messages SET folder = 'sent' WHERE (sender LIKE 'dr.%' OR sender LIKE '%@heurion.org') AND recipient NOT LIKE 'dr.%' AND recipient NOT LIKE '%@heurion.org' AND recipient NOT LIKE '%@heurion.com'")
    }
    if (!mailCols.includes('delivery_status')) {
      this.db.exec('ALTER TABLE mail_messages ADD COLUMN delivery_status TEXT')
    }
    if (!mailCols.includes('delivery_note')) {
      this.db.exec('ALTER TABLE mail_messages ADD COLUMN delivery_note TEXT')
    }
    if (!mailCols.includes('thread_id')) {
      this.db.exec('ALTER TABLE mail_messages ADD COLUMN thread_id TEXT')
    }
    if (!mailCols.includes('in_reply_to')) {
      this.db.exec('ALTER TABLE mail_messages ADD COLUMN in_reply_to TEXT')
    }
    if (!mailCols.includes('attachments')) {
      this.db.exec('ALTER TABLE mail_messages ADD COLUMN attachments TEXT')
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_mail_user_thread ON mail_messages (user_id, thread_id)')
    this.db.exec("UPDATE mail_messages SET delivery_status = 'simulated', delivery_note = '本地开发模拟：未配置外网发信服务 (SMTP/RESEND_API_KEY)' WHERE folder = 'sent' AND delivery_status IS NULL")
    // 清理早期版本自动注入的演示种子邮件与日历事件（仅删未关联真实日程/邮件的种子行）
    this.db.exec(`
      DELETE FROM mail_messages
       WHERE calendar_event_id IS NULL
         AND sender IN ('followup@heurion.org', 'research.dapa-hf@heurion.org', 'oncology.followup@heurion.org', 'irb.research@heurion.org', 'nutrition.prehab@heurion.org')
         AND (patient_id IN ('PT-BRONCHO-001', 'PT-NSCLC-002', 'PT-SARCO-003') OR study_id = 'DAPA-HF-RCT-2019');
      DELETE FROM calendar_events
       WHERE mail_id IS NULL
         AND (patient_id IN ('PT-BRONCHO-001', 'PT-NSCLC-002', 'PT-SARCO-003') OR study_id = 'DAPA-HF-RCT-2019')
         AND title IN (
           '【随访】PT-BRONCHO-001 气道CT与高密度粘液栓复查',
           '【科研】DAPA-HF 课题入组质控与 PSM 平衡评审会',
           '【随访】PT-NSCLC-002 奥希替尼靶向 RECIST 1.1 疗效评估',
           '【科研】DSMB 独立数据监查委员会中期审查闭门会议',
           '【随访】PT-SARCO-003 营养支持与化疗耐受评估（低 SMI）'
         );
    `)
  }


  // —— 文档 ——

  createDoc(input: { id?: string; owner: string; title: string; kind: DocKind; state: Uint8Array }): DocRow {
    const id = input.id ?? randomUUID()
    const t = now()
    this.db.prepare('INSERT INTO docs (id, owner, title, kind, rev, state, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
      .run(id, input.owner, input.title, input.kind, input.state, t, t)
    return this.getDoc(id)!
  }

  getDoc(id: string): DocRow | undefined {
    return this.db.prepare('SELECT id, owner, title, kind, rev, created_at, updated_at, project_id, deleted_at, context FROM docs WHERE id = ?').get(id) as DocRow | undefined
  }

  getCopilotDoc(owner: string): DocRow | undefined {
    return this.db.prepare("SELECT id, owner, title, kind, rev, created_at, updated_at, project_id, deleted_at, context FROM docs WHERE owner = ? AND deleted_at IS NULL AND json_extract(context, '$.kind') = 'copilot' ORDER BY created_at DESC LIMIT 1").get(owner) as DocRow | undefined
  }

  // —— 用户 ——

  /** 用户名比较不区分大小写（username_key）。第一个用户自动成为管理员。 */
  /** 新用户：tenant 给定时加入该租户，否则建一个个人租户（本人为机构管理员）。 */
  createUser(input: { id?: string; username: string; display_name: string; password_hash: string; role?: UserRow['role']; status?: UserRow['status']; imported_from?: string | null; email?: string | null; tenant?: { id: string; role: UserRow['tenant_role'] } }): UserRow {
    return this.transaction(() => {
      const id = input.id ?? ('u' + randomUUID().replace(/-/g, '').slice(0, 15))
      const role = input.role ?? (this.countUsers() === 0 ? 'admin' : 'user')
      const tenant = input.tenant ?? { id: this.createTenant({ name: `${input.display_name}（个人）`, kind: 'personal', created_by: id }).id, role: 'admin' as const }
      // 个人注册：个人空间就是工作空间；经邀请注册进机构的：个人空间等知家用到再建
      const personal = input.tenant ? null : tenant.id
      this.db.prepare(`INSERT INTO users (id, username, username_key, display_name, password_hash, role, status, created_at, imported_from, email, tenant_id, tenant_role, personal_tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.username, userKey(input.username), input.display_name, input.password_hash, role, input.status ?? 'active', now(), input.imported_from ?? null, input.email ?? null, tenant.id, tenant.role, personal)
      return this.getUser(id)!
    })
  }

  // —— 租户（机构） ——

  createTenant(input: { name: string; kind: TenantRow['kind']; created_by?: string | null; settings?: object; id?: string }): TenantRow {
    const id = input.id ?? 't' + randomUUID().replace(/-/g, '').slice(0, 11)
    this.db.prepare('INSERT INTO tenants (id, name, kind, status, settings, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.name, input.kind, 'active', JSON.stringify(input.settings ?? {}), now(), input.created_by ?? null)
    return this.getTenant(id)!
  }

  getTenant(id: string): TenantRow | undefined {
    return this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as unknown as TenantRow | undefined
  }

  listTenants(): Array<TenantRow & { members: number; admins: number; docs: number }> {
    return this.db.prepare(`SELECT t.*,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS members,
        (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.tenant_role = 'admin') AS admins,
        (SELECT COUNT(*) FROM docs d JOIN users u ON u.id = d.owner WHERE u.tenant_id = t.id) AS docs
      FROM tenants t ORDER BY t.kind DESC, t.created_at`).all() as unknown as Array<TenantRow & { members: number; admins: number; docs: number }>
  }

  updateTenant(id: string, patch: Partial<Pick<TenantRow, 'name' | 'status' | 'settings' | 'kind'>>): void {
    const ALLOWED = ['name', 'status', 'settings', 'kind'] as const
    const keys = (Object.keys(patch) as Array<keyof typeof patch>).filter(k => (ALLOWED as readonly string[]).includes(k))
    if (keys.length) this.db.prepare(`UPDATE tenants SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => patch[k] as string), id)
  }

  /** 机构数据密钥（已用平台主密钥加密，base64）；null = 还没生成或已销毁。 */
  getTenantDek(id: string): string | null {
    return (this.db.prepare('SELECT dek FROM tenants WHERE id = ?').get(id) as { dek: string | null } | undefined)?.dek ?? null
  }

  setTenantDek(id: string, dek: string | null): void {
    this.db.prepare('UPDATE tenants SET dek = ? WHERE id = ?').run(dek, id)
  }

  tenantMembers(tenantId: string): Array<UserRow & { doc_count: number }> {
    return this.db.prepare('SELECT u.*, (SELECT COUNT(*) FROM docs d WHERE d.owner = u.id) AS doc_count FROM users u WHERE u.tenant_id = ? ORDER BY u.created_at')
      .all(tenantId) as unknown as Array<UserRow & { doc_count: number }>
  }

  setTenantRole(userId: string, role: UserRow['tenant_role']): void {
    this.db.prepare('UPDATE users SET tenant_role = ? WHERE id = ?').run(role, userId)
  }

  /** 把用户移到另一个租户（平台运营把已有账号加进机构时用；个人数据随人走）。 */
  moveUserToTenant(userId: string, tenantId: string, role: UserRow['tenant_role']): void {
    this.db.prepare('UPDATE users SET tenant_id = ?, tenant_role = ? WHERE id = ?').run(tenantId, role, userId)
  }

  addInvite(input: Pick<TenantInviteRow, 'tenant_id' | 'role' | 'email' | 'created_by'> & { days: number; target_user_id?: string | null }): TenantInviteRow {
    const code = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8)
    const t = now()
    this.db.prepare('INSERT INTO tenant_invites (code, tenant_id, role, email, created_by, created_at, expires_at, target_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(code, input.tenant_id, input.role, input.email, input.created_by, t, new Date(Date.now() + input.days * 86_400_000).toISOString(), input.target_user_id ?? null)
    return this.getInvite(code)!
  }

  getInvite(code: string): TenantInviteRow | undefined {
    return this.db.prepare('SELECT * FROM tenant_invites WHERE code = ?').get(code) as unknown as TenantInviteRow | undefined
  }

  listInvites(tenantId: string): TenantInviteRow[] {
    return this.db.prepare('SELECT * FROM tenant_invites WHERE tenant_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC')
      .all(tenantId, now()) as unknown as TenantInviteRow[]
  }

  /** 发给这个账户、还没处理的邀请（按用户名邀请的）。 */
  invitesForUser(userId: string): TenantInviteRow[] {
    return this.db.prepare('SELECT * FROM tenant_invites WHERE target_user_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC')
      .all(userId, now()) as unknown as TenantInviteRow[]
  }

  setPersonalTenant(userId: string, tenantId: string | null): void {
    this.db.prepare('UPDATE users SET personal_tenant_id = ? WHERE id = ?').run(tenantId, userId)
  }

  useInvite(code: string, userId: string): void {
    this.db.prepare('UPDATE tenant_invites SET used_by = ?, used_at = ? WHERE code = ?').run(userId, now(), code)
  }

  revokeInvite(code: string): void {
    this.db.prepare('UPDATE tenant_invites SET revoked_at = ? WHERE code = ?').run(now(), code)
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined
  }

  getUserByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username_key = ?').get(userKey(username)) as unknown as UserRow | undefined
  }

  getUserByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as unknown as UserRow | undefined
  }

  getUserByWorkEmailPrefix(prefix: string): UserRow | undefined {
    const p = (prefix || '').trim().toLowerCase()
    if (!p) return undefined
    return this.db.prepare('SELECT * FROM users WHERE LOWER(work_email_prefix) = ?').get(p) as unknown as UserRow | undefined
  }

  setUserEmail(id: string, email: string | null): void {
    this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, id)
  }

  // —— 邮箱验证码（只存哈希） ——

  addVerificationCode(row: { id: string; target: string; purpose: string; code_hash: string; ip: string | null; created_at: number; expires_at: number }): void {
    this.db.prepare('INSERT INTO verification_codes (id, target, purpose, code_hash, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.target, row.purpose, row.code_hash, row.ip, row.created_at, row.expires_at)
  }

  latestVerificationCode(target: string, purpose: string): { id: string; code_hash: string; attempts: number; created_at: number; expires_at: number; used_at: number | null } | undefined {
    return this.db.prepare('SELECT * FROM verification_codes WHERE target = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1')
      .get(target, purpose) as unknown as ReturnType<Store['latestVerificationCode']>
  }

  countVerificationCodesByIp(ip: string, since: number): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM verification_codes WHERE ip = ? AND created_at >= ?').get(ip, since) as { n: number }).n)
  }

  markVerificationCode(id: string, patch: { used?: boolean; attempt?: boolean }): void {
    if (patch.used) this.db.prepare('UPDATE verification_codes SET used_at = ? WHERE id = ?').run(Date.now(), id)
    if (patch.attempt) this.db.prepare('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?').run(id)
  }

  countUsers(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n)
  }

  listUsers(): Array<UserRow & { doc_count: number }> {
    return this.db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM docs d WHERE d.owner = u.id) AS doc_count FROM users u ORDER BY u.created_at`)
      .all() as unknown as Array<UserRow & { doc_count: number }>
  }

  updateUser(id: string, patch: Partial<Pick<UserRow, 'display_name' | 'password_hash' | 'role' | 'status' | 'work_email_prefix'>> & { bumpTokenVersion?: boolean; touchLogin?: boolean }): UserRow | undefined {
    const sets: string[] = []
    const args: Array<string | number | null> = []
    for (const k of ['display_name', 'password_hash', 'role', 'status', 'work_email_prefix'] as const) {
      if (patch[k] !== undefined) { sets.push(`${k} = ?`); args.push(patch[k]) }
    }
    if (patch.bumpTokenVersion) sets.push('token_version = token_version + 1')
    if (patch.touchLogin) { sets.push('last_login_at = ?'); args.push(now()) }
    if (sets.length > 0) this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id)
    return this.getUser(id)
  }

  /** 开发期的数据（所有者是开发用户）转给一个正式账户。 */
  transferOwnership(from: string, to: string): { docs: number; assets: number } {
    return this.transaction(() => {
      const docs = Number(this.db.prepare('UPDATE docs SET owner = ? WHERE owner = ?').run(to, from).changes)
      const assets = Number(this.db.prepare('UPDATE assets SET owner = ? WHERE owner = ?').run(to, from).changes)
      return { docs, assets }
    })
  }

  /** 正常文档（不含回收站）。 */
  setDocContext(id: string, context: object | null): void {
    this.db.prepare('UPDATE docs SET context = ? WHERE id = ?').run(context ? JSON.stringify(context) : null, id)
  }

  /** 文档列表：普通文档（属于患者的病例报告等不在这里，在患者页）。 */
  listDocs(owner: string): DocRow[] {
    return this.db.prepare('SELECT id, owner, title, kind, rev, created_at, updated_at, project_id, deleted_at, context FROM docs WHERE owner = ? AND deleted_at IS NULL AND context IS NULL ORDER BY updated_at DESC')
      .all(owner) as unknown as DocRow[]
  }

  allDocIds(): string[] {
    return (this.db.prepare('SELECT id FROM docs').all() as Array<{ id: string }>).map(r => r.id)
  }

  listTrash(owner: string): DocRow[] {
    return this.db.prepare('SELECT id, owner, title, kind, rev, created_at, updated_at, project_id, deleted_at, context FROM docs WHERE owner = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC')
      .all(owner) as unknown as DocRow[]
  }

  /** 移进回收站 / 恢复（deleted = false）。 */
  trashDoc(id: string, deleted: boolean): void {
    this.db.prepare('UPDATE docs SET deleted_at = ? WHERE id = ?').run(deleted ? now() : null, id)
  }

  /** 回收站里超过 days 天的文档彻底删除，返回删掉的 id。 */
  purgeTrash(days: number): string[] {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
    const rows = this.db.prepare('SELECT id FROM docs WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff) as Array<{ id: string }>
    for (const r of rows) this.deleteDoc(r.id)
    return rows.map(r => r.id)
  }

  setDocProject(id: string, projectId: string | null): void {
    this.db.prepare('UPDATE docs SET project_id = ? WHERE id = ?').run(projectId, id)
  }

  // —— 参考资料库（R2） ——

  /** 新资料；同一用户上传同样的文件（按内容哈希）返回已有的那份。 */
  addKbFile(input: { owner: string; project_id: string | null; name: string; mime: string; bytes: Uint8Array; sha256: string }): { row: KbFileRow; duplicate: boolean } {
    const existing = this.db.prepare('SELECT id, owner, project_id, name, mime, size, sha256, status, note, pages, chunks, embedded, doi, pmid, created_at FROM kb_files WHERE owner = ? AND sha256 = ?').get(input.owner, input.sha256) as unknown as KbFileRow | undefined
    if (existing) return { row: existing, duplicate: true }
    const id = 'f' + randomUUID().replace(/-/g, '').slice(0, 11)
    this.db.prepare(`INSERT INTO kb_files (id, owner, project_id, name, mime, size, sha256, status, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, input.owner, input.project_id, input.name, input.mime, input.bytes.length, input.sha256, input.bytes, now())
    return { row: this.getKbFile(id)!, duplicate: false }
  }

  getKbFile(id: string): KbFileRow | undefined {
    return this.db.prepare('SELECT id, owner, project_id, name, mime, size, sha256, status, note, pages, chunks, embedded, doi, pmid, created_at FROM kb_files WHERE id = ?').get(id) as unknown as KbFileRow | undefined
  }

  getKbBytes(id: string): Uint8Array | null {
    const r = this.db.prepare('SELECT bytes FROM kb_files WHERE id = ?').get(id) as { bytes: Uint8Array } | undefined
    return r ? new Uint8Array(r.bytes) : null
  }

  listKbFiles(owner: string, projectId?: string | null): KbFileRow[] {
    if (projectId === undefined) return this.db.prepare('SELECT id, owner, project_id, name, mime, size, sha256, status, note, pages, chunks, embedded, doi, pmid, created_at FROM kb_files WHERE owner = ? ORDER BY created_at DESC').all(owner) as unknown as KbFileRow[]
    return this.db.prepare('SELECT id, owner, project_id, name, mime, size, sha256, status, note, pages, chunks, embedded, doi, pmid, created_at FROM kb_files WHERE owner = ? AND project_id IS ? ORDER BY created_at DESC').all(owner, projectId) as unknown as KbFileRow[]
  }

  /** 未处理完的资料（启动时继续处理）。 */
  listKbUnfinished(): KbFileRow[] {
    return this.db.prepare(`SELECT id, owner, project_id, name, mime, size, sha256, status, note, pages, chunks, embedded, doi, pmid, created_at FROM kb_files WHERE status IN ('pending', 'extracting', 'ocr', 'embedding') OR (status = 'ready' AND embedded < chunks) ORDER BY created_at`).all() as unknown as KbFileRow[]
  }

  updateKbFile(id: string, patch: Partial<Pick<KbFileRow, 'status' | 'note' | 'pages' | 'chunks' | 'embedded' | 'doi' | 'pmid' | 'project_id' | 'name'>>): void {
    const ALLOWED = ['status', 'note', 'pages', 'chunks', 'embedded', 'doi', 'pmid', 'project_id', 'name'] as const
    const keys = (Object.keys(patch) as Array<keyof typeof patch>).filter(k => (ALLOWED as readonly string[]).includes(k))
    if (keys.length === 0) return
    this.db.prepare(`UPDATE kb_files SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => patch[k] as string | number | null), id)
  }

  deleteKbFile(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM kb_fts WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE file_id = ?)').run(id)
      this.db.prepare('DELETE FROM kb_files WHERE id = ?').run(id)
    })
  }

  /** 写入一份资料的全部文字块（替换旧的）。 */
  putKbChunks(file: { id: string; owner: string }, chunks: Array<{ page: number; text: string }>): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM kb_fts WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE file_id = ?)').run(file.id)
      this.db.prepare('DELETE FROM kb_chunks WHERE file_id = ?').run(file.id)
      const ins = this.db.prepare('INSERT INTO kb_chunks (id, file_id, owner, seq, page, text) VALUES (?, ?, ?, ?, ?, ?)')
      const fts = this.db.prepare('INSERT INTO kb_fts (chunk_id, owner, text) VALUES (?, ?, ?)')
      chunks.forEach((c, i) => {
        const id = `${file.id}-${i}`
        ins.run(id, file.id, file.owner, i, c.page, c.text)
        fts.run(id, file.owner, c.text)
      })
    })
  }

  /** 还没向量化的块。 */
  kbChunksToEmbed(fileId: string, limit: number): Array<{ id: string; text: string }> {
    return this.db.prepare('SELECT id, text FROM kb_chunks WHERE file_id = ? AND embedding IS NULL ORDER BY seq LIMIT ?').all(fileId, limit) as Array<{ id: string; text: string }>
  }

  setKbEmbedding(chunkId: string, vector: Float32Array): void {
    this.db.prepare('UPDATE kb_chunks SET embedding = ? WHERE id = ?').run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), chunkId)
  }

  countKbEmbedded(fileId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE file_id = ? AND embedding IS NOT NULL').get(fileId) as { n: number }).n)
  }

  /** 读一份资料的文字（按页范围），kb_read 用。 */
  kbText(fileId: string, fromPage = 1, toPage = Number.MAX_SAFE_INTEGER): Array<{ page: number; text: string }> {
    return this.db.prepare('SELECT page, text FROM kb_chunks WHERE file_id = ? AND page BETWEEN ? AND ? ORDER BY seq').all(fileId, fromPage, toPage) as Array<{ page: number; text: string }>
  }

  /** 关键词检索（trigram；1–2 个字退回 LIKE），按 bm25 排序。 */
  kbKeywordSearch(owner: string, query: string, limit: number, fileIds?: string[]): KbChunkHit[] {
    const q = query.trim()
    if (!q) return []
    const scope = fileIds ? ` AND c.file_id IN (${fileIds.map(() => '?').join(',') || "''"})` : ''
    const select = `SELECT c.id AS chunk_id, c.file_id, f.name AS file_name, c.page, c.text, f.doi, f.pmid`
    let rows: KbChunkHit[]
    const terms = kbQueryTerms(q)
    if (terms.length > 0) {
      const match = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
      rows = this.db.prepare(`${select}, -bm25(kb_fts) AS score FROM kb_fts JOIN kb_chunks c ON c.id = kb_fts.chunk_id JOIN kb_files f ON f.id = c.file_id
        WHERE kb_fts.owner = ? AND kb_fts MATCH ?${scope} ORDER BY bm25(kb_fts) LIMIT ?`).all(owner, match, ...(fileIds ?? []), limit) as never
    } else {
      const like = `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`
      rows = this.db.prepare(`${select}, 1.0 AS score FROM kb_chunks c JOIN kb_files f ON f.id = c.file_id
        WHERE c.owner = ? AND c.text LIKE ? ESCAPE '\\'${scope} ORDER BY c.file_id, c.seq LIMIT ?`).all(owner, like, ...(fileIds ?? []), limit) as never
    }
    return rows
  }

  /** 向量检索：按用户（和资料范围）取出所有向量算余弦（个人资料库规模够用；大了再上 sqlite-vec）。 */
  kbVectorSearch(owner: string, query: Float32Array, limit: number, fileIds?: string[]): KbChunkHit[] {
    const scope = fileIds ? ` AND c.file_id IN (${fileIds.map(() => '?').join(',') || "''"})` : ''
    const rows = this.db.prepare(`SELECT c.id AS chunk_id, c.file_id, f.name AS file_name, c.page, c.text, f.doi, f.pmid, c.embedding
      FROM kb_chunks c JOIN kb_files f ON f.id = c.file_id WHERE c.owner = ? AND c.embedding IS NOT NULL${scope}`).all(owner, ...(fileIds ?? [])) as unknown as Array<KbChunkHit & { embedding: Uint8Array }>
    const scored = rows.map(r => {
      const v = new Float32Array(new Uint8Array(r.embedding).buffer)
      let dot = 0
      for (let i = 0; i < v.length && i < query.length; i++) dot += v[i]! * query[i]!
      const { embedding: _e, ...hit } = r
      return { ...hit, score: dot }
    })
    return scored.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  // —— 设置 ——

  getUserSetting(userId: string, key: string): string | null {
    return (this.db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key) as { value: string } | undefined)?.value ?? null
  }

  setUserSetting(userId: string, key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM user_settings WHERE user_id = ? AND key = ?').run(userId, key)
    else this.db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, value)
  }

  getAppSetting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null
  }

  setAppSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // —— 审计日志（M2） ——

  addAudit(e: { actor: string | null; action: string; target?: string | null; detail?: string | null; ip?: string | null; status?: number | null; tenant_id?: string | null; via?: string | null; confirmed_by?: string | null }): void {
    // 租户：显式给的，否则取操作者所在的租户（机构管理员只看本机构的审计）
    const tenant = e.tenant_id !== undefined ? e.tenant_id : e.actor ? this.getUser(e.actor)?.tenant_id ?? null : null
    this.db.prepare('INSERT INTO audit_events (at, actor, action, target, detail, ip, status, tenant_id, via, confirmed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(now(), e.actor, e.action, e.target ?? null, e.detail ?? null, e.ip ?? null, e.status ?? null, tenant, e.via ?? null, e.confirmed_by ?? null)
  }

  // —— AI 发起、等用户确认的操作 ——
  addPendingAction(a: Omit<PendingActionRow, 'id' | 'status' | 'result' | 'created_at' | 'decided_at' | 'decided_by'>): PendingActionRow {
    const id = 'pa' + randomUUID().replace(/-/g, '').slice(0, 14)
    this.db.prepare('INSERT INTO pending_actions (id, user_id, tool, action, method, path, body, summary, reason, editable, doc_id, turn_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, a.user_id, a.tool, a.action, a.method, a.path, a.body, a.summary, a.reason, a.editable, a.doc_id, a.turn_id, 'pending', now())
    return this.getPendingAction(id)!
  }
  getPendingAction(id: string): PendingActionRow | undefined {
    return this.db.prepare('SELECT * FROM pending_actions WHERE id = ?').get(id) as PendingActionRow | undefined
  }
  listPendingActions(userId: string, status?: string): PendingActionRow[] {
    return (status
      ? this.db.prepare('SELECT * FROM pending_actions WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100').all(userId, status)
      : this.db.prepare('SELECT * FROM pending_actions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(userId)) as unknown as PendingActionRow[]
  }
  /** 只在 from 状态时改（防止重复确认）；返回是否改到了。 */
  setPendingActionStatus(id: string, from: PendingActionRow['status'], to: PendingActionRow['status'], extra: { result?: string | null; decided_by?: string | null; body?: string | null } = {}): boolean {
    const r = this.db.prepare('UPDATE pending_actions SET status = ?, result = COALESCE(?, result), decided_by = COALESCE(?, decided_by), body = COALESCE(?, body), decided_at = ? WHERE id = ? AND status = ?')
      .run(to, extra.result ?? null, extra.decided_by ?? null, extra.body ?? null, now(), id, from)
    return Number(r.changes) > 0
  }
  /** 超过有效期的待确认操作标为过期，返回条数。 */
  expirePendingActions(maxAgeMs: number): number {
    return Number(this.db.prepare("UPDATE pending_actions SET status = 'expired', decided_at = ? WHERE status = 'pending' AND created_at < ?").run(now(), new Date(Date.now() - maxAgeMs).toISOString()).changes)
  }

  /** 最新在前；before = 上一页最后一条的 id。 */
  listAudit(f: { actor?: string; action?: string; before?: number; limit?: number; tenant?: string } = {}): Array<{ id: number; at: string; actor: string | null; action: string; target: string | null; detail: string | null; ip: string | null; status: number | null; via: string | null; confirmed_by: string | null }> {
    const where: string[] = []
    const args: Array<string | number> = []
    if (f.actor) { where.push('actor = ?'); args.push(f.actor) }
    if (f.tenant) { where.push('tenant_id = ?'); args.push(f.tenant) }
    if (f.action) { where.push('action LIKE ?'); args.push(`${f.action}%`) }
    if (f.before) { where.push('id < ?'); args.push(f.before) }
    return this.db.prepare(`SELECT id, at, actor, action, target, detail, ip, status, via, confirmed_by FROM audit_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...args, Math.min(f.limit ?? 100, 500)) as never
  }

  /** 保留期之外的审计记录删除，返回删了几条。 */
  purgeAudit(days: number): number {
    return Number(this.db.prepare('DELETE FROM audit_events WHERE at < ?').run(new Date(Date.now() - days * 86400_000).toISOString()).changes)
  }

  /** AI 代码隔离：平台用户 → 专属 Linux uid（20000 起，分配后不变）。 */
  sandboxUid(userId: string): number {
    const hit = this.db.prepare('SELECT uid FROM sandbox_uids WHERE user_id = ?').get(userId) as { uid: number } | undefined
    if (hit) return hit.uid
    const max = (this.db.prepare('SELECT MAX(uid) AS m FROM sandbox_uids').get() as { m: number | null }).m
    const uid = Math.max(20000, (max ?? 19999) + 1)
    if (uid >= 60000) throw new Error('隔离 uid 用完了')
    this.db.prepare('INSERT INTO sandbox_uids (user_id, uid) VALUES (?, ?)').run(userId, uid)
    return uid
  }

  // —— 记忆（R3） ——

  private static readonly MEM_COLS = 'id, owner, scope, project_id, kind, content, reason, source, source_doc_id, source_turn_id, status, explicit, created_at, updated_at, use_count, last_used_at'

  addMemory(input: Omit<MemoryRow, 'id' | 'created_at' | 'updated_at' | 'use_count' | 'last_used_at'> & { norm: string }): MemoryRow {
    const id = 'm' + randomUUID().replace(/-/g, '').slice(0, 11)
    const t = now()
    this.db.prepare(`INSERT INTO memories (id, owner, scope, project_id, kind, content, norm, reason, source, source_doc_id, source_turn_id, status, explicit, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.owner, input.scope, input.project_id, input.kind, input.content, input.norm, input.reason,
      input.source, input.source_doc_id, input.source_turn_id, input.status, input.explicit, t, t)
    return this.getMemory(id)!
  }

  getMemory(id: string): MemoryRow | undefined {
    return this.db.prepare(`SELECT ${Store.MEM_COLS} FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined
  }

  listMemories(owner: string, statuses?: MemoryStatus[]): MemoryRow[] {
    const where = statuses ? ` AND status IN (${statuses.map(() => '?').join(',')})` : ''
    return this.db.prepare(`SELECT ${Store.MEM_COLS} FROM memories WHERE owner = ?${where} ORDER BY updated_at DESC`).all(owner, ...(statuses ?? [])) as unknown as MemoryRow[]
  }

  /** 同一用户里规范化文本相同的记忆（去重、拒绝过的不再提议）。 */
  findMemoryByNorm(owner: string, norm: string): MemoryRow | undefined {
    return this.db.prepare(`SELECT ${Store.MEM_COLS} FROM memories WHERE owner = ? AND norm = ? ORDER BY updated_at DESC`).get(owner, norm) as MemoryRow | undefined
  }

  updateMemory(id: string, patch: Partial<Pick<MemoryRow, 'scope' | 'project_id' | 'kind' | 'content' | 'status' | 'explicit' | 'reason'>> & { norm?: string }): void {
    const ALLOWED = ['scope', 'project_id', 'kind', 'content', 'status', 'explicit', 'reason', 'norm'] as const
    const keys = (Object.keys(patch) as Array<keyof typeof patch>).filter(k => (ALLOWED as readonly string[]).includes(k))
    if (keys.length === 0) return
    this.db.prepare(`UPDATE memories SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => patch[k] as never), now(), id)
  }

  setMemoryEmbedding(id: string, v: Float32Array | null): void {
    this.db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(v ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null, id)
  }

  /** 有向量的记忆（相似去重、按相关度挑选注入）。 */
  memoryVectors(owner: string, statuses: MemoryStatus[]): Array<{ id: string; v: Float32Array }> {
    const rows = this.db.prepare(`SELECT id, embedding FROM memories WHERE owner = ? AND embedding IS NOT NULL AND status IN (${statuses.map(() => '?').join(',')})`).all(owner, ...statuses) as Array<{ id: string; embedding: Uint8Array }>
    return rows.map(r => ({ id: r.id, v: new Float32Array(new Uint8Array(r.embedding).buffer) }))
  }

  deleteMemory(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM memory_events WHERE memory_id = ?').run(id)
    })
  }

  /** 清空：owner 给定时只清这个用户，否则清全部（管理员停用记忆）。 */
  clearMemories(owner?: string): number {
    return this.transaction(() => {
      if (owner) {
        this.db.prepare('DELETE FROM memory_events WHERE owner = ?').run(owner)
        this.db.prepare('DELETE FROM memory_signals WHERE owner = ?').run(owner)
        this.db.prepare('DELETE FROM memory_changes WHERE owner = ?').run(owner)
        return Number(this.db.prepare('DELETE FROM memories WHERE owner = ?').run(owner).changes)
      }
      this.db.exec('DELETE FROM memory_events; DELETE FROM memory_signals; DELETE FROM memory_changes')
      return Number(this.db.prepare('DELETE FROM memories').run().changes)
    })
  }

  addMemoryEvent(e: Omit<MemoryEventRow, 'id' | 'at'>): void {
    this.db.prepare('INSERT INTO memory_events (id, memory_id, owner, action, actor, before, after, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), e.memory_id, e.owner, e.action, e.actor, e.before, e.after, now())
  }

  memoryEvents(memoryId: string): MemoryEventRow[] {
    return this.db.prepare('SELECT id, memory_id, owner, action, actor, before, after, at FROM memory_events WHERE memory_id = ? ORDER BY at').all(memoryId) as unknown as MemoryEventRow[]
  }

  /** 记一次使用（注入回合、检索命中）。不动 updated_at（那是内容变化的时间）。 */
  touchMemories(ids: string[]): void {
    if (ids.length === 0) return
    const t = now()
    const st = this.db.prepare('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    for (const id of ids) st.run(t, id)
  }

  // —— 机构幻灯片模板 ——

  addTenantTemplate(t: Omit<TenantTemplateRow, 'id' | 'created_at' | 'updated_at' | 'logo' | 'logo_mime'>): TenantTemplateRow {
    const id = 'ot' + randomUUID().replace(/-/g, '').slice(0, 10)
    const at = now()
    this.db.prepare('INSERT INTO tenant_templates (id, tenant_id, label, description, org_name, footer, base, colors, fonts, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, t.tenant_id, t.label, t.description, t.org_name, t.footer, t.base, t.colors, t.fonts, t.created_by, at, at)
    return this.getTenantTemplate(id)!
  }

  getTenantTemplate(id: string): TenantTemplateRow | undefined {
    return this.db.prepare('SELECT * FROM tenant_templates WHERE id = ?').get(id) as unknown as TenantTemplateRow | undefined
  }

  listTenantTemplates(tenantId?: string): TenantTemplateRow[] {
    return (tenantId
      ? this.db.prepare('SELECT * FROM tenant_templates WHERE tenant_id = ? ORDER BY created_at').all(tenantId)
      : this.db.prepare('SELECT * FROM tenant_templates ORDER BY created_at').all()) as unknown as TenantTemplateRow[]
  }

  updateTenantTemplate(id: string, patch: Partial<Pick<TenantTemplateRow, 'label' | 'description' | 'org_name' | 'footer' | 'base' | 'colors' | 'fonts' | 'logo' | 'logo_mime'>>): void {
    const ALLOWED = ['label', 'description', 'org_name', 'footer', 'base', 'colors', 'fonts', 'logo', 'logo_mime'] as const
    const keys = (Object.keys(patch) as Array<keyof typeof patch>).filter(k => (ALLOWED as readonly string[]).includes(k))
    if (keys.length === 0) return
    this.db.prepare(`UPDATE tenant_templates SET ${[...keys.map(k => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`).run(...keys.map(k => patch[k] as string | Uint8Array | null), now(), id)
  }

  deleteTenantTemplate(id: string): void {
    this.db.prepare('DELETE FROM tenant_templates WHERE id = ?').run(id)
  }

  // —— 科室 ——

  listDepartments(tenantId: string): Array<DepartmentRow & { members: string[] }> {
    const rows = this.db.prepare('SELECT * FROM tenant_departments WHERE tenant_id = ? ORDER BY created_at').all(tenantId) as unknown as DepartmentRow[]
    if (rows.length === 0) return []
    const memberRows = this.db.prepare(
      'SELECT dm.department_id, dm.user_id FROM department_members dm JOIN tenant_departments d ON d.id = dm.department_id WHERE d.tenant_id = ? ORDER BY dm.added_at',
    ).all(tenantId) as Array<{ department_id: string; user_id: string }>
    const byDept = new Map<string, string[]>()
    for (const m of memberRows) {
      let arr = byDept.get(m.department_id)
      if (!arr) { arr = []; byDept.set(m.department_id, arr) }
      arr.push(m.user_id)
    }
    return rows.map(d => ({ ...d, members: byDept.get(d.id) ?? [] }))
  }

  getDepartment(id: string): DepartmentRow | undefined {
    return this.db.prepare('SELECT * FROM tenant_departments WHERE id = ?').get(id) as unknown as DepartmentRow | undefined
  }

  addDepartment(tenantId: string, name: string): DepartmentRow {
    const id = 'dp' + randomUUID().replace(/-/g, '').slice(0, 10)
    this.db.prepare('INSERT INTO tenant_departments (id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, tenantId, name, now())
    return this.getDepartment(id)!
  }

  renameDepartment(id: string, name: string): void {
    this.db.prepare('UPDATE tenant_departments SET name = ? WHERE id = ?').run(name, id)
  }

  deleteDepartment(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM department_members WHERE department_id = ?').run(id)
      this.db.prepare('DELETE FROM tenant_departments WHERE id = ?').run(id)
    })
  }

  /** 科室成员整体替换（一人可在多个科室）。 */
  setDepartmentMembers(id: string, userIds: string[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM department_members WHERE department_id = ?').run(id)
      const st = this.db.prepare('INSERT OR IGNORE INTO department_members (department_id, user_id, added_at) VALUES (?, ?, ?)')
      for (const u of userIds) st.run(id, u, now())
    })
  }

  departmentsOfUser(userId: string): string[] {
    return (this.db.prepare('SELECT department_id FROM department_members WHERE user_id = ?').all(userId) as Array<{ department_id: string }>).map(r => r.department_id)
  }

  // —— 知家分享 ——

  addShare(s: Omit<PhrShareRow, 'id' | 'status' | 'created_at' | 'revoked_at' | 'imported_at' | 'imported_by' | 'imported_patient_id'>): PhrShareRow {
    const id = 'sh' + randomUUID().replace(/-/g, '').slice(0, 12)
    this.db.prepare(`INSERT INTO phr_shares (id, owner, source_tenant_id, patient_id, tenant_id, department_id, doctor_id, scope, allow_import, display_name_enc, expires_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
      .run(id, s.owner, s.source_tenant_id, s.patient_id, s.tenant_id, s.department_id, s.doctor_id, s.scope, s.allow_import, s.display_name_enc, s.expires_at, now())
    return this.getShare(id)!
  }

  getShare(id: string): PhrShareRow | undefined {
    return this.db.prepare('SELECT * FROM phr_shares WHERE id = ?').get(id) as unknown as PhrShareRow | undefined
  }

  sharesOf(owner: string, patientId: string): PhrShareRow[] {
    return this.db.prepare('SELECT * FROM phr_shares WHERE owner = ? AND patient_id = ? ORDER BY created_at DESC').all(owner, patientId) as unknown as PhrShareRow[]
  }

  /** 发给某医院、仍有效的分享（到期在服务层判断）。 */
  sharesToTenant(tenantId: string): PhrShareRow[] {
    return this.db.prepare("SELECT * FROM phr_shares WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC").all(tenantId) as unknown as PhrShareRow[]
  }

  revokeShare(id: string): void {
    this.db.prepare("UPDATE phr_shares SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now(), id)
  }

  markShareImported(id: string, by: string, patientId: string): void {
    this.db.prepare('UPDATE phr_shares SET imported_at = ?, imported_by = ?, imported_patient_id = ? WHERE id = ?').run(now(), by, patientId, id)
  }

  // —— 认领码与患者绑定 (PATIENT.md §4) ——

  addClaim(c: Pick<PhrClaimRow, 'code' | 'tenant_id' | 'patient_id' | 'created_by' | 'expires_at'>): PhrClaimRow {
    const id = 'clm' + randomUUID().replace(/-/g, '').slice(0, 12)
    this.db.prepare(`INSERT INTO phr_claims (id, code, tenant_id, patient_id, created_by, expires_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).run(id, c.code, c.tenant_id, c.patient_id, c.created_by, c.expires_at, now())
    return this.getClaim(id)!
  }

  getClaim(id: string): PhrClaimRow | undefined {
    return this.db.prepare('SELECT * FROM phr_claims WHERE id = ?').get(id) as unknown as PhrClaimRow | undefined
  }

  getClaimByCode(code: string): PhrClaimRow | undefined {
    return this.db.prepare('SELECT * FROM phr_claims WHERE code = ?').get(code) as unknown as PhrClaimRow | undefined
  }

  updateClaim(id: string, patch: Partial<PhrClaimRow>): void {
    const ALLOWED = [
      'code', 'tenant_id', 'patient_id', 'created_by', 'expires_at', 'status',
      'claimant_user_id', 'claimant_patient_id', 'requested_at',
      'confirmed_by', 'confirmed_at', 'revoked_by', 'revoked_at', 'created_at',
    ] as const
    const keys = Object.keys(patch).filter(k => (ALLOWED as readonly string[]).includes(k))
    if (keys.length === 0) return
    const sets = keys.map(k => `${k} = ?`).join(', ')
    const vals = keys.map(k => (patch as Record<string, any>)[k])
    this.db.prepare(`UPDATE phr_claims SET ${sets} WHERE id = ?`).run(...(vals as any[]), id)
  }

  listClaimsForPatient(tenantId: string, patientId: string): PhrClaimRow[] {
    return this.db.prepare('SELECT * FROM phr_claims WHERE tenant_id = ? AND patient_id = ? ORDER BY created_at DESC').all(tenantId, patientId) as unknown as PhrClaimRow[]
  }

  addPersonLink(l: Pick<PersonLinkRow, 'tenant_id' | 'hospital_patient_id' | 'claimant_user_id' | 'claimant_patient_id' | 'claim_id' | 'verified_by'>): PersonLinkRow {
    const id = 'plk' + randomUUID().replace(/-/g, '').slice(0, 12)
    const t = now()
    this.db.prepare(`INSERT INTO person_links (id, tenant_id, hospital_patient_id, claimant_user_id, claimant_patient_id, claim_id, verified_by, verified_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`).run(id, l.tenant_id, l.hospital_patient_id, l.claimant_user_id, l.claimant_patient_id, l.claim_id, l.verified_by, t, t)
    return this.getPersonLink(id)!
  }

  getPersonLink(id: string): PersonLinkRow | undefined {
    return this.db.prepare('SELECT * FROM person_links WHERE id = ?').get(id) as unknown as PersonLinkRow | undefined
  }

  revokePersonLink(id: string, revokedBy: string): void {
    this.db.prepare("UPDATE person_links SET status = 'revoked', revoked_by = ?, revoked_at = ? WHERE id = ?").run(revokedBy, now(), id)
  }

  listLinksForHospitalPatient(tenantId: string, patientId: string): PersonLinkRow[] {
    return this.db.prepare('SELECT * FROM person_links WHERE tenant_id = ? AND hospital_patient_id = ? ORDER BY created_at DESC').all(tenantId, patientId) as unknown as PersonLinkRow[]
  }

  listLinksForClaimant(claimantUserId: string, claimantPatientId: string): PersonLinkRow[] {
    return this.db.prepare('SELECT * FROM person_links WHERE claimant_user_id = ? AND claimant_patient_id = ? ORDER BY created_at DESC').all(claimantUserId, claimantPatientId) as unknown as PersonLinkRow[]
  }

  // —— 临床研究 ——

  addStudy(s: Pick<StudyRow, 'owner' | 'title' | 'design' | 'status' | 'summary'>): StudyRow {
    return this.transaction(() => {
      const id = 'st' + randomUUID().replace(/-/g, '').slice(0, 10)
      const t = now()
      const tenant = this.getUser(s.owner)?.tenant_id ?? null
      this.db.prepare('INSERT INTO studies (id, owner, title, design, status, summary, created_at, updated_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, s.owner, s.title, s.design, s.status, s.summary, t, t, tenant)
      this.db.prepare("INSERT INTO study_members (study_id, user_id, role, added_by, added_at) VALUES (?, ?, 'owner', ?, ?)").run(id, s.owner, s.owner, t)
      return this.getStudy(id)!
    })
  }

  getStudy(id: string): StudyRow | undefined {
    return this.db.prepare('SELECT * FROM studies WHERE id = ?').get(id) as unknown as StudyRow | undefined
  }

  /** 我参与的研究（负责人或成员），带我的角色。 */
  listStudies(user: string): Array<StudyRow & { my_role: StudyRole }> {
    return this.db.prepare('SELECT s.*, m.role AS my_role FROM studies s JOIN study_members m ON m.study_id = s.id AND m.user_id = ? ORDER BY s.updated_at DESC').all(user) as unknown as Array<StudyRow & { my_role: StudyRole }>
  }

  /** 机构里的全部研究（机构管理员做离职交接用） */
  listTenantStudies(tenantId: string): StudyRow[] {
    return this.db.prepare('SELECT * FROM studies WHERE tenant_id = ? ORDER BY updated_at DESC').all(tenantId) as unknown as StudyRow[]
  }

  studyMembers(studyId: string): StudyMemberRow[] {
    return this.db.prepare("SELECT * FROM study_members WHERE study_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, added_at").all(studyId) as unknown as StudyMemberRow[]
  }

  studyRole(studyId: string, userId: string): StudyRole | null {
    return (this.db.prepare('SELECT role FROM study_members WHERE study_id = ? AND user_id = ?').get(studyId, userId) as { role: StudyRole } | undefined)?.role ?? null
  }

  /** 加成员或改角色（owner 只经 transferStudy 设置）。 */
  setStudyMember(m: Omit<StudyMemberRow, 'added_at'>): void {
    this.db.prepare('INSERT INTO study_members (study_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (study_id, user_id) DO UPDATE SET role = excluded.role')
      .run(m.study_id, m.user_id, m.role, m.added_by, now())
  }

  removeStudyMember(studyId: string, userId: string): boolean {
    return Number(this.db.prepare("DELETE FROM study_members WHERE study_id = ? AND user_id = ? AND role != 'owner'").run(studyId, userId).changes) > 0
  }

  /** 转交负责人：新负责人成为 owner，原负责人留作 editor（keepOld=false 时移出，例如离职交接）。 */
  transferStudy(studyId: string, to: string, by: string, keepOld = true): void {
    const st = this.getStudy(studyId)
    if (!st) return
    this.transaction(() => {
      if (keepOld) this.db.prepare("UPDATE study_members SET role = 'editor' WHERE study_id = ? AND user_id = ?").run(studyId, st.owner)
      else this.db.prepare('DELETE FROM study_members WHERE study_id = ? AND user_id = ?').run(studyId, st.owner)
      this.db.prepare("INSERT INTO study_members (study_id, user_id, role, added_by, added_at) VALUES (?, ?, 'owner', ?, ?) ON CONFLICT (study_id, user_id) DO UPDATE SET role = 'owner'").run(studyId, to, by, now())
      this.db.prepare('UPDATE studies SET owner = ?, updated_at = ? WHERE id = ?').run(to, now(), studyId)
    })
  }

  updateStudy(id: string, patch: Partial<Pick<StudyRow, 'title' | 'design' | 'status' | 'summary'>>): void {
    const ALLOWED = ['title', 'design', 'status', 'summary'] as const
    const keys = (Object.keys(patch) as Array<keyof typeof patch>).filter(k => (ALLOWED as readonly string[]).includes(k))
    if (keys.length === 0) return
    this.db.prepare(`UPDATE studies SET ${[...keys.map(k => `${k} = ?`), 'updated_at = ?'].join(', ')} WHERE id = ?`).run(...keys.map(k => patch[k] as string | null), now(), id)
  }

  deleteStudy(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM study_items WHERE study_id = ?').run(id)
      this.db.prepare('DELETE FROM study_members WHERE study_id = ?').run(id)
      this.db.prepare('DELETE FROM studies WHERE id = ?').run(id)
    })
  }

  studyItems(studyId: string): StudyItemRow[] {
    return this.db.prepare('SELECT * FROM study_items WHERE study_id = ? ORDER BY added_at').all(studyId) as unknown as StudyItemRow[]
  }

  /** 某个文档 / 数据集归在哪个研究里（每样只属于一个研究）。 */
  studyOf(kind: StudyItemRow['kind'], refId: string): StudyItemRow | undefined {
    return this.db.prepare('SELECT * FROM study_items WHERE kind = ? AND ref_id = ?').get(kind, refId) as unknown as StudyItemRow | undefined
  }

  addStudyItem(i: Omit<StudyItemRow, 'added_at'>): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO study_items (study_id, kind, ref_id, role, added_at) VALUES (?, ?, ?, ?, ?)').run(i.study_id, i.kind, i.ref_id, i.role, now())
      this.db.prepare('UPDATE studies SET updated_at = ? WHERE id = ?').run(now(), i.study_id)
    })
  }

  removeStudyItem(studyId: string, kind: StudyItemRow['kind'], refId: string): boolean {
    return Number(this.db.prepare('DELETE FROM study_items WHERE study_id = ? AND kind = ? AND ref_id = ?').run(studyId, kind, refId).changes) > 0
  }

  /** 用到这些数据集的、带分析来源的图（不论是谁画的：研究成员的分析都汇总到研究里）。 */
  provenanceAssetsUsing(datasetIds: string[]): Array<{ id: string; owner: string; name: string; created_at: string; provenance: AssetProvenance }> {
    if (!datasetIds.length) return []
    const ids = new Set(datasetIds)
    const clause = datasetIds.map(() => 'instr(provenance, ?) > 0').join(' OR ')
    return (this.db.prepare(`SELECT id, owner, name, created_at, provenance FROM assets WHERE provenance IS NOT NULL AND (${clause}) ORDER BY created_at DESC`).all(...datasetIds.map(id => `"${id}"`)) as Array<{ id: string; owner: string; name: string; created_at: string; provenance: string }>)
      .map(r => ({ ...r, provenance: JSON.parse(r.provenance) as AssetProvenance }))
      .filter(r => r.provenance.datasets.some(d => ids.has(d.id)))
  }

  /** 用户带分析来源的图（研究的「分析」从这里按数据集汇总）。 */
  provenanceAssets(owner: string): Array<{ id: string; name: string; created_at: string; provenance: AssetProvenance }> {
    return (this.db.prepare('SELECT id, name, created_at, provenance FROM assets WHERE owner = ? AND provenance IS NOT NULL ORDER BY created_at DESC').all(owner) as Array<{ id: string; name: string; created_at: string; provenance: string }>)
      .map(r => ({ ...r, provenance: JSON.parse(r.provenance) as AssetProvenance }))
  }

  // —— 数据集 ——

  addDataset(d: Pick<DatasetRow, 'owner' | 'name' | 'filename' | 'format' | 'size' | 'sha256'> & { origin?: string | null; version?: number }): DatasetRow {
    const id = 'ds' + randomUUID().replace(/-/g, '').slice(0, 10)
    const t = now()
    this.db.prepare('INSERT INTO datasets (id, owner, name, filename, format, size, sha256, status, created_at, updated_at, origin, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, d.owner, d.name, d.filename, d.format, d.size, d.sha256, 'processing', t, t, d.origin ?? null, d.version ?? 1)
    return this.getDataset(id)!
  }

  getDataset(id: string): DatasetRow | undefined {
    return this.db.prepare('SELECT * FROM datasets WHERE id = ?').get(id) as DatasetRow | undefined
  }

  findDatasetBySha(owner: string, sha256: string): DatasetRow | undefined {
    return this.db.prepare('SELECT * FROM datasets WHERE owner = ? AND sha256 = ?').get(owner, sha256) as DatasetRow | undefined
  }

  listDatasets(owner: string): DatasetRow[] {
    return this.db.prepare('SELECT * FROM datasets WHERE owner = ? ORDER BY created_at DESC').all(owner) as unknown as DatasetRow[]
  }

  updateDataset(id: string, patch: Partial<Pick<DatasetRow, 'name' | 'status' | 'rows' | 'cols' | 'profile' | 'labels' | 'error' | 'version' | 'origin'>>): void {
    const ALLOWED = ['name', 'status', 'rows', 'cols', 'profile', 'labels', 'error', 'version', 'origin'] as const
    const keys = (Object.keys(patch) as Array<keyof typeof patch>).filter(k => (ALLOWED as readonly string[]).includes(k))
    if (keys.length === 0) return
    this.db.prepare(`UPDATE datasets SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map(k => patch[k] as never), now(), id)
  }

  deleteDataset(id: string): void {
    this.db.prepare('DELETE FROM datasets WHERE id = ?').run(id)
  }

  /** 服务重启时还在处理中的数据集（重新处理）。 */
  processingDatasets(): DatasetRow[] {
    return this.db.prepare("SELECT * FROM datasets WHERE status = 'processing'").all() as unknown as DatasetRow[]
  }

  // —— 记忆演进：信号与整理建议 ——

  /** 同一段落、同一次 AI 写入只记一条（第一次被用户改时的 AI 原文）。返回是否新记了一条。 */
  addMemorySignal(s: Omit<MemorySignalRow, 'id' | 'at' | 'consumed_at'>): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO memory_signals (id, owner, doc_id, node_id, kind, ai_text, user_text, ai_rev, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), s.owner, s.doc_id, s.node_id, s.kind, s.ai_text, s.user_text, s.ai_rev, now())
    return Number(r.changes) > 0
  }

  openMemorySignals(owner: string, limit = 60): MemorySignalRow[] {
    return this.db.prepare('SELECT * FROM memory_signals WHERE owner = ? AND consumed_at IS NULL ORDER BY at DESC LIMIT ?').all(owner, limit) as unknown as MemorySignalRow[]
  }

  consumeMemorySignals(ids: string[]): void {
    const t = now()
    const st = this.db.prepare('UPDATE memory_signals SET consumed_at = ? WHERE id = ?')
    for (const id of ids) st.run(t, id)
  }

  /** 有待整理信号的用户（定时整理用）。 */
  usersWithMemorySignals(min: number): string[] {
    return (this.db.prepare('SELECT owner FROM memory_signals WHERE consumed_at IS NULL GROUP BY owner HAVING COUNT(*) >= ?').all(min) as Array<{ owner: string }>).map(r => r.owner)
  }

  /** 清掉 60 天前的信号（用过的、没用上的都不再需要）。 */
  purgeMemorySignals(days = 60): void {
    this.db.prepare('DELETE FROM memory_signals WHERE at < ?').run(new Date(Date.now() - days * 86_400_000).toISOString())
  }

  addMemoryChange(c: Pick<MemoryChangeRow, 'owner' | 'action' | 'target_ids' | 'content' | 'reason'>): MemoryChangeRow {
    const id = 'c' + randomUUID().replace(/-/g, '').slice(0, 11)
    this.db.prepare('INSERT INTO memory_changes (id, owner, action, target_ids, content, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.owner, c.action, JSON.stringify(c.target_ids), c.content, c.reason, 'pending', now())
    return this.getMemoryChange(id)!
  }

  getMemoryChange(id: string): MemoryChangeRow | undefined {
    const r = this.db.prepare('SELECT * FROM memory_changes WHERE id = ?').get(id) as (Omit<MemoryChangeRow, 'target_ids'> & { target_ids: string }) | undefined
    return r ? { ...r, target_ids: JSON.parse(r.target_ids) as string[] } : undefined
  }

  listMemoryChanges(owner: string, statuses: MemoryChangeRow['status'][], limit = 50): MemoryChangeRow[] {
    const rows = this.db.prepare(`SELECT * FROM memory_changes WHERE owner = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`)
      .all(owner, ...statuses, limit) as Array<Omit<MemoryChangeRow, 'target_ids'> & { target_ids: string }>
    return rows.map(r => ({ ...r, target_ids: JSON.parse(r.target_ids) as string[] }))
  }

  resolveMemoryChange(id: string, status: 'applied' | 'dismissed'): void {
    this.db.prepare('UPDATE memory_changes SET status = ?, resolved_at = ? WHERE id = ?').run(status, now(), id)
  }

  // —— 执行与自演进信号 / Harness 策略规则 ——

  addExecutionSignal(s: Omit<ExecutionSignalRow, 'id' | 'at' | 'consumed_at'>): ExecutionSignalRow {
    const id = `es_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const t = now()
    this.db.prepare('INSERT INTO execution_signals (id, owner, doc_id, turn_id, kind, code, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, s.owner, s.doc_id, s.turn_id ?? null, s.kind, s.code, s.detail ?? null, t)
    return { id, owner: s.owner, doc_id: s.doc_id, turn_id: s.turn_id ?? null, kind: s.kind, code: s.code, detail: s.detail ?? null, consumed_at: null, at: t }
  }

  openExecutionSignals(owner: string, limit = 50): ExecutionSignalRow[] {
    if (owner === 'system') {
      return this.db.prepare('SELECT * FROM execution_signals WHERE consumed_at IS NULL ORDER BY at DESC LIMIT ?').all(limit) as unknown as ExecutionSignalRow[]
    }
    return this.db.prepare('SELECT * FROM execution_signals WHERE (owner = ? OR owner = \'system\') AND consumed_at IS NULL ORDER BY at DESC LIMIT ?').all(owner, limit) as unknown as ExecutionSignalRow[]
  }

  consumeExecutionSignals(ids: string[]): void {
    if (ids.length === 0) return
    const t = now()
    const q = ids.map(() => '?').join(',')
    this.db.prepare(`UPDATE execution_signals SET consumed_at = ? WHERE id IN (${q})`).run(t, ...ids)
  }

  addHarnessRule(r: Omit<HarnessRuleRow, 'id' | 'created_at' | 'updated_at'>): HarnessRuleRow {
    const id = `hr_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const t = now()
    this.db.prepare('INSERT INTO harness_rules (id, scope, owner, project_id, category, trigger_pattern, rule, evidence_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, r.scope, r.owner, r.project_id ?? null, r.category, r.trigger_pattern, r.rule, r.evidence_count ?? 1, r.status ?? 'active', t, t)
    return { id, ...r, created_at: t, updated_at: t }
  }

  listHarnessRules(owner: string, statuses: HarnessRuleRow['status'][] = ['active']): HarnessRuleRow[] {
    const q = statuses.map(() => '?').join(',')
    return this.db.prepare(`SELECT * FROM harness_rules WHERE (owner = ? OR owner = 'system') AND status IN (${q}) ORDER BY evidence_count DESC, updated_at DESC`)
      .all(owner, ...statuses) as unknown as HarnessRuleRow[]
  }

  bumpHarnessRule(id: string): void {
    this.db.prepare('UPDATE harness_rules SET evidence_count = evidence_count + 1, updated_at = ? WHERE id = ?').run(now(), id)
  }

  deleteHarnessRule(owner: string, id: string): boolean {
    return Number(this.db.prepare("DELETE FROM harness_rules WHERE id = ? AND owner = ? AND owner != 'system'").run(id, owner).changes) > 0
  }

  executionSignalStats(): { total: number; unconsumed: number; active_rules: number } {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM execution_signals').get() as { n: number }).n
    const unconsumed = (this.db.prepare('SELECT COUNT(*) AS n FROM execution_signals WHERE consumed_at IS NULL').get() as { n: number }).n
    const active_rules = (this.db.prepare("SELECT COUNT(*) AS n FROM harness_rules WHERE status = 'active'").get() as { n: number }).n
    return { total, unconsumed, active_rules }
  }

  /** 用户在某时间之后发的对话消息（整理时看有没有反复强调的要求）。 */
  userMessagesSince(owner: string, since: string | null, limit = 40): Array<{ text: string; doc_id: string; created_at: string }> {
    return this.db.prepare(`SELECT m.text, m.doc_id, m.created_at FROM messages m JOIN docs d ON d.id = m.doc_id
      WHERE d.owner = ? AND m.role = 'user' AND m.created_at > ? ORDER BY m.created_at DESC LIMIT ?`).all(owner, since ?? '', limit) as Array<{ text: string; doc_id: string; created_at: string }>
  }

  /** 某个节点的 AI 写入：最近一次 AI 改动的 rev 与时间。 */
  lastAiWrite(docId: string, nodeId: string): { rev: number; at: string } | null {
    const r = this.db.prepare(`SELECT nc.rev AS rev, o.created_at AS at FROM node_changes nc JOIN op_log o ON o.doc_id = nc.doc_id AND o.rev = nc.rev
      WHERE nc.doc_id = ? AND nc.node_id = ? AND nc.actor = 'ai' ORDER BY nc.rev DESC LIMIT 1`).get(docId, nodeId) as { rev: number; at: string } | undefined
    return r ?? null
  }

  // —— 项目（文件夹） ——

  createProject(owner: string, name: string): ProjectRow {
    const id = 'p' + randomUUID().replace(/-/g, '').slice(0, 11)
    this.db.prepare('INSERT INTO projects (id, owner, name, created_at) VALUES (?, ?, ?, ?)').run(id, owner, name, now())
    return this.getProject(id)!
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined
  }

  listProjects(owner: string): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects WHERE owner = ? ORDER BY created_at').all(owner) as unknown as ProjectRow[]
  }

  renameProject(id: string, name: string): void {
    this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
  }

  /** 删除项目：里面的文档回到「未分组」（不删文档）。 */
  deleteProject(id: string): void {
    this.transaction(() => {
      this.db.prepare('UPDATE docs SET project_id = NULL WHERE project_id = ?').run(id)
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    })
  }

  // —— 全文搜索（FTS5 trigram：3 个字及以上走索引；1–2 个字退回 LIKE） ——

  indexDoc(doc: { id: string; owner: string; title: string }, body: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(doc.id)
      this.db.prepare('INSERT INTO docs_fts (doc_id, owner, title, body) VALUES (?, ?, ?, ?)').run(doc.id, doc.owner, doc.title, body)
    })
  }

  unindexDoc(id: string): void {
    this.db.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(id)
  }

  indexedDocIds(): Set<string> {
    return new Set((this.db.prepare('SELECT doc_id FROM docs_fts').all() as Array<{ doc_id: string }>).map(r => r.doc_id))
  }

  searchDocs(owner: string, query: string, limit = 20): SearchHit[] {
    const q = query.trim()
    if (!q) return []
    const base = `SELECT d.id AS doc_id, d.title, d.kind, d.project_id, d.updated_at, f.body AS body FROM docs_fts f JOIN docs d ON d.id = f.doc_id
      WHERE f.owner = ? AND d.deleted_at IS NULL AND d.context IS NULL`
    let rows: Array<{ doc_id: string; title: string; kind: DocKind; project_id: string | null; updated_at: string; body: string }>
    if ([...q].length >= 3) {
      // trigram 匹配：整串当作短语
      const phrase = `"${q.replace(/"/g, '""')}"`
      rows = this.db.prepare(`${base} AND docs_fts MATCH ? ORDER BY bm25(docs_fts, 0, 0, 5, 1) LIMIT ?`).all(owner, phrase, limit) as never
    } else {
      const like = `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`
      rows = this.db.prepare(`${base} AND (f.title LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\') ORDER BY (f.title LIKE ? ESCAPE '\\') DESC, d.updated_at DESC LIMIT ?`).all(owner, like, like, like, limit) as never
    }
    return rows.map(r => ({ doc_id: r.doc_id, title: r.title, kind: r.kind, project_id: r.project_id, updated_at: r.updated_at, snippet: snippetOf(r.title, r.body, q) }))
  }

  getState(id: string): Uint8Array | null {
    const row = this.db.prepare('SELECT state FROM docs WHERE id = ?').get(id) as { state: Uint8Array | null } | undefined
    return row?.state ?? null
  }

  renameDoc(id: string, title: string): void {
    this.db.prepare('UPDATE docs SET title = ?, updated_at = ? WHERE id = ?').run(title, now(), id)
  }

  deleteDoc(id: string): void {
    this.transaction(() => {
      this.unindexDoc(id)
      this.db.prepare('DELETE FROM docs WHERE id = ?').run(id)
    })
  }

  /**
   * 一次提交：rev+1、写状态、追加 op log 与节点变更索引——同一事务。
   * 返回新 rev。
   */
  commit(input: {
    docId: string
    actor: Actor
    turnId: string | null
    state: Uint8Array
    ops: unknown
    changes: Array<{ node_id: string; kind: 'added' | 'modified' | 'removed' }>
  }): number {
    return this.transaction(() => {
      const doc = this.getDoc(input.docId)
      if (!doc) throw new Error(`doc ${input.docId} not found`)
      const rev = doc.rev + 1
      const t = now()
      this.db.prepare('UPDATE docs SET rev = ?, state = ?, updated_at = ? WHERE id = ?').run(rev, input.state, t, input.docId)
      this.db.prepare('INSERT INTO op_log (doc_id, rev, actor, turn_id, ops, affected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.docId, rev, input.actor, input.turnId, JSON.stringify(input.ops), JSON.stringify(input.changes), t)
      const ins = this.db.prepare('INSERT INTO node_changes (doc_id, rev, node_id, actor, kind) VALUES (?, ?, ?, ?, ?)')
      for (const c of input.changes) ins.run(input.docId, rev, c.node_id, input.actor, c.kind)
      return rev
    })
  }

  /** 节点在 sinceRev 之后是否被某类写者改过（冲突守卫）。 */
  lastChangeBy(docId: string, nodeId: string, actor: Actor): number {
    const row = this.db.prepare('SELECT MAX(rev) AS rev FROM node_changes WHERE doc_id = ? AND node_id = ? AND actor = ?')
      .get(docId, nodeId, actor) as { rev: number | null }
    return row.rev ?? 0
  }

  /** 某回合涉及的文档。 */
  docsTouchedByTurn(turnId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT doc_id FROM op_log WHERE turn_id = ?').all(turnId) as Array<{ doc_id: string }>).map(r => r.doc_id)
  }

  opLog(docId: string, sinceRev = 0): Array<{ rev: number; actor: Actor; turn_id: string | null; affected: unknown; created_at: string }> {
    return (this.db.prepare('SELECT rev, actor, turn_id, affected, created_at FROM op_log WHERE doc_id = ? AND rev > ? ORDER BY rev')
      .all(docId, sinceRev) as Array<{ rev: number; actor: Actor; turn_id: string | null; affected: string; created_at: string }>)
      .map(r => ({ ...r, affected: JSON.parse(r.affected) }))
  }

  // —— 版本 ——

  addVersion(input: { docId: string; rev: number; source: VersionSource; turnId?: string | null; note: string; state: Uint8Array }): VersionRow {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM versions WHERE doc_id = ?').get(input.docId) as { seq: number }
    const seq = row.seq + 1
    this.db.prepare('INSERT INTO versions (doc_id, seq, rev, source, turn_id, note, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.docId, seq, input.rev, input.source, input.turnId ?? null, input.note, input.state, now())
    return this.getVersion(input.docId, seq)!
  }

  getVersion(docId: string, seq: number): VersionRow | undefined {
    return this.db.prepare('SELECT doc_id, seq, rev, source, turn_id, note, created_at FROM versions WHERE doc_id = ? AND seq = ?')
      .get(docId, seq) as VersionRow | undefined
  }

  getVersionState(docId: string, seq: number): Uint8Array | null {
    const row = this.db.prepare('SELECT state FROM versions WHERE doc_id = ? AND seq = ?').get(docId, seq) as { state: Uint8Array } | undefined
    return row?.state ?? null
  }

  listVersions(docId: string): VersionRow[] {
    return this.db.prepare('SELECT doc_id, seq, rev, source, turn_id, note, created_at FROM versions WHERE doc_id = ? ORDER BY seq DESC')
      .all(docId) as unknown as VersionRow[]
  }

  latestVersion(docId: string): VersionRow | undefined {
    return this.db.prepare('SELECT doc_id, seq, rev, source, turn_id, note, created_at FROM versions WHERE doc_id = ? ORDER BY seq DESC LIMIT 1')
      .get(docId) as VersionRow | undefined
  }

  // —— 原始 XML ——

  putNodeSrc(docId: string, entries: Array<{ node_id: string; xml: string }>): void {
    const ins = this.db.prepare('INSERT OR REPLACE INTO node_src (doc_id, node_id, xml) VALUES (?, ?, ?)')
    for (const e of entries) ins.run(docId, e.node_id, e.xml)
  }

  getNodeSrc(docId: string, nodeId: string): string | null {
    const row = this.db.prepare('SELECT xml FROM node_src WHERE doc_id = ? AND node_id = ?').get(docId, nodeId) as { xml: string } | undefined
    return row?.xml ?? null
  }

  // —— 论断核对 ——

  /** 开放获取全文缓存（text 为 null = 查过没有；过一段时间可重查）。 */
  getFullText(doi: string): { source: string | null; url: string | null; license: string | null; text: string | null; fetched_at: string } | null {
    return (this.db.prepare('SELECT source, url, license, text, fetched_at FROM citation_fulltexts WHERE doi = ?').get(doi) as never) ?? null
  }

  putFullText(doi: string, row: { source: string | null; url: string | null; license: string | null; text: string | null }): void {
    this.db.prepare('INSERT INTO citation_fulltexts (doi, source, url, license, text, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (doi) DO UPDATE SET source = excluded.source, url = excluded.url, license = excluded.license, text = excluded.text, fetched_at = excluded.fetched_at')
      .run(doi, row.source, row.url, row.license, row.text, now())
  }

  getAbstract(doi: string): { pmid: string | null; abstract: string | null } | null {
    return (this.db.prepare('SELECT pmid, abstract FROM citation_abstracts WHERE doi = ?').get(doi) as { pmid: string | null; abstract: string | null } | undefined) ?? null
  }

  putAbstract(doi: string, pmid: string | null, abstract: string | null): void {
    this.db.prepare('INSERT OR REPLACE INTO citation_abstracts (doi, pmid, abstract, fetched_at) VALUES (?, ?, ?, ?)').run(doi, pmid, abstract, now())
  }

  getClaimCheck(docId: string, claimId: string): ClaimCheckRow | undefined {
    return this.db.prepare('SELECT * FROM claim_checks WHERE doc_id = ? AND claim_id = ?').get(docId, claimId) as ClaimCheckRow | undefined
  }

  putClaimCheck(row: Omit<ClaimCheckRow, 'created_at'>): void {
    this.db.prepare('INSERT OR REPLACE INTO claim_checks (doc_id, claim_id, node_id, sentence, verdict, reason, comment_id, rev, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.doc_id, row.claim_id, row.node_id, row.sentence, row.verdict, row.reason, row.comment_id, row.rev, now())
  }

  listClaimChecks(docId: string): ClaimCheckRow[] {
    return this.db.prepare('SELECT * FROM claim_checks WHERE doc_id = ? ORDER BY created_at DESC').all(docId) as unknown as ClaimCheckRow[]
  }

  /** 将某条论断标记为临床经验豁免（关闭关联评论并豁免后续文献比对）。 */
  exemptClaim(docId: string, claimId: string, reason = '已标记为临床经验/无需出处，豁免文献核对'): void {
    this.transaction(() => {
      const existing = this.getClaimCheck(docId, claimId)
      if (existing) {
        this.db.prepare('UPDATE claim_checks SET verdict = ?, reason = ? WHERE doc_id = ? AND claim_id = ?')
          .run('exempted', reason, docId, claimId)
        if (existing.comment_id) {
          this.addReply(existing.comment_id, 'user', `【临床经验豁免】：${reason}`)
          this.setCommentStatus(docId, existing.comment_id, 'resolved', 'user')
        }
      } else {
        this.putClaimCheck({
          doc_id: docId,
          claim_id: claimId,
          node_id: '',
          sentence: '',
          verdict: 'exempted',
          reason,
          comment_id: null,
          rev: 0,
        })
      }
    })
  }

  // —— AI 回合开始前的状态（撤销本轮的持久化依据） ——

  putTurnBase(turnId: string, docId: string, state: Uint8Array): void {
    this.db.prepare('INSERT OR IGNORE INTO turn_bases (turn_id, doc_id, state) VALUES (?, ?, ?)').run(turnId, docId, state)
  }

  getTurnBase(turnId: string, docId: string): { state: Uint8Array; reverted: boolean } | null {
    const row = this.db.prepare('SELECT state, reverted FROM turn_bases WHERE turn_id = ? AND doc_id = ?').get(turnId, docId) as { state: Uint8Array; reverted: number } | undefined
    return row ? { state: row.state, reverted: row.reverted === 1 } : null
  }

  markTurnReverted(turnId: string, docId: string): void {
    this.db.prepare('UPDATE turn_bases SET reverted = 1 WHERE turn_id = ? AND doc_id = ?').run(turnId, docId)
  }

  /** 某回合在某文档上的节点变更（按 rev 顺序）与该回合的 rev 范围。 */
  turnChanges(turnId: string, docId: string): { changes: Array<{ node_id: string; kind: 'added' | 'modified' | 'removed' }>; minRev: number; maxRev: number } {
    const rows = this.db.prepare('SELECT rev, affected FROM op_log WHERE doc_id = ? AND turn_id = ? ORDER BY rev').all(docId, turnId) as Array<{ rev: number; affected: string }>
    return {
      changes: rows.flatMap(r => JSON.parse(r.affected) as Array<{ node_id: string; kind: 'added' | 'modified' | 'removed' }>),
      minRev: rows[0]?.rev ?? 0,
      maxRev: rows.at(-1)?.rev ?? 0,
    }
  }

  /** sinceRev 之后被用户改过的节点。 */
  userTouchedSince(docId: string, sinceRev: number): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT node_id FROM node_changes WHERE doc_id = ? AND actor = \'user\' AND rev > ?').all(docId, sinceRev) as Array<{ node_id: string }>
    return new Set(rows.map(r => r.node_id))
  }

  // —— 原始文件包（修补式导出的底座：样式、编号、关系、媒体） ——

  putPackage(docId: string, kind: 'docx' | 'pptx' | 'pdf', bytes: Uint8Array): void {
    this.db.prepare('INSERT OR REPLACE INTO doc_packages (doc_id, kind, bytes) VALUES (?, ?, ?)').run(docId, kind, bytes)
  }

  getPackage(docId: string): Uint8Array | null {
    const row = this.db.prepare('SELECT bytes FROM doc_packages WHERE doc_id = ?').get(docId) as { bytes: Uint8Array } | undefined
    return row?.bytes ?? null
  }

  // —— 资产 ——

  putAsset(input: { owner: string; mime: string; name: string; bytes: Uint8Array; provenance?: AssetProvenance | null }): AssetRow {
    const id = 'a' + randomUUID().replace(/-/g, '').slice(0, 15)
    this.db.prepare('INSERT INTO assets (id, owner, mime, name, size, bytes, created_at, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.owner, input.mime, input.name, input.bytes.byteLength, input.bytes, now(), input.provenance ? JSON.stringify(input.provenance) : null)
    return this.getAsset(id)!
  }

  getAsset(id: string): AssetRow | undefined {
    return this.db.prepare('SELECT id, owner, mime, name, size, created_at FROM assets WHERE id = ?').get(id) as AssetRow | undefined
  }

  /** 由分析生成的图：生成它的代码与用到的数据集（没有则 null）。 */
  getAssetProvenance(id: string): AssetProvenance | null {
    const row = this.db.prepare('SELECT provenance FROM assets WHERE id = ?').get(id) as { provenance: string | null } | undefined
    return row?.provenance ? JSON.parse(row.provenance) as AssetProvenance : null
  }

  getAssetBytes(id: string): Uint8Array | null {
    const row = this.db.prepare('SELECT bytes FROM assets WHERE id = ?').get(id) as { bytes: Uint8Array } | undefined
    return row?.bytes ?? null
  }

  // —— 引用 ——

  /** formatted 由已清理的文献元数据生成（清理在抓取器里做一次），这里原样存。 */
  upsertCitation(input: { doc_id: string; doi: string; pmid: string | null; formatted: string; url: string | null }): CitationRow {
    const existing = this.db.prepare('SELECT * FROM citations WHERE doc_id = ? AND doi = ?').get(input.doc_id, input.doi) as CitationRow | undefined
    if (existing) {
      if (input.formatted && input.formatted !== existing.formatted) {
        this.db.prepare('UPDATE citations SET formatted = ?, pmid = COALESCE(?, pmid), url = COALESCE(?, url) WHERE id = ?')
          .run(input.formatted, input.pmid, input.url, existing.id)
        return this.db.prepare('SELECT * FROM citations WHERE id = ?').get(existing.id) as unknown as CitationRow
      }
      return existing
    }
    const id = 'c' + randomUUID().replace(/-/g, '').slice(0, 7)
    this.db.prepare('INSERT INTO citations (id, doc_id, doi, pmid, formatted, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.doc_id, input.doi, input.pmid, input.formatted, input.url, now())
    return this.db.prepare('SELECT * FROM citations WHERE id = ?').get(id) as unknown as CitationRow
  }

  /** 按给定 id 写入一条引用（复制文档用）。 */
  insertCitation(c: CitationRow): void {
    this.db.prepare('INSERT INTO citations (id, doc_id, doi, pmid, formatted, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.doc_id, c.doi, c.pmid, c.formatted, c.url, c.created_at)
  }

  copyNodeSrc(from: string, to: string): void {
    this.db.prepare('INSERT INTO node_src (doc_id, node_id, xml) SELECT ?, node_id, xml FROM node_src WHERE doc_id = ?').run(to, from)
  }

  /**
   * 一次性迁移：清理逻辑放到抓取器之前入库的引用可能带 HTML 标签 / 转义实体，在这里清理一遍。
   * cleanBibText 不是幂等的，用 app_settings 里的标记保证只执行一次；清理与写标记在同一事务里，中途崩溃不会留下清理了一半又没标记的状态。
   */
  cleanLegacyCitations(): void {
    const KEY = 'migration.citations_clean_text'
    if (this.db.prepare('SELECT 1 FROM app_settings WHERE key = ?').get(KEY)) return
    this.transaction(() => {
      const rows = this.db.prepare('SELECT id, formatted FROM citations').all() as Array<{ id: string; formatted: string }>
      const update = this.db.prepare('UPDATE citations SET formatted = ? WHERE id = ?')
      for (const r of rows) {
        const clean = cleanBibText(r.formatted)
        if (clean !== r.formatted) update.run(clean, r.id)
      }
      this.db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(KEY, new Date().toISOString())
    })
  }

  listCitations(docId: string): CitationRow[] {
    return this.db.prepare('SELECT * FROM citations WHERE doc_id = ? ORDER BY created_at').all(docId) as unknown as CitationRow[]
  }

  // —— 评论 ——

  addComment(input: { doc_id: string; node_id: string; snippet: string; id?: string; source_ref?: string | null; created_at?: string }): CommentRow {
    const id = input.id ?? newCommentId()
    this.db.prepare('INSERT INTO comments (id, doc_id, node_id, snippet, status, created_at, source_ref) VALUES (?, ?, ?, ?, \'open\', ?, ?)')
      .run(id, input.doc_id, input.node_id, input.snippet, input.created_at ?? now(), input.source_ref ?? null)
    return this.getComment(input.doc_id, id)!
  }

  getComment(docId: string, id: string): CommentRow | undefined {
    const row = this.db.prepare('SELECT * FROM comments WHERE doc_id = ? AND id = ?').get(docId, id) as Omit<CommentRow, 'replies'> | undefined
    if (!row) return undefined
    return { ...row, replies: this.replies(id) }
  }

  listComments(docId: string, status?: 'open' | 'resolved'): CommentRow[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM comments WHERE doc_id = ? AND status = ? ORDER BY created_at').all(docId, status)
      : this.db.prepare('SELECT * FROM comments WHERE doc_id = ? ORDER BY created_at').all(docId)) as unknown as Array<Omit<CommentRow, 'replies'>>
    if (rows.length === 0) return []
    const replyRows = this.db.prepare(
      'SELECT r.* FROM comment_replies r JOIN comments c ON c.id = r.comment_id WHERE c.doc_id = ? ORDER BY r.created_at, r.rowid',
    ).all(docId) as unknown as ReplyRow[]
    const byComment = new Map<string, ReplyRow[]>()
    for (const rep of replyRows) {
      let arr = byComment.get(rep.comment_id)
      if (!arr) { arr = []; byComment.set(rep.comment_id, arr) }
      arr.push(rep)
    }
    return rows.map(r => ({ ...r, replies: byComment.get(r.id) ?? [] }))
  }

  private replies(commentId: string): ReplyRow[] {
    return this.db.prepare('SELECT * FROM comment_replies WHERE comment_id = ? ORDER BY created_at, rowid').all(commentId) as unknown as ReplyRow[]
  }

  addReply(commentId: string, role: 'user' | 'ai', text: string, turnId: string | null = null, author: string | null = null): ReplyRow {
    const id = randomUUID()
    this.db.prepare('INSERT INTO comment_replies (id, comment_id, role, text, turn_id, created_at, author) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, commentId, role, text, turnId, now(), author)
    return this.db.prepare('SELECT * FROM comment_replies WHERE id = ?').get(id) as unknown as ReplyRow
  }

  setCommentStatus(docId: string, id: string, status: 'open' | 'resolved', by: Actor | null): boolean {
    return this.db.prepare('UPDATE comments SET status = ?, resolved_by = ? WHERE doc_id = ? AND id = ?')
      .run(status, by, docId, id).changes > 0
  }

  // —— 回合与对话 ——

  createTurn(input: { user_id: string; doc_id: string | null; message: string; opts?: string }): TurnRow {
    const id = 'r' + randomUUID().replace(/-/g, '').slice(0, 11)
    this.db.prepare('INSERT INTO turns (id, user_id, doc_id, message, status, started_at, opts) VALUES (?, ?, ?, ?, \'running\', ?, ?)')
      .run(id, input.user_id, input.doc_id, input.message, now(), input.opts ?? '{}')
    return this.getTurn(id)!
  }

  getTurn(id: string): TurnRow | undefined {
    return this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as unknown as TurnRow | undefined
  }

  endTurn(id: string, status: TurnRow['status'], error: string | null = null): void {
    this.db.prepare('UPDATE turns SET status = ?, ended_at = ?, error = ? WHERE id = ?').run(status, now(), error, id)
  }

  /** 文档里没有正常完成的回合（对话记录里标出失败原因）。 */
  failedTurns(docId: string): Array<Pick<TurnRow, 'id' | 'status' | 'error' | 'ended_at'>> {
    return this.db.prepare("SELECT id, status, error, ended_at FROM turns WHERE doc_id = ? AND status NOT IN ('done', 'running') ORDER BY started_at, rowid")
      .all(docId) as unknown as Array<Pick<TurnRow, 'id' | 'status' | 'error' | 'ended_at'>>
  }

  listTurns(docId: string): TurnRow[] {
    return this.db.prepare('SELECT * FROM turns WHERE doc_id = ? ORDER BY started_at ASC, rowid ASC').all(docId) as unknown as TurnRow[]
  }

  clearDocTurns(docId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM turns WHERE doc_id = ?').run(docId)
      this.db.prepare('DELETE FROM messages WHERE doc_id = ?').run(docId)
    })
  }

  // —— 回合队列（持久化：服务重启后排队中的任务继续执行） ——

  enqueueJob(job: QueuedJobRow): void {
    this.db.prepare('INSERT INTO turn_queue (id, user_id, doc_id, message, opts, enqueued_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(job.id, job.user_id, job.doc_id, job.message, job.opts, job.enqueued_at)
  }

  dequeueJob(id: string): void {
    this.db.prepare('DELETE FROM turn_queue WHERE id = ?').run(id)
  }

  listQueuedJobs(): QueuedJobRow[] {
    return this.db.prepare('SELECT * FROM turn_queue ORDER BY enqueued_at, rowid').all() as unknown as QueuedJobRow[]
  }

  /** 服务启动时：上次进程里没跑完的回合标为 interrupted。 */
  interruptRunningTurns(): number {
    return Number(this.db.prepare("UPDATE turns SET status = 'interrupted', ended_at = ?, error = '服务重启，回合被中断' WHERE status = 'running'").run(now()).changes)
  }

  /** 评论锚点所在块与引用文字（打锚点 / 重新锚定后同步）。 */
  setCommentAnchor(id: string, nodeId: string, snippet: string): void {
    this.db.prepare('UPDATE comments SET node_id = ?, snippet = ? WHERE id = ?').run(nodeId, snippet, id)
  }

  addMessage(docId: string, role: 'user' | 'assistant', text: string, turnId: string | null): MessageRow {
    const id = randomUUID()
    this.db.prepare('INSERT INTO messages (id, doc_id, role, text, turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, docId, role, text, turnId, now())
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as MessageRow
  }

  listMessages(docId: string): MessageRow[] {
    return this.db.prepare('SELECT * FROM messages WHERE doc_id = ? ORDER BY created_at, rowid').all(docId) as unknown as MessageRow[]
  }

  // —— 邮件 (Mail) ——

  createMailMessage(input: Omit<MailMessageRow, 'id' | 'created_at' | 'folder' | 'delivery_status' | 'delivery_note'> & { id?: string; created_at?: string; folder?: MailMessageRow['folder']; delivery_status?: MailMessageRow['delivery_status']; delivery_note?: string | null; thread_id?: string | null; in_reply_to?: string | null; attachments?: string | null }): MailMessageRow {
    const id = input.id ?? randomUUID()
    const createdAt = input.created_at ?? now()
    const folder = input.folder ?? 'inbox'
    const deliveryStatus = input.delivery_status ?? (folder === 'sent' ? 'delivered' : null)
    const deliveryNote = input.delivery_note ?? null
    const threadId = input.thread_id ?? null
    const inReplyTo = input.in_reply_to ?? null
    const attachments = input.attachments ?? null
    this.db.prepare(`
      INSERT INTO mail_messages (id, user_id, tenant_id, sender, sender_name, recipient, subject, body, category, patient_id, patient_code, study_id, study_title, read, starred, calendar_event_id, folder, delivery_status, delivery_note, thread_id, in_reply_to, attachments, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.user_id, input.tenant_id ?? null, input.sender, input.sender_name,
      input.recipient, input.subject, input.body, input.category,
      input.patient_id ?? null, input.patient_code ?? null, input.study_id ?? null, input.study_title ?? null,
      input.read ? 1 : 0, input.starred ? 1 : 0, input.calendar_event_id ?? null,
      folder, deliveryStatus, deliveryNote, threadId, inReplyTo, attachments, createdAt
    )
    return this.getMailMessage(input.user_id, id)!
  }

  updateMailPatient(userId: string, id: string, patientId: string, patientCode: string): void {
    this.db.prepare('UPDATE mail_messages SET patient_id = ?, patient_code = ? WHERE user_id = ? AND id = ?').run(patientId, patientCode, userId, id)
  }

  updateMailStudy(userId: string, id: string, studyId: string, studyTitle?: string | null): void {
    this.db.prepare('UPDATE mail_messages SET study_id = ?, study_title = ? WHERE user_id = ? AND id = ?').run(studyId, studyTitle ?? null, userId, id)
  }

  updateMailAttachments(userId: string, id: string, attachmentsJson: string): void {
    this.db.prepare('UPDATE mail_messages SET attachments = ? WHERE user_id = ? AND id = ?').run(attachmentsJson, userId, id)
  }

  listThreadMessages(userId: string, targetId: string): MailMessageRow[] {
    const target = this.getMailMessage(userId, targetId)
    if (!target) return []
    const cleanSubject = target.subject.replace(/^(?:(?:\s*(?:re|fwd|fw|回复|转发)[：:]\s*)+)/i, '').trim().toLowerCase()
    const threadKey = target.thread_id || target.id
    const likeSub = cleanSubject ? `%${cleanSubject.replace(/[%_\\]/g, m => '\\' + m)}%` : ''
    const candidates = (cleanSubject
      ? this.db.prepare(`
          SELECT * FROM mail_messages 
          WHERE user_id = ? AND folder != 'trash'
            AND (id = ? OR thread_id = ? OR thread_id = ? OR in_reply_to = ? OR id = ? OR lower(subject) LIKE ? ESCAPE '\\')
          ORDER BY created_at ASC, rowid ASC
        `).all(userId, target.id, threadKey, target.id, target.id, target.in_reply_to ?? '', likeSub)
      : this.db.prepare(`
          SELECT * FROM mail_messages 
          WHERE user_id = ? AND folder != 'trash'
            AND (id = ? OR thread_id = ? OR thread_id = ? OR in_reply_to = ? OR id = ?)
          ORDER BY created_at ASC, rowid ASC
        `).all(userId, target.id, threadKey, target.id, target.id, target.in_reply_to ?? '')
    ) as unknown as MailMessageRow[]

    const thread = candidates.filter(m => {
      if (m.id === target.id) return true
      if (target.thread_id && m.thread_id && target.thread_id === m.thread_id) return true
      if (m.thread_id === target.id || target.thread_id === m.id) return true
      if (m.in_reply_to === target.id || target.in_reply_to === m.id) return true
      const sub = m.subject.replace(/^(?:(?:\s*(?:re|fwd|fw|回复|转发)[：:]\s*)+)/i, '').trim().toLowerCase()
      if (sub === cleanSubject) {
        const sameParty = (m.sender === target.sender || m.recipient === target.sender || m.sender === target.recipient || m.recipient === target.recipient)
        const samePt = Boolean(target.patient_code && m.patient_code && target.patient_code === m.patient_code)
        const sameSt = Boolean(target.study_id && m.study_id && target.study_id === m.study_id)
        return sameParty || samePt || sameSt
      }
      return false
    })

    return thread.length > 0 ? thread : [target]
  }

  listMailMessages(userId: string, filterOrCategory?: string | { category?: string; folder?: string; starred?: boolean; unreadOnly?: boolean; search?: string }): MailMessageRow[] {
    const opts = typeof filterOrCategory === 'string' ? { category: filterOrCategory } : filterOrCategory
    const folder = opts?.folder ?? 'inbox'
    let sql = 'SELECT * FROM mail_messages WHERE user_id = ?'
    const params: any[] = [userId]
    if (folder !== 'all') {
      sql += ' AND folder = ?'
      params.push(folder)
    }
    if (opts?.category && opts.category !== 'all') {
      sql += ' AND category = ?'
      params.push(opts.category)
    }
    if (opts?.starred) {
      sql += ' AND starred = 1'
    }
    if (opts?.unreadOnly) {
      sql += ' AND read = 0'
    }
    if (opts?.search) {
      const q = `%${opts.search.trim().toLowerCase()}%`
      sql += ' AND (LOWER(subject) LIKE ? OR LOWER(sender) LIKE ? OR LOWER(recipient) LIKE ? OR LOWER(body) LIKE ? OR LOWER(COALESCE(patient_code, \'\')) LIKE ? OR LOWER(COALESCE(study_id, \'\')) LIKE ?)'
      params.push(q, q, q, q, q, q)
    }
    sql += ' ORDER BY created_at DESC'
    return this.db.prepare(sql).all(...params) as unknown as MailMessageRow[]
  }

  updateMailDelivery(id: string, status: MailMessageRow['delivery_status'], note?: string | null): void {
    this.db.prepare('UPDATE mail_messages SET delivery_status = ?, delivery_note = ? WHERE id = ?').run(status, note ?? null, id)
  }

  updateMailCleanText(id: string, subject: string, body: string, senderName?: string | null): void {
    this.db.prepare('UPDATE mail_messages SET subject = ?, body = ?, sender_name = ? WHERE id = ?').run(subject, body, senderName ?? null, id)
  }

  getMailMessage(userId: string, id: string): MailMessageRow | undefined {
    return this.db.prepare('SELECT * FROM mail_messages WHERE user_id = ? AND id = ?').get(userId, id) as MailMessageRow | undefined
  }

  markMailRead(userId: string, id: string, read = true): void {
    this.db.prepare('UPDATE mail_messages SET read = ? WHERE user_id = ? AND id = ?').run(read ? 1 : 0, userId, id)
  }

  markAllMailsRead(userId: string): void {
    this.db.prepare('UPDATE mail_messages SET read = 1 WHERE user_id = ?').run(userId)
  }

  setMailStarred(userId: string, id: string, starred = true): void {
    this.db.prepare('UPDATE mail_messages SET starred = ? WHERE user_id = ? AND id = ?').run(starred ? 1 : 0, userId, id)
  }

  moveMailFolder(userId: string, id: string, folder: 'inbox' | 'sent' | 'trash'): void {
    this.db.prepare('UPDATE mail_messages SET folder = ? WHERE user_id = ? AND id = ?').run(folder, userId, id)
  }

  deleteMailMessage(userId: string, id: string): void {
    this.db.prepare('DELETE FROM mail_messages WHERE user_id = ? AND id = ?').run(userId, id)
  }

  batchMarkMailRead(userId: string, ids: string[], read = true): void {
    if (!ids.length) return
    const placeholders = ids.map(() => '?').join(', ')
    this.db.prepare(`UPDATE mail_messages SET read = ? WHERE user_id = ? AND id IN (${placeholders})`).run(read ? 1 : 0, userId, ...ids)
  }

  batchSetMailStarred(userId: string, ids: string[], starred = true): void {
    if (!ids.length) return
    const placeholders = ids.map(() => '?').join(', ')
    this.db.prepare(`UPDATE mail_messages SET starred = ? WHERE user_id = ? AND id IN (${placeholders})`).run(starred ? 1 : 0, userId, ...ids)
  }

  batchMoveMailFolder(userId: string, ids: string[], folder: 'inbox' | 'sent' | 'trash'): void {
    if (!ids.length) return
    const placeholders = ids.map(() => '?').join(', ')
    this.db.prepare(`UPDATE mail_messages SET folder = ? WHERE user_id = ? AND id IN (${placeholders})`).run(folder, userId, ...ids)
  }

  batchDeleteMailMessages(userId: string, ids: string[]): void {
    if (!ids.length) return
    const placeholders = ids.map(() => '?').join(', ')
    this.db.prepare(`DELETE FROM mail_messages WHERE user_id = ? AND id IN (${placeholders})`).run(userId, ...ids)
  }

  emptyMailTrash(userId: string): number {
    const res = this.db.prepare("DELETE FROM mail_messages WHERE user_id = ? AND folder = 'trash'").run(userId)
    return Number(res.changes ?? 0)
  }

  // —— 日历 (Calendar) ——

  createCalendarEvent(input: Omit<CalendarEventRow, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string }): CalendarEventRow {
    const id = input.id ?? randomUUID()
    const t = now()
    this.db.prepare(`
      INSERT INTO calendar_events (id, user_id, tenant_id, title, description, start_time, end_time, all_day, category, status, patient_id, patient_code, study_id, study_title, location, mail_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.user_id, input.tenant_id ?? null, input.title, input.description ?? null,
      input.start_time, input.end_time, input.all_day ? 1 : 0, input.category, input.status ?? 'scheduled',
      input.patient_id ?? null, input.patient_code ?? null, input.study_id ?? null, input.study_title ?? null,
      input.location ?? null, input.mail_id ?? null, input.created_at ?? t, input.updated_at ?? t
    )
    return this.getCalendarEvent(input.user_id, id)!
  }

  listCalendarEvents(userId: string, opts?: { from?: string; to?: string; category?: string; status?: string; search?: string }): CalendarEventRow[] {
    let sql = 'SELECT * FROM calendar_events WHERE user_id = ?'
    const params: any[] = [userId]
    if (opts?.category && opts.category !== 'all') {
      sql += ' AND category = ?'
      params.push(opts.category)
    }
    if (opts?.status && opts.status !== 'all') {
      sql += ' AND status = ?'
      params.push(opts.status)
    }
    if (opts?.from) {
      sql += ' AND end_time >= ?'
      params.push(opts.from)
    }
    if (opts?.to) {
      sql += ' AND start_time <= ?'
      params.push(opts.to)
    }
    if (opts?.search) {
      const q = `%${opts.search.trim().toLowerCase()}%`
      sql += ' AND (LOWER(title) LIKE ? OR LOWER(COALESCE(description, \'\')) LIKE ? OR LOWER(COALESCE(patient_code, \'\')) LIKE ? OR LOWER(COALESCE(study_title, \'\')) LIKE ? OR LOWER(COALESCE(location, \'\')) LIKE ?)'
      params.push(q, q, q, q, q)
    }
    sql += ' ORDER BY start_time ASC'
    return this.db.prepare(sql).all(...params) as unknown as CalendarEventRow[]
  }

  getCalendarEvent(userId: string, id: string): CalendarEventRow | undefined {
    return this.db.prepare('SELECT * FROM calendar_events WHERE user_id = ? AND id = ?').get(userId, id) as CalendarEventRow | undefined
  }

  updateCalendarEvent(userId: string, id: string, patch: Partial<CalendarEventRow>): CalendarEventRow | undefined {
    const existing = this.getCalendarEvent(userId, id)
    if (!existing) return undefined
    const ALLOWED = [
      'tenant_id', 'title', 'description', 'start_time', 'end_time',
      'all_day', 'category', 'status', 'patient_id', 'patient_code',
      'study_id', 'study_title', 'location', 'mail_id',
    ] as const
    const fields: string[] = []
    const values: any[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (!(ALLOWED as readonly string[]).includes(k)) continue
      fields.push(`${k} = ?`)
      values.push(v)
    }
    if (!fields.length) return existing
    fields.push('updated_at = ?')
    values.push(now())
    values.push(userId, id)
    this.db.prepare(`UPDATE calendar_events SET ${fields.join(', ')} WHERE user_id = ? AND id = ?`).run(...values)
    return this.getCalendarEvent(userId, id)
  }

  deleteCalendarEvent(userId: string, id: string): void {
    this.db.prepare('DELETE FROM calendar_events WHERE user_id = ? AND id = ?').run(userId, id)
  }

  batchUpdateCalendarStatus(userId: string, ids: string[], status: 'scheduled' | 'completed'): void {
    if (!ids.length) return
    const placeholders = ids.map(() => '?').join(', ')
    this.db.prepare(`UPDATE calendar_events SET status = ?, updated_at = ? WHERE user_id = ? AND id IN (${placeholders})`).run(status, now(), userId, ...ids)
  }

  batchDeleteCalendarEvents(userId: string, ids: string[]): void {
    if (!ids.length) return
    const placeholders = ids.map(() => '?').join(', ')
    this.db.prepare(`DELETE FROM calendar_events WHERE user_id = ? AND id IN (${placeholders})`).run(userId, ...ids)
  }
}

/** 命中处前后各约 30 字，命中词用 [ ] 括起；正文没命中（只命中标题）时取正文开头。 */
function snippetOf(title: string, body: string, q: string): string {
  const at = body.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return body.slice(0, 60).replace(/\s+/g, ' ')
  const start = Math.max(0, at - 30)
  const end = Math.min(body.length, at + q.length + 30)
  return `${start > 0 ? '…' : ''}${body.slice(start, at)}[${body.slice(at, at + q.length)}]${body.slice(at + q.length, end)}${end < body.length ? '…' : ''}`.replace(/\s+/g, ' ')
}

const KB_STOPWORDS = new Set(('the and for with how does did what which who whom when where why are was were has have had not but from into than that this these those there their they them then also can could would should may might will about after before over under between during within without among per its our your you any all more most much many other such only very just been being is of to in on at by or as an a vs versus').split(' '))

/**
 * 资料库关键词检索的查询词：自然语言问题拆成英文词（≥3 字符，去停用词）与中文三字片段，用 OR 连接交给 FTS5（trigram）按 bm25 排序。
 * 整句当短语匹配几乎永远命中不了。
 */
export function kbQueryTerms(query: string): string[] {
  const out = new Set<string>()
  for (const m of query.matchAll(/[A-Za-z0-9\u00C0-\u024F][A-Za-z0-9\u00C0-\u024F\-/.]*[A-Za-z0-9\u00C0-\u024F]|[\u3400-\u9fff]+/g)) {
    const t = m[0]
    if (/[\u3400-\u9fff]/.test(t)) {
      if (t.length <= 3) { if (t.length === 3) out.add(t); continue }
      for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3))
    } else if (t.length >= 3 && !KB_STOPWORDS.has(t.toLowerCase())) out.add(t)
  }
  return [...out].slice(0, 48)
}
