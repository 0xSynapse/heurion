import { parseBlocks } from '../src/model/markdown.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'

export function setup(markdown?: string) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)
  const content = markdown ? schema.node('doc', null, parseBlocks(markdown)) : undefined
  const row = docs.create({ owner: 'u1', title: '测试', content })
  return { store, docs, ops, docId: row.id }
}

/** 顶层块 id 列表。 */
export function ids(docs: Documents, docId: string): string[] {
  const out: string[] = []
  docs.get(docId).forEach(n => out.push(n.attrs.id as string))
  return out
}

/**
 * Word XML 接受全部修订后的样子：去掉 w:del（含删除的文字），拆掉 w:ins 外壳（插入的文字留下）。
 * 导出时 AI 未确认的文字写成 AI 名下的修订，检查「改完后的文字」时用它。
 */
export function acceptAll(xml: string): string {
  return xml.replace(/<w:del\b[^>]*\/>/g, '').replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, '').replace(/<w:ins\b[^>]*\/>/g, '').replace(/<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>/g, '$1')
}
/** Word XML 里显示出来的文字：各 w:t 的内容依次拼接（不靠删标签，不会把别的标签内容当成文字） */
export const wordText = (xml: string): string => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(m => m[1]).join('')
/** 接受全部修订后的纯文字 */
export const acceptedText = (xml: string): string => wordText(acceptAll(xml))
