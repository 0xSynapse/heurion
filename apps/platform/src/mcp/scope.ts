/**
 * MCP 工具范围：每一步模型调用都要带上全部工具的说明，平台工具一百多个（约 9.6 万字符）。
 * 普通稿件与幻灯片的回合只暴露用得到的工具，其余场景（患者文档、随航）仍为全部工具。
 * 范围在 dsh 进程启动时随 MCP 令牌签发（进程按范围分槽，见 turns/service.ts 与 harness/pool.ts）。
 */
import type { DocRow } from '../store/db.ts'

export type ToolScope = 'doc' | 'deck'

/** 稿件与幻灯片都用不到的：影像、患者与家庭健康档案、检验、报告、分享、机构与平台管理。 */
const CLINICAL = /^(imaging_|patient_|phr_|lab_|labs_|report_|share_|tenant_admin$|platform_admin$|account$|org_template$|asset_provenance$)/
/** 只有幻灯片用得到的。 */
const DECK = /^(deck_|slide_|layout_check$|image_search$)/

/** 这个工具在该范围里是否暴露；scope 缺省为全部。 */
export function toolInScope(name: string, scope: ToolScope | undefined): boolean {
  if (!scope) return true
  if (CLINICAL.test(name)) return false
  return scope === 'deck' || !DECK.test(name)
}

/** 用户在普通稿件里提到制作 / 同步更新 PPT、幻灯片时，升级为 deck 范围（同时具备文稿与幻灯片工具）。 */
const WANTS_DECK = /\bpptx?\b|\bslides?\b|\bdeck\b|幻灯片|演示文稿|课件/i

/** 回合所在文档的工具范围：幻灯片（或消息要求操作幻灯片）→ deck；不属于患者、随航等的普通稿件 → doc；其余为全部（null）。 */
export function scopeOf(row: Pick<DocRow, 'kind' | 'context'> | undefined, message?: string): ToolScope | null {
  if (!row) return null
  if (row.kind === 'deck') return 'deck'
  if (row.context) return null
  if (message && WANTS_DECK.test(message)) return 'deck'
  return 'doc'
}
