export interface CopilotBoundUser {
  id: string
  username: string
  display_name: string
}

export interface CopilotHooks {
  token: () => string
  user: () => CopilotBoundUser | null
  onUnauthorized?: () => void
  activeDoc: () => { id: string; title: string } | null
  onInsertTable?: (rows: string[][]) => void | Promise<void>
  onNotice?: (msg: string, error?: boolean) => void
}

const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ESC_MAP[c] ?? c)

function splitTableCells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const PIPE_TOKEN = '\u0000PIPE\u0000'
  return s
    .replace(/\\\|/g, PIPE_TOKEN)
    .split('|')
    .map(c => c.replace(/\u0000PIPE\u0000/g, '|').trim())
}

function isTableSeparator(line: string): boolean {
  const s = line.trim()
  if (!s.includes('|') || !/[-—]/.test(s)) return false
  const cells = splitTableCells(s)
  if (cells.length === 0) return false
  if (cells.length === 1 && !(s.startsWith('|') && s.endsWith('|'))) return false
  return cells.every(c => /^:?[-—]+:?$/.test(c))
}

function parseTableAlignments(sepLine: string): Array<'left' | 'center' | 'right' | ''> {
  return splitTableCells(sepLine).map(c => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return ''
  })
}

export function formatInlineMarkdown(raw: string): string {
  if (!raw) return ''
  const inlineCodes: string[] = []
  let text = raw.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const idx = inlineCodes.length
    inlineCodes.push(`<code class="md-code">${esc(code)}</code>`)
    return `\u0000ICODE_${idx}\u0000`
  })
  // 允许表格或段落中显式的 <br> / <br/> 换行
  text = text.replace(/<br\s*\/?>/gi, '\u0000BR\u0000')
  let html = esc(text)
  html = html.replace(/\u0000BR\u0000/g, '<br>')
  // 引用标记 [@c:xxx]
  html = html.replace(/\[@c:([a-zA-Z0-9_-]+)\]/g, '<span class="pill green md-cite-pill">引用 $1</span>')
  // 安全链接 [text](url)
  html = html.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/|#\/)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="md-link">$1</a>')
  // 粗斜体 ***text***
  html = html.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
  // 粗体 **text** 或 __text__
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
  // 斜体 *text*
  html = html.replace(/(?<!\*)\*([^*\s][^*\n]*?)\*(?!\*)/g, '<em>$1</em>')
  // 删除线 ~~text~~
  html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  // 还原行内代码
  html = html.replace(/\u0000ICODE_(\d+)\u0000/g, (_m, idx: string) => inlineCodes[Number(idx)] ?? '')
  return html
}

export function formatMarkdown(text: string): string {
  if (!text) return ''
  const normalized = String(text).replace(/\r\n?/g, '\n')

  // 1. 先提取多行围栏代码块（支持流式输出中尚未闭合的代码块）
  const codeBlocks: string[] = []
  const withBlockTokens = normalized.replace(/```([\w+-]*)\n([\s\S]*?)(?:```|$)/g, (_m, lang: string, code: string) => {
    const idx = codeBlocks.length
    const cleanLang = esc(lang.trim())
    const cleanCode = esc(code.replace(/\n$/, ''))
    codeBlocks.push(
      `<div class="md-code-wrap">` +
        `<div class="md-block-bar">` +
          `<span class="md-block-label">${cleanLang || '代码'}</span>` +
          `<span class="grow"></span>` +
          `<button type="button" class="md-act-btn" data-md-act="copy-code" title="复制代码到剪贴板">复制代码</button>` +
        `</div>` +
        `<pre class="md-pre"><code${cleanLang ? ` class="lang-${cleanLang}"` : ''}>${cleanCode}</code></pre>` +
      `</div>`
    )
    return `\n\u0000CBLOCK_${idx}\u0000\n`
  })

  const lines = withBlockTokens.split('\n')
  const blocks: string[] = []
  let i = 0

  const isBlockStart = (idx: number): boolean => {
    if (idx >= lines.length) return true
    const l = lines[idx]!
    const t = l.trim()
    if (!t) return true
    if (/^\u0000CBLOCK_\d+\u0000$/.test(t)) return true
    if (/^(#{1,6})(?:\s+|(?=[一二三四五六七八九十百千万\d]))/.test(t)) return true
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) return true
    if (/^>\s?/.test(t)) return true
    if (/^(\s*)([-*+•]|\d+[.)])\s+/.test(l)) return true
    if (t.includes('|') && idx + 1 < lines.length && isTableSeparator(lines[idx + 1]!)) return true
    return false
  }

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (!trimmed) {
      i++
      continue
    }

    const cbMatch = /^\u0000CBLOCK_(\d+)\u0000$/.exec(trimmed)
    if (cbMatch) {
      blocks.push(codeBlocks[Number(cbMatch[1])] ?? '')
      i++
      continue
    }

    // GFM 表格（表头行 + 分隔行 + 数据行）
    if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const headerCells = splitTableCells(line)
      const aligns = parseTableAlignments(lines[i + 1]!)
      const colCount = Math.max(headerCells.length, aligns.length)
      const thHtml = headerCells
        .map((c, idx) => {
          const al = aligns[idx]
          return `<th${al ? ` style="text-align:${al}"` : ''}>${formatInlineMarkdown(c)}</th>`
        })
        .join('')
      i += 2
      const bodyRows: string[] = []
      while (i < lines.length) {
        const rowLine = lines[i]!
        const rowTrimmed = rowLine.trim()
        if (!rowTrimmed || !rowTrimmed.includes('|') || /^\u0000CBLOCK_\d+\u0000$/.test(rowTrimmed) || /^(#{1,6})\s/.test(rowTrimmed)) {
          break
        }
        if (isTableSeparator(rowLine)) {
          i++
          continue
        }
        const rawCells = splitTableCells(rowLine)
        const totalCols = Math.max(colCount, rawCells.length)
        const tds: string[] = []
        for (let c = 0; c < totalCols; c++) {
          const al = aligns[c]
          tds.push(`<td${al ? ` style="text-align:${al}"` : ''}>${formatInlineMarkdown(rawCells[c] ?? '')}</td>`)
        }
        bodyRows.push(`<tr>${tds.join('')}</tr>`)
        i++
      }
      blocks.push(
        `<div class="md-table-wrap">` +
          `<div class="md-block-bar">` +
            `<span class="md-block-label">数据表 · ${headerCells.length} 列 × ${bodyRows.length} 行</span>` +
            `<span class="grow"></span>` +
            `<button type="button" class="md-act-btn" data-md-act="copy-table" title="复制表格（支持直接粘贴至 Excel / Word）">复制表格</button>` +
            `<button type="button" class="md-act-btn primary" data-md-act="insert-table" title="作为可编辑三线表插入当前文稿">＋ 插入文档</button>` +
          `</div>` +
          `<table class="md-table"><thead><tr>${thHtml}</tr></thead>${
            bodyRows.length > 0 ? `<tbody>${bodyRows.join('')}</tbody>` : ''
          }</table>` +
        `</div>`
      )
      continue
    }

    // 标题 (# ~ ######)
    const hMatch = /^(#{1,6})(?:\s+|(?=[一二三四五六七八九十百千万\d]))(.+?)\s*#*$/.exec(trimmed)
    if (hMatch) {
      const level = Math.min(6, hMatch[1]!.length)
      blocks.push(`<h${level} class="md-h md-h${level}">${formatInlineMarkdown(hMatch[2]!)}</h${level}>`)
      i++
      continue
    }

    // 水平分割线 (--- / *** / ___)
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push('<hr class="md-hr">')
      i++
      continue
    }

    // 引用块 (> ...)
    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!.trim())) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push(`<blockquote class="md-quote">${quoteLines.map(l => formatInlineMarkdown(l)).join('<br>')}</blockquote>`)
      continue
    }

    // 列表（无序 - * + • 与有序 1. 2)）
    const listMatch = /^(\s*)([-*+•]|\d+[.)])\s+(.+)$/.exec(line)
    if (listMatch) {
      const isOrdered = /^\d+[.)]$/.test(listMatch[2]!)
      const startNum = isOrdered ? parseInt(listMatch[2]!, 10) : 1
      const baseIndent = listMatch[1]!.length
      const items: Array<{ html: string; subItems: string[]; subOrdered: boolean }> = []

      while (i < lines.length) {
        const curLine = lines[i]!
        if (!curLine.trim()) {
          const nextLine = lines[i + 1]
          const nextMatch = nextLine ? /^(\s*)([-*+•]|\d+[.)])\s+(.+)$/.exec(nextLine) : null
          if (nextMatch) {
            const nextOrdered = /^\d+[.)]$/.test(nextMatch[2]!)
            if (nextOrdered === isOrdered || nextMatch[1]!.length > baseIndent) {
              i++
              continue
            }
          }
          break
        }
        const m = /^(\s*)([-*+•]|\d+[.)])\s+(.+)$/.exec(curLine)
        if (!m) break
        const indent = m[1]!.length
        const itemOrdered = /^\d+[.)]$/.test(m[2]!)
        if (indent > baseIndent && items.length > 0) {
          const last = items[items.length - 1]!
          last.subOrdered = itemOrdered
          last.subItems.push(`<li>${formatInlineMarkdown(m[3]!)}</li>`)
          i++
          continue
        }
        if (itemOrdered !== isOrdered && indent <= baseIndent) break
        items.push({ html: formatInlineMarkdown(m[3]!), subItems: [], subOrdered: false })
        i++
      }

      const tag = isOrdered ? 'ol' : 'ul'
      const startAttr = isOrdered && startNum > 1 ? ` start="${startNum}"` : ''
      const liHtml = items
        .map(it => {
          const subTag = it.subOrdered ? 'ol' : 'ul'
          const sub = it.subItems.length > 0 ? `<${subTag} class="md-sublist">${it.subItems.join('')}</${subTag}>` : ''
          return `<li>${it.html}${sub}</li>`
        })
        .join('')
      blocks.push(`<${tag}${startAttr} class="md-list">${liHtml}</${tag}>`)
      continue
    }

    // 普通段落（合并连续非块级行）
    const paraLines: string[] = []
    while (i < lines.length && !isBlockStart(i)) {
      paraLines.push(formatInlineMarkdown(lines[i]!))
      i++
    }
    if (paraLines.length > 0) {
      blocks.push(`<p class="md-p">${paraLines.join('<br>')}</p>`)
    } else {
      blocks.push(`<p class="md-p">${formatInlineMarkdown(line)}</p>`)
      i++
    }
  }

  return blocks.join('')
}

function extractTableMatrix(table: HTMLTableElement): string[][] {
  const rows: string[][] = []
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    const cells = Array.from(tr.querySelectorAll('th, td')).map(c =>
      (c.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

export function bindMarkdownActions(
  container: HTMLElement,
  opts: {
    onInsertTable?: (rows: string[][]) => void | Promise<void>
    onNotice?: (msg: string, error?: boolean) => void
  } = {}
) {
  if ((container as any).__mdActionsBound) return
  ;(container as any).__mdActionsBound = true

  container.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-md-act]')
    if (!btn) return
    const act = btn.dataset.mdAct
    const origText = btn.textContent || ''

    const flashDone = (label: string) => {
      btn.textContent = label
      btn.classList.add('done')
      setTimeout(() => {
        btn.textContent = origText
        btn.classList.remove('done')
      }, 1500)
    }

    if (act === 'copy-code') {
      const code = btn.closest('.md-code-wrap')?.querySelector('code')?.textContent ?? ''
      try {
        await navigator.clipboard.writeText(code)
        flashDone('✓ 已复制')
        opts.onNotice?.('代码已复制到剪贴板')
      } catch {
        opts.onNotice?.('复制失败，请手动选择复制', true)
      }
      return
    }

    if (act === 'copy-table') {
      const table = btn.closest('.md-table-wrap')?.querySelector('table')
      if (!table) return
      const rows = extractTableMatrix(table)
      const tsv = rows.map(r => r.join('\t')).join('\n')
      try {
        await navigator.clipboard.writeText(tsv)
        flashDone('✓ 已复制')
        opts.onNotice?.('表格已复制（可直接粘贴至 Excel / Word / 文稿）')
      } catch {
        opts.onNotice?.('复制失败，请手动选择复制', true)
      }
      return
    }

    if (act === 'insert-table') {
      const table = btn.closest('.md-table-wrap')?.querySelector('table')
      if (!table) return
      const rows = extractTableMatrix(table)
      if (rows.length === 0) return
      if (opts.onInsertTable) {
        await opts.onInsertTable(rows)
        flashDone('✓ 已插入')
      }
    }
  })
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

  bindMarkdownActions(msgs, {
    onInsertTable: hooks.onInsertTable,
    onNotice: hooks.onNotice,
  })

  function isAuthenticated(): boolean {
    const token = hooks.token()?.trim()
    const user = hooks.user()
    const authScreen = document.getElementById('authScreen')
    const appEl = document.getElementById('app')
    if (!token || !user?.id) return false
    if (authScreen && !authScreen.hidden) return false
    if (appEl && appEl.hidden) return false
    return true
  }

  function handleUnauthorized() {
    isOpen = false
    drawer?.classList.add('hidden')
    if (toggleBtn) toggleBtn.hidden = true
    hooks.onUnauthorized?.()
  }

  if (!isAuthenticated()) {
    toggleBtn.hidden = true
    drawer.classList.add('hidden')
    return
  }
  toggleBtn.hidden = false

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
    const user = hooks.user()
    const userLabel = user ? (user.display_name || user.username) : '未绑定'
    badge.textContent = `${userLabel} · ${ctx.space}${ctx.title ? ` · 《${ctx.title.slice(0, 10)}》` : ''}`
  }

  async function loadHistory() {
    // 未登录（登录页）或未绑定用户时不预取
    if (historyLoaded || !isAuthenticated()) return
    try {
      const res = await fetch('/api/copilot/status', {
        headers: { Authorization: `Bearer ${hooks.token()}` },
      })
      if (res.status === 401) {
        handleUnauthorized()
        return
      }
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
    if (!isAuthenticated()) {
      handleUnauthorized()
      return
    }
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
    if (!isAuthenticated()) {
      handleUnauthorized()
      return
    }
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
    if (!isAuthenticated()) {
      handleUnauthorized()
      return
    }
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

      if (res.status === 401) {
        isStreaming = false
        handleUnauthorized()
        return
      }
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
    if (!isAuthenticated()) {
      handleUnauthorized()
      return
    }
    if (confirm('确定清空 Co-Pilot 对话记录吗？')) {
      try {
        const res = await fetch('/api/copilot/clear', {
          method: 'POST',
          headers: { Authorization: `Bearer ${hooks.token()}` },
        })
        if (res.status === 401) {
          handleUnauthorized()
          return
        }
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

  // 快捷键: Cmd+J / Ctrl+J（仅登录并绑定用户后生效）
  window.addEventListener('keydown', e => {
    if (!isAuthenticated()) return
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
