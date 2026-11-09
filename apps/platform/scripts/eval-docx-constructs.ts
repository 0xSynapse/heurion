/**
 * 导入质量评测：在干净 docx 上叠加作者投稿稿件常见的 Word 结构，检验产品的 Word 导入（标准答案仍是同版本 JATS）。
 * 叠加的结构（可按名单选择）：
 * - cite：正文引用「[12]」改成 EndNote 引文域（显示结果应保留，域指令不应进入正文）
 * - reflist：文末文献表包进横跨多段的 EndNote 文献表域
 * - seq：「Table 3.」里的编号改成 SEQ 题注域
 * - track：修订——正文末尾标为「插入」（应保留），再追加一段「删除」（采纳后的正文里不应出现，删除内容带标记数字 98765）
 * - textbox：第一个表题放进文本框
 * - linenum：开启行号（导入时应忽略）
 * - autonum：章节编号改由多级列表自动生成（只在按顺序编号能完全还原原编号时才改）
 * 输入是 LibreOffice 由平台 HTML 生成的 docx（段落样式 BodyText / Heading1–4），见 eval-import.ts。
 */
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
/** 修订删除内容里的标记数字：采纳后的正文里出现即为泄漏 */
export const DELETED_MARK = '98765'
const DEL_MARK = `DELETEDXYZ ${DELETED_MARK}`
export const ALL_CONSTRUCTS = ['cite', 'reflist', 'seq', 'track', 'textbox', 'linenum', 'autonum'] as const
export type Construct = typeof ALL_CONSTRUCTS[number]

export function applyConstructs(bytes: Uint8Array, which: ReadonlySet<string> = new Set(ALL_CONSTRUCTS)): { out: Uint8Array; applied: Record<string, number> } {
  const files = unzipSync(bytes)
  const doc: any = new DOMParser().parseFromString(strFromU8(files['word/document.xml']!), 'text/xml')
  const applied: Record<string, number> = {}
  const bump = (k: string) => { applied[k] = (applied[k] ?? 0) + 1 }
  const el = (name: string, attrs: Record<string, string> = {}, kids: any[] = []) => {
    const e = doc.createElementNS(W, `w:${name}`)
    for (const [k, v] of Object.entries(attrs)) e.setAttributeNS(W, `w:${k}`, v)
    for (const k of kids) e.appendChild(k)
    return e
  }
  const run = (text: string) => { const t = el('t', { space: 'preserve' }); t.setAttribute('xml:space', 'preserve'); t.appendChild(doc.createTextNode(text)); return el('r', {}, [t]) }
  const instr = (text: string) => { const t = el('instrText'); t.setAttribute('xml:space', 'preserve'); t.appendChild(doc.createTextNode(text)); return el('r', {}, [t]) }
  const fld = (type: string) => el('r', {}, [el('fldChar', { fldCharType: type })])
  const paras = () => Array.from(doc.getElementsByTagNameNS(W, 'p')) as any[]
  const styleOf = (p: any) => p.getElementsByTagNameNS(W, 'pStyle')[0]?.getAttributeNS(W, 'val') ?? ''
  const textOf = (p: any) => (Array.from(p.getElementsByTagNameNS(W, 't')) as any[]).map(t => t.textContent).join('')
  const inTable = (p: any) => { for (let n = p.parentNode; n; n = n.parentNode) if (n.localName === 'tbl') return true; return false }

  // 1. 引文域：正文里的「[12]」「[3,5]」换成 EndNote 引文域（结果文字不变，指令文字不应进入正文）
  if (which.has('cite')) for (const t of Array.from(doc.getElementsByTagNameNS(W, 't')) as any[]) {
    const s: string = t.textContent
    const m = /\[\d+(?:\s*[,–-]\s*\d+)*\]/.exec(s)
    if (!m || inTable(t)) continue
    const r = t.parentNode, parent = r.parentNode
    const before = s.slice(0, m.index), after = s.slice(m.index + m[0].length)
    for (const n of [run(before), fld('begin'), instr(' ADDIN EN.CITE <EndNote><Cite><Author>Smith</Author><Year>2020</Year><RecNum>123</RecNum></Cite></EndNote>'), fld('separate'), run(m[0]), fld('end'), run(after)]) parent.insertBefore(n, r)
    parent.removeChild(r)
    bump('cite')
  }

  // 2. 文献表域：References 标题之后的条目段落包进一个横跨多段的 EndNote 文献表域
  if (which.has('reflist')) {
    const ps = paras()
    const h = ps.findIndex(p => /^Heading/.test(styleOf(p)) && /^references$/i.test(textOf(p).trim()))
    const refs = h >= 0 ? ps.slice(h + 1).filter(p => /^\[[^\]]+\]\s/.test(textOf(p))) : []
    if (refs.length >= 2) {
      const first = refs[0], last = refs[refs.length - 1]
      const firstRun = first.getElementsByTagNameNS(W, 'r')[0]
      for (const n of [fld('begin'), instr(' ADDIN EN.REFLIST '), fld('separate')]) first.insertBefore(n, firstRun)
      last.appendChild(fld('end'))
      bump('reflist')
    }
  }

  // 3. 表题编号域：「Table 3.」里的 3 换成 SEQ 题注域（Word 插入题注的写法）
  if (which.has('seq')) for (const p of paras()) {
    const t = p.getElementsByTagNameNS(W, 't')[0]
    const m = t && /^(Table|Figure)\s+(\d+)/.exec(t.textContent)
    if (!m || inTable(p)) continue
    const r = t.parentNode
    const rest = t.textContent.slice(m[0].length)
    for (const n of [run(`${m[1]} `), fld('begin'), instr(` SEQ ${m[1]} \\* ARABIC `), fld('separate'), run(m[2]), fld('end'), run(rest)]) p.insertBefore(n, r)
    p.removeChild(r)
    bump('seq')
  }

  // 4. 修订：正文段落的最后一个文字片段标为「插入」（应保留），再追加一段「删除」（不应出现）
  if (which.has('track')) {
    let n = 0
    for (const p of paras()) {
      if (n >= 8 || styleOf(p) !== 'BodyText' || inTable(p) || textOf(p).length < 200) continue
      const runs = (Array.from(p.childNodes) as any[]).filter(c => c.localName === 'r')
      const last = runs[runs.length - 1]
      if (!last) continue
      const ins = el('ins', { id: String(9000 + n), author: 'Reviewer', date: '2026-01-01T00:00:00Z' })
      p.insertBefore(ins, last); ins.appendChild(last)
      const dt = el('delText'); dt.setAttribute('xml:space', 'preserve'); dt.appendChild(doc.createTextNode(` ${DEL_MARK}`))
      p.appendChild(el('del', { id: String(9500 + n), author: 'Reviewer', date: '2026-01-01T00:00:00Z' }, [el('r', {}, [dt])]))
      n++; bump('track')
    }
  }

  // 5. 文本框：第一个表题段落的内容放进文本框（VML 写法）
  if (which.has('textbox')) {
    const p = paras().find(p => /^Table\s/.test(textOf(p)) && !inTable(p))
    if (p) {
      const V = 'urn:schemas-microsoft-com:vml'
      doc.documentElement.setAttribute('xmlns:v', V)
      const inner = el('p', {}, (Array.from(p.childNodes) as any[]).filter(c => c.localName !== 'pPr'))
      const shape = doc.createElementNS(V, 'v:shape'); shape.setAttribute('style', 'width:400pt;height:40pt')
      const tb = doc.createElementNS(V, 'v:textbox'); tb.appendChild(el('txbxContent', {}, [inner])); shape.appendChild(tb)
      p.appendChild(el('r', {}, [el('pict', {}, [shape])]))
      bump('textbox')
    }
  }

  // 6. 行号
  if (which.has('linenum')) {
    const sect = doc.getElementsByTagNameNS(W, 'sectPr')[0]
    if (sect) { sect.appendChild(el('lnNumType', { countBy: '1', restart: 'continuous' })); bump('linenum') }
  }

  // 7. 章节自动编号：「2.1 Study design」的编号改由多级列表生成；只在按顺序编号能完全还原原编号时才改
  if (which.has('autonum')) {
    const heads = paras().filter(p => /^Heading[1-6]$/.test(styleOf(p)))
    const numbered = heads.map(p => ({ p, m: /^(\d+(?:\.\d+)*)\.?\s+/.exec(textOf(p)) })).filter(x => x.m)
    const counters: number[] = []
    const ok = numbered.length >= 3 && numbered.every(({ m }) => {
      const parts = m![1]!.split('.').map(Number)
      const lvl = parts.length - 1
      counters.length = lvl + 1
      counters[lvl] = (counters[lvl] ?? 0) + 1
      for (let i = 0; i < lvl; i++) counters[i] ??= 1
      return parts.every((v, i) => v === counters[i])
    })
    if (ok && files['word/numbering.xml']) {
      const num: any = new DOMParser().parseFromString(strFromU8(files['word/numbering.xml']!), 'text/xml')
      const root = num.documentElement
      const mk = (name: string, attrs: Record<string, string> = {}, kids: any[] = []) => { const e = num.createElementNS(W, `w:${name}`); for (const [k, v] of Object.entries(attrs)) e.setAttributeNS(W, `w:${k}`, v); kids.forEach(k => e.appendChild(k)); return e }
      const lvls = [0, 1, 2, 3].map(i => mk('lvl', { ilvl: String(i) }, [mk('start', { val: '1' }), mk('numFmt', { val: 'decimal' }), mk('lvlText', { val: Array.from({ length: i + 1 }, (_, k) => `%${k + 1}`).join('.') + (i === 0 ? '.' : '') })]))
      const firstNum = root.getElementsByTagNameNS(W, 'num')[0]
      root.insertBefore(mk('abstractNum', { abstractNumId: '900' }, lvls), firstNum ?? null)
      root.appendChild(mk('num', { numId: '900' }, [mk('abstractNumId', { val: '900' })]))
      files['word/numbering.xml'] = strToU8(new XMLSerializer().serializeToString(num))
      for (const { p, m } of numbered) {
        const t = p.getElementsByTagNameNS(W, 't')[0]
        t.textContent = t.textContent.slice(m![0].length)
        const pPr = p.getElementsByTagNameNS(W, 'pPr')[0]
        pPr.appendChild(el('numPr', {}, [el('ilvl', { val: String(m![1]!.split('.').length - 1) }), el('numId', { val: '900' })]))
        bump('autonum')
      }
    }
  }

  files['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(doc))
  return { out: zipSync(files), applied }
}

