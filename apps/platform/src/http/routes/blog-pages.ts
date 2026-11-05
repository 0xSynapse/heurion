/**
 * Heurion Research — Nordic Editorial Minimalist Technical Blog
 * Palette & Typography aligned with heurion.org (site.css v6).
 * Canonical host: https://heurion.org/blog (with English at https://heurion.org/en/blog)
 * Also supports standalone subdomain (https://blog.heurion.org) when accessed via blog.* host.
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

  const homeHref = subdomain ? (isEn ? '/en' : '/') : isEn ? '/en/blog' : '/blog'
  const zhHomeHref = subdomain ? '/' : '/blog'
  const enHomeHref = subdomain ? '/en' : '/en/blog'
  const postHref = (s: string) =>
    subdomain ? (isEn ? `/en/${s}` : `/${s}`) : isEn ? `/en/blog/${s}` : `/blog/${s}`
  const zhPostHref = (s: string) => (subdomain ? `/${s}` : `/blog/${s}`)
  const enPostHref = (s: string) => (subdomain ? `/en/${s}` : `/en/blog/${s}`)
  const mdHref = slug
    ? subdomain
      ? isEn
        ? `/en/${slug}.md`
        : `/${slug}.md`
      : isEn
        ? `/en/blog/${slug}.md`
        : `/blog/${slug}.md`
    : subdomain
      ? isEn
        ? '/en/blog.md'
        : '/blog.md'
      : isEn
        ? '/en/blog.md'
        : '/blog.md'
  const rssHref = subdomain
    ? isEn
      ? '/en/feed.xml'
      : '/feed.xml'
    : isEn
      ? '/en/blog/feed.xml'
      : '/blog/feed.xml'

  const zhCanonicalUrl = subdomain
    ? slug
      ? `https://blog.heurion.org/${slug}`
      : 'https://blog.heurion.org/'
    : slug
      ? `https://heurion.org/blog/${slug}`
      : 'https://heurion.org/blog'

  const enCanonicalUrl = subdomain
    ? slug
      ? `https://blog.heurion.org/en/${slug}`
      : 'https://blog.heurion.org/en'
    : slug
      ? `https://heurion.org/en/blog/${slug}`
      : 'https://heurion.org/en/blog'

  const canonicalUrl = isEn ? enCanonicalUrl : zhCanonicalUrl

  return {
    homeHref,
    zhHomeHref,
    enHomeHref,
    postHref,
    zhPostHref,
    enPostHref,
    mdHref,
    rssHref,
    canonicalUrl,
    zhCanonicalUrl,
    enCanonicalUrl,
  }
}

interface BlogGeoExtra {
  faq_zh: ReadonlyArray<{ q: string; a: string }>
  faq_en: ReadonlyArray<{ q: string; a: string }>
  links_zh: ReadonlyArray<{ label: string; href: string; desc: string }>
  links_en: ReadonlyArray<{ label: string; href: string; desc: string }>
  repoUrl: string
  paperUrl: string
}

const BLOG_GEO_EXTRAS: Record<string, BlogGeoExtra> = {
  'dual-surface-crdt-clinical-ai': {
    repoUrl: 'https://github.com/heurion-org/heurion',
    paperUrl: 'https://github.com/heurion-org/heurion/blob/main/paper/main.pdf',
    links_zh: [
      {
        label: 'Table 1 原生 Word (.docx) 生成器',
        href: '/tools/table-1-generator',
        desc: '体验字节级 OOXML 1.5pt/0.5pt 顶刊三线表直出与 SMD 均衡性计算',
      },
      {
        label: 'PubMed 文献真伪与 HR/OR 效应量核验器',
        href: '/tools/pubmed-citation-checker',
        desc: '实时对照 NCBI PubMed 与 Crossref 拦截幻觉 PMID 与张冠李戴效应量',
      },
      {
        label: 'Heurion 2.0 临床科研工作台',
        href: '/app',
        desc: '进入双表面 ProseMirror + Yjs CRDT 协同画布与沙箱统计环境',
      },
    ],
    links_en: [
      {
        label: 'Native Word (.docx) Table 1 Generator',
        href: '/en/tools/table-1-generator',
        desc: 'Experience byte-accurate OOXML 1.5pt/0.5pt three-line table export with SMD & P-values',
      },
      {
        label: 'PubMed Citation & Effect Size Auditor',
        href: '/en/tools/pubmed-citation-checker',
        desc: 'Cross-verify PMIDs/DOIs and inline HR/OR claims against live NCBI PubMed XML',
      },
      {
        label: 'Heurion 2.0 Clinical Workstation',
        href: '/app',
        desc: 'Launch the full Dual-Surface ProseMirror + Yjs CRDT studio and biostatistics sandbox',
      },
    ],
    faq_zh: [
      {
        q: '为什么使用 python-docx 或自由 Shell 脚本修改医学论文会破坏 Word 排版？',
        a: '自由 Shell 智能体通过 python-docx 解析并重序列化整个 .docx 压缩包时，会丢失未触碰段落的复杂域代码（EndNote/Zotero 域）、修订标记（w:ins/w:del）、自定义样式继承与分节符，实测仅能保留 21.4% 的原始排版保真度。Heurion 采用双表面 CRDT 与两级字节保留 OOXML 补丁架构（未改块 100% 原始二进制切片直拷 + 修改块 Run 级 LCS 差分），将排版保留率提升至 96.4%。',
      },
      {
        q: '什么是双表面 CRDT（Dual-Surface CRDT），它如何实现 0.128ms 的按轮次精准回滚？',
        a: 'Heurion 以单一 ProseMirror + Yjs CRDT 状态树作为唯一事实源：向人类研究者投影富文本/幻灯片画布，向 AI 智能体投影带持久块 ID（{#id}）的受控注解 Markdown。每次 AI 操作均打上 turnId 与 before_markdown 快照标签；当用户点击回滚某一轮 AI 修改时，系统仅需 0.128ms 即可非连续精准撤销该轮涉及的节点（revertByNodes），绝不误伤人类后续并发编辑。',
      },
    ],
    faq_en: [
      {
        q: 'Why do free-form shell agents and python-docx scripts corrupt clinical Word (.docx) manuscripts?',
        a: 'When shell-based coding agents parse and re-serialize an entire .docx archive via python-docx or pandoc, they strip complex field codes (EndNote/Zotero citations), tracked changes (w:ins/w:del), custom hospital style hierarchies, and section breaks—retaining only 21.4% formatting fidelity. Heurion uses a Dual-Surface CRDT paired with a 2-level byte-preserving OOXML patch engine (100% binary slice identity on untouched blocks and Run-level LCS patchParagraph on edited blocks), achieving 96.4% layout retention.',
      },
      {
        q: 'How does Dual-Surface CRDT achieve 0.128ms selective per-turn AI rollback without losing concurrent human edits?',
        a: 'Heurion maintains a single ProseMirror + Yjs CRDT source of truth projected simultaneously as a rich-text studio for clinicians and Annotated Markdown with stable {#id} block identifiers for AI agents. Every agent mutation records node-level turn attribution; rolling back a historical AI turn (revertByNodes) selectively restores only the nodes modified in that turn in 0.128ms while preserving subsequent human edits on adjacent paragraphs.',
      },
    ],
  },
  'human-agent-capability-parity-ai-native-software': {
    repoUrl: 'https://github.com/heurion-org/heurion',
    paperUrl: 'https://github.com/heurion-org/heurion/blob/main/paper/main.pdf',
    links_zh: [
      {
        label: '临床病历与文稿 PHI 隐私扫描与脱敏器',
        href: '/tools/phi-deidentifier',
        desc: '体验 MOD 11-2 身份证校验和、Luhn 卡号校验与零误伤医学指标的前置隐私守卫',
      },
      {
        label: 'Aegis OS 事务级智能体运行时',
        href: '/aegis-os/',
        desc: '了解 AAP-1.0 协议如何将人机同权与离线 Ed25519 审批租约下沉至操作系统内核',
      },
      {
        label: 'Kaplan-Meier 生存分析与 Cox 风险比计算器',
        href: '/tools/kaplan-meier-survival',
        desc: '直接调用与 MCP 工具同源的确定性生物统计内核生成出版级矢量图',
      },
    ],
    links_en: [
      {
        label: 'Clinical PHI Privacy Scanner & De-identifier',
        href: '/en/tools/phi-deidentifier',
        desc: 'Test deterministic MOD 11-2 & Luhn checksum PHI redaction before LLM prompting',
      },
      {
        label: 'Aegis OS Transactional Agent Runtime',
        href: '/en/aegis-os/',
        desc: 'Explore how AAP-1.0 enforces Capability Parity and Ed25519 human approval leases',
      },
      {
        label: 'Kaplan-Meier Survival & Log-rank Calculator',
        href: '/en/tools/kaplan-meier-survival',
        desc: 'Invoke the same deterministic biostatistical engine exposed to MCP agents',
      },
    ],
    faq_zh: [
      {
        q: '什么是 AI 原生软件的“人机同权公理（Capability & Permission Parity Axiom）”？',
        a: '人机同权公理包含两条硬性约束：(1) 能力同权（Agent Capability = User Capability），即人类在 GUI 能完成的每一项操作都有 1:1 对应的结构化 MCP 工具，消除脆弱的 DOM 屏幕抓取；(2) 权限同权（Agent Permission = User Permission），即智能体通过进程内 256-bit 环回内核完全继承当前人类用户的租户身份与 RBAC 边界，绝不允许走高权限 Service Role 数据库后门。',
      },
      {
        q: '为什么“AI 申请权限的过程”本身必须与最终执行结果同样可审计？',
        a: '如果系统只记录已批准的操作而不记录权限申请全过程，被提示词注入劫持的智能体就可以静默探测敏感边界、伪造模糊申请理由或高频轰炸诱导疲劳误批。Heurion 与 Aegis OS 将每一次权限申请建模为一等不可变审计事件（记录触发工具上下文、结构化理由、风险分级与审批耗时），并在协议层硬性拦截智能体自批（HTTP 403 Anti-Self-Approval Guard）。',
      },
    ],
    faq_en: [
      {
        q: 'What is the Capability & Permission Parity Axiom in AI-native software architecture?',
        a: 'It establishes two formal invariants: (1) Agent Capability = User Capability—every human GUI action has a 1:1 deterministic MCP tool backed by the same route handler, eliminating brittle DOM scraping; and (2) Agent Permission = User Permission—agents execute through a zero-fork in-process loopback kernel authenticated with a 256-bit RAM secret, inheriting the exact human user session and RBAC scope rather than an over-privileged database service key.',
      },
      {
        q: 'Why must the act of an AI agent requesting permission be as auditable as the execution itself?',
        a: 'If only approved executions are logged, a prompt-injected agent can silently probe forbidden boundaries, craft deceptive escalation rationales, or spam confirmation prompts without leaving forensic evidence. Heurion and Aegis OS record every permission escalation request—whether approved, denied, or expired—as an immutable audit event with full tool call arguments, agent rationale, and a strict 403 anti-self-approval guard.',
      },
    ],
  },
  'aegis-os-transactional-agent-kernel': {
    repoUrl: 'https://github.com/heurion-org/aegis-os',
    paperUrl: 'https://github.com/heurion-org/aegis-os/blob/main/paper/aegis_os_arxiv_preprint.pdf',
    links_zh: [
      {
        label: 'Aegis OS 架构主页与 Homebrew 安装指南',
        href: '/aegis-os/',
        desc: '深入了解 APFS clonefile / Btrfs FICLONE 写时复制影子工作区与双层内核沙箱',
      },
      {
        label: 'Aegis OS 快速上手教程（Install → UOMP 授权 → A2A 协同）',
        href: '/aegis-os/tutorial/',
        desc: '10 分钟跑通多智能体文件认领锁（coord_claim）与无冲突自动合并',
      },
      {
        label: 'Aegis OS GitHub 开源仓库 (heurion-org/aegis-os)',
        href: 'https://github.com/heurion-org/aegis-os',
        desc: '查阅 Rust 源码、80 项红队对抗测试集与 28,087 次真实工具调用基准报告',
      },
    ],
    links_en: [
      {
        label: 'Aegis OS Product Page & Homebrew Install',
        href: '/en/aegis-os/',
        desc: 'Deep dive into APFS clonefile / Btrfs FICLONE CoW shadow workspaces and kernel sandboxing',
      },
      {
        label: 'Aegis OS Interactive Tutorial (Install → UOMP → A2A)',
        href: '/en/aegis-os/tutorial/',
        desc: 'Step-by-step guide to advisory file claims (coord_claim) and transactional auto-merge',
      },
      {
        label: 'Aegis OS Open-Source Repository (heurion-org/aegis-os)',
        href: 'https://github.com/heurion-org/aegis-os',
        desc: 'Inspect the Rust crates, 80-attack red-team suite, and 28,087-call benchmark report',
      },
    ],
    faq_zh: [
      {
        q: '为什么传统的 Git Feature Branch 分支模式不适合高频多智能体（Multi-Agent）并发协作？',
        a: 'Git 分支是为人类数小时至数天的异步开发设计的：每个智能体拉取独立分支或 git worktree 会导致 .git 元数据膨胀、构建缓存（target/、node_modules/）重复编译，且在事后合并时引发高昂的语义冲突解决成本。Aegis OS 采用锚定主干的 CoW 影子工作区（单文件 0.42ms、整仓 6.3ms APFS clonefile）配合事前咨询式文件认领锁（coord_claim）与捎带式 IPC 总线，在 500 次三智能体并发提交中实现 98.7% 自动无冲突收敛。',
      },
      {
        q: 'Aegis OS 如何在消除 90.7%–97.9% 授权确认弹窗的同时保证 0.0% 逃逸攻击成功率？',
        a: '因为所有绿区（Green Zone）文件读写与构建测试都被内核级 Seatbelt/Bubblewrap 沙箱严格限制在隔离的 CoW 影子工作区内，无法直接污染宿主机主干或读取 ~/.ssh、~/.aws 等凭据（80 项红队攻击测试 0.0% ASR）。只有当智能体请求提交回宿主机（workspace_commit）或触碰敏感边界时，才通过全链路哈希链可审计账本与离线 Ed25519 人类审批租约放行。',
      },
      {
        q: '除了代码协作，Aegis OS 如何支持多文件文档库、二进制产物与数据科学流水线协作？',
        a: '在非代码协作中，共享目录直写会导致 41.2% 的后写覆盖与脏读。Aegis OS 通过四项机制覆盖全场景协作：（1）对 Markdown/LaTeX/JSON/CSV 走四级 LCS 自动三路归并，对 PDF/图表/DOCX 等二进制文件实施 coord_claim 排他锁与 overwrite_binaries 基线校验；（2）将 verify_cmd 扩展为广义领域预检门（如 LaTeX 编译、死链校验、PHI 隐私扫描）；（3）通过 org_artifact_publish（SHA-256 内容寻址 CAS）与 depends_on 任务 DAG 实现零脏读数据流水线接力；（4）通过 AAP-1.0 与 UOMP 协议将协作边界延伸至在线应用与受控记忆。',
      },
    ],
    faq_en: [
      {
        q: 'Why do traditional Git feature branches break down for concurrent multi-agent collaboration?',
        a: 'Git branches and worktrees were designed for human-timescale asynchronous work: spawning a branch per agent task duplicates build caches, fragments working trees, and defers conflict detection until expensive post-hoc merges. Aegis OS replaces feature branches with trunk-anchored Copy-on-Write shadow workspaces (0.42ms per-file / 6.3ms repo-wide APFS clonefile), proactive TTL file claims (coord_claim), and piggybacked _aegis_inbox IPC—achieving 98.7% automatic 4-tier LCS Diff3 convergence.',
      },
      {
        q: 'How does Aegis OS eliminate 90.7%–97.9% of authorization prompts while maintaining 0.0% attack success rate?',
        a: 'Routine edits, builds, and tests run inside kernel-enforced macOS Seatbelt / Linux Bubblewrap sandboxes bound to an isolated CoW shadow workspace with default-deny $HOME credential isolation (0.0% ASR across 80 adversarial attacks). Human confirmation is reserved strictly for boundary transitions (such as workspace_commit or policy escalations), which are recorded in a SHA-256 hash-chained audit ledger and gated by offline Ed25519 capability leases.',
      },
      {
        q: 'How does Aegis OS generalize beyond source code to document vaults, binary assets, and data pipelines?',
        a: 'Outside of software engineering, shared-folder agents suffer a 41.2% silent overwrite rate because they lack branches and compilers. Aegis OS unifies four collaboration domains: (1) 4-tier LCS auto-merge for text/LaTeX/Markdown/JSON paired with exclusive coord_claim locks and overwrite_binaries hash guards for PDFs, figures, and Office archives; (2) generalized verify_cmd domain gates (LaTeX compilation, citation checks, and PHI privacy scans); (3) immutable SHA-256 Content-Addressed Storage (org_artifact_publish) with depends_on DAG task wakeups for data pipelines; and (4) AAP-1.0 live application mounting and UOMP memory consent.',
      },
    ],
  },
  'from-agent-plugins-to-enforced-runtime': {
    repoUrl: 'https://github.com/heurion-org/aegis-os',
    paperUrl: 'https://github.com/heurion-org/aegis-os/blob/main/docs/AEGIS_ENFORCED_RUNTIME_DESIGN.md',
    links_zh: [
      {
        label: 'Aegis Enforced Runtime 完整架构规范 (GitHub)',
        href: 'https://github.com/heurion-org/aegis-os/blob/main/docs/AEGIS_ENFORCED_RUNTIME_DESIGN.md',
        desc: '阅读包含威胁模型、bwrap/Seatbelt 挂载表、.git 只读穿透与两层网关的完整工程规范',
      },
      {
        label: 'Aegis OS 事务级智能体内核专论（No. 03）',
        href: '/blog/aegis-os-transactional-agent-kernel',
        desc: '回顾 0.42ms CoW 影子工作区、四级 LCS 自动合并与多智能体文件认领锁的基准评测',
      },
      {
        label: 'Aegis OS 主页与安装指南',
        href: '/aegis-os/',
        desc: '了解如何为 Claude Code、OpenCode、Codex 与 AGY 一键接入 Aegis 运行时',
      },
    ],
    links_en: [
      {
        label: 'Aegis Enforced Runtime Full Specification (GitHub)',
        href: 'https://github.com/heurion-org/aegis-os/blob/main/docs/AEGIS_ENFORCED_RUNTIME_DESIGN.md',
        desc: 'Read the complete engineering specification covering bwrap/Seatbelt mounts, .git index separation, and L4/L7 egress',
      },
      {
        label: 'Aegis OS Transactional Agent Kernel Monograph (No. 03)',
        href: '/en/blog/aegis-os-transactional-agent-kernel',
        desc: 'Review the 0.42ms CoW shadow workspace, 4-tier LCS auto-merge, and advisory file claim benchmarks',
      },
      {
        label: 'Aegis OS Product Page & CLI Quickstart',
        href: '/en/aegis-os/',
        desc: 'Install Aegis OS for Claude Code, OpenCode, Codex CLI, and Antigravity (AGY)',
      },
    ],
    faq_zh: [
      {
        q: '为什么 Claude Code、OpenCode 或 Codex 的插件（PreToolUse Hook + MCP）不能作为严格的安全边界？',
        a: '因为插件与被监管的 Agent 主进程运行在同一个宿主机用户权限域（相同 UID 与系统调用面）中。在对抗性提示词注入或配置漂移下，Agent 可能调用未列入 Hook 的原生工具（如 NotebookEdit）、连接沙箱外已运行的共享守护进程（OpenCode --attach）、修改自身的 ~/.claude/settings.json 摘除 Hook，或借由看似只读的 git status / cargo test 触发宿主机上的恶意 .git/config fsmonitor 与 build.rs 脚本。因此插件模式属于 Advisory（建议级生产力护栏），真正的安全边界必须由 aegis-os run 作为父进程通过 OS 内核沙箱（Enforced / Isolated）强制实施。',
      },
      {
        q: 'aegis-os run 如何在禁止 Agent 篡改宿主机 .git 与自身配置的同时，保留正常的 git status 和客户端会话历史？',
        a: 'Aegis OS 采取两项内核级分层挂载设计：（1）将宿主机 .git 目录只读绑定（--ro-bind）到影子工作区以零拷贝共享 objects/refs，同时将单文件 .git/index 复制到沙箱私有目录并通过 GIT_INDEX_FILE 环境变量指向该副本，配合安全 Git Shim 禁用 core.fsmonitor 与 hooksPath；（2）对 ~/.claude/projects、~/.codex/sessions 等运行期状态子目录按需可写挂载，随后在顶层对 ~/.claude/settings.json、~/.gemini/config/hooks.json、~/.codex/config.toml 执行单文件 --ro-bind 只读锁定，防止 Agent 自篡改配置。',
      },
      {
        q: '为什么不能用标准 HTTPS CONNECT 代理宣称具备 L7 DLP 与请求方法审计？Aegis OS 如何解决？',
        a: '标准 HTTPS CONNECT 是端到端 TLS 加密隧道，代理只能观测到 host:port 与流量字节数，无法看到 HTTP Method（GET/POST）、URL Path 或 Request Body。Aegis OS 诚实区分两层默认出站网关：对通用 HTTPS 与包管理器采用零延迟的 L4 CONNECT 隧道（仅评估 net.connect 域名/端口白名单，不破坏证书 Pinning）；对大模型与核心 SaaS API 则通过注入 ANTHROPIC_BASE_URL / OPENAI_BASE_URL 采用 L7 反向代理模式（评估 net.request、在边界代填 API 密钥使沙箱内零明文凭据，并执行请求体 DLP 扫描与 SSE 零缓冲流式转发）。',
      },
    ],
    faq_en: [
      {
        q: 'Why can’t agent plugins (PreToolUse hooks + MCP servers) serve as a true security boundary?',
        a: 'Because plugins and hooks execute inside the same host user privilege domain (same UID, filesystem view, and syscall surface) as the supervised agent. Under prompt injection or configuration drift, an agent can invoke uncovered native tools (e.g., NotebookEdit), attach to an unsandboxed background daemon (OpenCode --attach), overwrite its own ~/.claude/settings.json to strip hooks, or trigger host code execution via build.rs or .git/config fsmonitor during seemingly benign commands. Plugins provide Advisory ergonomics; true Enforced isolation requires aegis-os run to act as the parent process and confine the entire agent tree inside an OS kernel sandbox.',
      },
      {
        q: 'How does aegis-os run keep git status and stateful agent sessions working without letting the agent tamper with .git or its own security settings?',
        a: 'Through two layered mount mechanisms: (1) It bind-mounts the host .git directory read-only into the shadow workspace for zero-copy object access, copies only the single-file .git/index into a private session path pointed to by GIT_INDEX_FILE, and injects a hardened Git shim that disables core.fsmonitor and hooksPath; (2) It mounts runtime state directories (~/.claude/projects, ~/.codex/sessions, ~/.local/share/opencode) writable first, then overlays single-file read-only mounts (--ro-bind) onto ~/.claude/settings.json, ~/.gemini/config/hooks.json, and ~/.codex/config.toml so the agent cannot disarm its own supervision.',
      },
      {
        q: 'Why does Aegis OS separate L4 HTTPS CONNECT tunnels from L7 Base URL reverse proxies?',
        a: 'A standard HTTPS CONNECT proxy only sees host:port over an encrypted TLS tunnel—it cannot inspect HTTP methods, URL paths, or request bodies without breaking TLS via MITM. Aegis OS therefore uses a dual-mode gateway: general HTTPS traffic uses an L4 CONNECT tunnel (enforcing net.connect domain/port allowlists with zero streaming overhead and intact certificate pinning), while LLM and SaaS APIs use an L7 Base URL reverse proxy (via ANTHROPIC_BASE_URL / OPENAI_BASE_URL) that performs net.request method auditing, boundary API key injection (keeping raw keys out of the sandbox), and request-body DLP without buffering streaming SSE tokens.',
      },
    ],
  },
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
    max-width: 1080px;
    margin: 0 auto;
    padding: 0.95rem 1.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    flex-wrap: nowrap;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    color: var(--ink);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .brand-mark {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }
  .mark-bar { fill: var(--ink); }
  .mark-accent { fill: var(--heurion-mint); }
  .brand-text {
    display: inline-flex;
    align-items: baseline;
    gap: 0.55rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .brand-name {
    font-family: var(--serif);
    font-size: 1.08rem;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--ink);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .brand-role {
    font-size: 0.78rem;
    color: var(--ink-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .nav-links {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    font-size: 0.82rem;
    color: var(--ink-secondary);
    flex-wrap: nowrap;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .nav-links a {
    white-space: nowrap;
    flex-shrink: 0;
  }
  .nav-links a:hover {
    color: var(--accent);
  }
  .lang-switch {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--mono);
    font-size: 0.73rem;
    line-height: 1.2;
    padding: 0.24rem 0.6rem;
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--ink);
    white-space: nowrap;
    flex-shrink: 0;
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
    padding: 1.5rem 0.25rem;
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
    flex-direction: column;
    gap: 0.2rem;
  }
  .post-row-meta-top {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .post-row-cat {
    font-size: 0.68rem;
    color: var(--accent);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .post-row-num {
    color: var(--accent-warm);
    font-weight: 500;
  }
  .post-row-main {
    display: flex;
    flex-direction: column;
    gap: 0.38rem;
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
  .post-row-sub {
    font-size: 0.88rem;
    line-height: 1.58;
    color: var(--ink-secondary);
    margin: 0;
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
  .article-md-link {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--accent);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    padding: 0.12rem 0.48rem;
    text-transform: none;
    letter-spacing: 0.02em;
  }
  .article-md-link:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
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

  /* GEO Capsule: Reproducible Artifacts, Internal Mesh & FAQ */
  .geo-capsule-box {
    margin-top: 3.25rem;
    padding: 1.65rem 1.75rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-top: 2px solid var(--accent);
  }
  .geo-capsule-eyebrow {
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 0.4rem;
  }
  .geo-capsule-heading {
    font-family: var(--serif);
    font-size: 1.22rem;
    font-weight: 500;
    color: var(--ink);
    margin: 0 0 1rem 0;
  }
  .geo-mesh-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.85rem;
    margin-bottom: 1.5rem;
  }
  .geo-mesh-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.85rem 0.95rem;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    transition: border-color 0.15s ease;
  }
  .geo-mesh-card:hover {
    border-color: var(--accent);
  }
  .geo-mesh-title {
    font-size: 0.86rem;
    font-weight: 600;
    color: var(--accent);
  }
  .geo-mesh-desc {
    font-size: 0.78rem;
    line-height: 1.48;
    color: var(--ink-secondary);
  }
  .geo-faq-list {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    border-top: 1px solid var(--border);
    padding-top: 1.15rem;
  }
  .geo-faq-item h3 {
    font-family: var(--serif);
    font-size: 1rem;
    font-weight: 500;
    color: var(--ink);
    margin: 0 0 0.3rem 0;
  }
  .geo-faq-item p {
    font-size: 0.88rem;
    line-height: 1.65;
    color: var(--ink-secondary);
    margin: 0;
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
  .footer-links {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .footer-links a:hover {
    color: var(--accent);
  }

  @media (max-width: 880px) {
    .brand-role { display: none; }
  }

  @media (max-width: 640px) {
    .top-nav-inner { padding: 0.85rem 1.2rem; gap: 1rem; overflow-x: auto; }
    .nav-links { gap: 0.85rem; }
    .wrap { padding: 2.25rem 1.2rem 4rem; }
    .post-row-link { grid-template-columns: 1fr; gap: 0.35rem; padding: 1.15rem 0; }
    .post-row-arrow { display: none; }
    .geo-mesh-grid { grid-template-columns: 1fr; }
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

const OG_IMAGE_WIDTH = 1200
const OG_IMAGE_HEIGHT = 630
const DEFAULT_OG_IMAGE = 'https://heurion.org/site/og-heurion-research.png'
const TWITTER_HANDLE = '@0xSynapse'

function postOgImage(post: BlogPostMeta, isEn: boolean): string {
  return (isEn ? post.og_image_en : post.og_image_zh) ?? DEFAULT_OG_IMAGE
}

function postOgTitle(post: BlogPostMeta, isEn: boolean): string {
  return (isEn ? post.og_title_en : post.og_title_zh) ?? (isEn ? post.title_en : post.title_zh)
}

function postOgDescription(post: BlogPostMeta, isEn: boolean): string {
  return (isEn ? post.og_description_en : post.og_description_zh) ?? (isEn ? post.summary_en : post.summary_zh)
}

function socialImageMeta(image: string, alt: string): string {
  return `<meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:width" content="${OG_IMAGE_WIDTH}">
  <meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">
  <meta property="og:image:alt" content="${escapeHtml(alt)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
  <meta name="twitter:image:alt" content="${escapeHtml(alt)}">`
}

function twitterSiteMeta(): string {
  return `<meta name="twitter:site" content="${TWITTER_HANDLE}">
  <meta name="twitter:creator" content="${TWITTER_HANDLE}">`
}

/**
 * 渲染个人博客首页（Nordic 纸感色调 + 结构化标题/摘要列表 + CollectionPage JSON-LD）
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
    ? 'Heurion Research · Systems Monographs & Technical Blog (Dual-Surface CRDT, Capability Parity & Aegis OS)'
    : 'Heurion Research · 技术博客与系统架构专论（双表面 CRDT · 人机同权 · Aegis OS）'
  const description = isEn
    ? 'Long-form systems architecture monographs by Hui Zhao (@0xSynapse) at Heurion Research: Dual-Surface ProseMirror + Yjs CRDTs, byte-preserving OOXML patching, Human-Agent Capability Parity, and Aegis OS Copy-on-Write shadow workspaces.'
    : 'Heurion Research 系统架构专论与工程手记：深度解析双表面 ProseMirror + Yjs CRDT、字节级 OOXML 补丁架构、人机同权（Capability Parity）、AI 申请权限全链路可审计性，以及 Aegis OS 写时复制影子工作区与文件锁协同。'
  const keywords = isEn
    ? 'Heurion Research, Technical Blog, Dual-Surface CRDT, OOXML patchParagraph, ProseMirror Yjs, Capability Parity, AI Agent Permission Auditability, Aegis OS, Copy-on-Write Shadow Workspace, Hui Zhao, 0xSynapse'
    : 'Heurion Research, 技术博客, 双表面 CRDT, OOXML 字节级补丁, 人机同权, Capability Parity, AI 权限审计, Aegis OS, 影子工作区, 文件认领锁'
  const ogImage = isEn
    ? 'https://heurion.org/site/og-blog-home-en.png'
    : 'https://heurion.org/site/og-blog-home-zh.png'
  const ogTitle = isEn
    ? 'Heurion Research · Systems Monographs'
    : 'Heurion Research · 系统架构专论'
  const ogDescription = isEn
    ? 'Dual-Surface CRDTs, human-agent capability parity, and the Aegis OS transactional agent kernel—long-form systems monographs by Hui Zhao.'
    : '双表面 CRDT、人机同权与 Aegis OS 事务级智能体操作系统：Hui Zhao 的系统架构长文与工程手记。'
  const ogImageAlt = isEn
    ? 'Heurion Research — Systems Monographs'
    : 'Heurion Research — 系统架构专论'

  const listItemsHtml = allPosts
    .map(p => {
      const pTitle = isEn ? p.title_en : p.title_zh
      const pSub = isEn ? p.subtitle_en : p.subtitle_zh
      const pCat = p.category
      const href = u.postHref(p.slug)
      return `
      <li class="post-row">
        <a class="post-row-link" href="${href}">
          <span class="post-row-meta">
            <span class="post-row-meta-top">
              <span class="post-row-num">${escapeHtml(p.num)}</span>
              <time datetime="${escapeHtml(p.date)}">${escapeHtml(p.date)}</time>
            </span>
            <span class="post-row-cat">${escapeHtml(pCat)}</span>
          </span>
          <div class="post-row-main">
            <h2 class="post-row-title">${escapeHtml(pTitle)}</h2>
            <p class="post-row-sub">${escapeHtml(pSub)}</p>
          </div>
          <span class="post-row-arrow" aria-hidden="true">→</span>
        </a>
      </li>`
    })
    .join('\n')

  const homeJsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': ['Blog', 'CollectionPage'],
        '@id': `${u.canonicalUrl}#blog`,
        name: title,
        description,
        url: u.canonicalUrl,
        inLanguage: isEn ? 'en-US' : 'zh-CN',
        author: {
          '@type': 'Person',
          name: 'Hui Zhao',
          alternateName: '0xSynapse',
          url: 'https://github.com/0xSynapse',
          affiliation: {
            '@type': 'Organization',
            name: 'Heurion Research',
            url: 'https://heurion.org',
          },
        },
        publisher: {
          '@type': 'Organization',
          name: 'Heurion Research',
          url: 'https://heurion.org',
          sameAs: ['https://github.com/heurion-org', 'https://github.com/0xSynapse'],
        },
        blogPost: allPosts.map(p => ({
          '@type': 'TechArticle',
          headline: isEn ? p.title_en : p.title_zh,
          description: isEn ? p.summary_en : p.summary_zh,
          datePublished: p.date,
          url: isEn
            ? subdomain
              ? `https://blog.heurion.org/en/${p.slug}`
              : `https://heurion.org/en/blog/${p.slug}`
            : subdomain
              ? `https://blog.heurion.org/${p.slug}`
              : `https://heurion.org/blog/${p.slug}`,
          author: {
            '@type': 'Person',
            name: 'Hui Zhao',
            url: 'https://github.com/0xSynapse',
          },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          {
            '@type': 'ListItem',
            position: 1,
            name: 'Heurion Research',
            item: isEn ? 'https://heurion.org/en' : 'https://heurion.org/',
          },
          {
            '@type': 'ListItem',
            position: 2,
            name: isEn ? 'Technical Blog & Systems Monographs' : '技术博客与系统架构专论',
            item: u.canonicalUrl,
          },
        ],
      },
    ],
  }

  return `<!doctype html>
<html lang="${isEn ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="shortcut icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-10 -2 112 104'%3E%3Crect x='-10' y='-2' width='112' height='104' rx='22' fill='%23FAF8F4' stroke='%23E5E0D6' stroke-width='2'/%3E%3Crect x='6' y='18' width='16' height='66' rx='8' fill='%23151C19'/%3E%3Crect x='60' y='35' width='16' height='49' rx='8' fill='%23151C19'/%3E%3Crect x='18' y='45' width='46' height='16' rx='8' fill='%230A7D52'/%3E%3Ccircle cx='76' cy='24' r='10' fill='%2300C472'/%3E%3C/svg%3E">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="keywords" content="${escapeHtml(keywords)}">
  <meta name="author" content="Hui Zhao (@0xSynapse) · Heurion Research">
  <link rel="canonical" href="${u.canonicalUrl}">
  <link rel="alternate" hreflang="zh-CN" href="${u.zhCanonicalUrl}">
  <link rel="alternate" hreflang="en" href="${u.enCanonicalUrl}">
  <link rel="alternate" hreflang="x-default" href="${u.zhCanonicalUrl}">
  <link rel="alternate" type="application/rss+xml" title="Heurion Research RSS Feed" href="${u.rssHref}">
  <link rel="alternate" type="text/markdown" title="Markdown Blog Index" href="${u.mdHref}">
  <link rel="alternate" type="text/plain" title="LLM Overview" href="/llms.txt">
  <link rel="alternate" type="text/plain" title="LLM Technical Manual" href="/llms-full.txt">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Heurion Research">
  <meta property="og:title" content="${escapeHtml(ogTitle)}">
  <meta property="og:description" content="${escapeHtml(ogDescription)}">
  <meta property="og:url" content="${u.canonicalUrl}">
  <meta property="og:locale" content="${isEn ? 'en_US' : 'zh_CN'}">
  <meta property="og:locale:alternate" content="${isEn ? 'zh_CN' : 'en_US'}">
  ${socialImageMeta(ogImage, ogImageAlt)}
  <meta name="twitter:card" content="summary_large_image">
  ${twitterSiteMeta()}
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}">
  <meta name="twitter:description" content="${escapeHtml(ogDescription)}">
  <script type="application/ld+json">${JSON.stringify(homeJsonLd)}</script>
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
        <a href="${isEn ? 'https://heurion.org/en' : 'https://heurion.org'}">heurion.org</a>
        <a href="${isEn ? '/en/tools' : '/tools'}">${isEn ? 'Clinical Tools' : '临床工具'}</a>
        <a href="${isEn ? '/en/aegis-os/' : '/aegis-os/'}">Aegis OS</a>
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
              ? 'Bilingual systems monographs by Hui Zhao (@0xSynapse) on Dual-Surface CRDT document engines, human-agent capability parity, auditable permission governance, and transactional agent operating systems.'
              : '由 Hui Zhao (@0xSynapse) 撰写的双语系统架构专论：聚焦双表面 CRDT 文档引擎、人机同权（Capability Parity）、AI 申请权限全链路可审计性，以及 Aegis OS 事务级智能体操作系统。'
          }
        </p>
      </div>

      <ul class="post-list">
        ${listItemsHtml}
      </ul>
    </main>

    <footer class="site-footer">
      <span>© 2026 Heurion Research · Hui Zhao (@0xSynapse)</span>
      <div class="footer-links">
        <a href="https://heurion.org/blog">heurion.org/blog</a>
        <a href="${u.mdHref}">Markdown (.md)</a>
        <a href="/llms.txt">LLMs.txt</a>
        <a href="/sitemap.xml">Sitemap</a>
      </div>
    </footer>
  </div>
</body>
</html>`
}

/**
 * 渲染单篇博客文章页（Nordic 纸感专业排版 + GEO 证据与问答胶囊 + E-E-A-T 复合 JSON-LD + 读者评论）
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
  const ogTitle = postOgTitle(post, isEn)
  const ogDescription = postOgDescription(post, isEn)
  const ogImage = postOgImage(post, isEn)
  const ogImageAlt = `${ogTitle} — Heurion Research`

  const rawProse = isEn ? post.body_en : post.body_zh
  const finalProse = rawProse.replace('<div id="omnidoc-live-studio-mount"></div>', '')

  const geoExtra = BLOG_GEO_EXTRAS[slug]
  const faqItems = geoExtra ? (isEn ? geoExtra.faq_en : geoExtra.faq_zh) : []
  const meshLinks = geoExtra ? (isEn ? geoExtra.links_en : geoExtra.links_zh) : []

  const geoCapsuleHtml = geoExtra
    ? `
      <aside class="geo-capsule-box" aria-label="${isEn ? 'Reproducible Artifacts & Technical FAQ' : '可复现开源构件与核心技术问答'}">
        <div class="geo-capsule-eyebrow">${isEn ? 'REPRODUCIBLE ARTIFACTS · LIVE TOOLS & TECHNICAL FAQ' : 'REPRODUCIBLE ARTIFACTS · 关联线上系统与核心技术问答'}</div>
        <h2 class="geo-capsule-heading">${isEn ? 'Explore Live Systems & Open-Source Code' : '关联在线工具、开源仓库与核心问答'}</h2>
        <div class="geo-mesh-grid">
          ${meshLinks
            .map(
              l => `<a class="geo-mesh-card" href="${l.href}">
                <span class="geo-mesh-title">${escapeHtml(l.label)} →</span>
                <span class="geo-mesh-desc">${escapeHtml(l.desc)}</span>
              </a>`,
            )
            .join('\n')}
        </div>
        <div class="geo-faq-list">
          ${faqItems
            .map(
              f => `<div class="geo-faq-item">
                <h3>${escapeHtml(f.q)}</h3>
                <p>${escapeHtml(f.a)}</p>
              </div>`,
            )
            .join('\n')}
        </div>
      </aside>`
    : ''

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

  const graphNodes: Record<string, unknown>[] = [
    {
      '@type': ['TechArticle', 'BlogPosting'],
      '@id': `${u.canonicalUrl}#article`,
      headline: postTitle,
      alternativeHeadline: postSubtitle,
      description,
      datePublished: post.date,
      dateModified: post.date,
      url: u.canonicalUrl,
      mainEntityOfPage: u.canonicalUrl,
      inLanguage: isEn ? 'en-US' : 'zh-CN',
      author: {
        '@type': 'Person',
        name: 'Hui Zhao',
        alternateName: '0xSynapse',
        url: 'https://github.com/0xSynapse',
        affiliation: {
          '@type': 'Organization',
          name: 'Heurion Research',
          url: 'https://heurion.org',
        },
      },
      publisher: {
        '@type': 'Organization',
        name: 'Heurion Research',
        url: 'https://heurion.org/',
        sameAs: ['https://github.com/heurion-org', 'https://github.com/0xSynapse'],
      },
      isPartOf: {
        '@type': 'Blog',
        name: isEn
          ? 'Heurion Research · Technical Blog & Systems Monographs'
          : 'Heurion Research · 技术博客与系统架构专论',
        url: isEn ? 'https://heurion.org/en/blog' : 'https://heurion.org/blog',
      },
      ...(geoExtra
        ? {
            codeRepository: geoExtra.repoUrl,
            citation: geoExtra.paperUrl,
          }
        : {}),
      keywords,
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Heurion Research',
          item: isEn ? 'https://heurion.org/en' : 'https://heurion.org/',
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: isEn ? 'Technical Blog' : '技术博客',
          item: isEn ? 'https://heurion.org/en/blog' : 'https://heurion.org/blog',
        },
        {
          '@type': 'ListItem',
          position: 3,
          name: postTitle,
          item: u.canonicalUrl,
        },
      ],
    },
  ]

  if (faqItems.length > 0) {
    graphNodes.push({
      '@type': 'FAQPage',
      mainEntity: faqItems.map(f => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: {
          '@type': 'Answer',
          text: f.a,
        },
      })),
    })
  }

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': graphNodes,
  }

  return `<!doctype html>
<html lang="${isEn ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(postTitle)} · Heurion Research</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="shortcut icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-10 -2 112 104'%3E%3Crect x='-10' y='-2' width='112' height='104' rx='22' fill='%23FAF8F4' stroke='%23E5E0D6' stroke-width='2'/%3E%3Crect x='6' y='18' width='16' height='66' rx='8' fill='%23151C19'/%3E%3Crect x='60' y='35' width='16' height='49' rx='8' fill='%23151C19'/%3E%3Crect x='18' y='45' width='46' height='16' rx='8' fill='%230A7D52'/%3E%3Ccircle cx='76' cy='24' r='10' fill='%2300C472'/%3E%3C/svg%3E">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="keywords" content="${escapeHtml(keywords)}">
  <meta name="author" content="Hui Zhao (@0xSynapse) · Heurion Research">
  <link rel="canonical" href="${u.canonicalUrl}">
  <link rel="alternate" hreflang="zh-CN" href="${u.zhCanonicalUrl}">
  <link rel="alternate" hreflang="en" href="${u.enCanonicalUrl}">
  <link rel="alternate" hreflang="x-default" href="${u.zhCanonicalUrl}">
  <link rel="alternate" type="text/markdown" title="Markdown Source for LLMs & Agents" href="${u.mdHref}">
  <link rel="alternate" type="text/plain" title="LLM Overview" href="/llms.txt">
  <link rel="alternate" type="text/plain" title="LLM Technical Manual" href="/llms-full.txt">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Heurion Research">
  <meta property="og:title" content="${escapeHtml(ogTitle)}">
  <meta property="og:description" content="${escapeHtml(ogDescription)}">
  <meta property="og:url" content="${u.canonicalUrl}">
  <meta property="og:locale" content="${isEn ? 'en_US' : 'zh_CN'}">
  <meta property="og:locale:alternate" content="${isEn ? 'zh_CN' : 'en_US'}">
  ${socialImageMeta(ogImage, ogImageAlt)}
  <meta property="article:published_time" content="${escapeHtml(post.date)}">
  <meta property="article:author" content="https://github.com/0xSynapse">
  <meta name="twitter:card" content="summary_large_image">
  ${twitterSiteMeta()}
  <meta name="twitter:title" content="${escapeHtml(ogTitle)}">
  <meta name="twitter:description" content="${escapeHtml(ogDescription)}">
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
        <a href="${u.mdHref}" class="lang-switch" title="${isEn ? 'View clean Markdown for LLM/Agent ingestion' : '查看面向大模型与智能体的纯净 Markdown'}">.MD</a>
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
            <span>·</span>
            <span>Hui Zhao (@0xSynapse)</span>
            <a class="article-md-link" href="${u.mdHref}">Markdown (.md)</a>
          </div>
          <h1 class="article-title">${escapeHtml(postTitle)}</h1>
          <p class="article-subtitle">${escapeHtml(postSubtitle)}</p>
        </header>

        <div class="prose">
          ${finalProse}
        </div>

        ${geoCapsuleHtml}
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
      <span>© 2026 Heurion Research · Hui Zhao (@0xSynapse)</span>
      <div class="footer-links">
        <a href="${u.homeHref}">${isEn ? '← All Articles' : '← 全部文章'}</a>
        <a href="${u.mdHref}">Markdown (.md)</a>
        <a href="/llms.txt">LLMs.txt</a>
      </div>
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
 * 将文章 HTML 正文转换为面向 AI Crawler / RAG / Agent 的高信噪比 Markdown
 */
function htmlProseToCleanMarkdown(html: string): string {
  return html
    .replace(/<figure class="blog-diagram">[\s\S]*?<figcaption>([\s\S]*?)<\/figcaption>\s*<\/figure>/gi, '\n> **[Diagram]** $1\n')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<div class="blog-callout">\s*<div class="blog-callout-title">([\s\S]*?)<\/div>\s*<p>([\s\S]*?)<\/p>\s*<\/div>/gi, '\n> **$1**: $2\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<strong>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<li>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<\/?(?:ul|ol|p|div|section|article|header|tbody|thead|table)[^>]*>/gi, '\n')
    .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row: string) => {
      const cells = Array.from(row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)).map(m =>
        m[1]!.replace(/<[^>]+>/g, '').trim(),
      )
      return cells.length ? `| ${cells.join(' | ')} |\n` : ''
    })
    .replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 渲染面向 AI Agent / Perplexity / ChatGPT Search 的纯净 Markdown 博客索引 (`/blog.md` & `/en/blog.md`)
 */
export function renderBlogIndexMarkdown(lang: 'zh' | 'en'): string {
  const isEn = lang === 'en'
  const allPosts = getAllPostsMerged()
  const lines: string[] = [
    isEn
      ? '# Heurion Research — Systems Architecture Monographs & Technical Blog'
      : '# Heurion Research — 技术博客与系统架构专论',
    '',
    `> Canonical Index: ${isEn ? 'https://heurion.org/en/blog' : 'https://heurion.org/blog'}`,
    '> Author: Hui Zhao (`@0xSynapse`, Founder of Heurion Research, Rotterdam, Netherlands)',
    '> Organization: Heurion Research (`https://heurion.org` · `https://github.com/heurion-org`)',
    '',
    isEn ? '## Published Systems Monographs' : '## 已发布系统架构专论',
    '',
  ]

  for (const p of allPosts) {
    const title = isEn ? p.title_en : p.title_zh
    const sub = isEn ? p.subtitle_en : p.subtitle_zh
    const summary = isEn ? p.summary_en : p.summary_zh
    const htmlUrl = isEn ? `https://heurion.org/en/blog/${p.slug}` : `https://heurion.org/blog/${p.slug}`
    const mdUrl = isEn ? `https://heurion.org/en/blog/${p.slug}.md` : `https://heurion.org/blog/${p.slug}.md`
    lines.push(`### ${p.num}. ${title}`)
    lines.push(`- **Date**: ${p.date} · **Category**: ${p.category}`)
    lines.push(`- **Subtitle**: ${sub}`)
    lines.push(`- **Summary**: ${summary}`)
    lines.push(`- **Canonical URL**: ${htmlUrl}`)
    lines.push(`- **Clean Markdown Source**: ${mdUrl}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 渲染单篇专论的纯净 Markdown 源 (`/blog/:slug.md` & `/en/blog/:slug.md`)
 */
export function renderBlogPostMarkdown(slug: string, lang: 'zh' | 'en'): string | null {
  const found = findBlogPostBySlug(slug)
  if (!found) return null
  const { post } = found
  const isEn = lang === 'en'
  const title = isEn ? post.title_en : post.title_zh
  const sub = isEn ? post.subtitle_en : post.subtitle_zh
  const summary = isEn ? post.summary_en : post.summary_zh
  const canonicalUrl = isEn
    ? `https://heurion.org/en/blog/${post.slug}`
    : `https://heurion.org/blog/${post.slug}`
  const alternateUrl = isEn
    ? `https://heurion.org/blog/${post.slug}`
    : `https://heurion.org/en/blog/${post.slug}`
  const extra = BLOG_GEO_EXTRAS[slug]
  const faqs = extra ? (isEn ? extra.faq_en : extra.faq_zh) : []

  const bodyMd = htmlProseToCleanMarkdown(isEn ? post.body_en : post.body_zh)

  const faqMd = faqs.length
    ? [
        '',
        isEn ? '## Frequently Asked Questions (Technical FAQ)' : '## 核心技术问答 (Technical FAQ)',
        '',
        ...faqs.flatMap(f => [`### Q: ${f.q}`, `${f.a}`, '']),
      ].join('\n')
    : ''

  return [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `subtitle: "${sub.replace(/"/g, '\\"')}"`,
    `author: "Hui Zhao (@0xSynapse, Heurion Research)"`,
    `date: "${post.date}"`,
    `canonical_url: "${canonicalUrl}"`,
    `alternate_language_url: "${alternateUrl}"`,
    ...(extra ? [`code_repository: "${extra.repoUrl}"`, `paper_preprint: "${extra.paperUrl}"`] : []),
    '---',
    '',
    `# ${title}`,
    '',
    `> **${sub}**`,
    `>`,
    `> **Executive Summary**: ${summary}`,
    '',
    bodyMd,
    faqMd,
  ].join('\n')
}

/**
 * 渲染 RSS 2.0 订阅源 XML
 */
export function renderBlogRssXml(lang: 'zh' | 'en', opts?: { subdomain?: boolean }): string {
  const isEn = lang === 'en'
  const subdomain = opts?.subdomain ?? false
  const channelTitle = isEn
    ? 'Heurion Research — Technical Notes (Heurion 2.0 & Aegis OS)'
    : 'Heurion Research — 技术博客（Heurion 2.0 与 Aegis OS）'
  const channelDesc = isEn
    ? 'Technical monographs by Heurion Research on Dual-Surface CRDTs, Clinical Research AI, and Transactional Agent Operating Systems.'
    : 'Heurion Research 关于双表面 CRDT、临床科研工作台与 Aegis OS 事务级智能体操作系统的技术文章。'
  const channelLink = subdomain
    ? isEn
      ? 'https://blog.heurion.org/en'
      : 'https://blog.heurion.org/'
    : isEn
      ? 'https://heurion.org/en/blog'
      : 'https://heurion.org/blog'
  const selfFeedUrl = subdomain
    ? `https://blog.heurion.org/${isEn ? 'en/feed.xml' : 'feed.xml'}`
    : `https://heurion.org/${isEn ? 'en/blog/feed.xml' : 'blog/feed.xml'}`
  const allPosts = getAllPostsMerged()

  const itemsXml = allPosts
    .map(p => {
      const title = isEn ? p.title_en : p.title_zh
      const desc = isEn ? p.summary_en : p.summary_zh
      const link = subdomain
        ? isEn
          ? `https://blog.heurion.org/en/${p.slug}`
          : `https://blog.heurion.org/${p.slug}`
        : isEn
          ? `https://heurion.org/en/blog/${p.slug}`
          : `https://heurion.org/blog/${p.slug}`
      const pubDate = new Date(`${p.date}T09:00:00Z`).toUTCString()
      return `    <item>
      <title>${escapeHtml(title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${pubDate}</pubDate>
      <author>huizhao@heurion.org (Hui Zhao · Heurion Research)</author>
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
    <atom:link href="${selfFeedUrl}" rel="self" type="application/rss+xml"/>
${itemsXml}
  </channel>
</rss>`
}

/**
 * 渲染博客专属 Sitemap XML（同时包含主站 `heurion.org/blog` 规范地址与双语互链）
 */
export function renderBlogSitemapXml(opts?: { subdomain?: boolean }): string {
  const subdomain = opts?.subdomain ?? false
  const allPosts = getAllPostsMerged()
  const baseZh = subdomain ? 'https://blog.heurion.org/' : 'https://heurion.org/blog'
  const baseEn = subdomain ? 'https://blog.heurion.org/en' : 'https://heurion.org/en/blog'
  const urls: string[] = [
    `  <url>
    <loc>${baseZh}</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>`,
    `  <url>
    <loc>${baseEn}</loc>
    <changefreq>weekly</changefreq>
    <priority>0.95</priority>
  </url>`,
  ]

  for (const p of allPosts) {
    const zhLoc = subdomain ? `https://blog.heurion.org/${p.slug}` : `https://heurion.org/blog/${p.slug}`
    const enLoc = subdomain
      ? `https://blog.heurion.org/en/${p.slug}`
      : `https://heurion.org/en/blog/${p.slug}`
    urls.push(`  <url>
    <loc>${zhLoc}</loc>
    <lastmod>${p.date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>`)
    urls.push(`  <url>
    <loc>${enLoc}</loc>
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
 * 注册博客路由（同时挂载：`heurion.org/blog*` 规范路径 + `.md` GEO 端点 + `blog.heurion.org` 子域名兼容 + 评论与双表面 CRDT 发布 API）
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
  const sendMarkdown = (c: any, md: string) =>
    c.body(md, 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
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
    if (path === '/blog.md') {
      return sendMarkdown(c, renderBlogIndexMarkdown('zh'))
    }
    if (path === '/en/blog.md') {
      return sendMarkdown(c, renderBlogIndexMarkdown('en'))
    }
    if (path === '/feed.xml' || path === '/rss.xml' || path === '/blog/feed.xml') {
      return sendXml(c, renderBlogRssXml('zh', { subdomain: true }))
    }
    if (path === '/en/feed.xml' || path === '/en/rss.xml' || path === '/en/blog/feed.xml') {
      return sendXml(c, renderBlogRssXml('en', { subdomain: true }))
    }
    if (path === '/sitemap.xml') {
      return sendXml(c, renderBlogSitemapXml({ subdomain: true }))
    }
    if (path === '/robots.txt') {
      return c.text(
        'User-agent: *\nAllow: /\nSitemap: https://heurion.org/sitemap.xml\n',
        200,
      )
    }
    const zhMdMatch = /^\/(?:posts\/|blog\/)?([a-z0-9-]+)\.md$/.exec(path)
    if (zhMdMatch?.[1] && findBlogPostBySlug(zhMdMatch[1])) {
      return sendMarkdown(c, renderBlogPostMarkdown(zhMdMatch[1], 'zh')!)
    }
    const enMdMatch = /^\/en\/(?:posts\/|blog\/)?([a-z0-9-]+)\.md$/.exec(path)
    if (enMdMatch?.[1] && findBlogPostBySlug(enMdMatch[1])) {
      return sendMarkdown(c, renderBlogPostMarkdown(enMdMatch[1], 'en')!)
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

  // 主站规范路径 (https://heurion.org/blog*) 与 GEO Markdown 端点
  const shouldRedirectToSubdomain = (c: any): boolean =>
    process.env.BLOG_REDIRECT_SUBDOMAIN === '1' || c.req.query('redirect') === '1'

  app.get('/blog.md', (c: any) => sendMarkdown(c, renderBlogIndexMarkdown('zh')))
  app.get('/en/blog.md', (c: any) => sendMarkdown(c, renderBlogIndexMarkdown('en')))

  app.get('/blog', (c: any) => {
    if (shouldRedirectToSubdomain(c)) return c.redirect('https://blog.heurion.org/', 302)
    const accept = String(c.req.header('accept') ?? '')
    if (accept.includes('text/markdown')) return sendMarkdown(c, renderBlogIndexMarkdown('zh'))
    return sendHtml(c, renderBlogHomeHtml('zh', { subdomain: false }))
  })
  app.get('/blog/', (c: any) =>
    shouldRedirectToSubdomain(c)
      ? c.redirect('https://blog.heurion.org/', 302)
      : c.redirect('/blog', 301),
  )
  app.get('/en/blog', (c: any) => {
    if (shouldRedirectToSubdomain(c)) return c.redirect('https://blog.heurion.org/en', 302)
    const accept = String(c.req.header('accept') ?? '')
    if (accept.includes('text/markdown')) return sendMarkdown(c, renderBlogIndexMarkdown('en'))
    return sendHtml(c, renderBlogHomeHtml('en', { subdomain: false }))
  })
  app.get('/en/blog/', (c: any) =>
    shouldRedirectToSubdomain(c)
      ? c.redirect('https://blog.heurion.org/en', 302)
      : c.redirect('/en/blog', 301),
  )

  // 容错 301 重定向：将误写的 /blog/en 及 /blog/en/:slug 自动引导至规范路径 /en/blog*
  app.get('/blog/en', (c: any) => c.redirect('/en/blog', 301))
  app.get('/blog/en/', (c: any) => c.redirect('/en/blog', 301))
  app.get('/blog/en/:slug', (c: any) => {
    const slug = String(c.req.param('slug') ?? '').replace(/\/+$/, '')
    return c.redirect(`/en/blog/${slug}`, 301)
  })

  app.get('/blog/feed.xml', (c: any) => sendXml(c, renderBlogRssXml('zh', { subdomain: false })))
  app.get('/blog/rss.xml', (c: any) => sendXml(c, renderBlogRssXml('zh', { subdomain: false })))
  app.get('/en/blog/feed.xml', (c: any) => sendXml(c, renderBlogRssXml('en', { subdomain: false })))
  app.get('/en/blog/rss.xml', (c: any) => sendXml(c, renderBlogRssXml('en', { subdomain: false })))

  app.get('/blog/:slug', (c: any) => {
    const rawParam = String(c.req.param('slug') ?? '')
    if (rawParam.endsWith('.md')) {
      const slug = rawParam.slice(0, -3)
      const md = renderBlogPostMarkdown(slug, 'zh')
      if (!md) return c.notFound()
      return sendMarkdown(c, md)
    }
    if (!findBlogPostBySlug(rawParam)) return c.notFound()
    if (shouldRedirectToSubdomain(c)) {
      return c.redirect(`https://blog.heurion.org/${rawParam}`, 302)
    }
    const accept = String(c.req.header('accept') ?? '')
    if (accept.includes('text/markdown')) {
      return sendMarkdown(c, renderBlogPostMarkdown(rawParam, 'zh')!)
    }
    return sendHtml(c, renderBlogPostHtml(rawParam, 'zh', { subdomain: false })!)
  })

  app.get('/en/blog/:slug', (c: any) => {
    const rawParam = String(c.req.param('slug') ?? '')
    if (rawParam.endsWith('.md')) {
      const slug = rawParam.slice(0, -3)
      const md = renderBlogPostMarkdown(slug, 'en')
      if (!md) return c.notFound()
      return sendMarkdown(c, md)
    }
    if (!findBlogPostBySlug(rawParam)) return c.notFound()
    if (shouldRedirectToSubdomain(c)) {
      return c.redirect(`https://blog.heurion.org/en/${rawParam}`, 302)
    }
    const accept = String(c.req.header('accept') ?? '')
    if (accept.includes('text/markdown')) {
      return sendMarkdown(c, renderBlogPostMarkdown(rawParam, 'en')!)
    }
    return sendHtml(c, renderBlogPostHtml(rawParam, 'en', { subdomain: false })!)
  })
}
