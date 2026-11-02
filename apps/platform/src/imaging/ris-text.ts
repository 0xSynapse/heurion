import type { Node as PMNode } from 'prosemirror-model'
import { measureExportText, type MeasureLookup } from '../model/measurements.ts'
import { withoutPending } from '../ops/suggest.ts'

/**
 * 「复制为 RIS 纯文本」（PRD W4.5 一期，T2.6）：把报告正文转成可直接粘贴进 RIS 报告框的纯文字。
 *
 * - 一段一行（段内换行保留），不输出任何 markdown / HTML 记号：标题不带 #，加粗等格式去掉，列表项用「· 」或「1. 」；
 * - 测量原子展开为「数值 单位」（按读者权限取当前值，与界面一致）；来源失效的在数字后注明〔…〕（与其它导出相同，不悄悄输出失效数字）；
 * - 不出现内部 id：块 id、[@m:…] / [@c:…] / [@w:…] 记号一律不输出（文字里写着的字面量记号也去掉并提示）；
 * - 图、不可编辑块不输出；引用、Word 域代码去掉；表格按行转成文字。这些都在 notes 里提示。
 * 待采纳修订按未采纳的原稿输出（与 markdown / docx 导出一致）。
 */

const INTERNAL = /\[@[cmw]:[^\]\s]*\]|\{#[a-z][a-z0-9]{2,15}\}/g
// 零宽字符、BOM：RIS 里看不见但会干扰检索与字数
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g

export interface RisText { text: string; notes: string[] }

export function risPlainText(doc: PMNode, opts: { exclude?: ReadonlySet<string>; measurements?: MeasureLookup } = {}): RisText {
  const notes = new Set<string>()
  const lines: string[] = []
  const inline = (node: PMNode): string => {
    let s = ''
    node.forEach(c => {
      if (c.isText) {
        const raw = c.text ?? ''
        const clean = raw.replace(INTERNAL, '')
        if (clean !== raw) notes.add('正文里有字面量的内部记号（[@m:…] / {#…} 等），已去掉')
        s += clean
      } else if (c.type.name === 'hard_break') s += '\n'
      else if (c.type.name === 'measurement') s += measureExportText(opts.measurements?.get(String(c.attrs.m_id)), String(c.attrs.m_id))
      else if (c.type.name === 'citation') notes.add('引用标记不进入 RIS 纯文本')
      else if (c.type.name === 'word_inline') notes.add('Word 脚注 / 域代码不进入 RIS 纯文本')
      else if (c.isInline && c.textContent) s += c.textContent
    })
    return s.replace(INVISIBLE, '').replace(/[ \t]+\n/g, '\n').trim()
  }
  const block = (node: PMNode, prefix = ''): void => {
    const name = node.type.name
    if (node.isTextblock) {
      const t = inline(node)
      if (t) lines.push(prefix + t)
      return
    }
    if (name === 'bullet_list' || name === 'ordered_list') {
      let n = (node.attrs.start as number | undefined) ?? 1
      node.forEach(item => {
        const marker = name === 'bullet_list' ? '· ' : `${n++}. `
        let first = true
        item.forEach(child => { block(child, first ? prefix + marker : prefix + '  '); first = false })
      })
      return
    }
    if (name === 'table') {
      notes.add('表格已按行转为文字（单元格之间用两个空格分隔）')
      node.forEach(row => {
        const cells: string[] = []
        row.forEach(cell => { const parts: string[] = []; cell.forEach(p => { if (p.isTextblock) { const t = inline(p); if (t) parts.push(t) } }); cells.push(parts.join(' ')) })
        const line = cells.join('  ').trim()
        if (line) lines.push(prefix + line)
      })
      return
    }
    if (name === 'figure') { notes.add('图不进入 RIS 纯文本'); return }
    if (name === 'opaque') { notes.add('不可编辑的内容（文本框、公式等）不进入 RIS 纯文本'); return }
    // 其余容器（列表项、引用块等）：逐个子块
    node.forEach(child => block(child, prefix))
  }
  withoutPending(doc).forEach(node => {
    if (opts.exclude && node.attrs.id && opts.exclude.has(String(node.attrs.id))) return
    block(node)
  })
  return { text: lines.join('\n'), notes: [...notes] }
}
