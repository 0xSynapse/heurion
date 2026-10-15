/**
 * Subagent（子智能体）协同调度服务
 *
 * 实现了「双翼 · 一核 · 一门」多智能体流水线：
 * 1. literature_researcher（文献专家）：检索 PubMed/OpenAlex，提炼临床证据与标准 AMA 引用，产出 Evidence Bundle
 * 2. biostatistician（生信统计专家）：基于本地数据集生成 NEJM/Lancet 级 Table 1 基线表或 KM 生存分析，产出 Statistical Bundle
 * 3. fact_checker（质控核查专家）：对抗式核查论断真实性、数字一致性与 PHI 敏感数据泄漏，产出 Verification Report
 */

import type { Documents } from '../model/runtime.ts'
import type { Store } from '../store/db.ts'
import type { ClaimService } from '../claims/service.ts'
import type { Article } from '../literature/types.ts'
import type { PubMedClient } from '../literature/pubmed.ts'
import type { OpenAlexClient } from '../literature/openalex.ts'
import type { FullTextClient } from '../literature/fulltext.ts'
import type { DatasetService } from '../datasets/service.ts'
import type { CohortService } from '../research/cohort.ts'
import type { Access } from '../research/access.ts'
import { formatAma, normalizeDoi } from '../literature/format.ts'
import { scanPhi } from '../ops/phi-scan.ts'
import {
  classifySectionRole,
  classifyVerificationTier,
  EXTERNAL_STUDY_CUE,
  extractTableSummaries,
  type SectionRole,
  type TableSummary,
} from '../claims/extract.ts'
import type {
  EvidenceBundle,
  EvidenceCitation,
  StatisticalBundle,
  VerificationReport,
  ClaimCheckIssue,
  IssueSeverity,
  SubagentProgress,
  SubagentResult,
  SubagentTaskParams,
} from './types.ts'

export interface SubagentDeps {
  docs: Documents
  store: Store
  claims: ClaimService
  pubmed: PubMedClient
  openalex?: OpenAlexClient
  fulltext?: FullTextClient
  datasets?: DatasetService
  cohort?: CohortService
  access?: Access
  cohortGuard?: (origin?: { kind: string } | null) => string | null
}

export type SubagentServiceDeps = SubagentDeps

export interface SubagentDelegateOptions {
  cohortGuard?: (origin?: { kind: string } | null) => string | null
}

export class SubagentService {
  constructor(private readonly deps: SubagentDeps) {}

  get access(): Access | undefined {
    return this.deps.access
  }

  set access(a: Access | undefined) {
    this.deps.access = a
  }

  get cohortGuard(): ((origin?: { kind: string } | null) => string | null) | undefined {
    return this.deps.cohortGuard
  }

  set cohortGuard(fn: ((origin?: { kind: string } | null) => string | null) | undefined) {
    this.deps.cohortGuard = fn
  }

  async delegate(
    userId: string,
    params: SubagentTaskParams,
    onProgress: SubagentProgress = { step: () => {} },
    opts?: SubagentDelegateOptions,
  ): Promise<SubagentResult> {
    switch (params.role) {
      case 'literature_researcher':
        return this.runLiteratureResearcher(userId, params, onProgress)
      case 'biostatistician':
        return this.runBiostatistician(userId, params, onProgress, opts)
      case 'fact_checker':
        return this.runFactChecker(userId, params, onProgress)
      default:
        throw new Error(`未知的 Subagent 角色: ${(params as any).role}`)
    }
  }

  /**
   * 文献证据专家：检索医学数据库，提取核心证据与注册引用
   */
  private async runLiteratureResearcher(
    userId: string,
    params: SubagentTaskParams,
    onProgress: SubagentProgress,
  ): Promise<EvidenceBundle> {
    if (params.doc_id && this.deps.access) {
      const docRow = this.deps.store.getDoc(params.doc_id)
      if (!docRow || docRow.deleted_at || !this.deps.access.canDoc(userId, docRow, 'write')) {
        throw new Error(`无权修改目标文档或文档不存在: ${params.doc_id}`)
      }
    }

    onProgress.step('正在解析临床检索意图与 PICO 关键词...', 'info')
    const query = this.extractQuery(params.task, params.context)
    onProgress.step(`正在向 PubMed 医学权威文献库检索「${query}」...`, 'info')

    let articles: Article[] = []
    let pubmedFailed = false
    try {
      articles = await this.deps.pubmed.search(query, 5)
    } catch {
      pubmedFailed = true
      onProgress.step('PubMed 检索遇阻，尝试备用文献源...', 'warn')
    }

    if (articles.length === 0 && this.deps.openalex) {
      if (!pubmedFailed) {
        onProgress.step('PubMed 未返回直接命中结果，正在检索 OpenAlex 备用文献源...', 'info')
      }
      try {
        const oa = await this.deps.openalex.search(query, 5)
        articles = oa.map(a => ({
          pmid: a.pmid ?? null,
          doi: a.doi ?? null,
          title: a.title,
          authors: a.authors,
          year: String(a.year ?? ''),
          journal: a.journal,
          url: (a as any).url ?? null,
        } as Article))
      } catch {}
    }

    if (articles.length === 0) {
      onProgress.step('未在数据库中检索到直接匹配的文献', 'warn')
      return {
        role: 'literature_researcher',
        topic: params.task,
        query,
        total_found: 0,
        citations: [],
        clinical_synthesis: '未检索到与该检索词直接匹配的高相关临床文献，请尝试放宽检索关键词。',
        suggested_markers: [],
      }
    }

    onProgress.step(`成功检索到 ${articles.length} 篇权威同行评议文献，正在提取摘要与临床证据...`, 'info')
    const citations: EvidenceCitation[] = []
    const suggestedMarkers: Array<{ cite_id?: string; marker: string; reference: string }> = []

    const canWriteDoc = params.doc_id
      ? (() => {
          const docRow = this.deps.store.getDoc(params.doc_id!)
          if (!docRow || docRow.deleted_at) return false
          return this.deps.access ? this.deps.access.canDoc(userId, docRow, 'write') : true
        })()
      : false

    for (const art of articles) {
      let abstractText: string | null = (art as any).abstract ?? null
      if (!abstractText && art.pmid) {
        abstractText = await this.deps.pubmed.abstract(art.pmid).catch(() => null)
      }

      // 如果提供了关联文档，直接为该文档注册正规引用
      let citeId: string | undefined
      const cleanDoi = art.doi ? normalizeDoi(art.doi) : ''
      const formatted = formatAma({
        pmid: art.pmid ?? '',
        doi: cleanDoi,
        title: art.title,
        authors: art.authors,
        journal: art.journal ?? '',
        year: art.year ?? new Date().getFullYear(),
      })
      const articleUrl =
        (art as any).url ??
        (art.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${art.pmid}/` : cleanDoi ? `https://doi.org/${cleanDoi}` : null)

      if (params.doc_id && canWriteDoc) {
        const doiKey = cleanDoi || (art.pmid ? `pmid:${art.pmid}` : '')
        if (doiKey) {
          try {
            const row = this.deps.store.upsertCitation({
              doc_id: params.doc_id,
              doi: doiKey,
              pmid: art.pmid ?? null,
              formatted,
              url: articleUrl,
            })
            citeId = row.id
            suggestedMarkers.push({
              cite_id: citeId,
              marker: `[@c:${citeId}]`,
              reference: formatted,
            })
          } catch {
            // 忽略重复引用注册
          }
        }
      }

      // 提取核心证据句（优先结果与结论）
      const quote = this.extractEvidenceQuote(abstractText)
      citations.push({
        cite_id: citeId,
        pmid: art.pmid,
        doi: cleanDoi || art.doi,
        url: articleUrl,
        title: art.title,
        authors: art.authors,
        year: art.year,
        journal: art.journal,
        evidence_quote: quote,
      })
    }

    onProgress.step(`文献证据提炼完毕，已生成结构化证据包（含 ${citations.length} 篇标准引用）`, 'ok')

    const clinicalSynthesis = citations.map((c, i) => {
      const auth = c.authors.length ? `${c.authors[0]} 等 (${c.year ?? '近期'})` : `文献 ${i + 1}`
      const marker = c.cite_id ? ` [@c:${c.cite_id}]` : ''
      return `【${auth}】《${c.title}》${marker}：\n证据提要：${c.evidence_quote || '（请参见全文摘要）'}`
    }).join('\n\n')

    return {
      role: 'literature_researcher',
      topic: params.task,
      query,
      total_found: citations.length,
      citations,
      clinical_synthesis: clinicalSynthesis,
      suggested_markers: suggestedMarkers,
    }
  }

  /**
   * 生信统计专家：调用医学统计套件完成 Table 1 或生存分析
   */
  private async runBiostatistician(
    userId: string,
    params: SubagentTaskParams,
    onProgress: SubagentProgress,
    opts?: SubagentDelegateOptions,
  ): Promise<StatisticalBundle> {
    onProgress.step('正在定位临床数据集与变量配置...', 'info')
    if (!this.deps.datasets) {
      throw new Error('当前系统未启用数据集分析服务')
    }

    let datasetId = params.dataset_id
    if (!datasetId) {
      const list = this.deps.store.listDatasets(userId)
      const readyList = list.filter(d => d.status === 'ready')
      // 若指定了 doc_id 且该文档归属某研究项目，优先选取同一研究下的 ready 数据集
      if (params.doc_id) {
        const studyItem = this.deps.store.studyOf('doc', params.doc_id)
        const docRow = this.deps.store.getDoc(params.doc_id)
        let studyId = studyItem?.study_id
        if (!studyId && docRow?.context) {
          try {
            const ctxObj = JSON.parse(docRow.context) as { study_id?: string }
            if (ctxObj.study_id) studyId = ctxObj.study_id
          } catch {}
        }
        if (studyId) {
          const studyDsIds = new Set(
            this.deps.store.studyItems(studyId).filter(i => i.kind === 'dataset').map(i => i.ref_id),
          )
          const inStudy = readyList.find(d => studyDsIds.has(d.id))
          if (inStudy) datasetId = inStudy.id
        }
      }
      if (!datasetId) {
        const chosen = readyList[0] ?? list[0]
        if (chosen) datasetId = chosen.id
      }
    }

    if (!datasetId) {
      throw new Error('未指定数据集 ID，且当前用户暂无可用数据集。请先上传临床研究数据集。')
    }

    const dataset = this.deps.datasets.get(userId, datasetId)
    const activeCohortGuard = opts?.cohortGuard ?? this.deps.cohortGuard
    const guardReason = activeCohortGuard?.(dataset.origin as any)
    if (guardReason) {
      onProgress.step(`数据集受机构隐私策略限制: ${guardReason}`, 'warn')
      return {
        role: 'biostatistician',
        dataset_id: datasetId,
        dataset_name: dataset.name,
        analysis_type: 'summary',
        sample_size: 0,
        markdown_table: '',
        summary_metrics: { blocked: true, reason: guardReason },
        clinical_interpretation: `因机构隐私与安全设置限制，当前无法对该患者队列研究数据集执行自动统计分析：${guardReason}`,
      }
    }

    const isSurvival =
      /\b(?:os|pfs|dfs|km|cox|kaplan|survival)\b/i.test(params.task) ||
      /生存|预后|风险比/.test(params.task)

    const ctx = params.context ?? {}
    const findMentionedCol = (exclude: Set<string>, numericOnly = false) => {
      const taskLower = params.task.toLowerCase()
      return dataset.columns.find(c => {
        if (exclude.has(c.name)) return false
        if (numericOnly && c.type !== 'numeric' && (c as any).type !== 'number') return false
        return taskLower.includes(c.name.toLowerCase())
      })?.name
    }

    if (isSurvival) {
      onProgress.step(`正在对数据集《${dataset.name}》拟合 Kaplan-Meier 累积生存率并进行 Log-rank 检验...`, 'info')
      const isNumericCol = (c: { name: string; type: string }) => c.type === 'numeric' || (c as any).type === 'number'
      const ctxTime = typeof (ctx.time_col ?? ctx.timeCol) === 'string' ? String(ctx.time_col ?? ctx.timeCol) : undefined
      const ctxEvent = typeof (ctx.event_col ?? ctx.eventCol) === 'string' ? String(ctx.event_col ?? ctx.eventCol) : undefined
      const ctxGroup = typeof (ctx.group_col ?? ctx.groupCol) === 'string' ? String(ctx.group_col ?? ctx.groupCol) : undefined

      // 自动嗅探生存时间列（必须为数值列）与结局事件列（不可与时间列同名）
      const timeCol =
        (ctxTime && dataset.columns.some(c => c.name === ctxTime) ? ctxTime : undefined) ??
        dataset.columns.find(c => isNumericCol(c) && /(?:^|_)(?:time|months?|days?|years?|os|pfs|dfs|surv)/i.test(c.name))?.name ??
        dataset.columns.find(c => isNumericCol(c) && /time|month|day|year|os|pfs|dfs|surv/i.test(c.name))?.name ??
        findMentionedCol(new Set(), true) ??
        dataset.columns.find(c => isNumericCol(c))?.name ??
        dataset.columns[0]?.name ??
        'time'

      const eventCol =
        (ctxEvent && ctxEvent !== timeCol && dataset.columns.some(c => c.name === ctxEvent) ? ctxEvent : undefined) ??
        dataset.columns.find(c => c.name !== timeCol && /event|status|censor|death|relapse|recur|dead|os_event|pfs_event/i.test(c.name))?.name ??
        findMentionedCol(new Set([timeCol]), false) ??
        dataset.columns.find(c => c.name !== timeCol && isNumericCol(c))?.name ??
        dataset.columns.find(c => c.name !== timeCol)?.name ??
        'event'

      const groupCol =
        (ctxGroup && ctxGroup !== timeCol && ctxGroup !== eventCol && dataset.columns.some(c => c.name === ctxGroup) ? ctxGroup : undefined) ??
        findMentionedCol(new Set([timeCol, eventCol]), false) ??
        dataset.columns.find(c => /group|arm|treat|cohort|stage|mut/i.test(c.name) && c.name !== timeCol && c.name !== eventCol)?.name

      const res = this.deps.datasets.survival(userId, datasetId, {
        time_col: timeCol,
        event_col: eventCol,
        group_col: groupCol,
        title: `Survival Analysis by ${groupCol || 'Overall'} (${dataset.name})`,
      })

      const totalN = res.groups.reduce((acc, g) => acc + g.total_n, 0)
      const totalEvents = res.groups.reduce((acc, g) => acc + g.events_n, 0)

      onProgress.step('生存曲线与风险回归完成，已生成统计学报告', 'ok')
      return {
        role: 'biostatistician',
        dataset_id: datasetId,
        dataset_name: dataset.name,
        analysis_type: 'survival',
        sample_size: totalN,
        markdown_table: res.markdown_table,
        summary_metrics: {
          time_column: timeCol,
          event_column: eventCol,
          group_column: groupCol ?? 'Overall',
          events_count: totalEvents,
          log_rank_p: res.log_rank?.p_value ?? null,
        },
        clinical_interpretation: `在纳入分析的 ${totalN} 例患者中，观察到终点事件 ${totalEvents} 例。${res.log_rank ? `组间 Log-rank 显著性检验 P = ${res.log_rank.p_value < 0.001 ? '<0.001' : res.log_rank.p_value.toFixed(3)}。` : ''}`,
      }
    }

    // 默认生成 Table 1 基线特征三线表
    onProgress.step(`正在对数据集《${dataset.name}》生成符合 NEJM/Lancet 标准的 Table 1 基线表...`, 'info')
    const ctxGroup = typeof (ctx.group_col ?? ctx.groupCol) === 'string' ? String(ctx.group_col ?? ctx.groupCol) : undefined
    const groupCol =
      (ctxGroup && dataset.columns.some(c => c.name === ctxGroup) ? ctxGroup : undefined) ??
      findMentionedCol(new Set(), false) ??
      dataset.columns.find(c => /group|arm|treat|stage|type/i.test(c.name))?.name
    const res = this.deps.datasets.table1(userId, datasetId, {
      group_col: groupCol,
      title: `Table 1. Baseline Characteristics of Study Population (${dataset.name})`,
      include_p_value: !!groupCol,
      include_smd: !!groupCol,
    })

    onProgress.step('Table 1 基线特征表生成完毕，已完成正态性与卡方/秩和检验', 'ok')
    return {
      role: 'biostatistician',
      dataset_id: datasetId,
      dataset_name: dataset.name,
      analysis_type: 'table1',
      sample_size: res.total_n,
      markdown_table: res.markdown,
      summary_metrics: {
        total_patients: res.total_n,
        variables_analyzed: res.rows.filter(r => !r.is_category_level).length,
        stratification_group: groupCol ?? 'Overall',
      },
      clinical_interpretation: `共纳入 ${res.total_n} 例患者基线数据${groupCol ? `，按 ${groupCol} 进行分层对比分析` : ''}。各项连续与分类变量分布已按规范分别采用 Mean±SD / Median [IQR] 及 N (%) 呈现，并完成显著性检验。`,
    }
  }

  /**
   * 质控核查专家（Google PAT 四阶段学术审查流水线）：
   * - Stage 1：章节感知切分（intro / methods / results / discussion）与表格结构化数值提取
   * - Stage 2：自适应核查预算分级（high / medium / light）
   * - Stage 3：多维并行专项核查（Pass A 外部文献对齐与数值等价性/方向性核验 + 实时检索兜底；Pass B 跨章节与正文-表格自洽性核验；Pass C 章节感知的缺出处外部论断核验）
   * - Stage 4：跨章节去重、严重度分级（critical / major / minor）与全局汇总
   */
  private async runFactChecker(
    userId: string,
    params: SubagentTaskParams,
    onProgress: SubagentProgress,
  ): Promise<VerificationReport> {
    onProgress.step('正在按章节解析文档结构、表格数值摘要与关键临床论断 (Stage 1 & 2)...', 'info')
    const docId = params.doc_id
    if (!docId) {
      throw new Error('质控核查专家必须指定 doc_id 目标文档')
    }

    const docRow = this.deps.store.getDoc(docId)
    if (!docRow || docRow.deleted_at) {
      throw new Error(`目标文档不存在: ${docId}`)
    }
    if (this.deps.access && !this.deps.access.canDoc(userId, docRow, 'read')) {
      throw new Error(`无权读取目标文档: ${docId}`)
    }

    const doc = this.deps.docs.get(docId)
    const docText = JSON.stringify(doc.toJSON())

    // 1. 扫描受保护健康隐私 (PHI)
    onProgress.step('正在执行 PHI 隐私扫描（身份证、手机号、病案号与姓名诊断筛查）...', 'info')
    const phiFindings = scanPhi(docText)
    const phiDetected = phiFindings.length > 0

    // 2. 分页拉取全部论断与表格摘要（Stage 1 & Stage 2）
    onProgress.step('正在执行多维专项核查：外部文献对齐、正文-表格自洽性与缺出处溯源 (Stage 3)...', 'info')
    const allClaims: Awaited<ReturnType<ClaimService['evidence']>>['claims'] = []
    const allUnsourced: Awaited<ReturnType<ClaimService['evidence']>>['unsourced'] = []
    let docTables: TableSummary[] = []
    let cursor: number | undefined = 0
    while (cursor !== undefined) {
      const page: Awaited<ReturnType<ClaimService['evidence']>> = await this.deps.claims.evidence(docId, cursor).catch(() => ({
        rev: 0,
        claims: [],
        unsourced: [],
        next_cursor: null,
        total: 0,
      }))
      allClaims.push(...(page.claims ?? []))
      if (cursor === 0) {
        allUnsourced.push(...(page.unsourced ?? []))
        if (page.tables) docTables = page.tables
      }
      cursor = page.next_cursor !== null && page.next_cursor !== undefined ? page.next_cursor : undefined
    }
    if (docTables.length === 0) {
      try {
        docTables = extractTableSummaries(doc)
      } catch {}
    }

    const sectionFilter = params.section?.trim()
    const matchesSection = (item: { node_id: string; sentence: string; section_title?: string }) =>
      item.node_id === sectionFilter ||
      Boolean(item.section_title && item.section_title.includes(sectionFilter!)) ||
      item.sentence.includes(sectionFilter!)

    const claims =
      sectionFilter && allClaims.some(matchesSection)
        ? allClaims.filter(matchesSection)
        : allClaims
    const unsourced =
      sectionFilter && allUnsourced.some(matchesSection)
        ? allUnsourced.filter(matchesSection)
        : allUnsourced

    const existingChecks = new Map(
      this.deps.store.listClaimChecks(docId).map(chk => [chk.claim_id, chk]),
    )

    const rawIssues: ClaimCheckIssue[] = []
    const reportBatch: Array<{ claim_id: string; verdict: 'supported' | 'unsupported' | 'missing_citation'; reason: string }> = []
    let supportedCount = 0
    let unsupportedCount = 0
    let unclearCount = 0
    let liveGroundedCount = 0

    // —— Stage 3 Pass A：外部文献对齐（含数值等价性 74% <-> 0.74、效应方向矛盾检测与实时检索补全） ——
    for (const c of claims) {
      const existing = existingChecks.get(c.claim_id)
      if (existing?.verdict === 'exempted') {
        supportedCount++
        continue
      }

      const tier = c.verification_tier ?? classifyVerificationTier(c.sentence, c.citations.length, c.section_role ?? 'other')
      let citationsText = c.citations.map(x => `${x.reference} ${x.abstract ?? ''} ${x.fulltext?.passages.join(' ') ?? ''}`).join(' ')

      if (c.no_abstract) {
        // 对缺少摘要的高优先级引文尝试通过 PubMed / OpenAlex 实时检索补全摘要证据（最多 2 处）
        if (liveGroundedCount < 2 && c.citations.length > 0) {
          const grounded = await this.groundCitationAbstract(c.citations)
          if (grounded) {
            citationsText += ` ${grounded}`
            liveGroundedCount++
          }
        }
        if (citationsText.trim().length <= 50) {
          unclearCount++
          continue
        }
      }

      // 剥离句内引用标号 [1] 及图表编号（表 1 / Table 1 / Fig 2）后再提取数值指标，排除 4 位年份（19xx / 20xx）
      const sentenceWithoutMarkers = c.sentence
        .replace(/\[\d+(?:\s*[,，\-–]\s*\d+)*\]/g, ' ')
        .replace(/(?:表|图|\bTable|\bFig(?:ure)?\.?)\s*\d+/gi, ' ')
      const rawNumbers = sentenceWithoutMarkers.match(/\b\d+(?:\.\d+)?[%％]?|\b(?:HR|OR|RR)\s*=?\s*\d+(?:\.\d+)?/gi) ?? []
      const numbersInSentence = rawNumbers.filter(num => !/^(?:19|20)\d{2}$/.test(num.trim()))

      // 核对数值等价性（支持 74% <-> 0.74、尾随零 0.50 <-> 0.5 等）
      const missingNumbers = numbersInSentence.filter(num => !this.isNumberMatchedInEvidence(num, citationsText))
      const directionConflict = this.detectDirectionalityContradiction(c.sentence, citationsText)

      if ((missingNumbers.length > 0 || directionConflict) && citationsText.length > 50) {
        unsupportedCount++
        const reason = missingNumbers.length > 0
          ? `正文中提及的数值 [${missingNumbers.join(', ')}] 未在所引文献摘要或结果中核验到对应出处${directionConflict ? `；且${directionConflict}` : ''}。`
          : `正文结论方向与所引文献矛盾：${directionConflict}。`
        const severity: IssueSeverity = tier === 'high' ? 'critical' : 'major'
        const issue: ClaimCheckIssue = {
          claim_id: c.claim_id,
          sentence: c.sentence,
          verdict: 'unsupported',
          reason,
          suggestion: `核实数值与效应方向是否与原始文献一致，或补充对应临床试验来源。`,
          severity,
          category: 'literature_mismatch',
          ...(c.section_title ? { section_title: c.section_title } : {}),
          verification_tier: tier,
        }
        rawIssues.push(issue)
        reportBatch.push({
          claim_id: c.claim_id,
          verdict: 'unsupported',
          reason: issue.reason,
        })
      } else if (numbersInSentence.length > 0) {
        supportedCount++
        reportBatch.push({
          claim_id: c.claim_id,
          verdict: 'supported',
          reason: '所引文献摘要支持该论断与数据描述。',
        })
      } else {
        supportedCount++
      }
    }

    // —— Stage 3 Pass B：跨章节与正文-表格内部自洽性核查（样本量 N、表内百分比引用对齐） ——
    const internalIssues = this.auditInternalConsistency(doc, docTables)
    for (const intIss of internalIssues) {
      rawIssues.push(intIss)
    }

    // —— Stage 3 Pass C：章节角色感知的缺出处外部论断核查 + 实时候选文献推荐 ——
    const prioritizedUnsourced = [...unsourced].sort((a, b) => {
      const rankRole = (r?: SectionRole) => (r === 'intro' || r === 'discussion' ? 0 : r === 'other' ? 1 : 2)
      const rankTier = (t?: string) => (t === 'high' ? 0 : t === 'medium' ? 1 : 2)
      return rankRole(a.section_role) - rankRole(b.section_role) || rankTier(a.verification_tier) - rankTier(b.verification_tier)
    })

    for (const u of prioritizedUnsourced.slice(0, 5)) {
      const existing = existingChecks.get(u.claim_id)
      if (existing?.verdict === 'exempted') continue
      unclearCount++
      const tier = u.verification_tier ?? classifyVerificationTier(u.sentence, 0, u.section_role ?? 'other')
      let candidateCitations: ClaimCheckIssue['candidate_citations']
      if (liveGroundedCount < 2 && (tier === 'high' || EXTERNAL_STUDY_CUE.test(u.sentence))) {
        const candidates = await this.groundUnsourcedClaim(u.sentence)
        if (candidates.length > 0) {
          candidateCitations = candidates
          liveGroundedCount++
        }
      }
      const reason = '该句包含具体临床统计数值，但缺少明确的参考文献引用标注。'
      const candidateHint = candidateCitations?.length
        ? ` 检索到候选文献：${candidateCitations.map(c => `${c.title}${c.pmid ? ` (PMID:${c.pmid})` : ''}`).join('；')}`
        : ''
      rawIssues.push({
        claim_id: u.claim_id,
        sentence: u.sentence,
        verdict: 'no_evidence',
        reason,
        suggestion: `建议补充权威文献支撑或声明为本研究队列数据。${candidateHint}`.trim(),
        severity: u.section_role === 'intro' || u.section_role === 'discussion' || EXTERNAL_STUDY_CUE.test(u.sentence) ? 'major' : 'minor',
        category: 'missing_citation',
        ...(u.section_title ? { section_title: u.section_title } : {}),
        verification_tier: tier,
        ...(candidateCitations ? { candidate_citations: candidateCitations } : {}),
      })
      reportBatch.push({
        claim_id: u.claim_id,
        verdict: 'missing_citation',
        reason,
      })
    }

    if (reportBatch.length > 0) {
      try {
        this.deps.claims.report(docId, reportBatch)
      } catch {
        // Fallback if document is read-only or comment anchor fails
      }
    }

    // 若检出 PHI 隐私数据，作为最高严重度（critical）加入问题清单
    if (phiDetected) {
      for (const f of phiFindings.slice(0, 5)) {
        rawIssues.push({
          sentence: f.redacted || f.description,
          verdict: 'unsupported',
          reason: `检出疑似患者敏感个人健康信息（${f.description}）`,
          suggestion: '请立即脱敏或移除患者个人身份信息（PHI）。',
          severity: 'critical',
          category: 'phi_leak',
        })
      }
    }

    // —— Stage 4：全局合成、跨章节重复问题去重与严重度排序 ——
    const seenKeys = new Set<string>()
    const issues: ClaimCheckIssue[] = []
    for (const iss of rawIssues) {
      const normKey = `${iss.category ?? iss.verdict}:${iss.sentence.replace(/\s+/g, '').toLowerCase()}`
      if (seenKeys.has(normKey)) continue
      seenKeys.add(normKey)
      issues.push(iss)
    }
    const severityOrder: Record<IssueSeverity, number> = { critical: 0, major: 1, minor: 2 }
    issues.sort((a, b) => severityOrder[a.severity ?? 'minor'] - severityOrder[b.severity ?? 'minor'])

    const totalAudited = claims.length + unsourced.length
    let verdict: 'pass' | 'warning' | 'fail' = 'pass'
    if (phiDetected || unsupportedCount > 0 || internalIssues.some(i => i.severity === 'critical')) {
      verdict = 'fail'
    } else if (issues.length > 0) {
      verdict = 'warning'
    }

    onProgress.step(
      `质控审核完成 (Stage 4)：${supportedCount} 条论断吻合，${issues.length} 处需关注（裁定: ${verdict.toUpperCase()}）`,
      verdict === 'pass' ? 'ok' : 'warn',
    )

    const severityTag = (s?: IssueSeverity) => (s === 'critical' ? '[严重]' : s === 'major' ? '[主要]' : '[次要]')
    const summary = [
      `【质控审查裁定】：${verdict === 'pass' ? '[通过] 全部核验通过 (Pass)' : verdict === 'warning' ? '[警告] 存在存疑点，建议复核 (Warning)' : '[未通过] 发现数据不符或隐私风险，需立即修正 (Fail)'}`,
      `- 论断核验总量：${totalAudited} 处（文献支持：${supportedCount}，数据不符：${unsupportedCount}，缺出处：${unsourced.length}${internalIssues.length > 0 ? `，正文-表格自洽异常：${internalIssues.length}` : ''}）`,
      `- PHI 患者隐私扫描：${phiDetected ? `[隐私告警] 检出 ${phiFindings.length} 处疑似敏感信息泄漏！` : '[通过] 未检出患者隐私数据'}`,
      issues.length > 0
        ? `\n【重点发现的问题清单】：\n` +
          issues
            .map(
              (iss, i) =>
                `${i + 1}. ${severityTag(iss.severity)}${iss.section_title ? `【${iss.section_title}】` : ''}「${iss.sentence}」\n   问题：${iss.reason}\n   建议：${iss.suggestion || '请核实修改'}`,
            )
            .join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n')

    return {
      role: 'fact_checker',
      verdict,
      total_claims_audited: totalAudited,
      supported_count: supportedCount,
      unsupported_count: unsupportedCount,
      unclear_count: unclearCount,
      internal_inconsistency_count: internalIssues.length,
      live_grounded_count: liveGroundedCount,
      phi_detected: phiDetected,
      phi_count: phiFindings.length,
      issues,
      summary,
    }
  }

  /**
   * Stage 3 Pass A 辅助：判断正文中的数值（如 74%、0.74、HR=0.65、1,250）是否在所引文献证据中匹配（含百分比与小数等价性）。
   */
  private isNumberMatchedInEvidence(rawNum: string, evidenceText: string): boolean {
    const trimmed = rawNum.trim()
    if (!trimmed) return true
    if (evidenceText.includes(trimmed)) return true

    // 提取纯数字/百分比核心部分（如 "HR=0.65" -> "0.65"）
    const coreMatch = /(\d+(?:,\d{3})*(?:\.\d+)?)\s*([%％])?/.exec(trimmed)
    if (!coreMatch || !coreMatch[1]) return evidenceText.includes(trimmed)

    const numPart = coreMatch[1].replace(/,/g, '')
    const isPercent = Boolean(coreMatch[2])
    const val = Number(numPart)
    if (Number.isNaN(val)) return evidenceText.includes(trimmed)

    // 1. 直接匹配去逗号数字或规范化小数（如 12.0 <-> 12，0.50 <-> 0.5）
    if (evidenceText.includes(numPart) || evidenceText.includes(String(val))) return true

    // 2. 百分比与小数等价转换（如 74% <-> 0.74，74.5% <-> 0.745）
    if (isPercent && val > 0 && val <= 100) {
      const dec = val / 100
      const candidates = [
        dec.toFixed(2),
        dec.toFixed(3),
        String(Number(dec.toFixed(4))),
        `${val.toFixed(1)}%`,
        `${Math.round(val)}%`,
      ]
      if (candidates.some(c => evidenceText.includes(c))) return true
    } else if (!isPercent && val > 0 && val < 1) {
      const pct = Number((val * 100).toFixed(2))
      const candidates = [`${pct}%`, `${pct.toFixed(1)}%`, `${Math.round(pct)}%`]
      if (candidates.some(c => evidenceText.includes(c))) return true
    }

    return false
  }

  /**
   * Stage 3 Pass A 辅助：检测正文效应方向（显著改善/降低）与文献摘要（无显著差异）是否存在直接方向性矛盾。
   */
  private detectDirectionalityContradiction(sentence: string, evidenceText: string): string | null {
    const claimsPositiveSignificance =
      /(?:显著(?:降低|延长|改善|提高|优于|减少)|明显(?:降低|延长|改善|优于)|\bsignificantly\s+(?:reduced|improved|prolonged|increased|lowered|decreased)\b)/i.test(
        sentence,
      )
    const evidenceStatesNoSignificance =
      /(?:无显著(?:性)?差异|差异无统计学意义|未见显著差异|\bno\s+statistically\s+significant\s+difference\b|\bno\s+significant\s+difference\b|\bdid\s+not\s+significantly\s+(?:reduce|improve|prolong|differ)\b)/i.test(
        evidenceText,
      )
    if (claimsPositiveSignificance && evidenceStatesNoSignificance) {
      return '正文声称存在显著效应，但所引文献报告差异无统计学意义（no significant difference）'
    }
    return null
  }

  /**
   * Stage 3 Pass B：跨章节与正文-表格内部自洽性核查（比对正文样本量 N 与表格样本量 N、表 1 引用百分比对齐）。
   */
  private auditInternalConsistency(doc: any, tables: TableSummary[]): ClaimCheckIssue[] {
    const issues: ClaimCheckIssue[] = []
    if (!tables || tables.length === 0) return issues

    const allTableSampleSizes = new Set<number>()
    const allTableNumbers = new Set<string>()
    for (const t of tables) {
      for (const n of t.sample_sizes) allTableSampleSizes.add(n)
      for (const num of t.numbers) allTableNumbers.add(num)
    }
    const sumOfSubgroupN =
      tables[0] && tables[0].sample_sizes.length >= 2
        ? tables[0].sample_sizes.reduce((acc, v) => acc + v, 0)
        : 0
    if (sumOfSubgroupN > 0) allTableSampleSizes.add(sumOfSubgroupN)

    let currentSectionTitle = ''
    const visit = (node: any, inTable: boolean) => {
      if (!node) return
      if (node.type?.name === 'table') return
      if (node.type?.name === 'heading' && !inTable) {
        const h = String(node.textContent ?? '').trim()
        if (h) currentSectionTitle = h
        return
      }
      if (!node.isTextblock) {
        if (typeof node.forEach === 'function') {
          node.forEach((child: any) => visit(child, inTable))
        }
        return
      }
      const text = String(node.textContent ?? '').trim()
      if (!text) return

      // 1. 核对正文声明的总样本量 N 与表格样本量是否矛盾
      if (allTableSampleSizes.size > 0) {
        const cohortMatch =
          /(?:本研究|研究|本队列|共|总计|最终)\s*(?:共)?(?:纳入|入组|收集|分析)[^\d。！？；!?]{0,10}(\d+)\s*例/.exec(text) ??
          /\b(?:enrolled|included|analyzed)\s+(?:a\s+total\s+of\s+)?(\d+)\s+(?:patients|subjects|cases|participants)\b/i.exec(text)
        if (cohortMatch && cohortMatch[1]) {
          const proseN = Number(cohortMatch[1])
          if (proseN > 0 && !allTableSampleSizes.has(proseN) && !allTableNumbers.has(String(proseN))) {
            issues.push({
              sentence: text,
              verdict: 'unsupported',
              reason: `正文声明的总样本量（${proseN} 例）与文档表格中声明的样本量（N=${[...allTableSampleSizes].join(' / ')}）不一致。`,
              suggestion: '请核对正文与 Table 1 基线表中的总样本量 N 及亚组样本量加总是否一致。',
              severity: 'critical',
              category: 'internal_inconsistency',
              ...(currentSectionTitle ? { section_title: currentSectionTitle } : {}),
              verification_tier: 'high',
            })
          }
        }
      }

      // 2. 核对明确引用「表 1 / Table 1」的句子中的百分比是否出现在表格中
      if (/(?:表\s*1\b|\bTable\s*1\b)/i.test(text) && tables[0] && tables[0].numbers.length > 0) {
        const pctMatches = text.match(/\b\d+(?:\.\d+)?[%％]/g) ?? []
        const tableEvidence = tables[0].numbers.join(' ')
        const missingPcts = pctMatches.filter(p => !this.isNumberMatchedInEvidence(p, tableEvidence))
        if (pctMatches.length > 0 && missingPcts.length === pctMatches.length) {
          issues.push({
            sentence: text,
            verdict: 'unsupported',
            reason: `正文引用表 1 描述的百分比 [${missingPcts.join(', ')}] 与表 1 单元格中的实际数值不符。`,
            suggestion: '请对照表 1 核实该变量的实际频数与百分比。',
            severity: 'major',
            category: 'internal_inconsistency',
            ...(currentSectionTitle ? { section_title: currentSectionTitle } : {}),
            verification_tier: 'high',
          })
        }
      }
    }

    if (typeof doc?.forEach === 'function') {
      doc.forEach((child: any) => visit(child, false))
    }
    return issues
  }

  /**
   * Stage 3/4 实时检索兜底：当文档中的引用没有缓存摘要时，提取标题关键词通过 PubMed / OpenAlex 检索补全摘要。
   */
  private async groundCitationAbstract(
    citations: Array<{ reference: string; abstract: string | null }>,
  ): Promise<string | null> {
    const ref = citations[0]?.reference?.trim()
    if (!ref || !this.deps.pubmed || typeof this.deps.pubmed.search !== 'function') return null
    try {
      const results = await this.deps.pubmed.search(ref.slice(0, 120), 1)
      const hit = results?.[0]
      if (hit?.pmid && typeof this.deps.pubmed.abstract === 'function') {
        const abs = await this.deps.pubmed.abstract(hit.pmid)
        if (abs) return abs
      }
    } catch {}
    return null
  }

  /**
   * Stage 3/4 实时检索兜底：针对缺出处的外部定量论断，检索候选权威文献供作者核对引用。
   */
  private async groundUnsourcedClaim(
    sentence: string,
  ): Promise<Array<{ pmid?: string | null; doi?: string | null; title: string; year?: string | number }>> {
    if (!this.deps.pubmed || typeof this.deps.pubmed.search !== 'function') return []
    try {
      const q = sentence
        .replace(/[^\w\u4e00-\u9fa5\s.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90)
      if (q.length < 6) return []
      const hits = await this.deps.pubmed.search(q, 2)
      return (hits ?? []).slice(0, 2).map(h => ({
        pmid: h.pmid ?? null,
        doi: h.doi ?? null,
        title: h.title,
        year: h.year,
      }))
    } catch {
      return []
    }
  }

  private extractQuery(task: string, context?: Record<string, unknown>): string {
    if (context?.query && typeof context.query === 'string') return context.query.trim()
    // 去掉中文指令前缀与句尾后缀（避免贪婪截断中间的临床条件）
    const cleaned = task
      .replace(/^(请(帮我)?|查一下|检索|搜索|调研|找关于|分析)\s*/g, '')
      .replace(/的(最新|三期|临床|相关)?(文献|研究|进展|数据|试验|证据|综述|Meta分析|RCT)\s*[。！？.!?]*$/gi, '')
      .trim()
    return cleaned || task
  }

  private extractEvidenceQuote(abstract: string | null): string {
    if (!abstract) return ''
    // 按句子边界切分，避开小数点（如 38.6%、10.2 months）
    const resultsMatch = /\b(?:RESULTS?|FINDINGS?)\b\s*[:：]?\s*((?:(?!\b(?:CONCLUSIONS?|INTERPRETATION|DISCUSSION)\b)[\s\S])+)/i.exec(abstract)
    if (resultsMatch && resultsMatch[1]) {
      const sentences = resultsMatch[1].trim().split(/(?<!\d)\.(?!\d)\s+/).slice(0, 3).join('. ').trim()
      if (sentences) return sentences.endsWith('.') ? sentences : `${sentences}.`
    }
    const conclusionMatch = /\b(?:CONCLUSIONS?|INTERPRETATION)\b\s*[:：]?\s*([\s\S]+)/i.exec(abstract)
    if (conclusionMatch && conclusionMatch[1]) {
      const sentences = conclusionMatch[1].trim().split(/(?<!\d)\.(?!\d)\s+/).slice(0, 2).join('. ').trim()
      if (sentences) return sentences.endsWith('.') ? sentences : `${sentences}.`
    }
    return abstract.slice(0, 240) + (abstract.length > 240 ? '...' : '')
  }
}
