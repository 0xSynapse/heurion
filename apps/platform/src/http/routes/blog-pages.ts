/**
 * Heurion Research — Nordic Editorial Minimalist Technical Blog
 * Palette & Typography aligned with heurion.org (site.css v6).
 * Supports both standalone subdomain (https://blog.heurion.org) and main-site path (https://heurion.org/blog).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BLOG_POSTS,
  BLOG_SLUGS,
  isBlogSlug,
  type BlogPostMeta,
  type BlogSlug,
} from './blog-posts-data.ts'
import {
  executeDualSurfaceSandbox,
  getDynamicBlogPost,
  getDynamicBlogPosts,
  loadMarkdownBlogDir,
  publishCrdtDocumentToBlog,
} from './blog-publisher.ts'

export {
  BLOG_POSTS,
  BLOG_SLUGS,
  isBlogSlug,
  type BlogPostMeta,
  type BlogSlug,
  executeDualSurfaceSandbox,
  publishCrdtDocumentToBlog,
  loadMarkdownBlogDir,
}

export interface BlogComment {
  id: string
  slug: string
  author: string
  content: string
  created_at: string
}

const COMMENTS_FILE = fileURLToPath(new URL('../../../../../data/blog-comments.json', import.meta.url))
const commentsBySlug = new Map<string, BlogComment[]>()
let commentsLoaded = false

function ensureCommentsLoaded(): void {
  if (commentsLoaded) return
  commentsLoaded = true
  try {
    if (existsSync(COMMENTS_FILE)) {
      const raw = JSON.parse(readFileSync(COMMENTS_FILE, 'utf8')) as Record<string, BlogComment[]>
      for (const [slug, list] of Object.entries(raw)) {
        if (Array.isArray(list)) commentsBySlug.set(slug, list)
      }
    }
  } catch {
    // ignore read error
  }
}

function persistComments(): void {
  try {
    mkdirSync(dirname(COMMENTS_FILE), { recursive: true })
    const obj: Record<string, BlogComment[]> = {}
    for (const [slug, list] of commentsBySlug.entries()) {
      obj[slug] = list
    }
    writeFileSync(COMMENTS_FILE, JSON.stringify(obj, null, 2), 'utf8')
  } catch {
    // ignore write error in read-only sandboxes
  }
}

export function getBlogComments(slug: string): BlogComment[] {
  ensureCommentsLoaded()
  return commentsBySlug.get(slug) ?? []
}

export function addBlogComment(input: {
  slug: string
  author: string
  content: string
}): BlogComment {
  ensureCommentsLoaded()
  const slug = String(input.slug ?? '').trim()
  const author = String(input.author ?? '').trim().slice(0, 60) || 'Anonymous'
  const content = String(input.content ?? '').trim().slice(0, 2000)
  if (!slug) throw new Error('Missing post slug')
  if (!content) throw new Error('Comment content cannot be empty')

  const comment: BlogComment = {
    id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    slug,
    author,
    content,
    created_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
  }
  const existing = commentsBySlug.get(slug) ?? []
  existing.push(comment)
  commentsBySlug.set(slug, existing)
  persistComments()
  return comment
}

function getAllPostsMerged(): BlogPostMeta[] {
  const dynamic = getDynamicBlogPosts()
  if (dynamic.length === 0) return [...BLOG_POSTS]
  const bySlug = new Map<string, BlogPostMeta>()
  for (const p of BLOG_POSTS) bySlug.set(p.slug, p)
  for (const d of dynamic) bySlug.set(d.slug, d)
  return Array.from(bySlug.values())
}

function findBlogPostBySlug(slug: string): { post: BlogPostMeta; idx: number; all: BlogPostMeta[] } | null {
  const all = getAllPostsMerged()
  const idx = all.findIndex(p => p.slug === slug)
  if (idx !== -1) return { post: all[idx]!, idx, all }
  const dyn = getDynamicBlogPost(slug)
  if (dyn) return { post: dyn, idx: all.length, all: [...all, dyn] }
  return null
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function isBlogSubdomainHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const hostname = hostHeader.split(':')[0]!.trim().toLowerCase()
  return (
    hostname === 'blog.heurion.org' ||
    hostname === 'blog.localhost' ||
    hostname.startsWith('blog.')
  )
}

function buildBlogUrls(lang: 'zh' | 'en', subdomain: boolean, slug?: string) {
  const isEn = lang === 'en'
  const canonicalOrigin = 'https://blog.heurion.org'

  const homeHref = subdomain ? (isEn ? '/en' : '/') : isEn ? '/en/blog' : '/blog'
  const zhHomeHref = subdomain ? '/' : '/blog'
  const enHomeHref = subdomain ? '/en' : '/en/blog'
  const postHref = (s: string) =>
    subdomain ? (isEn ? `/en/${s}` : `/${s}`) : isEn ? `/en/blog/${s}` : `/blog/${s}`
  const zhPostHref = (s: string) => (subdomain ? `/${s}` : `/blog/${s}`)
  const enPostHref = (s: string) => (subdomain ? `/en/${s}` : `/en/blog/${s}`)
  const rssHref = subdomain
    ? isEn
      ? '/en/feed.xml'
      : '/feed.xml'
    : isEn
      ? '/en/blog/feed.xml'
      : '/blog/feed.xml'

  const canonicalUrl = slug
    ? isEn
      ? `${canonicalOrigin}/en/${slug}`
      : `${canonicalOrigin}/${slug}`
    : isEn
      ? `${canonicalOrigin}/en`
      : `${canonicalOrigin}/`
  const zhCanonicalUrl = slug ? `${canonicalOrigin}/${slug}` : `${canonicalOrigin}/`
  const enCanonicalUrl = slug ? `${canonicalOrigin}/en/${slug}` : `${canonicalOrigin}/en`

  return {
    homeHref,
    zhHomeHref,
    enHomeHref,
    postHref,
    zhPostHref,
    enPostHref,
    rssHref,
    canonicalUrl,
    zhCanonicalUrl,
    enCanonicalUrl,
  }
}

const HEURION_EDITORIAL_BLOG_STYLES = `
  :root {
    --bg-primary: #FAF8F4;
    --bg-neutral: #EFECE4;
    --bg-elevated: #FDFCF9;
    --ink: #151C19;
    --ink-secondary: #4A534E;
    --ink-muted: #646D68;
    --accent: #233E33;
    --heurion-mint: #00C472;
    --accent-warm: #8F5638;
    --accent-soft: #E3ECE7;
    --border: #DFDAD0;
    --border-strong: #151C19;

    --serif: 'Newsreader', 'Noto Serif SC', 'Songti SC', 'STSong', Georgia, serif;
    --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Microsoft YaHei', sans-serif;
    --mono: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  html {
    scroll-behavior: smooth;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  body {
    margin: 0;
    background-color: var(--bg-primary);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 16px;
    line-height: 1.75;
    font-weight: 400;
  }

  ::selection {
    background: var(--accent-soft);
    color: var(--accent);
  }

  a {
    color: inherit;
    text-decoration: none;
    transition: color 0.18s ease, border-color 0.18s ease, background-color 0.18s ease;
  }

  /* Top Navigation Bar (matched to heurion.org) */
  .top-nav {
    position: sticky;
    top: 0;
    z-index: 50;
    background: rgba(250, 248, 244, 0.92);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
  }
  .top-nav-inner {
    max-width: 780px;
    margin: 0 auto;
    padding: 0.95rem 1.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    color: var(--ink);
  }
  .brand-mark {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }
  .mark-bar { fill: var(--ink); }
  .mark-accent { fill: var(--heurion-mint); }
  .brand-text {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
  }
  .brand-name {
    font-family: var(--serif);
    font-size: 1.08rem;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--ink);
  }
  .brand-role {
    font-size: 0.78rem;
    color: var(--ink-muted);
  }
  .nav-links {
    display: flex;
    align-items: center;
    gap: 1.15rem;
    font-size: 0.82rem;
    color: var(--ink-secondary);
  }
  .nav-links a:hover {
    color: var(--accent);
  }
  .lang-switch {
    font-family: var(--mono);
    font-size: 0.73rem;
    padding: 0.2rem 0.55rem;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--ink);
  }
  .lang-switch:hover {
    border-color: var(--ink);
  }

  /* Main Container */
  .wrap {
    max-width: 780px;
    margin: 0 auto;
    padding: 3.5rem 1.75rem 5.5rem;
  }

  /* Home Page Index Header */
  .index-intro {
    padding-bottom: 2rem;
    border-bottom: 1px solid var(--border-strong);
    margin-bottom: 0.5rem;
  }
  .index-eyebrow {
    font-family: var(--mono);
    font-size: 0.72rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 0.55rem;
  }
  .index-heading {
    font-family: var(--serif);
    font-size: clamp(1.65rem, 2.5vw, 2.1rem);
    font-weight: 400;
    line-height: 1.28;
    letter-spacing: -0.015em;
    margin: 0 0 0.45rem 0;
    color: var(--ink);
  }
  html[lang="zh-CN"] .index-heading {
    font-weight: 500;
  }
  .index-desc {
    font-size: 0.92rem;
    color: var(--ink-secondary);
    margin: 0;
  }

  /* Minimalist Editorial Post List */
  .post-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .post-row {
    border-bottom: 1px solid var(--border);
  }
  .post-row-link {
    display: grid;
    grid-template-columns: 7.5rem 1fr auto;
    align-items: baseline;
    gap: 1.5rem;
    padding: 1.35rem 0.25rem;
    transition: background-color 0.15s ease;
  }
  .post-row-link:hover .post-row-title {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 4px;
    text-decoration-thickness: 1px;
  }
  .post-row-link:hover .post-row-arrow {
    transform: translateX(3px);
    color: var(--accent);
  }
  .post-row-meta {
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--ink-muted);
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .post-row-num {
    color: var(--accent-warm);
    font-weight: 500;
  }
  .post-row-title {
    font-family: var(--serif);
    font-size: 1.18rem;
    font-weight: 400;
    line-height: 1.42;
    color: var(--ink);
    margin: 0;
    transition: color 0.15s ease;
  }
  html[lang="zh-CN"] .post-row-title {
    font-weight: 500;
    font-size: 1.12rem;
  }
  .post-row-arrow {
    font-family: var(--mono);
    font-size: 0.85rem;
    color: var(--ink-muted);
    transition: transform 0.15s ease, color 0.15s ease;
  }

  /* Single Article View */
  .article-header {
    padding-bottom: 2rem;
    margin-bottom: 2.5rem;
    border-bottom: 1px solid var(--border-strong);
  }
  .article-meta {
    font-family: var(--mono);
    font-size: 0.76rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-muted);
    margin-bottom: 0.85rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.65rem;
    align-items: center;
  }
  .article-meta-num {
    color: var(--accent-warm);
    font-weight: 500;
  }
  .article-title {
    font-family: var(--serif);
    font-size: clamp(1.75rem, 2.8vw, 2.3rem);
    font-weight: 400;
    line-height: 1.26;
    letter-spacing: -0.018em;
    color: var(--ink);
    margin: 0 0 1rem 0;
  }
  html[lang="zh-CN"] .article-title {
    font-weight: 500;
    line-height: 1.36;
  }
  .article-subtitle {
    font-size: 1.02rem;
    line-height: 1.68;
    color: var(--ink-secondary);
    margin: 0;
  }

  /* Editorial Prose Typography */
  .prose {
    font-size: 1.02rem;
    line-height: 1.84;
    color: var(--ink);
  }
  .prose h2 {
    font-family: var(--serif);
    font-size: 1.42rem;
    font-weight: 500;
    line-height: 1.32;
    letter-spacing: -0.01em;
    color: var(--ink);
    margin: 2.8rem 0 1rem;
    padding-top: 1.4rem;
    border-top: 1px solid var(--border);
  }
  .prose h2:first-child {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
  }
  .prose h3 {
    font-family: var(--serif);
    font-size: 1.16rem;
    font-weight: 500;
    line-height: 1.38;
    color: var(--ink);
    margin: 2rem 0 0.7rem;
  }
  .prose p {
    margin: 0 0 1.3rem;
    color: #1F2723;
  }
  .prose ul, .prose ol {
    margin: 0 0 1.4rem;
    padding-left: 1.45rem;
  }
  .prose li {
    margin-bottom: 0.5rem;
    color: #1F2723;
  }
  .prose strong {
    color: var(--ink);
    font-weight: 600;
  }
  .prose a {
    color: var(--accent);
    border-bottom: 1px solid rgba(35, 62, 51, 0.35);
  }
  .prose a:hover {
    border-bottom-color: var(--accent);
  }
  .prose code {
    font-family: var(--mono);
    font-size: 0.84em;
    background: var(--bg-neutral);
    color: var(--accent);
    padding: 0.14rem 0.38rem;
    border-radius: 2px;
  }
  .prose pre {
    background: #151C19;
    color: #F4F1EA;
    padding: 1.15rem 1.35rem;
    overflow-x: auto;
    margin: 1.65rem 0;
    font-family: var(--mono);
    font-size: 0.81rem;
    line-height: 1.65;
    border: 1px solid var(--border-strong);
  }
  .prose pre code {
    background: none;
    color: inherit;
    padding: 0;
    font-size: inherit;
  }
  .blog-callout {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    padding: 1rem 1.25rem;
    margin: 1.65rem 0;
  }
  .blog-callout-title {
    font-family: var(--mono);
    font-size: 0.72rem;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 0.35rem;
  }
  .blog-callout p {
    margin: 0;
    font-size: 0.95rem;
    color: var(--ink-secondary);
  }
  .blog-diagram {
    margin: 2rem 0;
    padding: 1.25rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
  }
  .blog-diagram svg {
    width: 100%;
    height: auto;
    display: block;
  }
  .blog-diagram figcaption {
    margin-top: 0.75rem;
    padding-top: 0.6rem;
    border-top: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--ink-muted);
    text-align: center;
  }
  .blog-table-wrap {
    overflow-x: auto;
    margin: 1.75rem 0;
    background: var(--bg-elevated);
    border-top: 1.5px solid var(--border-strong);
    border-bottom: 1.5px solid var(--border-strong);
  }
  .blog-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
  }
  .blog-table th, .blog-table td {
    text-align: left;
    padding: 0.65rem 0.85rem;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .blog-table th {
    font-family: var(--mono);
    font-size: 0.74rem;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--ink-secondary);
    background: var(--bg-neutral);
    border-bottom: 1px solid var(--border-strong);
  }
  .blog-table tr:last-child td {
    border-bottom: none;
  }
  .crdt-block-badge {
    font-family: var(--mono);
    font-size: 0.68rem;
    color: var(--ink-muted);
    background: var(--bg-neutral);
    padding: 0.08rem 0.32rem;
    margin-left: 0.35rem;
    user-select: none;
  }

  /* Prev / Next Article Pager */
  .post-pager {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    margin-top: 3.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
    font-size: 0.88rem;
  }
  .pager-link {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .pager-link.next {
    text-align: right;
  }
  .pager-label {
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-muted);
  }
  .pager-title {
    font-family: var(--serif);
    font-size: 0.98rem;
    color: var(--ink);
  }
  .pager-link:hover .pager-title {
    color: var(--accent);
    text-decoration: underline;
  }

  /* Reader Comments Section */
  .comments-section {
    margin-top: 3.5rem;
    padding-top: 2.25rem;
    border-top: 1px solid var(--border-strong);
  }
  .comments-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 1.5rem;
  }
  .comments-title {
    font-family: var(--serif);
    font-size: 1.25rem;
    font-weight: 500;
    margin: 0;
    color: var(--ink);
  }
  .comments-count {
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--ink-muted);
  }
  .comment-list {
    list-style: none;
    padding: 0;
    margin: 0 0 2rem 0;
  }
  .comment-item {
    padding: 1rem 0;
    border-bottom: 1px solid var(--border);
  }
  .comment-item:first-child {
    padding-top: 0;
  }
  .comment-meta {
    display: flex;
    align-items: baseline;
    gap: 0.65rem;
    margin-bottom: 0.35rem;
  }
  .comment-author {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--ink);
  }
  .comment-time {
    font-family: var(--mono);
    font-size: 0.74rem;
    color: var(--ink-muted);
  }
  .comment-body {
    font-size: 0.95rem;
    line-height: 1.65;
    color: var(--ink-secondary);
    white-space: pre-wrap;
    margin: 0;
  }
  .comment-empty {
    font-size: 0.88rem;
    color: var(--ink-muted);
    margin: 0 0 1.5rem 0;
  }
  .comment-form {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .comment-input, .comment-textarea {
    width: 100%;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 0.9rem;
    transition: border-color 0.15s ease;
  }
  .comment-input:focus, .comment-textarea:focus {
    outline: none;
    border-color: var(--accent);
    background: #fff;
  }
  .comment-textarea {
    min-height: 90px;
    resize: vertical;
  }
  .comment-submit-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }
  .comment-btn {
    padding: 0.5rem 1.15rem;
    background: var(--accent);
    color: #FAF8F4;
    border: 1px solid var(--accent);
    font-family: var(--sans);
    font-size: 0.84rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .comment-btn:hover {
    background: var(--ink);
    border-color: var(--ink);
  }
  .comment-status {
    font-family: var(--mono);
    font-size: 0.76rem;
    color: var(--ink-muted);
  }

  /* Minimalist Footer */
  .site-footer {
    margin-top: 4rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--ink-muted);
  }

  @media (max-width: 640px) {
    .top-nav-inner { padding: 0.85rem 1.2rem; }
    .brand-role { display: none; }
    .wrap { padding: 2.25rem 1.2rem 4rem; }
    .post-row-link { grid-template-columns: 1fr; gap: 0.3rem; padding: 1.1rem 0; }
    .post-row-arrow { display: none; }
    .post-pager { grid-template-columns: 1fr; }
    .pager-link.next { text-align: left; }
  }
`

const GOOGLE_FONTS_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=Noto+Serif+SC:wght@400;500;600&display=swap" rel="stylesheet">`

const HEURION_MARK_SVG = `<svg class="brand-mark" viewBox="-2 6 96 88" aria-hidden="true">
  <rect class="mark-bar" x="0" y="10" width="18" height="80" rx="9"/>
  <rect class="mark-bar" x="62" y="30" width="18" height="60" rx="9"/>
  <rect class="mark-accent" x="14" y="42" width="52" height="18" rx="9"/>
  <circle class="mark-accent" cx="80" cy="20" r="11"/>
</svg>`

/**
 * 渲染个人博客首页（Nordic 纸感色调 + 专业极简标题列表）
 */
export function renderBlogHomeHtml(
  lang: 'zh' | 'en',
  opts?: { subdomain?: boolean },
): string {
  const isEn = lang === 'en'
  const subdomain = opts?.subdomain ?? false
  const u = buildBlogUrls(lang, subdomain)
  const allPosts = getAllPostsMerged()

  const title = isEn
    ? 'Heurion Research · Technical Blog & Architecture Notes'
    : 'Heurion Research · 技术博客与架构手记'
  const description = isEn
    ? 'Technical writing and systems research notes by Heurion Research on Heurion 2.0, Aegis OS, and AI-Native Document Engines.'
    : 'Heurion Research 技术文章与系统架构手记：聚焦 Heurion 2.0、Aegis OS 与 AI-Native 文档引擎。'

  const listItemsHtml = allPosts
    .map(p => {
      const pTitle = isEn ? p.title_en : p.title_zh
      const href = u.postHref(p.slug)
      return `
      <li class="post-row">
        <a class="post-row-link" href="${href}">
          <span class="post-row-meta">
            <span class="post-row-num">${escapeHtml(p.num)}</span>
            <time datetime="${escapeHtml(p.date)}">${escapeHtml(p.date)}</time>
          </span>
          <h2 class="post-row-title">${escapeHtml(pTitle)}</h2>
          <span class="post-row-arrow" aria-hidden="true">→</span>
        </a>
      </li>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="${isEn ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="author" content="Heurion Research">
  <link rel="canonical" href="${u.canonicalUrl}">
  <link rel="alternate" hreflang="zh-CN" href="${u.zhCanonicalUrl}">
  <link rel="alternate" hreflang="en" href="${u.enCanonicalUrl}">
  <link rel="alternate" hreflang="x-default" href="${u.zhCanonicalUrl}">
  <link rel="alternate" type="application/rss+xml" title="Heurion Research RSS Feed" href="${u.rssHref}">
  ${GOOGLE_FONTS_LINK}
  <style>${HEURION_EDITORIAL_BLOG_STYLES}</style>
</head>
<body>
  <header class="top-nav">
    <div class="top-nav-inner">
      <a href="${u.homeHref}" class="brand">
        ${HEURION_MARK_SVG}
        <span class="brand-text">
          <span class="brand-name">Heurion Research</span>
          <span class="brand-role">Engineering &amp; Systems Blog</span>
        </span>
      </a>
      <nav class="nav-links">
        <a href="https://heurion.org">heurion.org</a>
        <a href="https://github.com/heurion-org" target="_blank" rel="noopener">GitHub</a>
        <a href="${u.rssHref}">RSS</a>
        <a href="${isEn ? u.zhHomeHref : u.enHomeHref}" class="lang-switch">${isEn ? '中文' : 'EN'}</a>
      </nav>
    </div>
  </header>

  <div class="wrap">
    <main>
      <div class="index-intro">
        <div class="index-eyebrow">HEURION RESEARCH · MONOGRAPHS &amp; NOTES</div>
        <h1 class="index-heading">${isEn ? 'Writing &amp; Systems Architecture' : '技术文章与系统架构手记'}</h1>
        <p class="index-desc">
          ${
            isEn
              ? 'Notes on Dual-Surface CRDT document engines, clinical research AI, and transactional agent operating systems.'
              : '关于双表面 CRDT 文档引擎、受控临床科研 AI 与 Aegis OS 事务级智能体操作系统的工程实践。'
          }
        </p>
      </div>

      <ul class="post-list">
        ${listItemsHtml}
      </ul>
    </main>

    <footer class="site-footer">
      <span>© 2026 Heurion Research</span>
      <span>blog.heurion.org</span>
    </footer>
  </div>
</body>
</html>`
}

/**
 * 渲染单篇博客文章页（Nordic 纸感专业排版 + 直接显示正文 + 底部读者评论）
 */
export function renderBlogPostHtml(
  slug: string,
  lang: 'zh' | 'en',
  opts?: { subdomain?: boolean },
): string | null {
  const found = findBlogPostBySlug(slug)
  if (!found) return null
  const { post, idx, all } = found
  const prevPost = idx > 0 ? all[idx - 1]! : null
  const nextPost = idx < all.length - 1 ? all[idx + 1]! : null

  const isEn = lang === 'en'
  const subdomain = opts?.subdomain ?? false
  const u = buildBlogUrls(lang, subdomain, slug)

  const postTitle = isEn ? post.title_en : post.title_zh
  const postSubtitle = isEn ? post.subtitle_en : post.subtitle_zh
  const description = isEn ? post.summary_en : post.summary_zh
  const keywords = isEn ? post.keywords_en : post.keywords_zh
  const readTime = isEn ? post.reading_time_en : post.reading_time_zh

  const rawProse = isEn ? post.body_en : post.body_zh
  const finalProse = rawProse.replace('<div id="omnidoc-live-studio-mount"></div>', '')

  const existingComments = getBlogComments(slug)
  const commentsListHtml = existingComments.length
    ? existingComments
        .map(
          c => `
        <li class="comment-item">
          <div class="comment-meta">
            <span class="comment-author">${escapeHtml(c.author)}</span>
            <time class="comment-time">${escapeHtml(c.created_at)}</time>
          </div>
          <p class="comment-body">${escapeHtml(c.content)}</p>
        </li>`,
        )
        .join('\n')
    : ''

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: postTitle,
    description,
    datePublished: post.date,
    dateModified: post.date,
    url: u.canonicalUrl,
    inLanguage: isEn ? 'en-US' : 'zh-CN',
    author: {
      '@type': 'Organization',
      name: 'Heurion Research',
      url: 'https://blog.heurion.org/',
    },
    publisher: {
      '@type': 'Organization',
      name: 'Heurion Research',
      url: 'https://heurion.org/',
    },
    keywords,
  }

  return `<!doctype html>
<html lang="${isEn ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(postTitle)} · Heurion Research</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="keywords" content="${escapeHtml(keywords)}">
  <meta name="author" content="Heurion Research">
  <link rel="canonical" href="${u.canonicalUrl}">
  <link rel="alternate" hreflang="zh-CN" href="${u.zhCanonicalUrl}">
  <link rel="alternate" hreflang="en" href="${u.enCanonicalUrl}">
  <link rel="alternate" hreflang="x-default" href="${u.zhCanonicalUrl}">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  ${GOOGLE_FONTS_LINK}
  <style>${HEURION_EDITORIAL_BLOG_STYLES}</style>
</head>
<body>
  <header class="top-nav">
    <div class="top-nav-inner">
      <a href="${u.homeHref}" class="brand">
        ${HEURION_MARK_SVG}
        <span class="brand-text">
          <span class="brand-name">Heurion Research</span>
        </span>
      </a>
      <nav class="nav-links">
        <a href="${u.homeHref}">← ${isEn ? 'All Articles' : '返回目录'}</a>
        <a href="${isEn ? u.zhPostHref(slug) : u.enPostHref(slug)}" class="lang-switch">${isEn ? '中文' : 'EN'}</a>
      </nav>
    </div>
  </header>

  <div class="wrap">
    <main>
      <article>
        <header class="article-header">
          <div class="article-meta">
            <span class="article-meta-num">NO. ${escapeHtml(post.num)}</span>
            <span>·</span>
            <time datetime="${escapeHtml(post.date)}">${escapeHtml(post.date)}</time>
            <span>·</span>
            <span>${escapeHtml(readTime)}</span>
          </div>
          <h1 class="article-title">${escapeHtml(postTitle)}</h1>
          <p class="article-subtitle">${escapeHtml(postSubtitle)}</p>
        </header>

        <div class="prose">
          ${finalProse}
        </div>
      </article>

      <nav class="post-pager">
        <div>
          ${
            prevPost
              ? `<a class="pager-link prev" href="${u.postHref(prevPost.slug)}">
                  <span class="pager-label">← ${isEn ? 'Previous' : '上一篇'}</span>
                  <span class="pager-title">${escapeHtml(isEn ? prevPost.title_en : prevPost.title_zh)}</span>
                </a>`
              : ''
          }
        </div>
        <div>
          ${
            nextPost
              ? `<a class="pager-link next" href="${u.postHref(nextPost.slug)}">
                  <span class="pager-label">${isEn ? 'Next' : '下一篇'} →</span>
                  <span class="pager-title">${escapeHtml(isEn ? nextPost.title_en : nextPost.title_zh)}</span>
                </a>`
              : ''
          }
        </div>
      </nav>

      <section class="comments-section" id="comments">
        <div class="comments-header">
          <h2 class="comments-title">${isEn ? 'Reader Comments' : '读者评论'}</h2>
          <span class="comments-count"><span id="commentCount">${existingComments.length}</span> ${isEn ? 'comments' : '条留言'}</span>
        </div>

        <ul class="comment-list" id="commentsList">
          ${commentsListHtml}
        </ul>
        ${
          existingComments.length === 0
            ? `<p class="comment-empty" id="commentEmpty">${isEn ? 'No comments yet. Share your thoughts or technical questions below.' : '暂无留言，欢迎在下方分享你的见解或技术讨论。'}</p>`
            : ''
        }

        <form class="comment-form" id="commentForm">
          <input
            type="text"
            id="commentAuthor"
            class="comment-input"
            placeholder="${isEn ? 'Your name / affiliation' : '你的称呼 / 机构（选填）'}"
            maxlength="60"
            required
          >
          <textarea
            id="commentContent"
            class="comment-textarea"
            placeholder="${isEn ? 'Write a comment...' : '写下你的评论...'}"
            maxlength="2000"
            required
          ></textarea>
          <div class="comment-submit-row">
            <span class="comment-status" id="commentStatus"></span>
            <button type="submit" class="comment-btn">${isEn ? 'Post Comment' : '发表评论'}</button>
          </div>
        </form>
      </section>
    </main>

    <footer class="site-footer">
      <span>© 2026 Heurion Research</span>
      <a href="${u.homeHref}">${isEn ? '← Back to All Articles' : '← 返回全部文章'}</a>
    </footer>
  </div>

  <script>
    (function() {
      var form = document.getElementById('commentForm');
      var authorInput = document.getElementById('commentAuthor');
      var contentInput = document.getElementById('commentContent');
      var listEl = document.getElementById('commentsList');
      var emptyEl = document.getElementById('commentEmpty');
      var countEl = document.getElementById('commentCount');
      var statusEl = document.getElementById('commentStatus');
      if (!form) return;

      function esc(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      form.addEventListener('submit', function(e) {
        e.preventDefault();
        var author = authorInput.value.trim();
        var content = contentInput.value.trim();
        if (!content) return;
        statusEl.textContent = ${isEn ? "'Posting...'" : "'正在提交...'"};
        fetch('/blog/api/comments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: ${JSON.stringify(slug)},
            author: author || 'Anonymous',
            content: content
          })
        })
        .then(function(r) { return r.json(); })
        .then(function(res) {
          if (!res.ok || !res.comment) {
            statusEl.textContent = res.error || 'Error';
            return;
          }
          if (emptyEl) emptyEl.style.display = 'none';
          var li = document.createElement('li');
          li.className = 'comment-item';
          li.innerHTML =
            '<div class="comment-meta">' +
              '<span class="comment-author">' + esc(res.comment.author) + '</span>' +
              '<time class="comment-time">' + esc(res.comment.created_at) + '</time>' +
            '</div>' +
            '<p class="comment-body">' + esc(res.comment.content) + '</p>';
          listEl.appendChild(li);
          if (countEl) countEl.textContent = String(Number(countEl.textContent || '0') + 1);
          contentInput.value = '';
          statusEl.textContent = ${isEn ? "'Comment posted.'" : "'评论已发布。'"};
        })
        .catch(function() {
          statusEl.textContent = ${isEn ? "'Network error.'" : "'网络异常，请重试。'"};
        });
      });
    })();
  </script>
</body>
</html>`
}

/**
 * 渲染 RSS 2.0 订阅源 XML
 */
export function renderBlogRssXml(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const channelTitle = isEn
    ? 'Heurion Research — Technical Notes (Heurion 2.0 & Aegis OS)'
    : 'Heurion Research — 技术博客（Heurion 2.0 与 Aegis OS）'
  const channelDesc = isEn
    ? 'Technical monographs by Heurion Research on Dual-Surface CRDTs, Clinical Research AI, and Transactional Agent Operating Systems.'
    : 'Heurion Research 关于双表面 CRDT、临床科研工作台与 Aegis OS 事务级智能体操作系统的技术文章。'
  const channelLink = isEn ? 'https://blog.heurion.org/en' : 'https://blog.heurion.org/'
  const allPosts = getAllPostsMerged()

  const itemsXml = allPosts
    .map(p => {
      const title = isEn ? p.title_en : p.title_zh
      const desc = isEn ? p.summary_en : p.summary_zh
      const link = isEn
        ? `https://blog.heurion.org/en/${p.slug}`
        : `https://blog.heurion.org/${p.slug}`
      const pubDate = new Date(`${p.date}T09:00:00Z`).toUTCString()
      return `    <item>
      <title>${escapeHtml(title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${pubDate}</pubDate>
      <author>research@heurion.org (Heurion Research)</author>
      <description>${escapeHtml(desc)}</description>
    </item>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(channelTitle)}</title>
    <link>${channelLink}</link>
    <description>${escapeHtml(channelDesc)}</description>
    <language>${isEn ? 'en-US' : 'zh-CN'}</language>
    <atom:link href="https://blog.heurion.org/${isEn ? 'en/feed.xml' : 'feed.xml'}" rel="self" type="application/rss+xml"/>
${itemsXml}
  </channel>
</rss>`
}

/**
 * 渲染独立子域名 `blog.heurion.org` 的专属 Sitemap XML
 */
export function renderBlogSitemapXml(): string {
  const allPosts = getAllPostsMerged()
  const urls: string[] = [
    `  <url>
    <loc>https://blog.heurion.org/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>`,
    `  <url>
    <loc>https://blog.heurion.org/en</loc>
    <changefreq>weekly</changefreq>
    <priority>0.95</priority>
  </url>`,
  ]

  for (const p of allPosts) {
    urls.push(`  <url>
    <loc>https://blog.heurion.org/${p.slug}</loc>
    <lastmod>${p.date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>`)
    urls.push(`  <url>
    <loc>https://blog.heurion.org/en/${p.slug}</loc>
    <lastmod>${p.date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>`)
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`
}

/**
 * 注册博客路由（同时挂载：`blog.heurion.org` 子域名中间件 + `heurion.org/blog*` 路径 + 评论与双表面 CRDT 发布 API）
 */
export function registerBlogRoutes(
  app: any,
  opts?: {
    serveHtml?: (c: any, html: string) => any
  },
): void {
  const PUBLIC_HTML_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600'
  const sendHtml =
    opts?.serveHtml ??
    ((c: any, html: string) => c.html(html, 200, { 'Cache-Control': PUBLIC_HTML_CACHE }))
  const sendXml = (c: any, xml: string) =>
    c.body(xml, 200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
    })

  // 1. 读者评论公开接口
  const handleGetComments = (c: any) => {
    const slug = String(c.req.query('slug') ?? '').trim()
    return c.json({ ok: true, slug, comments: getBlogComments(slug) }, 200)
  }
  const handlePostComment = async (c: any) => {
    const body = await c.req.json().catch(() => ({}))
    try {
      const comment = addBlogComment({
        slug: String(body.slug ?? ''),
        author: String(body.author ?? 'Anonymous'),
        content: String(body.content ?? ''),
      })
      return c.json({ ok: true, comment }, 200)
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
    }
  }
  app.get('/blog/api/comments', handleGetComments)
  app.post('/blog/api/comments', handlePostComment)
  app.get('/api/public/blog/comments', handleGetComments)
  app.post('/api/public/blog/comments', handlePostComment)

  // 2. 双表面 CRDT 编译与一键发布接口
  const handleCrdtCompile = async (c: any) => {
    const body = await c.req.json().catch(() => ({}))
    const res = executeDualSurfaceSandbox({
      markdown: String(body.markdown ?? ''),
      ops: Array.isArray(body.ops) ? body.ops : [],
      user_locked_ids: Array.isArray(body.user_locked_ids) ? body.user_locked_ids : [],
      show_block_badges: body.show_block_badges !== false,
    })
    return c.json(res, 200)
  }
  app.post('/blog/api/crdt-compile', handleCrdtCompile)
  app.post('/api/public/blog/crdt-compile', handleCrdtCompile)

  const handleBlogPublish = async (c: any) => {
    const body = await c.req.json().catch(() => ({}))
    try {
      const post = publishCrdtDocumentToBlog({
        slug: String(body.slug ?? 'omnidoc-live-note'),
        title_zh: String(body.title_zh ?? body.title ?? 'Untitled CRDT Note'),
        title_en: String(body.title_en ?? body.title_zh ?? body.title ?? 'Untitled CRDT Note'),
        subtitle_zh: body.subtitle_zh ? String(body.subtitle_zh) : undefined,
        subtitle_en: body.subtitle_en ? String(body.subtitle_en) : undefined,
        markdown_zh: String(body.markdown_zh ?? body.markdown ?? ''),
        markdown_en: String(body.markdown_en ?? body.markdown_zh ?? body.markdown ?? ''),
        tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
      })
      return c.json(
        {
          ok: true,
          slug: post.slug,
          subdomain_url: `/${post.slug}`,
          subdomain_en_url: `/en/${post.slug}`,
          path_url: `/blog/${post.slug}`,
          path_en_url: `/en/blog/${post.slug}`,
          stats: post.stats,
        },
        200,
      )
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400)
    }
  }
  app.post('/blog/api/publish', handleBlogPublish)
  app.post('/api/public/blog/publish', handleBlogPublish)

  // 独立子域名 (blog.heurion.org) 拦截中间件
  app.use('*', async (c: any, next: () => Promise<void>) => {
    const host = c.req.header('host') ?? new URL(c.req.url).host
    if (!isBlogSubdomainHost(host)) {
      await next()
      return
    }
    const path: string = c.req.path
    if (
      path.startsWith('/site/') ||
      path.startsWith('/assets/') ||
      path.startsWith('/api/') ||
      path.startsWith('/blog/api/') ||
      path === '/healthz'
    ) {
      await next()
      return
    }
    if (path === '/' || path === '') {
      return sendHtml(c, renderBlogHomeHtml('zh', { subdomain: true }))
    }
    if (path === '/en') {
      return sendHtml(c, renderBlogHomeHtml('en', { subdomain: true }))
    }
    if (path === '/en/') {
      return c.redirect('/en', 301)
    }
    if (path === '/blog' || path === '/blog/') {
      return c.redirect('/', 301)
    }
    if (path === '/en/blog' || path === '/en/blog/') {
      return c.redirect('/en', 301)
    }
    if (path === '/feed.xml' || path === '/rss.xml' || path === '/blog/feed.xml') {
      return sendXml(c, renderBlogRssXml('zh'))
    }
    if (path === '/en/feed.xml' || path === '/en/rss.xml' || path === '/en/blog/feed.xml') {
      return sendXml(c, renderBlogRssXml('en'))
    }
    if (path === '/sitemap.xml') {
      return sendXml(c, renderBlogSitemapXml())
    }
    if (path === '/robots.txt') {
      return c.text(
        'User-agent: *\nAllow: /\nSitemap: https://blog.heurion.org/sitemap.xml\n',
        200,
      )
    }
    const zhPostMatch = /^\/(?:posts\/|blog\/)?([a-z0-9-]+)\/?$/.exec(path)
    if (zhPostMatch?.[1] && findBlogPostBySlug(zhPostMatch[1])) {
      if (path.startsWith('/blog/') || path.endsWith('/')) {
        return c.redirect(`/${zhPostMatch[1]}`, 301)
      }
      return sendHtml(c, renderBlogPostHtml(zhPostMatch[1], 'zh', { subdomain: true })!)
    }
    const enPostMatch = /^\/en\/(?:posts\/|blog\/)?([a-z0-9-]+)\/?$/.exec(path)
    if (enPostMatch?.[1] && findBlogPostBySlug(enPostMatch[1])) {
      if (path.startsWith('/en/blog/') || path.endsWith('/')) {
        return c.redirect(`/en/${enPostMatch[1]}`, 301)
      }
      return sendHtml(c, renderBlogPostHtml(enPostMatch[1], 'en', { subdomain: true })!)
    }
    return c.notFound()
  })

  // 主站路径 (heurion.org/blog*) 兼容与可选重定向
  const shouldRedirectToSubdomain = (c: any): boolean =>
    process.env.BLOG_REDIRECT_SUBDOMAIN === '1' || c.req.query('redirect') === '1'

  app.get('/blog', (c: any) =>
    shouldRedirectToSubdomain(c)
      ? c.redirect('https://blog.heurion.org/', 302)
      : sendHtml(c, renderBlogHomeHtml('zh', { subdomain: false })),
  )
  app.get('/blog/', (c: any) =>
    shouldRedirectToSubdomain(c)
      ? c.redirect('https://blog.heurion.org/', 302)
      : c.redirect('/blog', 301),
  )
  app.get('/en/blog', (c: any) =>
    shouldRedirectToSubdomain(c)
      ? c.redirect('https://blog.heurion.org/en', 302)
      : sendHtml(c, renderBlogHomeHtml('en', { subdomain: false })),
  )
  app.get('/en/blog/', (c: any) =>
    shouldRedirectToSubdomain(c)
      ? c.redirect('https://blog.heurion.org/en', 302)
      : c.redirect('/en/blog', 301),
  )
  app.get('/blog/feed.xml', (c: any) => sendXml(c, renderBlogRssXml('zh')))
  app.get('/blog/rss.xml', (c: any) => sendXml(c, renderBlogRssXml('zh')))
  app.get('/en/blog/feed.xml', (c: any) => sendXml(c, renderBlogRssXml('en')))
  app.get('/en/blog/rss.xml', (c: any) => sendXml(c, renderBlogRssXml('en')))
  app.get('/blog/:slug', (c: any) => {
    const slug = c.req.param('slug')
    if (!findBlogPostBySlug(slug)) return c.notFound()
    if (shouldRedirectToSubdomain(c)) {
      return c.redirect(`https://blog.heurion.org/${slug}`, 302)
    }
    return sendHtml(c, renderBlogPostHtml(slug, 'zh', { subdomain: false })!)
  })
  app.get('/en/blog/:slug', (c: any) => {
    const slug = c.req.param('slug')
    if (!findBlogPostBySlug(slug)) return c.notFound()
    if (shouldRedirectToSubdomain(c)) {
      return c.redirect(`https://blog.heurion.org/en/${slug}`, 302)
    }
    return sendHtml(c, renderBlogPostHtml(slug, 'en', { subdomain: false })!)
  })
}
