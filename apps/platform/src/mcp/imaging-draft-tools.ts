import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { TokenClaims } from '../auth/token.ts'
import { DraftError, FindingsDraftService } from '../imaging/findings-draft.ts'
import { ImagingError } from '../imaging/studies.ts'
import { MeasurementError, measureSpace } from '../measurements/service.ts'
import type { MeasureLookup } from '../model/measurements.ts'
import type { Documents } from '../model/runtime.ts'
import type { OpService } from '../ops/service.ts'
import { OpError } from '../ops/types.ts'
import type { DocRow } from '../store/db.ts'
import { PatientError, type PatientService } from '../tenancy/patients.ts'
import { TenantError } from '../auth/tenants.ts'

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ code, message, ...extra }, null, 2) }], isError: true as const })

export interface DraftToolDeps {
  claims: TokenClaims
  docs: Documents
  ops: OpService
  patients?: PatientService
  /** 当前回合（生成写入记在这个回合上，doc_revert_turn 可撤销） */
  turnId: () => string | null
  /** 文档的读 / 写权限检查（与其它文档工具相同）；通过时返回 null */
  check: (docId: string, perm: 'read' | 'write') => ReturnType<typeof fail> | null
  touch: (docId: string) => void
  measureViews: (row: DocRow) => MeasureLookup
}

/**
 * 所见草稿（T2.6）给 AI 的工具：读模板、生成草稿、核对草稿 / 取 RIS 纯文本。改模板不给 AI（tests/parity.test.ts 的 NOT_FOR_AI）。
 * 润色草稿用普通的 doc_edit（经同一套写前守卫）：保留 [@m:…]，不手写测量数字。
 */
export function registerImagingDraftTools(server: McpServer, deps: DraftToolDeps): void {
  let svc: FindingsDraftService | null = null
  const drafts = () => (svc ??= new FindingsDraftService(deps.docs.store, deps.docs, deps.ops, deps.patients!))
  const actor = () => ({ userId: deps.claims.u, via: 'ai' as const, space: 'work' as const })
  const failure = (err: unknown) => {
    if (err instanceof DraftError) return fail(err.code, err.message, err.extra)
    if (err instanceof MeasurementError) return fail(err.code, err.message, err.hint ? { hint: err.hint } : {})
    if (err instanceof OpError) return fail(err.code, err.message, err.extra)
    if (err instanceof PatientError || err instanceof ImagingError || err instanceof TenantError) return fail(err.code, err.message)
    throw err
  }

  server.registerTool('imaging_findings_templates', {
    description: '读本机构的所见模板（只读）：机构默认模板、各科室模板、内置模板，以及我（当前用户）生成草稿时默认用哪一份；给 scope（org 或 dept:<科室 id>）时返回该模板的全部版本。'
      + '模板由科室维护（机构管理员或本科室的审核医师在界面上修改），AI 不能修改模板。',
    inputSchema: { scope: z.string().optional().describe('org 或 dept:<科室 id>；给了时返回该模板的历史版本') },
  }, async ({ scope }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    try { return json(scope ? drafts().templates.history(actor(), scope) : drafts().templates.list(actor())) } catch (err) { return failure(err) }
  })

  server.registerTool('imaging_findings_draft', {
    description: '按科室所见模板为一次影像检查生成「所见草稿」（确定性生成，不是你写的）：每个已确认的肺结节一句（位置、密度、大小、随访变化），测量数字都是绑定好的 [@m:…]。'
      + '只用已确认的结节（被否决、撤销、待确认、影子模式的不进）；还有待确认的 AI 检出时会拒绝（pending_lesions），请让医生先确认或否决。'
      + '同一检查已有草稿时返回 draft_exists（带 doc_id）：要更新就带 doc_id（只改自上次生成后没人动过的段落，医生改过的原样保留），要另起一份就 new=true。'
      + '生成后可以用 doc_edit 润色措辞：原样保留每个 [@m:…]，不要手写任何测量数字（随访的差值、体积倍增时间需要时用 insert_measurement 的 source=imaging_followup 绑定）。'
      + '返回 warnings（未定稿、随访需核对、分割失败等）要转告医生。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      imaging_study_id: z.string().describe('影像检查 ID（imaging_studies 返回的 id）'),
      doc_id: z.string().optional().describe('更新这份已有的所见草稿'),
      new: z.boolean().optional().describe('已有草稿时仍新建一份'),
      department_id: z.string().optional().describe('用哪个科室的模板（我在多个有模板的科室时必填，见 imaging_findings_templates）'),
    },
  }, async ({ patient_id, imaging_study_id, doc_id, new: fresh, department_id }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    if (doc_id) { const denied = deps.check(doc_id, 'write'); if (denied) return denied }
    else if (!deps.claims.p.includes('write') || deps.claims.d !== '*') return fail('forbidden', '当前令牌不能新建文档')
    try {
      const r = drafts().generate(actor(), patient_id, { study_id: imaging_study_id, doc_id: doc_id ?? null, new: fresh === true, department_id: department_id ?? null }, { turnId: deps.turnId() })
      deps.touch(r.doc_id)
      return json({ ...r, note: '草稿已写入文档（经写前守卫）。告诉医生在哪份文档、有哪些需要核对的地方；润色只改措辞，保留 [@m:…]。' })
    } catch (err) { return failure(err) }
  })

  server.registerTool('imaging_findings_draft_check', {
    description: '核对一份报告 / 所见草稿并取「RIS 纯文本」（只读）：text 是粘贴进 RIS 的纯文字（测量展开为「数值 单位」，没有 markdown 记号与内部 id，不含草稿标题与〔草稿〕状态行）；'
      + 'issues 列出复制前要处理的问题：测量来源失效（block）、检查未定稿、新确认 / 被否决的结节、随访变化已变、待确认检出、模板有新版本等；draft 是草稿的来源检查、模板版本与生成时间（不是草稿时为 null）。',
    inputSchema: { doc_id: z.string() },
  }, async ({ doc_id }) => {
    const denied = deps.check(doc_id, 'read')
    if (denied) return denied
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    const row = deps.docs.store.getDoc(doc_id)!
    try { return json(drafts().risText({ ...actor(), space: measureSpace(row) }, row, deps.measureViews(row))) } catch (err) { return failure(err) }
  })
}
