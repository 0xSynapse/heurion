import { strToU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { importDocx } from '../src/convert/docx-import.ts'
import { serializeBlocks } from '../src/model/markdown.ts'
import { docx, li, p } from './fixtures.ts'

describe('docx 导入', () => {
  it('标题、格式、列表嵌套、表格合并、修订、超链接', () => {
    const body = [
      p('引言', '<w:pStyle w:val="Heading1"/>'),
      `<w:p><w:r><w:t>心衰</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>高发</w:t></w:r><w:ins><w:r><w:t>（新增）</w:t></w:r></w:ins><w:del><w:r><w:delText>删掉</w:delText></w:r></w:del><w:hyperlink r:id="rId9"><w:r><w:t>链接</w:t></w:r></w:hyperlink></w:p>`,
      p('方法', '<w:pStyle w:val="2"/>'),
      li('第一步', 0), li('细节', 1), li('第二步', 0),
      `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>`,
      '<w:customXml><w:p><w:r><w:t>奇怪的结构</w:t></w:r></w:p></w:customXml>',
    ].join('')
    const r = importDocx(docx(body))
    const blocks: ReturnType<typeof r.doc.child>[] = []
    r.doc.forEach(n => blocks.push(n))
    // 含修订的段落 → 待采纳修订：原文版本（待删除）+ 修订版（待新增）
    expect(blocks.map(b => b.type.name)).toEqual(['heading', 'paragraph', 'paragraph', 'heading', 'ordered_list', 'table', 'opaque'])
    expect(blocks[3]!.attrs.level).toBe(2)
    expect([blocks[1]!.attrs.suggest, blocks[2]!.attrs.suggest]).toEqual(['delete', 'insert'])
    expect(blocks[2]!.attrs.suggest_of).toBe(blocks[1]!.attrs.id)
    const md = serializeBlocks(blocks)
    expect(md).toContain('心衰**高发**删掉[链接](https://example.org)')
    expect(md).toContain('心衰**高发**（新增）[链接](https://example.org)')
    // 嵌套列表：第一步下挂一个子列表
    const list = blocks[4]!
    expect(list.childCount).toBe(2)
    expect(list.child(0).child(1).type.name).toBe('bullet_list')
    // vMerge → rowspan 2，续行的单元格被吸收
    expect(blocks[5]!.child(0).child(1).attrs.rowspan).toBe(2)
    expect(blocks[5]!.child(1).childCount).toBe(1)
    // 每个块都有 id；原始 XML 对得上
    r.doc.descendants(n => { if (['heading', 'paragraph', 'table', 'opaque', 'list_item'].includes(n.type.name)) expect(n.attrs.id).toBeTruthy() })
    expect(r.src.length).toBeGreaterThanOrEqual(6)
    expect(r.src.find(s => s.node_id === blocks[0]!.attrs.id)?.xml).toContain('引言')
  })

  it('非 docx 报错', () => {
    expect(() => importDocx(strToU8('not a zip'))).toThrow(/docx/)
  })
})
