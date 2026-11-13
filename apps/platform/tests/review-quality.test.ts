/**
 * 深度审稿质量记录（docs/design/REVIEW_QUALITY.md）：按阶段的用量、覆盖范围、进度、意见结局、退化告警。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { detectRegression, reviewQualityReport, trackReview } from '../src/claims/review-quality.ts'
import { ClaimService, type ReviewProgress } from '../src/claims/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { makeComplete } from '../src/harness/complete.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

const PAPER = `# Abstract

A total of 120 patients were enrolled. The pCR rate was 37% (11/30).

# Methods

## Statistical analysis

Continuous variables were compared using t tests.

# Results

Among 120 patients, 45 (37.5%) achieved response.

# Acknowledgements

We thank the nurses.`

afterEach(() => { vi.unstubAllGlobals() })

/** 假的模型上游：每次调用回固定用量。 */
function stubModel(text = '[]', usage = { input_tokens: 1000, output_tokens: 200 }) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ content: [{ type: 'text', text }], usage }), { status: 200 }))
  return makeComplete({ upstream: 'https://example.test/v1', apiKey: 'k', model: 'deepseek-flash' })!
}

describe('一次审稿的记录', () => {
  it('真实审稿流程：逐步上报进度，按阶段记用量，结果带覆盖范围', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const row = docs.create({ owner: 'u1', title: 't', content: schema.node('doc', null, parseBlocks(PAPER)) })
    const claims = new ClaimService(docs, {} as PubMedClient)
    const complete = stubModel()
    const steps: ReviewProgress[] = []
    const { runId, result, stages } = await trackReview(store, { docId: row.id, owner: 'u1', rev: () => docs.rev(row.id) },
      onP => claims.deepReview(row.id, { mode: 'heurion_evolved', owner: 'u1', anchorComments: true, complete, onProgress: onP }), p => steps.push(p))
    expect(steps.map(s => `${s.step}:${s.status}`)).toEqual(expect.arrayContaining(['read:running', 'read:done', 'rules:done', 'sections:running', 'sections:done', 'synthesize:done']))
    expect(stages.sections!.calls).toBeGreaterThan(0)
    expect(stages.sections!.output_tokens).toBe(200 * stages.sections!.calls)
    // 回归：以前「Acknowledgements」等样板章节因正则的词尾边界匹配不上，被送去审稿
    expect(result.coverage!.sections_skipped).toContain('Acknowledgements')
    expect(result.coverage!.sections_reviewed).toBeLessThan(result.coverage!.sections_total)
    expect(result.coverage!.llm).toBe(true)
    const [run] = store.reviewRuns(1)
    expect(run).toMatchObject({ id: runId, status: 'done', model: 'deepseek-flash', thinking: 1 })
    expect(run!.words).toBeGreaterThan(20)
  })

  it('审稿出错也记一行', async () => {
    const store = new Store(':memory:')
    await expect(trackReview(store, { docId: 'd1', owner: 'u1', rev: () => 0 }, async () => { throw new Error('模型服务 500') })).rejects.toThrow()
    expect(store.reviewRuns(1)[0]).toMatchObject({ status: 'error', error: '模型服务 500' })
  })
})

describe('意见的结局', () => {
  it('明确表态按记录；其余按批注现状推断（解决且改过 = 采纳，解决没改 = 不了了之，开着 = 未处理）', () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const row = docs.create({ owner: 'u1', title: 't', content: schema.node('doc', null, parseBlocks(PAPER)) })
    const ids: string[] = []
    docs.get(row.id).forEach(n => ids.push(n.attrs.id as string))
    const c = (node: string) => store.addComment({ doc_id: row.id, node_id: node, snippet: 'x' }).id
    const [a, b, d, e] = [c(ids[1]!), c(ids[1]!), c(ids[4]!), c(ids[4]!)]
    store.startReviewRun({ id: 'r1', doc_id: row.id, owner: 'u1' })
    store.finishReviewRun('r1', { status: 'done', duration_ms: 1000, model: 'm', thinking: true, stages: {}, coverage: {}, words: 1000, raw_candidates: 4, verifier_rejected: 0, comments: 4 })
    store.addReviewFindings('r1', row.id, docs.rev(row.id), [a, b, d, e].map((id, i) => ({ comment_id: id, node_id: i < 2 ? ids[1]! : ids[4]!, category: 'internal_inconsistency', severity: 'major', source: 'llm_stage3' })))
    store.setReviewFindingOutcome(a, 'rejected')
    // b：医生改了那段再点解决 → 隐式采纳
    new OpService(docs).edit({ doc_id: row.id, base_rev: docs.rev(row.id), mode: 'apply', ops: [{ op: 'replace_text', id: ids[1]!, find: '37%', replace: '36.7%' }] }, { actor: 'user', turnId: null })
    store.setCommentStatus(row.id, b, 'resolved', 'user')
    // d：没改就点解决
    store.setCommentStatus(row.id, d, 'resolved', 'user')
    const out = Object.fromEntries(store.reviewFindingOutcomes(['r1']).map((o, i) => [[a, b, d, e][i], o.outcome]))
    expect(out).toEqual({ [a]: 'rejected', [b]: 'accepted_implicit', [d]: 'dismissed', [e]: 'open' })
    const report = reviewQualityReport(store, 30)
    expect(report.findings).toMatchObject({ total: 4, accepted: 1, rejected: 1, dismissed: 1, open: 1, precision: 0.5 })
  })
})

describe('退化告警', () => {
  /** 直接写一行审稿记录（指定开始时间与指标）。 */
  function run(store: Store, id: string, daysAgo: number, m: { ms: number; out: number; comments: number; thinking: boolean }) {
    store.startReviewRun({ id, doc_id: 'd', owner: 'u' })
    store.finishReviewRun(id, { status: 'done', duration_ms: m.ms, model: 'deepseek-flash', thinking: m.thinking, stages: { sections: { ms: m.ms, calls: 5, input_tokens: 10000, output_tokens: m.out } }, coverage: {}, words: 5000, raw_candidates: 10, verifier_rejected: 2, comments: m.comments })
    store.db.prepare('UPDATE review_runs SET started_at = ? WHERE id = ?').run(new Date(Date.now() - daysAgo * 86400_000).toISOString(), id)
  }

  it('近 3 次的耗时、输出 token 明显低于之前、深度思考关掉了 → 告警；正常波动不告警', () => {
    const store = new Store(':memory:')
    for (let i = 0; i < 8; i++) run(store, `b${i}`, 10 - i, { ms: 300_000, out: 40_000, comments: 12, thinking: true })
    expect(detectRegression(store)).toBeNull()
    for (let i = 0; i < 3; i++) run(store, `r${i}`, 0.1 - i * 0.01, { ms: 40_000, out: 5_000, comments: 4, thinking: false })
    const msg = detectRegression(store)
    expect(msg).toContain('深度思考从开着变成了关着')
    expect(msg).toContain('耗时')
  })

  it('样本不够时不告警', () => {
    const store = new Store(':memory:')
    for (let i = 0; i < 3; i++) run(store, `r${i}`, i, { ms: 1000, out: 10, comments: 0, thinking: false })
    expect(detectRegression(store)).toBeNull()
  })
})

describe('接口：后台任务与进度', () => {
  it('?async=1 立即返回任务 id，轮询看到每一步，结束后带结果与覆盖范围；管理员看到质量面板', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
    const mailer = { configured: true, available: true, mode: 'dev-mock' as const, async send() { return { success: true, mode: 'simulated' as const, messageId: 'm' } } }
    const accounts = new Accounts(store, { secret: 's', devMode: true, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: 's', baseMax: 300, minDelayMs: 0 }), mailer })
    const app = buildApi({
      docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
      crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))),
      accounts, devMode: true, devUser: 'dev', reviewComplete: stubModel(),
    })
    const pow = solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge)
    const me = await (await app.request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'password-123', pow }) })).json() as { token: string; user: { id: string } }
    const h = { Authorization: `Bearer ${me.token}` }
    const row = docs.create({ owner: me.user.id, title: 't', content: schema.node('doc', null, parseBlocks(PAPER)) })
    const { job_id } = await (await app.request(`/api/docs/${row.id}/deep-review?async=1`, { method: 'POST', headers: h })).json() as { job_id: string }
    let job: any
    for (let i = 0; i < 50; i++) {
      job = await (await app.request(`/api/docs/${row.id}/deep-review/jobs/${job_id}`, { headers: h })).json()
      if (job.status !== 'running') break
      await new Promise(r => setTimeout(r, 20))
    }
    expect(job.status).toBe('done')
    expect(job.steps.read.status).toBe('done')
    expect(job.steps.sections.total).toBeGreaterThan(0)
    expect(job.result.coverage.sections_total).toBeGreaterThan(0)
    expect(job.result.run_id).toMatch(/^rv/)
    const q = await (await app.request('/api/admin/review-quality', { headers: h })).json() as { runs: number; thinking_share: number }
    expect(q.runs).toBe(1)
    expect(q.thinking_share).toBe(1)
  })
})
