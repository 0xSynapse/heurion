import type { Node as PMNode } from 'prosemirror-model'

/**
 * 原文件未显式标注 <w:tblHeader/> 时，判断表格首行是否像「重复表头」：
 * 至少两列，每格不超过两个段落、不含换行、文字不超过 80 字。
 * 单列的表单型表格（如申报书章节表）或长文本首行不算表头。
 * 导入（docx-import）与导出（docx-export）共用此规则，避免两边阈值漂移。
 */
export function looksLikeHeaderRow(cells: ReadonlyArray<ReadonlyArray<PMNode>>): boolean {
  return cells.length >= 2 && cells.every(paras => {
    if (paras.length > 2) return false
    let len = 0
    let hasBr = false
    for (const p of paras) {
      len += p.textContent.length
      p.forEach(ch => { if (ch.type.name === 'hard_break') hasBr = true })
    }
    return !hasBr && len <= 80
  })
}
