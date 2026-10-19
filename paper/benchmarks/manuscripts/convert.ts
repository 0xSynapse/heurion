/**
 * 把开放获取论文的 JATS XML 转成改稿测试集用的稿件：markdown（平台导入）与期刊模板风格的 .docx。
 *   cd apps/platform && npx tsx ../../paper/benchmarks/manuscripts/convert.ts
 * 保留：题目、结构化摘要、各节正文（含小节）、表格（合并单元格拆开填空）、图注、文内编号引用 [n]、参考文献表。
 * 去掉：图片本身、补充材料、致谢以外的后附信息（作者贡献、利益冲突、资助等）。数字与文字全部来自原文。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { docxFor } from '../../../apps/platform/src/convert/exports.ts'
import { setup } from '../../../apps/platform/tests/helpers.ts'
import * as D from '../exp3/docx.ts'
import type { Paper } from './fetch.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(join(here, '../../../apps/platform/package.json'))
const { DOMParser } = require('@xmldom/xmldom') as typeof import('@xmldom/xmldom')

type El = Element

const kids = (e: El, name?: string): El[] => Array.from(e.childNodes).filter((n): n is El => n.nodeType === 1 && (!name || (n as El).localName === name)) as El[]
const first = (e: El | null | undefined, name: string): El | null => (e ? (e.getElementsByTagName(name)[0] as El | undefined) ?? null : null)
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const mdEsc = (s: string) => s.replace(/([*_`[\]|\\])/g, '\\$1')

/** 行内文字：引用 → [n]，上下标保留为文字，其余去标签。 */
function inline(e: Node, refNo: Map<string, number>): string {
  let out = ''
  for (const n of Array.from(e.childNodes)) {
    if (n.nodeType === 3) { out += mdEsc(n.nodeValue ?? ''); continue }
    if (n.nodeType !== 1) continue
    const el = n as El
    const tag = el.localName
    if (tag === 'xref' && el.getAttribute('ref-type') === 'bibr') {
      const nums = (el.getAttribute('rid') ?? '').split(/\s+/).map(r => refNo.get(r)).filter((x): x is number => !!x)
      const text = squash(el.textContent ?? '')
      // 原文的引用标记多为上标数字或 [n]；统一写成方括号编号
      out += nums.length ? `[${nums.join(',')}]` : /^\d/.test(text) ? `[${text}]` : text
      continue
    }
    if (tag === 'xref') { out += inline(el, refNo); continue }
    if (tag === 'italic') { const t = inline(el, refNo); out += t.trim() ? `*${t}*` : t; continue }
    if (tag === 'bold') { const t = inline(el, refNo); out += t.trim() ? `**${t}**` : t; continue }
    if (['fn', 'table-wrap', 'fig', 'disp-formula', 'supplementary-material', 'graphic', 'inline-graphic', 'media'].includes(tag)) continue
    out += inline(el, refNo)
  }
  return out
}

const para = (e: El, refNo: Map<string, number>) => squash(inline(e, refNo)).replace(/\s+([,.;:)])/g, '$1')

function table(tw: El, refNo: Map<string, number>): string[] {
  const label = squash(first(tw, 'label')?.textContent ?? '')
  const title = squash(first(first(tw, 'caption'), 'title')?.textContent ?? first(tw, 'caption')?.textContent ?? '')
  const t = first(tw, 'table')
  if (!t) return []
  // 展开合并单元格：rowspan / colspan 的延伸部分留空
  const grid: string[][] = []
  const rows = Array.from(t.getElementsByTagName('tr')) as El[]
  rows.forEach((tr, r) => {
    grid[r] ??= []
    let c = 0
    for (const cell of kids(tr).filter(k => k.localName === 'td' || k.localName === 'th')) {
      while (grid[r]![c] !== undefined) c++
      const text = para(cell, refNo).replace(/\|/g, '/') || ' '
      const rs = Number(cell.getAttribute('rowspan') || 1)
      const cs = Number(cell.getAttribute('colspan') || 1)
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) {
        grid[r + i] ??= []
        grid[r + i]![c + j] = i === 0 && j === 0 ? text : ' '
      }
      c += cs
    }
  })
  const width = Math.max(...grid.map(r => r.length))
  const lines = grid.filter(r => r.some(x => x.trim())).map(r => `| ${Array.from({ length: width }, (_, i) => r[i] ?? ' ').join(' | ')} |`)
  if (lines.length === 0) return []
  const out = [`${label ? `**${label.replace(/\.$/, '')}.** ` : ''}${title}`, '', lines[0]!, `| ${Array(width).fill('---').join(' | ')} |`, ...lines.slice(1)]
  const foot = kids(first(tw, 'table-wrap-foot') ?? tw).flatMap(k => k.localName === 'fn' || k.localName === 'p' ? [para(k, refNo)] : [])
  if (foot.length) out.push('', ...foot.filter(Boolean).map(f => `*${f.replace(/\*/g, '')}*`))
  return out
}

function section(sec: El, depth: number, refNo: Map<string, number>, out: string[]): void {
  const title = squash(first(sec, 'title')?.textContent ?? '')
  if (/^(author contributions?|conflicts? of interest|competing interests?|funding|acknowledg|declarations?|data availability|availability of data|ethics approval|consent for publication|abbreviations|supplementary|article information|references|associated data|supporting information|additional files?)/i.test(title)) return
  if (title) out.push(`${'#'.repeat(Math.min(depth, 4))} ${title}`, '')
  for (const k of kids(sec)) {
    if (k.localName === 'p') {
      // 段内嵌的表格放到段后
      const text = para(k, refNo)
      if (text) out.push(text, '')
      for (const tw of Array.from(k.getElementsByTagName('table-wrap')) as El[]) out.push(...table(tw, refNo), '')
    } else if (k.localName === 'sec') section(k, depth + 1, refNo, out)
    else if (k.localName === 'table-wrap') out.push(...table(k, refNo), '')
    else if (k.localName === 'fig') {
      const label = squash(first(k, 'label')?.textContent ?? '')
      const cap = squash(first(k, 'caption')?.textContent ?? '')
      if (cap) out.push(`${label ? `**${label.replace(/\.$/, '')}.** ` : ''}${mdEsc(cap)}`, '')
    } else if (k.localName === 'list') {
      for (const li of kids(k, 'list-item')) out.push(`- ${para(li, refNo)}`)
      out.push('')
    }
  }
}

export interface Ref { n: number; title: string; first: string; year: string; doi: string; pmid: string }

function refMeta(ref: El, n: number): Ref {
  const mc = first(ref, 'element-citation') ?? first(ref, 'mixed-citation') ?? first(ref, 'nlm-citation') ?? ref
  const id = (type: string) => (Array.from(mc.getElementsByTagName('pub-id')) as El[]).find(p => p.getAttribute('pub-id-type') === type)?.textContent?.trim() ?? ''
  const text = squash(mc.textContent ?? '')
  // 部分期刊（如 JAMA）的引用是整段纯文本：从文字里取 DOI / PMID / 题目
  const doi = id('doi') || (/\b(10\.\d{4,9}\/[^\s,;]+)/.exec(text)?.[1] ?? '').replace(/[.)]+$/, '')
  const pmid = id('pmid') || (/PMID:?\s*(\d{5,9})/i.exec(text)?.[1] ?? '')
  // 纯文本引用：在前几段里挑最像题目的一段（≥4 个词、不含作者分隔的分号）
  const guess = text.split(/\.\s+/).slice(1, 4).filter(x => x.split(' ').length >= 4 && !x.includes(';')).sort((x, y) => y.length - x.length)[0] ?? ''
  const title = squash(first(mc, 'article-title')?.textContent ?? '') || guess
  const surname = squash(first(mc, 'surname')?.textContent ?? first(mc, 'collab')?.textContent ?? '') || (text.split(/[ ,]/)[0] ?? '')
  return { n, title: title.replace(/\.$/, ''), first: surname, year: squash(first(mc, 'year')?.textContent ?? '') || (/\b(19|20)\d{2}\b/.exec(text)?.[0] ?? ''), doi, pmid }
}

function reference(ref: El): string {
  const mc = first(ref, 'element-citation') ?? first(ref, 'mixed-citation') ?? first(ref, 'nlm-citation') ?? ref
  const names = (Array.from(mc.getElementsByTagName('name')) as El[]).map(n => `${squash(first(n, 'surname')?.textContent ?? '')} ${squash(first(n, 'given-names')?.textContent ?? '').replace(/[^A-Z]/g, '')}`.trim())
  const authors = names.length > 6 ? `${names.slice(0, 6).join(', ')}, et al` : names.join(', ')
  const title = squash(first(mc, 'article-title')?.textContent ?? first(mc, 'chapter-title')?.textContent ?? '')
  const source = squash(first(mc, 'source')?.textContent ?? '')
  const year = squash(first(mc, 'year')?.textContent ?? '')
  const vol = squash(first(mc, 'volume')?.textContent ?? '')
  const issue = squash(first(mc, 'issue')?.textContent ?? '')
  const fp = squash(first(mc, 'fpage')?.textContent ?? '')
  const lp = squash(first(mc, 'lpage')?.textContent ?? '')
  const doi = (Array.from(mc.getElementsByTagName('pub-id')) as El[]).find(p => p.getAttribute('pub-id-type') === 'doi')?.textContent?.trim()
  const structured = [authors && `${authors}.`, title && `${title.replace(/\.$/, '')}.`, source && `${source}.`, year && `${year}${vol ? `;${vol}` : ''}${issue ? `(${issue})` : ''}${fp ? `:${fp}${lp ? `-${lp}` : ''}` : ''}.`, doi && `doi:${doi}`].filter(Boolean).join(' ')
  return mdEsc(structured || squash(mc.textContent ?? ''))
}

export function convert(xml: string): { markdown: string; words: number; tables: number; refs: number; title: string; refList: Ref[] } {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const article = doc.documentElement as unknown as El
  const refs = Array.from(article.getElementsByTagName('ref')) as El[]
  const refNo = new Map(refs.map((r, i) => [r.getAttribute('id') ?? `r${i}`, i + 1]))
  const meta = first(article, 'article-meta')
  const title = squash(first(meta, 'article-title')?.textContent ?? '')
  const out: string[] = [`# ${mdEsc(title)}`, '']
  // 摘要：取第一个不带 abstract-type 的（正式摘要，不取「要点」「图文摘要」）
  const abstracts = Array.from(meta?.getElementsByTagName('abstract') ?? []) as El[]
  const abs = abstracts.find(a => !a.getAttribute('abstract-type')) ?? abstracts[0]
  if (abs) {
    out.push('## Abstract', '')
    const secs = kids(abs, 'sec')
    if (secs.length) for (const s of secs) out.push(`**${squash(first(s, 'title')?.textContent ?? '')}:** ${kids(s, 'p').map(p => para(p, refNo)).join(' ')}`, '')
    else for (const p of kids(abs, 'p')) out.push(para(p, refNo), '')
  }
  const body = first(article, 'body')
  if (body) {
    for (const k of kids(body)) {
      if (k.localName === 'sec') section(k, 2, refNo, out)
      else if (k.localName === 'p') { const t = para(k, refNo); if (t) out.push(t, '') }
    }
    // 文末浮动的表格（部分期刊放在 floats-group）
  }
  for (const tw of Array.from(first(article, 'floats-group')?.getElementsByTagName('table-wrap') ?? []) as El[]) out.push(...table(tw, refNo), '')
  if (refs.length) {
    out.push('## References', '')
    refs.forEach((r, i) => out.push(`${i + 1}. ${reference(r)}`))
    out.push('')
  }
  const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n')
  const prose = markdown.split('## References')[0]!.replace(/^\|.*$/gm, '')
  return { markdown, words: prose.split(/\s+/).filter(Boolean).length, tables: (markdown.match(/^\| --- /gm) ?? []).length, refs: refs.length, title, refList: refs.map((r, i) => refMeta(r, i + 1)) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const papers = JSON.parse(readFileSync(join(here, 'corpus.json'), 'utf8')) as Paper[]
  const MD = join(here, 'data', 'md')
  const DOCX = join(here, 'data', 'docx')
  mkdirSync(MD, { recursive: true })
  mkdirSync(DOCX, { recursive: true })
  mkdirSync(join(here, 'data', 'refs'), { recursive: true })
  for (const p of papers) {
    const r = convert(readFileSync(join(here, 'data', 'xml', `${p.pmcid}.xml`), 'utf8'))
    writeFileSync(join(MD, `${p.pmcid}.md`), r.markdown)
    writeFileSync(join(here, 'data', 'refs', `${p.pmcid}.json`), JSON.stringify(r.refList, null, 1))
    // 期刊模板风格的 Word：经平台导出再加工（双倍行距、首行缩进、统一字体字号、段落 ID）
    const { docs, docId } = setup(r.markdown)
    const pkg = D.journalize(D.openDocx(docxFor(docs, docId).bytes), [], { percentItalic: false })
    writeFileSync(join(DOCX, `${p.pmcid}.docx`), D.saveDocx(pkg))
    console.log(`${p.pmcid} ${p.type}/${p.split}  ${r.words} 词  ${r.tables} 表  ${r.refs} 篇参考文献  ${r.title.slice(0, 60)}`)
  }
}
