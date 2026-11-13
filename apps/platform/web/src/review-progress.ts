/**
 * 深度审稿的进度与覆盖范围（docs/design/REVIEW_QUALITY.md）：后台任务每一步的状态，结束后说明审了什么、跳过了什么。
 */

export interface ReviewStepState { step: string; status: 'running' | 'done' | 'skipped'; done?: number; total?: number; detail?: string }
export interface ReviewCoverage { words: number; sections_total: number; sections_reviewed: number; sections_skipped: string[]; tables_total: number; tables_checked: number; llm: boolean; verifier: boolean }
interface JobState { status: 'running' | 'done' | 'error'; steps: Record<string, ReviewStepState>; elapsed_ms: number; result?: any; error?: string }

const STEPS: Array<[string, string]> = [
  ['read', '通读全文：切分章节、提取表格与样本量'],
  ['rules', '规则核查：分母与百分比、置信区间、方法与结果、结论夸大'],
  ['sections', '逐章节模型审稿'],
  ['verify', '全文复核：删去不成立的意见'],
  ['synthesize', '合成意见并锚定到原文'],
]

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export function renderReviewProgress(el: HTMLElement, job: Pick<JobState, 'steps' | 'elapsed_ms'>, onCancel: () => void): void {
  const firstPending = STEPS.findIndex(([k]) => !job.steps[k])
  const rows = STEPS.map(([k, label], i) => {
    const s = job.steps[k]
    const state = s?.status ?? (i === firstPending && !Object.values(job.steps).some(x => x.status === 'running') ? 'running' : 'pending')
    const mark = state === 'done' ? '✓' : state === 'skipped' ? '–' : state === 'running' ? '<span class="subagent-pulse"></span>' : '○'
    const count = s?.total ? ` ${s.done ?? 0}/${s.total}` : ''
    const detail = s?.detail ? `<span class="muted">（${esc(s.detail)}）</span>` : state === 'skipped' ? '<span class="muted">（跳过）</span>' : ''
    return `<li class="rv-step rv-${state}"><span class="rv-mark">${mark}</span><span>${esc(label)}${count}${detail}</span></li>`
  }).join('')
  el.innerHTML = `<div class="rv-progress"><div class="rv-progress-head"><b>正在深度审稿</b><span class="muted">已用 ${Math.round(job.elapsed_ms / 1000)} 秒</span>
    <button type="button" class="small-btn quiet" id="deepReviewCancel">停止等待</button></div><ol class="rv-steps">${rows}</ol></div>`
  el.querySelector('#deepReviewCancel')?.addEventListener('click', onCancel)
}

/** 轮询任务直到结束；取消时抛 AbortError（服务端照常跑完，结果以批注出现）。 */
export async function pollReviewJob(
  api: <T = any>(path: string, opts?: RequestInit) => Promise<T>,
  docId: string,
  jobId: string,
  signal: AbortSignal,
  onUpdate: (job: JobState) => void,
): Promise<any> {
  for (;;) {
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    const job = await api<JobState>(`/api/docs/${docId}/deep-review/jobs/${jobId}`, { signal })
    onUpdate(job)
    if (job.status === 'done') return job.result
    if (job.status === 'error') throw new Error(job.error || '审稿失败')
    await new Promise(r => setTimeout(r, 1500))
  }
}

/** 覆盖范围的一句话：审了几节、几张表、跳过了什么。 */
export function coverageText(c: ReviewCoverage | undefined): string {
  if (!c) return ''
  const parts = [`审了 ${c.sections_reviewed}/${c.sections_total} 个章节`, `核对 ${c.tables_checked}/${c.tables_total} 张表格`]
  if (!c.llm) parts.push('未使用模型（只做了规则核查）')
  else if (!c.verifier) parts.push('未做全文复核')
  const skipped = c.sections_skipped.slice(0, 4).join('、') + (c.sections_skipped.length > 4 ? ' 等' : '')
  return parts.join('，') + (c.sections_skipped.length ? `；跳过：${skipped}` : '') + '；图片未核对'
}
