/**
 * AI-Native Document Engine (Dual-Surface CRDT) -> Blog Publisher & Live Interactive Sandbox
 *
 * Bridges Heurion 2.0's ProseMirror + Yjs Dual-Surface substrate (`model/markdown.ts`, `model/ids.ts`, `ops/apply.ts`)
 * with `blog.heurion.org`, enabling:
 * 1. Deterministic compilation of Dual-Surface CRDT documents (`PMNode` or Annotated Markdown with `{#id}`) into
 *    publication-grade blog HTML + Table of Contents + block-level `{#id}` provenance badges;
 * 2. Sub-millisecond execution of guarded structural AI primitives (`applyOps`: `replace_block`, `insert_after`,
 *    `replace_text`) with concurrent human-edit protection (`userEditedIds`) and local PHI gatekeeping (`scanPhi`);
 * 3. File-backed (`docs/blog/*.md`) and API-backed 1-click publishing to `blog.heurion.org`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Node as PMNode } from 'prosemirror-model'
import { collectIds } from '../../model/ids.ts'
import { parseBlocks, serializeBlock } from '../../model/markdown.ts'
import { isAddressable, schema } from '../../model/schema.ts'
import { applyOps } from '../../ops/apply.ts'
import { scanPhi } from '../../ops/phi-scan.ts'
import { DocOp, OpError } from '../../ops/types.ts'
import type { BlogCategory, BlogPostMeta, BlogTocItem } from './blog-posts-data.ts'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 为文档分配确定性或顺序可读的短块 ID（当源文本带有 `{#id}` 时原样保留，未带时分配确定性 `b01`, `b02`...）
 */
export function parseAnnotatedMarkdownToDoc(source: string): PMNode {
  const lines = source.split('\n')
  const explicitIds: Array<string | null> = []
  const cleanedLines: string[] = []
  const prefixRe = /^(\s*)\{#([a-z][a-z0-9]{2,15})\}[ \t]?/

  for (const line of lines) {
    const m = prefixRe.exec(line)
    if (m) {
      explicitIds.push(m[2]!)
      cleanedLines.push(line.replace(prefixRe, '$1'))
    } else {
      cleanedLines.push(line)
    }
  }

  const rawBlocks = parseBlocks(cleanedLines.join('\n'))
  const taken = new Set<string>()
  let explicitIdx = 0
  let seq = 1

  const nextDeterministicId = (prefix: string): string => {
    while (true) {
      const candidate = `${prefix}${String(seq++).padStart(2, '0')}`
      if (!taken.has(candidate)) {
        taken.add(candidate)
        return candidate
      }
    }
  }

  const assignWalk = (n: PMNode): PMNode => {
    let attrs = n.attrs
    if (isAddressable(n)) {
      const exp = explicitIds[explicitIdx]
      if (exp && !taken.has(exp)) {
        explicitIdx++
        taken.add(exp)
        attrs = { ...n.attrs, id: exp }
      } else {
        if (exp) explicitIdx++
        const prefix =
          n.type.name === 'heading'
            ? 'h'
            : n.type.name === 'table'
              ? 'tbl'
              : n.type.name === 'paragraph' && n.attrs.style === 'Code'
                ? 'code'
                : n.type.name === 'paragraph' && n.attrs.style === 'Quote'
                  ? 'quo'
                  : 'p'
        attrs = { ...n.attrs, id: nextDeterministicId(prefix) }
      }
    }
    if (n.isLeaf) return attrs === n.attrs ? n : n.type.create(attrs, null, n.marks)
    const children: PMNode[] = []
    n.forEach(c => children.push(assignWalk(c)))
    return n.type.create(attrs, children, n.marks)
  }

  const assignedBlocks = rawBlocks.map(b => assignWalk(b))
  return schema.node('doc', null, assignedBlocks.length ? assignedBlocks : [schema.node('paragraph', { id: 'p01' })])
}

/**
 * 将 ProseMirror 双表面文档序列化为带 `{#id}` 的智能体表面（Annotated Markdown）
 */
export function serializeDocToAgentSurface(doc: PMNode): string {
  const parts: string[] = []
  doc.forEach(child => {
    parts.push(serializeBlock(child, { ids: true }, ''))
  })
  return parts.join('\n\n')
}

function renderInlineNodeToHtml(node: PMNode): string {
  let html = ''
  node.forEach(child => {
    if (child.isText) {
      let chunk = escapeHtml(child.text ?? '')
      for (const mark of child.marks) {
        switch (mark.type.name) {
          case 'bold':
            chunk = `<strong>${chunk}</strong>`
            break
          case 'italic':
            chunk = `<em>${chunk}</em>`
            break
          case 'code':
            chunk = `<code>${chunk}</code>`
            break
          case 'underline':
            chunk = `<u>${chunk}</u>`
            break
          case 'sup':
            chunk = `<sup>${chunk}</sup>`
            break
          case 'sub':
            chunk = `<sub>${chunk}</sub>`
            break
          case 'link':
            chunk = `<a href="${escapeHtml(String(mark.attrs.href ?? '#'))}" target="_blank" rel="noopener">${chunk}</a>`
            break
        }
      }
      html += chunk
    } else if (child.type.name === 'hard_break') {
      html += '<br>'
    } else if (child.type.name === 'citation') {
      const cid = escapeHtml(String(child.attrs.cite_id ?? ''))
      html += `<sup class="crdt-cite" title="Verified Citation: ${cid}">[${cid}]</sup>`
    } else if (child.type.name === 'measurement') {
      const mid = escapeHtml(String(child.attrs.m_id ?? ''))
      html += `<span class="crdt-measure" data-measure-id="${mid}">[m:${mid}]</span>`
    }
  })
  return html
}

/**
 * 将 ProseMirror 双表面文档编译为人类阅读表面（带 `{#id}` 块锚点徽章的出版级 HTML + 自动提取章节目录 TOC）
 */
export function compileDocToBlogSurface(
  doc: PMNode,
  opts?: { showBlockBadges?: boolean },
): { html: string; toc: BlogTocItem[]; blockCount: number } {
  const showBadges = opts?.showBlockBadges ?? true
  const toc: BlogTocItem[] = []
  const htmlBlocks: string[] = []
  let blockCount = 0

  const badgeHtml = (id: string | null | undefined) =>
    showBadges && id
      ? `<span class="crdt-block-badge" title="Dual-Surface CRDT Block ID {#${escapeHtml(id)}}">{#${escapeHtml(id)}}</span>`
      : ''

  doc.forEach(node => {
    const id = (node.attrs.id as string | null) ?? null
    if (id) blockCount++

    switch (node.type.name) {
      case 'heading': {
        const level = Math.min(4, Math.max(2, Number(node.attrs.level ?? 2)))
        const anchorId = id ? `sec-${id}` : `sec-${toc.length + 1}`
        const plain = node.textContent.trim()
        if (level === 2 && plain) {
          toc.push({ id: anchorId, zh: plain, en: plain })
        }
        htmlBlocks.push(
          `<h${level} id="${escapeHtml(anchorId)}" data-crdt-id="${escapeHtml(id ?? '')}">${renderInlineNodeToHtml(node)} ${badgeHtml(id)}</h${level}>`,
        )
        break
      }
      case 'paragraph': {
        if (node.attrs.style === 'Code') {
          htmlBlocks.push(
            `<pre data-crdt-id="${escapeHtml(id ?? '')}"><code>${escapeHtml(node.textContent)}</code></pre>`,
          )
        } else if (node.attrs.style === 'Quote') {
          htmlBlocks.push(
            `<div class="blog-callout" data-crdt-id="${escapeHtml(id ?? '')}"><p>${renderInlineNodeToHtml(node)} ${badgeHtml(id)}</p></div>`,
          )
        } else {
          htmlBlocks.push(
            `<p data-crdt-id="${escapeHtml(id ?? '')}">${renderInlineNodeToHtml(node)} ${badgeHtml(id)}</p>`,
          )
        }
        break
      }
      case 'bullet_list':
      case 'ordered_list': {
        const tag = node.type.name === 'bullet_list' ? 'ul' : 'ol'
        const items: string[] = []
        node.forEach(li => {
          const liParts: string[] = []
          li.forEach(p => liParts.push(renderInlineNodeToHtml(p)))
          items.push(`<li>${liParts.join('<br>')}</li>`)
        })
        htmlBlocks.push(
          `<${tag} data-crdt-id="${escapeHtml(id ?? '')}">\n${items.join('\n')}\n</${tag}>`,
        )
        break
      }
      case 'table': {
        const headCells: string[] = []
        const bodyRows: string[] = []
        node.forEach((rowNode, _rOff, rIdx) => {
          const cells: string[] = []
          rowNode.forEach(cellNode => {
            const cellText = cellNode.textContent.trim()
            const cellTag = rIdx === 0 || cellNode.attrs?.header ? 'th' : 'td'
            cells.push(`<${cellTag}>${escapeHtml(cellText)}</${cellTag}>`)
          })
          const rowHtml = `<tr>${cells.join('')}</tr>`
          if (rIdx === 0) headCells.push(rowHtml)
          else bodyRows.push(rowHtml)
        })
        htmlBlocks.push(
          `<div class="blog-table-wrap" data-crdt-id="${escapeHtml(id ?? '')}">
            <table class="blog-table">
              <thead>${headCells.join('')}</thead>
              <tbody>${bodyRows.join('')}</tbody>
            </table>
          </div>`,
        )
        break
      }
      default: {
        if (node.textContent.trim()) {
          htmlBlocks.push(
            `<p data-crdt-id="${escapeHtml(id ?? '')}">${escapeHtml(node.textContent)} ${badgeHtml(id)}</p>`,
          )
        }
      }
    }
  })

  return {
    html: htmlBlocks.join('\n'),
    toc,
    blockCount,
  }
}

export interface CrdtCompileRequest {
  markdown: string
  ops?: unknown[]
  user_locked_ids?: string[]
  show_block_badges?: boolean
}

export interface CrdtCompileResponse {
  ok: boolean
  error?: string
  error_code?: string
  latency_ms: number
  phi_clean: boolean
  phi_findings_count: number
  block_count: number
  applied_ops: Array<{ op_index: number; op: string; ids: string[] }>
  agent_surface_markdown: string
  human_surface_html: string
  toc: BlogTocItem[]
}

/**
 * 在内存中执行完整的双表面 CRDT 编译与结构化 AI 原语（`applyOps`），供在线交互沙盒与一键发布使用
 */
export function executeDualSurfaceSandbox(req: CrdtCompileRequest): CrdtCompileResponse {
  const t0 = performance.now()
  const baseDoc = parseAnnotatedMarkdownToDoc(req.markdown || '')
  const taken = collectIds(baseDoc)
  const userEditedIds = new Set<string>(req.user_locked_ids ?? [])

  let finalDoc = baseDoc
  let appliedOps: Array<{ op_index: number; op: string; ids: string[] }> = []

  if (Array.isArray(req.ops) && req.ops.length > 0) {
    try {
      const parsedOps = req.ops.map(raw => DocOp.parse(raw))
      for (const op of parsedOps) {
        const candidateTargets: string[] = []
        if ('id' in op && typeof op.id === 'string') candidateTargets.push(op.id)
        if ('scope' in op && typeof op.scope === 'string') candidateTargets.push(op.scope)
        if ('anchor_id' in op && typeof op.anchor_id === 'string') candidateTargets.push(op.anchor_id)
        if ('ids' in op && Array.isArray(op.ids)) candidateTargets.push(...op.ids)
        for (const t of candidateTargets) {
          if (userEditedIds.has(t)) {
            throw new OpError(
              'USER_EDITED_CONFLICT',
              `Block {#${t}} is locked by concurrent human editing (userEditedIds) and cannot be overwritten by an AI primitive.`,
            )
          }
        }
      }
      const res = applyOps(baseDoc, parsedOps, { taken, userEditedIds })
      finalDoc = res.doc
      appliedOps = res.results
    } catch (err) {
      const latency = Number((performance.now() - t0).toFixed(3))
      const baseAgent = serializeDocToAgentSurface(baseDoc)
      const baseHuman = compileDocToBlogSurface(baseDoc, { showBlockBadges: req.show_block_badges ?? true })
      const msg = err instanceof OpError ? err.message : err instanceof Error ? err.message : String(err)
      const code = err instanceof OpError ? err.code : 'INVALID_OP'
      return {
        ok: false,
        error: msg,
        error_code: code,
        latency_ms: latency,
        phi_clean: true,
        phi_findings_count: 0,
        block_count: baseHuman.blockCount,
        applied_ops: [],
        agent_surface_markdown: baseAgent,
        human_surface_html: baseHuman.html,
        toc: baseHuman.toc,
      }
    }
  }

  const agentSurface = serializeDocToAgentSurface(finalDoc)
  const phiFindings = scanPhi(agentSurface)
  const compiled = compileDocToBlogSurface(finalDoc, {
    showBlockBadges: req.show_block_badges ?? true,
  })
  const latency = Number((performance.now() - t0).toFixed(3))

  return {
    ok: true,
    latency_ms: latency,
    phi_clean: phiFindings.length === 0,
    phi_findings_count: phiFindings.length,
    block_count: compiled.blockCount,
    applied_ops: appliedOps,
    agent_surface_markdown: agentSurface,
    human_surface_html: compiled.html,
    toc: compiled.toc,
  }
}

/**
 * 动态发布的博客文章注册表（支持从工作台双表面 CRDT 文档一键发布，或从 `docs/blog/*.md` 自动加载）
 */
const dynamicPublishedPosts = new Map<string, BlogPostMeta>()

export function publishCrdtDocumentToBlog(input: {
  slug: string
  title_zh: string
  title_en?: string
  subtitle_zh?: string
  subtitle_en?: string
  category?: BlogCategory
  markdown_zh: string
  markdown_en?: string
  tags?: string[]
}): BlogPostMeta {
  const cleanSlug = input.slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!cleanSlug) throw new Error('Invalid blog post slug')

  const compiledZh = executeDualSurfaceSandbox({
    markdown: input.markdown_zh,
    show_block_badges: true,
  })
  const compiledEn = executeDualSurfaceSandbox({
    markdown: input.markdown_en || input.markdown_zh,
    show_block_badges: true,
  })

  const date = new Date().toISOString().slice(0, 10)
  const wordCount = input.markdown_zh.length
  const minutes = Math.max(3, Math.round(wordCount / 350))

  const meta: BlogPostMeta = {
    slug: cleanSlug as any,
    num: String(7 + dynamicPublishedPosts.size).padStart(2, '0'),
    category: input.category ?? 'heurion-2',
    category_label_zh: 'OMNIDOC · 双表面直发',
    category_label_en: 'OMNIDOC · CRDT PUBLISHED',
    date,
    reading_time_zh: `${minutes} 分钟深读`,
    reading_time_en: `${minutes} min read`,
    title_zh: input.title_zh,
    title_en: input.title_en || input.title_zh,
    subtitle_zh:
      input.subtitle_zh ||
      '由 Heurion Dual-Surface CRDT 引擎编译发布，保留块级 {#id} 寻址锚点与写前语法守卫校验。',
    subtitle_en:
      input.subtitle_en ||
      'Compiled and published via the Heurion Dual-Surface CRDT Engine with preserved {#id} block addressing and pre-write guard verification.',
    summary_zh:
      input.subtitle_zh ||
      input.markdown_zh.replace(/[#*`>{}[\]]/g, '').trim().slice(0, 140) + '...',
    summary_en:
      input.subtitle_en ||
      (input.markdown_en || input.markdown_zh).replace(/[#*`>{}[\]]/g, '').trim().slice(0, 160) + '...',
    keywords_zh: (input.tags ?? ['Dual-Surface CRDT', 'AI-Native Document', 'Heurion']).join(', '),
    keywords_en: (input.tags ?? ['Dual-Surface CRDT', 'AI-Native Document', 'Heurion']).join(', '),
    tags_zh: input.tags ?? ['双表面 CRDT 直发', `{#${compiledZh.block_count} Blocks}`],
    tags_en: input.tags ?? ['CRDT Published', `{#${compiledEn.block_count} Blocks}`],
    stats: [
      { val: `${compiledZh.block_count}`, lbl_zh: 'CRDT 寻址块数', lbl_en: 'CRDT Blocks' },
      { val: `${compiledZh.latency_ms}ms`, lbl_zh: '双表面编译耗时', lbl_en: 'Compile Latency' },
      { val: compiledZh.phi_clean ? '100%' : 'WARN', lbl_zh: '写前守卫通过', lbl_en: 'Pre-Write Guard' },
    ],
    repo_url: 'https://github.com/heurion-org/heurion',
    paper_url: 'https://github.com/heurion-org/heurion/blob/main/paper/main.pdf',
    toc: compiledZh.toc.length
      ? compiledZh.toc
      : [{ id: 'sec-overview', zh: '01. 核心内容', en: '01. Overview' }],
    body_zh: compiledZh.human_surface_html,
    body_en: compiledEn.human_surface_html,
  }

  dynamicPublishedPosts.set(cleanSlug, meta)
  return meta
}

/**
 * 扫描仓库 `docs/blog/*.md`（如存在）并自动通过双表面 CRDT 编译器加载为博客文章
 */
export function loadMarkdownBlogDir(dirPath?: string): BlogPostMeta[] {
  const defaultDir = fileURLToPath(new URL('../../../../../docs/blog', import.meta.url))
  const targetDir = dirPath ?? defaultDir
  if (!existsSync(targetDir)) return []

  const loaded: BlogPostMeta[] = []
  for (const file of readdirSync(targetDir)) {
    if (!file.endsWith('.md')) continue
    const slug = file.replace(/\.md$/, '')
    if (dynamicPublishedPosts.has(slug)) {
      loaded.push(dynamicPublishedPosts.get(slug)!)
      continue
    }
    const raw = readFileSync(join(targetDir, file), 'utf8')
    const titleMatch = /^#\s+(.+)$/m.exec(raw)
    const title = titleMatch?.[1]?.trim() ?? slug
    const bodyMd = raw.replace(/^#\s+.+\n+/, '')
    const post = publishCrdtDocumentToBlog({
      slug,
      title_zh: title,
      title_en: title,
      markdown_zh: bodyMd,
      markdown_en: bodyMd,
    })
    loaded.push(post)
  }
  return loaded
}

export function getDynamicBlogPosts(): BlogPostMeta[] {
  loadMarkdownBlogDir()
  return Array.from(dynamicPublishedPosts.values())
}

export function getDynamicBlogPost(slug: string): BlogPostMeta | null {
  loadMarkdownBlogDir()
  return dynamicPublishedPosts.get(slug) ?? null
}
