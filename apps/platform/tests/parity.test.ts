import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { Accounts } from '../src/auth/accounts.ts'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import { buildApi } from '../src/http/api.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { ADMIN_TOOLS } from '../src/mcp/admin-tools.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { OpService } from '../src/ops/service.ts'
import { Documents } from '../src/model/runtime.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Store } from '../src/store/db.ts'
import { TurnService } from '../src/turns/service.ts'

/**
 * 人与 AI 操作能力相同（heurion2 的原则）：每个界面接口都要有对应的 MCP 工具，
 * 或者登记「为什么不给 AI」。新加接口没登记时测试失败（docs/design/AI_PERMISSIONS.md）。
 */
const PATIENT_PARITY: Record<string, string> = {
  'GET /api/patients': 'patient_list',
  'POST /api/patients': 'patient_create',
  'GET /api/patients/:ptid': 'patient_read',
  'PATCH /api/patients/:ptid': 'patient_update',
  'POST /api/patients/:ptid/team': 'patient_team',
  'DELETE /api/patients/:ptid/team/:uid': 'patient_team',
  'GET /api/patients/:ptid/access-log': 'patient_access_log',
  'GET /api/patients/:ptid/labs': 'labs_query',
  'POST /api/patients/:ptid/labs/:lid/:action{confirm|reject}': 'lab_resolve',
  'PATCH /api/patients/:ptid/labs/:lid': 'lab_edit',
  'POST /api/patients/:ptid/files': 'report_upload',
  'GET /api/patients/:ptid/files/:pfid': 'report_read',
  'GET /api/patients/:ptid/records/:rcid/text': 'report_read',
  'POST /api/patients/:ptid/records/:rcid/labs': 'report_lab_add',
  'POST /api/patients/:ptid/records/:rcid/:action{confirm|reject}': 'report_resolve',
  'POST /api/patients/:ptid/docs': 'patient_doc_link',
  'DELETE /api/patients/:ptid/docs/:id': 'patient_doc_link',
}
const STUDY_PARITY: Record<string, string> = {
  'GET /api/studies': 'study_list',
  'POST /api/studies': 'study_create',
  'GET /api/studies/:sid': 'study_read',
  'PATCH /api/studies/:sid': 'study_update',
  'POST /api/studies/:sid/items': 'study_link',
  'DELETE /api/studies/:sid/items/:kind/:rid': 'study_link',
  'GET /api/studies/:sid/cohort': 'study_cohort_list',
  'POST /api/studies/:sid/cohort/preview': 'study_cohort_preview',
  'POST /api/studies/:sid/cohort': 'study_enroll',
  'DELETE /api/studies/:sid/cohort/:ptid': 'study_unenroll',
  'POST /api/studies/:sid/cohort/dataset': 'study_cohort_dataset',
  'POST /api/studies/:sid/cohort/imaging-batch': 'imaging_cohort_batch_analyze',
  'POST /api/studies/:sid/figures': 'imaging_medical_figure_studio',
  'GET /api/figures': 'imaging_medical_figure_studio',
  'POST /api/figures': 'imaging_medical_figure_studio',
  // 研究变量：AI 能读、能录入 / 导入（一律未核实），核实只能研究者本人（见 NOT_FOR_AI）
  'GET /api/studies/:sid/vars': 'study_vars_list',
  'POST /api/studies/:sid/vars/manual': 'study_vars_set',
  'POST /api/studies/:sid/vars/import-dataset': 'study_vars_import_dataset',
  'POST /api/studies/:sid/vars/import-imaging': 'study_vars_import_imaging',
  // 研究团队成员（研究团队协作）
  'GET /api/studies/:sid/members': 'study_members',
  'GET /api/studies/:sid/candidates': 'study_members',
  'POST /api/studies/:sid/members': 'study_members',
  'PATCH /api/studies/:sid/members/:uid': 'study_members',
  'DELETE /api/studies/:sid/members/:uid': 'study_members',
  'POST /api/studies/:sid/transfer': 'study_members',
}
/** 图库：界面「图片 ▾ → 从 Unsplash 搜索」与 AI 同一个服务。 */
const IMAGE_PARITY: Record<string, string> = {
  'GET /api/images/search': 'image_search',
  'POST /api/docs/:id/slides/:slide/photo': 'slide_add_photo',
}

/**
 * 其余全部接口（文档、资料库、数据集、记忆、机构、平台运营、账户……）→ MCP 工具（「工具.action」= 管理类工具的某个动作）。
 * AI 的权限 = 用户本人的权限（docs/design/AI_PERMISSIONS.md）：用户能做的，AI 都有对应工具。
 */
const ALL_PARITY: Record<string, string> = {
  // 文档与幻灯片
  'GET /api/docs': 'doc_list', 'GET /api/search': 'docs_search', 'POST /api/docs': 'doc_create',
  'GET /api/docs/:id': 'doc_read', 'GET /api/docs/:id/read': 'doc_read', 'GET /api/docs/:id/html': 'doc_read', 'GET /api/docs/:id/deck': 'slide_read',
  'GET /api/docs/:id/diff': 'doc_diff', 'POST /api/docs/:id/edit': 'doc_edit', 'GET /api/docs/:id/slides/:index/render.png': 'slide_render',
  'PATCH /api/docs/:id': 'doc_manage.rename', 'POST /api/docs/:id/duplicate': 'doc_manage.duplicate', 'DELETE /api/docs/:id': 'doc_manage.trash',
  'GET /api/trash': 'doc_manage.trash_list', 'POST /api/docs/:id/restore': 'doc_manage.restore', 'DELETE /api/docs/:id/purge': 'doc_manage.purge',
  'POST /api/docs/:id/save': 'doc_manage.save_version', 'POST /api/docs/:id/versions/:seq/restore': 'doc_manage.restore_version',
  'POST /api/docs/:id/turns/:turnId/revert': 'doc_manage.revert_turn',
  'GET /api/docs/:id/export.docx': 'doc_manage.export', 'GET /api/docs/:id/export.pptx': 'doc_manage.export', 'GET /api/docs/:id/export.md': 'doc_manage.export',
  'POST /api/docs/:id/assets': 'asset_upload', 'GET /api/assets/:id/provenance': 'asset_provenance.read',
  'GET /api/deck-templates': 'deck_templates', 'GET /api/deck-themes': 'deck_templates',
  'GET /api/projects': 'project_manage.list', 'POST /api/projects': 'project_manage.create', 'PATCH /api/projects/:pid': 'project_manage.rename', 'DELETE /api/projects/:pid': 'project_manage.delete',
  // 评论与引用
  'POST /api/docs/:id/comments': 'comment_manage.create', 'POST /api/docs/:id/comments/:cid/replies': 'comment_reply',
  'POST /api/docs/:id/comments/:cid/:action{resolve|reopen}': 'comment_manage.resolve', 'DELETE /api/docs/:id/comments/:cid': 'comment_manage.delete',
  'POST /api/docs/:id/citations': 'insert_citation', 'POST /api/docs/:id/citations/import': 'import_references', 'POST /api/docs/:id/verify': 'verify_claims',
  // 资料库
  'GET /api/kb': 'kb_manage.list', 'GET /api/kb-status': 'kb_manage.status', 'POST /api/kb': 'kb_manage.upload', 'PATCH /api/kb/:fid': 'kb_manage.update', 'DELETE /api/kb/:fid': 'kb_manage.delete',
  'GET /api/kb-search': 'kb_search', 'GET /api/kb/:fid/text': 'kb_read', 'GET /api/kb/:fid/file': 'kb_read',
  // 数据集
  'GET /api/datasets': 'dataset_list', 'GET /api/datasets/:did': 'dataset_describe', 'GET /api/datasets/:did/preview': 'dataset_open',
  'POST /api/datasets/:did/table1': 'dataset_table1', 'POST /api/datasets/:did/survival': 'dataset_survival', 'POST /api/datasets/:did/imaging-survival': 'dataset_imaging_survival',
  'POST /api/datasets': 'dataset_manage.upload', 'PATCH /api/datasets/:did': 'dataset_manage.rename', 'POST /api/datasets/:did/phi': 'dataset_manage.resolve_phi', 'DELETE /api/datasets/:did': 'dataset_manage.delete',
  // 记忆
  'GET /api/memory': 'memory_manage.list', 'GET /api/memory/:mid/events': 'memory_manage.events', 'PATCH /api/memory/:mid': 'memory_manage.edit',
  'POST /api/memory': 'memory_propose', 'DELETE /api/memory/:mid': 'memory_forget', 'POST /api/memory/review': 'memory_review', 'POST /api/memory/skill-train': 'memory_manage.train_from_doc',
  'PUT /api/memory/settings': 'memory_manage.pause', 'GET /api/memory-export': 'memory_manage.export', 'POST /api/memory-import': 'memory_manage.import', 'DELETE /api/memory': 'memory_manage.clear_all',
  // 任务队列、账户
  'GET /api/queue': 'task_queue.list', 'POST /api/queue/:jid/cancel': 'task_queue.cancel',
  'GET /api/me': 'account.view', 'PATCH /api/me': 'account.update_profile', 'POST /api/auth/logout-everywhere': 'account.logout_everywhere',
  // 已有账户加入医院（双重身份）：本人接受 / 拒绝 / 退出
  'GET /api/me/invites': 'account.invites', 'GET /api/me/invites/:code': 'account.view_invite',
  'POST /api/me/invites/:code/accept': 'account.join_tenant', 'POST /api/me/invites/:code/decline': 'account.decline_invite', 'POST /api/tenant/leave': 'account.leave_tenant',
  'DELETE /api/tenant/members/:uid': 'tenant_admin.remove_member',
  // 机构（机构管理员）
  'GET /api/tenant': 'tenant_admin.view', 'PATCH /api/tenant': 'tenant_admin.update_settings', 'GET /api/tenant/members': 'tenant_admin.members', 'PATCH /api/tenant/members/:uid': 'tenant_admin.set_member',
  'GET /api/tenant/invites': 'tenant_admin.invites', 'POST /api/tenant/invites': 'tenant_admin.invite', 'DELETE /api/tenant/invites/:code': 'tenant_admin.revoke_invite',
  'GET /api/tenant/audit': 'tenant_admin.audit', 'GET /api/tenant/colleagues': 'tenant_admin.colleagues', 'GET /api/tenant/studies': 'tenant_admin.studies',
  'GET /api/tenant/templates': 'org_template.list', 'POST /api/tenant/templates': 'org_template.create', 'PATCH /api/tenant/templates/:otid': 'org_template.update', 'DELETE /api/tenant/templates/:otid': 'org_template.delete',
  'PUT /api/tenant/templates/:otid/logo': 'org_template.set_logo', 'DELETE /api/tenant/templates/:otid/logo': 'org_template.clear_logo',
  // 平台运营
  'GET /api/platform/tenants': 'platform_admin.tenants', 'POST /api/platform/tenants': 'platform_admin.create_tenant', 'PATCH /api/platform/tenants/:tid': 'platform_admin.set_tenant_status',
  'GET /api/admin/users': 'platform_admin.users', 'PATCH /api/admin/users/:uid': 'platform_admin.update_user', 'POST /api/admin/users/:uid/logout': 'platform_admin.logout_user',
  'GET /api/admin/settings': 'platform_admin.settings', 'PUT /api/admin/settings': 'platform_admin.update_settings', 'GET /api/admin/audit': 'platform_admin.audit',
  // 患者、研究的高权限操作
  'GET /api/patients-directory': 'patient_admin.directory', 'POST /api/patients/:ptid/break-glass': 'patient_admin.break_glass', 'DELETE /api/patients/:ptid': 'patient_admin.delete',
  // 知家（PATIENT.md）：成员健康档案的落点；AI 用 doc_create + patient_doc_link（archive）同样能得到
  'POST /api/phr/:ptid/archive': 'patient_doc_link',
  'DELETE /api/studies/:sid': 'study_admin.delete', 'POST /api/studies/:sid/transfer': 'study_admin.transfer', 'POST /api/studies/:sid/handover': 'tenant_admin.handover',
  // AI 发起的待确认操作：AI 能查状态，确认 / 拒绝只能用户本人（见 NOT_FOR_AI）
  'GET /api/actions': 'action_status', 'GET /api/actions/:aid': 'action_status',
  // 科室（知家分享按科室投递；docs/design/SHARING.md）
  'GET /api/tenant/departments': 'tenant_admin.departments', 'POST /api/tenant/departments': 'tenant_admin.create_department',
  'PATCH /api/tenant/departments/:dpid': 'tenant_admin.rename_department', 'DELETE /api/tenant/departments/:dpid': 'tenant_admin.delete_department',
  'PUT /api/tenant/departments/:dpid/members': 'tenant_admin.set_department_members',
  // 知家分享：家人一侧（新建分享是对外披露，需确认）与医生一侧（只读视图、纳入本院）
  'GET /api/phr/directory': 'phr_share.directory', 'GET /api/phr/:ptid/shares': 'phr_share.list', 'POST /api/phr/:ptid/shares': 'phr_share.create', 'DELETE /api/phr/shares/:shid': 'phr_share.revoke',
  'GET /api/shares': 'share_list', 'GET /api/shares/:shid': 'share_read', 'GET /api/shares/:shid/docs/:id': 'share_read',
  'GET /api/shares/:shid/labs': 'share_labs', 'GET /api/shares/:shid/files/:pfid': 'share_file', 'POST /api/shares/:shid/import': 'share_import',
  'POST /api/patients/:ptid/claim_code': 'patient_claim_code',
  'GET /api/patients/:ptid/claims': 'patient_claims_list',
  'GET /api/phr/:ptid/links': 'phr_member_links',
  'POST /api/ops/phi-scan': 'phi_scan',
  // MONAI 医学影像微服务与患者影像分析 (imaging_*)
  'GET /api/imaging/status': 'imaging_status',
  'GET /api/imaging/models': 'imaging_models',
  'POST /api/patients/:ptid/imaging/analyze': 'imaging_analyze',
  'GET /api/imaging/mpr/info': 'imaging_volume_info',
  'POST /api/imaging/mpr/info': 'imaging_volume_info',
  'POST /api/imaging/mpr/slice': 'imaging_mpr_slice',
  'POST /api/imaging/mpr/diff-slice': 'imaging_diff_slice',
  'POST /api/imaging/radiomics': 'imaging_radiomics',
  'POST /api/imaging/interactive-segment': 'imaging_interactive_segment',
  'POST /api/imaging/whole-body': 'imaging_whole_body_segment',
  'POST /api/imaging/registration/deformable': 'imaging_deformable_register',
  'POST /api/imaging/registration/pet-ct-fusion': 'imaging_pet_ct_fuse',
  'POST /api/imaging/rtstruct/delineate': 'imaging_rtstruct_delineate',
  'POST /api/patients/:ptid/imaging/compare': 'imaging_longitudinal_compare',
  'GET /api/patients/:ptid/imaging/evidence-chain': 'imaging_evidence_chain',
  'GET /api/patients/:ptid/imaging/export': 'imaging_export_standard',
  'POST /api/patients/:ptid/imaging/full-report': 'imaging_generate_full_report',
  'GET /api/patients/:ptid/imaging/full-report': 'imaging_generate_full_report',
}

/** AI 发起后要用户在确认卡上确认才执行的动作（不可恢复的删除、权限与安全、以机构身份对外的标识）。 */
const AI_CONFIRM = [
  'account.logout_everywhere', 'account.join_tenant', 'account.leave_tenant', 'tenant_admin.invite_user', 'tenant_admin.remove_member',
  'tenant_admin.update_settings', 'tenant_admin.set_member', 'tenant_admin.invite', 'tenant_admin.handover',
  'org_template.delete', 'org_template.set_logo', 'org_template.clear_logo',
  'platform_admin.create_tenant', 'platform_admin.set_tenant_status', 'platform_admin.update_user', 'platform_admin.logout_user', 'platform_admin.update_settings',
  'doc_manage.purge', 'comment_manage.delete', 'dataset_manage.delete', 'kb_manage.delete', 'memory_manage.clear_all',
  'patient_admin.break_glass', 'patient_admin.delete', 'study_admin.delete', 'study_admin.transfer',
  'tenant_admin.delete_department', 'tenant_admin.set_department_members', 'phr_share.create',
]

/** 不给 AI 的（只是界面机制，或必须本人亲自做）；每条写清理由。 */
const NOT_FOR_AI: Record<string, string> = {
  'GET /api/images': '界面用来决定是否显示搜图入口；AI 从 image_search 返回的 unsplash_unconfigured 得知图库没配置',
  'GET /api/imaging/samples': '界面用来获取可供医生体验的临床预置样本列表（如 chest_lung_ct 269层）；AI 可直接通过 imaging_analyze 的 sample_id 指定',
  'GET /api/imaging/samples/:id/file': '预置 3D 样本体素文件二进制下载流，由界面下载；AI 读量化指标与关键截面',
  'GET /api/patients/:ptid/imaging/jobs': '界面用来实时轮询患者后台 3D 影像推理阶段与进度条状态；AI 调用 imaging_analyze 时直接获取完整分析结果',
  // 知家分享原件图片由界面展示
  'GET /api/shares/:shid/assets/:aid': '图片二进制资产由界面渲染展示；AI 读打码后的文字内容（share_file / share_read）',
  // 机构患者认领码绑定的人机分界
  'POST /api/claims/:cid/confirm': '医生确认认领绑定必须由医生本人在界面操作防错绑（留审计，AI 不能代为确认）',
  'DELETE /api/claims/:cid': '撤销认领码或解除绑定是医生/家属本人的管理操作',
  'POST /api/phr/:ptid/claim': '在知家输入认领码是患者/家属本人操作',
  // 知家（PATIENT.md）：手动录入是家人自己填的数值，直接为已确认；AI 的化验只能来自报告提取（report_upload / report_lab_add）
  'POST /api/patients/:ptid/labs': '手动录入化验是家人本人的操作（AI 的化验来自上传报告的提取与补项）',
  'POST /api/patients/:ptid/proposals/:prid/:action{accept|reject}': '审核 AI 的提议是人的事（AI 不能采纳自己的提议）',
  'POST /api/docs/:id/suggestions/:group/:action{accept|reject}': '采纳 / 拒绝 AI 的修订是人的事（AI 不能采纳自己的修订）',
  'POST /api/memory/changes/:cid/:action{apply|dismiss}': '采纳 / 忽略 AI 的记忆整理建议是人的事',
  'POST /api/actions/:aid/:decision{confirm|reject}': '确认 / 拒绝 AI 发起的高风险操作只能由用户本人在界面上做',
  'POST /api/docs/:id/chat': '给 AI 发消息的入口（AI 本身就在这轮对话里）',
  'POST /api/phr/:ptid/brief': '就诊简报的生成入口：服务端组装指令起回合（AI 不自己给自己排队）',
  'POST /api/docs/:id/comments/:cid/ask': '把评论交给 AI 处理的入口（AI 收到后用 comments_list / comment_reply 处理）',
  'POST /api/docs/:id/turns/:turnId/retry': '重跑一轮 AI 对话的入口（AI 不能自己重开对话）',
  'POST /api/cancel': '停止当前 AI 回合的按钮（AI 不能停自己）',
  'GET /api/docs/:id/stream': '浏览器的实时事件流（SSE）',
  'GET /api/assets/:id': '图片字节给浏览器显示；AI 用 slide_render / 工作区文件看图',
  'GET /api/auth/challenge': '登录前的人机校验（AI 不登录、不注册）', 'GET /api/auth/config': '登录页配置',
  'POST /api/auth/login': 'AI 不经手密码', 'POST /api/auth/register': 'AI 不注册账号', 'POST /api/auth/password-code': 'AI 不经手密码与验证码', 'POST /api/auth/reset-password': 'AI 不经手密码与验证码',
  'POST /api/admin/users/:uid/reset-password': 'AI 不经手密码（平台运营本人在界面上重置）',
  'POST /api/me/email': '绑定邮箱要本人收验证码', 'POST /api/me/email-code': '绑定邮箱要本人收验证码',
  'POST /api/me/claim-dev-data': '只在开发模式下给管理员本人认领开发数据',
  'GET /api/invites/:code': '邀请链接的公开预览（注册前用）',
  'GET /api/mail/status': '发信服务配置与投递状态查询（前端状态展示）',
  'GET /api/mail/summary': '医生查阅最近48小时邮件AI动态汇总（AI生成，本人查阅）',
  'GET /api/mail/messages': '医生工作站专属邮箱列表（本人阅览）',
  'GET /api/mail/messages/:id': '医生查阅邮件详情（本人阅览）',
  'POST /api/mail/messages': '医生起草并发送医疗通知专函（医生操作）',
  'PATCH /api/mail/messages/:id/read': '医生在界面上标记已读或未读（医生操作）',
  'PATCH /api/mail/messages/:id/star': '医生在界面上对邮件标星或取消标星（医生操作）',
  'POST /api/mail/read-all': '医生在界面上一键标记全部已读（医生操作）',
  'POST /api/mail/batch': '医生在界面上批量操作邮件（标记已读/未读、星标、移入废纸篓、批量删除）',
  'DELETE /api/mail/messages/:id': '医生在界面上删除邮件（医生操作）',
  'DELETE /api/mail/trash': '医生在界面上一键清空废纸篓（医生本人管理操作）',
  'GET /api/mail/messages/:id/smart-replies': '医生在回复框查看针对该邮件的临床智能回复建议（AI 生成，医生选用）',
  'POST /api/mail/messages/:id/to-doc': '医生在界面上一键将邮件归档为工作区科研文稿（医生本人操作）',
  'POST /api/mail/messages/:id/to-patient': '医生在界面上一键将邮件归档至指定患者档案并生成就诊记录（医生本人操作）',
  'POST /api/mail/messages/:id/attachments/:attId/to-kb': '医生在邮件详情中将随附附件一键导入到个人资料库（医生本人操作）',
  'GET /api/mail/messages/:id/attachments/:attId/download': '浏览器端直接下载邮件附件二进制文件（界面下载流）',
  'POST /api/mail/inbound': '外部邮件系统 (Cloudflare/Resend) 的 Inbound Webhook 投递回调，供外部系统投递邮件到站内',
  'GET /api/calendar/events': '医生排期日历事件列表（本人查阅）',
  'GET /api/calendar/events/:id': '医生查阅排期事件详情（本人查阅）',
  'POST /api/calendar/events': '医生安排随访与科研日程（医生操作）',
  'PATCH /api/calendar/events/:id': '医生更新排期或标记完成（医生操作）',
  'POST /api/calendar/batch': '医生在界面上批量操作排期日程（批量标记完成、恢复待办、批量删除）',
  'DELETE /api/calendar/events/:id': '医生删除排期日程（医生操作）',
  'POST /api/docs/:id/comments/:cid/exempt-claim': '医生在界面上将某论断标记为临床经验豁免（医生主观判定）',
  'POST /api/docs/:id/comments/:cid/apply-claim-fix': '医生在界面上一键采纳论断修改建议并替换正文（医生确认操作）',
  // 临床科研发表级证据链与三线表导出（由界面交互与下载）
  'GET /api/datasets/:did/table1-docx': '原生 Word (.docx) Table 1 二进制文件流，由浏览器界面下载',
  'POST /api/datasets/:did/table1-docx': '原生 Word (.docx) Table 1 二进制文件流，由浏览器界面下载',
  'GET /api/studies/:sid/cohort/consort': '出版级 CONSORT 2010 流程图矢量 SVG 预览与下载，由界面展示下载',
  'POST /api/studies/:sid/cohort/consort': '出版级 CONSORT 2010 流程图参数调整与矢量 SVG 生成，由界面交互',
  'POST /api/studies/:sid/causal/e-value': '因果推断 VanderWeele E-value 敏感度与审稿回复交互计算器，由界面操作',
  'POST /api/studies/:sid/causal/love-plot': '因果推断 Love Plot 协变量平衡收敛散点图生成，由界面展示',
  // Auto-eCRF 多模态特征批量提取与溯源（由界面弹窗交互配置、进度展示与数据归入）
  'GET /api/studies/:sid/ecrf/template': 'Auto-eCRF 变量字典模版查询，由界面配置对话框渲染',
  'POST /api/studies/:sid/ecrf/extract': 'Auto-eCRF 多模态特征自动提取巡航与切片证据溯源矩阵，由界面展示与交互溯源',
  'POST /api/studies/:sid/ecrf/save-dataset': '将 eCRF 提取矩阵保存固化为研究快照数据集，由医生在界面操作确认',
  // SCI 投稿包全量导出与预后预测模型 (Nomogram / ROC / DCA)
  'POST /api/studies/:sid/vars/verify': '研究变量的核实须研究者本人确认，AI 不能核实（服务层同样拒绝 via=ai）',
  'POST /api/studies/:sid/publication-bundle': 'SCI 投稿级成果包一键全量导出打包 (.zip) 二进制文件流，由浏览器界面直接下载',
  'POST /api/datasets/:did/nomogram': '预后预测列线图 (Nomogram) 标尺映射与矢量图生成，由界面交互弹窗计算与渲染',
  'POST /api/datasets/:did/roc-dca': 'ROC 诊断效能对比与 DCA 临床决策净获益曲线分析，由界面交互弹窗渲染',
  'GET /api/citations/search': '文献模糊搜索自动联想补全（供用户界面弹窗使用，AI 直接调 pubmed_search/openalex_search）',
  'GET /api/copilot/status': '全局 Co-Pilot 随航助手状态与历史查询（界面随航抽屉展示用）',
  'POST /api/copilot/chat': '全局 Co-Pilot 随航助手用户发起对话入口（由用户输入触发回合）',
  'POST /api/copilot/clear': '全局 Co-Pilot 随航助手清空会话（用户界面操作）',
  'DELETE /api/memory/rules/:rid': '移除个人自适应执行经验由用户本人在记忆界面操作（AI 不能自行删除约束自己的避坑规则）',
  // 官网公开无状态小工具（供未登录访客在官网着陆页体验；工作区内 AI 直接调用对应的已鉴权 MCP 工具）
  'POST /api/public/tools/e-value': '官网着陆页公开无状态 E-value 计算小工具（AI 调 study_cohort / biostatistician）',
  'POST /api/public/tools/consort': '官网着陆页公开无状态 CONSORT 流程图小工具（AI 调 study_cohort）',
  'POST /api/public/tools/table1': '官网着陆页公开无状态 Table 1 基线表计算小工具（AI 调 dataset_manage）',
  'POST /api/public/tools/table1-docx': '官网着陆页公开无状态 Table 1 Word 导出小工具（浏览器端文件下载）',
  'POST /api/public/tools/citation-check': '官网着陆页公开无状态文献真伪核验小工具（AI 调 pubmed_search / verify_claims）',
  // Aegis Application Protocol (AAP-1.0) 协议握手、授权令牌管理与人工租约审批接口
  'POST /api/aegis/auth/device': '由本地 aegis-os app login 发起 RFC 8628 设备码免密绑定请求（AI 不能自行发起）',
  'POST /api/aegis/auth/device/approve': '医生/研究员本人在设置页输入 8 位终端设备码确认绑定（AI 不能自行确认）',
  'POST /api/aegis/auth/token': '由医生/研究员本人通过 aegis app login 或设置页签发 Aegis 授权令牌（AI 不能自行签发令牌）',
  'DELETE /api/aegis/auth/token': '由医生/研究员本人或 aegis app logout 吊销 Aegis 授权令牌',
  'GET /api/aegis/auth/grants': '用户在设置页查看已绑定的 Aegis-OS 工作站授权列表',
  'GET /api/aegis/leases/escalations': '医生/研究员在待确认列表查看 Aegis-OS 智能体发起的 [Lease-Gated] 提权申请与生效租约',
  'POST /api/aegis/leases/approve': '医生/研究员本人审批 [Lease-Gated] 提权申请（AI 不能自我批准租约）',
  'POST /api/aegis/leases/reject': '医生/研究员本人拒绝 [Lease-Gated] 提权申请（AI 不能自我决定租约）',
  'POST /api/aegis/mcp': 'AAP-1.0 统一 MCP 协议网关入口本身（承载全部 MCP 工具调用）',
}

describe('人机对等：每个接口（AI 的权限 = 用户的权限）', () => {
  it('每个接口都有对应的 MCP 工具（或登记了不给 AI 的理由）', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const app = buildApi({
      docs, ops: new OpService(docs), turns: new TurnService(docs, {} as HarnessPool, new TurnRegistry()), postcheck: new PostCheck(docs), crossref: {} as CrossrefClient,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'par-'))), accounts: new Accounts(store, { secret: 's', devMode: false, devToken: 'd', devUser: 'd' }), devMode: false, devUser: 'd',
    })
    const routes = [...new Set(app.routes.filter(r => r.path.startsWith('/api/') && r.method !== 'ALL').map(r => `${r.method} ${r.path}`))]
    const MAP: Record<string, string> = { ...PATIENT_PARITY, ...STUDY_PARITY, ...IMAGE_PARITY, ...ALL_PARITY }
    expect(routes.filter(r => !MAP[r] && !NOT_FOR_AI[r]), '新接口要登记对应的 MCP 工具（AI 的权限 = 用户的权限），或在 NOT_FOR_AI 里写明理由').toEqual([])
    expect(Object.keys(MAP).filter(r => NOT_FOR_AI[r]), '同一个接口不能既给 AI 又不给').toEqual([])
    expect(Object.keys({ ...MAP, ...NOT_FOR_AI }).filter(r => !routes.includes(r)), '登记的接口要真的存在').toEqual([])

    const claims = verifyToken('s', issueToken('s', { u: 'u1', d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const server = buildMcpServer({
      docs, ops: new OpService(docs), turns: new TurnRegistry(), secret: 's', claims: new ClaimService(docs, {} as PubMedClient), renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'par2-'))),
      pubmed: {} as PubMedClient, crossref: {} as CrossrefClient, workspaceDir: () => tmpdir(), isLiveSession: () => true,
    }, claims)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'par', version: '0' })
    await client.connect(b)
    const tools = new Set((await client.listTools()).tools.map(t => t.name))
    const used = [...new Set([...Object.values(PATIENT_PARITY), ...Object.values(STUDY_PARITY), ...Object.values(IMAGE_PARITY), ...Object.values(ALL_PARITY)])]
    expect(used.map(t => t.split('.')[0]!).filter(t => !tools.has(t)), '登记的工具要真的存在').toEqual([])
    // 「工具.action」：管理类工具里真有这个动作，且它调用的正是登记的那个接口
    const toRe = (route: string) => { const [m, p] = route.split(' ') as [string, string]; return { m, re: new RegExp(`^${p.replace(/:[a-zA-Z]+\{([^}]+)\}/g, '($1)').replace(/:[a-zA-Z]+/g, '[^/?]+')}(\\?.*)?$`) } }
    const wrong: string[] = []
    for (const [route, target] of Object.entries(ALL_PARITY)) {
      const [tool, action] = target.split('.')
      if (!action) continue
      const op = ADMIN_TOOLS.find(t => t.name === tool)?.actions[action]
      if (!op) { wrong.push(`${route} → ${target}：没有这个动作`); continue }
      const sample = op.path(new Proxy({}, { get: (_t, k) => k === 'format' ? route.match(/export\.(\w+)/)?.[1] ?? 'docx' : k === 'seq' ? 1 : 'x1' }))
      const { m, re } = toRe(route)
      const same = (op.method === m && re.test(sample)) || Object.values(ADMIN_TOOLS.find(t => t.name === tool)!.actions).some(o => o.method === m && re.test(o.path(new Proxy({}, { get: () => 'x1' }))))
      if (!same) wrong.push(`${route} → ${target}（${op.method} ${sample}）`)
    }
    expect(wrong, '登记的动作要调用对应的接口').toEqual([])
    // 需要用户确认的动作（AI_CONFIRM）与工具定义一致
    const confirmed = ADMIN_TOOLS.flatMap(t => Object.entries(t.actions).filter(([, o]) => o.confirm).map(([a]) => `${t.name}.${a}`)).sort()
    expect(confirmed).toEqual([...AI_CONFIRM].sort())
  })
})
