/**
 * 进行中的回合登记：MCP 写入按用户找到当前回合，打上 turn_id（撤销单元、版本快照、事件归属）。
 * 每个用户同一时间只有一个 dsh 回合（一个用户一个 dsh 进程）。
 */

import type { MemoryRow } from '../store/db.ts'

/** 确认卡（对话里显示，用户确认 / 拒绝）。 */
export interface ActionCard { id: string; tool: string; action: string; summary: string; reason: string | null; editable: Record<string, string> | null; status: string; created_at: string }

export type TurnNotice =
  | { type: 'comment_reply'; doc_id: string; comment_id: string }
  /** AI 提议了一条记忆（待确认）或按用户明确要求记下了一条：对话里显示卡片。 */
  | { type: 'memory'; result: 'proposed' | 'active' | 'forgotten'; memory: MemoryRow }
  /** AI 发起了需要用户确认的高风险操作：对话里显示确认卡。 */
  | { type: 'action'; action: ActionCard }
  /** Subagent 子专家协同过程通知。 */
  | { type: 'subagent_start'; id: string; role: string; role_label: string; task: string; doc_id?: string }
  | { type: 'subagent_step'; id: string; role: string; step: string; status?: 'ok' | 'warn' | 'info'; doc_id?: string }
  | { type: 'subagent_done'; id: string; role: string; summary: string; output?: unknown; doc_id?: string }

export interface ActiveTurn {
  turnId: string
  /** 回合所在文档（项目记忆按它找项目）。 */
  docId?: string
  /** 本回合能不能用记忆（实例开启、用户没暂停、本轮没关）。 */
  memory?: boolean
  /** 本回合写过的文档。 */
  touched: Set<string>
  notify: (n: TurnNotice) => void
  /** 本回合 AI 写入的方式：suggest = 一律作为待采纳修订（服务端强制，不依赖模型传参）。 */
  mode: 'apply' | 'suggest'
  /** 评论触发的回合：正在回答的评论线程。 */
  answering?: string | null
}

export class TurnRegistry {
  private readonly byUser = new Map<string, ActiveTurn>()
  private readonly byGen = new Map<string, ActiveTurn>()
  private readonly byDoc = new Map<string, ActiveTurn>()

  begin(userId: string, turn: ActiveTurn, generation?: string): void {
    this.byUser.set(userId, turn)
    if (generation) this.byGen.set(generation, turn)
    if (turn.docId) this.byDoc.set(`${userId}#${turn.docId}`, turn)
  }

  end(userId: string, turnId: string): void {
    if (this.byUser.get(userId)?.turnId === turnId) this.byUser.delete(userId)
    for (const [k, t] of this.byGen) {
      if (t.turnId === turnId) this.byGen.delete(k)
    }
    for (const [k, t] of this.byDoc) {
      if (t.turnId === turnId) this.byDoc.delete(k)
    }
  }

  active(userId: string, generation?: string, docId?: string): ActiveTurn | undefined {
    if (generation && this.byGen.has(generation)) return this.byGen.get(generation)
    if (docId && this.byDoc.has(`${userId}#${docId}`)) return this.byDoc.get(`${userId}#${docId}`)
    return this.byUser.get(userId)
  }

  touch(userId: string, docId: string, generation?: string): void {
    this.active(userId, generation, docId)?.touched.add(docId)
  }

  notify(userId: string, notice: TurnNotice, generation?: string): void {
    const docId = 'doc_id' in notice ? notice.doc_id : undefined
    this.active(userId, generation, docId)?.notify(notice)
  }
}
