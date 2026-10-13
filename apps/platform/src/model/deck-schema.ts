import { Schema, type DOMOutputSpec, type Node as PMNode } from 'prosemirror-model'

/**
 * deck 插件的模型（PLATFORM.md §7）：幻灯片 → 形状 → 段落。与 doc 共用平台基础设施
 * （Yjs、操作层、版本、修订、撤销），所以同样用 ProseMirror 文档表示。
 *
 * 保真：形状与段落、文字段的原始格式以原始 XML 属性保留（shape.body_pr、paragraph.ppr、rpr mark），
 * 修补式导出时改过的文字沿用这些格式；未改动的形状原样写回（原文在 node_src）。
 * 几何单位是 EMU（1pt = 12700 EMU）；xfrm_inherited 表示位置来自版式占位符（文件里没写）。
 */

const suggestAttrs = { suggest: { default: null }, suggest_group: { default: null }, suggest_of: { default: null } }

export const SHAPE_KINDS = ['text', 'shape', 'image', 'table', 'chart', 'group', 'line', 'opaque'] as const
export type ShapeKind = typeof SHAPE_KINDS[number]

const domId = (node: PMNode): Record<string, string> => (node.attrs.id ? { 'data-id': node.attrs.id as string } : {})

export const deckSchema = new Schema({
  nodes: {
    doc: { content: 'slide+' },
    slide: {
      content: 'shape* notes?',
      attrs: {
        id: { default: null },
        /** 原幻灯片部件（ppt/slides/slideN.xml）；新建的幻灯片为 null。 */
        part: { default: null },
        /** 版式部件（ppt/slideLayouts/…）。 */
        layout: { default: null },
        layout_name: { default: '' },
        hidden: { default: false },
        /** 页面纯色背景（6 位十六进制）。导入时记下原背景；set_background / apply_theme 修改后导出写回。 */
        bg: { default: null },
        /** 套用的主题（deck-themes.ts 的键）；颜色参数里的主题记号按它解析，新加的页沿用前一页的主题。 */
        theme: { default: null },
        ...suggestAttrs,
      },
      toDOM: (node): DOMOutputSpec => ['section', { class: 'slide', ...domId(node) }, 0],
    },
    shape: {
      content: '(paragraph | table)*',
      attrs: {
        id: { default: null },
        kind: { default: 'text' },
        name: { default: '' },
        /** 原文件里的 cNvPr id（导出时沿用）。 */
        nv_id: { default: null },
        /** 占位符：type（title / body / ctrTitle / subTitle / pic …）与 idx。 */
        ph: { default: null },
        ph_idx: { default: null },
        x: { default: 0 }, y: { default: 0 }, w: { default: 0 }, h: { default: 0 },
        rot: { default: 0 },
        xfrm_inherited: { default: false },
        asset_id: { default: null },
        /** 不可编辑形状（图表、组合、SmartArt…）的描述。 */
        description: { default: '' },
        body_pr: { default: null },
        /** 纯色填充（6 位十六进制，或 'none' 无填充）。set_fill 修改后导出写回。 */
        fill: { default: null },
        /** 新建形状的几何：rect / roundRect / ellipse（导入的形状以原文为准，为 null）。 */
        geom: { default: null },
        /** 图表数据（kind=chart；convert/pptx-chart.ts 的 ChartData）：类型、类别、系列与数值。读不出数据的图表为 null（只读）。 */
        chart: { default: null },
        /** 导入的图表部件路径（ppt/charts/chartN.xml）；新建的图表为 null，导出时生成。 */
        chart_part: { default: null },
        ...suggestAttrs,
      },
      toDOM: (node): DOMOutputSpec => ['div', { class: `shape shape-${node.attrs.kind}`, ...domId(node) }, 0],
    },
    notes: { content: 'paragraph*', toDOM: (): DOMOutputSpec => ['aside', { class: 'notes' }, 0] },
    paragraph: {
      content: 'inline*',
      attrs: { ppr: { default: null }, lvl: { default: 0 }, align: { default: null } },
      toDOM: (): DOMOutputSpec => ['p', 0],
    },
    table: { content: 'table_row+', toDOM: (): DOMOutputSpec => ['table', ['tbody', 0]] },
    table_row: { content: 'table_cell+', toDOM: (): DOMOutputSpec => ['tr', 0] },
    table_cell: {
      content: 'paragraph+',
      attrs: { colspan: { default: 1 }, rowspan: { default: 1 }, tcpr: { default: null } },
      toDOM: (): DOMOutputSpec => ['td', 0],
    },
    text: { group: 'inline' },
    hard_break: { group: 'inline', inline: true, toDOM: (): DOMOutputSpec => ['br'] },
    citation: {
      group: 'inline', inline: true, atom: true, attrs: { cite_id: {} },
      toDOM: (node): DOMOutputSpec => ['sup', { class: 'cite', 'data-cite': node.attrs.cite_id as string }, '[?]'],
    },
  },
  marks: {
    bold: { toDOM: () => ['strong', 0] },
    italic: { toDOM: () => ['em', 0] },
    underline: { toDOM: () => ['u', 0] },
    sup: { excludes: 'sub', toDOM: () => ['sup', 0] },
    sub: { excludes: 'sup', toDOM: () => ['sub', 0] },
    code: { toDOM: () => ['code', 0] },
    link: { attrs: { href: {} }, inclusive: false, toDOM: m => ['a', { href: m.attrs.href as string }, 0] },
    comment: { attrs: { thread: {} }, excludes: '', inclusive: false, toDOM: m => ['mark', { class: 'comment', 'data-thread': m.attrs.thread as string }, 0] },
    /** 原始文字段格式（a:rPr，字号、颜色、字体…），导出时沿用。 */
    rpr: { attrs: { xml: {} }, toDOM: () => ['span', 0] },
    /** 字体与字号样式（字体名称、字号大小、颜色） */
    text_style: {
      attrs: {
        font_family: { default: null },
        font_size: { default: null },
        color: { default: null },
      },
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

/** EMU ↔ pt。 */
export const EMU_PER_PT = 12700
export const pt = (emu: number) => Math.round(emu / EMU_PER_PT)
export const emu = (points: number) => Math.round(points * EMU_PER_PT)
