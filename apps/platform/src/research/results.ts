import { RESULT_FIELDS } from '../model/measurements.ts'
import { numberObserved } from '../ops/numbers.ts'
import type { AnalysisResultRow, Store } from '../store/db.ts'

/**
 * 分析结果登记（docs/design/PROVENANCE.md 4.5）。
 *
 * AI 跑完分析（shell 里的 Python、dataset_* 工具）后，把统计量登记成一个结果，稿件里用
 * insert_measurement(source = analysis_result) 绑定成 [@m:]：重新分析后同名再登记，稿件里的数字一起更新。
 *
 * 防编造：AI 登记的每个数值都必须在本轮工具输出里出现过（与来源规则二同一套观察记录，可四舍五入）——
 * 登记表不能变成绕过数字出处检查的后门。用户本人在界面里登记不受此限（人写的数字，人负责）。
 */

export class ResultError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) { super(message) }
}

export interface RegisterInput {
  owner: string
  name: string
  method?: string
  values: Record<string, unknown>
  doc_id?: string | null
  code_path?: string | null
  dataset_ids?: string[]
  via: 'ai' | 'user'
  /** AI 回合（或会话）的观察记录键；AI 登记时必须有 */
  observe?: string | null
}

const decimalsOf = (v: number) => { const s = String(v); const i = s.indexOf('.'); return i < 0 || /e/i.test(s) ? 0 : s.length - i - 1 }

export function registerResult(store: Store, input: RegisterInput): AnalysisResultRow {
  const name = input.name.trim()
  if (!name || name.length > 80) throw new ResultError('invalid_name', '结果名称要有，且不超过 80 个字', '用能看懂的名字，如「OS 多因素 Cox · 年龄」')
  const values: Record<string, number> = {}
  for (const [k, v] of Object.entries(input.values ?? {})) {
    if (!RESULT_FIELDS[k]) throw new ResultError('invalid_field', `不认识的统计量 ${k}`, `可登记：${Object.entries(RESULT_FIELDS).map(([f, d]) => `${f}（${d.label}）`).join('、')}`)
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ResultError('invalid_value', `${k} 不是有效数字`)
    values[k] = v
  }
  if (Object.keys(values).length === 0) throw new ResultError('empty', '至少登记一个统计量')

  if (input.via === 'ai') {
    if (!input.observe) throw new ResultError('no_observation', '只能在 AI 回合里登记分析结果（要核对数值来自本轮的分析输出）')
    const seen = store.observedNumbers(input.observe)
    const missing = Object.entries(values).filter(([, v]) => !numberObserved({ raw: String(v), value: v, decimals: decimalsOf(v), percent: false }, seen))
    if (missing.length) {
      throw new ResultError('unobserved_value', `这些数值在本轮的分析输出里找不到：${missing.map(([k, v]) => `${k}=${v}`).join('、')}`,
        '先运行分析（脚本打印出结果，或用 dataset_* 工具），再用输出里的数值登记；不要手填或估算。')
    }
  }

  let studyId: string | null = null
  if (input.doc_id) {
    const doc = store.getDoc(input.doc_id)
    try { const ctx = doc?.context ? JSON.parse(doc.context) : null; if (ctx?.kind === 'study' && ctx.study_id) studyId = String(ctx.study_id) } catch { /* 没有归属 */ }
  }
  return store.upsertAnalysisResult({
    owner: input.owner, name, method: (input.method ?? '').trim().slice(0, 60), study_id: studyId, doc_id: input.doc_id ?? null,
    values, code_path: input.code_path?.trim() || null, dataset_ids: (input.dataset_ids ?? []).filter(x => typeof x === 'string').slice(0, 20),
  })
}

/** 用户能看到的分析结果：自己登记的 + 文档所在研究里的。 */
export function visibleResults(store: Store, userId: string, docId?: string | null): AnalysisResultRow[] {
  const mine = store.listAnalysisResults({ owner: userId })
  let study: AnalysisResultRow[] = []
  if (docId) {
    const doc = store.getDoc(docId)
    try {
      const ctx = doc?.context ? JSON.parse(doc.context) : null
      if (ctx?.kind === 'study' && ctx.study_id && store.studyRole(String(ctx.study_id), userId)) study = store.listAnalysisResults({ study_id: String(ctx.study_id) })
    } catch { /* 没有归属 */ }
  }
  const seen = new Set<string>()
  return [...mine, ...study].filter(r => !seen.has(r.id) && seen.add(r.id))
}
