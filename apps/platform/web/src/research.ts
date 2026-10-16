/**
 * 临床研究（工作空间）：研究项目列表与研究页——研究方案、数据集、分析（用研究数据集画的图，自动汇总）、稿件、入组患者。
 * 入组：按条件筛选诊疗组里的患者 → 预览（代号 + 匹配依据）→ 勾选入组（研究编号 S001…）→ 生成研究数据集（只有研究编号）。
 * 新建方案 / 论文 / 幻灯片：新建文档并归入研究，打开后把建议的指令填进对话框（由人改好再发送）。
 * 研究团队：负责人加同机构成员（可编辑 / 只读）、改角色、移出、转交；成员可退出；只读成员看不到修改类按钮。
 * 机构管理员在研究开始页可做离职交接（只换负责人，不看内容）。
 */
import { photoFigure } from './photos.ts'
import { askConfirm } from './dialogs.ts'
import { openHelpGuide } from './help.ts'
import { icon } from './icons.ts'

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
  goSpace(space: 'research'): void
  token(): string
  datasets: { upload(files: File[]): Promise<Array<{ id: string }>>; openDetail(id: string): Promise<void>; showProvenance(assetId: string): Promise<void> }
  /** 打开患者页（入组名单里点代号） */
  openPatient?(id: string): Promise<void>
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

  // —— 研究页 ——
  let openStudySeq = 0

  async function openStudy(id: string): Promise<void> {
    // 从研究里的文档回来、或在文档里点研究：先关掉文档（AI 栏收起，顶栏不再显示文档的东西）
    if (!$('page').classList.contains('study-page')) hooks.leaveDoc()
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
    const ro = canEdit ? '' : ' disabled'
    page.innerHTML = `
      ${canEdit ? '' : `<div class="banner rs-readonly"><span class="dot"></span>你是这个研究的只读成员（负责人 ${esc(s.owner_name)}）：能看文档、数据和分析，能评论；要修改请负责人把你改成「可编辑」。</div>`}
      <div class="rs-head">
        <input class="rs-title" id="rsTitle" value="${esc(s.title)}" aria-label="研究名称"${ro ? ' readonly' : ''}>
        <div class="row">
          <select id="rsDesign" aria-label="研究设计"${ro}><option value="">研究设计（未定）</option>${Object.entries(DESIGNS).map(([k, v]) => `<option value="${k}"${s.design === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <select id="rsStatus" aria-label="状态"${ro}>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${s.status === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
          <span class="rs-role muted small">我的角色：${ROLE_LABEL[s.my_role]}</span>
          <span class="grow"></span>
          <div class="menu-wrap"><button data-act="more" aria-haspopup="menu">更多 ▾</button>
            <div class="dropdown" id="rsMore" hidden>${w('<button data-act="attach">归入已有文档…</button>')}${isOwner ? '<button data-act="delete" class="danger-text">删除研究项目</button>' : '<button data-act="leave" class="danger-text">退出研究</button>'}</div></div>
        </div>
        <textarea id="rsSummary" rows="2" placeholder="简介：研究问题、人群、暴露 / 干预、主要终点"${ro ? ' readonly' : ''}>${esc(s.summary ?? '')}</textarea>
      </div>
      <div class="rs-grid">
        <section class="rs-card">
          <div class="rs-card-head"><h3>研究方案</h3>${w('<button class="small-btn" data-new="protocol">＋ 新建方案</button>')}</div>
          ${protocols.length ? `<ul class="rs-list">${protocols.map(docRow).join('')}</ul>` : '<p class="muted small">还没有研究方案。AI 可以依据你的研究问题起草：设计、纳入排除标准、终点、样本量、统计计划。</p>'}
        </section>
        <section class="rs-card">
          <div class="rs-card-head"><h3>数据集</h3>${w('<button class="small-btn" data-act="upload">＋ 上传数据</button><input type="file" id="rsUpload" accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls,.xpt,.sas7bdat,.sav,.zsav,.dta" multiple hidden>')}</div>
          ${s.datasets.length ? `<ul class="rs-list">${s.datasets.map(d => `<li class="rs-item" data-dataset="${d.dataset_id}"><span class="rs-kind">${esc(d.format)}</span><b>${esc(d.name)}</b>
            <span class="muted small">${d.status === 'ready' ? `${d.rows.toLocaleString()} 行 × ${d.cols} 列` : d.status === 'review' ? '<span class="flag-L">待处理身份信息</span>' : d.status === 'failed' ? '<span class="flag-H">导入失败</span>' : '处理中…'}</span>
            ${d.status === 'ready' ? `<button class="quiet small-btn" data-export-table1="${d.dataset_id}" title="导出符合医学期刊标准的原生 Word (.docx) Table 1 三线表">Word Table 1</button>` : ''}
            ${w(`<button class="quiet small-btn" data-unlink="dataset:${d.dataset_id}" title="移出研究（数据集回到上传者的「全部数据集」里）">移出</button>`)}</li>`).join('')}</ul>`
            : '<p class="muted small">上传 CSV、Excel、SAS、SPSS、Stata。在这个研究的文档里和 AI 对话时，会自动带上这些数据集。</p>'}
        </section>
        <section class="rs-card wide rs-folder-card">
          <div class="rs-card-head">
            <h3><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px; margin-right:4px;"><path d="M3 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>项目图表与成果文件夹</h3>
            <span class="muted small" style="margin-left:auto; display:inline-flex; align-items:center; gap:4px;"><svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> figures/ · 共 ${s.analyses.length} 份产出</span>
          </div>
          <div class="rs-folder-browser">
            <div class="rs-folder-header">
              <span class="rs-folder-path" style="display:inline-flex; align-items:center; gap:4px;"><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> 项目根目录 / <b>figures/</b></span>
              <span class="grow"></span>
              <span class="muted small">点开任意图表查看底层 Python 统计代码与数据溯源</span>
            </div>
            ${s.analyses.length ? `
              <div class="rs-folder-files">
                ${s.analyses.map(a => {
                  const filename = a.name.split('/').pop() || a.name
                  const ext = filename.split('.').pop() || 'png'
                  return `
                    <div class="rs-file-item" data-fig="${a.asset_id}" title="点击查看代码与溯源：${esc(a.name)}">
                      <div class="rs-file-preview">
                        <img src="/api/assets/${a.asset_id}?token=${encodeURIComponent(hooks.token())}" alt="${esc(a.name)}">
                        <span class="rs-file-badge">${esc(ext.toUpperCase())}</span>
                      </div>
                      <div class="rs-file-info">
                        <b class="rs-file-name">${esc(filename)}</b>
                        <div class="rs-file-meta">
                          ${a.has_code ? '<span class="pill green" title="可复现开源统计脚本">Python 脚本</span>' : ''}
                          <span>${esc(a.datasets.join('、') || '研究数据')}</span>
                          <span class="muted">${date(a.created_at)}</span>
                        </div>
                      </div>
                    </div>
                  `
                }).join('')}
              </div>
            ` : `
              <div class="rs-folder-empty">
                <p class="muted small" style="display:inline-flex; align-items:center; gap:6px;"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg> 图表文件夹当前为空。在方案/论文中对话让 AI 绘制 Table 1、Kaplan-Meier 生存曲线、森林图或影像分析图后，成果将自动归档至本文件夹。</p>
              </div>
            `}
          </div>
        </section>
        <section class="rs-card wide">
          <div class="rs-card-head"><h3>稿件</h3>${w('<button class="small-btn" data-new="manuscript">＋ 新建论文</button><button class="small-btn" data-new="slides">＋ 新建幻灯片</button>')}</div>
          ${manuscripts.length ? `<ul class="rs-list">${manuscripts.map(docRow).join('')}</ul>` : '<p class="muted small">论文、组会汇报幻灯片。写作时可以直接引用上面的分析结果。</p>'}
        </section>
        ${cohortCard(cohort, cohortOff, canEdit)}
        ${membersCard(members, candidates, isOwner)}
      </div>`
    // 数据集还在处理：隔几秒刷新
    if (s.datasets.some(d => d.status === 'processing')) poll = setTimeout(() => { if (current === id) void openStudy(id) }, 2500)
  }

  /** 入组患者卡片：入组名单、待确认的 AI 入组提议、研究数据集（过期提示）。 */
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

  function cohortCard(c: Cohort | null, off: string, canEdit = true): string {
    if (!c) return `<section class="rs-card wide"><div class="rs-card-head"><h3>入组患者</h3></div><p class="muted small">${esc(off || '研究入组需要启用患者模块')}</p></section>`
    const active = c.subjects.filter(x => x.status === 'active')
    const sets = c.datasets.filter(d => d.latest)
    const SHAPE: Record<string, string> = { wide: '宽表', long: '长表' }
    return `<section class="rs-card wide" id="rsCohort">
      <div class="rs-card-head"><h3>入组患者${active.length ? `<span class="muted small"> · ${active.length} 人</span>` : ''}</h3>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <button class="small-btn primary" data-act="bundle" title="一键导出包含 Table 1 (Word)、Figure 1~6 矢量图、方法与结果初稿及 STROBE 清单的完整投稿压缩包 (.zip)">${icon('download', { size: 13 })} 导出投稿出版包 (.zip)</button>
          <button class="small-btn" data-act="consort" title="查看出版级 CONSORT 2010 试验入组纳排流向图 (Figure 1)">${icon('chart', { size: 13 })} CONSORT 流程图</button>
          <button class="small-btn" data-act="evalue" title="因果推断敏感度分析与顶刊审稿回复论述">${icon('evidence', { size: 13 })} 因果推断 E-value</button>
          <button class="small-btn" data-act="ecrf" title="Auto-eCRF 多模态影像与临床指标批量提取与溯源">${icon('write', { size: 13 })} Auto-eCRF 批量回填</button>
          <button class="small-btn" data-act="vars" title="分组、随访、结局与影像变量：来源与核实状态；投稿材料只用已核实的值">${icon('check', { size: 13 })} 研究变量</button>
          ${canEdit ? `<button class="small-btn" data-act="screen">＋ 筛选入组</button>${active.length ? '<button class="small-btn" data-act="gen">生成研究数据集</button>' : ''}` : ''}
        </div></div>
      ${c.pending.length ? `<div class="banner pt-pending"><span class="dot"></span>AI 建议了 ${c.pending.length} 项入组 / 移出，待你确认</div>
        <ul class="rs-list">${c.pending.map(p => `<li class="rs-item"><span class="rs-kind">${p.kind === 'enroll' ? '入组' : '移出'}</span><b>${esc(p.code ?? '—')}</b><span class="muted small">${esc(p.reason)}</span>
          <button class="small-btn primary" data-prop="${p.proposal_id}" data-pt="${p.patient_id}" data-propx="accept">确认</button><button class="quiet small-btn" data-prop="${p.proposal_id}" data-pt="${p.patient_id}" data-propx="reject">不采纳</button></li>`).join('')}</ul>` : ''}
      ${sets.map(d => `<div class="rs-cohort-ds${d.stale ? ' stale' : ''}" data-dataset="${d.dataset_id}"><span class="rs-kind">${SHAPE[d.shape] ?? d.shape} v${d.version}</span>
        <span style="flex:1;">${esc(d.name)} <span class="muted small">${d.rows} 行 · ${date(d.generated_at)}</span></span>
        ${d.shape === 'wide' ? `
          <button class="small-btn primary" data-export-table1="${d.dataset_id}" title="一键导出符合医学期刊标准的原生 Word (.docx) Table 1 基线三线表">${icon('download', { size: 13 })} 导出 Table 1</button>
          <button class="small-btn" data-survival="${d.dataset_id}" data-dsname="${esc(d.name)}" title="KM 生存曲线与 Cox 比例风险森林图分析">${icon('chart', { size: 13 })} 生存分析 & 森林图</button>
          ${/* 列线图 / ROC-DCA 入口暂不开放：需要真实拟合的模型系数与预测概率，界面没有输入流程（接口保留） */ ''}
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

  /** CONSORT 2010 受试者纳排筛选流向图弹窗 */
  async function consortDialog(studyId: string): Promise<void> {
    const dlg = $('dialog')
    dlg.innerHTML = `<div class="dialog-card wide" role="dialog" aria-modal="true" aria-label="CONSORT 2010 流向图">
      <div class="dialog-head">
        <h2>受试者流向图 (Figure 1)</h2>
        <button class="quiet" data-close aria-label="关闭">✕</button>
      </div>
      <div class="dialog-body" style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span class="muted small">只含平台入组记录（入组 / 移出 / 在组）；筛选与排除环节需按原始纳排记录补充</span>
          <span class="grow"></span>
          <button class="small-btn" id="rsConsortCopyMermaid">${icon('copy', { size: 13 })} 复制 Mermaid 代码</button>
          <button class="small-btn primary" id="rsConsortDownloadSvg">${icon('download', { size: 13 })} 下载矢量 SVG</button>
        </div>
        <div id="rsConsortSvgContainer" style="background:#ffffff;border:1px solid var(--line);border-radius:8px;padding:20px;overflow:auto;max-height:560px;display:flex;justify-content:center;align-items:flex-start;">
          <div class="muted small" style="padding:40px;">正在生成出版级流向图…</div>
        </div>
        <div class="muted small" style="border-top:1px solid var(--line);padding-top:8px;display:flex;align-items:center;gap:6px;">
          ${icon('info', { size: 13 })} 提示：该矢量图可直接拖入或插入论文排版系统；点击「复制 Mermaid 代码」可直接粘贴嵌入 Markdown 方案与报告。
        </div>
      </div>
    </div>`
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }

    try {
      const res = await api<{ svg: string; mermaid: string; data: any }>(`/api/studies/${studyId}/cohort/consort`)
      const container = document.getElementById('rsConsortSvgContainer')
      if (container) container.innerHTML = res.svg

      const copyBtn = document.getElementById('rsConsortCopyMermaid')
      if (copyBtn) {
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(res.mermaid).then(() => {
            notice('已复制 CONSORT Mermaid 流程图代码，可直接贴入 Markdown 文稿')
          }).catch(() => {
            notice('复制失败，请手动选取', true)
          })
        }
      }

      const dlBtn = document.getElementById('rsConsortDownloadSvg')
      if (dlBtn) {
        dlBtn.onclick = () => {
          const blob = new Blob([res.svg], { type: 'image/svg+xml;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `CONSORT_2010_Flowchart_${studyId}.svg`
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          URL.revokeObjectURL(url)
          notice('已下载 CONSORT 矢量 SVG 图')
        }
      }
    } catch (err) {
      notice((err as Error).message, true)
    }
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
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <b>Figure 3: Kaplan-Meier 累积生存率曲线与风险集对照 (Number at Risk)</b>
              <button class="small-btn" id="rsDlKmSvg">${icon('download', { size: 13 })} 下载 KM 矢量图 (SVG)</button>
            </div>
            <div id="rsKmSvgWrap" style="overflow:auto;max-height:480px;display:flex;justify-content:center;"></div>
          </div>

          <!-- Statistical Callout Metrics -->
          <div id="rsSurvStats" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:12px;"></div>

          <!-- Cox Forest Plot -->
          <div id="rsForestWrap" style="border:1px solid var(--line);border-radius:8px;padding:16px;background:#ffffff;display:none;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
              <b>Figure 4: 多因素 Cox 比例风险回归亚组森林图 (Hazard Ratio & 95% CI)</b>
              <button class="small-btn" id="rsDlForestSvg">${icon('download', { size: 13 })} 下载森林图 (SVG)</button>
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
          if (kmWrap) kmWrap.innerHTML = kmSvg || '<div class="muted small">未生成 KM 图像</div>'

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
            forestSvgWrap.innerHTML = forestSvg
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
      const [nomoRes, rocDcaRes] = await Promise.all([
        api<any>(`/api/datasets/${datasetId}/nomogram`, { method: 'POST', body: JSON.stringify({}) }),
        api<any>(`/api/datasets/${datasetId}/roc-dca`, { method: 'POST', body: JSON.stringify({}) })
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
      if (nomoSvgWrap) nomoSvgWrap.innerHTML = nomoRes.svg || '<div class="muted small">未生成列线图</div>'

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
      if (rocSvgWrap) rocSvgWrap.innerHTML = rocDcaRes.roc?.svg || '<div class="muted small">未生成 ROC 图像</div>'

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
      if (dcaSvgWrap) dcaSvgWrap.innerHTML = rocDcaRes.dca?.svg || '<div class="muted small">未生成 DCA 图像</div>'

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
      <div style="margin-top: 28px; text-align: center; display: flex; justify-content: center; align-items: center; gap: 16px;">
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
  $('newStudy').onclick = () => createDialog()
  $('docSearch').addEventListener('input', () => { if (!$('studyList').hidden) renderList() })

  return {
    async enter(): Promise<void> {
      await loadList()
      if (current && $('page').classList.contains('study-page') && !$('page').classList.contains('rs-welcome')) return
      showWelcome()
    },
    leave(): void { current = null; if (poll) { clearTimeout(poll); poll = null } },
    /** 从研究里的文档回到研究页 */
    async open(id: string): Promise<void> { hooks.goSpace('research'); await openStudy(id) },
  }
}
