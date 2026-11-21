import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

/**
 * 外部智能体的文件进出（docs/design/MCP_MODULES.md §3.4，阶段 3）。
 *
 * 外部智能体的文件在用户本机，服务器上的路径对它没有意义；平台接收文件的工具（数据集、资料库、
 * 文档导入、院徽、记忆导入……）都按用户工作区解析 path / file_path。所以只要给它一条把文件放进
 * 工作区、从工作区取回的通道，这些工具都不用逐个改：MCP 工具 workspace_put / workspace_get /
 * workspace_list（≤10MB），以及 HTTP `PUT / GET /api/aegis/files/<path>`（大文件）。
 *
 * 写入只落在工作区的 `aegis-files/` 下；读取限于工作区内（AI 的权限 = 用户本人，工作区本来就是用户的）。
 * 一律按真实路径判断，符号链接指到工作区外的拒绝。
 */

export const AEGIS_FILES_DIR = 'aegis-files'
/** 经 MCP（base64 放在 JSON 里）上传 / 取回的上限。 */
export const MCP_PUT_MAX = 10 * 1024 * 1024
export const MCP_GET_MAX = 5 * 1024 * 1024
/** 经 HTTP 直传的上限（生产 Caddy 对普通请求体限 110MB，见 deploy/Caddyfile）。 */
export const HTTP_PUT_MAX = 100 * 1024 * 1024

export class WorkspaceFileError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** 规范化相对路径：拒绝绝对路径、`..`、空段与控制字符。 */
function cleanRel(path: string): string {
  const p = path.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!p || /[\0-\x1f]/.test(p)) throw new WorkspaceFileError('invalid_path', '路径无效')
  const norm = normalize(p).split(sep).join('/')
  if (norm === '..' || norm.startsWith('../') || isAbsolute(norm)) throw new WorkspaceFileError('invalid_path', '路径不能跳出工作区')
  return norm
}

/**
 * 写入目标：`aegis-files/<path>`（path 已带 aegis-files/ 前缀时不重复加）。
 * 返回绝对路径与相对工作区的路径（交给其他工具的 path / file_path 用）。
 */
export function writeTarget(workspace: string, path: string): { abs: string; rel: string } {
  mkdirSync(workspace, { recursive: true })
  const root = realpathSync(workspace)
  let rel = cleanRel(path)
  if (rel !== AEGIS_FILES_DIR && !rel.startsWith(`${AEGIS_FILES_DIR}/`)) rel = `${AEGIS_FILES_DIR}/${rel}`
  if (rel === AEGIS_FILES_DIR) throw new WorkspaceFileError('invalid_path', '要给文件名')
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  // 父目录（可能是已有的符号链接）也必须在工作区里
  if (!inside(root, realpathSync(dirname(abs)))) throw new WorkspaceFileError('invalid_path', '路径不能跳出工作区')
  if (existsSync(abs) && (lstatSync(abs).isSymbolicLink() || lstatSync(abs).isDirectory())) throw new WorkspaceFileError('invalid_path', '目标已存在且不是普通文件')
  return { abs, rel }
}

/** 读取目标：工作区内已有的文件或目录（按真实路径判断）。 */
export function readTarget(workspace: string, path: string): { abs: string; rel: string; size: number; dir: boolean } {
  if (!existsSync(workspace)) throw new WorkspaceFileError('file_not_found', `找不到 ${path}`, 404)
  const root = realpathSync(workspace)
  const rel = path.trim() === '' || path.trim() === '.' ? '' : cleanRel(path)
  let abs: string
  try { abs = realpathSync(join(root, rel)) } catch { throw new WorkspaceFileError('file_not_found', `找不到 ${path}`, 404) }
  if (!inside(root, abs)) throw new WorkspaceFileError('invalid_path', '路径不能跳出工作区')
  const st = statSync(abs)
  return { abs, rel: relative(root, abs).split(sep).join('/'), size: st.size, dir: st.isDirectory() }
}

/** 列目录（一层）。 */
export function listDir(abs: string): Array<{ name: string; dir: boolean; size: number }> {
  return readdirSync(abs, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const dir = e.isDirectory()
      let size = 0
      try { if (!dir) size = statSync(join(abs, e.name)).size } catch { /* 读不到就记 0 */ }
      return { name: e.name, dir, size }
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    .slice(0, 500)
}

/** 粗判文本：没有 NUL、能按 UTF-8 解码。 */
export function looksText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false }
}
