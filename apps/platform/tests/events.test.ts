import { describe, expect, it } from 'vitest'
import { addUsage, describeToolError, emptyUsage } from '../src/harness/events.ts'

describe('工具失败的原因（对话里显示给用户）', () => {
  it('平台 MCP 工具的 {code, message, hint}（dsh 包成 Error: …）', () => {
    const content = [{ type: 'text', text: 'Error: {\n  "code": "render_unavailable",\n  "message": "幻灯片渲染不可用：需要 LibreOffice",\n  "hint": "改用 layout_check 检查版面。"\n}' }]
    expect(describeToolError(content)).toEqual({ code: 'render_unavailable', message: '幻灯片渲染不可用：需要 LibreOffice', hint: '改用 layout_check 检查版面。' })
  })
  it('参数校验失败给出人话；其他错误取第一行；没有内容时为空', () => {
    expect(describeToolError([{ type: 'text', text: 'MCP error -32602: Input validation error: Invalid arguments for tool deck_edit: [...]' }])).toEqual({ code: 'validation_error', message: '参数格式不符合要求' })
    expect(describeToolError('Error: ENOENT no such file\n    at …')).toEqual({ message: 'ENOENT no such file' })
    expect(describeToolError(undefined)).toEqual({})
  })
})

describe('回合的模型用量', () => {
  const msg = (sessionId: string, usage?: object) => ({ method: 'session.event', params: { sessionId, event: { type: 'assistant/message', data: { usage } } } }) as never
  it('合计每一步的用量，子代理会话同样计入；没有用量的步骤与其他事件不计', () => {
    const acc = emptyUsage()
    addUsage(acc, msg('root', { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800 }))
    addUsage(acc, msg('root', { inputTokens: 1200, outputTokens: 30 }))
    addUsage(acc, msg('sub', { inputTokens: 300, outputTokens: 20 }))
    addUsage(acc, msg('root'))
    addUsage(acc, { method: 'session.status', params: { sessionId: 'root', status: 'idle' } } as never)
    expect({ ...acc, ids: undefined }).toEqual({ input: 2500, output: 100, cache_read: 800, steps: 3, sessions: 2, ids: undefined })
  })
})
