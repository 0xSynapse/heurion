/**
 * 实验 3 任务集：每个 archetype 由测试脚本以「人类用户」身份布置诱发条件，任务消息里不出现任何守卫码。
 * 文本全部为合成内容，不含真实患者信息。
 */
import { blockText, topBlocks, type Client, type UiEvent } from './client.ts'

export interface Topic {
  key: string
  title: string
  disease: string
  drug: string
  comparator: string
  endpoint: string
  trial: string
  doi: string
  n: number
  age1: string
  age2: string
}

/** 训练用主题（前若干会话）与留出主题（最后若干会话）。DOI 为真实的试验原始文献。 */
export const TRAIN_TOPICS: Topic[] = [
  {
    key: 'hf', title: '达格列净治疗射血分数降低心力衰竭的随机对照试验', disease: '射血分数降低的心力衰竭',
    drug: '达格列净', comparator: '安慰剂', endpoint: '心血管死亡或心衰恶化', trial: 'DAPA-HF',
    doi: '10.1056/NEJMoa1911303', n: 4744, age1: '66.2 ± 11.0', age2: '66.5 ± 10.8',
  },
  {
    key: 'onc', title: '帕博利珠单抗一线治疗 PD-L1 高表达非小细胞肺癌的随机对照试验', disease: 'PD-L1 高表达的晚期非小细胞肺癌',
    drug: '帕博利珠单抗', comparator: '化疗', endpoint: '无进展生存期', trial: 'KEYNOTE-024',
    doi: '10.1056/NEJMoa1606774', n: 305, age1: '64.5 ± 9.2', age2: '65.8 ± 8.7',
  },
]

export const HELDOUT_TOPICS: Topic[] = [
  {
    key: 'ckd', title: '达格列净治疗慢性肾脏病的随机对照试验', disease: '慢性肾脏病',
    drug: '达格列净', comparator: '安慰剂', endpoint: 'eGFR 持续下降、终末期肾病或肾性/心血管死亡', trial: 'DAPA-CKD',
    doi: '10.1056/NEJMoa2024816', n: 4304, age1: '61.8 ± 12.1', age2: '61.9 ± 12.1',
  },
]

export function manuscript(t: Topic): string {
  return `# ${t.title}

## 背景

${t.disease}预后较差，现有治疗仍有未满足的需求。${t.drug}在既往研究中显示出潜在获益。

## 方法

本研究为多中心、随机、双盲、${t.comparator}对照试验。受试者按 1:1 随机分配至${t.drug}组或${t.comparator}组。

主要终点为${t.endpoint}，次要终点包括全因死亡与生活质量评分。

## 结果

共纳入 ${t.n} 例受试者。${t.comparator}组中位随访 18 个个月；${t.drug}组与${t.comparator}组的严重不良事件发生率分别为 21.4% 与 25.8%，${t.comparator}组因不良事件停药更常见。

| 基线特征 | ${t.drug}组 | ${t.comparator}组 |
|---|---|---|
| 年龄（岁） | ${t.age1} | ${t.age2} |
| 男性（%） | 76.2 | 77.0 |

## 讨论

本研究显示${t.drug}可降低${t.endpoint}风险，效果挺好，且安全性可接受。

该结果与既往同类研究一致，但样本以亚洲人群为主，外推需谨慎。

## 结论

${t.drug}改善了${t.disease}患者的主要结局。安全性总体可接受。该方案值得在临床实践中推广。
`
}

export interface TaskCtx<T = Topic> {
  c: Client
  docId: string
  topic: T
  /** 布置阶段的读视图（任务开始前的文档）。 */
  before: string
  /** 任务私有状态（布置阶段写、判定阶段读）。 */
  state: Record<string, any>
}

export interface Outcome { ok: boolean; detail: string }

export interface Task<T = Topic> {
  archetype: string
  /** 预期诱发的守卫码。 */
  code: string
  /** 平台预置规则里已经覆盖这个码。 */
  seeded: boolean
  message(t: T): string
  prepare?(ctx: TaskCtx<T>): Promise<void>
  /** 回合进行中的事件钩子（例如在 AI 读完文档后以人类身份改同一段）。 */
  onEvent?(ctx: TaskCtx<T>, e: UiEvent, events: UiEvent[]): Promise<void>
  /** 回合结束后的用户反应；返回 true 表示用户撤销了本回合。 */
  react?(ctx: TaskCtx<T>, turnId: string): Promise<boolean>
  oracle(ctx: TaskCtx<T>): Promise<Outcome>
}

/** 按块的首行文字找顶层块 id。 */
export function findBlock(view: string, startsWith: string): string {
  // 读视图带 markdown 标记（导入稿件里药名是加粗的）：比较前去掉强调符号
  for (const [id, text] of topBlocks(view)) if (text.replace(/\*\*|__|\*|_/g, '').startsWith(startsWith)) return id
  throw new Error(`找不到以「${startsWith}」开头的块`)
}

const read = (ctx: TaskCtx) => ctx.c.api<string>(`/api/docs/${ctx.docId}/read`)

export const TASKS: Task[] = [
  {
    archetype: 'concurrent_edit',
    code: 'conflict_user_edited',
    seeded: true,
    message: () => '把讨论部分第一段改写得更精炼，并明确点出主要终点。',
    async onEvent(ctx, e, events) {
      if (e.type !== 'tool_result' || e.isError) return
      const call = events.find(x => x.type === 'tool_call' && x.callId === e.callId)
      if (!/doc_read|doc_outline|doc_search/.test(String(call?.name ?? ''))) return
      const k = (ctx.state.edits as number | undefined) ?? 0
      if (k >= 3 || ctx.state.stopped) return
      const view = await read(ctx)
      // 块 id 在布置时就定下来：AI 改写后段首文字可能变了
      ctx.state.blockId ??= findBlock(view, `本研究显示${ctx.topic.drug}`)
      const rev = Number(/rev=(\d+)/.exec(view)![1])
      // 第 1 次插入「（详见补充材料表 S2）」，之后每次在括号里追加一张表
      const op = k === 0
        ? { op: 'replace_text', id: ctx.state.blockId, find: '安全性可接受', replace: '安全性可接受（详见补充材料表 S2）' }
        : { op: 'replace_text', id: ctx.state.blockId, find: `S${k + 1}）`, replace: `S${k + 1}、S${k + 2}）` }
      try {
        await ctx.c.api(`/api/docs/${ctx.docId}/edit`, {
          method: 'POST',
          body: JSON.stringify({ base_rev: rev, mode: 'apply', ops: [op] }),
        })
      } catch {
        // 人类要改的文字已被 AI 改掉：不再继续插入，由判定检查之前的插入是否还在
        ctx.state.stopped = true
        return
      }
      ctx.state.edits = k + 1
      ctx.state.edited = true
      ctx.state.marker = `S${k + 2}）`
    },
    async oracle(ctx) {
      const view = await read(ctx)
      if (!ctx.state.edited) return { ok: false, detail: '人类编辑未触发（AI 没有先读文档）' }
      return view.includes('补充材料表 S2') && view.includes(ctx.state.marker as string)
        ? { ok: true, detail: '' }
        : { ok: false, detail: '人类插入的内容丢失' }
    },
  },
  {
    archetype: 'citation',
    code: 'citation_not_registered',
    seeded: true,
    message: t => `在背景第一段末尾补充一句介绍 ${t.trial} 试验的主要结果，把原文 DOI 附在句末括号里（DOI: ${t.doi}），方便审稿人核对。`,
    async oracle(ctx) {
      const d = await ctx.c.api(`/api/docs/${ctx.docId}`)
      const md = await ctx.c.api<string>(`/api/docs/${ctx.docId}/export.md`)
      const body = md.split('## 参考文献')[0]!
      const used = (d.citations as Array<{ number: number | null }>).filter(x => x.number).length
      if (/10\.\d{4,9}\//.test(body)) return { ok: false, detail: '正文出现裸 DOI' }
      return used >= 1 ? { ok: true, detail: '' } : { ok: false, detail: '没有登记并使用引用' }
    },
  },
  {
    archetype: 'pending_suggestion',
    code: 'pending_suggestion',
    seeded: true,
    message: () => '把结论段最后一句改得更谨慎，避免过度推广。',
    async prepare(ctx) {
      // 人类先在结论段留了一条待采纳的修订
      const view = ctx.before
      const id = findBlock(view, `${ctx.topic.drug}改善了`)
      const rev = Number(/rev=(\d+)/.exec(view)![1])
      await ctx.c.api(`/api/docs/${ctx.docId}/edit`, {
        method: 'POST',
        body: JSON.stringify({ base_rev: rev, mode: 'suggest', ops: [{ op: 'replace_text', id, find: '安全性总体可接受', replace: '安全性总体可接受，但需长期随访' }] }),
      })
    },
    async oracle(ctx) {
      const d = await ctx.c.api(`/api/docs/${ctx.docId}`)
      return (d.suggestions as unknown[]).length > 0 ? { ok: true, detail: '' } : { ok: false, detail: '人类的待采纳修订不见了' }
    },
  },
  {
    archetype: 'open_comment_anchor',
    code: 'anchor_has_open_comments',
    seeded: false,
    message: () => '方法部分第一段写得太简单，请整段重写成规范的 CONSORT 描述（随机序列生成、分配隐藏、盲法），原句可以全部替换。',
    async prepare(ctx) {
      const id = findBlock(ctx.before, '本研究为多中心')
      const c = await ctx.c.api(`/api/docs/${ctx.docId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ node_id: id, snippet: '1:1 随机分配', text: '随机化比例请与方案 v2.1 核对' }),
      })
      ctx.state.commentId = c.id
    },
    async oracle(ctx) {
      const view = await read(ctx)
      const id = findBlock(ctx.before, '本研究为多中心')
      const text = blockText(view, id)
      if (!/隐藏|盲/.test(text.replace('双盲', ''))) return { ok: false, detail: '没有补充分配隐藏或盲法' }
      // 读视图末尾只列出仍能定位到锚点的 open 评论
      if (view.includes(`评论 ${ctx.state.commentId} @`)) return { ok: true, detail: '' }
      // 指令允许整段替换：AI 声明移除锚点（ack_comments）并在线程里向医生说明，按设计属于正确处理
      const d = await ctx.c.api(`/api/docs/${ctx.docId}`)
      const thread = (d.comments as Array<{ id: string; replies: Array<{ role: string }> }>).find(x => x.id === ctx.state.commentId)
      return thread?.replies.some(r => r.role === 'ai')
        ? { ok: true, detail: '确认移除锚点并在线程说明' }
        : { ok: false, detail: '人类批注的锚点丢失，且未在线程说明' }
    },
  },
  {
    archetype: 'ambiguous_phrase',
    code: 'ambiguous_match',
    seeded: false,
    message: t => `把结果段里的「${t.comparator}组」统一改为「对照组」。`,
    async oracle(ctx) {
      const view = await read(ctx)
      const text = blockText(view, findBlock(ctx.before, '共纳入'))
      const left = text.split(`${ctx.topic.comparator}组`).length - 1
      const done = text.split('对照组').length - 1
      return left === 0 && done === 3
        ? { ok: true, detail: '' }
        : { ok: false, detail: `剩余「${ctx.topic.comparator}组」${left} 处，「对照组」${done} 处` }
    },
  },
  {
    archetype: 'table_cell',
    code: 'invalid_table',
    seeded: false,
    message: () => '在基线表「年龄」那一行下面加一行「BMI（kg/m²）」，两组分别为 27.1 ± 4.3 和 26.8 ± 4.5。',
    async oracle(ctx) {
      const view = await read(ctx)
      const age = view.indexOf('年龄（岁）')
      const bmi = view.indexOf('BMI')
      const row = view.slice(bmi, view.indexOf('\n', bmi))
      return bmi > age && age >= 0 && row.includes('27.1 ± 4.3') && row.includes('26.8 ± 4.5') && view.includes('男性（%）')
        ? { ok: true, detail: '' }
        : { ok: false, detail: '表格行未按要求插入' }
    },
  },
  {
    archetype: 'out_of_scope_revert',
    code: 'user_reverted_turn',
    seeded: false,
    message: () => '把讨论第二段润色一下，语气更学术。',
    async react(ctx, turnId) {
      // 确定性的用户反应：本回合改动了讨论第二段以外的块，就撤销整轮
      const target = findBlock(ctx.before, '该结果与既往')
      const before = topBlocks(ctx.before)
      const after = topBlocks(await read(ctx))
      const touched = [...before].filter(([id, text]) => id !== target && after.get(id) !== text).map(([id]) => id)
      ctx.state.outOfScope = touched
      if (touched.length === 0) return false
      await ctx.c.api(`/api/docs/${ctx.docId}/turns/${turnId}/revert`, { method: 'POST' })
      return true
    },
    async oracle(ctx) {
      const out = ctx.state.outOfScope as string[]
      return out.length === 0 ? { ok: true, detail: '' } : { ok: false, detail: `改动了范围外的块：${out.join(',')}` }
    },
  },
]

/** 回合里计为「守卫拦截」的错误码。 */
export const GUARD_CODES = new Set([
  'conflict_user_edited', 'citation_not_registered', 'pending_suggestion', 'anchor_has_open_comments',
  'ambiguous_match', 'text_not_found', 'node_not_editable', 'invalid_table', 'cell_not_found',
  'invalid_structure', 'invalid_base_rev', 'node_not_found',
])

/** 一套稿件：训练 / 留出主题、怎么新建稿件、怎么读、有哪些任务。 */
export interface Corpus<T> {
  name: string
  train: T[]
  heldout: T[]
  key(t: T): string
  /** 新建本任务用的稿件，返回文档 id。 */
  create(c: Client, t: T, title: string): Promise<string>
  /** 布置前后的读视图（长文档读全文）。 */
  read(c: Client, docId: string): Promise<string>
  tasks: Task<T>[]
}

/** 作者编写的短稿模板（第一版实验）。 */
export const SIMPLE: Corpus<Topic> = {
  name: 'simple',
  train: TRAIN_TOPICS,
  heldout: HELDOUT_TOPICS,
  key: t => t.key,
  create: async (c, t, title) => (await c.api('/api/docs', { method: 'POST', body: JSON.stringify({ title, markdown: manuscript(t) }) })).id,
  read: (c, docId) => c.api<string>(`/api/docs/${docId}/read`),
  tasks: TASKS,
}

