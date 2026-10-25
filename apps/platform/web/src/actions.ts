/**
 * AI 发起、等你确认的高风险操作（docs/design/AI_PERMISSIONS.md）：AI 拥有你的权限，但不可恢复的删除、
 * 机构设置与成员权限、邀请、紧急访问、交接、平台运营、上传院徽这类操作，要你在确认卡上点「确认执行」才会做。
 * - 对话里：AI 发起时出现确认卡；
 * - 全局：头像上的红点 + 菜单「待确认操作」，列出所有还没处理的。
 */
type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notice = (message: string, error?: boolean) => void

export interface Action {
  id: string; tool: string; action: string; summary: string; reason: string | null
  editable: Record<string, string> | null; status: string; created_at: string; expires_at?: string
  result?: { status: number; ok: boolean; response: unknown } | null
}

export interface AegisEscalation {
  id: string
  grant_id: string
  user_id: string
  agent_id: string
  tool: string
  action: string
  scope: string
  resource: string
  summary: string
  reason: string | null
  action_id: string | null
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  created_at: string
  decided_at: string | null
  decided_by: string | null
}

export interface AegisLease {
  id: string
  grant_id: string
  user_id: string
  agent_id: string
  scope: string
  resource: string
  escalation_id: string | null
  created_at: string
  expires_at: string
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const FIELD: Record<string, string> = { reason: '理由' }
const STATUS: Record<string, string> = { done: '已执行', failed: '执行失败', rejected: '已拒绝', expired: '已过期（超过 24 小时）', running: '执行中…' }
// 删除、停用、紧急访问、清空这类操作用红色确认按钮
const DANGER = /delete|purge|clear|break_glass|set_member|set_tenant_status|update_user|logout|handover|transfer|update_settings/

export function initActions(api: Api, notice: Notice) {
  const $ = (id: string) => document.getElementById(id)!

  function resultText(a: Action): string {
    if (a.status === 'failed') {
      const r = a.result?.response as { error?: string } | string | null | undefined
      return `执行失败：${typeof r === 'string' ? r : r?.error ?? `（${a.result?.status}）`}`
    }
    return STATUS[a.status] ?? ''
  }

  /** 一张确认卡（对话里与全局列表共用）。 */
  function card(a: Action, onDone?: () => void): HTMLElement {
    const el = document.createElement('div')
    el.className = `action-card${DANGER.test(a.action) ? ' danger' : ''}`
    el.dataset.action = a.id
    const fields = Object.entries(a.editable ?? {})
    const render = (x: Action) => {
      const pending = x.status === 'pending'
      el.innerHTML = `<div class="action-card-head">AI 请你确认</div>
        <div class="action-summary">${esc(x.summary)}</div>
        ${x.reason ? `<div class="action-reason"><span class="muted">AI 的理由：</span>${esc(x.reason)}</div>` : ''}
        ${pending && fields.length ? fields.map(([k, v]) => `<label class="action-field">${esc(FIELD[k] ?? k)}<textarea data-field="${esc(k)}" rows="2">${esc(v)}</textarea></label>`).join('') : ''}
        ${pending
          ? `<div class="actions-row"><button class="${DANGER.test(x.action) ? 'danger-solid' : 'primary'}" data-act="confirm">确认执行</button><button data-act="reject">拒绝</button>
             <span class="muted small">以你的名义执行，记入审计；24 小时内有效</span></div>`
          : `<div class="action-status ${x.status}">${esc(resultText(x))}</div>`}`
    }
    render(a)
    el.onclick = async e => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (act !== 'confirm' && act !== 'reject') return
      const btns = el.querySelectorAll<HTMLButtonElement>('button')
      btns.forEach(b => { b.disabled = true })
      const values: Record<string, string> = {}
      el.querySelectorAll<HTMLTextAreaElement>('[data-field]').forEach(t => { values[t.dataset.field!] = t.value })
      try {
        const r = await api<Action>(`/api/actions/${a.id}/${act}`, { method: 'POST', body: JSON.stringify({ fields: values }) })
        render(r)
        notice(act === 'reject' ? '已拒绝，AI 不会执行这项操作' : r.status === 'done' ? '已执行' : resultText(r), r.status === 'failed')
      } catch (err) {
        // 422：执行了但接口报错（例如理由太短）——取最新状态显示
        try { render(await api<Action>(`/api/actions/${a.id}`)) } catch { /* 忽略 */ }
        notice((err as Error).message, true)
      }
      onDone?.()
      void refreshBadge()
    }
    return el
  }

  /** Aegis-OS [Lease-Gated] 提权租约审批卡片 */
  function escalationCard(x: AegisEscalation, onDone?: () => void): HTMLElement {
    const el = document.createElement('div')
    el.className = `action-card${DANGER.test(x.action) ? ' danger' : ''}`
    el.dataset.escalation = x.id
    const render = (cur: AegisEscalation, leaseId?: string) => {
      const pending = cur.status === 'pending'
      const statusLabel =
        cur.status === 'approved'
          ? `已批准短期租约${leaseId ? ` (${leaseId})` : ''}`
          : cur.status === 'rejected'
          ? '已拒绝提权申请'
          : cur.status
      el.innerHTML = `<div class="action-card-head">Aegis-OS 智能体请求短期租约 [Lease-Gated]</div>
        <div class="action-summary">${esc(cur.summary)}</div>
        <div class="muted small" style="margin:4px 0">Agent: <code>${esc(cur.agent_id)}</code> · Scope: <code>${esc(cur.scope)}</code> · ID: <code>${esc(cur.id)}</code></div>
        ${cur.reason ? `<div class="action-reason"><span class="muted">申请理由：</span>${esc(cur.reason)}</div>` : ''}
        ${pending
          ? `<div class="actions-row"><button class="${DANGER.test(cur.action) ? 'danger-solid' : 'primary'}" data-eact="approve">批准租约 (15分钟)</button><button data-eact="reject">拒绝</button>
             <span class="muted small">批准后将签发 15 分钟同类操作租约并记入审计</span></div>`
          : `<div class="action-status ${cur.status === 'approved' ? 'done' : cur.status}">${esc(statusLabel)}</div>`}`
    }
    render(x)
    el.onclick = async e => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-eact]')?.dataset.eact
      if (act !== 'approve' && act !== 'reject') return
      const btns = el.querySelectorAll<HTMLButtonElement>('button')
      btns.forEach(b => { b.disabled = true })
      try {
        if (act === 'approve') {
          const r = await api<{ escalation: AegisEscalation; lease: AegisLease }>('/api/aegis/leases/approve', {
            method: 'POST',
            body: JSON.stringify({ escalation_id: x.id, ttl_secs: 900 }),
          })
          render(r.escalation, r.lease?.id)
          notice(`已批准 Aegis 短期租约 (${r.lease.id})`)
        } else {
          const r = await api<{ escalation: AegisEscalation }>('/api/aegis/leases/reject', {
            method: 'POST',
            body: JSON.stringify({ escalation_id: x.id }),
          })
          render(r.escalation)
          notice('已拒绝该 Aegis 提权申请')
        }
      } catch (err) {
        notice((err as Error).message, true)
      }
      onDone?.()
      void refreshBadge()
    }
    return el
  }

  async function refreshBadge(): Promise<void> {
    try {
      const [actions, aegis] = await Promise.all([
        api<Action[]>('/api/actions?status=pending').catch(() => [] as Action[]),
        api<{ escalations: AegisEscalation[] }>('/api/aegis/leases/escalations?status=pending').catch(() => ({ escalations: [] as AegisEscalation[] })),
      ])
      const linkedActionIds = new Set((aegis.escalations ?? []).map(e => e.action_id).filter(Boolean))
      const standaloneActions = actions.filter(a => !linkedActionIds.has(a.id))
      const n = standaloneActions.length + (aegis.escalations?.length ?? 0)
      $('userButton').classList.toggle('has-pending', n > 0)
      $('userMenuActions').textContent = n > 0 ? `待确认操作（${n}）` : '待确认操作'
    } catch { /* 未登录 */ }
  }

  async function openList(): Promise<void> {
    const dlg = $('dialog')
    const render = async () => {
      const [list, aegis] = await Promise.all([
        api<Action[]>('/api/actions'),
        api<{ escalations: AegisEscalation[]; active_leases: AegisLease[] }>('/api/aegis/leases/escalations').catch(() => ({
          escalations: [] as AegisEscalation[],
          active_leases: [] as AegisLease[],
        })),
      ])
      const pendingEscalations = (aegis.escalations ?? []).filter(e => e.status === 'pending')
      const activeLeases = aegis.active_leases ?? []
      const pending = list.filter(a => a.status === 'pending')
      const recent = list.filter(a => a.status !== 'pending').slice(0, 10)
      dlg.innerHTML = `<div class="dialog-card small" role="dialog" aria-modal="true" aria-label="待确认操作">
        <div class="dialog-head"><h2>待确认操作与 Aegis 租约</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
        <div class="dialog-body"><p class="muted small">AI 与 Aegis-OS 智能体拥有你的权限；不可恢复、对外发信或影响权限的操作需由你确认或授予短期租约后才执行。</p>
          <div id="escalationList"></div>
          <div id="actionList"></div>${pending.length === 0 && pendingEscalations.length === 0 ? '<div class="muted">没有待确认的操作或租约申请</div>' : ''}
          ${activeLeases.length ? `<h3 class="mem-h">生效中的 Aegis 短期租约</h3><ul class="action-recent">${activeLeases.map(l => `<li><span><code>${esc(l.agent_id)}</code> · <code>${esc(l.scope)}</code></span><span class="muted small">有效至 ${new Date(l.expires_at).toLocaleTimeString('zh-CN', { hour12: false })}</span></li>`).join('')}</ul>` : ''}
          ${recent.length ? `<h3 class="mem-h">最近处理</h3><ul class="action-recent">${recent.map(a => `<li><span>${esc(a.summary)}</span><span class="action-status ${a.status}">${esc(resultText(a))}</span></li>`).join('')}</ul>` : ''}
        </div></div>`
      const escBox = dlg.querySelector('#escalationList')!
      for (const e of pendingEscalations) escBox.appendChild(escalationCard(e))
      const box = dlg.querySelector('#actionList')!
      // 处理后卡片原地显示结果（不立刻刷新列表，便于看清执行结果）
      for (const a of pending) box.appendChild(card(a))
    }
    dlg.hidden = false
    dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) { dlg.hidden = true; dlg.innerHTML = '' } }
    try { await render() } catch (err) { notice((err as Error).message, true) }
  }

  $('userMenuActions').onclick = () => { $('userMenu').hidden = true; void openList() }
  // 登录后由 main.ts 调 refreshBadge；之后每分钟刷新（登录页上不请求，免得 401）
  window.setInterval(() => { if (document.getElementById('authScreen')?.hidden !== false) void refreshBadge() }, 60_000)

  return {
    /** 对话里 AI 发起高风险操作时的确认卡 */
    card: (a: Action) => { void refreshBadge(); return card(a) },
    refreshBadge,
    openList,
  }
}
