import { Unzip, UnzipInflate } from 'fflate'

export class PptxImportError extends Error {}

const MAX_PPTX_COMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_ZIP_BYTES = 150 * 1024 * 1024
const MAX_ZIP_ENTRIES = 2500

export function safeUnzipPptx(bytes: Uint8Array, filter?: (name: string) => boolean): Record<string, Uint8Array> {
  if (bytes.byteLength > MAX_PPTX_COMPRESSED_BYTES) {
    throw new PptxImportError('PPTX_INVALID: zip 文件体积超限')
  }
  const out: Record<string, Uint8Array> = {}
  let entries = 0
  let declaredBytes = 0
  let actualBytes = 0
  const unzip = new Unzip(file => {
    const name = file.name
    if (!name || name.includes('\0') || name.startsWith('/') || name.startsWith('\\') || name.split(/[\\/]/).includes('..')) {
      throw new PptxImportError('PPTX_INVALID: zip 条目路径非法')
    }
    entries++
    if (entries > MAX_ZIP_ENTRIES) {
      throw new PptxImportError('PPTX_INVALID: zip 条目数超限')
    }
    if (name.endsWith('/')) return
    if (filter && !filter(name)) return
    declaredBytes += file.originalSize ?? 0
    if (declaredBytes > MAX_ZIP_BYTES) {
      throw new PptxImportError('PPTX_INVALID: zip 解压体积超限')
    }
    const chunks: Uint8Array[] = []
    let entryBytes = 0
    file.ondata = (err, data, final) => {
      if (err) throw new PptxImportError('不是有效的 pptx 文件（zip 解析失败）')
      actualBytes += data.byteLength
      if (actualBytes > MAX_ZIP_BYTES) {
        throw new PptxImportError('PPTX_INVALID: zip 解压体积超限 (疑似压缩炸弹)')
      }
      entryBytes += data.byteLength
      chunks.push(data)
      if (final) {
        if (chunks.length === 1) {
          out[name] = chunks[0]!
        } else {
          const buf = new Uint8Array(entryBytes)
          let off = 0
          for (const ch of chunks) {
            buf.set(ch, off)
            off += ch.byteLength
          }
          out[name] = buf
        }
      }
    }
    file.start()
  })
  unzip.register(UnzipInflate)
  unzip.push(bytes, true)
  return out
}
