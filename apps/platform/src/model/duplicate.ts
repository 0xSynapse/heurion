import { randomUUID } from 'node:crypto'
import type { Node as PMNode } from 'prosemirror-model'
import type { DocRow } from '../store/db.ts'
import type { Documents } from './runtime.ts'

/**
 * 复制文档（R2）：内容、引用（换新 id，正文里的引用标记跟着改）、所在项目；幻灯片连同原始 pptx 包与形状原文
 * （修补式导出依赖它们）。评论、版本历史、对话不复制。
 */
export function duplicateDoc(docs: Documents, row: DocRow, owner: string): DocRow {
  docs.flush(row.id)
  const store = docs.store
  const citations = store.listCitations(row.id)
  const ids = new Map(citations.map(c => [c.id, 'c' + randomUUID().replace(/-/g, '').slice(0, 7)]))
  const remap = (n: PMNode): PMNode => {
    if (n.type.name === 'citation' && ids.has(n.attrs.cite_id as string)) return n.type.create({ ...n.attrs, cite_id: ids.get(n.attrs.cite_id as string) }, null, n.marks)
    if (n.isLeaf) return n
    const children: PMNode[] = []
    n.forEach(c => children.push(remap(c)))
    return n.type.create(n.attrs, children, n.marks)
  }
  const current = docs.get(row.id)
  const first = store.listVersions(row.id).at(-1)
  const base = first?.source === 'import' ? docs.versionDoc(row.id, first.seq) : null
  const copy = docs.create({
    owner,
    title: `${row.title}（副本）`,
    kind: row.kind,
    content: remap(base ?? current),
    source: base ? 'import' : 'create',
  })
  if (base && !base.eq(current)) {
    docs.commit(copy.id, remap(current), { actor: 'user', turnId: null, ops: [] })
  }
  for (const c of citations) store.insertCitation({ ...c, id: ids.get(c.id)!, doc_id: copy.id })
  if (row.project_id) store.setDocProject(copy.id, row.project_id)
  const pkg = store.getPackage(row.id)
  if (pkg) {
    const isZip = pkg.length >= 4 && pkg[0] === 0x50 && pkg[1] === 0x4B
    store.putPackage(copy.id, !isZip ? 'pdf' : row.kind === 'deck' ? 'pptx' : 'docx', pkg)
  }
  store.copyNodeSrc(row.id, copy.id)
  return store.getDoc(copy.id)!
}
