import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录：相对路径配置一律相对它解析。 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

function env(name: string, fallback?: string): string {
  const value = process.env[name]
  if (value !== undefined && value !== '') return value
  if (fallback !== undefined) return fallback
  throw new Error(`missing required env ${name}`)
}

const dataDir = resolve(repoRoot, env('HEURION_DATA_DIR', './data'))
const port = Number(env('PORT', '8787'))

export const config = {
  port,
  dataDir,
  dbPath: resolve(dataDir, 'platform', 'platform.db'),
  workspacesDir: resolve(dataDir, 'platform', 'workspaces'),
  dshHome: resolve(dataDir, 'platform', 'dsh-home'),
  renderDir: resolve(dataDir, 'platform', 'render'),
  secret: env('HEURION_SECRET', 'dev-secret-not-for-production-use!'),
  /**
   * 开发模式：除账户令牌外还接受开发令牌（`<令牌>` / `<令牌>:<名字>`，e2e 与浏览器测试用）。
   * 生产环境（NODE_ENV=production）默认关闭，且必须设置 HEURION_SECRET。
   */
  devMode: env('HEURION_DEV_MODE', process.env.NODE_ENV === 'production' ? '0' : '1') === '1',
  devToken: env('HEURION_DEV_TOKEN', 'dev'),
  devUser: env('HEURION_DEV_USER', 'dev'),
  provider: env('DSH_PROVIDER', 'deepseek-official'),
  model: env('DSH_MODEL', 'deepseek-flash'),
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
  ncbiApiKey: process.env.NCBI_API_KEY ?? '',
  /** Unsplash 图库（幻灯片搜图、插图）；不设则界面隐藏入口、接口返回「未配置」。 */
  unsplashAccessKey: process.env.UNSPLASH_ACCESS_KEY ?? '',
  contactEmail: process.env.CONTACT_EMAIL ?? '',
  /** dsh 进程回连平台 MCP 的地址。 */
  mcpUrl: env('HEURION_MCP_URL', `http://127.0.0.1:${port}/mcp`),
  /** dsh 调模型走平台代理（真实 key 不进 dsh）：dsh 用的地址与代理转发的上游。 */
  llmProxyUrl: env('HEURION_LLM_URL', `http://127.0.0.1:${port}/llm/v1`),
  llmUpstream: env('DEEPSEEK_UPSTREAM_URL', 'https://api.deepseek.com/anthropic/v1'),
  /** 邮件发信服务配置：标准 SMTP (首选) 或 Resend API */
  smtpHost: process.env.SMTP_HOST || process.env.NEXUS_SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || process.env.NEXUS_SMTP_PORT || '465'),
  smtpSecure: process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465' || process.env.NEXUS_SMTP_PORT === '465',
  smtpUser: process.env.SMTP_USER || process.env.NEXUS_SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || process.env.NEXUS_SMTP_PASSWORD || process.env.NEXUS_SMTP_PASS || '',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  emailFrom: process.env.EMAIL_FROM || process.env.SMTP_FROM || 'Heurion 临床工作站 <no-reply@heurion.org>',
  mailDomain: process.env.MAIL_DOMAIN || 'heurion.org',
  /** 本地嵌入服务（apps/embedder，bge-m3）；为空时资料库只用关键词检索。 */
  embeddingUrl: env('EMBEDDING_URL', 'http://127.0.0.1:8003'),
  /** 本地 PDF 结构化解析服务（apps/doc-parser，Docling）；设为空字符串（DOC_PARSER_URL=off）则 PDF 导入只用 poppler。 */
  docParserUrl: process.env.DOC_PARSER_URL === 'off' ? '' : env('DOC_PARSER_URL', 'http://127.0.0.1:8005'),
  /** 单个 PDF 的解析超时（CPU 上 Docling 每页约 1–3 秒，长文档需要更久） */
  docParserTimeoutMs: Number(env('DOC_PARSER_TIMEOUT_MS', String(10 * 60_000))),
  /**
   * AI 代码隔离（容器里开启）：每个平台用户的 dsh 进程及它执行的代码以专属 uid 运行（deploy/sandbox/heurion-sandbox-exec），
   * 读不到平台的数据库、密钥和其他用户的工作区。本机开发（macOS）不开。
   */
  sandbox: env('HEURION_SANDBOX', '0') === '1',
  dshHomesDir: resolve(dataDir, 'platform', 'dsh-homes'),
  /** 数据集（上传的原文件、规范化后的 data.csv 与概况）。 */
  datasetsDir: resolve(dataDir, 'platform', 'datasets'),
  /** 患者数据：每个机构一个子目录（patients.db + 加密文件），见 docs/design/TENANCY.md。 */
  tenantsDir: resolve(dataDir, 'tenants'),
  /** 平台主密钥（base64 的 32 字节）：包裹各机构的数据密钥。没配时从 HEURION_SECRET 派生。 */
  kek: process.env.HEURION_KEK ?? '',
  /** 计算用的 Python（统计、数据导入）：容器里是 /opt/compute 的 venv；本地开发用仓库里的 .venv-compute。 */
  computePython: env('HEURION_PYTHON', existsSync('/opt/compute/bin/python3') ? '/opt/compute/bin/python3' : resolve(repoRoot, '.venv-compute/bin/python3')),
  /** OCR 语言模型目录（镜像里构建时已下载好；本机开发第一次用时下载）。 */
  ocrCacheDir: env('HEURION_OCR_CACHE', resolve(dataDir, 'ocr-cache')),
  harnessIdleMs: Number(env('HARNESS_IDLE_MS', String(10 * 60_000))),
  /** 回合无响应超时：模型 / 工具连续这么久没有任何动静，自动停止该回合，放行队列。 */
  turnIdleTimeoutMs: Number(env('TURN_IDLE_TIMEOUT_MS', String(5 * 60_000))),
  /** 每个用户允许并发执行的文档任务数（默认 2 个，超出排队；Co-Pilot 随航走独立快车道，不占此配额）。 */
  maxDocConcurrency: Math.max(1, Number(env('MAX_DOC_CONCURRENCY', '2'))),
}

if (process.env.NODE_ENV === 'production' && config.secret === 'dev-secret-not-for-production-use!') {
  throw new Error('生产环境必须设置 HEURION_SECRET')
}

export type Config = typeof config
