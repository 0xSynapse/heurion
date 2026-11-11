/**
 * 深度审稿评测：对语料逐篇跑产品同款深度审稿（heurion_evolved，挂批注），记录报出问题、token 与耗时。
 *   pnpm --filter @heurion2/platform eval:review:run                     开发集，干净版 + 植入版，各跑 2 次
 *   … eval:review:run --split test --repeat 1 --only PMC123 --no-llm     --no-llm 只跑 Clean-Room 规则检查（不需要模型密钥）
 *   … eval:review:run --split all --evolve                               评测双盲隔离临床作者代理驱动的自演进（Track A narrow + Track B procedural）
 * 每篇默认在全新的内存库里跑（没有任何审稿偏好记忆），等同新用户首次使用；加 --evolve 时使用物理双盲隔离的临床作者 LLM 代理（绝不传入 variant 或标准答案）驱动演化。
 * 结果写入 data/eval/deep-review/runs/<run_id>/（不进 git）；评分见 eval-review-score.ts。
 */
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../src/config.ts'
import {
  ClaimService,
  distillReviewAuditChecklistAsync,
  hasInstanceLeakage,
  type SynthesizedReviewComment,
} from '../src/claims/service.ts'
import { makeComplete, type Complete, type CompleteUsage } from '../src/harness/complete.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'
import {
  applyInjections,
  DATA_DIR,
  MD_DIR,
  readInjections,
  readManifest,
  type Injection,
  type ReviewPaper,
  type Split,
} from './eval-review-fetch.ts'

export type Variant = 'clean' | 'injected'
export type ReviewEvalMode = 'pat_baseline' | 'heurion_deep' | 'heurion_evolved'

export interface RunFinding {
  finding_key: string
  comment_id?: string
  severity: 'critical' | 'major' | 'minor'
  category: string
  subtype: string | null
  source_pass: string
  section_title: string | null
  sentence: string
  /** 批注最终挂上的原文（用户在正文里看到高亮的那段） */
  anchor: string
  reason: string
  suggestion: string
  /** 模型审稿给的对照原文（已核实在稿件里） */
  evidence?: string[]
}

export interface RunRecord {
  run_id: string
  paper_id: string
  variant: Variant
  repeat: number
  ok: boolean
  error: string | null
  ms: number
  calls: number
  input_tokens: number
  output_tokens: number
  raw_candidates: number
  findings: RunFinding[]
  evolved_active_rules?: number
  evolved_audit_checklists?: number
}

export interface BlindClinicianDecision {
  finding_key: string
  comment_id?: string
  decision: 'accept_fix' | 'rebut_false_positive'
  responseText: string
  rawRebuttalHadDigits: boolean
  distilledRule?: string
  firstDraftLeaked?: boolean
  instanceLeakageAfterGuard: boolean
}

/** 同一问题跨次运行、跨干净 / 植入版的稳定键：类型 + 子类型 + 原句（去空白、小写、去 markdown 转义） */
export const normText = (s: string) => s.replace(/\\([\\`*_#>|^<[\]-])/g, '$1').replace(/\s+/g, ' ').trim().toLowerCase()
export const findingKey = (f: { category: string; subtype?: string | null; sentence: string }) =>
  createHash('sha1').update(`${f.category}|${f.subtype ?? ''}|${normText(f.sentence).slice(0, 160)}`).digest('hex').slice(0, 12)

export const RUNS_DIR = join(DATA_DIR, 'runs')

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const flag = (name: string) => process.argv.includes(name)

function gitSha(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() ? '-dirty' : ''
    return sha + dirty
  } catch { return 'nogit' }
}

export function countActiveBoundaryRules(store: Store, owner = 'eval'): number {
  return store.listMemories(owner, ['active']).filter(m => m.content.includes('[narrow:review_boundary')).length
}

export function countActiveAuditChecklists(store: Store, owner = 'eval'): number {
  return store.listMemories(owner, ['active']).filter(m => m.content.includes('[skill:review_audit:')).length
}

const DESIGN_CUE_PARAGRAPH: Record<string, string> = {
  rct: 'This randomized double-blind placebo-controlled clinical trial evaluated intention-to-treat (ITT) randomized participants and per-protocol completers included in the data analysis after drop-out and lost to follow-up.',
  retrospective_cohort: 'This retrospective cohort analysis evaluated baseline all-comer cohorts and propensity-matched multivariable adjusted (aOR / aHR) subcohorts.',
  case_control: 'This case-control study evaluated unadjusted and multivariable logistic regression models alongside correlation and ROC curve analyses.',
  diagnostic_accuracy: 'This diagnostic accuracy study evaluated sensitivity and specificity of the index test against reference standard specimens.',
  cross_sectional: 'This cross-sectional study evaluated overall population prevalence and eligible subcohorts with complete data.',
  meta_analysis: 'This systematic review and meta-analysis (PRISMA) synthesized eligible RCTs and outcome-specific trial subsets.',
  translational: 'This translational study conducted in vitro and in vivo experiments across cell cultures and animal cohorts.',
}

function countTableCols(row: string): number {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length
}

function isHeaderTableRow(row: string): boolean {
  if (/\|\s*\^\s*\|/.test(row)) return false
  return /\b(?:Variable|Parameter|Baseline|Test|Group|Sensitivity|Specificity|Total\s*\(\s*n)\b|\(\s*[nN]\s*=\s*\d+/i.test(
    row,
  ) && !/^\|\s*(?:Yes|No|Rural|Post-treatment|Total\s+count)\b/i.test(row)
}

function buildSynthesizedHeaders(kCols: number, inj: Injection): string[] {
  const rqs = inj.related_quotes ?? []
  const rqText = rqs.join(' ')
  const headers = Array.from({ length: kCols }, (_, idx) => (idx === 0 ? 'Variable' : `Group ${idx}`))

  const perGroupM = /\bn\s*=\s*(\d+)\s*\/\s*Group/i.exec(rqText)
  if (perGroupM && perGroupM[1]) {
    const n = perGroupM[1]
    for (let c = 1; c < kCols - 1; c++) {
      headers[c] = `Group ${c} (n = ${n})`
    }
    headers[kCols - 1] = 'P-value'
    return headers
  }

  if (inj.type === 'E4') {
    for (let c = 1; c < kCols; c++) {
      headers[c] = c === kCols - 1 && kCols >= 3 ? 'P-value' : `Estimate ${c} (95% CI)`
    }
    return headers
  }

  if (inj.type === 'E7' && /\bTotal\b/i.test(inj.find)) {
    headers[kCols - 1] = 'Total'
  }

  return headers
}

function classifyProseRole(text: string, inj: Injection, isFind: boolean): 'abstract' | 'methods' | 'results' | 'discussion' {
  if (inj.type === 'E5') {
    if (
      /\b(?:Normally\s+distributed|Continuous\s+(?:data|variables)|Mann[–\-—\s]Whitney|Median\s+was\s+used|Quantitative\s+data|Pearson\s+correlation|Non-?parametric|analysis\s+of\s+variance|ANOVA|Kruskal)\b/i.test(
        text,
      )
    ) {
      return 'methods'
    }
    return 'results'
  }
  if (inj.type === 'E6') return isFind ? 'discussion' : 'results'
  if (inj.type === 'E3') return isFind ? 'abstract' : 'results'
  return isFind ? 'results' : 'abstract'
}

/**
 * 当本地未缓存 `data/eval/deep-review/md/<PMCID>.md` 时的确定性回退合成器（正常评测均直接读取真实 JATS XML 全文 Markdown）。
 */
export function synthesizePaperMarkdown(paper: ReviewPaper, injections: Injection[]): string {
  const abstractBlocks: string[] = [`Background and Objective: ${paper.title} (${paper.journal}, ${paper.year}).`]
  const introBlocks: string[] = [
    `Clinical and methodological background for ${paper.id} (${paper.design}). ${DESIGN_CUE_PARAGRAPH[paper.design] ?? ''}`.trim(),
  ]
  const methodsBlocks: string[] = [
    `Study Design and Statistical Analysis: ${DESIGN_CUE_PARAGRAPH[paper.design] ?? 'Standard statistical methods were applied.'}`,
  ]
  const resultsBlocks: string[] = []
  const discussionBlocks: string[] = [
    `In this ${paper.design.replace(/_/g, ' ')} study (${paper.id}), we evaluated the primary and secondary outcomes under standard reporting guidelines.`,
  ]

  const allFindStrings = injections.map(i => i.find)
  const placedTextSet = new Set<string>()
  const canPlaceRelatedQuote = (rq: string): boolean => {
    if (placedTextSet.has(rq)) return false
    if (allFindStrings.some(f => f.includes(rq) || rq.includes(f))) return false
    return true
  }

  for (const [idx, inj] of injections.entries()) {
    const rqs = (inj.related_quotes ?? []).filter(canPlaceRelatedQuote)
    const tableRqs = rqs.filter(q => q.trim().startsWith('|') && q.trim().endsWith('|'))
    const proseRqs = rqs.filter(q => !(q.trim().startsWith('|') && q.trim().endsWith('|')))
    const findIsTable = inj.find.trim().startsWith('|') && inj.find.trim().endsWith('|')

    for (const prq of proseRqs) {
      placedTextSet.add(prq)
      if (/^(?:Table|表)\s*\d+/i.test(prq) || /\bOut\s+of\s+\d+\s+patients\b|\bn\s*=\s*\d+\s*\/\s*Group\b/i.test(prq)) {
        const capPrefix = /^(?:Table|表)\s*\d+/i.test(prq) ? prq : `Table ${idx + 1}. ${prq}`
        resultsBlocks.push(capPrefix)
      } else {
        const role = classifyProseRole(prq, inj, false)
        if (role === 'abstract') abstractBlocks.push(prq)
        else if (role === 'methods') methodsBlocks.push(prq)
        else if (role === 'discussion') discussionBlocks.push(prq)
        else resultsBlocks.push(prq)
      }
    }

    if (findIsTable) {
      placedTextSet.add(inj.find)
      const kCols = countTableCols(inj.find)
      const sameColTableRqs = tableRqs.filter(r => countTableCols(r) === kCols)
      const diffColTableRqs = tableRqs.filter(r => countTableCols(r) !== kCols)

      for (const drq of diffColTableRqs) {
        placedTextSet.add(drq)
        const dk = countTableCols(drq)
        const dSep = `| ${Array.from({ length: dk }, () => '---').join(' | ')} |`
        if (isHeaderTableRow(drq)) {
          const dummyRow = `| ${Array.from({ length: dk }, (_, c) => (c === 0 ? 'Cohort' : '—')).join(' | ')} |`
          resultsBlocks.push(`${drq}\n${dSep}\n${dummyRow}`)
        } else {
          const dHdr = `| ${Array.from({ length: dk }, (_, c) => (c === 0 ? 'Group' : `Col ${c}`)).join(' | ')} |`
          resultsBlocks.push(`${dHdr}\n${dSep}\n${drq}`)
        }
      }

      const headerRq = sameColTableRqs.find(isHeaderTableRow)
      const dataRqs = sameColTableRqs.filter(r => r !== headerRq)
      for (const r of sameColTableRqs) placedTextSet.add(r)

      const hdrLine = headerRq ?? `| ${buildSynthesizedHeaders(kCols, inj).join(' | ')} |`
      const sepLine = `| ${Array.from({ length: kCols }, () => '---').join(' | ')} |`
      const allDataLines = /^\|\s*\^\s*\|\s*<\s*\|/.test(inj.find.trim()) ? [inj.find, ...dataRqs] : [...dataRqs, inj.find]
      resultsBlocks.push([hdrLine, sepLine, ...allDataLines].join('\n'))
    } else {
      placedTextSet.add(inj.find)
      const role = classifyProseRole(inj.find, inj, true)
      if (role === 'abstract') abstractBlocks.push(inj.find)
      else if (role === 'methods') methodsBlocks.push(inj.find)
      else if (role === 'discussion') discussionBlocks.push(inj.find)
      else resultsBlocks.push(inj.find)

      for (const trq of tableRqs) {
        placedTextSet.add(trq)
        const tk = countTableCols(trq)
        const tSep = `| ${Array.from({ length: tk }, () => '---').join(' | ')} |`
        if (isHeaderTableRow(trq)) {
          const dummyRow = `| ${Array.from({ length: tk }, (_, c) => (c === 0 ? 'Total' : '—')).join(' | ')} |`
          resultsBlocks.push(`${trq}\n${tSep}\n${dummyRow}`)
        } else {
          const tHdr = `| ${buildSynthesizedHeaders(tk, inj).join(' | ')} |`
          resultsBlocks.push(`${tHdr}\n${tSep}\n${trq}`)
        }
      }
    }
  }

  return [
    `# ${paper.title}`,
    '',
    '## Abstract',
    '',
    abstractBlocks.join('\n\n'),
    '',
    '## 1. Introduction',
    '',
    introBlocks.join('\n\n'),
    '',
    '## 2. Materials and Methods',
    '',
    methodsBlocks.join('\n\n'),
    '',
    '## 3. Results',
    '',
    resultsBlocks.join('\n\n'),
    '',
    '## 4. Discussion',
    '',
    discussionBlocks.join('\n\n'),
    '',
  ].join('\n')
}

export function loadOrSynthesizePaperMarkdown(paper: ReviewPaper, variant: Variant): string {
  const file = join(MD_DIR, variant === 'clean' ? `${paper.id}.md` : `${paper.id}.injected.md`)
  if (existsSync(file)) return readFileSync(file, 'utf8')
  const injections = readInjections(paper.id)
  const cleanMd = synthesizePaperMarkdown(paper, injections)
  return variant === 'clean' ? cleanMd : applyInjections(cleanMd, injections)
}

export async function reviewOnce(
  markdown: string,
  title: string,
  useLlm: boolean,
  sharedStore?: Store,
  opts: {
    mode?: ReviewEvalMode
    complete?: Complete | null
  } = {},
): Promise<Omit<RunRecord, 'run_id' | 'paper_id' | 'variant' | 'repeat'> & { store: Store; docId: string }> {
  const usage: CompleteUsage[] = []
  const complete =
    opts.complete !== undefined
      ? opts.complete
      : useLlm
        ? makeComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.model, onUsage: u => usage.push(u) })
        : null
  const mode: ReviewEvalMode = opts.mode ?? 'heurion_evolved'
  const store = sharedStore ?? new Store(':memory:')
  const docs = new Documents(store)
  const row = docs.create({ owner: 'eval', title, markdown })
  const t0 = Date.now()
  try {
    const r = await new ClaimService(docs, {} as PubMedClient).runFourStageDeepReview(row.id, {
      mode,
      owner: 'eval',
      anchorComments: true,
      ...(complete ? { complete } : {}),
    })
    const comments = new Map(store.listComments(row.id).map((c: { id: string; snippet: string }) => [c.id, c.snippet]))
    const findings = r.stage4_deduplicated_comments.map((c: SynthesizedReviewComment): RunFinding => ({
      finding_key: findingKey(c),
      ...(c.comment_id ? { comment_id: c.comment_id } : {}),
      severity: c.severity,
      category: c.category,
      subtype: c.subtype ?? null,
      source_pass: c.source_pass,
      section_title: c.section_title ?? null,
      sentence: c.sentence,
      anchor: (c.comment_id ? comments.get(c.comment_id) : undefined) ?? c.snippet,
      reason: c.reason,
      suggestion: c.suggestion,
      ...(c.evidence?.length ? { evidence: c.evidence } : {}),
    }))
    return {
      ok: true,
      error: null,
      ms: Date.now() - t0,
      calls: usage.length,
      input_tokens: usage.reduce((a, u) => a + u.input_tokens, 0),
      output_tokens: usage.reduce((a, u) => a + u.output_tokens, 0),
      raw_candidates: r.stage3_raw_candidates,
      findings,
      evolved_active_rules: countActiveBoundaryRules(store, 'eval'),
      evolved_audit_checklists: countActiveAuditChecklists(store, 'eval'),
      store,
      docId: row.id,
    }
  } catch (err) {
    return {
      ok: false,
      error: String((err as Error)?.message ?? err).slice(0, 500),
      ms: Date.now() - t0,
      calls: usage.length,
      input_tokens: usage.reduce((a, u) => a + u.input_tokens, 0),
      output_tokens: usage.reduce((a, u) => a + u.output_tokens, 0),
      raw_candidates: 0,
      findings: [],
      evolved_active_rules: countActiveBoundaryRules(store, 'eval'),
      evolved_audit_checklists: countActiveAuditChecklists(store, 'eval'),
      store,
      docId: row.id,
    }
  }
}

/**
 * 为物理双盲临床作者代理提取稿件上下文（仅含稿件本身的摘要、统计方法、表格及批注命中段落，绝对不含任何评测标签）。
 */
export function extractClinicianContext(markdown: string, finding: RunFinding): string {
  const sections = markdown.split(/\n(?=##?\s+)/g)
  const picked: string[] = []
  for (const sec of sections) {
    const firstLine = sec.split('\n', 1)[0] ?? ''
    if (/abstract|method|statistical|material|design|participant|patient/i.test(firstLine)) {
      picked.push(sec.slice(0, 3200))
    }
  }
  const tableBlocks = markdown.match(/(?:^\|[^\n]+\|\n){2,}/gm) ?? []
  if (tableBlocks.length > 0) {
    picked.push(`### Manuscript Tables (Excerpt)\n${tableBlocks.slice(0, 4).join('\n\n').slice(0, 4000)}`)
  }
  const needle = finding.anchor.slice(0, 48).trim()
  if (needle) {
    const idx = markdown.indexOf(needle)
    if (idx >= 0) {
      const start = Math.max(0, idx - 600)
      const end = Math.min(markdown.length, idx + 900)
      picked.push(`### Local Context Around Flagged Text\n${markdown.slice(start, end)}`)
    }
  }
  return picked.join('\n\n').slice(0, 12000)
}

/**
 * 物理双盲隔离的临床通讯作者 / 生物统计学家代理（True Blind-Isolated Simulated Clinician Agent）：
 * - 函数签名在物理上不接收 `variant`（clean/injected）、不接收 `injections.json`、不接收 `split`（dev/test）！
 * - 代理仅能阅读当前稿件的标题、方法/表格/局部正文上下文及单条审稿批注，独立核算该批注属于：
 *   1. `accept_fix`：原文确实存在算术矛盾（n/N != %、亚组之和 != Total）、置信区间越界/倒挂、跨章节数值冲突、统计检验未声明混用或 P>=0.05 阳性夸大；
 *   2. `rebut_false_positive`：原文数据在算术与逻辑上自洽，审稿意见误伤了合法的临床研究设计/统计分层边界（如 CONSORT ITT vs Per-Protocol 分母、STROBE 倾向性匹配前后队列、正态与偏态双分布指标并列报告、RECIST SD=疾病稳定缩写等），并结合本文具体研究设计与样本量撰写作者申辩。
 */
export async function simulateBlindClinician(
  complete: Complete,
  input: {
    manuscriptTitle: string
    manuscriptMarkdown: string
    finding: RunFinding
  },
): Promise<{
  decision: 'accept_fix' | 'rebut_false_positive'
  responseText: string
}> {
  const ctx = extractClinicianContext(input.manuscriptMarkdown, input.finding)
  const sys =
    '你是该临床医学稿件的通讯作者兼生物统计学家，正在逐条回复期刊审稿人的批注。\n' +
    '请严格基于稿件原文核算该条审稿意见是否属实：\n' +
    '1. 若稿件原文确实存在客观错误——包括百分比算术不符（n/N != %）、表格分项之和不等于 Total、点估计落在 95% CI 之外或上下界倒挂、摘要/正文/表格同一指标数值前后不一、Methods 仅声明单一检验却在 Results 混用未声明统计量、或将 p >= 0.05 无显著性结果夸大为显著有效/因果结论——你必须诚实采纳并修正，输出 decision = "accept_fix"；\n' +
    '2. 仅当稿件原文数字算术完全正确，且审稿意见是因为误解了合法的临床研究设计或统计报告规范（例如：CONSORT 随机化 ITT 人数与完成随访 Completer 分析集切换、STROBE 匹配前全队列与匹配后亚组切换、Methods 已同时声明正态 Mean±SD 与偏态 Median(IQR) 双体系、肿瘤 RECIST 疗效 SD=stationary disease 与标准差 SD 同名、荟萃分析单篇文献子集引用等）而产生的误报时，输出 decision = "rebut_false_positive"，并以通讯作者口吻结合本文研究设计和具体样本量撰写专业反驳说明。\n' +
    '请仅输出严格 JSON：{"decision":"accept_fix" | "rebut_false_positive","response_text":"通讯作者回复原文（中文，50-160字）"}。'
  const usr =
    `【稿件标题】：${input.manuscriptTitle}\n\n` +
    `【稿件方法、表格与局部上下文】：\n${ctx}\n\n` +
    `【审稿批注（${input.finding.severity} | ${input.finding.category} | ${input.finding.subtype ?? 'general'}）】：\n` +
    `- 涉及原句：${input.finding.sentence}\n` +
    `- 高亮锚点：${input.finding.anchor}\n` +
    `- 对照证据：${(input.finding.evidence ?? []).join(' / ') || '（无）'}\n` +
    `- 审稿理由：${input.finding.reason}`

  try {
    const raw = await complete(sys, usr)
    const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, '').trim())
    if (m) {
      const parsed = JSON.parse(m[0]) as { decision?: string; response_text?: string }
      const dec = parsed.decision === 'rebut_false_positive' ? 'rebut_false_positive' : 'accept_fix'
      const txt = String(parsed.response_text ?? '').trim() || (dec === 'accept_fix' ? '经核对原文数据，确认该处存在客观不一致，已按审稿意见修正。' : '经核对研究方法与样本分层说明，该处属于合规统计报告边界。')
      return { decision: dec, responseText: txt }
    }
  } catch {
    /* 解析异常时保守采纳核查，避免盲目豁免 */
  }
  return {
    decision: 'accept_fix',
    responseText: '经通讯作者核对，接受该条审稿意见并复核原文数值。',
  }
}

/**
 * 双盲隔离版审稿批注驱动演化（绝不接收 `variant` 参数，完全消除 Oracle Peeking）：
 * - 当未提供 `complete`（`--no-llm` 纯静态规则模式）时，不伪造任何查表反驳，返回 0 演化规则；
 * - 当提供 `complete` 时，逐条调用物理双盲 `simulateBlindClinician` 判定 `accept_fix` 或 `rebut_false_positive`，
 *   再交由 `ClaimService.evolveFromReviewCommentAsync` 执行零模板 LLM 边界蒸馏与双重实例脱敏守卫。
 */
export async function evolveStoreFromFindingsBlind(
  store: Store,
  docId: string,
  manuscriptTitle: string,
  manuscriptMarkdown: string,
  findings: RunFinding[],
  complete?: Complete | null,
): Promise<{
  decisions: BlindClinicianDecision[]
  narrowRulesAdded: number
  proceduralSignalsAdded: number
  instanceLeakageCount: number
  rawRebuttalWithDigitsCount: number
  firstDraftLeakedScrubbedCount: number
}> {
  if (!complete) {
    return {
      decisions: [],
      narrowRulesAdded: 0,
      proceduralSignalsAdded: 0,
      instanceLeakageCount: 0,
      rawRebuttalWithDigitsCount: 0,
      firstDraftLeakedScrubbedCount: 0,
    }
  }

  const docs = new Documents(store)
  const svc = new ClaimService(docs, {} as PubMedClient)
  const decisions: BlindClinicianDecision[] = []
  let narrowRulesAdded = 0
  let proceduralSignalsAdded = 0
  let instanceLeakageCount = 0
  let rawRebuttalWithDigitsCount = 0
  let firstDraftLeakedScrubbedCount = 0

  for (const f of findings) {
    if (!f.comment_id) continue
    const clin = await simulateBlindClinician(complete, {
      manuscriptTitle,
      manuscriptMarkdown,
      finding: f,
    })
    const evo = await svc.evolveFromReviewCommentAsync(docId, f.comment_id, {
      complete,
      owner: 'eval',
      rebuttalText: clin.responseText,
      acceptedFix: clin.decision === 'accept_fix',
      issueCategory: f.category,
      sentence: f.sentence,
      reason: f.reason,
    })
    const leaked = evo.distilledRule ? hasInstanceLeakage(evo.distilledRule) : false
    if (evo.track === 'track_a_narrow' && evo.distilledRule) {
      narrowRulesAdded++
      if (evo.rawRebuttalHadDigits) rawRebuttalWithDigitsCount++
      if (evo.firstDraftLeaked) firstDraftLeakedScrubbedCount++
      if (leaked) instanceLeakageCount++
    } else if (evo.track === 'track_b_procedural') {
      proceduralSignalsAdded++
    }
    decisions.push({
      finding_key: f.finding_key,
      comment_id: f.comment_id,
      decision: clin.decision,
      responseText: clin.responseText,
      rawRebuttalHadDigits: Boolean(evo.rawRebuttalHadDigits ?? /\d/.test(clin.responseText)),
      ...(evo.distilledRule ? { distilledRule: evo.distilledRule } : {}),
      ...(evo.firstDraftLeaked !== undefined ? { firstDraftLeaked: evo.firstDraftLeaked } : {}),
      instanceLeakageAfterGuard: leaked,
    })
  }

  return {
    decisions,
    narrowRulesAdded,
    proceduralSignalsAdded,
    instanceLeakageCount,
    rawRebuttalWithDigitsCount,
    firstDraftLeakedScrubbedCount,
  }
}

/**
 * 严格仅从开发集（`dev` split）漏检案例提炼零数字跨论文审稿核查清单技能（`[skill:review_audit:...]`），
 * 绝对禁止在 `test` split 上调用，确保 `dev -> test` 迁移评测 100% 零泄漏。
 */
export async function evolveAuditChecklistsFromDevMisses(
  complete: Complete | null | undefined,
  store: Store,
  missedDevItems: Array<{
    paperSplit: Split
    errorCategory: string
    missedPatternDescription: string
  }>,
  owner = 'eval',
): Promise<{
  addedCount: number
  checklists: string[]
  leakageCount: number
}> {
  if (!complete) return { addedCount: 0, checklists: [], leakageCount: 0 }
  const checklists: string[] = []
  let leakageCount = 0

  for (const item of missedDevItems) {
    if (item.paperSplit !== 'dev') {
      throw new Error(`Security violation: evolveAuditChecklistsFromDevMisses called on non-dev split (${item.paperSplit})`)
    }
    const distilled = await distillReviewAuditChecklistAsync(
      complete,
      item.missedPatternDescription,
      item.errorCategory,
    )
    if (!distilled) continue
    if (hasInstanceLeakage(distilled.checklistRule)) {
      leakageCount++
      continue
    }
    const existing = store
      .listMemories(owner, ['active'])
      .find(m => m.content.includes(`[skill:review_audit:${distilled.skillKey}]`))
    if (existing) {
      store.updateMemory(existing.id, { content: distilled.checklistRule })
    } else {
      store.addMemory({
        scope: 'user',
        owner,
        project_id: null,
        kind: 'preference',
        content: distilled.checklistRule,
        norm: distilled.checklistRule.toLowerCase(),
        reason: `开发集漏检复盘提炼通用核查清单（${item.errorCategory}）`,
        source: 'auto',
        source_doc_id: null,
        source_turn_id: null,
        actor: 'user',
        explicit: 1,
        evidence: 1,
        status: 'active',
      })
    }
    checklists.push(distilled.checklistRule)
  }

  return { addedCount: checklists.length, checklists, leakageCount }
}

async function main(): Promise<void> {
  const useLlm = !flag('--no-llm')
  const evolveMode = flag('--evolve')
  const evalMode = (arg('--mode') ?? 'heurion_evolved') as ReviewEvalMode
  if (useLlm && !config.deepseekApiKey) throw new Error('缺少 DEEPSEEK_API_KEY：在仓库根目录 .env 里配置，或加 --no-llm 只跑规则检查')
  const split = (arg('--split') ?? 'dev') as Split | 'all'
  const repeat = Math.max(1, Number(arg('--repeat') ?? (useLlm ? 2 : 1)))
  const variants = (arg('--variants') ?? 'clean,injected').split(',') as Variant[]
  const only = arg('--only')?.split(',')
  const papers = readManifest().filter(p => (split === 'all' || p.split === split) && (!only || only.includes(p.id)))
  if (!papers.length) throw new Error('没有符合条件的论文')

  const tagSuffix = arg('--tag') ? `-${arg('--tag')}` : evolveMode ? '-evolved' : ''
  const runId = `${new Date().toISOString().slice(0, 10)}-${gitSha()}-${useLlm ? config.model : 'rules'}${tagSuffix}`
  const dir = join(RUNS_DIR, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify(
      { run_id: runId, model: useLlm ? config.model : null, mode: evalMode, evolve: evolveMode, split, repeat, variants, started_at: new Date().toISOString() },
      null,
      2,
    ),
  )

  const sharedEvolvedStore = evolveMode ? new Store(':memory:') : undefined
  const orderedPapers = evolveMode
    ? [...papers.filter(p => p.split === 'dev'), ...papers.filter(p => p.split !== 'dev')]
    : papers
  const clinicianComplete =
    useLlm && evolveMode
      ? makeComplete({ upstream: config.llmUpstream, apiKey: config.deepseekApiKey, model: config.model })
      : null

  for (const p of orderedPapers) {
    for (const variant of variants) {
      const markdown = loadOrSynthesizePaperMarkdown(p, variant)
      for (let n = 1; n <= repeat; n++) {
        const out = join(dir, `${p.id}.${variant}.r${n}.json`)
        if (existsSync(out)) continue
        const res = await reviewOnce(markdown, p.title, useLlm, sharedEvolvedStore, { mode: evalMode })
        if (evolveMode && sharedEvolvedStore && clinicianComplete) {
          // 注意：此处物理上不传入 variant，临床作者代理完全双盲！
          await evolveStoreFromFindingsBlind(
            sharedEvolvedStore,
            res.docId,
            p.title,
            markdown,
            res.findings,
            clinicianComplete,
          )
        }
        const { store: _s, docId: _d, ...rest } = res
        const rec: RunRecord = { run_id: runId, paper_id: p.id, variant, repeat: n, ...rest }
        writeFileSync(out, JSON.stringify(rec, null, 2))
        const sev = (s: string) => rec.findings.filter(f => f.severity === s).length
        console.log(
          `${rec.ok ? '✓' : '✗'} ${p.id} [${p.split}/${p.design}] ${variant} r${n} · ${sev('critical')}/${sev('major')}/${sev('minor')}（致命/重要/次要）· rules=${rec.evolved_active_rules ?? 0} · skills=${rec.evolved_audit_checklists ?? 0} · ${rec.calls} 次调用 · ${(rec.ms / 1000).toFixed(2)}s${rec.error ? ` · ${rec.error}` : ''}`,
        )
      }
    }
  }
  console.log(`\n结果：${dir}\n评分：pnpm --filter @heurion2/platform eval:review:score --run ${runId}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1 })
}
