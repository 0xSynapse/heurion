import { isOrgThemeKey, orgLogo, themeAllowed } from '../model/org-templates.ts'
import type { Node as PMNode } from 'prosemirror-model'
import { attachComment, locate, threadMarks } from '../model/anchors.ts'
import { indexById } from '../model/ids.ts'
import { plainText, serializeBlock } from '../model/markdown.ts'
import type { Documents, NodeChange } from '../model/runtime.ts'
import type { Actor } from '../store/db.ts'
import { randomBytes } from 'node:crypto'
import { applyOps, type OpResult } from './apply.ts'
import { toSuggestion } from './suggest.ts'
import { guardPhrRedlines, type PhrMember } from './phr-guard.ts'
import { DOI, manualCitation } from './citation-check.ts'
import { OpError, opTexts, targetIds, type DocOp, type EditBatch } from './types.ts'
import { applyDeckOps, deckOpTexts, deckTargetIds, type DeckEditBatch, type DeckOp } from './deck.ts'
import { readLayouts } from '../convert/pptx-layouts.ts'
import { isPlatformPackage } from '../convert/pptx-template.ts'
import { templateLayouts } from '../model/deck-templates.ts'
import { DEFAULT_THEME } from '../model/deck-themes.ts'
import { themePhoto } from '../model/theme-photos.ts'

type DeckInfo = ReturnType<typeof readLayouts> & { platform: boolean }

export interface EditResult {
  doc_id: string
  rev: number
  results: Array<Omit<OpResult, 'op'> & { op: string }>
  changes: NodeChange[]
}

export interface ValidateResult {
  valid: boolean
  doc_id?: string
  rev?: number
  code?: string
  message?: string
  op_index?: number
  hint?: string
  current?: unknown
  results?: Array<Omit<OpResult, 'op'> & { op: string }>
}


export type GuardRejectCallback = (e: {
  owner: string
  docId: string
  turnId?: string | null
  code: string
  message: string
  extra?: Record<string, unknown>
}) => void

/**
 * 操作层（PLATFORM.md §5）：唯一的 MCP 写入口。
 * 管线：schema 校验（zod，在接入层）→ 守卫 → 内存应用 → 单个 Yjs 事务提交 → op log。
 * 守卫只对 AI（MCP）硬拦截；用户写入不受冲突、引用、锚点守卫阻挡（用户优先）。
 */
export class OpService {
  constructor(
    private readonly docs: Documents,
    /** 知家红线守卫（PATIENT.md §3）：按归属查成员标记（孕产 / 哺乳 / 儿童年龄）；没有接入时特殊人群规则不启用。 */
    private readonly phrMember?: (owner: string, patientId: string, space?: 'work' | 'personal') => PhrMember | null,
    private readonly onGuardReject?: GuardRejectCallback,
  ) {}

  /** deck 的版式与页面尺寸（来自原始文件包；按文档缓存）。 */
  private readonly deckInfo = new Map<string, DeckInfo>()

  /** 平台模板生成的 deck 一律用模板的 8 个版式（早期只有 3 个版式的包也升级）；导入的 pptx 用文件自己的版式。 */
  deckContextInfo(docId: string): DeckInfo {
    let info = this.deckInfo.get(docId)
    if (!info) {
      const pkg = this.docs.store.getPackage(docId)
      const isZip = !!(pkg && pkg.length >= 4 && pkg[0] === 0x50 && pkg[1] === 0x4B)
      info = !pkg ? { layouts: [], size: { cx: 12192000, cy: 6858000 }, platform: false }
        : !isZip || isPlatformPackage(pkg) ? { layouts: templateLayouts(DEFAULT_THEME), size: { cx: 12192000, cy: 6858000 }, platform: true }
          : { ...readLayouts(pkg), platform: false }
      this.deckInfo.set(docId, info)
    }
    return info
  }

  /**
   * 预检与试探（Probe，Harness² 任务级自演进）：
   * 在内存中执行写前守卫、冲突检查与操作演算，不触发 Yjs 事务，不修改文档。
   * 失败时返回结构化原因（code/hint/current），不抛出异常。
   */
  validate(batch: EditBatch | DeckEditBatch, meta: { actor: Actor; turnId?: string | null; answering?: string | null; user?: string | null }): ValidateResult {
    try {
      const sim = this.simulate(batch, { actor: meta.actor, turnId: meta.turnId ?? null, answering: meta.answering, user: meta.user })
      return {
        valid: true,
        doc_id: batch.doc_id,
        rev: sim.rev,
        results: sim.results,
      }
    } catch (err) {
      if (err instanceof OpError) {
        if (meta.actor === 'ai') {
          const row = this.docs.store.getDoc(batch.doc_id)
          this.onGuardReject?.({
            owner: row?.owner ?? 'system',
            docId: batch.doc_id,
            turnId: meta.turnId,
            code: err.code,
            message: err.message,
            extra: err.extra as Record<string, unknown>,
          })
        }
        return {
          valid: false,
          code: err.code,
          message: err.message,
          ...err.extra,
        }
      }
      return {
        valid: false,
        code: 'validation_error',
        message: (err as Error).message ?? String(err),
      }
    }
  }

  /** 模拟应用与守卫验证（供 edit 与 validate 共用）。 */
  private simulate(batch: EditBatch | DeckEditBatch, meta: { actor: Actor; turnId: string | null; answering?: string | null; user?: string | null }): {
    deck: boolean
    before: PMNode
    after: PMNode
    reanchored: string | null
    /** 被评论的文字随合并、移动、整段改写到了别的位置：线程跟到新位置（commit 后更新记录）。 */
    followed: Array<{ thread: string; nodeId: string }>
    results: Array<Omit<OpResult, 'op'> & { op: string }>
    rev: number
  } {
    const store = this.docs.store
    const row = store.getDoc(batch.doc_id)
    if (!row) throw new OpError('doc_not_found', `文档 ${batch.doc_id} 不存在`)
    const deck = row.kind === 'deck'
    const targetsOf = (op: unknown) => deck ? deckTargetIds(op as DeckOp) : targetIds(op as DocOp)
    const textsOf = (op: unknown) => deck ? deckOpTexts(op as DeckOp) : opTexts(op as DocOp)
    // 先落掉尚未落库的浏览器编辑：冲突守卫要看到用户最新的改动
    this.docs.flush(batch.doc_id)
    const rev = this.docs.rev(batch.doc_id)
    if (batch.base_rev > rev) {
      throw new OpError('invalid_base_rev', `base_rev ${batch.base_rev} 大于当前 rev ${rev}`, { hint: '使用 doc_outline / doc_read 返回的 rev。' })
    }
    const before = this.docs.get(batch.doc_id)
    const ai = meta.actor === 'ai'
    // 机构模板只给本机构成员（按文档所有者判断；别的机构看不到，按「没有这个主题」处理）
    if (deck) {
      (batch.ops as DeckOp[]).forEach((op, i) => {
        if (op.op === 'apply_theme' && isOrgThemeKey(op.theme) && !themeAllowed(op.theme, row.owner)) throw new OpError('theme_not_found', `没有主题「${op.theme}」`, { op_index: i, hint: '本机构模板用 deck_templates 查' })
      })
    }

    this.guardPending(batch, before, targetsOf, ai)
    if (ai) {
      this.guardConflicts(batch, before, targetsOf, deck)
      this.guardCitations(batch, textsOf)
      if (!deck) this.guardExistingCitations(batch as EditBatch, before)
      this.guardPatientRedlines(batch, textsOf, row)
    }

    const taken = this.docs.takenIds(batch.doc_id)
    const appliedRaw = deck
      ? applyDeckOps(before, batch.ops as DeckOp[], {
        taken,
        ...this.deckContextInfo(batch.doc_id),
        // 插图只能用文档所有者或这次操作者自己的资产（研究共享的幻灯片里，成员插自己的图）
        asset: id => {
          const builtin = themePhoto(id) ?? orgLogo(id, row.owner)
          if (builtin) return builtin
          const a = store.getAsset(id)
          const bytes = a && (a.owner === row.owner || (meta.user && a.owner === meta.user)) ? store.getAssetBytes(id) : null
          return a && bytes ? { mime: a.mime, bytes } : null
        },
      })
      : applyOps(before, batch.ops as DocOp[], {
        taken,
        userEditedIds: ai ? store.userTouchedSince(batch.doc_id, batch.base_rev) : undefined,
      })
    // 改了合作者修订的修订版：核对没碰到合作者的修订，并把改动同步到原文版本（用户拒绝修订后改动仍在）
    const applied = deck || !ai ? appliedRaw : { ...appliedRaw, doc: this.coauthorEdits(before, appliedRaw.doc) }
    const results = applied.results
    let after = batch.mode === 'suggest'
      ? toSuggestion(before, applied.doc, `g${randomBytes(4).toString('hex')}`, ai ? null : this.authorName(meta.user))
      : applied.doc

    let reanchored: string | null = null
    if (meta.answering) ({ doc: after, nodeId: reanchored } = this.keepAnswering(batch.doc_id, meta.answering, before, after))
    after = this.keepWholeNode(batch.doc_id, after)
    let followed: Array<{ thread: string; nodeId: string }> = []
    if (!deck) ({ doc: after, moved: followed } = this.followSnippets(batch.doc_id, before, after))
    if (ai) this.guardAnchors(batch, before, after)
    if (ai && !deck) {
      this.guardUserContent(batch as EditBatch, before, after)
      this.guardCitationRetention(batch as EditBatch, before, after)
      this.guardCitationSupport(batch as EditBatch, before, after)
    }

    return { deck, before, after, reanchored, followed, results, rev }
  }

  /**
   * meta.answering：本回合正在回答的评论线程。它的锚点被改没时（用户要求改的正是被评论的文字），
   * 重新锚定到原来所在的块 / 形状上，而不是拦下（其他线程仍按锚点守卫）。
   */
  edit(batch: EditBatch | DeckEditBatch, meta: { actor: Actor; turnId: string | null; answering?: string | null; user?: string | null }): EditResult {
    try {
      const sim = this.simulate(batch, meta)
      if (batch.dry_run) {
        return { doc_id: batch.doc_id, rev: sim.rev, results: sim.results, changes: [] }
      }
      const event = this.docs.commit(batch.doc_id, sim.after, { actor: meta.actor, turnId: meta.turnId, ops: batch.ops, user: meta.user ?? null })
      // AI 自己写入的块：写入后的内容它是知道的
      if (meta.actor === 'ai' && event && !sim.deck) this.noteSeen(batch.doc_id, event.changes.map(c => c.node_id), event.rev)
      // 重新锚到整块的线程：记录随之改成整块评论（引用文字清空，之后按整块维护）
      if (sim.reanchored && meta.answering) this.docs.store.setCommentAnchor(meta.answering, sim.reanchored, '')
      for (const f of sim.followed) {
        const c = this.docs.store.getComment(batch.doc_id, f.thread)
        if (c) this.docs.store.setCommentAnchor(f.thread, f.nodeId, c.snippet)
      }
      // 评论标记随内容搬到了别的块（合并、移动）：线程记录的所在块跟着更新
      if (!sim.deck && event) {
        const marks = threadMarks(sim.after)
        for (const c of this.docs.store.listComments(batch.doc_id, 'open')) {
          const at = marks.get(c.id)
          if (at && at.node_ids.length > 0 && !at.node_ids.includes(c.node_id)) this.docs.store.setCommentAnchor(c.id, at.node_ids[0]!, c.snippet)
        }
      }
      return { doc_id: batch.doc_id, rev: event?.rev ?? sim.rev, results: sim.results, changes: event?.changes ?? [] }
    } catch (err) {
      if (err instanceof OpError && meta.actor === 'ai') {
        const row = this.docs.store.getDoc(batch.doc_id)
        this.onGuardReject?.({
          owner: row?.owner ?? 'system',
          docId: batch.doc_id,
          turnId: meta.turnId,
          code: err.code,
          message: err.message,
          extra: err.extra as Record<string, unknown>,
        })
      }
      throw err
    }
  }

  /**
   * 待采纳修订：「待删除」的原文版本（块自身或它所在的表格、列表）不能再改——改了会让修订失去配对，
   * 采纳或导出时出现两份内容。待新增的修订版可以继续改，改动并入同一条修订（见 toSuggestion）。
   */
  private guardPending(batch: EditBatch | DeckEditBatch, before: PMNode, targetsOf: (op: unknown) => string[], ai = true): void {
    const index = indexById(before)
    // 原文块 id → 它的修订版（待新增）块 id
    const copyOf = new Map<string, string>()
    before.descendants(n => {
      if (n.attrs.suggest === 'insert' && n.attrs.suggest_of) copyOf.set(n.attrs.suggest_of as string, n.attrs.id as string)
      return true
    })
    batch.ops.forEach((op, i) => {
      for (const id of [...targetsOf(op), ...('anchor_id' in op ? [op.anchor_id] : [])]) {
        const hit = index.get(id)
        if (!hit) continue
        let pending: PMNode | null = hit.node.attrs.suggest === 'delete' ? hit.node : null
        if (!pending) {
          const $pos = before.resolve(hit.pos)
          for (let d = $pos.depth; d > 0 && !pending; d--) if ($pos.node(d).attrs.suggest === 'delete') pending = $pos.node(d)
        }
        // 合作者在 Word 里留下的修订：修订版同样不能改（不能替合作者改他的修改），等用户采纳或拒绝
        const byCoauthor = (n: PMNode) => !!n.attrs.suggest && !!n.attrs.suggest_author
        let coauthor: PMNode | null = byCoauthor(hit.node) ? hit.node : null
        if (!coauthor) {
          const $pos = before.resolve(hit.pos)
          for (let d = $pos.depth; d > 0 && !coauthor; d--) if (byCoauthor($pos.node(d))) coauthor = $pos.node(d)
        }
        // 有作者的修订（用户自己提的、Word 导入的合作者修订）只约束 AI；用户可以直接改
        if (coauthor && ai) {
          // 合作者修订的修订版（待新增）本身：可以改合作者修订以外的文字（应用后由 coauthorEdits 核对并同步到原文版本）
          const editable = coauthor === hit.node && coauthor.attrs.suggest === 'insert' && (op.op === 'replace_text' || op.op === 'replace_block')
          if (editable) continue
          const copy = coauthor.attrs.suggest === 'delete' ? copyOf.get(coauthor.attrs.id as string) : undefined
          throw new OpError('pending_suggestion', `块 ${id} 是 ${coauthor.attrs.suggest_author} 留下的待采纳修订`, {
            op_index: i,
            hint: copy
              ? `这是合作者 ${coauthor.attrs.suggest_author} 修订前的原文版本。要改这段里别的文字，请对它的修订版 {#${copy}} 用 replace_text 或 replace_block，只改 ${coauthor.attrs.suggest_author} 修订以外的部分（修订本身不能替他改）。`
              : `这是合作者 ${coauthor.attrs.suggest_author} 在 Word 里留下的修订，不能替他改；只能用 replace_text / replace_block 改修订版里修订以外的文字，或等用户采纳或拒绝后再改。`,
          })
        }
        if (!pending) continue
        const copy = copyOf.get(pending.attrs.id as string)
        throw new OpError('pending_suggestion', `块 ${id} 在待采纳修订的原文版本里`, {
          op_index: i,
          hint: copy
            ? `这里是待删除的原文版本。要继续修改，请改它的修订版 {#${copy}}（改动并入同一条修订）；或等用户采纳 / 拒绝后再改。`
            : '这里是待删除的原文版本，等用户采纳或拒绝这条修订后再改；需要时在回复里说明。',
          ...(copy ? { current: { pending_copy: copy } } : {}),
        })
      }
    })
  }

  /**
   * 合作者（Word 导入的）修订：原文版本 D 与修订版 I 相邻成对。修订版被改过时，改动须整体落在合作者修订之前或之后
   * （不能碰合作者改的文字），并以同样方式改原文版本——这样用户采纳或拒绝合作者的修订，AI 的改动都在；
   * 导出时按原文 XML 打补丁，合作者的 w:ins / w:del 原样保留、仍归在他名下。
   */
  private coauthorEdits(before: PMNode, after: PMNode): PMNode {
    const now = new Map<string, { node: PMNode; index: number }>()
    after.forEach((n, _o, i) => { if (n.attrs.id) now.set(n.attrs.id as string, { node: n, index: i }) })
    let out = after
    before.forEach((d, _o, i) => {
      const ins = i + 1 < before.childCount ? before.child(i + 1) : null
      if (!d.attrs.suggest_author || d.attrs.suggest !== 'delete' || !ins || ins.attrs.suggest !== 'insert' || ins.attrs.suggest_of !== d.attrs.id) return
      const cur = now.get(ins.attrs.id as string)?.node
      if (!cur || cur.eq(ins)) return
      const who = String(d.attrs.suggest_author)
      // 合作者修订的范围：原文版本与修订版不同的部分（D 里 [ms, meD)，I 里 [ms, me)）
      const ms = d.content.findDiffStart(ins.content)
      const msEnd = d.content.findDiffEnd(ins.content)
      // 这次改动的范围（旧修订版里 [es, ee)）
      const es = ins.content.findDiffStart(cur.content) ?? 0
      const eEnd = ins.content.findDiffEnd(cur.content) ?? { a: ins.content.size, b: cur.content.size }
      const ee = Math.max(es, eEnd.a)
      const extra = [...now.values()].filter(x => x.node !== cur && x.node.attrs.suggest_group === ins.attrs.suggest_group && x.node.attrs.id !== d.attrs.id)
      let mirrored: PMNode | null = null
      if (ms === null || !msEnd) mirrored = d.type.create(d.attrs, cur.content, d.marks)
      else {
        const me = Math.max(ms, msEnd.b)
        const meD = Math.max(ms, msEnd.a)
        if (ee <= ms) mirrored = d.type.create(d.attrs, cur.content.cut(0, ms + cur.content.size - ins.content.size).append(d.content.cut(ms)), d.marks)
        else if (es >= me) mirrored = d.type.create(d.attrs, d.content.cut(0, meD).append(cur.content.cut(me)), d.marks)
        if (!mirrored || extra.length > 0) {
          const changed = ins.textBetween(ms, me, '', '¤') || `（删去了「${d.textBetween(ms, meD, '', '¤')}」）`
          throw new OpError('pending_suggestion', `块 ${ins.attrs.id} 的改动碰到了 ${who} 的修订`, {
            hint: `${who} 的修订改动的是「${changed}」，这部分不能替他改；只改修订之前或之后的文字（一次一处、改成一段），两处都要改请分两次提交。`,
          })
        }
      }
      const at = now.get(d.attrs.id as string)
      if (!at) return
      out = out.copy(out.content.replaceChild(at.index, mirrored))
    })
    return out
  }

  /**
   * AI 最后一次看到各块内容时的版本（doc_read 读到的、自己写入的、冲突时随拒绝返回的）。
   * 冲突守卫按这个判断「用户的改动 AI 看过没有」：base_rev 只说明 AI 拿到过某个版本号，
   * 不说明读过这一块的新内容（多轮会话里 AI 凭前几轮的记忆整段重写，会冲掉医生在轮次之间的修改）。
   */
  private seen = new Map<string, Map<string, number>>()

  /** 记下 AI 在 rev 时看到了这些块的内容。 */
  noteSeen(docId: string, ids: Iterable<string>, rev: number): void {
    let m = this.seen.get(docId)
    if (!m) this.seen.set(docId, (m = new Map()))
    for (const id of ids) m.set(id, Math.max(m.get(id) ?? -1, rev))
  }

  /** 用户提修订时记在修订上的作者名（显示名，没有则用户名，再没有则「用户」）。 */
  private authorName(userId: string | null | undefined): string {
    const u = userId ? this.docs.store.getUser(userId) : undefined
    return u?.display_name || u?.username || '用户'
  }

  /** 冲突守卫：目标块在 AI 最后一次看到它（没看过则为 base_rev）之后被用户改过 → 拒绝，附当前内容。 */
  private guardConflicts(batch: EditBatch | DeckEditBatch, before: PMNode, targetsOf: (op: unknown) => string[], deck = false): void {
    const index = indexById(before)
    // 幻灯片经 slide_read 读，尚未记录「看过」：仍按 base_rev 判断
    const seen = deck ? undefined : this.seen.get(batch.doc_id)
    batch.ops.forEach((op, i) => {
      // 按原文修改（replace_text）不看 rev：原文本身就是守卫——用户改了这几个字，原文就匹配不上
      // merge 原样搬运现有内容（用户改过的字也一并保留），同样不看 rev
      if (['replace_text', 'replace_all', 'merge'].includes((op as { op: string }).op)) return
      for (const id of targetsOf(op)) {
        const userRev = this.docs.store.lastChangeBy(batch.doc_id, id, 'user')
        const since = seen?.get(id) ?? batch.base_rev
        if (userRev > since) {
          // 当前内容随拒绝返回给 AI：算它看过了
          if (!deck) this.noteSeen(batch.doc_id, [id], this.docs.rev(batch.doc_id))
          const node = index.get(id)?.node
          throw new OpError('conflict_user_edited', `块 ${id} 在 rev ${userRev} 被用户修改过（你的 base_rev 是 ${batch.base_rev}）`, {
            op_index: i,
            hint: since === batch.base_rev && !seen?.has(id)
              ? '以 current 为准重新决定改法，并用新的 rev 作为 base_rev 再提交；用户的修改优先。'
              : '用户在你上次读到这一块之后改过它（current 是现在的内容）：以 current 为准重新改，保留用户的改动；只换 base_rev 原样重发会再次被拦下。',
            current: { rev: this.docs.rev(batch.doc_id), markdown: node ? (node.type.name === 'shape' || node.type.name === 'slide' ? node.textContent : serializeBlock(node, { ids: true }, '')) : null },
          })
        }
      }
    })
  }

  /**
   * 保护用户此前亲自修改或补充的内容：即使用户的修改已被 AI 读过（noteSeen），
   * AI 在精简或改写该段落时也不能把用户亲自改过的数字或补充的句子删掉。
   */
  private guardUserContent(batch: EditBatch, before: PMNode, after: PMNode): void {
    const logs = this.docs.store.userEditOps(batch.doc_id)
    if (logs.length === 0) return
    const spansByBlock = new Map<string, string[]>()
    const tokenChar = /[A-Za-z0-9._%\u00C0-\u024F()-]/
    for (const { ops } of logs) {
      if (!Array.isArray(ops)) continue
      for (const uop of ops as Array<Record<string, unknown>>) {
        if (!uop || typeof uop !== 'object' || uop.op !== 'replace_text' || typeof uop.id !== 'string' || typeof uop.find !== 'string' || typeof uop.replace !== 'string') continue
        const list = spansByBlock.get(uop.id) ?? []
        for (let k = 0; k < list.length; k++) {
          if (list[k]!.includes(uop.find)) list[k] = list[k]!.replace(uop.find, uop.replace)
        }
        const f = uop.find
        const r = uop.replace
        let p = 0
        while (p < f.length && p < r.length && f[p] === r[p]) p++
        let q = 0
        while (q < f.length - p && q < r.length - p && f[f.length - 1 - q] === r[r.length - 1 - q]) q++
        let s = p
        let e = r.length - q
        while (s > 0 && tokenChar.test(r[s - 1]!)) s--
        while (e < r.length && tokenChar.test(r[e]!)) e++
        const rawAdded = r.slice(s, e)
        const added = rawAdded.replace(/^[\s,;:.]+|[\s,;:.]+$/g, '').trim()
        if (added.length >= 2 && !list.some(x => x.includes(added))) {
          list.push(added)
        }
        spansByBlock.set(uop.id, list)
      }
    }
    if (spansByBlock.size === 0) return
    const beforeIdx = indexById(before)
    const afterIdx = indexById(after)
    batch.ops.forEach((op, i) => {
      if (op.op !== 'replace_block' && op.op !== 'replace_text') return
      const id = op.id
      const spans = spansByBlock.get(id)
      if (!spans?.length) return
      const bNode = beforeIdx.get(id)?.node
      const aNode = afterIdx.get(id)?.node
      if (!bNode || !aNode) return
      const bText = bNode.textContent
      const aText = aNode.textContent
      for (const span of spans) {
        if (bText.includes(span) && !aText.includes(span)) {
          throw new OpError('conflict_user_edited', `块 ${id} 中用户此前亲自修改或补充的内容「${span}」被删改`, {
            op_index: i,
            hint: `「${span}」是用户此前亲自修改或补充的内容，改写或精简该段落时必须原样保留这处内容（只改写段落其余部分）。`,
            current: { rev: this.docs.rev(batch.doc_id), user_kept: span, markdown: serializeBlock(bNode, { ids: true }, '') },
          })
        }
      }
    })
  }

  /**
   * 原有引用守卫：稿件里原有的文中编号（[5]、[3,4]、[2–6]）对应用户自己的参考文献表。AI 把它们换成平台引用 [@c:…]
   * 会接管并改写用户原有的条目与编号（之后移动段落还会全文重新编号）——除非用户要求，不允许；新补的引用照常用 [@c:…]。
   */
  private guardExistingCitations(batch: EditBatch, before: PMNode): void {
    const MARK = /\[\d+(?:\s*[,，–\-]\s*\d+)*\]/g
    const index = indexById(before)
    batch.ops.forEach((op, i) => {
      let oldText = ''
      let newText = ''
      if (op.op === 'replace_text' || op.op === 'replace_all') { oldText = op.find; newText = op.replace }
      else if (op.op === 'replace_block') { const hit = index.get(op.id); oldText = hit ? hit.node.textContent : ''; newText = op.markdown }
      else return
      if (!/\[@c:/.test(newText)) return
      const was: string[] = oldText.match(MARK) ?? []
      const now: string[] = newText.replace(/\[@[cw]:[^\]]*\]/g, '').match(MARK) ?? []
      const gone = was.filter(m => !now.includes(m))
      if (gone.length === 0) return
      throw new OpError('existing_citation', `这处修改把原有的文中编号 ${gone.slice(0, 3).join('、')} 换成了平台引用`, {
        op_index: i,
        hint: '稿件原有的文中编号对应用户自己的参考文献表，保持原样（不要登记成平台引用，也不要导入原有文献表）；只有新补充的文献用 [@c:…]。用户明确要求接管原有引用时再做。',
      })
    })
  }

  /**
   * 平台引用保留守卫：块内已有的 [@c:id] 平台引用标记在改写或精简段落时不能被无故丢弃或改写成纯文本 [1]，
   * 否则会导致文末对应的参考文献条目被自动移除（collateral_change）。
   */
  private guardCitationRetention(batch: EditBatch, before: PMNode, after: PMNode): void {
    const beforeIdx = indexById(before)
    const afterIdx = indexById(after)
    const insertCopyByOrig = new Map<string, PMNode>()
    after.descendants(n => {
      if (n.attrs.suggest === 'insert' && n.attrs.suggest_of) {
        insertCopyByOrig.set(String(n.attrs.suggest_of), n)
      }
      return true
    })
    const citesOf = (node: PMNode): Set<string> => {
      const out = new Set<string>()
      node.descendants(n => {
        if (n.type.name === 'citation' && n.attrs.cite_id) out.add(String(n.attrs.cite_id))
        return true
      })
      return out
    }
    batch.ops.forEach((op, i) => {
      if (op.op !== 'replace_block' && op.op !== 'replace_text') return
      const bNode = beforeIdx.get(op.id)?.node
      const aNode = insertCopyByOrig.get(op.id) ?? afterIdx.get(op.id)?.node
      if (!bNode || !aNode) return
      const oldCites = citesOf(bNode)
      if (oldCites.size === 0) return
      const newCites = citesOf(aNode)
      const lost = [...oldCites].filter(id => !newCites.has(id))
      const added = [...newCites].filter(id => !oldCites.has(id))
      if (lost.length > 0 && added.length === 0) {
        throw new OpError('existing_citation', `块 ${op.id} 中已有的平台引用标记 ${lost.map(c => `[@c:${c}]`).join('、')} 在修改后丢失`, {
          op_index: i,
          hint: '改写或精简段落时必须原样保留块内已有的 [@c:...] 引用标记（切勿写成纯文本 [1] 或直接删掉），否则会导致文末对应的参考文献条目被自动移除。',
        })
      }
    })
  }

  /**
   * 句级引文支撑与断句守卫：
   * 1) 拦截因引用前英文缩写句号（如 "vs. CT) [@c:1]."）导致的句子断裂（citation_detached）；
   * 2) 当文献在库中有摘要缓存时，拦截将外部文献直接裸挂在陈述“本研究自身方法/队列”的原句末尾，
   *    以及句中核心主张词干与文献摘要不匹配的情况（citation_unsupported）。
   */
  private guardCitationSupport(batch: EditBatch, before: PMNode, after: PMNode): void {
    const splitSentences = (t: string) => t.split(/(?<=[.。!?！？])\s+(?=[A-Z(\[［\u4e00-\u9fff])/).map(s => s.trim()).filter(Boolean)
    const CLAIM_STOP = new Set([
      'this', 'that', 'with', 'from', 'were', 'have', 'been', 'which', 'their', 'these', 'those', 'into', 'more', 'than', 'also', 'such', 'both', 'between', 'among', 'after', 'before', 'during', 'under', 'over', 'through', 'where', 'when', 'while', 'study', 'studies', 'methodological', 'contribution', 'lies', 'having', 'organized', 'explicit', 'process', 'links', 'context', 'understanding', 'analysis', 'design', 'prospective', 'retrospective', 'reported', 'here', 'cohort', 'patients', 'group', 'groups', 'results', 'data', 'used', 'using', 'based', 'showed', 'shown', 'found', 'associated', 'compared', 'similar', 'consistent', 'prior', 'demonstrating', 'demonstrated',
    ])
    const SELF_REF = /\b(this study|the study's|the present study|our study|our cohort|in this (?:retrospective |prospective |multicenter |single-center )?(?:cohort|study|analysis|trial)|reported here)\b/i
    const beforeIdx = indexById(before)
    const citesById = new Map(this.docs.store.listCitations(batch.doc_id).map(c => [c.id, c]))
    const citesIn = (node: PMNode): Set<string> => {
      const out = new Set<string>()
      node.descendants(n => {
        if (n.type.name === 'citation' && n.attrs.cite_id) out.add(String(n.attrs.cite_id))
        return true
      })
      return out
    }
    after.descendants(aNode => {
      if (!aNode.isTextblock || aNode.attrs.suggest === 'delete') return false
      const aCites = citesIn(aNode)
      if (aCites.size === 0) return false
      const origId = (aNode.attrs.suggest_of ?? aNode.attrs.id) as string | undefined
      const bNode = origId ? beforeIdx.get(origId)?.node : undefined
      const bCites = bNode ? citesIn(bNode) : new Set<string>()
      const addedCites = new Set([...aCites].filter(id => !bCites.has(id)))
      if (addedCites.size === 0) return false

      const sents = splitSentences(plainText(aNode))
      const bSents = bNode ? splitSentences(plainText(bNode)).map(s => s.replace(/\[@[cw]:[^\]]+\]/g, '').trim()) : []

      for (let si = 0; si < sents.length; si++) {
        const s = sents[si]!
        const sCites = [...s.matchAll(/\[@c:([a-z0-9]+)\]/g)].map(m => m[1]!).filter(id => addedCites.has(id))
        if (sCites.length === 0) continue
        const cleanS = s.replace(/\[@[cw]:[^\]]+\]/g, '').trim()
        const words = cleanS.match(/[A-Za-z]{2,}|[\u4e00-\u9fff]/g) ?? []
        if (
          sents.length > 1 &&
          words.length < 4 &&
          si > 0 &&
          /\b(?:vs|cf|e\.g|i\.e|al|fig|tab|dr|prof)\.$/i.test(sents[si - 1]!.replace(/\[@[cw]:[^\]]+\]/g, '').trim())
        ) {
          throw new OpError('citation_detached', '引文前的英文缩写句号（如 "vs. CT" 或 "et al."）导致句子在引用标记前被切碎', {
            hint: '请去掉引用前缩写词后的英文句号（例如将 "vs. CT" 改为 "vs CT"），确保整句完整不断裂。',
          })
        }

        for (const citeId of sCites) {
          const cite = citesById.get(citeId)
          const abs = cite ? this.docs.store.getAbstract(cite.doi)?.abstract : null
          if (!abs) continue

          if (SELF_REF.test(cleanS) && bNode) {
            const bMatch = bSents.find(bs => SELF_REF.test(bs) && cleanS.slice(0, 24).toLowerCase() === bs.slice(0, 24).toLowerCase())
              ?? bSents.find(bs => SELF_REF.test(bs))
            if (bMatch) {
              const bWords = bMatch.match(/[A-Za-z]{2,}|[\u4e00-\u9fff]/g) ?? []
              if (words.length - bWords.length < 5) {
                throw new OpError('citation_unsupported', `句子陈述的是本研究自身的方法或本队列结果，不能直接将 [@c:${citeId}] 裸挂在原句末尾`, {
                  hint: '外部文献不能直接证明本研究自身的方法或队列数值。请完整保留原句文字，将原句末尾句号改为「, consistent with prior studies demonstrating <文献摘要的具体结论> [@c:id].」，使每条引用支撑其对应的对比分句。',
                })
              }
            }
          }

          const allSigWords = [...new Set((cleanS.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(w => !CLAIM_STOP.has(w)))]
          let sigWords = allSigWords
          if (bNode) {
            const bWordSet = new Set(plainText(bNode).toLowerCase().match(/[a-z]{4,}/g) ?? [])
            const addedSigWords = allSigWords.filter(w => !bWordSet.has(w))
            if (addedSigWords.length >= 4) sigWords = addedSigWords
          }
          if (sigWords.length >= 2) {
            const hay = `${cite!.formatted} ${abs}`.toLowerCase()
            const hitCount = sigWords.filter(w => hay.includes(w.slice(0, 5))).length
            const minHits = sigWords.length >= 5 ? 2 : 1
            if (hitCount < minHits) {
              throw new OpError('citation_unsupported', `引用 [@c:${citeId}] 的摘要与所在句子的核心主张不匹配（仅重合 ${hitCount}/${sigWords.length} 个核心词干）`, {
                hint: '请根据该文献摘要的实际研究结果改写支撑分句，或换一篇摘要直接包含该句核心概念（如具体毒性、结局或方法学）的文献。',
              })
            }
          }
        }
      }
      return false
    })
  }

  /** 引用守卫：写入内容不得出现 DOI / PMID / 手写参考文献；[@c:id] 必须已登记。 */
  private guardCitations(batch: EditBatch | DeckEditBatch, textsOf: (op: unknown) => string[]): void {
    const registered = new Set(this.docs.store.listCitations(batch.doc_id).map(c => c.id))
    batch.ops.forEach((op, i) => {
      for (const text of textsOf(op)) {
        const withoutCites = text.replace(/\[@c:[a-z0-9]+\]/g, '')
        const doi = DOI.exec(withoutCites)?.[0]
        if (manualCitation(withoutCites)) {
          throw new OpError('citation_not_registered', doi ? `正文里不能直接写 DOI（${doi}）` : '正文里不能手写参考文献条目或 PMID', {
            op_index: i,
            hint: doi
              ? `先调用 insert_citation（doi="${doi}"）登记，再在正文里写它返回的 [@c:<cite_id>]。`
              : '用 pubmed_search 找到文献 → insert_citation 登记 → 正文写 [@c:<cite_id>]。参考文献表由平台自动生成，不要手写。',
          })
        }
        for (const m of text.matchAll(/\[@c:([a-z0-9]+)\]/g)) {
          if (!registered.has(m[1]!)) {
            throw new OpError('citation_unknown', `引用 [@c:${m[1]}] 未在本文档登记`, {
              op_index: i, hint: '只能使用本文档 insert_citation / list_citations 返回的 cite_id。',
            })
          }
        }
      }
    })
  }

  /** 患者红线守卫（知家成员的「健康档案」，doc context doc_kind=archive）：只对 AI。 */
  private guardPatientRedlines(batch: EditBatch | DeckEditBatch, textsOf: (op: unknown) => string[], row: { owner: string; context: string | null }): void {
    let ctx: { kind?: string; doc_kind?: string; patient_id?: string; space?: 'work' | 'personal' } | null = null
    try { ctx = row.context ? JSON.parse(row.context) : null } catch { /* 无归属：不适用 */ }
    if (ctx?.kind !== 'patient' || (ctx.doc_kind !== 'archive' && ctx.doc_kind !== 'brief')) return
    const member = ctx.patient_id && this.phrMember ? this.phrMember(row.owner, ctx.patient_id, ctx.space === 'work' ? 'work' : 'personal') : null
    batch.ops.forEach((op, i) => {
      for (const text of textsOf(op)) guardPhrRedlines(text, i, member)
    })
  }

  /** 锚点守卫：本批操作会让 open 评论失去锚点，且未在 ack_comments 中确认 → 拒绝。 */
  /** 返回重新锚定到的块 id（没有重新锚定为 null），edit 提交成功后写回评论记录。 */
  private keepAnswering(docId: string, thread: string, before: PMNode, after: PMNode): { doc: PMNode; nodeId: string | null } {
    const unchanged = { doc: after, nodeId: null }
    const comment = this.docs.store.getComment(docId, thread)
    if (!comment || comment.status !== 'open') return unchanged
    const was = locate(before, comment)
    if (!was.located || locate(after, comment).located) return unchanged
    for (const id of was.node_ids) {
      try {
        return { doc: attachComment(after, id, '', thread).doc, nodeId: id }
      } catch { /* 块也被删了：交给锚点守卫 */ }
    }
    return unchanged
  }

  /**
   * 被评论的文字还在、只是位置变了（两段合并、段落移动或整段改写时原样保留了这句）：
   * 锚点丢了的 open 线程，若它锚定的文字在改后的文档里恰好出现一次，就把评论跟过去，而不是丢掉或拦下。
   */
  private followSnippets(docId: string, before: PMNode, after: PMNode): { doc: PMNode; moved: Array<{ thread: string; nodeId: string }> } {
    const moved: Array<{ thread: string; nodeId: string }> = []
    const open = this.docs.store.listComments(docId, 'open').filter(c => c.snippet && c.snippet.length >= 4)
    if (open.length === 0) return { doc: after, moved }
    const marksBefore = threadMarks(before)
    let marksAfter = threadMarks(after)
    for (const c of open) {
      if (!locate(before, c, marksBefore).located || locate(after, c, marksAfter).located) continue
      const hits: string[] = []
      let count = 0
      after.descendants(n => {
        if (!n.isTextblock || !n.attrs.id) return true
        const k = n.textContent.split(c.snippet).length - 1
        if (k > 0) { hits.push(n.attrs.id as string); count += k }
        return false
      })
      if (count !== 1) continue
      try {
        after = attachComment(after, hits[0]!, c.snippet, c.id).doc
        marksAfter = threadMarks(after)
        moved.push({ thread: c.id, nodeId: hits[0]! })
      } catch { /* 交给锚点守卫 */ }
    }
    return { doc: after, moved }
  }

  /** 整块 / 整个形状的评论锚的是块本身：块还在而文字被整体改写时，把标记补回整块。 */
  private keepWholeNode(docId: string, after: PMNode): PMNode {
    const whole = this.docs.store.listComments(docId, 'open').filter(c => !c.snippet)
    if (whole.length === 0) return after
    const marks = threadMarks(after)
    for (const c of whole) {
      if (marks.has(c.id)) continue
      try { after = attachComment(after, c.node_id, '', c.id).doc } catch { /* 块已不在：交给锚点守卫 */ }
    }
    return after
  }

  private guardAnchors(batch: EditBatch | DeckEditBatch, before: PMNode, after: PMNode): void {
    const open = this.docs.store.listComments(batch.doc_id, 'open')
    if (open.length === 0) return
    const ack = new Set(batch.ack_comments ?? [])
    const marksBefore = threadMarks(before)
    const marksAfter = threadMarks(after)
    const lost = open.filter(c => !ack.has(c.id) && locate(before, c, marksBefore).located && !locate(after, c, marksAfter).located)
    if (lost.length > 0) {
      throw new OpError('anchor_has_open_comments', `这些修改会移除 ${lost.length} 条 open 评论的锚点`, {
        hint: '缩小修改范围保留被评论的文字（优先用 replace_text），或确认后把这些线程 id 放进 ack_comments 再提交，并在线程里说明。',
        current: lost.map(c => ({
          comment_id: c.id,
          node_id: c.node_id,
          anchored_text: c.snippet,
          request: c.replies.filter(r => r.role === 'user').at(-1)?.text ?? '',
        })),
      })
    }
  }
}

