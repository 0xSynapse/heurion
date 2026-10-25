import { createHash } from 'node:crypto'
import { OrthancError, type Orthanc, type OrthancSeries, type OrthancStudy } from '../src/imaging/orthanc.ts'

/** 测试用 DICOM：128 字节前导 + DICM + 一段 JSON（假 Orthanc 从这里读 UID） */
export function dicom(study: string, series: string, sop: string): Uint8Array<ArrayBuffer> {
  const body = new TextEncoder().encode(JSON.stringify({ study, series, sop }))
  const out = new Uint8Array(132 + body.byteLength)
  out.set([0x44, 0x49, 0x43, 0x4d], 128)
  out.set(body, 132)
  return out
}

/** 一个序列的 n 个实例 */
export const seriesFiles = (study: string, series: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `${series}-IM${i + 1}`, bytes: dicom(study, series, `${series}.${i + 1}`) }))

/** 内存版 Orthanc：按实例里的 UID 归档（Orthanc 的 ID 和真实一样是哈希，不含 UID），记下收到的请求 */
export class FakeOrthanc implements Orthanc {
  instances = new Map<string, { study: string; series: string }>()
  calls: Array<{ path: string; query: string }> = []
  archives: string[] = []
  /** 按 SeriesInstanceUID 覆盖序列标签（层厚、重建核、部位等） */
  seriesTags = new Map<string, Partial<OrthancSeries>>()
  private uids = new Map<string, string>()
  private oid(uid: string): string {
    const id = createHash('sha1').update(uid).digest('hex').slice(0, 16)
    this.uids.set(id, uid)
    return id
  }
  async upload(bytes: Uint8Array) {
    let meta: { study: string; series: string; sop: string }
    try { meta = JSON.parse(new TextDecoder().decode(bytes.slice(132))) } catch { throw new OrthancError(400, '不是有效的 DICOM 文件') }
    const had = this.instances.has(meta.sop)
    this.instances.set(meta.sop, { study: meta.study, series: meta.series })
    return { instanceId: this.oid(meta.sop), studyId: this.oid(meta.study), seriesId: this.oid(meta.series), status: had ? 'AlreadyStored' as const : 'Success' as const }
  }
  async study(id: string): Promise<OrthancStudy> {
    const uid = this.uids.get(id)!
    const series = [...new Set([...this.instances.values()].filter(i => i.study === uid).map(i => this.oid(i.series)))]
    return { studyUid: uid, studyDate: '2026-10-20', description: '胸部 CT 平扫', accession: 'ACC-778899', series }
  }
  async series(id: string): Promise<OrthancSeries> {
    const uid = this.uids.get(id)!
    return {
      seriesUid: uid, modality: 'CT', bodyPart: 'CHEST', description: '1.25mm 肺算法', sliceThickness: 1.25, kernel: 'B70f',
      instances: [...this.instances.values()].filter(i => i.series === uid).length, ...this.seriesTags.get(uid),
    }
  }
  async seriesArchive(id: string): Promise<Uint8Array> {
    this.archives.push(this.uids.get(id)!)
    return new Uint8Array([0x50, 0x4b, 0x03, 0x04])
  }
  async dicomweb(path: string, query: string) {
    this.calls.push({ path, query })
    return new Response(JSON.stringify([{ ok: path }]), { headers: { 'content-type': 'application/dicom+json' } })
  }
}

/** 假影像 worker：记下请求，按 handler 返回 */
export function fakeWorker(handler: (path: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ path: string; method: string; body: unknown }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body instanceof FormData ? { volume_id: init.body.get('volume_id') } : null
    calls.push({ path, method: init.method ?? 'GET', body })
    return handler(path, init)
  }) as typeof fetch
  return { calls, fetchImpl }
}

export const NODULE_RESULT = {
  model_id: 'lung_nodule_pipeline', model_version: 'lung_nodule_ct@0.5.9+vista3d@0.5.7', device: 'cpu', elapsed_ms: 4200,
  series_qc: { slice_thickness_mm: 1.25, spacing_mm: [1.25, 0.7, 0.7], shape: [240, 512, 512], warnings: [] },
  nodules: [
    { index: 1, detection_score: 0.93, center_vox_zyx: [120, 200, 310], box_vox_zyx: [114, 192, 302, 126, 208, 318], lobe: 'RUL', segmentation: 'vista3d', key_slice_z: 120,
      metrics: { long_axis_mm: 9.1, short_axis_mm: 7.3, mean_diameter_mm: 8.2, volume_mm3: 288.4, mean_hu: -12, std_hu: 64, nodule_type: 'solid', solid_core_diameter_mm: null, ctr: null }, warnings: [] },
    { index: 2, detection_score: 0.71, center_vox_zyx: [80, 300, 150], box_vox_zyx: [76, 295, 145, 84, 305, 155], lobe: 'LLL', segmentation: 'failed', key_slice_z: 80,
      metrics: { long_axis_mm: 5.5, short_axis_mm: 5.5, mean_diameter_mm: 5.5, volume_mm3: null, mean_hu: null, std_hu: null, nodule_type: null, solid_core_diameter_mm: null, ctr: null }, warnings: ['分割失败，测量取检出框径'] },
  ],
  warnings: [],
}
