/**
 * 幻灯片模板选择器与加页的版式菜单。预览图按 /api/deck-templates 的版式几何、装饰、配色用 SVG 画（不需要图片资源），
 * 与画布、导出看到的版面一致。选模板 = 新建 deck 的 template / 已有 deck 的 apply_theme；选版式 = add_slide 的 layout，
 * 与 AI 的 deck_templates、deck_edit 同一套。
 */

interface Ph { role: string; type: string; box: [number, number, number, number]; size: number; bold: boolean; color: string; align: 'l' | 'ctr' }
export interface TplDeco { box: [number, number, number, number]; fill: string; geom: string; image?: string; text?: { value: string; size: number; color: string; align: 'l' | 'r' }; href?: string }
export interface Layout { key: string; name: string; hint: string; placeholders: Ph[]; decorations: TplDeco[] }
export interface Template {
  key: string; label: string; description: string; tags: string[]; bg: string; body: string; muted: string; serif?: boolean; layouts: Layout[]
  surface?: string; soft?: string; title?: string; accent?: string; accent2?: string
  photo?: string; credit?: { photographer: string; photo_url: string } | null
  /** 本机构模板（院徽、机构名称） */
  org?: boolean; org_name?: string; base?: string
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

let cache: Template[] | null = null
export async function loadTemplates(api: (path: string) => Promise<any>): Promise<Template[]> {
  cache ??= await api('/api/deck-templates')
  return cache!
}
/** 机构模板改动后重新拉清单。 */
export function invalidateTemplates(): void { cache = null }

/** 图片装饰的地址：带图模板的内置照片走 /theme-photos；机构院徽走 /api/assets（带令牌，只给本机构成员）。 */
function decoHref(d: TplDeco): string {
  if (d.href) return d.href
  if (d.image?.startsWith('ol_')) {
    let token = ''
    try { token = localStorage.getItem('heurion.token') ?? '' } catch { /* 无痕模式 */ }
    return `/api/assets/${encodeURIComponent(d.image)}?token=${encodeURIComponent(token)}`
  }
  return `/theme-photos/${d.image}.jpg`
}

/** 预览里的示例文字（按版式与角色）。 */
const SAMPLE: Record<string, Record<string, string>> = {
  cover: { 标题: '临床研究进展', 副标题: '汇报人 · 2026 年 10 月' },
  section: { 标题: '第一部分', 说明: '研究背景与目的' },
  content: { 标题: '研究设计' },
  two_col: { 标题: '两组对比' },
  image_text: { 标题: '典型病例' },
  big_number: { 标题: '主要终点', 数字: '87%', 说明: '客观缓解率' },
  closing: { 标题: '谢谢', 联系方式: '欢迎提问与交流' },
}

/** 一个版式的 SVG 预览（viewBox 即 960×540pt 的页面）。 */
export function layoutSvg(t: Template, layoutKey: string): string {
  const l = t.layouts.find(x => x.key === layoutKey)
  if (!l) return ''
  const font = t.serif ? `'Songti SC','STSong','SimSun',serif` : `'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif`
  const parts = [`<rect width="960" height="540" fill="#${t.bg}"/>`]
  for (const d of l.decorations) {
    const [x, y, w, h] = d.box
    // 带图模板的照片（内置、公开）：按框裁切铺满；机构院徽：按原比例放进框里
    if (d.image || d.href) { parts.push(`<image href="${esc(decoHref(d))}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="${d.image?.startsWith('tp_') ? 'xMidYMid slice' : 'xMidYMid meet'}"/>`); continue }
    // 文字装饰（机构名称）
    if (d.text) { parts.push(`<text x="${d.text.align === 'r' ? x + w : x}" y="${y + d.text.size * 1.2}" font-size="${d.text.size}" fill="#${d.text.color}" text-anchor="${d.text.align === 'r' ? 'end' : 'start'}" font-family="${font}">${esc(d.text.value)}</text>`); continue }
    parts.push(d.geom === 'ellipse'
      ? `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#${d.fill}"/>`
      : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${d.geom === 'roundRect' ? Math.min(w, h) * 0.16 : 0}" fill="#${d.fill}"/>`)
  }
  for (const p of l.placeholders) {
    if (p.type === 'pic') continue
    const [x, y, w, h] = p.box
    const text = SAMPLE[l.key]?.[p.role]
    const anchor = p.align === 'ctr' ? 'middle' : 'start'
    const tx = p.align === 'ctr' ? x + w / 2 : x
    if (text) {
      parts.push(`<text x="${tx}" y="${y + p.size * 1.05}" font-size="${p.size}" font-weight="${p.bold ? 700 : 400}" fill="#${p.color}" text-anchor="${anchor}" font-family="${font}">${esc(text)}</text>`)
      continue
    }
    // 正文：几行示意条（项目符号 + 长短不一）
    const line = Math.max(14, p.size * 1.6)
    const rows = Math.min(5, Math.floor(h / line))
    for (let i = 0; i < rows; i++) {
      const len = w * [0.86, 0.7, 0.78, 0.6, 0.72][i]!
      const ly = y + i * line + line * 0.25
      parts.push(`<circle cx="${x + p.size * 0.3}" cy="${ly + p.size * 0.3}" r="${p.size * 0.16}" fill="#${p.color}" opacity=".55"/>`)
      parts.push(`<rect x="${x + p.size * 0.9}" y="${ly}" width="${len - p.size}" height="${p.size * 0.6}" rx="${p.size * 0.3}" fill="#${p.color}" opacity=".22"/>`)
    }
  }
  return `<svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(t.label)} · ${esc(l.name)}">${parts.join('')}</svg>`
}

function show(html: string): { el: HTMLElement; close: () => void; closed: Promise<void> } {
  const dlg = document.getElementById('dialog')!
  dlg.innerHTML = html
  dlg.hidden = false
  let done!: () => void
  const closed = new Promise<void>(r => { done = r })
  const close = () => { dlg.hidden = true; dlg.innerHTML = ''; document.removeEventListener('keydown', onKey); done() }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  dlg.onclick = e => { if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) close() }
  return { el: dlg, close, closed }
}

/** 模板选择器：每套一张封面 + 三个内页缩略图；点选即返回模板键，取消返回 null。 */
export async function pickTemplate(api: (path: string) => Promise<any>, opts: { title: string; current?: string | null }): Promise<string | null> {
  const list = await loadTemplates(api)
  let chosen: string | null = null
  const { el, close, closed } = show(`<div class="dialog-card tpl-dialog" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
    <div class="dialog-head"><h2>${esc(opts.title)}</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
    <div class="dialog-body"><div class="tpl-grid">${list.map(t => `
      <button class="tpl-card${t.key === opts.current ? ' on' : ''}" data-tpl="${esc(t.key)}" aria-pressed="${t.key === opts.current}">
        <span class="tpl-cover">${layoutSvg(t, 'cover')}</span>
        <span class="tpl-strip">${['content', 'two_col', 'big_number'].map(k => `<span>${layoutSvg(t, k)}</span>`).join('')}</span>
        <span class="tpl-meta"><b>${esc(t.label)}${t.org ? '<em class="tpl-org">本机构</em>' : ''}${t.key === opts.current ? '<em>当前</em>' : ''}</b><span>${esc(t.description)}</span><span class="tpl-tags">${t.tags.map(x => `<i>${esc(x)}</i>`).join('')}</span>${t.credit ? `<span class="tpl-credit">照片：${esc(t.credit.photographer)} · Unsplash</span>` : ''}</span>
      </button>`).join('')}</div></div></div>`)
  el.querySelector<HTMLElement>('.tpl-grid')!.onclick = e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tpl]')
    if (b) { chosen = b.dataset.tpl!; close() }
  }
  el.querySelector<HTMLElement>('.tpl-card.on, .tpl-card')?.focus()
  await closed
  return chosen
}

/** 加页的版式菜单（按当前页的模板画预览）；返回版式名，点外面关闭返回 null。 */
export async function pickLayout(api: (path: string) => Promise<any>, anchor: HTMLElement, themeKey: string | null): Promise<string | null> {
  const list = await loadTemplates(api)
  const t = list.find(x => x.key === themeKey) ?? list[0]!
  document.querySelector('.layout-pop')?.remove()
  const pop = document.createElement('div')
  pop.className = 'layout-pop'
  pop.setAttribute('role', 'menu')
  pop.innerHTML = `<div class="layout-pop-head">选择版式 · ${esc(t.label)}</div><div class="layout-grid">${t.layouts.map(l => `<button role="menuitem" data-layout="${esc(l.name)}" title="${esc(l.hint)}">${layoutSvg(t, l.key)}<span>${esc(l.name)}</span></button>`).join('')}</div>`
  const r = anchor.getBoundingClientRect()
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 500))}px`
  pop.style.top = `${r.bottom + 6}px`
  document.body.appendChild(pop)
  return new Promise(resolve => {
    const done = (v: string | null) => { pop.remove(); document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); resolve(v) }
    const outside = (e: MouseEvent) => { if (!pop.contains(e.target as Node) && e.target !== anchor) done(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') done(null) }
    setTimeout(() => { document.addEventListener('mousedown', outside); document.addEventListener('keydown', key) })
    pop.onclick = e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-layout]'); if (b) done(b.dataset.layout!) }
  })
}
