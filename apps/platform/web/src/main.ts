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
import { initCopilot } from './copilot.ts'
import { icon } from './icons.ts'

const TOKEN = storedToken()
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
applyTheme()
mountThemeSwitch($('themeSwitch'))
$('authScreen').insertAdjacentHTML('afterbegin', photoFigure('login'))
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

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
    const e = await res.json().catch(() => ({})) as { error?: string; message?: string }
    throw new Error(e.error || e.message || res.statusText)
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

// —— 文档列表 ——

const ICON_DOC = '<svg class="kind doc" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-label="文档"><path d="M4 1.75h5.5L12.5 4.75v9.5H4z"/><path d="M9.25 1.75v3.25h3.25M6 8h4.5M6 10.75h4.5"/></svg>'
const ICON_DECK = '<svg class="kind deck" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-label="幻灯片"><rect x="1.75" y="2.75" width="12.5" height="8.5" rx="1.5"/><path d="M8 11.25v2.5M5.5 13.75h5"/></svg>'

// —— 左栏：文档仓库（项目分组、搜索、回收站） ——

let docRows: any[] = []
let projects: Array<{ id: string; name: string }> = []
const collapsed = new Set<string>(JSON.parse((() => { try { return localStorage.getItem('heurion.collapsed') ?? '[]' } catch { return '[]' } })()))
const saveCollapsed = () => { try { localStorage.setItem('heurion.collapsed', JSON.stringify([...collapsed])) } catch { /* 忽略 */ } }

const docItem = (d: any) => `<li data-id="${d.id}" class="${d.id === session?.docId ? 'active' : ''}" title="${esc(d.title)}">${d.kind === 'deck' ? ICON_DECK : ICON_DOC}<span class="label">${esc(d.title)}</span><button class="item-menu" data-doc-menu="${d.id}" title="更多操作" aria-label="更多操作">⋯</button></li>`

async function loadDocs(): Promise<void> {
  ;[docRows, projects] = await Promise.all([api<any[]>('/api/docs'), api<any[]>('/api/projects')])
  if ($<HTMLInputElement>('docSearch').value.trim()) { void runSearch(); return }
  const loose = docRows.filter(d => !d.project_id)
  const groups = projects.map(p => {
    const items = docRows.filter(d => d.project_id === p.id)
    const open = !collapsed.has(p.id)
    return `<li class="group${open ? ' open' : ''}" data-project="${p.id}"><span class="caret">${open ? '▾' : '▸'}</span><span class="label">${esc(p.name)}</span><span class="count">${items.length}</span><button class="item-menu" data-project-menu="${p.id}" title="项目操作" aria-label="项目操作">⋯</button></li>${open ? items.map(docItem).join('') : ''}`
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
    : hits.map(h => `<li data-id="${h.doc_id}" class="hit${h.doc_id === session?.docId ? ' active' : ''}" title="${esc(h.title)}">${h.kind === 'deck' ? ICON_DECK : ICON_DOC}<span class="hit-text"><span class="label">${esc(h.title)}</span><span class="snippet">${mark(h.snippet)}</span></span></li>`).join('')
}
$('docSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = window.setTimeout(() => void runSearch(), 200) }
$('docSearch').onkeydown = e => { if (e.key === 'Escape') { $<HTMLInputElement>('docSearch').value = ''; void loadDocs() } }

/** 小菜单（固定定位在按钮旁边）。 */
function popMenu(anchor: HTMLElement, items: Array<[string, () => void | Promise<void>, boolean?]>): void {
  document.querySelector('.pop-menu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'pop-menu'
  menu.innerHTML = items.map(([label, , danger], i) => `<button data-i="${i}" class="${danger ? 'danger-text' : ''}">${esc(label)}</button>`).join('')
  const r = anchor.getBoundingClientRect()
  Object.assign(menu.style, { left: `${r.right - 4}px`, top: `${r.top}px` })
  document.body.appendChild(menu)
  const close = () => { menu.remove(); document.removeEventListener('mousedown', outside) }
  const outside = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) close() }
  setTimeout(() => document.addEventListener('mousedown', outside))
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
const datasets = initDatasets(api, (m, e) => showNotice(m, e), {
  showPage: (cls, title) => showPage(cls, title),
  openStudy: id => void researchUi.open(id),
})
let ME: Me | null = null
const patientsUi = initPatients(api, (m, e) => showNotice(m, e), {
  leaveDoc: () => leaveDoc(),
  openDoc: id => open(id),
  prefillChat: text => prefillChat(text),
  goSpace: space => spaces.set(space),
  tenantId: () => ME?.tenant?.id ?? null,
  token: () => TOKEN,
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

initCopilot({
  token: () => TOKEN,
  activeDoc: () => session ? { id: session.docId, title: detail?.title || '未命名文档' } : null,
})

// 资料库页打开时，图标栏高亮「资料库」而不是当前空间
new MutationObserver(() => {
  const lib = $('page').classList.contains('library-page')
  $('libraryBtn').classList.toggle('on', lib)
  document.querySelector('.rail')!.classList.toggle('on-page', lib)
  if (!lib) library.leave()
  if (!$('page').classList.contains('datasets-page')) datasets.leave()
}).observe($('page'), { attributes: true, attributeFilter: ['class'] })
// 左侧图标栏：患者 / 临床研究 / 写作 / 日历 / 邮箱
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
      // 如果当前正开着文档（非患者页、非研究页、非日历页、非邮箱页），保留当前文档
      if (session && !page.classList.contains('patient-page') && !page.classList.contains('study-page') && !page.classList.contains('calendar-page') && !page.classList.contains('mail-page') && !page.classList.contains('welcome-page')) {
        return
      }
      leaveDoc()
      showWelcome()
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
  if (renameNow) editTitle()
}
$('newDoc').onclick = () => void createDoc('doc')
$('newDeck').onclick = () => void createDoc('deck')

$('uploadBtn').onclick = () => $('uploadInput').click()
$<HTMLInputElement>('uploadInput').onchange = async e => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const fd = new FormData()
  fd.append('file', file)
  try {
    const d = await api('/api/docs', { method: 'POST', body: fd })
    await loadDocs()
    await open(d.id)
    if (d.warnings?.length) showNotice(`导入提示：${d.warnings.join('；')}`)
  } catch (err) {
    showNotice(`导入失败：${(err as Error).message}`, true)
  }
  input.value = ''
}

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
  // 没打开文档：AI 栏收起（对话要基于一份文档），顶栏不显示导出与同步状态
  $('app').classList.add('no-doc')
  close()
  hideTurnBanner()
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

async function open(docId: string): Promise<void> {
  streamHellos = 0
  $('app').classList.remove('no-doc')
  refImportHtml = ''
  patientsUi.leave()
  researchUi.leave()
  close()
  hideTurnBanner()
  turnUi = null
  $('chatLog').innerHTML = ''
  $('page').innerHTML = ''
  $('page').className = 'page'
  const meta = await api(`/api/docs/${docId}`)
  const stream = new EventSource(`/api/docs/${docId}/stream?token=${encodeURIComponent(TOKEN)}`)
  stream.onmessage = e => onStreamEvent(JSON.parse(e.data))
  const onCommentClick = (thread: string) => {
    switchTab('commentPane')
    document.querySelector(`[data-cid="${CSS.escape(thread)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
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
        switchTab('reviewPane')
        const card = document.querySelector(`.review-card[data-cid="${CSS.escape(claimId)}"]`)
        card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        card?.classList.add('card-highlight')
        setTimeout(() => card?.classList.remove('card-highlight'), 1600)
      },
      analysis: { has: id => datasets.hasProvenance(id), show: id => void datasets.showProvenance(id) },
      onSuggestion: (group, accept) => void resolveSuggestion(group, accept),
      onSelection: a => { anchor = a; placeFab(); syncToolbar() },
    })
    session = { docId, kind: 'doc', stream, ydoc, provider, editor }
    $('page').classList.remove('deck')
  }
  // 属于患者的文档（病例报告等）：顶栏显示归属，点击回到患者页
  const ctx = (() => { try { return meta.context ? JSON.parse(meta.context) : null } catch { return null } })()
  // 属于研究的文档（方案、论文、幻灯片）：同样显示归属、能回到研究页
  $('docContext').hidden = ctx?.kind !== 'patient' && ctx?.kind !== 'study'
  docPatient = ctx?.kind === 'patient' ? ctx.patient_id : null
  if (ctx?.kind === 'patient') {
    $('docContext').textContent = `← ${ctx.code} · ${({ case_report: '病例报告', followup: '随访小结', discussion: '病例讨论' } as Record<string, string>)[ctx.doc_kind] ?? '患者文档'}`
    $('docContext').onclick = () => void patientsUi.open(ctx.patient_id)
  } else if (ctx?.kind === 'study') {
    $('docContext').textContent = `← ${ctx.title} · ${({ protocol: '研究方案', manuscript: '论文', slides: '幻灯片' } as Record<string, string>)[ctx.role] ?? '研究文档'}`
    $('docContext').onclick = () => void researchUi.open(ctx.study_id)
  }
  // 研究共享文档：顶栏显示协作者；只读成员不显示编辑工具条
  const readOnly = meta.my_role === 'viewer'
  renderCollaborators(meta.collaborators ?? [], readOnly)
  $('page').classList.toggle('read-only', readOnly)
  $('toolbar').hidden = meta.kind === 'deck' || readOnly
  $('deckToolbar').hidden = meta.kind !== 'deck' || readOnly
  if (meta.kind === 'deck') void initDeckToolbar()
  $('exportDocxBtn').hidden = meta.kind === 'deck'
  $('exportMdBtn').hidden = meta.kind === 'deck'
  $('exportPptxBtn').hidden = meta.kind !== 'deck'
  for (const b of ['exportBtn', 'sendBtn']) $<HTMLButtonElement>(b).disabled = false
  await loadDocs()
  await refresh(true)
}

/** 顶栏的协作者（研究成员）：头像缩写 + 名字提示；我是只读成员时加一个「只读」标记 */
function renderCollaborators(list: Array<{ name: string; role: string }>, readOnly: boolean): void {
  const el = $('docCollab')
  el.hidden = list.length < 2 && !readOnly
  const ROLE: Record<string, string> = { owner: '负责人', editor: '可编辑', viewer: '只读' }
  el.innerHTML = list.slice(0, 5).map(m => `<span class="collab-avatar role-${esc(m.role)}" title="${esc(m.name)} · ${ROLE[m.role] ?? ''}">${esc(m.name.slice(0, 1).toUpperCase())}</span>`).join('')
    + (list.length > 5 ? `<span class="collab-more">+${list.length - 5}</span>` : '')
    + (readOnly ? '<span class="pill off collab-ro" title="你在这个研究里是只读成员：能看、能评论，不能修改">只读</span>' : '')
}

function close(): void {
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
    if (streamHellos++ > 0 && !e.busy && turnUi) { turnUi = null; void refresh(true) }
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
    const failed = new Map<string, { status: string; error: string | null }>((d.failed_turns ?? []).map((t: any) => [t.id, t]))
    for (const m of d.messages) {
      addMsg(m.role, displayMessage(m.text), m.role === 'assistant' && d.revertable.includes(m.turn_id) ? m.turn_id : null)
      // 没正常完成的回合：在该轮用户消息后标出原因（刷新页面后也看得到）
      const f = m.role === 'user' && m.turn_id ? failed.get(m.turn_id) : undefined
      if (f) {
        addStep(`${TURN_STATUS[f.status] ?? f.status}${f.error ? `：${friendlyError(f.error)}` : ''}`, 'err', f.error ?? '')
        addRetry(m.turn_id)
      }
    }
  }
  if (session?.editor && d.claim_checks) {
    session.editor.setClaimChecks(d.claim_checks)
  }
  renderComments()
  renderSuggestions()
  renderReview()
  renderVersions()
  renderCites()
  syncRevertButtons()
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

async function deckEdit(docId: string, ops: Array<Record<string, unknown>>, baseRev: number): Promise<boolean> {
  try {
    await api(`/api/docs/${docId}/edit`, { method: 'POST', body: JSON.stringify({ base_rev: baseRev, ops }) })
    return true
  } catch (err) {
    showNotice((err as Error).message, true)
    return false
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
    pop.style.left = `${r.left}px`
    pop.style.top = `${r.bottom + 6}px`
    document.body.appendChild(pop)
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
      Object.assign(menu.style, { position: 'fixed', left: `${r.left}px`, top: `${r.bottom + 6}px`, right: 'auto' })
      menu.hidden = !menu.hidden
      break
    }
    case 'chart': {
      const menu = $('chartMenu')
      const r = btn.getBoundingClientRect()
      Object.assign(menu.style, { position: 'fixed', left: `${r.left}px`, top: `${r.bottom + 6}px`, right: 'auto' })
      menu.hidden = !menu.hidden
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
      Object.assign(menu.style, { position: 'fixed', left: `${r.left}px`, top: `${r.bottom + 6}px`, right: 'auto' })
      menu.hidden = !menu.hidden
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

$('toolbar').onclick = e => {
  const btn = (e.target as HTMLElement).closest('button')
  const cmd = btn?.dataset.cmd
  if (!cmd || !session?.editor) return
  const c = session.editor.commands as Record<string, (...a: any[]) => void>
  if (cmd === 'image') { $('imageInput').click(); return }
  if (cmd === 'cite') { void addCitation(); return }
  if (['bold', 'italic', 'underline', 'sup', 'sub'].includes(cmd)) session.editor.commands.mark(cmd as 'bold')
  else c[cmd]?.()
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
function syncToolbar(): void {
  if (!session?.editor) return
  const t = session.editor.blockType()
  $<HTMLSelectElement>('blockType').value = ['p', 'h1', 'h2', 'h3'].includes(t) ? t : 'p'
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

/** AI 文字常带 **粗体** 与 `代码`：转义后只渲染这两种。 */
function lightMarkdown(text: string): string {
  return esc(text).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>')
}

function addMsg(role: 'user' | 'assistant', text: string, revertTurn: string | null = null): HTMLElement {
  const div = document.createElement('div')
  div.className = `msg ${role}`
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
      row.innerHTML = ids.map(id => `<a href="/api/assets/${id}?token=${encodeURIComponent(TOKEN)}" target="_blank" rel="noreferrer"><img src="/api/assets/${id}?token=${encodeURIComponent(TOKEN)}" alt="图片"></a>`).join('')
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
  doc_edit: a => `修改文档（${a.ops?.length ?? 1} 处操作）`,
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
  deck_edit: a => `修改幻灯片（${a.ops?.length ?? 1} 处操作）`,
  layout_check: () => '检查版面（溢出、重叠）',
  slide_render: () => '渲染幻灯片预览',
  asset_upload: () => '上传图片',
  read_image: () => '查看图片附件',
  bash: () => '运行计算',
}

function toolLabel(name: string, args: string): string {
  const short = name.replace(/^mcp__heurion__/, '')
  let parsed: any = {}
  try { parsed = JSON.parse(args) } catch { /* 参数不是 JSON */ }
  const f = TOOL_LABELS[short]
  return f ? f(parsed) : short
}

// —— 回合的界面状态：工作过程（折叠）、本轮改动（摘要条）、重试 ——

let turnUi: { steps: HTMLDetailsElement; count: number; retries: number; turnId: string | null } | null = null
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
  turnUi = { steps, count: 0, retries: 0, turnId }
}

const DONE_LABEL: Record<string, string> = { done: '已完成', error: '出错了', timeout: '超时停止', cancelled: '已停止', interrupted: '被中断' }

function finishTurnUi(status: string): void {
  if (!turnUi) return
  turnUi.steps.querySelector('summary')!.textContent = `${DONE_LABEL[status] ?? status} · ${turnUi.count} 步${turnUi.retries ? `（${turnUi.retries} 步调整后重试）` : ''}`
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

let lastAssistant: HTMLElement | null = null

function renderTurnEvent(ev: any): void {
  switch (ev.type) {
    case 'queued': addStep(`排队中（第 ${ev.position} 位）：${displayMessage(ev.message).slice(0, 40)}`); void loadQueue(); break
    case 'turn':
      void loadQueue()
      lastAssistant = null
      setBusy(true)
      hideTurnBanner()
      addMsg('user', displayMessage(ev.message))
      startTurnUi(ev.turn_id ?? null)
      break
    case 'assistant': lastAssistant = addMsg('assistant', ev.text); break
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
    case 'error': {
      addStep(ev.message, 'err')
      // 失败原因直接显示在对话里（不只在折叠的工作过程里）
      const div = addMsg('assistant', `出错了：${friendlyError(ev.message)}`)
      div.classList.add('error')
      break
    }
    case 'turn_done':
      setBusy(false)
      void loadQueue()
      finishTurnUi(ev.status)
      if (ev.status !== 'done') addRetry(ev.turn_id)
      if (ev.docs.includes(session?.docId) && ev.status !== 'error') {
        void refresh(false).then(() => {
          if (detail?.suggestions?.length > 0) {
            // 自动切换到审查面板，让用户直接看到右侧的审查卡片
            switchTab('reviewPane')
            if (lastAssistant) {
              const bar = document.createElement('div')
              bar.className = 'chat-turn-review-bar'
              bar.innerHTML = `
                <span class="badge-pill rev"><span class="dot"></span> AI 提出了 ${detail.suggestions.length} 处修订</span>
                <button class="btn-jump-review">在审查面板逐条查看并采纳 →</button>
              `
              bar.querySelector('button')?.addEventListener('click', () => {
                switchTab('reviewPane')
                const firstCard = document.querySelector('.review-card')
                firstCard?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                firstCard?.classList.add('ai-flash')
                setTimeout(() => firstCard?.classList.remove('ai-flash'), 1400)
              })
              lastAssistant.appendChild(bar)
            }
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
  $<HTMLButtonElement>('cancelBtn').disabled = !b
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
    const src = i.previewUrl || `/api/assets/${i.id}?token=${encodeURIComponent(TOKEN)}`
    return `<span class="chat-img" data-id="${i.id}"><img src="${src}" alt="${esc(i.name)}"><button class="chip-x" aria-label="移除">✕</button></span>`
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
      const match = /<img[^>]+src=["'](data:image\/([a-zA-Z0-9+]+);base64,([^"']+))["']/i.exec(html)
      const dataUrl = match?.[1]
      if (dataUrl) {
        try {
          const res = await fetch(dataUrl)
          const blob = await res.blob()
          if (blob.size > 0) {
            files.push(new File([blob], 'pasted-image.' + (match[2] || 'png'), { type: blob.type || 'image/png' }))
          }
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
  $<HTMLInputElement>('chatImageInput')?.click()
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
  if (queue.running) await cancelJob(queue.running.id)
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

interface QueueItem { id: string; doc_id: string; doc_title: string; label: string; suggest: boolean; since: string }
let queue: { running: QueueItem | null; queued: QueueItem[] } = { running: null, queued: [] }

async function loadQueue(): Promise<void> {
  if (!TOKEN) return
  try {
    queue = await api('/api/queue')
  } catch { return }
  renderQueue()
  // 忙碌状态只按刚取到的队列设置（不用缓存，免得发送后被旧数据覆盖）
  setBusy(!!queue.running)
}

function elapsed(since: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000))
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

function renderQueue(): void {
  const items = [...(queue.running ? [{ ...queue.running, running: true }] : []), ...queue.queued.map(q => ({ ...q, running: false }))]
  // 面板常驻：空闲时只显示一行，有任务时展开
  $('queuePanel').classList.toggle('idle', items.length === 0)
  $('queueClear').hidden = items.length === 0
  $('queueSummary').textContent = items.length === 0 ? '空闲' : `${queue.running ? '1 个执行中' : ''}${queue.running && queue.queued.length ? '，' : ''}${queue.queued.length ? `${queue.queued.length} 个排队` : ''}`
  $('queueList').innerHTML = items.map((q, i) => `
    <li class="${q.running ? 'running' : ''}">
      <div class="queue-main">
        <span class="queue-state">${q.running ? '执行中' : `第 ${i + (queue.running ? 0 : 1)} 位`}</span>
        <span class="queue-doc${q.doc_id === session?.docId ? ' here' : ''}" data-open="${esc(q.doc_id)}" title="打开这份文档">《${esc(q.doc_title)}》</span>
        ${q.suggest ? '<span class="queue-tag">修订</span>' : ''}
        <div class="queue-label" title="${esc(q.label)}">${esc(q.label)}</div>
        <div class="muted">${q.running ? '已运行' : '已等待'} ${elapsed(q.since)}</div>
      </div>
      <button data-cancel="${esc(q.id)}">${q.running ? '停止' : '取消'}</button>
    </li>`).join('')
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
  const open = t.closest('[data-open]') as HTMLElement | null
  if (open && open.dataset.open !== session?.docId) document.querySelector<HTMLElement>(`li[data-id="${CSS.escape(open.dataset.open!)}"]`)?.click()
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
  if (queue.running || queue.queued.length > 0 || queueTick % 5 === 0) void loadQueue()
}, 2000)
void loadQueue()

// —— 选区评论 ——

function placeFab(): void {
  const fab = $('commentFab')
  if (!anchor) { fab.style.display = 'none'; return }
  const main = document.querySelector('.center')!.getBoundingClientRect()
  fab.style.display = 'block'
  fab.textContent = anchor.blocked ?? (anchor.snippet ? '评论' : '评论此形状')
  fab.classList.toggle('blocked', !!anchor.blocked)
  fab.style.top = `${anchor.rect.top - main.top - 36}px`
  fab.style.left = `${anchor.rect.left - main.left + anchor.rect.width / 2 - 24}px`
}
$('scroller').addEventListener('scroll', () => { $('commentFab').style.display = 'none' })

$('commentFab').onmousedown = e => {
  e.preventDefault()
  if (!anchor || anchor.blocked) return
  pendingAnchor = { node_id: anchor.node_id, snippet: anchor.snippet, paragraph: anchor.paragraph, range: anchor.range }
  $('commentFab').style.display = 'none'
  switchTab('commentPane')
  $('newComment').hidden = false
  $('newCommentQuote').textContent = pendingAnchor.snippet || '（整个形状）'
  $<HTMLTextAreaElement>('newCommentText').value = ''
  $('newCommentText').focus()
}
$('newCommentCancel').onclick = () => { $('newComment').hidden = true; pendingAnchor = null }

async function saveComment(ask: boolean): Promise<void> {
  const text = $<HTMLTextAreaElement>('newCommentText').value.trim()
  if (!text || !pendingAnchor || !session) return
  try {
    const c = await api(`/api/docs/${session.docId}/comments`, { method: 'POST', body: JSON.stringify({ ...pendingAnchor, text }) })
    $('newComment').hidden = true
    pendingAnchor = null
    if (ask && !c.queued) {
      await api(`/api/docs/${session.docId}/comments/${c.id}/ask?async=1`, { method: 'POST', body: JSON.stringify({ suggest: $<HTMLInputElement>('suggestMode').checked }) })
    }
    await refresh(false)
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}
$('newCommentSave').onclick = () => void saveComment(false)
$('newCommentAsk').onclick = () => void saveComment(true)

function renderComments(): void {
  const list: any[] = detail?.comments ?? []
  $('comments').innerHTML = list.length === 0
    ? '<div class="muted">在正文中选中文字即可评论；写上 @heurion 由 AI 自动处理</div>'
    : list.map(c => {
      const isClaim = c.replies.some((r: any) => r.role === 'ai' && r.text.includes('论断核对：'))
      let suggestion: string | null = null
      for (const r of c.replies) {
        const m = /【建议修改为】：([^\n]+)/.exec(r.text) || /建议修改为：([^\n]+)/.exec(r.text)
        if (m) { suggestion = m[1]?.trim() ?? null; break }
      }
      return `
    <div class="card ${c.status}${isClaim ? ' claim-comment-card' : ''}" data-cid="${c.id}">
      <div class="quote ${c.anchor.located ? '' : 'lost'}">${esc(c.anchor.text || c.snippet || '（整块）')}${c.anchor.located ? '' : ' · 锚点已移除'}</div>
      ${c.replies.map((r: any) => `<div class="reply ${r.role}"><b>${r.role === 'ai' ? (isClaim ? 'Heurion 论断核验' : 'Heurion') : '我'}</b>：${r.role === 'ai' ? lightMarkdown(r.text) : esc(r.text)}</div>`).join('')}
      ${isClaim && suggestion && c.status === 'open' ? `
        <div class="claim-suggestion-box">
          <div class="claim-suggestion-title">AI 纠正建议</div>
          <div class="claim-suggestion-text">${esc(suggestion)}</div>
          <button type="button" class="small-btn quiet claim-fix-btn" data-act="apply-claim-fix" data-fix="${esc(suggestion)}" title="一键采纳文献真实数值并纠正正文">一键替换正文</button>
        </div>` : ''}
      <div class="row">
        ${c.status === 'open'
          ? `<input type="text" placeholder="追问或补充（含 @heurion 自动处理）" data-reply><button data-act="reply">回复</button><button data-act="ask" class="ai">让 AI 处理</button>${isClaim ? `<button data-act="exempt-claim" class="quiet" title="将该论断标记为临床经验/未发表观察，豁免文献核对并关闭评论">标为临床经验</button>` : ''}<button data-act="resolve">关闭</button><button data-act="delete" title="删除评论">删除</button>`
          : `<span class="muted">已关闭（${c.resolved_by === 'ai' ? 'AI' : '我'}）</span><button data-act="reopen">重新打开</button><button data-act="delete" title="删除评论">删除</button>`}
      </div>
    </div>`
    }).join('')
}

$('comments').onclick = async e => {
  const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null
  if (!btn || !session) return
  const card = btn.closest('[data-cid]') as HTMLElement
  const cid = card.dataset.cid!
  const input = card.querySelector<HTMLInputElement>('[data-reply]')
  const text = input?.value.trim() ?? ''
  try {
    if (btn.dataset.act === 'apply-claim-fix') {
      const fix = btn.dataset.fix ?? ''
      await api(`/api/docs/${session.docId}/comments/${cid}/apply-claim-fix`, {
        method: 'POST',
        body: JSON.stringify({ replace: fix }),
      })
      showNotice('已采纳建议并更新正文')
    } else if (btn.dataset.act === 'exempt-claim') {
      await api(`/api/docs/${session.docId}/comments/${cid}/exempt-claim`, { method: 'POST' })
      showNotice('已标记为临床经验并关闭评论')
    } else if (btn.dataset.act === 'reply') {
      if (!text) return
      await api(`/api/docs/${session.docId}/comments/${cid}/replies`, { method: 'POST', body: JSON.stringify({ text }) })
    } else if (btn.dataset.act === 'ask') {
      await api(`/api/docs/${session.docId}/comments/${cid}/ask?async=1`, { method: 'POST', body: JSON.stringify({ text, suggest: $<HTMLInputElement>('suggestMode').checked }) })
      switchTab('chatPane')
    } else if (btn.dataset.act === 'delete') {
      if (!await askConfirm({ title: '删除评论', message: '删除这条评论及其全部回复？正文里的评论标记也会去掉。', confirm: '删除', danger: true })) return
      await api(`/api/docs/${session.docId}/comments/${cid}`, { method: 'DELETE' })
    } else {
      await api(`/api/docs/${session.docId}/comments/${cid}/${btn.dataset.act}`, { method: 'POST' })
    }
    await refresh(false)
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}

// —— 修订 ——

async function resolveSuggestion(group: string, accept: boolean): Promise<void> {
  if (!session) return
  try {
    await api(`/api/docs/${session.docId}/suggestions/${group}/${accept ? 'accept' : 'reject'}`, { method: 'POST' })
    await refresh(false)
  } catch (err) {
    showNotice((err as Error).message, true)
  }
}

// 待采纳修订：只在有修订时出现在正文上方（不单设页签）；逐处采纳 / 拒绝在正文里的修订条上
let suggestCursor = -1

function renderSuggestions(): void {
  const groups: any[] = detail?.suggestions ?? []
  $('suggestBanner').hidden = groups.length === 0
  if (groups.length === 0) { suggestCursor = -1; return }
  const blocks = groups.reduce((n, g) => n + g.inserts + g.deletes, 0)
  $('suggestSummary').textContent = `${groups.length} 处待采纳修订（涉及 ${blocks} 块）· AI 的修改需你采纳后生效`
  if (suggestCursor >= groups.length) suggestCursor = groups.length - 1
}

$('suggestBanner').onclick = e => {
  const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null
  if (!t) return
  const groups: any[] = detail?.suggestions ?? []
  if (t.dataset.all) { void resolveSuggestion('all', t.dataset.all === '1'); return }
  if (t.dataset.nav && groups.length > 0) {
    suggestCursor = (suggestCursor + Number(t.dataset.nav) + groups.length) % groups.length
    const el = document.querySelector(`[data-suggest-group="${CSS.escape(groups[suggestCursor].group)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.classList.add('ai-flash')
    setTimeout(() => el?.classList.remove('ai-flash'), 1200)
  }
}

// —— 伴随审查面板（AI 修订与论断核查卡片流） ——

function renderReview(): void {
  const groups: any[] = detail?.suggestions ?? []
  const checks: any[] = detail?.claim_checks ?? []
  const flagged = checks.filter(c => c.verdict !== 'supported')
  const total = groups.length + flagged.length

  const badge = document.getElementById('reviewBadge')
  if (badge) {
    badge.textContent = String(total)
    badge.hidden = total === 0
  }

  const btnAcceptAll = document.getElementById('reviewAcceptAll')
  const btnRejectAll = document.getElementById('reviewRejectAll')
  if (btnAcceptAll) btnAcceptAll.hidden = groups.length === 0
  if (btnRejectAll) btnRejectAll.hidden = groups.length === 0

  const container = document.getElementById('reviewCards')
  if (!container) return

  if (total === 0) {
    container.innerHTML = `
      <div class="review-empty">
        <div class="empty-icon">✓</div>
        <div class="empty-title">当前无待处理修订或论断警示</div>
        <div class="muted">AI 提出的修订和文献论断核查将在此实时伴随呈现</div>
      </div>`
    return
  }

  const parts: string[] = []

  // 1. AI 修订卡片（墨黑底色高对比度，绿色标与采纳/拒绝）
  for (const g of groups) {
    let delText = ''
    let insText = ''
    const domEls = document.querySelectorAll(`[data-suggest-group="${CSS.escape(g.group)}"]`)
    domEls.forEach(el => {
      const del = el.querySelector('.diff-del')
      if (del) delText = del.textContent || ''
      const ins = el.querySelector('.diff-ins')
      if (ins) insText = ins.textContent || ''
    })

    parts.push(`
      <div class="review-card ai-card" data-group="${esc(g.group)}">
        <div class="card-top">
          <span class="badge-pill rev"><span class="dot"></span> AI 修订 · 待采纳</span>
          <span class="card-meta">#${esc(g.group.slice(0, 6))}</span>
        </div>
        <div class="card-title">根据最新证据量化表述</div>
        <div class="card-desc">补充定量效应值与精确置信区间，替换模糊陈述（涉及 ${g.inserts} 增 / ${g.deletes} 删）</div>
        ${(delText || insText) ? `
          <div class="diff-preview">
            ${delText ? `<div class="diff-del-row"><span class="tag-del">原内容</span><del>${esc(delText)}</del></div>` : ''}
            ${insText ? `<div class="diff-ins-row"><span class="tag-ins">修订</span><ins>${esc(insText)}</ins></div>` : ''}
          </div>` : ''}
        <div class="card-actions">
          <button class="btn-review-accept" data-act="accept" data-group="${esc(g.group)}">采纳</button>
          <button class="btn-review-reject" data-act="reject" data-group="${esc(g.group)}">拒绝</button>
          <button class="btn-review-locate" data-act="locate-rev" data-group="${esc(g.group)}">定位正文</button>
        </div>
      </div>`)
  }

  // 2. 论断核查卡片（暖黄警示标，展示反差与文献限制）
  for (const c of flagged) {
    parts.push(`
      <div class="review-card claim-card ${esc(c.verdict)}" data-cid="${esc(c.claim_id)}">
        <div class="card-top">
          <span class="badge-pill claim"><span class="dot"></span> 论断核查 · 文献依据</span>
          <span class="verdict-tag ${esc(c.verdict)}">${VERDICT[c.verdict] ?? c.verdict}</span>
        </div>
        <div class="claim-sentence">「${esc(c.sentence)}」</div>
        <div class="claim-reason">${esc(c.reason)}</div>
        <div class="card-actions">
          <button class="btn-claim-locate" data-act="locate-claim" data-cid="${esc(c.claim_id)}">定位正文</button>
        </div>
      </div>`)
  }

  container.innerHTML = parts.join('')
}

document.getElementById('reviewCards')?.addEventListener('click', async e => {
  const btn = (e.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null
  if (!btn || !session) return
  const act = btn.dataset.act
  const group = btn.dataset.group
  const cid = btn.dataset.cid
  if (act === 'accept' && group) {
    await resolveSuggestion(group, true)
  } else if (act === 'reject' && group) {
    await resolveSuggestion(group, false)
  } else if (act === 'locate-rev' && group) {
    const el = document.querySelector(`[data-suggest-group="${CSS.escape(group)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.classList.add('ai-flash')
    setTimeout(() => el?.classList.remove('ai-flash'), 1400)
  } else if (act === 'locate-claim' && cid) {
    const el = document.querySelector(`.claim-warn-text[data-claim-id="${CSS.escape(cid)}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el?.classList.add('ai-flash')
    setTimeout(() => el?.classList.remove('ai-flash'), 1400)
  }
})

document.getElementById('reviewAcceptAll')?.addEventListener('click', () => {
  void resolveSuggestion('all', true)
})
document.getElementById('reviewRejectAll')?.addEventListener('click', () => {
  void resolveSuggestion('all', false)
})

// —— 版本与引用 ——

const SOURCE: Record<string, string> = { create: '新建', import: '导入', turn: 'AI', user: '保存', restore: '回滚' }

function renderVersions(): void {
  $('versions').innerHTML = `<div class="row" style="margin-bottom:8px"><button id="saveVersion">保存当前为版本</button></div>` +
    (detail?.versions ?? []).map((v: any) => `<div class="vitem"><div><b>v${v.seq}</b> · ${SOURCE[v.source] ?? v.source} · ${esc(v.note)}<div class="muted">rev ${v.rev} · ${new Date(v.created_at).toLocaleString()}</div></div>
      <div class="row"><button data-diff="${v.seq}">对比</button><button data-restore="${v.seq}">回滚</button></div></div>`).join('')
  $('saveVersion').onclick = async () => {
    if (!session) return
    await api(`/api/docs/${session.docId}/save`, { method: 'POST' })
    await refresh(false)
  }
}

$('versions').onclick = async e => {
  const d = (e.target as HTMLElement).dataset
  if (!session) return
  if (d.restore && await askConfirm({ title: `回滚到 v${d.restore}`, message: '文档会恢复成这个版本的内容。回滚本身会生成一个新版本，之前的历史都保留，随时可以再回到现在。', confirm: '回滚' })) {
    try {
      await api(`/api/docs/${session.docId}/versions/${d.restore}/restore`, { method: 'POST' })
      await refresh(false)
    } catch (err) {
      showNotice((err as Error).message, true)
    }
  }
  if (d.diff) {
    const r = await api(`/api/docs/${session.docId}/diff?from=${d.diff}`)
    const label: Record<string, string> = { added: '新增', removed: '删除', modified: '修改' }
    $('diffView').innerHTML = `<h4>v${d.diff} → 当前</h4>` + (r.changes.length === 0 ? '<div class="muted">无变化</div>' : r.changes.map((c: any) =>
      `<div class="${c.kind}">[${label[c.kind]}] ${esc(c.kind === 'removed' ? c.before : c.after)}${c.kind === 'modified' ? `<div class="muted">原：${esc(c.before)}</div>` : ''}</div>`).join(''))
  }
}

const VERDICT: Record<string, string> = { supported: '支持', unsupported: '不支持', unclear: '无法判断', missing_citation: '缺出处' }

/** 最近一次导入参考文献的结果（重绘引用页时保留）。 */
let refImportHtml = ''

function renderCites(): void {
  const list: any[] = detail?.citations ?? []
  const checks: any[] = detail?.claim_checks ?? []
  const counts = checks.reduce((m: Record<string, number>, c: any) => { m[c.verdict] = (m[c.verdict] ?? 0) + 1; return m }, {})
  const summary = checks.length === 0 ? '<span class="muted">还没有核对过</span>'
    : Object.entries(counts).map(([v, n]) => `<span class="verdict ${v}">${VERDICT[v] ?? v} ${n}</span>`).join(' ')
  const flagged = checks.filter(c => c.verdict !== 'supported').map(c =>
    `<div class="claim"><span class="verdict ${c.verdict}">${VERDICT[c.verdict] ?? c.verdict}</span> ${esc(c.sentence)}<div class="muted">${esc(c.reason)}</div></div>`).join('')
  $('cites').innerHTML = `<div class="card"><div class="row"><b>论断核对</b><span class="grow"></span><button id="verifyBtn" class="ai">核对全部论断</button></div>
      <div class="muted" style="margin:4px 0">对照所引文献的 PubMed 摘要逐句核对；有问题的句子会挂一条 AI 评论，不会自动改写。</div>
      <div>${summary}</div>${flagged}</div>` +
    `<div class="card"><div class="row"><b>参考文献</b><span class="grow"></span><button id="refImportBtn" title="从 Zotero / EndNote / Mendeley / PubMed 导出的文件，或每行一个 DOI / PMID">导入参考文献</button>
      <input type="file" id="refImportInput" accept=".ris,.bib,.nbib,.txt,.xml,.enw" hidden></div>
      <div class="muted" style="margin:4px 0">导入后登记在这里（未使用），你和 AI 都能直接引用；每条按 DOI 核实，查不到的会列出来。</div><div id="refImportResult">${refImportHtml}</div></div>` +
    (list.length === 0 ? '<div class="muted">AI 通过文献检索登记的引用会显示在这里</div>' : list.map(c =>
      `<div class="card"><b>${c.number ? `[${c.number}]` : '未使用'}</b> ${esc(c.formatted)} <a href="${esc(c.url || `https://doi.org/${c.doi}`)}" target="_blank" rel="noopener">原文</a></div>`).join(''))
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
  $('verifyBtn').onclick = async () => {
    if (!session) return
    try {
      await api(`/api/docs/${session.docId}/verify?async=1`, { method: 'POST' })
      switchTab('chatPane')
    } catch (err) {
      showNotice((err as Error).message, true)
    }
  }
}

// —— 杂项 ——

function switchTab(id: string): void {
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === id))
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === id))
}
document.querySelector<HTMLElement>('.tabs')!.onclick = e => {
  const tab = (e.target as HTMLElement).closest('button')?.dataset.tab
  if (tab) switchTab(tab)
}

$('exportBtn').onclick = e => {
  e.stopPropagation()
  $('exportMenu').hidden = !$('exportMenu').hidden
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
$('exportDocxBtn').onclick = () => { if (session) location.href = `/api/docs/${session.docId}/export.docx?token=${encodeURIComponent(TOKEN)}&fonts=${exportFonts()}` }
$('exportPptxBtn').onclick = () => { if (session) location.href = `/api/docs/${session.docId}/export.pptx?token=${encodeURIComponent(TOKEN)}&fonts=${exportFonts()}` }
$('exportMdBtn').onclick = () => { if (session) location.href = `/api/docs/${session.docId}/export.md?token=${encodeURIComponent(TOKEN)}` }
// 开发者：读视图（用户菜单里，仅开发模式）
document.addEventListener('heurion:readview', async () => {
  if (!session) { showNotice('先打开一份文档'); return }
  const w = window.open('', '_blank')
  const text = await api<string>(`/api/docs/${session.docId}/read`)
  if (w) w.document.body.innerHTML = `<pre style="white-space:pre-wrap;font:13px ui-monospace,monospace">${esc(text)}</pre>`
})

// 启动：没有令牌 → 登录页；有令牌 → 取当前用户，失效时 api() 会回到登录页
async function boot(): Promise<void> {
  if (!TOKEN) { $('app').hidden = true; await showAuthScreen(); return }
  const me = await api<Me>('/api/me')
  ME = me
  initUserMenu(me, api, showNotice)
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

// —— 窄屏（手机 / 平板竖屏）：左栏与右栏变成滑出面板 ——
{
  const app = $('app')
  const setPanel = (which: 'nav' | 'side' | null) => {
    app.classList.toggle('nav-open', which === 'nav')
    app.classList.toggle('side-open', which === 'side')
  }
  $('navToggle').onclick = () => setPanel(app.classList.contains('nav-open') ? null : 'nav')
  $('sideToggle').onclick = () => setPanel(app.classList.contains('side-open') ? null : 'side')
  $('sideClose').onclick = () => setPanel(null)
  $('scrim').onclick = () => setPanel(null)
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('.dialog:not([hidden])')) setPanel(null) })
  // 在列表里点开文档、新建后收起左栏
  $('docList').addEventListener('click', e => { if ((e.target as HTMLElement).closest('li[data-id]')) setPanel(null) })
  for (const id of ['newDoc', 'newDeck']) $(id).addEventListener('click', () => setPanel(null))
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

initNavResizer()

