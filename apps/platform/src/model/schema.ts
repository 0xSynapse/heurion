import { Schema, type DOMOutputSpec, type Node as PMNode } from 'prosemirror-model'

/**
 * doc 插件的 ProseMirror schema（PLATFORM.md §6）——服务端（操作层、导入导出）与浏览器编辑器共用
 * 同一份定义，Yjs 里的结构因此两端一致。
 *
 * 可寻址节点（带平台 id）：heading / paragraph / bullet_list / ordered_list / list_item / table /
 * figure / opaque。表格单元格按 (row, col) 寻址，不单独给 id。
 * 引用是行内原子节点 citation(cite_id)：编号在渲染时按文中首次出现顺序计算。
 *
 * 修订（suggest 模式，块级）：可寻址节点带 suggest = 'insert' | 'delete'、suggest_group（同一批修订）、
 * suggest_of（替换型插入所替换的原块 id；采纳后新块接过原 id）。
 */

const blockAttrs = {
  id: { default: null },
  suggest: { default: null },
  suggest_group: { default: null },
  suggest_of: { default: null },
}

/** 浏览器渲染用的通用属性（data-id、修订状态）。 */
function domAttrs(node: PMNode, extra: Record<string, string | null | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  if (node.attrs.id) out['data-id'] = node.attrs.id as string
  if (node.attrs.suggest) {
    out['data-suggest'] = node.attrs.suggest as string
    out['data-suggest-group'] = (node.attrs.suggest_group as string | null) ?? ''
  }
  for (const [k, v] of Object.entries(extra)) if (v) out[k] = v
  return out
}

const textAlign = (node: PMNode) => node.attrs.align ? `text-align:${node.attrs.align}` : null
const styleClass = (node: PMNode) => node.attrs.style ? `style-${String(node.attrs.style).replace(/\s+/g, '-')}` : null

export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { ...blockAttrs, style: { default: null }, align: { default: null } },
      parseDOM: [{ tag: 'p' }],
      toDOM: (node): DOMOutputSpec => ['p', domAttrs(node, { class: styleClass(node), style: textAlign(node) }), 0],
    },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { ...blockAttrs, level: { default: 1 }, style: { default: null }, align: { default: null } },
      defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map(level => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node): DOMOutputSpec => [`h${node.attrs.level}`, domAttrs(node, { style: textAlign(node) }), 0],
    },
    bullet_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { ...blockAttrs },
      parseDOM: [{ tag: 'ul' }],
      toDOM: (node): DOMOutputSpec => ['ul', domAttrs(node), 0],
    },
    ordered_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { ...blockAttrs, start: { default: 1 } },
      parseDOM: [{ tag: 'ol', getAttrs: dom => ({ start: Number((dom as HTMLElement).getAttribute('start') ?? 1) }) }],
      toDOM: (node): DOMOutputSpec => ['ol', domAttrs(node, { start: node.attrs.start === 1 ? null : String(node.attrs.start) }), 0],
    },
    list_item: {
      content: 'paragraph block*',
      attrs: { ...blockAttrs },
      defining: true,
      parseDOM: [{ tag: 'li' }],
      toDOM: (node): DOMOutputSpec => ['li', domAttrs(node), 0],
    },
    table: {
      group: 'block',
      content: 'table_row+',
      attrs: { ...blockAttrs },
      isolating: true,
      tableRole: 'table',
      parseDOM: [{ tag: 'table' }],
      toDOM: (node): DOMOutputSpec => ['table', domAttrs(node), ['tbody', 0]],
    },
    table_row: {
      content: 'table_cell+',
      tableRole: 'row',
      parseDOM: [{ tag: 'tr' }],
      toDOM: (): DOMOutputSpec => ['tr', 0],
    },
    table_cell: {
      content: 'paragraph+',
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null }, header: { default: false } },
      isolating: true,
      tableRole: 'cell',
      parseDOM: ['td', 'th'].map(tag => ({
        tag,
        getAttrs: (dom: HTMLElement) => ({
          colspan: Number(dom.getAttribute('colspan') ?? 1),
          rowspan: Number(dom.getAttribute('rowspan') ?? 1),
          header: tag === 'th',
        }),
      })),
      toDOM: (node): DOMOutputSpec => [node.attrs.header ? 'th' : 'td', {
        ...(node.attrs.colspan !== 1 ? { colspan: String(node.attrs.colspan) } : {}),
        ...(node.attrs.rowspan !== 1 ? { rowspan: String(node.attrs.rowspan) } : {}),
      }, 0],
    },
    /** 图：引用平台资产（浏览器里由 NodeView 渲染图片地址）。 */
    figure: {
      group: 'block',
      atom: true,
      attrs: { ...blockAttrs, asset_id: { default: null }, alt: { default: '' }, caption: { default: '' } },
      toDOM: (node): DOMOutputSpec => ['figure', domAttrs(node, { 'data-asset': node.attrs.asset_id as string })],
    },
    /** 模型不认识的结构：可移动、可删除、可评论，不可编辑内部；导出时原样写回（src 存在 node_src 表）。 */
    opaque: {
      group: 'block',
      atom: true,
      attrs: { ...blockAttrs, kind: { default: 'unknown' }, description: { default: '' } },
      toDOM: (node): DOMOutputSpec => ['div', domAttrs(node, { class: 'opaque' }), `不可编辑内容 · ${node.attrs.kind}：${node.attrs.description}`],
    },
    text: { group: 'inline' },
    hard_break: {
      group: 'inline',
      inline: true,
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: (): DOMOutputSpec => ['br'],
    },
    citation: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { cite_id: {} },
      toDOM: (node): DOMOutputSpec => ['sup', { class: 'cite', 'data-cite': node.attrs.cite_id as string }, '[?]'],
    },
  },
  marks: {
    bold: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
    italic: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
    underline: { parseDOM: [{ tag: 'u' }], toDOM: () => ['u', 0] },
    sup: { excludes: 'sub', parseDOM: [{ tag: 'sup' }], toDOM: () => ['sup', 0] },
    sub: { excludes: 'sup', parseDOM: [{ tag: 'sub' }], toDOM: () => ['sub', 0] },
    code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [{ tag: 'a[href]', getAttrs: dom => ({ href: (dom as HTMLElement).getAttribute('href') }) }],
      toDOM: mark => ['a', { href: mark.attrs.href as string, target: '_blank', rel: 'noopener' }, 0],
    },
    /** 评论锚点：同一段文字可同时挂多条线程。 */
    comment: {
      attrs: { thread: {} },
      excludes: '',
      inclusive: false,
      toDOM: mark => ['mark', { class: 'comment', 'data-thread': mark.attrs.thread as string }, 0],
    },
    /** 文字字体与字号样式（字体名称、字号大小、颜色） */
    text_style: {
      attrs: {
        font_family: { default: null },
        font_size: { default: null },
        color: { default: null },
      },
      parseDOM: [{
        tag: 'span[style]',
        getAttrs: (dom: HTMLElement | string) => {
          if (typeof dom === 'string') return false
          const fontFamily = dom.style.fontFamily || null
          const fontSize = dom.style.fontSize || null
          const color = dom.style.color || null
          if (!fontFamily && !fontSize && !color) return false
          return { font_family: fontFamily, font_size: fontSize, color }
        },
      }],
      toDOM: mark => {
        const styles: string[] = []
        if (mark.attrs.font_family) styles.push(`font-family:${mark.attrs.font_family}`)
        if (mark.attrs.font_size) styles.push(`font-size:${mark.attrs.font_size}`)
        if (mark.attrs.color) styles.push(`color:${mark.attrs.color}`)
        return ['span', { style: styles.join(';') }, 0]
      },
    },
  },
})

/** 带平台 id 的节点类型（doc 与 deck 两套 schema 共用一个集合；deck 的段落不单独寻址）。 */
export const ADDRESSABLE = new Set(['heading', 'paragraph', 'bullet_list', 'ordered_list', 'list_item', 'table', 'figure', 'opaque', 'slide', 'shape'])

/** deck 里的段落、表格属于形状内部，不分配 id。 */
export const isAddressable = (n: PMNode): boolean => ADDRESSABLE.has(n.type.name) && 'id' in (n.type.spec.attrs ?? {})

/** 一个空文档（doc 至少要有一个块）。 */
export function emptyDoc(id: string): PMNode {
  return schema.node('doc', null, [schema.node('paragraph', { id })])
}
