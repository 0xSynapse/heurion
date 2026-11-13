import type { Node as PMNode } from 'prosemirror-model'
import { blockRegions, hasHumanText, movedFrom, movedPool, type ProvRegion } from '../model/provenance.ts'
import { allNumbers, checkableNumbers, numberObserved } from './numbers.ts'

/**
 * 来源等级第 2 期的写入检查（docs/design/PROVENANCE.md 2.2–2.3、第 3 节 P1 / P3）。
 *
 * - 规则一：AI 的写入不能降低来源等级。改到人写的文字时，只有「安全小改」可以直接生效；
 *   其余（以及删掉含人写文字的整块）整批转为待采纳修订，由人采纳 = 确认。这不是报错，AI 不必重试。
 * - 规则二：新写入的数字要有出处（文档里已有、本轮看到过、或同一句引用的文献原文里有）；
 *   新插入的引用要有保存的摘要或全文。
 */

export const SAFE_EDIT = { maxChars: 40, maxRegions: 5 }

/** 改动里出现这些就不算安全小改：数字、百分号、比较符号 */
const RISKY_SYMBOLS = /[0-9%<>≤≥=±]/
/** 否定与措辞强度（中英）：改了就可能改变主张 */
const RISKY_WORDS = /[不未无非没否勿]|可能|或许|也许|显著|明显|证实|证明|确定|肯定|必然|导致|引起|提示|表明|说明|有效|无效|优于|劣于|\b(?:not|no|never|none|neither|nor|without|cannot|may|might|could|possibly|probably|likely|unlikely|significant(?:ly)?|prove[sdn]?|proving|demonstrate[sd]?|confirm(?:s|ed)?|establish(?:es|ed)?|cause[sd]?|suggest(?:s|ed)?|indicate[sd]?|effective|ineffective|superior|inferior)\b/i

export interface HumanTouch { blockId: string; region: ProvRegion; safe: boolean; reason?: string }

export interface ProvenanceAssessment {
  /** 改到人写文字的地方 */
  touches: HumanTouch[]
  /** 被整块删掉、含人写文字的块 */
  removedHuman: string[]
  /** 全部改动区域（规则二用） */
  regions: Array<{ blockId: string; region: ProvRegion }>
  /** 新插入的引用 id（按块对比） */
  newCites: string[]
}

/** 文本块：改前按 id；改后按「它取代的原块」（修订版用 suggest_of），跳过待删除的原文版本。 */
function blocks(doc: PMNode, after: boolean): Map<string, PMNode> {
  const map = new Map<string, PMNode>()
  doc.descendants(n => {
    if (!n.isTextblock) return true
    if (after && n.attrs.suggest === 'delete') return false
    const key = (after ? n.attrs.suggest_of ?? n.attrs.id : n.attrs.id) as string | null
    if (key) map.set(key, n)
    return false
  })
  return map
}

const citesIn = (node: PMNode): Set<string> => {
  const out = new Set<string>()
  node.descendants(n => { if (n.type.name === 'citation' && n.attrs.cite_id) out.add(String(n.attrs.cite_id)); return true })
  return out
}

/**
 * used：同一回合（或外部智能体的同一会话）里，这份文档此前已经直接生效的「改到人写文字」处数。
 * 安全小改的处数上限按回合累计，AI 不能把改动拆成多批绕过。
 */
export function assessProvenance(before: PMNode, after: PMNode, used = 0): ProvenanceAssessment {
  const was = blocks(before, false)
  const now = blocks(after, true)
  const touches: HumanTouch[] = []
  const regions: ProvenanceAssessment['regions'] = []
  const newCites = new Set<string>()
  // 待删除的原文版本仍在文档里（建议模式）：不算删掉
  const pendingDelete = new Set<string>()
  after.descendants(n => { if (n.isTextblock && n.attrs.suggest === 'delete' && n.attrs.id) pendingDelete.add(String(n.attrs.id)); return !n.isTextblock })

  // 合并段落等跨块搬运：原样搬来的人写文字不算改动，被搬走文字的块也不算删掉
  const pool = movedPool(before, after)
  const movedCites = new Set<string>()
  for (const [id, n] of was) if (!now.has(id)) for (const c of citesIn(n)) movedCites.add(c)
  for (const [key, node] of now) {
    const old = was.get(key) ?? null
    if (old && old.content.eq(node.content)) continue
    const oldCites = old ? citesIn(old) : new Set<string>()
    for (const c of citesIn(node)) if (!oldCites.has(c) && !movedCites.has(c)) newCites.add(c)
    for (const region of blockRegions(old, node)) {
      const moved = !region.deleted && movedFrom(pool, region.inserted) !== null
      if (moved) continue
      regions.push({ blockId: key, region })
      if (region.deletesHuman || region.insertsIntoHuman) touches.push({ blockId: key, region, safe: true })
    }
  }
  const afterText = after.textContent
  const removedHuman = [...was]
    .filter(([id, n]) => !now.has(id) && !pendingDelete.has(id) && hasHumanText(n) && !afterText.includes(n.textContent.trim()))
    .map(([id]) => id)

  for (const t of touches) {
    const { deleted, inserted, touchesAtom } = t.region
    if (touchesAtom) Object.assign(t, { safe: false, reason: '涉及引用、测量或 Word 结构' })
    else if (deleted.length > SAFE_EDIT.maxChars || inserted.length > SAFE_EDIT.maxChars) Object.assign(t, { safe: false, reason: `单处改动超过 ${SAFE_EDIT.maxChars} 个字符` })
    else if (RISKY_SYMBOLS.test(deleted) || RISKY_SYMBOLS.test(inserted)) Object.assign(t, { safe: false, reason: '涉及数字或比较符号' })
    else if (RISKY_WORDS.test(deleted) || RISKY_WORDS.test(inserted)) Object.assign(t, { safe: false, reason: '涉及否定词或措辞强度' })
  }
  if (touches.length > 0 && used + touches.length > SAFE_EDIT.maxRegions) {
    const why = used > 0 ? `本轮直接改动人写的文字累计超过 ${SAFE_EDIT.maxRegions} 处` : `一次改动人写的文字超过 ${SAFE_EDIT.maxRegions} 处`
    for (const t of touches) Object.assign(t, { safe: false, reason: t.reason ?? why })
  }
  return { touches, removedHuman, regions, newCites: [...newCites] }
}

/** 规则一：这批改动要不要整批转为待采纳修订；返回原因（不转时为空）。 */
export function suggestReasons(a: ProvenanceAssessment, safeEdits: boolean): string[] {
  const out = new Set<string>()
  if (a.removedHuman.length) out.add('删除了含人写文字的段落')
  for (const t of a.touches) {
    if (!safeEdits) out.add('改到了人写的文字（本文档关闭了安全小改）')
    else if (!t.safe) out.add(`改到了人写的文字：${t.reason}`)
  }
  return [...out]
}

/**
 * 一轮里来源规则起作用的记录 → 给用户看的「保护记录」（每类一行，平常的话，不提内部代码）。
 * 没有记录时返回空数组（不显示）。
 */
export function protectionSummary(events: Array<{ kind: string; detail: string }>): string[] {
  const by = new Map<string, string[]>()
  for (const e of events) { if (!by.has(e.kind)) by.set(e.kind, []); by.get(e.kind)!.push(e.detail) }
  const n = (k: string) => by.get(k)?.length ?? 0
  const sample = (k: string) => [...new Set(by.get(k)!.flatMap(d => d.split('、')))].slice(0, 3).join('、')
  const out: string[] = []
  if (n('suggest')) out.push(`有 ${n('suggest')} 批修改改到了你写的文字，已转为待采纳修订，采纳后生效`)
  if (n('conflict_user_edited')) out.push(`保留了你在 AI 读过之后改的内容（${n('conflict_user_edited')} 次）`)
  if (n('unobserved_number')) out.push(`拦下了找不到出处的数字：${sample('unobserved_number')}`)
  if (n('unread_citation')) out.push(`拦下了 ${n('unread_citation')} 次未读原文就插入的引用`)
  const cite = n('existing_citation') + n('citation_not_registered') + n('citation_unknown')
  if (cite) out.push(`拦下了 ${cite} 次不规范的引用改动`)
  const measure = n('measurement_lost') + n('bare_measurement')
  if (measure) out.push(`拦下了 ${measure} 次没有绑定来源的测量数字`)
  if (n('unverifiable')) out.push(`请对照文献全文核对这些数字（所引文献只有摘要）：${sample('unverifiable')}`)
  return out
}

export interface NumberCheck {
  /** 没有出处的数字：拒绝 */
  unsourced: Array<{ number: string; blockId: string }>
  /** 同一句引用的文献只有摘要、摘要里没有：交给用户确认，不拒绝 */
  unverifiable: Array<{ number: string; blockId: string; cites: string[] }>
}

/**
 * 规则二（数字）：新写入的需核对数字要么在改前的文档里、要么本轮看到过、要么在同一句所引文献的原文里。
 * source(citeId) 返回该文献保存的原文与是否全文；没有保存原文时返回 null。
 */
export function checkNumbers(
  before: PMNode,
  a: ProvenanceAssessment,
  seen: number[],
  source: (citeId: string) => { text: string; full: boolean } | null,
): NumberCheck {
  const docNums = allNumbers(before.textContent)
  const out: NumberCheck = { unsourced: [], unverifiable: [] }
  const cache = new Map<string, number[]>()
  const nums = (cite: string) => {
    if (!cache.has(cite)) { const s = source(cite); cache.set(cite, s ? allNumbers(s.text) : []) }
    return cache.get(cite)!
  }
  for (const { blockId, region } of a.regions) {
    for (const piece of region.pieces) {
      for (const n of checkableNumbers(piece.text)) {
        if (numberObserved(n, docNums) || numberObserved(n, seen)) continue
        if (piece.cites.some(c => numberObserved(n, nums(c)))) continue
        const abstractOnly = piece.cites.filter(c => { const s = source(c); return !!s && !s.full })
        if (abstractOnly.length) out.unverifiable.push({ number: n.raw, blockId, cites: abstractOnly })
        else out.unsourced.push({ number: n.raw, blockId })
      }
    }
  }
  return out
}
