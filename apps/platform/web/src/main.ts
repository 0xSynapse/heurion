/**
 * Heurion 2.0 Web 工作台前端主入口。
 */
import 'prosemirror-view/style/prosemirror.css'
import 'prosemirror-tables/style/tables.css'
import 'prosemirror-gapcursor/style/gapcursor.css'
import './style.css'
import * as Y from 'yjs'
import { initUserMenu, showAuthScreen, signOut, storedToken, type Me } from './account.ts'
import { DeckView, type ChartData } from './deck.ts'
import { pickLayout, pickTemplate } from './templates.ts'
import { EDITABLE_CHART_TYPES, editChartData } from './chart-dialog.ts'
import { askConfirm, askText } from './dialogs.ts'
import { Editor, type SelectionAnchor } from './editor.ts'
import { OriginalView } from './original.ts'
import { initDatasets } from './datasets.ts'
import { initPatients } from './patients.ts'
import { initResearch } from './research.ts'
import { initCalendar } from './calendar.ts'
import { initMail } from './mail.ts'
import { initSpaces } from './spaces.ts'
import { initLibrary } from './library.ts'
import { initMemory } from './memory.ts'
import { initActions } from './actions.ts'
import { Provider, type ProviderStatus } from './provider.ts'
import { applyTheme, mountThemeSwitch } from './theme.ts'
import { photoFigure } from './photos.ts'
import { openPhotoSearch, photoSearchEnabled } from './unsplash.ts'
import { openHelpGuide, importHelpAsDoc } from './help.ts'
import { initCopilot, formatMarkdown, bindMarkdownActions } from './copilot.ts'
import { icon, type IconName } from './icons.ts'
import { downloadProof, initProvenanceUi, openDisclosure, protectionNote } from './provenance-ui.ts'
import { coverageText, pollReviewJob, renderReviewProgress, type ReviewCoverage } from './review-progress.ts'

const TOKEN = storedToken()
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
applyTheme()
mountThemeSwitch($('themeSwitch'))
$('authScreen').insertAdjacentHTML('afterbegin', photoFigure('login'))
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/**
 * 网关层的错误（生产经 Cloudflare 与 Caddy）：返回的是网关自己的 HTML 错误页，不是平台的 JSON。
 * 524 = 源站超过 100 秒没响应（Cloudflare 的上限），请求本身在服务端多半还在继续；502 / 521–523 = 暂时连不上源站（如部署重启）。
 */
const GATEWAY_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524])
const gatewayMessage = (status: number) => status === 524 || status === 504
  ? `等待超时（HTTP ${status}）：服务处理时间超过了网关时限，任务可能仍在后台进行`
  : `服务暂时不可用（HTTP ${status}），请稍后重试`

async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers as Record<string, string> | undefined) } })
  // 令牌失效（过期、被停用、在别处改了密码）：回到登录页
  if (res.status === 401) {
    if (TOKEN) signOut()
    throw new Error('请先登录')
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => '')
    let e: { error?: string; message?: string; detail?: string; code?: string } = {}
    try { e = JSON.parse(raw) } catch {}
    // 网关的 HTML 错误页不原样显示给用户；gateway = true 时调用方可以改为轮询任务状态
    const html = /^\s*</.test(raw) || (res.headers.get('content-type') ?? '').includes('text/html')
    if (html || (GATEWAY_STATUS.has(res.status) && !e.message && !e.error)) {
      throw Object.assign(new Error(gatewayMessage(res.status)), { status: res.status, body: e, gateway: true })
    }
    // 影像等接口用 { error: 代码, message: 说明 }：有说明时显示说明；HTTP/2 下 statusText 为空时回退状态码
    // 错误码与附带信息（如所见草稿的 draft_exists 带 doc_id）挂在错误上，调用方按需处理
    throw Object.assign(new Error(e.message || e.detail || e.error || raw.trim().slice(0, 200) || res.statusText || `请求失败 (HTTP ${res.status})`), { status: res.status, body: e })
  }
  return (res.headers.get('content-type')?.includes('json') ? res.json() : res.text()) as Promise<T>
}

interface Session {
  docId: string
  kind: 'doc' | 'deck'
  stream: EventSource
  /** doc：协同编辑器。 */
  ydoc?: Y.Doc
  provider?: Provider
  editor?: Editor
  /** deck：幻灯片查看器（编辑经对话）。 */
  deck?: DeckView
}

let session: Session | null = null
let detail: any = null
let anchor: SelectionAnchor | null = null
let pendingAnchor: { node_id: string; snippet: string; paragraph?: number; range?: { from: number; to: number } } | null = null
let refreshTimer: number | undefined

const ICON_DOC = '<svg class="kind doc" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-label="文档"><path d="M4 1.75h5.5L12.5 4.75v9.5H4z"/><path d="M9.25 1.75v3.25h3.25M6 8h4.5M6 10.75h4.5"/></svg>'
const ICON_DECK = '<svg class="kind deck" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-label="幻灯片"><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5"/><path d="M8 11.25v2.5M5.5 13.75h5"/></svg>'
const ICON_FOLDER = '<svg class="kind folder" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-label="项目文件夹"><path d="M1.75 3.5A1 1 0 0 1 2.75 2.5h3.69c.35 0 .68.18.87.48l.94 1.52H13.25a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-9z"/></svg>'
const ICON_FOLDER_OPEN = '<svg class="kind folder open" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-label="打开的项目文件夹"><path d="M1.75 4A1 1 0 0 1 2.75 3h3.69c.35 0 .68.18.87.48l.94 1.52H13.25a1 1 0 0 1 1 1v1.5H1.75V4z"/><path d="M1.75 6.5h11.75a1 1 0 0 1 .98 1.2l-1.1 4.5a1 1 0 0 1-.98.8H2.5a1 1 0 0 1-.98-.8l-1.1-4.5a1 1 0 0 1 .98-1.2h.35z"/></svg>'

// —— 左栏：文档仓库（项目分组、搜索、回收站） ——

let docRows: any[] = []
let projects: Array<{ id: string; name: string }> = []
const collapsed = new Set<string>(JSON.parse((() => { try { return localStorage.getItem('heurion.collapsed') ?? '[]' } catch { return '[]' } })()))
const saveCollapsed = () => { try { localStorage.setItem('heurion.collapsed', JSON.stringify([...collapsed])) } catch { /* 忽略 */ } }

const isCopilotDoc = (d: any): boolean => {
  if (!d?.context) return false
  if (typeof d.context === 'object') return d.context.kind === 'copilot'
  try { return JSON.parse(d.context)?.kind === 'copilot' } catch { return false }
}

const docItem = (d: any) => `<li data-id="${esc(d.id)}" class="${d.id === session?.docId ? 'active' : ''}" title="${esc(d.title)}">${d.kind === 'deck' ? ICON_DECK : ICON_DOC}<span class="label">${esc(d.title)}</span><button class="item-menu" data-doc-menu="${esc(d.id)}" title="更多操作" aria-label="更多操作">⋯</button></li>`

async function loadDocs(): Promise<void> {
  const [rawDocs, projs] = await Promise.all([api<any[]>('/api/docs'), api<any[]>('/api/projects')])
  docRows = rawDocs.filter(d => !isCopilotDoc(d))
  projects = projs
  if ($<HTMLInputElement>('docSearch').value.trim()) { void runSearch(); return }
  const loose = docRows.filter(d => !d.project_id)
  const groups = projects.map(p => {
    const items = docRows.filter(d => d.project_id === p.id)
    const open = !collapsed.has(p.id)
    return `<li class="group${open ? ' open' : ''}" data-project="${esc(p.id)}"><span class="caret">${open ? '▾' : '▸'}</span>${open ? ICON_FOLDER_OPEN : ICON_FOLDER}<span class="label">${esc(p.name)}</span><span class="count">${items.length}</span><button class="item-menu" data-project-menu="${esc(p.id)}" title="项目操作" aria-label="项目操作">⋯</button></li>${open ? items.map(docItem).join('') : ''}`
  }).join('')
  $('docList').innerHTML = (loose.length && projects.length ? '<li class="group-label">未分组</li>' : '') + loose.map(docItem).join('') + groups
    + (docRows.length === 0 ? '<li class="nav-empty">还没有文档</li>' : '')
}

let searchTimer: number | undefined
async function runSearch(): Promise<void> {
  if ($('docList').hidden) return
  const q = $<HTMLInputElement>('docSearch').value.trim()
  if (!q) { void loadDocs(); return }
  const hits = await api<any[]>(`/api/search?q=${encodeURIComponent(q)}`)
  // 命中词在片段里用 [ ] 括起：转义后换成高亮
  const mark = (s: string) => esc(s).replace(/\[([^\]]*)\]/g, '<mark>$1</mark>')
  $('docList').innerHTML = hits.length === 0
    ? `<li class="nav-empty">没有找到「${esc(q)}」</li>`
    : hits.map(h => `<li data-id="${esc(h.doc_id)}" class="hit${h.doc_id === session?.docId ? ' active' : ''}" title="${esc(h.title)}">${h.kind === 'deck' ? ICON_DECK : ICON_DOC}<span class="hit-text"><span class="label">${esc(h.title)}</span><span class="snippet">${mark(h.snippet)}</span></span></li>`).join('')
}
$('docSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void runSearch(), 200) }
$('docSearch').onkeydown = e => { if (e.key === 'Escape') { $<HTMLInputElement>('docSearch').value = ''; void loadDocs() } }

/** 将浮动弹层限制在可视窗口内（靠近底边自动向上翻转，靠近右边自动向左收缩）。 */
function placeFixedPopup(menu: HTMLElement, anchorRect: DOMRect, preferRight = false): void {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const pad = 8
  Object.assign(menu.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    right: 'auto',
    bottom: 'auto',
    maxHeight: `${Math.max(120, vh - pad * 2)}px`,
    maxWidth: `${Math.max(150, vw - pad * 2)}px`,
    overflowY: 'auto',
  })
  const mr = menu.getBoundingClientRect()
  const mw = mr.width || 160
  const mh = mr.height || 140
  let left = preferRight ? anchorRect.right - 4 : anchorRect.left
  if (left + mw > vw - pad) {
    left = preferRight ? Math.max(pad, anchorRect.left - mw + 4) : Math.max(pad, vw - mw - pad)
  }
  left = Math.max(pad, left)

  let top = preferRight ? anchorRect.top : anchorRect.bottom + 6
  if (top + mh > vh - pad) {
    const flipped = preferRight ? anchorRect.bottom - mh : anchorRect.top - mh - 6
    top = flipped >= pad ? flipped : Math.max(pad, vh - mh - pad)
  }
  top = Math.max(pad, top)
  menu.style.left = `${Math.round(left)}px`
  menu.style.top = `${Math.round(top)}px`
}

/** 小菜单（固定定位在按钮旁边，自动适配屏幕与窗口边界）。 */
function popMenu(anchor: HTMLElement, items: Array<[string, () => void | Promise<void>, boolean?]>): void {
  document.querySelector('.pop-menu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'pop-menu'
  menu.innerHTML = items.map(([label, , danger], i) => `<button data-i="${i}" class="${danger ? 'danger-text' : ''}">${esc(label)}</button>`).join('')
  const r = anchor.getBoundingClientRect()
  document.body.appendChild(menu)
  placeFixedPopup(menu, r, true)
  const close = () => {
    menu.remove()
    document.removeEventListener('mousedown', outside)
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', close)
  }
  const outside = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) close() }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  const onScroll = (e: Event) => { if (!menu.contains(e.target as Node)) close() }
  setTimeout(() => {
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', onKey)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close, { once: true })
  })
  menu.onclick = e => {
    const b = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null
    if (!b) return
    close()
    void items[Number(b.dataset.i)]![1]()
  }
}

async function moveDoc(docId: string): Promise<void> {
  const options = [['', '未分组'], ...projects.map(p => [p.id, p.name])]
  const current = docRows.find(d => d.id === docId)?.project_id ?? ''
  const name = await askText({ title: '移动到项目', label: `项目名（现有：${options.map(o => o[1]).join('、')}；输入新名字会新建项目）`, value: options.find(o => o[0] === current)?.[1] ?? '未分组', confirm: '移动' })
  if (name === null) return
  let target = name.trim() === '' || name.trim() === '未分组' ? null : projects.find(p => p.name === name.trim())?.id
  if (target === undefined) target = (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: name.trim() }) })).id
  await api(`/api/docs/${docId}`, { method: 'PATCH', body: JSON.stringify({ project_id: target }) })
  await loadDocs()
}

$('docList').onclick = async e => {
  const t = e.target as HTMLElement
  const docMenu = t.closest('[data-doc-menu]') as HTMLElement | null
  if (docMenu) {
    e.stopPropagation()
    const id = docMenu.dataset.docMenu!
    const d = docRows.find(x => x.id === id)
    popMenu(docMenu, [
      ['重命名', async () => {
        const title = await askText({ title: '重命名', label: '标题', value: d?.title ?? '' })
        if (title?.trim()) { await api(`/api/docs/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }); await loadDocs(); if (session?.docId === id) await refresh(false) }
      }],
      ['移动到项目…', () => moveDoc(id)],
      ['复制', async () => { const c = await api(`/api/docs/${id}/duplicate`, { method: 'POST' }); await loadDocs(); await open(c.id) }],
      ['移到回收站', async () => {
        await api(`/api/docs/${id}`, { method: 'DELETE' })
        if (session?.docId === id) { leaveDoc(); showWelcome() }
        await loadDocs()
        showNotice(`「${d?.title ?? '文档'}」已移到回收站（30 天内可恢复）`)
      }, true],
    ])
    return
  }
  const projMenu = t.closest('[data-project-menu]') as HTMLElement | null
  if (projMenu) {
    e.stopPropagation()
    const id = projMenu.dataset.projectMenu!
    const p = projects.find(x => x.id === id)
    popMenu(projMenu, [
      ['重命名', async () => {
        const name = await askText({ title: '重命名项目', label: '项目名', value: p?.name ?? '' })
        if (name?.trim()) { await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }); await loadDocs() }
      }],
      ['删除项目', async () => {
        if (!await askConfirm({ title: '删除项目', message: `删除项目「${p?.name ?? ''}」？里面的文档不会删除，会回到「未分组」。`, confirm: '删除项目', danger: true })) return
        await api(`/api/projects/${id}`, { method: 'DELETE' })
        await loadDocs()
      }, true],
    ])
    return
  }
  const group = t.closest('li.group') as HTMLElement | null
  if (group) {
    const id = group.dataset.project!
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id)
    saveCollapsed()
    await loadDocs()
    return
  }
  const li = t.closest('li[data-id]') as HTMLElement | null
  if (li?.dataset.id) void open(li.dataset.id)
}

$('newProject').onclick = async () => {
  const name = await askText({ title: '新建项目', label: '项目名', placeholder: '例如：SELECT 试验汇报', confirm: '新建' })
  if (!name?.trim()) return
  await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) })
  await loadDocs()
}

$('trashBtn').onclick = () => void openTrash()
$('helpBtn').onclick = () => openHelpGuide()
if ($('topbarHelpBtn')) $('topbarHelpBtn').onclick = () => openHelpGuide()
document.addEventListener('heurion:help', (e: Event) => {
  const detail = (e as CustomEvent).detail
  openHelpGuide(detail?.section)
})
document.addEventListener('heurion:import-help-doc', () => {
  void importHelpAsDoc(api, loadDocs, open, (msg, err) => showNotice(msg, err))
})
const library = initLibrary(api, () => TOKEN, (m, e) => showNotice(m, e), { showPage: (cls, title) => showPage(cls, title) })
const memory = initMemory(api, (m, e) => showNotice(m, e), id => void open(id))
const actions = initActions(api, (m, e) => showNotice(m, e))
// 来源等级：AI 文字底纹、提示栏、确认（docs/design/PROVENANCE.md 第 5 节）
const provUi = initProvenanceUi({ api, view: () => session?.editor?.view ?? null, docId: () => session?.docId ?? null, notice: (m, e) => showNotice(m, e) })
void provUi.loadPrefs()
const datasets = initDatasets(api, (m, e) => showNotice(m, e), {
  showPage: (cls, title) => showPage(cls, title),
  openStudy: id => void researchUi.open(id),
  openStudio: id => void researchUi.openStudio(id),
})
let ME: Me | null = null
const patientsUi = initPatients(api, (m, e) => showNotice(m, e), {
  leaveDoc: () => leaveDoc(),
  openDoc: id => open(id),
  prefillChat: text => prefillChat(text),
  goSpace: space => spaces.set(space),
  tenantId: () => ME?.tenant?.id ?? null,
  token: () => TOKEN,
  dicom: () => ME?.features?.dicom === true,
  openStudy: id => researchUi.open(id),
})
/** 把建议的指令填进对话框（不发送，由人改好再发） */
function prefillChat(text: string): void {
  switchTab('chatPane')
  const input = $<HTMLTextAreaElement>('chatInput')
  input.value = text
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}
const researchUi = initResearch(api, (m, e) => showNotice(m, e), {
  openDoc: id => open(id),
  leaveDoc: () => leaveDoc(),
  prefillChat: text => prefillChat(text),
  goSpace: space => spaces.set(space),
  token: () => TOKEN,
  datasets: { upload: files => datasets.upload(files), openDetail: id => { researchUi.leave(); return datasets.openDetail(id) }, showProvenance: id => datasets.showProvenance(id) },
  openPatient: id => patientsUi.open(id),
  insertFigureToDoc: async (assetId, caption) => {
    if (await insertFigureIntoActiveSession(assetId, caption)) return
    await loadDocs()
    if (docRows.length === 0) {
      spaces.set('write')
      const d = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: `${caption} · 论文初稿` }) })
      await loadDocs()
      await open(d.id)
      await insertFigureIntoActiveSession(assetId, caption)
      return
    }
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card small" role="dialog" aria-modal="true" aria-label="插入图表到文稿">
      <div class="dialog-head"><h2>插入图表到写作空间</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="insertFigDocForm">
        <div class="muted small">已将图表「${esc(caption)}」及底层可复现源码归档。请选择要插入的目标文稿或新建论文：</div>
        <label>目标文稿
          <select name="doc_id">
            <option value="__new_doc__">＋ 新建空白论文并插入此图</option>
            ${docRows.map(d => `<option value="${esc(d.id)}">${esc(d.title)}${d.kind === 'deck' ? '（幻灯片）' : ''}</option>`).join('')}
          </select>
        </label>
        <div class="row end">
          <button type="button" data-close>取消</button>
          <button type="submit" class="primary">打开文稿并插入图表</button>
        </div>
      </form>
    </div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
    const form = dlg.querySelector<HTMLFormElement>('#insertFigDocForm')!
    form.onsubmit = async e => {
      e.preventDefault()
      const targetId = String(new FormData(form).get('doc_id') || '__new_doc__')
      dlg.hidden = true; dlg.innerHTML = ''
      spaces.set('write')
      if (targetId === '__new_doc__') {
        const d = await api('/api/docs', { method: 'POST', body: JSON.stringify({ title: `${caption} · 论文初稿` }) })
        await loadDocs()
        await open(d.id)
      } else {
        await open(targetId)
      }
      await insertFigureIntoActiveSession(assetId, caption)
    }
  },
})

const calendarUi = initCalendar(api, (m, e) => showNotice(m, e), {
  leaveDoc: () => leaveDoc(),
  openPatient: async code => {
    try {
      const list = await api<any[]>('/api/patients')
      const target = list.find(p => p.code === code || p.id === code)
      if (target) await patientsUi.open(target.id)
      else showNotice(`未找到患者 ${code}`, true)
    } catch {
      showNotice(`无法打开患者 ${code}`, true)
    }
  },
  openStudy: async idOrTitle => {
    try {
      const list = await api<any[]>('/api/studies')
      const target = list.find(s => s.id === idOrTitle || s.title?.includes(idOrTitle))
      if (target) await researchUi.open(target.id)
      else await researchUi.open(idOrTitle)
    } catch {
      await researchUi.open(idOrTitle)
    }
  },
  openMail: async () => {
    spaces.set('mail')
  },
})

const mailUi = initMail(api, (m, e) => showNotice(m, e), {
  leaveDoc: () => leaveDoc(),
  openPatient: async code => {
    try {
      const list = await api<any[]>('/api/patients')
      const target = list.find(p => p.code === code || p.id === code)
      if (target) await patientsUi.open(target.id)
      else showNotice(`未找到患者 ${code}`, true)
    } catch {
      showNotice(`无法打开患者 ${code}`, true)
    }
  },
  openStudy: async idOrTitle => {
    try {
      const list = await api<any[]>('/api/studies')
      const target = list.find(s => s.id === idOrTitle || s.title?.includes(idOrTitle))
      if (target) await researchUi.open(target.id)
      else await researchUi.open(idOrTitle)
    } catch {
      await researchUi.open(idOrTitle)
    }
  },
  openCalendar: async () => {
    spaces.set('calendar')
  },
})

// 资料库页打开时，图标栏高亮「资料库」按钮而不是当前空间
new MutationObserver(() => {
  const lib = $('page').classList.contains('library-page')
  $('libraryBtn').classList.toggle('on', lib)
  document.querySelector('.rail')!.classList.toggle('on-page', lib)
  if (!lib) library.leave()
  if (!$('page').classList.contains('datasets-page')) datasets.leave()
}).observe($('page'), { attributes: true, attributeFilter: ['class'] })
// 左侧图标栏：患者 / 临床研究 / 写作 / 科研制图 / 日历 / 邮箱
const spaces = initSpaces({
  patients: {
    title: '患者', label: '患者', actions: 'ptActions', list: 'patientList', placeholder: '按代号、本机备注、标签筛选',
    enter: () => {
      researchUi.leave()
      calendarUi.leave()
      mailUi.leave()
      leaveDoc()
      return patientsUi.enter()
    }
  },
  research: {
    title: '临床研究', label: '研究项目', actions: 'rsActions', list: 'studyList', placeholder: '按研究名称筛选',
    enter: () => {
      patientsUi.leave()
      calendarUi.leave()
      mailUi.leave()
      leaveDoc()
      return researchUi.enter()
    }
  },
  write: {
    title: '写作', label: '文档', actions: 'docActions', list: 'docList', placeholder: '搜索文档（标题与正文）',
    enter: () => {
      patientsUi.leave()
      researchUi.leave()
      calendarUi.leave()
      mailUi.leave()
      const page = $('page')
      // 如果当前正开着文档（非患者页、非研究页、非制图页、非日历页、非邮箱页），保留当前文档
      if (session && !page.classList.contains('patient-page') && !page.classList.contains('study-page') && !page.classList.contains('studio-page') && !page.classList.contains('calendar-page') && !page.classList.contains('mail-page') && !page.classList.contains('welcome-page')) {
        return
      }
      leaveDoc()
      showWelcome()
    }
  },
  studio: {
    title: '科研制图', label: '图表库', actions: 'studioActions', list: 'studioList', placeholder: '按图表名称筛选',
    enter: () => {
      patientsUi.leave()
      researchUi.leave()
      calendarUi.leave()
      mailUi.leave()
      leaveDoc()
      return researchUi.enterStudio()
    }
  },
  calendar: {
    title: '日历', label: '排期日程', actions: 'calActions', list: 'calList', placeholder: '按标题、患者代号、课题筛选',
    enter: () => {
      patientsUi.leave()
      researchUi.leave()
      mailUi.leave()
      leaveDoc()
      return calendarUi.enter()
    }
  },
  mail: {
    title: '邮箱', label: '近48小时动态摘要', actions: 'mailActions', list: 'mailList', placeholder: '按主题、发件人、患者代号筛选',
    enter: () => {
      patientsUi.leave()
      researchUi.leave()
      calendarUi.leave()
      leaveDoc()
      return mailUi.enter()
    }
  },
})

async function openTrash(): Promise<void> {
  const rows = await api<any[]>('/api/trash')
  const dlg = $('dialog')
  const render = (list: any[]) => {
    dlg.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="回收站">
      <div class="dialog-head"><h2>回收站</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <div class="dialog-body">${list.length === 0 ? '<div class="muted">回收站是空的</div>' : `<div class="muted">删除的文档保留 30 天，之后自动彻底删除。</div>
        <table class="users"><tbody>${list.map(d => `<tr data-id="${d.id}"><td>${d.kind === 'deck' ? ICON_DECK : ICON_DOC} ${esc(d.title)}</td><td class="muted">删除于 ${new Date(d.deleted_at).toLocaleString('zh-CN', { hour12: false })}</td>
          <td class="actions"><div class="actions-row"><button data-restore>恢复</button><button data-purge class="danger">彻底删除</button></div></td></tr>`).join('')}</tbody></table>`}</div></div>`
  }
  render(rows)
  dlg.hidden = false
  dlg.onclick = async e => {
    const t = e.target as HTMLElement
    if (t === dlg || t.closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = ''; return }
    const id = (t.closest('tr[data-id]') as HTMLElement | null)?.dataset.id
    if (!id) return
    if (t.closest('[data-restore]')) {
      await api(`/api/docs/${id}/restore`, { method: 'POST' })
      showNotice('已恢复')
    } else if (t.closest('[data-purge]')) {
      dlg.hidden = true
      const ok = await askConfirm({ title: '彻底删除', message: '彻底删除后无法恢复，包括版本历史与评论。', confirm: '彻底删除', danger: true })
      if (ok) await api(`/api/docs/${id}/purge`, { method: 'DELETE' })
      void openTrash()
      await loadDocs()
      return
    }
    render(await api<any[]>('/api/trash'))
    await loadDocs()
  }
}

// 新建：直接建一份「未命名」并打开，标题进入编辑状态（不弹窗问标题）
async function createDoc(kind: 'doc' | 'deck', renameNow = true): Promise<void> {
  // 新文档放进当前打开文档所在的项目
  const project_id = docRows.find(x => x.id === session?.docId)?.project_id ?? null
  // 新建幻灯片先选模板（与 AI 的 doc_create template 同一套）
  const template = kind === 'deck' ? await pickTemplate(api, { title: '新建幻灯片：选一个模板' }) : null
  if (kind === 'deck' && !template) return
  const d = await api('/api/docs', { method: 'POST', body: JSON.stringify(kind === 'deck' ? { title: '未命名汇报', kind, project_id, template } : { title: '未命名文档', project_id }) })
  await loadDocs()
  await open(d.id)
  switchTab('chatPane')
  if (renameNow) editTitle()
}
$('newDoc').onclick = () => void createDoc('doc')
$('newDeck').onclick = () => void createDoc('deck')

let isUploading = false
async function uploadFileWithProgress(file: File): Promise<any> {
  if (isUploading) return
  isUploading = true
  const btn = $('uploadBtn') as HTMLButtonElement | null
  if (btn) btn.disabled = true

  const modal = $('uploadProgressModal')
  const nameEl = $('uploadProgressFileName')
  const percentEl = $('uploadProgressPercent')
  const barEl = $('uploadProgressBar')
  const statusEl = $('uploadProgressStatus')

  if (modal && nameEl && percentEl && barEl && statusEl) {
    nameEl.textContent = `正在导入: ${file.name}`
    percentEl.textContent = '0%'
    barEl.style.width = '0%'
    statusEl.textContent = '正在传输文件，请勿重复操作...'
    modal.hidden = false
  }

  const fd = new FormData()
  fd.append('file', file)

  try {
    const d = await new Promise<any>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/docs')
      if (TOKEN) xhr.setRequestHeader('Authorization', `Bearer ${TOKEN}`)

      xhr.upload.onprogress = ev => {
        if (ev.lengthComputable) {
          const pct = Math.round((ev.loaded / ev.total) * 100)
          if (percentEl) percentEl.textContent = `${pct}%`
          if (barEl) barEl.style.width = `${pct}%`
          if (statusEl && pct >= 100) statusEl.textContent = '文件传输完成，正在解析文档结构...'
        }
      }
      xhr.onload = () => {
        if (xhr.status === 401) {
          if (TOKEN) signOut()
          reject(new Error('请先登录'))
          return
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)) }
          catch { resolve({}) }
        } else {
          try {
            const err = JSON.parse(xhr.responseText)
            reject(new Error(err.error || err.message || `上传失败 (HTTP ${xhr.status})`))
          } catch {
            reject(new Error(`上传失败 (HTTP ${xhr.status})`))
          }
        }
      }
      xhr.onerror = () => reject(new Error('网络请求异常'))
      xhr.onabort = () => reject(new Error('上传已取消'))
      xhr.send(fd)
    })
    return d
  } finally {
    isUploading = false
    if (btn) btn.disabled = false
    if (modal) modal.hidden = true
  }
}

$('uploadBtn').onclick = () => {
  if (isUploading) return
  $('uploadInput').click()
}
$<HTMLInputElement>('uploadInput').onchange = async e => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const d = await uploadFileWithProgress(file)
    await loadDocs()
    await open(d.id)
    const summary = d.kind === 'deck'
      ? `已成功导入为演示文稿幻灯片（《${d.title}》）`
      : `已成功导入结构化文档（《${d.title}》）`
    showNotice(summary)
    if (d.warnings?.length) showNotice(`导入提示：${d.warnings.join('；')}`)
  } catch (err) {
    showNotice(`导入失败：${(err as Error).message}`, true)
  }
  input.value = ''
}

// 支持将文档或演示文稿直接拖拽至窗口上传
window.addEventListener('dragover', e => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault()
  }
})

window.addEventListener('drop', async e => {
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  if (!/\.(pdf|docx|pptx)$/i.test(file.name)) return
  e.preventDefault()
  if (isUploading) return
  try {
    const d = await uploadFileWithProgress(file)
    await loadDocs()
    await open(d.id)
    const summary = d.kind === 'deck'
      ? `已成功导入为演示文稿幻灯片（《${d.title}》）`
      : `已成功导入结构化文档（《${d.title}》）`
    showNotice(summary)
    if (d.warnings?.length) showNotice(`导入提示：${d.warnings.join('；')}`)
  } catch (err) {
    showNotice(`导入失败：${(err as Error).message}`, true)
  }
})

// —— 打开文档：Yjs 同步 + 编辑器 + 文档事件流 ——

/** 没打开文档时的欢迎页：新建 / 上传，加几条示例指令。 */
function showWelcome(): void {
  $('page').className = 'page welcome-page'
  $('page').replaceChildren(($('welcomeTpl') as HTMLTemplateElement).content.cloneNode(true))
  $('page').insertAdjacentHTML('beforeend', photoFigure('write'))
}

$('page').addEventListener('click', async e => {
  const t = (e.target as HTMLElement).closest('[data-start], [data-example], [data-guide-action], [data-guide-topic]') as HTMLElement | null
  if (!t) return
  if (t.dataset.guideAction === 'open') {
    openHelpGuide()
    return
  }
  if (t.dataset.guideAction === 'import') {
    await importHelpAsDoc(api, loadDocs, open, (msg, err) => showNotice(msg, err))
    return
  }
  if (t.dataset.guideTopic) {
    openHelpGuide(t.dataset.guideTopic)
    return
  }
  if (session) return
  if (t.dataset.start === 'upload') { $('uploadInput').click(); return }
  if (t.dataset.start === 'studio') { void researchUi.openStudio(); return }
  if (t.dataset.start === 'study') { spaces.set('research'); return }
  if (t.dataset.start) { await createDoc(t.dataset.start as 'doc' | 'deck'); return }
  // 示例：新建对应的文档，把指令填进对话框（由用户确认后发送）
  await createDoc(t.dataset.example as 'doc' | 'deck', false)
  switchTab('chatPane')
  const input = $<HTMLTextAreaElement>('chatInput')
  input.value = t.dataset.prompt ?? ''
  input.focus()
})

/**
 * 资料库、数据集这类工作区页面：离开患者页 / 研究页，没在这个页面上时先关掉文档，返回页面元素。
 * 资料库页高亮左侧图标栏的「资料库」（见 watchRail）。
 */
function showPage(cls: string, title: string): HTMLElement {
  patientsUi.leave()
  researchUi.leave()
  if (!$('page').classList.contains(cls)) leaveDoc()
  const page = $('page')
  page.className = `page ${cls}`
  $('docTitle').textContent = title
  return page
}

/** 离开文档（打开患者页时）：关掉编辑器，清空中间区域与对话。 */
function leaveDoc(): void {
  openSeq++
  // 没打开文档：AI 栏收起（对话要基于一份文档），顶栏不显示导出与同步状态
  $('app').classList.add('no-doc')
  close()
  hideTurnBanner()
  $('suggestBanner').hidden = true
  provUi.hide()
  const csb = document.getElementById('chatSuggestBanner')
  if (csb) csb.hidden = true
  const tocPanel = document.getElementById('docOutlinePanel')
  if (tocPanel) tocPanel.hidden = true
  const bSep = document.getElementById('docBreadcrumbSep')
  if (bSep) bSep.hidden = true
  const sibWrap = document.getElementById('docSiblingWrap')
  if (sibWrap) sibWrap.hidden = true
  if (TOKEN && ME?.id) {
    const cpBtn = document.getElementById('btnCopilotToggle')
    if (cpBtn) cpBtn.hidden = false
  }
  turnUi = null
  $('chatLog').innerHTML = ''
  $('page').className = 'page'
  $('page').innerHTML = ''
  $('toolbar').hidden = true
  $('deckToolbar').hidden = true
  $('docTitle').textContent = ''
  $('docContext').hidden = true
  $('docCollab').hidden = true
  $('page').classList.remove('read-only')
  docPatient = null
  setSyncStatus('offline')
  $('syncStatus').textContent = ''
  for (const b of ['exportBtn', 'sendBtn']) $<HTMLButtonElement>(b).disabled = true
  void loadDocs()
}

/** 当前文档所属的患者（病例报告等）；对话时自动带上。 */
let docPatient: string | null = null

/** 当前文档事件流收到 hello 的次数（大于 1 说明是断线重连）。 */
let streamHellos = 0

/** 事件流最后一次收到消息（含服务端每 25 秒的 ping）的时间；太久没收到说明连接已半开，需要重建。 */
let streamSeenAt = 0
const STREAM_STALE_MS = 70_000

function openStream(docId: string): EventSource {
  streamSeenAt = Date.now()
  const stream = new EventSource(`/api/docs/${docId}/stream?token=${encodeURIComponent(TOKEN)}`)
  stream.onmessage = e => { streamSeenAt = Date.now(); onStreamEvent(JSON.parse(e.data)) }
  stream.addEventListener('ping', () => { streamSeenAt = Date.now() })
  return stream
}

/** 事件流太久没动静（休眠唤醒、代理静默断开）：重建连接；hello 到达后会重新拉取文档状态。 */
function reviveStream(): void {
  if (!session || Date.now() - streamSeenAt < STREAM_STALE_MS) return
  session.stream.close()
  session.stream = openStream(session.docId)
}
setInterval(reviveStream, 15_000)

// 回到页面（切回标签页、唤醒）：补齐离开期间的修订与对话，不需要用户手动刷新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !session) return
  reviveStream()
  session.provider?.resync()
  scheduleRefresh()
})

/** 单调递增打开序号（防止并发 open(docId) 导致旧连接泄漏）。 */
let openSeq = 0

async function open(docId: string): Promise<void> {
  const seq = ++openSeq
  streamHellos = 0
  $('app').classList.remove('no-doc')
  // 写作视图下统一使用右侧栏「AI 助手」，自动收起右下角悬浮球避免双 AI 入口重叠与遮挡
  const cpBtn = document.getElementById('btnCopilotToggle')
  if (cpBtn) cpBtn.hidden = true
  document.getElementById('copilotDrawer')?.classList.add('hidden')
  refImportHtml = ''
  patientsUi.leave()
  researchUi.leave()
  close()
  openAiDrawer(false)
  selectedCommentIds.clear()
  commentNavCursor = -1
  pendingAnchor = null
  anchor = null
  $('newComment').hidden = true
  $('newCommentQuote').textContent = ''
  $<HTMLTextAreaElement>('newCommentText').value = ''
  $('commentFab').style.display = 'none'
  lastReviewSnapshot = loadReviewSnapshot(docId)
  hideTurnBanner()
  turnUi = null
  $('chatLog').innerHTML = ''
  renderSubagentWelcome()
  $('page').innerHTML = ''
  $('page').className = 'page'
  const meta = await api(`/api/docs/${docId}`)
  if (seq !== openSeq) return
  close()
  const stream = openStream(docId)
  const onCommentClick = (thread: string) => {
    switchTab('commentPane')
    const card = document.querySelector<HTMLElement>(`#comments [data-cid="${CSS.escape(thread)}"]`)
    document.querySelectorAll('#comments .card.card-active-focus').forEach(el => el.classList.remove('card-active-focus'))
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    card?.classList.add('card-highlight', 'card-active-focus')
    setTimeout(() => card?.classList.remove('card-highlight'), 1600)
    locateCommentInDoc(thread)
  }
  if (meta.kind === 'deck') {
    const deck = new DeckView($('page'), {
      docId, token: TOKEN, onCommentClick, onSelection: a => { anchor = a; placeFab() },
      onEdit: (ops, baseRev) => deckEdit(docId, ops, baseRev),
      onSelectShape: () => syncDeckToolbar(),
      onNotice: msg => showNotice(msg),
      onEditChart: (shapeId, chart) => void editChart(deck, shapeId, chart),
    })
    session = { docId, kind: 'deck', stream, deck }
    $('page').classList.add('deck')
    setSyncStatus('synced')
    await deck.load()
    if (seq !== openSeq) return
  } else {
    const ydoc = new Y.Doc()
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const provider = new Provider(`${proto}://${location.host}/collab/${docId}?token=${encodeURIComponent(TOKEN)}`, ydoc, setSyncStatus)
    const editor = new Editor($('page'), ydoc.getXmlFragment('body'), {
      readOnly: meta.my_role === 'viewer',
      assetUrl: id => `/api/assets/${id}?token=${encodeURIComponent(TOKEN)}`,
      uploadImage: async file => {
        const fd = new FormData()
        fd.append('file', file)
        try {
          return (await api(`/api/docs/${docId}/assets`, { method: 'POST', body: fd })).asset_id as string
        } catch (err) {
          showNotice(`图片上传失败：${(err as Error).message}`, true)
          throw err
        }
      },
      onCommentClick,
      onClaimClick: claimId => {
        switchTab('commentPane')
        const check = (detail?.claim_checks ?? []).find((c: any) => c.claim_id === claimId)
        const targetId = check?.comment_id ?? claimId
        const card = document.querySelector<HTMLElement>(`#comments [data-cid="${CSS.escape(targetId)}"]`)
        document.querySelectorAll('#comments .card.card-active-focus').forEach(el => el.classList.remove('card-active-focus'))
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        card?.classList.add('card-highlight', 'card-active-focus')
        setTimeout(() => card?.classList.remove('card-highlight'), 1600)
        locateCommentInDoc(targetId)
      },
      onCitationClick: citeId => {
        focusCitationCardInPanel(citeId)
      },
      onDocChange: () => {
        renderDocOutline()
        provUi.render()
      },
      analysis: { has: id => datasets.hasProvenance(id), show: id => void datasets.showProvenance(id) },
      onSuggestion: (group, accept) => void resolveSuggestion(group, accept),
      onSelection: a => { anchor = a; placeFab(); syncToolbar() },
    })
    session = { docId, kind: 'doc', stream, ydoc, provider, editor }
    provUi.render()
    $('page').classList.remove('deck')
  }
  const ctx = (() => { try { return meta.context ? JSON.parse(meta.context) : null } catch { return null } })()
  docPatient = ctx?.kind === 'patient' ? ctx.patient_id : null
  renderDocContextBreadcrumb(ctx, meta)
  renderChatQuickChips(ctx, meta)
  // 研究共享文档：顶栏显示协作者；只读成员不显示编辑工具条
  const readOnly = meta.my_role === 'viewer'
  renderCollaborators(meta.collaborators ?? [], readOnly)
  $('page').classList.toggle('read-only', readOnly)
  $('toolbar').hidden = meta.kind === 'deck' || readOnly
  $('deckToolbar').hidden = meta.kind !== 'deck' || readOnly
  if (meta.kind === 'deck') void initDeckToolbar()
  $('exportDocxBtn').hidden = meta.kind === 'deck'
  $('exportDocxCleanBtn').hidden = meta.kind === 'deck'
  $('aiDisclosureBtn').hidden = meta.kind === 'deck'
  $('provProofBtn').hidden = meta.kind === 'deck'
  $('exportMdBtn').hidden = meta.kind === 'deck'
  $('exportPptxBtn').hidden = meta.kind !== 'deck'
  // 患者文档（所见草稿、病例报告）：可复制为 RIS 纯文本
  $('risCopyBtn').hidden = meta.kind === 'deck' || ctx?.kind !== 'patient'
  for (const b of ['exportBtn', 'sendBtn']) $<HTMLButtonElement>(b).disabled = false
  await loadDocs()
  if (seq !== openSeq) return
  await refresh(true)
}

/**
 * 顶栏课题 / 患者面包屑导航与同课题关联文稿一键切换器（Batch 4）：
 * 显示「← 临床研究 / 课题名」+「[当前文稿类型 ▾]」，点击下拉即可一键切换到同课题/同患者的其他方案、论文、幻灯片或图表工作台。
 */
function renderDocContextBreadcrumb(ctx: any, meta: any): void {
  const ctxBtn = $('docContext')
  const sepEl = document.getElementById('docBreadcrumbSep')
  const sibWrap = document.getElementById('docSiblingWrap')
  const sibBtn = document.getElementById('docSiblingBtn')
  const sibLabel = document.getElementById('docSiblingLabel')
  const sibMenu = document.getElementById('docSiblingMenu')

  const isPatient = ctx?.kind === 'patient'
  const isStudy = ctx?.kind === 'study'
  ctxBtn.hidden = !isPatient && !isStudy
  if (sepEl) sepEl.hidden = !isPatient && !isStudy
  if (sibWrap) sibWrap.hidden = !isPatient && !isStudy
  if (sibMenu) sibMenu.hidden = true

  if (!isPatient && !isStudy) return

  const patientRoleMap: Record<string, string> = {
    case_report: '病例报告',
    followup: '随访小结',
    discussion: '病例讨论',
    findings: '影像所见草稿',
  }
  const studyRoleMap: Record<string, string> = {
    protocol: '研究方案',
    manuscript: '论文主稿',
    slides: '学术幻灯片',
  }

  if (isPatient) {
    const roleLabel = patientRoleMap[ctx.doc_kind] ?? '患者文稿'
    ctxBtn.textContent = `← 患者 · ${ctx.code}`
    ctxBtn.title = `回到患者 ${ctx.code} 档案主页`
    ctxBtn.onclick = () => void patientsUi.open(ctx.patient_id)
    if (sibLabel) sibLabel.textContent = roleLabel
  } else if (isStudy) {
    const roleLabel = studyRoleMap[ctx.role] ?? '研究文稿'
    ctxBtn.textContent = `← 课题 · ${ctx.title}`
    ctxBtn.title = `回到临床研究《${ctx.title}》主页`
    ctxBtn.onclick = () => void researchUi.open(ctx.study_id)
    if (sibLabel) sibLabel.textContent = roleLabel
  }

  if (sibBtn && sibMenu) {
    sibBtn.onclick = async e => {
      e.stopPropagation()
      sibMenu.hidden = !sibMenu.hidden
      if (sibMenu.hidden) return
      const siblingDocs = docRows.filter(d => {
        if (!d.context) return false
        try {
          const c = typeof d.context === 'object' ? d.context : JSON.parse(d.context)
          if (isStudy) return c?.kind === 'study' && c?.study_id === ctx.study_id
          if (isPatient) return c?.kind === 'patient' && c?.patient_id === ctx.patient_id
          return false
        } catch {
          return false
        }
      })
      const itemsHtml = siblingDocs.map(d => {
        let tag = d.kind === 'deck' ? '幻灯片' : '文稿'
        try {
          const c = typeof d.context === 'object' ? d.context : JSON.parse(d.context)
          tag = (isStudy ? studyRoleMap[c?.role] : patientRoleMap[c?.doc_kind]) || tag
        } catch {}
        const isCurrent = d.id === meta.id
        return `<button type="button" role="menuitem" class="${isCurrent ? 'active' : ''}" data-sib-doc="${esc(d.id)}">
          <span>${isCurrent ? '● ' : ''}${esc(d.title)}</span>
          <span class="muted">${esc(tag)}</span>
        </button>`
      }).join('')
      const hubActionHtml = isStudy
        ? `<div class="doc-sibling-sep"></div>
           <button type="button" role="menuitem" data-sib-hub="study">前往课题总览与数据集 ↗</button>
           <button type="button" role="menuitem" data-sib-hub="studio">前往课题科研制图工作台 ↗</button>`
        : `<div class="doc-sibling-sep"></div>
           <button type="button" role="menuitem" data-sib-hub="patient">前往患者档案与 3D 影像中心 ↗</button>`
      sibMenu.innerHTML = (itemsHtml || `<div class="muted small" style="padding:6px 10px;">当前仅此一篇关联文稿</div>`) + hubActionHtml
      placeFixedPopup(sibMenu, sibBtn.getBoundingClientRect(), false)
    }

    sibMenu.onclick = e => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button')
      if (!btn) return
      sibMenu.hidden = true
      if (btn.dataset.sibDoc && btn.dataset.sibDoc !== session?.docId) {
        void open(btn.dataset.sibDoc)
        return
      }
      if (btn.dataset.sibHub === 'study' && isStudy) {
        void researchUi.open(ctx.study_id)
      } else if (btn.dataset.sibHub === 'studio' && isStudy) {
        void researchUi.openStudio(ctx.study_id)
      } else if (btn.dataset.sibHub === 'patient' && isPatient) {
        void patientsUi.open(ctx.patient_id)
      }
    }
  }
}

document.addEventListener('click', e => {
  const sibMenu = document.getElementById('docSiblingMenu')
  if (sibMenu && !sibMenu.hidden && !(e.target as HTMLElement).closest('#docSiblingWrap')) {
    sibMenu.hidden = true
  }
})

/**
 * 右侧栏「AI 助手」快捷指令胶囊（Batch 2）：
 * 将原先悬浮 Co-Pilot 的场景化快捷提示收敛至文档「AI 助手」输入框上方，实现单入口无缝体验。
 */
function renderChatQuickChips(ctx: any, meta: any): void {
  const box = document.getElementById('chatQuickChips')
  if (!box) return
  let chips: Array<{ icon: IconName; label: string; prompt: string }> = []
  if (meta.kind === 'deck') {
    chips = [
      { icon: 'sparkles', label: '优化当页排版与要点精炼', prompt: '请精炼当前幻灯片页面的文字要点，使其符合学术答辩汇报规范，并检查版面布局。' },
      { icon: 'chart', label: '补充关键结果数据页', prompt: '请根据文稿核心结论在当前页后新增一页结构化结果汇总幻灯片。' },
      { icon: 'book', label: '补充参考文献尾页', prompt: '请整理当前汇报涉及的核心文献，在末尾生成规范的参考文献页。' },
    ]
  } else if (ctx?.kind === 'patient') {
    chips = [
      { icon: 'sparkles', label: '规范化病例报告润色', prompt: '请按期刊 Case Report 规范润色本文稿的病史、诊治经过与讨论段落（生成待采纳修订）。' },
      { icon: 'ruler', label: '核对影像病灶测量与 RECIST', prompt: '请核对文稿中的病灶尺寸、长短径及疗效评价是否前后一致。' },
      { icon: 'book', label: '检索同类罕见/靶向病例文献', prompt: '请检索 PubMed 中近 3 年同类靶向治疗或临床表现的权威文献并补充到讨论段。' },
    ]
  } else {
    chips = [
      { icon: 'sparkles', label: '学术润色与逻辑强化', prompt: '请对当前文稿进行医学学术润色，提升表述严谨性与可读性（以修订模式生成对比）。' },
      { icon: 'chart', label: '核对表文数据与统计指标', prompt: '请逐一核对正文描述的样本量、百分比、P 值与表格数据是否完全自洽。' },
      { icon: 'search', label: '检索 PubMed 补充最新引文', prompt: '请针对引言与讨论中的核心论断，检索近 3 年高影响因子临床文献并在相应位置插入规范引用。' },
      { icon: 'grid', label: '生成或完善 Table 1 三线表', prompt: '请根据文中基线特征描述，整理生成符合顶刊规范的 Table 1 基线特征三线表。' },
    ]
  }
  box.innerHTML = `<div class="chat-quick-chips-hint">快捷指令 · 点击填入输入框，不会自动发送</div>` + chips
    .map(c => `<button type="button" class="chat-quick-chip" data-chip-prompt="${esc(c.prompt)}" title="${esc(c.prompt)}">${icon(c.icon, { size: 12 })}<span>${esc(c.label)}</span></button>`)
    .join('')
}

document.getElementById('chatQuickChips')?.addEventListener('click', e => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-chip-prompt]')
  if (!btn?.dataset.chipPrompt) return
  const input = $<HTMLTextAreaElement>('chatInput')
  input.value = btn.dataset.chipPrompt
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
})

/**
 * 长文稿实时章节与图表目录（Batch 3）：
 * 自动提取 H1–H3 标题、表格与科研图片，联动显示每个章节下未处理的审稿批注数量，支持一键平滑跳转。
 */
let isOutlineCollapsed = false

function renderDocOutline(): void {
  const panel = document.getElementById('docOutlinePanel')
  const listEl = document.getElementById('docOutlineList')
  const metaEl = document.getElementById('docOutlineMeta')
  const toggleBtn = document.getElementById('docOutlineCollapseBtn')
  if (!panel || !listEl) return

  if (!session || session.kind !== 'doc' || !session.editor) {
    panel.hidden = true
    return
  }

  const items = session.editor.getDocOutline()
  if (items.length === 0) {
    panel.hidden = true
    return
  }

  panel.hidden = false
  listEl.hidden = isOutlineCollapsed
  if (toggleBtn) toggleBtn.textContent = isOutlineCollapsed ? '▸' : '▾'

  const openComments: any[] = (detail?.comments ?? []).filter((c: any) => c.status === 'open')
  const countByNodeId = new Map<string, { count: number; maxSev: 'critical' | 'major' | 'minor'; firstCid: string }>()
  const countByTitle = new Map<string, { count: number; maxSev: 'critical' | 'major' | 'minor'; firstCid: string }>()

  const bump = (
    map: Map<string, { count: number; maxSev: 'critical' | 'major' | 'minor'; firstCid: string }>,
    key: string,
    sev: 'critical' | 'major' | 'minor',
    cid: string,
  ) => {
    if (!key) return
    const prev = map.get(key)
    const rank = { critical: 3, major: 2, minor: 1 }
    if (!prev) {
      map.set(key, { count: 1, maxSev: sev, firstCid: cid })
    } else {
      prev.count++
      if (rank[sev] > rank[prev.maxSev]) prev.maxSev = sev
    }
  }

  for (const c of openComments) {
    const meta = parseReviewComment(c)
    const sev = meta.severity
    const directIds: string[] = [...(c.anchor?.node_ids ?? []), ...(c.node_id ? [c.node_id] : [])]
    let matchedDirect = false
    for (const nid of directIds) {
      if (items.some(it => it.id === nid && (it.kind === 'table' || it.kind === 'figure'))) {
        bump(countByNodeId, nid, sev, c.id)
        matchedDirect = true
        break
      }
    }
    if (matchedDirect) continue
    if (c.anchor?.section_node_id) {
      bump(countByNodeId, c.anchor.section_node_id, sev, c.id)
    } else if (c.anchor?.section_title) {
      bump(countByTitle, c.anchor.section_title.trim(), sev, c.id)
    }
  }

  const headingCount = items.filter(i => i.kind.startsWith('h')).length
  const mediaCount = items.filter(i => i.kind === 'table' || i.kind === 'figure').length
  if (metaEl) {
    metaEl.textContent = `${headingCount} 节${mediaCount > 0 ? ` · ${mediaCount} 图表` : ''}`
  }

  listEl.innerHTML = items
    .map(it => {
      const badgeInfo = countByNodeId.get(it.id) ?? (it.kind.startsWith('h') ? countByTitle.get(it.title.trim()) : undefined)
      const iconPrefix =
        it.kind === 'table' ? '⊞ ' : it.kind === 'figure' ? '◫ ' : it.kind === 'h1' ? '§ ' : ''
      const badgeHtml = badgeInfo
        ? `<span class="toc-badge sev-${esc(badgeInfo.maxSev)}" data-toc-cid="${esc(badgeInfo.firstCid)}" title="该章节/图表有 ${badgeInfo.count} 项待处理批注，点击直接定位批注">${badgeInfo.count}</span>`
        : it.suggest
          ? `<span class="toc-badge suggest" title="包含待采纳修订">修</span>`
          : ''
      return `<li class="toc-item toc-${esc(it.kind)}" data-toc-node="${esc(it.id)}" title="${esc(it.title)}">
        <span class="toc-label">${iconPrefix}${esc(it.title)}</span>
        ${badgeHtml}
      </li>`
    })
    .join('')
}

document.getElementById('docOutlineHead')?.addEventListener('click', () => {
  isOutlineCollapsed = !isOutlineCollapsed
  renderDocOutline()
})

document.getElementById('docOutlineList')?.addEventListener('click', e => {
  const badge = (e.target as HTMLElement).closest<HTMLElement>('[data-toc-cid]')
  if (badge?.dataset.tocCid) {
    e.stopPropagation()
    const cid = badge.dataset.tocCid
    switchTab('commentPane')
    const card = document.querySelector<HTMLElement>(`#comments [data-cid="${CSS.escape(cid)}"]`)
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    card?.classList.add('card-highlight')
    setTimeout(() => card?.classList.remove('card-highlight'), 1500)
    locateCommentInDoc(cid)
    return
  }
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-toc-node]')
  if (!li?.dataset.tocNode || !session?.editor) return
  document.querySelectorAll('#docOutlineList .toc-item.active').forEach(el => el.classList.remove('active'))
  li.classList.add('active')
  session.editor.scrollToSectionNode(li.dataset.tocNode)
})

/**
 * 点击正文中引用上标 [n] 时：自动展开右侧「引用」面板并滚动高亮对应文献卡片（Batch 5）。
 */
function focusCitationCardInPanel(citeId: string): void {
  if (!citeId) return
  switchTab('citePane')
  const card = document.querySelector<HTMLElement>(`#cites [data-cite-id="${CSS.escape(citeId)}"]`)
  document.querySelectorAll('#cites .card.card-active-focus').forEach(el => el.classList.remove('card-active-focus'))
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    card.classList.add('card-highlight', 'card-active-focus')
    setTimeout(() => card.classList.remove('card-highlight'), 1800)
  }
}

/** 顶栏的协作者（研究成员）：头像缩写 + 名字提示；我是只读成员时加一个「只读」标记 */
function renderCollaborators(list: Array<{ name: string; role: string }>, readOnly: boolean): void {
  const el = $('docCollab')
  el.hidden = list.length < 2 && !readOnly
  const ROLE: Record<string, string> = { owner: '负责人', editor: '可编辑', viewer: '只读' }
  el.innerHTML = list.slice(0, 5).map(m => `<span class="collab-avatar role-${esc(m.role)}" title="${esc(m.name)} · ${esc(ROLE[m.role] ?? '')}">${esc(m.name.slice(0, 1).toUpperCase())}</span>`).join('')
    + (list.length > 5 ? `<span class="collab-more">+${list.length - 5}</span>` : '')
    + (readOnly ? '<span class="pill off collab-ro" title="你在这个研究里是只读成员：能看、能评论，不能修改">只读</span>' : '')
}

// —— 原版 PDF 视图（PDF 导入的文档；只读，评论与审稿标注画在原版上，见 original.ts） ——

let origView: OriginalView | null = null
/** 已按默认打开过原版的文档（同一次打开里刷新详情时不再切回原版） */
let origAutoOpened: string | null = null
/** 原版视图加载完后要定位的评论 */
let pendingOrigFocus: string | null = null
/** 刚补生成过原版对照的文档（重开原版视图时不用缓存的映射） */
let origMapRebuilt: string | null = null

function setOriginalMode(on: boolean): void {
  if (!session || session.kind !== 'doc' || !detail?.original) on = false
  $('origToggle').classList.toggle('active', on)
  $('origToggle').textContent = on ? '转换稿' : '原版 PDF'
  $('origToggle').title = on ? '回到可编辑的转换稿' : '按原样查看导入的 PDF（只读），评论与审稿标注显示在原文位置'
  $('scroller').hidden = on
  $('toolbar').classList.toggle('orig-hidden', on)
  anchor = null
  $('commentFab').style.display = 'none'
  if (!on) { origView?.el.setAttribute('hidden', ''); return }
  if (!origView) {
    const docId = session!.docId
    origView = new OriginalView({
      docId,
      fetchBytes: async path => {
        const res = await fetch(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.arrayBuffer()
      },
      fetchJson: path => api(path),
      currentDoc: () => session?.editor?.view.state.doc ?? null,
      onSelection: a => { anchor = a; placeFab() },
      onCommentClick: id => {
        if ($('app').classList.contains('side-collapsed')) setSideCollapsed(false)
        switchTab('commentPane')
        locateCommentInDoc(id)
      },
      freshMap: origMapRebuilt === docId,
      ...(detail.original.mapped ? {} : {
        // 没有原版对照（早期导入 / 当时退回兜底解析）：重新解析原文件补生成，生成后重开原版视图
        onRebuildMap: async () => {
          try {
            const r = await api<{ matched: number; total: number }>(`/api/docs/${docId}/source-map/rebuild`, { method: 'POST' })
            showNotice(`已生成原版对照（对上 ${r.matched} / ${r.total} 处）`)
            origMapRebuilt = docId
          } catch (err) {
            showNotice(`生成原版对照失败：${(err as Error).message}`, true)
          }
          closeOriginal()
          await refresh(true)
          setOriginalMode(true)
        },
      }),
    })
    $('scroller').after(origView.el)
    void origView.load(!!detail.original.mapped).then(() => {
      origView?.setComments(detail?.comments ?? [])
      // 从评论卡片的「第 N 页」打开时：加载完再定位
      const focus = pendingOrigFocus
      pendingOrigFocus = null
      if (focus) setTimeout(() => locateCommentInDoc(focus), 200)
    })
  }
  origView.el.removeAttribute('hidden')
}

function closeOriginal(): void {
  origView?.destroy()
  origView = null
  $('scroller').hidden = false
  $('toolbar').classList.remove('orig-hidden')
  $('origToggle').classList.remove('active')
  $('origToggle').textContent = '原版 PDF'
}

function close(): void {
  closeOriginal()
  origAutoOpened = null
  activeSubagentTask = null
  subagentCards.clear()
  clearAllChatImages()
  callLabels.clear()
  turnChanges.clear()
  if (!session) return
  session.stream.close()
  session.editor?.destroy()
  session.provider?.destroy()
  session.ydoc?.destroy()
  session.deck?.destroy()
  session = null
}

function setSyncStatus(s: ProviderStatus): void {
  const el = $('syncStatus')
  el.textContent = s === 'synced' ? '已同步' : s === 'connecting' ? '连接中…' : '离线（恢复后自动同步）'
  el.className = `status ${s}`
}

function onStreamEvent(e: any): void {
  if (!session) return
  if (e.type === 'hello') {
    setBusy(Boolean(e.busy))
    // 断线重连（服务重启、网络抖动）：断线期间这一轮已经结束了，界面却还停在「进行中」——重新拉取对话，显示真实结果与重试按钮
    if (streamHellos++ > 0) {
      // 断线期间可能错过了 AI 的提交：补拉正文与修订列表
      session.provider?.resync()
      if (!e.busy && turnUi) { turnUi = null; void refresh(true) } else scheduleRefresh()
    }
    return
  }
  if (e.type === 'commit') {
    const ids = e.changes.filter((c: any) => c.kind !== 'removed').map((c: any) => c.node_id)
    if (e.actor === 'ai' && e.turn_id) {
      const c = turnChanges.get(e.turn_id) ?? { ids: new Set<string>(), count: 0 }
      for (const id of ids) c.ids.add(id)
      c.count += e.changes.length
      turnChanges.set(e.turn_id, c)
    }
    if (session.deck) void session.deck.load().then(() => { if (e.actor === 'ai') session?.deck?.flash(ids) })
    else if (e.actor === 'ai') session.editor?.flash(ids)
    // 服务端的提交（AI 写入、采纳/拒绝修订）：主动向协同服务补拉一次，正文不依赖那条可能已半开的连接
    session.provider?.resync()
    scheduleRefresh()
    return
  }
  if (e.type === 'notice') { showNotice(e.message); return }
  if (e.type === 'turn_event') renderTurnEvent(e.event)
}

function scheduleRefresh(): void {
  clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => void refresh(false), 400)
}

async function refresh(full: boolean): Promise<void> {
  if (!session) return
  const d = await api(`/api/docs/${session.docId}`)
  detail = d
  $('docTitle').textContent = d.title
  if (full) {
    setBusy(d.busy)
    if (!turnUi) {
      $('chatLog').innerHTML = ''
      renderSubagentWelcome()
    }
    const failed = new Map<string, { status: string; error: string | null }>((d.failed_turns ?? []).map((t: any) => [t.id, t]))
    for (const m of d.messages) {
      if (m.turn_id && $('chatLog').querySelector(`.msg.${CSS.escape(m.role)}[data-turn-id="${CSS.escape(m.turn_id)}"]`)) {
        continue
      }
      addMsg(m.role, displayMessage(m.text), m.role === 'assistant' && d.revertable.includes(m.turn_id) ? m.turn_id : null, m.turn_id ?? null)
      // 没正常完成的回合：在该轮用户消息后标出原因（刷新页面后也看得到）
      const f = m.role === 'user' && m.turn_id ? failed.get(m.turn_id) : undefined
      if (f) {
        addStep(`${TURN_STATUS[f.status] ?? f.status}${f.error ? `：${friendlyError(f.error)}` : ''}`, 'err', f.error ?? '')
        addRetry(m.turn_id)
      }
    }
    if (d.busy && d.active_turn && !turnUi) {
      startTurnUi(d.active_turn.turn_id ?? null)
      const curUi = turnUi as { steps: HTMLDetailsElement } | null
      if (d.active_turn.last_step && curUi) {
        const sum = curUi.steps.querySelector('summary')
        if (sum) sum.textContent = d.active_turn.last_step
      }
      if (d.active_turn.subagent) {
        const sub = d.active_turn.subagent
        renderTurnEvent({
          type: 'subagent_start',
          id: sub.id,
          role: sub.role,
          role_label: sub.role_label,
          task: sub.task,
          doc_id: session.docId,
        })
        for (const s of sub.steps ?? []) {
          renderTurnEvent({
            type: 'subagent_step',
            id: sub.id,
            role: sub.role,
            step: s.step,
            status: s.status,
            doc_id: session.docId,
          })
        }
      }
    }
  }
  if (session?.editor && d.claim_checks) {
    session.editor.setClaimChecks(d.claim_checks)
  }
  if (session?.editor && d.citation_numbering) {
    session.editor.setCitationNumbering(d.citation_numbering)
  }
  // 测量原子：服务端按当前用户的权限取到的值（来源病灶改了测量后，重新拉取文档详情即更新）
  if (session?.editor && Array.isArray(d.measurements)) {
    session.editor.setMeasurements(d.measurements)
  }
  // 已关闭批注：锚点保留在正文里，但不再显示高亮 / 下划线
  if (Array.isArray(d.comments)) {
    if (session?.editor) session.editor.setCommentStatuses(d.comments)
    if (session?.deck) session.deck.setCommentStatuses(d.comments)
    origView?.setComments(d.comments)
  }
  $('origToggle').hidden = !(session?.kind === 'doc' && d.original)
  // 有原版映射的 PDF 稿：每次打开默认显示原版 + 审稿侧栏（§12；转换稿是编辑入口），之后的刷新不再切换
  if (session?.kind === 'doc' && d.original?.mapped && origAutoOpened !== session.docId) {
    origAutoOpened = session.docId
    setOriginalMode(true)
    if ($('app').classList.contains('side-collapsed')) setSideCollapsed(false)
    switchTab('commentPane')
  }
  renderComments()
  renderSuggestions()
  renderVersions()
  renderCites()
  renderDocOutline()
  syncRevertButtons()
  syncToolbar()
}

// 重命名：点标题直接改（回车保存，Esc 取消，失焦保存）
function editTitle(): void {
  const el = $('docTitle')
  if (!session || !detail || el.isContentEditable) return
  const before = detail.title as string
  el.contentEditable = 'plaintext-only'
  el.classList.add('editing')
  el.focus()
  getSelection()?.selectAllChildren(el)
  const finish = async (save: boolean) => {
    el.removeEventListener('keydown', onKey)
    el.removeEventListener('blur', onBlur)
    el.contentEditable = 'false'
    el.classList.remove('editing')
    const title = (el.textContent ?? '').trim()
    if (!save || !title || title === before || !session) { el.textContent = before; return }
    try {
      await api(`/api/docs/${session.docId}`, { method: 'PATCH', body: JSON.stringify({ title }) })
      await loadDocs()
      await refresh(false)
    } catch (err) {
      el.textContent = before
      showNotice((err as Error).message, true)
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); void finish(true) }
    if (e.key === 'Escape') { e.preventDefault(); void finish(false) }
  }
  const onBlur = () => void finish(true)
  el.addEventListener('keydown', onKey)
  el.addEventListener('blur', onBlur)
}
$('docTitle').onclick = () => editTitle()

// —— 幻灯片画布工具条（与 AI 的 deck_edit 同一套操作） ——

type DeckTheme = { label: string; bg: string; surface: string; title: string; body: string; muted: string; accent: string; accent2: string }
let deckThemes: Record<string, DeckTheme> = {}

let pendingDeckEdit: Promise<boolean> | null = null

async function deckEdit(docId: string, ops: Array<Record<string, unknown>>, baseRev: number): Promise<boolean> {
  const task = (async () => {
    try {
      await api(`/api/docs/${docId}/edit`, { method: 'POST', body: JSON.stringify({ base_rev: baseRev, ops }) })
      return true
    } catch (err) {
      showNotice((err as Error).message, true)
      return false
    }
  })()
  pendingDeckEdit = task
  try {
    return await task
  } finally {
    if (pendingDeckEdit === task) pendingDeckEdit = null
  }
}

async function initDeckToolbar(): Promise<void> {
  if (Object.keys(deckThemes).length === 0) deckThemes = await api('/api/deck-themes').catch(() => ({}))
  syncDeckToolbar()
}

function shapeFontFamily(shape: any): string {
  let font: string | null = null
  const walk = (n: any) => {
    if (font !== null) return
    if (n.type === 'text') {
      const xml = n.marks?.find((m: any) => m.type === 'rpr')?.attrs?.xml as string | undefined
      const m = xml && (/<a:latin typeface="([^"]+)"/.exec(xml)?.[1] ?? /<a:ea typeface="([^"]+)"/.exec(xml)?.[1])
      if (m) font = m
    }
    n.content?.forEach(walk)
  }
  walk(shape)
  return font ?? ''
}

function syncDeckToolbar(): void {
  const sel = session?.deck?.selection()
  for (const b of document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('#deckToolbar [data-needs-shape]')) b.disabled = !sel
  const isTable = sel?.shape.attrs?.kind === 'table'
  for (const b of document.querySelectorAll<HTMLButtonElement>('#deckToolbar [data-needs-table]')) b.hidden = !isTable
  const isChart = sel?.shape.attrs?.kind === 'chart' && !!sel.shape.attrs.chart
  for (const b of document.querySelectorAll<HTMLButtonElement>('#deckToolbar [data-needs-chart]')) b.hidden = !isChart
  const n = session?.deck?.selectionIds().length ?? 0
  for (const b of document.querySelectorAll<HTMLButtonElement>('#arrangeMenu [data-distribute]')) b.disabled = n < 3
  if (sel?.shape) {
    const boldBtn = document.querySelector<HTMLButtonElement>('#deckToolbar [data-dk="bold"]')
    if (boldBtn) boldBtn.classList.toggle('active', hasBold(sel.shape))
    const fontSel = document.querySelector<HTMLSelectElement>('#selDeckFontFamily')
    if (fontSel) {
      const f = shapeFontFamily(sel.shape)
      fontSel.value = Array.from(fontSel.options).some(o => o.value === f) ? f : ''
    }
    const szSel = document.querySelector<HTMLSelectElement>('#selDeckFontSize')
    if (szSel) {
      const sz = shapeFontSize(sel.shape)
      szSel.value = Array.from(szSel.options).some(o => o.value === String(sz)) ? String(sz) : ''
    }
  }
}

/** 颜色板：当前页主题的颜色（以主题记号提交，换主题时跟着变）+ 自定义颜色。 */
/** pickColor 的结果（主题色键名或 6 位十六进制）→ 6 位十六进制；'none' 返回 ''。 */
function colorHex(c: string, themeKey = 'clinical'): string {
  if (c === 'none') return ''
  if (/^#?[0-9a-fA-F]{6}$/.test(c)) return c.replace(/^#/, '').toUpperCase()
  const t = (deckThemes[themeKey] ?? deckThemes.clinical) as Record<string, string> | undefined
  return (t?.[c] ?? '').toUpperCase()
}

function pickColor(anchor: HTMLElement, themeKey: string, allowNone: boolean): Promise<string | null> {
  return new Promise(resolve => {
    document.querySelector('.color-pop')?.remove()
    const t = deckThemes[themeKey] ?? deckThemes.clinical
    const swatches: Array<[string, string, string]> = t ? [
      ['accent', t.accent, '强调色'], ['accent2', t.accent2, '强调色 2'], ['title', t.title, '标题色'], ['body', t.body, '正文色'],
      ['muted', t.muted, '次要色'], ['surface', t.surface, '卡片色'], ['bg', t.bg, '背景色'], ['FFFFFF', 'FFFFFF', '白色'],
    ] : []
    const pop = document.createElement('div')
    pop.className = 'color-pop'
    pop.innerHTML = `<div class="swatches">${swatches.map(([v, hex, label]) => `<button data-c="${v}" title="${label}" style="background:#${hex}"></button>`).join('')}</div>
      <div class="color-row">${allowNone ? '<button data-c="none">无填充</button>' : ''}<label>自定义 <input type="color" value="#${t?.accent ?? '0EA5E9'}"></label></div>`
    const r = anchor.getBoundingClientRect()
    document.body.appendChild(pop)
    placeFixedPopup(pop, r, false)
    const done = (v: string | null) => { pop.remove(); document.removeEventListener('mousedown', outside); resolve(v) }
    const outside = (e: MouseEvent) => { if (!pop.contains(e.target as Node)) done(null) }
    setTimeout(() => document.addEventListener('mousedown', outside))
    pop.onclick = e => { const c = (e.target as HTMLElement).closest('[data-c]') as HTMLElement | null; if (c) done(c.dataset.c!) }
    pop.querySelector<HTMLInputElement>('input[type=color]')!.onchange = e => done((e.target as HTMLInputElement).value.slice(1).toUpperCase())
  })
}

/** 形状当前的字号（第一段文字的 a:rPr sz；没有时按占位符类型估）。 */
function shapeFontSize(shape: any): number {
  let sz: number | null = null
  const walk = (n: any) => {
    if (sz !== null) return
    if (n.type === 'text') { const xml = n.marks?.find((m: any) => m.type === 'rpr')?.attrs?.xml as string | undefined; const m = xml && /\ssz="(\d+)"/.exec(xml); if (m) sz = Number(m[1]) / 100 }
    n.content?.forEach(walk)
  }
  walk(shape)
  return sz ?? ({ title: 40, ctrTitle: 44, subTitle: 24, body: 28 } as Record<string, number>)[shape.attrs?.ph as string] ?? 18
}

const hasBold = (shape: any): boolean => JSON.stringify(shape).includes('"type":"bold"')

const tableRows = (shape: any): number => shape.content?.[0]?.content?.length ?? 0
const tableCols = (shape: any): number => shape.content?.[0]?.content?.[0]?.content?.length ?? 0

$('arrangeMenu').onclick = async e => {
  const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  const deck = session?.deck
  if (!b || !deck || b.disabled) return
  $('arrangeMenu').hidden = true
  const shape_ids = deck.selectionIds()
  if (b.dataset.arrange) await deck.edit([{ op: 'align_shapes', shape_ids, align: b.dataset.arrange }])
  if (b.dataset.distribute) await deck.edit([{ op: 'distribute_shapes', shape_ids, direction: b.dataset.distribute }])
}
document.addEventListener('click', e => {
  if ((e.target as HTMLElement).closest('.menu-wrap')) return
  $('arrangeMenu').hidden = true
  $('chartMenu').hidden = true
  $('imageMenu').hidden = true
  const fmtMenu = document.getElementById('formatMoreMenu')
  if (fmtMenu) fmtMenu.hidden = true
})

/** 插入图片：上传，或（服务器配了图库时）从 Unsplash 搜索。与 AI 的 add_image / slide_add_photo 同一套。 */
$('imageMenu').onclick = e => {
  const b = (e.target as HTMLElement).closest('[data-image-src]') as HTMLElement | null
  if (!b) return
  $('imageMenu').hidden = true
  if (b.dataset.imageSrc === 'upload') { $('deckImageInput').click(); return }
  openPhotoSearch({
    api, notice: showNotice,
    target: () => {
      const slide = session?.deck?.selection()?.slide ?? session?.deck?.currentSlide()
      return session && slide ? { docId: session.docId, slideId: slide.attrs!.id as string } : null
    },
  })
}

/** 插入图表：示例数据（饼 / 圆环只有一个系列），之后双击或「编辑数据」改。与 AI 同一个 add_chart。 */
$('chartMenu').onclick = async e => {
  const b = (e.target as HTMLElement).closest('[data-chart-type]') as HTMLButtonElement | null
  const deck = session?.deck
  const slide = deck?.selection()?.slide ?? deck?.currentSlide()
  if (!b || !deck || !slide) return
  $('chartMenu').hidden = true
  const type = b.dataset.chartType!
  const W = deck.slideSize.cx / 12700
  const H = deck.slideSize.cy / 12700
  const round = type === 'pie' || type === 'doughnut'
  const series = round
    ? [{ name: '占比', values: [45, 30, 25] }]
    : [{ name: '组 A', values: [4.3, 2.5, 3.5] }, { name: '组 B', values: [2.4, 4.4, 1.8] }]
  const w = round ? 420 : 560
  await deck.edit([{ op: 'add_chart', slide_id: slide.attrs!.id, type, x: Math.round(W / 2 - w / 2), y: Math.round(H / 2 - 160), w, h: 320, title: '图表标题', categories: ['类别 1', '类别 2', '类别 3'], series }])
}

/** 改图表数据：数据表对话框 → chart_set_data（与 AI 同一个操作）。 */
async function editChart(deck: DeckView, shapeId: string, chart: ChartData): Promise<void> {
  if (!EDITABLE_CHART_TYPES.includes(chart.type)) { showNotice('这种图表（散点 / 雷达等）暂不支持在这里改数据，可在 PowerPoint 里改，或删掉后用「＋图表」重建'); return }
  const next = await editChartData(chart)
  if (!next) return
  const { type, ...data } = next
  // 先改数据（用原 id），再换类型（导入的图表换类型后 id 会变）——同一批，原子提交
  const ops: Array<Record<string, unknown>> = [{ op: 'chart_set_data', shape_id: shapeId, ...data }]
  if (type !== chart.type) ops.push({ op: 'chart_set_type', shape_id: shapeId, type })
  await deck.edit(ops)
}

$('deckImageInput').onchange = async () => {
  const input = $<HTMLInputElement>('deckImageInput')
  const file = input.files?.[0]
  input.value = ''
  const deck = session?.deck
  const slide = deck?.currentSlide()
  if (!file || !deck || !slide || !session) return
  const form = new FormData()
  form.set('file', file)
  try {
    const r = await api(`/api/docs/${session.docId}/assets`, { method: 'POST', body: form })
    const W = deck.slideSize.cx / 12700
    await deck.edit([{ op: 'add_image', slide_id: slide.attrs!.id, asset_id: r.asset_id, x: Math.round(W / 2 - 200), y: 100, w: 400, description: file.name }])
  } catch (err) { showNotice((err as Error).message, true) }
}

$('deckToolbar').onclick = async e => {
  const btn = (e.target as HTMLElement).closest('[data-dk]') as HTMLButtonElement | null
  const deck = session?.deck
  if (!btn || !deck || btn.disabled) return
  const sel = deck.selection()
  const slide = sel?.slide ?? deck.currentSlide()
  if (!slide) return
  const theme = (slide.attrs?.theme as string | null) ?? 'clinical'
  const W = deck.slideSize.cx / 12700
  const H = deck.slideSize.cy / 12700
  const id = sel?.shape.attrs?.id as string | undefined
  // 样式操作作用于全部选中的形状（Shift+单击多选），一次提交
  const ids = deck.selectionIds()
  const each = (op: Record<string, unknown>) => ids.map(shape_id => ({ ...op, shape_id }))
  const cell = deck.tableCell()
  switch (btn.dataset.dk) {
    // 模板与加页：与 AI 的 apply_theme / add_slide 同一套
    case 'theme': {
      const current = (deck.currentSlide()?.attrs?.theme as string | null) ?? null
      const key = await pickTemplate(api, { title: '换模板', current })
      if (key && key !== current) await deck.edit([{ op: 'apply_theme', theme: key }])
      break
    }
    case 'slide-add': {
      const layout = await pickLayout(api, btn, (slide.attrs?.theme as string | null) ?? null)
      if (layout) await deck.edit([{ op: 'add_slide', after: slide.attrs!.id, layout }])
      break
    }
    case 'slide-del': {
      if (await askConfirm({ title: '删除这一页', message: '删除当前这一页？可以在版本历史里找回。', confirm: '删除', danger: true })) await deck.edit([{ op: 'delete_slide', slide_id: slide.attrs!.id }])
      break
    }
    case 'bg': { const c = await pickColor(btn, theme, false); if (c) await deck.edit([{ op: 'set_background', slide_id: slide.attrs!.id, color: c }]); break }
    case 'textbox': await deck.edit([{ op: 'add_shape', slide_id: slide.attrs!.id, markdown: '新文本框', x: Math.round(W / 2 - 200), y: Math.round(H / 2 - 30), w: 400, h: 60, color: 'body' }]); break
    case 'block': await deck.edit([{ op: 'add_shape', slide_id: slide.attrs!.id, markdown: '', x: Math.round(W / 2 - 150), y: Math.round(H / 2 - 60), w: 300, h: 120, geometry: 'roundRect', fill: 'accent', color: 'FFFFFF' }]); break
    case 'image': {
      // 没配图库：直接上传；配了：弹出「上传 / 从 Unsplash 搜索」
      if (!await photoSearchEnabled(api)) { $('deckImageInput').click(); break }
      const menu = $('imageMenu')
      const r = btn.getBoundingClientRect()
      menu.hidden = !menu.hidden
      if (!menu.hidden) placeFixedPopup(menu, r, false)
      break
    }
    case 'chart': {
      const menu = $('chartMenu')
      const r = btn.getBoundingClientRect()
      menu.hidden = !menu.hidden
      if (!menu.hidden) placeFixedPopup(menu, r, false)
      break
    }
    case 'figure-studio': {
      void researchUi.openDocFigureModal({
        docTitle: detail?.title || '当前幻灯片',
        onInsert: async (assetId, caption) => {
          await insertFigureIntoActiveSession(assetId, caption)
        },
      })
      break
    }
    case 'chart-data': if (id && sel!.shape.attrs?.chart) await editChart(deck, id, sel!.shape.attrs.chart as ChartData); break
    case 'table': await deck.edit([{ op: 'add_table', slide_id: slide.attrs!.id, x: Math.round(W / 2 - 300), y: Math.round(H / 2 - 64), w: 600, rows: [['项目', '组 A', '组 B'], ['', '', ''], ['', '', '']] }]); break
    case 'fill': { const c = await pickColor(btn, theme, true); if (c && id) await deck.edit(each({ op: 'set_fill', color: c })); break }
    case 'color': { const c = await pickColor(btn, theme, false); if (c && id) await deck.edit(each({ op: 'set_text_style', color: c })); break }
    case 'bigger': case 'smaller': {
      if (!id) break
      const now = shapeFontSize(sel!.shape)
      const step = now >= 28 ? 4 : 2
      await deck.edit(each({ op: 'set_text_style', size: Math.max(8, Math.min(120, btn.dataset.dk === 'bigger' ? now + step : now - step)) }))
      break
    }
    case 'bold': if (id) await deck.edit(each({ op: 'set_text_style', bold: !hasBold(sel!.shape) })); break
    case 'align-left': if (id) await deck.edit(each({ op: 'set_text_style', align: 'left' })); break
    case 'align-center': if (id) await deck.edit(each({ op: 'set_text_style', align: 'center' })); break
    case 'arrange': {
      // 工具条横向可滚动（会裁掉里面的下拉），菜单按按钮位置固定定位
      const menu = $('arrangeMenu')
      const r = btn.getBoundingClientRect()
      menu.hidden = !menu.hidden
      if (!menu.hidden) placeFixedPopup(menu, r, false)
      syncDeckToolbar()
      break
    }
    case 'row-add': if (id) await deck.edit([{ op: 'table_insert_rows', shape_id: id, at: (cell?.r ?? tableRows(sel!.shape) - 1) + 1 }]); break
    case 'col-add': if (id) await deck.edit([{ op: 'table_insert_cols', shape_id: id, at: (cell?.c ?? tableCols(sel!.shape) - 1) + 1 }]); break
    case 'row-del': if (id) await deck.edit([{ op: 'table_delete_rows', shape_id: id, at: cell?.r ?? tableRows(sel!.shape) - 1, count: 1 }]); break
    case 'col-del': if (id) await deck.edit([{ op: 'table_delete_cols', shape_id: id, at: cell?.c ?? tableCols(sel!.shape) - 1, count: 1 }]); break
    case 'front': if (id) await deck.edit(each({ op: 'set_z', to: 'front' })); break
    case 'back': if (id) await deck.edit(each({ op: 'set_z', to: 'back' })); break
    case 'delete': if (id) await deck.edit(each({ op: 'delete_shape' })); break
  }
}

$('deckToolbar').onchange = async e => {
  const selEl = (e.target as HTMLElement).closest('select') as HTMLSelectElement | null
  const deck = session?.deck
  if (!selEl || !deck) return
  const currentSel = deck.selection()
  const id = currentSel?.shape.attrs?.id as string | undefined
  if (!id) return
  const ids = deck.selectionIds()
  const each = (op: Record<string, unknown>) => ids.map(shape_id => ({ ...op, shape_id }))
  if (selEl.id === 'selDeckFontFamily' && selEl.value) {
    await deck.edit(each({ op: 'set_text_style', font_family: selEl.value }))
  } else if (selEl.id === 'selDeckFontSize' && selEl.value) {
    await deck.edit(each({ op: 'set_text_style', size: Number(selEl.value) }))
  }
}

// —— 工具栏 ——

async function insertFigureIntoActiveSession(assetId: string, caption: string): Promise<boolean> {
  if (!session) return false
  if (session.kind === 'doc' && session.editor) {
    session.editor.insertFigureAsset(assetId, caption)
    showNotice(`已插入科研图表「${caption}」（自动绑定可复现分析溯源）`)
    return true
  }
  if (session.kind === 'deck' && session.deck) {
    const slide = session.deck.selection()?.slide ?? session.deck.currentSlide()
    if (!slide) return false
    const W = session.deck.slideSize.cx / 12700
    await session.deck.edit([{
      op: 'add_image',
      slide_id: slide.attrs!.id,
      asset_id: assetId,
      x: Math.round(W / 2 - 220),
      y: 90,
      w: 440,
      description: caption,
    }])
    showNotice(`已将科研图表「${caption}」插入当前幻灯片`)
    return true
  }
  return false
}

async function insertTableIntoActiveOrNewDoc(rows: string[][]): Promise<void> {
  if (!rows.length) return
  if (session?.kind === 'doc' && session.editor) {
    session.editor.insertTableRows(rows, true)
    syncToolbar()
    showNotice(`已插入可编辑三线表（${rows.length} 行 × ${rows[0]?.length ?? 0} 列）`)
    return
  }
  try {
    const created = await api<{ id: string }>('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ title: '临床数据汇总与文稿', kind: 'doc' }),
    })
    await loadDocs()
    await open(created.id)
    await new Promise(r => setTimeout(r, 180))
    session?.editor?.insertTableRows(rows, true)
    syncToolbar()
    showNotice(`已新建文稿并插入可编辑三线表（${rows.length} 行 × ${rows[0]?.length ?? 0} 列）`)
  } catch (err) {
    showNotice(`插入表格失败：${(err as Error).message}`, true)
  }
}

bindMarkdownActions($('chatLog'), {
  onInsertTable: insertTableIntoActiveOrNewDoc,
  onNotice: showNotice,
})

document.getElementById('formatMoreBtn')?.addEventListener('click', e => {
  e.stopPropagation()
  const menu = document.getElementById('formatMoreMenu')
  if (!menu) return
  menu.hidden = !menu.hidden
})

$('toolbar').onclick = async e => {
  const btn = (e.target as HTMLElement).closest('button')
  const cmd = btn?.dataset.cmd
  if (!cmd || !session?.editor) return
  if (cmd === 'deepReview') {
    switchTab('commentPane')
    void runDeepReview()
    return
  }
  const c = session.editor.commands as Record<string, (...a: any[]) => void>
  if (cmd === 'image') { $('imageInput').click(); return }
  if (cmd === 'figureStudio') {
    void researchUi.openDocFigureModal({
      docTitle: detail?.title || '当前文稿',
      onInsert: async (assetId, caption) => {
        await insertFigureIntoActiveSession(assetId, caption)
      },
    })
    return
  }
  if (cmd === 'cite') { void addCitation(); return }
  if (cmd === 'measure') { void openMeasureDialog(); return }
  if (cmd === 'confirmAi') { provUi.confirmSelection(); return }
  if (cmd === 'tableMerge') {
    if (!session.editor.commands.tableMerge()) showNotice('先拖选两个以上相邻的单元格再合并')
    return
  }
  if (cmd === 'tableSplit') {
    if (!session.editor.commands.tableSplit()) showNotice('光标所在的单元格没有合并，无需拆分')
    return
  }
  if (cmd === 'tableBackground') {
    const color = await pickColor(btn, 'clinical', true)
    if (color && session?.editor) session.editor.commands.tableBackground(colorHex(color))
    return
  }
  if (cmd === 'color') {
    const color = await pickColor(btn, 'clinical', true)
    if (color && session?.editor) {
      const hex = colorHex(color)
      session.editor.commands.setTextColor(hex ? `#${hex}` : '')
    }
    return
  }
  if (['bold', 'italic', 'underline', 'sup', 'sub'].includes(cmd)) {
    session.editor.commands.mark(cmd as 'bold')
    syncToolbar()
  } else {
    c[cmd]?.()
  }
}
async function addCitation(): Promise<void> {
  if (!session?.editor) return
  const input = await askText({
    title: '插入引用文献',
    label: 'DOI / PMID / 论文标题或关键词',
    placeholder: '例如 10.1056/NEJMoa2307563 或 38215162 或 Osimertinib in NSCLC',
    confirm: '核实并插入',
    hint: '支持输入 DOI、PubMed ID (PMID) 或论文标题关键词。系统将通过 PubMed / Crossref / OpenAlex 权威比对并自动插入引用编号。',
  })
  if (!input?.trim()) return
  try {
    const raw = input.trim()
    const isPmid = /^\d{6,9}$/.test(raw) || /^pmid:?\s*\d+/i.test(raw)
    const isDoi = /\b10\.\d{4,9}\//.test(raw)
    const payload: Record<string, string> = {}
    if (isDoi) payload.doi = raw
    else if (isPmid) payload.pmid = raw.replace(/^pmid:?\s*/i, '')
    else payload.query = raw

    const r = await api(`/api/docs/${session.docId}/citations`, { method: 'POST', body: JSON.stringify(payload) })
    session.editor?.insertCitation(r.cite_id)
    showNotice(`已插入引用：${r.formatted}`)
    scheduleRefresh()
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}

/** 编辑器「插入测量」弹窗（T2.5 / W4.2）：复用本文档已登记测量原子，或从患者已确认病灶绑定新测量并在光标处插入 [@m:id] */
async function openMeasureDialog(): Promise<void> {
  if (!session?.editor) return
  const docId = session.docId
  const dlg = $('dialog')
  const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
  type DocMeasureResp = {
    strict: boolean
    explicit_strict?: boolean | null
    patient_id?: string | null
    measurements: Array<{ id: string; source_kind: string; source_id: string; field: string; unit: string; view?: { id: string; text: string; status: string; source_label: string; note: string } }>
  }
  type PatientItem = { id: string; code: string; sex?: string | null; birth_year?: number | null }
  type StudyItem = { id: string; study_date: string | null; description: string | null; modalities: string[]; lesions: { confirmed: number; proposed: number } }
  type ReviewLesion = { id: string; label: string | null; location: string | null; status: string; metrics: Record<string, unknown> }

  const FIELD_GROUPS: Array<{ source: 'imaging_lesion' | 'imaging_followup'; key: string; label: string; units: string[] }> = [
    { source: 'imaging_lesion', key: 'mean_diameter_mm', label: '平均径', units: ['mm', 'cm'] },
    { source: 'imaging_lesion', key: 'long_axis_mm', label: '长径', units: ['mm', 'cm'] },
    { source: 'imaging_lesion', key: 'short_axis_mm', label: '短径', units: ['mm', 'cm'] },
    { source: 'imaging_lesion', key: 'solid_core_diameter_mm', label: '实性成分直径', units: ['mm', 'cm'] },
    { source: 'imaging_lesion', key: 'volume_mm3', label: '体积', units: ['mm3', 'cm3'] },
    { source: 'imaging_lesion', key: 'mean_hu', label: '平均 CT 值', units: ['HU'] },
    { source: 'imaging_lesion', key: 'ctr', label: '实性成分占比 (CTR)', units: ['ratio'] },
    { source: 'imaging_followup', key: 'delta_mean_diameter_mm', label: '随访：Δ平均径', units: ['mm', 'cm'] },
    { source: 'imaging_followup', key: 'delta_volume_mm3', label: '随访：Δ体积', units: ['mm3', 'cm3'] },
    { source: 'imaging_followup', key: 'delta_volume_pct', label: '随访：Δ体积变化率 (%)', units: ['pct'] },
    { source: 'imaging_followup', key: 'vdt_days', label: '随访：体积倍增时间 (VDT)', units: ['day'] },
  ]
  const UNIT_LABEL: Record<string, string> = { mm: 'mm', cm: 'cm', mm3: 'mm³', cm3: 'cm³', HU: 'HU', ratio: '比值（无单位）', pct: '%', day: '天' }

  let data: DocMeasureResp
  let patients: PatientItem[] = []
  try {
    ;[data, patients] = await Promise.all([
      api<DocMeasureResp>(`/api/docs/${docId}/measurements`),
      api<{ patients: PatientItem[] }>('/api/patients').then(r => r.patients ?? []).catch(() => [] as PatientItem[]),
    ])
  } catch (err) {
    showNotice((err as Error).message, true)
    return
  }

  const lockedPid = data.patient_id ?? null
  let selectedPid = lockedPid ?? patients[0]?.id ?? ''
  let studies: StudyItem[] = []
  let selectedSid = ''
  let confirmedLesions: ReviewLesion[] = []

  const loadStudiesForPatient = async (pid: string) => {
    if (!pid) { studies = []; selectedSid = ''; confirmedLesions = []; return }
    try {
      studies = await api<StudyItem[]>(`/api/patients/${encodeURIComponent(pid)}/imaging/studies`)
      const withConfirmed = studies.find(s => (s.lesions?.confirmed ?? 0) > 0)
      selectedSid = (withConfirmed ?? studies[0])?.id ?? ''
      await loadLesionsForStudy(pid, selectedSid)
    } catch {
      studies = []; selectedSid = ''; confirmedLesions = []
    }
  }

  const loadLesionsForStudy = async (pid: string, sid: string) => {
    if (!pid || !sid) { confirmedLesions = []; return }
    try {
      const rv = await api<{ lesions: ReviewLesion[] }>(`/api/patients/${encodeURIComponent(pid)}/imaging/studies/${encodeURIComponent(sid)}/review`)
      confirmedLesions = (rv.lesions ?? []).filter(l => l.status === 'confirmed')
    } catch {
      confirmedLesions = []
    }
  }

  await loadStudiesForPatient(selectedPid)

  const render = () => {
    const fItem = FIELD_GROUPS[0]!
    dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="插入测量原子">
      <div class="dialog-head"><h2>插入病灶测量原子 [@m:id]（T2.5 / W4.2）</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <div class="dialog-body" style="display:flex;flex-direction:column;gap:12px;">
        <div class="muted small">
          测量数字绑定到医生已确认的病灶测量，文档只存原子节点 <code>[@m:id]</code>，重测后自动同步更新；严格模式下禁止 AI 手写裸测量数字。
        </div>
        <div class="row" style="align-items:center;justify-content:space-between;background:var(--raised);padding:8px 10px;border:1px solid var(--line);border-radius:6px;">
          <span class="small"><b>测量严格模式</b>：${data.strict ? '<span class="pill green small">已开启（拦截 AI 裸测量数字）</span>' : '<span class="muted small">未开启</span>'}</span>
          <span style="display:inline-flex;gap:6px;">
            <button type="button" class="small-btn${data.explicit_strict === true ? ' primary' : ''}" data-mpolicy="true">强制开启</button>
            <button type="button" class="small-btn${data.explicit_strict === null || data.explicit_strict === undefined ? ' primary' : ''}" data-mpolicy="null">自动（有测量即开启）</button>
            <button type="button" class="small-btn quiet${data.explicit_strict === false ? ' primary' : ''}" data-mpolicy="false">关闭</button>
          </span>
        </div>

        <div>
          <div style="font-weight:600;margin-bottom:6px;">1. 本文档已登记的测量原子（${data.measurements.length} 项）</div>
          ${data.measurements.length === 0 ? '<div class="muted small">本文档尚未登记测量原子，可在下方选择已确认病灶绑定并插入。</div>' : `
            <div class="ds-scroll" style="max-height:180px;">
              <table class="help-table">
                <thead><tr><th>标记</th><th>当前显示值</th><th>来源说明</th><th>状态</th><th></th></tr></thead>
                <tbody>
                  ${data.measurements.map(m => `
                    <tr>
                      <td><code>[@m:${esc(m.id)}]</code></td>
                      <td><b>${esc(m.view?.text ?? '—')}</b></td>
                      <td class="small">${esc(m.view?.source_label ?? m.field)}</td>
                      <td class="small">${m.view?.status === 'ok' ? '<span class="muted">正常</span>' : `<span class="flag-L">${esc(m.view?.note ?? m.view?.status ?? '')}</span>`}</td>
                      <td><button type="button" class="small-btn primary" data-minsert="${esc(m.id)}">插入光标处</button></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>

        <form class="form" id="measureBindForm" style="border-top:1px solid var(--line);padding-top:10px;">
          <div style="font-weight:600;margin-bottom:4px;">2. 绑定并插入已确认病灶的新测量</div>
          ${patients.length === 0 && !lockedPid ? '<div class="muted small">暂无可见的在管患者，请先在「患者」页建档并确认影像病灶。</div>' : `
            <div class="row" style="gap:8px;flex-wrap:wrap;">
              <label style="flex:1;min-width:160px;">患者
                <select name="patient_id" id="mbPatient" ${lockedPid ? 'disabled title="一份文档只关联同一位患者的病灶测量"' : ''}>
                  ${patients.map(p => `<option value="${esc(p.id)}"${p.id === selectedPid ? ' selected' : ''}>${esc(p.code)}</option>`).join('')}
                  ${lockedPid && !patients.some(p => p.id === lockedPid) ? `<option value="${esc(lockedPid)}" selected>当前关联患者</option>` : ''}
                </select>
              </label>
              <label style="flex:1;min-width:200px;">影像检查
                <select name="study_id" id="mbStudy">
                  ${studies.length === 0 ? '<option value="">（无影像检查）</option>' : studies.map(s => `<option value="${esc(s.id)}"${s.id === selectedSid ? ' selected' : ''}>${esc(s.study_date ?? '日期未知')} · ${esc(s.description ?? (s.modalities.join('/') || 'CT'))}（已确认 ${s.lesions?.confirmed ?? 0}）</option>`).join('')}
                </select>
              </label>
            </div>
            <div class="row" style="gap:8px;flex-wrap:wrap;">
              <label style="flex:2;min-width:220px;">已确认病灶（仅 status=confirmed 可绑定）
                <select name="lesion_id" id="mbLesion" required>
                  ${confirmedLesions.length === 0 ? '<option value="">（该检查暂无已确认病灶，请先在阅片器或审核视图确认）</option>' : confirmedLesions.map(l => {
                    const md = typeof l.metrics?.mean_diameter_mm === 'number' ? ` · 平均径 ${l.metrics.mean_diameter_mm.toFixed(1)} mm` : ''
                    const vol = typeof l.metrics?.volume_mm3 === 'number' ? ` · 体积 ${Math.round(l.metrics.volume_mm3)} mm³` : ''
                    return `<option value="${esc(l.id)}">${esc(l.label ?? l.id)} · ${esc(l.location ?? '部位未定')}${md}${vol}</option>`
                  }).join('')}
                </select>
              </label>
              <label style="flex:1;min-width:180px;">测量字段
                <select name="field_spec" id="mbField">
                  ${FIELD_GROUPS.map((g, idx) => `<option value="${idx}">${esc(g.label)}</option>`).join('')}
                </select>
              </label>
              <label style="min-width:110px;">显示单位
                <select name="unit" id="mbUnit">
                  ${fItem.units.map(u => `<option value="${esc(u)}">${esc(UNIT_LABEL[u] ?? u)}</option>`).join('')}
                </select>
              </label>
            </div>
            <div class="row end" style="margin-top:6px;">
              <button type="button" data-close>取消</button>
              <button type="submit" class="primary" ${confirmedLesions.length === 0 ? 'disabled' : ''}>绑定并插入光标处</button>
            </div>
          `}
        </form>
      </div>
    </div>`
    dlg.hidden = false

    const ptSel = dlg.querySelector<HTMLSelectElement>('#mbPatient')
    if (ptSel) {
      ptSel.onchange = async () => {
        selectedPid = ptSel.value
        await loadStudiesForPatient(selectedPid)
        render()
      }
    }
    const stSel = dlg.querySelector<HTMLSelectElement>('#mbStudy')
    if (stSel) {
      stSel.onchange = async () => {
        selectedSid = stSel.value
        await loadLesionsForStudy(selectedPid, selectedSid)
        render()
      }
    }
    const fieldSel = dlg.querySelector<HTMLSelectElement>('#mbField')
    const unitSel = dlg.querySelector<HTMLSelectElement>('#mbUnit')
    if (fieldSel && unitSel) {
      fieldSel.onchange = () => {
        const g = FIELD_GROUPS[Number(fieldSel.value)] ?? FIELD_GROUPS[0]!
        unitSel.innerHTML = g.units.map(u => `<option value="${esc(u)}">${esc(UNIT_LABEL[u] ?? u)}</option>`).join('')
      }
    }
    const form = dlg.querySelector<HTMLFormElement>('#measureBindForm')
    if (form) {
      form.onsubmit = async ev => {
        ev.preventDefault()
        const fd = new FormData(form)
        const lesionId = String(fd.get('lesion_id') ?? '').trim()
        const g = FIELD_GROUPS[Number(fd.get('field_spec') ?? 0)] ?? FIELD_GROUPS[0]!
        const unit = String(fd.get('unit') ?? g.units[0] ?? '').trim()
        if (!lesionId) { showNotice('请先选择已确认的病灶', true); return }
        try {
          const r = await api<{ m_id: string; marker: string; view: { id: string; text: string; status: string; bound_text: string; source_label: string; source_version: number | null; bound_version: number; note: string } }>(
            `/api/docs/${docId}/measurements`,
            { method: 'POST', body: JSON.stringify({ source: g.source, source_id: lesionId, field: g.key, unit }) },
          )
          const refreshed = await api<DocMeasureResp>(`/api/docs/${docId}/measurements`).catch(() => null)
          if (refreshed && session?.editor) {
            session.editor.setMeasurements(refreshed.measurements.map(m => m.view).filter((v): v is NonNullable<typeof v> => !!v) as any)
          }
          session?.editor?.insertMeasurement(r.m_id)
          close()
          showNotice(`已插入测量：${r.view.text}（${r.view.source_label}）`)
          scheduleRefresh()
        } catch (err) {
          showNotice((err as Error).message, true)
        }
      }
    }
    dlg.onclick = async ev => {
      const t = ev.target as HTMLElement
      if (ev.target === dlg || t.closest('[data-close]')) { close(); return }
      const ins = t.closest<HTMLElement>('[data-minsert]')
      if (ins) {
        const mId = ins.dataset.minsert!
        session?.editor?.insertMeasurement(mId)
        close()
        showNotice(`已插入测量 [@m:${mId}]`)
        return
      }
      const pol = t.closest<HTMLElement>('[data-mpolicy]')
      if (pol) {
        const raw = pol.dataset.mpolicy
        const strictVal = raw === 'true' ? true : raw === 'false' ? false : null
        try {
          const res = await api<{ strict: boolean; explicit: boolean | null }>(`/api/docs/${docId}/measurements/policy`, {
            method: 'PUT',
            body: JSON.stringify({ strict: strictVal }),
          })
          data.strict = res.strict
          data.explicit_strict = res.explicit
          render()
          showNotice(res.strict ? '已开启测量严格模式' : '已关闭测量严格模式')
        } catch (err) {
          showNotice((err as Error).message, true)
        }
      }
    }
  }

  render()
}

$<HTMLInputElement>('imageInput').onchange = e => {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (session?.editor && files.length > 0) void session.editor.insertImages(files).catch(() => {})
}
$<HTMLSelectElement>('blockType').onchange = e => {
  const v = (e.target as HTMLSelectElement).value
  if (!session?.editor) return
  if (v === 'p') session.editor.commands.paragraph()
  else session.editor.commands.heading(Number(v.slice(1)))
}
const docFf = $<HTMLSelectElement>('docFontFamily')
if (docFf) docFf.onchange = () => session?.editor?.commands.setFontFamily(docFf.value)
const docFs = $<HTMLSelectElement>('docFontSize')
if (docFs) docFs.onchange = () => session?.editor?.commands.setFontSize(docFs.value)

function syncToolbar(): void {
  if (!session?.editor) return
  const t = session.editor.blockType()
  const bt = $<HTMLSelectElement>('blockType')
  if (bt) bt.value = ['p', 'h1', 'h2', 'h3'].includes(t) ? t : 'p'

  const fontSel = $<HTMLSelectElement>('docFontFamily')
  const szSel = $<HTMLSelectElement>('docFontSize')
  const style = session.editor.commands.activeTextStyle()
  if (fontSel) {
    const f = style.fontFamily
    fontSel.value = Array.from(fontSel.options).some(o => o.value === f) ? f : ''
  }
  if (szSel) {
    const sz = style.fontSize
    szSel.value = Array.from(szSel.options).some(o => o.value === sz) ? sz : ''
  }

  // 光标在表格里时才显示表格工具
  $('tableTools').hidden = !session.editor.commands.inTable()

  const boldBtn = document.querySelector<HTMLButtonElement>('#toolbar [data-cmd="bold"]')
  if (boldBtn) boldBtn.classList.toggle('active', session.editor.commands.isMarkActive('bold'))
  const italicBtn = document.querySelector<HTMLButtonElement>('#toolbar [data-cmd="italic"]')
  if (italicBtn) italicBtn.classList.toggle('active', session.editor.commands.isMarkActive('italic'))
  const underlineBtn = document.querySelector<HTMLButtonElement>('#toolbar [data-cmd="underline"]')
  if (underlineBtn) underlineBtn.classList.toggle('active', session.editor.commands.isMarkActive('underline'))

  const statsEl = document.getElementById('docStatsMeta')
  if (statsEl) {
    const st = session.editor.getDocStats()
    const parts = [`${st.chars} 字`]
    if (st.tables > 0) parts.push(`${st.tables} 表`)
    if (st.figures > 0) parts.push(`${st.figures} 图`)
    if (st.citations > 0) parts.push(`${st.citations} 引用`)
    statsEl.textContent = parts.join(' · ')
  }
}

// —— 通知 ——

let noticeTimer: number | undefined
function showNotice(text: string, error = false): void {
  const el = $('notice')
  el.textContent = text
  el.className = `notice toast${error ? ' error' : ''}`
  el.setAttribute('role', error ? 'alert' : 'status')
  el.hidden = false
  clearTimeout(noticeTimer)
  // 成功的提示短一点；出错的多停一会儿（点一下可以关）
  noticeTimer = window.setTimeout(() => { el.hidden = true }, error ? 9000 : 4000)
}
$('notice').onclick = () => { $('notice').hidden = true }

// —— 对话 ——

const TURN_STATUS: Record<string, string> = { error: '本轮出错', cancelled: '本轮已取消', timeout: '本轮超时', interrupted: '本轮被中断' }

function displayMessage(text: string): string {
  const m = /^请处理文档 \S+ 中的评论 (\S+)：/.exec(text)
  if (m) return `处理评论 ${m[1]}`
  if (/^请核对文档 \S+ 中带引用的论断/.test(text)) return '核对全部论断'
  // 发送时附给 AI 的说明（选中的资料 / 数据集）：对话里只显示名字
  return text.replace(/\n\n［(参考资料|数据集)］[^：]*：(.*)/g, (_m, kind: string, list: string) =>
    `\n（${kind === '数据集' ? '数据' : '资料'}：${[...list.matchAll(/《([^》]+)》/g)].map(x => x[1]).join('、')}）`)
    .replace(/\n\n［患者］[^：]*：(.*)/g, (_m, list: string) => `\n（患者：${[...list.matchAll(/(P-\d+)\(/g)].map(x => x[1]).join('、')}）`)
    .replace(/\n\n［研究］.*/g, '')
    .replace(/\n\n［图片］.*/g, m => [...m.matchAll(/asset_id=([A-Za-z0-9]+)/g)].map(x => `⟦img:${x[1]}⟧`).join(''))
}

/** 对话与子智能体分析文本统一支持完整 Markdown（含 GFM 表格、多级标题、列表、代码块、粗斜体与引用标记）。 */
function lightMarkdown(text: string): string {
  return `<div class="chat-md">${formatMarkdown(text)}</div>`
}

function addMsg(role: 'user' | 'assistant', text: string, revertTurn: string | null = null, msgTurnId: string | null = revertTurn): HTMLElement {
  $('chatSubagentWelcome')?.remove()
  const div = document.createElement('div')
  div.className = `msg ${role}`
  if (msgTurnId) div.dataset.turnId = msgTurnId
  if (role === 'assistant') {
    div.innerHTML = lightMarkdown(text)
    if (docPatient && /影像|病灶|切片|RECIST|CT|MRI|长径|短径|密度|结节|支气管|粘液栓|MPR/i.test(text)) {
      const actionRow = document.createElement('div')
      actionRow.className = 'chat-assistant-imaging-actions'
      actionRow.innerHTML = `<button type="button" class="small-btn quiet chat-go-imaging-btn" title="直接前往当前患者的影像学档案查看 3D MPR、病灶分割与定量评估">${icon('scan')} 前往患者影像中心 (3D MPR / RECIST) →</button>`
      actionRow.querySelector('.chat-go-imaging-btn')?.addEventListener('click', () => {
        void patientsUi.open(docPatient!, 'records')
      })
      div.appendChild(actionRow)
    }
  } else {
    // 用户消息里贴的图片（displayMessage 留下的 ⟦img:资产 id⟧）：显示缩略图
    const ids = [...text.matchAll(/⟦img:([A-Za-z0-9]+)⟧/g)].map(m => m[1]!)
    div.textContent = text.replace(/⟦img:[A-Za-z0-9]+⟧/g, '').trim()
    if (ids.length) {
      const row = document.createElement('div')
      row.className = 'msg-images'
      row.innerHTML = ids.map(id => `<a href="/api/assets/${encodeURIComponent(id)}?token=${encodeURIComponent(TOKEN)}" target="_blank" rel="noreferrer"><img src="/api/assets/${encodeURIComponent(id)}?token=${encodeURIComponent(TOKEN)}" alt="图片"></a>`).join('')
      div.appendChild(row)
    }
  }
  if (revertTurn) attachRevert(div, revertTurn)
  $('chatLog').appendChild(div)
  $('chatLog').scrollTop = 1e9
  return div
}

function attachRevert(el: HTMLElement, turnId: string): void {
  const btn = document.createElement('button')
  btn.className = 'revert'
  btn.dataset.turn = turnId
  btn.textContent = '撤销本轮修改'
  btn.onclick = async () => {
    if (!session) return
    try {
      const r = await api(`/api/docs/${session.docId}/turns/${turnId}/revert`, { method: 'POST' })
      const kept = r.skipped.length > 0 ? `；${r.skipped.length} 处你之后改过，已保留你的版本` : ''
      btn.replaceWith(Object.assign(document.createElement('div'), { className: 'step ok', textContent: `已撤销本轮修改（${r.changes} 处）${kept}` }))
    } catch (err) {
      showNotice((err as Error).message, true)
    }
  }
  el.appendChild(btn)
}

function syncRevertButtons(): void {
  const ok = new Set<string>(detail?.revertable ?? [])
  document.querySelectorAll<HTMLButtonElement>('button.revert').forEach(b => { if (!ok.has(b.dataset.turn!)) b.remove() })
}

function addStep(text: string, cls = '', detail = text): HTMLElement {
  const div = document.createElement('div')
  div.className = `step ${cls}`
  div.textContent = text
  div.title = detail
  // 回合进行中：步骤收进本轮的「工作过程」，结束后折叠
  ;(turnUi?.steps ?? $('chatLog')).appendChild(div)
  $('chatLog').scrollTop = 1e9
  return div
}

/** 工具调用的人话说明（原始参数放在悬停提示里）。 */
const TOOL_LABELS: Record<string, (a: any) => string> = {
  doc_outline: () => '查看文档结构',
  doc_read: () => '阅读文档',
  doc_search: a => `在文档里查找「${a.query ?? ''}」`,
  doc_validate: a => `预检文档修改（${a.ops?.length ?? 1} 处操作）`,
  doc_edit: a => `${a.dry_run ? '预检' : '修改'}文档（${a.ops?.length ?? 1} 处操作）`,
  doc_history: () => '查看修改历史',
  doc_diff: () => '对比版本',
  doc_list: () => '查看文档列表',
  doc_create: a => `新建文档《${a.title ?? ''}》`,
  comments_list: () => '读取评论',
  comment_reply: () => '在评论里回复',
  comment_resolve: () => '关闭评论',
  pubmed_search: a => `检索 PubMed：${a.query ?? ''}`,
  doi_lookup: a => `核实 DOI ${a.doi ?? ''}`,
  insert_citation: () => '登记引用文献',
  list_citations: () => '查看已登记的引用',
  verify_claims: () => '对照文献核对论断',
  claim_report: () => '提交核对结果',
  slide_read: () => '阅读幻灯片',
  deck_edit: a => `${a.dry_run ? '预检' : '修改'}幻灯片（${a.ops?.length ?? 1} 处操作）`,
  layout_check: () => '检查版面（溢出、重叠）',
  slide_render: () => '渲染幻灯片预览',
  asset_upload: () => '上传图片',
  read_image: () => '查看图片附件',
  bash: () => '运行计算',
  delegate_task: a => {
    const roleMap: Record<string, string> = {
      literature_researcher: '文献证据专家',
      biostatistician: '生信统计专家',
      fact_checker: '质控核查专家',
    }
    const roleName = roleMap[a?.role] ?? (a?.role || '子专家')
    return `委派【${roleName}】：${a?.task?.slice(0, 36) ?? ''}`
  },
}

function toolLabel(name: string, args: string): string {
  const short = name.replace(/^mcp__heurion__/, '')
  let parsed: any = {}
  try { parsed = JSON.parse(args) } catch { /* 参数不是 JSON */ }
  const f = TOOL_LABELS[short]
  return f ? f(parsed) : short
}

// —— 回合的界面状态：工作过程（折叠）、本轮改动（摘要条）、重试 ——

let turnUi: { steps: HTMLDetailsElement; count: number; retries: number; subagents: number; turnId: string | null } | null = null
/** 工具调用 id → 人话名称（工具失败时说清是哪一步）。 */
const callLabels = new Map<string, string>()
/** 每轮 AI 改动的块（提交事件带回合 id）。 */
const turnChanges = new Map<string, { ids: Set<string>; count: number }>()

function startTurnUi(turnId: string | null): void {
  const steps = document.createElement('details')
  steps.className = 'steps'
  steps.open = true
  steps.innerHTML = '<summary>工作中…</summary>'
  $('chatLog').appendChild(steps)
  turnUi = { steps, count: 0, retries: 0, subagents: 0, turnId }
}

const DONE_LABEL: Record<string, string> = { done: '已完成', error: '出错了', timeout: '超时停止', cancelled: '已停止', interrupted: '被中断' }

function finishTurnUi(status: string): void {
  if (!turnUi) return
  const subagentInfo = turnUi.subagents > 0 ? `（含 ${turnUi.subagents} 位专家协同）` : ''
  const retryInfo = turnUi.retries ? `（${turnUi.retries} 步调整后重试）` : ''
  turnUi.steps.querySelector('summary')!.textContent = `${DONE_LABEL[status] ?? status} · ${turnUi.count} 步${subagentInfo}${retryInfo}`
  turnUi.steps.open = false
  turnUi.steps.classList.toggle('failed', status !== 'done')
  turnUi = null
}

function addRetry(turnId: string): void {
  const step = addStep('', 'retry')
  step.title = ''
  const btn = document.createElement('button')
  btn.textContent = '重试这一轮'
  btn.onclick = async () => {
    if (!session) return
    btn.disabled = true
    try {
      await api(`/api/docs/${session.docId}/turns/${turnId}/retry`, { method: 'POST' })
      step.textContent = '已重新排队'
      void loadQueue()
    } catch (err) {
      btn.disabled = false
      showNotice((err as Error).message, true)
    }
  }
  step.appendChild(btn)
}

let banner: { turnId: string; ids: string[]; cursor: number } | null = null

function showTurnBanner(turnId: string): void {
  // 若当前已有待采纳修订横幅，则不再同时叠加显示 turnBanner，避免正文顶部双横幅挤压（Batch 2）
  if ((detail?.suggestions?.length ?? 0) > 0) {
    hideTurnBanner()
    return
  }
  const c = turnChanges.get(turnId)
  if (!c || c.count === 0) return
  // 修订模式下的改动由修订提示条处理；这里只列出正文里真实存在的块
  const ids = [...c.ids].filter(id => {
    const el = document.querySelector(`#page [data-id="${CSS.escape(id)}"]`)
    return el && !el.closest('[data-suggest]')
  })
  if (ids.length === 0) return
  banner = { turnId, ids, cursor: -1 }
  $('turnSummary').textContent = `本轮 AI 改了 ${c.count} 处`
  $('turnBanner').hidden = false
}

function hideTurnBanner(): void {
  banner = null
  $('turnBanner').hidden = true
}

$('turnBanner').onclick = async e => {
  const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  if (!t || !banner || !session) return
  if (t.dataset.tnav) {
    banner.cursor = (banner.cursor + Number(t.dataset.tnav) + banner.ids.length) % banner.ids.length
    const el = document.querySelector(`#page [data-id="${CSS.escape(banner.ids[banner.cursor]!)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.classList.add('ai-flash')
    setTimeout(() => el?.classList.remove('ai-flash'), 1200)
    return
  }
  if (t.dataset.tact === 'close') { hideTurnBanner(); return }
  if (t.dataset.tact === 'revert') {
    try {
      const r = await api(`/api/docs/${session.docId}/turns/${banner.turnId}/revert`, { method: 'POST' })
      showNotice(`已撤销本轮修改（${r.changes} 处）${r.skipped.length ? `；${r.skipped.length} 处你之后改过，已保留你的版本` : ''}`)
      hideTurnBanner()
      await refresh(false)
    } catch (err) {
      showNotice((err as Error).message, true)
    }
  }
}

let activeSubagentTask: { role: string; role_label: string; task: string } | null = null

function renderSubagentWelcome(): void {
  // 对话区保持极简清爽，不再展示与「审稿与批注」重叠的欢迎卡片与快捷胶囊
  $('chatSubagentWelcome')?.remove()
}

interface SubagentCardState {
  card: HTMLElement
  stepsList: HTMLElement
  statusEl: HTMLElement
  resultBox: HTMLElement
  role: string
}
const subagentCards = new Map<string, SubagentCardState>()

function formatMarkdownTableHtml(md: string): string {
  const lines = md.trim().split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.some(l => l.includes('|'))) {
    return `<pre class="subagent-mono-block">${esc(md)}</pre>`
  }
  let isHeader = true
  let headerHtml = ''
  let bodyHtml = ''

  for (const line of lines) {
    if (!line.includes('|')) continue
    if (/^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(line)) {
      isHeader = false
      continue
    }
    const cols = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    if (isHeader) {
      headerHtml += `<tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>`
    } else {
      bodyHtml += `<tr>${cols.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`
    }
  }

  if (!headerHtml && !bodyHtml) {
    return `<pre class="subagent-mono-block">${esc(md)}</pre>`
  }

  return `<table class="subagent-data-table">${headerHtml ? `<thead>${headerHtml}</thead>` : ''}<tbody>${bodyHtml}</tbody></table>`
}

function renderSubagentStart(ev: { id: string; role: string; role_label: string; task: string }): void {
  activeSubagentTask = { role: ev.role, role_label: ev.role_label || ev.role, task: ev.task }
  renderQueue()
  if (turnUi) {
    turnUi.count++
    turnUi.subagents++
  }
  const card = document.createElement('div')
  card.className = `subagent-card role-${esc(ev.role)}`
  card.id = `subagent-${esc(ev.id)}`

  const header = document.createElement('div')
  header.className = 'subagent-header'
  header.innerHTML = `
    <div class="subagent-title-row">
      <span class="subagent-role-pill role-${esc(ev.role)}">${esc(ev.role_label || ev.role)}</span>
      <span class="subagent-task" title="${esc(ev.task)}">${esc(ev.task)}</span>
    </div>
    <span class="subagent-status status-running"><span class="subagent-pulse"></span>协同中…</span>
  `

  const stepsList = document.createElement('div')
  stepsList.className = 'subagent-steps'

  const resultBox = document.createElement('div')
  resultBox.className = 'subagent-result-box'
  resultBox.hidden = true

  card.appendChild(header)
  card.appendChild(stepsList)
  card.appendChild(resultBox)

  const parent = turnUi?.steps ?? $('chatLog')
  parent.appendChild(card)
  $('chatLog').scrollTop = 1e9

  subagentCards.set(ev.id, {
    card,
    stepsList,
    statusEl: header.querySelector('.subagent-status') as HTMLElement,
    resultBox,
    role: ev.role,
  })
}

function renderSubagentStep(ev: { id: string; role: string; step: string; status?: 'ok' | 'warn' | 'info' }): void {
  const state = subagentCards.get(ev.id)
  if (!state) {
    addStep(`  [${ev.role}] ${ev.step}`, ev.status === 'warn' ? 'warn' : ev.status === 'ok' ? 'ok' : '')
    return
  }
  const item = document.createElement('div')
  item.className = `subagent-step-item status-${ev.status ?? 'info'}`
  const iconSpan = ev.status === 'ok' ? '●' : ev.status === 'warn' ? '▲' : '▸'
  item.innerHTML = `<span class="subagent-step-bullet">${iconSpan}</span><span class="subagent-step-msg">${esc(ev.step)}</span>`
  state.stepsList.appendChild(item)
  $('chatLog').scrollTop = 1e9
}

function renderSubagentDone(ev: { id: string; role: string; summary: string; output?: any }): void {
  activeSubagentTask = null
  renderQueue()

  const state = subagentCards.get(ev.id)
  if (!state) {
    addStep(`  [${ev.role}] ${ev.summary}`, 'ok')
    return
  }

  state.statusEl.className = 'subagent-status status-done'
  state.statusEl.innerHTML = '已交付'

  const out = ev.output
  if (out && typeof out === 'object') {
    state.resultBox.hidden = false
    const details = document.createElement('details')
    details.className = 'subagent-output-details'
    details.open = true

    let roleTitle = '成果交付'
    if (ev.role === 'literature_researcher') roleTitle = '文献检索与引注包'
    else if (ev.role === 'biostatistician') roleTitle = '生信统计报表 (Table 1 / KM)'
    else if (ev.role === 'fact_checker') roleTitle = '证据核验与合规审查报告'

    let contentHtml = ''
    if (ev.role === 'literature_researcher') {
      const citations = Array.isArray(out.citations) ? out.citations : []
      contentHtml = `
        <div class="subagent-output-summary">${esc(ev.summary)}</div>
        ${out.clinical_synthesis ? `<div class="subagent-synthesis-callout"><strong>临床综合分析：</strong>${lightMarkdown(out.clinical_synthesis)}</div>` : ''}
        ${citations.length > 0 ? `
          <div class="subagent-citations-title">登记与引用建议（共 ${citations.length} 篇）：</div>
          <div class="subagent-citation-cards">
            ${citations.map((c: any) => `
              <div class="subagent-citation-card">
                <div class="cite-header">
                  <span class="cite-title">${esc(c.title || '无题')}</span>
                  ${c.cite_id ? `<span class="cite-marker-pill" title="文档引用标记">[@c:${esc(c.cite_id)}]</span>` : ''}
                </div>
                <div class="cite-meta">
                  <span>${esc(Array.isArray(c.authors) ? c.authors.slice(0, 3).join(', ') + (c.authors.length > 3 ? ' 等' : '') : c.authors || '')}</span>
                  ${c.journal ? `<span> · <i>${esc(c.journal)}</i></span>` : ''}
                  ${c.year ? `<span> (${esc(String(c.year))})</span>` : ''}
                  ${c.pmid ? `<span class="cite-badge pmid">PMID: ${esc(String(c.pmid))}</span>` : ''}
                  ${c.doi ? `<span class="cite-badge doi">DOI: ${esc(String(c.doi))}</span>` : ''}
                </div>
                ${c.evidence_quote ? `<div class="cite-quote">“${esc(c.evidence_quote)}”</div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
      `
    } else if (ev.role === 'biostatistician') {
      const mdTable = out.markdown_table ? formatMarkdownTableHtml(out.markdown_table) : ''
      contentHtml = `
        <div class="subagent-output-summary">${esc(ev.summary)}</div>
        <div class="subagent-stat-meta">
          <span>数据集：<b>${esc(out.dataset_name || out.dataset_id || '未命名')}</b></span>
          <span>样本量：<b>N = ${esc(String(out.sample_size ?? '-'))}</b></span>
          <span>分析类型：<b>${esc(out.analysis_type === 'survival' ? 'Kaplan-Meier 生存分析' : out.analysis_type === 'table1' ? 'Table 1 基线特征' : '统计汇总')}</b></span>
        </div>
        ${mdTable ? `<div class="subagent-table-wrapper">${mdTable}</div>` : ''}
        ${out.clinical_interpretation ? `<div class="subagent-stat-callout"><strong>统计学与临床释义：</strong>${lightMarkdown(out.clinical_interpretation)}</div>` : ''}
      `
    } else if (ev.role === 'fact_checker') {
      const verdict = out.verdict || 'pass'
      const verdictLabel = verdict === 'pass' ? '核验全部通过' : verdict === 'warning' ? '存在存疑或轻微出入' : '发现未支持的论断'
      const issues = Array.isArray(out.issues) ? out.issues : []
      contentHtml = `
        <div class="subagent-fc-verdict verdict-${esc(verdict)}">${verdictLabel}</div>
        <div class="subagent-fc-grid">
          <div class="fc-metric"><span class="fc-val">${esc(out.total_claims_audited ?? 0)}</span><span class="fc-label">核验论断</span></div>
          <div class="fc-metric"><span class="fc-val ok">${esc(out.supported_count ?? 0)}</span><span class="fc-label">文献完全吻合</span></div>
          <div class="fc-metric"><span class="fc-val ${out.unsupported_count ? 'danger' : ''}">${esc(out.unsupported_count ?? 0)}</span><span class="fc-label">无证据/冲突</span></div>
          <div class="fc-metric"><span class="fc-val ${out.phi_detected ? 'danger' : 'ok'}">${out.phi_detected ? `检出 ${esc(out.phi_count)}` : '无敏感信息'}</span><span class="fc-label">PHI 敏感脱敏</span></div>
        </div>
        ${issues.length > 0 ? `
          <div class="subagent-issues-title">需作者关注的论断核验项（${issues.length} 处）：</div>
          <div class="subagent-issue-list">
            ${issues.map((iss: any) => `
              <div class="subagent-issue-item verdict-${esc(iss.verdict)}">
                <div class="issue-sentence">「${esc(iss.sentence)}」</div>
                <div class="issue-reason"><b>原因：</b>${esc(iss.reason)}</div>
                ${iss.suggestion ? `<div class="issue-fix"><b>修改建议：</b>${esc(iss.suggestion)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
      `
    } else {
      contentHtml = `<div class="subagent-output-summary">${esc(ev.summary)}</div>`
    }

    details.innerHTML = `
      <summary class="subagent-output-summary-btn">${roleTitle} · 成果交付</summary>
      <div class="subagent-output-content">${contentHtml}</div>
    `
    state.resultBox.appendChild(details)
  }
  $('chatLog').scrollTop = 1e9
}

let lastAssistant: HTMLElement | null = null

function renderTurnEvent(ev: any): void {
  switch (ev.type) {
    case 'queued': addStep(`排队中（第 ${ev.position} 位）：${displayMessage(ev.message).slice(0, 40)}`); void loadQueue(); break
    case 'turn': {
      activeSubagentTask = null
      subagentCards.clear()
      void loadQueue()
      lastAssistant = null
      setBusy(true)
      hideTurnBanner()
      const existingUserMsg = ev.turn_id
        ? $('chatLog').querySelector(`.msg.user[data-turn-id="${CSS.escape(ev.turn_id)}"]`)
        : null
      if (!existingUserMsg) {
        addMsg('user', displayMessage(ev.message), null, ev.turn_id ?? null)
      }
      startTurnUi(ev.turn_id ?? null)
      break
    }
    case 'assistant': lastAssistant = addMsg('assistant', ev.text, null, turnUi?.turnId ?? null); break
    case 'subagent_start': renderSubagentStart(ev); break
    case 'subagent_step': renderSubagentStep(ev); break
    case 'subagent_done': renderSubagentDone(ev); break
    case 'tool_call': {
      if (turnUi) turnUi.count++
      const label = toolLabel(String(ev.name), String(ev.arguments ?? ''))
      callLabels.set(String(ev.callId ?? ''), label)
      addStep(label, '', `${String(ev.name).replace(/^mcp__heurion__/, '')} ${String(ev.arguments ?? '')}`)
      break
    }
    case 'tool_result':
      if (ev.isError) {
        // 工具没成功通常 AI 会按提示调整后重试：说清哪一步、为什么，不当成致命错误
        if (turnUi) turnUi.retries++
        const what = callLabels.get(String(ev.callId ?? '')) ?? '上一步'
        const why = ev.message ? `：${ev.message}` : ''
        addStep(`  ${what}没成功${why}`, 'warn', [ev.message, ev.hint ? `建议：${ev.hint}` : '', ev.code ? `（${ev.code}）` : ''].filter(Boolean).join('\n'))
      }
      break
    case 'doc_updated': addStep(`  已写入文档（${ev.changes} 处）`, 'ok'); break
    case 'comment_reply': scheduleRefresh(); break
    case 'memory': $('chatLog').appendChild(memory.memoryCard(ev)); $('chatLog').scrollTop = 1e9; break
    case 'action': $('chatLog').appendChild(actions.card(ev.action)); $('chatLog').scrollTop = 1e9; break
    case 'version': addStep(`  ✓ 已保存为 v${ev.seq}`, 'ok'); break
    case 'protection': $('chatLog').appendChild(protectionNote(ev.lines ?? [])); $('chatLog').scrollTop = 1e9; break
    case 'error': {
      addStep(ev.message, 'err')
      // 失败原因直接显示在对话里（不只在折叠的工作过程里）
      const div = addMsg('assistant', `出错了：${friendlyError(ev.message)}`)
      div.classList.add('error')
      break
    }
    case 'turn_done':
      activeSubagentTask = null
      setBusy(false)
      void loadQueue()
      finishTurnUi(ev.status)
      if (ev.status !== 'done') addRetry(ev.turn_id)
      // 出错或中断的回合也可能已经写入了一部分修订：同样刷新，不然这些修订要手动刷新页面才看得到
      if (ev.docs.includes(session?.docId)) {
        session?.provider?.resync()
        void refresh(false).then(() => {
          if (detail?.suggestions?.length > 0) {
            const targetMsg = lastAssistant ?? addMsg('assistant', '（已生成待采纳修订，请确认采纳或拒绝）', null, ev.turn_id ?? null)
            attachChatReviewBar(targetMsg, detail.suggestions.length)
          } else if (detail?.revertable.includes(ev.turn_id)) {
            attachRevert(lastAssistant ?? addMsg('assistant', '（本轮已完成）'), ev.turn_id)
            showTurnBanner(ev.turn_id)
          }
        })
      }
      break
  }
}

function setBusy(b: boolean): void {
  const cancelBtn = $<HTMLButtonElement>('cancelBtn')
  cancelBtn.disabled = !b
  cancelBtn.hidden = !b
  $<HTMLButtonElement>('sendBtn').textContent = b ? '排队发送' : '发送'
}

// —— 对话里贴图：粘贴 / 拖入的图片先上传为资产，发送时一起带上（AI 用 read_image 看） ——
let chatImages: Array<{ id: string; name: string; previewUrl: string }> = []
function renderChatImages(): void {
  const box = $('chatImages')
  box.hidden = chatImages.length === 0
  if (chatImages.length === 0) {
    box.innerHTML = ''
    return
  }
  const imgsHtml = chatImages.map(i => {
    const src = i.previewUrl || `/api/assets/${encodeURIComponent(i.id)}?token=${encodeURIComponent(TOKEN)}`
    return `<span class="chat-img" data-id="${esc(i.id)}"><img src="${esc(src)}" alt="${esc(i.name)}"><button class="chip-x" aria-label="移除">✕</button></span>`
  }).join('')

  const patientAction = docPatient
    ? `<button type="button" class="chat-action-pill" data-prompt="请结合当前患者档案与既往病史，对比解读该影像截图并提供诊疗参考">${icon('hospital', { size: 13 })} 结合当前患者档案诊断</button>`
    : ''

  box.innerHTML = `
    <div class="chat-img-list">${imgsHtml}</div>
    <div class="chat-img-actions">
      <span class="chat-img-actions-label">快捷分析提示：</span>
      <button type="button" class="chat-action-pill" data-prompt="请提取附图中的病灶长短径尺寸与CT密度/信号特征，并给出影像学描述与拟诊">${icon('ruler', { size: 13 })} 提取长短径与密度测量</button>
      <button type="button" class="chat-action-pill" data-prompt="请根据 RECIST 1.1 标准解读此影像切片中的靶病灶，评估病灶大小与肿瘤反应状态">${icon('target', { size: 13 })} RECIST 靶病灶解读</button>
      <button type="button" class="chat-action-pill" data-prompt="请将此影像截面总结为一段规范的病程记录与影像学诊断意见草案">${icon('write', { size: 13 })} 生成病程影像记录</button>
      ${patientAction}
    </div>
    <span class="muted small chat-img-hint">已附图 · AI 将结合临床影像/图表视角解读（请勿上传含真实姓名/身份证号等个人敏感标识的图片；3D 容积量化与 RECIST 评估请在「患者 -> 影像」上传）</span>
  `
}

function removeChatImage(id: string): void {
  const item = chatImages.find(i => i.id === id)
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
  chatImages = chatImages.filter(i => i.id !== id)
  renderChatImages()
}

function clearAllChatImages(): void {
  for (const i of chatImages) {
    if (i.previewUrl) URL.revokeObjectURL(i.previewUrl)
  }
  chatImages = []
  renderChatImages()
}

async function attachImages(files: File[]): Promise<void> {
  if (!session) { showNotice('先打开一份文档再贴图', true); return }
  for (const f of files.slice(0, 8 - chatImages.length)) {
    if (!f || f.size <= 0) {
      showNotice('剪贴板中无有效图片数据（或为本地文件副本，请直接拖拽图片入框）', true)
      continue
    }
    if (f.size > 10 * 1024 * 1024) { showNotice(`${f.name} 超过 10MB`, true); continue }
    const previewUrl = URL.createObjectURL(f)
    const fd = new FormData()
    fd.append('file', f)
    try {
      const res = await api<{ asset_id: string; name: string }>(`/api/docs/${session.docId}/assets`, { method: 'POST', body: fd })
      chatImages.push({ id: res.asset_id, name: f.name || '图片', previewUrl })
    } catch (err) {
      URL.revokeObjectURL(previewUrl)
      showNotice(`图片上传失败：${(err as Error).message}`, true)
    }
  }
  renderChatImages()
}

$<HTMLTextAreaElement>('chatInput').addEventListener('paste', async e => {
  const cd = e.clipboardData
  if (!cd) return

  const files: File[] = []

  // 1. 优先从 items 提取（系统截图、画板、直接粘贴图片二进制）
  for (const item of [...(cd.items ?? [])]) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file && file.size > 0) files.push(file)
    }
  }

  // 2. 兜底从 files 读取
  if (files.length === 0) {
    for (const f of [...(cd.files ?? [])]) {
      if (f.type.startsWith('image/') && f.size > 0) files.push(f)
    }
  }

  // 3. 从 HTML 解析 base64 图片（网页直接复制图）
  if (files.length === 0) {
    const html = cd.getData('text/html')
    if (html) {
      const match = /<img[^>]+src=["'](data:image\/([a-zA-Z0-9+.-]+);base64,([^"']+))["']/i.exec(html)
      if (match?.[3]) {
        try {
          const subtype = (match[2] || 'png').toLowerCase().replace(/[^a-z0-9+.-]/g, '') || 'png'
          const binary = atob(match[3].replace(/\s+/g, ''))
          const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0))
          files.push(new File([bytes], `pasted-image.${subtype}`, { type: `image/${subtype}` }))
        } catch { /* 忽略 */ }
      }
    }
  }

  if (files.length > 0) {
    e.preventDefault()
    void attachImages(files)
  } else {
    // 检查是否复制了 Finder 本地文件（size === 0）
    const hasZeroFile = [...(cd.files ?? [])].some(f => f.type.startsWith('image/') || f.size === 0)
    if (hasZeroFile && cd.types.includes('Files')) {
      e.preventDefault()
      showNotice('无法直接粘贴本地文件副本（系统安全限制），请直接将图片文件拖入输入框', true)
    }
  }
})

let composerDragDepth = 0
const composerEl = document.querySelector('.composer')
if (composerEl) {
  composerEl.addEventListener('dragenter', e => {
    const dt = (e as DragEvent).dataTransfer
    if ([...(dt?.items ?? [])].some(i => i.kind === 'file' || i.type.startsWith('image/'))) {
      composerDragDepth++
      composerEl.classList.add('composer-drag-over')
    }
  })

  composerEl.addEventListener('dragover', e => {
    const dt = (e as DragEvent).dataTransfer
    if ([...(dt?.items ?? [])].some(i => i.kind === 'file' || i.type.startsWith('image/'))) {
      e.preventDefault()
    }
  })

  composerEl.addEventListener('dragleave', () => {
    composerDragDepth = Math.max(0, composerDragDepth - 1)
    if (composerDragDepth === 0) composerEl.classList.remove('composer-drag-over')
  })

  composerEl.addEventListener('drop', e => {
    composerDragDepth = 0
    composerEl.classList.remove('composer-drag-over')
    const dt = (e as DragEvent).dataTransfer
    const files: File[] = []
    for (const item of [...(dt?.items ?? [])]) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f && f.type.startsWith('image/') && f.size > 0) files.push(f)
      }
    }
    if (files.length === 0) {
      for (const f of [...(dt?.files ?? [])]) {
        if (f.type.startsWith('image/') && f.size > 0) files.push(f)
      }
    }
    if (files.length) { e.preventDefault(); void attachImages(files) }
  })
}

$('chatImages').onclick = e => {
  const pill = (e.target as HTMLElement).closest<HTMLButtonElement>('.chat-action-pill')
  if (pill) {
    const prompt = pill.dataset.prompt
    if (prompt) {
      const input = $<HTMLTextAreaElement>('chatInput')
      input.value = prompt
      input.focus()
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return
  }
  const id = ((e.target as HTMLElement).closest('.chip-x')?.parentElement as HTMLElement | undefined)?.dataset.id
  if (id) removeChatImage(id)
}

$('imgUploadBtn')?.addEventListener('click', () => {
  const ctxMenu = document.getElementById('composerContextMenu')
  if (ctxMenu) ctxMenu.hidden = true
  $<HTMLInputElement>('chatImageInput')?.click()
})
document.getElementById('composerContextBtn')?.addEventListener('click', e => {
  e.stopPropagation()
  const btn = e.currentTarget as HTMLElement
  const menu = document.getElementById('composerContextMenu')
  if (!menu) return
  menu.hidden = !menu.hidden
  if (!menu.hidden) placeFixedPopup(menu, btn.getBoundingClientRect(), false)
})
document.getElementById('composerContextMenu')?.addEventListener('click', () => {
  const menu = document.getElementById('composerContextMenu')
  if (menu) menu.hidden = true
})
document.addEventListener('click', e => {
  const menu = document.getElementById('composerContextMenu')
  if (menu && !menu.hidden && !(e.target as HTMLElement).closest('#composerContextBtn')) {
    menu.hidden = true
  }
})
$<HTMLInputElement>('chatImageInput')?.addEventListener('change', e => {
  const input = e.target as HTMLInputElement
  if (input.files && input.files.length) {
    void attachImages([...input.files])
    input.value = ''
  }
})

async function send(): Promise<void> {
  const typed = $<HTMLTextAreaElement>('chatInput').value.trim()
  if ((!typed && chatImages.length === 0) || !session) return
  const text = typed || '请看我附的图片'
  const images = chatImages.map(i => i.id)
  clearAllChatImages()
  $<HTMLTextAreaElement>('chatInput').value = ''
  // 属于患者的文档（病例报告等）：对话自动带上这位患者
  const patients = [...new Set([...(docPatient ? [docPatient] : []), ...patientsUi.takePicked()])]
  try {
    await api(`/api/docs/${session.docId}/chat?async=1`, { method: 'POST', body: JSON.stringify({ message: text, suggest: $<HTMLInputElement>('suggestMode').checked, kb_files: library.takePicked(), datasets: datasets.takePicked(), images, patients, memory: memory.takeMemoryFlag() }) })
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}
$('sendBtn').onclick = () => void send()
$<HTMLTextAreaElement>('chatInput').onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send() }
// 「停止」只停当前任务，排在后面的照常执行；清空排队在任务队列里
$('cancelBtn').onclick = async () => {
  await loadQueue() // 刚发送的任务可能还不在缓存里
  const activeList = queue.active ?? (queue.running ? [queue.running] : [])
  const currentRunning = activeList.find(item => item.doc_id === session?.docId) ?? queue.running
  if (currentRunning) await cancelJob(currentRunning.id)
}

const suggestCheckbox = $<HTMLInputElement>('suggestMode')
const suggestPill = $('suggestModePill')
const suggestText = $('suggestModeText')
const savedSuggest = localStorage.getItem('heurion.suggestMode')
const isSuggestDefault = savedSuggest === null ? true : savedSuggest === '1'
function updateSuggestModeUI(active: boolean): void {
  if (suggestPill) suggestPill.classList.toggle('active', active)
  if (suggestText) suggestText.innerHTML = active ? `${icon('sparkles', { size: 13 })} 修订模式 · 生成 Diff 待采纳` : '直接修改模式（覆盖正文）'
}
if (suggestCheckbox) {
  suggestCheckbox.checked = isSuggestDefault
  updateSuggestModeUI(isSuggestDefault)
  suggestCheckbox.addEventListener('change', () => {
    const active = suggestCheckbox.checked
    localStorage.setItem('heurion.suggestMode', active ? '1' : '0')
    updateSuggestModeUI(active)
  })
}

// —— 任务队列（同一用户的所有文档共用一个队列） ——

interface QueueItem { id: string; doc_id: string; doc_title: string; label: string; suggest: boolean; since: string; comment_id?: string | null }
let queue: { running: QueueItem | null; active?: QueueItem[]; queued: QueueItem[] } = { running: null, active: [], queued: [] }
/** 记录哪些批注卡片曾触发过 AI 处理，用于原地显示「正在修订 → 已生成段落修订建议」状态（Batch 1）。 */
const aiAskedCommentIds = new Set<string>()
const aiCompletedCommentIds = new Set<string>()

function syncCommentAskButtons(): void {
  const activeList = queue.active ?? (queue.running ? [queue.running] : [])
  document.querySelectorAll<HTMLElement>('#comments .card[data-cid]').forEach(card => {
    const cid = card.dataset.cid
    const btn = card.querySelector<HTMLButtonElement>('button[data-act="ask"]')
    if (!cid || !btn) return
    const running = activeList.some(item => item.doc_id === session?.docId && item.comment_id === cid)
    const queued = !running && queue.queued.some(item => item.doc_id === session?.docId && item.comment_id === cid)
    if (running || queued) {
      aiAskedCommentIds.add(cid)
      aiCompletedCommentIds.delete(cid)
    } else if (aiAskedCommentIds.has(cid)) {
      aiAskedCommentIds.delete(cid)
      aiCompletedCommentIds.add(cid)
    }
    btn.disabled = running || queued
    const idleLabel = btn.dataset.defaultLabel || '交给 AI 处理'
    btn.textContent = running ? 'AI 正在修订…' : queued ? '排队中…' : aiCompletedCommentIds.has(cid) ? '再次交给 AI' : idleLabel

    let statusBar = card.querySelector<HTMLElement>('.rv-ai-status-bar')
    if (running || queued || aiCompletedCommentIds.has(cid)) {
      if (!statusBar) {
        statusBar = document.createElement('div')
        statusBar.className = 'rv-ai-status-bar'
        const actionBar = card.querySelector('.rv-action-bar') ?? card.querySelector('.row')
        if (actionBar) card.insertBefore(statusBar, actionBar)
        else card.appendChild(statusBar)
      }
      if (running) {
        statusBar.className = 'rv-ai-status-bar running'
        statusBar.innerHTML = `<span class="subagent-pulse"></span><span>AI 正在对照审稿意见修订对应段落（您可继续审阅下方其他卡片）…</span>`
      } else if (queued) {
        statusBar.className = 'rv-ai-status-bar queued'
        statusBar.innerHTML = `<span class="subagent-pulse"></span><span>已加入 AI 修订队列，正在排队处理…</span>`
      } else {
        statusBar.className = 'rv-ai-status-bar done'
        statusBar.innerHTML = `<span>✓ AI 已生成段落修订建议</span><button type="button" class="small-btn quiet" data-rv-jump-diff="${esc(cid)}">定位查看对比 ↗</button>`
      }
    } else if (statusBar) {
      statusBar.remove()
    }
  })
}

async function loadQueue(): Promise<void> {
  if (!TOKEN) return
  try {
    queue = await api('/api/queue')
  } catch { return }
  renderQueue()
  syncCommentAskButtons()
  // 忙碌状态只按刚取到的队列设置：判断当前打开的文档是否正在执行
  const activeList = queue.active ?? (queue.running ? [queue.running] : [])
  const isCurrentDocBusy = !!session?.docId && activeList.some(item => item.doc_id === session?.docId)
  setBusy(isCurrentDocBusy)
}

function elapsed(since: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000))
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

function renderQueue(): void {
  const activeList = queue.active ?? (queue.running ? [queue.running] : [])
  const items = [...activeList.map(r => ({ ...r, running: true })), ...queue.queued.map(q => ({ ...q, running: false }))]
  // 面板常驻：空闲时只显示一行，有任务时展开
  $('queuePanel').classList.toggle('idle', items.length === 0)
  $('queueClear').hidden = items.length === 0
  const runningCount = activeList.length
  $('queueSummary').textContent = items.length === 0 ? '空闲' : `${runningCount > 0 ? `${runningCount} 个执行中` : ''}${runningCount > 0 && queue.queued.length ? '，' : ''}${queue.queued.length ? `${queue.queued.length} 个排队` : ''}`
  const chatBadge = document.getElementById('chatBadge')
  if (chatBadge) {
    chatBadge.textContent = String(items.length)
    chatBadge.hidden = items.length === 0
  }
  $('queueList').innerHTML = items.map(q => {
    const queuePos = q.running ? '执行中' : `第 ${queue.queued.findIndex(x => x.id === q.id) + 1} 位`
    const isCurrentDocActive = q.running && q.doc_id === session?.docId && activeSubagentTask
    return `
    <li class="${q.running ? 'running' : ''}">
      <div class="queue-main">
        <span class="queue-state">${queuePos}</span>
        <span class="queue-doc${q.doc_id === session?.docId ? ' here' : ''}" data-open="${esc(q.doc_id)}" title="打开这份文档">《${esc(q.doc_title)}》</span>
        ${q.suggest ? '<span class="queue-tag">修订</span>' : ''}
        ${isCurrentDocActive ? `<div class="queue-subagent-tag"><span class="subagent-pulse"></span>协同中：${esc(activeSubagentTask!.role_label)}</div>` : ''}
        <div class="queue-label" title="${esc(q.label)}">${esc(q.label)}</div>
        <div class="muted">${q.running ? '已运行' : '已等待'} ${elapsed(q.since)}</div>
      </div>
      <button data-cancel="${esc(q.id)}">${q.running ? '停止' : '取消'}</button>
    </li>`
  }).join('')
}

async function cancelJob(id: string): Promise<void> {
  try {
    await api(`/api/queue/${id}/cancel`, { method: 'POST' })
  } catch (err) {
    showNotice((err as Error).message, true)
  }
  await loadQueue()
}

$('queueList').onclick = e => {
  const t = e.target as HTMLElement
  const cancel = t.closest('[data-cancel]') as HTMLElement | null
  if (cancel) { void cancelJob(cancel.dataset.cancel!); return }
  const openEl = t.closest('[data-open]') as HTMLElement | null
  if (openEl && openEl.dataset.open && openEl.dataset.open !== session?.docId) {
    const docId = openEl.dataset.open
    const li = $('docList').querySelector<HTMLElement>(`li[data-id="${CSS.escape(docId)}"]`)
    if (li) li.click()
    else void open(docId)
  }
}
$('queueClear').onclick = async () => {
  await api('/api/cancel', { method: 'POST' }).catch(err => showNotice((err as Error).message, true))
  await loadQueue()
}
// 队列跨文档（别的文档里的任务、@heurion 自动触发），定时刷新；有任务时刷得勤一些
let queueTick = 0
setInterval(() => {
  if (document.hidden) return
  queueTick++
  const activeList = queue.active ?? (queue.running ? [queue.running] : [])
  if (activeList.length > 0 || queue.queued.length > 0 || queueTick % 5 === 0) void loadQueue()
}, 2000)
void loadQueue()

// —— 选区悬浮快捷操作条（＋ 批注） ——

function placeFab(): void {
  const fab = $('commentFab')
  if (!anchor) { fab.style.display = 'none'; return }
  const main = document.querySelector('.center')!.getBoundingClientRect()
  fab.style.display = 'inline-flex'
  fab.classList.toggle('blocked', !!anchor.blocked)
  if (anchor.blocked) {
    fab.innerHTML = `<span class="sel-bub-blocked">${esc(anchor.blocked)}</span>`
  } else if (anchor.snippet) {
    fab.innerHTML = `<button type="button" class="sel-bub-btn primary" data-sel-act="comment" title="为选中句子添加批注">＋ 批注</button>`
  } else {
    fab.innerHTML = `<button type="button" class="sel-bub-btn primary" data-sel-act="comment">＋ 批注</button>`
  }
  const fr = fab.getBoundingClientRect()
  const fw = fr.width || 76
  const fh = fr.height || 30
  let top = anchor.rect.top - main.top - fh - 8
  if (top < 8) top = anchor.rect.top - main.top + 28
  let rawLeft = anchor.rect.left - main.left + anchor.rect.width / 2 - fw / 2
  if (!anchor.snippet && !anchor.blocked) {
    // 整个形状的评论：放在形状右侧（右边放不下就放左侧），不压住选中框顶部居中的拖动手柄
    top = anchor.rect.top - main.top
    const right = anchor.rect.left - main.left + anchor.rect.width + 8
    rawLeft = right + fw <= main.width - 8 ? right : anchor.rect.left - main.left - fw - 8
  }
  top = Math.max(8, Math.min(top, Math.max(8, main.height - fh - 8)))
  const left = Math.max(8, Math.min(rawLeft, Math.max(8, main.width - fw - 8)))
  fab.style.top = `${Math.round(top)}px`
  fab.style.left = `${Math.round(left)}px`
}
$('scroller').addEventListener('scroll', () => { $('commentFab').style.display = 'none' })
$('origToggle').onclick = () => setOriginalMode(!$('origToggle').classList.contains('active'))

$('commentFab').onmousedown = async e => {
  e.preventDefault()
  if (!anchor || anchor.blocked) return
  const actBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-sel-act]')
  const act = actBtn?.dataset.selAct || 'comment'
  const curAnchor = { node_id: anchor.node_id, snippet: anchor.snippet, paragraph: anchor.paragraph, range: anchor.range }
  $('commentFab').style.display = 'none'

  if (act === 'polish' && curAnchor.snippet && session) {
    if ($('app').classList.contains('side-collapsed')) setSideCollapsed(false)
    switchTab('chatPane')
    const input = $<HTMLTextAreaElement>('chatInput')
    input.value = `请对以下选中句子进行医学学术润色（保持原意、增强严谨性，直接生成待采纳修订）：\n「${curAnchor.snippet}」`
    void send()
    return
  }

  if (act === 'verify' && curAnchor.snippet && session) {
    if ($('app').classList.contains('side-collapsed')) setSideCollapsed(false)
    switchTab('commentPane')
    try {
      const c = await api(`/api/docs/${session.docId}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ...curAnchor,
          text: '请核查该论断的数据与文献证据支撑，若有需要补充的权威引用请一并给出修订建议。',
        }),
      })
      if (!c.queued) {
        await api(`/api/docs/${session.docId}/comments/${c.id}/ask?async=1`, {
          method: 'POST',
          body: JSON.stringify({ suggest: $<HTMLInputElement>('suggestMode').checked }),
        })
      }
      showNotice('已发起选区证据与引用核查')
      await refresh(false)
    } catch (err) {
      showNotice((err as Error).message, true)
    }
    return
  }

  pendingAnchor = curAnchor
  session?.editor?.highlightPendingAnchor(curAnchor)
  if ($('app').classList.contains('side-collapsed')) setSideCollapsed(false)
  switchTab('commentPane')
  $('newComment').hidden = false
  $('newCommentQuote').textContent = pendingAnchor.snippet || '（整个形状）'
  $<HTMLTextAreaElement>('newCommentText').value = ''
  $('newCommentText').focus()
}
$('newCommentCancel').onclick = () => {
  $('newComment').hidden = true
  pendingAnchor = null
  session?.editor?.highlightPendingAnchor(null)
}

async function saveComment(ask: boolean): Promise<void> {
  const text = $<HTMLTextAreaElement>('newCommentText').value.trim()
  if (!text || !pendingAnchor || !session) return
  try {
    const c = await api(`/api/docs/${session.docId}/comments`, { method: 'POST', body: JSON.stringify({ ...pendingAnchor, text }) })
    $('newComment').hidden = true
    pendingAnchor = null
    session.editor?.highlightPendingAnchor(null)
    if (ask && !c.queued) {
      aiAskedCommentIds.add(c.id)
      await api(`/api/docs/${session.docId}/comments/${c.id}/ask?async=1`, { method: 'POST', body: JSON.stringify({ suggest: $<HTMLInputElement>('suggestMode').checked }) })
      await loadQueue()
      showNotice('已存为批注并加入 AI 修订队列（修订完成后可直接在卡片或正文中查看对比）')
    }
    await refresh(false)
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}
$('newCommentSave').onclick = () => void saveComment(false)
$('newCommentAsk').onclick = () => void saveComment(true)

// —— 统一深度审稿与批注面板（零认知负担：一键审稿 + 审稿偏好抽屉 + 三选一卡片） ——

interface ReviewSnapshotState {
  docId: string
  /** 生成快照时的文档 rev（之后文档有改动时提示快照可能过期）。 */
  rev?: number
  scratchpad?: {
    enrolled_sample_sizes?: number[]
    table_sample_sizes?: number[]
    clone_sample_sizes?: number[]
    declared_summary_metrics?: string[]
    declared_tests?: string[]
  }
  rawCount: number
  createdCount: number
  exemptedCount: number
}

const REVIEW_SNAPSHOT_PREFIX = 'heurion.reviewSnapshot.'

function loadReviewSnapshot(docId: string): ReviewSnapshotState | null {
  try {
    const raw = localStorage.getItem(REVIEW_SNAPSHOT_PREFIX + docId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ReviewSnapshotState
    return parsed?.docId === docId ? parsed : null
  } catch {
    return null
  }
}

function saveReviewSnapshot(snapshot: ReviewSnapshotState): void {
  try {
    localStorage.setItem(REVIEW_SNAPSHOT_PREFIX + snapshot.docId, JSON.stringify(snapshot))
  } catch {
    /* 浏览器禁用本地存储时只保留当前会话 */
  }
}

let lastReviewSnapshot: ReviewSnapshotState | null = null
type ReviewFilter = 'all' | 'critical' | 'major' | 'minor' | 'plain'
let activeReviewFilter: ReviewFilter = 'all'
let reviewSortMode: 'severity' | 'section' = 'severity'
let isRunningDeepReview = false
let deepReviewAbort: AbortController | null = null
/** 右侧批注批量选择（只保存 id；刷新后按当前列表过滤）。 */
const selectedCommentIds = new Set<string>()
let visibleOpenCommentIds: string[] = []
let commentNavCursor = -1
let bulkBusy = false

function formatCleanRuleText(raw: string): string {
  return raw
    .replace(/^\[narrow:review_boundary(?::[^\]]+)?\]\s*/i, '')
    .trim()
}

async function loadReviewRules(): Promise<void> {
  if (!TOKEN) return
  try {
    const res = await api<{ items: Array<{ id: string; content: string; status: string; kind: string }> }>('/api/memory')
    const activeRules = (res.items ?? []).filter(
      m => m.status === 'active' && m.content.includes('[narrow:review_boundary'),
    )
    const countEl = document.getElementById('reviewRulesCount')
    if (countEl) countEl.textContent = String(activeRules.length)
    const listEl = document.getElementById('reviewRulesList')
    if (!listEl) return
    if (activeRules.length === 0) {
      listEl.innerHTML = `<div class="muted small">暂无已记住的审稿偏好。在下方审稿卡片点击「误报 · 以后免报」时，系统会自动提炼并记住您的专科边界规则。</div>`
      return
    }
    listEl.innerHTML = activeRules
      .map(
        r => `
      <div class="review-rule-item" data-mid="${esc(r.id)}">
        <span class="review-rule-dot">●</span>
        <span class="review-rule-text">${esc(formatCleanRuleText(r.content))}</span>
        <button type="button" class="quiet small-btn review-rule-del" data-del-rule="${esc(r.id)}" title="移除此条审稿偏好">✕</button>
      </div>`,
      )
      .join('')
  } catch {
    /* 忽略未登录或网络异常 */
  }
}

document.getElementById('reviewRulesBtn')?.addEventListener('click', () => {
  const drawer = document.getElementById('reviewRulesDrawer')
  if (!drawer) return
  drawer.hidden = !drawer.hidden
  if (!drawer.hidden) void loadReviewRules()
})

document.getElementById('reviewRulesList')?.addEventListener('click', async e => {
  const delBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-del-rule]')
  if (!delBtn?.dataset.delRule) return
  try {
    await api(`/api/memory/${delBtn.dataset.delRule}`, { method: 'DELETE' })
    await loadReviewRules()
    showNotice('已移除该条审稿偏好')
  } catch (err) {
    showNotice((err as Error).message, true)
  }
})

document.getElementById('reviewRuleAddBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('reviewRuleInput') as HTMLInputElement | null
  const text = input?.value.trim()
  if (!text) return
  try {
    await api('/api/memory', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'user',
        kind: 'preference',
        content: `[narrow:review_boundary:custom] ${text}`,
      }),
    })
    if (input) input.value = ''
    await loadReviewRules()
    showNotice('已添加审稿偏好，后续审稿将自动遵循')
  } catch (err) {
    showNotice((err as Error).message, true)
  }
})

async function runDeepReview(): Promise<void> {
  if (!session || isRunningDeepReview) return
  isRunningDeepReview = true
  const abort = new AbortController()
  deepReviewAbort = abort
  const btn = document.getElementById('deepReviewBtn') as HTMLButtonElement | null
  const snapEl = document.getElementById('reviewSnapshotBar')
  if (btn) {
    btn.disabled = true
    btn.textContent = '正在深度审稿…'
  }
  if (snapEl) {
    snapEl.hidden = false
    snapEl.innerHTML = `<div class="rv-progress-line"><span class="subagent-pulse"></span><span>正在通读全文与表格，核查样本量分母、算术自洽、统计方法与结论表述…</span><button type="button" class="small-btn quiet" id="deepReviewCancel">停止等待</button></div>`
    snapEl.querySelector('#deepReviewCancel')?.addEventListener('click', () => abort.abort())
  }
  try {
    // 后台任务 + 轮询：显示每一步的进度（docs/design/REVIEW_QUALITY.md）
    const reviewDocId = session.docId
    const { job_id } = await api<{ job_id: string }>(`/api/docs/${reviewDocId}/deep-review?async=1`, { method: 'POST', signal: abort.signal })
    const r: {
      ok: boolean
      scratchpad?: ReviewSnapshotState['scratchpad']
      raw_candidates_count?: number
      comments_created?: Array<any>
      exempted_count?: number
      warnings?: string[]
      coverage?: ReviewCoverage
    } = await pollReviewJob(api, reviewDocId, job_id, abort.signal, job => { if (snapEl) renderReviewProgress(snapEl, job, () => abort.abort()) })
    lastReviewSnapshot = {
      docId: session.docId,
      scratchpad: r.scratchpad,
      rawCount: r.raw_candidates_count ?? 0,
      createdCount: r.comments_created?.length ?? 0,
      exemptedCount: r.exempted_count ?? 0,
    }
    activeReviewFilter = 'all'
    await refresh(false)
    if (lastReviewSnapshot) {
      lastReviewSnapshot.rev = detail?.rev
      saveReviewSnapshot(lastReviewSnapshot)
    }
    await loadReviewRules()
    renderReviewSnapshot()
    const created = lastReviewSnapshot.createdCount
    const exempted = lastReviewSnapshot.exemptedCount
    const reviewWarnings = r.warnings ?? []
    const exemptNote = exempted > 0 ? `（已按审稿偏好自动免报 ${exempted} 处）` : ''
    // 没检出问题时也不说「全文自洽」：只说没有检出，并说明审了什么、跳过了什么（覆盖范围）
    const cov = coverageText(r.coverage)
    showNotice(
      (created > 0
        ? `深度审稿完成：检出 ${created} 处建议关注项${exemptNote}`
        : `深度审稿完成：未检出问题${exemptNote}`)
        + (cov ? `。${cov}` : '')
        + (reviewWarnings.length ? `。${reviewWarnings.join(' ')}` : ''),
      reviewWarnings.length > 0,
    )
  } catch (err) {
    if (snapEl) snapEl.hidden = true
    if ((err as Error).name === 'AbortError') showNotice('已停止等待深度审稿（服务端可能仍在后台处理，结果会以批注形式出现）')
    else showNotice(`审稿失败：${(err as Error).message}`, true)
  } finally {
    isRunningDeepReview = false
    deepReviewAbort = null
    if (btn) {
      btn.disabled = false
      btn.textContent = '全文深度审稿'
    }
  }
}

document.getElementById('deepReviewBtn')?.addEventListener('click', () => {
  void runDeepReview()
})

interface ParsedReviewMeta {
  isReview: boolean
  severity: 'critical' | 'major' | 'minor'
  severityLabel: string
  categoryKey: string
  categoryLabel: string
  cleanReason: string
  suggestion: string | null
}

function parseReviewComment(c: any): ParsedReviewMeta {
  const aiReplies = (c.replies ?? []).filter((r: any) => r.role === 'ai')
  const firstAi = aiReplies[0]?.text ?? ''
  let suggestion: string | null = null
  for (const r of c.replies ?? []) {
    const m = /【建议修改(?:为)?】：([^\n]+)/.exec(r.text) || /建议修改(?:为)?：([^\n]+)/.exec(r.text)
    if (m) {
      suggestion = m[1]?.trim() ?? null
      break
    }
  }
  const tagMatch = /^\[(CRITICAL|MAJOR|MINOR)\s*\|\s*([^\]]+)\]\s*/i.exec(firstAi)
  const isClaim = firstAi.includes('论断核对：')
  if (!tagMatch && !isClaim) {
    return {
      isReview: false,
      severity: 'minor',
      severityLabel: '批注',
      categoryKey: 'general',
      categoryLabel: '批注',
      cleanReason: firstAi,
      suggestion,
    }
  }
  const rawSev = (tagMatch?.[1] ?? (firstAi.includes('不支持') ? 'critical' : 'major')).toLowerCase()
  const severity: 'critical' | 'major' | 'minor' =
    rawSev === 'critical' ? 'critical' : rawSev === 'major' ? 'major' : 'minor'
  const severityLabel =
    severity === 'critical' ? '数据/算术矛盾' : severity === 'major' ? '方法与统计建议' : '表述与规范'
  const rawCat = (tagMatch?.[2] ?? (isClaim ? 'citation_check' : 'general')).trim().toLowerCase()
  const catMap: Record<string, string> = {
    internal_inconsistency: '正文-表格自洽',
    method_result_mismatch: '统计与方法对齐',
    spin_or_guideline: '结论与报告规范',
    citation_check: '文献证据核对',
  }
  const categoryLabel = catMap[rawCat] ?? '学术规范核查'
  const cleanReason = firstAi
    .replace(/^\[(CRITICAL|MAJOR|MINOR)\s*\|\s*[^\]]+\]\s*/i, '')
    .replace(/^论断核对：\s*/i, '')
    .replace(/\n*【建议修改(?:为)?】：[^\n]+/g, '')
    .trim()

  return {
    isReview: true,
    severity,
    severityLabel,
    categoryKey: rawCat,
    categoryLabel,
    cleanReason,
    suggestion,
  }
}

function renderReviewSnapshot(): void {
  const snapEl = document.getElementById('reviewSnapshotBar')
  if (!snapEl) return
  const list: any[] = detail?.comments ?? []
  const openList = list.filter(c => c.status === 'open')
  const openReviewItems = openList.map(c => ({ c, meta: parseReviewComment(c) })).filter(x => x.meta.isReview)
  const plainCount = openList.filter(c => !parseReviewComment(c).isReview).length
  const hasSnapshot = lastReviewSnapshot && lastReviewSnapshot.docId === session?.docId
  if (!hasSnapshot && openReviewItems.length === 0) {
    snapEl.hidden = true
    snapEl.innerHTML = ''
    return
  }
  snapEl.hidden = false
  const snapshotStale = !!hasSnapshot && lastReviewSnapshot?.rev != null && detail?.rev != null && lastReviewSnapshot.rev !== detail.rev
  const critCount = openReviewItems.filter(x => x.meta.severity === 'critical').length
  const majCount = openReviewItems.filter(x => x.meta.severity === 'major').length
  const minCount = openReviewItems.filter(x => x.meta.severity === 'minor').length
  const sp = hasSnapshot ? lastReviewSnapshot?.scratchpad : undefined
  const exempted = hasSnapshot ? (lastReviewSnapshot?.exemptedCount ?? 0) : 0

  const filterHtml = openList.length > 0 ? `
    <div class="rv-filter-pills">
      <button type="button" class="rv-filter-pill ${activeReviewFilter === 'all' ? 'active' : ''}" data-rv-filter="all">全部 (${openList.length})</button>
      ${critCount > 0 ? `<button type="button" class="rv-filter-pill crit ${activeReviewFilter === 'critical' ? 'active' : ''}" data-rv-filter="critical">数据矛盾 (${critCount})</button>` : ''}
      ${majCount > 0 ? `<button type="button" class="rv-filter-pill maj ${activeReviewFilter === 'major' ? 'active' : ''}" data-rv-filter="major">方法建议 (${majCount})</button>` : ''}
      ${minCount > 0 ? `<button type="button" class="rv-filter-pill min ${activeReviewFilter === 'minor' ? 'active' : ''}" data-rv-filter="minor">规范 (${minCount})</button>` : ''}
      ${plainCount > 0 ? `<button type="button" class="rv-filter-pill ${activeReviewFilter === 'plain' ? 'active' : ''}" data-rv-filter="plain">普通批注 (${plainCount})</button>` : ''}
    </div>
  ` : `<div class="rv-summary-ok">✓ 全文核心数据与方法学核对通过</div>`

  const enrolledStr = sp?.enrolled_sample_sizes?.length ? `N = ${sp.enrolled_sample_sizes.join(' / ')}` : '自动识别中'
  const tableNStr = sp?.table_sample_sizes?.length ? `n = ${sp.table_sample_sizes.join(' / ')}` : '无或与总样本一致'
  const statStr = [...(sp?.declared_summary_metrics ?? []), ...(sp?.declared_tests ?? [])].slice(0, 6).join(' · ') || '常规描述统计'

  snapEl.innerHTML = `
    <div class="rv-snap-top">
      ${filterHtml}
      <div class="rv-snap-actions">
        ${openReviewItems.length > 1 ? `
          <div class="rv-sort-seg" role="group" aria-label="排序方式">
            <button type="button" class="rv-sort-btn ${reviewSortMode === 'severity' ? 'active' : ''}" data-rv-sort="severity" title="优先处理高严重度的数据矛盾与方法学问题">按严重度</button>
            <button type="button" class="rv-sort-btn ${reviewSortMode === 'section' ? 'active' : ''}" data-rv-sort="section" title="按正文从上到下的章节顺序分组">按章节顺序</button>
          </div>
        ` : ''}
        ${openReviewItems.length > 0 ? `<button type="button" class="quiet small-btn rv-copy-btn" data-rv-copy="1" title="将待处理审稿问题复制为 Markdown 清单，方便发给合作者或学生修改">复制清单</button>` : ''}
        ${snapshotStale ? `<span class="rv-stale-badge" title="快照生成后文档已修改，关键数字可能已变化">快照基于 rev ${esc(lastReviewSnapshot!.rev)}</span>` : ''}
        ${exempted > 0 ? `<span class="rv-exempt-badge" title="已根据您的审稿偏好自动过滤同类误报">已按审稿偏好免报 ${exempted} 处</span>` : ''}
      </div>
    </div>
    ${sp ? `
      <details class="rv-scratchpad-details">
        <summary>全文关键数字核对快照（入组 ${esc(enrolledStr)} · 表分母 ${esc(tableNStr)}）</summary>
        <div class="rv-scratchpad-grid">
          <div><span class="muted">入组总样本：</span><b>${esc(enrolledStr)}</b></div>
          <div><span class="muted">表格/亚组分母：</span><b>${esc(tableNStr)}</b></div>
          <div class="full"><span class="muted">统计指标与方法：</span><b>${esc(statStr)}</b></div>
        </div>
      </details>
    ` : ''}
  `
}

document.getElementById('reviewSnapshotBar')?.addEventListener('click', async e => {
  const sortBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-rv-sort]')
  if (sortBtn?.dataset.rvSort) {
    reviewSortMode = sortBtn.dataset.rvSort as 'severity' | 'section'
    renderReviewSnapshot()
    renderComments()
    return
  }
  const copyBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-rv-copy]')
  if (copyBtn) {
    const list: any[] = detail?.comments ?? []
    const openReviewItems = list
      .filter(c => c.status === 'open')
      .map(c => ({ c, meta: parseReviewComment(c) }))
      .filter(x => x.meta.isReview)
    if (openReviewItems.length === 0) return
    const docTitle = detail?.title || '未命名文稿'
    const lines = [
      `# 《${docTitle}》深度审稿核查清单（待处理 ${openReviewItems.length} 项）`,
      '',
      ...openReviewItems.map((item, idx) => {
        const quote = item.c.anchor?.text || item.c.snippet || '（定位段落）'
        const fixLine = item.meta.suggestion ? `\n   - **建议修改**：${item.meta.suggestion}` : ''
        return `${idx + 1}. **[${item.meta.severityLabel} · ${item.meta.categoryLabel}]**\n   - **原句**：「${quote}」\n   - **核查说明**：${item.meta.cleanReason}${fixLine}`
      }),
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n\n'))
      showNotice(`✓ 已复制 ${openReviewItems.length} 项审稿清单到剪贴板`)
    } catch {
      showNotice('复制失败，请检查浏览器剪贴板权限', true)
    }
    return
  }
  const pill = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-rv-filter]')
  if (!pill?.dataset.rvFilter) return
  activeReviewFilter = pill.dataset.rvFilter as ReviewFilter
  commentNavCursor = -1
  renderReviewSnapshot()
  renderComments()
})

function formatCommentTime(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function renderCommentCardHtml(c: any): string {
  const meta = parseReviewComment(c)
  const isReview = meta.isReview
  const replies: any[] = c.replies ?? []
  // 审稿卡片的第一条 AI 回复是审稿理由，正文里单独展示；其余回复（含用户最初的批注）都进讨论区
  const reasonReply = isReview ? replies.find(r => r.role === 'ai') : undefined
  const visibleReplies = reasonReply ? replies.filter(r => r !== reasonReply) : replies
  const originReply = isReview ? reasonReply : replies[0]
  const originLabel = isReview ? 'AI 审稿' : (originReply?.author || '我')
  const originTime = formatCommentTime(originReply?.created_at)
  const quoteText = c.anchor?.text || c.snippet || '（点击定位正文段落）'
  const sectionTitle = c.anchor?.section_title || (session?.kind === 'deck' ? session.deck?.shapeSlideContext(c.node_id) ?? '' : '')
  const secLabel = sectionTitle ? (session?.kind === 'deck' ? sectionTitle.slice(0, 22) : `§ ${sectionTitle.slice(0, 22)}`) : '§ 定位章节'
  const selected = c.status === 'open' && visibleOpenCommentIds.length > 1 && selectedCommentIds.has(c.id)
  const cardClass = ['card', isReview ? 'rv-card' : '', isReview ? `sev-${esc(meta.severity)}` : '', esc(c.status), selected ? 'card-selected' : ''].filter(Boolean).join(' ')
  const cardAttrs = `data-cid="${esc(c.id)}"${isReview ? ` data-cat="${esc(meta.categoryKey)}" data-reason="${esc(meta.cleanReason)}"` : ''}`
  // 初始批注本身不算一次“讨论”；只统计后续回复
  const discussionCount = Math.max(0, replies.length - 1)
  return `
    <div class="${cardClass}" ${cardAttrs}>
      <div class="rv-card-header">
        ${c.status === 'open' && visibleOpenCommentIds.length > 1 ? `<label class="card-select" title="选择此批注"><input type="checkbox" data-select-cid="${esc(c.id)}" ${selected ? 'checked' : ''}></label>` : ''}
        ${isReview ? `<span class="rv-sev-badge sev-${esc(meta.severity)}">${esc(meta.severityLabel)}</span>` : ''}
        <span class="rv-cat-tag">${esc(isReview ? meta.categoryLabel : '批注')}</span>
        <span class="rv-origin">${esc(originLabel)}${originTime ? ` · ${esc(originTime)}` : ''}</span>
        <button type="button" class="rv-sec-badge" data-locate="1" title="点击定位并高亮所属章节与原句">${esc(secLabel)}</button>
        ${typeof c.page === 'number' ? `<button type="button" class="rv-page-badge" data-orig-view="1" title="在原版 PDF 中查看这一处">第 ${c.page} 页</button>` : ''}
        ${c.edited ? `<span class="rv-edited-badge" title="导入后这段在转换稿里改过：原版上的高亮按导入时的文字，可能不准">已修改</span>` : ''}
        <span class="grow"></span>
        ${c.status === 'open' ? `<button type="button" class="quiet small-btn" data-act="delete" title="删除批注">✕</button>` : ''}
      </div>
      <div class="quote" data-locate="1" title="点击在正文中定位并高亮原句与所属章节">
        <span class="quote-text">${esc(quoteText)}</span>
        <span class="quote-locate-pill">定位原文 ↗</span>
      </div>
      ${isReview && meta.cleanReason ? `<div class="rv-reason-body">${lightMarkdown(meta.cleanReason)}</div>` : ''}
      ${isReview && meta.suggestion ? `<div class="rv-suggest-hint"><span class="rv-suggest-hint-tag">修改建议参考</span>${lightMarkdown(meta.suggestion)}</div>` : ''}
      ${visibleReplies.length > 0 ? `<div class="rv-replies-list">${visibleReplies.map((r: any) => {
        const when = formatCommentTime(r.created_at)
        return `<div class="reply ${esc(r.role)}"><b>${r.role === 'ai' ? 'Heurion' : r.author ? esc(r.author) : '我'}</b>${when ? `<span class="reply-time">${esc(when)}</span>` : ''}：${r.role === 'ai' ? lightMarkdown(r.text) : esc(r.text)}</div>`
      }).join('')}</div>` : ''}
      ${c.status === 'open' ? `
        <div class="rv-action-bar${isReview ? '' : ' rv-action-simple'}">
          <button type="button" class="ai small-btn" data-act="ask" data-default-label="交给 AI 处理" title="将该批注（及您的补充要求）交给 AI 修改对应段落">交给 AI 处理</button>
          <button type="button" class="quiet small-btn rv-comment-btn" data-act="toggle-reply" title="添加批注说明、团队讨论或补充改稿要求">批注讨论${discussionCount > 0 ? ` (${discussionCount})` : ''}</button>
          <button type="button" class="quiet small-btn" data-act="resolve" title="关闭此批注并归档（不撤销已完成的修改）">关闭批注</button>
          ${isReview ? `<button type="button" class="quiet small-btn rv-fp-btn" data-act="toggle-fp" title="标记为误报或专科常规写法，系统会自动提炼规则，后续不再误报">误报 · 以后免报</button>` : ''}
        </div>
        <div class="rv-reply-drawer" data-reply-drawer hidden>
          <div class="rv-reply-input-row">
            <input type="text" placeholder="添加批注讨论，或补充具体改稿要求后点「交给 AI 处理」（回车发送批注）…" data-reply>
            <button type="button" class="small-btn primary" data-act="reply">发送批注</button>
          </div>
        </div>
        ${isReview ? `
        <div class="rv-fp-drawer" data-fp-drawer hidden>
          <div class="rv-fp-title">选择原因（系统将自动记住此审稿偏好，后续免报同类情况）：</div>
          <div class="rv-fp-chips">
            <button type="button" class="rv-fp-chip" data-act="exempt-claim" data-rebuttal="本研究自报队列数据，无需外部文献或跨表强行对齐">本研究自报数据</button>
            <button type="button" class="rv-fp-chip" data-act="exempt-claim" data-rebuttal="亚组分析、删失或克隆队列的合理分母差异，并非算术错误">亚组/删失合理分母</button>
            <button type="button" class="rv-fp-chip" data-act="exempt-claim" data-rebuttal="本专科常规学术表述或探索性分析，无需额外校正">专科常规写法</button>
          </div>
          <div class="rv-fp-custom-row">
            <input type="text" data-fp-input placeholder="或输入一句话原因…">
            <button type="button" class="small-btn primary" data-act="exempt-claim">确认免报</button>
          </div>
        </div>` : ''}
      ` : `
        <div class="row rv-resolved-row">
          <span class="muted small">已处理归档</span>
          <span class="grow"></span>
          <button type="button" class="small-btn quiet" data-act="reopen">重新打开</button>
          <button type="button" class="small-btn quiet" data-act="delete">删除</button>
        </div>
      `}
    </div>`
}

function renderComments(): void {
  const list: any[] = detail?.comments ?? []
  const openList = list.filter(c => c.status === 'open')
  const resolvedList = list.filter(c => c.status !== 'open')
  for (const id of [...selectedCommentIds]) {
    if (!openList.some(c => c.id === id)) selectedCommentIds.delete(id)
  }
  const openCount = openList.length
  for (const id of ['commentBadge', 'sideToggleBadge']) {
    const badge = document.getElementById(id)
    if (badge) {
      badge.textContent = String(openCount)
      badge.hidden = openCount === 0
    }
  }
  renderReviewSnapshot()
  void loadReviewRules()

  const filteredOpenList = openList.filter(c => {
    if (activeReviewFilter === 'all') return true
    const meta = parseReviewComment(c)
    if (activeReviewFilter === 'plain') return !meta.isReview
    return meta.isReview && meta.severity === activeReviewFilter
  })
  visibleOpenCommentIds = filteredOpenList.map(c => c.id)
  const selectedVisible = filteredOpenList.filter(c => selectedCommentIds.has(c.id))
  const allVisibleSelected = filteredOpenList.length > 0 && selectedVisible.length === filteredOpenList.length
  const bulkBar = filteredOpenList.length > 1
    ? `<div class="comment-bulk-bar${selectedVisible.length > 0 ? ' active' : ''}" data-bulk-bar>
        <label class="comment-select-all"><input type="checkbox" data-select-all ${allVisibleSelected ? 'checked' : ''}> 全选当前 ${filteredOpenList.length} 条</label>
        <span class="comment-nav-actions">
          <button type="button" class="quiet small-btn" data-comment-nav="-1" title="上一条未处理批注（⌥↑）">↑</button>
          <button type="button" class="quiet small-btn" data-comment-nav="1" title="下一条未处理批注（⌥↓）">↓</button>
        </span>
        <span class="grow"></span>
        ${selectedVisible.length > 0
          ? `<span class="muted small">已选 ${selectedVisible.length} 条</span>
             <button type="button" class="small-btn ai" data-bulk-act="ask" ${bulkBusy ? 'disabled' : ''}>AI 修订</button>
             <button type="button" class="small-btn quiet" data-bulk-act="resolve" ${bulkBusy ? 'disabled' : ''}>关闭</button>
             <button type="button" class="small-btn quiet" data-bulk-act="clear" ${bulkBusy ? 'disabled' : ''}>清除</button>`
          : `<span class="muted small">勾选卡片左侧复选框可批量处理</span>`}
      </div>`
    : ''

  const sevRank: Record<'critical' | 'major' | 'minor', number> = { critical: 3, major: 2, minor: 1 }
  let openHtml = bulkBar
  if (filteredOpenList.length === 0) {
    openHtml = openList.length === 0
      ? `<div class="rv-empty-hint muted">${resolvedList.length > 0 ? `当前待处理问题已全部清零（下方已归档 ${resolvedList.length} 项）。` : ''}点击上方 <b>「全文深度审稿」</b> 一键核查全文数据自洽与统计规范；也可以在正文中选中句子手动添加批注。</div>`
      : `<div class="rv-empty-hint muted">当前筛选条件下无待处理项。</div>`
  } else if (reviewSortMode === 'section') {
    const groups = new Map<string, any[]>()
    for (const c of filteredOpenList) {
      const sec = (c.anchor?.section_title || '正文段落与综合讨论').trim()
      const arr = groups.get(sec) ?? []
      arr.push(c)
      groups.set(sec, arr)
    }
    openHtml += Array.from(groups.entries())
      .map(
        ([secName, items]) => `
        <div class="rv-sec-group">
          <div class="rv-sec-group-head"><span>§ ${esc(secName)}</span><span class="muted">${items.length} 项</span></div>
          ${items.map(renderCommentCardHtml).join('')}
        </div>`,
      )
      .join('')
  } else {
    const sorted = [...filteredOpenList].sort((a, b) => {
      const ma = parseReviewComment(a)
      const mb = parseReviewComment(b)
      return sevRank[mb.severity] - sevRank[ma.severity]
    })
    openHtml += sorted.map(renderCommentCardHtml).join('')
  }

  const resolvedDrawerHtml = resolvedList.length > 0
    ? `<details class="rv-resolved-drawer">
        <summary>已处理归档 (${resolvedList.length})</summary>
        <div class="rv-resolved-list">${resolvedList.map(renderCommentCardHtml).join('')}</div>
      </details>`
    : ''

  $('comments').innerHTML = openHtml + resolvedDrawerHtml
  syncCommentAskButtons()
  syncManuscriptReviewHighlights(openList)
}

function selectedOpenComments(): any[] {
  const visible = new Set(visibleOpenCommentIds)
  return (detail?.comments ?? []).filter((c: any) => c.status === 'open' && selectedCommentIds.has(c.id) && visible.has(c.id))
}

async function bulkAskSelected(): Promise<void> {
  if (!session || bulkBusy) return
  const selected = selectedOpenComments().map(c => ({ c, meta: parseReviewComment(c) }))
  if (selected.length === 0) return
  if (!await askConfirm({
    title: '批量交给 AI 修订',
    message: `将把选中的 ${selected.length} 条批注一次性交给 AI，按修订模式生成待采纳对比。修改完成后批注会保持待确认，由你逐条或批量关闭。`,
    confirm: '交给 AI',
  })) return
  bulkBusy = true
  renderComments()
  const summaryTasks = selected.map((item, idx) => {
    const quote = item.c.anchor?.text || item.c.snippet || '（定位段落）'
    const fix = item.meta.suggestion ? `（参考修改建议：${item.meta.suggestion}）` : ''
    const issue = item.meta.isReview
      ? item.meta.cleanReason
      : ((item.c.replies ?? []).filter((r: any) => r.role === 'user').at(-1)?.text ?? '请按批注要求处理')
    const label = item.meta.isReview ? item.meta.severityLabel : '普通批注'
    return `${idx + 1}. [${label}] 原句：「${quote}」 -> 要求：${issue} ${fix}`
  }).join('\n')
  try {
    await api(`/api/docs/${session.docId}/chat?async=1`, {
      method: 'POST',
      body: JSON.stringify({
        message: `请按修订模式（生成待采纳对比）逐条处理以下 ${selected.length} 条批注，修改正文中对应的段落或表格。修改完成后保持对应批注为待确认状态，不要自行关闭：\n${summaryTasks}`,
        suggest: true,
      }),
    })
    selectedCommentIds.clear()
    await loadQueue()
    showNotice(`已提交 ${selected.length} 条批注的批量修订，进度可在「AI 助手」查看`)
  } catch (err) {
    showNotice((err as Error).message, true)
  } finally {
    bulkBusy = false
    renderComments()
  }
}

async function bulkCloseSelected(): Promise<void> {
  if (!session || bulkBusy) return
  const selected = selectedOpenComments()
  if (selected.length === 0) return
  if (!await askConfirm({
    title: '批量关闭批注',
    message: `关闭选中的 ${selected.length} 条批注并归档？正文内容不会被修改。`,
    confirm: '关闭批注',
  })) return
  bulkBusy = true
  renderComments()
  try {
    const results = await Promise.allSettled(selected.map(c => api(`/api/docs/${session!.docId}/comments/${c.id}/resolve`, { method: 'POST' })))
    const failed = results.filter(r => r.status === 'rejected').length
    selectedCommentIds.clear()
    await refresh(false)
    showNotice(failed > 0 ? `已关闭 ${selected.length - failed} 条，${failed} 条失败` : `已关闭 ${selected.length} 条批注`, failed > 0)
  } catch (err) {
    showNotice((err as Error).message, true)
  } finally {
    bulkBusy = false
    renderComments()
  }
}

function navigateComment(delta: number): void {
  if (!session || visibleOpenCommentIds.length === 0) return
  commentNavCursor = (commentNavCursor + delta + visibleOpenCommentIds.length) % visibleOpenCommentIds.length
  const id = visibleOpenCommentIds[commentNavCursor]!
  locateCommentInDoc(id)
  document.querySelector<HTMLElement>(`#comments [data-cid="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function syncManuscriptReviewHighlights(openList: any[]): void {
  if (!session?.editor) return
  const openIds = new Set(openList.map(c => c.id))
  // 已关闭（或已删除）批注对应的论断核查记录不再在正文里划线；重新打开后恢复
  const baseChecks: any[] = (Array.isArray(detail?.claim_checks) ? detail.claim_checks : [])
    .filter((chk: any) => !chk.comment_id || openIds.has(chk.comment_id))
  const existingCommentIds = new Set(baseChecks.map(chk => chk.comment_id).filter(Boolean))
  const reviewChecks: Array<{ claim_id: string; node_id: string; sentence: string; verdict: string; reason: string; severity?: string }> = []
  const sevByClaimId = new Map<string, 'critical' | 'major' | 'minor'>()

  for (const chk of baseChecks) {
    if (chk.claim_id) {
      sevByClaimId.set(chk.claim_id, chk.verdict === 'unsupported' ? 'critical' : 'major')
    }
  }

  for (const c of openList) {
    const meta = parseReviewComment(c)
    if (!meta.isReview) continue
    sevByClaimId.set(c.id, meta.severity)
    if (existingCommentIds.has(c.id)) continue
    const sentence = (c.anchor?.text || c.snippet || '').trim()
    const nodeId = c.anchor?.node_ids?.[0] || c.node_id || ''
    if (!sentence && !nodeId) continue
    reviewChecks.push({
      claim_id: c.id,
      node_id: nodeId,
      sentence,
      verdict: `${meta.severityLabel} · ${meta.categoryLabel}`,
      reason: meta.cleanReason,
    })
  }

  session.editor.setClaimChecks([...baseChecks, ...reviewChecks])

  requestAnimationFrame(() => {
    document.querySelectorAll<HTMLElement>('#page .claim-warn-text[data-claim-id], #page .claim-warn-block[data-claim-id]').forEach(el => {
      const cid = el.dataset.claimId ?? ''
      const sev = sevByClaimId.get(cid)
      if (sev) el.dataset.rvSev = sev
    })
    document.querySelectorAll<HTMLElement>('#page mark.comment[data-thread]').forEach(el => {
      const tid = el.dataset.thread ?? ''
      const sev = sevByClaimId.get(tid)
      if (sev) el.dataset.rvSev = sev
      else delete el.dataset.rvSev
    })
    document.querySelectorAll<HTMLElement>('#page [data-comment]').forEach(el => {
      const ids = (el.dataset.comment ?? '').split(/\s+/).filter(Boolean)
      const matchedSev = ids.map(id => sevByClaimId.get(id)).find(Boolean)
      if (matchedSev) el.dataset.rvSev = matchedSev
      else delete el.dataset.rvSev
    })
  })
}

function locateCommentInDoc(cid: string): void {
  const navIndex = visibleOpenCommentIds.indexOf(cid)
  if (navIndex >= 0) commentNavCursor = navIndex
  const card = document.querySelector<HTMLElement>(`#comments [data-cid="${CSS.escape(cid)}"]`)
  document.querySelectorAll('#comments .card.card-active-focus').forEach(el => el.classList.remove('card-active-focus'))
  card?.classList.add('card-active-focus')

  const c = (detail?.comments ?? []).find((x: any) => x.id === cid)
  const check = (detail?.claim_checks ?? []).find((x: any) => x.comment_id === cid || x.claim_id === cid)

  // 原版视图里：滚到原版上的位置（锚定的块在原版里没有对应位置时，提示到转换稿里看）
  if (origView && !origView.el.hasAttribute('hidden')) {
    if (!origView.scrollToComment(cid) && !origView.scrollToNode(c?.anchor?.node_ids?.[0] ?? c?.node_id ?? '')) {
      showNotice('这条评论锚定的内容在原版里没有对应位置（导入后新写的内容），请切换到转换稿查看')
    }
    return
  }

  if (session?.editor) {
    const res = session.editor.locateAndHighlightComment({
      commentId: cid,
      claimId: check?.claim_id,
      nodeId: c?.node_id ?? check?.node_id,
      nodeIds: c?.anchor?.node_ids ?? (check?.node_id ? [check.node_id] : undefined),
      sectionNodeId: c?.anchor?.section_node_id,
      snippet: c?.anchor?.text || c?.snippet || check?.sentence,
    })
    if (res.sectionTitle && card) {
      const secBtn = card.querySelector<HTMLElement>('.rv-sec-badge')
      if (secBtn && secBtn.textContent?.includes('定位章节')) {
        secBtn.textContent = `§ ${res.sectionTitle.slice(0, 22)}`
      }
    }
    return
  }

  // Deck 幻灯片模式定位回退
  const target = document.querySelector<HTMLElement>(`[data-comment~="${CSS.escape(cid)}"]`)
    ?? (c?.node_id ? document.querySelector<HTMLElement>(`[data-id="${CSS.escape(c.node_id)}"]`) : null)
    ?? (check?.node_id ? document.querySelector<HTMLElement>(`[data-id="${CSS.escape(check.node_id)}"]`) : null)
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target?.classList.add('ai-flash')
  setTimeout(() => target?.classList.remove('ai-flash'), 1600)
}

$('comments').onkeydown = e => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
  const input = (e.target as HTMLElement).closest<HTMLInputElement>('input[data-reply]')
  if (!input) return
  const card = input.closest<HTMLElement>('[data-cid]')
  const replyBtn = card?.querySelector<HTMLButtonElement>('button[data-act="reply"]')
  if (replyBtn && input.value.trim()) {
    e.preventDefault()
    replyBtn.click()
  }
}

$('comments').addEventListener('change', e => {
  const input = e.target as HTMLInputElement
  if (input.matches('[data-select-all]')) {
    if (input.checked) visibleOpenCommentIds.forEach(id => selectedCommentIds.add(id))
    else visibleOpenCommentIds.forEach(id => selectedCommentIds.delete(id))
    renderComments()
    return
  }
  if (!input.matches('input[data-select-cid]')) return
  const id = input.dataset.selectCid
  if (!id) return
  if (input.checked) selectedCommentIds.add(id)
  else selectedCommentIds.delete(id)
  renderComments()
})

document.addEventListener('keydown', e => {
  if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
  if (!session || document.querySelector('.dialog:not([hidden])')) return
  if (!$('commentPane').classList.contains('active')) return
  const target = e.target as HTMLElement
  if (target.closest('input, textarea, [contenteditable="true"]')) return
  if (visibleOpenCommentIds.length === 0) return
  e.preventDefault()
  navigateComment(e.key === 'ArrowDown' ? 1 : -1)
})

$('comments').onclick = async e => {
  const targetEl = e.target as HTMLElement
  const navBtn = targetEl.closest<HTMLButtonElement>('[data-comment-nav]')
  if (navBtn?.dataset.commentNav) {
    navigateComment(Number(navBtn.dataset.commentNav))
    return
  }
  const bulkBtn = targetEl.closest<HTMLButtonElement>('[data-bulk-act]')
  if (bulkBtn?.dataset.bulkAct) {
    if (bulkBtn.dataset.bulkAct === 'ask') void bulkAskSelected()
    else if (bulkBtn.dataset.bulkAct === 'resolve') void bulkCloseSelected()
    else if (bulkBtn.dataset.bulkAct === 'clear') { selectedCommentIds.clear(); renderComments() }
    return
  }
  // 勾选框只负责选择，不触发卡片定位
  if (targetEl.closest('.card-select, .comment-select-all, input[data-select-cid], input[data-select-all]')) return
  const jumpDiffBtn = targetEl.closest<HTMLElement>('[data-rv-jump-diff]')
  if (jumpDiffBtn?.dataset.rvJumpDiff) {
    locateCommentInDoc(jumpDiffBtn.dataset.rvJumpDiff)
    jumpToSuggestion(1)
    return
  }
  // 「第 N 页」：切到原版并定位（原版第一次打开时等加载完再定位）
  const origBtn = targetEl.closest<HTMLElement>('[data-orig-view]')
  if (origBtn) {
    const cid = origBtn.closest<HTMLElement>('[data-cid]')?.dataset.cid
    if (!cid) return
    if (!origView || origView.el.hasAttribute('hidden')) {
      const fresh = !origView
      if (fresh) pendingOrigFocus = cid
      setOriginalMode(true)
      if (!fresh) locateCommentInDoc(cid)
    } else locateCommentInDoc(cid)
    return
  }
  const locateTrigger = targetEl.closest('[data-locate]') as HTMLElement | null
  if (locateTrigger) {
    const card = locateTrigger.closest<HTMLElement>('[data-cid]')
    if (card?.dataset.cid) locateCommentInDoc(card.dataset.cid)
    return
  }
  const btn = targetEl.closest('button[data-act]') as HTMLButtonElement | null
  if (!btn) {
    // 点击卡片空白或理由区域（非输入框/文本框/抽屉）时，同样自动定位并高亮对应章节与原句
    if (!targetEl.closest('input, textarea, a, .rv-fp-drawer, .rv-reply-drawer, .rv-suggest-box')) {
      const clickedCard = targetEl.closest<HTMLElement>('[data-cid]')
      if (clickedCard?.dataset.cid) locateCommentInDoc(clickedCard.dataset.cid)
    }
    return
  }
  if (!session) return
  const card = btn.closest('[data-cid]') as HTMLElement
  const cid = card.dataset.cid!
  const act = btn.dataset.act

  if (act === 'toggle-reply') {
    const replyDrawer = card.querySelector<HTMLElement>('[data-reply-drawer]')
    if (replyDrawer) {
      replyDrawer.hidden = !replyDrawer.hidden
      if (!replyDrawer.hidden) {
        locateCommentInDoc(cid)
        replyDrawer.querySelector<HTMLInputElement>('[data-reply]')?.focus()
      }
    }
    return
  }
  if (act === 'toggle-fp') {
    const fpDrawer = card.querySelector<HTMLElement>('[data-fp-drawer]')
    if (fpDrawer) {
      fpDrawer.hidden = !fpDrawer.hidden
      if (!fpDrawer.hidden) fpDrawer.querySelector<HTMLInputElement>('[data-fp-input]')?.focus()
    }
    return
  }

  const input = card.querySelector<HTMLInputElement>('[data-reply]')
  const text = input?.value.trim() ?? ''
  try {
    if (act === 'apply-claim-fix') {
      const fixInput = card.querySelector<HTMLTextAreaElement>('[data-fix-input]')
      const fix = fixInput?.value.trim() || btn.dataset.fix || ''
      await api(`/api/docs/${session.docId}/comments/${cid}/apply-claim-fix`, {
        method: 'POST',
        body: JSON.stringify({ replace: fix }),
      })
      showNotice('✓ 已采纳修改并更新正文')
    } else if (act === 'exempt-claim') {
      const fpInput = card.querySelector<HTMLInputElement>('[data-fp-input]')
      const rebuttal = btn.dataset.rebuttal || fpInput?.value.trim() || '本专科常规学术写法/本研究自报数据，以后免报同类情况'
      const quoteText = card.querySelector('.quote')?.textContent ?? ''
      await api(`/api/docs/${session.docId}/comments/${cid}/exempt-claim`, {
        method: 'POST',
        body: JSON.stringify({
          rebuttal,
          category: card.dataset.cat || undefined,
          sentence: quoteText,
          reason: card.dataset.reason || undefined,
        }),
      })
      await loadReviewRules()
      const rulesBtn = document.getElementById('reviewRulesBtn')
      rulesBtn?.classList.add('card-highlight')
      setTimeout(() => rulesBtn?.classList.remove('card-highlight'), 1500)
      showNotice('✓ 已记住该审稿偏好，后续审稿将自动豁免同类表述')
    } else if (act === 'reply') {
      if (!text) return
      await api(`/api/docs/${session.docId}/comments/${cid}/replies`, { method: 'POST', body: JSON.stringify({ text }) })
    } else if (act === 'ask') {
      if (btn.disabled) return
      btn.disabled = true
      btn.textContent = '排队中…'
      aiAskedCommentIds.add(cid)
      aiCompletedCommentIds.delete(cid)
      syncCommentAskButtons()
      await api(`/api/docs/${session.docId}/comments/${cid}/ask?async=1`, { method: 'POST', body: JSON.stringify({ text, suggest: $<HTMLInputElement>('suggestMode').checked }) })
      await loadQueue()
      // 保持停留在「审稿与批注」Tab（不强制切去 AI 助手），卡片原地显示 AI 正在修订状态（Batch 1）
    } else if (act === 'delete') {
      if (!await askConfirm({ title: '删除批注', message: '删除这条批注及其全部回复？正文里的标记也会去掉。', confirm: '删除', danger: true })) return
      await api(`/api/docs/${session.docId}/comments/${cid}`, { method: 'DELETE' })
    } else {
      await api(`/api/docs/${session.docId}/comments/${cid}/${act}`, { method: 'POST' })
    }
    await refresh(false)
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}

// —— 修订 ——

let resolvingSuggestion: Promise<void> | null = null

async function resolveSuggestion(group: string, accept: boolean): Promise<void> {
  if (!session) return
  const docId = session.docId
  const task = (async () => {
    try {
      await api(`/api/docs/${docId}/suggestions/${group}/${accept ? 'accept' : 'reject'}`, { method: 'POST' })
      await refresh(false)
    } catch (err) {
      showNotice((err as Error).message, true)
    }
  })()
  resolvingSuggestion = task
  try {
    await task
  } finally {
    if (resolvingSuggestion === task) resolvingSuggestion = null
  }
}

// 待采纳修订：在正文上方、对话输入框上方及最新 AI 回复中同步展示醒目审查条；逐处采纳 / 拒绝在正文里的修订条上
let suggestCursor = -1

// 审查条是插在修订块正前方（或单元格开头）的挂件：高亮紧随其后的同组块，其次是所在的同组容器，
// 不能用全局第一个同组块，否则跨章节的修订会高亮到别处
function suggestBlockNearBar(bar: HTMLElement, group: string): HTMLElement | null {
  const sel = `[data-suggest-group="${CSS.escape(group)}"]:not(.suggest-paired-delete)`
  for (let el = bar.nextElementSibling; el; el = el.nextElementSibling) {
    if (el.matches(sel)) return el as HTMLElement
    if (el.matches('.suggest-bar')) break
  }
  return bar.parentElement?.closest<HTMLElement>(sel) ?? null
}

function jumpToSuggestion(step = 1): void {
  const bars = Array.from(document.querySelectorAll<HTMLElement>('.suggest-bar[data-suggest-bar-group]'))
  const targets = bars.length > 0
    ? bars
    : Array.from(document.querySelectorAll<HTMLElement>('[data-suggest-group]:not(.suggest-paired-delete)'))
  if (targets.length === 0) return
  suggestCursor = (suggestCursor + step + targets.length) % targets.length
  const target = targets[suggestCursor]!
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target.classList.add('ai-flash')
  const group = target.dataset.suggestBarGroup ?? target.dataset.suggestGroup
  const blk = group && target.dataset.suggestBarGroup ? suggestBlockNearBar(target, group) : null
  blk?.classList.add('ai-flash')
  setTimeout(() => {
    target.classList.remove('ai-flash')
    blk?.classList.remove('ai-flash')
  }, 1400)
}

function attachChatReviewBar(container: HTMLElement, count: number): void {
  // 待采纳计数是全文档的总数，对话里只保留一条审查条（挂在最新的回复上），避免多条计数互相矛盾
  document.querySelectorAll('#chatLog .chat-turn-review-bar').forEach(el => el.remove())
  container.querySelector('.chat-turn-review-bar')?.remove()
  const bar = document.createElement('div')
  bar.className = 'chat-turn-review-bar'
  bar.innerHTML = `
    <span class="badge-pill rev"><span class="dot"></span> AI 提出了 ${count} 处待采纳修订（采纳后正式生效）</span>
    <div class="chat-turn-review-actions">
      <button type="button" class="btn-jump-review secondary" data-act="jump">定位查看</button>
      <button type="button" class="btn-jump-review secondary" data-act="reject">全部拒绝</button>
      <button type="button" class="btn-jump-review" data-act="accept">全部采纳</button>
    </div>
  `
  bar.addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')
    if (!btn) return
    if (btn.dataset.act === 'jump') jumpToSuggestion(1)
    else if (btn.dataset.act === 'accept') void resolveSuggestion('all', true)
    else if (btn.dataset.act === 'reject') void resolveSuggestion('all', false)
  })
  container.appendChild(bar)
}

function renderSuggestions(): void {
  const groups: any[] = detail?.suggestions ?? []
  $('suggestBanner').hidden = groups.length === 0
  // 消除重复横幅噪音（Batch 2）：正文顶部仅保留一条统一状态栏，不再与 turnBanner 或输入框上方横幅重复叠加
  const chatBanner = document.getElementById('chatSuggestBanner')
  if (chatBanner) chatBanner.hidden = true
  if (groups.length > 0) {
    hideTurnBanner()
  }
  if (groups.length === 0) {
    suggestCursor = -1
    document.querySelectorAll('#chatLog .chat-turn-review-bar').forEach(el => el.remove())
    return
  }
  const blocks = groups.reduce((n, g) => n + g.inserts + g.deletes, 0)
  $('suggestSummary').textContent = `待审阅修订（${groups.length} 处 · 涉及 ${blocks} 块）`
  const existingBars = document.querySelectorAll<HTMLElement>('#chatLog .chat-turn-review-bar')
  if (existingBars.length > 0) {
    existingBars.forEach(bar => {
      const pill = bar.querySelector('.badge-pill.rev')
      if (pill) pill.innerHTML = `<span class="dot"></span> AI 提出了 ${groups.length} 处待采纳修订（采纳后正式生效）`
    })
  } else {
    const assistantMsgs = document.querySelectorAll<HTMLElement>('#chatLog .msg.assistant:not(.error)')
    const lastMsg = assistantMsgs[assistantMsgs.length - 1]
    if (lastMsg) attachChatReviewBar(lastMsg, groups.length)
  }
}

$('suggestBanner').onclick = e => {
  const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  if (!t) return
  if (t.dataset.all) { void resolveSuggestion('all', t.dataset.all === '1'); return }
  if (t.dataset.nav) {
    jumpToSuggestion(Number(t.dataset.nav))
  }
}

document.getElementById('chatSuggestBanner')?.addEventListener('click', e => {
  const t = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-chat-sug]')
  if (!t) return
  const act = t.dataset.chatSug
  if (act === 'jump') jumpToSuggestion(1)
  else if (act === 'accept') void resolveSuggestion('all', true)
  else if (act === 'reject') void resolveSuggestion('all', false)
})

// —— 版本与引用 ——

const SOURCE: Record<string, string> = { create: '新建', import: '导入', turn: 'AI', user: '保存', restore: '回滚' }

function renderVersions(): void {
  $('versions').innerHTML = `<div class="row" style="margin-bottom:8px"><button id="saveVersion">保存当前为版本</button></div>` +
    (detail?.versions ?? []).map((v: any) => `<div class="vitem" data-vseq="${esc(v.seq)}"><div><b>v${esc(v.seq)}</b> · ${esc(SOURCE[v.source] ?? v.source)} · ${esc(v.note)}<div class="muted">rev ${esc(v.rev)} · ${new Date(v.created_at).toLocaleString()}</div></div>
      <div class="row"><button data-diff="${esc(v.seq)}">对比</button><button data-restore="${esc(v.seq)}">回滚</button></div></div>`).join('')
  $('saveVersion').onclick = async () => {
    if (!session) return
    await api(`/api/docs/${session.docId}/save`, { method: 'POST' })
    await refresh(false)
  }
}

$('versions').onclick = async e => {
  const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  const d = btn?.dataset ?? (e.target as HTMLElement).dataset
  if (!session) return
  if (d.closeDiff) {
    btn?.closest('.vitem-diff-box')?.remove()
    $('diffView').innerHTML = ''
    return
  }
  if (d.restore && await askConfirm({ title: `回滚到 v${d.restore}`, message: '文档会恢复成这个版本的内容。回滚本身会生成一个新版本，之前的历史都保留，随时可以再回到现在。', confirm: '回滚' })) {
    try {
      await api(`/api/docs/${session.docId}/versions/${d.restore}/restore`, { method: 'POST' })
      $('diffView').innerHTML = ''
      await refresh(false)
    } catch (err) {
      showNotice((err as Error).message, true)
    }
  }
  if (d.diff) {
    const vitem = (e.target as HTMLElement).closest<HTMLElement>('.vitem')
    const existingBox = vitem?.querySelector<HTMLElement>('.vitem-diff-box')
    if (existingBox) {
      existingBox.remove()
      $('diffView').innerHTML = ''
      return
    }
    const r = await api(`/api/docs/${session.docId}/diff?from=${d.diff}`)
    const label: Record<string, string> = { added: '新增', removed: '删除', modified: '修改' }
    const changesHtml = r.changes.length === 0
      ? '<div class="muted small">与当前版本内容完全一致，无变化</div>'
      : r.changes.map((c: any) =>
        `<div class="${esc(c.kind)}">[${esc(label[c.kind] ?? c.kind)}] ${esc(c.kind === 'removed' ? c.before : c.after)}${c.kind === 'modified' ? `<div class="muted">原：${esc(c.before)}</div>` : ''}</div>`).join('')
    const boxHtml = `
      <div class="vitem-diff-head">
        <b>v${esc(d.diff)} → 当前版本差异对比（${r.changes.length} 处）</b>
        <span class="grow"></span>
        <button type="button" class="small-btn primary" data-restore="${esc(d.diff)}">恢复到此版本 v${esc(d.diff)}</button>
        <button type="button" class="small-btn quiet" data-close-diff="1">收起 ✕</button>
      </div>
      <div class="vitem-diff-body">${changesHtml}</div>
    `
    $('diffView').innerHTML = `<div class="vitem-diff-box">${boxHtml}</div>`
    document.querySelectorAll('#versions .vitem-diff-box').forEach(el => el.remove())
    if (vitem) {
      const inlineBox = document.createElement('div')
      inlineBox.className = 'vitem-diff-box'
      inlineBox.innerHTML = boxHtml
      vitem.appendChild(inlineBox)
      inlineBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }
}

const VERDICT: Record<string, string> = { supported: '支持', unsupported: '不支持', unclear: '无法判断', missing_citation: '缺出处' }
const TIER_LABEL: Record<string, string> = { table: '全文表格核验', fulltext: '全文正文核验', abstract: '仅摘要核验', none: '无原文证据' }

/** 平台引用合并进正文末尾用户自己的文献表时的说明（引用页常驻、导出时提示）；没有合并返回 null。 */
function refMergeText(): string | null {
  const n = detail?.citation_numbering
  if (!n || !n.user_refs) return null
  return `正文末尾已有你自己的参考文献表（${n.user_refs} 条）：平台引用已合并进去，从 [${n.user_refs + 1}] 起编号`
    + (n.duplicates ? `；其中 ${n.duplicates} 条与表中已有文献相同，沿用原编号` : '')
}

/** 最近一次导入参考文献的结果（重绘引用页时保留）。 */
let refImportHtml = ''

function renderCites(): void {
  const list: any[] = detail?.citations ?? []
  $('cites').innerHTML =
    `<div class="card"><div class="row"><b>参考文献 (${list.length})</b><span class="grow"></span><button id="refImportBtn" class="small-btn" title="从 Zotero / EndNote / Mendeley / PubMed 导出的文件，或每行一个 DOI / PMID">导入文献</button>
      <input type="file" id="refImportInput" accept=".ris,.bib,.nbib,.txt,.xml,.enw" hidden></div>
      <div class="muted small" style="margin:4px 0">按 DOI / PMID 自动核实登记，点击正文 [n] 上标或下方卡片可双向联动定位（Batch 5）。</div>${refMergeText() ? `<div class="ref-merge-note">${esc(refMergeText())}；导出 Word / Markdown 时合并成一份文献表。</div>` : ''}<div id="refImportResult">${refImportHtml}</div></div>` +
    (list.length === 0 ? '<div class="muted small" style="margin:8px 0">暂无已登记引用。点击上方「导入文献」或在正文工具栏点「引用」添加。</div>' : list.map(c => {
      const cid = c.id || c.cite_id || ''
      const rawDoi = typeof c.doi === 'string' ? c.doi.trim() : ''
      const pmidFromDoi = rawDoi.toLowerCase().startsWith('pmid:') ? rawDoi.slice(5).trim() : ''
      const effectivePmid = c.pmid ? String(c.pmid).trim() : pmidFromDoi
      const candidateUrl = typeof c.url === 'string' && /^https?:\/\//i.test(c.url)
        ? c.url
        : (rawDoi.startsWith('10.')
          ? `https://doi.org/${encodeURIComponent(rawDoi)}`
          : (effectivePmid ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(effectivePmid)}/` : ''))
      return `<div class="card cite-card-item" data-cite-id="${esc(cid)}">
        <div class="cite-card-main"><b>${c.number ? `[${esc(c.number)}]` : '[未引用]'}</b> ${esc(c.formatted)}</div>
        <div class="cite-card-actions">
          ${session?.kind === 'doc' ? `<button type="button" class="small-btn quiet" data-cite-act="insert" data-cid="${esc(cid)}" title="将此文献引用标记插入正文当前光标处">＋ 插入到光标处</button>` : ''}
          ${c.number ? `<button type="button" class="small-btn quiet" data-cite-act="locate" data-cid="${esc(cid)}" title="在正文中定位并高亮引用该文献的句子">定位正文引用 ↗</button>` : ''}
          ${candidateUrl ? `<a class="small-btn quiet cite-ext-link" href="${esc(candidateUrl)}" target="_blank" rel="noopener">查看原文 ↗</a>` : ''}
        </div>
      </div>`
    }).join(''))
  $('refImportBtn').onclick = () => $('refImportInput').click()
  $<HTMLInputElement>('refImportInput').onchange = async e => {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file || !session) return
    const box = $('refImportResult')
    box.innerHTML = '<div class="muted">正在逐条核实……</div>'
    try {
      const r = await api<{ added: Array<{ formatted: string }>; already: number; skipped: Array<{ label: string; reason: string }> }>(`/api/docs/${session.docId}/citations/import`, { method: 'POST', body: JSON.stringify({ text: await file.text() }) })
      refImportHtml = `<div>新登记 ${r.added.length} 条${r.already ? `，已有 ${r.already} 条` : ''}${r.skipped.length ? `，跳过 ${r.skipped.length} 条` : ''}</div>` +
        (r.skipped.length ? `<details><summary class="muted">跳过的条目</summary>${r.skipped.slice(0, 50).map(x => `<div class="muted small">${esc(x.label.slice(0, 80))} — ${esc(x.reason)}</div>`).join('')}</details>` : '')
      box.innerHTML = refImportHtml
      await refresh(false)
    } catch (err) {
      box.innerHTML = `<div class="form-error">${esc((err as Error).message)}</div>`
    }
  }
}

$('cites').onclick = e => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-cite-act]')
  if (!btn?.dataset.cid || !session?.editor) return
  const cid = btn.dataset.cid
  if (btn.dataset.citeAct === 'insert') {
    session.editor.insertCitation(cid)
    showNotice('已将文献引用插入当前光标处')
    scheduleRefresh()
  } else if (btn.dataset.citeAct === 'locate') {
    const ok = session.editor.locateCitationInDoc(cid)
    if (!ok) showNotice('正文中暂未找到该文献的上标引用位置', true)
  }
}

// —— 杂项 ——

const SIDE_COLLAPSED_KEY = 'heurion.side-collapsed'

function setSideCollapsed(collapsed: boolean): void {
  const app = $('app')
  app.classList.toggle('side-collapsed', collapsed)
  const toggleBtn = $('sideToggle')
  if (toggleBtn) {
    toggleBtn.setAttribute('aria-expanded', String(!collapsed))
    toggleBtn.classList.toggle('active', !collapsed)
    toggleBtn.title = collapsed ? '展开右侧栏 (快捷键 Cmd+] / Ctrl+])' : '收起右侧栏 (快捷键 Cmd+] / Ctrl+])'
  }
  try {
    localStorage.setItem(SIDE_COLLAPSED_KEY, collapsed ? 'true' : 'false')
  } catch {}
}

function openAiDrawer(open: boolean): void {
  const pane = document.getElementById('chatPane')
  if (!pane) return
  pane.classList.toggle('open', open)
  document.getElementById('aiDockBtn')?.classList.toggle('active', open)
  if (open) {
    if ($('app').classList.contains('side-collapsed')) setSideCollapsed(false)
    setTimeout(() => $('chatInput').focus(), 0)
  }
}

function switchTab(id: string): void {
  if (id === 'chatPane') {
    openAiDrawer(true)
    return
  }
  openAiDrawer(false)
  document.querySelectorAll<HTMLButtonElement>('.tabs button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === id))
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === id))
  if ($('app').classList.contains('side-collapsed')) {
    setSideCollapsed(false)
  }
}
document.querySelector<HTMLElement>('.tabs')!.onclick = e => {
  const tab = (e.target as HTMLElement).closest('button')?.dataset.tab
  if (tab) switchTab(tab)
}
$('aiDockBtn').onclick = () => openAiDrawer(!$('chatPane').classList.contains('open'))
$('aiDrawerClose').onclick = () => openAiDrawer(false)

$('exportBtn').onclick = e => {
  e.stopPropagation()
  const menu = $('exportMenu')
  menu.hidden = !menu.hidden
  if (!menu.hidden) placeFixedPopup(menu, $('exportBtn').getBoundingClientRect(), false)
}
document.addEventListener('click', () => { $('exportMenu').hidden = true })
// 导出字体：Mac（苹方、宋体-简）/ Windows（微软雅黑、等线、宋体）；默认按当前电脑，选过的记在本机
const FONTS_KEY = 'heurion.exportFonts'
const exportFonts = (): 'mac' | 'win' => {
  try { const v = localStorage.getItem(FONTS_KEY); if (v === 'mac' || v === 'win') return v } catch { /* 无痕模式 */ }
  return /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'mac' : 'win'
}
const renderExportFonts = () => $('exportFonts').querySelectorAll<HTMLButtonElement>('[data-fonts]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fonts === exportFonts())))
renderExportFonts()
$('exportFonts').onclick = e => {
  e.stopPropagation()
  const v = (e.target as HTMLElement).closest<HTMLElement>('[data-fonts]')?.dataset.fonts
  if (v) { try { localStorage.setItem(FONTS_KEY, v) } catch { /* 无痕模式 */ } renderExportFonts() }
}
async function ensureSuggestionsResolvedBeforeExport(): Promise<void> {
  if (!session) return
  if (pendingDeckEdit) await pendingDeckEdit
  if (resolvingSuggestion) await resolvingSuggestion
  const domGroups = new Set(
    Array.from(document.querySelectorAll<HTMLElement>('[data-suggest-group]:not(.suggest-paired-delete)'))
      .map(el => el.dataset.suggestGroup)
      .filter(Boolean),
  )
  const count = detail?.suggestions?.length || domGroups.size
  if (!count) return
  const accept = await askConfirm({
    title: '导出前处理待采纳修订',
    message: `当前文档有 ${count} 处待采纳修订（编辑区目前显示的是修订后的内容）。是否先全部采纳后再导出，使导出的文件与编辑区显示一致？（点「取消」将按未采纳前的原稿导出）`,
    confirm: '全部采纳并导出',
  })
  if (accept) await resolveSuggestion('all', true)
}
$('exportDocxBtn').onclick = async () => {
  if (!session) return
  await ensureSuggestionsResolvedBeforeExport()
  const merge = refMergeText()
  if (merge) showNotice(`${merge}。`)
  location.href = `/api/docs/${session.docId}/export.docx?token=${encodeURIComponent(TOKEN)}&fonts=${exportFonts()}`
}
// 干净稿：AI 未确认的文字按普通文字导出（默认的 Word 导出把它写成「Heurion AI」名下的修订）
$('exportDocxCleanBtn').onclick = async () => {
  if (!session) return
  await ensureSuggestionsResolvedBeforeExport()
  const merge = refMergeText()
  if (merge) showNotice(`${merge}。`)
  location.href = `/api/docs/${session.docId}/export.docx?token=${encodeURIComponent(TOKEN)}&fonts=${exportFonts()}&clean=1`
}
$('exportPptxBtn').onclick = async () => {
  if (!session) return
  await ensureSuggestionsResolvedBeforeExport()
  location.href = `/api/docs/${session.docId}/export.pptx?token=${encodeURIComponent(TOKEN)}&fonts=${exportFonts()}`
}
$('aiDisclosureBtn').onclick = () => { if (session) void openDisclosure(api, session.docId, (m, e) => showNotice(m, e)) }
$('provProofBtn').onclick = () => { if (session) void downloadProof(api, session.docId, detail?.title ?? '', (m, e) => showNotice(m, e)) }
$('exportMdBtn').onclick = async () => {
  if (!session) return
  await ensureSuggestionsResolvedBeforeExport()
  const merge = refMergeText()
  if (merge) showNotice(`${merge}。`)
  location.href = `/api/docs/${session.docId}/export.md?token=${encodeURIComponent(TOKEN)}`
}
/**
 * 复制为 RIS 纯文本（T2.6 / W4.5）：服务端按我的权限展开测量、去掉格式记号与草稿标题；
 * 有要处理的问题（测量来源失效、未定稿、草稿依据的结节已变……）时先列出来，由医生决定是否仍然复制。
 */
$('risCopyBtn').onclick = async () => {
  if (!session) return
  try {
    const r = await api<{ text: string; notes: string[]; issues: Array<{ severity: 'block' | 'warn'; message: string }>; draft: { template: { version: number; department_name: string | null }; generated_at: string } | null }>(`/api/docs/${session.docId}/ris-text`)
    if (!r.text.trim()) { showNotice('正文是空的，没有可复制的内容', true); return }
    const problems = [...r.issues.filter(i => i.severity === 'block'), ...r.issues.filter(i => i.severity === 'warn')]
    if (problems.length) {
      const block = problems.some(i => i.severity === 'block')
      const ok = await askConfirm({
        title: block ? '复制前请先处理：有测量或结节的来源已失效' : '复制前请核对',
        message: problems.map(i => `${i.severity === 'block' ? '【需处理】' : '· '}${i.message}`).join('\n') + (block ? '\n\n仍然复制时，失效的数字后面带〔…〕标注。' : ''),
        confirm: '仍然复制', danger: block,
      })
      if (!ok) return
    }
    await navigator.clipboard.writeText(r.text)
    // 效率埋点（T2.10）：写所见的结束时刻；只记本机构库，失败不打扰医生
    void api(`/api/docs/${session.docId}/ris-copied`, { method: 'POST' }).catch(() => {})
    showNotice(`已复制 RIS 纯文本（${r.text.split('\n').length} 行）${r.notes.length ? `；${r.notes.join('；')}` : ''}`)
  } catch (err) { showNotice(`不能复制：${(err as Error).message}`, true) }
}

// 开发者：读视图（用户菜单里，仅开发模式）
document.addEventListener('heurion:readview', async () => {
  if (!session) { showNotice('先打开一份文档'); return }
  const w = window.open('', '_blank')
  const text = await api<string>(`/api/docs/${session.docId}/read`)
  if (w) w.document.body.innerHTML = `<pre style="white-space:pre-wrap;font:13px ui-monospace,monospace">${esc(text)}</pre>`
})

// 启动：没有令牌 → 登录页；有令牌 → 取当前用户，失效时 api() 会回到登录页
async function boot(): Promise<void> {
  if (!TOKEN) {
    $('app').hidden = true
    const cpBtn = document.getElementById('btnCopilotToggle')
    if (cpBtn) cpBtn.hidden = true
    document.getElementById('copilotDrawer')?.classList.add('hidden')
    await showAuthScreen()
    return
  }
  const me = await api<Me>('/api/me')
  ME = me
  initUserMenu(me, api, showNotice)
  initCopilot({
    token: () => TOKEN,
    user: () => ME,
    onUnauthorized: () => signOut(),
    activeDoc: () => session ? { id: session.docId, title: detail?.title || '未命名文档' } : null,
    onInsertTable: insertTableIntoActiveOrNewDoc,
    onNotice: showNotice,
    onFocusDocChat: () => {
      switchTab('chatPane')
      $<HTMLTextAreaElement>('chatInput').focus()
    },
  })
  // 回到上次停留的工作空间（显示该空间的开始页）
  spaces.setEnabled('patients', me.tenant?.settings.patient_module !== false)
  void actions.refreshBadge()
  patientsUi.setPickEnabled(me.tenant?.settings.patient_module !== false)
  leaveDoc()
  spaces.set(spaces.saved())
  await loadDocs()
}
boot().catch(err => { $('page').innerHTML = `<div class="empty">${esc((err as Error).message)}</div>` })

/** 模型服务的报错翻成用户看得懂的话（原文仍在工作过程里）。 */
function friendlyError(message: string): string {
  if (/runtime exited|服务重启/.test(message)) return 'AI 进程中途退出（多为服务重启或升级），这一轮没有完成，请点「重试这一轮」。'
  if (/Authentication Fails|api key.*invalid|401/i.test(message)) return '模型服务认证失败（平台的 API key 无效或过期），请联系管理员。'
  if (/rate limit|429|Too Many Requests/i.test(message)) return '模型服务繁忙（限流），请稍后重试。'
  if (/insufficient|balance|402/i.test(message)) return '模型服务余额不足，请联系管理员。'
  if (/timeout|ETIMEDOUT|ECONNRESET|fetch failed/i.test(message)) return '连接模型服务失败，请稍后重试。'
  return message.slice(0, 300)
}

// —— 左右栏面板交互（窄屏滑出、桌面折叠） ——
{
  const app = $('app')
  const setPanel = (which: 'nav' | 'side' | null) => {
    app.classList.toggle('nav-open', which === 'nav')
    app.classList.toggle('side-open', which === 'side')
  }

  const toggleSide = () => {
    if (window.innerWidth <= 900) {
      const willOpen = !app.classList.contains('side-open')
      setPanel(willOpen ? 'side' : null)
    } else {
      setSideCollapsed(!app.classList.contains('side-collapsed'))
    }
  }

  const closeSide = () => {
    if (window.innerWidth <= 900) {
      setPanel(null)
    } else {
      setSideCollapsed(true)
    }
  }

  $('navToggle').onclick = () => setPanel(app.classList.contains('nav-open') ? null : 'nav')
  $('sideToggle').onclick = toggleSide
  $('sideClose').onclick = closeSide
  const sideCollapseBtn = document.getElementById('sideCollapseBtn')
  if (sideCollapseBtn) sideCollapseBtn.onclick = closeSide

  $('scrim').onclick = () => setPanel(null)

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.querySelector('.dialog:not([hidden])') && document.getElementById('chatPane')?.classList.contains('open')) {
      e.preventDefault()
      openAiDrawer(false)
      return
    }
    if (e.key === 'Escape' && !document.querySelector('.dialog:not([hidden])')) {
      setPanel(null)
    }
    // 快捷键 Cmd+] / Ctrl+] 或 Cmd+\ / Ctrl+\ 快速展开/收起右侧 AI 对话栏
    if ((e.metaKey || e.ctrlKey) && (e.key === ']' || e.key === '}' || e.key === '\\')) {
      if (!app.classList.contains('no-doc')) {
        e.preventDefault()
        toggleSide()
      }
    }
  })

  // 在列表里点开文档、新建后收起左栏
  $('docList').addEventListener('click', e => { if ((e.target as HTMLElement).closest('li[data-id]')) setPanel(null) })
  for (const id of ['newDoc', 'newDeck']) $(id).addEventListener('click', () => setPanel(null))

  // 初始化恢复右侧栏折叠状态
  try {
    const savedCollapsed = localStorage.getItem(SIDE_COLLAPSED_KEY)
    if (savedCollapsed === 'true') {
      setSideCollapsed(true)
    } else {
      const toggleBtn = $('sideToggle')
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', 'true')
        toggleBtn.classList.add('active')
      }
    }
  } catch {}
}

// —— 左侧边栏宽度手工拖拽调整与记忆 ——
function initNavResizer(): void {
  const NAV_WIDTH_KEY = 'heurion.nav-width'
  const DEFAULT_WIDTH = 292
  const MIN_WIDTH = 220
  const MAX_WIDTH = 680

  const applyWidth = (w: number) => {
    document.documentElement.style.setProperty('--nav-width', `${w}px`)
  }

  // 初始化时读取已保存的宽度
  try {
    const saved = localStorage.getItem(NAV_WIDTH_KEY)
    if (saved) {
      const num = parseInt(saved, 10)
      if (num >= MIN_WIDTH && num <= MAX_WIDTH) {
        applyWidth(num)
      }
    }
  } catch {}

  const resizer = document.getElementById('navResizer')
  if (!resizer) return

  let startX = 0
  let startW = DEFAULT_WIDTH

  const onPointerMove = (e: PointerEvent) => {
    const dx = e.clientX - startX
    const newW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + dx))
    applyWidth(newW)
  }

  const onPointerUp = (e: PointerEvent) => {
    resizer.classList.remove('dragging')
    document.body.classList.remove('nav-resizing')
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)

    const dx = e.clientX - startX
    const finalW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + dx))
    try {
      localStorage.setItem(NAV_WIDTH_KEY, `${finalW}px`)
    } catch {}
  }

  resizer.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault()
    startX = e.clientX
    const nav = document.querySelector<HTMLElement>('aside.nav')
    startW = nav ? nav.getBoundingClientRect().width : DEFAULT_WIDTH
    resizer.classList.add('dragging')
    document.body.classList.add('nav-resizing')

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  })

  // 双击手柄快速恢复默认 292px 宽度
  resizer.addEventListener('dblclick', () => {
    applyWidth(DEFAULT_WIDTH)
    try {
      localStorage.removeItem(NAV_WIDTH_KEY)
    } catch {}
  })
}

// —— 右侧边栏宽度手工拖拽调整与记忆 ——
function initSideResizer(): void {
  const SIDE_WIDTH_KEY = 'heurion.side-width'
  const DEFAULT_WIDTH = 400
  const MIN_WIDTH = 300
  const MAX_WIDTH = 800

  const applyWidth = (w: number) => {
    document.documentElement.style.setProperty('--side-width', `${w}px`)
  }

  // 初始化时读取已保存的宽度
  try {
    const saved = localStorage.getItem(SIDE_WIDTH_KEY)
    if (saved) {
      const num = parseInt(saved, 10)
      if (num >= MIN_WIDTH && num <= MAX_WIDTH) {
        applyWidth(num)
      }
    }
  } catch {}

  const resizer = document.getElementById('sideResizer')
  if (!resizer) return

  let startX = 0
  let startW = DEFAULT_WIDTH

  const onPointerMove = (e: PointerEvent) => {
    // 右栏在右侧，向左拖拽（dx 为负）使右栏变宽
    const dx = e.clientX - startX
    const maxAllowed = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 350))
    const newW = Math.max(MIN_WIDTH, Math.min(maxAllowed, startW - dx))
    applyWidth(newW)
  }

  const onPointerUp = (e: PointerEvent) => {
    resizer.classList.remove('dragging')
    document.body.classList.remove('side-resizing')
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)

    const dx = e.clientX - startX
    const maxAllowed = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 350))
    const finalW = Math.max(MIN_WIDTH, Math.min(maxAllowed, startW - dx))
    try {
      localStorage.setItem(SIDE_WIDTH_KEY, `${finalW}px`)
    } catch {}
  }

  resizer.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault()
    startX = e.clientX
    const side = document.querySelector<HTMLElement>('section.side')
    startW = side ? side.getBoundingClientRect().width : DEFAULT_WIDTH
    resizer.classList.add('dragging')
    document.body.classList.add('side-resizing')

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  })

  // 双击手柄快速恢复默认 400px 宽度
  resizer.addEventListener('dblclick', () => {
    applyWidth(DEFAULT_WIDTH)
    try {
      localStorage.removeItem(SIDE_WIDTH_KEY)
    } catch {}
  })
}

initNavResizer()
initSideResizer()

