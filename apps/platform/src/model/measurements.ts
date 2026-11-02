import type { Node as PMNode } from 'prosemirror-model'

/**
 * 测量原子 `[@m:<id>]`（PRD W4.2；docs/PLATFORM.md「测量原子」）：报告里的数字绑定到已确认的测量值，而不是由 AI 手写。
 *
 * 文档里只存原子 measurement(m_id)；数值、单位与来源状态在渲染时按登记表（measurements 表）取来源的当前值
 * （医生重测后报告随之更新），没有来源权限的读者看到绑定时的快照。本文件只放与运行环境无关的部分
 * （字段与单位目录、格式化、显示规则、裸测量数字识别），服务端与浏览器编辑器共用。
 *
 * 来源类型可扩展：本期只有影像病灶测量（imaging_lesion），以后科研手稿的队列统计值（W6.5）另加一种来源。
 */

/** 显示单位：dim 相同才能互换，factor = 1 个基准单位换算成该单位的倍数。 */
export const MEASURE_UNITS = {
  mm: { label: 'mm', dim: 'length', factor: 1, decimals: 1 },
  cm: { label: 'cm', dim: 'length', factor: 0.1, decimals: 2 },
  mm3: { label: 'mm³', dim: 'volume', factor: 1, decimals: 0 },
  cm3: { label: 'cm³', dim: 'volume', factor: 0.001, decimals: 2 },
  HU: { label: 'HU', dim: 'density', factor: 1, decimals: 0 },
  ratio: { label: '', dim: 'ratio', factor: 1, decimals: 2 },
} as const
export type MeasureUnit = keyof typeof MEASURE_UNITS

/** 影像病灶（imaging_lesions.metrics）里能绑定的测量字段：字段名 → 名称与基准单位。 */
export const LESION_FIELDS: Record<string, { label: string; base: MeasureUnit }> = {
  mean_diameter_mm: { label: '平均径', base: 'mm' },
  long_axis_mm: { label: '长径', base: 'mm' },
  short_axis_mm: { label: '短径', base: 'mm' },
  solid_core_diameter_mm: { label: '实性成分直径', base: 'mm' },
  volume_mm3: { label: '体积', base: 'mm3' },
  mean_hu: { label: '平均 CT 值', base: 'HU' },
  ctr: { label: '实性成分占比（CTR）', base: 'ratio' },
}

/** 某个基准单位可选的显示单位。 */
export function unitsFor(base: MeasureUnit): MeasureUnit[] {
  return (Object.keys(MEASURE_UNITS) as MeasureUnit[]).filter(u => MEASURE_UNITS[u].dim === MEASURE_UNITS[base].dim)
}

export function isMeasureUnit(u: unknown): u is MeasureUnit {
  return typeof u === 'string' && Object.prototype.hasOwnProperty.call(MEASURE_UNITS, u)
}

/** 基准单位的数值换算成显示单位（同一量纲才能换算）。 */
export function convertMeasure(value: number, base: MeasureUnit, unit: MeasureUnit): number {
  if (MEASURE_UNITS[base].dim !== MEASURE_UNITS[unit].dim) throw new Error(`单位 ${unit} 与 ${base} 不是同一量纲`)
  return value * MEASURE_UNITS[unit].factor / MEASURE_UNITS[base].factor
}

/** 「8.2 mm」「-12 HU」「0.45」。value 已是显示单位的数值。 */
export function formatMeasure(value: number, unit: MeasureUnit, decimals: number): string {
  const d = Math.max(0, Math.min(4, Math.floor(decimals)))
  let s = value.toFixed(d)
  if (/^-0(?:\.0+)?$/.test(s)) s = s.slice(1) // -0.0 → 0.0
  const label = MEASURE_UNITS[unit].label
  return label ? `${s} ${label}` : s
}

/** 绑定时快照的显示文字（登记表一行）。单位不认识时只写数值。 */
export function snapshotText(m: { bound_value: number; unit: string; decimals: number }): string {
  return isMeasureUnit(m.unit) ? formatMeasure(m.bound_value, m.unit, m.decimals) : String(m.bound_value)
}

/**
 * 渲染时的状态：
 * - ok：来源有效，显示当前值；updated：来源在绑定后改过且数值变了（显示当前值，提示绑定时的值）；
 * - rejected / withdrawn / unconfirmed：来源病灶已被否决 / 撤销或被取代 / 不再是已确认 —— 显示绑定时的快照并醒目标出；
 * - field_missing：来源还在但这个测量没有值了（如重新分割失败）—— 显示快照并标出；
 * - no_access：读者无权查看来源（或来源已不存在、不在读者的机构）—— 只显示绑定时的快照，不透露来源的当前情况；
 * - unknown：正文里的 [@m:id] 不在本文档的登记表里（例如从别的文档粘贴过来）。
 */
export type MeasureStatus = 'ok' | 'updated' | 'rejected' | 'withdrawn' | 'unconfirmed' | 'field_missing' | 'no_access' | 'unknown'

/** 一个测量原子在某位读者眼里的样子（渲染、导出、编辑器、AI 读视图共用）。 */
export interface MeasureView {
  id: string
  /** 正文里显示的文字（数值 + 单位）。 */
  text: string
  status: MeasureStatus
  /** 绑定时的文字（快照）。 */
  bound_text: string
  /** 来源的简短说明（「病灶 结节 1 · 右上叶 · 平均径」）；no_access 时只用绑定时记下的说明。 */
  source_label: string
  /** 来源当前版本 / 绑定时版本（无权限时 source_version 为 null）。 */
  source_version: number | null
  bound_version: number
  /** 给人看的状态说明（悬停提示、导出时的标注）。 */
  note: string
}

/** 状态异常（导出时要在数字后注明）的状态。 */
const FLAGGED: Partial<Record<MeasureStatus, string>> = {
  rejected: '来源病灶已被否决',
  withdrawn: '来源病灶已撤销',
  unconfirmed: '来源病灶未确认',
  field_missing: '来源测量已缺失',
  unknown: '未登记的测量',
}

/** 状态的文字说明。 */
export function statusNote(status: MeasureStatus, boundText: string): string {
  switch (status) {
    case 'ok': return '与来源一致'
    case 'updated': return `已随来源更新（绑定时为 ${boundText}）`
    case 'no_access': return '你没有查看来源病灶的权限：显示的是绑定时的值'
    default: return `${FLAGGED[status]}：显示的是绑定时的值`
  }
}

/** 导出（docx / pptx / HTML / markdown）时的文字：状态异常的在数字后注明，不能悄悄输出一个来源已失效的数字。 */
export function measureExportText(view: MeasureView | undefined, id: string): string {
  if (!view) return `〔${FLAGGED.unknown}〕`
  const flag = FLAGGED[view.status]
  if (view.status === 'unknown') return `〔${flag}〕`
  return flag ? `${view.text}〔${flag}〕` : view.text
}

export type MeasureLookup = ReadonlyMap<string, MeasureView>

/** 正文里测量原子的首次出现顺序。 */
export function measurementOrderOf(doc: PMNode): string[] {
  const order: string[] = []
  doc.descendants(n => {
    if (n.type.name === 'measurement' && !order.includes(n.attrs.m_id as string)) order.push(n.attrs.m_id as string)
  })
  return order
}

/** 一个块里的测量原子 id。 */
export function measurementsIn(node: PMNode): Set<string> {
  const out = new Set<string>()
  node.descendants(n => {
    if (n.type.name === 'measurement' && n.attrs.m_id) out.add(String(n.attrs.m_id))
    return true
  })
  return out
}

/** 写入内容里的测量标记（markdown 方言）。 */
export const MEASURE_MARKER = /\[@m:([a-z0-9]{3,32})\]/g

// —— 裸测量数字（写前守卫，可选的严格模式） ——

const NUM = String.raw`[-−+]?\d+(?:\.\d+)?`
const UNIT = String.raw`(?:mm³|mm3|mm²|mm2|cm³|cm3|cm²|cm2|mm|cm|HU|毫米|厘米)`
const BARE = new RegExp(String.raw`(?<![\w.])(${NUM})\s*(${UNIT})(?![A-Za-z0-9²³])`, 'g')
/** 采集 / 重建参数、阈值：不是病灶测量（层厚 1.25 mm、窗位 -600 HU、阈值 -400 HU…）。 */
const PARAM_CUE = /(?:层厚|层间距|重建间隔|间隔|准直|螺距|窗宽|窗位|阈值|视野|FOV|slice|thickness|interval|spacing|collimation|pitch|window|level|threshold|kernel)/i
/** 比较词在前：「≥ 6 mm」「大于 8 mm」—— 指南阈值、分类界值，不是测量结果。 */
const COMPARE_BEFORE = /(?:[≥≤><＞＜⩾⩽]|大于|小于|超过|不足|不超过|不小于|不大于|至少|低于|高于|greater than|less than|larger than|smaller than|at least|up to|exceeding|above|below|over|under)\s*(?:或等于)?\s*$/i
const COMPARE_AFTER = /^\s*(?:以上|以下|以内|及以上|及以下|or (?:more|less|larger|smaller|greater))/i
/** 范围（6–8 mm、6 mm 至 8 mm）：分类区间。 */
const RANGE_BEFORE = /\d\s*(?:mm|cm|毫米|厘米)?\s*[-–—~～至到]\s*$/
const RANGE_AFTER = /^\s*[-–—~～至到]\s*\d/
/** 压力单位 mmHg、cmH2O（带空格写法）。 */
const PRESSURE_AFTER = /^\s*(?:Hg|H2O|H₂O)/i

/**
 * 文字里的裸测量数字（带 mm / cm / mm² / mm³ / cm³ / HU 的数），按出现顺序返回规范写法（如 `8.2mm`）。
 * 不算：测量原子本身、采集参数（层厚、窗位…）、带比较词的阈值、范围、mmHg / cmH2O；日期、年龄、序号、百分比没有这些单位，本来就不算。
 */
export function findBareMeasurements(text: string): string[] {
  const src = text.replace(MEASURE_MARKER, ' ')
  const out: string[] = []
  for (const m of src.matchAll(BARE)) {
    const at = m.index!
    const before = src.slice(Math.max(0, at - 16), at)
    const after = src.slice(at + m[0].length, at + m[0].length + 12)
    const clause = before.split(/[，,。；;：:（(、\n]/).pop() ?? ''
    if (PARAM_CUE.test(clause) || COMPARE_BEFORE.test(before) || COMPARE_AFTER.test(after)) continue
    if (RANGE_BEFORE.test(before) || RANGE_AFTER.test(after) || PRESSURE_AFTER.test(after)) continue
    out.push(`${m[1]!.replace('−', '-')}${m[2]!.replace('3', '³').replace('2', '²')}`)
  }
  return out
}
