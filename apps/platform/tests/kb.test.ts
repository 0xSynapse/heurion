/**
 * 参考资料库单元测试：验证 PDF（pdftotext + OCR）/ 文本抽取、DOI 规范化、
 * 分页切块、向量与关键词混合检索。
 */
import { describe, expect, it } from 'vitest'
import type { Embedder } from '../src/kb/embedder.ts'
import { chunkPages, extractText } from '../src/kb/extract.ts'
import { tidy, type Ocr } from '../src/kb/ocr.ts'
import { KbService } from '../src/kb/service.ts'
import { kbQueryTerms, Store } from '../src/store/db.ts'

/** 手工拼一份多页 PDF（Helvetica、ASCII 文字），给 pdftotext 抽取。 */
function pdf(pages: string[]): Uint8Array {
  const objs: string[] = []
  const add = (s: string) => { objs.push(s); return objs.length }
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pageIds: number[] = []
  const parent = objs.length + 1 + pages.length * 2 + 0
  for (const text of pages) {
    const lines = text.split('\n').map((l, i) => `BT /F1 12 Tf 50 ${750 - i * 16} Td (${l.replace(/[()\\]/g, m => '\\' + m)}) Tj ET`).join('\n')
    const content = add(`<< /Length ${lines.length} >>\nstream\n${lines}\nendstream`)
    pageIds.push(add(`<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`))
  }
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map(i => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/** 假嵌入：字符三元组哈希成 256 维再归一化（字面相近即相近），测试不依赖真实模型。 */
class FakeEmbedder implements Embedder {
  calls = 0
  constructor(private up = true) {}
  setUp(v: boolean) { this.up = v }
  async available() { return this.up }
  async embed(texts: string[]) {
    this.calls++
    return texts.map(t => {
      const v = new Float32Array(256)
      const s = t.toLowerCase()
      for (let i = 0; i + 3 <= s.length; i++) { let h = 0; for (const ch of s.slice(i, i + 3)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[h % 256]! += 1 }
      const n = Math.hypot(...v) || 1
      return v.map(x => x / n)
    })
  }
}

describe('参考资料库：抽取与切块', () => {
  it('PDF 按页抽取（pdftotext），识别并规范化小写 DOI（剥除句尾标点）；切块保留页码', async () => {
    const bytes = pdf(['Semaglutide and Cardiovascular Outcomes\ndoi: 10.1056/NEJMoa2307563.\nMajor adverse cardiovascular events were reduced.', 'Page two discusses safety and adverse events leading to discontinuation.'])
    const x = await extractText('select.pdf', bytes)
    expect(x.pages.length).toBe(2)
    expect(x.doi).toBe('10.1056/nejmoa2307563')
    expect(x.pages[1]).toContain('safety')
    const chunks = chunkPages(x.pages, 80, 10)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.some(c => c.page === 2 && c.text.includes('safety'))).toBe(true)
  })

  it('扫描页走 OCR：只识别没有文字层的页，汉字间空格去掉，进度与提示可见', async () => {
    const calls: number[][] = []
    const progress: string[] = []
    const fake: Ocr = async (_pdf, pages, onPage) => {
      calls.push(pages)
      pages.forEach((_, i) => onPage?.(i + 1, pages.length))
      return new Map(pages.map(p => [p, tidy(`第 ${p} 页 扫 描 内 容 ： 心 力 衰 竭 患 者 的 随 访 ， 共 120 例 。`)]))
    }
    const x = await extractText('mixed.pdf', pdf(['Page one has a real text layer about heart failure outcomes.', '', '']), { ocr: fake, onOcr: (d, n) => progress.push(`${d}/${n}`) })
    expect(calls).toEqual([[2, 3]])
    expect(progress).toEqual(['1/2', '2/2'])
    expect(x.pages[0]).toContain('heart failure')
    expect(x.pages[1]).toBe('第 2 页扫描内容：心力衰竭患者的随访，共 120 例。')
    expect(x.note).toContain('2 页是扫描页')

    const store = new Store(':memory:')
    const kb = new KbService(store, null, fake)
    const { file } = await kb.upload('u1', { name: 'scan.pdf', bytes: pdf(['', '']) })
    await kb.idle()
    expect(store.getKbFile(file.id)).toMatchObject({ status: 'ready', pages: 2 })
    expect((await kb.search('u1', '心力衰竭患者'))[0]?.file_id).toBe(file.id)
  })

  it('没有文字层的 PDF 标注为扫描件', async () => {
    const x = await extractText('scan.pdf', pdf(['', '']))
    expect(x.note).toContain('扫描件')
  })

  it('长段落按长度切开，块间有重叠', () => {
    const long = '心力衰竭'.repeat(400)
    const chunks = chunkPages([long], 300, 50)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every(c => c.text.length <= 300)).toBe(true)
  })
})

describe('参考资料库：处理流水线与检索', () => {
  it('上传 → 抽取 → 切块 → 向量化；同样内容不重复处理；混合检索返回出处与 DOI；限定资料范围', async () => {
    const store = new Store(':memory:')
    const embedder = new FakeEmbedder()
    const kb = new KbService(store, embedder)
    const a = await kb.upload('u1', { name: 'select.pdf', bytes: pdf(['Semaglutide and Cardiovascular Outcomes\ndoi: 10.1056/NEJMoa2307563\nMajor adverse cardiovascular events were reduced by 20 percent.', 'Gastrointestinal adverse events led to discontinuation.']) })
    const b = await kb.upload('u1', { name: '指南.md', bytes: new TextEncoder().encode('# 心衰指南\n\n射血分数降低的心衰推荐使用 SGLT2 抑制剂。') })
    await kb.idle()
    const fa = store.getKbFile(a.file.id)!
    expect([fa.status, fa.pages, fa.embedded === fa.chunks, fa.doi]).toEqual(['ready', 2, true, '10.1056/nejmoa2307563'])
    expect((await kb.upload('u1', { name: 'again.pdf', bytes: store.getKbBytes(a.file.id)! })).duplicate).toBe(true)
    const hits = await kb.search('u1', 'adverse events discontinuation')
    expect(hits[0]).toMatchObject({ file_id: a.file.id, page: 2, doi: '10.1056/nejmoa2307563' })
    expect((await kb.search('u1', 'SGLT2 抑制剂'))[0]!.file_id).toBe(b.file.id)
    expect((await kb.search('u1', '心衰', { fileIds: [a.file.id] })).every(h => h.file_id === a.file.id)).toBe(true)
    expect(await kb.search('u2', 'adverse')).toEqual([]) // 别人的资料
  })

  it('嵌入服务不可用：先可用（关键词检索），服务就绪后补向量', async () => {
    const store = new Store(':memory:')
    const embedder = new FakeEmbedder(false)
    const kb = new KbService(store, embedder)
    const { file } = await kb.upload('u1', { name: 'n.txt', bytes: new TextEncoder().encode('Heart failure with reduced ejection fraction benefits from SGLT2 inhibitors.') })
    await kb.idle()
    let f = store.getKbFile(file.id)!
    expect([f.status, f.embedded]).toEqual(['ready', 0])
    expect(f.note).toContain('关键词检索')
    expect((await kb.search('u1', 'ejection fraction'))[0]!.file_id).toBe(file.id)
    embedder.setUp(true)
    for (const x of store.listKbUnfinished()) kb.enqueue(x.id)
    await kb.idle()
    f = store.getKbFile(file.id)!
    expect([f.status, f.embedded, f.note]).toEqual(['ready', f.chunks, null])
  })

  it('不支持的类型拒绝；删除资料连同块一起删', async () => {
    const store = new Store(':memory:')
    const kb = new KbService(store, null)
    await expect(kb.upload('u1', { name: 'x.exe', bytes: new Uint8Array([1]) })).rejects.toThrow('不支持')
    const { file } = await kb.upload('u1', { name: 'a.txt', bytes: new TextEncoder().encode('alpha beta gamma delta epsilon') })
    await kb.idle()
    store.deleteKbFile(file.id)
    expect(await kb.search('u1', 'gamma')).toEqual([])
  })
})

describe('参考资料库：关键词检索的查询词', () => {
  it('自然语言问题拆成词（去停用词）与中文三字片段，整句不当短语', async () => {
    expect(kbQueryTerms('How much weight is regained after stopping semaglutide?')).toEqual(['weight', 'regained', 'stopping', 'semaglutide'])
    expect(kbQueryTerms('IL-6 与 SGLT2抑制剂')).toEqual(['IL-6', 'SGLT2', '抑制剂'])
    expect(kbQueryTerms('心力衰竭')).toEqual(['心力衰', '力衰竭'])
    const store = new Store(':memory:')
    const kb = new KbService(store, null)
    const { file } = await kb.upload('u1', { name: 'a.txt', bytes: new TextEncoder().encode('Participants regained two-thirds of their prior weight loss one year after semaglutide withdrawal.') })
    await kb.idle()
    expect((await kb.search('u1', 'How much weight is regained after stopping semaglutide?'))[0]?.file_id).toBe(file.id)
  })
})
