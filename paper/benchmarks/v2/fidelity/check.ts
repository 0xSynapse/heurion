/**
 * 导出 .docx 的通用完整性检查（保真度评测与 v2 三组判定共用）：XML 可解析、关系与引用 id 对得上、
 * 域与书签成对、段落 ID 与修订 id 不重复、每个部件都有内容类型；LibreOffice 能打开。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOMParser } from '../../../../apps/platform/node_modules/@xmldom/xmldom/lib/index.js'
import { strFromU8 } from '../../../../apps/platform/node_modules/fflate/esm/browser.js'
import * as D from '../../exp3/docx.ts'

const text = (pkg: D.Pkg, name: string) => (pkg[name] ? strFromU8(pkg[name]!) : null)

export function wellFormed(pkg: D.Pkg): string[] {
  const bad: string[] = []
  for (const name of Object.keys(pkg).filter(n => /\.(xml|rels)$/.test(n))) {
    const errors: string[] = []
    new DOMParser({ onError: (level: string, msg: string) => { if (level !== 'warning') errors.push(msg) } }).parseFromString(strFromU8(pkg[name]!), 'text/xml')
    if (errors.length) bad.push(`${name}: ${errors[0]!.slice(0, 120)}`)
  }
  return bad
}

export function integrity(pkg: D.Pkg): string[] {
  const out: string[] = []
  const doc = D.docXml(pkg)
  const relsFor = (part: string) => { const dir = part.slice(0, part.lastIndexOf('/')); const name = part.slice(part.lastIndexOf('/') + 1); return text(pkg, `${dir}/_rels/${name}.rels`) ?? '' }
  // 每个 XML 部件里用到的关系 id 都要在它的 .rels 里，内部目标部件要存在
  for (const part of Object.keys(pkg).filter(n => /^word\/[^_].*\.xml$/.test(n))) {
    const body = text(pkg, part)!
    const rels = relsFor(part)
    for (const m of body.matchAll(/\br:(?:id|embed|link|pict)="([^"]+)"/g)) if (!rels.includes(`Id="${m[1]}"`)) out.push(`${part} 引用了不存在的关系 ${m[1]}`)
    for (const m of rels.matchAll(/<Relationship\b[^>]*Target="([^"]+)"[^>]*>/g)) {
      if (/TargetMode="External"/.test(m[0])) continue
      const dir = part.slice(0, part.lastIndexOf('/'))
      const target = m[1]!.startsWith('/') ? m[1]!.slice(1) : `${dir}/${m[1]}`.replace(/[^/]+\/\.\.\//g, '')
      if (!pkg[target]) out.push(`${part} 的关系指向不存在的部件 ${target}`)
    }
  }
  const ids = (re: RegExp, s: string) => [...s.matchAll(re)].map(m => m[1]!)
  const notes = (kind: 'footnote' | 'endnote') => {
    const part = text(pkg, `word/${kind}s.xml`) ?? ''
    for (const id of ids(new RegExp(`<w:${kind}Reference w:id="(-?\\d+)"`, 'g'), doc)) if (!new RegExp(`<w:${kind}\\b[^>]*w:id="${id}"`).test(part)) out.push(`${kind} ${id} 没有正文`)
  }
  notes('footnote'); notes('endnote')
  const comments = text(pkg, 'word/comments.xml') ?? ''
  for (const id of ids(/<w:commentReference w:id="(\d+)"/g, doc)) if (!new RegExp(`<w:comment\\b[^>]*w:id="${id}"`).test(comments)) out.push(`批注 ${id} 在 comments.xml 里没有条目`)
  for (const id of ids(/<w:commentRangeStart w:id="(\d+)"/g, doc)) if (!doc.includes(`<w:commentRangeEnd w:id="${id}"/>`)) out.push(`批注 ${id} 只有起点没有终点`)
  for (const id of ids(/<w:bookmarkStart\b[^>]*w:id="(\d+)"/g, doc)) if (!new RegExp(`<w:bookmarkEnd\\b[^>]*w:id="${id}"`).test(doc)) out.push(`书签 ${id} 没有结束`)
  const begin = (doc.match(/w:fldCharType="begin"/g) ?? []).length
  const end = (doc.match(/w:fldCharType="end"/g) ?? []).length
  if (begin !== end) out.push(`域开始 ${begin} 个、结束 ${end} 个`)
  const dup = (list: string[]) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))]
  const paraIds = dup(ids(/w14:paraId="([0-9A-Fa-f]+)"/g, doc))
  if (paraIds.length) out.push(`段落 ID 重复：${paraIds.slice(0, 3).join(',')}`)
  const revIds = dup(ids(/<w:(?:ins|del|moveFrom|moveTo|rPrChange|pPrChange)\b[^>]*w:id="(\d+)"/g, doc))
  if (revIds.length) out.push(`修订 id 重复：${revIds.slice(0, 3).join(',')}`)
  const types = text(pkg, '[Content_Types].xml')!
  for (const name of Object.keys(pkg)) {
    if (name === '[Content_Types].xml') continue
    const ext = name.split('.').pop()!
    if (!types.includes(`PartName="/${name}"`) && !new RegExp(`Extension="${ext}"`, 'i').test(types)) out.push(`部件 ${name} 没有内容类型`)
  }
  return out
}


/** LibreOffice 打开并转成纯文本；expect 为应能读到的文字（正则）。打不开或读不到时返回原因，否则 null。 */
export function opens(pkg: D.Pkg, expect: RegExp): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'docx-check-'))
  writeFileSync(join(dir, 'x.docx'), D.saveDocx(pkg))
  try {
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'txt:Text', '--outdir', dir, join(dir, 'x.docx')], { stdio: 'ignore', timeout: 90_000 })
    const txt = readFileSync(join(dir, 'x.txt'), 'utf8')
    return expect.test(txt) ? null : 'LibreOffice 打开后读不到正文'
  } catch (err) {
    return `LibreOffice 打不开：${String((err as Error).message).slice(0, 80)}`
  }
}

/** 同上，异步（评测时三组并行，转换期间不阻塞事件循环）。 */
export async function opensAsync(pkg: D.Pkg, expect: RegExp): Promise<string | null> {
  const { execFile } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'docx-check-'))
  writeFileSync(join(dir, 'x.docx'), D.saveDocx(pkg))
  const ok = await new Promise<boolean>(resolve => execFile('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'txt:Text', '--outdir', dir, join(dir, 'x.docx')], { timeout: 120_000 }, err => resolve(!err)))
  if (!ok) return 'LibreOffice 打不开'
  try {
    return expect.test(readFileSync(join(dir, 'x.txt'), 'utf8')) ? null : 'LibreOffice 打开后读不到正文'
  } catch {
    return 'LibreOffice 没有转出文本'
  }
}

/**
 * 块的规范化 XML：属性按名排序、去掉保存痕迹（w:rsid*）、元素间的空白不计、属性容器（rPr、pPr 等）里的子元素按内容排序；
 * 批注范围与批注引用不计（新加批注是看得见的注释，不是改动）；相邻、格式相同的纯文字 run 合并（run 切分方式不同不算改动）。
 * 规范化后仍不同 = 真实的格式或结构改动。
 */
export function canonical(xml: string): string {
  const doc = new DOMParser({ onError: () => {} }).parseFromString(`<root ${NS_DECL}>${xml}</root>`, 'text/xml')
  const SORTED = new Set(['w:rPr', 'w:pPr', 'w:tcPr', 'w:tblPr', 'w:trPr', 'w:sectPr', 'w:rFonts', 'w:tblBorders', 'w:pBdr', 'w:tcBorders'])
  const elems = (n: any) => Array.from(n.childNodes as ArrayLike<any>).filter(c => c.nodeType === 1)
  const walk = (n: any, inText: boolean): string => {
    if (n.nodeType === 3) return inText || n.nodeValue.trim() ? n.nodeValue : ''
    if (n.nodeType !== 1) return ''
    if (n.nodeName === 'w:commentRangeStart' || n.nodeName === 'w:commentRangeEnd') return ''
    const kidsEl = elems(n)
    if (n.nodeName === 'w:r' && kidsEl.length > 0 && kidsEl.every(c => c.nodeName === 'w:rPr' || c.nodeName === 'w:commentReference') && kidsEl.some(c => c.nodeName === 'w:commentReference')) return ''
    // 纯文字 run（rPr + 一个 w:t）记成可合并的记号
    if (n.nodeName === 'w:r' && kidsEl.length <= 2 && kidsEl.filter(c => c.nodeName === 'w:t').length === 1 && kidsEl.every(c => c.nodeName === 'w:t' || c.nodeName === 'w:rPr')) {
      const rpr = kidsEl.find(c => c.nodeName === 'w:rPr')
      return `\u0001${rpr ? walk(rpr, false) : ''}\u0002${kidsEl.find(c => c.nodeName === 'w:t').textContent}\u0003`
    }
    const attrs = Array.from(n.attributes as ArrayLike<{ name: string; value: string }>).filter(a => !/^w:rsid/.test(a.name) && !/^xmlns/.test(a.name)).map(a => `${a.name}="${a.value}"`).sort().join(' ')
    const kids = Array.from(n.childNodes as ArrayLike<any>).map(c => walk(c, n.nodeName === 'w:t' || n.nodeName === 'w:delText' || n.nodeName === 'w:instrText'))
    if (SORTED.has(n.nodeName)) kids.sort()
    // 相邻、格式相同的纯文字 run 合并
    const merged: string[] = []
    for (const k of kids) {
      const m = /^\u0001([\s\S]*)\u0002([\s\S]*)\u0003$/.exec(k)
      const last = merged.length ? /^\u0001([\s\S]*)\u0002([\s\S]*)\u0003$/.exec(merged[merged.length - 1]!) : null
      if (m && last && last[1] === m[1]) merged[merged.length - 1] = `\u0001${m[1]}\u0002${last[2]}${m[2]}\u0003`
      else if (k) merged.push(k)
    }
    const body = merged.map(k => k.replace(/^\u0001([\s\S]*)\u0002([\s\S]*)\u0003$/, (_m, rpr: string, t: string) => `<w:r>${rpr}<w:t>${t}</w:t></w:r>`)).join('')
    return `<${n.nodeName}${attrs ? ' ' + attrs : ''}>${body}</${n.nodeName}>`
  }
  return Array.from(doc.documentElement.childNodes as ArrayLike<any>).map(c => walk(c, false)).join('')
}
const NS_DECL = [
  ['w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'], ['r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'],
  ['w14', 'http://schemas.microsoft.com/office/word/2010/wordml'], ['w15', 'http://schemas.microsoft.com/office/word/2012/wordml'],
  ['wp', 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'], ['a', 'http://schemas.openxmlformats.org/drawingml/2006/main'],
  ['pic', 'http://schemas.openxmlformats.org/drawingml/2006/picture'], ['m', 'http://schemas.openxmlformats.org/officeDocument/2006/math'],
  ['mc', 'http://schemas.openxmlformats.org/markup-compatibility/2006'], ['wps', 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'],
  ['v', 'urn:schemas-microsoft-com:vml'], ['o', 'urn:schemas-microsoft-com:office:office'],
].map(([p, u]) => `xmlns:${p}="${u}"`).join(' ')
