import { z } from 'zod'

/** doc_edit 的操作（PLATFORM.md §6.3）。 */
export const DocOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insert_after'),
    anchor_id: z.string().min(1).describe('插入到该块之后'),
    markdown: z.string().min(1).describe('一个或多个块的 markdown'),
  }),
  z.object({
    op: z.literal('insert_before'),
    anchor_id: z.string().min(1).describe('插入到该块之前'),
    markdown: z.string().min(1),
  }),
  z.object({
    op: z.literal('replace_block'),
    id: z.string().min(1),
    markdown: z.string().describe('替换后的 markdown；可以是多个块，第一个块沿用原 id'),
  }),
  z.object({
    op: z.literal('replace_text'),
    id: z.string().min(1).describe('段落或标题 id'),
    find: z.string().min(1).describe('块内要替换的原文（逐字复制，不含 {#id} 前缀）'),
    replace: z.string().describe('替换为的行内 markdown；空串表示删除'),
    occurrence: z.number().int().min(1).optional().describe('原文在块内出现多次时指定第几处（从 1 开始）'),
  }),
  z.object({ op: z.literal('delete'), ids: z.array(z.string().min(1)).min(1) }),
  z.object({
    op: z.literal('move'),
    ids: z.array(z.string().min(1)).min(1).describe('按此顺序移动的块'),
    after: z.string().nullable().describe('移动到该块之后；null 表示文档开头'),
  }),
  z.object({
    op: z.literal('set_block_style'),
    id: z.string().min(1),
    type: z.enum(['paragraph', 'heading']).optional(),
    level: z.number().int().min(1).max(6).optional().describe('标题级别'),
    align: z.enum(['left', 'center', 'right', 'justify']).nullable().optional(),
    style: z.string().nullable().optional().describe('Word 段落样式名，如 Quote'),
  }),
  z.object({
    op: z.literal('set_text_style'),
    id: z.string().min(1).describe('段落或标题 id'),
    font_family: z.string().optional().describe('字体名称，如 PingFang SC, SimSun, Arial, Times New Roman'),
    size: z.union([z.number(), z.string()]).optional().describe('字号大小（如 16 或 "16px"）'),
    bold: z.boolean().optional().describe('是否加粗'),
    italic: z.boolean().optional().describe('是否斜体'),
    color: z.string().optional().describe('文字颜色十六进制或颜色名'),
    range: z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }).optional().describe('选区相对段落起点，缺省为整段'),
  }),
  z.object({
    op: z.literal('table_set_cells'),
    id: z.string().min(1),
    cells: z.array(z.object({
      row: z.number().int().min(0),
      col: z.number().int().min(0),
      markdown: z.string().describe('单元格行内 markdown；多行用 <br>'),
    })).min(1),
  }),
  z.object({
    op: z.literal('table_insert_rows'),
    id: z.string().min(1),
    at: z.number().int().min(0).describe('插入位置（行下标，等于行数时追加到末尾）'),
    rows: z.array(z.array(z.string())).min(1).describe('每行的单元格行内 markdown'),
  }),
  z.object({
    op: z.literal('table_delete_rows'),
    id: z.string().min(1),
    at: z.number().int().min(0),
    count: z.number().int().min(1).default(1),
  }),
  z.object({
    op: z.literal('table_insert_cols'),
    id: z.string().min(1),
    at: z.number().int().min(0).describe('插入位置（列下标，等于列数时追加到最右）'),
    cells: z.array(z.string()).optional().describe('新列自上而下每行的单元格行内 markdown；缺省为空'),
  }),
  z.object({
    op: z.literal('table_delete_cols'),
    id: z.string().min(1),
    at: z.number().int().min(0),
    count: z.number().int().min(1).default(1),
  }),
  z.object({
    op: z.literal('table_merge_cells'),
    id: z.string().min(1),
    row: z.number().int().min(0),
    col: z.number().int().min(0),
    rows: z.number().int().min(1).default(1).describe('合并区域的行数'),
    cols: z.number().int().min(1).default(1).describe('合并区域的列数'),
  }),
  z.object({
    op: z.literal('table_split_cell'),
    id: z.string().min(1),
    row: z.number().int().min(0).describe('合并单元格左上角的行'),
    col: z.number().int().min(0).describe('合并单元格左上角的列'),
  }),
  z.object({
    op: z.literal('table_set_header'),
    id: z.string().min(1),
    rows: z.number().int().min(0).describe('开头几行作为表头（跨页重复）；0 = 没有表头'),
  }),
  z.object({
    op: z.literal('table_set_style'),
    id: z.string().min(1),
    col_widths: z.array(z.number().positive()).nullable().optional().describe('各列相对宽度（如 [1, 3] 表示 1:3）；null = 恢复默认'),
    cells: z.array(z.object({
      row: z.number().int().min(0),
      col: z.number().int().min(0),
      background: z.string().regex(/^(#?[0-9a-fA-F]{6})?$/).nullable().optional().describe('底纹色 #RRGGBB；空串 = 去掉底纹；null = 恢复原样'),
      valign: z.enum(['top', 'center', 'bottom']).nullable().optional(),
    })).optional(),
  }),
])

export type DocOp = z.infer<typeof DocOp>

export const EditBatch = z.object({
  doc_id: z.string().min(1),
  base_rev: z.number().int().min(0).describe('读视图返回的 rev'),
  mode: z.enum(['apply', 'suggest']).default('apply'),
  ack_comments: z.array(z.string()).optional().describe('确认会移除锚点的 open 评论线程 id'),
  dry_run: z.boolean().optional().describe('试探预检模式：仅执行写前守卫与语法校验，不提交改动'),
  ops: z.array(DocOp).min(1).max(50),
})

export type EditBatch = z.infer<typeof EditBatch>

/** 操作层的结构化错误（PLATFORM.md §5.3）。 */
export class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: { op_index?: number; hint?: string; current?: unknown } = {},
  ) {
    super(message)
  }

  toJSON() {
    return { code: this.code, message: this.message, ...this.extra }
  }
}

/** 操作的目标块 id（冲突守卫用）。 */
export function targetIds(op: DocOp): string[] {
  switch (op.op) {
    case 'insert_after':
    case 'insert_before':
      return []
    case 'delete':
    case 'move':
      return op.ids
    default:
      return [op.id]
  }
}

/** 操作里出现的全部 markdown 文本（引用守卫用）。 */
export function opTexts(op: DocOp): string[] {
  switch (op.op) {
    case 'insert_after':
    case 'insert_before':
    case 'replace_block':
      return [op.markdown]
    case 'replace_text':
      return [op.replace]
    case 'table_set_cells':
      return op.cells.map(c => c.markdown)
    case 'table_insert_rows':
      return op.rows.flat()
    case 'table_insert_cols':
      return op.cells ?? []
    default:
      return []
  }
}
