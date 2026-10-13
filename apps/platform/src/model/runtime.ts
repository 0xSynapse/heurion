import { EventEmitter } from 'node:events'
import type { Node as PMNode } from 'prosemirror-model'
import * as Y from 'yjs'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import type { Actor, DocKind, DocRow, Store, VersionRow, VersionSource } from '../store/db.ts'
import { assignIds, collectIds } from './ids.ts'
import { schema } from './schema.ts'
import { deckSchema } from './deck-schema.ts'
import { revertByNodes } from '../ops/revert.ts'

/** Yjs 里存放正文的 fragment 名。 */
const BODY = 'body'

export interface NodeChange { node_id: string; kind: 'added' | 'modified' | 'removed' }

export interface CommitEvent {
  docId: string
  rev: number
  actor: Actor
  turnId: string | null
  changes: NodeChange[]
  /**
   * 做出这次修改的用户（研究共享文档里可能是任何一位成员）。浏览器协同编辑按连接记；一次合批里有多人的编辑时为 null。
   * 记忆信号只记在这个人名下（memory/signals.ts）。
   */
  user?: string | null
}

export interface CommitDetail { event: CommitEvent; before: PMNode; after: PMNode; ops: unknown }

/** 变更 diff 时计入「修改」的节点：叶子级块（容器类只记增删）。 */
const LEAF_BLOCKS = new Set(['paragraph', 'heading', 'figure', 'opaque', 'table', 'shape'])

function addressableMap(doc: PMNode): Map<string, PMNode> {
  const map = new Map<string, PMNode>()
  doc.descendants(n => {
    if (n.attrs.id) map.set(n.attrs.id as string, n)
    // 表格内部按整表比较
    return n.type.name !== 'table'
  })
  return map
}

/** 两版文档的节点级差异（按 id）。 */
export function diffNodes(before: PMNode, after: PMNode): NodeChange[] {
  const a = addressableMap(before)
  const b = addressableMap(after)
  const out: NodeChange[] = []
  for (const [id, node] of b) {
    const prev = a.get(id)
    if (!prev) out.push({ node_id: id, kind: 'added' })
    else if (LEAF_BLOCKS.has(node.type.name) && !prev.eq(node)) out.push({ node_id: id, kind: 'modified' })
  }
  for (const id of a.keys()) if (!b.has(id)) out.push({ node_id: id, kind: 'removed' })
  return out
}

/** 文档类型对应的 schema。 */
export const schemaFor = (kind: DocKind) => kind === 'deck' ? deckSchema : schema

export function stateToDoc(state: Uint8Array, kind: DocKind = 'doc'): PMNode {
  const ydoc = new Y.Doc()
  try {
    Y.applyUpdate(ydoc, state)
    return yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(BODY), schemaFor(kind))
  } finally {
    ydoc.destroy()
  }
}

function docToState(doc: PMNode): Uint8Array {
  const ydoc = new Y.Doc()
  try {
    ydoc.transact(() => writeFragment(ydoc, doc))
    return Y.encodeStateAsUpdate(ydoc)
  } finally {
    ydoc.destroy()
  }
}

/**
 * 把模型写入 Y.Doc：updateYFragment 做最小差异，然后读回核对。y-prosemirror 1.3.7 在行内原子节点（引用）
 * 之后的文字只改格式时不更新格式属性（实测：粗体 → 评论标记无效）。修补在原有 Yjs 元素上进行——
 * 用临时 Y.Doc 生成目标内容的 Yjs 表示作参照，只补格式与元素属性，不删不换元素：协作者在同一段的并发输入、
 * 回合撤销（UndoManager 追踪的元素）都不受影响。结构对不上时才退回最小范围重写（保留未变前后缀）。
 */
export function writeFragment(ydoc: Y.Doc, next: PMNode): void {
  const fragment = ydoc.getXmlFragment(BODY)
  updateYFragment(ydoc, fragment, next, { mapping: new Map(), isOMark: new Map() } as never)
  let got = yXmlFragmentToProseMirrorRootNode(fragment, next.type.schema)
  if (got.eq(next)) return
  if (got.childCount === next.childCount && fragment.length === next.childCount) {
    withReferenceFragment(next, reference => {
      for (let i = 0; i < next.childCount; i++) {
        if (!got.child(i).eq(next.child(i))) syncAttributes(fragment.get(i), reference.get(i))
      }
    })
    got = yXmlFragmentToProseMirrorRootNode(fragment, next.type.schema)
    if (got.eq(next)) return
  }
  // 兜底：结构本身对不上，最小范围重写不一致的顶层块
  if (got.childCount !== next.childCount || fragment.length !== next.childCount) {
    const minLen = Math.min(got.childCount, next.childCount, fragment.length)
    let pre = 0
    while (pre < minLen && got.child(pre).eq(next.child(pre))) pre++
    let suf = 0
    while (
      suf < minLen - pre &&
      got.child(got.childCount - 1 - suf).eq(next.child(next.childCount - 1 - suf))
    ) {
      suf++
    }
    const delCount = fragment.length - pre - suf
    if (delCount > 0) fragment.delete(pre, delCount)
    if (next.childCount - pre - suf > 0) {
      fragment.insert(pre, freshElements(next, pre, next.childCount - suf))
    }
    return
  }
  for (let i = 0; i < next.childCount; i++) {
    if (got.child(i).eq(next.child(i))) continue
    fragment.delete(i, 1)
    fragment.insert(i, freshElements(next, i, i + 1))
  }
}

/** 目标内容在临时 Y.Doc 里的 Yjs 表示（y-prosemirror 自己的编码，作格式属性的参照），用完即销毁。 */
function withReferenceFragment<T>(doc: PMNode, fn: (frag: Y.XmlFragment) => T): T {
  const tmp = new Y.Doc()
  try {
    tmp.transact(() => updateYFragment(tmp, tmp.getXmlFragment(BODY), doc, { mapping: new Map(), isOMark: new Map() } as never))
    return fn(tmp.getXmlFragment(BODY))
  } finally {
    tmp.destroy()
  }
}

type YNode = Y.XmlElement | Y.XmlText | Y.XmlHook

/** 让 live 的格式与元素属性与 reference 一致（文字与结构相同才动）；结构不同返回 false。 */
function syncAttributes(live: YNode | undefined, reference: YNode | undefined): boolean {
  if (live instanceof Y.XmlText && reference instanceof Y.XmlText) {
    const liveDelta = live.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>
    const refDelta = reference.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>
    // 比纯文字（XmlText.toString() 带格式标签，不能用）
    const plain = (d: typeof liveDelta) => d.map(x => (typeof x.insert === 'string' ? x.insert : '\uFFFC')).join('')
    if (plain(liveDelta) !== plain(refDelta)) return false
    if (JSON.stringify(liveDelta) === JSON.stringify(refDelta)) return true
    const keys = new Set(liveDelta.flatMap(d => Object.keys(d.attributes ?? {})))
    let offset = 0
    for (const d of refDelta) {
      const length = typeof d.insert === 'string' ? d.insert.length : 1
      const attrs: Record<string, unknown> = { ...(d.attributes ?? {}) }
      for (const k of keys) if (!(k in attrs)) attrs[k] = null
      live.format(offset, length, attrs)
      offset += length
    }
    return true
  }
  if (live instanceof Y.XmlElement && reference instanceof Y.XmlElement && live.nodeName === reference.nodeName && live.length === reference.length) {
    const la = live.getAttributes() as Record<string, unknown>
    const ra = reference.getAttributes() as Record<string, unknown>
    for (const [k, v] of Object.entries(ra)) if (JSON.stringify(la[k]) !== JSON.stringify(v)) live.setAttribute(k, v as never)
    for (const k of Object.keys(la)) if (!(k in ra)) live.removeAttribute(k)
    for (let j = 0; j < live.length; j++) if (!syncAttributes(live.get(j), reference.get(j))) return false
    return true
  }
  return false
}

/** 顶层块 [from, to) 的全新 Yjs 元素（在临时 Y.Doc 里生成后克隆，可插入任何文档）。 */
function freshElements(doc: PMNode, from: number, to: number): Y.XmlElement[] {
  const nodes: PMNode[] = []
  for (let i = from; i < to; i++) nodes.push(doc.child(i))
  return withReferenceFragment(doc.type.create(doc.attrs, nodes), frag =>
    frag.toArray().map(el => (el as Y.XmlElement).clone()),
  )
}

/** 服务端提交的 Yjs origin（区别于浏览器经协同网关送来的更新）。 */
export interface ServerOrigin { server: true; actor: Actor; turnId: string | null }

const isServerOrigin = (origin: unknown): origin is ServerOrigin =>
  typeof origin === 'object' && origin !== null && (origin as ServerOrigin).server === true

/** 用户编辑合批落库的间隔。 */
const USER_FLUSH_MS = 400
/** 每份文档保留可撤销的最近 AI 回合数。 */
const TURN_UNDO_KEEP = 20

interface Loaded {
  kind: DocKind
  ydoc: Y.Doc
  rev: number
  cache: PMNode | null
  /** 上一次落库时的内容（用户编辑合批的 diff 基准）。 */
  committed: PMNode
  timer: NodeJS.Timeout | null
  /** 回合 id → 该回合的 Yjs 撤销器（只跟踪该回合的提交）。 */
  turnUndo: Map<string, { origin: ServerOrigin; um: Y.UndoManager }>
  /** 本次合批里做了浏览器编辑的用户（协同连接上标的 heurionUser） */
  editors: Set<string>
  /** 活跃连接 / 任务引用计数（> 0 时不可被空闲驱逐） */
  pins: number
  /** 上次访问时间戳 */
  lastAccessed: number
}

type Meta = { actor: Actor; turnId: string | null; ops: unknown; user?: string | null }

/**
 * 文档运行时：每个文档一个 Y.Doc（按需加载与空闲驱逐）。
 * - 服务端写入（AI / 导入 / 回滚 / 评论锚点）经 commit 以单个 Yjs 事务提交，origin = ServerOrigin；
 * - 浏览器的编辑经协同网关直接写进同一个 Y.Doc，按 USER_FLUSH_MS 合批成一次用户提交
 *   （rev+1、op log、节点变更索引），并修复编辑器拆段带来的重复 id；
 * - 每个 AI 回合有自己的 Y.UndoManager：撤销本轮只撤掉该回合的改动，用户在此期间的编辑保留（CRDT 语义）。
 */
export class Documents extends EventEmitter<{ commit: [CommitEvent]; 'commit-detail': [CommitDetail]; created: [DocRow] }> {
  private readonly loaded = new Map<string, Loaded>()
  private idleTimeoutMs = 10 * 60 * 1000

  constructor(readonly store: Store) {
    super()
    this.setMaxListeners(0)
  }

  /** 判断文档是否已加载在内存中（供冷索引等只读场景判断，不触发加载）。 */
  isLoaded(docId: string): boolean {
    return this.loaded.has(docId)
  }

  /** 钉住文档（活跃 WebSocket 连接或 AI 回合期间），增加引用计数，防止空闲驱逐。 */
  pin(docId: string): void {
    const l = this.load(docId)
    l.pins = (l.pins ?? 0) + 1
    l.lastAccessed = Date.now()
  }

  /** 释放钉住，减少引用计数。 */
  unpin(docId: string): void {
    const l = this.loaded.get(docId)
    if (!l) return
    l.pins = Math.max(0, (l.pins ?? 1) - 1)
    l.lastAccessed = Date.now()
  }

  /**
   * 检查并驱逐空闲文档：未被钉住（pins === 0）、超过 idleMs 未访问。
   * 驱逐前若有未落库编辑先落库。返回驱逐的文档数量。
   */
  evictIdle(idleMs = this.idleTimeoutMs): number {
    const now = Date.now()
    let count = 0
    for (const [docId, l] of [...this.loaded.entries()]) {
      if ((l.pins ?? 0) > 0) continue
      if (now - (l.lastAccessed ?? 0) < idleMs) continue
      this.flush(docId)
      this.unload(docId)
      count++
    }
    return count
  }

  /** 新建文档：content 缺省为一个空段落；同时落 v1。 */
  create(input: { owner: string; title: string; kind?: DocKind; content?: PMNode; source?: VersionSource; id?: string }): DocRow {
    const kind = input.kind ?? 'doc'
    const empty = kind === 'deck'
      ? deckSchema.node('doc', null, [deckSchema.node('slide')])
      : schema.node('doc', null, [schema.node('paragraph')])
    const content = assignIds(input.content ?? empty, new Set())
    const row = this.store.createDoc({ id: input.id, owner: input.owner, title: input.title, kind, state: docToState(content) })
    this.store.addVersion({ docId: row.id, rev: 0, source: input.source ?? 'create', note: input.source === 'import' ? '导入' : '新建', state: this.store.getState(row.id)! })
    this.emit('created', row)
    return row
  }

  private load(docId: string): Loaded {
    let l = this.loaded.get(docId)
    if (l) {
      l.lastAccessed = Date.now()
      return l
    }
    const row = this.store.getDoc(docId)
    const state = this.store.getState(docId)
    if (!row || !state) throw new Error(`doc ${docId} not found`)
    const ydoc = new Y.Doc()
    Y.applyUpdate(ydoc, state)
    const committed = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(BODY), schemaFor(row.kind))
    const loaded: Loaded = { kind: row.kind, ydoc, rev: row.rev, cache: committed, committed, timer: null, turnUndo: new Map(), editors: new Set(), pins: 0, lastAccessed: Date.now() }
    ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      loaded.cache = null
      if (isServerOrigin(origin)) return
      const who = (origin as { heurionUser?: unknown } | null)?.heurionUser
      if (typeof who === 'string') loaded.editors.add(who)
      // 浏览器编辑（或回合撤销）：合批落库
      if (loaded.timer) clearTimeout(loaded.timer)
      loaded.timer = setTimeout(() => { this.flush(docId) }, USER_FLUSH_MS)
      loaded.timer.unref?.()
    })
    l = loaded
    this.loaded.set(docId, l)
    return l
  }

  /** 当前文档（PM 节点，只读）。 */
  get(docId: string): PMNode {
    const l = this.load(docId)
    l.cache ??= yXmlFragmentToProseMirrorRootNode(l.ydoc.getXmlFragment(BODY), schemaFor(l.kind))
    return l.cache
  }

  rev(docId: string): number {
    return this.load(docId).rev
  }

  ydoc(docId: string): Y.Doc {
    return this.load(docId).ydoc
  }

  /**
   * 把尚未落库的浏览器编辑落成一次用户提交。修复重复 / 缺失的块 id（编辑器拆段、粘贴会复制 id），
   * 修复本身以服务端事务写回（广播给所有客户端）。返回提交事件，没有变化时返回 null。
   */
  flush(docId: string, ops: unknown = [{ op: 'collab' }]): CommitEvent | null {
    const l = this.loaded.get(docId)
    if (!l) return null
    if (l.timer) { clearTimeout(l.timer); l.timer = null }
    if (!this.store.getDoc(docId)) return null
    let after = this.get(docId)
    if (after.eq(l.committed)) return null
    const fixed = assignIds(after, collectIds(after))
    if (!fixed.eq(after)) {
      l.ydoc.transact(() => {
        writeFragment(l.ydoc, fixed)
      }, { server: true, actor: 'system', turnId: null } satisfies ServerOrigin)
      l.cache = null
      after = this.get(docId)
    }
    const user = l.editors.size === 1 ? [...l.editors][0]! : null
    l.editors.clear()
    return this.record(docId, l, after, { actor: 'user', turnId: null, ops, user })
  }

  private record(docId: string, l: Loaded, after: PMNode, meta: Meta): CommitEvent {
    const before = l.committed
    const changes = diffNodes(before, after)
    const rev = this.store.commit({
      docId, actor: meta.actor, turnId: meta.turnId, state: Y.encodeStateAsUpdate(l.ydoc), ops: meta.ops, changes,
    })
    l.rev = rev
    l.committed = after
    const event: CommitEvent = { docId, rev, actor: meta.actor, turnId: meta.turnId, changes, user: meta.user ?? null }
    this.emit('commit', event)
    // 带改前 / 改后文档的版本（服务端内部用，例如记忆演进收集「用户改了 AI 写的段落」；不推给浏览器）
    this.emit('commit-detail', { event, before, after, ops: meta.ops } satisfies CommitDetail)
    return event
  }

  /**
   * 服务端写入：把 next 写成新的当前状态（y-prosemirror 做最小差异更新，未改动的节点在 Yjs 里
   * 保持原样）。先落掉尚未落库的浏览器编辑，冲突守卫才能看到用户最新的改动。没有实际变化时返回 null。
   */
  commit(docId: string, next: PMNode, meta: Meta): CommitEvent | null {
    const l = this.load(docId)
    this.flush(docId)
    const before = this.get(docId)
    if (before.eq(next)) return null
    // AI 回合第一次写这份文档：记下回合开始前的状态（服务重启后按节点撤销的依据）
    if (meta.actor === 'ai' && meta.turnId) this.store.putTurnBase(meta.turnId, docId, Y.encodeStateAsUpdate(l.ydoc))
    const origin = this.originFor(docId, l, meta)
    l.ydoc.transact(() => writeFragment(l.ydoc, next), origin)
    l.cache = null
    return this.record(docId, l, this.get(docId), meta)
  }

  /** AI 回合的提交共用一个 origin，并挂上只跟踪它的撤销器。 */
  private originFor(docId: string, l: Loaded, meta: { actor: Actor; turnId: string | null }): ServerOrigin {
    if (meta.actor !== 'ai' || !meta.turnId) return { server: true, actor: meta.actor, turnId: meta.turnId }
    let entry = l.turnUndo.get(meta.turnId)
    if (!entry) {
      const origin: ServerOrigin = { server: true, actor: 'ai', turnId: meta.turnId }
      const um = new Y.UndoManager(l.ydoc.getXmlFragment(BODY), { trackedOrigins: new Set([origin]), captureTimeout: Number.MAX_SAFE_INTEGER })
      entry = { origin, um }
      l.turnUndo.set(meta.turnId, entry)
      while (l.turnUndo.size > TURN_UNDO_KEEP) {
        const oldest = l.turnUndo.keys().next().value!
        l.turnUndo.get(oldest)!.um.destroy()
        l.turnUndo.delete(oldest)
      }
    }
    return entry.origin
  }

  /** 该回合能否撤销：内存里有撤销器，或有持久化的回合起点且未撤销过。 */
  canRevertTurn(docId: string, turnId: string): boolean {
    if (this.load(docId).turnUndo.get(turnId)?.um.canUndo()) return true
    const base = this.store.getTurnBase(turnId, docId)
    return Boolean(base && !base.reverted)
  }

  /**
   * 撤销某个 AI 回合对本文档的全部改动，落成一次用户提交。
   * 有撤销器（服务未重启）：Yjs 撤销只移除该回合插入 / 恢复该回合删除的内容，用户期间的编辑保留；
   * 否则按节点撤销（revertByNodes）：用户之后改过的块跳过，返回跳过的块 id。
   */
  revertTurn(docId: string, turnId: string): { event: CommitEvent | null; skipped: string[] } | null {
    const l = this.load(docId)
    const entry = l.turnUndo.get(turnId)
    if (entry?.um.canUndo()) {
      this.flush(docId)
      while (entry.um.canUndo()) entry.um.undo()
      if (l.timer) { clearTimeout(l.timer); l.timer = null }
      entry.um.destroy()
      l.turnUndo.delete(turnId)
      this.store.markTurnReverted(turnId, docId)
      return { event: this.flush(docId, [{ op: 'revert_turn', turn_id: turnId }]), skipped: [] }
    }
    const base = this.store.getTurnBase(turnId, docId)
    if (!base || base.reverted) return null
    this.flush(docId)
    const turn = this.store.turnChanges(turnId, docId)
    const { doc, skipped } = revertByNodes(this.get(docId), stateToDoc(base.state, l.kind), turn.changes, this.store.userTouchedSince(docId, turn.minRev))
    const event = this.commit(docId, doc, { actor: 'user', turnId: null, ops: [{ op: 'revert_turn', turn_id: turnId, by: 'nodes' }] })
    this.store.markTurnReverted(turnId, docId)
    return { event, skipped }
  }

  /** 打版本快照（回合结束、用户保存、导入、回滚）。与上一版本 rev 相同则不重复打。 */
  snapshot(docId: string, source: VersionSource, note: string, turnId: string | null = null): VersionRow | null {
    const l = this.load(docId)
    this.flush(docId)
    const latest = this.store.latestVersion(docId)
    if (latest && latest.rev === l.rev) return null
    return this.store.addVersion({ docId, rev: l.rev, source, turnId, note, state: Y.encodeStateAsUpdate(l.ydoc) })
  }

  versionDoc(docId: string, seq: number): PMNode | null {
    const state = this.store.getVersionState(docId, seq)
    return state ? stateToDoc(state, this.load(docId).kind) : null
  }

  /** 回滚：把旧版本内容作为一次用户提交写回（历史只增），并打版本。 */
  restore(docId: string, seq: number): VersionRow | null {
    const old = this.versionDoc(docId, seq)
    if (!old) throw new Error(`version ${seq} not found`)
    this.commit(docId, old, { actor: 'user', turnId: null, ops: [{ op: 'restore', seq }] })
    return this.snapshot(docId, 'restore', `回滚到 v${seq}`)
  }

  /** 文档内已占用 id（分配新 id 用）。 */
  takenIds(docId: string): Set<string> {
    return collectIds(this.get(docId))
  }

  /** 落掉全部未落库的编辑（关停前调用）。 */
  flushAll(): void {
    for (const id of this.loaded.keys()) this.flush(id)
  }

  unload(docId: string): void {
    const l = this.loaded.get(docId)
    if (l?.timer) clearTimeout(l.timer)
    for (const { um } of l?.turnUndo.values() ?? []) um.destroy()
    l?.ydoc.destroy()
    this.loaded.delete(docId)
  }
}
