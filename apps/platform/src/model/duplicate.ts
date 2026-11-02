import { randomUUID } from 'node:crypto'
import type { Node as PMNode } from 'prosemirror-model'
import type { DocRow } from '../store/db.ts'
import type { Documents } from './runtime.ts'

/**
 * 复制文档（R2）：内容、引用与测量登记（都换新 id，正文里的引用 / 测量标记跟着改；测量的快照与来源一并复制，
 * 副本里的读者看到什么仍按各自对来源的权限决定）、所在项目；幻灯片连同原始 pptx 包与形状原文
 * （修补式导出依赖它们）。评论、版本历史、对话不复制。
 */
export function duplicateDoc(docs: Documents, row: DocRow, owner: string): DocRow {
  const store = docs.store
  const citations = store.listCitations(row.id)
  const ids = new Map(citations.map(c => [c.id, 'c' + randomUUID().replace(/-/g, '').slice(0, 7)]))
  const measurements = store.listMeasurements(row.id)
  const mids = new Map(measurements.map(m => [m.id, 'm' + randomUUID().replace(/-/g, '').slice(0, 7)]))
  const remap = (n: PMNode): PMNode => {
    if (n.type.name === 'citation' && ids.has(n.attrs.cite_id as string)) return n.type.create({ ...n.attrs, cite_id: ids.get(n.attrs.cite_id as string) }, null, n.marks)
    if (n.type.name === 'measurement' && mids.has(n.attrs.m_id as string)) return n.type.create({ ...n.attrs, m_id: mids.get(n.attrs.m_id as string) }, null, n.marks)
    if (n.isLeaf) return n
    const children: PMNode[] = []
    n.forEach(c => children.push(remap(c)))
    return n.type.create(n.attrs, children, n.marks)
  }
  const copy = docs.create({ owner, title: `${row.title}（副本）`, kind: row.kind, content: remap(docs.get(row.id)), source: 'create' })
  for (const c of citations) store.insertCitation({ ...c, id: ids.get(c.id)!, doc_id: copy.id })
  for (const m of measurements) store.insertMeasurement({ ...m, id: mids.get(m.id)!, doc_id: copy.id })
  const strict = store.measurementStrict(row.id)
  if (strict !== null) store.setMeasurementStrict(copy.id, strict, owner)
  if (row.project_id) store.setDocProject(copy.id, row.project_id)
  const pkg = store.getPackage(row.id)
  if (pkg) store.putPackage(copy.id, row.kind === 'deck' ? 'pptx' : 'docx', pkg)
  store.copyNodeSrc(row.id, copy.id)
  return store.getDoc(copy.id)!
}
