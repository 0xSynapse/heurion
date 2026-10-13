/**
 * MPR 手动测量（卡尺 / ROI）的单位换算。
 * 只用影像元数据里的像素间距或体素间距换算为 mm；没有间距时以像素（切片显示网格）为单位，
 * 不用任何默认间距，也不能以 mm 写入记录或报告。
 */

export interface Spacing { h: number; v: number }
export interface VoxelSpacing { dx?: number; dy?: number; dz?: number }
export type Plane = 'axial' | 'coronal' | 'sagittal'

export const NO_SPACING_NOTE = '缺少体素间距，未换算为 mm'

const pos = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }

/** 当前切片的像素间距：优先切片自带的 pixel_spacing_mm，其次按平面取体素间距；都没有返回 null */
export function planeSpacing(pixel: { horizontal?: unknown; vertical?: unknown } | null | undefined, voxel: VoxelSpacing | null | undefined, plane: Plane): Spacing | null {
  const ph = pos(pixel?.horizontal), pv = pos(pixel?.vertical)
  if (ph && pv) return { h: ph, v: pv }
  if (!voxel) return null
  const [h, v] = plane === 'axial' ? [voxel.dx, voxel.dy] : plane === 'coronal' ? [voxel.dx, voxel.dz] : [voxel.dy, voxel.dz]
  const sh = pos(h), sv = pos(v)
  return sh && sv ? { h: sh, v: sv } : null
}

export interface Measure { value: number; unit: 'mm' | 'px' | 'mm²' | 'px²' }

const r1 = (n: number) => Math.round(n * 10) / 10

export function caliperMeasure(dxPx: number, dyPx: number, sp: Spacing | null): Measure {
  return sp ? { value: r1(Math.hypot(dxPx * sp.h, dyPx * sp.v)), unit: 'mm' } : { value: r1(Math.hypot(dxPx, dyPx)), unit: 'px' }
}

export function roiMeasure(wPx: number, hPx: number, sp: Spacing | null): Measure {
  return sp ? { value: r1(Math.abs(wPx) * sp.h * Math.abs(hPx) * sp.v), unit: 'mm²' } : { value: r1(Math.abs(wPx * hPx)), unit: 'px²' }
}

/** 已换算为物理单位（可以 mm 写入报告） */
export const isPhysical = (m: Measure) => m.unit === 'mm' || m.unit === 'mm²'

/** 显示文字：像素单位时附带提示 */
export function formatMeasure(m: Measure): string {
  const base = `${m.value.toFixed(1)} ${m.unit}`
  if (m.unit === 'mm²' && m.value >= 100) return `${base} (${(m.value / 100).toFixed(2)} cm²)`
  return isPhysical(m) ? base : `${base}（${NO_SPACING_NOTE}）`
}

/** 过小的误触不记：mm 下卡尺 < 1.5 mm、ROI < 4 mm²；像素下卡尺 < 2 px、ROI < 4 px² */
export function largeEnough(m: Measure): boolean {
  return m.unit === 'mm' ? m.value >= 1.5 : m.unit === 'px' ? m.value >= 2 : m.value >= 4
}
