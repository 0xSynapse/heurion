import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { TokenClaims } from '../auth/token.ts'
import type { Store } from '../store/db.ts'
import { PatientError, type PatientService } from '../tenancy/patients.ts'
import { ImagingError } from '../imaging/studies.ts'
import { ImagingReviewService } from '../imaging/review.ts'

/**
 * 影像审核视图（T2.7）给 AI 的只读工具。与界面 GET /api/patients/:ptid/imaging/reviews、
 * …/studies/:stid/review、…/studies/:stid/signoffs/:seq 对应。初写完成、定稿、阅片角色不给 AI（tests/parity.test.ts 的 NOT_FOR_AI）。
 */
export function registerImagingReviewTools(server: McpServer, deps: { store: Store; claims: TokenClaims; patients?: PatientService }): void {
  const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] })
  const fail = (code: string, message: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: code, message }, null, 2) }], isError: true })

  server.registerTool('imaging_review', {
    description: '影像检查的审核视图（只读）。不给 imaging_study_id 时列出患者各检查的审核状态（reading 初写中 / submitted 待审核 / finalized 已定稿 / amending 定稿后修改中）；'
      + '给了时按病灶列出 AI 原值、初写修改、审核修改、当前值与定稿历史；再给 signoff_version 时返回那一次定稿的完整快照。'
      + '写报告、随访对比请用已定稿的值（state = finalized；amending 表示定稿后又有改动、尚未再次定稿）。AI 不能提交初写、不能定稿。',
    inputSchema: {
      patient_id: z.string().describe('患者 ID'),
      imaging_study_id: z.string().optional().describe('影像检查 ID（imaging_studies 返回的 id）；不给时列出全部检查的审核状态'),
      signoff_version: z.number().int().min(1).optional().describe('定稿版本号；给了时返回该次定稿的快照'),
    },
  }, async ({ patient_id, imaging_study_id, signoff_version }) => {
    if (!deps.patients) return fail('patients_unavailable', '患者模块未启用')
    const a = { userId: deps.claims.u, via: 'ai' as const, space: 'work' as const }
    const svc = new ImagingReviewService(deps.patients, u => deps.store.getUser(u)?.display_name ?? null)
    try {
      const all = svc.summaries(a, patient_id)
      if (!imaging_study_id) return json(all)
      if (!all.some(s => s.study_id === imaging_study_id)) return fail('not_found', '影像检查不存在')
      if (signoff_version) return json(svc.signoff(a, imaging_study_id, signoff_version))
      return json(svc.view(a, imaging_study_id))
    } catch (err) {
      if (err instanceof PatientError || err instanceof ImagingError) return fail(err.code, err.message)
      throw err
    }
  })
}
