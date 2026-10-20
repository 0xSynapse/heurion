import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import { assignIds, indexById, stripIds } from '../model/ids.ts'
import { MarkdownError, parseBlocks, parseCell, parseInline, serializeBlock } from '../model/markdown.ts'
import { colWidths, schema } from '../model/schema.ts'
import { buildFromGrid, readGrid, type Grid, type GridCell } from '../model/table-grid.ts'
import { OpError, type DocOp } from './types.ts'

export interface OpResult {
  op_index: number
  op: DocOp['op']
  /** 新增块的 id，或被修改 / 移动的块 id。 */
  ids: string[]
}

export interface ApplyContext {
  /** 文档里已占用的 id（新分配的 id 会加入）。 */
  taken: Set<string>
  /** base_rev 之后被用户改过的块 id（AI 整章替换时不静默覆盖这些块）。 */
  userEditedIds?: Set<string>
}

/**
 * 在内存里把一批操作应用到文档上（纯函数，不落库）。任何一个 op 失败即抛 OpError，
 * 调用方整批放弃（原子性）。
 */
export function applyOps(doc: PMNode, ops: DocOp[], ctx: ApplyContext): { doc: PMNode; results: OpResult[] } {
  const tr = new Transform(doc)
  const results: OpResult[] = []
  const targetedIds = new Set<string>()
  for (const op of ops) {
    switch (op.op) {
      case 'insert_after':
      case 'insert_before':
        targetedIds.add(op.anchor_id)
        break
      case 'replace_block':
      case 'replace_text':
      case 'set_block_style':
      case 'set_text_style':
      case 'table_set_cells':
      case 'table_insert_rows':
      case 'table_delete_rows':
      case 'table_insert_cols':
      case 'table_delete_cols':
      case 'table_merge_cells':
      case 'table_split_cell':
      case 'table_set_header':
      case 'table_set_style':
        targetedIds.add(op.id)
        break
      case 'delete':
        for (const id of op.ids) targetedIds.add(id)
        break
      case 'move':
        for (const id of op.ids) targetedIds.add(id)
        if (op.after) targetedIds.add(op.after)
        break
    }
  }
  ops.forEach((op, index) => {
    try {
      results.push({ op_index: index, op: op.op, ids: applyOne(tr, op, ctx, targetedIds) })
    } catch (err) {
      if (err instanceof OpError) throw new OpError(err.code, err.message, { op_index: index, ...err.extra })
      if (err instanceof MarkdownError) throw new OpError('invalid_markdown', err.message, { op_index: index })
      throw new OpError('invalid_structure', `操作无法应用：${(err as Error).message}`, { op_index: index })
    }
  })
  restoreWordInlines(doc, tr)
  try {
    tr.doc.check()
  } catch (err) {
    throw new OpError('invalid_structure', `操作后的文档结构不合法：${(err as Error).message}`)
  }
  return { doc: tr.doc, results }
}

function find(tr: Transform, id: string): { node: PMNode; pos: number } {
  const hit = indexById(tr.doc).get(id)
  if (!hit) {
    throw new OpError('node_not_found', `找不到块 ${id}`, { hint: '先用 doc_outline / doc_read 获取当前的块 id；id 区分大小写，不要自己编造。' })
  }
  return hit
}

function parseNew(markdown: string, taken: Set<string>): PMNode[] {
  return parseBlocks(markdown).map(n => assignIds(stripIds(n), taken))
}

function topIds(nodes: readonly PMNode[]): string[] {
  return nodes.map(n => n.attrs.id as string).filter(Boolean)
}

function normalizeHeadingTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function applyOne(tr: Transform, op: DocOp, ctx: ApplyContext, targetedIds: Set<string>): string[] {
  switch (op.op) {
    case 'insert_after':
    case 'insert_before':
      return insert(tr, op.anchor_id, op.markdown, op.op === 'insert_after', ctx)
    case 'replace_block':
      return replaceBlock(tr, op.id, op.markdown, ctx, targetedIds)
    case 'replace_text':
      return replaceText(tr, op)
    case 'delete':
      for (const id of op.ids) deleteBlock(tr, id, ctx)
      return op.ids
    case 'move':
      return move(tr, op.ids, op.after)
    case 'set_block_style':
      return setStyle(tr, op)
    case 'set_text_style':
      return setTextStyle(tr, op)
    case 'table_set_cells':
    case 'table_insert_rows':
    case 'table_delete_rows':
    case 'table_insert_cols':
    case 'table_delete_cols':
    case 'table_merge_cells':
    case 'table_split_cell':
    case 'table_set_header':
    case 'table_set_style':
      return tableOp(tr, op, ctx)
  }
}

function insert(tr: Transform, anchorId: string, markdown: string, after: boolean, ctx: ApplyContext): string[] {
  const anchor = find(tr, anchorId)
  let nodes = parseNew(markdown, ctx.taken)
  if (nodes.length === 0) throw new OpError('invalid_markdown', 'markdown 解析后为空')
  const $pos = tr.doc.resolve(anchor.pos)
  const parent = $pos.parent
  const index = $pos.index()
  // 锚点是标题且在标题后插入多块内容时，若 AI 把同名同级标题重复写在开头，自动去掉首块避免重复章节标题
  if (
    after &&
    anchor.node.type.name === 'heading' &&
    nodes.length > 1 &&
    nodes[0]!.type.name === 'heading' &&
    nodes[0]!.attrs.level === anchor.node.attrs.level &&
    normalizeHeadingTitle(nodes[0]!.textContent) === normalizeHeadingTitle(anchor.node.textContent)
  ) {
    ctx.taken.delete(nodes[0]!.attrs.id as string)
    nodes = nodes.slice(1)
  }
  // 锚点是列表项、内容是一个列表 → 插入其中的列表项
  if (anchor.node.type.name === 'list_item' && nodes.length === 1 && /_list$/.test(nodes[0]!.type.name)) {
    const items: PMNode[] = []
    nodes[0]!.forEach(c => items.push(c))
    nodes = items
  }
  const at = after ? index + 1 : index
  const fragment = Fragment.from(nodes)
  if (!parent.canReplace(at, at, fragment)) {
    throw new OpError('invalid_structure', `不能把这些内容插在 ${anchorId} ${after ? '之后' : '之前'}`, {
      hint: anchor.node.type.name === 'list_item'
        ? '锚点是列表项：插入列表项请用 "- 内容" 形式；要在整个列表前后插入段落，请用列表本身的 id。'
        : '检查锚点所在的容器（如表格单元格、列表项）是否接受该类型的块。',
    })
  }
  tr.insert(after ? anchor.pos + anchor.node.nodeSize : anchor.pos, fragment)
  return topIds(nodes)
}

function replaceBlock(tr: Transform, id: string, markdown: string, ctx: ApplyContext, targetedIds: Set<string>): string[] {
  const target = find(tr, id)
  if (target.node.type.name === 'opaque') {
    throw new OpError('node_not_editable', `块 ${id} 是不可编辑内容（${target.node.attrs.description}）`, { hint: '不可编辑块只能移动或删除。' })
  }
  let nodes = parseNew(markdown, ctx.taken)
  if (target.node.type.name === 'list_item' && nodes.length === 1 && /_list$/.test(nodes[0]!.type.name)) {
    const items: PMNode[] = []
    nodes[0]!.forEach(c => items.push(c))
    nodes = items
  }
  // 第一个块沿用原 id（同类可互换：段落 ↔ 标题）
  if (nodes.length > 0) {
    const first = nodes[0]!
    const compatible = first.type === target.node.type || (first.isTextblock && target.node.isTextblock)
    if (compatible) {
      ctx.taken.delete(first.attrs.id as string)
      const attrs: Record<string, unknown> = { ...first.attrs, id }
      // 保留原段落样式与对齐（markdown 不表达）
      if (target.node.isTextblock && first.type === target.node.type) {
        attrs.style = target.node.attrs.style
        attrs.align = target.node.attrs.align
      }
      nodes[0] = first.type.create(attrs, first.content, first.marks)
    }
  }
  const $pos = tr.doc.resolve(target.pos)
  const index = $pos.index()

  // 当目标块是顶层章节标题且替换内容是以同级标题开头的多块章节全文时，
  // 若该章节原有的正文块未被同批次其他操作显式引用，则一并替换该章节正文，防止残留旧章节导致章节重复。
  let replaceEndIndex = index + 1
  let replaceEndPos = target.pos + target.node.nodeSize
  if (
    $pos.depth === 0 &&
    target.node.type.name === 'heading' &&
    nodes.length > 1 &&
    nodes[0]!.type.name === 'heading' &&
    nodes[0]!.attrs.level === target.node.attrs.level
  ) {
    const parent = $pos.parent
    const level = target.node.attrs.level as number
    const hasSubheadings = nodes.slice(1).some(n => n.type.name === 'heading')
    const newHeadingTitles = new Set(
      nodes
        .slice(1)
        .filter(n => n.type.name === 'heading')
        .map(n => `${n.attrs.level}:${normalizeHeadingTitle(n.textContent)}`),
    )
    let scanIdx = index + 1
    let scanPos = replaceEndPos
    let canAbsorb = true
    while (scanIdx < parent.childCount) {
      const sib = parent.child(scanIdx)
      if (sib.type.name === 'heading') {
        const sibLevel = sib.attrs.level as number
        const sibKey = `${sibLevel}:${normalizeHeadingTitle(sib.textContent)}`
        if (sibLevel <= level) {
          if (!newHeadingTitles.has(sibKey)) break
        } else if (!hasSubheadings) {
          break
        }
      }
      // 这一节里有待采纳的修订：整节替换会只换标题、留下旧正文，新旧两份并存——拒绝，先让用户处理修订
      if (sib.attrs.suggest) {
        throw new OpError('pending_suggestion', `章节 ${target.node.attrs.id} 里有待采纳的修订，不能整节替换`, {
          hint: '这一节有还没采纳的修订。请先在回复里请用户采纳或拒绝，或只改具体段落（修订版的块可以直接改）。',
        })
      }
      let bad = sib.type.name === 'opaque'
      sib.descendants(d => {
        const did = d.attrs.id as string | null
        if (did && (targetedIds.has(did) || ctx.userEditedIds?.has(did))) bad = true
        if (d.marks.some(m => m.type.name === 'comment')) bad = true
        return !bad
      })
      const sid = sib.attrs.id as string | null
      if (sid && (targetedIds.has(sid) || ctx.userEditedIds?.has(sid))) bad = true
      if (bad) {
        canAbsorb = false
        break
      }
      scanPos += sib.nodeSize
      scanIdx++
    }
    if (canAbsorb && scanIdx > index + 1) {
      replaceEndIndex = scanIdx
      replaceEndPos = scanPos
    }
  }

  const fragment = Fragment.from(nodes)
  if (!$pos.parent.canReplace(index, replaceEndIndex, fragment)) {
    throw new OpError('invalid_structure', `块 ${id} 不能替换成这些内容`, {
      hint: nodes.length === 0 ? '替换为空会让容器变空；要删除请用 delete。' : '检查块类型是否适合所在容器。',
    })
  }
  tr.replaceWith(target.pos, replaceEndPos, fragment)
  return topIds(nodes)
}

/** 块内字符 → 文档位置的映射。citation 以 `[@c:id]`、Word 行内结构以 `[@w:key]` 参与匹配（同按引用标记处理），hard_break 记作换行。 */
function textMap(node: PMNode, nodePos: number): { text: string; from: number[]; to: number[]; marks: Array<readonly Mark[]>; cite: boolean[] } {
  let text = ''
  const from: number[] = []
  const to: number[] = []
  const marks: Array<readonly Mark[]> = []
  const cite: boolean[] = []
  node.forEach((child, offset) => {
    const start = nodePos + 1 + offset
    if (child.isText) {
      for (let i = 0; i < child.text!.length; i++) {
        text += child.text![i]
        from.push(start + i)
        to.push(start + i + 1)
        marks.push(child.marks)
        cite.push(false)
      }
    } else {
      const marker = child.type.name === 'citation' || child.type.name === 'word_inline'
      const s = child.type.name === 'citation' ? `[@c:${child.attrs.cite_id}]`
        : child.type.name === 'word_inline' ? `[@w:${child.attrs.key}]`
          : child.type.name === 'hard_break' ? '\n' : '￼'
      for (const ch of s) {
        text += ch
        from.push(start)
        to.push(start + child.nodeSize)
        marks.push(child.marks)
        cite.push(marker)
      }
    }
  })
  return { text, from, to, marks, cite }
}

/** 去掉引用标记后的文字，index[i] = 去标记文字第 i 个字符在原映射里的下标。 */
function stripCitations(map: ReturnType<typeof textMap>): { text: string; index: number[] } {
  let text = ''
  const index: number[] = []
  for (let i = 0; i < map.text.length; i++) {
    if (map.cite[i]) continue
    text += map.text[i]
    index.push(i)
  }
  return { text, index }
}

/**
 * find 跨过了引用标记、而 replace 只是在 find 前 / 后追加文字时：不动原文（保留引用），
 * 只把追加的部分插到匹配处之后 / 之前。处理不了返回 false。
 */
function appendAcrossCitation(tr: Transform, map: ReturnType<typeof textMap>, op: ReplaceArgs, parse: InlineParser): boolean {
  const stripped = stripCitations(map)
  for (const v of findVariants(op.find)) {
    const find = v.replace(/\[@[cw]:[a-z0-9]+\]/g, '')
    if (!find) continue
    const hits = allIndexes(stripped.text, find)
    if (hits.length === 0) continue
    if (hits.length > 1 && op.occurrence === undefined) return false
    const at = hits[(op.occurrence ?? 1) - 1]
    if (at === undefined) return false
    const startIdx = stripped.index[at]!
    const endIdx = stripped.index[at + find.length - 1]!
    let addition: string | null = null
    let after = true
    if (op.replace.startsWith(v)) addition = op.replace.slice(v.length)
    else if (op.replace.endsWith(v)) { addition = op.replace.slice(0, op.replace.length - v.length); after = false }
    if (addition === null || !addition) return false
    const base = map.marks[after ? endIdx : startIdx]!.filter(m => m.type.name !== 'comment')
    const inline = parse(addition).map(n => {
      let set = n.marks
      for (const m of base) if (!m.isInSet(set)) set = m.addToSet(set)
      return n.isText ? n.mark(set) : n
    })
    // 插在匹配末尾所在位置之后（若末尾紧跟引用，插在引用之后）
    let pos = after ? map.to[endIdx]! : map.from[startIdx]!
    if (after) for (let i = endIdx + 1; i < map.text.length && map.cite[i]; i++) pos = map.to[i]!
    tr.insert(pos, inline)
    return true
  }
  return false
}

function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = []
  if (!needle) return out // 空串会在末尾原地打转
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i)
  return out
}

/** find 的候选写法：原样 → 去 markdown 转义与 <br> → 去强调符号。 */
function findVariants(find: string): string[] {
  const unescaped = find.replace(/<br\s*\/?>/gi, '\n').replace(/\\([\\*_`[\]<>])/g, '$1').replace(/&lt;/g, '<')
  const plain = unescaped.replace(/\*\*|__|(?<![\w*])\*(?!\s)|(?<!\s)\*(?![\w*])/g, '')
  // 「**」这类只有强调符号的 find 去掉符号后是空串：不能当作匹配词
  return [...new Set([find, unescaped, plain])].filter(v => v.length > 0)
}

export type InlineParser = (markdown: string) => PMNode[]
export interface ReplaceArgs { find: string; replace: string; occurrence?: number }

/** 原文失配时给模型的候选（PLATFORM.md §5.3，参照 Claude Docs 的 near / matches）。 */
export interface MatchCandidate {
  occurrence?: number
  /** 文档里实际的写法。 */
  text: string
  before: string
  after: string
  /** 与 find 的差别：whitespace 空白不同 / case 大小写不同 / citation 中间隔着引用标记。 */
  how?: 'whitespace' | 'case' | 'citation'
}

export type ReplaceOutcome =
  | { ok: true }
  | { ok: false; code: 'text_not_found'; near: MatchCandidate[] }
  | { ok: false; code: 'ambiguous_match'; matches: MatchCandidate[] }
  | { ok: false; code: 'occurrence_out_of_range'; matches: MatchCandidate[] }

const CONTEXT = 12
const context = (text: string, start: number, length: number, extra: Partial<MatchCandidate> = {}): MatchCandidate => ({
  text: text.slice(start, start + length),
  before: text.slice(Math.max(0, start - CONTEXT), start),
  after: text.slice(start + length, start + length + CONTEXT),
  ...extra,
})

/** 一个「内容单位」：一个字符或一个行内原子（引用、换行），带上非评论格式，用于新旧对比。 */
interface Unit { key: string; from: number; to: number; marks: readonly Mark[] }

function marksKey(marks: readonly Mark[]): string {
  return marks.filter(m => m.type.name !== 'comment').map(m => `${m.type.name}${JSON.stringify(m.attrs)}`).sort().join('|')
}

/** 旧内容：匹配范围内的单位（引用的多个字符合成一个单位）。 */
function oldUnits(tr: Transform, map: ReturnType<typeof textMap>, start: number, end: number): Unit[] {
  const out: Unit[] = []
  for (let i = start; i <= end; i++) {
    if (i > start && map.from[i] === map.from[i - 1]) continue // 同一个原子
    const atom = map.from[i]! + 1 !== map.to[i]! || map.cite[i] || map.text[i] === '\n'
    const node = atom ? tr.doc.nodeAt(map.from[i]!) : null
    const key = node && !node.isText
      ? atomKey(node)
      : `t:${map.text[i]}|${marksKey(map.marks[i]!)}`
    out.push({ key, from: map.from[i]!, to: map.to[i]!, marks: map.marks[i]! })
  }
  return out
}

/**
 * 新内容：解析出的行内节点逐单位展开（文字逐 UTF-16 码元、原子一个），位置即 Fragment 内偏移。
 * 必须按码元而不是按字符（for…of 会把 emoji 等代理对当一个）：旧内容与 ProseMirror 位置都按码元计。
 */
function newUnits(nodes: readonly PMNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.isText) for (let i = 0; i < n.text!.length; i++) out.push(`t:${n.text![i]}|${marksKey(n.marks)}`)
    else out.push(atomKey(n))
  }
  return out
}

/** 行内原子的比较键。Word 行内结构只认 key：解析出的新节点只带 key，原始内容在整批操作后补回。 */
function atomKey(n: PMNode): string {
  return n.type.name === 'word_inline' ? `atom:word_inline:${n.attrs.key}` : `atom:${n.type.name}${JSON.stringify(n.attrs)}`
}

/**
 * 写入内容里的 `[@w:key]` 只带 key：按 key 从原文档补回脚注引用 / 域代码的原始内容；
 * 原文档里没有这个 key（模型编造或拼错）时整批拒绝。
 */
function restoreWordInlines(before: PMNode, tr: Transform): void {
  const known = new Map<string, Record<string, unknown>>()
  before.descendants(n => { if (n.type.name === 'word_inline' && n.attrs.xml) known.set(n.attrs.key as string, n.attrs); return true })
  const fill: Array<{ pos: number; attrs: Record<string, unknown> }> = []
  tr.doc.descendants((n, pos) => {
    if (n.type.name !== 'word_inline' || n.attrs.xml) return true
    const attrs = known.get(n.attrs.key as string)
    if (!attrs) {
      throw new OpError('invalid_structure', `[@w:${n.attrs.key}] 不是文档里已有的脚注或域代码标记`, {
        hint: '[@w:…] 只能原样保留或删除读视图里已有的标记，不能新建或修改；新增引用请用 insert_citation。',
      })
    }
    fill.push({ pos, attrs })
    return true
  })
  for (const f of fill) tr.setNodeMarkup(f.pos, undefined, f.attrs)
}

/**
 * 在一个文本块（doc 段落 / 标题，deck 形状里的段落）内做 replace_text（参照 Claude Docs 的 find + as:text）：
 * - 匹配：原样 → 去 markdown 转义 → 去强调符号 → 不区分大小写（唯一时）；空白不容错；
 * - 只替换真正变化的部分：新旧内容去掉相同的开头与结尾后再替换，未变的文字保留原样
 *   （格式、引用、评论锚点都不动）；被改写的锚定文字随之消失（锚点缩到剩下的文字）；
 * - 失配时返回候选（空白 / 大小写不同、隔着引用标记、多处匹配），模型可直接据此重发；
 * - find 跳过引用标记而 replace 只是在前后追加：保留引用，只插入追加部分。
 */
export function replaceInTextblock(tr: Transform, node: PMNode, pos: number, op: ReplaceArgs, parse: InlineParser): ReplaceOutcome {
  const map = textMap(node, pos)
  let needle = ''
  let hits: number[] = []
  for (const v of findVariants(op.find)) {
    hits = allIndexes(map.text, v)
    if (hits.length > 0) { needle = v; break }
  }
  if (hits.length === 0) {
    // 大小写不同：唯一匹配时接受（Claude Docs 默认不区分大小写）
    // 转小写会改变长度的字符（如 İ）下位置对不上，这时不做大小写回退
    const lower = map.text.toLowerCase()
    for (const v of lower.length === map.text.length ? findVariants(op.find) : []) {
      const ci = allIndexes(lower, v.toLowerCase())
      if (ci.length === 1 || (ci.length > 1 && op.occurrence !== undefined)) { hits = ci; needle = v; break }
    }
  }
  if (hits.length === 0) {
    if (appendAcrossCitation(tr, map, op, parse)) return { ok: true }
    return { ok: false, code: 'text_not_found', near: nearCandidates(map, op.find) }
  }
  const all = () => hits.map((h, i) => context(map.text, h, needle.length, { occurrence: i + 1 }))
  if (hits.length > 1 && op.occurrence === undefined) return { ok: false, code: 'ambiguous_match', matches: all() }
  const start = hits[(op.occurrence ?? 1) - 1]
  if (start === undefined) return { ok: false, code: 'occurrence_out_of_range', matches: all() }
  const end = start + needle.length - 1

  const parsed = parse(op.replace)
  // 纯文字替换（不带任何格式）：只按文字比较，保留下来的字保持原格式。
  // 带格式的替换：markdown 能表达的格式（粗体、斜体、链接…）以替换文字为准，不再从原文继承——否则
  // 「**0.80**[@c]。」后追加的句子会被匹配起点的粗体染上；只继承 markdown 表达不了的格式（deck 的 rpr 字号颜色）。
  const plain = parsed.every(n => !n.isText || n.marks.length === 0)
  const inherit = (marks: readonly Mark[]) => marks.filter(m => m.type.name !== 'comment')
  const base = inherit(map.marks[start]!)
  const hidden = base.filter(m => m.type.name === 'rpr')
  const inline = plain ? parsed : parsed.map(n => {
    let set = n.marks
    for (const m of hidden) if (!m.isInSet(set)) set = m.addToSet(set)
    return n.mark(set)
  })
  const textOnly = (k: string) => (k.startsWith('t:') ? k.slice(0, k.lastIndexOf('|')) : k)

  // 最小差异：去掉相同的开头与结尾
  const olds = oldUnits(tr, map, start, end)
  const news = newUnits(inline)
  const same = (a: string, b: string) => (plain ? textOnly(a) === textOnly(b) : a === b)
  let p = 0
  while (p < olds.length && p < news.length && same(olds[p]!.key, news[p]!)) p++
  let q = 0
  while (q < olds.length - p && q < news.length - p && same(olds[olds.length - 1 - q]!.key, news[news.length - 1 - q]!)) q++
  if (p === olds.length && p === news.length) return { ok: true } // 内容没变
  const from = p < olds.length ? olds[p]!.from : olds[olds.length - 1]!.to
  const to = olds.length - q > p ? olds[olds.length - 1 - q]!.to : from
  let middle = node.type.create(null, inline).content.cut(p, news.length - q)
  if (plain) {
    // 替换掉旧字：沿用被替换的第一个字的格式；纯插入：取左右邻字共有的格式（插在粗体中间仍是粗体，贴着粗体边界插入的不变粗）
    const left = p > 0 ? olds[p - 1]!.marks : map.marks[start - 1]
    const right = olds.length - q < olds.length ? olds[olds.length - q]!.marks : map.marks[end + 1]
    const near = inherit(from !== to ? olds[p]!.marks : left && right ? left.filter(m => m.isInSet(right)) : left ?? right ?? base)
    const marked: PMNode[] = []
    middle.forEach(n => marked.push(n.isText ? n.mark(near) : n.mark(near.filter(m => m.type.name !== 'link'))))
    middle = Fragment.from(marked)
  }
  if (middle.size === 0) tr.delete(from, to)
  else if (from === to) tr.insert(from, middle)
  else tr.replaceWith(from, to, middle)
  return { ok: true }
}

/** 失配候选：空白或大小写不同的写法、中间隔着引用标记的写法。 */
function nearCandidates(map: ReturnType<typeof textMap>, find: string): MatchCandidate[] {
  const out: MatchCandidate[] = []
  const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  for (const v of findVariants(find)) {
    const target = squash(v)
    if (!target) continue
    // 去空白、转小写后的逐字比较，映射回原文位置
    const idx: number[] = []
    let flat = ''
    for (let i = 0; i < map.text.length; i++) {
      if (/\s/.test(map.text[i]!)) continue
      const ch = map.text[i]!.toLowerCase()
      flat += ch.length === 1 ? ch : map.text[i]!
      idx.push(i)
    }
    for (let at = flat.indexOf(target); at !== -1 && out.length < 3; at = flat.indexOf(target, at + 1)) {
      const s0 = idx[at]!
      const s1 = idx[at + target.length - 1]!
      const actual = map.text.slice(s0, s1 + 1)
      out.push(context(map.text, s0, s1 - s0 + 1, { how: actual.toLowerCase() === v.toLowerCase() ? 'case' : 'whitespace' }))
    }
    if (out.length > 0) return out
    const stripped = stripCitations(map)
    const bare = v.replace(/\[@c:[a-z0-9]+\]/g, '')
    const at = bare ? stripped.text.indexOf(bare) : -1
    if (at !== -1) {
      const s0 = stripped.index[at]!
      const s1 = stripped.index[at + bare.length - 1]!
      return [context(map.text, s0, s1 - s0 + 1, { how: 'citation' })]
    }
  }
  return out
}

/** replace_text 失败时的结构化错误（附候选，模型可直接据此重发）。 */
export function replaceError(outcome: Exclude<ReplaceOutcome, { ok: true }>, where: string, current: string): OpError {
  if (outcome.code === 'ambiguous_match') {
    return new OpError('ambiguous_match', `原文在${where}中出现 ${outcome.matches.length} 次`, {
      hint: '用 occurrence 指定第几处（matches 列出了每一处的前后文），或把 find 写长一些。',
      current: { matches: outcome.matches },
    })
  }
  if (outcome.code === 'occurrence_out_of_range') {
    return new OpError('text_not_found', `原文只出现 ${outcome.matches.length} 次`, { current: { matches: outcome.matches } })
  }
  const near = outcome.near
  const hint = near[0]?.how === 'citation'
    ? '原文在这段文字中间有引用标记 [@c:…]：find 与 replace 里要原样写出引用标记（否则会删掉引用），或者只匹配引用标记之前 / 之后的文字。'
    : near.length > 0
      ? '原文的空白或大小写与 find 不同：按 near 里的 text 原样写 find 重发。'
      : '按 current 中的原文逐字复制 find（不含 {#id} 前缀和 markdown 符号）。'
  return new OpError('text_not_found', `${where}中找不到要替换的原文`, { hint, current: near.length > 0 ? { near, text: current } : current })
}

function replaceText(tr: Transform, op: Extract<DocOp, { op: 'replace_text' }>): string[] {
  const target = find(tr, op.id)
  if (!target.node.isTextblock) {
    throw new OpError('invalid_structure', `replace_text 只能用于段落或标题，${op.id} 是 ${target.node.type.name}`, {
      hint: target.node.type.name === 'list_item' ? '列表项的文字请用列表项 id 配合 replace_block。' : '表格请用 table_set_cells；其他块用 replace_block。',
    })
  }
  const outcome = replaceInTextblock(tr, target.node, target.pos, op, parseInline)
  if (!outcome.ok) throw replaceError(outcome, `块 ${op.id} `, serializeBlock(target.node, { ids: true }, ''))
  return [op.id]
}

function deleteBlock(tr: Transform, id: string, ctx: ApplyContext): void {
  const target = find(tr, id)
  const $pos = tr.doc.resolve(target.pos)
  const parent = $pos.parent
  const index = $pos.index()
  if (parent.canReplace(index, index + 1, Fragment.empty)) {
    tr.delete(target.pos, target.pos + target.node.nodeSize)
    return
  }
  if (parent.type.name === 'doc') {
    // 删掉最后一个块：留一个空段落
    tr.replaceWith(target.pos, target.pos + target.node.nodeSize, assignIds(schema.node('paragraph'), ctx.taken))
    return
  }
  throw new OpError('invalid_structure', `删除 ${id} 会让所在的${parent.type.name === 'list_item' ? '列表项' : parent.type.name}变空`, {
    hint: '改为删除外层的块（例如整个列表或列表项）。',
  })
}

function move(tr: Transform, ids: string[], after: string | null): string[] {
  if (after !== null && ids.includes(after)) throw new OpError('invalid_structure', '不能把块移动到自己之后')
  const nodes = ids.map(id => find(tr, id).node)
  // 从后往前删，位置不受影响
  const positions = ids.map(id => ({ id, ...find(tr, id) })).sort((a, b) => b.pos - a.pos)
  for (const p of positions) {
    const $pos = tr.doc.resolve(p.pos)
    if (!$pos.parent.canReplace($pos.index(), $pos.index() + 1, Fragment.empty)) {
      throw new OpError('invalid_structure', `移走 ${p.id} 会让所在容器变空`)
    }
    tr.delete(p.pos, p.pos + p.node.nodeSize)
  }
  let at: number
  let parent: PMNode
  let index: number
  if (after === null) {
    at = 0
    parent = tr.doc
    index = 0
  } else {
    const anchor = find(tr, after)
    const $pos = tr.doc.resolve(anchor.pos)
    at = anchor.pos + anchor.node.nodeSize
    parent = $pos.parent
    index = $pos.index() + 1
  }
  const fragment = Fragment.from(nodes)
  if (!parent.canReplace(index, index, fragment)) {
    throw new OpError('invalid_structure', `这些块不能放在 ${after ?? '文档开头'} 之后的位置`)
  }
  tr.insert(at, fragment)
  return ids
}

function setStyle(tr: Transform, op: Extract<DocOp, { op: 'set_block_style' }>): string[] {
  const target = find(tr, op.id)
  if (!target.node.isTextblock) throw new OpError('invalid_structure', `set_block_style 只能用于段落或标题，${op.id} 是 ${target.node.type.name}`)
  const typeName = op.type ?? (op.level !== undefined ? 'heading' : target.node.type.name)
  const type = schema.nodes[typeName]!
  const attrs: Record<string, unknown> = { id: op.id, style: target.node.attrs.style, align: target.node.attrs.align }
  if (typeName === 'heading') attrs.level = op.level ?? (target.node.attrs.level as number | undefined) ?? 1
  if (op.align !== undefined) attrs.align = op.align
  if (op.style !== undefined) attrs.style = op.style
  tr.setNodeMarkup(target.pos, type, attrs)
  return [op.id]
}

function setTextStyle(tr: Transform, op: Extract<DocOp, { op: 'set_text_style' }>): string[] {
  const target = find(tr, op.id)
  if (!target.node.isTextblock) throw new OpError('invalid_structure', `set_text_style 只能用于段落或标题，${op.id} 是 ${target.node.type.name}`)

  let from: number
  let to: number
  if (op.range) {
    const map = textMap(target.node, target.pos)
    if (map.text.length === 0 || op.range.from >= op.range.to || op.range.from >= map.text.length) return [op.id]
    const startIdx = Math.max(0, op.range.from)
    const endIdx = Math.min(map.text.length, op.range.to) - 1
    if (startIdx > endIdx) return [op.id]
    from = map.from[startIdx]!
    to = map.to[endIdx]!
  } else {
    from = target.pos + 1
    to = target.pos + 1 + target.node.content.size
  }
  if (from >= to) return [op.id]

  if (op.bold !== undefined) {
    if (op.bold) tr.addMark(from, to, schema.marks.bold!.create())
    else tr.removeMark(from, to, schema.marks.bold!)
  }
  if (op.italic !== undefined) {
    if (op.italic) tr.addMark(from, to, schema.marks.italic!.create())
    else tr.removeMark(from, to, schema.marks.italic!)
  }
  if (op.font_family || op.size || op.color) {
    const sizeStr = op.size !== undefined ? (typeof op.size === 'number' ? `${op.size}px` : op.size) : undefined
    const textStyleType = schema.marks.text_style!
    const spans: Array<{ from: number; to: number; attrs: Record<string, unknown> }> = []
    tr.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return
      const nFrom = Math.max(from, pos)
      const nTo = Math.min(to, pos + node.nodeSize)
      if (nFrom >= nTo) return
      const existing = textStyleType.isInSet(node.marks)
      spans.push({
        from: nFrom,
        to: nTo,
        attrs: {
          font_family: op.font_family ?? (existing?.attrs.font_family as string | null) ?? null,
          font_size: sizeStr ?? (existing?.attrs.font_size as string | null) ?? null,
          color: op.color ?? (existing?.attrs.color as string | null) ?? null,
        },
      })
    })
    if (spans.length > 0) {
      for (const s of spans) {
        tr.addMark(s.from, s.to, textStyleType.create(s.attrs))
      }
    } else {
      tr.addMark(from, to, textStyleType.create({
        font_family: op.font_family ?? null,
        font_size: sizeStr ?? null,
        color: op.color ?? null,
      }))
    }
  }
  return [op.id]
}

/**
 * 单元格新内容：段落之间用读视图的 `{#id}` 前缀分隔（见 markdown.ts parseCell）。
 * 写了 id 的段落按 id 对回原单元格里的段落，沿用其属性与 id（段落样式、对齐不丢，docx 导出仍按原段落处理）；
 * id 对不上或重复的段落新分配 id。整格都没写 id（如直接写一句话）时按位置对回。
 */
function cellContent(markdown: string, old: PMNode | null, taken: Set<string>): PMNode[] {
  const parsed = parseCell(markdown)
  const oldById = new Map<string, PMNode>()
  old?.forEach(p => { if (p.attrs.id) oldById.set(p.attrs.id as string, p) })
  const byId = parsed.some(x => x.id)
  const used = new Set<string>()
  return parsed.map(({ para, id }, i) => {
    let prev: PMNode | null = null
    if (byId) {
      const hit = id ? oldById.get(id) : undefined
      if (hit && !used.has(id!)) { prev = hit; used.add(id!) }
    } else if (old && i < old.childCount) prev = old.child(i)
    return prev ? prev.type.create(prev.attrs, para.content, prev.marks) : assignIds(para, taken)
  })
}

function tableTarget(tr: Transform, id: string): { node: PMNode; pos: number; grid: Grid } {
  const target = find(tr, id)
  if (target.node.type.name !== 'table') throw new OpError('invalid_structure', `${id} 不是表格`)
  return { ...target, grid: readGrid(target.node) }
}

function replaceTable(tr: Transform, target: { node: PMNode; pos: number }, cells: GridCell[], height: number, id: string, attrs: Record<string, unknown> = target.node.attrs): string[] {
  const table = buildFromGrid(cells, height, attrs)
  if ('emptyRow' in table) throw new OpError('invalid_structure', `操作后表格第 ${table.emptyRow} 行没有单元格`, { hint: '请用 replace_block 整表替换。' })
  tr.replaceWith(target.pos, target.pos + target.node.nodeSize, table)
  return [id]
}

/**
 * 表格操作一律按逻辑网格坐标（计入 colspan / rowspan，与 doc_read 的表格视图一致）。
 * 增删行列时合并单元格随之伸缩：插入点落在合并区内部则合并区扩展；删除范围部分覆盖合并区则合并区收缩，
 * 合并区起点被删时内容保留、起点移到删除范围之后。
 */
function tableOp(tr: Transform, op: Extract<DocOp, { op: `table_${string}` }>, ctx: ApplyContext): string[] {
  const target = tableTarget(tr, op.id)
  const { grid } = target
  const shape = `表格共 ${grid.height} 行、${grid.width} 列；行列下标从 0 开始，按合并后的逻辑网格计。`
  const cells = grid.cells.map(c => ({ ...c }))
  const blank = (top: number, left: number, header: boolean, markdown = ''): GridCell =>
    ({ node: schema.node('table_cell', { header }, cellContent(markdown, null, ctx.taken)), top, left, rowspan: 1, colspan: 1 })
  const origin = (row: number, col: number): GridCell => {
    const cell = grid.at(row, col)
    if (!cell) throw new OpError('cell_not_found', `表格 ${op.id} 没有单元格 (${row}, ${col})`, { hint: shape })
    if (cell.top !== row || cell.left !== col) throw new OpError('cell_not_found', `单元格 (${row}, ${col}) 已并入 (${cell.top}, ${cell.left}) 的合并单元格`, { hint: `请写合并单元格的左上角 (${cell.top}, ${cell.left})。` })
    return cells.find(x => x.top === row && x.left === col)!
  }
  // 设定过列宽时增删列同步调整（新列取平均宽度）
  const widths = colWidths(target.node)
  const withWidths = (ws: number[] | null) => ({ ...target.node.attrs, col_widths: ws ? ws.join(',') : null })

  switch (op.op) {
    case 'table_set_cells': {
      for (const c of op.cells) {
        const cell = grid.at(c.row, c.col)
        if (!cell) throw new OpError('cell_not_found', `表格 ${op.id} 没有单元格 (${c.row}, ${c.col})`, { hint: `${shape}要加列先用 table_insert_cols。` })
        if (cell.top !== c.row || cell.left !== c.col) {
          throw new OpError('cell_not_found', `单元格 (${c.row}, ${c.col}) 已并入 (${cell.top}, ${cell.left}) 的合并单元格`, { hint: `请写合并单元格的左上角 (${cell.top}, ${cell.left})。` })
        }
        const i = cells.findIndex(x => x.top === cell.top && x.left === cell.left)
        cells[i] = { ...cells[i]!, node: cell.node.type.create(cell.node.attrs, cellContent(c.markdown, cells[i]!.node, ctx.taken)) }
      }
      return replaceTable(tr, target, cells, grid.height, op.id)
    }
    case 'table_insert_rows': {
      if (op.at > grid.height) throw new OpError('cell_not_found', `插入位置 ${op.at} 超出表格行数 ${grid.height}`)
      const n = op.rows.length
      if (op.rows.some(r => r.length > grid.width)) throw new OpError('invalid_structure', `新行的单元格数超过表格列数 ${grid.width}`, { hint: '要加列先用 table_insert_cols。' })
      for (const c of cells) {
        if (c.top >= op.at) c.top += n
        else if (c.top + c.rowspan > op.at) c.rowspan += n
      }
      for (let k = 0; k < n; k++) {
        for (let col = 0; col < grid.width; col++) {
          // 被向下延伸的合并单元格覆盖的位置不另建单元格
          const covering = grid.at(op.at - 1, col)
          if (covering && op.at > 0 && op.at < covering.top + covering.rowspan) continue
          cells.push(blank(op.at + k, col, false, op.rows[k]![col] ?? ''))
        }
      }
      return replaceTable(tr, target, cells, grid.height + n, op.id)
    }
    case 'table_insert_cols': {
      if (op.at > grid.width) throw new OpError('cell_not_found', `插入位置 ${op.at} 超出表格列数 ${grid.width}`)
      for (const c of cells) {
        if (c.left >= op.at) c.left += 1
        else if (c.left + c.colspan > op.at) c.colspan += 1
      }
      for (let row = 0; row < grid.height; row++) {
        const covering = grid.at(row, op.at - 1)
        if (covering && op.at > 0 && op.at < covering.left + covering.colspan) continue
        const neighbor = grid.at(row, op.at) ?? grid.at(row, op.at - 1)
        cells.push(blank(row, op.at, (neighbor?.node.attrs.header as boolean | undefined) ?? false, op.cells?.[row] ?? ''))
      }
      const ws = widths?.length === grid.width ? [...widths.slice(0, op.at), widths.reduce((a, b) => a + b, 0) / widths.length, ...widths.slice(op.at)] : null
      return replaceTable(tr, target, cells, grid.height, op.id, widths ? withWidths(ws) : target.node.attrs)
    }
    case 'table_delete_rows':
    case 'table_delete_cols': {
      const rows = op.op === 'table_delete_rows'
      const size = rows ? grid.height : grid.width
      const unit = rows ? '行' : '列'
      if (op.at + op.count > size) throw new OpError('cell_not_found', `要删除的${unit}超出表格范围（共 ${size} ${unit}）`)
      if (op.count >= size) throw new OpError('invalid_structure', `不能删除表格的全部${unit}`, { hint: '要删除整张表请用 delete。' })
      const end = op.at + op.count
      const kept: GridCell[] = []
      for (const c of cells) {
        const start = rows ? c.top : c.left
        const span = rows ? c.rowspan : c.colspan
        const overlap = Math.max(0, Math.min(start + span, end) - Math.max(start, op.at))
        if (overlap === span) continue
        const next = start < op.at ? start : start >= end ? start - op.count : op.at
        if (rows) kept.push({ ...c, top: next, rowspan: span - overlap })
        else kept.push({ ...c, left: next, colspan: span - overlap })
      }
      if (rows) return replaceTable(tr, target, kept, grid.height - op.count, op.id)
      const ws = widths?.length === grid.width ? [...widths.slice(0, op.at), ...widths.slice(end)] : null
      return replaceTable(tr, target, kept, grid.height, op.id, widths ? withWidths(ws) : target.node.attrs)
    }
    case 'table_merge_cells': {
      const end = { row: op.row + op.rows, col: op.col + op.cols }
      if (end.row > grid.height || end.col > grid.width) throw new OpError('cell_not_found', `合并区域超出表格范围`, { hint: shape })
      if (op.rows === 1 && op.cols === 1) throw new OpError('invalid_structure', '合并区域至少要有两个单元格')
      const inside = (c: GridCell) => c.top >= op.row && c.left >= op.col && c.top + c.rowspan <= end.row && c.left + c.colspan <= end.col
      const overlaps = (c: GridCell) => c.top < end.row && c.top + c.rowspan > op.row && c.left < end.col && c.left + c.colspan > op.col
      const hit = cells.filter(overlaps)
      const partial = hit.find(c => !inside(c))
      if (partial) throw new OpError('invalid_structure', `合并区域切到了 (${partial.top}, ${partial.left}) 的合并单元格`, { hint: '合并区域要完整包住已有的合并单元格；可先 table_split_cell 拆开。' })
      const head = origin(op.row, op.col)
      // 内容按阅读顺序合在左上角单元格里，跳过空单元格
      const paras: PMNode[] = []
      for (const c of hit.sort((a, b) => a.top - b.top || a.left - b.left)) {
        if (c.node.childCount === 1 && c.node.firstChild!.content.size === 0) continue
        c.node.forEach(p => paras.push(p))
      }
      const merged: GridCell = { ...head, rowspan: op.rows, colspan: op.cols, node: head.node.type.create(head.node.attrs, paras.length > 0 ? paras : [assignIds(schema.node('paragraph'), ctx.taken)]) }
      return replaceTable(tr, target, [...cells.filter(c => !overlaps(c)), merged], grid.height, op.id)
    }
    case 'table_split_cell': {
      const head = origin(op.row, op.col)
      if (head.rowspan === 1 && head.colspan === 1) throw new OpError('invalid_structure', `单元格 (${op.row}, ${op.col}) 没有合并，不需要拆分`)
      const out = cells.filter(c => c !== head)
      out.push({ ...head, rowspan: 1, colspan: 1 })
      for (let r = head.top; r < head.top + head.rowspan; r++) {
        for (let c = head.left; c < head.left + head.colspan; c++) {
          if (r === head.top && c === head.left) continue
          const fresh = blank(r, c, head.node.attrs.header as boolean)
          // 拆出来的格沿用原合并单元格的底纹与对齐
          out.push({ ...fresh, node: fresh.node.type.create({ ...fresh.node.attrs, background: head.node.attrs.background, valign: head.node.attrs.valign }, fresh.node.content) })
        }
      }
      return replaceTable(tr, target, out, grid.height, op.id)
    }
    case 'table_set_header': {
      if (op.rows > grid.height) throw new OpError('cell_not_found', `表格只有 ${grid.height} 行`)
      const straddle = cells.find(c => c.top < op.rows && c.top + c.rowspan > op.rows)
      if (straddle) throw new OpError('invalid_structure', `(${straddle.top}, ${straddle.left}) 的合并单元格跨过了表头边界`, { hint: '先 table_split_cell 拆开，或调整表头行数。' })
      const out = cells.map(c => ({ ...c, node: c.node.type.create({ ...c.node.attrs, header: c.top < op.rows }, c.node.content, c.node.marks) }))
      return replaceTable(tr, target, out, grid.height, op.id, { ...target.node.attrs, header_explicit: true })
    }
    case 'table_set_style': {
      let attrs = target.node.attrs
      if (op.col_widths !== undefined) {
        if (op.col_widths && op.col_widths.length !== grid.width) throw new OpError('invalid_structure', `col_widths 有 ${op.col_widths.length} 项，表格有 ${grid.width} 列`)
        attrs = withWidths(op.col_widths)
      }
      for (const c of op.cells ?? []) {
        const cell = origin(c.row, c.col)
        const next = { ...cell.node.attrs }
        if (c.background !== undefined) next.background = c.background === null ? null : c.background.replace(/^#/, '').toUpperCase()
        if (c.valign !== undefined) next.valign = c.valign
        cell.node = cell.node.type.create(next, cell.node.content, cell.node.marks)
      }
      return replaceTable(tr, target, cells, grid.height, op.id, attrs)
    }
  }
}
