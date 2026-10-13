import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Node as PMNode } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { buildPdfDeck, buildPdfDoc, importPdf, type PdfLine, type PdfPage } from '../src/convert/pdf-import.ts'
import { deckPdf, pdf, type PdfItem } from './fixtures.ts'

/** 本机或容器里是否有 poppler 的 pdftohtml（集成测试依赖它） */
const hasPoppler = (() => {
  if (['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].some(d => existsSync(join(d, 'pdftohtml')))) return true
  try { execFileSync('pdftohtml', ['-v'], { stdio: 'ignore' }); return true } catch { return false }
})()

const runningHeader = (n: number): PdfItem[] => [
  { text: 'Journal of Test Medicine 2026', x: 72, y: 40, size: 8 },
  { text: String(n), x: 290, y: 810, size: 8 },
]

/** 三页样例：第 1 页标题 / 段落（含断行连字符）/ 无序列表 / 表格 / 嵌入图片与题注；第 2 页有序列表；第 3 页只有整页图片（扫描页） */
function samplePdf(): Uint8Array {
  return pdf([
    [
      ...runningHeader(1),
      { text: 'Effects of Exercise on Recovery', x: 72, y: 90, size: 20, bold: true },
      { text: '1. Introduction', x: 72, y: 130, size: 14, bold: true },
      { text: 'Regular physical activity is associated with improved outcomes in pa-', x: 72, y: 155, size: 10 },
      { text: 'tients recovering from surgery. This study examines the effect of a', x: 72, y: 168, size: 10 },
      { text: 'structured program on recovery time.', x: 72, y: 181, size: 10 },
      { text: 'A second paragraph starts here after a visible gap between blocks.', x: 72, y: 205, size: 10 },
      { text: 'Key aims of the study:', x: 72, y: 229, size: 10 },
      { text: '• Measure recovery time after surgery', x: 82, y: 245, size: 10 },
      { text: '• Compare two exercise programs', x: 82, y: 258, size: 10 },
      { text: '2. Methods', x: 72, y: 290, size: 14, bold: true },
      { text: 'Group', x: 72, y: 320, size: 10, bold: true },
      { text: 'N', x: 200, y: 320, size: 10, bold: true },
      { text: 'Mean age', x: 300, y: 320, size: 10, bold: true },
      { text: 'Control', x: 72, y: 335, size: 10 },
      { text: '40', x: 200, y: 335, size: 10 },
      { text: '61.2', x: 300, y: 335, size: 10 },
      { text: 'Exercise', x: 72, y: 350, size: 10 },
      { text: '42', x: 200, y: 350, size: 10 },
      { text: '60.8', x: 300, y: 350, size: 10 },
      { image: { w: 40, h: 30, rgb: [200, 30, 30] }, x: 72, y: 380, width: 160, height: 120 },
      { text: 'Figure 1. Study flow.', x: 72, y: 515, size: 9 },
    ],
    [
      ...runningHeader(2),
      { text: '3. Results', x: 72, y: 90, size: 14, bold: true },
      { text: 'Recovery was faster in the exercise group.', x: 72, y: 115, size: 10 },
      { text: '1) First numbered finding', x: 72, y: 140, size: 10 },
      { text: '2) Second numbered finding', x: 72, y: 153, size: 10 },
    ],
    [{ image: { w: 60, h: 80, rgb: [240, 240, 240] }, x: 0, y: 0, width: 595, height: 842 }],
  ])
}

const blocks = (doc: PMNode) => { const out: PMNode[] = []; doc.forEach(n => { out.push(n) }); return out }
const types = (doc: PMNode) => blocks(doc).map(n => n.type.name)

describe.skipIf(!hasPoppler)('PDF 导入为可编辑文档（poppler）', () => {
  it('标题 / 段落 / 列表 / 表格是结构化节点；只插嵌入图片，不插整页截图', async () => {
    const r = await importPdf(samplePdf(), '样例.pdf')
    const bs = blocks(r.doc)
    const t = types(r.doc)
    expect(t).toEqual([
      'paragraph', // 导入说明（扫描页）
      'heading', 'heading', 'paragraph', 'paragraph', 'paragraph', 'bullet_list',
      'heading', 'table', 'figure',
      'heading', 'paragraph', 'ordered_list',
      'figure', // 第 3 页扫描页
    ])
    expect(r.pageCount).toBe(3)

    const headings = bs.filter(n => n.type.name === 'heading')
    expect(headings.map(h => [h.attrs.level, h.textContent])).toEqual([[1, 'Effects of Exercise on Recovery'], [2, '1. Introduction'], [2, '2. Methods'], [2, '3. Results']])

    // 断行连字符去掉、同段多行合并、段落间隔另起一段
    expect(bs[3]!.textContent).toBe('Regular physical activity is associated with improved outcomes in patients recovering from surgery. This study examines the effect of a structured program on recovery time.')
    expect(bs[4]!.textContent).toBe('A second paragraph starts here after a visible gap between blocks.')

    const bullet = bs.find(n => n.type.name === 'bullet_list')!
    expect(bullet.childCount).toBe(2)
    expect(bullet.child(0).textContent).toBe('Measure recovery time after surgery')
    const ordered = bs.find(n => n.type.name === 'ordered_list')!
    expect(ordered.childCount).toBe(2)
    expect(ordered.child(1).textContent).toBe('Second numbered finding')

    const table = bs.find(n => n.type.name === 'table')!
    expect(table.childCount).toBe(3)
    expect(table.child(0).childCount).toBe(3)
    expect(table.child(0).child(0).attrs.header).toBe(true)
    expect(table.child(2).child(2).textContent).toBe('60.8')

    // 嵌入图片带题注；题注不再重复成段落
    const figs = bs.filter(n => n.type.name === 'figure')
    expect(figs[0]!.attrs.caption).toBe('Figure 1. Study flow.')
    expect(bs.filter(n => n.type.name === 'paragraph').some(n => n.textContent.startsWith('Figure 1'))).toBe(false)
    // 不再有逐页「原版视图」截图；只有嵌入图 + 扫描页
    expect(r.assets.map(a => a.key)).toEqual(['pdf_img_1_1', 'pdf_scan_3'])
    expect(r.doc.textContent).not.toContain('原版视图')
    expect(figs.some(f => String(f.attrs.caption).includes('原版'))).toBe(false)

    // 页眉、页码删除；扫描页在开头注明
    expect(r.doc.textContent).not.toContain('Journal of Test Medicine')
    expect(bs.some(n => n.textContent === '1' || n.textContent === '2')).toBe(false)
    expect(bs[0]!.textContent).toContain('第 3 页为扫描页，未识别文字')
    expect(r.warnings).toContain('第 3 页为扫描页，未识别文字')
  })

  it('有 OCR 时扫描页识别成文字段落，不插整页图片', async () => {
    const r = await importPdf(samplePdf(), '样例.pdf', {
      ocr: async (_pdf, pages) => new Map(pages.map(p => [p, `扫描页第一段文字。\n\n扫描页第二段文字。`])),
    })
    expect(r.assets.map(a => a.key)).toEqual(['pdf_img_1_1'])
    const bs = blocks(r.doc)
    expect(bs[0]!.textContent).toContain('第 3 页为扫描页，文字由 OCR 识别')
    expect(bs.slice(-2).map(n => n.textContent)).toEqual(['扫描页第一段文字。', '扫描页第二段文字。'])
  })

  it('HTTP 上传 PDF 新建文档：得到结构化内容，原始 PDF 存为文件包', async () => {
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
    const user = store.createUser({ username: 'pdf_u', display_name: 'U', password_hash: 'x' })
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'pdf-render-'))),
      accounts: new Accounts(store, { secret: 'test-secret', devMode: true, devToken: 'dev', devUser: user.id }),
      devMode: true, devUser: user.id,
    })
    const token = `Bearer ${issueToken('test-secret', { u: user.id, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: user.token_version })}`
    const form = new FormData()
    form.append('file', new File([samplePdf() as Uint8Array<ArrayBuffer>], '样例.pdf', { type: 'application/pdf' }))
    const res = await app.request('/api/docs', { method: 'POST', headers: { Authorization: token }, body: form })
    expect(res.status).toBe(201)
    const row = await res.json() as { id: string; title: string }
    expect(row.title).toBe('样例')
    const doc = docs.get(row.id)
    expect(types(doc)).toContain('table')
    expect(types(doc)).toContain('bullet_list')
    expect(types(doc).filter(t => t === 'figure').length).toBe(2)
    expect(store.getPackage(row.id)?.length).toBe(samplePdf().length)
  })

  it('横版演示文稿 PDF 自动识别为幻灯片（kind=deck）：生成独立 shape 形状与 EMU 坐标，支持编辑', async () => {
    const deckBytes = deckPdf([
      [
        { text: 'HEURION 2.0 ROADMAP', x: 80, y: 50, size: 24, bold: true },
        { text: 'Continuously evolving infrastructure for clinical research', x: 80, y: 85, size: 14 },
        { text: 'Live - Data and cohorts', x: 80, y: 180, size: 12, bold: true },
        { text: 'Lab report OCR and PHR.', x: 80, y: 200, size: 10 },
        { text: 'Live - 3D imaging', x: 340, y: 180, size: 12, bold: true },
        { text: 'MONAI and PyTorch.', x: 340, y: 200, size: 10 },
        { text: 'Milestone - Evidence', x: 600, y: 180, size: 12, bold: true },
        { text: 'Table 1 in Word.', x: 600, y: 200, size: 10 },
        { text: 'Try it at heurion.org', x: 80, y: 480, size: 10 },
      ],
    ])
    const r = await importPdf(deckBytes, '路线图.pdf')
    expect(r.kind).toBe('deck')
    expect(r.pageCount).toBe(1)
    expect(r.doc.childCount).toBe(1)
    const slide = r.doc.child(0)
    expect(slide.type.name).toBe('slide')

    // 形状数量：标题、副标题/正文、3 个横向卡片、页脚；各卡片独立成 shape
    const shapes: PMNode[] = []
    slide.forEach(n => { if (n.type.name === 'shape') shapes.push(n) })
    expect(shapes.length).toBeGreaterThanOrEqual(4)
    expect(shapes.every(s => s.attrs.kind === 'text')).toBe(true)

    // EMU 坐标已换算
    expect(shapes[0]!.attrs.x).toBeGreaterThan(0)
    expect(shapes[0]!.attrs.y).toBeGreaterThan(0)

    // 卡片之间保持分离，未被错误合并成一个大段落
    const texts = shapes.map(s => s.textContent)
    expect(texts.some(t => t.includes('Data and cohorts'))).toBe(true)
    expect(texts.some(t => t.includes('3D imaging'))).toBe(true)
    expect(texts.some(t => t.includes('Evidence'))).toBe(true)
    const cardData = shapes.find(s => s.textContent.includes('Data and cohorts'))!
    expect(cardData.textContent).not.toContain('3D imaging')
  })

  it('HTTP 上传演示文稿 PDF：自动创建 kind=deck，支持画布交互与幻灯片底座', async () => {
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
    const user = store.createUser({ username: 'deck_u', display_name: 'U', password_hash: 'x' })
    const app = buildApi({
      docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'deck-render-'))),
      accounts: new Accounts(store, { secret: 'test-secret', devMode: true, devToken: 'dev', devUser: user.id }),
      devMode: true, devUser: user.id,
    })
    const token = `Bearer ${issueToken('test-secret', { u: user.id, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: user.token_version })}`

    const deckBytes = deckPdf([
      [
        { text: 'SLIDE 1 TITLE', x: 80, y: 50, size: 24, bold: true },
        { text: 'Bullet point 1', x: 80, y: 150, size: 14 },
      ],
    ])
    const form = new FormData()
    form.append('file', new File([deckBytes as Uint8Array<ArrayBuffer>], '汇报.pdf', { type: 'application/pdf' }))
    const res = await app.request('/api/docs', { method: 'POST', headers: { Authorization: token }, body: form })
    expect(res.status).toBe(201)
    const row = await res.json() as { id: string; title: string; kind: string }
    expect(row.title).toBe('汇报')
    expect(row.kind).toBe('deck')
    const doc = docs.get(row.id)
    expect(doc.child(0).type.name).toBe('slide')
    expect(store.getPackage(row.id)).not.toBeNull()
  })
})

describe('PDF 版面 → 文档（不依赖 poppler）', () => {
  const line = (text: string, top: number, extra: Partial<PdfLine> = {}): PdfLine => ({ text, top, left: 60, width: 400, height: 14, size: 12, bold: false, ...extra })
  const page = (number: number, lines: PdfLine[]): PdfPage => ({ number, width: 600, height: 800, lines, images: [] })

  it('中文行合并不加空格；「第 N 页」页脚和跨页重复页眉删除；「3.5 mg」开头的行不当成编号列表', () => {
    const p1 = page(1, [
      line('某某医院学报', 20, { size: 9, height: 10 }),
      line('研究背景', 80, { size: 16, bold: true, height: 18 }),
      line('慢性肾病患者的运动干预研究较少，本研究纳入了', 110),
      line('一百二十名受试者进行观察。', 126),
      line('3.5 mg 剂量组的不良事件发生率较低。', 160),
      line('第 1 页', 770, { size: 9, height: 10 }),
    ])
    const p2 = page(2, [
      line('某某医院学报', 20, { size: 9, height: 10 }),
      line('研究方法采用回顾性队列设计，纳入标准如下：', 80),
      line('（1）年龄 18 岁以上', 100),
      line('（2）确诊慢性肾病', 116),
      line('第 2 页', 770, { size: 9, height: 10 }),
    ])
    const { doc } = buildPdfDoc([p1, p2], { baseName: 't' })
    const bs = blocks(doc)
    expect(bs.map(n => n.type.name)).toEqual(['heading', 'paragraph', 'paragraph', 'paragraph', 'ordered_list'])
    expect(bs[1]!.textContent).toBe('慢性肾病患者的运动干预研究较少，本研究纳入了一百二十名受试者进行观察。')
    expect(bs[2]!.textContent.startsWith('3.5 mg')).toBe(true)
    expect(bs[4]!.child(0).textContent).toBe('年龄 18 岁以上')
    expect(doc.textContent).not.toMatch(/某某医院学报|第 \d 页/)
  })

  it('没有文字也没有图片的 PDF 给出说明段落', () => {
    const { doc, warnings } = buildPdfDoc([page(1, [])], { baseName: 't' })
    expect(doc.textContent).toContain('第 1 页为扫描页，未识别文字')
    expect(warnings.length).toBeGreaterThan(0)
  })
})
