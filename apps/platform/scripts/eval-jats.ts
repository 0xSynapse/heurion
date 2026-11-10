/**
 * 深度审稿评测：把 PubMed Central 的 JATS 全文 XML 转成平台 markdown，尽量贴近用户上传 Word 稿件后的样子：
 * - 引用保留原文写法（上标引用补成「[n]」），文末是普通的「References」文献表，不转成平台引用节点；
 * - 结构化摘要写成「Background: …」段落，不拆成单独标题（否则会多出被当成引言的章节）；
 * - 表格保留合并单元格（平台方言：`^` 与上方合并、`<` 与左侧合并），表题段落放在表前、表注放在表后；
 * - 非引用上标写成「^」（10^9/L），避免与前面的数字粘成另一个数。
 * 只用于评测语料，不是产品导入入口。
 */
import { DOMParser } from '@xmldom/xmldom'
import { parseBlocks } from '../src/model/markdown.ts'

/** xmldom 节点里用到的部分（转换器与保真度检查共用） */
export type El = {
  nodeType: number
  nodeName: string
  childNodes: ArrayLike<El>
  textContent: string | null
  parentNode: El | null
  previousSibling: El | null
  nextSibling: El | null
  getAttribute(n: string): string | null
  getElementsByTagName(n: string): ArrayLike<El>
  removeChild(c: El): void
}

export interface JatsStats {
  sections: number
  paragraphs: number
  tables: number
  /** 合并单元格解析失败、退回不合并写法的表格数 */
  tablesFlattened: number
  figures: number
  citations: number
  references: number
  formulas: number
  /** 未识别、按纯文字处理的元素名（去重计数） */
  unknown: Record<string, number>
}

export interface JatsDoc {
  title: string
  markdown: string
  stats: JatsStats
}

const each = (list: ArrayLike<El> | undefined | null): El[] => (list ? Array.from({ length: list.length }, (_, i) => list[i]!) : [])
const elements = (n: El): El[] => each(n.childNodes).filter(c => c.nodeType === 1)
const child = (n: El, name: string): El | undefined => elements(n).find(c => c.nodeName === name)
const children = (n: El, name: string): El[] => elements(n).filter(c => c.nodeName === name)
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 行内 markdown 转义：强调、代码、反斜杠（表格单元格内同时转义竖线）；段首的块级标记另行处理 */
const escapeInline = (s: string, inCell = false) => s.replace(inCell ? /([\\`*_\|])/g : /([\\`*_])/g, '\\$1')
/** 段首会被当成标题、列表、引用块、表格的写法前面加反斜杠 */
const escapeBlockStart = (s: string) => s.replace(/^(\s*)(#{1,6}\s|[-+*]\s|\d+[.)]\s|>|\|)/, '$1\\$2')

const INLINE_PASSTHROUGH = new Set([
  'italic', 'bold', 'underline', 'sc', 'monospace', 'roman', 'sans-serif', 'named-content', 'styled-content',
  'ext-link', 'uri', 'email', 'abbrev', 'def', 'term', 'span', 'chem-struct', 'overline', 'strike', 'sub',
  'inline-supplementary-material', 'related-article', 'funding-source', 'award-id', 'institution', 'x',
])
const BLOCK_INSIDE_P = new Set(['table-wrap', 'fig', 'disp-formula', 'list', 'boxed-text', 'disp-quote', 'table-wrap-group', 'fig-group', 'def-list', 'supplementary-material'])

export function jatsToMarkdown(xml: string): JatsDoc {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as El
  const article = each(doc.getElementsByTagName('article'))[0] ?? doc
  const stats: JatsStats = { sections: 0, paragraphs: 0, tables: 0, tablesFlattened: 0, figures: 0, citations: 0, references: 0, formulas: 0, unknown: {} }
  const blocks: string[] = []
  const unknown = (name: string) => { stats.unknown[name] = (stats.unknown[name] ?? 0) + 1 }

  // —— 行内 ——
  const inline = (n: El, inCell = false): string => {
    if (n.nodeType === 3 || n.nodeType === 4) return escapeInline(n.textContent ?? '', inCell)
    if (n.nodeType !== 1) return ''
    const name = n.nodeName
    if (name === 'xref') {
      const t = squash(n.textContent ?? '')
      if (n.getAttribute('ref-type') !== 'bibr') return escapeInline(t, inCell)
      stats.citations++
      // 纯数字引用前后都没有括号或分隔符：原文是靠样式显示的上标，补成「[n]」；原文自带括号的保持原样
      const before = n.previousSibling?.nodeType === 3 ? (n.previousSibling.textContent ?? '') : ''
      const after = n.nextSibling?.nodeType === 3 ? (n.nextSibling.textContent ?? '') : ''
      // 紧挨着前一个引用、中间没有任何字符（网页靠样式显示成「12, 42」）：补分隔符，否则会粘成另一个数
      const prev = n.previousSibling
      const glued = prev?.nodeType === 1 && prev.nodeName === 'xref' && prev.getAttribute('ref-type') === 'bibr'
      const bare = !glued && /^\d+(?:\s*[–-]\s*\d+)?$/.test(t) && !/[[(,，;–-]\s*$/.test(before) && !/^\s*[\]),，;–-]/.test(after)
      return `${glued ? ', ' : ''}${bare ? `[${escapeInline(t, inCell)}]` : escapeInline(t, inCell)}`
    }
    if (name === 'sup') {
      const kids = elements(n)
      // 只含引用的上标（Vancouver 上标写法）：整组补一对方括号，「1,2」→「[1,2]」
      if (kids.length > 0 && kids.every(c => c.nodeName === 'xref' && c.getAttribute('ref-type') === 'bibr')) {
        stats.citations += kids.length
        const t = squash(each(n.childNodes).map(c => escapeInline(c.textContent ?? '', inCell)).join(''))
        return /^\[.*\]$/.test(t) ? t : `[${t.replace(/^[[(]|[\])]$/g, '')}]`
      }
      const t = each(n.childNodes).map(c => inline(c, inCell)).join('')
      if (!t.trim()) return ''
      // 脚注标记后面紧跟单词（「^cAverage」）时补空格，不让标记和单词粘成一个词
      const next = n.nextSibling?.nodeType === 3 ? (n.nextSibling.textContent ?? '') : ''
      return /^\p{L}/u.test(next) && /\p{L}$/u.test(t) ? `^${t} ` : `^${t}`
    }
    if (name === 'inline-formula') { stats.formulas++; return formulaText(n, inCell) }
    if (name === 'break') return ' '
    if (name === 'fn' || name === 'target') return ''
    if (name === 'inline-graphic' || name === 'graphic' || name === 'media') return ''
    if (name === 'alternatives') {
      const pick = child(n, 'tex-math') ?? child(n, 'mml:math') ?? elements(n)[0]
      return pick ? escapeInline(squash(pick.textContent ?? ''), inCell) : ''
    }
    if (!INLINE_PASSTHROUGH.has(name)) unknown(name)
    return each(n.childNodes).map(c => inline(c, inCell)).join('')
  }

  const formulaText = (n: El, inCell = false): string => {
    const tex = each(n.getElementsByTagName('tex-math'))[0]
    if (tex) return escapeInline(squash((tex.textContent ?? '').replace(/\\documentclass[\s\S]*?\\begin\{document\}|\\end\{document\}/g, '')), inCell)
    return escapeInline(squash(n.textContent ?? ''), inCell)
  }

  const inlineText = (n: El | undefined) => (n ? squash(each(n.childNodes).map(c => inline(c)).join('')) : '')

  const pushPara = (text: string) => {
    const t = squash(text)
    if (!t) return
    blocks.push(escapeBlockStart(t))
    stats.paragraphs++
  }

  // —— 浮动体：有的版本（如 Europe PMC）把表格和图集中放在正文外的 floats-group ——
  // 放到正文里第一次引用它的段落之后；从未被引用的放在正文末尾
  const floats = new Map<string, El>()
  const floatsGroup = each(article.getElementsByTagName('floats-group'))[0]
  if (floatsGroup) {
    for (const f of elements(floatsGroup)) {
      const id = f.getAttribute('id')
      if (id) floats.set(id, f)
      else for (const inner of elements(f)) { const iid = inner.getAttribute('id'); if (iid) floats.set(iid, inner) }
    }
  }
  const placed = new Set<El>()
  const placeFloatsCitedIn = (n: El) => {
    for (const x of each(n.getElementsByTagName('xref'))) {
      for (const rid of (x.getAttribute('rid') ?? '').split(/\s+/)) {
        const f = floats.get(rid)
        if (f && !placed.has(f)) { placed.add(f); block(f, 0) }
      }
    }
  }

  // —— 块级 ——
  const paragraph = (p: El) => {
    // 段内嵌套的表格 / 图 / 列表拆成独立块，前后文字各成一段
    let buf = ''
    for (const c of each(p.childNodes)) {
      if (c.nodeType === 1 && BLOCK_INSIDE_P.has(c.nodeName)) {
        pushPara(buf)
        buf = ''
        block(c, 0)
      } else buf += inline(c)
    }
    pushPara(buf)
    placeFloatsCitedIn(p)
  }

  const caption = (n: El, fallbackLabel: string): string => {
    const label = inlineText(child(n, 'label'))
    const cap = child(n, 'caption')
    const capTitle = cap ? inlineText(child(cap, 'title')) : ''
    const capParas = cap ? children(cap, 'p').map(inlineText).filter(Boolean).join(' ') : ''
    const head = label || fallbackLabel
    const body = [capTitle, capParas].filter(Boolean).join(' ')
    return squash(`${head}${head && !/[.:：]$/.test(head) ? '.' : ''} ${body}`)
  }

  const tableWrap = (tw: El) => {
    stats.tables++
    pushPara(caption(tw, `Table ${stats.tables}`))
    const table = each(tw.getElementsByTagName('table'))[0]
    if (table) blocks.push(tableMarkdown(table))
    const foot = child(tw, 'table-wrap-foot')
    if (foot) footnotes(foot)
  }

  /** 表注：每条脚注一段，保留脚注标记（*、a）与全部段落；也认表注里直接写的段落 */
  const footnotes = (foot: El) => {
    for (const c of elements(foot)) {
      if (c.nodeName === 'fn') {
        const label = inlineText(child(c, 'label'))
        const paras = elements(c).filter(x => x.nodeName === 'p')
        const text = paras.length ? paras.map(inlineText).join(' ') : inlineText(c)
        pushPara(label ? `${label} ${text}` : text)
      } else if (c.nodeName === 'fn-group') footnotes(c)
      else if (c.nodeName === 'p') pushPara(inlineText(c))
      else if (c.nodeName !== 'title' && c.nodeName !== 'attrib' && c.nodeName !== 'permissions') pushPara(inlineText(c))
    }
  }

  const tableMarkdown = (table: El): string => {
    type Slot = string | '^' | '<'
    const rows = each(table.getElementsByTagName('tr'))
    const grid: Slot[][] = []
    const taken: boolean[][] = []
    rows.forEach((tr, r) => {
      grid[r] ??= []
      taken[r] ??= []
      let c = 0
      for (const cell of elements(tr).filter(x => x.nodeName === 'td' || x.nodeName === 'th')) {
        while (taken[r]![c]) c++
        const colspan = Math.max(1, Number(cell.getAttribute('colspan')) || 1)
        const rowspan = Math.max(1, Math.min(rows.length - r, Number(cell.getAttribute('rowspan')) || 1))
        for (let dr = 0; dr < rowspan; dr++) {
          grid[r + dr] ??= []
          taken[r + dr] ??= []
          for (let dc = 0; dc < colspan; dc++) {
            taken[r + dr]![c + dc] = true
            grid[r + dr]![c + dc] = dr === 0 && dc === 0 ? cellText(cell) : dc > 0 ? '<' : '^'
          }
        }
        c += colspan
      }
    })
    const width = Math.max(1, ...grid.map(r => r.length))
    const full = grid.map(r => Array.from({ length: width }, (_, i) => r[i] ?? ''))
    const render = (g: Slot[][]) => {
      const line = (cells: Slot[]) => `| ${cells.join(' | ')} |`
      return [line(g[0]!), line(Array.from({ length: width }, () => '---')), ...g.slice(1).map(line)].join('\n')
    }
    const md = render(full)
    try {
      parseBlocks(md)
      return md
    } catch {
      // 合并结构不规整（JATS 里偶有 rowspan 越界或重叠）：退回不合并写法
      stats.tablesFlattened++
      return render(full.map(r => r.map(s => (s === '^' || s === '<' ? '' : s))))
    }
  }

  const cellText = (cell: El): string => {
    const t = squash(each(cell.childNodes).map(c => inline(c, true)).join(' '))
    // 单独的 ^ / < 会被当成合并标记
    return t === '^' || t === '<' ? `\\${t}` : t
  }

  const list = (l: El, depth: number) => {
    const ordered = l.getAttribute('list-type') === 'order'
    children(l, 'list-item').forEach((item, i) => {
      const indent = '  '.repeat(depth)
      const marker = ordered ? `${i + 1}.` : '-'
      const text = elements(item).filter(c => c.nodeName === 'p').map(inlineText).filter(Boolean).join(' ') || inlineText(item)
      if (text) { blocks.push(`${indent}${marker} ${text}`); stats.paragraphs++ }
      for (const sub of children(item, 'list')) list(sub, depth + 1)
    })
  }

  const block = (n: El, level: number) => {
    switch (n.nodeName) {
      case 'sec': section(n, level + 1); break
      case 'p': paragraph(n); break
      case 'table-wrap': tableWrap(n); break
      case 'table-wrap-group': elements(n).forEach(c => block(c, level)); break
      case 'fig': stats.figures++; pushPara(caption(n, `Figure ${stats.figures}`)); break
      case 'fig-group': elements(n).forEach(c => block(c, level)); break
      case 'disp-formula': stats.formulas++; pushPara(formulaText(n)); break
      case 'list': list(n, 0); break
      case 'boxed-text': case 'disp-quote': case 'statement':
        elements(n).forEach(c => block(c, level)); break
      case 'def-list': case 'glossary': glossary(n); break
      // 有的版本（如 Europe PMC）把文献表放在正文末尾的「References」章节里：章节标题已经输出，这里只出条目
      case 'ref-list': refList(n, false); break
      case 'notes': case 'fn-group': break
      case 'title': case 'label': break
      case 'supplementary-material': {
        const t = caption(n, 'Supplementary material')
        if (t) pushPara(t)
        break
      }
      default:
        unknown(n.nodeName)
        if (elements(n).length) elements(n).forEach(c => block(c, level))
        else pushPara(inline(n))
    }
  }

  const section = (sec: El, level: number) => {
    // 章节编号（2.1、3.2.1）在 <label> 里，用户稿件通常带着编号，一并写进标题
    const label = inlineText(child(sec, 'label'))
    const title = squash(`${label} ${inlineText(child(sec, 'title'))}`)
    if (title) {
      blocks.push(`${'#'.repeat(Math.min(6, level + 1))} ${title}`)
      stats.sections++
    }
    for (const c of elements(sec)) if (c.nodeName !== 'title' && c.nodeName !== 'label') block(c, level)
  }

  /** 文献表：「[label] 条目」，与平台识别的导入稿件文献表格式一致；整篇只输出一次 */
  let refsRendered = false
  const refList = (rl: El, withDefaultTitle: boolean) => {
    if (refsRendered) return
    refsRendered = true
    const own = inlineText(child(rl, 'title'))
    if (own || withDefaultTitle) { blocks.push(`## ${own || 'References'}`); stats.sections++ }
    each(rl.getElementsByTagName('ref')).forEach((ref, i) => {
      const label = squash(child(ref, 'label')?.textContent ?? '').replace(/^[[(]|[\])\.]$/g, '') || String(i + 1)
      // 有的出版社把两种写法包在 citation-alternatives 里：优先取自带标点的 mixed-citation
      const holder = child(ref, 'citation-alternatives') ?? ref
      const cit = child(holder, 'mixed-citation') ?? child(holder, 'element-citation') ?? child(holder, 'citation')
      const text = formatCitation(cit ?? ref)
      if (text) { blocks.push(`[${label}] ${escapeInline(text)}`); stats.references++ }
    })
  }

  /** 缩写表：写成「ABBR: 全称」，与审稿草稿板的缩写抽取格式一致 */
  const glossary = (g: El) => {
    const title = inlineText(child(g, 'title'))
    if (title) { blocks.push(`## ${title}`); stats.sections++ }
    for (const item of each(g.getElementsByTagName('def-item'))) {
      const term = inlineText(child(item, 'term'))
      const def = inlineText(child(item, 'def'))
      if (term && def) pushPara(`${term}: ${def}`)
    }
  }

  // —— 标题与摘要 ——
  const meta = each(article.getElementsByTagName('article-meta'))[0]
  const title = meta ? inlineText(each(meta.getElementsByTagName('article-title'))[0]) : ''
  if (title) blocks.push(`# ${title}`)
  // 摘要：除图形摘要 / 导读之类外全部保留（MDPI 有「Simple Summary」与正式摘要两份），按原顺序；
  // 结构化小节写成「Background: …」段落前缀，与小节并列的普通段落也保留
  for (const abstract of abstractsOf(meta)) {
    blocks.push(`## ${inlineText(child(abstract, 'title')) || 'Abstract'}`)
    stats.sections++
    for (const c of elements(abstract)) {
      if (c.nodeName === 'sec') {
        const label = inlineText(child(c, 'title'))
        const text = elements(c).filter(x => x.nodeName === 'p').map(inlineText).join(' ')
        pushPara(label ? `${label}${/[:：]$/.test(label) || !text ? '' : ':'} ${text}` : text)
        // PLoS「作者摘要」等：小节内容是项目符号列表
        for (const l of children(c, 'list')) list(l, 0)
      } else if (c.nodeName === 'p') pushPara(inlineText(c))
      else if (c.nodeName === 'list') list(c, 0)
    }
  }

  // —— 正文 ——
  const body = each(article.getElementsByTagName('body'))[0]
  if (body) for (const c of elements(body)) block(c, 0)
  for (const f of new Set(floats.values())) if (!placed.has(f)) { placed.add(f); block(f, 0) }

  // —— 文末：致谢、声明、缩写、文献表 ——
  const back = each(article.getElementsByTagName('back'))[0]
  if (back) {
    for (const c of elements(back)) {
      if (c.nodeName === 'ref-list' || c.nodeName === 'fn-group' || c.nodeName === 'notes') continue
      if (c.nodeName === 'ack') {
        blocks.push(`## ${inlineText(child(c, 'title')) || 'Acknowledgements'}`)
        stats.sections++
        for (const x of elements(c)) if (x.nodeName !== 'title') block(x, 1)
        continue
      }
      block(c, 0)
    }
    const rl = each(back.getElementsByTagName('ref-list'))[0]
    if (rl) refList(rl, true)
  }

  return { title, markdown: blocks.join('\n\n') + '\n', stats }
}

const IDENTIFIER = new Set(['pub-id', 'ext-link', 'uri', 'comment', 'object-id', 'elocation-id'])

/** 不属于稿件正文内容的摘要类型（图形摘要、目录导读等） */
const NON_MANUSCRIPT_ABSTRACT = /^(graphical|teaser|toc|editor-summary|web-summary|precis)$/i

/** 稿件里的摘要（转换器与保真度检查共用同一范围定义） */
export function abstractsOf(meta: El | undefined): El[] {
  return meta ? elements(meta).filter(c => c.nodeName === 'abstract' && !NON_MANUSCRIPT_ABSTRACT.test(c.getAttribute('abstract-type') ?? '')) : []
}

/** 文献条目：mixed-citation 自带标点，直接取文字；element-citation 按「作者. 标题. 刊名. 年;卷:页. doi」拼 */
function formatCitation(cit: El): string {
  if (cit.nodeName !== 'element-citation') {
    // 两个子元素紧挨着、中间没有任何文字时补一个空格（否则 PMID、DOI、页码会粘成一串数字）；原文自带的标点保持不变
    const walk = (n: El): string => {
      if (n.nodeType === 3 || n.nodeType === 4) return n.textContent ?? ''
      if (n.nodeType !== 1 || n.nodeName === 'label') return ''
      let s = ''
      let prevEl = false
      for (const c of each(n.childNodes)) {
        if (c.nodeType === 1) {
          // PMID / DOI / 链接原本单独显示：前面没有空白时补一个，避免「195.」+「10.1016…」拼成假小数 195.10
          if (prevEl || (IDENTIFIER.has(c.nodeName) && s && !/\s$/.test(s))) s += ' '
          s += walk(c)
          prevEl = c.nodeName !== 'label'
        }
        else { s += walk(c); prevEl = false }
      }
      return s
    }
    return squash(walk(cit))
  }
  const pick = (name: string) => squash(each(cit.getElementsByTagName(name))[0]?.textContent ?? '')
  const names = each(cit.getElementsByTagName('name')).map(n => {
    const sur = squash(each(n.getElementsByTagName('surname'))[0]?.textContent ?? '')
    const given = squash(each(n.getElementsByTagName('given-names'))[0]?.textContent ?? '')
    return [sur, given].filter(Boolean).join(' ')
  })
  const authors = names.length > 6 ? `${names.slice(0, 6).join(', ')}, et al` : names.join(', ')
  const doi = each(cit.getElementsByTagName('pub-id')).find(p => p.getAttribute('pub-id-type') === 'doi')
  const vol = pick('volume')
  const pages = [pick('fpage'), pick('lpage')].filter(Boolean).join('–')
  const tail = `${pick('year')}${vol ? `;${vol}` : ''}${pages ? `:${pages}` : ''}`
  return squash([authors, pick('article-title') || pick('chapter-title'), pick('source'), tail, doi ? `doi:${squash(doi.textContent ?? '')}` : '']
    .filter(Boolean).map(s => (/[.?!]$/.test(s) ? s : `${s}.`)).join(' '))
}
