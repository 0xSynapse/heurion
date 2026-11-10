import { invalidateTemplates, layoutSvg, loadTemplates, type Template, type TplDeco } from './templates.ts'

/**
 * 机构管理里的「机构幻灯片模板」：机构管理员新建 / 编辑 / 删除模板、上传院徽；右侧实时预览封面与内容页。
 * 预览在本地按所选骨架的版式重新着色、加上院徽与页脚（与服务端 deck-templates.ts 的机构装饰同一套几何），保存后以服务端为准。
 * 成员只能看列表。AI 通过 deck_templates / doc_create / apply_theme 使用这些模板，不能管理它们（机构设置）。
 */

type ApiFn = <T = any>(path: string, opts?: RequestInit) => Promise<T>
type Notify = (msg: string, error?: boolean) => void

const COLOR_KEYS = ['bg', 'surface', 'soft', 'title', 'body', 'muted', 'accent', 'accent2'] as const
type ColorKey = (typeof COLOR_KEYS)[number]
const COLOR_LABEL: Record<ColorKey, string> = { bg: '底色', surface: '卡片', soft: '浅色块', title: '标题（主色）', body: '正文', muted: '次要文字', accent: '强调', accent2: '辅助' }

interface OrgTpl {
  id: string; key: string; label: string; description: string; org_name: string; footer: string; base: string
  colors: Record<ColorKey, string>; has_logo: boolean; logo_url: string | null
}
interface Meta { templates: OrgTpl[]; bases: Array<{ key: string; label: string }>; presets: Array<{ label: string; org_name: string; base: string; colors: Record<ColorKey, string> }> }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const cleanHex = (s: unknown) => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(s ?? '').trim())
  if (!m) return '000000'
  const n = Number.parseInt(m[1]!, 16)
  return Number.isInteger(n) && n >= 0 && n <= 0xffffff ? n.toString(16).padStart(6, '0').toUpperCase() : '000000'
}
const token = () => { try { return localStorage.getItem('heurion.token') ?? '' } catch { return '' } }

/** PNG / JPEG / SVG 的像素尺寸（预览按比例放院徽）。 */
async function logoSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 })
    img.onerror = () => resolve({ width: 1, height: 1 })
    img.src = url
  })
}

/** 本地预览：骨架模板换色 + 机构装饰（几何与服务端一致）。 */
function previewTemplate(base: Template, colors: Record<ColorKey, string>, org: { name: string; footer: string }, logo: { href: string; width: number; height: number } | null): Template {
  const map = new Map<string, string>()
  for (const k of COLOR_KEYS) { const from = (base[k] ?? '').toUpperCase(); if (from && !map.has(from)) map.set(from, colors[k]) }
  const swap = (hex: string) => map.get(hex.toUpperCase()) ?? hex
  const logoDeco = (h: number, right: number, y: number): TplDeco[] => {
    if (!logo) return []
    const w = Math.min(260, Math.round(h * logo.width / Math.max(1, logo.height)))
    return [{ box: [right - w, y, w, h], fill: 'none', geom: 'rect', href: logo.href }]
  }
  return {
    ...base, bg: colors.bg, title: colors.title, body: colors.body, muted: colors.muted, accent: colors.accent, accent2: colors.accent2,
    layouts: base.layouts.map(l => {
      const decos = l.decorations.map(d => ({ ...d, fill: swap(d.fill) }))
      if (l.key === 'cover' || l.key === 'closing') decos.push(...logoDeco(72, 904, 40))
      else if (l.key === 'section') decos.push(...logoDeco(56, 904, 40))
      else {
        decos.push({ box: [60, 504, 840, 1.5], fill: colors.title, geom: 'rect' })
        if (org.footer || org.name) decos.push({ box: [60, 510, 620, 22], fill: 'none', geom: 'rect', text: { value: org.footer || org.name, size: 10, color: colors.muted, align: 'l' } })
        decos.push(...logoDeco(22, 900, 510))
      }
      return { ...l, decorations: decos, placeholders: l.placeholders.map(p => ({ ...p, color: /^[0-9A-F]{6}$/i.test(p.color) ? swap(p.color) : p.color })) }
    }),
  }
}

export async function mountOrgTemplates(box: HTMLElement, api: ApiFn, notify: Notify, isAdmin: boolean): Promise<void> {
  const catalog = await loadTemplates(api)
  let meta: Meta = await api('/api/tenant/templates')
  const baseOf = (key: string) => catalog.find(t => t.key === key) ?? catalog.find(t => t.key === 'clinical')!

  const coverOf = async (t: OrgTpl) => {
    const href = t.logo_url ? `${t.logo_url}?token=${encodeURIComponent(token())}` : null
    const size = href ? await logoSize(href) : null
    return layoutSvg(previewTemplate(baseOf(t.base), t.colors, { name: t.org_name, footer: t.footer }, href && size ? { href, ...size } : null), 'cover')
  }

  const renderList = async () => {
    const covers = await Promise.all(meta.templates.map(coverOf))
    box.innerHTML = `<div class="org-tpl-list">
      ${meta.templates.map((t, i) => `<div class="org-tpl-item" data-otid="${esc(t.id)}"><span class="org-tpl-thumb">${covers[i]}</span>
        <span class="org-tpl-info"><b>${esc(t.label)}</b><span class="muted small">${esc(t.org_name)}${t.has_logo ? '' : ' · 未上传院徽'}</span></span>
        ${isAdmin ? '<span class="actions-row"><button data-oact="edit">编辑</button><button data-oact="delete" class="danger">删除</button></span>' : ''}</div>`).join('')}
      ${meta.templates.length === 0 ? `<div class="muted small">还没有机构模板。${isAdmin ? '新建一套带院徽、机构名称和标准色的模板，本机构成员新建幻灯片时就能选用。' : '机构管理员可以新建带院徽和标准色的模板。'}</div>` : ''}
      ${isAdmin ? '<div><button class="primary" data-oact="new">＋ 新建机构模板</button></div>' : ''}</div>`
  }

  const editor = (t: OrgTpl | null) => {
    const preset = meta.presets[0]
    const colors: Record<ColorKey, string> = { ...(t?.colors ?? preset?.colors ?? baseOf('clinical') as unknown as Record<ColorKey, string>) }
    for (const k of COLOR_KEYS) colors[k] = cleanHex(colors[k])
    let logoFile: File | null = null
    let logoUrl: string | null = t?.logo_url ? `${t.logo_url}?token=${encodeURIComponent(token())}` : null
    let clearLogo = false
    box.innerHTML = `<form class="org-tpl-editor" id="orgTplForm">
      <div class="org-tpl-fields form">
        <label>模板名称<input name="label" maxlength="40" required value="${esc(t?.label ?? preset?.label ?? '')}" placeholder="例如：省立医院学术汇报"></label>
        <label>机构名称（院徽说明、页脚默认文字）<input name="org_name" maxlength="80" required value="${esc(t?.org_name ?? preset?.org_name ?? '')}"></label>
        <label>页脚文字（可选，默认用机构名称）<input name="footer" maxlength="80" value="${esc(t?.footer ?? '')}" placeholder="例如：安徽省立医院 · 心血管内科"></label>
        <label>基础风格（版式与装饰）<select name="base">${meta.bases.map(b => `<option value="${esc(b.key)}"${(t?.base ?? preset?.base ?? 'clinical') === b.key ? ' selected' : ''}>${esc(b.label)}</option>`).join('')}</select></label>
        <div class="org-tpl-colors">${COLOR_KEYS.map(k => `<label class="org-color"><input type="color" data-color="${k}" value="#${colors[k]}"><span>${COLOR_LABEL[k]}<i>#${colors[k]}</i></span></label>`).join('')}</div>
        ${preset ? `<div><button type="button" class="small-btn" data-oact="preset">填入${esc(preset.label)}标准色</button> <span class="muted small">藏蓝 #004098 · 红 #C90304 · 青 #00ADA9（取自医院官网）</span></div>` : ''}
        <div class="org-tpl-logo"><span>院徽</span><input type="file" accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg" id="orgTplLogo" hidden>
          <button type="button" class="small-btn" data-oact="logo">${t?.has_logo ? '更换院徽…' : '上传院徽…'}</button>
          <button type="button" class="small-btn" data-oact="nologo"${t?.has_logo ? '' : ' hidden'}>移除</button>
          <span class="muted small">请用医院的官方文件（PNG / JPEG / SVG，≤ 1 MB）；平台不提供任何机构的院徽。</span></div>
        <div class="row end"><button type="button" data-oact="cancel">取消</button><button class="primary">${t ? '保存' : '创建模板'}</button></div>
      </div>
      <div class="org-tpl-preview"><div class="muted small">预览</div><span id="orgPrevCover"></span><span id="orgPrevContent"></span></div>
    </form>`
    const form = box.querySelector<HTMLFormElement>('#orgTplForm')!
    const val = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement).value
    const draw = async () => {
      const size = logoUrl ? await logoSize(logoUrl) : null
      const pt = previewTemplate(baseOf(val('base')), colors, { name: val('org_name'), footer: val('footer') }, logoUrl && size ? { href: logoUrl, ...size } : null)
      box.querySelector('#orgPrevCover')!.innerHTML = layoutSvg(pt, 'cover')
      box.querySelector('#orgPrevContent')!.innerHTML = layoutSvg(pt, 'content')
    }
    form.addEventListener('input', e => {
      const el = e.target as HTMLInputElement
      if (el.dataset.color) { colors[el.dataset.color as ColorKey] = cleanHex(el.value); el.parentElement!.querySelector('i')!.textContent = `#${colors[el.dataset.color as ColorKey]}` }
      void draw()
    })
    form.addEventListener('change', () => void draw())
    form.querySelector<HTMLInputElement>('#orgTplLogo')!.onchange = e => {
      const f = (e.target as HTMLInputElement).files?.[0]
      if (!f) return
      if (f.size > 1024 * 1024) { notify('院徽文件不能超过 1 MB', true); return }
      logoFile = f
      clearLogo = false
      logoUrl = URL.createObjectURL(f)
      form.querySelector<HTMLElement>('[data-oact="nologo"]')!.hidden = false
      void draw()
    }
    form.onclick = e => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-oact]')?.dataset.oact
      if (act === 'cancel') void renderList()
      else if (act === 'logo') form.querySelector<HTMLInputElement>('#orgTplLogo')!.click()
      else if (act === 'nologo') { logoFile = null; logoUrl = null; clearLogo = true; (e.target as HTMLElement).hidden = true; void draw() }
      else if (act === 'preset' && preset) {
        Object.assign(colors, preset.colors)
        for (const k of COLOR_KEYS) { const input = form.querySelector<HTMLInputElement>(`[data-color="${k}"]`)!; input.value = `#${colors[k]}`; input.parentElement!.querySelector('i')!.textContent = `#${colors[k]}` }
        if (!val('org_name')) (form.elements.namedItem('org_name') as HTMLInputElement).value = preset.org_name
        void draw()
      }
    }
    form.onsubmit = async e => {
      e.preventDefault()
      const body = { label: val('label'), org_name: val('org_name'), footer: val('footer'), base: val('base'), colors }
      try {
        const saved: OrgTpl = t
          ? await api(`/api/tenant/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify(body) })
          : await api('/api/tenant/templates', { method: 'POST', body: JSON.stringify(body) })
        if (logoFile) await api(`/api/tenant/templates/${saved.id}/logo`, { method: 'PUT', body: logoFile, headers: { 'Content-Type': logoFile.type || 'application/octet-stream' } })
        else if (clearLogo && t?.has_logo) await api(`/api/tenant/templates/${saved.id}/logo`, { method: 'DELETE' })
        notify(t ? '模板已保存' : '已创建机构模板，本机构成员新建幻灯片时可以选用')
        invalidateTemplates()
        meta = await api('/api/tenant/templates')
        await renderList()
      } catch (err) { notify((err as Error).message, true) }
    }
    void draw()
  }

  box.addEventListener('click', async e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-oact]')
    if (!el || el.closest('#orgTplForm')) return
    const act = el.dataset.oact
    const t = meta.templates.find(x => x.id === el.closest<HTMLElement>('[data-otid]')?.dataset.otid) ?? null
    if (act === 'new') editor(null)
    else if (act === 'edit' && t) editor(t)
    else if (act === 'delete' && t) {
      // 机构管理本身在对话框里：删除用按钮内二次确认，不再弹一层
      el.dataset.oact = 'delete-confirm'
      el.textContent = '确认删除？'
      el.title = '已经用它做的幻灯片不受影响，但以后不能再选用'
    } else if (act === 'delete-confirm' && t) {
      try { await api(`/api/tenant/templates/${t.id}`, { method: 'DELETE' }); notify('已删除'); invalidateTemplates(); meta = await api('/api/tenant/templates'); await renderList() } catch (err) { notify((err as Error).message, true) }
    }
  })
  await renderList()
}
