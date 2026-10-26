import { baseKeymap, chainCommands, toggleMark } from 'prosemirror-commands'
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { InputRule, inputRules, wrappingInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { Mark, type Node as PMNode, type NodeType } from 'prosemirror-model'
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list'
import { EditorState, Plugin, PluginKey, TextSelection, type Command } from 'prosemirror-state'
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, CellSelection, deleteColumn, deleteRow, findTable, goToNextCell, isInTable, mergeCells, setCellAttr, splitCell, tableEditing } from 'prosemirror-tables'
import { Decoration, DecorationSet, EditorView, type NodeView } from 'prosemirror-view'
import { askText } from './dialogs.ts'
import { redo, undo, ySyncPlugin, ySyncPluginKey, yUndoPlugin } from 'y-prosemirror'
import type * as Y from 'yjs'
import { citationOrderOf, numberCitations } from '../../../apps/platform/src/model/references.ts'
import { ADDRESSABLE, schema } from '../../../apps/platform/src/model/schema.ts'

/**
 * doc 编辑器（PLATFORM.md §9 P1）：ProseMirror + y-prosemirror，schema 与服务端共用。
 * 用户编辑经 Yjs 实时同步；AI 的修改作为 Yjs 更新流入，被改动的块短暂高亮。
 */

export interface EditorOptions {
  assetUrl: (assetId: string) => string
  /** 上传图片为资产，返回 asset_id（失败抛错）。 */
  uploadImage: (file: File) => Promise<string>
  onCommentClick: (thread: string) => void
  onSuggestion: (group: string, accept: boolean) => void
  onSelection: (anchor: SelectionAnchor | null) => void
  /** 点击论断标注时回调（定位或展开伴随审查卡片） */
  onClaimClick?: (claimId: string) => void
  /** 图是否由数据分析生成（有则显示「来自分析」，点开看代码与数据来源）。 */
  analysis?: { has: (assetId: string) => Promise<boolean>; show: (assetId: string) => void }
  /** 只读（研究里的只读成员）：能看、能选中文字评论，不能改 */
  readOnly?: boolean
}

export interface SelectionAnchor {
  node_id: string
  /** 空串表示整块 / 整个形状。 */
  snippet: string
  /** deck：选区所在段落在形状里的序号。 */
  paragraph?: number
  /** 选区在段落内的偏移（ProseMirror 位置，相对段落内容起点）。 */
  range?: { from: number; to: number }
  /** 选区不能评论时的提示（跨段落、跨形状…）；有值时只提示不评论。 */
  blocked?: string
  /** 选区在视口中的位置（浮动按钮用）。 */
  rect: { top: number; left: number; width: number }
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
/** 浏览器侧块 id：6 位、字母开头（服务端是 4 位起，基本不会相撞；相撞时服务端落库前会修复）。 */
function clientId(): string {
  let s = ALPHABET[10 + Math.floor(Math.random() * 26)]!
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * 36)]
  return s
}

const isRemote = (tr: { getMeta: (k: PluginKey) => unknown }) =>
  Boolean((tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin)

/** 本地编辑（回车拆段、粘贴）产生的缺失 / 重复 id 当场补上，新块不继承修订标记。 */
const idPlugin = new Plugin({
  appendTransaction(trs, _old, state) {
    if (!trs.some(t => t.docChanged && !isRemote(t))) return null
    const seen = new Set<string>()
    let tr: ReturnType<EditorState['tr']['setNodeMarkup']> | null = null
    state.doc.descendants((node, pos) => {
      if (!ADDRESSABLE.has(node.type.name)) return true
      const id = node.attrs.id as string | null
      if (!id || seen.has(id)) {
        const fresh = clientId()
        tr ??= state.tr
        const keepInsert = Boolean(id && seen.has(id) && node.attrs.suggest === 'insert' && node.attrs.suggest_group)
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          id: fresh,
          suggest: keepInsert ? 'insert' : null,
          suggest_group: keepInsert ? node.attrs.suggest_group : null,
          suggest_of: null,
        })
        seen.add(fresh)
      } else seen.add(id)
      return true
    })
    return tr
  },
})

/**
 * 引用编号：按正文首次出现顺序（NodeView 忽略自身 DOM 变化，编号由插件视图刷新）。
 * 与导出同一规则（model/references.ts）：正文末尾有用户自己的文献表时，服务端给出偏移量与沿用编号，这里接着编。
 */
export interface CitationNumbering { offset: number; fixed: Record<string, number> }
const citeKey = new PluginKey<CitationNumbering>('cite-numbering')
const citePlugin = new Plugin<CitationNumbering>({
  key: citeKey,
  state: {
    init: () => ({ offset: 0, fixed: {} }),
    apply: (tr, value) => tr.getMeta(citeKey) ?? value,
  },
  view: view => {
    const renumber = () => {
      const { offset, fixed } = citeKey.getState(view.state)!
      const numbers = numberCitations(citationOrderOf(view.state.doc), offset, fixed)
      view.dom.querySelectorAll<HTMLElement>('sup.cite').forEach(el => {
        const n = numbers.get(el.dataset.cite ?? '')
        el.textContent = `[${n ?? '?'}]`
      })
    }
    renumber()
    return { update: renumber }
  },
})

const flashKey = new PluginKey<DecorationSet>('ai-flash')
const flashPlugin = new Plugin<DecorationSet>({
  key: flashKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, set) {
      const meta = tr.getMeta(flashKey) as string[] | 'clear' | undefined
      if (meta === 'clear') return DecorationSet.empty
      if (!meta) return set.map(tr.mapping, tr.doc)
      const ids = new Set(meta)
      const decos: Decoration[] = []
      tr.doc.descendants((n, pos) => {
        if (n.attrs.id && ids.has(n.attrs.id as string)) decos.push(Decoration.node(pos, pos + n.nodeSize, { class: 'ai-flash' }))
        return true
      })
      return DecorationSet.create(tr.doc, decos)
    },
  },
  props: { decorations: state => flashKey.getState(state) },
})

/** 把 textblock 内部的字符偏移映射为 ProseMirror 全局文档位置 */
export function charOffsetToPos(node: PMNode, nodeStartPos: number, charOffset: number): number {
  let curChar = 0
  let curPos = nodeStartPos + 1
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child.isText && child.text) {
      const len = child.text.length
      if (charOffset <= curChar + len) {
        return curPos + Math.max(0, charOffset - curChar)
      }
      curChar += len
    }
    curPos += child.nodeSize
  }
  return curPos
}

export type DiffOp = { kind: 'equal' | 'delete' | 'insert'; text: string }

/** 中英混合文本的词 / 字符级 LCS Diff */
export function diffWords(a: string, b: string): DiffOp[] {
  if (a === b) return a ? [{ kind: 'equal', text: a }] : []
  if (!a) return b ? [{ kind: 'insert', text: b }] : []
  if (!b) return a ? [{ kind: 'delete', text: a }] : []

  const tokenize = (s: string) => s.match(/[\u4e00-\u9fa5]|[a-zA-Z0-9_.-]+|\s+|[^\s\w\u4e00-\u9fa5]/g) ?? []
  const tokensA = tokenize(a)
  const tokensB = tokenize(b)

  const n = tokensA.length
  const m = tokensB.length
  if (n * m > 250000) {
    return [{ kind: 'delete', text: a }, { kind: 'insert', text: b }]
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (tokensA[i] === tokensB[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
      }
    }
  }

  const raw: DiffOp[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && tokensA[i - 1] === tokensB[j - 1]) {
      raw.push({ kind: 'equal', text: tokensA[i - 1]! })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      raw.push({ kind: 'insert', text: tokensB[j - 1]! })
      j--
    } else {
      raw.push({ kind: 'delete', text: tokensA[i - 1]! })
      i--
    }
  }
  raw.reverse()

  const merged: DiffOp[] = []
  for (const item of raw) {
    if (merged.length > 0 && merged[merged.length - 1]!.kind === item.kind) {
      merged[merged.length - 1]!.text += item.text
    } else {
      merged.push({ ...item })
    }
  }

  // 语义平滑：若 delete 与 insert 之间仅夹着 1 个汉字（如「显著下」+「降」+「低」），将其合并以保证整词完整（「显著下降」与「降低」）
  for (let idx = 0; idx < merged.length - 2; idx++) {
    const a = merged[idx]!
    const b = merged[idx + 1]!
    const c = merged[idx + 2]!
    if (
      ((a.kind === 'delete' && c.kind === 'insert') || (a.kind === 'insert' && c.kind === 'delete')) &&
      b.kind === 'equal' && b.text.length === 1 && /^[\u4e00-\u9fa5]$/.test(b.text)
    ) {
      if (a.kind === 'delete') {
        a.text += b.text
        c.text = b.text + c.text
      } else {
        a.text = b.text + a.text
        c.text += b.text
      }
      merged.splice(idx + 1, 1)
      idx--
    }
  }

  return merged
}

/** 待采纳修订：在视图层将成对的增删块投影为行内字符级 Diff，并在块前呈现精致审查条 */
function suggestionDiffPlugin(onSuggestion: EditorOptions['onSuggestion']) {
  const renderTextblockInlineDiff = (delNode: PMNode, insNode: PMNode, insPos: number, decos: Decoration[]) => {
    const ops = diffWords(delNode.textContent, insNode.textContent)
    let charOffset = 0
    let hasWordDiff = false
    for (const op of ops) {
      if (op.kind === 'equal') {
        charOffset += op.text.length
      } else if (op.kind === 'delete') {
        hasWordDiff = true
        const widgetPos = charOffsetToPos(insNode, insPos, charOffset)
        const delText = op.text
        decos.push(Decoration.widget(widgetPos, () => {
          const el = document.createElement('del')
          el.className = 'diff-del'
          el.textContent = delText
          el.title = '原删除内容'
          return el
        }, { side: -1, key: `del-${insPos}-${charOffset}` }))
      } else if (op.kind === 'insert') {
        hasWordDiff = true
        const from = charOffsetToPos(insNode, insPos, charOffset)
        const to = charOffsetToPos(insNode, insPos, charOffset + op.text.length)
        if (to > from) {
          decos.push(Decoration.inline(from, to, { class: 'diff-ins' }))
        }
        charOffset += op.text.length
      }
    }
    // 仅变更了引用角标 [@c:...] 或行内样式（纯文本未变）时，对整块加修订高亮边框以便用户识别
    if (!hasWordDiff) {
      decos.push(Decoration.node(insPos, insPos + insNode.nodeSize, { class: 'diff-ins-block' }))
    }
  }

  // 新表保留了原表全部行、且每行保留了原有全部单元格时，才能只在新表上叠加 Diff；
  // 否则被删的行/列在新表里无处呈现，必须让原表以删除样式保持可见
  const tableShapeKept = (del: PMNode, ins: PMNode): boolean => {
    if (del.childCount > ins.childCount) return false
    for (let r = 0; r < del.childCount; r++) {
      if (del.child(r).childCount > ins.child(r).childCount) return false
    }
    return true
  }

  // 非文本块容器（列表等）：新块按位置覆盖原块全部子节点、且对应子节点可逐一比对时，才能隐藏原块只看叠加 Diff
  const canOverlay = (del: PMNode, ins: PMNode): boolean => {
    if (del.type !== ins.type || del.childCount > ins.childCount) return false
    for (let i = 0; i < del.childCount; i++) {
      const d = del.child(i)
      const n = ins.child(i)
      if (d.isTextblock && n.isTextblock) continue
      if (d.isTextblock || n.isTextblock || d.isLeaf || n.isLeaf) {
        if (!d.eq(n)) return false
      } else if (!canOverlay(d, n)) return false
    }
    return true
  }

  const renderOverlayDiff = (del: PMNode, ins: PMNode, insPos: number, decos: Decoration[]) => {
    let pos = insPos + 1
    for (let i = 0; i < ins.childCount; i++) {
      const n = ins.child(i)
      const d = i < del.childCount ? del.child(i) : null
      if (!d) decos.push(Decoration.node(pos, pos + n.nodeSize, { class: 'diff-ins-block' }))
      else if (!d.eq(n)) {
        if (n.isTextblock) renderTextblockInlineDiff(d, n, pos, decos)
        else renderOverlayDiff(d, n, pos, decos)
      }
      pos += n.nodeSize
    }
  }

  const makeSuggestBar = (group: string, keySuffix: string, pos: number, label = 'AI 修订 · 待采纳'): Decoration =>
    Decoration.widget(pos, () => {
      const bar = document.createElement('div')
      bar.className = 'suggest-bar'
      bar.dataset.suggestBarGroup = group
      bar.contentEditable = 'false'
      bar.innerHTML = `<span class="badge-pill rev"><span class="dot"></span> ${label}</span><button data-a="1" class="btn-sm-accept">采纳</button><button data-a="0" class="btn-sm-reject">拒绝</button>`
      bar.addEventListener('mousedown', e => {
        const btn = (e.target as HTMLElement).closest('button')
        if (!btn) return
        e.preventDefault()
        onSuggestion(group, btn.dataset.a === '1')
      })
      return bar
    }, { side: -1, key: `sg-${group}-${keySuffix}`, ignoreSelection: true })

  const build = (doc: PMNode) => {
    const decos: Decoration[] = []

    interface SuggestionBlock {
      pos: number
      node: PMNode
      suggest: 'insert' | 'delete'
      group: string
      id: string | null
      suggestOf: string | null
    }
    const sameBlockContent = (a: PMNode, b: PMNode): boolean => {
      if (a.type !== b.type || !a.content.eq(b.content) || !Mark.sameSet(a.marks, b.marks)) return false
      for (const k of Object.keys(a.attrs)) {
        if (k === 'id' || k.startsWith('suggest')) continue
        if (a.attrs[k] !== b.attrs[k]) return false
      }
      return true
    }
    const sameCellContent = (a: PMNode, b: PMNode): boolean => {
      if (a.type !== b.type || a.childCount !== b.childCount) return false
      for (const k of Object.keys(a.attrs)) {
        if (a.attrs[k] !== b.attrs[k]) return false
      }
      for (let i = 0; i < a.childCount; i++) {
        if (!sameBlockContent(a.child(i), b.child(i))) return false
      }
      return true
    }
    const groups = new Map<string, SuggestionBlock[]>()
    doc.descendants((node, pos) => {
      const suggest = node.attrs.suggest as 'insert' | 'delete' | null
      const group = node.attrs.suggest_group as string | null
      if (suggest && group) {
        const list = groups.get(group) ?? []
        list.push({
          pos,
          node,
          suggest,
          group,
          id: (node.attrs.id as string | null) ?? null,
          suggestOf: (node.attrs.suggest_of as string | null) ?? null,
        })
        groups.set(group, list)
        return false
      }
      return true
    })

    for (const [group, blocks] of groups) {
      const deletes = blocks.filter(b => b.suggest === 'delete')
      const inserts = blocks.filter(b => b.suggest === 'insert')
      const pairedDeletes = new Set<SuggestionBlock>()

      for (const ins of inserts) {
        // 只按 suggest_of 配对：同一批里「新增一段 + 删除另一段」不能互相配对，否则被删的段会被隐藏、显示成一处莫名的改写
        const del = deletes.find(d => !pairedDeletes.has(d) && ins.suggestOf && d.id === ins.suggestOf)

        if (del && ins.node.isTextblock && del.node.isTextblock) {
          pairedDeletes.add(del)
          // 隐藏原删除块（由新块呈现行内划线 Diff）
          decos.push(Decoration.node(del.pos, del.pos + del.node.nodeSize, { class: 'suggest-paired-delete' }))
          renderTextblockInlineDiff(del.node, ins.node, ins.pos, decos)
        } else if (del && ins.node.type.name === 'table' && del.node.type.name === 'table' && tableShapeKept(del.node, ins.node)) {
          pairedDeletes.add(del)
          // 隐藏原整表（避免大表格在编辑区重复展示两份），在新表内按单元格呈现行内 Diff 与采纳条
          decos.push(Decoration.node(del.pos, del.pos + del.node.nodeSize, { class: 'suggest-paired-delete' }))
          const changedCellBarPositions: number[] = []
          let rowPos = ins.pos + 1
          for (let r = 0; r < ins.node.childCount; r++) {
            const insRow = ins.node.child(r)
            const delRow = r < del.node.childCount ? del.node.child(r) : null
            if (!delRow) {
              decos.push(Decoration.node(rowPos, rowPos + insRow.nodeSize, { class: 'diff-ins-block' }))
              if (insRow.childCount > 0 && insRow.child(0).childCount > 0) {
                changedCellBarPositions.push(rowPos + 2)
              }
            } else {
              let cellPos = rowPos + 1
              for (let c = 0; c < insRow.childCount; c++) {
                const insCell = insRow.child(c)
                const delCell = c < delRow.childCount ? delRow.child(c) : null
                if (!delCell) {
                  decos.push(Decoration.node(cellPos, cellPos + insCell.nodeSize, { class: 'diff-ins-block' }))
                  changedCellBarPositions.push(cellPos + 1)
                } else if (!sameCellContent(delCell, insCell)) {
                  decos.push(Decoration.node(cellPos, cellPos + insCell.nodeSize, { class: 'diff-modified-cell' }))
                  changedCellBarPositions.push(cellPos + 1)
                  let pPos = cellPos + 1
                  for (let p = 0; p < insCell.childCount; p++) {
                    const insP = insCell.child(p)
                    const delP = p < delCell.childCount ? delCell.child(p) : null
                    if (delP && insP.isTextblock && delP.isTextblock) {
                      if (!sameBlockContent(delP, insP)) {
                        renderTextblockInlineDiff(delP, insP, pPos, decos)
                      }
                    } else {
                      decos.push(Decoration.node(pPos, pPos + insP.nodeSize, { class: 'diff-ins-block' }))
                    }
                    pPos += insP.nodeSize
                  }
                  if (delCell.childCount > insCell.childCount) {
                    const removedTexts: string[] = []
                    for (let p = insCell.childCount; p < delCell.childCount; p++) {
                      const t = delCell.child(p).textContent.trim()
                      if (t) removedTexts.push(t)
                    }
                    if (removedTexts.length > 0) {
                      const delSummary = removedTexts.join(' ')
                      const endPos = Math.max(cellPos + 1, pPos - 1)
                      decos.push(Decoration.widget(endPos, () => {
                        const el = document.createElement('del')
                        el.className = 'diff-del'
                        el.textContent = delSummary
                        el.title = '原删除段落'
                        return el
                      }, { side: 1, key: `tdel-${cellPos}` }))
                    }
                  }
                }
                cellPos += insCell.nodeSize
              }
            }
            rowPos += insRow.nodeSize
          }
          // 在修改的单元格内部直接放置采纳条（方便长表格局部修改时就地采纳）；改动很多时只放前几处，其余单元格靠底色与行内标注识别
          for (const cPos of changedCellBarPositions.slice(0, 6)) {
            decos.push(makeSuggestBar(group, `cell-${cPos}`, cPos, '表格内容已修订 · 待采纳'))
          }
          // 单元格文字都没变（只改了表格属性、合并等）：整表加修订边框，免得原表被隐藏后看不出任何改动
          if (changedCellBarPositions.length === 0) decos.push(Decoration.node(ins.pos, ins.pos + ins.node.nodeSize, { class: 'diff-ins-block' }))
        } else if (del && del.node.type.name !== 'table' && canOverlay(del.node, ins.node)) {
          pairedDeletes.add(del)
          decos.push(Decoration.node(del.pos, del.pos + del.node.nodeSize, { class: 'suggest-paired-delete' }))
          const before = decos.length
          renderOverlayDiff(del.node, ins.node, ins.pos, decos)
          // 子节点逐一相同（只改了块属性）时整体加修订边框，免得用户看不出改动
          if (decos.length === before) decos.push(Decoration.node(ins.pos, ins.pos + ins.node.nodeSize, { class: 'diff-ins-block' }))
        } else {
          // 结构对不上（删了列表项、表格行/列，或换成了别的块）：原块保持删除样式可见，新块整体标为插入
          decos.push(Decoration.node(ins.pos, ins.pos + ins.node.nodeSize, { class: 'diff-ins-block' }))
        }
      }

      for (const del of deletes) {
        if (!pairedDeletes.has(del)) {
          decos.push(Decoration.node(del.pos, del.pos + del.node.nodeSize, { class: 'diff-del-block' }))
        }
      }

      const visibleBlocks = [
        ...inserts,
        ...deletes.filter(d => !pairedDeletes.has(d)),
      ].sort((a, b) => a.pos - b.pos)

      let prevEnd = -1
      for (const blk of visibleBlocks) {
        // 连续相邻的同组块只在该连续片段开头放一条审查条；跨章节的多处修改则在每处上方都放审查条
        if (prevEnd === -1 || blk.pos > prevEnd + 2) {
          const barPos = blk.node.type.name === 'list_item' ? blk.pos + 1 : blk.pos
          const label = visibleBlocks.length > 1
            ? `AI 修订（同批共 ${visibleBlocks.length} 处）· 待采纳`
            : 'AI 修订 · 待采纳'
          decos.push(makeSuggestBar(group, `blk-${barPos}`, barPos, label))
        }
        prevEnd = blk.pos + blk.node.nodeSize
      }
    }

    return DecorationSet.create(doc, decos)
  }

  return new Plugin<DecorationSet>({
    state: {
      init: (_c, state) => build(state.doc),
      apply: (tr, set) => tr.docChanged ? build(tr.doc) : set,
    },
    props: { decorations(state) { return this.getState(state) } },
  })
}

export interface ClaimCheckItem {
  claim_id: string
  node_id: string
  sentence: string
  verdict: string
  reason: string
}

export const claimPluginKey = new PluginKey<{ checks: ClaimCheckItem[]; decos: DecorationSet }>('claim-checks')

function claimCheckPlugin() {
  const build = (doc: PMNode, checks: ClaimCheckItem[]) => {
    const flagged = checks.filter(c => c.verdict !== 'supported' && c.sentence && c.sentence.trim())
    if (flagged.length === 0) return DecorationSet.empty

    const decos: Decoration[] = []
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true
      const text = node.textContent
      for (const check of flagged) {
        const s = check.sentence.trim()
        let idx = text.indexOf(s)
        while (idx >= 0) {
          const from = charOffsetToPos(node, pos, idx)
          const to = charOffsetToPos(node, pos, idx + s.length)
          if (to > from) {
            decos.push(Decoration.inline(from, to, {
              class: 'claim-warn-text',
              'data-claim-id': check.claim_id,
              title: `论断核查 [${check.verdict}]：${check.reason}`,
            }))
          }
          idx = text.indexOf(s, idx + s.length)
        }
      }
      return true
    })
    return DecorationSet.create(doc, decos)
  }

  return new Plugin<{ checks: ClaimCheckItem[]; decos: DecorationSet }>({
    key: claimPluginKey,
    state: {
      init: () => ({ checks: [], decos: DecorationSet.empty }),
      apply(tr, prev) {
        const meta = tr.getMeta(claimPluginKey) as ClaimCheckItem[] | undefined
        if (meta) {
          return { checks: meta, decos: build(tr.doc, meta) }
        }
        if (tr.docChanged) {
          return { checks: prev.checks, decos: build(tr.doc, prev.checks) }
        }
        return prev
      },
    },
    props: {
      decorations(state) {
        return claimPluginKey.getState(state)?.decos ?? DecorationSet.empty
      },
    },
  })
}

/** 改块类型时保留 id 等属性（setBlockType 会丢掉）。 */
function setBlock(type: NodeType, level?: number): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection
    const targets: Array<{ pos: number; node: PMNode }> = []
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isTextblock) targets.push({ pos, node })
      return !node.isTextblock
    })
    if (targets.length === 0) return false
    if (dispatch) {
      const tr = state.tr
      for (const { pos, node } of targets) {
        const attrs: Record<string, unknown> = {
          id: node.attrs.id,
          align: node.attrs.align,
          style: node.attrs.style,
          suggest: node.attrs.suggest,
          suggest_group: node.attrs.suggest_group,
          suggest_of: node.attrs.suggest_of,
        }
        if (type.name === 'heading') attrs.level = level ?? 1
        tr.setNodeMarkup(pos, type, attrs)
      }
      dispatch(tr)
    }
    return true
  }
}

function toggleList(type: NodeType): Command {
  return (state, dispatch, view) => {
    const $from = state.selection.$from
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type === type) return liftListItem(schema.nodes.list_item!)(state, dispatch, view)
    }
    return wrapInList(type)(state, dispatch, view)
  }
}

const insertHardBreak: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break!.create()).scrollIntoView())
  return true
}

const insertTable: Command = (state, dispatch) => {
  const cell = (header: boolean) => schema.nodes.table_cell!.create({ header }, schema.nodes.paragraph!.create())
  const row = (header: boolean) => schema.nodes.table_row!.create(null, [cell(header), cell(header), cell(header)])
  const table = schema.nodes.table!.create(null, [row(true), row(false), row(false)])
  dispatch?.(state.tr.replaceSelectionWith(table).scrollIntoView())
  return true
}

/** 首行设为 / 取消表头（并标记表头为显式设定，导出时据此决定跨页重复）。 */
const toggleHeaderRow: Command = (state, dispatch) => {
  if (!isInTable(state)) return false
  const t = findTable(state.selection.$from)
  const first = t?.node.firstChild
  if (!t || !first) return false
  let allHeader = true
  first.forEach(cell => { if (!cell.attrs.header) allHeader = false })
  const on = !allHeader
  if (dispatch) {
    const tr = state.tr
    first.forEach((cell, off) => { tr.setNodeMarkup(t.pos + 2 + off, undefined, { ...cell.attrs, header: on }) })
    tr.setNodeMarkup(t.pos, undefined, { ...t.node.attrs, header_explicit: true })
    dispatch(tr)
  }
  return true
}

/**
 * 加列后让新格跟随所在行的表头状态（prosemirror-tables 新建的格不带 header 属性，表头行里会混进普通格）。
 * 加列不改变行数，所以按行号对回加列前每行是否整行为表头。
 */
const keepRowHeaders = (add: Command): Command => (state, dispatch, view) => {
  if (!isInTable(state)) return false
  const before = findTable(state.selection.$from)
  const rowHeader: boolean[] = []
  before?.node.forEach(row => { let all = row.childCount > 0; row.forEach(c => { if (!c.attrs.header) all = false }); rowHeader.push(all) })
  return add(state, dispatch && (tr => {
    const after = findTable(tr.selection.$from)
    if (after) {
      after.node.forEach((row, rowOff, r) => {
        row.forEach((cell, cellOff) => {
          if (cell.attrs.header !== rowHeader[r]) tr.setNodeMarkup(after.pos + 1 + rowOff + 1 + cellOff, undefined, { ...cell.attrs, header: rowHeader[r] ?? false })
        })
      })
    }
    dispatch(tr)
  }), view)
}

const rules = inputRules({
  rules: [
    new InputRule(/^(#{1,6})\s$/, (state, match, start, end) => {
      const $start = state.doc.resolve(start)
      if (!$start.parent.isTextblock || $start.parent.type.name !== 'paragraph') return null
      const pos = $start.before()
      return state.tr.delete(start, end).setNodeMarkup(pos, schema.nodes.heading, { ...$start.parent.attrs, level: match[1]!.length })
    }),
    wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list!),
    wrappingInputRule(/^(\d+)\.\s$/, schema.nodes.ordered_list!, m => ({ start: Number(m[1]) })),
  ],
})

export class Editor {
  readonly view: EditorView

  constructor(mount: HTMLElement, fragment: Y.XmlFragment, private readonly opts: EditorOptions) {
    const listItem = schema.nodes.list_item!
    const state = EditorState.create({
      schema,
      plugins: [
        ySyncPlugin(fragment),
        yUndoPlugin(),
        rules,
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Shift-Mod-z': redo,
          'Mod-b': toggleMark(schema.marks.bold!),
          'Mod-i': toggleMark(schema.marks.italic!),
          'Mod-u': toggleMark(schema.marks.underline!),
          'Shift-Enter': insertHardBreak,
          'Mod-Alt-0': setBlock(schema.nodes.paragraph!),
          'Mod-Alt-1': setBlock(schema.nodes.heading!, 1),
          'Mod-Alt-2': setBlock(schema.nodes.heading!, 2),
          'Mod-Alt-3': setBlock(schema.nodes.heading!, 3),
          Enter: splitListItem(listItem),
          Tab: chainCommands(goToNextCell(1), sinkListItem(listItem)),
          'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(listItem)),
        }),
        keymap(baseKeymap),
        dropCursor(),
        gapCursor(),
        tableEditing(),
        idPlugin,
        citePlugin,
        flashPlugin,
        suggestionDiffPlugin(opts.onSuggestion),
        claimCheckPlugin(),
      ],
    })
    const editor = this
    this.view = new EditorView(mount, {
      state,
      editable: () => !opts.readOnly,
      nodeViews: {
        citation: node => {
          const dom = document.createElement('sup')
          dom.className = 'cite'
          dom.dataset.cite = node.attrs.cite_id as string
          dom.textContent = '[?]'
          return { dom, ignoreMutation: () => true } satisfies NodeView
        },
        figure: (node, view, getPos) => {
          const dom = document.createElement('figure')
          if (node.attrs.id) dom.dataset.id = node.attrs.id as string
          if (node.attrs.suggest) dom.dataset.suggest = node.attrs.suggest as string
          const img = document.createElement('img')
          img.src = opts.assetUrl(node.attrs.asset_id as string)
          img.alt = (node.attrs.alt as string) ?? ''
          dom.appendChild(img)
          const cap = document.createElement('figcaption')
          cap.textContent = (node.attrs.caption as string) || '双击添加图注'
          if (!node.attrs.caption) cap.className = 'placeholder'
          dom.appendChild(cap)
          dom.title = '双击编辑图注'
          const assetId = node.attrs.asset_id as string
          if (opts.analysis && assetId) void opts.analysis.has(assetId).then(has => {
            if (!has) return
            const badge = document.createElement('button')
            badge.className = 'fig-prov'
            badge.type = 'button'
            badge.textContent = '来自分析'
            badge.title = '查看生成这张图的代码与数据'
            badge.onmousedown = e => e.preventDefault()
            badge.onclick = e => { e.stopPropagation(); opts.analysis!.show(assetId) }
            dom.appendChild(badge)
          })
          dom.addEventListener('dblclick', async () => {
            const pos = getPos()
            if (pos === undefined) return
            const caption = await askText({ title: '图注', label: '图注文字', value: (view.state.doc.nodeAt(pos)?.attrs.caption as string) ?? '', placeholder: '例如：图 1 主要终点的 Kaplan-Meier 曲线' })
            const at = getPos()
            const current = at === undefined ? null : view.state.doc.nodeAt(at)
            if (caption === null || at === undefined || !current) return
            view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...current.attrs, caption: caption.trim() }))
          })
          return { dom, ignoreMutation: () => true } satisfies NodeView
        },
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter(f => f.type.startsWith('image/'))
        if (files.length === 0) return false
        void editor.insertImages(files)
        return true
      },
      handleDrop: (view, event) => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])].filter(f => f.type.startsWith('image/'))
        if (files.length === 0) return false
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })
        if (at) view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at.pos))))
        void editor.insertImages(files)
        return true
      },
      handleClickOn: (_view, _pos, _node, _nodePos, event) => {
        const claimEl = (event.target as HTMLElement).closest('.claim-warn-text') as HTMLElement | null
        if (claimEl?.dataset.claimId) {
          opts.onClaimClick?.(claimEl.dataset.claimId)
          return true
        }
        const mark = (event.target as HTMLElement).closest('mark.comment') as HTMLElement | null
        if (mark?.dataset.thread) opts.onCommentClick(mark.dataset.thread)
        return false
      },
      // ySyncPlugin 在构造期间就会 dispatch（this.view 尚未赋值）：用 ProseMirror 绑定的 this（即 view）
      dispatchTransaction(this: EditorView, tr) {
        this.updateState(this.state.apply(tr))
        if (editor.view && (tr.selectionSet || tr.docChanged)) editor.reportSelection()
      },
    })
  }

  /** 当前选区是否在单个块内（可评论），给出锚点。 */
  private reportSelection(): void {
    const sel = this.view.state.selection
    const { from, to, empty, $from, $to } = sel
    // 拖选单元格（合并、设底纹等表格操作）不是要评论，不弹提示
    if (empty || sel instanceof CellSelection) { this.opts.onSelection(null); return }
    if (!$from.parent.isTextblock || $from.parent !== $to.parent) {
      // 与 Claude Docs 一致：评论只能落在一个段落内
      const start = this.view.coordsAtPos(from)
      this.opts.onSelection({ node_id: '', snippet: '', blocked: '评论只能选在一个段落内', rect: { top: start.top, left: start.left, width: 120 } })
      return
    }
    let nodeId: string | null = null
    for (let d = $from.depth; d > 0 && !nodeId; d--) nodeId = ($from.node(d).attrs.id as string | null) ?? null
    // 与服务端 paragraphText 同一规则：硬换行记作换行，引用不计文字
    const snippet = this.view.state.doc.textBetween(from, to, '\n', leaf => (leaf.type.name === 'hard_break' ? '\n' : ''))
    if (!nodeId || !snippet.trim()) { this.opts.onSelection(null); return }
    // 段落内偏移：服务端按位置打锚点（重复出现的文字也能锚准）
    const base = $from.start()
    const range = $from.parent.attrs.id === nodeId ? { from: from - base, to: to - base } : undefined
    const start = this.view.coordsAtPos(from)
    const end = this.view.coordsAtPos(to)
    this.opts.onSelection({ node_id: nodeId, snippet, range, rect: { top: start.top, left: start.left, width: Math.max(0, end.right - start.left) } })
  }

  /** AI 改动的块短暂高亮（Yjs 更新可能晚于提交事件到达，稍等再标）。 */
  flash(ids: string[]): void {
    if (ids.length === 0) return
    setTimeout(() => {
      this.view.dispatch(this.view.state.tr.setMeta(flashKey, ids).setMeta('addToHistory', false))
      setTimeout(() => this.view.dispatch(this.view.state.tr.setMeta(flashKey, 'clear').setMeta('addToHistory', false)), 2200)
    }, 250)
  }

  /** 在光标处插入引用（cite_id 已在服务端登记）。 */
  insertCitation(citeId: string): void {
    this.view.dispatch(this.view.state.tr.replaceSelectionWith(schema.nodes.citation!.create({ cite_id: citeId })).scrollIntoView())
    this.view.focus()
  }

  /** 上传图片并在光标处插入图块（逐张，保持顺序）。 */
  async insertImages(files: File[]): Promise<void> {
    for (const file of files) {
      const assetId = await this.opts.uploadImage(file)
      const figure = schema.nodes.figure!.create({ asset_id: assetId, alt: file.name.replace(/\.[^.]+$/, '') })
      this.view.dispatch(this.view.state.tr.replaceSelectionWith(figure).scrollIntoView())
    }
    this.view.focus()
  }

  /** 在光标处插入已归档的科研图表资产（自动附带图注与「来自分析」代码/数据溯源标记）。 */
  insertFigureAsset(assetId: string, caption = ''): void {
    const cleanCaption = caption.replace(/\.(svg|png|jpg|jpeg)$/i, '').trim()
    const figure = schema.nodes.figure!.create({
      asset_id: assetId,
      alt: cleanCaption || '科研图表',
      caption: cleanCaption,
    })
    this.view.dispatch(this.view.state.tr.replaceSelectionWith(figure).scrollIntoView())
    this.view.focus()
  }

  run(command: Command): boolean {
    const ok = command(this.view.state, this.view.dispatch, this.view)
    this.view.focus()
    return ok
  }

  private updateTextStyle(patch: { font_family?: string | null; font_size?: string | null; color?: string | null }): void {
    const state = this.view.state
    const { from, to, empty } = state.selection
    const textStyleType = schema.marks.text_style!
    const mergeAttrs = (existing?: Mark | null) => {
      const next = {
        font_family: patch.font_family !== undefined ? (patch.font_family || null) : ((existing?.attrs.font_family as string | null) ?? null),
        font_size: patch.font_size !== undefined ? (patch.font_size || null) : ((existing?.attrs.font_size as string | null) ?? null),
        color: patch.color !== undefined ? (patch.color || null) : ((existing?.attrs.color as string | null) ?? null),
      }
      return next.font_family || next.font_size || next.color ? next : null
    }
    let tr = state.tr
    if (empty) {
      const baseMarks = state.storedMarks || state.selection.$from.marks()
      const existing = textStyleType.isInSet(baseMarks)
      const next = mergeAttrs(existing)
      if (next) tr = tr.addStoredMark(textStyleType.create(next))
      else tr = tr.removeStoredMark(textStyleType)
    } else {
      const spans: Array<{ from: number; to: number; attrs: Record<string, unknown> | null }> = []
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isText) return
        const nFrom = Math.max(from, pos)
        const nTo = Math.min(to, pos + node.nodeSize)
        if (nFrom >= nTo) return
        const existing = textStyleType.isInSet(node.marks)
        spans.push({ from: nFrom, to: nTo, attrs: mergeAttrs(existing) })
      })
      for (const s of spans) {
        tr = tr.removeMark(s.from, s.to, textStyleType)
        if (s.attrs) tr = tr.addMark(s.from, s.to, textStyleType.create(s.attrs))
      }
    }
    this.view.dispatch(tr)
    this.view.focus()
  }

  readonly commands = {
    mark: (name: 'bold' | 'italic' | 'underline' | 'sup' | 'sub') => this.run(toggleMark(schema.marks[name]!)),
    setFontFamily: (fontFamily: string) => this.updateTextStyle({ font_family: fontFamily }),
    setFontSize: (fontSize: string) => this.updateTextStyle({ font_size: fontSize }),
    setTextColor: (color: string) => this.updateTextStyle({ color }),
    activeTextStyle: (): { fontFamily: string; fontSize: string; color: string } => {
      const state = this.view.state
      const marks = state.storedMarks || state.selection.$from.marks()
      const styleMark = marks.find(m => m.type === schema.marks.text_style!)
      return {
        fontFamily: (styleMark?.attrs.font_family as string) || '',
        fontSize: (styleMark?.attrs.font_size as string) || '',
        color: (styleMark?.attrs.color as string) || '',
      }
    },
    isMarkActive: (name: 'bold' | 'italic' | 'underline' | 'sup' | 'sub'): boolean => {
      const state = this.view.state
      const markType = schema.marks[name]
      if (!markType) return false
      const { from, to, empty } = state.selection
      if (empty) {
        return Boolean(markType.isInSet(state.storedMarks || state.selection.$from.marks()))
      }
      return state.doc.rangeHasMark(from, to, markType)
    },
    paragraph: () => this.run(setBlock(schema.nodes.paragraph!)),
    heading: (level: number) => this.run(setBlock(schema.nodes.heading!, level)),
    bulletList: () => this.run(toggleList(schema.nodes.bullet_list!)),
    orderedList: () => this.run(toggleList(schema.nodes.ordered_list!)),
    table: () => this.run(insertTable),
    /** 光标是否在表格里（工具栏据此显示表格工具）。 */
    inTable: (): boolean => isInTable(this.view.state),
    tableAddRowBefore: () => this.run(addRowBefore),
    tableAddRowAfter: () => this.run(addRowAfter),
    tableAddColBefore: () => this.run(keepRowHeaders(addColumnBefore)),
    tableAddColAfter: () => this.run(keepRowHeaders(addColumnAfter)),
    tableDeleteRow: () => this.run(deleteRow),
    tableDeleteCol: () => this.run(deleteColumn),
    /** 合并需要先拖选多个单元格。 */
    tableMerge: (): boolean => this.run(mergeCells),
    tableSplit: (): boolean => this.run(splitCell),
    tableToggleHeader: () => this.run(toggleHeaderRow),
    /** 底纹：hex 为 6 位十六进制（不带 #），'' 去掉底纹。 */
    tableBackground: (hex: string) => this.run(setCellAttr('background', hex.replace(/^#/, '').toUpperCase())),
    undo: () => this.run(undo),
    redo: () => this.run(redo),
  }

  /** 光标所在块的类型（工具栏状态）。 */
  blockType(): string {
    const parent = this.view.state.selection.$from.parent
    return parent.type.name === 'heading' ? `h${parent.attrs.level}` : 'p'
  }

  scrollToThread(thread: string): void {
    const el = this.view.dom.querySelector(`mark.comment[data-thread="${CSS.escape(thread)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  /** 服务端给出的引用编号规则（正文末尾有用户自己的文献表时接着编号）。 */
  setCitationNumbering(numbering: CitationNumbering): void {
    this.view.dispatch(this.view.state.tr.setMeta(citeKey, numbering))
  }

  setClaimChecks(checks: ClaimCheckItem[]): void {
    this.view.dispatch(this.view.state.tr.setMeta(claimPluginKey, checks))
  }

  destroy(): void {
    this.view.destroy()
  }
}
