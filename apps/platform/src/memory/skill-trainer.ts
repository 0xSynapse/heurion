import type { Complete } from '../harness/complete.ts'
import type { Documents } from '../model/runtime.ts'
import type { MemoryChangeRow, MemoryKind, MemoryRow, Store } from '../store/db.ts'
import {
  getDomainSkillAdapter,
  inferSkillDomain,
  type DomainSkillAdapter,
  type ExtractedSkillCandidate,
  type SkillDomain,
} from './domain-adapters.ts'
import { sensitiveReason } from './guard.ts'
import { MEMORY_KINDS, MemoryError, type MemoryService } from './service.ts'

export interface CorruptedReconstructionPair {
  exemplar: string
  skeleton: string
  reconstructed: string
  domain: SkillDomain
  /** 重建稿 x_hat 与黄金范例 x_0 的结构与规范对齐分（0~1，越高代表语义扩散重建损失越低）。 */
  alignmentScore: number
}

export interface SkillTrainResult {
  domain: SkillDomain
  pairs: CorruptedReconstructionPair[]
  proposed: MemoryRow[]
  changes: MemoryChangeRow[]
  filtered_leaks: Array<{ content: string; reason: string }>
}

/**
 * 跨领域自监督退化-重构技能训练引擎（Track A: Self-Supervised Corruption-and-Reconstruction Loop）：
 * 对应 `skill-training` (arXiv:2607.27557) 的四阶段闭环：
 * 1) Forward Corruption：将领域范例 x_0 退化为粗糙骨架 x_tilde；
 * 2) Skill-Routed Reconstruction：挂载当前激活记忆 S_t 重建输出 x_hat；
 * 3) Self-Contrastive Loss & Backward Credit Assignment：对比 (x_tilde, x_hat, x_0) 执行 create / update / merge；
 * 4) Instance–Skill Decoupling & PHI Guard：拦截具体样本量、精确结果值与患者隐私，且所有产出进入候选态（遵守 Invariant 3）。
 */
export class SkillTrainingService {
  constructor(
    private readonly store: Store,
    private readonly memory: MemoryService,
    private readonly docs: Documents,
    private readonly complete: Complete | null = null,
  ) {}

  available(): boolean {
    return true
  }

  /** 从平台内的文档（支持普通文档 doc 与演示文稿 deck）抽取核心段落执行自监督退化-重构训练。 */
  async trainFromDoc(
    owner: string,
    input: {
      docId: string
      domain?: SkillDomain
      maxSegments?: number
      useLlm?: boolean
    },
  ): Promise<SkillTrainResult> {
    if (!this.memory.active(owner)) {
      throw new MemoryError('memory_off', '记忆已停用或暂停')
    }
    const row = this.store.getDoc(input.docId)
    if (!row || row.deleted_at) {
      throw new MemoryError('not_found', `文档 ${input.docId} 不存在`)
    }
    const doc = this.docs.get(input.docId)
    const segments: string[] = []
    doc.descendants(n => {
      if (n.isTextblock && n.textContent.trim().length >= 30) {
        segments.push(n.textContent.trim())
      }
      return true
    })
    const docKind = row.kind === 'deck' ? 'deck' : 'doc'
    const domain = input.domain ?? inferSkillDomain(segments.slice(0, 3).join(' '), undefined, docKind)
    const picked = segments
      .sort((a, b) => b.length - a.length)
      .slice(0, Math.max(1, Math.min(input.maxSegments ?? 3, 6)))

    return this.trainFromExemplar(owner, {
      exemplarText: picked,
      domain,
      docId: input.docId,
      maxSegments: input.maxSegments,
      useLlm: input.useLlm,
    })
  }

  /** 从任意领域的黄金范例文本（论文段落、统计分析方案、幻灯片结构、代码/查询）执行退化-重构闭环训练。 */
  async trainFromExemplar(
    owner: string,
    input: {
      exemplarText: string | string[]
      domain?: SkillDomain
      docId?: string
      maxSegments?: number
      useLlm?: boolean
      precomputedSkeletons?: string[]
      skipBackward?: boolean
    },
  ): Promise<SkillTrainResult> {
    if (!this.memory.active(owner)) {
      throw new MemoryError('memory_off', '记忆已停用或暂停')
    }
    const rawList = Array.isArray(input.exemplarText)
      ? input.exemplarText
      : input.exemplarText
          .split(/\n{2,}/)
          .map(s => s.trim())
          .filter(s => s.length >= 20)

    const segments = rawList.slice(0, Math.max(1, Math.min(input.maxSegments ?? 3, 6)))
    const adapter = getDomainSkillAdapter(input.domain, segments.join('\n'))
    const domain = adapter.domain
    const useLlm = input.useLlm !== false && this.complete !== null

    const activeMemories = this.store
      .listMemories(owner, ['active'])
      .filter(m => {
        const tag = /^\[domain:([^\]]+)\]/i.exec(m.content)?.[1]?.toLowerCase()
        return !tag || tag === domain
      })

    const pairs: CorruptedReconstructionPair[] = []
    const allCandidates: ExtractedSkillCandidate[] = []

    for (const [idx, exemplar] of segments.entries()) {
      // 阶段 1：Forward Corruption C_domain(x_0) -> x_tilde
      const skeleton = input.precomputedSkeletons?.[idx] ?? (await this.forwardCorrupt(adapter, exemplar, useLlm))

      // 阶段 2：Skill-Routed Reconstruction (x_tilde, S_t) -> x_hat
      const activeBlock =
        activeMemories.length > 0
          ? `［当前领域已激活技能卡（${adapter.label}）］\n` +
            activeMemories.map(m => `- (${m.id}) ${m.content.replace(/^\[domain:[^\]]+\]\s*/i, '')}`).join('\n')
          : ''
      const reconstructed = await this.reconstruct(adapter, skeleton, activeBlock, activeMemories, useLlm)

      const alignmentScore = computeDomainAlignment(exemplar, reconstructed, activeMemories, domain)
      pairs.push({ exemplar, skeleton, reconstructed, domain, alignmentScore })

      // 阶段 3：Contrastive Loss & Backward Credit Assignment
      if (!input.skipBackward) {
        const candidates = await this.backwardCreditAssignment(
          adapter,
          skeleton,
          reconstructed,
          exemplar,
          activeMemories,
          useLlm,
        )
        allCandidates.push(...candidates)
      }
    }

    // 阶段 4：Instance–Skill Decoupling & PHI Guard + 落库（候选态隔离）
    return this.commitCandidates(owner, domain, adapter, pairs, allCandidates, activeMemories)
  }

  private async forwardCorrupt(adapter: DomainSkillAdapter, exemplar: string, useLlm: boolean): Promise<string> {
    if (useLlm && this.complete) {
      try {
        const { system, user } = adapter.corruptionPrompt(exemplar)
        const out = (await this.complete(system, user)).trim()
        if (out.length >= 10) return out
      } catch {
        /* 退回确定性退化算子 */
      }
    }
    return adapter.corruptDeterministic(exemplar)
  }

  private async reconstruct(
    adapter: DomainSkillAdapter,
    skeleton: string,
    activeBlock: string,
    activeMemories: MemoryRow[],
    useLlm: boolean,
  ): Promise<string> {
    if (useLlm && this.complete) {
      try {
        const { system, user } = adapter.reconstructionPrompt(skeleton, activeBlock)
        const out = (await this.complete(system, user)).trim()
        if (out.length >= 10) return out
      } catch {
        /* 退回确定性技能导向重建 */
      }
    }
    return deterministicSkillGuidedReconstruct(skeleton, activeMemories, adapter.domain)
  }

  private async backwardCreditAssignment(
    adapter: DomainSkillAdapter,
    skeleton: string,
    reconstructed: string,
    exemplar: string,
    activeMemories: MemoryRow[],
    useLlm: boolean,
  ): Promise<ExtractedSkillCandidate[]> {
    const activeSkillsSummary = activeMemories.map(m => ({ id: m.id, kind: m.kind, content: m.content }))
    if (useLlm && this.complete) {
      try {
        const { system, user } = adapter.backwardPrompt(skeleton, reconstructed, exemplar, activeSkillsSummary)
        const raw = await this.complete(system, user)
        const match = /\{[\s\S]*\}/.exec(raw.replace(/```(?:json)?/g, ''))
        if (match) {
          const parsed = JSON.parse(match[0]) as { ops?: Array<Record<string, unknown>> }
          const llmOut: ExtractedSkillCandidate[] = []
          for (const op of parsed.ops ?? []) {
            const action = op.op === 'update' || op.op === 'merge' ? op.op : 'create'
            const kind = (typeof op.kind === 'string' && op.kind in MEMORY_KINDS ? op.kind : 'style') as MemoryKind
            const rawContent = typeof op.content === 'string' ? op.content.trim() : ''
            if (!rawContent) continue
            const content = rawContent.startsWith('[domain:') ? rawContent : `[domain:${adapter.domain}] ${rawContent}`
            const targetIds = Array.isArray(op.target_ids)
              ? op.target_ids.filter((x): x is string => typeof x === 'string')
              : undefined
            const reason = typeof op.reason === 'string' && op.reason.trim() ? op.reason.trim() : `${adapter.label}范例对比自演进提炼`
            llmOut.push({ op: action, kind, content, target_ids: targetIds, reason })
          }
          if (llmOut.length > 0) {
            return [
              ...llmOut,
              ...adapter.extractContrastCandidates(skeleton, reconstructed, exemplar, activeSkillsSummary),
            ]
          }
        }
      } catch {
        /* 退回确定性对比特征提取 */
      }
    }
    return adapter.extractContrastCandidates(skeleton, reconstructed, exemplar, activeSkillsSummary)
  }

  private async commitCandidates(
    owner: string,
    domain: SkillDomain,
    adapter: DomainSkillAdapter,
    pairs: CorruptedReconstructionPair[],
    candidates: ExtractedSkillCandidate[],
    activeMemories: MemoryRow[],
  ): Promise<SkillTrainResult> {
    const proposed: MemoryRow[] = []
    const changes: MemoryChangeRow[] = []
    const filtered_leaks: Array<{ content: string; reason: string }> = []
    const pendingTargets = new Set(this.store.listMemoryChanges(owner, ['pending']).flatMap(c => c.target_ids))
    const seenContents = new Set<string>()

    for (const cand of candidates) {
      const normalized = cand.content.trim().replace(/\s+/g, ' ').slice(0, 300)
      if (!normalized || seenContents.has(normalized)) continue
      seenContents.add(normalized)

      // 1. PHI 患者隐私拦截守卫
      const phiReason = sensitiveReason(normalized)
      if (phiReason) {
        filtered_leaks.push({ content: normalized, reason: `PHI 隐私拦截：${phiReason}` })
        continue
      }

      // 2. 领域实例污染解耦守卫（Instance–Skill Decoupling Guard）
      const leakReason = adapter.hasInstanceLeakage(normalized)
      if (leakReason) {
        filtered_leaks.push({ content: normalized, reason: leakReason })
        continue
      }

      try {
        if (cand.op === 'create') {
          // 若当前已有高度重叠的同领域记忆，自动转为 strengthen (update) 或 merge
          const overlapping = activeMemories.filter(m => tokenOverlapRatio(m.content, normalized) >= 0.45)
          if (overlapping.length >= 2 && overlapping.every(m => !pendingTargets.has(m.id))) {
            const ids = overlapping.slice(0, 2).map(m => m.id)
            const ch = this.store.addMemoryChange({
              owner,
              action: 'merge',
              target_ids: ids,
              content: normalized,
              reason: `${cand.reason}（反向归因自动合并重叠技能）`,
            })
            changes.push(ch)
            ids.forEach(id => pendingTargets.add(id))
          } else {
            const r = await this.memory.propose(
              owner,
              { content: normalized, kind: cand.kind, scope: 'global', reason: cand.reason },
              { source: 'review', actor: 'ai' },
            )
            if (r.result === 'proposed') proposed.push(r.memory)
          }
        } else if (cand.op === 'update' && cand.target_ids?.length) {
          const targetId = cand.target_ids[0]!
          if (!pendingTargets.has(targetId) && activeMemories.some(m => m.id === targetId)) {
            const ch = this.store.addMemoryChange({
              owner,
              action: 'update',
              target_ids: [targetId],
              content: normalized,
              reason: cand.reason,
            })
            changes.push(ch)
            pendingTargets.add(targetId)
          }
        } else if (cand.op === 'merge' && (cand.target_ids?.length ?? 0) >= 2) {
          const validIds = cand.target_ids!.filter(id => !pendingTargets.has(id) && activeMemories.some(m => m.id === id))
          if (validIds.length >= 2) {
            const ch = this.store.addMemoryChange({
              owner,
              action: 'merge',
              target_ids: validIds,
              content: normalized,
              reason: cand.reason,
            })
            changes.push(ch)
            validIds.forEach(id => pendingTargets.add(id))
          }
        }
      } catch (err) {
        if (!(err instanceof MemoryError)) throw err
      }
    }

    return { domain, pairs, proposed, changes, filtered_leaks }
  }
}

/** 确定性技能导向重建器：根据当前已激活的领域技能卡对退化骨架执行规范化复原。 */
function deterministicSkillGuidedReconstruct(
  skeleton: string,
  activeMemories: MemoryRow[],
  domain: SkillDomain,
): string {
  const rulesText = activeMemories.map(m => m.content).join('\n')
  let out = skeleton
    .split(/\n+/)
    .map(l => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')

  if (domain === 'manuscript') {
    if (/P\s*=\s*\.\d|省略小数点前的\s*0/i.test(rulesText)) {
      out = out.replace(/\bp\s*=\s*0\.(\d+)/gi, 'P = .$1')
    }
    if (/95%\s*CI/i.test(rulesText)) {
      out = out.replace(/\b(HR|OR|RR)\s*=\s*(\d+\.\d+)\s*\((\d+\.\d+\s*[–-]\s*\d+\.\d+)/g, '$1 = $2 (95% CI, $3')
    }
    if (/consistent with prior studies/i.test(rulesText) && !/consistent with prior studies/i.test(out)) {
      out = `${out.replace(/[.。]+$/, '')}, consistent with prior studies.`
    }
  } else if (domain === 'biostats') {
    const extras: string[] = []
    if (/Median\s*\[IQR\]|偏态/i.test(rulesText)) {
      out = out.replace(/汇总统计量/g, 'median [IQR] (Mann-Whitney U test)')
    }
    if (/Fisher/i.test(rulesText)) {
      extras.push("Fisher's exact test for expected cell counts < 5.")
    }
    if (/Schoenfeld|EPV/i.test(rulesText)) {
      extras.push('Verify proportional hazards via Schoenfeld residuals (EPV >= 10).')
    }
    if (extras.length > 0) out = `${out} ${extras.join(' ')}`
  } else if (domain === 'deck') {
    const tags: string[] = []
    if (/Action Title|结论先行/i.test(rulesText)) tags.push('[action_title: Quantitative outcome headline]')
    if (/two_column|双栏/i.test(rulesText)) tags.push('[layout: two_column, max_bullets=4]')
    if (/chart|图表/i.test(rulesText)) tags.push('[chart_pairing: paired_visual_chart]')
    if (tags.length > 0) out = `${tags.join(' ')}\n${out}`
  }

  return out
}

/** 计算重建输出 x_hat 与黄金范例 x_0 的结构与风格对齐度（0~1）。 */
export function computeDomainAlignment(
  exemplar: string,
  reconstructed: string,
  activeMemories: MemoryRow[],
  domain: SkillDomain,
): number {
  const baseOverlap = tokenOverlapRatio(exemplar, reconstructed)
  let featureChecks = 0
  let featureHits = 0

  if (domain === 'manuscript') {
    const checks: Array<[RegExp, RegExp]> = [
      [/\(95%\s*CI/i, /\(95%\s*CI/i],
      [/\bP\s*=\s*\.\d+/, /\bP\s*=\s*\.\d+/],
      [/consistent with prior/i, /consistent with prior/i],
    ]
    for (const [exRe, recRe] of checks) {
      if (exRe.test(exemplar)) {
        featureChecks++
        if (recRe.test(reconstructed)) featureHits++
      }
    }
  } else if (domain === 'biostats') {
    const checks: Array<[RegExp, RegExp]> = [
      [/median\s*\[IQR\]/i, /median\s*\[IQR\]/i],
      [/Fisher/i, /Fisher/i],
      [/Schoenfeld|EPV/i, /Schoenfeld|EPV/i],
    ]
    for (const [exRe, recRe] of checks) {
      if (exRe.test(exemplar)) {
        featureChecks++
        if (recRe.test(reconstructed)) featureHits++
      }
    }
  } else if (domain === 'deck') {
    const checks: Array<[RegExp, RegExp]> = [
      [/Action Title|结论先行|reduced|increased|降低了|提升了/i, /action_title|reduced|increased|降低了|提升了/i],
      [/two_column|双栏/i, /two_column|双栏/i],
      [/chart|图表/i, /chart|图表/i],
    ]
    for (const [exRe, recRe] of checks) {
      if (exRe.test(exemplar)) {
        featureChecks++
        if (recRe.test(reconstructed)) featureHits++
      }
    }
  }

  const featureScore = featureChecks > 0 ? featureHits / featureChecks : baseOverlap
  const skillBonus = Math.min(0.15, activeMemories.length * 0.05)
  return Number(Math.min(1, 0.45 * baseOverlap + 0.4 * featureScore + skillBonus).toFixed(3))
}

function tokenOverlapRatio(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      (s.toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{2}/g) ?? []).filter(
        w => !['domain', 'manuscript', 'biostats', 'deck', 'general_mcp'].includes(w),
      ),
    )
  const setA = tokenize(a)
  const setB = tokenize(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const t of setA) {
    if (setB.has(t)) inter++
  }
  return inter / Math.min(setA.size, setB.size)
}
