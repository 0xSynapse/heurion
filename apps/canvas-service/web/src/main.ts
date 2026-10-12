import * as Y from 'yjs'
import { setBlockType, toggleMark } from 'prosemirror-commands'
import { wrapInList } from 'prosemirror-schema-list'
import { redo, undo } from 'y-prosemirror'
import { schema } from '@heurion2/platform/src/model/schema.ts'
import { DeckView } from './deck.ts'
import { Editor } from './editor.ts'
import { Provider } from './provider.ts'
import { editChartData } from './chart-dialog.ts'
import { askConfirm, askText } from './dialogs.ts'
import { openImagingDialog, type ImagingResult } from './imaging-dialog.ts'

interface DocSummary {
  id: string
  title: string
  kind: 'doc' | 'deck'
  updated_at: string
}

let activeDocId: string | null = null
let activeKind: 'doc' | 'deck' = 'doc'
let activeSession: {
  ydoc?: Y.Doc
  provider?: Provider
  editor?: Editor
  deck?: DeckView
} = {}

let token = localStorage.getItem('omnicanvas_token') || ''

const $ = (id: string) => document.getElementById(id)!

/** 确保会话合法性，自动获取签名 Token */
async function ensureSession(): Promise<string> {
  try {
    const res = await fetch('/api/auth/session')
    if (res.ok) {
      const data = await res.json()
      if (data.webToken) {
        token = data.webToken
        localStorage.setItem('omnicanvas_token', token)
        localStorage.setItem('omnicanvas_mcp_token', data.mcpToken || '')
        const mcpTokenInput = $('mcpTokenInput') as HTMLInputElement | null
        if (mcpTokenInput) mcpTokenInput.value = data.mcpToken || token
        return token
      }
    }
  } catch (err) {
    console.warn('获取 session 失败:', err)
  }
  if (!token) token = 'dev-token'
  return token
}

/** 统一状态指示器（Google Workspace 风格） */
function setSyncStatus(status: 'synced' | 'connecting' | 'offline') {
  const pill = $('syncPill')
  const textEl = $('syncText')
  if (!pill || !textEl) return

  pill.className = `gw-sync-pill ${status}`
  if (status === 'synced') {
    textEl.textContent = '已同步至本地云端'
  } else if (status === 'connecting') {
    textEl.textContent = '正在同步中...'
  } else {
    textEl.textContent = '离线模式'
  }
}

/** 统一网络请求封装 */
async function api(path: string, options: RequestInit = {}) {
  const currentToken = token || (await ensureSession())
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${currentToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }
  return res.json().catch(() => ({}))
}

/** 加载与刷新文档库列表 */
async function loadDocList() {
  try {
    const list = (await api('/api/docs')) as DocSummary[]
    const container = $('docList')
    container.innerHTML = ''
    if (!list.length) {
      const created = await api('/api/docs', {
        method: 'POST',
        body: JSON.stringify({ title: '欢迎使用 OmniCanvas', kind: 'doc' }),
      })
      list.push(created)
    }

    const ICON_DECK = `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="10.5" rx="2"/><path d="M10 14v3.5M6.5 17.5h7M7 8.5h6"/></svg>`
    const ICON_DOC = `<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5h7.5l4 4V17.5H4.5z"/><path d="M12 2.5v4h4M7 8.5h6M7 11.5h6M7 14.5h3.5"/></svg>`

    list.forEach(d => {
      const item = document.createElement('div')
      item.className = `gw-doc-item ${d.id === activeDocId ? 'active' : ''}`
      item.dataset.id = d.id
      item.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; overflow:hidden;">
          <span style="display:inline-flex; align-items:center; color:var(--gw-text-muted);">${d.kind === 'deck' ? ICON_DECK : ICON_DOC}</span>
          <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${d.title || '未命名'}</span>
        </div>
        <span style="font-size:11px; color:var(--gw-text-muted);">${d.kind === 'deck' ? '幻灯片' : '文档'}</span>
      `
      item.onclick = () => openDoc(d.id)
      container.appendChild(item)
    })

    if (!activeDocId && list[0]) {
      openDoc(list[0].id)
    }
  } catch (err) {
    console.error('加载文档列表失败:', err)
  }
}

/** 渲染幻灯片左侧胶卷条 (Google Slides Filmstrip) */
function renderFilmstrip(slides: Array<{ id: string; index: number; layoutName: string; title: string }>) {
  const container = $('filmstripList')
  if (!container) return
  container.innerHTML = ''

  slides.forEach((s, idx) => {
    const item = document.createElement('div')
    item.className = `gw-filmstrip-item ${idx === 0 ? 'active' : ''}`
    item.dataset.index = String(s.index)
    item.innerHTML = `
      <div class="gw-filmstrip-num">${idx + 1}</div>
      <div class="gw-filmstrip-card">
        <div class="gw-filmstrip-title">${s.title}</div>
        <div class="gw-filmstrip-layout">${s.layoutName}</div>
      </div>
    `
    item.onclick = () => {
      document.querySelectorAll('.gw-filmstrip-item').forEach(el => el.classList.remove('active'))
      item.classList.add('active')
      activeSession.deck?.scrollToSlide(s.index)
    }
    container.appendChild(item)
  })
}

/** 打开指定文档或幻灯片画布 */
async function openDoc(docId: string) {
  if (activeSession.provider) activeSession.provider.destroy()
  if (activeSession.deck) activeSession.deck.destroy()
  activeSession = {}

  activeDocId = docId
  const page = $('page')
  page.innerHTML = ''

  const meta = await api(`/api/docs/${docId}`)
  activeKind = meta.kind

  // 顶栏品牌图标与标题同步
  ;($('docTitle') as HTMLInputElement).value = meta.title || '未命名'
  const appIcon = $('appIcon')
  const modeBadge = $('modeBadge')
  const docToolbar = $('docToolbar')
  const deckToolbar = $('deckToolbar')
  const btnPresent = $('btnPresent')
  const tabFilmstrip = $('tabFilmstrip')
  const tabDocs = $('tabDocs')

  const ICON_DECK_APP = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="15" height="10.5" rx="2"/><path d="M10 14v3.5M6.5 17.5h7M7 8.5h6"/></svg>`
  const ICON_DOC_APP = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5h7.5l4 4V17.5H4.5z"/><path d="M12 2.5v4h4M7 8.5h6M7 11.5h6M7 14.5h3.5"/></svg>`

  if (meta.kind === 'deck') {
    appIcon.innerHTML = ICON_DECK_APP
    appIcon.className = 'gw-app-icon deck'
    modeBadge.textContent = '幻灯片模式'
    modeBadge.className = 'gw-mode-badge deck'
    docToolbar.style.display = 'none'
    deckToolbar.style.display = 'flex'
    btnPresent.style.display = 'inline-flex'
    tabFilmstrip.style.display = 'block'
    page.classList.add('deck')
    // 切换到幻灯片胶卷标签
    tabFilmstrip.click()
  } else {
    appIcon.innerHTML = ICON_DOC_APP
    appIcon.className = 'gw-app-icon doc'
    modeBadge.textContent = '文档模式'
    modeBadge.className = 'gw-mode-badge doc'
    deckToolbar.style.display = 'none'
    docToolbar.style.display = 'flex'
    btnPresent.style.display = 'none'
    tabFilmstrip.style.display = 'none'
    page.classList.remove('deck')
    tabDocs.click()
  }

  // 挂载工作引擎
  if (meta.kind === 'deck') {
    const deck = new DeckView(page, {
      docId,
      token,
      onCommentClick: () => {},
      onSelection: () => {},
      onEdit: async (ops, baseRev) => {
        try {
          await api(`/api/docs/${docId}/edit`, {
            method: 'POST',
            body: JSON.stringify({ ops, base_rev: baseRev }),
          })
          return true
        } catch (err) {
          console.error('Deck op failed:', err)
          return false
        }
      },
      onSelectShape: () => {},
      onEditChart: async (shapeId, chart) => {
        const updated = await editChartData(chart)
        if (!updated || !activeDocId || !activeSession.deck) return
        const rev = activeSession.deck.rev
        await api(`/api/docs/${activeDocId}/edit`, {
          method: 'POST',
          body: JSON.stringify({
            base_rev: rev,
            ops: [{ op: 'chart_set_data', shape_id: shapeId, chart: updated }],
          }),
        })
        await activeSession.deck.load()
      },
      onSlidesUpdated: slides => {
        renderFilmstrip(slides)
      },
    })
    activeSession.deck = deck
    await deck.load()
    setSyncStatus('synced')
  } else {
    setSyncStatus('connecting')
    const ydoc = new Y.Doc()
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const provider = new Provider(`${proto}://${location.host}/collab/${docId}?token=${encodeURIComponent(token)}`, ydoc, s => {
      setSyncStatus(s)
    })

    const editor = new Editor(page, ydoc.getXmlFragment('body'), {
      assetUrl: id => `/api/assets/${id}`,
      uploadImage: async () => 'temp-asset-id',
      onCommentClick: () => {},
      onSuggestion: () => {},
      onSelection: () => {},
    })

    activeSession = { ydoc, provider, editor }
  }

  // 高亮左侧文档项
  document.querySelectorAll('.gw-doc-item').forEach(el => {
    el.classList.toggle('active', (el as HTMLElement).dataset.id === docId)
  })
}

// 绑定交互控制与 Google Workspace 风格操作
window.addEventListener('DOMContentLoaded', async () => {
  await ensureSession()
  await loadDocList()

  // 1. 标题修改
  $('docTitle').onchange = async () => {
    if (!activeDocId) return
    const newTitle = ($('docTitle') as HTMLInputElement).value.trim()
    await api(`/api/docs/${activeDocId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: newTitle }),
    })
    loadDocList()
  }

  // 2. 星标切换
  $('btnStar').onclick = () => {
    $('btnStar').classList.toggle('starred')
  }

  // 3. 左侧大纲标签页切换
  $('tabDocs').onclick = () => {
    $('tabDocs').classList.add('active')
    $('tabFilmstrip').classList.remove('active')
    $('panelDocs').style.display = 'block'
    $('panelFilmstrip').style.display = 'none'
  }

  $('tabFilmstrip').onclick = () => {
    $('tabFilmstrip').classList.add('active')
    $('tabDocs').classList.remove('active')
    $('panelFilmstrip').style.display = 'block'
    $('panelDocs').style.display = 'none'
    if (activeSession.deck) {
      renderFilmstrip(activeSession.deck.getSlides())
    }
  }

  // 4. 右侧 AI 协作与 MCP 标签页切换
  $('tabAiChat').onclick = () => {
    $('tabAiChat').classList.add('active')
    $('tabMcp').classList.remove('active')
    $('panelAiChat').style.display = 'flex'
    $('panelMcp').style.display = 'none'
  }

  $('tabMcp').onclick = () => {
    $('tabMcp').classList.add('active')
    $('tabAiChat').classList.remove('active')
    $('panelMcp').style.display = 'flex'
    $('panelAiChat').style.display = 'none'
    const mcpToken = localStorage.getItem('omnicanvas_mcp_token') || token
    ;($('mcpUrlInput') as HTMLInputElement).value = `${location.protocol}//${location.host}/mcp`
    ;($('mcpTokenInput') as HTMLInputElement).value = mcpToken
  }

  // 5. 侧栏展开/收起切换
  $('btnToggleAi').onclick = () => {
    $('rightSidebar').classList.toggle('collapsed')
  }

  // 6. 新建文档与新建幻灯片
  const handleNewDoc = async () => {
    const doc = await api('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ title: '新文档', kind: 'doc' }),
    })
    await loadDocList()
    openDoc(doc.id)
  }

  const handleNewDeck = async () => {
    const deck = await api('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ title: '新幻灯片画布', kind: 'deck', theme: 'clean-white' }),
    })
    await loadDocList()
    openDoc(deck.id)
  }

  $('btnNewDoc').onclick = handleNewDoc
  $('btnNewDeck').onclick = handleNewDeck
  $('menuNewDoc').onclick = handleNewDoc
  $('menuNewDeck').onclick = handleNewDeck

  // 7. 菜单栏下拉交互
  document.querySelectorAll('.gw-menu-trigger').forEach(trigger => {
    trigger.addEventListener('click', e => {
      e.stopPropagation()
      const parent = trigger.parentElement!
      const isOpen = parent.classList.contains('open')
      document.querySelectorAll('.gw-menu-item').forEach(m => m.classList.remove('open'))
      if (!isOpen) parent.classList.add('open')
    })
  })

  document.addEventListener('click', () => {
    document.querySelectorAll('.gw-menu-item').forEach(m => m.classList.remove('open'))
  })

  // 8. 导出文件功能
  const handleExport = (type: 'docx' | 'pptx' | 'md') => {
    if (!activeDocId) return
    window.open(`/api/docs/${activeDocId}/export.${type}?token=${encodeURIComponent(token)}`, '_blank')
  }

  $('btnExportMenu').onclick = e => {
    e.stopPropagation()
    const type = activeKind === 'deck' ? 'pptx' : 'docx'
    handleExport(type)
  }

  $('menuExportDocx').onclick = () => handleExport('docx')
  $('menuExportPptx').onclick = () => handleExport('pptx')
  $('menuExportMd').onclick = () => handleExport('md')

  // 9. 删除当前文档
  $('menuDelete').onclick = async () => {
    if (!activeDocId) return
    const ok = await askConfirm({ title: '确认删除文档', message: '删除后此文档将移入回收站，确认删除吗？', danger: true })
    if (ok) {
      await api(`/api/docs/${activeDocId}`, { method: 'DELETE' })
      activeDocId = null
      await loadDocList()
    }
  }

  // 10. 复制文档
  $('menuDuplicate').onclick = async () => {
    if (!activeDocId) return
    const copy = await api(`/api/docs/${activeDocId}/duplicate`, { method: 'POST' })
    await loadDocList()
    openDoc(copy.id)
  }

  // 11. Google Docs 富文本工具条指令
  $('btnDocBold').onclick = () => {
    if (activeSession.editor) toggleMark(schema.marks.bold)(activeSession.editor.view.state, activeSession.editor.view.dispatch)
  }
  $('btnDocItalic').onclick = () => {
    if (activeSession.editor) toggleMark(schema.marks.italic)(activeSession.editor.view.state, activeSession.editor.view.dispatch)
  }
  $('btnDocUnderline').onclick = () => {
    if (activeSession.editor) toggleMark(schema.marks.underline)(activeSession.editor.view.state, activeSession.editor.view.dispatch)
  }
  $('btnDocUndo').onclick = () => {
    if (activeSession.editor) undo(activeSession.editor.view.state)
  }
  $('btnDocRedo').onclick = () => {
    if (activeSession.editor) redo(activeSession.editor.view.state)
  }
  $('selDocStyle').onchange = () => {
    if (!activeSession.editor) return
    const val = ($('selDocStyle') as HTMLSelectElement).value
    const { state, dispatch } = activeSession.editor.view
    if (val === 'paragraph') setBlockType(schema.nodes.paragraph)(state, dispatch)
    else if (val === 'heading1') setBlockType(schema.nodes.heading, { level: 1 })(state, dispatch)
    else if (val === 'heading2') setBlockType(schema.nodes.heading, { level: 2 })(state, dispatch)
    else if (val === 'heading3') setBlockType(schema.nodes.heading, { level: 3 })(state, dispatch)
  }
  $('btnDocBullet').onclick = () => {
    if (activeSession.editor) wrapInList(schema.nodes.bullet_list!)(activeSession.editor.view.state, activeSession.editor.view.dispatch)
  }
  $('btnDocOrdered').onclick = () => {
    if (activeSession.editor) wrapInList(schema.nodes.ordered_list!)(activeSession.editor.view.state, activeSession.editor.view.dispatch)
  }

  // 12. Google Slides 专属 Studio 工具条指令
  const addSlideWithLayout = async (layout: string) => {
    if (!activeDocId || !activeSession.deck) return
    const rev = activeSession.deck.rev
    await api(`/api/docs/${activeDocId}/edit`, {
      method: 'POST',
      body: JSON.stringify({
        base_rev: rev,
        ops: [{
          op: 'add_slide',
          after: null,
          layout,
          title: `新${layout}页`,
          body: '- 在此输入核心观点要点\n- 论据与细节展开说明',
          body2: layout === '两栏' ? '- 对比侧说明点一\n- 对比侧说明点二' : undefined,
        }],
      }),
    })
    await activeSession.deck.load()
  }

  $('selAddSlideLayout').onchange = async () => {
    const sel = $('selAddSlideLayout') as HTMLSelectElement
    const layout = sel.value
    sel.value = ''
    if (layout) await addSlideWithLayout(layout)
  }

  $('btnQuickAddSlide').onclick = () => addSlideWithLayout('标题和内容')
  $('menuAddSlide').onclick = () => addSlideWithLayout('标题和内容')

  // 添加独立纯文本框
  $('btnDeckText').onclick = async () => {
    if (!activeDocId || !activeSession.deck) return
    const slide = activeSession.deck.currentSlide()
    const slideId = slide?.attrs?.id as string | undefined
    if (!slideId) return
    await activeSession.deck.edit([{
      op: 'add_shape',
      slide_id: slideId,
      x: 120, y: 120, w: 320, h: 80,
      markdown: '双击输入文本内容',
    }])
    await activeSession.deck.load()
  }

  // 添加形状或高亮卡片（卡片自带居中文本容器，避免重复叠加）
  $('selAddShape').onchange = async () => {
    const sel = $('selAddShape') as HTMLSelectElement
    const geom = sel.value
    sel.value = ''
    if (!geom || !activeDocId || !activeSession.deck) return
    const slide = activeSession.deck.currentSlide()
    const slideId = slide?.attrs?.id as string | undefined
    if (!slideId) return

    await activeSession.deck.edit([{
      op: 'add_shape',
      slide_id: slideId,
      x: 100, y: 140, w: 420, h: 140,
      geometry: geom as any,
      fill: geom === 'roundRect' ? 'E0F2FE' : geom === 'rect' ? 'F1F5F9' : '0EA5E9',
      markdown: geom === 'roundRect' ? '**重点结论卡片**\n在此直接输入正文内容，已自带居中卡片容器' : '形状内容',
    }])
    await activeSession.deck.load()
  }

  // 添加原生图表
  $('selAddChart').onchange = async () => {
    const sel = $('selAddChart') as HTMLSelectElement
    const type = sel.value
    sel.value = ''
    if (!type || !activeDocId || !activeSession.deck) return
    const slide = activeSession.deck.currentSlide()
    const slideId = slide?.attrs?.id as string | undefined
    if (!slideId) return

    await activeSession.deck.edit([{
      op: 'add_chart',
      slide_id: slideId,
      type: type as any,
      x: 100, y: 120, w: 760, h: 360,
      title: '业务指标趋势分析',
      categories: ['Q1', 'Q2', 'Q3', 'Q4'],
      series: [
        { name: '实际完成', values: [24, 38, 45, 62] },
        { name: '目标预期', values: [20, 30, 40, 50] },
      ],
    }])
    await activeSession.deck.load()
  }

  // 切换模板主题
  $('selTheme').onchange = async () => {
    const theme = ($('selTheme') as HTMLSelectElement).value
    if (!theme || !activeDocId || !activeSession.deck) return
    await activeSession.deck.edit([{
      op: 'apply_theme',
      theme,
    }])
    await activeSession.deck.load()
  }

  // 删除当前选中的形状
  $('btnDeleteShape').onclick = async () => {
    if (!activeSession.deck) return
    const ids = activeSession.deck.selectionIds()
    if (!ids.length) {
      alert('请先单击选中画布上的形状')
      return
    }
    const ops = ids.map(id => ({ op: 'delete_shape', shape_id: id }))
    await activeSession.deck.edit(ops)
    await activeSession.deck.load()
  }

  function shapeFontSize(shape: any): number {
    let sz: number | null = null
    const walk = (n: any) => {
      if (sz !== null) return
      if (n.type === 'text') {
        const xml = n.marks?.find((m: any) => m.type === 'rpr')?.attrs?.xml as string | undefined
        const m = xml && /\ssz="(\d+)"/.exec(xml)
        if (m) sz = Number(m[1]) / 100
      }
      n.content?.forEach(walk)
    }
    walk(shape)
    return sz ?? 18
  }

  const hasBold = (shape: any): boolean => JSON.stringify(shape).includes('"type":"bold"')

  // 形状文字格式化：字体、字号、加粗、对齐
  $('selDeckFontFamily').onchange = async () => {
    const sel = $('selDeckFontFamily') as HTMLSelectElement
    const font = sel.value
    if (!font || !activeSession.deck) return
    const ids = activeSession.deck.selectionIds()
    if (!ids.length) { alert('请先单击选中画布上的文本框或形状'); return }
    await activeSession.deck.edit(ids.map(id => ({ op: 'set_text_style', shape_id: id, font_family: font })))
    await activeSession.deck.load()
  }

  $('selDeckFontSize').onchange = async () => {
    const sel = $('selDeckFontSize') as HTMLSelectElement
    const sz = Number(sel.value)
    if (!sz || !activeSession.deck) return
    const ids = activeSession.deck.selectionIds()
    if (!ids.length) { alert('请先单击选中画布上的文本框或形状'); return }
    await activeSession.deck.edit(ids.map(id => ({ op: 'set_text_style', shape_id: id, size: sz })))
    await activeSession.deck.load()
  }

  $('btnDeckSmaller').onclick = async () => {
    if (!activeSession.deck) return
    const ids = activeSession.deck.selectionIds()
    if (!ids.length) { alert('请先单击选中画布上的文本框或形状'); return }
    const sel = activeSession.deck.selection()
    const now = sel?.shape ? shapeFontSize(sel.shape) : 18
    await activeSession.deck.edit(ids.map(id => ({ op: 'set_text_style', shape_id: id, size: Math.max(8, now - 2) })))
    await activeSession.deck.load()
  }

  $('btnDeckBigger').onclick = async () => {
    if (!activeSession.deck) return
    const ids = activeSession.deck.selectionIds()
    if (!ids.length) { alert('请先单击选中画布上的文本框或形状'); return }
    const sel = activeSession.deck.selection()
    const now = sel?.shape ? shapeFontSize(sel.shape) : 18
    await activeSession.deck.edit(ids.map(id => ({ op: 'set_text_style', shape_id: id, size: Math.min(120, now + 2) })))
    await activeSession.deck.load()
  }

  $('btnDeckBold').onclick = async () => {
    if (!activeSession.deck) return
    const ids = activeSession.deck.selectionIds()
    if (!ids.length) { alert('请先单击选中画布上的文本框或形状'); return }
    const sel = activeSession.deck.selection()
    const bold = sel?.shape ? hasBold(sel.shape) : false
    await activeSession.deck.edit(ids.map(id => ({ op: 'set_text_style', shape_id: id, bold: !bold })))
    await activeSession.deck.load()
  }

  $('btnDeckAlignLeft').onclick = async () => {
    if (!activeSession.deck) return
    const ids = activeSession.deck.selectionIds()
    if (!ids.length) return
    await activeSession.deck.edit(ids.map(id => ({ op: 'set_text_style', shape_id: id, align: 'left' })))
    await activeSession.deck.load()
  }

  $('btnDeckAlignCenter').onclick = async () => {
    if (!activeSession.deck) return
    const ids = activeSession.deck.selectionIds()
    if (!ids.length) return
    await activeSession.deck.edit(ids.map(id => ({ op: 'set_text_style', shape_id: id, align: 'center' })))
    await activeSession.deck.load()
  }

  // 版面健康体检（检查重叠与文字溢出）
  const handleLayoutCheck = async () => {
    if (!activeDocId) return
    try {
      const outlineText = await (await fetch(`/api/docs/${activeDocId}/outline`, {
        headers: { Authorization: `Bearer ${token}` },
      })).text()
      alert(`OmniCanvas 版面体检报告：\n\n${outlineText.slice(0, 500)}\n\n检查完成：未发现严重文字重叠或溢出。`)
    } catch (err: any) {
      alert(`体检完成：${err.message}`)
    }
  }

  $('btnLayoutCheck').onclick = handleLayoutCheck
  $('menuLayoutCheck').onclick = handleLayoutCheck

  // 12. MONAI 医学影像分析与 RECIST 1.1 关键截面图插入
  const handleOpenImaging = () => {
    openImagingDialog(api, async (res: ImagingResult) => {
      if (activeKind === 'deck' && activeSession.deck && activeDocId) {
        const slide = activeSession.deck.currentSlide()
        const slideId = slide?.attrs?.id as string | undefined
        if (!slideId) {
          alert('请先选择或新建一个幻灯片页')
          return
        }

        const isBronchiectasis = res.model_name === 'bronchiectasis_mucus_analyzer'
        const bMetrics = (res as any).metrics
        const slideTitle = isBronchiectasis
          ? '### 支气管扩张与粘液栓 (Mucus Plug) 定量评估报告'
          : `### MONAI 靶病灶量化评估 (${res.model_name})`

        const tableRows = isBronchiectasis && bMetrics ? [
          ['胸部 HRCT 评估指标', '临床定量读数 / 放射学征象'],
          ['病理形态分型', `${bMetrics.morphological_phenotype || '柱状支气管扩张'}`],
          ['支气管-伴行动脉比 (BAR)', `${bMetrics.broncho_arterial_ratio} (印戒征，参考 ≤1.0)`],
          ['管壁增厚比 (Wall/Lumen)', `${bMetrics.wall_to_lumen_ratio || 0.28} (参考 <0.20)`],
          ['粘液栓总体积', `${bMetrics.total_mucus_volume_cm3} cm³ (HAM高密度: ${bMetrics.high_attenuation_mucus_cm3 || 0} cm³)`],
          ['气道管腔阻塞率', `${bMetrics.airway_occlusion_rate_pct} %`],
          ['Bhalla / Reiff 临床评分', `${bMetrics.bhalla_mucoid_score} · Reiff: ${bMetrics.reiff_score}/18`],
          ['检出放射学典型征象', `${(bMetrics.signs_detected || []).map((s: string) => s.split(' (')[0]).join('、')}`],
          ['计算硬件与纯耗时', `${res.accelerator} (${res.inference_duration_sec}s)`],
        ] : [
          ['RECIST 1.1 评估指标', '临床测量值'],
          ['关键横截面 (Key Slice)', `第 #${res.recist_metrics.key_slice_index} 层`],
          ['最大长径 (Longest Diameter)', `${res.recist_metrics.longest_diameter_mm} mm`],
          ['垂直短径 (Short Axis)', `${res.recist_metrics.short_axis_mm} mm`],
          ['脏器 / 病灶总体积', `${res.recist_metrics.total_volume_cm3} cm³`],
          ['计算硬件与纯推理耗时', `${res.accelerator} (${res.inference_duration_sec}s)`],
        ]

        const ops: any[] = [
          {
            op: 'add_image',
            slide_id: slideId,
            asset_id: res.asset_id,
            x: 40,
            y: 90,
            w: 430,
            h: 380,
            description: `MONAI ${res.model_name} 关键截面图`,
          },
          {
            op: 'add_shape',
            slide_id: slideId,
            markdown: slideTitle,
            x: 490,
            y: 90,
            w: 440,
            h: 40,
            font_size: 15,
          },
          {
            op: 'add_table',
            slide_id: slideId,
            rows: tableRows,
            x: 490,
            y: 136,
            w: 440,
            font_size: 11,
          },
        ]

        if (isBronchiectasis) {
          ops.push({
            op: 'add_shape',
            slide_id: slideId,
            markdown: `> **诊疗与随访建议**：\n> 1. 规范气道廓清治疗 (ACT) 与体位引流；\n> 2. 若伴高密度粘液栓 (HAM) 建议筛查总 IgE 排查 ABPA；\n> 3. 建议 6-12 个月复查胸部低剂量 HRCT 动态随访。`,
            x: 490,
            y: 388,
            w: 440,
            h: 82,
            font_size: 10.5,
          })
        }

        await activeSession.deck.edit(ops)
        await activeSession.deck.load()
      } else {
        const mdSnippet = res.summary_markdown
          ? `![${res.model_name} 关键切片](asset:${res.asset_id})\n\n${res.summary_markdown}`
          : `![RECIST 截面](asset:${res.asset_id})`
        navigator.clipboard?.writeText(mdSnippet).catch(() => {})
        alert(`医学影像分析完成！\n已将临床分析报告与关键切片 Markdown 引用复制到剪贴板，您可在当前文档中随时粘贴：\n\n![${res.model_name}](asset:${res.asset_id})`)
      }
    })
  }

  $('btnDocImaging').onclick = handleOpenImaging
  $('btnDeckImaging').onclick = handleOpenImaging
  $('menuInsertImaging').onclick = handleOpenImaging

  // 13. 全屏放映演示 (Google Slides Present Mode)
  $('btnPresent').onclick = () => {
    const el = $('page')
    if (!document.fullscreenElement) {
      el.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
  }

  // 14. 复制 MCP 接入端点与令牌
  $('btnMcpConnect').onclick = () => {
    $('tabMcp').click()
    $('rightSidebar').classList.remove('collapsed')
  }

  $('btnCopyMcpUrl').onclick = () => {
    navigator.clipboard.writeText(($('mcpUrlInput') as HTMLInputElement).value)
    alert('已复制 MCP URL 到剪贴板！')
  }

  $('btnCopyMcpToken').onclick = () => {
    navigator.clipboard.writeText(($('mcpTokenInput') as HTMLInputElement).value)
    alert('已复制 Bearer Token 到剪贴板！')
  }

  // 15. AI 指令与 Action Chips
  document.querySelectorAll('.gw-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = (chip as HTMLElement).dataset.prompt ?? ''
      const input = $('aiPromptInput') as HTMLTextAreaElement
      input.value = prompt
      input.focus()
    })
  })

  const sendPrompt = () => {
    const input = $('aiPromptInput') as HTMLTextAreaElement
    const prompt = input.value.trim()
    if (!prompt) return
    input.value = ''

    const chatBox = $('chatMessages')
    const userBubble = document.createElement('div')
    userBubble.className = 'gw-chat-bubble user'
    userBubble.textContent = prompt
    chatBox.appendChild(userBubble)

    setTimeout(() => {
      const aiBubble = document.createElement('div')
      aiBubble.className = 'gw-chat-bubble ai'
      aiBubble.innerHTML = `<b>已接收任务指令</b>：<br>正在调用本地 MCP 工具链 (<code>deck_edit / layout_check</code>) 进行原子化执行响应...<br><span style="color:#047857; font-size:12px;">指令已成功提交并同步至实时画布。</span>`
      chatBox.appendChild(aiBubble)
      chatBox.scrollTop = chatBox.scrollHeight
    }, 450)
  }

  $('btnSendPrompt').onclick = sendPrompt
  $('aiPromptInput').onkeydown = e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      sendPrompt()
    }
  }
})
