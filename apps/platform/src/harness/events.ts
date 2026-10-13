import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'

/** 推给前端的精简事件（SSE data 字段）。 */
export type UiEvent =
  | { type: 'turn'; turn_id: string; message: string }
  /** 排队中（同一用户的上一回合还没结束）。 */
  | { type: 'queued'; position: number; message: string }
  | { type: 'turn_done'; turn_id: string; status: 'done' | 'error' | 'cancelled' | 'timeout'; docs: string[] }
  | { type: 'status'; status: 'running' | 'idle' }
  | { type: 'reasoning'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; callId: string; name: string; arguments: string }
  /** 工具结果；失败时带原因（message）与建议（hint），前端显示给用户。 */
  | { type: 'tool_result'; callId: string; isError: boolean; code?: string; message?: string; hint?: string }
  | { type: 'turn_end'; reason: string }
  /** 文档被本回合修改（实时，每次 doc_edit 提交一次）。 */
  | { type: 'doc_updated'; doc_id: string; rev: number; changes: number }
  /** 回合结束时落的版本。 */
  | { type: 'version'; doc_id: string; seq: number }
  | { type: 'comment_reply'; doc_id: string; comment_id: string }
  | { type: 'memory'; result: 'proposed' | 'active' | 'forgotten'; memory: import('../store/db.ts').MemoryRow }
  | { type: 'action'; action: import('../mcp/turns.ts').ActionCard }
  | { type: 'error'; message: string }
  | { type: 'done' }
  /** Subagent 子专家协同事件：开始、执行步、完成。 */
  | { type: 'subagent_start'; id: string; role: string; role_label: string; task: string }
  | { type: 'subagent_step'; id: string; role: string; step: string; status?: 'ok' | 'warn' | 'info' }
  | { type: 'subagent_done'; id: string; role: string; summary: string; output?: unknown }

interface Block { type: string; text?: string; id?: string; name?: string; arguments?: string }

/**
 * dsh 的 SDK 通知 → UiEvent。只看根会话；dsh 的 `session.event` 是已提交的会话日志事件，
 * 粒度是「每一步」而不是逐 token（SDK 协议没有 delta 流）。
 */
export function mapNotification(n: HarnessNotification, sessionId: string): UiEvent[] {
  if (n.params.sessionId !== sessionId) return []
  if (n.method === 'session.status') {
    const status = n.params.status
    return status === 'running' || status === 'idle' ? [{ type: 'status', status }] : []
  }
  if (n.method !== 'session.event') return []
  const event = n.params.event as { type?: string; data?: Record<string, unknown> } | undefined
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'assistant/message': {
      const message = data.message as { content?: Block[] } | undefined
      const out: UiEvent[] = []
      for (const b of message?.content ?? []) {
        if (b.type === 'reasoning' && b.text) out.push({ type: 'reasoning', text: b.text })
        else if (b.type === 'text' && b.text) out.push({ type: 'assistant', text: b.text })
        else if (b.type === 'tool-call') out.push({ type: 'tool_call', callId: b.id ?? '', name: b.name ?? '', arguments: b.arguments ?? '' })
      }
      return out
    }
    case 'tool/result': {
      const message = data.message as { toolCallId?: string; isError?: boolean; code?: string; error?: unknown; source?: { toolCallId?: string }; content?: unknown } | undefined
      const event: Extract<UiEvent, { type: 'tool_result' }> = {
        type: 'tool_result',
        callId: message?.toolCallId ?? message?.source?.toolCallId ?? '',
        isError: Boolean(message?.isError),
      }
      // MCP 工具的显式失败码（validation_error / unit_not_found …）——前端据此展示具体原因。
      if (typeof message?.code === 'string' && message.code) event.code = message.code
      if (event.isError) Object.assign(event, describeToolError(message?.content, message?.error ?? (data as { error?: unknown }).error))
      return [event]
    }
    case 'turn/end': {
      // reason 形如 { kind: 'completed' | 'error' | ..., error?: { message, code } }
      const reason = data.reason as { kind?: string; error?: { message?: string; code?: string } } | string | undefined
      const kind = typeof reason === 'string' ? reason : reason?.kind ?? 'unknown'
      const out: UiEvent[] = [{ type: 'turn_end', reason: kind }]
      if (typeof reason === 'object' && reason?.error) out.push({ type: 'error', message: describeError(reason.error) })
      return out
    }
    default:
      return []
  }
}

const ERROR_HINTS: Record<string, string> = {
  MISSING_CREDENTIAL: '服务端未配置 DEEPSEEK_API_KEY，请在 .env 中填写后重启 server。',
  INVALID_CREDENTIAL: 'DEEPSEEK_API_KEY 无效，请检查 .env。',
}

function describeError(e: { message?: string; code?: string }): string {
  return (e.code && ERROR_HINTS[e.code]) ?? e.message ?? e.code ?? 'AI 回合失败'
}

export function extractToolOutput(rec: unknown, isError = false): string {
  if (typeof rec === 'string') return rec
  if (Array.isArray(rec)) {
    const texts = rec.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).filter(Boolean)
    return texts.join('\n')
  }
  if (rec && typeof rec === 'object') {
    const obj = rec as { content?: unknown; text?: unknown; error?: unknown; isError?: boolean }
    const texts: string[] = []
    if (Array.isArray(obj.content)) {
      for (const c of obj.content) {
        if (c && typeof c === 'object' && 'text' in c && (c as { text: unknown }).text) {
          texts.push(String((c as { text: unknown }).text))
        }
      }
    } else if (typeof obj.content === 'string' && obj.content) {
      texts.push(obj.content)
    } else if (typeof obj.text === 'string' && obj.text) {
      texts.push(obj.text)
    }
    if (texts.length === 0 && (isError || obj.isError) && obj.error !== undefined && obj.error !== null) {
      if (typeof obj.error === 'string') texts.push(obj.error)
      else if (typeof obj.error === 'object' && 'message' in obj.error && typeof (obj.error as { message: unknown }).message === 'string') {
        texts.push((obj.error as { message: string }).message)
      }
    }
    return texts.join('\n')
  }
  return ''
}

/**
 * 工具失败的原因：平台 MCP 工具返回 `{code, message, hint}`（dsh 包成 "Error: {...}"）；
 * 参数校验失败等其他错误取第一行。给用户看的是 message，code / hint 放在悬停提示里。
 */
export function describeToolError(content: unknown, fallbackError?: unknown): { code?: string; message?: string; hint?: string } {
  let text = extractToolOutput(content, true)
  if (!text && fallbackError !== undefined && fallbackError !== null) {
    text = typeof fallbackError === 'string'
      ? fallbackError
      : typeof fallbackError === 'object' && 'message' in fallbackError && typeof (fallbackError as { message: unknown }).message === 'string'
      ? (fallbackError as { message: string }).message
      : ''
  }
  if (!text) return {}
  const body = text.replace(/^\s*Error:\s*/, '')
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown; hint?: unknown }
    if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string') {
      return {
        ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
        message: parsed.message.slice(0, 300),
        ...(typeof parsed.hint === 'string' ? { hint: parsed.hint.slice(0, 300) } : {}),
      }
    }
  } catch { /* 不是平台工具的 JSON 错误 */ }
  if (/invalid arguments|input validation/i.test(body)) return { code: 'validation_error', message: '参数格式不符合要求' }
  return { message: body.split('\n')[0]!.slice(0, 200) }
}
