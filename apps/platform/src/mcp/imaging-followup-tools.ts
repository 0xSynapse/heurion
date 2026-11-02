import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { TokenClaims } from '../auth/token.ts'
import { PatientError, type PatientService } from '../tenancy/patients.ts'
import { ImagingError } from '../imaging/studies.ts'
import { sharedFollowup, type ImagingFollowup } from '../imaging/followup.ts'

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })
const fail = (code: string, message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message }, null, 2) }], isError: true })

/**
 * 随访对比（T2.4）给 AI 的只读工具，对应界面 GET /api/patients/:ptid/imaging/studies/:stid/followup。
 * 重新匹配、拆开 / 重新对应是医生的判断，不给 AI（服务层同样拒绝 via = ai）。
 */
export function registerImagingFollowupTools(server: McpServer, deps: { claims: TokenClaims; patients?: PatientService; followup?: ImagingFollowup }): void {
  server.registerTool('imaging_followup', {
    description: '读一个影像检查与前片的随访对比（肺结节）：前片日期与间隔天数、配准质量、每个结节的变化（new 新发 / disappeared 消失 / enlarged 增大 / shrunk 缩小 / stable 稳定）、'
      + '平均径与体积的变化、体积倍增时间（只在体积增大时给出）、是否在测量误差范围内（within_error）、对应关系来源（ai 自动 / manual 医生）与是否需要医生核对（needs_review）。'
      + 'change 为 null 表示尚未对比。配准不可靠（registration.reliable = false）或 needs_review = true 的结论写报告前须经医生核对；AI 不能修改对应关系。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      imaging_study_id: z.string().describe('影像检查 ID（imaging_studies 返回的 id，本次检查）'),
    },
  }, async ({ patient_id, imaging_study_id }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    try {
      const a = { userId: deps.claims.u, via: 'ai' as const, space: 'work' as const }
      const f = deps.followup ?? sharedFollowup(deps.patients)
      if (f.studyPatient(a, imaging_study_id) !== patient_id) return fail('not_found', '影像检查不存在')
      return json(f.view(a, imaging_study_id))
    } catch (err) {
      if (err instanceof PatientError || err instanceof ImagingError) return fail(err.code, err.message)
      throw err
    }
  })
}
