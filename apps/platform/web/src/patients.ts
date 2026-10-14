/**
 * 患者（第二期）：左栏「患者」页签、患者页（概览 / 化验 / 报告 / 待确认）、上传报告与审核、诊疗组、紧急访问、访问记录。
 * 患者在平台里只有代号；「代号 → 姓名」的备注只存在这台电脑的浏览器里（localStorage），平台不保存。
 */
import { ENGINE_GROUP, ENGINE_LABEL, ENGINE_STYLE, modelOptionTag } from './imaging-engine.ts'
import { caliperMeasure, formatMeasure, largeEnough, NO_SPACING_NOTE, planeSpacing, roiMeasure, type Measure, type Plane, type Spacing, type VoxelSpacing } from './mpr-measure.ts'
import { photoFigure } from './photos.ts'
import { askConfirm, askText } from './dialogs.ts'
import { icon } from './icons.ts'
import { openHelpGuide, importHelpAsDoc } from './help.ts'
import { esc } from './dom.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notice = (msg: string, error?: boolean) => void

interface Patient {
  id: string; code: string; sex: 'M' | 'F' | null; birth_year: number | null; tags: string[]; status: string
  role?: string; labs?: number; last_lab?: string | null; pending?: number
}
interface Lab {
  id: string; record_id: string | null; test_key: string; test_name: string; value_num: number | null; value_text: string | null; unit: string | null
  ref_low: number | null; ref_high: number | null; ref_text: string | null; flag: 'H' | 'L' | null; collected_on: string | null
  status: 'pending' | 'confirmed' | 'rejected' | 'superseded'; source: string; locator: { page?: number; verified?: boolean } | null
  collected_at: string | null; replaces: string | null
  std_value: number | null; std_unit: string | null; std_ref_low: number | null; std_ref_high: number | null; converted: boolean; unknown_unit: boolean
  same_day?: Lab[]
}
interface RecordRow {
  id: string; kind: string; title: string; report_date: string | null; file_id: string | null; status: 'pending' | 'confirmed' | 'rejected'
  extraction: string | null; extraction_note: string | null; created_at: string
  /** ai_report = AI 生成的报告草稿 */
  origin?: string | null
  imaging_data?: {
    model_id?: string
    sample_id?: string | null
    modality?: string
    asset_id?: string
    file_id?: string
    raw_file_id?: string | null
    raw_file_name?: string | null
    raw_file_size?: number | null
    metrics?: Record<string, any>
    findings?: string[]
    analyzed_at?: string
  } | null
}
interface Detail extends Patient {
  access: 'owner' | 'member' | 'tenant' | 'break_glass'; summary: string | null
  documents: Array<{ doc_id: string; kind: string; title: string; author: string; linked_at: string; updated_at: string; can_open: boolean }>
  care_team: Array<{ user_id: string; role: string; name: string }>; records: RecordRow[]; latest_labs: Lab[]
  pending_proposals: Array<{ id: string; kind: string; payload: Record<string, unknown>; reason: string; created_at: string }>
  /** 所在研究（研究编号） */
  studies?: Array<{ study_id: string; title: string; subject_id: string; enrolled_at: string }>
}

interface ShareSummary {
  share_id: string; share_code: string; department: string; to_me: boolean; scope: { categories: string[]; since: string | null }
  allow_import: boolean; expires_at: string; shared_at: string; imported: { at: string; patient_id: string | null } | null; display_name?: string | null
}
interface ShareDetail extends ShareSummary {
  sex: 'M' | 'F' | null; birth_year: number | null; tags: string[]; latest_labs: Lab[]; lab_count: number
  records: Array<{ id: string; kind: string; title: string; report_date: string | null; file_id: string | null }>
  documents: Array<{ doc_id: string; kind: string; title: string; updated_at: string }>
}
const SCOPE: Record<string, string> = { labs: '化验', reports: '报告原件', docs: '简报与健康档案' }
const scopeText = (s: { categories: string[]; since: string | null }) => `${s.categories.map(c => SCOPE[c] ?? c).join('、')}${s.since ? `（${s.since} 起）` : ''}`

export interface PatientHooks {
  /** 离开当前文档（关掉编辑器、清空中间区域） */
  leaveDoc(): void
  openDoc(id: string): Promise<void>
  /** 把指令填进对话框（不发送） */
  prefillChat(text: string): void
  /** 切到某个工作空间（左侧图标栏） */
  goSpace(space: 'write' | 'patients' | 'research'): void
  tenantId(): string | null
  token(): string
  /** 打开研究页（患者所在研究） */
  openStudy?(id: string): Promise<void>
}

const KIND: Record<string, string> = { lab_report: '化验', discharge: '出院小结', pathology: '病理', imaging: '影像', note: '记录', other: '报告' }
const SEX: Record<string, string> = { M: '男', F: '女' }
const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.docx,.txt'
const value = (l: Lab) => l.value_num ?? l.value_text ?? ''
const ref = (l: Lab) => l.ref_low !== null || l.ref_high !== null ? `${l.ref_low ?? ''}–${l.ref_high ?? ''}` : (l.ref_text ?? '')
/** 标准单位下的值（化验表、趋势用）；换算过的带「*」，悬停看原值 */
const stdValue = (l: Lab) => l.std_value ?? l.value_text ?? ''
const stdRef = (l: Lab) => l.std_ref_low !== null || l.std_ref_high !== null ? `${l.std_ref_low ?? ''}–${l.std_ref_high ?? ''}` : (l.ref_text ?? '')
const origNote = (l: Lab) => l.converted ? `原值 ${l.value_num} ${l.unit ?? ''}，已换算` : l.unknown_unit ? `单位 ${l.unit} 无法换算，不能与其他次直接比较` : ''
const when = (l: Lab) => l.collected_at ?? l.collected_on ?? ''

export function initPatients(api: Api, notice: Notice, hooks: PatientHooks) {
  let list: Patient[] = []
  let current: string | null = null
  let tab: 'overview' | 'labs' | 'records' | 'docs' | 'review' = 'overview'
  let poll: ReturnType<typeof setTimeout> | null = null
  const $ = (id: string) => document.getElementById(id)!

  // —— 本机备注名 ——
  const namesKey = () => `heurion.ptnames.${hooks.tenantId() ?? 'x'}`
  const names = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(namesKey()) ?? '{}') } catch { return {} } }
  const setName = (id: string, name: string) => { try { const n = names(); if (name.trim()) n[id] = name.trim().slice(0, 40); else delete n[id]; localStorage.setItem(namesKey(), JSON.stringify(n)) } catch { /* 无痕模式 */ } }
  const label = (p: Patient) => names()[p.id] ? `${p.code} · ${names()[p.id]}` : p.code
  const age = (p: Patient) => p.birth_year ? `${new Date().getFullYear() - p.birth_year} 岁` : ''

  // —— 左栏 ——

  // —— 家庭分享（知家家人分享给本人科室 / 本人的档案，只读；docs/design/SHARING.md）——
  let shares: ShareSummary[] = []
  async function loadShares(): Promise<void> {
    try { shares = await api<ShareSummary[]>('/api/shares') } catch { shares = [] }
  }

  async function loadList(): Promise<void> {
    await loadShares()
    try { list = await api<Patient[]>('/api/patients') } catch (err) {
      $('patientList').innerHTML = `<li class="nav-empty">${esc((err as Error).message)}</li>`
      return
    }
    renderList()
  }

  function renderList(): void {
    const q = (document.getElementById('docSearch') as HTMLInputElement).value.trim().toLowerCase()
    const shown = list.filter(p => !q || label(p).toLowerCase().includes(q) || p.tags.some(t => t.toLowerCase().includes(q)))
    $('patientList').innerHTML = (shares.length ? `<li class="pt-share-row${document.getElementById('page')!.classList.contains('share-page') ? ' active' : ''}" data-shares title="知家家人分享给你所在科室的档案（只读）">
        <span class="pt-code">家庭</span><span class="label">家庭分享</span><span class="count">${shares.length}</span></li>` : '')
      + shown.map(p => `<li data-pt="${p.id}" class="${p.id === current ? 'active' : ''}" title="${esc(p.tags.join('、'))}">
        <span class="pt-code">${esc(p.code)}</span><span class="label">${esc(names()[p.id] ?? p.tags.slice(0, 2).join('、'))}</span>
        ${p.pending ? `<span class="count" title="待确认">${p.pending}</span>` : ''}${p.role === 'break_glass' ? '<span class="pill off" title="紧急访问">紧急</span>' : ''}</li>`).join('')
      + (list.length === 0 ? '<li class="nav-empty">还没有患者。点「＋患者」新建；患者在系统里只用代号。</li>' : shown.length === 0 ? `<li class="nav-empty">没有找到「${esc(q)}」</li>` : '')
      + '<li class="nav-empty pt-glass-row"><button class="nav-add" id="breakGlassBtn" hidden>紧急访问…</button></li>'
    void api('/api/tenant').then(t => { const b = document.getElementById('breakGlassBtn'); if (b) b.hidden = t.role !== 'admin' }).catch(() => {})
  }

  async function createPatient(): Promise<void> {
    const sex = await askText({ title: '新建患者', label: '性别（男 / 女，可留空）', placeholder: '男', confirm: '下一步', hint: '患者在系统里只有代号（P-0001…），不要填姓名。姓名可以在患者页「本机备注」里记，只存在这台电脑上。' })
    if (sex === null) return
    const year = await askText({ title: '新建患者', label: '出生年份（可留空）', placeholder: '1962', confirm: '下一步' })
    if (year === null) return
    const tags = await askText({ title: '新建患者', label: '诊断标签（用逗号分开，可留空）', placeholder: '2型糖尿病，CKD3', confirm: '创建' })
    if (tags === null) return
    try {
      const p = await api<Patient>('/api/patients', { method: 'POST', body: JSON.stringify({ sex: sex.trim(), birth_year: year.trim() || null, tags: tags.split(/[,，、;；]/).map(x => x.trim()).filter(Boolean) }) })
      await loadList()
      await openPatient(p.id)
    } catch (err) { notice((err as Error).message, true) }
  }

  async function breakGlass(): Promise<void> {
    const dir = await api<Array<{ id: string; code: string }>>('/api/patients-directory')
    const visible = new Set(list.map(p => p.id))
    const others = dir.filter(d => !visible.has(d.id))
    if (others.length === 0) { notice('本机构所有患者你都已能看到'); return }
    const code = await askText({ title: '紧急访问', label: `患者代号（可访问的：${others.map(o => o.code).slice(0, 12).join('、')}${others.length > 12 ? ' …' : ''}）`, placeholder: 'P-0001', confirm: '下一步' })
    const target = others.find(o => o.code === code?.trim().toUpperCase())
    if (!target) { if (code) notice('没有这个代号', true); return }
    const reason = await askText({ title: `紧急访问 ${target.code}`, label: '理由（至少 10 个字，会记入访问日志并留痕）', placeholder: '例如：患者夜间急诊，主治医生不在，需要查看既往肾功能', confirm: '申请 24 小时只读访问' })
    if (!reason) return
    try {
      await api(`/api/patients/${target.id}/break-glass`, { method: 'POST', body: JSON.stringify({ reason }) })
      notice('已获得 24 小时只读访问，已记入访问日志')
      await loadList()
      await openPatient(target.id)
    } catch (err) { notice((err as Error).message, true) }
  }

  // —— 患者页 ——
  let openPatientSeq = 0

  async function openPatient(id: string, keepTab = false, initialTab?: 'overview' | 'labs' | 'records' | 'docs' | 'review'): Promise<void> {
    if (!id) return
    if (current !== id) hooks.leaveDoc()
    current = id
    const seq = ++openPatientSeq
    if (!keepTab) tab = initialTab || 'overview'
    if (poll) { clearTimeout(poll); poll = null }
    let d: Detail
    try { d = await api<Detail>(`/api/patients/${id}`) } catch (err) {
      if (seq === openPatientSeq) { notice((err as Error).message, true); current = null }
      return
    }
    if (seq !== openPatientSeq || current !== id) return
    const page = $('page')
    page.className = 'page patient-page'
    $('docTitle').textContent = label(d)
    renderList()
    const pendingLabs = tab === 'review' || tab === 'labs' ? await api<Lab[]>(`/api/patients/${id}/labs?pending=1`) : []
    if (seq !== openPatientSeq || current !== id) return
    const confirmedLabs = tab === 'labs' ? pendingLabs.filter(l => l.status === 'confirmed') : []
    const pendingCount = d.records.filter(r => r.status === 'pending').length + d.pending_proposals.length
    const canEdit = d.access === 'owner' || d.access === 'member'
    page.innerHTML = `
      <div class="pt-head">
        <div class="pt-id"><span class="pt-code big">${esc(d.code)}</span>
          <button class="quiet small-btn" data-act="alias" title="只存在这台电脑的浏览器里，平台不保存">${names()[d.id] ? `本机备注：${esc(names()[d.id])}` : '＋ 本机备注姓名'}</button></div>
        <div class="pt-meta">${[d.sex ? SEX[d.sex] : '', d.birth_year ? `${d.birth_year} 年生（${age(d)}）` : ''].filter(Boolean).join(' · ') || '<span class="muted">未填性别 / 年龄</span>'}
          ${d.tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}${canEdit ? '<button class="quiet small-btn" data-act="tags">编辑</button>' : ''}</div>
        ${d.access === 'break_glass' ? '<div class="notice">紧急访问（只读，24 小时内有效，已记入访问日志）</div>' : d.access === 'tenant' ? '<div class="muted small">机构设置为全员可见：你可以查看，修改需要加入诊疗组</div>' : ''}
        <div class="row pt-actions">
          ${canEdit ? `<button class="primary" data-act="imaging" title="对 CT / MRI 做量化测量（规则算法、定量 CT 或深度学习模型，按模型如实标注）并存入患者档案">${icon('scan')} 影像分析</button>` : ''}
          ${canEdit ? `<button data-act="upload" title="化验单、出院小结、病理报告（PDF、扫描件、手机照片）：自动提取，审核后进入化验表">上传化验单 / 报告</button><input type="file" id="ptUpload" accept="${ACCEPT}" multiple hidden>` : ''}
          <button data-act="report" title="新建一份病例报告并关联到这位患者；对话框里会填好建议的指令，由你确认后发送">写病例报告</button>
          ${d.access === 'owner' ? `<span class="grow"></span><div class="menu-wrap"><button data-act="ptmore" aria-haspopup="menu">更多 ▾</button>
            <div class="dropdown" id="ptMore" hidden><button data-act="claim">就诊认领与知家绑定</button><button data-act="team">诊疗组</button><button data-act="log">访问记录</button><button data-act="delete" class="danger-text">删除患者</button></div></div>` : ''}
        </div>
        ${pendingCount ? `<div class="banner pt-pending"><span class="dot"></span>${d.records.filter(r => r.status === 'pending').length} 份报告、${d.pending_proposals.length} 条 AI 提议待确认<button data-tab="review">去审核</button></div>` : ''}
      </div>
      <div class="tabs pt-tabs">${(['overview', 'labs', 'records', 'docs', 'review'] as const).map(t => `<button data-tab="${t}" class="${t === tab ? 'active' : ''}">${{ overview: '概览', labs: '化验', records: `原始报告 / 影像${d.records.filter(r => r.kind === 'imaging').length ? ` (${d.records.filter(r => r.kind === 'imaging').length})` : ''}`, docs: `病例报告${d.documents.length ? ` (${d.documents.length})` : ''}`, review: `待确认${pendingCount ? ` (${pendingCount})` : ''}` }[t]}</button>`).join('')}</div>
      <div class="pt-body">${tab === 'overview' ? overview(d, canEdit) : tab === 'labs' ? labsView(confirmedLabs) : tab === 'records' ? recordsView(d) : tab === 'docs' ? docsView(d) : reviewView(d, pendingLabs, canEdit)}</div>`
    // 还在提取的报告：隔几秒刷新
    if (d.records.some(r => r.extraction === 'queued' || r.extraction === 'running')) poll = setTimeout(() => { if (current === id) void openPatient(id, true) }, 3000)
  }

  function overview(d: Detail, canEdit: boolean): string {
    const imagingRecords = d.records.filter(r => r.kind === 'imaging')
    const scanRecords = imagingRecords.filter(r => r.imaging_data?.model_id !== 'recist_longitudinal_comparator')
    const hasMultiImaging = scanRecords.length >= 2
    const latestImg = scanRecords[0] || imagingRecords[0]
    let imgWidget = ''
    if (latestImg) {
      const imgData = (latestImg.imaging_data || {}) as Record<string, any>
      const aid = imgData.asset_id
      const sliceFid = imgData.file_id
      const rawFid = imgData.raw_file_id || (latestImg.file_id && latestImg.file_id !== sliceFid ? latestImg.file_id : null)
      const imgUrl = aid
        ? `/api/assets/${aid}?token=${encodeURIComponent(hooks.token())}`
        : (sliceFid && sliceFid !== rawFid)
        ? `/api/patients/${d.id}/files/${sliceFid}?token=${encodeURIComponent(hooks.token())}`
        : (!rawFid && latestImg.file_id)
        ? `/api/patients/${d.id}/files/${latestImg.file_id}?token=${encodeURIComponent(hooks.token())}`
        : ''

      const m = (imgData.metrics || imgData.raw_metrics || {}) as Record<string, any>
      const isHAM = Boolean(m.high_attenuation_mucus || (m.ham_max_hu && m.ham_max_hu > 70) || (m.high_attenuation_mucus_cm3 && m.high_attenuation_mucus_cm3 > 0))
      const isNegative = m.has_lesion === false || (m.longest_diameter_mm === 0)
      const isHighRiskNodule = !isNegative && Boolean(m.longest_diameter_mm && m.longest_diameter_mm >= 8)
      const igeLab = d.latest_labs.find(l => l.test_key === 'ige' || l.test_name.includes('IgE'))

      let proactiveBanner = ''
      if (isHAM) {
        proactiveBanner = `
          <div class="pt-proactive-banner alert-ham">
            <div class="pt-proactive-main">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
                <span class="pt-proactive-pill medium">影像所见</span>
                <span class="muted small">高密度粘液栓 · 算法测得 CT 值 &gt; 70 HU</span>
              </div>
              <div style="font-weight: 600; font-size: 13.5px; color: #FCA5A5; margin-bottom: 4px">
                算法测得支气管管腔高密度粘液栓
              </div>
              <div class="muted small" style="line-height: 1.5; color: var(--text-1)">
                量化记录显示管腔内粘液栓 CT 值高于 70 HU${igeLab ? `；近期总 IgE ${igeLab.value_num ?? igeLab.std_value} ${igeLab.unit || 'kU/L'}` : ''}。上述所见需结合临床与实验室检查判断。
              </div>
            </div>
            <div class="pt-proactive-actions">
              <button class="primary small-btn" data-generate-full-report="${latestImg.id}">${icon('report')} 生成影像所见报告</button>
              <button class="small-btn quiet" data-open-evidence="${latestImg.id}">${icon('evidence')} 查看指标对照</button>
            </div>
          </div>
        `
      } else if (isHighRiskNodule) {
                const radsDesc = `长径 ${m.longest_diameter_mm} mm（≥ 8 mm）`
        proactiveBanner = `
          <div class="pt-proactive-banner alert-nodule">
            <div class="pt-proactive-main">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
                <span class="pt-proactive-pill medium">结节测量</span>
                <span class="muted small">${radsDesc}</span>
              </div>
              <div style="font-weight: 600; font-size: 13.5px; color: #FDE68A; margin-bottom: 4px">
                算法测得结节，长径 ${m.longest_diameter_mm} mm
              </div>
              <div class="muted small" style="line-height: 1.5; color: var(--text-1)">
                量化记录：长径 ${m.longest_diameter_mm} mm，三维体积 ${m.total_volume_cm3 ?? '--'} cm³。上述所见需结合临床与实验室检查判断。
              </div>
            </div>
            <div class="pt-proactive-actions">
              <button class="primary small-btn" data-generate-full-report="${latestImg.id}">${icon('report')} 生成影像所见报告</button>
              <button class="small-btn quiet" data-open-evidence="${latestImg.id}">${icon('evidence')} 查看指标对照</button>
            </div>
          </div>
        `
      }

      imgWidget = `
      <section class="pt-overview-imaging">
        <div class="row" style="align-items: baseline; margin-bottom: 8px">
          <h3 class="mem-h" style="margin: 0">最新医学影像量化</h3>
          <span class="grow"></span>
          ${hasMultiImaging ? `<button class="primary small-btn" data-act="compare-imaging" style="margin-right: 8px" title="对比多期影像并计算 RECIST 1.1 疗效等级">${icon('compare')} 多期影像随访对比 (RECIST 1.1)</button>` : ''}
          <button class="quiet small-btn" data-tab="records">查看全部影像档案 (${imagingRecords.length}) ${icon('arrowRight', { size: 12 })}</button>
        </div>
        ${proactiveBanner}
        <div class="pt-overview-img-card" data-rec="${latestImg.id}">
          <div class="pt-overview-thumb-wrap" style="position: relative; width: 140px; height: 110px; flex-shrink: 0; background: #000; border-radius: 6px; overflow: hidden; display: flex; align-items: center; justify-content: center">
            ${imgUrl ? `<img src="${imgUrl}" class="pt-overview-thumb" data-view-img="${imgUrl}" title="点击查看切片大图" style="width: 100%; height: 100%; object-fit: contain; cursor: pointer" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex'">` : ''}
            <div class="pt-imaging-no-img" style="${imgUrl ? 'display: none;' : ''}width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 11px">暂无预览</div>
            <span class="pt-imaging-badge-overlay" style="position: absolute; top: 4px; left: 4px; font-size: 10px; background: rgba(0,0,0,0.6); padding: 2px 6px; border-radius: 4px">${esc(latestImg.imaging_data?.modality || 'CT')}</span>
          </div>
          <div class="pt-overview-img-meta">
            <div class="row" style="align-items: center; justify-content: space-between"><b>${esc(latestImg.title)}</b><span class="muted small">${esc(latestImg.report_date || '')}</span></div>
            <div class="muted small" style="margin: 6px 0 10px; line-height: 1.5">${esc(latestImg.extraction_note || '已完成三维体素分割与定量测量')}</div>
            <div class="row" style="gap: 8px; flex-wrap: wrap">
              <button class="primary small-btn" data-generate-full-report="${latestImg.id}" title="生成影像量化所见报告（只列实测值与相关化验，不含诊断结论；AI 生成的存为待医生确认的草稿）">${icon('report')} 影像所见报告</button>
              <button class="small-btn quiet" data-img-report="${latestImg.id}">${icon('write')} 基于此影像写报告</button>
              <button class="small-btn" data-img-canvas="${latestImg.id}">${icon('deck')} 会诊 Slide</button>
              <button class="small-btn quiet" data-open-mpr="${latestImg.id}" title="进入 3D 多平面重建 (MPR) 互动切片浏览器">${icon('mpr')} 3D 切片</button>
              <button class="small-btn quiet" data-open-evidence="${latestImg.id}" title="查看多模态因果诊断链 (影像 + 化验 + 病史)">${icon('evidence')} 因果诊断链</button>
              <button class="small-btn quiet" data-export-standard="${latestImg.id}" title="导出 HL7 FHIR 或 DICOM SR 标准医学交换格式">${icon('download')} 导出标准数据</button>
              ${hasMultiImaging ? `<button class="small-btn quiet" data-compare-with="${latestImg.id}" title="以该影像为基准进行 RECIST 1.1 多期随访对比">${icon('compare')} 随访对比</button>` : ''}
              <button class="quiet small-btn" data-tab="records">详细指标</button>
            </div>
          </div>
        </div>
      </section>`
    }

    return `<section><h3 class="mem-h">摘要</h3>
        ${canEdit ? `<textarea id="ptSummary" data-pid="${esc(d.id)}" rows="4" placeholder="病史要点、用药、随访计划（只用代号，不写姓名）">${esc(d.summary ?? '')}</textarea>` : `<div class="pt-summary">${esc(d.summary ?? '（无）')}</div>`}</section>
      ${imgWidget}
      <section><h3 class="mem-h">最近化验</h3>${d.latest_labs.length === 0 ? '<div class="muted">还没有已确认的化验。点「上传化验单 / 报告」，自动提取后在「待确认」里审核。</div>' : `<table class="users pt-labs">
        <thead><tr><th>项目</th><th>结果</th><th>参考范围</th><th>日期</th></tr></thead><tbody>
        ${d.latest_labs.map(l => `<tr data-trend="${esc(l.test_key)}"><td>${esc(l.test_name)}</td><td class="flag-${l.flag ?? 'n'}" title="${esc(origNote(l))}">${esc(stdValue(l))} ${esc(l.std_unit ?? '')}${l.flag === 'H' ? ' ↑' : l.flag === 'L' ? ' ↓' : ''}${l.converted || l.unknown_unit ? '<sup>*</sup>' : ''}</td><td class="muted">${esc(stdRef(l))}</td><td class="muted">${esc(when(l))}</td></tr>`).join('')}
        </tbody></table><div class="muted small">点一行看趋势。</div>`}</section>
      ${d.studies?.length ? `<section><h3 class="mem-h">所在研究</h3><div>${d.studies.map(x => `<button class="chip pt-study" data-study="${x.study_id}" title="打开研究">${esc(x.title)} · ${esc(x.subject_id)}</button>`).join(' ')}</div></section>` : ''}
      <section><h3 class="mem-h">诊疗组</h3><div>${d.care_team.map(m => `<span class="chip">${esc(m.name)}${m.role === 'owner' ? '（负责人）' : ''}</span>`).join(' ')}</div></section>`
  }

  function labsView(labs: Lab[]): string {
    if (labs.length === 0) return '<div class="muted">还没有已确认的化验。</div>'
    const dates = [...new Set(labs.map(l => l.collected_on!))].sort().reverse().slice(0, 12)
    const tests = [...new Map(labs.map(l => [l.test_key, l])).values()]
    // 同一天多次：显示最新一次 + ×N，悬停列出每一次（时间、值、原单位）
    const cell = (key: string, date: string) => {
      const day = labs.filter(x => x.test_key === key && x.collected_on === date)
      const l = day.at(-1)
      if (!l) return '<td></td>'
      const tip = day.map(x => `${x.collected_at ?? x.collected_on}：${stdValue(x)} ${x.std_unit ?? ''}${x.converted ? `（原值 ${x.value_num} ${x.unit}）` : ''}`).join('\n') + (origNote(l) && day.length === 1 ? '' : '')
      return `<td class="flag-${l.flag ?? 'n'}" title="${esc(day.length > 1 ? tip : origNote(l))}">${esc(stdValue(l))}${l.flag === 'H' ? '↑' : l.flag === 'L' ? '↓' : ''}${l.converted || l.unknown_unit ? '<sup>*</sup>' : ''}${day.length > 1 ? `<span class="pt-multi">×${day.length}</span>` : ''}</td>`
    }
    const unitOf = (key: string) => {
      const units = [...new Set(labs.filter(l => l.test_key === key).map(l => l.std_unit ?? ''))]
      return units.length > 1 ? `<span class="flag-L" title="有无法换算的单位，不同次不能直接比较">${esc(units.join(' / '))} ${icon('warning', { size: 11 })}</span>` : esc(units[0] ?? '')
    }
    const anyConverted = labs.some(l => l.converted)
    return `<div class="ds-scroll"><table class="chart-grid pt-pivot"><thead><tr><th>项目</th><th>单位</th>${dates.map(d => `<th>${esc(d)}</th>`).join('')}</tr></thead>
      <tbody>${tests.map(t => `<tr data-trend="${esc(t.test_key)}"><td>${esc(t.test_name)}</td><td class="muted">${unitOf(t.test_key)}</td>${dates.map(d => cell(t.test_key, d)).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="muted small">只显示已确认的化验，最近 12 个检查日；同一天多次显示最新一次（×N，悬停看每次）。${anyConverted ? '带 * 的是从其他单位换算的（悬停看原值）。' : ''}点一行看趋势。</div><div id="ptTrend"></div>`
  }

  /** 病例报告历史：「写病例报告」新建的文档都关联在这里，新的在前。 */
  function docsView(d: Detail): string {
    const KINDS: Record<string, string> = { case_report: '病例报告', followup: '随访小结', discussion: '病例讨论', other: '文档' }
    return `<div class="row"><span class="muted small">依据这位患者已确认的数据写的报告都保存在这里；每份报告在文档里也有自己的版本历史。</span><span class="grow"></span><button class="primary" data-act="report">写新的病例报告</button></div>
      ${d.documents.length === 0 ? '<div class="muted pt-empty">还没有病例报告。</div>' : `<table class="users"><thead><tr><th>标题</th><th>类型</th><th>作者</th><th>创建</th><th>最近修改</th><th></th></tr></thead><tbody>
      ${d.documents.map(x => `<tr><td><b>${esc(x.title)}</b></td><td>${esc(KINDS[x.kind] ?? x.kind)}</td><td>${esc(x.author)}</td>
        <td class="muted">${new Date(x.linked_at).toLocaleString('zh-CN', { hour12: false })}</td><td class="muted">${new Date(x.updated_at).toLocaleString('zh-CN', { hour12: false })}</td>
        <td class="actions">${x.can_open ? `<button data-opendoc="${x.doc_id}">打开</button>` : '<span class="muted small">只有作者能打开</span>'}</td></tr>`).join('')}</tbody></table>`}`
  }

  function recordsView(d: Detail): string {
    const imagingRecords = d.records.filter(r => r.kind === 'imaging')
    const otherRecords = d.records.filter(r => r.kind !== 'imaging')

    if (d.records.length === 0) return `<div class="muted">还没有影像或报告。点击上方「${icon('scan')} 影像分析」量化 CT/MRI，或「上传化验单 / 报告」。</div>`
    const STATUS: Record<string, string> = { pending: '待确认', confirmed: '已确认', rejected: '已驳回' }
    const EXTRACT: Record<string, string> = { queued: '排队提取', running: '提取中…', done: '', failed: '提取失败', skipped: '' }

    const scanRecords = d.records.filter(r => r.kind === 'imaging' && r.imaging_data?.model_id !== 'recist_longitudinal_comparator')
    const hasMultiImaging = scanRecords.length >= 2

    // 检查是否有任何影像存在高危征象 (HAM 或结节 > 8mm)
    const anyHamRec = scanRecords.find(r => {
      const imgD = (r.imaging_data || {}) as Record<string, any>
      const m = (imgD.metrics || imgD.raw_metrics || {}) as Record<string, any>
      return Boolean(m.high_attenuation_mucus || (m.ham_max_hu && m.ham_max_hu > 70) || (m.high_attenuation_mucus_cm3 && m.high_attenuation_mucus_cm3 > 0))
    })
    const anyNoduleRec = scanRecords.find(r => {
      const imgD = (r.imaging_data || {}) as Record<string, any>
      const nm = (imgD.metrics || imgD.raw_metrics || {}) as Record<string, any>
      const isNeg = nm.has_lesion === false || (nm.longest_diameter_mm === 0)
      return !isNeg && Boolean(nm.longest_diameter_mm && nm.longest_diameter_mm >= 8)
    })
    const igeLab = d.latest_labs.find(l => l.test_key === 'ige' || l.test_name.includes('IgE'))

    let sectionAlertBanner = ''
    if (anyHamRec) {
      sectionAlertBanner = `
        <div class="pt-proactive-banner alert-ham" style="margin-top: 10px">
          <div class="pt-proactive-main">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
              <span class="pt-proactive-pill medium">影像所见</span>
              <span class="muted small">高密度粘液栓 · 算法测得 CT 值 &gt; 70 HU</span>
            </div>
            <div style="font-weight: 600; font-size: 13.5px; color: #FCA5A5; margin-bottom: 4px">
              算法测得支气管管腔高密度粘液栓
            </div>
            <div class="muted small" style="line-height: 1.5; color: var(--text-1)">
              量化记录显示管腔内粘液栓 CT 值高于 70 HU${igeLab ? `；近期总 IgE ${igeLab.value_num ?? igeLab.std_value} ${igeLab.unit || 'kU/L'}` : ''}。上述所见需结合临床与实验室检查判断。
            </div>
          </div>
          <div class="pt-proactive-actions">
            <button class="primary small-btn" data-generate-full-report="${anyHamRec.id}">${icon('report')} 生成影像所见报告</button>
            <button class="small-btn quiet" data-open-evidence="${anyHamRec.id}">${icon('evidence')} 查看指标对照</button>
          </div>
        </div>
      `
    } else if (anyNoduleRec) {
      const imgD = (anyNoduleRec.imaging_data || {}) as Record<string, any>
      const nm = (imgD.metrics || imgD.raw_metrics || {}) as Record<string, any>
            const radsDesc = `长径 ${nm.longest_diameter_mm} mm（≥ 8 mm）`
      sectionAlertBanner = `
        <div class="pt-proactive-banner alert-nodule" style="margin-top: 10px">
          <div class="pt-proactive-main">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
              <span class="pt-proactive-pill medium">${icon('info')} 结节测量</span>
              <span class="muted small">${radsDesc}</span>
            </div>
            <div style="font-weight: 600; font-size: 13.5px; color: #FDE68A; margin-bottom: 4px">
              算法测得结节，长径 ${nm.longest_diameter_mm} mm
            </div>
            <div class="muted small" style="line-height: 1.5; color: var(--text-1)">
              量化记录：长径 ${nm.longest_diameter_mm} mm，三维体积 ${nm.total_volume_cm3 ?? '--'} cm³。上述所见需结合临床与实验室检查判断。
            </div>
          </div>
          <div class="pt-proactive-actions">
            <button class="primary small-btn" data-generate-full-report="${anyNoduleRec.id}">${icon('report')} 生成影像所见报告</button>
            <button class="small-btn quiet" data-open-evidence="${anyNoduleRec.id}">${icon('evidence')} 查看指标对照</button>
          </div>
        </div>
      `
    }

    const imagingHtml = imagingRecords.length ? `
      <div class="pt-imaging-section">
        <div class="row pt-section-head">
          <h3 class="mem-h" style="margin: 0">${icon('scan')} 医学影像量化档案 (MONAI 3D Quantitative Imaging)</h3>
          <span class="muted small">${imagingRecords.length} 份分析记录</span>
          <span class="grow"></span>
          <div style="display: flex; gap: 8px; align-items: center">
            ${hasMultiImaging ? `<button class="quiet small-btn" data-act="compare-imaging" title="对比多期影像并计算 RECIST 1.1 靶病灶长径变化率与疗效评级">${icon('compare')} 随访疗效 (RECIST 1.1)</button>` : ''}
            <button class="quiet small-btn" data-open-mpr="latest" title="打开 3D 多平面重建 (MPR) 互动切片浏览器：在轴位/冠状位/矢状位平滑滑动连续切片">${icon('mpr')} 3D MPR 互动切片</button>
            <button class="quiet small-btn" data-open-evidence="latest" title="查看多模态因果诊断链 (影像 + 化验 + 病史)">${icon('evidence')} 因果诊断链</button>
            <button class="primary small-btn" data-act="imaging">＋ 新建影像量化分析</button>
          </div>
        </div>
        ${sectionAlertBanner}
        ${hasMultiImaging ? `
          <div class="pt-imaging-recist-banner">
            <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
              <span class="pt-imaging-badge" style="background: rgba(16,185,129,0.18); color: #34D399; font-weight: 700; padding: 4px 10px; border-radius: 4px">
                ${icon('compare')} RECIST 1.1 纵向对比就绪
              </span>
              <span style="font-size: 13px; color: var(--text)">
                检测到患者已有 <b>${scanRecords.length}</b> 份纵向影像记录，支持基线与多期随访疗效自动对比评估。
              </span>
              <span class="grow"></span>
              <button class="primary small-btn" data-act="compare-imaging" title="对比基线与最新随访影像，自动计算 RECIST 1.1 靶病灶长径变化率与疗效评级">
                ${icon('chart')} 多期影像随访对比 (RECIST 1.1)
              </button>
            </div>
          </div>
        ` : ''}
        <div class="pt-imaging-grid">
          ${imagingRecords.map(r => {
            const data = r.imaging_data || {}
            const m = data.metrics || {}
            const aid = data.asset_id
            const sliceFid = data.file_id
            const rawFid = data.raw_file_id || (r.file_id && r.file_id !== sliceFid ? r.file_id : null)
            const imgUrl = aid
              ? `/api/assets/${aid}?token=${encodeURIComponent(hooks.token())}`
              : (sliceFid && sliceFid !== rawFid)
              ? `/api/patients/${d.id}/files/${sliceFid}?token=${encodeURIComponent(hooks.token())}`
              : ''
            const rawFileName = data.raw_file_name || (rawFid ? 'scan.nii.gz' : '')
            const rawSizeText = data.raw_file_size ? `${(data.raw_file_size / (1024 * 1024)).toFixed(1)} MB` : ''
            const isBronchiectasis = data.model_id === 'bronchiectasis_mucus_analyzer' || r.title.includes('支气管')
            return `
              <div class="pt-imaging-card" data-rec="${r.id}">
                <div class="pt-imaging-thumb-wrap" ${imgUrl ? `data-view-img="${imgUrl}" title="点击查看切片大图"` : ''}>
                  ${imgUrl ? `<img src="${imgUrl}" alt="${esc(r.title)}" class="pt-imaging-thumb" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex'"><div class="pt-imaging-no-img" style="display:none">暂无预览</div>` : '<div class="pt-imaging-no-img">暂无预览</div>'}
                  <span class="pt-imaging-badge-overlay">${esc(data.modality || (data.model_id === 'recist_longitudinal_comparator' ? 'RECIST 1.1' : 'CT'))}</span>
                </div>
                <div class="pt-imaging-content">
                  <div class="pt-imaging-head">
                    <div class="pt-imaging-title">
                      <b>${esc(r.title)}</b>
                      ${rawFileName ? `<span class="pt-imaging-badge" title="原始 3D 扫描文件已加密保存在该患者档案中">${icon('lock')} ${esc(rawFileName)}</span>` : ''}
                    </div>
                    <span class="muted small">${esc(r.report_date || r.created_at.slice(0, 10))}</span>
                  </div>
                  <div class="pt-imaging-metrics">
                    ${data.model_id === 'recist_longitudinal_comparator' ? `
                      <span class="pt-imaging-badge" style="background: rgba(16,185,129,0.18); color: #34D399; font-weight: 700">${icon('compare')} 随访测量对比 · RECIST ${m.recist_category && m.recist_category !== 'NA' ? `${esc(m.recist_category)}（未经阅片确认）` : '不适用'}</span>
                      <span class="pt-imaging-pill ${m.recist_category === 'PR' || m.recist_category === 'CR' ? 'ok' : m.recist_category === 'PD' ? 'alert' : ''}">长径变化: ${m.percent_change_ld > 0 ? `+${m.percent_change_ld}%` : `${m.percent_change_ld}%`}</span>
                      <span class="pt-imaging-pill">体积变化: ${m.percent_change_volume > 0 ? `+${m.percent_change_volume}%` : `${m.percent_change_volume}%`}</span>
                      ${m.vdt ? `<span class="pt-imaging-pill ${m.vdt.clinical_alert ? 'alert' : 'ok'}">VDT: ${m.vdt.days !== null ? `${m.vdt.days} 天` : esc(m.vdt.label)}</span>` : ''}
                    ` : isBronchiectasis ? `
                      ${m.bar_ratio ? `<span class="pt-imaging-pill ${m.signet_ring_sign ? 'alert' : 'ok'}">BAR: ${m.bar_ratio}${m.signet_ring_sign ? '（> 1.10）' : ''}</span>` : ''}
                      ${m.total_mucus_volume_cm3 !== undefined ? `<span class="pt-imaging-pill">粘液栓体积: ${m.total_mucus_volume_cm3} cm³</span>` : ''}
                      ${m.high_attenuation_mucus_cm3 ? `<span class="pt-imaging-pill alert">高密度粘液栓: ${m.high_attenuation_mucus_cm3} cm³</span>` : ''}
                      ${m.airway_occlusion_rate_pct !== undefined ? `<span class="pt-imaging-pill">管腔阻塞率: ${m.airway_occlusion_rate_pct}%</span>` : ''}
                      ${m.wall_to_lumen_ratio ? `<span class="pt-imaging-pill">管壁/管腔比: ${m.wall_to_lumen_ratio}</span>` : ''}
                      ${m.primary_location || m.distribution_summary ? `
                        <div class="pt-imaging-location-row" style="margin-top: 6px; font-size: 12px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                          <span style="font-weight: 600; color: var(--text)">${icon('target')} 解剖定位:</span>
                          <span class="pt-imaging-badge" style="background: rgba(56,189,248,0.12); color: var(--blue); border-color: rgba(56,189,248,0.3)">${esc(m.primary_location || m.distribution_summary)}</span>
                          ${m.mucus_nodule_locations && m.mucus_nodule_locations.length > 0 ? `
                            <span class="muted small">(${m.mucus_nodule_locations.length} 个主要嵌顿团簇 · 范围 ${esc(m.mucus_nodule_locations[0].slice_range)})</span>
                          ` : ''}
                        </div>
                      ` : ''}
                    ` : `
                      ${m.has_lesion === false || (m.longest_diameter_mm === 0) ? `
                        <span class="pt-imaging-pill ok">算法未检出可测量结节</span>
                      ` : `
                        ${m.nodule_type_zh ? `<span class="pt-imaging-badge" style="background: rgba(147, 51, 234, 0.15); color: #c084fc; border: 1px solid rgba(147, 51, 234, 0.3)">${esc(m.nodule_type_zh)}</span>` : ''}
                        ${m.longest_diameter_mm ? `<span class="pt-imaging-pill alert">长径: ${m.longest_diameter_mm} mm</span>` : ''}
                        ${m.solid_core_diameter_mm ? `<span class="pt-imaging-pill" style="border-color: rgba(251, 146, 60, 0.4); color: #fb923c">实性核心: ${m.solid_core_diameter_mm} mm${typeof m.consolidation_tumor_ratio === 'number' ? ` (CTR ${Math.round(m.consolidation_tumor_ratio * 100)}%)` : ''}</span>` : ''}
                        ${m.short_axis_mm ? `<span class="pt-imaging-pill">短径: ${m.short_axis_mm} mm</span>` : ''}
                        ${m.total_volume_cm3 ? `<span class="pt-imaging-pill">3D 体积: ${m.total_volume_cm3} cm³</span>` : ''}
                        ${m.key_slice_index !== undefined ? `<span class="pt-imaging-pill">最大截面: #${m.key_slice_index} 层</span>` : ''}
                      `}
                    `}
                  </div>
                  ${r.extraction_note ? `<div class="pt-imaging-note muted small">${esc(r.extraction_note)}</div>` : ''}
                  <div class="pt-imaging-actions">
                    <button class="primary small-btn" data-generate-full-report="${r.id}" title="生成影像量化所见报告（只列实测值与相关化验，不含诊断结论；AI 生成的存为待医生确认的草稿）">${icon('report')} 影像所见报告</button>
                    ${data.model_id !== 'recist_longitudinal_comparator' ? `<button class="small-btn quiet" data-open-mpr="${r.id}" title="打开 3D 多平面重建 (MPR) 互动浏览器：实时滑动轴位/冠状位/矢状位连续切片、切换窗宽窗位并定位病灶">${icon('mpr')} 3D 切片 (MPR)</button>` : ''}
                    <button class="small-btn quiet" data-open-evidence="${r.id}" title="查看多模态因果诊断链 (影像 + 化验 + 病史)">${icon('evidence')} 因果诊断链</button>
                    <button class="small-btn quiet" data-export-standard="${r.id}" title="导出 HL7 FHIR 或 DICOM SR 标准医学交换格式">${icon('download')} 导出标准数据</button>
                    ${hasMultiImaging && data.model_id !== 'recist_longitudinal_comparator' ? `<button class="small-btn quiet" data-compare-with="${r.id}" title="以该影像为基准进行 RECIST 1.1 多期随访对比">${icon('compare')} 随访对比</button>` : ''}
                    <button class="small-btn quiet" data-img-report="${r.id}" title="自动创建文档并由 AI 撰写 CARE 准则病例报告，插入该影像量化指标与关键截面图">${icon('write')} 写影像病例报告</button>
                    <button class="small-btn" data-img-canvas="${r.id}" title="在 Heurion 原生幻灯片工作台制作包含此影像指标的多页会诊 Slide (PPTX)">${icon('deck')} 制作会诊 Slide</button>
                    ${imgUrl ? `<button class="quiet small-btn" data-view-img="${imgUrl}">${icon('eye')} 查看量化切片</button>` : ''}
                    ${rawFid ? `<a class="quiet small-btn" href="/api/patients/${d.id}/files/${rawFid}?token=${encodeURIComponent(hooks.token())}" target="_blank" download="${esc(rawFileName)}" title="下载该患者已归档的原始 3D 序列扫描文件">${icon('download')} 下载 3D 原卷${rawSizeText ? ` (${esc(rawSizeText)})` : ''}</a>` : ''}
                  </div>
                </div>
              </div>`
          }).join('')}
        </div>
      </div>
    ` : ''

    const otherHtml = otherRecords.length ? `
      <div class="pt-other-records-section">
        <h3 class="mem-h" style="margin-top: ${imagingRecords.length ? '24px' : '0'}">${icon('report')} 检验报告与病历文书</h3>
        <table class="users"><thead><tr><th>报告日期</th><th>类型</th><th>标题</th><th>状态</th><th></th></tr></thead><tbody>
          ${otherRecords.map(r => `<tr data-rec="${r.id}"><td>${esc(r.report_date ?? '—')}</td><td>${esc(KIND[r.kind] ?? r.kind)}</td>
            <td>${esc(r.title)}${r.extraction_note ? `<div class="muted small">${esc(r.extraction_note)}</div>` : ''}</td>
            <td><span class="pill ${r.status === 'confirmed' ? 'ok' : 'off'}">${STATUS[r.status]}</span>${aiDraftBadge(r)} <span class="muted small">${EXTRACT[r.extraction ?? ''] ?? ''}</span></td>
            <td class="actions">${r.file_id ? `<button data-file="${r.file_id}">原件</button>` : ''}</td></tr>`).join('')}
        </tbody></table>
      </div>
    ` : ''

    return imagingHtml + otherHtml
  }

  /** 待确认页：展开 AI 报告草稿时载入全文（只载入一次） */
  document.addEventListener('toggle', e => {
    const box = e.target as HTMLElement
    if (!(box instanceof HTMLDetailsElement) || !box.open || !box.dataset.aiPreview || box.dataset.loaded) return
    const body = box.querySelector<HTMLElement>('.pt-ai-preview-body')
    const pid = current
    if (!body || !pid) return
    box.dataset.loaded = '1'
    api<{ text: string | null }>(`/api/patients/${pid}/records/${box.dataset.aiPreview}/text`)
      .then(r => { body.textContent = r.text ?? '（这份报告没有文字内容）' })
      .catch(err => { body.textContent = `载入失败：${(err as Error).message}`; delete box.dataset.loaded })
  }, true)

  /** AI 生成的报告草稿标识：须医生本人确认后才进入病历（AI 不能确认） */
  function aiDraftBadge(r: RecordRow): string {
    if (r.origin !== 'ai_report') return ''
    return r.status === 'pending' ? ' <span class="pill warn" title="AI 生成的报告草稿，须医生本人核对后确认">AI 草稿 · 待医生确认</span>' : ' <span class="pill" title="AI 生成、已由医生确认">AI 生成</span>'
  }

  function reviewView(d: Detail, labs: Lab[], canEdit: boolean): string {
    const pendingRecs = d.records.filter(r => r.status === 'pending')
    if (pendingRecs.length === 0 && d.pending_proposals.length === 0) return '<div class="muted">没有待确认的内容。</div>'
    const fileUrl = (fid: string) => `/api/patients/${d.id}/files/${fid}?token=${encodeURIComponent(hooks.token())}`
    const recHtml = pendingRecs.map(r => {
      const rows = labs.filter(l => l.record_id === r.id && l.status === 'pending')
      const busy = r.extraction === 'queued' || r.extraction === 'running'
      return `<div class="pt-review" data-rec="${r.id}">
        <div class="pt-review-file">${r.file_id ? `<iframe title="原件" src="${fileUrl(r.file_id)}"></iframe><a href="${fileUrl(r.file_id)}" target="_blank" rel="noreferrer" class="small">在新标签页打开原件</a>` : ''}</div>
        <div class="pt-review-data">
          <div class="row"><b>${esc(r.title)}</b>${aiDraftBadge(r)}<span class="muted small">${esc(KIND[r.kind] ?? r.kind)}</span><span class="grow"></span>
            <label class="small">报告日期 <input type="date" class="pt-date" value="${esc(r.report_date ?? '')}" ${canEdit ? '' : 'disabled'}></label></div>
          ${busy ? '<div class="muted">正在提取，稍候…</div>' : r.extraction_note ? `<div class="muted small">${esc(r.extraction_note)}</div>` : ''}
          ${r.origin === 'ai_report' ? `<details class="pt-ai-preview" data-ai-preview="${r.id}">
            <summary><span class="pill warn">AI 草稿 · 待医生确认</span> 展开查看全文（确认或驳回前请核对）</summary>
            <div class="pt-ai-preview-body" style="white-space: pre-wrap; font-size: 12.5px; line-height: 1.6; max-height: 480px; overflow: auto; padding: 10px; border: 1px solid var(--line); border-radius: 6px; margin-top: 6px">正在载入…</div>
          </details>` : ''}
          ${rows.length ? `<table class="chart-grid pt-edit"><thead><tr><th>项目</th><th>结果</th><th>单位</th><th>参考低</th><th>参考高</th><th>页</th><th></th></tr></thead><tbody>
            ${rows.map(l => `<tr data-lab="${l.id}" class="${l.locator?.verified === false ? 'pt-unverified' : ''}">
              <td><input data-f="test_name" value="${esc(l.test_name)}" ${canEdit ? '' : 'disabled'}></td><td><input data-f="value" value="${esc(value(l))}" ${canEdit ? '' : 'disabled'}></td>
              <td><input data-f="unit" value="${esc(l.unit ?? '')}" ${canEdit ? '' : 'disabled'}></td><td><input data-f="ref_low" value="${esc(l.ref_low ?? '')}" ${canEdit ? '' : 'disabled'}></td>
              <td><input data-f="ref_high" value="${esc(l.ref_high ?? '')}" ${canEdit ? '' : 'disabled'}></td><td class="muted">${l.locator?.page ?? ''}${l.locator?.verified === false ? ` <span title="原文里没找到这个数，请对照原件">${icon('warning', { size: 11 })}</span>` : ''}</td>
              <td>${canEdit ? '<button class="quiet small-btn" data-labx="reject" title="删除这一项">✕</button>' : ''}</td></tr>
              ${l.same_day?.length ? `<tr class="pt-sameday" data-lab="${l.id}"><td colspan="7">同一天已确认：${l.same_day.map(o => `${esc(stdValue(o))} ${esc(o.std_unit ?? '')}${o.collected_at ? `（${esc(o.collected_at.slice(11))}）` : ''}`).join('、')}
                ${canEdit ? `<select data-replaces><option value="">两个都保留</option>${l.same_day.map(o => `<option value="${o.id}"${l.replaces === o.id ? ' selected' : ''}>这是更正：替换 ${esc(stdValue(o))}</option>`).join('')}</select>` : ''}</td></tr>` : ''}`).join('')}</tbody></table>` : busy ? '' : '<div class="muted small">没有提取到化验项。</div>'}
          ${canEdit && !busy ? '<button class="quiet small-btn" data-recx="addrow" title="自动提取漏了某项，或不能自动提取时：对照左边的原件补上">＋ 对照原件补一项</button>' : ''}
          ${canEdit && !busy ? '<div class="row end"><button class="danger" data-recx="reject">驳回整份</button><button class="primary" data-recx="confirm">确认这份报告</button></div>' : ''}
        </div></div>`
    }).join('')
    const props = d.pending_proposals.map(p => `<li class="mem" data-prop="${p.id}"><div class="mem-text"><span class="mem-kind">AI 提议</span>${esc(p.kind === 'lab' ? `化验：${p.payload.test_name} ${p.payload.value} ${p.payload.unit ?? ''}（${p.payload.collected_on}）` : p.kind === 'tag' ? `诊断标签：${p.payload.tag}` : p.kind === 'enroll' ? `入组研究「${p.payload.study_title}」` : p.kind === 'unenroll' ? `移出研究「${p.payload.study_title}」（${p.payload.subject_id}）` : p.kind === 'update' ? `修改患者信息：${Object.keys(p.payload).join('、')}` : `摘要补充：${p.payload.text}`)}</div>
        <div class="muted small">依据：${esc(p.reason)}</div>${canEdit ? '<div class="actions-row"><button class="primary" data-propx="accept">采纳</button><button data-propx="reject">不采纳</button></div>' : ''}</li>`).join('')
    return recHtml + (props ? `<h3 class="mem-h">AI 的提议</h3><ul class="mem-list">${props}</ul>` : '')
  }

  /** 趋势：一条折线 + 参考范围色带（SVG）。 */
  async function showTrend(key: string, after: HTMLElement): Promise<void> {
    const all = (await api<Lab[]>(`/api/patients/${current}/labs?tests=${encodeURIComponent(key)}`)).filter(l => l.std_value !== null && l.collected_on)
    document.getElementById('ptTrendBox')?.remove()
    // 单位无法换算的点不画（和其他次不可比），在图下说明
    const labs = all.filter(l => !l.unknown_unit)
    const skipped = all.length - labs.length
    if (labs.length === 0) return
    const W = 560, H = 180, P = 36
    const t = (l: Lab) => Date.parse((l.collected_at ?? l.collected_on!).replace(' ', 'T'))
    const xs = labs.map(t), ys = labs.map(l => l.std_value!)
    const lows = labs.map(l => l.std_ref_low).filter((v): v is number => v !== null), highs = labs.map(l => l.std_ref_high).filter((v): v is number => v !== null)
    const lo = Math.min(...ys, ...lows), hi = Math.max(...ys, ...highs)
    const pad = (hi - lo) * 0.15 || 1
    const [y0, y1] = [lo - pad, hi + pad]
    const x = (ts: number) => xs.length === 1 || xs.at(-1) === xs[0] ? W / 2 : P + (ts - xs[0]!) / (xs.at(-1)! - xs[0]!) * (W - 2 * P)
    const y = (v: number) => H - P / 2 - (v - y0) / (y1 - y0) * (H - P)
    // 参考范围色带：每段用该段起点那次化验的参考范围（不同医院范围不同）
    const seg = (l: Lab, x0: number, x1: number) => l.std_ref_low === null && l.std_ref_high === null ? ''
      : `<rect x="${x0}" width="${Math.max(2, x1 - x0)}" y="${y(l.std_ref_high ?? y1)}" height="${y(l.std_ref_low ?? y0) - y(l.std_ref_high ?? y1)}" class="trend-band"/>`
    const band = labs.length === 1 ? seg(labs[0]!, P, W - P) : labs.slice(0, -1).map((l, i) => seg(l, x(xs[i]!), x(xs[i + 1]!))).join('') + seg(labs.at(-1)!, x(xs.at(-1)!) - 1, W - P)
    const pts = labs.map(l => `${x(t(l))},${y(l.std_value!)}`).join(' ')
    const box = document.createElement('div')
    box.id = 'ptTrendBox'
    box.className = 'pt-trend'
    box.innerHTML = `<div class="row"><b>${esc(labs[0]!.test_name)}</b><span class="muted small">${esc(labs[0]!.std_unit ?? '')}${labs.some(l => l.converted) ? ' · 部分数值已从其他单位换算' : ''} · 色带为各次报告的参考范围</span><span class="grow"></span><button class="quiet small-btn" data-trend-close>✕</button></div>
      <svg viewBox="0 0 ${W} ${H}" class="trend-svg">${band}<polyline points="${pts}" class="trend-line"/>
        ${labs.map(l => `<circle cx="${x(t(l))}" cy="${y(l.std_value!)}" r="3.5" class="trend-dot flag-${l.flag ?? 'n'}"><title>${esc(when(l))}：${l.std_value} ${esc(l.std_unit ?? '')}${l.converted ? `（原值 ${l.value_num} ${esc(l.unit ?? '')}）` : ''}</title></circle>
          <text x="${x(t(l))}" y="${y(l.std_value!) - 8}" class="trend-label">${l.std_value}</text>`).join('')}
        <text x="${P}" y="${H - 4}" class="trend-axis">${esc(labs[0]!.collected_on)}</text><text x="${W - P}" y="${H - 4}" class="trend-axis" text-anchor="end">${esc(labs.at(-1)!.collected_on)}</text></svg>
      ${skipped ? `<div class="muted small">另有 ${skipped} 次的单位无法换算，没有画进趋势（见化验表）。</div>` : ''}`
    after.after(box)
  }

  /** 写病例报告：新建文档并关联到患者，打开后把建议的指令填进对话框（不自动发送，由医生改好后自己发送）。 */
  async function writeReport(d: Patient): Promise<void> {
    try {
      const doc = await api<{ id: string }>('/api/docs', { method: 'POST', body: JSON.stringify({ title: `${d.code} 病例报告 ${new Date().toLocaleDateString('sv-SE')}` }) })
      await api(`/api/patients/${d.id}/docs`, { method: 'POST', body: JSON.stringify({ doc_id: doc.id, kind: 'case_report' }) })
      current = null
      await hooks.openDoc(doc.id)
      hooks.prefillChat(`请依据患者 ${d.code} 的已确认数据写一份病例报告（参考 CARE 指南：病史、检查、诊断、治疗与随访、讨论）。化验值写明日期并标出异常；只用代号或去标识写法，不写姓名；数据里没有的内容留「待补充」，不要编造。需要时画关键化验的趋势图。`)
      notice('已新建病例报告并关联到患者。对话框里填好了建议的指令，可以修改后点「发送」')
    } catch (err) { notice((err as Error).message, true) }
  }

  /** 基于影像分析记录一键写病例报告：创建文档，关联患者，自动在 AI 对话框预填影像指标与关键截面插图 */
  async function writeImagingReport(d: Patient | Detail, r: RecordRow): Promise<void> {
    try {
      const doc = await api<{ id: string }>('/api/docs', {
        method: 'POST',
        body: JSON.stringify({ title: `${d.code} 影像病例报告 ${r.report_date || new Date().toISOString().slice(0, 10)}` })
      })
      await api(`/api/patients/${d.id}/docs`, { method: 'POST', body: JSON.stringify({ doc_id: doc.id, kind: 'case_report' }) })
      current = null
      await hooks.openDoc(doc.id)

      const imgData = r.imaging_data || {}
      const m = imgData.metrics || {}
      const assetId = imgData.asset_id
      const isBronchiectasis = imgData.model_id === 'bronchiectasis_mucus_analyzer' || r.title.includes('支气管')

      let promptText = `请依据患者 ${d.code} 的已确认数据及最新医学影像量化分析结果写一份专业病例报告（参考 CARE 临床病例报告指南与 Fleischner 学会准则）：\n\n`
      promptText += `【影像检查信息】\n`
      promptText += `- 检查名称：${r.title}\n`
      promptText += `- 检查日期：${r.report_date || '近期'}\n`
      if (assetId) {
        promptText += `- 关键截面插图：![${r.title}](/api/assets/${assetId})\n`
      }
      promptText += `\n【核心量化指标】\n`
      if (isBronchiectasis) {
        if (m.bar_ratio) promptText += `- 支气管-伴行动脉比 (BAR): ${m.bar_ratio} (${m.signet_ring_sign ? '> 1.10' : '≤ 1.10'})\n`
        if (m.total_mucus_volume_cm3 !== undefined) promptText += `- 气道粘液栓总体积: ${m.total_mucus_volume_cm3} cm³\n`
        if (m.high_attenuation_mucus_cm3) promptText += `- 高密度粘液栓 (HAM) 体积: ${m.high_attenuation_mucus_cm3} cm³\n`
        if (m.airway_occlusion_rate_pct !== undefined) promptText += `- 气道管腔阻塞率: ${m.airway_occlusion_rate_pct}%\n`
        if (m.wall_to_lumen_ratio) promptText += `- 管壁增厚比 (Wall/Lumen): ${m.wall_to_lumen_ratio}\n`
        if (m.primary_location) promptText += `- 粘液栓主要解剖位置: ${m.primary_location}\n`
        if (m.distribution_summary) promptText += `- 优势分布肺叶: ${m.distribution_summary}\n`
        if (m.mucus_nodule_locations && m.mucus_nodule_locations.length > 0) {
          promptText += `- 主要粘液结节/栓塞详情:\n`
          m.mucus_nodule_locations.slice(0, 3).forEach((n: any, idx: number) => {
            promptText += `  ${idx + 1}. ${n.location_name} (${n.zone_type}) · 切片: ${n.slice_range} · 体积: ${n.volume_cm3} cm³ (CT: ${n.mean_hu} HU)\n`
          })
        }
      } else {
        if (m.longest_diameter_mm) promptText += `- RECIST 1.1 靶病灶最大横截面长径: ${m.longest_diameter_mm} mm\n`
        if (m.short_axis_mm) promptText += `- 垂直短径: ${m.short_axis_mm} mm\n`
        if (m.total_volume_cm3) promptText += `- 3D 病灶总体积: ${m.total_volume_cm3} cm³\n`
        if (m.key_slice_index !== undefined) promptText += `- 最大横截面层号: 第 #${m.key_slice_index} 层\n`
      }
      if (r.extraction_note) promptText += `- 征象摘要: ${r.extraction_note}\n`
      promptText += `\n请按照病史摘要、影像表现与量化分析、诊断结论、鉴别诊断及下一步临床随访治疗方案展开撰写。只用患者代号 ${d.code}，不写姓名。`

      hooks.prefillChat(promptText)
      notice('已新建影像病例报告并关联到患者。AI 对话框已准备好包含量化指标与切片插图的指令，可直接确认发送。')
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  /** 基于影像分析记录直接在 Heurion 原生工作台创建多页会诊幻灯片 (kind='deck') 并关联患者 */
  async function makeImagingSlideDeck(d: Patient | Detail, r: RecordRow): Promise<void> {
    try {
      const title = `${d.code} 影像会诊幻灯片 ${r.report_date || new Date().toISOString().slice(0, 10)}`
      const doc = await api<{ id: string }>('/api/docs', {
        method: 'POST',
        body: JSON.stringify({ title, kind: 'deck' })
      })
      await api(`/api/patients/${d.id}/docs`, {
        method: 'POST',
        body: JSON.stringify({ doc_id: doc.id, kind: 'presentation' })
      })
      current = null
      await hooks.openDoc(doc.id)

      const imgData = r.imaging_data || {}
      const m = imgData.metrics || {}
      const assetId = imgData.asset_id
      const isBronchiectasis = imgData.model_id === 'bronchiectasis_mucus_analyzer' || r.title.includes('支气管')

      let promptText = `请依据患者 ${d.code} 的医学影像量化分析数据，为当前会诊幻灯片（标题：${title}）制作多页专业幻灯片：\n\n`
      promptText += `【影像检查信息】\n`
      promptText += `- 检查项目：${r.title}\n`
      promptText += `- 检查日期：${r.report_date || '近期'}\n`
      if (assetId) {
        promptText += `- 关键截面图（已入库资产）：![${r.title}](/api/assets/${assetId})\n`
      }
      promptText += `\n【核心量化指标】\n`
      if (isBronchiectasis) {
        if (m.bar_ratio) promptText += `- BAR 印戒征比值: ${m.bar_ratio} (${m.signet_ring_sign ? '> 1.10' : '≤ 1.10'})\n`
        if (m.total_mucus_volume_cm3 !== undefined) promptText += `- 气道粘液栓总体积: ${m.total_mucus_volume_cm3} cm³ (阻塞率: ${m.airway_occlusion_rate_pct}%)\n`
        if (m.high_attenuation_mucus_cm3) promptText += `- 高密度粘液栓 HAM: ${m.high_attenuation_mucus_cm3} cm³\n`
        if (m.primary_location) promptText += `- 主要解剖部位: ${m.primary_location}\n`
        if (m.distribution_summary) promptText += `- 优势分布肺叶: ${m.distribution_summary}\n`
      } else {
        if (m.longest_diameter_mm) promptText += `- RECIST 1.1 靶病灶长径: ${m.longest_diameter_mm} mm (短径: ${m.short_axis_mm} mm)\n`
        if (m.total_volume_cm3) promptText += `- 3D 病灶体积: ${m.total_volume_cm3} cm³\n`
        if (m.key_slice_index !== undefined) promptText += `- 最大截面层号: 第 #${m.key_slice_index} 层\n`
      }
      promptText += `\n【建议幻灯片结构】\n`
      promptText += `1. 封面页：${d.code} 影像多学科会诊 (MDT)\n`
      promptText += `2. 临床指标与病灶测量页：三维容积、BAR 比值与管壁厚度对比\n`
      promptText += `3. 关键截面影像插图页：插入 /api/assets/${assetId || ''} 截面图并标注病灶解剖定位与阻塞率\n`
      promptText += `4. 讨论要点页：只列影像所见与待讨论问题，不写诊断结论与治疗方案（由会诊医师填写）\n\n`
      promptText += `请使用 deck_edit 工具按此结构生成或修改幻灯片各页内容。`

      hooks.prefillChat(promptText)
      notice('已在 Heurion 中新建会诊幻灯片并关联患者！AI 对话框已准备好制作指令，可直接确认发送。')
    } catch (err) {
      notice((err as Error).message, true)
    }
  }

  function showImageLightbox(imgUrl: string, title?: string): void {
    const dlg = document.getElementById('dialog')!
    dlg.innerHTML = `
      <div class="dialog-card pt-lightbox-card" role="dialog" aria-modal="true" style="max-width: 860px; background: #0b0f19; border-color: rgba(255,255,255,0.15)">
        <div class="dialog-head" style="border-bottom-color: rgba(255,255,255,0.1); color: #fff">
          <h2 style="color: #fff">${esc(title || '医学影像关键截面原图 (Key Slice · MONAI 量化标尺)')}</h2>
          <button class="quiet" data-close aria-label="关闭" style="color: #ccc">✕</button>
        </div>
        <div class="dialog-body" style="padding: 16px; display: flex; justify-content: center; align-items: center">
          <img src="${imgUrl}" style="max-width: 100%; max-height: 80vh; object-fit: contain; border-radius: 4px; box-shadow: 0 8px 32px rgba(0,0,0,0.6)">
        </div>
      </div>`
    dlg.hidden = false
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) close() }
  }

  async function showImagingDialog(patientId: string, d: Detail | Patient): Promise<void> {
    const dlg = document.getElementById('dialog')!
    dlg.innerHTML = `
      <div class="dialog-card pt-imaging-dialog" role="dialog" aria-modal="true" style="max-width: 680px">
        <div class="dialog-head">
          <h2>${icon('scan', { size: 18 })} ${esc(d.code)} 医学影像量化分析 (MONAI 3D)</h2>
          <button class="quiet" data-close aria-label="关闭">✕</button>
        </div>
        <div class="dialog-body" style="gap: 14px">
          <div class="pt-img-dlg-loading" style="padding: 24px; text-align: center; color: var(--text-2);">
            正在连接 MONAI 影像计算节点与加载临床模型...
          </div>
        </div>
      </div>`
    dlg.hidden = false
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) close() }

    let statusData: any = null
    let modelsData: any = { models: [] }
    let samplesData: any = { samples: [] }

    try {
      [statusData, modelsData, samplesData] = await Promise.all([
        api<any>('/api/imaging/status').catch(() => null),
        api<any>('/api/imaging/models').catch(() => ({ models: [] })),
        api<any>('/api/imaging/samples').catch(() => ({ samples: [] })),
      ])
    } catch {}

    const isHealthy = statusData && statusData.status === 'healthy'
    const devInfo = statusData?.device || {}
    const devName = isHealthy
      ? `${devInfo.accelerator || 'GPU / Metal 统一内存加速'}${devInfo.total_unified_ram_gb ? ` · ${devInfo.total_unified_ram_gb}GB 统一内存` : ''}`
      : '计算节点离线 (端口 8004 未连接)'

    const samples: Array<{ id: string; name: string; modality: string; size_mb?: number }> = samplesData.samples || []
    const modelsList: Array<{
      id: string
      name: string
      category?: string
      modality?: string
      target?: string
      recommended_window?: string
      engine_type?: string
      body_part?: string
      is_ready?: boolean
      unavailable_reason?: string | null
      compatible_samples?: string[]
    }> = [...(modelsData.models || []), ...(modelsData.planned_models || [])]

    const renderOption = (m: any, isSelected: boolean) => {
      const ready = m.is_ready !== false
      const modalityTag = `[${esc(m.modality || 'CT')}]`
      const selectedAttr = isSelected ? 'selected' : ''
      const disabledAttr = !ready ? 'disabled style="color: var(--text-muted)"' : ''
      return `
        <option value="${esc(m.id)}"
          data-engine="${esc(m.engine_type || 'deep_learning')}"
          data-body="${esc(m.body_part || 'chest')}"
          data-window="${esc(m.recommended_window || 'lung')}"
          data-target="${esc(m.target || '')}"
          data-ready="${ready ? 'true' : 'false'}"
          data-reason="${esc(m.unavailable_reason || '')}"
          data-samples="${esc((m.compatible_samples || []).join(','))}"
          ${selectedAttr}
          ${disabledAttr}>
          ${esc(m.name)} ${modalityTag} ${esc(modelOptionTag(m))}
        </option>`
    }

    const defaultDesc = modelsList.find(m => m.id === 'bronchiectasis_mucus_analyzer')?.target || '支气管-动脉径比 (BAR)、粘液栓容积、解剖肺叶肺段定位、树芽征'
    const devAccel = devInfo.accelerator || 'GPU / 硬件加速计算集群'

    const body = dlg.querySelector('.dialog-body')
    if (!body) return
    body.innerHTML = `
      <div class="pt-img-banner ${isHealthy ? 'ok' : 'warn'}">
        <span class="dot"></span>
        <div>
          <b>${isHealthy ? 'MONAI 医学影像计算引擎就绪' : '计算微服务离线'}</b>
          <div class="muted small">${esc(devName)}</div>
        </div>
      </div>

      <div class="field">
        <div class="row" style="justify-content: space-between; align-items: baseline; margin-bottom: 6px">
          <label><b>影像数据来源</b> <span class="muted small" style="font-weight: normal">（上传该患者的 CT/MR 影像文件）</span></label>
          <button type="button" class="quiet small" id="btnToggleDemoSample" style="font-size: 11.5px; color: var(--blue); cursor: pointer; padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--hover)">
            ${icon('scan', { size: 12 })} 暂无影像？载入演示样本快速体验
          </button>
        </div>

        <div id="imgUploadBox" style="margin-top: 4px">
          <label for="imgFileInput" style="display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px dashed var(--line-strong); padding: 18px 14px; border-radius: 6px; background: var(--hover); cursor: pointer; text-align: center">
            ${icon('upload', { size: 24, style: 'color: var(--blue); margin-bottom: 6px' })}
            <span style="font-size: 13px; font-weight: 500">点击选择或拖拽医学影像文件至此</span>
            <span class="muted small" style="margin-top: 4px">支持高分辨率序列：NIfTI (.nii, .nii.gz, .gz)、单个 DICOM (.dcm) 或整套 DICOM 序列压缩包 (.zip, .tar.gz)</span>
          </label>
          <input type="file" id="imgFileInput" accept=".nii,.nii.gz,.gz,.dcm,.dicom,.zip,.tar,.tar.gz,.tgz,application/gzip,application/x-gzip,application/zip,application/x-tar,application/octet-stream" style="display: none">
          <div id="imgUploadFileName" class="muted small" style="margin-top: 6px; display: none; color: var(--teal)"></div>
          <div class="muted small" style="margin-top: 6px; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; display: flex; align-items: flex-start; gap: 5px">
            ${icon('info', { size: 13, style: 'margin-top: 2px; color: var(--blue); flex-shrink: 0' })}
            <span><b>交互提示：</b>选定影像后，系统智能推荐适配专科。因 3D 影像体量大且消耗 GPU 算力，选定文件不会自动立即分析；请确认下方模型参数后，点击弹窗底部<b>「开始 MONAI 3D 量化推理」</b>按钮启动运算。</span>
          </div>
        </div>

        <div id="imgSampleBox" hidden style="margin-top: 4px; padding: 12px 14px; background: var(--hover); border: 1px solid var(--line); border-radius: 6px">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
            <span class="small" style="font-weight: 600; color: var(--text)">临床测试演示样本（一键体验）</span>
            <button type="button" class="quiet small" id="btnBackToUpload" style="font-size: 11.5px; color: var(--blue); text-decoration: underline; cursor: pointer; padding: 0">
              返回上传本地文件
            </button>
          </div>
          <select id="imgSampleSelect" class="pt-dlg-select" style="width: 100%; padding: 7px 10px" ${samples.length ? '' : 'disabled'}>
            ${samples.length ? samples.map((s, idx) => `
              <option value="${esc(s.id)}" ${idx === 0 ? 'selected' : ''}>
                ${esc(s.name)} [${esc(s.modality)}] ${s.size_mb ? `(${s.size_mb} MB)` : ''}
              </option>
            `).join('') : '<option value="" selected>影像服务没有列出可用的演示样本</option>'}
          </select>
          ${samples.length ? `<div class="pt-sample-chips" style="margin-top: 8px">
            <span class="muted small">快捷选择：</span>
            ${samples.slice(0, 9).map((s, idx) => `<button type="button" class="pt-sample-chip${idx === 0 ? ' active' : ''}" data-sid="${esc(s.id)}">${icon('scan', { size: 12 })} ${esc(s.name)}</button>`).join('')}
          </div>` : ''}
          <div class="muted small" style="margin-top: 6px; font-size: 11.5px">演示样本是公开数据集影像，不是该患者的影像；分析记录会标注「演示样本」。</div>
        </div>
      </div>

      <div class="field" style="margin-top: 12px">
        <div class="row" style="justify-content: space-between; align-items: baseline; margin-bottom: 6px">
          <label><b>选择临床影像分析算法与模型</b></label>
          <span class="muted small" id="imgModelCount">${modelsList.length || 19} 款专科模型就绪</span>
        </div>

        <div class="pt-specialty-tabs" id="imgSpecialtyTabs">
          <button type="button" class="pt-specialty-tab active" data-cat="auto">${icon('sparkles', { size: 12 })} 智能匹配</button>
          <button type="button" class="pt-specialty-tab" data-cat="chest">${icon('lung', { size: 12 })} 胸部与呼吸</button>
          <button type="button" class="pt-specialty-tab" data-cat="abdomen">${icon('abdomen', { size: 12 })} 腹部与泌尿</button>
          <button type="button" class="pt-specialty-tab" data-cat="brain">${icon('brain', { size: 12 })} 颅脑与心血管</button>
          <button type="button" class="pt-specialty-tab" data-cat="whole_body">${icon('bone', { size: 12 })} 全身与骨骼</button>
          <button type="button" class="pt-specialty-tab" data-cat="interactive">${icon('interactive', { size: 12 })} 交互式分割</button>
          <button type="button" class="pt-specialty-tab" data-cat="all">${icon('grid', { size: 12 })} 全部专科</button>
        </div>

        <select id="imgModelSelect" class="pt-dlg-select" style="width: 100%; padding: 7px 10px">
        </select>
        <div id="imgModelDesc" class="muted small" style="margin-top: 6px; color: var(--blue)">临床靶目标：${esc(defaultDesc)}</div>
      </div>

      <details class="pt-dlg-params" open>
        <summary style="cursor: pointer; user-select: none"><b>临床量化与重建参数设置</b> <span class="muted small">（根据所选模型动态适配）</span></summary>
        <div id="imgAirwayParams" class="grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px">
          <div>
            <label class="small muted">支气管-伴行动脉比 (BAR) 扩张切点</label>
            <input type="number" id="imgBarCutoff" step="0.05" value="1.10" style="width: 100%; padding: 4px 6px">
            <span class="muted small" style="font-size: 11px">阈值: &gt; 1.10（Fleischner）</span>
          </div>
          <div>
            <label class="small muted">高密度粘液栓 (HAM) CT 阈值 (HU)</label>
            <input type="number" id="imgHamThreshold" step="5" value="70.0" style="width: 100%; padding: 4px 6px">
            <span class="muted small" style="font-size: 11px">阈值: &ge; 70 HU（高密度粘液栓定义）</span>
          </div>
          <div>
            <label class="small muted">常规粘液栓 CT 阈值范围 (HU)</label>
            <div class="row" style="gap: 4px">
              <input type="number" id="imgMucusMin" step="5" value="10.0" style="width: 50%; padding: 4px 6px">
              <span style="align-self: center">~</span>
              <input type="number" id="imgMucusMax" step="5" value="75.0" style="width: 50%; padding: 4px 6px">
            </div>
          </div>
        </div>
        <div style="margin-top: 8px">
          <label class="small muted">CT/MRI 窗宽窗位预设 (Window Preset)</label>
          <select id="imgWindowSelect" style="width: 100%; padding: 4px 6px">
            <option value="lung" selected>肺窗 (Lung W:1500 L:-600)</option>
            <option value="mediastinum">纵隔窗 (Mediastinum W:350 L:40)</option>
            <option value="abdomen">腹部窗 (Abdomen W:400 L:50)</option>
            <option value="brain">脑窗 (Brain W:80 L:40)</option>
            <option value="bone">骨窗 (Bone W:2000 L:350)</option>
          </select>
        </div>
      </details>

      <div class="field-row" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 6px">
        <label style="display: flex; align-items: center; gap: 8px">
          <span class="muted small">报告/检查日期:</span>
          <input type="date" id="imgReportDate" value="${new Date().toISOString().slice(0, 10)}" style="padding: 3px 6px">
        </label>
        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px">
          <input type="checkbox" id="imgAutoTag" checked> 发现阳性征象（如 BAR 印戒征或 HAM）时自动更新诊断标签
        </label>
      </div>

      <div id="imgProgressBox" hidden style="margin-top: 8px; padding: 12px; border: 1px solid var(--line); background: var(--panel); border-radius: 4px">
        <div class="row" style="align-items: center; gap: 10px">
          <span class="dot" style="background: var(--mint)"></span>
          <b id="imgProgressMsg">正在调度 ${esc(devAccel)} 执行 3D 卷积推理...</b>
        </div>
        <div class="muted small" style="margin-top: 4px">包含三维体素分割、支气管伴行动脉测距 (BAR)、粘液栓体积积分与高清关键截面渲染。</div>
      </div>

      <div class="row end" style="margin-top: 14px; gap: 10px">
        <button type="button" data-close>取消</button>
        <button type="button" class="primary" id="btnRunImaging" ${isHealthy ? '' : 'disabled'}>
          ${icon('sparkles')} 开始 MONAI 3D 量化推理并存入档案
        </button>
      </div>`

    // 影像来源模式：默认优先本地上传 ('upload')，点击辅助链接可切换为临床测试样本 ('sample')
    let currentSourceMode: 'upload' | 'sample' = 'upload'
    const btnToggleDemo = body.querySelector('#btnToggleDemoSample') as HTMLButtonElement | null
    const btnBackToUpload = body.querySelector('#btnBackToUpload') as HTMLButtonElement | null
    const sampleBox = body.querySelector('#imgSampleBox') as HTMLElement
    const uploadBox = body.querySelector('#imgUploadBox') as HTMLElement
    const modelSelect = body.querySelector('#imgModelSelect') as HTMLSelectElement
    const windowSelect = body.querySelector('#imgWindowSelect') as HTMLSelectElement
    const modelDesc = body.querySelector('#imgModelDesc') as HTMLElement
    const sampleSelect = body.querySelector('#imgSampleSelect') as HTMLSelectElement

    let currentSpecialty = 'auto'

    const updateModelUI = () => {
      const opt = modelSelect.selectedOptions[0]
      if (!opt) return
      const win = opt.dataset.window
      const target = opt.dataset.target
      const engine = opt.dataset.engine
      const ready = opt.dataset.ready === 'true'
      const modelId = modelSelect.value

      if (win && windowSelect) windowSelect.value = win

      // 按 worker 返回的 engine_type 如实显示三类：深度学习 / 定量 CT / 规则算法
      const engineBadge = `<span class="pt-imaging-badge" style="${ENGINE_STYLE[engine ?? ''] ?? ''}">${esc(ENGINE_LABEL[engine ?? ''] ?? '类型未标注')}</span>`

      const readyBadge = ready
        ? `<span class="pt-imaging-badge" style="background: rgba(56, 189, 248, 0.12); color: var(--blue)">可用</span>`
        : `<span class="pt-imaging-badge alert" style="background: rgba(239, 68, 68, 0.15); color: #ef4444">不可用：${esc(opt.dataset.reason || '未就绪')}</span>`

      if (modelDesc) {
        modelDesc.innerHTML = `
          <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap">
            ${engineBadge}
            ${readyBadge}
          </div>
          <div><b>临床靶目标：</b>${esc(target || '临床定量分析')}</div>
        `
      }

      const airwayParamBox = body.querySelector('#imgAirwayParams') as HTMLElement
      if (airwayParamBox) {
        if (modelId === 'bronchiectasis_mucus_analyzer') {
          airwayParamBox.style.display = 'grid'
        } else {
          airwayParamBox.style.display = 'none'
        }
      }
    }

    const filterModelsForSample = () => {
      const isUpload = currentSourceMode === 'upload'
      const sid = isUpload ? null : (sampleSelect?.value || null)
      const uploadedFile = fileInputEl?.files?.[0]
      const fn = uploadedFile?.name?.toLowerCase() || ''

      // Sync active state of sample chips
      body.querySelectorAll('.pt-sample-chip').forEach(btn => {
        const el = btn as HTMLElement
        el.classList.toggle('active', !isUpload && el.dataset.sid === sid)
      })

      let matchedCategory = currentSpecialty
      let autoMatchedLabel = ''
      if (currentSpecialty === 'auto') {
        if (!isUpload) {
          if (sid === 'chest_lung_ct' || sid === 'lidc_lung_nodule_ct' || sid === 'copd_emphysema_ct' || sid === 'nsclc_lung_ct') {
            matchedCategory = 'chest'
            autoMatchedLabel = '胸部与呼吸'
          } else if (sid === 'spleen_test' || sid === 'liver_tumor_ct') {
            matchedCategory = 'abdomen'
            autoMatchedLabel = '腹部与消化'
          } else if (sid === 'prostate_mri') {
            matchedCategory = 'abdomen'
            autoMatchedLabel = '前列腺与盆腔'
          } else if (sid === 'brats_brain_mri' || sid === 'hippocampus_brain_mri') {
            matchedCategory = 'brain'
            autoMatchedLabel = '颅脑多模态 MRI'
          } else if (sid === 'cardiac_heart_mri') {
            matchedCategory = 'brain'
            autoMatchedLabel = '心血管高分辨 MRI'
          } else {
            matchedCategory = 'all'
          }
        } else {
          // Smart inference from uploaded filename
          if (/lung|chest|thorax|pulm|hrct|bronch|nodule|copd|abpa|pneumo/.test(fn)) {
            matchedCategory = 'chest'
            autoMatchedLabel = '胸部与呼吸'
          } else if (/abdom|spleen|liver|pancrea|kidney|renal|kits/.test(fn)) {
            matchedCategory = 'abdomen'
            autoMatchedLabel = '腹部与消化'
          } else if (/prostat|pelvi|tz|bph/.test(fn)) {
            matchedCategory = 'abdomen'
            autoMatchedLabel = '前列腺与盆腔'
          } else if (/brain|neuro|head|cranial|brats|glioma|stroke|hippo/.test(fn)) {
            matchedCategory = 'brain'
            autoMatchedLabel = '颅脑与神经'
          } else if (/cardiac|heart|cine|valve|coronary|lvef/.test(fn)) {
            matchedCategory = 'brain'
            autoMatchedLabel = '心血管'
          } else if (/whole|total|body|spine|bone|vertebra/.test(fn)) {
            matchedCategory = 'whole_body'
            autoMatchedLabel = '全身与骨骼'
          } else {
            matchedCategory = 'all'
            if (uploadedFile) autoMatchedLabel = '全专科覆盖'
          }
        }
      }

      // Filter models based on matchedCategory
      const filtered = modelsList.filter(m => {
        if (matchedCategory === 'all') return true
        if (matchedCategory === 'chest') return m.body_part === 'chest' || m.body_part === 'whole_body' || m.body_part === 'general'
        if (matchedCategory === 'abdomen') return m.body_part === 'abdomen' || m.body_part === 'pelvis' || m.body_part === 'whole_body' || m.body_part === 'general'
        if (matchedCategory === 'brain') return m.body_part === 'brain' || m.body_part === 'cardiac'
        if (matchedCategory === 'whole_body') return m.body_part === 'whole_body' || m.body_part === 'bone'
        if (matchedCategory === 'interactive') return m.body_part === 'general' || m.id.includes('vista') || m.id.includes('interactive')
        return true
      })

      // Determine default selected model
      let preferredModelId = ''
      if (!isUpload) {
        if (sid === 'chest_lung_ct') preferredModelId = 'bronchiectasis_mucus_analyzer'
        else if (sid === 'lidc_lung_nodule_ct') preferredModelId = 'lung_nodule_segmenter'
        else if (sid === 'copd_emphysema_ct') preferredModelId = 'copd_emphysema_analyzer'
        else if (sid === 'liver_tumor_ct') preferredModelId = 'liver_lesion_segmenter'
        else if (sid === 'cardiac_heart_mri') preferredModelId = 'cardiac_mri_segmentation'
        else if (sid === 'brats_brain_mri') preferredModelId = 'brain_tumor_brats'
        else if (sid === 'hippocampus_brain_mri') preferredModelId = 'brain_tumor_segmenter'
        else if (sid === 'nsclc_lung_ct') preferredModelId = 'nsclc_recist_analyzer'
        else if (sid === 'spleen_test') preferredModelId = 'multi_organ_ct'
        else if (sid === 'prostate_mri') preferredModelId = 'prostate_mri_segmenter'
      } else {
        if (/bronch|mucus|ham|abpa/.test(fn)) preferredModelId = 'bronchiectasis_mucus_analyzer'
        else if (/nodule/.test(fn)) preferredModelId = 'lung_nodule_segmenter'
        else if (/copd|emphysema/.test(fn)) preferredModelId = 'copd_emphysema_analyzer'
        else if (/liver|hepatic/.test(fn)) preferredModelId = 'liver_lesion_segmenter'
        else if (/cardiac|heart/.test(fn)) preferredModelId = 'cardiac_mri_segmentation'
        else if (/spleen/.test(fn)) preferredModelId = 'spleen_segmenter'
        else if (/prostat/.test(fn)) preferredModelId = 'prostate_mri_segmenter'
        else if (/brain|brats|hippo/.test(fn)) preferredModelId = 'brain_tumor_brats'
      }
      if (!preferredModelId && filtered.length > 0 && filtered[0]) preferredModelId = filtered[0].id

      // 按引擎类型分组：规则算法 / 定量 CT / 深度学习；其它类型单列
      let html = ''
      for (const [type, label] of Object.entries(ENGINE_GROUP)) {
        const group = filtered.filter(m => (m.engine_type ?? '') === type)
        if (group.length) html += `<optgroup label="${label}">${group.map(m => renderOption(m, m.id === preferredModelId)).join('')}</optgroup>`
      }
      const other = filtered.filter(m => !ENGINE_GROUP[m.engine_type ?? ''])
      if (other.length) html += `<optgroup label="类型未标注">${other.map(m => renderOption(m, m.id === preferredModelId)).join('')}</optgroup>`
      if (!html && filtered.length > 0) {
        html = filtered.map(m => renderOption(m, m.id === preferredModelId)).join('')
      }

      modelSelect.innerHTML = html
      if (preferredModelId) {
        modelSelect.value = preferredModelId
      }

      const countEl = body.querySelector('#imgModelCount')
      if (countEl) {
        if (autoMatchedLabel) {
          countEl.textContent = `智能匹配: ${autoMatchedLabel} (${filtered.length} 款模型就绪)`
        } else {
          countEl.textContent = `${filtered.length} 款适配模型就绪`
        }
      }

      updateModelUI()
    }

    btnToggleDemo?.addEventListener('click', () => {
      currentSourceMode = 'sample'
      uploadBox.hidden = true
      sampleBox.hidden = false
      if (btnToggleDemo) btnToggleDemo.hidden = true
      filterModelsForSample()
    })

    btnBackToUpload?.addEventListener('click', () => {
      currentSourceMode = 'upload'
      uploadBox.hidden = false
      sampleBox.hidden = true
      if (btnToggleDemo) btnToggleDemo.hidden = false
      filterModelsForSample()
    })

    sampleSelect?.addEventListener('change', filterModelsForSample)
    modelSelect?.addEventListener('change', updateModelUI)

    // Specialty tabs event delegation
    body.querySelectorAll('.pt-specialty-tab').forEach(tabBtn => {
      tabBtn.addEventListener('click', () => {
        body.querySelectorAll('.pt-specialty-tab').forEach(b => b.classList.remove('active'))
        tabBtn.classList.add('active')
        currentSpecialty = (tabBtn as HTMLElement).dataset.cat || 'auto'
        filterModelsForSample()
      })
    })

    // Sample quick chips
    body.querySelectorAll('.pt-sample-chip').forEach(chipBtn => {
      chipBtn.addEventListener('click', () => {
        const sid = (chipBtn as HTMLElement).dataset.sid
        if (sid && sampleSelect) {
          sampleSelect.value = sid
          currentSourceMode = 'sample'
          sampleBox.hidden = false
          uploadBox.hidden = true
          if (btnToggleDemo) btnToggleDemo.hidden = true
          filterModelsForSample()
        }
      })
    })

    // File upload change listener & drag-and-drop
    const fileInputEl = body.querySelector('#imgFileInput') as HTMLInputElement
    const fileNameEl = body.querySelector('#imgUploadFileName') as HTMLElement
    const dropZone = body.querySelector('#imgUploadBox label') as HTMLElement

    const handleFileSelected = () => {
      const f = fileInputEl.files?.[0]
      if (f && fileNameEl) {
        fileNameEl.style.display = 'block'
        const fn = f.name.toLowerCase()
        let inferredHint = ''
        if (/lung|chest|thorax|pulm|hrct|bronch|nodule|copd|abpa/.test(fn)) {
          inferredHint = ` · 智能识别专科: <b>胸部与呼吸</b>`
        } else if (/abdom|spleen|liver|pancrea|kidney|renal/.test(fn)) {
          inferredHint = ` · 智能识别专科: <b>腹部与消化</b>`
        } else if (/prostat|pelvi|bph/.test(fn)) {
          inferredHint = ` · 智能识别专科: <b>前列腺与盆腔</b>`
        } else if (/brain|neuro|head|brats|hippo/.test(fn)) {
          inferredHint = ` · 智能识别专科: <b>颅脑与神经</b>`
        } else if (/cardiac|heart|valve/.test(fn)) {
          inferredHint = ` · 智能识别专科: <b>心血管</b>`
        } else if (/whole|total|spine/.test(fn)) {
          inferredHint = ` · 智能识别专科: <b>全身与骨骼</b>`
        } else {
          inferredHint = ` · 序列已选定 (将在点击底部【开始推理】上传并执行分析)`
        }
        fileNameEl.innerHTML = `${icon('file', { size: 12 })} 已选文件: <b>${esc(f.name)}</b> (${(f.size / (1024 * 1024)).toFixed(1)} MB)${inferredHint}`
        filterModelsForSample()
      }
    }

    fileInputEl?.addEventListener('change', handleFileSelected)

    if (dropZone) {
      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault()
        dropZone.style.borderColor = 'var(--blue)'
        dropZone.style.background = 'rgba(56, 189, 248, 0.08)'
      })
      dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = 'var(--line-strong)'
        dropZone.style.background = 'var(--hover)'
      })
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault()
        dropZone.style.borderColor = 'var(--line-strong)'
        dropZone.style.background = 'var(--hover)'
        if (e.dataTransfer?.files?.length) {
          fileInputEl.files = e.dataTransfer.files
          handleFileSelected()
        }
      })
    }

    // Initial trigger to sync UI
    filterModelsForSample()

    // 启动分析按钮
    const btnRun = body.querySelector('#btnRunImaging') as HTMLButtonElement
    const progressBox = body.querySelector('#imgProgressBox') as HTMLElement
    const progressMsg = body.querySelector('#imgProgressMsg') as HTMLElement

    btnRun?.addEventListener('click', async () => {
      const isUpload = currentSourceMode === 'upload'
      const sampleId = (body.querySelector('#imgSampleSelect') as HTMLSelectElement)?.value
      const modelId = (body.querySelector('#imgModelSelect') as HTMLSelectElement)?.value || 'bronchiectasis_mucus_analyzer'
      const windowPreset = (body.querySelector('#imgWindowSelect') as HTMLSelectElement)?.value
      const parseSafeInput = (val: string | undefined, def: number): number => {
        if (!val) return def
        const n = parseFloat(String(val).trim().replace(',', '.'))
        return isNaN(n) ? def : n
      }
      const barCutoff = parseSafeInput((body.querySelector('#imgBarCutoff') as HTMLInputElement)?.value, 1.10)
      const mucusMin = parseSafeInput((body.querySelector('#imgMucusMin') as HTMLInputElement)?.value, 10.0)
      const mucusMax = parseSafeInput((body.querySelector('#imgMucusMax') as HTMLInputElement)?.value, 75.0)
      const hamThresh = parseSafeInput((body.querySelector('#imgHamThreshold') as HTMLInputElement)?.value, 70.0)
      const reportDate = (body.querySelector('#imgReportDate') as HTMLInputElement)?.value
      const autoTag = (body.querySelector('#imgAutoTag') as HTMLInputElement)?.checked

      const fileInput = body.querySelector('#imgFileInput') as HTMLInputElement
      const uploadedFile = fileInput?.files?.[0]

      if (isUpload && !uploadedFile) {
        notice('请先选择或拖拽要上传的 CT/MRI 影像文件 (.nii / .nii.gz / .gz / .dcm / .zip / .tar.gz 序列包)，或点击右上角载入演示样本快速体验。', true)
        return
      }

      btnRun.disabled = true
      progressBox.hidden = false
      progressMsg.textContent = `正在传输体素数据并调度 ${devAccel} 执行 3D 卷积分割...`

      try {
        if (isUpload && uploadedFile) {
          const fd = new FormData()
          fd.append('file', uploadedFile)
          fd.append('model_id', modelId)
          fd.append('window_preset', windowPreset)
          fd.append('bar_cutoff', String(barCutoff))
          fd.append('mucus_min_hu', String(mucusMin))
          fd.append('mucus_max_hu', String(mucusMax))
          fd.append('ham_threshold_hu', String(hamThresh))
          if (reportDate) fd.append('report_date', reportDate)
          fd.append('auto_tag', String(autoTag))
          await api(`/api/patients/${patientId}/imaging/analyze`, { method: 'POST', body: fd })
        } else {
          await api(`/api/patients/${patientId}/imaging/analyze`, {
            method: 'POST',
            body: JSON.stringify({
              sample_id: sampleId,
              model_id: modelId,
              window_preset: windowPreset,
              bar_cutoff: barCutoff,
              mucus_min_hu: mucusMin,
              mucus_max_hu: mucusMax,
              ham_threshold_hu: hamThresh,
              report_date: reportDate,
              auto_tag: autoTag,
            })
          })
        }

        notice('影像量化分析完成！已生成关键截面并加密存入患者档案。')
        close()
        tab = 'records'
        await loadList()
        await openPatient(patientId, true)
      } catch (err: any) {
        btnRun.disabled = false
        progressBox.hidden = true
        notice(`影像分析失败: ${err.message || String(err)}`, true)
      }
    })
  }

  async function showMprViewerDialog(patientId: string, d: Detail | Patient, r?: RecordRow): Promise<void> {
    const dlg = document.getElementById('dialog')!
    dlg.innerHTML = `
      <div class="dialog-card pt-mpr-dialog" role="dialog" aria-modal="true">
        <div class="dialog-head">
          <div style="display: flex; align-items: center; gap: 10px">
            <h2>${icon('mpr', { size: 18 })} 3D 多平面重建 (MPR) 互动切片浏览器</h2>
            <span class="muted small">${esc(d.code)}${r?.title ? ` · ${esc(r.title)}` : ''}</span>
          </div>
          <button class="quiet" data-close aria-label="关闭">✕</button>
        </div>
        <div class="dialog-body" style="gap: 14px">
          <div class="pt-img-dlg-loading" style="padding: 40px; text-align: center; color: var(--text-2);">
            正在探测体素几何分布与加载 3D 体积元数据...
          </div>
        </div>
      </div>`
    dlg.hidden = false
    let nvInstance: any = null
    const cleanupNv = () => {
      if (nvInstance) {
        try {
          if (typeof nvInstance.destroy === 'function') {
            nvInstance.destroy()
          }
        } catch {}
        nvInstance = null
      }
    }
    const close = () => {
      cleanupNv()
      dlg.hidden = true
      dlg.innerHTML = ''
    }
    dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) close() }

    const imgData = (r?.imaging_data as any) || {}
    const modelName = imgData.model_id || imgData.model_name || (r?.title?.includes('支气管') ? 'bronchiectasis_mucus_analyzer' : undefined)
    const rawFileId = imgData.raw_file_id || r?.file_id
    const isPatientRealScan = Boolean(patientId && r && (rawFileId || r.id))
    // 只用记录里真实的样本 ID，不按文件名猜、不用默认演示样本
    const sampleId: string = imgData.sample_id || ''

    let mprInfo: any = null
    try {
      const qParams = new URLSearchParams()
      if (isPatientRealScan) {
        qParams.set('patient_id', patientId)
        if (r?.id) qParams.set('record_id', r.id)
        if (rawFileId) qParams.set('file_id', rawFileId)
        if (sampleId) qParams.set('sample_id', sampleId)
      } else if (sampleId) {
        qParams.set('sample_id', sampleId)
      }
      if (modelName) qParams.set('model_name', modelName)
      mprInfo = await api<any>(`/api/imaging/mpr/info?${qParams.toString()}`)
    } catch (err: any) {
      const bodyEl = dlg.querySelector('.dialog-body')
      if (bodyEl) {
        bodyEl.innerHTML = `
          <div style="padding: 24px; text-align: center; color: #FCA5A5">
            <p>无法载入影像：${esc(err.message || '影像服务离线')}</p>
            <button class="primary small-btn" style="margin-top: 14px" data-close>关闭</button>
          </div>`
      }
      return
    }

    const dims = mprInfo.dimensions || { z: 269, y: 512, x: 512 }
    // 没有体素间距时为 null：不用默认值换算（手动测量以像素显示）
    const voxelSpacing: VoxelSpacing | null = mprInfo.voxel_spacing_mm || null
    const planes: Record<string, { total_slices: number; default_slice: number; label: string }> = mprInfo.planes || {
      axial: { total_slices: dims.z, default_slice: Math.floor(dims.z / 2), label: '轴位 (Axial)' },
      coronal: { total_slices: dims.y, default_slice: Math.floor(dims.y / 2), label: '冠状位 (Coronal)' },
      sagittal: { total_slices: dims.x, default_slice: Math.floor(dims.x / 2), label: '矢状位 (Sagittal)' },
    }
    const centerSlice: Record<string, number> = mprInfo.center_slice || {
      axial: Math.floor(dims.z / 2),
      coronal: Math.floor(dims.y / 2),
      sagittal: Math.floor(dims.x / 2),
    }

    let currentPlane = 'axial'
    let currentSlice = centerSlice.axial ?? Math.floor(dims.z / 2)
    let currentWindow = mprInfo.recommended_windows?.[0] || 'lung'
    let overlayMask = true
    const sliceCache = new Map<string, any>()
    let isFetching = false

    const dlgBody = dlg.querySelector('.dialog-body')!
    dlgBody.innerHTML = `
      <div class="pt-mpr-layout">
        <!-- 左侧参数与控制面板 -->
        <div class="pt-mpr-sidebar">
          <div class="pt-mpr-sidebar-section">
            <div class="pt-mpr-sidebar-title">浏览引擎 (Renderer Engine)</div>
            <div class="pt-mpr-btn-group" id="mprEngineBtns">
              <button data-engine="slice" class="active" title="轻量 2D 正交多平面重建，带 5cm 标尺与精确解剖尺寸">${icon('scan')} 2D 正交切片</button>
              <button data-engine="niivue" title="NiiVue WebGL2 引擎：体绘制 3D 自由旋转与多平面联动">${icon('globe')} NiiVue 3D WebGL</button>
            </div>
          </div>

          <div class="pt-mpr-sidebar-section">
            <div class="pt-mpr-sidebar-title">正交解剖平面 (Plane)</div>
            <div class="pt-mpr-btn-group" id="mprPlaneBtns">
              <button data-plane="axial" class="active">轴位 (Axial)</button>
              <button data-plane="coronal">冠状位 (Coronal)</button>
              <button data-plane="sagittal">矢状位 (Sagittal)</button>
              <button data-plane="multi" style="display: none" id="nvMultiBtn" title="NiiVue 四视图联动">四视图</button>
              <button data-plane="render" style="display: none" id="nvRenderBtn" title="NiiVue 3D 立体旋转体绘制">3D 体绘制</button>
            </div>
          </div>

          <div class="pt-mpr-sidebar-section">
            <div class="pt-mpr-sidebar-title">CT 窗宽窗位预设 (Window)</div>
            <div class="pt-mpr-btn-group" id="mprWindowBtns">
              <button data-win="lung" class="${currentWindow === 'lung' ? 'active' : ''}">肺窗 (Lung)</button>
              <button data-win="mediastinum" class="${currentWindow === 'mediastinum' ? 'active' : ''}">纵隔 (Med)</button>
              <button data-win="abdomen" class="${currentWindow === 'abdomen' ? 'active' : ''}">腹部 (Abd)</button>
              <button data-win="bone" class="${currentWindow === 'bone' ? 'active' : ''}">骨窗 (Bone)</button>
              <button data-win="brain" class="${currentWindow === 'brain' ? 'active' : ''}">脑窗 (Brain)</button>
            </div>
          </div>

          <div class="pt-mpr-sidebar-section">
            <div class="pt-mpr-sidebar-title">病灶与高亮 (Overlay)</div>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer">
              <input type="checkbox" id="mprOverlayCheck" checked>
              <span>MONAI 病灶半透明红色高亮</span>
            </label>
            <div id="mprLesionBadge" class="pt-mpr-status-badge no-lesion" style="margin-top: 4px">
              病灶探测中...
            </div>
          </div>

          <div class="pt-mpr-sidebar-section">
            <div class="pt-mpr-sidebar-title">解剖导航与对齐</div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap">
              <button class="small-btn quiet" id="mprJumpCenter" title="根据 3D 卷积分割范围自动对齐至病灶中心切片">${icon('target')} 定位病灶中心</button>
              <button class="small-btn quiet" id="mprJumpFirst">首层</button>
              <button class="small-btn quiet" id="mprJumpLast">尾层</button>
            </div>
          </div>

          <div class="pt-mpr-sidebar-section" id="mprAnnotSection">
            <div class="pt-mpr-sidebar-title">交互式测量与标注 (Manual Tool)</div>
            <div class="pt-mpr-btn-group" id="mprToolBtns">
              <button data-tool="browse" class="active" title="浏览模式：滚轮与点击正常切片滚动">${icon('search')} 浏览</button>
              <button data-tool="caliper" title="测距卡尺：在切片上按住鼠标拖拽绘制线段，实时计算物理毫米 (mm) 距离">${icon('caliper')} 测距卡尺</button>
              <button data-tool="roi" title="ROI 矩形测量：在切片上按住鼠标拖拽矩形框，计算截面面积 (mm²)">${icon('target')} ROI 区域</button>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px">
              <span id="mprMeasureSummary" class="muted small" style="font-family: var(--mono); font-size: 11px">当前切片无测量</span>
              <button class="quiet small-btn" id="mprClearAnnotBtn" style="padding: 2px 6px; font-size: 11px" title="清除当前切片上的所有手动测量标注">清除标注</button>
            </div>
          </div>

          <div class="pt-mpr-sidebar-section" style="margin-top: auto; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px">
            <div class="pt-mpr-sidebar-title">报告插图与资产沉淀</div>
            <button class="primary small-btn" id="mprSaveAssetBtn" style="width: 100%" title="保存当前 MPR 正交切片为平台资产并生成 Markdown 引用">${icon('save')} 保存切片为文档资产</button>
            <button class="small-btn quiet" id="mprGenReportBtn" style="margin-top: 6px; width: 100%; border: 1px solid rgba(45,212,191,0.35); color: var(--teal)" title="汇总当前病灶测值、窗宽窗位与切片截图，生成影像所见草稿（不含诊断结论）">${icon('report')} 生成影像所见草稿</button>
            <div id="mprSaveNotice" class="muted small" style="display: none; margin-top: 6px; word-break: break-all"></div>
          </div>
        </div>

        <!-- 右侧交互视口与切片滚动条 -->
        <div class="pt-mpr-viewport-container">
          <!-- 2D 切片视口 -->
          <div class="pt-mpr-screen" id="mprScreen" title="在切片区域上下滚动鼠标滚轮即可连续浏览切片">
            <div class="pt-mpr-canvas-wrap" style="position: relative; display: inline-flex; align-items: center; justify-content: center; max-width: 100%; max-height: 460px;">
              <img id="mprImg" alt="3D MPR 切片" style="display: none; max-width: 100%; max-height: 460px; object-fit: contain;">
              <canvas id="mprAnnotCanvas" width="512" height="512" style="position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 5;"></canvas>
            </div>
            <div id="mprLoadingSpinner" style="color: var(--text-2); font-size: 13px">
              正在提取当前切片...
            </div>
            <!-- HUD 信息层 -->
            <div class="pt-mpr-hud-overlay" id="mprHudLeft">
              MPR // AXIAL<br>
              Slice #-- / --
            </div>
            <div class="pt-mpr-hud-right" id="mprHudRight">
              ${esc(mprInfo.modality || 'CT')}<br>
              ${voxelSpacing ? `Voxel: ${voxelSpacing.dx}×${voxelSpacing.dy}×${voxelSpacing.dz} mm` : NO_SPACING_NOTE}
            </div>
            <div class="pt-mpr-hud-bottom">
              鼠标滚轮上下滚动或按键盘 ↑/↓ 即可连贯浏览连续切片
            </div>
          </div>

          <!-- NiiVue WebGL2 视口 -->
          <div id="nvContainer" style="display: none; position: relative; width: 100%; height: 460px; background: #000; border-radius: 6px; overflow: hidden">
            <canvas id="nvCanvas" style="width: 100%; height: 100%; outline: none"></canvas>
            <div id="nvLoading" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: var(--text-2); font-size: 13px">
              正在初始化 NiiVue WebGL2 引擎并加载 3D NIfTI 卷数据...
            </div>
          </div>

          <!-- 底部切片 Scrubber 滑动条 -->
          <div class="pt-mpr-scrubber-bar" id="mprScrubberBar">
            <button class="quiet small-btn" id="mprPrevBtn" title="上一层 (↑ / ←)">◀</button>
            <input type="range" id="mprSlider" min="0" max="${(planes[currentPlane]?.total_slices ?? 100) - 1}" value="${currentSlice}">
            <button class="quiet small-btn" id="mprNextBtn" title="下一层 (↓ / →)">▶</button>
            <span id="mprSliceNum" style="font-family: var(--mono); font-size: 12px; min-width: 90px; text-align: right">#${currentSlice} / ${planes[currentPlane]?.total_slices ?? '--'}</span>
          </div>
        </div>
      </div>`

    // DOM Elements
    const imgEl = dlg.querySelector('#mprImg') as HTMLImageElement
    const spinnerEl = dlg.querySelector('#mprLoadingSpinner') as HTMLElement
    const hudLeft = dlg.querySelector('#mprHudLeft') as HTMLElement
    const hudRight = dlg.querySelector('#mprHudRight') as HTMLElement
    const slider = dlg.querySelector('#mprSlider') as HTMLInputElement
    const sliceNum = dlg.querySelector('#mprSliceNum') as HTMLElement
    const lesionBadge = dlg.querySelector('#mprLesionBadge') as HTMLElement
    const overlayCheck = dlg.querySelector('#mprOverlayCheck') as HTMLInputElement
    const mprScreen = dlg.querySelector('#mprScreen') as HTMLElement
    const scrubberBar = dlg.querySelector('#mprScrubberBar') as HTMLElement
    const nvContainer = dlg.querySelector('#nvContainer') as HTMLElement
    const nvLoading = dlg.querySelector('#nvLoading') as HTMLElement
    const nvMultiBtn = dlg.querySelector('#nvMultiBtn') as HTMLButtonElement
    const nvRenderBtn = dlg.querySelector('#nvRenderBtn') as HTMLButtonElement
    const saveAssetBtn = dlg.querySelector('#mprSaveAssetBtn') as HTMLButtonElement
    const saveNotice = dlg.querySelector('#mprSaveNotice') as HTMLElement
    const annotCanvas = dlg.querySelector('#mprAnnotCanvas') as HTMLCanvasElement
    const annotCtx = annotCanvas?.getContext('2d')
    const toolBtns = dlg.querySelector('#mprToolBtns')
    const measureSummary = dlg.querySelector('#mprMeasureSummary') as HTMLElement
    const clearAnnotBtn = dlg.querySelector('#mprClearAnnotBtn') as HTMLButtonElement

    type ToolMode = 'browse' | 'caliper' | 'roi'
    let currentTool: ToolMode = 'browse'

    interface CaliperAnnot {
      type: 'caliper'
      x1: number
      y1: number
      x2: number
      y2: number
      /** 有间距时为 mm，否则为 px */
      measure: Measure
    }

    interface RoiAnnot {
      type: 'roi'
      x1: number
      y1: number
      x2: number
      y2: number
      /** 有间距时为 mm²，否则为 px² */
      measure: Measure
    }

    type AnnotItem = CaliperAnnot | RoiAnnot
    const sliceAnnotations = new Map<string, AnnotItem[]>()
    const annotKey = (plane: string, slice: number) => `${plane}:${slice}`

    function getSpacing(): Spacing | null {
      const curData = sliceCache.get(`${sampleId}:${currentPlane}:${currentSlice}:${currentWindow}:${overlayMask}`)
      return planeSpacing(curData?.pixel_spacing_mm, voxelSpacing, currentPlane as Plane)
    }

    function drawAnnotItem(ctx: CanvasRenderingContext2D, item: AnnotItem): void {
      ctx.save()
      if (item.type === 'caliper') {
        const { x1, y1, x2, y2, measure } = item
        const dx = x2 - x1
        const dy = y2 - y1
        const len = Math.hypot(dx, dy)

        ctx.strokeStyle = '#2DD4BF'
        ctx.lineWidth = 2
        ctx.shadowColor = 'rgba(0, 0, 0, 0.9)'
        ctx.shadowBlur = 4
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()

        if (len > 0) {
          const perpX = -(dy / len) * 7
          const perpY = (dx / len) * 7
          ctx.beginPath()
          ctx.moveTo(x1 - perpX, y1 - perpY)
          ctx.lineTo(x1 + perpX, y1 + perpY)
          ctx.moveTo(x2 - perpX, y2 - perpY)
          ctx.lineTo(x2 + perpX, y2 + perpY)
          ctx.stroke()
        }

        const midX = (x1 + x2) / 2
        const midY = (y1 + y2) / 2
        const text = `LD: ${formatMeasure(measure)}`
        ctx.font = 'bold 12px monospace, sans-serif'
        const textMetrics = ctx.measureText(text)
        const padX = 6
        const boxW = textMetrics.width + padX * 2
        const boxH = 18

        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)'
        ctx.strokeStyle = '#2DD4BF'
        ctx.lineWidth = 1
        ctx.shadowBlur = 0
        const bx = midX - boxW / 2
        const by = midY - boxH - 6
        ctx.beginPath()
        if (typeof (ctx as any).roundRect === 'function') {
          (ctx as any).roundRect(bx, by, boxW, boxH, 4)
        } else {
          ctx.rect(bx, by, boxW, boxH)
        }
        ctx.fill()
        ctx.stroke()

        ctx.fillStyle = '#FFFFFF'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, midX, by + boxH / 2)
      } else if (item.type === 'roi') {
        const { x1, y1, x2, y2, measure } = item
        const rx = Math.min(x1, x2)
        const ry = Math.min(y1, y2)
        const rw = Math.abs(x2 - x1)
        const rh = Math.abs(y2 - y1)

        ctx.fillStyle = 'rgba(45, 212, 191, 0.15)'
        ctx.strokeStyle = '#2DD4BF'
        ctx.lineWidth = 2
        ctx.setLineDash([5, 4])
        ctx.shadowColor = 'rgba(0, 0, 0, 0.9)'
        ctx.shadowBlur = 4
        ctx.beginPath()
        ctx.rect(rx, ry, rw, rh)
        ctx.fill()
        ctx.stroke()
        ctx.setLineDash([])

        const text = `ROI: ${formatMeasure(measure)}`
        ctx.font = 'bold 12px monospace, sans-serif'
        const textMetrics = ctx.measureText(text)
        const padX = 6
        const boxW = textMetrics.width + padX * 2
        const boxH = 18

        const bx = rx
        const by = Math.max(4, ry - boxH - 4)

        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)'
        ctx.strokeStyle = '#2DD4BF'
        ctx.lineWidth = 1
        ctx.shadowBlur = 0
        ctx.beginPath()
        if (typeof (ctx as any).roundRect === 'function') {
          (ctx as any).roundRect(bx, by, boxW, boxH, 4)
        } else {
          ctx.rect(bx, by, boxW, boxH)
        }
        ctx.fill()
        ctx.stroke()

        ctx.fillStyle = '#FFFFFF'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, bx + padX, by + boxH / 2)
      }
      ctx.restore()
    }

    function redrawCanvas(activePreview?: AnnotItem | null): void {
      if (!annotCtx || !annotCanvas) return
      annotCtx.clearRect(0, 0, 512, 512)
      const items = sliceAnnotations.get(annotKey(currentPlane, currentSlice)) || []
      for (const item of items) {
        drawAnnotItem(annotCtx, item)
      }
      if (activePreview) {
        drawAnnotItem(annotCtx, activePreview)
      }
    }

    function updateMeasureSummary(): void {
      if (!measureSummary) return
      const items = sliceAnnotations.get(annotKey(currentPlane, currentSlice)) || []
      if (items.length === 0) {
        measureSummary.textContent = '当前切片无测量'
        return
      }
      const parts: string[] = []
      for (const it of items) {
        if (it.type === 'caliper') parts.push(`卡尺: ${formatMeasure(it.measure)}`)
        else if (it.type === 'roi') parts.push(`ROI: ${formatMeasure(it.measure)}`)
      }
      measureSummary.textContent = parts.join(' | ')
    }

    let isDrawing = false
    let dragStart = { x: 0, y: 0 }

    function getCanvasCoords(ev: MouseEvent): { x: number; y: number } {
      const rect = annotCanvas.getBoundingClientRect()
      const x = Math.max(0, Math.min(512, ((ev.clientX - rect.left) / rect.width) * 512))
      const y = Math.max(0, Math.min(512, ((ev.clientY - rect.top) / rect.height) * 512))
      return { x, y }
    }

    annotCanvas?.addEventListener('mousedown', ev => {
      if (currentTool === 'browse' || ev.button !== 0) return
      ev.preventDefault()
      isDrawing = true
      dragStart = getCanvasCoords(ev)
    })

    annotCanvas?.addEventListener('mousemove', ev => {
      if (!isDrawing || currentTool === 'browse') return
      ev.preventDefault()
      const { x, y } = getCanvasCoords(ev)
      const sp = getSpacing()

      if (currentTool === 'caliper') {
        redrawCanvas({ type: 'caliper', x1: dragStart.x, y1: dragStart.y, x2: x, y2: y, measure: caliperMeasure(x - dragStart.x, y - dragStart.y, sp) })
      } else if (currentTool === 'roi') {
        redrawCanvas({ type: 'roi', x1: dragStart.x, y1: dragStart.y, x2: x, y2: y, measure: roiMeasure(x - dragStart.x, y - dragStart.y, sp) })
      }
    })

    const finishDrawing = () => {
      if (!isDrawing || currentTool === 'browse') return
      isDrawing = false
      redrawCanvas()
      updateMeasureSummary()
    }

    annotCanvas?.addEventListener('mouseup', ev => {
      if (!isDrawing || currentTool === 'browse') return
      isDrawing = false
      const { x, y } = getCanvasCoords(ev)
      const sp = getSpacing()
      const key = annotKey(currentPlane, currentSlice)
      const existing = sliceAnnotations.get(key) || []

      if (currentTool === 'caliper') {
        const measure = caliperMeasure(x - dragStart.x, y - dragStart.y, sp)
        if (largeEnough(measure)) {
          existing.push({ type: 'caliper', x1: dragStart.x, y1: dragStart.y, x2: x, y2: y, measure })
          sliceAnnotations.set(key, existing)
        }
      } else if (currentTool === 'roi') {
        const measure = roiMeasure(x - dragStart.x, y - dragStart.y, sp)
        if (largeEnough(measure)) {
          existing.push({ type: 'roi', x1: dragStart.x, y1: dragStart.y, x2: x, y2: y, measure })
          sliceAnnotations.set(key, existing)
        }
      }
      redrawCanvas()
      updateMeasureSummary()
    })

    annotCanvas?.addEventListener('mouseleave', finishDrawing)

    annotCanvas?.addEventListener('wheel', ev => {
      ev.preventDefault()
      const delta = ev.deltaY > 0 ? 1 : -1
      void loadSlice(currentSlice + delta)
    }, { passive: false })

    toolBtns?.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tool]')
      if (!btn) return
      toolBtns.querySelectorAll('button').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      currentTool = (btn.dataset.tool || 'browse') as ToolMode

      if (currentTool === 'browse') {
        annotCanvas.style.pointerEvents = 'none'
        annotCanvas.style.cursor = 'default'
      } else {
        annotCanvas.style.pointerEvents = 'auto'
        annotCanvas.style.cursor = 'crosshair'
      }
    })

    clearAnnotBtn?.addEventListener('click', () => {
      sliceAnnotations.delete(annotKey(currentPlane, currentSlice))
      redrawCanvas()
      updateMeasureSummary()
    })

    let currentEngine = 'slice'
    nvInstance = null
    const savedSlices: Array<{ label: string; assetId: string; mdText: string }> = []

    async function initNiivue() {
      if (nvInstance) return nvInstance
      try {
        const { Niivue } = await import('@niivue/niivue')
        nvInstance = new Niivue({
          backColor: [0.03, 0.04, 0.07, 1],
          show3Dcrosshair: true,
          isColorbar: true,
        })
        const canvas = dlg.querySelector('#nvCanvas') as HTMLCanvasElement
        nvInstance.attachToCanvas(canvas)
        const volumeId = isPatientRealScan && (rawFileId || r?.id) ? `pt_${patientId}_${rawFileId || r?.id}` : sampleId
        const fileUrl = `/api/imaging/samples/${volumeId}/file?token=${encodeURIComponent(hooks.token())}`
        await nvInstance.loadVolumes([{ url: fileUrl, name: `${volumeId}.nii.gz`, colormap: 'gray' }])
        if (nvLoading) nvLoading.style.display = 'none'
      } catch (err: any) {
        if (nvLoading) nvLoading.textContent = `NiiVue 引擎启动失败: ${err.message || '环境未支持 WebGL2'}`
      }
      return nvInstance
    }

    async function loadSlice(targetSlice: number): Promise<void> {
      const total = planes[currentPlane]?.total_slices || 100
      targetSlice = Math.max(0, Math.min(total - 1, targetSlice))
      currentSlice = targetSlice

      slider.value = String(currentSlice)
      sliceNum.textContent = `#${currentSlice} / ${total}`

      if (saveAssetBtn.textContent?.includes('已保存') || saveAssetBtn.disabled) {
        saveAssetBtn.disabled = false
        saveAssetBtn.innerHTML = `${icon('save')} 保存当前切片为资产`
      }

      const cacheVolId = isPatientRealScan ? `pt_${patientId}_${rawFileId || r?.id}` : sampleId
      const cacheKey = `${cacheVolId}:${currentPlane}:${currentSlice}:${currentWindow}:${overlayMask}`
      if (sliceCache.has(cacheKey)) {
        renderSliceData(sliceCache.get(cacheKey))
        return
      }

      if (isFetching) return
      isFetching = true

      try {
        const payload: Record<string, any> = {
          sample_id: sampleId,
          plane: currentPlane,
          slice_index: currentSlice,
          window_preset: currentWindow,
          overlay_mask: overlayMask,
          model_name: modelName,
        }
        if (isPatientRealScan) {
          payload.patient_id = patientId
          if (r?.id) payload.record_id = r.id
          if (rawFileId) payload.file_id = rawFileId
        }
        const res = await api<any>('/api/imaging/mpr/slice', {
          method: 'POST',
          body: JSON.stringify(payload),
        })

        sliceCache.set(cacheKey, res)
        renderSliceData(res)
      } catch (err: any) {
        spinnerEl.textContent = `切片提取失败: ${err.message || '未知错误'}`
      } finally {
        isFetching = false
      }
    }

    function renderSliceData(data: any): void {
      if (data.slice_png_base64) {
        imgEl.src = data.slice_png_base64
        imgEl.style.display = 'block'
        spinnerEl.style.display = 'none'
      }

      const planeMap: Record<string, string> = { axial: 'AXIAL (轴位)', coronal: 'CORONAL (冠状位)', sagittal: 'SAGITTAL (矢状位)' }
      hudLeft.innerHTML = `MPR // ${planeMap[currentPlane] || currentPlane.toUpperCase()}<br>Slice #${data.slice_index} / ${data.total_slices}<br>${esc(data.window?.preset || currentWindow).toUpperCase()} WIN`

      // 病灶面积：worker 给了 mm² 就用；否则只有有间距时才换算，没有间距时以像素显示
      const sp = planeSpacing(data.pixel_spacing_mm, voxelSpacing, currentPlane as Plane)
      const lesionMeasure: Measure = data.lesion_area_mm2 !== undefined && data.lesion_area_mm2 !== null
        ? { value: Number(data.lesion_area_mm2), unit: 'mm²' }
        : roiMeasure(data.lesion_pixel_count || 0, 1, sp)
      const lesionArea = formatMeasure(lesionMeasure)

      hudRight.innerHTML = `512×512<br>${sp ? `Pixel: ${sp.h}×${sp.v} mm` : NO_SPACING_NOTE}${lesionMeasure.value > 0 ? `<br><span style="color:#FCA5A5">病灶面积: ${lesionArea}</span>` : ''}`

      if (data.lesion_present && data.lesion_pixel_count > 0) {
        lesionBadge.className = 'pt-mpr-status-badge has-lesion'
        lesionBadge.innerHTML = `${icon('target', { size: 12 })} 病灶检出 (${lesionArea})`
      } else {
        lesionBadge.className = 'pt-mpr-status-badge no-lesion'
        lesionBadge.innerHTML = `无明显高密度病灶`
      }
      redrawCanvas()
      updateMeasureSummary()
    }

    // 渲染引擎切换 (2D 切片 vs NiiVue 3D WebGL)
    dlg.querySelector('#mprEngineBtns')?.addEventListener('click', async e => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-engine]')
      if (!btn) return
      dlg.querySelectorAll('#mprEngineBtns button').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      currentEngine = btn.dataset.engine || 'slice'

      if (currentEngine === 'niivue') {
        mprScreen.style.display = 'none'
        scrubberBar.style.display = 'none'
        nvContainer.style.display = 'block'
        nvMultiBtn.style.display = 'inline-block'
        nvRenderBtn.style.display = 'inline-block'
        const nv = await initNiivue()
        if (nv) nv.setSliceType(nv.sliceTypeMultiplanar)
      } else {
        nvContainer.style.display = 'none'
        nvMultiBtn.style.display = 'none'
        nvRenderBtn.style.display = 'none'
        mprScreen.style.display = 'flex'
        scrubberBar.style.display = 'flex'
        void loadSlice(currentSlice)
      }
    })

    // 事件绑定: 平面与视图切换
    dlg.querySelector('#mprPlaneBtns')?.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-plane]')
      if (!btn) return
      dlg.querySelectorAll('#mprPlaneBtns button').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      const targetPlane = btn.dataset.plane || 'axial'

      if (currentEngine === 'niivue' && nvInstance) {
        if (targetPlane === 'multi') nvInstance.setSliceType(nvInstance.sliceTypeMultiplanar)
        else if (targetPlane === 'render') nvInstance.setSliceType(nvInstance.sliceTypeRender)
        else if (targetPlane === 'axial') nvInstance.setSliceType(nvInstance.sliceTypeAxial)
        else if (targetPlane === 'coronal') nvInstance.setSliceType(nvInstance.sliceTypeCoronal)
        else if (targetPlane === 'sagittal') nvInstance.setSliceType(nvInstance.sliceTypeSagittal)
        return
      }

      currentPlane = targetPlane
      const total = planes[currentPlane]?.total_slices || 100
      slider.max = String(total - 1)
      currentSlice = centerSlice[currentPlane] ?? Math.floor(total / 2)
      void loadSlice(currentSlice)
      redrawCanvas()
      updateMeasureSummary()
    })

    // 窗宽窗位切换
    dlg.querySelector('#mprWindowBtns')?.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-win]')
      if (!btn) return
      dlg.querySelectorAll('#mprWindowBtns button').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      currentWindow = btn.dataset.win || 'lung'
      void loadSlice(currentSlice)
    })

    // Overlay 切换
    overlayCheck.addEventListener('change', () => {
      overlayMask = overlayCheck.checked
      void loadSlice(currentSlice)
    })

    // 滑动条拖动
    slider.addEventListener('input', () => {
      void loadSlice(Number(slider.value))
    })

    // 滚轮 Scrubbing
    mprScreen.addEventListener('wheel', ev => {
      ev.preventDefault()
      const delta = ev.deltaY > 0 ? 1 : -1
      void loadSlice(currentSlice + delta)
    }, { passive: false })

    // 键盘上下左右键
    const keyHandler = (ev: KeyboardEvent) => {
      if (dlg.hidden) return
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
        ev.preventDefault()
        void loadSlice(currentSlice - 1)
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
        ev.preventDefault()
        void loadSlice(currentSlice + 1)
      }
    }
    window.addEventListener('keydown', keyHandler)
    const origClose = close
    const wrappedClose = () => {
      window.removeEventListener('keydown', keyHandler)
      origClose()
    }
    dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) wrappedClose() }

    // 按钮上下层
    dlg.querySelector('#mprPrevBtn')?.addEventListener('click', () => void loadSlice(currentSlice - 1))
    dlg.querySelector('#mprNextBtn')?.addEventListener('click', () => void loadSlice(currentSlice + 1))

    // 快捷定位
    dlg.querySelector('#mprJumpCenter')?.addEventListener('click', () => {
      const target = centerSlice[currentPlane] ?? Math.floor((planes[currentPlane]?.total_slices || 100) / 2)
      void loadSlice(target)
    })
    dlg.querySelector('#mprJumpFirst')?.addEventListener('click', () => void loadSlice(0))
    dlg.querySelector('#mprJumpLast')?.addEventListener('click', () => void loadSlice((planes[currentPlane]?.total_slices || 100) - 1))

    // 保存为资产
    saveAssetBtn.addEventListener('click', async () => {
      saveAssetBtn.disabled = true
      saveAssetBtn.textContent = '正在保存资产...'
      try {
        const planeNameMap: Record<string, string> = { axial: '轴位', coronal: '冠状位', sagittal: '矢状位' }
        const hasAnnots = (sliceAnnotations.get(annotKey(currentPlane, currentSlice)) || []).length > 0
        const label = `${d.code} MPR ${planeNameMap[currentPlane] || currentPlane} 第 ${currentSlice} 层${hasAnnots ? ' (含手动测量标注)' : ''}`

        let customB64: string | undefined = undefined
        if (hasAnnots && imgEl) {
          const offCanvas = document.createElement('canvas')
          offCanvas.width = 512
          offCanvas.height = 512
          const offCtx = offCanvas.getContext('2d')
          if (offCtx) {
            offCtx.drawImage(imgEl, 0, 0, 512, 512)
            offCtx.drawImage(annotCanvas, 0, 0, 512, 512)
            customB64 = offCanvas.toDataURL('image/png')
          }
        }

        const res = await api<any>('/api/imaging/mpr/slice', {
          method: 'POST',
          body: JSON.stringify({
            sample_id: sampleId,
            plane: currentPlane,
            slice_index: currentSlice,
            window_preset: currentWindow,
            overlay_mask: overlayMask,
            model_name: modelName,
            save_asset: true,
            label,
            custom_png_base64: customB64,
          }),
        })

        if (res.asset_id) {
          saveAssetBtn.innerHTML = `${icon('check')} 已保存当前切片`
          const mdText = res.markdown_insert || `![${label}](asset:${res.asset_id})`
          savedSlices.unshift({ label, assetId: res.asset_id, mdText })

          saveNotice.style.display = 'block'
          saveNotice.innerHTML = `
            <div style="color: var(--teal); font-weight: 600; margin-bottom: 4px">${icon('check')} 本次已保存 ${savedSlices.length} 张切片至资产库：</div>
            <div style="max-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px">
              ${savedSlices.map((s, idx) => `
                <div style="background: rgba(255,255,255,0.06); padding: 4px 6px; border-radius: 4px; display: flex; align-items: center; justify-content: space-between; gap: 6px">
                  <span style="font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${esc(s.label)}</span>
                  <button class="quiet small-btn" data-copy-md="${idx}" style="padding: 2px 6px; font-size: 10.5px">复制</button>
                </div>
              `).join('')}
            </div>
            <div class="muted small">已复制最新 Markdown 引用到剪贴板，可继续滑动保存其他层。</div>
          `
          await navigator.clipboard.writeText(mdText).catch(() => {})
          notice(`切片已存为资产 (${label})，Markdown 已复制！`)

          // 1.5 秒后自动复位，允许再次点击或保存其他层
          setTimeout(() => {
            saveAssetBtn.disabled = false
            saveAssetBtn.innerHTML = `${icon('save')} 保存当前切片为资产`
          }, 1500)
        } else {
          saveAssetBtn.disabled = false
          saveAssetBtn.innerHTML = `${icon('save')} 保存当前切片为资产`
        }
      } catch (err: any) {
        saveAssetBtn.disabled = false
        saveAssetBtn.innerHTML = `${icon('save')} 保存切片为文档资产`
        notice(`保存资产失败: ${err.message || String(err)}`, true)
      }
    })

    saveNotice.addEventListener('click', async ev => {
      const copyBtn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-md]')
      if (!copyBtn) return
      const idx = Number(copyBtn.dataset.copyMd)
      const s = savedSlices[idx]
      if (s) {
        await navigator.clipboard.writeText(s.mdText).catch(() => {})
        copyBtn.textContent = '已复制!'
        setTimeout(() => { copyBtn.textContent = '复制' }, 1200)
        notice(`已复制 ${s.label} 的 Markdown 引用！`)
      }
    })

    // 生成影像所见草稿（只列测值，不给诊断）
    const genReportBtn = dlg.querySelector('#mprGenReportBtn') as HTMLButtonElement
    genReportBtn?.addEventListener('click', async () => {
      // 1. 如果本次尚未手动保存任何切片，自动把当前层切片保存为资产，作为报告关键插图
      if (savedSlices.length === 0) {
        genReportBtn.disabled = true
        genReportBtn.textContent = '正在提取当前关键截面...'
        try {
          const planeNameMap: Record<string, string> = { axial: '轴位', coronal: '冠状位', sagittal: '矢状位' }
          const hasAnnots = (sliceAnnotations.get(annotKey(currentPlane, currentSlice)) || []).length > 0
          const label = `${d.code} MPR ${planeNameMap[currentPlane] || currentPlane} 第 ${currentSlice} 层${hasAnnots ? ' (含手动测量标注)' : ''}`

          let customB64: string | undefined = undefined
          if (hasAnnots && imgEl) {
            const offCanvas = document.createElement('canvas')
            offCanvas.width = 512
            offCanvas.height = 512
            const offCtx = offCanvas.getContext('2d')
            if (offCtx) {
              offCtx.drawImage(imgEl, 0, 0, 512, 512)
              offCtx.drawImage(annotCanvas, 0, 0, 512, 512)
              customB64 = offCanvas.toDataURL('image/png')
            }
          }

          const res = await api<any>('/api/imaging/mpr/slice', {
            method: 'POST',
            body: JSON.stringify({
              sample_id: sampleId,
              plane: currentPlane,
              slice_index: currentSlice,
              window_preset: currentWindow,
              overlay_mask: overlayMask,
              model_name: modelName,
              save_asset: true,
              label,
              custom_png_base64: customB64,
            }),
          })
          if (res.asset_id) {
            const mdText = res.markdown_insert || `![${label}](asset:${res.asset_id})`
            savedSlices.push({ label, assetId: res.asset_id, mdText })
          }
        } catch (e) {
          console.warn('Auto-save current slice for report failed', e)
        } finally {
          genReportBtn.disabled = false
          genReportBtn.innerHTML = `${icon('report')} 生成影像所见草稿`
        }
      }

      // 2. 组装结构化放射报告草案
      const planeNameMap: Record<string, string> = { axial: '轴位 (Axial)', coronal: '冠状位 (Coronal)', sagittal: '矢状位 (Sagittal)' }
      const winNameMap: Record<string, string> = { lung: '肺窗 (Lung, W1500/L-600)', mediastinum: '纵隔窗 (W350/L40)', abdomen: '腹部软组织窗', bone: '骨窗', brain: '脑窗' }
      const curData = sliceCache.get(`${sampleId}:${currentPlane}:${currentSlice}:${currentWindow}:${overlayMask}`)
      const m = (r?.imaging_data as any)?.metrics || {}
      const reportDate = r?.report_date || new Date().toISOString().slice(0, 10)
      const modality = (r?.imaging_data as any)?.modality || mprInfo.modality || '胸部高分辨率 CT (HRCT)'
      const isBronch = (r?.imaging_data as any)?.model_id === 'bronchiectasis_mucus_analyzer' || (r?.title || '').includes('支气管')

      const findingsList: string[] = []
      if (isBronch) {
        if (m.bar_ratio) findingsList.push(`- **支气管-伴行动脉比 (BAR)**: ${m.bar_ratio} (${m.signet_ring_sign ? '> 1.10' : '≤ 1.10'})`)
        if (m.total_mucus_volume_cm3 !== undefined) findingsList.push(`- **支气管管腔粘液栓总体积**: ${m.total_mucus_volume_cm3} cm³`)
        if (m.high_attenuation_mucus_cm3) findingsList.push(`- **高密度粘液栓 (HAM)**: ${m.high_attenuation_mucus_cm3} cm³（CT 值 > 70 HU）`)
        if (m.airway_occlusion_rate_pct !== undefined) findingsList.push(`- **受累气道管腔平均阻塞率**: ${m.airway_occlusion_rate_pct}%`)
        if (m.primary_location) findingsList.push(`- **病灶解剖定位**: ${m.primary_location}`)
      } else {
        if (m.longest_diameter_mm) findingsList.push(`- **靶病灶最大横截面长径**: ${m.longest_diameter_mm} mm`)
        if (m.short_axis_mm) findingsList.push(`- **最大横截面垂直短径**: ${m.short_axis_mm} mm`)
        if (m.total_volume_cm3) findingsList.push(`- **病灶三维体积**: ${m.total_volume_cm3} cm³`)
        if (m.key_slice_index !== undefined) findingsList.push(`- **靶病灶中心层号**: 第 #${m.key_slice_index} 层`)
      }
      if (curData && curData.lesion_present && curData.lesion_pixel_count > 0) {
        findingsList.push(`- **当前浏览视口截面测量**: ${planeNameMap[currentPlane]} 第 #${currentSlice} 层，病灶截面积 ${formatMeasure(roiMeasure(curData.lesion_pixel_count || 0, 1, planeSpacing(curData.pixel_spacing_mm, voxelSpacing, currentPlane as Plane)))}`)
      }

      const manualFindings: string[] = []
      for (const [key, items] of sliceAnnotations.entries()) {
        const parts = key.split(':')
        const pl = parts[0] || 'axial'
        const sl = parts[1] || '0'
        const pName = planeNameMap[pl] || pl
        for (const it of items) {
          if (it.type === 'caliper') {
            manualFindings.push(`- **手动测距卡尺 (${pName} 第 #${sl} 层)**: 长度 ${formatMeasure(it.measure)}`)
          } else if (it.type === 'roi') {
            manualFindings.push(`- **手动感兴趣区截面 (${pName} 第 #${sl} 层)**: 面积 ${formatMeasure(it.measure)}`)
          }
        }
      }
      if (manualFindings.length > 0) {
        findingsList.push(...manualFindings)
      }

      // 只写影像所见：不给诊断结论、分级与处置建议
      const impression = '上述所见需结合临床与实验室检查判断。'
      // 只写影像元数据里有的体素间距（没有时不写，不用默认值）
      const spacingText = voxelSpacing ? `；体素间距 ${voxelSpacing.dx}×${voxelSpacing.dy}×${voxelSpacing.dz} mm` : `；${NO_SPACING_NOTE}，手动测量以像素记录`

      const reportMarkdown = `# 影像所见草稿

**患者代号**: \`${esc(d.code)}\`  
**性别**: ${d.sex === 'M' ? '男' : d.sex === 'F' ? '女' : '未记录'} | **出生年份**: ${d.birth_year || '--'}  
**检查时间**: ${reportDate}  
**模态**: ${esc(modality)}${spacingText}  
**观察方式**: 多平面重建 (MPR)；观察窗 ${winNameMap[currentWindow] || currentWindow.toUpperCase()}  

---

### 一、 影像所见 (Findings)
${findingsList.length > 0 ? findingsList.join('\n') : '- 该影像记录没有可用的量化测值。'}

---

### 二、 关键切片 (Key Slices)
${savedSlices.map(s => `- **${esc(s.label)}**:\n  ${s.mdText}`).join('\n\n')}

---

### 三、 说明
${impression}

> 本草稿只列出算法量化测值与手动测量值，不包含诊断结论与治疗建议，须由执业医师审阅。
`

      showRadiologyReportDraftDialog(patientId, d, `${d.code} 影像所见草稿 (${reportDate})`, reportMarkdown)
    })

    // 初始加载第一张切片
    void loadSlice(currentSlice)
  }

  function showRadiologyReportDraftDialog(patientId: string, d: Detail | Patient, title: string, initialMarkdown: string): void {
    const reportDlg = document.createElement('div')
    reportDlg.className = 'dialog-backdrop'
    reportDlg.id = 'reportDraftDialog'
    reportDlg.innerHTML = `
      <div class="dialog-card pt-rad-report-dialog" role="dialog" aria-modal="true" style="max-width: 780px; width: 92vw; max-height: 88vh; display: flex; flex-direction: column">
        <div class="dialog-head">
          <div style="display: flex; align-items: center; gap: 10px">
            <h2>${icon('report', { size: 18 })} 影像所见草稿</h2>
            <span class="muted small">${esc(d.code)}</span>
          </div>
          <button class="quiet" data-close-draft aria-label="关闭">✕</button>
        </div>
        <div class="dialog-body" style="flex: 1; display: flex; flex-direction: column; gap: 12px; overflow: hidden; padding-bottom: 0">
          <div class="muted small">
            已聚合当前检查序列、3D MPR 切片参数与量化指标。您可以在下方直接微调内容，并复制或落库为正式病历文档：
          </div>
          <div style="flex: 1; min-height: 280px; position: relative">
            <textarea id="radReportDraftText" class="pt-rad-draft-textarea" style="width: 100%; height: 100%; min-height: 320px; resize: none; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 12px; font-family: var(--mono); font-size: 12.5px; line-height: 1.6; color: var(--text)">${esc(initialMarkdown)}</textarea>
          </div>
          <div id="radReportSaveStatus" class="muted small" style="min-height: 18px"></div>
        </div>
        <div class="dialog-foot" style="display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; border-top: 1px solid rgba(255,255,255,0.08)">
          <button class="quiet small-btn" data-close-draft>关闭</button>
          <div style="display: flex; gap: 8px">
            <button class="small-btn quiet" id="radCopyDraftBtn">${icon('copy')} 复制报告全文</button>
            <button class="primary small-btn" id="radSaveDocBtn">${icon('save')} 落库为患者正式病历文档</button>
          </div>
        </div>
      </div>
    `
    document.body.appendChild(reportDlg)

    const closeDraft = () => { reportDlg.remove() }
    reportDlg.onclick = ev => {
      if (ev.target === reportDlg || (ev.target as HTMLElement).closest('[data-close-draft]')) closeDraft()
    }

    const textarea = reportDlg.querySelector('#radReportDraftText') as HTMLTextAreaElement
    const statusEl = reportDlg.querySelector('#radReportSaveStatus') as HTMLElement
    const copyBtn = reportDlg.querySelector('#radCopyDraftBtn') as HTMLButtonElement
    const saveBtn = reportDlg.querySelector('#radSaveDocBtn') as HTMLButtonElement

    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(textarea.value).catch(() => {})
      copyBtn.innerHTML = `${icon('check')} 已复制全文`
      setTimeout(() => { copyBtn.innerHTML = `${icon('copy')} 复制报告全文` }, 1500)
      notice('报告全文已成功复制到剪贴板！')
    }

    saveBtn.onclick = async () => {
      saveBtn.disabled = true
      saveBtn.textContent = '正在保存正式文档...'
      statusEl.textContent = '正在创建平台文档并关联到患者...'
      try {
        const textVal = textarea.value.trim()
        const doc = await api<{ id: string }>('/api/docs', {
          method: 'POST',
          body: JSON.stringify({
            title,
            markdown: textVal,
          }),
        })
        await api(`/api/patients/${patientId}/docs`, {
          method: 'POST',
          body: JSON.stringify({
            doc_id: doc.id,
            kind: 'case_report',
          }),
        })
        statusEl.innerHTML = `<span style="color: var(--teal)">${icon('check')} 文档已成功落库归档！<a href="#/docs/${doc.id}" style="color: var(--blue); margin-left: 8px; text-decoration: underline" target="_blank">${icon('link')} 打开文档进行富文本编辑与排版</a></span>`
        saveBtn.innerHTML = `${icon('check')} 已落库归档`
        notice('影像所见草稿已存入并与患者关联')
        void openPatient(patientId, true)
      } catch (err: any) {
        saveBtn.disabled = false
        saveBtn.innerHTML = `${icon('save')} 落库为患者正式病历文档`
        statusEl.innerHTML = `<span style="color: #F87171">保存失败: ${esc(err.message || String(err))}</span>`
      }
    }
  }

  async function showImagingCompareDialog(patientId: string, d: Detail | Patient, selectedRecordId?: string): Promise<void> {
    const detail = 'records' in d ? (d as Detail) : await api<Detail>(`/api/patients/${patientId}`)
    const imgRecords = detail.records.filter(r => r.kind === 'imaging' && r.imaging_data && r.imaging_data.model_id !== 'recist_longitudinal_comparator')
    if (imgRecords.length < 2) {
      notice('患者需要至少 2 份原始医学影像记录（CT/MRI）才能进行纵向对比评估', true)
      return
    }

    // 按日期正序排列
    const sorted = [...imgRecords].sort((a, b) => {
      const da = a.report_date || a.created_at.slice(0, 10)
      const db = b.report_date || b.created_at.slice(0, 10)
      return new Date(da).getTime() - new Date(db).getTime()
    })

    let defaultBaseId = sorted[0]!.id
    let defaultFollowId = sorted[sorted.length - 1]!.id
    if (selectedRecordId) {
      if (selectedRecordId === sorted[0]!.id) {
        defaultBaseId = sorted[0]!.id
        defaultFollowId = sorted[sorted.length - 1]!.id
      } else {
        defaultBaseId = sorted[0]!.id
        defaultFollowId = selectedRecordId
      }
    }

    const dlg = document.getElementById('dialog')!
    dlg.innerHTML = `
      <div class="dialog-card pt-recist-dialog" role="dialog" aria-modal="true" style="max-height: 92vh; width: 96vw; max-width: 1080px; display: flex; flex-direction: column">
        <div class="dialog-head">
          <div style="display: flex; align-items: center; gap: 10px">
            <h2>${icon('compare', { size: 18 })} 多期影像随访对比与因果诊断工作台</h2>
            <span class="muted small">${esc(detail.code)}</span>
          </div>
          <button class="quiet" data-close-compare aria-label="关闭">✕</button>
        </div>
        <div class="dialog-body" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 14px 18px">
          <!-- 选择对比基线与随访点 -->
          <div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 10px 14px">
            <div style="flex: 1; min-width: 220px">
              <label class="muted small" style="display: flex; align-items: center; gap: 4px; margin-bottom: 4px">${icon('pin')} 基线检查点 (Baseline):</label>
              <select id="compareBaseSelect" style="width: 100%; padding: 6px 10px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: var(--text)">
                ${sorted.map(r => `<option value="${r.id}" ${r.id === defaultBaseId ? 'selected' : ''}>${esc(r.report_date || r.created_at.slice(0, 10))} · ${esc(r.title)}</option>`).join('')}
              </select>
            </div>
            <div style="color: var(--muted); align-self: flex-end; padding-bottom: 8px">${icon('arrowRight', { size: 18 })}</div>
            <div style="flex: 1; min-width: 220px">
              <label class="muted small" style="display: flex; align-items: center; gap: 4px; margin-bottom: 4px">${icon('target')} 随访对比点 (Follow-up):</label>
              <select id="compareFollowSelect" style="width: 100%; padding: 6px 10px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: var(--text)">
                ${sorted.map(r => `<option value="${r.id}" ${r.id === defaultFollowId ? 'selected' : ''}>${esc(r.report_date || r.created_at.slice(0, 10))} · ${esc(r.title)}</option>`).join('')}
              </select>
            </div>
            <button class="primary small-btn" id="compareRunBtn" style="align-self: flex-end; padding: 7px 16px">重新评估</button>
            <span class="grow"></span>
            <div style="display: flex; gap: 8px; align-self: flex-end">
              <button class="small-btn quiet" id="exportFhirBtn" title="导出 HL7 FHIR R4 标准 DiagnosticReport JSON">${icon('download')} 导出 FHIR</button>
              <button class="small-btn quiet" id="exportDicomSrBtn" title="导出 DICOM PS 3.3 TID 1500 结构化报告 JSON">${icon('download')} 导出 DICOM SR</button>
            </div>
          </div>

          <!-- 子导航 Tab 切换 -->
          <div class="pt-compare-nav-tabs">
            <button class="pt-compare-tab active" data-tab-name="overview">${icon('chart')} 随访疗效总览 (RECIST 1.1)</button>
            <button class="pt-compare-tab" data-tab-name="dual-mpr">${icon('mpr')} 双联 MPR 联动切片 (Dual-Scrubber)</button>
            <button class="pt-compare-tab" data-tab-name="evidence">${icon('evidence')} 多模态因果诊断链 (Evidence Chain)</button>
          </div>

          <!-- Tab 1: 随访疗效总览 -->
          <div id="compareTabOverview">
            <div id="compareResultContainer">
              <div class="muted small" style="text-align: center; padding: 30px">正在计算 RECIST 1.1 疗效评估...</div>
            </div>
          </div>

          <!-- Tab 2: 双联 MPR 联动切片 -->
          <div id="compareTabDualMpr" style="display: none">
            <div class="pt-dual-mpr-wrapper">
              <div class="pt-dual-mpr-toolbar">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                  <span class="muted small" style="font-weight: 600">正交平面:</span>
                  <div class="pt-mpr-btn-group" id="dualPlaneBtns">
                    <button data-plane="axial" class="active">轴位 (Axial)</button>
                    <button data-plane="coronal">冠状位 (Coronal)</button>
                    <button data-plane="sagittal">矢状位 (Sagittal)</button>
                  </div>
                </div>

                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                  <span class="muted small" style="font-weight: 600">窗宽窗位:</span>
                  <div class="pt-mpr-btn-group" id="dualWindowBtns">
                    <button data-win="lung" class="active">肺窗</button>
                    <button data-win="mediastinum">纵隔</button>
                    <button data-win="abdomen">腹窗</button>
                    <button data-win="bone">骨窗</button>
                    <button data-win="brain">脑窗</button>
                  </div>
                </div>

                <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap">
                  <label style="cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--teal)">
                    <input type="checkbox" id="dualSyncLock" checked> ${icon('lock')} 锁定同步滚动
                  </label>
                  <label style="cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12.5px">
                    <input type="checkbox" id="dualOverlayMask" checked> 半透明病灶高亮
                  </label>
                  <label style="cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: #10B981; font-weight: 600">
                    <input type="checkbox" id="dualDiffHeatmap"> ${icon('layers')} 叠加 CT 值差分图（CT 值升高 / 降低）
                  </label>
                </div>
              </div>

              <!-- 双联视窗 Grid -->
              <div class="pt-dual-mpr-grid">
                <!-- 左：基线 Viewport -->
                <div class="pt-dual-viewport" id="baseViewport">
                  <div class="pt-dual-viewport-head">
                    <b>${icon('pin')} 基线 (Baseline) · <span id="baseTitleText">--</span></b>
                    <span class="muted small" id="baseDateText">--</span>
                  </div>
                  <div class="pt-dual-viewport-view">
                    <img id="baseMprImg" class="pt-dual-viewport-img" alt="基线切片" style="display: none">
                    <div id="baseMprLoading" class="muted small">加载切片中...</div>
                  </div>
                  <div class="pt-dual-viewport-controls">
                    <div style="display: flex; justify-content: space-between">
                      <span>切片层厚: 第 <b id="baseSliceNum">0</b> / <span id="baseSliceTotal">0</span> 层</span>
                      <span class="muted small" id="baseSliceSpacing">间距 -- mm</span>
                    </div>
                    <input type="range" id="baseSliceSlider" class="pt-dual-scrubber-slider" min="0" max="100" value="50">
                  </div>
                </div>

                <!-- 右：随访 Viewport -->
                <div class="pt-dual-viewport" id="followViewport">
                  <div class="pt-dual-viewport-head">
                    <b>${icon('target')} 本次随访 (Follow-up) · <span id="followTitleText">--</span></b>
                    <span class="muted small" id="followDateText">--</span>
                  </div>
                  <div class="pt-dual-viewport-view">
                    <img id="followMprImg" class="pt-dual-viewport-img" alt="随访切片" style="display: none">
                    <div id="followMprLoading" class="muted small">加载切片中...</div>
                  </div>
                  <div class="pt-dual-viewport-controls">
                    <div style="display: flex; justify-content: space-between">
                      <span>切片层厚: 第 <b id="followSliceNum">0</b> / <span id="followSliceTotal">0</span> 层</span>
                      <span class="muted small" id="followDateText">--</span>
                    </div>
                    <input type="range" id="followSliceSlider" class="pt-dual-scrubber-slider" min="0" max="100" value="50">
                  </div>
                </div>
              </div>
              <div id="diffHeatmapHud" style="display: none; padding: 10px 14px; background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.25); border-radius: 6px; font-size: 12px; margin: 10px 0; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px">
                <span><b>${icon('evidence')} 3D 体素空间差分演变:</b> <span id="diffTrendText" style="color: #34D399; font-weight: 600">--</span></span>
                <span class="muted small" id="diffStatsDetail">--</span>
              </div>
              <div class="muted small" style="text-align: center">支持在任意一侧视窗使用鼠标滚轮上下滑动层厚。当「锁定同步滚动」开启时，两侧视窗按相对解剖比例同步平滑切片。</div>
            </div>
          </div>

          <!-- Tab 3: 多模态因果诊断链 -->
          <div id="compareTabEvidence" style="display: none">
            <div id="compareEvidenceContainer">
              <div class="muted small" style="text-align: center; padding: 30px">正在对齐影像与实验室因果证据链...</div>
            </div>
          </div>
        </div>
      </div>
    `
    dlg.hidden = false
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    dlg.onclick = ev => {
      if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close-compare]')) close()
    }

    const baseSelect = dlg.querySelector('#compareBaseSelect') as HTMLSelectElement
    const followSelect = dlg.querySelector('#compareFollowSelect') as HTMLSelectElement
    const runBtn = dlg.querySelector('#compareRunBtn') as HTMLButtonElement
    const container = dlg.querySelector('#compareResultContainer') as HTMLElement

    // Tab 切换控制
    const tabs = dlg.querySelectorAll<HTMLButtonElement>('.pt-compare-tab')
    const paneOverview = dlg.querySelector('#compareTabOverview') as HTMLElement
    const paneDualMpr = dlg.querySelector('#compareTabDualMpr') as HTMLElement
    const paneEvidence = dlg.querySelector('#compareTabEvidence') as HTMLElement

    let activeTab = 'overview'
    let currentCompareRes: any = null
    let dualMprInitialized = false
    let evidenceLoaded = false

    tabs.forEach(tab => {
      tab.onclick = () => {
        const target = tab.dataset.tabName
        if (!target || target === activeTab) return
        activeTab = target
        tabs.forEach(t => t.classList.toggle('active', t === tab))
        paneOverview.style.display = target === 'overview' ? 'block' : 'none'
        paneDualMpr.style.display = target === 'dual-mpr' ? 'block' : 'none'
        paneEvidence.style.display = target === 'evidence' ? 'block' : 'none'

        if (target === 'dual-mpr' && !dualMprInitialized) {
          void setupDualMpr()
        } else if (target === 'evidence' && !evidenceLoaded) {
          void loadEvidenceChain()
        }
      }
    })

    // 双联 MPR 状态管理
    // 只用记录里真实的样本 ID；没有就为空（服务端会如实返回「没有可用影像」，不用演示样本代替）
    let bSample = ''
    let fSample = ''
    let bReal = false
    let fReal = false
    let bRec: RecordRow | undefined
    let fRec: RecordRow | undefined
    let bData: Record<string, any> = {}
    let fData: Record<string, any> = {}
    let baseMax = 268
    let followMax = 268
    let baseSlice = 134
    let followSlice = 134
    let dualPlane = 'axial'
    let dualWindow = 'lung'
    let dualSyncLock = true
    let dualOverlay = true
    let dualDiffHeatmap = false
    const baseCache = new Map<string, any>()
    const followCache = new Map<string, any>()
    const diffCache = new Map<string, any>()

    function updateDiffHud(data: any) {
      const hud = dlg.querySelector('#diffHeatmapHud') as HTMLElement
      const trendEl = dlg.querySelector('#diffTrendText')
      const detailEl = dlg.querySelector('#diffStatsDetail')
      if (!hud) return
      if (!dualDiffHeatmap || !data?.statistics_3d) {
        hud.style.display = 'none'
        return
      }
      hud.style.display = 'flex'
      // 只显示 HU 变化体积，不给吸收 / 进展之类的趋势结论
      if (trendEl) trendEl.textContent = 'CT 值变化体积'
      if (detailEl) detailEl.innerHTML = `<span style="color:#10B981">● CT 值降低 &gt; ${data.threshold_hu || 50} HU:</span> ${data.statistics_3d.hu_decreased_volume_cm3 ?? '—'} cm³ · <span style="color:#EF4444">● CT 值升高 &gt; ${data.threshold_hu || 50} HU:</span> ${data.statistics_3d.hu_increased_volume_cm3 ?? '—'} cm³（要求两期同网格，未做配准时差值无解剖意义）`
    }

    async function loadComparison() {
      const bId = baseSelect.value
      const fId = followSelect.value
      if (bId === fId) {
        container.innerHTML = `<div style="padding: 24px; text-align: center; color: #FCA5A5">请选择两个不同的检查时间点进行纵向对比。</div>`
        return
      }

      container.innerHTML = `<div class="muted small" style="text-align: center; padding: 30px">正在计算 RECIST 1.1 疗效评估...</div>`
      dualMprInitialized = false
      evidenceLoaded = false

      try {
        const res = await api<any>(`/api/patients/${patientId}/imaging/compare`, {
          method: 'POST',
          body: JSON.stringify({
            baseline_record_id: bId,
            followup_record_id: fId,
          }),
        })
        currentCompareRes = res
        renderComparisonResult(res)
        if (activeTab === 'dual-mpr') void setupDualMpr()
        else if (activeTab === 'evidence') void loadEvidenceChain()
      } catch (err: any) {
        container.innerHTML = `<div style="padding: 24px; text-align: center; color: #FCA5A5">对比计算失败: ${esc(err.message || String(err))}</div>`
      }
    }

    async function setupDualMpr() {
      dualMprInitialized = true
      const bId = baseSelect.value
      const fId = followSelect.value
      bRec = detail.records.find(r => r.id === bId)
      fRec = detail.records.find(r => r.id === fId)

      // 解析样本
      bData = (bRec?.imaging_data || {}) as Record<string, any>
      fData = (fRec?.imaging_data || {}) as Record<string, any>
      bReal = Boolean(patientId && bRec && (bData.raw_file_id || bRec.file_id || bRec.id))
      fReal = Boolean(patientId && fRec && (fData.raw_file_id || fRec.file_id || fRec.id))
      bSample = bData.sample_id || ''
      fSample = fData.sample_id || ''

      // 设置标题
      const bTitleEl = dlg.querySelector('#baseTitleText')
      const bDateEl = dlg.querySelector('#baseDateText')
      const fTitleEl = dlg.querySelector('#followTitleText')
      const fDateEl = dlg.querySelector('#followDateText')
      if (bTitleEl) bTitleEl.textContent = bRec?.title || '基线扫描'
      if (bDateEl) bDateEl.textContent = bRec?.report_date || bRec?.created_at.slice(0, 10) || ''
      if (fTitleEl) fTitleEl.textContent = fRec?.title || '随访扫描'
      if (fDateEl) fDateEl.textContent = fRec?.report_date || fRec?.created_at.slice(0, 10) || ''

      // 获取两份 3D 体积元数据
      try {
        const bUrl = bReal
          ? `/api/imaging/mpr/info?patient_id=${encodeURIComponent(patientId)}&record_id=${encodeURIComponent(bRec!.id)}&file_id=${encodeURIComponent(bData.raw_file_id || bRec!.file_id || '')}`
          : `/api/imaging/mpr/info?sample_id=${encodeURIComponent(bSample)}`
        const fUrl = fReal
          ? `/api/imaging/mpr/info?patient_id=${encodeURIComponent(patientId)}&record_id=${encodeURIComponent(fRec!.id)}&file_id=${encodeURIComponent(fData.raw_file_id || fRec!.file_id || '')}`
          : `/api/imaging/mpr/info?sample_id=${encodeURIComponent(fSample)}`

        const [bInfo, fInfo] = await Promise.all([
          api<any>(bUrl).catch(() => null),
          api<any>(fUrl).catch(() => null),
        ])

        if (bInfo?.planes?.[dualPlane]) {
          baseMax = bInfo.planes[dualPlane].total_slices - 1
          baseSlice = bInfo.center_slice?.[dualPlane] ?? Math.floor(baseMax / 2)
        }
        if (fInfo?.planes?.[dualPlane]) {
          followMax = fInfo.planes[dualPlane].total_slices - 1
          followSlice = fInfo.center_slice?.[dualPlane] ?? Math.floor(followMax / 2)
        }

        const bSlider = dlg.querySelector('#baseSliceSlider') as HTMLInputElement
        const fSlider = dlg.querySelector('#followSliceSlider') as HTMLInputElement
        const bTotalEl = dlg.querySelector('#baseSliceTotal')
        const fTotalEl = dlg.querySelector('#followSliceTotal')
        if (bSlider) { bSlider.max = String(baseMax); bSlider.value = String(baseSlice) }
        if (fSlider) { fSlider.max = String(followMax); fSlider.value = String(followSlice) }
        if (bTotalEl) bTotalEl.textContent = String(baseMax + 1)
        if (fTotalEl) fTotalEl.textContent = String(followMax + 1)

        await Promise.all([updateBaseSlice(baseSlice), updateFollowSlice(followSlice)])
      } catch (err: any) {
        console.error('Failed to load dual mpr info:', err)
      }
    }

    async function updateBaseSlice(idx: number) {
      baseSlice = Math.max(0, Math.min(baseMax, idx))
      const slider = dlg.querySelector('#baseSliceSlider') as HTMLInputElement
      const numEl = dlg.querySelector('#baseSliceNum')
      const imgEl = dlg.querySelector('#baseMprImg') as HTMLImageElement
      const loadEl = dlg.querySelector('#baseMprLoading') as HTMLElement
      if (slider) slider.value = String(baseSlice)
      if (numEl) numEl.textContent = String(baseSlice)

      const key = `${bReal ? `pt_${bRec!.id}` : bSample}_${dualPlane}_${baseSlice}_${dualWindow}_${dualOverlay ? 1 : 0}`
      if (baseCache.has(key)) {
        const data = baseCache.get(key)
        if (imgEl) { imgEl.src = data.slice_png_base64; imgEl.style.display = 'block' }
        if (loadEl) loadEl.style.display = 'none'
        return
      }

      try {
        const body: Record<string, any> = {
          sample_id: bSample,
          plane: dualPlane,
          slice_index: baseSlice,
          window_preset: dualWindow,
          overlay_mask: dualOverlay,
          model_name: bData?.model_id || bData?.model_name,
        }
        if (bReal) {
          body.patient_id = patientId
          body.record_id = bRec!.id
          body.file_id = bData.raw_file_id || bRec!.file_id
        }
        const data = await api<any>('/api/imaging/mpr/slice', {
          method: 'POST',
          body: JSON.stringify(body),
        })
        baseCache.set(key, data)
        if (imgEl && data.slice_png_base64) {
          imgEl.src = data.slice_png_base64
          imgEl.style.display = 'block'
        }
        if (loadEl) loadEl.style.display = 'none'
      } catch {}
    }

    async function updateFollowSlice(idx: number) {
      followSlice = Math.max(0, Math.min(followMax, idx))
      const slider = dlg.querySelector('#followSliceSlider') as HTMLInputElement
      const numEl = dlg.querySelector('#followSliceNum')
      const imgEl = dlg.querySelector('#followMprImg') as HTMLImageElement
      const loadEl = dlg.querySelector('#followMprLoading') as HTMLElement
      if (slider) slider.value = String(followSlice)
      if (numEl) numEl.textContent = String(followSlice)

      if (dualDiffHeatmap) {
        const diffKey = `diff_${bReal ? `pt_${bRec!.id}` : bSample}_${fReal ? `pt_${fRec!.id}` : fSample}_${dualPlane}_${followSlice}_${dualWindow}`
        if (diffCache.has(diffKey)) {
          const data = diffCache.get(diffKey)
          if (imgEl && data.slice_png_base64) { imgEl.src = data.slice_png_base64; imgEl.style.display = 'block' }
          if (loadEl) loadEl.style.display = 'none'
          updateDiffHud(data)
          return
        }
        try {
          const body: Record<string, any> = {
            baseline_id: bSample,
            followup_id: fSample,
            plane: dualPlane,
            slice_index: followSlice,
            window_preset: dualWindow,
            threshold_hu: 50,
          }
          if (bReal || fReal) {
            body.patient_id = patientId
            if (bReal) {
              body.baseline_record_id = bRec!.id
              body.baseline_file_id = bData.raw_file_id || bRec!.file_id
            }
            if (fReal) {
              body.followup_record_id = fRec!.id
              body.followup_file_id = fData.raw_file_id || fRec!.file_id
            }
          }
          const data = await api<any>('/api/imaging/mpr/diff-slice', {
            method: 'POST',
            body: JSON.stringify(body),
          })
          diffCache.set(diffKey, data)
          if (imgEl && data.slice_png_base64) {
            imgEl.src = data.slice_png_base64
            imgEl.style.display = 'block'
          }
          if (loadEl) loadEl.style.display = 'none'
          updateDiffHud(data)
        } catch {}
        return
      }

      updateDiffHud(null)
      const followKey = `${fReal ? `pt_${fRec!.id}` : fSample}_${dualPlane}_${followSlice}_${dualWindow}_${dualOverlay ? 1 : 0}`
      if (followCache.has(followKey)) {
        const data = followCache.get(followKey)
        if (imgEl) { imgEl.src = data.slice_png_base64; imgEl.style.display = 'block' }
        if (loadEl) loadEl.style.display = 'none'
        return
      }

      try {
        const body: Record<string, any> = {
          sample_id: fSample,
          plane: dualPlane,
          slice_index: followSlice,
          window_preset: dualWindow,
          overlay_mask: dualOverlay,
          model_name: fData?.model_id || fData?.model_name,
        }
        if (fReal) {
          body.patient_id = patientId
          body.record_id = fRec!.id
          body.file_id = fData.raw_file_id || fRec!.file_id
        }
        const data = await api<any>('/api/imaging/mpr/slice', {
          method: 'POST',
          body: JSON.stringify(body),
        })
        followCache.set(followKey, data)
        if (imgEl && data.slice_png_base64) {
          imgEl.src = data.slice_png_base64
          imgEl.style.display = 'block'
        }
        if (loadEl) loadEl.style.display = 'none'
      } catch {}
    }


    // 导出标准医学数据
    const exportFhirBtn = dlg.querySelector('#exportFhirBtn') as HTMLButtonElement
    const exportDicomSrBtn = dlg.querySelector('#exportDicomSrBtn') as HTMLButtonElement
    if (exportFhirBtn) {
      exportFhirBtn.onclick = () => {
        const fId = followSelect.value
        window.open(`/api/patients/${patientId}/imaging/export?format=fhir&record_id=${encodeURIComponent(fId)}&download=1`, '_blank')
      }
    }
    if (exportDicomSrBtn) {
      exportDicomSrBtn.onclick = () => {
        const fId = followSelect.value
        window.open(`/api/patients/${patientId}/imaging/export?format=dicom-sr&record_id=${encodeURIComponent(fId)}&download=1`, '_blank')
      }
    }

    // 绑定双联滑动条事件
    const bSlider = dlg.querySelector('#baseSliceSlider') as HTMLInputElement
    const fSlider = dlg.querySelector('#followSliceSlider') as HTMLInputElement
    const syncCheck = dlg.querySelector('#dualSyncLock') as HTMLInputElement
    const overlayCheck = dlg.querySelector('#dualOverlayMask') as HTMLInputElement
    const diffCheck = dlg.querySelector('#dualDiffHeatmap') as HTMLInputElement

    if (syncCheck) {
      syncCheck.onchange = () => { dualSyncLock = syncCheck.checked }
    }
    if (overlayCheck) {
      overlayCheck.onchange = () => {
        dualOverlay = overlayCheck.checked
        void updateBaseSlice(baseSlice)
        void updateFollowSlice(followSlice)
      }
    }
    if (diffCheck) {
      diffCheck.onchange = () => {
        dualDiffHeatmap = diffCheck.checked
        void updateFollowSlice(followSlice)
      }
    }

    if (bSlider) {
      bSlider.oninput = () => {
        const val = Number(bSlider.value)
        void updateBaseSlice(val)
        if (dualSyncLock && baseMax > 0 && followMax > 0) {
          const propF = Math.round((val / baseMax) * followMax)
          void updateFollowSlice(propF)
        }
      }
    }
    if (fSlider) {
      fSlider.oninput = () => {
        const val = Number(fSlider.value)
        void updateFollowSlice(val)
        if (dualSyncLock && baseMax > 0 && followMax > 0) {
          const propB = Math.round((val / followMax) * baseMax)
          void updateBaseSlice(propB)
        }
      }
    }

    // 滚轮联动切片
    const bView = dlg.querySelector('#baseViewport .pt-dual-viewport-view') as HTMLElement
    const fView = dlg.querySelector('#followViewport .pt-dual-viewport-view') as HTMLElement
    const handleWheel = (isBase: boolean, e: WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -1 : 1
      if (isBase) {
        const newB = Math.max(0, Math.min(baseMax, baseSlice + delta))
        void updateBaseSlice(newB)
        if (dualSyncLock && baseMax > 0 && followMax > 0) {
          const propF = Math.round((newB / baseMax) * followMax)
          void updateFollowSlice(propF)
        }
      } else {
        const newF = Math.max(0, Math.min(followMax, followSlice + delta))
        void updateFollowSlice(newF)
        if (dualSyncLock && baseMax > 0 && followMax > 0) {
          const propB = Math.round((newF / followMax) * baseMax)
          void updateBaseSlice(propB)
        }
      }
    }
    bView?.addEventListener('wheel', e => handleWheel(true, e), { passive: false })
    fView?.addEventListener('wheel', e => handleWheel(false, e), { passive: false })

    // 正交平面切换
    const planeBtns = dlg.querySelectorAll<HTMLButtonElement>('#dualPlaneBtns button')
    planeBtns.forEach(btn => {
      btn.onclick = () => {
        const p = btn.dataset.plane
        if (!p || p === dualPlane) return
        dualPlane = p
        planeBtns.forEach(b => b.classList.toggle('active', b === btn))
        void setupDualMpr()
      }
    })

    // 窗宽窗位切换
    const winBtns = dlg.querySelectorAll<HTMLButtonElement>('#dualWindowBtns button')
    winBtns.forEach(btn => {
      btn.onclick = () => {
        const w = btn.dataset.win
        if (!w || w === dualWindow) return
        dualWindow = w
        winBtns.forEach(b => b.classList.toggle('active', b === btn))
        void updateBaseSlice(baseSlice)
        void updateFollowSlice(followSlice)
      }
    })

    // 加载多模态因果诊断链
    async function loadEvidenceChain() {
      evidenceLoaded = true
      const bId = baseSelect.value
      const fId = followSelect.value
      const evBox = dlg.querySelector('#compareEvidenceContainer') as HTMLElement
      evBox.innerHTML = `<div class="muted small" style="text-align: center; padding: 30px">正在对齐影像量化指标与实验室化验检验项目...</div>`
      try {
        const evData = await api<any>(`/api/patients/${patientId}/imaging/evidence-chain?baseline_record_id=${encodeURIComponent(bId)}&followup_record_id=${encodeURIComponent(fId)}`)
        renderEvidenceChainContent(evBox, evData, patientId, detail)
      } catch (err: any) {
        evBox.innerHTML = `<div style="padding: 24px; text-align: center; color: #FCA5A5">获取证据链失败: ${esc(err.message || String(err))}</div>`
      }
    }

    function renderComparisonResult(res: any) {
      const rec = res.recist || {}
      const cat = (rec.category || 'SD').toLowerCase()
      const bImgUrl = res.baseline?.asset_id
        ? `/api/assets/${res.baseline.asset_id}?token=${encodeURIComponent(hooks.token())}`
        : res.baseline?.slice_file_id
        ? `/api/patients/${patientId}/files/${res.baseline.slice_file_id}?token=${encodeURIComponent(hooks.token())}`
        : (res.baseline?.file_id && res.baseline?.file_id !== res.baseline?.raw_file_id)
        ? `/api/patients/${patientId}/files/${res.baseline.file_id}?token=${encodeURIComponent(hooks.token())}`
        : ''
      const fImgUrl = res.followup?.asset_id
        ? `/api/assets/${res.followup.asset_id}?token=${encodeURIComponent(hooks.token())}`
        : res.followup?.slice_file_id
        ? `/api/patients/${patientId}/files/${res.followup.slice_file_id}?token=${encodeURIComponent(hooks.token())}`
        : (res.followup?.file_id && res.followup?.file_id !== res.followup?.raw_file_id)
        ? `/api/patients/${patientId}/files/${res.followup.file_id}?token=${encodeURIComponent(hooks.token())}`
        : ''

      const signLd = rec.percent_change_ld > 0 ? `+${rec.percent_change_ld}%` : `${rec.percent_change_ld}%`
      const signVol = rec.percent_change_volume > 0 ? `+${rec.percent_change_volume}%` : `${rec.percent_change_volume}%`

      container.innerHTML = `
        <!-- 评定总览 Header -->
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 14px">
          <div>
            <div style="display: flex; align-items: center; gap: 10px">
              <span class="pt-recist-badge ${cat}">${rec.category === 'NA' ? `RECIST 不适用 · ${esc(rec.na_reason ?? '')}` : `${esc(rec.category_name)} · ${esc(rec.recist_note ?? '按 RECIST 1.1 阈值计算，未经阅片确认')}`}</span>
              <span class="muted small">随访间隔 <b>${res.interval_days}</b> 天</span>
            </div>
            <div style="font-size: 13px; color: var(--text-1); margin-top: 6px">
              ${esc(rec.interpretation)}
            </div>
          </div>
          <div style="display: flex; gap: 8px">
            <button class="small-btn quiet" id="compareCopyMdBtn">${icon('copy')} 复制 Markdown 报告</button>
            <button class="primary small-btn" id="compareSaveRecBtn">${icon('save')} 保存为随访记录</button>
          </div>
        </div>

        ${rec.vdt ? `
          <div style="margin-top: 10px; padding: 10px 14px; border-radius: 6px; background: ${rec.vdt.clinical_alert ? 'rgba(239,68,68,0.12)' : 'rgba(56,189,248,0.08)'}; border: 1px solid ${rec.vdt.clinical_alert ? 'rgba(239,68,68,0.3)' : 'rgba(56,189,248,0.2)'}; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px">
            <div style="display: flex; align-items: center; gap: 8px">
              <span style="font-weight: 700; color: ${rec.vdt.clinical_alert ? '#F87171' : 'var(--blue)'}">${icon('chart')} 肿瘤动力学体积倍增时间 (Schwartz VDT):</span>
              <span class="pt-recist-badge ${rec.vdt.clinical_alert ? 'pd' : 'sd'}">${esc(rec.vdt.label)}</span>
            </div>
            <div style="font-size: 12px; color: var(--text-2)">
              ${esc(rec.vdt.description)}
            </div>
          </div>
        ` : ''}

        <!-- 双期图像与指标对照 -->
        <div class="pt-recist-dual-grid">
          <div class="pt-recist-card">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <b>基线 (Baseline)</b>
              <span class="muted small">${esc(res.baseline?.date)}</span>
            </div>
            <div class="muted small">${esc(res.baseline?.title)}</div>
            ${bImgUrl ? `
              <div class="pt-recist-thumb-wrap" style="position: relative; overflow: hidden; border-radius: 6px">
                <a href="${bImgUrl}" target="_blank" rel="noreferrer" title="点击新窗口查看基线切片大图" style="display: block; width: 100%; height: 220px; text-decoration: none">
                  <img src="${bImgUrl}" alt="基线切片" class="pt-recist-card-thumb" onerror="this.style.display='none'; if(this.parentElement && this.parentElement.nextElementSibling) this.parentElement.nextElementSibling.style.display='flex'">
                </a>
              </div>
              <div class="pt-imaging-no-img" style="height: 220px; display: none">暂无截面图</div>
            ` : '<div class="pt-imaging-no-img" style="height: 220px">暂无截面图</div>'}
            <div style="font-size: 12.5px; display: flex; flex-direction: column; gap: 4px; margin-top: 4px">
              <div>最大截面长径 (LD): <b>${rec.baseline_ld_mm ?? '--'} mm</b></div>
              <div>3D 总体积 (Volume): <b>${rec.baseline_volume_cm3 ?? '--'} cm³</b></div>
            </div>
          </div>

          <div class="pt-recist-card">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <b>本次随访 (Follow-up)</b>
              <span class="muted small">${esc(res.followup?.date)}</span>
            </div>
            <div class="muted small">${esc(res.followup?.title)}</div>
            ${fImgUrl ? `
              <div class="pt-recist-thumb-wrap" style="position: relative; overflow: hidden; border-radius: 6px">
                <a href="${fImgUrl}" target="_blank" rel="noreferrer" title="点击新窗口查看随访切片大图" style="display: block; width: 100%; height: 220px; text-decoration: none">
                  <img src="${fImgUrl}" alt="随访切片" class="pt-recist-card-thumb" onerror="this.style.display='none'; if(this.parentElement && this.parentElement.nextElementSibling) this.parentElement.nextElementSibling.style.display='flex'">
                </a>
              </div>
              <div class="pt-imaging-no-img" style="height: 220px; display: none">暂无截面图</div>
            ` : '<div class="pt-imaging-no-img" style="height: 220px">暂无截面图</div>'}
            <div style="font-size: 12.5px; display: flex; flex-direction: column; gap: 4px; margin-top: 4px">
              <div>最大截面长径 (LD): <b>${rec.followup_ld_mm ?? '--'} mm</b> <span class="pt-recist-badge ${cat}" style="padding: 2px 6px; font-size: 11px">${signLd}</span></div>
              <div>3D 总体积 (Volume): <b>${rec.followup_volume_cm3 ?? '--'} cm³</b> <span class="pt-recist-badge ${cat}" style="padding: 2px 6px; font-size: 11px">${signVol}</span></div>
            </div>
          </div>
        </div>

        ${bImgUrl && fImgUrl ? `
          <!-- 随访切片动态溶解对比 (Alpha Blending Slider) -->
          <div style="margin-top: 14px; padding: 12px 16px; border-radius: 8px; background: rgba(30, 41, 59, 0.4); border: 1px solid var(--border)">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px">
              <span style="font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px">
                ${icon('eye')} 随访切片动态溶解对比 (Alpha Blending Slider)
              </span>
              <span id="blendOpacityLabel" class="muted small" style="font-family: monospace">随访透明度: 50% (基线 50%)</span>
            </div>
            <div style="position: relative; width: 100%; max-width: 480px; height: 240px; margin: 0 auto; overflow: hidden; border-radius: 6px; background: #000; border: 1px solid rgba(255,255,255,0.08)">
              <img src="${bImgUrl}" id="blendBaseImg" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain" alt="基线底图">
              <img src="${fImgUrl}" id="blendFollowImg" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; opacity: 0.5" alt="随访叠图">
            </div>
            <div style="display: flex; align-items: center; gap: 12px; margin-top: 10px; max-width: 480px; margin-left: auto; margin-right: auto">
              <span class="small muted" style="white-space: nowrap">基线 (0%)</span>
              <input type="range" id="blendSlider" min="0" max="100" value="50" style="flex: 1; cursor: pointer; accent-color: var(--blue, #38BDF8)">
              <span class="small muted" style="white-space: nowrap">随访 (100%)</span>
            </div>
          </div>
        ` : ''}

        <!-- 详细演变对比表格 -->
        <table class="pt-recist-table">
          <thead>
            <tr>
              <th>测量指标</th>
              <th>基线值 (${esc(res.baseline?.date)})</th>
              <th>随访值 (${esc(res.followup?.date)})</th>
              <th>绝对差值 (Δ)</th>
              <th>变化率 (Δ%)</th>
              <th>临床标准</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><b>最大截面长径 (LD)</b></td>
              <td>${rec.baseline_ld_mm ?? '--'} mm</td>
              <td>${rec.followup_ld_mm ?? '--'} mm</td>
              <td>${rec.diff_ld_mm !== undefined ? `${rec.diff_ld_mm > 0 ? '+' : ''}${rec.diff_ld_mm} mm` : '--'}</td>
              <td><b style="color: ${cat === 'pr' || cat === 'cr' ? '#34D399' : cat === 'pd' ? '#F87171' : 'var(--text)'}">${signLd}</b></td>
              <td>RECIST 1.1 靶病灶</td>
            </tr>
            <tr>
              <td><b>3D 肿瘤总体积 (Volume)</b></td>
              <td>${rec.baseline_volume_cm3 ?? '--'} cm³</td>
              <td>${rec.followup_volume_cm3 ?? '--'} cm³</td>
              <td>${rec.diff_volume_cm3 !== undefined ? `${rec.diff_volume_cm3 > 0 ? '+' : ''}${rec.diff_volume_cm3} cm³` : '--'}</td>
              <td><b style="color: ${cat === 'pr' || cat === 'cr' ? '#34D399' : cat === 'pd' ? '#F87171' : 'var(--text)'}">${signVol}</b></td>
              <td>影像分析记录测值</td>
            </tr>
            ${rec.vdt ? `
              <tr>
                <td><b>体积倍增时间 (Schwartz VDT)</b></td>
                <td colspan="2" style="color: ${rec.vdt.clinical_alert ? '#F87171' : 'var(--blue)'}; font-weight: 600">${rec.vdt.days !== null ? `${rec.vdt.days} 天` : '--'}</td>
                <td colspan="2"><span class="pt-recist-badge ${rec.vdt.clinical_alert ? 'pd' : 'sd'}">${esc(rec.vdt.label)}</span></td>
                <td>Schwartz 动力学标准 (&lt;400天高危)</td>
              </tr>
            ` : ''}
          </tbody>
        </table>

        <!-- 结构化报告全文折叠 -->
        <details style="margin-top: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; padding: 10px; border: 1px solid rgba(255,255,255,0.06)">
          <summary style="cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--text-2)">查看学术对比评估报告 Markdown</summary>
          <pre style="margin-top: 10px; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; color: var(--text); max-height: 220px; overflow-y: auto">${esc(res.summary_markdown || '')}</pre>
        </details>
      `

      // 绑定复制按钮
      container.querySelector('#compareCopyMdBtn')?.addEventListener('click', async () => {
        if (res.summary_markdown) {
          await navigator.clipboard.writeText(res.summary_markdown).catch(() => {})
          notice('RECIST 1.1 对比报告已成功复制到剪贴板！')
        }
      })

      // 绑定随访动态溶解对比滑块
      const blendSlider = container.querySelector('#blendSlider') as HTMLInputElement | null
      const blendFollowImg = container.querySelector('#blendFollowImg') as HTMLImageElement | null
      const blendLabel = container.querySelector('#blendOpacityLabel') as HTMLElement | null
      if (blendSlider && blendFollowImg && blendLabel) {
        blendSlider.addEventListener('input', () => {
          const val = Number(blendSlider.value)
          blendFollowImg.style.opacity = String(val / 100)
          blendLabel.textContent = `随访透明度: ${val}% (基线 ${100 - val}%)`
        })
      }

      // 绑定保存为记录按钮
      const saveRecBtn = container.querySelector('#compareSaveRecBtn') as HTMLButtonElement
      saveRecBtn?.addEventListener('click', async () => {
        saveRecBtn.disabled = true
        saveRecBtn.textContent = '正在保存记录...'
        try {
          const saveRes = await api<any>(`/api/patients/${patientId}/imaging/compare`, {
            method: 'POST',
            body: JSON.stringify({
              baseline_record_id: baseSelect.value,
              followup_record_id: followSelect.value,
              save_as_record: true,
            }),
          })
          if (saveRes.record_id) {
            saveRecBtn.innerHTML = `${icon('check')} 已保存记录`
            notice('RECIST 1.1 随访对比评估已存入患者病历记录！')
            void openPatient(patientId, true)
          } else {
            saveRecBtn.disabled = false
            saveRecBtn.innerHTML = `${icon('save')} 保存为随访记录`
          }
        } catch (e: any) {
          saveRecBtn.disabled = false
          saveRecBtn.innerHTML = `${icon('save')} 保存为随访记录`
          notice(`保存失败: ${e.message || String(e)}`, true)
        }
      })
    }

    runBtn.onclick = () => void loadComparison()
    void loadComparison()
  }

  function renderEvidenceChainContent(container: HTMLElement, data: any, patientId: string, d: Detail | Patient, onInjectReport?: (md: string) => void) {
    const criteria = data.criteria_table || []
    const labs = data.matched_labs || []
    const workup = data.suggested_workup || []

    container.innerHTML = `
      <div class="pt-evidence-wrapper">
        <div class="pt-evidence-header-card">
          <div style="flex: 1; min-width: 260px">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
              <span class="muted small">${esc(data.record_title || '医学影像')}</span>
            </div>
            <h3 style="margin: 8px 0 6px; font-size: 16px; color: var(--text)">${icon('evidence', { size: 16 })} ${esc(data.syndrome || '多模态因果诊断链')}</h3>
            <div style="font-size: 13px; line-height: 1.5; color: var(--text-1)">${esc(data.diagnostic_impression || '')}</div>
            <div class="muted small" style="margin-top: 6px">${esc(data.match_summary || '')}</div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap">
            <button class="primary small-btn" id="evGenFullReportBtn">${icon('report')} 生成影像所见报告</button>
            <button class="small-btn quiet" id="evCopyMdBtn">${icon('copy')} 复制 Markdown</button>
            <button class="small-btn quiet" id="evInjectReportBtn">${icon('write')} 注入病例报告草案</button>
          </div>
        </div>

        <div>
          <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--text-2)">${icon('template')} 指标与参考阈值对照（不构成诊断）</div>
          <table class="pt-evidence-table">
            <thead>
              <tr>
                <th>诊断准则要点</th>
                <th>证据类别</th>
                <th>判定状态</th>
                <th>患者客观实测值</th>
                <th>参考临床指南</th>
              </tr>
            </thead>
            <tbody>
              ${criteria.map((c: any) => `
                <tr>
                  <td><b>${esc(c.criterion)}</b></td>
                  <td class="muted small">${c.category === 'imaging' ? '医学影像' : c.category === 'lab' ? '实验室化验' : '既往病史'}</td>
                  <td>
                    <span class="pt-evidence-tag-status ${esc(c.status)}">
                      ${c.status === 'positive' ? `${icon('check', { size: 12 })} 阳性` : c.status === 'negative' ? '阴性' : `${icon('info', { size: 12 })} 缺漏待查`}
                    </span>
                  </td>
                  <td>${esc(c.evidence_value)}</td>
                  <td class="muted small">${esc(c.reference_guideline)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>

        ${labs.length > 0 ? `
          <div>
            <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--text-2)">${icon('dna')} 协同关键实验室指标 (Correlated Laboratory Markers)</div>
            <table class="pt-evidence-table">
              <thead>
                <tr>
                  <th>化验项目</th>
                  <th>检测数值</th>
                  <th>异常标识</th>
                  <th>采样日期</th>
                  <th>临床因果关联解读</th>
                </tr>
              </thead>
              <tbody>
                ${labs.map((l: any) => `
                  <tr>
                    <td><b>${esc(l.test_name)}</b></td>
                    <td>${esc(l.value)} ${esc(l.unit || '')}</td>
                    <td><span class="${l.flag === 'H' ? 'flag-H' : l.flag === 'L' ? 'flag-L' : 'muted'}">${l.flag === 'H' ? '↑ 升高' : l.flag === 'L' ? '↓ 降低' : '正常'}</span></td>
                    <td class="muted small">${esc(l.date)}</td>
                    <td style="font-size: 12px">${esc(l.clinical_significance)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : ''}

        ${workup.length > 0 ? `
          <div style="background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.2); border-radius: 6px; padding: 12px">
            <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px; color: #FBBF24">${icon('sparkles')} 临床指南推荐完善检查 / 诊疗路径</div>
            <ol style="margin: 0; padding-left: 20px; font-size: 12.5px; line-height: 1.6; color: var(--text-1)">
              ${workup.map((w: string) => `<li>${esc(w)}</li>`).join('')}
            </ol>
          </div>
        ` : ''}
      </div>
    `

    container.querySelector('#evGenFullReportBtn')?.addEventListener('click', () => {
      void showFullDiagnosticReportDialog(patientId, d, data.record_id)
    })

    container.querySelector('#evCopyMdBtn')?.addEventListener('click', async () => {
      if (data.summary_markdown) {
        await navigator.clipboard.writeText(data.summary_markdown).catch(() => {})
        notice('多模态因果诊断链 Markdown 已复制到剪贴板！')
      }
    })

    container.querySelector('#evInjectReportBtn')?.addEventListener('click', () => {
      if (onInjectReport) {
        onInjectReport(data.summary_markdown)
      } else {
        const prompt = `请依据患者 ${d.code} 的多模态因果诊断证据链分析结果撰写专业临床病例报告：\n\n${data.summary_markdown}\n\n请按病史摘要、多模态证据链三角比对、诊断与鉴别诊断、下一步治疗方案展开撰写。`
        hooks.prefillChat(prompt)
        notice('已将多模态诊断证据链指令填入 AI 对话框，可直接确认发送！')
      }
    })
  }

  async function showEvidenceChainDialog(patientId: string, d: Detail | Patient, recordId?: string): Promise<void> {
    const dlg = document.getElementById('dialog')!
    dlg.innerHTML = `
      <div class="dialog-card pt-rad-report-dialog" role="dialog" aria-modal="true" style="max-height: 92vh; width: 95vw; max-width: 900px; display: flex; flex-direction: column">
        <div class="dialog-head">
          <div style="display: flex; align-items: center; gap: 10px">
            <h2>${icon('evidence', { size: 18 })} 多模态因果诊断证据链 (Multimodal Evidence Chain)</h2>
            <span class="muted small">${esc(d.code)}</span>
          </div>
          <button class="quiet" data-close aria-label="关闭">✕</button>
        </div>
        <div class="dialog-body" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 16px 20px">
          <div class="muted small" style="text-align: center; padding: 30px">正在对齐影像量化指标与实验室化验检验项目...</div>
        </div>
      </div>`
    dlg.hidden = false
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) close() }

    try {
      const url = `/api/patients/${patientId}/imaging/evidence-chain${recordId ? `?record_id=${encodeURIComponent(recordId)}` : ''}`
      const evData = await api<any>(url)
      renderEvidenceChainContent(dlg.querySelector('.dialog-body')!, evData, patientId, d)
    } catch (err: any) {
      const b = dlg.querySelector('.dialog-body')
      if (b) b.innerHTML = `<div style="padding: 24px; text-align: center; color: #FCA5A5">获取证据链失败: ${esc(err.message || String(err))}</div>`
    }
  }

  async function showFullDiagnosticReportDialog(patientId: string, d: Detail | Patient, recordId?: string): Promise<void> {
    const dlg = document.getElementById('dialog')!
    dlg.innerHTML = `
      <div class="dialog-card pt-full-report-dialog" role="dialog" aria-modal="true">
        <div class="dialog-head no-print">
          <div style="display: flex; align-items: center; gap: 10px">
            <h2>${icon('hospital', { size: 18 })} 影像量化所见报告</h2>
            <span class="muted small">${esc(d.code)}</span>
          </div>
          <button class="quiet" data-close aria-label="关闭">✕</button>
        </div>
        <div class="dialog-body" style="flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; padding: 20px">
          <div class="muted small" style="text-align: center; padding: 36px">
            <div class="pt-img-dlg-loading">正在汇总影像量化测值与相关化验…</div>
          </div>
        </div>
      </div>`
    dlg.hidden = false
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) close() }

    try {
      const res = await api<any>(`/api/patients/${patientId}/imaging/full-report`, {
        method: 'POST',
        body: JSON.stringify({ record_id: recordId, save_to_records: true }),
      })

      const body = dlg.querySelector('.dialog-body')
      if (!body) return

      const m = res.metrics || {}
      const ev = res.evidence || {}
      const matchedLabs: any[] = ev.matched_labs || []
      const rptId = `RPT-${res.patient_code}-${(res.exam_date || '').replace(/-/g, '')}-01`

      body.innerHTML = `
        <!-- 视图切换与顶部操作栏 -->
        <div class="no-print" style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 4px">
          <div style="display: flex; gap: 6px" id="reportViewTabs">
            <button class="small-btn primary" data-view="formatted">${icon('eye')} 临床标准报告排版</button>
            <button class="small-btn quiet" data-view="markdown">${icon('write')} Markdown 源码编辑</button>
          </div>
          <div style="display: flex; gap: 8px; align-items: center">
            <button class="small-btn quiet" id="btnCopyFullReportMd">${icon('copy')} 复制 Markdown</button>
            <button class="small-btn primary" id="btnPrintFullReport">${icon('print')} 打印 / 导出 PDF</button>
          </div>
        </div>

        <!-- 格式化排版区 (同时作为打印区域) -->
        <div id="fullReportPrintArea" class="pt-report-paper" style="display: block">
          <div class="pt-report-hospital-head">
            <div class="pt-report-hospital-title">${icon('hospital')} 影像量化所见报告</div>
            <div class="pt-report-hospital-sub">Medical Imaging &amp; Multimodal Diagnostic Report · 依据 RECIST 1.1 / Fleischner / CARE 规范生成</div>
          </div>

          <div class="pt-report-patient-grid">
            <div><div class="item-label">患者代号</div><div class="item-val">${esc(res.patient_code)}</div></div>
            <div><div class="item-label">性别 / 出生年</div><div class="item-val">${d.sex === 'M' ? '男' : d.sex === 'F' ? '女' : '未知'} / ${d.birth_year || '--'}</div></div>
            <div><div class="item-label">检查日期</div><div class="item-val">${esc(res.exam_date)}</div></div>
            <div><div class="item-label">设备模态</div><div class="item-val">${esc(res.modality)}</div></div>
            <div><div class="item-label">检查项目</div><div class="item-val">${esc(res.title)}</div></div>
            <div><div class="item-label">报告流水号</div><div class="item-val">${esc(rptId)}</div></div>
          </div>

          <!-- 核心量化指标面板 -->
          <div class="pt-report-sec">
            <div class="pt-report-sec-h">一、 核心 3D 定量与靶病灶测值 (Quantitative Measurements)</div>
            <div class="pt-report-metrics-grid">
              ${m.longest_diameter_mm !== undefined ? `
                <div class="pt-report-metric-card ${m.longest_diameter_mm > 8 ? 'alert' : ''}">
                  <div class="pt-report-metric-title">RECIST 1.1 最大长径</div>
                  <div class="pt-report-metric-value">${m.longest_diameter_mm} mm</div>
                </div>
              ` : ''}
              ${m.short_axis_mm !== undefined ? `
                <div class="pt-report-metric-card">
                  <div class="pt-report-metric-title">垂直短径 (Short Axis)</div>
                  <div class="pt-report-metric-value">${m.short_axis_mm} mm</div>
                </div>
              ` : ''}
              ${m.total_volume_cm3 !== undefined ? `
                <div class="pt-report-metric-card">
                  <div class="pt-report-metric-title">3D 病灶总体积 (Volume)</div>
                  <div class="pt-report-metric-value">${m.total_volume_cm3} cm³</div>
                </div>
              ` : ''}
              ${m.bar_ratio !== undefined ? `
                <div class="pt-report-metric-card ${m.bar_ratio > 1.10 ? 'alert' : ''}">
                  <div class="pt-report-metric-title">支气管-伴行动脉比 (BAR)</div>
                  <div class="pt-report-metric-value">${m.bar_ratio} ${m.bar_ratio > 1.10 ? '(> 1.10)' : ''}</div>
                </div>
              ` : ''}
              ${m.high_attenuation_mucus_cm3 !== undefined || m.ham_density_confirmed ? `
                <div class="pt-report-metric-card alert">
                  <div class="pt-report-metric-title">高密度粘液栓 (HAM)</div>
                  <div class="pt-report-metric-value">${m.high_attenuation_mucus_cm3 ? `${m.high_attenuation_mucus_cm3} cm³` : '可见 (>70 HU)'}</div>
                </div>
              ` : ''}
              ${m.key_slice_index !== undefined ? `
                <div class="pt-report-metric-card">
                  <div class="pt-report-metric-title">靶病灶中心层号</div>
                  <div class="pt-report-metric-value">第 #${m.key_slice_index} 层</div>
                </div>
              ` : ''}
            </div>
          </div>

          <!-- 多模态实验室化验 -->
          ${matchedLabs.length > 0 ? `
            <div class="pt-report-sec">
              <div class="pt-report-sec-h">二、 相关化验 (Laboratory)</div>
              <table class="pt-evidence-table">
                <thead>
                  <tr><th>化验项目</th><th>测得数值</th><th>相对参考区间</th><th>采样日期</th></tr>
                </thead>
                <tbody>
                  ${matchedLabs.map(l => `
                    <tr>
                      <td><b>${esc(l.test_name)}</b></td>
                      <td>${esc(l.value)} ${esc(l.unit || '')}</td>
                      <td><span class="${l.flag === 'H' ? 'flag-H' : l.flag === 'L' ? 'flag-L' : 'muted'}">${l.flag === 'H' ? '↑ 高于' : l.flag === 'L' ? '↓ 低于' : '未超出 / 未标注'}</span></td>
                      <td class="muted small">${esc(l.date)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : ''}

          <!-- 影像学所见 -->
          <div class="pt-report-sec">
            <div class="pt-report-sec-h">三、 影像学所见 (Findings)</div>
            <div style="font-size: 13px; line-height: 1.7; white-space: pre-line">${esc(res.findings)}</div>
          </div>

          <!-- 说明：不给诊断结论与处置建议 -->
          <div class="pt-report-sec">
            <div class="pt-report-sec-h">四、 说明</div>
            <div style="font-size: 13px; line-height: 1.7; white-space: pre-line">${esc(res.impression)}</div>
          </div>

          <!-- 报告落款 -->
          <div class="pt-report-signature-row">
            <div>检查日期: <b>${esc(res.exam_date)}</b></div>
            <div>${!res.saved_record_id ? '<span class="pill">未存入病历</span>' : res.saved_status === 'pending' ? '<span class="pill warn">AI 草稿 · 待医生在「待确认」中确认</span>' : `<span class="pill ok">${icon('check', { size: 12 })} 已存入病历</span>`}</div>
          </div>
        </div>

        <!-- Markdown 源码微调编辑区 (默认隐藏) -->
        <div id="fullReportMarkdownArea" style="display: none; flex-direction: column; gap: 10px">
          <textarea id="fullReportMarkdownText" style="width: 100%; min-height: 480px; resize: vertical; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; padding: 14px; font-family: var(--mono); font-size: 12.5px; line-height: 1.6; color: var(--text)">${esc(res.full_report_markdown)}</textarea>
          <div class="muted small">您可以在上方直接微调 Markdown 文本，并复制用于学术讨论或病历系统录入。</div>
        </div>
      `

      // 绑定 Tab 切换
      const tabs = body.querySelector('#reportViewTabs')
      const printArea = body.querySelector('#fullReportPrintArea') as HTMLElement
      const mdArea = body.querySelector('#fullReportMarkdownArea') as HTMLElement
      const textarea = body.querySelector('#fullReportMarkdownText') as HTMLTextAreaElement

      tabs?.addEventListener('click', e => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-view]')
        if (!btn) return
        tabs.querySelectorAll('button').forEach(b => {
          b.className = 'small-btn quiet'
        })
        btn.className = 'small-btn primary'
        if (btn.dataset.view === 'markdown') {
          printArea.style.display = 'none'
          mdArea.style.display = 'flex'
        } else {
          printArea.style.display = 'block'
          mdArea.style.display = 'none'
        }
      })

      // 复制 Markdown
      body.querySelector('#btnCopyFullReportMd')?.addEventListener('click', async () => {
        const text = textarea ? textarea.value : res.full_report_markdown
        await navigator.clipboard.writeText(text).catch(() => {})
        notice('全景影像诊断报告 Markdown 已成功复制到剪贴板！')
      })

      // 打印 / 导出 PDF
      body.querySelector('#btnPrintFullReport')?.addEventListener('click', () => {
        window.print()
      })

      notice('全景多模态影像诊断报告已生成，并自动同步存入病历档案！')
      void openPatient(patientId, true)
    } catch (err: any) {
      const body = dlg.querySelector('.dialog-body')
      if (body) {
        body.innerHTML = `<div style="padding: 30px; text-align: center; color: #FCA5A5">生成全景报告失败: ${esc(err.message || String(err))}</div>`
      }
    }
  }

  async function showClaimDialog(patientId: string, d: Detail | Patient): Promise<void> {
    const data = await api<{
      claims: Array<{ id: string; code: string; status: string; expires_at: string; created_at: string; requested_at: string | null; confirmed_at: string | null; claimant_info?: { birth_year?: number | null } }>;
      links: Array<{ id: string; status: string; verified_at: string }>;
    }>(`/api/patients/${patientId}/claims`)
    const dlg = document.getElementById('dialog')!
    const activeClaim = data.claims.find(c => c.status === 'active')
    const requestedClaim = data.claims.find(c => c.status === 'requested')
    const activeLink = data.links.find(l => l.status === 'active')

    const renderClaimHtml = () => `
      <div class="dialog-card" role="dialog" aria-modal="true" aria-label="就诊认领与知家绑定">
        <div class="dialog-head"><h2>${esc(d.code)} 就诊认领与知家绑定</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
        <div class="dialog-body" style="gap: 16px">
          ${activeLink ? `
            <div class="banner" style="background: var(--green-soft); border-color: var(--green-line)">
              <span class="dot"></span>
              <div><b>已绑定知家家庭档案！</b><div class="muted small">关联编号：${esc(activeLink.id)} · 绑定于 ${new Date(activeLink.verified_at).toLocaleString('zh-CN', { hour12: false })}</div></div>
              <button class="danger quiet" id="btnUnlink" style="margin-left: auto">解除绑定</button>
            </div>
          ` : requestedClaim ? `
            <div class="banner pt-pending" style="flex-direction: column; align-items: flex-start; gap: 8px">
              <div style="display: flex; gap: 8px; align-items: center">
                <span class="dot"></span>
                <b>知家端已提交认领申请！</b>
                <span class="chip">${requestedClaim.claimant_info?.birth_year ? `${requestedClaim.claimant_info.birth_year} 年生` : '未提供出生年份'}</span>
              </div>
              <div class="muted small">为防止错认或手误，请核对患者信息并输入出生年份进行二次核验后确认绑定。</div>
              <div class="field-row" style="width: 100%; margin-top: 4px">
                <input type="number" id="claimBirthYear" placeholder="输入患者出生年份（如 1985）核对" style="max-width: 220px">
                <button class="primary" id="btnConfirmClaim">确认绑定（医生本人）</button>
                <button class="quiet" id="btnRejectClaim">驳回申请</button>
              </div>
            </div>
          ` : activeClaim ? `
            <div class="invite-link">
              <div class="muted small">患者知家认领码（24 小时有效，一码一用）：</div>
              <div class="field-row">
                <input type="text" readonly value="${esc(activeClaim.code)}" style="font-size: 16px; font-weight: 600; letter-spacing: 2px">
                <button type="button" class="primary" id="btnCopyClaim">复制</button>
              </div>
              <div class="row" style="justify-content: space-between; margin-top: 4px">
                <span class="muted small">有效期至：${new Date(activeClaim.expires_at).toLocaleString('zh-CN', { hour12: false })}</span>
                <button class="quiet danger-text" id="btnRevokeClaim" style="font-size: 12px">撤销认领码</button>
              </div>
            </div>
          ` : `
            <div class="muted small">
              生成 24 小时有效的专属就诊认领码。患者或家属在知家移动端输入该认领码后，系统将建立医院病历与家庭档案的安全链接。
            </div>
            <div class="row">
              <button class="primary" id="btnGenClaim">生成 24 小时就诊认领码</button>
            </div>
          `}

          <h3 class="mem-h" style="margin-top: 14px">认领历史记录</h3>
          ${data.claims.length === 0 ? '<div class="muted small">暂无认领记录</div>' : `
            <table class="users" style="font-size: 12px">
              <thead><tr><th>认领码</th><th>状态</th><th>生成时间</th><th>处理时间</th></tr></thead>
              <tbody>${data.claims.map(c => `<tr>
                <td style="font-family: var(--mono)">${esc(c.code)}</td>
                <td>${c.status === 'confirmed' ? '<span class="pill ok">已绑定</span>' : c.status === 'requested' ? '<span class="pill warn">待确认</span>' : c.status === 'active' ? '<span class="pill">生效中</span>' : c.status === 'expired' ? '<span class="pill off">已过期</span>' : '<span class="pill off">已撤销</span>'}</td>
                <td class="muted">${new Date(c.created_at).toLocaleString('zh-CN', { hour12: false })}</td>
                <td class="muted">${c.confirmed_at ? new Date(c.confirmed_at).toLocaleString('zh-CN', { hour12: false }) : c.requested_at ? new Date(c.requested_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
              </tr>`).join('')}</tbody>
            </table>
          `}
        </div>
      </div>`

    dlg.innerHTML = renderClaimHtml()
    dlg.hidden = false
    const close = () => { dlg.hidden = true; dlg.innerHTML = '' }
    dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) close() }

    dlg.querySelector('#btnCopyClaim')?.addEventListener('click', async () => {
      if (activeClaim) {
        await navigator.clipboard.writeText(activeClaim.code).catch(() => {})
        notice('已复制认领码')
      }
    })
    dlg.querySelector('#btnGenClaim')?.addEventListener('click', async () => {
      try {
        await api(`/api/patients/${patientId}/claims`, { method: 'POST' })
        notice('认领码已生成')
        await showClaimDialog(patientId, d)
      } catch (err) { notice((err as Error).message, true) }
    })
    dlg.querySelector('#btnRevokeClaim')?.addEventListener('click', async () => {
      if (activeClaim) {
        try {
          await api(`/api/claims/${activeClaim.id}`, { method: 'DELETE' })
          notice('认领码已撤销')
          await showClaimDialog(patientId, d)
        } catch (err) { notice((err as Error).message, true) }
      }
    })
    dlg.querySelector('#btnUnlink')?.addEventListener('click', async () => {
      const activeClaimId = data.claims.find(c => c.status === 'confirmed')?.id
      if (activeClaimId && await askConfirm({ title: '解除关联', message: '解除与知家家庭成员的档案关联？解除后医院端病历数据仍保留。', confirm: '解除绑定', danger: true })) {
        try {
          await api(`/api/claims/${activeClaimId}`, { method: 'DELETE' })
          notice('已解除绑定')
          await showClaimDialog(patientId, d)
        } catch (err) { notice((err as Error).message, true) }
      }
    })
    dlg.querySelector('#btnRejectClaim')?.addEventListener('click', async () => {
      if (requestedClaim) {
        try {
          await api(`/api/claims/${requestedClaim.id}`, { method: 'DELETE' })
          notice('已驳回认领申请')
          await showClaimDialog(patientId, d)
        } catch (err) { notice((err as Error).message, true) }
      }
    })
    dlg.querySelector('#btnConfirmClaim')?.addEventListener('click', async () => {
      if (requestedClaim) {
        const yearInput = (dlg.querySelector('#claimBirthYear') as HTMLInputElement).value.trim()
        const year = yearInput ? Number(yearInput) : undefined
        try {
          await api(`/api/claims/${requestedClaim.id}/confirm`, { method: 'POST', body: JSON.stringify({ birth_year: year }) })
          notice('病历与知家家庭档案绑定成功！')
          await showClaimDialog(patientId, d)
        } catch (err) { notice((err as Error).message, true) }
      }
    })
  }

  // —— 事件 ——

  document.getElementById('page')!.addEventListener('click', async e => {
    if (!current || !document.getElementById('page')!.classList.contains('patient-page')) return
    const t = e.target as HTMLElement
    const id = current
    const d = await (async () => list.find(p => p.id === id) ?? await api<Patient>(`/api/patients/${id}`))()
    const tabBtn = t.closest<HTMLElement>('[data-tab]')
    if (tabBtn) { tab = tabBtn.dataset.tab as typeof tab; void openPatient(id, true); return }
    const trend = t.closest<HTMLElement>('tr[data-trend]')
    if (trend) { void showTrend(trend.dataset.trend!, trend.closest('table')!); return }
    if (t.closest('[data-trend-close]')) { document.getElementById('ptTrendBox')?.remove(); return }
    const opendoc = t.closest<HTMLElement>('[data-opendoc]')
    if (opendoc) { current = null; await hooks.openDoc(opendoc.dataset.opendoc!); return }
    const study = t.closest<HTMLElement>('[data-study]')
    if (study && hooks.openStudy) { current = null; await hooks.openStudy(study.dataset.study!); return }
    const file = t.closest<HTMLElement>('[data-file]')
    if (file) { window.open(`/api/patients/${id}/files/${file.dataset.file}?token=${encodeURIComponent(hooks.token())}`, '_blank'); return }

    const viewImg = t.closest<HTMLElement>('[data-view-img]')
    if (viewImg) {
      const url = viewImg.dataset.viewImg || (viewImg as HTMLImageElement).src
      if (url) showImageLightbox(url)
      return
    }

    const genFullReport = t.closest<HTMLElement>('[data-generate-full-report]')
    if (genFullReport) {
      const recId = genFullReport.dataset.generateFullReport
      const detail = await api<Detail>(`/api/patients/${id}`)
      await showFullDiagnosticReportDialog(id, detail, recId === 'latest' ? undefined : recId)
      return
    }

    const imgReport = t.closest<HTMLElement>('[data-img-report]')
    if (imgReport) {
      const recId = imgReport.dataset.imgReport
      const detail = await api<Detail>(`/api/patients/${id}`)
      const r = detail.records.find(x => x.id === recId)
      if (r) await writeImagingReport(detail, r)
      return
    }

    const imgCanvas = t.closest<HTMLElement>('[data-img-canvas]')
    if (imgCanvas) {
      const recId = imgCanvas.dataset.imgCanvas
      const detail = await api<Detail>(`/api/patients/${id}`)
      const r = detail.records.find(x => x.id === recId)
      if (r) await makeImagingSlideDeck(detail, r)
      return
    }

    const openMpr = t.closest<HTMLElement>('[data-open-mpr]')
    if (openMpr) {
      const recId = openMpr.dataset.openMpr
      const detail = await api<Detail>(`/api/patients/${id}`)
      const r = recId === 'latest' ? detail.records.find(x => x.kind === 'imaging') : detail.records.find(x => x.id === recId)
      await showMprViewerDialog(id, detail, r)
      return
    }

    const openEvidence = t.closest<HTMLElement>('[data-open-evidence]')
    if (openEvidence) {
      const recId = openEvidence.dataset.openEvidence
      const detail = await api<Detail>(`/api/patients/${id}`)
      const r = recId === 'latest' ? detail.records.find(x => x.kind === 'imaging') : detail.records.find(x => x.id === recId)
      await showEvidenceChainDialog(id, detail, r?.id)
      return
    }

    const compareWith = t.closest<HTMLElement>('[data-compare-with]')
    if (compareWith) {
      const recId = compareWith.dataset.compareWith
      const detail = await api<Detail>(`/api/patients/${id}`)
      await showImagingCompareDialog(id, detail, recId)
      return
    }

    const exportStandard = t.closest<HTMLElement>('[data-export-standard]')
    if (exportStandard) {
      const recId = exportStandard.dataset.exportStandard
      const choice = await askText({
        title: '导出国际医学行业标准交换格式',
        label: '请选择格式：\n1. HL7 FHIR R4 DiagnosticReport (JSON)\n2. DICOM SR (TID 1500 Structured Reporting JSON)',
        value: '1',
        confirm: '下载',
        hint: '输入 1 下载 FHIR 资源，输入 2 下载 DICOM SR 报告',
      })
      if (!choice) return
      const fmt = choice.trim() === '2' ? 'dicom-sr' : 'fhir'
      window.open(`/api/patients/${id}/imaging/export?format=${fmt}&record_id=${encodeURIComponent(recId || '')}&download=1`, '_blank')
      return
    }

    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
    if (act === 'ptmore') { const m = document.getElementById('ptMore'); if (m) m.hidden = !m.hidden; return }
    document.getElementById('ptMore')?.setAttribute('hidden', '')
    try {
      if (act === 'compare-imaging') {
        const detail = await api<Detail>(`/api/patients/${id}`)
        await showImagingCompareDialog(id, detail)
      } else if (act === 'alias') {
        const n = await askText({ title: '本机备注姓名', label: `${d.code} 的姓名（只存在这台电脑的浏览器里，平台不保存、不发给 AI）`, value: names()[id] ?? '', confirm: '保存' })
        if (n !== null) { setName(id, n); void openPatient(id, true) }
      } else if (act === 'tags') {
        const v = await askText({ title: '诊断标签', label: '用逗号分开', value: d.tags.join('，'), confirm: '保存' })
        if (v !== null) { await api(`/api/patients/${id}`, { method: 'PATCH', body: JSON.stringify({ tags: v.split(/[,，、;；]/).map(x => x.trim()).filter(Boolean) }) }); await loadList(); void openPatient(id, true) }
      } else if (act === 'upload') {
        (document.getElementById('ptUpload') as HTMLInputElement).click()
      } else if (act === 'imaging') {
        await showImagingDialog(id, d)
      } else if (act === 'report') {
        await writeReport(d)
      } else if (act === 'claim') {
        await showClaimDialog(id, d)
      } else if (act === 'team') {
        const [colleagues, detail] = await Promise.all([api<any[]>('/api/tenant/colleagues'), api<Detail>(`/api/patients/${id}`)])
        const inTeam = new Set(detail.care_team.map(m => m.user_id))
        const add = colleagues.filter(c => !inTeam.has(c.id))
        const who = await askText({ title: '诊疗组', label: `现在：${detail.care_team.map(m => m.name).join('、')}。加入谁？（用户名）`, placeholder: add.map(c => c.username).slice(0, 5).join(' / '), confirm: '加入', hint: '诊疗组成员能查看和修改这位患者；要移出某人，在用户名前加「-」，例如 -nurse_li' })
        if (!who) return
        const name = who.trim().replace(/^-/, '')
        const target = colleagues.find(c => c.username === name || c.display_name === name)
        if (!target) { notice('本机构没有这位成员', true); return }
        if (who.trim().startsWith('-')) await api(`/api/patients/${id}/team/${target.id}`, { method: 'DELETE' })
        else await api(`/api/patients/${id}/team`, { method: 'POST', body: JSON.stringify({ user_id: target.id }) })
        notice('诊疗组已更新'); void openPatient(id, true)
      } else if (act === 'log') {
        const rows = await api<any[]>(`/api/patients/${id}/access-log`)
        const ACTION: Record<string, string> = { create: '新建', view: '查看', update: '修改', labs_read: '读化验', lab_add: '补录化验项', doc_link: '关联报告', doc_unlink: '取消关联', lab_confirm: '确认化验', lab_reject: '删除化验', lab_edit: '修改化验', file_upload: '上传报告', file_download: '查看原件', record_confirm: '确认报告', record_reject: '驳回报告', imaging_analyze: '影像量化分析', propose: '提议', proposal_accept: '采纳提议', proposal_reject: '不采纳提议', team_add: '加入诊疗组', team_remove: '移出诊疗组', break_glass: '紧急访问', delete: '删除', cohort_screen: '研究筛选', enroll: '入组研究', unenroll: '移出研究', cohort_export: '生成研究数据集' }
        const dlg = document.getElementById('dialog')!
        dlg.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="访问记录"><div class="dialog-head"><h2>${esc(d.code)} 访问记录</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
          <div class="dialog-body"><table class="users audit-table"><thead><tr><th>时间</th><th>谁</th><th>操作</th><th>说明</th></tr></thead><tbody>
          ${rows.map(r => `<tr${r.action === 'break_glass' ? ' class="audit-failed"' : ''}><td class="muted">${new Date(r.at).toLocaleString('zh-CN', { hour12: false })}</td><td>${esc(r.user)}${r.via === 'ai' ? ' <span class="pill">AI</span>' : ''}</td><td>${esc(ACTION[r.action] ?? r.action)}</td><td class="muted">${esc(r.action === 'break_glass' ? r.detail : '')}</td></tr>`).join('')}</tbody></table></div></div>`
        dlg.hidden = false
        dlg.onclick = ev => { if (ev.target === dlg || (ev.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
      } else if (act === 'delete') {
        if (await askConfirm({ title: `删除 ${d.code}`, message: '删除这位患者的全部记录、化验和上传的报告，不可恢复。', confirm: '删除', danger: true })) {
          await api(`/api/patients/${id}`, { method: 'DELETE' }); setName(id, ''); current = null; await loadList(); hooks.leaveDoc(); showWelcome()
        }
      }
      // 审核
      const recBox = t.closest<HTMLElement>('[data-rec]')
      const recx = t.closest<HTMLElement>('[data-recx]')?.dataset.recx
      if (recBox && recx === 'addrow') {
        const line = await askText({ title: '对照原件补一项', label: '项目 结果 单位 参考范围（空格分开，单位和参考范围可省略）', placeholder: '肌酐 168 µmol/L 57-111', confirm: '添加', hint: '日期取这份报告的日期。添加后和自动提取的项一样，确认整份报告时一起生效。' })
        if (!line) return
        const m = /^(\S+)\s+(\S+)(?:\s+(\S+))?(?:\s+(-?[\d.]+)\s*[-–~]\s*(-?[\d.]+))?\s*$/.exec(line.trim())
        if (!m) { notice('格式：项目 结果 单位 参考范围，例如「肌酐 168 µmol/L 57-111」', true); return }
        await api(`/api/patients/${id}/records/${recBox.dataset.rec}/labs`, { method: 'POST', body: JSON.stringify({ test_name: m[1], value: m[2], unit: m[3] ?? null, ref_low: m[4] ?? null, ref_high: m[5] ?? null }) })
        void openPatient(id, true)
        return
      }
      if (recBox && recx) {
        const date = (recBox.querySelector('.pt-date') as HTMLInputElement | null)?.value || undefined
        await api(`/api/patients/${id}/records/${recBox.dataset.rec}/${recx}`, { method: 'POST', body: JSON.stringify({ report_date: date }) })
        notice(recx === 'confirm' ? '已确认，化验已进入化验表' : '已驳回'); await loadList(); void openPatient(id, true)
      }
      const labRow = t.closest<HTMLElement>('tr[data-lab]')
      if (labRow && t.closest('[data-labx]')) { await api(`/api/patients/${id}/labs/${labRow.dataset.lab}/reject`, { method: 'POST' }); labRow.remove() }
      const prop = t.closest<HTMLElement>('[data-prop]')
      const propx = t.closest<HTMLElement>('[data-propx]')?.dataset.propx
      if (prop && propx) { await api(`/api/patients/${id}/proposals/${prop.dataset.prop}/${propx}`, { method: 'POST' }); await loadList(); void openPatient(id, true) }
    } catch (err) { notice((err as Error).message, true) }
  })

  // 审核表里改字段：失焦即保存（只改待确认的）
  document.getElementById('page')!.addEventListener('change', async e => {
    if (!current) return
    const input = e.target as HTMLInputElement
    const id = current
    if (input.id === 'ptUpload' && input.files?.length) {
      const failed: string[] = []
      let ok = 0
      let hasImaging = false
      for (const f of Array.from(input.files)) {
        const isImaging = /\.(nii|nii\.gz|dcm|dicom|mha|nrrd)$/i.test(f.name)
        if (isImaging) {
          hasImaging = true
          notice(`正在上传医学影像 ${f.name} 并调度 MONAI 3D 卷积执行量化分析...`)
          const fd = new FormData()
          fd.append('file', f)
          fd.append('model_id', 'bronchiectasis_mucus_analyzer')
          fd.append('auto_tag', 'true')
          try {
            await api(`/api/patients/${id}/imaging/analyze`, { method: 'POST', body: fd })
            ok++
            notice(`已成功将 3D 影像资料 ${f.name} 关联至患者，并生成量化分析记录！`)
          } catch (err) {
            failed.push(`${f.name}：${(err as Error).message}`)
          }
          continue
        }
        const fd = new FormData()
        fd.append('file', f)
        try { await api(`/api/patients/${id}/files`, { method: 'POST', body: fd }); ok++ } catch (err) { failed.push(`${f.name}：${(err as Error).message}`) }
      }
      input.value = ''
      // 被拦下的（重复上传等）单独说清楚，不被「已上传」覆盖
      if (failed.length) notice((ok ? `已上传 ${ok} 份。` : '') + failed.join('；'), true)
      else if (!hasImaging) notice('已上传，正在自动提取，完成后在「待确认」里审核')
      if (!ok) return
      tab = hasImaging ? 'records' : 'review'
      await loadList()
      void openPatient(id, true)
      return
    }
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-replaces]')
    const srow = sel?.closest<HTMLElement>('tr[data-lab]')
    if (sel && srow) {
      try { await api(`/api/patients/${id}/labs/${srow.dataset.lab}`, { method: 'PATCH', body: JSON.stringify({ replaces: sel.value || null }) }); notice(sel.value ? '确认这份报告时，旧值会标为已被更正' : '两个都保留') }
      catch (err) { notice((err as Error).message, true) }
      return
    }
    const row = input.closest<HTMLElement>('tr[data-lab]')
    if (row && input.dataset.f) {
      try { await api(`/api/patients/${id}/labs/${row.dataset.lab}`, { method: 'PATCH', body: JSON.stringify({ [input.dataset.f]: input.value }) }); row.classList.remove('pt-unverified') }
      catch (err) { notice((err as Error).message, true) }
    }
  })
  document.getElementById('page')!.addEventListener('blur', async e => {
    const ta = e.target as HTMLTextAreaElement
    const targetPid = ta.dataset?.pid || current
    if (ta.id !== 'ptSummary' || !targetPid) return
    try { await api(`/api/patients/${targetPid}`, { method: 'PATCH', body: JSON.stringify({ summary: ta.value }) }) } catch (err) { notice((err as Error).message, true) }
  }, true)

  /** 家庭分享收件箱：中间区域显示卡片列表，点开看只读视图。 */
  async function openShares(focus?: string): Promise<void> {
    hooks.leaveDoc()
    current = null
    openPatientSeq++
    if (poll) { clearTimeout(poll); poll = null }
    await loadShares()
    const page = $('page')
    page.className = 'page patient-page share-page'
    $('docTitle').textContent = '家庭分享'
    renderList()
    page.innerHTML = `<div class="sh-head"><h1>家庭分享</h1>
      <p class="muted">家人在知家里分享给你所在科室（或指定给你）的档案：只读、有效期内可见，每次查看家人都能在访问记录里看到。家人允许时可以「纳入本院」，复制成本院患者。</p></div>
      ${shares.length ? `<div class="sh-cards">${shares.map(s => `<button class="sh-card" data-share="${esc(s.share_id)}">
        <div class="sh-card-t"><b>${esc(s.display_name || s.share_code)}</b><span class="pt-code">${esc(s.share_code)}</span>${s.to_me ? '<span class="pill ok">指定给我</span>' : ''}</div>
        <div class="muted small">${esc(s.department)} · ${esc(scopeText(s.scope))} · ${esc(s.expires_at.slice(0, 10))} 到期</div>
        <div class="muted small">${s.imported ? '已纳入本院' : s.allow_import ? '家人允许纳入本院' : '仅查看'}</div></button>`).join('')}</div>`
        : '<p class="muted">还没有收到家庭分享。家人在知家里选「本院 → 你所在的科室」分享后会出现在这里；科室由机构管理员在「机构管理」里设置。</p>'}`
    page.querySelectorAll<HTMLElement>('[data-share]').forEach(b => b.addEventListener('click', () => void openShare(b.dataset.share!)))
    if (focus) await openShare(focus)
  }

  async function openShare(id: string): Promise<void> {
    const page = $('page')
    let v: ShareDetail
    try { v = await api<ShareDetail>(`/api/shares/${id}`) } catch (err) { notice((err as Error).message, true); await openShares(); return }
    page.className = 'page patient-page share-page'
    const who = v.display_name || v.share_code
    $('docTitle').textContent = `家庭分享 · ${who}`
    const labsRows = v.latest_labs.map(l => `<tr><td>${esc(l.test_name)}</td><td class="${l.flag ? 'pt-flag' : ''}">${esc(stdValue(l))} ${esc(l.std_unit ?? l.unit ?? '')}${l.flag === 'H' ? ' ↑' : l.flag === 'L' ? ' ↓' : ''}</td>
      <td class="muted">${esc(stdRef(l))}</td><td class="muted">${esc(when(l))}</td><td class="muted small">${l.source === 'manual' ? '家人手工录入' : '来自报告'}</td></tr>`).join('')
    page.innerHTML = `<div class="sh-head"><button class="link-btn" data-back>← 家庭分享</button>
        <h1>${esc(who)} <span class="pt-code">${esc(v.share_code)}</span></h1>
        <div class="muted">${[v.sex ? SEX[v.sex] : '', v.birth_year ? `${new Date().getFullYear() - v.birth_year} 岁` : '', ...v.tags].filter(Boolean).map(esc).join(' · ')}</div>
        <div class="muted small">发给 ${esc(v.department)}${v.to_me ? '（指定给你）' : ''} · 范围：${esc(scopeText(v.scope))} · ${esc(v.expires_at.slice(0, 10))} 到期 · 只读，家人能看到你的查看记录</div>
        <div class="row">${v.imported ? `<button data-open-imported="${esc(v.imported.patient_id ?? '')}">已纳入本院 · 打开患者</button>` : v.allow_import ? '<button class="primary" data-import>纳入本院</button>' : '<span class="muted small">家人没有允许纳入本院病历</span>'}</div></div>
      ${v.scope.categories.includes('labs') ? `<section class="sh-sec"><h3 class="mem-h">化验（各项最近一次，共 ${v.lab_count} 条）</h3>${labsRows ? `<table class="users pt-labs"><thead><tr><th>项目</th><th>结果</th><th>参考范围</th><th>日期</th><th>来源</th></tr></thead><tbody>${labsRows}</tbody></table>
        <button class="small-btn" data-all-labs>看全部化验</button><div id="shAllLabs"></div>` : '<p class="muted">范围内没有化验</p>'}</section>` : ''}
      ${v.scope.categories.includes('reports') ? `<section class="sh-sec"><h3 class="mem-h">报告原件</h3>${v.records.length ? `<ul class="rs-list">${v.records.map(r => `<li class="rs-item"><span class="rs-kind">${esc(KIND[r.kind] ?? '报告')}</span><b>${esc(r.title)}</b><span class="muted small">${esc(r.report_date ?? '')}</span>
        ${r.file_id ? `<a class="small-btn" target="_blank" rel="noopener" href="/api/shares/${esc(v.share_id)}/files/${esc(r.file_id)}?token=${encodeURIComponent(hooks.token())}">看原件</a>` : ''}</li>`).join('')}</ul>` : '<p class="muted">范围内没有报告</p>'}</section>` : ''}
      ${v.scope.categories.includes('docs') ? `<section class="sh-sec"><h3 class="mem-h">就诊简报与健康档案</h3>${v.documents.length ? `<ul class="rs-list">${v.documents.map(d => `<li class="rs-item"><span class="rs-kind">${esc(d.kind === 'brief' ? '就诊简报' : d.kind === 'archive' ? '健康档案' : '文档')}</span><b>${esc(d.title)}</b><span class="muted small">${esc(d.updated_at.slice(0, 10))}</span>
        <button class="small-btn" data-doc="${esc(d.doc_id)}">阅读</button></li>`).join('')}</ul><div id="shDoc"></div>` : '<p class="muted">没有简报或档案</p>'}</section>` : ''}`
    page.querySelector('[data-back]')!.addEventListener('click', () => void openShares())
    page.querySelector('[data-all-labs]')?.addEventListener('click', async () => {
      try {
        const all = await api<Lab[]>(`/api/shares/${id}/labs`)
        $('shAllLabs').innerHTML = `<table class="users pt-labs"><thead><tr><th>项目</th><th>结果</th><th>参考范围</th><th>日期</th></tr></thead><tbody>${all.map(l => `<tr><td>${esc(l.test_name)}</td><td>${esc(stdValue(l))} ${esc(l.std_unit ?? l.unit ?? '')}</td><td class="muted">${esc(stdRef(l))}</td><td class="muted">${esc(when(l))}</td></tr>`).join('')}</tbody></table>`
      } catch (err) { notice((err as Error).message, true) }
    })
    page.querySelectorAll<HTMLElement>('[data-doc]').forEach(b => b.addEventListener('click', async () => {
      try {
        const d = await api<{ title: string; html: string }>(`/api/shares/${id}/docs/${b.dataset.doc}`)
        $('shDoc').innerHTML = `<div class="sh-doc"><div class="sh-doc-t"><b>${esc(d.title)}</b><span class="muted small">只读</span></div><div class="ProseMirror sh-doc-body">${d.html}</div></div>`
      } catch (err) { notice((err as Error).message, true) }
    }))
    page.querySelector('[data-import]')?.addEventListener('click', async () => {
      if (!await askConfirm({ title: '纳入本院', message: `把「${who}」复制成本院患者（新代号，你是负责人）：化验、报告原件、简报一并复制并标明来自家庭分享。纳入后归本院管理，家人撤销分享不影响已纳入的部分。`, confirm: '纳入本院' })) return
      try {
        const p = await api<Patient>(`/api/shares/${id}/import`, { method: 'POST' })
        notice(`已纳入本院：${p.code}`)
        await loadList()
        await openPatient(p.id)
      } catch (err) { notice((err as Error).message, true) }
    })
    page.querySelector<HTMLElement>('[data-open-imported]')?.addEventListener('click', e => { const pid = (e.currentTarget as HTMLElement).dataset.openImported; if (pid) void openPatient(pid) })
  }

  /** 患者模式下还没选患者：中间显示患者模块的引导（与写作、研究统一结构）。 */
  function showWelcome(): void {
    const page = $('page')
    page.className = 'page patient-page pt-welcome'
    $('docTitle').textContent = '患者'
    page.innerHTML = `<div class="welcome">
      <svg class="mark" viewBox="-2 6 96 88" aria-hidden="true"><rect class="mark-ink" x="0" y="10" width="18" height="80" rx="9"/><rect class="mark-ink" x="62" y="30" width="18" height="60" rx="9"/><rect class="mark-sky" x="14" y="42" width="52" height="18" rx="9"/><circle class="mark-sky" cx="80" cy="20" r="11"/></svg>
      <h1>开始患者管理与影像分析</h1>
      <p class="welcome-sub">患者在平台内以去标识化虚拟代号建档，严守零 PHI 医学隐私底线；支持化验单与出院小结智能提取、3D HRCT/MR 深度学习体素量化与纵向配准对比。</p>
      <div class="welcome-cards">
        <button class="welcome-card primary" data-pw="new"><b>＋ 新建患者</b><span>虚拟代号建档（如 P-0001），真实姓名仅存本机浏览器</span></button>
        <button class="welcome-card" data-pw="upload"><b>上传报告与影像</b><span>化验单、出院小结原件或 DICOM 影像自动解析</span></button>
        ${list[0]
          ? `<button class="welcome-card" data-pw="open"><b>打开最近患者</b><span>打开 ${esc(label(list[0]))}</span></button>`
          : `<button class="welcome-card" data-pw="guide"><b>标杆案例导览</b><span>查阅 4 大典型病种 3D 量化与诊断证据链</span></button>`}
      </div>
      <h2>试试快速体验 4 大典型临床标杆案例</h2>
      <div class="welcome-examples">
        <button data-pt-preset="nsclc" title="点击快速进入或新建晚期非小细胞肺癌 (NSCLC) 靶向随访患者档案">
          <span style="display:flex;align-items:center;gap:8px;">
            ${icon('nsclc', { size: 16 })}
            <b>[NSCLC 靶向评估]</b> PT-NSCLC-002 · 58岁女 · EGFR 19del 奥希替尼 12 周随访 (RECIST 1.1 PR · 3D 容积 -78.2%)
          </span>
        </button>
        <button data-pt-preset="abpa" title="打开或新建示例患者：支气管与粘液栓影像测量">
          <span style="display:flex;align-items:center;gap:8px;">
            ${icon('scan', { size: 16 })}
            <b>[示例 · 支气管与粘液栓测量]</b> PT-BRONCHO-001 · 52岁男 · BAR 1.45 · 高密度粘液栓 12.44 cm³
          </span>
        </button>
        <button data-pt-preset="sarco" title="打开或新建示例患者：腹部脏器容积与 L3 体成分测量">
          <span style="display:flex;align-items:center;gap:8px;">
            ${icon('users', { size: 16 })}
            <b>[示例 · 腹部脏器与 L3 体成分]</b> PT-ABDOMEN-003 · 52岁男 · 脾体积 680 cm³ · L3 SMI 29.9 cm²/m²
          </span>
        </button>
        <button data-pt-preset="prostate" title="点击快速进入或新建盆腔前列腺多参数 T2-MRI (PI-RADS v2.1) 患者档案">
          <span style="display:flex;align-items:center;gap:8px;">
            ${icon('scan', { size: 16 })}
            <b>[前列腺 MRI 评估]</b> PT-PROSTATE-004 · 68岁男 · T2 MRI 腺体 48.6 cm³ (TZI 0.58) · PI-RADS 2 类良性增生
          </span>
        </button>
      </div>
      <div style="margin-top: 28px; text-align: center;">
        <button class="linkish small muted" data-guide-action="open">查阅 Heurion 临床工作站 3D 影像量化与患者全流程手册 ↗</button>
      </div>
    </div>${photoFigure('patients')}`
  }

  document.getElementById('page')!.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pw], [data-pt-preset], [data-guide-action], [data-guide-topic]')
    if (!b || !document.getElementById('page')!.classList.contains('pt-welcome')) return
    if (b.dataset.guideAction === 'open') { openHelpGuide('casestudy'); return }
    if (b.dataset.guideAction === 'import') {
      await importHelpAsDoc(api, async () => {}, async (id) => { hooks.goSpace('write'); await hooks.openDoc(id) }, (msg, err) => notice(msg, err))
      return
    }
    if (b.dataset.guideTopic) { openHelpGuide(b.dataset.guideTopic); return }
    if (b.dataset.pw === 'new') { void createPatient(); return }
    if (b.dataset.pw === 'open') { if (list[0]) void openPatient(list[0].id); return }
    if (b.dataset.pw === 'upload') {
      if (list[0]) {
        await openPatient(list[0].id)
        $('ptUpload')?.click()
      } else {
        await createPatient()
        if (current) $('ptUpload')?.click()
      }
      return
    }
    if (b.dataset.pw === 'guide') { openHelpGuide('casestudy'); return }
    if (b.dataset.ptPreset === 'nsclc') {
      const existing = list.find(p => p.tags.some(t => /nsclc|肺癌|egfr/i.test(t)) || p.code === 'PT-NSCLC-002')
      if (existing) {
        await openPatient(existing.id)
      } else {
        try {
          const created = await api<Patient>('/api/patients', {
            method: 'POST',
            body: JSON.stringify({
              code: 'PT-NSCLC-002',
              sex: '女',
              birth_year: '1968',
              tags: ['NSCLC', 'EGFR-19del', '奥希替尼靶向治疗', 'cT2bN2M0']
            })
          })
          notice('已创建典型案例患者档案：PT-NSCLC-002')
          await loadList()
          await openPatient(created.id)
        } catch (err) {
          notice((err as Error).message, true)
        }
      }
      return
    }
    if (b.dataset.ptPreset === 'abpa') {
      const existing = list.find(p => p.tags.some(t => /abpa|曲霉|支气管/i.test(t)) || p.code === 'PT-BRONCHO-001')
      if (existing) {
        await openPatient(existing.id)
      } else {
        try {
          const created = await api<Patient>('/api/patients', {
            method: 'POST',
            body: JSON.stringify({
              code: 'PT-BRONCHO-001',
              sex: '男',
              birth_year: '1974',
              tags: ['示例患者', '支气管扩张', '哮喘']
            })
          })
          notice('已创建典型案例患者档案：PT-BRONCHO-001')
          await loadList()
          await openPatient(created.id)
        } catch (err) {
          notice((err as Error).message, true)
        }
      }
      return
    }
    if (b.dataset.ptPreset === 'sarco') {
      const existing = list.find(p => p.tags.some(t => /sarco|肌少症|恶液质|脾大|abdomen/i.test(t)) || p.code === 'PT-SARCO-003' || p.code === 'PT-ABDOMEN-003')
      if (existing) {
        await openPatient(existing.id)
      } else {
        try {
          const created = await api<Patient>('/api/patients', {
            method: 'POST',
            body: JSON.stringify({
              code: 'PT-ABDOMEN-003',
              sex: '男',
              birth_year: '1974',
              tags: ['示例患者', 'L3 体成分', '化疗中']
            })
          })
          notice('已创建典型案例患者档案：PT-ABDOMEN-003')
          await loadList()
          await openPatient(created.id)
        } catch (err) {
          notice((err as Error).message, true)
        }
      }
      return
    }
    if (b.dataset.ptPreset === 'prostate' || b.dataset.ptPreset === 'ipf') {
      const existing = list.find(p => p.tags.some(t => /prostate|前列腺|pi-rads|bph|ipf/i.test(t)) || p.code === 'PT-PROSTATE-004' || p.code === 'PT-IPF-004')
      if (existing) {
        await openPatient(existing.id)
      } else {
        try {
          const created = await api<Patient>('/api/patients', {
            method: 'POST',
            body: JSON.stringify({
              code: 'PT-PROSTATE-004',
              sex: '男',
              birth_year: '1958',
              tags: ['前列腺增生', 'BPH', 'PI-RADS-2', '盆腔T2-MRI', '规避过度活检']
            })
          })
          notice('已创建典型案例患者档案：PT-PROSTATE-004')
          await loadList()
          await openPatient(created.id)
        } catch (err) {
          notice((err as Error).message, true)
        }
      }
      return
    }
  })

  // —— 左栏页签 ——

  $('newPatientBig').onclick = () => void createPatient()
  $('patientList').onclick = e => {
    const t = e.target as HTMLElement
    if (t.closest('#breakGlassBtn')) { void breakGlass(); return }
    if (t.closest('[data-shares]')) { void openShares(); return }
    const li = t.closest<HTMLElement>('li[data-pt]')
    if (li) void openPatient(li.dataset.pt!)
  }
  document.getElementById('docSearch')!.addEventListener('input', () => { if (!$('patientList').hidden) renderList() })

  // —— 对话框下方：「引用患者」（任意文档的对话里把患者带给 AI；只列诊疗组里的，紧急访问的不列） ——
  let picked: Array<{ id: string; label: string }> = []
  const pickedBox = () => document.getElementById('ptPicked')!
  function renderPicked(): void {
    pickedBox().hidden = picked.length === 0
    pickedBox().innerHTML = picked.map(p => `<span class="chip" data-id="${p.id}" title="AI 会读这位患者的资料与化验">${icon('users', { size: 12 })} ${esc(p.label)}<button class="chip-x" aria-label="移除">${icon('close', { size: 10 })}</button></span>`).join('')
  }
  pickedBox().onclick = e => {
    const id = ((e.target as HTMLElement).closest('.chip-x')?.parentElement as HTMLElement | undefined)?.dataset.id
    if (id) { picked = picked.filter(p => p.id !== id); renderPicked() }
  }
  document.getElementById('ptPickBtn')!.onclick = async e => {
    const anchor = e.currentTarget as HTMLElement
    document.querySelector('.kb-picker')?.remove()
    let all: Patient[] = []
    try { all = (await api<Patient[]>('/api/patients')).filter(p => p.role !== 'break_glass') } catch (err) { notice((err as Error).message, true); return }
    const menu = document.createElement('div')
    menu.className = 'pop-menu kb-picker'
    menu.innerHTML = all.length === 0
      ? '<div class="muted small kb-picker-empty">诊疗组里还没有患者</div>'
      : all.map(p => `<label><input type="checkbox" value="${p.id}" ${picked.some(x => x.id === p.id) ? 'checked' : ''}> ${esc(label(p))} <span class="muted small">${esc(p.tags.slice(0, 2).join('、'))}</span></label>`).join('')
    document.body.append(menu)
    const r = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(8, r.left)}px`
    menu.style.bottom = `${window.innerHeight - r.top + 6}px`
    menu.onchange = ev => {
      const box = ev.target as HTMLInputElement
      const p = all.find(y => y.id === box.value)!
      picked = box.checked ? [...picked, { id: p.id, label: label(p) }].slice(0, 10) : picked.filter(x => x.id !== p.id)
      renderPicked()
    }
    const done = () => { menu.remove(); document.removeEventListener('mousedown', away); document.removeEventListener('keydown', onKey) }
    const away = (ev: MouseEvent) => { if (!menu.contains(ev.target as Node) && ev.target !== anchor) done() }
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') done() }
    setTimeout(() => { document.addEventListener('mousedown', away); document.addEventListener('keydown', onKey) })
  }

  return {
    /** 发送对话时取走「引用患者」（发送后清空） */
    takePicked(): string[] { const ids = picked.map(p => p.id); picked = []; renderPicked(); return ids },
    /** 机构开了患者模块才显示「＋ 引用患者」 */
    setPickEnabled(on: boolean): void { document.getElementById('ptPickBtn')!.hidden = !on },
    /** 打开文档时：患者页失效 */
    leave(): void { current = null; openPatientSeq++; if (poll) { clearTimeout(poll); poll = null } if (!$('patientList').hidden) renderList() },
    /** 打开患者页（从病例报告回到患者，可直达指定页签） */
    async open(id: string, initialTab?: 'overview' | 'labs' | 'records' | 'docs' | 'review'): Promise<void> { hooks.goSpace('patients'); await openPatient(id, false, initialTab) },
    /** 进入患者空间（左侧图标栏）：刷新列表；中间区域显示患者或引导页 */
    async enter(): Promise<void> {
      const page = document.getElementById('page')!
      if (current && page.classList.contains('patient-page') && !page.classList.contains('pt-welcome')) {
        await loadList()
        return
      }
      current = null
      await loadList()
      // 列表加载期间已经打开了某位患者（从研究页 / 病例报告跳过来）：不要再用引导页盖掉
      if (current === null && !page.classList.contains('share-page')) showWelcome()
    },
  }
}
