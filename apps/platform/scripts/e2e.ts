/**
 * 平台 e2e（真实 dsh + 模型）：对运行中的平台跑一组任务，统计耗时、工具调用与断言结果。
 *   pnpm --filter @heurion2/platform e2e [baseUrl]
 * 需要 server 在跑且配置了 DEEPSEEK_API_KEY。会在平台里新建测试文档。
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787'
// 独立的测试用户：e2e 的回合不进手工测试用户的队列
const TOKEN = `${process.env.HEURION_DEV_TOKEN || 'dev'}:e2e`
const H = { Authorization: `Bearer ${TOKEN}` }

interface Turn { ms: number; events: Array<Record<string, any>>; calls: string[]; errors: string[] }

async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...init.headers } })
  if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`)
  return (res.headers.get('content-type')?.includes('json') ? res.json() : res.text()) as Promise<T>
}

async function turn(path: string, body: unknown): Promise<Turn> {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  const events = text.split('\n\n').map(f => f.split('\n').find(l => l.startsWith('data:'))).filter(Boolean).map(l => JSON.parse(l!.slice(5)))
  return {
    ms: Date.now() - t0,
    events,
    calls: events.filter(e => e.type === 'tool_call').map(e => String(e.name).replace(/^mcp__heurion__/, '')),
    errors: events.filter(e => e.type === 'tool_result' && e.isError).map(e => {
      const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
      return `${String(call?.name ?? '?').replace(/^mcp__heurion__/, '')}${e.code ? `(${e.code})` : ''}`
    }),
  }
}

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const summary = (t: Turn) => `${(t.ms / 1000).toFixed(1)}s · 工具 ${t.calls.length}（${[...new Set(t.calls)].join(', ')}）· 工具报错 ${t.errors.length}${t.errors.length ? `：${t.errors.join(', ')}` : ''}`
const shell = (t: Turn) => t.calls.some(c => !['doc_outline', 'doc_read', 'doc_search', 'doc_edit', 'doc_history', 'doc_diff', 'doc_list', 'doc_create', 'comments_list', 'comment_reply', 'comment_resolve', 'pubmed_search', 'doi_lookup', 'insert_citation', 'list_citations', 'asset_upload', 'verify_claims', 'claim_report', 'slide_read', 'deck_edit', 'layout_check', 'slide_render', 'diagram_render', 'docs_search', 'kb_search', 'kb_read', 'memory_propose', 'memory_search', 'memory_forget'].includes(c))

// —— 1. 起草：带引用的证据段 ——
const doc = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'e2e 司美格鲁肽', markdown: '# 引言\n\n司美格鲁肽是 GLP-1 受体激动剂。\n\n# 证据\n\n待补充。' }) })
const t1 = await turn(`/api/docs/${doc.id}/chat`, { message: '把「证据」下的「待补充」改写成一段 SUSTAIN-6 与 SELECT 的证据综述（各给出 MACE 的 HR 与 95% CI），并按规范引用两项试验的原始文献。' })
const d1 = await api(`/api/docs/${doc.id}`)
const md1 = await api<string>(`/api/docs/${doc.id}/export.md`)
check('起草：文档被修改', t1.events.some(e => e.type === 'doc_updated'), summary(t1))
check('起草：引用 ≥ 2 条且都在文中使用', d1.citations.filter((c: any) => c.number).length >= 2)
check('起草：正文无 DOI、参考文献表由平台生成', !/10\.\d{4,9}\//.test(md1.split('## 参考文献')[0]!) && md1.includes('## 参考文献'))
check('起草：未修改「引言」', md1.includes('司美格鲁肽是 GLP-1 受体激动剂。'))
check('起草：只用平台工具改文档', !shell(t1), t1.calls.join(' '))
check('起草：回合结束落版本', t1.events.some(e => e.type === 'version'))

// —— 2. 评论驱动 ——
const html = (await api(`/api/docs/${doc.id}/html`)).html as string
const introId = /<p data-id="([a-z0-9]+)">司美格鲁肽是/.exec(html)?.[1]
const comment = await api(`/api/docs/${doc.id}/comments`, { method: 'POST', body: JSON.stringify({ node_id: introId, snippet: 'GLP-1 受体激动剂', text: '补充一句给药方式（每周一次皮下注射/口服）' }) })
const t2 = await turn(`/api/docs/${doc.id}/comments/${comment.id}/ask`, {})
const d2 = await api(`/api/docs/${doc.id}`)
const c2 = d2.comments.find((c: any) => c.id === comment.id)
check('评论：AI 修改了锚定块', t2.calls.includes('doc_edit') && /皮下|口服/.test(c2.anchor.text + (await api(`/api/docs/${doc.id}/export.md`))), summary(t2))
check('评论：AI 在线程里回复', c2.replies.some((r: any) => r.role === 'ai'))
check('评论：改过内容的线程留给用户关闭', c2.status === 'open')
check('评论：锚点仍可定位', c2.anchor.located)

// —— 3. 追问（同一会话多轮） ——
const t3 = await turn(`/api/docs/${doc.id}/chat`, { message: '把刚才写的证据段压缩到 120 字以内，保留两个 HR 和引用。' })
const md3 = await api<string>(`/api/docs/${doc.id}/export.md`)
const evidence = md3.split('# 证据')[1]?.split('## 参考文献')[0] ?? ''
check('追问：证据段压缩且保留引用', evidence.replace(/\s/g, '').length < 220 && (evidence.match(/\[\d\]/g) ?? []).length >= 2, `${summary(t3)} · 证据段 ${evidence.replace(/\s/g, '').length} 字`)

// —— 4. 导入 docx → 局部修改 → 导出 ——
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const para = (t: string, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`
const body = [para('研究背景', 'Heading1'), para('2 型糖尿病患病率持续上升，其慢性血管并发症是致残和致死的主要原因，寻找能够改善硬终点的降糖策略因此成为临床研究的重点，相关研究近年来数量很多。'), para('早期 RCT 提示强化血糖控制可降低微血管并发症风险。')].join('')
const file = zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/document.xml': strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`),
  'word/styles.xml': strToU8(`<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`),
})
const form = new FormData()
form.append('file', new Blob([file]), 'e2e 导入.docx')
const imported = await api('/api/docs', { method: 'POST', body: form })
const t4 = await turn(`/api/docs/${imported.id}/chat`, { message: '把第一段正文改得更简洁（不超过 40 字），其他内容不要动。' })
const res = await fetch(`${BASE}/api/docs/${imported.id}/export.docx`, { headers: H })
const exported = new Uint8Array(await res.arrayBuffer())
const xml = strFromU8(unzipSync(exported)['word/document.xml']!)
check('导入：AI 只改了第一段', t4.calls.includes('doc_edit') && !xml.includes('相关研究近年来数量很多'), summary(t4))
check('导出：未改动的块原样写回', xml.includes(para('研究背景', 'Heading1')) && xml.includes(para('早期 RCT 提示强化血糖控制可降低微血管并发症风险。')))

// —— 5. @heurion 自动触发（评论即指令，事件经文档流推送） ——
{
  const html5 = (await api(`/api/docs/${doc.id}/html`)).html as string
  const evidenceId = [...html5.matchAll(/<p data-id="([a-z0-9]+)">/g)].map(m => m[1]).at(-1)
  const t0 = Date.now()
  const created = await api(`/api/docs/${doc.id}/comments`, { method: 'POST', body: JSON.stringify({ node_id: evidenceId, snippet: '', text: '@heurion 在这段末尾加一句局限性说明（不超过 30 字）' }) })
  check('@heurion：创建评论即排队', created.queued === true)
  let replied = false
  for (let i = 0; i < 120 && !replied; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const d = await api(`/api/docs/${doc.id}`)
    replied = !d.busy && d.comments.find((c: any) => c.id === created.id)?.replies.some((r: any) => r.role === 'ai')
  }
  check('@heurion：AI 自动处理并在线程里回复', replied, `${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

// —— 6. 修订模式：AI 的修改先作为待采纳修订，采纳后生效 ——
{
  const before = await api<string>(`/api/docs/${doc.id}/export.md`)
  const t6 = await turn(`/api/docs/${doc.id}/chat`, { message: '把「引言」这一节的正文改写得更正式一些。', suggest: true })
  const d6 = await api(`/api/docs/${doc.id}`)
  const after = await api<string>(`/api/docs/${doc.id}/export.md`)
  check('修订模式：生成待采纳修订，导出内容不变', d6.suggestions.length > 0 && after === before, summary(t6))
  await api(`/api/docs/${doc.id}/suggestions/all/accept`, { method: 'POST' })
  const accepted = await api(`/api/docs/${doc.id}`)
  check('修订模式：全部采纳后生效', accepted.suggestions.length === 0 && (await api<string>(`/api/docs/${doc.id}/export.md`)) !== before)
}

// —— 7. 撤销本轮：只撤该回合的改动 ——
{
  const before = await api<string>(`/api/docs/${doc.id}/export.md`)
  const t7 = await turn(`/api/docs/${doc.id}/chat`, { message: '在文末新增一个「结论」小节，写一句话总结。' })
  const turnId = t7.events.find(e => e.type === 'turn')?.turn_id
  const changed = await api<string>(`/api/docs/${doc.id}/export.md`)
  const r = await api(`/api/docs/${doc.id}/turns/${turnId}/revert`, { method: 'POST' })
  const reverted = await api<string>(`/api/docs/${doc.id}/export.md`)
  check('撤销本轮：恢复到该回合之前', changed !== before && reverted === before, `${summary(t7)} · 撤销 ${r.changes} 处`)
}

// —— 7b. 参考资料库：对话里选中资料，AI 检索并依据它写、标明出处 ——
{
  const marker = `${(Date.now() % 900) + 100}`
  const form = new FormData()
  form.append('file', new Blob([`# 本院心衰门诊年报（2025）\n\n2025 年本院心衰门诊随访 1${marker} 例，射血分数降低的心衰患者 SGLT2 抑制剂使用率为 61.3%，较 2024 年提高 18 个百分点。\n\n主要障碍是生殖器感染顾虑与医保报销限制。`], { type: 'text/markdown' }), `e2e-门诊年报-${marker}.md`)
  const [file] = await api<any[]>('/api/kb', { method: 'POST', body: form })
  for (let i = 0; i < 20 && (await api<any[]>('/api/kb')).find(f => f.id === file.id)?.status !== 'ready'; i++) await new Promise(r => setTimeout(r, 500))
  const kbDoc = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'e2e 资料库', markdown: '# 本院现状\n\n待补充。' }) })
  const t = await turn(`/api/docs/${kbDoc.id}/chat`, { message: '依据我选的资料，把「本院现状」下的「待补充」改写成一段话，写出门诊例数和 SGLT2 抑制剂使用率，并注明数据来源。', kb_files: [file.id] })
  const md = await api<string>(`/api/docs/${kbDoc.id}/export.md`)
  check('资料库：AI 检索选中资料并据此写作', t.calls.some(c => c === 'kb_search' || c === 'kb_read') && md.includes('61.3') && md.includes(`1${marker}`), `${summary(t)} · 调用 ${t.calls.filter(c => c.startsWith('kb_')).join('、') || '无'}`)
  await api(`/api/kb/${file.id}`, { method: 'DELETE' })
}

// —— 7c. 记忆：用户说「记住」→ 直接生效；新文档的回合遵守；本轮不用记忆时不提议 ——
{
  await api('/api/memory', { method: 'DELETE' })
  const a = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'e2e 记忆甲', markdown: '# 结果\n\n待补充。' }) })
  const t1 = await turn(`/api/docs/${a.id}/chat`, { message: '请记住：以后我的文档里百分比一律保留两位小数（例如 6.50%）。这一轮不用改文档。' })
  const mem = (await api<any>('/api/memory')).items as any[]
  check('记忆：用户要求记住后直接生效', t1.calls.includes('memory_propose') && mem.some(m => m.status === 'active' && /两位小数/.test(m.content)), `${summary(t1)} · ${mem.map(m => `${m.status}:${m.content}`).join('；')}`)
  const b = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'e2e 记忆乙', markdown: '# 结果\n\n待补充。' }) })
  await turn(`/api/docs/${b.id}/chat`, { message: '把「待补充」改写成一句话：SELECT 试验中主要终点事件发生率为 6.5% 对 8.0%。' })
  const md = await api<string>(`/api/docs/${b.id}/export.md`)
  check('记忆：新文档的回合遵守已记住的偏好', md.includes('6.50%') && md.includes('8.00%'), md.split('\n').find(l => l.includes('%'))?.slice(0, 80) ?? '')
  const c = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'e2e 记忆丙', markdown: '# 结果\n\n待补充。' }) })
  const t3 = await turn(`/api/docs/${c.id}/chat`, { message: '请记住：表格标题放在表格上方。把「待补充」改成「见下表」。', memory: false })
  const after = (await api<any>('/api/memory')).items as any[]
  check('记忆：本轮不用记忆时不新增', !after.some(m => /表格标题/.test(m.content)), `${summary(t3)}`)
  const t4 = await turn(`/api/docs/${c.id}/chat`, { message: '请忘掉「百分比保留两位小数」这条要求，以后不用了。不用改文档。' })
  const left = (await api<any>('/api/memory')).items as any[]
  check('记忆：用户要求忘掉后删除', t4.calls.includes('memory_forget') && !left.some(m => /两位小数/.test(m.content)), `${summary(t4)}`)
  await api('/api/memory', { method: 'DELETE' })
}

// —— 8. 论断核对：故意写错的论断被标出 ——
{
  const wrong = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'e2e 论断核对', markdown: '# 证据\n\n占位。' }) })
  const cite = await api(`/api/docs/${wrong.id}/citations`, { method: 'POST', body: JSON.stringify({ doi: '10.1056/NEJMoa2307563' }) })
  const read8 = await api<string>(`/api/docs/${wrong.id}/read`)
  const pid = /\{#([a-z0-9]+)\} 占位/.exec(read8)![1]
  await api(`/api/docs/${wrong.id}/edit`, { method: 'POST', body: JSON.stringify({ base_rev: 0, ops: [{ op: 'replace_block', id: pid, markdown: `SELECT 试验在 2 型糖尿病患者中进行，因安全性问题提前终止[@c:${cite.cite_id}]。` }] }) })
  const t8 = await turn(`/api/docs/${wrong.id}/verify`, {})
  const d8 = await api(`/api/docs/${wrong.id}`)
  const flagged = d8.claim_checks.filter((c: any) => c.verdict === 'unsupported')
  check('论断核对：错误论断被判为不支持并挂评论', flagged.length === 1 && d8.comments.some((c: any) => c.id === flagged[0].comment_id), `${summary(t8)} · ${flagged[0]?.reason ?? ''}`)
  check('论断核对：只核对不改正文', !t8.calls.includes('doc_edit'))
}

// —— 9. 幻灯片：从零做一份汇报，再插页、改页 ——
let deckId = ''
{
  const deck = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: 'e2e SELECT 汇报', kind: 'deck' }) })
  deckId = deck.id
  const t9 = await turn(`/api/docs/${deck.id}/chat`, { message: '把这份幻灯片做成 3 页的 SELECT 试验汇报：标题页（副标题写「心血管结局试验解读」）、研究设计、主要结果（写出主要终点 HR 与 95% CI，并按规范引用原始文献）。做完检查版面。' })
  const d9 = await api(`/api/docs/${deck.id}/deck`)
  const slides = d9.doc.content as any[]
  const all = JSON.stringify(d9.doc)
  check('幻灯片：AI 从零做出 3 页', slides.length === 3 && all.includes('研究设计') && /0\.80|HR/.test(all), summary(t9))
  check('幻灯片：只用平台工具且做了版面检查', !shell(t9) && t9.calls.includes('deck_edit') && t9.calls.includes('layout_check'), t9.calls.join(' '))
  check('幻灯片：引用经登记写入', (await api(`/api/docs/${deck.id}`)).citations.some((c: any) => c.number) && all.includes('"type":"citation"'))
  const t10 = await turn(`/api/docs/${deck.id}/chat`, { message: '在「研究设计」之后插入一页「安全性」，列 2 条要点；并把标题页的副标题改成「SELECT 试验解读 · 2026」。' })
  const d10 = await api(`/api/docs/${deck.id}/deck`)
  const titles = (d10.doc.content as any[]).map(s => JSON.stringify(s))
  check('幻灯片：插入新页并修改已有页', titles.length === 4 && titles[2]!.includes('安全性') && titles[0]!.includes('SELECT 试验解读 · 2026'), summary(t10))

  // 整形状评论：选中「研究设计」页的正文形状整体评论，AI 整体改写后锚点仍覆盖该形状
  const design = (d10.doc.content as any[])[1]
  const shapeText = (s: any): string => s.type === 'text' ? s.text : (s.content ?? []).map(shapeText).join('')
  const bodyShape = (design.content as any[]).filter(s => s.type === 'shape' && s.attrs.kind === 'text').sort((a, b) => shapeText(b).length - shapeText(a).length)[0]
  const wc = await api(`/api/docs/${deck.id}/comments`, { method: 'POST', body: JSON.stringify({ node_id: bodyShape.attrs.id, snippet: '', text: '这个形状里的内容全部改成英文' }) })
  const t11 = await turn(`/api/docs/${deck.id}/comments/${wc.id}/ask`, {})
  const c11 = (await api(`/api/docs/${deck.id}`)).comments.find((c: any) => c.id === wc.id)
  const after = shapeText((((await api(`/api/docs/${deck.id}/deck`)).doc.content as any[])[1].content as any[]).find(s => s.attrs?.id === bodyShape.attrs.id) ?? {})
  check('幻灯片：整形状评论改写后锚点仍在、内容已改成英文', c11.anchor.located && after.length > 0 && !/[\u4e00-\u9fff]/.test(after) && c11.replies.some((r: any) => r.role === 'ai'), `${summary(t11)} · ${after.slice(0, 80)}`)

  // C1：AI 用与画布相同的操作做样式——套主题、生成示意图并插入、加强调色结论条
  const t12 = await turn(`/api/docs/${deck.id}/chat`, { message: '给这份幻灯片套用「深夜蓝」主题；在「研究设计」那一页右侧画一张研究流程示意图（筛选 → 随机 → 两组随访 → 主要终点）并插入，左侧文字保持不变；在该页底部加一条强调色的结论条。做完检查版面。' })
  const d12 = await api(`/api/docs/${deck.id}/deck`)
  const allShapes = (d12.doc.content as any[]).flatMap(s => (s.content ?? []).filter((c: any) => c.type === 'shape'))
  check('幻灯片：AI 套主题、生成示意图插入、加色块（与画布同一套操作）',
    (d12.doc.content as any[]).every(s => s.attrs.theme === 'midnight') && allShapes.some(s => s.attrs.kind === 'image' && s.attrs.asset_id) && allShapes.some(s => s.attrs.fill && s.attrs.fill !== 'none'),
    `${summary(t12)} · 工具 ${[...new Set(t12.calls)].join(' ')}`)
  // C1 第 2 周：AI 建表格（画布上人也是同一个 add_table）
  const t13 = await turn(`/api/docs/${deck.id}/chat`, { message: '在「安全性」那一页加一个表格，列出两组（司美格鲁肽 vs 安慰剂）因不良事件停药的比例和严重不良事件比例，数值可以写「待核实」。' })
  const tables = ((await api(`/api/docs/${deck.id}/deck`)).doc.content as any[]).flatMap(s => (s.content ?? []).filter((c: any) => c.attrs?.kind === 'table'))
  check('幻灯片：AI 新建表格（与画布同一套操作）', tables.length > 0 && JSON.stringify(tables).includes('安慰剂'), `${summary(t13)} · 工具 ${[...new Set(t13.calls)].join(' ')}`)
  // C1 第 3 周：AI 增删表格行、对齐形状（画布的「＋行」「排列」是同一套操作）
  const rowsBefore = tables[0]?.content?.[0]?.content?.length ?? 0
  const t14 = await turn(`/api/docs/${deck.id}/chat`, { message: '在「安全性」那页的表格最后加一行「低血糖」（两组都写「待核实」），然后把该页的表格水平居中对齐到页面。' })
  const d14 = await api(`/api/docs/${deck.id}/deck`)
  const table14 = (d14.doc.content as any[]).flatMap(s => (s.content ?? []).filter((c: any) => c.attrs?.kind === 'table'))[0]
  const centered = table14 && Math.abs(table14.attrs.x + table14.attrs.w / 2 - d14.size.cx / 2) < 12700 * 2
  check('幻灯片：AI 增加表格行并居中对齐（与画布同一套操作）', (table14?.content?.[0]?.content?.length ?? 0) === rowsBefore + 1 && JSON.stringify(table14).includes('低血糖') && centered,
    `${summary(t14)} · 工具 ${[...new Set(t14.calls)].join(' ')}`)
  // C1 图表：AI 建原生图表、再改数据（画布的「＋图表」与数据表是同一个 add_chart / chart_set_data）
  const charts = async () => ((await api(`/api/docs/${deck.id}/deck`)).doc.content as any[]).flatMap(s => (s.content ?? []).filter((c: any) => c.attrs?.kind === 'chart'))
  const t15 = await turn(`/api/docs/${deck.id}/chat`, { message: '在「主要结果」那一页加一张柱状图：类别为「主要终点」「心血管死亡」，系列「司美格鲁肽」数值 6.5、2.5，系列「安慰剂」数值 8.0、3.0，图表标题「事件发生率（%）」。不要用图片，用原生图表。' })
  // 前面的步骤里 AI 可能已经画过别的图表：按内容找这一张
  const ours = async () => (await charts()).find(c => JSON.stringify(c.attrs.chart).includes('心血管死亡'))
  const c15 = await ours()
  check('幻灯片：AI 新建原生图表（与画布同一个 add_chart）', !!c15 && c15.attrs.chart.series.length === 2 && JSON.stringify(c15.attrs.chart).includes('6.5') && t15.calls.includes('deck_edit') && !shell(t15),
    `${summary(t15)} · 工具 ${[...new Set(t15.calls)].join(' ')}`)
  const t16 = await turn(`/api/docs/${deck.id}/chat`, { message: '把「主要结果」页图表里安慰剂的心血管死亡改成 3.2，并加一个类别「心衰住院」：司美格鲁肽 1.4、安慰剂 1.7。' })
  const c16 = await ours()
  const placebo = c16?.attrs.chart.series.find((s: any) => s.name.includes('安慰剂'))
  check('幻灯片：AI 改图表数据（与画布数据表同一个 chart_set_data）', !!placebo && placebo.values.includes(3.2) && placebo.values.includes(1.7) && c16.attrs.chart.categories.length === 3,
    `${summary(t16)} · ${JSON.stringify(c16?.attrs.chart)}`)
  // 导出的 pptx：图表缓存与内嵌工作簿都是新数据
  const files = unzipSync(new Uint8Array(await (await fetch(`${BASE}/api/docs/${deck.id}/export.pptx`, { headers: H })).arrayBuffer()))
  const chartXml = Object.keys(files).filter(f => /^ppt\/charts\/chart\d+\.xml$/.test(f)).map(f => strFromU8(files[f]!)).join('')
  const book = Object.keys(files).find(f => f.startsWith('ppt/embeddings/') && f.endsWith('.xlsx'))
  const sheet = book ? strFromU8(unzipSync(files[book]!)['xl/worksheets/sheet1.xml']!) : ''
  check('导出：图表缓存与内嵌工作簿是改后的数据', chartXml.includes('<c:v>3.2</c:v>') && chartXml.includes('心衰住院') && sheet.includes('<v>3.2</v>') && sheet.includes('心衰住院'))
}

// —— 10. 导出 docx 能被 LibreOffice 打开（需要 podman 与 heurion2:dev 镜像，否则跳过） ——
{
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  let engine: string | null = null
  for (const e of ['podman', 'docker']) {
    try { execFileSync(e, ['image', 'exists', 'heurion2:dev'], { stdio: 'ignore' }); engine = e; break } catch { /* 下一个 */ }
  }
  if (!engine) console.log('- 跳过 LibreOffice 校验：没有 podman/docker 或 heurion2:dev 镜像')
  else {
    const dir = mkdtempSync(join(tmpdir(), 'heurion-e2e-'))
    try {
      for (const [name, id, ext] of [['drafted', doc.id, 'docx'], ['imported', imported.id, 'docx'], ['deck', deckId, 'pptx']] as const) {
        const bytes = new Uint8Array(await (await fetch(`${BASE}/api/docs/${id}/export.${ext}`, { headers: H })).arrayBuffer())
        writeFileSync(join(dir, `${name}.${ext}`), bytes)
      }
      try {
        execFileSync(engine, ['run', '--rm', '-v', `${dir}:/x:Z`, '--user', 'root', '--entrypoint', 'bash', 'heurion2:dev', '-c',
          'export HOME=/tmp && cd /x && for f in *.docx *.pptx; do timeout 120 soffice "-env:UserInstallation=file:///x/lo-profile" --headless --convert-to pdf --outdir /x "$f" >/dev/null 2>&1; done'], { stdio: 'ignore', timeout: 600_000 })
      } catch { /* 结果按产物判断 */ }
      check('导出：LibreOffice 能打开 docx 与 pptx 并转成 PDF', existsSync(join(dir, 'drafted.pdf')) && existsSync(join(dir, 'imported.pdf')) && existsSync(join(dir, 'deck.pdf')), dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

const passed = results.filter(r => r.ok).length
console.log(`\n${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)
