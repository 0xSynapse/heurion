/**
 * 来源等级的界面（docs/design/PROVENANCE.md 第 5 节）：
 * - 正文里 AI 写的、还没确认的文字带浅色底纹（默认开，可隐藏；偏好存在服务端，换设备也一样）；
 * - 文档上方提示栏：还有多少段含未确认的 AI 文字，「下一处」「全部确认」；
 * - 工具栏「确认」：确认光标所在 / 选中的段落；
 * - 确认只能由用户做（服务端 /confirm-ai 不给 AI）。确认后标记经协同同步回来，提示栏随之更新。
 */
import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { aiStats } from '../../src/model/provenance.ts'

interface Deps {
  api: <T = any>(path: string, opts?: RequestInit) => Promise<T>
  view: () => EditorView | null
  docId: () => string | null
  notice: (text: string, error?: boolean) => void
}

export interface ProvenancePrefs { safe_edits: boolean; shade: boolean }

export function initProvenanceUi(deps: Deps) {
  const banner = document.getElementById('provBanner')!
  const summary = document.getElementById('provSummary')!
  const shadeBtn = document.getElementById('provShadeBtn')!
  const confirmBtn = document.getElementById('confirmAiBtn') as HTMLButtonElement | null
  let shade = true

  const applyShade = () => {
    document.body.classList.toggle('hide-prov', !shade)
    shadeBtn.textContent = shade ? '隐藏底纹' : '显示底纹'
  }

  async function loadPrefs(): Promise<void> {
    try {
      const p = await deps.api<ProvenancePrefs>('/api/me/provenance')
      shade = p.shade
    } catch { /* 拿不到偏好时按默认显示 */ }
    applyShade()
  }

  /** 按当前文档刷新提示栏与「确认」按钮。 */
  function render(): void {
    const view = deps.view()
    const stats = view ? aiStats(view.state.doc) : { blocks: 0, chars: 0 }
    banner.hidden = stats.blocks === 0
    if (confirmBtn) confirmBtn.hidden = stats.blocks === 0
    if (stats.blocks) summary.textContent = `有 ${stats.blocks} 段含 AI 写的、还没确认的文字（约 ${stats.chars} 字）`
  }

  /** 选中范围（或光标所在）的段落 id。 */
  function selectedBlockIds(view: EditorView): string[] {
    const { from, to, $from } = view.state.selection
    const ids = new Set<string>()
    if (from === to) {
      for (let d = $from.depth; d > 0; d--) {
        const n = $from.node(d)
        if (n.isTextblock && n.attrs.id) { ids.add(String(n.attrs.id)); break }
      }
    } else {
      view.state.doc.nodesBetween(from, to, (n: PMNode) => {
        if (n.isTextblock) { if (n.attrs.id) ids.add(String(n.attrs.id)); return false }
        return true
      })
    }
    return [...ids]
  }

  async function confirm(ids: string[] | null): Promise<void> {
    const docId = deps.docId()
    if (!docId) return
    try {
      const r = await deps.api<{ confirmed: number; remaining: { blocks: number } }>(`/api/docs/${docId}/confirm-ai`, {
        method: 'POST',
        body: JSON.stringify(ids ? { node_ids: ids } : {}),
      })
      deps.notice(r.confirmed ? `已确认 ${r.confirmed} 段 AI 写的文字` : '所选段落里没有需要确认的 AI 文字')
    } catch (err) {
      deps.notice(`确认失败：${(err as Error).message}`, true)
    }
  }

  /** 跳到光标之后的下一处 AI 文字（到末尾后从头找）。 */
  function next(): void {
    const view = deps.view()
    if (!view) return
    const doc = view.state.doc
    const starts: Array<{ from: number; to: number }> = []
    doc.descendants((n, pos) => {
      if (n.isText && n.marks.some(m => m.type.name === 'prov')) {
        const last = starts.at(-1)
        if (last && last.to === pos) last.to = pos + n.nodeSize
        else starts.push({ from: pos, to: pos + n.nodeSize })
      }
      return true
    })
    if (!starts.length) return
    const at = view.state.selection.to
    const hit = starts.find(s => s.from >= at) ?? starts[0]!
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, hit.from, hit.to)).scrollIntoView())
    view.focus()
  }

  banner.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-prov]')
    if (!b) return
    if (b.dataset.prov === 'all') void confirm(null)
    else if (b.dataset.prov === 'next') next()
    else if (b.dataset.prov === 'shade') {
      shade = !shade
      applyShade()
      void deps.api('/api/me/provenance', { method: 'PUT', body: JSON.stringify({ shade }) }).catch(() => {})
    }
  })

  return {
    loadPrefs,
    render,
    hide: () => { banner.hidden = true; if (confirmBtn) confirmBtn.hidden = true },
    /** 工具栏「确认」 */
    confirmSelection: () => {
      const view = deps.view()
      if (!view) return
      const ids = selectedBlockIds(view)
      if (ids.length) void confirm(ids)
    },
  }
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/** 下载来源证明（JSON）：AI 未确认的文字、绑定数字的来源、引用证据、AI 的修改回合。 */
export async function downloadProof(api: Deps['api'], docId: string, title: string, notice: Deps['notice']): Promise<void> {
  try {
    const proof = await api(`/api/docs/${docId}/provenance`)
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([JSON.stringify(proof, null, 2)], { type: 'application/json' })),
      download: `${title || docId}-来源证明.json`,
    })
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  } catch (err) { notice(`来源证明生成失败：${(err as Error).message}`, true) }
}

/** AI 使用声明：中 / 英两版，复制后粘进投稿系统；有未确认的 AI 文字等问题时先列出来。 */
export async function openDisclosure(api: Deps['api'], docId: string, notice: Deps['notice']): Promise<void> {
  const dlg = document.getElementById('dialog')!
  const load = (lang: 'zh' | 'en') => api<{ text: string; warnings: string[] }>(`/api/docs/${docId}/ai-disclosure?lang=${lang}`)
  let zh: { text: string; warnings: string[] }, en: { text: string }
  try { [zh, en] = await Promise.all([load('zh'), load('en')]) } catch (err) { notice(`AI 使用声明生成失败：${(err as Error).message}`, true); return }
  dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="AI 使用声明">
    <div class="dialog-head"><h2>AI 使用声明（草稿）</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
    <div class="dialog-body">
      <div class="muted small">按平台记录到的事实生成：AI 改了哪些段落、哪些已由你确认、是否新增参考文献、哪些数字绑定到分析结果。期刊要求声明 AI 使用时，核对后粘进投稿系统。</div>
      ${zh.warnings.length ? `<div class="danger-confirm" style="margin:10px 0">${zh.warnings.map(escHtml).join('<br>')}</div>` : ''}
      <h3>中文</h3><textarea id="discZh" rows="5" style="width:100%">${escHtml(zh.text)}</textarea>
      <div class="row end"><button data-copy="discZh">复制中文</button></div>
      <h3>English</h3><textarea id="discEn" rows="5" style="width:100%">${escHtml(en.text)}</textarea>
      <div class="row end"><button data-copy="discEn">Copy English</button></div>
    </div></div>`
  dlg.hidden = false
  const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
  dlg.onclick = async e => {
    const t = e.target as HTMLElement
    if (t === dlg || t.closest('[data-close]')) { close(); return }
    const copy = t.closest<HTMLButtonElement>('button[data-copy]')
    if (copy) {
      const ta = document.getElementById(copy.dataset.copy!) as HTMLTextAreaElement
      try { await navigator.clipboard.writeText(ta.value); notice('已复制') } catch { ta.select(); notice('请按 ⌘C / Ctrl+C 复制') }
    }
  }
}

/** 对话里的保护记录（回合结束时一行汇总）。 */
export function protectionNote(lines: string[]): HTMLElement {
  const div = document.createElement('div')
  div.className = 'msg protection-note'
  const b = document.createElement('b')
  b.textContent = '写作保护'
  div.appendChild(b)
  const ul = document.createElement('ul')
  for (const line of lines) {
    const li = document.createElement('li')
    li.textContent = line
    ul.appendChild(li)
  }
  div.appendChild(ul)
  return div
}
