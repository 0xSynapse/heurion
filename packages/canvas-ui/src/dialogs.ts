/**
 * 页内对话框：替代浏览器原生 prompt / confirm（样式统一、不阻塞页面、可用键盘：回车确定、Esc 取消）。
 */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

function show(html: string, onClose: () => void): HTMLElement {
  const dlg = document.getElementById('dialog')!
  dlg.innerHTML = html
  dlg.hidden = false
  const close = () => {
    dlg.hidden = true
    dlg.innerHTML = ''
    document.removeEventListener('keydown', onKey)
    onClose()
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) close() }
  return dlg
}

/** 输入一行文字；取消返回 null。 */
export function askText(opts: { title: string; label?: string; value?: string; placeholder?: string; confirm?: string; hint?: string }): Promise<string | null> {
  return new Promise(resolve => {
    let result: string | null = null
    const dlg = show(`<div class="dialog-card small" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
      <div class="dialog-head"><h2>${esc(opts.title)}</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <form class="dialog-body form" id="askForm">
        <label>${esc(opts.label ?? '')}<input type="text" name="v" value="${esc(opts.value ?? '')}" placeholder="${esc(opts.placeholder ?? '')}" autocomplete="off"></label>
        ${opts.hint ? `<div class="muted">${esc(opts.hint)}</div>` : ''}
        <div class="row end"><button type="button" data-close>取消</button><button class="primary">${esc(opts.confirm ?? '确定')}</button></div>
      </form></div>`, () => resolve(result))
    const input = dlg.querySelector<HTMLInputElement>('input[name="v"]')!
    input.focus()
    input.select()
    dlg.querySelector<HTMLFormElement>('#askForm')!.onsubmit = e => {
      e.preventDefault()
      result = input.value
      ;(dlg.querySelector('[data-close]') as HTMLElement).click()
    }
  })
}

/** 确认一个操作；danger 时确定按钮标红。 */
export function askConfirm(opts: { title: string; message: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise(resolve => {
    let result = false
    const dlg = show(`<div class="dialog-card small" role="alertdialog" aria-modal="true" aria-label="${esc(opts.title)}">
      <div class="dialog-head"><h2>${esc(opts.title)}</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
      <div class="dialog-body"><p class="dialog-message">${esc(opts.message)}</p>
        <div class="row end"><button data-close>取消</button><button class="${opts.danger ? 'danger' : 'primary'}" id="askOk">${esc(opts.confirm ?? '确定')}</button></div>
      </div></div>`, () => resolve(result))
    const ok = dlg.querySelector<HTMLButtonElement>('#askOk')!
    ok.focus()
    ok.onclick = () => { result = true; (dlg.querySelector('[data-close]') as HTMLElement).click() }
  })
}
