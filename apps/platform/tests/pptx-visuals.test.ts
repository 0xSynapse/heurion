import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { importPptx } from '../src/convert/pptx-import.ts'
import { pptxTemplate } from '../src/convert/pptx-template.ts'
import { PptxVisuals } from '../src/convert/pptx-visuals.ts'
import { autoNumOf, bulletOf, colorOf, fillColorOf, formatAutoNum, textColorOf } from '../src/model/ooxml-color.ts'
import { readLayouts } from '../src/convert/pptx-layouts.ts'
import { Accounts } from '../src/auth/accounts.ts'
import { BotGuard } from '../src/auth/bot-guard.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
/** 1×1 的 PNG。 */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))

const sp = (id: number, name: string, x: number, y: number, w: number, h: number, inner: string, text = '') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>${inner}</p:spPr>${text ? `<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="2400" b="1"><a:solidFill><a:prstClr val="white"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody>` : ''}</p:sp>`

/**
 * 一份「外部」pptx（不是平台模板生成的）：母版上有主题色色条和 logo 图片；
 * 幻灯片上有组合（子形状一个用组合填充、一个是自由曲线）、连接线、主题色填充的六边形。
 */
function externalDeck(): Uint8Array {
  const files = unzipSync(pptxTemplate())
  files['ppt/theme/theme1.xml'] = strToU8(strFromU8(files['ppt/theme/theme1.xml']!).replace(/name="Heurion"/g, 'name="Office Theme"'))
  // 母版：色条（accent1，亮度 75%）+ logo
  const deco = sp(90, '色条', 0, 0, 12192000, 300000, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr></a:solidFill>')
    + '<p:pic><p:nvPicPr><p:cNvPr id="91" name="logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdLogo"/><a:srcRect l="10000" r="10000"/></p:blipFill><p:spPr><a:xfrm><a:off x="6096000" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
  files['ppt/slideMasters/slideMaster1.xml'] = strToU8(strFromU8(files['ppt/slideMasters/slideMaster1.xml']!).replace('</p:spTree>', `${deco}</p:spTree>`))
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = strToU8(strFromU8(files['ppt/slideMasters/_rels/slideMaster1.xml.rels']!).replace('</Relationships>', '<Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/></Relationships>'))
  files['ppt/media/logo.png'] = PNG
  const group = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="组合 9"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="1000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="2000000"/></a:xfrm><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></p:grpSpPr>'
    + sp(11, '方块', 0, 0, 2000000, 2000000, '<a:prstGeom prst="hexagon"><a:avLst/></a:prstGeom><a:grpFill/>', '01')
    + sp(12, '曲线', 2000000, 0, 2000000, 2000000, '<a:custGeom><a:avLst/><a:gdLst/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="50"/></a:lnTo><a:cubicBezTo><a:pt x="50" y="100"/><a:pt x="20" y="100"/><a:pt x="0" y="100"/></a:cubicBezTo><a:close/></a:path></a:pathLst></a:custGeom><a:solidFill><a:srgbClr val="B2D2DE"/></a:solidFill>')
    + '</p:grpSp>'
  const line = '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="20" name="直线 19"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm flipV="1"><a:off x="4000000" y="1000000"/><a:ext cx="1000000" cy="500000"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="25400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></p:spPr></p:cxnSp>'
  const hex = sp(30, '六边形', 6000000, 3000000, 1000000, 900000, '<a:prstGeom prst="hexagon"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill>', '02')
  files['ppt/slides/slide1.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${group}${line}${hex}</p:spTree></p:cSld></p:sld>`)
  files['ppt/slides/_rels/slide1.xml.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout2.xml"/></Relationships>')
  files['ppt/presentation.xml'] = strToU8(strFromU8(files['ppt/presentation.xml']!).replace('<p:sldIdLst/>', '<p:sldIdLst><p:sldId id="256" r:id="rId99"/></p:sldIdLst>'))
  files['ppt/_rels/presentation.xml.rels'] = strToU8(strFromU8(files['ppt/_rels/presentation.xml.rels']!).replace('</Relationships>', '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'))
  files['[Content_Types].xml'] = strToU8(strFromU8(files['[Content_Types].xml']!).replace('</Types>', '<Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>'))
  return zipSync(files)
}

describe('DrawingML 颜色解析', () => {
  const scheme = { accent1: '0EA5E9', tx1: '0F172A' }
  it('srgbClr / schemeClr / prstClr / sysClr，亮度修饰', () => {
    expect(colorOf('<a:srgbClr val="ff0000"/>')).toBe('FF0000')
    expect(colorOf('<a:schemeClr val="accent1"/>', scheme)).toBe('0EA5E9')
    expect(colorOf('<a:prstClr val="white"/>')).toBe('FFFFFF')
    expect(colorOf('<a:sysClr val="windowText" lastClr="000000"/>')).toBe('000000')
    expect(colorOf('<a:srgbClr val="FFFFFF"><a:lumMod val="50000"/></a:srgbClr>')).toBe('808080')
    expect(colorOf('<a:schemeClr val="nope"/>', scheme)).toBeNull()
  })
  it('文字颜色不取轮廓线与阴影里的颜色；带命名空间声明的片段也能读', () => {
    const rpr = '<a:rPr xmlns:a="x" sz="2000"><a:ln w="9525"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln><a:solidFill xmlns:a="x"><a:prstClr val="white"/></a:solidFill><a:effectLst><a:outerShdw><a:srgbClr val="C0C0C0"/></a:outerShdw></a:effectLst></a:rPr>'
    expect(textColorOf(rpr)).toBe('FFFFFF')
    expect(fillColorOf('<a:gradFill><a:gsLst><a:gs pos="0"><a:schemeClr val="tx1"/></a:gs></a:gsLst></a:gradFill>', scheme)).toBe('0F172A')
  })
})

describe('项目符号', () => {
  it('段落写了就用（Wingdings 符号换成 Unicode），buNone / 自动编号不显示，没写返回 undefined', () => {
    expect(bulletOf('<a:pPr><a:buFont typeface="Wingdings"/><a:buChar char="Ø"/></a:pPr>')).toBe('➢')
    expect(bulletOf('<a:pPr><a:buFont typeface="Arial"/><a:buChar char="–"/></a:pPr>')).toBe('–')
    expect(bulletOf('<a:pPr><a:buNone/></a:pPr>')).toBe('')
    expect(bulletOf('<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>')).toBe('')
    expect(bulletOf('<a:pPr algn="l"/>')).toBeUndefined()
    expect(bulletOf('<a:pPr><a:buChar char="&amp;lt;"/></a:pPr>')).toBe('&lt;')
  })
})

describe('自动编号', () => {
  it('编号样式与起始号；各种格式的编号文字', () => {
    expect(autoNumOf('<a:pPr><a:buAutoNum type="alphaLcPeriod" startAt="3"/></a:pPr>')).toEqual({ type: 'alphaLcPeriod', start: 3 })
    expect(autoNumOf('<a:pPr><a:buChar char="•"/></a:pPr>')).toBeNull()
    expect(formatAutoNum('arabicPeriod', 3)).toBe('3.')
    expect(formatAutoNum('arabicParenR', 2)).toBe('2)')
    expect(formatAutoNum('alphaLcPeriod', 27)).toBe('aa.')
    expect(formatAutoNum('romanUcPeriod', 4)).toBe('IV.')
    expect(formatAutoNum('alphaUcParenBoth', 1)).toBe('(A)')
    expect(formatAutoNum('circleNumDbPlain', 3)).toBe('③')
  })
})

describe('导入 pptx 的显示层', () => {
  const bytes = externalDeck()
  const imported = importPptx(bytes)
  const visuals = new PptxVisuals(bytes)
  const slide = imported.doc.child(0)
  const src = (name: string) => {
    let id = ''
    slide.forEach(s => { if (s.attrs.name === name) id = s.attrs.id as string })
    return imported.src.find(x => x.node_id === id)!.xml
  }

  it('版式：母版的装饰（主题色色条、logo 图片与裁剪）、背景与主题配色', () => {
    const lv = visuals.deck().layouts[slide.attrs.layout as string]!
    expect(lv.colors.accent1).toBe('0EA5E9')
    expect(lv.colors.tx1).toBe('0F172A') // clrMap：tx1 → dk1
    expect(lv.bg).toEqual({ color: 'FFFFFF' })
    const bar = lv.parts.find(p => p.fill && p.y === 0 && p.w === 1)
    expect(bar?.fill).toBe(colorOf('<a:srgbClr val="0EA5E9"><a:lumMod val="75000"/></a:srgbClr>'))
    const logo = lv.parts.find(p => p.img)
    expect(logo).toMatchObject({ img: 'ppt/media/logo.png', x: 0.5, crop: [0.1, 0, 0.1, 0] })
    // 母版占位符不画（那是给幻灯片填内容的提示框）
    expect(lv.parts.some(p => p.text)).toBe(false)
  })

  it('组合展开：按组合框比例定位，组合填充取组合的颜色，自由曲线转成路径', () => {
    const sv = visuals.shape(src('组合 9'), slide.attrs.part as string, slide.attrs.layout as string)!
    expect(sv.parts).toHaveLength(2)
    const [box, curve] = sv.parts!
    expect(box).toMatchObject({ x: 0, y: 0, w: 0.5, h: 1, geom: 'hexagon', fill: '0284C7' })
    expect(box!.text?.paras[0]?.runs[0]).toMatchObject({ t: '01', sz: 24, b: true, color: 'FFFFFF' })
    expect(box!.text?.anchor).toBe('ctr')
    expect(curve).toMatchObject({ x: 0.5, w: 0.5, fill: 'B2D2DE' })
    expect(curve!.paths?.[0]?.d).toBe('M0 0L1 0.5C0.5 1 0.2 1 0 1Z')
  })

  it('连接线画成线（方向、颜色、粗细）；顶层形状的主题色填充与外形', () => {
    const line = visuals.shape(src('直线 19'), slide.attrs.part as string, slide.attrs.layout as string)!
    expect(line.parts).toEqual([{ x: 0, y: 0, w: 1, h: 1, connector: true, flipV: true, line: { color: '0F172A', w: 2 } }])
    const hex = visuals.shape(src('六边形'), slide.attrs.part as string, slide.attrs.layout as string)!
    expect(hex).toMatchObject({ fill: '0EA5E9', geom: 'hexagon' })
    // 模型里导入的填充只认写死的颜色：主题色要靠显示层
    let fill: unknown = 'x'
    slide.forEach(s => { if (s.attrs.name === '六边形') fill = s.attrs.fill })
    expect(fill).toBeNull()
  })

  it('连接线箭头；版式带主题字体；占位符样式带项目符号与文字颜色', () => {
    const files = unzipSync(externalDeck())
    const slide1 = strFromU8(files['ppt/slides/slide1.xml']!).replace('<a:ln w="25400">', '<a:ln w="25400"><a:tailEnd type="triangle"/>')
    files['ppt/slides/slide1.xml'] = strToU8(slide1)
    const pkg = zipSync(files)
    const v = new PptxVisuals(pkg)
    const imp = importPptx(pkg)
    const s = imp.doc.child(0)
    let id = ''
    s.forEach(n => { if (n.attrs.name === '直线 19') id = n.attrs.id as string })
    const line = v.shape(imp.src.find(x => x.node_id === id)!.xml, s.attrs.part as string, s.attrs.layout as string)!
    expect(line.parts?.[0]?.line).toEqual({ color: '0F172A', w: 2, tail: true })
    expect(v.deck().layouts[s.attrs.layout as string]!.fonts.minor).toBeTruthy()
    // 版式标题：lstStyle 写了 buNone 与颜色（版式自己的优先于母版）；正文沿用母版的「•」与颜色
    const phs = readLayouts(pkg).layouts.find(l => l.part === 'ppt/slideLayouts/slideLayout2.xml')!.placeholders
    const title = phs.find(p => p.type === 'title')!
    expect(title.style?.bullet).toBe('')
    expect(fillColorOf(title.style?.colorXml)).toBe('0F172A')
    const body = phs.find(p => p.type === 'body' || p.type === 'obj')
    if (body) expect(body.style?.bullet).toBe('•')
  })

  it('表格的列宽、行高按原文件网格；组合里文本的自动编号连续累加', () => {
    const v = new PptxVisuals(bytes)
    const tbl = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="40" name="表格"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="3000000" cy="1000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="1000000"/><a:gridCol w="2000000"/></a:tblGrid><a:tr h="400000"><a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc></a:tr><a:tr h="600000"><a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc><a:tc><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
    expect(v.shape(tbl, 'ppt/slides/slide1.xml', 'ppt/slideLayouts/slideLayout2.xml')).toEqual({ table: { cols: [0.33333, 0.66667], rows: [0.4, 0.6] } })
    const para = (t: string, ppr = '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>') => `<a:p>${ppr}<a:r><a:t>${t}</a:t></a:r></a:p>`
    const text = `<p:sp><p:nvSpPr><p:cNvPr id="50" name="说明"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/>${para('一')}${para('二')}${para('插话', '<a:pPr><a:buNone/></a:pPr>')}${para('重新')}</p:txBody></p:sp>`
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="49" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></p:grpSpPr>${text}</p:grpSp>`
    const paras = v.shape(group, 'ppt/slides/slide1.xml', 'ppt/slideLayouts/slideLayout2.xml')!.parts![0]!.text!.paras
    expect(paras.map(p => p.bu)).toEqual(['1.', '2.', undefined, '1.'])
  })

  it('媒体只取 ppt/media/ 下画布能显示的图片（含要转换的 emf / wmf）', () => {
    expect(PptxVisuals.mediaBytes(bytes, 'ppt/media/logo.png')).toEqual(PNG)
    const files = unzipSync(bytes)
    files['ppt/media/x.emf'] = PNG
    files['ppt/media/x.tif'] = PNG
    expect(PptxVisuals.mediaBytes(zipSync(files), 'ppt/media/x.emf')).toEqual(PNG)
    expect(PptxVisuals.mediaBytes(zipSync(files), 'ppt/media/x.tif')).toBeNull()
    expect(PptxVisuals.mediaBytes(bytes, 'ppt/slides/slide1.xml')).toBeNull()
    expect(PptxVisuals.mediaBytes(bytes, 'ppt/media/../slides/slide1.xml')).toBeNull()
  })
})

describe('emf / wmf 转 png', () => {
  it('画布显示时（view=1）给转换后的 png，其余情况给原文件；包里的 emf 同样转换', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
    const mailer = { configured: true, available: true, mode: 'dev-mock' as const, async send() { return { success: true, mode: 'simulated' as const, messageId: 'm' } } }
    const accounts = new Accounts(store, { secret: 's', devMode: true, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: 's', baseMax: 300, minDelayMs: 0 }), mailer })
    const renderer = new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-')))
    const calls: string[] = []
    renderer.vectorToPng = async (_b, ext) => { calls.push(ext); return PNG }
    const app = buildApi({ docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs), crossref: {} as CrossrefClient, renderer, accounts, devMode: true, devUser: 'dev' })
    const asset = store.putAsset({ owner: 'dev', mime: 'image/emf', name: 'a.emf', bytes: new Uint8Array([1, 2, 3]) })
    const H = { Authorization: 'Bearer dev' }
    const view = await app.request(`/api/assets/${asset.id}?view=1`, { headers: H })
    expect(view.headers.get('content-type')).toBe('image/png')
    const raw = await app.request(`/api/assets/${asset.id}`, { headers: H })
    expect(raw.headers.get('content-type')).toBe('image/emf')
    const files = unzipSync(externalDeck())
    files['ppt/media/chart.emf'] = new Uint8Array([9, 9])
    const form = new FormData()
    form.append('file', new File([new Uint8Array(zipSync(files))], 'ext.pptx'))
    const row = await (await app.request('/api/docs', { method: 'POST', headers: H, body: form })).json() as { id: string }
    const media = await app.request(`/api/docs/${row.id}/package-media?path=ppt/media/chart.emf`, { headers: H })
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/png')
    expect(calls).toEqual(['emf', 'emf'])
  })
})

describe('显示层接口', () => {
  function env() {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const pool = { liveSession: () => null, run: () => new Promise(() => {}), cancel: async () => {} } as unknown as HarnessPool
    const mailer = { configured: true, available: true, mode: 'dev-mock' as const, async send() { return { success: true, mode: 'simulated' as const, messageId: 'm' } } }
    const accounts = new Accounts(store, { secret: 's', devMode: true, devToken: 'dev', devUser: 'dev', botGuard: new BotGuard({ secret: 's', baseMax: 300, minDelayMs: 0 }), mailer })
    const app = buildApi({
      docs, ops: new OpService(docs), turns: new TurnService(docs, pool, new TurnRegistry()), postcheck: new PostCheck(docs),
      crossref: {} as CrossrefClient, renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'hr-'))),
      accounts, devMode: true, devUser: 'dev',
    })
    return { app }
  }

  it('导入的 deck 带显示层（只含用到的版式），媒体可取；平台模板新建的 deck 没有', async () => {
    const { app } = env()
    const H = { Authorization: 'Bearer dev' }
    const form = new FormData()
    form.append('file', new File([new Uint8Array(externalDeck())], 'ext.pptx'))
    const row = await (await app.request('/api/docs', { method: 'POST', headers: H, body: form })).json() as { id: string }
    const deck = await (await app.request(`/api/docs/${row.id}/deck`, { headers: H })).json() as { visuals: { layouts: Record<string, unknown>; shapes: Record<string, { parts?: unknown[] }> } }
    expect(Object.keys(deck.visuals.layouts)).toEqual(['ppt/slideLayouts/slideLayout2.xml'])
    expect(Object.values(deck.visuals.shapes).filter(s => s.parts).length).toBe(2)
    const img = await app.request(`/api/docs/${row.id}/package-media?path=ppt/media/logo.png`, { headers: H })
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect((await app.request(`/api/docs/${row.id}/package-media?path=ppt/presentation.xml`, { headers: H })).status).toBe(404)
    // emf：画布显示时转成 png（转换器不可用时 404，画布不显示这张图）
    expect((await app.request(`/api/docs/${row.id}/package-media?path=ppt/media/chart.emf`, { headers: H })).status).toBe(404)
    const plain = await (await app.request('/api/docs', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 't', kind: 'deck' }) })).json() as { id: string }
    expect((await (await app.request(`/api/docs/${plain.id}/deck`, { headers: H })).json() as { visuals: unknown }).visuals).toBeNull()
  })
})
