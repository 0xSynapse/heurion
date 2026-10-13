export interface CopilotHooks {
  token: () => string
  activeDoc: () => { id: string; title: string } | null
}

const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c] ?? c)

function formatMarkdown(text: string): string {
  let html = esc(text)
  // 代码块
  html = html.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code class="lang-${lang}">${code}</code></pre>`)
  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  // 加粗
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  // 引用标记 [@c:xxx]
  html = html.replace(/\[@c:([a-z0-9]+)\]/g, '<span class="pill green" style="font-size:10.5px;padding:0 4px;">引用 $1</span>')
  // 换行
  html = html.replace(/\n/g, '<br>')
  return html
}

export function initCopilot(hooks: CopilotHooks) {
  const toggleBtn = document.getElementById('btnCopilotToggle')
  const drawer = document.getElementById('copilotDrawer')
  const badge = document.getElementById('copilotContextBadge')
  const msgs = document.getElementById('copilotMessages')
  const chipsContainer = document.getElementById('copilotQuickChips')
  const input = document.getElementById('copilotInput') as HTMLTextAreaElement | null
  const sendBtn = document.getElementById('copilotSendBtn')
  const clearBtn = document.getElementById('copilotClearBtn')
  const closeBtn = document.getElementById('copilotCloseBtn')

  if (!toggleBtn || !drawer || !msgs || !input) return

  let isOpen = false
  let isStreaming = false
  let abortController: AbortController | null = null
  let historyLoaded = false

  function detectContext(): { space: string; study_id?: string; patient_id?: string; doc_id?: string; title?: string } {
    const hash = window.location.hash || ''
    const doc = hooks.activeDoc()

    if (doc?.id) {
      return { space: '医学写作与工作台', doc_id: doc.id, title: doc.title }
    }
    if (hash.startsWith('#/study/')) {
      const parts = hash.split('/')
      return { space: '临床研究项目', study_id: parts[2] }
    }
    if (hash.startsWith('#/patients') || hash.startsWith('#/p/')) {
      const parts = hash.split('/')
      return { space: '患者中心与影像工作站', patient_id: parts[2] || undefined }
    }
    if (hash.startsWith('#/datasets')) {
      return { space: '数据集管理' }
    }
    if (hash.startsWith('#/library')) {
      return { space: '文献知识库' }
    }
    if (hash.startsWith('#/settings') || hash.startsWith('#/org')) {
      return { space: '机构设置' }
    }
    return { space: '全平台随航' }
  }

  function renderChips() {
    if (!chipsContainer) return
    const ctx = detectContext()
    let chips: string[] = []

    if (ctx.study_id) {
      chips = [
        '拟定临床研究入排标准',
        '设计 Table 1 基线三线表',
        '倾向性评分匹配 (PSM) 方案设计',
        '检索最新相关顶刊 RCT 文献',
      ]
    } else if (ctx.patient_id || ctx.space.includes('患者')) {
      chips = [
        'RECIST 1.1 靶病灶评价规则',
        '解读化验指标异常与临床意义',
        '起草 MDT 疑难病例讨论小结',
        '评估药物相关不良反应 (AE)',
      ]
    } else if (ctx.doc_id) {
      chips = [
        '润色段落并强化医学论据',
        '在正文中补充纳入与排除标准',
        '检索 PubMed 证据支撑当前假说',
        '核查全文所有数值论断',
      ]
    } else if (ctx.space.includes('数据')) {
      chips = [
        '变量缺失值分析与多重插补',
        '单因素与多因素 Cox 回归统计建议',
        '如何生成符合期刊要求的基线宽表？',
      ]
    } else {
      chips = [
        '起草前言引言 (Introduction) 段落',
        '统计分析计划 (SAP) 编写要点',
        '检索 Lancet 最新临床试验',
        '解读 RECIST 1.1 与 3D 容积反应',
      ]
    }

    chipsContainer.innerHTML = chips
      .map(c => `<button class="copilot-chip" data-chip="${esc(c)}">${esc(c)}</button>`)
      .join('')
  }

  function updateContextBadge() {
    if (!badge) return
    const ctx = detectContext()
    badge.textContent = `${ctx.space}${ctx.title ? ` · 《${ctx.title.slice(0, 10)}》` : ''}`
  }

  async function loadHistory() {
    if (historyLoaded) return
    try {
      const res = await fetch('/api/copilot/status', {
        headers: { Authorization: `Bearer ${hooks.token()}` },
      })
      if (!res.ok) return
      const data = await res.json() as {
        messages?: Array<{ id: string; role: 'user' | 'assistant'; text: string }>
        turns?: Array<{ id: string; user_message: string; status: string }>
      }
      if (data.messages && data.messages.length > 0) {
        msgs!.innerHTML = ''
        for (const m of data.messages) {
          if (m.role === 'user') {
            appendUserMsg(m.text)
          } else {
            appendAssistantMsg(m.text)
          }
        }
      } else if (data.turns && data.turns.length > 0) {
        msgs!.innerHTML = ''
        for (const t of data.turns) {
          appendUserMsg(t.user_message)
          if (t.status === 'error') {
            appendAssistantMsg('（该轮执行遇到异常，可重新提问）')
          }
        }
      }
      historyLoaded = true
    } catch {}
  }

  function openCopilot() {
    isOpen = true
    drawer?.classList.remove('hidden')
    updateContextBadge()
    renderChips()
    void loadHistory()
    setTimeout(() => input?.focus(), 150)
  }

  function closeCopilot() {
    isOpen = false
    drawer?.classList.add('hidden')
  }

  function toggleCopilot() {
    if (isOpen) closeCopilot()
    else openCopilot()
  }

  function appendUserMsg(text: string): HTMLElement {
    const div = document.createElement('div')
    div.className = 'copilot-msg user'
    div.innerHTML = esc(text).replace(/\n/g, '<br>')
    msgs?.appendChild(div)
    msgs!.scrollTop = msgs!.scrollHeight
    return div
  }

  function appendAssistantMsg(initialText = ''): { container: HTMLElement; textEl: HTMLElement; toolEl: HTMLElement } {
    const container = document.createElement('div')
    container.className = 'copilot-msg assistant'

    const toolEl = document.createElement('div')
    toolEl.className = 'copilot-msg-tool'
    toolEl.style.display = 'none'

    const textEl = document.createElement('div')
    textEl.className = 'copilot-msg-text'
    textEl.innerHTML = formatMarkdown(initialText)

    container.appendChild(toolEl)
    container.appendChild(textEl)
    msgs?.appendChild(container)
    msgs!.scrollTop = msgs!.scrollHeight
    return { container, textEl, toolEl }
  }

  async function sendMessage(overrideText?: string) {
    const text = (overrideText ?? input?.value ?? '').trim()
    if (!text || isStreaming) return
    if (!overrideText && input) input.value = ''

    appendUserMsg(text)
    const assistant = appendAssistantMsg('思考中...')
    isStreaming = true
    abortController = new AbortController()

    let accumulatedText = ''
    const ctx = detectContext()

    try {
      const res = await fetch('/api/copilot/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${hooks.token()}`,
        },
        body: JSON.stringify({
          message: text,
          space: ctx.space,
          study_id: ctx.study_id,
          patient_id: ctx.patient_id,
          doc_id: ctx.doc_id,
          title: ctx.title,
        }),
        signal: abortController.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        assistant.textEl.innerHTML = `<span style="color:var(--danger);">请求失败: ${esc(err.error || '服务器繁忙')}</span>`
        isStreaming = false
        return
      }

      if (!res.body) {
        assistant.textEl.textContent = '完成。'
        isStreaming = false
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const dataStr = trimmed.slice(5).trim()
          if (!dataStr) continue
          try {
            const ev = JSON.parse(dataStr) as { type: string; [k: string]: any }
            if (ev.type === 'assistant' && typeof ev.text === 'string') {
              accumulatedText = ev.text
              assistant.textEl.innerHTML = formatMarkdown(accumulatedText)
              msgs!.scrollTop = msgs!.scrollHeight
            } else if (ev.type === 'tool_call') {
              assistant.toolEl.style.display = 'inline-flex'
              assistant.toolEl.textContent = `正在调用: ${ev.name}...`
            } else if (ev.type === 'tool_result') {
              assistant.toolEl.textContent = `工具执行完毕`
            } else if (ev.type === 'error') {
              assistant.textEl.innerHTML = `<span style="color:var(--danger);">${esc(ev.message || '发生错误')}</span>`
            } else if (ev.type === 'done') {
              if (!accumulatedText) assistant.textEl.textContent = '已处理完毕。'
              assistant.toolEl.style.display = 'none'
            }
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        assistant.textEl.innerHTML = `<span style="color:var(--danger);">网络或连接异常: ${esc(err.message)}</span>`
      }
    } finally {
      isStreaming = false
      abortController = null
    }
  }

  // 事件监听
  toggleBtn.onclick = toggleCopilot
  closeBtn?.addEventListener('click', closeCopilot)

  clearBtn?.addEventListener('click', async () => {
    if (confirm('确定清空 Co-Pilot 对话记录吗？')) {
      try {
        await fetch('/api/copilot/clear', {
          method: 'POST',
          headers: { Authorization: `Bearer ${hooks.token()}` },
        })
        msgs.innerHTML = `
          <div class="copilot-welcome">
            <div class="copilot-welcome-badge">全局临床科研 AI 助手</div>
            <h4>有什么可以协助您的临床研究或写作？</h4>
            <p class="muted small">随时为你检索 PubMed 顶刊文献、解答 GCP 规范、撰写统计分析计划 (SAP)、编写 Python 绘图代码、解读 RECIST 1.1 影像病灶。</p>
          </div>
        `
      } catch {}
    }
  })

  chipsContainer?.addEventListener('click', e => {
    const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('.copilot-chip')
    if (chip?.dataset.chip) {
      void sendMessage(chip.dataset.chip)
    }
  })

  sendBtn?.addEventListener('click', () => void sendMessage())

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  })

  // 快捷键: Cmd+J / Ctrl+J
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
      e.preventDefault()
      toggleCopilot()
    } else if (e.key === 'Escape' && isOpen) {
      closeCopilot()
    }
  })

  // 路由变化时刷新上下文
  window.addEventListener('hashchange', () => {
    if (isOpen) {
      updateContextBadge()
      renderChips()
    }
  })

  // 初始化时静默预加载历史聊天记录
  void loadHistory()
}
