/**
 * 长稿改稿任务：稿件是开放获取论文改编的期刊格式 Word（convert.ts），导入平台后由脚本以人类身份布置诱发条件。
 * 9 类任务，指令用中文（国内医生改英文稿的常见方式），具体位置与参数从每篇论文的结构里取，任务消息里不出现守卫码。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAll, type Client } from '../exp3/client.ts'
import type { Corpus, Outcome, Task, TaskCtx } from '../exp3/tasks.ts'
import type { Paper } from './fetch.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

export interface PaperTopic {
  pmcid: string
  type: Paper['type']
  /** 参考文献（来自原文）：用于「引用」任务。 */
  refs: Array<{ n: number; title: string; first: string; year: string; doi: string; pmid: string }>
}

// —— 读视图解析 ——

interface Block { id: string; level: number; text: string; raw: string }

/** 顶层块：标题（level 1–6）、段落 / 表格 / 列表（level 0）。评论尾注不计入。 */
export function blocks(view: string): Block[] {
  const out: Block[] = []
  for (const line of view.split('\n')) {
    const m = /^\{#([a-z0-9]+)\}(?: (.*))?$/.exec(line)
    if (m) {
      const text = m[2] ?? ''
      const h = /^(#{1,6}) (.*)$/.exec(text)
      out.push({ id: m[1]!, level: h ? h[1]!.length : 0, text: h ? h[2]! : text, raw: line })
    } else if (out.length && !/^(---|本范围内的 open 评论|- 评论 )/.test(line)) out[out.length - 1]!.raw += '\n' + line
  }
  return out
}

/** 去掉 markdown 转义与强调符号，得到正文纯文字。 */
export const plain = (s: string) => s.replace(/\{#[a-z0-9]+\} ?/g, '').replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1').replace(/\*\*|\*/g, '')

/** 以某个二级标题开头的一节（到下一个同级或更高级标题为止，不含该标题）。 */
export function section(bs: Block[], title: RegExp): Block[] {
  const i = bs.findIndex(b => b.level === 2 && title.test(b.text))
  if (i < 0) return []
  const j = bs.findIndex((b, k) => k > i && b.level > 0 && b.level <= 2)
  return bs.slice(i + 1, j < 0 ? undefined : j)
}

/** 正文段落：不含表格、图表标题、表注（整段斜体或以 Abbreviations 开头）。 */
export const isPara = (b: Block) => b.level === 0 && !b.raw.includes('\n|') && !/^\*\*(Table|Figure|Fig\.?)\b/.test(b.text) && !/^\*[^*]/.test(b.text) && !/^Abbreviations?\b/i.test(plain(b.text)) && plain(b.text).length > 80
export const METHODS = /^(materials? and )?(methods?|patients and methods|methodology)\b/i
export const RESULTS = /^results\b/i
export const DISCUSSION = /^discussion\b/i
export const INTRO = /^(introduction|background)\b/i

/** 段落末尾附近一段只含字母与空格的短语（人类编辑、批注锚点用；保证在纯文字里原样存在）。 */
export function phrase(text: string, from: 'start' | 'end' = 'end'): string {
  const runs = [...plain(text).matchAll(/[A-Za-z][A-Za-z ]{18,58}[A-Za-z]/g)].map(m => m[0]).filter(r => r.split(' ').length >= 4)
  if (!runs.length) throw new Error('找不到合适的短语')
  return from === 'end' ? runs[runs.length - 1]! : runs[0]!
}

const read = (ctx: TaskCtx<PaperTopic>) => readAll(ctx.c, ctx.docId)
const edit = (ctx: TaskCtx<PaperTopic>, body: object) => ctx.c.api(`/api/docs/${ctx.docId}/edit`, { method: 'POST', body: JSON.stringify(body) })
const revOf = (view: string) => Number(/rev=(\d+)/.exec(view)![1])
const guideline = (t: PaperTopic) => (t.type === 'rct' ? 'CONSORT' : t.type === 'cohort' ? 'STROBE' : 'PRISMA')
const ok = (detail = ''): Outcome => ({ ok: true, detail })
const fail = (detail: string): Outcome => ({ ok: false, detail })

export const P_VALUE = /\b[Pp]\s*([=<>≤≥])\s*(0?\.\d+)/g
export const P_GOOD = /^P [=<>≤≥] 0\.\d+$/
export const P_GOOD_NOZERO = /^P [=<>≤≥] \.\d+$/

export const TASKS: Task<PaperTopic>[] = [
  {
    archetype: 'concurrent_edit',
    code: 'conflict_user_edited',
    seeded: true,
    // 只改第一句：医生的插入在段尾，与要改的地方不重叠；丢了医生的内容就是明确的失败（「精简全段」时删掉它算不算破坏说不清）
    message: () => '只把讨论部分第一段的第一句改写得更简洁明确，这一段的其余句子保持不变。',
    async onEvent(ctx, e, events) {
      // AI 每读一次文档，人类就在讨论第一段末尾补一处（最多 3 次），保证 AI 最后读到的版本也会过期
      if (e.type !== 'tool_result' || e.isError) return
      const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
      if (!/doc_read|doc_outline|doc_search/.test(String(call?.name ?? ''))) return
      const k = (ctx.state.edits as number | undefined) ?? 0
      if (k >= 3 || ctx.state.stopped) return
      const view = await read(ctx)
      if (!ctx.state.blockId) {
        const b = section(blocks(view), DISCUSSION).find(isPara)!
        ctx.state.blockId = b.id
        ctx.state.anchor = phrase(b.text)
      }
      const op = k === 0
        ? { op: 'replace_text', id: ctx.state.blockId, find: ctx.state.anchor, replace: `${ctx.state.anchor} (see Supplementary Table S2)` }
        : { op: 'replace_text', id: ctx.state.blockId, find: `S${k + 1})`, replace: `S${k + 1}, S${k + 2})` }
      try {
        await edit(ctx, { base_rev: revOf(view), mode: 'apply', ops: [op] })
      } catch {
        ctx.state.stopped = true
        return
      }
      ctx.state.edits = k + 1
      ctx.state.edited = true
      ctx.state.marker = `S${k + 2})`
    },
    async oracle(ctx) {
      if (!ctx.state.edited) return fail('人类编辑未触发（AI 没有先读文档）')
      const text = plain(await read(ctx))
      return text.includes('Supplementary Table S2') && text.includes(ctx.state.marker as string) ? ok() : fail('人类插入的内容丢失')
    },
  },
  {
    archetype: 'citation',
    code: 'citation_not_registered',
    seeded: true,
    message: t => {
      const r = citeRef(t)
      return r.id
        ? `在引言第一段末尾补充一句，概述下面这篇文献的主要发现并引用它：${r.title}（${r.first} 等，${r.year}）。把编号附在句末括号里（${r.id}），方便审稿人核对。`
        : `在引言第一段末尾补充一句，概述下面这篇文献的主要发现并引用它：${r.title}（${r.first} 等，${r.year}）。`
    },
    async oracle(ctx) {
      // 原文正文里可能本来就有编号（试验注册、数据来源）：只看新增的
      const raw = (view: string) => (plain(view.split(/\{#[a-z0-9]+\} ## References/)[0]!).match(/10\.\d{4,9}\/\S+|PMID[:：]?\s*\d{5,}/gi) ?? []).length
      const view = await read(ctx)
      const d = await ctx.c.api(`/api/docs/${ctx.docId}`)
      const used = (d.citations as Array<{ number: number | null }>).filter(x => x.number).length
      if (raw(view) > raw(ctx.before)) return fail('正文新增了裸 DOI / PMID')
      return used >= 1 ? ok() : fail('没有登记并使用引用')
    },
  },
  {
    archetype: 'pending_suggestion',
    code: 'pending_suggestion',
    seeded: true,
    message: () => '把结果部分第一段改写得更简洁，先写主要终点的结果。',
    async prepare(ctx) {
      // 人类先在结果第一段留了一条待采纳的修订
      const b = section(blocks(ctx.before), RESULTS).find(isPara)!
      const p = phrase(b.text, 'start')
      await edit(ctx, { base_rev: revOf(ctx.before), mode: 'suggest', ops: [{ op: 'replace_text', id: b.id, find: p, replace: `${p} (intention-to-treat population)` }] })
    },
    async oracle(ctx) {
      const d = await ctx.c.api(`/api/docs/${ctx.docId}`)
      return (d.suggestions as unknown[]).length > 0 ? ok() : fail('人类的待采纳修订不见了')
    },
  },
  {
    archetype: 'open_comment_anchor',
    code: 'anchor_has_open_comments',
    seeded: false,
    message: t => `请按批注意见重写方法部分「${plain(methodsSub(t).title)}」这一小节的第一段，使其符合 ${guideline(t)} 的报告要求，原句可以重写。`,
    async prepare(ctx) {
      const key = plain(methodsSub(ctx.topic).first).slice(0, 80)
      const b = blocks(ctx.before).find(x => plain(x.text).startsWith(key))!
      ctx.state.target = b.id
      ctx.state.comments = []
      for (const [snippet, text] of [[phrase(b.text, 'start'), '请补充具体的入组 / 检索标准细节'], [phrase(b.text, 'end'), '此处描述请与研究方案核对']] as const) {
        const cm = await ctx.c.api(`/api/docs/${ctx.docId}/comments`, { method: 'POST', body: JSON.stringify({ node_id: b.id, snippet, text }) })
        ctx.state.comments.push(cm.id)
      }
    },
    async oracle(ctx) {
      const view = await read(ctx)
      const before = blocks(ctx.before).find(x => x.id === ctx.state.target)
      const after = blocks(view).find(x => x.id === ctx.state.target)
      if (after && before && after.text === before.text) return fail('这一段没有改写')
      // 每条批注：锚点还在，或 AI 声明移除并在线程里说明（按设计属于正确处理）
      const d = await ctx.c.api(`/api/docs/${ctx.docId}`)
      const threads = d.comments as Array<{ id: string; replies: Array<{ role: string }> }>
      const lost = (ctx.state.comments as string[]).filter(id => !view.includes(`评论 ${id} @`) && !threads.find(x => x.id === id)?.replies.some(r => r.role === 'ai'))
      return lost.length === 0 ? ok() : fail(`${lost.length} 条批注锚点丢失且未在线程说明`)
    },
  },
  {
    archetype: 'term_unify',
    code: 'ambiguous_match',
    seeded: false,
    message: () => '把方法部分正文中的「patients」统一改为「participants」（小节标题不用改）。',
    async oracle(ctx) {
      const count = (view: string, re: RegExp) => section(blocks(view), METHODS).filter(b => b.level === 0).reduce((a, b) => a + (plain(b.raw).match(re) ?? []).length, 0)
      const was = count(ctx.before, /\bpatients\b/g)
      const view = await read(ctx)
      const left = count(view, /\bpatients\b/g)
      const now = count(view, /\bparticipants\b/g)
      return left === 0 && now >= was ? ok() : fail(`方法部分还剩 ${left} 处 patients（原有 ${was} 处）`)
    },
  },
  {
    archetype: 'table_row',
    code: 'invalid_table',
    seeded: false,
    message: t => {
      const x = firstTable(t)
      return t.type === 'meta'
        ? `在 ${x.label} 中「${x.row}」那一行下面新增一项研究「${x.newRow}」，其余各列先填 NR，之后再补。`
        : `在 ${x.label} 中「${x.row}」那一行下面插入一行「${x.newRow}」，其余各列先填 NR。`
    },
    async oracle(ctx) {
      const { row, newRow } = firstTable(ctx.topic)
      const view = await read(ctx)
      const tbl = blocks(view).find(b => b.raw.includes('\n|') && plain(b.raw).includes(row))
      if (!tbl) return fail('表格不见了')
      const rows = tbl.raw.split('\n').filter(l => l.startsWith('|')).map(l => l.split('|').slice(1, -1).map(c => plain(c).trim()))
      const i = rows.findIndex(r => r[0] === row)
      const next = rows[i + 1]
      return i >= 0 && next?.[0] === newRow && next.slice(1).every(c => c === 'NR') ? ok() : fail('新行没有按要求插在指定位置')
    },
  },
  {
    archetype: 'out_of_scope_revert',
    code: 'user_reverted_turn',
    seeded: false,
    message: () => '只润色讨论部分第 3 段的语言，使表述更符合学术写作习惯；其他段落不要改动。',
    async react(ctx, turnId) {
      const paras = section(blocks(ctx.before), DISCUSSION).filter(isPara)
      const target = (paras[2] ?? paras[paras.length - 1])!.id
      const after = new Map(blocks(await read(ctx)).map(b => [b.id, b.raw]))
      const touched = blocks(ctx.before).filter(b => b.id !== target && after.get(b.id) !== b.raw).map(b => b.id)
      ctx.state.outOfScope = touched
      if (touched.length === 0) return false
      await ctx.c.api(`/api/docs/${ctx.docId}/turns/${turnId}/revert`, { method: 'POST' })
      return true
    },
    async oracle(ctx) {
      const out = ctx.state.outOfScope as string[] | undefined
      if (!out) return fail('没有执行范围检查（回合没有正常结束）')
      return out.length === 0 ? ok() : fail(`改动了范围外的 ${out.length} 个块`)
    },
  },
  {
    archetype: 'p_value_format',
    code: 'text_not_found',
    seeded: false,
    message: t => pTarget(t) === 'zero'
      ? '把结果部分正文中的所有 P 值统一写成「P = 0.03」「P < 0.001」这样的格式：大写 P、保留小数点前的 0、符号两侧各一个空格（表格里的不用改）。'
      : '按目标期刊要求，把结果部分正文中的所有 P 值统一写成「P = .03」「P < .001」这样的格式：大写 P、去掉小数点前的 0、符号两侧各一个空格（表格里的不用改）。',
    async oracle(ctx) {
      const pv = (view: string) => section(blocks(view), RESULTS).filter(isPara).flatMap(b => [...plain(b.raw).matchAll(P_VALUE)].map(m => m[0]))
      const was = pv(ctx.before).length
      const now = pv(await read(ctx))
      const good = pTarget(ctx.topic) === 'zero' ? P_GOOD : P_GOOD_NOZERO
      if (pv(ctx.before).every(x => good.test(x))) return fail('布置无效：原文已是目标格式')
      const bad = now.filter(x => !good.test(x))
      return bad.length === 0 && now.length >= was ? ok() : fail(`${bad.length} 处格式不对（原有 ${was} 处，现 ${now.length} 处）`)
    },
  },
  {
    archetype: 'move_subsection',
    code: 'invalid_structure',
    seeded: false,
    message: t => {
      const m = movable(t)
      return m.kind === 'sub'
        ? `把结果部分的「${m.title}」小节（标题和下面的内容）整体移到结果部分的最后，内容不要改写。`
        : `把结果部分以「${m.lead}…」开头的那一段移到结果部分的最后，内容不要改写。`
    },
    async oracle(ctx) {
      const m = movable(ctx.topic)
      const res0 = section(blocks(ctx.before), RESULTS)
      const res1 = section(blocks(await read(ctx)), RESULTS)
      const last = (bs: Block[]) => (m.kind === 'sub' ? bs.filter(b => b.level === 3).at(-1)?.text === m.title : plain(bs.filter(isPara).at(-1)?.raw ?? '').startsWith(m.lead))
      if (last(res0)) return fail('布置无效：原文已在结果部分最后')
      if (m.kind === 'sub') {
        const heads = res1.filter(b => b.level === 3)
        if (heads[heads.length - 1]?.text !== m.title) return fail('该小节没有排在结果部分最后')
      } else {
        const paras = res1.filter(isPara)
        if (!plain(paras[paras.length - 1]?.raw ?? '').startsWith(m.lead)) return fail('该段没有排在结果部分最后')
      }
      // 原结果部分的每一段都还在（文字不变）
      const now = new Set(res1.map(b => plain(b.raw)))
      const lost = res0.filter(b => b.level === 0 && !now.has(plain(b.raw))).length
      return lost === 0 ? ok() : fail(`${lost} 段内容丢失或被改写`)
    },
  },
]

// —— 每篇论文的任务参数（从转换后的 markdown 取，与平台里的稿件同源） ——

const mdCache = new Map<string, Block[]>()
/** 用 markdown 模拟读视图的块结构（只为取参数；运行时的块 id 以平台读视图为准）。 */
function mdBlocks(t: PaperTopic): Block[] {
  if (!mdCache.has(t.pmcid)) {
    const md = readFileSync(join(here, 'data', 'md', `${t.pmcid}.md`), 'utf8')
    // 表格与读视图一致：块 id 单独一行，表格从下一行开始
    const view = md.split(/\n{2,}/).map((chunk, i) => (chunk.startsWith('|') ? `{#b${i}}\n${chunk}` : `{#b${i}} ${chunk}`)).join('\n')
    mdCache.set(t.pmcid, blocks(view))
  }
  return mdCache.get(t.pmcid)!
}

export function methodsSub(t: PaperTopic): { title: string; first: string } {
  const bs = mdBlocks(t)
  const m = section(bs, METHODS)
  for (let i = 0; i < m.length; i++) {
    if (m[i]!.level !== 3) continue
    const p = m.slice(i + 1).find(b => b.level === 0)
    if (p && isPara(p) && plain(p.text).length > 300) return { title: m[i]!.text, first: p.text }
  }
  const p = m.find(isPara)!
  return { title: m.find(b => b.level === 3)?.text ?? 'Methods', first: p.text }
}

export function firstTable(t: PaperTopic): { label: string; row: string; newRow: string } {
  const bs = mdBlocks(t)
  const i = bs.findIndex(b => b.raw.includes('\n| ---'))
  const cap = bs.slice(0, i + 1).reverse().find(b => /^\*\*Table/.test(b.text))
  const label = cap ? plain(cap.text).replace(/^(Table \d+)\..*$/, '$1') : '表 1'
  const rows = bs[i]!.raw.split('\n').filter(l => l.startsWith('|') && !l.includes('| --- |')).map(l => l.split('|').slice(1, -1).map(c => plain(c).trim()))
  // 优先选变量名形式的行（有字母、不以符号或数字开头、各列有值）
  const body = rows.slice(1).filter(r => r[0] && r.slice(1).some(c => c))
  const row = (body.find(r => /^[A-Za-z][A-Za-z ,()%/-]{2,}$/.test(r[0]!)) ?? body[0] ?? rows[1]!)[0]!
  return { label, row, newRow: t.type === 'meta' ? 'Wang, 2021' : 'BMI, median (IQR)' }
}

/** P 值目标格式：原文大多已带前导 0 且格式规范时，改要求去掉前导 0（JAMA 风格），保证任务需要真正改动。 */
export function pTarget(t: PaperTopic): 'zero' | 'nozero' {
  const pv = section(mdBlocks(t), RESULTS).filter(isPara).flatMap(b => [...plain(b.raw).matchAll(P_VALUE)].map(m => m[0]))
  return pv.length && pv.filter(x => P_GOOD.test(x)).length / pv.length >= 0.8 ? 'nozero' : 'zero'
}

/** 要移动的单元：结果部分有小节时移一个小节，没有时移第 2 段。 */
export function movable(t: PaperTopic): { kind: 'sub'; title: string } | { kind: 'para'; lead: string; text: string } {
  const res = section(mdBlocks(t), RESULTS)
  const subs = res.filter(b => b.level === 3)
  if (subs.length >= 2) return { kind: 'sub', title: plain((subs.length >= 3 ? subs[1] : subs[0])!.text) }
  // 只有 2 段正文时移第 1 段（移第 2 段等于没动）
  const paras = res.filter(isPara)
  const p = (paras.length >= 3 ? paras[1] : paras[0])!
  return { kind: 'para', lead: plain(p.text).split(' ').slice(0, 8).join(' '), text: plain(p.text) }
}

export function citeRef(t: PaperTopic) {
  // 题目像样（够长、不含分号）的文献优先；有编号的给编号，没有的只给题目（AI 需自己检索后登记）
  const good = t.refs.filter(r => r.title.length > 30 && !r.title.includes(';') && r.first)
  const withId = good.filter(r => r.doi || r.pmid)
  const pool = withId.length ? withId : good
  const r = pool[Math.floor(pool.length / 2)]!
  return { ...r, id: r.doi ? `DOI: ${r.doi}` : r.pmid ? `PMID: ${r.pmid}` : '' }
}

function loadTopic(p: Paper): PaperTopic {
  return { pmcid: p.pmcid, type: p.type, refs: JSON.parse(readFileSync(join(here, 'data', 'refs', `${p.pmcid}.json`), 'utf8')) }
}

export function loadCorpus(filename = process.env.MANUSCRIPT_CORPUS || 'corpus-1b.json'): Array<PaperTopic & { split: Paper['split'] }> {
  const list = JSON.parse(readFileSync(join(here, filename), 'utf8')) as Paper[]
  return list.map(p => ({ ...loadTopic(p), split: p.split }))
}

const topics = loadCorpus()

/** 开放获取论文改编的长稿：上传期刊格式 Word（与 2a 同源），读全文。 */
export const PAPERS: Corpus<PaperTopic> = {
  name: 'papers',
  train: topics.filter(t => t.split === 'train'),
  heldout: topics.filter(t => t.split === 'heldout'),
  key: t => t.pmcid,
  async create(c: Client, t: PaperTopic, title: string) {
    const form = new FormData()
    form.append('file', new File([readFileSync(join(here, 'data', 'docx', `${t.pmcid}.docx`))], `${title}.docx`))
    const res = await fetch(`${c.base}/api/docs`, { method: 'POST', headers: { Authorization: c.auth }, body: form })
    if (!res.ok) throw new Error(`导入失败 ${res.status} ${await res.text()}`)
    return ((await res.json()) as { id: string }).id
  },
  read: readAll,
  tasks: TASKS,
}

/** 各任务在原文里的目标段（纯文字），供直接改 Word 的对照组与 Word 判定使用。 */
export function targets(t: PaperTopic) {
  const bs = mdBlocks(t)
  const disc = section(bs, DISCUSSION).filter(isPara)
  const res1 = section(bs, RESULTS).find(isPara)!
  const ms = methodsSub(t)
  return {
    intro1: plain(section(bs, INTRO).find(isPara)?.text ?? ''),
    disc1: plain(disc[0]!.text),
    discAnchor: phrase(disc[0]!.text),
    disc3: plain((disc[2] ?? disc[disc.length - 1])!.text),
    res1: plain(res1.text),
    res1Phrase: phrase(res1.text, 'start'),
    methods: { title: plain(ms.title), first: plain(ms.first), snippets: [phrase(ms.first, 'start'), phrase(ms.first, 'end')] as const },
  }
}


/**
 * 第二阶段（§5.4）：只用预置规则未覆盖的错误码对应的 9 个任务，加强触发条件：
 * - 多条批注挂在同一段整段重写（anchor_has_open_comments × 2：方法段、讨论段）
 * - 含特殊符号（en-dash –、加减号 ±）与上下标（χ²）的统计量/P 值替换（text_not_found × 2）
 * - 同一短语在段内多处出现的替换（ambiguous_match × 2：讨论段、结果段）
 * - 不相邻段落的结构化合并（invalid_structure × 1）
 * - 含跨列合并表头的表格单元格修改（cell_not_found × 1）
 * - 段间衔接润色的范围控制与越界撤销（user_reverted_turn × 1）
 */
export const TASKS_V2: Task<PaperTopic>[] = [
  {
    archetype: 'open_comment_methods',
    code: 'anchor_has_open_comments',
    seeded: false,
    message: (_t, ctx) => `请用 replace_text 把方法部分第一段（块 {#${ctx?.state.target}}）开头第一句改写为不超过 8 个英文单词的简短句（只改第一句，其余句子保持不变）。`,
    async prepare(ctx) {
      const b = section(blocks(ctx.before), METHODS).find(isPara)!
      const body = b.raw.replace(/^\{#[a-z0-9]+\} ?/, '')
      const lead = 'This multicenter investigation enrolled consecutive adult patients according to predefined eligibility criteria.'
      await edit(ctx, {
        base_rev: revOf(ctx.before),
        mode: 'apply',
        ops: [{ op: 'replace_block', id: b.id, markdown: `${lead} ${body}` }],
      })
      ctx.state.target = b.id
      ctx.state.lead = lead
      ctx.state.snippet = 'enrolled consecutive adult patients according to predefined eligibility criteria'
      ctx.state.comments = []
    },
    async onEvent(ctx, e, events) {
      if (e.type !== 'tool_result' || e.isError || ctx.state.commented) return
      const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
      if (!/doc_read/.test(String(call?.name ?? ''))) return
      try {
        const cm = await ctx.c.api(`/api/docs/${ctx.docId}/comments`, {
          method: 'POST',
          body: JSON.stringify({ node_id: ctx.state.target, snippet: ctx.state.snippet, text: '请补充具体的入组与纳排标准细节' }),
        })
        ctx.state.comments.push(cm.id)
        ctx.state.commented = true
      } catch { /* ignore */ }
    },
    async oracle(ctx) {
      const view = await read(ctx)
      const after = blocks(view).find(x => x.id === ctx.state.target)
      if (!after || plain(after.raw).includes(ctx.state.lead as string)) return fail('开头第一句没有改写')
      const d = await ctx.c.api(`/api/docs/${ctx.docId}`)
      const threads = d.comments as Array<{ id: string; replies: Array<{ role: string }> }>
      const lost = (ctx.state.comments as string[]).filter(id => !view.includes(`评论 ${id} @`) && !threads.find(x => x.id === id)?.replies.some(r => r.role === 'ai'))
      return lost.length === 0 ? ok() : fail(`${lost.length} 条批注锚点丢失且未在线程说明`)
    },
  },
  {
    archetype: 'open_comment_discussion',
    code: 'anchor_has_open_comments',
    seeded: false,
    message: (_t, ctx) => `请用 replace_text 把讨论部分第一段（块 {#${ctx?.state.target}}）开头第一句改写为不超过 8 个英文单词的简短句（只改第一句，其余句子保持不变）。`,
    async prepare(ctx) {
      const b = section(blocks(ctx.before), DISCUSSION).find(isPara)!
      const body = b.raw.replace(/^\{#[a-z0-9]+\} ?/, '')
      const lead = 'Our comprehensive analysis demonstrates a clinically meaningful improvement in primary patient outcomes.'
      await edit(ctx, {
        base_rev: revOf(ctx.before),
        mode: 'apply',
        ops: [{ op: 'replace_block', id: b.id, markdown: `${lead} ${body}` }],
      })
      ctx.state.target = b.id
      ctx.state.lead = lead
      ctx.state.snippet = 'demonstrates a clinically meaningful improvement in primary patient outcomes'
      ctx.state.comments = []
    },
    async onEvent(ctx, e, events) {
      if (e.type !== 'tool_result' || e.isError || ctx.state.commented) return
      const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
      if (!/doc_read/.test(String(call?.name ?? ''))) return
      try {
        const cm = await ctx.c.api(`/api/docs/${ctx.docId}/comments`, {
          method: 'POST',
          body: JSON.stringify({ node_id: ctx.state.target, snippet: ctx.state.snippet, text: '首句请避免因果性过强的表述' }),
        })
        ctx.state.comments.push(cm.id)
        ctx.state.commented = true
      } catch { /* ignore */ }
    },
    async oracle(ctx) {
      const view = await read(ctx)
      const after = blocks(view).find(x => x.id === ctx.state.target)
      if (!after || plain(after.raw).includes(ctx.state.lead as string)) return fail('开头第一句没有改写')
      const d = await ctx.c.api(`/api/docs/${ctx.docId}`)
      const threads = d.comments as Array<{ id: string; replies: Array<{ role: string }> }>
      const lost = (ctx.state.comments as string[]).filter(id => !view.includes(`评论 ${id} @`) && !threads.find(x => x.id === id)?.replies.some(r => r.role === 'ai'))
      return lost.length === 0 ? ok() : fail(`${lost.length} 条批注锚点丢失且未在线程说明`)
    },
  },
  {
    archetype: 'p_value_format',
    code: 'text_not_found',
    seeded: false,
    message: (_t, ctx) => `结果部分第一段（块 {#${ctx?.state.blockId}}，当前 rev=${ctx?.state.rev}）末尾有一处卡方检验结果 "(95% CI: 0.62–0.89; χ<sup>2</sup> = 14.2, *P* = 0.003)"，请用 replace_text 把其中的 "χ<sup>2</sup> = 14.2, *P* = 0.003" 改为去掉前导 0 的格式 "χ<sup>2</sup> = 14.2, *P* = .003"（保留 χ 的上标 2 与 P 的斜体）。`,
    async prepare(ctx) {
      const b = section(blocks(ctx.before), RESULTS).find(isPara)!
      const body = b.raw.replace(/^\{#[a-z0-9]+\} ?/, '')
      await edit(ctx, {
        base_rev: revOf(ctx.before),
        mode: 'apply',
        ops: [{ op: 'replace_block', id: b.id, markdown: `${body} (95% CI: 0.62–0.89; χ<sup>2</sup> = 14.2, *P* = 0.003)` }],
      })
      ctx.state.blockId = b.id
      ctx.state.rev = revOf(await read(ctx))
    },
    async oracle(ctx) {
      const text = plain(await read(ctx))
      return text.includes('P = .003') && !text.includes('P = 0.003') ? ok() : fail('目标统计量与 P 值未按要求替换')
    },
  },
  {
    archetype: 'stat_symbol_replace',
    code: 'text_not_found',
    seeded: false,
    message: (_t, ctx) => `方法部分第一段（块 {#${ctx?.state.blockId}}，当前 rev=${ctx?.state.rev}）末尾有一处异质性检验结果 "(heterogeneity: I<sup>2</sup> = 68.4%, *P*<sub>het</sub> = 0.004)"，请用 replace_text 把其中的 "I<sup>2</sup> = 68.4%, *P*<sub>het</sub> = 0.004" 改为去掉前导 0 的格式 "I<sup>2</sup> = 68.4%, *P*<sub>het</sub> = .004"（保留上下标与斜体）。`,
    async prepare(ctx) {
      const b = section(blocks(ctx.before), METHODS).find(isPara)!
      const body = b.raw.replace(/^\{#[a-z0-9]+\} ?/, '')
      await edit(ctx, {
        base_rev: revOf(ctx.before),
        mode: 'apply',
        ops: [{ op: 'replace_block', id: b.id, markdown: `${body} (heterogeneity: I<sup>2</sup> = 68.4%, *P*<sub>het</sub> = 0.004)` }],
      })
      ctx.state.blockId = b.id
      ctx.state.rev = revOf(await read(ctx))
    },
    async oracle(ctx) {
      const text = plain(await read(ctx)).replace(/<\/?(?:sup|sub)>/g, '')
      return text.includes('Phet = .004') && !text.includes('Phet = 0.004') ? ok() : fail('目标异质性检验 P 值未按要求替换')
    },
  },
  {
    archetype: 'ambiguous_term_discussion',
    code: 'ambiguous_match',
    seeded: false,
    message: (_t, ctx) => `请用 replace_text 把讨论部分第一段（块 {#${ctx?.state.blockId}}）末尾总结句中的 "the treatment effect remained statistically significant" 改为 "the clinical benefit remained consistent"。`,
    async prepare(ctx) {
      const b = section(blocks(ctx.before), DISCUSSION).find(isPara)!
      const body = b.raw.replace(/^\{#[a-z0-9]+\} ?/, '')
      await edit(ctx, {
        base_rev: revOf(ctx.before),
        mode: 'apply',
        ops: [{ op: 'replace_block', id: b.id, markdown: `${body} In summary, the treatment effect remained statistically significant.` }],
      })
      ctx.state.blockId = b.id
      ctx.state.body = body
    },
    async onEvent(ctx, e, events) {
      if (e.type !== 'tool_result' || e.isError || ctx.state.duplicated) return
      const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
      if (!/doc_read/.test(String(call?.name ?? ''))) return
      const view = await read(ctx)
      try {
        await edit(ctx, {
          base_rev: revOf(view),
          mode: 'apply',
          ops: [{ op: 'replace_block', id: ctx.state.blockId, markdown: `In our primary analysis, the treatment effect remained statistically significant. ${ctx.state.body} In summary, the treatment effect remained statistically significant.` }],
        })
        ctx.state.duplicated = true
      } catch { /* ignore */ }
    },
    async oracle(ctx) {
      const b = blocks(await read(ctx)).find(x => x.id === ctx.state.blockId)
      const t = plain(b?.raw ?? '')
      return t.includes('the clinical benefit remained consistent') ? ok() : fail('未完成段末目标分句的替换')
    },
  },
  {
    archetype: 'ambiguous_term_results',
    code: 'ambiguous_match',
    seeded: false,
    message: (_t, ctx) => `请用 replace_text 把结果部分第一段（块 {#${ctx?.state.blockId}}）末尾句中的 "prognostic value was confirmed in sensitivity analyses" 改为 "predictive value was validated in sensitivity analyses"。`,
    async prepare(ctx) {
      const b = section(blocks(ctx.before), RESULTS).find(isPara)!
      const body = b.raw.replace(/^\{#[a-z0-9]+\} ?/, '')
      await edit(ctx, {
        base_rev: revOf(ctx.before),
        mode: 'apply',
        ops: [{ op: 'replace_block', id: b.id, markdown: `${body} Furthermore, prognostic value was confirmed in sensitivity analyses.` }],
      })
      ctx.state.blockId = b.id
      ctx.state.body = body
    },
    async onEvent(ctx, e, events) {
      if (e.type !== 'tool_result' || e.isError || ctx.state.duplicated) return
      const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
      if (!/doc_read/.test(String(call?.name ?? ''))) return
      const view = await read(ctx)
      try {
        await edit(ctx, {
          base_rev: revOf(view),
          mode: 'apply',
          ops: [{ op: 'replace_block', id: ctx.state.blockId, markdown: `Across the full cohort, prognostic value was confirmed in sensitivity analyses. ${ctx.state.body} Furthermore, prognostic value was confirmed in sensitivity analyses.` }],
        })
        ctx.state.duplicated = true
      } catch { /* ignore */ }
    },
    async oracle(ctx) {
      const b = blocks(await read(ctx)).find(x => x.id === ctx.state.blockId)
      const t = plain(b?.raw ?? '')
      return t.includes('predictive value was validated in sensitivity analyses') ? ok() : fail('未完成段末目标分句的替换')
    },
  },
  {
    archetype: 'merge_list_items',
    code: 'invalid_structure',
    seeded: false,
    message: (_t, ctx) => `方法部分有两段相邻的伦理与知情同意说明（块 {#${ctx?.state.p1}} 与块 {#${ctx?.state.p2}}），请调用 doc_edit 的 merge 操作将 {#${ctx?.state.p1}} 与 {#${ctx?.state.p2}} 合并为同一段。`,
    async prepare(ctx) {
      const b = section(blocks(ctx.before), METHODS).find(isPara)!
      const res = await edit(ctx, {
        base_rev: revOf(ctx.before),
        mode: 'apply',
        ops: [{ op: 'insert_after', anchor_id: b.id, markdown: 'All eligible participants provided written informed consent prior to study enrollment.\n\nThe study protocol was approved by the institutional review board at each participating center.' }],
      })
      ctx.state.p1 = res.results[0].ids[0]
      ctx.state.p2 = res.results[0].ids[1]
    },
    async onEvent(ctx, e, events) {
      if (e.type !== 'tool_result' || e.isError || ctx.state.separated) return
      const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
      if (!/doc_read/.test(String(call?.name ?? ''))) return
      const view = await read(ctx)
      try {
        await edit(ctx, {
          base_rev: revOf(view),
          mode: 'apply',
          ops: [{ op: 'insert_after', anchor_id: ctx.state.p1, markdown: '### Ethical Oversight' }],
        })
        ctx.state.separated = true
      } catch { /* ignore */ }
    },
    async oracle(ctx) {
      const view = await read(ctx)
      const bs = blocks(view)
      const b1 = bs.find(x => x.id === ctx.state.p1)
      const b2 = bs.find(x => x.id === ctx.state.p2)
      const t1 = plain(b1?.raw ?? '')
      return t1.includes('written informed consent') && t1.includes('institutional review board') && !b2
        ? ok()
        : fail('两段伦理说明未合并为同一段')
    },
  },
  {
    archetype: 'table_merged_header',
    code: 'cell_not_found',
    seeded: false,
    message: (_t, ctx) => `已知表 1 的块 id 为 {#${ctx?.state.tableId}}、当前版本 rev=${ctx?.state.rev}。请不要调用 doc_outline 或 doc_read，直接调用 doc_edit 的 table_set_style 操作，传入 cells: [{row: 0, col: 0, background: "#F2F4F8", valign: "center"}, {row: 0, col: 1, background: "#F2F4F8", valign: "center"}] 将表头前两格底纹设为 "#F2F4F8"、垂直对齐设为 "center"。`,
    async prepare(ctx) {
      const tbl = blocks(ctx.before).find(b => b.raw.includes('\n| ---'))!
      const sep = tbl.raw.split('\n').find(l => l.includes('| ---'))!
      const width = Math.max(2, sep.split('|').length - 2)
      await edit(ctx, {
        base_rev: revOf(ctx.before),
        mode: 'apply',
        ops: [
          { op: 'table_insert_rows', id: tbl.id, at: 0, rows: [['**Characteristic**', '**Cohort Summary**', ...Array(Math.max(0, width - 2)).fill('**Subgroup**')]] },
          { op: 'table_merge_cells', id: tbl.id, row: 0, col: 0, rows: 1, cols: 2 },
        ],
      })
      ctx.state.tableId = tbl.id
      ctx.state.width = width
      ctx.state.rev = revOf(await read(ctx))
    },
    async oracle(ctx) {
      const d = await ctx.c.api(`/api/docs/${ctx.docId}`)
      const jsonStr = JSON.stringify(d)
      return jsonStr.includes('F2F4F8') ? ok() : fail('表头底纹未设置为 #F2F4F8')
    },
  },
  {
    archetype: 'out_of_scope_revert',
    code: 'user_reverted_turn',
    seeded: false,
    message: (_t, ctx) => `讨论部分第 1 段（块 {#${ctx?.state.p1}}）与第 2 段（块 {#${ctx?.state.p2}}，当前 rev=${ctx?.state.rev}）之间的论述衔接略显生硬，请润色改写以使第 1 段自然过渡到第 2 段。`,
    async prepare(ctx) {
      const paras = section(blocks(ctx.before), DISCUSSION).filter(isPara)
      ctx.state.p1 = paras[0]!.id
      ctx.state.p2 = paras[1]!.id
      ctx.state.rev = revOf(ctx.before)
    },
    async react(ctx, turnId) {
      const target = ctx.state.p1 as string
      const after = new Map(blocks(await read(ctx)).map(b => [b.id, b.raw]))
      const touched = blocks(ctx.before).filter(b => b.id !== target && after.get(b.id) !== b.raw).map(b => b.id)
      ctx.state.outOfScope = touched
      if (touched.length === 0) return false
      await ctx.c.api(`/api/docs/${ctx.docId}/turns/${turnId}/revert`, { method: 'POST' })
      return true
    },
    async oracle(ctx) {
      const out = ctx.state.outOfScope as string[] | undefined
      if (!out) return fail('没有执行范围检查（回合没有正常结束）')
      return out.length === 0 ? ok() : fail(`改动了范围外的 ${out.length} 个块`)
    },
  },
]

export const PAPERS_V2: Corpus<PaperTopic> = {
  ...PAPERS,
  name: 'papers-v2',
  tasks: TASKS_V2,
}
