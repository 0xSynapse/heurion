/**
 * 论断核对与四阶段深度临床评审服务（M1，PLATFORM.md §5.5 & Google PAT arXiv:2606.28277 扩展）：
 * - Stage 1：章节感知切分（intro / methods / results / discussion）与跨章节共享 Scratchpad 构建；
 * - Stage 2：自适应核查预算分级（light / medium / high Thinking Track）；
 * - Stage 3：多维专项审查（Pass A 外部文献对齐、Pass B 内部自洽、Pass C 方法-结果配对、Pass D Spin 与报告规范）；
 * - Stage 4：全局去重合成与批注锚定（{#c:id}）及审稿批注驱动的双轨自演进（evolveFromReviewComment）。
 */
import { createHash } from 'node:crypto'
import type { Node as PMNode } from 'prosemirror-model'
import type { Complete } from '../harness/complete.ts'
import { attachComment, AnchorError } from '../model/anchors.ts'
import { indexById } from '../model/ids.ts'
import { readGrid } from '../model/table-grid.ts'
import type { Documents } from '../model/runtime.ts'
import { relevantPassages, type FullTextClient } from '../literature/fulltext.ts'
import type { PubMedClient } from '../literature/pubmed.ts'
import type { CitationRow, ClaimVerdict, EvidenceTier } from '../store/db.ts'
import { referencePlan } from '../model/references.ts'
import { snapshotText } from '../model/measurements.ts'
import { getDomainSkillAdapter } from '../memory/domain-adapters.ts'
import { sensitiveReason } from '../memory/guard.ts'
import {
  auditInternalConsistency,
  auditMethodResultConsistency,
  auditSpinAndGuidelines,
  buildManuscriptScratchpad,
  classifySectionRole,
  classifyVerificationTier,
  extractClaims,
  extractTableSummaries,
  isExemptedByActiveRules,
  isHardObjectiveReviewFinding,
  SectionRoleTracker,
  type Claim,
  type DeepReviewAuditIssue,
  type DeepReviewCategory,
  type ManuscriptScratchpad,
  type SectionRole,
  type TableSummary,
  type VerificationTier,
} from './extract.ts'
import { headingText, isPendingDeletion } from './extract.ts'
import { assessTablesWithVision, type TableVision } from './table-vision.ts'
import { normForMatch, numberKey, parseVerdicts, quotedIn, VERIFY_SYSTEM } from './review-evidence.ts'

/**
 * 论断核对与四阶段深度临床评审服务（M1，PLATFORM.md §5.5 & Google PAT arXiv:2606.28277 扩展）：
 * - Stage 1：章节感知切分（intro / methods / results / discussion）与跨章节共享 Scratchpad 构建；
 * - Stage 2：自适应推理预算分配（light / medium / high）；
 * - Stage 3：并行多维专项深审（Pass A 文献/PMC表格核对 + Pass B 表文算术自洽 + Pass C 统计方法配对 + Pass D Spin/规范）；
 * - Stage 4：全局合成 Judge（跨章节去重、严重度门控、基于自进化记忆过滤假阳性，并挂载为文内批注 {#c:id}）。
 */

const PAGE = 8
/** 给模型的摘要上限（C2 评测：1800 字时六成摘要的结果 / 结论段被截掉，数字类召回低 16 个百分点）。 */
export const ABSTRACT_MAX = 4000

/** 超长摘要截断时优先保留结果与结论段（数字和结论在那里），前面的背景 / 方法按剩余长度保留。 */
export function fitAbstract(abstract: string, max = ABSTRACT_MAX): string {
  if (abstract.length <= max) return abstract
  const m = /\b(RESULTS?|FINDINGS)\b\s*[:：]?/.exec(abstract) ?? /\bCONCLUSIONS?\b\s*[:：]?/.exec(abstract)
  if (!m || m.index === 0) return abstract.slice(0, max)
  const tail = abstract.slice(m.index)
  if (tail.length >= max - 200) return tail.slice(0, max)
  return `${abstract.slice(0, max - tail.length - 3).trimEnd()} … ${tail}`
}

/**
 * 论断核对的判定标准（verifyPrompt 与 C2 评测共用，改这里两边一起变）。
 * v4（四阶段学术审稿工作流）：
 * - 关注数值等价性（如 74% 与 0.74）与效应方向性矛盾；
 * - 结合章节角色（section_role）与核查预算分级（verification_tier: high/medium/light）分配审查力度；
 * - 理由用中文，明确给出【建议修改为】纠正文本。
 */
export const CLAIM_CRITERIA =
  '逐条只依据所引文献的摘要（以及给出的开放获取全文与表格片段）判断，不凭记忆补充：' +
  'supported = 摘要或全文/表格支持该句的说法与数字（注意百分比与小数等价性，如 74% 与 0.74 视为一致）；' +
  'unsupported = 摘要或全文/表格与该句矛盾，或数字、结论、人群、药物 / 干预、效应方向任何一处对不上——只要你的理由里指出了某处不符，结论就必须是 unsupported，不能是 unclear；若为特定亚组/分层，请对照对应表格列核对；若摘要支持总体趋势，但开放全文/表格中给出了相反或修正后的数字（例如多因素校正后无显著差异），必须判为 unsupported，在 reason 中写明「全文/表格修正了摘要结论」，并在 evidence_quote 中附上对应的全文/表格原文；' +
  'unclear = 证据涉及该句的内容，但信息不足以确认或否定。' +
  '没有摘要和全文片段，或它们根本没涉及该句说的内容时，判 unclear 并标 no_evidence=true（这类不会逐句挂评论，只在总结里汇总）。' +
  '每条结果在 claim_report 中还需输出 evidence_tier（table = 经开放全文表格/图注核实，fulltext = 经开放全文正文段落核实，abstract = 仅凭 PubMed 摘要核实，none = 无可用摘要或全文证据）与 evidence_quote（原文摘要或开放全文/表格中与该句论断直接对应的具体原文原句或表格行摘录，必须原样摘录原文中的关键句或 Markdown 表格行，供医生直接对照）。' +
  'reason 用中文，一两句话写明依据（引用摘要或表格里的关键数字或结论）；若判 unsupported 且文献有明确相反或正确数字，请在末尾加上【建议修改为】：<简明纠正文本>。'

export interface ClaimEvidence {
  claim_id: string
  node_id: string
  sentence: string
  section_title?: string
  section_role?: SectionRole
  verification_tier?: VerificationTier
  citations: Array<{
    cite_id: string
    number: number | null
    reference: string
    abstract: string | null
    /** 开放获取全文里与该句最相关的片段（摘要之外的证据；没有开放全文时缺省）。 */
    fulltext?: { source: string; passages: string[] }
  }>
  /** 所引文献都没有可用摘要：没有可核对的证据。 */
  no_abstract?: true
  last_verdict?: ClaimVerdict
}

export type DeepReviewMode =
  | 'zero_shot'
  | 'pass_at_k'
  | 'pat_baseline'
  | 'heurion_deep'
  | 'heurion_evolved'

export interface SynthesizedReviewComment {
  id: string
  comment_id?: string
  node_id: string
  section_title?: string
  section_role: SectionRole
  verification_tier: VerificationTier
  category: DeepReviewCategory | 'missing_citation'
  subtype?: string
  severity: 'critical' | 'major' | 'minor'
  sentence: string
  snippet: string
  reason: string
  suggestion: string
  source_pass: 'llm_stage3' | 'pass_a_citation' | 'pass_b_internal' | 'pass_c_method' | 'pass_d_spin'
  /** 针对表格某一格：[网格行, 列]（node_id 是表格） */
  cell?: [number, number]
  /** 模型审稿给的证据：与原句矛盾的另一处原文（已核实在稿件里） */
  evidence?: string[]
}

export interface FourStageReviewResult {
  doc_id: string
  mode: DeepReviewMode
  scratchpad: ManuscriptScratchpad
  stage1_sections: number
  stage2_budget_counts: Record<VerificationTier, number>
  stage3_raw_candidates: number
  stage4_deduplicated_comments: SynthesizedReviewComment[]
  active_rules_applied: string[]
  /** 给用户看的审稿说明（如表格结构不可靠、已跳过表格核查） */
  warnings: string[]
  /** 这次审了什么、跳过了什么（docs/design/REVIEW_QUALITY.md） */
  coverage?: ReviewCoverage
  /** 全文复核删掉的模型意见数 */
  verifier_rejected?: number
}

/** 审稿的步骤（进度显示与按阶段统计用量）。 */
export type ReviewStep = 'read' | 'rules' | 'sections' | 'verify' | 'synthesize'
export interface ReviewProgress { step: ReviewStep; status: 'running' | 'done' | 'skipped'; done?: number; total?: number; detail?: string }

/** 覆盖范围：让用户看得出系统到底做了多少。 */
export interface ReviewCoverage {
  words: number
  sections_total: number
  /** 交给模型逐章节审的章节（合并后的审稿单元数） */
  sections_reviewed: number
  /** 没有交给模型的章节标题（致谢、参考文献等样板章节，或核查力度为「轻」的引言） */
  sections_skipped: string[]
  tables_total: number
  tables_checked: number
  /** 有没有用模型（没配置模型时只做规则核查） */
  llm: boolean
  /** 有没有做全文复核 */
  verifier: boolean
}

/**
 * 深度审稿 Stage 3 的章节审稿提示词（产品模式）。审稿的成败在误报：只报能用稿件原文证明的客观错误，
 * 每条必须逐字引用原句与证据（另一处矛盾的原文、表格单元格或统计量），程序会核实引文确实在稿件里。
 */
export function sectionReviewPrompt(title: string, role: SectionRole, scratchpadSummary: string, rulesContext: string): string {
  return (
    `你是医学期刊的统计与数据核对审稿人，正在审查章节「${title}」（角色：${role}）。\n` +
    `${scratchpadSummary}${rulesContext}\n` +
    '只报告能用本稿原文证明的客观错误，例如：\n' +
    '- 同一个数（样本量、结局人数、效应量、P 值）在两处写得不一样（正文与摘要、正文与表格、前后章节）；\n' +
    '- 百分比与分子分母算不上、分组人数加起来不等于总数；\n' +
    '- 点估计落在置信区间外、区间上下界倒挂；\n' +
    '- 方法里写的统计方法 / 汇总指标与结果里报告的不一致；\n' +
    '- 结论与报告的统计结果不符（如 P > 0.05 却写「显著」，观察性研究写成因果）。\n' +
    '不要报告：写作与表达建议、研究设计或方法学的主观评价、局限性、建议补充的分析、缺少的引用、你无法在本稿中找到对照原文的怀疑。\n' +
    '也不要报告「没有报告 / 没有给出 / 缺少某项结果、方法或数据」：你只看到本章节和摘要，缺的内容多半写在方法、结果或表格的别处。' +
    '只报告两处原文直接矛盾、或原文自身算不上的问题。\n' +
    '以下不算错误，不要报告：\n' +
    '- 用原始人数或样本构成去验算加权、校正、标化后的估计（加权患病率、校正 OR / HR、年龄标化率本来就与粗算不同）；\n' +
    '- 四舍五入造成的小差异（几个百分比相加为 99.9% 或 100.1%、末位相差 1）；\n' +
    '- 两处数字属于不同的结局、人群、时间点、模型或分析集（如粗 OR 与校正 OR、ITT 与 PP、总人群与亚组）——比较前先确认说的是同一件事。\n' +
    '每条必须给出两段逐字摘录：sentence = 有问题的原句（从提供的正文或表格中逐字复制，不要改写）；' +
    'evidence = 证明它有问题的另一处原文（逐字复制的矛盾句子、表格行或统计量，可以有 1–3 段）。拿不出 evidence 的不要报。\n' +
    '严重程度：critical = 主要结局、主要样本量或关键数字错误；major = 次要结局的数值矛盾、方法与结果不一致、结论夸大；minor = 次要变量的小算术错误。\n' +
    '宁缺毋滥：没有把握就不报；一个章节通常 0–2 条，最多 3 条。没有问题返回 []。\n' +
    '严格输出 JSON 数组：[{"node_id":"块ID","sentence":"原句","evidence":["证据原文"],"category":"internal_inconsistency|method_result_mismatch|spin_or_guideline","severity":"critical|major|minor","reason":"中文：哪两处对不上、具体数字","suggestion":"中文修改建议"}]。'
  )
}

/** 声明性章节：伦理、基金、致谢、数据可得性、作者贡献、利益冲突、缩写、补充材料等，没有可核对的结果数据，不送审 */
// 只要求词首边界：这些多是词干（acknowledg-ements、ethic-s、availab-ility、interest-s），
// 以前末尾还要求词尾边界，「Acknowledgements」「Ethics」「Data availability」「Competing interests」都匹配不上，被当正文送去审稿
const BOILERPLATE_SECTION = /\b(?:ethic|funding|financial support|acknowledg|data (?:availab|sharing)|availability of data|code availab|author(?:s'?|ship)? contribution|contributions|conflicts? of interest|competing interest|disclosure|declaration|consent for publication|patient consent|informed consent statement|abbreviation|supplementary|publisher'?s note|trial registration|registration|patient and public involvement)|^\s*references?\s*$|^\s*参考文献\s*$|伦理|基金|资助|致谢|数据(?:可用|可得|共享)|作者贡献|利益冲突|缩略|补充材料/i

interface ReviewSection { title: string; role: SectionRole; tier: VerificationTier; blocks: Array<{ nodeId: string; text: string; tier: VerificationTier }> }

/**
 * 深度审稿的章节调度（产品模式）：不审声明性章节；相邻的同角色小章节（每节不到 1500 字）合成一次调用，凑到约 3000 字为止。
 * 评测稿件里三成的调用审的是不到 600 字的章节，每次都要带上系统提示与对照材料。摘要章节单独审，不与别的合并。
 */
export function scheduleReviewSections<T extends ReviewSection>(sections: T[], abstractSection?: T): T[] {
  const size = (s: ReviewSection) => s.blocks.reduce((n, b) => n + b.text.length, 0)
  const out: T[] = []
  for (const s of sections) {
    if (s !== abstractSection && BOILERPLATE_SECTION.test(s.title)) continue
    const last = out[out.length - 1]
    if (last && s !== abstractSection && last !== abstractSection && last.role === s.role && size(s) < 1500 && size(last) < 3000) {
      out[out.length - 1] = { ...last, title: `${last.title} / ${s.title}`, tier: last.tier === 'high' || s.tier === 'high' ? 'high' : last.tier, blocks: [...last.blocks, ...s.blocks] }
      continue
    }
    out.push(s)
  }
  return out
}

/**
 * 审稿意见的结局（docs/design/REVIEW_QUALITY.md）：采纳修改 / 驳回是自演进 A、B 两轨的同一个入口，在这里记下。
 * 记录失败不影响演进。
 */
function recordFindingOutcome(store: any, commentId: string, opts: { acceptedFix?: boolean; rebuttalText?: string }): void {
  try {
    if (typeof store?.setReviewFindingOutcome !== 'function') return
    if (opts.acceptedFix) store.setReviewFindingOutcome(commentId, 'accepted')
    else if (opts.rebuttalText) store.setReviewFindingOutcome(commentId, 'rejected')
  } catch { /* 质量记录不影响审稿与演进 */ }
}

/** 字数：汉字按字、其他按词（覆盖范围与「每千字意见数」用）。 */
export function countWords(text: string): number {
  return (text.match(/[一-鿿]/g)?.length ?? 0) + (text.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9]+/g)?.length ?? 0)
}

export function untrustedTablesWarning(skipped: string[]): string {
  return `此 PDF 有 ${skipped.length} 张表格未能可靠识别，本次审稿没有核查这些表格：${skipped.join('；')}。建议上传 Word 原稿以获得完整审稿。`
}

export const TABLES_UNRELIABLE_WARNING =
  '此 PDF 的表格未能可靠识别（文档解析服务不可用，已用备用方式导入），本次审稿跳过了依赖表格的核查。建议上传 Word 原稿以获得完整审稿。'

const BOUNDARY_STOP_WORDS_EN = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'were', 'was', 'are', 'has', 'have', 'had',
  'not', 'but', 'our', 'their', 'into', 'over', 'after', 'before', 'between', 'among', 'within',
  'without', 'only', 'also', 'than', 'such', 'both', 'each', 'more', 'most', 'other', 'some',
  'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'why', 'how', 'all', 'any', 'can',
  'may', 'will', 'would', 'should', 'could', 'been', 'being', 'does', 'did', 'done', 'center',
  'study', 'cohort', 'patients', 'patient', 'group', 'groups', 'table', 'figure', 'data', 'results',
])

const BOUNDARY_STOP_WORDS_ZH = new Set([
  '本研究', '研究', '我们', '该数', '该处', '属于', '并非', '无需', '不需', '其中', '以及',
  '进行', '采用', '显示', '表明', '结果', '方法', '讨论', '摘要', '数据', '分析', '报告',
  '说明', '由于', '因为', '所以', '如果', '可以', '通过', '根据', '按照', '没有', '存在',
  '患者', '队列', '本中心', '入组',
])

function extractSanitizedBoundaryKeywords(texts: string[], maxCount = 5): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (w: string) => {
    const clean = w.trim().toLowerCase()
    if (clean.length < 2 || /\d/.test(clean) || seen.has(clean)) return
    seen.add(clean)
    out.push(clean)
  }

  for (const raw of texts) {
    if (!raw) continue
    const stripped = raw
      .replace(/\[@[cm]:[^\]]+\]/g, ' ')
      .replace(/\b\d+(?:\.\d+)?%?\b/g, ' ')
      .toLowerCase()

    for (const m of stripped.matchAll(/\b[a-z][a-z-]{2,}\b/g)) {
      const w = m[0]!
      if (!BOUNDARY_STOP_WORDS_EN.has(w)) push(w)
      if (out.length >= maxCount) return out
    }

    const cjkChunks = stripped.split(/[，。；：？！、（）【】《》“”‘’"',.;:?!()[\]\s的和与在及或为是了于对将按由把被从向到等中内上下的地得仅只但而却且并则即各每]+/)
    for (const chunk of cjkChunks) {
      for (const m of chunk.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
        const seg = m[0]!
        if (BOUNDARY_STOP_WORDS_ZH.has(seg)) continue
        const token = seg.length <= 4 ? seg : seg.slice(0, 4)
        if (!BOUNDARY_STOP_WORDS_ZH.has(token)) push(token)
        if (out.length >= maxCount) return out
      }
    }
  }
  return out
}

const DEDUP_STOP_WORDS_EN = new Set([
  ...BOUNDARY_STOP_WORDS_EN,
  'arm', 'arms', 'subject', 'subjects', 'participant', 'participants', 'case', 'cases', 'sample',
  'total', 'fig', 'section', 'value', 'values', 'rate', 'rates', 'level', 'levels', 'score', 'scores',
  'method', 'methods', 'analysis', 'compared', 'showed', 'observed', 'reported', 'found', 'using',
  'based', 'mean', 'median', 'iqr', 'range', 'std', 'sem', 'ci', 'hr', 'or', 'rr', 'vs', 'versus',
  'mmhg', 'bpm', 'mg', 'kg', 'cm', 'mm', 'ml', 'dl', 'ul', 'ug', 'ng', 'pg', 'mmol', 'umol', 'mol',
  'iu', 'gy', 'cgy', 'sec', 'min', 'hrs', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
])

const DEDUP_STOP_WORDS_ZH = new Set([
  ...BOUNDARY_STOP_WORDS_ZH,
  '病例', '样本', '组别', '对照组', '试验组', '观察组', '表格', '相比', '比较', '差异', '显著',
  '平均', '均数', '中位数', '比例', '发生率', '水平', '评分', '纳入', '共计', '总计', '分别', '或者', '之间',
  '毫米', '个月', '小时', '分钟',
])

function extractTopicTokensForDedup(texts: string[]): Set<string> {
  const tokens = new Set<string>()
  const blob = texts.join(' ').toLowerCase()
  for (const m of blob.matchAll(/\b[a-z][a-z0-9_-]{1,}\b/g)) {
    const w = m[0]!
    if (/^\d+$/.test(w) || DEDUP_STOP_WORDS_EN.has(w)) continue
    tokens.add(w)
  }
  const cjkChunks = blob.split(/[，。；：？！、（）【】《》“”‘’"',.;:?!()[\]\s的和与在及或为是了于对将按由把被从向到等中内上下的地得仅只但而却且并则即各每]+/)
  for (const chunk of cjkChunks) {
    for (const m of chunk.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
      const seg = m[0]!
      if (DEDUP_STOP_WORDS_ZH.has(seg)) continue
      tokens.add(seg.length <= 4 ? seg : seg.slice(0, 4))
    }
  }
  return tokens
}

const CLINICAL_SPECIALTY_EXAMPLE_LEAK_RE =
  /(?:妊娠期高血压|先兆子痫|子痫|糖尿病|冠心病|心肌梗死|高血压病|乳腺癌|肺癌|胃癌|肝癌|结直肠癌|前列腺癌|白血病|淋巴瘤|黑色素瘤|皮瓣|植皮|皮肤移植|骨折|关节炎|肺炎|结核|哮喘|阿尔茨海默|帕金森|抑郁症|精神分裂|脑卒中|preeclampsia|gestational\s+hypertension|diabetes\s+mellitus|carcinoma|melanoma|leukemia|lymphoma|skin\s+graft|flap\s+reconstruction)/i

export function scrubSpecialtyExampleLeakage(body: string): string {
  if (!body) return body
  let out = body
  if (CLINICAL_SPECIALTY_EXAMPLE_LEAK_RE.test(out)) {
    out = out
      .replace(/（[^）]*(?:如|例如|比如)[^）]*）/g, '')
      .replace(/\([^)]*(?:e\.g\.|such\s+as|for\s+example|如|例如)[^)]*\)/gi, '')
      .replace(CLINICAL_SPECIALTY_EXAMPLE_LEAK_RE, '特定临床专科指标')
  }
  return out.replace(/\s+/g, ' ').trim()
}

export function hasInstanceLeakage(text: string): boolean {
  if (getDomainSkillAdapter('manuscript').hasInstanceLeakage(text)) return true
  if (text.includes('[narrow:review_boundary') || text.includes('[skill:review_audit:')) {
    const bodyWithoutTags = text.replace(/\[[^\]]+\]/g, '')
    if (/\d/.test(bodyWithoutTags)) return true
    if (CLINICAL_SPECIALTY_EXAMPLE_LEAK_RE.test(bodyWithoutTags)) return true
  }
  return false
}

/**
 * 从临床医生的自然语言反驳（Rebuttal）与原句上下文中提炼去数字化的专科边界规则（Track A narrow）。
 * 强制剥离具体样本量、P 值、HR、置信区间等实例数字，确保 0% 跨队列实例泄漏（Instance Contamination = 0%）。
 */
export function synthesizeSanitizedBoundaryRule(
  rebuttalOrCategory: string,
  contextOrSentence: { sentence?: string; category?: string; reason?: string } | string = {},
  maybeReason?: string,
  maybeRebuttal?: string,
): { patternKey: string; rule: string } {
  const isPositional = typeof contextOrSentence === 'string'
  const rebuttalText = isPositional ? (maybeRebuttal ?? maybeReason ?? rebuttalOrCategory) : rebuttalOrCategory
  const context: { sentence?: string; category?: string; reason?: string } = isPositional
    ? {
        category: rebuttalOrCategory,
        sentence: contextOrSentence,
        ...(maybeRebuttal !== undefined && maybeReason !== undefined ? { reason: maybeReason } : {}),
      }
    : contextOrSentence

  const combined = `${rebuttalText} ${context.sentence ?? ''} ${context.reason ?? ''}`.toLowerCase()

  // 1. 目标试验模拟（TTE）克隆-删失-加权（CCW）伪队列与因果效应指标
  if (
    /(?:target\s+trial\s+emulation|\btte\b|clone|克隆|删失|ccw|不死时间|immortal\s+time|伪队列)/i.test(combined)
  ) {
    return {
      patternKey: 'target_trial_emulation_ccw',
      rule:
        '[domain:manuscript] [narrow:review_boundary:target_trial_emulation_ccw] 审稿核查边界收窄：在目标试验模拟（Target Trial Emulation, TTE）采用克隆-删失-加权（CCW）消除不死时间偏倚的研究中，结果表中的克隆伪队列样本量（clones）允许大于或不同于原始入组分组人数，且优先报告绝对风险差（RD）与相对风险（RR）而非传统 HR，免于触发样本量不一致或缺失 HR 误报。',
    }
  }

  // 2. 单臂 II 期临床试验与历史对照 / ITT vs 手术切除分母
  if (
    /(?:单臂|single[\s-]arm|历史对照|historical\s+control|无需.*对照组|without\s+a\s+control\s+arm|手术.*人群.*itt)/i.test(
      combined,
    )
  ) {
    return {
      patternKey: 'single_arm_phase2_trial',
      rule:
        '[domain:manuscript] [narrow:review_boundary:single_arm_phase2_trial] 审稿核查边界收窄：在探索性单臂 II 期临床试验（Single-Arm Phase II Trial）中，基线特征表与生存终点系与预设历史对照阈值比对，无需平行对照组及组间比较 P 值；且病理缓解率（pCR/MPR）允许按接受手术切除人群（Per-Protocol）与全入组人群（ITT）分别报告，免于触发缺平行对照组误报。',
    }
  }

  // 3a. 回顾性队列研究匹配前原始人群与倾向性匹配/多因素完整协变量亚组边界
  if (
    /(?:回顾性队列|retrospective\s+cohort|倾向性评分|propensity|匹配前后|匹配亚组|多因素回归亚组)/i.test(combined)
  ) {
    return {
      patternKey: 'retrospective_cohort_matching_boundary',
      rule:
        '[domain:manuscript] [narrow:review_boundary:retrospective_cohort_matching_boundary] 审稿核查边界收窄：在遵循 STROBE 规范的回顾性队列研究中，匹配前原始入组总队列与倾向性评分匹配后子队列（或具有完整多因素协变量记录的分析亚组）属于标准分层报告，允许基线表与多因素回归表采用各自对应的合法分母。',
    }
  }

  // 3b. 病例对照研究（Case-Control）多级递进协变量调整模型与相关性/ROC 组合边界
  if (
    /(?:病例对照|case-control|递进调整|多模型|粗比值比|crude\s+or|adjusted\s+or|协变量调整模型)/i.test(combined)
  ) {
    return {
      patternKey: 'case_control_multimodel_boundary',
      rule:
        '[domain:manuscript] [narrow:review_boundary:case_control_multimodel_boundary] 审稿核查边界收窄：在病例对照研究中，同时报告未调整粗比值比与多级递进协变量调整模型及生物标志物相关性/受试者工作特征曲线（ROC）分析属于标准统计报告范式，不同调整模型间的效应量差异免于触发方法结果矛盾误报。',
    }
  }

  // 3c. 诊断准确性研究（STARD）受试者总人数与有效质控标本/参考标准亚组边界
  if (
    /(?:诊断准确性|diagnostic\s+accuracy|\bstard\b|参考标准|reference\s+standard|index\s+test|可评估标本|有效质控)/i.test(combined)
  ) {
    return {
      patternKey: 'diagnostic_specimen_reference_boundary',
      rule:
        '[domain:manuscript] [narrow:review_boundary:diagnostic_specimen_reference_boundary] 审稿核查边界收窄：在遵循 STARD 规范的诊断准确性研究中，筛查招募总人数、通过质控可评估标本数与金标准阳性/阴性参考标准亚组属于合法多级诊断分母，免于触发样本量分母不一致误报。',
    }
  }

  // 3d. 横断面流行病学研究（Cross-Sectional）全样本患病率人群与特定风险预测合格子队列边界
  if (
    /(?:横断面|cross-sectional|全人群粗患病率|风险预测子队列|合格预测子队列|年龄合格亚组)/i.test(combined)
  ) {
    return {
      patternKey: 'cross_sectional_subcohort_boundary',
      rule:
        '[domain:manuscript] [narrow:review_boundary:cross_sectional_subcohort_boundary] 审稿核查边界收窄：在横断面流行病学研究中，全样本基线患病率分析集与满足特定年龄段或无既往事件要求的心血管/临床风险预测子队列属于合法分层结构，允许两部分采用各自对应的样本分母。',
    }
  }

  // 3e. 系统评价与荟萃分析（PRISMA Meta-Analysis）纳入总试验数与特定结局可用试验子集边界
  if (
    /(?:荟萃分析|系统评价|meta-analysis|\bprisma\b|特定结局指标|可用试验子集|研究子集)/i.test(combined)
  ) {
    return {
      patternKey: 'meta_analysis_trial_subset_boundary',
      rule:
        '[domain:manuscript] [narrow:review_boundary:meta_analysis_trial_subset_boundary] 审稿核查边界收窄：在遵循 PRISMA 规范的系统评价与荟萃分析中，文献检索纳入的总合格试验数与报告某一特定次要结局或时间点的可用试验子集人数自然不同，按各结局实际汇报试验子集合并免于触发总样本量矛盾误报。',
    }
  }

  // 4. 转化医学体内外动物实验分组与临床组织芯片队列（TMA）双体系规范
  if (
    /(?:小鼠|动物实验|荷瘤|xenograft|\bmice\b|组织芯片|\btma\b|流式|免疫微环境|体外实验|in\s+vitro\s+and\s+in\s+vivo|多实验批次|体内外)/i.test(combined)
  ) {
    return {
      patternKey: 'translational_animal_tma_dual_cohort',
      rule:
        '[domain:manuscript] [narrow:review_boundary:translational_animal_tma_dual_cohort] 审稿核查边界收窄：在转化医学体内外联合研究中，体外细胞或虫体培养孔板重复实验（in vitro replicates）与体内动物实验分组（in vivo animal cohorts）及临床组织芯片（TMA）属于独立实验体系，不同独立实验模块的样本量按实验设计分别设定，免于触发跨体系分母不一致误报。',
    }
  }

  // 4b. 临床筛查人群 vs 随机化队列 vs 非随机观察队列 / 发现-训练-验证多层子队列设计
  if (
    /(?:非\s*ccr|non[\s-]ccr|观察队列|筛查.*随机|平行观察|双队列|多队列|发现队列|训练队列|验证队列|子队列|multi[\s-]cohort)/i.test(
      combined,
    )
  ) {
    return {
      patternKey: 'multi_cohort_trial_structure',
      rule:
        '[domain:manuscript] [narrow:review_boundary:multi_cohort_trial_structure] 审稿核查边界收窄：当临床研究同时包含总筛查人群、达完全缓解（cCR）随机化队列与未达标平行观察队列时，各亚表分母按对应子队列独立核算，不强制要求随机表两组之和等于总筛查人数。',
    }
  }

  // 4c. 随机对照试验（RCT）意向性分析集（ITT）与完成随访/符合方案集（Completers/Per-Protocol）双口径边界
  if (
    /(?:意向性分析|\bitt\b|per-protocol|completers?|完成随访|完成研究|consort|脱落|随机对照试验|\brct\b)/i.test(combined)
  ) {
    return {
      patternKey: 'rct_itt_completer_boundary',
      rule:
        '[domain:manuscript] [narrow:review_boundary:rct_itt_completer_boundary] 审稿核查边界收窄：在遵循 CONSORT 规范的随机对照试验（RCT）中，基线随机化意向性分析集（ITT）与完成随访或纳入终末结局评估的符合方案集（Completers/Per-Protocol）属于合法双分析集结构，允许不同结局表按各自预定义分析集分母报告，免于触发分母切换误报。',
    }
  }

  // 5. 通用去数字化反驳规则合成（剥离所有阿拉伯数字、百分比与患者标识，提取 2-5 个领域/结构关键词并携带 cat 与 kw 标签）
  const sanitizedRebuttal = rebuttalText
    .replace(/\b(?:n|N|clones?|HR|OR|RR|P|p)\s*[=<>≤≥:：]\s*\d+(?:\.\d+)?%?/g, '指定统计量')
    .replace(/\b\d+(?:\.\d+)?\s*(?:%|％|例|人|名|个|只|天|月|年|mm³|mm3|mm|Gy)\b/g, '特定定量值')
    .replace(/\b\d+(?:\.\d+)?\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)

  const resolvedCat = (context.category || 'missing_citation').trim().toLowerCase()
  const keywords = extractSanitizedBoundaryKeywords([context.sentence ?? '', rebuttalText, context.reason ?? ''], 5)
  const kwSuffix = keywords.length > 0 ? `:kw=${keywords.join(',')}` : ''
  const tag = `[narrow:review_boundary:custom_clinical_boundary:cat=${resolvedCat}${kwSuffix}]`

  const candidate = `[domain:manuscript] ${tag} 审稿核查边界收窄：当方法或结果段陈述本研究自身入组队列、基线统计或专科设计（${sanitizedRebuttal || '不含外部研究对比词'}）时，属于合理专科研究边界，免于触发缺文献引用或教条误报。`

  // 通过实例解耦守卫二次校验，若仍含实例数字泄露则回退为安全抽象规则
  const adapter = getDomainSkillAdapter('manuscript')
  if (adapter.hasInstanceLeakage(candidate)) {
    return {
      patternKey: 'self_cohort_boundary',
      rule: `[domain:manuscript] [narrow:review_boundary:self_cohort_boundary:cat=${resolvedCat}${kwSuffix}] 审稿核查边界收窄：当方法或结果段陈述本研究自身入组队列、基线统计或本中心随访协议数据（且不含外部研究对比词）时，属于自报数据边界，免于触发缺文献引用（missing_citation）告警。`,
    }
  }

  return {
    patternKey: 'custom_clinical_boundary',
    rule: candidate,
  }
}

/**
 * 在线大模型零模板专科边界规则蒸馏（Track A narrow LLM Distiller + 实例脱敏守卫）：
 * 从临床医生的自由文本反驳（允许含稿件具体样本量/P值/亚组数字）中提炼零数字、跨论文可复用的研究设计边界规则，
 * 并经 `hasInstanceLeakage` 与 `sensitiveReason` 双重守卫核验（首次含数字自动二次剥离/重试，确保实例数字泄漏率 = 0%）。
 */
export async function synthesizeSanitizedBoundaryRuleAsync(
  complete: Complete | null | undefined,
  rebuttalText: string,
  context: { sentence?: string; category?: string; reason?: string } = {},
): Promise<{
  patternKey: string
  rule: string
  usedLlm: boolean
  rawRebuttalHadDigits: boolean
  firstDraftLeaked: boolean
}> {
  const rawRebuttalHadDigits = /\d/.test(rebuttalText)
  if (!complete) {
    const syncRes = synthesizeSanitizedBoundaryRule(rebuttalText, context)
    return {
      ...syncRes,
      usedLlm: false,
      rawRebuttalHadDigits,
      firstDraftLeaked: false,
    }
  }

  const resolvedCat = (context.category || 'method_result_mismatch').trim().toLowerCase()
  const sys =
    '你是临床研究方法学与审稿记忆治理专家。作者对一条 AI 审稿意见提出了合理的方法学反驳（说明该现象属于合法的研究设计或统计报告边界，而非客观错误）。\n' +
    '请将该反驳提炼为一条可跨论文复用的通用审稿边界豁免规则，严格遵守以下铁律：\n' +
    '1. 绝对禁止出现任何阿拉伯数字、样本量、百分比、P值、置信区间、具体药物名、具体疾病名、具体手术术式名或机构名（严禁在括号举例中写出具体病种或术式，必须 100% 零实例泄漏）；\n' +
    '2. 绝不允许豁免客观算术错误、置信区间越界、表格加总错误、末位小数/四舍五入借口或未声明的统计检验混用；规则正文必须包含显式触发前提（仅当原文或表头/表注存在对应分析集分层、模型调整层级或双分布声明证据时豁免；同一分析集与同一指标的前后矛盾仍须报错）；\n' +
    '3. pattern_key 优先归并到规范方法学家族（如 rct_itt_completer_boundary / subcohort_denominator_stratification_boundary / crude_vs_adjusted_model_boundary / dual_distribution_summary_boundary / non_additive_multichoice_category_boundary / domain_abbreviation_homonym_boundary / meta_analysis_subset_citation_boundary，严禁使用 rounding_and_percentage 类四舍五入规则，若均不匹配再自定义简洁 snake_case）；keywords 仅输出具体方法学英文单词（勿用下划线长词或 cohort/trial/study 等泛词）；\n' +
    '4. 输出 JSON：{"pattern_key":"英文snake_case设计标签","keywords":["具体方法学英文词1","词2","词3"],"rule_body":"一句带显式原文证据触发前提的中文通用边界规则说明（不含任何数字与具体病种术式）"}。'
  const usr =
    `【原审稿意见类别】：${resolvedCat}\n` +
    `【原审稿意见理由】：${(context.reason ?? '').slice(0, 300)}\n` +
    `【涉及原句片段】：${(context.sentence ?? '').slice(0, 300)}\n` +
    `【临床作者反驳原文】：${rebuttalText.slice(0, 500)}`

  const ensureExplicitConditionGuard = (body: string): string => {
    if (!body) return body
    if (/(?:同一.*仍|未声明.*仍|仅当|仅限|显式声明|显式标明)/.test(body)) return body
    const trimmed = body.replace(/[。；;]+$/, '')
    return `${trimmed}（仅限原文或表注显式标明该分层、调整模型或报告口径的情形；同一人群与同一指标的前后数值矛盾仍须报错）。`
  }

  try {
    const raw = await complete(sys, usr)
    const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, '').trim())
    if (m) {
      const parsed = JSON.parse(m[0]) as { pattern_key?: string; keywords?: string[]; rule_body?: string }
      const rawKey = String(parsed.pattern_key || 'study_design_boundary')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 48) || 'study_design_boundary'
      const kws = Array.isArray(parsed.keywords)
        ? parsed.keywords
            .flatMap(k => String(k).trim().toLowerCase().split(/[\s_]+/))
            .map(k => k.replace(/[^a-z0-9-]/g, ''))
            .filter(k => k.length >= 3 && !/\d/.test(k))
            .slice(0, 5)
        : extractSanitizedBoundaryKeywords([rebuttalText, context.reason ?? ''], 4)
      const kwSuffix = kws.length > 0 ? `:kw=${kws.join(',')}` : ''
      const bodyRaw = ensureExplicitConditionGuard(String(parsed.rule_body ?? '').trim())
      const firstCandidate = `[domain:manuscript] [narrow:review_boundary:${rawKey}:cat=${resolvedCat}${kwSuffix}] 审稿核查边界收窄：${bodyRaw}`
      const firstDraftLeaked = hasInstanceLeakage(firstCandidate) || Boolean(sensitiveReason(firstCandidate))
      if (!firstDraftLeaked && bodyRaw.length >= 12) {
        return {
          patternKey: rawKey,
          rule: firstCandidate,
          usedLlm: true,
          rawRebuttalHadDigits,
          firstDraftLeaked: false,
        }
      }
      // 二次强脱敏剥离所有数字、具体病种/术式括号举例与敏感词元后再校验
      const scrubbedBody = ensureExplicitConditionGuard(
        scrubSpecialtyExampleLeakage(
          String(parsed.rule_body ?? '')
            .replace(/\b(?:n|N|HR|OR|RR|P|p)\s*[=<>≤≥:：]?\s*\d+(?:\.\d+)?%?/g, '')
            .replace(/\d+(?:\.\d+)?%?/g, '')
            .replace(/\s+/g, ' ')
            .trim(),
        ),
      )
      const secondCandidate = `[domain:manuscript] [narrow:review_boundary:${rawKey}:cat=${resolvedCat}${kwSuffix}] 审稿核查边界收窄：${scrubbedBody}`
      if (scrubbedBody.length >= 12 && !hasInstanceLeakage(secondCandidate) && !sensitiveReason(secondCandidate)) {
        return {
          patternKey: rawKey,
          rule: secondCandidate,
          usedLlm: true,
          rawRebuttalHadDigits,
          firstDraftLeaked: true,
        }
      }
    }
  } catch {
    /* 网络或解析异常时回退至确定性无泄漏合成器 */
  }

  const fallback = synthesizeSanitizedBoundaryRule(rebuttalText, context)
  return {
    ...fallback,
    usedLlm: false,
    rawRebuttalHadDigits,
    firstDraftLeaked: true,
  }
}

/**
 * 从开发集（dev）漏检复盘信号提炼零数字、可跨论文迁移的审稿核查清单技能（Track B Review Audit Checklist）：
 * 严禁包含任何特定论文的样本量、数值、药物名或疾病名，仅提炼通用核查动作，供后续测试集 Stage 3 LLM 审稿注入。
 */
export async function distillReviewAuditChecklistAsync(
  complete: Complete | null | undefined,
  missedPatternDescription: string,
  errorCategory: string,
): Promise<{ skillKey: string; checklistRule: string } | null> {
  if (!complete) return null
  const sys =
    '你是医学期刊统计审稿方法学教练。审稿系统在一篇开发集稿件上漏检了一类客观数据/方法学不一致问题。\n' +
    '请将其抽象为一条面向未来未知稿件的「通用审稿核查动作清单（Audit Checklist）」，严格遵守：\n' +
    '1. 严禁出现任何阿拉伯数字、具体样本量、具体统计值、具体药物/疾病/器官名称（必须 100% 领域通用、零实例泄漏）；\n' +
    '2. 只描述通用的跨章节或表文比对动作（45字以内中文）；\n' +
    '3. 输出 JSON：{"skill_key":"英文snake_case核查键","checklist_action":"一句不含任何数字的中文通用核查动作"}。'
  const usr = `【漏检问题类别】：${errorCategory}\n【漏检机制简述】：${missedPatternDescription.slice(0, 400)}`
  try {
    const raw = await complete(sys, usr)
    const m = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, '').trim())
    if (!m) return null
    const parsed = JSON.parse(m[0]) as { skill_key?: string; checklist_action?: string }
    const skillKey = String(parsed.skill_key || 'cross_section_audit')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 40) || 'cross_section_audit'
    const actionBody = scrubSpecialtyExampleLeakage(
      String(parsed.checklist_action ?? '')
        .replace(/\d+(?:\.\d+)?%?/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    if (actionBody.length < 10) return null
    const checklistRule = `[domain:manuscript] [skill:review_audit:${skillKey}] 审稿重点核查清单：${actionBody}`
    if (hasInstanceLeakage(checklistRule) || sensitiveReason(checklistRule)) return null
    return { skillKey, checklistRule }
  } catch {
    return null
  }
}

const SELECTIVE_ROUTING_STOPWORDS = new Set([
  'cohort', 'cohorts', 'trial', 'trials', 'study', 'studies', 'population', 'populations',
  'group', 'groups', 'table', 'tables', 'analysis', 'analyses', 'method', 'methods',
  'result', 'results', 'patient', 'patients', 'participant', 'participants', 'subject', 'subjects',
  'data', 'value', 'values', 'number', 'numbers', 'rate', 'rates', 'level', 'levels',
  'reported', 'included', 'clinical', 'statistical', 'consistency', 'internal', 'boundary',
  'difference', 'summary', 'variable', 'variables', 'characteristic', 'characteristics',
  'section', 'sections', 'outcome', 'outcomes', 'set', 'sets', 'narrative', 'reading',
  'convention', 'reporting', 'reproducibility', 'framework', 'presentation', 'description',
])

export function isArithmeticRoundingBoundaryRule(ruleText: string): boolean {
  const lower = ruleText.toLowerCase()
  if (lower.includes('rounding_and_percentage')) return true
  if (/(?:rounding|decimal|四舍五入|末位舍入|末位小数)/i.test(lower) && !/(?:互补|complement)/i.test(lower)) {
    return true
  }
  return false
}

function isProtectedHardStage3Candidate(c: {
  category: string
  subtype?: string
  sentence: string
  reason: string
  evidence?: string[]
}): boolean {
  if (isHardObjectiveReviewFinding(c)) return true
  const blob = `${c.sentence} ${(c.evidence ?? []).join(' ')} ${c.reason}`.toLowerCase()
  if (
    /(?:点估计.*(?:落在|超出|不在|位于).*(?:区间|ci|iqr)|置信区间.*(?:越界|不包含|下界.*大于.*上界)|outside\s+(?:its|the)\s+95%\s*ci|lower\s+bound\s*>\s*upper)/i.test(
      blob,
    )
  ) {
    return true
  }
  if (/(?:百分比计算错误|算术计算错误|算术不符|除以.*应为)/i.test(blob)) {
    return true
  }
  return false
}

function matchesCanonicalMethodologicalCue(ruleLower: string, candBlob: string): boolean {
  if (ruleLower.includes('crude_vs_adjusted')) {
    return /(?:adjusted|unadjusted|crude|multivariable|univariable|ancova|weighted|age-standardized|omnibus|bonferroni|pairwise|校正|未校正|粗模型|粗比值比|多因素|标化|加权|两两比较)/i.test(
      candBlob,
    )
  }
  if (ruleLower.includes('dual_distribution')) {
    return /(?:median|iqr|interquartile|nonparametric|non-parametric|normality|shapiro|mann-whitney|wilcoxon|kruskal|中位数|四分位|非参数|正态)/i.test(
      candBlob,
    )
  }
  if (ruleLower.includes('subcohort_denominator') || ruleLower.includes('retrospective_cohort') || ruleLower.includes('cross_sectional') || ruleLower.includes('diagnostic_specimen') || ruleLower.includes('meta_analysis')) {
    return /(?:subcohort|subgroup|missing|attrition|completers?|per-protocol|\bitt\b|propensity|matched|subset|evaluable|reference\s+standard|亚组|子队列|子集|缺失|脱落|不同分母|分层分母|可评估)/i.test(
      candBlob,
    )
  }
  if (ruleLower.includes('rct_itt') || ruleLower.includes('multi_cohort')) {
    return /(?:intention-to-treat|\bitt\b|per-protocol|completers?|lost\s+to\s+follow-up|consort|randomiz|意向性|符合方案|完成随访|脱落)/i.test(
      candBlob,
    )
  }
  if (ruleLower.includes('target_trial_emulation')) {
    return /(?:target\s+trial|\btte\b|clone|ccw|immortal\s+time|克隆|不死时间|伪队列)/i.test(candBlob)
  }
  if (ruleLower.includes('single_arm')) {
    return /(?:single[\s-]arm|historical\s+control|单臂|历史对照)/i.test(candBlob)
  }
  if (ruleLower.includes('domain_abbreviation')) {
    return /(?:abbreviation|synonym|homonym|terminology|缩写|简称|同义|异名|标签)/i.test(candBlob)
  }
  if (ruleLower.includes('translational_animal')) {
    return /(?:xenograft|\bmice\b|\btma\b|in\s+vitro|动物|小鼠|体外|组织芯片)/i.test(candBlob)
  }
  return false
}

/**
 * Stage 4 候选级选择性记忆路由（Candidate-Scoped Selective Memory Routing）：
 * 仅对非客观算术/区间硬伤（通过 F_hard 防火墙）且类别与方法学关键词匹配的特定候选审稿意见挂载适用边界规则，
 * 消除全局 System Prompt 无差别注入导致的跨论文过度保守与召回率坍塌。
 */
export function selectCandidateScopedBoundaryRules(
  candidate: {
    category: string
    subtype?: string
    sentence: string
    reason: string
    evidence?: string[]
  },
  activeRules: string[],
): string[] {
  if (!activeRules.length || isProtectedHardStage3Candidate(candidate)) return []
  const candBlob = `${candidate.sentence} ${(candidate.evidence ?? []).join(' ')} ${candidate.reason}`.toLowerCase()
  const scored: Array<{ score: number; cleanText: string }> = []

  for (const rawRule of activeRules) {
    if (isArithmeticRoundingBoundaryRule(rawRule)) continue
    const sanitizedRule = scrubSpecialtyExampleLeakage(rawRule)
    const rLower = sanitizedRule.toLowerCase()
    if (!rLower.includes('[narrow:review_boundary')) continue

    const catMatch = /:cat=([a-z0-9_]+)/i.exec(rLower)
    if (catMatch?.[1] && catMatch[1].toLowerCase() !== candidate.category.toLowerCase()) {
      continue
    }

    const kwMatch = /:kw=([^\]\s]+)/i.exec(rLower)
    const familyCue = matchesCanonicalMethodologicalCue(rLower, candBlob)
    let matchedScore = 0

    if (kwMatch?.[1]) {
      const specificTokens = new Set<string>()
      for (const rk of kwMatch[1].split(',')) {
        const cleanKw = rk.trim().toLowerCase()
        if (cleanKw.length >= 3 && !cleanKw.includes('_') && !SELECTIVE_ROUTING_STOPWORDS.has(cleanKw)) {
          specificTokens.add(cleanKw)
        }
        for (const sub of cleanKw.split('_')) {
          if (sub.length >= 3 && !SELECTIVE_ROUTING_STOPWORDS.has(sub)) {
            specificTokens.add(sub)
          }
        }
      }
      const hits = [...specificTokens].filter(k => candBlob.includes(k)).length
      if (hits >= 2 || (hits >= 1 && familyCue)) {
        matchedScore = hits * 2 + (familyCue ? 1 : 0)
      }
    } else if (familyCue) {
      matchedScore = 2
    }

    if (matchedScore > 0) {
      const cleanText = sanitizedRule
        .replace(/\[[^\]]+\]\s*/g, '')
        .replace(/^审稿核查边界收窄[：:]\s*/, '')
        .trim()
      if (cleanText) scored.push({ score: matchedScore, cleanText })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map(s => s.cleanText)
}

export class ClaimService {
  constructor(
    private readonly docs: Documents,
    private readonly pubmed: PubMedClient,
    private readonly fulltext: FullTextClient | null = null,
  ) {}

  private getActiveBoundaryRules(owner?: string): string[] {
    const store = this.docs.store as any
    if (typeof store?.listMemories !== 'function') return []
    const resolvedOwner = owner ?? 'local'
    try {
      const mems = store.listMemories(resolvedOwner, ['active']) as Array<{ content: string; status?: string }>
      return (mems ?? [])
        .filter(m => !m.status || m.status === 'active')
        .map(m => m.content)
        .filter(c => c.includes('[narrow:review_boundary'))
    } catch {
      return []
    }
  }

  private getActiveReviewAuditChecklists(owner?: string): string[] {
    const store = this.docs.store as any
    if (typeof store?.listMemories !== 'function') return []
    const resolvedOwner = owner ?? 'local'
    try {
      const mems = store.listMemories(resolvedOwner, ['active']) as Array<{ content: string; status?: string }>
      return (mems ?? [])
        .filter(m => !m.status || m.status === 'active')
        .map(m => m.content)
        .filter(c => c.includes('[skill:review_audit:'))
    } catch {
      return []
    }
  }

  private extract(docId: string, activeRules: string[] = []): {
    claims: Claim[]
    unsourced: Claim[]
    tables: TableSummary[]
    scratchpad: ManuscriptScratchpad
  } {
    const doc = this.docs.get(docId)
    const store = this.docs.store as any
    const rawMeasures = typeof store?.listMeasurements === 'function' ? store.listMeasurements(docId) : []
    const measures = new Map<string, string>((rawMeasures as any[]).map((m: any) => [String(m.id), snapshotText(m)]))
    const rawCitations = typeof store?.listCitations === 'function' ? store.listCitations(docId) : []
    const { claims, unsourced: rawUnsourced } = extractClaims(
      doc,
      referencePlan(doc, rawCitations).numbers,
      measures,
    )
    const tables = extractTableSummaries(doc)
    const scratchpad = buildManuscriptScratchpad(doc, tables)
    const unsourced = rawUnsourced.filter(
      u =>
        !isExemptedByActiveRules(
          {
            category: 'missing_citation',
            reason: '数值型论断缺少出处',
            sentence: u.sentence,
            section_role: u.section_role,
          },
          activeRules,
        ),
    )
    return { claims, unsourced, tables, scratchpad }
  }

  private async abstractFor(doi: string, pmid: string | null): Promise<string | null> {
    const cached = this.docs.store.getAbstract(doi)
    if (cached) return cached.abstract
    let id = pmid
    let abstract: string | null = null
    try {
      id ??= await this.pubmed.pmidForDoi(doi)
      abstract = id ? await this.pubmed.abstract(id) : null
    } catch {
      return null // 网络问题不缓存，下次再取
    }
    this.docs.store.putAbstract(doi, id, abstract)
    return abstract
  }

  /** 一页待核对的论断（带证据）+ 缺出处的数值句 + 文档表格数值摘要 + 四阶段深审问题（首页）。 */
  async evidence(docId: string, cursor = 0): Promise<{
    rev: number
    claims: ClaimEvidence[]
    unsourced: Array<{
      claim_id: string
      node_id: string
      sentence: string
      section_title?: string
      section_role?: SectionRole
      verification_tier?: VerificationTier
    }>
    tables?: TableSummary[]
    audit_issues?: DeepReviewAuditIssue[]
    scratchpad?: ManuscriptScratchpad
    total: number
    next_cursor: number | null
  }> {
    const store = this.docs.store as any
    const owner = typeof store?.getDoc === 'function' ? store.getDoc(docId)?.owner : undefined
    const activeRules = this.getActiveBoundaryRules(owner)
    const { claims, unsourced, tables, scratchpad } = this.extract(docId, activeRules)
    const cites = new Map<string, CitationRow>(
      ((typeof store?.listCitations === 'function' ? store.listCitations(docId) : []) as CitationRow[]).map(c => [c.id, c]),
    )
    const numbers = referencePlan(this.docs.get(docId), [...cites.values()]).numbers
    const page = claims.slice(cursor, cursor + PAGE)
    const out: ClaimEvidence[] = []
    for (const c of page) {
      const citations = []
      for (const id of c.cite_ids) {
        const row = cites.get(id)
        if (!row) continue
        const abstract = await this.abstractFor(row.doi, row.pmid)
        const full = this.fulltext ? await this.fulltext.get(row.doi).catch(() => null) : null
        const passages = full ? relevantPassages(full.text, c.sentence) : []
        citations.push({
          cite_id: id,
          number: numbers.get(id) ?? null,
          reference: row.formatted,
          abstract: abstract ? fitAbstract(abstract) : null,
          ...(passages.length ? { fulltext: { source: full!.source === 'pmc' ? 'PMC 开放获取全文' : '开放获取全文（Unpaywall）', passages } } : {}),
        })
      }
      const last = typeof store?.getClaimCheck === 'function' ? store.getClaimCheck(docId, c.claim_id)?.verdict : undefined
      const noAbstract = citations.every(x => !x.abstract && !x.fulltext)
      out.push({
        claim_id: c.claim_id,
        node_id: c.node_id,
        sentence: c.sentence,
        ...(c.section_title ? { section_title: c.section_title } : {}),
        ...(c.section_role ? { section_role: c.section_role } : {}),
        ...(c.verification_tier ? { verification_tier: c.verification_tier } : {}),
        citations,
        ...(noAbstract ? { no_abstract: true as const } : {}),
        ...(last ? { last_verdict: last } : {}),
      })
    }
    const next = cursor + PAGE < claims.length ? cursor + PAGE : null
    const auditIssues = cursor === 0 ? this.auditDeepReviewPasses(docId, { owner }) : undefined
    return {
      rev: this.docs.rev(docId),
      claims: out,
      unsourced: cursor === 0
        ? unsourced.map(u => ({
            claim_id: u.claim_id,
            node_id: u.node_id,
            sentence: u.sentence,
            ...(u.section_title ? { section_title: u.section_title } : {}),
            ...(u.section_role ? { section_role: u.section_role } : {}),
            ...(u.verification_tier ? { verification_tier: u.verification_tier } : {}),
          }))
        : [],
      ...(cursor === 0 && tables.length > 0 ? { tables } : {}),
      ...(cursor === 0 && auditIssues && auditIssues.length > 0 ? { audit_issues: auditIssues } : {}),
      ...(cursor === 0 ? { scratchpad } : {}),
      total: claims.length,
      next_cursor: next,
    }
  }

  /**
   * 记录核对结果；不支持 / 无法判断 / 缺出处 → 在该句挂 AI 评论（同一句同一结论不重复挂）。
   */
  report(
    docId: string,
    results: Array<{
      claim_id: string
      verdict: ClaimVerdict
      reason: string
      no_evidence?: boolean
      evidence_tier?: EvidenceTier
      evidence_quote?: string
    }>,
  ): Array<{ claim_id: string; status: 'recorded' | 'commented' | 'unchanged' | 'stale' | 'no_evidence'; comment_id?: string }> {
    const store = this.docs.store
    const { claims, unsourced } = this.extract(docId)
    const byId = new Map([...claims, ...unsourced].map(c => [c.claim_id, c]))
    const cites = new Map(store.listCitations(docId).map(c => [c.id, c]))
    const hasAbstract = (claim: Claim) =>
      claim.cite_ids.some(id => {
        const row = cites.get(id)
        return !!(row && (store.getAbstract(row.doi)?.abstract || store.getFullText(row.doi)?.text))
      })
    const out: Array<{ claim_id: string; status: 'recorded' | 'commented' | 'unchanged' | 'stale' | 'no_evidence'; comment_id?: string }> = []
    let doc = this.docs.get(docId)
    const commentOps: Array<{ op: 'claim_comment'; thread: string }> = []
    const pendingChecks: Array<() => void> = []
    for (const r of results) {
      const claim = byId.get(r.claim_id)
      if (!claim) {
        out.push({ claim_id: r.claim_id, status: 'stale' })
        continue
      }
      const prev = store.getClaimCheck(docId, r.claim_id)
      if (prev && prev.verdict === 'exempted' && r.verdict !== 'supported') {
        out.push({ claim_id: r.claim_id, status: 'unchanged' })
        continue
      }
      const selfReported =
        r.verdict === 'missing_citation' &&
        /(?:本研究|自报|自身队列|本队列|基线数据|表格单元格|无需引用|不需引用|不应挂.*引用|无需改动)/.test(r.reason)
      const effectiveVerdict: ClaimVerdict = selfReported ? 'supported' : r.verdict
      const { tier: effectiveTier, quote: effectiveQuote } = this.resolveEvidence(claim, cites, r.evidence_tier, r.evidence_quote)
      const needsHighRiskAbstractNotice =
        effectiveVerdict === 'supported' &&
        !selfReported &&
        effectiveTier === 'abstract' &&
        claim.verification_tier === 'high' &&
        claim.cite_ids.length > 0
      if (
        prev &&
        prev.verdict === effectiveVerdict &&
        prev.evidence_tier === effectiveTier &&
        (effectiveVerdict === 'supported' ? !needsHighRiskAbstractNotice || Boolean(prev.comment_id) : Boolean(prev.comment_id))
      ) {
        out.push({ claim_id: r.claim_id, status: 'unchanged', ...(prev.comment_id ? { comment_id: prev.comment_id } : {}) })
        continue
      }
      const noEvidence = effectiveVerdict === 'unclear' && (r.no_evidence === true || !hasAbstract(claim))
      let commentId: string | null = null
      if ((effectiveVerdict !== 'supported' && effectiveVerdict !== 'exempted' && !noEvidence) || needsHighRiskAbstractNotice) {
        const res = this.prepareComment(docId, doc, claim, effectiveVerdict, r.reason, effectiveTier, effectiveQuote)
        doc = res.doc
        commentId = res.commentId
        if (res.anchored) commentOps.push({ op: 'claim_comment', thread: res.commentId })
      }
      const cId = commentId
      pendingChecks.push(() => {
        store.putClaimCheck({
          doc_id: docId,
          claim_id: r.claim_id,
          node_id: claim.node_id,
          sentence: claim.sentence,
          verdict: effectiveVerdict,
          evidence_tier: effectiveTier,
          evidence_quote: effectiveQuote,
          reason: noEvidence ? `（没有可核对的证据）${r.reason}` : r.reason,
          comment_id: cId,
          rev: this.docs.rev(docId),
        })
      })
      out.push({
        claim_id: r.claim_id,
        status: noEvidence ? 'no_evidence' : commentId ? 'commented' : 'recorded',
        ...(commentId ? { comment_id: commentId } : {}),
      })
    }
    if (commentOps.length > 0) {
      this.docs.commit(docId, doc, { actor: 'system', turnId: null, ops: commentOps })
    }
    for (const put of pendingChecks) put()
    return out
  }

  private resolveEvidence(
    claim: Claim,
    cites: Map<string, CitationRow>,
    explicitTier?: EvidenceTier,
    explicitQuote?: string,
  ): { tier: EvidenceTier; quote: string } {
    const store = this.docs.store
    const fullPassages: string[] = []
    const abstracts: string[] = []
    for (const id of claim.cite_ids) {
      const row = cites.get(id)
      if (!row) continue
      const ft = store.getFullText(row.doi)?.text
      if (ft && ft.trim().length > 0) {
        const rel = relevantPassages(ft, claim.sentence)
        if (rel.length > 0) {
          fullPassages.push(...rel)
        } else {
          const blocks = ft.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
          if (blocks.length > 0) {
            const best = this.pickBestText(blocks, claim.sentence)
            if (best) fullPassages.push(best)
          }
        }
      }
      const abs = store.getAbstract(row.doi)?.abstract
      if (abs && abs.trim().length > 0) {
        abstracts.push(abs.trim())
      }
    }

    const isTablePassage = (p: string) => /\|.*\|/.test(p) || /\[(?:表格|Table)\b/i.test(p) || /\bTable\s+\d+/i.test(p)
    let tier: EvidenceTier
    if (explicitTier) {
      tier = explicitTier
    } else if (fullPassages.length > 0) {
      tier = fullPassages.some(isTablePassage) ? 'table' : 'fulltext'
    } else if (abstracts.length > 0) {
      tier = 'abstract'
    } else {
      tier = 'none'
    }

    if (explicitQuote && explicitQuote.trim().length > 0) {
      return { tier, quote: explicitQuote.trim().slice(0, 600) }
    }

    if (fullPassages.length > 0 && (tier === 'table' || tier === 'fulltext')) {
      const targetPassages =
        tier === 'table' && fullPassages.some(isTablePassage) ? fullPassages.filter(isTablePassage) : fullPassages
      const bestPassage = this.pickBestText(targetPassages, claim.sentence) ?? targetPassages[0]!
      const lines = bestPassage.split('\n').map(l => l.trim()).filter(Boolean)
      const tableLines = lines.filter(l => l.includes('|') && !/^\|\s*[-:]+(?:\s*\|\s*[-:]+)*\s*\|?$/.test(l))
      if (tableLines.length >= 2) {
        const captionLine = lines.find(l => /^\[(?:表格|Table)/i.test(l))
        const header = tableLines[0]!
        const dataRows = tableLines.slice(1)
        const bestRow = this.pickBestText(dataRows, claim.sentence) ?? dataRows[0]!
        const assembled = [captionLine, header, bestRow].filter(Boolean).join('\n')
        return { tier, quote: assembled.slice(0, 350) }
      }
      return { tier, quote: this.extractBestSentences(bestPassage, claim.sentence, 350) }
    }

    if (abstracts.length > 0) {
      const combined = abstracts.join('\n')
      return { tier, quote: this.extractBestSentences(combined, claim.sentence, 350, true) }
    }

    return { tier, quote: '' }
  }

  private scoreOverlap(candidate: string, claimSentence: string, inResultsSection = false): number {
    const rawNums = claimSentence.replace(/(\d)·(\d)/g, '$1.$2').match(/\d+(?:\.\d+)?%?/g) ?? []
    const claimNums = new Set<string>()
    for (const raw of rawNums) {
      const clean = raw.replace(/%$/, '')
      if (/^(19|20)\d\d$/.test(clean)) continue
      claimNums.add(clean)
      const val = Number(clean)
      if (!Number.isNaN(val)) {
        if (raw.endsWith('%')) {
          claimNums.add((val / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))
        } else if (val > 0 && val < 1 && clean.startsWith('0.')) {
          claimNums.add(String(Math.round(val * 1000) / 10))
        }
      }
    }
    const claimWords = new Set((claimSentence.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).map(w => w.slice(0, 6)))
    const claimCjk = new Set<string>()
    for (const m of claimSentence.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
      for (let i = 0; i + 2 <= m.length; i++) claimCjk.add(m.slice(i, i + 2))
    }

    let score = 0
    const candNorm = candidate.replace(/(\d)·(\d)/g, '$1.$2')
    const candNums = new Set(candNorm.match(/\d+(?:\.\d+)?/g) ?? [])
    for (const n of claimNums) {
      if (candNums.has(n) || candNorm.includes(n)) score += 5
    }
    const candLower = candidate.toLowerCase()
    for (const w of claimWords) {
      if (candLower.includes(w)) score += 2
    }
    for (const bg of claimCjk) {
      if (candidate.includes(bg)) score += 1
    }
    if (inResultsSection || /\b(RESULTS?|FINDINGS|CONCLUSIONS?|结果|结论)\b/i.test(candidate)) {
      score += 2
    }
    return score
  }

  private pickBestText(candidates: string[], claimSentence: string): string | undefined {
    if (candidates.length === 0) return undefined
    let best = candidates[0]!
    let bestScore = -1
    for (const c of candidates) {
      const s = this.scoreOverlap(c, claimSentence)
      if (s > bestScore) {
        bestScore = s
        best = c
      }
    }
    return best
  }

  private extractBestSentences(source: string, claimSentence: string, maxChars = 350, isAbstract = false): string {
    const sentences = source
      .split(/(?<=[.!?])\s+(?=[A-Z\u4e00-\u9fff\[])|(?<=[。！？；])\s*|\n+/)
      .map(s => s.trim())
      .filter(Boolean)
    if (sentences.length === 0) return source.trim().slice(0, maxChars)

    let inKeySection = false
    const scored = sentences.map((s, idx) => {
      if (isAbstract) {
        if (/\b(RESULTS?|FINDINGS|CONCLUSIONS?|结果|结论)\b\s*[:：]/i.test(s)) inKeySection = true
        else if (/\b(BACKGROUND|METHODS?|OBJECTIVES?|INTRODUCTION|背景|方法)\b\s*[:：]/i.test(s)) inKeySection = false
      }
      return { s, idx, score: this.scoreOverlap(s, claimSentence, isAbstract && inKeySection) }
    })

    scored.sort((a, b) => b.score - a.score || a.idx - b.idx)
    const first = scored[0]!
    const picked = [first]
    const second = scored[1]
    if (second && second.score >= 4 && first.s.length + 1 + second.s.length <= maxChars) {
      picked.push(second)
      picked.sort((a, b) => a.idx - b.idx)
    }
    return picked.map(p => p.s).join(' ').slice(0, maxChars)
  }

  private prepareComment(
    docId: string,
    doc: PMNode,
    claim: Claim,
    verdict: ClaimVerdict,
    reason: string,
    evidenceTier: EvidenceTier = 'none',
    evidenceQuote = '',
  ): { commentId: string; doc: PMNode; anchored: boolean } {
    const store = this.docs.store
    const label = {
      unsupported: '所引文献不支持该论断',
      unclear: '无法从所引文献判断',
      missing_citation: '数值型论断缺少出处',
      supported: '高风险定量/亚组论断仅由摘要支持（缺少全文或数据表佐证，建议核对原文全文）',
      exempted: '',
    }[verdict]
    const resolved = this.resolveTargetNodeAndSnippet(doc, claim.node_id, claim.snippet, claim.sentence)
    const row = store.addComment({ doc_id: docId, node_id: resolved.nodeId, snippet: resolved.snippet })
    let nextDoc = doc
    let anchored = false
    try {
      nextDoc = attachComment(doc, resolved.nodeId, resolved.anchorSnippet, row.id).doc
      anchored = true
    } catch (err) {
      if (!(err instanceof AnchorError)) throw err
      // 找不到段落内精确连续文字（如跨行内引用原子或表格块）：退化为整块 comment mark 锚点
      try {
        nextDoc = attachComment(doc, resolved.nodeId, '', row.id).doc
        anchored = true
      } catch {
        store.db.prepare("UPDATE comments SET snippet = '' WHERE id = ?").run(row.id)
      }
    }
    const quoteBlock = evidenceQuote
      ? `\n${evidenceTier === 'table' || evidenceTier === 'fulltext' ? '【匹配全文/表格原文】' : '【匹配摘要原文】'}：${evidenceQuote}`
      : ''
    store.addReply(row.id, 'ai', `论断核对：${label}。${reason}${quoteBlock}\n句子：${claim.sentence}`)
    return { commentId: row.id, doc: nextDoc, anchored }
  }

  /**
   * 批注锚点只取完整句子，避免把“半句话”挂到正文上：
   * - sentence 本身就是完整原句时原样返回；
   * - 结构化核查传入整段时，按 snippet 定位到所在句子；
   * - 超长且没有句末标点时，按逗号回退，尽量不截断在词中间。
   */
  /**
   * 表格意见要落的单元格段落：给了 [网格行, 列] 时取那一格（合并单元格取起始格）；否则在表内找唯一包含该文字的单元格。
   * anchor 是格内要标的文字（格里找得到 snippet 时只标它，否则标整格）。找不到时返回 null（退回整张表）。
   */
  private cellTarget(table: PMNode, snippet: string, cell?: [number, number]): { nodeId: string; anchor: string } | null {
    const grid = readGrid(table)
    const paraOf = (n: PMNode): PMNode | null => {
      let para: PMNode | null = null
      n.descendants(d => { if (!para && d.isTextblock && d.attrs.id && d.textContent.trim()) para = d; return !para })
      return para
    }
    const pick = (n: PMNode | null): { nodeId: string; anchor: string } | null => {
      if (!n) return null
      const text = n.textContent
      return { nodeId: n.attrs.id as string, anchor: snippet && text.includes(snippet) ? snippet : '' }
    }
    if (cell) {
      const c = grid.at(cell[0], cell[1])
      const hit = c ? pick(paraOf(c.node)) : null
      if (hit) return hit
    }
    if (!snippet) return null
    const found = grid.cells.map(c => paraOf(c.node)).filter((p): p is PMNode => !!p && p.textContent.includes(snippet))
    return found.length === 1 ? pick(found[0]!) : null
  }

  private sentenceForAnchor(text: string, probe: string, maxChars = 300): string {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return probe.trim()
    if (clean.length <= maxChars) return clean
    const needle = probe.replace(/\s+/g, ' ').trim().slice(0, 32)
    const at = needle ? clean.indexOf(needle) : -1
    let start = at >= 0 ? at : 0
    while (start > 0 && !/[。！？；!?;]/.test(clean[start - 1]!)) start--
    let end = at >= 0 ? at + Math.max(needle.length, 1) : Math.min(clean.length, maxChars)
    while (end < clean.length && !/[。！？；!?;]/.test(clean[end]!)) end++
    if (end < clean.length) end++
    let out = clean.slice(start, end).trim()
    if (out.length > maxChars) {
      const comma = out.lastIndexOf('，', maxChars)
      out = out.slice(0, comma > maxChars * 0.6 ? comma + 1 : maxChars).trim()
    }
    return out || clean.slice(0, maxChars)
  }

  /**
   * 为审稿/核查批注解析最匹配的文档块 ID 与可锚定片段：
   * - 当 LLM Stage 3 给出的 node_id 缺失、为章节标题或文字落在其他段落/表格时，自动按文本重叠度回溯真实块；
   * - 当句子中间夹有引用原子 [@c:...] / 测量原子 [@m:...] 时，自动提取段落内最长连续子串用于精确打标。
   */
  private resolveTargetNodeAndSnippet(
    doc: PMNode,
    rawNodeId: string,
    rawSnippet: string,
    sentence: string,
    cell?: [number, number],
  ): { nodeId: string; snippet: string; anchorSnippet: string } {
    const byId = indexById(doc)
    const cleanSentence = sentence.replace(/\[@[cm]:[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim()
    const displaySnippet = this.sentenceForAnchor(cleanSentence || rawSnippet, rawSnippet || cleanSentence)

    let targetId = rawNodeId
    const initialHit = byId.get(targetId)
    const probe = rawSnippet.replace(/^\[表格\]\s*/, '').trim().slice(0, 32) || cleanSentence.slice(0, 32)

    const blockContainsProbe = (node: PMNode): boolean => {
      if (!probe) return true
      const txt = node.textContent
      if (txt.includes(probe)) return true
      const clauses = ( cleanSentence || rawSnippet )
        .split(/[，。；、,;：:\s[\]()（）]+/)
        .map(s => s.trim())
        .filter(s => s.length >= 5)
      return clauses.some(c => txt.includes(c))
    }

    // 表格与图（问题出在图注里）按整块定位，不去别的段落里找相似文字
    const wholeBlock = (n: PMNode) => n.type.name === 'table' || n.type.name === 'figure'
    if (!initialHit || (!wholeBlock(initialHit.node) && !blockContainsProbe(initialHit.node))) {
      let bestId = initialHit ? targetId : ''
      let bestScore = initialHit ? this.scoreOverlap(initialHit.node.textContent, cleanSentence || rawSnippet) : -1
      doc.descendants(node => {
        const id = node.attrs?.id as string | undefined
        if (!id) return true
        if (!node.isTextblock && node.type.name !== 'table') return true
        const txt = node.textContent
        if (!txt.trim()) return false
        let s = this.scoreOverlap(txt, cleanSentence || rawSnippet)
        if (probe && txt.includes(probe)) s += 25
        if (node.type.name === 'paragraph' || node.type.name === 'table') s += 1
        if (s > bestScore) {
          bestScore = s
          bestId = id
        }
        return node.type.name !== 'table'
      })
      if (bestId) targetId = bestId
    }

    const finalHit = byId.get(targetId)
    if (!finalHit) {
      return { nodeId: targetId, snippet: displaySnippet, anchorSnippet: displaySnippet }
    }

    if (finalHit.node.type.name === 'table') {
      // 表格意见落到单元格：给了行列用那一格；否则按单元格文字在表内唯一匹配。转换稿与原版都只标那一格
      const inCell = this.cellTarget(finalHit.node, rawSnippet.replace(/^\[表格\]\s*/, '').trim(), cell)
      if (inCell) return { nodeId: inCell.nodeId, snippet: inCell.anchor || displaySnippet, anchorSnippet: inCell.anchor }
    }

    if (!finalHit.node.isTextblock) {
      // 表格、列表、图片等复合块：使用空 anchorSnippet 打整块 comment mark，同时保留可读 snippet
      return { nodeId: targetId, snippet: displaySnippet, anchorSnippet: '' }
    }

    const blockText = finalHit.node.textContent
    if (displaySnippet && blockText.includes(displaySnippet)) {
      return { nodeId: targetId, snippet: displaySnippet, anchorSnippet: displaySnippet }
    }

    // 从句子或 snippet 中提取在该段落中唯一出现的最长连续子串（避开 [@c:...] 行内原子断点）
    const segments = [rawSnippet, cleanSentence]
      .flatMap(s => s.split(/\[@[cm]:[^\]]+\]|[\r\n]+|[，。；：,;（）()[\]]+/))
      .map(s => s.trim())
      .filter(s => s.length >= 4)
      .sort((a, b) => b.length - a.length)

    for (const seg of segments) {
      const sub = this.sentenceForAnchor(seg, seg)
      if (blockText.includes(sub)) {
        return { nodeId: targetId, snippet: displaySnippet || sub, anchorSnippet: sub }
      }
    }

    return { nodeId: targetId, snippet: displaySnippet, anchorSnippet: '' }
  }

  /**
   * 静态/记忆感知的四阶段深度审稿专项巡检（Stage 3 Pass B 内部表文自洽 + Pass C 方法-结果配对 + Pass D Spin Bias 与规范）：
   * 可独立调用或与 verify_claims / runFourStageDeepReview 联合执行。
   */
  auditDeepReviewPasses(
    docId: string,
    opts: { includeInternal?: boolean; useMemory?: boolean; owner?: string } = {},
  ): DeepReviewAuditIssue[] {
    const doc = this.docs.get(docId)
    const tables = extractTableSummaries(doc)
    const activeRules = opts.useMemory !== false ? this.getActiveBoundaryRules(opts.owner) : []
    const includeInternal = opts.includeInternal !== false
    return [
      ...(includeInternal ? auditInternalConsistency(doc, tables, activeRules) : []),
      ...auditMethodResultConsistency(doc, tables, activeRules),
      ...auditSpinAndGuidelines(doc, activeRules),
    ]
  }

  private getDocExemptedReviewChecks(docId: string): Array<{
    claim_id: string
    sentence: string
    evidence_quote: string
    reason: string
  }> {
    const store = this.docs.store as any
    if (typeof store?.listClaimChecks !== 'function') return []
    try {
      const checks = (store.listClaimChecks(docId) ?? []) as Array<any>
      return checks
        .filter(c => c && c.verdict === 'exempted' && String(c.claim_id ?? '').startsWith('rev_exempt_'))
        .map(c => ({
          claim_id: String(c.claim_id),
          sentence: String(c.sentence ?? ''),
          evidence_quote: String(c.evidence_quote ?? ''),
          reason: String(c.reason ?? ''),
        }))
    } catch {
      return []
    }
  }

  private isMatchedByDocExemptedReview(
    item: SynthesizedReviewComment,
    exemptedList: Array<{ claim_id: string; sentence: string; evidence_quote: string; reason: string }>,
  ): boolean {
    if (!exemptedList.length) return false
    if (isHardObjectiveReviewFinding(item)) return false

    const itemNorm = normForMatch(item.sentence)
    const itemEvidenceNorms = (item.evidence ?? []).map(e => normForMatch(e)).filter(e => e.length >= 10)
    const itemNums = numberKey([item.sentence, ...(item.evidence ?? [])])
    const itemNumList = itemNums ? itemNums.split(',').filter(Boolean) : []
    const itemTokens = extractTopicTokensForDedup([item.sentence, ...(item.evidence ?? [])])

    for (const ex of exemptedList) {
      const exCat = /\[([a-z_]+)\]/.exec(ex.reason)?.[1]
      const exNorm = normForMatch(ex.sentence)
      const exEvNorm = normForMatch(ex.evidence_quote)

      if (
        itemNorm.length >= 10 &&
        exNorm.length >= 10 &&
        (itemNorm.includes(exNorm.slice(0, 48)) || exNorm.includes(itemNorm.slice(0, 48)))
      ) {
        return true
      }

      // 同稿二次复审中，若上一轮驳回的是 (A, B) 对照点，而第二轮调换为 (B, A) 报出，同样按同稿已澄清点幂等消音
      if ((!exCat || exCat === item.category) && itemNorm.length >= 12 && exEvNorm.length >= 12) {
        if (
          (exEvNorm.includes(itemNorm.slice(0, 36)) || itemNorm.includes(exEvNorm.slice(0, 36))) &&
          itemEvidenceNorms.some(ev => exNorm.includes(ev.slice(0, 32)) || ev.includes(exNorm.slice(0, 32)))
        ) {
          return true
        }
      }

      if ((!exCat || exCat === item.category) && itemNumList.length >= 2) {
        const exNums = numberKey([ex.sentence, ex.evidence_quote])
        const exNumList = exNums ? exNums.split(',').filter(Boolean) : []
        if (exNums === itemNums) {
          if (itemNumList.length >= 3) return true
          const exTokens = extractTopicTokensForDedup([ex.sentence, ex.evidence_quote])
          if (itemTokens.size > 0 && [...itemTokens].some(t => exTokens.has(t))) {
            return true
          }
        } else if (exNumList.length >= 2) {
          const exSet = new Set(exNumList)
          const sharedNums = itemNumList.filter(n => exSet.has(n))
          if (sharedNums.length >= 2 && sharedNums.length === Math.min(exNumList.length, itemNumList.length)) {
            const exTokens = extractTopicTokensForDedup([ex.sentence, ex.evidence_quote])
            if (itemTokens.size > 0 && [...itemTokens].some(t => exTokens.has(t))) {
              return true
            }
          }
        }
      }
    }
    return false
  }

  /**
   * Stage 4 全局合成 Judge（Global Synthesis, Deduplication, Severity Gating & {#c:id} Comment Anchoring）：
   * 对应 Google PAT (arXiv:2606.28277) Stage 4：
   * 1. 跨章节/多通道重复问题去重（Deduplication）；
   * 2. 严重度分级排序（critical -> major -> minor）；
   * 3. 若开启自进化记忆（useMemory），依据同稿已驳回记录与活跃 `[narrow:review_boundary]` 规则过滤假阳性；
   * 4. 可选将去重后的审稿意见直接挂载为文档内联批注 `{#c:id}`。
   */
  synthesizeStage4Review(
    docId: string,
    candidates: SynthesizedReviewComment[],
    opts: {
      deduplicate?: boolean
      useMemory?: boolean
      owner?: string
      anchorComments?: boolean
      verifiedByLlm?: boolean
    } = {},
  ): SynthesizedReviewComment[] {
    const activeRules = opts.useMemory ? this.getActiveBoundaryRules(opts.owner) : []
    const docExempted = opts.useMemory ? this.getDocExemptedReviewChecks(docId) : []
    const deduplicate = opts.deduplicate !== false

    const filtered = candidates.filter(c => {
      if (this.isMatchedByDocExemptedReview(c, docExempted)) return false
      // 已通过全文 VERIFY_SYSTEM 结合边界规则逐条核实为 holds 的模型意见，不再用单句表层关键词二次误删
      if (c.source_pass === 'llm_stage3' && opts.verifiedByLlm) return true
      return !isExemptedByActiveRules(c, activeRules)
    })
    const deduplicated: SynthesizedReviewComment[] = []
    const seenKeys = new Set<string>()

    for (const item of filtered) {
      if (deduplicate) {
        const normSentence = item.sentence.replace(/\s+/g, '').toLowerCase().slice(0, 60)
        const key = `${item.category}|${item.subtype ?? ''}|${item.node_id}|${normSentence}`
        if (seenKeys.has(key)) continue

        // 跨章节去重：同一处数字矛盾常被几个章节换着说法报出来（各章节都拿到了表格）——
        // 当仅含 2 个相同数字时，要求同时共享至少 1 个非停用词/非单位的主题词（避免不同变量碰巧含相同 2 个数字被误删）；
        // 当含 >= 3 个完全相同的数字组合、或共享主题词时，合并去重
        const nums = item.source_pass === 'llm_stage3' ? numberKey([item.sentence, ...(item.evidence ?? [])]) : ''
        const numList = nums ? nums.split(',').filter(Boolean) : []
        if (numList.length >= 2) {
          const itemTokens = extractTopicTokensForDedup([item.sentence, ...(item.evidence ?? [])])
          const isCrossSectionNumDup = deduplicated.some(e => {
            if (e.source_pass !== 'llm_stage3' || e.category !== item.category) return false
            if (numberKey([e.sentence, ...(e.evidence ?? [])]) !== nums) return false
            if (numList.length >= 3) return true
            const eTokens = extractTopicTokensForDedup([e.sentence, ...(e.evidence ?? [])])
            if (itemTokens.size === 0 || eTokens.size === 0) return e.node_id === item.node_id
            return [...itemTokens].some(t => eTokens.has(t))
          })
          if (isCrossSectionNumDup) continue
        }

        // 跨通道语义去重：同一段落/表格块若已被结构化精确核查（Pass B/C/D）定位，或同表同一子类型（如双零笔误、修订粘连含HR），合并去重
        const isRedundantWithExisting = deduplicated.some(existing => {
          if (existing.node_id !== item.node_id) return false
          // 表格单元格的意见：不同的格是不同的错误，不合并（只合并同一格）
          if (existing.cell && item.cell) {
            return existing.subtype === item.subtype && existing.cell[0] === item.cell[0] && existing.cell[1] === item.cell[1]
          }
          if (existing.subtype && existing.subtype === item.subtype) return true
          if (
            existing.subtype === 'uncleaned_revision_merge_artifact' &&
            item.subtype === 'cross_section_hr_mismatch'
          ) {
            return true
          }
          // 模型意见只在与规则意见说的是同一件事时让位：规则意见针对的是一个短的单元格值（带数字），模型意见的原句、证据或理由里有这个值。
          // 原来同一张表 / 同一段落上只要有规则意见，模型意见一律去掉，把模型查出的别的真问题也吞了（深度审稿评测 2026-11-09）
          if (existing.source_pass !== 'llm_stage3' && item.source_pass === 'llm_stage3') {
            const snip = (existing.snippet ?? '').trim()
            return snip.length > 0 && snip.length <= 30 && /\d/.test(snip) &&
              normForMatch([item.sentence, ...(item.evidence ?? []), item.reason].join(' ')).includes(normForMatch(snip))
          }
          return false
        })
        if (isRedundantWithExisting) continue
        seenKeys.add(key)
      }
      deduplicated.push(item)
    }

    const sevRank: Record<'critical' | 'major' | 'minor', number> = { critical: 0, major: 1, minor: 2 }
    deduplicated.sort((a, b) => sevRank[a.severity] - sevRank[b.severity])

    if (opts.anchorComments && deduplicated.length > 0) {
      const store = this.docs.store as any
      if (typeof store?.addComment === 'function') {
        let doc = this.docs.get(docId)
        const ops: Array<{ op: 'claim_comment'; thread: string }> = []
        for (const item of deduplicated) {
          const resolved = this.resolveTargetNodeAndSnippet(doc, item.node_id, item.snippet, item.sentence, item.cell)
          item.node_id = resolved.nodeId
          const row = store.addComment({
            doc_id: docId,
            node_id: resolved.nodeId,
            snippet: resolved.snippet,
          })
          item.comment_id = row.id
          try {
            doc = attachComment(doc, resolved.nodeId, resolved.anchorSnippet, row.id).doc
            ops.push({ op: 'claim_comment', thread: row.id })
          } catch {
            /* 段落内多处重复或跨行内原子时，退化为整块 comment mark 锚点，确保正文中始终可定位高亮 */
            try {
              doc = attachComment(doc, resolved.nodeId, '', row.id).doc
              ops.push({ op: 'claim_comment', thread: row.id })
            } catch {
              /* 块级兜底 */
            }
          }
          if (typeof store?.addReply === 'function') {
            store.addReply(
              row.id,
              'ai',
              `[${item.severity.toUpperCase()} | ${item.category}${item.subtype ? ` | ${item.subtype}` : ''}] ${item.reason}` +
                (item.evidence?.length ? `\n【对照原文】：${item.evidence.map(e => `「${e.slice(0, 300)}」`).join(' ')}` : '') +
                `\n【建议修改】：${item.suggestion}`,
            )
          }
        }
        if (ops.length > 0 && typeof (this.docs as any).commit === 'function') {
          this.docs.commit(docId, doc, { actor: 'system', turnId: null, ops })
        }
      }
    }

    return deduplicated
  }

  /**
   * 端到端四阶段临床深度审稿管线（支持 Google PAT 基线与 Heurion 2.0 模式同台对比）：
   * - `zero_shot`：单次全文调用（Google PAT Table 2 基线）；
   * - `pass_at_k`：k=3 独立全文采样汇总、无 Stage 4 去重（Google PAT Section 2 精度崩塌基线）；
   * - `pat_baseline`：原版 Google PAT 四阶段纯文本管线（Stage 1 章节切分 + Stage 2 预算分级 + Stage 3 共享 Scratchpad 分段 LLM 深审 + Stage 4 去重合成，不含结构化表文 AST 核查与批注自进化记忆）；
   * - `heurion_deep`：PAT 四阶段 + Stage 3 结构化四维核查（Pass A/B/C/D）+ Stage 4 全局合成与批注锚定；
   * - `heurion_evolved`：PAT 四阶段 + 结构化四维核查 + 医生批注反驳自进化记忆（Track A narrow + Track B）。
   */
  async deepReview(
    docId: string,
    opts: {
      mode?: DeepReviewMode
      complete?: Complete | null
      owner?: string
      anchorComments?: boolean
      passK?: number
      tablesUnreliable?: boolean
      assessTables?: boolean
      tableVision?: TableVision | null
      onProgress?: (p: ReviewProgress) => void
    } = {},
  ): Promise<FourStageReviewResult> {
    return this.runFourStageDeepReview(docId, {
      mode: opts.mode ?? 'heurion_evolved',
      ...opts,
    })
  }

  async runFourStageDeepReview(
    docId: string,
    opts: {
      mode: DeepReviewMode
      complete?: Complete | null
      owner?: string
      anchorComments?: boolean
      passK?: number
      /** 表格结构不可靠（PDF 走 poppler 兜底导入）：规则核查与模型输入都不使用表格，并提示用户 */
      tablesUnreliable?: boolean
      /** 表格由版面推断（PDF 经 Docling 导入）：逐表判断可信度，不可信的表不参与核查、不交给模型，并提示用户 */
      assessTables?: boolean
      /** 与 assessTables 一起用：先按页面图像核对表格（PDF_ORIGINAL_VIEW.md §12.3），核对不了的再按文字规则判断 */
      tableVision?: TableVision | null
      /** 进度回调（界面显示步骤；按阶段统计用量）。回调出错不影响审稿 */
      onProgress?: (p: ReviewProgress) => void
      /** 正交消融实验开关（默认全关，生产行为完全不变） */
      ablation?: {
        disableStructAst?: boolean
        disable2dTableGrid?: boolean
        disableDualQuoteGate?: boolean
        disableStage4Verifier?: boolean
        disableTrackARules?: boolean
        disableAuditChecklists?: boolean
        /** 消融对照：退回旧版全局无差别将全部 Track A 规则塞入 Stage 3 与 Stage 4 System Prompt */
        unfilteredGlobalRulePrompt?: boolean
      }
    },
  ): Promise<FourStageReviewResult> {
    const doc = this.docs.get(docId)
    const abl = opts.ablation ?? {}
    const progress = (p: ReviewProgress) => { try { opts.onProgress?.(p) } catch { /* 进度显示不影响审稿 */ } }
    progress({ step: 'read', status: 'running' })
    const tablesAll = opts.tablesUnreliable ? 0 : extractTableSummaries(doc).length
    let tables = opts.tablesUnreliable ? [] : extractTableSummaries(doc)
    const warnings = opts.tablesUnreliable ? [TABLES_UNRELIABLE_WARNING] : []
    if (opts.assessTables && tables.length) {
      const checked = await assessTablesWithVision(tables, opts.tableVision)
      tables = checked.tables
      if (checked.skipped.length) warnings.push(untrustedTablesWarning(checked.skipped))
    }
    // 全部表格都不可用时显式跳过，避免规则核查把空列表当成「未提供」而重新从文档提取表格
    const skipTables = opts.tablesUnreliable || abl.disable2dTableGrid === true || (opts.assessTables === true && tables.length === 0)
    const scratchpad = buildManuscriptScratchpad(doc, abl.disable2dTableGrid ? [] : tables)
    const useMemory = opts.mode === 'heurion_evolved'
    const activeRules = useMemory && !abl.disableTrackARules ? this.getActiveBoundaryRules(opts.owner) : []
    const activeChecklists = useMemory && !abl.disableAuditChecklists ? this.getActiveReviewAuditChecklists(opts.owner) : []

    // Stage 1 & Stage 2：按章节切分文档并统计 Light / Medium / High 预算分布
    const sections: Array<{
      title: string
      role: SectionRole
      tier: VerificationTier
      blocks: Array<{ nodeId: string; text: string; tier: VerificationTier }>
    }> = []
    let curSection = {
      title: 'Abstract / Header',
      role: 'other' as SectionRole,
      tier: 'medium' as VerificationTier,
      blocks: [] as Array<{ nodeId: string; text: string; tier: VerificationTier }>,
    }
    const budgetCounts: Record<VerificationTier, number> = { light: 0, medium: 0, high: 0 }
    // 小节标题看不出角色时（「Insulin resistance」「Statistics and reproducibility」），通过 SectionRoleTracker 沿用上一级章节角色
    const roleTracker = new SectionRoleTracker()

    doc.forEach(node => {
      if (isPendingDeletion(node)) return
      if (node.type.name === 'heading') {
        if (curSection.blocks.length > 0) sections.push(curSection)
        const hText = headingText(node)
        const role = roleTracker.onHeading(Number(node.attrs.level ?? 2), hText)
        curSection = { title: hText, role, tier: role === 'methods' || role === 'results' ? 'high' : 'medium', blocks: [] }
        return
      }
      // 图注存在图块的 caption 属性里（Word 题注与 PDF 图注都并进图块）：样本量、P 值常写在图注里，一并审读
      const figCaption = node.type.name === 'figure' ? String(node.attrs.caption ?? '').trim() : ''
      if (figCaption) {
        const nodeId = (node.attrs.id as string | null) ?? `fig_${curSection.blocks.length + 1}`
        const tier = classifyVerificationTier(figCaption, 0, curSection.role)
        budgetCounts[tier]++
        curSection.blocks.push({ nodeId, text: figCaption, tier })
        return
      }
      if (node.isTextblock) {
        const text = node.textContent.trim()
        if (!text) return
        const nodeId = (node.attrs.id as string | null) ?? `p_${curSection.blocks.length + 1}`
        const tier = classifyVerificationTier(text, 0, curSection.role)
        budgetCounts[tier]++
        if (tier === 'high') curSection.tier = 'high'
        curSection.blocks.push({ nodeId, text, tier })
      }
    })
    if (curSection.blocks.length > 0) sections.push(curSection)
    const words = sections.reduce((n, s) => n + s.blocks.reduce((m, b) => m + countWords(b.text), 0), 0)
    progress({ step: 'read', status: 'done', detail: `${sections.length} 个章节、${tables.length}/${tablesAll} 张表格` })
    const coverage: ReviewCoverage = {
      words, sections_total: sections.length, sections_reviewed: 0, sections_skipped: [],
      tables_total: tablesAll, tables_checked: skipTables ? 0 : tables.length,
      llm: Boolean(opts.complete), verifier: false,
    }
    let verifierRejected = 0
    let verifyFailedBatches = 0

    const candidates: SynthesizedReviewComment[] = []
    let seq = 1
    progress({ step: 'rules', status: 'running' })

    // 1. 若在 heurion_deep 或 heurion_evolved 模式下，执行 Stage 3 结构化临床四维核查（Pass B + Pass C + Pass D）
    if ((opts.mode === 'heurion_deep' || opts.mode === 'heurion_evolved') && !abl.disableStructAst) {
      const tablesForAst = abl.disable2dTableGrid ? [] : tables
      const structIssues = [
        ...auditInternalConsistency(doc, tablesForAst, activeRules, { skipTables }),
        ...auditMethodResultConsistency(doc, tablesForAst, activeRules),
        ...auditSpinAndGuidelines(doc, activeRules),
      ]
      for (const iss of structIssues) {
        candidates.push({
          id: `rev_struct_${seq++}`,
          node_id: iss.node_id,
          ...(iss.section_title ? { section_title: iss.section_title } : {}),
          section_role: iss.section_role,
          verification_tier: 'high',
          category: iss.category,
          ...(iss.subtype ? { subtype: iss.subtype } : {}),
          ...(iss.cell ? { cell: iss.cell } : {}),
          severity: iss.severity,
          sentence: iss.sentence,
          snippet: iss.snippet,
          reason: iss.reason,
          suggestion: iss.suggestion,
          source_pass:
            iss.category === 'internal_inconsistency'
              ? 'pass_b_internal'
              : iss.category === 'method_result_mismatch'
                ? 'pass_c_method'
                : 'pass_d_spin',
        })
      }
    }

    progress({ step: 'rules', status: 'done', detail: `${candidates.length} 处` })
    if (!opts.complete) {
      progress({ step: 'sections', status: 'skipped', detail: '没有配置审稿模型' })
      progress({ step: 'verify', status: 'skipped' })
      coverage.sections_skipped = sections.map(s => s.title)
    }

    // 2. 若提供了在线大模型（complete），按对应模式执行 LLM 审稿推理
    const docExemptedReviews = useMemory && !abl.disableTrackARules ? this.getDocExemptedReviewChecks(docId) : []
    const verifyEvidence = opts.mode === 'heurion_deep' || opts.mode === 'heurion_evolved'
    const enforceDualQuoteGate = verifyEvidence && !abl.disableDualQuoteGate
    const runStage4Verifier = verifyEvidence && !abl.disableStage4Verifier
    if (opts.complete) {
      const useLegacyUnfilteredGlobalRules = abl.unfilteredGlobalRulePrompt === true
      const globalBoundaryBlock =
        useMemory && useLegacyUnfilteredGlobalRules && activeRules.length > 0
          ? `\n【本课题组已确认的专科审稿边界豁免规则（请严格遵守：仅在原文或表注存在对应分层/调整模型/报告口径依据时免报；同一人群与同一指标的前后硬矛盾仍须报错）】：\n${activeRules.map(r => `- ${r}`).join('\n')}\n`
          : ''
      const docRebuttalBlock =
        useMemory && docExemptedReviews.length > 0
          ? `\n【本稿件上一轮审稿中作者已核实澄清并驳回的误报点（仅限本稿件；若无客观算术/区间越界错误，请勿对同一处重复报错）】：\n${docExemptedReviews
              .slice(0, 12)
              .map(e => `- 原句「${e.sentence.slice(0, 120)}」→ ${e.reason.slice(0, 160)}`)
              .join('\n')}\n`
          : ''
      const checklistBlock =
        useMemory && activeChecklists.length > 0
          ? `\n【补充跨章节核查关注点（在不影响本章节内部算术、置信区间与结论客观核查的前提下，若本章节与所附摘要/统计方法/表格在同一分析集下存在确凿矛盾，亦请附逐字原文 evidence 报出；不同分析集分层请勿误报）】：\n${activeChecklists.map(c => `- ${c}`).join('\n')}\n`
          : ''
      const rulesContext = `${globalBoundaryBlock}${docRebuttalBlock}${checklistBlock}`

      // 产品模式（heurion_deep / heurion_evolved）：意见要带原文证据并逐条核实、每章节最多 3 条；PAT 基线模式保持原样以便对照
      let corpus: string | null = null
      const corpusText = () => (corpus ??= normForMatch(`${fullProse}\n${tableMarkdown}`))
      const sevRank: Record<string, number> = { critical: 0, major: 1, minor: 2 }

      const parseLlmIssues = (rawJson: string, fallbackSection?: { title: string; role: SectionRole; firstNodeId: string }) => {
        const cleaned = rawJson.replace(/```(?:json)?/g, '').trim()
        const match = /\[[\s\S]*\]/.exec(cleaned) ?? /\{[\s\S]*\}/.exec(cleaned)
        if (!match) return
        try {
          const parsed = JSON.parse(match[0])
          let list: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed.issues) ? parsed.issues : []
          if (enforceDualQuoteGate) {
            // 原句与证据都要真在稿件里（模型编造或复述走样的引文对不上就不报），再按严重度每章节最多留 3 条
            list = list
              .filter(item => {
                const sentence = String(item?.sentence ?? item?.quote ?? '').trim()
                const evidence = (Array.isArray(item?.evidence) ? item.evidence : item?.evidence ? [item.evidence] : []).map((e: unknown) => String(e))
                return sentence && quotedIn(sentence, corpusText()) && evidence.some((e: string) => quotedIn(e, corpusText()))
              })
              .sort((a, b) => (sevRank[String(a.severity)] ?? 1) - (sevRank[String(b.severity)] ?? 1))
              .slice(0, 3)
          }
          for (const item of list) {
            if (!item || typeof item.reason !== 'string' || !item.reason.trim()) continue
            const catRaw = String(item.category ?? 'method_result_mismatch')
            const category: DeepReviewCategory =
              catRaw === 'internal_inconsistency' ||
              catRaw === 'method_result_mismatch' ||
              catRaw === 'spin_or_guideline' ||
              catRaw === 'citation_distortion'
                ? catRaw
                : 'method_result_mismatch'
            const sevRaw = String(item.severity ?? 'major')
            const severity: 'critical' | 'major' | 'minor' =
              sevRaw === 'critical' || sevRaw === 'major' || sevRaw === 'minor' ? sevRaw : 'major'
            const sentence = String(item.sentence ?? item.quote ?? fallbackSection?.title ?? '').trim()
            candidates.push({
              id: `rev_llm_${seq++}`,
              node_id: String(item.node_id ?? fallbackSection?.firstNodeId ?? 'p_1'),
              ...(fallbackSection?.title ? { section_title: fallbackSection.title } : {}),
              section_role: fallbackSection?.role ?? 'other',
              verification_tier: 'high',
              category,
              ...(item.subtype ? { subtype: String(item.subtype) } : {}),
              severity,
              sentence: sentence || '全文段落',
              snippet: sentence || '全文段落',
              reason: item.reason.trim(),
              suggestion: String(item.suggestion ?? '请核实并修正该处表述或数据。').trim(),
              source_pass: 'llm_stage3',
              ...(Array.isArray(item.evidence) || item.evidence
                ? { evidence: (Array.isArray(item.evidence) ? item.evidence : [item.evidence]).map((e: unknown) => String(e)).slice(0, 3) }
                : {}),
            })
          }
        } catch {
          /* JSON 解析容错 */
        }
      }

      const fullProse = sections
        .map(s => `## ${s.title}\n` + s.blocks.map(b => `[${b.nodeId}] ${b.text}`).join('\n'))
        .join('\n\n')

      const tableMarkdown = opts.tablesUnreliable
        ? '（本稿表格由 PDF 版面推断，行列结构不可靠，已略去；请不要依据表格做数值核对。）'
        : (opts.mode === 'heurion_deep' || opts.mode === 'heurion_evolved') && !abl.disable2dTableGrid
          ? tables
              .map(
                t =>
                  `### Table (${t.node_id}): ${t.caption ?? ''}\n| ${t.headers.join(' | ')} |\n` +
                  t.rows.map(r => `| ${r.join(' | ')} |`).join('\n'),
              )
              .join('\n\n')
          : tables.map(t => `Table (${t.node_id}) headers: ${t.headers.join(', ')}`).join('\n')

      if (opts.mode === 'zero_shot') {
        const sys =
          '你是医学与科学期刊审稿专家。请单次通读以下论文全文，找出其中的客观计算/分母错误、统计方法与结果矛盾、研究设计缺陷或结论夸大问题。输出 JSON 数组：[{"node_id":"...","sentence":"原文原句","category":"internal_inconsistency|method_result_mismatch|spin_or_guideline","severity":"critical|major|minor","reason":"中文原因","suggestion":"中文修改建议"}]。'
        const raw = await opts.complete(sys, `${fullProse}\n\n${tableMarkdown}`)
        parseLlmIssues(raw)
      } else if (opts.mode === 'pass_at_k') {
        const k = opts.passK ?? 3
        const passPromises = Array.from({ length: k }, async (_, i) => {
          const sys = `你是科学论文审稿员（Pass #${i + 1}/${k}，侧重维度：${
            i === 0 ? '样本量与数值前后矛盾' : i === 1 ? '研究设计与对照组/统计学检验缺陷' : '结论夸大与缩写/排版规范'
          }）。请找出论文中所有可疑问题（宁可多报勿漏报）。输出 JSON 数组：[{"node_id":"...","sentence":"原文原句","category":"internal_inconsistency|method_result_mismatch|spin_or_guideline","severity":"critical|major|minor","reason":"中文原因","suggestion":"中文修改建议"}]。`
          return opts.complete!(sys, `${fullProse}\n\n${tableMarkdown}`)
        })
        const raws = await Promise.all(passPromises)
        for (const raw of raws) parseLlmIssues(raw)
      } else {
        // pat_baseline / heurion_deep / heurion_evolved：按 Stage 1 章节与 Stage 2 预算（重点审查 High/Medium 章节）共享 Scratchpad 并行执行（Stage 3 Parallel Deep Review）
        const scratchpadSummary =
          `【跨章节共享 Scratchpad】：入组样本量 N=${scratchpad.enrolled_sample_sizes.join('/') || '未知'}；` +
          `表格样本量 n=${scratchpad.table_sample_sizes.join('/') || '未知'}；` +
          (scratchpad.clone_sample_sizes.length ? `表头 clones=${scratchpad.clone_sample_sizes.join('/')}；` : '') +
          `声明统计指标=${scratchpad.declared_summary_metrics.join(', ') || '未声明'}；` +
          `声明检验方法=${scratchpad.declared_tests.join(', ') || '未声明'}。`

        let targetSections = sections.filter(sec => !(sec.tier === 'light' && sec.role === 'intro'))
        // 摘要：标题含 Abstract / 摘要 的章节，没有就取第一个章节（标题前的摘要段落）；最多 4000 字
        const abstractSection = sections.find(s => /abstract|摘要|summary/i.test(s.title)) ?? sections[0]
        const abstractText = abstractSection ? abstractSection.blocks.map(b => b.text).join('\n').slice(0, 4000) : ''
        // 统计方法段落（方法里标题或正文写着统计分析的段落）：结果与讨论章节审稿时作对照（方法与结果不一致是常见错误）
        const statsText = verifyEvidence
          ? sections.filter(s => s.role === 'methods').flatMap(s => s.blocks
            .filter(b => /statistic|统计/i.test(s.title) || /statistical analys|were analy[sz]ed (?:using|with)|\b(?:SPSS|Stata|SAS)\b|R software|统计学?分析|统计软件/i.test(b.text))
            .map(b => b.text)).join('\n').slice(0, 3000)
          : ''
        if (verifyEvidence) targetSections = scheduleReviewSections(targetSections, abstractSection)
        {
          // 覆盖范围：合并后的审稿单元标题里出现过的章节都算审过
          const covered = new Set(targetSections.flatMap(s => s.title.split(' / ')))
          coverage.sections_reviewed = targetSections.length
          coverage.sections_skipped = sections.map(s => s.title).filter(t => !covered.has(t))
        }
        let sectionsDone = 0
        progress({ step: 'sections', status: 'running', done: 0, total: targetSections.length })
        const concurrency = 4
        const secResults: Array<{ raw: string; sec: (typeof targetSections)[number] }> = new Array(targetSections.length)
        let nextSecIdx = 0
        const runSectionWorker = async () => {
          while (nextSecIdx < targetSections.length) {
            const idx = nextSecIdx++
            const sec = targetSections[idx]!
            const secText = sec.blocks.map(b => `[${b.nodeId}] ${b.text}`).join('\n')
            const sys = verifyEvidence ? sectionReviewPrompt(sec.title, sec.role, scratchpadSummary, rulesContext) :
              `你是四阶段科学深度审稿系统（Stage 3 Specialist Reviewer，当前分配预算：${sec.tier.toUpperCase()} Thinking Track）。\n` +
              `${scratchpadSummary}${rulesContext}\n` +
              `请结合全局 Scratchpad 深入审查当前章节「${sec.title}」（角色：${sec.role}），重点核查：\n` +
              `1) 样本量分母、百分比算术（n/N）、置信区间上下界或修订粘连错误；\n` +
              `2) 统计方法（Mean±SD vs SEM vs Median[IQR]）、对照组设计与结果报告是否矛盾；\n` +
              `3) 跨章节终点指标（如 pCR、OS、HR）或缩略语定义是否前后不一致。\n` +
              `若无客观问题请返回 []；若有问题请严格输出 JSON 数组：[{"node_id":"块ID","sentence":"原文原句","category":"internal_inconsistency|method_result_mismatch|spin_or_guideline","severity":"critical|major|minor","reason":"中文具体原因","suggestion":"中文修改建议"}]。`
            // 产品模式：结果与讨论章节附上摘要与统计方法段落作对照（摘要与正文、方法与结果不一致是常见错误，
            // 按章节审时看不到就拿不出证据）；方法、引言等章节不附，省输入
            const crossCheck = verifyEvidence && (sec.role === 'results' || sec.role === 'discussion')
            const abstractRef = crossCheck && abstractText && sec !== abstractSection
              ? `\n\n【摘要（供对照；与本章节不一致时可逐字引用作为 evidence）】：\n${abstractText}`
              : ''
            const statsRef = crossCheck && statsText
              ? `\n\n【统计方法（供对照；与本章节报告的方法不一致时可逐字引用作为 evidence）】：\n${statsText}`
              : ''
            // 表格：结果章节都给；方法章节原来都给，产品模式下只给统计分析小节（小节角色沿用上级后，方法小节很多，逐个附全部表格太费）
            const withTables = sec.role === 'results' ||
              (sec.role === 'methods' && (!verifyEvidence || /statistic|统计/i.test(`${sec.title}\n${secText.slice(0, 600)}`)))
            const userPayload = withTables
              ? `【当前章节正文】：\n${secText}\n\n【关联表格信息】：\n${tableMarkdown}${abstractRef}${statsRef}`
              : `【当前章节正文】：\n${secText}${abstractRef}${statsRef}`
            const raw = await opts.complete!(sys, userPayload)
            secResults[idx] = { raw, sec }
            progress({ step: 'sections', status: 'running', done: ++sectionsDone, total: targetSections.length, detail: sec.title })
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(concurrency, targetSections.length) }, () => runSectionWorker()),
        )
        for (const { raw, sec } of secResults) {
          parseLlmIssues(raw, {
            title: sec.title,
            role: sec.role,
            firstNodeId: sec.blocks[0]?.nodeId ?? 'p_1',
          })
        }

        // 全文复核：章节审稿只看到本章节与摘要，把全部模型意见连同全文交给模型逐条复核，判为不成立的不报（每 20 条一次调用）
        progress({ step: 'sections', status: 'done', done: sectionsDone, total: targetSections.length, detail: `${candidates.filter(c => c.source_pass === 'llm_stage3').length} 条模型意见` })
        if (!runStage4Verifier) progress({ step: 'verify', status: 'skipped' })
        if (runStage4Verifier) {
          const llm = candidates.filter(c => c.source_pass === 'llm_stage3')
          const rejected = new Set<SynthesizedReviewComment>()
          const batches = Math.ceil(llm.length / 20)
          coverage.verifier = true
          progress({ step: 'verify', status: 'running', done: 0, total: batches })
          const fullText = `${fullProse}\n\n${tableMarkdown}`
          for (let i = 0; i < llm.length; i += 20) {
            const batch = llm.slice(i, i + 20)
            let anyCandidateScopedRule = false
            const list = batch
              .map((c, k) => {
                const scopedRules =
                  useMemory && !useLegacyUnfilteredGlobalRules && activeRules.length > 0
                    ? selectCandidateScopedBoundaryRules(c, activeRules)
                    : []
                if (scopedRules.length > 0) anyCandidateScopedRule = true
                const ruleSuffix =
                  scopedRules.length > 0
                    ? `\n   候选适用专科边界规则（仅当原文或表头/表注确有该分层/模型/分布声明依据，且非同一分析集与同一指标的前后硬矛盾时方可判 rejected；否则必须判 holds）：${scopedRules.join(' ｜ ')}`
                    : ''
                return `${k + 1}. [${c.severity}] 原句：${c.sentence}\n   证据：${(c.evidence ?? []).join(' / ') || '（无）'}\n   理由：${c.reason}${ruleSuffix}`
              })
              .join('\n')
            const verifySysForBatch =
              globalBoundaryBlock || docRebuttalBlock
                ? `${VERIFY_SYSTEM}\n${globalBoundaryBlock}${docRebuttalBlock}复核准则补充：\n1) 若待复核意见确实属于上述合法研究设计/统计分层/模型调整边界（原文或表头/表注有明确依据），或属于本稿件作者上一轮已核实澄清的同一非算术误报点，请将其 verdict 判为 rejected；\n2) 若待复核意见指出了同一分析集、同一模型、同一指标的前后数值硬矛盾、百分比或分项加总算术不符、点估计落在置信区间外、或 P>=0.05 阳性夸大，必须判为 holds，严禁借边界规则误放过真实客观错误。`
                : anyCandidateScopedRule
                  ? `${VERIFY_SYSTEM}\n复核准则补充：部分条目下方附有“候选适用专科边界规则”；仅当论文原文或表头/表注确实存在该规则要求的分层/模型/双分布声明依据且并非同一分析集与同一指标的前后硬矛盾时判为 rejected，一切真实客观矛盾与计算/区间/夸大错误必须判为 holds。`
                  : VERIFY_SYSTEM
            try {
              const verdicts = parseVerdicts(await opts.complete!(verifySysForBatch, `【论文全文】\n${fullText}\n\n【待复核的意见】\n${list}`))
              batch.forEach((c, k) => { if (verdicts.get(k + 1) === 'rejected') rejected.add(c) })
            } catch {
              /* 复核调用失败：这一批照常报出（记入质量数据，不再无声无息） */
              verifyFailedBatches++
            }
            progress({ step: 'verify', status: 'running', done: i / 20 + 1, total: batches })
          }
          verifierRejected = rejected.size
          if (verifyFailedBatches) warnings.push(`全文复核有 ${verifyFailedBatches} 批调用失败，这些意见未经复核，可能有误报。`)
          progress({ step: 'verify', status: 'done', done: batches, total: batches, detail: `删去 ${rejected.size} 条不成立的意见` })
          if (rejected.size) {
            const kept = candidates.filter(c => !rejected.has(c))
            candidates.length = 0
            candidates.push(...kept)
          }
        }
      }
    }
    progress({ step: 'synthesize', status: 'running' })

    // Stage 4：全局合成（pass_at_k 模式下不去重以展示 Google Section 2 的假阳性堆积效应；其余模式执行 Stage 4 去重与过滤）
    const synthesized = this.synthesizeStage4Review(docId, candidates, {
      deduplicate: opts.mode !== 'pass_at_k',
      useMemory: useMemory && !abl.disableTrackARules,
      owner: opts.owner,
      anchorComments: opts.anchorComments,
      verifiedByLlm: Boolean(opts.complete && runStage4Verifier),
    })
    progress({ step: 'synthesize', status: 'done', detail: `${synthesized.length} 条意见` })

    return {
      doc_id: docId,
      mode: opts.mode,
      scratchpad,
      stage1_sections: sections.length,
      stage2_budget_counts: budgetCounts,
      stage3_raw_candidates: candidates.length,
      stage4_deduplicated_comments: synthesized,
      active_rules_applied: activeRules,
      warnings,
      coverage,
      verifier_rejected: verifierRejected,
    }
  }

  private recordIntraDocReviewExemption(
    docId: string,
    commentId: string,
    linkedCheck: any,
    commentObj: any,
    aiReplyText: string,
    inferredCategory: string | undefined,
    opts: {
      rebuttalText: string
      issueSubtype?: string | null
      sentence?: string
      reason?: string
      evidence?: string[]
    },
  ): string | undefined {
    const store = this.docs.store as any
    if (linkedCheck && typeof store?.putClaimCheck === 'function') {
      store.putClaimCheck({
        doc_id: docId,
        claim_id: linkedCheck.claim_id,
        node_id: linkedCheck.node_id,
        sentence: linkedCheck.sentence,
        verdict: 'exempted',
        evidence_tier: linkedCheck.evidence_tier,
        evidence_quote: linkedCheck.evidence_quote,
        reason: `作者申辩豁免：${opts.rebuttalText.trim()}`,
        comment_id: commentId,
        rev: typeof this.docs?.rev === 'function' ? this.docs.rev(docId) : 0,
      })
      return linkedCheck.claim_id
    }

    const inferredSubtype =
      opts.issueSubtype ??
      /\[(?:CRITICAL|MAJOR|MINOR)\s*\|\s*[a-z_]+\s*\|\s*([a-z0-9_]+)\]/i.exec(aiReplyText)?.[1]?.toLowerCase() ??
      undefined
    const targetSentence = (opts.sentence ?? commentObj?.snippet ?? '').trim()
    const targetReason = (opts.reason ?? aiReplyText ?? '').trim()

    if (
      targetSentence.length > 0 &&
      typeof store?.putClaimCheck === 'function' &&
      !isHardObjectiveReviewFinding({
        category: inferredCategory,
        subtype: inferredSubtype,
        sentence: targetSentence,
        reason: targetReason,
      })
    ) {
      const exemptId =
        'rev_exempt_' +
        createHash('sha1')
          .update(`${inferredCategory ?? 'review'}|${normForMatch(targetSentence).slice(0, 140)}`)
          .digest('hex')
          .slice(0, 12)
      store.putClaimCheck({
        doc_id: docId,
        claim_id: exemptId,
        node_id: commentObj?.node_id ?? '',
        sentence: targetSentence,
        verdict: 'exempted',
        evidence_tier: 'fulltext',
        evidence_quote: (opts.evidence ?? []).join(' | '),
        reason: `作者申辩豁免 [${inferredCategory ?? 'review'}]：${opts.rebuttalText.trim()}`,
        comment_id: commentId,
        rev: typeof this.docs?.rev === 'function' ? this.docs.rev(docId) : 0,
      })
      if (commentObj && typeof store?.setCommentStatus === 'function') {
        if (typeof store?.addReply === 'function') {
          store.addReply(commentId, 'user', opts.rebuttalText.trim())
        }
        store.setCommentStatus(docId, commentId, 'resolved', 'user')
      }
      return exemptId
    }
    return undefined
  }

  /**
   * 审稿批注自演进闭环（Comment-Driven Dual-Track Evolution Loop）：
   * 将研究者在 `{#c:id}` 审稿批注上的交互反馈回流至双轨自演进引擎：
   * 1. 作者驳回/申辩（rebuttalText 非空且 acceptedFix !== true）：
   *    - 将关联的 claim_check（或非硬伤深审批注）标记为 `exempted`（同稿幂等豁免，后续复审不再重复挂批注）；
   *    - 触发 Track A `narrow` 算子：通过 `synthesizeSanitizedBoundaryRule` 动态提炼去数字化的专科边界记忆，避免对同类自报队列、TTE 克隆伪队列、单臂试验或转化实验再次误报。
   * 2. 作者采纳审稿意见并改稿修复（acceptedFix === true）：
   *    - 写入带 `recovery_ops` 的已验证执行信号（execution_signal），供 Track B 程序性策略引擎提炼前置守卫规则。
   */
  evolveFromReviewComment(
    docId: string,
    commentId: string,
    opts: {
      owner?: string
      rebuttalText?: string
      acceptedFix?: boolean
      issueCategory?: string
      issueSubtype?: string | null
      recoveryOp?: string
      sentence?: string
      reason?: string
      evidence?: string[]
    } = {},
  ): {
    track: 'track_a_narrow' | 'track_b_procedural' | 'none'
    exemptedClaimId?: string
    memoryId?: string
    signalId?: string
    distilledRule?: string
  } {
    const store = this.docs.store as any
    recordFindingOutcome(store, commentId, opts)
    const owner = opts.owner ?? (typeof store?.getDoc === 'function' ? store.getDoc(docId)?.owner : undefined) ?? 'local'
    const checks = (typeof store?.listClaimChecks === 'function' ? store.listClaimChecks(docId) : []) as Array<any>
    const linkedCheck = checks.find(c => c.comment_id === commentId)
    const commentObj = typeof store?.getComment === 'function' ? store.getComment(docId, commentId) : undefined
    const aiReplyText = commentObj?.replies?.find((r: any) => r.role === 'ai')?.text ?? ''

    // Case 1: 研究者回复驳回（Rebuttal）-> 豁免该论断 + Track A narrow 动态收窄边界记忆
    if (opts.rebuttalText && !opts.acceptedFix) {
      const inferredCategory =
        opts.issueCategory ??
        /\|\s*(internal_inconsistency|method_result_mismatch|spin_or_guideline|citation_distortion|missing_citation)(?:\s*\||\])/i
          .exec(aiReplyText)?.[1]
          ?.toLowerCase() ??
        (linkedCheck?.verdict === 'missing_citation' ? 'missing_citation' : undefined)

      const exemptedClaimId = this.recordIntraDocReviewExemption(
        docId,
        commentId,
        linkedCheck,
        commentObj,
        aiReplyText,
        inferredCategory,
        {
          rebuttalText: opts.rebuttalText,
          issueSubtype: opts.issueSubtype,
          sentence: opts.sentence ?? linkedCheck?.sentence,
          reason: opts.reason ?? linkedCheck?.reason,
          evidence: opts.evidence,
        },
      )

      const { patternKey, rule: narrowRule } = synthesizeSanitizedBoundaryRule(opts.rebuttalText, {
        sentence: opts.sentence ?? linkedCheck?.sentence ?? commentObj?.snippet,
        category: inferredCategory,
        reason: opts.reason ?? linkedCheck?.reason ?? aiReplyText,
      })

      const existingMems = (typeof store?.listMemories === 'function' ? store.listMemories(owner) : []) as Array<any>
      const keyPrefixColon = `[narrow:review_boundary:${patternKey}:`
      const keyExact = `[narrow:review_boundary:${patternKey}]`
      const existingMem = existingMems.find(
        m =>
          m.content.includes(keyPrefixColon) ||
          m.content.includes(keyExact) ||
          (patternKey === 'self_cohort_boundary' && m.content.includes('[narrow:review_boundary]')),
      )
      const memRow =
        existingMem && typeof store?.updateMemory === 'function'
          ? (store.updateMemory(existingMem.id, { content: narrowRule }), existingMem)
          : store.addMemory({
              scope: 'global',
              owner,
              project_id: null,
              kind: 'preference',
              content: narrowRule,
              norm: narrowRule.toLowerCase(),
              reason: `审稿批注作者申辩收窄边界：${opts.rebuttalText.trim().slice(0, 80)}`,
              source: 'review',
              source_doc_id: docId,
              source_turn_id: null,
              explicit: 1,
              status: 'active',
            })
      return {
        track: 'track_a_narrow',
        ...(exemptedClaimId ? { exemptedClaimId } : {}),
        memoryId: memRow.id,
        distilledRule: narrowRule,
      }
    }

    // Case 2: 研究者采纳审稿意见并改稿修复 -> 记录带恢复轨迹的去数字化信号供 Track B 提炼前置规则
    if (opts.acceptedFix) {
      const code = opts.issueCategory ?? (linkedCheck?.verdict === 'unsupported' ? 'citation_unsupported' : 'review_comment_fix')
      const recovery = opts.recoveryOp ?? 'doc_read → replace_text (align prose with table/method/citation evidence) → resolve_comment'
      const rawHint = opts.reason ?? linkedCheck?.reason ?? ''
      const sanitizedHint =
        rawHint && !hasInstanceLeakage(rawHint)
          ? rawHint
          : '落笔前先用 doc_read 核对正文数值与表格/统计方法/文献原文一致性，避免产生表文算术矛盾、方法结果冲突或结论夸大表述'
      const sigRow = store.addExecutionSignal({
        owner,
        doc_id: docId,
        turn_id: `review_fix_${commentId}`,
        kind: 'guard_reject',
        code,
        detail: JSON.stringify({
          message: '作者采纳审稿批注并完成正文修正',
          hint: sanitizedHint,
          failed_ops: 'unverified_prose_claim',
          recovery_ops: recovery,
          domain: 'manuscript',
        }),
      })
      return {
        track: 'track_b_procedural',
        ...(linkedCheck ? { exemptedClaimId: linkedCheck.claim_id } : {}),
        signalId: sigRow.id,
      }
    }

    return { track: 'none' }
  }

  /**
   * 异步在线大模型版审稿批注自演进闭环：
   * 当提供 `complete` 时，使用 `synthesizeSanitizedBoundaryRuleAsync` 进行零模板 LLM 规则蒸馏与双重实例脱敏校验。
   */
  async evolveFromReviewCommentAsync(
    docId: string,
    commentId: string,
    opts: {
      complete?: Complete | null
      owner?: string
      rebuttalText?: string
      acceptedFix?: boolean
      issueCategory?: string
      issueSubtype?: string | null
      recoveryOp?: string
      sentence?: string
      reason?: string
      evidence?: string[]
    } = {},
  ): Promise<{
    track: 'track_a_narrow' | 'track_b_procedural' | 'none'
    exemptedClaimId?: string
    memoryId?: string
    signalId?: string
    distilledRule?: string
    rawRebuttalHadDigits?: boolean
    firstDraftLeaked?: boolean
  }> {
    if (!opts.complete || opts.acceptedFix || !opts.rebuttalText) {
      return this.evolveFromReviewComment(docId, commentId, opts)
    }
    const store = this.docs.store as any
    recordFindingOutcome(store, commentId, opts)
    const owner = opts.owner ?? (typeof store?.getDoc === 'function' ? store.getDoc(docId)?.owner : undefined) ?? 'local'
    const checks = (typeof store?.listClaimChecks === 'function' ? store.listClaimChecks(docId) : []) as Array<any>
    const linkedCheck = checks.find(c => c.comment_id === commentId)
    const commentObj = typeof store?.getComment === 'function' ? store.getComment(docId, commentId) : undefined
    const aiReplyText = commentObj?.replies?.find((r: any) => r.role === 'ai')?.text ?? ''

    const inferredCategory =
      opts.issueCategory ??
      /\|\s*(internal_inconsistency|method_result_mismatch|spin_or_guideline|citation_distortion|missing_citation)(?:\s*\||\])/i
        .exec(aiReplyText)?.[1]
        ?.toLowerCase() ??
      (linkedCheck?.verdict === 'missing_citation' ? 'missing_citation' : undefined)

    const exemptedClaimId = this.recordIntraDocReviewExemption(
      docId,
      commentId,
      linkedCheck,
      commentObj,
      aiReplyText,
      inferredCategory,
      {
        rebuttalText: opts.rebuttalText,
        issueSubtype: opts.issueSubtype,
        sentence: opts.sentence ?? linkedCheck?.sentence,
        reason: opts.reason ?? linkedCheck?.reason,
        evidence: opts.evidence,
      },
    )

    const { patternKey, rule: narrowRule, rawRebuttalHadDigits, firstDraftLeaked } =
      await synthesizeSanitizedBoundaryRuleAsync(opts.complete, opts.rebuttalText, {
        sentence: opts.sentence ?? linkedCheck?.sentence ?? commentObj?.snippet,
        category: inferredCategory,
        reason: opts.reason ?? linkedCheck?.reason ?? aiReplyText,
      })

    const existingMems = (typeof store?.listMemories === 'function' ? store.listMemories(owner) : []) as Array<any>
    const keyPrefixColon = `[narrow:review_boundary:${patternKey}:`
    const keyExact = `[narrow:review_boundary:${patternKey}]`
    const existingMem = existingMems.find(m => m.content.includes(keyPrefixColon) || m.content.includes(keyExact))
    const memRow =
      existingMem && typeof store?.updateMemory === 'function'
        ? (store.updateMemory(existingMem.id, { content: narrowRule }), existingMem)
        : store.addMemory({
            scope: 'global',
            owner,
            project_id: null,
            kind: 'preference',
            content: narrowRule,
            norm: narrowRule.toLowerCase(),
            reason: `审稿批注作者申辩收窄边界：${opts.rebuttalText.trim().slice(0, 80)}`,
            source: 'review',
            source_doc_id: docId,
            source_turn_id: null,
            explicit: 1,
            status: 'active',
          })

    return {
      track: 'track_a_narrow',
      ...(exemptedClaimId ? { exemptedClaimId } : {}),
      memoryId: memRow.id,
      distilledRule: narrowRule,
      rawRebuttalHadDigits,
      firstDraftLeaked,
    }
  }
}

/** 「核对全部论断」回合的提示（基于四阶段多智能体学术审查工作流）。 */
export function verifyPrompt(docId: string): string {
  return (
    `请按四阶段学术审稿工作流核对并审查文档 ${docId}，只把真正有问题、需要作者注意的地方挂为评论，不直接修改正文：\n` +
    `1. [Stage 1 & 2 章节感知与预算分级核对]：调用 verify_claims（doc_id="${docId}"），按 next_cursor 翻页直到取完；结合每条论断的 section_role（intro/methods/results/discussion）与 verification_tier（high/medium/light）分配审查力度，重点深挖 high 级统计与定量论断；${CLAIM_CRITERIA}每页判断完用 claim_report 提交；\n` +
    `2. [Stage 3 多维专项审查（文献对齐 / 正文-表格自洽 / 方法-结果对齐 / Spin 与报告规范）]：结合 verify_claims 返回的 tables 摘要、audit_issues 与 doc_read 通读全文：\n` +
    `   - Pass A（外部文献对齐）：核实数值（含百分比与小数等价性）及效应方向是否与所引文献一致；若文献缺失摘要，可调用 pubmed_search 实时检索补全证据；\n` +
    `   - Pass B（跨章节与正文-表格自洽）：核对摘要、方法、结果及表格（如 Table 1）之间的总样本量 N、亚组频数/百分比加总、HR/OR/P 值及影像测量原子 [@m:id] 是否前后一致；\n` +
    `   - Pass C（统计/影像方法与结果一致性及缺出处溯源）：核查统计方法（正态 Mean±SD vs 偏态 Median[IQR] vs 标准误 SEM、卡方 vs Fisher 精确检验）及缩略语定义是否与结果一致；对引言/讨论中漏标引用的外部研究论断用 claim_report 标记；\n` +
    `   - Pass D（Spin Bias 与 CONSORT/STROBE 规范）：拦截 P ≥ 0.05 却使用“显著获益”阳性夸大措辞（Spin Bias）或观察性研究使用强因果定性措辞；\n` +
    `3. [Stage 4 全局汇总与严重度分级]：对跨章节重复问题去重，按严重度（严重 Critical / 主要 Major / 次要 Minor）在两三句话内总结核对结果。`
  )
}
