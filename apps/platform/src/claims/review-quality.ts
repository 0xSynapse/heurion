import { randomUUID } from 'node:crypto'
import { withUsageScope, type CompleteUsage } from '../harness/complete.ts'
import type { Store } from '../store/db.ts'
import type { FourStageReviewResult, ReviewProgress, ReviewStep } from './service.ts'

/**
 * 深度审稿质量记录（docs/design/REVIEW_QUALITY.md）。
 *
 * 不另跑测试集：每次真实审稿都记下耗时、按阶段的模型用量、是否开着深度思考、覆盖范围与意见数；
 * 每条意见记下医生后来是采纳、驳回还是没处理。管理员看质量面板；近几次的指标明显低于近期水平时告警
 * （2026-11-11「flash 默认关闭思考」那类退化，第一天就能发现）。这些数据也是自演进改动前回放验证的依据。
 */

type StageUsage = { ms: number; calls: number; input_tokens: number; output_tokens: number }

export interface TrackedReview<T> { runId: string; result: T; stages: Record<string, StageUsage> }

/**
 * 跑一次审稿并记录。run 收到 onProgress，进度同时用来把模型用量记到当前阶段；
 * 审稿出错也记一行（status = error）再抛出。
 */
export async function trackReview(
  store: Store,
  input: { docId: string; owner: string; rev: () => number },
  run: (onProgress: (p: ReviewProgress) => void) => Promise<FourStageReviewResult>,
  onProgress?: (p: ReviewProgress) => void,
): Promise<TrackedReview<FourStageReviewResult>> {
  const runId = `rv${randomUUID().replace(/-/g, '').slice(0, 10)}`
  store.startReviewRun({ id: runId, doc_id: input.docId, owner: input.owner })
  const t0 = Date.now()
  const stages: Record<string, StageUsage> = {}
  let current: ReviewStep = 'read'
  let stageStart = Date.now()
  let model: string | null = null
  let thinkingCalls = 0
  let calls = 0
  const stage = (s: string) => (stages[s] ??= { ms: 0, calls: 0, input_tokens: 0, output_tokens: 0 })
  const record = (u: CompleteUsage) => {
    const s = stage(current)
    s.calls++; s.input_tokens += u.input_tokens; s.output_tokens += u.output_tokens
    model = u.model; calls++; if (u.thinking !== false) thinkingCalls++
  }
  const progress = (p: ReviewProgress) => {
    if (p.step !== current && p.status === 'running') {
      stage(current).ms += Date.now() - stageStart
      current = p.step
      stageStart = Date.now()
    }
    try { onProgress?.(p) } catch { /* 进度显示不影响审稿 */ }
  }
  try {
    const result = await withUsageScope(record, () => run(progress))
    stage(current).ms += Date.now() - stageStart
    const comments = result.stage4_deduplicated_comments
    store.finishReviewRun(runId, {
      status: 'done', duration_ms: Date.now() - t0, model, thinking: calls ? thinkingCalls === calls : null, stages,
      coverage: result.coverage ?? {}, words: result.coverage?.words ?? 0, raw_candidates: result.stage3_raw_candidates,
      verifier_rejected: result.verifier_rejected ?? 0, comments: comments.length,
    })
    store.addReviewFindings(runId, input.docId, input.rev(), comments.filter(c => c.comment_id).map(c => ({
      comment_id: c.comment_id!, node_id: c.node_id, category: c.category, severity: c.severity, source: c.source_pass,
    })))
    return { runId, result, stages }
  } catch (err) {
    store.finishReviewRun(runId, {
      status: 'error', duration_ms: Date.now() - t0, model, thinking: calls ? thinkingCalls === calls : null, stages,
      coverage: {}, words: 0, raw_candidates: 0, verifier_rejected: 0, comments: 0, error: (err as Error).message?.slice(0, 500) ?? String(err),
    })
    throw err
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

interface RunRow { id: string; status: string; started_at: string; duration_ms: number | null; model: string | null; thinking: number | null; stages: string; coverage: string; words: number; comments: number; raw_candidates: number; verifier_rejected: number; error: string | null }

const perK = (v: number, words: number) => words > 0 ? (v * 1000) / words : null
const outputTokens = (r: RunRow) => Object.values(JSON.parse(r.stages || '{}') as Record<string, StageUsage>).reduce((s, x) => s + x.output_tokens, 0)

/** 一次审稿的「每千字」指标（不同长度的稿件可比）。 */
function normalized(r: RunRow) {
  return {
    ms_per_k: perK(r.duration_ms ?? 0, r.words),
    out_tokens_per_k: perK(outputTokens(r), r.words),
    comments_per_k: perK(r.comments, r.words),
  }
}

/**
 * 退化检测：最近 3 次完成的审稿（中位数）与之前 14 天（至少 5 次）的中位数比，
 * 耗时、输出 token、意见数三项里有两项低于基线的 40%，或深度思考从开着变成关着 → 返回告警说明。
 */
export function detectRegression(store: Store): string | null {
  const runs = (store.reviewRuns(17) as RunRow[]).filter(r => r.status === 'done' && r.words > 300)
  if (runs.length < 8) return null
  const recent = runs.slice(0, 3)
  const base = runs.slice(3).filter(r => Date.now() - Date.parse(r.started_at) <= 17 * 86400_000)
  if (base.length < 5) return null
  const m = (rows: RunRow[], k: keyof ReturnType<typeof normalized>) => median(rows.map(r => normalized(r)[k]).filter((x): x is number => x !== null))
  const drops: string[] = []
  for (const [k, label] of [['ms_per_k', '耗时'], ['out_tokens_per_k', '输出 token'], ['comments_per_k', '意见数']] as const) {
    const now = m(recent, k)
    const was = m(base, k)
    if (now !== null && was !== null && was > 0 && now < 0.4 * was) drops.push(`${label}（每千字）从 ${was.toFixed(1)} 降到 ${now.toFixed(1)}`)
  }
  const thinkingWas = base.filter(r => r.thinking === 1).length / base.length
  const thinkingNow = recent.filter(r => r.thinking === 1).length / recent.length
  if (thinkingWas >= 0.8 && thinkingNow === 0) drops.push('深度思考从开着变成了关着')
  if (drops.length >= 2 || drops.some(d => d.includes('深度思考'))) return `最近 3 次深度审稿与之前 ${base.length} 次相比：${drops.join('；')}。可能是模型配置或审稿流程被改动，请检查最近的提交。`
  return null
}

/** 管理员的审稿质量面板：最近 days 天的汇总、每天的走势、按类别的意见结局。 */
export function reviewQualityReport(store: Store, days = 30) {
  const runs = store.reviewRuns(days) as RunRow[]
  const done = runs.filter(r => r.status === 'done')
  const outcomes = store.reviewFindingOutcomes(done.map(r => r.id))
  const count = (o: string[]) => outcomes.filter(x => o.includes(x.outcome)).length
  const accepted = count(['accepted', 'accepted_implicit'])
  const rejected = count(['rejected'])
  const coverageOf = (r: RunRow) => { try { return JSON.parse(r.coverage || '{}') as { sections_total?: number; sections_reviewed?: number; tables_total?: number; tables_checked?: number } } catch { return {} } }
  const byDay = new Map<string, RunRow[]>()
  for (const r of done) { const d = r.started_at.slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(r) }
  const med = (rows: RunRow[], k: keyof ReturnType<typeof normalized>) => median(rows.map(r => normalized(r)[k]).filter((x): x is number => x !== null))
  const categories = new Map<string, { accepted: number; rejected: number; dismissed: number; open: number }>()
  for (const o of outcomes) {
    const c = categories.get(o.category) ?? { accepted: 0, rejected: 0, dismissed: 0, open: 0 }
    if (o.outcome.startsWith('accepted')) c.accepted++
    else if (o.outcome === 'rejected') c.rejected++
    else if (o.outcome === 'dismissed') c.dismissed++
    else if (o.outcome === 'open') c.open++
    categories.set(o.category, c)
  }
  return {
    days,
    runs: runs.length,
    errors: runs.filter(r => r.status === 'error').length,
    median_duration_s: (median(done.map(r => r.duration_ms ?? 0)) ?? 0) / 1000,
    median_ms_per_k: med(done, 'ms_per_k'),
    median_out_tokens_per_k: med(done, 'out_tokens_per_k'),
    median_comments_per_k: med(done, 'comments_per_k'),
    thinking_share: done.length ? done.filter(r => r.thinking === 1).length / done.length : null,
    models: [...new Set(done.map(r => r.model).filter(Boolean))],
    coverage: {
      sections: done.reduce((s, r) => s + (coverageOf(r).sections_reviewed ?? 0), 0),
      sections_total: done.reduce((s, r) => s + (coverageOf(r).sections_total ?? 0), 0),
      tables: done.reduce((s, r) => s + (coverageOf(r).tables_checked ?? 0), 0),
      tables_total: done.reduce((s, r) => s + (coverageOf(r).tables_total ?? 0), 0),
    },
    findings: {
      total: outcomes.length, accepted, rejected,
      dismissed: count(['dismissed']), open: count(['open']), deleted: count(['deleted']),
      /** 精确率（下限估计）：明确表态的意见里被采纳的比例；没处理与不了了之的不计入 */
      precision: accepted + rejected > 0 ? accepted / (accepted + rejected) : null,
    },
    by_category: [...categories].map(([category, c]) => ({ category, ...c })),
    daily: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, rows]) => ({
      day, runs: rows.length, median_ms_per_k: med(rows, 'ms_per_k'), median_out_tokens_per_k: med(rows, 'out_tokens_per_k'), median_comments_per_k: med(rows, 'comments_per_k'),
      thinking_share: rows.filter(r => r.thinking === 1).length / rows.length,
    })),
    alert: detectRegression(store),
  }
}
