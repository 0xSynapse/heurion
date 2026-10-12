/**
 * deck 查看器（PLATFORM.md §9 P2）：按模型近似渲染每页（形状按位置与尺寸缩放、图片用资产），
 * 每页可切换到 LibreOffice 的精确渲染。AI 改动的形状高亮，修订标红 / 绿。
 * 评论按最小颗粒度：形状里一个段落内的文字，或单击选中整个形状。
 * 画布（C1）：单击选中形状 → 拖顶部手柄移动、拖 8 个控制点缩放、方向键微调（Shift 10pt）、Delete 删除；
 * 每个手势结束时提交一个 deck 操作（与 AI 的 deck_edit 同一套），服务端回推后重新渲染。
 * 形状里拖动仍是选文字（评论），与移动互不干扰。
 */

import { icon } from './icons.ts'

interface PMJson { type: string; attrs?: Record<string, any>; content?: PMJson[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, any> }> }

export interface DeckViewOptions {
  docId: string
  token: string
  /** 选中文字（限一个段落内）或单击形状（整个形状）；跨段落、跨形状给 blocked 提示。 */
  onSelection: (anchor: { node_id: string; snippet: string; paragraph?: number; range?: { from: number; to: number }; blocked?: string; rect: { top: number; left: number; width: number } } | null) => void
  onCommentClick: (thread: string) => void
  /** 提交 deck 操作（REST edit，actor=user）；成功返回 true。 */
  onEdit: (ops: Array<Record<string, unknown>>, baseRev: number) => Promise<boolean>
  /** 选中的形状变化（工具条据此更新）。 */
  onSelectShape?: (shapeId: string | null) => void
  /** 给用户的提示（并发修改等）。 */
  onNotice?: (message: string) => void
  /** 双击图表：编辑数据（数据表对话框，提交 chart_set_data）。 */
  onEditChart?: (shapeId: string, chart: ChartData) => void
}

export interface ChartData { type: string; title?: string; categories: string[]; series: Array<{ name: string; values: Array<number | null> }>; colors?: string[] }

type Box = { l: number; t: number; w: number; h: number }

type DragKind = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

const EMU_PER_PT = 12700
/** 幻灯片显示宽度随中间栏自适应（窄屏不被裁掉），在这个范围内。 */
/** 最小宽度：手机上按屏宽缩放（不小于这个值，避免字小到看不清）。 */
const MIN_WIDTH = 280
const MAX_WIDTH = 960
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const PH_SIZE: Record<string, number> = { title: 40, ctrTitle: 44, subTitle: 24 }
const PH_HINT: Record<string, string> = { title: '双击输入标题', ctrTitle: '双击输入标题', subTitle: '双击输入副标题', body: '双击输入正文' }
/** 模板版式里各正文区的提示（版式名/占位符 idx）。 */
const LAYOUT_HINT: Record<string, string> = {
  '两栏/1': '双击输入左栏', '两栏/2': '双击输入右栏', '大数字/1': '双击输入数字或一句结论', '大数字/2': '双击输入说明',
  '章节页/1': '双击输入一句说明', '图文/2': '双击输入说明（图片放在左侧区域）', '致谢/1': '双击输入联系方式或问答提示',
}

interface PhStyle { anchor?: 't' | 'ctr' | 'b'; align?: 'l' | 'ctr' | 'r' | 'just'; size?: number; bold?: boolean }
const BODY_LEVELS = [28, 24, 20, 18, 18]

export class DeckView {
  private data: {
    rev: number
    size: { cx: number; cy: number }
    doc: PMJson
    ph_styles?: Record<string, Array<{ type: string; idx: string | null; style: PhStyle }>>
    render_info?: {
      available: boolean
      mode: string
      soffice: string | null
      pdftoppm: string | null
      missing: string[]
      installHint: string
    }
  } | null = null
  /** 正在渲染的形状继承的占位符样式（导入的占位符才有）。 */
  private phStyle: PhStyle | null = null
  private precise = new Set<number>()
  private numbers = new Map<string, number>()
  /** 渲染中当前形状的段落计数（与服务端 attachComment 的段落序号一致：形状内文本块的文档顺序）。 */
  private pIndex = 0
  /** 段落模型（形状 id#段落序号）：选区换算引用文字用。 */
  private paras = new Map<string, PMJson>()
  /** 选中的形状（同一页；第一个是主选中，工具条按它显示）。 */
  private selected: string[] = []
  /** 最近点过的表格单元格（增删行列用）。 */
  private cell: { shapeId: string; r: number; c: number } | null = null
  private drag: {
    kind: DragKind; ids: string[]; x: number; y: number; boxes: Map<string, Box>; union: Box; ratio: number | null; moved: boolean
    /** 吸附线（页面坐标 px）与开始时的形状快照（提交时判断并发修改）。 */
    lines: { xs: number[]; ys: number[] }; slideEl: HTMLElement; snapshot: Map<string, string>; last: Map<string, Box>
  } | null = null
  private nudge: { ids: string[]; dx: number; dy: number; timer: number } | null = null
  private width = 760
  /** 正在画布上直接改字（形状 / 表格单元格 / 备注）。 */
  private editing: { el: HTMLElement; commit: () => Promise<void>; cancel: () => void } | null = null
  private renderPending = false
  private readonly resize = new ResizeObserver(() => {
    if (Math.abs(this.fitWidth() - this.width) > 8 && !this.drag) this.render()
  })

  constructor(private readonly mount: HTMLElement, private readonly opts: DeckViewOptions) {
    const scroller = mount.closest('.scroller')
    if (scroller) this.resize.observe(scroller)
    mount.addEventListener('dblclick', e => this.startEditing(e))
    mount.addEventListener('pointerdown', e => this.startDrag(e))
    mount.addEventListener('pointermove', e => this.moveDrag(e))
    mount.addEventListener('pointerup', e => void this.endDrag(e))
    document.addEventListener('keydown', this.onKey)
    mount.addEventListener('mouseup', e => this.reportSelection(e))
    mount.addEventListener('keyup', () => this.reportSelection())
    mount.addEventListener('click', e => {
      const t = e.target as HTMLElement
      const mark = t.closest('mark.comment') as HTMLElement | null
      if (mark?.dataset.thread) opts.onCommentClick(mark.dataset.thread)

      const copyBtn = t.closest('[data-copy-cmd]') as HTMLElement | null
      if (copyBtn) {
        const cmd = copyBtn.dataset.copyCmd || 'brew install --cask libreoffice'
        navigator.clipboard?.writeText(cmd).then(() => {
          this.opts.onNotice?.('已复制安装命令到剪贴板：' + cmd)
        }).catch(() => {
          prompt('请复制以下命令在终端中运行：', cmd)
        })
        return
      }

      const backBtn = t.closest('[data-back-approx]') as HTMLElement | null
      if (backBtn) {
        const i = Number(backBtn.dataset.backApprox)
        this.precise.delete(i)
        this.render()
        return
      }

      const toggle = t.closest('[data-precise]') as HTMLElement | null
      if (toggle) {
        const i = Number(toggle.dataset.precise)
        if (this.precise.has(i)) {
          this.precise.delete(i)
        } else {
          this.precise.add(i)
        }
        this.render()
      }
    })
  }

  async load(): Promise<void> {
    const res = await fetch(`/api/docs/${this.opts.docId}/deck`, { headers: { Authorization: `Bearer ${this.opts.token}` } })
    this.data = await res.json()
    this.render()
  }

  private scale(): number {
    return this.width / (this.data!.size.cx / EMU_PER_PT)
  }

  /** 中间栏可用宽度（减去滚动区与页面的内边距）。 */
  private fitWidth(): number {
    const scroller = this.mount.closest('.scroller') as HTMLElement | null
    // 桌面：滚动区与页面各留 48px；手机（窄于 700px）：两边一共只留 20px，幻灯片尽量占满屏宽
    const width = scroller?.clientWidth ?? 856
    const avail = width - (width < 700 ? 20 : 96)
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.floor(avail)))
  }

  private render(): void {
    if (!this.data) return
    // 正在改字时不重绘（会冲掉输入）；改完再按最新数据重绘
    if (this.editing || this.drag?.moved) { this.renderPending = true; return }
    const slides = this.data.doc.content ?? []
    // 引用编号：全文首次出现顺序
    this.numbers.clear()
    this.paras.clear()
    const walk = (n: PMJson) => {
      if (n.type === 'citation' && !this.numbers.has(n.attrs!.cite_id)) this.numbers.set(n.attrs!.cite_id, this.numbers.size + 1)
      n.content?.forEach(walk)
    }
    walk(this.data.doc)
    this.width = this.fitWidth()
    const height = Math.round(this.width * this.data.size.cy / this.data.size.cx)
    this.mount.innerHTML = slides.map((slide, i) => {
      const notes = slide.content?.find(c => c.type === 'notes')
      const suggest = slide.attrs?.suggest ? ` data-suggest="${slide.attrs.suggest}" data-suggest-group="${esc(slide.attrs.suggest_group)}"` : ''
      const shapesHtml = (slide.content ?? []).filter(c => c.type === 'shape').map(s => this.shape(s, slide.attrs?.layout as string | undefined, slide.attrs?.layout_name as string | undefined)).join('')
      const renderUnavailableHtml = `
        <div class="render-warning-overlay">
          <div class="render-warning-card">
            <div class="render-warning-title">${icon('info', { size: 14 })} 幻灯片精确渲染不可用</div>
            <div class="render-warning-desc">${esc(this.data?.render_info?.installHint || '当前系统缺少 LibreOffice，无法将 PPTX 转换为位图。')}</div>
            <div class="render-warning-actions">
              <button class="btn-copy-install" data-copy-cmd="brew install --cask libreoffice">${icon('copy', { size: 13 })} 复制安装命令 (macOS)</button>
              <button class="btn-back-approx" data-back-approx="${i}">切回近似预览</button>
            </div>
            <div class="render-warning-fallback">已自动为您呈现高保真近真矢量预览：</div>
          </div>
        </div>
      `
      const body = this.precise.has(i)
        ? `<div class="precise-slide-container">
            <img class="slide-png" src="/api/docs/${this.opts.docId}/slides/${i}/render.png?token=${encodeURIComponent(this.opts.token)}&rev=${this.data!.rev}" alt="渲染中…" onerror="const c = this.closest('.precise-slide-container'); if (c) c.classList.add('render-error');">
            <div class="precise-fallback-view">${renderUnavailableHtml}${shapesHtml}</div>
          </div>`
        : shapesHtml
      return `<div class="slide-wrap" data-id="${esc(slide.attrs?.id)}" data-index="${i}"${suggest}>
        <div class="slide-head"><span>第 ${i + 1} 页 · ${esc(slide.attrs?.layout_name || '无版式')}</span><button data-precise="${i}">${this.precise.has(i) ? '近似预览' : '精确预览'}</button></div>
        <div class="slide"${slide.attrs?.theme ? ` data-theme="${esc(slide.attrs.theme)}"` : ''} style="width:${this.width}px;height:${height}px;${slide.attrs?.bg ? `background:#${slide.attrs.bg};${isDark(slide.attrs.bg) ? 'color:#E2E8F0;' : ''}` : ''}">${body}</div>
        <div class="slide-notes"><span class="notes-label">备注</span><div class="notes-text${notes && this.text(notes) ? '' : ' empty'}" data-notes="${esc(slide.attrs?.id)}" title="双击编辑演讲者备注">${notes && this.text(notes) ? esc(this.text(notes)) : '双击添加演讲者备注'}</div></div>
      </div>`
    }).join('')

    // 选中的形状被删了（别人或 AI 删的）：从选中里去掉
    const alive = this.selected.filter(id => this.findShape(id))
    if (alive.length !== this.selected.length) { this.selected = alive; this.opts.onSelectShape?.(alive[0] ?? null) }
    this.drawSelection()
  }

  // —— 画布：选中（Shift 多选）、移动（吸附对齐）、缩放、微调、删除 ——

  /** 主选中的形状与所在页（工具条用）。 */
  selection(): { shape: PMJson; slide: PMJson } | null {
    if (!this.selected[0] || !this.data) return null
    for (const slide of this.data.doc.content ?? []) {
      const shape = slide.content?.find(c => c.attrs?.id === this.selected[0])
      if (shape) return { shape, slide }
    }
    return null
  }

  /** 全部选中的形状 id。 */
  selectionIds(): string[] { return [...this.selected] }

  /** 最近点过的表格单元格（选中的是表格时）。 */
  tableCell(): { shapeId: string; r: number; c: number } | null {
    return this.cell && this.cell.shapeId === this.selected[0] ? this.cell : null
  }

  /** 视口里当前的页（没选中形状时，插入 / 背景作用在这一页）。 */
  currentSlide(): PMJson | null {
    const sel = this.selection()
    if (sel) return sel.slide
    const slides = this.data?.doc.content ?? []
    const wraps = [...this.mount.querySelectorAll<HTMLElement>('.slide-wrap')]
    const top = this.mount.closest('.scroller')?.getBoundingClientRect().top ?? 0
    const visible = wraps.find(w => w.getBoundingClientRect().bottom > top + 80)
    return slides[Number(visible?.dataset.index ?? 0)] ?? slides[0] ?? null
  }

  get rev(): number { return this.data?.rev ?? 0 }
  get slideSize(): { cx: number; cy: number } { return this.data?.size ?? { cx: 12192000, cy: 6858000 } }

  async edit(ops: Array<Record<string, unknown>>): Promise<boolean> {
    return this.opts.onEdit(ops, this.rev)
  }

  private shapeEl(id: string): HTMLElement | null {
    return this.mount.querySelector<HTMLElement>(`.slide .shape[data-id="${CSS.escape(id)}"]`)
  }

  private static boxOf(el: HTMLElement): Box {
    return { l: parseFloat(el.style.left), t: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }
  }

  /** 选中框：每个选中的形状一个框（框不挡鼠标，形状里的文字仍可选中评论）；单选时才有缩放控制点。 */
  private drawSelection(): void {
    this.mount.querySelectorAll('.sel-box, .guide').forEach(el => el.remove())
    const single = this.selected.length === 1
    for (const id of this.selected) {
      const el = this.shapeEl(id)
      if (!el) continue
      // 选中框画在页面外层（页面会裁掉超出部分）：形状超出页面时控制点仍可见、可拖
      const slideEl = el.parentElement!
      const ox = slideEl.offsetLeft
      const oy = slideEl.offsetTop
      const box = document.createElement('div')
      box.className = `sel-box${single ? '' : ' multi'}`
      box.dataset.for = id
      box.dataset.ox = String(ox)
      box.dataset.oy = String(oy)
      box.style.cssText = `left:${ox + parseFloat(el.style.left)}px;top:${oy + parseFloat(el.style.top)}px;width:${el.style.width};height:${el.style.height};${el.style.transform ? `transform:${el.style.transform};` : ''}`
      box.innerHTML = `<div class="sel-grip" data-drag="move" title="拖动移动${single ? '' : '（全部选中的形状）'}；方向键微调（Shift 每次 10pt）；按住 Alt 拖动不吸附；Delete 删除；Shift+单击多选；双击形状改字">⠿</div>`
        + (single ? (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map(h => `<div class="sel-handle h-${h}" data-drag="${h}"></div>`).join('') : '')
      box.querySelector<HTMLElement>('.sel-grip')!.classList.add(oy + parseFloat(el.style.top) >= 26 ? 'above' : 'inside')
      slideEl.parentElement!.appendChild(box)
    }
  }

  /** 吸附线：页面的边与中线、同页其他形状的边与中线（px，页面坐标）。 */
  private snapLines(slideEl: HTMLElement, exclude: Set<string>): { xs: number[]; ys: number[] } {
    const W = slideEl.clientWidth
    const H = slideEl.clientHeight
    const xs = [0, W / 2, W]
    const ys = [0, H / 2, H]
    for (const el of slideEl.querySelectorAll<HTMLElement>(':scope > .shape[data-id]')) {
      if (exclude.has(el.dataset.id!)) continue
      const b = DeckView.boxOf(el)
      xs.push(b.l, b.l + b.w / 2, b.l + b.w)
      ys.push(b.t, b.t + b.h / 2, b.t + b.h)
    }
    return { xs, ys }
  }

  /** 一组边里离吸附线最近的（6px 内）：返回要挪的距离与吸到的线。 */
  private static snap(edges: number[], lines: number[]): { delta: number; line: number } | null {
    let best: { delta: number; line: number } | null = null
    for (const e of edges) for (const l of lines) {
      const d = l - e
      if (Math.abs(d) <= 6 && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, line: l }
    }
    return best
  }

  private showGuides(slideEl: HTMLElement, x: number | null, y: number | null): void {
    this.mount.querySelectorAll('.guide').forEach(el => el.remove())
    const wrap = slideEl.parentElement!
    const add = (cls: string, style: string) => { const g = document.createElement('div'); g.className = `guide ${cls}`; g.style.cssText = style; wrap.appendChild(g) }
    if (x !== null) add('v', `left:${slideEl.offsetLeft + x}px;top:${slideEl.offsetTop}px;height:${slideEl.clientHeight}px`)
    if (y !== null) add('h', `top:${slideEl.offsetTop + y}px;left:${slideEl.offsetLeft}px;width:${slideEl.clientWidth}px`)
  }

  private startDrag(e: PointerEvent): void {
    const handle = (e.target as HTMLElement).closest('[data-drag]') as HTMLElement | null
    if (!handle || this.selected.length === 0 || e.button !== 0) return
    const els = this.selected.map(id => [id, this.shapeEl(id)] as const).filter((x): x is readonly [string, HTMLElement] => !!x[1])
    if (els.length === 0) return
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    const kind = handle.dataset.drag as DragKind
    const boxes = new Map(els.map(([id, el]) => [id, DeckView.boxOf(el)]))
    const all = [...boxes.values()]
    const union = { l: Math.min(...all.map(b => b.l)), t: Math.min(...all.map(b => b.t)), w: 0, h: 0 }
    union.w = Math.max(...all.map(b => b.l + b.w)) - union.l
    union.h = Math.max(...all.map(b => b.t + b.h)) - union.t
    const first = els[0]![1]
    // 图片拖角时保持比例
    const ratio = kind !== 'move' && first.classList.contains('shape-image') && kind.length === 2 ? union.w / union.h : null
    const slideEl = first.parentElement!
    const snapshot = new Map(els.map(([id]) => [id, JSON.stringify(this.findShape(id)?.attrs ?? {})]))
    this.drag = { kind, ids: els.map(([id]) => id), x: e.clientX, y: e.clientY, boxes, union, ratio, moved: false, lines: this.snapLines(slideEl, new Set(this.selected)), slideEl, snapshot, last: boxes }
  }

  private moveDrag(e: PointerEvent): void {
    const d = this.drag
    if (!d) return
    let dx = e.clientX - d.x
    let dy = e.clientY - d.y
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 2) return
    d.moved = true
    let gx: number | null = null
    let gy: number | null = null
    if (d.kind === 'move') {
      if (!e.altKey) {
        const u = d.union
        const sx = DeckView.snap([u.l + dx, u.l + dx + u.w / 2, u.l + dx + u.w], d.lines.xs)
        const sy = DeckView.snap([u.t + dy, u.t + dy + u.h / 2, u.t + dy + u.h], d.lines.ys)
        if (sx) { dx += sx.delta; gx = sx.line }
        if (sy) { dy += sy.delta; gy = sy.line }
      }
      d.last = new Map([...d.boxes].map(([id, b]) => [id, { ...b, l: b.l + dx, t: b.t + dy }]))
    } else {
      const r = this.dragRect(d, dx, dy)
      if (!e.altKey && !d.ratio) {
        // 缩放时只吸附正在拖的那条边
        const sx = d.kind.includes('e') ? DeckView.snap([r.l + r.w], d.lines.xs) : d.kind.includes('w') ? DeckView.snap([r.l], d.lines.xs) : null
        const sy = d.kind.includes('s') ? DeckView.snap([r.t + r.h], d.lines.ys) : d.kind.includes('n') ? DeckView.snap([r.t], d.lines.ys) : null
        if (sx) { if (d.kind.includes('e')) r.w += sx.delta; else { r.l += sx.delta; r.w -= sx.delta } gx = sx.line }
        if (sy) { if (d.kind.includes('s')) r.h += sy.delta; else { r.t += sy.delta; r.h -= sy.delta } gy = sy.line }
      }
      d.last = new Map([[d.ids[0]!, r]])
    }
    for (const [id, b] of d.last) this.placeLive(id, b)
    this.showGuides(d.slideEl, gx, gy)
  }

  /** 拖动 / 微调过程中就地移动形状与它的选中框（框在页面外层，要加页面偏移）。 */
  private placeLive(id: string, r: Box): void {
    const el = this.shapeEl(id)
    if (el) Object.assign(el.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.w}px`, height: `${r.h}px` })
    const box = this.mount.querySelector<HTMLElement>(`.sel-box[data-for="${CSS.escape(id)}"]`)
    if (box) Object.assign(box.style, { left: `${r.l + Number(box.dataset.ox)}px`, top: `${r.t + Number(box.dataset.oy)}px`, width: `${r.w}px`, height: `${r.h}px` })
  }

  private dragRect(d: NonNullable<DeckView['drag']>, dx: number, dy: number): Box {
    const min = 10 * this.scale()
    let { l, t, w, h } = d.boxes.get(d.ids[0]!)!
    if (d.kind.includes('e')) w = Math.max(min, w + dx)
    if (d.kind.includes('s')) h = Math.max(min, h + dy)
    if (d.kind.includes('w')) { const nw = Math.max(min, w - dx); l += w - nw; w = nw }
    if (d.kind.includes('n')) { const nh = Math.max(min, h - dy); t += h - nh; h = nh }
    if (d.ratio) {
      const nh = w / d.ratio
      if (d.kind.includes('n')) t += h - nh
      h = nh
    }
    return { l, t, w, h }
  }

  private async endDrag(_e: PointerEvent): Promise<void> {
    const d = this.drag
    if (!d) return
    this.drag = null
    this.mount.querySelectorAll('.guide').forEach(el => el.remove())
    if (!d.moved) return
    const k = this.scale()
    // 拖动期间形状被删 / 被别人挪过：删了的跳过，挪过的以你的位置为准（都告诉用户）
    const ops: Array<Record<string, unknown>> = []
    let gone = 0
    let moved = 0
    for (const [id, r] of d.last) {
      const now = this.findShape(id)
      if (!now) { gone++; continue }
      const before = JSON.parse(d.snapshot.get(id) ?? '{}')
      if (['x', 'y', 'w', 'h'].some(key => before[key] !== now.attrs?.[key])) moved++
      ops.push({ op: 'set_xfrm', shape_id: id, x: Math.round(r.l / k), y: Math.round(r.t / k), w: Math.max(10, Math.round(r.w / k)), h: Math.max(10, Math.round(r.h / k)) })
    }
    if (gone) this.opts.onNotice?.(`你拖动的形状里有 ${gone} 个刚被删除了，已跳过`)
    if (moved) this.opts.onNotice?.('你拖动时 AI 也移动了这个形状，已以你的位置为准')
    const ok = ops.length > 0 ? await this.edit(ops) : true
    if (!ok || this.renderPending || ops.length === 0) { this.renderPending = false; this.render() } // 被拒或期间有更新：按服务端的状态重绘
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (this.selected.length === 0 || !this.mount.isConnected) return
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], .ProseMirror, .dialog')) return
    if (e.key === 'Escape') { this.select([]); return }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      const ids = [...this.selected]
      this.select([])
      void this.edit(ids.map(id => ({ op: 'delete_shape', shape_id: id })))
      return
    }
    const step = e.shiftKey ? 10 : 1
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!delta) return
    e.preventDefault()
    // 连续按键先就地移动，停下 400ms 后合并成一次提交（每个选中形状一个 set_xfrm）
    const key = this.selected.join(',')
    const n = this.nudge && this.nudge.ids.join(',') === key ? this.nudge : { ids: [...this.selected], dx: 0, dy: 0, timer: 0 }
    n.dx += delta[0]!
    n.dy += delta[1]!
    const k = this.scale()
    for (const id of n.ids) {
      const el = this.shapeEl(id)
      if (el) { const b = DeckView.boxOf(el); this.placeLive(id, { ...b, l: b.l + delta[0]! * k, t: b.t + delta[1]! * k }) }
    }
    clearTimeout(n.timer)
    n.timer = window.setTimeout(() => {
      this.nudge = null
      const ops = n.ids.flatMap(id => {
        const a = this.findShape(id)?.attrs
        return a ? [{ op: 'set_xfrm', shape_id: id, x: Math.round(a.x / EMU_PER_PT + n.dx), y: Math.round(a.y / EMU_PER_PT + n.dy) }] : []
      })
      if (ops.length) void this.edit(ops)
    }, 400)
    this.nudge = n
  }

  // —— 画布上直接改字：双击文本框 / 色块 / 占位符、表格单元格、备注 ——

  private startEditing(e: MouseEvent): void {
    if (this.editing) return
    const t = e.target as HTMLElement
    const notes = t.closest('.notes-text') as HTMLElement | null
    if (notes) { this.editNotes(notes, e); return }
    const shapeEl = t.closest('.slide .shape[data-id]') as HTMLElement | null
    if (!shapeEl) return
    const id = shapeEl.dataset.id!
    const sel = this.findShape(id)
    if (!sel) return
    const kind = sel.attrs?.kind as string
    const td = t.closest('td[data-r]') as HTMLElement | null
    if (kind === 'table' && td) { this.editCell(id, td, e); return }
    if (kind === 'chart' && sel.attrs?.chart) { this.opts.onEditChart?.(id, sel.attrs.chart as ChartData); return }
    if (kind === 'text' || kind === 'shape') this.editShape(id, shapeEl, sel, e)
  }

  private findShape(id: string): PMJson | null {
    for (const slide of this.data?.doc.content ?? []) {
      const shape = slide.content?.find(c => c.attrs?.id === id)
      if (shape) return shape
    }
    return null
  }

  /** 进入编辑：contenteditable + 完成（点别处 / ⌘↩）与取消（Esc）。 */
  private beginEdit(el: HTMLElement, mode: 'true' | 'plaintext-only', commit: () => Promise<void>, at?: MouseEvent): void {
    this.mount.querySelectorAll('.sel-box').forEach(b => b.remove())
    this.opts.onSelection(null)
    el.contentEditable = mode
    el.classList.add('editing')
    document.execCommand('defaultParagraphSeparator', false, 'p')
    el.focus()
    // 光标放在双击的位置：双击时浏览器选中的一片可能带着分段，接着打字会把两段并成一段
    const caret = at ? document.caretRangeFromPoint?.(at.clientX, at.clientY) : null
    if (caret && el.contains(caret.startContainer)) {
      caret.collapse(true)
      getSelection()?.removeAllRanges()
      getSelection()?.addRange(caret)
    }
    const finish = async (save: boolean) => {
      if (!this.editing || this.editing.el !== el) return
      el.removeEventListener('keydown', onKey)
      el.removeEventListener('focusout', onOut)
      this.editing = null
      el.contentEditable = 'false'
      el.classList.remove('editing')
      if (save) await commit()
      // 提交后服务端会回推新数据；没提交（取消 / 没改）就按现有数据重绘
      if (!save || this.renderPending) { this.renderPending = false; this.render() }
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.preventDefault(); void finish(false) }
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); void finish(true) }
    }
    const onOut = (ev: FocusEvent) => { if (!el.contains(ev.relatedTarget as Node | null)) void finish(true) }
    el.addEventListener('keydown', onKey)
    el.addEventListener('focusout', onOut)
    this.editing = { el, commit: () => finish(true), cancel: () => void finish(false) }
  }

  private editShape(id: string, shapeEl: HTMLElement, shape: PMJson, at: MouseEvent): void {
    const container = (shapeEl.querySelector('.shape-text') as HTMLElement | null) ?? shapeEl
    const original = (shape.content ?? []).filter(p => p.type === 'paragraph').map(p => ({ text: modelText(p), lvl: p.attrs?.lvl ?? 0 }))
    const snapshot = JSON.stringify(shape.content ?? [])
    this.beginEdit(container, 'true', async () => {
      // 编辑期间这个形状被删了 / 被 AI 改了（数据已更新，只是没重绘）
      const latest = this.findShape(id)
      if (!latest) { this.opts.onNotice?.('你编辑的形状刚被删除了，修改没有保存'); return }
      const changedMeanwhile = JSON.stringify(latest.content ?? []) !== snapshot
      const paragraphs = domParagraphs(container)
      const same = paragraphs.length === original.length && paragraphs.every((p, i) => p.text === original[i]!.text && p.lvl === original[i]!.lvl)
      if (same) return
      const ok = await this.edit([{ op: 'set_paragraphs', shape_id: id, paragraphs }])
      if (ok && changedMeanwhile) this.opts.onNotice?.('你编辑时 AI 也改了这个形状，已以你的修改为准；AI 的版本可在「版本」里找回')
    }, at)
  }

  private editCell(id: string, td: HTMLElement, at: MouseEvent): void {
    const before = domParagraphs(td).map(p => p.text).join('\n\n')
    this.beginEdit(td, 'true', async () => {
      const markdown = domParagraphs(td).map(p => p.text).join('\n\n')
      if (markdown === before) return
      await this.edit([{ op: 'table_set_cells', shape_id: id, cells: [{ row: Number(td.dataset.r), col: Number(td.dataset.c), markdown }] }])
    }, at)
  }

  private editNotes(el: HTMLElement, at: MouseEvent): void {
    const slideId = el.dataset.notes!
    const wasEmpty = el.classList.contains('empty')
    if (wasEmpty) { el.textContent = ''; el.classList.remove('empty') }
    const before = wasEmpty ? '' : (el.textContent ?? '')
    this.beginEdit(el, 'plaintext-only', async () => {
      const text = (el.innerText ?? '').replace(/\u00a0/g, ' ').trim()
      if (text === before.trim()) return
      const markdown = text.split(/\n+/).map(l => escapeMd(l.trim())).filter(Boolean).join('\n\n')
      await this.edit([{ op: 'set_notes', slide_id: slideId, markdown }])
    }, wasEmpty ? undefined : at)
  }

  private text(n: PMJson): string {
    if (n.type === 'text') return n.text ?? ''
    return (n.content ?? []).map(c => this.text(c)).join(n.type === 'notes' ? '\n' : '')
  }

  /**
   * 导入的占位符（保留原文件 bodyPr，body_pr 不为 null）按版式 / 母版继承的样式显示：锚点、对齐、字号、粗细，
   * 与 PowerPoint 一致。平台新建的占位符导出时写明顶端左对齐，画布按默认显示。
   */
  private inheritedStyle(a: Record<string, any>, layout: string | undefined): PhStyle | null {
    if (a.kind !== 'text' || !a.ph || a.body_pr === null || a.body_pr === undefined) return null
    const list = (layout && this.data?.ph_styles?.[layout]) || []
    const isTitle = (t: string) => t === 'title' || t === 'ctrTitle'
    const hit = list.find(p => p.type === a.ph && (p.idx ?? null) === (a.ph_idx ?? null))
      ?? list.find(p => p.type === a.ph)
      ?? list.find(p => isTitle(p.type) && isTitle(a.ph))
      ?? (a.ph_idx ? list.find(p => p.idx === a.ph_idx) : undefined)
    const own = /\banchor="(t|ctr|b)"/.exec(String(a.body_pr))?.[1] as PhStyle['anchor'] | undefined
    return { ...(hit?.style ?? {}), ...(own ? { anchor: own } : {}) }
  }

  private shape(s: PMJson, layout?: string, layoutName?: string): string {
    const a = s.attrs!
    const k = this.scale()
    this.phStyle = this.inheritedStyle(a, layout)
    const anchor = this.phStyle?.anchor ? `display:flex;flex-direction:column;justify-content:${{ t: 'flex-start', ctr: 'center', b: 'flex-end' }[this.phStyle.anchor]};` : ''
    const box = `left:${a.x / EMU_PER_PT * k}px;top:${a.y / EMU_PER_PT * k}px;width:${a.w / EMU_PER_PT * k}px;height:${a.h / EMU_PER_PT * k}px;${a.rot ? `transform:rotate(${a.rot / 60000}deg);` : ''}`
    const suggest = a.suggest ? ` data-suggest="${a.suggest}" data-suggest-group="${esc(a.suggest_group)}"` : ''
    const fill = a.fill === 'none' ? 'background:transparent;border:0;' : a.fill ? `background:#${a.fill};border:0;` : ''
    const radius = a.geom === 'ellipse' ? 'border-radius:50%;' : a.geom === 'roundRect' ? `border-radius:${Math.min(a.w, a.h) / EMU_PER_PT * k * 0.16}px;` : ''
    this.pIndex = 0
    const sel = this.selected.includes(a.id) ? ' selected' : ''
    // 带几何 / 实心填充的文本框按色块显示（文字垂直居中，与导出的 anchor="ctr" 一致）
    const block = a.kind === 'text' && !a.ph && (a.geom || (a.fill && a.fill !== 'none'))
    // 模板装饰：不可选中、不挡点击（换模板时自动替换）
    const deco = String(a.name ?? '').startsWith('deco:') ? ' deco' : ''
    // 还没写字的模板占位符：显示提示（双击输入）
    const hint = LAYOUT_HINT[`${layoutName ?? ''}/${a.ph_idx ?? ''}`] ?? PH_HINT[a.ph as string] ?? '双击输入文字'
    const empty = a.kind === 'text' && a.ph && !this.text(s).trim() ? ` ph-empty" data-hint="${esc(hint)}` : ''
    const common = `class="shape shape-${block ? 'shape' : a.kind}${sel}${deco}${empty}" data-id="${esc(a.id)}"${a.ph ? ` data-ph="${esc(a.ph)}"` : ''}${suggest} style="${box}${fill}${radius}${anchor}"`
    if (a.kind === 'image' && a.asset_id) return `<div ${common}><img src="/api/assets/${esc(a.asset_id)}?token=${encodeURIComponent(this.opts.token)}" alt=""></div>`
    if (a.kind === 'text' && !block) return `<div ${common}>${(s.content ?? []).map(p => this.paragraph(s, p, k)).join('')}</div>`
    if (block) return `<div ${common}><div class="shape-text">${(s.content ?? []).map(p => this.paragraph(s, p, k)).join('')}</div></div>`
    if (a.kind === 'table') {
      const table = s.content?.[0]
      // 单元格底色取自 a:tcPr 的纯色填充
      const cellBg = (c: PMJson) => { const m = /<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(String(c.attrs?.tcpr ?? '')); return m ? ` style="background:#${m[1]}"` : '' }
      const rows = (table?.content ?? []).map((r, ri) => `<tr>${(r.content ?? []).map((c, ci) => `<td data-r="${ri}" data-c="${ci}"${cellBg(c)}>${(c.content ?? []).map(p => this.paragraph(s, p, k)).join('')}</td>`).join('')}</tr>`).join('')
      return `<div ${common}><table>${rows}</table></div>`
    }
    // 色块 / 卡片：文字垂直居中（与导出的 anchor="ctr" 一致）
    if (a.kind === 'shape') return `<div ${common}><div class="shape-text">${(s.content ?? []).map(p => this.paragraph(s, p, k)).join('')}</div></div>`
    if (a.kind === 'chart' && a.chart) return `<div ${common} title="双击编辑图表数据">${chartSvg(a.chart as ChartData, a.w / EMU_PER_PT * k, a.h / EMU_PER_PT * k)}</div>`
    return `<div ${common}><span class="shape-label">${esc(a.description || a.kind)}</span></div>`
  }

  private paragraph(shape: PMJson, p: PMJson, k: number): string {
    const lvl = p.attrs?.lvl ?? 0
    const ph = shape.attrs!.ph as string | null
    let size = 0
    // 每个行内单位标上在段落里的偏移（data-o），选区据此换算回模型位置
    let offset = 0
    const runs = (p.content ?? []).map(c => {
      const o = offset
      offset += c.type === 'text' ? (c.text ?? '').length : 1
      if (c.type === 'hard_break') return `<br data-o="${o}">`
      if (c.type === 'citation') return `<sup class="cite" data-o="${o}" data-atom data-cite="${esc(c.attrs!.cite_id)}" contenteditable="false">[${this.numbers.get(c.attrs!.cite_id) ?? '?'}]</sup>`
      const rpr = c.marks?.find(m => m.type === 'rpr')?.attrs?.xml as string | undefined
      const sz = rpr ? /\ssz="(\d+)"/.exec(rpr)?.[1] : undefined
      const color = rpr ? /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(rpr)?.[1] : undefined
      const font = rpr ? (/<a:latin typeface="([^"]+)"/.exec(rpr)?.[1] ?? /<a:ea typeface="([^"]+)"/.exec(rpr)?.[1]) : undefined
      if (sz && !size) size = Number(sz) / 100
      let html = esc(c.text)
      for (const m of c.marks ?? []) {
        if (m.type === 'bold') html = `<b>${html}</b>`
        if (m.type === 'italic') html = `<i>${html}</i>`
        if (m.type === 'underline') html = `<u>${html}</u>`
        if (m.type === 'sup') html = `<sup>${html}</sup>`
        if (m.type === 'sub') html = `<sub>${html}</sub>`
        if (m.type === 'comment') html = `<mark class="comment" data-thread="${esc(m.attrs?.thread)}">${html}</mark>`
      }
      const styles = [
        color ? `color:#${color}` : '',
        font ? `font-family:${font}` : '',
        sz ? `font-size:${Number(sz) / 100 * k}px` : '',
      ].filter(Boolean).join(';')
      return `<span data-o="${o}"${styles ? ` style="${styles}"` : ''}>${html}</span>`
    }).join('')
    // 还没写字的模板占位符：版式规定的字号在段落属性的 a:defRPr 里
    if (!size) { const d = /<a:defRPr\b[^>]*\ssz="(\d+)"/.exec(String(p.attrs?.ppr ?? '')); if (d) size = Number(d[1]) / 100 }
    if (!size) size = (lvl === 0 && this.phStyle?.size) || (ph && PH_SIZE[ph]) || (ph === 'body' || ph === 'obj' ? BODY_LEVELS[lvl] ?? 18 : 18)
    // 项目符号用 CSS 画，不进选区文字
    const bullet = (ph === 'body' || ph === 'obj') && runs && !/<a:buNone\b/.test(String(p.attrs?.ppr ?? '')) ? ' class="bullet"' : ''
    const inherited = this.phStyle?.align ? { l: 'left', ctr: 'center', r: 'right', just: 'justify' }[this.phStyle.align] : null
    const align = p.attrs?.align ? `text-align:${p.attrs.align};` : inherited ? `text-align:${inherited};` : ''
    const weight = this.phStyle?.bold ? 'font-weight:700;' : ''
    this.paras.set(`${shape.attrs!.id}#${this.pIndex}`, p)
    return `<p data-p="${this.pIndex++}" data-len="${offset}" data-lvl="${lvl}"${bullet} style="font-size:${size * k}px;margin-left:${lvl * 18 * k}px;${align}${weight}">${runs || '&nbsp;'}</p>`
  }

  private reportSelection(e?: MouseEvent): void {
    if (this.editing) return // 改字时的选区不是评论选区
    // Shift+单击形状是多选（浏览器会顺带把文字选区扩展过去，清掉）
    const shiftTarget = e?.shiftKey ? (e.target as HTMLElement).closest('.slide .shape[data-id]') as HTMLElement | null : null
    if (shiftTarget && this.selected[0] && this.shapeEl(this.selected[0])?.parentElement === shiftTarget.parentElement) {
      getSelection()?.removeAllRanges()
      const id = shiftTarget.dataset.id!
      this.select(this.selected.includes(id) ? this.selected.filter(x => x !== id) : [...this.selected, id])
      this.opts.onSelection(null)
      return
    }
    // 在选中框（手柄、控制点）上松开鼠标是拖动的结束，不是点空白处
    if ((e?.target as HTMLElement | undefined)?.closest?.('.sel-box')) return
    const sel = getSelection()
    const el = (n: Node | null) => (n?.nodeType === 3 ? n.parentElement : n as HTMLElement | null)
    const shapeOf = (n: Node | null) => el(n)?.closest('.shape[data-id]') as HTMLElement | null
    const paraOf = (n: Node | null) => el(n)?.closest('p[data-p]') as HTMLElement | null
    if (!sel || sel.isCollapsed || !this.mount.contains(sel.anchorNode)) {
      // 单击形状：选中整个形状
      const target = e ? (e.target as HTMLElement).closest('.slide .shape[data-id]') as HTMLElement | null : null
      if (target && !(e!.target as HTMLElement).closest('mark.comment')) {
        const id = target.dataset.id!
        const td = (e!.target as HTMLElement).closest('td[data-r]') as HTMLElement | null
        this.cell = td ? { shapeId: id, r: Number(td.dataset.r), c: Number(td.dataset.c) } : null
        this.select([id])
        const r = target.getBoundingClientRect()
        // 评论按钮放在形状右上角（正上方留给移动手柄）
        this.opts.onSelection({ node_id: id, snippet: '', rect: { top: r.top, left: r.right - 100, width: 100 } })
      } else {
        this.select([])
        this.opts.onSelection(null)
      }
      return
    }
    this.select([])
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    const at = { top: rect.top, left: rect.left, width: rect.width }
    const a = shapeOf(sel.anchorNode)
    if (!a) { this.opts.onSelection(null); return }
    const p = paraOf(sel.anchorNode)
    if (a !== shapeOf(sel.focusNode) || !p || p !== paraOf(sel.focusNode)) {
      this.opts.onSelection({ node_id: '', snippet: '', blocked: a !== shapeOf(sel.focusNode) ? '评论只能选在一个形状内' : '评论只能选在一个段落内；要评论整个形状请单击它', rect: at })
      return
    }
    const r = sel.getRangeAt(0)
    const from = pmOffset(p, r.startContainer, r.startOffset)
    const to = pmOffset(p, r.endContainer, r.endOffset)
    const model = this.paras.get(`${a.dataset.id}#${p.dataset.p}`)
    if (from === null || to === null || from >= to || !model) { this.opts.onSelection(null); return }
    // 引用文字按模型算（与服务端同一规则），不含渲染出来的 [n] 角标
    const snippet = paragraphSlice(model, from, to)
    if (!snippet.trim()) { this.opts.onSelection(null); return }
    this.opts.onSelection({ node_id: a.dataset.id!, snippet, paragraph: Number(p.dataset.p), range: { from, to }, rect: at })
  }

  private select(ids: string[]): void {
    const changed = ids.join(',') !== this.selected.join(',')
    this.selected = ids
    this.mount.querySelectorAll('.shape.selected').forEach(el => el.classList.remove('selected'))
    for (const id of ids) this.shapeEl(id)?.classList.add('selected')
    this.drawSelection()
    if (changed) this.opts.onSelectShape?.(ids[0] ?? null)
  }

  flash(ids: string[]): void {
    setTimeout(() => {
      for (const id of ids) this.mount.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('ai-flash')
      setTimeout(() => this.mount.querySelectorAll('.ai-flash').forEach(el => el.classList.remove('ai-flash')), 2200)
    }, 50)
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKey)
    this.resize.disconnect()
    this.mount.innerHTML = ''
  }
}

/** 浏览器选区端点 → 段落内的模型偏移（按 data-o 标注换算；引用角标整体算一个单位）。 */
function pmOffset(p: HTMLElement, node: Node, offset: number): number | null {
  const el = node.nodeType === 3 ? node.parentElement : node as HTMLElement
  if (!el || !p.contains(el)) return null
  if (el === p) {
    const kid = p.childNodes[offset] as HTMLElement | undefined
    return kid?.dataset?.o !== undefined ? Number(kid.dataset.o) : Number(p.dataset.len ?? 0)
  }
  const run = el.closest('[data-o]') as HTMLElement | null
  if (!run || !p.contains(run)) return null
  const o = Number(run.dataset.o)
  if (run.dataset.atom !== undefined || run.tagName === 'BR') return offset === 0 ? o : o + 1
  if (node.nodeType === 3) return o + offset
  return offset === 0 ? o : o + (run.textContent ?? '').length
}

/** 段落模型 [from, to) 的文字：硬换行记作换行，引用不计文字（同服务端 paragraphText）。 */
function paragraphSlice(p: PMJson, from: number, to: number): string {
  let out = ''
  let pos = 0
  for (const c of p.content ?? []) {
    const len = c.type === 'text' ? (c.text ?? '').length : 1
    const a = Math.max(from, pos)
    const b = Math.min(to, pos + len)
    if (a < b) out += c.type === 'text' ? c.text!.slice(a - pos, b - pos) : c.type === 'hard_break' ? '\n' : ''
    pos += len
  }
  return out
}

/** 纯文字转成行内 markdown（转义会被当成格式的字符）。 */
const escapeMd = (text: string) => text.replace(/([\\*_`[\]<>])/g, '\\$1')

/** 模型段落 → 编辑提交用的文字（与 domParagraphs 同一写法，用来判断改没改）。 */
function modelText(p: PMJson): string {
  return (p.content ?? []).map(c => c.type === 'text' ? escapeMd(c.text ?? '') : c.type === 'citation' ? `[@c:${c.attrs!.cite_id}]` : c.type === 'hard_break' ? '<br>' : '').join('')
}

/** 编辑后的 DOM → 段落（文字转义；引用角标还原成 [@c:id]；换行写 <br>）。浏览器可能把输入包成 div 或裸文字，一并算段落。 */
function domParagraphs(container: HTMLElement): Array<{ text: string; lvl: number }> {
  const out: Array<{ text: string; lvl: number }> = []
  const inline = (node: Node): string => {
    let s = ''
    node.childNodes.forEach((c, i) => {
      if (c.nodeType === 3) s += escapeMd((c.textContent ?? '').replace(/\u00a0/g, ' '))
      else if (c instanceof HTMLElement) {
        if (c.tagName === 'BR') { if (i < node.childNodes.length - 1) s += '<br>' }
        else if (c.dataset.cite) s += `[@c:${c.dataset.cite}]`
        else s += inline(c)
      }
    })
    return s
  }
  container.childNodes.forEach(c => {
    if (c instanceof HTMLElement && (c.tagName === 'P' || c.tagName === 'DIV')) out.push({ text: inline(c).replace(/^ $/, ''), lvl: Number(c.dataset.lvl ?? 0) })
    else if (c.nodeType === 3 && (c.textContent ?? '').trim()) out.push({ text: escapeMd(c.textContent!.trim()), lvl: 0 })
  })
  return out
}

const CHART_COLORS = ['0EA5E9', 'F59E0B', '10B981', '8B5CF6', 'EF4444', '64748B']

/** 图表的近似预览（SVG）：柱 / 条 / 折线 / 面积 / 饼 / 圆环；其他类型画柱状。精确效果看 LibreOffice 预览。 */
export function chartSvg(c: ChartData, w: number, h: number): string {
  const color = (i: number) => `#${c.colors?.[i] || CHART_COLORS[i % CHART_COLORS.length]}`
  const fs = Math.max(8, Math.min(14, h / 22))
  const titleH = c.title ? fs * 1.8 : 0
  const legendH = fs * 1.8
  const title = c.title ? `<text x="${w / 2}" y="${fs * 1.3}" font-size="${fs * 1.1}" font-weight="600" text-anchor="middle" fill="currentColor">${esc(c.title)}</text>` : ''
  const round = c.type === 'pie' || c.type === 'doughnut'
  const legendItems = round ? c.categories : c.series.map(s => s.name)
  const itemW = Math.min(90, w / Math.max(1, legendItems.length))
  const legend = legendItems.map((name, i) => {
    const x = w / 2 - (legendItems.length * itemW) / 2 + i * itemW
    return `<rect x="${x}" y="${h - legendH + fs * 0.3}" width="${fs * 0.8}" height="${fs * 0.8}" fill="${color(i)}"/><text x="${x + fs}" y="${h - legendH + fs * 1.05}" font-size="${fs * 0.85}" fill="currentColor">${esc(name.slice(0, 10))}</text>`
  }).join('')
  const top = titleH + fs * 0.5
  const bottom = h - legendH
  let body = ''
  if (round) {
    const values = (c.series[0]?.values ?? []).map(v => Math.max(0, v ?? 0))
    const total = values.reduce((a, b) => a + b, 0) || 1
    const r = Math.max(4, Math.min(w, bottom - top) / 2 - 4)
    const cx = w / 2
    const cy = (top + bottom) / 2
    let angle = -Math.PI / 2
    body = values.map((v, i) => {
      const a2 = angle + (v / total) * Math.PI * 2
      const large = a2 - angle > Math.PI ? 1 : 0
      const p1 = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)]
      const p2 = [cx + r * Math.cos(a2), cy + r * Math.sin(a2)]
      angle = a2
      if (v >= total) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color(i)}"/>`
      return `<path d="M${cx},${cy} L${p1[0]},${p1[1]} A${r},${r} 0 ${large} 1 ${p2[0]},${p2[1]} Z" fill="${color(i)}" stroke="#fff" stroke-width="1"/>`
    }).join('')
    if (c.type === 'doughnut') body += `<circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="#fff"/>`
  } else {
    const all = c.series.flatMap(s => s.values).filter((v): v is number => v !== null)
    const max = Math.max(0, ...all)
    const min = Math.min(0, ...all)
    const span = max - min || 1
    const left = fs * 3
    const plotW = w - left - fs
    const plotH = bottom - top - fs * 1.6
    const n = c.categories.length || 1
    const horizontal = c.type === 'bar'
    const y = (v: number) => top + plotH - ((v - min) / span) * plotH
    const grid = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const v = min + span * f
      const yy = y(v)
      return horizontal ? '' : `<line x1="${left}" x2="${w - fs}" y1="${yy}" y2="${yy}" stroke="currentColor" stroke-opacity=".12"/><text x="${left - 4}" y="${yy + fs * 0.35}" font-size="${fs * 0.8}" text-anchor="end" fill="currentColor" fill-opacity=".7">${+v.toFixed(2)}</text>`
    }).join('')
    const labels = c.categories.map((cat, ci) => horizontal
      ? `<text x="${left - 4}" y="${top + (ci + 0.5) * (plotH / n) + fs * 0.35}" font-size="${fs * 0.8}" text-anchor="end" fill="currentColor">${esc(cat.slice(0, 8))}</text>`
      : `<text x="${left + (ci + 0.5) * (plotW / n)}" y="${top + plotH + fs * 1.2}" font-size="${fs * 0.8}" text-anchor="middle" fill="currentColor">${esc(cat.slice(0, 10))}</text>`).join('')
    if (c.type === 'line' || c.type === 'area') {
      body = c.series.map((s, si) => {
        const pts = s.values.map((v, ci) => v === null ? null : [left + (ci + 0.5) * (plotW / n), y(v)] as const).filter((p): p is readonly [number, number] => !!p)
        if (pts.length === 0) return ''
        const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ')
        const area = c.type === 'area' ? `<path d="${line} L${pts.at(-1)![0]},${y(Math.max(min, 0))} L${pts[0]![0]},${y(Math.max(min, 0))} Z" fill="${color(si)}" fill-opacity=".35"/>` : ''
        return `${area}<path d="${line}" fill="none" stroke="${color(si)}" stroke-width="2"/>${c.type === 'line' ? pts.map(p => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="${color(si)}"/>`).join('') : ''}`
      }).join('')
    } else {
      const groupW = (horizontal ? plotH : plotW) / n
      const barW = (groupW * 0.75) / Math.max(1, c.series.length)
      const zero = horizontal ? left + ((0 - min) / span) * plotW : y(0)
      body = c.categories.map((_, ci) => c.series.map((s, si) => {
        const v = s.values[ci]
        if (v === null || v === undefined) return ''
        const offset = ci * groupW + groupW * 0.125 + si * barW
        if (horizontal) {
          const x2 = left + ((v - min) / span) * plotW
          return `<rect x="${Math.min(zero, x2)}" y="${top + offset}" width="${Math.abs(x2 - zero)}" height="${barW * 0.9}" fill="${color(si)}"/>`
        }
        const yy = y(v)
        return `<rect x="${left + offset}" y="${Math.min(zero, yy)}" width="${barW * 0.9}" height="${Math.abs(zero - yy)}" fill="${color(si)}"/>`
      }).join('')).join('')
    }
    body = grid + body + labels
  }
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${title}${body}${legend}</svg>`
}

/** 深色背景（图表的坐标轴与文字用浅色）。 */
function isDark(hex: string): boolean {
  const n = parseInt(hex, 16)
  return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 128
}
