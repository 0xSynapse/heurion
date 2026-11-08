/**
 * 影像微服务（imaging-worker）错误的对外出口。
 *
 * worker 只在内网、只被平台调用，它返回的 detail 保持原样（引擎写的可读原因，便于平台日志排查）。
 * 平台把它转给用户、AI 或写进对用户可见的记录之前，一律经这里清理：
 * - 4xx / 501：原因如实转出（AI 和用户要靠它改参数、拉权重），只把服务器绝对路径换成文件名；
 * - 其余 5xx：原因可能带内部异常文本，对外只给通用说明，完整原因写进平台日志。
 * 状态码 → 说明的映射也只在这里定义，HTTP 路由、MCP 工具与 callWorker 共用。
 */

// 路径段：除空白、斜杠与常见中英文标点外的任意字符（含中文目录名）
const SEG = String.raw`[^\s/\\:"'<>()（）\[\]{}，,；;。、！？!?】」』]+`
// 至少两级的绝对路径（/srv/data/x.nii.gz）；前面不能紧跟 ASCII 字母数字、斜杠或点，避免误伤 URL 与相对片段（Bq/ml）
const ABS_PATH = new RegExp(String.raw`(?<![A-Za-z0-9_/.])(?:/${SEG}){2,}/?`, 'g')

/** 把文本里的服务器绝对路径替换为文件名 */
export function scrubPaths(text: string): string {
  return text.replace(ABS_PATH, m => {
    const parts = m.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? ''
  })
}

/** 读出 worker 错误响应里的 detail（FastAPI 的 {detail}，或非 JSON 的原文） */
export async function readWorkerDetail(resp: Response): Promise<string> {
  try {
    const text = await resp.text()
    try {
      const j = JSON.parse(text)
      if (typeof j.detail === 'string') return j.detail
      if (j.detail) return JSON.stringify(j.detail)
      return String(j.message ?? j.error ?? text)
    } catch {
      return text
    }
  } catch {
    return ''
  }
}

/** worker 原因是否可以对外转出（状态码也原样转给调用方）：参数 / 影像不存在 / 模型不可用 */
export function isPassThroughStatus(status: number): boolean {
  return (status >= 400 && status < 500) || status === 501
}

/** worker 状态码对应的中文说明 */
export function workerErrorKind(status: number): string {
  if (status === 501) return '模型不可用'
  if (status === 404) return '影像或样本不存在'
  if (isPassThroughStatus(status)) return '请求参数有误'
  return '影像微服务出错'
}

/**
 * 给用户或 AI 看的原因。不可转出的状态只返回通用说明，原文记日志。
 * @param where 日志里标明是哪条调用链，便于和请求对上
 */
export function publicWorkerDetail(status: number, detail: string, max: number, where: string): string {
  if (isPassThroughStatus(status)) return scrubPaths(detail).slice(0, max)
  console.error(`[imaging] ${where}：影像微服务 HTTP ${status}：${detail.slice(0, 2000)}`)
  return '服务内部错误，详见平台日志'
}
