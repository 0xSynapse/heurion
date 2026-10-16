import type { Node as PMNode } from 'prosemirror-model'
import { schema } from './schema.ts'

/**
 * 表格的逻辑网格：按 colspan / rowspan 把单元格摆到 (行, 列) 坐标上。
 * 读视图、表格操作与 markdown 解析共用这一套坐标，保证 AI 看到的行列号就是操作用的行列号。
 */
export interface GridCell {
  node: PMNode
  top: number
  left: number
  rowspan: number
  colspan: number
}

export interface Grid {
  width: number
  height: number
  cells: GridCell[]
  /** 覆盖 (row, col) 的单元格；参差表格的空位为 undefined。 */
  at(row: number, col: number): GridCell | undefined
}

export function readGrid(table: PMNode): Grid {
  const height = table.childCount
  const slots: Array<Array<GridCell | undefined>> = Array.from({ length: height }, () => [])
  const cells: GridCell[] = []
  table.forEach((row, _o, r) => {
    let c = 0
    row.forEach(node => {
      while (slots[r]![c]) c++
      const colspan = Math.max(1, node.attrs.colspan as number)
      // 跨行合并超出表格底部的部分截掉
      const rowspan = Math.max(1, Math.min(node.attrs.rowspan as number, height - r))
      const cell: GridCell = { node, top: r, left: c, rowspan, colspan }
      cells.push(cell)
      for (let dr = 0; dr < rowspan; dr++) for (let dc = 0; dc < colspan; dc++) slots[r + dr]![c + dc] = cell
      c += colspan
    })
  })
  const width = Math.max(0, ...slots.map(s => s.length))
  return { width, height, cells, at: (row, col) => slots[row]?.[col] }
}

/** 由网格单元格重建表格节点；某行没有任何以它为起点的单元格时返回该行号（调用方报错）。 */
export function buildFromGrid(cells: readonly GridCell[], height: number, tableAttrs: Record<string, unknown>): PMNode | { emptyRow: number } {
  const rows: PMNode[][] = Array.from({ length: height }, () => [])
  for (const cell of [...cells].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const attrs = { ...cell.node.attrs, colspan: cell.colspan, rowspan: cell.rowspan }
    rows[cell.top]!.push(cell.node.type.create(attrs, cell.node.content, cell.node.marks))
  }
  const empty = rows.findIndex(r => r.length === 0)
  if (empty !== -1) return { emptyRow: empty }
  return schema.node('table', tableAttrs, rows.map(r => schema.node('table_row', null, r)))
}
