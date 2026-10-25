import { esc } from './dom.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notice = (msg: string, error?: boolean) => void

interface SeriesView { id: string; modality: string | null; body_part: string | null; description: string | null; slice_thickness: number | null; kernel: string | null; instances: number }
interface StudyView {
  id: string; study_date: string | null; modalities: string[]; description: string | null; accession?: string | null
  source: 'upload' | 'pacs'; created_at: string; series: SeriesView[]; lesions: { proposed: number; confirmed: number; rejected: number }
  runs: RunView[]
}
interface RunView {
  id: string; task: string; model_version: string | null; status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted'; error: string | null
  summary: { found?: number; warnings?: string[]; elapsed_ms?: number } | null; created_at: string; finished_at: string | null
}

const TASK: Record<string, string> = { lung_nodule: '肺结节' }

/** 最近一次分析的状态文字 */
function runLine(r: RunView | undefined): string {
  if (!r) return '<span class="muted">未分析</span>'
  const task = esc(TASK[r.task] ?? r.task)
  if (r.status === 'queued') return `${task}：排队中…`
  if (r.status === 'running') return `${task}：分析中…`
  if (r.status === 'done') {
    const warn = r.summary?.warnings?.length ? `<div class="muted">${r.summary.warnings.map(w => esc(w)).join('；')}</div>` : ''
    return `${task}：检出 ${r.summary?.found ?? 0} 个${r.model_version ? `<div class="muted">${esc(r.model_version)}</div>` : ''}${warn}`
  }
  return `<span class="danger-text">${task}：${r.status === 'interrupted' ? '已中断' : '失败'}</span><div class="muted">${esc(r.error ?? '')}</div>`
}
interface ImportResult {
  studies: StudyView[]; files: { received: number; uploaded: number; duplicates: number; skipped: Array<{ name: string; reason: string }> }; conflicts: number
  analysis?: Array<{ study_id: string; task: string; run_id: string | null; skipped: string | null }>
}

/** 每批上传的大小上限（服务端默认单次 2 GB，这里分小批，失败时只需重传一批） */
const BATCH_BYTES = 300 * 1024 * 1024

/** 影像检查（DICOM）区块的占位，放在患者页「原始报告 / 影像」标签顶部；mountStudies 填充内容 */
export function studiesSection(canEdit: boolean): string {
  return `<section class="pt-dicom" id="ptDicomStudies">
    <div class="row"><b>影像检查（DICOM）</b><span class="grow"></span>
      ${canEdit ? `<button class="small-btn" data-dicom="files" title="选择 DICOM 文件或 zip 压缩包">上传 DICOM 文件</button>
      <button class="small-btn" data-dicom="folder" title="选择包含一次检查的文件夹（光盘导出的目录也可以）">上传文件夹</button>
      <input type="file" id="ptDicomFiles" accept=".dcm,.dicom,.zip,application/dicom,application/zip" multiple hidden>
      <input type="file" id="ptDicomFolder" webkitdirectory multiple hidden>` : ''}
    </div>
    <div id="ptDicomList" class="muted small">正在读取影像检查…</div>
  </section>`
}

function seriesLine(s: SeriesView): string {
  return [s.modality, s.body_part, s.description, s.slice_thickness ? `${s.slice_thickness} mm` : null, s.kernel, `${s.instances} 层`].filter(Boolean).map(x => esc(String(x))).join(' · ')
}

function render(list: StudyView[], canEdit: boolean): string {
  if (!list.length) return '<div class="muted small">还没有影像检查。上传 DICOM 后会在这里按检查列出，并自动进入 AI 分析。</div>'
  return `<table class="users"><thead><tr><th>检查日期</th><th>模态</th><th>检查描述</th><th>序列</th><th>AI 分析</th><th>病灶</th><th>来源</th></tr></thead><tbody>
    ${list.map(st => {
      const last = st.runs[0]
      const busy = last && (last.status === 'queued' || last.status === 'running')
      return `<tr>
      <td>${esc(st.study_date ?? '未知')}</td><td>${esc(st.modalities.join(' / ') || '—')}</td><td>${esc(st.description ?? '')}</td>
      <td class="small">${st.series.map(s => `<div>${seriesLine(s)}</div>`).join('')}</td>
      <td class="small">${runLine(last)}${canEdit && !busy ? `<div><button class="small-btn" data-analyze="${esc(st.id)}">${last ? '重新分析' : '开始分析'}</button></div>` : ''}</td>
      <td class="small">${st.lesions.proposed + st.lesions.confirmed + st.lesions.rejected ? `待确认 ${st.lesions.proposed} · 已确认 ${st.lesions.confirmed} · 已否决 ${st.lesions.rejected}` : '<span class="muted">—</span>'}</td>
      <td class="muted small">${st.source === 'pacs' ? 'PACS' : '手工上传'}<br>${new Date(st.created_at).toLocaleString('zh-CN', { hour12: false })}</td></tr>`
    }).join('')}
  </tbody></table>`
}

async function upload(api: Api, notice: Notice, patientId: string, files: File[]): Promise<void> {
  const batches: File[][] = []
  let cur: File[] = [], size = 0
  for (const f of files) {
    if (cur.length && size + f.size > BATCH_BYTES) { batches.push(cur); cur = []; size = 0 }
    cur.push(f); size += f.size
  }
  if (cur.length) batches.push(cur)
  let uploaded = 0, duplicates = 0, conflicts = 0
  const skipped: string[] = []
  const notApplicable = new Set<string>()
  for (const [i, batch] of batches.entries()) {
    notice(batches.length > 1 ? `正在上传 DICOM（第 ${i + 1} / ${batches.length} 批）…` : '正在上传 DICOM…')
    const fd = new FormData()
    for (const f of batch) fd.append('files', f)
    const r = await api<ImportResult>(`/api/patients/${patientId}/imaging/dicom`, { method: 'POST', body: fd })
    uploaded += r.files.uploaded; duplicates += r.files.duplicates; conflicts += r.conflicts
    skipped.push(...r.files.skipped.map(s => `${s.name}（${s.reason}）`))
    for (const x of r.analysis ?? []) if (x.skipped) notApplicable.add(x.skipped)
  }
  const parts = [`新入库 ${uploaded} 个文件`, duplicates ? `${duplicates} 个已存在` : '', skipped.length ? `跳过 ${skipped.length} 个` : ''].filter(Boolean)
  const analysis = notApplicable.size ? `；未自动分析：${[...notApplicable].join('；')}` : ''
  notice(`DICOM 上传完成：${parts.join('，')}${conflicts ? `；有 ${conflicts} 个检查已属于本机构的其他患者，未关联到这位患者` : ''}${analysis}`, conflicts > 0)
  if (skipped.length) console.info('跳过的文件：', skipped)
}

/** 读取并显示影像检查；绑定上传按钮。患者页每次重绘「原始报告 / 影像」标签后调用。 */
export async function mountStudies(api: Api, notice: Notice, patientId: string, isCurrent: () => boolean): Promise<void> {
  const box = document.getElementById('ptDicomStudies')
  const listEl = document.getElementById('ptDicomList')
  if (!box || !listEl) return
  const canEdit = Boolean(box.querySelector('[data-dicom]'))
  let timer: ReturnType<typeof setTimeout> | null = null
  const refresh = async () => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!isCurrent()) return
    try {
      const list = await api<StudyView[]>(`/api/patients/${patientId}/imaging/studies`)
      if (!isCurrent()) return
      listEl.innerHTML = render(list, canEdit)
      // 有排队 / 分析中的检查时隔几秒刷新
      if (list.some(st => st.runs[0] && (st.runs[0].status === 'queued' || st.runs[0].status === 'running'))) timer = setTimeout(() => void refresh(), 5000)
    } catch (err) {
      if (isCurrent()) listEl.textContent = `影像检查读取失败：${(err as Error).message}`
    }
  }
  listEl.onclick = async e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-analyze]')
    if (!btn) return
    btn.disabled = true
    try {
      await api(`/api/patients/${patientId}/imaging/studies/${encodeURIComponent(btn.dataset.analyze!)}/analyze`, { method: 'POST', body: JSON.stringify({ task: 'lung_nodule' }), headers: { 'Content-Type': 'application/json' } })
      notice('已开始分析，完成后结果会出现在这里')
    } catch (err) { notice(`不能分析：${(err as Error).message}`, true) }
    await refresh()
  }
  const pick = (input: HTMLInputElement | null) => {
    if (!input) return
    input.onchange = async () => {
      const files = Array.from(input.files ?? []).filter(f => !f.name.startsWith('.'))
      input.value = ''
      if (!files.length) return
      try { await upload(api, notice, patientId, files) } catch (err) { notice(`DICOM 上传失败：${(err as Error).message}`, true) }
      await refresh()
    }
  }
  pick(document.getElementById('ptDicomFiles') as HTMLInputElement | null)
  pick(document.getElementById('ptDicomFolder') as HTMLInputElement | null)
  box.querySelectorAll<HTMLButtonElement>('[data-dicom]').forEach(b => {
    b.onclick = () => document.getElementById(b.dataset.dicom === 'folder' ? 'ptDicomFolder' : 'ptDicomFiles')?.click()
  })
  await refresh()
}
