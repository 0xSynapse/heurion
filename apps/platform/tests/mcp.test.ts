import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { ClaimService } from '../src/claims/service.ts'
import { KbService } from '../src/kb/service.ts'
import { DatasetService } from '../src/datasets/service.ts'
import { MemoryEvolution } from '../src/memory/evolve.ts'
import { MemoryService } from '../src/memory/service.ts'
import type { FullTextClient } from '../src/literature/fulltext.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { setup } from './helpers.ts'

const SECRET = 'test-secret'

async function connect(markdown: string, scope: { d?: '*' | string[]; p?: Array<'read' | 'write'> } = {}) {
  const env = setup(markdown)
  const kb = new KbService(env.store, null)
  const memory = new MemoryService(env.store, null)
  // 数据集：假的导入（不依赖 Python）——内容为 y 的文件标出一列身份信息
  const datasets = new DatasetService(env.store, mkdtempSync(join(tmpdir(), 'heurion-ds-')), async (_owner, src) => {
    const dir = mkdtempSync(join(tmpdir(), 'heurion-ds-out-'))
    writeFileSync(join(dir, 'data.csv'), 'arm,age\nA,60\nB,55\n')
    const phi = readFileSync(src, 'utf8') === 'y'
    return { csv: join(dir, 'data.csv'), cleanup: () => {}, profile: { ok: true, rows: 2, truncated: false, columns: [
      { name: 'arm', type: 'categorical', missing: 0, unique: 2, ...(phi ? { phi: { reason: '列名像姓名' } } : {}) },
      { name: 'age', type: 'numeric', missing: 0, unique: 2 },
    ] } }
  })
  // 记忆整理：假模型——有「数值」相关的记忆就提议合并，并总结一条新规律
  const evolution = new MemoryEvolution(env.store, memory, env.docs, async (_s, user) => {
    const ms = JSON.parse(user).memories as Array<{ id: string; content: string }>
    const num = ms.filter(m => m.content.includes('小数'))
    return JSON.stringify({ changes: [
      { action: 'create', kind: 'style', content: '效应量写 HR 与 95% CI', reason: '你多次补上了 HR', evidence: ['u1', 'u2'] },
      ...(num.length >= 2 ? [{ action: 'merge', ids: num.map(m => m.id), content: '数值一律保留两位小数', reason: '重复' }] : []),
    ] })
  })
  const workspace = mkdtempSync(join(tmpdir(), 'heurion-ws-'))
  const registry = new TurnRegistry()
  const crossref = {
    lookup: async (doi: string) => doi.includes('404') ? null : { pmid: null, doi: doi.toLowerCase(), title: 'Trial', authors: ['Doe J'], journal: 'N Engl J Med', year: '2020' },
  } as unknown as CrossrefClient
  const claims = verifyToken(SECRET, issueToken(SECRET, { u: 'u1', d: scope.d ?? '*', p: scope.p ?? ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
  const pubmed = {
    search: async (q: string) => q.includes('SELECT') ? [{ pmid: '37952131', doi: '10.1056/nejmoa2307563', title: 'Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes', authors: ['Lincoff AM'], journal: 'N Engl J Med', year: '2023' }] : [],
    pmidForDoi: async () => '12345',
    abstract: async () => 'RESULTS: The primary outcome occurred in 6.5% vs 8.0% (HR 0.80; 95% CI 0.72-0.90). The trial was completed as planned.',
  } as unknown as PubMedClient
  const server = buildMcpServer({
    docs: env.docs, ops: env.ops, turns: registry, secret: SECRET, claims: new ClaimService(env.docs, pubmed), renderer: new SlideRenderer(workspace),
    pubmed, crossref,
    workspaceDir: () => workspace,
    isLiveSession: () => true,
    kb,
    memory,
    evolution,
    datasets,
    fulltext: { get: async (doi: string) => doi === '10.1/open' ? { source: 'pmc', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/', license: 'CC BY', text: 'Intro paragraph that is long enough to count as a passage for ranking purposes here.\n\nResults: the hazard ratio was 0.80 (95% CI 0.72 to 0.90) for the primary endpoint in all participants.' } : null } as unknown as FullTextClient,
  }, claims)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(b)
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ type?: string; text?: string; data?: string; mimeType?: string }> }
    const first = r.content?.[0]
    const body = first?.text ?? ''
    let parsed: unknown = body
    try { parsed = JSON.parse(body) } catch { /* 纯文本视图 */ }
    return {
      isError: Boolean(r.isError),
      body: parsed as any,
      text: body,
      content: r.content,
      image: first?.type === 'image' ? first : undefined,
    }
  }
  return { ...env, client, call, registry, workspace, kb, memory, datasets }
}

describe('MCP 工具', () => {
  it('outline → read → edit → 引用的完整流程', async () => {
    const t = await connect('# 引言\n\n心衰常见。\n\n# 方法\n\n待补充。')
    const outline = await t.call('doc_outline', { doc_id: t.docId })
    expect(outline.text).toContain('rev=0')
    const methods = /# \{#([a-z0-9]+)\} 方法/.exec(outline.text)![1]!
    const read = await t.call('doc_read', { doc_id: t.docId, section_id: methods })
    const para = /\{#([a-z0-9]+)\} 待补充/.exec(read.text)![1]!

    const cite = await t.call('insert_citation', { doc_id: t.docId, doi: '10.1056/NEJMoa2020' })
    expect(cite.body.marker).toMatch(/^\[@c:c[a-z0-9]+\]$/)

    const edit = await t.call('doc_edit', {
      doc_id: t.docId, base_rev: 0,
      ops: [{ op: 'replace_block', id: para, markdown: `纳入 120 例患者${cite.body.marker}。` }],
    })
    expect(edit.isError).toBe(false)
    expect(edit.body.rev).toBe(1)
    const list = await t.call('list_citations', { doc_id: t.docId })
    expect(list.body[0].number).toBe(1)

    const bad = await t.call('doc_edit', { doc_id: t.docId, base_rev: 1, ops: [{ op: 'insert_after', anchor_id: para, markdown: '见 10.1056/NEJMoa2020' }] })
    expect(bad.isError).toBe(true)
    expect(bad.body.code).toBe('citation_not_registered')
    expect(bad.body.hint).toContain('insert_citation')

    // doc_validate 试探预检：返回结构化拦截原因，但不抛出 MCP tool error
    const valBad = await t.call('doc_validate', { doc_id: t.docId, base_rev: 1, ops: [{ op: 'insert_after', anchor_id: para, markdown: '见 10.1056/NEJMoa2020' }] })
    expect(valBad.isError).toBe(false)
    expect(valBad.body.valid).toBe(false)
    expect(valBad.body.code).toBe('citation_not_registered')

    const valOk = await t.call('doc_validate', { doc_id: t.docId, base_rev: 1, ops: [{ op: 'replace_text', id: para, find: '纳入', replace: '共纳入' }] })
    expect(valOk.isError).toBe(false)
    expect(valOk.body.valid).toBe(true)

    // 按 DOI 登记：一并返回摘要摘录，供核对是否支持所在句子
    expect(cite.body.abstract).toContain('HR 0.80')
    // 只给检索词：返回候选（含摘要），不替 AI 挑第一条登记
    const before = (await t.call('list_citations', { doc_id: t.docId })).body.length
    const cands = await t.call('insert_citation', { doc_id: t.docId, query: 'SELECT semaglutide cardiovascular' })
    expect(cands.body.registered).toBe(false)
    expect(cands.body.candidates[0].pmid).toBe('37952131')
    expect(cands.body.candidates[0].abstract).toContain('HR 0.80')
    expect((await t.call('list_citations', { doc_id: t.docId })).body.length).toBe(before)
    const missing = await t.call('insert_citation', { doc_id: t.docId, doi: '10.9999/404' })
    expect(missing.body.code).toBe('doi_not_found')

    // 传入 claim 时，若摘要与句子核心术语完全无重合，则以 citation_unsupported 拦截
    const unsupported = await t.call('insert_citation', { doc_id: t.docId, doi: '10.1056/NEJMoa2020', claim: 'Esophageal displacement with transesophageal echocardiography during ablation.' })
    expect(unsupported.isError).toBe(true)
    expect(unsupported.body.code).toBe('citation_unsupported')
  })

  it('回合内的写入带 turn_id，并通知回合', async () => {
    const t = await connect('段落。')
    const notices: unknown[] = []
    t.registry.begin('u1', { turnId: 'r1', touched: new Set(), notify: n => notices.push(n), mode: 'apply' })
    const read = await t.call('doc_read', { doc_id: t.docId })
    const id = /\{#([a-z0-9]+)\}/.exec(read.text)![1]!
    await t.call('doc_edit', { doc_id: t.docId, base_rev: 0, ops: [{ op: 'replace_text', id, find: '段落', replace: '新段落' }] })
    expect(t.store.opLog(t.docId)[0]!.turn_id).toBe('r1')
    expect(t.registry.active('u1')!.touched.has(t.docId)).toBe(true)
  })

  it('权限：别人的文档、只读令牌', async () => {
    const t = await connect('段落。', { p: ['read'] })
    const other = t.docs.create({ owner: 'someone-else', title: 'x' })
    expect((await t.call('doc_outline', { doc_id: other.id })).body.code).toBe('doc_not_found')
    const read = await t.call('doc_read', { doc_id: t.docId })
    const id = /\{#([a-z0-9]+)\}/.exec(read.text)![1]!
    const edit = await t.call('doc_edit', { doc_id: t.docId, base_rev: 0, ops: [{ op: 'delete', ids: [id] }] })
    expect(edit.body.code).toBe('forbidden')
  })

  it('asset_upload 只能读工作区内的图片，插入后渲染为图', async () => {
    const t = await connect('段落。')
    writeFileSync(join(t.workspace, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const up = await t.call('asset_upload', { path: 'chart.png' })
    expect(up.body.asset_id).toMatch(/^a/)
    expect((await t.call('asset_upload', { path: '../../etc/passwd' })).isError).toBe(true)
    const read = await t.call('doc_read', { doc_id: t.docId })
    const id = /\{#([a-z0-9]+)\}/.exec(read.text)![1]!
    const edit = await t.call('doc_edit', { doc_id: t.docId, base_rev: 0, ops: [{ op: 'insert_after', anchor_id: id, markdown: `![心衰发病率](asset:${up.body.asset_id} "图 1")` }] })
    expect(edit.isError).toBe(false)
    expect(t.docs.get(t.docId).child(1).type.name).toBe('figure')
  })

  it('评论：读取锚点、回复、关闭', async () => {
    const t = await connect('心衰常见。')
    const node = t.docs.get(t.docId).child(0).attrs.id as string
    const c = t.store.addComment({ doc_id: t.docId, node_id: node, snippet: '' })
    t.store.addReply(c.id, 'user', '补充发病率数据')
    const list = await t.call('comments_list', { doc_id: t.docId })
    expect(list.body.comments[0].anchor.node_ids).toEqual([node])
    expect((await t.call('comment_resolve', { doc_id: t.docId, comment_id: c.id })).body.code).toBe('reply_required')
    await t.call('comment_reply', { doc_id: t.docId, comment_id: c.id, text: '已补充' })
    expect((await t.call('comment_resolve', { doc_id: t.docId, comment_id: c.id })).body.status).toBe('resolved')
  })

  it('doc_create 带初始内容；违反引用规范时不留下空文档', async () => {
    const t = await connect('x')
    const ok = await t.call('doc_create', { title: '新稿', markdown: '# 标题\n\n正文。' })
    expect(ok.body.rev).toBe(1)
    const bad = await t.call('doc_create', { title: '坏稿', markdown: 'doi:10.1056/abc' })
    expect(bad.body.code).toBe('citation_not_registered')
    const titles = (await t.call('doc_list', {})).body.map((d: { title: string }) => d.title)
    expect(titles).toContain('新稿')
    expect(titles).not.toContain('坏稿')
  })
})

describe('评论规则', () => {
  it('本回合改过文档后，AI 不能关闭线程', async () => {
    const t = await connect('心衰常见。')
    const node = t.docs.get(t.docId).child(0).attrs.id as string
    const c = t.store.addComment({ doc_id: t.docId, node_id: node, snippet: '' })
    t.registry.begin('u1', { turnId: 'r1', touched: new Set(), notify: () => {}, mode: 'apply' })
    await t.call('doc_edit', { doc_id: t.docId, base_rev: 0, ops: [{ op: 'replace_text', id: node, find: '常见', replace: '高发' }] })
    await t.call('comment_reply', { doc_id: t.docId, comment_id: c.id, text: '已改' })
    expect((await t.call('comment_resolve', { doc_id: t.docId, comment_id: c.id })).body.code).toBe('user_confirms_changes')
  })

  it('comment_add：模型基于语义理解直接在指定块和文字片段挂评论，且重复调用不重复创建', async () => {
    const t = await connect('表 1 显示三分类饮酒比例分别为 40.4%、2.5% 与 51.1%。')
    const node = t.docs.get(t.docId).child(0).attrs.id as string
    const first = await t.call('comment_add', {
      doc_id: t.docId,
      node_id: node,
      snippet: '40.4%、2.5% 与 51.1%',
      text: '数据自洽提示：三项百分比加总为 94.0%，且 40.4% (19/47) 与总样本量 N=45 的分母不一致，建议核对原始数据。',
    })
    expect(first.body.status).toBe('commented')
    expect(first.body.comment_id).toBeTruthy()

    const dup = await t.call('comment_add', {
      doc_id: t.docId,
      node_id: node,
      snippet: '40.4%、2.5% 与 51.1%',
      text: '数据自洽提示：三项百分比加总为 94.0%，且 40.4% (19/47) 与总样本量 N=45 的分母不一致，建议核对原始数据。',
    })
    expect(dup.body.status).toBe('unchanged')
    expect(t.store.listComments(t.docId, 'open')).toHaveLength(1)
  })
})

describe('论断核对', () => {
  it('verify_claims 给出论断与摘要证据、缺出处的数值句；claim_report 挂评论且不重复', async () => {
    const t = await connect('占位。')
    const cite = t.store.upsertCitation({ doc_id: t.docId, doi: '10.1056/nejmoa2307563', pmid: null, formatted: 'Lincoff AM. SELECT. N Engl J Med. 2023.', url: null })
    const id = t.docs.get(t.docId).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id, markdown: `SELECT 试验因安全性问题提前终止[@c:${cite.id}]。另有研究纳入 120 例患者。` }] }, { actor: 'user', turnId: null })
    const ev = (await t.call('verify_claims', { doc_id: t.docId })).body
    expect(ev.claims).toHaveLength(1)
    expect(ev.claims[0].sentence).toBe('SELECT 试验因安全性问题提前终止[1]。')
    expect(ev.claims[0].citations[0].abstract).toContain('completed as planned')
    expect(ev.unsourced).toHaveLength(1)
    expect(ev.unsourced[0].sentence).toContain('120 例')
    const report = await t.call('claim_report', { doc_id: t.docId, results: [
      { claim_id: ev.claims[0].claim_id, verdict: 'unsupported', reason: '摘要显示试验按计划完成，并未提前终止。' },
      { claim_id: ev.unsourced[0].claim_id, verdict: 'missing_citation', reason: '样本量没有出处。' },
    ] })
    expect(report.body.results.map((r: { status: string }) => r.status)).toEqual(['commented', 'commented'])
    const comments = t.store.listComments(t.docId, 'open')
    expect(comments).toHaveLength(2)
    expect(comments[0]!.replies[0]!.text).toContain('不支持')
    // 同一结论再报一次不重复挂评论；句子改过后旧 claim_id 失效
    const again = await t.call('claim_report', { doc_id: t.docId, results: [{ claim_id: ev.claims[0].claim_id, verdict: 'unsupported', reason: '同上' }] })
    expect(again.body.results[0].status).toBe('unchanged')
    expect(t.store.listComments(t.docId, 'open')).toHaveLength(2)
    t.ops.edit({ doc_id: t.docId, base_rev: t.docs.rev(t.docId), mode: 'apply', ack_comments: comments.map(c => c.id), ops: [{ op: 'replace_text', id, find: '因安全性问题提前终止', replace: '按计划完成' }] }, { actor: 'user', turnId: null })
    const stale = await t.call('claim_report', { doc_id: t.docId, results: [{ claim_id: ev.claims[0].claim_id, verdict: 'supported', reason: 'x' }] })
    expect(stale.body.results[0].status).toBe('stale')
  })
})

describe('开放获取全文（AI 读全文）', () => {
  it('oa_fulltext 按 query 返回相关片段；没有开放全文时如实报错', async () => {
    const t = await connect('占位。')
    const r = await t.call('oa_fulltext', { doi: '10.1/OPEN', query: 'hazard ratio 0.80 primary endpoint' })
    expect(r.body).toMatchObject({ source: 'pmc', license: 'CC BY' })
    expect(r.body.passages[0]).toContain('0.80')
    expect(JSON.parse((await t.call('oa_fulltext', { doi: '10.1/closed' })).text).code).toBe('no_open_fulltext')
  })
})

describe('参考文献导入（AI 与网页同一操作）', () => {
  it('import_references 登记可核实的条目、报告查不到的；之后 list_citations 能拿到 cite_id', async () => {
    const t = await connect('占位。')
    const r = await t.call('import_references', { doc_id: t.docId, text: 'TY  - JOUR\nTI  - SELECT\nDO  - 10.1056/NEJMoa2307563\nER  - \n\nTY  - JOUR\nTI  - 假的\nDO  - 10.404/none\nER  - \n' })
    expect([r.body.added, r.body.skipped.length]).toEqual([1, 1])
    const list = await t.call('list_citations', { doc_id: t.docId })
    expect(list.body[0]).toMatchObject({ doi: '10.1056/nejmoa2307563', number: null })
    expect(JSON.parse((await t.call('import_references', { doc_id: t.docId, text: '没有任何文献' })).text).code).toBe('no_references')
  })
})

describe('论断核对 v3（C2 评测后）', () => {
  it('没有可核对证据的「无法判断」只记录不挂评论；有证据的不支持照常挂评论', async () => {
    const t = await connect('占位。')
    const withAbs = t.store.upsertCitation({ doc_id: t.docId, doi: '10.1056/nejmoa2307563', pmid: null, formatted: 'Lincoff AM. SELECT. 2023.', url: null })
    const noAbs = t.store.upsertCitation({ doc_id: t.docId, doi: '10.9999/no-abstract', pmid: null, formatted: 'Conf Abstract. 2024.', url: null })
    t.store.putAbstract('10.9999/no-abstract', null, null) // 会议摘要之类：PubMed 没有摘要
    const id = t.docs.get(t.docId).child(0).attrs.id as string
    t.ops.edit({ doc_id: t.docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_block', id, markdown: `SELECT 试验提前终止[@c:${withAbs.id}]。某会议报告了类似结果[@c:${noAbs.id}]。该队列随访 5 年[@c:${withAbs.id}]。` }] }, { actor: 'user', turnId: null })
    const ev = (await t.call('verify_claims', { doc_id: t.docId })).body
    expect(ev.claims.map((c: any) => !!c.no_abstract)).toEqual([false, true, false])
    const r = await t.call('claim_report', { doc_id: t.docId, results: [
      { claim_id: ev.claims[0].claim_id, verdict: 'unsupported', reason: '摘要显示按计划完成。' },
      { claim_id: ev.claims[1].claim_id, verdict: 'unclear', reason: '没有摘要。' },
      { claim_id: ev.claims[2].claim_id, verdict: 'unclear', reason: '摘要没提随访时长。', no_evidence: true },
    ] })
    expect(r.body.results.map((x: any) => x.status)).toEqual(['commented', 'no_evidence', 'no_evidence'])
    expect(t.store.listComments(t.docId, 'open')).toHaveLength(1)
  })

  it('超长摘要截断时保留结果与结论段', async () => {
    const { fitAbstract } = await import('../src/claims/service.ts')
    const abs = `BACKGROUND: ${'背景'.repeat(1500)} METHODS: ${'方法'.repeat(1000)} RESULTS: HR 0.80 (95% CI 0.72-0.90). CONCLUSIONS: 降低 20%。`
    const out = fitAbstract(abs, 4000)
    expect(out.length).toBeLessThanOrEqual(4000)
    expect(out).toContain('RESULTS: HR 0.80')
    expect(out).toContain('CONCLUSIONS')
    expect(out.startsWith('BACKGROUND')).toBe(true)
    expect(fitAbstract('短摘要', 4000)).toBe('短摘要')
  })
})

describe('MCP 会话失效', () => {
  it('被停止的 dsh 进程的令牌立即失效；当前进程的令牌照常', async () => {
    const { handleMcp } = await import('../src/mcp/server.ts')
    const live = new Set(['g-now'])
    const deps = { secret: SECRET, isLiveSession: (_u: string, g: string) => live.has(g) } as unknown as Parameters<typeof handleMcp>[0]
    const call = async (s: string) => {
      const token = issueToken(SECRET, { u: 'u1', d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60, s })
      const res = { code: 0, body: '', writeHead(code: number) { this.code = code; return this }, end(b: string) { this.body = b }, on() {} }
      await handleMcp(deps, { headers: { authorization: `Bearer ${token}` } } as never, res as never).catch(() => {})
      return res
    }
    const stale = await call('g-old')
    expect([stale.code, stale.body]).toEqual([401, 'session stopped'])
    expect((await call('g-now')).code).not.toBe(401)
  })
})

describe('AI 生成图片并插入（与人的插图能力一致）', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200"><rect width="400" height="200" fill="#F1F5F9"/><circle cx="100" cy="100" r="50" fill="#0EA5E9"/><text x="180" y="108" font-size="24" font-family="Noto Sans CJK SC">T 细胞 → 肿瘤</text></svg>'

  it('diagram_render：拒绝脚本、事件属性、外部链接；合法 SVG 渲染成资产，插进文档', async () => {
    const t = await connect('# 原理\n\n待补充。')
    for (const bad of [
      SVG.replace('</svg>', '<script>alert(1)</script></svg>'),
      SVG.replace('<circle', '<circle onclick="x()"'),
      SVG.replace('</svg>', '<image href="https://evil.example/a.png" width="10" height="10"/></svg>'),
    ]) {
      const r = await t.call('diagram_render', { svg: bad })
      expect([r.isError, r.body.code]).toEqual([true, 'invalid_svg'])
    }
    const r = await t.call('diagram_render', { svg: SVG, name: '免疫机制', width_px: 800 })
    expect(r.isError).toBe(false)
    expect([r.body.width, r.body.height]).toEqual([800, 400])
    const asset = t.store.getAsset(r.body.asset_id)!
    expect([asset.owner, asset.mime]).toEqual(['u1', 'image/png'])
    const outline = await t.call('doc_outline', { doc_id: t.docId })
    const h = /# \{#([a-z0-9]+)\} 原理/.exec(outline.text)![1]!
    const edit = await t.call('doc_edit', { doc_id: t.docId, base_rev: 0, ops: [{ op: 'insert_after', anchor_id: h, markdown: r.body.markdown }] })
    expect(edit.isError).toBe(false)
    expect((await t.call('doc_read', { doc_id: t.docId })).text).toContain(`asset:${r.body.asset_id}`)
  })

  it('幻灯片：AI 经 MCP 套主题、加色块、插入生成的图（画布能做的 AI 都能做）', async () => {
    const t = await connect('占位。')
    const created = await t.call('doc_create', { title: '机制汇报', kind: 'deck' })
    const deckId = created.body.doc_id as string
    const outline = await t.call('doc_outline', { doc_id: deckId })
    const slideId = /\{#([a-z0-9]+)\}/.exec(outline.text)![1]!
    const img = await t.call('diagram_render', { svg: SVG })
    const edit = await t.call('deck_edit', { doc_id: deckId, base_rev: created.body.rev, ops: [
      { op: 'apply_theme', theme: 'midnight' },
      { op: 'add_shape', slide_id: slideId, x: 40, y: 360, w: 300, h: 60, geometry: 'roundRect', fill: 'accent', color: 'FFFFFF', markdown: 'PD-1 阻断' },
      { op: 'add_image', slide_id: slideId, asset_id: img.body.asset_id, x: 400, y: 120, w: 480 },
    ] })
    expect(edit.isError).toBe(false)
    const read = await t.call('slide_read', { doc_id: deckId, slide_id: slideId })
    expect(read.text).toContain('主题 midnight')
    expect(read.text).toContain('roundRect')
    expect(read.text).toMatch(/图片/)
  })

  it('幻灯片模板：AI 列出模板、按模板新建、按版式加页、换模板（与画布的模板选择器、加页菜单同一套）', async () => {
    const t = await connect('占位。')
    const list = await t.call('deck_templates', {})
    expect(list.body.templates.length).toBeGreaterThanOrEqual(8)
    expect(list.body.layouts.map((l: { name: string }) => l.name)).toContain('大数字')
    const created = await t.call('doc_create', { title: '年度总结', kind: 'deck', template: 'swiss' })
    expect(created.body.template).toBe('swiss')
    const deckId = created.body.doc_id as string
    const outline = await t.call('doc_outline', { doc_id: deckId })
    expect(outline.text).toContain('[封面]')
    expect(outline.text).toContain('两栏（')
    const first = /\{#([a-z0-9]+)\}/.exec(outline.text)![1]!
    const edit = await t.call('deck_edit', { doc_id: deckId, base_rev: created.body.rev, ops: [
      { op: 'add_slide', after: first, layout: '两栏', title: '对比', body: '- 治疗组', body2: '- 对照组' },
      { op: 'apply_theme', theme: 'mint' },
    ] })
    expect(edit.isError).toBe(false)
    const slideId = /第 2 页 \{#([a-z0-9]+)\}/.exec((await t.call('doc_outline', { doc_id: deckId })).text)![1]!
    const read = await t.call('slide_read', { doc_id: deckId, slide_id: slideId })
    expect(read.text).toContain('主题 mint')
    expect(read.text).toMatch(/模板装饰 \d+ 个/)
    expect(read.text).toContain('对照组')
  })

  it('slide_render：服务端内置光栅化引擎自闭环返回真实 PNG 图片，无需外部系统 LibreOffice', async () => {
    const t = await connect('占位。')
    const created = await t.call('doc_create', { title: '测试演示', kind: 'deck' })
    const deckId = created.body.doc_id as string
    const outline = await t.call('doc_outline', { doc_id: deckId })
    const slideId = /\{#([a-z0-9]+)\}/.exec(outline.text)![1]!
    const res = await t.call('slide_render', { doc_id: deckId, slide_id: slideId })
    expect(res.isError).toBe(false)
    expect(res.content?.[0]?.type).toBe('image')
    expect(res.content?.[0]?.mimeType).toBe('image/png')
    expect(typeof res.content?.[0]?.data).toBe('string')
    expect((res.content?.[0]?.data ?? '').length).toBeGreaterThan(100)
  }, 30000)
})

describe('文档仓库（AI 一侧）', () => {
  it('docs_search 跨文档搜索；回收站里的文档 AI 读不到也搜不到', async () => {
    const { SearchIndex } = await import('../src/model/search-index.ts')
    const t = await connect('# 心衰\n\n沙库巴曲缬沙坦可降低心衰住院。')
    const search = new SearchIndex(t.docs, 0)
    search.reindex(t.docId)
    const other = t.docs.create({ owner: 'u1', title: '糖尿病笔记', content: undefined })
    search.reindex(other.id)
    const hits = await t.call('docs_search', { query: '沙库巴曲' })
    expect(hits.body.map((h: any) => h.doc_id)).toEqual([t.docId])
    expect(hits.body[0].snippet).toContain('[沙库巴曲]')
    t.store.trashDoc(t.docId, true)
    expect((await t.call('docs_search', { query: '沙库巴曲' })).body).toEqual([])
    const read = await t.call('doc_outline', { doc_id: t.docId })
    expect([read.isError, read.body.code]).toEqual([true, 'doc_not_found'])
  })

  it('参考资料库：kb_search 找到片段与出处，kb_read 按页读原文；读不到别人的资料', async () => {
    const t = await connect('# 引言\n\n待补充。')
    const enc = (x: string) => new TextEncoder().encode(x)
    const mine = await t.kb.upload('u1', { name: '指南.md', bytes: enc('# 心衰指南\n\n射血分数降低的心衰推荐使用 SGLT2 抑制剂以降低住院风险。') })
    const other = await t.kb.upload('u2', { name: 'secret.txt', bytes: enc('SGLT2 confidential notes from another user.') })
    await t.kb.idle()
    const hits = await t.call('kb_search', { query: 'SGLT2' })
    expect(hits.body.map((h: any) => h.file_id)).toEqual([mine.file.id])
    expect(hits.body[0]).toMatchObject({ file: '指南.md', page: 1 })
    const read = await t.call('kb_read', { file_id: mine.file.id })
    expect(read.text).toContain('《指南.md》')
    expect(read.text).toContain('［第 1 页］')
    const denied = await t.call('kb_read', { file_id: other.file.id })
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('file_not_found')
  })

  it('记忆：memory_propose 提议并通知对话；明确要求直接生效；本轮关闭时不可用；敏感内容被拦；memory_search 只找已生效的', async () => {
    const t = await connect('# 引言\n\n待补充。')
    const notices: any[] = []
    t.registry.begin('u1', { turnId: 't1', docId: t.docId, touched: new Set(), notify: n => notices.push(n), mode: 'apply', memory: true })
    const p = await t.call('memory_propose', { content: '数值保留两位小数', kind: 'preference', reason: '用户两次改成两位小数' })
    expect(p.body.result).toBe('proposed')
    expect(notices[0]).toMatchObject({ type: 'memory', result: 'proposed', memory: { content: '数值保留两位小数', source_turn_id: 't1' } })
    const e = await t.call('memory_propose', { content: '统计软件用 R', kind: 'fact', explicit: true })
    expect(e.body.result).toBe('active')
    const blocked = await t.call('memory_propose', { content: '患者王某某，男，65岁', kind: 'fact', explicit: true })
    expect([blocked.isError, JSON.parse(blocked.text).code]).toEqual([true, 'sensitive_content'])
    const found = await t.call('memory_search', { query: '统计软件' })
    expect(found.body.map((m: any) => m.content)).toEqual(['统计软件用 R'])
    t.registry.end('u1', 't1')

    t.registry.begin('u1', { turnId: 't2', docId: t.docId, touched: new Set(), notify: () => {}, mode: 'apply', memory: false })
    const off = await t.call('memory_propose', { content: '别的偏好', kind: 'preference' })
    expect(JSON.parse(off.text).code).toBe('memory_off')
    expect(JSON.parse((await t.call('memory_search', { query: '统计' })).text).code).toBe('memory_off')
    // 忘掉：本轮关闭记忆时也能用，并通知对话
    const gone: any[] = []
    t.registry.end('u1', 't2')
    t.registry.begin('u1', { turnId: 't3', docId: t.docId, touched: new Set(), notify: n => gone.push(n), mode: 'apply', memory: false })
    const f = await t.call('memory_forget', { target: '统计软件用 R' })
    expect(f.body).toMatchObject({ result: 'forgotten', forgotten: ['统计软件用 R'] })
    expect(gone[0]).toMatchObject({ type: 'memory', result: 'forgotten' })
    expect(JSON.parse((await t.call('memory_forget', { target: '统计软件用 R' })).text).code).toBe('not_found')
  })

  it('数据集：dataset_list / describe / open 只给自己的、已处理身份信息的；asset_upload 记下代码与数据来源', async () => {
    const t = await connect('一段。')
    const ok = t.datasets.upload('u1', 'trial.csv', new TextEncoder().encode('x')).dataset
    const phi = t.datasets.upload('u1', 'phi.csv', new TextEncoder().encode('y')).dataset
    const other = t.datasets.upload('u2', 'mine.csv', new TextEncoder().encode('z')).dataset
    await t.datasets.idle()
    t.datasets.update('u1', ok.id, { labels: { age: '年龄（岁）' } })

    const list = await t.call('dataset_list', {})
    expect(list.body.map((d: any) => [d.name, d.status]).sort()).toEqual([['phi', 'review'], ['trial', 'ready']])
    expect((await t.call('dataset_describe', { dataset_id: ok.id })).body.columns[1]).toMatchObject({ name: 'age', label: '年龄（岁）' })
    expect(JSON.parse((await t.call('dataset_describe', { dataset_id: other.id })).text).code).toBe('not_found')

    const opened = await t.call('dataset_open', { dataset_id: ok.id })
    expect(opened.body).toMatchObject({ path: `data/${ok.id}.csv`, rows: 2, labels: { age: '年龄（岁）' } })
    expect(readFileSync(join(t.workspace, opened.body.path), 'utf8')).toContain('arm,age')
    expect(JSON.parse((await t.call('dataset_open', { dataset_id: phi.id })).text).code).toBe('needs_review')
    expect(JSON.parse((await t.call('dataset_open', { dataset_id: other.id })).text).code).toBe('not_found')

    // 分析画的图：带上脚本与数据集
    writeFileSync(join(t.workspace, 'km.py'), 'import pandas as pd\n# KM 曲线\n')
    writeFileSync(join(t.workspace, 'km.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    const up = await t.call('asset_upload', { path: 'km.png', code_path: 'km.py', dataset_ids: [ok.id, other.id] })
    const prov = t.store.getAssetProvenance(up.body.asset_id)!
    expect(prov.code).toContain('KM 曲线')
    expect(prov.datasets.map(d => d.name)).toEqual(['trial'])
    expect(t.store.getAssetProvenance((await t.call('asset_upload', { path: 'km.png' })).body.asset_id)).toBeNull()


    // Table 1 自动计算与三线表生成
    const t1 = await t.call('dataset_table1', { dataset_id: ok.id, group_col: 'arm' })
    expect(t1.body.markdown).toContain('Table 1')
    expect(t1.body.table1.groups.map((g: any) => g.name)).toEqual(['A', 'B'])
    expect(t1.body.markdown).toContain('年龄（岁）')
  })


  it('记忆：memory_review 生成待用户采纳的建议（与界面「整理记忆」同一方法），本轮关闭记忆时不可用', async () => {
    const t = await connect('一段。')
    for (const content of ['数值保留两位小数', '小数保留两位']) await t.memory.propose('u1', { content, kind: 'preference', scope: 'global' }, { source: 'manual', actor: 'user' })
    const notices: unknown[] = []
    t.registry.begin('u1', { turnId: 't1', docId: t.docId, touched: new Set(), notify: n => notices.push(n), mode: 'apply', memory: true })
    const r = await t.call('memory_review', {})
    expect(r.body).toMatchObject({
      result: 'reviewed',
      new_memories_proposed: [{ content: '效应量写 HR 与 95% CI' }],
      cleanup_suggestions: [{ action: '合并', new_content: '数值一律保留两位小数' }],
    })
    // 两条记忆同一毫秒创建，先后不固定：只比内容
    expect([...r.body.cleanup_suggestions[0].memories].sort()).toEqual(['小数保留两位', '数值保留两位小数'])
    expect(notices).toMatchObject([{ type: 'memory', result: 'proposed' }])
    // 建议不会自动生效
    expect(t.store.listMemories('u1', ['active']).map(m => m.content).sort()).toEqual(['小数保留两位', '数值保留两位小数'])
    t.registry.begin('u1', { turnId: 't2', docId: t.docId, touched: new Set(), notify: () => {}, mode: 'apply', memory: false })
    expect(JSON.parse((await t.call('memory_review', {})).text).code).toBe('memory_off')
  })
})

describe('图表（AI 与画布同一套操作）', () => {
  it('AI 经 deck_edit 新建图表、slide_read 读到数据、chart_set_data 改数据', async () => {
    const t = await connect('占位。')
    const created = await t.call('doc_create', { title: '结果汇报', kind: 'deck' })
    const deckId = created.body.doc_id as string
    const slideId = /\{#([a-z0-9]+)\}/.exec((await t.call('doc_outline', { doc_id: deckId })).text)![1]!
    const add = await t.call('deck_edit', { doc_id: deckId, base_rev: created.body.rev, ops: [
      { op: 'add_chart', slide_id: slideId, type: 'column', x: 60, y: 120, w: 600, h: 320, title: '主要终点', categories: ['MACE', '心衰住院'], series: [{ name: '司美格鲁肽', values: [6.5, 3.1] }] },
    ] })
    expect(add.isError).toBe(false)
    const chartId = add.body.results[0].ids[0]
    const read = await t.call('slide_read', { doc_id: deckId, slide_id: slideId })
    expect(read.text).toContain('柱状图「主要终点」')
    expect(read.text).toContain('系列「司美格鲁肽」：6.5 | 3.1')
    const edit = await t.call('deck_edit', { doc_id: deckId, base_rev: add.body.rev, ops: [
      { op: 'chart_set_data', shape_id: chartId, series: [{ name: '司美格鲁肽', values: [6.5, 3.1] }, { name: '安慰剂', values: [8.0, 3.7] }] },
    ] })
    expect(edit.isError).toBe(false)
    expect((await t.call('slide_read', { doc_id: deckId, slide_id: slideId })).text).toContain('系列「安慰剂」：8 | 3.7')
    const bad = await t.call('deck_edit', { doc_id: deckId, base_rev: edit.body.rev, ops: [{ op: 'chart_set_data', shape_id: chartId, series: [{ name: 'x', values: [1] }] }] })
    expect([bad.isError, bad.body.code]).toEqual([true, 'invalid_chart'])
    // 换类型：折线可以；饼图要单系列，给出可操作的提示
    const line = await t.call('deck_edit', { doc_id: deckId, base_rev: edit.body.rev, ops: [{ op: 'chart_set_type', shape_id: chartId, type: 'line' }] })
    expect(line.isError).toBe(false)
    expect((await t.call('slide_read', { doc_id: deckId, slide_id: slideId })).text).toContain('折线图「主要终点」')
    const pie = await t.call('deck_edit', { doc_id: deckId, base_rev: line.body.rev, ops: [{ op: 'chart_set_type', shape_id: chartId, type: 'pie' }] })
    expect([pie.isError, pie.body.code]).toEqual([true, 'invalid_chart'])
    expect(pie.body.hint).toContain('一个系列')
  })
})
