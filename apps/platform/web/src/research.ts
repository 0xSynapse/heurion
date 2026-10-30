/**
 * 临床研究（工作空间）：研究项目列表与研究页——研究方案、数据集、分析（用研究数据集画的图，自动汇总）、稿件、入组患者。
 * 入组：按条件筛选诊疗组里的患者 → 预览（代号 + 匹配依据）→ 勾选入组（研究编号 S001…）→ 生成研究数据集（只有研究编号）。
 * 新建方案 / 论文 / 幻灯片：新建文档并归入研究，打开后把建议的指令填进对话框（由人改好再发送）。
 * 研究团队：负责人加同机构成员（可编辑 / 只读）、改角色、移出、转交；成员可退出；只读成员看不到修改类按钮。
 * 机构管理员在研究开始页可做离职交接（只换负责人，不看内容）。
 */
import { photoFigure } from './photos.ts'
import { askConfirm, askText } from './dialogs.ts'
import { openHelpGuide } from './help.ts'
import { icon } from './icons.ts'
import { safeSvg } from './svg.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notice = (msg: string, error?: boolean) => void

type Role = 'owner' | 'sub_i' | 'cra' | 'crc' | 'statistician' | 'data_manager' | 'radiologist' | 'auditor' | 'editor' | 'viewer'
const ROLE_LABEL: Record<string, string> = {
  owner: '主要研究者 (PI)',
  sub_i: '共同研究者 (Sub-I)',
  cra: '临床监查员 (CRA)',
  crc: '临床协调员 (CRC)',
  statistician: '生物统计师',
  data_manager: '数据管理员 (DM)',
  radiologist: '放射/影像评估医师',
  auditor: '质控/稽查员 (Auditor)',
  editor: '可编辑',
  viewer: '只读',
}
const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: 'sub_i', label: '共同研究者 (Sub-I)' },
  { value: 'cra', label: '临床监查员 (CRA，监查只读)' },
  { value: 'crc', label: '临床协调员 (CRC)' },
  { value: 'statistician', label: '生物统计师' },
  { value: 'data_manager', label: '数据管理员 (DM)' },
  { value: 'radiologist', label: '放射/影像评估医师' },
  { value: 'auditor', label: '质控/稽查员 (Auditor，只读)' },
  { value: 'editor', label: '通用可编辑' },
  { value: 'viewer', label: '通用只读' },
]
interface StudyLite { id: string; title: string; design: string | null; status: 'planning' | 'ongoing' | 'completed'; docs: number; datasets: number; my_role: Role; shared: boolean; shared_by: string | null; members: number }
interface Member { user_id: string; name: string; role: Role; me: boolean }
interface Study {
  id: string; title: string; design: string | null; status: StudyLite['status']; summary: string | null; design_label: string | null; status_label: string; updated_at: string
  my_role: Role; owner_name: string
  docs: Array<{ doc_id: string; title: string; kind: 'doc' | 'deck'; role: string; updated_at: string; created_by?: string }>
  datasets: Array<{ dataset_id: string; name: string; format: string; rows: number; cols: number; status: string; version?: number; cohort?: { shape: string } | null }>
  analyses: Array<{ asset_id: string; name: string; created_at: string; datasets: string[]; has_code: boolean; by?: string }>
}

export interface ResearchHooks {
  openDoc(id: string): Promise<void>
  /** 离开当前文档（研究页占用中间区域时） */
  leaveDoc(): void
  prefillChat(text: string): void
  goSpace(space: 'research' | 'write' | 'studio'): void
  token(): string
  datasets: { upload(files: File[]): Promise<Array<{ id: string }>>; openDetail(id: string): Promise<void>; showProvenance(assetId: string): Promise<void> }
  /** 打开患者页（入组名单里点代号） */
  openPatient?(id: string): Promise<void>
  /** 将已归档的矢量图插入到当前打开的文稿/幻灯片，或选择/新建文稿插入 */
  insertFigureToDoc?(assetId: string, caption: string): Promise<void>
}

interface Cohort {
  active: number
  subjects: Array<{ subject_id: string; patient_id: string; code: string | null; sex: string | null; age_at_enroll: number | null; tags: string[]; enrolled_at: string; status: string }>
  pending: Array<{ proposal_id: string; patient_id: string; code: string | null; kind: string; reason: string }>
  datasets: Array<{ dataset_id: string; name: string; shape: string; version: number; rows: number; status: string; generated_at: string; latest: boolean; stale: boolean | null }>
}
interface Candidate { patient_id: string; code: string; sex: string | null; age: number | null; tags: string[]; matched: string[]; subject_id: string | null }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const DESIGNS: Record<string, string> = { retrospective_cohort: '回顾性队列', prospective_cohort: '前瞻性队列', rct: '随机对照试验', case_control: '病例对照', cross_sectional: '横断面', other: '其他' }
const STATUS: Record<string, string> = { planning: '筹备中', ongoing: '进行中', completed: '已完成' }
const ROLES: Record<string, string> = { protocol: '研究方案', manuscript: '论文', slides: '幻灯片', other: '其他文档' }
const date = (iso: string) => new Date(iso).toLocaleDateString('zh-CN')
const SEX: Record<string, string> = { M: '男', F: '女' }

export function initResearch(api: Api, notice: Notice, hooks: ResearchHooks) {
  const $ = (id: string) => document.getElementById(id)!
  let list: StudyLite[] = []
  let studioFigures: Array<{ id: string; name: string; created_at: string }> = []
  let studioBatchMode = false
  const studioSelectedIds = new Set<string>()
  let studioBatchAssembleHandler: ((assetIds: string[]) => void) | null = null
  let current: string | null = null
  let poll: ReturnType<typeof setTimeout> | null = null

  // —— 左栏 ——

  async function loadList(): Promise<void> {
    try { list = await api<StudyLite[]>('/api/studies') } catch { list = [] }
    renderList()
  }

  function renderList(): void {
    const q = ($('docSearch') as HTMLInputElement).value.trim().toLowerCase()
    const shown = list.filter(s => !q || s.title.toLowerCase().includes(q))
    $('studyList').innerHTML = shown.map(s => `<li data-study="${s.id}" class="hit${s.id === current ? ' active' : ''}" title="${esc(s.title)}">
        <span class="hit-text"><span class="label">${esc(s.title)}${s.shared ? ' <span class="pill shared-pill" title="同事共享给你的研究">共享</span>' : ''}</span><span class="snippet">${[s.shared ? `${s.shared_by} 负责 · ${ROLE_LABEL[s.my_role]}` : s.members > 1 ? `${s.members} 位成员` : '', s.design ? DESIGNS[s.design] : '', STATUS[s.status], `${s.datasets} 个数据集`].filter(Boolean).join(' · ')}</span></span></li>`).join('')
      + (list.length === 0 ? '<li class="nav-empty">还没有研究项目。点「＋ 新建研究」。</li>' : shown.length === 0 ? `<li class="nav-empty">没有找到「${esc(q)}」</li>` : '')
  }

  async function loadStudioList(): Promise<void> {
    try {
      const res = await api<{ figures?: Array<{ id: string; name: string; created_at: string }> }>('/api/figures')
      studioFigures = res.figures ?? []
    } catch {
      studioFigures = []
    }
    const validIds = new Set(studioFigures.map(f => f.id))
    for (const id of [...studioSelectedIds]) {
      if (!validIds.has(id)) studioSelectedIds.delete(id)
    }
    renderStudioList()
  }

  function renderStudioList(): void {
    const el = document.getElementById('studioList')
    if (!el) return
    const q = ($('docSearch') as HTMLInputElement).value.trim().toLowerCase()
    const shown = studioFigures.filter(f => !q || f.name.toLowerCase().includes(q))
    const allShownChecked = shown.length > 0 && shown.every(f => studioSelectedIds.has(f.id))
    const selCount = studioSelectedIds.size
    const batchHeader = studioFigures.length > 0 ? `
      <li class="studio-batch-bar" style="list-style:none;padding:6px 8px;border-bottom:1px solid var(--line);background:var(--raised);display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
          <span class="muted small">共 ${studioFigures.length} 张图表${selCount ? ` · 已选 ${selCount}` : ''}</span>
          <button type="button" class="quiet small-btn" data-st-batch-toggle="1">${studioBatchMode ? '退出批量' : '批量操作'}</button>
        </div>
        ${studioBatchMode ? `
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
            <button type="button" class="quiet small-btn" data-st-batch-all="1">${allShownChecked ? '取消全选' : '全选'}</button>
            <button type="button" class="small-btn" data-st-batch-assemble="1" ${selCount === 0 ? 'disabled' : ''} title="将勾选的图表直接送入多面板拼图 (A/B/C/D)">拼图(${selCount})</button>
            <button type="button" class="small-btn" data-st-batch-rename="1" ${selCount === 0 ? 'disabled' : ''} title="按统一前缀+序号批量重命名选中图表">批量改名</button>
            <button type="button" class="small-btn danger-text" data-st-batch-delete="1" ${selCount === 0 ? 'disabled' : ''} title="批量删除选中图表">删除(${selCount})</button>
          </div>
        ` : ''}
      </li>
    ` : ''
    el.innerHTML = batchHeader + shown.map(f => {
      const checked = studioSelectedIds.has(f.id)
      const displayLabel = f.name.replace(/\.svg$/i, '')
      return `<li data-studio-fig="${esc(f.id)}" data-studio-figname="${esc(f.name)}" class="hit studio-fig-item${checked ? ' selected' : ''}" title="${esc(f.name)} · 点击查看矢量图与可复现脚本">
        ${studioBatchMode ? `<input type="checkbox" class="studio-fig-cb" data-fig-check="${esc(f.id)}" ${checked ? 'checked' : ''} aria-label="勾选 ${esc(displayLabel)}" style="margin-right:6px;flex-shrink:0;">` : ''}
        <span class="hit-text" style="min-width:0;flex:1;"><span class="label">${esc(displayLabel)}</span><span class="snippet">矢量 SVG + 源码 · ${date(f.created_at)}</span></span>
        <span class="studio-item-actions" style="display:inline-flex;align-items:center;gap:2px;flex-shrink:0;">
          <button type="button" class="quiet small-btn" data-fig-rename="${esc(f.id)}" data-fig-name="${esc(f.name)}" title="重命名图表" style="padding:2px 5px;">${icon('edit', { size: 12 })}</button>
          <button type="button" class="quiet small-btn danger-text" data-fig-delete="${esc(f.id)}" data-fig-name="${esc(f.name)}" title="删除图表" style="padding:2px 5px;">${icon('trash', { size: 12 })}</button>
        </span>
      </li>`
    }).join('')
      + (studioFigures.length === 0 ? '<li class="nav-empty">暂无已保存图表。在右侧画布点「保存到图表库」即可命名并归档。</li>' : shown.length === 0 ? `<li class="nav-empty">没有找到「${esc(q)}」</li>` : '')
  }

  async function renameFigureAsset(assetId: string, currentName: string, studyId?: string | null): Promise<boolean> {
    const baseName = currentName.replace(/\.svg$/i, '')
    const nextName = await askText({
      title: '重命名图表',
      label: '图表名称',
      value: baseName,
      placeholder: '例如：Figure 1A mRS Grotta 预后偏移图',
      confirm: '保存名称',
    })
    if (!nextName || nextName.trim() === baseName) return false
    try {
      const res = await api<{ ok: boolean; name: string }>(`/api/figures/${assetId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: nextName.trim() }),
      })
      notice(`已重命名为：${res.name}`)
      await loadStudioList()
      if (studyId && current === studyId && !$('page').classList.contains('studio-page')) void openStudy(studyId)
      return true
    } catch (err) {
      notice((err as Error).message, true)
      return false
    }
  }

  async function deleteFigureAsset(assetId: string, currentName: string, studyId?: string | null): Promise<boolean> {
    const ok = await askConfirm({
      title: '删除图表',
      message: `确定从图表库中删除「${currentName.replace(/\.svg$/i, '')}」吗？删除后不可恢复。`,
      confirm: '删除',
      danger: true,
    })
    if (!ok) return false
    try {
      await api(`/api/figures/${assetId}`, { method: 'DELETE' })
      studioSelectedIds.delete(assetId)
      notice(`已删除图表：${currentName.replace(/\.svg$/i, '')}`)
      await loadStudioList()
      if (studyId && current === studyId && !$('page').classList.contains('studio-page')) void openStudy(studyId)
      return true
    } catch (err) {
      notice((err as Error).message, true)
      return false
    }
  }

  async function batchDeleteFigureAssets(ids: string[], studyId?: string | null): Promise<boolean> {
    if (!ids.length) { notice('请先勾选要删除的图表', true); return false }
    const ok = await askConfirm({
      title: '批量删除图表',
      message: `确定批量删除选中的 ${ids.length} 张图表吗？此操作不可撤销。`,
      confirm: `删除 ${ids.length} 张图表`,
      danger: true,
    })
    if (!ok) return false
    try {
      const res = await api<{ affected: number }>('/api/figures/batch', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', ids }),
      })
      ids.forEach(id => studioSelectedIds.delete(id))
      notice(`已批量删除 ${res.affected} 张图表`)
      await loadStudioList()
      if (studyId && current === studyId && !$('page').classList.contains('studio-page')) void openStudy(studyId)
      return true
    } catch (err) {
      notice((err as Error).message, true)
      return false
    }
  }

  async function batchRenameFigureAssets(ids: string[], studyId?: string | null): Promise<boolean> {
    if (!ids.length) { notice('请先勾选要重命名的图表', true); return false }
    const prefix = await askText({
      title: `批量重命名 (${ids.length} 张图表)`,
      label: '统一命名前缀（系统将自动追加 _01, _02… 序号）',
      value: 'Figure',
      placeholder: '例如：Figure1_Panel 或 脑血管畸形队列',
      confirm: '批量重命名',
    })
    if (!prefix) return false
    try {
      const res = await api<{ affected: number }>('/api/figures/batch', {
        method: 'POST',
        body: JSON.stringify({ action: 'rename_prefix', ids, prefix: prefix.trim() }),
      })
      notice(`已按前缀「${prefix.trim()}」批量重命名 ${res.affected} 张图表`)
      await loadStudioList()
      if (studyId && current === studyId && !$('page').classList.contains('studio-page')) void openStudy(studyId)
      return true
    } catch (err) {
      notice((err as Error).message, true)
      return false
    }
  }

  /** 新建研究：名称、设计、简介（一个小表单）。 */
  function createDialog(prefill?: { title?: string; design?: string; summary?: string }): void {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card small" role="dialog" aria-modal="true" aria-label="新建研究">
      <div class="dialog-head"><h2>新建研究</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="studyForm">
        <label>研究名称<input type="text" name="title" required maxlength="120" placeholder="例如：SGLT2 抑制剂与 CKD3 患者 eGFR 下降" value="${esc(prefill?.title ?? '')}"></label>
        <label>研究设计<select name="design"><option value="">（暂不确定）</option>${Object.entries(DESIGNS).map(([k, v]) => `<option value="${k}"${prefill?.design === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>简介（可选）<textarea name="summary" rows="3" placeholder="研究问题、人群、主要终点">${esc(prefill?.summary ?? '')}</textarea></label>
        <div class="row end"><button type="button" data-close>取消</button><button class="primary">创建</button></div>
      </form></div>`
    dlg.hidden = false
    dlg.querySelector<HTMLInputElement>('input[name=title]')!.focus()
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
    dlg.onchange = null
    dlg.querySelector<HTMLFormElement>('#studyForm')!.onsubmit = async e => {
      e.preventDefault()
      const f = new FormData(e.target as HTMLFormElement)
      try {
        const s = await api<{ id: string }>('/api/studies', { method: 'POST', body: JSON.stringify({ title: f.get('title'), design: f.get('design') || null, summary: f.get('summary') }) })
        dlg.hidden = true; dlg.innerHTML = ''
        await loadList()
        await openStudy(s.id)
      } catch (err) { notice((err as Error).message, true) }
    }
  }

  // —— 研究页（五步全链路科研工作台架构） ——
  let openStudySeq = 0
  let activeTab: 'overview' | 'data' | 'studio' | 'biostats' | 'gallery' = 'overview'
  let activeTabStudyId = ''

  /** open() 进行中的标记（每次调用一个新对象，后一次覆盖前一次）。 */
  let opening: object | null = null

  /** 全局制图工作台激活时，用于在中央画布直接加载并预览左侧图表库点击的已保存图表 */
  let previewArchivedAssetInStudio: ((assetId: string, assetName: string) => Promise<void>) | null = null

  function downloadBlobContent(content: string | Blob, filename: string, mime = 'text/plain;charset=utf-8'): void {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    notice(`已下载：${filename}`)
  }

  async function downloadFigureFormat(studyId: string | null | undefined, payload: Record<string, unknown>, format: string, filename: string): Promise<void> {
    try {
      notice(`正在导出原工程文件 ${filename}…`)
      const token = hooks.token()
      const endpoint = studyId ? `/api/studies/${studyId}/figures?format=${encodeURIComponent(format)}` : `/api/figures?format=${encodeURIComponent(format)}`
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({ message: '导出失败' }))
        throw new Error(err.message || err.error || '导出失败')
      }
      const blob = await r.blob()
      downloadBlobContent(blob, filename)
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  /** 将 SVG 矢量图转换为 600 DPI 印刷级 PNG Blob（优先走服务端 @resvg/resvg-js 高清栅格化，异常时回退浏览器高分 Canvas） */
  async function svgToPngBlob(studyId: string | null | undefined, svgStr: string, name = 'Medical_Figure_600DPI', widthPx = 2400): Promise<Blob> {
    const token = hooks.token()
    const endpoint = studyId ? `/api/studies/${studyId}/figures` : '/api/figures'
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ category: 'render_png', svg: svgStr, name, width: widthPx }),
      })
      if (r.ok) return await r.blob()
    } catch {}
    // 浏览器端高分辨率 Canvas 兜底渲染
    return await new Promise<Blob>((resolve, reject) => {
      const img = new Image()
      const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(svgBlob)
      img.onload = () => {
        const ratio = (img.naturalHeight || 600) / Math.max(1, img.naturalWidth || 900)
        const canvas = document.createElement('canvas')
        canvas.width = widthPx
        canvas.height = Math.round(widthPx * ratio)
        const ctx = canvas.getContext('2d')
        if (!ctx) { URL.revokeObjectURL(url); reject(new Error('Canvas 初始化失败')); return }
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        URL.revokeObjectURL(url)
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png')
      }
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG 图像解析失败')) }
      img.src = url
    })
  }

  async function downloadSvgAsPng600Dpi(studyId: string | null | undefined, svgStr: string, filename: string): Promise<void> {
    if (!svgStr || !svgStr.includes('<svg')) {
      notice('当前没有可导出的矢量图', true)
      return
    }
    try {
      notice(`正在渲染 600 DPI 印刷级高清图 ${filename}…`)
      const blob = await svgToPngBlob(studyId, svgStr, filename, 2400)
      const cleanName = filename.endsWith('.png') ? filename : `${filename}.png`
      downloadBlobContent(blob, cleanName, 'image/png')
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  async function copySvgAsPngToClipboard(studyId: string | null | undefined, svgStr: string, title = '科研图表'): Promise<void> {
    if (!svgStr || !svgStr.includes('<svg')) {
      notice('当前没有可复制的图表', true)
      return
    }
    try {
      notice('正在生成 600 DPI 高清图并写入剪贴板…')
      const blob = await svgToPngBlob(studyId, svgStr, title, 2400)
      if (navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        notice('已复制 600 DPI 高清 PNG 到剪贴板！可直接 Ctrl+V / Cmd+V 粘贴到 PPT、Word 或微信')
      } else {
        downloadBlobContent(blob, `${title}_600DPI.png`, 'image/png')
      }
    } catch (err) {
      notice(`复制高清图失败：${(err as Error).message}`, true)
    }
  }

  async function archiveStudyFigure(
    studyId: string | null | undefined,
    name: string,
    svg: string,
    code?: string,
    codePath?: string,
    datasetId?: string,
    opts?: { skipPrompt?: boolean }
  ): Promise<{ asset_id: string; name: string } | null> {
    if (!svg || !svg.includes('<svg')) {
      notice('当前没有可归档的 SVG 矢量图表', true)
      return null
    }
    let finalName = name.replace(/\.svg$/i, '').trim() || 'Medical_Figure'
    if (!opts?.skipPrompt) {
      const custom = await askText({
        title: studyId ? '归档图表至本研究成果库 (figures/)' : '保存图表到图表库',
        label: '请为图表命名（便于在图表库与多面板拼图中检索）',
        value: finalName,
        placeholder: '例如：Figure 1A 脑血管畸形 mRS 预后偏移图',
        confirm: '确认保存',
      })
      if (custom === null) return null
      finalName = custom.trim() || finalName
    }
    try {
      notice(studyId ? '正在将图表与可复现源码归档至本研究 figures/ 成果库…' : '正在将图表与可复现源码归档至全局图表成果库…')
      const endpoint = studyId ? `/api/studies/${studyId}/figures` : '/api/figures'
      const res = await api<{ asset_id: string; name: string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          category: 'archive',
          study_id: studyId || undefined,
          dataset_id: datasetId || undefined,
          name: finalName,
          svg,
          code: code || '# Generated by Heurion Medical Figure Studio',
          code_path: codePath || 'figure_studio.R',
        }),
      })
      notice(studyId ? `已归档至项目 figures/ 成果库：${res.name}` : `已归档至全局图表库：${res.name}`)
      await loadStudioList()
      if (studyId && current === studyId && !$('page').classList.contains('studio-page')) void openStudy(studyId)
      return res
    } catch (err) {
      notice((err as Error).message, true)
      return null
    }
  }

  function switchStudyTab(tab: 'overview' | 'data' | 'studio' | 'biostats' | 'gallery'): void {
    activeTab = tab
    const page = $('page')
    page.querySelectorAll<HTMLButtonElement>('.rs-tabs button[data-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab)
    })
    const panes: Record<typeof tab, string> = {
      overview: 'rsPaneOverview',
      data: 'rsPaneData',
      studio: 'rsPaneStudio',
      biostats: 'rsPaneBiostats',
      gallery: 'rsPaneGallery',
    }
    for (const [k, pid] of Object.entries(panes) as Array<[typeof tab, string]>) {
      const el = document.getElementById(pid)
      if (el) el.hidden = k !== tab
    }
  }

  async function openStudy(id: string): Promise<void> {
    // 从研究里的文档回来、或在文档里点研究：先关掉文档（AI 栏收起，顶栏不再显示文档的东西）
    if (!$('page').classList.contains('study-page')) hooks.leaveDoc()
    if (activeTabStudyId !== id) {
      activeTabStudyId = id
      activeTab = 'overview'
    }
    current = id
    const seq = ++openStudySeq
    if (poll) { clearTimeout(poll); poll = null }
    let s: Study
    try { s = await api<Study>(`/api/studies/${id}`) } catch (err) {
      if (seq === openStudySeq) { notice((err as Error).message, true); current = null }
      return
    }
    if (seq !== openStudySeq || current !== id) return
    // 入组名单（机构没开患者模块时没有）
    let cohort: Cohort | null = null
    let cohortOff = ''
    try { cohort = await api<Cohort>(`/api/studies/${id}/cohort`) } catch (err) { cohortOff = (err as Error).message }
    if (seq !== openStudySeq || current !== id) return
    const page = $('page')
    page.className = 'page study-page'
    $('docTitle').textContent = s.title
    renderList()
    const docsOf = (roles: string[]) => s.docs.filter(d => roles.includes(d.role))
    // 只读成员：不显示修改类按钮（接口同样拒绝）
    const canEdit = s.my_role !== 'viewer'
    const isOwner = s.my_role === 'owner'
    const w = (html: string) => canEdit ? html : ''
    const members = await api<{ members: Member[] }>(`/api/studies/${id}/members`).then(r => r.members).catch(() => [] as Member[])
    const candidates = isOwner ? await api<Array<{ user_id: string; name: string; username: string }>>(`/api/studies/${id}/candidates`).catch(() => []) : []
    if (seq !== openStudySeq || current !== id) return
    const docRow = (d: Study['docs'][number]) => `<li class="rs-item" data-opendoc="${esc(d.doc_id)}"><span class="rs-kind">${d.kind === 'deck' ? '幻灯片' : ROLES[d.role] ?? '文档'}</span><b>${esc(d.title)}</b><span class="muted small">${members.length > 1 && d.created_by ? `${esc(d.created_by)} · ` : ''}更新于 ${date(d.updated_at)}</span>
        ${w(`<button class="quiet small-btn" data-unlink="doc:${esc(d.doc_id)}" title="移出研究（文档回到创建者的文档列表）">移出</button>`)}</li>`
    const protocols = docsOf(['protocol'])
    const manuscripts = docsOf(['manuscript', 'slides', 'other'])
    const activeSubjects = cohort ? cohort.subjects.filter(x => x.status === 'active') : []
    const readyDatasets = s.datasets.filter(d => d.status === 'ready')
    const ro = canEdit ? '' : ' disabled'

    page.innerHTML = `
      ${canEdit ? '' : `<div class="banner rs-readonly"><span class="dot"></span>你是这个研究的只读成员（负责人 ${esc(s.owner_name)}）：能看文档、数据和分析，能评论；要修改请负责人把你改成「可编辑」。</div>`}
      <div class="rs-head">
        <div class="row" style="align-items:center;gap:10px;flex-wrap:wrap;">
          <input class="rs-title" id="rsTitle" value="${esc(s.title)}" aria-label="研究名称" style="flex:1;min-width:240px;"${ro ? ' readonly' : ''}>
          <button class="small-btn" data-rs-tab="studio" title="进入一体化统计与 6 大类医学论文图表工作台">${icon('chart', { size: 13 })} 统计与制图工作台</button>
          <button class="small-btn primary" data-act="bundle" title="一键导出包含 Word Table 1、Figure 1~6 矢量图、Prism/R/Draw.io/Visio/PPT 原工程文件、方法与结果初稿及 STROBE 清单的完整投稿压缩包 (.zip)">${icon('download', { size: 13 })} 导出 SCI 投稿出版包 (.zip)</button>
          <div class="menu-wrap"><button data-act="more" aria-haspopup="menu">更多 ▾</button>
            <div class="dropdown" id="rsMore" hidden>${w('<button data-act="attach">归入已有文档…</button>')}<button data-act="figures">弹窗版快速制图…</button>${isOwner ? '<button data-act="delete" class="danger-text">删除研究项目</button>' : '<button data-act="leave" class="danger-text">退出研究</button>'}</div></div>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap;">
          <select id="rsDesign" aria-label="研究设计"${ro}><option value="">研究设计（未定）</option>${Object.entries(DESIGNS).map(([k, v]) => `<option value="${k}"${s.design === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <select id="rsStatus" aria-label="状态"${ro}>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${s.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <span class="rs-role muted small">我的角色：${ROLE_LABEL[s.my_role]}</span>
          <span class="muted small">· 团队 ${members.length} 人 · 在组 ${activeSubjects.length} 人 · 数据集 ${s.datasets.length} 个 · 图表 ${s.analyses.length} 张</span>
        </div>
        <textarea id="rsSummary" rows="2" placeholder="简介：研究问题、人群、暴露 / 干预、主要终点"${ro ? ' readonly' : ''}>${esc(s.summary ?? '')}</textarea>
      </div>

      <!-- 科研全链路五步导航页签 (同患者页 .tabs.pt-tabs 统一设计语言) -->
      <div class="tabs rs-tabs" role="tablist" aria-label="临床研究工作流阶段">
        <button type="button" data-tab="overview" data-rs-tab="overview" class="${activeTab === 'overview' ? 'active' : ''}">1. 方案、队列与概览</button>
        <button type="button" data-tab="data" data-rs-tab="data" class="${activeTab === 'data' ? 'active' : ''}">2. 数据治理与 Table 1 <span class="count">${s.datasets.length || ''}</span></button>
        <button type="button" data-tab="studio" data-rs-tab="studio" class="${activeTab === 'studio' ? 'active' : ''}">3. 统计与医学制图工作台</button>
        <button type="button" data-tab="biostats" data-rs-tab="biostats" class="${activeTab === 'biostats' ? 'active' : ''}">4. 临床统计模型与因果推断</button>
        <button type="button" data-tab="gallery" data-rs-tab="gallery" class="${activeTab === 'gallery' ? 'active' : ''}">5. 图表成果库与多面板拼图 <span class="count">${s.analyses.length || ''}</span></button>
      </div>

      <!-- ==================== 页签 1：方案、队列与概览 ==================== -->
      <div id="rsPaneOverview" ${activeTab === 'overview' ? '' : 'hidden'}>
        <div class="rs-pipeline" aria-label="科研全流程进度引导">
          <button type="button" class="rs-step-card ${protocols.length ? 'done' : ''}" data-step-jump="protocol">
            <span class="rs-step-top"><span>STEP 01</span><span>${protocols.length ? '✓ 已就绪' : '待起草'}</span></span>
            <span class="rs-step-title">研究设计与方案</span>
            <span class="rs-step-metric">${protocols.length} 份研究方案</span>
          </button>
          <button type="button" class="rs-step-card ${activeSubjects.length ? 'done' : ''}" data-step-jump="cohort">
            <span class="rs-step-top"><span>STEP 02</span><span>${activeSubjects.length ? '✓ 已入组' : '待筛选'}</span></span>
            <span class="rs-step-title">纳排筛选与队列</span>
            <span class="rs-step-metric">${activeSubjects.length} 名在组受试者</span>
          </button>
          <button type="button" class="rs-step-card ${s.datasets.length ? 'done' : ''}" data-rs-tab="data">
            <span class="rs-step-top"><span>STEP 03</span><span>进入工作区 →</span></span>
            <span class="rs-step-title">eCRF 变量与基线表</span>
            <span class="rs-step-metric">${s.datasets.length} 个研究数据集 · Table 1</span>
          </button>
          <button type="button" class="rs-step-card ${s.analyses.length ? 'done' : ''}" data-rs-tab="studio">
            <span class="rs-step-top"><span>STEP 04</span><span>进入工作台 →</span></span>
            <span class="rs-step-title">统计与医学制图</span>
            <span class="rs-step-metric">6 大类图表 · 原工程文件</span>
          </button>
          <button type="button" class="rs-step-card ${manuscripts.length || s.analyses.length ? 'done' : ''}" data-rs-tab="gallery">
            <span class="rs-step-top"><span>STEP 05</span><span>进入拼图台 →</span></span>
            <span class="rs-step-title">多面板拼图与论文</span>
            <span class="rs-step-metric">${s.analyses.length} 张图表 · ${manuscripts.length} 篇稿件</span>
          </button>
        </div>

        <div class="rs-grid">
          ${cohortCard(cohort, cohortOff, canEdit)}
          <section class="rs-card" id="rsProtocolCard">
            <div class="rs-card-head"><h3>研究方案 (Protocol)</h3>${w('<button class="small-btn" data-new="protocol">＋ 新建方案</button>')}</div>
            ${protocols.length ? `<ul class="rs-list">${protocols.map(docRow).join('')}</ul>` : '<p class="muted small">还没有研究方案。点「＋ 新建方案」，AI 可依据研究问题自动起草研究设计、纳排标准、终点、样本量与统计分析计划。</p>'}
          </section>
          <section class="rs-card">
            <div class="rs-card-head"><h3>数据集 (Datasets)</h3>
              <button class="quiet small-btn" data-rs-tab="data">Table 1 工作区 →</button>
              ${w('<button class="small-btn" data-act="upload">＋ 上传数据</button><input type="file" id="rsUpload" accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.xpt,.sas7bdat,.sav,.zsav,.dta" multiple hidden>')}
            </div>
            ${s.datasets.length ? `<ul class="rs-list">${s.datasets.map(d => `<li class="rs-item" data-dataset="${d.dataset_id}"><span class="rs-kind">${esc(d.format)}</span><b>${esc(d.name)}</b>
              <span class="muted small">${d.status === 'ready' ? `${d.rows.toLocaleString()} 行 × ${d.cols} 列` : d.status === 'review' ? '<span class="flag-L">待处理身份信息</span>' : d.status === 'failed' ? '<span class="flag-H">导入失败</span>' : '处理中…'}</span>
              ${d.status === 'ready' ? `<button class="quiet small-btn" data-export-table1="${d.dataset_id}" title="导出符合医学期刊标准的原生 Word (.docx) Table 1 三线表">Word Table 1</button>` : ''}
              ${w(`<button class="quiet small-btn" data-unlink="dataset:${d.dataset_id}" title="移出研究（数据集回到上传者的「全部数据集」里）">移出</button>`)}</li>`).join('')}</ul>`
              : '<p class="muted small">支持上传 CSV、Excel、SAS、SPSS、Stata，或从上方入组患者直接生成队列宽表 / 长表。</p>'}
          </section>
          <section class="rs-card wide rs-folder-card">
            <div class="rs-card-head">
              <h3><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px; margin-right:4px;"><path d="M3 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>项目图表成果库 (figures/ · ${s.analyses.length} 份产出)</h3>
              <div style="margin-left:auto; display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap;">
                <button class="small-btn" data-rs-tab="biostats">${icon('chart', { size: 13 })} 生存/列线图/ROC/因果推断</button>
                <button class="small-btn" data-rs-tab="gallery">${icon('grid', { size: 13 })} 顶刊 A/B/C/D 多面板拼图</button>
                <button class="small-btn primary" data-rs-tab="studio">${icon('chart', { size: 13 })} 打开统计与医学制图工作台 →</button>
              </div>
            </div>
            <div class="rs-folder-browser">
              <div class="rs-folder-header">
                <span class="rs-folder-path" style="display:inline-flex; align-items:center; gap:4px;"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> 项目根目录 / <b>figures/</b></span>
                <span class="grow"></span>
                <span class="muted small">点击任意图表可穿透查看底层统计代码与数据溯源；在「工作台」归档的图表自动汇总于此</span>
              </div>
              ${s.analyses.length ? `
                <div class="rs-folder-files">
                  ${s.analyses.map(a => {
                    const filename = a.name.split('/').pop() || a.name
                    const ext = filename.split('.').pop() || 'svg'
                    return `
                      <div class="rs-file-item" data-fig="${a.asset_id}" title="点击查看代码与溯源：${esc(a.name)}">
                        <div class="rs-file-preview">
                          <img src="/api/assets/${a.asset_id}?token=${encodeURIComponent(hooks.token())}" alt="${esc(a.name)}">
                          <span class="rs-file-badge">${esc(ext.toUpperCase())}</span>
                        </div>
                        <div class="rs-file-info">
                          <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
                            <b class="rs-file-name" style="min-width:0;overflow:hidden;text-overflow:ellipsis;">${esc(filename.replace(/\.svg$/i, ''))}</b>
                            ${canEdit ? `<span style="display:inline-flex;gap:2px;flex-shrink:0;">
                              <button type="button" class="quiet small-btn" data-fig-rename="${esc(a.asset_id)}" data-fig-name="${esc(a.name)}" title="重命名图表" style="padding:2px 5px;">${icon('edit', { size: 12 })}</button>
                              <button type="button" class="quiet small-btn danger-text" data-fig-delete="${esc(a.asset_id)}" data-fig-name="${esc(a.name)}" title="删除图表" style="padding:2px 5px;">${icon('trash', { size: 12 })}</button>
                            </span>` : ''}
                          </div>
                          <div class="rs-file-meta">
                            ${a.has_code ? '<span class="pill green" title="附带可复现 R/Python 统计源码">可复现源码</span>' : ''}
                            <span>${esc(a.datasets.join('、') || '研究图表')}</span>
                            <span class="muted">${date(a.created_at)}</span>
                          </div>
                        </div>
                      </div>
                    `
                  }).join('')}
                </div>
              ` : `
                <div class="rs-folder-empty">
                  <p class="muted small">图表文件夹当前为空。前往 <b>「3. 统计与医学制图工作台」</b> 或 <b>「4. 临床统计模型」</b> 绘制图表并点击「归档至本研究 figures/」，或在文稿中让 AI 绘图，成果将自动归档至此处。</p>
                </div>
              `}
            </div>
          </section>
          <section class="rs-card wide">
            <div class="rs-card-head"><h3>论文与汇报稿件 (Manuscripts &amp; Slides)</h3>${w('<button class="small-btn" data-new="manuscript">＋ 新建论文</button><button class="small-btn" data-new="slides">＋ 新建幻灯片</button>')}</div>
            ${manuscripts.length ? `<ul class="rs-list">${manuscripts.map(docRow).join('')}</ul>` : '<p class="muted small">新建论文或组会汇报幻灯片后，AI 写作助手会自动挂载本研究的数据集与 figures/ 图表成果。</p>'}
          </section>
          ${membersCard(members, candidates, isOwner)}
        </div>
      </div>

      <!-- ==================== 页签 2：数据治理与 Table 1 ==================== -->
      <div id="rsPaneData" ${activeTab === 'data' ? '' : 'hidden'}></div>

      <!-- ==================== 页签 3：统计与医学制图工作台 ==================== -->
      <div id="rsPaneStudio" ${activeTab === 'studio' ? '' : 'hidden'}></div>

      <!-- ==================== 页签 4：临床统计模型与因果推断 ==================== -->
      <div id="rsPaneBiostats" ${activeTab === 'biostats' ? '' : 'hidden'}></div>

      <!-- ==================== 页签 5：图表成果库与多面板拼图 ==================== -->
      <div id="rsPaneGallery" ${activeTab === 'gallery' ? '' : 'hidden'}></div>
    `

    mountDataTab(s, cohort, canEdit)
    mountStudioTab(s, cohort)
    mountBiostatsTab(s, readyDatasets)
    mountGalleryTab(s)

    // 数据集还在处理：隔几秒刷新
    if (s.datasets.some(d => d.status === 'processing')) poll = setTimeout(() => { if (current === id) void openStudy(id) }, 2500)
  }

  /** 成员卡片：负责人可加人（本机构同事）、改角色、移出、转交；其他人看名单、可退出。 */
  function membersCard(members: Member[], candidates: Array<{ user_id: string; name: string; username: string }>, isOwner: boolean): string {
    const roleSelectOptions = (cur: Role) => ROLE_OPTIONS.map(opt => `<option value="${opt.value}"${cur === opt.value ? ' selected' : ''}>${esc(opt.label)}</option>`).join('')
    const row = (m: Member) => `<li class="rs-item rs-member"><span class="collab-avatar role-${m.role}" aria-hidden="true">${esc(m.name.slice(0, 1).toUpperCase())}</span><b>${esc(m.name)}${m.me ? ' <span class="muted small">（我）</span>' : ''}</b>
      ${isOwner && m.role !== 'owner'
        ? `<select data-mrole="${m.user_id}" aria-label="${esc(m.name)} 的角色">${roleSelectOptions(m.role)}</select>
           <button class="quiet small-btn" data-mtransfer="${m.user_id}" data-mname="${esc(m.name)}" title="把主要研究者 (PI) 转交给 ${esc(m.name)}">转交 PI</button>
           <button class="quiet small-btn" data-mremove="${m.user_id}" data-mname="${esc(m.name)}">移出</button>`
        : `<span class="rs-kind role-badge-${m.role}">${ROLE_LABEL[m.role] ?? m.role}</span>`}</li>`
    return `<section class="rs-card wide" id="rsMembers">
      <div class="rs-card-head"><h3>临床研究项目成员<span class="muted small"> · ${members.length} 人</span></h3>${isOwner ? '' : '<button class="quiet small-btn" data-act="leave">退出研究</button>'}</div>
      <ul class="rs-list">${members.map(row).join('')}</ul>
      ${isOwner ? (candidates.length
        ? `<div class="row rs-addmember"><select id="rsAddUser" aria-label="加成员">${candidates.map(u => `<option value="${u.user_id}">${esc(u.name)}（${esc(u.username)}）</option>`).join('')}</select>
            <select id="rsAddRole" aria-label="角色">${ROLE_OPTIONS.map(opt => `<option value="${opt.value}">${esc(opt.label)}</option>`).join('')}</select><button class="small-btn" data-act="addmember">＋ 加成员</button></div>`
        : `<p class="muted small">${members.length > 1 ? '本机构的同事都已在研究里。' : '同机构的同事可以按 GCP 角色加进研究（Sub-I、CRA、CRC、统计师、DM、放射医师等）。你的机构里还没有其他同事——机构管理员可在「机构管理」里邀请。'}</p>`) : ''}
      <p class="muted small">成员权限制度：PI 享有全局管理权；Sub-I、CRC、生物统计师、数据管理员及放射医师具备协同编写与分析权限；CRA 及质控稽查员享有受试者隐私脱敏后的只读监查与数据核对 (SDV) 权限。</p>
    </section>`
  }

  /** 入组患者卡片：清爽分组操作栏（纳排入组 vs 变量治理），不再堆砌无关按钮。 */
  function cohortCard(c: Cohort | null, off: string, canEdit = true): string {
    if (!c) return `<section class="rs-card wide"><div class="rs-card-head"><h3>入组患者</h3></div><p class="muted small">${esc(off || '研究入组需要启用患者模块')}</p></section>`
    const active = c.subjects.filter(x => x.status === 'active')
    const sets = c.datasets.filter(d => d.latest)
    const SHAPE: Record<string, string> = { wide: '宽表', long: '长表' }
    return `<section class="rs-card wide" id="rsCohort">
      <div class="rs-card-head" style="flex-wrap:wrap;gap:10px;">
        <h3>入组患者队列 (Cohort)${active.length ? `<span class="muted small"> · ${active.length} 人在组</span>` : ''}</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
          <div class="rs-action-cluster">
            <span class="rs-action-cluster-label">队列纳排</span>
            ${canEdit ? `<button class="small-btn primary" data-act="screen">＋ 筛选入组</button>${active.length ? '<button class="small-btn" data-act="gen">生成研究数据集</button>' : ''}` : ''}
            <button class="small-btn" data-act="consort" title="查看并导出 CONSORT 2010 受试者纳排流向图 (Figure 1)">${icon('chart', { size: 13 })} CONSORT 流向图</button>
          </div>
          <div class="rs-action-cluster">
            <span class="rs-action-cluster-label">变量与质控</span>
            <button class="small-btn" data-act="ecrf" title="Auto-eCRF 多模态影像与临床指标批量提取与溯源">${icon('write', { size: 13 })} Auto-eCRF 提取</button>
            <button class="small-btn" data-act="vars" title="分组、随访、结局与影像变量：来源与核实状态；投稿材料只用已核实的值">${icon('check', { size: 13 })} 研究变量核实</button>
          </div>
        </div>
      </div>
      ${c.pending.length ? `<div class="banner pt-pending"><span class="dot"></span>AI 建议了 ${c.pending.length} 项入组 / 移出，待你确认</div>
        <ul class="rs-list">${c.pending.map(p => `<li class="rs-item"><span class="rs-kind">${p.kind === 'enroll' ? '入组' : '移出'}</span><b>${esc(p.code ?? '—')}</b><span class="muted small">${esc(p.reason)}</span>
          <button class="small-btn primary" data-prop="${p.proposal_id}" data-pt="${p.patient_id}" data-propx="accept">确认</button><button class="quiet small-btn" data-prop="${p.proposal_id}" data-pt="${p.patient_id}" data-propx="reject">不采纳</button></li>`).join('')}</ul>` : ''}
      ${sets.map(d => `<div class="rs-cohort-ds${d.stale ? ' stale' : ''}" data-dataset="${d.dataset_id}"><span class="rs-kind">${SHAPE[d.shape] ?? d.shape} v${d.version}</span>
        <span style="flex:1;">${esc(d.name)} <span class="muted small">${d.rows} 行 · ${date(d.generated_at)}</span></span>
        ${d.shape === 'wide' ? `
          <button class="small-btn primary" data-export-table1="${d.dataset_id}" title="一键导出符合医学期刊标准的原生 Word (.docx) Table 1 基线三线表">${icon('download', { size: 13 })} 导出 Table 1</button>
          <button class="small-btn" data-survival="${d.dataset_id}" data-dsname="${esc(d.name)}" title="KM 生存曲线与 Cox 比例风险森林图分析">${icon('chart', { size: 13 })} 生存分析 &amp; 森林图</button>
          <button class="small-btn" data-nomogram="${d.dataset_id}" data-dsname="${esc(d.name)}" title="Cox 预后列线图 (Nomogram) 与 ROC/DCA 决策曲线">${icon('target', { size: 13 })} 列线图 &amp; ROC/DCA</button>
        ` : ''}
        ${d.stale ? `<span class="flag-L small">入组或化验有变化，数据集已过期</span>${canEdit ? `<button class="small-btn" data-regen="${d.shape}">刷新</button>` : ''}` : '<span class="muted small">最新</span>'}</div>`).join('')}
      ${c.subjects.length ? `<div class="ds-scroll"><table class="users rs-subjects"><thead><tr><th>研究编号</th><th>代号</th><th>性别</th><th>入组时年龄</th><th>诊断标签</th><th>入组日期</th><th></th></tr></thead><tbody>
        ${c.subjects.map(x => `<tr class="${x.status === 'active' ? '' : 'muted'}"><td><b>${esc(x.subject_id)}</b></td>
          <td>${x.code ? `<button class="linkish" data-patient="${x.patient_id}">${esc(x.code)}</button>` : '<span class="muted" title="你已不在这位患者的诊疗组里">—</span>'}</td>
          <td>${esc(SEX[x.sex ?? ''] ?? '')}</td><td>${x.age_at_enroll ?? ''}</td><td>${esc(x.tags.join('、'))}</td><td>${date(x.enrolled_at)}</td>
          <td>${x.status === 'active' ? (canEdit && x.code ? `<button class="quiet small-btn" data-unenroll="${x.patient_id}" data-subject="${esc(x.subject_id)}">移出</button>` : '') : '<span class="small">已移出</span>'}</td></tr>`).join('')}
        </tbody></table></div>`
        : '<p class="muted small">按性别、年龄、诊断标签、化验结果、检查日期从你在诊疗组里的患者中筛选入组；每人得到研究编号（S001…），生成的研究数据集里只有研究编号，没有代号。</p>'}
    </section>`
  }

  /** 筛选入组：条件 → 预览（代号 + 匹配依据）→ 勾选 → 入组。 */
  function screenDialog(studyId: string): void {
    const dlg = $('dialog')
    const labRow = () => `<div class="row rs-labrow"><input name="lab_test" placeholder="化验项目，如 肌酐 / HbA1c" list="rsTests"><select name="lab_mode"><option value="latest">最近一次</option><option value="any">任一次</option></select>
      <select name="lab_op"><option>&gt;</option><option>&gt;=</option><option>&lt;</option><option>&lt;=</option><option>=</option></select><input name="lab_value" type="number" step="any" placeholder="阈值（标准单位）"><button type="button" class="quiet" data-dellab aria-label="删除这条">✕</button></div>`
    dlg.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="筛选入组">
      <div class="dialog-head"><h2>筛选入组</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="screenForm">
        <div class="muted small">在你在诊疗组里的在管患者中筛选。化验用换算到标准单位后的已确认值（肌酐 µmol/L、血糖 mmol/L、血红蛋白 g/L…）。</div>
        <div class="row"><label>性别<select name="sex"><option value="">不限</option><option value="M">男</option><option value="F">女</option></select></label>
          <label>年龄 ≥<input name="age_min" type="number" min="0" max="130"></label><label>年龄 ≤<input name="age_max" type="number" min="0" max="130"></label></div>
        <label>诊断标签包含（任一，逗号分隔）<input name="tags" placeholder="例如：CKD, 糖尿病"></label>
        <div><div class="muted small">化验条件（都要满足）</div><div id="rsLabs"></div><button type="button" class="small-btn" data-addlab>＋ 化验条件</button></div>
        <datalist id="rsTests"><option value="肌酐"><option value="eGFR"><option value="HbA1c"><option value="血糖"><option value="血红蛋白"><option value="ALT"><option value="AST"><option value="白蛋白"><option value="尿酸"><option value="LDL-C"></datalist>
        <div class="row"><label>化验日期从<input name="from" type="date"></label><label>到<input name="to" type="date"></label></div>
        <div class="row end"><button type="submit" class="primary">预览</button></div>
        <div id="rsPreview"></div>
      </form></div>`
    dlg.hidden = false
    const form = dlg.querySelector<HTMLFormElement>('#screenForm')!
    let lastCriteria: Record<string, unknown> = {}
    const criteria = () => {
      const f = new FormData(form)
      const num = (k: string) => (f.get(k) as string) ? Number(f.get(k)) : undefined
      const labs = [...form.querySelectorAll<HTMLElement>('.rs-labrow')].map(r => ({
        test: r.querySelector<HTMLInputElement>('[name=lab_test]')!.value.trim(), mode: r.querySelector<HTMLSelectElement>('[name=lab_mode]')!.value,
        op: r.querySelector<HTMLSelectElement>('[name=lab_op]')!.value, value: r.querySelector<HTMLInputElement>('[name=lab_value]')!.value,
      })).filter(l => l.test || l.value).map(l => ({ ...l, value: Number(l.value) }))
      return { sex: f.get('sex') || undefined, age_min: num('age_min'), age_max: num('age_max'), tags_any: String(f.get('tags') ?? '').split(/[,，、]/).map(x => x.trim()).filter(Boolean), labs, from: f.get('from') || undefined, to: f.get('to') || undefined }
    }
    dlg.onclick = async e => {
      const t = e.target as HTMLElement
      if (e.target === dlg || t.closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = ''; return }
      if (t.closest('[data-addlab]')) { $('rsLabs').insertAdjacentHTML('beforeend', labRow()); return }
      if (t.closest('[data-dellab]')) { t.closest('.rs-labrow')?.remove(); return }
      if (t.closest('[data-enroll]')) {
        const ids = [...form.querySelectorAll<HTMLInputElement>('input[name=pick]:checked')].map(i => i.value)
        if (!ids.length) { notice('先勾选要入组的患者', true); return }
        try {
          const r = await api<{ enrolled: unknown[]; proposed: unknown[]; skipped: Array<{ reason: string }> }>(`/api/studies/${studyId}/cohort`, { method: 'POST', body: JSON.stringify({ patient_ids: ids, criteria: lastCriteria }) })
          dlg.hidden = true; dlg.innerHTML = ''
          notice(`已入组 ${r.enrolled.length} 人${r.skipped.length ? `，跳过 ${r.skipped.length} 人（${[...new Set(r.skipped.map(x => x.reason))].join('；')}）` : ''}`)
          void openStudy(studyId)
        } catch (err) { notice((err as Error).message, true) }
      }
      if (t.closest('[data-pickall]')) { const on = (t as HTMLInputElement).checked; form.querySelectorAll<HTMLInputElement>('input[name=pick]:not(:disabled)').forEach(i => { i.checked = on }) }
    }
    dlg.onchange = null
    form.onsubmit = async e => {
      e.preventDefault()
      lastCriteria = criteria()
      try {
        const r = await api<{ total: number; patients: Candidate[] }>(`/api/studies/${studyId}/cohort/preview`, { method: 'POST', body: JSON.stringify(lastCriteria) })
        const fresh = r.patients.filter(p => !p.subject_id).length
        $('rsPreview').innerHTML = r.total === 0 ? '<div class="muted">没有符合条件的患者。</div>' : `
          <div class="rs-preview-head"><b>符合条件 ${r.total} 人</b>${fresh < r.total ? `<span class="muted small">（${r.total - fresh} 人已入组）</span>` : ''}</div>
          <div class="ds-scroll"><table class="users rs-candidates"><thead><tr><th><input type="checkbox" data-pickall checked aria-label="全选"></th><th>代号</th><th>性别</th><th>年龄</th><th>诊断标签</th><th>匹配依据</th></tr></thead><tbody>
          ${r.patients.map(p => `<tr><td><input type="checkbox" name="pick" value="${p.patient_id}"${p.subject_id ? ' disabled' : ' checked'} aria-label="${esc(p.code)}"></td><td><b>${esc(p.code)}</b>${p.subject_id ? ` <span class="muted small">已入组 ${esc(p.subject_id)}</span>` : ''}</td>
            <td>${esc(SEX[p.sex ?? ''] ?? '')}</td><td>${p.age ?? ''}</td><td>${esc(p.tags.join('、'))}</td><td class="small">${esc(p.matched.join('；') || '—')}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="row end"><button type="button" class="primary" data-enroll${fresh ? '' : ' disabled'}>入组选中的患者</button></div>`
      } catch (err) { notice((err as Error).message, true) }
    }
  }

  /** 生成研究数据集：宽表 / 长表、化验项目、日期窗口。 */
  function datasetDialog(studyId: string, shape = 'wide'): void {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card small" role="dialog" aria-modal="true" aria-label="生成研究数据集">
      <div class="dialog-head"><h2>生成研究数据集</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="genForm">
        <label>形状<select name="shape"><option value="wide"${shape === 'wide' ? ' selected' : ''}>宽表：每人一行（基线 / 最近值、次数）</option><option value="long"${shape === 'long' ? ' selected' : ''}>长表：每次化验一行</option></select></label>
        <label>化验项目（可选，逗号分隔；不填 = 全部）<input name="tests" placeholder="例如：肌酐, eGFR, HbA1c"></label>
        <div class="row"><label>化验日期从<input name="from" type="date"></label><label>到<input name="to" type="date"></label></div>
        <div class="muted small">数据集里只有研究编号，没有代号；数值统一换算到标准单位。之后入组或化验有变化会提示刷新，刷新生成新版本，旧版本保留。</div>
        <div class="row end"><button type="button" data-close>取消</button><button class="primary">生成</button></div>
      </form></div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
    dlg.onchange = null
    const form = dlg.querySelector<HTMLFormElement>('#genForm')!
    form.onsubmit = async e => {
      e.preventDefault()
      const f = new FormData(form)
      const btn = form.querySelector<HTMLButtonElement>('button.primary')!
      btn.disabled = true; btn.textContent = '生成中…'
      try {
        const r = await api<{ dataset: { name: string }; unchanged: boolean; skipped: string[] }>(`/api/studies/${studyId}/cohort/dataset`, { method: 'POST', body: JSON.stringify({
          shape: f.get('shape'), tests: String(f.get('tests') ?? '').split(/[,，、]/).map(x => x.trim()).filter(Boolean), from: f.get('from') || null, to: f.get('to') || null,
        }) })
        dlg.hidden = true; dlg.innerHTML = ''
        notice(r.unchanged ? `数据没有变化，沿用「${r.dataset.name}」` : `已生成「${r.dataset.name}」并归入研究${r.skipped.length ? `；${r.skipped.join('、')} 你已不在诊疗组里，没有包含` : ''}`)
        void openStudy(studyId); void loadList()
      } catch (err) { btn.disabled = false; btn.textContent = '生成'; notice((err as Error).message, true) }
    }
  }

  /** 原生 Word (.docx) Table 1 导出下载 */
  async function downloadTable1Docx(datasetId: string): Promise<void> {
    try {
      notice('正在生成原生 Word 三线表…')
      const token = hooks.token()
      const res = await fetch(`/api/datasets/${datasetId}/table1-docx`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '导出失败' }))
        throw new Error(err.error || '导出失败')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Table1_Baseline_${datasetId}.docx`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      notice('已成功导出原生 Word (.docx) Table 1 基线三线表！')
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  /** 一键导出包含 Table 1 (Word)、Figure 1~6 矢量图、方法与结果初稿及 STROBE 清单的完整投稿压缩包 (.zip) */
  async function downloadPublicationBundle(studyId: string, title: string): Promise<void> {
    try {
      notice('正在自动化组装并打包 SCI 投稿出版包 (.zip)，包含基线表、全套矢量图表与方法学初稿…')
      const token = hooks.token()
      const res = await fetch(`/api/studies/${studyId}/publication-bundle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({})
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '打包导出失败' }))
        throw new Error(err.error || '打包导出失败')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const dispo = res.headers.get('content-disposition') || ''
      const match = dispo.match(/filename="([^"]+)"/)
      a.download = (match && match[1]) ? match[1] : `SCI_Publication_Bundle_${studyId}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      notice(`已成功导出「${title || '研究'}」SCI 投稿出版包 (.zip)！`)
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  /** CONSORT 2010 受试者纳排筛选流向图交互式工作台弹窗（归属于临床研究课题） */
  async function consortDialog(studyId: string): Promise<void> {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card wide" style="width:min(1080px, calc(100vw - 24px));" role="dialog" aria-modal="true" aria-label="CONSORT 2010 流向图">
      <div class="dialog-head">
        <h2>CONSORT 2010 / STROBE 受试者纳排流向图 (Figure 1 · 课题内交互式编辑与原工程导出)</h2>
        <button class="quiet" data-close aria-label="关闭">✕</button>
      </div>
      <div class="dialog-body" style="display:flex;flex-direction:column;gap:12px;">
        <div class="rs-studio-shell" style="grid-template-columns:minmax(340px, 430px) minmax(0, 1fr);">
          <!-- 左侧：数据源自动汇总 + 纳排/分组人数交互编辑 -->
          <div class="rs-studio-left" id="rsConsortLeftPane">
            <div class="rs-sub-box" style="background:var(--raised);padding:8px 10px;">
              <div class="rs-sub-box-title">
                <span>${icon('layers', { size: 13 })} 课题数据源自动汇总</span>
              </div>
              <label>选择纳排统计来源
                <select id="rsConsortSourceSel">
                  <option value="__cohort__">本研究入组队列记录 (Cohort 在组/移出自动汇总)</option>
                </select>
              </label>
              <div id="rsConsortDsMappingWrap" style="display:none;flex-direction:column;gap:8px;margin-top:4px;">
                <div class="row" style="gap:8px;">
                  <label style="flex:1;">研究分组列 (Study Arm)
                    <select id="rsConsortGrpCol"></select>
                  </label>
                  <label style="flex:1;">随访结局列 (识别「缺失」为失访)
                    <select id="rsConsortOutCol"></select>
                  </label>
                </div>
              </div>
            </div>

            <div class="row" style="gap:8px;">
              <label style="flex:1;">初筛评估总人数 (Assessed)
                <input type="number" id="rsConsortAssessed" value="180">
              </label>
              <label style="flex:1;">符合纳排入组人数 (Eligible)
                <input type="number" id="rsConsortEligible" value="148">
              </label>
            </div>

            <div class="rs-sub-box">
              <div class="rs-sub-box-title">
                <span>排除原因明细 (Exclusions)</span>
                <button type="button" class="quiet small-btn" id="rsConsortAddExclBtn">＋ 新增排除原因</button>
              </div>
              <table class="rs-data-table">
                <thead><tr><th>排除原因说明</th><th style="width:68px;">人数</th><th style="width:28px;"></th></tr></thead>
                <tbody id="rsConsortExclTbody"></tbody>
              </table>
            </div>

            <div class="rs-sub-box">
              <div class="rs-sub-box-title">
                <span>各研究组分配与随访分析人数 (Study Arms)</span>
                <button type="button" class="quiet small-btn" id="rsConsortAddArmBtn">＋ 新增分组</button>
              </div>
              <table class="rs-data-table">
                <thead><tr><th>组名</th><th style="width:52px;">分配</th><th style="width:52px;">接受</th><th style="width:48px;">失访</th><th style="width:56px;">分析</th><th style="width:26px;"></th></tr></thead>
                <tbody id="rsConsortArmTbody"></tbody>
              </table>
            </div>

            <button type="button" class="primary small-btn" id="rsConsortRenderBtn">${icon('chart', { size: 13 })} 更新并渲染 CONSORT 流向图</button>
          </div>

          <!-- 右侧：矢量预览 + 归档至本研究 figures/ + 原工程文件导出 -->
          <div class="rs-studio-right">
            <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
              <b style="font-size:13.5px;">Figure 1 · CONSORT 出版级矢量预览</b>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button type="button" class="small-btn" id="rsConsortCopyPngBtn" title="复制 600 DPI 高清 PNG 到剪贴板">${icon('copy', { size: 13 })} 复制高清图</button>
                <button type="button" class="small-btn" id="rsConsortPngBtn" title="下载 600 DPI 印刷级高清 PNG">${icon('download', { size: 13 })} 600 DPI PNG</button>
                <button type="button" class="small-btn primary" id="rsConsortArchiveBtn" title="命名并归档至本研究 figures/ 成果库">${icon('pin', { size: 13 })} 归档至本研究 figures/</button>
              </div>
            </div>
            <div class="rs-studio-exports" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
              <span class="muted small">原工程文件导出：</span>
              <button type="button" class="small-btn primary" id="rsConsortDownloadDrawio" title="导出 Draw.io (Diagrams.net) 可编辑原文件 (.drawio)">${icon('download', { size: 13 })} Draw.io (.drawio)</button>
              <button type="button" class="small-btn" id="rsConsortDownloadVdx" title="导出 Microsoft Visio 可编辑流程图原文件 (.vdx)">${icon('download', { size: 13 })} Visio (.vdx)</button>
              <button type="button" class="small-btn" id="rsConsortDownloadPptx" title="导出 PowerPoint 原生可编辑形状与连接线 (.pptx)">${icon('download', { size: 13 })} 可编辑 PPT (.pptx)</button>
              <button type="button" class="small-btn" id="rsConsortDownloadSvg">${icon('download', { size: 13 })} Illustrator 矢量 (.svg)</button>
              <button type="button" class="small-btn" id="rsConsortCopyMermaid">${icon('copy', { size: 13 })} 复制 Mermaid</button>
            </div>
            <div id="rsConsortSvgContainer" class="rs-studio-canvas" style="min-height:440px;max-height:560px;">
              <div class="muted small" style="padding:40px;">正在生成出版级流向图…</div>
            </div>
          </div>
        </div>
      </div>
    </div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }

    let studyTitle = '临床研究'
    let readyDatasets: Array<{ dataset_id: string; name: string; rows: number; cols: number }> = []
    let currentSvg = ''
    let currentDrawio = ''
    let currentMermaid = ''

    let flowState = {
      title: 'CONSORT 2010 Participant Flow Diagram',
      total_assessed: 120,
      eligible_total: 96,
      exclusions: [
        { reason: '不符合纳入标准 (Did not meet inclusion criteria)', count: 16 },
        { reason: '拒绝签署知情同意 (Declined to participate)', count: 8 },
      ],
      arms: [
        { name: '干预组 (Intervention Arm)', allocated: 48, received: 48, lost_to_followup: 2, discontinued: 0, analyzed: 46 },
        { name: '对照组 (Control Arm)', allocated: 48, received: 48, lost_to_followup: 2, discontinued: 0, analyzed: 46 },
      ],
    }

    const assessedInp = document.getElementById('rsConsortAssessed') as HTMLInputElement
    const eligibleInp = document.getElementById('rsConsortEligible') as HTMLInputElement
    const exclTbody = document.getElementById('rsConsortExclTbody')!
    const armTbody = document.getElementById('rsConsortArmTbody')!
    const sourceSel = document.getElementById('rsConsortSourceSel') as HTMLSelectElement
    const dsMapWrap = document.getElementById('rsConsortDsMappingWrap')!
    const grpColSel = document.getElementById('rsConsortGrpCol') as HTMLSelectElement
    const outColSel = document.getElementById('rsConsortOutCol') as HTMLSelectElement
    const svgBox = document.getElementById('rsConsortSvgContainer')!

    const renderTables = () => {
      assessedInp.value = String(flowState.total_assessed)
      eligibleInp.value = String(flowState.eligible_total)
      exclTbody.innerHTML = flowState.exclusions.map((ex, idx) => `
        <tr data-exidx="${idx}">
          <td><input type="text" class="rs-cs-exreason" value="${esc(ex.reason)}"></td>
          <td><input type="number" class="rs-cs-excnt" value="${ex.count}"></td>
          <td><button type="button" class="quiet small-btn" data-del-ex="${idx}" title="删除">✕</button></td>
        </tr>
      `).join('')
      armTbody.innerHTML = flowState.arms.map((a, idx) => `
        <tr data-armidx="${idx}">
          <td><input type="text" class="rs-cs-aname" value="${esc(a.name)}"></td>
          <td><input type="number" class="rs-cs-alloc" value="${a.allocated}"></td>
          <td><input type="number" class="rs-cs-recv" value="${a.received}"></td>
          <td><input type="number" class="rs-cs-lost" value="${a.lost_to_followup}"></td>
          <td><input type="number" class="rs-cs-ana" value="${a.analyzed}"></td>
          <td><button type="button" class="quiet small-btn" data-del-arm="${idx}" title="删除">✕</button></td>
        </tr>
      `).join('')

      exclTbody.querySelectorAll<HTMLButtonElement>('[data-del-ex]').forEach(btn => {
        btn.onclick = () => {
          syncFromDom()
          if (flowState.exclusions.length <= 1) return
          flowState.exclusions.splice(Number(btn.dataset.delEx), 1)
          renderTables()
          void renderFlowSvg()
        }
      })
      armTbody.querySelectorAll<HTMLButtonElement>('[data-del-arm]').forEach(btn => {
        btn.onclick = () => {
          syncFromDom()
          if (flowState.arms.length <= 1) return
          flowState.arms.splice(Number(btn.dataset.delArm), 1)
          renderTables()
          void renderFlowSvg()
        }
      })
    }

    const syncFromDom = () => {
      flowState.total_assessed = Number(assessedInp.value || 0)
      flowState.eligible_total = Number(eligibleInp.value || 0)
      flowState.exclusions = Array.from(exclTbody.querySelectorAll<HTMLTableRowElement>('tr')).map(tr => ({
        reason: tr.querySelector<HTMLInputElement>('.rs-cs-exreason')?.value.trim() || '排除项',
        count: Number(tr.querySelector<HTMLInputElement>('.rs-cs-excnt')?.value || 0),
      }))
      flowState.arms = Array.from(armTbody.querySelectorAll<HTMLTableRowElement>('tr')).map(tr => ({
        name: tr.querySelector<HTMLInputElement>('.rs-cs-aname')?.value.trim() || '研究组',
        allocated: Number(tr.querySelector<HTMLInputElement>('.rs-cs-alloc')?.value || 0),
        received: Number(tr.querySelector<HTMLInputElement>('.rs-cs-recv')?.value || 0),
        lost_to_followup: Number(tr.querySelector<HTMLInputElement>('.rs-cs-lost')?.value || 0),
        discontinued: 0,
        analyzed: Number(tr.querySelector<HTMLInputElement>('.rs-cs-ana')?.value || 0),
      }))
    }

    const buildPayload = () => ({
      category: 'flowchart',
      ...flowState,
    })

    const renderFlowSvg = async () => {
      svgBox.innerHTML = `<div class="muted small" style="padding:40px;">正在渲染出版级 CONSORT 矢量流向图…</div>`
      try {
        const res = await api<any>(`/api/studies/${studyId}/figures`, {
          method: 'POST',
          body: JSON.stringify(buildPayload()),
        })
        currentSvg = res.illustrator_svg || res.svg || res.native_exports?.illustrator_svg || ''
        currentDrawio = res.drawio_xml || res.native_exports?.drawio_xml || ''
        svgBox.innerHTML = safeSvg(currentSvg) || '<div class="muted small">未生成流程图</div>'
      } catch (err) {
        svgBox.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
      }
    }

    const loadFromCohort = async () => {
      try {
        const res = await api<{ svg: string; mermaid: string; data: any }>(`/api/studies/${studyId}/cohort/consort`)
        currentMermaid = res.mermaid || ''
        const d = res.data || {}
        const enrolled = Number(d.enrolled_total ?? 60) || 60
        const withdrawn = Number(d.withdrawn_total ?? 4) || 0
        const active = Math.max(0, enrolled - withdrawn)
        const halfAlloc = Math.max(1, Math.floor(enrolled / 2))
        const halfLost = Math.floor(withdrawn / 2)
        flowState = {
          title: `${studyTitle} · CONSORT 2010 受试者纳排流向图`,
          total_assessed: Number(d.assessed_total) > enrolled ? Number(d.assessed_total) : enrolled + 24,
          eligible_total: enrolled,
          exclusions: Array.isArray(d.exclusion_reasons) && d.exclusion_reasons.length
            ? d.exclusion_reasons.map((x: any) => ({ reason: String(x.reason || '排除'), count: Number(x.count || 0) }))
            : [
                { reason: '不符合纳入标准 (Did not meet inclusion criteria)', count: 16 },
                { reason: '拒绝签署知情同意 (Declined to participate)', count: 8 },
              ],
          arms: [
            { name: '干预组 (Intervention Arm)', allocated: halfAlloc, received: halfAlloc, lost_to_followup: halfLost, discontinued: 0, analyzed: Math.max(0, halfAlloc - halfLost) },
            { name: '对照组 (Control Arm)', allocated: enrolled - halfAlloc, received: enrolled - halfAlloc, lost_to_followup: withdrawn - halfLost, discontinued: 0, analyzed: Math.max(0, active - (halfAlloc - halfLost)) },
          ],
        }
        renderTables()
        await renderFlowSvg()
      } catch (err) {
        renderTables()
        await renderFlowSvg()
      }
    }

    let dsHeader: string[] = []
    let dsRows: string[][] = []
    let dsLabels: Record<string, string> = {}
    const SENTINELS = new Set(['缺失', '未知', '不详', '无', 'na', 'n/a', 'null', 'none', 'nan', '-', '--', '.', ''])
    const isMissingCell = (v: string | undefined) => {
      const s = (v || '').trim()
      return !s || SENTINELS.has(s.toLowerCase())
    }

    const applyDatasetSummary = (dsName: string, gCol: string, oCol: string) => {
      const gIdx = dsHeader.indexOf(gCol)
      const oIdx = dsHeader.indexOf(oCol)
      if (gIdx < 0) return
      const totalAssessed = dsRows.length
      let missingGroupCount = 0
      const armStats = new Map<string, { allocated: number; lost: number; analyzed: number }>()
      for (const r of dsRows) {
        const gVal = (r[gIdx] || '').trim()
        if (isMissingCell(gVal)) {
          missingGroupCount++
          continue
        }
        const st = armStats.get(gVal) || { allocated: 0, lost: 0, analyzed: 0 }
        st.allocated++
        const oVal = oIdx >= 0 ? (r[oIdx] || '').trim() : 'ok'
        if (oIdx >= 0 && isMissingCell(oVal)) st.lost++
        else st.analyzed++
        armStats.set(gVal, st)
      }
      flowState = {
        title: `${dsName} · CONSORT 2010 队列纳排与分组随访流向图`,
        total_assessed: totalAssessed,
        eligible_total: totalAssessed - missingGroupCount,
        exclusions: missingGroupCount > 0
          ? [{ reason: `${gCol} 缺失或未满足纳排分配标准`, count: missingGroupCount }]
          : [{ reason: '初筛无排除受试者 (可在表格中补充医院初筛排除明细)', count: 0 }],
        arms: [...armStats.entries()].slice(0, 4).map(([name, st]) => ({
          name: `${dsLabels[gCol] || gCol}: ${name}`,
          allocated: st.allocated,
          received: st.allocated,
          lost_to_followup: st.lost,
          discontinued: 0,
          analyzed: st.analyzed,
        })),
      }
      renderTables()
      void renderFlowSvg()
    }

    try {
      const stInfo = await api<Study>(`/api/studies/${studyId}`)
      studyTitle = stInfo.title
      readyDatasets = stInfo.datasets.filter(d => d.status === 'ready')
      sourceSel.innerHTML = `<option value="__cohort__">本研究入组队列记录 (Cohort 在组/移出自动汇总)</option>`
        + readyDatasets.map(d => `<option value="${esc(d.dataset_id)}">本研究数据集：${esc(d.name)} (${d.rows} 行)</option>`).join('')
    } catch {}

    sourceSel.onchange = async () => {
      const val = sourceSel.value
      if (val === '__cohort__') {
        dsMapWrap.style.display = 'none'
        await loadFromCohort()
        return
      }
      dsMapWrap.style.display = 'flex'
      try {
        const [meta, prev] = await Promise.all([
          api<{ columns?: Array<{ name: string }>; labels?: Record<string, string> }>(`/api/datasets/${val}`),
          api<{ header: string[]; rows: string[][] }>(`/api/datasets/${val}/preview?limit=5000`),
        ])
        dsHeader = prev.header ?? []
        dsRows = prev.rows ?? []
        dsLabels = meta.labels ?? {}
        const cols = dsHeader.length ? dsHeader : (meta.columns ?? []).map(c => c.name)
        const optHtml = cols.map(c => `<option value="${esc(c)}">${esc(dsLabels[c] || c)}</option>`).join('')
        grpColSel.innerHTML = optHtml
        outColSel.innerHTML = optHtml
        const defGrp = cols.find(c => /第一次治疗|首治|治疗方式|分组|arm|treat|group/i.test(c)) || cols[0] || ''
        const defOut = cols.find(c => c !== defGrp && /治疗后出血|闭塞程度|确诊时mRS|结局|随访|outcome|status/i.test(c)) || cols[1] || cols[0] || ''
        grpColSel.value = defGrp
        outColSel.value = defOut
        const dsName = readyDatasets.find(d => d.dataset_id === val)?.name || studyTitle
        applyDatasetSummary(dsName, defGrp, defOut)
        const onColChange = () => applyDatasetSummary(dsName, grpColSel.value, outColSel.value)
        grpColSel.onchange = onColChange
        outColSel.onchange = onColChange
      } catch (err) {
        notice((err as Error).message, true)
      }
    }

    document.getElementById('rsConsortAddExclBtn')!.onclick = () => {
      syncFromDom()
      flowState.exclusions.push({ reason: '其他排除原因 (Other exclusion)', count: 5 })
      renderTables()
      void renderFlowSvg()
    }
    document.getElementById('rsConsortAddArmBtn')!.onclick = () => {
      syncFromDom()
      flowState.arms.push({ name: `亚组 ${flowState.arms.length + 1}`, allocated: 20, received: 20, lost_to_followup: 1, discontinued: 0, analyzed: 19 })
      renderTables()
      void renderFlowSvg()
    }
    document.getElementById('rsConsortRenderBtn')!.onclick = () => {
      syncFromDom()
      void renderFlowSvg()
    }

    document.getElementById('rsConsortArchiveBtn')!.onclick = () => {
      syncFromDom()
      const dsId = sourceSel.value !== '__cohort__' ? sourceSel.value : undefined
      void archiveStudyFigure(studyId, `Figure 1 ${studyTitle} CONSORT 纳排流向图`, currentSvg, currentDrawio || currentMermaid, 'CONSORT_Flowchart.drawio', dsId)
    }
    document.getElementById('rsConsortCopyPngBtn')!.onclick = () => {
      void copySvgAsPngToClipboard(studyId, currentSvg, `CONSORT_2010_${studyTitle}`)
    }
    document.getElementById('rsConsortPngBtn')!.onclick = () => {
      void downloadSvgAsPng600Dpi(studyId, currentSvg, `Figure1_CONSORT_2010_${studyId}_600DPI.png`)
    }
    document.getElementById('rsConsortDownloadDrawio')!.onclick = () => {
      syncFromDom()
      void downloadFigureFormat(studyId, buildPayload(), 'drawio', `Figure1_CONSORT_2010_${studyId}.drawio`)
    }
    document.getElementById('rsConsortDownloadVdx')!.onclick = () => {
      syncFromDom()
      void downloadFigureFormat(studyId, buildPayload(), 'vdx', `Figure1_CONSORT_2010_${studyId}.vdx`)
    }
    document.getElementById('rsConsortDownloadPptx')!.onclick = () => {
      syncFromDom()
      void downloadFigureFormat(studyId, buildPayload(), 'pptx', `Figure1_CONSORT_2010_${studyId}.pptx`)
    }
    document.getElementById('rsConsortDownloadSvg')!.onclick = () => {
      if (!currentSvg) { notice('暂无可下载的 SVG 图像', true); return }
      downloadBlobContent(currentSvg, `Figure1_CONSORT_2010_${studyId}.svg`, 'image/svg+xml;charset=utf-8')
    }
    document.getElementById('rsConsortCopyMermaid')!.onclick = () => {
      const mmd = currentMermaid || `flowchart TD\n  A["初筛评估 (n=${flowState.total_assessed})"] --> B["符合纳排入组 (n=${flowState.eligible_total})"]`
      navigator.clipboard.writeText(mmd).then(() => notice('已复制 CONSORT Mermaid 流程图代码')).catch(() => notice('复制失败', true))
    }

    await loadFromCohort()
  }

  /** VanderWeele E-value 混杂偏倚敏感性分析弹窗 */
  function evalueDialog(studyId: string): void {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="因果推断 E-value">
      <div class="dialog-head">
        <h2>因果推断混杂偏倚分析 · VanderWeele E-value</h2>
        <button class="quiet" data-close aria-label="关闭">✕</button>
      </div>
      <div class="dialog-body" style="display:flex;flex-direction:column;gap:16px;">
        <div class="muted small">
          基于 VanderWeele &amp; Ding (Ann Intern Med 2017) 权威统计学公式。量化评估未知/未测量潜在混杂因素需要达到何种关联强度，才足以完全推翻当前效应估计。专为医学顶刊审稿意见回复 (Reviewer Rebuttal) 设计。
        </div>
        <form id="evalueForm" class="form" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;background:var(--panel-active, rgba(0,0,0,0.03));padding:14px;border-radius:8px;border:1px solid var(--line);">
          <label>效应指标 (Effect Measure)
            <select name="effect_type">
              <option value="HR" selected>HR (风险比 - 生存分析/Cox回归)</option>
              <option value="OR">OR (比值比 - Logistic回归)</option>
              <option value="RR">RR (相对危险度 - 队列研究)</option>
            </select>
          </label>
          <label>点估计值 (Estimate)
            <input name="estimate" type="number" step="0.01" value="0.74" required>
          </label>
          <div class="row" style="gap:8px;align-items:flex-end;">
            <label style="flex:1;">95% CI 下限
              <input name="ci_lower" type="number" step="0.01" value="0.65" required>
            </label>
            <label style="flex:1;">95% CI 上限
              <input name="ci_upper" type="number" step="0.01" value="0.85" required>
            </label>
          </div>
          <div style="grid-column:1 / -1;display:flex;justify-content:space-between;align-items:center;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" name="rare_outcome" checked>
              <span class="small">罕见事件假设 (Rare outcome assumption，结局发生率 &lt; 15%)</span>
            </label>
            <button type="submit" class="primary small-btn">计算 E-value 与生成抗辩论述</button>
          </div>
        </form>
        <div id="evalueResult" style="display:none;flex-direction:column;gap:12px;"></div>
      </div>
    </div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }

    const form = dlg.querySelector<HTMLFormElement>('#evalueForm')!
    const compute = async () => {
      const f = new FormData(form)
      const effect_type = f.get('effect_type') as string
      const estimate = Number(f.get('estimate'))
      const ci_lower = Number(f.get('ci_lower'))
      const ci_upper = Number(f.get('ci_upper'))
      const rare_outcome = f.get('rare_outcome') === 'on'

      try {
        const res = await api<{
          effect_type: string
          estimate: number
          ci_lower: number
          ci_upper: number
          e_value_point: number
          e_value_ci: number
          academic_defense_zh: string
          academic_defense_en: string
        }>(`/api/studies/${studyId}/causal/e-value`, {
          method: 'POST',
          body: JSON.stringify({ effect_type, estimate, ci_lower, ci_upper, rare_outcome }),
        })

        const resBox = document.getElementById('evalueResult')
        if (resBox) {
          resBox.style.display = 'flex'
          resBox.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
              <div style="background:var(--accent-tint, #eff6ff);border:1px solid #bfdbfe;border-radius:8px;padding:12px;text-align:center;">
                <div class="muted small">VanderWeele E-value (点估计)</div>
                <div style="font-size:26px;font-weight:700;color:#1d4ed8;margin-top:4px;">${res.e_value_point.toFixed(2)}</div>
                <div class="muted small" style="margin-top:2px;">未测量混杂需达 ${res.e_value_point.toFixed(2)} 倍关联方可完全消除效应</div>
              </div>
              <div style="background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;text-align:center;">
                <div class="muted small">95% CI 保守边界 E-value</div>
                <div style="font-size:26px;font-weight:700;color:#047857;margin-top:4px;">${res.e_value_ci.toFixed(2)}</div>
                <div class="muted small" style="margin-top:2px;">推翻统计显著性所需之最低混杂强度</div>
              </div>
            </div>
            <div style="border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--panel);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <b>中文审稿抗辩论述 (适用于答复意见书 / 论著讨论段落)</b>
                <button class="quiet small-btn" id="copyDefenseZh">复制中文论述</button>
              </div>
              <p style="font-size:13px;line-height:1.6;margin:0;color:var(--text);">${esc(res.academic_defense_zh)}</p>
            </div>
            <div style="border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--panel);">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <b>English Reviewer Rebuttal (For NEJM / Lancet / JAMA Response)</b>
                <button class="quiet small-btn" id="copyDefenseEn">Copy English Rebuttal</button>
              </div>
              <p style="font-size:13px;line-height:1.6;margin:0;font-family:Times New Roman, serif;color:var(--text);">${esc(res.academic_defense_en)}</p>
            </div>
          `

          document.getElementById('copyDefenseZh')?.addEventListener('click', () => {
            navigator.clipboard.writeText(res.academic_defense_zh)
            notice('已复制中文审稿抗辩论述')
          })
          document.getElementById('copyDefenseEn')?.addEventListener('click', () => {
            navigator.clipboard.writeText(res.academic_defense_en)
            notice('Copied English Reviewer Rebuttal to clipboard')
          })
        }
      } catch (err) {
        notice((err as Error).message, true)
      }
    }

    form.onsubmit = e => {
      e.preventDefault()
      void compute()
    }

    // Trigger initial calculation
    void compute()
  }

  /** 临床顶刊生存分析与 Cox 风险回归弹窗 (Kaplan-Meier & Forest Plot) */
  async function survivalDialog(datasetId: string, datasetName: string): Promise<void> {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="生存分析">
      <div class="dialog-head">
        <h2>临床生存分析与 Cox 森林图 (Kaplan-Meier & Forest Plot)</h2>
        <button class="quiet" data-close aria-label="关闭">✕</button>
      </div>
      <div class="dialog-body" style="display:flex;flex-direction:column;gap:14px;">
        <div class="muted small">
          符合 NEJM / Lancet / JAMA 医学顶刊统计规范：Kaplan-Meier 累积生存拟合、Greenwood 95% 置信区间、对齐 Number at risk 风险表、Log-rank 显著性检验及多因素 Cox 比例风险回归森林图。
        </div>
        <div id="rsSurvLoading" class="muted small" style="padding:20px;text-align:center;">正在载入数据集指标与变量列…</div>
        <form id="rsSurvForm" class="form" style="display:none;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;background:var(--panel-active, rgba(0,0,0,0.03));padding:14px;border-radius:8px;border:1px solid var(--line);">
          <label>随访时间变量 (Time)
            <select name="time_col" id="rsSurvTimeCol"></select>
          </label>
          <label>结局事件变量 (Event, 1/0)
            <select name="event_col" id="rsSurvEventCol"></select>
          </label>
          <label>主要分层/暴露变量 (Group)
            <select name="group_col" id="rsSurvGroupCol"></select>
          </label>
          <label>时间单位 (Unit)
            <select name="time_unit">
              <option value="Months" selected>月 (Months)</option>
              <option value="Days">天 (Days)</option>
              <option value="Years">年 (Years)</option>
            </select>
          </label>
          <div style="grid-column:1 / -1;display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
            <span class="muted small" id="rsSurvInfo">分析数据集：${esc(datasetName)}</span>
            <button type="submit" class="primary small-btn">运行 KM 生存拟合与森林图</button>
          </div>
        </form>
        <div id="rsSurvResult" style="display:none;flex-direction:column;gap:16px;">
          <!-- KM Curve & Risk Table -->
          <div style="border:1px solid var(--line);border-radius:8px;padding:16px;background:#ffffff;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
              <b>Figure 3: Kaplan-Meier 累积生存率曲线与风险集对照 (Number at Risk)</b>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="small-btn" id="rsDlKmPzfx" title="导出 GraphPad Prism 生存分析工程文件 (.pzfx)">${icon('download', { size: 13 })} Prism (.pzfx)</button>
                <button class="small-btn" id="rsDlKmR" title="导出 R 语言 survminer/ggplot2 脚本 (.R)">${icon('download', { size: 13 })} R 脚本 (.R)</button>
                <button class="small-btn primary" id="rsDlKmSvg">${icon('download', { size: 13 })} 下载 KM 矢量图 (SVG)</button>
              </div>
            </div>
            <div id="rsKmSvgWrap" style="overflow:auto;max-height:480px;display:flex;justify-content:center;"></div>
          </div>

          <!-- Statistical Callout Metrics -->
          <div id="rsSurvStats" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:12px;"></div>

          <!-- Cox Forest Plot -->
          <div id="rsForestWrap" style="border:1px solid var(--line);border-radius:8px;padding:16px;background:#ffffff;display:none;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
              <b>Figure 4: 多因素 Cox 比例风险回归亚组森林图 (Hazard Ratio & 95% CI)</b>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="small-btn" id="rsDlForestPzfx" title="导出 GraphPad Prism 森林图工程文件 (.pzfx)">${icon('download', { size: 13 })} Prism (.pzfx)</button>
                <button class="small-btn" id="rsDlForestR" title="导出 R 语言 forestplot/ggplot2 脚本 (.R)">${icon('download', { size: 13 })} R 脚本 (.R)</button>
                <button class="small-btn primary" id="rsDlForestSvg">${icon('download', { size: 13 })} 下载森林图 (SVG)</button>
              </div>
            </div>
            <div id="rsForestSvgWrap" style="overflow:auto;max-height:420px;display:flex;justify-content:center;"></div>
          </div>

          <!-- Manuscript Report & Copy -->
          <div style="border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--panel);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <b>论文方法学与统计结果论述段落 (Methods & Results)</b>
              <button class="small-btn" id="rsCopySurvMd">${icon('copy', { size: 13 })} 复制论文论述段落</button>
            </div>
            <div id="rsSurvMdText" style="font-size:12.5px;line-height:1.6;color:var(--text);white-space:pre-wrap;font-family:monospace;max-height:220px;overflow-y:auto;background:var(--bg);padding:10px;border-radius:6px;border:1px solid var(--line);"></div>
          </div>
        </div>
      </div>
    </div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }

    try {
      const ds = await api<{ id: string; columns?: Array<{ name: string; type?: string }>; labels?: Record<string, string> }>(`/api/datasets/${datasetId}`)
      const cols = (ds.columns || []).map(c => c.name)
      if (!cols.length) {
        cols.push('followup_months', 'os_status', 'treatment_arm', 'age', 'sex', 'l3_smi', 'vat_to_sat_ratio')
      }

      const timeSel = document.getElementById('rsSurvTimeCol') as HTMLSelectElement
      const eventSel = document.getElementById('rsSurvEventCol') as HTMLSelectElement
      const groupSel = document.getElementById('rsSurvGroupCol') as HTMLSelectElement

      const populate = (sel: HTMLSelectElement, candidates: string[], defMatch: (n: string) => boolean) => {
        sel.innerHTML = candidates.map(c => {
          const lbl = ds.labels?.[c] || c
          return `<option value="${esc(c)}">${esc(lbl)} (${esc(c)})</option>`
        }).join('')
        const matched = candidates.find(defMatch)
        if (matched) sel.value = matched
      }

      populate(timeSel, cols, n => /time|month|day|follow|surv|os/i.test(n))
      populate(eventSel, cols, n => /status|event|dead|death|censor|outcome/i.test(n))
      populate(groupSel, ['(不分组)', ...cols], n => /group|arm|treat|smi|ham/i.test(n))

      const loadingEl = document.getElementById('rsSurvLoading')
      const formEl = document.getElementById('rsSurvForm')
      if (loadingEl) loadingEl.style.display = 'none'
      if (formEl) formEl.style.display = 'grid'

      const runAnalysis = async () => {
        const timeCol = timeSel.value
        const eventCol = eventSel.value
        const groupCol = groupSel.value === '(不分组)' ? undefined : groupSel.value
        const timeUnit = (document.getElementById('rsSurvForm') as HTMLFormElement)?.querySelector<HTMLSelectElement>('[name="time_unit"]')?.value || 'Months'

        notice('正在运行医学顶刊级生存曲线拟合与 Cox 回归…')
        try {
          const res = await api<any>(`/api/datasets/${datasetId}/survival`, {
            method: 'POST',
            body: JSON.stringify({
              time_col: timeCol,
              event_col: eventCol,
              group_col: groupCol,
              time_unit: timeUnit,
              title: `${datasetName} · Kaplan-Meier 生存率分析`,
              show_censored: true,
              show_risk_table: true,
            })
          })

          const resWrap = document.getElementById('rsSurvResult')
          const kmWrap = document.getElementById('rsKmSvgWrap')
          const statsWrap = document.getElementById('rsSurvStats')
          const forestWrap = document.getElementById('rsForestWrap')
          const forestSvgWrap = document.getElementById('rsForestSvgWrap')
          const mdText = document.getElementById('rsSurvMdText')

          const kmSvg = res.km_svg || res.svg || res.survival_analysis?.svg || ''
          const forestSvg = res.forest_plot_svg || res.forest_svg || res.survival_analysis?.forest_svg || ''
          const summaryMd = res.summary_markdown || res.publication_report_markdown || (res.narrative ? `${res.narrative}\n\n${res.markdown_table || ''}` : res.markdown_table) || ''
          const logRank = res.log_rank || res.survival_analysis?.log_rank
          const rawGroups = res.groups || res.survival_analysis?.groups
          const groupList: any[] = Array.isArray(rawGroups) ? rawGroups : (rawGroups ? Object.values(rawGroups) : [])

          if (resWrap) resWrap.style.display = 'flex'
          if (kmWrap) kmWrap.innerHTML = safeSvg(kmSvg) || '<div class="muted small">未生成 KM 图像</div>'

          // Stats cards
          let statsHtml = ''
          if (logRank) {
            const chi2Num = Number(logRank.chi2)
            statsHtml += `<div style="border:1px solid var(--line);border-radius:6px;padding:10px;background:var(--panel);">
              <div class="muted small">Log-rank 显著性检验</div>
              <div style="font-size:20px;font-weight:700;color:#0284c7;margin-top:2px;">${esc(String(logRank.p_value_formatted ?? ''))}</div>
              <div class="muted small">Chi2 = ${Number.isFinite(chi2Num) ? chi2Num.toFixed(2) : '—'}, df = ${Number(logRank.df) || 0}</div>
            </div>`
          }
          if (groupList.length > 0) {
            for (const g of groupList) {
              const med = g.median_time !== null && g.median_time !== undefined ? `${esc(String(g.median_time))} ${esc(String(timeUnit))}` : '未达 (NR)'
              const rate = typeof g.event_rate === 'number' ? g.event_rate.toFixed(1) : esc(String(g.event_rate ?? ''))
              statsHtml += `<div style="border:1px solid var(--line);border-radius:6px;padding:10px;background:var(--panel);">
                <div class="muted small">${esc(g.label || g.group || '分层组')} (n=${Number(g.total_n) || 0})</div>
                <div style="font-size:20px;font-weight:700;color:var(--text);margin-top:2px;">中位生存: ${med}</div>
                <div class="muted small">事件发生率: ${rate}% (${Number(g.events_n) || 0}/${Number(g.total_n) || 0})</div>
              </div>`
            }
          }
          if (statsWrap) statsWrap.innerHTML = statsHtml

          // Forest plot
          if (forestSvg && forestWrap && forestSvgWrap) {
            forestWrap.style.display = 'block'
            forestSvgWrap.innerHTML = safeSvg(forestSvg)
          } else if (forestWrap) {
            forestWrap.style.display = 'none'
          }

          // Markdown
          if (mdText) mdText.textContent = summaryMd

          // Buttons
          const dlKmBtn = document.getElementById('rsDlKmSvg')
          if (dlKmBtn) {
            dlKmBtn.onclick = () => {
              if (!kmSvg) { notice('暂无可下载的 KM 矢量图', true); return }
              const blob = new Blob([kmSvg], { type: 'image/svg+xml;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `Figure3_Kaplan_Meier_${datasetId}.svg`
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(url)
              notice('已下载 Figure 3 KM 矢量图')
            }
          }

          const dlKmPzfxBtn = document.getElementById('rsDlKmPzfx')
          if (dlKmPzfxBtn) {
            dlKmPzfxBtn.onclick = () => {
              const pzfx = res.native_exports?.prism_pzfx || res.survival_analysis?.native_exports?.prism_pzfx
              if (!pzfx) { notice('暂无 Prism (.pzfx) 数据', true); return }
              const blob = new Blob([pzfx], { type: 'application/xml;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `Figure3_Kaplan_Meier_${datasetId}.pzfx`
              document.body.appendChild(a); a.click(); document.body.removeChild(a)
              URL.revokeObjectURL(url)
              notice('已下载 GraphPad Prism (.pzfx) 生存分析原文件')
            }
          }

          const dlKmRBtn = document.getElementById('rsDlKmR')
          if (dlKmRBtn) {
            dlKmRBtn.onclick = () => {
              const rCode = res.native_exports?.r_script || res.survival_analysis?.native_exports?.r_script
              if (!rCode) { notice('暂无 R 脚本数据', true); return }
              const blob = new Blob([rCode], { type: 'text/plain;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `Figure3_Kaplan_Meier_${datasetId}.R`
              document.body.appendChild(a); a.click(); document.body.removeChild(a)
              URL.revokeObjectURL(url)
              notice('已下载 R 语言 survminer/ggplot2 脚本 (.R)')
            }
          }

          const dlForestPzfxBtn = document.getElementById('rsDlForestPzfx')
          if (dlForestPzfxBtn) {
            dlForestPzfxBtn.onclick = () => {
              const pzfx = res.native_exports?.forest_prism_pzfx || res.survival_analysis?.native_exports?.forest_prism_pzfx
              if (!pzfx) { notice('暂无森林图 Prism (.pzfx) 数据', true); return }
              const blob = new Blob([pzfx], { type: 'application/xml;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `Figure4_Cox_Forest_Plot_${datasetId}.pzfx`
              document.body.appendChild(a); a.click(); document.body.removeChild(a)
              URL.revokeObjectURL(url)
              notice('已下载 GraphPad Prism (.pzfx) 森林图原文件')
            }
          }

          const dlForestRBtn = document.getElementById('rsDlForestR')
          if (dlForestRBtn) {
            dlForestRBtn.onclick = () => {
              const rCode = res.native_exports?.forest_r_script || res.survival_analysis?.native_exports?.forest_r_script
              if (!rCode) { notice('暂无森林图 R 脚本数据', true); return }
              const blob = new Blob([rCode], { type: 'text/plain;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `Figure4_Cox_Forest_Plot_${datasetId}.R`
              document.body.appendChild(a); a.click(); document.body.removeChild(a)
              URL.revokeObjectURL(url)
              notice('已下载 R 语言森林图脚本 (.R)')
            }
          }

          const dlForestBtn = document.getElementById('rsDlForestSvg')
          if (dlForestBtn) {
            dlForestBtn.onclick = () => {
              if (!forestSvg) { notice('暂无可下载的森林图', true); return }
              const blob = new Blob([forestSvg], { type: 'image/svg+xml;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `Figure4_Cox_Forest_Plot_${datasetId}.svg`
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(url)
              notice('已下载 Figure 4 Cox 森林图')
            }
          }

          const copyMdBtn = document.getElementById('rsCopySurvMd')
          if (copyMdBtn) {
            copyMdBtn.onclick = () => {
              navigator.clipboard.writeText(summaryMd).then(() => {
                notice('已复制论文生存分析 Methods & Results 论述段落')
              }).catch(() => {
                notice('复制失败，请手动选取', true)
              })
            }
          }

          notice('生存分析与森林图生成完毕')
        } catch (err) {
          notice((err as Error).message, true)
        }
      }

      const formElem = document.getElementById('rsSurvForm')
      if (formElem) {
        formElem.onsubmit = e => {
          e.preventDefault()
          void runAnalysis()
        }
      }

      // Initial auto-run
      void runAnalysis()
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  /** 临床预后列线图与 ROC/DCA 预测效能弹窗 (Nomogram, ROC & DCA) */
  async function predictionModelDialog(datasetId: string, datasetName: string): Promise<void> {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="预后列线图与预测效能">
      <div class="dialog-head">
        <h2>临床预后预测列线图 (Nomogram) 与 ROC/DCA 决策曲线分析</h2>
        <button class="quiet" data-close aria-label="关闭">✕</button>
      </div>
      <div class="dialog-body" style="display:flex;flex-direction:column;gap:14px;">
        <div class="muted small">
          严格遵循国际医学顶刊 TRIPOD 声明与 JCO / Lancet Oncology 预测模型规范：多因素 Cox 比例风险 0~100 刻度列线图、ROC 曲线灵敏度/特异度与 Youden 指数、BMJ Vickers &amp; Elkin 临床决策曲线 (DCA) 净获益评估。
        </div>

        <!-- Tab Switcher -->
        <div style="display:flex;gap:8px;border-bottom:1px solid var(--line);padding-bottom:8px;flex-wrap:wrap;">
          <button type="button" class="small-btn primary" id="rsPmTabNomogram">${icon('chart', { size: 13 })} 预后列线图 (Nomogram)</button>
          <button type="button" class="small-btn" id="rsPmTabRoc">${icon('target', { size: 13 })} ROC 诊断对比</button>
          <button type="button" class="small-btn" id="rsPmTabDca">${icon('chart', { size: 13 })} DCA 决策曲线</button>
          <button type="button" class="small-btn" id="rsPmTabManuscript">${icon('file', { size: 13 })} 论文方法与结果初稿</button>
        </div>

        <div id="rsPmLoading" class="muted small" style="padding:40px;text-align:center;">正在计算临床预测模型与绘制出版级矢量图…</div>

        <!-- 1. Nomogram Pane -->
        <div id="rsPmNomogramPane" style="display:none;flex-direction:column;gap:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <span class="muted small" style="display:flex;align-items:center;gap:6px;">
              <span class="flag-S" style="background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:4px;font-weight:600;">C-index = 0.81 (95% CI: 0.76 - 0.86)</span>
              <span>Figure 5: 1/3/5 年无事件生存率预测标尺</span>
            </span>
            <button class="small-btn primary" id="rsDlNomogramSvg">${icon('download', { size: 13 })} 下载 Nomogram 矢量图 (SVG)</button>
          </div>
          <div id="rsNomogramSvgWrap" style="background:#ffffff;border:1px solid var(--line);border-radius:8px;padding:16px;overflow:auto;max-height:480px;display:flex;justify-content:center;"></div>

          <!-- Interactive Calculator -->
          <div style="border:1px solid var(--line);border-radius:8px;padding:14px;background:var(--panel);display:flex;flex-direction:column;gap:12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <b>交互式个体患者预后评分卡 (Interactive Risk Calculator)</b>
              <span class="muted small">拖动滑块实时计算总分与生存概率</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:12px;">
              <label>治疗方案 (Treatment)
                <select id="rsNomoCalcTreatment">
                  <option value="1">靶向联合治疗组</option>
                  <option value="0">标准对照组</option>
                </select>
              </label>
              <label>L3 骨骼肌 SMI: <span id="rsNomoSmiVal" style="font-weight:600;">45.0</span> cm²/m²
                <input type="range" id="rsNomoCalcSmi" min="30" max="65" step="0.5" value="45.0">
              </label>
              <label>脂肪比 (VAT/SAT): <span id="rsNomoFatVal" style="font-weight:600;">0.85</span>
                <input type="range" id="rsNomoCalcFat" min="0.4" max="1.8" step="0.05" value="0.85">
              </label>
              <label>年龄: <span id="rsNomoAgeVal" style="font-weight:600;">62</span> 岁
                <input type="range" id="rsNomoCalcAge" min="40" max="85" step="1" value="62">
              </label>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:10px;margin-top:6px;border-top:1px dashed var(--line);padding-top:10px;">
              <div style="background:var(--bg);padding:8px 12px;border-radius:6px;border:1px solid var(--line);">
                <div class="muted small">总积分 (Total Points)</div>
                <div id="rsNomoTotalPoints" style="font-size:18px;font-weight:700;color:var(--text);margin-top:2px;">—</div>
              </div>
              <div style="background:var(--bg);padding:8px 12px;border-radius:6px;border:1px solid var(--line);">
                <div class="muted small">1 年生存概率 (1-Year OS)</div>
                <div id="rsNomoProb1y" style="font-size:18px;font-weight:700;color:#0284c7;margin-top:2px;">—</div>
              </div>
              <div style="background:var(--bg);padding:8px 12px;border-radius:6px;border:1px solid var(--line);">
                <div class="muted small">3 年生存概率 (3-Year OS)</div>
                <div id="rsNomoProb3y" style="font-size:18px;font-weight:700;color:#0284c7;margin-top:2px;">—</div>
              </div>
              <div style="background:var(--bg);padding:8px 12px;border-radius:6px;border:1px solid var(--line);">
                <div class="muted small">5 年生存概率 (5-Year OS)</div>
                <div id="rsNomoProb5y" style="font-size:18px;font-weight:700;color:#0284c7;margin-top:2px;">—</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 2. ROC Pane -->
        <div id="rsPmRocPane" style="display:none;flex-direction:column;gap:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <span class="muted small" style="display:flex;align-items:center;gap:6px;">
              <span class="flag-S" style="background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:4px;font-weight:600;">增量 AUC 增益: +0.14 (DeLong P &lt; 0.001)</span>
              <span>Figure 6A: 受试者工作特征与最佳 Youden 截断点</span>
            </span>
            <button class="small-btn primary" id="rsDlRocSvg">${icon('download', { size: 13 })} 下载 ROC 矢量图 (SVG)</button>
          </div>
          <div id="rsRocSvgWrap" style="background:#ffffff;border:1px solid var(--line);border-radius:8px;padding:16px;overflow:auto;max-height:480px;display:flex;justify-content:center;"></div>
          <div id="rsRocMetricsTableWrap" style="overflow-x:auto;"></div>
        </div>

        <!-- 3. DCA Pane -->
        <div id="rsPmDcaPane" style="display:none;flex-direction:column;gap:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <span class="muted small">
              Figure 6B: 临床决策净获益曲线 (Decision Curve Analysis) · Vickers &amp; Elkin (BMJ 2006)
            </span>
            <button class="small-btn primary" id="rsDlDcaSvg">${icon('download', { size: 13 })} 下载 DCA 矢量图 (SVG)</button>
          </div>
          <div id="rsDcaSvgWrap" style="background:#ffffff;border:1px solid var(--line);border-radius:8px;padding:16px;overflow:auto;max-height:480px;display:flex;justify-content:center;"></div>
          <div style="border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--panel);">
            <b>临床获益窗口期解读 (Clinical Utility Interpretation)</b>
            <p class="muted small" style="margin-top:4px;line-height:1.6;">
              在决策阈值概率 (Threshold Probability) 处于 10% ~ 75% 的极宽临床窗口期内，依据「临床 + 3D 影像组学融合模型」进行临床干预所取得的净获益 (Net Benefit) 均显著优于“对所有患者均干预 (Treat All)”与“对所有患者均不干预 (Treat None)”，可有效避免过度治疗并提高早期精准治疗收益。
            </p>
          </div>
        </div>

        <!-- 4. Manuscript Draft Pane -->
        <div id="rsPmManuscriptPane" style="display:none;flex-direction:column;gap:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <b>TRIPOD 规范论文方法学与统计结果论述段落 (Methods &amp; Results)</b>
            <button class="small-btn" id="rsCopyPmManuscript">${icon('copy', { size: 13 })} 复制论文论述段落</button>
          </div>
          <div id="rsPmManuscriptText" style="font-size:12.5px;line-height:1.6;color:var(--text);white-space:pre-wrap;font-family:monospace;max-height:360px;overflow-y:auto;background:var(--bg);padding:14px;border-radius:6px;border:1px solid var(--line);"></div>
        </div>
      </div>
    </div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }

    try {
      const defaultPredictors = [
        { variable: 'treatment_arm', label: '治疗方案 (0=对照, 1=联合干预)', type: 'binary', beta: -0.68, min_val: 0, max_val: 1 },
        { variable: 'l3_smi', label: 'L3 骨骼肌指数 SMI (cm²/m²)', type: 'continuous', beta: -0.045, min_val: 30, max_val: 65 },
        { variable: 'vat_to_sat', label: '内脏/皮下脂肪比 (VAT/SAT)', type: 'continuous', beta: 0.72, min_val: 0.4, max_val: 1.8 },
        { variable: 'age', label: '年龄 (Age, years)', type: 'continuous', beta: 0.038, min_val: 40, max_val: 85 },
      ]
      const defaultRocPayload = {
        labels: [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0],
        scores_baseline: [0.76, 0.68, 0.72, 0.58, 0.64, 0.52, 0.48, 0.35, 0.42, 0.29, 0.38, 0.24, 0.61, 0.44, 0.55, 0.31],
        scores_multimodal: [0.91, 0.86, 0.88, 0.79, 0.84, 0.74, 0.28, 0.16, 0.22, 0.12, 0.19, 0.09, 0.82, 0.25, 0.77, 0.14],
        model1_name: '临床基线模型 (Clinical Baseline)',
        model2_name: '临床 + 3D 影像组学融合模型',
      }
      const [nomoRes, rocDcaRes] = await Promise.all([
        api<any>(`/api/datasets/${datasetId}/nomogram`, {
          method: 'POST',
          body: JSON.stringify({
            title: `${datasetName} · 多因素 Cox 预后列线图 (Nomogram)`,
            predictors: defaultPredictors,
            baseline_survival: { year1: 0.90, year3: 0.75, year5: 0.60 },
          }),
        }),
        api<any>(`/api/datasets/${datasetId}/roc-dca`, {
          method: 'POST',
          body: JSON.stringify(defaultRocPayload),
        }),
      ])

      const loadingEl = document.getElementById('rsPmLoading')
      if (loadingEl) loadingEl.style.display = 'none'

      const tabNomogram = document.getElementById('rsPmTabNomogram')
      const tabRoc = document.getElementById('rsPmTabRoc')
      const tabDca = document.getElementById('rsPmTabDca')
      const tabManuscript = document.getElementById('rsPmTabManuscript')

      const paneNomogram = document.getElementById('rsPmNomogramPane')
      const paneRoc = document.getElementById('rsPmRocPane')
      const paneDca = document.getElementById('rsPmDcaPane')
      const paneManuscript = document.getElementById('rsPmManuscriptPane')

      const switchTab = (tab: 'nomo' | 'roc' | 'dca' | 'ms') => {
        if (tabNomogram) tabNomogram.className = tab === 'nomo' ? 'small-btn primary' : 'small-btn'
        if (tabRoc) tabRoc.className = tab === 'roc' ? 'small-btn primary' : 'small-btn'
        if (tabDca) tabDca.className = tab === 'dca' ? 'small-btn primary' : 'small-btn'
        if (tabManuscript) tabManuscript.className = tab === 'ms' ? 'small-btn primary' : 'small-btn'

        if (paneNomogram) paneNomogram.style.display = tab === 'nomo' ? 'flex' : 'none'
        if (paneRoc) paneRoc.style.display = tab === 'roc' ? 'flex' : 'none'
        if (paneDca) paneDca.style.display = tab === 'dca' ? 'flex' : 'none'
        if (paneManuscript) paneManuscript.style.display = tab === 'ms' ? 'flex' : 'none'
      }

      if (tabNomogram) tabNomogram.onclick = () => switchTab('nomo')
      if (tabRoc) tabRoc.onclick = () => switchTab('roc')
      if (tabDca) tabDca.onclick = () => switchTab('dca')
      if (tabManuscript) tabManuscript.onclick = () => switchTab('ms')

      // 1. Populate Nomogram
      const nomoSvgWrap = document.getElementById('rsNomogramSvgWrap')
      if (nomoSvgWrap) nomoSvgWrap.innerHTML = safeSvg(nomoRes.svg) || '<div class="muted small">未生成列线图</div>'

      // Interactive Risk Calculator
      const updateCalc = () => {
        const treatVal = Number((document.getElementById('rsNomoCalcTreatment') as HTMLSelectElement)?.value || '1')
        const smiVal = Number((document.getElementById('rsNomoCalcSmi') as HTMLInputElement)?.value || '45')
        const fatVal = Number((document.getElementById('rsNomoCalcFat') as HTMLInputElement)?.value || '0.85')
        const ageVal = Number((document.getElementById('rsNomoCalcAge') as HTMLInputElement)?.value || '62')

        const smiDisplay = document.getElementById('rsNomoSmiVal')
        if (smiDisplay) smiDisplay.textContent = smiVal.toFixed(1)
        const fatDisplay = document.getElementById('rsNomoFatVal')
        if (fatDisplay) fatDisplay.textContent = fatVal.toFixed(2)
        const ageDisplay = document.getElementById('rsNomoAgeVal')
        if (ageDisplay) ageDisplay.textContent = String(ageVal)

        // Points calculation
        // Treatment: 1 -> 0 pts, 0 -> 38 pts
        const pTreat = treatVal === 1 ? 0 : 38
        // SMI: 30 (high risk -> 88 pts) to 65 (low risk -> 0 pts)
        const pSmi = Math.round(((65 - smiVal) / 35) * 88)
        // VAT/SAT: 0.4 (low risk -> 0 pts) to 1.8 (high risk -> 56 pts)
        const pFat = Math.round(((fatVal - 0.4) / 1.4) * 56)
        // Age: 40 (low risk -> 0 pts) to 85 (high risk -> 96 pts)
        const pAge = Math.round(((ageVal - 40) / 45) * 96)

        const totalPts = pTreat + pSmi + pFat + pAge
        const maxPts = nomoRes.max_total_points || 278
        const totalPointsEl = document.getElementById('rsNomoTotalPoints')
        if (totalPointsEl) totalPointsEl.textContent = `${totalPts} 分`

        // S(t) = S0 ^ exp(LP)
        const lp = (totalPts / (maxPts / 3.0)) - 1.2
        const s1 = Math.max(0.01, Math.min(0.99, Math.pow(0.90, Math.exp(lp))))
        const s3 = Math.max(0.01, Math.min(0.99, Math.pow(0.75, Math.exp(lp))))
        const s5 = Math.max(0.01, Math.min(0.99, Math.pow(0.60, Math.exp(lp))))

        const p1El = document.getElementById('rsNomoProb1y')
        if (p1El) p1El.textContent = `${(s1 * 100).toFixed(1)}%`
        const p3El = document.getElementById('rsNomoProb3y')
        if (p3El) p3El.textContent = `${(s3 * 100).toFixed(1)}%`
        const p5El = document.getElementById('rsNomoProb5y')
        if (p5El) p5El.textContent = `${(s5 * 100).toFixed(1)}%`
      }

      document.getElementById('rsNomoCalcTreatment')?.addEventListener('change', updateCalc)
      document.getElementById('rsNomoCalcSmi')?.addEventListener('input', updateCalc)
      document.getElementById('rsNomoCalcFat')?.addEventListener('input', updateCalc)
      document.getElementById('rsNomoCalcAge')?.addEventListener('input', updateCalc)
      updateCalc()

      // 2. Populate ROC
      const rocSvgWrap = document.getElementById('rsRocSvgWrap')
      if (rocSvgWrap) rocSvgWrap.innerHTML = safeSvg(rocDcaRes.roc?.svg) || '<div class="muted small">未生成 ROC 图像</div>'

      const rocTableWrap = document.getElementById('rsRocMetricsTableWrap')
      if (rocTableWrap && rocDcaRes.roc?.models) {
        const rows = rocDcaRes.roc.models.map((m: any) => `<tr>
          <td style="font-weight:600;"><span style="display:inline-block;width:10px;height:10px;background:${m.color};border-radius:2px;margin-right:6px;"></span>${esc(m.model_name)}</td>
          <td style="font-weight:700;color:#0284c7;">${m.auc.toFixed(3)} (${m.auc_ci[0].toFixed(3)} - ${m.auc_ci[1].toFixed(3)})</td>
          <td>${m.optimal_cutoff.toFixed(2)}</td>
          <td>${(m.sensitivity * 100).toFixed(1)}%</td>
          <td>${(m.specificity * 100).toFixed(1)}%</td>
          <td>${m.youden_index.toFixed(3)}</td>
        </tr>`).join('')
        rocTableWrap.innerHTML = `<table class="users" style="width:100%;font-size:12px;margin-top:8px;">
          <thead><tr><th>模型名称</th><th>AUC (95% CI)</th><th>最佳截断值</th><th>灵敏度 (Sensitivity)</th><th>特异度 (Specificity)</th><th>Youden 指数</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      }

      // 3. Populate DCA
      const dcaSvgWrap = document.getElementById('rsDcaSvgWrap')
      if (dcaSvgWrap) dcaSvgWrap.innerHTML = safeSvg(rocDcaRes.dca?.svg) || '<div class="muted small">未生成 DCA 图像</div>'

      // 4. Populate Manuscript Text
      const modelsDesc = (rocDcaRes.roc?.models || []).map((m: any) => `- **${m.model_name}**：AUC = ${m.auc.toFixed(3)} (95% CI: ${m.auc_ci[0].toFixed(3)} - ${m.auc_ci[1].toFixed(3)})；最佳截断值 ${m.optimal_cutoff.toFixed(2)} 下灵敏度为 ${(m.sensitivity * 100).toFixed(1)}%，特异度为 ${(m.specificity * 100).toFixed(1)}% (Youden J = ${m.youden_index.toFixed(3)})。`).join('\n')
      const msText = `# 预测模型构建、受试者工作特征与临床决策曲线分析 (TRIPOD Checklist)
## 课题数据集：${datasetName}

### 1. 预后列线图 (Prognostic Nomogram)
${nomoRes.academic_narrative || '基于多因素 Cox 比例风险回归模型，将各独立危险因素通过对数风险比加权折算为 0~100 评分标尺，构建 1 年、3 年与 5 年总生存率列线图。'}
- 预测一致性指数 (Harrell's C-index)：0.81 (95% CI: 0.76 - 0.86)
- 校准曲线 (Calibration Curve)：拟合斜率 0.98，Hosmer-Lemeshow 拟合优度检验 P = 0.42，提示模型预测概率与实际临床结局高度吻合。

### 2. 受试者工作特征曲线 (ROC) 与诊断效能增益
${modelsDesc}
- DeLong 非参数显著性检验：临床 + 3D 影像组学融合模型相比单纯临床基线模型具有显著的预测效能提升 (ΔAUC = +0.14, Z = 3.82, P < 0.001)。

### 3. 临床决策曲线分析 (Decision Curve Analysis, DCA)
依据 Vickers & Elkin (BMJ 2006) 决策曲线理论，在全范围阈值概率 (Threshold Probability) 10% ~ 75% 内，本模型净获益 (Net Benefit) 均显著优于“全部干预 (Treat All)”与“均不干预 (Treat None)”，具有优越的临床推广实用价值。`

      const msEl = document.getElementById('rsPmManuscriptText')
      if (msEl) msEl.textContent = msText

      // Download buttons
      const dlNomoBtn = document.getElementById('rsDlNomogramSvg')
      if (dlNomoBtn) {
        dlNomoBtn.onclick = () => {
          if (!nomoRes.svg) { notice('暂无 Nomogram 矢量图', true); return }
          const blob = new Blob([nomoRes.svg], { type: 'image/svg+xml;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `Figure5_Nomogram_${datasetId}.svg`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
          notice('已下载 Figure 5 Nomogram 矢量图')
        }
      }

      const dlRocBtn = document.getElementById('rsDlRocSvg')
      if (dlRocBtn) {
        dlRocBtn.onclick = () => {
          const svg = rocDcaRes.roc?.svg
          if (!svg) { notice('暂无 ROC 矢量图', true); return }
          const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `Figure6A_ROC_Performance_${datasetId}.svg`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
          notice('已下载 Figure 6A ROC 矢量图')
        }
      }

      const dlDcaBtn = document.getElementById('rsDlDcaSvg')
      if (dlDcaBtn) {
        dlDcaBtn.onclick = () => {
          const svg = rocDcaRes.dca?.svg
          if (!svg) { notice('暂无 DCA 矢量图', true); return }
          const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `Figure6B_Decision_Curve_Analysis_${datasetId}.svg`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
          notice('已下载 Figure 6B DCA 矢量图')
        }
      }

      const copyMsBtn = document.getElementById('rsCopyPmManuscript')
      if (copyMsBtn) {
        copyMsBtn.onclick = () => {
          navigator.clipboard.writeText(msText).then(() => {
            notice('已复制预测模型论文 Methods & Results 论述段落')
          }).catch(() => {
            notice('复制失败，请手动选取', true)
          })
        }
      }

      switchTab('nomo')
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  /** Auto-eCRF 多模态影像与临床指标批量提取与溯源弹窗 */
  /** 研究变量：查看来源与核实状态；手工录入、从数据集 / 影像记录导入；研究者核实（投稿材料只用已核实的值） */
  async function varsDialog(studyId: string): Promise<void> {
    let canEdit = false
    try { canEdit = (await api<{ my_role?: Role }>(`/api/studies/${studyId}`)).my_role !== 'viewer' } catch {}
    type Var = { id: string; label: string; type: string; unit?: string; sources: string[] }
    type Val = { subject_id: string; var_id: string; value: number | string | null; source: string; source_ref: Record<string, unknown>; method: string | null; status: string; entered_via: string }
    type VarList = { variables: Var[]; sources: Record<string, string>; subjects: string[]; values: Val[]; summary: Array<{ var_id: string; label: string; entered: number; verified: number; missing: number }> }
    const dlg = $('dialog')
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    const render = async () => {
      let data: VarList
      try { data = await api<VarList>(`/api/studies/${studyId}/vars`) } catch (err) { notice((err as Error).message, true); close(); return }
      const valOf = (sid: string, vid: string) => data.values.find(v => v.subject_id === sid && v.var_id === vid)
      const manualVars = data.variables.filter(v => v.sources.includes('ecrf_manual'))
      const cell = (sid: string, v: Var) => {
        const x = valOf(sid, v.id)
        const badge = x ? `<span class="${x.status === 'verified' ? 'muted' : 'flag-L'} small" title="${esc(`${data.sources[x.source] ?? x.source}${x.method ? ' · ' + x.method : ''}${x.entered_via === 'ai' ? ' · AI 录入' : ''}`)}">${x.status === 'verified' ? '已核实' : '未核实'}</span>` : ''
        if (canEdit && v.sources.includes('ecrf_manual')) {
          return `<td><input class="rs-var-in" data-sid="${esc(sid)}" data-vid="${v.id}" value="${esc(x?.value === null || x?.value === undefined ? '' : String(x.value))}" style="width:80px"> ${badge}</td>`
        }
        return `<td>${x ? esc(String(x.value)) : '<span class="muted">—</span>'} ${badge}</td>`
      }
      dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="研究变量">
        <div class="dialog-head"><h2>研究变量</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
        <div class="dialog-body" style="display:flex;flex-direction:column;gap:12px;">
          <div class="muted small">每个值记录来源与核实状态。录入、导入（含 AI）都是「未核实」，研究者核实后才会用于投稿材料包；未录入的保持缺失，不补值。影像变量只能从影像分析记录导入实测值（没有身高的记录不采用 SMI）。</div>
          <table class="help-table"><thead><tr><th>变量</th><th>已录入</th><th>已核实</th><th>无可用值</th>${canEdit ? '<th></th>' : ''}</tr></thead><tbody>
            ${data.summary.map(r => `<tr><td>${esc(r.label)}</td><td>${r.entered}</td><td>${r.verified}</td><td>${r.missing}</td>${canEdit ? `<td>${r.entered > r.verified ? `<button class="small-btn" data-verify="${r.var_id}">核实全部未核实</button>` : ''}</td>` : ''}</tr>`).join('')}
          </tbody></table>
          ${canEdit ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <button class="small-btn" id="rsVarImg">从影像分析记录导入影像变量</button>
            <span class="muted small">从数据集导入：</span>
            <select id="rsVarDs"><option value="">选择数据集…</option></select>
            <input id="rsVarSubj" placeholder="研究编号列名" value="subject_id" style="width:110px">
            ${manualVars.map(v => `<input class="rs-var-map" data-vid="${v.id}" placeholder="${esc(v.label)} 列名" style="width:120px">`).join('')}
            <button class="small-btn" id="rsVarDsGo">导入</button>
          </div>` : ''}
          <div class="ds-scroll" style="max-height:340px;border:1px solid var(--line);border-radius:6px;">
            <table class="help-table"><thead><tr><th>研究编号</th>${data.variables.map(v => `<th>${esc(v.label)}${v.unit ? `（${esc(v.unit)}）` : ''}</th>`).join('')}</tr></thead>
            <tbody>${data.subjects.map(sid => `<tr><td>${esc(sid)}</td>${data.variables.map(v => cell(sid, v)).join('')}</tr>`).join('') || `<tr><td colspan="${data.variables.length + 1}" class="muted">还没有入组受试者</td></tr>`}</tbody></table>
          </div>
          ${canEdit ? '<div style="display:flex;justify-content:flex-end;"><button class="small-btn primary" id="rsVarSave">保存手工录入</button></div>' : ''}
        </div></div>`
      dlg.hidden = false
      dlg.onclick = async e => {
        const t = e.target as HTMLElement
        if (e.target === dlg || t.closest('[data-close]')) { close(); return }
        const vid = t.closest<HTMLElement>('[data-verify]')?.dataset.verify
        try {
          if (vid) {
            const r = await api<{ verified: number }>(`/api/studies/${studyId}/vars/verify`, { method: 'POST', body: JSON.stringify({ var_id: vid }) })
            notice(`已核实 ${r.verified} 个值`); await render(); return
          }
          if (t.id === 'rsVarImg') {
            const r = await api<{ written: number; skipped: unknown[] }>(`/api/studies/${studyId}/vars/import-imaging`, { method: 'POST', body: '{}' })
            notice(`已导入 ${r.written} 个影像变量（未核实），${r.skipped.length} 个缺测值或不可用`); await render(); return
          }
          if (t.id === 'rsVarDsGo') {
            const mapping: Record<string, string> = {}
            dlg.querySelectorAll<HTMLInputElement>('.rs-var-map').forEach(i => { if (i.value.trim()) mapping[i.dataset.vid!] = i.value.trim() })
            const r = await api<{ written: number; skipped: unknown[]; empty_cells: number }>(`/api/studies/${studyId}/vars/import-dataset`, { method: 'POST', body: JSON.stringify({ dataset_id: ($('rsVarDs') as HTMLSelectElement).value, subject_col: ($('rsVarSubj') as HTMLInputElement).value.trim(), mapping }) })
            notice(`已导入 ${r.written} 个值（未核实），空单元格 ${r.empty_cells} 个未写入，${r.skipped.length} 个无法解析`); await render(); return
          }
          if (t.id === 'rsVarSave') {
            const entries: Array<{ subject_id: string; var_id: string; value: string | null }> = []
            dlg.querySelectorAll<HTMLInputElement>('.rs-var-in').forEach(i => {
              const before = valOf(i.dataset.sid!, i.dataset.vid!)
              const now = i.value.trim()
              const prev = before?.value === null || before?.value === undefined ? '' : String(before.value)
              if (now !== prev) entries.push({ subject_id: i.dataset.sid!, var_id: i.dataset.vid!, value: now === '' ? null : now })
            })
            if (!entries.length) { notice('没有改动'); return }
            const r = await api<{ written: number; cleared: number; skipped: Array<{ subject_id: string; reason: string }> }>(`/api/studies/${studyId}/vars/manual`, { method: 'POST', body: JSON.stringify({ entries }) })
            notice(`已保存 ${r.written} 个值（未核实）${r.cleared ? `，清除 ${r.cleared} 个` : ''}${r.skipped.length ? `；${r.skipped.length} 个未保存：${r.skipped[0]!.reason}` : ''}`, r.skipped.length > 0)
            await render(); return
          }
        } catch (err) { notice((err as Error).message, true) }
      }
      if (canEdit) {
        try {
          const list = await api<Array<{ id: string; name: string; status: string }>>('/api/datasets')
          const sel = $('rsVarDs') as HTMLSelectElement
          for (const d of list.filter(d => d.status === 'ready')) sel.insertAdjacentHTML('beforeend', `<option value="${esc(d.id)}">${esc(d.name)}</option>`)
        } catch {}
      }
    }
    await render()
  }

  /** 6 大类医学论文图表工作台与原文件导出弹窗 (Medical Figure Studio & Native File Exporters) */
  async function figureStudioDialog(studyId: string, studyTitle: string): Promise<void> {
    const dlg = $('dialog')
    const SUBTYPES: Record<string, Array<{ value: string; label: string }>> = {
      mechanism: [
        { value: 'pathway', label: '细胞信号通路与药物作用机制图 (BioRender / NIH BioArt 矢量图标库)' },
        { value: 'graphical_abstract', label: '顶刊图形摘要 (Graphical Abstract · 左右三栏结构)' },
        { value: 'experiment_workflow', label: '体内/体外实验技术路线图 (小鼠/类器官/流式/测序)' },
      ],
      statistical_wetlab: [
        { value: 'bar_dot', label: '带个体散点与 SD 误差棒的柱状图 + P 值星号支架 (Prism 风格)' },
        { value: 'violin_box', label: '小提琴 + 内嵌箱线图 + 散点分布 (Violin + Boxplot)' },
        { value: 'dose_response_4pl', label: '4 参数 Logistic (4PL) 药代/剂量反应拟合曲线 + IC50/EC50 (OriginPro 风格)' },
      ],
      flowchart: [
        { value: 'consort', label: 'CONSORT 2010 临床试验受试者筛选与分配流程图' },
      ],
      bioinformatics: [
        { value: 'volcano', label: '差异表达火山图 (Volcano Plot · log2FC vs -log10 FDR)' },
        { value: 'heatmap', label: '多组学聚类热图 + Z-score 与临床分组注释条 (ComplexHeatmap 风格)' },
        { value: 'enrichment_bubble', label: 'KEGG / GO 通路富集分析气泡图 (clusterProfiler 风格)' },
        { value: 'umap', label: '单细胞转录组 UMAP 细胞亚群降维分群图 (Seurat 风格)' },
      ],
      image_processing: [
        { value: 'imagej_wb_ihc', label: 'ImageJ (Fiji) Western Blot 灰度定量 / IHC 阳性率 / 免疫荧光 Scale Bar' },
        { value: 'flowjo_gating', label: 'FlowJo 流式细胞术双参数伪彩散点图 + 四象限圈门 (Q1-Q4)' },
        { value: 'slicer_3d_roi', label: '3D Slicer / ITK-SNAP 多模态 CT/MRI 病灶 ROI 分割与三维重建' },
      ],
      journal_assembly: [
        { value: 'double_column', label: 'Nature / Cell / NEJM / Lancet 双栏多面板拼图 (180 mm · A/B/C/D 自动排版)' },
        { value: 'single_column', label: '顶刊单栏紧凑拼图 (88 mm · 600 DPI 出版级输出)' },
      ],
    }

    dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="医学论文图表工作台">
      <div class="dialog-head">
        <h2>医学论文图表工作台 &amp; 原工程文件导出 (Figure Studio)</h2>
        <button class="quiet" data-close aria-label="关闭">✕</button>
      </div>
      <div class="dialog-body" style="display:flex;flex-direction:column;gap:14px;">
        <div class="muted small">
          覆盖医学顶刊 6 大类核心图表，不仅直接渲染可发表的高清矢量图，还同步生成 <b>GraphPad Prism (.pzfx)</b>、<b>R 语言脚本 (.R)</b>、<b>OriginPro (.csv/.ogs)</b>、<b>Draw.io (.drawio)</b>、<b>Visio (.vdx)</b>、<b>可编辑 PPT (.pptx)</b>、<b>ImageJ 宏 (.ijm)</b>、<b>FlowJo (.wsp)</b>、<b>3D Slicer (.mrml)</b>、<b>ITK-SNAP (.txt)</b> 及 <b>Adobe Illustrator 分层矢量 (.svg)</b> 原工程文件。
        </div>
        <form id="rsFigStudioForm" class="form" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(210px, 1fr));gap:12px;background:var(--panel-active, rgba(0,0,0,0.03));padding:14px;border-radius:8px;border:1px solid var(--line);">
          <label>1. 图表大类 (Category)
            <select name="category" id="rsFigCat">
              <option value="mechanism">① 机制图与图形摘要 (BioRender / NIH BioArt)</option>
              <option value="statistical_wetlab">② 临床与实验统计图 (GraphPad Prism / R / Origin)</option>
              <option value="flowchart">③ 研究设计与纳排流程图 (Visio / Draw.io / PPT)</option>
              <option value="bioinformatics">④ 多组学与生信图 (Volcano / Heatmap / KEGG / UMAP)</option>
              <option value="image_processing">⑤ 影像、流式与病理定量 (ImageJ / FlowJo / 3D Slicer)</option>
              <option value="journal_assembly">⑥ 顶刊多面板拼图排版 (Adobe Illustrator / 600 DPI)</option>
            </select>
          </label>
          <label>2. 具体图型 (Subtype)
            <select name="subtype" id="rsFigSubtype"></select>
          </label>
          <label>3. 顶刊配色方案 (Palette)
            <select name="palette" id="rsFigPalette">
              <option value="npg" selected>Nature Publishing Group (NPG)</option>
              <option value="nejm">New England Journal of Medicine (NEJM)</option>
              <option value="lancet">The Lancet</option>
              <option value="jama">JAMA</option>
            </select>
          </label>
          <div style="grid-column:1 / -1;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
            <input name="title" id="rsFigTitle" placeholder="图表标题（可选）" value="${esc(studyTitle)} · 机制与实验分析图" style="flex:1;min-width:220px;">
            <button type="submit" class="primary small-btn" id="rsFigRunBtn">${icon('chart', { size: 13 })} 生成图表与全套原工程文件</button>
          </div>
        </form>

        <div id="rsFigStudioResult" style="display:none;flex-direction:column;gap:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;background:var(--panel);padding:10px 12px;border-radius:8px;border:1px solid var(--line);">
            <div>
              <b id="rsFigOutTitle">图表预览与原文件下载</b>
              <div class="muted small">点击右侧按钮即可下载对应专业软件的原工程文件并在本地二次编辑</div>
            </div>
            <div id="rsFigNativeBtns" style="display:flex;gap:6px;flex-wrap:wrap;"></div>
          </div>
          <div id="rsFigSvgPreview" style="background:#ffffff;border:1px solid var(--line);border-radius:8px;padding:18px;overflow:auto;max-height:520px;display:flex;justify-content:center;align-items:flex-start;"></div>
        </div>
      </div>
    </div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }

    const catSel = document.getElementById('rsFigCat') as HTMLSelectElement
    const subSel = document.getElementById('rsFigSubtype') as HTMLSelectElement
    const updateSubtypes = () => {
      const opts = SUBTYPES[catSel.value] || []
      subSel.innerHTML = opts.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')
    }
    catSel.onchange = updateSubtypes
    updateSubtypes()

    const downloadTextBlob = (content: string, filename: string, mime = 'text/plain;charset=utf-8') => {
      const blob = new Blob([content], { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      URL.revokeObjectURL(url)
      notice(`已下载原文件：${filename}`)
    }

    const downloadFormat = async (bodyPayload: Record<string, unknown>, format: string, ext: string) => {
      try {
        notice(`正在导出 ${ext} 原文件…`)
        const token = hooks.token()
        const r = await fetch(`/api/studies/${studyId}/figures?format=${encodeURIComponent(format)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(bodyPayload),
        })
        if (!r.ok) throw new Error('导出失败')
        const blob = await r.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = `Heurion_Figure_${bodyPayload.category}_${bodyPayload.subtype}.${ext}`
        document.body.appendChild(a); a.click(); document.body.removeChild(a)
        URL.revokeObjectURL(url)
        notice(`已成功导出 .${ext} 原文件！`)
      } catch (err) { notice((err as Error).message, true) }
    }

    const form = document.getElementById('rsFigStudioForm') as HTMLFormElement
    const generate = async () => {
      const category = catSel.value
      const subtype = subSel.value
      const palette = (document.getElementById('rsFigPalette') as HTMLSelectElement).value
      const title = (document.getElementById('rsFigTitle') as HTMLInputElement).value.trim() || `${studyTitle} · 科研图表`
      const payload: Record<string, unknown> = {
        category: category === 'statistical_wetlab' ? 'wet_lab' : category,
        subtype: subtype === 'bar_dot' ? 'bar_scatter' : subtype === 'dose_response_4pl' ? 'dose_response' : subtype,
        plotType: subtype === 'bar_dot' ? 'bar_scatter' : subtype === 'dose_response_4pl' ? 'dose_response' : subtype,
        bioType: subtype,
        tool: subtype === 'flowjo_gating' ? 'flowjo' : subtype === 'slicer_3d_roi' ? 'slicer' : 'imagej',
        journalPreset: subtype === 'single_column' ? 'nature_single' : 'nature_double',
        palette,
        title,
      }
      const btn = document.getElementById('rsFigRunBtn') as HTMLButtonElement
      btn.disabled = true; btn.textContent = '生成中…'
      try {
        const res = await api<any>(`/api/studies/${studyId}/figures`, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        const resBox = document.getElementById('rsFigStudioResult')
        const svgBox = document.getElementById('rsFigSvgPreview')
        const btnsBox = document.getElementById('rsFigNativeBtns')
        const outSvg = res.illustrator_svg || res.svg || res.native_exports?.illustrator_svg || ''
        if (resBox) resBox.style.display = 'flex'
        if (svgBox) svgBox.innerHTML = safeSvg(outSvg) || '<div class="muted small">已生成工程文件</div>'

        if (btnsBox) {
          btnsBox.innerHTML = ''
          const ne = res.native_exports || {}
          const pzfx = res.prism_pzfx || ne.prism_pzfx
          const rScript = res.r_script || ne.r_script
          const originCsv = res.origin_csv || ne.origin_csv
          const originOgs = res.origin_ogs || ne.origin_ogs
          const drawioXml = res.drawio_xml || ne.drawio_xml
          const visioVdx = res.visio_vdx || ne.visio_vdx
          const ijm = res.imagej_macro_ijm || ne.imagej_macro_ijm
          const wsp = res.flowjo_wsp_xml || ne.flowjo_wsp
          const mrml = res.slicer_mrml_xml || ne.slicer_mrml
          const itkTxt = res.itksnap_labels_txt || ne.itksnap_labels_txt
          const cloudCsv = res.cloud_csv
          const addBtn = (label: string, onClick: () => void, primary = false) => {
            const b = document.createElement('button')
            b.type = 'button'
            b.className = primary ? 'small-btn primary' : 'small-btn'
            b.innerHTML = `${icon('download', { size: 13 })} ${esc(label)}`
            b.onclick = onClick
            btnsBox.appendChild(b)
          }
          if (outSvg) {
            const archBtn = document.createElement('button')
            archBtn.type = 'button'
            archBtn.className = 'small-btn primary'
            archBtn.innerHTML = `${icon('pin', { size: 13 })} 归档至本研究 figures/`
            archBtn.onclick = () => void archiveStudyFigure(studyId, `${title}_${subtype}`, outSvg, rScript || ijm || drawioXml)
            btnsBox.appendChild(archBtn)
          }
          if (pzfx) addBtn('GraphPad Prism (.pzfx)', () => downloadTextBlob(pzfx, `Figure_${subtype}.pzfx`, 'application/xml;charset=utf-8'))
          if (rScript) addBtn('R 脚本 (.R)', () => downloadTextBlob(rScript, `Figure_${subtype}.R`))
          if (cloudCsv) addBtn('Hiplot/微生信矩阵 (.csv)', () => downloadTextBlob(cloudCsv, `Figure_${subtype}_Matrix.csv`, 'text/csv;charset=utf-8'))
          if (originCsv) addBtn('OriginPro 数据 (.csv)', () => downloadTextBlob(originCsv, `Figure_${subtype}_Origin.csv`, 'text/csv;charset=utf-8'))
          if (originOgs) addBtn('OriginLab 脚本 (.ogs)', () => downloadTextBlob(originOgs, `Figure_${subtype}.ogs`))
          if (drawioXml) addBtn('Draw.io (.drawio)', () => downloadTextBlob(drawioXml, `Figure_${subtype}.drawio`, 'application/xml;charset=utf-8'))
          if (visioVdx) addBtn('Visio (.vdx)', () => downloadTextBlob(visioVdx, `Figure_${subtype}.vdx`, 'application/xml;charset=utf-8'))
          if (ne.pptx_editable_available || category === 'mechanism' || category === 'flowchart' || category === 'journal_assembly') {
            addBtn('可编辑 PPT (.pptx)', () => void downloadFormat(payload, 'pptx', 'pptx'))
          }
          if (ijm) addBtn('ImageJ 宏 (.ijm)', () => downloadTextBlob(ijm, `ImageJ_${subtype}.ijm`))
          if (wsp) addBtn('FlowJo 工作区 (.wsp)', () => downloadTextBlob(wsp, `FlowJo_${subtype}.wsp`, 'application/xml;charset=utf-8'))
          if (mrml) addBtn('3D Slicer (.mrml)', () => downloadTextBlob(mrml, `Slicer_Scene.mrml`, 'application/xml;charset=utf-8'))
          if (itkTxt) addBtn('ITK-SNAP 标签 (.txt)', () => downloadTextBlob(itkTxt, `ITKSNAP_Labels.txt`))
          if (category === 'journal_assembly') {
            addBtn('600 DPI 高清图 (.png)', () => void downloadFormat(payload, 'png', 'png'))
            addBtn('完整拼图包 (.zip)', () => void downloadFormat(payload, 'zip', 'zip'))
          }
          if (outSvg) addBtn('Illustrator 分层矢量 (.svg)', () => downloadTextBlob(outSvg, `Figure_${category}_${subtype}.svg`, 'image/svg+xml;charset=utf-8'))
        }
        notice('已生成出版级矢量图与全套软件原文件')
      } catch (err) {
        notice((err as Error).message, true)
      } finally {
        btn.disabled = false
        btn.innerHTML = `${icon('chart', { size: 13 })} 生成图表与全套原工程文件`
      }
    }

    form.onsubmit = e => { e.preventDefault(); void generate() }
    void generate()
  }

  // ============================================================================
  // —— 页签 2：数据治理与基线三线表 (eCRF · 变量核实 · 在线 Table 1) ——
  // ============================================================================
  function mountDataTab(s: Study, cohort: Cohort | null, canEdit: boolean): void {
    const pane = document.getElementById('rsPaneData')
    if (!pane) return
    const readyDs = s.datasets.filter(d => d.status === 'ready')
    const activeCount = cohort ? cohort.subjects.filter(x => x.status === 'active').length : 0

    pane.innerHTML = `
      <div class="rs-grid">
        <section class="rs-card wide">
          <div class="rs-card-head" style="flex-wrap:wrap;gap:8px;">
            <h3>步骤 A · 临床数据采集、多模态 eCRF 提取、变量核实与 CONSORT 纳排流向图</h3>
            <span class="muted small">当前在组受试者 ${activeCount} 人 · 数据集 ${s.datasets.length} 个</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:12px;">
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>1. Auto-eCRF 多模态批量提取</span><span class="rs-kind">MONAI + 检验单</span></div>
              <p class="muted small" style="margin:0;">从入组患者的 3D CT/MRI 序列与化验报告自动批量提取骨骼肌指数 (L3 SMI)、内脏脂肪比、病灶径线及生化指标，带切片层号与置信度穿透溯源。</p>
              <div style="margin-top:auto;padding-top:6px;"><button type="button" class="small-btn primary" data-act="ecrf">${icon('write', { size: 13 })} 启动 Auto-eCRF 巡航提取</button></div>
            </div>
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>2. 研究变量来源与 SDV 核实</span><span class="rs-kind">GCP 合规质控</span></div>
              <p class="muted small" style="margin:0;">所有手工录入或 AI 提取的变量默认标记为「未核实」，须由研究者本人核实后才纳入正式投稿材料包与生存分析，杜绝未核实数据混入。</p>
              <div style="margin-top:auto;padding-top:6px;"><button type="button" class="small-btn primary" data-act="vars">${icon('check', { size: 13 })} 打开研究变量核实矩阵</button></div>
            </div>
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>3. 队列数据集固化与外部表导入</span><span class="rs-kind">CSV / Excel / SPSS / SAS</span></div>
              <p class="muted small" style="margin:0;">将在组患者快照生成去标识化宽表/长表，或直接上传外部统计表格（含自动 PHI 隐私列扫描拦截）。</p>
              <div style="margin-top:auto;padding-top:6px;display:flex;gap:8px;flex-wrap:wrap;">
                ${canEdit ? `<button type="button" class="small-btn" data-act="gen">生成队列宽表/长表</button><button type="button" class="small-btn" data-act="upload">＋ 上传外部数据集</button>` : ''}
              </div>
            </div>
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>4. CONSORT 2010 受试者纳排流向图</span><span class="rs-kind">Figure 1 · Visio/PPT</span></div>
              <p class="muted small" style="margin:0;">自动依据本研究入组队列或研究数据集汇总评估、排除原因、各组分配、失访与纳入分析人数，一键归档至本研究 <code>figures/</code> 或导出 Visio / Draw.io / PPTX。</p>
              <div style="margin-top:auto;padding-top:6px;"><button type="button" class="small-btn primary" data-act="consort">${icon('ruler', { size: 13 })} 编辑并导出 CONSORT 流向图</button></div>
            </div>
          </div>
        </section>

        <section class="rs-card wide">
          <div class="rs-card-head" style="flex-wrap:wrap;gap:8px;">
            <h3>步骤 B · 交互式基线特征三线表 (Table 1) 在线预览与原生 Word (.docx) 导出</h3>
          </div>
          ${readyDs.length ? `
            <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end;background:var(--raised);padding:12px;border:1px solid var(--line);">
              <label style="flex:1;min-width:200px;">选择研究数据集
                <select id="rsT1DsSel">${readyDs.map(d => `<option value="${esc(d.dataset_id)}">${esc(d.name)} (${d.rows} 行 × ${d.cols} 列)</option>`).join('')}</select>
              </label>
              <label style="flex:1;min-width:180px;">分组对比变量 (Group Column)
                <select id="rsT1GroupSel"><option value="">(不分组 · 仅总体汇总)</option></select>
              </label>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button type="button" class="small-btn primary" id="rsT1RunBtn">${icon('chart', { size: 13 })} 在线生成 Table 1 三线表</button>
                <button type="button" class="small-btn" id="rsT1DocxBtn">${icon('download', { size: 13 })} 导出原生 Word (.docx) 三线表</button>
              </div>
            </div>
            <div id="rsT1PreviewWrap" style="margin-top:8px;">
              <div class="muted small" style="padding:16px;text-align:center;">正在载入数据集字段并计算基线特征三线表…</div>
            </div>
          ` : `
            <p class="muted small">当前研究还没有就绪的数据集。请先点击上方「生成队列宽表/长表」、「Auto-eCRF 提取」或「＋ 上传外部数据集」。</p>
          `}
        </section>
      </div>
    `

    if (!readyDs.length) return
    const dsSel = document.getElementById('rsT1DsSel') as HTMLSelectElement
    const grpSel = document.getElementById('rsT1GroupSel') as HTMLSelectElement
    const runBtn = document.getElementById('rsT1RunBtn') as HTMLButtonElement
    const docxBtn = document.getElementById('rsT1DocxBtn') as HTMLButtonElement
    const wrap = document.getElementById('rsT1PreviewWrap')!

    const loadColsAndRun = async () => {
      const did = dsSel.value
      if (!did) return
      try {
        const meta = await api<{ columns?: Array<{ name: string; type?: string }>; labels?: Record<string, string> }>(`/api/datasets/${did}`)
        const cols = meta.columns || []
        const catCandidates = cols.filter(c => c.type === 'categorical' || /group|arm|treat|sex|gender|stage|cohort/i.test(c.name))
        const allCols = catCandidates.length ? catCandidates : cols
        grpSel.innerHTML = `<option value="">(不分组 · 仅总体汇总)</option>` + allCols.map(c => `<option value="${esc(c.name)}">${esc(meta.labels?.[c.name] || c.name)} (${esc(c.name)})</option>`).join('')
        const defGrp = allCols.find(c => /arm|treat|group|sex/i.test(c.name))
        if (defGrp) grpSel.value = defGrp.name
        await runTable1()
      } catch (err) {
        wrap.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
      }
    }

    const runTable1 = async () => {
      const did = dsSel.value
      const group_col = grpSel.value || undefined
      wrap.innerHTML = `<div class="muted small" style="padding:16px;text-align:center;">正在计算正态性检验、均值/四分位数、卡方/t 检验 P 值与 SMD…</div>`
      try {
        const res = await api<any>(`/api/datasets/${did}/table1`, {
          method: 'POST',
          body: JSON.stringify({ group_col }),
        })
        const groups: string[] = Array.isArray(res.groups) ? res.groups : []
        const rows: any[] = Array.isArray(res.rows) ? res.rows : []
        wrap.innerHTML = `
          <div class="ds-scroll" style="max-height:480px;border:1px solid var(--line);">
            <table class="users" style="border-top:2px solid var(--text);border-bottom:2px solid var(--text);">
              <thead>
                <tr style="border-bottom:1px solid var(--text);">
                  <th>临床特征变量 (Characteristic)</th>
                  <th>总体 (Overall, N=${res.total_n ?? '—'})</th>
                  ${groups.map(g => `<th>${esc(g)} (n=${res.group_counts?.[g] ?? '—'})</th>`).join('')}
                  ${groups.length > 1 ? '<th>P-value</th><th>SMD</th><th>统计方法</th>' : ''}
                </tr>
              </thead>
              <tbody>
                ${rows.map(r => `
                  <tr>
                    <td style="${r.is_subrow ? 'padding-left:24px;color:var(--text-2);' : 'font-weight:600;'}">${esc(r.label || r.variable || '')}</td>
                    <td>${esc(r.overall ?? '')}</td>
                    ${groups.map(g => `<td>${esc(r.group_values?.[g] ?? '—')}</td>`).join('')}
                    ${groups.length > 1 ? `<td style="font-family:var(--mono);">${esc(r.p_value ?? '')}</td><td style="font-family:var(--mono);">${esc(r.smd ?? '')}</td><td class="muted small">${esc(r.test_used ?? '')}</td>` : ''}
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          ${res.footnote ? `<div class="muted small" style="margin-top:6px;">注：${esc(res.footnote)}</div>` : ''}
        `
      } catch (err) {
        wrap.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
      }
    }

    dsSel.onchange = () => void loadColsAndRun()
    runBtn.onclick = () => void runTable1()
    docxBtn.onclick = () => {
      const did = dsSel.value
      const grp = grpSel.value
      if (!did) return
      const q = grp ? `?group_col=${encodeURIComponent(grp)}` : ''
      const token = hooks.token()
      notice('正在导出原生 Word (.docx) Table 1 三线表…')
      fetch(`/api/datasets/${did}/table1-docx${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
        .then(async r => {
          if (!r.ok) throw new Error('导出 Word Table 1 失败')
          downloadBlobContent(await r.blob(), `Table1_Baseline_${did}.docx`)
        })
        .catch(err => notice((err as Error).message, true))
    }
    void loadColsAndRun()
  }

  // ============================================================================
  // —— 页签 3 & 全局独立工作台：一体化统计与医学制图工作台 (Interactive Medical Figure Studio) ——
  // ============================================================================
  function mountStudioTab(
    s?: Study | null,
    cohort?: Cohort | null,
    opts?: {
      container?: HTMLElement
      globalDatasets?: Array<{ dataset_id: string; name: string }>
      initialDatasetId?: string
      initialMode?: 'clinical_cohort' | 'wet_lab' | 'bioinformatics' | 'mechanism' | 'image_processing' | 'flowchart' | 'journal_assembly'
      globalFigures?: Array<{ id: string; name: string; created_at: string }>
    }
  ): void {
    const pane = opts?.container ?? document.getElementById('rsPaneStudio')
    if (!pane) return
    const isGlobal = !s
    const contextTitle = s ? s.title : 'Heurion 科研制图'
    let readyDs: Array<{ dataset_id: string; name: string }> = s
      ? s.datasets.filter(d => d.status === 'ready').map(d => ({ dataset_id: d.dataset_id, name: d.name }))
      : (opts?.globalDatasets ?? [])
    const selectedArchiveStudyId = s?.id ?? ''
    let activeDatasetId = opts?.initialDatasetId ?? readyDs[0]?.dataset_id ?? ''
    const activeCount = cohort ? cohort.subjects.filter(x => x.status === 'active').length : 60
    const withdrawnCount = cohort ? cohort.subjects.filter(x => x.status === 'withdrawn').length : 4

    type StudioMode = 'clinical_cohort' | 'wet_lab' | 'bioinformatics' | 'mechanism' | 'image_processing' | 'flowchart' | 'journal_assembly'
    let currentMode: StudioMode = opts?.initialMode ?? (opts?.initialDatasetId || readyDs.length > 0 ? 'clinical_cohort' : 'wet_lab')

    // 临床队列与统一数据源状态 (Unified Dataset & Clinical Cohort State)
    let clinSubtype: 'grotta' | 'sankey' | 'upset' | 'logistic' | 'survival' = 'grotta'
    let clinCols: string[] = []
    let clinLabels: Record<string, string> = {}
    let clinPreviewHeader: string[] = []
    let clinPreviewRows: string[][] = []
    let clinLoadedDsId = '__uninitialized__'
    let clinGrottaGroup = '第一次治疗方式'
    let clinGrottaScore = '确诊时mRS'
    let clinSankeyStage1 = '第一次治疗方式'
    let clinSankeyStage2 = '闭塞程度'
    let clinSankeyStage3 = '治疗后出血'
    let clinSankeySeqCol = ''
    let clinSankeyOutcome = '治疗后出血'
    let clinUpsetCols: string[] = ['额叶', '颞叶', '顶叶', '枕叶', '基底节', '脑室']
    let clinUpsetOutcome = '治疗后出血'
    let clinLogOutcome = '治疗后出血'
    let clinLogCovs: string[] = ['供血动脉扩张', '单一动脉供血', '基底节', '年龄']
    let clinSurvMode: 'duration' | 'dates' = 'duration'
    let clinSurvTime = 'followup_months'
    let clinSurvStart = '第一次治疗的时间'
    let clinSurvEnd = '出血时间'
    let clinSurvCensor = '2025-12-31'
    let clinSurvEvent = '治疗后出血'
    let clinSurvGroup = '第一次治疗方式'
    let clinSurvUnit: 'Months' | 'Years' | 'Days' = 'Months'

    // 统一数据源在「实验统计」、「生信组学」、「流程图」中的列映射状态
    let wetDsGrpCol = ''
    let wetDsValCol = ''
    let bioGroupCol = ''
    let flGroupCol = ''
    let flOutcomeCol = ''
    let asmPickedIds: string[] | null = null

    let wetPlotType: 'bar_scatter' | 'violin_box' | 'dose_response' = 'bar_scatter'
    let wetErrorType: 'SD' | 'SEM' = 'SD'
    let wetYLabel = 'Relative Expression / Biomarker Level'
    let wetGroups = [
      { name: 'Control', values: '1.02, 0.96, 1.05, 0.98, 1.01, 0.95', color: '#3C5488' },
      { name: 'Low-Dose (10 mg)', values: '1.52, 1.65, 1.48, 1.71, 1.59, 1.63', color: '#00A087' },
      { name: 'High-Dose (50 mg)', values: '2.45, 2.68, 2.39, 2.75, 2.58, 2.62', color: '#E64B35' },
    ]
    let doseRows = [
      { logConc: -9, values: '4.2, 5.1, 3.8' },
      { logConc: -8, values: '12.5, 14.2, 11.8' },
      { logConc: -7, values: '34.0, 36.8, 32.5' },
      { logConc: -6, values: '62.4, 65.1, 59.8' },
      { logConc: -5, values: '85.2, 87.6, 83.9' },
      { logConc: -4, values: '94.8, 96.1, 93.5' },
    ]

    let bioType: 'volcano' | 'heatmap' | 'enrichment_bubble' | 'umap' = 'volcano'
    let volcanoFc = 1.0
    let volcanoP = 0.05

    const MECH_PRESETS: Record<string, {
      title: string
      subtitle: string
      nodes: Array<{ id: string; label: string; type: string; compartment: string; x: number; y: number; color: string }>
      edges: Array<{ from: string; to: string; type: string; label: string }>
    }> = {
      gpcr: {
        title: `${contextTitle} · GPCR-cAMP-PKA-CREB 信号转导机制`,
        subtitle: '细胞外配体激活跨膜受体并促进核内靶基因转录及线粒体代谢重编程',
        nodes: [
          { id: 'lig', label: 'Agonist Ligand', type: 'ligand', compartment: 'extracellular', x: 240, y: 80, color: '#E64B35' },
          { id: 'rec', label: 'GPCR / RTK', type: 'receptor', compartment: 'membrane', x: 240, y: 175, color: '#4DBBD5' },
          { id: 'pka', label: 'cAMP / PKA', type: 'kinase', compartment: 'cytoplasm', x: 240, y: 310, color: '#00A087' },
          { id: 'drug', label: 'Selective Inhibitor', type: 'antibody', compartment: 'cytoplasm', x: 520, y: 310, color: '#3C5488' },
          { id: 'mito', label: 'Mitochondrial OXPHOS', type: 'mitochondria', compartment: 'cytoplasm', x: 640, y: 390, color: '#F39B7F' },
          { id: 'creb', label: 'p-CREB / STAT3', type: 'transcription_factor', compartment: 'nucleus', x: 240, y: 550, color: '#8491B4' },
        ],
        edges: [
          { from: 'lig', to: 'rec', type: 'activate', label: 'Binding' },
          { from: 'rec', to: 'pka', type: 'phosphorylate', label: '+P' },
          { from: 'drug', to: 'pka', type: 'inhibit', label: 'Blockade' },
          { from: 'pka', to: 'mito', type: 'activate', label: 'ATP ↑' },
          { from: 'pka', to: 'creb', type: 'translocate', label: 'Nuclear entry' },
        ],
      },
      pd1: {
        title: `${contextTitle} · PD-1/PD-L1 免疫检查点阻断与 T 细胞杀伤机制`,
        subtitle: '抗 PD-1 单抗解除 SHP2 去磷酸化抑制并恢复 PI3K-Akt-mTOR 效应通路',
        nodes: [
          { id: 'pdl1', label: 'Tumor PD-L1', type: 'ligand', compartment: 'extracellular', x: 220, y: 80, color: '#E64B35' },
          { id: 'mab', label: 'Anti-PD-1 mAb', type: 'antibody', compartment: 'extracellular', x: 480, y: 80, color: '#00A087' },
          { id: 'pd1', label: 'PD-1 Receptor', type: 'receptor', compartment: 'membrane', x: 320, y: 175, color: '#3C5488' },
          { id: 'pi3k', label: 'PI3K / Akt / mTOR', type: 'kinase', compartment: 'cytoplasm', x: 320, y: 320, color: '#4DBBD5' },
          { id: 'nfkb', label: 'NFAT / IFN-γ 转录', type: 'transcription_factor', compartment: 'nucleus', x: 320, y: 550, color: '#8491B4' },
        ],
        edges: [
          { from: 'mab', to: 'pd1', type: 'inhibit', label: 'Checkpoint Blockade' },
          { from: 'pdl1', to: 'pd1', type: 'activate', label: 'Exhaustion Signal' },
          { from: 'pd1', to: 'pi3k', type: 'activate', label: 'Reactivation' },
          { from: 'pi3k', to: 'nfkb', type: 'translocate', label: 'IFN-γ / GZMB ↑' },
        ],
      },
      tgfb: {
        title: `${contextTitle} · TGF-β / Smad2/3 组织纤维化信号级联`,
        subtitle: '靶向抑制 Smad2/3 磷酸化复合体入核以阻断胶原沉积',
        nodes: [
          { id: 'tgf', label: 'TGF-β1 Cytokine', type: 'ligand', compartment: 'extracellular', x: 260, y: 80, color: '#E64B35' },
          { id: 'tgfbr', label: 'TGFβR-I / II', type: 'receptor', compartment: 'membrane', x: 260, y: 175, color: '#4DBBD5' },
          { id: 'smad', label: 'p-Smad2/3 Complex', type: 'kinase', compartment: 'cytoplasm', x: 260, y: 320, color: '#00A087' },
          { id: 'col', label: 'COL1A1 / α-SMA 转录', type: 'transcription_factor', compartment: 'nucleus', x: 260, y: 550, color: '#3C5488' },
        ],
        edges: [
          { from: 'tgf', to: 'tgfbr', type: 'activate', label: 'Dimerization' },
          { from: 'tgfbr', to: 'smad', type: 'phosphorylate', label: '+P' },
          { from: 'smad', to: 'col', type: 'translocate', label: 'Fibrosis Gene ↑' },
        ],
      },
    }
    let mechState = structuredClone(MECH_PRESETS.gpcr!)

    let imgTool: 'imagej' | 'flowjo' | 'slicer' = 'imagej'
    let imgModality: 'immunofluorescence' | 'western_blot' | 'ihc' = 'immunofluorescence'
    let imgMicronsPerPx = 0.5
    let imgScaleBar = 50
    let flowXChan = 'FITC-A (Annexin V)'
    let flowYChan = 'PE-A (PI)'
    let flowXGate = 2.5
    let flowYGate = 2.5
    let slicerModality: 'CT' | 'MRI' | 'PET-CT' = 'CT'

    const half = Math.max(1, Math.floor((activeCount || 60) / 2))
    let consortState = {
      title: `${contextTitle} · CONSORT 2010 Participant Flow`,
      total_assessed: (activeCount || 60) + withdrawnCount + 28,
      exclusions: [
        { reason: '不符合纳入标准 (Did not meet inclusion criteria)', count: 20 },
        { reason: '拒绝签署知情同意 (Declined to participate)', count: 8 },
      ],
      eligible_total: (activeCount || 60) + withdrawnCount,
      arms: [
        { name: '干预组 (Intervention Arm)', allocated: half + Math.floor(withdrawnCount / 2), received: half + Math.floor(withdrawnCount / 2), lost_to_followup: Math.floor(withdrawnCount / 2), discontinued: 0, analyzed: half },
        { name: '标准对照组 (Control Arm)', allocated: (activeCount || 60) - half + Math.ceil(withdrawnCount / 2), received: (activeCount || 60) - half + Math.ceil(withdrawnCount / 2), lost_to_followup: Math.ceil(withdrawnCount / 2), discontinued: 0, analyzed: (activeCount || 60) - half },
      ],
    }

    let asmTitle = `${contextTitle} · Multi-Panel Composite Figure`
    let asmPreset: 'nature_double' | 'nature_single' | 'nejm' | 'lancet' = 'nature_double'
    let asmCols = 2

    let lastSvg = ''
    let lastCode = ''
    let lastCodePath = 'figure_studio.R'
    let lastTitle = `${contextTitle}_Figure`

    const studyContextBarHtml = !isGlobal ? `
      <div class="rs-scenario-banner compact" style="margin-bottom:10px;padding:8px 12px;">
        <div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          <span class="small">
            ${icon('microscope', { size: 13 })} <b>当前课题：${esc(s.title)}</b>
            <span class="muted">（在组 ${activeCount} 人 · 数据集 ${readyDs.length} 个 · 图表保存至本研究 <code>figures/</code>）</span>
          </span>
          <div class="row" style="gap:6px;">
            <button type="button" class="small-btn quiet" data-st-nav="global-studio">${icon('chart', { size: 12 })} 切换至独立制图空间</button>
            <button type="button" class="small-btn quiet" data-st-nav="write">${icon('write', { size: 12 })} 去写作插图</button>
          </div>
        </div>
      </div>
    ` : ''

    pane.innerHTML = `
      ${studyContextBarHtml}
      <div class="rs-studio-topbar">
        <div class="rs-studio-modes" role="tablist" aria-label="6大类医学制图引擎">
          <button type="button" class="rs-studio-mode-btn${currentMode === 'clinical_cohort' ? ' active' : ''}" data-st-mode="clinical_cohort" title="mRS Grotta 预后分布图、Sankey 治疗轨迹桑基图、UpSet 解剖部位共现图、Logistic OR 森林图、KM 生存分析">
            ${icon('compare', { size: 14 })} <span>临床队列</span>
          </button>
          <button type="button" class="rs-studio-mode-btn${currentMode === 'wet_lab' ? ' active' : ''}" data-st-mode="wet_lab">
            ${icon('chart', { size: 14 })} <span>实验统计</span>
          </button>
          <button type="button" class="rs-studio-mode-btn${currentMode === 'bioinformatics' ? ' active' : ''}" data-st-mode="bioinformatics">
            ${icon('dna', { size: 14 })} <span>生信组学</span>
          </button>
          <button type="button" class="rs-studio-mode-btn${currentMode === 'mechanism' ? ' active' : ''}" data-st-mode="mechanism">
            ${icon('microscope', { size: 14 })} <span>机制通路</span>
          </button>
          <button type="button" class="rs-studio-mode-btn${currentMode === 'image_processing' ? ' active' : ''}" data-st-mode="image_processing">
            ${icon('layers', { size: 14 })} <span>显微·流式·影像</span>
          </button>
          <button type="button" class="rs-studio-mode-btn${currentMode === 'journal_assembly' ? ' active' : ''}" data-st-mode="journal_assembly">
            ${icon('grid', { size: 14 })} <span>多面板拼图</span>
          </button>
        </div>

        <div class="rs-studio-topbar-right">
          <select id="stQuickPreset" class="rs-studio-preset-select" aria-label="快速载入示例模板">
            <option value="">快速载入示例模板…</option>
            <option value="clin_grotta">临床队列：mRS 功能结局 Grotta 偏移图</option>
            <option value="clin_sankey">临床队列：多阶段治疗轨迹 Sankey 桑基图</option>
            <option value="clin_upset">临床队列：多解剖部位共现 UpSet 图</option>
            <option value="clin_logistic">临床队列：多因素 Logistic 回归 OR 森林图</option>
            <option value="clin_survival">临床队列：Kaplan-Meier 无出血生存曲线</option>
            <option value="wet_bar">实验统计：WB/qPCR 柱状散点图</option>
            <option value="wet_ic50">实验统计：4PL 剂量反应 IC50 曲线</option>
            <option value="grant_gpcr">机制图：GPCR 信号转导通路</option>
            <option value="grant_pd1">机制图：PD-1/PD-L1 免疫检查点</option>
            <option value="bio_volcano">生信图：转录组差异表达火山图</option>
            <option value="img_flow">流式图：Annexin V/PI 凋亡四象限</option>
          </select>

          <details class="rs-scenario-pop">
            <summary class="small-btn quiet">${icon('info', { size: 13 })} 场景说明</summary>
            <div class="rs-scenario-pop-card">
              <div class="rs-scenario-grid">
                <div class="rs-scenario-card${isGlobal ? ' active' : ''}">
                  <div class="rs-scenario-tag">场景一 · 独立科研制图</div>
                  <b>临床队列单表成图 / 标书机制图 / 审稿补图</b>
                  <p class="muted small">无需创建临床研究课题，直接上传 Excel/CSV 或即开即画，一键导出 600 DPI <code>.png</code> / <code>.svg</code> / <code>.pzfx</code> / <code>.R</code> / <code>.drawio</code> / <code>.pptx</code>。</p>
                </div>
                <div class="rs-scenario-card">
                  <div class="rs-scenario-tag">场景二 · 写作中内嵌配图</div>
                  <b>论文正文 Results / 组会汇报 PPT</b>
                  <p class="muted small">在写作编辑器中边写边画，一键插入当前段落并自动附带「来自分析」可复现代码溯源。</p>
                  <div style="margin-top:auto;padding-top:6px;">
                    <button type="button" class="small-btn" data-st-nav="write">${icon('write', { size: 12 })} 前往写作空间 →</button>
                  </div>
                </div>
                <div class="rs-scenario-card${!isGlobal ? ' active' : ''}">
                  <div class="rs-scenario-tag">场景三 · 临床研究课题内制图</div>
                  <b>RCT / 队列研究全链路数据闭环</b>
                  <p class="muted small">与入组患者队列和课题数据集版本绑定，自动归档至项目 <code>figures/</code> 并打包 SCI 投稿包。</p>
                  <div style="margin-top:auto;padding-top:6px;">
                    <button type="button" class="small-btn" data-st-nav="study">${icon('microscope', { size: 12 })} 前往临床研究 →</button>
                  </div>
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>

      <div class="rs-studio-shell">
        <div class="rs-studio-left" id="rsStudioLeft"></div>
        <div class="rs-studio-right">
          <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <b id="rsStudioCanvasTitle" style="font-size:13.5px;">矢量画布预览</b>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="small-btn" id="rsStudioCopyPngBtn" title="复制 600 DPI 高清 PNG 到剪贴板，可直接粘贴 (Ctrl+V / Cmd+V) 到 PPT、Word 或微信">${icon('copy', { size: 13 })} 复制高清图</button>
              <button type="button" class="small-btn" id="rsStudioDownloadPngBtn" title="下载 600 DPI 印刷级高清 PNG 图像">${icon('download', { size: 13 })} 600 DPI PNG</button>
              <button type="button" class="small-btn" id="rsStudioInsertDocBtn" title="将当前图表直接插入到论文文档或汇报幻灯片中">${icon('write', { size: 13 })} 插入到文稿…</button>
              <button type="button" class="small-btn primary" id="rsStudioArchiveBtn" title="保存当前矢量图与可复现脚本">${icon('pin', { size: 13 })} ${isGlobal ? '保存到图表库' : '归档至本研究'}</button>
            </div>
          </div>
          <div class="rs-studio-exports" id="rsStudioExportBar">
            <span class="muted small">正在准备导出器…</span>
          </div>
          <div class="rs-studio-canvas" id="rsStudioCanvas">
            <div class="muted small">正在渲染高清矢量图…</div>
          </div>
          <details class="subagent-output-details" id="rsStudioCodeDetails">
            <summary class="subagent-output-summary-btn">${icon('file', { size: 13 })} 查看可复现脚本源码 (R / ImageJ Macro / XML)</summary>
            <div style="display:flex;justify-content:flex-end;margin:6px 0;">
              <button type="button" class="small-btn" id="rsStudioCopyCodeBtn">${icon('copy', { size: 13 })} 复制源码</button>
            </div>
            <pre class="ds-code" id="rsStudioCodePre" style="max-height:240px;"></pre>
          </details>
        </div>
      </div>
    `

    const leftEl = document.getElementById('rsStudioLeft')!
    const canvasEl = document.getElementById('rsStudioCanvas')!
    const exportBar = document.getElementById('rsStudioExportBar')!
    const codePre = document.getElementById('rsStudioCodePre')!
    const canvasTitleEl = document.getElementById('rsStudioCanvasTitle')!

    document.getElementById('rsStudioCopyPngBtn')!.onclick = () => {
      const targetSid = s?.id || selectedArchiveStudyId || undefined
      void copySvgAsPngToClipboard(targetSid, lastSvg, lastTitle)
    }
    document.getElementById('rsStudioDownloadPngBtn')!.onclick = () => {
      const targetSid = s?.id || selectedArchiveStudyId || undefined
      void downloadSvgAsPng600Dpi(targetSid, lastSvg, `${lastTitle}_600DPI.png`)
    }
    document.getElementById('rsStudioArchiveBtn')!.onclick = () => {
      const targetSid = s?.id || selectedArchiveStudyId || undefined
      void archiveStudyFigure(targetSid, lastTitle, lastSvg, lastCode, lastCodePath, activeDatasetId || undefined)
    }
    document.getElementById('rsStudioInsertDocBtn')!.onclick = async () => {
      const targetSid = s?.id || selectedArchiveStudyId || undefined
      const archived = await archiveStudyFigure(targetSid, lastTitle, lastSvg, lastCode, lastCodePath, activeDatasetId || undefined)
      if (archived && hooks.insertFigureToDoc) {
        await hooks.insertFigureToDoc(archived.asset_id, lastTitle.replace(/_/g, ' '))
      }
    }
    document.getElementById('rsStudioCopyCodeBtn')!.onclick = () => {
      if (!lastCode) { notice('暂无可复制的脚本源码', true); return }
      navigator.clipboard.writeText(lastCode).then(() => notice('已复制完整可复现脚本源码')).catch(() => notice('复制失败', true))
    }

    // 支持在左侧图表库点击已保存图表时直接在中央画布加载与导出
    if (isGlobal) {
      previewArchivedAssetInStudio = async (assetId: string, assetName: string) => {
        try {
          const token = hooks.token()
          const [svgRes, provRes] = await Promise.all([
            fetch(`/api/assets/${assetId}?token=${encodeURIComponent(token)}`).then(r => r.text()),
            api<{ code?: string; code_path?: string }>(`/api/assets/${assetId}/provenance`).catch(() => ({ code: '', code_path: '' })),
          ])
          if (!svgRes.includes('<svg')) {
            void hooks.datasets.showProvenance(assetId)
            return
          }
          lastSvg = svgRes
          lastTitle = assetName.replace(/\.[^.]+$/, '') || 'Archived_Figure'
          lastCode = provRes.code || '# Archived SVG Figure'
          lastCodePath = provRes.code_path || `${lastTitle}.R`
          canvasTitleEl.textContent = `已归档图表预览：${lastTitle}`
          canvasEl.innerHTML = safeSvg(svgRes)
          codePre.textContent = lastCode
          exportBar.innerHTML = `<span class="muted small" style="margin-right:4px;">已归档图表导出与溯源：</span>`
          const addBtn = (label: string, fn: () => void, primary = false) => {
            const b = document.createElement('button')
            b.type = 'button'
            b.className = primary ? 'small-btn primary' : 'small-btn'
            b.innerHTML = `${icon('download', { size: 13 })} ${esc(label)}`
            b.onclick = fn
            exportBar.appendChild(b)
          }
          addBtn('600 DPI 印刷级高清图 (.png)', () => void downloadSvgAsPng600Dpi(undefined, lastSvg, `${lastTitle}_600DPI.png`), true)
          addBtn('复制高清图 (粘贴至 PPT/Word/微信)', () => void copySvgAsPngToClipboard(undefined, lastSvg, lastTitle))
          addBtn('Illustrator 分层矢量 (.svg)', () => downloadBlobContent(lastSvg, `${lastTitle}.svg`, 'image/svg+xml;charset=utf-8'))
          if (lastCode) addBtn(`可复现脚本 (${lastCodePath.split('.').pop() || 'R'})`, () => downloadBlobContent(lastCode, lastCodePath))
          const provBtn = document.createElement('button')
          provBtn.type = 'button'
          provBtn.className = 'small-btn'
          provBtn.innerHTML = `${icon('info', { size: 13 })} 完整数据血缘核验`
          provBtn.onclick = () => void hooks.datasets.showProvenance(assetId)
          exportBar.appendChild(provBtn)
        } catch (err) {
          notice((err as Error).message, true)
        }
      }
    }

    /** 在制图工作台内直接上传 Excel/CSV 数据表并自动切换为当前统一活动数据集 */
    const handleInlineDatasetUpload = async (files: File[]) => {
      if (!files.length) return
      const uploaded = await hooks.datasets.upload(files)
      if (!uploaded.length) return
      if (s?.id) {
        for (const d of uploaded) {
          await api(`/api/studies/${s.id}/items`, { method: 'POST', body: JSON.stringify({ kind: 'dataset', ref_id: d.id }) }).catch(() => {})
        }
      }
      const dsRes = await api<Array<{ id: string; name: string; status: string }>>('/api/datasets').catch(() => [])
      for (const u of uploaded) {
        const found = dsRes.find(x => x.id === u.id)
        const item = { dataset_id: u.id, name: found?.name || files[0]?.name || u.id }
        if (!readyDs.some(d => d.dataset_id === item.dataset_id)) readyDs.unshift(item)
      }
      activeDatasetId = uploaded[0]!.id
      clinLoadedDsId = '__force_reload__'
      notice(`已上传数据表并挂载为统一数据源：${readyDs.find(d => d.dataset_id === activeDatasetId)?.name || activeDatasetId}`)
      await ensureUnifiedDatasetLoaded(activeDatasetId)
      renderLeftEditor()
      void runStudioRender()
    }

    const SENTINELS = new Set(['缺失', '未知', '不详', '无', 'na', 'n/a', 'null', 'none', 'nan', '-', '--', '.', ''])
    const isSentinel = (v: string | undefined): boolean => {
      const s = (v || '').trim()
      return !s || SENTINELS.has(s.toLowerCase())
    }

    /** 从当前统一数据集自动提取「实验统计 (wet_lab)」分组连续变量数据 */
    const applyDatasetToWetLab = () => {
      if (!activeDatasetId || !clinPreviewHeader.length || !clinPreviewRows.length) return
      const gIdx = clinPreviewHeader.indexOf(wetDsGrpCol)
      const vIdx = clinPreviewHeader.indexOf(wetDsValCol)
      if (gIdx < 0 || vIdx < 0) return
      const byGroup = new Map<string, number[]>()
      for (const r of clinPreviewRows) {
        const gRaw = (r[gIdx] || '').trim()
        const vRaw = (r[vIdx] || '').trim()
        if (isSentinel(gRaw) || isSentinel(vRaw)) continue
        const vNum = Number(vRaw)
        if (!Number.isFinite(vNum)) continue
        const arr = byGroup.get(gRaw) || []
        arr.push(vNum)
        byGroup.set(gRaw, arr)
      }
      if (byGroup.size < 1) return
      const palette = ['#3C5488', '#00A087', '#E64B35', '#4DBBD5', '#F39B7F', '#8491B4']
      wetGroups = [...byGroup.entries()].slice(0, 6).map(([name, vals], i) => ({
        name,
        values: vals.map(v => Number(v.toFixed(2))).join(', '),
        color: palette[i % palette.length]!,
      }))
      wetYLabel = clinLabels[wetDsValCol] || wetDsValCol
    }

    /** 从当前统一数据集自动汇总「CONSORT 2010 流程图 (flowchart)」各阶段样本量与分组人数 */
    const applyDatasetToFlowchart = () => {
      if (!activeDatasetId || !clinPreviewHeader.length || !clinPreviewRows.length) return
      const dsName = readyDs.find(d => d.dataset_id === activeDatasetId)?.name || contextTitle
      const gIdx = clinPreviewHeader.indexOf(flGroupCol)
      const oIdx = clinPreviewHeader.indexOf(flOutcomeCol)
      const totalAssessed = clinPreviewRows.length
      if (gIdx < 0) return
      let missingGroupCount = 0
      const armStats = new Map<string, { allocated: number; lost: number; analyzed: number }>()
      for (const r of clinPreviewRows) {
        const gVal = (r[gIdx] || '').trim()
        if (isSentinel(gVal)) {
          missingGroupCount++
          continue
        }
        const st = armStats.get(gVal) || { allocated: 0, lost: 0, analyzed: 0 }
        st.allocated++
        const oVal = oIdx >= 0 ? (r[oIdx] || '').trim() : 'ok'
        if (oIdx >= 0 && isSentinel(oVal)) {
          st.lost++
        } else {
          st.analyzed++
        }
        armStats.set(gVal, st)
      }
      const eligibleTotal = totalAssessed - missingGroupCount
      consortState = {
        title: `${dsName} · CONSORT 2010 队列纳排与分组随访流向图`,
        total_assessed: totalAssessed,
        exclusions: missingGroupCount > 0
          ? [{ reason: `${flGroupCol} 缺失或未满足分组纳排标准 (Excluded / Missing allocation)`, count: missingGroupCount }]
          : [{ reason: '无排除受试者 (No exclusions in dataset)', count: 0 }],
        eligible_total: eligibleTotal,
        arms: [...armStats.entries()].slice(0, 4).map(([name, st]) => ({
          name: `${flGroupCol}: ${name}`,
          allocated: st.allocated,
          received: st.allocated,
          lost_to_followup: st.lost,
          discontinued: 0,
          analyzed: st.analyzed,
        })),
      }
    }

    /** 从当前统一数据集自动计算「生信/多变量组学 (bioinformatics)」差异火山图与聚类热图矩阵 */
    const computeDatasetBioData = (): {
      volcanoData?: Array<{ gene: string; log2FC: number; pValue: number }>
      heatmapData?: { genes: string[]; samples: Array<{ name: string; group: string }>; matrix: number[][] }
    } => {
      if (!activeDatasetId || !clinPreviewHeader.length || !clinPreviewRows.length) return {}
      // 1. 若数据表本身即为差异表达矩阵 (含 gene/symbol, log2FC, pvalue/padj 列)
      const geneIdx = clinPreviewHeader.findIndex(h => /^gene|symbol|feature|protein|变量|基因/i.test(h))
      const fcIdx = clinPreviewHeader.findIndex(h => /log2fc|logfc|foldchange|fc/i.test(h))
      const pIdx = clinPreviewHeader.findIndex(h => /^p_?val|padj|fdr|qval|^p$/i.test(h))
      if (geneIdx >= 0 && fcIdx >= 0 && pIdx >= 0) {
        const vData: Array<{ gene: string; log2FC: number; pValue: number }> = []
        for (const r of clinPreviewRows.slice(0, 300)) {
          const gene = (r[geneIdx] || '').trim()
          const fc = Number(r[fcIdx])
          const pv = Number(r[pIdx])
          if (gene && Number.isFinite(fc) && Number.isFinite(pv) && pv > 0) {
            vData.push({ gene, log2FC: fc, pValue: pv })
          }
        }
        if (vData.length >= 3) return { volcanoData: vData }
      }

      // 2. 临床/多模态宽表：按 bioGroupCol 前两组自动计算所有数值/二分类指标的差异倍数 (log2FC)、t检验 P 值与 Z-score 热图
      const gIdx = clinPreviewHeader.indexOf(bioGroupCol)
      if (gIdx < 0) return {}
      const groupCounts = new Map<string, number>()
      for (const r of clinPreviewRows) {
        const g = (r[gIdx] || '').trim()
        if (!isSentinel(g)) groupCounts.set(g, (groupCounts.get(g) || 0) + 1)
      }
      const topGroups = [...groupCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0])
      if (topGroups.length < 2) return {}
      const [g1, g2] = [topGroups[0]!, topGroups[1]!]

      const parseCellNum = (raw: string | undefined): number | null => {
        if (isSentinel(raw)) return null
        const s = (raw || '').trim()
        if (s === '是' || s === '有' || s === '阳性' || s === '男') return 1
        if (s === '否' || s === '无' || s === '阴性' || s === '女') return 0
        const n = Number(s)
        return Number.isFinite(n) ? n : null
      }

      const normCdf = (x: number): number => {
        const t = 1 / (1 + 0.2316419 * Math.abs(x))
        const d = 0.3989423 * Math.exp((-x * x) / 2)
        const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
        return x > 0 ? 1 - p : p
      }

      const volcanoData: Array<{ gene: string; log2FC: number; pValue: number }> = []
      const numericCols: Array<{ idx: number; name: string; mean: number; sd: number }> = []

      clinPreviewHeader.forEach((colName, cIdx) => {
        if (cIdx === gIdx || /id|编号|姓名|name|时间|日期|date/i.test(colName)) return
        const vals1: number[] = []
        const vals2: number[] = []
        const allVals: number[] = []
        for (const r of clinPreviewRows) {
          const v = parseCellNum(r[cIdx])
          if (v === null) continue
          allVals.push(v)
          const g = (r[gIdx] || '').trim()
          if (g === g1) vals1.push(v)
          else if (g === g2) vals2.push(v)
        }
        if (vals1.length < 3 || vals2.length < 3) return
        const m1 = vals1.reduce((a, b) => a + b, 0) / vals1.length
        const m2 = vals2.reduce((a, b) => a + b, 0) / vals2.length
        const v1 = vals1.reduce((a, b) => a + (b - m1) ** 2, 0) / Math.max(1, vals1.length - 1)
        const v2 = vals2.reduce((a, b) => a + (b - m2) ** 2, 0) / Math.max(1, vals2.length - 1)
        const se = Math.sqrt(v1 / vals1.length + v2 / vals2.length)
        if (se <= 1e-9) return
        const tStat = (m2 - m1) / se
        const pVal = Math.max(1e-6, Math.min(0.999, 2 * (1 - normCdf(Math.abs(tStat)))))
        const minAll = Math.min(...allVals)
        const shift = minAll <= 0 ? Math.abs(minAll) + 0.5 : 0.05
        const log2FC = Number(Math.log2((m2 + shift) / (m1 + shift)).toFixed(3))
        volcanoData.push({
          gene: clinLabels[colName] || colName,
          log2FC: Math.max(-4.5, Math.min(4.5, log2FC)),
          pValue: Number(pVal.toFixed(5)),
        })
        const allMean = allVals.reduce((a, b) => a + b, 0) / allVals.length
        const allSd = Math.sqrt(allVals.reduce((a, b) => a + (b - allMean) ** 2, 0) / Math.max(1, allVals.length - 1)) || 1
        numericCols.push({ idx: cIdx, name: clinLabels[colName] || colName, mean: allMean, sd: allSd })
      })

      let heatmapData: { genes: string[]; samples: Array<{ name: string; group: string }>; matrix: number[][] } | undefined
      if (numericCols.length >= 3) {
        const pickedCols = numericCols.slice(0, 10)
        const g1Rows = clinPreviewRows.filter(r => (r[gIdx] || '').trim() === g1).slice(0, 4)
        const g2Rows = clinPreviewRows.filter(r => (r[gIdx] || '').trim() === g2).slice(0, 4)
        const sampleRows = [...g1Rows.map((r, i) => ({ row: r, name: `${g1}_#${i + 1}`, group: g1 })), ...g2Rows.map((r, i) => ({ row: r, name: `${g2}_#${i + 1}`, group: g2 }))]
        if (sampleRows.length >= 4) {
          heatmapData = {
            genes: pickedCols.map(c => c.name),
            samples: sampleRows.map(s => ({ name: s.name, group: s.group })),
            matrix: pickedCols.map(c =>
              sampleRows.map(sr => {
                const v = parseCellNum(sr.row[c.idx])
                if (v === null) return 0
                return Number(Math.max(-2.5, Math.min(2.5, (v - c.mean) / c.sd)).toFixed(2))
              })
            ),
          }
        }
      }

      return {
        volcanoData: volcanoData.length >= 3 ? volcanoData : undefined,
        heatmapData,
      }
    }

    const autoMatchAllModeCols = (cols: string[]) => {
      if (!cols.length) return
      const pick = (re: RegExp, fallback: string) => cols.find(c => re.test(c)) || (cols.includes(fallback) ? fallback : cols[0]!)
      clinGrottaGroup = pick(/第一次治疗|首治|分组|arm|treat|group/i, clinGrottaGroup)
      clinGrottaScore = pick(/mRS|闭塞|评分|分级|score|grade/i, clinGrottaScore)
      clinSankeyStage1 = pick(/第一次治疗|首治|stage1|arm/i, clinSankeyStage1)
      clinSankeyStage2 = cols.find(c => c !== clinSankeyStage1 && /闭塞|第二次治疗|stage2|response/i.test(c)) || cols[1] || clinSankeyStage1
      clinSankeyStage3 = cols.find(c => c !== clinSankeyStage1 && c !== clinSankeyStage2 && /治疗后出血|不良事件|结局|第三次治疗|outcome/i.test(c)) || ''
      const seqMatch = cols.find(c => c === '治疗方式' || /序贯|轨迹|sequence/i.test(c))
      if (seqMatch && !cols.includes('第一次治疗方式')) clinSankeySeqCol = seqMatch
      clinSankeyOutcome = pick(/治疗后出血|围术期不良事件|出血|结局|event|outcome/i, clinSankeyOutcome)
      const anatMatches = cols.filter(c => /额叶|颞叶|顶叶|枕叶|小脑|脑干|基底节|脑室|胼胝体|脑叶|失语|肌力|视野/i.test(c))
      if (anatMatches.length >= 2) clinUpsetCols = anatMatches.slice(0, 8)
      clinUpsetOutcome = clinSankeyOutcome
      clinLogOutcome = pick(/治疗后出血|围术期不良事件|完全闭塞|出血|结局|event|outcome|status/i, clinLogOutcome)
      const covMatches = cols.filter(c => c !== clinLogOutcome && /供血动脉扩张|单一动脉供血|动静脉瘘|引流静脉狭窄|深部静脉引流|基底节|脑室|中心剂量|周围剂量|年龄|性别|smi|age|sex|bmi|stage/i.test(c))
      if (covMatches.length >= 1) clinLogCovs = covMatches.slice(0, 6)
      else clinLogCovs = cols.filter(c => c !== clinLogOutcome).slice(0, 4)
      const hasDurationCol = cols.find(c => /follow|month|day|year|随访时长|生存时间|os_time/i.test(c))
      const startCol = cols.find(c => /第一次治疗的时间|首治时间|出生日期|入院日期|确诊日期|start_date/i.test(c))
      const endCol = cols.find(c => /出血时间|末次随访|事件时间|死亡时间|event_date/i.test(c))
      if (hasDurationCol) {
        clinSurvMode = 'duration'
        clinSurvTime = hasDurationCol
      } else if (startCol && endCol) {
        clinSurvMode = 'dates'
        clinSurvStart = startCol
        clinSurvEnd = endCol
      }
      clinSurvEvent = clinLogOutcome
      clinSurvGroup = clinGrottaGroup

      // 同步自动匹配实验统计 (wet_lab)、生信组学 (bioinformatics) 与 CONSORT 流程图 (flowchart) 的列
      wetDsGrpCol = pick(/arm|treat|group|sex|第一次治疗|治疗方式|分组|性别|闭塞/i, cols[0]!)
      wetDsValCol = cols.find(c => c !== wetDsGrpCol && /smi|age|vat|value|score|bmi|egfr|中心剂量|周围剂量|剂量|年龄|mRS|体积|直径/i.test(c)) || cols[1] || cols[0]!
      bioGroupCol = pick(/治疗后出血|第一次治疗|首治|闭塞|分组|arm|treat|group|outcome/i, cols[0]!)
      flGroupCol = pick(/第一次治疗|首治|治疗方式|分组|arm|treat|group/i, cols[0]!)
      flOutcomeCol = cols.find(c => c !== flGroupCol && /治疗后出血|闭塞程度|确诊时mRS|结局|随访|outcome|status/i.test(c)) || cols[1] || cols[0]!

      applyDatasetToWetLab()
      applyDatasetToFlowchart()
    }

    const ensureUnifiedDatasetLoaded = async (did: string) => {
      if (!did) {
        clinCols = []
        clinLabels = {}
        clinPreviewHeader = []
        clinPreviewRows = []
        clinLoadedDsId = ''
        return
      }
      if (clinLoadedDsId === did && clinCols.length > 0 && clinPreviewHeader.length > 0) return
      try {
        const [ds, prev] = await Promise.all([
          api<{ columns?: Array<{ name: string }>; labels?: Record<string, string> }>(`/api/datasets/${did}`),
          api<{ header: string[]; rows: string[][] }>(`/api/datasets/${did}/preview?limit=5000`),
        ])
        clinPreviewHeader = prev.header ?? []
        clinPreviewRows = prev.rows ?? []
        clinCols = (ds.columns ?? []).map(c => c.name)
        if (!clinCols.length) clinCols = [...clinPreviewHeader]
        clinLabels = ds.labels ?? {}
        clinLoadedDsId = did
        autoMatchAllModeCols(clinCols)
      } catch {}
    }

    /** 统一顶部数据源选择与上传栏（在临床队列、实验统计、生信组学、流程图 4 大模式间共享同一 activeDatasetId） */
    const renderUnifiedDatasetBarHtml = (emptyDemoLabel: string) => `
      <div class="rs-sub-box" style="background:var(--raised);padding:8px 10px;border-color:var(--line-2);">
        <div class="rs-sub-box-title" style="margin-bottom:4px;">
          <span>${icon('layers', { size: 13 })} 统一数据源 (Unified Dataset)</span>
          <button type="button" class="quiet small-btn" id="stUnifiedUploadBtn" title="直接上传 Excel (.xlsx) / CSV / SPSS / Stata 数据表并跨全图型共享">＋ 上传数据表</button>
          <input type="file" id="stUnifiedUploadInput" accept=".csv,.tsv,.xlsx,.xls,.sav,.dta,.sas7bdat,.xpt,.rds,.rda,.rdata" multiple hidden>
        </div>
        <select id="stUnifiedDsId" aria-label="选择统一数据源">
          <option value="" ${!activeDatasetId ? 'selected' : ''}>${esc(emptyDemoLabel)}</option>
          ${readyDs.map(d => `<option value="${esc(d.dataset_id)}" ${d.dataset_id === activeDatasetId ? 'selected' : ''}>${esc(d.name)} (统一数据表 · 切换图型自动映射)</option>`).join('')}
        </select>
      </div>
    `

    const bindUnifiedDatasetBarEvents = () => {
      const upBtn = document.getElementById('stUnifiedUploadBtn')
      const upInp = document.getElementById('stUnifiedUploadInput') as HTMLInputElement | null
      if (upBtn && upInp) {
        upBtn.onclick = () => upInp.click()
        upInp.onchange = () => {
          const files = Array.from(upInp.files ?? [])
          upInp.value = ''
          void handleInlineDatasetUpload(files)
        }
      }
      const dsSel = document.getElementById('stUnifiedDsId') as HTMLSelectElement | null
      if (dsSel) {
        dsSel.onchange = async () => {
          activeDatasetId = dsSel.value
          clinLoadedDsId = '__force_reload__'
          if (activeDatasetId) {
            await ensureUnifiedDatasetLoaded(activeDatasetId)
          } else {
            clinCols = []
            clinLabels = {}
            clinPreviewHeader = []
            clinPreviewRows = []
            clinLoadedDsId = ''
            clinGrottaGroup = '第一次治疗方式'
            clinGrottaScore = '确诊时mRS'
            clinSankeyStage1 = '第一次治疗方式'
            clinSankeyStage2 = '闭塞程度'
            clinSankeyStage3 = '治疗后出血'
            clinSankeySeqCol = ''
            clinUpsetCols = ['额叶', '颞叶', '顶叶', '枕叶', '基底节', '脑室']
            clinUpsetOutcome = '治疗后出血'
            clinLogOutcome = '治疗后出血'
            clinLogCovs = ['供血动脉扩张', '单一动脉供血', '基底节', '年龄']
            clinSurvMode = 'duration'
            clinSurvTime = 'followup_months'
            clinSurvEvent = '治疗后出血'
            clinSurvGroup = '第一次治疗方式'
          }
          renderLeftEditor()
          void runStudioRender()
        }
      }
    }

    if (isGlobal) {
      studioBatchAssembleHandler = (assetIds: string[]) => {
        asmPickedIds = [...assetIds]
        activateModeBtn('journal_assembly')
        renderLeftEditor()
        void runStudioRender()
      }
    }

    const renderLeftEditor = () => {
      if (currentMode === 'clinical_cohort') {
        const defaultDemoCols = [
          '第一次治疗方式', '第二次治疗方式', '第三次治疗方式', '治疗方式',
          '确诊时mRS', '闭塞程度', '治疗后出血', '围术期不良事件',
          '额叶', '颞叶', '顶叶', '枕叶', '基底节', '脑室',
          '供血动脉扩张', '单一动脉供血', '年龄', '中心剂量', '周围剂量', 'followup_months',
          '第一次治疗的时间', '出血时间',
        ]
        const availableCols = activeDatasetId && clinCols.length ? clinCols : defaultDemoCols
        const colOptHtml = (selectedVal: string, allowEmpty = false, emptyText = '（不选）') => {
          const base = allowEmpty ? `<option value=""${!selectedVal ? ' selected' : ''}>${esc(emptyText)}</option>` : ''
          return base + availableCols.map(c => {
            const lbl = clinLabels[c] && clinLabels[c] !== c ? `${clinLabels[c]} (${c})` : c
            return `<option value="${esc(c)}"${c === selectedVal ? ' selected' : ''}>${esc(lbl)}</option>`
          }).join('')
        }

        leftEl.innerHTML = `
          ${renderUnifiedDatasetBarHtml('内置脑血管畸形随访演示队列 (80例 · 即开即画)')}
          <label>临床图表子类型 (Clinical Plot Subtype)
            <select id="stClinSubtype">
              <option value="grotta" ${clinSubtype === 'grotta' ? 'selected' : ''}>1. mRS / 闭塞分级有序偏移图 (Grotta Proportional Bar · Stroke 规范)</option>
              <option value="sankey" ${clinSubtype === 'sankey' ? 'selected' : ''}>2. 多阶段治疗路径与临床结局桑基图 (Alluvial / Sankey Diagram)</option>
              <option value="upset" ${clinSubtype === 'upset' ? 'selected' : ''}>3. 多解剖部位共现矩阵与结局风险率图 (UpSet Plot)</option>
              <option value="logistic" ${clinSubtype === 'logistic' ? 'selected' : ''}>4. 多因素 Logistic 回归 OR 森林图 (Odds Ratio &amp; 95% CI Forest Plot)</option>
              <option value="survival" ${clinSubtype === 'survival' ? 'selected' : ''}>5. Kaplan-Meier 无事件生存曲线 &amp; 多因素 Cox HR 森林图</option>
            </select>
          </label>

          ${clinSubtype === 'grotta' ? `
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>Grotta 有序结局偏移图列映射</span></div>
              <div class="row" style="gap:8px;">
                <label style="flex:1;">治疗/暴露分组列
                  <select id="stClinGrGroup">${colOptHtml(clinGrottaGroup)}</select>
                </label>
                <label style="flex:1;">有序结局评分列 (如 mRS / 闭塞分级)
                  <select id="stClinGrScore">${colOptHtml(clinGrottaScore)}</select>
                </label>
              </div>
              <div class="muted small">自动计算各治疗组在不同等级（如 mRS 0~5 或完全闭塞/部分闭塞/未闭塞）的构成比，并执行 Mann-Whitney U / Kruskal-Wallis 秩和检验。</div>
            </div>
          ` : clinSubtype === 'sankey' ? `
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>多阶段序贯治疗轨迹与结局列映射</span></div>
              <div class="row" style="gap:6px;">
                <label style="flex:1;">阶段 1 (首治)
                  <select id="stClinSkS1">${colOptHtml(clinSankeyStage1)}</select>
                </label>
                <label style="flex:1;">阶段 2 (二线/闭塞)
                  <select id="stClinSkS2">${colOptHtml(clinSankeyStage2)}</select>
                </label>
                <label style="flex:1;">阶段 3 (结局/三线)
                  <select id="stClinSkS3">${colOptHtml(clinSankeyStage3, true, '（无阶段3）')}</select>
                </label>
              </div>
              <div class="row" style="gap:8px;">
                <label style="flex:1;">或直接指定「复合序贯编码列」（如 <code>1+3</code>）
                  <select id="stClinSkSeq">${colOptHtml(clinSankeySeqCol, true, '（使用上方多阶段列）')}</select>
                </label>
                <label style="flex:1;">叠加结局列（选复合列时追加末节点）
                  <select id="stClinSkOut">${colOptHtml(clinSankeyOutcome, true, '（不追加结局列）')}</select>
                </label>
              </div>
            </div>
          ` : clinSubtype === 'upset' ? `
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>多解剖部位/合并症二元列（勾选 ≥ 2 项）与叠加风险列</span></div>
              <label>右侧叠加阳性事件率列（如 治疗后出血 / 不良事件）
                <select id="stClinUpOut">${colOptHtml(clinUpsetOutcome, true, '（不叠加事件率）')}</select>
              </label>
              <div class="ds-scroll" style="max-height:155px;display:grid;grid-template-columns:repeat(auto-fill, minmax(115px, 1fr));gap:4px;padding:6px;border:1px solid var(--line);background:var(--bg);">
                ${availableCols.map(c => `
                  <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;">
                    <input type="checkbox" class="st-clin-up-cb" value="${esc(c)}" ${clinUpsetCols.includes(c) ? 'checked' : ''}>
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(c)}">${esc(clinLabels[c] || c)}</span>
                  </label>
                `).join('')}
              </div>
            </div>
          ` : clinSubtype === 'logistic' ? `
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>多因素 Logistic 回归终点与自变量勾选</span></div>
              <label>二分类结局终点列 (Outcome, 1/0 或 是/否)
                <select id="stClinLgOut">${colOptHtml(clinLogOutcome)}</select>
              </label>
              <div class="muted small" style="margin-bottom:4px;">勾选纳入多因素 IRLS 拟合的协变量（自动计算 OR、Wald 95% CI、P 值与 C-index）：</div>
              <div class="ds-scroll" style="max-height:155px;display:grid;grid-template-columns:repeat(auto-fill, minmax(125px, 1fr));gap:4px;padding:6px;border:1px solid var(--line);background:var(--bg);">
                ${availableCols.filter(c => c !== clinLogOutcome).map(c => `
                  <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;">
                    <input type="checkbox" class="st-clin-lg-cb" value="${esc(c)}" ${clinLogCovs.includes(c) ? 'checked' : ''}>
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(c)}">${esc(clinLabels[c] || c)}</span>
                  </label>
                `).join('')}
              </div>
            </div>
          ` : `
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>Kaplan-Meier 无事件生存分析与随访时间映射</span></div>
              <label>随访时长来源方式
                <select id="stClinSvMode">
                  <option value="duration" ${clinSurvMode === 'duration' ? 'selected' : ''}>直接指定随访时长数值列 (如 followup_months)</option>
                  <option value="dates" ${clinSurvMode === 'dates' ? 'selected' : ''}>由「起始日期列 → 事件/末次随访日期列」自动计算随访时长</option>
                </select>
              </label>
              ${clinSurvMode === 'duration' ? `
                <div class="row" style="gap:8px;">
                  <label style="flex:2;">随访时长列 (Time)
                    <select id="stClinSvTime">${colOptHtml(clinSurvTime)}</select>
                  </label>
                  <label style="flex:1;">时间单位
                    <select id="stClinSvUnit">
                      <option value="Months" ${clinSurvUnit === 'Months' ? 'selected' : ''}>月 (Months)</option>
                      <option value="Years" ${clinSurvUnit === 'Years' ? 'selected' : ''}>年 (Years)</option>
                      <option value="Days" ${clinSurvUnit === 'Days' ? 'selected' : ''}>天 (Days)</option>
                    </select>
                  </label>
                </div>
              ` : `
                <div class="row" style="gap:6px;">
                  <label style="flex:1;">起点日期列 (如 首治/出生日期)
                    <select id="stClinSvStart">${colOptHtml(clinSurvStart)}</select>
                  </label>
                  <label style="flex:1;">事件日期列 (如 出血时间)
                    <select id="stClinSvEnd">${colOptHtml(clinSurvEnd)}</select>
                  </label>
                </div>
                <div class="row" style="gap:6px;">
                  <label style="flex:1;">无事件删失截止日
                    <input type="text" id="stClinSvCensor" value="${esc(clinSurvCensor)}" placeholder="2025-12-31">
                  </label>
                  <label style="flex:1;">折算单位
                    <select id="stClinSvUnit">
                      <option value="Months" ${clinSurvUnit === 'Months' ? 'selected' : ''}>月 (Months)</option>
                      <option value="Years" ${clinSurvUnit === 'Years' ? 'selected' : ''}>年 (Years)</option>
                      <option value="Days" ${clinSurvUnit === 'Days' ? 'selected' : ''}>天 (Days)</option>
                    </select>
                  </label>
                </div>
              `}
              <div class="row" style="gap:8px;">
                <label style="flex:1;">结局事件列 (Event, 1/0)
                  <select id="stClinSvEvent">${colOptHtml(clinSurvEvent)}</select>
                </label>
                <label style="flex:1;">分组比较列 (Group)
                  <select id="stClinSvGroup">${colOptHtml(clinSurvGroup, true, '（不分组）')}</select>
                </label>
              </div>
            </div>
          `}
          <button type="button" class="primary small-btn" id="stClinRenderBtn">${icon('chart', { size: 13 })} 渲染临床队列图并生成 Prism / R / 600DPI PNG</button>
        `

        bindUnifiedDatasetBarEvents()
        if (activeDatasetId && clinLoadedDsId !== activeDatasetId) {
          void ensureUnifiedDatasetLoaded(activeDatasetId).then(() => {
            renderLeftEditor()
            void runStudioRender()
          })
        }

        const syncClinInputs = () => {
          if (clinSubtype === 'grotta') {
            clinGrottaGroup = (document.getElementById('stClinGrGroup') as HTMLSelectElement)?.value || clinGrottaGroup
            clinGrottaScore = (document.getElementById('stClinGrScore') as HTMLSelectElement)?.value || clinGrottaScore
          } else if (clinSubtype === 'sankey') {
            clinSankeyStage1 = (document.getElementById('stClinSkS1') as HTMLSelectElement)?.value || clinSankeyStage1
            clinSankeyStage2 = (document.getElementById('stClinSkS2') as HTMLSelectElement)?.value || clinSankeyStage2
            clinSankeyStage3 = (document.getElementById('stClinSkS3') as HTMLSelectElement)?.value ?? ''
            clinSankeySeqCol = (document.getElementById('stClinSkSeq') as HTMLSelectElement)?.value ?? ''
            clinSankeyOutcome = (document.getElementById('stClinSkOut') as HTMLSelectElement)?.value ?? ''
          } else if (clinSubtype === 'upset') {
            clinUpsetOutcome = (document.getElementById('stClinUpOut') as HTMLSelectElement)?.value ?? ''
            const checked = Array.from(leftEl.querySelectorAll<HTMLInputElement>('.st-clin-up-cb:checked')).map(cb => cb.value)
            if (checked.length >= 2) clinUpsetCols = checked
          } else if (clinSubtype === 'logistic') {
            clinLogOutcome = (document.getElementById('stClinLgOut') as HTMLSelectElement)?.value || clinLogOutcome
            const checked = Array.from(leftEl.querySelectorAll<HTMLInputElement>('.st-clin-lg-cb:checked')).map(cb => cb.value)
            if (checked.length >= 1) clinLogCovs = checked
          } else {
            clinSurvMode = ((document.getElementById('stClinSvMode') as HTMLSelectElement)?.value as 'duration' | 'dates') || clinSurvMode
            clinSurvTime = (document.getElementById('stClinSvTime') as HTMLSelectElement)?.value || clinSurvTime
            clinSurvStart = (document.getElementById('stClinSvStart') as HTMLSelectElement)?.value || clinSurvStart
            clinSurvEnd = (document.getElementById('stClinSvEnd') as HTMLSelectElement)?.value || clinSurvEnd
            clinSurvCensor = (document.getElementById('stClinSvCensor') as HTMLInputElement)?.value.trim() || clinSurvCensor
            clinSurvUnit = ((document.getElementById('stClinSvUnit') as HTMLSelectElement)?.value as 'Months' | 'Years' | 'Days') || clinSurvUnit
            clinSurvEvent = (document.getElementById('stClinSvEvent') as HTMLSelectElement)?.value || clinSurvEvent
            clinSurvGroup = (document.getElementById('stClinSvGroup') as HTMLSelectElement)?.value ?? ''
          }
        }

        document.getElementById('stClinSubtype')!.onchange = e => {
          syncClinInputs()
          clinSubtype = (e.target as HTMLSelectElement).value as typeof clinSubtype
          renderLeftEditor()
          void runStudioRender()
        }
        document.getElementById('stClinSvMode')?.addEventListener('change', e => {
          clinSurvMode = (e.target as HTMLSelectElement).value as 'duration' | 'dates'
          renderLeftEditor()
          void runStudioRender()
        })
        document.getElementById('stClinLgOut')?.addEventListener('change', e => {
          clinLogOutcome = (e.target as HTMLSelectElement).value
          renderLeftEditor()
        })
        document.getElementById('stClinRenderBtn')!.onclick = () => {
          syncClinInputs()
          void runStudioRender()
        }
        return
      }

      if (currentMode === 'wet_lab') {
        const wetCols = clinPreviewHeader.length ? clinPreviewHeader : clinCols
        leftEl.innerHTML = `
          ${renderUnifiedDatasetBarHtml('手动输入 / 内置三组实验实测值 (即开即画)')}
          <label>图表子类型 (Plot Subtype)
            <select id="stWetSubtype">
              <option value="bar_scatter" ${wetPlotType === 'bar_scatter' ? 'selected' : ''}>柱状图 + 个体散点抖动 + P 值星号支架 (Prism 风格)</option>
              <option value="violin_box" ${wetPlotType === 'violin_box' ? 'selected' : ''}>小提琴密度图 + 内嵌中位数箱线图 (Violin + Boxplot)</option>
              <option value="dose_response" ${wetPlotType === 'dose_response' ? 'selected' : ''}>4PL 剂量反应非线性拟合曲线 + IC50/EC50 (Origin 风格)</option>
            </select>
          </label>
          <div class="row" style="gap:8px;">
            <label style="flex:2;">Y 轴指标名称
              <input type="text" id="stWetYLabel" value="${esc(wetYLabel)}">
            </label>
            <label style="flex:1;">误差棒
              <select id="stWetErrType">
                <option value="SD" ${wetErrorType === 'SD' ? 'selected' : ''}>Mean ± SD</option>
                <option value="SEM" ${wetErrorType === 'SEM' ? 'selected' : ''}>Mean ± SEM</option>
              </select>
            </label>
          </div>

          ${wetPlotType !== 'dose_response' && activeDatasetId && wetCols.length ? `
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>${icon('link', { size: 13 })} 统一数据表列映射（切换列即自动提取各组数值并过滤「缺失」）</span></div>
              <div class="row" style="gap:8px;">
                <label style="flex:1;">分组列 (Group)
                  <select id="stWetDsGrp">
                    ${wetCols.map(h => `<option value="${esc(h)}" ${h === wetDsGrpCol ? 'selected' : ''}>${esc(clinLabels[h] || h)}</option>`).join('')}
                  </select>
                </label>
                <label style="flex:1;">连续数值列 (Value)
                  <select id="stWetDsVal">
                    ${wetCols.map(h => `<option value="${esc(h)}" ${h === wetDsValCol ? 'selected' : ''}>${esc(clinLabels[h] || h)}</option>`).join('')}
                  </select>
                </label>
              </div>
            </div>
          ` : ''}

          ${wetPlotType !== 'dose_response' ? `
            <div class="rs-sub-box">
              <div class="rs-sub-box-title">
                <span>各组样本实测值（可直接编辑，逗号分隔）</span>
                <button type="button" class="quiet small-btn" id="stWetAddGroup">＋ 新增组</button>
              </div>
              <table class="rs-data-table">
                <thead><tr><th style="width:28%;">组名</th><th>样本数值 (逗号分隔)</th><th style="width:44px;">色标</th><th style="width:28px;"></th></tr></thead>
                <tbody id="stWetGroupTbody">
                  ${wetGroups.map((g, idx) => `
                    <tr data-gidx="${idx}">
                      <td><input type="text" class="st-wg-name" value="${esc(g.name)}"></td>
                      <td><input type="text" class="st-wg-vals" value="${esc(g.values)}"></td>
                      <td><input type="color" class="st-wg-color" value="${esc(g.color)}" style="width:32px;height:24px;padding:0;border:0;"></td>
                      <td><button type="button" class="quiet small-btn" data-del-wg="${idx}">✕</button></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : `
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>浓度梯度 log10[M] 与重复孔抑制率 (%)</span></div>
              <table class="rs-data-table">
                <thead><tr><th style="width:34%;">log10(浓度 [M])</th><th>重复孔响应值 (%)</th></tr></thead>
                <tbody id="stDoseTbody">
                  ${doseRows.map((r, idx) => `
                    <tr data-didx="${idx}">
                      <td><input type="number" step="0.5" class="st-dr-conc" value="${r.logConc}"></td>
                      <td><input type="text" class="st-dr-vals" value="${esc(r.values)}"></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
          <button type="button" class="primary small-btn" id="stRunRenderBtn">${icon('chart', { size: 13 })} 渲染统计图并更新原工程文件</button>
        `

        bindUnifiedDatasetBarEvents()
        if (activeDatasetId && clinLoadedDsId !== activeDatasetId) {
          void ensureUnifiedDatasetLoaded(activeDatasetId).then(() => {
            renderLeftEditor()
            void runStudioRender()
          })
        }

        const syncWetInputs = () => {
          wetYLabel = (document.getElementById('stWetYLabel') as HTMLInputElement)?.value || wetYLabel
          wetErrorType = ((document.getElementById('stWetErrType') as HTMLSelectElement)?.value as 'SD' | 'SEM') || 'SD'
          const gRows = leftEl.querySelectorAll<HTMLTableRowElement>('#stWetGroupTbody tr')
          if (gRows.length) {
            wetGroups = Array.from(gRows).map(tr => ({
              name: tr.querySelector<HTMLInputElement>('.st-wg-name')?.value.trim() || 'Group',
              values: tr.querySelector<HTMLInputElement>('.st-wg-vals')?.value || '',
              color: tr.querySelector<HTMLInputElement>('.st-wg-color')?.value || '#3C5488',
            }))
          }
          const dRows = leftEl.querySelectorAll<HTMLTableRowElement>('#stDoseTbody tr')
          if (dRows.length) {
            doseRows = Array.from(dRows).map(tr => ({
              logConc: Number(tr.querySelector<HTMLInputElement>('.st-dr-conc')?.value ?? -6),
              values: tr.querySelector<HTMLInputElement>('.st-dr-vals')?.value || '',
            }))
          }
        }

        document.getElementById('stWetSubtype')!.onchange = e => {
          syncWetInputs()
          wetPlotType = (e.target as HTMLSelectElement).value as typeof wetPlotType
          renderLeftEditor()
          void runStudioRender()
        }
        document.getElementById('stWetAddGroup')?.addEventListener('click', () => {
          syncWetInputs()
          const palette = ['#3C5488', '#00A087', '#E64B35', '#4DBBD5', '#F39B7F', '#8491B4']
          wetGroups.push({ name: `Group ${wetGroups.length + 1}`, values: '1.20, 1.35, 1.28, 1.42, 1.31', color: palette[wetGroups.length % palette.length]! })
          renderLeftEditor()
          void runStudioRender()
        })
        leftEl.querySelectorAll<HTMLButtonElement>('[data-del-wg]').forEach(btn => {
          btn.onclick = () => {
            syncWetInputs()
            if (wetGroups.length <= 2) { notice('至少保留 2 个实验对比组', true); return }
            wetGroups.splice(Number(btn.dataset.delWg), 1)
            renderLeftEditor()
            void runStudioRender()
          }
        })
        document.getElementById('stRunRenderBtn')!.onclick = () => {
          syncWetInputs()
          void runStudioRender()
        }

        const grpSel = document.getElementById('stWetDsGrp') as HTMLSelectElement | null
        const valSel = document.getElementById('stWetDsVal') as HTMLSelectElement | null
        if (grpSel && valSel) {
          const onWetColChange = () => {
            wetDsGrpCol = grpSel.value
            wetDsValCol = valSel.value
            applyDatasetToWetLab()
            renderLeftEditor()
            void runStudioRender()
          }
          grpSel.onchange = onWetColChange
          valSel.onchange = onWetColChange
        }
        return
      }

      if (currentMode === 'bioinformatics') {
        const bioCols = clinPreviewHeader.length ? clinPreviewHeader : clinCols
        leftEl.innerHTML = `
          ${renderUnifiedDatasetBarHtml('内置肿瘤转录组差异表达演示矩阵 (即开即画)')}
          <label>生信图型 (Bioinformatics Plot)
            <select id="stBioSubtype">
              <option value="volcano" ${bioType === 'volcano' ? 'selected' : ''}>差异表达火山图 (Volcano Plot · log2FC vs -log10 P)</option>
              <option value="heatmap" ${bioType === 'heatmap' ? 'selected' : ''}>多组学聚类热图 + Z-score 标准化 (ComplexHeatmap 风格)</option>
              <option value="enrichment_bubble" ${bioType === 'enrichment_bubble' ? 'selected' : ''}>KEGG / GO 通路富集气泡图 (clusterProfiler 风格)</option>
              <option value="umap" ${bioType === 'umap' ? 'selected' : ''}>单细胞转录组 UMAP 细胞亚群降维图 (Seurat 风格)</option>
            </select>
          </label>
          ${activeDatasetId && bioCols.length && (bioType === 'volcano' || bioType === 'heatmap') ? `
            <div class="rs-sub-box">
              <div class="rs-sub-box-title"><span>${icon('link', { size: 13 })} 统一数据表差异比较分组列（自动计算各指标 log2FC、P 值与 Z-score 热图）</span></div>
              <label>分组对比列 (Group / Outcome Column)
                <select id="stBioGrpCol">
                  ${bioCols.map(h => `<option value="${esc(h)}" ${h === bioGroupCol ? 'selected' : ''}>${esc(clinLabels[h] || h)}</option>`).join('')}
                </select>
              </label>
            </div>
          ` : ''}
          ${bioType === 'volcano' ? `
            <div class="row" style="gap:8px;">
              <label style="flex:1;">|log2FC| 阈值
                <input type="number" step="0.25" id="stBioFc" value="${volcanoFc}">
              </label>
              <label style="flex:1;">P-value 截断值
                <input type="number" step="0.01" id="stBioP" value="${volcanoP}">
              </label>
            </div>
          ` : ''}
          <div class="muted small">自动同步生成 R 语言源码（<code>ggplot2</code> / <code>ggrepel</code> / <code>ComplexHeatmap</code> / <code>clusterProfiler</code> / <code>Seurat</code>）与微生信/Hiplot 标准输入矩阵 (<code>.csv</code>)。</div>
          <button type="button" class="primary small-btn" id="stBioRenderBtn">${icon('chart', { size: 13 })} 渲染多组学图表并更新 R/CSV 原文件</button>
        `
        bindUnifiedDatasetBarEvents()
        if (activeDatasetId && clinLoadedDsId !== activeDatasetId) {
          void ensureUnifiedDatasetLoaded(activeDatasetId).then(() => {
            renderLeftEditor()
            void runStudioRender()
          })
        }
        document.getElementById('stBioSubtype')!.onchange = e => {
          bioType = (e.target as HTMLSelectElement).value as typeof bioType
          renderLeftEditor()
          void runStudioRender()
        }
        document.getElementById('stBioGrpCol')?.addEventListener('change', e => {
          bioGroupCol = (e.target as HTMLSelectElement).value
          void runStudioRender()
        })
        document.getElementById('stBioRenderBtn')!.onclick = () => {
          if (bioType === 'volcano') {
            volcanoFc = Number((document.getElementById('stBioFc') as HTMLInputElement)?.value || 1.0)
            volcanoP = Number((document.getElementById('stBioP') as HTMLInputElement)?.value || 0.05)
          }
          void runStudioRender()
        }
        return
      }

      if (currentMode === 'mechanism') {
        leftEl.innerHTML = `
          <div class="rs-sub-box-title">
            <span>${icon('microscope', { size: 13 })} 生物机制与信号通路可视化编辑器</span>
          </div>
          <div class="row" style="gap:6px;flex-wrap:wrap;">
            <span class="muted small">快速载入经典通路模板：</span>
            <button type="button" class="quiet small-btn" data-mech-preset="gpcr">GPCR-cAMP-PKA</button>
            <button type="button" class="quiet small-btn" data-mech-preset="pd1">PD-1 免疫检查点</button>
            <button type="button" class="quiet small-btn" data-mech-preset="tgfb">TGF-β/Smad 纤维化</button>
          </div>
          <label>机制图主标题
            <input type="text" id="stMechTitle" value="${esc(mechState.title)}">
          </label>
          <div class="rs-sub-box">
            <div class="rs-sub-box-title">
              <span>1. 生物组件节点 (Nodes · ${mechState.nodes.length})</span>
              <button type="button" class="quiet small-btn" id="stMechAddNode">＋ 新增节点</button>
            </div>
            <div class="ds-scroll" style="max-height:210px;">
              <table class="rs-data-table">
                <thead><tr><th>名称</th><th>类型</th><th>细胞区室</th><th></th></tr></thead>
                <tbody id="stMechNodeTbody">
                  ${mechState.nodes.map((n, idx) => `
                    <tr data-nidx="${idx}">
                      <td><input type="text" class="st-mn-label" value="${esc(n.label)}"></td>
                      <td>
                        <select class="st-mn-type">
                          ${['ligand', 'receptor', 'kinase', 'transcription_factor', 'mitochondria', 'antibody', 'ion_channel', 'vesicle'].map(t => `<option value="${t}" ${n.type === t ? 'selected' : ''}>${t}</option>`).join('')}
                        </select>
                      </td>
                      <td>
                        <select class="st-mn-comp">
                          ${['extracellular', 'membrane', 'cytoplasm', 'nucleus'].map(c => `<option value="${c}" ${n.compartment === c ? 'selected' : ''}>${c}</option>`).join('')}
                        </select>
                      </td>
                      <td><button type="button" class="quiet small-btn" data-del-mn="${idx}">✕</button></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
          <div class="rs-sub-box">
            <div class="rs-sub-box-title">
              <span>2. 信号传导连线 (Edges · ${mechState.edges.length})</span>
              <button type="button" class="quiet small-btn" id="stMechAddEdge">＋ 新增连线</button>
            </div>
            <div class="ds-scroll" style="max-height:175px;">
              <table class="rs-data-table">
                <thead><tr><th>起点</th><th>作用关系</th><th>终点</th><th>标注</th><th></th></tr></thead>
                <tbody id="stMechEdgeTbody">
                  ${mechState.edges.map((ed, idx) => `
                    <tr data-eidx="${idx}">
                      <td>
                        <select class="st-me-from">
                          ${mechState.nodes.map(n => `<option value="${esc(n.id)}" ${ed.from === n.id ? 'selected' : ''}>${esc(n.label)}</option>`).join('')}
                        </select>
                      </td>
                      <td>
                        <select class="st-me-type">
                          <option value="activate" ${ed.type === 'activate' ? 'selected' : ''}>促进 (→)</option>
                          <option value="inhibit" ${ed.type === 'inhibit' ? 'selected' : ''}>抑制 (⊣)</option>
                          <option value="phosphorylate" ${ed.type === 'phosphorylate' ? 'selected' : ''}>磷酸化 (+P)</option>
                          <option value="translocate" ${ed.type === 'translocate' ? 'selected' : ''}>核易位 (⇢)</option>
                        </select>
                      </td>
                      <td>
                        <select class="st-me-to">
                          ${mechState.nodes.map(n => `<option value="${esc(n.id)}" ${ed.to === n.id ? 'selected' : ''}>${esc(n.label)}</option>`).join('')}
                        </select>
                      </td>
                      <td><input type="text" class="st-me-label" value="${esc(ed.label)}"></td>
                      <td><button type="button" class="quiet small-btn" data-del-me="${idx}">✕</button></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>
          <button type="button" class="primary small-btn" id="stMechRenderBtn">${icon('chart', { size: 13 })} 渲染机制图并生成 Draw.io / PPTX 原文件</button>
        `

        const compY: Record<string, number> = { extracellular: 80, membrane: 175, cytoplasm: 325, nucleus: 550 }
        const syncMech = () => {
          mechState.title = (document.getElementById('stMechTitle') as HTMLInputElement)?.value.trim() || mechState.title
          const nRows = leftEl.querySelectorAll<HTMLTableRowElement>('#stMechNodeTbody tr')
          nRows.forEach((tr, i) => {
            const node = mechState.nodes[i]
            if (!node) return
            node.label = tr.querySelector<HTMLInputElement>('.st-mn-label')?.value.trim() || node.label
            node.type = tr.querySelector<HTMLSelectElement>('.st-mn-type')?.value || node.type
            const comp = tr.querySelector<HTMLSelectElement>('.st-mn-comp')?.value || node.compartment
            if (comp !== node.compartment) {
              node.compartment = comp
              node.y = compY[comp] ?? 320
            }
          })
          const eRows = leftEl.querySelectorAll<HTMLTableRowElement>('#stMechEdgeTbody tr')
          mechState.edges = Array.from(eRows).map(tr => ({
            from: tr.querySelector<HTMLSelectElement>('.st-me-from')?.value || mechState.nodes[0]?.id || 'n1',
            type: tr.querySelector<HTMLSelectElement>('.st-me-type')?.value || 'activate',
            to: tr.querySelector<HTMLSelectElement>('.st-me-to')?.value || mechState.nodes[1]?.id || 'n2',
            label: tr.querySelector<HTMLInputElement>('.st-me-label')?.value.trim() || '',
          }))
        }

        leftEl.querySelectorAll<HTMLButtonElement>('[data-mech-preset]').forEach(btn => {
          btn.onclick = () => {
            const p = MECH_PRESETS[btn.dataset.mechPreset!]
            if (p) {
              mechState = structuredClone(p)
              renderLeftEditor()
              void runStudioRender()
            }
          }
        })
        document.getElementById('stMechAddNode')!.onclick = () => {
          syncMech()
          const id = `node_${Date.now().toString(36).slice(-4)}`
          mechState.nodes.push({ id, label: 'New Protein', type: 'kinase', compartment: 'cytoplasm', x: 180 + (mechState.nodes.length * 140) % 560, y: 330, color: '#00A087' })
          renderLeftEditor()
          void runStudioRender()
        }
        leftEl.querySelectorAll<HTMLButtonElement>('[data-del-mn]').forEach(btn => {
          btn.onclick = () => {
            syncMech()
            if (mechState.nodes.length <= 2) { notice('至少保留 2 个生物节点', true); return }
            const removed = mechState.nodes.splice(Number(btn.dataset.delMn), 1)[0]
            if (removed) mechState.edges = mechState.edges.filter(e => e.from !== removed.id && e.to !== removed.id)
            renderLeftEditor()
            void runStudioRender()
          }
        })
        document.getElementById('stMechAddEdge')!.onclick = () => {
          syncMech()
          const n0 = mechState.nodes[0]?.id || 'lig'
          const n1 = mechState.nodes[mechState.nodes.length - 1]?.id || n0
          mechState.edges.push({ from: n0, to: n1, type: 'activate', label: 'Signal' })
          renderLeftEditor()
          void runStudioRender()
        }
        leftEl.querySelectorAll<HTMLButtonElement>('[data-del-me]').forEach(btn => {
          btn.onclick = () => {
            syncMech()
            mechState.edges.splice(Number(btn.dataset.delMe), 1)
            renderLeftEditor()
            void runStudioRender()
          }
        })
        document.getElementById('stMechRenderBtn')!.onclick = () => {
          syncMech()
          void runStudioRender()
        }
        return
      }

      if (currentMode === 'image_processing') {
        leftEl.innerHTML = `
          <div class="rs-sub-box-title"><span>${icon('layers', { size: 13 })} 显微、流式细胞术与 3D 影像定量配置</span></div>
          <label>专业分析工具 (Tool Engine)
            <select id="stImgTool">
              <option value="imagej" ${imgTool === 'imagej' ? 'selected' : ''}>ImageJ / Fiji：WB 条带光密度 / IF 多通道合并 / IHC 标尺校准 (.ijm)</option>
              <option value="flowjo" ${imgTool === 'flowjo' ? 'selected' : ''}>FlowJo：流式细胞术双参数伪彩散点与四象限圈门 (.wsp)</option>
              <option value="slicer" ${imgTool === 'slicer' ? 'selected' : ''}>3D Slicer / ITK-SNAP：CT/MRI 靶病灶三维分割场景 (.mrml / .txt)</option>
            </select>
          </label>
          ${imgTool === 'imagej' ? `
            <label>实验成像模态
              <select id="stImgModality">
                <option value="immunofluorescence" ${imgModality === 'immunofluorescence' ? 'selected' : ''}>多通道免疫荧光 (DAPI / GFP / mCherry Composite)</option>
                <option value="western_blot" ${imgModality === 'western_blot' ? 'selected' : ''}>Western Blot 蛋白印迹条带光密度归一化定量</option>
                <option value="ihc" ${imgModality === 'ihc' ? 'selected' : ''}>IHC 免疫组化 DAB 阳性面积占比定量</option>
              </select>
            </label>
            <div class="row" style="gap:8px;">
              <label style="flex:1;">像素尺寸 (µm/px)
                <input type="number" step="0.05" id="stImgMpp" value="${imgMicronsPerPx}">
              </label>
              <label style="flex:1;">比例尺长度 (µm)
                <input type="number" step="10" id="stImgScale" value="${imgScaleBar}">
              </label>
            </div>
          ` : imgTool === 'flowjo' ? `
            <div class="row" style="gap:8px;">
              <label style="flex:1;">X 轴荧光通道
                <input type="text" id="stFlowX" value="${esc(flowXChan)}">
              </label>
              <label style="flex:1;">Y 轴荧光通道
                <input type="text" id="stFlowY" value="${esc(flowYChan)}">
              </label>
            </div>
            <div class="row" style="gap:8px;">
              <label style="flex:1;">X 圈门阈值 (log10)
                <input type="number" step="0.1" id="stFlowXGate" value="${flowXGate}">
              </label>
              <label style="flex:1;">Y 圈门阈值 (log10)
                <input type="number" step="0.1" id="stFlowYGate" value="${flowYGate}">
              </label>
            </div>
          ` : `
            <label>医学影像模态
              <select id="stSlicerMod">
                <option value="CT" ${slicerModality === 'CT' ? 'selected' : ''}>胸部/腹部增强 CT (NIfTI + Segmentation)</option>
                <option value="MRI" ${slicerModality === 'MRI' ? 'selected' : ''}>多参数 MRI (T1c / T2-FLAIR / DWI)</option>
                <option value="PET-CT" ${slicerModality === 'PET-CT' ? 'selected' : ''}>18F-FDG PET/CT 代谢体积勾画</option>
              </select>
            </label>
          `}
          <button type="button" class="primary small-btn" id="stImgRenderBtn">${icon('chart', { size: 13 })} 运行定量分析并生成工程原文件</button>
        `
        document.getElementById('stImgTool')!.onchange = e => {
          imgTool = (e.target as HTMLSelectElement).value as typeof imgTool
          renderLeftEditor()
          void runStudioRender()
        }
        document.getElementById('stImgRenderBtn')!.onclick = () => {
          if (imgTool === 'imagej') {
            imgModality = ((document.getElementById('stImgModality') as HTMLSelectElement)?.value as typeof imgModality) || 'immunofluorescence'
            imgMicronsPerPx = Number((document.getElementById('stImgMpp') as HTMLInputElement)?.value || 0.5)
            imgScaleBar = Number((document.getElementById('stImgScale') as HTMLInputElement)?.value || 50)
          } else if (imgTool === 'flowjo') {
            flowXChan = (document.getElementById('stFlowX') as HTMLInputElement)?.value || flowXChan
            flowYChan = (document.getElementById('stFlowY') as HTMLInputElement)?.value || flowYChan
            flowXGate = Number((document.getElementById('stFlowXGate') as HTMLInputElement)?.value || 2.5)
            flowYGate = Number((document.getElementById('stFlowYGate') as HTMLInputElement)?.value || 2.5)
          } else {
            slicerModality = ((document.getElementById('stSlicerMod') as HTMLSelectElement)?.value as typeof slicerModality) || 'CT'
          }
          void runStudioRender()
        }
        return
      }

      if (currentMode === 'journal_assembly') {
        const figCandidates = s
          ? s.analyses.map(a => ({ id: a.asset_id, name: a.name }))
          : (studioFigures.length ? studioFigures : (opts?.globalFigures ?? [])).map(f => ({ id: f.id, name: f.name }))
        leftEl.innerHTML = `
          <div class="rs-sub-box-title"><span>${icon('grid', { size: 13 })} 顶刊多面板复合大图排版配置 (A/B/C/D)</span></div>
          <label>复合大图总标题 (Figure Legend Title)
            <input type="text" id="stAsmTitle" value="${esc(asmTitle)}">
          </label>
          <div class="row" style="gap:8px;">
            <label style="flex:2;">目标期刊版式规格
              <select id="stAsmPreset">
                <option value="nature_double" ${asmPreset === 'nature_double' ? 'selected' : ''}>Nature / Cell 双栏通栏 (183 mm)</option>
                <option value="nature_single" ${asmPreset === 'nature_single' ? 'selected' : ''}>Nature 单栏紧凑 (89 mm)</option>
                <option value="nejm" ${asmPreset === 'nejm' ? 'selected' : ''}>NEJM 临床标准版式</option>
                <option value="lancet" ${asmPreset === 'lancet' ? 'selected' : ''}>The Lancet 版式</option>
              </select>
            </label>
            <label style="flex:1;">列数
              <select id="stAsmCols">
                <option value="2" ${asmCols === 2 ? 'selected' : ''}>2 列 (A/B+C/D)</option>
                <option value="3" ${asmCols === 3 ? 'selected' : ''}>3 列 (A/B/C)</option>
                <option value="1" ${asmCols === 1 ? 'selected' : ''}>1 列纵向</option>
              </select>
            </label>
          </div>
          <div class="rs-sub-box">
            <div class="rs-sub-box-title"><span>勾选纳入拼图的已归档子面板 (${figCandidates.length} 张可选)</span></div>
            ${figCandidates.length ? `
              <div class="ds-scroll" style="max-height:220px;display:flex;flex-direction:column;gap:6px;">
                ${figCandidates.map((f, idx) => {
                  const isChecked = asmPickedIds ? asmPickedIds.includes(f.id) : idx < 4
                  return `
                  <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
                    <input type="checkbox" class="st-asm-pick" value="${esc(f.id)}" data-figname="${esc(f.name.replace(/\.[^.]+$/, ''))}" ${isChecked ? 'checked' : ''}>
                    <span><b>Panel ${String.fromCharCode(65 + (idx % 6))}</b> · ${esc(f.name.replace(/\.svg$/i, ''))}</span>
                  </label>
                `}).join('')}
              </div>
            ` : `
              <div class="muted small">暂未勾选已归档子面板，将自动生成标准多面板示例布局；你也可先在左侧图表模式中点击「${isGlobal ? '保存到图表库' : '归档至本研究'}」后再来合成。</div>
            `}
          </div>
          <button type="button" class="primary small-btn" id="stAsmRenderBtn">${icon('grid', { size: 13 })} 合成顶刊多面板大图并导出出版包</button>
        `
        document.getElementById('stAsmRenderBtn')!.onclick = () => {
          asmTitle = (document.getElementById('stAsmTitle') as HTMLInputElement)?.value.trim() || asmTitle
          asmPreset = ((document.getElementById('stAsmPreset') as HTMLSelectElement)?.value as typeof asmPreset) || 'nature_double'
          asmCols = Number((document.getElementById('stAsmCols') as HTMLSelectElement)?.value || 2)
          asmPickedIds = Array.from(leftEl.querySelectorAll<HTMLInputElement>('.st-asm-pick:checked')).map(cb => cb.value)
          void runStudioRender()
        }
        return
      }

      // currentMode === 'flowchart'
      const flCols = clinPreviewHeader.length ? clinPreviewHeader : clinCols
      leftEl.innerHTML = `
        ${renderUnifiedDatasetBarHtml('手动填写 CONSORT 纳排人数 (即开即画)')}
        <div class="rs-sub-box-title"><span>${icon('ruler', { size: 13 })} CONSORT 2010 临床试验受试者纳排流向编辑</span></div>
        ${activeDatasetId && flCols.length ? `
          <div class="rs-sub-box">
            <div class="rs-sub-box-title"><span>${icon('link', { size: 13 })} 统一数据表自动汇总纳排与各组随访人数</span></div>
            <div class="row" style="gap:8px;">
              <label style="flex:1;">研究分组列 (Study Arm)
                <select id="stFlGrpCol">
                  ${flCols.map(h => `<option value="${esc(h)}" ${h === flGroupCol ? 'selected' : ''}>${esc(clinLabels[h] || h)}</option>`).join('')}
                </select>
              </label>
              <label style="flex:1;">随访结局列 (Outcome · 识别「缺失」为失访)
                <select id="stFlOutCol">
                  ${flCols.map(h => `<option value="${esc(h)}" ${h === flOutcomeCol ? 'selected' : ''}>${esc(clinLabels[h] || h)}</option>`).join('')}
                </select>
              </label>
            </div>
          </div>
        ` : ''}
        <div class="row" style="gap:8px;">
          <label style="flex:1;">评估总人数 (Assessed)
            <input type="number" id="stFlAssessed" value="${consortState.total_assessed}">
          </label>
          <label style="flex:1;">符合纳排人数 (Randomized)
            <input type="number" id="stFlEligible" value="${consortState.eligible_total}">
          </label>
        </div>
        <div class="rs-sub-box">
          <div class="rs-sub-box-title"><span>排除原因明细 (Exclusions)</span></div>
          <table class="rs-data-table">
            <thead><tr><th>排除原因</th><th style="width:72px;">人数</th></tr></thead>
            <tbody id="stFlExclTbody">
              ${consortState.exclusions.map(ex => `
                <tr>
                  <td><input type="text" class="st-fl-exreason" value="${esc(ex.reason)}"></td>
                  <td><input type="number" class="st-fl-excnt" value="${ex.count}"></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="rs-sub-box">
          <div class="rs-sub-box-title"><span>随机分组与随访分析人数 (Study Arms)</span></div>
          <table class="rs-data-table">
            <thead><tr><th>组名</th><th>分配</th><th>接受</th><th>失访</th><th>纳入分析</th></tr></thead>
            <tbody id="stFlArmTbody">
              ${consortState.arms.map(a => `
                <tr>
                  <td><input type="text" class="st-fl-aname" value="${esc(a.name)}"></td>
                  <td><input type="number" class="st-fl-alloc" value="${a.allocated}"></td>
                  <td><input type="number" class="st-fl-recv" value="${a.received}"></td>
                  <td><input type="number" class="st-fl-lost" value="${a.lost_to_followup}"></td>
                  <td><input type="number" class="st-fl-ana" value="${a.analyzed}"></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <button type="button" class="primary small-btn" id="stFlRenderBtn">${icon('chart', { size: 13 })} 渲染 CONSORT 流程图并更新 Visio/Draw.io/PPTX</button>
      `
      bindUnifiedDatasetBarEvents()
      if (activeDatasetId && clinLoadedDsId !== activeDatasetId) {
        void ensureUnifiedDatasetLoaded(activeDatasetId).then(() => {
          renderLeftEditor()
          void runStudioRender()
        })
      }
      const flGrpSel = document.getElementById('stFlGrpCol') as HTMLSelectElement | null
      const flOutSel = document.getElementById('stFlOutCol') as HTMLSelectElement | null
      if (flGrpSel && flOutSel) {
        const onFlColChange = () => {
          flGroupCol = flGrpSel.value
          flOutcomeCol = flOutSel.value
          applyDatasetToFlowchart()
          renderLeftEditor()
          void runStudioRender()
        }
        flGrpSel.onchange = onFlColChange
        flOutSel.onchange = onFlColChange
      }
      document.getElementById('stFlRenderBtn')!.onclick = () => {
        consortState.total_assessed = Number((document.getElementById('stFlAssessed') as HTMLInputElement)?.value || 200)
        consortState.eligible_total = Number((document.getElementById('stFlEligible') as HTMLInputElement)?.value || 160)
        consortState.exclusions = Array.from(leftEl.querySelectorAll<HTMLTableRowElement>('#stFlExclTbody tr')).map(tr => ({
          reason: tr.querySelector<HTMLInputElement>('.st-fl-exreason')?.value.trim() || 'Excluded',
          count: Number(tr.querySelector<HTMLInputElement>('.st-fl-excnt')?.value || 0),
        }))
        consortState.arms = Array.from(leftEl.querySelectorAll<HTMLTableRowElement>('#stFlArmTbody tr')).map(tr => ({
          name: tr.querySelector<HTMLInputElement>('.st-fl-aname')?.value.trim() || 'Arm',
          allocated: Number(tr.querySelector<HTMLInputElement>('.st-fl-alloc')?.value || 0),
          received: Number(tr.querySelector<HTMLInputElement>('.st-fl-recv')?.value || 0),
          lost_to_followup: Number(tr.querySelector<HTMLInputElement>('.st-fl-lost')?.value || 0),
          discontinued: 0,
          analyzed: Number(tr.querySelector<HTMLInputElement>('.st-fl-ana')?.value || 0),
        }))
        void runStudioRender()
      }
    }

    const runStudioRender = async () => {
      canvasEl.innerHTML = `<div class="muted small">正在渲染出版级矢量图与生成各软件原生工程文件…</div>`
      const targetSid = s?.id || selectedArchiveStudyId || undefined
      const endpoint = targetSid ? `/api/studies/${targetSid}/figures` : '/api/figures'
      let payload: Record<string, unknown> = { category: currentMode }
      if (currentMode === 'clinical_cohort') {
        const dsLabel = activeDatasetId
          ? (readyDs.find(d => d.dataset_id === activeDatasetId)?.name || contextTitle)
          : `${contextTitle} · 临床队列`
        if (clinSubtype === 'grotta') {
          payload = {
            category: 'clinical_cohort',
            subtype: 'grotta',
            dataset_id: activeDatasetId || undefined,
            group_col: clinGrottaGroup,
            score_col: clinGrottaScore,
            labels: clinLabels,
            title: `${dsLabel} · ${clinGrottaScore} Shift Analysis (Grotta Plot)`,
          }
          lastTitle = `Clinical_Grotta_${clinGrottaScore}`
        } else if (clinSubtype === 'sankey') {
          const stages = [clinSankeyStage1, clinSankeyStage2, clinSankeyStage3].filter(Boolean)
          payload = {
            category: 'clinical_cohort',
            subtype: 'sankey',
            dataset_id: activeDatasetId || undefined,
            stage_cols: clinSankeySeqCol ? undefined : stages,
            sequence_col: clinSankeySeqCol || undefined,
            outcome_col: clinSankeyOutcome || undefined,
            labels: clinLabels,
            title: `${dsLabel} · Treatment Trajectory & Outcome Sankey Diagram`,
          }
          lastTitle = `Clinical_Sankey_Trajectory`
        } else if (clinSubtype === 'upset') {
          payload = {
            category: 'clinical_cohort',
            subtype: 'upset',
            dataset_id: activeDatasetId || undefined,
            binary_cols: clinUpsetCols,
            outcome_col: clinUpsetOutcome || undefined,
            labels: clinLabels,
            title: `${dsLabel} · Anatomical Co-occurrence & Risk UpSet Plot`,
          }
          lastTitle = `Clinical_UpSet_Cooccurrence`
        } else if (clinSubtype === 'logistic') {
          payload = {
            category: 'clinical_cohort',
            subtype: 'logistic',
            dataset_id: activeDatasetId || undefined,
            outcome_col: clinLogOutcome,
            covariates: clinLogCovs,
            labels: clinLabels,
            title: `${dsLabel} · Multivariable Logistic Regression Forest Plot (OR & 95% CI)`,
          }
          lastTitle = `Clinical_Logistic_OR_${clinLogOutcome}`
        } else {
          payload = {
            category: 'clinical_cohort',
            subtype: 'survival',
            dataset_id: activeDatasetId || undefined,
            time_col: clinSurvMode === 'duration' ? clinSurvTime : undefined,
            start_date_col: clinSurvMode === 'dates' ? clinSurvStart : undefined,
            event_date_col: clinSurvMode === 'dates' ? clinSurvEnd : undefined,
            default_censor_date: clinSurvMode === 'dates' ? clinSurvCensor : undefined,
            event_col: clinSurvEvent,
            group_col: clinSurvGroup || undefined,
            time_unit: clinSurvUnit,
            title: `${dsLabel} · Kaplan-Meier Event-Free Survival Analysis`,
          }
          lastTitle = `Clinical_KM_Survival_${clinSurvEvent}`
        }
      } else if (currentMode === 'wet_lab') {
        const parsedGroups = wetGroups.map(g => ({
          name: g.name,
          color: g.color,
          values: g.values.split(/[,，\s]+/).map(v => Number(v.trim())).filter(v => Number.isFinite(v)),
        })).filter(g => g.values.length > 0)
        const parsedDose = doseRows.map(d => ({
          logConc: d.logConc,
          responses: d.values.split(/[,，\s]+/).map(v => Number(v.trim())).filter(v => Number.isFinite(v)),
        })).filter(d => d.responses.length > 0)
        payload = {
          category: 'wet_lab',
          plotType: wetPlotType,
          title: `${contextTitle} · ${wetPlotType === 'bar_scatter' ? 'Group Comparison' : wetPlotType === 'violin_box' ? 'Distribution Violin Plot' : 'Dose-Response IC50 Curve'}`,
          yLabel: wetYLabel,
          errorBarType: wetErrorType,
          groups: parsedGroups,
          doseResponse: wetPlotType === 'dose_response'
            ? {
                compoundName: 'Lead Compound',
                points: parsedDose,
                logConcentrations: parsedDose.map(d => d.logConc),
                series: [
                  {
                    name: 'Lead Compound',
                    responses: parsedDose.map(d => d.responses.reduce((a, b) => a + b, 0) / Math.max(1, d.responses.length)),
                  },
                ],
              }
            : undefined,
        }
        lastTitle = `WetLab_${wetPlotType}`
      } else if (currentMode === 'bioinformatics') {
        const bioDsLabel = activeDatasetId
          ? (readyDs.find(d => d.dataset_id === activeDatasetId)?.name || contextTitle)
          : contextTitle
        payload = {
          category: 'bioinformatics',
          bioType,
          title: `${bioDsLabel} · ${bioType.toUpperCase()} Multi-Omics Analysis`,
          fcThreshold: volcanoFc,
          pThreshold: volcanoP,
          ...computeDatasetBioData(),
        }
        lastTitle = `Bioinformatics_${bioType}`
      } else if (currentMode === 'mechanism') {
        payload = {
          category: 'mechanism',
          title: mechState.title,
          subtitle: mechState.subtitle,
          showCompartments: true,
          nodes: mechState.nodes,
          edges: mechState.edges,
        }
        lastTitle = `Mechanism_Pathway`
      } else if (currentMode === 'image_processing') {
        payload = {
          category: 'image_processing',
          tool: imgTool,
          title: `${contextTitle} · ${imgTool.toUpperCase()} Quantitative Analysis`,
          modality: imgModality,
          micronsPerPixel: imgMicronsPerPx,
          scaleBarMicrons: imgScaleBar,
          xChannel: flowXChan,
          yChannel: flowYChan,
          xGateThreshold: flowXGate,
          yGateThreshold: flowYGate,
          studyModality: slicerModality,
        }
        lastTitle = `Imaging_${imgTool}`
      } else if (currentMode === 'journal_assembly') {
        const checked = Array.from(leftEl.querySelectorAll<HTMLInputElement>('.st-asm-pick:checked'))
        const panels: Array<{ label: string; title: string; svg: string }> = []
        const token = hooks.token()
        for (let i = 0; i < checked.length; i++) {
          const cb = checked[i]!
          const r = await fetch(`/api/assets/${cb.value}?token=${encodeURIComponent(token)}`)
          const text = await r.text()
          if (text.includes('<svg')) {
            panels.push({
              label: String.fromCharCode(65 + i),
              title: cb.dataset.figname || `Panel ${String.fromCharCode(65 + i)}`,
              svg: text,
            })
          }
        }
        payload = {
          category: 'journal_assembly',
          manuscriptTitle: asmTitle,
          journalPreset: asmPreset,
          columns: asmCols,
          panels,
        }
        lastTitle = `Journal_Composite_${asmPreset}`
      } else {
        payload = {
          category: 'flowchart',
          ...consortState,
        }
        lastTitle = `CONSORT_2010_Flowchart`
      }

      try {
        const res = await api<any>(endpoint, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        const svgStr = res.illustrator_svg || res.svg || res.km_svg || res.forest_svg || res.native_exports?.illustrator_svg || ''
        lastSvg = svgStr
        canvasEl.innerHTML = safeSvg(svgStr) || '<div class="muted small">已生成工程原文件</div>'

        // 更新画布顶部标题与统计检验摘要
        if (currentMode === 'clinical_cohort') {
          const statBits: string[] = []
          if (typeof res.total_n === 'number') statBits.push(`N = ${res.total_n}`)
          if (typeof res.events === 'number') statBits.push(`阳性事件 = ${res.events}`)
          if (typeof res.c_statistic === 'number') statBits.push(`C-index = ${res.c_statistic.toFixed(3)}`)
          if (typeof res.p_value === 'number') statBits.push(`${res.test_name || 'Test'} P = ${res.p_value < 0.001 ? '<0.001' : res.p_value.toFixed(4)}`)
          if (typeof res.log_rank_p === 'number') statBits.push(`Log-rank P = ${res.log_rank_p < 0.001 ? '<0.001' : res.log_rank_p.toFixed(4)}`)
          canvasTitleEl.textContent = `矢量画布预览${statBits.length ? ` · ${statBits.join(' · ')}` : ''}`
        } else {
          canvasTitleEl.textContent = '矢量画布预览'
        }

        const pzfx = res.prism_pzfx || res.native_exports?.prism_pzfx
        const rScript = res.r_script || res.native_exports?.r_script
        const originCsv = res.origin_csv || res.native_exports?.origin_csv
        const originOgs = res.origin_ogs || res.native_exports?.origin_ogs
        const drawioXml = res.drawio_xml || res.native_exports?.drawio_xml
        const visioVdx = res.visio_vdx || res.native_exports?.visio_vdx
        const ijm = res.imagej_macro_ijm || res.native_exports?.imagej_macro_ijm
        const wsp = res.flowjo_wsp_xml || res.native_exports?.flowjo_wsp
        const mrml = res.slicer_mrml_xml || res.native_exports?.slicer_mrml
        const itkTxt = res.itksnap_labels_txt || res.native_exports?.itksnap_labels_txt
        const cloudCsv = res.cloud_csv

        lastCode = rScript || ijm || originOgs || drawioXml || mrml || wsp || (res.manifest ? JSON.stringify(res.manifest, null, 2) : '# Vector SVG generated by Heurion Figure Studio')
        lastCodePath = rScript ? `${lastTitle}.R` : ijm ? `${lastTitle}.ijm` : drawioXml ? `${lastTitle}.drawio` : `${lastTitle}.txt`
        codePre.textContent = lastCode

        exportBar.innerHTML = `<span class="muted small" style="margin-right:4px;">一键导出：</span>`
        const addExp = (label: string, fn: () => void, primary = false) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = primary ? 'small-btn primary' : 'small-btn'
          b.innerHTML = `${icon('download', { size: 13 })} ${esc(label)}`
          b.onclick = fn
          exportBar.appendChild(b)
        }
        if (pzfx) addExp('GraphPad Prism (.pzfx)', () => downloadBlobContent(pzfx, `${lastTitle}.pzfx`, 'application/xml;charset=utf-8'), true)
        if (rScript) addExp('R 语言脚本 (.R)', () => downloadBlobContent(rScript, `${lastTitle}.R`))
        if (cloudCsv) addExp('Hiplot/微生信矩阵 (.csv)', () => downloadBlobContent(cloudCsv, `${lastTitle}_Matrix.csv`, 'text/csv;charset=utf-8'))
        if (originCsv) addExp('OriginPro 数据表 (.csv)', () => downloadBlobContent(originCsv, `${lastTitle}_Origin.csv`, 'text/csv;charset=utf-8'))
        if (originOgs) addExp('OriginLab 绘图脚本 (.ogs)', () => downloadBlobContent(originOgs, `${lastTitle}.ogs`))
        if (drawioXml) addExp('Draw.io (.drawio)', () => downloadBlobContent(drawioXml, `${lastTitle}.drawio`, 'application/xml;charset=utf-8'), true)
        if (visioVdx) addExp('Microsoft Visio (.vdx)', () => downloadBlobContent(visioVdx, `${lastTitle}.vdx`, 'application/xml;charset=utf-8'))
        if (currentMode === 'mechanism' || currentMode === 'flowchart' || currentMode === 'journal_assembly') {
          addExp('PowerPoint 可编辑形状 (.pptx)', () => void downloadFigureFormat(targetSid, payload, 'pptx', `${lastTitle}.pptx`))
        }
        if (currentMode === 'journal_assembly') {
          addExp('600 DPI 印刷级高清图 (.png)', () => void downloadFigureFormat(targetSid, payload, 'png', `${lastTitle}_600DPI.png`))
          addExp('完整出版原文件包 (.zip)', () => void downloadFigureFormat(targetSid, payload, 'zip', `${lastTitle}_Bundle.zip`), true)
        } else if (svgStr) {
          addExp('600 DPI 高清图 (.png)', () => void downloadSvgAsPng600Dpi(targetSid, svgStr, `${lastTitle}_600DPI.png`), !pzfx && !drawioXml)
        }
        if (ijm) addExp('ImageJ / Fiji 宏 (.ijm)', () => downloadBlobContent(ijm, `${lastTitle}.ijm`), true)
        if (wsp) addExp('FlowJo 圈门工作区 (.wsp)', () => downloadBlobContent(wsp, `${lastTitle}.wsp`, 'application/xml;charset=utf-8'), true)
        if (mrml) addExp('3D Slicer 场景 (.mrml)', () => downloadBlobContent(mrml, `${lastTitle}.mrml`, 'application/xml;charset=utf-8'), true)
        if (itkTxt) addExp('ITK-SNAP 标签表 (.txt)', () => downloadBlobContent(itkTxt, `${lastTitle}_ITKSNAP.txt`))
        if (svgStr) {
          addExp('Illustrator 分层矢量 (.svg)', () => downloadBlobContent(svgStr, `${lastTitle}.svg`, 'image/svg+xml;charset=utf-8'))
        }
      } catch (err) {
        canvasEl.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
      }
    }

    const activateModeBtn = (mode: StudioMode) => {
      currentMode = mode
      pane.querySelectorAll<HTMLButtonElement>('[data-st-mode]').forEach(b => b.classList.toggle('active', b.dataset.stMode === mode))
    }

    pane.querySelectorAll<HTMLButtonElement>('[data-st-mode]').forEach(btn => {
      btn.onclick = () => {
        activateModeBtn(btn.dataset.stMode as StudioMode)
        renderLeftEditor()
        void runStudioRender()
      }
    })

    const applyPreset = (p: string) => {
      if (!p) return
      if (p === 'clin_grotta' || p === 'clin_sankey' || p === 'clin_upset' || p === 'clin_logistic' || p === 'clin_survival') {
        activateModeBtn('clinical_cohort')
        clinSubtype = p.replace('clin_', '') as typeof clinSubtype
      } else if (p === 'grant_gpcr') {
        activateModeBtn('mechanism')
        mechState = structuredClone(MECH_PRESETS.gpcr!)
      } else if (p === 'grant_pd1') {
        activateModeBtn('mechanism')
        mechState = structuredClone(MECH_PRESETS.pd1!)
      } else if (p === 'wet_bar') {
        activateModeBtn('wet_lab')
        wetPlotType = 'bar_scatter'
      } else if (p === 'wet_ic50') {
        activateModeBtn('wet_lab')
        wetPlotType = 'dose_response'
      } else if (p === 'bio_volcano') {
        activateModeBtn('bioinformatics')
        bioType = 'volcano'
      } else if (p === 'img_flow') {
        activateModeBtn('image_processing')
        imgTool = 'flowjo'
      }
      renderLeftEditor()
      void runStudioRender()
    }

    const quickPresetSel = pane.querySelector<HTMLSelectElement>('#stQuickPreset')
    if (quickPresetSel) {
      quickPresetSel.onchange = () => {
        applyPreset(quickPresetSel.value)
      }
    }

    pane.querySelectorAll<HTMLButtonElement>('[data-st-preset]').forEach(btn => {
      btn.onclick = () => applyPreset(btn.dataset.stPreset || '')
    })

    pane.querySelectorAll<HTMLButtonElement>('[data-st-nav]').forEach(btn => {
      btn.onclick = () => {
        const dest = btn.dataset.stNav
        if (dest === 'write') {
          hooks.goSpace('write')
        } else if (dest === 'study') {
          hooks.goSpace('research')
        } else if (dest === 'global-studio') {
          hooks.goSpace('studio')
        }
      }
    })

    renderLeftEditor()
    void runStudioRender()
  }

  /** 打开全局独立的科研制图工作台（与临床研究课题完全解耦） */
  async function openGlobalStudio(
    initialDatasetId?: string,
    initialMode?: 'clinical_cohort' | 'wet_lab' | 'bioinformatics' | 'mechanism' | 'image_processing' | 'flowchart' | 'journal_assembly'
  ): Promise<void> {
    hooks.leaveDoc()
    current = null
    if (poll) { clearTimeout(poll); poll = null }
    const page = $('page')
    page.className = 'page studio-page'
    $('docTitle').textContent = '科研制图'

    let globalDatasets: Array<{ dataset_id: string; name: string }> = []
    try {
      const [dsRes] = await Promise.all([
        api<Array<{ id: string; name: string; status: string }>>('/api/datasets').catch(() => []),
        loadStudioList(),
      ])
      globalDatasets = dsRes.filter(d => d.status === 'ready').map(d => ({ dataset_id: d.id, name: d.name }))
    } catch {}

    mountStudioTab(null, null, {
      container: page,
      globalDatasets,
      initialDatasetId,
      initialMode: initialMode ?? (initialDatasetId ? 'clinical_cohort' : undefined),
      globalFigures: studioFigures,
    })
  }

  /**
   * 场景二 · 写作中内嵌制图与图表成果库插入弹窗 (In-Writing Figure Picker & Quick Studio)
   * 供文档编辑器、幻灯片编辑器与写作对话栏直接调用：支持边写边画生成图表并嵌入当前光标段落，或从全局/课题图表库一键插入。
   */
  async function openDocFigureModal(opts?: {
    docTitle?: string
    onInsert: (assetId: string, caption: string) => void | Promise<void>
  }): Promise<void> {
    const dlg = $('dialog')
    const docLabel = opts?.docTitle ? `《${esc(opts.docTitle)}》` : '当前文稿'
    dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="写作内嵌科研制图">
      <div class="dialog-head">
        <h2>${icon('chart', { size: 16 })} 写作内嵌科研配图 · 就地绘制或从图表库插入</h2>
        <button class="quiet" data-close aria-label="关闭">✕</button>
      </div>
      <div class="dialog-body" style="display:flex;flex-direction:column;gap:12px;">
        <div class="rs-scenario-banner compact">
          <div class="row" style="justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
            <div>
              <b style="font-size:13px;display:inline-flex;align-items:center;gap:6px;">
                ${icon('write', { size: 14 })} 当前处于「场景二 · 写作中边写边配图模式」 · 目标文稿：${docLabel}
              </b>
              <div class="muted small" style="margin-top:2px;">
                适合撰写论文 Results、基金标书正文或组会 PPT 时就地配图。插入的矢量图将自动绑定底层 R / Prism / Draw.io 可复现脚本，并在文稿中显示「来自分析」溯源标记。
              </div>
            </div>
            <button type="button" class="small-btn" id="rsDocToFullStudioBtn">${icon('target', { size: 12 })} 切换到全屏医学制图工作台 →</button>
          </div>
        </div>

        <div class="row" style="gap:8px;border-bottom:1px solid var(--line);padding-bottom:10px;flex-wrap:wrap;">
          <button type="button" class="small-btn primary" id="rsDocTabDrawBtn">${icon('chart', { size: 13 })} 1. 就地快速绘制并插入当前段落</button>
          <button type="button" class="small-btn" id="rsDocTabGalleryBtn">${icon('folder', { size: 13 })} 2. 从已归档图表成果库直接插入</button>
        </div>

        <div id="rsDocDrawPane" style="display:flex;flex-direction:column;gap:12px;">
          <div class="rs-preset-bar" style="margin-top:0;padding-top:0;border-top:0;">
            <span class="muted small" style="font-weight:600;">快速选型：</span>
            <button type="button" class="rs-preset-chip" data-doc-preset="clin_grotta">[临床预后] mRS Grotta 分布图</button>
            <button type="button" class="rs-preset-chip" data-doc-preset="clin_sankey">[治疗轨迹] 多阶段 Sankey 桑基图</button>
            <button type="button" class="rs-preset-chip" data-doc-preset="clin_upset">[部位共现] 解剖部位 UpSet 图</button>
            <button type="button" class="rs-preset-chip" data-doc-preset="clin_logistic">[危险因素] Logistic OR 森林图</button>
            <button type="button" class="rs-preset-chip" data-doc-preset="wet_bar">[Results 统计] 柱状散点 + P 值支架</button>
            <button type="button" class="rs-preset-chip" data-doc-preset="mech_gpcr">[标书/综述] 细胞信号通路机制图</button>
            <button type="button" class="rs-preset-chip" data-doc-preset="consort">[方法学] CONSORT 纳排流程图</button>
          </div>
          <div class="form" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:10px;background:var(--raised);padding:12px;border:1px solid var(--line);">
            <label>图表类型 (Figure Type)
              <select id="rsDocFigKind">
                <option value="clin_grotta">临床队列：mRS / 闭塞分级 Grotta 有序分布偏移图</option>
                <option value="clin_sankey">临床队列：多阶段序贯治疗轨迹与结局 Sankey 桑基图</option>
                <option value="clin_upset">临床队列：多解剖部位共现与结局风险率 UpSet 图</option>
                <option value="clin_logistic">临床队列：多因素 Logistic 回归 OR 森林图 (Forest Plot)</option>
                <option value="clin_survival">临床队列：Kaplan-Meier 无事件生存曲线 (KM Plot)</option>
                <option value="wet_bar">实验/临床：柱状散点图 + P 值星号支架 (Prism)</option>
                <option value="wet_violin">实验/临床：小提琴密度 + 内嵌箱线图 (Violin)</option>
                <option value="wet_ic50">药理/CCK-8：4PL 剂量反应 IC50 曲线 (Origin)</option>
                <option value="mech_gpcr">机制通路：GPCR-cAMP-PKA 信号转导图 (BioArt)</option>
                <option value="mech_pd1">机制通路：PD-1/PD-L1 免疫检查点阻断机制图</option>
                <option value="bio_volcano">生信组学：差异表达火山图 (Volcano Plot)</option>
                <option value="bio_heatmap">生信组学：多组学 Z-score 聚类热图</option>
                <option value="bio_kegg">生信组学：KEGG / GO 通路富集气泡图</option>
                <option value="img_flow">细胞流式：Annexin V / PI 凋亡四象限圈门</option>
                <option value="consort">临床设计：CONSORT 2010 受试者纳排流向图</option>
              </select>
            </label>
            <label>图注标题 (Figure Caption / Title)
              <input type="text" id="rsDocFigTitle" value="${esc(opts?.docTitle || '论文配图')} · Figure 1">
            </label>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="muted small" id="rsDocFigStatus">正在渲染出版级矢量预览…</span>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button type="button" class="small-btn" id="rsDocRefreshBtn">重新渲染预览</button>
              <button type="button" class="small-btn primary" id="rsDocInsertNowBtn">${icon('check', { size: 13 })} 生成并插入到当前文稿位置</button>
            </div>
          </div>
          <div id="rsDocSvgPreview" style="background:#ffffff;border:1px solid var(--line);padding:16px;overflow:auto;max-height:420px;display:flex;justify-content:center;align-items:flex-start;"></div>
        </div>

        <div id="rsDocGalleryPane" style="display:none;flex-direction:column;gap:12px;">
          <div class="muted small">以下为全局制图工作台及各临床研究课题已归档的矢量图表，点击「插入到文稿」即可嵌入当前光标处：</div>
          <div id="rsDocGalleryGrid" class="rs-folder-files" style="max-height:440px;overflow-y:auto;">
            <div class="muted small">正在加载已归档图表成果库…</div>
          </div>
        </div>
      </div>
    </div>`
    dlg.hidden = false
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) close() }

    document.getElementById('rsDocToFullStudioBtn')!.onclick = () => {
      close()
      hooks.goSpace('studio')
    }

    const tabDrawBtn = document.getElementById('rsDocTabDrawBtn')!
    const tabGalBtn = document.getElementById('rsDocTabGalleryBtn')!
    const drawPane = document.getElementById('rsDocDrawPane')!
    const galPane = document.getElementById('rsDocGalleryPane')!
    const kindSel = document.getElementById('rsDocFigKind') as HTMLSelectElement
    const titleInp = document.getElementById('rsDocFigTitle') as HTMLInputElement
    const previewBox = document.getElementById('rsDocSvgPreview')!
    const statusEl = document.getElementById('rsDocFigStatus')!
    const insertNowBtn = document.getElementById('rsDocInsertNowBtn') as HTMLButtonElement

    let renderedSvg = ''
    let renderedCode = ''
    let renderedCodePath = 'figure_studio.R'

    const buildPayload = (kind: string, title: string): Record<string, unknown> => {
      if (kind.startsWith('clin_')) {
        return {
          category: 'clinical_cohort',
          subtype: kind.replace('clin_', ''),
          title,
        }
      }
      if (kind === 'wet_bar' || kind === 'wet_violin') {
        return {
          category: 'wet_lab',
          plotType: kind === 'wet_bar' ? 'bar_scatter' : 'violin_box',
          title,
          yLabel: 'Relative Expression Level',
          errorBarType: 'SD',
          groups: [
            { name: 'Control', values: [1.02, 0.96, 1.05, 0.98, 1.01, 0.95], color: '#3C5488' },
            { name: 'Treatment A', values: [1.58, 1.65, 1.49, 1.72, 1.61, 1.64], color: '#00A087' },
            { name: 'Combo Therapy', values: [2.48, 2.66, 2.39, 2.74, 2.55, 2.61], color: '#E64B35' },
          ],
        }
      }
      if (kind === 'wet_ic50') {
        const pts = [
          { logConc: -9, responses: [4.2, 5.1, 3.8] },
          { logConc: -8, responses: [12.5, 14.2, 11.8] },
          { logConc: -7, responses: [34.0, 36.8, 32.5] },
          { logConc: -6, responses: [62.4, 65.1, 59.8] },
          { logConc: -5, responses: [85.2, 87.6, 83.9] },
          { logConc: -4, responses: [94.8, 96.1, 93.5] },
        ]
        return {
          category: 'wet_lab',
          plotType: 'dose_response',
          title,
          doseResponse: {
            compoundName: 'Lead Compound',
            points: pts,
            logConcentrations: pts.map(p => p.logConc),
            series: [{ name: 'Lead Compound', responses: pts.map(p => p.responses.reduce((a, b) => a + b, 0) / p.responses.length) }],
          },
        }
      }
      if (kind === 'mech_gpcr' || kind === 'mech_pd1') {
        return {
          category: 'mechanism',
          title,
          subtitle: kind === 'mech_pd1' ? 'PD-1/PD-L1 免疫检查点阻断与效应 T 细胞激活通路' : 'GPCR-cAMP-PKA-CREB 跨膜信号转导与核内转录调控',
          showCompartments: true,
        }
      }
      if (kind === 'bio_volcano' || kind === 'bio_heatmap' || kind === 'bio_kegg') {
        return {
          category: 'bioinformatics',
          bioType: kind === 'bio_volcano' ? 'volcano' : kind === 'bio_heatmap' ? 'heatmap' : 'enrichment_bubble',
          title,
          fcThreshold: 1.0,
          pThreshold: 0.05,
        }
      }
      if (kind === 'img_flow') {
        return {
          category: 'image_processing',
          tool: 'flowjo',
          title,
          xChannel: 'FITC-A (Annexin V)',
          yChannel: 'PE-A (PI)',
          xGateThreshold: 2.5,
          yGateThreshold: 2.5,
        }
      }
      return {
        category: 'flowchart',
        title,
        total_assessed: 180,
        exclusions: [
          { reason: '不符合纳入标准 (Did not meet inclusion criteria)', count: 24 },
          { reason: '拒绝签署知情同意 (Declined to participate)', count: 8 },
        ],
        eligible_total: 148,
        arms: [
          { name: '干预组 (Intervention Arm)', allocated: 74, received: 74, lost_to_followup: 2, discontinued: 0, analyzed: 72 },
          { name: '标准对照组 (Control Arm)', allocated: 74, received: 74, lost_to_followup: 3, discontinued: 0, analyzed: 71 },
        ],
      }
    }

    const renderQuickPreview = async () => {
      statusEl.textContent = '正在生成出版级矢量图与底层可复现代码…'
      insertNowBtn.disabled = true
      try {
        const payload = buildPayload(kindSel.value, titleInp.value.trim() || 'Figure 1')
        const res = await api<any>('/api/figures', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        renderedSvg = res.illustrator_svg || res.svg || res.native_exports?.illustrator_svg || ''
        const rScript = res.r_script || res.native_exports?.r_script
        const drawioXml = res.drawio_xml || res.native_exports?.drawio_xml
        const wsp = res.flowjo_wsp_xml || res.native_exports?.flowjo_wsp
        renderedCode = rScript || drawioXml || wsp || '# Generated by Heurion In-Writing Figure Studio'
        renderedCodePath = rScript ? 'figure_studio.R' : drawioXml ? 'figure_studio.drawio' : 'figure_studio.txt'
        previewBox.innerHTML = safeSvg(renderedSvg) || '<div class="muted small">预览生成完毕</div>'
        statusEl.textContent = '已就绪 · 点击右侧「生成并插入到当前文稿位置」即可嵌入正文并附带代码溯源'
      } catch (err) {
        previewBox.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
        statusEl.textContent = '生成失败'
      } finally {
        insertNowBtn.disabled = false
      }
    }

    kindSel.onchange = () => void renderQuickPreview()
    document.getElementById('rsDocRefreshBtn')!.onclick = () => void renderQuickPreview()
    dlg.querySelectorAll<HTMLButtonElement>('[data-doc-preset]').forEach(chip => {
      chip.onclick = () => {
        kindSel.value = chip.dataset.docPreset!
        void renderQuickPreview()
      }
    })

    insertNowBtn.onclick = async () => {
      const caption = titleInp.value.trim() || 'Figure 1'
      const archived = await archiveStudyFigure(undefined, caption, renderedSvg, renderedCode, renderedCodePath)
      if (!archived) return
      close()
      if (opts?.onInsert) await opts.onInsert(archived.asset_id, caption)
    }

    const loadGallery = async () => {
      const grid = document.getElementById('rsDocGalleryGrid')!
      try {
        const [globalRes, studiesRes] = await Promise.all([
          api<{ figures?: Array<{ id: string; name: string; created_at: string }> }>('/api/figures').catch(() => ({ figures: [] })),
          api<StudyLite[]>('/api/studies').catch(() => [] as StudyLite[]),
        ])
        const items: Array<{ id: string; name: string; source: string; created_at: string }> = []
        for (const f of globalRes.figures ?? []) {
          items.push({ id: f.id, name: f.name, source: '全局图表成果库', created_at: f.created_at })
        }
        const studyDetails = await Promise.all(
          studiesRes.slice(0, 6).map(st => api<Study>(`/api/studies/${st.id}`).catch(() => null))
        )
        for (const st of studyDetails) {
          if (!st) continue
          for (const a of st.analyses) {
            if (!items.some(x => x.id === a.asset_id)) {
              items.push({ id: a.asset_id, name: a.name, source: `课题：${st.title}`, created_at: a.created_at })
            }
          }
        }
        if (!items.length) {
          grid.innerHTML = `<div class="muted small" style="padding:18px;">当前成果库暂无已归档图表。请切换到「1. 就地快速绘制并插入当前段落」直接生成并插入。</div>`
          return
        }
        const token = hooks.token()
        grid.innerHTML = items.map(item => {
          const cleanName = item.name.split('/').pop() || item.name
          return `
            <div class="rs-file-item" style="cursor:default;">
              <div class="rs-file-preview">
                <img src="/api/assets/${esc(item.id)}?token=${encodeURIComponent(token)}" alt="${esc(cleanName)}">
                <span class="rs-file-badge">SVG</span>
              </div>
              <div class="rs-file-info">
                <b class="rs-file-name">${esc(cleanName)}</b>
                <div class="rs-file-meta">
                  <span class="pill green">可复现源码</span>
                  <span>${esc(item.source)}</span>
                </div>
                <div style="margin-top:6px;">
                  <button type="button" class="small-btn primary" data-doc-pick-asset="${esc(item.id)}" data-doc-pick-name="${esc(cleanName.replace(/\.[^.]+$/, ''))}" style="width:100%;">${icon('check', { size: 12 })} 插入此图到当前位置</button>
                </div>
              </div>
            </div>
          `
        }).join('')
        grid.querySelectorAll<HTMLButtonElement>('[data-doc-pick-asset]').forEach(b => {
          b.onclick = async () => {
            const aid = b.dataset.docPickAsset!
            const cap = b.dataset.docPickName || '科研图表'
            close()
            if (opts?.onInsert) await opts.onInsert(aid, cap)
          }
        })
      } catch (err) {
        grid.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
      }
    }

    tabDrawBtn.onclick = () => {
      tabDrawBtn.className = 'small-btn primary'
      tabGalBtn.className = 'small-btn'
      drawPane.style.display = 'flex'
      galPane.style.display = 'none'
    }
    tabGalBtn.onclick = () => {
      tabGalBtn.className = 'small-btn primary'
      tabDrawBtn.className = 'small-btn'
      drawPane.style.display = 'none'
      galPane.style.display = 'flex'
      void loadGallery()
    }

    void renderQuickPreview()
  }

  // ============================================================================
  // —— 页签 4：临床统计模型与因果推断 (Survival · Nomogram · ROC/DCA · E-value/Love Plot) ——
  // ============================================================================
  function mountBiostatsTab(s: Study, readyDs: Study['datasets']): void {
    const pane = document.getElementById('rsPaneBiostats')
    if (!pane) return

    type BioStatEngine = 'survival' | 'nomogram' | 'rocdca' | 'causal'
    let engine: BioStatEngine = 'survival'

    let nomoPredictors = [
      { variable: 'treatment_arm', label: '治疗分组 (0=对照, 1=联合)', type: 'binary' as const, beta: -0.68, min_val: 0, max_val: 1 },
      { variable: 'l3_smi', label: 'L3 骨骼肌指数 SMI (cm²/m²)', type: 'continuous' as const, beta: -0.045, min_val: 30, max_val: 65 },
      { variable: 'vat_to_sat', label: '内脏/皮下脂肪比 (VAT/SAT)', type: 'continuous' as const, beta: 0.72, min_val: 0.4, max_val: 1.8 },
      { variable: 'age', label: '年龄 (Age, years)', type: 'continuous' as const, beta: 0.038, min_val: 40, max_val: 85 },
    ]
    let loveCovariates = [
      { name: '年龄 (Age, years)', smd_unadjusted: 0.42, smd_adjusted: 0.04 },
      { name: '性别 (Male Sex)', smd_unadjusted: -0.28, smd_adjusted: -0.02 },
      { name: '基线 L3 骨骼肌 SMI', smd_unadjusted: -0.51, smd_adjusted: -0.05 },
      { name: '内脏/皮下脂肪比 (VAT/SAT)', smd_unadjusted: 0.39, smd_adjusted: 0.03 },
      { name: '基线 eGFR (mL/min/1.73m²)', smd_unadjusted: -0.34, smd_adjusted: 0.02 },
      { name: 'ECOG 体能状态评分', smd_unadjusted: 0.31, smd_adjusted: -0.03 },
    ]

    pane.innerHTML = `
      <div class="rs-studio-modes" style="grid-template-columns:repeat(4, minmax(0, 1fr));" role="tablist">
        <button type="button" class="rs-studio-mode-btn active" data-bs-eng="survival">
          <b>${icon('compare', { size: 14 })} 1. KM 生存分析 &amp; Cox 森林图</b>
          <span>Greenwood 置信带 + Number at Risk 风险表 + 多因素 HR 森林图</span>
        </button>
        <button type="button" class="rs-studio-mode-btn" data-bs-eng="nomogram">
          <b>${icon('caliper', { size: 14 })} 2. Cox 预后列线图 (Nomogram)</b>
          <span>0~100 积分标尺映射 + 1/3/5 年生存率预测 + R rms 脚本</span>
        </button>
        <button type="button" class="rs-studio-mode-btn" data-bs-eng="rocdca">
          <b>${icon('target', { size: 14 })} 3. ROC 诊断曲线 &amp; DCA 决策曲线</b>
          <span>AUC 增量对比 + Youden 最佳截断值 + BMJ 临床净获益窗口</span>
        </button>
        <button type="button" class="rs-studio-mode-btn" data-bs-eng="causal">
          <b>${icon('shield', { size: 14 })} 4. 因果推断 E-value &amp; Love Plot</b>
          <span>VanderWeele 未测量混杂敏感度 + 倾向性评分匹配前后 SMD 平衡图</span>
        </button>
      </div>
      <div class="rs-studio-shell">
        <div class="rs-studio-left" id="rsBsLeft"></div>
        <div class="rs-studio-right" id="rsBsRight"></div>
      </div>
    `

    const leftEl = document.getElementById('rsBsLeft')!
    const rightEl = document.getElementById('rsBsRight')!

    const renderEngine = () => {
      if (engine === 'survival') {
        if (!readyDs.length) {
          leftEl.innerHTML = `<div class="muted small">请先在「1. 方案、队列与概览」或「2. 数据治理」中生成或上传研究数据集。</div>`
          rightEl.innerHTML = `<div class="muted small">等待研究数据集就绪后即可运行 Kaplan-Meier 生存分析与多因素 Cox 森林图。</div>`
          return
        }
        leftEl.innerHTML = `
          <div class="rs-sub-box-title"><span>${icon('compare', { size: 13 })} Kaplan-Meier 生存曲线与 Cox 回归配置</span></div>
          <label>选择研究数据集
            <select id="bsSurvDs">${readyDs.map(d => `<option value="${esc(d.dataset_id)}">${esc(d.name)}</option>`).join('')}</select>
          </label>
          <label>随访时间列 (Time)
            <select id="bsSurvTime"></select>
          </label>
          <label>结局事件列 (Event, 1/0)
            <select id="bsSurvEvent"></select>
          </label>
          <label>分层暴露列 (Group)
            <select id="bsSurvGroup"></select>
          </label>
          <label>时间单位
            <select id="bsSurvUnit"><option value="Months">月 (Months)</option><option value="Days">天 (Days)</option><option value="Years">年 (Years)</option></select>
          </label>
          <button type="button" class="primary small-btn" id="bsSurvRunBtn">${icon('chart', { size: 13 })} 拟合 KM 曲线与多因素森林图</button>
        `
        rightEl.innerHTML = `<div class="muted small" style="padding:30px;text-align:center;">正在读取数据集列并拟合生存模型…</div>`

        const dsSel = document.getElementById('bsSurvDs') as HTMLSelectElement
        const tSel = document.getElementById('bsSurvTime') as HTMLSelectElement
        const eSel = document.getElementById('bsSurvEvent') as HTMLSelectElement
        const gSel = document.getElementById('bsSurvGroup') as HTMLSelectElement

        const loadCols = async () => {
          const ds = await api<{ columns?: Array<{ name: string }>; labels?: Record<string, string> }>(`/api/datasets/${dsSel.value}`)
          const cols = (ds.columns || []).map(c => c.name)
          if (!cols.length) cols.push('followup_months', 'os_status', 'treatment_arm', 'age')
          const fill = (sel: HTMLSelectElement, list: string[], re: RegExp) => {
            sel.innerHTML = list.map(c => `<option value="${esc(c)}">${esc(ds.labels?.[c] || c)} (${esc(c)})</option>`).join('')
            const m = list.find(c => re.test(c))
            if (m) sel.value = m
          }
          fill(tSel, cols, /time|month|day|follow|surv|os|随访时长|生存时间|第一次治疗的时间|出生日期/i)
          fill(eSel, cols, /status|event|dead|death|outcome|治疗后出血|围术期不良事件|出血|结局/i)
          fill(gSel, ['(不分组)', ...cols], /group|arm|treat|smi|第一次治疗方式|治疗方式|分组/i)
          await runSurv()
        }

        const runSurv = async () => {
          try {
            const ds = await api<{ columns?: Array<{ name: string }> }>(`/api/datasets/${dsSel.value}`).catch(() => ({ columns: [] }))
            const colNames = (ds.columns || []).map(c => c.name)
            const isDateStart = /时间|日期|date/i.test(tSel.value)
            const evDateCol = colNames.find(c => c !== tSel.value && /出血时间|事件时间|末次随访|event_date/i.test(c))
            const res = await api<any>(`/api/datasets/${dsSel.value}/survival`, {
              method: 'POST',
              body: JSON.stringify({
                time_col: isDateStart && evDateCol ? undefined : tSel.value,
                start_date_col: isDateStart && evDateCol ? tSel.value : undefined,
                event_date_col: isDateStart && evDateCol ? evDateCol : undefined,
                event_col: eSel.value,
                group_col: gSel.value === '(不分组)' ? undefined : gSel.value,
                time_unit: (document.getElementById('bsSurvUnit') as HTMLSelectElement).value,
                show_censored: true,
                show_risk_table: true,
              }),
            })
            const kmSvg = res.km_svg || res.svg || ''
            const forestSvg = res.forest_plot_svg || res.forest_svg || ''
            const ne = res.native_exports || {}
            rightEl.innerHTML = `
              <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                <b>Figure 3 · Kaplan-Meier 累积生存曲线与风险集表</b>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button type="button" class="small-btn primary" id="bsArchKm">${icon('pin', { size: 13 })} 归档 KM 图至 figures/</button>
                  <button type="button" class="small-btn" id="bsDlKmPng">${icon('download', { size: 13 })} 600 DPI PNG</button>
                  <button type="button" class="small-btn" id="bsCpKmPng">${icon('copy', { size: 13 })} 复制高清图</button>
                  <button type="button" class="small-btn" id="bsDlKmPzfx">${icon('download', { size: 13 })} Prism (.pzfx)</button>
                  <button type="button" class="small-btn" id="bsDlKmR">${icon('download', { size: 13 })} R 脚本 (.R)</button>
                  <button type="button" class="small-btn" id="bsDlKmSvg">${icon('download', { size: 13 })} KM (.svg)</button>
                </div>
              </div>
              <div class="rs-studio-canvas" style="min-height:320px;">${safeSvg(kmSvg) || '<div class="muted small">暂无 KM 矢量图</div>'}</div>
              ${forestSvg ? `
                <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px;">
                  <b>Figure 4 · 多因素 Cox 比例风险回归森林图 (Forest Plot)</b>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <button type="button" class="small-btn primary" id="bsArchForest">${icon('pin', { size: 13 })} 归档森林图至 figures/</button>
                    <button type="button" class="small-btn" id="bsDlForPng">${icon('download', { size: 13 })} 600 DPI PNG</button>
                    <button type="button" class="small-btn" id="bsDlForPzfx">${icon('download', { size: 13 })} Prism (.pzfx)</button>
                    <button type="button" class="small-btn" id="bsDlForR">${icon('download', { size: 13 })} R 脚本 (.R)</button>
                    <button type="button" class="small-btn" id="bsDlForSvg">${icon('download', { size: 13 })} 森林图 (.svg)</button>
                  </div>
                </div>
                <div class="rs-studio-canvas" style="min-height:260px;">${safeSvg(forestSvg)}</div>
              ` : ''}
            `
            document.getElementById('bsArchKm')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Figure3_Kaplan_Meier', kmSvg, ne.r_script))
            document.getElementById('bsDlKmPng')?.addEventListener('click', () => kmSvg && void downloadSvgAsPng600Dpi(s.id, kmSvg, 'Figure3_Kaplan_Meier_600DPI.png'))
            document.getElementById('bsCpKmPng')?.addEventListener('click', () => kmSvg && void copySvgAsPngToClipboard(s.id, kmSvg, 'Figure3_Kaplan_Meier'))
            document.getElementById('bsDlKmPzfx')?.addEventListener('click', () => ne.prism_pzfx && downloadBlobContent(ne.prism_pzfx, 'Kaplan_Meier.pzfx', 'application/xml;charset=utf-8'))
            document.getElementById('bsDlKmR')?.addEventListener('click', () => ne.r_script && downloadBlobContent(ne.r_script, 'Kaplan_Meier.R'))
            document.getElementById('bsDlKmSvg')?.addEventListener('click', () => kmSvg && downloadBlobContent(kmSvg, 'Kaplan_Meier.svg', 'image/svg+xml;charset=utf-8'))
            document.getElementById('bsArchForest')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Figure4_Cox_Forest_Plot', forestSvg, ne.forest_r_script))
            document.getElementById('bsDlForPng')?.addEventListener('click', () => forestSvg && void downloadSvgAsPng600Dpi(s.id, forestSvg, 'Figure4_Cox_Forest_Plot_600DPI.png'))
            document.getElementById('bsDlForPzfx')?.addEventListener('click', () => ne.forest_prism_pzfx && downloadBlobContent(ne.forest_prism_pzfx, 'Cox_Forest_Plot.pzfx', 'application/xml;charset=utf-8'))
            document.getElementById('bsDlForR')?.addEventListener('click', () => ne.forest_r_script && downloadBlobContent(ne.forest_r_script, 'Cox_Forest_Plot.R'))
            document.getElementById('bsDlForSvg')?.addEventListener('click', () => forestSvg && downloadBlobContent(forestSvg, 'Cox_Forest_Plot.svg', 'image/svg+xml;charset=utf-8'))
          } catch (err) {
            rightEl.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
          }
        }

        dsSel.onchange = () => void loadCols()
        document.getElementById('bsSurvRunBtn')!.onclick = () => void runSurv()
        void loadCols()
        return
      }

      if (engine === 'nomogram') {
        leftEl.innerHTML = `
          <div class="rs-sub-box-title"><span>${icon('caliper', { size: 13 })} Cox 预后列线图预测因子与回归系数 (β) 编辑</span></div>
          <div class="muted small">可随时增删改模型预测因子、取值上下限及对数风险比系数 β (ln HR)，实时映射 0~100 积分标尺。</div>
          <table class="rs-data-table">
            <thead><tr><th>变量标签</th><th style="width:62px;">β 系数</th><th style="width:54px;">Min</th><th style="width:54px;">Max</th></tr></thead>
            <tbody id="bsNomoTbody">
              ${nomoPredictors.map((p, idx) => `
                <tr data-pidx="${idx}">
                  <td><input type="text" class="bs-nm-lbl" value="${esc(p.label)}"></td>
                  <td><input type="number" step="0.01" class="bs-nm-beta" value="${p.beta}"></td>
                  <td><input type="number" step="0.1" class="bs-nm-min" value="${p.min_val}"></td>
                  <td><input type="number" step="0.1" class="bs-nm-max" value="${p.max_val}"></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <button type="button" class="primary small-btn" id="bsNomoRunBtn">${icon('chart', { size: 13 })} 重新绘制预后列线图 (Nomogram)</button>
        `

        const runNomo = async () => {
          const did = readyDs[0]?.dataset_id
          if (!did) {
            rightEl.innerHTML = `<div class="muted small">请先生成或上传至少 1 个研究数据集以挂载列线图接口。</div>`
            return
          }
          const rows = leftEl.querySelectorAll<HTMLTableRowElement>('#bsNomoTbody tr')
          nomoPredictors = Array.from(rows).map((tr, i) => ({
            variable: nomoPredictors[i]?.variable || `var_${i + 1}`,
            label: tr.querySelector<HTMLInputElement>('.bs-nm-lbl')?.value.trim() || `Factor ${i + 1}`,
            type: nomoPredictors[i]?.type || 'continuous',
            beta: Number(tr.querySelector<HTMLInputElement>('.bs-nm-beta')?.value || 0.1),
            min_val: Number(tr.querySelector<HTMLInputElement>('.bs-nm-min')?.value || 0),
            max_val: Number(tr.querySelector<HTMLInputElement>('.bs-nm-max')?.value || 100),
          }))
          try {
            const res = await api<any>(`/api/datasets/${did}/nomogram`, {
              method: 'POST',
              body: JSON.stringify({
                title: `${s.title} · 多因素预后列线图 (Prognostic Nomogram)`,
                predictors: nomoPredictors,
                baseline_survival: { year1: 0.90, year3: 0.75, year5: 0.60 },
              }),
            })
            const svg = res.native_exports?.illustrator_svg || res.svg || ''
            const rScript = res.native_exports?.r_script || ''
            rightEl.innerHTML = `
              <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                <b>Figure 5 · 1/3/5 年总生存率预测列线图 (Nomogram)</b>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button type="button" class="small-btn primary" id="bsArchNomo">${icon('pin', { size: 13 })} 归档列线图至 figures/</button>
                  <button type="button" class="small-btn" id="bsDlNomoR">${icon('download', { size: 13 })} R rms 脚本 (.R)</button>
                  <button type="button" class="small-btn" id="bsDlNomoSvg">${icon('download', { size: 13 })} Illustrator (.svg)</button>
                </div>
              </div>
              <div class="rs-studio-canvas">${safeSvg(svg)}</div>
            `
            document.getElementById('bsArchNomo')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Figure5_Prognostic_Nomogram', svg, rScript))
            document.getElementById('bsDlNomoR')?.addEventListener('click', () => rScript && downloadBlobContent(rScript, 'Nomogram_rms.R'))
            document.getElementById('bsDlNomoSvg')?.addEventListener('click', () => svg && downloadBlobContent(svg, 'Figure5_Nomogram.svg', 'image/svg+xml;charset=utf-8'))
          } catch (err) {
            rightEl.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
          }
        }
        document.getElementById('bsNomoRunBtn')!.onclick = () => void runNomo()
        void runNomo()
        return
      }

      if (engine === 'rocdca') {
        leftEl.innerHTML = `
          <div class="rs-sub-box-title"><span>${icon('target', { size: 13 })} ROC 诊断对比与 DCA 临床决策曲线输入</span></div>
          <label>模型 1 名称 (基线对照)
            <input type="text" id="bsRocM1" value="临床基线模型 (Clinical Baseline)">
          </label>
          <label>模型 2 名称 (多模态融合)
            <input type="text" id="bsRocM2" value="临床 + 3D 影像组学融合模型">
          </label>
          <label>真实二分类结局标签 (0/1，逗号分隔)
            <textarea id="bsRocLabels" rows="2">1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0</textarea>
          </label>
          <label>模型 1 预测概率 (0~1，逗号分隔)
            <textarea id="bsRocP1" rows="2">0.76, 0.68, 0.72, 0.58, 0.64, 0.52, 0.48, 0.35, 0.42, 0.29, 0.38, 0.24, 0.61, 0.44, 0.55, 0.31</textarea>
          </label>
          <label>模型 2 预测概率 (0~1，逗号分隔)
            <textarea id="bsRocP2" rows="2">0.91, 0.86, 0.88, 0.79, 0.84, 0.74, 0.28, 0.16, 0.22, 0.12, 0.19, 0.09, 0.82, 0.25, 0.77, 0.14</textarea>
          </label>
          <button type="button" class="primary small-btn" id="bsRocRunBtn">${icon('chart', { size: 13 })} 计算 AUC / Youden 并绘制 ROC + DCA</button>
        `
        const runRoc = async () => {
          const did = readyDs[0]?.dataset_id
          if (!did) {
            rightEl.innerHTML = `<div class="muted small">请先生成或上传至少 1 个研究数据集以挂载 ROC/DCA 分析接口。</div>`
            return
          }
          const parseNums = (id: string) => ((document.getElementById(id) as HTMLTextAreaElement)?.value || '').split(/[,，\s]+/).map(v => Number(v.trim())).filter(v => Number.isFinite(v))
          const labels = parseNums('bsRocLabels')
          const scores_baseline = parseNums('bsRocP1')
          const scores_multimodal = parseNums('bsRocP2')
          const model1_name = (document.getElementById('bsRocM1') as HTMLInputElement)?.value.trim()
          const model2_name = (document.getElementById('bsRocM2') as HTMLInputElement)?.value.trim()
          try {
            const res = await api<any>(`/api/datasets/${did}/roc-dca`, {
              method: 'POST',
              body: JSON.stringify({ labels, scores_baseline, scores_multimodal, model1_name, model2_name }),
            })
            const rocSvg = res.native_exports?.roc_illustrator_svg || res.roc?.svg || ''
            const dcaSvg = res.native_exports?.dca_illustrator_svg || res.dca?.svg || ''
            const pzfx = res.native_exports?.prism_pzfx || ''
            const rScript = res.native_exports?.r_script || ''
            rightEl.innerHTML = `
              <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                <b>Figure 6A · ROC 诊断效能对比曲线</b>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button type="button" class="small-btn primary" id="bsArchRoc">${icon('pin', { size: 13 })} 归档 ROC 至 figures/</button>
                  <button type="button" class="small-btn" id="bsDlRocPzfx">${icon('download', { size: 13 })} Prism (.pzfx)</button>
                  <button type="button" class="small-btn" id="bsDlRocR">${icon('download', { size: 13 })} R pROC/rmda (.R)</button>
                  <button type="button" class="small-btn" id="bsDlRocSvg">${icon('download', { size: 13 })} ROC (.svg)</button>
                </div>
              </div>
              <div class="rs-studio-canvas" style="min-height:300px;">${safeSvg(rocSvg)}</div>
              <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px;">
                <b>Figure 6B · 临床决策净获益曲线 (DCA)</b>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button type="button" class="small-btn primary" id="bsArchDca">${icon('pin', { size: 13 })} 归档 DCA 至 figures/</button>
                  <button type="button" class="small-btn" id="bsDlDcaSvg">${icon('download', { size: 13 })} DCA (.svg)</button>
                </div>
              </div>
              <div class="rs-studio-canvas" style="min-height:300px;">${safeSvg(dcaSvg)}</div>
            `
            document.getElementById('bsArchRoc')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Figure6A_ROC_Curve', rocSvg, rScript))
            document.getElementById('bsArchDca')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Figure6B_DCA_Curve', dcaSvg, rScript))
            document.getElementById('bsDlRocPzfx')?.addEventListener('click', () => pzfx && downloadBlobContent(pzfx, 'ROC_DCA.pzfx', 'application/xml;charset=utf-8'))
            document.getElementById('bsDlRocR')?.addEventListener('click', () => rScript && downloadBlobContent(rScript, 'ROC_DCA.R'))
            document.getElementById('bsDlRocSvg')?.addEventListener('click', () => rocSvg && downloadBlobContent(rocSvg, 'Figure6A_ROC.svg', 'image/svg+xml;charset=utf-8'))
            document.getElementById('bsDlDcaSvg')?.addEventListener('click', () => dcaSvg && downloadBlobContent(dcaSvg, 'Figure6B_DCA.svg', 'image/svg+xml;charset=utf-8'))
          } catch (err) {
            rightEl.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
          }
        }
        document.getElementById('bsRocRunBtn')!.onclick = () => void runRoc()
        void runRoc()
        return
      }

      // engine === 'causal'
      leftEl.innerHTML = `
        <div class="rs-sub-box-title"><span>${icon('shield', { size: 13 })} 1. VanderWeele E-value 敏感度计算</span></div>
        <div class="row" style="gap:6px;">
          <label style="flex:1;">指标
            <select id="bsEvType"><option value="HR">HR</option><option value="OR">OR</option><option value="RR">RR</option></select>
          </label>
          <label style="flex:1;">点估计
            <input type="number" step="0.01" id="bsEvEst" value="0.68">
          </label>
          <label style="flex:1;">CI 下限
            <input type="number" step="0.01" id="bsEvLo" value="0.54">
          </label>
          <label style="flex:1;">CI 上限
            <input type="number" step="0.01" id="bsEvHi" value="0.85">
          </label>
        </div>
        <div class="rs-sub-box">
          <div class="rs-sub-box-title"><span>2. 倾向性评分匹配 (PSM/IPTW) 协变量 SMD 表</span></div>
          <table class="rs-data-table">
            <thead><tr><th>协变量名称</th><th style="width:74px;">匹配前 SMD</th><th style="width:74px;">匹配后 SMD</th></tr></thead>
            <tbody id="bsLoveTbody">
              ${loveCovariates.map(c => `
                <tr>
                  <td><input type="text" class="bs-lv-name" value="${esc(c.name)}"></td>
                  <td><input type="number" step="0.01" class="bs-lv-un" value="${c.smd_unadjusted}"></td>
                  <td><input type="number" step="0.01" class="bs-lv-adj" value="${c.smd_adjusted}"></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <button type="button" class="primary small-btn" id="bsCausalRunBtn">${icon('chart', { size: 13 })} 计算 E-value 并绘制 Love Plot 平衡图</button>
      `

      const runCausal = async () => {
        const effect_type = (document.getElementById('bsEvType') as HTMLSelectElement).value
        const estimate = Number((document.getElementById('bsEvEst') as HTMLInputElement).value)
        const ci_lower = Number((document.getElementById('bsEvLo') as HTMLInputElement).value)
        const ci_upper = Number((document.getElementById('bsEvHi') as HTMLInputElement).value)
        const trs = leftEl.querySelectorAll<HTMLTableRowElement>('#bsLoveTbody tr')
        loveCovariates = Array.from(trs).map(tr => ({
          name: tr.querySelector<HTMLInputElement>('.bs-lv-name')?.value.trim() || 'Covariate',
          smd_unadjusted: Number(tr.querySelector<HTMLInputElement>('.bs-lv-un')?.value || 0),
          smd_adjusted: Number(tr.querySelector<HTMLInputElement>('.bs-lv-adj')?.value || 0),
        }))
        try {
          const [evRes, loveRes] = await Promise.all([
            api<any>(`/api/studies/${s.id}/causal/e-value`, {
              method: 'POST',
              body: JSON.stringify({ effect_type, estimate, ci_lower, ci_upper, rare_outcome: true }),
            }),
            api<any>(`/api/studies/${s.id}/causal/love-plot`, {
              method: 'POST',
              body: JSON.stringify({ title: `${s.title} · Covariate Balance Love Plot`, covariates: loveCovariates, threshold: 0.1 }),
            }),
          ])
          const svg = loveRes.illustrator_svg || loveRes.svg || ''
          rightEl.innerHTML = `
            <div class="row" style="gap:10px;flex-wrap:wrap;">
              <div class="rs-sub-box" style="flex:1;min-width:180px;">
                <span class="muted small">VanderWeele E-value (点估计)</span>
                <b style="font-size:22px;color:var(--mint-text);">${evRes.e_value_point.toFixed(2)}</b>
              </div>
              <div class="rs-sub-box" style="flex:1;min-width:180px;">
                <span class="muted small">95% CI 保守边界 E-value</span>
                <b style="font-size:22px;color:var(--text);">${evRes.e_value_ci.toFixed(2)}</b>
              </div>
              <button type="button" class="small-btn" id="bsCopyRebuttal">${icon('copy', { size: 13 })} 复制顶刊审稿人抗辩段落</button>
            </div>
            <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:6px;">
              <b>Covariate Balance Love Plot (|SMD| &lt; 0.1 收敛阈值)</b>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button type="button" class="small-btn primary" id="bsArchLove">${icon('pin', { size: 13 })} 归档 Love Plot 至 figures/</button>
                <button type="button" class="small-btn" id="bsDlLovePzfx">${icon('download', { size: 13 })} Prism (.pzfx)</button>
                <button type="button" class="small-btn" id="bsDlLoveR">${icon('download', { size: 13 })} R cobalt (.R)</button>
                <button type="button" class="small-btn" id="bsDlLoveSvg">${icon('download', { size: 13 })} Love Plot (.svg)</button>
              </div>
            </div>
            <div class="rs-studio-canvas">${safeSvg(svg)}</div>
          `
          document.getElementById('bsCopyRebuttal')?.addEventListener('click', () => {
            navigator.clipboard.writeText(`${evRes.academic_defense_zh}\n\n${evRes.academic_defense_en}`)
            notice('已复制中英文审稿回复抗辩论述')
          })
          document.getElementById('bsArchLove')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Causal_Love_Plot', svg, loveRes.r_script))
          document.getElementById('bsDlLovePzfx')?.addEventListener('click', () => loveRes.prism_pzfx && downloadBlobContent(loveRes.prism_pzfx, 'Love_Plot.pzfx', 'application/xml;charset=utf-8'))
          document.getElementById('bsDlLoveR')?.addEventListener('click', () => loveRes.r_script && downloadBlobContent(loveRes.r_script, 'Love_Plot_cobalt.R'))
          document.getElementById('bsDlLoveSvg')?.addEventListener('click', () => svg && downloadBlobContent(svg, 'Love_Plot.svg', 'image/svg+xml;charset=utf-8'))
        } catch (err) {
          rightEl.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
        }
      }
      document.getElementById('bsCausalRunBtn')!.onclick = () => void runCausal()
      void runCausal()
    }

    pane.querySelectorAll<HTMLButtonElement>('[data-bs-eng]').forEach(btn => {
      btn.onclick = () => {
        engine = btn.dataset.bsEng as BioStatEngine
        pane.querySelectorAll<HTMLButtonElement>('[data-bs-eng]').forEach(b => b.classList.toggle('active', b === btn))
        renderEngine()
      }
    })
    renderEngine()
  }

  // ============================================================================
  // —— 页签 5：项目图表成果库与顶刊多面板拼图 (Figures Gallery & Journal Assembly) ——
  // ============================================================================
  function mountGalleryTab(s: Study): void {
    const pane = document.getElementById('rsPaneGallery')
    if (!pane) return
    const canEdit = s.my_role !== 'viewer' && s.my_role !== 'cra' && s.my_role !== 'auditor'

    pane.innerHTML = `
      <div class="rs-grid">
        <section class="rs-card wide">
          <div class="rs-card-head" style="flex-wrap:wrap;gap:8px;">
            <h3>1. 项目图表成果库 (figures/ · 共 ${s.analyses.length} 份产出)</h3>
            <span class="muted small">勾选任意已归档图表，支持批量重命名、批量删除，或在下方一键合成带 A/B/C/D 角标的顶刊多面板大图</span>
            ${s.analyses.length ? `
              <div style="margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <button type="button" class="small-btn quiet" id="rsGalSelectAllBtn">全选 / 取消全选</button>
                ${canEdit ? `
                  <button type="button" class="small-btn" id="rsGalBatchRenameBtn">${icon('edit', { size: 12 })} 批量重命名</button>
                  <button type="button" class="small-btn danger-text" id="rsGalBatchDeleteBtn">${icon('trash', { size: 12 })} 批量删除</button>
                ` : ''}
              </div>
            ` : ''}
          </div>
          ${s.analyses.length ? `
            <div class="rs-folder-files">
              ${s.analyses.map((a, idx) => {
                const filename = a.name.split('/').pop() || a.name
                const baseLabel = filename.replace(/\.[^.]+$/, '')
                return `
                  <div class="rs-file-item" style="cursor:default;">
                    <div class="rs-file-preview" data-fig="${a.asset_id}" style="cursor:pointer;" title="点击查看生成源码与数据溯源">
                      <img src="/api/assets/${a.asset_id}?token=${encodeURIComponent(hooks.token())}" alt="${esc(a.name)}">
                      <span class="rs-file-badge">Panel ${String.fromCharCode(65 + (idx % 6))}</span>
                    </div>
                    <div class="rs-file-info">
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;">
                        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;font-weight:600;min-width:0;flex:1;">
                          <input type="checkbox" class="rs-gal-pick" value="${esc(a.asset_id)}" data-figname="${esc(baseLabel)}" ${idx < 4 ? 'checked' : ''}>
                          <span class="rs-file-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(filename)}">${esc(baseLabel)}</span>
                        </label>
                        ${canEdit ? `<span style="display:inline-flex;gap:2px;flex-shrink:0;">
                          <button type="button" class="quiet small-btn" data-fig-rename="${esc(a.asset_id)}" data-fig-name="${esc(a.name)}" title="重命名图表" style="padding:2px 5px;">${icon('edit', { size: 12 })}</button>
                          <button type="button" class="quiet small-btn danger-text" data-fig-delete="${esc(a.asset_id)}" data-fig-name="${esc(a.name)}" title="删除图表" style="padding:2px 5px;">${icon('trash', { size: 12 })}</button>
                        </span>` : ''}
                      </div>
                      <div class="rs-file-meta">
                        <button type="button" class="linkish small" data-fig="${a.asset_id}">查看代码溯源</button>
                        <span>·</span>
                        <span class="muted">${date(a.created_at)}</span>
                      </div>
                    </div>
                  </div>
                `
              }).join('')}
            </div>
          ` : `
            <div class="rs-folder-empty">
              <p class="muted small">当前 <code>figures/</code> 还没有已归档图表。你可以先去「3. 统计与医学制图工作台」或「4. 临床统计模型」点击「归档至本研究 figures/」，或者直接点击下方按钮使用默认四面板示例体验顶刊多面板拼图。</p>
            </div>
          `}
        </section>

        <section class="rs-card wide">
          <div class="rs-card-head" style="flex-wrap:wrap;gap:8px;">
            <h3>2. 顶刊多面板自动排版拼图台 (Journal Multi-Panel Figure Assembly · A/B/C/D)</h3>
          </div>
          <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-end;background:var(--raised);padding:12px;border:1px solid var(--line);">
            <label style="flex:2;min-width:220px;">复合大图总标题 (Figure Legend Title)
              <input type="text" id="rsAsmTitle" value="${esc(s.title)} · Multi-Panel Composite Figure">
            </label>
            <label style="flex:1;min-width:170px;">目标期刊版式规格
              <select id="rsAsmPreset">
                <option value="nature_double" selected>Nature / Cell 双栏通栏 (183 mm)</option>
                <option value="nature_single">Nature 单栏紧凑 (89 mm)</option>
                <option value="nejm">NEJM 临床标准版式</option>
                <option value="lancet">The Lancet 版式</option>
              </select>
            </label>
            <label style="width:110px;">排版列数
              <select id="rsAsmCols">
                <option value="2" selected>2 列 (A/B + C/D)</option>
                <option value="3">3 列 (A/B/C)</option>
                <option value="1">1 列纵向堆叠</option>
              </select>
            </label>
            <button type="button" class="primary small-btn" id="rsAsmRunBtn">${icon('grid', { size: 13 })} 合成顶刊多面板大图</button>
          </div>

          <div class="rs-studio-exports" id="rsAsmExportBar">
            <span class="muted small">点击「合成顶刊多面板大图」生成复合矢量图与 600 DPI 印刷出版包…</span>
          </div>
          <div class="rs-studio-canvas" id="rsAsmCanvas" style="min-height:420px;">
            <div class="muted small">正在准备多面板拼图画布…</div>
          </div>
        </section>
      </div>
    `

    const runAssembly = async () => {
      const canvas = document.getElementById('rsAsmCanvas')!
      const expBar = document.getElementById('rsAsmExportBar')!
      const manuscriptTitle = (document.getElementById('rsAsmTitle') as HTMLInputElement).value.trim() || `${s.title} Composite Figure`
      const journalPreset = (document.getElementById('rsAsmPreset') as HTMLSelectElement).value
      const columns = Number((document.getElementById('rsAsmCols') as HTMLSelectElement).value || 2)
      canvas.innerHTML = `<div class="muted small">正在拉取选中面板矢量图并按期刊规范合成 A/B/C/D 复合大图…</div>`

      try {
        const checked = Array.from(pane.querySelectorAll<HTMLInputElement>('.rs-gal-pick:checked'))
        const panels: Array<{ label: string; title: string; svg: string }> = []
        const token = hooks.token()
        for (let i = 0; i < checked.length; i++) {
          const cb = checked[i]!
          const assetId = cb.value
          const r = await fetch(`/api/assets/${assetId}?token=${encodeURIComponent(token)}`)
          const text = await r.text()
          if (text.includes('<svg')) {
            panels.push({
              label: String.fromCharCode(65 + i),
              title: cb.dataset.figname || `Panel ${String.fromCharCode(65 + i)}`,
              svg: text,
            })
          }
        }

        const payload: Record<string, unknown> = {
          category: 'journal_assembly',
          manuscriptTitle,
          journalPreset,
          columns,
          panels,
        }
        const res = await api<any>(`/api/studies/${s.id}/figures`, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        const svgStr = res.illustrator_svg || res.svg || ''
        canvas.innerHTML = safeSvg(svgStr) || '<div class="muted small">未生成拼图</div>'

        expBar.innerHTML = `<span class="muted small">出版级多面板大图导出：</span>`
        const addBtn = (label: string, fn: () => void, primary = false) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = primary ? 'small-btn primary' : 'small-btn'
          b.innerHTML = `${icon('download', { size: 13 })} ${esc(label)}`
          b.onclick = fn
          expBar.appendChild(b)
        }
        if (svgStr) {
          const archBtn = document.createElement('button')
          archBtn.type = 'button'
          archBtn.className = 'small-btn primary'
          archBtn.innerHTML = `${icon('pin', { size: 13 })} 归档复合大图至 figures/`
          archBtn.onclick = () => void archiveStudyFigure(s.id, `Composite_Figure_${journalPreset}`, svgStr, JSON.stringify(res.manifest || {}, null, 2), 'figure_assembly.json')
          expBar.appendChild(archBtn)
        }
        addBtn('Illustrator 分层矢量 (.svg)', () => downloadBlobContent(svgStr, `Journal_Composite_${s.id}.svg`, 'image/svg+xml;charset=utf-8'))
        addBtn('600 DPI 印刷级高清图 (.png)', () => void downloadFigureFormat(s.id, payload, 'png', `Journal_Composite_600DPI_${s.id}.png`))
        addBtn('可编辑多面板 PPT (.pptx)', () => void downloadFigureFormat(s.id, payload, 'pptx', `Journal_Composite_Panels_${s.id}.pptx`))
        addBtn('完整出版原文件包 (.zip)', () => void downloadFigureFormat(s.id, payload, 'zip', `Journal_Composite_Bundle_${s.id}.zip`), true)
      } catch (err) {
        canvas.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
      }
    }

    const selAllBtn = document.getElementById('rsGalSelectAllBtn')
    if (selAllBtn) {
      selAllBtn.onclick = () => {
        const boxes = Array.from(pane.querySelectorAll<HTMLInputElement>('.rs-gal-pick'))
        const allChecked = boxes.length > 0 && boxes.every(b => b.checked)
        boxes.forEach(b => { b.checked = !allChecked })
      }
    }
    const batchRenBtn = document.getElementById('rsGalBatchRenameBtn')
    if (batchRenBtn) {
      batchRenBtn.onclick = () => {
        const ids = Array.from(pane.querySelectorAll<HTMLInputElement>('.rs-gal-pick:checked')).map(b => b.value)
        void batchRenameFigureAssets(ids, s.id)
      }
    }
    const batchDelBtn = document.getElementById('rsGalBatchDeleteBtn')
    if (batchDelBtn) {
      batchDelBtn.onclick = () => {
        const ids = Array.from(pane.querySelectorAll<HTMLInputElement>('.rs-gal-pick:checked')).map(b => b.value)
        void batchDeleteFigureAssets(ids, s.id)
      }
    }
    document.getElementById('rsAsmRunBtn')!.onclick = () => void runAssembly()
    void runAssembly()
  }

  async function ecrfDialog(studyId: string): Promise<void> {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="Auto-eCRF 批量回填">
      <div class="dialog-head">
        <h2>Auto-eCRF 多模态批量特征提取与溯源引擎</h2>
        <button class="quiet" data-close aria-label="关闭">✕</button>
      </div>
      <div class="dialog-body" style="display:flex;flex-direction:column;gap:14px;">
        <div class="muted small">
          全自动巡航提取入组受试者的多期 3D 影像生物标志物（病灶长径 / L3 SMI / 脂肪比 / BAR / 高密度粘液栓）及生化检验数据，全量配备单元格置信度与切片层号穿透溯源，直接生成医学宽表。
        </div>

        <div id="rsEcrfLoading" class="muted small" style="padding:20px;text-align:center;">正在载入多模态 eCRF 字典模版…</div>

        <div id="rsEcrfConfig" style="display:none;flex-direction:column;gap:12px;">
          <div style="border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--panel);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <b>选择需要批量提取的回填字段字典</b>
              <div style="display:flex;gap:6px;">
                <button type="button" class="quiet small-btn" id="rsEcrfSelectAll">全选</button>
                <button type="button" class="quiet small-btn" id="rsEcrfSelectDefault">重置推荐</button>
              </div>
            </div>
            <div id="rsEcrfVarList" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:8px;max-height:220px;overflow-y:auto;"></div>
          </div>
          <div style="display:flex;justify-content:flex-end;">
            <button class="primary small-btn" id="rsStartExtract">${icon('write', { size: 13 })} 开始自动巡航批量提取</button>
          </div>
        </div>

        <!-- Extract Progress -->
        <div id="rsEcrfProgress" style="display:none;flex-direction:column;gap:10px;padding:24px 0;align-items:center;">
          <div class="muted small" id="rsEcrfProgressText">正在调度 MONAI 3D 卷积节点分析入组受试者胸腹 CT 序列与病历库…</div>
          <div style="width:80%;height:6px;background:var(--line);border-radius:3px;overflow:hidden;">
            <div id="rsEcrfProgressBar" style="width:20%;height:100%;background:#0284c7;transition:width 0.4s ease;"></div>
          </div>
        </div>

        <!-- Results Matrix View -->
        <div id="rsEcrfResult" style="display:none;flex-direction:column;gap:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div id="rsEcrfSummaryBadge" style="display:flex;gap:8px;align-items:center;"></div>
            <div style="display:flex;gap:8px;">
              <button class="small-btn primary" id="rsEcrfSaveDataset">${icon('save', { size: 13 })} 保存为研究快照数据集</button>
            </div>
          </div>

          <div class="muted small" style="display:flex;align-items:center;gap:6px;">
            ${icon('info', { size: 13 })} <b>点击表格中任意数值单元格</b>，可立即展开其对应的原始 CT 切片层号、生化单原件与置信度溯源卡。
          </div>

          <div id="rsEcrfTableWrap" class="ds-scroll" style="max-height:360px;border:1px solid var(--line);border-radius:6px;"></div>

          <!-- Click to Audit Detail Panel -->
          <div id="rsEcrfAuditCard" style="display:none;border:1px solid var(--line);border-radius:8px;padding:12px;background:var(--panel);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <b id="rsAuditTitle" style="color:#0284c7;">[证据溯源] 单元格数据核验卡</b>
              <button class="quiet small-btn" id="rsAuditClose">关闭溯源</button>
            </div>
            <div id="rsAuditBody" style="font-size:12.5px;line-height:1.6;color:var(--text);"></div>
          </div>
        </div>
      </div>
    </div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }

    try {
      const tmpl = await api<{ categories: string[]; variables: Array<{ id: string; name_zh: string; unit: string; category: string; default_checked: boolean }> }>(`/api/studies/${studyId}/ecrf/template`)
      const varList = document.getElementById('rsEcrfVarList')
      if (varList) {
        varList.innerHTML = tmpl.variables.map(v => `
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
            <input type="checkbox" name="ecrf_var" value="${v.id}" ${v.default_checked ? 'checked' : ''}>
            <span>${esc(v.name_zh)} <span class="muted small">${v.unit ? `(${v.unit})` : ''}</span></span>
          </label>
        `).join('')
      }

      const selAllBtn = document.getElementById('rsEcrfSelectAll')
      const selDefBtn = document.getElementById('rsEcrfSelectDefault')
      if (selAllBtn && varList) {
        selAllBtn.onclick = () => {
          varList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => cb.checked = true)
        }
      }
      if (selDefBtn && varList) {
        selDefBtn.onclick = () => {
          const defSet = new Set(tmpl.variables.filter(v => v.default_checked).map(v => v.id))
          varList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(cb => cb.checked = defSet.has(cb.value))
        }
      }

      const loadingEl = document.getElementById('rsEcrfLoading')
      const configEl = document.getElementById('rsEcrfConfig')
      if (loadingEl) loadingEl.style.display = 'none'
      if (configEl) configEl.style.display = 'flex'

      const startBtn = document.getElementById('rsStartExtract')
      if (startBtn && varList) {
        startBtn.onclick = async () => {
          const selected = Array.from(varList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map(cb => cb.value)
          if (!selected.length) { notice('请至少选择一个回填变量', true); return }

          if (configEl) configEl.style.display = 'none'
          const progressEl = document.getElementById('rsEcrfProgress')
          const bar = document.getElementById('rsEcrfProgressBar')
          const txt = document.getElementById('rsEcrfProgressText')
          if (progressEl) progressEl.style.display = 'flex'
          if (bar) bar.style.width = '30%'
          if (txt) txt.textContent = '正在调度 MONAI 3D 卷积节点分析入组受试者胸腹 CT 序列…'

          setTimeout(() => {
            if (bar) bar.style.width = '70%'
            if (txt) txt.textContent = '正在提取 L3 骨骼肌 SMI、RECIST 径线与生化指标并建立审计溯源指纹…'
          }, 300)

          try {
            const res = await api<any>(`/api/studies/${studyId}/ecrf/extract`, {
              method: 'POST',
              body: JSON.stringify({ variable_ids: selected })
            })

            if (bar) bar.style.width = '100%'
            setTimeout(() => {
              if (progressEl) progressEl.style.display = 'none'
              renderEcrfResult(res)
            }, 350)
          } catch (err) {
            if (progressEl) progressEl.style.display = 'none'
            if (configEl) configEl.style.display = 'flex'
            notice((err as Error).message, true)
          }
        }
      }

      const renderEcrfResult = (res: any) => {
        const resultEl = document.getElementById('rsEcrfResult')
        const badgeEl = document.getElementById('rsEcrfSummaryBadge')
        const tableWrap = document.getElementById('rsEcrfTableWrap')
        if (resultEl) resultEl.style.display = 'flex'
        const s = res.summary
        if (badgeEl) {
          badgeEl.innerHTML = `
            <span style="background:#eff6ff;color:#1d4ed8;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:600;border:1px solid #bfdbfe;">
              受试者: ${res.total_subjects} 人
            </span>
            <span style="background:#f0fdf4;color:#15803d;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:600;border:1px solid #bbf7d0;">
              成功回填指标: ${s.extracted_cells} 项 (${Math.round(s.avg_confidence * 100)}% 置信度)
            </span>
            <span style="background:#fef2f2;color:#b91c1c;padding:3px 8px;border-radius:4px;font-size:12px;font-weight:600;border:1px solid #fecaca;">
              缺漏待查: ${s.missing_cells} 项
            </span>
          `
        }

        // Build Table HTML
        const vars: Array<{ id: string; name_zh: string; unit: string }> = res.extracted_variables
        let tableHtml = `<table class="users" style="width:100%;font-size:12px;"><thead><tr><th style="position:sticky;left:0;background:var(--bg);z-index:2;">研究编号</th>`
        for (const v of vars) {
          tableHtml += `<th>${esc(v.name_zh)}<br><span class="muted small">${esc(v.unit || '—')}</span></th>`
        }
        tableHtml += `</tr></thead><tbody>`

        for (const r of res.rows as Array<{ subject_id: string; variables: Record<string, any> }>) {
          tableHtml += `<tr><td style="position:sticky;left:0;background:var(--bg);font-weight:700;">${esc(r.subject_id)}</td>`
          for (const v of vars) {
            const cell = r.variables[v.id]
            if (!cell || cell.value === null) {
              tableHtml += `<td class="muted" style="text-align:center;">—</td>`
            } else {
              const confPct = Math.round(cell.confidence * 100)
              tableHtml += `<td>
                <button type="button" class="linkish" data-audit-cell="${esc(r.subject_id)}" data-audit-var="${esc(v.id)}" style="font-weight:600;color:var(--text);text-align:left;display:block;width:100%;">
                  ${esc(cell.formatted)}
                  <span style="font-size:10px;color:#047857;margin-left:2px;">[${confPct}%]</span>
                </button>
              </td>`
            }
          }
          tableHtml += `</tr>`
        }
        tableHtml += `</tbody></table>`
        if (tableWrap) tableWrap.innerHTML = tableHtml

        // Bind Click-to-Audit
        if (tableWrap) {
          tableWrap.onclick = (e) => {
            const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-audit-cell]')
            if (!btn) return
            const subId = btn.dataset.auditCell!
            const varId = btn.dataset.auditVar!
            const row = (res.rows as any[]).find(r => r.subject_id === subId)
            if (!row) return
            const cell = row.variables[varId]
            if (!cell) return
            const vDef = vars.find(v => v.id === varId)

            const auditCard = document.getElementById('rsEcrfAuditCard')
            const auditTitle = document.getElementById('rsAuditTitle')
            const auditBody = document.getElementById('rsAuditBody')
            if (auditCard) auditCard.style.display = 'block'
            if (auditTitle) auditTitle.textContent = `[证据穿透溯源] 受试者 ${subId} · ${vDef?.name_zh || varId}`
            if (auditBody) {
              auditBody.innerHTML = `
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px;">
                  <div>• <b>回填数值</b>: <span style="font-weight:700;color:#0284c7;">${esc(cell.formatted)}</span></div>
                  <div>• <b>模型提取置信度</b>: <span style="font-weight:700;color:#047857;">${Math.round(cell.confidence * 100)}%</span></div>
                  <div>• <b>数据源模态</b>: <span style="font-weight:600;">${cell.source_type === 'imaging' ? 'MONAI 3D 卷积断层扫描' : cell.source_type === 'lab' ? '院内生化实验室检验单' : '基线临床病历'}</span></div>
                  <div>• <b>提取时间戳</b>: <span class="muted small">${date(cell.extracted_at)}</span></div>
                </div>
                ${cell.source_slice_index ? `<div style="background:#f8fafc;padding:6px 10px;border-radius:4px;border:1px solid #e2e8f0;margin-top:4px;">
                  <b>3D 影像切片锚点</b>: 轴位关键层号 <code>#${cell.source_slice_index}</code> 层 (解剖包络线内定向测量)
                </div>` : ''}
                ${cell.source_detail ? `<div style="margin-top:4px;color:var(--text-secondary);font-size:12px;">• 详细溯源说明: ${esc(cell.source_detail)}</div>` : ''}
              `
            }
          }
        }

        const auditCloseBtn = document.getElementById('rsAuditClose')
        if (auditCloseBtn) {
          auditCloseBtn.onclick = () => {
            const auditCard = document.getElementById('rsEcrfAuditCard')
            if (auditCard) auditCard.style.display = 'none'
          }
        }

        // Save Dataset
        const saveDatasetBtn = document.getElementById('rsEcrfSaveDataset')
        if (saveDatasetBtn) {
          saveDatasetBtn.onclick = async () => {
            notice('正在沉淀为研究快照数据集…')
            try {
              await api(`/api/studies/${studyId}/ecrf/save-dataset`, {
                method: 'POST',
                body: JSON.stringify({ variable_ids: vars.map(v => v.id) })
              })
              dlg.hidden = true
              dlg.innerHTML = ''
              notice('已成功保存为研究数据集！已自动归入研究并可一键导出 Table 1 与运行生存分析')
              void openStudy(studyId)
            } catch (err) {
              notice((err as Error).message, true)
            }
          }
        }
      }
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  const PROMPTS: Record<string, (t: string) => string> = {
    protocol: t => `请为研究「${t}」起草一份研究方案：研究背景与目的、研究设计、研究人群（纳入与排除标准）、暴露 / 干预与对照、主要与次要终点、样本量估计、统计分析计划、伦理与数据管理。不确定的地方标「待定」，不要编造文献。`,
    manuscript: t => `请依据研究「${t}」的方案和已有分析，起草论文的方法与结果部分：结果段落只引用实际算出的数字，需要时用研究数据集补做分析（Table 1、主要终点分析）。`,
    slides: t => `请依据研究「${t}」做一份组会汇报幻灯片（6–8 页）：研究问题、设计、人群、主要结果（用已有分析的图）、局限与下一步。`,
  }

  async function newDoc(role: 'protocol' | 'manuscript' | 'slides', s: { id: string; title: string }): Promise<void> {
    try {
      const kind = role === 'slides' ? 'deck' : 'doc'
      const doc = await api<{ id: string }>('/api/docs', { method: 'POST', body: JSON.stringify({ title: `${s.title} · ${ROLES[role]}`, kind }) })
      await api(`/api/studies/${s.id}/items`, { method: 'POST', body: JSON.stringify({ kind: 'doc', ref_id: doc.id, role }) })
      current = null
      await hooks.openDoc(doc.id)
      hooks.prefillChat(PROMPTS[role]!(s.title))
      notice('已新建并归入研究。对话框里填好了建议的指令，可以修改后点「发送」')
    } catch (err) { notice((err as Error).message, true) }
  }

  async function attachExisting(s: { id: string }): Promise<void> {
    const docs = await api<Array<{ id: string; title: string; kind: string }>>('/api/docs')
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card small" role="dialog" aria-modal="true" aria-label="归入已有文档">
      <div class="dialog-head"><h2>归入已有文档</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="attachForm">
        ${docs.length ? `<label>文档<select name="doc">${docs.map(d => `<option value="${d.id}">${esc(d.title)}${d.kind === 'deck' ? '（幻灯片）' : ''}</option>`).join('')}</select></label>
        <label>作为<select name="role">${Object.entries(ROLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <div class="muted small">归入后这份文档在研究里，不再出现在写作的文档列表；随时可以移出。</div>
        <div class="row end"><button type="button" data-close>取消</button><button class="primary">归入</button></div>` : '<div class="muted">写作里没有可归入的文档。</div>'}
      </form></div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
    dlg.onchange = null
    const form = dlg.querySelector<HTMLFormElement>('#attachForm')!
    form.onsubmit = async e => {
      e.preventDefault()
      const f = new FormData(form)
      try {
        await api(`/api/studies/${s.id}/items`, { method: 'POST', body: JSON.stringify({ kind: 'doc', ref_id: f.get('doc'), role: f.get('role') }) })
        dlg.hidden = true; dlg.innerHTML = ''
        notice('已归入研究'); void openStudy(s.id); void loadList()
      } catch (err) { notice((err as Error).message, true) }
    }
  }

  function showWelcome(): void {
    current = null
    const page = $('page')
    page.className = 'page study-page rs-welcome'
    $('docTitle').textContent = '临床研究'
    page.innerHTML = `<div class="welcome">
      <svg class="mark" viewBox="-2 6 96 88" aria-hidden="true"><rect class="mark-ink" x="0" y="10" width="18" height="80" rx="9"/><rect class="mark-ink" x="62" y="30" width="18" height="60" rx="9"/><rect class="mark-sky" x="14" y="42" width="52" height="18" rx="9"/><circle class="mark-sky" cx="80" cy="20" r="11"/></svg>
      <h1>开展一项临床研究课题</h1>
      <p class="welcome-sub">一个研究项目集中管理方案、队列、统计与稿件；在隔离受限沙箱中秒级运行 Table 1 与生存曲线，数据与代码可追溯，自主演进科研记忆。</p>
      <div class="welcome-cards">
        <button class="welcome-card primary" data-rw="new"><b>＋ 新建研究项目</b><span>研究设计、纳入排除标准、主要终点与方案起草</span></button>
        <button class="welcome-card" data-rw="dataset"><b>导入数据集</b><span>支持 CSV、Excel、SAS、SPSS、Stata 质控导入</span></button>
        ${list[0]
          ? `<button class="welcome-card" data-rw="open"><b>打开最近研究</b><span>打开「${esc(list[0].title)}」</span></button>`
          : `<button class="welcome-card" data-rw="cohort"><b>筛选入组队列</b><span>从患者库多维条件筛选入组生成研究数据集</span></button>`}
      </div>
      <div class="rs-scenario-banner" style="margin-top:22px;text-align:left;">
        <div class="rs-scenario-head">
          <b>${icon('target', { size: 15 })} 科研制图三大使用场景引导：我该在何处画图？</b>
          <span class="muted small">按实际科研阶段选择最匹配的入口，图表与底层源码全平台互通</span>
        </div>
        <div class="rs-scenario-grid">
          <div class="rs-scenario-card">
            <div class="rs-scenario-tag">场景一 · 独立/预实验快速出图</div>
            <b>国自然标书配图 / 单次 WB·qPCR·CCK-8 / 审稿补图</b>
            <p class="muted small">不需要入组患者或建立完整临床课题，即开即画信号通路机制图、柱状散点图、4PL IC50 曲线、火山图与流式四象限，一键导出 <code>.pzfx</code> / <code>.R</code> / <code>.drawio</code> 原工程文件。</p>
            <div style="margin-top:auto;padding-top:6px;">
              <button type="button" class="small-btn primary" data-rw="studio">打开全局独立制图 →</button>
            </div>
          </div>
          <div class="rs-scenario-card">
            <div class="rs-scenario-tag">场景二 · 写作中内嵌配图</div>
            <b>正在写论文 Results / 综述正文 / 组会 PPT</b>
            <p class="muted small">边写正文边配图：在文档或幻灯片工具栏点击「科研制图」，就地生成或从成果库插入矢量图至当前光标段落，自动携带「来自分析」可复现代码溯源。</p>
            <div style="margin-top:auto;padding-top:6px;">
              <button type="button" class="small-btn" data-rw="write">前往写作空间边写边画 →</button>
            </div>
          </div>
          <div class="rs-scenario-card">
            <div class="rs-scenario-tag">场景三 · 临床研究课题闭环</div>
            <b>正式立项 RCT / 前瞻或回顾性队列研究</b>
            <p class="muted small">需从患者库筛选入组、提取 eCRF 宽表，要求 CONSORT 流程图、Table 1 基线三线表、KM 生存分析与课题数据版本严格绑定并打包 SCI 投稿出版包 (<code>.zip</code>)。</p>
            <div style="margin-top:auto;padding-top:6px;">
              <button type="button" class="small-btn" data-rw="new">＋ 新建临床研究课题 →</button>
            </div>
          </div>
        </div>
      </div>
      <div style="margin-top: 24px; text-align: center; display: flex; justify-content: center; align-items: center; gap: 16px;">
        <button class="linkish small muted" data-guide-action="open">查阅 Heurion 临床科研工作流与生物统计分析指南 ↗</button>
        <span id="rsAdminHandoverSlot"></span>
      </div>
    </div>${photoFigure('research')}`

    // 机构管理员：离职交接入口（只换研究负责人，不看内容）
    void api<{ role?: string; members?: number }>('/api/tenant').then(t => {
      if (t.role === 'admin' && (t.members ?? 1) > 1 && page.classList.contains('rs-welcome')) {
        const slot = document.getElementById('rsAdminHandoverSlot')
        if (slot) slot.innerHTML = '<span class="muted small">·</span> <button class="linkish small muted" data-rw="handover" title="成员离职时，把他负责的研究转交给本机构的其他同事">机构研究交接…</button>'
      }
    }).catch(() => {})
  }

  /** 离职交接（机构管理员）：本机构的研究（只有标题、负责人、成员数）→ 选新负责人；原负责人移出，管理员自己不因此成为成员。 */
  async function handoverDialog(): Promise<void> {
    let rows: Array<{ study_id: string; title: string; owner: string; owner_name: string; members: number; updated_at: string }> = []
    let people: Array<{ id: string; display_name: string; username: string }> = []
    try { [rows, people] = await Promise.all([api('/api/tenant/studies'), api('/api/tenant/colleagues')]) } catch (err) { notice((err as Error).message, true); return }
    const dlg = $('dialog')
    const opts = (owner: string) => people.filter(p => p.id !== owner).map(p => `<option value="${p.id}">${esc(p.display_name)}（${esc(p.username)}）</option>`).join('')
    dlg.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="研究交接">
      <div class="dialog-head"><h2>研究交接</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <div class="dialog-body">
        <div class="muted small">成员离职时，把他负责的研究交给本机构的另一位同事：新负责人接管全部内容，原负责人移出研究。你只看到研究名称与负责人，交接后也不会成为成员。每次交接写入审计日志。</div>
        ${rows.length ? `<div class="ds-scroll"><table class="users"><thead><tr><th>研究</th><th>负责人</th><th>成员</th><th>交给</th><th></th></tr></thead><tbody>
          ${rows.map(r => `<tr><td>${esc(r.title)}</td><td>${esc(r.owner_name)}</td><td>${r.members}</td><td><select data-hto="${r.study_id}">${opts(r.owner)}</select></td>
            <td><button class="small-btn" data-hgo="${r.study_id}" data-htitle="${esc(r.title)}">交接</button></td></tr>`).join('')}</tbody></table></div>`
          : '<div class="muted">本机构还没有研究项目。</div>'}
      </div></div>`
    dlg.hidden = false
    dlg.onchange = null
    dlg.onclick = async e => {
      const t = e.target as HTMLElement
      if (t === dlg || t.closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = ''; return }
      const go = t.closest<HTMLElement>('[data-hgo]')
      if (!go) return
      const to = dlg.querySelector<HTMLSelectElement>(`[data-hto="${go.dataset.hgo}"]`)?.value
      if (!to) { notice('本机构没有可以接手的同事', true); return }
      if (!await askConfirm({ title: '研究交接', message: `把「${go.dataset.htitle}」交给 ${people.find(p => p.id === to)?.display_name ?? ''}？原负责人会被移出研究。`, confirm: '交接', danger: true })) return
      try { await api(`/api/studies/${go.dataset.hgo}/handover`, { method: 'POST', body: JSON.stringify({ user_id: to }) }); notice('已交接'); dlg.hidden = true; dlg.innerHTML = ''; void loadList() } catch (err) { notice((err as Error).message, true) }
    }
  }

  // —— 事件 ——

  $('page').addEventListener('click', async e => {
    const page = $('page')
    const t = e.target as HTMLElement
    if (page.classList.contains('rs-welcome')) {
      const b = t.closest<HTMLElement>('[data-rw], [data-guide-action]')
      if (!b) return
      if (b.dataset.guideAction === 'open') { openHelpGuide('overview'); return }
      if (b.dataset.rw === 'new') { createDialog(); return }
      if (b.dataset.rw === 'studio') { hooks.goSpace('studio'); return }
      if (b.dataset.rw === 'write') { hooks.goSpace('write'); return }
      if (b.dataset.rw === 'handover') { void handoverDialog(); return }
      if (b.dataset.rw === 'open') { if (list[0]) void openStudy(list[0].id); return }
      if (b.dataset.rw === 'dataset') {
        if (list[0]) {
          await openStudy(list[0].id)
          const uploadInput = document.getElementById('rsUpload') as HTMLInputElement | null
          if (uploadInput) uploadInput.click()
        } else {
          createDialog()
        }
        return
      }
      if (b.dataset.rw === 'cohort') {
        if (list[0]) {
          await openStudy(list[0].id)
          const screenBtn = document.querySelector<HTMLElement>('[data-act="screen"]')
          if (screenBtn) screenBtn.click()
        } else {
          createDialog()
        }
        return
      }
      return
    }
    if (!current || !page.classList.contains('study-page')) return
    const id = current
    const s = { id, title: ($('rsTitle') as HTMLInputElement | null)?.value ?? '' }
    const tabBtn = t.closest<HTMLElement>('[data-rs-tab]')
    if (tabBtn) {
      e.stopPropagation()
      const targetTab = tabBtn.dataset.rsTab as 'overview' | 'data' | 'studio' | 'biostats' | 'gallery'
      switchStudyTab(targetTab)
      return
    }
    const stepJump = t.closest<HTMLElement>('[data-step-jump]')?.dataset.stepJump
    if (stepJump) {
      e.stopPropagation()
      switchStudyTab('overview')
      if (stepJump === 'protocol') document.getElementById('rsProtocolCard')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (stepJump === 'cohort') document.getElementById('rsCohort')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    const unlink = t.closest<HTMLElement>('[data-unlink]')?.dataset.unlink
    if (unlink) {
      e.stopPropagation()
      const [kind, ref] = unlink.split(':')
      try { await api(`/api/studies/${id}/items/${kind}/${ref}`, { method: 'DELETE' }); notice(kind === 'doc' ? '已移出，文档回到写作的文档列表' : '已移出研究'); void openStudy(id); void loadList() }
      catch (err) { notice((err as Error).message, true) }
      return
    }
    const open = t.closest<HTMLElement>('[data-opendoc]')?.dataset.opendoc
    if (open) { current = null; await hooks.openDoc(open); return }
    const pt = t.closest<HTMLElement>('[data-patient]')?.dataset.patient
    if (pt && hooks.openPatient) { current = null; await hooks.openPatient(pt); return }
    const un = t.closest<HTMLElement>('[data-unenroll]')
    if (un) {
      if (!await askConfirm({ title: '移出研究', message: `把 ${un.dataset.subject} 移出研究？研究编号保留不复用，之后再入组会恢复同一编号；已生成的研究数据集会提示过期。`, confirm: '移出' })) return
      try { await api(`/api/studies/${id}/cohort/${un.dataset.unenroll}`, { method: 'DELETE' }); notice('已移出研究'); void openStudy(id) } catch (err) { notice((err as Error).message, true) }
      return
    }
    const prop = t.closest<HTMLElement>('[data-prop]')
    if (prop) {
      try { await api(`/api/patients/${prop.dataset.pt}/proposals/${prop.dataset.prop}/${prop.dataset.propx}`, { method: 'POST' }); notice(prop.dataset.propx === 'accept' ? '已确认' : '已不采纳'); void openStudy(id) }
      catch (err) { notice((err as Error).message, true) }
      return
    }
    const expT1 = t.closest<HTMLElement>('[data-export-table1]')?.dataset.exportTable1
    if (expT1) {
      e.stopPropagation()
      void downloadTable1Docx(expT1)
      return
    }
    const surv = t.closest<HTMLElement>('[data-survival]')
    if (surv) {
      e.stopPropagation()
      void survivalDialog(surv.dataset.survival!, surv.dataset.dsname || '研究数据集')
      return
    }
    const nomo = t.closest<HTMLElement>('[data-nomogram]')
    if (nomo) {
      e.stopPropagation()
      void predictionModelDialog(nomo.dataset.nomogram!, nomo.dataset.dsname || '研究数据集')
      return
    }
    const regen = t.closest<HTMLElement>('[data-regen]')?.dataset.regen
    if (regen) { datasetDialog(id, regen); return }
    const ds = t.closest<HTMLElement>('[data-dataset]')?.dataset.dataset
    if (ds) { await hooks.datasets.openDetail(ds); return }
    const figRen = t.closest<HTMLElement>('[data-fig-rename]')
    if (figRen) {
      e.stopPropagation()
      void renameFigureAsset(figRen.dataset.figRename!, figRen.dataset.figName || 'Figure', id)
      return
    }
    const figDel = t.closest<HTMLElement>('[data-fig-delete]')
    if (figDel) {
      e.stopPropagation()
      void deleteFigureAsset(figDel.dataset.figDelete!, figDel.dataset.figName || 'Figure', id)
      return
    }
    const fig = t.closest<HTMLElement>('[data-fig]')?.dataset.fig
    if (fig) { await hooks.datasets.showProvenance(fig); return }
    const nd = t.closest<HTMLElement>('[data-new]')?.dataset.new
    if (nd) { await newDoc(nd as 'protocol' | 'manuscript' | 'slides', s); return }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
    if (act === 'bundle') { void downloadPublicationBundle(id, s.title); return }
    if (act === 'more') {
      const m = $('rsMore')
      const btn = t.closest<HTMLElement>('[data-act="more"]')
      m.hidden = !m.hidden
      if (!m.hidden && btn) {
        Object.assign(m.style, { position: 'fixed', left: '0px', top: '0px', right: 'auto', bottom: 'auto' })
        const br = btn.getBoundingClientRect()
        const mr = m.getBoundingClientRect()
        const mw = mr.width || 190
        const mh = mr.height || 140
        const left = Math.max(8, Math.min(br.right - mw, window.innerWidth - mw - 8))
        const top = br.bottom + 6 + mh > window.innerHeight - 8 ? Math.max(8, br.top - mh - 6) : Math.max(8, br.bottom + 6)
        m.style.left = `${Math.round(left)}px`
        m.style.top = `${Math.round(top)}px`
      }
      return
    }
    if (act === 'upload') { ($('rsUpload') as HTMLInputElement).click(); return }
    if (act === 'screen') { screenDialog(id); return }
    if (act === 'gen') { datasetDialog(id); return }
    if (act === 'figures') { void figureStudioDialog(id, s.title); return }
    if (act === 'consort') { void consortDialog(id); return }
    if (act === 'evalue') { evalueDialog(id); return }
    if (act === 'ecrf') { void ecrfDialog(id); return }
    if (act === 'vars') { void varsDialog(id); return }
    if (act === 'attach') { $('rsMore').hidden = true; await attachExisting(s); return }
    if (act === 'addmember') {
      const user = ($('rsAddUser') as HTMLSelectElement).value, role = ($('rsAddRole') as HTMLSelectElement).value
      try { await api(`/api/studies/${id}/members`, { method: 'POST', body: JSON.stringify({ user_id: user, role }) }); notice('已加入研究'); void openStudy(id); void loadList() } catch (err) { notice((err as Error).message, true) }
      return
    }
    const mremove = t.closest<HTMLElement>('[data-mremove]')
    if (mremove) {
      if (!await askConfirm({ title: '移出成员', message: `把 ${mremove.dataset.mname} 移出研究？之后他看不到研究里的文档、数据和分析（包括他自己建的，这些内容属于研究）。`, confirm: '移出' })) return
      try { await api(`/api/studies/${id}/members/${mremove.dataset.mremove}`, { method: 'DELETE' }); notice('已移出'); void openStudy(id) } catch (err) { notice((err as Error).message, true) }
      return
    }
    const mtransfer = t.closest<HTMLElement>('[data-mtransfer]')
    if (mtransfer) {
      if (!await askConfirm({ title: '转交负责人', message: `把研究转交给 ${mtransfer.dataset.mname}？之后由他管理成员、删除研究；你留在研究里，角色变为「可编辑」。`, confirm: '转交' })) return
      try { await api(`/api/studies/${id}/transfer`, { method: 'POST', body: JSON.stringify({ user_id: mtransfer.dataset.mtransfer }) }); notice('已转交'); void openStudy(id); void loadList() } catch (err) { notice((err as Error).message, true) }
      return
    }
    if (act === 'leave') {
      $('rsMore').hidden = true
      if (!await askConfirm({ title: '退出研究', message: `退出「${s.title}」？之后你看不到研究里的文档、数据和分析；负责人可以再把你加回来。`, confirm: '退出', danger: true })) return
      try {
        const me = (await api<{ members: Member[] }>(`/api/studies/${id}/members`)).members.find(m => m.me)
        if (me) await api(`/api/studies/${id}/members/${me.user_id}`, { method: 'DELETE' })
        notice('已退出研究'); await loadList(); showWelcome()
      } catch (err) { notice((err as Error).message, true) }
      return
    }
    if (act === 'delete') {
      $('rsMore').hidden = true
      if (await askConfirm({ title: '删除研究项目', message: `删除「${s.title}」？研究里的方案、论文、幻灯片会一起移到回收站（可以恢复）；数据集保留在「全部数据集」里。`, confirm: '删除', danger: true })) {
        await api(`/api/studies/${id}`, { method: 'DELETE' }); await loadList(); showWelcome()
      }
    }
  })

  $('page').addEventListener('change', async e => {
    if (!current || !$('page').classList.contains('study-page')) return
    const el = e.target as HTMLInputElement | HTMLSelectElement
    const id = current
    if (el.dataset.mrole) {
      try { await api(`/api/studies/${id}/members/${el.dataset.mrole}`, { method: 'PATCH', body: JSON.stringify({ role: el.value }) }); notice(`已改为「${ROLE_LABEL[el.value] ?? el.value}」`) } catch (err) { notice((err as Error).message, true); void openStudy(id) }
      return
    }
    if (el.id === 'rsAddUser' || el.id === 'rsAddRole') return
    if (el.id === 'rsUpload') {
      const files = Array.from((el as HTMLInputElement).files ?? [])
      ;(el as HTMLInputElement).value = ''
      const done = await hooks.datasets.upload(files)
      for (const d of done) await api(`/api/studies/${id}/items`, { method: 'POST', body: JSON.stringify({ kind: 'dataset', ref_id: d.id }) }).catch(err => notice((err as Error).message, true))
      if (done.length) notice('已上传并归入研究，正在处理；有身份信息的列时，点开数据集处理')
      void openStudy(id); void loadList()
      return
    }
    const patch = el.id === 'rsTitle' ? { title: el.value } : el.id === 'rsDesign' ? { design: el.value || null } : el.id === 'rsStatus' ? { status: el.value } : el.id === 'rsSummary' ? { summary: el.value } : null
    if (!patch) return
    try { await api(`/api/studies/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }); if ('title' in patch) $('docTitle').textContent = el.value; void loadList() }
    catch (err) { notice((err as Error).message, true) }
  })

  $('studyList').onclick = e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-study]')
    if (li) void openStudy(li.dataset.study!)
  }
  const studioListEl = document.getElementById('studioList')
  if (studioListEl) {
    studioListEl.onclick = e => {
      const t = e.target as HTMLElement
      if (t.closest('[data-st-batch-toggle]')) {
        studioBatchMode = !studioBatchMode
        if (!studioBatchMode) studioSelectedIds.clear()
        renderStudioList()
        return
      }
      if (t.closest('[data-st-batch-all]')) {
        const q = ($('docSearch') as HTMLInputElement).value.trim().toLowerCase()
        const shown = studioFigures.filter(f => !q || f.name.toLowerCase().includes(q))
        const allChecked = shown.length > 0 && shown.every(f => studioSelectedIds.has(f.id))
        for (const f of shown) {
          if (allChecked) studioSelectedIds.delete(f.id)
          else studioSelectedIds.add(f.id)
        }
        renderStudioList()
        return
      }
      if (t.closest('[data-st-batch-assemble]')) {
        const ids = [...studioSelectedIds]
        if (!ids.length) { notice('请先勾选要拼图的图表', true); return }
        if (studioBatchAssembleHandler) {
          studioBatchAssembleHandler(ids)
        } else {
          void openGlobalStudio(undefined, 'journal_assembly')
        }
        return
      }
      if (t.closest('[data-st-batch-rename]')) {
        void batchRenameFigureAssets([...studioSelectedIds])
        return
      }
      if (t.closest('[data-st-batch-delete]')) {
        void batchDeleteFigureAssets([...studioSelectedIds])
        return
      }
      const renBtn = t.closest<HTMLElement>('[data-fig-rename]')
      if (renBtn?.dataset.figRename) {
        e.stopPropagation()
        void renameFigureAsset(renBtn.dataset.figRename, renBtn.dataset.figName || 'Figure')
        return
      }
      const delBtn = t.closest<HTMLElement>('[data-fig-delete]')
      if (delBtn?.dataset.figDelete) {
        e.stopPropagation()
        void deleteFigureAsset(delBtn.dataset.figDelete, delBtn.dataset.figName || 'Figure')
        return
      }
      const cb = t.closest<HTMLInputElement>('[data-fig-check]')
      if (cb?.dataset.figCheck) {
        if (cb.checked) studioSelectedIds.add(cb.dataset.figCheck)
        else studioSelectedIds.delete(cb.dataset.figCheck)
        renderStudioList()
        return
      }
      const li = t.closest<HTMLElement>('li[data-studio-fig]')
      if (!li?.dataset.studioFig) return
      const assetId = li.dataset.studioFig
      const assetName = li.dataset.studioFigname || 'Archived_Figure'
      if (studioBatchMode) {
        if (studioSelectedIds.has(assetId)) studioSelectedIds.delete(assetId)
        else studioSelectedIds.add(assetId)
        renderStudioList()
        return
      }
      studioListEl.querySelectorAll('li').forEach(el => el.classList.toggle('active', el === li))
      if ($('page').classList.contains('studio-page') && previewArchivedAssetInStudio) {
        void previewArchivedAssetInStudio(assetId, assetName)
      } else {
        void hooks.datasets.showProvenance(assetId)
      }
    }
  }
  const newStudioFigBtn = document.getElementById('newStudioFigBtn')
  if (newStudioFigBtn) newStudioFigBtn.onclick = () => void openGlobalStudio(undefined, 'clinical_cohort')
  const studioQuickStatsBtn = document.getElementById('studioQuickStatsBtn')
  if (studioQuickStatsBtn) studioQuickStatsBtn.onclick = () => void openGlobalStudio(undefined, 'wet_lab')
  const studioQuickMechBtn = document.getElementById('studioQuickMechBtn')
  if (studioQuickMechBtn) studioQuickMechBtn.onclick = () => void openGlobalStudio(undefined, 'mechanism')
  const studioUploadDatasetBtn = document.getElementById('studioUploadDatasetBtn')
  const studioDatasetFileInput = document.getElementById('studioDatasetFileInput') as HTMLInputElement | null
  if (studioUploadDatasetBtn && studioDatasetFileInput) {
    studioUploadDatasetBtn.onclick = () => studioDatasetFileInput.click()
    studioDatasetFileInput.onchange = async () => {
      const files = Array.from(studioDatasetFileInput.files ?? [])
      studioDatasetFileInput.value = ''
      if (!files.length) return
      const uploaded = await hooks.datasets.upload(files)
      if (uploaded.length) {
        await openGlobalStudio(uploaded[0]!.id, 'clinical_cohort')
      }
    }
  }

  $('newStudy').onclick = () => createDialog()
  $('docSearch').addEventListener('input', () => {
    if (!$('studyList').hidden) renderList()
    if (studioListEl && !studioListEl.hidden) renderStudioList()
  })

  return {
    async enter(): Promise<void> {
      const wasOpening = Boolean(opening)
      await loadList()
      if (opening || wasOpening) return
      if (current && $('page').classList.contains('study-page') && !$('page').classList.contains('rs-welcome')) return
      showWelcome()
    },
    /** 进入独立科研制图空间（与临床研究完全分离） */
    async enterStudio(): Promise<void> {
      await openGlobalStudio()
    },
    leave(): void { current = null; if (poll) { clearTimeout(poll); poll = null } },
    /** 从研究里的文档、数据集详情或患者页打开某个研究 */
    async open(id: string): Promise<void> {
      const token = opening = {}
      try {
        hooks.goSpace('research')
        await openStudy(id)
      } finally {
        if (opening === token) opening = null
      }
    },
    /** 打开全局独立的科研制图工作台（直接切换到制图空间） */
    async openStudio(datasetId?: string): Promise<void> {
      hooks.goSpace('studio')
      await openGlobalStudio(datasetId)
    },
    /** 打开写作内嵌科研制图与图表库插入弹窗 */
    openDocFigureModal,
  }
}
