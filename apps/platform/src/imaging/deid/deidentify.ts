import { DicomParseError, find, parseDicom, str, tagHex, textElement, writeDicom, type DicomElement, type DicomFile } from './dicom.ts'
import { CLASS_UID_TAGS, WHITELIST } from './whitelist.ts'

/**
 * DICOM 去标识化（docs/design/IMAGING_STUDIES.md「去标识化」）：浏览器在上传前对每个文件执行；服务端用 verifyDeidentified 核验。
 *
 * - 白名单（whitelist.ts）之外的标签一律删除，含全部私有标签与 60xx 叠加层；
 * - 所有非「类」UID（递归含序列里的 Referenced*UID）映射为 2.25.<HMAC-SHA256(机构 UID 假名化密钥, 原 UID) 前 16 字节的十进制>：
 *   同一机构同一原 UID 结果确定，去重、冲突检测、随访与 SEG 引用照常可用；没有密钥无法从假名反推原 UID；
 * - PatientName / PatientID 写成服务端给的患者假名；写入 PatientIdentityRemoved = YES 与本方案的 DeidentificationMethod；
 * - 有烧录文字风险的影像（BurnedInAnnotation = YES、Secondary Capture、超声、截屏等）不处理、不上传，给出原因。
 */

/** 方案版本：改动白名单或规则时递增，服务端按它核验 */
export const DEID_SCHEME = 'HEURION-DEID-1'
/** 写入 DeidentificationMethod (0012,0063) 的固定串（LO，≤ 64 字符） */
export const DEID_METHOD = `${DEID_SCHEME} PS3.15 BASIC+FULL-DATES+PATIENT-CHARS`
/** 本方案写出的 file meta 里的 ImplementationClassUID（固定值，标识「由本方案重写」） */
export const DEID_IMPLEMENTATION_CLASS_UID = '2.25.147690575267048597001706454953125432337'
export const DEID_IMPLEMENTATION_VERSION = 'HEURION_DEID_1'

const T = {
  SOPClassUID: 0x00080016, SOPInstanceUID: 0x00080018, StudyInstanceUID: 0x0020000d, SeriesInstanceUID: 0x0020000e,
  Modality: 0x00080060, ImageType: 0x00080008, BurnedInAnnotation: 0x00280301, SpecificCharacterSet: 0x00080005,
  PatientName: 0x00100010, PatientID: 0x00100020, AccessionNumber: 0x00080050,
  PatientIdentityRemoved: 0x00120062, DeidentificationMethod: 0x00120063, DeidentificationMethodCodeSequence: 0x00120064,
  LongitudinalTemporalInformationModified: 0x00280303,
  MediaStorageSOPClassUID: 0x00020002, MediaStorageSOPInstanceUID: 0x00020003, TransferSyntaxUID: 0x00020010,
  ImplementationClassUID: 0x00020012, ImplementationVersionName: 0x00020013, FileMetaInformationVersion: 0x00020001,
}

/** 隐式 VR 文件按白名单登记的 VR 解析（白名单外的标签不必认识：删掉即可） */
export const vrOf = (tag: number) => WHITELIST.get(tag)?.vr

/** 「类」UID：标准根 1.2.840.10008 下的（SOP 类、传输语法、编码体系等），或登记为保存类 UID 的标签（含厂商私有 SOP 类） */
export function isClassUid(tag: number, uid: string): boolean {
  return CLASS_UID_TAGS.has(tag) || uid.startsWith('1.2.840.10008.')
}
const PSEUDO_UID = /^2\.25\.(0|[1-9]\d{0,38})$/

/** 患者假名的格式：大写字母与数字（服务端生成，不含真实信息） */
export const PSEUDONYM = /^[A-Z0-9]{6,32}$/

const MODALITY_RISK: Record<string, string> = {
  SC: '二次采集（Secondary Capture）影像常有烧录的患者信息',
  OT: '模态为 OT（其他），常是截图或文档，可能有烧录文字',
  US: '超声影像通常在画面里烧录患者信息',
  IVUS: '血管内超声影像通常在画面里烧录患者信息',
  XC: '外部相机照片可能拍到患者面部或文字',
  ES: '内镜影像通常在画面里烧录患者信息',
  GM: '大体照片可能有标签文字',
  OP: '眼科照片可能有烧录文字',
  DOC: '扫描文档含患者信息',
  SR: '结构化报告含自由文本，不在影像去标识范围内',
  KO: '关键图像标注（KO）不在影像去标识范围内',
  PR: '显示状态（PR）可能含文字标注',
}
const SOP_RISK: Array<[string, string]> = [
  ['1.2.840.10008.1.3.10', 'DICOMDIR 目录文件不入库'],
  ['1.2.840.10008.5.1.4.1.1.7', '二次采集（Secondary Capture）影像常有烧录的患者信息'],
  ['1.2.840.10008.5.1.4.1.1.88.', '结构化报告含自由文本，不在影像去标识范围内'],
  ['1.2.840.10008.5.1.4.1.1.11.', '显示状态（PR）可能含文字标注'],
  ['1.2.840.10008.5.1.4.1.1.104.', '封装文档（PDF / CDA）含患者信息'],
  ['1.2.840.10008.5.1.4.1.1.77.', '可见光照片 / 视频可能有烧录文字或面部'],
  ['1.2.840.10008.5.1.4.1.1.481.', '放疗对象（RT）含自由文本，不在本方案范围内'],
]
const IMAGE_TYPE_RISK = ['SCREEN SAVE', 'SCREENSHOT', 'DOSE INFO', 'DOSE_INFO', 'DOSE REPORT']

/** 烧录文字风险：只能按标签判断（不识别像素里的文字）。有风险返回中文原因。 */
export function burnedInRisk(file: Pick<DicomFile, 'meta' | 'dataset'>): string | null {
  const ds = file.dataset
  if ((str(find(ds, T.BurnedInAnnotation)) ?? '').toUpperCase() === 'YES') return '标记为有烧录文字（BurnedInAnnotation = YES），画面里可能有患者信息'
  const sop = str(find(ds, T.SOPClassUID)) ?? str(find(file.meta, T.MediaStorageSOPClassUID)) ?? ''
  for (const [prefix, why] of SOP_RISK) if (sop === prefix || (prefix.endsWith('.') ? sop.startsWith(prefix) : sop.startsWith(`${prefix}.`))) return why
  const modality = (str(find(ds, T.Modality)) ?? '').toUpperCase()
  if (MODALITY_RISK[modality]) return MODALITY_RISK[modality]!
  const imageType = (str(find(ds, T.ImageType)) ?? '').toUpperCase().split('\\').map(s => s.trim())
  const hit = IMAGE_TYPE_RISK.find(t => imageType.includes(t))
  if (hit) return `图像类型含 ${hit}（截屏 / 剂量报告），画面里可能有患者信息`
  return null
}

/** 按 SpecificCharacterSet 解码文字（检查号等；中文常见 GB18030 / UTF-8） */
function decodeText(v: Uint8Array | undefined, charset: string | null): string | null {
  if (!v) return null
  const cs = (charset ?? '').toUpperCase().split('\\').map(s => s.trim())
  const label = cs.includes('ISO_IR 192') ? 'utf-8' : cs.some(c => c === 'GB18030' || c === 'GBK') ? 'gb18030' : 'latin1'
  let s: string
  try { s = new TextDecoder(label).decode(v) } catch { s = new TextDecoder('latin1').decode(v) }
  return s.replace(/[\0 ]+$/, '').trim() || null
}

const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array | undefined) => {
  if (!a || !b || a.byteLength !== b.byteLength) return a === b
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

export interface DeidParams {
  /** 机构的 UID 假名化密钥（32 字节） */
  key: Uint8Array
  /** 该患者的假名（写入 PatientName / PatientID） */
  pseudonym: string
}

export type DeidResult =
  | {
      ok: true
      bytes: Uint8Array
      /** 假名化后的 UID（上传时随表单附带检查号用） */
      studyUid: string
      seriesUid: string
      sopUid: string
      /** 原文件里的少量信息：只留在浏览器或单独加密上传，不进 Orthanc */
      original: {
        accession: string | null
        /** 原 PatientID 与 PatientName 的组合（只在浏览器里比较「这批是不是同一位患者」，不上传） */
        patientKey: string
      }
    }
  | { ok: false; reason: string }

export interface Deidentifier {
  deidentify(bytes: Uint8Array): Promise<DeidResult>
  /** 单个 UID 的假名（类 UID 请勿传入） */
  mapUid(uid: string): Promise<string>
}

/** 建一个去标识器（一次上传用一个：UID 映射有缓存）。用 globalThis.crypto.subtle，浏览器与 Node 都有。 */
export async function createDeidentifier(params: DeidParams): Promise<Deidentifier> {
  if (params.key.byteLength < 16) throw new Error('去标识密钥长度不对')
  if (!PSEUDONYM.test(params.pseudonym)) throw new Error('患者假名格式不对')
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('当前浏览器不支持 Web Crypto（需要 HTTPS 页面），不能在本机去标识')
  const key = await subtle.importKey('raw', new Uint8Array(params.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const cache = new Map<string, Promise<string>>()
  const enc = new TextEncoder()
  const mapUid = (uid: string): Promise<string> => {
    let hit = cache.get(uid)
    if (!hit) {
      hit = subtle.sign('HMAC', key, enc.encode(uid)).then(sig => {
        let n = 0n
        for (const b of new Uint8Array(sig).subarray(0, 16)) n = (n << 8n) | BigInt(b)
        return `2.25.${n.toString(10)}`
      })
      cache.set(uid, hit)
    }
    return hit
  }

  const mapUiValue = async (tag: number, v: Uint8Array): Promise<Uint8Array> => {
    const parts = new TextDecoder('latin1').decode(v).replace(/[\0 ]+$/, '').split('\\')
    const out: string[] = []
    for (const raw of parts) {
      const uid = raw.replace(/\0/g, '').trim()
      out.push(!uid || isClassUid(tag, uid) ? uid : await mapUid(uid))
    }
    return enc.encode(out.join('\\'))
  }

  /** 按白名单递归过滤；UI 值假名化 */
  const filter = async (list: DicomElement[]): Promise<DicomElement[]> => {
    const out: DicomElement[] = []
    for (const el of list) {
      if ((el.tag >>> 16) & 1) continue
      const w = WHITELIST.get(el.tag)
      if (!w || w.kind !== 'keep') continue
      if (el.items) {
        if (w.vr !== 'SQ') continue
        const items: DicomElement[][] = []
        // 条目一个不删（PerFrameFunctionalGroupsSequence 的条目数须等于帧数）
        for (const item of el.items) items.push(await filter(item))
        out.push({ tag: el.tag, vr: 'SQ', items })
        continue
      }
      if (w.vr === 'SQ') continue
      if (el.vr === 'UI' && el.value) { out.push({ tag: el.tag, vr: 'UI', value: await mapUiValue(el.tag, el.value) }); continue }
      out.push(el)
    }
    return out
  }

  return {
    mapUid,
    async deidentify(bytes) {
      let file: DicomFile
      try { file = parseDicom(bytes, vrOf) } catch (err) {
        return { ok: false, reason: err instanceof DicomParseError ? err.message : `文件无法解析：${err instanceof Error ? err.message : String(err)}` }
      }
      const risk = burnedInRisk(file)
      if (risk) return { ok: false, reason: risk }
      const ds = file.dataset
      const sopClass = str(find(ds, T.SOPClassUID)) ?? str(find(file.meta, T.MediaStorageSOPClassUID))
      const study = str(find(ds, T.StudyInstanceUID)), series = str(find(ds, T.SeriesInstanceUID)), sop = str(find(ds, T.SOPInstanceUID))
      if (!sopClass || !study || !series || !sop) return { ok: false, reason: '缺少 SOPClassUID / StudyInstanceUID / SeriesInstanceUID / SOPInstanceUID，不是完整的影像实例' }
      const charset = str(find(ds, T.SpecificCharacterSet))
      const pid = find(ds, T.PatientID)?.value, pname = find(ds, T.PatientName)?.value
      const original = {
        accession: decodeText(find(ds, T.AccessionNumber)?.value, charset)?.slice(0, 64) ?? null,
        patientKey: `${decodeText(pid, charset) ?? ''}\\${decodeText(pname, charset) ?? ''}`,
      }

      const kept = await filter(ds)
      const code = (value: string, meaning: string): DicomElement[] => [
        textElement(0x00080100, 'SH', value), textElement(0x00080102, 'SH', 'DCM'), textElement(0x00080104, 'LO', meaning),
      ]
      kept.push(
        textElement(T.PatientName, 'PN', params.pseudonym),
        textElement(T.PatientID, 'LO', params.pseudonym),
        textElement(T.PatientIdentityRemoved, 'CS', 'YES'),
        textElement(T.DeidentificationMethod, 'LO', DEID_METHOD),
        { tag: T.DeidentificationMethodCodeSequence, vr: 'SQ', items: [
          code('113100', 'Basic Application Confidentiality Profile'),
          code('113106', 'Retain Longitudinal Temporal Information Full Dates Option'),
          code('113108', 'Retain Patient Characteristics Option'),
        ] },
        textElement(T.LongitudinalTemporalInformationModified, 'CS', 'UNMODIFIED'),
      )
      const sopUid = await mapUid(sop)
      const meta: DicomElement[] = [
        { tag: T.FileMetaInformationVersion, vr: 'OB', value: new Uint8Array([0, 1]) },
        textElement(T.MediaStorageSOPClassUID, 'UI', sopClass),
        textElement(T.MediaStorageSOPInstanceUID, 'UI', sopUid),
        textElement(T.TransferSyntaxUID, 'UI', file.transferSyntax),
        textElement(T.ImplementationClassUID, 'UI', DEID_IMPLEMENTATION_CLASS_UID),
        textElement(T.ImplementationVersionName, 'SH', DEID_IMPLEMENTATION_VERSION),
      ]
      let out: Uint8Array
      try { out = writeDicom({ meta, dataset: kept, explicit: file.explicit }) } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
      return { ok: true, bytes: out, studyUid: await mapUid(study), seriesUid: await mapUid(series), sopUid, original }
    },
  }
}

const META_ALLOWED = new Set([0x00020000, T.FileMetaInformationVersion, T.MediaStorageSOPClassUID, T.MediaStorageSOPInstanceUID, T.TransferSyntaxUID, T.ImplementationClassUID, T.ImplementationVersionName])

/**
 * 服务端核验：文件确实经本方案去标识（DEID_SCHEME 版本）、且属于这位患者（PatientName / PatientID 等于其假名）。
 * 规则：有标记；file meta 只有本方案写的元素；数据集（递归）没有私有标签、没有白名单外的标签；
 * 所有非类 UID 都在 2.25 根下；没有烧录文字风险。不通过返回中文原因。
 */
export function verifyDeidentified(bytes: Uint8Array, expect: { pseudonym: string }): { ok: true } | { ok: false; reason: string } {
  let file: DicomFile
  try { file = parseDicom(bytes, vrOf) } catch (err) { return { ok: false, reason: err instanceof Error ? err.message : String(err) } }
  for (const el of file.meta) {
    if (!META_ALLOWED.has(el.tag)) return { ok: false, reason: `文件头含本方案不写的元素 ${tagHex(el.tag)}` }
  }
  if (str(find(file.meta, T.ImplementationClassUID)) !== DEID_IMPLEMENTATION_CLASS_UID) return { ok: false, reason: '文件不是由本平台的去标识程序写出的' }
  const ds = file.dataset
  if ((str(find(ds, T.PatientIdentityRemoved)) ?? '') !== 'YES') return { ok: false, reason: '缺少去标识标记（PatientIdentityRemoved）' }
  if (str(find(ds, T.DeidentificationMethod)) !== DEID_METHOD) return { ok: false, reason: '去标识方法不是本平台当前的方案版本' }
  const pseudo = new TextEncoder().encode(expect.pseudonym)
  const same = (tag: number) => { const v = find(ds, tag)?.value; return Boolean(v) && (bytesEqual(v, pseudo) || str(find(ds, tag)) === expect.pseudonym) }
  if (!same(T.PatientName) || !same(T.PatientID)) return { ok: false, reason: '患者姓名 / ID 不是这位患者的假名（可能传错了患者，或未经去标识）' }
  const bad = checkTree(ds, 0)
  if (bad) return { ok: false, reason: bad }
  const mediaSop = str(find(file.meta, T.MediaStorageSOPInstanceUID)) ?? ''
  if (!PSEUDO_UID.test(mediaSop)) return { ok: false, reason: '文件头的 SOPInstanceUID 未经假名化' }
  const risk = burnedInRisk(file)
  if (risk) return { ok: false, reason: risk }
  return { ok: true }
}

function checkTree(list: DicomElement[], depth: number): string | null {
  for (const el of list) {
    if ((el.tag >>> 16) & 1) return `含私有标签 ${tagHex(el.tag)}`
    const w = WHITELIST.get(el.tag)
    if (!w) return `含白名单外的标签 ${tagHex(el.tag)}`
    if (depth > 0 && w.kind !== 'keep') return `序列里含不该有的 ${w.keyword}`
    if (el.items) {
      for (const item of el.items) { const r = checkTree(item, depth + 1); if (r) return r }
      continue
    }
    if (el.vr === 'UI' && el.value) {
      for (const raw of new TextDecoder('latin1').decode(el.value).replace(/[\0 ]+$/, '').split('\\')) {
        const uid = raw.trim()
        if (uid && !isClassUid(el.tag, uid) && !PSEUDO_UID.test(uid)) return `${w.keyword} 含未假名化的 UID`
      }
    }
  }
  return null
}
