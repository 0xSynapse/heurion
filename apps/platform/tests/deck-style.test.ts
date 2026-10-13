import { DOMParser } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { exportPptx } from '../src/convert/pptx-export.ts'
import { readLayouts } from '../src/convert/pptx-layouts.ts'
import { pptxTemplate } from '../src/convert/pptx-template.ts'
import { DECK_THEMES } from '../src/model/deck-themes.ts'
import { Documents } from '../src/model/runtime.ts'
import { DeckOp, newDeckContent } from '../src/ops/deck.ts'
import { OpService } from '../src/ops/service.ts'
import { OpError } from '../src/ops/types.ts'
import { Store } from '../src/store/db.ts'
import { slideRead } from '../src/views/deck.ts'

/** 1×1 透明 PNG 的文件头改成 300×150（只读尺寸，不解码）。 */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

function deck() {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const pkg = pptxTemplate()
  const row = docs.create({ owner: 'u', title: '汇报', kind: 'deck', content: newDeckContent(readLayouts(pkg).layouts, 'SELECT 试验') })
  store.putPackage(row.id, 'pptx', pkg)
  const edit = (ops_: DeckOp[]) => ops.edit({ doc_id: row.id, base_rev: docs.rev(row.id), mode: 'apply', ops: ops_ }, { actor: 'ai', turnId: null })
  const exported = () => {
    const bytes = exportPptx({
      doc: docs.get(row.id), baseline: null, pkg: store.getPackage(row.id)!, src: id => store.getNodeSrc(row.id, id), citations: [],
      asset: id => { const a = store.getAsset(id); const b = store.getAssetBytes(id); return a && b ? { mime: a.mime, bytes: b } : null },
    }).bytes
    const files = unzipSync(bytes)
    const text = (name: string) => strFromU8(files[name]!)
    return { files, text }
  }
  const doc = () => docs.get(row.id)
  const slide = (i: number) => doc().child(i)
  const shape = (i: number, pred: (a: Record<string, any>) => boolean) => {
    let hit: any = null
    slide(i).forEach(s => { if (!hit && s.type.name === 'shape' && pred(s.attrs)) hit = s })
    return hit as ReturnType<typeof doc>
  }
  return { store, docs, docId: row.id, edit, exported, doc, slide, shape }
}

const wellFormed = (xml: string) => {
  const errors: string[] = []
  new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(msg) } }).parseFromString(xml, 'text/xml')
  return errors
}

describe('deck 样式操作（C1：画布与 MCP 共用）', () => {
  it('add_shape 色块：几何、填充（主题记号）、文字颜色 → 导出 prstGeom + srgbClr', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    const r = t.edit([{ op: 'add_shape', slide_id: sid, markdown: '主要终点', x: 40, y: 40, w: 300, h: 80, geometry: 'roundRect', fill: 'accent', color: 'FFFFFF' }])
    const block = t.shape(0, a => a.id === r.results[0]!.ids[0])
    expect(block.attrs).toMatchObject({ kind: 'shape', geom: 'roundRect', fill: DECK_THEMES.clinical!.accent })
    const xml = t.exported().text('ppt/slides/slide1.xml')
    expect(xml).toContain('<a:prstGeom prst="roundRect">')
    expect(xml).toContain(`<a:srgbClr val="${DECK_THEMES.clinical!.accent}"/>`)
    expect(xml).toContain('<a:srgbClr val="FFFFFF"/>')
    expect(wellFormed(xml)).toEqual([])
  })

  it('set_fill / set_background / set_text_style（单段）写进模型与导出', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    const title = t.shape(0, a => a.ph === 'ctrTitle' || a.ph === 'title')
    t.edit([
      { op: 'set_text', shape_id: title.attrs.id as string, markdown: 'SELECT 试验\n\n心血管结局' },
      { op: 'set_background', slide_id: sid, color: '#0b1f3a' },
      { op: 'set_fill', shape_id: title.attrs.id as string, color: 'none' },
      { op: 'set_text_style', shape_id: title.attrs.id as string, paragraph: 1, color: '38BDF8', size: 20, bold: true, align: 'center' },
    ])
    const s = t.slide(0)
    expect(s.attrs.bg).toBe('0B1F3A')
    const after = t.shape(0, a => a.id === title.attrs.id)
    const second = after.child(1)
    const rpr = second.firstChild!.marks.find(m => m.type.name === 'rpr')!.attrs.xml as string
    expect(rpr).toContain('<a:srgbClr val="38BDF8"/>')
    expect(rpr).toContain('sz="2000"')
    expect(second.firstChild!.marks.some(m => m.type.name === 'bold')).toBe(true)
    expect(second.attrs.align).toBe('center')
    expect(after.child(0).firstChild!.marks.some(m => m.type.name === 'bold')).toBe(false) // 只改第 2 段
    const xml = t.exported().text('ppt/slides/slide1.xml')
    expect(xml).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="0B1F3A"/>')
    expect(xml).toMatch(/algn="ctr"/)
    expect(wellFormed(xml)).toEqual([])
    expect(slideRead(t.slide(0), 0, 1)).toContain('背景 #0B1F3A')
  })

  it('改已有形状的文字颜色：替换原有填充，不动线条颜色', async () => {
    const { rprWithColor } = await import('../src/ops/deck.ts')
    const xml = '<a:rPr lang="zh-CN" sz="2400"><a:ln w="9525"><a:solidFill><a:srgbClr val="111111"/></a:solidFill></a:ln><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="Arial"/></a:rPr>'
    const out = rprWithColor(xml, 'FF0000')
    expect(out).toContain('<a:ln w="9525"><a:solidFill><a:srgbClr val="111111"/></a:solidFill></a:ln>')
    expect(out).toContain('<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:latin typeface="Arial"/>')
    expect(out).not.toContain('schemeClr')
  })

  it('add_image：按原图比例算高度；导出 p:pic、媒体文件、关系与内容类型', () => {
    const t = deck()
    const asset = t.store.putAsset({ owner: 'u', mime: 'image/png', name: 'km.png', bytes: png(300, 150) })
    const sid = t.slide(0).attrs.id as string
    const r = t.edit([{ op: 'add_image', slide_id: sid, asset_id: asset.id, x: 100, y: 100, w: 400, description: 'KM 曲线' }])
    const img = t.shape(0, a => a.id === r.results[0]!.ids[0])
    expect(img.attrs).toMatchObject({ kind: 'image', asset_id: asset.id, description: 'KM 曲线', h: 200 * 12700 })
    const { files, text } = t.exported()
    const slideXml = text('ppt/slides/slide1.xml')
    const rid = /<a:blip r:embed="(rId\d+)"\/>/.exec(slideXml)?.[1]
    expect(rid).toBeTruthy()
    expect(text('ppt/slides/_rels/slide1.xml.rels')).toContain(`Id="${rid}"`)
    expect(files[`ppt/media/heurion-${asset.id}.png`]).toBeTruthy()
    expect(text('[Content_Types].xml')).toMatch(/<Default Extension="png"/)
    expect(wellFormed(slideXml)).toEqual([])
  })

  it('add_image：别人的资产、非图片资产都拒绝', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    const other = t.store.putAsset({ owner: 'someone-else', mime: 'image/png', name: 'x.png', bytes: png(10, 10) })
    const pdf = t.store.putAsset({ owner: 'u', mime: 'application/pdf', name: 'x.pdf', bytes: new Uint8Array([1]) })
    for (const [id, code] of [[other.id, 'asset_not_found'], [pdf.id, 'invalid_asset']] as const) {
      try { t.edit([{ op: 'add_image', slide_id: sid, asset_id: id, x: 0, y: 0, w: 100 }]); throw new Error('应当拒绝') } catch (err) { expect((err as OpError).code).toBe(code) }
    }
  })

  it('set_z：置顶 / 置底 / 上下移一层改变叠放顺序，导出顺序随之改变', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    const a = t.edit([{ op: 'add_shape', slide_id: sid, markdown: '甲', x: 0, y: 0, w: 50, h: 50, fill: 'accent' }]).results[0]!.ids[0]!
    const b = t.edit([{ op: 'add_shape', slide_id: sid, markdown: '乙', x: 0, y: 0, w: 50, h: 50, fill: 'accent2' }]).results[0]!.ids[0]!
    const order = () => { const out: string[] = []; t.slide(0).forEach(s => out.push(s.attrs.id as string)); return out }
    t.edit([{ op: 'set_z', shape_id: b, to: 'back' }])
    expect(order()[0]).toBe(b)
    t.edit([{ op: 'set_z', shape_id: b, to: 'forward' }])
    expect(order()[1]).toBe(b)
    t.edit([{ op: 'set_z', shape_id: a, to: 'front' }])
    expect(order().at(-1)).toBe(a)
    const xml = t.exported().text('ppt/slides/slide1.xml')
    expect(xml.indexOf('乙')).toBeLessThan(xml.indexOf('甲'))
  })

  it('apply_theme：背景、标题与正文着色；之后新加的页沿用；主题记号按新主题取色；pptx 主题强调色更新', () => {
    const t = deck()
    const first = t.slide(0).attrs.id as string
    t.edit([{ op: 'add_slide', after: first, title: '研究设计', body: '- 多中心随机双盲' }])
    t.edit([{ op: 'apply_theme', theme: 'midnight' }])
    const m = DECK_THEMES.midnight!
    t.doc().forEach(s => expect([s.attrs.theme, s.attrs.bg]).toEqual(['midnight', m.bg]))
    const titleRpr = t.shape(1, a => a.ph === 'title').firstChild!.firstChild!.marks.find(mk => mk.type.name === 'rpr')!.attrs.xml as string
    expect(titleRpr).toContain(`<a:srgbClr val="${m.title}"/>`)
    const bodyRpr = t.shape(1, a => a.ph === 'body').firstChild!.firstChild!.marks.find(mk => mk.type.name === 'rpr')!.attrs.xml as string
    expect(bodyRpr).toContain(`<a:srgbClr val="${m.body}"/>`)
    // 新加的页沿用主题
    t.edit([{ op: 'add_slide', after: t.slide(1).attrs.id as string, title: '主要结果', body: '- HR 0.80' }])
    expect([t.slide(2).attrs.theme, t.slide(2).attrs.bg]).toEqual(['midnight', m.bg])
    // 主题记号按新主题取色；换主题时原强调色色块跟着换
    const block = t.edit([{ op: 'add_shape', slide_id: t.slide(2).attrs.id as string, markdown: '', x: 0, y: 0, w: 20, h: 300, fill: 'accent' }]).results[0]!.ids[0]!
    expect(t.shape(2, a => a.id === block).attrs.fill).toBe(m.accent)
    t.edit([{ op: 'apply_theme', theme: 'warm' }])
    expect(t.shape(2, a => a.id === block).attrs.fill).toBe(DECK_THEMES.warm!.accent)
    const themeXml = t.exported().text('ppt/theme/theme1.xml')
    expect(themeXml).toContain(`<a:accent1><a:srgbClr val="${DECK_THEMES.warm!.accent}"/></a:accent1>`)
    expect(wellFormed(themeXml)).toEqual([])
  })

  it('无效颜色、无效主题给出可操作的错误', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    try { t.edit([{ op: 'set_background', slide_id: sid, color: 'blue-ish' }]); throw new Error('应当拒绝') } catch (err) {
      expect((err as OpError).code).toBe('invalid_color')
      expect((err as OpError).extra.hint).toContain('accent')
    }
    expect(DeckOp.safeParse({ op: 'apply_theme', theme: 'neon' }).success).toBe(false)
  })

  it('MCP 与画布共用同一套操作定义：每种新操作都能通过 deck_edit 的参数校验', () => {
    const samples = [
      { op: 'add_shape', slide_id: 's', x: 0, y: 0, w: 10, h: 10, geometry: 'ellipse', fill: 'accent' },
      { op: 'set_fill', shape_id: 'x', color: 'none' },
      { op: 'set_background', slide_id: 's', color: 'bg' },
      { op: 'set_text_style', shape_id: 'x', color: 'title', size: 28, bold: true, align: 'center' },
      { op: 'add_image', slide_id: 's', asset_id: 'a', x: 0, y: 0, w: 100 },
      { op: 'set_z', shape_id: 'x', to: 'front' },
      { op: 'apply_theme', theme: 'teal' },
    ]
    for (const op of samples) expect([op.op, DeckOp.safeParse(op).success]).toEqual([op.op, true])
  })
})

describe('色块写文字', () => {
  it('set_text 不把色块变成文本框；导出写回色块里的新文字', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    const id = t.edit([{ op: 'add_shape', slide_id: sid, markdown: '', x: 40, y: 400, w: 600, h: 50, geometry: 'roundRect', fill: 'accent' }]).results[0]!.ids[0]!
    t.edit([{ op: 'set_text', shape_id: id, markdown: '**结论**：阻断 PD-1 恢复抗肿瘤免疫' }])
    expect(t.shape(0, a => a.id === id).attrs).toMatchObject({ kind: 'shape', geom: 'roundRect' })
    expect(t.exported().text('ppt/slides/slide1.xml')).toContain('阻断 PD-1 恢复抗肿瘤免疫')
  })
})

describe('set_paragraphs：画布直接改字（逐段最小差异）', () => {
  it('改一个字：其余文字的颜色、加粗、引用、评论标记都保留；新增 / 删除段落；改列表级别', async () => {
    const { attachComment } = await import('../src/model/anchors.ts')
    const t = deck()
    const c = t.store.upsertCitation({ doc_id: t.docId, doi: '10.1056/x', pmid: null, formatted: 'x', url: null })
    const first = t.slide(0).attrs.id as string
    const r = t.edit([{ op: 'add_slide', after: first, title: '结果', body: `- 主要终点 HR **0.80**[@c:${c.id}]\n- 次要终点一致\n- 安全性可接受` }])
    const body = t.shape(1, a => a.ph !== 'title').attrs.id as string
    t.edit([{ op: 'set_text_style', shape_id: body, paragraph: 0, color: 'DC2626' }])
    const cm = t.store.addComment({ doc_id: t.docId, node_id: body, snippet: '主要终点' })
    t.docs.commit(t.docId, attachComment(t.doc(), body, '主要终点', cm.id, 0).doc, { actor: 'user', turnId: null, ops: [] })
    // 第 1 段只把「主要」改成「首要」，第 2 段不动，删第 3 段，加一段二级要点
    t.edit([{ op: 'set_paragraphs', shape_id: body, paragraphs: [
      { text: `首要终点 HR **0.80**[@c:${c.id}]` },
      { text: '次要终点一致' },
      { text: '心血管死亡亦下降', lvl: 1 },
    ] }])
    const shape = t.shape(1, a => a.id === body)
    expect(shape.childCount).toBe(3)
    const p0 = shape.child(0)
    expect(p0.textContent).toBe('首要终点 HR 0.80')
    let cites = 0, bold = '', red = true, commented = ''
    p0.forEach(n => {
      if (n.type.name === 'citation') cites++
      if (n.isText) {
        if (n.marks.some(m => m.type.name === 'bold')) bold += n.text
        if (!(n.marks.find(m => m.type.name === 'rpr')?.attrs.xml as string ?? '').includes('DC2626')) red = false
        if (n.marks.some(m => m.type.name === 'comment')) commented += n.text
      }
    })
    expect([cites, bold, red]).toEqual([1, '0.80', true])
    expect(commented).toBe('要终点') // 锚点收缩到保留下来的字
    expect([shape.child(1).textContent, shape.child(2).textContent, shape.child(2).attrs.lvl]).toEqual(['次要终点一致', '心血管死亡亦下降', 1])
    expect(r.results[0]!.ids.length).toBeGreaterThan(0)
    const out = t.exported()
    const texts = Object.keys(out.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).map(f => [...out.text(f).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join(''))
    expect(texts.some(x => x.includes('首要终点 HR 0.80[1]') && x.includes('心血管死亡亦下降'))).toBe(true)
  })

  it('段落都没变：不产生改动；不可编辑的形状拒绝', () => {
    const t = deck()
    const title = t.shape(0, a => a.ph === 'ctrTitle' || a.ph === 'title').attrs.id as string
    const before = t.shape(0, a => a.id === title)
    t.edit([{ op: 'set_paragraphs', shape_id: title, paragraphs: [{ text: before.textContent }] }])
    expect(t.shape(0, a => a.id === title).eq(before)).toBe(true)
  })
})

describe('add_table：新建表格（人与 AI 同一套操作）', () => {
  it('表头强调色白字、交替行底色；导出 a:tbl；单元格可改；换主题时表头跟着换色且保持白字', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    const id = t.edit([{ op: 'add_table', slide_id: sid, x: 60, y: 120, w: 600, rows: [['指标', '司美格鲁肽', '安慰剂'], ['主要终点', '6.5%', '8.0%'], ['HR (95% CI)', '0.80 (0.72–0.90)', '—']] }]).results[0]!.ids[0]!
    const shape = t.shape(0, a => a.id === id)
    expect(shape.attrs.kind).toBe('table')
    const head = shape.firstChild!.firstChild!.firstChild!
    expect(head.attrs.tcpr).toContain(DECK_THEMES.clinical!.accent)
    const headRpr = head.firstChild!.firstChild!.marks.find(m => m.type.name === 'rpr')!.attrs.xml as string
    expect(headRpr).toContain('FFFFFF')
    t.edit([{ op: 'table_set_cells', shape_id: id, cells: [{ row: 1, col: 1, markdown: '6.5%（n=8803）' }] }])
    const xml = t.exported().text('ppt/slides/slide1.xml')
    expect(xml).toContain('<a:tbl>')
    expect(xml).toContain('6.5%（n=8803）')
    expect((xml.match(/<a:gridCol /g) ?? []).length).toBe(3)
    expect(wellFormed(xml)).toEqual([])
    t.edit([{ op: 'apply_theme', theme: 'teal' }])
    const head2 = t.shape(0, a => a.id === id).firstChild!.firstChild!.firstChild!
    expect(head2.attrs.tcpr).toContain(DECK_THEMES.teal!.accent)
    expect(head2.firstChild!.firstChild!.marks.find(m => m.type.name === 'rpr')!.attrs.xml).toContain('FFFFFF')
  })

  it('每行格数不一致时拒绝', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    try { t.edit([{ op: 'add_table', slide_id: sid, x: 0, y: 0, w: 300, rows: [['a', 'b'], ['c']] }]); throw new Error('应当拒绝') } catch (err) { expect((err as OpError).code).toBe('invalid_table') }
  })
})

describe('表格增删行列（人与 AI 同一套操作）', () => {
  it('新建表格：插行沿用正文行格式、插列沿用相邻列；删行删列；不能删光', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    const id = t.edit([{ op: 'add_table', slide_id: sid, x: 60, y: 120, w: 600, rows: [['指标', 'A', 'B'], ['终点', '1', '2']] }]).results[0]!.ids[0]!
    const grid = () => { const g: string[][] = []; t.shape(0, a => a.id === id).firstChild!.forEach(r => { const row: string[] = []; r.forEach(c => row.push(c.textContent)); g.push(row) }); return g }
    t.edit([{ op: 'table_insert_rows', shape_id: id, at: 2, rows: [['安全性', '3', '4']] }])
    t.edit([{ op: 'table_insert_cols', shape_id: id, at: 3, cells: ['P 值', '0.01', '0.2'] }])
    expect(grid()).toEqual([['指标', 'A', 'B', 'P 值'], ['终点', '1', '2', '0.01'], ['安全性', '3', '4', '0.2']])
    // 新行沿用正文行（不是表头）的格式：不加粗；新列表头格沿用表头：加粗
    const table = t.shape(0, a => a.id === id).firstChild!
    expect(table.child(2).child(0).firstChild!.firstChild!.marks.some(m => m.type.name === 'bold')).toBe(false)
    expect(table.child(0).child(3).firstChild!.firstChild!.marks.some(m => m.type.name === 'bold')).toBe(true)
    t.edit([{ op: 'table_delete_rows', shape_id: id, at: 1, count: 1 }, { op: 'table_delete_cols', shape_id: id, at: 1, count: 2 }])
    expect(grid()).toEqual([['指标', 'P 值'], ['安全性', '0.2']])
    try { t.edit([{ op: 'table_delete_rows', shape_id: id, at: 0, count: 2 }]); throw new Error('应当拒绝') } catch (err) { expect((err as OpError).code).toBe('invalid_table') }
    expect((t.exported().text('ppt/slides/slide1.xml').match(/<a:gridCol /g) ?? []).length).toBe(2)
  })

  it('导入的表格增删行后导出：沿用原表格的 tblPr、列宽与行高，行数正确', async () => {
    const { importPptx } = await import('../src/convert/pptx-import.ts')
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    t.edit([{ op: 'add_table', slide_id: sid, x: 60, y: 120, w: 600, rows: [['指标', 'A'], ['终点', '1']] }])
    const bytes = exportPptx({ doc: t.doc(), baseline: null, pkg: t.store.getPackage(t.docId)!, src: () => null, citations: [] }).bytes
    // 当作一份导入的 pptx：形状带原文
    const imported = importPptx(bytes)
    const docs = new Documents(new Store(':memory:'))
    const ops = new OpService(docs)
    const row = docs.create({ owner: 'u', title: 'x', kind: 'deck', content: imported.doc, source: 'import' })
    docs.store.putNodeSrc(row.id, imported.src)
    let tableId = ''
    docs.get(row.id).child(0).forEach(s => { if (s.attrs.kind === 'table') tableId = s.attrs.id as string })
    ops.edit({ doc_id: row.id, base_rev: 0, mode: 'apply', ops: [{ op: 'table_insert_rows', shape_id: tableId, at: 2, rows: [['安全性', '3']] }] }, { actor: 'user', turnId: null })
    const out = unzipSync(exportPptx({ doc: docs.get(row.id), baseline: docs.versionDoc(row.id, 1), pkg: bytes, src: id => docs.store.getNodeSrc(row.id, id), citations: [] }).bytes)
    const xml = strFromU8(out['ppt/slides/slide1.xml']!)
    expect((xml.match(/<a:tr /g) ?? []).length).toBe(3)
    expect(xml).toContain('安全性')
    expect(xml).toContain('<a:tblPr firstRow="1" bandRow="1"/>')
    expect(wellFormed(xml)).toEqual([])
  })
})

describe('对齐与分布（人与 AI 同一套操作）', () => {
  it('align_shapes：多个形状对齐选区、单个形状对齐页面；distribute_shapes 首尾不动中间等距', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    const add = (x: number, y: number, w: number) => t.edit([{ op: 'add_shape', slide_id: sid, markdown: '', x, y, w, h: 40, fill: 'accent' }]).results[0]!.ids[0]!
    const a = add(100, 300, 50), b = add(220, 320, 100), c = add(600, 340, 80)
    const at = (id: string) => t.shape(0, s => s.id === id).attrs
    t.edit([{ op: 'align_shapes', shape_ids: [a, b, c], align: 'top' }])
    expect([at(a).y, at(b).y, at(c).y]).toEqual([300 * 12700, 300 * 12700, 300 * 12700])
    t.edit([{ op: 'distribute_shapes', shape_ids: [c, a, b], direction: 'horizontal' }])
    const gap1 = at(b).x - (at(a).x + at(a).w)
    const gap2 = at(c).x - (at(b).x + at(b).w)
    expect(Math.abs(gap1 - gap2)).toBeLessThanOrEqual(1)
    expect([at(a).x, at(c).x]).toEqual([100 * 12700, 600 * 12700]) // 首尾不动
    t.edit([{ op: 'align_shapes', shape_ids: [b], align: 'center' }])
    expect(at(b).x).toBe(Math.round((12192000 - at(b).w) / 2))
  })

  it('text_style 与 align：字号、颜色、字体族与段落居中导出为合法 PPTX XML', () => {
    const t = deck()
    const sid = t.slide(0).attrs.id as string
    const shapeId = t.edit([{ op: 'add_shape', slide_id: sid, markdown: '自定义样式标题', x: 100, y: 100, w: 400, h: 60 }]).results[0]!.ids[0]!
    t.edit([
      { op: 'set_text_style', shape_id: shapeId, paragraph: 0, font_family: 'Arial', size: 28, color: 'FF5733', align: 'center' }
    ])

    const { text } = t.exported()
    const slideXml = text('ppt/slides/slide1.xml')
    expect(wellFormed(slideXml)).toEqual([])
    expect(slideXml).toContain('sz="2800"')
    expect(slideXml).toContain('val="FF5733"')
    expect(slideXml).toContain('typeface="Arial"')
    expect(slideXml).toContain('algn="ctr"')
  })
})
