import { allows, type Access, type Level } from '../research/access.ts'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { DatasetRow, Store } from '../store/db.ts'
import type { ColumnProfile, Ingest, Profile } from './ingest.ts'
import { generateTable1FromData, type Table1Options, type Table1Result } from './table1.ts'
import { generateSurvivalAnalysis, type SurvivalOptions, type SurvivalAnalysisResult } from './survival.ts'
import { runImagingBiomarkerSurvival, type ImagingSurvivalRequest, type ImagingSurvivalResponse } from './imaging-survival.ts'
import {
  generateLogisticRegression,
  generateGrottaPlot,
  generateSankeyDiagram,
  generateUpSetPlot,
  type LogisticOptions,
  type LogisticRegressionResult,
  type GrottaOptions,
  type GrottaPlotResult,
  type SankeyOptions,
  type SankeyDiagramResult,
  type UpSetOptions,
  type UpSetPlotResult,
} from './clinical-plots.ts'

export type {
  Table1Options,
  Table1Result,
  SurvivalOptions,
  SurvivalAnalysisResult,
  ImagingSurvivalRequest,
  ImagingSurvivalResponse,
  LogisticOptions,
  LogisticRegressionResult,
  GrottaOptions,
  GrottaPlotResult,
  SankeyOptions,
  SankeyDiagramResult,
  UpSetOptions,
  UpSetPlotResult,
}


/**
 * 数据集（实验室数据分析 · 第一期）：医生上传大样本表格，AI 在隔离环境里用 Python 分析，结果（Table 1、图、方法与结果段落）写进文稿。
 * - 上传 → 在用户的隔离环境里解析（ingest.ts）→ 概况（列类型、缺失、摘要）。
 * - 疑似身份信息的列（姓名、证件号、电话、病历号、地址、出生日期、邮箱）必须由用户逐列处理：删掉，或明确确认「不是身份信息」，
 *   之后才能被 AI 使用（status=review → ready）。
 * - AI 经 MCP 的 dataset_list / dataset_describe / dataset_open 使用；只读，不能绕过确认。
 * 归属：按用户（owner）。以后加租户时数据集归租户，查询改按 tenant_id。
 */

export const DATASET_FORMATS: Record<string, string> = {
  '.csv': 'CSV', '.tsv': 'TSV', '.txt': 'CSV', '.xlsx': 'Excel', '.xlsm': 'Excel', '.xls': 'Excel',
  '.xpt': 'SAS', '.sas7bdat': 'SAS', '.sav': 'SPSS', '.zsav': 'SPSS', '.dta': 'Stata',
}
export const DATASET_MAX_BYTES = 100 * 1024 * 1024

export class DatasetError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export interface DatasetView extends Omit<DatasetRow, 'profile' | 'labels' | 'origin'> {
  columns: ColumnProfile[]
  /** 平台生成的数据集的来源（研究队列快照等）；用户上传的为 null */
  origin: DatasetOrigin | null
  labels: Record<string, string>
  /** 待用户处理的疑似身份信息列 */
  phi: Array<{ name: string; reason: string }>
  truncated: boolean
}

/** 平台生成的数据集（如研究队列快照）。trusted_columns：平台自己生成的列，不按「疑似身份信息」拦（列名像编号、日期也不是身份信息）。 */
export interface DatasetOrigin { kind: string; trusted_columns?: string[]; [k: string]: unknown }

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')

export class DatasetService {
  private queue: Promise<void> = Promise.resolve()
  /** 访问判定（研究团队协作：研究里的数据集按成员角色共享）；没接上时只认主人（测试里常用）。 */
  access: Access | null = null

  constructor(private readonly store: Store, private readonly dir: string, private readonly ingest: Ingest) {
    // 服务重启时没处理完的重新处理
    for (const d of store.processingDatasets()) this.schedule(d.id)
  }

  private folder(d: Pick<DatasetRow, 'owner' | 'id'>): string { return join(this.dir, safe(d.owner), d.id) }
  private original(d: DatasetRow): string { return join(this.folder(d), 'original' + extname(d.filename).toLowerCase()) }
  csvPath(d: DatasetRow): string { return join(this.folder(d), 'data.csv') }

  /** 上传：同一用户重复上传同一文件返回已有的。处理在后台排队进行。 */
  upload(owner: string, filename: string, bytes: Uint8Array, opts: { name?: string; origin?: DatasetOrigin; version?: number } = {}): { dataset: DatasetView; duplicate: boolean } {
    const ext = extname(filename).toLowerCase()
    const format = DATASET_FORMATS[ext]
    if (!format) throw new DatasetError('bad_format', `不支持的格式：${ext || '无扩展名'}（支持 CSV、Excel、SAS、SPSS、Stata）`)
    if (bytes.byteLength === 0) throw new DatasetError('empty', '文件是空的')
    if (bytes.byteLength > DATASET_MAX_BYTES) throw new DatasetError('too_large', '文件超过 100 MB')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const name = (opts.name ?? filename.replace(/\.[^.]+$/, '')).slice(0, 120) || '数据集'
    const same = this.store.findDatasetBySha(owner, sha256)
    if (same) {
      // 上次解析失败的同一份文件允许直接重新上传重试，不再卡死在 failed 状态
      if (same.status === 'failed') {
        mkdirSync(this.folder(same), { recursive: true })
        writeFileSync(this.original(same), bytes)
        this.store.updateDataset(same.id, {
          name,
          status: 'processing',
          error: null,
          ...(opts.origin ? { origin: JSON.stringify(opts.origin) } : {}),
          ...(opts.version !== undefined ? { version: opts.version } : {}),
        })
        this.schedule(same.id)
        return { dataset: this.view(this.store.getDataset(same.id)!), duplicate: false }
      }
      return { dataset: this.view(same), duplicate: true }
    }
    const row = this.store.addDataset({ owner, name, filename: filename.slice(0, 200), format, size: bytes.byteLength, sha256, origin: opts.origin ? JSON.stringify(opts.origin) : null, version: opts.version })
    mkdirSync(this.folder(row), { recursive: true })
    writeFileSync(this.original(row), bytes)
    this.schedule(row.id)
    return { dataset: this.view(row), duplicate: false }
  }

  /** 逐个处理（解析很快，但大文件占内存，不并发）。 */
  private schedule(id: string, drop: string[] = []): Promise<void> {
    this.queue = this.queue.then(() => this.process(id, drop)).catch(err => console.error('[datasets]', id, err))
    return this.queue
  }

  /** 等后台处理完（测试用）。 */
  idle(): Promise<void> { return this.queue }

  private async process(id: string, drop: string[]): Promise<void> {
    const d = this.store.getDataset(id)
    if (!d) return
    let r
    try {
      r = await this.ingest(d.owner, this.original(d), drop)
    } catch (err) {
      this.store.updateDataset(id, { status: 'failed', error: (err as Error).message.slice(0, 300) })
      return
    }
    try {
      if (!this.store.getDataset(id)) return // 处理期间被删了
      if (!r.profile.ok || !r.csv) {
        this.store.updateDataset(id, { status: 'failed', error: r.profile.ok ? '没有生成数据' : r.profile.error })
        return
      }
      const tmp = this.csvPath(d) + '.tmp'
      copyFileSync(r.csv, tmp)
      renameSync(tmp, this.csvPath(d))
      chmodSync(this.csvPath(d), 0o640)
      const trusted = new Set((d.origin ? JSON.parse(d.origin) as DatasetOrigin : null)?.trusted_columns ?? [])
      for (const c of r.profile.columns) if (c.phi && trusted.has(c.name)) delete c.phi
      const phi = r.profile.columns.filter(c => c.phi)
      this.store.updateDataset(id, { status: phi.length ? 'review' : 'ready', rows: r.profile.rows, cols: r.profile.columns.length, profile: JSON.stringify(r.profile), error: null })
    } finally {
      r.cleanup()
    }
  }

  /**
   * 处理疑似身份信息的列：drop 里的删掉，keep 里的是用户确认「不是身份信息」的。每个被标出的列都必须二选一。
   * 有要删的列时重新解析（从原文件），删完再检查一遍。
   */
  async resolvePhi(owner: string, id: string, drop: string[], keep: string[]): Promise<DatasetView> {
    const d = this.own(owner, id, 'write')
    if (d.status !== 'review') throw new DatasetError('not_in_review', '这个数据集不需要处理身份信息')
    const flagged = this.phiOf(d).map(c => c.name)
    const missing = flagged.filter(n => !drop.includes(n) && !keep.includes(n))
    if (missing.length) throw new DatasetError('unresolved', `还有列没处理：${missing.join('、')}（删掉，或确认不是身份信息）`)
    const prev = JSON.parse(d.profile!) as Extract<Profile, { ok: true }>
    if (drop.length) {
      this.store.updateDataset(id, { status: 'processing' })
      const toDrop = [...new Set([
        ...(prev.phi_resolved?.dropped ?? []),
        ...drop.filter(n => flagged.includes(n) || prev.columns.some(c => c.name === n)),
      ])]
      await this.schedule(id, toDrop)
    }
    // 用户确认保留的列：去掉标记，记下确认（审计里也有记录）
    const cur = this.store.getDataset(id)!
    if (cur.status === 'failed') return this.view(cur)
    const profile = JSON.parse(cur.profile!) as Extract<Profile, { ok: true }>
    for (const c of profile.columns) if (c.phi && keep.includes(c.name)) delete c.phi
    const still = profile.columns.filter(c => c.phi)
    this.store.updateDataset(id, { profile: JSON.stringify({ ...profile, phi_resolved: { dropped: drop, kept: keep, at: new Date().toISOString() } }), status: still.length ? 'review' : 'ready' })
    return this.view(this.store.getDataset(id)!)
  }

  /** 我能看到的数据集：自己的（不在我已被移出的研究里）+ 我参与的研究里别人上传的（shared=true） */
  list(owner: string): Array<DatasetView & { shared: boolean; my_role: string }> {
    const mine = this.store.listDatasets(owner).filter(d => this.roleOf(owner, d))
    const seen = new Set(mine.map(d => d.id))
    const shared = this.store.listStudies(owner).flatMap(st => this.store.studyItems(st.id).filter(i => i.kind === 'dataset' && !seen.has(i.ref_id)))
      .flatMap(i => { const d = this.store.getDataset(i.ref_id); return d ? [d] : [] })
    return [...mine, ...shared].map(d => ({ ...this.view(d), shared: d.owner !== owner, my_role: this.roleOf(owner, d) ?? 'viewer' }))
  }

  get(owner: string, id: string): DatasetView { return this.view(this.own(owner, id)) }

  update(owner: string, id: string, patch: { name?: string; labels?: Record<string, string> }): DatasetView {
    const d = this.own(owner, id, 'write')
    const next: Parameters<Store['updateDataset']>[1] = {}
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim().slice(0, 120)
    if (patch.labels && typeof patch.labels === 'object') {
      const cols = new Set(this.view(d).columns.map(c => c.name))
      const labels: Record<string, string> = { ...this.view(d).labels }
      for (const [k, v] of Object.entries(patch.labels)) {
        if (!cols.has(k)) continue
        if (typeof v === 'string' && v.trim()) labels[k] = v.trim().slice(0, 80)
        else delete labels[k]
      }
      next.labels = JSON.stringify(labels)
    }
    this.store.updateDataset(id, next)
    return this.view(this.store.getDataset(id)!)
  }

  /** 改平台生成的数据集的来源记录（研究队列刷新时数据没变，只更新指纹）。 */
  setOrigin(owner: string, id: string, origin: DatasetOrigin): void {
    this.own(owner, id, 'write')
    this.store.updateDataset(id, { origin: JSON.stringify(origin) })
  }

  remove(owner: string, id: string): void {
    const d = this.own(owner, id)
    if (!(this.access ? this.access.canDelete(owner, d, this.roleOf(owner, d)) : d.owner === owner)) throw new DatasetError('forbidden', '只有上传者或研究负责人能删除这个数据集')
    this.store.deleteDataset(id)
    rmSync(this.folder(d), { recursive: true, force: true })
  }

  /** 前 limit 行（预览）。 */
  preview(owner: string, id: string, limit = 50): { header: string[]; rows: string[][] } {
    const d = this.own(owner, id)
    if (d.status === 'review' && d.owner !== owner) throw new DatasetError('needs_review', '这个数据集有疑似身份信息的列，上传者还没处理，暂不能预览')
    if (!existsSync(this.csvPath(d))) return { header: [], rows: [] }
    const records = parseCsv(readHead(this.csvPath(d), limit + 1))
    return { header: records[0] ?? [], rows: records.slice(1, limit + 1) }
  }

  /** AI 打开数据：只有可用（ready）的。返回规范化 CSV 的路径。 */
  readyCsv(owner: string, id: string): { dataset: DatasetView; path: string } {
    const d = this.own(owner, id)
    if (d.status === 'review') throw new DatasetError('needs_review', '这个数据集有疑似身份信息的列，用户还没处理，暂不能使用')
    if (d.status !== 'ready') throw new DatasetError('not_ready', d.status === 'failed' ? `数据集导入失败：${d.error ?? ''}` : '数据集还在处理')
    return { dataset: this.view(d), path: this.csvPath(d) }
  }

  /** 生成临床研究 Table 1 基线特征表 */
  table1(owner: string, id: string, opts: Table1Options = {}): Table1Result {
    const { dataset, path } = this.readyCsv(owner, id)
    if (!existsSync(path)) throw new DatasetError('file_missing', '数据集数据文件丢失')
    const content = readFileSync(path, 'utf8')
    const matrix = parseCsv(content)
    if (matrix.length < 2) throw new DatasetError('insufficient_data', '数据集没有足够的数据生成 Table 1')
    const header = matrix[0]!
    const records: Record<string, string>[] = []
    for (let i = 1; i < matrix.length; i++) {
      const row = matrix[i]!
      if (!row || row.length === 0 || (row.length === 1 && !row[0])) continue
      const rec: Record<string, string> = {}
      for (let j = 0; j < header.length; j++) {
        const col = header[j]!
        rec[col] = row[j] ?? ''
      }
      records.push(rec)
    }

    const numCols = dataset.columns.filter(c => c.type === 'numeric').map(c => c.name)
    const catCols = dataset.columns.filter(c => c.type === 'categorical').map(c => c.name)
    const defaultCols = dataset.columns
      .filter(c => (c.type === 'numeric' || c.type === 'categorical')
        && c.name !== opts.group_col
        && !/^(id|pid|uuid|.*_id)$/i.test(c.name))
      .map(c => c.name)

    const mergedOpts: Table1Options = {
      ...opts,
      labels: { ...dataset.labels, ...opts.labels },
      columns: opts.columns ?? (defaultCols.length ? defaultCols : undefined),
      continuous_vars: opts.continuous_vars ?? (numCols.length ? numCols : undefined),
      categorical_vars: opts.categorical_vars ?? (catCols.length ? catCols : undefined),
    }

    return generateTable1FromData(records, mergedOpts)
  }

  /** 生存分析：根据时间列、事件列与分组变量拟合 KM 生存曲线与 Cox 比例风险回归 */
  survival(user: string, id: string, opts: SurvivalOptions): SurvivalAnalysisResult {
    const { dataset, path: csvFile } = this.readyCsv(user, id)

    const csvText = readFileSync(csvFile, 'utf8')
    const parsed = parseCsv(csvText)
    if (parsed.length < 2) throw new DatasetError('empty', '数据集为空')

    const header = parsed[0]!
    const records: Array<Record<string, unknown>> = []
    for (let i = 1; i < parsed.length; i++) {
      const r = parsed[i]!
      if (!r || r.length === 0 || (r.length === 1 && !r[0])) continue
      const rec: Record<string, unknown> = {}
      for (let j = 0; j < header.length; j++) {
        const col = header[j]!
        rec[col] = r[j] ?? ''
      }
      records.push(rec)
    }

    const mergedOpts: SurvivalOptions = {
      ...opts,
      labels: { ...dataset.labels, ...opts.labels }
    }

    return generateSurvivalAnalysis(records, mergedOpts)
  }

  /** 影像生物标志物生存分析：以 L3 SMI / VAT / 影像组学球形度等指标为切点拟合 KM 曲线与多变量 Cox 回归 */
  imagingSurvival(user: string, id: string, req: ImagingSurvivalRequest): ImagingSurvivalResponse {
    const { path: csvFile } = this.readyCsv(user, id)

    const csvText = readFileSync(csvFile, 'utf8')
    const parsed = parseCsv(csvText)
    if (parsed.length < 2) throw new DatasetError('empty', '数据集为空')

    const header = parsed[0]!
    const records: Array<Record<string, unknown>> = []
    for (let i = 1; i < parsed.length; i++) {
      const r = parsed[i]!
      if (!r || r.length === 0 || (r.length === 1 && !r[0])) continue
      const rec: Record<string, unknown> = {}
      for (let j = 0; j < header.length; j++) {
        const col = header[j]!
        rec[col] = r[j] ?? ''
      }
      records.push(rec)
    }

    return runImagingBiomarkerSurvival(records, req)
  }

  /** 二元结局单因素 / 多因素 Logistic 回归与 OR 森林图 */
  logistic(user: string, id: string, opts: LogisticOptions): LogisticRegressionResult {
    const { dataset, records } = this.readRecords(user, id)
    return generateLogisticRegression(records, {
      ...opts,
      labels: { ...dataset.labels, ...opts.labels },
    })
  }

  /** Grotta 100% 堆叠水平百分比条形图与有序评分分布迁移分析 (mRS Shift / 闭塞程度对比) */
  grotta(user: string, id: string, opts: GrottaOptions): GrottaPlotResult {
    const { dataset, records } = this.readRecords(user, id)
    return generateGrottaPlot(records, {
      ...opts,
      labels: { ...dataset.labels, ...opts.labels },
    })
  }

  /** 多阶段序贯治疗路径与结局流向桑基图 (Sankey / Alluvial Diagram) */
  sankey(user: string, id: string, opts: SankeyOptions): SankeyDiagramResult {
    const { dataset, records } = this.readRecords(user, id)
    return generateSankeyDiagram(records, {
      ...opts,
      labels: { ...dataset.labels, ...opts.labels },
    })
  }

  /** 多部位解剖受累共现交集与结局发生率联动图 (UpSet Co-occurrence Plot) */
  upset(user: string, id: string, opts: UpSetOptions): UpSetPlotResult {
    const { dataset, records } = this.readRecords(user, id)
    return generateUpSetPlot(records, {
      ...opts,
      labels: { ...dataset.labels, ...opts.labels },
    })
  }

  private readRecords(user: string, id: string): { dataset: DatasetView; records: Array<Record<string, unknown>> } {
    const { dataset, path: csvFile } = this.readyCsv(user, id)
    const csvText = readFileSync(csvFile, 'utf8')
    const parsed = parseCsv(csvText)
    if (parsed.length < 2) throw new DatasetError('empty', '数据集为空')
    const header = parsed[0]!
    const records: Array<Record<string, unknown>> = []
    for (let i = 1; i < parsed.length; i++) {
      const r = parsed[i]!
      if (!r || r.length === 0 || (r.length === 1 && !r[0])) continue
      const rec: Record<string, unknown> = {}
      for (let j = 0; j < header.length; j++) {
        rec[header[j]!] = r[j] ?? ''
      }
      records.push(rec)
    }
    return { dataset, records }
  }


  private roleOf(user: string, d: DatasetRow) {
    return this.access ? this.access.datasetRole(user, d) : d.owner === user ? 'owner' as const : null
  }

  private own(owner: string, id: string, level: Level = 'read'): DatasetRow {
    const d = this.store.getDataset(id)
    const role = d ? this.roleOf(owner, d) : null
    if (!d || !role) throw new DatasetError('not_found', '数据集不存在')
    if (!allows(role, level)) throw new DatasetError('forbidden', '你在这个研究里是只读成员，不能修改数据集')
    return d
  }

  private phiOf(d: DatasetRow): ColumnProfile[] {
    if (!d.profile) return []
    const p = JSON.parse(d.profile) as Profile
    return p.ok ? p.columns.filter(c => c.phi) : []
  }

  private view(d: DatasetRow): DatasetView {
    const p = d.profile ? JSON.parse(d.profile) as Profile : null
    const columns = p && p.ok ? p.columns : []
    const { profile: _p, labels, origin, ...rest } = d
    return { ...rest, origin: origin ? JSON.parse(origin) as DatasetOrigin : null, columns, labels: JSON.parse(labels || '{}') as Record<string, string>, phi: columns.filter(c => c.phi).map(c => ({ name: c.name, reason: c.phi!.reason })), truncated: Boolean(p && p.ok && p.truncated) }
  }
}

/** 读文件开头够 n 条记录的部分（预览不读整个大文件）。 */
function readHead(path: string, n: number): string {
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  const len = readSync(fd, buf, 0, buf.length, 0)
  closeSync(fd)
  return headOf(buf.subarray(0, len), n)
}

function headOf(buf: Buffer, n: number): string {
  let lines = 0
  let quoted = false
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i]
    if (ch === 0x22) quoted = !quoted
    else if (ch === 0x0a && !quoted && ++lines >= n) return buf.subarray(0, i).toString('utf8')
  }
  return buf.toString('utf8')
}

/** RFC 4180 CSV（引号、转义引号、引号内换行）。 */
export function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); out.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row) }
  return out
}
