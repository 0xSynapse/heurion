/**
 * 原版 PDF 视图（docs/design/PDF_ORIGINAL_VIEW.md）：PDF 导入的文档按原样逐页显示（只读）。
 *
 * - 页面用 pdf.js 画在 canvas 上（打开原版视图时才加载 pdf.js）；选区与高亮用我们自己的词层：词来自导入时存下的原版映射，
 *   与「块文字 → 词」的对齐是同一份数据，选中的词能准确换回转换稿里的块与文字。
 * - 评论仍然只有一种锚点（转换稿里的 comment mark / 块 id）：这里只把锚定的文字画到原版上，新建评论也走同一个接口。
 */
import type { Node as PMNode } from 'prosemirror-model'
import type { SelectionAnchor } from './editor.ts'
import { findQuoteWords, type Word } from './quote-match.ts'
interface SourceMap {
  version: 1
  /** rot：解析时为转正竖排页额外加的旋转（顺时针度数），渲染时同样转，词坐标按转正后的页面 */
  pages: Array<{ w: number; h: number; rot?: number }>
  words: Word[]
  nodes: Record<string, { text?: string; spans?: number[][]; regions?: number[][] }>
}
export interface OriginalComment {
  id: string
  status: string
  node_id: string
  snippet?: string
  anchor?: { located?: boolean; node_ids?: string[]; text?: string }
}

export interface OriginalViewOptions {
  docId: string
  /** 带登录凭据取二进制 / JSON */
  fetchBytes: (path: string) => Promise<ArrayBuffer>
  fetchJson: (path: string) => Promise<any>
  /** 转换稿当前的文档（算段落内位置用；拿不到时只提交文字，由服务端查找） */
  currentDoc: () => PMNode | null
  onSelection: (anchor: SelectionAnchor | null) => void
  onCommentClick: (id: string) => void
}

const MAX_WIDTH = 920

export class OriginalView {
  readonly el: HTMLElement
  private map: SourceMap | null = null
  private pdf: any = null
  /** 每页的缩放：各页按可用宽度放满（横向页比竖向页宽，用同一个比例会超出视图） */
  private scales: number[] = []
  private scaleOf(page: number): number { return this.scales[page - 1] ?? this.scales[0] ?? 1 }
  private pagesEl: HTMLElement[] = []
  /** 词 → 它在哪些块的哪段文字里 */
  private wordOwners = new Map<number, Array<{ node: string; s: number; e: number }>>()
  private comments: OriginalComment[] = []
  private observer: IntersectionObserver | null = null
  private destroyed = false

  constructor(private readonly opts: OriginalViewOptions) {
    this.el = document.createElement('div')
    this.el.className = 'orig-view'
    this.el.innerHTML = '<div class="orig-status">正在加载原版 PDF…</div>'
    this.el.addEventListener('mouseup', () => setTimeout(() => this.onMouseUp(), 0))
    this.el.addEventListener('click', e => {
      const hl = (e.target as HTMLElement).closest<HTMLElement>('[data-thread]')
      if (hl && !window.getSelection()?.toString()) this.opts.onCommentClick(hl.dataset.thread!)
    })
  }

  async load(mapped: boolean): Promise<void> {
    try {
      const [bytes, map] = await Promise.all([
        this.opts.fetchBytes(`/api/docs/${this.opts.docId}/original.pdf`),
        mapped ? this.opts.fetchJson(`/api/docs/${this.opts.docId}/source-map`).catch(() => null) : Promise.resolve(null),
      ])
      if (this.destroyed) return
      this.map = map as SourceMap | null
      const pdfjs = await import('pdfjs-dist')
      const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
      pdfjs.GlobalWorkerOptions.workerSrc = worker
      // 不执行 PDF 里的脚本、不加载远程资源（CVE-2024-4367 之类的字体脚本问题由 isEvalSupported:false 关掉）
      this.pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, enableXfa: false }).promise
      if (this.destroyed) return
      this.indexWords()
      await this.layout()
    } catch (err) {
      this.el.innerHTML = `<div class="orig-status err">原版 PDF 加载失败：${escapeHtml((err as Error).message)}</div>`
    }
  }

  destroy(): void {
    this.destroyed = true
    this.observer?.disconnect()
    void this.pdf?.destroy?.()
    this.el.remove()
  }

  /** 评论（及深度审稿的批注）变了：重画高亮 */
  setComments(comments: OriginalComment[]): void {
    this.comments = comments
    this.drawHighlights()
  }

  /** 滚到某条评论在原版上的位置；找不到时返回 false */
  scrollToComment(id: string): boolean {
    const el = this.el.querySelector<HTMLElement>(`.orig-hl[data-thread="${CSS.escape(id)}"]`)
    if (!el) return false
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    this.el.querySelectorAll('.orig-hl.focus').forEach(x => x.classList.remove('focus'))
    this.el.querySelectorAll(`.orig-hl[data-thread="${CSS.escape(id)}"]`).forEach(x => x.classList.add('focus'))
    return true
  }

  /** 滚到某个块（转换稿里「在原版中查看」） */
  scrollToNode(nodeId: string): boolean {
    const r = this.map?.nodes[nodeId]?.regions?.[0]
    if (!r) return false
    const page = this.pagesEl[r[0]! - 1]
    if (!page) return false
    this.el.scrollTo({ top: page.offsetTop + r[2]! * this.scaleOf(r[0]!) - 80, behavior: 'smooth' })
    return true
  }

  // —— 内部 ——

  private indexWords(): void {
    this.wordOwners.clear()
    for (const [node, n] of Object.entries(this.map?.nodes ?? {})) {
      for (const [s, e, w] of n.spans ?? []) {
        const list = this.wordOwners.get(w!) ?? []
        list.push({ node, s: s!, e: e! })
        this.wordOwners.set(w!, list)
      }
    }
  }

  private async layout(): Promise<void> {
    const n = this.pdf.numPages as number
    const first = await this.pdf.getPage(1)
    const vp0 = first.getViewport({ scale: 1, rotation: this.rotationOf(first, 1) })
    const avail = Math.min(MAX_WIDTH, (this.el.clientWidth || MAX_WIDTH) - 48)
    this.scales = []
    this.el.innerHTML = ''
    if (!this.map) {
      const note = document.createElement('div')
      note.className = 'orig-status'
      note.textContent = '这份文档没有原版对照信息（兜底解析导入或早期导入）：只能查看原版，评论与审稿标注不显示在原版上。'
      this.el.append(note)
    }
    this.pagesEl = []
    for (let i = 1; i <= n; i++) {
      const size = this.map?.pages[i - 1]
      const s = avail / (size?.w ?? vp0.width)
      this.scales.push(s)
      const w = (size?.w ?? vp0.width) * s
      const h = (size?.h ?? vp0.height) * s
      const page = document.createElement('div')
      page.className = 'orig-page'
      page.dataset.page = String(i)
      page.style.width = `${w}px`
      page.style.height = `${h}px`
      page.innerHTML = '<canvas></canvas><div class="orig-hls"></div><div class="orig-words"></div>'
      this.el.append(page)
      this.pagesEl.push(page)
    }
    this.renderWords()
    this.drawHighlights()
    // 页面进入可视区附近时才画
    this.observer = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        const el = en.target as HTMLElement
        this.observer?.unobserve(el)
        void this.renderPage(Number(el.dataset.page), el)
      }
    }, { root: this.el, rootMargin: '1200px 0px' })
    for (const p of this.pagesEl) this.observer.observe(p)
  }

  private rotationOf(page: any, no: number): number {
    return ((page.rotate ?? 0) + (this.map?.pages[no - 1]?.rot ?? 0)) % 360
  }

  private async renderPage(no: number, el: HTMLElement): Promise<void> {
    const page = await this.pdf.getPage(no)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const vp = page.getViewport({ scale: this.scaleOf(no) * dpr, rotation: this.rotationOf(page, no) })
    const canvas = el.querySelector('canvas')!
    canvas.width = Math.floor(vp.width)
    canvas.height = Math.floor(vp.height)
    canvas.style.width = el.style.width
    canvas.style.height = el.style.height
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp }).promise
  }

  /** 词层：透明文字盖在页面上，浏览器原生选区；没对上任何块的词（页眉、图里的字）也能选，但不能评论 */
  private renderWords(): void {
    if (!this.map) return
    const frags = this.pagesEl.map(() => document.createDocumentFragment())
    this.map.words.forEach(([p, l, t, r, b, text], i) => {
      const f = frags[p - 1]
      if (!f) return
      const s = this.scaleOf(p)
      const span = document.createElement('span')
      span.dataset.w = String(i)
      span.textContent = `${text} `
      const h = (b - t) * s
      span.style.cssText = `left:${l * s}px;top:${t * s}px;width:${Math.max(1, (r - l) * s)}px;height:${h}px;font-size:${h * 0.85}px`
      if (!this.wordOwners.has(i)) span.classList.add('free')
      f.append(span)
    })
    this.pagesEl.forEach((p, i) => p.querySelector('.orig-words')!.append(frags[i]!))
  }

  private drawHighlights(): void {
    if (!this.map || !this.pagesEl.length) return
    for (const p of this.pagesEl) p.querySelector('.orig-hls')!.innerHTML = ''
    const add = (page: number, box: number[], thread: string, cls: string) => {
      const host = this.pagesEl[page - 1]?.querySelector('.orig-hls')
      if (!host) return
      const s = this.scaleOf(page)
      const d = document.createElement('div')
      d.className = `orig-hl ${cls}`
      d.dataset.thread = thread
      d.style.cssText = `left:${box[0]! * s - 1}px;top:${box[1]! * s - 1}px;width:${(box[2]! - box[0]!) * s + 2}px;height:${(box[3]! - box[1]!) * s + 2}px`
      host.append(d)
    }
    for (const c of this.comments) {
      if (c.status !== 'open' || c.anchor?.located === false) continue
      // 整张表 / 整块的评论锚在许多单元格段落上：按评论记的块画；锚在一个段落里的按那个段落
      const ids = c.anchor?.node_ids ?? []
      const nodeId = ids.length === 1 ? ids[0]! : c.node_id
      const n = this.map.nodes[nodeId] ?? this.map.nodes[c.node_id]
      if (!n) continue
      const quote = (c.anchor?.text ?? c.snippet ?? '').trim()
      const at = quote && n.text ? n.text.indexOf(quote) : -1
      if (at >= 0 && n.spans) {
        // 锚定文字 → 词 → 按行合并的框
        const words = [...new Set(n.spans.filter(([a, b]) => a! < at + quote.length && b! > at).map(x => x[2]!))].sort((x, y) => x - y)
        for (const line of mergeLines(words.map(w => this.map!.words[w]!))) add(line[0]!, line.slice(1), c.id, 'text')
      } else {
        // 块在转换稿里改过、或锚在整块（表格意见按图像重新识别后锚在整张表）：在块的区域里按文字找；
        // 先找评论记下的文字（表格意见是单元格文字），再找锚定的文字；都找不到才画块的区域
        const regions = n.regions ?? []
        const hit = [c.snippet, c.anchor?.text].map(q => (q ?? '').trim()).filter(q => q && q.length < 400)
          .map(q => findQuoteWords(this.map!.words, regions, q)).find(Boolean)
        if (hit) for (const line of mergeLines(hit.map(w => this.map!.words[w]!))) add(line[0]!, line.slice(1), c.id, 'text')
        else for (const r of regions) add(r[0]!, r.slice(1), c.id, 'block')
      }
    }
  }

  private onMouseUp(): void {
    const sel = window.getSelection()
    if (!this.map || !sel || sel.isCollapsed || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    if (!this.el.contains(range.commonAncestorContainer)) return
    const picked = [...this.el.querySelectorAll<HTMLElement>('.orig-words span')].filter(sp => range.intersectsNode(sp))
    if (!picked.length) return
    const rect = range.getBoundingClientRect()
    const at = { top: rect.top, left: rect.left, width: rect.width }
    const owners = picked.flatMap(sp => this.wordOwners.get(Number(sp.dataset.w)) ?? [])
    const nodes = new Set(owners.map(o => o.node))
    if (!nodes.size) { this.opts.onSelection({ node_id: '', snippet: '', blocked: '这部分没有导入正文（页眉、图里的文字），不能评论', rect: at }); return }
    if (nodes.size > 1) { this.opts.onSelection({ node_id: '', snippet: '', blocked: '评论只能选在一个段落内', rect: at }); return }
    const nodeId = [...nodes][0]!
    const n = this.map.nodes[nodeId]!
    const s = Math.min(...owners.map(o => o.s))
    const e = Math.max(...owners.map(o => o.e))
    const snippet = (n.text ?? '').slice(s, e).trim()
    if (!snippet) return
    this.opts.onSelection({ node_id: nodeId, snippet, ...this.rangeIn(nodeId, n.text ?? '', s, e), rect: at })
  }

  /** 转换稿里这段文字没改过时，给出段落内位置（与编辑器选区同一规则：硬换行算一个字、引用等原子不算字）；改过时只给文字 */
  private rangeIn(nodeId: string, importText: string, s: number, e: number): { range?: { from: number; to: number } } {
    const doc = this.opts.currentDoc()
    if (!doc) return {}
    let node: PMNode | null = null
    doc.descendants(n => { if (!node && n.attrs?.id === nodeId) node = n; return !node })
    const block = node as PMNode | null
    if (!block || !block.isTextblock || block.textContent !== importText) return {}
    let text = 0
    let from = -1, to = -1
    block.forEach((child, offset) => {
      const len = child.isText ? child.text!.length : child.type.name === 'hard_break' ? 1 : 0
      if (from < 0 && s < text + len) from = offset + (child.isText ? s - text : 0)
      if (to < 0 && e <= text + len) to = offset + (child.isText ? e - text : child.nodeSize)
      text += len
    })
    return from >= 0 && to > from ? { range: { from, to } } : {}
  }
}

/** 同一行（上下重叠一半以上、左右相邻）的词框合成一个：[页, 左, 上, 右, 下] */
function mergeLines(words: Word[]): number[][] {
  const out: number[][] = []
  for (const [p, l, t, r, b] of words) {
    const last = out[out.length - 1]
    if (last && last[0] === p && Math.min(last[4]!, b) - Math.max(last[2]!, t) > (b - t) / 2 && l - last[3]! < (b - t) * 1.5 && l >= last[1]!) {
      last[3] = Math.max(last[3]!, r); last[2] = Math.min(last[2]!, t); last[4] = Math.max(last[4]!, b)
    } else out.push([p, l, t, r, b])
  }
  return out
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
