import { findBareMeasurements } from '../model/measurements.ts'

/**
 * 科室所见模板（PRD W4.1 / T2.6，docs/design/IMAGING_STUDIES.md「所见草稿（T2.6）」）：纯函数部分——模板结构、语法、校验与渲染。
 *
 * 模板是一份 JSON：按情况分句（每个已确认结节一句，按随访变化选句；未见结节；前片消失的结节；比较说明），
 * 句子里用占位符取值。语法只有三样，不能执行任何代码（没有表达式、循环、函数调用、HTML）：
 * - `{名称}`：占位符；`{名称|缺省文字}`：没有值时用缺省文字；
 * - `[ … ]`：可选片段，里面任何一个占位符没有值（且没写缺省文字）时整段省略（如「[，体积 {体积}]」——分割失败、没有体积时整段不写）；不能嵌套；
 * - `\{ \} \[ \] \| \\`：字面量。
 * 测量类占位符（平均径、体积、随访差值、VDT……）渲染为测量原子 [@m:id]，不是数字；模板文字本身不能写测量数字
 * （和 AI 一样受「裸测量数字」规则约束，阈值写比较词「≥ 6 mm」除外）。模板文字在写进文档前逐字转义，
 * 所以写进模板的 markdown / HTML 记号（`**`、`<u>`、`[@m:…]`、`# `）都按字面显示，不会变成格式、原子或标题。
 */

export const TEMPLATE_KIND = 'lung_nodule'

/** 每个结节句子按情况选用（缺的情况用 default）。 */
export const NODULE_CASES = ['default', 'new', 'enlarged', 'shrunk', 'stable', 'review', 'no_prior'] as const
export type NoduleCase = (typeof NODULE_CASES)[number]
export const COMPARISON_CASES = ['finalized', 'unfinalized', 'none'] as const
export type ComparisonCase = (typeof COMPARISON_CASES)[number]
export const IMPRESSION_CASES = ['default', 'none'] as const
export type ImpressionCase = (typeof IMPRESSION_CASES)[number]

export interface FindingsTemplateBody {
  /** 草稿正文的标题（不进 RIS 纯文本） */
  title: string
  /** 每个已确认结节一句 */
  nodule: { default: string } & Partial<Record<Exclude<NoduleCase, 'default'>, string>>
  /** 没有已确认的结节 */
  none: string
  /** 前片有、本次没有的结节（每个一句） */
  disappeared?: string
  /** 比较说明（放在结节句子之前）：前片已定稿 / 前片未定稿（按已确认结节对比）/ 没有前片 */
  comparison?: Partial<Record<ComparisonCase, string>>
  /** 影像印象段（W4.3：客观总结，不给诊断结论或随访建议；可为字符串或 { default, none }） */
  impression?: string | Partial<Record<ImpressionCase, string>>
  /** 结尾句（可选） */
  closing?: string
}

/** 占位符：名称 → 说明、是否为测量原子。按句子类别限定可用的占位符。 */
export interface PlaceholderDef { label: string; measure: boolean }
const P = (label: string, measure = false): PlaceholderDef => ({ label, measure })
const NODULE_PH: Record<string, PlaceholderDef> = {
  序号: P('结节在草稿里的顺序号（1、2、3…）'),
  编号: P('结节名称（如「结节 1」「医生补充 1」）'),
  位置: P('肺叶（如「右肺上叶」）；没有定位时为空'),
  密度: P('实性 / 部分实性 / 磨玻璃；没有分型时为空'),
  平均径: P('平均径', true),
  长径: P('长径', true),
  短径: P('短径', true),
  体积: P('体积（分割失败时为空）', true),
  CT值: P('平均 CT 值', true),
  实性成分: P('实性成分直径（部分实性结节）', true),
  CTR: P('实性成分占比（部分实性结节）', true),
  变化: P('新发 / 较前增大 / 较前缩小 / 较前相仿；未对比时为空'),
  平均径变化: P('与前片相比平均径的变化（带正负号）', true),
  体积变化: P('与前片相比体积的变化（mm³，带正负号）', true),
  体积变化率: P('与前片相比体积的变化率（%，带正负号）', true),
  VDT: P('体积倍增时间（只在体积增大且超出测量误差时有值）', true),
  误差说明: P('变化在测量误差范围内时为「变化在测量误差范围内」，否则为空'),
  前片编号: P('前片对应结节的名称'),
  前片日期: P('前片检查日期'),
  间隔: P('与前片间隔天数（如「183 天」，由两次检查日期算出）'),
}
const PRIOR_PH: Record<string, PlaceholderDef> = {
  序号: P('顺序号'),
  前片编号: P('前片结节的名称'),
  前片位置: P('前片结节所在肺叶'),
  前片日期: P('前片检查日期'),
  间隔: P('与前片间隔天数'),
}
const STUDY_PH: Record<string, PlaceholderDef> = {
  前片日期: P('前片检查日期'),
  间隔: P('与前片间隔天数'),
  检查日期: P('本次检查日期'),
}
const IMPRESSION_PH: Record<string, PlaceholderDef> = {
  ...STUDY_PH,
  结节数: P('已确认结节总数（如「2」）'),
  最大结节编号: P('平均径最大的已确认结节名称'),
  最大结节位置: P('平均径最大的已确认结节所在肺叶'),
  最大结节密度: P('平均径最大的已确认结节密度分型'),
  最大结节平均径: P('平均径最大的已确认结节的平均径', true),
  最大结节长径: P('平均径最大的已确认结节的长径', true),
  最大结节体积: P('平均径最大的已确认结节的体积（分割失败时为空）', true),
  随访概况: P('与前片对比的客观变化汇总（如「新发 1 枚，较前增大 1 枚」「较前相仿」；未对比时为空）'),
}
export const PLACEHOLDERS = { nodule: NODULE_PH, disappeared: PRIOR_PH, study: STUDY_PH, impression: IMPRESSION_PH } as const

/** W4.3 客观影像印象段参考模板（只作客观总结，不给诊断结论或随访建议；可在科室模板中选用） */
export const DEFAULT_IMPRESSION_TEMPLATE: Record<ImpressionCase, string> = {
  default: '印象：双肺见 {结节数} 枚结节[，较大者位于{最大结节位置|肺内}，平均径 {最大结节平均径}][，体积 {最大结节体积}][；与 {前片日期} 片比较，{随访概况}]。',
  none: '印象：双肺未见明确结节。',
}

const MAX_SENTENCE = 400
const MAX_TITLE = 60
const MAX_BODY = 16_000

/** 内置模板（种子）：机构与科室没有维护自己的模板时使用；可被机构默认模板、科室模板覆盖。 */
/** 内置模板内容一改就加一（草稿记下所用版本；v2：「消失」句措辞） */
export const BUILTIN_VERSION = 2
export const BUILTIN_TEMPLATE: FindingsTemplateBody = {
  title: '影像所见',
  nodule: {
    default: '{序号}. {位置|肺内}见{密度}结节，平均径 {平均径}[，体积 {体积}]。',
    new: '{序号}. {位置|肺内}见{密度}结节，平均径 {平均径}[，体积 {体积}]，为新发结节。',
    enlarged: '{序号}. {位置|肺内}{密度}结节，平均径 {平均径}[，体积 {体积}]，较前增大[，平均径变化 {平均径变化}][，体积变化 {体积变化率}][，体积倍增时间约 {VDT}]。',
    shrunk: '{序号}. {位置|肺内}{密度}结节，平均径 {平均径}[，体积 {体积}]，较前缩小[，平均径变化 {平均径变化}][，体积变化 {体积变化率}]。',
    stable: '{序号}. {位置|肺内}{密度}结节，平均径 {平均径}[，体积 {体积}]，与前片相仿[（{误差说明}）]。',
    review: '{序号}. {位置|肺内}见{密度}结节，平均径 {平均径}[，体积 {体积}]；与前片的对应关系待核对。',
  },
  none: '双肺未见明确结节。',
  disappeared: '前片所见{前片位置|肺内}结节，本次未见。',
  comparison: {
    finalized: '与 {前片日期} 片比较[（间隔 {间隔}）]。',
    unfinalized: '与 {前片日期} 片比较（前片尚未定稿，按其已确认的结节对比）。',
    none: '无前片可供比较。',
  },
  impression: DEFAULT_IMPRESSION_TEMPLATE,
}

// —— 语法 ——

export type Token = { t: 'text'; v: string } | { t: 'ph'; name: string; fallback: string | null }
export type Piece = Token | { t: 'opt'; items: Token[] }

export class TemplateError extends Error {
  constructor(readonly where: string, message: string) { super(`${where}：${message}`) }
}

/** 解析一句模板。allowed = 这一类句子可用的占位符。 */
export function parseSentence(src: string, where: string, allowed: Record<string, PlaceholderDef>): Piece[] {
  if (typeof src !== 'string') throw new TemplateError(where, '应为文字')
  if (src.length > MAX_SENTENCE) throw new TemplateError(where, `太长（${src.length} 字，上限 ${MAX_SENTENCE}）`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(src)) throw new TemplateError(where, '不能有换行或控制字符：每一句写成一行（一句一段）')
  const out: Piece[] = []
  let opt: Token[] | null = null
  let text = ''
  const push = (tok: Token) => { (opt ?? (out as Token[])).push(tok) }
  const flush = () => { if (text) { push({ t: 'text', v: text }); text = '' } }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (ch === '\\') {
      const nx = src[i + 1]
      if (nx === undefined || !'{}[]|\\'.includes(nx)) throw new TemplateError(where, `第 ${i + 1} 个字符：反斜杠只能用来写字面量 \\{ \\} \\[ \\] \\| \\\\`)
      text += nx
      i++
      continue
    }
    if (ch === '{') {
      const end = src.indexOf('}', i + 1)
      if (end < 0) throw new TemplateError(where, `第 ${i + 1} 个字符的「{」没有配对的「}」`)
      const inner = src.slice(i + 1, end)
      if (inner.includes('{') || inner.includes('[') || inner.includes(']')) throw new TemplateError(where, `占位符「{${inner}}」里不能再有括号`)
      const bar = inner.indexOf('|')
      const name = (bar < 0 ? inner : inner.slice(0, bar)).trim()
      const fallback = bar < 0 ? null : inner.slice(bar + 1)
      if (!name) throw new TemplateError(where, '占位符名称为空')
      if (!Object.prototype.hasOwnProperty.call(allowed, name)) {
        throw new TemplateError(where, `不认识的占位符「{${name}}」；这一句可用：${Object.keys(allowed).map(k => `{${k}}`).join(' ')}`)
      }
      if (fallback !== null && allowed[name]!.measure) throw new TemplateError(where, `测量占位符「{${name}}」不能写缺省文字（没有测量时应省略，用 [ … ] 包起来）`)
      if (fallback && findBareMeasurements(fallback).length) throw new TemplateError(where, `缺省文字「${fallback}」里不能写测量数字`)
      flush()
      push({ t: 'ph', name, fallback })
      i = end
      continue
    }
    if (ch === '}') throw new TemplateError(where, `第 ${i + 1} 个字符的「}」没有配对的「{」（字面量写 \\}）`)
    if (ch === '[') {
      if (opt) throw new TemplateError(where, '可选片段 [ … ] 不能嵌套')
      flush()
      opt = []
      continue
    }
    if (ch === ']') {
      if (!opt) throw new TemplateError(where, `第 ${i + 1} 个字符的「]」没有配对的「[」（字面量写 \\]）`)
      flush()
      if (!opt.some(x => x.t === 'ph')) throw new TemplateError(where, '可选片段 [ … ] 里至少要有一个占位符')
      out.push({ t: 'opt', items: opt })
      opt = null
      continue
    }
    if (ch === '|') throw new TemplateError(where, '「|」只能写在占位符里（字面量写 \\|）')
    text += ch
  }
  if (opt) throw new TemplateError(where, '可选片段的「[」没有配对的「]」')
  flush()
  // 模板文字本身不能写测量数字：草稿里的测量数字一律是测量原子（与 AI 写入同一条规则）
  const literal = out.flatMap(p => p.t === 'opt' ? p.items : [p]).filter((x): x is { t: 'text'; v: string } => x.t === 'text').map(x => x.v).join(' ')
  const bare = findBareMeasurements(literal)
  if (bare.length) throw new TemplateError(where, `模板文字里不能写测量数字（${bare.join('、')}）；病灶的测量请用占位符，指南阈值写明比较词（如「≥ 6 mm」）`)
  return out
}

export interface ParsedTemplate {
  body: FindingsTemplateBody
  title: string
  nodule: Record<NoduleCase, Piece[] | null>
  none: Piece[]
  disappeared: Piece[] | null
  comparison: Record<ComparisonCase, Piece[] | null>
  impression: Record<ImpressionCase, Piece[] | null>
  closing: Piece[] | null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** W4.3 影像印象段禁写主观诊断结论或随访建议（只做客观总结） */
const IMPRESSION_FORBIDDEN_RE = /(考虑.{0,6}(?:恶性|癌|肿瘤|转移|结核|炎)|疑似.{0,6}(?:恶性|癌|肿瘤)|不能除外|不除外|建议.{0,8}(?:随访|复查|穿刺|活检|手术|增强|治疗|就诊)|Lung-?RADS|BI-?RADS)/i

/** 校验并解析整份模板；有错时抛 TemplateError（指出哪一句、什么问题）。 */
export function parseTemplate(input: unknown): ParsedTemplate {
  if (!isObj(input)) throw new TemplateError('模板', '应为 JSON 对象')
  if (JSON.stringify(input).length > MAX_BODY) throw new TemplateError('模板', `太大（上限 ${MAX_BODY} 字符）`)
  const known = new Set(['title', 'nodule', 'none', 'disappeared', 'comparison', 'impression', 'closing'])
  for (const k of Object.keys(input)) if (!known.has(k)) throw new TemplateError('模板', `不认识的字段「${k}」；可用：${[...known].join('、')}`)
  const title = input.title
  if (typeof title !== 'string' || !title.trim()) throw new TemplateError('title', '标题不能为空')
  if (title.length > MAX_TITLE) throw new TemplateError('title', `太长（上限 ${MAX_TITLE} 字）`)
  // 标题也逐字转义，只做与句子相同的基本检查（不允许占位符）
  parseSentence(title, 'title', {})
  if (!isObj(input.nodule)) throw new TemplateError('nodule', '应为对象，至少有 default')
  for (const k of Object.keys(input.nodule)) if (!(NODULE_CASES as readonly string[]).includes(k)) throw new TemplateError('nodule', `不认识的情况「${k}」；可用：${NODULE_CASES.join('、')}`)
  if (typeof input.nodule.default !== 'string') throw new TemplateError('nodule.default', '必须提供（没有对应情况的句子时用它）')
  const nodule = Object.fromEntries(NODULE_CASES.map(c => {
    const v = (input.nodule as Record<string, unknown>)[c]
    return [c, v === undefined || v === '' ? null : parseSentence(v as string, `nodule.${c}`, NODULE_PH)]
  })) as Record<NoduleCase, Piece[] | null>
  if (!nodule.default) throw new TemplateError('nodule.default', '不能为空')
  if (typeof input.none !== 'string' || !input.none.trim()) throw new TemplateError('none', '必须提供（没有已确认结节时的句子，如「双肺未见明确结节。」）')
  const none = parseSentence(input.none, 'none', STUDY_PH)
  const opt = (v: unknown, where: string, allowed: Record<string, PlaceholderDef>) => v === undefined || v === '' ? null : parseSentence(v as string, where, allowed)
  const comp = input.comparison
  if (comp !== undefined && !isObj(comp)) throw new TemplateError('comparison', '应为对象')
  if (comp) for (const k of Object.keys(comp)) if (!(COMPARISON_CASES as readonly string[]).includes(k)) throw new TemplateError('comparison', `不认识的情况「${k}」；可用：${COMPARISON_CASES.join('、')}`)
  const comparison = Object.fromEntries(COMPARISON_CASES.map(c => [c, opt(comp?.[c], `comparison.${c}`, STUDY_PH)])) as Record<ComparisonCase, Piece[] | null>

  const impRaw = input.impression
  let impObj: Record<string, unknown> | null = null
  if (impRaw !== undefined && impRaw !== '') {
    if (typeof impRaw === 'string') impObj = { default: impRaw }
    else if (isObj(impRaw)) impObj = impRaw
    else throw new TemplateError('impression', '应为字符串或对象（{ default, none }）')
    for (const k of Object.keys(impObj)) if (!(IMPRESSION_CASES as readonly string[]).includes(k)) throw new TemplateError('impression', `不认识的情况「${k}」；可用：${IMPRESSION_CASES.join('、')}`)
  }
  const parseImpression = (v: unknown, where: string): Piece[] | null => {
    if (v === undefined || v === '') return null
    const pieces = parseSentence(v as string, where, IMPRESSION_PH)
    if (IMPRESSION_FORBIDDEN_RE.test(v as string)) {
      throw new TemplateError(where, '影像印象段（W4.3）只作客观总结，不能写诊断结论或随访建议（如「考虑恶性」「建议随访」）')
    }
    return pieces
  }
  const impression: Record<ImpressionCase, Piece[] | null> = {
    default: parseImpression(impObj?.default, typeof impRaw === 'string' ? 'impression' : 'impression.default'),
    none: parseImpression(impObj?.none, 'impression.none'),
  }
  const normalizedImp = typeof impRaw === 'string' && impRaw
    ? impRaw
    : impObj
      ? Object.fromEntries(IMPRESSION_CASES.filter(c => typeof impObj![c] === 'string' && impObj![c]).map(c => [c, impObj![c] as string]))
      : undefined

  const body: FindingsTemplateBody = {
    title: title.trim(),
    nodule: Object.fromEntries(NODULE_CASES.filter(c => typeof (input.nodule as Record<string, unknown>)[c] === 'string' && (input.nodule as Record<string, string>)[c]).map(c => [c, (input.nodule as Record<string, string>)[c]])) as FindingsTemplateBody['nodule'],
    none: input.none,
    ...(typeof input.disappeared === 'string' && input.disappeared ? { disappeared: input.disappeared } : {}),
    ...(comp && Object.keys(comp).length ? { comparison: Object.fromEntries(COMPARISON_CASES.filter(c => typeof comp[c] === 'string' && comp[c]).map(c => [c, comp[c]])) } : {}),
    ...(normalizedImp && (typeof normalizedImp === 'string' || Object.keys(normalizedImp).length) ? { impression: normalizedImp } : {}),
    ...(typeof input.closing === 'string' && input.closing ? { closing: input.closing } : {}),
  }
  return {
    body, title: body.title, nodule, none,
    disappeared: opt(input.disappeared, 'disappeared', PRIOR_PH),
    comparison,
    impression,
    closing: opt(input.closing, 'closing', STUDY_PH),
  }
}

// —— 渲染 ——

/** 占位符的值：文字、测量原子（由调用方绑定后换成 [@m:id]），或没有值。 */
export type Value = string | { atom: string } | null
/** 渲染结果：文字与测量原子交替。 */
export type Part = { text: string } | { atom: string }

/** 按值渲染一句：可选片段里有占位符没有值（且没有缺省文字）时整段省略。 */
export function renderSentence(pieces: Piece[], values: Record<string, Value>): Part[] {
  const out: Part[] = []
  const put = (p: Part) => {
    const last = out[out.length - 1]
    if ('text' in p && last && 'text' in last) last.text += p.text
    else if (!('text' in p) || p.text) out.push({ ...p })
  }
  const valueOf = (tok: Extract<Token, { t: 'ph' }>): Part | null => {
    const v = values[tok.name] ?? null
    if (v && typeof v === 'object') return { atom: v.atom }
    if (typeof v === 'string' && v) return { text: v }
    return tok.fallback ? { text: tok.fallback } : null
  }
  for (const p of pieces) {
    if (p.t === 'text') put({ text: p.v })
    else if (p.t === 'ph') { const v = valueOf(p); if (v) put(v) }
    else {
      const parts = p.items.map(x => x.t === 'text' ? { text: x.v } as Part : valueOf(x))
      if (parts.some(x => x === null)) continue
      for (const x of parts) put(x!)
    }
  }
  // 首尾空白去掉，连续空白合一（模板与值里的空格不会变成 markdown 的缩进代码块）
  for (const p of out) if ('text' in p) p.text = p.text.replace(/\s+/g, ' ')
  const first = out[0], last = out[out.length - 1]
  if (first && 'text' in first) first.text = first.text.replace(/^\s+/, '')
  if (last && 'text' in last) last.text = last.text.replace(/\s+$/, '')
  return out.filter(p => !('text' in p) || p.text)
}

/**
 * 文字逐字转义为 markdown：所有 ASCII 标点前加反斜杠（CommonMark 允许转义任何 ASCII 标点），
 * 所以模板与病灶位置里的 `*`、`<u>`、`[@m:…]`、`{#id}`、`# `、`1. ` 都按字面显示。
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, '\\$&')
}

/** 渲染结果 → 一段 markdown（测量原子由 atomId 换成已绑定的 m_id）。 */
export function partsToMarkdown(parts: Part[], atomId: (key: string) => string): string {
  return parts.map(p => 'text' in p ? escapeMarkdown(p.text) : `[@m:${atomId(p.atom)}]`).join('')
}

/** 渲染结果的纯文字（测量原子写成 [@m:id]，与 plainText(node) 一致；核对往返用）。 */
export function partsToPlain(parts: Part[], atomId: (key: string) => string): string {
  return parts.map(p => 'text' in p ? p.text : `[@m:${atomId(p.atom)}]`).join('')
}
