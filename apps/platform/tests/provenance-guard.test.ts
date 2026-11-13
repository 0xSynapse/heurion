/**
 * 来源等级第 2 期（docs/design/PROVENANCE.md）：规则一（AI 不能降低来源等级：改人写的文字只有安全小改直接生效，
 * 其余整批转为待采纳修订）与规则二（新写的数字要有出处，新插的引用要有保存的原文）。
 */
import type { Node as PMNode } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { toolCallsOf, toolResultOf, toolResultText } from '../src/harness/events.ts'
import { read } from '../src/views/read.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { TurnService } from '../src/turns/service.ts'
import { parseBlocks } from '../src/model/markdown.ts'
import { aiSpans, hasAiText } from '../src/model/provenance.ts'
import { Documents } from '../src/model/runtime.ts'
import { schema } from '../src/model/schema.ts'
import { allNumbers, checkableNumbers, isLiteratureTool, numberObserved } from '../src/ops/numbers.ts'
import { OpService } from '../src/ops/service.ts'
import { OpError } from '../src/ops/types.ts'
import { Store } from '../src/store/db.ts'

const SAMPLE = `# 结果

在 120 名患者中，pCR 率为 37%，R0 切除率为 97%。

本研究提示新辅助治疗可能有效。`

function setup(markdown = SAMPLE) {
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs, undefined, undefined, { provenance: true })
  const row = docs.create({ owner: 'u1', title: '测试', content: schema.node('doc', null, parseBlocks(markdown)) })
  const ids: string[] = []
  docs.get(row.id).forEach(n => ids.push(n.attrs.id as string))
  return { store, docs, ops, docId: row.id, ids }
}

const AI = (turnId: string | null = 't1', observe: string | null = 't1') => ({ actor: 'ai' as const, turnId, observe })
const code = (fn: () => unknown): string => { try { fn() } catch (err) { if (err instanceof OpError) return err.code; throw err } return 'ok' }
const hasSuggestions = (doc: PMNode) => { let s = false; doc.descendants(n => { if (n.attrs.suggest) s = true; return !s }); return s }

describe('数字的提取与匹配', () => {
  it('名称里的数字不算；区间的连接号不是负号；小整数和年份不核对', () => {
    expect(allNumbers('COVID-19 与 IL-6、CD8 无关，HR 0.82（95% CI 0.40–1.69）')).toEqual([0.82, 95, 0.4, 1.69])
    expect(checkableNumbers('随访 3 年（2024 年）共 120 例，P = 0.032，下降 12.5%').map(n => n.raw)).toEqual(['120', '0.032', '12.5%'])
  })

  it('允许四舍五入与百分数换算', () => {
    const [n1] = checkableNumbers('36.7%')
    expect(numberObserved(n1!, [0.366666])).toBe(true)
    const [n2] = checkableNumbers('0.37')
    expect(numberObserved(n2!, [0.366666])).toBe(true)
    const [n3] = checkableNumbers('36.9%')
    expect(numberObserved(n3!, [0.366666])).toBe(false)
  })

  it('从 dsh 的工具结果事件里取文字（含 shell / Python 输出）', () => {
    const n = { method: 'session.event', params: { sessionId: 's', event: { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'pCR = 0.3667 (11/30)' }] } } } } }
    expect(toolResultText(n as never)).toBe('pCR = 0.3667 (11/30)')
  })

  it('回合里：shell 结果的数字记为看到过，文献检索结果的数字不记（另一项研究的数字须同句引用）', async () => {
    const { store, docs, docId } = setup()
    const ev = (event: object) => ({ method: 'session.event', params: { sessionId: 'sub', event } }) as never
    const pool = {
      liveSession: () => 's',
      cancel: async () => {},
      run: async (_u: string, _p: string, on: (n: never, s: string) => void) => {
        on(ev({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'mcp__heurion__pubmed_search', arguments: '{}' }, { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' }] } } }), 's')
        on(ev({ type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'CROSS trial: pCR 29.4%' }] } } }), 's')
        on(ev({ type: 'tool/result', data: { message: { toolCallId: 'c2', content: [{ type: 'text', text: 'pCR = 0.3667' }] } } }), 's')
        return { finalResponse: 'ok' }
      },
    } as unknown as HarnessPool
    const turns = new TurnService(docs, pool, new TurnRegistry())
    await turns.submit('u1', docId, '帮我写结果')
    const turnId = store.listTurns(docId).at(-1)!.id
    const seen = store.observedNumbers(turnId)
    expect(seen).toContain(0.3667)
    expect(seen).not.toContain(29.4)
  })

  it('文献类工具的结果按调用 id 认出（工具名可带 MCP 前缀）；它们的数字不算「看到过」', () => {
    const call = { method: 'session.event', params: { sessionId: 'sub', event: { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'mcp__heurion__pubmed_search', arguments: '{}' }, { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' }] } } } } }
    expect(toolCallsOf(call as never)).toEqual([['c1', 'mcp__heurion__pubmed_search'], ['c2', 'bash']])
    const res = { method: 'session.event', params: { sessionId: 'sub', event: { type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'pCR 29%' }] } } } } }
    expect(toolResultOf(res as never)).toEqual({ callId: 'c1', text: 'pCR 29%' })
    expect(isLiteratureTool('mcp__heurion__pubmed_search')).toBe(true)
    expect(isLiteratureTool('oa_fulltext')).toBe(true)
    expect(isLiteratureTool('bash')).toBe(false)
    expect(isLiteratureTool('dataset_survival')).toBe(false)
    expect(isLiteratureTool('kb_read')).toBe(false)
  })
})

describe('规则一：改人写的文字', () => {
  it('安全小改直接生效，新词标为 AI', () => {
    const { docs, ops, docId, ids } = setup()
    const r = ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: ids[1]!, find: '名患者', replace: '名可评估患者' }] }, AI())
    expect(r.provenance).toBeUndefined()
    expect(hasSuggestions(docs.get(docId))).toBe(false)
    expect(aiSpans(docs.get(docId).child(1)).map(s => s.text).join('')).toContain('可评估')
  })

  it('改了措辞强度（可能 → 确实）：整批转为待采纳修订，人写的原文不动', () => {
    const { docs, ops, docId, ids } = setup()
    const r = ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: ids[2]!, find: '可能有效', replace: '确实有效' }] }, AI())
    expect(r.provenance?.converted_to_suggest?.[0]).toContain('措辞强度')
    expect(hasSuggestions(docs.get(docId))).toBe(true)
    let original = ''
    docs.get(docId).descendants(n => { if (n.attrs.suggest === 'delete') original = n.textContent; return true })
    expect(original).toBe('本研究提示新辅助治疗可能有效。')
  })

  it('改人写的数字：即使数字有出处，也转为待采纳修订', () => {
    const { store, docs, ops, docId, ids } = setup()
    store.addObservedNumbers('t1', [0.366666])
    const r = ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: ids[1]!, find: '37%', replace: '36.7%' }] }, AI())
    expect(r.provenance?.converted_to_suggest?.[0]).toContain('数字')
    expect(hasSuggestions(docs.get(docId))).toBe(true)
  })

  it('整段删掉人写的段落：转为待采纳修订', () => {
    const { docs, ops, docId, ids } = setup()
    const r = ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'delete', ids: [ids[2]!] }] }, AI())
    expect(r.provenance?.converted_to_suggest).toContain('删除了含人写文字的段落')
    expect(docs.get(docId).textContent).toContain('可能有效')
  })

  it('AI 改自己写的文字：大改也直接生效', () => {
    const { docs, ops, docId, ids } = setup()
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: ids[2]!, markdown: '这一结果需要更大样本验证。' }] }, AI())
    let added = ''
    docs.get(docId).forEach(n => { if (n.textContent.startsWith('这一结果')) added = n.attrs.id as string })
    const r = ops.edit({ doc_id: docId, base_rev: docs.rev(docId), mode: 'apply', ops: [{ op: 'replace_block', id: added, markdown: '这一发现尚需多中心、更大样本的前瞻性研究进一步验证。' }] }, AI())
    expect(r.provenance).toBeUndefined()
    expect(hasSuggestions(docs.get(docId))).toBe(false)
  })

  it('一次改人写的文字超过 5 处：转为待采纳修订', () => {
    const { ops, docId, ids } = setup('# 讨论\n\n甲乙丙丁戊己庚辛壬癸，子丑寅卯辰巳午未申酉。')
    const r = ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: ['甲', '丙', '戊', '庚', '壬', '子'].map(c => ({ op: 'replace_text' as const, id: ids[1]!, find: c, replace: `${c}之` })) }, AI())
    expect(r.provenance?.converted_to_suggest?.[0]).toContain('超过 5 处')
  })

  it('5 处的上限按回合累计：拆成多批也不能绕过；换一个回合重新计', () => {
    const { docs, ops, docId, ids } = setup('# 讨论\n\n甲乙丙丁戊己庚辛壬癸，子丑寅卯辰巳午未申酉。')
    const batch = (chars: string[]) => ({ doc_id: docId, base_rev: docs.rev(docId), mode: 'apply' as const, ops: chars.map(c => ({ op: 'replace_text' as const, id: ids[1]!, find: c, replace: `${c}之` })) })
    expect(ops.edit(batch(['甲', '丙', '戊']), AI('t1', 't1')).provenance?.converted_to_suggest).toBeUndefined()
    const second = ops.edit(batch(['庚', '壬', '子']), AI('t1', 't1'))
    expect(second.provenance?.converted_to_suggest?.[0]).toContain('累计超过 5 处')
    expect(hasSuggestions(docs.get(docId))).toBe(true)
    // 新的回合：从 0 计
    const { docs: d2, ops: o2, docId: id2, ids: ids2 } = setup('# 讨论\n\n甲乙丙丁戊己庚辛壬癸，子丑寅卯辰巳午未申酉。')
    const b2 = (chars: string[]) => ({ doc_id: id2, base_rev: d2.rev(id2), mode: 'apply' as const, ops: chars.map(c => ({ op: 'replace_text' as const, id: ids2[1]!, find: c, replace: `${c}之` })) })
    o2.edit(b2(['甲', '丙', '戊']), AI('t1', 't1'))
    expect(o2.edit(b2(['庚', '壬']), AI('t2', 't2')).provenance?.converted_to_suggest).toBeUndefined()
  })

  it('读视图用 ⟦⟧ 标出 AI 未确认的文字；AI 把 ⟦⟧ 原样抄进编辑内容时去掉再处理', () => {
    const { store, docs, ops, docId, ids } = setup()
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: ids[2]!, markdown: '这一结果需要更大样本验证。' }] }, AI())
    const view = read({ doc: docs.get(docId), docId, rev: docs.rev(docId), comments: store.listComments(docId, 'open') })
    expect(view).toContain('⟦这一结果需要更大样本验证。⟧')
    expect(view).toContain('⟦⟧ 内是 AI 写的')
    expect(view).not.toContain('⟦在 120 名患者中')
    const added = docs.get(docId).child(3).attrs.id as string
    ops.edit({ doc_id: docId, base_rev: docs.rev(docId), mode: 'apply', ops: [{ op: 'replace_text', id: added, find: '⟦这一结果需要', replace: '⟦这一发现需要' }] }, AI())
    expect(docs.get(docId).child(3).textContent).toBe('这一发现需要更大样本验证。')
  })

  it('文档所有者关闭安全小改：改到人写的文字一律转为待采纳修订', () => {
    const { store, ops, docId, ids } = setup()
    store.setUserSetting('u1', 'provenance.safe_edits', 'off')
    const r = ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: ids[1]!, find: '名患者', replace: '名可评估患者' }] }, AI())
    expect(r.provenance?.converted_to_suggest?.[0]).toContain('关闭了安全小改')
  })

  it('合并人写的两段：文字原样搬运，直接生效，仍是人写的', () => {
    const { docs, ops, docId, ids } = setup()
    const r = ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'merge', ids: [ids[1]!, ids[2]!] }] }, AI())
    expect(r.provenance).toBeUndefined()
    expect(hasSuggestions(docs.get(docId))).toBe(false)
    expect(docs.get(docId).child(1).textContent).toContain('可能有效')
    expect(hasAiText(docs.get(docId))).toBe(false)
  })

  it('人改 AI 写的文字、人自己的修改都不受影响', () => {
    const { docs, ops, docId, ids } = setup()
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'replace_text', id: ids[2]!, find: '可能有效', replace: '确实有效' }] }, { actor: 'user', turnId: null })
    expect(hasSuggestions(docs.get(docId))).toBe(false)
    expect(hasAiText(docs.get(docId))).toBe(false)
  })
})

describe('规则二：数字要有出处', () => {
  const addPara = (ops: OpService, docId: string, anchor: string, markdown: string, meta = AI()) =>
    ops.edit({ doc_id: docId, base_rev: 0, mode: 'apply', ops: [{ op: 'insert_after', anchor_id: anchor, markdown }] }, meta)

  it('文档里已有的数字、本轮看到过的数字可以写；凭空的数字拒绝', () => {
    const { store, ops, docId, ids } = setup()
    expect(code(() => addPara(ops, docId, ids[2]!, '共纳入 120 例，pCR 率 37%。'))).toBe('ok')
    expect(code(() => addPara(ops, docId, ids[2]!, '中位随访 18.5 个月。'))).toBe('unobserved_number')
    store.addObservedNumbers('t1', [18.47])
    expect(code(() => addPara(ops, docId, ids[2]!, '中位随访 18.5 个月。'))).toBe('ok')
  })

  it('没有观察记录键（非 AI 回合的内部写入）：不做数字出处检查', () => {
    const { ops, docId, ids } = setup()
    expect(code(() => addPara(ops, docId, ids[2]!, '中位随访 18.5 个月。', AI(null, null)))).toBe('ok')
  })

  it('文献数字：同一句引用了它、且原文里有，才算有出处', () => {
    // 每种写法用一份新文档：前一次写进去的数字会成为「文档里已有」
    const attempt = (markdown: (cite: string) => string) => {
      const { store, ops, docId, ids } = setup()
      const cross = store.upsertCitation({ doc_id: docId, doi: '10.1000/cross', pmid: null, formatted: 'CROSS', url: null })
      store.putFullText('10.1000/cross', { source: 'pmc', url: null, license: 'cc-by', text: 'In the CROSS trial, neoadjuvant chemoradiotherapy achieved a pathologic complete response rate of 29%.' })
      return code(() => addPara(ops, docId, ids[2]!, markdown(cross.id)))
    }
    // 原文里有 29%，同一句引用 → 可以
    expect(attempt(c => `In the CROSS trial, neoadjuvant chemoradiotherapy achieved a pathologic complete response rate of 29% [@c:${c}].`)).toBe('ok')
    // 原文里没有 49% → 拒绝（张冠李戴或抄错）
    expect(attempt(c => `In the CROSS trial, neoadjuvant chemoradiotherapy achieved a pathologic complete response rate of 49% [@c:${c}].`)).toBe('unobserved_number')
    // 数字写在没有引用的句子里 → 拒绝（出处错误：看起来像本研究的结果）
    expect(attempt(c => `The pathologic complete response rate was 29%. In the CROSS trial, neoadjuvant chemoradiotherapy achieved a high pathologic complete response rate [@c:${c}].`)).toBe('unobserved_number')
  })

  it('所引文献只有摘要、摘要里找不到：写入，但交给用户核对', () => {
    const { store, ops, docId, ids } = setup()
    const neo = store.upsertCitation({ doc_id: docId, doi: '10.1000/neo', pmid: null, formatted: 'NEO', url: null })
    store.putAbstract('10.1000/neo', null, 'Neoadjuvant chemoradiotherapy improved 3-year overall survival in esophageal squamous cell carcinoma.')
    const r = addPara(ops, docId, ids[2]!, `Neoadjuvant chemoradiotherapy improved 3-year overall survival to 64.4% in esophageal squamous cell carcinoma [@c:${neo.id}].`)
    expect(r.provenance?.unverifiable_numbers?.[0]?.number).toBe('64.4%')
  })

  it('新插的引用要有保存的摘要或全文', () => {
    const { store, ops, docId, ids } = setup()
    const bare = store.upsertCitation({ doc_id: docId, doi: '10.1000/bare', pmid: null, formatted: 'BARE', url: null })
    expect(code(() => addPara(ops, docId, ids[2]!, `既往研究也观察到类似现象 [@c:${bare.id}]。`))).toBe('unread_citation')
    store.putAbstract('10.1000/bare', null, 'Similar phenomenon was observed in prior cohorts.')
    expect(code(() => addPara(ops, docId, ids[2]!, `既往研究也观察到类似现象 [@c:${bare.id}]。`))).toBe('ok')
  })
})
