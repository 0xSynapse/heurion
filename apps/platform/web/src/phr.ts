/**
 * 知家（患者个人应用 V0，docs/design/PATIENT.md）：家庭健康顾问的移动 Web 外壳。
 * - 家人建档 = 登录用户（个人租户）患者库里的患者；接口全部复用 /api/patients*，本页不引入新权限。
 * - 本批立起数据闭环：建档 → 上传报告 / 手动录入化验 → 待确认 → 化验趋势；AI 建议与红线守卫是下一批。
 * - 独立于主应用（/app）的页面：手机浏览器优先，桌面浏览器同套。
 */
import './phr.css'
import { icon } from './icons.ts'
import { powDelay, solvePow, type PowSolution } from './pow.ts'

// —— 类型（与 patients.ts 的行结构对应；本页只用到这些字段） ——

interface Patient {
  id: string; code: string; name: string | null; sex: 'M' | 'F' | null; birth_year: number | null; tags: string[]
  status: string; labs?: number; lab_reports?: number; last_lab?: string | null; pending?: number
}
interface Lab {
  id: string; record_id: string | null; test_key: string; test_name: string
  value_num: number | null; value_text: string | null; unit: string | null
  ref_low: number | null; ref_high: number | null; ref_text: string | null; flag: 'H' | 'L' | null
  collected_on: string | null; status: 'pending' | 'confirmed' | 'rejected' | 'superseded'; source: string
  locator: { page?: number; verified?: boolean } | null
  std_value: number | null; std_unit: string | null; std_ref_low: number | null; std_ref_high: number | null
  same_day?: Lab[]
}
interface RecordRow {
  id: string; kind: string; title: string; report_date: string | null; file_id: string | null
  status: 'pending' | 'confirmed' | 'rejected'; extraction: string | null; extraction_note: string | null; created_at: string
}
interface Detail extends Patient {
  records: RecordRow[]; latest_labs: Lab[]
  documents: Array<{ doc_id: string; kind: string; title: string; updated_at: string; can_open: boolean }>
  pending_proposals: Array<{ id: string; kind: string; payload: Record<string, unknown>; reason: string }>
}

// —— 基础 ——

const app = document.getElementById('phr')!
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T

const token = (): string => { try { return localStorage.getItem('heurion.token') ?? '' } catch { return '' } }

class ApiErr extends Error { constructor(message: string, readonly status: number, readonly code = '') { super(message) } }

async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  // 知家一律用个人空间的患者库（加入了医院的账户，工作台用医院、知家仍是自己的家人档案）
  const res = await fetch(path, { ...opts, headers: { ...(opts.headers ?? {}), Authorization: `Bearer ${token()}`, 'X-Heurion-Space': 'personal' } })
  if (res.status === 401) {
    try { localStorage.removeItem('heurion.token') } catch { /* 无痕模式 */ }
    renderAuth(); throw new ApiErr('未登录', 401)
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string }
  if (!res.ok) throw new ApiErr(body.error ?? `请求失败（${res.status}）`, res.status, body.code ?? '')
  return body as T
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
function toast(msg: string, error = false): void {
  document.querySelector('.toast')?.remove()
  const el = document.createElement('div')
  el.className = `toast${error ? ' err' : ''}`
  el.textContent = msg
  document.body.append(el)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.remove(), error ? 4200 : 2600)
}

/** 打开一个 <dialog> 弹层（手机浏览器原生支持），返回弹层元素供取值。 */
function dlg(html: string): HTMLDialogElement {
  const d = document.createElement('dialog')
  d.innerHTML = html
  document.body.append(d)
  d.addEventListener('click', e => { if (e.target === d) d.close() })
  // 关掉就移除（不然页面里会留下一堆关闭的弹层，后面的选择器会选到旧的）
  d.addEventListener('close', () => setTimeout(() => d.remove(), 0))
  d.showModal()
  return d
}

function confirmDlg(text: string, okLabel = '确定'): Promise<boolean> {
  return new Promise(resolve => {
    const d = dlg(`<h3>${esc(text)}</h3><div class="dlg-act"><button class="btn ghost" data-x="0">取消</button><button class="btn" data-x="1">${esc(okLabel)}</button></div>`)
    d.addEventListener('close', () => resolve(false))
    d.querySelectorAll('button[data-x]').forEach(b => b.addEventListener('click', () => { resolve(b.getAttribute('data-x') === '1'); d.close() }))
  })
}

// —— 小工具 ——

const SEX: Record<string, string> = { M: '男', F: '女' }
const KIND: Record<string, string> = { lab_report: '化验单', discharge: '出院小结', pathology: '病理', imaging: '影像', note: '记录', other: '其他' }
const EXTRACT: Record<string, string> = { queued: '提取排队中', running: '提取中', done: '已提取', failed: '提取失败', skipped: '未能自动识别' }
const STATUS: Record<string, string> = { pending: '待确认', confirmed: '已确认', rejected: '已驳回', superseded: '已替换' }
/** 关联文档的类型（成员页「记录」页签里显示）。 */
const DOC_KIND: Record<string, string> = { archive: '健康档案', brief: '就诊简报', case_report: '病例报告', followup: '随访小结', discussion: '讨论', other: '其他' }

/** 家人标记（PATIENT.md §3 特殊人群守卫的数据基础）。 */
const FAMILY_TAGS = ['孕产', '哺乳', '儿童'] as const

/** Heurion 品牌标志（知家是 Heurion 的家庭健康子品牌，品牌资产随界面露出）。 */
const MARK = (cls: string): string => `<svg class="${cls}" viewBox="-2 6 96 88" aria-hidden="true">
  <rect x="0" y="10" width="18" height="80" rx="9" fill="#151C19"/><rect x="62" y="30" width="18" height="60" rx="9" fill="#151C19"/>
  <rect x="14" y="42" width="52" height="18" rx="9" fill="#00C472"/><circle cx="80" cy="20" r="11" fill="#00C472"/></svg>`

const display = (p: { name: string | null; code: string }): string => p.name || p.code
const ageText = (birthYear: number | null): string => {
  if (!birthYear) return '—'
  const y = new Date().getFullYear()
  const months = (new Date().getFullYear() - birthYear) * 12 + new Date().getMonth() - (new Date().getMonth())
  if (birthYear === y) return `${Math.max(months, 0) || 1} 个月`
  return `${y - birthYear} 岁`
}
const dayShort = (s: string | null): string => s ? s.slice(5) : ''

/** 化验值展示：优先数值 + 单位，文字值（如「<40」）照抄。 */
function valText(l: Lab): string {
  return l.value_num !== null ? `${l.value_num}${l.unit ? ` ${l.unit}` : ''}` : (l.value_text ?? '—')
}
/** 趋势点上的单位：用标准单位（同一项目画在一起才有意义）。 */
const trendUnit = (l: Lab): string => l.std_unit ?? l.unit ?? ''

/**
 * 单项趋势小图：标准单位的点连线 + 参考范围带；异常点按 H/L 着色。
 * labs 按 collected_on 升序（labs() 的排序就是升序）。
 */
function spark(labs: Lab[]): string {
  const pts = labs.filter(l => l.std_value !== null && l.collected_on)
  if (!pts.length) return ''
  const ys = pts.map(l => l.std_value!)
  const lows = pts.map(l => l.std_ref_low).filter((x): x is number => x !== null)
  const highs = pts.map(l => l.std_ref_high).filter((x): x is number => x !== null)
  const lo = Math.min(...ys, ...lows)
  const hi = Math.max(...ys, ...highs)
  const pad = (hi - lo) * 0.18 || Math.abs(hi) * 0.1 || 1
  const min = lo - pad, max = hi + pad
  const W = 320, H = 92, L = 6, R = W - 6, T = 8, B = H - 18
  const x = (i: number): number => pts.length === 1 ? (L + R) / 2 : L + (i * (R - L)) / (pts.length - 1)
  const y = (v: number): number => T + (1 - (v - min) / (max - min)) * (B - T)
  const band = lows.length && highs.length
    ? `<rect x="${L}" y="${y(Math.max(...highs))}" width="${R - L}" height="${Math.max(y(Math.min(...lows)) - y(Math.max(...highs)), 2)}" fill="currentColor" opacity=".08" stroke="none"/>` : ''
  const line = pts.length > 1 ? `<polyline points="${pts.map((_, i) => `${x(i)},${y(ys[i]!)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>` : ''
  const dots = pts.map((l, i) => `<circle cx="${x(i)}" cy="${y(ys[i]!)}" r="3.4" fill="${l.flag === 'H' ? 'var(--hi)' : l.flag === 'L' ? 'var(--lo)' : 'var(--ok)'}"/>`).join('')
  const label = (s: string, a: string): string => `<text x="${a}" y="${H - 4}" font-size="10" fill="var(--sub)" text-anchor="${a === 'start' ? 'start' : 'end'}">${esc(s.slice(5))}</text>`
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="趋势图">${band}${line}${dots}${label(pts[0]!.collected_on!, 'start')}${label(pts[pts.length - 1]!.collected_on!, 'end')}</svg>`
}

// —— 路由 ——

function render(): void {
  if (!token()) { renderLanding(); return }
  const h = location.hash
  let m = /^#\/m\/([\w-]+)$/.exec(h)
  if (m) { void memberView(m[1]!); return }
  m = /^#\/b\/([\w-]+)$/.exec(h)
  if (m) { void briefView(m[1]!); return }
  m = /^#\/chat\/([\w-]+)$/.exec(h)
  if (m) { void chatView(m[1]!); return }
  void homeView()
}
window.addEventListener('hashchange', render)

// —— 登录 / 注册（知家自带；人机校验与主应用共用同一套 PoW） ——

/** 知家落地页（未登录首屏）：介绍 + 三步用法 + 注册 / 登录入口；登录后直接进家庭空间。 */
function renderLanding(): void {
  app.innerHTML = `<div class="land">
    <header class="land-top">${MARK('mark-sm')}<span class="land-brand">知家</span><span class="land-sub">Heurion 家庭健康顾问</span></header>
    <div class="land-hero">
      <h1>家人的化验单、检查报告，<br>一份档案管明白。</h1>
      <p>拍照上传化验单，AI 帮你把每项指标讲清楚（讲法带文献出处）；异常值提醒就医，就诊前自动生成简报和要问医生的问题。给爸妈、孩子和自己，每人一份。</p>
      <div class="land-cta"><button class="btn" id="landGo">为家人建档 · 注册 / 登录 <span aria-hidden="true">→</span></button></div>
      <p class="land-note">提供建议与整理，不构成诊疗 · 数据加密存储，只有你和授权的人能看到</p>
    </div>
    <div class="land-steps">
      <div><span>1</span><b>建档</b><p>给每位家人一份档案（称呼不用实名）</p></div>
      <div><span>2</span><b>上传 / 录入</b><p>拍照传报告，或手动记一笔化验</p></div>
      <div><span>3</span><b>看懂再就诊</b><p>趋势与解读带出处，简报带给医生</p></div>
    </div>
    <p class="land-foot">Heurion 出品 · 知家在，合家安</p>
  </div>`
  $('#landGo').addEventListener('click', () => renderAuth())
}

/** 退出登录：服务端让所有设备的令牌失效（与主应用「退出所有设备」同一口径），回到落地页。 */
async function signOutPhr(): Promise<void> {
  if (!(await confirmDlg('退出登录？所有设备上的知家 / 主应用都会下线', '退出'))) return
  try { await api('/api/auth/logout-everywhere', { method: 'POST', body: '{}' }) } catch { /* 令牌已失效也算退出 */ }
  try { localStorage.removeItem('heurion.token') } catch { /* 无痕模式 */ }
  toast('已退出')
  renderLanding()
}

type AuthMode = 'login' | 'register' | 'reset'
let authMode: AuthMode = 'login'
let pow: Promise<{ solution: PowSolution; fetchedAt: number }> | null = null
const armPow = (): void => { pow = solvePow(); pow.catch(() => { /* 失败在提交时呈现 */ }) }
/** 找回密码：验证码已发出 + 60 秒重发冷却。 */
let resetSent = false
let resetReadyAt = 0

function renderAuth(err = ''): void {
  if (new URLSearchParams(location.search).get('invite')) authMode = 'register'
  const mode = authMode
  const title = mode === 'login' ? '登录' : mode === 'register' ? '注册' : '找回密码'
  const body = mode === 'reset'
    ? `<div class="form">
        <label>绑定过的邮箱<input id="rEmail" type="email" autocomplete="email"></label>
        <div style="display:flex;gap:8px"><input id="rCode" placeholder="6 位验证码" inputmode="numeric" maxlength="6" style="flex:1" ${resetSent ? '' : 'disabled'}><button class="btn sec" id="rSend" style="flex:none">${resetSent ? '重发' : '发送验证码'}</button></div>
        <label>新密码<input id="rNew" type="password" autocomplete="new-password" ${resetSent ? '' : 'disabled'}></label>
        <div id="aErr" style="color:var(--hi);font-size:13px;min-height:1.2em">${esc(err)}</div>
        <button class="btn block" id="aGo" ${resetSent ? '' : 'disabled'}>重置并登录</button>
        <div style="text-align:center;font-size:13px" id="aSwitch"><a href="#" data-m="login">想起来了？返回登录</a></div>
        <div style="text-align:center;font-size:12px;color:var(--sub)">验证码发到账户绑定的邮箱；没绑定邮箱的账户请联系管理员</div>
      </div>`
    : `<div class="form">
        <label>用户名<input id="aUser" autocomplete="username"></label>
        <label>密码<input id="aPass" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}"></label>
        ${mode === 'register' ? '<label>昵称（可留空）<input id="aName" maxlength="24" autocomplete="nickname"></label>' : ''}
        <div id="aErr" style="color:var(--hi);font-size:13px;min-height:1.2em">${esc(err)}</div>
        <button class="btn block" id="aGo">${mode === 'login' ? '登录' : '注册'}</button>
        <div style="text-align:center;font-size:13px" id="aSwitch">${mode === 'login'
          ? '<a href="#" data-m="reset">忘记密码？</a> · 没有账户？<a href="#" data-m="register">注册</a>'
          : '已有账户？<a href="#" data-m="login">登录</a>'}</div>
        <div id="aDev" hidden style="text-align:center;font-size:12px"><a href="#" id="aDevGo">开发模式直接进入</a></div>
      </div>`
  app.innerHTML = `<div class="gate">${MARK('mark')}<div class="logo">知家</div>
    <div class="tag">知家在，合家安</div><div class="brand">Heurion 出品 · 家庭健康顾问</div>
    <div class="card" style="text-align:left"><div class="form"><div style="font-weight:700;font-size:15px">${title}</div></div>${body}</div></div>`
  $('#aSwitch').querySelectorAll('a').forEach(a => a.addEventListener('click', e => {
    e.preventDefault(); authMode = a.getAttribute('data-m') as AuthMode; if (authMode === 'reset') resetSent = false; renderAuth()
  }))
  if (mode === 'reset') {
    $('#rSend').addEventListener('click', () => void sendResetCode())
    $('#aGo').addEventListener('click', () => void submitReset())
    ;[$('#rEmail'), $('#rCode'), $('#rNew')].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault() }))
    armPow()
  } else {
    ;[$('#aUser'), $('#aPass')].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') void submitAuth() }))
    $('#aGo').addEventListener('click', () => void submitAuth())
    armPow()
  }
  void (async () => {
    const cfg = await fetch('/api/auth/config').then(r => r.json()).catch(() => null) as { has_users?: boolean; dev_mode?: boolean } | null
    if (!cfg || mode !== authMode) return
    if (cfg.has_users === false && authMode === 'login') { authMode = 'register'; renderAuth(); return }
    if (cfg.dev_mode) {
      $('#aDev').hidden = false
      $('#aDevGo').addEventListener('click', e => {
        e.preventDefault()
        try { localStorage.setItem('heurion.token', 'dev') } catch { /* 无痕模式 */ }
        render()
      })
    }
  })()
}

async function sendResetCode(): Promise<void> {
  const email = ($('#rEmail') as HTMLInputElement).value.trim()
  if (!email) { $('#aErr').textContent = '先填邮箱'; return }
  if (Date.now() < resetReadyAt) { $('#aErr').textContent = `验证码 60 秒内只能重发（还剩 ${Math.ceil((resetReadyAt - Date.now()) / 1000)} 秒）`; return }
  const btn = $<HTMLButtonElement>('#rSend')
  btn.disabled = true; btn.textContent = '人机校验中…'
  try {
    const { solution, fetchedAt } = await pow!
    await powDelay(fetchedAt)
    const res = await fetch('/api/auth/password-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, pow: solution, website: '' }) })
    const data = await res.json().catch(() => ({})) as { error?: string }
    if (!res.ok) throw new Error(data.error ?? '发送失败')
    resetSent = true
    resetReadyAt = Date.now() + 60_000
    toast('验证码已发出（10 分钟内有效），没收到看看垃圾邮件')
    renderAuth()
  } catch (err) {
    $('#aErr').textContent = (err as Error).message
    btn.disabled = false; btn.textContent = resetSent ? '重发' : '发送验证码'
    armPow()
  }
}

/** 登录 / 注册提交：人机校验在后台提前算（用户填表期间完成），失败后重新领题。 */
async function submitAuth(): Promise<void> {
  const btn = $<HTMLButtonElement>('#aGo')
  const user = ($('#aUser') as HTMLInputElement).value.trim()
  const pass = ($('#aPass') as HTMLInputElement).value
  if (!user || !pass) { $('#aErr').textContent = '用户名和密码都要填'; return }
  btn.disabled = true
  const label = btn.textContent
  btn.textContent = '人机校验中…'
  try {
    const { solution, fetchedAt } = await pow!
    await powDelay(fetchedAt)
    btn.textContent = authMode === 'login' ? '登录中…' : '注册中…'
    const body: Record<string, unknown> = { username: user, password: pass, pow: solution }
    if (authMode === 'register') {
      body.display_name = ($('#aName') as HTMLInputElement | undefined)?.value.trim() ?? ''
      const inv = new URLSearchParams(location.search).get('invite')
      if (inv) body.invite = inv
    }
    const res = await fetch(authMode === 'login' ? '/api/auth/login' : '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({})) as { token?: string; error?: string }
    if (!res.ok || !data.token) throw new Error(data.error ?? '没有成功，请重试')
    try { localStorage.setItem('heurion.token', data.token) } catch { /* 无痕模式 */ }
    toast(authMode === 'login' ? '欢迎回来' : '欢迎来到知家')
    render()
  } catch (err) {
    $('#aErr').textContent = (err as Error).message
    btn.disabled = false
    btn.textContent = label
    armPow()
  }
}

async function submitReset(): Promise<void> {  const email = ($('#rEmail') as HTMLInputElement).value.trim()
  const code = ($('#rCode') as HTMLInputElement).value.trim()
  const pass = ($('#rNew') as HTMLInputElement).value
  if (!email || !code || !pass) { $('#aErr').textContent = '邮箱、验证码、新密码都要填'; return }
  const btn = $<HTMLButtonElement>('#aGo')
  btn.disabled = true; btn.textContent = '重置中…'
  try {
    const res = await fetch('/api/auth/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code, new_password: pass }) })
    const data = await res.json().catch(() => ({})) as { token?: string; error?: string }
    if (!res.ok || !data.token) throw new Error(data.error ?? '重置没有成功，请重试')
    try { localStorage.setItem('heurion.token', data.token) } catch { /* 无痕模式 */ }
    toast('密码已重置，直接进入')
    render()
  } catch (err) {
    $('#aErr').textContent = (err as Error).message
    btn.disabled = false; btn.textContent = '重置并登录'
  }
}

// —— 首页：家庭空间 ——

async function homeView(): Promise<void> {
  app.innerHTML = `<div class="topbar"><div class="topbar-in">
      <div style="flex:1;display:flex;align-items:center;gap:9px">${MARK('mark-sm')}<div><h1 style="flex:none">知家</h1><div class="sub">知家在，合家安</div></div></div>
      <button class="btn" id="addMember" style="min-height:40px;padding:0 16px">＋ 家人</button>
      <button class="edit" id="logout" title="退出登录">退出</button>
    </div></div><div class="max"><div id="main" class="loading">加载中…</div></div>`
  $('#addMember').addEventListener('click', () => void memberDialog(null, () => void homeView()))
  $('#logout').addEventListener('click', () => void signOutPhr())
  const list = await api<Array<Patient>>('/api/patients').catch(err => { if ((err as ApiErr).status !== 401) toast((err as Error).message, true); return null })
  if (!list) return
  const cards = list.map(p => `<button class="member" data-id="${esc(p.id)}">
      <div class="nm">${esc(display(p))}<span class="sex">${p.sex ? SEX[p.sex] : ''}</span>${p.pending ? `<span class="pend" style="margin-left:auto">${p.pending} 待确认</span>` : ''}</div>
      <div class="meta">${p.birth_year ? `${p.birth_year} 年生 · ${ageText(p.birth_year)}` : ''}${p.birth_year && p.sex ? ' · ' : ''}${p.sex ? SEX[p.sex] : ''}</div>
      ${p.tags.length ? `<div style="margin-top:6px">${p.tags.map(t => `<span class="chip${(FAMILY_TAGS as readonly string[]).includes(t) ? ' on' : ''}">${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="meta">化验 ${p.lab_reports ?? 0} 次${p.last_lab ? ` · 最近 ${esc(p.last_lab)}` : ''}</div>
    </button>`).join('')
  $('#main').innerHTML = list.length
    ? `<div class="member-grid">${cards}</div>`
    : `<div class="empty"><div class="big">${icon('home', { size: 36 })}</div>还没有家人的档案<br><span style="font-size:12px">把报告、化验单管起来，先给每位家人建一份档案</span></div>`
  document.querySelectorAll('.member').forEach(b => b.addEventListener('click', () => { location.hash = `#/m/${b.getAttribute('data-id')}` }))
}

// —— 建档 / 编辑成员 ——

function memberDialog(p: Patient | null, done: () => void): void {
  const tags = p?.tags ?? []
  const d = dlg(`<h3>${p ? '编辑家人' : '添加家人'}</h3><div class="form">
      <label>称呼（如：妈妈、宝宝）<input id="fName" maxlength="24" value="${esc(p?.name ?? '')}" placeholder="称呼"></label>
      <label>性别<select id="fSex"><option value="">保密</option><option value="F" ${p?.sex === 'F' ? 'selected' : ''}>女</option><option value="M" ${p?.sex === 'M' ? 'selected' : ''}>男</option></select></label>
      <label>出生年份<input id="fYear" type="number" inputmode="numeric" value="${p?.birth_year ?? ''}" placeholder="如 1990 / 2023（可留空）"></label>
      <label>标记<span id="fTags">${FAMILY_TAGS.map(t => `<button type="button" class="chip pick${tags.includes(t) ? ' on' : ''}" data-t="${t}">${t}</button>`).join('')}</span></label>
      <div class="dlg-act"><button class="btn ghost" data-x="0">取消</button><button class="btn" data-x="1">${p ? '保存' : '建档'}</button></div>
    </div>`)
  let chosen = new Set(tags)
  d.querySelectorAll('.pick').forEach(b => b.addEventListener('click', () => {
    const t = b.getAttribute('data-t')!
    chosen.has(t) ? chosen.delete(t) : chosen.add(t)
    b.classList.toggle('on')
  }))
  d.querySelector('[data-x="0"]')!.addEventListener('click', () => d.close())
  d.querySelector('[data-x="1"]')!.addEventListener('click', async () => {
    const body = {
      name: ($('#fName', d) as HTMLInputElement).value,
      sex: ($('#fSex', d) as HTMLSelectElement).value || null,
      birth_year: ($('#fYear', d) as HTMLInputElement).value,
      tags: [...chosen],
    }
    try {
      if (p) await api(`/api/patients/${p.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      else await api('/api/patients', { method: 'POST', body: JSON.stringify(body) })
      d.close(); toast(p ? '已保存' : '已建档'); done()
    } catch (err) { toast((err as Error).message, true) }
  })
}

// —— 成员页 ——

async function memberView(id: string, tab: 'labs' | 'records' | 'pending' = 'labs'): Promise<void> {
  app.innerHTML = `<div class="topbar"><div class="topbar-in">
      <button class="back" id="back">‹</button><div style="flex:1;min-width:0"><h1 id="mName">…</h1><div class="sub" id="mMeta"></div></div>
      <button class="edit" id="mChat" title="问知家">${icon('chat')} 问知家</button>
      <div class="more-wrap"><button class="edit" id="mMore" aria-haspopup="menu" aria-label="更多">⋯</button>
        <div class="more-menu" id="mMenu" role="menu" hidden>
          <button id="mBrief" role="menuitem">${icon('report')} 生成就诊简报</button><button id="mShare" role="menuitem">${icon('hospital')} 分享给医生</button><button id="mClaim" role="menuitem">${icon('link')} 绑定就诊认领码</button><button id="mEdit" role="menuitem">${icon('edit')} 编辑资料</button>
        </div></div></div></div>
    <div class="max"><div class="tabs" id="tabs">
      <button class="tab on" data-tab="labs">化验</button><button class="tab" data-tab="records">记录</button><button class="tab" data-tab="pending">待确认</button><button class="tab" data-tab="share">分享</button>
    </div><div id="main" class="loading">加载中…</div></div>`
  $('#back').addEventListener('click', () => { location.hash = '' })
  let detail: Detail
  try {
    detail = await api<Detail>(`/api/patients/${id}`)
  } catch (err) { if ((err as ApiErr).status !== 401) toast((err as Error).message, true); $('#mName').textContent = '加载失败'; return }
  const name = display(detail)
  $('#mName').textContent = name
  $('#mMeta').textContent = [detail.sex ? SEX[detail.sex] : '', detail.birth_year ? ageText(detail.birth_year) : '', detail.tags.join(' · ')].filter(Boolean).join(' · ')
  $('#mEdit').addEventListener('click', () => memberDialog(detail, () => void memberView(id)))
  // 顶部只留「问知家」和「⋯」：简报、分享、编辑收进菜单（手机上四个按钮太挤）
  const menu = $('#mMenu')
  $('#mMore').addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden })
  document.addEventListener('click', () => { menu.hidden = true }, { once: false })
  menu.addEventListener('click', () => { menu.hidden = true })
  $('#mBrief').addEventListener('click', () => void makeBrief(id))
  $('#mChat').addEventListener('click', () => void openChat(id))
  $('#mShare').addEventListener('click', () => void shareDialog(id, name, () => show('share')))
  $('#mClaim').addEventListener('click', () => void claimDialog(id, name, () => show('share')))

  const state = { tab: 'labs' as 'labs' | 'records' | 'pending' | 'share' }
  const show = (tab: 'labs' | 'records' | 'pending' | 'share'): void => {
    state.tab = tab
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.getAttribute('data-tab') === tab))
    const main = $('#main')
    if (tab === 'labs') void labsTab(main, id, detail)
    else if (tab === 'records') void recordsTab(main, id, detail)
    else if (tab === 'share') void shareTab(main, id, name, () => show('share'))
    else void pendingTab(main, id, detail)
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => show(t.getAttribute('data-tab') as never)))
  show(tab)
}

/** 化验页签：最近值 + 每项展开全史与趋势。 */
// —— 分享给医生（docs/design/SHARING.md）：选医院 → 科室 → 可选医生；范围、有效期、是否允许纳入医院病历 ——

interface Hospital { id: string; name: string; departments: Array<{ id: string; name: string; doctors: Array<{ id: string; display_name: string }> }> }
interface ShareRow {
  id: string; hospital: string; department: string; doctor: string | null; scope: { categories: string[]; since: string | null }
  allow_import: boolean; display_name: string | null; status: 'active' | 'revoked' | 'expired' | 'department_gone'; expires_at: string; created_at: string
  imported: { at: string; by: string | null } | null
}
const SCOPE: Record<string, string> = { labs: '化验', reports: '报告原件', docs: '简报与健康档案' }
const SHARE_STATUS: Record<string, string> = { active: '有效', revoked: '已撤销', expired: '已过期', department_gone: '科室已撤销' }
const LOG_ACTION: Record<string, string> = { share_create: '分享', share_revoke: '撤销分享', share_view: '查看了概况', share_labs: '查看了化验', share_file: '下载了报告原件', share_doc: '查看了简报 / 档案', share_record: '读了报告', share_import: '纳入了医院病历' }

async function shareDialog(id: string, name: string, done: () => void): Promise<void> {
  let dir: Hospital[] = []
  try { dir = await api<Hospital[]>('/api/phr/directory') } catch (err) { toast((err as Error).message, true); return }
  if (dir.length === 0) { toast('现在还没有接受家庭分享的医院', true); return }
  const opt = (v: string, t: string) => `<option value="${esc(v)}">${esc(t)}</option>`
  const d = dlg(`<h3>把「${esc(name)}」的档案分享给医生</h3><div class="form">
      <label>医院<select id="sHos">${dir.map(h => opt(h.id, h.name)).join('')}</select></label>
      <label>科室<select id="sDept"></select></label>
      <label>医生（可选）<select id="sDoc"></select></label>
      <label>分享哪些<span>${Object.entries(SCOPE).map(([k, v]) => `<button type="button" class="chip pick on" data-c="${k}">${v}</button>`).join('')}</span></label>
      <label>从哪天起的记录（可留空 = 全部）<input id="sSince" type="date"></label>
      <label>有效期<select id="sDays"><option value="7">7 天</option><option value="30" selected>30 天</option><option value="90">90 天</option></select></label>
      <label>给医生看的姓名（可选，只有被授权的医生看得到）<input id="sName" maxlength="24" placeholder="如：王桂兰"></label>
      <label class="check"><input type="checkbox" id="sImport"> 允许医生把档案纳入医院病历（纳入后归医院保存，撤销分享也不会删除）</label>
      <div class="hint">医生只读，看不到你的其他家人；你随时可以撤销。医生每次查看你都能在「分享」里看到。</div>
      <div class="dlg-act"><button class="btn ghost" data-x="0">取消</button><button class="btn" data-x="1">确认分享</button></div>
    </div>`)
  const hos = d.querySelector<HTMLSelectElement>('#sHos')!, dept = d.querySelector<HTMLSelectElement>('#sDept')!, doc = d.querySelector<HTMLSelectElement>('#sDoc')!
  const fillDept = () => { const h = dir.find(x => x.id === hos.value)!; dept.innerHTML = h.departments.map(x => opt(x.id, x.name)).join(''); fillDoc() }
  const fillDoc = () => { const dp = dir.find(x => x.id === hos.value)!.departments.find(x => x.id === dept.value); doc.innerHTML = opt('', '科室里的医生都能看') + (dp?.doctors ?? []).map(x => opt(x.id, x.display_name)).join('') }
  hos.addEventListener('change', fillDept); dept.addEventListener('change', fillDoc); fillDept()
  d.querySelectorAll<HTMLButtonElement>('[data-c]').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')))
  d.querySelector('[data-x="0"]')!.addEventListener('click', () => d.close())
  d.querySelector('[data-x="1"]')!.addEventListener('click', async () => {
    const categories = [...d.querySelectorAll<HTMLElement>('[data-c].on')].map(b => b.dataset.c!)
    if (!categories.length) { toast('至少选一类要分享的内容', true); return }
    try {
      await api(`/api/phr/${id}/shares`, { method: 'POST', body: JSON.stringify({
        tenant_id: hos.value, department_id: dept.value, doctor_id: doc.value || null, scope: { categories, since: (d.querySelector<HTMLInputElement>('#sSince')!.value || null) },
        days: Number(d.querySelector<HTMLSelectElement>('#sDays')!.value), allow_import: d.querySelector<HTMLInputElement>('#sImport')!.checked, display_name: d.querySelector<HTMLInputElement>('#sName')!.value,
      }) })
      d.close()
      toast('已分享，医生现在就能看到')
      done()
    } catch (err) { toast((err as Error).message, true) }
  })
}

async function claimDialog(id: string, name: string, done: () => void): Promise<void> {
  const d = dlg(`<h3>绑定医院病历</h3><div class="form">
    <div style="font-size:13px;color:var(--text-2);line-height:1.6">输入接诊医生在工作台提供的 8 位认领码（如 <code>9ABC-2DEF</code>），向医院提交「${esc(name)}」的病历档案关联申请。</div>
    <label>8 位就诊认领码<input id="cCode" maxlength="12" placeholder="例如：9ABC-2DEF" style="text-transform:uppercase;font-family:var(--mono);font-size:16px;letter-spacing:2px;font-weight:600"></label>
    <div class="dlg-act"><button class="btn ghost" data-x="0">取消</button><button class="btn" data-x="1">提交申请</button></div>
  </div>`)
  d.querySelector('[data-x="0"]')!.addEventListener('click', () => d.close())
  d.querySelector('[data-x="1"]')!.addEventListener('click', async () => {
    const code = ($('#cCode', d) as HTMLInputElement).value.trim()
    if (!code) { toast('请先输入认领码', true); return }
    try {
      const res = await api<{ hospital_name: string }>(`/api/phr/${id}/claim`, { method: 'POST', body: JSON.stringify({ code }) })
      d.close()
      toast(`已向「${res.hospital_name}」提交绑定申请，请等待医生确认！`)
      done()
    } catch (err) { toast((err as Error).message, true) }
  })
}

async function shareTab(main: HTMLElement, id: string, name: string, refresh: () => void): Promise<void> {
  main.className = 'loading'
  let rows: ShareRow[] = [], log: Array<{ at: string; user: string; action: string; via: string; detail: string | null }> = []
  let links: Array<{ id: string; hospital_name: string; status: string; verified_at: string }> = []
  try {
    const [r1, r2, r3] = await Promise.all([
      api<ShareRow[]>(`/api/phr/${id}/shares`),
      api<typeof log>(`/api/patients/${id}/access-log`),
      api<typeof links>(`/api/phr/${id}/links`).catch(() => []),
    ])
    rows = r1; log = r2; links = r3
  } catch (err) { main.className = ''; main.innerHTML = `<div class="empty">${esc((err as Error).message)}</div>`; return }
  main.className = ''
  const visits = log.filter(l => l.action.startsWith('share_') && l.action !== 'share_create' && l.action !== 'share_revoke')
  main.innerHTML = `<div style="display:flex;justify-content:flex-end;gap:8px">
      <button class="btn sec" id="btnClaim" style="min-height:38px;padding:0 14px">${icon('link')} 绑定认领码</button>
      <button class="btn" id="newShare" style="min-height:38px;padding:0 14px">＋ 分享给医生</button>
    </div>
    ${links.length ? `<div class="card"><div class="sub" style="color:var(--sub);font-size:13px;margin-bottom:6px">已绑定的医院病历</div>
      ${links.map(l => `<div class="rec"><div class="info">
        <div class="t">${icon('hospital')} ${esc(l.hospital_name)}</div>
        <div class="m">已完成正式病历绑定 · ${esc(l.verified_at ? l.verified_at.slice(0, 10) : '生效中')}</div>
      </div><span class="chip on">已互通</span></div>`).join('')}</div>` : ''}
    <div class="card"><div class="sub" style="color:var(--sub);font-size:13px;margin-bottom:6px">分享</div>
      ${rows.length ? rows.map(r => `<div class="rec"><div class="info"><div class="t">${esc(r.hospital)} · ${esc(r.department)}${r.doctor ? ` · ${esc(r.doctor)}` : ''}</div>
        <div class="m">${esc(r.scope.categories.map(c => SCOPE[c] ?? c).join('、'))}${r.scope.since ? `（${esc(r.scope.since)} 起）` : ''} · ${r.status === 'active' ? `${esc(r.expires_at.slice(0, 10))} 到期` : esc(SHARE_STATUS[r.status])}${r.allow_import ? ' · 允许纳入病历' : ''}</div>
        ${r.imported ? `<div class="m" style="color:var(--pri-deep)">已被${esc(r.hospital)} ${esc(r.department)}${r.imported.by ? `（${esc(r.imported.by)}）` : ''}纳入病历 · ${esc(r.imported.at.slice(0, 10))}</div>` : ''}</div>
        ${r.status === 'active' ? `<button class="btn ghost" data-revoke="${esc(r.id)}" style="min-height:34px;padding:0 12px">撤销</button>` : `<span class="chip">${esc(SHARE_STATUS[r.status])}</span>`}</div>`).join('')
        : `<div class="empty">还没有分享过<br><span style="font-size:12px">看病前把${esc(name)}的化验、报告和简报分享给医生，医生打开就能看到</span></div>`}</div>
    <div class="card"><div class="sub" style="color:var(--sub);font-size:13px;margin-bottom:6px">医生的查看记录</div>
      ${visits.length ? visits.slice(0, 50).map(l => `<div class="rec"><div class="info"><div class="t">${esc(l.user)}${l.via === 'ai' ? '（医生的 AI 助手）' : ''} ${esc(LOG_ACTION[l.action] ?? l.action)}</div><div class="m">${esc(l.detail ?? '')} · ${esc(l.at.slice(0, 16).replace('T', ' '))}</div></div></div>`).join('')
        : '<div class="empty">还没有医生查看过</div>'}</div>`
  main.querySelector('#newShare')!.addEventListener('click', () => void shareDialog(id, name, refresh))
  main.querySelector('#btnClaim')!.addEventListener('click', () => void claimDialog(id, name, refresh))
  main.querySelectorAll<HTMLElement>('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
    if (!(await confirmDlg('撤销这个分享？医生立刻就看不到了（已纳入医院病历的部分归医院保存）', '撤销'))) return
    try { await api(`/api/phr/shares/${b.dataset.revoke}`, { method: 'DELETE' }); toast('已撤销'); refresh() } catch (err) { toast((err as Error).message, true) }
  }))
}

async function labsTab(main: HTMLElement, id: string, detail: Detail): Promise<void> {
  main.innerHTML = `<div style="display:flex;justify-content:flex-end"><button class="btn sec" id="addLab" style="min-height:36px;padding:0 12px">＋ 手动录入</button></div>
    <div class="card" id="latest">${detail.latest_labs.length ? '' : '<div class="empty">还没有化验值<br><span style="font-size:12px">上传化验单，或右上角手动录入</span></div>'}</div>`
  $('#addLab').addEventListener('click', () => void labDialog(id, () => void memberView(id)))
  const box = $('#latest')
  detail.latest_labs.forEach(l => {
    const b = document.createElement('div')
    b.innerHTML = `<button class="labrow" data-key="${esc(l.test_key)}">
      <span class="nm"><span class="t">${esc(l.test_name)}</span><span class="r">${esc(l.ref_text ?? '')}</span></span>
      <span class="v">${esc(valText(l))}</span>
      ${l.flag ? `<span class="flag ${l.flag}">${l.flag === 'H' ? '↑' : '↓'}</span>` : ''}
      <span class="d">${esc(dayShort(l.collected_on))}</span></button><div class="hist" hidden></div>`
    box.append(b)
    b.querySelector('.labrow')!.addEventListener('click', () => void toggleHistory(b, id, l))
  })
}

/** 展开 / 收起一项的全史（懒加载，同 key 缓存在元素上）。 */
async function toggleHistory(block: HTMLElement, id: string, l: Lab): Promise<void> {
  const hist = block.querySelector('.hist') as HTMLElement
  if (!hist.hidden) { hist.hidden = true; return }
  if (!hist.dataset.loaded) {
    hist.innerHTML = '<div class="loading">…</div>'
    try {
      const rows = await api<Lab[]>(`/api/patients/${id}/labs?tests=${encodeURIComponent(l.test_key)}`)
      hist.innerHTML = `${spark(rows)}` + rows.slice().reverse().map(r => `<div class="row">
        <span class="d">${esc(r.collected_on ?? '')}</span><span style="flex:1">${esc(valText(r))}${r.source === 'manual' ? ' <span class="chip">手录</span>' : ''}</span>
        ${r.flag ? `<span class="flag ${r.flag}">${r.flag === 'H' ? '↑' : '↓'}</span>` : ''}</div>`).join('')
      hist.dataset.loaded = '1'
    } catch (err) { hist.innerHTML = `<div class="loading">${esc((err as Error).message)}</div>` }
  }
  hist.hidden = false
}

/** 手动录入一项化验（数值直接为已确认；AI 不能手动录入，服务端拒绝 via=ai）。 */
function labDialog(id: string, done: () => void): void {
  const d = dlg(`<h3>手动录入化验</h3><div class="form">
      <label>项目名（如：空腹血糖）<input id="lName" maxlength="60"></label>
      <label>数值（可含符号，如 &lt;40）<input id="lVal" inputmode="decimal"></label>
      <label>单位<input id="lUnit" maxlength="20" placeholder="如 mmol/L（可留空）"></label>
      <div style="display:flex;gap:8px"><label style="flex:1">参考下限<input id="lLow" inputmode="decimal"></label><label style="flex:1">参考上限<input id="lHigh" inputmode="decimal"></label></div>
      <label>采样日期<input id="lDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <div class="dlg-act"><button class="btn ghost" data-x="0">取消</button><button class="btn" data-x="1">保存</button></div>
    </div>`)
  d.querySelector('[data-x="0"]')!.addEventListener('click', () => d.close())
  d.querySelector('[data-x="1"]')!.addEventListener('click', async () => {
    try {
      await api(`/api/patients/${id}/labs`, { method: 'POST', body: JSON.stringify({
        test_name: ($('#lName', d) as HTMLInputElement).value,
        value: ($('#lVal', d) as HTMLInputElement).value,
        unit: ($('#lUnit', d) as HTMLInputElement).value,
        ref_low: ($('#lLow', d) as HTMLInputElement).value || null,
        ref_high: ($('#lHigh', d) as HTMLInputElement).value || null,
        collected_on: ($('#lDate', d) as HTMLInputElement).value,
      }) })
      d.close(); toast('已录入'); done()
    } catch (err) { toast((err as Error).message, true) }
  })
}

/** 记录页签：上传报告 + 记录列表（含关联文档）。 */
async function recordsTab(main: HTMLElement, id: string, detail: Detail): Promise<void> {
  main.innerHTML = `<input type="file" id="upFile" accept="image/*,application/pdf,.docx,.txt" hidden multiple>
    <button class="btn block" id="upBtn" style="margin-top:12px">${icon('camera')} 上传报告 / 化验单（拍照或相册）</button>
    <div class="card" id="recs">${detail.records.length ? '' : '<div class="empty">还没有记录</div>'}</div>
    ${detail.documents.length ? `<div class="card"><div class="sub" style="color:var(--sub);font-size:13px;margin-bottom:6px">关联文档</div>
      ${detail.documents.map(doc => `<button class="rec rec-open" data-doc="${esc(doc.doc_id)}" data-kind="${esc(doc.kind)}"><div class="info"><div class="t">${esc(DOC_KIND[doc.kind] ? `${display(detail)}的${DOC_KIND[doc.kind]}` : doc.title)}</div><div class="m">更新于 ${esc(doc.updated_at.slice(0, 10))}</div></div><span class="go">›</span></button>`).join('')}</div>` : ''}`
  // 关联文档可以打开：简报 / 档案等用同一个阅读页（健康档案也能进入对话）
  document.querySelectorAll<HTMLElement>('.rec-open').forEach(el => el.addEventListener('click', () => {
    docViewTitle = DOC_KIND[el.dataset.kind ?? ''] ?? '文档'
    location.hash = `#/b/${el.dataset.doc}`
  }))
  $('#upBtn').addEventListener('click', () => $('#upFile').click())
  $('#upFile').addEventListener('change', async () => {
    const files = Array.from(($('#upFile') as HTMLInputElement).files ?? [])
    if (!files.length) return
    for (const f of files) {
      const fd = new FormData(); fd.append('file', f)
      try { await api(`/api/patients/${id}/files`, { method: 'POST', body: fd }); toast(`已上传：${f.name}`) }
      catch (err) { toast((err as Error).message, true) }
    }
    ($('#upFile') as HTMLInputElement).value = ''
    // 提取在后台跑：过一会儿自动刷新，完了去「待确认」
    toast('已上传，正在自动识别，稍后到「待确认」逐项确认', false)
    setTimeout(() => void recordsTab(main, id, detail), 2600)
    setTimeout(() => void recordsTab(main, id, detail), 8000)
  })
  const box = $('#recs')
  detail.records.forEach(r => {
    const b = document.createElement('div')
    b.innerHTML = `<div class="rec"><div class="info">
        <div class="t">${esc(r.title)}</div>
        <div class="m">${KIND[r.kind] ?? r.kind}${r.report_date ? ` · ${esc(r.report_date)}` : ''} · ${STATUS[r.status] ?? r.status}${r.extraction && r.status === 'pending' ? ` · ${EXTRACT[r.extraction] ?? ''}` : ''}${r.extraction_note ? ` · ${esc(r.extraction_note)}` : ''}</div></div>
      ${r.file_id ? `<button class="go">原件</button>` : ''}</div>`
    box.append(b)
    const go = b.querySelector('.go')
    if (go) go.addEventListener('click', () => void downloadFile(id, r.file_id!, r.title))
  })
}

/** 原件是加密存放的，经授权接口取回再展示（<a> 带不了 Authorization 头）。 */
async function downloadFile(id: string, fileId: string, title: string): Promise<void> {
  try {
    const res = await fetch(`/api/patients/${id}/files/${fileId}`, { headers: { Authorization: `Bearer ${token()}`, 'X-Heurion-Space': 'personal' } })
    if (!res.ok) throw new Error(`取回失败（${res.status}）`)
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a'); a.href = url; a.download = title; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  } catch (err) { toast((err as Error).message, true) }
}

/**
 * 待确认页签：按报告分组——一份报告一张卡片，「全部确认」一次确认整份（不对的项先点 ✕ 去掉）；
 * 有多份报告时顶部「全部确认」一次确认所有报告（缺日期的先补、核对不上的先提醒）。AI 的提议单独列出。
 */
async function pendingTab(main: HTMLElement, id: string, detail: Detail): Promise<void> {
  const labs = await api<Lab[]>(`/api/patients/${id}/labs?pending=1`).catch(() => [])
  const pendingLabs = labs.filter(l => l.status === 'pending')
  const pendingRecords = detail.records.filter(r => r.status === 'pending')
  const byRecord = new Map<string, Lab[]>()
  for (const l of pendingLabs) if (l.record_id) byRecord.set(l.record_id, [...(byRecord.get(l.record_id) ?? []), l])
  const loose = pendingLabs.filter(l => !l.record_id || !pendingRecords.some(r => r.id === l.record_id))
  const n = pendingLabs.length + pendingRecords.length + detail.pending_proposals.length
  document.querySelector('.tab[data-tab="pending"]')!.textContent = `待确认${n ? ` ${n}` : ''}`
  const ready = pendingRecords.filter(r => !r.extraction || r.extraction === 'done')
  const readyItems = ready.reduce((k, r) => k + (byRecord.get(r.id)?.length ?? 0), 0)
  main.innerHTML = (ready.length > 1 ? `<div class="bulk"><button class="btn ok" id="allOk">✓ 全部确认（${ready.length} 份报告 · ${readyItems} 项）</button></div>` : '')
    + `<div id="pend">${n ? '' : '<div class="card"><div class="empty">没有待确认的内容<br><span style="font-size:12px">上传报告后，自动识别的结果会在这里等你确认</span></div></div>'}</div>`
  const box = $('#pend')
  const again = (): void => void memberView(id, 'pending')

  const labLine = (l: Lab, removable = true): string => `<div class="pitem"><span class="t">${esc(l.test_name)}</span>
      <span class="v">${esc(valText(l))}${l.flag ? ` <span class="flag ${l.flag}">${l.flag === 'H' ? '↑' : '↓'}</span>` : ''}</span>
      ${l.locator?.verified === false ? `<span class="warn" title="这个值没能回原文核对上，请对照原件">${icon('warning', { size: 12 })}</span>` : ''}
      ${l.same_day?.length ? `<span class="warn" title="同日同项已有：${esc(l.same_day.map(x => valText(x)).join('、'))}；确认后旧值标记「已替换」">↺</span>` : ''}
      ${removable ? `<button class="x" data-x="${esc(l.id)}" title="这一项不对，去掉">✕</button>` : ''}</div>`

  for (const r of pendingRecords) {
    const items = byRecord.get(r.id) ?? []
    const unverified = items.filter(l => l.locator?.verified === false).length
    const waiting = Boolean(r.extraction && r.extraction !== 'done')
    const b = document.createElement('div')
    b.className = 'card pcard'
    b.innerHTML = `<div class="hd"><span class="t">${esc(r.title)}</span><span class="chip">${KIND[r.kind] ?? r.kind}</span><span class="d">${esc(r.report_date ?? '缺日期')}</span></div>
      ${waiting ? `<div class="same">${EXTRACT[r.extraction!] ?? r.extraction}${r.extraction_note ? `：${esc(r.extraction_note)}` : ''}（先等识别完成，或直接驳回）</div>` : ''}
      ${unverified ? `<div class="same">${icon('warning', { size: 13 })} 有 ${unverified} 项没能回原文核对上，确认前请对照原件；不对的点 ✕ 去掉</div>` : ''}
      ${items.length ? `<div class="plist">${items.map(l => labLine(l)).join('')}</div>` : ''}
      <div class="act"><button class="btn ok" data-a="confirm" style="flex:2" ${waiting ? 'disabled' : ''}>✓ 全部确认${items.length ? `（${items.length} 项）` : ''}</button><button class="btn no" data-a="reject" style="flex:1">驳回整份</button></div>`
    box.append(b)
    b.querySelector('[data-a="confirm"]')!.addEventListener('click', async () => {
      if (await resolveRecord(id, r)) { toast(`已确认${items.length ? ` ${items.length} 项` : ''}`); again() }
    })
    b.querySelector('[data-a="reject"]')!.addEventListener('click', async () => {
      if (!(await confirmDlg(`驳回「${r.title}」？这份报告的待确认化验一并作废`, '驳回'))) return
      try { await api(`/api/patients/${id}/records/${r.id}/reject`, { method: 'POST', body: '{}' }); toast('已驳回'); again() } catch (err) { toast((err as Error).message, true) }
    })
    b.querySelectorAll<HTMLElement>('[data-x]').forEach(x => x.addEventListener('click', async () => {
      try {
        await api(`/api/patients/${id}/labs/${x.dataset.x}/reject`, { method: 'POST', body: '{}' })
        x.closest('.pitem')?.remove()
        toast('已去掉这一项')
      } catch (err) { toast((err as Error).message, true) }
    }))
  }

  // 不属于某份待确认报告的单项（少见）：逐项确认
  for (const l of loose) {
    const b = document.createElement('div')
    b.className = 'card pcard'
    b.innerHTML = `<div class="plist">${labLine(l, false)}</div>
      <div class="act"><button class="btn ok" data-a="confirm" style="flex:1">✓ 确认</button><button class="btn no" data-a="reject" style="flex:1">✕ 驳回</button></div>`
    box.append(b)
    b.querySelector('[data-a="confirm"]')!.addEventListener('click', () => void resolveLab(id, l.id, true))
    b.querySelector('[data-a="reject"]')!.addEventListener('click', () => void resolveLab(id, l.id, false))
  }

  detail.pending_proposals.forEach(pr => {
    const b = document.createElement('div')
    b.className = 'card pcard'
    b.innerHTML = `<div class="hd"><span class="t">${esc(proposalText(pr))}</span><span class="chip">AI 提议</span></div>
      <div class="same">${esc(pr.reason)}</div>
      <div class="act"><button class="btn ok" data-a="accept" style="flex:1">✓ 接受</button><button class="btn no" data-a="reject" style="flex:1">✕ 拒绝</button></div>`
    box.append(b)
    b.querySelector('[data-a="accept"]')!.addEventListener('click', () => void resolveProposal(id, pr.id, true))
    b.querySelector('[data-a="reject"]')!.addEventListener('click', () => void resolveProposal(id, pr.id, false))
  })

  // 顶部「全部确认」：缺日期的报告一次补齐，核对不上的先提醒，然后逐份确认
  document.getElementById('allOk')?.addEventListener('click', async () => {
    const undated = ready.filter(r => !r.report_date)
    const unverified = ready.reduce((k, r) => k + (byRecord.get(r.id) ?? []).filter(l => l.locator?.verified === false).length, 0)
    const dates = new Map<string, string>()
    if (undated.length || unverified) {
      const d = dlg(`<h3>确认 ${ready.length} 份报告</h3><div class="form">
          ${unverified ? `<div class="same">${icon('warning', { size: 13 })} 有 ${unverified} 项没能回原文核对上。不确定的先取消，点 ✕ 去掉。</div>` : ''}
          ${undated.map(r => `<label>「${esc(r.title)}」的日期<input type="date" data-rd="${esc(r.id)}"></label>`).join('')}
          <div class="dlg-act"><button class="btn ghost" data-x="0">取消</button><button class="btn" data-x="1">全部确认</button></div></div>`)
      const ok = await new Promise<boolean>(res => {
        d.querySelector('[data-x="0"]')!.addEventListener('click', () => { res(false); d.close() })
        d.querySelector('[data-x="1"]')!.addEventListener('click', () => {
          for (const inp of d.querySelectorAll<HTMLInputElement>('[data-rd]')) if (inp.value) dates.set(inp.dataset.rd!, inp.value)
          if (undated.some(r => !dates.has(r.id))) { toast('每份报告都要填日期', true); return }
          res(true); d.close()
        })
      })
      if (!ok) return
    }
    let done = 0
    for (const r of ready) {
      try {
        await api(`/api/patients/${id}/records/${r.id}/confirm`, { method: 'POST', body: JSON.stringify({ report_date: dates.get(r.id) ?? null }) })
        done++
      } catch (err) { toast(`「${r.title}」没确认上：${(err as Error).message}`, true) }
    }
    if (done) toast(`已确认 ${done} 份报告`)
    again()
  })
}

const proposalText = (pr: { kind: string; payload: Record<string, unknown> }): string => {  const p = pr.payload
  if (pr.kind === 'lab') return `补充化验：${String(p.test_name ?? '')} ${String(p.value ?? '')}${p.unit ? ` ${String(p.unit)}` : ''}`
  if (pr.kind === 'tag') return `加标记：${String(p.tag ?? '')}`
  if (pr.kind === 'note') return '补一段健康记录'
  if (pr.kind === 'update') return '修改基本信息'
  return `提议：${pr.kind}`
}

async function resolveLab(id: string, labId: string, ok: boolean): Promise<void> {
  try {
    await api(`/api/patients/${id}/labs/${labId}/${ok ? 'confirm' : 'reject'}`, { method: 'POST', body: '{}' })
    toast(ok ? '已确认' : '已驳回'); void memberView(id, 'pending')
  } catch (err) { toast((err as Error).message, true) }
}

async function resolveRecord(id: string, r: RecordRow): Promise<boolean> {
  try {
    let reportDate: string | null = null
    if (r.extraction === 'done' && !r.report_date) {
      const d = dlg(`<h3>「${esc(r.title)}」的日期</h3><div class="form"><label>报告 / 采样日期<input id="rd" type="date"></label>
        <div class="dlg-act"><button class="btn ghost" data-x="0">取消</button><button class="btn" data-x="1">确认</button></div></div>`)
      const ok = await new Promise<string | null>(res => {
        d.querySelector('[data-x="0"]')!.addEventListener('click', () => { res(null); d.close() })
        d.querySelector('[data-x="1"]')!.addEventListener('click', () => { res(($('#rd', d) as HTMLInputElement).value); d.close() })
      })
      if (!ok) return false
      reportDate = ok
    }
    await api(`/api/patients/${id}/records/${r.id}/confirm`, { method: 'POST', body: JSON.stringify({ report_date: reportDate }) })
    return true
  } catch (err) { toast((err as Error).message, true); return false }
}

async function resolveProposal(id: string, prid: string, accept: boolean): Promise<void> {
  try {
    await api(`/api/patients/${id}/proposals/${prid}/${accept ? 'accept' : 'reject'}`, { method: 'POST', body: '{}' })
    toast(accept ? '已接受' : '已拒绝'); void memberView(id, 'pending')
  } catch (err) { toast((err as Error).message, true) }
}

// —— 知家：健康档案 doc、就诊简报、问知家对话（同一 turns 队列；写入受红线守卫） ——

/** 成员健康档案 doc（没有就补建）；对话与就诊简报的落点。 */
async function archiveDocOf(id: string): Promise<string | null> {
  try {
    const r = await api<{ doc_id: string }>(`/api/phr/${id}/archive`, { method: 'POST', body: '{}' })
    return r.doc_id
  } catch (err) { toast((err as Error).message, true); return null }
}

async function makeBrief(id: string): Promise<void> {
  try {
    const r = await api<{ doc_id: string }>(`/api/phr/${id}/brief`, { method: 'POST', body: '{}' })
    toast('简报生成中，写完实时显示')
    location.hash = `#/b/${r.doc_id}`
  } catch (err) { toast((err as Error).message, true) }
}

let chatMeta = '成员'

async function openChat(id: string): Promise<void> {
  const docId = await archiveDocOf(id)
  if (docId) {
    chatMeta = $('#mName').textContent || '成员'
    location.hash = `#/chat/${docId}`
  }
}

const TOOL: Record<string, string> = {
  doc_outline: '看文档结构', doc_read: '读文档', doc_search: '搜文档', doc_edit: '修改文档', doc_history: '看历史', doc_create: '新建文档',
  comments_list: '看评论', comment_reply: '回复评论', pubmed_search: '检索文献', insert_citation: '登记引用',
  patient_read: '读健康记录', labs_query: '查化验', kb_search: '查资料', kb_read: '读资料',
  read_image: '看图片', asset_upload: '放图片进文档', memory_propose: '记一条偏好',
}

/** 就诊简报视图：渲染简报文档（GET /html），SSE 跟写作进度实时刷新。 */
/** 阅读页的标题（从记录里打开时按文档类型；生成简报后默认是「就诊简报」）。 */
let docViewTitle = '就诊简报'

async function briefView(docId: string): Promise<void> {
  app.innerHTML = `<div class="topbar"><div class="topbar-in">
      <button class="back" id="back">‹</button><div style="flex:1"><h1>${esc(docViewTitle)}</h1><div class="sub">${docViewTitle === '就诊简报' ? '看病前给医生看的准备' : ''}</div></div></div></div>
    <div class="max"><div id="writenote" class="writenote">知家正在写…</div><div id="doc" class="doc"><div class="loading">…</div></div></div>`
  $('#back').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '' })
  const note = $('#writenote')
  const setBusy = (b: boolean): void => { note.classList.toggle('on', b) }
  const paint = async (): Promise<void> => {
    try {
      const r = await api<{ rev: number; html: string }>(`/api/docs/${docId}/html`)
      const doc = $('#doc')
      doc.classList.remove('loading')
      const blank = !r.html || !r.html.replace(/<[^>]+>/g, '').trim()
      if (!blank) { doc.innerHTML = r.html; return }
      if (docViewTitle !== '健康档案') { doc.innerHTML = '<div class="empty">简报还没内容，稍等…</div>'; return }
      // 空的健康档案：说明它记什么，并可以让知家先整理一份（走同一个对话回合，写入受红线守卫）
      doc.innerHTML = `<div class="empty">健康档案还是空的<br><span style="font-size:13px">这里记病史、用药、医生交代和每次检查的要点。问知家时说过的内容会整理进来；也可以让知家先根据已有的化验和报告整理一份。</span>
        <div style="margin-top:14px"><button class="btn" id="fillArchive">让知家整理一份</button></div></div>`
      $('#fillArchive').addEventListener('click', async () => {
        try {
          await api(`/api/docs/${docId}/chat?async=1`, { method: 'POST', body: JSON.stringify({ message: '请根据已有的化验和报告，把健康档案整理一份：基本情况、最近的检查要点（只列和健康有关的几项，注明日期）、需要留意的地方。用家人看得懂的大白话，不下诊断、不给用药建议。' }) })
          setBusy(true); toast('知家正在整理，写好会自动显示')
        } catch (err) { toast((err as Error).message, true) }
      })
    } catch (err) { if ((err as ApiErr).status !== 401) $('#doc').textContent = (err as Error).message }
  }
  void paint()
  const es = new EventSource(`/api/docs/${docId}/stream?token=${encodeURIComponent(token())}`)
  es.onmessage = e => {
    try {
      const ev = JSON.parse(e.data) as { type: string; busy?: boolean; event?: { type: string; status?: string; message?: string } }
      if (ev.type === 'hello') setBusy(!!ev.busy)
      else if (ev.type === 'commit') void paint()
      else if (ev.type === 'turn_event' && ev.event) {
        if (ev.event.type === 'status') setBusy(ev.event.status === 'running')
        else if (ev.event.type === 'turn_done' || ev.event.type === 'done') setBusy(false)
        else if (ev.event.type === 'error') { setBusy(false); toast(ev.event.message ?? '出错了', true) }
      }
    } catch { /* 忽略坏帧 */ }
  }
  window.addEventListener('hashchange', () => es.close(), { once: true })
}

/** 问知家：绑定成员健康档案的对话（同一 turns 队列；对档案的写入受红线守卫）。 */
async function chatView(docId: string): Promise<void> {
  app.innerHTML = `<div class="topbar"><div class="topbar-in">
      <button class="back" id="back">‹</button><div style="flex:1;min-width:0"><h1 style="font-size:17px">问知家 · ${esc(chatMeta)}</h1><div class="sub">建议仅供准备就诊，不构成诊疗</div></div></div></div>
    <div class="max" style="padding-bottom:96px"><div id="msgs" class="chat"></div></div>
    <div class="composer"><div class="composer-in">
      <input id="say" placeholder="问问知家：这项检查要注意什么？" maxlength="500">
      <button class="btn" id="send" style="min-width:64px">发送</button>
    </div></div>`
  $('#back').addEventListener('click', () => { location.hash = '' })
  const msgs = $('#msgs')
  const scrollDown = (): void => { msgs.scrollTop = msgs.scrollHeight }
  const bubble = (role: 'user' | 'ai', text: string): void => {
    const b = document.createElement('div')
    b.className = `msg ${role === 'user' ? 'user' : 'ai'}`
    b.textContent = text
    msgs.append(b); scrollDown()
  }
  const step = (text: string, err = false): void => {
    const s = document.createElement('div')
    s.className = `step${err ? ' err' : ''}`
    s.textContent = text
    msgs.append(s); scrollDown()
  }
  try {
    const hist = await api<{ messages?: Array<{ role: string; text: string }> }>(`/api/docs/${docId}`)
    const ms = hist.messages ?? []
    for (const m of ms) if (m.role === 'user' || m.role === 'assistant') bubble(m.role === 'user' ? 'user' : 'ai', m.text)
    if (!ms.length) step('检查报告、化验单里不明白的地方，直接问。AI 的回答帮你准备就诊，不是诊断。')
  } catch (err) { if ((err as ApiErr).status !== 401) toast((err as Error).message, true) }

  let busy = false
  const send = $<HTMLButtonElement>('#send')
  const say = $<HTMLInputElement>('#say')
  const submit = async (): Promise<void> => {
    const text = say.value.trim()
    if (!text || busy) return
    busy = true; send.disabled = true
    try {
      await api(`/api/docs/${docId}/chat?async=1`, { method: 'POST', body: JSON.stringify({ message: text }) })
      say.value = ''
    } catch (err) { toast((err as Error).message, true); busy = false; send.disabled = false }
  }
  send.addEventListener('click', () => void submit())
  say.addEventListener('keydown', e => { if (e.key === 'Enter') void submit() })

  const es = new EventSource(`/api/docs/${docId}/stream?token=${encodeURIComponent(token())}`)
  es.onmessage = e => {
    try {
      const ev = JSON.parse(e.data) as { type: string; busy?: boolean; event?: { type: string; text?: string; status?: string; message?: string; name?: string; isError?: boolean } }
      if (ev.type === 'hello') { busy = !!ev.busy; send.disabled = busy; return }
      if (ev.type !== 'turn_event' || !ev.event) return
      const t = ev.event
      if (t.type === 'turn') bubble('user', t.message ?? '')
      else if (t.type === 'queued') step('排队中…')
      else if (t.type === 'assistant') bubble('ai', t.text ?? '')
      else if (t.type === 'tool_call') step(`${TOOL[t.name ?? ''] ?? t.name ?? '工具'}…`)
      else if (t.type === 'tool_result' && t.isError) step(`有一步没成：${t.message ?? ''}`, true)
      else if (t.type === 'turn_done' || t.type === 'done') { busy = false; send.disabled = false; scrollDown() }
      else if (t.type === 'error') { busy = false; send.disabled = false; toast(t.message ?? '出错了', true) }
    } catch { /* 忽略坏帧 */ }
  }
  window.addEventListener('hashchange', () => es.close(), { once: true })
}

// —— 启动 ——

render()
