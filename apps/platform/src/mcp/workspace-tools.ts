import { readFileSync, writeFileSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listDir, looksText, MCP_GET_MAX, MCP_PUT_MAX, readTarget, WorkspaceFileError, writeTarget } from '../aegis/files.ts'
import type { TokenClaims } from '../auth/token.ts'

/**
 * 外部智能体的工作区文件工具（aegis/files.ts，MCP_MODULES.md §3.4）。只在外部网关注册：
 * dsh 在服务器上本来就有 shell 与工作区，不需要它们（也保证 dsh 的工具清单不变）。
 * 不属于任何一个模块，挂在每个模块的地址上（modules.ts 的 SHARED_TOOLS）。
 */

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))
const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: JSON.stringify({ code, message, ...extra }, null, 2) }],
})
const filesUrl = (rel: string) => `/api/aegis/files/${rel.split('/').map(encodeURIComponent).join('/')}`
const asFail = (err: unknown) => {
  if (err instanceof WorkspaceFileError) return fail(err.code, err.message)
  throw err
}

export function registerWorkspaceTools(server: McpServer, deps: { claims: TokenClaims; workspaceDir: (userId: string) => string }): void {
  const { claims } = deps
  const workspace = () => deps.workspaceDir(claims.u)

  server.registerTool('workspace_put', {
    description: '把你本机的文件放进 Heurion 工作区（落在 aegis-files/ 下），返回 path；再把 path 传给其他工具的 path / file_path 参数（数据集上传、资料库上传、Word / PPT 导入、记忆导入等）。内容用 base64，≤10MB；更大的文件用 PUT /api/aegis/files/<path> 直传。同名覆盖。',
    inputSchema: {
      path: z.string().min(1).max(300).describe('文件名或相对路径，如 data/cohort.csv（自动放在 aegis-files/ 下）'),
      data_base64: z.string().min(1).describe('文件内容的 base64'),
    },
  }, async ({ path, data_base64 }) => {
    if (!claims.p.includes('write')) return fail('forbidden', '当前授权是只读的，不能放文件')
    const bytes = Buffer.from(data_base64, 'base64')
    if (bytes.byteLength > MCP_PUT_MAX) return fail('too_large', `文件超过 ${MCP_PUT_MAX / 1024 / 1024}MB`, { hint: '改用 PUT /api/aegis/files/<path> 直传（同一授权令牌）。' })
    try {
      const t = writeTarget(workspace(), path)
      writeFileSync(t.abs, bytes)
      return json({ path: t.rel, bytes: bytes.byteLength })
    } catch (err) { return asFail(err) }
  })

  server.registerTool('workspace_get', {
    description: '取回 Heurion 工作区里的文件（如 doc_manage export 导出的 docx / pptx）。文本文件直接返回文字，其他返回 base64；超过 5MB 只返回下载地址（GET，同一授权令牌）。',
    inputSchema: { path: z.string().min(1).max(300).describe('相对工作区的路径') },
  }, async ({ path }) => {
    try {
      const t = readTarget(workspace(), path)
      if (t.dir) return fail('is_directory', `${t.rel} 是目录`, { hint: '用 workspace_list 列目录。' })
      if (t.size > MCP_GET_MAX) return json({ path: t.rel, bytes: t.size, download_url: filesUrl(t.rel) })
      const bytes = new Uint8Array(readFileSync(t.abs))
      return looksText(bytes)
        ? json({ path: t.rel, bytes: t.size, text: new TextDecoder().decode(bytes) })
        : json({ path: t.rel, bytes: t.size, data_base64: Buffer.from(bytes).toString('base64') })
    } catch (err) { return asFail(err) }
  })

  server.registerTool('workspace_list', {
    description: '列出 Heurion 工作区里的一个目录（默认根目录；你放进来的文件在 aegis-files/ 下）。',
    inputSchema: { path: z.string().max(300).optional().describe('相对工作区的目录，默认根目录') },
  }, async ({ path }) => {
    try {
      const t = readTarget(workspace(), path ?? '')
      if (!t.dir) return json({ path: t.rel, entries: [{ name: t.rel.split('/').pop(), dir: false, size: t.size }] })
      return json({ path: t.rel || '.', entries: listDir(t.abs) })
    } catch (err) {
      if (err instanceof WorkspaceFileError && err.code === 'file_not_found' && !path) return json({ path: '.', entries: [] })
      return asFail(err)
    }
  })
}
