/**
 * JATS → 平台 markdown 转换的保真度检查：不复用转换器代码，独立从原文 XML 取「应该出现的内容」，
 * 与导入平台后的文档逐项比对。
 *   pnpm --filter @heurion2/platform eval:review:check        检查清单里全部已转换的论文
 * 检查项：
 * 1. 数字：原文（摘要、正文、表格、图表题注，不含文献表与公式）里的每个数字按出现次数都要在文档里出现，缺失必须为 0；
 * 2. 文字：原文词元在文档中的缺失比例；
 * 3. 表格：每张表的行数、列数与逐格内容（按合并单元格展开后的网格）；
 * 4. 章节标题：原文每个章节标题（含编号）都要作为标题出现；
 * 5. 转义残留：文档文字里不能出现原文没有的 markdown 转义反斜杠。
 */
import { DOMParser } from '@xmldom/xmldom'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Node as PMNode } from 'prosemirror-model'
import { abstractsOf, type El } from './eval-jats.ts'
import { readGrid } from '../src/model/table-grid.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'

export interface FidelityReport {
  missingNumbers: Array<{ token: string; missing: number }>
  extraNumbers: Array<{ token: string; extra: number }>
  numberCount: number
  wordCount: number
  missingWordRatio: number
  missingWordsSample: string[]
  tables: {
    source: number
    converted: number
    mismatched: Array<{ table: string; problem: string }>
    /**
     * 每张原文表格：是否找到对应表、行列是否一致、位置完全对上的单元格比例、内容出现在对应表中（不论位置）的单元格比例；
     * 合并单元格（只统计行列一致的表）：原文被合并区覆盖的格数、其中转换结果同样被覆盖的格数、转换结果多出的被覆盖格数
     */
    detail: Array<{ found: boolean; dimsOk: boolean; cellExact: number; cellRecall: number; spanCells: number; spanHit: number; spanExtra: number }>
  }
  missingHeadings: string[]
  escapeResidue: string[]
  /**
   * 结构（只用于导入评测，不影响 ok）：
   * - titleOk：文档第一个标题是论文标题；
   * - 图：原文图数、图注落在某个图块上的图数、文档图块数、没有图注的图块数（版面杂物、拆开的子图）；
   * - 标题：原文没有的多余标题数（侧栏信息、图里的文字）、对上的标题中层级不对的个数；
   * - 段落：原文较长的段落（≥25 词）数、其中首尾不在同一块里的段落数（换页 / 换栏被截断、混进别的内容）。
   */
  structure: {
    titleOk: boolean
    figSource: number
    figCaptioned: number
    figImages: number
    figUncaptioned: number
    headingsExtra: string[]
    headingLevelWrong: number
    paraTotal: number
    paraBroken: number
    /** 原文的独立公式（disp-formula）数、转换结果里的公式块数（只比个数：原文是 MathML，转换结果是 TeX） */
    formulaSource: number
    formulaConverted: number
  }
  ok: boolean
}

const each = (list: ArrayLike<El> | undefined | null): El[] => (list ? Array.from({ length: list.length }, (_, i) => list[i]!) : [])
const elements = (n: El): El[] => each(n.childNodes).filter(c => c.nodeType === 1)
const child = (n: El, name: string) => elements(n).find(c => c.nodeName === name)

const NUM = /\d+(?:\.\d+)?/g
// 中日韩文字没有空格：每个字算一个词，其余文字按连续两个以上字母算词（「PAOO技术」与「PAOO 技术」一样）
const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])\p{L}){2,}/gu
const numbers = (s: string) => s.match(NUM) ?? []
const words = (s: string) => (s.toLowerCase().match(WORD) ?? [])
const tokens = (s: string) => [...numbers(s), ...words(s)].join(' ')
/** 按原顺序的词序列（只取字母词，前后带空格，便于判断「连续出现」） */
const wordSeq = (s: string) => ` ${words(s).join(' ')} `
/**
 * 文末声明类标题（作者贡献、基金、数据可用性、利益冲突等）：原文多放在脚注组 / notes 里（不比对的部分），
 * PDF 里是正常的小节标题，不算多余标题
 */
const BACK_MATTER = /^(?:authors?(?: s)? contributions?|contributions|funding(?: information| statement)?|financial support|data(?: and code)? availability(?: statement)?|code availability|availability of data and materials|competing interests?|conflicts? of interests?|declaration(?:s| of interests?)?|ethics(?: approval and consent to participate| statement| declarations)?|consent for publication|additional information|publisher(?: s)? note|supplementary (?:material|information|data)|abbreviations|generative ai statement|author details|study limitations?|reporting summary|institutional review board statement|informed consent statement|disclaimer publisher(?: s)? note|nonstandard abbreviations and acronyms|authors? affiliations|authors and affiliations|ethic(?:s|al) approval|grant disclosures|supplementary files|disclosures?|declaration of conflicting (?:of )?interests.*|competing interests.*|authors relationships and activities)$/
const hasAncestor = (n: El, names: string[]) => { for (let p = n.parentNode as El | null; p; p = p.parentNode as El | null) if (names.includes(p.nodeName)) return true; return false }
const depthOf = (n: El) => { let d = 0; for (let p = n as El | null; p; p = p.parentNode as El | null) if (p.nodeName === 'sec') d++; return d }

/** 元素边界插空格的文字：避免「10<sup>9</sup>」粘成 109、相邻单元格粘在一起 */
function spacedText(n: El): string {
  if (n.nodeType === 3 || n.nodeType === 4) return n.textContent ?? ''
  if (n.nodeType !== 1) return ''
  return ` ${each(n.childNodes).map(spacedText).join('')} `
}

/** 单元格按 <break/> 或格内 <p> 分出的各行文字（都没有时只有一行）。 */
function breakLines(n: El): string[] {
  const out = ['']
  const walk = (x: El) => {
    if (x.nodeType === 3 || x.nodeType === 4) { out[out.length - 1] += x.textContent ?? ''; return }
    if (x.nodeType !== 1) return
    if (x.nodeName === 'break') { out.push(''); return }
    // 格内几个 <p> 也是分行
    const para = x.nodeName === 'p'
    if (para) out.push('')
    out[out.length - 1] += ' '
    each(x.childNodes).forEach(walk)
    out[out.length - 1] += ' '
    if (para) out.push('')
  }
  walk(n)
  return out.map(s => s.trim()).filter(Boolean)
}

/**
 * 有的 JATS（中文期刊常见）把整张表的几十行塞进一行，每格用 <break/> 或几个 <p> 分行；PDF 上是逐行排的。
 * 一行里每个有字的格都正好有 k（≥3）行、且没有合并单元格时，展开成 k 行，与 PDF 的排法一致。
 */
function splitBreakRows(cells: El[]): string[][] | null {
  if (cells.some(c => (Number(c.getAttribute('rowspan')) || 1) > 1 || (Number(c.getAttribute('colspan')) || 1) > 1)) return null
  const lines = cells.map(breakLines)
  const filled = lines.filter(l => l.length)
  const k = filled[0]?.length ?? 0
  // 至少 3 行：两行的多是表头里折行的标签（「Control」「(n=50)」），PDF 上也在一格里
  if (k < 3 || filled.length < 2 || filled.some(l => l.length !== k)) return null
  // 格内的项目列表（「• 18 years old …」）不是压缩的多行：带项目符号、或各行是长句时不展开
  const all = filled.flat()
  if (all.some(s => /^[•·▪◦‣\-–]\s/.test(s)) || all.reduce((n, s) => n + s.length, 0) / all.length > 40) return null
  return Array.from({ length: k }, (_, i) => lines.map(l => l[i] ?? ''))
}

const remove = (els: El[]) => { for (const e of els) e.parentNode?.removeChild(e) }

/**
 * 展开的引用编号收回区间：JATS 把「[28–36]」写成 28, 29, …, 36（每个一个 xref），PDF 上只印首尾。
 * 三个以上逐一递增的整数用逗号连着时只留首尾（正文里这样连写的通常就是引用）。
 */
export function collapseCiteRuns(s: string): string {
  // 逗号两边都有空格（xref 元素边界插的），千分位数字（1,092,385）不会被当成编号
  return s.replace(/(?<![\d.,])\d{1,3}(?:\s+,\s+\d{1,3}){2,}(?![\d.])/g, run => {
    const parts = run.split(/\s+,\s+/)
    const ns = parts.map(Number)
    const out: string[] = []
    for (let i = 0; i < ns.length;) {
      let j = i
      while (j + 1 < ns.length && ns[j + 1] === ns[j]! + 1) j++
      out.push(j - i >= 2 ? `${parts[i]} – ${parts[j]}` : parts.slice(i, j + 1).join(' , '))
      i = j + 1
    }
    return out.join(' , ')
  })
}

/** 原文中「应当出现在转换结果里」的部分 */
export interface SourceSnapshot {
  text: string
  refText: string
  tables: string[][][]
  headings: string[]
  /** 结构比对用：论文标题、各章节标题的嵌套深度、原文所有 <title>（含摘要小标题、致谢、文献表）、图注、较长段落 */
  title: string
  headingDepths: Map<string, number>
  allTitles: Set<string>
  figCaptions: string[]
  paragraphs: string[]
  formulas: number
}

/**
 * printed：按 PDF 上的印法比（默认）。压缩成一行的多行表（splitBreakRows）展开；
 * Word 路径的文件由 JATS 直接生成、保留了这种压缩，比 Word 时传 false。
 */
export function sourceSnapshot(xml: string, opts: { printed?: boolean } = {}): SourceSnapshot {
  const printed = opts.printed ?? true
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as El
  const article = each(doc.getElementsByTagName('article'))[0] ?? doc
  // 文献表与公式的文字单独留着：转换结果里多出的数字若来自它们，属于正常
  // 段落里嵌着列表、公式、表格等块级内容的：转换后本来就会拆成几块，不参加「段落完整」比对（要在删除公式之前记下）
  const nestedBlock = new Set<El>()
  for (const name of ['list', 'def-list', 'table-wrap', 'fig', 'disp-formula', 'disp-quote', 'boxed-text']) {
    for (const e of each(article.getElementsByTagName(name))) for (let p = e.parentNode as El | null; p; p = p.parentNode as El | null) if (p.nodeName === 'p') nestedBlock.add(p)
  }
  const formulas = each(article.getElementsByTagName('disp-formula')).filter(f => !hasAncestor(f, ['sub-article', 'response'])).length
  const refText = [...each(article.getElementsByTagName('ref-list')), ...each(article.getElementsByTagName('inline-formula')),
    ...each(article.getElementsByTagName('disp-formula'))].map(spacedText).join(' ')
  // 不属于稿件内容、不比对的部分：
  // - 附带的审稿意见与作者回复（sub-article / response）
  // - 文献表、出版说明、脚注组、段内脚注
  // - 公式（转换器取 TeX 写法，与原文 MathML 文字不同）、图形、无障碍描述
  // - 表格 / 图的对象编号（DOI）、版权与来源声明
  for (const name of ['sub-article', 'response', 'ref-list', 'notes', 'fn-group', 'inline-formula', 'disp-formula',
    'graphic', 'inline-graphic', 'media', 'alt-text', 'long-desc', 'object-id', 'permissions', 'attrib',
    // 基金机构的注册号（FundRef 10.13039/501100000265）：只在元数据里，PDF 上不印
    'institution-id']) {
    remove(each(article.getElementsByTagName(name)))
  }
  remove(each(article.getElementsByTagName('fn')).filter(f => f.parentNode?.nodeName === 'p'))


  const meta = each(article.getElementsByTagName('article-meta'))[0]
  const parts: string[] = []
  if (meta) {
    parts.push(spacedText(each(meta.getElementsByTagName('article-title'))[0] ?? ({ nodeType: 3, textContent: '' } as El)))
    for (const abs of abstractsOf(meta)) parts.push(spacedText(abs))
  }
  for (const name of ['body', 'back', 'floats-group']) for (const el of each(article.getElementsByTagName(name))) parts.push(spacedText(el))

  const tables = [...each(article.getElementsByTagName('table-wrap'))].map(tw => {
    const table = each(tw.getElementsByTagName('table'))[0]
    if (!table) return []
    // 与平台相同的展开规则：只记起点单元格，合并区域留空
    const rows = each(table.getElementsByTagName('tr'))
    const grid: string[][] = []
    const taken: boolean[][] = []
    let r = 0
    rows.forEach((tr, ri) => {
      const cells = elements(tr).filter(x => x.nodeName === 'td' || x.nodeName === 'th')
      const split = !printed || taken[r]?.some(Boolean) ? null : splitBreakRows(cells)
      if (split) {
        for (const line of split) { grid[r] = line.map(tokens); taken[r] = line.map(() => true); r++ }
        return
      }
      grid[r] ??= []; taken[r] ??= []
      let c = 0
      for (const cell of cells) {
        while (taken[r]![c]) c++
        const cs = Math.max(1, Number(cell.getAttribute('colspan')) || 1)
        const rs = Math.max(1, Math.min(rows.length - ri, Number(cell.getAttribute('rowspan')) || 1))
        for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) {
          grid[r + dr] ??= []; taken[r + dr] ??= []
          taken[r + dr]![c + dc] = true
          grid[r + dr]![c + dc] = dr === 0 && dc === 0 ? tokens(spacedText(cell)) : '\u0000'
        }
        c += cs
      }
      r++
    })
    const width = Math.max(0, ...grid.map(r => r.length))
    return grid.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''))
  })

  const headings: string[] = []
  const headingDepths = new Map<string, number>()
  for (const sec of each(article.getElementsByTagName('sec'))) {
    if (sec.parentNode?.nodeName === 'abstract') continue
    const title = child(sec, 'title')
    if (!title) continue
    const label = child(sec, 'label')
    const h = tokens(`${label ? spacedText(label) : ''} ${spacedText(title)}`)
    headings.push(h)
    if (!headingDepths.has(h)) headingDepths.set(h, depthOf(sec))
  }

  const titleEl = meta ? each(meta.getElementsByTagName('article-title'))[0] : undefined
  // 原文以元素表示、没有 <title> 的通用部分（摘要、文献表、致谢）
  const allTitles = new Set<string>(['abstract', 'references', 'bibliography', 'acknowledgements', 'acknowledgments', 'acknowledgement', 'acknowledgment'])
  for (const t of [...each(article.getElementsByTagName('title')), ...each(article.getElementsByTagName('article-title'))]) {
    const label = t.parentNode ? child(t.parentNode as El, 'label') : undefined
    allTitles.add(tokens(spacedText(t)))
    if (label) allTitles.add(tokens(`${spacedText(label)} ${spacedText(t)}`))
  }
  const figCaptions = each(article.getElementsByTagName('fig')).map(f => {
    const cap = child(f, 'caption')
    return cap ? wordSeq(spacedText(cap)) : ''
  })
  const paragraphs = each(article.getElementsByTagName('p'))
    .filter(p => !nestedBlock.has(p) && !hasAncestor(p, ['table-wrap', 'fig', 'caption', 'list', 'abstract', 'trans-abstract', 'boxed-text', 'disp-quote', 'supplementary-material', 'ack', 'back']))
    .map(p => wordSeq(spacedText(p)))
    .filter(s => s.trim().split(' ').length >= 25)
  return { text: collapseCiteRuns(parts.join(' ')), refText, tables, headings, title: titleEl ? tokens(spacedText(titleEl)) : '', headingDepths, allTitles, figCaptions, paragraphs, formulas }
}

/** 文本块的文字，上下标两边插空格（与原文侧 spacedText 对 <sup>/<sub> 的处理一致：10⁹ 不算成 109） */
function spacedNodeText(n: PMNode): string {
  if (n.isText) return n.marks.some(m => m.type.name === 'sup' || m.type.name === 'sub') ? ` ${n.text} ` : n.text ?? ''
  // 行内原子（Word 域代码、脚注引用等）的文字由节点自己给出
  if (n.isLeaf) return n.textContent
  let s = ''
  n.forEach(c => { s += spacedNodeText(c) })
  return s
}

function docText(doc: PMNode, skipRefLabels = false): string {
  const out: string[] = []
  doc.descendants(n => {
    // 待采纳删除的修订块不算正文（导入的 Word 修订里被删掉的原文）
    if (n.attrs?.suggest === 'delete') return false
    // 图注存在图块的 caption 属性里，算正文
    if (n.type.name === 'figure') { out.push(' ', String(n.attrs.caption ?? '')); return false }
    if (n.isTextblock) {
      // 文献条目开头的「[n]」：原文没有编号时由转换器按顺序补上，不算多出的数字；标题带上 Word 自动编号
      const t = `${n.attrs?.number ? `${n.attrs.number} ` : ''}${spacedNodeText(n)}`
      out.push(' ', skipRefLabels ? t.replace(/^\[[^\]\s]{1,8}\]\s/, '') : t)
      return false
    }
    return true
  })
  return out.join('')
}

function docTables(doc: PMNode): string[][][] {
  const out: string[][][] = []
  doc.descendants(n => {
    if (n.type.name !== 'table') return true
    const g = readGrid(n)
    out.push(Array.from({ length: g.height }, (_, r) => Array.from({ length: g.width }, (_, c) => {
      const cell = g.at(r, c)
      if (!cell) return ''
      return cell.top === r && cell.left === c ? tokens(spacedNodeText(cell.node)) : '\u0000'
    })))
    return false
  })
  return out
}

const multiset = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())

export function checkFidelity(xml: string, markdown: string): FidelityReport {
  const docs = new Documents(new Store(':memory:'))
  const row = docs.create({ owner: 'check', title: 'check', markdown })
  return checkFidelityDoc(xml, docs.get(row.id))
}

/** 直接检查平台文档（如产品 PDF / Word 导入的结果） */
export function checkFidelityDoc(xml: string, doc: PMNode, opts: { printed?: boolean } = {}): FidelityReport {
  const src = sourceSnapshot(xml, opts)
  const text = docText(doc)

  // 1. 数字（按出现次数）
  const have = multiset(numbers(text))
  const srcNums = multiset(numbers(src.text))
  const missingNumbers = [...srcNums]
    .map(([token, n]) => ({ token, missing: n - (have.get(token) ?? 0) }))
    .filter(x => x.missing > 0)
  // 多出的数字：转换结果里比原文（含文献表与公式）多出现的次数，例如相邻引用粘连「12」「42」→「1242」
  const refNums = multiset(numbers(src.refText))
  const extraNumbers = [...multiset(numbers(docText(doc, true)))]
    .map(([token, n]) => ({ token, extra: n - (srcNums.get(token) ?? 0) - (refNums.get(token) ?? 0) }))
    .filter(x => x.extra > 0)

  // 2. 文字
  const haveW = multiset(words(text))
  const srcW = words(src.text)
  let missW = 0
  const sample = new Set<string>()
  for (const [w, n] of multiset(srcW)) {
    const m = n - (haveW.get(w) ?? 0)
    if (m > 0) { missW += m; if (sample.size < 12) sample.add(w) }
  }

  // 3. 表格：按内容找最相近的一张，再比行列与逐格内容
  const conv = docTables(doc)
  const used = new Set<number>()
  const mismatched: FidelityReport['tables']['mismatched'] = []
  const detail: FidelityReport['tables']['detail'] = []
  src.tables.forEach((sg, i) => {
    const flat = sg.flat().join(' ')
    let best = -1, bestScore = 0
    conv.forEach((cg, j) => {
      if (used.has(j)) return
      const cf = cg.flat().join(' ')
      const score = cf === flat ? Infinity : [...new Set(flat.split(' '))].filter(t => t && cf.includes(t)).length
      if (score > bestScore) { bestScore = score; best = j }
    })
    const name = `第 ${i + 1} 张表`
    if (best < 0) { mismatched.push({ table: name, problem: '转换结果中找不到' }); detail.push({ found: false, dimsOk: false, cellExact: 0, cellRecall: 0, spanCells: 0, spanHit: 0, spanExtra: 0 }); return }
    used.add(best)
    const cg = conv[best]!
    const srcCells = sg.flatMap((r, ri) => r.map((cell, ci) => ({ cell, ri, ci }))).filter(x => x.cell && x.cell !== '\u0000')
    const convCells = new Set(cg.flat())
    const exact = srcCells.filter(x => cg[x.ri]?.[x.ci] === x.cell).length
    const recall = srcCells.filter(x => convCells.has(x.cell)).length
    const dimsOk = sg.length === cg.length && (sg[0]?.length ?? 0) === (cg[0]?.length ?? 0)
    let spanCells = 0, spanHit = 0, spanExtra = 0
    if (dimsOk) sg.forEach((r, ri) => r.forEach((cell, ci) => {
      const got = cg[ri]![ci]
      if (cell === '\u0000') { spanCells++; if (got === '\u0000') spanHit++ } else if (got === '\u0000') spanExtra++
    }))
    detail.push({ found: true, dimsOk, cellExact: srcCells.length ? exact / srcCells.length : 1, cellRecall: srcCells.length ? recall / srcCells.length : 1, spanCells, spanHit, spanExtra })
    if (!dimsOk) {
      mismatched.push({ table: name, problem: `行列 ${sg.length}×${sg[0]?.length ?? 0} → ${cg.length}×${cg[0]?.length ?? 0}` })
      return
    }
    const bad: string[] = []
    sg.forEach((r, ri) => r.forEach((cell, ci) => {
      const got = cg[ri]![ci]!
      // 平台在合并失败退回不合并写法时，合并区为空格：视为一致
      if (cell !== got && !(cell === '\u0000' && got === '')) bad.push(`(${ri + 1},${ci + 1}) 「${cell.slice(0, 30)}」→「${got.slice(0, 30)}」`)
    }))
    if (bad.length) mismatched.push({ table: name, problem: `${bad.length} 格不一致：${bad.slice(0, 3).join('；')}` })
  })

  // 4. 章节标题
  const convHeadings: string[] = []
  doc.descendants(n => {
    if (n.type.name === 'heading' && n.attrs.suggest !== 'delete') convHeadings.push(tokens(`${n.attrs.number ?? ''} ${n.textContent}`))
    return !n.isTextblock
  })
  const missingHeadings = src.headings.filter(h => h && !convHeadings.includes(h))

  // 6. 结构
  const levels: Array<{ h: string; level: number }> = []
  const blocksSeq: string[] = []
  let figImages = 0, figUncaptioned = 0, formulaConverted = 0
  const figCaps: string[] = []
  doc.descendants(n => {
    if (n.attrs?.suggest === 'delete') return false
    if (n.type.name === 'paragraph' && n.attrs.style === 'Code' && n.textContent.startsWith('$$')) formulaConverted++
    if (n.type.name === 'figure') {
      figImages++
      const cap = String(n.attrs.caption ?? '').trim()
      if (!cap) figUncaptioned++
      figCaps.push(wordSeq(cap)); blocksSeq.push(wordSeq(cap))
      return false
    }
    if (n.type.name === 'heading') levels.push({ h: tokens(`${n.attrs.number ?? ''} ${n.textContent}`), level: n.attrs.level })
    if (n.isTextblock) { blocksSeq.push(wordSeq(n.textContent)); return false }
    return true
  })
  // 原文斜体等标签会把一个词拆开（「<italic>Lacto</italic>bacillus」），比较时去掉空格
  const squash = (s: string) => s.replace(/ /g, '')
  const titleOk = !!src.title && squash(levels[0]?.h ?? '') === squash(src.title)
  const known = new Set([...src.headingDepths.keys(), ...src.allTitles].map(squash))
  const headingsExtra = levels.map(x => x.h).filter((h, i) => h && !(i === 0 && titleOk) && !known.has(squash(h)) && !BACK_MATTER.test(h))
  // 层级：对上的标题里，「文档层级 − 原文嵌套深度」取众数作为整体偏移，偏离众数的算层级不对
  const pairs = levels.filter(x => src.headingDepths.has(x.h)).map(x => x.level - src.headingDepths.get(x.h)!)
  const counts = multiset(pairs.map(String))
  const mode = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  const headingLevelWrong = mode === undefined ? 0 : pairs.filter(p => String(p) !== mode).length
  const head = (s: string, k: number) => ` ${s.trim().split(' ').slice(0, k).join(' ')} `
  const tail = (s: string, k: number) => ` ${s.trim().split(' ').slice(-k).join(' ')} `
  const figCaptioned = src.figCaptions.filter(c => c.trim() && figCaps.some(fc => fc.includes(head(c, 6)))).length
  const blocksSq = blocksSeq.map(squash)
  const paraBroken = src.paragraphs.filter(p => { const h = squash(head(p, 5)), t = squash(tail(p, 5)); return !blocksSq.some(b => b.includes(h) && b.includes(t)) }).length
  const structure = {
    titleOk, figSource: src.figCaptions.length, figCaptioned, figImages, figUncaptioned,
    headingsExtra, headingLevelWrong, paraTotal: src.paragraphs.length, paraBroken,
    formulaSource: src.formulas, formulaConverted,
  }

  // 5. 转义残留
  const escapeResidue = (text.match(/\\[\\`*_#>|^<\-+.()[\]]/g) ?? []).filter(e => !src.text.includes(e)).slice(0, 10)

  const ok = missingNumbers.length === 0 && extraNumbers.length === 0 && mismatched.length === 0 && missingHeadings.length === 0 && escapeResidue.length === 0
    && (srcW.length === 0 || missW / srcW.length < 0.005)
  return {
    missingNumbers,
    extraNumbers,
    numberCount: numbers(src.text).length,
    wordCount: srcW.length,
    missingWordRatio: srcW.length ? missW / srcW.length : 0,
    missingWordsSample: [...sample],
    tables: { source: src.tables.length, converted: conv.length, mismatched, detail },
    missingHeadings,
    escapeResidue,
    structure,
    ok,
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { MD_DIR, XML_DIR, readManifest } = await import('./eval-review-paths.ts')
  let bad = 0
  for (const p of readManifest()) {
    const xmlFile = join(XML_DIR, `${p.id}.xml`), mdFile = join(MD_DIR, `${p.id}.md`)
    if (!existsSync(xmlFile) || !existsSync(mdFile)) { console.log(`- ${p.id} 未转换`); continue }
    const r = checkFidelity(readFileSync(xmlFile, 'utf8'), readFileSync(mdFile, 'utf8'))
    if (!r.ok) bad++
    const parts = [
      `数字 ${r.numberCount} 个，缺 ${r.missingNumbers.reduce((a, x) => a + x.missing, 0)}${r.missingNumbers.length ? `（${r.missingNumbers.slice(0, 6).map(x => `${x.token}×${x.missing}`).join(' ')}）` : ''}`
        + `，多 ${r.extraNumbers.reduce((a, x) => a + x.extra, 0)}${r.extraNumbers.length ? `（${r.extraNumbers.slice(0, 6).map(x => `${x.token}×${x.extra}`).join(' ')}）` : ''}`,
      `文字缺 ${(r.missingWordRatio * 100).toFixed(2)}%${r.missingWordsSample.length && r.missingWordRatio >= 0.005 ? `（${r.missingWordsSample.slice(0, 6).join(' ')}）` : ''}`,
      `表格 ${r.tables.source}→${r.tables.converted}${r.tables.mismatched.length ? `，不一致：${r.tables.mismatched.map(m => `${m.table} ${m.problem}`).join('；')}` : ''}`,
      ...(r.missingHeadings.length ? [`缺标题 ${r.missingHeadings.length}：${r.missingHeadings.slice(0, 3).join(' | ')}`] : []),
      ...(r.escapeResidue.length ? [`转义残留：${r.escapeResidue.join(' ')}`] : []),
    ]
    console.log(`${r.ok ? '✓' : '✗'} ${p.id} · ${parts.join(' · ')}`)
  }
  if (bad) process.exitCode = 1
}
