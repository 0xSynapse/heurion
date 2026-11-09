import { describe, expect, it } from 'vitest'
import { docParserToDoc, mergeContinuedTables, richText, scriptedText, type DocParserBlock } from '../src/convert/doc-parser.ts'
import { cellPlainText, sentenceTexts } from '../src/claims/extract.ts'
import { tidyPopplerBlocks } from '../src/convert/pdf-import.ts'
import { schema } from '../src/model/schema.ts'

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

describe('poppler 兜底路径的版面整理', () => {
  it('标题合并放最前；页眉、坐标轴数字、作者行、正文前的版面标题还原或去掉；断段接上', () => {
    type B = Parameters<typeof tidyPopplerBlocks>[0][number]
    const h = (text: string, level = 3): B => ({ kind: 'heading', level, text, top: 0 })
    const p = (text: string): B => ({ kind: 'paragraph', text, top: 0 })
    const out = tidyPopplerBlocks([
      h('Clinical epidemiology of', 2), h('hypertension in rural Thailand', 2), h('Original Research'),
      h('Smith 1,2 Lee 3 Wong 1'), h('Abstract'), p('Body text.'), h('Articles'), h('12'),
      h('miRNA-200a and miRNA-200b expression in obesity'), p('The data collection consisted of three parts and was performed at'),
      { kind: 'figure', key: 'k', caption: '', top: 0 }, p('primary care units by well trained staff.'), h('Articles'), h('Articles'),
    ], 'Clinical epidemiology of hypertension in rural Thailand')
    expect(out.filter(b => b.kind === 'heading').map(b => (b as { text: string }).text)).toEqual([
      'Clinical epidemiology of hypertension in rural Thailand', 'Abstract', 'miRNA-200a and miRNA-200b expression in obesity',
    ])
    expect(out.some(b => b.kind === 'paragraph' && b.text === 'Original Research')).toBe(true)
    expect(out.some(b => b.kind === 'paragraph' && b.text.endsWith('performed at primary care units by well trained staff.'))).toBe(true)
  })
})

describe('表格单元格的上下标（cell_marks）', () => {
  it('按格加格式；审稿读格子时上标两边加空格，脚注号不会粘进数值', () => {
    const { doc } = docParserToDoc({
      engine: 'docling', page_count: 1, warnings: [], scanned_pages: [],
      blocks: [{ type: 'table', header_rows: 1, rows: [['Item', 'P'], ['Stroke', '0.751'], ['WBC', '10.2×109/L']], cell_marks: [[1, 1, [[4, 5, 'sup']]], [2, 1, [[7, 8, 'sup']]]] }],
    }, 'x')
    const sups: string[] = []
    doc.descendants(n => { if (n.isText && n.marks.some(m => m.type.name === 'sup')) sups.push(n.text!); return true })
    expect(sups).toEqual(['1', '9'])
    const cells: string[] = []
    doc.descendants(n => { if (n.type.name === 'table_cell') { cells.push(cellPlainText(n)); return false } return true })
    expect(cells).toEqual(['Item', 'P', 'Stroke', '0.75 1', 'WBC', '10.2×10 9 /L'])
  })

  it('续表合并时格式的行号跟着下移', () => {
    const head = ['Variable', 'Value']
    const out = mergeContinuedTables([
      { type: 'table', rows: [head, ['Age', '37']], header_rows: 1, caption: 'Table 1. Baseline.', page: 1 },
      { type: 'table', rows: [head, ['BMI', '26 a']], header_rows: 1, caption: 'Table 1. Cont.', page: 2, cell_marks: [[1, 1, [[3, 4, 'sup']]]] },
    ])
    expect((out[0] as Extract<DocParserBlock, { type: 'table' }>).cell_marks).toEqual([[2, 1, [[3, 4, 'sup']]]])
  })
})

describe('审稿断句认得句末上标引用', () => {
  it('「months.²³ Gender …」在上标后切开，句子是原文子串', () => {
    const sup = schema.marks.sup!.create()
    const p = schema.node('paragraph', null, [
      schema.text('Follow-up ranged from 4 weeks'), schema.text('29', [sup]), schema.text(' to 12 months.'), schema.text('23', [sup]),
      schema.text(' Gender ranged from roughly equal (placebo group 47% male'), schema.text('31', [sup]),
      schema.text(') to female only.'), schema.text('28', [sup]), schema.text(' The remainder are summarized in Table 1. Done.'),
    ])
    const s = sentenceTexts(p)
    expect(s).toEqual([
      'Follow-up ranged from 4 weeks29 to 12 months.23',
      'Gender ranged from roughly equal (placebo group 47% male31) to female only.28',
      'The remainder are summarized in Table 1.', 'Done.',
    ])
    for (const x of s) expect(p.textContent).toContain(x)
  })
})

describe('PDF 文字层给出的上下标与斜体（doc-parser marks）', () => {
  const runs = (nodes: ReturnType<typeof richText>) => nodes.map(n => [n.text, n.marks.map(m => m.type.name).join(',')])

  it('按范围加格式；其余部分仍按规则补上标', () => {
    const t = '  M. tuberculosis risk3,4. BMI 26 kg/m 2 overall'
    // 范围按原文（含开头空白）的下标
    const nodes = richText(t, [[2, 17, 'italic'], [22, 25, 'sup']])
    expect(runs(nodes)).toEqual([
      ['M. tuberculosis', 'italic'], [' risk', ''], ['3,4', 'sup'], ['. BMI 26 kg/m', ''], ['2', 'sup'], [' overall', ''],
    ])
  })

  it('重叠、越界、不认识的范围丢弃', () => {
    const nodes = richText('abc def', [[0, 3, 'sup'], [2, 5, 'sub'], [4, 99, 'bold'], [5, 3, 'italic']])
    expect(runs(nodes)).toEqual([['abc', 'sup'], [' def', '']])
  })

  it('段落与标题都用 marks 生成', () => {
    const { doc } = docParserToDoc({
      engine: 'docling', page_count: 1, warnings: [], scanned_pages: [],
      blocks: [
        { type: 'heading', level: 2, text: 'Effect of CO2 exposure', marks: [[12, 13, 'sub']] },
        { type: 'paragraph', text: 'by 106 fold', marks: [[5, 6, 'sup']] },
      ],
    }, 'x')
    const marked: string[] = []
    doc.descendants(n => { if (n.isText && n.marks.length) marked.push(`${n.text}:${n.marks[0]!.type.name}`) })
    expect(marked).toEqual(['2:sub', '6:sup'])
    expect(doc.textContent).toBe('Effect of CO2 exposureby 106 fold')
  })
})
