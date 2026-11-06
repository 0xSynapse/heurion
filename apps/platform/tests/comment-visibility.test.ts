import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvedThreadIds } from '@heurion2/canvas-ui/src/comments.ts'
import { Accounts } from '../src/auth/accounts.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { readLayouts } from '../src/convert/pptx-layouts.ts'
import { pptxTemplate } from '../src/convert/pptx-template.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { attachComment } from '../src/model/anchors.ts'
import { Documents } from '../src/model/runtime.ts'
import { newDeckContent } from '../src/ops/deck.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

describe('已关闭批注的正文显示', () => {
  it('只把 resolved 线程视为已关闭', () => {
    expect([...resolvedThreadIds([
      { id: 'open-1', status: 'open' },
      { id: 'closed-1', status: 'resolved' },
    ])]).toEqual(['closed-1'])
    expect(resolvedThreadIds([]).size).toBe(0)
    expect(resolvedThreadIds(undefined).size).toBe(0)
  })

  it('关闭批注只改线程状态：文档详情仍带锚点，deck 接口带线程状态供渲染层隐藏高亮', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const ops = new OpService(docs)
    const turns = new TurnService(docs, {} as HarnessPool, new TurnRegistry())
    const accounts = new Accounts(store, { secret: 's', devMode: true, devToken: 'dev-token', devUser: 'u1' })
    const app = buildApi({
      docs, ops, turns, postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'comment-visibility-'))),
      accounts, devMode: true, devUser: 'u1',
    })
    const call = (path: string) => app.request(path, { headers: { Authorization: 'Bearer dev-token' } })

    // 文档：批注锚在正文文字上，关闭后标记仍在模型里（重新打开 / 定位归档还能用）
    const doc = docs.create({ owner: 'u1', title: '文稿', markdown: '第一段。' })
    const p1 = docs.get(doc.id).child(0).attrs.id as string
    const c = store.addComment({ doc_id: doc.id, node_id: p1, snippet: '第一段' })
    docs.commit(doc.id, attachComment(docs.get(doc.id), p1, '第一段', c.id).doc, { actor: 'user', turnId: null, ops: [{ op: 'comment', thread: c.id }] })
    expect((await app.request(`/api/docs/${doc.id}/comments/${c.id}/resolve`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-token' },
    })).status).toBe(200)

    const detail = await (await call(`/api/docs/${doc.id}`)).json() as any
    expect(detail.comments.find((x: any) => x.id === c.id)?.status).toBe('resolved')
    let marked = false
    docs.get(doc.id).descendants(n => {
      if (n.isText && n.marks.some(m => m.type.name === 'comment' && m.attrs.thread === c.id)) marked = true
      return true
    })
    expect(marked).toBe(true)

    // 幻灯片：deck 模型接口返回线程状态（渲染层据此不给已关闭批注画高亮 / 下划线）
    const pkg = pptxTemplate()
    const { layouts } = readLayouts(pkg)
    const deck = docs.create({ owner: 'u1', title: '汇报', kind: 'deck', content: newDeckContent(layouts, 'SELECT 试验') })
    store.putPackage(deck.id, 'pptx', pkg)
    const dc = store.addComment({ doc_id: deck.id, node_id: 's0', snippet: '' })
    store.setCommentStatus(deck.id, dc.id, 'resolved', 'user')
    const model = await (await call(`/api/docs/${deck.id}/deck`)).json() as any
    expect(model.comments).toContainEqual({ id: dc.id, status: 'resolved' })
  })
})
