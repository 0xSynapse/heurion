import { Fragment, Mark, type Node as PMNode } from 'prosemirror-model'

/**
 * 来源等级（docs/design/PROVENANCE.md）：文字上的 prov 标记。
 *
 * - 只给「AI 未确认」的文字加 `prov{by:'ai', turn}`；人写的、导入的、人采纳或确认过的文字不加标记。
 * - 标记由服务端在提交时维护，不信任客户端：同一块改前改后按词对齐，没变的词沿用原来的来源，
 *   新写入的词按这次提交的写者打标（AI → 加标记，人 → 去标记）。
 *   这样 AI 用整段 Markdown 替换时，它以前写的、这次没改的文字不会丢标记被当成人写的；
 *   人在 AI 文字中间改几个字，改的部分自动成为人写的。
 * - 只标文字；引用、测量、Word 行内结构等原子有自己的登记来源（见 P2），不加标记。
 */

export const PROV_MARK = 'prov'

export interface ProvLabelOptions {
  actor: 'ai' | 'user'
  turnId: string | null
}

/** 一个对齐单位：一个词、一段空白、一个标点或汉字，或一个行内原子节点。 */
interface Tok { sig: string; node: PMNode; text: string | null; ai: boolean; turn: string | null }

/**
 * 英文单词为一个单位，数字（含小数点、千分位、百分号）为一个单位，空白为一个单位，其余（汉字、标点）逐字。
 * 句号不并进前面的词：「29%.」是数字加句末标点，句子边界要保留（来源规则二按句子找引用）。
 */
const WORD = /[A-Za-zÀ-ɏ'’]+|\d+(?:[.,]\d+)*%?|\s+|[\s\S]/gu

const provOf = (marks: readonly Mark[]): Mark | undefined => marks.find(m => m.type.name === PROV_MARK)

function tokens(block: PMNode): Tok[] {
  const out: Tok[] = []
  block.forEach(child => {
    if (child.isText) {
      const p = provOf(child.marks)
      for (const m of child.text!.matchAll(WORD)) out.push({ sig: `t:${m[0]}`, node: child, text: m[0], ai: !!p, turn: (p?.attrs.turn as string | null) ?? null })
    } else {
      out.push({ sig: `n:${child.type.name}:${JSON.stringify(child.attrs)}`, node: child, text: null, ai: false, turn: null })
    }
  })
  return out
}

/**
 * 最长公共子序列对齐（先去掉公共前后缀）。返回 b 中每个记号对应的 a 下标，没对上为 -1。
 * 中间部分过大时不做 DP，中间部分整体视为新写入（只会多标，不会少标）。
 */
function alignTokens(a: string[], b: string[]): number[] {
  const n = a.length
  const m = b.length
  const map = new Array<number>(m).fill(-1)
  let pre = 0
  while (pre < n && pre < m && a[pre] === b[pre]) { map[pre] = pre; pre++ }
  let suf = 0
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) { map[m - 1 - suf] = n - 1 - suf; suf++ }
  const p = n - pre - suf
  const q = m - pre - suf
  if (p === 0 || q === 0 || p * q > 4_000_000) return map
  const dp = new Uint32Array((p + 1) * (q + 1))
  const at = (i: number, j: number) => i * (q + 1) + j
  for (let i = p - 1; i >= 0; i--) {
    for (let j = q - 1; j >= 0; j--) {
      dp[at(i, j)] = a[pre + i] === b[pre + j] ? dp[at(i + 1, j + 1)]! + 1 : Math.max(dp[at(i + 1, j)]!, dp[at(i, j + 1)]!)
    }
  }
  for (let i = 0, j = 0; i < p && j < q;) {
    if (a[pre + i] === b[pre + j]) { map[pre + j] = pre + i; i++; j++ }
    else if (dp[at(i + 1, j)]! >= dp[at(i, j + 1)]!) i++
    else j++
  }
  return map
}

/** 按每个记号的来源重建块的行内内容（相邻同格式的文字合并）。 */
function rebuild(block: PMNode, toks: Tok[], label: (k: number) => { ai: boolean; turn: string | null }): PMNode {
  const schema = block.type.schema
  const provType = schema.marks[PROV_MARK]!
  const out: PMNode[] = []
  toks.forEach((t, k) => {
    if (t.text === null) { out.push(t.node); return }
    const { ai, turn } = label(k)
    let marks = provType.removeFromSet(t.node.marks)
    if (ai) marks = provType.create({ by: 'ai', turn }).addToSet(marks)
    const last = out.at(-1)
    if (last?.isText && Mark.sameSet(last.marks, marks)) out[out.length - 1] = schema.text(last.text! + t.text, marks)
    else out.push(schema.text(t.text, marks))
  })
  return block.copy(Fragment.fromArray(out))
}

/** 块里是否有 AI 未确认的文字。 */
export function hasAiText(block: PMNode): boolean {
  let found = false
  block.descendants(n => { if (!found && n.isText && provOf(n.marks)) found = true; return !found })
  return found
}

/** 去掉块里全部来源标记（人采纳 / 确认）。 */
export function stripProv(block: PMNode): PMNode {
  if (!hasAiText(block)) return block
  return mapTextblocks(block, tb => rebuild(tb, tokens(tb), () => ({ ai: false, turn: null })))
}

/** 把块里全部文字标为 AI 未确认（回填已有文档时用）。 */
export function markAllAi(block: PMNode, turnId: string | null): PMNode {
  return mapTextblocks(block, tb => {
    const toks = tokens(tb)
    return rebuild(tb, toks, k => ({ ai: true, turn: toks[k]!.turn ?? turnId }))
  })
}

/** 把指定 id 的块（含表格、列表等容器）整块标为 AI 未确认；ids 为 块 id → 回合 id。 */
export function markAiBlocks(doc: PMNode, ids: Map<string, string | null>): PMNode {
  const walk = (node: PMNode): PMNode => {
    const id = node.attrs.id as string | null | undefined
    if (id && ids.has(id)) return markAllAi(node, ids.get(id) ?? null)
    if (node.isLeaf || node.isTextblock) return node
    let changed = false
    const kids: PMNode[] = []
    node.forEach(c => { const n = walk(c); if (n !== c) changed = true; kids.push(n) })
    return changed ? node.copy(Fragment.fromArray(kids)) : node
  }
  return walk(doc)
}

/** 对节点内每个文本块做变换；没变化的子树保持原对象。 */
function mapTextblocks(node: PMNode, fn: (tb: PMNode) => PMNode): PMNode {
  if (node.isTextblock) return fn(node)
  if (node.isLeaf) return node
  let changed = false
  const kids: PMNode[] = []
  node.forEach(c => {
    const next = mapTextblocks(c, fn)
    if (next !== c) changed = true
    kids.push(next)
  })
  return changed ? node.copy(Fragment.fromArray(kids)) : node
}

/** 文档里所有带 id 的文本块（含表格单元格、列表项里的段落）。 */
function textblocksById(doc: PMNode): Map<string, PMNode> {
  const map = new Map<string, PMNode>()
  doc.descendants(n => {
    if (n.isTextblock) {
      const id = n.attrs.id as string | null
      if (id) map.set(id, n)
      return false
    }
    return true
  })
  return map
}

/** 被整块去掉的文本块的文字（合并、跨块搬运时，文字会原样出现在别的块里）。 */
export interface MovedPool { texts: Array<{ text: string; ai: 'none' | 'all' | 'mixed' }> }

export function movedPool(before: PMNode, after: PMNode): MovedPool {
  const kept = new Set<string>()
  after.descendants(n => { if (n.isTextblock) { if (n.attrs.id) kept.add(String(n.attrs.id)); return false } return true })
  const texts: MovedPool['texts'] = []
  before.descendants(n => {
    if (!n.isTextblock) return true
    const id = n.attrs.id as string | null
    if (id && !kept.has(id) && n.textContent.trim()) {
      const human = hasHumanText(n)
      const anyAi = hasAiText(n)
      texts.push({ text: n.textContent, ai: !anyAi ? 'none' : human ? 'mixed' : 'all' })
    }
    return false
  })
  return { texts }
}

/** 一段新出现的文字是不是从被去掉的块原样搬过来的；是则返回那块的来源。 */
export function movedFrom(pool: MovedPool, text: string): 'none' | 'all' | 'mixed' | null {
  // 原子（引用、脚注等）在 textContent 里是空的，比较前去掉占位符
  const t = text.replace(/￼/g, '').trim()
  if (t.length < 2) return null
  return pool.texts.find(p => p.text.includes(t))?.ai ?? null
}

/**
 * 给一次提交打来源标记：before 是提交前的文档，after 是这次要写入的文档。
 * 返回打好标记的 after（没有需要改的地方时返回 after 本身）。
 * 合并段落等跨块搬运：新出现的文字若原样来自被去掉的块，沿用那块的来源（人写的仍是人写的；
 * 来源混杂时按 AI 记，宁可让 AI 可改，也不把 AI 文字记成人确认过的）。
 */
export function labelProvenance(before: PMNode, after: PMNode, opts: ProvLabelOptions): PMNode {
  const prev = textblocksById(before)
  const ai = opts.actor === 'ai'
  const pool = movedPool(before, after)
  return mapTextblocks(after, tb => {
    const id = tb.attrs.id as string | null
    const old = id ? prev.get(id) : undefined
    // 人采纳了 AI 的待采纳修订：采纳即确认
    if (!ai && old && old.attrs.suggest === 'insert' && !tb.attrs.suggest) return stripProv(tb)
    if (old && old.content.eq(tb.content)) return tb
    const now = tokens(tb)
    if (!old) {
      // 新块：AI 写的整块标 AI；人新建的块里，粘贴进来的 AI 标记也一并去掉
      if (!ai && !hasAiText(tb)) return tb
      return rebuild(tb, now, () => ({ ai, turn: ai ? opts.turnId : null }))
    }
    const was = tokens(old)
    const map = alignTokens(was.map(t => t.sig), now.map(t => t.sig))
    // 没对上的连续记号作为一段，看是不是从被去掉的块搬来的
    const runLabel = new Map<number, { ai: boolean; turn: string | null }>()
    for (let k = 0; k < now.length;) {
      if (map[k]! >= 0) { k++; continue }
      let e = k
      while (e < now.length && map[e]! < 0) e++
      const moved = ai ? movedFrom(pool, now.slice(k, e).map(t => t.text ?? '').join('')) : null
      const label = moved === 'none' ? { ai: false, turn: null } : { ai, turn: ai ? opts.turnId : null }
      for (let x = k; x < e; x++) runLabel.set(x, label)
      k = e
    }
    const next = rebuild(tb, now, k => {
      const j = map[k]!
      if (j >= 0) return { ai: was[j]!.ai, turn: was[j]!.turn }
      return runLabel.get(k)!
    })
    return next.eq(tb) ? tb : next
  })
}

/** 一处改动：删掉的原记号与新写入的记号（都按文档顺序）。 */
export interface ProvRegion {
  /** 删掉的原文（文字拼起来；原子记为 ￼） */
  deleted: string
  inserted: string
  /** 删掉的里面有人写的文字或原子 */
  deletesHuman: boolean
  /** 纯插入且紧挨着人写的文字 */
  insertsIntoHuman: boolean
  /** 删掉或写入了原子（引用、测量、Word 结构、换行） */
  touchesAtom: boolean
  /** 新写入的文字按句子分段，每段带它所在句子里的引用 id（来源规则二：数字与引用要在同一句） */
  pieces: Array<{ text: string; cites: string[] }>
}

const SENTENCE_END = /^[。！？；.!?;]$/

/**
 * 同一块改前（old，可为 null 表示新块）改后（now）的改动区域。
 * 与 labelProvenance 用同一种按词对齐，保证「标成 AI 的」和「算作改动的」是同一批字。
 */
export function blockRegions(old: PMNode | null, now: PMNode): ProvRegion[] {
  const was = old ? tokens(old) : []
  const cur = tokens(now)
  const map = alignTokens(was.map(t => t.sig), cur.map(t => t.sig))
  const join = (ts: Tok[]) => ts.map(t => t.text ?? '￼').join('')
  const isHuman = (t: Tok | undefined) => !!t && t.text !== null && !t.ai && t.text.trim() !== ''
  const citeOf = (t: Tok) => t.text === null && t.node.type.name === 'citation' ? String(t.node.attrs.cite_id) : null
  // 每个新记号属于第几句：句末标点归本句；句末标点后（隔着空白）紧跟的引用也归本句
  // （"... 29% [@c:x]." 与 "... 29%. [@c:x]" 两种写法都算这一句的引用）
  const sent = new Array<number>(cur.length).fill(0)
  const citesOfSent = new Map<number, Set<string>>()
  {
    let s = 0
    let ended = false
    for (let k = 0; k < cur.length; k++) {
      const t = cur[k]!
      const blank = t.text !== null && t.text.trim() === ''
      if (ended && !blank && !citeOf(t)) { s++; ended = false }
      sent[k] = s
      const c = citeOf(t)
      if (c) { if (!citesOfSent.has(s)) citesOfSent.set(s, new Set()); citesOfSent.get(s)!.add(c) }
      if (t.text !== null && SENTENCE_END.test(t.text)) ended = true
    }
  }
  const piecesOf = (from: number, to: number): ProvRegion['pieces'] => {
    const out: ProvRegion['pieces'] = []
    for (let k = from; k < to; k++) {
      const last = out.at(-1)
      const cites = [...(citesOfSent.get(sent[k]!) ?? [])]
      const text = cur[k]!.text ?? '￼'
      if (last && k > from && sent[k] === sent[k - 1]) last.text += text
      else out.push({ text, cites })
    }
    return out
  }
  const regions: ProvRegion[] = []
  let pi = -1
  let pj = -1
  const flush = (i: number, j: number) => {
    const del = was.slice(pi + 1, i)
    const ins = cur.slice(pj + 1, j)
    if (del.length || ins.length) {
      regions.push({
        deleted: join(del),
        inserted: join(ins),
        deletesHuman: del.some(t => t.text === null || (!t.ai && t.text.trim() !== '')),
        insertsIntoHuman: del.length === 0 && old !== null && (isHuman(was[pi]) || isHuman(was[i])),
        touchesAtom: del.some(t => t.text === null) || ins.some(t => t.text === null),
        pieces: piecesOf(pj + 1, j),
      })
    }
  }
  for (let j = 0; j < cur.length; j++) {
    const i = map[j]!
    if (i < 0) continue
    flush(i, j)
    pi = i
    pj = j
  }
  flush(was.length, cur.length)
  return regions
}

/** 块里有没有人写的文字（非空白、没有 AI 标记）。 */
export function hasHumanText(block: PMNode): boolean {
  let found = false
  block.descendants(n => { if (!found && n.isText && !provOf(n.marks) && n.text!.trim() !== '') found = true; return !found })
  return found
}

/** 块内 AI 未确认文字的片段（给 AI 读视图、保护记录、来源证明用）。 */
export function aiSpans(block: PMNode): Array<{ text: string; turn: string | null }> {
  const out: Array<{ text: string; turn: string | null }> = []
  const walk = (node: PMNode) => {
    if (!node.isTextblock) { node.forEach(walk); return }
    let open = false
    node.forEach(n => {
      const p = n.isText ? provOf(n.marks) : undefined
      if (!p) { open = false; return }
      const turn = (p.attrs.turn as string | null) ?? null
      const last = out.at(-1)
      if (open && last && last.turn === turn) last.text += n.text!
      else out.push({ text: n.text!, turn })
      open = true
    })
  }
  walk(block)
  return out
}
