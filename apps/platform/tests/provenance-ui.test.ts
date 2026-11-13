/**
 * 来源等级第 3 期（docs/design/PROVENANCE.md 第 5 节）：确认 AI 文字、个人偏好、保护记录。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard, solveChallenge, type Challenge } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { aiStats, confirmBlocks, hasAiText } from '../src/model/provenance.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { protectionSummary } from '../src/ops/provenance-guard.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

const SAMPLE = `# 讨论

本研究提示新辅助治疗可能有效。`

function env() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs, undefined, undefined, { provenance: true })
  const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
  const mailer = { configured: true, available: true, mode: 'dev-mock' as const, async send() { return { success: true, mode: 'simulated' as const, messageId: 'm' } } }
  const accounts = new Accounts(store, { secret: 's', devMode: true, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: 's', baseMax: 300, minDelayMs: 0 }), mailer })
  const app = buildApi({
    docs, ops, turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
    crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))),
    accounts, devMode: true, devUser: 'dev',
  })
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
    return { status: res.status, data: await res.json().catch(() => null) as any }
  }
  const register = async (username: string) => {
    const pow = solveChallenge((await (await app.request('/api/auth/challenge')).json()) as Challenge)
    const res = await app.request('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password-123', pow }) })
    return (await res.json()) as { token: string; user: { id: string } }
  }
  return { store, docs, ops, call, register }
}

describe('确认 AI 文字', () => {
  it('确认指定段落：只去掉这些段落的 AI 标记；不给 node_ids 确认全文', async () => {
    const t = env()
    const me = await t.register('alice')
    const row = t.docs.create({ owner: me.user.id, title: 't', content: schema.node('doc', null, parseBlocks(SAMPLE)) })
    const anchor = t.docs.get(row.id).child(1).attrs.id as string
    t.ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: anchor, markdown: '第一段 AI 补充。' }, { op: 'insert_after', anchor_id: anchor, markdown: '第二段 AI 补充。' }] }, { actor: 'ai', turnId: 't1', observe: null })
    expect(aiStats(t.docs.get(row.id)).blocks).toBe(2)
    const first = t.docs.get(row.id).child(2).attrs.id as string
    const r1 = await t.call('POST', `/api/docs/${row.id}/confirm-ai`, me.token, { node_ids: [first] })
    expect(r1.data.confirmed).toBe(1)
    expect(r1.data.remaining.blocks).toBe(1)
    expect(hasAiText(t.docs.get(row.id).child(2))).toBe(false)
    const r2 = await t.call('POST', `/api/docs/${row.id}/confirm-ai`, me.token, {})
    expect(r2.data.confirmed).toBe(1)
    expect(hasAiText(t.docs.get(row.id))).toBe(false)
    // 确认后的文字算人写的：AI 再大改它要转为待采纳修订
    const r3 = t.ops.edit({ doc_id: row.id, base_rev: t.docs.rev(row.id), mode: 'apply', ops: [{ op: 'replace_block', id: first, markdown: '完全改写后的第一段，表述不同。' }] }, { actor: 'ai', turnId: 't2', observe: null })
    expect(r3.provenance?.converted_to_suggest?.length).toBeGreaterThan(0)
  })

  it('别人的文档不能确认', async () => {
    const t = env()
    const a = await t.register('alice')
    const b = await t.register('bob')
    const row = t.docs.create({ owner: a.user.id, title: 't', content: schema.node('doc', null, parseBlocks(SAMPLE)) })
    expect((await t.call('POST', `/api/docs/${row.id}/confirm-ai`, b.token, {})).status).toBe(404)
  })

  it('confirmBlocks 只动有 AI 文字的段落', () => {
    const t = env()
    const row = t.docs.create({ owner: 'u', title: 't', content: schema.node('doc', null, parseBlocks(SAMPLE)) })
    const { blocks } = confirmBlocks(t.docs.get(row.id), null)
    expect(blocks).toBe(0)
  })
})

describe('个人偏好', () => {
  it('默认都开；关掉安全小改后 AI 对人写文字的小改也转为待采纳修订', async () => {
    const t = env()
    const me = await t.register('alice')
    expect((await t.call('GET', '/api/me/provenance', me.token)).data).toEqual({ safe_edits: true, shade: true })
    expect((await t.call('PUT', '/api/me/provenance', me.token, { safe_edits: false })).data).toEqual({ safe_edits: false, shade: true })
    const row = t.docs.create({ owner: me.user.id, title: 't', content: schema.node('doc', null, parseBlocks(SAMPLE)) })
    const p = t.docs.get(row.id).child(1).attrs.id as string
    const r = t.ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p, find: '本研究', replace: '本项研究' }] }, { actor: 'ai', turnId: 't1', observe: null })
    expect(r.provenance?.converted_to_suggest?.[0]).toContain('关闭了安全小改')
    await t.call('PUT', '/api/me/provenance', me.token, { safe_edits: true, shade: false })
    expect((await t.call('GET', '/api/me/provenance', me.token)).data).toEqual({ safe_edits: true, shade: false })
  })
})

describe('保护记录', () => {
  it('回合里转为待采纳修订、拒绝没有出处的数字都记下，汇总成平常的话', () => {
    const t = env()
    const row = t.docs.create({ owner: 'u', title: 't', content: schema.node('doc', null, parseBlocks(SAMPLE)) })
    const p = t.docs.get(row.id).child(1).attrs.id as string
    t.ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: p, find: '可能有效', replace: '确实有效' }] }, { actor: 'ai', turnId: 'turn-1', observe: 'turn-1' })
    const heading = t.docs.get(row.id).child(0).attrs.id as string
    expect(() => t.ops.edit({ doc_id: row.id, base_rev: t.docs.rev(row.id), mode: 'apply', ops: [{ op: 'insert_after', anchor_id: heading, markdown: '中位随访 18.5 个月。' }] }, { actor: 'ai', turnId: 'turn-1', observe: 'turn-1' })).toThrow(/找不到出处/)
    const lines = protectionSummary(t.store.provenanceEvents('turn-1'))
    expect(lines).toEqual([
      '有 1 批修改改到了你写的文字，已转为待采纳修订，采纳后生效',
      '拦下了找不到出处的数字：18.5',
    ])
    // 别的回合不受影响；没有记录时不显示
    expect(protectionSummary(t.store.provenanceEvents('turn-2'))).toEqual([])
  })

  it('试探（dry_run）不记', () => {
    const t = env()
    const row = t.docs.create({ owner: 'u', title: 't', content: schema.node('doc', null, parseBlocks(SAMPLE)) })
    const p = t.docs.get(row.id).child(1).attrs.id as string
    t.ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', dry_run: true, ops: [{ op: 'replace_text', id: p, find: '可能有效', replace: '确实有效' }] }, { actor: 'ai', turnId: 'turn-1', observe: 'turn-1' })
    expect(t.store.provenanceEvents('turn-1')).toEqual([])
  })
})
