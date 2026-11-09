import { describe, expect, it } from 'vitest'
import { docParserToDoc, mergeContinuedTables, scriptedText, type DocParserBlock } from '../src/convert/doc-parser.ts'

const HEAD = ['Variables', 'Control (n = 30)', 'Itraconazole (n = 30)']
const t = (page: number, rows: string[][], caption?: string): DocParserBlock => ({ type: 'table', rows, header_rows: 1, page, ...(caption ? { caption } : {}) })
const rowsOf = (b: DocParserBlock | undefined) => (b?.type === 'table' ? b.rows : null)

describe('PDF 续表：续表表题的各种写法', () => {
  it('「Table 1. Cont.」「TABLE 1 (Continued)」是续表表题，可连续跨几页', () => {
    const out = mergeContinuedTables([
      t(6, [HEAD, ['Age', '54.7', '53.9']], 'Table 1. Demographic data.'),
      t(7, [HEAD, ['Weight', '79.2', '84.9']], 'Table 1. Cont.'),
      t(8, [HEAD, ['BMI', '29.5', '31.8']], 'TABLE 1 (Continued)'),
    ])
    expect(out).toHaveLength(1)
    expect(rowsOf(out[0])).toEqual([HEAD, ['Age', '54.7', '53.9'], ['Weight', '79.2', '84.9'], ['BMI', '29.5', '31.8']])
  })

  it('明确写着续表时允许同一页（并排排版）、允许隔着表注；表注移到合并后的表格后面', () => {
    const out = mergeContinuedTables([
      t(6, [HEAD, ['Age', '1', '2']], 'Table 3 | Baseline characteristics'),
      { type: 'paragraph', text: 'Moxi, moxibustion; TCM, traditional Chinese medicine.', page: 6 },
      t(6, [HEAD, ['Sex', '3', '4']], 'Table 3 (continued) | Baseline characteristics'),
    ])
    expect(out.map(b => b.type)).toEqual(['table', 'paragraph'])
    expect(rowsOf(out[0])).toEqual([HEAD, ['Age', '1', '2'], ['Sex', '3', '4']])
  })

  it('不合并：续表表题的表号不同；没写续表时不跨表注、不在同一页', () => {
    expect(mergeContinuedTables([t(1, [HEAD, ['a', '1', '2']], 'Table 1. A'), t(2, [HEAD, ['b', '1', '2']], 'Table 2. Cont.')])).toHaveLength(2)
    expect(mergeContinuedTables([t(1, [HEAD, ['a', '1', '2']]), { type: 'paragraph', text: 'Note.', page: 1 }, t(2, [HEAD, ['b', '1', '2']])])).toHaveLength(3)
    expect(mergeContinuedTables([t(1, [HEAD, ['a', '1', '2']]), t(1, [HEAD, ['b', '1', '2']])])).toHaveLength(2)
  })
})

describe('PDF 上标还原', () => {
  const view = (s: string) => scriptedText(s).map(n => (n.marks.some(m => m.type.name === 'sup') ? `^${n.text}` : n.text)).join('')

  it('单位指数、I² / R² / χ²、10⁹/L 标成上标，文字里的数字不变', () => {
    expect(view('BMI (kg/m 2 )')).toBe('BMI (kg/m^2 )')
    expect(view('BSA (m 2 ), eGFR (ml/min/1.73 m 2 )')).toBe('BSA (m^2 ), eGFR (ml/min/1.73 m^2 )')
    expect(view('Not serious, I 2 = 91.55%')).toBe('Not serious, I^2 = 91.55%')
    expect(view('R 2 = 0.42; χ 2 test')).toBe('R^2 = 0.42; χ^2 test')
    expect(view('WBC 10 9 /L')).toBe('WBC 10^9 /L')
  })

  it('不像指数的不动：普通数字、小数、组别', () => {
    for (const s of ['n = 2 groups', 'arm 2 (n = 30)', 'm 2.5 cm', 'Group I 20 patients', '10 mg/L']) expect(view(s)).toBe(s)
  })

  it('导入的段落与表格单元格都带上标；公式段落保持原文', () => {
    const { doc } = docParserToDoc({
      engine: 'docling', page_count: 1, blocks: [
        { type: 'paragraph', text: 'Mean BMI was 29 kg/m 2 at baseline.', page: 1 },
        { type: 'table', rows: [['BMI (kg/m 2 )', 'I 2 = 0%'], ['29', '1']], header_rows: 1, page: 1 },
        { type: 'formula', latex: 'x = m 2', page: 1 },
      ], scanned_pages: [], warnings: [],
    }, 't')
    const sups: string[] = []
    doc.descendants(n => { if (n.isText && n.marks.some(m => m.type.name === 'sup')) sups.push(n.text!); return true })
    expect(sups).toEqual(['2', '2', '2'])
    expect(doc.textContent).toContain('Mean BMI was 29 kg/m2 at baseline.')
    expect(doc.textContent).toContain('$$x = m 2$$')
  })
})
