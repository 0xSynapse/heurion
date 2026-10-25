/**
 * 数据集（实验室数据分析）：工作区里的「数据集」页（列表：上传、处理状态、所属研究；详情：身份信息列处理、变量与标签、预览、删除），
 * 对话框下方的「引用数据」选择，以及文档里分析图的「来自分析」（代码与数据来源）。
 */
import { askConfirm } from './dialogs.ts'
import { icon } from './icons.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>

interface Column {
  name: string; type: 'numeric' | 'categorical' | 'date' | 'text'; missing: number; unique: number; label?: string
  stats?: { mean: number | null; sd: number | null; median: number | null; q1: number | null; q3: number | null; min: number | null; max: number | null }
  top?: Array<{ value: string; count: number }>
  range?: [string, string]
}
interface Dataset {
  id: string; name: string; filename: string; format: string; size: number; status: 'processing' | 'review' | 'ready' | 'failed'
  rows: number; cols: number; error: string | null; created_at: string; updated_at: string
  /** 所属研究（归入研究项目时） */
  study?: { id: string; title: string } | null
  columns: Column[]; labels: Record<string, string>; phi: Array<{ name: string; reason: string }>; truncated: boolean
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
export const DATASET_ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,.xls,.xpt,.sas7bdat,.sav,.zsav,.dta'
const STATUS: Record<Dataset['status'], string> = { processing: '处理中', review: '待处理身份信息', ready: '可分析', failed: '失败' }
const TYPE: Record<Column['type'], string> = { numeric: '数值', categorical: '分类', date: '日期', text: '文本' }

const fmt = (n: number | null | undefined) => n === null || n === undefined ? '—' : Math.abs(n) >= 1000 ? n.toFixed(0) : Number(n.toPrecision(4)).toString()
function summary(c: Column, rows: number): string {
  if (c.type === 'numeric' && c.stats) return `中位数 ${fmt(c.stats.median)}（${fmt(c.stats.q1)}–${fmt(c.stats.q3)}），范围 ${fmt(c.stats.min)}–${fmt(c.stats.max)}`
  if (c.type === 'date' && c.range) return `${c.range[0]} 至 ${c.range[1]}`
  if (c.top?.length) {
    const n = rows - c.missing || 1
    return c.top.slice(0, 4).map(t => `${t.value} ${Math.round(t.count / n * 100)}%`).join('、') + (c.unique > 4 ? ` 等 ${c.unique} 类` : '')
  }
  return ''
}

export interface DatasetHooks {
  /** 把中间区域换成一个页面（关掉文档、离开患者页 / 研究页），返回页面元素 */
  showPage(cls: string, title: string): HTMLElement
  /** 打开研究页（数据集详情里「返回研究」） */
  openStudy(id: string): void
}

const PAGE = 'datasets-page'

export function initDatasets(api: Api, notice: (msg: string, error?: boolean) => void, hooks: DatasetHooks) {
  let picked: Dataset[] = []
  let poll: ReturnType<typeof setTimeout> | null = null
  /** 这次刚上传的：处理完如果要处理身份信息，直接打开详情 */
  const justUploaded = new Set<string>()
  const dlg = () => document.getElementById('dialog')!
  const page = () => document.getElementById('page')!
  const onPage = () => page().classList.contains(PAGE)
  /** 数据集页当前显示：列表，或某个数据集的详情 */
  let view: { kind: 'list'; list: Dataset[] } | { kind: 'detail'; x: Dataset } | null = null

  async function upload(files: FileList | File[]): Promise<Dataset[]> {
    const form = new FormData()
    for (const f of Array.from(files)) form.append('file', f)
    const res = await api<Array<Dataset & { duplicate?: boolean; error?: string }>>('/api/datasets', { method: 'POST', body: form })
    for (const r of res) if (r.id && !r.error) justUploaded.add(r.id)
    const failed = res.filter(r => r.error)
    if (failed.length) notice(failed.map(r => `${r.filename}：${r.error}`).join('；'), true)
    else if (res.some(r => r.duplicate)) notice('这份文件已经上传过了')
    return res.filter(r => r.id && !r.error)
  }

  const stopPoll = () => { if (poll) clearTimeout(poll); poll = null }
  const statusPill = (x: Dataset) => `<span class="kb-status ${x.status === 'ready' ? 'ready' : x.status === 'failed' ? 'failed' : x.status === 'review' ? 'review' : 'busy'}">${STATUS[x.status]}</span>`

  // —— 列表页 ——

  async function openList(): Promise<void> {
    stopPoll()
    const list = await api<Dataset[]>('/api/datasets')
    const el = hooks.showPage(PAGE, '数据集')
    view = { kind: 'list', list }
    const row = (x: Dataset) => `<tr data-id="${x.id}" class="${x.status === 'processing' || x.status === 'failed' ? '' : 'pg-row'}"><td><div class="kb-name"><b>${esc(x.name)}</b></div>${x.error ? `<div class="kb-note error">${esc(x.error)}</div>` : ''}</td>
      <td class="muted">${esc(x.format)}</td>
      <td class="muted nowrap">${x.status === 'ready' || x.status === 'review' ? `${x.rows.toLocaleString()} × ${x.cols}` : '—'}</td>
      <td>${statusPill(x)}</td>
      <td>${x.study ? `<button class="link-btn" data-study="${x.study.id}" title="打开研究">${esc(x.study.title)}</button>` : '<span class="muted">—</span>'}</td>
      <td class="actions"><div class="actions-row">${x.status === 'review' ? '<button data-open class="primary">处理身份信息</button>' : ''}<button data-del class="danger">删除</button></div></td></tr>`
    el.innerHTML = `
      <div class="pg-head">
        <h1>数据集</h1>
        <p class="muted">上传研究数据表（CSV、Excel 第一个工作表、SAS .xpt / .sas7bdat、SPSS .sav、Stata .dta，≤100 MB），在对话里「＋ 引用数据」或把数据集归入研究项目后，让 AI 做 Table 1、生存曲线、组间比较、回归。
          上传时会检查疑似身份信息的列（姓名、证件号、电话、病历号、地址、出生日期），处理后才能分析。</p>
      </div>
      <div class="kb-drop" id="dsDrop">把文件拖到这里，或 <button id="dsPick" class="primary">选择文件</button><input id="dsInput" type="file" accept="${DATASET_ACCEPT}" multiple hidden></div>
      ${list.length === 0 ? '<div class="muted kb-empty">还没有数据</div>' : `<div class="pg-table"><table class="users ds-list"><thead><tr><th>名称</th><th>格式</th><th>行 × 列</th><th>状态</th><th>所属研究</th><th></th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`}`
    if (list.some(x => x.status === 'processing')) poll = setTimeout(() => void refreshList(), 1500)
  }

  async function refreshList(): Promise<void> {
    if (!onPage() || view?.kind !== 'list') return
    const list = await api<Dataset[]>('/api/datasets')
    // 刚上传的处理完、需要处理身份信息：直接打开详情
    const fresh = list.find(x => justUploaded.has(x.id) && x.status === 'review')
    for (const x of list) if (x.status !== 'processing') justUploaded.delete(x.id)
    if (fresh) { void openDetail(fresh.id); return }
    await openList()
  }

  const withRefresh = async (p: Promise<unknown>) => {
    try { await p } catch (err) { notice((err as Error).message, true) }
    await refreshList()
  }

  // —— 详情页：身份信息处理、变量与标签、预览 ——

  async function openDetail(id: string): Promise<void> {
    stopPoll()
    const [x, preview, studies] = await Promise.all([api<Dataset>(`/api/datasets/${id}`), api<{ header: string[]; rows: string[][] }>(`/api/datasets/${id}/preview?limit=50`), api<Array<{ id: string; title: string }>>('/api/studies').catch(() => [])])
    const el = hooks.showPage(PAGE, x.name)
    view = { kind: 'detail', x }
    const phi = new Set(x.phi.map(p => p.name))
    el.innerHTML = `
      <div class="pg-crumbs"><button class="link-btn" data-back>← 全部数据集</button>${x.study ? `<span class="muted">·</span><button class="link-btn" data-study="${x.study.id}">← 返回研究「${esc(x.study.title)}」</button>` : ''}</div>
      <div class="rs-head">
        <input class="rs-title" id="dsName" value="${esc(x.name)}" aria-label="数据集名称">
        <div class="row"><span class="muted small">${esc(x.filename)} · ${esc(x.format)} · ${x.rows.toLocaleString()} 行 × ${x.cols} 列${x.truncated ? ' · <b>超过 200 万行，只导入了前 200 万行</b>' : ''}</span>
          ${statusPill(x)}<span class="grow"></span>${x.status === 'ready' ? `<button class="small-btn quiet" id="dsExportTable1Docx" title="直接导出该数据集的医学标准三线表 (.docx)">导出 Table 1 (.docx)</button>` : ''}${x.study ? `<button class="primary small-btn" data-study="${x.study.id}" title="进入所属研究的统计与医学制图工作台">打开研究分析工作台 →</button>` : ''}<label class="muted small ds-study">所属研究 <select id="dsStudy"><option value="">（未归入）</option>${studies.map(st => `<option value="${st.id}"${x.study?.id === st.id ? ' selected' : ''}>${esc(st.title)}</option>`).join('')}</select></label>
          <button class="danger small-btn" data-del>删除数据集</button></div>
      </div>
      ${x.phi.length ? `<section class="ds-phi">
        <div><b>这些列像身份信息</b>，处理后才能给 AI 分析。删除的列从数据集里去掉（原文件里的也不再使用）；确认「不是身份信息」的会保留并记录。</div>
        <table class="users"><tbody>${x.phi.map(p => `<tr><td><b>${esc(p.name)}</b><div class="muted small">${esc(p.reason)}</div></td>
          <td><label class="toggle"><input type="radio" name="phi-${esc(p.name)}" value="drop" checked> 删除这一列</label></td>
          <td><label class="toggle"><input type="radio" name="phi-${esc(p.name)}" value="keep"> 不是身份信息，保留</label></td></tr>`).join('')}</tbody></table>
        <div class="row end"><button class="primary" id="dsPhiOk">确认，可以分析</button></div></section>` : ''}
      <section class="rs-card wide">
        <div class="rs-card-head"><h3>变量（${x.columns.length}）</h3><span class="muted small">标签是画图、做表时用的名字</span></div>
        <div class="ds-scroll"><table class="users ds-vars"><thead><tr><th>列名</th><th>标签</th><th>类型</th><th>缺失</th><th>概况</th></tr></thead><tbody>
          ${x.columns.map(c => `<tr${phi.has(c.name) ? ' class="ds-flag"' : ''}><td class="ds-col">${esc(c.name)}</td>
            <td><input class="ds-label" data-col="${esc(c.name)}" value="${esc(x.labels[c.name] ?? c.label ?? '')}" placeholder="${c === x.columns[0] ? '例如：胆红素（mg/dL）' : '添加标签'}"></td>
            <td>${TYPE[c.type]}</td><td>${c.missing ? `${c.missing}（${Math.round(c.missing / Math.max(1, x.rows) * 100)}%）` : '—'}</td>
            <td class="muted small">${esc(summary(c, x.rows))}</td></tr>`).join('')}
        </tbody></table></div>
      </section>
      <section class="rs-card wide">
        <div class="rs-card-head"><h3>预览</h3><span class="muted small">前 ${preview.rows.length} 行</span></div>
        <div class="ds-scroll ds-preview"><table class="chart-grid"><thead><tr>${preview.header.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${preview.rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      </section>`
  }

  async function remove(x: Dataset): Promise<boolean> {
    if (!await askConfirm({ title: '删除数据', message: `删除「${x.name}」？AI 将不能再分析它；已写进文稿的结果不受影响。`, confirm: '删除', danger: true })) return false
    try { await api(`/api/datasets/${x.id}`, { method: 'DELETE' }) } catch (err) { notice((err as Error).message, true); return false }
    picked = picked.filter(p => p.id !== x.id)
    renderPicked()
    return true
  }

  page().addEventListener('click', async e => {
    if (!onPage() || !view) return
    const t = e.target as HTMLElement
    const study = t.closest<HTMLElement>('[data-study]')?.dataset.study
    if (study) { e.stopPropagation(); stopPoll(); view = null; hooks.openStudy(study); return }
    if (t.closest('[data-back]')) { void openList(); return }
    if (view.kind === 'list') {
      if (t.closest('#dsPick')) { page().querySelector<HTMLInputElement>('#dsInput')!.click(); return }
      const x = view.list.find(y => y.id === (t.closest('tr[data-id]') as HTMLElement | null)?.dataset.id)
      if (!x) return
      if (t.closest('[data-del]')) { if (await remove(x)) void openList(); return }
      if (t.closest('[data-open]') || (t.closest('tr.pg-row') && !t.closest('button, a, input'))) void openDetail(x.id)
      return
    }
    const x = view.x
    if (t.closest('#dsExportTable1Docx')) {
      try {
        const token = localStorage.getItem('heurion.token') || ''
        const r = await fetch(`/api/datasets/${x.id}/table1-docx`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!r.ok) throw new Error(`导出失败 (${r.status})`)
        const blob = await r.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${x.name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')}_Table1.docx`
        a.click()
        URL.revokeObjectURL(url)
        notice('已导出医学标准三线表 (.docx)')
      } catch (err) {
        notice((err as Error).message, true)
      }
      return
    }
    if (t.closest('[data-del]')) { if (await remove(x)) void openList(); return }
    if (t.closest('#dsPhiOk')) {
      const drop: string[] = []
      const keep: string[] = []
      for (const p of x.phi) (page().querySelector<HTMLInputElement>(`input[name="phi-${CSS.escape(p.name)}"]:checked`)?.value === 'keep' ? keep : drop).push(p.name)
      const btn = t.closest<HTMLButtonElement>('#dsPhiOk')!
      btn.disabled = true
      btn.textContent = '处理中…'
      try {
        const r = await api<Dataset>(`/api/datasets/${x.id}/phi`, { method: 'POST', body: JSON.stringify({ drop, keep }) })
        notice(r.status === 'ready' ? `已处理${drop.length ? `，删除了 ${drop.length} 列` : ''}，可以分析了` : '还有需要处理的列')
      } catch (err) { notice((err as Error).message, true) }
      void openDetail(x.id)
    }
  })
  page().addEventListener('change', async e => {
    if (!onPage() || !view) return
    const t = e.target as HTMLInputElement
    if (view.kind === 'list') {
      if (t.id === 'dsInput' && t.files?.length) { const files = Array.from(t.files); t.value = ''; void withRefresh(upload(files)) }
      return
    }
    const id = view.x.id
    if (t.id === 'dsStudy') {
      const cur = view.x.study?.id
      try {
        if (cur) await api(`/api/studies/${cur}/items/dataset/${id}`, { method: 'DELETE' })
        if (t.value) await api(`/api/studies/${t.value}/items`, { method: 'POST', body: JSON.stringify({ kind: 'dataset', ref_id: id }) })
        notice(t.value ? '已归入研究' : '已移出研究')
      } catch (err) { notice((err as Error).message, true) }
      void openDetail(id)
      return
    }
    if (t.id === 'dsName') {
      if (!t.value.trim()) return
      try { await api(`/api/datasets/${id}`, { method: 'PATCH', body: JSON.stringify({ name: t.value }) }); document.getElementById('docTitle')!.textContent = t.value.trim() }
      catch (err) { notice((err as Error).message, true) }
      return
    }
    if (t.classList.contains('ds-label')) {
      try { await api(`/api/datasets/${id}`, { method: 'PATCH', body: JSON.stringify({ labels: { [t.dataset.col!]: t.value } }) }) }
      catch (err) { notice((err as Error).message, true) }
    }
  })
  page().addEventListener('dragover', e => { const drop = (e.target as HTMLElement).closest<HTMLElement>('#dsDrop'); if (onPage() && drop) { e.preventDefault(); drop.classList.add('over') } })
  page().addEventListener('dragleave', e => { (e.target as HTMLElement).closest<HTMLElement>('#dsDrop')?.classList.remove('over') })
  page().addEventListener('drop', e => {
    const drop = (e.target as HTMLElement).closest<HTMLElement>('#dsDrop')
    if (!onPage() || !drop) return
    e.preventDefault(); drop.classList.remove('over')
    if (e.dataTransfer?.files.length) void withRefresh(upload(e.dataTransfer.files))
  })

  function close(): void {
    const d = dlg()
    d.hidden = true
    d.innerHTML = ''
  }

  // —— 对话框下方：「引用数据」 ——

  function renderPicked(): void {
    const box = document.getElementById('dsPicked')!
    box.hidden = picked.length === 0
    box.innerHTML = picked.map(x => `<span class="chip" data-id="${x.id}" title="AI 会分析这份数据">${icon('grid', { size: 12 })} ${esc(x.name)}<button class="chip-x" aria-label="移除">✕</button></span>`).join('')
  }

  async function openPicker(anchor: HTMLElement): Promise<void> {
    document.querySelector('.kb-picker')?.remove()
    const all = await api<Dataset[]>('/api/datasets')
    const ready = all.filter(x => x.status === 'ready')
    const menu = document.createElement('div')
    menu.className = 'pop-menu kb-picker'
    menu.innerHTML = (ready.length === 0
      ? `<div class="muted small kb-picker-empty">${all.some(x => x.status === 'review') ? '有数据还没处理身份信息' : '还没有可分析的数据'}</div>`
      : ready.map(x => `<label><input type="checkbox" value="${x.id}" ${picked.some(p => p.id === x.id) ? 'checked' : ''}> ${esc(x.name)} <span class="muted small">${x.rows.toLocaleString()} 行</span></label>`).join(''))
      + '<hr><button data-manage>上传与管理数据…</button>'
    document.body.append(menu)
    menu.style.left = '0px'
    menu.style.top = '0px'
    const r = anchor.getBoundingClientRect()
    const mr = menu.getBoundingClientRect()
    const mw = mr.width || 240
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - mw - 8))}px`
    if (r.top >= window.innerHeight - r.bottom) {
      menu.style.top = 'auto'
      menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`
      menu.style.maxHeight = `${Math.max(120, r.top - 16)}px`
    } else {
      menu.style.bottom = 'auto'
      menu.style.top = `${Math.max(8, r.bottom + 6)}px`
      menu.style.maxHeight = `${Math.max(120, window.innerHeight - r.bottom - 16)}px`
    }
    menu.style.overflowY = 'auto'
    menu.onchange = e => {
      const box = e.target as HTMLInputElement
      const x = ready.find(y => y.id === box.value)!
      picked = box.checked ? [...picked, x] : picked.filter(p => p.id !== x.id)
      renderPicked()
    }
    menu.onclick = e => { if ((e.target as HTMLElement).closest('[data-manage]')) { done(); void openList() } }
    const done = () => { menu.remove(); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', done) }
    const away = (e: MouseEvent) => { if (!menu.contains(e.target as Node) && e.target !== anchor) done() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done() }
    setTimeout(() => { document.addEventListener('mousedown', away); document.addEventListener('keydown', onKey); window.addEventListener('resize', done, { once: true }) })
  }

  // —— 文档里的分析图：代码与数据来源 ——

  const provCache = new Map<string, Promise<any>>()
  const provenance = (assetId: string) => {
    if (!provCache.has(assetId)) provCache.set(assetId, api<any>(`/api/assets/${assetId}/provenance`).catch(() => null))
    return provCache.get(assetId)!
  }

  async function showProvenance(assetId: string): Promise<void> {
    const p = await provenance(assetId)
    if (!p) return
    const d = dlg()
    d.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="分析来源">
      <div class="dialog-head"><h2>分析来源</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <div class="dialog-body">
        <div class="muted small">${new Date(p.at).toLocaleString('zh-CN', { hour12: false })} 由 AI 运行代码生成</div>
        ${p.datasets.length ? `<div><b>数据</b>：${p.datasets.map((s: any) => `《${esc(s.name)}》（${Number(s.rows).toLocaleString()} 行，第 ${s.version} 版）`).join('、')}</div>` : ''}
        ${p.code ? `<div class="row"><b>代码</b>${p.code_path ? `<span class="muted small">${esc(p.code_path)}</span>` : ''}<span class="grow"></span><button class="small-btn" id="provCopy">复制</button></div>
          <pre class="ds-code">${esc(p.code)}</pre>` : '<div class="muted">没有记录代码</div>'}
      </div></div>`
    d.hidden = false
    d.onchange = null
    d.onclick = async e => {
      const t = e.target as HTMLElement
      if (t === d || t.closest('[data-close]')) { close(); return }
      if (t.closest('#provCopy')) { await navigator.clipboard.writeText(p.code); notice('已复制代码') }
    }
  }

  document.getElementById('datasetsBtn')!.onclick = () => void openList()
  document.getElementById('dsPickBtn')!.onclick = e => void openPicker(e.currentTarget as HTMLElement)
  document.getElementById('dsPicked')!.onclick = e => {
    const id = ((e.target as HTMLElement).closest('.chip-x')?.parentElement as HTMLElement | undefined)?.dataset.id
    if (id) { picked = picked.filter(p => p.id !== id); renderPicked() }
  }

  return {
    openList,
    /** 研究页上传数据集（返回上传成功的，含重复的已有数据集） */
    upload,
    /** 打开数据集详情页（变量、身份信息处理、预览） */
    openDetail,
    /** 离开数据集页（别的页面接管中间区域时） */
    leave(): void { stopPoll(); view = null },
    /** 文档里的图是否由分析生成（编辑器给图加「来自分析」标记用）。 */
    hasProvenance: async (assetId: string) => Boolean(await provenance(assetId)),
    showProvenance,
    /** 发送时取走选中的数据集 id（发完清空）。 */
    takePicked(): string[] {
      const ids = picked.map(x => x.id)
      picked = []
      renderPicked()
      return ids
    },
  }
}
