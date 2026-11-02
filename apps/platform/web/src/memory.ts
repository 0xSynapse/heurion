/**
 * 记忆（R3，参考 Claude 的记忆设计）：记忆页（待确认、已生效、编辑删除、出处、导出导入、暂停 / 清空、整理建议）、
 * 对话里的「记住这条？」卡片、对话框的「本轮不用记忆」。
 */
import { askConfirm, askText } from './dialogs.ts'

type Api = <T = any>(path: string, opts?: RequestInit) => Promise<T>

interface Memory {
  id: string; scope: 'global' | 'project'; project_id: string | null; kind: 'preference' | 'fact' | 'style' | 'term'
  content: string; reason: string | null; source: 'turn' | 'comment' | 'manual' | 'import' | 'review'; source_doc_id: string | null; source_doc_title: string | null
  status: 'proposed' | 'active'; explicit: number; updated_at: string; use_count: number; last_used_at: string | null
}

/** 整理建议：合并 / 改写 / 归档（采纳后才生效）。 */
interface Change {
  id: string; action: 'merge' | 'update' | 'archive'; content: string | null; reason: string
  targets: Array<{ id: string; kind: Memory['kind']; content: string }>
}

interface HarnessRuleVersion {
  id: string
  rule_id: string
  trigger_pattern: string
  rule: string
  reason?: string | null
  created_at: string
}

interface HarnessRule {
  id: string; scope: 'global' | 'user' | 'project'; owner: string; category: 'guard' | 'tool' | 'subagent' | 'format'
  trigger_pattern: string; rule: string; evidence_count: number; evidence_refs?: string
  hit_count?: number; success_count?: number; status: 'pending' | 'active' | 'archived'; updated_at: string
  versions?: HarnessRuleVersion[]
}
type ProceduralRule = HarnessRule

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const KINDS: Record<Memory['kind'], string> = { preference: '偏好', fact: '事实', style: '写法', term: '术语' }
const SOURCE: Record<Memory['source'], string> = { turn: '对话', comment: '评论', manual: '手动添加', import: '导入', review: '整理记忆' }
const ACTION: Record<Change['action'], string> = { merge: '合并', update: '改写', archive: '归档' }
const RULE_CAT: Record<ProceduralRule['category'], string> = { guard: '守卫避坑', tool: '工具规范', subagent: '专家分工', format: '格式策略' }

/** 「用过 3 次 · 2 天前」 */
function usage(m: Memory): string {
  if (!m.use_count) return '还没用到'
  const d = m.last_used_at ? Math.floor((Date.now() - Date.parse(m.last_used_at)) / 86_400_000) : null
  return `用过 ${m.use_count} 次${d === null ? '' : d === 0 ? ' · 今天' : ` · ${d} 天前`}`
}

export function initMemory(api: Api, notice: (msg: string, error?: boolean) => void, openDoc: (id: string) => void) {
  const dlg = () => document.getElementById('dialog')!

  async function openMemory(): Promise<void> {
    const [data, projects] = await Promise.all([
      api<{ enabled: boolean; instance: boolean; paused: boolean; items: Memory[]; changes?: Change[]; procedural_rules?: ProceduralRule[]; review?: { available: boolean; last: string | null } }>('/api/memory'),
      api<Array<{ id: string; name: string }>>('/api/projects'),
    ])
    const changes = data.changes ?? []
    const rules = data.procedural_rules ?? []
    const userRulesCount = rules.filter(r => r.owner !== 'system').length
    const projectName = (id: string | null) => projects.find(p => p.id === id)?.name ?? '项目'
    const proposed = data.items.filter(m => m.status === 'proposed')
    const active = data.items.filter(m => m.status === 'active')
    const origin = (m: Memory) => [
      m.scope === 'project' ? `<span class="pill">${esc(projectName(m.project_id))}</span>` : '<span class="pill">全局</span>',
      `来自${SOURCE[m.source]}`,
      m.source_doc_id ? `<a href="#" data-doc="${esc(m.source_doc_id)}">《${esc(m.source_doc_title ?? '已删除的文档')}》</a>` : '',
    ].filter(Boolean).join(' · ')
    const row = (m: Memory) => `<li class="mem" data-id="${m.id}">
        <div class="mem-text"><span class="mem-kind">${KINDS[m.kind]}</span>${esc(m.content)}</div>
        <div class="muted small">${origin(m)}${m.status === 'active' ? ` · ${usage(m)}` : ''}${m.reason ? ` · ${esc(m.reason)}` : ''}</div>
        <div class="actions-row">${m.status === 'proposed'
          ? '<button class="primary" data-act="accept">采纳</button><button data-act="edit">改写</button><button data-act="reject">拒绝</button>'
          : '<button data-act="edit">编辑</button><button data-act="history">历史</button><button data-act="delete" class="danger">删除</button>'}</div></li>`

    function changeRow(c: Change): string {
      const before = c.targets.map(t => `<div class="mem-text mem-old"><span class="mem-kind">${KINDS[t.kind]}</span>${esc(t.content)}</div>`).join('')
      const after = c.action === 'archive' ? '<div class="muted small">→ 归档（不再使用，可在历史里查到）</div>' : `<div class="mem-text mem-new">→ ${esc(c.content)}</div>`
      return `<li class="mem mem-change" data-change="${c.id}">
        <div class="muted small"><span class="pill">${ACTION[c.action]}</span> ${esc(c.reason)}</div>${before}${after}
        <div class="actions-row"><button class="primary" data-cact="apply">采纳</button><button data-cact="dismiss">忽略</button></div></li>`
    }

    function ruleRow(r: HarnessRule): string {
      const isSystem = r.owner === 'system'
      const statusBadge = r.status === 'pending'
        ? '<span class="badge">⏳ 观察验证中 (Pending)</span>'
        : '<span class="badge ok">✅ 已生效</span>'
      const pendingHint = r.status === 'pending'
        ? ' · 待跨回合验证后生效'
        : ''
      const reliability = (r.hit_count ?? 0) > 0
        ? ` · 实战调用 ${r.hit_count} 次 · 有效率 ${Math.round(((r.success_count ?? 0) / r.hit_count!) * 100)}% (${r.success_count ?? 0}/${r.hit_count})`
        : ''
      const hasVersions = Boolean(r.versions && r.versions.length > 0)
      const versionDetails = hasVersions
        ? `<details class="muted small" style="margin-top: 4px"><summary style="cursor: pointer">历史演化版本（${r.versions!.length}）</summary><ol class="mem-history muted small">${r.versions!.map(v => `<li><div>${esc(new Date(v.created_at).toLocaleString('zh-CN', { hour12: false }))}${v.reason ? ` · ${esc(v.reason)}` : ''} · 触发特征：<code>${esc(v.trigger_pattern)}</code></div><div>${esc(v.rule)} <button data-ract="rollback" data-ver="${esc(v.id)}">回退到此版</button></div></li>`).join('')}</ol></details>`
        : ''
      const rollbackQuickBtn = hasVersions ? '<button data-ract="rollback">回退上一版</button>' : ''
      return `<li class="mem" data-rule="${esc(r.id)}">
        <div class="mem-text"><span class="mem-kind">${esc(RULE_CAT[r.category] ?? r.category)}</span>${statusBadge} ${esc(r.rule)}</div>
        <div class="muted small"><span class="pill">${isSystem ? '系统基线' : '自动习得'}</span> 触发特征：<code>${esc(r.trigger_pattern)}</code> · 累计验证 ${r.evidence_count} 次${reliability}${pendingHint}</div>
        ${versionDetails}
        ${isSystem ? '' : `<div class="actions-row">${rollbackQuickBtn}<button data-ract="delete" class="danger">移除此经验</button></div>`}
      </li>`
    }

    const d = dlg()
    d.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-label="记忆">
      <div class="dialog-head"><h2>记忆</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <div class="dialog-body">
        <div class="muted">AI 会记住你确认过的写作偏好、术语和常用事实，在之后的对话里照做。不会记住患者信息或账号。</div>
        ${!data.instance ? '<div class="mem-banner">管理员已停用记忆。</div>' : `<div class="row">
          <label class="toggle"><input type="checkbox" id="memOn" ${data.paused ? '' : 'checked'}> 使用记忆</label>
          <span class="muted small">${data.paused ? '已暂停：保留已有记忆，但对话里不使用、也不提议新的。' : ''}</span>
          <span class="grow"></span>${data.review?.available && data.enabled ? '<button id="memReview" title="根据你最近对 AI 文字的修改、拒绝的修订和对话，总结新的写作习惯，并整理重复、过时、不用的记忆。结果都要你采纳。">整理记忆</button>' : ''}<button id="memAdd">＋ 添加</button></div>`}
        ${data.review?.last ? `<div class="muted small">上次整理：${new Date(data.review.last).toLocaleString('zh-CN', { hour12: false })}</div>` : ''}
        ${changes.length ? `<h3 class="mem-h">整理建议（${changes.length}）</h3><ul class="mem-list">${changes.map(changeRow).join('')}</ul>` : ''}
        ${proposed.length ? `<h3 class="mem-h">待确认（${proposed.length}）</h3><ul class="mem-list">${proposed.map(row).join('')}</ul>` : ''}
        <h3 class="mem-h">已生效（${active.length}）</h3>
        ${active.length ? `<ul class="mem-list">${active.map(row).join('')}</ul>` : '<div class="muted">还没有记忆。对话里说「记住……」，或点「＋ 添加」。</div>'}
        ${rules.length ? `<details style="margin-top: 16px"><summary class="muted small" style="cursor: pointer">AI 自适应执行经验（共 ${rules.length} 条${userRulesCount ? ` · 含个人自动习得 ${userRulesCount} 条` : ''}）</summary>
          <div class="muted small" style="margin: 6px 0">根据文档编辑冲突、引用拦截与撤销历史自动沉淀的执行与避坑策略，无需手动审批。</div>
          <ul class="mem-list">${rules.map(ruleRow).join('')}</ul></details>` : ''}
        <div class="row mem-foot"><button id="memExport">导出</button><button id="memImport">导入</button><input id="memImportFile" type="file" accept=".json,application/json" hidden>
          <span class="grow"></span><button id="memClear" class="danger">清空全部记忆</button></div>
      </div></div>`
    d.hidden = false

    const reopen = () => void openMemory()
    const on = d.querySelector<HTMLInputElement>('#memOn')
    if (on) on.onchange = async () => { await api('/api/memory/settings', { method: 'PUT', body: JSON.stringify({ paused: !on.checked }) }); notice(on.checked ? '已恢复使用记忆' : '已暂停记忆'); reopen() }
    const review = d.querySelector<HTMLButtonElement>('#memReview')
    if (review) review.onclick = async () => {
      review.disabled = true
      review.textContent = '整理中…'
      try {
        const r = await api<{ proposed: number; changes: number; signals: number; messages: number }>('/api/memory/review', { method: 'POST' })
        notice(r.proposed + r.changes ? `整理完成：${r.proposed} 条新记忆待确认，${r.changes} 条整理建议` : `看了 ${r.signals} 处修改、${r.messages} 条对话，没有需要整理的地方`)
      } catch (err) { notice((err as Error).message, true) }
      reopen()
    }
    const add = d.querySelector<HTMLButtonElement>('#memAdd')
    if (add) add.onclick = async () => {
      const content = await askText({ title: '添加记忆', label: '一条偏好、写法、术语或事实', placeholder: '例如：数值保留两位小数', confirm: '添加', hint: '写成以后可以直接照做的规则；不要写患者信息。' })
      if (content?.trim()) await api('/api/memory', { method: 'POST', body: JSON.stringify({ content, kind: 'preference' }) }).then(() => notice('已添加'), err => notice((err as Error).message, true))
      reopen()
    }
    d.querySelector<HTMLButtonElement>('#memExport')!.onclick = async () => {
      const text = await api<string | object>('/api/memory-export')
      const blob = new Blob([typeof text === 'string' ? text : JSON.stringify(text, null, 2)], { type: 'application/json' })
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'heurion-memory.json' })
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    }
    const file = d.querySelector<HTMLInputElement>('#memImportFile')!
    d.querySelector<HTMLButtonElement>('#memImport')!.onclick = () => file.click()
    file.onchange = async () => {
      const f = file.files?.[0]
      if (!f) return
      try {
        const r = await api<{ added: number; skipped: Array<{ reason: string }> }>('/api/memory-import', { method: 'POST', body: await f.text() })
        notice(`导入 ${r.added} 条到「待确认」${r.skipped.length ? `，跳过 ${r.skipped.length} 条` : ''}`)
      } catch (err) { notice(`导入失败：${(err as Error).message}`, true) }
      reopen()
    }
    d.querySelector<HTMLButtonElement>('#memClear')!.onclick = async () => {
      d.hidden = true
      if (await askConfirm({ title: '清空全部记忆', message: '彻底删除你的所有记忆（包括待确认的），不可恢复。', confirm: '清空', danger: true })) {
        const r = await api<{ deleted: number }>('/api/memory', { method: 'DELETE' })
        notice(`已删除 ${r.deleted} 条记忆`)
      }
      reopen()
    }
    d.onclick = async e => {
      const t = e.target as HTMLElement
      if (t === d || t.closest('[data-close]')) { d.hidden = true; d.innerHTML = ''; return }
      const link = t.closest<HTMLElement>('[data-doc]')
      if (link) { e.preventDefault(); d.hidden = true; openDoc(link.dataset.doc!); return }
      const cact = t.closest<HTMLElement>('[data-cact]')?.dataset.cact
      const change = t.closest<HTMLElement>('li[data-change]')?.dataset.change
      if (cact && change) {
        try {
          await api(`/api/memory/changes/${change}/${cact}`, { method: 'POST' })
          notice(cact === 'apply' ? '已采纳' : '已忽略，不会再提这条')
        } catch (err) { notice((err as Error).message, true) }
        reopen()
        return
      }
      const ract = t.closest<HTMLElement>('[data-ract]')?.dataset.ract
      const ruleId = t.closest<HTMLElement>('li[data-rule]')?.dataset.rule
      if (ract === 'delete' && ruleId) {
        try {
          await api(`/api/memory/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' })
          notice('已移除该条自适应经验')
        } catch (err) { notice((err as Error).message, true) }
        reopen()
        return
      }
      if (ract === 'rollback' && ruleId) {
        const verId = t.closest<HTMLElement>('[data-ver]')?.dataset.ver
        try {
          await api(`/api/memory/rules/${encodeURIComponent(ruleId)}/rollback`, {
            method: 'POST',
            body: JSON.stringify(verId ? { version_id: verId } : {}),
          })
          notice('已回退至历史版本')
        } catch (err) { notice((err as Error).message, true) }
        reopen()
        return
      }
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act
      const m = data.items.find(x => x.id === t.closest<HTMLElement>('li[data-id]')?.dataset.id)
      if (!act || !m) return
      if (act === 'delete') {
        d.hidden = true
        if (await askConfirm({ title: '删除记忆', message: `删除「${m.content}」？之后的对话不再使用它。`, confirm: '删除', danger: true })) await api(`/api/memory/${m.id}`, { method: 'DELETE' })
        reopen()
        return
      }
      const li = t.closest<HTMLElement>('li[data-id]')!
      if (act === 'history') {
        const events = await api<Array<{ action: string; actor: string; before: string | null; after: string | null; at: string }>>(`/api/memory/${m.id}/events`)
        const ACTION: Record<string, string> = { create: '创建', edit: '修改', active: '采纳', rejected: '拒绝', archived: '归档', activate: '生效' }
        const WHO: Record<string, string> = { user: '你', ai: 'AI', system: '系统' }
        li.querySelector('.mem-history')?.remove()
        li.insertAdjacentHTML('beforeend', `<ol class="mem-history muted small">${events.map(ev => {
          const after = ev.after ? (() => { try { return JSON.parse(ev.after!).content as string } catch { return '' } })() : ''
          return `<li>${new Date(ev.at).toLocaleString('zh-CN', { hour12: false })} · ${WHO[ev.actor] ?? ev.actor}${ACTION[ev.action] ?? ev.action}${after && ev.action !== 'create' ? `：${esc(after)}` : ''}</li>`
        }).join('')}</ol>`)
        return
      }
      if (act === 'edit') {
        // 就地编辑：内容、种类、范围（全局 / 某个项目）
        li.innerHTML = `<form class="mem-edit">
          <textarea name="content" rows="2">${esc(m.content)}</textarea>
          <div class="row"><select name="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === m.kind ? ' selected' : ''}>${v}</option>`).join('')}</select>
            <select name="scope"><option value="">全局</option>${projects.map(p => `<option value="${esc(p.id)}"${m.scope === 'project' && m.project_id === p.id ? ' selected' : ''}>项目：${esc(p.name)}</option>`).join('')}</select>
            <span class="grow"></span><button type="button" data-act="cancel">取消</button><button class="primary">${m.status === 'proposed' ? '保存并采纳' : '保存'}</button></div></form>`
        const form = li.querySelector<HTMLFormElement>('form')!
        form.querySelector<HTMLTextAreaElement>('textarea')!.focus()
        form.onsubmit = async ev => {
          ev.preventDefault()
          const fd = new FormData(form)
          const scope = String(fd.get('scope') ?? '')
          try {
            await api(`/api/memory/${m.id}`, { method: 'PATCH', body: JSON.stringify({ content: String(fd.get('content') ?? ''), kind: fd.get('kind'), scope: scope ? 'project' : 'global', project_id: scope || null, status: 'active' }) })
            notice('已保存')
            reopen()
          } catch (err) { notice((err as Error).message, true) }
        }
        return
      }
      if (act === 'cancel') { reopen(); return }
      await api(`/api/memory/${m.id}`, { method: 'PATCH', body: JSON.stringify({ status: act === 'accept' ? 'active' : 'rejected' }) })
      notice(act === 'accept' ? '已记住' : '已拒绝，不会再提议这条')
      reopen()
    }
  }

  /** 对话里 AI 提议（或按用户要求记下）一条记忆时的卡片。 */
  function memoryCard(ev: { result: 'proposed' | 'active' | 'forgotten'; memory: Memory }): HTMLElement {
    const m = ev.memory
    const card = document.createElement('div')
    card.className = 'mem-card'
    const done = (text: string) => { card.querySelector('.actions-row')!.outerHTML = `<div class="muted small">${esc(text)}</div>` }
    card.innerHTML = ev.result === 'forgotten'
      ? `<div class="mem-card-head">已忘记</div><div class="mem-text"><span class="mem-kind">${KINDS[m.kind]}</span><s>${esc(m.content)}</s></div>
         <div class="actions-row"><button data-act="restore">撤销</button></div>`
      : ev.result === 'active'
      ? `<div class="mem-card-head">已记住</div><div class="mem-text"><span class="mem-kind">${KINDS[m.kind]}</span>${esc(m.content)}</div>
         <div class="actions-row"><button data-act="undo">撤销</button><button data-act="manage">管理记忆</button></div>`
      : `<div class="mem-card-head">记住这条？</div><div class="mem-text"><span class="mem-kind">${KINDS[m.kind]}</span>${esc(m.content)}</div>
         ${m.reason ? `<div class="muted small">${esc(m.reason)}</div>` : ''}
         <div class="actions-row"><button class="primary" data-act="accept">记住</button><button data-act="edit">改写</button><button data-act="reject">不用</button></div>`
    card.onclick = async e => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
      if (!act) return
      try {
        if (act === 'manage') { void openMemory(); return }
        if (act === 'restore') {
          await api('/api/memory', { method: 'POST', body: JSON.stringify({ content: m.content, kind: m.kind, scope: m.scope, project_id: m.project_id }) })
          done('已恢复这条记忆')
          return
        }
        if (act === 'undo') { await api(`/api/memory/${m.id}`, { method: 'DELETE' }); done('已撤销，不会记住这条'); return }
        if (act === 'edit') {
          const content = await askText({ title: '改写后记住', label: KINDS[m.kind], value: m.content, confirm: '记住' })
          if (!content?.trim()) return
          await api(`/api/memory/${m.id}`, { method: 'PATCH', body: JSON.stringify({ content, status: 'active' }) })
          done(`已记住：${content.trim()}`)
          return
        }
        await api(`/api/memory/${m.id}`, { method: 'PATCH', body: JSON.stringify({ status: act === 'accept' ? 'active' : 'rejected' }) })
        done(act === 'accept' ? '已记住，之后的对话会照做' : '好的，不记这条')
      } catch (err) { notice((err as Error).message, true) }
    }
    return card
  }

  document.getElementById('userMenuMemory')!.onclick = () => { document.getElementById('userMenu')!.hidden = true; void openMemory() }

  return {
    openMemory,
    memoryCard,
    /** 本轮是否使用记忆（对话框里的开关；发送后恢复默认）。 */
    takeMemoryFlag(): boolean {
      const box = document.getElementById('noMemory') as HTMLInputElement
      const off = box.checked
      box.checked = false
      return !off
    },
  }
}
