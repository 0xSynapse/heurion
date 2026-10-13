import { strToU8, zipSync } from 'fflate'

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

export function docx(body: string, extra: { rels?: string; files?: Record<string, Uint8Array> } = {}): Uint8Array {
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`),
    'word/styles.xml': strToU8(`<?xml version="1.0"?><w:styles ${W}>
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="2"><w:name w:val="标题 2"/></w:style>
    </w:styles>`),
    'word/numbering.xml': strToU8(`<?xml version="1.0"?><w:numbering ${W}>
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
    </w:numbering>`),
    'word/_rels/document.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId9" Type="hyperlink" Target="https://example.org" TargetMode="External"/>${extra.rels ?? ''}</Relationships>`),
    ...(extra.files ?? {}),
  })
}

export const p = (text: string, pPr = '', rPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
export const li = (text: string, ilvl: number) => p(text, `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr>`)


/** 1×1 PNG。 */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])

export const IMAGE_REL = '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>'

export const drawing = (rid = 'rId20') => `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Picture 1" descr="图"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`

// —— 最小 PDF 生成器（测试 PDF 导入用，不依赖外部库） ——

/** 页面上的一个元素：文字（F1 常规 / F2 粗体 Helvetica）、图片（RGB 原始像素）或直线 */
export type PdfItem =
  | { text: string; x: number; y: number; size: number; bold?: boolean }
  | { image: { w: number; h: number; rgb: [number, number, number] }; x: number; y: number; width: number; height: number }

/** 生成多页 PDF；默认 A4（595×842pt）；y 为从页面顶部向下的距离，便于书写。 */
export function pdf(pages: PdfItem[][], dim: { w: number; h: number } = { w: 595, h: 842 }): Uint8Array {
  const objs: Array<string | Uint8Array[]> = []
  const add = (o: string | Uint8Array[]) => { objs.push(o); return objs.length }
  const enc = new TextEncoder()
  const esc = (s: string) => s.replace(/[\\()]/g, m => `\\${m}`)
  const catalog = add('')
  const pagesObj = add('')
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  const kids: number[] = []
  for (const items of pages) {
    const xobjs: string[] = []
    let content = ''
    for (const it of items) {
      if ('text' in it) {
        content += `BT /${it.bold ? 'F2' : 'F1'} ${it.size} Tf ${it.x} ${dim.h - it.y} Td (${esc(it.text)}) Tj ET\n`
      } else {
        const { w, h, rgb } = it.image
        const px = new Uint8Array(w * h * 3)
        for (let i = 0; i < w * h; i++) {
          // 加一点渐变，避免被当成纯色块
          px[i * 3] = (rgb[0] + (i % w) * 3) & 255; px[i * 3 + 1] = (rgb[1] + Math.floor(i / w) * 3) & 255; px[i * 3 + 2] = rgb[2]
        }
        const id = add([enc.encode(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${px.length} >>\nstream\n`), px, enc.encode('\nendstream')])
        const name = `Im${xobjs.length + 1}`
        xobjs.push(`/${name} ${id} 0 R`)
        content += `q ${it.width} 0 0 ${it.height} ${it.x} ${dim.h - it.y - it.height} cm /${name} Do Q\n`
      }
    }
    // 内容流按 WinAnsi 单字节编码（• = 0x95），其余字符按 Latin-1
    const bytes = Uint8Array.from([...content].map(ch => ch === '\u2022' ? 0x95 : ch.charCodeAt(0) & 255))
    const stream = add([enc.encode(`<< /Length ${bytes.length} >>\nstream\n`), bytes, enc.encode('endstream')])
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${dim.w} ${dim.h}] /Contents ${stream} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> /XObject << ${xobjs.join(' ')} >> >> >>`))
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`

  const chunks: Uint8Array[] = [enc.encode('%PDF-1.4\n')]
  let offset = chunks[0]!.length
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(offset)
    const parts = typeof o === 'string' ? [enc.encode(o)] : o
    const all = [enc.encode(`${i + 1} 0 obj\n`), ...parts, enc.encode('\nendobj\n')]
    for (const p of all) { chunks.push(p); offset += p.length }
  })
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`
  chunks.push(enc.encode(xref))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let pos = 0
  for (const c of chunks) { out.set(c, pos); pos += c.length }
  return out
}

/** 生成 16:9（960×540pt）演示文稿 PDF */
export function deckPdf(pages: PdfItem[][]): Uint8Array {
  return pdf(pages, { w: 960, h: 540 })
}
