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

/** 后端为示例数据生成的 SVG 打的标记（见 src/research/demo-data.ts）：这类图只能预览，不能导出 / 归档 / 插入文稿 */
const isDemoSvg = (svg: string): boolean => /<svg\b[^>]*\bdata-heurion-demo="true"/.test(svg)

/** Auto-eCRF 单元格来源等级（见 src/research/ecrf.ts 的 EcrfSourceTier） */
const ECRF_TIER_LABEL: Record<string, string> = {
  registry: '患者主档案（不在研究变量核实流程内）',
  lab: '院内化验记录',
  imaging: '影像量化分析记录',
  manual: '研究变量登记（手工录入）',
  none: '未找到来源',
}
const ECRF_TIER_SHORT: Record<string, string> = { registry: '主档案', lab: '化验', imaging: '影像', manual: '手工', none: '无来源' }

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
  analyses: Array<{ asset_id: string; name: string; created_at: string; datasets: string[]; has_code: boolean; by?: string; stale_data?: boolean; stale_reason?: string | null }>
  /** 计划样本量（服务端按保存的参数重新计算） */
  sample_size_plan?: SampleSizePlanView | null
}

interface SampleSizeResultView {
  design: string
  groups: Array<{ label: string; n: number; n_with_dropout: number }>
  total: number
  total_with_dropout: number
  events_required?: number
  event_prob_used?: number
  simon?: Record<'optimal' | 'minimax', { n1: number; r1: number; n: number; r: number; en0: number; pet0: number; actual_alpha: number; actual_power: number }>
  one_proportion?: { min_responses: number; actual_alpha: number; actual_power: number; normal_approx_n: number }
  method: string
  methods_text_zh: string
  methods_text_en: string
  warnings?: string[]
}
interface SampleSizePlanView {
  input: Record<string, unknown>
  result: SampleSizeResultView
  saved_at: string
  saved_by: string
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

  /** 新建研究：支持选择三条真实临床研究启动路径（路径 A 外部数据快车道 / 路径 B 方案驱动院内队列 / 路径 C 审稿返修与统计抗辩）。 */
  function createDialog(prefill?: { title?: string; design?: string; summary?: string; mode?: 'excel_fast' | 'protocol_cohort' | 'rebuttal' }): void {
    const initMode = prefill?.mode ?? 'excel_fast'
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="新建研究" style="max-width:620px;">
      <div class="dialog-head"><h2>新建临床研究课题</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="studyForm">
        <div>
          <div class="small" style="font-weight:600;margin-bottom:6px;">选择研究启动路径（创建后自动引导进入对应工作流）</div>
          <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:8px;" id="studyModeCards">
            <label style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;cursor:pointer;display:flex;flex-direction:column;gap:4px;background:var(--panel);">
              <span style="display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;">
                <input type="radio" name="start_mode" value="excel_fast" ${initMode === 'excel_fast' ? 'checked' : ''}>
                ${icon('upload', { size: 13 })} 路径 A · 已有数据表
              </span>
              <span class="muted small" style="font-size:11.5px;line-height:1.4;">已有 Excel/CSV（含多表数据字典），创建后直接上传预检并出 Table 1 与模型图</span>
            </label>
            <label style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;cursor:pointer;display:flex;flex-direction:column;gap:4px;background:var(--panel);">
              <span style="display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;">
                <input type="radio" name="start_mode" value="protocol_cohort" ${initMode === 'protocol_cohort' ? 'checked' : ''}>
                ${icon('report', { size: 13 })} 路径 B · 方案建队列
              </span>
              <span class="muted small" style="font-size:11.5px;line-height:1.4;">从方案提取纳排规则与终点变量，筛查院内患者、Auto-eCRF 核实并生成随访宽表</span>
            </label>
            <label style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;cursor:pointer;display:flex;flex-direction:column;gap:4px;background:var(--panel);">
              <span style="display:flex;align-items:center;gap:6px;font-weight:600;font-size:12.5px;">
                <input type="radio" name="start_mode" value="rebuttal" ${initMode === 'rebuttal' ? 'checked' : ''}>
                ${icon('shield', { size: 13 })} 路径 C · 统计与返修
              </span>
              <span class="muted small" style="font-size:11.5px;line-height:1.4;">直达倾向性评分 PSM/IPTW Love Plot、E-value 混杂抗辩与 DeLong 增量检验</span>
            </label>
          </div>
        </div>
        <label>研究名称<input type="text" name="title" required maxlength="120" placeholder="例如：SGLT2 抑制剂与 CKD3 患者 eGFR 下降" value="${esc(prefill?.title ?? '')}"></label>
        <label>研究设计<select name="design"><option value="">（暂不确定 / 由方案自动识别）</option>${Object.entries(DESIGNS).map(([k, v]) => `<option value="${k}"${prefill?.design === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label>研究方案摘要 / 纳排标准段落（可选；路径 B 下将自动从中提取结构化纳排规则与研究终点变量）
          <textarea name="summary" rows="3" placeholder="可粘贴研究问题、人群纳入/排除标准、主要终点（如 EGFR、PD-L1、mRS、ORR 等）">${esc(prefill?.summary ?? '')}</textarea>
        </label>
        <div class="row end"><button type="button" data-close>取消</button><button class="primary">创建并进入路径</button></div>
      </form></div>`
    dlg.hidden = false
    dlg.querySelector<HTMLInputElement>('input[name=title]')!.focus()
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
    dlg.onchange = null
    dlg.querySelector<HTMLFormElement>('#studyForm')!.onsubmit = async e => {
      e.preventDefault()
      const f = new FormData(e.target as HTMLFormElement)
      const mode = String(f.get('start_mode') || 'excel_fast')
      const summaryText = String(f.get('summary') || '').trim()
      try {
        const s = await api<{ id: string }>('/api/studies', { method: 'POST', body: JSON.stringify({ title: f.get('title'), design: f.get('design') || null, summary: summaryText }) })
        dlg.hidden = true; dlg.innerHTML = ''
        if (mode === 'protocol_cohort' && summaryText) {
          await api(`/api/studies/${s.id}/eligibility/extract`, { method: 'POST', body: JSON.stringify({ protocol_text: summaryText, save: true }) }).catch(() => {})
        }
        await loadList()
        await openStudy(s.id)
        if (mode === 'excel_fast') {
          const uploadInput = document.getElementById('rsUpload') as HTMLInputElement | null
          if (uploadInput) uploadInput.click()
        } else if (mode === 'protocol_cohort') {
          screenDialog(s.id)
        } else if (mode === 'rebuttal') {
          switchStudyTab('biostats')
        }
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
    if (isDemoSvg(svg)) {
      notice('这张图由示例数据生成，不能归档或插入文稿。请选择数据集或录入真实数据后重新生成。', true)
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
    const topTab = tab === 'studio' ? 'biostats' : tab
    page.querySelectorAll<HTMLButtonElement>('.rs-tabs button[data-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === topTab)
    })
    page.querySelectorAll<HTMLButtonElement>('.rs-subview-switch button[data-rs-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.rsTab === tab)
    })
    const ov = document.getElementById('rsPaneOverview')
    const dt = document.getElementById('rsPaneData')
    const an = document.getElementById('rsPaneAnalytics')
    const bs = document.getElementById('rsPaneBiostats')
    const st = document.getElementById('rsPaneStudio')
    const ga = document.getElementById('rsPaneGallery')
    if (ov) ov.hidden = tab !== 'overview'
    if (dt) dt.hidden = tab !== 'data'
    if (an) an.hidden = tab !== 'biostats' && tab !== 'studio'
    if (bs) bs.hidden = tab !== 'biostats'
    if (st) st.hidden = tab !== 'studio'
    if (ga) ga.hidden = tab !== 'gallery'
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

    const topTab = activeTab === 'studio' ? 'biostats' : activeTab
    const staleCount = s.analyses.filter(a => a.stale_data).length

    page.innerHTML = `
      ${canEdit ? '' : `<div class="banner rs-readonly"><span class="dot"></span>你是这个研究的只读成员（负责人 ${esc(s.owner_name)}）：能看文档、数据和分析，能评论；要修改请负责人把你改成「可编辑」。</div>`}
      <div class="rs-head">
        <div class="row" style="align-items:center;gap:10px;flex-wrap:wrap;">
          <input class="rs-title" id="rsTitle" value="${esc(s.title)}" aria-label="研究名称" style="flex:1;min-width:240px;"${ro ? ' readonly' : ''}>
          <button class="small-btn primary" data-act="bundle" title="一键导出包含 Word Table 1、Figure 矢量图、原工程文件、方法与结果初稿及 STROBE 清单的完整投稿压缩包 (.zip)">${icon('download', { size: 13 })} 导出投稿包 (.zip)</button>
          <div class="menu-wrap"><button data-act="more" aria-haspopup="menu">更多 ▾</button>
            <div class="dropdown" id="rsMore" hidden>${w('<button data-act="attach">归入已有文档…</button>')}${isOwner ? '<button data-act="delete" class="danger-text">删除研究项目</button>' : '<button data-act="leave" class="danger-text">退出研究</button>'}</div></div>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap;">
          <select id="rsDesign" aria-label="研究设计"${ro}><option value="">研究设计（未定）</option>${Object.entries(DESIGNS).map(([k, v]) => `<option value="${k}"${s.design === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <select id="rsStatus" aria-label="状态"${ro}>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${s.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <span class="rs-role muted small">我的角色：${ROLE_LABEL[s.my_role]}</span>
          <span class="muted small">· 团队 ${members.length} 人 · 在组 ${activeSubjects.length} 人 · 数据集 ${s.datasets.length} 个 · 图表 ${s.analyses.length} 张</span>
          ${staleCount ? `<span class="flag-L small">${icon('warning', { size: 11 })} ${staleCount} 张图表待同步</span>` : ''}
        </div>
        <textarea id="rsSummary" rows="1" placeholder="简介：研究问题、人群、暴露 / 干预、主要终点"${ro ? ' readonly' : ''}>${esc(s.summary ?? '')}</textarea>
      </div>

      <div class="tabs rs-tabs" role="tablist" aria-label="临床研究工作流阶段">
        <button type="button" data-tab="overview" data-rs-tab="overview" class="${topTab === 'overview' ? 'active' : ''}">概览</button>
        <button type="button" data-tab="data" data-rs-tab="data" class="${topTab === 'data' ? 'active' : ''}">数据与 Table 1${s.datasets.length ? ` <span class="count">${s.datasets.length}</span>` : ''}</button>
        <button type="button" data-tab="biostats" data-rs-tab="biostats" class="${topTab === 'biostats' ? 'active' : ''}">统计与制图</button>
        <button type="button" data-tab="gallery" data-rs-tab="gallery" class="${topTab === 'gallery' ? 'active' : ''}">图表库${s.analyses.length ? ` <span class="count">${s.analyses.length}</span>` : ''}</button>
      </div>

      <!-- ==================== 页签 1：概览 ==================== -->
      <div id="rsPaneOverview" ${activeTab === 'overview' ? '' : 'hidden'}>
        <div class="rs-grid">
          ${cohortCard(cohort, cohortOff, canEdit)}
          <section class="rs-card" id="rsProtocolCard">
            <div class="rs-card-head"><h3>研究方案</h3>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="small-btn" data-act="samplesize" title="按 α、检验效能与预期效应量计算计划样本量">${icon('ruler', { size: 12 })} 样本量估算</button>
                ${w('<button class="small-btn" data-new="protocol">＋ 新建方案</button>')}
              </div>
            </div>
            ${protocols.length ? `<ul class="rs-list">${protocols.map(docRow).join('')}</ul>` : '<p class="muted small">还没有研究方案。点「＋ 新建方案」起草研究设计、纳排标准与主要终点。</p>'}
            ${sampleSizePlanSummary(s.sample_size_plan ?? null, cohort ? activeSubjects.length : null)}
          </section>
          <section class="rs-card">
            <div class="rs-card-head"><h3>数据集</h3>
              ${w('<button class="small-btn" data-act="upload">＋ 上传数据</button><input type="file" id="rsUpload" accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.xpt,.sas7bdat,.sav,.zsav,.dta" multiple hidden>')}
            </div>
            ${s.datasets.length ? `<ul class="rs-list">${s.datasets.map(d => `<li class="rs-item" data-dataset="${d.dataset_id}"><span class="rs-kind">${esc(d.format)}</span><b>${esc(d.name)}</b>
              <span class="muted small">${d.status === 'ready' ? `${d.rows.toLocaleString()} 行 × ${d.cols} 列` : d.status === 'review' ? '<span class="flag-L">待处理身份信息</span>' : d.status === 'failed' ? '<span class="flag-H">导入失败</span>' : '处理中…'}</span>
              ${d.status === 'ready' ? `<button class="quiet small-btn" data-export-table1="${d.dataset_id}" title="导出符合医学期刊标准的原生 Word (.docx) Table 1 三线表">Word Table 1</button>` : ''}
              ${w(`<button class="quiet small-btn" data-unlink="dataset:${d.dataset_id}" title="移出研究（数据集回到上传者的「全部数据集」里）">移出</button>`)}</li>`).join('')}</ul>`
              : '<p class="muted small">支持上传 CSV、Excel、SAS、SPSS、Stata，或从上方入组患者直接生成队列宽表。</p>'}
          </section>
          <section class="rs-card wide">
            <div class="rs-card-head"><h3>论文与汇报稿件</h3>${w('<button class="small-btn" data-new="manuscript">＋ 新建论文</button><button class="small-btn" data-new="slides">＋ 新建幻灯片</button>')}</div>
            ${manuscripts.length ? `<ul class="rs-list">${manuscripts.map(docRow).join('')}</ul>` : '<p class="muted small">新建论文或汇报幻灯片后，AI 写作助手会自动挂载本研究的数据集与图表。</p>'}
          </section>
          ${membersCard(members, candidates, isOwner)}
        </div>
      </div>

      <!-- ==================== 页签 2：数据与 Table 1 ==================== -->
      <div id="rsPaneData" ${activeTab === 'data' ? '' : 'hidden'}></div>

      <!-- ==================== 页签 3：统计与制图 ==================== -->
      <div id="rsPaneAnalytics" ${activeTab === 'biostats' || activeTab === 'studio' ? '' : 'hidden'}>
        <div class="rs-subview-switch" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
          <div class="seg" role="tablist" aria-label="统计与制图切换">
            <button type="button" data-rs-tab="biostats" class="${activeTab === 'biostats' ? 'active' : ''}">${icon('chart', { size: 13 })} 统计模型与因果推断</button>
            <button type="button" data-rs-tab="studio" class="${activeTab === 'studio' ? 'active' : ''}">${icon('layers', { size: 13 })} 科研制图画布</button>
          </div>
          <span class="muted small">生成的统计图与机制图均可一键归档至「图表库」或插入论文</span>
        </div>
        <div id="rsPaneBiostats" ${activeTab === 'biostats' ? '' : 'hidden'}></div>
        <div id="rsPaneStudio" ${activeTab === 'studio' ? '' : 'hidden'}></div>
      </div>

      <!-- ==================== 页签 4：图表库 ==================== -->
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
      <div class="rs-card-head"><h3>项目成员<span class="muted small"> · ${members.length} 人</span></h3>${isOwner ? '' : '<button class="quiet small-btn" data-act="leave">退出研究</button>'}</div>
      <ul class="rs-list">${members.map(row).join('')}</ul>
      ${isOwner ? (candidates.length
        ? `<div class="row rs-addmember"><select id="rsAddUser" aria-label="加成员">${candidates.map(u => `<option value="${u.user_id}">${esc(u.name)}（${esc(u.username)}）</option>`).join('')}</select>
            <select id="rsAddRole" aria-label="角色">${ROLE_OPTIONS.map(opt => `<option value="${opt.value}">${esc(opt.label)}</option>`).join('')}</select><button class="small-btn" data-act="addmember">＋ 加成员</button></div>`
        : `<p class="muted small">${members.length > 1 ? '本机构的同事都已在研究里。' : '机构管理员可在「机构管理」里邀请同机构成员协同参与课题。'}</p>`) : ''}
    </section>`
  }

  /** 入组患者卡片：清爽紧凑工具栏。 */
  function cohortCard(c: Cohort | null, off: string, canEdit = true): string {
    if (!c) return `<section class="rs-card wide"><div class="rs-card-head"><h3>入组患者</h3></div><p class="muted small">${esc(off || '研究入组需要启用患者模块')}</p></section>`
    const active = c.subjects.filter(x => x.status === 'active')
    const sets = c.datasets.filter(d => d.latest)
    const SHAPE: Record<string, string> = { wide: '宽表', long: '长表' }
    return `<section class="rs-card wide" id="rsCohort">
      <div class="rs-card-head" style="flex-wrap:wrap;gap:8px;">
        <h3>入组患者${active.length ? `<span class="muted small"> · ${active.length} 人在组</span>` : ''}</h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          ${canEdit ? `<button class="small-btn primary" data-act="screen">＋ 筛选入组</button>${active.length ? '<button class="small-btn" data-act="gen">生成研究数据集</button>' : ''}` : ''}
          <button class="small-btn" data-act="ecrf" title="Auto-eCRF 多模态影像与临床指标批量提取与溯源">Auto-eCRF 提取</button>
          <button class="small-btn" data-act="vars" title="分组、随访、结局与影像变量：来源与核实状态">变量核实</button>
          <button class="small-btn" data-act="consort" title="查看并导出 CONSORT 2010 受试者纳排流向图">CONSORT 图</button>
          <button class="small-btn quiet" data-act="img-export" title="去标识化影像与结节数据导出申请及 PI 审批留痕">影像导出审批</button>
        </div>
      </div>
      ${c.pending.length ? `<div class="banner pt-pending"><span class="dot"></span>AI 建议了 ${c.pending.length} 项入组 / 移出，待你确认</div>
        <ul class="rs-list">${c.pending.map(p => `<li class="rs-item"><span class="rs-kind">${p.kind === 'enroll' ? '入组' : '移出'}</span><b>${esc(p.code ?? '—')}</b><span class="muted small">${esc(p.reason)}</span>
          <button class="small-btn primary" data-prop="${p.proposal_id}" data-pt="${p.patient_id}" data-propx="accept">确认</button><button class="quiet small-btn" data-prop="${p.proposal_id}" data-pt="${p.patient_id}" data-propx="reject">不采纳</button></li>`).join('')}</ul>` : ''}
      ${sets.map(d => `<div class="rs-cohort-ds${d.stale ? ' stale' : ''}" data-dataset="${d.dataset_id}"><span class="rs-kind">${SHAPE[d.shape] ?? d.shape} v${d.version}</span>
        <span style="flex:1;">${esc(d.name)} <span class="muted small">${d.rows} 行 · ${date(d.generated_at)}</span></span>
        ${d.shape === 'wide' ? `<button class="small-btn" data-export-table1="${d.dataset_id}" title="一键导出原生 Word (.docx) Table 1 基线三线表">Word Table 1</button>` : ''}
        ${d.stale ? `<span class="flag-L small">入组或化验有变化，数据集已过期</span>${canEdit ? `<button class="small-btn" data-regen="${d.shape}">刷新</button>` : ''}` : '<span class="muted small">最新</span>'}</div>`).join('')}
      ${c.subjects.length ? `<div class="ds-scroll"><table class="users rs-subjects"><thead><tr><th>研究编号</th><th>代号</th><th>性别</th><th>入组时年龄</th><th>诊断标签</th><th>入组日期</th><th></th></tr></thead><tbody>
        ${c.subjects.map(x => `<tr class="${x.status === 'active' ? '' : 'muted'}"><td><b>${esc(x.subject_id)}</b></td>
          <td>${x.code ? `<button class="linkish" data-patient="${x.patient_id}">${esc(x.code)}</button>` : '<span class="muted" title="你已不在这位患者的诊疗组里">—</span>'}</td>
          <td>${esc(SEX[x.sex ?? ''] ?? '')}</td><td>${x.age_at_enroll ?? ''}</td><td>${esc(x.tags.join('、'))}</td><td>${date(x.enrolled_at)}</td>
          <td>${x.status === 'active' ? (canEdit && x.code ? `<button class="quiet small-btn" data-unenroll="${x.patient_id}" data-subject="${esc(x.subject_id)}">移出</button>` : '') : '<span class="small">已移出</span>'}</td></tr>`).join('')}
        </tbody></table></div>`
        : '<p class="muted small">按性别、年龄、诊断标签、化验结果、检查日期从患者中筛选入组；生成的研究数据集里只有研究编号（S001…），不含患者代号。</p>'}
    </section>`
  }

  /** 筛选入组：支持从研究方案自动提取纳排规则、专科模板、多模态纳入/排除规则构建、筛选漏斗与勾选入组。 */
  function screenDialog(studyId: string): void {
    const dlg = $('dialog')
    const labRow = () => `<div class="row rs-labrow"><input name="lab_test" placeholder="化验项目，如 肌酐 / HbA1c" list="rsTests"><select name="lab_mode"><option value="latest">最近一次</option><option value="any">任一次</option><option value="baseline">基线(首次)</option><option value="min">最小值</option><option value="max">最大值</option><option value="count">检测次数</option></select>
      <select name="lab_op"><option>&gt;</option><option>&gt;=</option><option>&lt;</option><option>&lt;=</option><option>=</option></select><input name="lab_value" type="number" step="any" placeholder="阈值（标准单位）"><button type="button" class="quiet" data-dellab aria-label="删除这条">✕</button></div>`
    const noduleRow = () => `<div class="row rs-nodulerow"><select name="nodule_field" aria-label="结节指标"><option value="mean_diameter_mm">平均径 (mm)</option><option value="volume_mm3">体积 (mm³)</option><option value="solid_core_mm">实性成分径 (mm)</option><option value="vdt_days">倍增时间 VDT (天)</option></select><select name="nodule_type" aria-label="结节密度"><option value="">密度不限</option><option value="solid">实性</option><option value="part_solid">部分实性</option><option value="ground_glass">纯磨玻璃</option><option value="calcified">钙化</option></select><select name="nodule_op"><option>&gt;=</option><option>&gt;</option><option>&lt;=</option><option>&lt;</option><option>=</option></select><input name="nodule_value" type="number" step="any" placeholder="阈值"><input name="nodule_min_studies" type="number" min="1" step="1" placeholder="最少定稿随访次数" style="max-width:140px;"><button type="button" class="quiet" data-delnodule aria-label="删除这条">✕</button></div>`
    dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="筛选入组">
      <div class="dialog-head"><h2>研究方案纳排规则与患者筛选入组</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="screenForm" style="display:flex;flex-direction:column;gap:10px;">
        <div class="muted small">在你在诊疗组里的在管患者中按研究方案筛选。支持从研究方案文档一键提取纳入/排除标准，覆盖人口学、诊断标签、任意化验（最新/基线/极值/次数）、3D 影像指标、病历/病理文本检索与人工复核项，自动生成 CONSORT 纳排漏斗。</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--raised);padding:8px 10px;border:1px solid var(--line);border-radius:6px;">
          <b class="small">方案纳排引擎：</b>
          <button type="button" class="small-btn primary" data-extract-protocol title="从本研究关联的研究方案文档或简介自动提取纳入与排除标准">从研究方案提取纳排规则</button>
          <select id="rsEligTplSel" style="max-width:220px;">
            <option value="">加载专科纳排模板…</option>
            <option value="oncology_solid_tumor">实体瘤临床研究标准模板</option>
            <option value="metabolic_chronic_disease">代谢与慢病管理队列模板</option>
            <option value="radiomics_body_comp">影像组学与体成分纵向随访模板</option>
          </select>
          <button type="button" class="small-btn" data-save-plan title="将当前纳入与排除规则保存为本研究方案的默认纳排标准">保存为本研究纳排方案</button>
          <span id="rsEligPlanStatus" class="muted small" style="margin-left:auto;"></span>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(300px, 1fr));gap:10px;">
          <div style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <b class="small" style="color:var(--ok, #059669);">纳入标准 (Inclusion Rules · 均需满足)</b>
              <button type="button" class="quiet small-btn" data-add-rule="inclusion">＋ 新增纳入项</button>
            </div>
            <div id="rsIncRulesList" style="display:flex;flex-direction:column;gap:4px;"></div>
          </div>
          <div style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <b class="small" style="color:var(--danger, #dc2626);">排除标准 (Exclusion Rules · 命中即排除并记入 CONSORT)</b>
              <button type="button" class="quiet small-btn" data-add-rule="exclusion">＋ 新增排除项</button>
            </div>
            <div id="rsExcRulesList" style="display:flex;flex-direction:column;gap:4px;"></div>
          </div>
        </div>

        <div id="rsRuleCreator" style="display:none;background:var(--raised);padding:8px 10px;border:1px dashed var(--line);border-radius:6px;gap:8px;flex-wrap:wrap;align-items:flex-end;">
          <label class="small">规则类型
            <select id="rsNewRuleKind">
              <option value="tag">诊断标签包含</option>
              <option value="lab">化验指标阈值</option>
              <option value="imaging_metric">3D 影像/体成分指标</option>
              <option value="record_text">病历/病理记录包含文本</option>
              <option value="demographic">年龄范围</option>
              <option value="manual_check">人工复核清单项（如知情同意/ECOG）</option>
            </select>
          </label>
          <label class="small" style="flex:1;min-width:160px;">规则名称/描述
            <input id="rsNewRuleTitle" placeholder="例如：既往合并恶性肿瘤病史 / eGFR >= 30">
          </label>
          <label class="small" id="rsNewRuleParamWrap">参数/关键词/指标名
            <input id="rsNewRuleParam" placeholder="例如：恶性肿瘤 或 eGFR 或 l3_smi">
          </label>
          <label class="small" id="rsNewRuleOpWrap" style="display:none;">比较符
            <select id="rsNewRuleOp"><option value=">=">&gt;=</option><option value=">">&gt;</option><option value="<=">&lt;=</option><option value="<">&lt;</option><option value="=">=</option></select>
          </label>
          <label class="small" id="rsNewRuleValWrap" style="display:none;">阈值
            <input id="rsNewRuleVal" type="number" step="any" placeholder="数值" style="width:90px;">
          </label>
          <button type="button" class="small-btn primary" data-confirm-add-rule>添加</button>
          <button type="button" class="small-btn quiet" data-cancel-add-rule>取消</button>
        </div>

        <details style="border:1px solid var(--line);border-radius:6px;padding:6px 10px;">
          <summary class="small muted" style="cursor:pointer;">快捷基线条件与定稿肺结节条件（可与方案纳排规则组合使用）</summary>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
            <div class="row"><label>性别<select name="sex"><option value="">不限</option><option value="M">男</option><option value="F">女</option></select></label>
              <label>年龄 ≥<input name="age_min" type="number" min="0" max="130"></label><label>年龄 ≤<input name="age_max" type="number" min="0" max="130"></label></div>
            <label>诊断标签包含（任一，逗号分隔）<input name="tags" placeholder="例如：CKD, 糖尿病"></label>
            <div><div class="muted small">化验条件（都要满足）</div><div id="rsLabs"></div><button type="button" class="small-btn" data-addlab>＋ 化验条件</button></div>
            <div><div class="muted small">已定稿肺结节条件（W6.1，都要满足；只匹配已定稿检查）</div><div id="rsNodules"></div><button type="button" class="small-btn" data-addnodule>＋ 已定稿肺结节条件</button></div>
            <datalist id="rsTests"><option value="肌酐"><option value="eGFR"><option value="HbA1c"><option value="血糖"><option value="血红蛋白"><option value="ALT"><option value="AST"><option value="白蛋白"><option value="尿酸"><option value="LDL-C"><option value="NT-proBNP"><option value="CEA"></datalist>
            <div class="row"><label>化验日期从<input name="from" type="date"></label><label>到<input name="to" type="date"></label></div>
          </div>
        </details>

        <div class="row end"><button type="submit" class="primary">执行纳排筛选预览</button></div>
        <div id="rsPreview"></div>
      </form></div>`
    dlg.hidden = false
    const form = dlg.querySelector<HTMLFormElement>('#screenForm')!
    let lastCriteria: Record<string, unknown> = {}
    let incRules: Array<any> = []
    let excRules: Array<any> = []
    const manualConfirmed = new Set<string>()
    let addingPhase: 'inclusion' | 'exclusion' = 'inclusion'

    const renderPlanRules = () => {
      const renderList = (rules: Array<any>, phase: 'inclusion' | 'exclusion') => {
        if (!rules.length) return `<div class="muted small">暂无${phase === 'inclusion' ? '结构化纳入' : '结构化排除'}规则（可从研究方案提取、选专科模板或点右上角新增）</div>`
        return rules.map((r, idx) => {
          const isManual = r.predicate?.kind === 'manual_check'
          const checked = manualConfirmed.has(r.id)
          return `<div style="display:flex;align-items:center;gap:6px;font-size:12px;background:var(--panel);padding:4px 6px;border-radius:4px;border:1px solid var(--line);">
            <span class="rs-kind">${esc(r.predicate?.kind ?? 'rule')}</span>
            <span style="flex:1;"><b>${esc(r.title || r.id)}</b></span>
            ${isManual && phase === 'inclusion' ? `<label class="small" style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;"><input type="checkbox" data-manual-rule="${esc(r.id)}" ${checked ? 'checked' : ''}>人工确认满足</label>` : ''}
            <button type="button" class="quiet small-btn" data-del-rule="${phase}" data-rule-idx="${idx}" title="移除">✕</button>
          </div>`
        }).join('')
      }
      $('rsIncRulesList').innerHTML = renderList(incRules, 'inclusion')
      $('rsExcRulesList').innerHTML = renderList(excRules, 'exclusion')
    }

    // 初始化加载研究已保存的 eligibility_plan
    void (async () => {
      try {
        const stInfo = await api<any>(`/api/studies/${studyId}`)
        const plan = stInfo?.eligibility_plan
        if (plan && (Array.isArray(plan.inclusion_rules) || Array.isArray(plan.exclusion_rules))) {
          incRules = Array.isArray(plan.inclusion_rules) ? [...plan.inclusion_rules] : []
          excRules = Array.isArray(plan.exclusion_rules) ? [...plan.exclusion_rules] : []
          $('rsEligPlanStatus').textContent = `已加载本方案纳排规则（纳入 ${incRules.length} 条 · 排除 ${excRules.length} 条）`
        }
      } catch {}
      renderPlanRules()
    })()

    const kindSel = dlg.querySelector<HTMLSelectElement>('#rsNewRuleKind')!
    kindSel.onchange = () => {
      const k = kindSel.value
      const needOp = k === 'lab' || k === 'imaging_metric' || k === 'demographic'
      ;($('rsNewRuleOpWrap') as HTMLElement).style.display = needOp ? '' : 'none'
      ;($('rsNewRuleValWrap') as HTMLElement).style.display = needOp ? '' : 'none'
      ;($('rsNewRuleParamWrap') as HTMLElement).style.display = (k === 'manual_check' || k === 'demographic') ? 'none' : ''
    }

    const tplSel = dlg.querySelector<HTMLSelectElement>('#rsEligTplSel')!
    tplSel.onchange = async () => {
      const tplId = tplSel.value
      if (!tplId) return
      try {
        const res = await api<{ eligibility_plan: any }>(`/api/studies/${studyId}/eligibility/extract`, {
          method: 'POST',
          body: JSON.stringify({ template_id: tplId, save: true }),
        })
        incRules = res.eligibility_plan?.inclusion_rules ?? []
        excRules = res.eligibility_plan?.exclusion_rules ?? []
        $('rsEligPlanStatus').textContent = `已应用模板（纳入 ${incRules.length} 条 · 排除 ${excRules.length} 条）`
        renderPlanRules()
        notice('已加载专科纳排模板并保存至研究方案')
      } catch (err) {
        notice((err as Error).message, true)
      }
    }

    const criteria = () => {
      const f = new FormData(form)
      const num = (k: string) => (f.get(k) as string) ? Number(f.get(k)) : undefined
      const labs = [...form.querySelectorAll<HTMLElement>('.rs-labrow')].map(r => ({
        test: r.querySelector<HTMLInputElement>('[name=lab_test]')!.value.trim(), mode: r.querySelector<HTMLSelectElement>('[name=lab_mode]')!.value,
        op: r.querySelector<HTMLSelectElement>('[name=lab_op]')!.value, value: r.querySelector<HTMLInputElement>('[name=lab_value]')!.value,
      })).filter(l => l.test || l.value).map(l => ({ ...l, value: Number(l.value) }))
      const imaging_nodules = [...form.querySelectorAll<HTMLElement>('.rs-nodulerow')].map(r => {
        const field = r.querySelector<HTMLSelectElement>('[name=nodule_field]')!.value
        const nodule_type = r.querySelector<HTMLSelectElement>('[name=nodule_type]')!.value || undefined
        const op = r.querySelector<HTMLSelectElement>('[name=nodule_op]')!.value
        const rawVal = r.querySelector<HTMLInputElement>('[name=nodule_value]')!.value.trim()
        const rawMin = r.querySelector<HTMLInputElement>('[name=nodule_min_studies]')!.value.trim()
        return {
          field,
          nodule_type,
          op,
          value: rawVal ? Number(rawVal) : NaN,
          min_finalized_studies: rawMin ? Number(rawMin) : undefined,
        }
      }).filter(n => Number.isFinite(n.value))
      return {
        sex: f.get('sex') || undefined,
        age_min: num('age_min'),
        age_max: num('age_max'),
        tags_any: String(f.get('tags') ?? '').split(/[,，、]/).map(x => x.trim()).filter(Boolean),
        labs,
        imaging_nodules: imaging_nodules.length ? imaging_nodules : undefined,
        inclusion_rules: incRules.length ? incRules : undefined,
        exclusion_rules: excRules.length ? excRules : undefined,
        manual_confirmed_rules: manualConfirmed.size ? [...manualConfirmed] : undefined,
        from: f.get('from') || undefined,
        to: f.get('to') || undefined,
      }
    }
    dlg.onclick = async e => {
      const t = e.target as HTMLElement
      if (e.target === dlg || t.closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = ''; return }
      if (t.closest('[data-addlab]')) { $('rsLabs').insertAdjacentHTML('beforeend', labRow()); return }
      if (t.closest('[data-dellab]')) { t.closest('.rs-labrow')?.remove(); return }
      if (t.closest('[data-addnodule]')) { $('rsNodules').insertAdjacentHTML('beforeend', noduleRow()); return }
      if (t.closest('[data-delnodule]')) { t.closest('.rs-nodulerow')?.remove(); return }
      if (t.closest('[data-extract-protocol]')) {
        try {
          const res = await api<{ eligibility_plan: any; extracted_count: number }>(`/api/studies/${studyId}/eligibility/extract`, {
            method: 'POST',
            body: JSON.stringify({ save: true }),
          })
          if ((res.extracted_count ?? 0) === 0) {
            const pasted = await askText({
              title: '粘贴研究方案纳排标准段落',
              label: '当前研究尚未关联研究方案文档或未检出纳排段落。请直接粘贴研究方案中的「纳入标准 / 排除标准」文本：',
              placeholder: '纳入标准：\n1. 年龄 18-80 岁\n2. 诊断：2型糖尿病\n3. eGFR >= 30\n排除标准：\n1. 病历包含：恶性肿瘤\n2. ALT >= 120',
            })
            if (pasted && pasted.trim()) {
              const res2 = await api<{ eligibility_plan: any; extracted_count: number; extracted_custom_vars?: Array<{ label: string }>; recommended_design?: string | null }>(`/api/studies/${studyId}/eligibility/extract`, {
                method: 'POST',
                body: JSON.stringify({ protocol_text: pasted.trim(), save: true }),
              })
              incRules = res2.eligibility_plan?.inclusion_rules ?? []
              excRules = res2.eligibility_plan?.exclusion_rules ?? []
              renderPlanRules()
              const varExtra2 = res2.extracted_custom_vars?.length ? ` · 自动预置 ${res2.extracted_custom_vars.length} 个终点/标志物变量` : ''
              $('rsEligPlanStatus').textContent = `已从方案文本提取（纳入 ${incRules.length} 条 · 排除 ${excRules.length} 条${varExtra2}）`
              notice(`已从方案提取 ${incRules.length} 条纳入规则与 ${excRules.length} 条排除规则${varExtra2}`)
            }
          } else {
            incRules = res.eligibility_plan?.inclusion_rules ?? []
            excRules = res.eligibility_plan?.exclusion_rules ?? []
            renderPlanRules()
            const varExtra = (res as any).extracted_custom_vars?.length ? ` · 自动预置 ${(res as any).extracted_custom_vars.length} 个终点/标志物变量` : ''
            $('rsEligPlanStatus').textContent = `已从研究方案提取（纳入 ${incRules.length} 条 · 排除 ${excRules.length} 条${varExtra}）`
            notice(`已从研究方案文档提取 ${incRules.length} 条纳入规则与 ${excRules.length} 条排除规则${varExtra}`)
          }
        } catch (err) {
          notice((err as Error).message, true)
        }
        return
      }
      if (t.closest('[data-save-plan]')) {
        try {
          await api(`/api/studies/${studyId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              eligibility_plan: {
                version: 1,
                source: 'manual',
                inclusion_rules: incRules,
                exclusion_rules: excRules,
              },
            }),
          })
          $('rsEligPlanStatus').textContent = `已保存（纳入 ${incRules.length} 条 · 排除 ${excRules.length} 条）`
          notice('已保存为本研究默认纳排方案')
        } catch (err) {
          notice((err as Error).message, true)
        }
        return
      }
      const addRuleBtn = t.closest<HTMLElement>('[data-add-rule]')
      if (addRuleBtn) {
        addingPhase = (addRuleBtn.dataset.addRule as 'inclusion' | 'exclusion') || 'inclusion'
        $('rsRuleCreator').style.display = 'flex'
        ;($('rsNewRuleTitle') as HTMLInputElement).focus()
        return
      }
      if (t.closest('[data-cancel-add-rule]')) {
        $('rsRuleCreator').style.display = 'none'
        return
      }
      if (t.closest('[data-confirm-add-rule]')) {
        const k = kindSel.value
        const title = ($('rsNewRuleTitle') as HTMLInputElement).value.trim()
        const param = ($('rsNewRuleParam') as HTMLInputElement).value.trim()
        const op = ($('rsNewRuleOp') as HTMLSelectElement).value
        const val = Number(($('rsNewRuleVal') as HTMLInputElement).value)
        const id = `${addingPhase === 'inclusion' ? 'inc' : 'exc'}_${Date.now().toString(36)}`
        let predicate: any = null
        if (k === 'tag') {
          const tags = (param || title).split(/[,，、]/).map(s => s.trim()).filter(Boolean)
          if (!tags.length) { notice('请填写诊断标签关键词', true); return }
          predicate = { kind: 'tags', mode: 'any', tags }
        } else if (k === 'lab') {
          if (!param || !Number.isFinite(val)) { notice('请填写化验项目名称与数值阈值', true); return }
          predicate = { kind: 'lab', name: param, mode: 'latest', op, value: val }
        } else if (k === 'imaging_metric') {
          if (!Number.isFinite(val)) { notice('请填写影像指标阈值', true); return }
          predicate = { kind: 'imaging', metric: param || 'lesion_diameter_mm', op, value: val }
        } else if (k === 'record_text') {
          const kw = param || title
          if (!kw) { notice('请填写病历或病理需检索的关键词', true); return }
          predicate = { kind: 'record', record_kind: 'any', keyword: kw, mode: 'present' }
        } else if (k === 'demographic') {
          if (!Number.isFinite(val)) { notice('请填写年龄阈值', true); return }
          predicate = op.startsWith('>') ? { kind: 'demographics', min_age: val } : { kind: 'demographics', max_age: val }
        } else {
          predicate = { kind: 'manual', label: title || '人工复核项' }
        }
        const ruleObj = { id, type: addingPhase, title: title || param || id, enabled: true, predicate }
        if (addingPhase === 'inclusion') incRules.push(ruleObj)
        else excRules.push(ruleObj)
        $('rsRuleCreator').style.display = 'none'
        ;($('rsNewRuleTitle') as HTMLInputElement).value = ''
        ;($('rsNewRuleParam') as HTMLInputElement).value = ''
        renderPlanRules()
        return
      }
      const delRuleBtn = t.closest<HTMLElement>('[data-del-rule]')
      if (delRuleBtn) {
        const phase = delRuleBtn.dataset.delRule
        const idx = Number(delRuleBtn.dataset.ruleIdx)
        if (phase === 'inclusion') incRules.splice(idx, 1)
        else excRules.splice(idx, 1)
        renderPlanRules()
        return
      }
      const manualChk = t.closest<HTMLInputElement>('[data-manual-rule]')
      if (manualChk) {
        const rid = manualChk.dataset.manualRule!
        if (manualChk.checked) manualConfirmed.add(rid)
        else manualConfirmed.delete(rid)
        return
      }
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
        const r = await api<{ total: number; patients: Candidate[]; funnel?: { assessed_total: number; inclusion_passed: number; excluded_total: number; exclusions_by_rule: Array<{ rule_id: string; title: string; count: number }>; eligible_total: number } }>(`/api/studies/${studyId}/cohort/preview`, { method: 'POST', body: JSON.stringify(lastCriteria) })
        const fresh = r.patients.filter(p => !p.subject_id).length
        const funnelHtml = r.funnel ? `
          <div style="background:var(--raised);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-bottom:8px;font-size:12px;">
            <div><b>CONSORT 纳排筛选漏斗（已自动同步至研究流向图）：</b>在管评估 <b>${r.funnel.assessed_total}</b> 人 → 纳入通过 <b>${r.funnel.inclusion_passed}</b> 人 → 规则排除 <b>${r.funnel.excluded_total}</b> 人 → 最终符合 <b>${r.funnel.eligible_total}</b> 人</div>
            ${r.funnel.exclusions_by_rule.length ? `<div class="muted small" style="margin-top:4px;">排除明细：${r.funnel.exclusions_by_rule.map(ex => `${esc(ex.title)} (n=${ex.count})`).join(' · ')}</div>` : ''}
          </div>` : ''
        $('rsPreview').innerHTML = funnelHtml + (r.total === 0 ? '<div class="muted">没有符合条件的患者。</div>' : `
          <div class="rs-preview-head"><b>符合条件 ${r.total} 人</b>${fresh < r.total ? `<span class="muted small">（${r.total - fresh} 人已入组）</span>` : ''}</div>
          <div class="ds-scroll"><table class="users rs-candidates"><thead><tr><th><input type="checkbox" data-pickall checked aria-label="全选"></th><th>代号</th><th>性别</th><th>年龄</th><th>诊断标签</th><th>匹配依据</th></tr></thead><tbody>
          ${r.patients.map(p => `<tr><td><input type="checkbox" name="pick" value="${p.patient_id}"${p.subject_id ? ' disabled' : ' checked'} aria-label="${esc(p.code)}"></td><td><b>${esc(p.code)}</b>${p.subject_id ? ` <span class="muted small">已入组 ${esc(p.subject_id)}</span>` : ''}</td>
            <td>${esc(SEX[p.sex ?? ''] ?? '')}</td><td>${p.age ?? ''}</td><td>${esc(p.tags.join('、'))}</td><td class="small">${esc(p.matched.join('；') || '—')}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="row end"><button type="button" class="primary" data-enroll${fresh ? '' : ' disabled'}>入组选中的患者</button></div>`)
      } catch (err) { notice((err as Error).message, true) }
    }
  }

  /** 生成研究数据集：宽表 / 长表、化验项目、基线时间窗与纵向随访时间点。 */
  function datasetDialog(studyId: string, shape = 'wide'): void {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card small" role="dialog" aria-modal="true" aria-label="生成研究数据集">
      <div class="dialog-head"><h2>生成研究数据集</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="genForm">
        <label>形状<select name="shape"><option value="wide"${shape === 'wide' ? ' selected' : ''}>宽表：每人一行（基线 / 最近值、随访节点与结局）</option><option value="long"${shape === 'long' ? ' selected' : ''}>长表：每次化验一行（适合混合效应模型）</option></select></label>
        <label>化验项目（可选，逗号分隔；不填 = 全部）<input name="tests" placeholder="例如：肌酐, eGFR, HbA1c"></label>
        <label>基线值锚定时间窗（围绕入组日期 Day 0 自动就近取值）
          <select name="baseline_window">
            <option value="">不限（取研究期间最早一次记录作为基线）</option>
            <option value="-30,7">入组日前 30 天至后 7 天 [-30d, +7d]（推荐临床试验/队列）</option>
            <option value="-14,3">入组日前 14 天至后 3 天 [-14d, +3d]（严格围入组期）</option>
            <option value="-90,14">入组日前 90 天至后 14 天 [-90d, +14d]（真实世界慢病队列）</option>
          </select>
        </label>
        <div style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--panel);">
          <div class="small" style="font-weight:600;margin-bottom:4px;">纵向随访时间点衍生列（宽表可选，围绕入组后天数就近提取）</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:12px;">
            <label style="display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" name="landmark" value="m1"> M1 (30天±15d)</label>
            <label style="display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" name="landmark" value="m3"> M3 (90天±30d)</label>
            <label style="display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" name="landmark" value="m6"> M6 (180天±45d)</label>
            <label style="display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" name="landmark" value="m12"> M12 (365天±60d)</label>
          </div>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin-top:6px;">
            <input type="checkbox" name="include_change" value="1"> 同时生成较基线绝对变化量 (<code>_delta</code>) 与百分比变化率 (<code>_change_pct</code>)
          </label>
        </div>
        <div class="row"><label>绝对化验日期从<input name="from" type="date"></label><label>到<input name="to" type="date"></label></div>
        <div class="muted small">数据集里只有研究编号，没有代号；数值统一换算到标准单位，并自动合并已核实的研究终点与多模态变量。之后入组或化验有变化会提示刷新。</div>
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
      const bwRaw = String(f.get('baseline_window') ?? '').trim()
      const baseline_window_days = bwRaw ? bwRaw.split(',').map(Number) as [number, number] : null
      const landmarks = form.querySelectorAll<HTMLInputElement>('input[name="landmark"]:checked')
      const landmarkArr = Array.from(landmarks).map(cb => cb.value)
      const include_change = form.querySelector<HTMLInputElement>('input[name="include_change"]')?.checked || false
      try {
        const r = await api<{ dataset: { name: string }; unchanged: boolean; skipped: string[] }>(`/api/studies/${studyId}/cohort/dataset`, { method: 'POST', body: JSON.stringify({
          shape: f.get('shape'),
          tests: String(f.get('tests') ?? '').split(/[,，、]/).map(x => x.trim()).filter(Boolean),
          from: f.get('from') || null,
          to: f.get('to') || null,
          baseline_window_days,
          landmarks: landmarkArr.length ? landmarkArr : undefined,
          include_change: include_change || undefined,
        }) })
        dlg.hidden = true; dlg.innerHTML = ''
        notice(r.unchanged ? `数据没有变化，沿用「${r.dataset.name}」` : `已生成「${r.dataset.name}」并归入研究${r.skipped.length ? `；${r.skipped.join('、')} 你已不在诊疗组里，没有包含` : ''}`)
        void openStudy(studyId); void loadList()
      } catch (err) { btn.disabled = false; btn.textContent = '生成'; notice((err as Error).message, true) }
    }
  }

  /** W6.4 去标识化影像与结节数据导出申请、烧录文字扫描拦截及 PI 审批留痕。 */
  async function imagingExportDialog(studyId: string): Promise<void> {
    let myRole: Role = 'viewer'
    try { myRole = (await api<{ my_role?: Role }>(`/api/studies/${studyId}`)).my_role ?? 'viewer' } catch {}
    const isOwner = myRole === 'owner'
    const canEdit = myRole !== 'viewer'
    type ExportItem = {
      id: string
      study_id: string
      requested_by: string
      reason: string
      status: 'pending_pi_approval' | 'approved' | 'rejected'
      reviewed_by: string | null
      review_note: string | null
      deid_profile: string
      included_subjects: number
      included_studies: number
      included_series: number
      blocked_series: Array<{ subject_id: string; study_uid: string; series_uid: string; modality: string | null; description: string | null; reason: string }>
      manifest: Array<{ subject_id: string; study_date: string | null; signoff_version: number; lesion_count: number }>
      csv_preview: string
      created_at: string
      reviewed_at: string | null
    }
    const STATUS_BADGE: Record<ExportItem['status'], string> = {
      pending_pi_approval: '<span class="flag-L small">待 PI 审批</span>',
      approved: '<span class="pill green small">PI 已批准</span>',
      rejected: '<span class="flag-H small">已驳回</span>',
    }
    const dlg = $('dialog')
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    const render = async () => {
      let exportsList: ExportItem[] = []
      try {
        const res = await api<{ exports: ExportItem[] }>(`/api/studies/${studyId}/cohort/imaging-exports`)
        exportsList = res.exports ?? []
      } catch (err) {
        notice((err as Error).message, true)
        close()
        return
      }
      dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="去标识影像导出与 PI 审批">
        <div class="dialog-head"><h2>去标识影像导出与 PI 审批（W6.4）</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
        <div class="dialog-body" style="display:flex;flex-direction:column;gap:12px;">
          <div class="muted small">
            严格遵循 DICOM PS3.15 Basic Application Level Confidentiality Profile 去标识规范：受试者统一映射为研究编号（S001…），仅纳入已定稿（Sign-off）影像检查，自动拦截带烧录文字风险（BurnedInAnnotation=YES 或截图/派生序列 SC/OT/SR）的序列，且须由研究负责人（PI）审批留痕后方可下载。
          </div>
          ${canEdit ? `<form class="form" id="imgExpForm" style="background:var(--raised);padding:10px;border:1px solid var(--line);border-radius:6px;">
            <div class="row" style="align-items:flex-end;gap:8px;">
              <label style="flex:1;">申请导出用途说明（必填，记入伦理与合规审计留痕）
                <input name="reason" required placeholder="例如：队列基线肺结节形态学特征与倍增时间统计分析">
              </label>
              <button type="submit" class="primary small-btn">发起导出申请</button>
            </div>
          </form>` : ''}
          ${exportsList.length === 0 ? '<div class="muted small">暂无影像导出申请记录。</div>' : `
            <div class="ds-scroll">
              <table class="help-table">
                <thead><tr><th>申请时间</th><th>状态</th><th>用途说明</th><th>纳入范围（已定稿）</th><th>烧录风险拦截</th><th>审批意见 / 操作</th></tr></thead>
                <tbody>
                  ${exportsList.map(x => `
                    <tr data-exp-id="${esc(x.id)}">
                      <td class="small">${date(x.created_at)}</td>
                      <td>${STATUS_BADGE[x.status] ?? esc(x.status)}</td>
                      <td>${esc(x.reason)}</td>
                      <td class="small">${x.included_subjects} 名受试者 · ${x.included_studies} 份定稿检查 · ${x.included_series} 个安全序列</td>
                      <td class="small">
                        ${x.blocked_series.length === 0
                          ? '<span class="muted">无拦截</span>'
                          : `<details><summary class="flag-L" style="cursor:pointer;">已拦截 ${x.blocked_series.length} 个序列</summary>
                              ${x.blocked_series.map(b => `<div class="muted small">· ${esc(b.subject_id)} (${esc(b.modality ?? '—')}): ${esc(b.reason)}</div>`).join('')}
                            </details>`}
                      </td>
                      <td class="small">
                        ${x.status === 'pending_pi_approval'
                          ? (isOwner
                            ? `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                                <input type="text" data-exp-note="${esc(x.id)}" placeholder="审批备注（可选）" style="width:130px;">
                                <button type="button" class="small-btn primary" data-exp-review="${esc(x.id)}" data-decision="approved">PI 批准</button>
                                <button type="button" class="small-btn quiet danger-text" data-exp-review="${esc(x.id)}" data-decision="rejected">驳回</button>
                              </div>`
                            : '<span class="muted">等待 PI 审批</span>')
                          : `<div>${x.review_note ? `备注：${esc(x.review_note)} · ` : ''}${x.reviewed_at ? date(x.reviewed_at) : ''}</div>
                             ${x.status === 'approved' && x.csv_preview
                               ? `<button type="button" class="small-btn primary" data-exp-dl="${esc(x.id)}" style="margin-top:4px;">下载去标识结节清单 (.csv)</button>`
                               : ''}`}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </div>`
      dlg.hidden = false
      const form = dlg.querySelector<HTMLFormElement>('#imgExpForm')
      if (form) {
        form.onsubmit = async ev => {
          ev.preventDefault()
          const fd = new FormData(form)
          const reason = String(fd.get('reason') ?? '').trim()
          if (!reason) return
          try {
            await api(`/api/studies/${studyId}/cohort/imaging-exports`, { method: 'POST', body: JSON.stringify({ reason }) })
            notice('已提交去标识影像导出申请，等待 PI 审批')
            await render()
          } catch (err) {
            notice((err as Error).message, true)
          }
        }
      }
      dlg.onclick = async ev => {
        const t = ev.target as HTMLElement
        if (ev.target === dlg || t.closest('[data-close]')) { close(); return }
        const revBtn = t.closest<HTMLElement>('[data-exp-review]')
        if (revBtn) {
          const eid = revBtn.dataset.expReview!
          const decision = revBtn.dataset.decision as 'approved' | 'rejected'
          const noteInput = dlg.querySelector<HTMLInputElement>(`[data-exp-note="${eid}"]`)
          const note = noteInput?.value.trim() || undefined
          try {
            await api(`/api/studies/${studyId}/cohort/imaging-exports/${eid}/review`, {
              method: 'POST',
              body: JSON.stringify({ decision, note }),
            })
            notice(decision === 'approved' ? 'PI 已批准该导出申请' : '已驳回该导出申请')
            await render()
          } catch (err) {
            notice((err as Error).message, true)
          }
          return
        }
        const dlBtn = t.closest<HTMLElement>('[data-exp-dl]')
        if (dlBtn) {
          const eid = dlBtn.dataset.expDl!
          const item = exportsList.find(x => x.id === eid)
          if (item?.csv_preview) {
            downloadBlobContent(item.csv_preview, `cohort_deid_nodules_${studyId.slice(0, 8)}_${eid.slice(0, 6)}.csv`, 'text/csv;charset=utf-8')
          }
        }
      }
    }
    await render()
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

  /** 研究方案卡片里的计划样本量摘要与入组进度（计划人数按含脱落的入组目标计） */
  function sampleSizePlanSummary(plan: SampleSizePlanView | null, enrolled: number | null): string {
    if (!plan) return ''
    const target = plan.result.total_with_dropout
    const pct = enrolled !== null && target > 0 ? Math.min(100, Math.round((enrolled / target) * 100)) : null
    return `<div class="rs-ss-plan">
      <div class="small"><b>计划样本量：${target} 例</b>${target !== plan.result.total ? `<span class="muted">（未计脱落 ${plan.result.total} 例）</span>` : ''}
        <span class="muted"> · ${esc(plan.result.method)} · ${esc(plan.saved_by)} 保存于 ${date(plan.saved_at)}</span></div>
      ${pct !== null ? `<div class="rs-ss-progress" title="已入组 ${enrolled} / 计划 ${target}"><span style="width:${pct}%"></span></div>
        <div class="muted small">入组进度：${enrolled} / ${target}（${pct}%）</div>` : ''}
    </div>`
  }

  /** 样本量估算弹窗：参数改动即重算（后端计算，见 src/research/sample-size.ts），可复制方法学描述、保存为计划样本量、交给 AI 写入方案 */
  async function sampleSizeDialog(studyId: string): Promise<void> {
    const study = await api<Study>(`/api/studies/${studyId}`)
    const canEdit = study.my_role !== 'viewer'
    const protocol = study.docs.find(d => d.role === 'protocol')
    const prev = (study.sample_size_plan?.input ?? {}) as Record<string, unknown>
    const pv = (k: string, scale = 1): string => (typeof prev[k] === 'number' ? String(Number(((prev[k] as number) * scale).toPrecision(6))) : '')
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card wide" style="width:min(980px, calc(100vw - 24px));" role="dialog" aria-modal="true" aria-label="样本量估算">
      <div class="dialog-head">
        <h2>样本量估算</h2>
        <button class="quiet" data-close aria-label="关闭">✕</button>
      </div>
      <div class="dialog-body">
        <div class="muted small" style="margin-bottom:10px;">按研究设计、检验水准 α、检验效能 1−β 与预期效应量计算<b>计划样本量</b>。效应量应来自预试验、文献或临床上有意义的最小差值；改动参数即重新计算。</div>
        <div class="rs-studio-shell" style="grid-template-columns:minmax(300px, 380px) minmax(0, 1fr);">
          <div class="rs-studio-left" id="ssForm">
            <label>研究设计
              <select id="ssDesign">
                <option value="two_proportions">两组率比较（如有效率、事件率）</option>
                <option value="two_means">两组均值比较（如评分、化验值）</option>
                <option value="survival_logrank">生存分析（log-rank，按风险比 HR）</option>
                <option value="one_proportion">单臂率与历史对照比较（精确二项）</option>
                <option value="simon_two_stage">单臂 Simon 两阶段（II 期）</option>
              </select>
            </label>
            <div class="row" style="gap:8px;">
              <label style="flex:1;">α<input type="number" id="ssAlpha" step="0.005" min="0.001" max="0.2" value="${pv('alpha') || '0.05'}"></label>
              <label style="flex:1;">单/双侧
                <select id="ssSides"><option value="2">双侧</option><option value="1">单侧</option></select>
              </label>
              <label style="flex:1;">检验效能 (%)<input type="number" id="ssPower" step="5" min="50" max="99" value="${pv('power', 100) || '80'}"></label>
            </div>
            <div class="row" style="gap:8px;" data-ss-show="two_proportions two_means survival_logrank">
              <label style="flex:1;">分配比 组2:组1<input type="number" id="ssRatio" step="0.5" min="0.1" max="10" value="${pv('ratio') || '1'}"></label>
            </div>
            <label>预计脱落率 (%)<input type="number" id="ssDropout" step="1" min="0" max="90" value="${pv('dropout', 100)}" placeholder="如 10；不填按 0"></label>

            <div class="rs-sub-box" data-ss-show="two_proportions">
              <div class="row" style="gap:8px;">
                <label style="flex:1;">组 1（对照）率 %<input type="number" id="ssP1a" step="1" value="${pv('p1', 100)}" placeholder="必填"></label>
                <label style="flex:1;">组 2（试验）率 %<input type="number" id="ssP2a" step="1" value="${pv('p2', 100)}" placeholder="必填"></label>
              </div>
              <label class="small" style="display:flex;gap:6px;align-items:center;"><input type="checkbox" id="ssCc"${prev.continuity_correction ? ' checked' : ''}> Fleiss 连续性校正（更保守）</label>
            </div>
            <div class="rs-sub-box" data-ss-show="two_means">
              <div class="row" style="gap:8px;">
                <label style="flex:1;">两组均值差<input type="number" id="ssDiff" step="any" value="${pv('mean_diff')}" placeholder="必填"></label>
                <label style="flex:1;">共同标准差<input type="number" id="ssSd" step="any" value="${pv('sd')}" placeholder="必填"></label>
              </div>
            </div>
            <div class="rs-sub-box" data-ss-show="survival_logrank">
              <label>风险比 HR（组 2 相对组 1）<input type="number" id="ssHr" step="0.01" value="${pv('hr')}" placeholder="必填，如 0.7"></label>
              <label>事件发生比例
                <select id="ssEvMode"><option value="direct">直接填写研究期间总体事件发生比例</option><option value="median">由对照组中位生存期推算（指数分布）</option></select>
              </label>
              <div data-ss-ev="direct"><label>总体事件发生比例 %<input type="number" id="ssEvProb" step="1" value="${pv('event_prob', 100)}" placeholder="必填"></label></div>
              <div data-ss-ev="median" class="row" style="gap:6px;">
                <label style="flex:1;">组 1 中位生存期<input type="number" id="ssMed" step="any" value="${pv('median_control')}"></label>
                <label style="flex:1;">入组期<input type="number" id="ssAcc" step="any" value="${pv('accrual')}"></label>
                <label style="flex:1;">末例入组后随访<input type="number" id="ssFu" step="any" value="${pv('follow_up')}"></label>
              </div>
              <div class="muted small" data-ss-ev="median">三项用同一时间单位（如月）。</div>
            </div>
            <div class="rs-sub-box" data-ss-show="one_proportion simon_two_stage">
              <div class="row" style="gap:8px;">
                <label style="flex:1;">无效率 p0 %（历史对照）<input type="number" id="ssP0" step="1" value="${pv('p0', 100)}" placeholder="必填"></label>
                <label style="flex:1;">预期有效率 p1 %<input type="number" id="ssP1b" step="1" value="${pv('p1', 100)}" placeholder="必填"></label>
              </div>
            </div>
          </div>
          <div class="rs-studio-right" id="ssResult"><div class="muted small" style="padding:30px;">填写左侧参数后自动计算。</div></div>
        </div>
      </div>
    </div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }

    const el = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T
    const designSel = el<HTMLSelectElement>('ssDesign')
    const sidesSel = el<HTMLSelectElement>('ssSides')
    const evModeSel = el<HTMLSelectElement>('ssEvMode')
    const resultEl = el<HTMLDivElement>('ssResult')
    if (typeof prev.design === 'string') designSel.value = prev.design
    if (prev.sides === 1 || prev.sides === 2) sidesSel.value = String(prev.sides)
    else sidesSel.value = designSel.value === 'one_proportion' || designSel.value === 'simon_two_stage' ? '1' : '2'
    if (prev.median_control !== undefined && prev.event_prob === undefined) evModeSel.value = 'median'

    const num = (id: string, scale = 1): number | undefined => {
      const v = el(id).value.trim()
      return v === '' ? undefined : Number(v) / scale
    }
    const applyVisibility = () => {
      const d = designSel.value
      dlg.querySelectorAll<HTMLElement>('[data-ss-show]').forEach(x => { x.style.display = x.dataset.ssShow!.split(' ').includes(d) ? '' : 'none' })
      dlg.querySelectorAll<HTMLElement>('[data-ss-ev]').forEach(x => { x.style.display = x.dataset.ssEv === evModeSel.value ? '' : 'none' })
      // Simon 只支持单侧
      sidesSel.disabled = d === 'simon_two_stage'
      if (d === 'simon_two_stage') sidesSel.value = '1'
    }
    const buildInput = (): Record<string, unknown> => {
      const d = designSel.value
      const input: Record<string, unknown> = { design: d, alpha: num('ssAlpha'), power: num('ssPower', 100), sides: Number(sidesSel.value) }
      const dropout = num('ssDropout', 100)
      if (dropout !== undefined) input.dropout = dropout
      if (d === 'two_proportions' || d === 'two_means' || d === 'survival_logrank') input.ratio = num('ssRatio')
      if (d === 'two_proportions') Object.assign(input, { p1: num('ssP1a', 100), p2: num('ssP2a', 100), continuity_correction: el('ssCc').checked })
      if (d === 'two_means') Object.assign(input, { mean_diff: num('ssDiff'), sd: num('ssSd') })
      if (d === 'survival_logrank') {
        input.hr = num('ssHr')
        if (evModeSel.value === 'direct') input.event_prob = num('ssEvProb', 100)
        else Object.assign(input, { median_control: num('ssMed'), accrual: num('ssAcc'), follow_up: num('ssFu') })
      }
      if (d === 'one_proportion' || d === 'simon_two_stage') Object.assign(input, { p0: num('ssP0', 100), p1: num('ssP1b', 100) })
      return input
    }

    let lastInput: Record<string, unknown> | null = null
    let lastResult: SampleSizeResultView | null = null
    let seq = 0
    const renderResult = (r: SampleSizeResultView) => {
      const groupRows = r.groups.map(g => `<tr><td>${esc(g.label)}</td><td><b>${g.n}</b></td><td>${g.n_with_dropout}</td></tr>`).join('')
      const simon = r.simon
        ? `<table class="rs-data-table" style="margin-top:8px;"><thead><tr><th>Simon 设计</th><th>第一阶段</th><th>全程</th><th>H0 下提前终止</th><th>H0 下期望例数</th><th>实际 α / 效能</th></tr></thead><tbody>
            ${(['optimal', 'minimax'] as const).map(k => { const x = r.simon![k]; return `<tr><td>${k === 'optimal' ? '最优' : '极小极大'}</td><td>${x.n1} 例，有效 ≤ ${x.r1} 则终止</td><td>${x.n} 例，有效 > ${x.r} 判定有效</td><td>${(x.pet0 * 100).toFixed(1)}%</td><td>${x.en0}</td><td>${x.actual_alpha} / ${(x.actual_power * 100).toFixed(1)}%</td></tr>` }).join('')}
          </tbody></table><div class="muted small">上方例数按最优设计的全程最大样本量计；选择极小极大设计时以表中例数为准。</div>`
        : ''
      const op = r.one_proportion
        ? `<div class="small" style="margin-top:6px;">判定有效：有效例数 ≥ <b>${r.one_proportion.min_responses}</b>（实际 α = ${r.one_proportion.actual_alpha}，实际效能 ${(r.one_proportion.actual_power * 100).toFixed(1)}%）；正态近似参考值 ${r.one_proportion.normal_approx_n} 例。</div>`
        : ''
      resultEl.innerHTML = `
        <div class="row" style="gap:10px;flex-wrap:wrap;">
          <div class="rs-sub-box" style="flex:1;min-width:150px;"><span class="muted small">需要样本量</span><b style="font-size:24px;">${r.total} 例</b></div>
          <div class="rs-sub-box" style="flex:1;min-width:150px;"><span class="muted small">考虑脱落后计划入组</span><b style="font-size:24px;color:var(--mint-text);">${r.total_with_dropout} 例</b></div>
          ${r.events_required !== undefined ? `<div class="rs-sub-box" style="flex:1;min-width:150px;"><span class="muted small">需观察到的事件数</span><b style="font-size:24px;">${r.events_required}</b>${r.event_prob_used !== undefined ? `<span class="muted small">事件比例 ${(r.event_prob_used * 100).toFixed(1)}%</span>` : ''}</div>` : ''}
        </div>
        <table class="rs-data-table" style="margin-top:8px;"><thead><tr><th>组别</th><th>例数</th><th>含脱落</th></tr></thead><tbody>${groupRows}</tbody></table>
        ${op}${simon}
        ${(r.warnings ?? []).map(w => `<div class="small" style="color:var(--warn);margin-top:6px;">${esc(w)}</div>`).join('')}
        <div class="rs-sub-box" style="margin-top:10px;">
          <div class="rs-sub-box-title"><span>方法学描述（可直接写入方案「样本量」一节）</span>
            <span style="display:flex;gap:6px;"><button type="button" class="small-btn" id="ssCopyZh">${icon('copy', { size: 12 })} 复制中文</button><button type="button" class="small-btn" id="ssCopyEn">${icon('copy', { size: 12 })} 复制英文</button></span>
          </div>
          <div class="small" style="line-height:1.7;">${esc(r.methods_text_zh)}</div>
          <div class="small muted" style="line-height:1.6;margin-top:6px;">${esc(r.methods_text_en)}</div>
        </div>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px;">
          ${canEdit ? `<button type="button" class="small-btn primary" id="ssSaveBtn">${icon('check', { size: 12 })} 保存为本研究计划样本量</button>` : ''}
          <button type="button" class="small-btn" id="ssToProtocolBtn"${protocol ? '' : ' disabled title="请先新建研究方案"'}>${icon('write', { size: 12 })} 让 AI 写入研究方案</button>
        </div>`
      const copy = (t: string) => navigator.clipboard.writeText(t).then(() => notice('已复制方法学描述')).catch(() => notice('复制失败', true))
      el('ssCopyZh').onclick = () => void copy(r.methods_text_zh)
      el('ssCopyEn').onclick = () => void copy(r.methods_text_en)
      const saveBtn = document.getElementById('ssSaveBtn')
      if (saveBtn) saveBtn.onclick = async () => {
        try {
          // 只提交参数，服务端重新计算后保存
          await api(`/api/studies/${studyId}`, { method: 'PATCH', body: JSON.stringify({ sample_size_plan: { input: lastInput } }) })
          notice(`已保存计划样本量：${r.total_with_dropout} 例`)
          if (current === studyId) void openStudy(studyId)
        } catch (err) { notice((err as Error).message, true) }
      }
      const toProto = document.getElementById('ssToProtocolBtn')
      if (toProto && protocol) toProto.onclick = async () => {
        dlg.hidden = true
        dlg.innerHTML = ''
        await hooks.openDoc(protocol.doc_id)
        hooks.prefillChat(`请把下面的样本量计算写入本研究方案的「样本量」一节（没有该节就在统计分析部分新建），保持数字不变：\n${r.methods_text_zh}`)
      }
    }
    const recalc = async () => {
      applyVisibility()
      const input = buildInput()
      const my = ++seq
      try {
        const r = await api<SampleSizeResultView>('/api/sample-size', { method: 'POST', body: JSON.stringify(input) })
        if (my !== seq) return
        lastInput = input
        lastResult = r
        renderResult(r)
      } catch (err) {
        if (my !== seq) return
        lastResult = null
        resultEl.innerHTML = `<div class="muted small" style="padding:24px;">${esc((err as Error).message)}</div>`
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void recalc(), 250) }
    el('ssForm').addEventListener('input', schedule)
    el('ssForm').addEventListener('change', e => {
      if ((e.target as HTMLElement).id === 'ssDesign') {
        const d = designSel.value
        sidesSel.value = d === 'one_proportion' || d === 'simon_two_stage' ? '1' : '2'
      }
      schedule()
    })
    void lastResult
    await recalc()
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
                <input type="number" id="rsConsortAssessed" min="0" placeholder="待录入">
              </label>
              <label style="flex:1;">符合纳排入组人数 (Eligible)
                <input type="number" id="rsConsortEligible" min="0" placeholder="待录入">
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

            <div id="rsConsortStatus" class="small" style="line-height:1.6;"></div>

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

    // 人数一律为「真实来源或用户录入」：无来源时为 null（界面显示「待录入」），绝不填示例数字。
    type Cnt = number | null
    /** 字段来源：auto = 由队列 / 数据集带出；manual = 带出后被用户改过；缺省 = 用户从空白录入 */
    type FieldSrc = Record<string, 'auto' | 'manual'>
    type ExclRow = { reason: string; count: Cnt; src: FieldSrc }
    type ArmRow = { name: string; allocated: Cnt; received: Cnt; lost_to_followup: Cnt; discontinued: number; analyzed: Cnt; src: FieldSrc }
    type FlowState = { title: string; total_assessed: Cnt; eligible_total: Cnt; exclusions: ExclRow[]; arms: ArmRow[]; src: FieldSrc }

    const emptyExcl = (): ExclRow => ({ reason: '', count: null, src: {} })
    const emptyArm = (): ArmRow => ({ name: '', allocated: null, received: null, lost_to_followup: null, discontinued: 0, analyzed: null, src: {} })
    const emptyFlow = (title = 'CONSORT 2010 Participant Flow Diagram'): FlowState => ({
      title, total_assessed: null, eligible_total: null, exclusions: [emptyExcl()], arms: [emptyArm()], src: {},
    })
    /** 把带出的字段标记为 auto（仅对非空值） */
    const autoSrc = (obj: Record<string, unknown>, keys: string[]): FieldSrc =>
      Object.fromEntries(keys.filter(k => obj[k] != null && obj[k] !== '').map(k => [k, 'auto' as const]))

    let flowState: FlowState = emptyFlow()
    /** 当前数据来源说明，如「本研究入组队列记录」；为空表示全部手动录入 */
    let dataOrigin = ''
    /** 来源相关的补充说明（如平台未记录哪些环节） */
    let originNote = ''

    const assessedInp = document.getElementById('rsConsortAssessed') as HTMLInputElement
    const eligibleInp = document.getElementById('rsConsortEligible') as HTMLInputElement
    const exclTbody = document.getElementById('rsConsortExclTbody')!
    const armTbody = document.getElementById('rsConsortArmTbody')!
    const sourceSel = document.getElementById('rsConsortSourceSel') as HTMLSelectElement
    const dsMapWrap = document.getElementById('rsConsortDsMappingWrap')!
    const grpColSel = document.getElementById('rsConsortGrpCol') as HTMLSelectElement
    const outColSel = document.getElementById('rsConsortOutCol') as HTMLSelectElement
    const svgBox = document.getElementById('rsConsortSvgContainer')!
    const statusEl = document.getElementById('rsConsortStatus')!
    const exportBtnIds = [
      'rsConsortCopyPngBtn', 'rsConsortPngBtn', 'rsConsortArchiveBtn', 'rsConsortDownloadDrawio',
      'rsConsortDownloadVdx', 'rsConsortDownloadPptx', 'rsConsortDownloadSvg', 'rsConsortCopyMermaid',
    ]

    const numVal = (v: Cnt) => (v == null ? '' : String(v))
    const readNum = (el: HTMLInputElement | null | undefined): Cnt => {
      const s = (el?.value ?? '').trim()
      if (!s) return null
      const n = Number(s)
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
    }

    /** 按字段来源给输入框加标记，并在用户修改带出值时转为 manual */
    const bindOrigin = (el: HTMLInputElement, src: FieldSrc, key: string) => {
      const paint = () => {
        const s = src[key]
        el.classList.toggle('rs-cs-auto', s === 'auto')
        el.classList.toggle('rs-cs-manual', s === 'manual')
        el.title = s === 'auto' ? `来自${dataOrigin}` : s === 'manual' ? `已手动修改（原值来自${dataOrigin}）` : ''
      }
      paint()
      el.oninput = () => {
        if (src[key] === 'auto') { src[key] = 'manual'; paint() }
      }
    }

    const renderTables = () => {
      assessedInp.value = numVal(flowState.total_assessed)
      eligibleInp.value = numVal(flowState.eligible_total)
      bindOrigin(assessedInp, flowState.src, 'total_assessed')
      bindOrigin(eligibleInp, flowState.src, 'eligible_total')
      exclTbody.innerHTML = flowState.exclusions.map((ex, idx) => `
        <tr data-exidx="${idx}">
          <td><input type="text" class="rs-cs-exreason" value="${esc(ex.reason)}" placeholder="如：不符合纳入标准"></td>
          <td><input type="number" min="0" class="rs-cs-excnt" value="${numVal(ex.count)}" placeholder="待录入"></td>
          <td><button type="button" class="quiet small-btn" data-del-ex="${idx}" title="删除">✕</button></td>
        </tr>
      `).join('')
      armTbody.innerHTML = flowState.arms.map((a, idx) => `
        <tr data-armidx="${idx}">
          <td><input type="text" class="rs-cs-aname" value="${esc(a.name)}" placeholder="如：干预组"></td>
          <td><input type="number" min="0" class="rs-cs-alloc" value="${numVal(a.allocated)}" placeholder="—"></td>
          <td><input type="number" min="0" class="rs-cs-recv" value="${numVal(a.received)}" placeholder="—"></td>
          <td><input type="number" min="0" class="rs-cs-lost" value="${numVal(a.lost_to_followup)}" placeholder="—"></td>
          <td><input type="number" min="0" class="rs-cs-ana" value="${numVal(a.analyzed)}" placeholder="—"></td>
          <td><button type="button" class="quiet small-btn" data-del-arm="${idx}" title="删除">✕</button></td>
        </tr>
      `).join('')

      const exFields: Array<[string, string]> = [['.rs-cs-exreason', 'reason'], ['.rs-cs-excnt', 'count']]
      exclTbody.querySelectorAll<HTMLTableRowElement>('tr').forEach((tr, i) => {
        const row = flowState.exclusions[i]
        if (row) for (const [sel, key] of exFields) bindOrigin(tr.querySelector<HTMLInputElement>(sel)!, row.src, key)
      })
      const armFields: Array<[string, string]> = [
        ['.rs-cs-aname', 'name'], ['.rs-cs-alloc', 'allocated'], ['.rs-cs-recv', 'received'],
        ['.rs-cs-lost', 'lost_to_followup'], ['.rs-cs-ana', 'analyzed'],
      ]
      armTbody.querySelectorAll<HTMLTableRowElement>('tr').forEach((tr, i) => {
        const row = flowState.arms[i]
        if (row) for (const [sel, key] of armFields) bindOrigin(tr.querySelector<HTMLInputElement>(sel)!, row.src, key)
      })

      exclTbody.querySelectorAll<HTMLButtonElement>('[data-del-ex]').forEach(btn => {
        btn.onclick = () => {
          syncFromDom()
          flowState.exclusions.splice(Number(btn.dataset.delEx), 1)
          if (!flowState.exclusions.length) flowState.exclusions.push(emptyExcl())
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
      flowState.total_assessed = readNum(assessedInp)
      flowState.eligible_total = readNum(eligibleInp)
      // DOM 行与 flowState 行在 renderTables 时一一对应，按下标保留各行的来源标记
      flowState.exclusions = Array.from(exclTbody.querySelectorAll<HTMLTableRowElement>('tr')).map((tr, i) => ({
        src: flowState.exclusions[i]?.src ?? {},
        reason: tr.querySelector<HTMLInputElement>('.rs-cs-exreason')?.value.trim() || '',
        count: readNum(tr.querySelector<HTMLInputElement>('.rs-cs-excnt')),
      }))
      flowState.arms = Array.from(armTbody.querySelectorAll<HTMLTableRowElement>('tr')).map((tr, i) => ({
        src: flowState.arms[i]?.src ?? {},
        name: tr.querySelector<HTMLInputElement>('.rs-cs-aname')?.value.trim() || '',
        allocated: readNum(tr.querySelector<HTMLInputElement>('.rs-cs-alloc')),
        received: readNum(tr.querySelector<HTMLInputElement>('.rs-cs-recv')),
        lost_to_followup: readNum(tr.querySelector<HTMLInputElement>('.rs-cs-lost')),
        discontinued: 0,
        analyzed: readNum(tr.querySelector<HTMLInputElement>('.rs-cs-ana')),
      }))
    }

    const isBlankExcl = (ex: ExclRow) => !ex.reason && ex.count == null
    const isBlankArm = (a: ArmRow) => !a.name && a.allocated == null && a.received == null && a.lost_to_followup == null && a.analyzed == null

    /** 列出仍待录入的项；全空的排除原因行视为「无排除」，全空的分组行忽略 */
    const missingFields = (): string[] => {
      const miss: string[] = []
      if (flowState.total_assessed == null) miss.push('初筛评估总人数')
      if (flowState.eligible_total == null) miss.push('符合纳排入组人数')
      flowState.exclusions.forEach((ex, i) => {
        if (isBlankExcl(ex)) return
        if (!ex.reason) miss.push(`排除原因 ${i + 1} 的说明`)
        if (ex.count == null) miss.push(`排除原因 ${i + 1} 的人数`)
      })
      const arms = flowState.arms.filter(a => !isBlankArm(a))
      if (!arms.length) miss.push('至少一个研究组')
      arms.forEach((a, i) => {
        const label = a.name || `研究组 ${i + 1}`
        if (!a.name) miss.push(`研究组 ${i + 1} 的组名`)
        const lacks = ([['allocated', '分配'], ['received', '接受'], ['lost_to_followup', '失访'], ['analyzed', '分析']] as const)
          .filter(([k]) => a[k] == null).map(([, t]) => t)
        if (lacks.length) miss.push(`${label}：${lacks.join(' / ')}人数`)
      })
      return miss
    }

    const countManual = () => {
      const all = [flowState.src, ...flowState.exclusions.map(e => e.src), ...flowState.arms.map(a => a.src)]
      return all.reduce((acc, s) => acc + Object.values(s).filter(v => v === 'manual').length, 0)
    }

    const renderStatus = (miss: string[]) => {
      const parts: string[] = []
      parts.push(dataOrigin
        ? `<span class="rs-cs-legend rs-cs-auto">带出</span> 来自${esc(dataOrigin)}`
        : '<span class="muted">数据来源：手动录入</span>')
      const manual = countManual()
      if (manual) parts.push(`<span class="rs-cs-legend rs-cs-manual">已改</span> ${manual} 项带出值已被手动修改`)
      if (originNote) parts.push(`<span class="muted">${esc(originNote)}</span>`)
      if (miss.length) {
        parts.push(`<span style="color:var(--warn);">还有 ${miss.length} 项待录入：${esc(miss.slice(0, 4).join('、'))}${miss.length > 4 ? ' 等' : ''}。补齐前不能导出或归档。</span>`)
      }
      statusEl.innerHTML = parts.map(p => `<div>${p}</div>`).join('')
    }

    const setExportsEnabled = (on: boolean) => {
      for (const id of exportBtnIds) {
        const b = document.getElementById(id) as HTMLButtonElement | null
        if (!b) continue
        b.disabled = !on
        if (!on) b.dataset.prevTitle ??= b.title
        b.title = on ? (b.dataset.prevTitle ?? b.title) : '请先补齐左侧待录入的人数'
      }
    }

    /** 导出前兜底校验（编辑后未点「更新并渲染」也会拦截） */
    const ensureComplete = (): boolean => {
      syncFromDom()
      const miss = missingFields()
      if (miss.length) {
        notice(`还有 ${miss.length} 项待录入，补齐后才能导出：${miss.slice(0, 3).join('、')}${miss.length > 3 ? ' 等' : ''}`, true)
        renderStatus(miss)
        return false
      }
      return true
    }

    const buildPayload = () => ({
      category: 'flowchart',
      title: flowState.title,
      total_assessed: flowState.total_assessed ?? 0,
      eligible_total: flowState.eligible_total ?? 0,
      exclusions: flowState.exclusions.filter(ex => !isBlankExcl(ex)).map(ex => ({ reason: ex.reason, count: ex.count ?? 0 })),
      arms: flowState.arms.filter(a => !isBlankArm(a)).map(a => ({
        name: a.name,
        allocated: a.allocated ?? 0,
        received: a.received ?? 0,
        lost_to_followup: a.lost_to_followup ?? 0,
        discontinued: a.discontinued,
        analyzed: a.analyzed ?? 0,
      })),
    })

    /** 待录入时的灰色骨架预览：只画结构，人数一律显示「—」 */
    const skeletonHtml = (miss: number) => {
      const box = (t: string) => `<div style="border:1px dashed var(--line-strong);padding:10px 14px;min-width:220px;text-align:center;color:var(--text-2);font-size:12px;">${t}<br><b>n = —</b></div>`
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:14px;padding:28px 12px;opacity:.75;">
        <div class="muted small">流向图待录入（还缺 ${miss} 项）。补齐左侧人数后点击「更新并渲染」生成正式图。</div>
        ${box('评估初筛受试者 (Assessed for eligibility)')}
        ${box('排除受试者 (Excluded)')}
        ${box('合格入组 (Eligible / Allocated)')}
        <div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:center;">${box('研究组 (Arm)')}</div>
      </div>`
    }

    const renderFlowSvg = async () => {
      const miss = missingFields()
      renderStatus(miss)
      if (miss.length) {
        currentSvg = ''
        currentDrawio = ''
        svgBox.innerHTML = skeletonHtml(miss.length)
        setExportsEnabled(false)
        return
      }
      svgBox.innerHTML = `<div class="muted small" style="padding:40px;">正在渲染出版级 CONSORT 矢量流向图…</div>`
      try {
        const res = await api<any>(`/api/studies/${studyId}/figures`, {
          method: 'POST',
          body: JSON.stringify(buildPayload()),
        })
        currentSvg = res.illustrator_svg || res.svg || res.native_exports?.illustrator_svg || ''
        currentDrawio = res.drawio_xml || res.native_exports?.drawio_xml || ''
        svgBox.innerHTML = safeSvg(currentSvg) || '<div class="muted small">未生成流程图</div>'
        setExportsEnabled(!!currentSvg)
      } catch (err) {
        svgBox.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
        setExportsEnabled(false)
      }
    }

    /**
     * 从本研究入组记录带出真实人数。平台只记录「入组 / 已移出」与（若做过结构化纳排筛选）筛选漏斗；
     * 未记录的环节（初筛人数、排除原因、治疗分组、接受干预人数）一律留空待录入，不做任何推算或均分。
     */
    const loadFromCohort = async () => {
      currentMermaid = ''
      try {
        const res = await api<{ svg: string; mermaid: string; data: any }>(`/api/studies/${studyId}/cohort/consort`)
        const d = res.data || {}
        const enrolled = Math.max(0, Number(d.enrolled_ever) || 0)
        const withdrawn = Math.max(0, Number(d.withdrawn) || 0)
        const analyzed = Number.isFinite(Number(d.analyzed)) ? Number(d.analyzed) : Math.max(0, enrolled - withdrawn)
        const funnel = d.screening_funnel
        const hasFunnel = !!funnel && Number(funnel.assessed_total) > 0
        const title = `${studyTitle} · CONSORT 2010 受试者纳排流向图`

        if (!enrolled && !hasFunnel) {
          flowState = emptyFlow(title)
          dataOrigin = ''
          originNote = '本研究队列暂无入组记录。请按原始纳排记录手动录入，或在上方选择已上传的数据集。'
        } else {
          currentMermaid = res.mermaid || ''
          dataOrigin = '本研究入组队列记录'
          const unrecorded: string[] = []
          const exclusions: ExclRow[] = hasFunnel && Array.isArray(funnel.exclusions) && funnel.exclusions.length
            ? funnel.exclusions.map((x: any) => {
                const row = { reason: String(x.reason || ''), count: Number.isFinite(Number(x.count)) ? Number(x.count) : null }
                return { ...row, src: autoSrc(row, ['reason', 'count']) }
              })
            : [emptyExcl()]
          if (!hasFunnel) unrecorded.push('初筛人数与排除原因')
          let arms: ArmRow[]
          if (enrolled) {
            const arm = { name: '全部入组受试者 (Enrolled)', allocated: enrolled, received: null, lost_to_followup: withdrawn, discontinued: 0, analyzed }
            arms = [{ ...arm, src: autoSrc(arm, ['name', 'allocated', 'lost_to_followup', 'analyzed']) }]
            unrecorded.push('治疗分组', '实际接受干预人数')
          } else {
            arms = [emptyArm()]
          }
          const top = {
            total_assessed: hasFunnel ? Number(funnel.assessed_total) : null,
            eligible_total: enrolled || null,
          }
          flowState = { title, ...top, exclusions, arms, src: autoSrc(top, ['total_assessed', 'eligible_total']) }
          originNote = `已带出：入组 ${enrolled} 人、已移出 ${withdrawn} 人（按失访计）${hasFunnel ? `、初筛 ${funnel.assessed_total} 人` : ''}。平台未记录${unrecorded.join('、')}，请按原始记录补充。`
        }
      } catch (err) {
        flowState = emptyFlow(`${studyTitle} · CONSORT 2010 受试者纳排流向图`)
        dataOrigin = ''
        originNote = `读取入组记录失败（${(err as Error).message}），请手动录入。`
      }
      renderTables()
      await renderFlowSvg()
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
      const top = { total_assessed: totalAssessed, eligible_total: totalAssessed - missingGroupCount }
      const exRow = { reason: `${gCol} 缺失或未满足纳排分配标准`, count: missingGroupCount }
      flowState = {
        title: `${dsName} · CONSORT 2010 队列纳排与分组随访流向图`,
        ...top,
        src: autoSrc(top, ['total_assessed', 'eligible_total']),
        exclusions: missingGroupCount > 0 ? [{ ...exRow, src: autoSrc(exRow, ['reason', 'count']) }] : [emptyExcl()],
        arms: [...armStats.entries()].slice(0, 4).map(([name, st]) => {
          const arm = {
            name: `${dsLabels[gCol] || gCol}: ${name}`,
            allocated: st.allocated,
            received: st.allocated,
            lost_to_followup: st.lost,
            discontinued: 0,
            analyzed: st.analyzed,
          }
          return { ...arm, src: autoSrc(arm, ['name', 'allocated', 'received', 'lost_to_followup', 'analyzed']) }
        }),
      }
      if (!flowState.arms.length) flowState.arms = [emptyArm()]
      dataOrigin = `数据集「${dsName}」`
      originNote = `总行数计为初筛人数，「${dsLabels[gCol] || gCol}」缺失计为排除，「${dsLabels[oCol] || oCol}」缺失计为失访；接受人数按分配人数计。如与实际不符请直接修改。`
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
        if (dsRows.length >= 5000) notice('该数据集超过 5000 行：流向图人数只按前 5000 行汇总，请核对后手动修正。', true)
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
      flowState.exclusions.push(emptyExcl())
      renderTables()
      void renderFlowSvg()
    }
    document.getElementById('rsConsortAddArmBtn')!.onclick = () => {
      syncFromDom()
      flowState.arms.push(emptyArm())
      renderTables()
      void renderFlowSvg()
    }
    document.getElementById('rsConsortRenderBtn')!.onclick = () => {
      syncFromDom()
      void renderFlowSvg()
    }

    document.getElementById('rsConsortArchiveBtn')!.onclick = () => {
      if (!ensureComplete() || !currentSvg) return
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
      if (!ensureComplete()) return
      void downloadFigureFormat(studyId, buildPayload(), 'drawio', `Figure1_CONSORT_2010_${studyId}.drawio`)
    }
    document.getElementById('rsConsortDownloadVdx')!.onclick = () => {
      if (!ensureComplete()) return
      void downloadFigureFormat(studyId, buildPayload(), 'vdx', `Figure1_CONSORT_2010_${studyId}.vdx`)
    }
    document.getElementById('rsConsortDownloadPptx')!.onclick = () => {
      if (!ensureComplete()) return
      void downloadFigureFormat(studyId, buildPayload(), 'pptx', `Figure1_CONSORT_2010_${studyId}.pptx`)
    }
    document.getElementById('rsConsortDownloadSvg')!.onclick = () => {
      if (!currentSvg) { notice('暂无可下载的 SVG 图像', true); return }
      downloadBlobContent(currentSvg, `Figure1_CONSORT_2010_${studyId}.svg`, 'image/svg+xml;charset=utf-8')
    }
    document.getElementById('rsConsortCopyMermaid')!.onclick = () => {
      if (!ensureComplete()) return
      const mmd = currentMermaid || `flowchart TD\n  A["初筛评估 (n=${flowState.total_assessed})"] --> B["符合纳排入组 (n=${flowState.eligible_total})"]`
      navigator.clipboard.writeText(mmd).then(() => notice('已复制 CONSORT Mermaid 流程图代码')).catch(() => notice('复制失败', true))
    }

    await loadFromCohort()
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
          ${canEdit ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--raised);padding:8px 10px;border:1px solid var(--line);border-radius:6px;">
            <b class="small">自定义研究变量：</b>
            <input id="rsCustomVarId" placeholder="变量代号 (如 kras_mut)" style="width:140px;">
            <input id="rsCustomVarLabel" placeholder="显示名称 (如 KRAS突变状态)" style="width:160px;">
            <select id="rsCustomVarType" style="width:110px;">
              <option value="categorical">分类变量</option>
              <option value="continuous">连续变量</option>
              <option value="binary">二分类(0/1)</option>
              <option value="date">日期</option>
            </select>
            <input id="rsCustomVarUnit" placeholder="单位 (可选)" style="width:90px;">
            <button type="button" class="small-btn" id="rsCustomVarAdd">＋ 添加到本研究</button>
          </div>` : ''}
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
          if (t.id === 'rsCustomVarAdd') {
            const id = ($('rsCustomVarId') as HTMLInputElement).value.trim().replace(/[^a-zA-Z0-9_]/g, '_')
            const label = ($('rsCustomVarLabel') as HTMLInputElement).value.trim()
            const type = ($('rsCustomVarType') as HTMLSelectElement).value
            const unit = ($('rsCustomVarUnit') as HTMLInputElement).value.trim() || undefined
            if (!id || !label) { notice('请填写变量代号（英文/下划线）与显示名称', true); return }
            const stInfo = await api<any>(`/api/studies/${studyId}`)
            const existing = Array.isArray(stInfo?.custom_vars) ? [...stInfo.custom_vars] : []
            if (existing.some((x: any) => x.id === id)) { notice(`变量 ${id} 已存在`, true); return }
            existing.push({ id, label, type, unit })
            await api(`/api/studies/${studyId}`, { method: 'PATCH', body: JSON.stringify({ custom_vars: existing }) })
            notice(`已新增研究变量「${label} (${id})」`)
            await render()
            return
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
        <section class="rs-card wide" style="padding:10px 14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
            <span class="muted small">当前在组受试者 <b>${activeCount}</b> 人 · 就绪数据集 <b>${readyDs.length}</b> / ${s.datasets.length} 个</span>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
              <button type="button" class="small-btn" data-act="ecrf">${icon('write', { size: 12 })} Auto-eCRF 提取</button>
              <button type="button" class="small-btn" data-act="vars">${icon('check', { size: 12 })} 变量核实</button>
              <button type="button" class="small-btn" data-act="consort">${icon('ruler', { size: 12 })} CONSORT 流向图</button>
              ${canEdit ? `<button type="button" class="small-btn" data-act="gen">生成队列宽表</button><button type="button" class="small-btn primary" data-act="upload">＋ 上传数据集</button>` : ''}
            </div>
          </div>
        </section>

        <section class="rs-card wide">
          <div class="rs-card-head" style="flex-wrap:wrap;gap:8px;">
            <h3>基线特征三线表 (Table 1)</h3>
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
                <button type="button" class="small-btn primary" id="rsT1RunBtn">${icon('chart', { size: 13 })} 在线生成 Table 1</button>
                <button type="button" class="small-btn" id="rsT1DocxBtn">${icon('download', { size: 13 })} 导出 Word (.docx)</button>
              </div>
            </div>
            <div id="rsT1PreviewWrap" style="margin-top:8px;">
              <div class="muted small" style="padding:16px;text-align:center;">正在载入数据集字段并计算基线特征三线表…</div>
            </div>
          ` : `
            <p class="muted small">当前研究还没有就绪的数据集。请先点击右上角「生成队列宽表」、「Auto-eCRF 提取」或「＋ 上传数据集」。</p>
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
      initialMode?: 'clinical_cohort' | 'wet_lab' | 'bioinformatics' | 'mechanism' | 'image_processing' | 'journal_assembly'
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
    // 未启用入组（cohort 为 null）时人数未知，显示「—」，不兜底
    const activeCount: number | null = cohort ? cohort.subjects.filter(x => x.status === 'active').length : null

    type StudioMode = 'clinical_cohort' | 'wet_lab' | 'bioinformatics' | 'mechanism' | 'image_processing' | 'journal_assembly'
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
    // 随访截止日由用户填写（未发生事件者删失于此日）；不预填日期
    let clinSurvCensor = ''
    let clinSurvEvent = '治疗后出血'
    let clinSurvGroup = '第一次治疗方式'
    let clinSurvUnit: 'Months' | 'Years' | 'Days' = 'Months'

    // 统一数据源在「实验统计」、「生信组学」、「流程图」中的列映射状态
    let wetDsGrpCol = ''
    let wetDsValCol = ''
    let bioGroupCol = ''
    let asmPickedIds: string[] | null = null

    let wetPlotType: 'bar_scatter' | 'violin_box' | 'dose_response' = 'bar_scatter'
    let wetErrorType: 'SD' | 'SEM' = 'SD'
    let wetYLabel = 'Relative Expression / Biomarker Level'
    // 实验数值只来自用户录入或数据集：初始只给空的分组与浓度梯度，不预填示例数值
    let wetGroups = [
      { name: 'Control', values: '', color: '#3C5488' },
      { name: 'Treatment', values: '', color: '#E64B35' },
    ]
    let doseRows = [-9, -8, -7, -6, -5, -4].map(logConc => ({ logConc, values: '' }))

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
        title: 'GPCR-cAMP-PKA-CREB 信号转导机制（示意）',
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
        title: 'PD-1/PD-L1 免疫检查点阻断与 T 细胞杀伤机制（示意）',
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

    let asmTitle = `${contextTitle} · Multi-Panel Composite Figure`
    let asmPreset: 'nature_double' | 'nature_single' | 'nejm' | 'lancet' = 'nature_double'
    let asmCols = 2

    let lastSvg = ''
    let lastCode = ''
    /** 最近一次渲染实际使用的数据集（用于归档溯源）；未用数据集时为空 */
    let lastDatasetId = ''
    /** 最近一次渲染是否落到示例数据（只能预览，不能导出 / 归档 / 插入） */
    let lastIsDemo = false
    let lastCodePath = 'figure_studio.R'
    let lastTitle = `${contextTitle}_Figure`

    const studyContextBarHtml = !isGlobal ? `
      <div class="rs-scenario-banner compact" style="margin-bottom:8px;padding:6px 10px;">
        <div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          <span class="small">
            ${icon('microscope', { size: 13 })} <b>当前课题：${esc(s.title)}</b>
            <span class="muted">（在组 ${activeCount ?? '—'} 人 · 数据集 ${readyDs.length} 个 · 归档至本研究 <code>figures/</code>）</span>
          </span>
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

    const demoBlocked = () => {
      if (lastIsDemo) notice('当前是示例数据预览，不能导出、归档或插入文稿。请选择数据集或录入真实数据。', true)
      return lastIsDemo
    }
    document.getElementById('rsStudioCopyPngBtn')!.onclick = () => {
      if (demoBlocked()) return
      const targetSid = s?.id || selectedArchiveStudyId || undefined
      void copySvgAsPngToClipboard(targetSid, lastSvg, lastTitle)
    }
    document.getElementById('rsStudioDownloadPngBtn')!.onclick = () => {
      if (demoBlocked()) return
      const targetSid = s?.id || selectedArchiveStudyId || undefined
      void downloadSvgAsPng600Dpi(targetSid, lastSvg, `${lastTitle}_600DPI.png`)
    }
    document.getElementById('rsStudioArchiveBtn')!.onclick = () => {
      if (demoBlocked()) return
      const targetSid = s?.id || selectedArchiveStudyId || undefined
      void archiveStudyFigure(targetSid, lastTitle, lastSvg, lastCode, lastCodePath, lastDatasetId || undefined)
    }
    document.getElementById('rsStudioInsertDocBtn')!.onclick = async () => {
      if (demoBlocked()) return
      const targetSid = s?.id || selectedArchiveStudyId || undefined
      const archived = await archiveStudyFigure(targetSid, lastTitle, lastSvg, lastCode, lastCodePath, lastDatasetId || undefined)
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

    /** 从当前统一数据集自动计算「生信/多变量组学 (bioinformatics)」差异火山图与聚类热图矩阵 */
    /** 返回字段名与后端 BioinformaticsFigureSpec 一致（volcano_genes / heatmap_matrix），否则后端会忽略 */
    const computeDatasetBioData = (): {
      volcano_genes?: Array<{ gene: string; log2FC: number; pValue: number }>
      heatmap_matrix?: { row_names: string[]; col_names: string[]; col_groups: string[]; values: number[][] }
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
        if (vData.length >= 3) return { volcano_genes: vData }
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

      // Welch t 检验的双侧 P 值：t 分布 CDF 经正则化不完全 Beta 函数计算（Numerical Recipes 连分式）
      const logGamma = (z: number): number => {
        const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
        let x = z, y = z
        let tmp = x + 5.5
        tmp -= (x + 0.5) * Math.log(tmp)
        let ser = 1.000000000190015
        for (const ci of c) ser += ci / ++y
        return -tmp + Math.log((2.5066282746310005 * ser) / x)
      }
      const betacf = (a: number, b: number, x: number): number => {
        const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300
        const qab = a + b, qap = a + 1, qam = a - 1
        let c = 1, d = 1 - (qab * x) / qap
        if (Math.abs(d) < FPMIN) d = FPMIN
        d = 1 / d
        let h = d
        for (let m = 1; m <= MAXIT; m++) {
          const m2 = 2 * m
          let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
          d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN
          c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN
          d = 1 / d; h *= d * c
          aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
          d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN
          c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN
          d = 1 / d
          const del = d * c
          h *= del
          if (Math.abs(del - 1) < EPS) break
        }
        return h
      }
      const incBeta = (a: number, b: number, x: number): number => {
        if (x <= 0) return 0
        if (x >= 1) return 1
        const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
        return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b
      }
      /** 双侧 P = I_{df/(df+t²)}(df/2, 1/2) */
      const tTwoSidedP = (t: number, df: number): number => incBeta(df / 2, 0.5, df / (df + t * t))

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
        const q1 = v1 / vals1.length
        const q2 = v2 / vals2.length
        const se = Math.sqrt(q1 + q2)
        if (se <= 1e-9) return
        const tStat = (m2 - m1) / se
        // Welch–Satterthwaite 自由度
        const df = (q1 + q2) ** 2 / ((q1 * q1) / (vals1.length - 1) + (q2 * q2) / (vals2.length - 1))
        // 下限仅为避免 -log10(0) 无穷大，不截断上限
        const pVal = Math.max(1e-300, tTwoSidedP(tStat, df))
        const minAll = Math.min(...allVals)
        const shift = minAll <= 0 ? Math.abs(minAll) + 0.5 : 0.05
        const log2FC = Number(Math.log2((m2 + shift) / (m1 + shift)).toFixed(3))
        volcanoData.push({
          gene: clinLabels[colName] || colName,
          log2FC,
          pValue: Number(pVal.toPrecision(4)),
        })
        const allMean = allVals.reduce((a, b) => a + b, 0) / allVals.length
        const allSd = Math.sqrt(allVals.reduce((a, b) => a + (b - allMean) ** 2, 0) / Math.max(1, allVals.length - 1)) || 1
        numericCols.push({ idx: cIdx, name: clinLabels[colName] || colName, mean: allMean, sd: allSd })
      })

      let heatmapData: { row_names: string[]; col_names: string[]; col_groups: string[]; values: number[][] } | undefined
      if (numericCols.length >= 3) {
        const pickedCols = numericCols.slice(0, 10)
        const g1Rows = clinPreviewRows.filter(r => (r[gIdx] || '').trim() === g1).slice(0, 4)
        const g2Rows = clinPreviewRows.filter(r => (r[gIdx] || '').trim() === g2).slice(0, 4)
        const sampleRows = [...g1Rows.map((r, i) => ({ row: r, name: `${g1}_#${i + 1}`, group: g1 })), ...g2Rows.map((r, i) => ({ row: r, name: `${g2}_#${i + 1}`, group: g2 }))]
        if (sampleRows.length >= 4) {
          heatmapData = {
            row_names: pickedCols.map(c => c.name),
            col_names: sampleRows.map(s => s.name),
            col_groups: sampleRows.map(s => s.group),
            // 行 = 指标，列 = 样本；值为 Z-score（显示截断 ±2.5，缺失记为 0 = 均值）
            values: pickedCols.map(c =>
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
        volcano_genes: volcanoData.length >= 3 ? volcanoData : undefined,
        heatmap_matrix: heatmapData,
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

      // 同步自动匹配实验统计 (wet_lab)、生信组学 (bioinformatics) 的列
      wetDsGrpCol = pick(/arm|treat|group|sex|第一次治疗|治疗方式|分组|性别|闭塞/i, cols[0]!)
      wetDsValCol = cols.find(c => c !== wetDsGrpCol && /smi|age|vat|value|score|bmi|egfr|中心剂量|周围剂量|剂量|年龄|mRS|体积|直径/i.test(c)) || cols[1] || cols[0]!
      bioGroupCol = pick(/治疗后出血|第一次治疗|首治|闭塞|分组|arm|treat|group|outcome/i, cols[0]!)

      applyDatasetToWetLab()
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
        // 前端汇总（实验统计 / 组学）只读取前 5000 行，超出时必须告知
        if (clinPreviewRows.length >= 5000) notice('该数据集超过 5000 行：实验统计与组学图在前端只汇总了前 5000 行，临床队列图由后端用全量数据计算。', true)
      } catch (err) {
        // 记下已尝试，避免反复重载；把失败原因告诉用户
        clinLoadedDsId = did
        clinPreviewHeader = []
        clinPreviewRows = []
        notice(`读取数据集失败：${(err as Error).message}`, true)
      }
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
                    <input type="text" id="stClinSvCensor" value="${esc(clinSurvCensor)}" placeholder="必填，YYYY-MM-DD">
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
            clinSurvCensor = (document.getElementById('stClinSvCensor') as HTMLInputElement)?.value.trim() ?? clinSurvCensor
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
          ${renderUnifiedDatasetBarHtml('手动输入（在下方表格录入各组数值）')}
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
                <span>各组样本数值（逗号分隔）</span>
                <button type="button" class="quiet small-btn" id="stWetAddGroup">＋ 新增组</button>
              </div>
              <table class="rs-data-table">
                <thead><tr><th style="width:28%;">组名</th><th>样本数值 (逗号分隔)</th><th style="width:44px;">色标</th><th style="width:28px;"></th></tr></thead>
                <tbody id="stWetGroupTbody">
                  ${wetGroups.map((g, idx) => `
                    <tr data-gidx="${idx}">
                      <td><input type="text" class="st-wg-name" value="${esc(g.name)}"></td>
                      <td><input type="text" class="st-wg-vals" value="${esc(g.values)}" placeholder="如：1.02, 0.96, 1.05"></td>
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
                      <td><input type="text" class="st-dr-vals" value="${esc(r.values)}" placeholder="重复孔响应值，逗号分隔"></td>
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
          // 新增组不预填数值，由用户录入后再渲染
          wetGroups.push({ name: `Group ${wetGroups.length + 1}`, values: '', color: palette[wetGroups.length % palette.length]! })
          renderLeftEditor()
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
          // 先去掉空片段，否则 Number('') === 0 会把空白当成一个 0 值样本
          values: g.values.split(/[,，\s]+/).filter(v => v.trim()).map(v => Number(v.trim())).filter(v => Number.isFinite(v)),
        })).filter(g => g.values.length > 0)
        const parsedDose = doseRows.map(d => ({
          logConc: d.logConc,
          responses: d.values.split(/[,，\s]+/).filter(v => v.trim()).map(v => Number(v.trim())).filter(v => Number.isFinite(v)),
        })).filter(d => d.responses.length > 0)
        const wetEmpty = wetPlotType === 'dose_response' ? parsedDose.length < 4 : parsedGroups.length < 1
        if (wetEmpty) {
          lastSvg = ''
          lastIsDemo = false
          canvasEl.innerHTML = `<div class="muted small" style="padding:40px;text-align:center;">${wetPlotType === 'dose_response'
            ? '请在左侧至少为 4 个浓度录入重复孔响应值，或选择数据集。'
            : '请在左侧录入各组数值（逗号分隔），或选择数据集。'}</div>`
          exportBar.innerHTML = ''
          return
        }
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
          const text = r.ok ? await r.text() : ''
          // 任一面板取回失败就停止：静默跳过会让面板字母与成果库里的 Panel 编号错位
          if (!text.includes('<svg')) {
            canvasEl.innerHTML = `<div class="muted small" style="padding:30px;">面板「${esc(cb.dataset.figname || cb.value)}」读取失败或不是 SVG 矢量图，已停止拼图。请取消勾选该面板后重试。</div>`
            exportBar.innerHTML = ''
            return
          }
          panels.push({
            label: String.fromCharCode(65 + i),
            title: cb.dataset.figname || `Panel ${String.fromCharCode(65 + i)}`,
            svg: text,
          })
        }
        payload = {
          category: 'journal_assembly',
          manuscriptTitle: asmTitle,
          journalPreset: asmPreset,
          columns: asmCols,
          panels,
        }
        lastTitle = `Journal_Composite_${asmPreset}`
      }

      try {
        const res = await api<any>(endpoint, {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        const svgStr = res.illustrator_svg || res.svg || res.km_svg || res.forest_svg || res.native_exports?.illustrator_svg || ''
        lastSvg = svgStr
        lastIsDemo = !!res.is_demo_data || isDemoSvg(svgStr)
        lastDatasetId = lastIsDemo
          ? ''
          : typeof payload.dataset_id === 'string' && payload.dataset_id
            ? payload.dataset_id
            : currentMode === 'bioinformatics' && (payload.volcano_genes || payload.heatmap_matrix)
              ? activeDatasetId
              : ''
        canvasEl.innerHTML = safeSvg(svgStr) || '<div class="muted small">已生成工程原文件</div>'
        if (lastIsDemo) {
          canvasTitleEl.textContent = `示例数据预览（非真实研究结果）· ${res.demo_reason || '未提供真实数据'}`
          exportBar.innerHTML = `<span class="small" style="color:var(--warn);">示例数据仅供预览：不能导出、归档或插入文稿。请在左侧选择数据集或录入真实数据。</span>`
          lastCode = ''
          codePre.textContent = '# 示例数据不提供可复现脚本'
          return
        }

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
        if (currentMode === 'mechanism' || currentMode === 'journal_assembly') {
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
    initialMode?: 'clinical_cohort' | 'wet_lab' | 'bioinformatics' | 'mechanism' | 'image_processing' | 'journal_assembly'
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
                数据类图表（临床队列、统计、生信、流式、CONSORT）必须基于真实数据：请在制图工作台或研究的「统计与制图」中选择数据集生成并归档，再从「图表成果库」插入，插入的图保留归档时记录的数据集与脚本溯源。就地绘制只提供不含数据的机制示意图模板。
              </div>
            </div>
            <button type="button" class="small-btn" id="rsDocToFullStudioBtn">${icon('target', { size: 12 })} 切换到全屏医学制图工作台 →</button>
          </div>
        </div>

        <div class="row" style="gap:8px;border-bottom:1px solid var(--line);padding-bottom:10px;flex-wrap:wrap;">
          <button type="button" class="small-btn primary" id="rsDocTabDrawBtn">${icon('chart', { size: 13 })} 1. 就地插入机制示意图</button>
          <button type="button" class="small-btn" id="rsDocTabGalleryBtn">${icon('folder', { size: 13 })} 2. 从已归档图表成果库直接插入</button>
        </div>

        <div id="rsDocDrawPane" style="display:flex;flex-direction:column;gap:12px;">
          <div class="muted small" style="border:1px solid var(--line);background:var(--raised);padding:8px 10px;">
            需要数据图？<button type="button" class="small-btn" id="rsDocGoGalleryBtn">${icon('folder', { size: 12 })} 从图表成果库插入</button>
            或 <button type="button" class="small-btn" id="rsDocGoStudioBtn">${icon('target', { size: 12 })} 去制图工作台用数据集生成</button>
          </div>
          <div class="form" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:10px;background:var(--raised);padding:12px;border:1px solid var(--line);">
            <label>机制示意图模板（不含数据）
              <select id="rsDocFigKind">
                <option value="mech_gpcr">GPCR-cAMP-PKA 信号转导示意图</option>
                <option value="mech_pd1">PD-1/PD-L1 免疫检查点阻断机制示意图</option>
              </select>
            </label>
            <label>图注标题 (Figure Caption / Title)
              <input type="text" id="rsDocFigTitle" value="机制示意图">
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

    // 就地绘制只提供机制示意图模板；数据类图表不在这里用写死数值生成
    const buildPayload = (kind: string, title: string): Record<string, unknown> => ({
      category: 'mechanism',
      title,
      subtitle: kind === 'mech_pd1' ? 'PD-1/PD-L1 免疫检查点阻断与效应 T 细胞激活通路（示意）' : 'GPCR-cAMP-PKA-CREB 跨膜信号转导与核内转录调控（示意）',
      showCompartments: true,
    })

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
        statusEl.textContent = '已就绪 · 点击右侧「生成并插入到当前文稿位置」即可嵌入正文（机制示意图，不含数据）'
      } catch (err) {
        // 失败时清空，避免随后点击「插入」把上一张图配上新标题插进去
        renderedSvg = ''
        renderedCode = ''
        previewBox.innerHTML = `<div class="muted small">${esc((err as Error).message)}</div>`
        statusEl.textContent = '生成失败'
      } finally {
        insertNowBtn.disabled = !renderedSvg
      }
    }

    kindSel.onchange = () => void renderQuickPreview()
    document.getElementById('rsDocRefreshBtn')!.onclick = () => void renderQuickPreview()
    document.getElementById('rsDocGoStudioBtn')!.onclick = () => {
      close()
      hooks.goSpace('studio')
    }

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
          grid.innerHTML = `<div class="muted small" style="padding:18px;">当前成果库暂无已归档图表。请先在制图工作台或研究的「统计与制图」中用数据集生成并归档。</div>`
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
    document.getElementById('rsDocGoGalleryBtn')!.onclick = () => tabGalBtn.click()

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

    // 系数与 SMD 只来自数据集拟合或用户手动录入；不预填任何示例数值
    type NomoPred = { variable: string; label: string; type: 'binary' | 'continuous'; beta: number; min_val: number; max_val: number }
    type LoveCov = { name: string; smd_unadjusted: number; smd_adjusted: number }
    let nomoPredictors: NomoPred[] = []
    let loveCovariates: LoveCov[] = []

    /** 读取数据集列名与中文标签；数据集没有列时报错，不编造列名 */
    const loadDatasetCols = async (did: string) => {
      const ds = await api<{ columns?: Array<{ name: string }>; labels?: Record<string, string> }>(`/api/datasets/${did}`)
      const cols = (ds.columns || []).map(c => c.name)
      if (!cols.length) throw new Error('该数据集没有可用的列')
      return { cols, labels: ds.labels || {} }
    }
    const colOptionsHtml = (cols: string[], labels: Record<string, string>) =>
      cols.map(c => `<option value="${esc(c)}">${esc(labels[c] || c)} (${esc(c)})</option>`).join('')
    /** 协变量多选框（复选框列表） */
    const colPickerHtml = (id: string, title: string) => `
      <div class="small">${title}
        <div id="${id}" style="max-height:120px;overflow:auto;border:1px solid var(--line);border-radius:4px;padding:4px 6px;margin-top:2px;display:flex;flex-wrap:wrap;gap:2px 10px;">
          <span class="muted">正在读取数据集列…</span>
        </div>
      </div>`
    const fillColPicker = (id: string, cols: string[], labels: Record<string, string>, emptyMsg = '数据集没有可用列') => {
      const el = document.getElementById(id)
      if (!el) return
      el.innerHTML = cols.length
        ? cols.map(c => `<label style="display:inline-flex;align-items:center;gap:3px;font-weight:400;"><input type="checkbox" value="${esc(c)}"> ${esc(labels[c] || c)}</label>`).join('')
        : `<span class="muted">${esc(emptyMsg)}</span>`
    }
    const readColPicker = (id: string): string[] =>
      Array.from(document.querySelectorAll<HTMLInputElement>(`#${id} input[type=checkbox]:checked`)).map(i => i.value)

    pane.innerHTML = `
      <div class="rs-studio-topbar">
        <div class="rs-studio-modes" role="tablist" aria-label="统计与因果模型分类">
          <button type="button" class="rs-studio-mode-btn active" data-bs-eng="survival">
            ${icon('compare', { size: 14 })} <span>KM 生存分析 &amp; Cox 森林图</span>
          </button>
          <button type="button" class="rs-studio-mode-btn" data-bs-eng="nomogram">
            ${icon('caliper', { size: 14 })} <span>Cox 预后列线图</span>
          </button>
          <button type="button" class="rs-studio-mode-btn" data-bs-eng="rocdca">
            ${icon('target', { size: 14 })} <span>ROC &amp; DCA 决策曲线</span>
          </button>
          <button type="button" class="rs-studio-mode-btn" data-bs-eng="causal">
            ${icon('shield', { size: 14 })} <span>因果推断 &amp; 倾向性评分</span>
          </button>
        </div>
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
          leftEl.innerHTML = `<div class="muted small">请先在「概览」或「数据与 Table 1」中生成或上传研究数据集。</div>`
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
          <label>随访截止日（仅当随访列是日期时需要；未发生事件者删失于此日）
            <input type="text" id="bsSurvCensor" placeholder="YYYY-MM-DD">
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
            .catch(err => { rightEl.innerHTML = `<div class="muted small">读取数据集失败：${esc((err as Error).message)}</div>`; return null })
          if (!ds) return
          const cols = (ds.columns || []).map(c => c.name)
          if (!cols.length) {
            rightEl.innerHTML = `<div class="muted small">该数据集没有可用的列，无法进行生存分析。</div>`
            return
          }
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
            const dateMode = isDateStart && !!evDateCol
            const censorDate = (document.getElementById('bsSurvCensor') as HTMLInputElement).value.trim()
            const res = await api<any>(`/api/datasets/${dsSel.value}/survival`, {
              method: 'POST',
              body: JSON.stringify({
                time_col: dateMode ? undefined : tSel.value,
                start_date_col: dateMode ? tSel.value : undefined,
                event_date_col: dateMode ? evDateCol : undefined,
                default_censor_date: dateMode && censorDate ? censorDate : undefined,
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
            // 自动切换到「按日期计算随访」时必须让用户看到用了哪两列、删失怎么处理
            const dateNote = dateMode
              ? `<div class="small" style="color:var(--warn);margin-bottom:6px;">随访时长按日期计算：起点「${esc(tSel.value)}」→ 事件日期「${esc(evDateCol!)}」；未发生事件者删失于随访截止日 ${esc(censorDate)}。如列选择不对，请改选数值型随访时长列。</div>`
              : ''
            rightEl.innerHTML = `
              ${dateNote}
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
            document.getElementById('bsArchKm')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Figure3_Kaplan_Meier', kmSvg, ne.r_script, undefined, dsSel.value))
            document.getElementById('bsDlKmPng')?.addEventListener('click', () => kmSvg && void downloadSvgAsPng600Dpi(s.id, kmSvg, 'Figure3_Kaplan_Meier_600DPI.png'))
            document.getElementById('bsCpKmPng')?.addEventListener('click', () => kmSvg && void copySvgAsPngToClipboard(s.id, kmSvg, 'Figure3_Kaplan_Meier'))
            document.getElementById('bsDlKmPzfx')?.addEventListener('click', () => ne.prism_pzfx && downloadBlobContent(ne.prism_pzfx, 'Kaplan_Meier.pzfx', 'application/xml;charset=utf-8'))
            document.getElementById('bsDlKmR')?.addEventListener('click', () => ne.r_script && downloadBlobContent(ne.r_script, 'Kaplan_Meier.R'))
            document.getElementById('bsDlKmSvg')?.addEventListener('click', () => kmSvg && downloadBlobContent(kmSvg, 'Kaplan_Meier.svg', 'image/svg+xml;charset=utf-8'))
            document.getElementById('bsArchForest')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Figure4_Cox_Forest_Plot', forestSvg, ne.forest_r_script, undefined, dsSel.value))
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
        const nomoRowHtml = (p?: NomoPred) => `
          <tr>
            <td><input type="text" class="bs-nm-lbl" value="${esc(p?.label ?? '')}" placeholder="变量名"></td>
            <td><input type="number" step="0.001" class="bs-nm-beta" value="${p ? p.beta : ''}" placeholder="β"></td>
            <td><input type="number" step="0.1" class="bs-nm-min" value="${p ? p.min_val : ''}" placeholder="—"></td>
            <td><input type="number" step="0.1" class="bs-nm-max" value="${p ? p.max_val : ''}" placeholder="—"></td>
          </tr>`
        const nomoRowsHtml = () => (nomoPredictors.length ? nomoPredictors.map(p => nomoRowHtml(p)) : [nomoRowHtml(), nomoRowHtml(), nomoRowHtml()]).join('')
        leftEl.innerHTML = `
          <div class="rs-sub-box-title"><span>${icon('caliper', { size: 13 })} 预后列线图 (Nomogram)</span></div>
          ${readyDs.length ? `
            <div style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--panel);display:flex;flex-direction:column;gap:6px;">
              <b class="small">从数据集拟合（二分类 Logistic 回归）</b>
              <label class="small">选择研究数据集
                <select id="bsNomoDs">${readyDs.map(d => `<option value="${esc(d.dataset_id)}">${esc(d.name)}</option>`).join('')}</select>
              </label>
              <label class="small">二分类结局列（必选）
                <select id="bsNomoOutcome"><option value="">请选择</option></select>
              </label>
              ${colPickerHtml('bsNomoCovs', '预测变量列（至少选 1 个）')}
              <label class="small">随访时间列（可选，仅用于计算 Harrell C-index）
                <select id="bsNomoTime"><option value="">不使用</option></select>
              </label>
              <button type="button" class="small-btn primary" id="bsNomoAutoFitBtn">${icon('chart', { size: 13 })} 从数据集拟合回归系数与 C-index</button>
              <div class="muted small">数据集拟合的是二分类 Logistic 模型，不使用随访时间建模，因此列线图只给出总分标尺，不给出 1/3/5 年生存概率。</div>
            </div>
          ` : ''}
          <div class="rs-sub-box-title" style="margin-top:6px;"><span>或：手动输入外部模型的系数</span></div>
          <div class="muted small">适用于已发表或在外部软件中拟合的模型：填入各预测因子的回归系数 β（ln HR / ln OR）与取值范围。</div>
          <label class="small">原模型类型（必选）
            <select id="bsNomoModelType">
              <option value="">请选择</option>
              <option value="cox">Cox 比例风险模型（β = ln HR）</option>
              <option value="logistic">Logistic 回归（β = ln OR）</option>
            </select>
          </label>
          <table class="rs-data-table">
            <thead><tr><th>变量标签</th><th style="width:62px;">β 系数</th><th style="width:54px;">Min</th><th style="width:54px;">Max</th></tr></thead>
            <tbody id="bsNomoTbody">${nomoRowsHtml()}</tbody>
          </table>
          <button type="button" class="quiet small-btn" id="bsNomoAddRow">＋ 新增预测因子</button>
          <div class="small">基线生存率 S0(t)（可选；须来自同一 Cox 模型，留空则不输出该时间点的生存概率）</div>
          <div class="row" style="gap:6px;">
            <label class="small" style="flex:1;">1 年<input type="number" step="0.01" min="0" max="1" id="bsNomoS1" placeholder="—"></label>
            <label class="small" style="flex:1;">3 年<input type="number" step="0.01" min="0" max="1" id="bsNomoS3" placeholder="—"></label>
            <label class="small" style="flex:1;">5 年<input type="number" step="0.01" min="0" max="1" id="bsNomoS5" placeholder="—"></label>
          </div>
          <button type="button" class="primary small-btn" id="bsNomoRunBtn">${icon('chart', { size: 13 })} 按手动参数绘制列线图</button>
        `
        rightEl.innerHTML = `<div class="muted small" style="padding:30px;text-align:center;">${readyDs.length
          ? '选择结局列和预测变量后点击「从数据集拟合」，或在左侧手动输入外部模型的系数。'
          : '请先上传研究数据集；手动绘制列线图也需要挂载在一个研究数据集下。'}</div>`

        /** fromDid：从数据集拟合时传入，用于归档溯源；手动系数时为空 */
        const renderNomoRight = (res: any, fromDid?: string) => {
          const svg = res.native_exports?.illustrator_svg || res.svg || ''
          const rScript = res.native_exports?.r_script || ''
          const cIdxBadge = typeof res.c_index === 'number'
            ? `<span class="flag-S small" style="background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:4px;font-weight:600;">C-index = ${res.c_index.toFixed(3)}${Array.isArray(res.c_index_ci) ? ` (95% CI: ${res.c_index_ci[0].toFixed(3)}–${res.c_index_ci[1].toFixed(3)})` : ''}</span>`
            : ''
          const nBadge = typeof res.sample_size === 'number'
            ? `<span class="muted small">n = ${res.sample_size}，事件 ${res.events_n ?? '—'}</span>`
            : ''
          const figTitle = res.absolute_survival ? '预后列线图（含生存概率）' : '预后列线图（总分标尺，无绝对生存概率）'
          rightEl.innerHTML = `
            <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <b>Figure 5 · ${figTitle}</b>
                ${cIdxBadge}
                ${nBadge}
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button type="button" class="small-btn primary" id="bsArchNomo">${icon('pin', { size: 13 })} 归档列线图至 figures/</button>
                <button type="button" class="small-btn" id="bsDlNomoR">${icon('download', { size: 13 })} R rms 脚本 (.R)</button>
                <button type="button" class="small-btn" id="bsDlNomoSvg">${icon('download', { size: 13 })} Illustrator (.svg)</button>
              </div>
            </div>
            <div class="rs-studio-canvas">${safeSvg(svg)}</div>
          `
          document.getElementById('bsArchNomo')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Figure5_Prognostic_Nomogram', svg, rScript, undefined, fromDid))
          document.getElementById('bsDlNomoR')?.addEventListener('click', () => rScript && downloadBlobContent(rScript, 'Nomogram_rms.R'))
          document.getElementById('bsDlNomoSvg')?.addEventListener('click', () => svg && downloadBlobContent(svg, 'Figure5_Nomogram.svg', 'image/svg+xml;charset=utf-8'))
        }

        const dsNomoSel = document.getElementById('bsNomoDs') as HTMLSelectElement | null
        const outNomoSel = document.getElementById('bsNomoOutcome') as HTMLSelectElement | null
        const timeNomoSel = document.getElementById('bsNomoTime') as HTMLSelectElement | null
        let nomoLabels: Record<string, string> = {}
        if (dsNomoSel && outNomoSel && timeNomoSel) {
          const loadNomoCols = async () => {
            try {
              const { cols, labels } = await loadDatasetCols(dsNomoSel.value)
              nomoLabels = labels
              outNomoSel.innerHTML = `<option value="">请选择</option>` + colOptionsHtml(cols, labels)
              timeNomoSel.innerHTML = `<option value="">不使用</option>` + colOptionsHtml(cols, labels)
              fillColPicker('bsNomoCovs', cols, labels)
            } catch (err) {
              fillColPicker('bsNomoCovs', [], {}, `读取数据集列失败：${(err as Error).message}`)
            }
          }
          dsNomoSel.onchange = () => void loadNomoCols()
          void loadNomoCols()
        }

        const autoFitNomo = async () => {
          const did = dsNomoSel?.value
          if (!did) return
          const outcome_col = outNomoSel?.value || ''
          const time_col = timeNomoSel?.value || ''
          const covariates = readColPicker('bsNomoCovs').filter(c => c !== outcome_col && c !== time_col)
          if (!outcome_col || !covariates.length) {
            notice('请先选择二分类结局列和至少 1 个预测变量列', true)
            return
          }
          rightEl.innerHTML = `<div class="muted small" style="padding:30px;text-align:center;">正在拟合…</div>`
          try {
            const res = await api<any>(`/api/datasets/${did}/nomogram`, {
              method: 'POST',
              body: JSON.stringify({
                title: `${s.title} · 预后列线图 (Nomogram)`,
                outcome_col,
                covariates,
                time_col: time_col || undefined,
                labels: nomoLabels,
              }),
            })
            if (Array.isArray(res.axes) && res.axes.length) {
              nomoPredictors = res.axes.map((a: any) => ({
                variable: a.variable,
                label: a.label,
                type: a.type === 'binary' ? 'binary' : 'continuous',
                beta: Number(Number(a.beta).toFixed(3)),
                min_val: a.min_val,
                max_val: a.max_val,
              }))
              const tbody = document.getElementById('bsNomoTbody')
              if (tbody) tbody.innerHTML = nomoRowsHtml()
              for (const id of ['bsNomoS1', 'bsNomoS3', 'bsNomoS5']) (document.getElementById(id) as HTMLInputElement).value = ''
            }
            renderNomoRight(res, did)
          } catch (err) {
            rightEl.innerHTML = `<div class="muted small" style="padding:20px;">拟合失败：${esc((err as Error).message)}</div>`
          }
        }

        const runNomo = async () => {
          const did = dsNomoSel?.value || readyDs[0]?.dataset_id
          if (!did) {
            rightEl.innerHTML = `<div class="muted small">请先生成或上传至少 1 个研究数据集。</div>`
            return
          }
          const rows = Array.from(leftEl.querySelectorAll<HTMLTableRowElement>('#bsNomoTbody tr'))
          const parsed: NomoPred[] = []
          const bad: string[] = []
          rows.forEach((tr, i) => {
            const label = tr.querySelector<HTMLInputElement>('.bs-nm-lbl')?.value.trim() || ''
            const raw = ['.bs-nm-beta', '.bs-nm-min', '.bs-nm-max'].map(sel => tr.querySelector<HTMLInputElement>(sel)?.value.trim() || '')
            if (!label && raw.every(v => !v)) return
            const [beta, min_val, max_val] = raw.map(v => (v === '' ? NaN : Number(v)))
            if (!label || !Number.isFinite(beta) || !Number.isFinite(min_val) || !Number.isFinite(max_val) || max_val! <= min_val!) {
              bad.push(`第 ${i + 1} 行`)
              return
            }
            parsed.push({
              variable: nomoPredictors[i]?.variable || label,
              label,
              type: min_val === 0 && max_val === 1 ? 'binary' : 'continuous',
              beta: beta!,
              min_val: min_val!,
              max_val: max_val!,
            })
          })
          if (bad.length) { notice(`${bad.join('、')}未填完整：需要变量名、β、Min、Max，且 Max 大于 Min`, true); return }
          const model_type = (document.getElementById('bsNomoModelType') as HTMLSelectElement).value
          if (model_type !== 'cox' && model_type !== 'logistic') { notice('请选择原模型类型（Cox 或 Logistic）', true); return }
          if (!parsed.length) { notice('请至少填写 1 个预测因子', true); return }
          const baseline_survival: Record<string, number> = {}
          for (const [id, key] of [['bsNomoS1', 'year1'], ['bsNomoS3', 'year3'], ['bsNomoS5', 'year5']] as const) {
            const v = (document.getElementById(id) as HTMLInputElement).value.trim()
            if (!v) continue
            const n = Number(v)
            if (!(n > 0 && n < 1)) { notice('基线生存率须在 0 到 1 之间（不含端点）', true); return }
            baseline_survival[key] = n
          }
          if (model_type === 'logistic' && Object.keys(baseline_survival).length) {
            notice('Logistic 模型没有基线生存率，请清空 1/3/5 年 S0，或把模型类型改为 Cox', true)
            return
          }
          nomoPredictors = parsed
          try {
            const res = await api<any>(`/api/datasets/${did}/nomogram`, {
              method: 'POST',
              body: JSON.stringify({
                title: `${s.title} · 预后列线图 (Nomogram)`,
                predictors: parsed,
                baseline_survival,
                model_type,
              }),
            })
            renderNomoRight(res)
          } catch (err) {
            rightEl.innerHTML = `<div class="muted small" style="padding:20px;">${esc((err as Error).message)}</div>`
          }
        }
        document.getElementById('bsNomoAutoFitBtn')?.addEventListener('click', () => void autoFitNomo())
        document.getElementById('bsNomoRunBtn')!.onclick = () => void runNomo()
        document.getElementById('bsNomoAddRow')!.onclick = () => {
          document.getElementById('bsNomoTbody')?.insertAdjacentHTML('beforeend', nomoRowHtml())
        }
        return
      }

      if (engine === 'rocdca') {
        leftEl.innerHTML = `
          <div class="rs-sub-box-title"><span>${icon('target', { size: 13 })} ROC 诊断对比 (DeLong 检验) 与 DCA 决策曲线</span></div>
          ${readyDs.length ? `
            <div style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--panel);display:flex;flex-direction:column;gap:6px;">
              <b class="small">从数据集拟合两个 Logistic 模型并比较</b>
              <label class="small">选择研究数据集
                <select id="bsRocDs">${readyDs.map(d => `<option value="${esc(d.dataset_id)}">${esc(d.name)}</option>`).join('')}</select>
              </label>
              <label class="small">二分类结局列（必选）
                <select id="bsRocOutcome"><option value="">请选择</option></select>
              </label>
              ${colPickerHtml('bsRocBase', '模型 1 的预测变量（至少 1 个）')}
              ${colPickerHtml('bsRocExtra', '模型 2 在模型 1 基础上增加的变量（至少 1 个）')}
              <button type="button" class="small-btn primary" id="bsRocAutoFitBtn">${icon('chart', { size: 13 })} 从数据集拟合两个模型的 ROC &amp; DCA</button>
            </div>
          ` : ''}
          <label>模型 1 名称
            <input type="text" id="bsRocM1" placeholder="模型 1">
          </label>
          <label>模型 2 名称
            <input type="text" id="bsRocM2" placeholder="模型 2">
          </label>
          <details style="border:1px solid var(--line);border-radius:6px;padding:6px 8px;">
            <summary class="small">或：手动粘贴外部模型的结局标签与预测概率</summary>
            <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
              <label class="small">真实结局标签（1/0，逗号分隔）
                <textarea id="bsRocLabels" rows="2" placeholder="如：1, 0, 1, 1, 0"></textarea>
              </label>
              <label class="small">模型 1 预测概率（与标签等长）
                <textarea id="bsRocP1" rows="2" placeholder="如：0.72, 0.31, 0.64, 0.58, 0.22"></textarea>
              </label>
              <label class="small">模型 2 预测概率（与标签等长）
                <textarea id="bsRocP2" rows="2" placeholder="如：0.81, 0.25, 0.70, 0.66, 0.18"></textarea>
              </label>
              <button type="button" class="small-btn" id="bsRocRunBtn">${icon('chart', { size: 13 })} 按手动概率数组计算 ROC + DCA</button>
            </div>
          </details>
        `
        rightEl.innerHTML = `<div class="muted small" style="padding:30px;text-align:center;">${readyDs.length
          ? '选择结局列与两个模型的变量后点击「从数据集拟合」，或展开左侧手动粘贴预测概率。'
          : '请先上传研究数据集；手动计算 ROC 也需要挂载在一个研究数据集下。'}</div>`

        const renderRocRight = (res: any, fromDid?: string) => {
          const rocSvg = res.native_exports?.roc_illustrator_svg || res.roc?.svg || ''
          const dcaSvg = res.native_exports?.dca_illustrator_svg || res.dca?.svg || ''
          const pzfx = res.native_exports?.prism_pzfx || ''
          const rScript = res.native_exports?.r_script || ''
          const dl = res.delong
          const dlBadge = dl
            ? `<span class="flag-S small" style="background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:4px;font-weight:600;">DeLong ΔAUC = ${dl.delta_auc >= 0 ? '+' : ''}${dl.delta_auc.toFixed(3)} (Z = ${dl.z_stat.toFixed(2)}, ${dl.p_formatted})</span>`
            : ''
          const win = Array.isArray(res.benefit_window_pct)
            ? ` <span class="muted small">· 模型 2 净获益占优的阈值区间 ${res.benefit_window_pct[0]}%–${res.benefit_window_pct[1]}%</span>`
            : (res.benefit_window_pct === null ? ' <span class="muted small">· 模型 2 在任何阈值下净获益均未超过 Treat All / Treat None</span>' : '')
          rightEl.innerHTML = `
            <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <b>Figure 6A · ROC 诊断效能对比曲线</b>
                ${dlBadge}
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button type="button" class="small-btn primary" id="bsArchRoc">${icon('pin', { size: 13 })} 归档 ROC 至 figures/</button>
                <button type="button" class="small-btn" id="bsDlRocPzfx">${icon('download', { size: 13 })} Prism (.pzfx)</button>
                <button type="button" class="small-btn" id="bsDlRocR">${icon('download', { size: 13 })} R pROC/rmda (.R)</button>
                <button type="button" class="small-btn" id="bsDlRocSvg">${icon('download', { size: 13 })} ROC (.svg)</button>
              </div>
            </div>
            <div class="rs-studio-canvas" style="min-height:300px;">${safeSvg(rocSvg)}</div>
            <div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px;">
              <b>Figure 6B · 临床决策净获益曲线 (DCA)${win}</b>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button type="button" class="small-btn primary" id="bsArchDca">${icon('pin', { size: 13 })} 归档 DCA 至 figures/</button>
                <button type="button" class="small-btn" id="bsDlDcaSvg">${icon('download', { size: 13 })} DCA (.svg)</button>
              </div>
            </div>
            <div class="rs-studio-canvas" style="min-height:300px;">${safeSvg(dcaSvg)}</div>
          `
          document.getElementById('bsArchRoc')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Figure6A_ROC_Curve', rocSvg, rScript, undefined, fromDid))
          document.getElementById('bsArchDca')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Figure6B_DCA_Curve', dcaSvg, rScript, undefined, fromDid))
          document.getElementById('bsDlRocPzfx')?.addEventListener('click', () => pzfx && downloadBlobContent(pzfx, 'ROC_DCA.pzfx', 'application/xml;charset=utf-8'))
          document.getElementById('bsDlRocR')?.addEventListener('click', () => rScript && downloadBlobContent(rScript, 'ROC_DCA.R'))
          document.getElementById('bsDlRocSvg')?.addEventListener('click', () => rocSvg && downloadBlobContent(rocSvg, 'Figure6A_ROC.svg', 'image/svg+xml;charset=utf-8'))
          document.getElementById('bsDlDcaSvg')?.addEventListener('click', () => dcaSvg && downloadBlobContent(dcaSvg, 'Figure6B_DCA.svg', 'image/svg+xml;charset=utf-8'))
        }

        const dsRocSel = document.getElementById('bsRocDs') as HTMLSelectElement | null
        const outRocSel = document.getElementById('bsRocOutcome') as HTMLSelectElement | null
        let rocLabels: Record<string, string> = {}
        if (dsRocSel && outRocSel) {
          const loadRocCols = async () => {
            try {
              const { cols, labels } = await loadDatasetCols(dsRocSel.value)
              rocLabels = labels
              outRocSel.innerHTML = `<option value="">请选择</option>` + colOptionsHtml(cols, labels)
              fillColPicker('bsRocBase', cols, labels)
              fillColPicker('bsRocExtra', cols, labels)
            } catch (err) {
              const msg = `读取数据集列失败：${(err as Error).message}`
              fillColPicker('bsRocBase', [], {}, msg)
              fillColPicker('bsRocExtra', [], {}, msg)
            }
          }
          dsRocSel.onchange = () => void loadRocCols()
          void loadRocCols()
        }

        const modelNames = () => ({
          model1_name: (document.getElementById('bsRocM1') as HTMLInputElement)?.value.trim() || '模型 1',
          model2_name: (document.getElementById('bsRocM2') as HTMLInputElement)?.value.trim() || '模型 2',
        })

        const autoFitRoc = async () => {
          const did = dsRocSel?.value
          if (!did) return
          const outcome_col = outRocSel?.value || ''
          const baseline_covariates = readColPicker('bsRocBase').filter(c => c !== outcome_col)
          const full_covariates = readColPicker('bsRocExtra').filter(c => c !== outcome_col && !baseline_covariates.includes(c))
          if (!outcome_col || !baseline_covariates.length || !full_covariates.length) {
            notice('请选择结局列、模型 1 的变量，以及模型 2 额外增加的变量（与模型 1 不重复）', true)
            return
          }
          rightEl.innerHTML = `<div class="muted small" style="padding:30px;text-align:center;">正在拟合…</div>`
          try {
            const res = await api<any>(`/api/datasets/${did}/roc-dca`, {
              method: 'POST',
              body: JSON.stringify({ outcome_col, baseline_covariates, full_covariates, labels: rocLabels, ...modelNames() }),
            })
            renderRocRight(res, did)
          } catch (err) {
            rightEl.innerHTML = `<div class="muted small" style="padding:20px;">拟合失败：${esc((err as Error).message)}</div>`
          }
        }

        const runRoc = async () => {
          const did = dsRocSel?.value || readyDs[0]?.dataset_id
          if (!did) {
            rightEl.innerHTML = `<div class="muted small">请先生成或上传至少 1 个研究数据集。</div>`
            return
          }
          const parseNums = (id: string) => ((document.getElementById(id) as HTMLTextAreaElement)?.value || '').split(/[,，\s]+/).filter(v => v.trim()).map(v => Number(v.trim()))
          const labels = parseNums('bsRocLabels')
          const scores_baseline = parseNums('bsRocP1')
          const scores_multimodal = parseNums('bsRocP2')
          const allFinite = [labels, scores_baseline, scores_multimodal].every(a => a.length && a.every(Number.isFinite))
          if (!allFinite || scores_baseline.length !== labels.length || scores_multimodal.length !== labels.length) {
            notice('请填写等长的结局标签和两组预测概率（只能是数字）', true)
            return
          }
          try {
            const res = await api<any>(`/api/datasets/${did}/roc-dca`, {
              method: 'POST',
              body: JSON.stringify({ labels, scores_baseline, scores_multimodal, ...modelNames() }),
            })
            renderRocRight(res)
          } catch (err) {
            rightEl.innerHTML = `<div class="muted small" style="padding:20px;">${esc((err as Error).message)}</div>`
          }
        }
        document.getElementById('bsRocAutoFitBtn')?.addEventListener('click', () => void autoFitRoc())
        document.getElementById('bsRocRunBtn')!.onclick = () => void runRoc()
        return
      }

      // engine === 'causal'
      const loveRowHtml = (c?: LoveCov) => `
        <tr>
          <td><input type="text" class="bs-lv-name" value="${esc(c?.name ?? '')}" placeholder="协变量名"></td>
          <td><input type="number" step="0.01" class="bs-lv-un" value="${c ? c.smd_unadjusted : ''}" placeholder="—"></td>
          <td><input type="number" step="0.01" class="bs-lv-adj" value="${c ? c.smd_adjusted : ''}" placeholder="—"></td>
        </tr>`
      const loveRowsHtml = () => (loveCovariates.length ? loveCovariates.map(c => loveRowHtml(c)) : [loveRowHtml(), loveRowHtml(), loveRowHtml()]).join('')
      leftEl.innerHTML = `
        ${readyDs.length ? `
          <div style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--panel);display:flex;flex-direction:column;gap:6px;margin-bottom:6px;">
            <b class="small">从数据集计算倾向性评分平衡 (PSM / IPTW)</b>
            <label class="small">选择研究数据集
              <select id="bsCausalDs">${readyDs.map(d => `<option value="${esc(d.dataset_id)}">${esc(d.name)}</option>`).join('')}</select>
            </label>
            <div class="row" style="gap:6px;">
              <label class="small" style="flex:1;">暴露/治疗分组列（必选）
                <select id="bsCausalTreat"><option value="">请选择</option></select>
              </label>
              <label class="small" style="flex:1;">调整方法
                <select id="bsCausalMethod">
                  <option value="iptw">稳定化逆概率加权 (IPTW)</option>
                  <option value="psm">1:1 卡尺倾向性评分匹配 (PSM)</option>
                </select>
              </label>
            </div>
            ${colPickerHtml('bsCausalCovs', '混杂协变量（至少 1 个）')}
            <label class="small">结局事件列（可选；选了才会估计调整后 OR 与 E-value）
              <select id="bsCausalOutcome"><option value="">不估计效应</option></select>
            </label>
            <button type="button" class="small-btn primary" id="bsCausalAutoFitBtn">${icon('chart', { size: 13 })} 从数据集计算 SMD（及 E-value）</button>
          </div>
        ` : ''}
        <div class="rs-sub-box-title"><span>${icon('shield', { size: 13 })} 1. VanderWeele E-value（可手动填写已发表或外部分析的效应量）</span></div>
        <div class="row" style="gap:6px;">
          <label style="flex:1;">指标
            <select id="bsEvType"><option value="HR">HR</option><option value="OR">OR</option><option value="RR">RR</option></select>
          </label>
          <label style="flex:1;">点估计
            <input type="number" step="0.01" id="bsEvEst" placeholder="—">
          </label>
          <label style="flex:1;">CI 下限
            <input type="number" step="0.01" id="bsEvLo" placeholder="—">
          </label>
          <label style="flex:1;">CI 上限
            <input type="number" step="0.01" id="bsEvHi" placeholder="—">
          </label>
        </div>
        <label class="small" style="display:flex;align-items:center;gap:6px;"><input type="checkbox" id="bsEvRare"> 结局罕见（发生率 &lt; 15%；仅对 OR 有影响，不勾选按常见结局保守换算）</label>
        <div class="rs-sub-box">
          <div class="rs-sub-box-title">
            <span>2. 协变量 SMD 表（Love Plot）</span>
            <button type="button" class="quiet small-btn" id="bsLoveAddRow">＋ 新增协变量</button>
          </div>
          <table class="rs-data-table">
            <thead><tr><th>协变量名称</th><th style="width:74px;">调整前 SMD</th><th style="width:74px;">调整后 SMD</th></tr></thead>
            <tbody id="bsLoveTbody">${loveRowsHtml()}</tbody>
          </table>
        </div>
        <button type="button" class="primary small-btn" id="bsCausalRunBtn">${icon('chart', { size: 13 })} 按当前填写内容计算 E-value / 绘制 Love Plot</button>
      `
      rightEl.innerHTML = `<div class="muted small" style="padding:30px;text-align:center;">${readyDs.length
        ? '选择分组列和混杂协变量后点击「从数据集计算」，或在左侧手动填写效应量 / SMD。'
        : '在左侧手动填写效应量或 SMD 后计算；也可以先上传研究数据集。'}</div>`

      const dsCausalSel = document.getElementById('bsCausalDs') as HTMLSelectElement | null
      const treatCausalSel = document.getElementById('bsCausalTreat') as HTMLSelectElement | null
      const outCausalSel = document.getElementById('bsCausalOutcome') as HTMLSelectElement | null
      let causalLabels: Record<string, string> = {}
      /** SMD 表来自数据集计算时记录数据集 ID（归档溯源用）；用户手动改表后清空 */
      let causalFromDid = ''
      if (dsCausalSel && treatCausalSel && outCausalSel) {
        const loadCausalCols = async () => {
          try {
            const { cols, labels } = await loadDatasetCols(dsCausalSel.value)
            causalLabels = labels
            treatCausalSel.innerHTML = `<option value="">请选择</option>` + colOptionsHtml(cols, labels)
            outCausalSel.innerHTML = `<option value="">不估计效应</option>` + colOptionsHtml(cols, labels)
            fillColPicker('bsCausalCovs', cols, labels)
          } catch (err) {
            fillColPicker('bsCausalCovs', [], {}, `读取数据集列失败：${(err as Error).message}`)
          }
        }
        dsCausalSel.onchange = () => void loadCausalCols()
        void loadCausalCols()
      }

      const setEvInputs = (v: { type: string; est: string; lo: string; hi: string; rare: boolean }) => {
        ;(document.getElementById('bsEvType') as HTMLSelectElement).value = v.type
        ;(document.getElementById('bsEvEst') as HTMLInputElement).value = v.est
        ;(document.getElementById('bsEvLo') as HTMLInputElement).value = v.lo
        ;(document.getElementById('bsEvHi') as HTMLInputElement).value = v.hi
        ;(document.getElementById('bsEvRare') as HTMLInputElement).checked = v.rare
      }

      const autoFitCausal = async () => {
        const did = dsCausalSel?.value
        if (!did) return
        const treatment_col = treatCausalSel?.value || ''
        const outcome_col = outCausalSel?.value || ''
        const covariates = readColPicker('bsCausalCovs').filter(c => c !== treatment_col && c !== outcome_col)
        if (!treatment_col || !covariates.length) {
          notice('请先选择暴露/治疗分组列和至少 1 个混杂协变量', true)
          return
        }
        const method = ((document.getElementById('bsCausalMethod') as HTMLSelectElement)?.value || 'iptw') as 'iptw' | 'psm'
        rightEl.innerHTML = `<div class="muted small" style="padding:30px;text-align:center;">正在计算…</div>`
        try {
          const res = await api<any>(`/api/datasets/${did}/causal`, {
            method: 'POST',
            body: JSON.stringify({
              title: `${s.title} · Covariate Balance Love Plot`,
              treatment_col,
              outcome_col: outcome_col || undefined,
              covariates,
              method,
              labels: causalLabels,
            }),
          })
          loveCovariates = Array.isArray(res.covariates)
            ? res.covariates.map((c: any) => ({
                name: c.label_zh || c.name,
                smd_unadjusted: c.smd_unadjusted,
                smd_adjusted: c.smd_adjusted,
              }))
            : []
          const tbody = document.getElementById('bsLoveTbody')
          if (tbody) tbody.innerHTML = loveRowsHtml()
          causalFromDid = did
          const te = res.treatment_effect
          if (te && typeof te.estimate === 'number') {
            setEvInputs({ type: te.effect_type || 'OR', est: String(te.estimate), lo: String(te.ci_lower), hi: String(te.ci_upper), rare: !!te.rare_outcome })
          } else {
            setEvInputs({ type: 'OR', est: '', lo: '', hi: '', rare: false })
          }
          await runCausal()
        } catch (err) {
          rightEl.innerHTML = `<div class="muted small" style="padding:20px;">计算失败：${esc((err as Error).message)}</div>`
        }
      }
      document.getElementById('bsCausalAutoFitBtn')?.addEventListener('click', () => void autoFitCausal())

      const runCausal = async () => {
        const effect_type = (document.getElementById('bsEvType') as HTMLSelectElement).value
        const evRaw = ['bsEvEst', 'bsEvLo', 'bsEvHi'].map(id => (document.getElementById(id) as HTMLInputElement).value.trim())
        const rare_outcome = (document.getElementById('bsEvRare') as HTMLInputElement).checked
        const hasEv = evRaw.every(v => v !== '')
        if (!hasEv && evRaw.some(v => v !== '')) { notice('E-value 需要同时填写点估计、CI 下限和 CI 上限', true); return }
        const [estimate, ci_lower, ci_upper] = evRaw.map(Number)

        const trs = Array.from(leftEl.querySelectorAll<HTMLTableRowElement>('#bsLoveTbody tr'))
        const rows: LoveCov[] = []
        const bad: string[] = []
        trs.forEach((tr, i) => {
          const name = tr.querySelector<HTMLInputElement>('.bs-lv-name')?.value.trim() || ''
          const un = tr.querySelector<HTMLInputElement>('.bs-lv-un')?.value.trim() || ''
          const adj = tr.querySelector<HTMLInputElement>('.bs-lv-adj')?.value.trim() || ''
          if (!name && !un && !adj) return
          if (!name || un === '' || adj === '' || !Number.isFinite(Number(un)) || !Number.isFinite(Number(adj))) { bad.push(`第 ${i + 1} 行`); return }
          rows.push({ name, smd_unadjusted: Number(un), smd_adjusted: Number(adj) })
        })
        if (bad.length) { notice(`SMD 表${bad.join('、')}未填完整`, true); return }
        if (!hasEv && !rows.length) { notice('请填写效应量（计算 E-value）或至少 1 行 SMD（绘制 Love Plot）', true); return }
        loveCovariates = rows

        try {
          const [evRes, loveRes] = await Promise.all([
            hasEv
              ? api<any>(`/api/studies/${s.id}/causal/e-value`, {
                  method: 'POST',
                  body: JSON.stringify({ effect_type, estimate, ci_lower, ci_upper, rare_outcome }),
                })
              : Promise.resolve(null),
            rows.length
              ? api<any>(`/api/studies/${s.id}/causal/love-plot`, {
                  method: 'POST',
                  body: JSON.stringify({ title: `${s.title} · Covariate Balance Love Plot`, covariates: rows, threshold: 0.1 }),
                })
              : Promise.resolve(null),
          ])
          const svg = loveRes ? (loveRes.illustrator_svg || loveRes.svg || '') : ''
          rightEl.innerHTML = `
            ${evRes ? `
              <div class="row" style="gap:10px;flex-wrap:wrap;">
                <div class="rs-sub-box" style="flex:1;min-width:180px;">
                  <span class="muted small">VanderWeele E-value (点估计)</span>
                  <b style="font-size:22px;color:var(--mint-text);">${evRes.e_value_point.toFixed(2)}</b>
                </div>
                <div class="rs-sub-box" style="flex:1;min-width:180px;">
                  <span class="muted small">95% CI 保守边界 E-value</span>
                  <b style="font-size:22px;color:var(--text);">${evRes.e_value_ci.toFixed(2)}</b>
                </div>
                <button type="button" class="small-btn" id="bsCopyRebuttal">${icon('copy', { size: 13 })} 复制 E-value 敏感性分析段落</button>
              </div>
            ` : '<div class="muted small">未填写效应量，未计算 E-value。</div>'}
            ${loveRes ? `
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
            ` : '<div class="muted small" style="margin-top:6px;">未填写 SMD，未绘制 Love Plot。</div>'}
          `
          if (evRes) {
            document.getElementById('bsCopyRebuttal')?.addEventListener('click', () => {
              navigator.clipboard.writeText(`${evRes.academic_defense_zh}\n\n${evRes.academic_defense_en}`)
              notice('已复制中英文 E-value 敏感性分析段落')
            })
          }
          if (loveRes) {
            document.getElementById('bsArchLove')?.addEventListener('click', () => void archiveStudyFigure(s.id, 'Causal_Love_Plot', svg, loveRes.r_script, undefined, causalFromDid || undefined))
            document.getElementById('bsDlLovePzfx')?.addEventListener('click', () => loveRes.prism_pzfx && downloadBlobContent(loveRes.prism_pzfx, 'Love_Plot.pzfx', 'application/xml;charset=utf-8'))
            document.getElementById('bsDlLoveR')?.addEventListener('click', () => loveRes.r_script && downloadBlobContent(loveRes.r_script, 'Love_Plot_cobalt.R'))
            document.getElementById('bsDlLoveSvg')?.addEventListener('click', () => svg && downloadBlobContent(svg, 'Love_Plot.svg', 'image/svg+xml;charset=utf-8'))
          }
        } catch (err) {
          rightEl.innerHTML = `<div class="muted small" style="padding:20px;">${esc((err as Error).message)}</div>`
        }
      }
      document.getElementById('bsCausalRunBtn')!.onclick = () => { causalFromDid = ''; void runCausal() }
      document.getElementById('bsLoveAddRow')!.onclick = () => {
        document.getElementById('bsLoveTbody')?.insertAdjacentHTML('beforeend', loveRowHtml())
      }
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
                        ${a.stale_data ? `<span class="flag-L small" title="${esc(a.stale_reason || '底层数据集已更新，建议重新生成图表')}">${icon('warning', { size: 11 })} 数据已更新</span><span>·</span>` : ''}
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
              <p class="muted small">当前 <code>figures/</code> 还没有已归档图表。你可以先在「统计与制图」页签绘制图表并点击「归档至本研究」，或直接使用下方默认示例合成顶刊多面板大图。</p>
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
          const text = r.ok ? await r.text() : ''
          // 任一面板取回失败就停止，避免面板字母错位
          if (!text.includes('<svg')) throw new Error(`面板「${cb.dataset.figname || assetId}」读取失败或不是 SVG 矢量图，请取消勾选后重试`)
          panels.push({
            label: String.fromCharCode(65 + i),
            title: cb.dataset.figname || `Panel ${String.fromCharCode(65 + i)}`,
            svg: text,
          })
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
          从平台已有记录汇总入组受试者的影像量化结果（病灶长径 / L3 SMI / 脂肪比等）与化验数据，每个单元格标注来源与核实状态，生成研究宽表。本功能只读取已有记录，不重新分析影像；未核实的值需研究者逐项核实后才会用于投稿材料。
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
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
              <input type="checkbox" id="rsEcrfSyncVars" checked>
              <span>提取后自动同步回写至「研究变量表 (<code>subject_vars</code>)」（保留已人工核实项，无缝衔接生成宽表）</span>
            </label>
            <button class="primary small-btn" id="rsStartExtract">${icon('write', { size: 13 })} 开始自动巡航批量提取</button>
          </div>
        </div>

        <!-- Extract Progress -->
        <div id="rsEcrfProgress" style="display:none;flex-direction:column;gap:10px;padding:24px 0;align-items:center;">
          <div class="muted small" id="rsEcrfProgressText">正在汇总入组受试者的已有影像分析与化验记录…</div>
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
          if (txt) txt.textContent = '正在汇总入组受试者的已有影像分析与化验记录…'

          setTimeout(() => {
            if (bar) bar.style.width = '70%'
            if (txt) txt.textContent = '正在按变量匹配记录并标注来源…'
          }, 300)

          try {
            const syncToVars = (document.getElementById('rsEcrfSyncVars') as HTMLInputElement | null)?.checked ?? true
            const res = await api<any>(`/api/studies/${studyId}/ecrf/extract`, {
              method: 'POST',
              body: JSON.stringify({ variable_ids: selected, sync_to_vars: syncToVars })
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
              已回填: ${s.extracted_cells} 项（已核实 ${s.verified_cells ?? 0} 项）
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
              // 标注来源等级与核实状态，而不是写死的「置信度」百分比
              const tag = cell.verified ? '已核实' : `${ECRF_TIER_SHORT[cell.source_tier] ?? '来源未知'} · 未核实`
              tableHtml += `<td>
                <button type="button" class="linkish" data-audit-cell="${esc(r.subject_id)}" data-audit-var="${esc(v.id)}" style="font-weight:600;color:var(--text);text-align:left;display:block;width:100%;">
                  ${esc(cell.formatted)}
                  <span style="font-size:10px;color:${cell.verified ? '#047857' : 'var(--warn)'};margin-left:2px;">[${esc(tag)}]</span>
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
                  <div>• <b>核实状态</b>: <span style="font-weight:700;color:${cell.verified ? '#047857' : 'var(--warn)'};">${cell.verified ? '研究者已核实' : '未核实'}</span></div>
                  <div>• <b>数据来源</b>: <span style="font-weight:600;">${esc(ECRF_TIER_LABEL[cell.source_tier] ?? '来源未知')}</span></div>
                  <div>• <b>提取时间戳</b>: <span class="muted small">${date(cell.extracted_at)}</span></div>
                </div>
                ${cell.source_slice_index ? `<div style="background:#f8fafc;padding:6px 10px;border-radius:4px;border:1px solid #e2e8f0;margin-top:4px;">
                  <b>3D 影像切片锚点</b>: 轴位关键层号 <code>#${cell.source_slice_index}</code> 层 (解剖包络线内定向测量)
                </div>` : ''}
                ${cell.source_detail ? `<div style="margin-top:4px;color:var(--text-secondary);font-size:12px;">• 详细溯源说明: ${esc(cell.source_detail)}</div>` : ''}
                <div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--line);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <label class="small" style="display:inline-flex;align-items:center;gap:6px;">
                    <b>源数据核对 (SDV) 修订值：</b>
                    <input type="text" id="rsAuditEditVal" value="${esc(cell.value ?? '')}" style="width:120px;">
                  </label>
                  <button type="button" class="small-btn primary" id="rsAuditVerifyBtn">${icon('check', { size: 12 })} 确认无误并 SDV 核实锁定</button>
                  <span class="muted small">核实后标记为「已核实」并写入研究变量表</span>
                </div>
              `
              const verifyBtn = document.getElementById('rsAuditVerifyBtn')
              if (verifyBtn) {
                verifyBtn.onclick = async () => {
                  const rawInput = (document.getElementById('rsAuditEditVal') as HTMLInputElement | null)?.value.trim() ?? ''
                  const numVal = Number(rawInput)
                  const finalVal = rawInput !== '' && Number.isFinite(numVal) ? numVal : rawInput
                  try {
                    await api(`/api/studies/${studyId}/ecrf/verify-cell`, {
                      method: 'POST',
                      body: JSON.stringify({
                        subject_id: subId,
                        var_id: varId,
                        value: finalVal,
                        note: `${cell.source_detail || 'Auto-eCRF'} · 研究者 SDV 复核确认`,
                      }),
                    })
                    cell.value = finalVal
                    cell.verified = true
                    cell.formatted = vDef?.unit ? `${finalVal} ${vDef.unit}` : String(finalVal)
                    btn.innerHTML = `${esc(cell.formatted)} <span style="font-size:10px;color:#047857;margin-left:2px;">[已核实]</span>`
                    notice(`已核实并锁定受试者 ${subId} 的「${vDef?.name_zh || varId}」数据`)
                  } catch (err) {
                    notice((err as Error).message, true)
                  }
                }
              }
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
      <p class="welcome-sub">一个研究项目集中管理方案、队列、统计与稿件；在隔离受限沙箱中秒级运行 Table 1 与生存曲线，数据与代码可追溯。</p>
      <div class="welcome-cards">
        <button class="welcome-card primary" data-rw="new"><b>＋ 新建研究项目</b><span>研究设计、纳入排除标准、主要终点与方案起草</span></button>
        <button class="welcome-card" data-rw="dataset"><b>导入数据集</b><span>支持 CSV、Excel、SAS、SPSS、Stata 质控导入</span></button>
        ${list[0]
          ? `<button class="welcome-card" data-rw="open"><b>打开最近研究</b><span>打开「${esc(list[0].title)}」</span></button>`
          : `<button class="welcome-card" data-rw="cohort"><b>筛选入组队列</b><span>从患者库多维条件筛选入组生成研究数据集</span></button>`}
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
          createDialog({ mode: 'excel_fast' })
        }
        return
      }
      if (b.dataset.rw === 'cohort') {
        if (list[0]) {
          await openStudy(list[0].id)
          const screenBtn = document.querySelector<HTMLElement>('[data-act="screen"]')
          if (screenBtn) screenBtn.click()
        } else {
          createDialog({ mode: 'protocol_cohort' })
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
    if (act === 'consort') { void consortDialog(id); return }
    if (act === 'samplesize') { void sampleSizeDialog(id); return }
    if (act === 'ecrf') { void ecrfDialog(id); return }
    if (act === 'vars') { void varsDialog(id); return }
    if (act === 'img-export') { void imagingExportDialog(id); return }
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
