import { askConfirm, askText } from './dialogs.ts'
// 去标识模块与服务端共用（纯 TS，不依赖 node），经相对路径引用
import { createDeidentifier, estimateSources, iterateSources } from '../../src/imaging/deid/index.ts'
import { esc } from './dom.ts'
import { mountReview, reviewBadge, type ReviewSummary } from './imaging-review.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notice = (msg: string, error?: boolean) => void

interface SeriesView { id: string; modality: string | null; body_part: string | null; description: string | null; slice_thickness: number | null; kernel: string | null; instances: number }
interface StudyView {
  id: string; study_uid?: string; study_date: string | null; modalities: string[]; description: string | null; accession?: string | null
  source: 'upload' | 'pacs'; created_at: string; series: SeriesView[]; lesions: { proposed: number; confirmed: number; rejected: number }
  runs: RunView[]
  /** 机构处于影像 AI 影子模式：自动分析在后台运行，结果不显示 */
  ai_shadow?: boolean
  /** 原件已按保留期从云端删除（服务端 imaging/retention.ts）：不给阅片器、分析入口；重新上传同一检查即恢复 */
  originals_deleted?: { at: string; retention_days: number | null; message: string } | null
}
interface RunView {
  id: string; task: string; model_version: string | null; status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted'; error: string | null
  summary: { found?: number; warnings?: string[]; elapsed_ms?: number } | null; created_at: string; finished_at: string | null
  /** 排队中时前面还有几个任务（含正在分析的） */
  waiting_ahead?: number | null
}

const TASK: Record<string, string> = { lung_nodule: '肺结节' }

/** 最近一次分析的状态文字 */
function runLine(r: RunView | undefined): string {
  if (!r) return '<span class="muted">未分析</span>'
  const task = esc(TASK[r.task] ?? r.task)
  if (r.status === 'queued') return `${task}：排队中${r.waiting_ahead ? `，前面还有 ${r.waiting_ahead} 个任务` : '…'}`
  if (r.status === 'running') return `${task}：分析中…`
  if (r.status === 'done') {
    const warn = r.summary?.warnings?.length ? `<div class="muted">${r.summary.warnings.map(w => esc(w)).join('；')}</div>` : ''
    return `${task}：检出 ${r.summary?.found ?? 0} 个${r.model_version ? `<div class="muted">${esc(r.model_version)}</div>` : ''}${warn}`
  }
  return `<span class="danger-text">${task}：${r.status === 'interrupted' ? '已中断' : '失败'}</span><div class="muted">${esc(r.error ?? '')}</div>`
}
interface ImportResult {
  studies: StudyView[]; files: { received: number; uploaded: number; duplicates: number; skipped: Array<{ name: string; reason: string }> }; conflicts: number; conflict_keys?: string[]; updated_study_ids?: string[]
  analysis?: Array<{ study_id: string; task: string; run_id: string | null; shadow?: boolean; skipped: string | null }>
}

/**
 * 每批上传的大小上限：生产经 Cloudflare，单个请求不能超过 100 MB；按 48 MB 分批（加上表单开销仍在 64 MB 以内），
 * 失败时只需重传一批，浏览器里同时只攒一批去标识后的文件。
 */
const BATCH_BYTES = 48 * 1024 * 1024

/** 服务端给的去标识参数（GET /api/patients/:ptid/imaging/deid-params） */
interface DeidParamsView { key: string; pseudonym: string; scheme: string; accept_identified: boolean }

/** 影像检查（DICOM）区块的占位，放在患者页「原始报告 / 影像」标签顶部；mountStudies 填充内容 */
export function studiesSection(canEdit: boolean): string {
  return `<section class="pt-dicom" id="ptDicomStudies">
    <div class="row"><b>影像检查（DICOM）</b><span class="grow"></span>
      <button class="small-btn quiet" data-findings-tpl title="科室所见模板：生成所见草稿时每句话的写法（机构管理员或本科室审核医师维护）">所见模板</button>
      ${canEdit ? `<button class="small-btn" data-dicom="files" title="选择 DICOM 文件或 zip 压缩包">上传 DICOM 文件</button>
      <button class="small-btn" data-dicom="folder" title="选择包含一次检查的文件夹（光盘导出的目录也可以）">上传文件夹</button>
      <input type="file" id="ptDicomFiles" accept=".dcm,.dicom,.zip,application/dicom,application/zip" multiple hidden>
      <input type="file" id="ptDicomFolder" webkitdirectory multiple hidden>` : ''}
    </div>
    ${canEdit ? '<div class="muted small">影像会先在本机（浏览器里）去除姓名、ID 等信息再上传；截屏、超声等可能有烧录文字的影像不上传。</div>' : ''}
    <div id="ptFindingsTpl" class="pt-imgreview" hidden></div>
    <div id="ptDicomList" class="muted small">正在读取影像检查…</div>
  </section>`
}

function seriesLine(s: SeriesView): string {
  return [s.modality, s.body_part, s.description, s.slice_thickness ? `${s.slice_thickness} mm` : null, s.kernel, `${s.instances} 层`].filter(Boolean).map(x => esc(String(x))).join(' · ')
}

function render(list: StudyView[], canEdit: boolean, reviews: Map<string, ReviewSummary>, open: Set<string>, openFollowup: Set<string>): string {
  if (!list.length) return '<div class="muted small">还没有影像检查。上传 DICOM 后会在这里按检查列出，并自动进入 AI 分析。</div>'
  return `<table class="users"><thead><tr><th>检查日期</th><th>模态</th><th>检查描述</th><th>序列</th><th>AI 分析</th><th>病灶</th><th>审核</th></tr></thead><tbody>
    ${list.map(st => {
      const last = st.runs[0]
      const busy = last && (last.status === 'queued' || last.status === 'running')
      const gone = st.originals_deleted
      const goneNote = gone ? `<div class="muted small" title="删除于 ${esc(new Date(gone.at).toLocaleString('zh-CN', { hour12: false }))}；AI 结果、病灶、测量与审核留痕仍保留">${esc(gone.message)}</div>` : ''
      const isCt = st.modalities.includes('CT')
      return `<tr>
      <td class="pt-dicom-date">${esc(st.study_date ?? '未知')}<div class="muted small">${st.source === 'pacs' ? 'PACS' : '手工上传'}</div>${gone ? goneNote : st.study_uid ? `<div><button class="small-btn" data-view="${esc(st.study_uid)}">在阅片器中打开</button></div>` : ''}</td><td>${esc(st.modalities.join(' / ') || '—')}</td><td>${esc(st.description ?? '')}</td>
      <td class="small">${st.series.map(s => `<div>${seriesLine(s)}</div>`).join('')}</td>
      <td class="small">${st.ai_shadow && !last ? '<span class="muted" title="上线前评估：AI 在后台分析，结果只进机构的对照报告">影子模式，结果不显示</span>' : `${runLine(last)}${canEdit && !busy && !gone ? `<div><button class="small-btn" data-analyze="${esc(st.id)}">${last ? '重新分析' : '开始分析'}</button></div>` : ''}`}</td>
      <td class="small">${st.lesions.proposed + st.lesions.confirmed + st.lesions.rejected ? `待确认 ${st.lesions.proposed} · 已确认 ${st.lesions.confirmed} · 已否决 ${st.lesions.rejected}` : '<span class="muted">—</span>'}
        ${isCt ? `<div><button class="small-btn" data-followup="${esc(st.id)}" title="查看与前片胸部 CT 的结节配准对应、径线与体积变化及倍增时间（VDT）">${openFollowup.has(st.id) ? '收起随访' : '随访对比'}</button></div>` : ''}</td>
      <td class="small">${reviewBadge(reviews.get(st.id))}${reviews.has(st.id) ? `<div><button class="small-btn" data-review="${esc(st.id)}">${open.has(st.id) ? '收起审核' : '审核视图'}</button></div>` : ''}
        ${canEdit && isCt ? `<div><button class="small-btn" data-draft="${esc(st.id)}" title="按科室模板，由已确认的结节生成所见草稿（测量数字绑定病灶，医生重测后自动更新）">生成所见草稿</button></div>` : ''}</td></tr>
      ${openFollowup.has(st.id) ? `<tr class="pt-imgreview-row"><td colspan="7"><div class="pt-imgreview" data-followup-box="${esc(st.id)}">正在读取随访对比…</div></td></tr>` : ''}
      ${open.has(st.id) ? `<tr class="pt-imgreview-row"><td colspan="7"><div class="pt-imgreview" data-review-box="${esc(st.id)}">正在读取审核视图…</div></td></tr>` : ''}`
    }).join('')}
  </tbody></table>`
}

/** 各批上传结果的汇总 */
function tally() {
  let uploaded = 0, duplicates = 0, shadow = false
  // 一个检查分几批上传时每批都会报冲突：按检查去重
  const conflictKeys = new Set<string>()
  let conflictsNoKey = 0
  const skipped: string[] = []
  const notApplicable = new Set<string>()
  /** 有新实例入库、等最后一批之后统一排队分析的检查 */
  const pending = new Set<string>()
  return {
    skipped,
    /** 所有批次传完（或中途停止）后：对有新实例的检查各排队一次分析 */
    async analyze(api: Api, patientId: string) {
      for (const id of pending) {
        try {
          const r = await api<{ shadow?: boolean }>(`/api/patients/${patientId}/imaging/studies/${encodeURIComponent(id)}/analyze`, { method: 'POST', body: JSON.stringify({ task: 'lung_nodule' }), headers: { 'Content-Type': 'application/json' } })
          if (r.shadow) shadow = true
        } catch (err) { notApplicable.add((err as Error).message) }
      }
      pending.clear()
    },
    add(r: ImportResult, nameOf: (n: string) => string = n => n) {
      for (const id of r.updated_study_ids ?? []) pending.add(id)
      uploaded += r.files.uploaded; duplicates += r.files.duplicates
      if (r.conflict_keys) r.conflict_keys.forEach(k => conflictKeys.add(k)); else conflictsNoKey += r.conflicts
      skipped.push(...r.files.skipped.map(s => `${nameOf(s.name)}（${s.reason}）`))
      for (const x of r.analysis ?? []) { if (x.skipped) notApplicable.add(x.skipped); if (x.shadow) shadow = true }
    },
    finish(notice: Notice, head = 'DICOM 上传完成') {
      const conflicts = conflictKeys.size + conflictsNoKey
      const parts = [`新入库 ${uploaded} 个文件`, duplicates ? `${duplicates} 个已存在` : '', skipped.length ? `跳过 ${skipped.length} 个` : ''].filter(Boolean)
      const reasons = [...new Set(skipped.map(s => s.replace(/^.*（(.*)）$/, '$1')))]
      const analysis = (notApplicable.size ? `；未自动分析：${[...notApplicable].join('；')}` : '') + (shadow ? '；影像 AI 处于影子模式，分析在后台进行，结果不显示' : '')
      notice(`${head}：${parts.join('，')}${reasons.length ? `（跳过原因：${reasons.slice(0, 4).join('；')}${reasons.length > 4 ? ' 等' : ''}）` : ''}${conflicts ? `；有 ${conflicts} 个检查已属于本机构的其他患者，未关联到这位患者，这次上传的文件已删除` : ''}${analysis}`, conflicts > 0 || (uploaded + duplicates === 0 && skipped.length > 0))
      if (skipped.length) console.info('跳过的文件：', skipped)
    },
  }
}

const b64bytes = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

/**
 * 上传 DICOM（docs/design/IMAGING_STUDIES.md「去标识化」）：在浏览器里解 zip、跳过 DICOMDIR 与非 DICOM、逐个去标识，
 * 攒满一批就上传（同时只在内存里留一批）。原检查号单独作为表单字段发送，服务端加密存放，不进影像存储。
 * 院内部署接收原件时（accept_identified）按原样分批上传。
 */
export async function uploadDicomStudies(api: Api, notice: Notice, patientId: string, files: File[], onBatch?: () => void | Promise<void>): Promise<void> {
  const params = await api<DeidParamsView>(`/api/patients/${patientId}/imaging/deid-params`)
  if (params.accept_identified) return uploadOriginals(api, notice, patientId, files, onBatch)
  const deid = await createDeidentifier({ key: b64bytes(params.key), pseudonym: params.pseudonym })
  notice('正在读取文件…')
  const est = await estimateSources(files)
  const totalBatches = Math.max(1, Math.ceil(est.bytes / BATCH_BYTES))
  const t = tally()
  /** 上传用的文件名是序号（原文件名、文件夹名可能含患者姓名，不上传）；跳过时换回原名显示 */
  const names = new Map<string, string>()
  let seq = 0, done = 0, batchNo = 0
  let batch: { files: File[]; size: number; studies: Map<string, string | null> } = { files: [], size: 0, studies: new Map() }
  const flush = async () => {
    if (!batch.files.length) return
    batchNo++
    notice(`正在上传第 ${batchNo} / ${Math.max(batchNo, totalBatches)} 批…`)
    const fd = new FormData()
    for (const f of batch.files) fd.append('files', f)
    fd.append('study_meta', JSON.stringify(Object.fromEntries([...batch.studies].map(([uid, accession]) => [uid, { accession }]))))
    fd.append('defer_analysis', '1')
    batch = { files: [], size: 0, studies: new Map() }
    const r = await api<ImportResult>(`/api/patients/${patientId}/imaging/dicom`, { method: 'POST', body: fd })
    t.add(r, n => names.get(n) ?? n)
    await onBatch?.()
  }
  let firstPatient: string | null = null, mixedOk = false
  try {
  for await (const e of iterateSources(files)) {
    done++
    if (done === 1 || done % 10 === 0) notice(`正在去标识 ${done} / ${Math.max(done, est.files)}（影像先在本机去除姓名、ID 等信息再上传）…`)
    if ('skipped' in e) { t.skipped.push(`${e.name}（${e.skipped}）`); continue }
    const r = await deid.deidentify(e.bytes)
    if (!r.ok) { t.skipped.push(`${e.name}（${r.reason}）`); continue }
    // 去标识后服务端分不出是不是同一位患者：这里按原 PatientID / 姓名提醒一次
    if (firstPatient === null) firstPatient = r.original.patientKey
    else if (r.original.patientKey !== firstPatient && !mixedOk) {
      if (!await askConfirm({ title: '这批影像不像同一位患者', message: '所选文件里的患者 ID / 姓名不止一种。影像会全部归到当前患者名下。\n确认都是这位患者的再继续；点「取消」停止上传（已上传的批次保留）。', confirm: '继续上传' })) {
        await t.analyze(api, patientId)
        t.finish(notice, 'DICOM 上传已停止')
        return
      }
      mixedOk = true
    }
    if (batch.size + r.bytes.byteLength > BATCH_BYTES) await flush()
    const name = `${++seq}.dcm`
    names.set(name, e.name)
    batch.files.push(new File([r.bytes as Uint8Array<ArrayBuffer>], name, { type: 'application/dicom' }))
    batch.size += r.bytes.byteLength
    if (!batch.studies.get(r.studyUid)) batch.studies.set(r.studyUid, r.original.accession)
  }
  await flush()
  } finally {
    // 中途某批失败时，已入库的批次照样排队分析
    await t.analyze(api, patientId)
  }
  if (!batchNo && !t.skipped.length) { notice('没有找到 DICOM 文件', true); return }
  t.finish(notice)
}

/** 院内部署接收原件：按原样分批上传（单个文件超过批大小时独占一批） */
async function uploadOriginals(api: Api, notice: Notice, patientId: string, files: File[], onBatch?: () => void | Promise<void>): Promise<void> {
  const batches: File[][] = []
  let cur: File[] = [], size = 0
  for (const f of files) {
    if (cur.length && size + f.size > BATCH_BYTES) { batches.push(cur); cur = []; size = 0 }
    cur.push(f); size += f.size
  }
  if (cur.length) batches.push(cur)
  const t = tally()
  for (const [i, batch] of batches.entries()) {
    notice(`正在上传第 ${i + 1} / ${batches.length} 批（本院部署接收原件，不在本机去标识）…`)
    const fd = new FormData()
    for (const f of batch) fd.append('files', f)
    fd.append('defer_analysis', '1')
    try {
      t.add(await api<ImportResult>(`/api/patients/${patientId}/imaging/dicom`, { method: 'POST', body: fd }))
    } catch (err) { await t.analyze(api, patientId); throw err }
    await onBatch?.()
  }
  await t.analyze(api, patientId)
  t.finish(notice)
}

interface DraftOutcome {
  doc_id: string; created: boolean; nodules: number; warnings: string[]
  template: { source: string; version: number; department_name: string | null }
  blocks: { written: string[]; unchanged: string[]; kept: Array<{ key: string; reason: string }>; removed: string[] }
  guideline_reference?: { status_label: string; requires_confirmation: boolean; reference_sentence: string } | null
  guideline_appended?: boolean
}
type ApiError = Error & { body?: { code?: string; doc_id?: string; departments?: string[] } }

/**
 * 生成所见草稿（T2.6 + W4.3 二期指南分级参考）：已有草稿时让医生选「更新那份」（只改没人动过的段落）或「另建一份」；
 * 在多个有模板的科室时选科室。完成后打开草稿文档。
 */
async function generateDraft(api: Api, notice: Notice, patientId: string, studyId: string, openDoc: ((docId: string) => Promise<void>) | undefined, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    const r = await api<DraftOutcome>(`/api/patients/${patientId}/imaging/studies/${encodeURIComponent(studyId)}/findings-draft`, { method: 'POST', body: JSON.stringify(extra), headers: { 'Content-Type': 'application/json' } })
    const tpl = r.template.source === 'builtin' ? '内置模板' : `${r.template.department_name ?? '机构默认'}模板 v${r.template.version}`
    const kept = r.blocks.kept.filter(k => k.reason !== 'deleted').length
    const head = r.created ? `已生成所见草稿（${r.nodules} 个结节，${tpl}）` : `已更新所见草稿：改写 ${r.blocks.written.length} 段、删去 ${r.blocks.removed.length} 段${kept ? `，你改过的 ${kept} 段原样保留` : ''}`
    const guideTip = r.guideline_reference
      ? r.guideline_appended
        ? '；已按医生确认附入 Lung-RADS / Fleischner 指南参考'
        : `；指南参考（${r.guideline_reference.status_label}）：${r.guideline_reference.reference_sentence}`
      : ''
    // 有「请核对」也是生成成功，不用错误样式（错误样式会以「出错了」开头）
    notice(`${head}${r.warnings.length ? `。请核对：${r.warnings.join('；')}` : ''}${guideTip}`)
    if (openDoc) await openDoc(r.doc_id)
  } catch (err) {
    const body = (err as ApiError).body
    if (body?.code === 'draft_exists' && body.doc_id) {
      if (await askConfirm({ title: '这次检查已有所见草稿', message: '更新那份草稿：只改自上次生成后没人动过的段落，你改过、删掉的段落原样保留。\n点「取消」可以选择另建一份。', confirm: '更新那份' })) {
        return generateDraft(api, notice, patientId, studyId, openDoc, { ...extra, doc_id: body.doc_id })
      }
      if (await askConfirm({ title: '另建一份所见草稿？', message: '新建一份独立的草稿文档，原来的那份不变。', confirm: '新建一份' })) return generateDraft(api, notice, patientId, studyId, openDoc, { ...extra, new: true })
      return
    }
    if (body?.code === 'department_required' && body.departments?.length) {
      const list = body.departments
      const pick = await askText({ title: '用哪个科室的模板？', label: list.map((d, i) => `${i + 1}. ${d.replace(/^[^（]*（/, '').replace(/）$/, '')}`).join('；'), placeholder: '输入序号', confirm: '生成' })
      const id = list[Number(pick) - 1]?.split('（')[0]
      if (id) return generateDraft(api, notice, patientId, studyId, openDoc, { ...extra, department_id: id })
      return
    }
    notice(`不能生成所见草稿：${(err as Error).message}`, true)
  }
}

interface TemplateView { id: string; version: number; body: unknown; created_by_name: string | null; created_at: string | null; note: string | null }
interface TemplateList {
  org: TemplateView | null; builtin: TemplateView; can_edit_org: boolean
  departments: Array<{ id: string; name: string; mine: boolean; template: TemplateView | null; can_edit: boolean }>
  placeholders: Record<string, Record<string, { label: string; measure: boolean }>>
}

/** 科室所见模板的查看与编辑（JSON；保存即新版本，旧版本保留）。权限在服务端判断。 */
async function mountTemplates(api: Api, notice: Notice, box: HTMLElement): Promise<void> {
  let data: TemplateList
  try { data = await api<TemplateList>('/api/imaging/findings-templates') } catch (err) { box.textContent = `所见模板读取失败：${(err as Error).message}`; return }
  const scopes = [
    { value: 'org', label: '机构默认', tpl: data.org, can: data.can_edit_org },
    ...data.departments.map(d => ({ value: `dept:${d.id}`, label: `科室：${d.name}${d.mine ? '（我所在）' : ''}`, tpl: d.template, can: d.can_edit })),
  ]
  const show = (i: number) => {
    const sc = scopes[i]!
    const cur = sc.tpl ?? (sc.value === 'org' ? data.builtin : data.org ?? data.builtin)
    const info = sc.tpl ? `当前 v${sc.tpl.version}${sc.tpl.created_by_name ? ` · ${esc(sc.tpl.created_by_name)}` : ''}${sc.tpl.created_at ? ` · ${new Date(sc.tpl.created_at).toLocaleString('zh-CN', { hour12: false })}` : ''}${sc.tpl.note ? ` · ${esc(sc.tpl.note)}` : ''}`
      : sc.value === 'org' ? '未设置：使用内置模板' : '未设置：使用机构默认模板（再没有则用内置模板）'
    const ph = Object.entries(data.placeholders.nodule ?? {}).map(([k, v]) => `<code>{${esc(k)}}</code> ${esc(v.label)}${v.measure ? '（测量原子）' : ''}`).join('；')
    const impPh = Object.entries(data.placeholders.impression ?? {}).map(([k, v]) => `<code>{${esc(k)}}</code> ${esc(v.label)}${v.measure ? '（测量原子）' : ''}`).join('；')
    box.innerHTML = `<div class="row" style="gap:6px"><b>所见模板</b>
        <select data-tpl-scope>${scopes.map((x, k) => `<option value="${k}"${k === i ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
        <span class="muted small">${info}</span><span class="grow"></span>
        ${sc.tpl ? '<button class="small-btn quiet" data-tpl-history>历史版本</button>' : ''}
        <button class="small-btn quiet" data-tpl-close>收起</button></div>
      <div class="muted small" style="margin:4px 0">语法：<code>{占位符}</code>、<code>{占位符|缺省文字}</code>、<code>[可选片段]</code>（片段里有占位符没有值时整段省略）、<code>\\{</code> 等写字面量。模板文字不能写测量数字；每句一段。结节句子可用：${ph}${impPh ? `<br>印象段（W4.3，只作客观总结，不写诊断结论或随访建议）可用：${impPh}` : ''}</div>
      <div data-tpl-hist-box class="muted small" style="margin:4px 0" hidden></div>
      <textarea data-tpl-body rows="14" style="width:100%;font:12px ui-monospace,monospace"${sc.can ? '' : ' readonly'}>${esc(JSON.stringify(cur.body, null, 2))}</textarea>
      ${sc.can ? `<div class="row" style="gap:6px;margin-top:4px"><input type="text" data-tpl-note placeholder="这一版改了什么（可选）" maxlength="200" style="min-width:16em"><button class="small-btn quiet" data-tpl-add-imp title="在模板中加入 W4.3 客观影像印象段（自动汇总已确认结节数、最大结节径线与随访变化）">填入客观印象段（W4.3）</button><button class="small-btn primary" data-tpl-save>保存为新版本</button></div>`
        : '<div class="muted small">只有机构管理员（机构默认）或本科室的审核医师（科室模板）能修改。</div>'}`
    box.querySelector<HTMLSelectElement>('[data-tpl-scope]')!.onchange = e => show(Number((e.target as HTMLSelectElement).value))
    box.querySelector<HTMLButtonElement>('[data-tpl-close]')!.onclick = () => { box.hidden = true }
    const addImp = box.querySelector<HTMLButtonElement>('[data-tpl-add-imp]')
    if (addImp) addImp.onclick = () => {
      const ta = box.querySelector<HTMLTextAreaElement>('[data-tpl-body]')!
      try {
        const obj = JSON.parse(ta.value) as Record<string, unknown>
        obj.impression = {
          default: '印象：双肺见 {结节数} 枚结节[，较大者位于{最大结节位置|肺内}，平均径 {最大结节平均径}][，体积 {最大结节体积}][；与 {前片日期} 片比较，{随访概况}]。',
          none: '印象：双肺未见明确结节。',
        }
        ta.value = JSON.stringify(obj, null, 2)
        notice('已填入客观印象段模板（W4.3），点「保存为新版本」生效')
      } catch { notice('当前编辑框内容不是有效 JSON，请先修正后再填入', true) }
    }
    const histBtn = box.querySelector<HTMLButtonElement>('[data-tpl-history]')
    const histBox = box.querySelector<HTMLElement>('[data-tpl-hist-box]')
    if (histBtn && histBox) histBtn.onclick = async () => {
      if (!histBox.hidden) { histBox.hidden = true; return }
      histBox.hidden = false
      histBox.textContent = '正在读取历史版本…'
      try {
        const versions = await api<TemplateView[]>(`/api/imaging/findings-templates/versions?scope=${encodeURIComponent(sc.value)}`)
        if (!versions.length) { histBox.textContent = '暂无历史版本'; return }
        histBox.innerHTML = versions.map((v, idx) => `<div class="row" style="gap:6px;margin-top:2px"><span>v${v.version} · ${esc(v.created_by_name ?? '未知')} · ${v.created_at ? new Date(v.created_at).toLocaleString('zh-CN', { hour12: false }) : ''}${v.note ? ` · ${esc(v.note)}` : ''}</span>${sc.can ? `<button class="small-btn quiet" data-tpl-load-ver="${idx}">载入此版到编辑框</button>` : ''}</div>`).join('')
        histBox.querySelectorAll<HTMLButtonElement>('[data-tpl-load-ver]').forEach(btn => {
          btn.onclick = () => {
            const ver = versions[Number(btn.dataset.tplLoadVer)]
            if (!ver) return
            box.querySelector<HTMLTextAreaElement>('[data-tpl-body]')!.value = JSON.stringify(ver.body, null, 2)
            const noteInput = box.querySelector<HTMLInputElement>('[data-tpl-note]')
            if (noteInput) noteInput.value = `回退自 v${ver.version}`
            notice(`已将 v${ver.version} 载入编辑框，点「保存为新版本」即可生效`)
          }
        })
      } catch (err) { histBox.textContent = `读取历史版本失败：${(err as Error).message}` }
    }
    const save = box.querySelector<HTMLButtonElement>('[data-tpl-save]')
    if (save) save.onclick = async () => {
      let body: unknown
      try { body = JSON.parse(box.querySelector<HTMLTextAreaElement>('[data-tpl-body]')!.value) } catch { notice('模板不是有效的 JSON', true); return }
      save.disabled = true
      try {
        const r = await api<TemplateView>('/api/imaging/findings-templates', { method: 'PUT', body: JSON.stringify({ scope: sc.value, body, note: box.querySelector<HTMLInputElement>('[data-tpl-note]')?.value ?? '' }), headers: { 'Content-Type': 'application/json' } })
        notice(`所见模板已保存为 v${r.version}`)
        await mountTemplates(api, notice, box)
      } catch (err) { notice(`模板没有保存：${(err as Error).message}`, true); save.disabled = false }
    }
  }
  show(0)
}

interface FollowupViewData {
  study_id: string
  prior: { study_id: string; study_date: string | null; interval_days: number | null; reference: 'finalized' | 'confirmed'; signoff_version: number | null } | null
  prior_lesions?: Array<{ id: string; label: string | null; location: string | null; mean_diameter_mm: number | null }>
  registration: { quality: 'fine' | 'coarse' | 'none'; reliable: boolean; notes: string[] } | null
  notes: string[]
  items: Array<{
    link_id: string | null
    lesion_id: string | null
    prior_lesion_id: string | null
    source: 'ai' | 'manual' | null
    change: 'new' | 'enlarged' | 'shrunk' | 'stable' | 'disappeared' | null
    needs_review: boolean
    notes: string[]
    lesion: { id: string; label: string | null; location: string | null; status: string; mean_diameter_mm: number | null; volume_mm3: number | null } | null
    prior_lesion: { id: string; label: string | null; location: string | null; mean_diameter_mm: number | null; volume_mm3: number | null } | null
    metrics: {
      delta_mean_diameter_mm: number | null
      delta_volume_mm3: number | null
      delta_volume_pct: number | null
      vdt_days: number | null
      vdt_note: string | null
      within_error: boolean
    } | null
  }>
}

const FU_LOBE: Record<string, string> = { RUL: '右肺上叶', RML: '右肺中叶', RLL: '右肺下叶', LUL: '左肺上叶', LLL: '左肺下叶' }
const FU_CHANGE: Record<string, { text: string; cls: string }> = {
  new: { text: '新发', cls: 'warn' },
  enlarged: { text: '较前增大', cls: 'warn' },
  shrunk: { text: '较前缩小', cls: 'ok' },
  stable: { text: '较前相仿', cls: 'ok' },
  disappeared: { text: '本次未见', cls: '' },
}
const fmtSigned = (n: number | null | undefined, digits = 1, unit = '') =>
  typeof n === 'number' && Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(digits)}${unit}` : '—'

/** 患者页内联随访对比视图（W3：前片配准、逐结节变化分类、径线与体积差值、VDT、双片并排阅片 W3.4、重新匹配与拆开对应） */
async function mountFollowup(
  api: Api,
  notice: Notice,
  patientId: string,
  studyId: string,
  canEdit: boolean,
  box: HTMLElement,
  openViewer: (lesionId: string) => void,
  openCompare?: (priorStudyId: string) => void,
): Promise<void> {
  const base = `/api/patients/${patientId}/imaging/studies/${encodeURIComponent(studyId)}/followup`
  const load = async () => {
    try {
      const v = await api<FollowupViewData>(base)
      const regBadge = v.registration
        ? `<span class="pill ${v.registration.reliable ? 'ok' : 'warn'}" style="margin-left:6px">${v.registration.quality === 'fine' ? '配准可靠' : v.registration.quality === 'coarse' ? '粗配准（请核对）' : '未配准（请核对）'}</span>`
        : ''
      const priorText = v.prior
        ? `前片：<b>${esc(v.prior.study_date ?? '日期未知')}</b>${v.prior.interval_days != null ? `（间隔 ${v.prior.interval_days} 天）` : ''} · 参照：${v.prior.reference === 'finalized' ? `第 ${v.prior.signoff_version ?? 1} 版定稿快照` : '已确认结节（前片尚未定稿）'}`
        : '无可用前片检查'
      const allNotes = [...(v.notes ?? []), ...(v.registration?.notes ?? [])]
      const rows = v.items.map(it => {
        const cur = it.lesion
        const pri = it.prior_lesion
        const ch = it.needs_review
          ? `<span class="pill warn">待核对${it.change && FU_CHANGE[it.change] ? `（${FU_CHANGE[it.change]!.text}）` : ''}</span>`
          : it.change && FU_CHANGE[it.change]
            ? `<span class="pill ${FU_CHANGE[it.change]!.cls}">${FU_CHANGE[it.change]!.text}</span>`
            : '<span class="muted">未对比</span>'
        const dm = it.metrics ? fmtSigned(it.metrics.delta_mean_diameter_mm, 1, ' mm') : '—'
        const dv = it.metrics && it.metrics.delta_volume_mm3 !== null
          ? `${fmtSigned(it.metrics.delta_volume_mm3, 0, ' mm³')}${it.metrics.delta_volume_pct !== null ? `（${fmtSigned(it.metrics.delta_volume_pct, 0, '%')}）` : ''}`
          : '—'
        const vdt = it.metrics
          ? (it.metrics.vdt_days !== null ? `${Math.round(it.metrics.vdt_days)} 天${it.metrics.within_error ? '（误差内）' : ''}` : esc(it.metrics.vdt_note ?? '—'))
          : '—'
        const itemNotes = [
          it.metrics?.within_error ? '变化在测量误差范围内' : '',
          it.source === 'manual' ? '医生手动对应' : '',
          ...it.notes,
        ].filter(Boolean)
        return `<tr>
          <td class="small">${cur ? `<b>${esc(cur.label ?? cur.id)}</b> · ${esc(FU_LOBE[cur.location ?? ''] ?? cur.location ?? '未定位')} · ${cur.mean_diameter_mm != null ? `${cur.mean_diameter_mm.toFixed(1)} mm` : '—'}` : '<span class="muted">（前片结节消失）</span>'}</td>
          <td class="small">${pri ? `<b>${esc(pri.label ?? pri.id)}</b> · ${esc(FU_LOBE[pri.location ?? ''] ?? pri.location ?? '未定位')} · ${pri.mean_diameter_mm != null ? `${pri.mean_diameter_mm.toFixed(1)} mm` : '—'}` : '<span class="muted">—</span>'}</td>
          <td class="small">${ch}${itemNotes.length ? `<div class="muted">${esc(itemNotes.join('；'))}</div>` : ''}</td>
          <td class="small">${esc(dm)}</td>
          <td class="small">${esc(dv)}</td>
          <td class="small">${vdt}</td>
          <td class="small">
            ${cur ? `<button class="small-btn" data-fu-jump="${esc(cur.id)}">定位</button>` : ''}
            ${canEdit && it.link_id && cur && pri ? `<button class="small-btn quiet" data-fu-unlink="${esc(it.link_id)}" title="拆开这一对对应，改为本次新发 + 前片消失">拆开</button>` : ''}
          </td>
        </tr>`
      }).join('')
      box.innerHTML = `<div class="row" style="gap:8px"><b>随访对比</b><span class="small">${priorText}</span>${regBadge}<span class="grow"></span>
        ${v.prior && openCompare ? `<button class="small-btn primary" data-fu-compare="${esc(v.prior.study_id)}" title="以当前片与前片双 StudyInstanceUID 挂片打开 OHIF 1x2 并排对比视图（W3.4）">双片并排阅片（W3.4）</button>` : ''}
        ${canEdit ? '<button class="small-btn" data-fu-rematch>重新匹配</button>' : ''}</div>
        ${allNotes.length ? `<div class="muted small" style="margin:4px 0">${allNotes.map(n => esc(n)).join('；')}</div>` : ''}
        ${v.items.length ? `<table class="users" style="margin-top:4px"><thead><tr><th>本次结节</th><th>前片对应</th><th>变化</th><th>Δ平均径</th><th>Δ体积</th><th>VDT</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted small" style="margin-top:4px">暂无可对比的结节。</div>'}`
    } catch (err) {
      box.textContent = `随访对比读取失败：${(err as Error).message}`
    }
  }
  box.onclick = async e => {
    const el = e.target as HTMLElement
    const jump = el.closest<HTMLButtonElement>('[data-fu-jump]')
    if (jump) { openViewer(jump.dataset.fuJump!); return }
    const compare = el.closest<HTMLButtonElement>('[data-fu-compare]')
    if (compare && openCompare) { openCompare(compare.dataset.fuCompare!); return }
    const rematch = el.closest<HTMLButtonElement>('[data-fu-rematch]')
    if (rematch) {
      rematch.disabled = true
      try {
        await api(`${base}/rematch`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
        notice('已触发随访重新匹配')
      } catch (err) { notice(`重新匹配失败：${(err as Error).message}`, true) }
      await load()
      return
    }
    const unlink = el.closest<HTMLButtonElement>('[data-fu-unlink]')
    if (unlink) {
      unlink.disabled = true
      try {
        await api(`/api/patients/${patientId}/imaging/followup-links/${encodeURIComponent(unlink.dataset.fuUnlink!)}/unlink`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
        notice('已拆开随访对应关系')
      } catch (err) { notice(`拆开失败：${(err as Error).message}`, true) }
      await load()
    }
  }
  await load()
}

/** 读取并显示影像检查；绑定上传按钮。患者页每次重绘「原始报告 / 影像」标签后调用。openDoc：生成所见草稿后打开文档。 */
export async function mountStudies(api: Api, notice: Notice, patientId: string, isCurrent: () => boolean, openDoc?: (docId: string) => Promise<void>): Promise<void> {
  const box = document.getElementById('ptDicomStudies')
  const listEl = document.getElementById('ptDicomList')
  if (!box || !listEl) return
  const canEdit = Boolean(box.querySelector('[data-dicom]'))
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 展开了审核视图 / 随访对比的检查（列表定时刷新后重新挂上） */
  const open = new Set<string>()
  const openFollowup = new Set<string>()
  let studies: StudyView[] = []
  /** 在阅片器中打开（lesionId：审核视图里「跳转」，打开后结节面板定位到该结节；priorStudyUid：W3.4 双片并排挂片） */
  const openViewer = async (studyUid: string, lesionId?: string, priorStudyUid?: string) => {
    // 先同步开窗（异步之后再开会被浏览器拦截）；阅片器在独立子域名，凭一次性票据换取那里的只读 Cookie
    const win = window.open('', '_blank')
    try {
      const t = await api<{ url: string }>('/api/imaging/viewer-ticket', { method: 'POST', body: JSON.stringify({ study_uid: studyUid, ...(priorStudyUid ? { prior_study_uid: priorStudyUid } : {}), ...(lesionId ? { lesion_id: lesionId } : {}) }), headers: { 'Content-Type': 'application/json' } })
      if (win) { win.opener = null; win.location.href = t.url }
    } catch (err) {
      win?.close()
      notice(`不能打开阅片器：${(err as Error).message}`, true)
    }
  }
  /** 医生刚点开的审核视图（只有这一次的请求记效率埋点；之后的自动刷新不记） */
  let justOpened: string | null = null
  const mountOpen = () => {
    for (const id of openFollowup) {
      const el = listEl.querySelector<HTMLElement>(`[data-followup-box="${CSS.escape(id)}"]`)
      const uid = studies.find(s => s.id === id)?.study_uid
      if (el) void mountFollowup(
        api,
        notice,
        patientId,
        id,
        canEdit,
        el,
        lesionId => { if (uid) void openViewer(uid, lesionId) },
        priorStudyId => {
          const prior = studies.find(s => s.id === priorStudyId)
          if (!uid || !prior?.study_uid || prior.originals_deleted) {
            notice(prior?.originals_deleted ? `前片原件已删除：${prior.originals_deleted.message}` : '找不到前片影像 UID，暂无法并排阅片', true)
            return
          }
          void openViewer(uid, undefined, prior.study_uid)
        },
      )
    }
    for (const id of open) {
      const el = listEl.querySelector<HTMLElement>(`[data-review-box="${CSS.escape(id)}"]`)
      const uid = studies.find(s => s.id === id)?.study_uid
      if (el) void mountReview(api, notice, patientId, id, el, () => void refresh(), lesionId => { if (uid) void openViewer(uid, lesionId) }, id === justOpened)
    }
    justOpened = null
  }
  const refresh = async () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!isCurrent()) return
    try {
      const [list, reviews] = await Promise.all([
        api<StudyView[]>(`/api/patients/${patientId}/imaging/studies`),
        api<ReviewSummary[]>(`/api/patients/${patientId}/imaging/reviews`).catch(() => [] as ReviewSummary[]),
      ])
      if (!isCurrent()) return
      studies = list
      listEl.innerHTML = render(list, canEdit, new Map(reviews.map(r => [r.study_id, r])), open, openFollowup)
      mountOpen()
      // 有排队 / 分析中的检查时隔几秒刷新
      if (list.some(st => st.runs[0] && (st.runs[0].status === 'queued' || st.runs[0].status === 'running'))) timer = setTimeout(() => void refresh(), 5000)
    } catch (err) {
      if (isCurrent()) listEl.textContent = `影像检查读取失败：${(err as Error).message}`
    }
  }
  listEl.onclick = async e => {
    // 审核视图与随访对比里的点击由各自面板处理
    if ((e.target as HTMLElement).closest('[data-review-box], [data-followup-box]')) return
    const view = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-view]')
    if (view) { await openViewer(view.dataset.view!); return }
    const fu = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-followup]')
    if (fu) {
      const id = fu.dataset.followup!
      if (openFollowup.has(id)) openFollowup.delete(id)
      else openFollowup.add(id)
      await refresh()
      return
    }
    const rv = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-review]')
    if (rv) {
      const id = rv.dataset.review!
      if (open.has(id)) open.delete(id)
      else { open.add(id); justOpened = id }
      await refresh()
      return
    }
    const draft = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-draft]')
    if (draft) {
      draft.disabled = true
      await generateDraft(api, notice, patientId, draft.dataset.draft!, openDoc)
      draft.disabled = false
      return
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-analyze]')
    if (!btn) return
    btn.disabled = true
    const run = (confirmChest: boolean) => api<{ shadow?: boolean }>(`/api/patients/${patientId}/imaging/studies/${encodeURIComponent(btn.dataset.analyze!)}/analyze`, { method: 'POST', body: JSON.stringify({ task: 'lung_nodule', ...(confirmChest ? { confirm_chest: true } : {}) }), headers: { 'Content-Type': 'application/json' } })
    try {
      let r: { shadow?: boolean } | null = null
      try { r = await run(false) } catch (err) {
        // DICOM 里判断不出部位：请医生确认是胸部 CT 再分析（确认记入访问留痕）
        if ((err as ApiError).body?.code !== 'needs_confirmation') throw err
        const ok = await askConfirm({ title: '确认是胸部 CT', message: `${(err as Error).message.replace(/。确认是胸部 CT 后，可点「开始分析」$/, '')}。\n确认这次检查是胸部 CT 后再做肺结节分析；确认人会记入访问记录。`, confirm: '是胸部 CT，开始分析' })
        if (ok) r = await run(true)
      }
      if (r) notice(r.shadow ? '影像 AI 处于影子模式：已在后台分析，结果不显示' : '已开始分析，完成后结果会出现在这里')
    } catch (err) { notice(`不能分析：${(err as Error).message}`, true) }
    await refresh()
  }
  const pick = (input: HTMLInputElement | null) => {
    if (!input) return
    input.onchange = async () => {
      const files = Array.from(input.files ?? []).filter(f => !f.name.startsWith('.'))
      input.value = ''
      if (!files.length) return
      try { await uploadDicomStudies(api, notice, patientId, files, refresh) } catch (err) { notice(`DICOM 上传失败：${(err as Error).message}`, true) }
      await refresh()
    }
  }
  pick(document.getElementById('ptDicomFiles') as HTMLInputElement | null)
  pick(document.getElementById('ptDicomFolder') as HTMLInputElement | null)
  const tplBtn = box.querySelector<HTMLButtonElement>('[data-findings-tpl]')
  const tplBox = document.getElementById('ptFindingsTpl')
  if (tplBtn && tplBox) tplBtn.onclick = () => { tplBox.hidden = !tplBox.hidden; if (!tplBox.hidden) void mountTemplates(api, notice, tplBox) }
  box.querySelectorAll<HTMLButtonElement>('[data-dicom]').forEach(b => {
    b.onclick = () => document.getElementById(b.dataset.dicom === 'folder' ? 'ptDicomFolder' : 'ptDicomFiles')?.click()
  })
  await refresh()
}
