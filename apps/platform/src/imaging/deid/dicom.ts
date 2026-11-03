/**
 * 最小的 DICOM Part 10 解析 / 重写器（去标识化用；浏览器与服务端共用，不依赖 node 专有 API）。
 *
 * 支持：Explicit VR Little Endian、Implicit VR Little Endian，以及基于 Explicit VR LE 的封装压缩传输语法
 * （JPEG / JPEG-LS / JPEG 2000 / HTJ2K / RLE 等：像素片段原样拷贝，不解码）。未定长度的序列与条目、
 * 显式 VR 文件里以 UN 编码的未定长度序列（CP-246，内容按隐式 VR 解析）都能正确处理。
 * 拒绝：Deflated（整个数据集被压缩，1.2.840.10008.1.2.1.99）和 Big Endian（1.2.840.10008.1.2.2）。
 *
 * 只做去标识需要的事：元素树（序列递归）、取 / 改字符串值、写回合法的 Part 10（file meta 的 group length 重算）。
 */

export const TS_IMPLICIT_LE = '1.2.840.10008.1.2'
export const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1'
export const TS_DEFLATED = '1.2.840.10008.1.2.1.99'
export const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2'

export class DicomParseError extends Error {}

export interface DicomElement {
  /** (group << 16 | element)，无符号 */
  tag: number
  vr: string
  /** 普通元素的值（指向原缓冲区的视图，不拷贝） */
  value?: Uint8Array
  /** 序列的条目，每个条目是一组元素 */
  items?: DicomElement[][]
  /** 封装像素数据：头之后到序列结束符（含）的原始字节，原样写回 */
  encapsulated?: Uint8Array
}

export interface DicomFile {
  meta: DicomElement[]
  dataset: DicomElement[]
  transferSyntax: string
  /** 数据集是否显式 VR */
  explicit: boolean
}

/** 4 字节长度的显式 VR（其余为 2 字节长度） */
const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV'])
const UNDEFINED = 0xffffffff
const ITEM = 0xfffee000
const ITEM_END = 0xfffee00d
const SEQ_END = 0xfffee0dd
export const PIXEL_DATA = 0x7fe00010

export const tagHex = (tag: number) => `(${(tag >>> 16).toString(16).padStart(4, '0').toUpperCase()},${(tag & 0xffff).toString(16).padStart(4, '0').toUpperCase()})`

/** DICOM Part 10 文件在 128 字节前导后有 'DICM' 标记 */
export function isDicomPart10(bytes: Uint8Array): boolean {
  return bytes.byteLength > 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d
}

/** 不支持的传输语法给出原因；支持的返回 null */
export function unsupportedTransferSyntax(ts: string): string | null {
  if (ts === TS_DEFLATED) return '传输语法为 Deflated Explicit VR Little Endian（整个数据集被压缩），本机去标识不支持；请在 PACS / 光盘导出时选择非压缩或 JPEG 等传输语法'
  if (ts === TS_EXPLICIT_BE) return '传输语法为 Explicit VR Big Endian（DICOM 已退役），本机去标识不支持；请重新导出为 Little Endian'
  if (!ts.startsWith('1.2.840.10008.1.2')) return `不认识的传输语法 ${ts}，本机去标识不支持`
  return null
}

/** 解析时按标签查 VR（隐式 VR 文件靠它认出序列与 UID）；不认识返回 undefined */
export type VrLookup = (tag: number) => string | undefined

class Reader {
  private readonly dv: DataView
  constructor(readonly bytes: Uint8Array, private readonly vrOf: VrLookup) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  private need(pos: number, n: number) {
    if (pos + n > this.bytes.byteLength) throw new DicomParseError(`文件在第 ${pos} 字节处被截断`)
  }
  u16(pos: number) { this.need(pos, 2); return this.dv.getUint16(pos, true) }
  u32(pos: number) { this.need(pos, 4); return this.dv.getUint32(pos, true) }
  tag(pos: number) { return ((this.u16(pos) << 16) | this.u16(pos + 2)) >>> 0 }

  /** 解析 [pos, end) 内的元素（end = null 时读到条目结束符或文件尾）。返回元素与结束位置。 */
  elements(pos: number, end: number | null, explicit: boolean, stopAtGroup?: number): { list: DicomElement[]; pos: number } {
    const list: DicomElement[] = []
    const limit = end ?? this.bytes.byteLength
    while (pos < limit) {
      if (pos + 8 > this.bytes.byteLength) {
        // 末尾不足一个元素头的填充字节：只在顶层容忍
        if (end === null && stopAtGroup === undefined) break
        throw new DicomParseError(`文件在第 ${pos} 字节处被截断`)
      }
      const tag = this.tag(pos)
      if (stopAtGroup !== undefined && tag >>> 16 !== stopAtGroup) break
      if (tag === ITEM_END) { return { list, pos: pos + 8 } }
      if (tag === ITEM || tag === SEQ_END) throw new DicomParseError(`第 ${pos} 字节处出现了不该出现的条目分隔符`)
      const r = this.element(pos, explicit)
      list.push(r.el)
      pos = r.pos
    }
    if (end !== null && pos !== end) throw new DicomParseError('条目长度与内容不符')
    return { list, pos }
  }

  private element(pos: number, explicit: boolean): { el: DicomElement; pos: number } {
    const tag = this.tag(pos)
    let vr: string, len: number, hdr: number
    if (explicit) {
      this.need(pos, 8)
      const a = this.bytes[pos + 4]!, b = this.bytes[pos + 5]!
      if (a < 0x41 || a > 0x5a || b < 0x41 || b > 0x5a) throw new DicomParseError(`${tagHex(tag)} 的 VR 不合法（文件可能不是声明的显式 VR）`)
      vr = String.fromCharCode(a, b)
      if (LONG_VR.has(vr)) { len = this.u32(pos + 8); hdr = 12 } else { len = this.u16(pos + 6); hdr = 8 }
    } else {
      vr = this.vrOf(tag) ?? 'UN'
      len = this.u32(pos + 4); hdr = 8
    }
    const start = pos + hdr
    // 封装像素数据：未定长度的 OB / OW 像素
    if (tag === PIXEL_DATA && len === UNDEFINED) {
      const end = this.encapsulatedEnd(start)
      return { el: { tag, vr: explicit ? vr : 'OB', encapsulated: this.bytes.subarray(start, end) }, pos: end }
    }
    // 显式 VR 文件里以 UN 编码的元素：认识的标签按登记的 VR 解读（UN 的值就是隐式 VR LE 的值）
    let innerExplicit = explicit
    if (vr === 'UN') {
      const known = this.vrOf(tag)
      if (len === UNDEFINED || known === 'SQ') { vr = 'SQ'; innerExplicit = false }
      else if (known) vr = known
    }
    if (vr === 'SQ' || len === UNDEFINED) {
      if (len === UNDEFINED && vr !== 'SQ') { vr = 'SQ'; innerExplicit = false }
      const r = this.sequence(start, len === UNDEFINED ? null : start + len, innerExplicit)
      return { el: { tag, vr: 'SQ', items: r.items }, pos: r.pos }
    }
    this.need(start, len)
    return { el: { tag, vr, value: this.bytes.subarray(start, start + len) }, pos: start + len }
  }

  private sequence(pos: number, end: number | null, explicit: boolean): { items: DicomElement[][]; pos: number } {
    const items: DicomElement[][] = []
    for (;;) {
      if (end !== null && pos >= end) {
        if (pos !== end) throw new DicomParseError('序列长度与内容不符')
        return { items, pos }
      }
      const tag = this.tag(pos)
      const len = this.u32(pos + 4)
      if (tag === SEQ_END) {
        if (end !== null) throw new DicomParseError('定长序列里出现了序列结束符')
        return { items, pos: pos + 8 }
      }
      if (tag !== ITEM) throw new DicomParseError(`序列里应为条目，实际是 ${tagHex(tag)}`)
      if (len === UNDEFINED) {
        const r = this.elements(pos + 8, null, explicit)
        // elements(null) 读到条目结束符返回；读到文件尾说明缺结束符
        if (r.pos > this.bytes.byteLength || this.tag(r.pos - 8) !== ITEM_END) throw new DicomParseError('未定长度的条目缺少结束符')
        items.push(r.list); pos = r.pos
      } else {
        const r = this.elements(pos + 8, pos + 8 + len, explicit)
        items.push(r.list); pos = r.pos
      }
    }
  }

  /** 封装像素：条目（基本偏移表与片段）直到序列结束符，返回结束符之后的位置 */
  private encapsulatedEnd(pos: number): number {
    for (;;) {
      const tag = this.tag(pos)
      const len = this.u32(pos + 4)
      if (tag === SEQ_END) return pos + 8
      if (tag !== ITEM || len === UNDEFINED) throw new DicomParseError('封装像素数据的片段结构不对')
      this.need(pos + 8, len)
      pos += 8 + len
    }
  }
}

const ascii = (b: Uint8Array) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s }

/** 字符串值（去掉末尾的空格与 \0 填充） */
export function str(el: DicomElement | undefined): string | null {
  if (!el?.value) return null
  return ascii(el.value).replace(/[\0 ]+$/, '').replace(/^ +/, '')
}

export const find = (list: DicomElement[], tag: number) => list.find(e => e.tag === tag)

/** 解析 Part 10 文件。不支持的传输语法、结构损坏都抛 DicomParseError（消息是给医生看的中文原因）。 */
export function parseDicom(bytes: Uint8Array, vrOf: VrLookup): DicomFile {
  if (!isDicomPart10(bytes)) throw new DicomParseError('不是 DICOM Part 10 文件（缺少 DICM 标记）')
  const r = new Reader(bytes, vrOf)
  const meta = r.elements(132, null, true, 0x0002)
  const ts = str(find(meta.list, 0x00020010))
  if (!ts) throw new DicomParseError('文件头缺少传输语法（TransferSyntaxUID）')
  const bad = unsupportedTransferSyntax(ts)
  if (bad) throw new DicomParseError(bad)
  let explicit = ts !== TS_IMPLICIT_LE
  let transferSyntax = ts
  // 有些设备声明显式 VR LE、实际写的是隐式 VR：非压缩时按实际情况读
  if (explicit && meta.pos + 6 <= bytes.byteLength) {
    const a = bytes[meta.pos + 4]!, b = bytes[meta.pos + 5]!
    if ((a < 0x41 || a > 0x5a || b < 0x41 || b > 0x5a) && ts === TS_EXPLICIT_LE) { explicit = false; transferSyntax = TS_IMPLICIT_LE }
  }
  const ds = r.elements(meta.pos, null, explicit)
  return { meta: meta.list, dataset: ds.list, transferSyntax, explicit }
}

// —— 写 ——

class Writer {
  private chunks: Uint8Array[] = []
  size = 0
  push(b: Uint8Array) { this.chunks.push(b); this.size += b.byteLength }
  header(tag: number, vr: string, len: number, explicit: boolean) {
    const long = !explicit || LONG_VR.has(vr)
    const h = new Uint8Array(explicit ? (long ? 12 : 8) : 8)
    const dv = new DataView(h.buffer)
    dv.setUint16(0, tag >>> 16, true); dv.setUint16(2, tag & 0xffff, true)
    if (!explicit) dv.setUint32(4, len, true)
    else {
      h[4] = vr.charCodeAt(0); h[5] = vr.charCodeAt(1)
      if (long) dv.setUint32(8, len, true)
      else {
        if (len > 0xffff) throw new DicomParseError(`${tagHex(tag)} 的值太长，不能用 ${vr} 写出`)
        dv.setUint16(6, len, true)
      }
    }
    this.push(h)
  }
  delimiter(tag: number) {
    const h = new Uint8Array(8); const dv = new DataView(h.buffer)
    dv.setUint16(0, tag >>> 16, true); dv.setUint16(2, tag & 0xffff, true)
    this.push(h)
  }
  /** 写一组元素（按标签升序，序列条目里也一样） */
  elements(list: DicomElement[], explicit: boolean) {
    for (const el of sortByTag(list)) {
      if (el.items) {
        // 序列与条目一律写成未定长度（合法，且不必回填长度）
        this.header(el.tag, 'SQ', UNDEFINED, explicit)
        for (const item of el.items) { this.header(ITEM, '', UNDEFINED, false); this.elements(item, explicit); this.delimiter(ITEM_END) }
        this.delimiter(SEQ_END)
      } else if (el.encapsulated) {
        this.header(el.tag, el.vr === 'OW' ? 'OW' : 'OB', UNDEFINED, explicit)
        this.push(el.encapsulated)
      } else {
        const v = el.value ?? new Uint8Array(0)
        const odd = v.byteLength % 2 === 1
        this.header(el.tag, el.vr, v.byteLength + (odd ? 1 : 0), explicit)
        this.push(v)
        if (odd) this.push(new Uint8Array([el.vr === 'UI' || el.vr === 'OB' || el.vr === 'UN' ? 0 : 0x20]))
      }
    }
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.size)
    let p = 0
    for (const c of this.chunks) { out.set(c, p); p += c.byteLength }
    return out
  }
}

/**
 * 写出 Part 10：128 字节全零前导（原前导可能夹带 TIFF 等数据，不保留）+ DICM + file meta（重算 group length）+ 数据集。
 * meta 里的 (0002,0000) 由这里生成；元素按标签排序。
 */
export function writeDicom(file: { meta: DicomElement[]; dataset: DicomElement[]; explicit: boolean }): Uint8Array {
  const metaBody = new Writer()
  metaBody.elements(file.meta.filter(e => e.tag !== 0x00020000), true)
  const out = new Writer()
  const pre = new Uint8Array(132); pre.set([0x44, 0x49, 0x43, 0x4d], 128)
  out.push(pre)
  const gl = new Uint8Array(4); new DataView(gl.buffer).setUint32(0, metaBody.size, true)
  out.elements([{ tag: 0x00020000, vr: 'UL', value: gl }], true)
  out.push(metaBody.concat())
  out.elements(file.dataset, file.explicit)
  return out.concat()
}

export const sortByTag = (list: DicomElement[]) => [...list].sort((a, b) => a.tag - b.tag)

const enc = new TextEncoder()
/** 字符串元素（ASCII 值；按 VR 补齐偶数长度在写出时处理） */
export const textElement = (tag: number, vr: string, value: string): DicomElement => ({ tag, vr, value: enc.encode(value) })
