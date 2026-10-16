import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { stateToDoc, writeFragment } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'

const bold = schema.marks.bold!.create()
const comment = schema.marks.comment!.create({ thread: 't1' })
const cite = schema.nodes.citation!.create({ cite_id: 'cx' })
/** 引用之后的文字只改格式：y-prosemirror 1.3.7 不更新这种格式变化，需要 writeFragment 修补。 */
const doc = (tail: Parameters<typeof schema.text>[1], extra = '') => schema.node('doc', null, [
  schema.node('paragraph', { id: 'p1' }, [schema.text('HR ', [comment]), schema.text('0.80', [bold, comment]), cite, schema.text('。尾。' + extra, tail)]),
  schema.node('paragraph', { id: 'p2' }, [schema.text('other')]),
])
const text = (ydoc: Y.Doc) => stateToDoc(Y.encodeStateAsUpdate(ydoc)).child(0).textContent
const firstText = (frag: Y.XmlFragment) => (frag.get(0) as Y.XmlElement).get(0) as Y.XmlText

describe('Yjs 写入核对：原地修补格式', () => {
  it('只改格式的修补不替换 Yjs 元素', () => {
    const ydoc = new Y.Doc()
    ydoc.transact(() => writeFragment(ydoc, doc([bold])))
    const frag = ydoc.getXmlFragment('body')
    const before = frag.get(0)
    ydoc.transact(() => writeFragment(ydoc, doc([comment])))
    expect(frag.get(0)).toBe(before)
    expect(stateToDoc(Y.encodeStateAsUpdate(ydoc)).eq(doc([comment]))).toBe(true)
  })

  it('协作者在同一段的并发输入不丢', () => {
    const ydoc = new Y.Doc()
    ydoc.transact(() => writeFragment(ydoc, doc([bold])))
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc))
    ydoc.transact(() => writeFragment(ydoc, doc([comment])))
    remote.transact(() => firstText(remote.getXmlFragment('body')).insert(0, 'CONCURRENT '))
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(ydoc)))
    expect(text(ydoc)).toBe('CONCURRENT HR 0.80。尾。')
  })

  it('撤销触发修补的回合：只撤该回合，用户之后的输入保留', () => {
    const ydoc = new Y.Doc()
    ydoc.transact(() => writeFragment(ydoc, doc([bold])))
    const frag = ydoc.getXmlFragment('body')
    const turn = { turn: 'T1' }
    const undo = new Y.UndoManager(frag, { trackedOrigins: new Set([turn]), captureTimeout: 1e15 })
    ydoc.transact(() => writeFragment(ydoc, doc([comment], 'AI加的')), turn)
    ydoc.transact(() => firstText(frag).insert(0, 'LATER '))
    while (undo.canUndo()) undo.undo()
    expect(text(ydoc)).toBe('LATER HR 0.80。尾。')
  })

  it('之后的提交修补了上一回合改过的块，撤销上一回合仍然生效', () => {
    const ydoc = new Y.Doc()
    ydoc.transact(() => writeFragment(ydoc, doc([bold])))
    const frag = ydoc.getXmlFragment('body')
    const turn = { turn: 'T1' }
    const undo = new Y.UndoManager(frag, { trackedOrigins: new Set([turn]), captureTimeout: 1e15 })
    ydoc.transact(() => writeFragment(ydoc, doc([bold], 'AI加的')), turn)
    ydoc.transact(() => writeFragment(ydoc, doc([comment], 'AI加的')), { user: true })
    while (undo.canUndo()) undo.undo()
    expect(text(ydoc)).toBe('HR 0.80。尾。')
  })

  it('前部插入新章节且尾部同时修改时：按块 id 对齐，不覆写中间章节的 Y.XmlElement，并发编辑不产生重复章节', () => {
    const initial = schema.node('doc', null, [
      schema.node('heading', { id: 'h1', level: 1 }, [schema.text('引言')]),
      schema.node('paragraph', { id: 'p1' }, [schema.text('引言段落。')]),
      schema.node('heading', { id: 'h2', level: 1 }, [schema.text('方法')]),
      schema.node('paragraph', { id: 'p2' }, [schema.text('方法段落。')]),
      schema.node('heading', { id: 'h3', level: 1 }, [schema.text('讨论')]),
      schema.node('paragraph', { id: 'p3' }, [schema.text('讨论原稿。')]),
    ])
    const ydoc = new Y.Doc()
    ydoc.transact(() => writeFragment(ydoc, initial))
    const frag = ydoc.getXmlFragment('body')
    const h2ElemBefore = frag.get(2)
    const p2ElemBefore = frag.get(3)
    const p3ElemBefore = frag.get(5)

    // 模拟远端客户端同时在「方法段落」末尾输入文字
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc))
    remote.transact(() => {
      const remoteP2 = (remote.getXmlFragment('body').get(3) as Y.XmlElement).get(0) as Y.XmlText
      remoteP2.insert(remoteP2.length, '补充说明。')
    })

    // 服务端在同一批次中：在「引言」后插入新章节，并修改「讨论」段落
    const updated = schema.node('doc', null, [
      schema.node('heading', { id: 'h1', level: 1 }, [schema.text('引言')]),
      schema.node('paragraph', { id: 'p1' }, [schema.text('引言段落。')]),
      schema.node('heading', { id: 'h_new', level: 1 }, [schema.text('研究背景')]),
      schema.node('paragraph', { id: 'p_new' }, [schema.text('新增背景段落。')]),
      schema.node('heading', { id: 'h2', level: 1 }, [schema.text('方法')]),
      schema.node('paragraph', { id: 'p2' }, [schema.text('方法段落。')]),
      schema.node('heading', { id: 'h3', level: 1 }, [schema.text('讨论')]),
      schema.node('paragraph', { id: 'p3' }, [schema.text('讨论修订稿。')]),
    ])
    ydoc.transact(() => writeFragment(ydoc, updated))

    // 中间「方法」章节的 Y.XmlElement 身份保持不变，尾部「讨论」段落也是原地更新
    expect(frag.get(4)).toBe(h2ElemBefore)
    expect(frag.get(5)).toBe(p2ElemBefore)
    expect(frag.get(7)).toBe(p3ElemBefore)

    // 合并远端并发修改后，章节顺序与数量完全正确，无重复章节
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(ydoc)))
    const merged = stateToDoc(Y.encodeStateAsUpdate(ydoc))
    const headings: string[] = []
    merged.forEach(n => {
      if (n.type.name === 'heading') headings.push(n.textContent)
    })
    expect(headings).toEqual(['引言', '研究背景', '方法', '讨论'])
    expect(merged.child(5).textContent).toBe('方法段落。补充说明。')
    expect(merged.child(7).textContent).toBe('讨论修订稿。')
  })
})

