import { allows, type Access, type Level } from '../research/access.ts'
import type { Complete } from '../harness/complete.ts'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { DatasetRow, Store } from '../store/db.ts'
import type { AiWorkbookAudit, ColumnProfile, Ingest, IngestSheetOptions, Profile, SheetSummary } from './ingest.ts'
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
import {
  fitNomogramFromRecords,
  fitRocDcaFromRecords,
  type NomogramResult,
} from '../research/prediction-models.ts'
import {
  analyzeDatasetCausalBalance,
  type DatasetCausalAnalysisOptions,
  type DatasetCausalAnalysisResult,
} from '../research/causal-inference.ts'

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
 * - 支持多工作表 Excel（自动识别「数据表」与「数据字典 / 变量编码表」，或切换工作表）与双行表头自动剥离。
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
  /** 数据字典或双行表头解析出的分类值标签映射：{ 列名: { 原始编码值: 中文含义 } } */
  value_labels: Record<string, Record<string, string>>
  /** 多工作表 Excel 的工作表清单（含自动判定的 data / dictionary 角色） */
  sheets?: SheetSummary[]
  /** 当前作为主数据表的工作表名称 */
  active_sheet?: string | null
  /** 当前联动解析的数据字典工作表名称 */
  dictionary_sheet?: string | null
  /** 是否自动剥离了第 2 行中文说明表头 */
  two_row_header?: boolean
  /** AI / 语义工作簿与数据字典核验报告 */
  ai_audit?: AiWorkbookAudit | null
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
  /** 可选：大模型完成函数（用于多工作表 Excel 与数据字典的深度语义核验；仅传表结构与字典文本，绝不传受试者行数据） */
  complete: Complete | null = null

  constructor(private readonly store: Store, private readonly dir: string, private readonly ingest: Ingest, complete: Complete | null = null) {
    this.complete = complete
    // 服务重启时没处理完的重新处理
    for (const d of store.processingDatasets()) this.schedule(d.id)
  }

  private folder(d: Pick<DatasetRow, 'owner' | 'id'>): string { return join(this.dir, safe(d.owner), d.id) }
  private original(d: DatasetRow): string { return join(this.folder(d), 'original' + extname(d.filename).toLowerCase()) }
  csvPath(d: DatasetRow): string { return join(this.folder(d), 'data.csv') }

  /** 上传：同一用户重复上传同一文件返回已有的。处理在后台排队进行。 */
  upload(
    owner: string,
    filename: string,
    bytes: Uint8Array,
    opts: { name?: string; origin?: DatasetOrigin; version?: number; sheet?: string; dict_sheet?: string | null } = {},
  ): { dataset: DatasetView; duplicate: boolean } {
    const ext = extname(filename).toLowerCase()
    const format = DATASET_FORMATS[ext]
    if (!format) throw new DatasetError('bad_format', `不支持的格式：${ext || '无扩展名'}（支持 CSV、Excel、SAS、SPSS、Stata）`)
    if (bytes.byteLength === 0) throw new DatasetError('empty', '文件是空的')
    if (bytes.byteLength > DATASET_MAX_BYTES) throw new DatasetError('too_large', '文件超过 100 MB')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const name = (opts.name ?? filename.replace(/\.[^.]+$/, '')).slice(0, 120) || '数据集'
    const sheetOpts: IngestSheetOptions | undefined =
      opts.sheet !== undefined || opts.dict_sheet !== undefined
        ? { sheet: opts.sheet, dict_sheet: opts.dict_sheet }
        : undefined
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
        this.schedule(same.id, [], sheetOpts)
        return { dataset: this.view(this.store.getDataset(same.id)!), duplicate: false }
      }
      return { dataset: this.view(same), duplicate: true }
    }
    const row = this.store.addDataset({ owner, name, filename: filename.slice(0, 200), format, size: bytes.byteLength, sha256, origin: opts.origin ? JSON.stringify(opts.origin) : null, version: opts.version })
    mkdirSync(this.folder(row), { recursive: true })
    writeFileSync(this.original(row), bytes)
    this.schedule(row.id, [], sheetOpts)
    return { dataset: this.view(row), duplicate: false }
  }

  /** 逐个处理（解析很快，但大文件占内存，不并发）。 */
  private schedule(id: string, drop: string[] = [], sheetOpts?: IngestSheetOptions, resetAutoLabels = false): Promise<void> {
    this.queue = this.queue.then(() => this.process(id, drop, sheetOpts, resetAutoLabels)).catch(err => console.error('[datasets]', id, err))
    return this.queue
  }

  /** 等后台处理完（测试用）。 */
  idle(): Promise<void> { return this.queue }

  private async process(id: string, drop: string[], sheetOpts?: IngestSheetOptions, resetAutoLabels = false): Promise<void> {
    const d = this.store.getDataset(id)
    if (!d) return
    let r
    try {
      r = await this.ingest(d.owner, this.original(d), drop, sheetOpts)
    } catch (err) {
      this.store.updateDataset(id, { status: 'failed', error: (err as Error).message.slice(0, 300) })
      return
    }
    try {
      const current = this.store.getDataset(id)
      if (!current) return // 处理期间被删了
      if (!r.profile.ok || !r.csv) {
        this.store.updateDataset(id, { status: 'failed', error: r.profile.ok ? '没有生成数据' : r.profile.error })
        return
      }
      const tmp = this.csvPath(current) + '.tmp'
      copyFileSync(r.csv, tmp)
      renameSync(tmp, this.csvPath(current))
      chmodSync(this.csvPath(current), 0o640)
      const trusted = new Set((current.origin ? JSON.parse(current.origin) as DatasetOrigin : null)?.trusted_columns ?? [])
      for (const c of r.profile.columns) if (c.phi && trusted.has(c.name)) delete c.phi

      // 当上传的是多工作表 Excel、含数据字典工作表或双行表头时，执行「语义模糊对齐 + AI 深度核验」
      const needsWorkbookAudit =
        (r.profile.sheets && r.profile.sheets.length > 1) ||
        Boolean(r.profile.dictionary_sheet) ||
        Boolean(r.profile.two_row_header)
      if (needsWorkbookAudit) {
        const audit = await this.inspectAndEnrichWorkbook(r.profile, false)
        // 若 AI 建议切换主数据表或字典工作表（且用户未显式指定 sheetOpts），自动切换重新解析一次
        if (
          !sheetOpts &&
          audit.mode === 'ai' &&
          ((audit.recommended_data_sheet && audit.recommended_data_sheet !== r.profile.active_sheet) ||
            (audit.recommended_dict_sheet !== undefined && audit.recommended_dict_sheet !== r.profile.dictionary_sheet))
        ) {
          const nextSheetOpts: IngestSheetOptions = {
            sheet: audit.recommended_data_sheet || r.profile.active_sheet,
            dict_sheet: audit.recommended_dict_sheet !== undefined ? audit.recommended_dict_sheet : r.profile.dictionary_sheet,
          }
          try {
            const r2 = await this.ingest(d.owner, this.original(d), drop, nextSheetOpts)
            try {
              if (r2.profile.ok && r2.csv) {
                const tmp2 = this.csvPath(current) + '.tmp'
                copyFileSync(r2.csv, tmp2)
                renameSync(tmp2, this.csvPath(current))
                chmodSync(this.csvPath(current), 0o640)
                for (const c of r2.profile.columns) if (c.phi && trusted.has(c.name)) delete c.phi
                const audit2 = await this.inspectAndEnrichWorkbook(r2.profile, false)
                audit2.sheet_switch_applied = true
                r2.profile.ai_audit = audit2
                r.cleanup()
                r = r2
              }
            } finally {
              if (r !== r2) r2.cleanup()
            }
          } catch {
            // Keep initial ingest if re-ingest fails
          }
        }
        if (r.profile.ok && !r.profile.ai_audit) {
          r.profile.ai_audit = audit
        }
      }
      if (!r.profile.ok) return

      const phi = r.profile.columns.filter(c => c.phi)

      // 自动合并从数据字典工作表 / 双行表头 / AI 核验 / SPSS / Stata 解析出的变量标签
      const existingLabels: Record<string, string> = resetAutoLabels ? {} : JSON.parse(current.labels || '{}')
      const mergedLabels: Record<string, string> = { ...existingLabels }
      for (const c of r.profile.columns) {
        if (c.label && typeof c.label === 'string' && c.label.trim() && !mergedLabels[c.name]) {
          mergedLabels[c.name] = c.label.trim().slice(0, 80)
        }
      }

      this.store.updateDataset(id, {
        status: phi.length ? 'review' : 'ready',
        rows: r.profile.rows,
        cols: r.profile.columns.length,
        profile: JSON.stringify(r.profile),
        labels: JSON.stringify(mergedLabels),
        error: null,
      })
    } finally {
      r.cleanup()
    }
  }

  /**
   * 手动触发或重新执行「AI 多工作表与数据字典语义核验」（仅传工作表结构与字典文本，绝不传受试者行数据）。
   */
  async auditWorkbook(owner: string, id: string): Promise<DatasetView> {
    const d = this.own(owner, id, 'write')
    if (!d.profile) throw new DatasetError('not_ready', '数据集尚无解析概况')
    const prof = JSON.parse(d.profile) as Profile
    if (!prof.ok) throw new DatasetError('failed', '数据集解析失败，无法执行核验')
    const audit = await this.inspectAndEnrichWorkbook(prof, true)
    prof.ai_audit = audit
    const mergedLabels: Record<string, string> = JSON.parse(d.labels || '{}')
    for (const c of prof.columns) {
      if (c.label && typeof c.label === 'string' && c.label.trim()) {
        mergedLabels[c.name] = c.label.trim().slice(0, 80)
      }
    }
    this.store.updateDataset(id, {
      profile: JSON.stringify(prof),
      labels: JSON.stringify(mergedLabels),
    })
    return this.view(this.store.getDataset(id)!)
  }

  /**
   * 切换多工作表 Excel 的「数据表」与「数据字典工作表」，重新解析并自动更新列概况、变量标签与分类值编码。
   */
  async selectSheets(owner: string, id: string, opts: { sheet?: string; dict_sheet?: string | null }): Promise<DatasetView> {
    const d = this.own(owner, id, 'write')
    if (!existsSync(this.original(d))) {
      throw new DatasetError('no_source', '原始上传文件不存在，无法切换工作表')
    }
    const prev = d.profile ? (JSON.parse(d.profile) as Profile) : null
    const sheetOpts: IngestSheetOptions = {
      sheet: opts.sheet ?? (prev && prev.ok ? prev.active_sheet : undefined),
      dict_sheet: opts.dict_sheet !== undefined ? opts.dict_sheet : (prev && prev.ok ? prev.dictionary_sheet : undefined),
    }
    this.store.updateDataset(id, { status: 'processing', error: null })
    await this.schedule(id, [], sheetOpts, true)
    return this.view(this.store.getDataset(id)!)
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
    const sheetOpts: IngestSheetOptions | undefined =
      prev.active_sheet || prev.dictionary_sheet !== undefined
        ? { sheet: prev.active_sheet, dict_sheet: prev.dictionary_sheet }
        : undefined
    if (drop.length) {
      this.store.updateDataset(id, { status: 'processing' })
      const toDrop = [...new Set([
        ...(prev.phi_resolved?.dropped ?? []),
        ...drop.filter(n => flagged.includes(n) || prev.columns.some(c => c.name === n)),
      ])]
      await this.schedule(id, toDrop, sheetOpts)
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

  update(
    owner: string,
    id: string,
    patch: { name?: string; labels?: Record<string, string>; value_labels?: Record<string, Record<string, string>> },
  ): DatasetView {
    const d = this.own(owner, id, 'write')
    const next: Parameters<Store['updateDataset']>[1] = {}
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim().slice(0, 120)
    const v = this.view(d)
    const cols = new Set(v.columns.map(c => c.name))
    if (patch.labels && typeof patch.labels === 'object') {
      const labels: Record<string, string> = { ...v.labels }
      for (const [k, val] of Object.entries(patch.labels)) {
        if (!cols.has(k)) continue
        if (typeof val === 'string' && val.trim()) labels[k] = val.trim().slice(0, 80)
        else delete labels[k]
      }
      next.labels = JSON.stringify(labels)
    }
    if (patch.value_labels && typeof patch.value_labels === 'object' && d.profile) {
      const prof = JSON.parse(d.profile) as Profile
      if (prof.ok) {
        for (const c of prof.columns) {
          if (patch.value_labels[c.name] !== undefined) {
            const rawMap = patch.value_labels[c.name]
            if (rawMap && typeof rawMap === 'object') {
              const cleaned: Record<string, string> = {}
              for (const [codeKey, codeLabel] of Object.entries(rawMap)) {
                if (typeof codeLabel === 'string' && codeLabel.trim()) {
                  cleaned[String(codeKey).trim()] = codeLabel.trim().slice(0, 60)
                }
              }
              if (Object.keys(cleaned).length > 0) c.value_labels = cleaned
              else delete c.value_labels
              if (c.top) {
                c.top = c.top.map(item => ({
                  value: item.value,
                  count: item.count,
                  ...(c.value_labels?.[item.value] ? { label: c.value_labels[item.value] } : {}),
                }))
              }
            } else {
              delete c.value_labels
            }
          }
        }
        next.profile = JSON.stringify(prof)
      }
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

  /** 合并列标签与数据字典分类值标签（用于 Table 1 / 回归 / 生存分析展示）。 */
  private effectiveLabels(dataset: DatasetView): Record<string, string> {
    const out: Record<string, string> = { ...dataset.labels }
    for (const [col, vmap] of Object.entries(dataset.value_labels)) {
      for (const [code, lbl] of Object.entries(vmap)) {
        const key = `${col}.${code}`
        if (!out[key]) out[key] = lbl
      }
    }
    return out
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

    const numCols = dataset.columns.filter(c => c.type === 'numeric' && !c.value_labels).map(c => c.name)
    const catCols = dataset.columns.filter(c => c.type === 'categorical' || Boolean(c.value_labels)).map(c => c.name)
    const defaultCols = dataset.columns
      .filter(c => (c.type === 'numeric' || c.type === 'categorical')
        && c.name !== opts.group_col
        && !/^(id|pid|uuid|.*_id)$/i.test(c.name))
      .map(c => c.name)

    const mergedOpts: Table1Options = {
      ...opts,
      labels: { ...this.effectiveLabels(dataset), ...opts.labels },
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
      labels: { ...this.effectiveLabels(dataset), ...opts.labels },
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
      labels: { ...this.effectiveLabels(dataset), ...opts.labels },
    })
  }

  /** Grotta 100% 堆叠水平百分比条形图与有序评分分布迁移分析 (mRS Shift / 闭塞程度对比) */
  grotta(user: string, id: string, opts: GrottaOptions): GrottaPlotResult {
    const { dataset, records } = this.readRecords(user, id)
    return generateGrottaPlot(records, {
      ...opts,
      labels: { ...this.effectiveLabels(dataset), ...opts.labels },
    })
  }

  /** 多阶段序贯治疗路径与结局流向桑基图 (Sankey / Alluvial Diagram) */
  sankey(user: string, id: string, opts: SankeyOptions): SankeyDiagramResult {
    const { dataset, records } = this.readRecords(user, id)
    return generateSankeyDiagram(records, {
      ...opts,
      labels: { ...this.effectiveLabels(dataset), ...opts.labels },
    })
  }

  /** 多部位解剖受累共现交集与结局发生率联动图 (UpSet Co-occurrence Plot) */
  upset(user: string, id: string, opts: UpSetOptions): UpSetPlotResult {
    const { dataset, records } = this.readRecords(user, id)
    return generateUpSetPlot(records, {
      ...opts,
      labels: { ...this.effectiveLabels(dataset), ...opts.labels },
    })
  }

  /** 从真实数据集拟合多因素预后列线图 (Nomogram) 与 Harrell's C-index */
  nomogram(
    user: string,
    id: string,
    opts: {
      title?: string
      outcome_col: string
      time_col?: string
      covariates: string[]
      labels?: Record<string, string>
      positive_value?: unknown
    },
  ): NomogramResult {
    const { dataset, records } = this.readRecords(user, id)
    return fitNomogramFromRecords(records, {
      ...opts,
      title: opts.title || `${dataset.name} · 多因素预后列线图 (Nomogram)`,
      labels: { ...this.effectiveLabels(dataset), ...opts.labels },
    })
  }

  /** 从真实数据集拟合双模型 ROC 诊断效能对比、DeLong 检验与 DCA 决策曲线 */
  rocDca(
    user: string,
    id: string,
    opts: {
      dataset_name?: string
      outcome_col: string
      baseline_covariates: string[]
      full_covariates?: string[]
      model1_name?: string
      model2_name?: string
      labels?: Record<string, string>
      positive_value?: unknown
    },
  ) {
    const { dataset, records } = this.readRecords(user, id)
    return fitRocDcaFromRecords(records, {
      ...opts,
      dataset_name: opts.dataset_name || dataset.name,
      labels: { ...this.effectiveLabels(dataset), ...opts.labels },
    })
  }

  /** 从真实数据集计算倾向性评分 (PSM / IPTW)、协变量 SMD 平衡表 (Love Plot) 与 VanderWeele E-value */
  causal(
    user: string,
    id: string,
    opts: DatasetCausalAnalysisOptions,
  ): DatasetCausalAnalysisResult {
    const { dataset, records } = this.readRecords(user, id)
    return analyzeDatasetCausalBalance(records, {
      ...opts,
      title: opts.title || `${dataset.name} · 倾向性评分协变量平衡图 (Love Plot)`,
      labels: { ...this.effectiveLabels(dataset), ...opts.labels },
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

  /**
   * 混合架构工作簿与数据字典核验器：
   * 1. 确定性临床语义校验与模糊变量名对齐（如 eGFR_baseline <-> egfr_base，0/1 临床二分类列自动纠正为 categorical）；
   * 2. 当配置了 LLM (this.complete) 时，仅将工作表元数据、字典页纯文本与去重脱敏编码（绝不含任何患者行数据）交由 AI 深度解析自然语言赋值规则与表结构。
   */
  private async inspectAndEnrichWorkbook(
    prof: Extract<Profile, { ok: true }>,
    forceAi = false,
  ): Promise<AiWorkbookAudit> {
    const typeCorrections: AiWorkbookAudit['type_corrections'] = []
    const fuzzyMatches: AiWorkbookAudit['fuzzy_matches'] = []
    const warnings: string[] = []

    const normStem = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')

    // 1. 字典表模糊对齐：若字典里有变量因拼写微差（如 egfr_baseline vs egfr_base）未命中表头，自动模糊匹配
    if (prof.dict_preview_rows && prof.dict_preview_rows.length >= 2) {
      const dictHeader = prof.dict_preview_rows[0] ?? []
      const dictRows = prof.dict_preview_rows.slice(1)
      const colByName = new Map(prof.columns.map(c => [c.name.toLowerCase(), c]))
      const unlabelledCols = prof.columns.filter(c => !c.label || !c.value_labels)

      for (const r of dictRows) {
        const rawVar = (r[0] ?? '').trim()
        if (!rawVar || colByName.has(rawVar.toLowerCase())) continue
        const stemVar = normStem(rawVar)
        if (stemVar.length < 3) continue
        const candidates = unlabelledCols.filter(c => {
          const sc = normStem(c.name)
          if (sc.length < 3) return false
          return sc === stemVar || (sc.length >= 4 && stemVar.startsWith(sc)) || (stemVar.length >= 4 && sc.startsWith(stemVar))
        })
        if (candidates.length === 1) {
          const targetCol = candidates[0]!
          const rawLabel = (r[1] ?? '').trim()
          const rawThird = (r[2] ?? '').trim()
          const rawFourth = (r[3] ?? '').trim()
          if (rawLabel && !targetCol.label) {
            targetCol.label = rawLabel.slice(0, 80)
            fuzzyMatches.push({ column: targetCol.name, dict_var: rawVar, label: targetCol.label })
          }
          const combinedCoding = [rawLabel, rawThird, rawFourth].filter(Boolean).join(' ')
          const parsedMap = parseNaturalLanguageCodings(combinedCoding)
          if (Object.keys(parsedMap).length >= 2 && (!targetCol.value_labels || Object.keys(targetCol.value_labels).length === 0)) {
            targetCol.value_labels = parsedMap
          }
        }
      }
      void dictHeader
    }

    // 2. 临床二分类与等级变量（0/1, 1/2/3/4）类型自动修正 + 自然语言编码兜底提取
    const CLINICAL_CAT_NAME_RE = /^(sex|gender|smoke|smoking|drink|alcohol|htn|hypertension|dm|diabetes|ckd|copd|af|chf|event|status|outcome|death|deceased|relapse|recurrence|metastasis|group|arm|treat|treatment|stage|tnm|grade|nyha|ecog|asa|child_pugh)$/i
    const CLINICAL_CAT_LABEL_RE = /(?:性别|吸烟|饮酒|高血压|糖尿病|冠心病|房颤|心衰|慢性肾病|结局|终点|死亡|复发|转移|分组|组别|治疗组|分期|分级|是否|有无|阴阳性)/

    for (const c of prof.columns) {
      if (c.description && (!c.value_labels || Object.keys(c.value_labels).length === 0)) {
        const nlMap = parseNaturalLanguageCodings(c.description)
        if (Object.keys(nlMap).length >= 2) {
          c.value_labels = nlMap
        }
      }
      const hasValueLabels = Boolean(c.value_labels && Object.keys(c.value_labels).length >= 2)
      if (c.type === 'numeric') {
        if (hasValueLabels && c.unique <= 12) {
          c.type = 'categorical'
          typeCorrections.push({
            column: c.name,
            from: 'numeric',
            to: 'categorical',
            reason: '数据字典已定义分类取值编码，修正为分类变量',
          })
        } else if (
          c.unique <= 6 &&
          (CLINICAL_CAT_NAME_RE.test(c.name) || (c.label && CLINICAL_CAT_LABEL_RE.test(c.label)))
        ) {
          c.type = 'categorical'
          typeCorrections.push({
            column: c.name,
            from: 'numeric',
            to: 'categorical',
            reason: '临床二分类/分期等级指标，修正为分类变量以避免误算均值±标准差',
          })
        }
      }
      if (c.top && c.value_labels) {
        c.top = c.top.map(item => ({
          value: item.value,
          count: item.count,
          ...(c.value_labels?.[item.value] ? { label: c.value_labels[item.value] } : {}),
        }))
      }
    }

    let mode: 'ai' | 'heuristic' = 'heuristic'
    let confidence: 'high' | 'medium' | 'low' = 'high'
    let recommendedDataSheet: string | null | undefined = prof.active_sheet ?? null
    let recommendedDictSheet: string | null | undefined = prof.dictionary_sheet ?? null
    let aiSummary = ''

    // 3. 若配置了 LLM，将脱敏工作表结构与字典文本交由 AI 深度核验
    if (this.complete && (forceAi || (prof.sheets?.length ?? 0) > 1 || Boolean(prof.dictionary_sheet) || Boolean(prof.two_row_header))) {
      try {
        const safePayload = {
          sheets: (prof.sheets ?? []).map(s => ({
            name: s.name,
            rows: s.rows,
            cols: s.cols,
            role: s.role,
            columns_preview: s.columns_preview ?? [],
          })),
          active_sheet: prof.active_sheet ?? null,
          dictionary_sheet: prof.dictionary_sheet ?? null,
          dict_preview_rows: (prof.dict_preview_rows ?? []).slice(0, 45),
          columns: prof.columns.map(c => ({
            name: c.name,
            type: c.type,
            unique: c.unique,
            label: c.label ?? null,
            unit: c.unit ?? null,
            value_labels: c.value_labels ?? null,
            description: c.description ?? null,
            distinct_codes: c.phi ? undefined : c.distinct_codes,
          })),
        }
        const sysPrompt = [
          '你是临床医学研究数据管理与生物统计专家（CDISC / eCRF 数据字典核验员）。',
          '请审阅上传的 Excel 工作簿结构摘要与数据字典内容（已严格脱敏，不含受试者行数据），完成以下核验并只返回合法 JSON：',
          '1. 判断当前选中的主数据表 (recommended_data_sheet) 与数据字典工作表 (recommended_dict_sheet) 是否准确；',
          '2. 从字典文本或自然语言说明中补全每个数据表列的中文名称 (label)、测量单位 (unit) 和分类取值编码映射 (value_labels，如 {"0":"否","1":"是"})；',
          '3. 若字典变量名与数据表列名存在轻微拼写差异（如 egfr_baseline 与 egfr_base），请完成匹配并在 matched_dict_var 中注明；',
          '4. 检查列类型 (type: "numeric" | "categorical" | "date" | "text")，将用 0/1 或 1/2/3 编码的二分类/等级分类变量修正为 "categorical"；',
          '5. 在 warnings 数组中列出需要提醒研究者注意的潜在问题（如：某列为 0/1 编码但字典未说明含义、或字典中有变量在数据表中缺失）。',
          '输出 JSON 格式：{"recommended_data_sheet":string|null,"recommended_dict_sheet":string|null,"confidence":"high"|"medium"|"low","summary":string,"columns":{"<列名>":{"label"?:string,"unit"?:string,"type"?:"numeric"|"categorical"|"date"|"text","type_reason"?:string,"value_labels"?:Record<string,string>,"matched_dict_var"?:string}},"warnings":string[]}',
        ].join('\n')

        const rawResp = await this.complete(sysPrompt, JSON.stringify(safePayload))
        const jsonMatch = rawResp.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            recommended_data_sheet?: string | null
            recommended_dict_sheet?: string | null
            confidence?: 'high' | 'medium' | 'low'
            summary?: string
            columns?: Record<string, {
              label?: string
              unit?: string
              type?: 'numeric' | 'categorical' | 'date' | 'text'
              type_reason?: string
              value_labels?: Record<string, string>
              matched_dict_var?: string
            }>
            warnings?: string[]
          }
          mode = 'ai'
          if (parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low') {
            confidence = parsed.confidence
          }
          if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
            aiSummary = parsed.summary.trim()
          }
          if (parsed.recommended_data_sheet && prof.sheets?.some(s => s.name === parsed.recommended_data_sheet)) {
            recommendedDataSheet = parsed.recommended_data_sheet
          }
          if (parsed.recommended_dict_sheet !== undefined) {
            if (parsed.recommended_dict_sheet === null || prof.sheets?.some(s => s.name === parsed.recommended_dict_sheet)) {
              recommendedDictSheet = parsed.recommended_dict_sheet
            }
          }
          if (parsed.columns && typeof parsed.columns === 'object') {
            for (const c of prof.columns) {
              const patch = parsed.columns[c.name]
              if (!patch || typeof patch !== 'object') continue
              if (typeof patch.label === 'string' && patch.label.trim()) {
                c.label = patch.label.trim().slice(0, 80)
              }
              if (typeof patch.unit === 'string' && patch.unit.trim()) {
                c.unit = patch.unit.trim().slice(0, 30)
                if (c.label && !c.label.includes(c.unit)) {
                  c.label = `${c.label} (${c.unit})`
                }
              }
              if (patch.value_labels && typeof patch.value_labels === 'object') {
                const vmap: Record<string, string> = { ...(c.value_labels ?? {}) }
                for (const [k, v] of Object.entries(patch.value_labels)) {
                  if (typeof v === 'string' && v.trim()) vmap[String(k).trim()] = v.trim().slice(0, 50)
                }
                if (Object.keys(vmap).length > 0) {
                  c.value_labels = vmap
                  if (c.top) {
                    c.top = c.top.map(item => ({
                      value: item.value,
                      count: item.count,
                      ...(vmap[item.value] ? { label: vmap[item.value] } : {}),
                    }))
                  }
                }
              }
              if (
                (patch.type === 'categorical' || patch.type === 'numeric') &&
                patch.type !== c.type
              ) {
                const prevType = c.type
                c.type = patch.type
                if (!typeCorrections.some(tc => tc.column === c.name)) {
                  typeCorrections.push({
                    column: c.name,
                    from: prevType,
                    to: patch.type,
                    reason: patch.type_reason || 'AI 根据临床变量含义与编码规则修正列类型',
                  })
                }
              }
              if (typeof patch.matched_dict_var === 'string' && patch.matched_dict_var.trim() && patch.matched_dict_var !== c.name) {
                if (!fuzzyMatches.some(fm => fm.column === c.name)) {
                  fuzzyMatches.push({
                    column: c.name,
                    dict_var: patch.matched_dict_var.trim(),
                    label: c.label || c.name,
                  })
                }
              }
            }
          }
          if (Array.isArray(parsed.warnings)) {
            for (const w of parsed.warnings) {
              if (typeof w === 'string' && w.trim() && !warnings.includes(w.trim())) {
                warnings.push(w.trim().slice(0, 200))
              }
            }
          }
        }
      } catch {
        // Fallback smoothly to deterministic audit when upstream LLM is unreachable
      }
    }

    // 4. 汇总未说明的 0/1 编码列或多数据表提示
    const unlabelledBinaryCols = prof.columns.filter(c => {
      if (c.phi || (c.value_labels && Object.keys(c.value_labels).length > 0)) return false
      const codes = c.distinct_codes ?? []
      return codes.length === 2 && codes.includes('0') && codes.includes('1')
    })
    if (unlabelledBinaryCols.length > 0) {
      const colNames = unlabelledBinaryCols.map(c => c.label ? `${c.name}(${c.label})` : c.name).join('、')
      const msg = `检测到二分类 0/1 编码列「${colNames}」尚未配置 0 与 1 的具体文字含义，建议在列概览中点击「设置编码」确认。`
      if (!warnings.some(w => w.includes(unlabelledBinaryCols[0]!.name))) {
        warnings.push(msg)
      }
      if (confidence === 'high') confidence = 'medium'
    }

    const dataSheetCandidates = (prof.sheets ?? []).filter(s => s.role === 'data' && s.rows > 0)
    if (dataSheetCandidates.length > 1) {
      const others = dataSheetCandidates.filter(s => s.name !== prof.active_sheet).map(s => `${s.name}(${s.rows}行)`).join('、')
      if (others) {
        warnings.push(`工作簿包含多个数据表，当前已选「${prof.active_sheet}」，其余候选数据表：${others}（可在上方一键切换）。`)
      }
    }

    const enrichedLabelsCount = prof.columns.filter(c => Boolean(c.label)).length
    const enrichedCodingsCount = prof.columns.filter(c => Boolean(c.value_labels && Object.keys(c.value_labels).length > 0)).length

    const defaultSummary = [
      prof.active_sheet ? `主数据表「${prof.active_sheet}」(${prof.rows} 行 × ${prof.columns.length} 列)` : `共 ${prof.rows} 行 × ${prof.columns.length} 列`,
      prof.dictionary_sheet ? `已联动数据字典「${prof.dictionary_sheet}」` : prof.two_row_header ? '已自动剥离并解析第 2 行中文说明表头' : '已完成列结构核验',
      `成功提取 ${enrichedLabelsCount}/${prof.columns.length} 项变量标签、${enrichedCodingsCount} 项分类取值编码`,
      typeCorrections.length ? `修正 ${typeCorrections.length} 项分类变量类型` : '',
      fuzzyMatches.length ? `模糊对齐 ${fuzzyMatches.length} 项字典变量` : '',
    ].filter(Boolean).join('；') + '。'

    return {
      audited_at: new Date().toISOString(),
      mode,
      confidence,
      summary: aiSummary || defaultSummary,
      recommended_data_sheet: recommendedDataSheet,
      recommended_dict_sheet: recommendedDictSheet,
      enriched_labels_count: enrichedLabelsCount,
      enriched_codings_count: enrichedCodingsCount,
      type_corrections: typeCorrections,
      fuzzy_matches: fuzzyMatches,
      warnings,
    }
  }

  private view(d: DatasetRow): DatasetView {
    const p = d.profile ? JSON.parse(d.profile) as Profile : null
    const columns = p && p.ok ? p.columns : []
    const value_labels: Record<string, Record<string, string>> = {}
    for (const c of columns) {
      if (c.value_labels && Object.keys(c.value_labels).length > 0) {
        value_labels[c.name] = c.value_labels
      }
    }
    const { profile: _p, labels, origin, ...rest } = d
    return {
      ...rest,
      origin: origin ? JSON.parse(origin) as DatasetOrigin : null,
      columns,
      labels: JSON.parse(labels || '{}') as Record<string, string>,
      value_labels,
      ...(p && p.ok && p.sheets ? {
        sheets: p.sheets,
        active_sheet: p.active_sheet ?? null,
        dictionary_sheet: p.dictionary_sheet ?? null,
      } : {}),
      ...(p && p.ok && p.two_row_header ? { two_row_header: true } : {}),
      ...(p && p.ok && p.ai_audit ? { ai_audit: p.ai_audit } : {}),
      phi: columns.filter(c => c.phi).map(c => ({ name: c.name, reason: c.phi!.reason })),
      truncated: Boolean(p && p.ok && p.truncated),
    }
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

/**
 * 从自然语言赋值描述（如 "0=否, 1=是"、"1代表达格列净组，0代表常规对照组"、"男记为1，女记为2"）中解析编码映射。
 */
export function parseNaturalLanguageCodings(text: string): Record<string, string> {
  if (!text || typeof text !== 'string') return {}
  const out: Record<string, string> = {}
  const stdRe = /(?:^|[,，;；/、|\n\r\t]+|\s+)([+-]?\d+|[A-Za-z0-9_]{1,10})\s*(?:=|:|：|->|→|--|—|-)\s*([^,，;；/、|\n\r=：:（）()]{1,36}?)(?=$|[,，;；/、|\n\r\t]+|\s+[+-]?\d+\s*(?:=|:|：|-)|[）)])/g
  let m: RegExpExecArray | null
  while ((m = stdRe.exec(text)) !== null) {
    const k = m[1]!.trim()
    const v = m[2]!.trim()
    if (/^[+-]?\d+$/.test(k) && /^[+-]?\d+$/.test(v)) continue
    if (k && v) out[k] = v
  }
  if (Object.keys(out).length >= 2) return out

  const nlCodeFirst = /(?:^|[,，;；/、。\n\r\t]+|\s+)([+-]?\d+|[A-Za-z]{1,6})\s*(?:代表|表示|表示的是|指|对应|即为|记作|定义为|为)\s*([^,，;；/、。\n\r=：:（）()]{1,32}?)(?=$|[,，;；/、。\n\r\t]+|\s+[+-]?\d+\s*(?:代表|表示|指|对应|为)|[）)])/g
  while ((m = nlCodeFirst.exec(text)) !== null) {
    const k = m[1]!.trim()
    const v = m[2]!.trim()
    if (/^[+-]?\d+$/.test(k) && /^[+-]?\d+$/.test(v)) continue
    if (k && v) out[k] = v
  }
  if (Object.keys(out).length >= 2) return out

  const nlLabelFirst = /(?:^|[,，;；/、。\n\r\t]+|\s+)([^,，;；/、。\n\r=：:（）()\d]{1,20}?)\s*(?:记为|赋值为|编码为|代码为|记作|定义为)\s*([+-]?\d+|[A-Za-z]{1,6})(?=$|[,，;；/、。\n\r\t]+|[）)])/g
  while ((m = nlLabelFirst.exec(text)) !== null) {
    const v = m[1]!.trim()
    const k = m[2]!.trim()
    if (k && v) out[k] = v
  }
  return Object.keys(out).length >= 2 ? out : {}
}
