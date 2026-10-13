import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Documents, CommitEvent } from '../model/runtime.ts'
import { mapNotification, type UiEvent } from '../harness/events.ts'
import { filterPhrReply, type PhrMember } from '../ops/phr-guard.ts'
import type { MemoryService } from '../memory/service.ts'
import type { Alerts } from '../ops-alert/alerts.ts'
import type { HarnessPool } from '../harness/pool.ts'
import type { TurnRegistry } from '../mcp/turns.ts'

/** 评论触发回合的提示（服务端组装，前端不拼自然语言）。幻灯片与文档用不同的读写工具。 */
export function commentPrompt(docId: string, commentId: string, kind: 'doc' | 'deck' = 'doc'): string {
  const edit = kind === 'deck'
    ? `2. 锚点 node_ids 是形状 id：用 doc_outline 找到它所在的页，slide_read 读这一页，用 deck_edit（replace_text 或 set_text，沿用原格式）完成修改，改完用 layout_check 检查是否溢出；\n`
    : `2. 按锚点所在块 id 用 doc_read 读取上下文，用 doc_edit 完成修改；\n`
  return (
    `请处理文档 ${docId} 中的评论 ${commentId}：\n` +
    `1. comments_list（doc_id="${docId}", comment_id="${commentId}"）读取锚点与要求；\n` +
    edit +
    `3. 用 comment_reply 说明改了什么、改在哪（线程留给用户确认后关闭）；确实无需改动时说明原因后 comment_resolve。\n` +
    `只处理这一条评论。`
  )
}

/** 评论 / 回复里召唤 AI 的触发词。 */
export const wantsAi = (text: string): boolean => /[@＠]heurion\b/i.test(text)

/**
 * 知家的回答口吻（给家人看，不是给医生看）：每一轮绑定健康档案 / 简报的对话都带上。
 * 简洁、清晰、不专业：先一句话说结论，再最多三点；术语换成大白话（实在要用就括号解释）；短句；不堆数字和文献。
 */
export const PHR_STYLE =
  '［回答口吻］用科普的口吻和普通家庭说话，不是写病历、也不是替医生下结论：\n' +
  '- 先一句大白话回答问题，再讲清「这个指标 / 情况是什么、一般有哪些常见原因、平时要注意什么、什么情况该去看医生」，最多 3–4 个要点，整段一般不超过 200 字；\n' +
  '- 讲常识可以用「一般来说」「常见原因有」；说到这位家人自己的情况，只说数值和变化（如「这次 168，比 3 月高」），判断留给医生；\n' +
  '- 不用专业术语和英文缩写，非用不可时括号里一句话解释；短句，不列长表格、不堆数字，不贴文献编号；\n' +
  '- 不推荐具体药物和剂量；生活上的注意事项（饮食、作息、喝水、复查）可以说；\n' +
  '- 需要就医时直接说「建议带上报告去看医生」，紧急情况说「请立即就医或打 120」；写进档案的内容同样用这种口吻。\n\n'

/** 就诊简报（知家，PATIENT.md §6）：服务端组装的生成指令。简报文档是回合的落点；红线守卫在操作层强制。 */
export function phrBriefPrompt(input: {
  patientId: string; code: string; sex: 'M' | 'F' | null; birth_year: number | null; tags: string[]
  archiveDocId?: string | null
}): string {
  const who = [input.sex === 'M' ? '男' : input.sex === 'F' ? '女' : '', input.birth_year ? `${input.birth_year} 年生` : '', ...input.tags].filter(Boolean).join('，')
  return (
    `请为家庭成员生成一份「就诊简报」，用 doc_edit 写进本文档（看病前给医生看的准备，不是病历）。\n` +
    `成员：${input.code}（${who || '基本信息待补'}）。patient_id=${input.patientId}。\n` +
    `步骤：\n` +
    `1. patient_read（patient_id）与 labs_query 看最近的化验与记录（重点近 3 个月与异常项）；` +
    (input.archiveDocId ? `doc_outline / doc_read 读健康档案文档 ${input.archiveDocId}，了解背景与医生交代；\n` : `\n`) +
    `2. 用 doc_edit 写三节：\n` +
    `「近况」——最近的数值与变化：照抄数值与单位、注明日期，用记录口径（「检查见…」），不写诊断结论；\n` +
    `「想请医生看的问题」——2–4 个具体、家人真正关心的问题；\n` +
    `「要带的材料」——原始报告、正在用的药物清单、既往小结。\n` +
    `3. 红线：不下诊断；不提用药、剂量或停换药建议；异常数值处写「建议当面咨询医生」；只记录与提问。\n` +
    `4. 口吻：家人和医生都要一眼看懂——短句、大白话，术语加括号解释；整份不超过 400 字，「近况」只列和问题有关的几项。\n` +
    `写完用一两句话总结。`
  )
}

export interface TurnBusEvent { userId: string; docId: string; event: UiEvent }

export interface TurnOptions {
  /** AI 的写入一律作为待采纳修订。 */
  suggest?: boolean
  /** 评论触发的回合：正在回答的评论线程。 */
  commentId?: string
  /** false = 本轮不用记忆（不注入、memory_* 工具不可用、不产生提议）。 */
  memory?: boolean
  /** 通道：copilot 走全局随航快车道，doc 走文档编辑通道（默认 doc）。 */
  lane?: 'copilot' | 'doc'
  /** Co-Pilot 等随航通道关联的当前打开文档 ID。 */
  contextDocId?: string
}

interface Job {
  id: string
  docId: string
  message: string
  opts: TurnOptions
  enqueuedAt: string
  emit: (e: UiEvent) => void
  done: () => void
}

export interface ActiveSubagentSnapshot {
  id: string
  role: string
  role_label: string
  task: string
  steps: Array<{ step: string; status?: 'ok' | 'warn' | 'info' }>
}

interface Running {
  job: Job
  turnId: string | null
  startedAt: string
  slot: string
  lastStep?: string
  subagent?: ActiveSubagentSnapshot | null
  /** 让正在等待的 dsh 调用立即失败（进程卡住、close 不返回时也能放行队列）。 */
  abort: (reason: Error) => void
}

/** 队列视图（页面的「任务队列」）。 */
export interface QueueItem {
  id: string
  doc_id: string
  doc_title: string
  label: string
  suggest: boolean
  /** running：开始时间；queued：入队时间。 */
  since: string
  turn_id?: string | null
}

export interface QueueView {
  running: QueueItem | null
  active?: QueueItem[]
  queued: QueueItem[]
}

/**
 * 一轮 AI 编辑（PLATFORM.md §6.5）：登记回合 → dsh 执行（经 MCP 读写文档，改动实时提交）
 * → 回合结束为本回合改过的每份文档打一个版本快照。守卫已在每次写入前执行，没有落版前审计 / 丢弃。
 *
 * 双轨制任务调度：
 * 1. Co-Pilot 独立快车道：opts.lane === 'copilot'，走专属 slot（'copilot'），不阻塞文档任务，也不被文档排队阻塞。
 * 2. 文档并发进程池：按 (userId, docId) 隔离，同一文档保证严格串行（防自身版本冲突），不同文档之间池化并行（默认最多 2 个并发）。
 */
export class TurnService {
  readonly events = new EventEmitter<{ event: [TurnBusEvent] }>()
  private readonly cancelling = new Set<string>()
  private readonly timedOut = new Set<string>()
  private readonly idleTimeoutMs: number
  private readonly maxDocConcurrency: number
  private readonly memory: MemoryService | null
  private readonly alerts: Alerts | null
  /** 知家红线（PATIENT.md §3）：返回 undefined = 不是知家文档（不检查）；null = 是知家文档但没有特殊标记；对象 = 有孕产 / 哺乳 / 儿童标记。 */
  private readonly phrGuard: ((docId: string) => PhrMember | null | undefined) | null
  private readonly queues = new Map<string, Job[]>()
  /** 各用户正在执行的文档任务：userId -> (docId -> Running) */
  private readonly running = new Map<string, Map<string, Running>>()
  /** 各用户正在执行的 Co-Pilot 随航任务：userId -> Running */
  private readonly copilotRunning = new Map<string, Running>()

  constructor(
    private readonly docs: Documents,
    private readonly pool: HarnessPool,
    private readonly registry: TurnRegistry,
    opts: {
      idleTimeoutMs?: number
      memory?: MemoryService
      alerts?: Alerts
      phrGuard?: (docId: string) => PhrMember | null | undefined
      maxDocConcurrency?: number
    } = {},
  ) {
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000
    this.maxDocConcurrency = opts.maxDocConcurrency ?? 2
    this.memory = opts.memory ?? null
    this.alerts = opts.alerts ?? null
    this.phrGuard = opts.phrGuard ?? null
    this.events.setMaxListeners(0)
  }

  /** 服务启动时恢复：上次没跑完的回合标为中断，排队中的任务重新入队。 */
  restore(): { interrupted: number; requeued: number } {
    const store = this.docs.store
    let interrupted = typeof store.interruptRunningTurns === 'function' ? store.interruptRunningTurns() : 0
    const extra = (store as unknown as { db?: { prepare: (sql: string) => { run: () => { changes?: number } } } }).db
      ?.prepare("UPDATE turns SET status = 'interrupted', ended_at = datetime('now') WHERE status = 'running'")
      .run()
    interrupted += Number(extra?.changes ?? 0)
    const rows = store.listQueuedJobs()
    for (const row of rows) {
      let opts: TurnOptions = {}
      try { opts = JSON.parse(row.opts) as TurnOptions } catch { /* 用默认 */ }
      this.push(row.user_id, { id: row.id, docId: row.doc_id, message: row.message, opts, enqueuedAt: row.enqueued_at }, () => {}, () => {}, false)
    }
    for (const userId of new Set(rows.map(r => r.user_id))) void this.drain(userId)
    return { interrupted, requeued: rows.length }
  }

  recoverTurns(): { interrupted: number; requeued: number } {
    return this.restore()
  }

  /** 指定文档是否正在执行；不传 docId 时表示该用户是否有任意文档任务在执行。 */
  isBusy(userId: string, docId?: string): boolean {
    if (docId) {
      return this.running.get(userId)?.has(docId) ?? false
    }
    return (this.running.get(userId)?.size ?? 0) > 0
  }

  /** 获取指定文档当前正在执行的实时回合快照（供前端切回文档或重连时恢复进度与子代理卡片）。 */
  activeTurn(userId: string, docId: string): {
    turn_id: string | null
    message: string
    started_at: string
    last_step?: string
    subagent?: ActiveSubagentSnapshot | null
  } | null {
    const r = this.running.get(userId)?.get(docId)
    if (!r) return null
    return {
      turn_id: r.turnId,
      message: r.job.message,
      started_at: r.startedAt,
      ...(r.lastStep ? { last_step: r.lastStep } : {}),
      ...(r.subagent ? { subagent: r.subagent } : {}),
    }
  }

  /** 全局 Co-Pilot 随航通道是否正忙。 */
  isCopilotBusy(userId: string): boolean {
    return this.copilotRunning.has(userId)
  }

  queued(userId: string): number {
    return this.queues.get(userId)?.length ?? 0
  }

  /** 当前用户正在排队中的文档 ID 列表。 */
  queueIds(userId: string): string[] {
    return (this.queues.get(userId) ?? []).map(j => j.docId)
  }

  /** 当前用户的队列：正在执行的所有文档任务 + 排队中的（按执行顺序）。 */
  view(userId: string): QueueView {
    const item = (job: Job, since: string, turnId?: string | null): QueueItem => ({
      id: job.id,
      doc_id: job.docId,
      doc_title: this.docs.store.getDoc(job.docId)?.title ?? '（已删除的文档）',
      label: this.label(job),
      suggest: !!job.opts.suggest,
      since,
      ...(turnId !== undefined ? { turn_id: turnId } : {}),
    })
    const runningList = [...(this.running.get(userId)?.values() ?? [])]
    const active = runningList.map(r => item(r.job, r.startedAt, r.turnId))
    return {
      running: active[0] ?? null,
      active,
      queued: (this.queues.get(userId) ?? []).map(j => item(j, j.enqueuedAt)),
    }
  }

  /** 排队执行一轮；返回的 Promise 在该回合结束时完成。emit 收到本回合的全部事件。 */
  submit(userId: string, docId: string, message: string, emit: (e: UiEvent) => void = () => {}, opts: TurnOptions = {}): Promise<void> {
    const target = this.docs.store.getDoc(docId)
    if (!target || target.deleted_at) return Promise.reject(new Error(`doc ${docId} not found`))
    if (opts.lane === 'copilot') {
      return this.submitCopilot(userId, docId, message, emit, opts)
    }
    return new Promise(resolve => {
      const job = { id: 'q' + randomUUID().replace(/-/g, '').slice(0, 11), docId, message, opts, enqueuedAt: new Date().toISOString() }
      this.push(userId, job, emit, resolve, true)
      void this.drain(userId)
    })
  }

  /** Co-Pilot 专用独立随航通道：不入排队队列，直接走 copilot slot 快速执行。 */
  private async submitCopilot(userId: string, docId: string, message: string, emit: (e: UiEvent) => void, opts: TurnOptions): Promise<void> {
    const publish = (e: UiEvent) => {
      emit(e)
      this.events.emit('event', { userId, docId, event: e })
    }
    // 若该用户当前有正在跑的上一条随航提问，优雅中断上一轮，接入新一轮
    const prev = this.copilotRunning.get(userId)
    if (prev) {
      await this.stopJob(userId, prev).catch(() => {})
    }

    let abort: (reason: Error) => void = () => {}
    const aborted = new Promise<never>((_, reject) => { abort = reject })
    aborted.catch(() => {})

    const job: Job = {
      id: 'cp' + randomUUID().replace(/-/g, '').slice(0, 10),
      docId,
      message,
      opts,
      enqueuedAt: new Date().toISOString(),
      emit: publish,
      done: () => {},
    }
    const r: Running = { job, turnId: null, startedAt: new Date().toISOString(), slot: 'copilot', abort }
    this.copilotRunning.set(userId, r)

    try {
      await this.execute(userId, job, r, aborted, 'copilot')
    } catch (err) {
      job.emit({ type: 'error', message: String((err as Error).message ?? err) })
    } finally {
      if (this.copilotRunning.get(userId) === r) {
        this.copilotRunning.delete(userId)
      }
      job.emit({ type: 'done' })
    }
  }

  private push(userId: string, base: Omit<Job, 'emit' | 'done'>, emit: (e: UiEvent) => void, done: () => void, persist: boolean): void {
    const publish = (e: UiEvent) => {
      emit(e)
      this.events.emit('event', { userId, docId: base.docId, event: e })
    }
    const q = this.queues.get(userId) ?? []
    const job: Job = { ...base, emit: publish, done }
    q.push(job)
    this.queues.set(userId, q)
    if (persist) {
      this.docs.store.enqueueJob({ id: job.id, user_id: userId, doc_id: job.docId, message: job.message, opts: JSON.stringify(job.opts), enqueued_at: job.enqueuedAt })
    }
    const runningMap = this.running.get(userId)
    const isDocRunning = runningMap?.has(base.docId) ?? false
    const isFull = (runningMap?.size ?? 0) >= this.maxDocConcurrency
    if (isDocRunning || isFull) {
      publish({ type: 'queued', position: q.length, message: job.message })
    }
  }

  private async drain(userId: string): Promise<void> {
    const q = this.queues.get(userId)
    if (!q || q.length === 0) {
      this.queues.delete(userId)
      return
    }

    const existingRunning = this.running.get(userId)
    if (existingRunning && existingRunning.size >= this.maxDocConcurrency) return

    // 寻找队列中第一个「目标文档当前未在执行」的任务（保证同一文档严格串行安全）
    const jobIndex = q.findIndex(j => !existingRunning?.has(j.docId))
    if (jobIndex === -1) return

    const [job] = q.splice(jobIndex, 1)
    if (q.length === 0) this.queues.delete(userId)
    if (!job) return
    this.docs.store.dequeueJob(job.id)

    // 排队期间文档被删了 / 进了回收站：跳过
    const target = this.docs.store.getDoc(job.docId)
    if (!target || target.deleted_at) {
      job.done()
      void this.drain(userId)
      return
    }

    let runningMap = this.running.get(userId)
    if (!runningMap) {
      runningMap = new Map<string, Running>()
      this.running.set(userId, runningMap)
    }

    // 分配可用的 slot（doc_0, doc_1 ...）
    const usedSlots = new Set([...runningMap.values()].map(r => r.slot))
    let slot = 'doc_0'
    for (let i = 0; i < this.maxDocConcurrency; i++) {
      const candidate = `doc_${i}`
      if (!usedSlots.has(candidate)) { slot = candidate; break }
    }

    let abort: (reason: Error) => void = () => {}
    const aborted = new Promise<never>((_, reject) => { abort = reject })
    aborted.catch(() => {})
    const r: Running = { job, turnId: null, startedAt: new Date().toISOString(), slot, abort }
    runningMap.set(job.docId, r)

    void (async () => {
      try {
        await this.execute(userId, job, r, aborted, slot)
      } catch (err) {
        job.emit({ type: 'error', message: String((err as Error).message ?? err) })
      } finally {
        const curMap = this.running.get(userId)
        if (curMap?.get(job.docId) === r) {
          curMap.delete(job.docId)
        }
        if (curMap && curMap.size === 0) {
          this.running.delete(userId)
        }
        job.emit({ type: 'done' })
        job.done()
        void this.drain(userId)
      }
    })()

    // 若仍有富余并发配额且队列有可用任务，继续调度
    if (runningMap.size < this.maxDocConcurrency && (this.queues.get(userId)?.length ?? 0) > 0) {
      void this.drain(userId)
    }
  }

  private label(job: Job): string {
    const m = /^请处理文档 \S+ 中的评论 (\S+)：/.exec(job.message)
    if (m) {
      const c = this.docs.store.getComment(job.docId, m[1]!)
      const ask = c?.replies.filter(r => r.role === 'user').at(-1)?.text ?? ''
      return `处理评论：${ask.replace(/[@＠]heurion\b/gi, '').trim() || m[1]}`
    }
    if (/^请核对文档 \S+ 中带引用的论断/.test(job.message)) return '核对全部论断'
    return job.message
  }

  private async execute(userId: string, job: Job, r: Running, aborted: Promise<never>, slot = 'default'): Promise<void> {
    const { docId, message, emit, opts } = job
    const store = this.docs.store
    const doc = store.getDoc(docId)
    if (!doc) throw new Error(`doc ${docId} not found`)
    this.docs.pin(docId)

    let turn: { id: string } | null = null
    let watchdog: ReturnType<typeof setInterval> | null = null
    let onCommit: ((e: CommitEvent) => void) | null = null
    const touched = new Set<string>()
    let status: 'done' | 'error' | 'cancelled' | 'timeout' = 'done'
    let failure: string | null = null
    let modelError: string | null = null

    try {
      turn = store.createTurn({ user_id: userId, doc_id: docId, message, opts: JSON.stringify(opts) })
      r.turnId = turn.id
      const turnId = turn.id
      const memoryOn = opts.memory !== false && !!this.memory?.active(userId)
      const emitWithState = (e: UiEvent) => {
        if (e.type === 'tool_call') r.lastStep = e.name
        else if (e.type === 'subagent_start') {
          r.subagent = { id: e.id, role: e.role, role_label: e.role_label, task: e.task, steps: [] }
          r.lastStep = `正在委派：${e.role_label}`
        } else if (e.type === 'subagent_step' && r.subagent && r.subagent.id === e.id) {
          r.subagent.steps.push({ step: e.step, status: e.status })
          r.lastStep = `[${r.subagent.role_label}] ${e.step}`
        } else if (e.type === 'subagent_done' && r.subagent && r.subagent.id === e.id) {
          r.subagent = null
          r.lastStep = `${e.role} 协同完成`
        }
        emit(e)
      }
      const activeTurnObj = {
        turnId,
        docId,
        ...(opts.contextDocId ? { contextDocId: opts.contextDocId } : {}),
        touched,
        notify: (n: UiEvent) => emitWithState(n),
        mode: (opts.suggest ? 'suggest' : 'apply') as 'apply' | 'suggest',
        answering: opts.commentId ?? null,
        memory: memoryOn,
      }
      const gen = this.pool.generation?.(userId, slot)
      this.registry.begin(userId, activeTurnObj, gen)
      // 无响应超时：dsh 的任何通知（模型输出、工具调用 / 结果）或本回合的提交都算动静
      let lastActivity = Date.now()
      watchdog = setInterval(() => {
        if (Date.now() - lastActivity < this.idleTimeoutMs) return
        if (watchdog) clearInterval(watchdog)
        this.timedOut.add(job.id)
        void this.stopJob(userId, r)
      }, Math.min(30_000, Math.max(5, this.idleTimeoutMs / 4)))
      onCommit = (e: CommitEvent) => {
        if (e.turnId !== turnId) return
        lastActivity = Date.now()
        touched.add(e.docId)
        emitWithState({ type: 'doc_updated', doc_id: e.docId, rev: e.rev, changes: e.changes.length })
      }
      this.docs.on('commit', onCommit)
      emitWithState({ type: 'turn', turn_id: turnId, message })

      const history = this.pool.liveSession(userId, slot) === null ? this.recentHistory(docId) : ''
      store.addMessage(docId, 'user', message, turnId)
      const suggestNote = opts.suggest ? '本轮的修改会作为待用户采纳的修订提交。' : ''
      const memoryBlock = memoryOn ? await this.memory!.forPrompt(userId, docId, message) : ''
      const memoryNote = memoryOn ? '' : opts.memory === false ? '（用户本轮关闭了记忆：不要使用 memory_* 工具，也不要沿用之前回合提到的记忆。）' : ''
      // 记忆紧挨着本轮消息（放在最前面时模型容易照抄消息里的写法而忽略偏好）
      // 知家红线只看文档归属，整个回合算一次；知家的对话另加家人向的回答口吻
      const phr = this.phrGuard?.(docId)
      const styleNote = phr !== undefined ? PHR_STYLE : ''
      const prompt = `${history}（当前文档：doc_id=${docId}，《${doc.title}》，rev=${this.docs.rev(docId)}）${suggestNote}${memoryNote}\n\n${memoryBlock}${styleNote}${message}`

      if (this.cancelling.has(job.id) || this.timedOut.has(job.id)) throw new Error('cancelled')

      // 若 memory.forPrompt 期间进程池槽位被回收重建，重新同步最新 generation
      const runGen = this.pool.generation?.(userId, slot)
      if (runGen && runGen !== gen) {
        this.registry.begin(userId, activeTurnObj, runGen)
      }

      const result = await Promise.race([
        this.pool.run(userId, prompt, (n, sessionId) => {
          lastActivity = Date.now()
          for (const e of mapNotification(n, sessionId)) {
            // 模型调用失败（认证失败、限流、服务出错等）：dsh 正常结束回合但带错误，按失败记，不算「已完成」
            if (e.type === 'error') modelError = e.message
            // 知家红线：对话回复在展示前过守卫，违规换成安全提示（不把诊疗判断显示给家人）
            else if (e.type === 'assistant' && phr !== undefined) {
              // 知家红线（对话比档案宽松）：只去掉越线的句子、补提醒；只记触发的规则，不记内容
              const f = filterPhrReply(e.text, phr)
              if (f.codes.length) console.warn(`[知家红线] 回复已过滤：${f.codes.join('、')}（doc ${docId}）`)
              emitWithState({ type: 'assistant', text: f.text })
              continue
            }
            emitWithState(e)
          }
        }, slot),
        aborted,
      ])
      // 落库的历史同样过守卫：违规回复不进消息记录
      if (result.finalResponse) {
        store.addMessage(docId, 'assistant', phr !== undefined ? filterPhrReply(result.finalResponse, phr).text : result.finalResponse, turnId)
      }
      if (modelError) { status = 'error'; failure = modelError }
    } catch (err) {
      status = this.timedOut.has(job.id) ? 'timeout' : this.cancelling.has(job.id) ? 'cancelled' : 'error'
      const kept = '已提交的修改保留，可撤销本轮或按版本回滚。'
      failure = status === 'timeout'
        ? `模型服务 ${Math.round(this.idleTimeoutMs / 60_000) || '<1'} 分钟无响应，已自动停止`
        : status === 'cancelled' ? '已取消' : String((err as Error).message ?? err)
      emit({
        type: 'error',
        message: status === 'timeout'
          ? `模型服务 ${Math.round(this.idleTimeoutMs / 60_000) || '<1'} 分钟无响应，已自动停止；${kept}`
          : status === 'cancelled' ? `已取消；${kept}` : String((err as Error).message ?? err),
      })
    } finally {
      if (watchdog) clearInterval(watchdog)
      if (onCommit) this.docs.off('commit', onCommit)
      if (turn) {
        this.registry.end(userId, turn.id)
        for (const id of touched) {
          const v = this.docs.snapshot(id, 'turn', message.slice(0, 80), turn.id)
          if (v) emit({ type: 'version', doc_id: id, seq: v.seq })
        }
        store.endTurn(turn.id, status, failure)
        // 取消不算故障；出错、超时交给运维告警（模型认证 / 余额问题立即发，其余短时间内多次才发）
        if ((status === 'error' || status === 'timeout') && failure) this.alerts?.turnFailed(failure)
        emit({ type: 'turn_done', turn_id: turn.id, status, docs: [...touched] })
      }
      this.cancelling.delete(job.id)
      this.timedOut.delete(job.id)
      this.docs.unpin(docId)
    }
  }

  /** 取消当前用户的全部任务并清空排队。 */
  async cancel(userId: string): Promise<void> {
    const queuedJobs = this.queues.get(userId) ?? []
    this.queues.delete(userId)
    for (const job of queuedJobs) this.drop(job)

    const runningMap = this.running.get(userId)
    if (runningMap) {
      const runningSnapshot = [...runningMap.values()]
      for (const r of runningSnapshot) {
        await this.stopJob(userId, r).catch(() => {})
        if (runningMap.get(r.job.docId) === r) {
          runningMap.delete(r.job.docId)
        }
      }
      if (runningMap.size === 0 && this.running.get(userId) === runningMap) {
        this.running.delete(userId)
      }
    }
    const cp = this.copilotRunning.get(userId)
    if (cp) {
      await this.stopJob(userId, cp).catch(() => {})
      if (this.copilotRunning.get(userId) === cp) {
        this.copilotRunning.delete(userId)
      }
    }
  }

  /**
   * 取消一个任务：排队中的直接移出；正在执行的只停止它（结束其 slot 进程，下一次任务重新拉起），
   * 排在后面的任务照常执行。返回 false 表示找不到（已经执行完）。
   */
  async cancelJob(userId: string, jobId: string): Promise<boolean> {
    const q = this.queues.get(userId)
    if (q) {
      const i = q.findIndex(j => j.id === jobId)
      if (i >= 0) {
        const [job] = q.splice(i, 1)
        if (q.length === 0) this.queues.delete(userId)
        this.drop(job!)
        return true
      }
    }
    const runningMap = this.running.get(userId)
    if (runningMap) {
      for (const r of runningMap.values()) {
        if (r.job.id === jobId) {
          await this.stopJob(userId, r)
          return true
        }
      }
    }
    const cp = this.copilotRunning.get(userId)
    if (cp && cp.job.id === jobId) {
      await this.stopJob(userId, cp)
      return true
    }
    return false
  }

  private drop(job: Job): void {
    this.docs.store.dequeueJob(job.id)
    job.emit({ type: 'error', message: '已取消（排队中）' })
    job.emit({ type: 'done' })
    job.done()
  }

  private async stopJob(userId: string, r: Running): Promise<void> {
    this.cancelling.add(r.job.id)
    // 先同步移除旧 slot entry 并放行队列，再等待进程关闭：避免阻塞或误杀新拉起的回合
    const cancelTask = this.pool.cancel(userId, r.slot).catch(() => {})
    r.abort(new Error('cancelled'))
    await cancelTask
  }

  /** 新会话首轮带上最近 6 条对话。 */
  private recentHistory(docId: string): string {
    const msgs = this.docs.store.listMessages(docId).slice(-6)
    if (msgs.length === 0) return ''
    return `（此前的对话，供参考）\n${msgs.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.text.slice(0, 500)}`).join('\n')}\n\n`
  }
}
