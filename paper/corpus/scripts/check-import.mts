// 用 Heurion 自己的 Word 导入器解析测试稿，统计引用原子、修订块、批注、警告
// 用法（在 apps/platform 下）：node_modules/.bin/tsx ../../paper/corpus/scripts/check-import.mts ../../paper/corpus
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
const { importDocx } = await import(join(process.cwd(), 'src/convert/docx-import.ts'))

for (const id of readdirSync(join(root, 'out')).filter((d) => /^[QP]\d\d$/.test(d)).sort()) {
  const meta = JSON.parse(readFileSync(join(root, 'out', id, 'meta.json'), 'utf8'))
  const r = importDocx(new Uint8Array(readFileSync(join(root, 'out', id, 'manuscript.docx'))))
  const counts: Record<string, number> = {}
  let citeAtoms = 0, suggest = 0, text = ''
  r.doc.descendants((n: any) => {
    counts[n.type.name] = (counts[n.type.name] || 0) + 1
    if (n.attrs?.suggest_of || n.attrs?.suggest_author) suggest++
    if (n.isText) text += n.text
    for (const v of Object.values(n.attrs ?? {})) if (typeof v === 'string' && v.startsWith('w:')) citeAtoms++
  })
  const atomTypes = Object.entries(counts).filter(([k]) => !['doc', 'text', 'paragraph', 'heading'].includes(k)).map(([k, v]) => `${k}:${v}`).join(' ')
  console.log(JSON.stringify({ id, mode: meta.citation_mode, expectCites: meta.citations, suggest, comments: r.comments.length, warnings: r.warnings.slice(0, 3), atomTypes, rawCiteMarkers: (text.match(/\[@w:/g) || []).length }))
}
