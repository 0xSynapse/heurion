import type { Mark, Node as PMNode } from 'prosemirror-model'
import { serializeBlocks } from '../model/markdown.ts'
import { sanitizeHref } from '../model/schema.ts'
import type { CitationRow } from '../store/db.ts'
import { referencePlan } from '../model/references.ts'

/**
 * 面向人的渲染：HTML 预览与 markdown 导出。引用按文中首次出现顺序编号，
 * 参考文献表由登记表自动生成（模型不手写）。
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const SAFE_ALIGN = new Set(['left', 'center', 'right', 'justify'])

interface RenderContext {
  numbers: Map<string, number>
  assetUrl: (assetId: string) => string
}

function wrap(html: string, marks: readonly Mark[]): string {
  let out = html
  for (const m of marks) {
    switch (m.type.name) {
      case 'bold': out = `<strong>${out}</strong>`; break
      case 'italic': out = `<em>${out}</em>`; break
      case 'underline': out = `<u>${out}</u>`; break
      case 'sup': out = `<sup>${out}</sup>`; break
      case 'sub': out = `<sub>${out}</sub>`; break
      case 'code': out = `<code>${out}</code>`; break
      case 'link': out = `<a href="${esc(sanitizeHref(m.attrs.href))}" target="_blank" rel="noopener">${out}</a>`; break
      case 'comment': out = `<mark class="comment" data-thread="${esc(String(m.attrs.thread))}">${out}</mark>`; break
    }
  }
  return out
}

function inline(node: PMNode, ctx: RenderContext): string {
  let out = ''
  node.forEach(child => {
    if (child.isText) out += wrap(esc(child.text!), child.marks)
    else if (child.type.name === 'hard_break') out += '<br>'
    else if (child.type.name === 'citation') {
      const n = ctx.numbers.get(child.attrs.cite_id as string)
      out += wrap(`<sup class="cite">[${n ?? '?'}]</sup>`, child.marks)
    }
  })
  return out
}

function block(node: PMNode, ctx: RenderContext): string {
  const id = node.attrs.id ? ` data-id="${esc(String(node.attrs.id))}"` : ''
  const rawAlign = typeof node.attrs.align === 'string' ? node.attrs.align.trim().toLowerCase() : ''
  const align = SAFE_ALIGN.has(rawAlign) ? ` style="text-align:${rawAlign}"` : ''
  const children = () => { let s = ''; node.forEach(c => { s += block(c, ctx) }); return s }
  switch (node.type.name) {
    case 'paragraph': {
      const cls = node.attrs.style ? ` class="style-${esc(String(node.attrs.style)).replace(/\s+/g, '-')}"` : ''
      return `<p${id}${cls}${align}>${inline(node, ctx) || '<br>'}</p>`
    }
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs.level) || 1))
      return `<h${level}${id}${align}>${inline(node, ctx)}</h${level}>`
    }
    case 'bullet_list': return `<ul${id}>${children()}</ul>`
    case 'ordered_list': {
      const start = Math.max(1, Math.floor(Number(node.attrs.start) || 1))
      return `<ol${id} start="${start}">${children()}</ol>`
    }
    case 'list_item': return `<li${id}>${children()}</li>`
    case 'table': return `<table${id}>${children()}</table>`
    case 'table_row': return `<tr>${children()}</tr>`
    case 'table_cell': {
      const tag = node.attrs.header ? 'th' : 'td'
      const colspan = Math.floor(Number(node.attrs.colspan) || 1)
      const rowspan = Math.floor(Number(node.attrs.rowspan) || 1)
      const span = `${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}`
      return `<${tag}${span}>${children()}</${tag}>`
    }
    case 'figure': {
      const caption = node.attrs.caption ? `<figcaption>${esc(String(node.attrs.caption))}</figcaption>` : ''
      return `<figure${id}><img src="${esc(ctx.assetUrl(String(node.attrs.asset_id)))}" alt="${esc(String(node.attrs.alt ?? ''))}">${caption}</figure>`
    }
    case 'opaque':
      return `<div${id} class="opaque">不可编辑内容 · ${esc(String(node.attrs.kind))}：${esc(String(node.attrs.description))}</div>`
    default:
      return ''
  }
}

/** 与 docx 导出同一套编号与文献表合并规则（model/references.ts）。 */
function numbering(doc: PMNode, citations: CitationRow[]) {
  const byId = new Map(citations.map(c => [c.id, c]))
  const plan = referencePlan(doc, citations)
  return { plan, numbers: plan.numbers, list: plan.append.map(a => ({ n: a.n, c: byId.get(a.id)! })) }
}

export function renderHtml(doc: PMNode, citations: CitationRow[], assetUrl: (id: string) => string): string {
  const { plan, numbers, list } = numbering(doc, citations)
  let body = ''
  doc.forEach((n, _o, i) => { if (i < plan.bodyEnd) body += block(n, { numbers, assetUrl }) })
  if (list.length > 0) {
    const items = list.map(({ c }) => `<li>${esc(c.formatted)} <a href="${esc(sanitizeHref(c.url ?? `https://doi.org/${c.doi}`))}" target="_blank" rel="noopener">原文</a></li>`).join('')
    // 合并进用户的文献表 / 复用已有标题时不再另起标题；编号接着用户的表
    const heading = plan.userCount > 0 || plan.hasHeading ? '' : '<h2>参考文献</h2>'
    body += `<section class="references">${heading}<ol start="${list[0]!.n}">${items}</ol></section>`
  }
  return body
}

/** markdown 导出：引用替换成 [n]，末尾追加参考文献表（与 docx 同一套合并规则）。 */
export function exportMarkdown(doc: PMNode, citations: CitationRow[]): string {
  const { plan, numbers, list } = numbering(doc, citations)
  const blocks: PMNode[] = []
  doc.forEach((n, _o, i) => { if (i < plan.bodyEnd) blocks.push(n) })
  let md = serializeBlocks(blocks).replace(/\[@c:([a-z0-9]+)\]/g, (_m, id: string) => `[${numbers.get(id) ?? '?'}]`)
  if (list.length > 0) {
    const heading = plan.userCount > 0 || plan.hasHeading ? '' : '## 参考文献\n\n'
    md += `\n\n${heading}${list.map(({ n, c }) => `[${n}] ${c.formatted}`).join('\n\n')}`
  }
  return md + '\n'
}
