import { PatientError } from './patients.ts'

/**
 * 发往影像 worker 的请求体收口。
 * worker 不认识用户：任何字符串都会先当体积缓存键（`pt_<患者>_<文件>`）查内存、再当文件路径去读，
 * 平台只校验个别字段就会被 file_path / mask_sample_id 之类绕过。所以转发前统一：
 * - 拒绝调用方给的任何路径字段（生产环境 worker 与平台不共享数据卷，合法影像一律经平台上传到 worker）；
 * - 任何位置出现的患者体积键都核对该患者的读权限；
 * - 其余 *_id 只允许安全字符（worker 会把样本 ID 拼进数据目录路径）。
 */
const PATH_KEY = /(^|_)paths?$/
const ID_KEY = /(^|_)id$/
const PT_VOLUME = /^pt_([^_]+)_[^_]/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function guardImagingPayload(
  body: unknown,
  readPatient: (patientId: string) => void,
  trustedPaths: ReadonlySet<string> = new Set(),
): void {
  const visit = (key: string, value: unknown, depth: number): void => {
    if (depth > 4) return
    if (Array.isArray(value)) { for (const v of value) visit(key, v, depth + 1); return }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(k, v, depth + 1)
      return
    }
    if (typeof value !== 'string' || value === '') return
    if (PATH_KEY.test(key)) {
      if (trustedPaths.has(value)) return
      throw new PatientError('invalid_input', `不接受调用方提供的服务器文件路径（${key}）：请改用患者影像记录或 sample_id`)
    }
    const m = PT_VOLUME.exec(value)
    if (m) { readPatient(m[1]!); return }
    if (ID_KEY.test(key) && (!SAFE_ID.test(value) || value.includes('..'))) {
      throw new PatientError('invalid_input', `${key} 含非法字符`)
    }
  }
  visit('', body, 0)
}
