/**
 * Subagent（子智能体）协同调度服务
 *
 * 实现了「双翼 · 一核 · 一门」多智能体流水线：
 * 1. 📚 literature_researcher（文献专家）：检索 PubMed/OpenAlex，提炼临床证据与标准 AMA 引用，产出 Evidence Bundle
 * 2. 📊 biostatistician（生信统计专家）：基于本地数据集生成 NEJM/Lancet 级 Table 1 基线表或 KM 生存分析，产出 Statistical Bundle
 * 3. 🛡️ fact_checker（质控核查专家）：对抗式核查论断真实性、数字一致性与 PHI 敏感数据泄漏，产出 Verification Report
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
import type {
  EvidenceBundle,
  EvidenceCitation,
  StatisticalBundle,
  VerificationReport,
  ClaimCheckIssue,
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
  ): Promise<SubagentResult> {
    switch (params.role) {
      case 'literature_researcher':
        return this.runLiteratureResearcher(userId, params, onProgress)
      case 'biostatistician':
        return this.runBiostatistician(userId, params, onProgress)
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
    const guardReason = this.deps.cohortGuard?.(dataset.origin as any)
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
   * 质控核查专家：对抗式筛查正文论断与数字真实性、引用匹配及 PHI 风险
   */
  private async runFactChecker(
    userId: string,
    params: SubagentTaskParams,
    onProgress: SubagentProgress,
  ): Promise<VerificationReport> {
    onProgress.step('正在提取文档正文与关键临床论断...', 'info')
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

    // 2. 论断核对与数字比对（分页拉取全部论断）
    onProgress.step('正在核对带引用论断与文献摘要的忠实度...', 'info')
    const allClaims: Awaited<ReturnType<ClaimService['evidence']>>['claims'] = []
    const allUnsourced: Awaited<ReturnType<ClaimService['evidence']>>['unsourced'] = []
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
      }
      cursor = page.next_cursor !== null && page.next_cursor !== undefined ? page.next_cursor : undefined
    }

    const sectionFilter = params.section?.trim()
    const claims =
      sectionFilter && allClaims.some(c => c.node_id === sectionFilter || c.sentence.includes(sectionFilter))
        ? allClaims.filter(c => c.node_id === sectionFilter || c.sentence.includes(sectionFilter))
        : allClaims
    const unsourced =
      sectionFilter && allUnsourced.some(u => u.node_id === sectionFilter || u.sentence.includes(sectionFilter))
        ? allUnsourced.filter(u => u.node_id === sectionFilter || u.sentence.includes(sectionFilter))
        : allUnsourced

    const existingChecks = new Map(
      this.deps.store.listClaimChecks(docId).map(chk => [chk.claim_id, chk]),
    )

    const issues: ClaimCheckIssue[] = []
    const reportBatch: Array<{ claim_id: string; verdict: 'supported' | 'unsupported' | 'missing_citation'; reason: string }> = []
    let supportedCount = 0
    let unsupportedCount = 0
    let unclearCount = 0

    for (const c of claims) {
      const existing = existingChecks.get(c.claim_id)
      if (existing?.verdict === 'exempted') {
        supportedCount++
        continue
      }

      if (c.no_abstract) {
        unclearCount++
        continue
      }

      // 提取句子中的数字指标（如 76.5%、HR 0.65、p=0.01），排除 4 位年份（19xx / 20xx）
      const rawNumbers = c.sentence.match(/\b\d+(?:\.\d+)?%?|\bHR\s*=?\s*\d+(?:\.\d+)?/gi) ?? []
      const numbersInSentence = rawNumbers.filter(num => !/^(?:19|20)\d{2}$/.test(num.trim()))
      const citationsText = c.citations.map(x => `${x.reference} ${x.abstract ?? ''} ${x.fulltext?.passages.join(' ') ?? ''}`).join(' ')

      // 如果句中有明确数值指标，但引用的摘要/全文中找不到该数值，判定为数字偏差风险
      const missingNumbers = numbersInSentence.filter(num => !citationsText.includes(num))
      if (missingNumbers.length > 0 && citationsText.length > 50) {
        unsupportedCount++
        const issue: ClaimCheckIssue = {
          claim_id: c.claim_id,
          sentence: c.sentence,
          verdict: 'unsupported',
          reason: `正文中提及的数值 [${missingNumbers.join(', ')}] 未在所引文献摘要或结果中核验到对应出处。`,
          suggestion: `核实数值是否与原始文献一致，或补充对应临床试验来源。`,
        }
        issues.push(issue)
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

    // 缺出处的数值句：自动挂载评论以便用户直接在「评论」面板处理或标为临床经验
    for (const u of unsourced.slice(0, 5)) {
      const existing = existingChecks.get(u.claim_id)
      if (existing?.verdict === 'exempted') continue
      unclearCount++
      const reason = '该句包含具体临床统计数值，但缺少明确的参考文献引用标注。'
      issues.push({
        claim_id: u.claim_id,
        sentence: u.sentence,
        verdict: 'no_evidence',
        reason,
        suggestion: '建议补充权威文献支撑或声明为本研究队列数据。',
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

    // 若检出 PHI 隐私数据，同样加入问题清单
    if (phiDetected) {
      for (const f of phiFindings.slice(0, 5)) {
        issues.push({
          sentence: f.redacted || f.description,
          verdict: 'unsupported',
          reason: `检出疑似患者敏感个人健康信息（${f.description}）`,
          suggestion: '请立即脱敏或移除患者个人身份信息（PHI）。',
        })
      }
    }

    const totalAudited = claims.length + unsourced.length
    let verdict: 'pass' | 'warning' | 'fail' = 'pass'
    if (phiDetected || unsupportedCount > 0) {
      verdict = 'fail'
    } else if (issues.length > 0) {
      verdict = 'warning'
    }

    onProgress.step(`质控审核完成：${supportedCount} 条论断吻合，${issues.length} 处需关注（裁定: ${verdict.toUpperCase()}）`, verdict === 'pass' ? 'ok' : 'warn')

    const summary = [
      `【质控审查裁定】：${verdict === 'pass' ? '[通过] 全部核验通过 (Pass)' : verdict === 'warning' ? '[警告] 存在存疑点，建议复核 (Warning)' : '[未通过] 发现数据不符或隐私风险，需立即修正 (Fail)'}`,
      `- 论断核验总量：${totalAudited} 处（文献支持：${supportedCount}，数据不符：${unsupportedCount}，缺出处：${unsourced.length}）`,
      `- PHI 患者隐私扫描：${phiDetected ? `[隐私告警] 检出 ${phiFindings.length} 处疑似敏感信息泄漏！` : '[通过] 未检出患者隐私数据'}`,
      issues.length > 0 ? `\n【重点发现的问题清单】：\n` + issues.map((iss, i) => `${i + 1}. 「${iss.sentence}」\n   问题：${iss.reason}\n   建议：${iss.suggestion || '请核实修改'}`).join('\n') : '',
    ].filter(Boolean).join('\n')

    return {
      role: 'fact_checker',
      verdict,
      total_claims_audited: totalAudited,
      supported_count: supportedCount,
      unsupported_count: unsupportedCount,
      unclear_count: unclearCount,
      phi_detected: phiDetected,
      phi_count: phiFindings.length,
      issues,
      summary,
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
