import { isOrgThemeKey, orgLogo, themeAllowed } from '../model/org-templates.ts'
import type { Node as PMNode } from 'prosemirror-model'
import { attachComment, locate, threadMarks } from '../model/anchors.ts'
import { indexById } from '../model/ids.ts'
import { serializeBlock } from '../model/markdown.ts'
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

    this.guardPending(batch, before, targetsOf)
    if (ai) {
      this.guardConflicts(batch, before, targetsOf)
      this.guardCitations(batch, textsOf)
      this.guardPatientRedlines(batch, textsOf, row)
    }

    const taken = this.docs.takenIds(batch.doc_id)
    const applied = deck
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
        userEditedIds: ai ? store.userTouchedSince(batch.doc_id, batch.base_rev + 1) : undefined,
      })
    const results = applied.results
    let after = batch.mode === 'suggest'
      ? toSuggestion(before, applied.doc, `g${randomBytes(4).toString('hex')}`)
      : applied.doc

    let reanchored: string | null = null
    if (meta.answering) ({ doc: after, nodeId: reanchored } = this.keepAnswering(batch.doc_id, meta.answering, before, after))
    after = this.keepWholeNode(batch.doc_id, after)
    if (ai) this.guardAnchors(batch, before, after)

    return { deck, before, after, reanchored, results, rev }
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
      // 重新锚到整块的线程：记录随之改成整块评论（引用文字清空，之后按整块维护）
      if (sim.reanchored && meta.answering) this.docs.store.setCommentAnchor(meta.answering, sim.reanchored, '')
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
  private guardPending(batch: EditBatch | DeckEditBatch, before: PMNode, targetsOf: (op: unknown) => string[]): void {
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
        if (coauthor) {
          throw new OpError('pending_suggestion', `块 ${id} 是 ${coauthor.attrs.suggest_author} 留下的待采纳修订`, {
            op_index: i,
            hint: `这是合作者 ${coauthor.attrs.suggest_author} 在 Word 里留下的修订，不能替他改；请等用户采纳或拒绝后再改，需要时在回复里说明。`,
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

  /** 冲突守卫：目标块在 base_rev 之后被用户改过 → 拒绝，附当前内容。 */
  private guardConflicts(batch: EditBatch | DeckEditBatch, before: PMNode, targetsOf: (op: unknown) => string[]): void {
    const index = indexById(before)
    batch.ops.forEach((op, i) => {
      // 按原文修改（replace_text）不看 rev：原文本身就是守卫——用户改了这几个字，原文就匹配不上
      if ((op as { op: string }).op === 'replace_text') return
      for (const id of targetsOf(op)) {
        const userRev = this.docs.store.lastChangeBy(batch.doc_id, id, 'user')
        if (userRev > batch.base_rev) {
          const node = index.get(id)?.node
          throw new OpError('conflict_user_edited', `块 ${id} 在 rev ${userRev} 被用户修改过（你的 base_rev 是 ${batch.base_rev}）`, {
            op_index: i,
            hint: '以 current 为准重新决定改法，并用新的 rev 作为 base_rev 再提交；用户的修改优先。',
            current: { rev: this.docs.rev(batch.doc_id), markdown: node ? (node.type.name === 'shape' || node.type.name === 'slide' ? node.textContent : serializeBlock(node, { ids: true }, '')) : null },
          })
        }
      }
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

