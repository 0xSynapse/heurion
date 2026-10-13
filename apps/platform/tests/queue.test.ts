import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessPool } from '../src/harness/pool.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

/** 假 dsh 进程池：每次 run 挂起，直到测试手动放行；hang 的那次永不返回（模拟卡住的模型调用）。 */
function fakePool() {
  const pending: Array<{ prompt: string; finish: () => void }> = []
  let cancels = 0
  const pool = {
    liveSession: () => 's',
    generation: () => 'gen-test',
    isLive: () => true,
    run: (_u: string, prompt: string) => new Promise(resolve => {
      pending.push({ prompt, finish: () => resolve({ finalResponse: 'ok' }) })
    }),
    cancel: async () => { cancels++ },
  }
  return { pool: pool as unknown as HarnessPool, pending, cancels: () => cancels }
}

const tick = () => new Promise(r => setTimeout(r, 10))

function env(path = ':memory:', opts: { maxDocConcurrency?: number } = {}) {
  const store = new Store(path)
  const docs = new Documents(store)
  const a = docs.create({ owner: 'u1', title: '甲文档' })
  const b = docs.create({ owner: 'u1', title: '乙文档' })
  const fake = fakePool()
  const turns = new TurnService(docs, fake.pool, new TurnRegistry(), opts)
  return { store, docs, turns, fake, a: a.id, b: b.id }
}

describe('任务队列', () => {
  it('view 列出执行中与排队中的任务（单并发或同文档按顺序）', async () => {
    const t = env(':memory:', { maxDocConcurrency: 1 })
    void t.turns.submit('u1', t.a, '第一件事')
    void t.turns.submit('u1', t.b, '第二件事', undefined, { suggest: true })
    void t.turns.submit('u1', t.a, '第三件事')
    await tick()
    const v = t.turns.view('u1')
    expect(v.running).toMatchObject({ doc_title: '甲文档', label: '第一件事' })
    expect(v.queued.map(q => [q.doc_title, q.label, q.suggest])).toEqual([['乙文档', '第二件事', true], ['甲文档', '第三件事', false]])
    expect(t.turns.view('u2')).toEqual({ running: null, active: [], queued: [] })
  })

  it('取消排队中的一个：只移出它，其他照常执行', async () => {
    const t = env()
    void t.turns.submit('u1', t.a, '一')
    void t.turns.submit('u1', t.a, '二')
    void t.turns.submit('u1', t.a, '三')
    await tick()
    const second = t.turns.view('u1').queued[0]!.id
    expect(await t.turns.cancelJob('u1', second)).toBe(true)
    expect(t.turns.view('u1').queued.map(q => q.label)).toEqual(['三'])
    t.fake.pending[0]!.finish()
    await tick()
    expect(t.turns.view('u1').running?.label).toBe('三')
    expect(await t.turns.cancelJob('u1', second)).toBe(false)
  })

  it('停止卡住的当前任务：进程调用永不返回也能放行队列，回合记为 cancelled', async () => {
    const t = env()
    void t.turns.submit('u1', t.a, '卡住的任务')
    void t.turns.submit('u1', t.b, '后面的任务')
    await tick()
    const running = t.turns.view('u1').running!
    expect(await t.turns.cancelJob('u1', running.id)).toBe(true)
    await tick()
    expect(t.fake.cancels()).toBe(1)
    expect(t.turns.view('u1').running?.label).toBe('后面的任务')
    const row = t.store.db.prepare('SELECT status FROM turns WHERE id = ?').get(running.turn_id!) as { status: string }
    expect(row.status).toBe('cancelled')
  })

  it('评论任务显示用户的要求而不是内部提示', async () => {
    const t = env()
    const c = t.store.addComment({ doc_id: t.a, node_id: 'x', snippet: '' })
    t.store.addReply(c.id, 'user', '@heurion 改成英文')
    void t.turns.submit('u1', t.a, '占位')
    void t.turns.submit('u1', t.a, `请处理文档 ${t.a} 中的评论 ${c.id}：\n…`, undefined, { commentId: c.id })
    await tick()
    expect(t.turns.view('u1').queued[0]!.label).toBe('处理评论：改成英文')
  })

  it('服务重启：排队中的任务继续执行，没跑完的回合标为 interrupted', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hq-')), 'q.db')
    const first = env(path, { maxDocConcurrency: 1 })
    void first.turns.submit('u1', first.a, '执行中被打断')
    void first.turns.submit('u1', first.b, '排队一', undefined, { suggest: true })
    void first.turns.submit('u1', first.a, '排队二')
    await tick()
    const interruptedTurn = first.turns.view('u1').running!.turn_id!
    // 新进程：同一个数据库
    const store = new Store(path)
    const docs = new Documents(store)
    const fake = fakePool()
    const turns = new TurnService(docs, fake.pool, new TurnRegistry(), { maxDocConcurrency: 1 })
    expect(turns.restore()).toEqual({ interrupted: 1, requeued: 2 })
    await tick()
    const v = turns.view('u1')
    expect(v.running).toMatchObject({ label: '排队一', suggest: true })
    expect(v.queued.map(q => q.label)).toEqual(['排队二'])
    expect((store.db.prepare('SELECT status FROM turns WHERE id = ?').get(interruptedTurn) as { status: string }).status).toBe('interrupted')
    // 开始执行的任务从持久队列里移除
    expect(store.listQueuedJobs().map(j => j.message)).toEqual(['排队二'])
  })
})

describe('回合无响应超时', () => {
  it('模型长时间没有动静：自动停止、记为 timeout、放行下一个任务', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const a = docs.create({ owner: 'u1', title: '甲' })
    const fake = fakePool()
    const turns = new TurnService(docs, fake.pool, new TurnRegistry(), { idleTimeoutMs: 40 })
    const events: Array<{ type: string; message?: string }> = []
    void turns.submit('u1', a.id, '会卡住', e => events.push(e as never))
    void turns.submit('u1', a.id, '下一个')
    await tick()
    const stuck = turns.view('u1').running!
    await new Promise(r => setTimeout(r, 120))
    expect(fake.cancels()).toBeGreaterThanOrEqual(1)
    // 下一个任务已经开始执行（假进程池里它同样会卡住，这里只看它被放行）
    expect(fake.pending.map(p => p.prompt.endsWith('下一个'))).toEqual([false, true])
    expect((store.db.prepare('SELECT status FROM turns WHERE id = ?').get(stuck.turn_id!) as { status: string }).status).toBe('timeout')
    expect(events.some(e => e.type === 'error' && /无响应，已自动停止/.test(e.message ?? ''))).toBe(true)
  })

  it('持续有动静（提交）就不超时', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const a = docs.create({ owner: 'u1', title: '甲' })
    const fake = fakePool()
    const registry = new TurnRegistry()
    const turns = new TurnService(docs, fake.pool, registry, { idleTimeoutMs: 60 })
    void turns.submit('u1', a.id, '慢但在干活')
    await tick()
    const turnId = turns.view('u1').running!.turn_id!
    const { schema } = await import('../src/model/schema.ts')
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 30))
      docs.commit(a.id, schema.node('doc', null, [schema.node('paragraph', { id: 'p1' }, [schema.text(`第 ${i} 次`)])]), { actor: 'ai', turnId, ops: [] })
    }
    expect(fake.cancels()).toBe(0)
    expect(turns.view('u1').running?.turn_id).toBe(turnId)
  })
})

describe('失败原因', () => {
  it('报错 / 取消 / 超时的原因写进回合记录，文档能列出', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const a = docs.create({ owner: 'u1', title: '甲' })
    let n = 0
    const pool = {
      liveSession: () => 's',
      run: () => (n++ === 0 ? Promise.reject(new Error('provider 429: rate limited')) : new Promise(() => {})),
      cancel: async () => {},
    } as unknown as HarnessPool
    const turns = new TurnService(docs, pool, new TurnRegistry(), { idleTimeoutMs: 40 })
    await turns.submit('u1', a.id, '会报错')
    void turns.submit('u1', a.id, '会被取消')
    void turns.submit('u1', a.id, '会超时')
    await tick()
    await turns.cancelJob('u1', turns.view('u1').running!.id)
    await new Promise(r => setTimeout(r, 120))
    expect(store.failedTurns(a.id).map(t => [t.status, t.error])).toEqual([
      ['error', 'provider 429: rate limited'],
      ['cancelled', '已取消'],
      ['timeout', '模型服务 <1 分钟无响应，已自动停止'],
    ])
  })

  it('服务重启中断的回合记下原因', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hq-')), 'q.db')
    const first = env(path)
    void first.turns.submit('u1', first.a, '执行中被打断')
    await tick()
    const store = new Store(path)
    new TurnService(new Documents(store), fakePool().pool, new TurnRegistry()).restore()
    expect(store.failedTurns(first.a).map(t => [t.status, t.error])).toEqual([['interrupted', '服务重启，回合被中断']])
  })
})

describe('开发令牌', () => {
  it('「令牌:名字」映射到独立开发用户；非法名字与错误令牌拒绝', async () => {
    const { devUserFor } = await import('../src/auth/dev.ts')
    expect(devUserFor('dev', 'dev', 'dev')).toBe('dev')
    expect(devUserFor('dev:e2e', 'dev', 'dev')).toBe('dev:e2e')
    expect(devUserFor('dev:BAD USER', 'dev', 'dev')).toBeNull()
    expect(devUserFor('other:e2e', 'dev', 'dev')).toBeNull()
    expect(devUserFor('', 'dev', 'dev')).toBeNull()
  })
})

describe('双轨制任务调度与文档并发池', () => {
  it('跨文档并发执行与同文档严格串行排队', async () => {
    const t = env(':memory:', { maxDocConcurrency: 2 })
    const docC = t.docs.create({ owner: 'u1', title: '丙文档' }).id

    // 同时提交 甲1 和 乙1：两份不同文档，应立即并发执行（doc_0, doc_1）
    void t.turns.submit('u1', t.a, '任务A1')
    void t.turns.submit('u1', t.b, '任务B1')
    // 再提交 甲2：因为甲文档已在执行，为防止自身版本冲突，必须排队
    void t.turns.submit('u1', t.a, '任务A2')
    // 再提交 丙1：虽然是新文档，但并发槽位已满（2/2），进入队列排队
    void t.turns.submit('u1', docC, '任务C1')
    await tick()

    const v1 = t.turns.view('u1')
    expect(v1.active?.map(x => x.label)).toEqual(['任务A1', '任务B1'])
    expect(v1.queued.map(x => x.label)).toEqual(['任务A2', '任务C1'])
    expect(t.turns.isBusy('u1', t.a)).toBe(true)
    expect(t.turns.isBusy('u1', t.b)).toBe(true)
    expect(t.turns.isBusy('u1', docC)).toBe(false) // 丙文档排队中，尚未占用执行槽位

    // 释放 甲1：此时甲文档空闲，且队列头部的 甲2 恰好等待甲文档，甲2 应立即被调度执行
    const finishA1 = t.fake.pending.find(p => p.prompt.endsWith('任务A1'))!
    finishA1.finish()
    await tick()

    const v2 = t.turns.view('u1')
    expect(v2.active?.map(x => x.label).sort()).toEqual(['任务A2', '任务B1'])
    expect(v2.queued.map(x => x.label)).toEqual(['任务C1'])

    // 释放 乙1：乙文档完成，队列中的 丙1 应立即被调度执行
    const finishB1 = t.fake.pending.find(p => p.prompt.endsWith('任务B1'))!
    finishB1.finish()
    await tick()

    const v3 = t.turns.view('u1')
    expect(v3.active?.map(x => x.label).sort()).toEqual(['任务A2', '任务C1'])
    expect(v3.queued).toEqual([])

    // 全部结束
    t.fake.pending.find(p => p.prompt.endsWith('任务A2'))!.finish()
    t.fake.pending.find(p => p.prompt.endsWith('任务C1'))!.finish()
    await tick()
    expect(t.turns.isBusy('u1')).toBe(false)
    expect(t.turns.view('u1').active).toEqual([])
  })

  it('Co-Pilot 独立快车道并发且不阻塞文档队列', async () => {
    const t = env(':memory:', { maxDocConcurrency: 2 })
    const copilotDoc = t.docs.create({ owner: 'u1', title: '随航助手' }).id

    // 启动两个文档长任务，占满文档并发配额
    void t.turns.submit('u1', t.a, '文档甲长任务')
    void t.turns.submit('u1', t.b, '文档乙长任务')
    await tick()
    expect(t.turns.isBusy('u1')).toBe(true)
    expect(t.turns.isCopilotBusy('u1')).toBe(false)

    // 发起 Co-Pilot 随航提问（lane: copilot）
    void t.turns.submit('u1', copilotDoc, '随航提问一', undefined, { lane: 'copilot' })
    await tick()

    // 验证：Co-Pilot 立即开始执行，不进排队队列，不阻塞文档任务
    expect(t.turns.isCopilotBusy('u1')).toBe(true)
    expect(t.turns.view('u1').queued).toEqual([])
    expect(t.fake.pending.length).toBe(3)
    expect(t.fake.pending.some(p => p.prompt.includes('文档甲长任务'))).toBe(true)
    expect(t.fake.pending.some(p => p.prompt.includes('文档乙长任务'))).toBe(true)
    expect(t.fake.pending.some(p => p.prompt.includes('随航提问一'))).toBe(true)

    // 用户在随航中紧接着发起第二问：自动中断上一问并立即执行新问
    void t.turns.submit('u1', copilotDoc, '随航提问二', undefined, { lane: 'copilot' })
    await tick()
    expect(t.fake.cancels()).toBeGreaterThanOrEqual(1)
    expect(t.fake.pending.some(p => p.prompt.includes('随航提问二'))).toBe(true)

    // 文档任务依然稳健执行不受影响
    expect(t.turns.isBusy('u1', t.a)).toBe(true)
    expect(t.turns.isBusy('u1', t.b)).toBe(true)
  })

  it('并发执行时精准取消特定文档任务，不影响其他并发文档', async () => {
    const t = env(':memory:', { maxDocConcurrency: 2 })
    void t.turns.submit('u1', t.a, '甲任务')
    void t.turns.submit('u1', t.b, '乙任务')
    await tick()

    const active = t.turns.view('u1').active!
    const jobA = active.find(x => x.doc_id === t.a)!
    expect(await t.turns.cancelJob('u1', jobA.id)).toBe(true)
    await tick()

    // 甲任务已取消，乙任务继续运行
    expect(t.turns.isBusy('u1', t.a)).toBe(false)
    expect(t.turns.isBusy('u1', t.b)).toBe(true)
    expect(t.turns.view('u1').active?.map(x => x.label)).toEqual(['乙任务'])

    // 完成乙任务
    t.fake.pending.find(p => p.prompt.endsWith('乙任务'))!.finish()
    await tick()
    expect(t.turns.isBusy('u1', t.b)).toBe(false)
  })
})

