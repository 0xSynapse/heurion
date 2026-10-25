import { mountOrgTemplates } from './org-templates.ts'
import { powDelay, solvePow } from './pow.ts'
import { icon } from './icons.ts'

/**
 * 账户界面（MIGRATION_PLAN.md §2.5 R1）：登录 / 注册页（含邀请链接）、左栏底部的用户菜单、个人设置、
 * 机构管理（机构管理员：成员、邀请、设置、本机构审计）、平台运营（机构、用户、实例设置、审计）。
 * 令牌存 localStorage（heurion.token）；任何接口返回 401 都回到登录页。
 */

const KEY = 'heurion.token'
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export interface Me {
  id: string
  username: string
  display_name: string
  email: string | null
  work_email_prefix?: string | null
  work_email?: string | null
  role: 'user' | 'admin'
  dev?: boolean
  dev_mode: boolean
  tenant: { id: string; name: string; kind: 'personal' | 'org'; role: 'admin' | 'member'; settings: TenantSettings; members: number; personal_id?: string | null; in_org?: boolean } | null
}

interface TenantSettings { patient_module: boolean; external_model_for_patients: boolean; patient_visibility: 'care_team' | 'tenant'; ai_patient_writes: 'review' | 'direct'; accept_patient_shares?: boolean }

/** 邀请链接里的邀请码（/app?invite=…）。 */
export const inviteCode = (): string | null => new URLSearchParams(location.search).get('invite')
const inviteLink = (code: string) => `${location.origin}/app?invite=${code}`

export const storedToken = (): string => {
  try { return localStorage.getItem(KEY) ?? '' } catch { return '' }
}

function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(KEY, token)
    else localStorage.removeItem(KEY)
  } catch { /* 无痕模式等：只在本页有效 */ }
}

/** 未登录 / 令牌失效：清掉令牌，显示登录页。 */
export function signOut(): void {
  saveToken(null)
  location.reload()
}

async function post(path: string, body: unknown, token?: string): Promise<any> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

// —— 防机器人：工作量证明（服务端见 src/auth/bot-guard.ts）；实现抽在 pow.ts，与知家共用 ——

// —— 登录 / 注册 ——

export async function showAuthScreen(): Promise<void> {
  const cfg = await fetch('/api/auth/config').then(r => r.json()).catch(() => ({ has_users: true, dev_mode: false })) as { has_users: boolean; dev_mode: boolean }
  const screen = $('authScreen')
  screen.hidden = false
  let mode: 'login' | 'register' | 'reset' = cfg.has_users ? 'login' : 'register'
  // 邀请链接：直接进注册，提示加入哪个机构；邀请无效时如实说明，仍可正常登录 / 注册
  const code = inviteCode()
  let invite: { tenant: string; role: 'admin' | 'member' } | null = null
  if (code) {
    const r = await fetch(`/api/invites/${encodeURIComponent(code)}`)
    const data = await r.json().catch(() => ({}))
    if (r.ok) { invite = data; mode = 'register' } else $('authError').textContent = data.error ?? '邀请链接无效'
  }
  const render = () => {
    screen.querySelector('.auth-title')!.textContent = !cfg.has_users ? '创建管理员账户' : mode === 'login' ? '登录' : mode === 'reset' ? '找回密码' : '注册'
    screen.querySelector('.auth-sub')!.textContent = !cfg.has_users
      ? '这是第一个账户，将成为平台运营：可以新建机构、管理所有账户。'
      : mode === 'login' ? '登录后继续你的文档与幻灯片。'
        : mode === 'reset' ? '向你绑定的邮箱发送验证码。没有绑定邮箱的账户请联系管理员重置。'
          : invite ? `受邀加入「${invite.tenant}」（${invite.role === 'admin' ? '机构管理员' : '成员'}）。注册后即可开始；文档、资料只有你自己能看到。`
            : '注册后即可开始写作；文档、资料只有你自己能看到。'
    $('authForm').hidden = mode === 'reset'
    $('resetForm').hidden = mode !== 'reset'
    $('authDisplayRow').hidden = mode === 'login'
    $('authSubmit').textContent = mode === 'login' ? '登录' : '创建账户'
    $('authSwitch').innerHTML = !cfg.has_users ? '' : mode === 'login'
      ? '<a href="#" data-mode="reset">忘记密码？</a> · 还没有账户？<a href="#" data-mode="register">注册</a>'
      : mode === 'reset' ? '想起来了？<a href="#" data-mode="login">登录</a>'
        : '已有账户？<a href="#" data-mode="login">登录</a>'
    $('authHint').hidden = mode === 'login'
    if (!code || invite) $('authError').textContent = ''
    $<HTMLInputElement>('authPassword').autocomplete = mode === 'login' ? 'current-password' : 'new-password'
  }
  render()
  $('authDev').hidden = !cfg.dev_mode
  $('authSwitch').onclick = e => {
    const a = (e.target as HTMLElement).closest('[data-mode]') as HTMLElement | null
    if (!a) return
    e.preventDefault()
    mode = a.dataset.mode as typeof mode
    render()
  }
  $('authDev').onclick = e => {
    e.preventDefault()
    saveToken('dev')
    location.reload()
  }
  // 打开页面就在后台解题：用户填表期间算完，提交时通常无需等待；每题只能用一次，用后再领
  let pow = solvePow()
  pow.catch(() => {})
  $<HTMLFormElement>('authForm').onsubmit = async e => {
    e.preventDefault()
    const btn = $<HTMLButtonElement>('authSubmit')
    const label = btn.textContent
    btn.disabled = true
    btn.textContent = '正在进行人机校验…'
    $('authError').textContent = ''
    try {
      const body = {
        username: $<HTMLInputElement>('authUsername').value,
        password: $<HTMLInputElement>('authPassword').value,
        display_name: $<HTMLInputElement>('authDisplay').value,
        website: $<HTMLInputElement>('authWebsite').value,
      }
      const { solution, fetchedAt } = await pow
      // 服务端要求领题后至少 1.5 秒才提交（拦脚本）：按本机领题时刻补足，不受时钟偏差影响
      await powDelay(fetchedAt)
      btn.textContent = label
      const r = await post(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { ...body, pow: solution, ...(mode === 'register' && invite ? { invite: code } : {}) })
      saveToken(r.token)
      if (code) history.replaceState(null, '', '/app')
      location.reload()
    } catch (err) {
      $('authError').textContent = (err as Error).message
      btn.textContent = label
      btn.disabled = false
      pow = solvePow()
      pow.catch(() => {})
    }
  }
  // 找回密码：发码（需人机校验）→ 验证码 + 新密码
  let resetPow = solvePow()
  resetPow.catch(() => {})
  let cooldown = 0
  $('resetSend').onclick = async () => {
    const btn = $<HTMLButtonElement>('resetSend')
    if (cooldown > Date.now()) return
    $('resetError').textContent = ''
    btn.disabled = true
    btn.textContent = '发送中…'
    try {
      const { solution, fetchedAt } = await resetPow
      await powDelay(fetchedAt)
      await post('/api/auth/password-code', { email: $<HTMLInputElement>('resetEmail').value, pow: solution, website: $<HTMLInputElement>('authWebsite').value })
      $('resetNote').textContent = '如果这个邮箱绑定了账户，验证码已发出（10 分钟内有效）。没收到请检查垃圾邮件。'
      $<HTMLInputElement>('resetCode').focus()
      cooldown = Date.now() + 60_000
      const tick = () => {
        const left = Math.ceil((cooldown - Date.now()) / 1000)
        if (left > 0) { btn.textContent = `${left} 秒后可重发`; setTimeout(tick, 1000) } else { btn.textContent = '重新发送'; btn.disabled = false }
      }
      tick()
    } catch (err) {
      $('resetError').textContent = (err as Error).message
      btn.textContent = '发送验证码'
      btn.disabled = false
    }
    resetPow = solvePow()
    resetPow.catch(() => {})
  }
  $<HTMLFormElement>('resetForm').onsubmit = async e => {
    e.preventDefault()
    $('resetError').textContent = ''
    try {
      const r = await post('/api/auth/reset-password', {
        email: $<HTMLInputElement>('resetEmail').value,
        code: $<HTMLInputElement>('resetCode').value,
        new_password: $<HTMLInputElement>('resetPassword').value,
      })
      saveToken(r.token)
      location.reload()
    } catch (err) {
      $('resetError').textContent = (err as Error).message
    }
  }
  $<HTMLInputElement>('authUsername').focus()
}

// —— 用户菜单 ——

const nudgeKey = (id: string) => `heurion.emailNudge.${id}`
const dismissed = (id: string) => { try { return localStorage.getItem(nudgeKey(id)) === '1' } catch { return false } }
const dismiss = (id: string) => { try { localStorage.setItem(nudgeKey(id), '1') } catch { /* 忽略 */ } }

export function initUserMenu(me: Me, api: <T = any>(path: string, opts?: RequestInit) => Promise<T>, notify: (msg: string, error?: boolean) => void): void {
  const initial = (me.display_name || me.username).trim().slice(0, 1).toUpperCase()
  $('userAvatar').textContent = initial
  $('userName').textContent = me.display_name
  const tenantRole = me.tenant?.role === 'admin' ? '管理员' : '成员'
  // 工作空间（医院或个人）+ 个人空间（知家）
  $('userRole').textContent = me.dev ? '开发用户' : me.tenant?.kind === 'org' ? `${me.tenant.name} · ${tenantRole}${me.tenant.in_org ? ' · 另有个人空间（知家）' : ''}` : me.role === 'admin' ? '平台运营' : `${me.username} · 个人空间`
  $('userMenuAdmin').hidden = me.role !== 'admin'
  $('userMenuTenant').hidden = me.dev || me.tenant?.role !== 'admin'
  $('userMenuTenant').textContent = me.tenant?.kind === 'org' ? '机构管理' : '机构与邀请'
  // 已登录时打开邀请链接：确认后用现有账户加入（个人空间 / 知家保留）
  const linkCode = inviteCode()
  if (linkCode && !me.dev) {
    history.replaceState(null, '', '/app')
    void openJoin(linkCode, api, notify)
  }
  $('userMenuLeave').hidden = !!me.dev || !me.tenant?.in_org
  $('userMenuPhr').hidden = !!me.dev
  if (!me.dev) void refreshInvites(api, notify)
  // 读视图是模型看到的文档表示，只在开发模式下作为排查工具提供
  $('userMenuReadView').hidden = !me.dev_mode
  $('userMenuSettings').hidden = !!me.dev
  $('userMenuEverywhere').hidden = !!me.dev
  const menu = $('userMenu')
  $('userButton').onclick = e => {
    e.stopPropagation()
    menu.hidden = !menu.hidden
  }
  document.addEventListener('click', e => { if (!menu.contains(e.target as Node)) menu.hidden = true })
  // 没绑邮箱：提醒一次（可关掉），忘记密码时才能自助找回
  if (!me.dev && !me.email && !dismissed(me.id)) {
    const bar = $('emailNudge')
    bar.hidden = false
    bar.onclick = e => {
      const t = (e.target as HTMLElement).closest('[data-nudge]') as HTMLElement | null
      if (!t) return
      bar.hidden = true
      if (t.dataset.nudge === 'bind') openSettings(me, api, notify)
      else dismiss(me.id)
    }
  }
  menu.onclick = async e => {
    const item = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null
    if (!item) return
    menu.hidden = true
    switch (item.dataset.action) {
      case 'help': document.dispatchEvent(new CustomEvent('heurion:help')); break
      case 'settings': openSettings(me, api, notify); break
      case 'admin': void openAdmin(me, api, notify); break
      case 'tenant': void openTenant(me, api, notify); break
      case 'invites': void openMyInvites(api, notify); break
      case 'phr': location.href = '/phr'; break
      case 'leave': void leaveHospital(me, api, notify); break
      case 'everywhere':
        await api('/api/auth/logout-everywhere', { method: 'POST' }).catch(() => {})
        signOut()
        break
      case 'readview': document.dispatchEvent(new CustomEvent('heurion:readview')); break
      case 'logout': signOut(); break
    }
  }
}

// —— 已有账户加入医院（双重身份：工作台按医院，知家仍是自己的个人空间）——

interface InviteView { code: string; tenant: string; tenant_id: string; role: 'admin' | 'member'; invited_by: string | null; expires_at: string }

/** 发给我的邀请：菜单里显示数目，页面顶部提醒一次（可「以后再说」）。 */
async function refreshInvites(api: ApiFn, notify: Notify): Promise<void> {
  const list = await api<InviteView[]>('/api/me/invites').catch(() => [] as InviteView[])
  const item = $('userMenuInvites')
  item.hidden = list.length === 0
  item.textContent = list.length ? `医院邀请（${list.length}）` : '医院邀请'
  const bar = $('inviteNudge')
  const key = list.map(i => i.code).join(',')
  let later = ''
  try { later = sessionStorage.getItem('heurion.inviteLater') ?? '' } catch { /* 无痕模式 */ }
  bar.hidden = list.length === 0 || later === key
  if (!list.length) return
  $('inviteNudgeText').textContent = list.length === 1 ? `${list[0]!.tenant} 邀请你加入（${list[0]!.role === 'admin' ? '机构管理员' : '成员'}）。` : `有 ${list.length} 家医院邀请你加入。`
  bar.onclick = e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-join]')
    if (!t) return
    bar.hidden = true
    if (t.dataset.join === 'view') {
      void (list.length === 1 ? openJoin(list[0]!.code, api, notify) : openMyInvites(api, notify))
    } else { try { sessionStorage.setItem('heurion.inviteLater', key) } catch { /* 无痕模式 */ } }
  }
}

const JOIN_EXPLAIN = `<ul class="join-explain">
    <li>加入后，<b>工作台</b>里的患者、临床研究、科室、机构幻灯片模板都按这家医院走；管理员会把你分进科室，你就能收到发给科室的家庭分享。</li>
    <li>你的<b>个人文档、资料库、记忆</b>仍只属于你，医院管理员看不到。</li>
    <li><b>知家</b>（个人空间）里的家人健康档案不受影响，照常使用。</li>
    <li>同一时间只能加入一家医院；随时可以在头像菜单里「退出医院」。</li>
  </ul>`

/** 接受 / 拒绝一个邀请（邀请链接或按用户名的邀请）。 */
async function openJoin(code: string, api: ApiFn, notify: Notify): Promise<void> {
  let inv: InviteView
  try { inv = await api<InviteView>(`/api/me/invites/${encodeURIComponent(code)}`) } catch (err) { notify((err as Error).message, true); return }
  const dlg = openDialog(`加入「${inv.tenant}」`, `
    <p>${inv.invited_by ? `${esc(inv.invited_by)} ` : ''}邀请你以<b>${inv.role === 'admin' ? '机构管理员' : '成员'}</b>身份加入 <b>${esc(inv.tenant)}</b>。</p>
    ${JOIN_EXPLAIN}
    <p class="muted small">邀请有效期至 ${esc(when(inv.expires_at))}</p>
    <div class="row end"><button data-j="decline">拒绝</button><button data-j="later" class="quiet">以后再说</button><button class="primary" data-j="accept">接受加入</button></div>`)
  dlg.querySelector('.dialog-body')!.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-j]')
    if (!b) return
    if (b.dataset.j === 'later') { closeDialog(); return }
    try {
      if (b.dataset.j === 'accept') {
        await api(`/api/me/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' })
        notify(`已加入 ${inv.tenant}`); setTimeout(() => location.reload(), 700)
      } else {
        await api(`/api/me/invites/${encodeURIComponent(code)}/decline`, { method: 'POST' })
        notify('已拒绝'); closeDialog(); void refreshInvites(api, notify)
      }
    } catch (err) { notify((err as Error).message, true) }
  })
}

async function openMyInvites(api: ApiFn, notify: Notify): Promise<void> {
  const list = await api<InviteView[]>('/api/me/invites').catch(() => [] as InviteView[])
  const dlg = openDialog('医院邀请', list.length === 0 ? '<div class="muted">没有待处理的邀请</div>'
    : `<table class="users"><tbody>${list.map(i => `<tr><td><b>${esc(i.tenant)}</b><div class="muted">${i.invited_by ? `${esc(i.invited_by)} 邀请 · ` : ''}${i.role === 'admin' ? '机构管理员' : '成员'} · 有效期至 ${esc(when(i.expires_at))}</div></td>
      <td class="actions"><button class="primary" data-open="${esc(i.code)}">查看</button></td></tr>`).join('')}</tbody></table>`)
  dlg.querySelector('.dialog-body')!.addEventListener('click', e => {
    const code = (e.target as HTMLElement).closest<HTMLElement>('[data-open]')?.dataset.open
    if (code) { closeDialog(); void openJoin(code, api, notify) }
  })
}

async function leaveHospital(me: Me, api: ApiFn, notify: Notify): Promise<void> {
  const name = me.tenant?.name ?? '医院'
  const dlg = openDialog(`退出「${name}」`, `
    <p>退出后工作台回到你的个人空间：</p>
    <ul class="join-explain"><li>本院研究里的成员身份、科室归属会去掉；还负责本院研究的，要先转交给同事。</li>
      <li>本院患者你将看不到（诊疗组记录保留，重新加入后恢复）。</li><li>个人文档和知家不受影响。</li></ul>
    <div class="row end"><button data-l="cancel" class="quiet">取消</button><button class="danger" data-l="leave">退出医院</button></div>`)
  dlg.querySelector('.dialog-body')!.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-l]')
    if (!b) return
    if (b.dataset.l === 'cancel') { closeDialog(); return }
    try { await api('/api/tenant/leave', { method: 'POST' }); notify('已退出医院'); setTimeout(() => location.reload(), 700) } catch (err) { notify((err as Error).message, true) }
  })
}

function closeDialog(): void { const d = $('dialog'); d.hidden = true; d.innerHTML = '' }

function openDialog(title: string, body: string, wide = false): HTMLElement {
  const dlg = $('dialog')
  dlg.innerHTML = `<div class="dialog-card${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="dialog-head"><h2>${esc(title)}</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
    <div class="dialog-body">${body}</div></div>`
  dlg.hidden = false
  const close = () => { dlg.hidden = true; dlg.innerHTML = ''; document.removeEventListener('keydown', onKey) }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) close() }
  return dlg
}

function openSettings(me: Me, api: <T = any>(path: string, opts?: RequestInit) => Promise<T>, notify: (msg: string, error?: boolean) => void): void {
  const dlg = openDialog('个人设置', `
    <form id="profileForm" class="form">
      <label>用户名<input type="text" value="${esc(me.username)}" disabled></label>
      <label>显示名<input type="text" name="display_name" value="${esc(me.display_name)}" maxlength="40" required></label>
      <div class="row end"><button class="primary">保存</button></div>
    </form>
    <form id="workEmailForm" class="form">
      <h3>专属工作邮箱 (Heurion Mail)</h3>
      <div class="muted">配置您在院内与多中心科研协作中的专属发件/收件邮箱前缀：</div>
      <label>专属工作邮箱前缀
        <span class="field-row">
          <input type="text" id="workEmailPrefixInput" name="work_email_prefix" value="${esc(me.work_email_prefix || me.username.toLowerCase())}" placeholder="例如：${esc(me.username.toLowerCase())}" maxlength="32" required pattern="[a-zA-Z0-9._-]+">
          <span class="work-email-suffix" style="display:inline-flex;align-items:center;padding:0 8px;font-family:var(--mono);color:var(--muted);background:var(--bg-deep);border:1px solid var(--line);border-left:none;">@heurion.org</span>
        </span>
      </label>
      <div class="muted small work-email-preview">生效邮箱：<strong id="workEmailPreview">${esc(me.work_email || `${(me.work_email_prefix || me.username.toLowerCase())}@heurion.org`)}</strong>（外部真实来信与院内信件均直达此邮箱）</div>
      <div class="form-error" id="workEmailError"></div>
      <div class="row end"><button class="primary" id="workEmailSaveBtn">保存工作邮箱前缀</button></div>
    </form>
    <form id="emailForm" class="form">
      <h3>找回密码邮箱</h3>
      <div class="muted">${me.email ? `已绑定 <b>${esc(me.email)}</b>。忘记密码时可以用它自助找回；要换绑，在下面填新邮箱。` : '还没有绑定邮箱：绑定后忘记密码可以自助找回，否则只能找管理员重置。'}</div>
      <label>${me.email ? '新邮箱' : '邮箱'}<span class="field-row"><input type="text" name="email" inputmode="email" autocomplete="email" required><button type="button" id="emailSend">发送验证码</button></span></label>
      <label>验证码<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
      <div class="form-error" id="emailError"></div>
      <div class="row end"><button class="primary">绑定</button></div>
    </form>
    <form id="passwordForm" class="form">
      <h3>修改密码</h3>
      <label>当前密码<input type="password" name="current_password" autocomplete="current-password" required></label>
      <label>新密码<input type="password" name="new_password" autocomplete="new-password" required minlength="8"></label>
      <div class="muted">至少 8 位，同时包含字母和数字。修改后其他设备上的登录会失效。</div>
      <div class="form-error" id="passwordError"></div>
      <div class="row end"><button class="primary">修改密码</button></div>
    </form>
    <div id="aegisGrantsSection" class="form">
      <h3>Aegis-OS 智能体终端授权 (AAP-1.0)</h3>
      <div class="muted small">将您的医生/研究员账户与本地 Aegis-OS 运行时（Antigravity / Hermes 多智能体协同沙箱）绑定。智能体将以您的身份和租户权限执行操作，高危对外动作需您批准短期租约 (Session Lease)。</div>
      <div id="aegisGrantsBox" class="muted small" style="margin-top:8px">加载中…</div>
    </div>`, true)
  dlg.querySelector<HTMLFormElement>('#profileForm')!.onsubmit = async e => {
    e.preventDefault()
    const name = new FormData(e.target as HTMLFormElement).get('display_name') as string
    try {
      await api('/api/me', { method: 'PATCH', body: JSON.stringify({ display_name: name }) })
      $('userName').textContent = name
      notify('已保存')
    } catch (err) { notify((err as Error).message, true) }
  }

  const workEmailForm = dlg.querySelector<HTMLFormElement>('#workEmailForm')!
  const prefixInput = dlg.querySelector<HTMLInputElement>('#workEmailPrefixInput')!
  const previewEl = dlg.querySelector<HTMLElement>('#workEmailPreview')!
  prefixInput.oninput = () => {
    const raw = prefixInput.value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
    previewEl.textContent = `${raw || me.username.toLowerCase()}@heurion.org`
  }
  workEmailForm.onsubmit = async e => {
    e.preventDefault()
    const prefix = prefixInput.value.trim().toLowerCase()
    const errEl = dlg.querySelector('#workEmailError')!
    errEl.textContent = ''
    try {
      const res = await api<{ user: any }>('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_email_prefix: prefix }),
      })
      me.work_email_prefix = res.user?.work_email_prefix || prefix
      me.work_email = res.user?.work_email || `${prefix}@heurion.org`
      notify(`专属工作邮箱已更新为：${me.work_email}`)
      document.dispatchEvent(new CustomEvent('heurion:user-updated', { detail: me }))
    } catch (err) {
      errEl.textContent = (err as Error).message
    }
  }
  const emailForm = dlg.querySelector<HTMLFormElement>('#emailForm')!
  dlg.querySelector<HTMLButtonElement>('#emailSend')!.onclick = async () => {
    const btn = dlg.querySelector<HTMLButtonElement>('#emailSend')!
    try {
      await api('/api/me/email-code', { method: 'POST', body: JSON.stringify({ email: (emailForm.elements.namedItem('email') as HTMLInputElement).value }) })
      btn.disabled = true
      btn.textContent = '已发送'
      notify('验证码已发送，10 分钟内有效')
      setTimeout(() => { btn.disabled = false; btn.textContent = '重新发送' }, 60_000)
    } catch (err) { dlg.querySelector('#emailError')!.textContent = (err as Error).message }
  }
  emailForm.onsubmit = async e => {
    e.preventDefault()
    const f = new FormData(emailForm)
    try {
      const u = await api('/api/me/email', { method: 'POST', body: JSON.stringify({ email: f.get('email'), code: f.get('code') }) })
      me.email = u.email
      notify('邮箱已绑定')
      openSettings(me, api, notify)
    } catch (err) { dlg.querySelector('#emailError')!.textContent = (err as Error).message }
  }
  dlg.querySelector<HTMLFormElement>('#passwordForm')!.onsubmit = async e => {
    e.preventDefault()
    const f = new FormData(e.target as HTMLFormElement)
    try {
      const r = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ current_password: f.get('current_password'), new_password: f.get('new_password') }) })
      if (r.token) saveToken(r.token)
      notify('密码已修改')
      setTimeout(() => location.reload(), 700)
    } catch (err) { dlg.querySelector('#passwordError')!.textContent = (err as Error).message }
  }
  void mountAegisGrants(dlg.querySelector<HTMLElement>('#aegisGrantsBox')!, api, notify)
}

interface AegisGrantItem {
  id: string
  name: string
  token_prefix: string
  aegis_node_pubkey: string | null
  tool_scope: 'all' | 'canvas' | 'clinical' | 'research' | 'readonly'
  write_mode: 'direct' | 'tracked'
  created_at: string
  expires_at: string | null
  last_used_at: string | null
  last_agent_id: string | null
  revoked_at: string | null
}

const SCOPE_LABELS: Record<string, string> = {
  all: '全量工作站 (all)',
  canvas: '仅论文与幻灯片 (canvas)',
  clinical: '仅临床患者与影像 (clinical)',
  research: '仅临床研究与统计 (research)',
  readonly: '只读检阅 (readonly)',
}

async function mountAegisGrants(
  box: HTMLElement,
  api: <T = any>(path: string, opts?: RequestInit) => Promise<T>,
  notify: (msg: string, error?: boolean) => void,
): Promise<void> {
  let newlyIssuedToken: string | null = null
  const render = async () => {
    const res = await api<{ grants: AegisGrantItem[] }>('/api/aegis/auth/grants').catch(() => ({ grants: [] }))
    const grants = res.grants ?? []
    box.className = ''
    box.innerHTML = `
      <form id="aegisGrantIssueForm" class="inline-form" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        <input type="text" name="name" placeholder="终端名称（如：Mac Studio / agy-research）" maxlength="60" required style="flex:1 1 200px">
        <select name="tool_scope" aria-label="权限范围">
          <option value="all">全量工作站 (all)</option>
          <option value="canvas">仅文稿与幻灯片 (canvas)</option>
          <option value="clinical">仅临床患者 (clinical)</option>
          <option value="research">仅临床研究与统计 (research)</option>
          <option value="readonly">只读模式 (readonly)</option>
        </select>
        <select name="write_mode" aria-label="写入模式">
          <option value="tracked">留痕修订 (tracked)</option>
          <option value="direct">直接生效 (direct)</option>
        </select>
        <input type="text" name="node_pubkey" placeholder="可选：Aegis-OS 节点 Ed25519 公钥" style="flex:1 1 180px">
        <button class="primary" type="submit">签发授权令牌</button>
      </form>
      ${newlyIssuedToken ? `
        <div class="invite-link" style="margin-bottom:10px">
          <div class="muted small">新签发的 Aegis-OS 授权令牌（请立即复制，关闭后不再显示明文）：</div>
          <div class="field-row" style="margin-top:4px">
            <input type="text" id="aegisIssuedTokenInput" readonly value="${esc(newlyIssuedToken)}">
            <button type="button" id="aegisCopyTokenBtn">复制令牌</button>
            <button type="button" class="primary" id="aegisCopyCmdBtn">复制 CLI 登录命令</button>
          </div>
        </div>
      ` : ''}
      ${grants.length === 0
        ? '<div class="muted small">尚未绑定任何 Aegis-OS 智能体终端。</div>'
        : `<table class="users">
            <thead><tr><th>终端名称</th><th>范围 / 写模式</th><th>最近调用 Agent</th><th>状态</th><th></th></tr></thead>
            <tbody>${grants.map(g => `
              <tr data-gid="${esc(g.id)}" class="${g.revoked_at ? 'disabled' : ''}">
                <td>
                  <b>${esc(g.name)}</b>
                  <div class="muted small" style="font-family:var(--mono)">${esc(g.token_prefix)}…${g.aegis_node_pubkey ? ' · 已绑节点公钥' : ''}</div>
                </td>
                <td class="small">${esc(SCOPE_LABELS[g.tool_scope] ?? g.tool_scope)}<div class="muted small">${g.write_mode === 'tracked' ? '留痕修订' : '直接写入'}</div></td>
                <td class="muted small">${g.last_agent_id ? `<code>${esc(g.last_agent_id)}</code><br>${when(g.last_used_at)}` : '尚未使用'}</td>
                <td>${g.revoked_at ? '<span class="pill off">已吊销</span>' : '<span class="pill ok">生效中</span>'}</td>
                <td class="actions">${g.revoked_at ? '' : `<button type="button" class="danger" data-revoke-grant="${esc(g.id)}">吊销</button>`}</td>
              </tr>`).join('')}
            </tbody>
          </table>`}
    `
    const form = box.querySelector<HTMLFormElement>('#aegisGrantIssueForm')
    if (form) {
      form.onsubmit = async e => {
        e.preventDefault()
        const f = new FormData(form)
        try {
          const issued = await api<{ access_token: string }>('/api/aegis/auth/token', {
            method: 'POST',
            body: JSON.stringify({
              name: String(f.get('name') ?? '').trim(),
              tool_scope: String(f.get('tool_scope') ?? 'all'),
              write_mode: String(f.get('write_mode') ?? 'tracked'),
              node_pubkey: String(f.get('node_pubkey') ?? '').trim() || undefined,
            }),
          })
          newlyIssuedToken = issued.access_token
          notify('已签发 Aegis-OS 授权令牌')
          await render()
        } catch (err) {
          notify((err as Error).message, true)
        }
      }
    }
    box.querySelector<HTMLButtonElement>('#aegisCopyTokenBtn')?.addEventListener('click', async () => {
      if (!newlyIssuedToken) return
      await navigator.clipboard.writeText(newlyIssuedToken).catch(() => {})
      notify('已复制 Aegis 授权令牌')
    })
    box.querySelector<HTMLButtonElement>('#aegisCopyCmdBtn')?.addEventListener('click', async () => {
      if (!newlyIssuedToken) return
      const cmd = `aegis app login heurion --url ${location.origin} --token ${newlyIssuedToken}`
      await navigator.clipboard.writeText(cmd).catch(() => {})
      notify('已复制 CLI 登录命令')
    })
    box.querySelectorAll<HTMLButtonElement>('[data-revoke-grant]').forEach(btn => {
      btn.onclick = async () => {
        const gid = btn.dataset.revokeGrant
        if (!gid) return
        try {
          await api('/api/aegis/auth/token', {
            method: 'DELETE',
            body: JSON.stringify({ grant_id: gid }),
          })
          notify('已吊销该 Aegis-OS 终端授权，其关联租约已立即失效')
          await render()
        } catch (err) {
          notify((err as Error).message, true)
        }
      }
    })
  }
  await render()
}

async function openAdmin(me: Me, api: <T = any>(path: string, opts?: RequestInit) => Promise<T>, notify: (msg: string, error?: boolean) => void): Promise<void> {
  const dlg = openDialog('平台运营', `
    <div class="org-tabs" id="adminTabs">
      <button class="org-tab active" data-tab="tenants">${icon('building')} 机构大盘</button>
      <button class="org-tab" data-tab="users">${icon('users')} 全局用户</button>
      <button class="org-tab" data-tab="settings">${icon('template')} 实例设置</button>
      <button class="org-tab" data-tab="audit">${icon('shield')} 全局审计</button>
    </div>
    <div class="org-panel" id="tabAdminTenants">
      <div id="platformTenants" class="muted">加载中…</div>
    </div>
    <div class="org-panel" id="tabAdminUsers" hidden>
      <div class="member-search-row">
        <input type="search" id="adminUserSearch" class="member-search-input" placeholder="按姓名、用户名或机构筛选用户..." autocomplete="off">
      </div>
      <div id="adminUsers" class="muted">加载中…</div>
    </div>
    <div class="org-panel" id="tabAdminSettings" hidden>
      <div id="adminSettings" class="admin-settings"></div>
    </div>
    <div class="org-panel" id="tabAdminAudit" hidden>
      ${AUDIT_HTML}
    </div>`, true)

  const tabs = dlg.querySelectorAll<HTMLButtonElement>('#adminTabs .org-tab')
  const panels: Record<string, HTMLElement> = {
    tenants: dlg.querySelector('#tabAdminTenants')!,
    users: dlg.querySelector('#tabAdminUsers')!,
    settings: dlg.querySelector('#tabAdminSettings')!,
    audit: dlg.querySelector('#tabAdminAudit')!,
  }
  tabs.forEach(btn => btn.addEventListener('click', () => {
    const t = btn.dataset.tab!
    tabs.forEach(b => b.classList.toggle('active', b === btn))
    Object.entries(panels).forEach(([k, p]) => { p.hidden = k !== t })
  }))

  void renderTenants(dlg, me, api, notify).catch(err => notify((err as Error).message, true))
  mountAudit(dlg, '/api/admin/audit', api, notify)
  // 实例设置：记忆总开关（停用会删除所有用户的记忆，页内二次确认）
  const renderSettings = async () => {
    const st = await api<{ memory_enabled: boolean }>('/api/admin/settings')
    const box = dlg.querySelector('#adminSettings')!
    box.innerHTML = `<label class="toggle"><input type="checkbox" id="adminMemory" ${st.memory_enabled ? 'checked' : ''}> 本实例启用记忆</label>
      <span class="muted small">AI 记住用户确认过的偏好与事实；停用会删除所有用户的记忆。</span>`
    const cb = box.querySelector<HTMLInputElement>('#adminMemory')!
    cb.onchange = async e => {
      e.stopPropagation()
      if (cb.checked) { await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ memory_enabled: true }) }); notify('已启用记忆'); return }
      cb.checked = true
      box.insertAdjacentHTML('beforeend', `<div class="danger-confirm" id="memOffConfirm">停用后所有用户的记忆会被<b>彻底删除</b>，重新启用后从头开始。
        <button class="danger" id="memOffYes">停用并删除</button><button id="memOffNo">取消</button></div>`)
      box.querySelector<HTMLButtonElement>('#memOffNo')!.onclick = () => box.querySelector('#memOffConfirm')?.remove()
      box.querySelector<HTMLButtonElement>('#memOffYes')!.onclick = async () => {
        const r = await api<{ deleted: number }>('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ memory_enabled: false }) })
        notify(`已停用记忆，删除 ${r.deleted} 条`)
        await renderSettings()
      }
    }
  }
  void renderSettings().catch(err => notify((err as Error).message, true))
  const render = async () => {
    const users: any[] = await api('/api/admin/users')
    dlg.querySelector('#adminUsers')!.outerHTML = `<table class="users" id="adminUsers">
      <thead><tr><th>用户</th><th>机构</th><th>平台角色</th><th>状态</th><th>文档</th><th>最近登录</th><th></th></tr></thead>
      <tbody>${users.map(u => `<tr data-uid="${esc(u.id)}" class="${u.status === 'disabled' ? 'disabled' : ''}">
        <td><b>${esc(u.display_name)}</b><div class="muted">${esc(u.username)}${u.imported ? ' · 从 1.0 导入' : ''}${u.id === me.id ? ' · 我' : ''}</div></td>
        <td>${esc(u.tenant)}</td>
        <td><select data-field="role"><option value="user"${u.role === 'user' ? ' selected' : ''}>普通用户</option><option value="admin"${u.role === 'admin' ? ' selected' : ''}>平台运营</option></select></td>
        <td>${u.status === 'active' ? '<span class="pill ok">正常</span>' : '<span class="pill off">已停用</span>'}</td>
        <td>${u.doc_count}</td>
        <td class="muted">${u.last_login_at ? new Date(u.last_login_at).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
        <td class="actions"><div class="actions-row">
          <button data-act="${u.status === 'active' ? 'disable' : 'enable'}">${u.status === 'active' ? '停用' : '启用'}</button>
          <button data-act="reset">重置密码</button>
          <button data-act="logout" title="让该用户所有设备上的登录失效">强制下线</button>
        </div></td></tr>`).join('')}</tbody></table>`

    const searchInput = dlg.querySelector<HTMLInputElement>('#adminUserSearch')
    if (searchInput) {
      searchInput.oninput = () => {
        const q = searchInput.value.trim().toLowerCase()
        dlg.querySelectorAll<HTMLElement>('#adminUsers tbody tr').forEach(tr => {
          if (tr.classList.contains('reset-row')) return
          const text = tr.innerText.toLowerCase()
          tr.hidden = Boolean(q && !text.includes(q))
        })
      }
    }
  }
  await render().catch(err => notify((err as Error).message, true))
  dlg.onchange = async e => {
    const sel = e.target as HTMLSelectElement
    const uid = (sel.closest('[data-uid]') as HTMLElement | null)?.dataset.uid
    if (!uid || sel.dataset.field !== 'role') return
    try { await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: JSON.stringify({ role: sel.value }) }); notify('角色已更新') } catch (err) { notify((err as Error).message, true) }
    await render()
  }
  dlg.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
    const uid = (btn?.closest('[data-uid]') as HTMLElement | null)?.dataset.uid
    if (!btn || !uid) return
    try {
      if (btn.dataset.act === 'disable' || btn.dataset.act === 'enable') {
        await api(`/api/admin/users/${uid}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.act === 'disable' ? 'disabled' : 'active' }) })
        notify(btn.dataset.act === 'disable' ? '已停用，该用户的登录立即失效' : '已启用')
      } else if (btn.dataset.act === 'reset') {
        const row = btn.closest('tr')!
        const box = document.createElement('tr')
        box.className = 'reset-row'
        box.innerHTML = `<td colspan="7"><form class="inline-form"><input type="text" name="pw" placeholder="新密码（至少 8 位，含字母和数字）" required minlength="8"><button class="primary">设置</button></form></td>`
        row.after(box)
        box.querySelector('form')!.onsubmit = async ev => {
          ev.preventDefault()
          const pw = (box.querySelector('input') as HTMLInputElement).value
          try { await api(`/api/admin/users/${uid}/reset-password`, { method: 'POST', body: JSON.stringify({ password: pw }) }); notify('密码已重置，请告知该用户'); box.remove() } catch (err) { notify((err as Error).message, true) }
        }
        return
      } else if (btn.dataset.act === 'logout') {
        await api(`/api/admin/users/${uid}/logout`, { method: 'POST' })
        notify('已让该用户所有设备下线')
      }
    } catch (err) { notify((err as Error).message, true) }
    await render()
  })
}

const AUDIT_HTML = '<div class="audit"><div class="row"><span class="eyebrow">审计日志</span><span class="grow"></span><input id="auditActor" type="search" placeholder="按用户名筛选" autocomplete="off"><select id="auditAction"><option value="">全部操作</option><option value="auth.">登录与账户</option><option value="aegis.">Aegis-OS 智能体授权与租约</option><option value="doc.">文档（导出、删除）</option><option value="kb.">参考资料</option><option value="dataset.">数据</option><option value="memory.">记忆</option><option value="tenant.">机构管理</option><option value="admin.">平台运营</option><option value="platform.">机构开停</option></select></div><div id="auditList" class="muted">加载中…</div><button id="auditMore" hidden>更早的记录</button></div>'

/** 审计日志列表（平台运营看全部，机构管理员看本机构）。 */
function mountAudit(dlg: HTMLElement, endpoint: string, api: <T = any>(path: string, opts?: RequestInit) => Promise<T>, notify: (msg: string, error?: boolean) => void): void {
  // 审计日志：谁、什么时候、从哪里、对什么做了什么
  const AUDIT_LABEL: Record<string, string> = {
    'auth.login': '登录', 'auth.login_failed': '登录失败', 'auth.register': '注册', 'auth.register_failed': '注册失败',
    'auth.reset_password': '找回密码', 'auth.reset_password_failed': '找回密码失败', 'auth.logout_everywhere': '退出所有设备',
    'account.update': '修改个人资料', 'account.bind_email': '绑定邮箱',
    'aegis.grant_issue': '签发 Aegis 终端授权', 'aegis.grant_revoke': '吊销 Aegis 终端授权',
    'aegis.lease_approve': '批准 Aegis 提权租约', 'aegis.lease_reject': '拒绝 Aegis 提权租约',
    'doc.export': '导出文档', 'doc.trash': '移到回收站', 'doc.purge': '彻底删除文档', 'doc.restore': '恢复文档', 'project.delete': '删除项目',
    'kb.download': '下载资料原文', 'kb.delete': '删除资料', 'memory.clear': '清空记忆', 'memory.export': '导出记忆', 'memory.import': '导入记忆',
    'dataset.upload': '上传数据', 'dataset.delete': '删除数据', 'dataset.phi_resolve': '处理身份信息列',
    'tenant.update': '修改机构设置', 'tenant.member_update': '修改成员', 'tenant.invite': '发出邀请', 'tenant.invite_revoke': '撤销邀请',
    'platform.tenant_create': '新建机构', 'platform.tenant_status': '停用 / 恢复机构',
    'admin.user_update': '修改用户', 'admin.user_reset_password': '重置用户密码', 'admin.user_logout': '强制下线', 'admin.settings': '修改实例设置',
  }
  let auditRows: any[] = []
  const loadAudit = async (more = false) => {
    const q = new URLSearchParams()
    const actor = (dlg.querySelector('#auditActor') as HTMLInputElement).value.trim()
    const action = (dlg.querySelector('#auditAction') as HTMLSelectElement).value
    if (actor) q.set('actor', actor)
    if (action) q.set('action', action)
    if (more && auditRows.length) q.set('before', String(auditRows.at(-1).id))
    const rows: any[] = await api(`${endpoint}?${q}`)
    auditRows = more ? [...auditRows, ...rows] : rows
    const box = dlg.querySelector('#auditList')!
    box.className = auditRows.length ? '' : 'muted'
    box.innerHTML = auditRows.length === 0 ? '没有记录' : `<table class="users audit-table"><thead><tr><th>时间</th><th>用户</th><th>操作</th><th>对象</th><th>来源 IP</th></tr></thead><tbody>${auditRows.map(r =>
      `<tr class="${r.status >= 400 || /failed/.test(r.action) ? 'audit-failed' : ''}"><td class="muted">${new Date(r.at).toLocaleString('zh-CN', { hour12: false })}</td><td>${esc(r.actor_name ?? '—')}</td><td>${esc(AUDIT_LABEL[r.action] ?? r.action)}${r.status >= 400 ? ` <span class="muted">(${r.status})</span>` : ''}</td><td class="muted">${esc(r.target ?? r.detail ?? '')}</td><td class="muted">${esc(r.ip ?? '')}</td></tr>`).join('')}</tbody></table>`
    ;(dlg.querySelector('#auditMore') as HTMLElement).hidden = rows.length < 100
  }
  void loadAudit().catch(err => notify((err as Error).message, true))
  let auditTimer: ReturnType<typeof setTimeout> | undefined
  dlg.querySelector('#auditActor')!.addEventListener('input', () => { clearTimeout(auditTimer); auditTimer = setTimeout(() => void loadAudit(), 300) })
  dlg.querySelector('#auditAction')!.addEventListener('change', e => { e.stopPropagation(); void loadAudit() })
  ;(dlg.querySelector('#auditMore') as HTMLButtonElement).onclick = () => void loadAudit(true)
}

type ApiFn = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notify = (msg: string, error?: boolean) => void
const when = (t: string | null) => t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—'

/** 平台运营：机构列表、新建机构（得到首位管理员的邀请链接）、停用 / 恢复。 */
async function renderTenants(dlg: HTMLElement, me: Me, api: ApiFn, notify: Notify): Promise<void> {
  const list: any[] = await api('/api/platform/tenants')
  const box = dlg.querySelector<HTMLElement>('#platformTenants')!
  box.className = ''
  box.innerHTML = `<form class="inline-form" id="newTenant"><input type="text" name="name" placeholder="新机构名称，例如：某某医院心内科" required maxlength="60"><input type="text" name="email" placeholder="首位管理员邮箱（可选）" inputmode="email"><button class="primary">新建机构</button></form>
    <div id="newTenantLink"></div>
    <table class="users"><thead><tr><th>机构</th><th>类型</th><th>成员</th><th>文档</th><th>状态</th><th></th></tr></thead><tbody>
    ${list.filter(t => t.kind === 'org').concat(list.filter(t => t.kind !== 'org')).map(t => `<tr data-tid="${esc(t.id)}" class="${t.status === 'suspended' ? 'disabled' : ''}">
      <td><b>${esc(t.name)}</b><div class="muted small">建于 ${when(t.created_at)}${t.id === me.tenant?.id ? ' · 我所在' : ''}</div></td>
      <td>${t.kind === 'org' ? '机构' : '个人'}</td><td>${t.members}${t.admins ? `（管理员 ${t.admins}）` : ''}</td><td>${t.docs}</td>
      <td>${t.status === 'active' ? '<span class="pill ok">正常</span>' : '<span class="pill off">已停用</span>'}</td>
      <td class="actions">${t.id === me.tenant?.id ? '' : `<button data-tact="${t.status === 'active' ? 'suspend' : 'restore'}">${t.status === 'active' ? '停用' : '恢复'}</button>`}</td></tr>`).join('')}
    </tbody></table>`
  box.querySelector<HTMLFormElement>('#newTenant')!.onsubmit = async e => {
    e.preventDefault()
    const f = new FormData(e.target as HTMLFormElement)
    try {
      const r = await api('/api/platform/tenants', { method: 'POST', body: JSON.stringify({ name: f.get('name'), admin_email: f.get('email') }) })
      await renderTenants(dlg, me, api, notify)
      showLink(dlg.querySelector('#newTenantLink')!, inviteLink(r.invite.code), `把这个链接发给「${r.tenant.name}」的首位管理员（30 天内有效，只能用一次）：`, notify)
    } catch (err) { notify((err as Error).message, true) }
  }
  box.onclick = async e => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tact]')
    const tid = btn?.closest<HTMLElement>('[data-tid]')?.dataset.tid
    if (!btn || !tid) return
    e.stopPropagation()
    try {
      await api(`/api/platform/tenants/${tid}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.tact === 'suspend' ? 'suspended' : 'active' }) })
      notify(btn.dataset.tact === 'suspend' ? '已停用：该机构的成员立即下线、不能登录' : '已恢复')
      await renderTenants(dlg, me, api, notify)
    } catch (err) { notify((err as Error).message, true) }
  }
}

function showLink(box: Element, link: string, label: string, notify: Notify): void {
  box.innerHTML = `<div class="invite-link"><div class="muted small">${esc(label)}</div><div class="field-row"><input type="text" readonly value="${esc(link)}"><button type="button" class="primary">复制</button></div></div>`
  box.querySelector('button')!.onclick = async () => { await navigator.clipboard.writeText(link).catch(() => {}); notify('已复制邀请链接') }
  box.querySelector('input')!.select()
}

/** 机构管理（机构管理员）：名称与设置、成员、邀请、本机构审计。 */
/**
 * 科室（知家家庭分享按科室投递：家人选「医院 → 科室」，科室里的医生都能看到）。
 * 管理员建 / 改名 / 删科室、勾选成员（一人可在多个科室）；成员只能看。
 */
async function mountDepartments(box: HTMLElement, api: ApiFn, notify: Notify, admin: boolean, onMembersChange?: () => Promise<void>): Promise<void> {
  type Dept = { id: string; name: string; members: Array<{ id: string; display_name: string }> }
  const render = async () => {
    const list: Dept[] = await api('/api/tenant/departments')
    box.className = 'dept-box'
    box.innerHTML = `<div class="muted small" style="margin-bottom: 8px">家人在知家里分享档案时选「本院 → 科室」，科室里的医生都能在「患者 → 家庭分享」里看到。一人可在多个科室。</div>
      ${list.length ? `<table class="users"><thead><tr><th>科室</th><th>科室医生 (${list.reduce((acc, d) => acc + d.members.length, 0)} 人次)</th><th></th></tr></thead><tbody>${list.map(d => `<tr data-dept="${esc(d.id)}">
        <td style="min-width: 140px">${admin ? `<input class="dept-name" value="${esc(d.name)}" maxlength="40" aria-label="科室名称">` : `<b>${esc(d.name)}</b>`}</td>
        <td>${d.members.length ? d.members.map(m => `<span class="chip">${esc(m.display_name)}</span>`).join(' ') : '<span class="muted">还没有成员</span>'}</td>
        <td class="actions">${admin ? '<div class="actions-row"><button data-dact="members">设置成员</button><button data-dact="delete" class="danger">删除</button></div>' : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">还没有科室。</div>'}
      ${admin ? '<form class="inline-form" id="deptForm" style="margin-top: 10px"><input type="text" name="name" placeholder="新科室名称，如：心血管内科" maxlength="40" required><button class="primary">新建科室</button></form>' : ''}`
    box.querySelector<HTMLFormElement>('#deptForm')?.addEventListener('submit', async e => {
      e.preventDefault()
      try { await api('/api/tenant/departments', { method: 'POST', body: JSON.stringify({ name: new FormData(e.target as HTMLFormElement).get('name') }) }); notify('科室已建好'); await render() } catch (err) { notify((err as Error).message, true) }
    })
    box.querySelectorAll<HTMLInputElement>('.dept-name').forEach(inp => inp.addEventListener('change', async () => {
      const id = inp.closest<HTMLElement>('[data-dept]')!.dataset.dept!
      try { await api(`/api/tenant/departments/${id}`, { method: 'PATCH', body: JSON.stringify({ name: inp.value }) }); notify('已改名') } catch (err) { notify((err as Error).message, true) }
    }))
    box.querySelectorAll<HTMLButtonElement>('[data-dact]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.closest<HTMLElement>('[data-dept]')!.dataset.dept!
      const d = list.find(x => x.id === id)!
      if (btn.dataset.dact === 'delete') {
        btn.dataset.dact = 'delete-confirm'
        btn.textContent = '再点一次删除（发给该科室的家庭分享会失效）'
        return
      }
      if (btn.dataset.dact === 'delete-confirm') {
        try { await api(`/api/tenant/departments/${id}`, { method: 'DELETE' }); notify('已删除'); await render(); await onMembersChange?.() } catch (err) { notify((err as Error).message, true) }
        return
      }
      // 设置成员：带实时搜索过滤、全选/清空、已选计数
      const all: Array<{ id: string; display_name: string; username: string; status: string }> = await api('/api/tenant/members')
      const activeMembers = all.filter(u => u.status === 'active')
      const have = new Set(d.members.map(m => m.id))
      const row = btn.closest('tr')!
      const editor = document.createElement('tr')
      editor.className = 'dept-editor'
      editor.innerHTML = `<td colspan="3"><div class="dept-editor-inner">
        <div class="dept-filter-row">
          <input type="search" class="dept-member-filter" placeholder="搜索成员姓名、用户名..." autocomplete="off">
          <span class="muted small dept-count-info">已选 <b>${have.size}</b> / ${activeMembers.length} 人</span>
          <button type="button" class="quiet small-btn dept-select-all">全选</button>
          <button type="button" class="quiet small-btn dept-clear-all">清空</button>
        </div>
        <div class="dept-pick dept-pick-scroll">${activeMembers.map(u => `<label class="toggle dept-pick-item" data-text="${esc(u.display_name.toLowerCase())} ${esc(u.username.toLowerCase())}"><input type="checkbox" value="${esc(u.id)}" ${have.has(u.id) ? 'checked' : ''}> <b>${esc(u.display_name)}</b> <span class="muted">${esc(u.username)}</span></label>`).join('')}</div>
        <div class="actions-row" style="margin-top: 8px"><button class="primary" data-save>保存成员</button><button data-cancel>取消</button></div>
      </div></td>`
      box.querySelector('.dept-editor')?.remove()
      row.after(editor)

      const filterInput = editor.querySelector<HTMLInputElement>('.dept-member-filter')!
      const countInfo = editor.querySelector<HTMLElement>('.dept-count-info')!
      const updateCount = () => {
        const checkedCount = editor.querySelectorAll<HTMLInputElement>('.dept-pick-item input:checked').length
        countInfo.innerHTML = `已选 <b>${checkedCount}</b> / ${activeMembers.length} 人`
      }
      filterInput.addEventListener('input', () => {
        const q = filterInput.value.trim().toLowerCase()
        editor.querySelectorAll<HTMLElement>('.dept-pick-item').forEach(item => {
          const match = !q || (item.dataset.text ?? '').includes(q)
          item.hidden = !match
        })
      })
      editor.querySelector('.dept-select-all')?.addEventListener('click', () => {
        editor.querySelectorAll<HTMLElement>('.dept-pick-item:not([hidden]) input').forEach(i => { (i as HTMLInputElement).checked = true })
        updateCount()
      })
      editor.querySelector('.dept-clear-all')?.addEventListener('click', () => {
        editor.querySelectorAll<HTMLElement>('.dept-pick-item:not([hidden]) input').forEach(i => { (i as HTMLInputElement).checked = false })
        updateCount()
      })
      editor.querySelectorAll<HTMLInputElement>('.dept-pick-item input').forEach(i => i.addEventListener('change', updateCount))

      editor.querySelector('[data-cancel]')!.addEventListener('click', () => editor.remove())
      editor.querySelector('[data-save]')!.addEventListener('click', async () => {
        const ids = [...editor.querySelectorAll<HTMLInputElement>('input:checked')].map(i => i.value)
        try {
          await api(`/api/tenant/departments/${id}/members`, { method: 'PUT', body: JSON.stringify({ user_ids: ids }) })
          notify('科室成员已更新')
          await render()
          await onMembersChange?.()
        } catch (err) { notify((err as Error).message, true) }
      })
    }))
  }
  await render()
}

async function openTenant(me: Me, api: ApiFn, notify: Notify): Promise<void> {
  const t = await api('/api/tenant')
  const title = t.kind === 'org' ? (t.name ? `机构管理 · ${t.name}` : '机构管理') : (t.name ? `机构与邀请 · ${t.name}` : '机构与邀请')
  const dlg = openDialog(title, `
    <div class="org-tabs" id="tenantTabs">
      <button class="org-tab active" data-tab="overview">${icon('template')} 概览与设置</button>
      ${t.kind === 'org' ? `<button class="org-tab" data-tab="depts">${icon('hospital')} 科室管理</button>` : ''}
      <button class="org-tab" data-tab="members">${icon('users')} 成员与邀请</button>
      <button class="org-tab" data-tab="templates">${icon('template')} 机构模板</button>
      <button class="org-tab" data-tab="audit">${icon('shield')} 安全审计</button>
    </div>

    <!-- Tab 1: Overview & Settings -->
    <div class="org-panel" id="tTabOverview">
      <div class="org-stats-grid" id="tStatsGrid"></div>
      <form id="tenantForm" class="form">
        <label>机构名称<span class="field-row"><input type="text" name="name" value="${esc(t.name)}" maxlength="60" required><button class="primary">保存名称</button></span></label>
      </form>
      ${t.kind === 'personal' ? '<div class="muted">现在是个人账户。邀请同事加入后，这里就成为一个机构：成员的文档、资料仍各自私有；以后的患者数据按机构隔离。</div>' : ''}
      <h3 class="mem-h">患者数据与合规规则</h3>
      <div class="tenant-settings">
        <label class="toggle"><input type="checkbox" data-set="patient_module" ${t.settings.patient_module ? 'checked' : ''}> 启用患者模块</label>
        <label class="toggle"><input type="checkbox" data-set="external_model_for_patients" ${t.settings.external_model_for_patients ? 'checked' : ''}> 患者数据可以交给外部模型分析（只发代号，不发姓名）</label>
        <label class="toggle">AI 修改患者记录 <select data-set="ai_patient_writes"><option value="review"${t.settings.ai_patient_writes !== 'direct' ? ' selected' : ''}>需医生确认（进待确认）</option><option value="direct"${t.settings.ai_patient_writes === 'direct' ? ' selected' : ''}>直接生效（和人一样）</option></select></label>
        ${t.kind === 'org' ? `<label class="toggle"><input type="checkbox" data-set="accept_patient_shares" ${t.settings.accept_patient_shares !== false ? 'checked' : ''}> 接受知家家庭分享（家人可在知家里选本院的科室分享档案）</label>` : ''}
        <label class="toggle">患者默认可见范围 <select data-set="patient_visibility"><option value="care_team"${t.settings.patient_visibility === 'care_team' ? ' selected' : ''}>创建者 + 诊疗组</option><option value="tenant"${t.settings.patient_visibility === 'tenant' ? ' selected' : ''}>本机构全员</option></select></label>
      </div>
    </div>

    <!-- Tab 2: Departments -->
    ${t.kind === 'org' ? `<div class="org-panel" id="tTabDepts" hidden>
      <div id="tenantDepts" class="muted">加载中…</div>
    </div>` : ''}

    <!-- Tab 3: Members & Invites -->
    <div class="org-panel" id="tTabMembers" hidden>
      <div class="member-search-row">
        <input type="search" id="memberSearch" class="member-search-input" placeholder="按姓名、用户名或科室筛选成员..." autocomplete="off">
      </div>
      <div id="tenantMembers" class="muted">加载中…</div>
      <h3 class="mem-h" style="margin-top: 20px">邀请新成员</h3>
      <div class="org-sub-section">
        ${t.kind === 'org' ? `<form class="inline-form" id="inviteUserForm"><input type="text" name="username" placeholder="平台已有账户用户名（如知家注册账户）" required autocomplete="off"><select name="role"><option value="member">普通成员</option><option value="admin">机构管理员</option></select><button class="primary">按用户名邀请</button></form>
        <div class="muted small">已注册用户：对方在头像菜单收到邀请并接受后加入，个人空间（知家）予以保留。</div>` : ''}
        <form class="inline-form" id="inviteForm"><select name="role"><option value="member">普通成员</option><option value="admin">机构管理员</option></select><input type="text" name="email" placeholder="对方邮箱（可选，仅备注）" inputmode="email"><select name="days"><option value="7">7 天内有效</option><option value="1">1 天</option><option value="30">30 天</option></select><button class="primary">生成邀请链接</button></form>
        <div id="inviteLink"></div><div id="inviteList"></div>
      </div>
    </div>

    <!-- Tab 4: Templates -->
    <div class="org-panel" id="tTabTemplates" hidden>
      <div id="orgTemplates" class="muted">加载中…</div>
    </div>

    <!-- Tab 5: Audit -->
    <div class="org-panel" id="tTabAudit" hidden>
      ${AUDIT_HTML}
    </div>`, true)

  const tabs = dlg.querySelectorAll<HTMLButtonElement>('#tenantTabs .org-tab')
  const panels: Record<string, HTMLElement> = {
    overview: dlg.querySelector('#tTabOverview')!,
    depts: dlg.querySelector('#tTabDepts') as HTMLElement,
    members: dlg.querySelector('#tTabMembers')!,
    templates: dlg.querySelector('#tTabTemplates')!,
    audit: dlg.querySelector('#tTabAudit')!,
  }
  tabs.forEach(btn => btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab!
    tabs.forEach(b => b.classList.toggle('active', b === btn))
    Object.entries(panels).forEach(([k, p]) => { if (p) p.hidden = k !== tabName })
  }))

  mountAudit(dlg, '/api/tenant/audit', api, notify)
  const orgBox = dlg.querySelector<HTMLElement>('#orgTemplates')!
  orgBox.classList.remove('muted')
  void mountOrgTemplates(orgBox, api, notify, t.role === 'admin').catch(err => { orgBox.textContent = (err as Error).message })

  let currentMembersList: any[] = []
  let currentInvitesList: any[] = []
  let currentDeptsList: any[] = []

  const updateStats = () => {
    const grid = dlg.querySelector('#tStatsGrid')
    if (!grid) return
    const adminsCount = currentMembersList.filter(m => m.tenant_role === 'admin' && m.status === 'active').length
    grid.innerHTML = `
      <div class="org-stat-card"><span class="org-stat-num">${currentMembersList.length}</span><span class="org-stat-lbl">机构成员 (管理员 ${adminsCount})</span></div>
      ${t.kind === 'org' ? `<div class="org-stat-card"><span class="org-stat-num">${currentDeptsList.length}</span><span class="org-stat-lbl">临床科室</span></div>` : ''}
      <div class="org-stat-card"><span class="org-stat-num">${currentInvitesList.length}</span><span class="org-stat-lbl">待加入邀请</span></div>
      <div class="org-stat-card"><span class="org-stat-num">${t.settings.patient_module ? '已启用' : '未开放'}</span><span class="org-stat-lbl">患者数据模块</span></div>
    `
  }

  const deptBox = dlg.querySelector<HTMLElement>('#tenantDepts')
  if (deptBox) {
    void mountDepartments(deptBox, api, notify, t.role === 'admin', async () => {
      await renderMembers()
    }).catch(err => { deptBox.textContent = (err as Error).message })
  }

  dlg.querySelector<HTMLFormElement>('#tenantForm')!.onsubmit = async e => {
    e.preventDefault()
    const newName = String(new FormData(e.target as HTMLFormElement).get('name') ?? '').trim()
    try {
      await api('/api/tenant', { method: 'PATCH', body: JSON.stringify({ name: newName }) })
      t.name = newName
      const h2 = dlg.querySelector('.dialog-head h2')
      if (h2) h2.textContent = t.kind === 'org' ? `机构管理 · ${newName}` : `机构与邀请 · ${newName}`
      notify('已保存')
    } catch (err) {
      notify((err as Error).message, true)
    }
  }
  dlg.querySelector('.tenant-settings')!.addEventListener('change', async e => {
    e.stopPropagation()
    const el = e.target as HTMLInputElement | HTMLSelectElement
    const key = el.dataset.set
    if (!key) return
    const value = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value
    try { await api('/api/tenant', { method: 'PATCH', body: JSON.stringify({ settings: { [key]: value } }) }); notify('设置已保存') } catch (err) { notify((err as Error).message, true) }
  })

  const renderMembers = async () => {
    currentMembersList = await api('/api/tenant/members')
    if (t.kind === 'org') {
      try { currentDeptsList = await api('/api/tenant/departments') } catch { currentDeptsList = [] }
    }
    updateStats()
    const box = dlg.querySelector('#tenantMembers')!
    box.className = ''
    box.innerHTML = `<table class="users"><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>文档</th><th>最近登录</th><th></th></tr></thead><tbody>
      ${currentMembersList.map(u => `<tr data-mid="${esc(u.id)}" class="${u.status === 'disabled' ? 'disabled' : ''}">
        <td><b>${esc(u.display_name)}</b><div class="muted">${esc(u.username)}${u.id === me.id ? ' · 我' : ''}${u.joined ? ' · 已有账户加入' : ''}</div>
          ${u.departments?.length ? `<div style="margin-top: 4px">${u.departments.map((d: any) => `<span class="member-dept-badge">${esc(d.name)}</span>`).join('')}</div>` : ''}</td>
        <td><select data-mrole><option value="member"${u.tenant_role === 'member' ? ' selected' : ''}>普通成员</option><option value="admin"${u.tenant_role === 'admin' ? ' selected' : ''}>机构管理员</option></select></td>
        <td>${u.status === 'active' ? '<span class="pill ok">正常</span>' : '<span class="pill off">已停用</span>'}</td><td>${u.doc_count}</td><td class="muted">${when(u.last_login_at)}</td>
        <td class="actions">${u.id === me.id ? '' : `<div class="actions-row"><button data-mact="${u.status === 'active' ? 'disable' : 'enable'}">${u.status === 'active' ? '停用' : '启用'}</button>${t.kind === 'org' ? '<button data-mact="remove" class="danger">移出</button>' : ''}</div>`}</td></tr>`).join('')}</tbody></table>`

    const searchInput = dlg.querySelector<HTMLInputElement>('#memberSearch')
    if (searchInput) {
      searchInput.oninput = () => {
        const q = searchInput.value.trim().toLowerCase()
        box.querySelectorAll<HTMLElement>('tbody tr').forEach(tr => {
          const text = tr.innerText.toLowerCase()
          tr.hidden = Boolean(q && !text.includes(q))
        })
      }
    }
  }

  const renderInvites = async () => {
    currentInvitesList = await api('/api/tenant/invites')
    updateStats()
    dlg.querySelector('#inviteList')!.innerHTML = currentInvitesList.length === 0 ? '' : `<table class="users" style="margin-top: 10px"><thead><tr><th>待使用的邀请</th><th>角色</th><th>有效期至</th><th></th></tr></thead><tbody>
      ${currentInvitesList.map(i => `<tr data-code="${esc(i.code)}"><td class="muted">${i.target_username ? `发给用户 <b>${esc(i.target_username)}</b>` : esc(i.email ?? '（未注明）')} · ${when(i.created_at)} 发出</td><td>${i.role === 'admin' ? '机构管理员' : '普通成员'}</td><td class="muted">${when(i.expires_at)}</td>
        <td class="actions"><div class="actions-row">${i.target_username ? '' : '<button data-iact="copy">复制链接</button>'}<button data-iact="revoke" class="danger">撤销</button></div></td></tr>`).join('')}</tbody></table>`
  }

  await Promise.all([renderMembers(), renderInvites()]).catch(err => notify((err as Error).message, true))

  const userForm = dlg.querySelector<HTMLFormElement>('#inviteUserForm')
  if (userForm) userForm.onsubmit = async e => {
    e.preventDefault()
    const f = new FormData(userForm)
    try {
      await api('/api/tenant/invites', { method: 'POST', body: JSON.stringify({ username: String(f.get('username') ?? '').trim(), role: f.get('role') }) })
      notify(`已邀请「${String(f.get('username'))}」，对方登录后接受即加入`); userForm.reset(); await renderInvites()
    } catch (err) { notify((err as Error).message, true) }
  }
  dlg.querySelector<HTMLFormElement>('#inviteForm')!.onsubmit = async e => {
    e.preventDefault()
    const f = new FormData(e.target as HTMLFormElement)
    try {
      const inv = await api('/api/tenant/invites', { method: 'POST', body: JSON.stringify({ role: f.get('role'), email: f.get('email'), days: Number(f.get('days')) }) })
      showLink(dlg.querySelector('#inviteLink')!, inviteLink(inv.code), '把这个链接发给对方，对方用它注册即加入本机构（只能用一次）：', notify)
      await renderInvites()
    } catch (err) { notify((err as Error).message, true) }
  }
  dlg.addEventListener('change', async e => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-mrole]')
    const uid = sel?.closest<HTMLElement>('[data-mid]')?.dataset.mid
    if (!sel || !uid) return
    try { await api(`/api/tenant/members/${uid}`, { method: 'PATCH', body: JSON.stringify({ tenant_role: sel.value }) }); notify('角色已更新') } catch (err) { notify((err as Error).message, true) }
    await renderMembers()
  })
  dlg.addEventListener('click', async e => {
    const t2 = e.target as HTMLElement
    const mact = t2.closest<HTMLElement>('[data-mact]')
    const uid = mact?.closest<HTMLElement>('[data-mid]')?.dataset.mid
    if (mact && uid && mact.dataset.mact === 'remove') {
      mact.dataset.mact = 'remove-confirm'; mact.textContent = '确认移出'
      mact.title = '他回到自己的个人空间（知家不受影响），本院研究成员身份与科室归属会去掉'
      return
    }
    if (mact && uid && mact.dataset.mact === 'remove-confirm') {
      try { await api(`/api/tenant/members/${uid}`, { method: 'DELETE' }); notify('已移出') } catch (err) { notify((err as Error).message, true) }
      await renderMembers()
      return
    }
    if (mact && uid) {
      try {
        await api(`/api/tenant/members/${uid}`, { method: 'PATCH', body: JSON.stringify({ status: mact.dataset.mact === 'disable' ? 'disabled' : 'active' }) })
        notify(mact.dataset.mact === 'disable' ? '已停用，该成员的登录立即失效' : '已启用')
      } catch (err) { notify((err as Error).message, true) }
      await renderMembers()
      return
    }
    const iact = t2.closest<HTMLElement>('[data-iact]')
    const code = iact?.closest<HTMLElement>('[data-code]')?.dataset.code
    if (!iact || !code) return
    if (iact.dataset.iact === 'copy') { await navigator.clipboard.writeText(inviteLink(code)).catch(() => {}); notify('已复制邀请链接'); return }
    try { await api(`/api/tenant/invites/${code}`, { method: 'DELETE' }); notify('已撤销') } catch (err) { notify((err as Error).message, true) }
    await renderInvites()
  })
}
