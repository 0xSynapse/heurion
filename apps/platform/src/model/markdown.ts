import MarkdownIt, { type StateInline, type Token } from 'markdown-it'
import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model'
import { schema } from './schema.ts'

/**
 * 平台的 markdown 方言（PLATFORM.md §6.1）：CommonMark + GFM 表格 + 引用 `[@c:<cite_id>]`
 * + 读视图里的块 id 前缀 `{#id}`（写入时忽略）+ 资产图 `![alt](asset:<id> "图注")`
 * + 行内 `<sup> <sub> <u> <br>`。样式（标题级别以外）不进 markdown，由专用 op 修改。
 */

const ID_PREFIX_LINE = /^(\s*)\{#[a-z][a-z0-9]{2,15}\}[ \t]?/gm
const ID_PREFIX_INLINE = /^\{#[a-z][a-z0-9]{2,15}\}[ \t]?/
const CITATION = /^\[@c:([a-z0-9]{3,32})\]/

function citationRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x5b /* [ */) return false
  const m = CITATION.exec(state.src.slice(state.pos))
  if (!m) return false
  if (!silent) {
    const token = state.push('citation', '', 0)
    token.meta = { cite_id: m[1] }
  }
  state.pos += m[0].length
  return true
}

function idPrefixRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x7b /* { */) return false
  const m = ID_PREFIX_INLINE.exec(state.src.slice(state.pos))
  if (!m) return false
  if (!silent) { /* 丢弃：id 由平台管理 */ }
  state.pos += m[0].length
  return true
}

const md = new MarkdownIt('commonmark', { html: true }).enable('table')
md.inline.ruler.before('link', 'citation', citationRule)
// markdown-it 的 text 规则本身在 `{` `[` 处停下，上面两条规则能接管
md.inline.ruler.before('text', 'id_prefix', idPrefixRule)

export class MarkdownError extends Error {}

// —— 解析：markdown → 块节点 ——

/** 解析为块节点列表（无 id；调用方负责分配）。 */
export function parseBlocks(source: string): PMNode[] {
  const tokens = md.parse(source.replace(ID_PREFIX_LINE, '$1'), {})
  const [nodes] = buildBlocks(tokens, 0, null)
  return nodes
}

/** 解析为行内内容（replace_text 的替换文本、表格单元格）。 */
export function parseInline(source: string): PMNode[] {
  const blocks = parseBlocks(source)
  if (blocks.length === 0) return []
  if (blocks.length > 1 || !blocks[0]!.isTextblock) {
    throw new MarkdownError('这里只接受行内内容（不能包含多个段落、标题、列表或表格）')
  }
  const out: PMNode[] = []
  blocks[0]!.forEach(c => out.push(c))
  return out
}

function buildBlocks(tokens: Token[], start: number, closeType: string | null, ctx: { style?: string } = {}): [PMNode[], number] {
  const out: PMNode[] = []
  let i = start
  while (i < tokens.length) {
    const t = tokens[i]!
    if (closeType && t.type === closeType) return [out, i + 1]
    switch (t.type) {
      case 'paragraph_open': {
        const inline = tokens[i + 1]!
        const content = buildInline(inline.children ?? [])
        const figure = asFigure(inline.children ?? [])
        if (figure) out.push(figure)
        else out.push(schema.node('paragraph', { style: ctx.style ?? null }, content))
        i += 3
        break
      }
      case 'heading_open': {
        const level = Number(t.tag.slice(1))
        out.push(schema.node('heading', { level }, buildInline(tokens[i + 1]!.children ?? [])))
        i += 3
        break
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const closer = t.type.replace('_open', '_close')
        const [items, next] = buildBlocks(tokens, i + 1, closer)
        const listType = t.type === 'bullet_list_open' ? 'bullet_list' : 'ordered_list'
        const attrs = listType === 'ordered_list' ? { start: Number(t.attrGet('start') ?? 1) } : {}
        out.push(schema.node(listType, attrs, items))
        i = next
        break
      }
      case 'list_item_open': {
        const [children, next] = buildBlocks(tokens, i + 1, 'list_item_close')
        if (children.length === 0 || children[0]!.type.name !== 'paragraph') children.unshift(schema.node('paragraph'))
        out.push(schema.node('list_item', null, children))
        i = next
        break
      }
      case 'blockquote_open': {
        const [children, next] = buildBlocks(tokens, i + 1, 'blockquote_close', { style: 'Quote' })
        out.push(...children)
        i = next
        break
      }
      case 'fence':
      case 'code_block': {
        const lines = t.content.replace(/\n$/, '').split('\n')
        const content: PMNode[] = []
        lines.forEach((line, idx) => {
          if (idx > 0) content.push(schema.node('hard_break'))
          if (line) content.push(schema.text(line))
        })
        out.push(schema.node('paragraph', { style: 'Code' }, content))
        i++
        break
      }
      case 'html_block': {
        const text = t.content.replace(/<[^>]+>/g, '').trim()
        if (text) out.push(schema.node('paragraph', null, schema.text(text)))
        i++
        break
      }
      case 'table_open': {
        const [table, next] = buildTable(tokens, i + 1)
        out.push(table)
        i = next
        break
      }
      default:
        i++ // hr 等：忽略
    }
  }
  if (closeType) throw new MarkdownError(`markdown 结构不完整（缺少 ${closeType}）`)
  return [out, i]
}

function buildTable(tokens: Token[], start: number): [PMNode, number] {
  const rows: PMNode[] = []
  let cells: PMNode[] = []
  let i = start
  while (i < tokens.length) {
    const t = tokens[i]!
    if (t.type === 'table_close') return [schema.node('table', null, rows), i + 1]
    if (t.type === 'tr_open') cells = []
    else if (t.type === 'tr_close') rows.push(schema.node('table_row', null, cells))
    else if (t.type === 'th_open' || t.type === 'td_open') {
      const content = buildInline(tokens[i + 1]!.children ?? [])
      cells.push(schema.node('table_cell', { header: t.type === 'th_open' }, [schema.node('paragraph', null, content)]))
      i += 3
      continue
    }
    i++
  }
  throw new MarkdownError('表格结构不完整')
}

/** 只含一个图片的段落 → figure 块（资产图）。 */
function asFigure(children: Token[]): PMNode | null {
  const meaningful = children.filter(c => !(c.type === 'text' && !c.content.trim()) && c.type !== 'softbreak')
  if (meaningful.length !== 1 || meaningful[0]!.type !== 'image') return null
  const img = meaningful[0]!
  const src = String(img.attrGet('src') ?? '')
  const m = /^asset:([a-z0-9]+)$/.exec(src)
  if (!m) throw new MarkdownError(`图片只能引用平台资产（asset:<asset_id>，先用 asset_upload 上传），不支持 ${src}`)
  return schema.node('figure', {
    asset_id: m[1],
    alt: img.children?.map(c => c.content).join('') ?? img.content ?? '',
    caption: String(img.attrGet('title') ?? ''),
  })
}

const HTML_MARK: Record<string, string> = { sup: 'sup', sub: 'sub', u: 'underline' }

function buildInline(children: Token[]): PMNode[] {
  const out: PMNode[] = []
  let marks: readonly Mark[] = []
  const add = (name: string, attrs?: Record<string, unknown>) => { marks = schema.marks[name]!.create(attrs).addToSet(marks) }
  const remove = (name: string) => { marks = schema.marks[name]!.removeFromSet(marks) }
  for (const t of children) {
    switch (t.type) {
      case 'text':
        if (t.content) out.push(schema.text(t.content, marks))
        break
      case 'softbreak': {
        // 中文换行不加空格
        const prev = out[out.length - 1]?.text ?? ''
        if (prev && !/[\u3000-\u9fff\uff00-\uffef]$/.test(prev)) out.push(schema.text(' ', marks))
        break
      }
      case 'hardbreak':
        out.push(schema.node('hard_break'))
        break
      case 'strong_open': add('bold'); break
      case 'strong_close': remove('bold'); break
      case 'em_open': add('italic'); break
      case 'em_close': remove('italic'); break
      case 'link_open': add('link', { href: t.attrGet('href') ?? '' }); break
      case 'link_close': remove('link'); break
      case 'code_inline':
        out.push(schema.text(t.content, schema.marks.code!.create().addToSet(marks)))
        break
      case 'citation':
        out.push(schema.node('citation', { cite_id: (t.meta as { cite_id: string }).cite_id }))
        break
      case 'html_inline': {
        const spanOpen = /^<span\s+style="([^"]+)"\s*>/i.exec(t.content.trim())
        if (spanOpen && spanOpen[1]) {
          const styles = spanOpen[1]
          const ff = /font-family:\s*([^;]+)/i.exec(styles)?.[1]?.trim() ?? null
          const fs = /font-size:\s*([^;]+)/i.exec(styles)?.[1]?.trim() ?? null
          const clr = /color:\s*([^;]+)/i.exec(styles)?.[1]?.trim() ?? null
          add('text_style', { font_family: ff, font_size: fs, color: clr })
          break
        }
        if (/^<\/span>$/i.test(t.content.trim())) {
          remove('text_style')
          break
        }
        const m = /^<(\/?)(sup|sub|u|br)\s*\/?>$/i.exec(t.content.trim())
        if (!m) { out.push(schema.text(t.content, marks)); break }
        const tag = m[2]!.toLowerCase()
        if (tag === 'br') { out.push(schema.node('hard_break')); break }
        if (m[1]) remove(HTML_MARK[tag]!)
        else add(HTML_MARK[tag]!)
        break
      }
      case 'image':
        // 行内图片不支持：保留 alt 文字
        if (t.content) out.push(schema.text(t.content, marks))
        break
      default:
        if (t.content) out.push(schema.text(t.content, marks))
    }
  }
  return normalizeInline(out)
}

/** 合并相邻同 mark 文本（Fragment 构造会自动处理）。 */
function normalizeInline(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = []
  Fragment.from(nodes).forEach(n => out.push(n))
  return out
}

// —— 序列化：块节点 → markdown ——

export interface SerializeOptions {
  /** 读视图：每个可寻址块前加 `{#id}`。 */
  ids?: boolean
}

export function serializeBlocks(nodes: readonly PMNode[], opts: SerializeOptions = {}): string {
  return nodes.map(n => serializeBlock(n, opts, '')).join('\n\n')
}

export function serializeBlock(node: PMNode, opts: SerializeOptions, indent: string): string {
  const pending = node.attrs.suggest === 'insert' ? '⟨待采纳·新增⟩ ' : node.attrs.suggest === 'delete' ? '⟨待采纳·删除⟩ ' : ''
  const pre = opts.ids && node.attrs.id ? `{#${node.attrs.id}} ${pending}` : ''
  switch (node.type.name) {
    case 'paragraph':
      return indent + pre + serializeInline(node)
    case 'heading':
      return indent + pre + '#'.repeat(Math.min(6, Math.max(1, node.attrs.level as number))) + ' ' + serializeInline(node)
    case 'bullet_list':
    case 'ordered_list': {
      const lines: string[] = []
      let n = (node.attrs.start as number | undefined) ?? 1
      node.forEach(item => {
        const marker = node.type.name === 'bullet_list' ? '-' : `${n++}.`
        lines.push(serializeListItem(item, marker, opts, indent))
      })
      const head = opts.ids && node.attrs.id ? `${indent}{#${node.attrs.id}}\n` : ''
      return head + lines.join('\n')
    }
    case 'table':
      return (opts.ids && node.attrs.id ? `${indent}{#${node.attrs.id}}\n` : '') + serializeTable(node, indent)
    case 'figure': {
      const caption = node.attrs.caption ? ` "${String(node.attrs.caption).replace(/"/g, '\\"')}"` : ''
      return `${indent}${pre}![${node.attrs.alt ?? ''}](asset:${node.attrs.asset_id}${caption})`
    }
    case 'opaque':
      return `${indent}${pre}[不可编辑·${node.attrs.kind}：${node.attrs.description}]`
    default:
      return indent + pre + node.textContent
  }
}

function serializeListItem(item: PMNode, marker: string, opts: SerializeOptions, indent: string): string {
  const pad = indent + ' '.repeat(marker.length + 1)
  const parts: string[] = []
  item.forEach((child, _off, idx) => {
    if (idx === 0 && child.type.name === 'paragraph') {
      const pre = opts.ids && item.attrs.id ? `{#${item.attrs.id}} ` : ''
      parts.push(`${indent}${marker} ${pre}${serializeInline(child)}`)
    } else {
      parts.push(serializeBlock(child, { ...opts, ids: opts.ids && child.type.name !== 'paragraph' }, pad))
    }
  })
  return parts.join('\n')
}

function serializeTable(node: PMNode, indent: string): string {
  const rows: string[][] = []
  node.forEach(row => {
    const cells: string[] = []
    row.forEach(cell => {
      const parts: string[] = []
      cell.forEach(p => parts.push(serializeInline(p)))
      cells.push(parts.join('<br>').replace(/\|/g, '\\|'))
    })
    rows.push(cells)
  })
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map(r => r.length))
  const line = (r: string[]) => `${indent}| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`
  return [line(rows[0]!), `${indent}|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n')
}

const MARK_ORDER = ['link', 'text_style', 'bold', 'italic', 'underline', 'sup', 'sub', 'code']

function openMark(m: Mark): string {
  switch (m.type.name) {
    case 'text_style': {
      const styles: string[] = []
      if (m.attrs.font_family) styles.push(`font-family:${m.attrs.font_family}`)
      if (m.attrs.font_size) styles.push(`font-size:${m.attrs.font_size}`)
      if (m.attrs.color) styles.push(`color:${m.attrs.color}`)
      return styles.length ? `<span style="${styles.join(';')}">` : ''
    }
    case 'bold': return '**'
    case 'italic': return '*'
    case 'underline': return '<u>'
    case 'sup': return '<sup>'
    case 'sub': return '<sub>'
    case 'code': return '`'
    case 'link': return '['
    default: return ''
  }
}

function closeMark(m: Mark): string {
  switch (m.type.name) {
    case 'text_style': {
      const styles: string[] = []
      if (m.attrs.font_family) styles.push(`font-family:${m.attrs.font_family}`)
      if (m.attrs.font_size) styles.push(`font-size:${m.attrs.font_size}`)
      if (m.attrs.color) styles.push(`color:${m.attrs.color}`)
      return styles.length ? '</span>' : ''
    }
    case 'bold': return '**'
    case 'italic': return '*'
    case 'underline': return '</u>'
    case 'sup': return '</sup>'
    case 'sub': return '</sub>'
    case 'code': return '`'
    case 'link': return `](${m.attrs.href})`
    default: return ''
  }
}

const escapeText = (s: string) => s.replace(/([\\*_`])/g, '\\$1').replace(/<(?=[a-zA-Z/])/g, '&lt;').replace(/\[(?=@c:)/g, '\\[')

/** 行内内容 → markdown（评论 mark 不进 markdown，由读视图单独列出）。 */
export function serializeInline(node: PMNode): string {
  let out = ''
  const stack: Mark[] = []
  const sorted = (marks: readonly Mark[]) => marks
    .filter(m => MARK_ORDER.includes(m.type.name))
    .sort((a, b) => MARK_ORDER.indexOf(a.type.name) - MARK_ORDER.indexOf(b.type.name))
  const sync = (marks: readonly Mark[]) => {
    const want = sorted(marks)
    let keep = 0
    while (keep < stack.length && keep < want.length && stack[keep]!.eq(want[keep]!)) keep++
    while (stack.length > keep) out += closeMark(stack.pop()!)
    for (let i = keep; i < want.length; i++) { out += openMark(want[i]!); stack.push(want[i]!) }
  }
  node.forEach(child => {
    if (child.isText) {
      sync(child.marks)
      const isCode = child.marks.some(m => m.type.name === 'code')
      out += isCode ? child.text! : escapeText(child.text!)
    } else if (child.type.name === 'hard_break') {
      out += '<br>'
    } else if (child.type.name === 'citation') {
      sync(child.marks)
      out += `[@c:${child.attrs.cite_id}]`
    }
  })
  sync([])
  return out
}

/** 纯文本（检索、冲突摘要、diff 用）。citation 记作 `[@c:id]`。 */
export function plainText(node: PMNode): string {
  if (node.isTextblock) {
    let s = ''
    node.forEach(c => {
      if (c.isText) s += c.text
      else if (c.type.name === 'hard_break') s += '\n'
      else if (c.type.name === 'citation') s += `[@c:${c.attrs.cite_id}]`
    })
    return s
  }
  if (node.type.name === 'figure') return `[图] ${node.attrs.alt ?? ''} ${node.attrs.caption ?? ''}`.trim()
  if (node.type.name === 'opaque') return `[${node.attrs.kind}] ${node.attrs.description}`
  const parts: string[] = []
  node.forEach(c => parts.push(plainText(c)))
  return parts.join(node.type.name === 'table_row' ? ' | ' : '\n')
}
