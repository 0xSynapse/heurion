import { constants, gunzipSync } from 'node:zlib'

/**
 * 旧版影像分析接口（POST /api/patients/:ptid/imaging/analyze）收到的文件是不是 NIfTI。
 *
 * 去标识化（docs/design/IMAGING_STUDIES.md「去标识化」）只覆盖 DICOM 上传；旧接口把文件原样交给 worker，
 * 不做去标识。所以没开「接收原件」（IMAGING_ACCEPT_IDENTIFIED）时，旧接口只收 NIfTI：NIfTI 头里没有
 * 患者姓名、ID 一类的标准字段。按文件内容判断（不看扩展名）：
 * - NIfTI-1：头长 sizeof_hdr = 348，偏移 344 处 magic 为 "n+1\0" 或 "ni1\0"；
 * - NIfTI-2：sizeof_hdr = 540，偏移 4 处 magic 为 "n+2\0" 或 "ni2\0"；
 * - 两种都可以是 gzip 压缩（.nii.gz）：只解开开头一段来看头。
 * DICOM、zip、tar 以及其他格式都返回 false。
 */
export function isNifti(buf: Uint8Array): boolean {
  let head = buf
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      head = gunzipSync(buf.subarray(0, Math.min(buf.length, 64 * 1024)), { finishFlush: constants.Z_SYNC_FLUSH })
    } catch { return false }
  }
  if (head.length < 348) return false
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const magic = (off: number) => String.fromCharCode(head[off]!, head[off + 1]!, head[off + 2]!) + (head[off + 3] === 0 ? '\0' : '?')
  for (const le of [true, false]) {
    const size = dv.getInt32(0, le)
    if (size === 348 && ['n+1\0', 'ni1\0'].includes(magic(344))) return true
    if (size === 540 && head.length >= 540 && ['n+2\0', 'ni2\0'].includes(magic(4))) return true
  }
  return false
}
