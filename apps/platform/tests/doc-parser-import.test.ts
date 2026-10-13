import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Node as PMNode } from 'prosemirror-model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { docParserToDoc, HttpDocParser, type DocParser, type DocParseResult } from '../src/convert/doc-parser.ts'
import { importPdf } from '../src/convert/pdf-import.ts'
import { pdf } from './fixtures.ts'

const hasPoppler = (() => {
  if (['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].some(d => existsSync(join(d, 'pdftohtml')))) return true
  try { execFileSync('pdftohtml', ['-v'], { stdio: 'ignore' }); return true } catch { return false }
})()

/** 1×1 PNG */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 模拟 doc-parser 的解析结果：覆盖所有块类型、OCR 成功的扫描页、OCR 失败的扫描页 */
function sampleResult(): DocParseResult {
  return {
    engine: 'docling', engine_version: '2.x', page_count: 4,
    blocks: [
      { type: 'heading', level: 1, text: 'Effects of Exercise on Recovery', page: 1 },
      { type: 'paragraph', text: 'doi: 10.1234/abcd.5678 Regular activity improves outcomes.', page: 1 },
      { type: 'heading', level: 2, text: '1. Introduction', page: 1 },
      { type: 'list', ordered: false, items: ['Measure recovery time', 'Compare programs'], page: 1 },
      { type: 'list', ordered: true, start: 3, items: ['Third', 'Fourth'], page: 1 },
      { type: 'table', rows: [['Group', 'N'], ['Control', '40'], ['Exercise', '42']], header_rows: 1, caption: 'Table 1. Baseline.', page: 1 },
      { type: 'figure', mime: 'image/png', data: PNG, caption: '', page: 2 },
      { type: 'paragraph', text: 'Figure 1. Study flow.', page: 2 },
      { type: 'formula', latex: 'E = mc^2', page: 2 },
      { type: 'formula', latex: '', text: 'a + b = c', page: 2 },
      { type: 'paragraph', text: '扫描页 OCR 出来的文字。', page: 3 },
      { type: 'paragraph', text: '第五页正文。', page: 5 },
    ],
    scanned_pages: [{ page: 3, ocr: true }, { page: 4, ocr: false, mime: 'image/png', data: PNG }],
    warnings: ['示例警告'],
  }
}

const blocks = (doc: PMNode) => { const out: PMNode[] = []; doc.forEach(n => { out.push(n) }); return out }
const types = (doc: PMNode) => blocks(doc).map(n => n.type.name)

class StubParser implements DocParser {
  calls = 0
  constructor(private readonly opts: { ready?: boolean; fail?: string; result?: DocParseResult } = {}) {}
  async ready() { return this.opts.ready ?? true }
  async parse() {
    this.calls++
    if (this.opts.fail) throw new Error(this.opts.fail)
    return this.opts.result ?? sampleResult()
  }
}

describe('doc-parser 结果 → 文档模型', () => {
  it('标题 / 段落 / 列表 / 表格 / 图 / 公式转成对应节点；扫描页按 OCR 结果注明或退回整页图', () => {
    const { doc, assets, warnings } = docParserToDoc(sampleResult(), '样例')
    expect(types(doc)).toEqual([
      'paragraph', // 导入说明
      'heading', 'paragraph', 'heading', 'bullet_list', 'ordered_list',
      'paragraph', 'table', // 表题注 + 表
      'figure', 'paragraph', 'paragraph', // 图（题注并入）+ 两个公式
      'paragraph', // 第 3 页 OCR 文字
      'figure', // 第 4 页 OCR 失败：整页图，在第 5 页内容之前
      'paragraph',
    ])
    const bs = blocks(doc)
    expect(bs[0]!.textContent).toContain('第 3 页为扫描页，文字由 OCR 识别')
    expect(bs[0]!.textContent).toContain('第 4 页为扫描页，未识别文字')
    expect(bs[1]!.attrs.level).toBe(1)
    expect(bs[3]!.attrs.level).toBe(2)
    expect(bs[4]!.child(1).textContent).toBe('Compare programs')
    expect(bs[5]!.attrs.start).toBe(3)

    const table = bs[7]!
    expect(table.childCount).toBe(3)
    expect(table.child(0).child(0).attrs.header).toBe(true)
    expect(table.child(1).child(0).attrs.header).toBe(false)
    expect(table.child(2).child(1).textContent).toBe('42')

    expect(bs[8]!.attrs).toMatchObject({ asset_id: 'pdf_img_2_1', caption: 'Figure 1. Study flow.' })
    expect(doc.textContent.match(/Figure 1\. Study flow/g)).toBeNull() // 图注在属性里，不重复成段落
    expect(bs[9]!.attrs.style).toBe('Code')
    expect(bs[9]!.textContent).toBe('$$E = mc^2$$')
    expect(bs[10]!.textContent).toBe('a + b = c')
    expect(bs[12]!.attrs).toMatchObject({ asset_id: 'pdf_scan_4' })

    expect(assets.map(a => a.key)).toEqual(['pdf_img_2_1', 'pdf_scan_4'])
    expect(assets[0]!.mime).toBe('image/png')
    expect(Buffer.from(assets[0]!.bytes).subarray(1, 4).toString()).toBe('PNG')
    expect(warnings).toContain('示例警告')
  })

  it('空结果给出说明段落', () => {
    const { doc, warnings } = docParserToDoc({ engine: 'docling', page_count: 1, blocks: [], scanned_pages: [], warnings: [] }, 't')
    expect(doc.textContent).toContain('没有可识别的内容')
    expect(warnings.length).toBe(1)
  })
})

describe('PDF 导入：doc-parser 主路径与 poppler 兜底', () => {
  const tiny = () => pdf([[
    { text: 'Fallback Title', x: 72, y: 90, size: 20, bold: true },
    { text: 'Body text of the fallback document goes here.', x: 72, y: 130, size: 10 },
  ]])

  it('服务就绪：用 doc-parser 结果，engine=docling，块 id 已分配，DOI 从正文检出', async () => {
    const stub = new StubParser()
    const r = await importPdf(tiny(), '样例.pdf', { docParser: stub })
    expect(stub.calls).toBe(1)
    expect(r.engine).toBe('docling')
    expect(r.fallbackReason).toBeUndefined()
    expect(r.pageCount).toBe(4)
    expect(r.doi).toBe('10.1234/abcd.5678')
    expect(blocks(r.doc).every(n => typeof n.attrs.id === 'string' && n.attrs.id.length >= 4)).toBe(true)
  })

  it.skipIf(!hasPoppler)('服务未就绪：不调用解析，退回 poppler 并记录原因', async () => {
    const stub = new StubParser({ ready: false })
    const r = await importPdf(tiny(), '样例.pdf', { docParser: stub })
    expect(stub.calls).toBe(0)
    expect(r.engine).toBe('poppler')
    expect(r.fallbackReason).toBe('文档解析服务未就绪')
    expect(r.warnings[0]).toContain('已改用基础解析')
    expect(blocks(r.doc)[0]!.textContent).toBe('Fallback Title')
  })

  it.skipIf(!hasPoppler)('解析失败：退回 poppler 并记录错误', async () => {
    const r = await importPdf(tiny(), '样例.pdf', { docParser: new StubParser({ fail: 'boom' }) })
    expect(r.engine).toBe('poppler')
    expect(r.fallbackReason).toContain('boom')
    expect(types(r.doc)).toContain('heading')
  })

  it.skipIf(!hasPoppler)('没配置服务：直接用 poppler，不加降级提示', async () => {
    const r = await importPdf(tiny(), '样例.pdf')
    expect(r.engine).toBe('poppler')
    expect(r.warnings.some(w => w.includes('已改用基础解析'))).toBe(false)
  })
})

describe('HttpDocParser（本地桩服务）', () => {
  let server: Server
  let base = ''
  let health = { status: 503, body: { status: 'warming', ready: false } as Record<string, unknown> }
  let parseStatus = 200
  let lastUpload = ''

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(health.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(health.body))
        return
      }
      if (req.url === '/parse' && req.method === 'POST') {
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c as Buffer))
        req.on('end', () => {
          lastUpload = Buffer.concat(chunks).toString('latin1')
          res.writeHead(parseStatus, { 'content-type': 'application/json' })
          res.end(parseStatus === 200 ? JSON.stringify(sampleResult()) : JSON.stringify({ detail: '解析失败：bad' }))
        })
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => { server.close() })

  it('预热中（503）视为未就绪；就绪后可解析，上传的是 multipart 的 PDF', async () => {
    const p = new HttpDocParser(base)
    expect(await p.ready()).toBe(false)
    health = { status: 200, body: { status: 'ready', ready: true } }
    expect(await p.ready()).toBe(true)
    const r = await p.parse(pdf([[{ text: 'x', x: 72, y: 90, size: 10 }]]), 'a.pdf')
    expect(r.blocks.length).toBe(sampleResult().blocks.length)
    expect(lastUpload).toContain('filename="a.pdf"')
    expect(lastUpload).toContain('%PDF')
  })

  it('服务返回错误时抛错（调用方据此兜底）', async () => {
    parseStatus = 422
    await expect(new HttpDocParser(base).parse(new Uint8Array([1]), 'a.pdf')).rejects.toThrow(/422/)
    parseStatus = 200
  })

  it('连不上时视为未就绪', async () => {
    expect(await new HttpDocParser('http://127.0.0.1:1', { healthTimeoutMs: 500 }).ready()).toBe(false)
  })

  it('HTTP 上传 PDF：响应里记录 importEngine', async () => {
    const { Store } = await import('../src/store/db.ts')
    const { Documents } = await import('../src/model/runtime.ts')
    const { OpService } = await import('../src/ops/service.ts')
    const { PostCheck } = await import('../src/collab/postcheck.ts')
    const { SlideRenderer } = await import('../src/render/slides.ts')
    const { Accounts } = await import('../src/auth/accounts.ts')
    const { issueToken } = await import('../src/auth/token.ts')
    const { buildApi } = await import('../src/http/api.ts')
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const user = store.createUser({ username: 'dp_u', display_name: 'U', password_hash: 'x' })
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'dp-render-'))),
      accounts: new Accounts(store, { secret: 'test-secret', devMode: true, devToken: 'dev', devUser: user.id }),
      devMode: true, devUser: user.id, docParser: new StubParser(),
    })
    const token = `Bearer ${issueToken('test-secret', { u: user.id, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: user.token_version })}`
    const form = new FormData()
    const bytes = pdf([[{ text: 'x', x: 72, y: 90, size: 10 }]])
    form.append('file', new File([bytes as Uint8Array<ArrayBuffer>], '样例.pdf', { type: 'application/pdf' }))
    const res = await app.request('/api/docs', { method: 'POST', headers: { Authorization: token }, body: form })
    expect(res.status).toBe(201)
    const row = await res.json() as { id: string; importEngine: string }
    expect(row.importEngine).toBe('docling')
    const doc = docs.get(row.id)
    expect(types(doc)).toContain('table')
    // 图片资产已绑定为平台资产 id
    const fig = blocks(doc).find(n => n.type.name === 'figure')!
    expect(fig.attrs.asset_id).not.toBe('pdf_img_2_1')
    expect(store.getPackage(row.id)?.length).toBe(bytes.length)
  })
})
