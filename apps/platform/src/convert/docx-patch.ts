/**
 * 改过的段落按原始 XML「打补丁」导出：只改动变化的文字，原段落里模型表达不了的内容（书签、符号、软连字符、
 * 文字格式、字符样式、注音、公式、编辑权限、内容控件、智能标记、批注范围、修订……）原样留在原处。
 *
 * 做法：把原始段落拆成与导入时完全一致的「文字记号」序列（字符、制表符、换行、域 / 脚注等原子），
 * 与导入时的模型逐个核对；再对比导入时与现在的段落（字符 + 格式标记），对原始 run 做最小改动：
 * 删掉的字符从 w:t 里去掉，新增的文字以相邻 run 的格式插入（如同在 Word 里打字）。
 * 核对不上或遇到处理不了的情况（图、链接边界变化、平台新建的批注……）返回 null，由调用方按原方式重新生成。
 */
import type { Mark, Node as PMNode } from 'prosemirror-model'
import { elementChildrenRaw } from './docx-import.ts'

/** 导出器提供的渲染函数。 */
export interface PatchRender {
  /** 新增文字的 run 属性：base 为相邻 run 的 rPr 子元素原文（已去掉由格式标记表达的属性）。 */
  runs(text: string, marks: readonly Mark[], base: string): string
  /** 新增的原子（引用、Word 行内原子、换行）。 */
  atom(node: PMNode, base: string): string | null
  /** 这个格式标记能否打补丁（平台新建的批注线程须重新生成范围标记 → 不能）。 */
  markOk(mark: Mark): boolean
  /** 段落里嵌着的图（导入时拆成了其后的图块）原样留在原处：调用方已确认这些图块仍原样紧跟在后面。 */
  drawings?: boolean
}

// —— 记号 ——

/** 一个记号：字符（含 \t）或原子（br、Word 行内原子、引用）。sig 用于对比（含格式标记）。 */
interface Tok { sig: string; text: string | null; node: PMNode | null; marks: readonly Mark[]; link: boolean }

const MARKED = new Set(['bold', 'italic', 'underline', 'sup', 'sub', 'code', 'link'])
const markSig = (marks: readonly Mark[]) => marks.filter(m => MARKED.has(m.type.name)).map(m => m.type.name === 'link' ? `link:${m.attrs.href}` : m.type.name).sort().join('+')

function modelTokens(node: PMNode): Tok[] | null {
  const out: Tok[] = []
  let ok = true
  node.forEach(child => {
    const link = child.marks.some(m => m.type.name === 'link')
    if (child.isText) {
      const ms = markSig(child.marks)
      for (const ch of child.text!) out.push({ sig: `${ch}|${ms}`, text: ch, node: null, marks: child.marks, link })
    } else if (child.type.name === 'hard_break') out.push({ sig: '⏎', text: null, node: child, marks: child.marks, link })
    else if (child.type.name === 'word_inline') out.push({ sig: `@w:${child.attrs.key}|${markSig(child.marks)}`, text: null, node: child, marks: child.marks, link })
    else if (child.type.name === 'citation') out.push({ sig: `@c:${child.attrs.cite_id}`, text: null, node: child, marks: child.marks, link })
    else ok = false
  })
  return ok ? out : null
}

// —— 原始段落的结构 ——

type Part = { k: 'keep'; xml: string } | { k: 'text'; s: string; tok: number; xml: string } | { k: 'tab'; tok: number; xml: string } | { k: 'br'; tok: number; xml: string }
type RNode =
  | { k: 'keep'; xml: string }
  | { k: 'atom'; xml: string; tok: number }
  | { k: 'run'; open: string; rPr: string; parts: Part[] }
  | { k: 'box'; open: string; close: string; kids: RNode[]; link: boolean; frozen: boolean }

const unesc = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_m, e: string) =>
  e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))))
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const tagOf = (el: string) => /^<([\w.-]+:[\w.-]+|[\w.-]+)/.exec(el)?.[1] ?? ''
const openTag = (el: string) => /^<[^>]*>/.exec(el)![0]
const closeTag = (el: string) => `</${tagOf(el)}>`
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

/**
 * 按导入的规则（docx-import 的 inlineOf / runOf，接受全部修订）拆原始段落；
 * tokens 收集每个记号的原文字符或原子类别，供与导入时的模型核对。不能处理时返回 null。
 */
function parse(raw: string, drawings: boolean): { tree: RNode[]; kinds: string[] } | null {
  const kinds: string[] = []
  let bad = false
  const walk = (inner: string[]): RNode[] => {
    const out: RNode[] = []
    for (let i = 0; i < inner.length; i++) {
      const el = inner[i]!
      const tag = tagOf(el)
      // 复杂域：从 begin 到配对的 end（可跨多个兄弟元素）整体为一个原子
      if (tag === 'w:r' && /w:fldCharType="begin"/.test(el)) {
        let depth = 0
        let end = -1
        for (let j = i; j < inner.length; j++) {
          depth += count(inner[j]!, /w:fldCharType="begin"/g) - count(inner[j]!, /w:fldCharType="end"/g)
          if (depth <= 0) { end = j; break }
        }
        if (end >= 0) {
          out.push({ k: 'atom', xml: inner.slice(i, end + 1).join(''), tok: kinds.push('field') - 1 })
          i = end
          continue
        }
        bad = true
      }
      switch (tag) {
        case 'w:r': {
          if (/<w:(footnoteReference|endnoteReference)\b/.test(el)) { out.push({ k: 'atom', xml: el, tok: kinds.push('note') - 1 }); break }
          // 文本框、图表、形状、嵌入对象：导入时整个 run 是一个对象原子（与 docx-import 的 isObjectRun 一致）
          if (/<w:object\b|<mc:AlternateContent\b/.test(el) || (/<w:(drawing|pict)\b/.test(el) && !/<a:blip\b/.test(el))) { out.push({ k: 'atom', xml: el, tok: kinds.push('object') - 1 }); break }
          if (!drawings && /<w:(drawing|pict)\b/.test(el)) { bad = true; break }
          const kids = elementChildrenRaw(el)
          const rPr = kids.find(k => tagOf(k) === 'w:rPr') ?? ''
          const parts: Part[] = []
          for (const k of kids) {
            const t = tagOf(k)
            if (t === 'w:rPr') continue
            if (t === 'w:t') {
              const s = unesc(/^<w:t\b[^>]*\/>$/.test(k) ? '' : k.replace(/^<w:t\b[^>]*>/, '').replace(/<\/w:t>$/, ''))
              if (s) { parts.push({ k: 'text', s, tok: kinds.length, xml: k }); for (const ch of s) kinds.push(`t:${ch}`) }
            } else if (t === 'w:tab') parts.push({ k: 'tab', tok: kinds.push('t:\t') - 1, xml: k })
            else if (t === 'w:br' || t === 'w:cr') parts.push({ k: 'br', tok: kinds.push('br') - 1, xml: k })
            else if (t === 'w:fldChar') { bad = true; parts.push({ k: 'keep', xml: k }) }
            else parts.push({ k: 'keep', xml: k })
          }
          out.push({ k: 'run', open: openTag(el), rPr, parts })
          break
        }
        case 'w:fldSimple': out.push({ k: 'atom', xml: el, tok: kinds.push('field') - 1 }); break
        case 'w:hyperlink': case 'w:smartTag': case 'w:customXml': case 'w:ins': case 'w:moveTo':
          // 修订容器（别人的插入 / 移入）冻结：里面的文字不能改，新文字也不能放进去（否则算成别人的修订）
          out.push({ k: 'box', open: openTag(el), close: closeTag(el), kids: /\/>$/.test(openTag(el)) ? [] : walk(elementChildrenRaw(el)), link: tag === 'w:hyperlink', frozen: tag === 'w:ins' || tag === 'w:moveTo' })
          break
        case 'w:sdt': {
          // 内容控件：控件属性原样保留，只拆 sdtContent 里的内容
          const kids = elementChildrenRaw(el)
          const content = kids.find(k => tagOf(k) === 'w:sdtContent')
          if (!content) { out.push({ k: 'keep', xml: el }); break }
          const before = kids.slice(0, kids.indexOf(content)).join('')
          const after = kids.slice(kids.indexOf(content) + 1).join('')
          out.push({ k: 'box', open: `${openTag(el)}${before}${openTag(content)}`, close: `${closeTag(content)}${after}${closeTag(el)}`, kids: walk(elementChildrenRaw(content)), link: false, frozen: false })
          break
        }
        default:
          // 段落层级的兼容内容（文本框等）：导入时是对象原子
          if (tag === 'mc:AlternateContent') { out.push({ k: 'atom', xml: el, tok: kinds.push('object') - 1 }); break }
          // 段落属性、书签、批注范围、校对标记、编辑权限、公式、删除的修订……：不是文字，原样保留
          out.push({ k: 'keep', xml: el })
      }
    }
    return out
  }
  const tree = walk(elementChildrenRaw(raw))
  return bad ? null : { tree, kinds }
}

// —— 对比 ——

/**
 * 最长公共子序列对齐，再做语义清理（同 diff-match-patch 的 cleanupSemantic）：夹在两处改动之间、不长于两侧改动的
 * 短相同片段并入改动，免得一个词被拆成零碎的保留字符与插入字符。
 * 返回 keep[i]：原记号 i 是否保留；ins[i]：插在原记号 i 之前的新记号（替换的新文字放在被删文字的位置，ins[n] 在末尾）。
 */
function align(a: string[], b: string[]): { keep: boolean[]; ins: number[][] } | null {
  const n = a.length
  const m = b.length
  let pre = 0
  while (pre < n && pre < m && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++
  const p = n - pre - suf
  const q = m - pre - suf
  if (p * q > 16_000_000) return null
  // dp[i][j]：a[pre+i..] 与 b[pre+j..] 中间部分的 LCS 长度
  const dp = new Uint32Array((p + 1) * (q + 1))
  const at = (i: number, j: number) => i * (q + 1) + j
  for (let i = p - 1; i >= 0; i--) for (let j = q - 1; j >= 0; j--) dp[at(i, j)] = a[pre + i] === b[pre + j] ? dp[at(i + 1, j + 1)]! + 1 : Math.max(dp[at(i + 1, j)]!, dp[at(i, j + 1)]!)
  let pairs: Array<[number, number]> = []
  for (let k = 0; k < pre; k++) pairs.push([k, k])
  for (let i = 0, j = 0; i < p && j < q;) {
    if (a[pre + i] === b[pre + j]) { pairs.push([pre + i, pre + j]); i++; j++ }
    else if (dp[at(i, j + 1)]! >= dp[at(i + 1, j)]!) j++
    else i++
  }
  for (let k = 0; k < suf; k++) pairs.push([n - suf + k, m - suf + k])
  // 语义清理：把对齐分成连续相同的片段，短片段两侧的改动都不比它短时去掉，反复到不再变化
  for (let changed = true; changed;) {
    changed = false
    const segs: Array<{ from: number; to: number }> = []
    for (let k = 0; k < pairs.length; k++) {
      const last = segs.at(-1)
      if (last && pairs[k]![0] === pairs[k - 1]![0] + 1 && pairs[k]![1] === pairs[k - 1]![1] + 1) last.to = k
      else segs.push({ from: k, to: k })
    }
    const edit = (x: [number, number] | undefined, y: [number, number] | undefined) =>
      Math.max((y ? y[0] : n) - (x ? x[0] + 1 : 0), (y ? y[1] : m) - (x ? x[1] + 1 : 0))
    const drop = new Set<number>()
    segs.forEach((sg, k) => {
      const len = sg.to - sg.from + 1
      const before = edit(k > 0 ? pairs[segs[k - 1]!.to] : undefined, pairs[sg.from])
      const after = edit(pairs[sg.to], k + 1 < segs.length ? pairs[segs[k + 1]!.from] : undefined)
      if (before > 0 && after > 0 && len <= before && len <= after) for (let x = sg.from; x <= sg.to; x++) drop.add(x)
    })
    if (drop.size) { pairs = pairs.filter((_x, k) => !drop.has(k)); changed = true }
  }
  const keep = new Array<boolean>(n).fill(false)
  const ins: number[][] = Array.from({ length: n + 1 }, () => [])
  let pi = -1
  let pj = -1
  for (const [i, j] of [...pairs, [n, m] as [number, number]]) {
    // 两个相邻匹配之间：原记号 pi+1..i-1 被删，新记号 pj+1..j-1 插入，放在被删文字的位置
    for (let x = pj + 1; x < j; x++) ins[pi + 1]!.push(x)
    if (i < n) keep[i] = true
    pi = i
    pj = j
  }
  return { keep, ins }
}

// —— 生成 ——

const MARK_PROPS = ['b', 'bCs', 'i', 'iCs', 'u', 'vertAlign', 'rStyle', 'rPrChange', 'ins', 'del']
const stripMarkProps = (rPr: string) => elementChildrenRaw(rPr || '<w:rPr/>').filter(k => !MARK_PROPS.some(n => new RegExp(`^<w:${n}\\b`).test(k))).join('')

/**
 * 原始段落 raw（导入时的 XML）、导入时的模型 before、现在的模型 after → 打过补丁的段落 XML；不能打补丁返回 null。
 * 段落属性（pPr）原样沿用：调用方须保证块类型、样式、对齐等属性没有变化。
 */
export function patchParagraph(raw: string, before: PMNode, after: PMNode, render: PatchRender): string | null {
  if (!/^<w:p\b/.test(raw)) return null
  const parsed = /^<w:p\b[^>]*\/>$/.test(raw) ? { tree: [] as RNode[], kinds: [] as string[] } : parse(raw, !!render.drawings)
  if (!parsed) return null
  const old = modelTokens(before)
  const now = modelTokens(after)
  if (!old || !now) return null
  for (const n of [before, after]) {
    let ok = true
    n.descendants(c => { if (c.marks.some(m => !render.markOk(m))) ok = false; return ok })
    if (!ok) return null
  }
  // 与导入时的模型逐个核对（字符一致、原子类别一致）
  if (parsed.kinds.length !== old.length) return null
  for (let i = 0; i < old.length; i++) {
    const k = parsed.kinds[i]!
    const o = old[i]!
    const same = k.startsWith('t:') ? o.text === k.slice(2) : k === 'br' ? o.node?.type.name === 'hard_break' : o.node?.type.name === 'word_inline'
    if (!same) return null
  }
  const plan = align(old.map(t => t.sig), now.map(t => t.sig))
  if (!plan) return null
  const { keep, ins } = plan
  const total = old.length

  let firstRPr: string | null = null
  const findRPr = (nodes: RNode[]): void => { for (const n of nodes) { if (firstRPr !== null) return; if (n.k === 'run') firstRPr = n.rPr; else if (n.k === 'box') findRPr(n.kids) } }
  findRPr(parsed.tree)
  let lastRPr: string = firstRPr ?? ''
  let failed = false

  /** 新增的记号（在 link 容器里 / 外须与记号的链接标记一致，否则放弃补丁）。 */
  const inserted = (idx: number[], inLink: boolean): string => {
    let out = ''
    let buf = ''
    let bufMarks: readonly Mark[] = []
    const base = stripMarkProps(lastRPr)
    const flush = () => { if (buf) out += render.runs(buf, bufMarks.filter(m => m.type.name !== 'link'), base); buf = '' }
    for (const j of idx) {
      const t = now[j]!
      if (t.link !== inLink) failed = true
      if (t.text !== null) {
        if (buf && markSig(bufMarks) !== markSig(t.marks)) flush()
        bufMarks = t.marks
        buf += t.text
      } else {
        flush()
        const xml = render.atom(t.node!, base)
        if (xml === null) failed = true
        else out += xml
      }
    }
    flush()
    return out
  }

  const emit = (nodes: RNode[], inLink: boolean): string => {
    let out = ''
    for (const n of nodes) {
      if (n.k === 'keep') out += n.xml
      else if (n.k === 'box' && n.frozen) {
        // 冻结的修订容器：里面的记号须全部保留、中间不能插入；紧贴容器开头 / 末尾的新内容放在容器外
        const toks: number[] = []
        const collect = (xs: RNode[]) => { for (const x of xs) { if (x.k === 'atom') toks.push(x.tok); else if (x.k === 'box') collect(x.kids); else if (x.k === 'run') for (const part of x.parts) if (part.k === 'text') for (let c = 0; c < [...part.s].length; c++) toks.push(part.tok + c); else if (part.k !== 'keep') toks.push(part.tok) } }
        collect(n.kids)
        if (toks.length === 0) { out += `${n.open}${emit(n.kids, inLink)}${n.close}`; continue }
        const t0 = toks[0]!
        const t1 = toks.at(-1)!
        if (toks.some(t => !keep[t]) || toks.slice(1).some(t => ins[t]!.length > 0)) { failed = true; continue }
        if (ins[t0]!.length) { out += inserted(ins[t0]!, inLink); ins[t0] = [] }
        const tail = t1 === total - 1 ? ins[total]! : []
        if (tail.length) ins[total] = []
        out += `${n.open}${emit(n.kids, inLink)}${n.close}`
        if (tail.length) out += inserted(tail, inLink)
      }
      else if (n.k === 'box') out += `${n.open}${emit(n.kids, inLink || n.link)}${n.close}`
      else if (n.k === 'atom') {
        if (ins[n.tok]!.length) out += inserted(ins[n.tok]!, inLink)
        if (keep[n.tok]) out += n.xml
        if (n.tok === total - 1 && ins[total]!.length) out += inserted(ins[total]!, inLink)
      } else {
        lastRPr = n.rPr
        // 一个原始 run 可能被插入的内容切成几段：每段沿用原 run 的开标签与属性。
        // 新文字的格式与本 run 相同时直接写进本 run（如同在 Word 里打字），否则另起 run
        const firstText = n.parts.find(x => x.k === 'text') as { tok: number } | undefined
        const runSig = firstText ? markSig(old[firstText.tok]!.marks) : null
        let seg = ''
        let has = false
        let text = ''
        const flushText = () => { if (text) { seg += `<w:t xml:space="preserve">${esc(text)}</w:t>`; has = true; text = '' } }
        const close = () => { flushText(); if (has || seg) out += `${n.open}${n.rPr}${seg}</w:r>`; seg = ''; has = false }
        const put = (idx: number[]) => {
          let other: number[] = []
          const spill = () => { if (other.length) { close(); out += inserted(other, inLink); lastRPr = n.rPr; other = [] } }
          for (const j of idx) {
            const t = now[j]!
            if (t.text !== null && t.text !== '\t' && runSig !== null && markSig(t.marks) === runSig && t.link === inLink) { spill(); text += t.text }
            else other.push(j)
          }
          spill()
        }
        const before = (tok: number) => { if (ins[tok]!.length) put(ins[tok]!) }
        const after = (tok: number) => { if (tok === total - 1 && ins[total]!.length) put(ins[total]!) }
        for (const part of n.parts) {
          if (part.k === 'keep') { flushText(); seg += part.xml; has = true; continue }
          if (part.k === 'tab' || part.k === 'br') {
            before(part.tok)
            flushText()
            if (keep[part.tok]) { seg += part.xml; has = true }
            after(part.tok)
            continue
          }
          const chars = [...part.s]
          // 整段文字没动（全部保留、前后与中间都没有插入）：原 w:t 原样写回
          const untouched = !text && chars.every((_ch, c) => keep[part.tok + c] && !ins[part.tok + c]!.length) && !(part.tok + chars.length - 1 === total - 1 && ins[total]!.length)
          if (untouched) {
            seg += part.xml
            has = true
            continue
          }
          chars.forEach((ch, c) => {
            const tok = part.tok + c
            before(tok)
            if (keep[tok]) text += ch
            after(tok)
          })
          flushText()
        }
        close()
      }
    }
    return out
  }
  const open = openTag(raw)
  let body = /\/>$/.test(open) ? '' : emit(parsed.tree, false)
  if (total === 0 && ins[0]!.length) {
    // 原来是空段落：新文字加在段落末尾（段落属性之后）
    body += inserted(ins[0]!, false)
  }
  if (failed) return null
  return /\/>$/.test(open) ? `${open.replace(/\/>$/, '>')}${body}</w:p>` : `${open}${body}</w:p>`
}
