import { Unzip, UnzipInflate, unzipSync } from 'fflate'
import { isDicomPart10 } from './dicom.ts'

/**
 * 把医生选的文件 / 文件夹（含 zip）逐个展开成待去标识的 DICOM（浏览器与 Node 共用：只用 Blob.stream / slice）。
 * zip 按流解开：一边读一边产出条目，不把整个压缩包或全部结果读进内存。
 */

export interface SourceFile { name: string; size: number; slice(start?: number, end?: number): Blob; stream(): ReadableStream<Uint8Array> }
export type SourceEntry = { name: string; bytes: Uint8Array } | { name: string; skipped: string }

/** 不入库的条目：隐藏文件、macOS 资源目录；DICOMDIR 记为跳过 */
function skipName(name: string): 'ignore' | 'dicomdir' | null {
  const base = name.split('/').pop() ?? name
  if (!base || base.startsWith('.') || name.includes('__MACOSX/')) return 'ignore'
  if (base.toUpperCase() === 'DICOMDIR') return 'dicomdir'
  return null
}

const DICOMDIR_REASON = 'DICOMDIR 目录文件不入库'
const NOT_DICOM = '不是 DICOM 文件'

async function head(f: SourceFile, n: number): Promise<Uint8Array> { return new Uint8Array(await f.slice(0, n).arrayBuffer()) }
const isZipHead = (b: Uint8Array) => b.byteLength >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

/**
 * 读 zip 的中央目录，估计条目数与解压后的总字节（显示进度、估算批数用）。ZIP64 或读不出时返回 null。
 */
export async function zipEstimate(f: SourceFile): Promise<{ files: number; bytes: number } | null> {
  const tailLen = Math.min(f.size, 22 + 0xffff)
  const tail = new Uint8Array(await f.slice(f.size - tailLen, f.size).arrayBuffer())
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) return null
  const total = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true)
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff || cdOff + cdSize > f.size) return null
  const cd = new Uint8Array(await f.slice(cdOff, cdOff + cdSize).arrayBuffer())
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
  let p = 0, files = 0, bytes = 0
  const dec = new TextDecoder()
  while (p + 46 <= cd.byteLength && cv.getUint32(p, true) === 0x02014b50) {
    const size = cv.getUint32(p + 24, true), nl = cv.getUint16(p + 28, true), xl = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true)
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nl))
    if (!name.endsWith('/') && skipName(name) !== 'ignore') { files++; bytes += size }
    p += 46 + nl + xl + cl
  }
  return { files, bytes }
}

/** 估计一组输入共有多少个文件、多少字节（zip 读中央目录；读不出时按 1 个文件、压缩包大小计） */
export async function estimateSources(files: SourceFile[]): Promise<{ files: number; bytes: number }> {
  let n = 0, bytes = 0
  for (const f of files) {
    if (skipName(f.name) === 'ignore') continue
    if (isZipHead(await head(f, 4))) {
      const e = await zipEstimate(f).catch(() => null)
      n += e?.files ?? 1; bytes += e?.bytes ?? f.size
    } else { n++; bytes += f.size }
  }
  return { files: n, bytes }
}

/** 逐个产出 DICOM 文件（或跳过的原因）。zip 里的条目名为 `<压缩包名>/<条目路径>`。 */
export async function* iterateSources(files: SourceFile[]): AsyncGenerator<SourceEntry> {
  for (const f of files) {
    const kind = skipName(f.name)
    if (kind === 'ignore') continue
    if (kind === 'dicomdir') { yield { name: f.name, skipped: DICOMDIR_REASON }; continue }
    if (isZipHead(await head(f, 4))) { yield* iterateZip(f); continue }
    const bytes = new Uint8Array(await f.slice().arrayBuffer())
    yield isDicomPart10(bytes) ? { name: f.name, bytes } : { name: f.name, skipped: NOT_DICOM }
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let p = 0
  for (const c of chunks) { out.set(c, p); p += c.byteLength }
  return out
}

/** 流式解开一个 zip；流式解不了（如不压缩又带数据描述符的条目）且不太大时，退回整包解开，跳过已产出的条目 */
async function* iterateZip(f: SourceFile): AsyncGenerator<SourceEntry> {
  const seen = new Set<string>()
  const ready: SourceEntry[] = []
  const take = (name: string, bytes: Uint8Array) => {
    seen.add(name)
    ready.push(isDicomPart10(bytes) ? { name: `${f.name}/${name}`, bytes } : { name: `${f.name}/${name}`, skipped: NOT_DICOM })
  }
  let failed: unknown = null
  const unz = new Unzip(file => {
    if (file.name.endsWith('/')) return
    const kind = skipName(file.name)
    if (kind === 'ignore') return
    if (kind === 'dicomdir') { seen.add(file.name); ready.push({ name: `${f.name}/${file.name}`, skipped: DICOMDIR_REASON }); return }
    if (file.compression !== 0 && file.compression !== 8) { seen.add(file.name); ready.push({ name: `${f.name}/${file.name}`, skipped: `压缩方式（${file.compression}）不支持` }); return }
    const chunks: Uint8Array[] = []
    file.ondata = (err, chunk, final) => {
      if (err) { failed ??= err; return }
      if (chunk.byteLength) chunks.push(chunk)
      if (final) take(file.name, concat(chunks))
    }
    file.start()
  })
  unz.register(UnzipInflate)
  const reader = f.stream().getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      try { unz.push(value ?? new Uint8Array(0), done) } catch (err) { failed ??= err }
      while (ready.length) yield ready.shift()!
      if (failed || done) break
    }
  } finally { reader.releaseLock?.() }
  if (!failed) return
  if (f.size > 1024 * 1024 * 1024) { yield { name: f.name, skipped: '压缩包无法流式解开，且超过 1 GB；请解压后选择文件夹上传' }; return }
  let entries: Record<string, Uint8Array>
  try { entries = unzipSync(new Uint8Array(await f.slice().arrayBuffer())) } catch { yield { name: f.name, skipped: '压缩包无法解开' }; return }
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('/') || seen.has(name)) continue
    const kind = skipName(name)
    if (kind === 'ignore') continue
    if (kind === 'dicomdir') { yield { name: `${f.name}/${name}`, skipped: DICOMDIR_REASON }; continue }
    yield isDicomPart10(bytes) ? { name: `${f.name}/${name}`, bytes } : { name: `${f.name}/${name}`, skipped: NOT_DICOM }
  }
}
