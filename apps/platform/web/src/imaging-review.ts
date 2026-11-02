import { esc } from './dom.ts'

/**
 * 影像审核视图与定稿（T2.7）：患者页影像检查表里每个检查的「审核」区块。
 * 按结节对比 AI 原值、初写修改、审核修改与当前值（数据来自病灶留痕）；初写完成、定稿按钮；定稿历史。
 * 服务端：src/imaging/review.ts；设计：docs/design/IMAGING_STUDIES.md「审核与定稿」。
 */

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notice = (msg: string, error?: boolean) => void

export type ReviewState = 'reading' | 'submitted' | 'finalized' | 'amending'
export interface ReviewSummary {
  study_id: string; state: ReviewState; revision: number
  latest_signoff: { version: number; signed_by: string; signed_by_name: string | null; signed_at: string; mode: string } | null
}
interface Change { event_id: number; at: string; user_name: string | null; user_id: string; action: string; after_signoff: number; changes: Record<string, { before: unknown; after: unknown }> }
interface Lesion {
  id: string; label: string | null; source: 'ai' | 'manual'; status: string; reject_reason: string | null; version: number; location: string | null
  metrics: Record<string, unknown>
  ai_original: { label: string | null; location: string | null; metrics: Record<string, unknown> } | null
  added_by: { user_name: string | null; user_id: string; phase: string } | null
  reader_changes: Change[]; reviewer_changes: Change[]
  finalized: { signoff_version: number; lesion_version: number; status: string; current: boolean } | null
}
interface SignoffMeta { id: string; version: number; signed_by_name: string | null; signed_by: string; signed_at: string; mode: string; snapshot_hash: string; lesions: { total: number; confirmed: number; rejected: number } }
interface View {
  study_id: string; state: ReviewState; revision: number; reading_mode: 'org' | 'personal'; my_role: 'reader' | 'reviewer' | null
  counts: { proposed: number; confirmed: number; rejected: number }
  submissions: Array<{ user_name: string | null; at: string; revision: number }>
  lesions: Lesion[]; removed_since_finalized: Array<{ id: string; label: string | null }>
  signoffs: SignoffMeta[]; latest_signoff: SignoffMeta | null
  finalize: { allowed: boolean; blockers: Array<{ code: string; message: string }> }
}

const STATE: Record<ReviewState, { text: string; cls: string }> = {
  reading: { text: '初写中', cls: '' },
  submitted: { text: '待审核', cls: 'warn' },
  finalized: { text: '已定稿', cls: 'ok' },
  amending: { text: '定稿后修改中', cls: 'warn' },
}
const LOBE: Record<string, string> = { RUL: '右肺上叶', RML: '右肺中叶', RLL: '右肺下叶', LUL: '左肺上叶', LLL: '左肺下叶' }
const TYPE: Record<string, string> = { solid: '实性', part_solid: '部分实性', pure_ggo: '纯磨玻璃' }
const STATUS: Record<string, string> = { proposed: '待确认', confirmed: '已确认', rejected: '已否决', superseded: '已撤销' }
const ACTION: Record<string, string> = { confirm: '确认', reject: '否决', edit: '修改', withdraw: '撤销', create: '补充' }
const FIELD: Record<string, string> = {
  status: '状态', reject_reason: '否决原因', location: '位置', label: '名称', seg_ref: '轮廓',
  mean_diameter_mm: '平均径', long_axis_mm: '长径', short_axis_mm: '短径', volume_mm3: '体积', mean_hu: 'CT 值', nodule_type: '密度', segmentation: '分割',
}
const MODE: Record<string, string> = { dual: '初写与审核分开', self: '自审', single: '单人' }
const when = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false })

const num = (v: unknown, d = 1) => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—'
function valueText(k: string, v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (k === 'status') return STATUS[String(v)] ?? String(v)
  if (k === 'location') return LOBE[String(v)] ?? String(v)
  if (k === 'nodule_type') return TYPE[String(v)] ?? String(v)
  if (k === 'seg_ref') return '已更新'
  if (typeof v === 'number') return k === 'volume_mm3' || k === 'mean_hu' ? num(v, 0) : num(v)
  return String(v)
}
/** 一个结节的主要测量：平均径（长 × 短）、密度、位置 */
function measures(m: Record<string, unknown>, location: string | null): string {
  const parts = [
    `平均径 ${num(m.mean_diameter_mm)} mm${m.long_axis_mm !== undefined ? `（${num(m.long_axis_mm)} × ${num(m.short_axis_mm)}）` : ''}`,
    m.volume_mm3 !== undefined ? `体积 ${num(m.volume_mm3, 0)} mm³` : '',
    TYPE[String(m.nodule_type ?? '')] ?? '',
    location ? LOBE[location] ?? location : '',
  ].filter(Boolean)
  return parts.map(esc).join(' · ')
}
function changeList(list: Change[]): string {
  if (!list.length) return '<span class="muted">—</span>'
  return list.map(c => {
    const fields = Object.entries(c.changes).filter(([k]) => !(k === 'status' && (c.action === 'confirm' || c.action === 'reject' || c.action === 'withdraw')))
    const detail = fields.map(([k, d]) => `${esc(FIELD[k] ?? k)} ${esc(valueText(k, d.before))} → ${esc(valueText(k, d.after))}`).join('；')
    const reason = c.action === 'reject' && c.changes.reject_reason ? `（${esc(String(c.changes.reject_reason.after ?? ''))}）` : ''
    return `<div><b>${esc(ACTION[c.action] ?? c.action)}</b>${c.action === 'reject' ? reason : detail ? `：${detail}` : ''}
      <div class="muted">${esc(c.user_name ?? c.user_id)} · ${when(c.at)}${c.after_signoff ? ` · 第 ${c.after_signoff} 版定稿后` : ''}</div></div>`
  }).join('')
}

/** 检查表里的审核状态标记 */
export function reviewBadge(s: ReviewSummary | undefined): string {
  if (!s) return '<span class="muted">—</span>'
  const st = STATE[s.state]
  const so = s.latest_signoff
  return `<span class="pill ${st.cls}">${st.text}${so ? ` v${so.version}` : ''}</span>${so ? `<div class="muted">${esc(so.signed_by_name ?? '')} ${when(so.signed_at)}</div>` : ''}`
}

function render(v: View): string {
  const st = STATE[v.state]
  const latest = v.latest_signoff
  const head = `<div class="row"><b>审核视图</b><span class="pill ${st.cls}" style="margin-left:8px">${st.text}${latest ? ` · 第 ${latest.version} 版` : ''}</span>
    <span class="muted" style="margin-left:8px">${v.reading_mode === 'personal' ? '个人空间：本人即可定稿' : v.my_role === 'reviewer' ? '我的阅片角色：审核' : '我的阅片角色：初写'}</span>
    ${v.submissions.length ? `<span class="muted" style="margin-left:8px">初写完成：${v.submissions.map(s => `${esc(s.user_name ?? '')} ${when(s.at)}`).join('；')}</span>` : ''}</div>`
  const rows = v.lesions.map(l => {
    const ai = l.ai_original ? measures(l.ai_original.metrics, l.ai_original.location) : l.added_by ? `<span class="muted">医生补充（${esc(l.added_by.user_name ?? '')}）</span>` : '<span class="muted">—</span>'
    const fin = l.finalized ? (l.finalized.current ? `<div class="muted">与第 ${l.finalized.signoff_version} 版定稿一致</div>` : `<div class="danger-text">定稿后有改动（定稿时 v${l.finalized.lesion_version}）</div>`) : ''
    return `<tr>
      <td><b>${esc(l.label ?? '结节')}</b><div class="muted">${l.source === 'ai' ? 'AI 检出' : '医生补充'}</div></td>
      <td class="small">${ai}</td>
      <td class="small">${changeList(l.reader_changes)}</td>
      <td class="small">${changeList(l.reviewer_changes)}</td>
      <td class="small">${measures(l.metrics, l.location)}</td>
      <td class="small">${esc(STATUS[l.status] ?? l.status)}${l.reject_reason ? `（${esc(l.reject_reason)}）` : ''}<div class="muted">v${l.version}</div>${fin}</td>
      <td><button class="small-btn" data-rv-jump="${esc(l.id)}">跳转</button></td></tr>`
  }).join('')
  const removed = v.removed_since_finalized.length ? `<div class="danger-text small">定稿后撤销：${v.removed_since_finalized.map(r => esc(r.label ?? r.id)).join('、')}</div>` : ''
  const table = v.lesions.length
    ? `<table class="users"><thead><tr><th>结节</th><th>AI 原值</th><th>初写修改</th><th>审核修改</th><th>当前值</th><th>状态 / 版本</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="muted small">没有结节（定稿即「未见结节」）。</div>'
  // 已提交且之后病灶没有改动时不再显示（再交一次只会重复记一条初写完成）
  const lastSub = v.submissions[v.submissions.length - 1]
  const canSubmit = v.state !== 'finalized' && !(v.state === 'submitted' && lastSub && lastSub.revision === v.revision)
  const actions = `<div class="row" style="margin-top:6px;gap:6px">
    ${canSubmit ? `<button class="small-btn" data-rv="submit"${v.counts.proposed ? ` disabled title="还有 ${v.counts.proposed} 个待确认"` : ''}>初写完成，提交审核</button>` : ''}
    ${v.finalize.allowed ? `<input type="text" data-rv-note placeholder="审核意见（可选）" maxlength="500" style="min-width:12em">
      <button class="small-btn primary" data-rv="finalize">${latest ? `定稿（生成第 ${latest.version + 1} 版）` : '定稿'}</button>` : ''}
    ${!v.finalize.allowed && v.finalize.blockers.length && v.state !== 'finalized' ? `<span class="muted small">暂不能定稿：${v.finalize.blockers.map(b => esc(b.message)).join('；')}</span>` : ''}
  </div>`
  const history = v.signoffs.length ? `<div class="small" style="margin-top:6px"><b>定稿记录</b>${v.signoffs.map(s => `<div>第 ${s.version} 版 · ${esc(s.signed_by_name ?? s.signed_by)} · ${when(s.signed_at)} · ${esc(MODE[s.mode] ?? s.mode)} · 已确认 ${s.lesions.confirmed} · 已否决 ${s.lesions.rejected}
    <span class="muted" title="快照 SHA-256">#${esc(s.snapshot_hash.slice(0, 8))}</span></div>`).join('')}</div>` : ''
  return `${head}${table}${removed}${actions}${history}`
}

/**
 * 在 box 里显示一个检查的审核视图。onChanged：提交 / 定稿后刷新检查表；openViewer：在阅片器中打开并定位到结节。
 */
/** opened = 医生刚点开审核视图（效率埋点只记这一次；自动刷新、操作后重新加载不记） */
export async function mountReview(api: Api, notice: Notice, patientId: string, studyId: string, box: HTMLElement, onChanged: () => void, openViewer: (lesionId: string) => void, opened = false): Promise<void> {
  const base = `/api/patients/${patientId}/imaging/studies/${encodeURIComponent(studyId)}`
  let view: View
  let first = opened
  const load = async () => {
    try {
      view = await api<View>(`${base}/review${first ? '?opened=1' : ''}`)
      first = false
      box.innerHTML = render(view)
    } catch (err) { box.textContent = `审核视图读取失败：${(err as Error).message}` }
  }
  box.onclick = async e => {
    const el = e.target as HTMLElement
    const jump = el.closest<HTMLButtonElement>('[data-rv-jump]')
    if (jump) { openViewer(jump.dataset.rvJump!); return }
    const btn = el.closest<HTMLButtonElement>('[data-rv]')
    if (!btn || !view) return
    if (btn.dataset.rv === 'finalize' && !btn.dataset.confirm) {
      // 两步确认：定稿后不可修改，只能再生成新版本
      btn.dataset.confirm = '1'
      btn.textContent = '确认定稿（不可修改，之后的改动生成新版本）'
      return
    }
    btn.disabled = true
    try {
      if (btn.dataset.rv === 'submit') {
        await api(`${base}/review/submit`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
        notice('已提交审核')
      } else {
        const note = box.querySelector<HTMLInputElement>('[data-rv-note]')?.value ?? ''
        const r = await api<{ version: number }>(`${base}/finalize`, { method: 'POST', body: JSON.stringify({ expected_revision: view.revision, note }), headers: { 'Content-Type': 'application/json' } })
        notice(`已定稿（第 ${r.version} 版）`)
      }
      onChanged()
    } catch (err) { notice((err as Error).message, true) }
    await load()
  }
  await load()
}
