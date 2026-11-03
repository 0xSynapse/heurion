import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { TenantService } from '../src/auth/tenants.ts'
import { issueToken } from '../src/auth/token.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { buildApi } from '../src/http/api.ts'
import {
  createDeidentifier, DEID_METHOD, estimateSources, iterateSources, parseDicom, verifyDeidentified, vrOf, WHITELIST, writeDicom,
  type DicomElement, type DicomFile,
} from '../src/imaging/deid/index.ts'
import { ImagingStudyService } from '../src/imaging/studies.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { kekFrom, TenantKeys } from '../src/tenancy/keys.ts'
import { PatientService, type Actor } from '../src/tenancy/patients.ts'
import { FakeOrthanc } from './imaging-fakes.ts'

// —— 用代码合成 DICOM（不依赖被测的写出器）——

interface El { tag: number; vr: string; v?: string | Uint8Array; items?: El[][]; undef?: boolean; frags?: Uint8Array[] }
const LONG = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV'])
const u16 = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b }
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b }
const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.byteLength } return o }
const tagBytes = (t: number) => cat(u16(t >>> 16), u16(t & 0xffff))
const valueBytes = (e: El) => {
  if (e.v instanceof Uint8Array) return e.v
  const b = new TextEncoder().encode(e.v ?? '')
  return b.byteLength % 2 ? cat(b, new Uint8Array([e.vr === 'UI' ? 0 : 0x20])) : b
}
function header(tag: number, vr: string, len: number, explicit: boolean): Uint8Array {
  if (!explicit) return cat(tagBytes(tag), u32(len))
  const v = new TextEncoder().encode(vr)
  return LONG.has(vr) ? cat(tagBytes(tag), v, new Uint8Array(2), u32(len)) : cat(tagBytes(tag), v, u16(len))
}
function encode(list: El[], explicit: boolean): Uint8Array {
  const out: Uint8Array[] = []
  for (const e of list) {
    if (e.items) {
      const items = e.items.map(it => {
        const body = encode(it, explicit && e.vr !== 'UN')
        return e.undef ? cat(tagBytes(0xfffee000), u32(0xffffffff), body, tagBytes(0xfffee00d), u32(0)) : cat(tagBytes(0xfffee000), u32(body.byteLength), body)
      })
      const body = cat(...items)
      out.push(e.undef ? cat(header(e.tag, e.vr, 0xffffffff, explicit), body, tagBytes(0xfffee0dd), u32(0)) : cat(header(e.tag, e.vr, body.byteLength, explicit), body))
    } else if (e.frags) {
      const fr = e.frags.map(f => cat(tagBytes(0xfffee000), u32(f.byteLength), f))
      out.push(cat(header(e.tag, 'OB', 0xffffffff, explicit), cat(tagBytes(0xfffee000), u32(0)), ...fr, tagBytes(0xfffee0dd), u32(0)))
    } else {
      const v = valueBytes(e)
      out.push(cat(header(e.tag, e.vr, v.byteLength, explicit), v))
    }
  }
  return cat(...out)
}
function part10(ts: string, dataset: El[], explicit = ts !== '1.2.840.10008.1.2'): Uint8Array<ArrayBuffer> {
  const metaBody = encode([
    { tag: 0x00020001, vr: 'OB', v: new Uint8Array([0, 1]) },
    { tag: 0x00020002, vr: 'UI', v: '1.2.840.10008.5.1.4.1.1.2' },
    { tag: 0x00020003, vr: 'UI', v: '1.2.392.200036.9116.2.6.1.48.1214833767.1.1' },
    { tag: 0x00020010, vr: 'UI', v: ts },
    { tag: 0x00020012, vr: 'UI', v: '1.2.276.0.7230010.3.0.3.6.4' },
    { tag: 0x00020016, vr: 'AE', v: 'CT_STATION_7' },
  ], true)
  const pre = new Uint8Array(132); pre.set([0x44, 0x49, 0x43, 0x4d], 128); pre.fill(0x41, 0, 16) // 前导里夹带字节
  return cat(pre, cat(header(0x00020000, 'UL', 4, true), u32(metaBody.byteLength)), metaBody, encode(dataset, explicit)) as Uint8Array<ArrayBuffer>
}

const STUDY = '1.2.392.200036.9116.2.6.1.48.1214833767.1'
const SERIES = '1.2.392.200036.9116.2.6.1.48.1214833767.1.2'
const SOP = '1.2.392.200036.9116.2.6.1.48.1214833767.1.2.7'
const FOR = '1.2.392.200036.9116.2.6.1.48.1214833767.9'
const REF_SOP = '1.2.392.200036.9116.2.6.1.48.1214833767.1.1.1'
const CT_CLASS = '1.2.840.10008.5.1.4.1.1.2'
const PIXELS = Uint8Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff)

/** 一张带各种可识别信息的胸部 CT（显式 / 隐式 VR 都用这一组元素） */
function ctElements(extra: El[] = [], undef = true): El[] {
  return [
    { tag: 0x00080005, vr: 'CS', v: 'ISO_IR 192' },
    { tag: 0x00080008, vr: 'CS', v: 'ORIGINAL\\PRIMARY\\AXIAL' },
    { tag: 0x00080016, vr: 'UI', v: CT_CLASS },
    { tag: 0x00080018, vr: 'UI', v: SOP },
    { tag: 0x00080020, vr: 'DA', v: '20260315' },
    { tag: 0x00080050, vr: 'SH', v: 'ACC-2026-0315' },
    { tag: 0x00080060, vr: 'CS', v: 'CT' },
    { tag: 0x00080080, vr: 'LO', v: '某某市第一人民医院' },
    { tag: 0x00080090, vr: 'PN', v: 'LI^SI' },
    { tag: 0x00081010, vr: 'SH', v: 'CT_STATION_7' },
    { tag: 0x00081030, vr: 'LO', v: '胸部 CT 平扫' },
    { tag: 0x00081070, vr: 'PN', v: 'OPERATOR^ZHAO' },
    { tag: 0x00081140, vr: 'SQ', undef, items: [[
      { tag: 0x00081150, vr: 'UI', v: CT_CLASS },
      { tag: 0x00081155, vr: 'UI', v: REF_SOP },
      { tag: 0x00091010, vr: 'LO', v: 'PRIVATE-IN-SEQ' },
    ]] },
    { tag: 0x00091001, vr: 'LO', v: 'GEMS_PRIVATE' },
    { tag: 0x00093001, vr: 'SQ', undef: true, items: [[{ tag: 0x00100010, vr: 'PN', v: 'HIDDEN^NAME' }]] },
    { tag: 0x00100010, vr: 'PN', v: 'ZHANG^SAN' },
    { tag: 0x00100020, vr: 'LO', v: 'MRN-123456' },
    { tag: 0x00100030, vr: 'DA', v: '19610402' },
    { tag: 0x00100040, vr: 'CS', v: 'F' },
    { tag: 0x00101000, vr: 'LO', v: 'OLD-ID-9' },
    { tag: 0x00101010, vr: 'AS', v: '064Y' },
    { tag: 0x00101040, vr: 'LO', v: '北京市朝阳区' },
    { tag: 0x00181000, vr: 'LO', v: 'SN-778899' },
    { tag: 0x00180050, vr: 'DS', v: '1.25' },
    { tag: 0x00181210, vr: 'SH', v: 'B70f' },
    { tag: 0x0020000d, vr: 'UI', v: STUDY },
    { tag: 0x0020000e, vr: 'UI', v: SERIES },
    { tag: 0x00200010, vr: 'SH', v: 'S12345' },
    { tag: 0x00200013, vr: 'IS', v: '7' },
    { tag: 0x00200032, vr: 'DS', v: '-150\\-150\\-30' },
    { tag: 0x00200037, vr: 'DS', v: '1\\0\\0\\0\\1\\0' },
    { tag: 0x00200052, vr: 'UI', v: FOR },
    { tag: 0x00280010, vr: 'US', v: u16(4) },
    { tag: 0x00280011, vr: 'US', v: u16(8) },
    { tag: 0x00280100, vr: 'US', v: u16(16) },
    { tag: 0x00281052, vr: 'DS', v: '-1024' },
    { tag: 0x00281053, vr: 'DS', v: '1' },
    { tag: 0x60003000, vr: 'OW', v: new Uint8Array(8) },
    ...extra,
    { tag: 0x7fe00010, vr: 'OW', v: PIXELS },
  ].sort((a, b) => a.tag - b.tag)
}

const KEY = new Uint8Array(32).fill(7)
const PSEUDO = 'HXA1B2C3D4E5F60718'

function tags(list: DicomElement[], out = new Set<number>()): Set<number> {
  for (const e of list) { out.add(e.tag); for (const it of e.items ?? []) tags(it, out) }
  return out
}
const get = (f: DicomFile, tag: number) => { const e = f.dataset.find(x => x.tag === tag); return e?.value ? new TextDecoder().decode(e.value).replace(/[\0 ]+$/, '') : undefined }
const ok = <T extends { ok: boolean }>(r: T) => { if (!r.ok) throw new Error(`应当成功：${JSON.stringify(r)}`); return r as Extract<T, { ok: true }> }

describe('DICOM 去标识：白名单与标记', () => {
  for (const [label, ts] of [['显式 VR', '1.2.840.10008.1.2.1'], ['隐式 VR', '1.2.840.10008.1.2']] as const) {
    it(`${label}：白名单外与私有标签、叠加层全部删除；像素原样；标记与假名写入；verify 通过`, async () => {
      const d = await createDeidentifier({ key: KEY, pseudonym: PSEUDO })
      const r = ok(await d.deidentify(part10(ts, ctElements())))
      const out = parseDicom(r.bytes, vrOf)
      expect(out.transferSyntax).toBe(ts)
      const all = tags(out.dataset)
      for (const t of all) expect(WHITELIST.has(t), `0x${t.toString(16)}`).toBe(true)
      for (const t of [0x00080050, 0x00080080, 0x00080090, 0x00081010, 0x00081070, 0x00100030, 0x00101000, 0x00101040, 0x00181000, 0x00200010, 0x60003000, 0x00091001, 0x00093001, 0x00091010]) {
        expect(all.has(t), `0x${t.toString(16)} 应删除`).toBe(false)
      }
      expect(get(out, 0x00100010)).toBe(PSEUDO)
      expect(get(out, 0x00100020)).toBe(PSEUDO)
      expect(get(out, 0x00120062)).toBe('YES')
      expect(get(out, 0x00120063)).toBe(DEID_METHOD)
      expect(get(out, 0x00280303)).toBe('UNMODIFIED')
      // 保留的：日期、性别年龄、描述（UTF-8 原字节）、层厚、重建核
      expect(get(out, 0x00080020)).toBe('20260315')
      expect(get(out, 0x00100040)).toBe('F')
      expect(get(out, 0x00101010)).toBe('064Y')
      expect(get(out, 0x00081030)).toBe('胸部 CT 平扫')
      expect(get(out, 0x00181210)).toBe('B70f')
      // 像素字节原样
      expect(out.dataset.find(e => e.tag === 0x7fe00010)!.value).toEqual(PIXELS)
      // 前导清零、file meta 只有本方案写的元素，group length 正确
      expect(r.bytes.subarray(0, 128).every(b => b === 0)).toBe(true)
      expect(out.meta.map(e => e.tag)).toEqual([0x00020000, 0x00020001, 0x00020002, 0x00020003, 0x00020010, 0x00020012, 0x00020013])
      const gl = new DataView(out.meta[0]!.value!.buffer, out.meta[0]!.value!.byteOffset).getUint32(0, true)
      const metaEnd = 132 + 12 + gl
      expect(new DataView(r.bytes.buffer, r.bytes.byteOffset).getUint16(metaEnd, true)).toBe(0x0008) // meta 之后紧接着是 (0008,xxxx)
      expect(r.original).toEqual({ accession: 'ACC-2026-0315', patientKey: 'MRN-123456\\ZHANG^SAN' })
      expect(verifyDeidentified(r.bytes, { pseudonym: PSEUDO })).toEqual({ ok: true })
    })
  }

  it('UID：确定、同机构一致、序列内引用同步；类 UID 不变；换密钥结果不同', async () => {
    const d1 = await createDeidentifier({ key: KEY, pseudonym: PSEUDO })
    const d2 = await createDeidentifier({ key: KEY, pseudonym: 'HXOTHER000000' })
    const d3 = await createDeidentifier({ key: new Uint8Array(32).fill(9), pseudonym: PSEUDO })
    const src = part10('1.2.840.10008.1.2.1', ctElements())
    const a = ok(await d1.deidentify(src)), b = ok(await d2.deidentify(src)), c = ok(await d3.deidentify(src))
    expect(a.studyUid).toMatch(/^2\.25\.[1-9]\d*$/)
    expect(a.studyUid.length).toBeLessThanOrEqual(64)
    expect([a.studyUid, a.seriesUid, a.sopUid]).toEqual([b.studyUid, b.seriesUid, b.sopUid])
    expect(c.studyUid).not.toBe(a.studyUid)
    const out = parseDicom(a.bytes, vrOf)
    expect(get(out, 0x0020000d)).toBe(a.studyUid)
    expect(get(out, 0x00200052)).toBe(await d1.mapUid(FOR))
    expect(get(out, 0x00080016)).toBe(CT_CLASS)
    const ref = out.dataset.find(e => e.tag === 0x00081140)!.items![0]!
    expect(new TextDecoder().decode(ref.find(e => e.tag === 0x00081150)!.value!).replace(/\0$/, '')).toBe(CT_CLASS)
    // 被引用实例的 UID 与那个实例自己去标识后的 SOPInstanceUID 相同
    const referenced = ok(await d1.deidentify(part10('1.2.840.10008.1.2.1', ctElements().map(e => e.tag === 0x00080018 ? { ...e, v: REF_SOP } : e))))
    expect(new TextDecoder().decode(ref.find(e => e.tag === 0x00081155)!.value!).replace(/\0$/, '')).toBe(referenced.sopUid)
    expect(ref.some(e => e.tag === 0x00091010)).toBe(false)
    // 文件头的 MediaStorageSOPInstanceUID 与数据集一致
    expect(new TextDecoder().decode(out.meta.find(e => e.tag === 0x00020003)!.value!).replace(/\0$/, '')).toBe(a.sopUid)
  })

  it('封装压缩像素（JPEG）：片段原样拷贝；Enhanced 多帧功能组按白名单逐层过滤、条目数不变；UN 编码的未定长度序列能解析', async () => {
    const frags = [Uint8Array.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]), Uint8Array.from([0xff, 0xd8, 9, 8, 0xff, 0xd9])]
    const frame = (z: string): El[] => [
      { tag: 0x00209111, vr: 'SQ', undef: true, items: [[{ tag: 0x00209157, vr: 'UL', v: u32(1) }]] },
      { tag: 0x00209113, vr: 'SQ', items: [[{ tag: 0x00200032, vr: 'DS', v: `0\\0\\${z}` }]] },
      { tag: 0x00211001, vr: 'LO', v: 'VENDOR' },
      { tag: 0x00189999, vr: 'LO', v: 'UNKNOWN-IN-FRAME' },
    ]
    const ds = ctElements([
      { tag: 0x00280008, vr: 'IS', v: '2' },
      { tag: 0x52009229, vr: 'SQ', undef: true, items: [[{ tag: 0x00289110, vr: 'SQ', undef: true, items: [[{ tag: 0x00280030, vr: 'DS', v: '0.7\\0.7' }, { tag: 0x00180050, vr: 'DS', v: '1' }]] }]] },
      { tag: 0x52009230, vr: 'SQ', undef: true, items: [frame('-10'), frame('-9')] },
      // CP-246：显式 VR 文件里以 UN 编码的未定长度序列（ReferencedSeriesSequence），内容是隐式 VR
      { tag: 0x00081115, vr: 'UN', undef: true, items: [[{ tag: 0x0020000e, vr: 'UI', v: SERIES }]] },
    ]).filter(e => e.tag !== 0x7fe00010)
    ds.push({ tag: 0x7fe00010, vr: 'OB', frags })
    const d = await createDeidentifier({ key: KEY, pseudonym: PSEUDO })
    const r = ok(await d.deidentify(part10('1.2.840.10008.1.2.4.50', ds)))
    const out = parseDicom(r.bytes, vrOf)
    expect(out.transferSyntax).toBe('1.2.840.10008.1.2.4.50')
    const px = out.dataset.find(e => e.tag === 0x7fe00010)!.encapsulated!
    // 基本偏移表（空）+ 两个片段 + 序列结束符，逐字节相同
    expect(px).toEqual(cat(tagBytes(0xfffee000), u32(0), ...frags.map(f => cat(tagBytes(0xfffee000), u32(f.byteLength), f)), tagBytes(0xfffee0dd), u32(0)))
    const perFrame = out.dataset.find(e => e.tag === 0x52009230)!.items!
    expect(perFrame).toHaveLength(2)
    expect(perFrame.map(it => it.map(e => e.tag))).toEqual([[0x00209111, 0x00209113], [0x00209111, 0x00209113]])
    const shared = out.dataset.find(e => e.tag === 0x52009229)!.items![0]![0]!.items![0]!
    expect(shared.map(e => e.tag)).toEqual([0x00180050, 0x00280030])
    const refSeries = out.dataset.find(e => e.tag === 0x00081115)!
    expect(refSeries.vr).toBe('SQ')
    expect(new TextDecoder().decode(refSeries.items![0]![0]!.value!).replace(/\0$/, '')).toBe(r.seriesUid)
    expect(verifyDeidentified(r.bytes, { pseudonym: PSEUDO })).toEqual({ ok: true })
  })

  it('Deflated 与 Big Endian 拒绝并说明原因；不是 Part 10 的文件拒绝', async () => {
    const d = await createDeidentifier({ key: KEY, pseudonym: PSEUDO })
    const deflated = await d.deidentify(part10('1.2.840.10008.1.2.1.99', ctElements()))
    expect(deflated).toMatchObject({ ok: false, reason: expect.stringContaining('Deflated') })
    const be = await d.deidentify(part10('1.2.840.10008.1.2.2', ctElements()))
    expect(be).toMatchObject({ ok: false, reason: expect.stringContaining('Big Endian') })
    expect(await d.deidentify(new Uint8Array(300))).toMatchObject({ ok: false, reason: expect.stringContaining('DICM') })
    // 截断的文件
    const full = part10('1.2.840.10008.1.2.1', ctElements())
    expect(await d.deidentify(full.subarray(0, full.byteLength - 20))).toMatchObject({ ok: false, reason: expect.stringContaining('截断') })
  })

  it('烧录文字风险跳过：BurnedInAnnotation=YES、Secondary Capture、超声、截屏', async () => {
    const d = await createDeidentifier({ key: KEY, pseudonym: PSEUDO })
    const variant = (patch: (e: El) => El, extra: El[] = []) => part10('1.2.840.10008.1.2.1', ctElements(extra).map(patch))
    const same = (e: El) => e
    expect(await d.deidentify(variant(same, [{ tag: 0x00280301, vr: 'CS', v: 'YES' }]))).toMatchObject({ ok: false, reason: expect.stringContaining('烧录') })
    expect(await d.deidentify(variant(e => e.tag === 0x00080016 ? { ...e, v: '1.2.840.10008.5.1.4.1.1.7' } : e))).toMatchObject({ ok: false, reason: expect.stringContaining('Secondary Capture') })
    expect(await d.deidentify(variant(e => e.tag === 0x00080060 ? { ...e, v: 'US' } : e))).toMatchObject({ ok: false, reason: expect.stringContaining('超声') })
    expect(await d.deidentify(variant(e => e.tag === 0x00080008 ? { ...e, v: 'DERIVED\\SECONDARY\\SCREEN SAVE' } : e))).toMatchObject({ ok: false, reason: expect.stringContaining('SCREEN SAVE') })
    // BurnedInAnnotation=NO 照常处理
    expect((await d.deidentify(variant(same, [{ tag: 0x00280301, vr: 'CS', v: 'NO' }]))).ok).toBe(true)
  })
})

describe('DICOM 去标识：服务端核验', () => {
  async function deidFile() {
    const d = await createDeidentifier({ key: KEY, pseudonym: PSEUDO })
    return ok(await d.deidentify(part10('1.2.840.10008.1.2.1', ctElements()))).bytes
  }
  const tamper = (bytes: Uint8Array, fn: (f: DicomFile) => void) => {
    const f = parseDicom(bytes, vrOf)
    fn(f)
    return writeDicom(f)
  }
  const text = (tag: number, vr: string, v: string): DicomElement => ({ tag, vr, value: new TextEncoder().encode(v.length % 2 ? `${v}${vr === 'UI' ? '\0' : ' '}` : v) })

  it('识别篡改：加回真实姓名、私有标签、白名单外标签、非 2.25 的 UID、换了患者、原件', async () => {
    const good = await deidFile()
    expect(verifyDeidentified(good, { pseudonym: PSEUDO })).toEqual({ ok: true })
    // 原样再写一遍仍通过（写出器稳定）
    expect(verifyDeidentified(tamper(good, () => {}), { pseudonym: PSEUDO })).toEqual({ ok: true })

    const name = tamper(good, f => { f.dataset = f.dataset.map(e => e.tag === 0x00100010 ? text(0x00100010, 'PN', 'ZHANG^SAN') : e) })
    expect(verifyDeidentified(name, { pseudonym: PSEUDO })).toMatchObject({ ok: false, reason: expect.stringContaining('假名') })

    const priv = tamper(good, f => { f.dataset.push(text(0x00291010, 'LO', 'SIEMENS CSA')) })
    expect(verifyDeidentified(priv, { pseudonym: PSEUDO })).toMatchObject({ ok: false, reason: expect.stringContaining('私有标签') })

    const extra = tamper(good, f => { f.dataset.push(text(0x00080080, 'LO', 'HOSPITAL')) })
    expect(verifyDeidentified(extra, { pseudonym: PSEUDO })).toMatchObject({ ok: false, reason: expect.stringContaining('白名单外') })

    const uid = tamper(good, f => {
      const seq = f.dataset.find(e => e.tag === 0x00081140)!
      seq.items![0] = seq.items![0]!.map(e => e.tag === 0x00081155 ? text(0x00081155, 'UI', REF_SOP) : e)
    })
    expect(verifyDeidentified(uid, { pseudonym: PSEUDO })).toMatchObject({ ok: false, reason: expect.stringContaining('未假名化的 UID') })

    const nested = tamper(good, f => { f.dataset.find(e => e.tag === 0x00081140)!.items![0]!.push(text(0x00100010, 'PN', 'ZHANG^SAN')) })
    expect(verifyDeidentified(nested, { pseudonym: PSEUDO })).toMatchObject({ ok: false })

    const marker = tamper(good, f => { f.dataset = f.dataset.filter(e => e.tag !== 0x00120062) })
    expect(verifyDeidentified(marker, { pseudonym: PSEUDO })).toMatchObject({ ok: false, reason: expect.stringContaining('标记') })

    expect(verifyDeidentified(good, { pseudonym: 'HXSOMEONEELSE1' })).toMatchObject({ ok: false, reason: expect.stringContaining('假名') })
    expect(verifyDeidentified(part10('1.2.840.10008.1.2.1', ctElements()), { pseudonym: PSEUDO })).toMatchObject({ ok: false })
  })
})

describe('上传源展开（浏览器端流式解 zip）', () => {
  it('zip 里的 DICOM 逐个产出；DICOMDIR、非 DICOM 说明原因；隐藏文件忽略；不压缩的条目也能读；估计条目数', async () => {
    const dcm = part10('1.2.840.10008.1.2.1', ctElements())
    const zip = zipSync({
      'PATIENT/CT/IM0001': [dcm, { level: 6 }], 'PATIENT/CT/IM0002': [dcm, { level: 0 }], DICOMDIR: dcm,
      'readme.txt': new TextEncoder().encode('hello'), '__MACOSX/CT/._IM0001': new Uint8Array(10), 'CT/.DS_Store': new Uint8Array(10),
    })
    const files = [new File([zip], 'study.zip'), new File([dcm], 'IM0003'), new File([new Uint8Array(400)], 'notes.bin')]
    const got: Array<{ name: string; ok: boolean; reason?: string }> = []
    for await (const e of iterateSources(files)) {
      got.push('bytes' in e ? { name: e.name, ok: true } : { name: e.name, ok: false, reason: e.skipped })
      if ('bytes' in e) expect(e.bytes).toEqual(dcm)
    }
    expect(got.sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: 'IM0003', ok: true },
      { name: 'notes.bin', ok: false, reason: '不是 DICOM 文件' },
      { name: 'study.zip/DICOMDIR', ok: false, reason: 'DICOMDIR 目录文件不入库' },
      { name: 'study.zip/PATIENT/CT/IM0001', ok: true },
      { name: 'study.zip/PATIENT/CT/IM0002', ok: true },
      { name: 'study.zip/readme.txt', ok: false, reason: '不是 DICOM 文件' },
    ])
    expect(await estimateSources(files)).toEqual({ files: 6, bytes: dcm.byteLength * 4 + 5 + 400 })
  })
})

// —— 服务端：取参数接口、默认拒收原件、院内配置接收原件、检查号单独加密存放 ——

function env(acceptIdentified = false) {
  const store = new Store(':memory:')
  const tenants = new TenantService(store, { devMode: false })
  const keys = new TenantKeys(store, kekFrom({ secret: 'test-secret' }))
  const patients = new PatientService(mkdtempSync(join(tmpdir(), 'hr-deid-')), tenants, keys, store)
  const hosp = store.createTenant({ name: '放射科', kind: 'org' })
  const other = store.createTenant({ name: '另一家医院', kind: 'org' })
  const dr = store.createUser({ username: 'dr_wang', display_name: '王医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const dr2 = store.createUser({ username: 'dr_zhao', display_name: '赵医生', password_hash: 'x', tenant: { id: hosp.id, role: 'member' } }).id
  const ext = store.createUser({ username: 'dr_ext', display_name: '外院医生', password_hash: 'x', tenant: { id: other.id, role: 'member' } }).id
  const orthanc = new FakeOrthanc()
  const svc = new ImagingStudyService(patients, orthanc, { acceptIdentified })
  const as = (userId: string, via: Actor['via'] = 'user'): Actor => ({ userId, via })
  return { store, patients, orthanc, svc, dr, dr2, ext, as }
}

const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

describe('去标识上传：服务端', () => {
  it('取参数：要写权限；AI 取不到；同机构密钥相同、患者假名各不相同且恒定；不同机构密钥不同；记访问留痕', () => {
    const t = env()
    const a = t.as(t.dr)
    const p = t.patients.create(a, { sex: 'F', birth_year: 1961 })
    const q = t.patients.create(a, { sex: 'M', birth_year: 1950 })
    const r1 = t.svc.deidParams(a, p.id), r2 = t.svc.deidParams(a, q.id)
    expect(fromB64(r1.key)).toHaveLength(32)
    expect(r1.key).toBe(r2.key)
    expect(r1.pseudonym).toMatch(/^HX[0-9A-F]{16}$/)
    expect(r1.pseudonym).not.toBe(r2.pseudonym)
    expect(t.svc.deidParams(a, p.id).pseudonym).toBe(r1.pseudonym)
    expect(r1).toMatchObject({ scheme: 'HEURION-DEID-1', accept_identified: false })
    expect(() => t.svc.deidParams(t.as(t.dr, 'ai'), p.id)).toThrow(/医生本人/)
    expect(() => t.svc.deidParams(t.as(t.ext), p.id)).toThrow()
    expect(t.patients.accessLog(a, p.id).some(l => l.action === 'imaging_deid_params')).toBe(true)
    // 另一家机构的密钥不同
    const pe = t.patients.create(t.as(t.ext), { sex: 'F', birth_year: 1970 })
    expect(t.svc.deidParams(t.as(t.ext), pe.id).key).not.toBe(r1.key)
  })

  it('默认拒收原件（写明「未经去标识」）；去标识过的入库，检查号经表单单独加密存放；别的患者的假名不收', async () => {
    const t = env()
    const a = t.as(t.dr)
    const p = t.patients.create(a, { sex: 'F', birth_year: 1961 })
    const q = t.patients.create(a, { sex: 'M', birth_year: 1950 })
    const raw = part10('1.2.840.10008.1.2.1', ctElements())
    await expect(t.svc.importDicom(a, p.id, [{ name: '1.dcm', bytes: raw }])).rejects.toThrow(/未经去标识/)
    expect(t.orthanc.instances.size).toBe(0)

    const prm = t.svc.deidParams(a, p.id)
    const d = await createDeidentifier({ key: fromB64(prm.key), pseudonym: prm.pseudonym })
    const r = ok(await d.deidentify(raw))
    const res = await t.svc.importDicom(a, p.id, [{ name: '1.dcm', bytes: r.bytes }, { name: '2.dcm', bytes: raw }], { [r.studyUid]: { accession: r.original.accession } })
    expect(res.files).toMatchObject({ received: 2, uploaded: 1, skipped: [{ name: '2.dcm', reason: expect.stringContaining('未经去标识') }] })
    expect(res.studies).toHaveLength(1)
    expect(res.studies[0]).toMatchObject({ study_uid: r.studyUid, accession: 'ACC-2026-0315', description: '胸部 CT 平扫' })
    // Orthanc 里没有检查号，也没有原 UID
    expect(t.orthanc.accessions.get(r.studyUid)).toBeNull()
    expect([...t.orthanc.instances.values()].some(i => i.study === STUDY)).toBe(false)
    // 后续批没带检查号：保留已有的
    const again = await t.svc.importDicom(a, p.id, [{ name: '1.dcm', bytes: r.bytes }])
    expect(again.studies[0]!.accession).toBe('ACC-2026-0315')

    // 用这位患者的假名去标识的文件，传给另一位患者：拒收
    await expect(t.svc.importDicom(a, q.id, [{ name: '1.dcm', bytes: r.bytes }])).rejects.toThrow(/假名/)
  })

  it('同一机构两位医生分别去标识同一检查：UID 一致，冲突检测照常（不关联到第二位患者）', async () => {
    const t = env()
    const p = t.patients.create(t.as(t.dr), { sex: 'F', birth_year: 1961 })
    const q = t.patients.create(t.as(t.dr2), { sex: 'F', birth_year: 1961 })
    const raw = part10('1.2.840.10008.1.2.1', ctElements())
    const up = async (who: string, pid: string) => {
      const prm = t.svc.deidParams(t.as(who), pid)
      const r = ok(await (await createDeidentifier({ key: fromB64(prm.key), pseudonym: prm.pseudonym })).deidentify(raw))
      return { r, res: await t.svc.importDicom(t.as(who), pid, [{ name: 'x', bytes: r.bytes }]) }
    }
    const first = await up(t.dr, p.id)
    const second = await up(t.dr2, q.id)
    expect(second.r.studyUid).toBe(first.r.studyUid)
    expect(second.res.conflicts).toBe(1)
    expect(second.res.studies).toHaveLength(0)
  })

  it('院内部署（acceptIdentified）接收原件', async () => {
    const t = env(true)
    const a = t.as(t.dr)
    const p = t.patients.create(a, { sex: 'F', birth_year: 1961 })
    const res = await t.svc.importDicom(a, p.id, [{ name: '1.dcm', bytes: part10('1.2.840.10008.1.2.1', ctElements()) }])
    expect(res.files.uploaded).toBe(1)
    expect(res.studies[0]).toMatchObject({ study_uid: STUDY, accession: 'ACC-2026-0315' })
    expect(t.svc.deidParams(a, p.id).accept_identified).toBe(true)
  })

  it('接口：取参数（no-store、留痕）；上传默认拒收原件、带 study_meta 的去标识文件入库；配置后接收原件', async () => {
    for (const accept of [false, true]) {
      const t = env()
      const docs = new Documents(t.store)
      const app = buildApi({
        docs, ops: new OpService(docs), turns: {} as any, postcheck: new PostCheck(docs), crossref: {} as any,
        renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'deid-r-'))), accounts: new Accounts(t.store, { secret: 'test-secret', devMode: false, devToken: 'dev', devUser: 'dev' }),
        devMode: false, devUser: 'dev', patients: t.patients, orthanc: t.orthanc, imagingPipeline: null, imagingAcceptIdentified: accept,
      })
      const auth = (u: string) => ({ Authorization: `Bearer ${issueToken('test-secret', { u, d: '*', p: ['read', 'write'], aud: 'web', ttlSeconds: 3600, v: t.store.getUser(u)!.token_version })}` })
      const p = t.patients.create(t.as(t.dr), { sex: 'F', birth_year: 1961 })
      const resp = await app.request(`/api/patients/${p.id}/imaging/deid-params`, { headers: auth(t.dr) })
      expect(resp.status).toBe(200)
      expect(resp.headers.get('cache-control')).toContain('no-store')
      const prm = await resp.json() as { key: string; pseudonym: string; accept_identified: boolean }
      expect(prm.accept_identified).toBe(accept)
      expect((await app.request(`/api/patients/${p.id}/imaging/deid-params`, { headers: auth(t.ext) })).status).toBeGreaterThanOrEqual(403)

      const raw = part10('1.2.840.10008.1.2.1', ctElements())
      const rawForm = new FormData()
      rawForm.append('files', new File([raw], 'ZHANG_SAN/IM1'))
      const rawUp = await app.request(`/api/patients/${p.id}/imaging/dicom`, { method: 'POST', headers: auth(t.dr), body: rawForm })
      if (!accept) {
        expect(rawUp.status).toBe(400)
        expect(((await rawUp.json()) as { error: string }).error).toContain('未经去标识')
        const r = ok(await (await createDeidentifier({ key: fromB64(prm.key), pseudonym: prm.pseudonym })).deidentify(raw))
        const form = new FormData()
        form.append('files', new File([new Uint8Array(r.bytes)], '1.dcm'))
        form.append('study_meta', JSON.stringify({ [r.studyUid]: { accession: r.original.accession }, 'not-a-uid': { accession: 'x' } }))
        const up = await app.request(`/api/patients/${p.id}/imaging/dicom`, { method: 'POST', headers: auth(t.dr), body: form })
        expect(up.status).toBe(201)
        const body = await up.json() as { studies: Array<{ accession: string }> }
        expect(body.studies[0]!.accession).toBe('ACC-2026-0315')
      } else {
        expect(rawUp.status).toBe(201)
      }
    }
  })
})
