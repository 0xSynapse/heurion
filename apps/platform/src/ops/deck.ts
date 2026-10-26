import { Fragment, type Mark, type Node as PMNode } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import { z } from 'zod'
import { imageSize } from '../convert/image-size.ts'
import { checkChartData, EDITABLE_CHART_TYPES, type ChartData } from '../convert/pptx-chart.ts'
import { deckSchema, emu, pt } from '../model/deck-schema.ts'
import { decorations, isDecoName, LAYOUTS as LAYOUT_DEFS, layoutByName, layoutDef, layoutSpec, phSpecOf, themeOf, type LayoutKey, type PhSpec } from '../model/deck-templates.ts'
import { DECK_THEMES, DEFAULT_THEME, resolveColor } from '../model/deck-themes.ts'
import { BUILTIN_THEME_KEYS } from '../model/org-templates.ts'
import { assignIds, indexById } from '../model/ids.ts'
import { MarkdownError, parseBlocks, parseInline } from '../model/markdown.ts'
import { replaceError, replaceInTextblock } from './apply.ts'
import { OpError } from './types.ts'

const CHART_SERIES = z.array(z.object({
  name: z.string().describe('系列名称（图例）'),
  values: z.array(z.number().nullable()).describe('每个类别一个数值；缺的写 null'),
})).min(1).max(20)

const COLOR = z.string().describe('颜色：6 位十六进制（如 0EA5E9），或主题记号 accent / accent2 / title / body / muted / bg / surface')

/** deck_edit 的操作（PLATFORM.md §7 MCP 面）。几何单位 pt。画布上人能做的操作都在这里，AI 与人用同一套。 */
export const DeckOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_slide'),
    after: z.string().nullable().describe('插在该页之后；null 表示开头'),
    layout: z.string().optional().describe('版式名（slide_read / doc_outline 列出的可用版式）；缺省为「标题和内容」类版式'),
    title: z.string().optional().describe('标题占位符的文字'),
    body: z.string().optional().describe('正文占位符的 markdown（列表项 - 对应项目符号，缩进对应级别）；封面是副标题，大数字版式是那个数字'),
    body2: z.string().optional().describe('第二个正文区：两栏的右栏、大数字版式的说明（平台模板的版式才有）'),
  }),
  z.object({ op: z.literal('delete_slide'), slide_id: z.string() }),
  z.object({ op: z.literal('move_slide'), slide_id: z.string(), after: z.string().nullable() }),
  z.object({ op: z.literal('set_text'), shape_id: z.string(), markdown: z.string().describe('形状的全部文字；沿用原有字号、颜色与段落格式') }),
  z.object({
    op: z.literal('replace_text'),
    shape_id: z.string(),
    find: z.string().min(1),
    replace: z.string(),
    occurrence: z.number().int().min(1).optional(),
  }),
  z.object({
    op: z.literal('add_shape'),
    slide_id: z.string(),
    markdown: z.string().default('').describe('形状里的文字（色块可留空）'),
    x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(),
    font_size: z.number().positive().optional().describe('字号（pt），缺省 18'),
    geometry: z.enum(['rect', 'roundRect', 'ellipse']).optional().describe('形状：矩形 / 圆角矩形 / 椭圆；缺省为无边框文本框'),
    fill: COLOR.optional().describe('填充色（色块、标题条、强调卡片）'),
    color: COLOR.optional().describe('文字颜色'),
  }),
  z.object({
    op: z.literal('set_paragraphs'),
    shape_id: z.string(),
    paragraphs: z.array(z.object({
      text: z.string().describe('该段文字（行内 markdown：**粗体**、[@c:id] 引用、<br> 换行）'),
      lvl: z.number().int().min(0).max(8).optional().describe('列表级别；缺省沿用原段'),
    })).describe('形状的全部段落，按顺序'),
  }).describe('逐段改写形状文字：每段只替换变化的字，原有格式、引用、评论标记保留（画布上直接改字用的就是它）'),
  z.object({
    op: z.literal('add_table'),
    slide_id: z.string(),
    rows: z.array(z.array(z.string()).min(1).max(12)).min(1).max(30).describe('单元格文字（行内 markdown），第一行默认是表头'),
    x: z.number(), y: z.number(), w: z.number().positive(),
    h: z.number().positive().optional().describe('缺省按行数（每行约 32pt）'),
    header: z.boolean().optional().describe('第一行作表头（强调色底、白色粗体），缺省 true'),
    font_size: z.number().min(8).max(40).optional().describe('字号（pt），缺省 14'),
  }),
  z.object({
    op: z.literal('table_insert_rows'), shape_id: z.string(),
    at: z.number().int().min(0).describe('插入位置（行下标；等于行数时追加到末尾）'),
    rows: z.array(z.array(z.string())).optional().describe('新行的单元格文字；缺省插一行空行'),
  }),
  z.object({ op: z.literal('table_delete_rows'), shape_id: z.string(), at: z.number().int().min(0), count: z.number().int().min(1).default(1) }),
  z.object({
    op: z.literal('table_insert_cols'), shape_id: z.string(),
    at: z.number().int().min(0).describe('插入位置（列下标；等于列数时追加到最右）'),
    cells: z.array(z.string()).optional().describe('新列每行的文字（从表头起）；缺省空列'),
  }),
  z.object({ op: z.literal('table_delete_cols'), shape_id: z.string(), at: z.number().int().min(0), count: z.number().int().min(1).default(1) }),
  z.object({
    op: z.literal('align_shapes'),
    shape_ids: z.array(z.string()).min(1).describe('同一页上的形状'),
    align: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']),
    to: z.enum(['selection', 'slide']).optional().describe('对齐到所选形状的范围或整页；缺省：多个形状对齐选区，单个形状对齐页面'),
  }),
  z.object({
    op: z.literal('distribute_shapes'),
    shape_ids: z.array(z.string()).min(3).describe('同一页上的形状（至少 3 个）'),
    direction: z.enum(['horizontal', 'vertical']).describe('首尾不动，中间等间距'),
  }),
  z.object({
    op: z.literal('chart_set_data'),
    shape_id: z.string(),
    categories: z.array(z.string()).min(1).max(200).optional().describe('类别（横轴 / 扇区）；缺省沿用原类别'),
    series: CHART_SERIES,
    title: z.string().optional().describe('图表标题；空串去掉标题；缺省不变'),
  }).describe('改图表数据（导出时同时更新图表缓存与内嵌工作簿，PowerPoint「编辑数据」看到的就是新数据）'),
  z.object({
    op: z.literal('chart_set_type'),
    shape_id: z.string(),
    type: z.enum(['column', 'bar', 'line', 'pie', 'area', 'doughnut']),
  }).describe('换图表类型（数据不变；饼图 / 圆环图只能一个系列。导入的图表换类型后按新图表导出、形状 id 会变，原文件里的图表样式不保留）'),
  z.object({
    op: z.literal('add_chart'),
    slide_id: z.string(),
    type: z.enum(['column', 'bar', 'line', 'pie', 'area', 'doughnut']).describe('柱状 / 条形 / 折线 / 饼 / 面积 / 圆环'),
    x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(),
    title: z.string().optional(),
    categories: z.array(z.string()).min(1).max(200),
    series: CHART_SERIES,
  }).describe('新建原生图表（系列颜色取当页主题）'),
  z.object({ op: z.literal('set_fill'), shape_id: z.string(), color: COLOR.describe('填充色；none 为无填充') }),
  z.object({ op: z.literal('set_background'), slide_id: z.string(), color: COLOR }),
  z.object({
    op: z.literal('set_text_style'),
    shape_id: z.string(),
    paragraph: z.number().int().min(0).optional().describe('只改第几段（从 0 起）；缺省改整个形状'),
    color: COLOR.optional(),
    size: z.number().min(6).max(200).optional().describe('字号（pt）'),
    font_family: z.string().optional().describe('字体名称，如 Arial, SimSun, SimHei, KaiTi, Roboto, PingFang SC'),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    align: z.enum(['left', 'center', 'right', 'justify']).optional(),
  }),
  z.object({
    op: z.literal('add_image'),
    slide_id: z.string(),
    asset_id: z.string().describe('asset_upload 返回的资产 id'),
    x: z.number(), y: z.number(), w: z.number().positive(),
    h: z.number().positive().optional().describe('缺省按原图比例'),
    description: z.string().optional().describe('图片说明（替代文字）'),
    credit: z.string().optional().describe('图片署名（markdown，追加到这一页的演讲备注末尾；图库照片必填，如 Photo by X on Unsplash）'),
  }),
  z.object({ op: z.literal('set_z'), shape_id: z.string(), to: z.enum(['front', 'back', 'forward', 'backward']).describe('置顶 / 置底 / 上移一层 / 下移一层') }),
  z.object({
    op: z.literal('apply_theme'),
    theme: z.string().refine(v => !!DECK_THEMES[v], v => ({ message: `没有模板「${v}」（deck_templates 列出可用模板）` })).describe(BUILTIN_THEME_KEYS.map(k => `${k}：${DECK_THEMES[k]!.label}（${DECK_THEMES[k]!.description}）`).join('；') + '；以及本机构的模板 org_…（deck_templates 列出，只有本机构成员能用）'),
    slide_ids: z.array(z.string()).optional().describe('只套用到这些页；缺省全部'),
  }).describe('换模板：配色与字体；平台新建的 deck 还会换掉模板装饰（色条、色块等），继承版式位置的占位符挪到新模板的位置'),
  z.object({
    op: z.literal('set_xfrm'),
    shape_id: z.string(),
    x: z.number().optional(), y: z.number().optional(), w: z.number().positive().optional(), h: z.number().positive().optional(),
  }),
  z.object({ op: z.literal('delete_shape'), shape_id: z.string() }),
  z.object({ op: z.literal('set_notes'), slide_id: z.string(), markdown: z.string() }),
  z.object({
    op: z.literal('table_set_cells'),
    shape_id: z.string(),
    cells: z.array(z.object({ row: z.number().int().min(0), col: z.number().int().min(0), markdown: z.string() })).min(1),
  }),
])
export type DeckOp = z.infer<typeof DeckOp>

export const DeckEditBatch = z.object({
  doc_id: z.string(),
  base_rev: z.number().int().min(0),
  mode: z.enum(['apply', 'suggest']).default('apply'),
  ack_comments: z.array(z.string()).optional(),
  dry_run: z.boolean().optional().describe('试探预检模式：仅执行写前守卫与语法校验，不提交改动'),
  ops: z.array(DeckOp).min(1).max(50),
})
export type DeckEditBatch = z.infer<typeof DeckEditBatch>

/** 占位符从版式 / 母版继承的文字样式（画布据此显示导入的占位符，与 PowerPoint 一致）。 */
export interface PlaceholderStyle { anchor?: 't' | 'ctr' | 'b'; align?: 'l' | 'ctr' | 'r' | 'just'; size?: number; bold?: boolean }

export interface LayoutInfo {
  name: string
  part: string
  placeholders: Array<{ type: string; idx: string | null; x: number; y: number; w: number; h: number; style?: PlaceholderStyle }>
}

export interface DeckContext {
  taken: Set<string>
  layouts: LayoutInfo[]
  size: { cx: number; cy: number }
  /** 平台模板生成的 deck（有 8 个模板版式、带模板装饰）；导入的 pptx 为 false。 */
  platform?: boolean
  /** 文档所有者的资产（add_image 用）；别人的资产返回 null。 */
  asset?: (id: string) => { mime: string; bytes: Uint8Array } | null
}

export function deckTargetIds(op: DeckOp): string[] {
  switch (op.op) {
    case 'add_slide': case 'add_shape': case 'add_image': case 'add_table': case 'add_chart': return []
    case 'delete_slide': case 'move_slide': case 'set_notes': case 'set_background': return [op.slide_id]
    case 'apply_theme': return op.slide_ids ?? []
    case 'align_shapes': case 'distribute_shapes': return op.shape_ids
    default: return [op.shape_id]
  }
}

export function deckOpTexts(op: DeckOp): string[] {
  switch (op.op) {
    case 'add_slide': return [op.title ?? '', op.body ?? '', op.body2 ?? '']
    case 'set_text': case 'add_shape': case 'set_notes': return [op.markdown ?? '']
    case 'set_paragraphs': return op.paragraphs.map(p => p.text)
    case 'add_table': return op.rows.flat()
    case 'table_insert_rows': return op.rows?.flat() ?? []
    case 'chart_set_data': case 'add_chart': return [op.title ?? '', ...(op.categories ?? []), ...op.series.map(s => s.name)]
    case 'table_insert_cols': return op.cells ?? []
    case 'replace_text': return [op.replace]
    case 'table_set_cells': return op.cells.map(c => c.markdown)
    default: return []
  }
}

// —— markdown → deck 段落 ——

/** doc schema 的行内节点 → deck schema（同名 mark / 节点），叠加模板格式。 */
function toDeckInline(nodes: readonly PMNode[], rpr: Mark | null): PMNode[] {
  return nodes.map(n => {
    let marks: readonly Mark[] = n.marks.flatMap(m => {
      const type = deckSchema.marks[m.type.name]
      return type ? [type.create(m.attrs)] : []
    })
    if (rpr && n.isText && !marks.some(m => m.type.name === 'rpr')) marks = rpr.addToSet(marks)
    if (n.isText) return deckSchema.text(n.text!, marks)
    if (n.type.name === 'citation') return deckSchema.node('citation', { cite_id: n.attrs.cite_id })
    return deckSchema.node('hard_break')
  })
}

interface Template { ppr: (lvl: number) => string | null; rpr: Mark | null; bold?: boolean }

function templateOf(shape: PMNode | null): Template {
  const pprs: Array<string | null> = []
  let rpr: Mark | null = null
  let bold: boolean | undefined
  shape?.descendants(n => {
    if (n.type.name === 'paragraph') pprs[n.attrs.lvl as number] ??= n.attrs.ppr as string | null
    if (n.isText && !rpr) { rpr = n.marks.find(m => m.type.name === 'rpr') ?? null; bold = n.marks.some(m => m.type.name === 'bold') }
    return true
  })
  // 还没有文字的模板占位符：字号、颜色、粗细取段落属性里的 a:defRPr（版式规定的样式）
  if (!rpr && pprs[0]) {
    const def = /<a:defRPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:defRPr>)/.exec(pprs[0])
    if (def) {
      bold = /\sb="1"/.test(def[1]!)
      rpr = deckSchema.marks.rpr!.create({ xml: `<a:rPr ${A_NS} lang="zh-CN"${(/\ssz="\d+"/.exec(def[1]!)?.[0]) ?? ''} dirty="0">${def[2] ?? ''}</a:rPr>` })
    }
  }
  return { ppr: lvl => pprs[lvl] ?? pprs[0] ?? null, rpr, bold }
}

/** markdown → 段落：标题 / 段落各成一段，列表项按嵌套深度设 lvl。 */
export function deckParagraphs(markdown: string, template: Template): PMNode[] {
  const out: PMNode[] = []
  const walk = (node: PMNode, depth: number) => {
    if (node.isTextblock) {
      out.push(deckSchema.node('paragraph', { lvl: depth, ppr: template.ppr(depth), align: alignOf(template.ppr(depth)) }, boldIf(toDeckInline(contentOf(node), template.rpr), template.bold)))
      return
    }
    if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
      node.forEach(item => item.forEach(child => walk(child, /_list$/.test(child.type.name) ? depth + 1 : depth)))
      return
    }
    node.forEach(child => walk(child, depth))
  }
  for (const block of parseBlocks(markdown)) {
    walk(block, /_list$/.test(block.type.name) ? 1 : 0)
  }
  // 顶层列表在幻灯片里就是项目符号段落：从 lvl 0 开始
  const minLvl = Math.min(...out.map(p => p.attrs.lvl as number), 99)
  return out.map(p => minLvl > 0 ? p.type.create({ ...p.attrs, lvl: (p.attrs.lvl as number) - minLvl, ppr: template.ppr((p.attrs.lvl as number) - minLvl) }, p.content) : p)
}

function contentOf(node: PMNode): PMNode[] {
  const out: PMNode[] = []
  node.forEach(c => out.push(c))
  return out
}

const deckInlineParser = (template: Template) => (md: string) => boldIf(toDeckInline(parseInline(md), template.rpr), template.bold)

/** 模板规定粗体的占位符：新写的字加粗。 */
function boldIf(nodes: PMNode[], bold: boolean | undefined): PMNode[] {
  return bold ? nodes.map(n => n.isText ? n.mark(deckSchema.marks.bold!.create().addToSet(n.marks)) : n) : nodes
}

/** 段落属性里的对齐 → 段落的 align 属性（画布显示用）。 */
function alignOf(ppr: string | null): string | null {
  const a = ppr ? /\salgn="(ctr|r|just)"/.exec(ppr)?.[1] : undefined
  return a ? ({ ctr: 'center', r: 'right', just: 'justify' } as Record<string, string>)[a]! : null
}

// —— 应用 ——

function find(tr: Transform, id: string, kind: 'slide' | 'shape'): { node: PMNode; pos: number } {
  const hit = indexById(tr.doc).get(id)
  if (!hit || hit.node.type.name !== kind) {
    throw new OpError('node_not_found', `找不到${kind === 'slide' ? '幻灯片' : '形状'} ${id}`, { hint: '先用 doc_outline / slide_read 获取当前的 id。' })
  }
  return hit
}

const EDITABLE_TEXT = new Set(['text', 'shape'])

export function applyDeckOps(doc: PMNode, ops: DeckOp[], ctx: DeckContext): { doc: PMNode; results: Array<{ op_index: number; op: string; ids: string[] }> } {
  const tr = new Transform(doc)
  const results: Array<{ op_index: number; op: string; ids: string[] }> = []
  ops.forEach((op, index) => {
    try {
      results.push({ op_index: index, op: op.op, ids: applyOne(tr, op, ctx) })
    } catch (err) {
      if (err instanceof OpError) throw new OpError(err.code, err.message, { op_index: index, ...err.extra })
      if (err instanceof MarkdownError) throw new OpError('invalid_markdown', err.message, { op_index: index })
      throw new OpError('invalid_structure', `操作无法应用：${(err as Error).message}`, { op_index: index })
    }
  })
  try {
    tr.doc.check()
  } catch (err) {
    throw new OpError('invalid_structure', `操作后的结构不合法：${(err as Error).message}`)
  }
  return { doc: tr.doc, results }
}

function pickLayout(ctx: DeckContext, name?: string): LayoutInfo | null {
  if (ctx.layouts.length === 0) return null
  if (name) {
    const n = name.toLowerCase()
    const hit = ctx.layouts.find(l => l.name.toLowerCase() === n) ?? ctx.layouts.find(l => l.name.toLowerCase().includes(n))
    if (!hit) throw new OpError('layout_not_found', `没有版式「${name}」`, { hint: `可用版式：${ctx.layouts.map(l => l.name).join('、')}` })
    return hit
  }
  return ctx.layouts.find(l => /title and content|标题和内容/i.test(l.name))
    ?? ctx.layouts.find(l => l.placeholders.some(p => p.type === 'title') && l.placeholders.some(p => p.type === 'body' || p.type === 'obj'))
    ?? ctx.layouts[0]!
}

/** 模板装饰只能移动、删除、改填充，不能改字。 */
const DECO_LOCKED = new Set(['set_text', 'replace_text', 'set_paragraphs', 'set_text_style'])

function applyOne(tr: Transform, op: DeckOp, ctx: DeckContext): string[] {
  const target = 'shape_id' in op ? indexById(tr.doc).get(op.shape_id) : undefined
  if (target && DECO_LOCKED.has(op.op) && isDecoName(target.node.attrs.name)) {
    throw new OpError('node_not_editable', `形状 ${(op as { shape_id: string }).shape_id} 是模板装饰，不能写字`, { hint: '装饰随模板走（apply_theme 换模板时自动替换）；要写字请 add_shape 新建文本框，不想要这个装饰可以 delete_shape。' })
  }
  switch (op.op) {
    case 'add_slide': {
      if (ctx.platform) {
        // 平台模板的 deck：按前一页（或第一页）的模板与版式生成，占位符带版式样式，模板装饰在最底层
        const neighbour = op.after ? indexById(tr.doc).get(op.after)?.node : tr.doc.firstChild
        const def = op.layout ? layoutByName(op.layout) ?? LAYOUT_DEFS.find(l => l.name.includes(op.layout!.trim())) : LAYOUT_DEFS.find(l => l.key === 'content')
        if (!def) throw new OpError('layout_not_found', `没有版式「${op.layout}」`, { hint: `可用版式：${LAYOUT_DEFS.map(l => `${l.name}（${l.hint}）`).join('、')}` })
        const slide = assignIds(templateSlide(def.key, (neighbour?.attrs.theme as string | null) ?? null, { title: op.title, body: op.body, body2: op.body2 }), ctx.taken)
        insertSlide(tr, slide, op.after)
        return [slide.attrs.id as string, ...contentOf(slide).map(s => s.attrs.id as string)]
      }
      const layout = pickLayout(ctx, op.layout)
      const shapes: PMNode[] = []
      const add = (ph: LayoutInfo['placeholders'][number], markdown: string) => {
        const paragraphs = deckParagraphs(markdown, { ppr: () => null, rpr: null })
        shapes.push(deckSchema.node('shape', {
          kind: 'text', ph: ph.type, ph_idx: ph.idx, x: ph.x, y: ph.y, w: ph.w, h: ph.h, xfrm_inherited: true,
          name: ph.type === 'title' || ph.type === 'ctrTitle' ? 'Title' : 'Content',
        }, paragraphs.length > 0 ? paragraphs : [deckSchema.node('paragraph')]))
      }
      const title = layout?.placeholders.find(p => p.type === 'title' || p.type === 'ctrTitle')
      const body = layout?.placeholders.find(p => p.type === 'body' || p.type === 'obj' || p.type === 'subTitle')
      if (title && op.title !== undefined) add(title, op.title)
      if (body && op.body !== undefined) add(body, op.body)
      if (!layout && (op.title || op.body)) {
        // 没有版式（不应发生）：用文本框兜底
        if (op.title) shapes.push(textBox(op.title, { x: 40, y: 30, w: pt(ctx.size.cx) - 80, h: 60 }, 32))
        if (op.body) shapes.push(textBox(op.body, { x: 40, y: 110, w: pt(ctx.size.cx) - 80, h: pt(ctx.size.cy) - 150 }, 20))
      }
      let slide = assignIds(deckSchema.node('slide', { layout: layout?.part ?? null, layout_name: layout?.name ?? '' }, shapes), ctx.taken)
      // 新页沿用前一页（或第一页）的主题
      const neighbour = op.after ? indexById(tr.doc).get(op.after)?.node : tr.doc.firstChild
      const theme = neighbour?.attrs.theme as string | null | undefined
      if (theme) slide = themedSlide(slide, theme)
      insertSlide(tr, slide, op.after)
      return [slide.attrs.id as string, ...contentOf(slide).map(s => s.attrs.id as string)]
    }
    case 'delete_slide': {
      const hit = find(tr, op.slide_id, 'slide')
      if (tr.doc.childCount === 1) throw new OpError('invalid_structure', '不能删除最后一页')
      tr.delete(hit.pos, hit.pos + hit.node.nodeSize)
      return [op.slide_id]
    }
    case 'move_slide': {
      if (op.after === op.slide_id) throw new OpError('invalid_structure', '不能移动到自己之后')
      const hit = find(tr, op.slide_id, 'slide')
      tr.delete(hit.pos, hit.pos + hit.node.nodeSize)
      insertSlide(tr, hit.node, op.after)
      return [op.slide_id]
    }
    case 'set_text': {
      const hit = find(tr, op.shape_id, 'shape')
      if (!EDITABLE_TEXT.has(hit.node.attrs.kind as string)) throw notEditable(hit.node)
      const paragraphs = deckParagraphs(op.markdown, templateOf(hit.node))
      // 色块（kind=shape）写文字后仍是色块，不变成文本框
      const next = hit.node.type.create({ ...hit.node.attrs, kind: hit.node.attrs.kind === 'shape' ? 'shape' : 'text' }, paragraphs.length > 0 ? paragraphs : [deckSchema.node('paragraph')])
      tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, next)
      return [op.shape_id]
    }
    case 'replace_text': {
      const hit = find(tr, op.shape_id, 'shape')
      if (!EDITABLE_TEXT.has(hit.node.attrs.kind as string) && hit.node.attrs.kind !== 'table') throw notEditable(hit.node)
      const parse = deckInlineParser(templateOf(hit.node))
      let last: Exclude<ReturnType<typeof replaceInTextblock>, { ok: true }> | null = null
      let done = false
      hit.node.descendants((node, offset) => {
        if (done || node.type.name !== 'paragraph') return !done
        const outcome = replaceInTextblock(tr, node, hit.pos + 1 + offset, op, parse)
        if (outcome.ok) done = true
        else if (outcome.code !== 'text_not_found' || !last) last = outcome
        return false
      })
      if (!done) throw replaceError(last ?? { ok: false, code: 'text_not_found', near: [] }, `形状 ${op.shape_id} `, hit.node.textContent)
      return [op.shape_id]
    }
    case 'add_shape': {
      const hit = find(tr, op.slide_id, 'slide')
      const theme = hit.node.attrs.theme as string | null
      const fill = op.fill !== undefined ? color(op.fill, theme) : null
      const textColor = op.color !== undefined ? color(op.color, theme) : null
      let shape = textBox(op.markdown ?? '', op, op.font_size ?? 18, textColor)
      if (op.geometry || fill) shape = shape.type.create({ ...shape.attrs, kind: 'shape', name: op.geometry ? 'Shape' : 'TextBox', geom: op.geometry ?? 'rect', fill }, shape.content)
      shape = assignIds(shape, ctx.taken)
      // 插在备注之前（slide 内容：shape* notes?）
      const last = hit.node.lastChild
      const at = last?.type.name === 'notes' ? hit.pos + hit.node.nodeSize - 1 - last.nodeSize : hit.pos + hit.node.nodeSize - 1
      tr.insert(at, shape)
      return [shape.attrs.id as string]
    }
    case 'set_xfrm': {
      const hit = find(tr, op.shape_id, 'shape')
      const a = hit.node.attrs
      tr.setNodeMarkup(hit.pos, undefined, {
        ...a,
        x: op.x !== undefined ? emu(op.x) : a.x,
        y: op.y !== undefined ? emu(op.y) : a.y,
        w: op.w !== undefined ? emu(op.w) : a.w,
        h: op.h !== undefined ? emu(op.h) : a.h,
        xfrm_inherited: false,
      })
      return [op.shape_id]
    }
    case 'set_paragraphs': {
      const hit = find(tr, op.shape_id, 'shape')
      if (!EDITABLE_TEXT.has(hit.node.attrs.kind as string)) throw notEditable(hit.node)
      const template = templateOf(hit.node)
      const parse = deckInlineParser(template)
      const old: PMNode[] = []
      hit.node.forEach(c => { if (c.type.name === 'paragraph') old.push(c) })
      const next = op.paragraphs.map((p, i) => {
        const before = old[i]
        const lvl = p.lvl ?? (before?.attrs.lvl as number | undefined) ?? 0
        if (!before) return deckSchema.node('paragraph', { lvl, ppr: template.ppr(lvl) }, parse(p.text))
        const attrs = lvl !== before.attrs.lvl ? { ...before.attrs, lvl, ppr: template.ppr(lvl) } : before.attrs
        return rewriteParagraph(before.type.create(attrs, before.content), p.text, parse)
      })
      const content = next.length > 0 ? next : [deckSchema.node('paragraph')]
      tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, hit.node.type.create(hit.node.attrs, content))
      return [op.shape_id]
    }
    case 'add_table': {
      const hit = find(tr, op.slide_id, 'slide')
      const cols = Math.max(...op.rows.map(r => r.length))
      if (op.rows.some(r => r.length !== cols)) throw new OpError('invalid_table', '每行的单元格数要一样', { hint: `最多的一行有 ${cols} 格；空格写 ""。` })
      const theme = DECK_THEMES[(hit.node.attrs.theme as string | null) ?? DEFAULT_THEME] ?? DECK_THEMES[DEFAULT_THEME]!
      const header = op.header ?? true
      const size = op.font_size ?? 14
      const rows = op.rows.map((row, ri) => deckSchema.node('table_row', null, row.map(text => {
        const isHead = header && ri === 0
        let xml = `<a:rPr ${A_NS} lang="zh-CN" sz="${Math.round(size * 100)}"${isHead ? ' b="1"' : ''} dirty="0"/>`
        xml = rprWithColor(xml, isHead ? 'FFFFFF' : theme.body)
        const inline = toDeckInline(parseInline(text), deckSchema.marks.rpr!.create({ xml }))
        const marked = isHead ? inline.map(n => n.isText ? n.mark(deckSchema.marks.bold!.create().addToSet(n.marks)) : n) : inline
        const fill = isHead ? theme.accent : ri % 2 === 0 ? theme.surface : null
        const tcpr = fill ? `<a:tcPr ${A_NS}><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:tcPr>` : `<a:tcPr ${A_NS}/>`
        return deckSchema.node('table_cell', { tcpr }, [deckSchema.node('paragraph', null, marked)])
      })))
      const h = op.h ?? Math.max(32, Math.round(size * 2.2)) * op.rows.length
      const shape = assignIds(deckSchema.node('shape', {
        kind: 'table', name: 'Table', x: emu(op.x), y: emu(op.y), w: emu(op.w), h: emu(h),
      }, [deckSchema.node('table', null, rows)]), ctx.taken)
      const last = hit.node.lastChild
      const at = last?.type.name === 'notes' ? hit.pos + hit.node.nodeSize - 1 - last.nodeSize : hit.pos + hit.node.nodeSize - 1
      tr.insert(at, shape)
      return [shape.attrs.id as string]
    }
    case 'table_insert_rows': case 'table_delete_rows': case 'table_insert_cols': case 'table_delete_cols': {
      const hit = find(tr, op.shape_id, 'shape')
      const table = hit.node.firstChild
      if (hit.node.attrs.kind !== 'table' || table?.type.name !== 'table') throw new OpError('invalid_structure', `${op.shape_id} 不是表格`)
      const grid: PMNode[][] = []
      table.forEach(r => { const cells: PMNode[] = []; r.forEach(c => cells.push(c)); grid.push(cells) })
      const cols = grid[0]?.length ?? 0
      const count = 'count' in op ? op.count ?? 1 : 1
      let next: PMNode[][]
      if (op.op === 'table_insert_rows') {
        if (op.at > grid.length) throw new OpError('cell_not_found', `插入位置 ${op.at} 超出行数 ${grid.length}`)
        // 沿用相邻正文行的格式（避开表头）
        const tmpl = grid[Math.min(Math.max(op.at, grid.length > 1 ? 1 : 0), grid.length - 1)]!
        const rows = op.rows ?? [Array.from({ length: cols }, () => '')]
        if (rows.some(r => r.length !== cols)) throw new OpError('invalid_table', `每行要有 ${cols} 格`)
        next = [...grid.slice(0, op.at), ...rows.map(r => r.map((text, ci) => cellLike(tmpl[ci]!, text))), ...grid.slice(op.at)]
      } else if (op.op === 'table_delete_rows') {
        if (op.at + count > grid.length) throw new OpError('cell_not_found', `第 ${op.at}–${op.at + count - 1} 行超出行数 ${grid.length}`)
        if (count >= grid.length) throw new OpError('invalid_table', '不能删掉全部行；要删除整个表格用 delete_shape')
        next = [...grid.slice(0, op.at), ...grid.slice(op.at + count)]
      } else if (op.op === 'table_insert_cols') {
        if (op.at > cols) throw new OpError('cell_not_found', `插入位置 ${op.at} 超出列数 ${cols}`)
        if (op.cells && op.cells.length !== grid.length) throw new OpError('invalid_table', `新列要有 ${grid.length} 格（每行一格）`)
        const tc = Math.min(op.at, cols - 1)
        next = grid.map((r, ri) => [...r.slice(0, op.at), cellLike(r[tc]!, op.cells?.[ri] ?? ''), ...r.slice(op.at)])
      } else {
        if (op.at + count > cols) throw new OpError('cell_not_found', `第 ${op.at}–${op.at + count - 1} 列超出列数 ${cols}`)
        if (count >= cols) throw new OpError('invalid_table', '不能删掉全部列；要删除整个表格用 delete_shape')
        next = grid.map(r => [...r.slice(0, op.at), ...r.slice(op.at + count)])
      }
      const rowsNodes = next.map(cells => deckSchema.nodes.table_row!.create(null, cells))
      tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, hit.node.type.create(hit.node.attrs, [table.type.create(table.attrs, rowsNodes)]))
      return [op.shape_id]
    }
    case 'align_shapes': case 'distribute_shapes': {
      const hits = op.shape_ids.map(id => find(tr, id, 'shape'))
      const slides = new Set(hits.map(h => slideAt(tr, h.pos)?.attrs.id))
      if (slides.size > 1) throw new OpError('invalid_structure', '只能对齐同一页上的形状')
      const box = (n: PMNode) => ({ x: n.attrs.x as number, y: n.attrs.y as number, w: n.attrs.w as number, h: n.attrs.h as number })
      const moves = new Map<string, { x?: number; y?: number }>()
      if (op.op === 'align_shapes') {
        const toSlide = (op.to ?? (hits.length > 1 ? 'selection' : 'slide')) === 'slide'
        const boxes = hits.map(h => box(h.node))
        const L = toSlide ? 0 : Math.min(...boxes.map(b => b.x))
        const T = toSlide ? 0 : Math.min(...boxes.map(b => b.y))
        const R = toSlide ? ctx.size.cx : Math.max(...boxes.map(b => b.x + b.w))
        const B = toSlide ? ctx.size.cy : Math.max(...boxes.map(b => b.y + b.h))
        hits.forEach((h, i) => {
          const b = boxes[i]!
          const m = { left: { x: L }, center: { x: Math.round((L + R - b.w) / 2) }, right: { x: R - b.w }, top: { y: T }, middle: { y: Math.round((T + B - b.h) / 2) }, bottom: { y: B - b.h } }[op.align]
          moves.set(h.node.attrs.id as string, m)
        })
      } else {
        const horizontal = op.direction === 'horizontal'
        const sorted = [...hits].sort((a, b) => horizontal ? (a.node.attrs.x as number) - (b.node.attrs.x as number) : (a.node.attrs.y as number) - (b.node.attrs.y as number))
        const start = horizontal ? box(sorted[0]!.node).x : box(sorted[0]!.node).y
        const lastBox = box(sorted.at(-1)!.node)
        const end = horizontal ? lastBox.x + lastBox.w : lastBox.y + lastBox.h
        const total = sorted.reduce((n, h) => n + (horizontal ? box(h.node).w : box(h.node).h), 0)
        const gap = (end - start - total) / (sorted.length - 1)
        let at = start
        for (const h of sorted) {
          moves.set(h.node.attrs.id as string, horizontal ? { x: Math.round(at) } : { y: Math.round(at) })
          at += (horizontal ? box(h.node).w : box(h.node).h) + gap
        }
      }
      for (const [id, m] of moves) {
        const h = find(tr, id, 'shape')
        tr.setNodeMarkup(h.pos, undefined, { ...h.node.attrs, ...m, xfrm_inherited: false })
      }
      return op.shape_ids
    }
    case 'chart_set_data': {
      const hit = find(tr, op.shape_id, 'shape')
      const old = hit.node.attrs.chart as ChartData | null
      if (hit.node.attrs.kind !== 'chart') throw new OpError('invalid_structure', `${op.shape_id} 不是图表`)
      if (!old) throw new OpError('node_not_editable', `图表 ${op.shape_id} 的数据读不出来，不能改`, { hint: '可以删掉它，用 add_chart 重建。' })
      if (!EDITABLE_CHART_TYPES.includes(old.type)) throw new OpError('node_not_editable', `${old.type} 类型的图表暂不支持改数据`)
      const data: ChartData = {
        ...old,
        categories: op.categories ?? old.categories,
        series: op.series.map(s => ({ name: s.name, values: s.values })),
        ...(op.title !== undefined ? { title: op.title } : {}),
      }
      const bad = checkChartData(data)
      if (bad) throw new OpError('invalid_chart', bad)
      tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, chart: data, description: `图表：${data.title || hit.node.attrs.name}` })
      return [op.shape_id]
    }
    case 'chart_set_type': {
      const hit = find(tr, op.shape_id, 'shape')
      const old = hit.node.attrs.chart as ChartData | null
      if (hit.node.attrs.kind !== 'chart') throw new OpError('invalid_structure', `${op.shape_id} 不是图表`)
      if (!old) throw new OpError('node_not_editable', `图表 ${op.shape_id} 的数据读不出来，不能换类型`, { hint: '可以删掉它，用 add_chart 重建。' })
      if (old.type === op.type) return [op.shape_id]
      const data: ChartData = { ...old, type: op.type }
      const bad = checkChartData(data)
      if (bad) throw new OpError('invalid_chart', bad, op.type === 'pie' || op.type === 'doughnut' ? { hint: '饼图 / 圆环图只能有一个系列：先用 chart_set_data 留下一个系列再换类型。' } : {})
      const attrs = { ...hit.node.attrs, chart: data }
      if (!hit.node.attrs.chart_part) {
        tr.setNodeMarkup(hit.pos, undefined, attrs)
        return [op.shape_id]
      }
      // 导入的图表：原图表部件绑定原类型，换类型就按新图表导出——换一个新 id（不再沿用原文件里的形状与图表部件）
      const fresh = assignIds(deckSchema.node('shape', { ...attrs, id: null, chart_part: null }), ctx.taken)
      tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, fresh)
      return [fresh.attrs.id as string]
    }
    case 'add_chart': {
      const hit = find(tr, op.slide_id, 'slide')
      const theme = DECK_THEMES[(hit.node.attrs.theme as string | null) ?? DEFAULT_THEME] ?? DECK_THEMES[DEFAULT_THEME]!
      const data: ChartData = {
        type: op.type, categories: op.categories, series: op.series.map(s => ({ name: s.name, values: s.values })),
        ...(op.title ? { title: op.title } : {}),
        // 系列（饼图是扇区）颜色：主题强调色在前
        colors: [theme.accent, theme.accent2, '10B981', '8B5CF6', 'EF4444', theme.muted],
      }
      const bad = checkChartData(data)
      if (bad) throw new OpError('invalid_chart', bad)
      const shape = assignIds(deckSchema.node('shape', {
        kind: 'chart', name: 'Chart', chart: data, description: `图表：${op.title || '新图表'}`,
        x: emu(op.x), y: emu(op.y), w: emu(op.w), h: emu(op.h),
      }), ctx.taken)
      const last = hit.node.lastChild
      const at = last?.type.name === 'notes' ? hit.pos + hit.node.nodeSize - 1 - last.nodeSize : hit.pos + hit.node.nodeSize - 1
      tr.insert(at, shape)
      return [shape.attrs.id as string]
    }
    case 'set_fill': {
      const hit = find(tr, op.shape_id, 'shape')
      if (!['text', 'shape'].includes(hit.node.attrs.kind as string)) throw new OpError('node_not_editable', `形状 ${op.shape_id}（${hit.node.attrs.kind}）不能设置填充`)
      tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, fill: color(op.color, slideAt(tr, hit.pos)?.attrs.theme) })
      return [op.shape_id]
    }
    case 'set_background': {
      const hit = find(tr, op.slide_id, 'slide')
      const bg = color(op.color, hit.node.attrs.theme)
      if (bg === 'none') throw new OpError('invalid_color', '背景不能是 none，请给一个颜色')
      tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, bg })
      return [op.slide_id]
    }
    case 'set_text_style': {
      const hit = find(tr, op.shape_id, 'shape')
      if (!EDITABLE_TEXT.has(hit.node.attrs.kind as string) && hit.node.attrs.kind !== 'table') throw notEditable(hit.node)
      const theme = slideAt(tr, hit.pos)?.attrs.theme as string | null
      const style: TextStyle = {
        color: op.color !== undefined ? color(op.color, theme) : undefined,
        size: op.size, font_family: op.font_family, bold: op.bold, italic: op.italic, align: op.align,
      }
      if (style.color === 'none') throw new OpError('invalid_color', '文字颜色不能是 none')
      let index = 0
      let touched = false
      const next = mapParagraphs(hit.node, p => {
        const mine = op.paragraph === undefined || index === op.paragraph
        index++
        if (!mine) return p
        touched = true
        return styledParagraph(p, style)
      })
      if (!touched) throw new OpError('paragraph_not_found', `形状 ${op.shape_id} 没有第 ${(op.paragraph ?? 0) + 1} 段`, { hint: `共 ${index} 段，从 0 起。` })
      tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, next)
      return [op.shape_id]
    }
    case 'add_image': {
      const hit = find(tr, op.slide_id, 'slide')
      const asset = ctx.asset?.(op.asset_id)
      if (!asset) throw new OpError('asset_not_found', `找不到图片资产 ${op.asset_id}`, { hint: '先用 asset_upload 上传图片文件，拿到 asset_id。' })
      if (!/^image\/(png|jpeg|gif)$/.test(asset.mime)) throw new OpError('invalid_asset', `资产 ${op.asset_id} 不是 PNG / JPEG / GIF 图片（${asset.mime}）`)
      let h = op.h
      if (h === undefined) {
        const size = imageSize(asset.bytes)
        h = size ? op.w * size.height / size.width : op.w * 0.75
      }
      const shape = assignIds(deckSchema.node('shape', {
        kind: 'image', name: 'Picture', asset_id: op.asset_id, description: op.description ?? '',
        x: emu(op.x), y: emu(op.y), w: emu(op.w), h: emu(h),
      }), ctx.taken)
      const last = hit.node.lastChild
      const at = last?.type.name === 'notes' ? hit.pos + hit.node.nodeSize - 1 - last.nodeSize : hit.pos + hit.node.nodeSize - 1
      tr.insert(at, shape)
      if (op.credit?.trim()) {
        // 署名追加到演讲备注末尾（导出 pptx 时在备注页里）
        const slide = find(tr, op.slide_id, 'slide')
        const credit = deckParagraphs(op.credit.trim(), { ppr: () => null, rpr: null })
        const notes = slide.node.lastChild
        const end = slide.pos + slide.node.nodeSize - 1
        if (notes?.type.name === 'notes') tr.insert(end - 1, credit)
        else tr.insert(end, deckSchema.node('notes', null, credit))
      }
      return [shape.attrs.id as string]
    }
    case 'set_z': {
      const hit = find(tr, op.shape_id, 'shape')
      const slidePos = tr.doc.resolve(hit.pos).before(1)
      const slide = tr.doc.nodeAt(slidePos)!
      const shapes: PMNode[] = []
      let notes: PMNode | null = null
      slide.forEach(n => { if (n.type.name === 'notes') notes = n; else shapes.push(n) })
      const from = shapes.findIndex(n => n.attrs.id === op.shape_id)
      const to = op.to === 'front' ? shapes.length - 1 : op.to === 'back' ? 0 : op.to === 'forward' ? Math.min(shapes.length - 1, from + 1) : Math.max(0, from - 1)
      const [moved] = shapes.splice(from, 1)
      shapes.splice(to, 0, moved!)
      tr.replaceWith(slidePos, slidePos + slide.nodeSize, slide.type.create(slide.attrs, notes ? [...shapes, notes] : shapes))
      return [op.shape_id]
    }
    case 'apply_theme': {
      if (!DECK_THEMES[op.theme]) throw new OpError('theme_not_found', `没有主题「${op.theme}」`, { hint: `可用主题：${BUILTIN_THEME_KEYS.join('、')}；本机构模板用 deck_templates 查` })
      const ids: string[] = []
      const hits: Array<{ slide: PMNode; offset: number }> = []
      tr.doc.forEach((slide, offset) => {
        if (op.slide_ids && !op.slide_ids.includes(slide.attrs.id as string)) return
        hits.push({ slide, offset })
        ids.push(slide.attrs.id as string)
      })
      // 从后往前替换：换装饰会改变页的大小，前面的位置不受影响
      for (const { slide, offset } of hits.reverse()) {
        tr.replaceWith(offset, offset + slide.nodeSize, assignIds(themedSlide(slide, op.theme, ctx.platform), ctx.taken))
      }
      if (op.slide_ids) for (const id of op.slide_ids) if (!ids.includes(id)) throw new OpError('node_not_found', `找不到幻灯片 ${id}`)
      return ids
    }
    case 'delete_shape': {
      const hit = find(tr, op.shape_id, 'shape')
      tr.delete(hit.pos, hit.pos + hit.node.nodeSize)
      return [op.shape_id]
    }
    case 'set_notes': {
      const hit = find(tr, op.slide_id, 'slide')
      const paragraphs = deckParagraphs(op.markdown, { ppr: () => null, rpr: null })
      const notes = deckSchema.node('notes', null, paragraphs)
      const last = hit.node.lastChild
      if (last?.type.name === 'notes') {
        const at = hit.pos + hit.node.nodeSize - 1 - last.nodeSize
        tr.replaceWith(at, at + last.nodeSize, paragraphs.length > 0 ? notes : Fragment.empty)
      } else if (paragraphs.length > 0) {
        tr.insert(hit.pos + hit.node.nodeSize - 1, notes)
      }
      return [op.slide_id]
    }
    case 'table_set_cells': {
      const hit = find(tr, op.shape_id, 'shape')
      const table = hit.node.firstChild
      if (hit.node.attrs.kind !== 'table' || table?.type.name !== 'table') throw new OpError('invalid_structure', `${op.shape_id} 不是表格`)
      const rows: PMNode[][] = []
      table.forEach(r => { const cells: PMNode[] = []; r.forEach(c => cells.push(c)); rows.push(cells) })
      for (const c of op.cells) {
        const cell = rows[c.row]?.[c.col]
        if (!cell) throw new OpError('cell_not_found', `表格 ${op.shape_id} 没有单元格 (${c.row}, ${c.col})`, { hint: `共 ${rows.length} 行；下标从 0 开始。` })
        const paragraphs = deckParagraphs(c.markdown, templateOf(deckSchema.node('shape', null, [deckSchema.node('table', null, [deckSchema.node('table_row', null, [cell])])])))
        rows[c.row]![c.col] = cell.type.create(cell.attrs, paragraphs.length > 0 ? paragraphs : [deckSchema.node('paragraph')])
      }
      const next = hit.node.type.create(hit.node.attrs, [deckSchema.node('table', null, rows.map(r => deckSchema.node('table_row', null, r)))])
      tr.replaceWith(hit.pos, hit.pos + hit.node.nodeSize, next)
      return [op.shape_id]
    }
  }
}

function notEditable(shape: PMNode): OpError {
  return new OpError('node_not_editable', `形状 ${shape.attrs.id}（${shape.attrs.kind}）的内容不可编辑`, { hint: '不可编辑形状只能移动（set_xfrm）或删除（delete_shape）。' })
}

function textBox(markdown: string, box: { x: number; y: number; w: number; h: number }, fontSize: number, textColor: string | null = null): PMNode {
  let xml = `<a:rPr ${A_NS} lang="zh-CN" sz="${Math.round(fontSize * 100)}" dirty="0"/>`
  if (textColor && textColor !== 'none') xml = rprWithColor(xml, textColor)
  const rpr = deckSchema.marks.rpr!.create({ xml })
  const paragraphs = deckParagraphs(markdown, { ppr: () => null, rpr })
  return deckSchema.node('shape', { kind: 'text', name: 'TextBox', x: emu(box.x), y: emu(box.y), w: emu(box.w), h: emu(box.h) }, paragraphs.length > 0 ? paragraphs : [deckSchema.node('paragraph')])
}

function insertSlide(tr: Transform, slide: PMNode, after: string | null): void {
  if (after === null) { tr.insert(0, slide); return }
  const hit = find(tr, after, 'slide')
  tr.insert(hit.pos + hit.node.nodeSize, slide)
}

const PH_SHAPE_NAME: Record<string, string> = { ctrTitle: 'Title', title: 'Title', subTitle: 'Subtitle' }

/** 占位符的段落属性：对齐、有无项目符号，以及版式规定的字号 / 粗细 / 颜色（a:defRPr，还没写字时也带着）。 */
function specPpr(spec: PhSpec, color: string): string {
  const marg = spec.bullets ? '' : ' marL="0" indent="0"'
  const algn = spec.align === 'ctr' ? ' algn="ctr"' : ''
  return `<a:pPr ${A_NS}${marg}${algn}>${spec.bullets ? '' : '<a:buNone/>'}<a:defRPr sz="${spec.size * 100}"${spec.bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:defRPr></a:pPr>`
}

function specParagraphs(spec: PhSpec, themeKey: string, markdown?: string): PMNode[] {
  const color = resolveColor(spec.color, themeKey)!
  const ppr = specPpr(spec, color)
  const rpr = deckSchema.marks.rpr!.create({ xml: `<a:rPr ${A_NS} lang="zh-CN" sz="${spec.size * 100}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr>` })
  const paragraphs = markdown ? deckParagraphs(markdown, { ppr: () => ppr, rpr, bold: spec.bold }) : []
  return paragraphs.length > 0 ? paragraphs : [deckSchema.node('paragraph', { ppr, align: alignOf(ppr) })]
}

/** 模板装饰形状（最底层；名字 deco: 开头）。 */
function decoShapes(themeKey: string, key: LayoutKey): PMNode[] {
  return decorations(themeKey, key).map(d => d.image
    ? deckSchema.node('shape', { kind: 'image', name: d.name, asset_id: d.image, description: d.credit ?? '', x: emu(d.box[0]), y: emu(d.box[1]), w: emu(d.box[2]), h: emu(d.box[3]) })
    : d.text ? decoText(d)
    : deckSchema.node('shape', {
      kind: 'shape', name: d.name, geom: d.geom, fill: d.fill, x: emu(d.box[0]), y: emu(d.box[1]), w: emu(d.box[2]), h: emu(d.box[3]),
    }))
}

/** 文字装饰（机构名称）：一段固定字号、颜色的文字，名字 deco: 开头，不能改字。 */
function decoText(d: { name: string; box: [number, number, number, number]; text?: { value: string; size: number; color: string; align: 'l' | 'r' } }): PMNode {
  const t = d.text!
  const ppr = `<a:pPr ${A_NS} marL="0" indent="0"${t.align === 'r' ? ' algn="r"' : ''}><a:buNone/></a:pPr>`
  const rpr = deckSchema.marks.rpr!.create({ xml: `<a:rPr ${A_NS} lang="zh-CN" sz="${Math.round(t.size * 100)}" dirty="0"><a:solidFill><a:srgbClr val="${t.color}"/></a:solidFill></a:rPr>` })
  return deckSchema.node('shape', { kind: 'text', name: d.name, x: emu(d.box[0]), y: emu(d.box[1]), w: emu(d.box[2]), h: emu(d.box[3]) },
    [deckSchema.node('paragraph', { ppr, align: alignOf(ppr) }, [deckSchema.text(t.value, [rpr])])])
}

/**
 * 平台模板的一页：版式的全部文字占位符（按模板几何与样式，没给文字的留空）+ 模板装饰。
 * themeKey 为 null（早期没套过模板的 deck）时不加装饰、不设主题，样式按默认模板。
 */
export function templateSlide(key: LayoutKey, themeKey: string | null, texts: { title?: string; body?: string; body2?: string } = {}): PMNode {
  const k = themeKey && DECK_THEMES[themeKey] ? themeKey : DEFAULT_THEME
  const def = layoutDef(key)
  const shapes: PMNode[] = themeKey ? decoShapes(k, key) : []
  for (const spec of layoutSpec(k, key)) {
    if (spec.type === 'pic') continue // 图片区：装饰里的底色块标出位置，图片用 add_image 放上去
    shapes.push(deckSchema.node('shape', {
      kind: 'text', ph: spec.type, ph_idx: spec.idx, x: emu(spec.box[0]), y: emu(spec.box[1]), w: emu(spec.box[2]), h: emu(spec.box[3]), xfrm_inherited: true,
      name: PH_SHAPE_NAME[spec.type] ?? 'Content',
    }, specParagraphs(spec, k, spec.fill ? texts[spec.fill] : undefined)))
  }
  const theme = themeKey ? { theme: k, bg: themeOf(k).bg } : {}
  return deckSchema.node('slide', { layout: `ppt/slideLayouts/slideLayout${def.n}.xml`, layout_name: def.name, ...theme }, shapes)
}

/** 平台模板新建 deck 的初始内容：一页封面（标题填好，副标题留空）。 */
export function newTemplateDeck(title: string, themeKey: string = DEFAULT_THEME): PMNode {
  return deckSchema.node('doc', null, [templateSlide('cover', DECK_THEMES[themeKey] ? themeKey : DEFAULT_THEME, { title: title ? escapeMarkdown(title) : undefined })])
}

/** 标题原样当文字（不按 markdown 解析）。 */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]#<>|~])/g, '\\$1')
}

/** 新建 deck 的初始内容：一页「标题页」版式（标题、副标题占位符留空）。 */
export function newDeckContent(layouts: LayoutInfo[], title = ''): PMNode {
  const layout = layouts.find(l => /title slide|标题幻灯片/i.test(l.name)) ?? layouts[0]
  const shapes: PMNode[] = []
  for (const ph of layout?.placeholders ?? []) {
    if (!['ctrTitle', 'title', 'subTitle'].includes(ph.type)) continue
    shapes.push(deckSchema.node('shape', {
      kind: 'text', ph: ph.type, ph_idx: ph.idx, x: ph.x, y: ph.y, w: ph.w, h: ph.h, xfrm_inherited: true,
      name: ph.type === 'subTitle' ? 'Subtitle' : 'Title',
    }, [deckSchema.node('paragraph', null, ph.type !== 'subTitle' && title ? [deckSchema.text(title)] : [])]))
  }
  return deckSchema.node('doc', null, [deckSchema.node('slide', { layout: layout?.part ?? null, layout_name: layout?.name ?? '' }, shapes)])
}

// —— 样式（颜色、字号、对齐、主题） ——

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

function color(value: string, theme: unknown): string {
  const c = resolveColor(value, theme as string | null)
  if (!c) throw new OpError('invalid_color', `颜色「${value}」无效`, { hint: '用 6 位十六进制（如 0EA5E9）或主题记号 accent / accent2 / title / body / muted / bg / surface。' })
  return c
}

/** 位置所在的幻灯片。 */
function slideAt(tr: Transform, pos: number): PMNode | null {
  const $pos = tr.doc.resolve(pos)
  return $pos.depth >= 1 ? $pos.node(1) : tr.doc.nodeAt(pos)
}

interface TextStyle { color?: string; size?: number; font_family?: string; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right' | 'justify' }

/** a:rPr 片段设颜色：替换顶层的填充（不动 a:ln 里的线条填充）。 */
export function rprWithColor(xml: string, hex: string): string {
  const fill = `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`
  const self = /^(<a:rPr\b[^>]*?)\s*\/>$/.exec(xml.trim())
  if (self) return `${self[1]}>${fill}</a:rPr>`
  const m = /^(<a:rPr\b[^>]*>)([\s\S]*)(<\/a:rPr>)$/.exec(xml.trim())
  if (!m) return xml
  const ln = /<a:ln\b[^>]*?\/>|<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/.exec(m[2]!)?.[0] ?? ''
  const rest = m[2]!.replace(ln, '').replace(/<a:(solidFill|gradFill|pattFill)\b[^>]*>[\s\S]*?<\/a:\1>|<a:noFill\s*\/>/g, '')
  return `${m[1]}${ln}${fill}${rest}${m[3]}`
}

function rprWithSize(xml: string, size: number): string {
  const sz = String(Math.round(size * 100))
  return /\ssz="[^"]*"/.test(xml) ? xml.replace(/\ssz="[^"]*"/, ` sz="${sz}"`) : xml.replace(/^<a:rPr\b/, `<a:rPr sz="${sz}"`)
}

export function rprWithFont(xml: string, font: string): string {
  const clean = font.split(',')[0]!.trim().replace(/^['"]+|['"]+$/g, '')
  const escFont = (clean || font).replace(/"/g, '&quot;')
  const fontTags = `<a:latin typeface="${escFont}"/><a:ea typeface="${escFont}"/>`
  const self = /^(<a:rPr\b[^>]*?)\s*\/>$/.exec(xml.trim())
  if (self) return `${self[1]}>${fontTags}</a:rPr>`
  let res = xml
  if (/<a:latin\b[^>]*\/>/.test(res)) res = res.replace(/<a:latin\b[^>]*\/>/, `<a:latin typeface="${escFont}"/>`)
  else res = res.replace(/<\/a:rPr>/, `<a:latin typeface="${escFont}"/></a:rPr>`)
  if (/<a:ea\b[^>]*\/>/.test(res)) res = res.replace(/<a:ea\b[^>]*\/>/, `<a:ea typeface="${escFont}"/>`)
  else res = res.replace(/<\/a:rPr>/, `<a:ea typeface="${escFont}"/></a:rPr>`)
  return res
}

const ALGN = { left: 'l', center: 'ctr', right: 'r', justify: 'just' } as const

function styledParagraph(p: PMNode, style: TextStyle): PMNode {
  const content: PMNode[] = []
  p.forEach(child => {
    if (!child.isText) { content.push(child); return }
    let marks = child.marks
    if (style.color || style.size || style.font_family) {
      let xml = (marks.find(m => m.type.name === 'rpr')?.attrs.xml as string | undefined) ?? `<a:rPr ${A_NS} lang="zh-CN" dirty="0"/>`
      if (style.color) xml = rprWithColor(xml, style.color)
      if (style.size) xml = rprWithSize(xml, style.size)
      if (style.font_family) xml = rprWithFont(xml, style.font_family)
      marks = deckSchema.marks.rpr!.create({ xml }).addToSet(marks.filter(m => m.type.name !== 'rpr'))
    }
    for (const [key, type] of [['bold', deckSchema.marks.bold!], ['italic', deckSchema.marks.italic!]] as const) {
      if (style[key] === true) marks = type.create().addToSet(marks)
      if (style[key] === false) marks = type.removeFromSet(marks)
    }
    content.push(child.mark(marks))
  })
  let attrs = p.attrs
  if (style.align) {
    const ppr = (p.attrs.ppr as string | null) ?? `<a:pPr ${A_NS}/>`
    const algn = ALGN[style.align]
    const nextPpr = /\salgn="[^"]*"/.test(ppr) ? ppr.replace(/\salgn="[^"]*"/, ` algn="${algn}"`) : ppr.replace(/^<a:pPr\b/, `<a:pPr algn="${algn}"`)
    attrs = { ...attrs, ppr: nextPpr, align: style.align === 'left' ? null : style.align }
  }
  return p.type.create(attrs, content, p.marks)
}

/** 形状里的每个段落（含表格单元格里的）按 fn 替换。 */
function mapParagraphs(node: PMNode, fn: (p: PMNode) => PMNode): PMNode {
  if (node.type.name === 'paragraph') return fn(node)
  if (node.isLeaf) return node
  const children: PMNode[] = []
  node.forEach(c => children.push(mapParagraphs(c, fn)))
  return node.type.create(node.attrs, children, node.marks)
}

/**
 * 套用主题：背景、标题 / 正文颜色；原来用上一个主题强调色、卡片色的填充换成新主题的。
 * 平台模板的 deck（platform）：再换掉模板装饰；版式里的占位符按新模板的样式着色、对齐，
 * 位置继承自版式的（没被拖动过）挪到新模板的位置；早期的英文版式名换成模板版式名。
 */
export function themedSlide(slide: PMNode, themeKey: string, platform = false): PMNode {
  const theme = DECK_THEMES[themeKey] ?? DECK_THEMES[DEFAULT_THEME]!
  // 没套过主题的页按默认主题算（主题记号一直按默认主题取色）
  const old = DECK_THEMES[(slide.attrs.theme as string | null) ?? DEFAULT_THEME] ?? null
  const def = platform ? layoutByName(slide.attrs.layout_name as string) : null
  const specs = def ? layoutSpec(themeKey, def.key) : []
  const shapes: PMNode[] = def ? decoShapes(themeKey, def.key) : []
  slide.forEach(shape => {
    if (shape.type.name !== 'shape') { shapes.push(shape); return }
    if (isDecoName(shape.attrs.name)) { if (!def) shapes.push(shape); return }
    const spec = def && shape.attrs.kind === 'text' ? phSpecOf(specs, shape.attrs.ph as string | null, shape.attrs.ph_idx as string | null) : null
    if (spec && spec.type !== 'pic') {
      const color = resolveColor(spec.color, themeKey)!
      const box = shape.attrs.xfrm_inherited ? { x: emu(spec.box[0]), y: emu(spec.box[1]), w: emu(spec.box[2]), h: emu(spec.box[3]) } : {}
      const restyled = mapParagraphs(shape, p => {
        const ppr = specPpr(spec, color)
        return styledParagraph(p.type.create({ ...p.attrs, ppr, align: alignOf(ppr) }, p.content, p.marks), { color })
      })
      shapes.push(restyled.type.create({ ...shape.attrs, ...box }, restyled.content, restyled.marks))
      return
    }
    const ph = shape.attrs.ph as string | null
    const isTitle = ph === 'title' || ph === 'ctrTitle'
    let attrs = shape.attrs
    if (old && attrs.fill === old.accent) attrs = { ...attrs, fill: theme.accent }
    else if (old && attrs.fill === old.accent2) attrs = { ...attrs, fill: theme.accent2 }
    else if (old && attrs.fill === old.surface) attrs = { ...attrs, fill: theme.surface }
    if (attrs.kind === 'table') { shapes.push(shape.type.create(attrs, [themedTable(shape.firstChild!, theme, old)], shape.marks)); return }
    // 实心色块上的文字保持原色（多为反白），其余按标题 / 正文着色
    const onFill = attrs.fill && attrs.fill !== 'none'
    const restyled = onFill || !['text', 'shape'].includes(attrs.kind as string)
      ? shape
      : mapParagraphs(shape, p => styledParagraph(p, { color: isTitle ? theme.title : ph === 'subTitle' ? theme.muted : theme.body }))
    shapes.push(restyled.type.create(attrs, restyled.content, restyled.marks))
  })
  const layout = def ? { layout: `ppt/slideLayouts/slideLayout${def.n}.xml`, layout_name: def.name } : {}
  return slide.type.create({ ...slide.attrs, ...layout, theme: themeKey, bg: theme.bg }, shapes)
}

/**
 * 把一段改写成新文字：在单独的小文档里对这一段做最小差异替换（同 replace_text），没变的字保留原格式、引用、评论标记。
 */
function rewriteParagraph(paragraph: PMNode, text: string, parse: (md: string) => PMNode[]): PMNode {
  const doc = deckSchema.node('doc', null, [deckSchema.node('slide', null, [deckSchema.node('shape', null, [paragraph])])])
  const tr = new Transform(doc)
  const pos = 2 // doc → slide（内容起点 1）→ shape（内容起点 2）→ 段落
  const current = paragraphMarkdownText(paragraph)
  if (current === text) return paragraph
  if (current === '') {
    tr.replaceWith(pos + 1, pos + 1 + paragraph.content.size, parse(text))
  } else {
    const outcome = replaceInTextblock(tr, paragraph, pos, { find: current, replace: text }, parse)
    if (!outcome.ok) throw replaceError(outcome, '段落', paragraph.textContent)
  }
  return tr.doc.child(0).child(0).child(0)
}

/** 段落的文字（引用写成 [@c:id]、硬换行写成换行；与 replace_text 匹配用的文字一致）。 */
function paragraphMarkdownText(p: PMNode): string {
  let out = ''
  p.forEach(c => {
    if (c.isText) out += c.text
    else if (c.type.name === 'citation') out += `[@c:${c.attrs.cite_id}]`
    else if (c.type.name === 'hard_break') out += '\n'
  })
  return out
}

/** 套主题时的表格：表头 / 交替行底色换成新主题的强调色 / 卡片色；有强调色底的单元格保持白字，其余用正文色。 */
function themedTable(table: PMNode, theme: (typeof DECK_THEMES)[string], old: (typeof DECK_THEMES)[string] | null): PMNode {
  const rows: PMNode[] = []
  table.forEach(row => {
    const cells: PMNode[] = []
    row.forEach(cell => {
      const tcpr = (cell.attrs.tcpr as string | null) ?? ''
      const fill = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(tcpr)?.[1]?.toUpperCase()
      let next = tcpr
      if (fill && old && fill === old.accent) next = tcpr.replace(fill, theme.accent)
      else if (fill && old && fill === old.surface) next = tcpr.replace(fill, theme.surface)
      const head = !!fill && (fill === theme.accent || fill === old?.accent)
      const styled = mapParagraphs(cell, p => styledParagraph(p, { color: head ? 'FFFFFF' : theme.body }))
      cells.push(cell.type.create({ ...cell.attrs, tcpr: next || cell.attrs.tcpr }, styled.content))
    })
    rows.push(row.type.create(row.attrs, cells))
  })
  return table.type.create(table.attrs, rows)
}

/** 新单元格：沿用参照单元格的底色（tcPr）与文字格式（a:rPr），填入新文字。 */
function cellLike(ref: PMNode, text: string): PMNode {
  const rpr = templateOf(deckSchema.node('shape', null, [deckSchema.node('table', null, [deckSchema.node('table_row', null, [ref])])])).rpr
  let bold = false
  ref.descendants(n => { if (n.isText && n.marks.some(m => m.type.name === 'bold')) bold = true; return !bold })
  let inline = toDeckInline(parseInline(text), rpr)
  if (bold) inline = inline.map(n => n.isText ? n.mark(deckSchema.marks.bold!.create().addToSet(n.marks)) : n)
  const ppr = ref.firstChild?.attrs.ppr ?? null
  return ref.type.create({ ...ref.attrs, colspan: 1, rowspan: 1 }, [deckSchema.node('paragraph', { ppr }, inline)])
}
