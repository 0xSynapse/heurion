/**
 * 参考资料库（R2b）：上传论文 / 指南 / 内部材料，平台抽取文字、切块、向量化；AI 用 kb_search / kb_read 检索与读原文。
 * 这里是工作区里的资料库页（上传、处理状态、归入项目、试检索、删除）和对话框下方的「引用资料」选择。
 */
import { askConfirm } from './dialogs.ts'
import { icon } from './icons.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>

interface KbFile {
  id: string; name: string; status: 'pending' | 'extracting' | 'ocr' | 'embedding' | 'ready' | 'failed'
  project_id: string | null; note: string | null; pages: number; chunks: number; embedded: number; doi: string | null; pmid: string | null; size: number; created_at: string
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const STATUS: Record<KbFile['status'], string> = { pending: '排队中', extracting: '抽取文字', ocr: '识别文字', embedding: '向量化', ready: '可检索', failed: '失败' }
const ACCEPT = '.pdf,.docx,.pptx,.txt,.md'

function size(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

export interface LibraryHooks {
  /** 把中间区域换成一个页面（关掉文档、离开患者页 / 研究页），返回页面元素 */
  showPage(cls: string, title: string): HTMLElement
}

export function initLibrary(api: Api, token: () => string, notice: (msg: string, error?: boolean) => void, hooks: LibraryHooks) {
  /** 对话里选中的资料（发送时随消息带上，发完清空）。 */
  let picked: KbFile[] = []
  let poll: ReturnType<typeof setTimeout> | null = null

  async function upload(files: FileList | File[]): Promise<void> {
    const form = new FormData()
    for (const f of Array.from(files)) form.append('file', f)
    const res = await api<Array<KbFile & { duplicate?: boolean; error?: string }>>('/api/kb', { method: 'POST', body: form })
    const failed = res.filter(r => r.error)
    const dup = res.filter(r => r.duplicate)
    if (failed.length > 0) notice(failed.map(r => `${r.name}：${r.error}`).join('；'), true)
    else if (dup.length > 0) notice(`${dup.map(r => `「${r.name}」`).join('')}已在资料库里`)
  }

  async function openFile(f: KbFile): Promise<void> {
    // 原文要带令牌取，取到后在新标签页打开
    const res = await fetch(`/api/kb/${f.id}/file`, { headers: { Authorization: `Bearer ${token()}` } })
    if (!res.ok) { notice('打不开这份资料', true); return }
    const url = URL.createObjectURL(await res.blob())
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  // —— 资料库页 ——

  const PAGE = 'library-page'
  const page = () => document.getElementById('page')!
  const onPage = () => page().classList.contains(PAGE)
  let files: KbFile[] = []
  let projects: Array<{ id: string; name: string }> = []
  let vector = false
  let query = ''
  let hits: any[] | null = null

  const row = (f: KbFile) => {
    const busy = f.status !== 'ready' && f.status !== 'failed'
    const meta = [f.pages ? `${f.pages} 页` : '', size(f.size), f.doi ? `DOI ${f.doi}` : '', f.status === 'ready' && f.chunks > 0 && f.embedded < f.chunks ? '仅关键词' : ''].filter(Boolean).join(' · ')
    return `<tr data-id="${f.id}"><td><div class="kb-name"><b>${esc(f.name)}</b></div><div class="muted small">${esc(meta)}</div>${f.note ? `<div class="kb-note${f.status === 'failed' ? ' error' : ''}">${esc(f.note)}</div>` : ''}</td>
      <td><select data-project title="归入项目：项目里的文档对话时可按项目检索">${['<option value="">未归类</option>', ...projects.map(p => `<option value="${esc(p.id)}"${p.id === f.project_id ? ' selected' : ''}>${esc(p.name)}</option>`)].join('')}</select></td>
      <td><span class="kb-status ${f.status}${busy ? ' busy' : ''}">${STATUS[f.status]}</span></td>
      <td class="muted nowrap">${new Date(f.created_at).toLocaleDateString('zh-CN')}</td>
      <td class="actions"><div class="actions-row"><button data-view>原文</button><button data-del class="danger">删除</button></div></td></tr>`
  }

  function render(): void {
    if (!onPage()) return
    const el = page()
    const focusSearch = document.activeElement?.id === 'kbQuery'
    el.innerHTML = `
      <div class="pg-head">
        <h1>参考资料库</h1>
        <p class="muted">上传论文、指南、内部材料（PDF、docx、pptx、txt、md），AI 写作时会检索这些资料并标明出处；参考文献条目（RIS、BibTeX、EndNote、PubMed、DOI 列表）在文档右侧「参考文献」里导入。
          ${vector ? '' : '<br><b>向量检索暂不可用</b>（嵌入服务没启动），目前只按关键词检索，服务就绪后自动补上。'}</p>
      </div>
      <div class="kb-drop" id="kbDrop">把文件拖到这里，或 <button id="kbPick" class="primary">选择文件</button><input id="kbInput" type="file" accept="${ACCEPT}" multiple hidden></div>
      <form class="kb-search" id="kbSearch"><input id="kbQuery" type="search" placeholder="试检索：输入问题，看资料库能找到什么" value="${esc(query)}" autocomplete="off"><button>检索</button></form>
      ${hits === null ? '' : hits.length === 0 ? '<div class="muted">没有找到相关片段</div>' : `<section class="rs-card wide kb-hits-card"><div class="rs-card-head"><h3>检索结果</h3><button class="quiet small-btn" data-clear>清除</button></div><ol class="kb-hits">${hits.map(h => `<li><div class="muted small">《${esc(h.file_name)}》第 ${h.page} 页</div><div>${esc(h.text.slice(0, 280))}${h.text.length > 280 ? '…' : ''}</div></li>`).join('')}</ol></section>`}
      ${files.length === 0 ? '<div class="muted kb-empty">资料库还是空的</div>' : `<div class="pg-table"><table class="users kb-table"><thead><tr><th>资料（${files.length}）</th><th>项目</th><th>状态</th><th>上传</th><th></th></tr></thead><tbody>${files.map(row).join('')}</tbody></table></div>`}`
    if (focusSearch) { const q = el.querySelector<HTMLInputElement>('#kbQuery')!; q.focus(); q.setSelectionRange(q.value.length, q.value.length) }
  }

  async function refresh(): Promise<void> {
    if (!onPage()) return
    files = await api<KbFile[]>('/api/kb')
    render()
    // 有资料在处理中就隔两秒再看
    if (poll) clearTimeout(poll)
    poll = null
    if (files.some(f => f.status !== 'ready' && f.status !== 'failed')) poll = setTimeout(() => void refresh(), 2000)
  }
  const withRefresh = async (p: Promise<unknown>) => {
    try { await p } catch (err) { notice((err as Error).message, true) }
    await refresh()
  }

  async function openLibrary(): Promise<void> {
    ;[files, { vector }, projects] = await Promise.all([api<KbFile[]>('/api/kb'), api<{ vector: boolean }>('/api/kb-status'), api<Array<{ id: string; name: string }>>('/api/projects')])
    hooks.showPage(PAGE, '参考资料库')
    query = ''
    hits = null
    render()
    void refresh()
  }

  page().addEventListener('click', async e => {
    if (!onPage()) return
    const t = e.target as HTMLElement
    if (t.closest('#kbPick')) { page().querySelector<HTMLInputElement>('#kbInput')!.click(); return }
    if (t.closest('[data-clear]')) { query = ''; hits = null; render(); return }
    const f = files.find(x => x.id === (t.closest('tr[data-id]') as HTMLElement | null)?.dataset.id)
    if (!f) return
    if (t.closest('[data-view]')) void openFile(f)
    else if (t.closest('[data-del]')) {
      const ok = await askConfirm({ title: '删除资料', message: `删除「${f.name}」？AI 将检索不到它；已插入文档的引用不受影响。`, confirm: '删除', danger: true })
      if (!ok) return
      try { await api(`/api/kb/${f.id}`, { method: 'DELETE' }) } catch (err) { notice((err as Error).message, true) }
      picked = picked.filter(p => p.id !== f.id)
      renderPicked()
      await refresh()
    }
  })
  page().addEventListener('submit', async e => {
    if (!onPage() || (e.target as HTMLElement).id !== 'kbSearch') return
    e.preventDefault()
    query = page().querySelector<HTMLInputElement>('#kbQuery')!.value.trim()
    try { hits = query ? await api<any[]>(`/api/kb-search?q=${encodeURIComponent(query)}`) : null } catch (err) { notice((err as Error).message, true) }
    render()
  })
  page().addEventListener('change', async e => {
    if (!onPage()) return
    const t = e.target as HTMLElement
    if (t.id === 'kbInput') { const input = t as HTMLInputElement; if (input.files?.length) { const fl = Array.from(input.files); input.value = ''; void withRefresh(upload(fl)) } return }
    const sel = t.closest<HTMLSelectElement>('select[data-project]')
    const id = (sel?.closest('tr[data-id]') as HTMLElement | null)?.dataset.id
    if (!sel || !id) return
    try {
      await api(`/api/kb/${id}`, { method: 'PATCH', body: JSON.stringify({ project_id: sel.value || null }) })
      files = files.map(f => f.id === id ? { ...f, project_id: sel.value || null } : f)
      notice(sel.value ? `已归入「${projects.find(p => p.id === sel.value)?.name}」` : '已移出项目')
    } catch (err) { notice((err as Error).message, true) }
  })
  page().addEventListener('dragover', e => { const drop = (e.target as HTMLElement).closest<HTMLElement>('#kbDrop'); if (onPage() && drop) { e.preventDefault(); drop.classList.add('over') } })
  page().addEventListener('dragleave', e => { (e.target as HTMLElement).closest<HTMLElement>('#kbDrop')?.classList.remove('over') })
  page().addEventListener('drop', e => {
    const drop = (e.target as HTMLElement).closest<HTMLElement>('#kbDrop')
    if (!onPage() || !drop) return
    e.preventDefault(); drop.classList.remove('over')
    if (e.dataTransfer?.files.length) void withRefresh(upload(e.dataTransfer.files))
  })

  // —— 对话框下方：「引用资料」 ——

  function renderPicked(): void {
    const box = document.getElementById('kbPicked')!
    box.hidden = picked.length === 0
    box.innerHTML = picked.map(f => `<span class="chip" data-id="${f.id}" title="AI 会依据这份资料">${icon('file', { size: 12 })} ${esc(f.name)}<button class="chip-x" aria-label="移除">${icon('close', { size: 10 })}</button></span>`).join('')
  }

  async function openPicker(anchor: HTMLElement): Promise<void> {
    document.querySelector('.kb-picker')?.remove()
    const files = (await api<KbFile[]>('/api/kb')).filter(f => f.status === 'ready')
    const menu = document.createElement('div')
    menu.className = 'pop-menu kb-picker'
    menu.innerHTML = (files.length === 0
      ? '<div class="muted small kb-picker-empty">资料库里还没有可用的资料</div>'
      : files.map(f => `<label><input type="checkbox" value="${f.id}" ${picked.some(p => p.id === f.id) ? 'checked' : ''}> ${esc(f.name)}</label>`).join(''))
      + '<hr><button data-manage>管理资料库…</button>'
    document.body.append(menu)
    const r = anchor.getBoundingClientRect()
    const mr = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - (mr.width || 240) - 8))}px`
    menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`
    menu.style.maxHeight = `${Math.max(140, r.top - 16)}px`
    menu.style.overflowY = 'auto'
    menu.onchange = e => {
      const box = e.target as HTMLInputElement
      const f = files.find(x => x.id === box.value)!
      picked = box.checked ? [...picked, f] : picked.filter(p => p.id !== f.id)
      renderPicked()
    }
    menu.onclick = e => {
      if ((e.target as HTMLElement).closest('[data-manage]')) { close(); void openLibrary() }
    }
    const close = () => { menu.remove(); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', onKey) }
    const away = (e: MouseEvent) => { if (!menu.contains(e.target as Node) && e.target !== anchor) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    setTimeout(() => { document.addEventListener('mousedown', away); document.addEventListener('keydown', onKey) })
  }

  document.getElementById('libraryBtn')!.onclick = () => void openLibrary()
  document.getElementById('kbPickBtn')!.onclick = e => void openPicker(e.currentTarget as HTMLElement)
  document.getElementById('kbPicked')!.onclick = e => {
    const id = ((e.target as HTMLElement).closest('.chip-x')?.parentElement as HTMLElement | undefined)?.dataset.id
    if (id) { picked = picked.filter(p => p.id !== id); renderPicked() }
  }

  return {
    open: openLibrary,
    /** 离开资料库页（别的页面接管中间区域时） */
    leave(): void { if (poll) clearTimeout(poll); poll = null },
    /** 发送时取走选中的资料 id（发完清空）。 */
    takePicked(): string[] {
      const ids = picked.map(f => f.id)
      picked = []
      renderPicked()
      return ids
    },
  }
}
