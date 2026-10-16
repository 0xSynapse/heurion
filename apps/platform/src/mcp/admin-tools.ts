import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Invoke, InvokeBody } from '../http/invoke.ts'
import type { Store } from '../store/db.ts'
import type { TurnRegistry } from './turns.ts'

/**
 * AI 拥有用户本人的权限（docs/design/AI_PERMISSIONS.md）：界面上能做的机构管理、平台运营、账户、删除 / 恢复……
 * 这里的每个动作都映射到同一个 HTTP 接口，在进程内以用户身份调用（权限判定、审计与界面一致，见 http/invoke.ts）。
 * 高风险动作（不可恢复的删除、权限与安全设置、以机构身份对外的标识）不直接执行：生成「待确认操作」，
 * 用户在对话里的确认卡上确认后才以用户身份执行（审计 via=ai-confirmed、confirmed_by=用户）。AI 不能确认自己的操作。
 */

type Args = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

interface Op {
  method: Method
  path: (a: Args) => string
  /** 请求体；需要读工作区文件时用 file(path) */
  body?: (a: Args, file: (p: unknown) => WorkspaceFile) => InvokeBody | undefined
  /** 需要用户确认 */
  confirm?: boolean
  /** 确认卡上的一句话（做什么、影响什么） */
  summary?: (a: Args) => string
  /** 确认卡上用户可改的字段（请求体 json 里的键 → 当前值） */
  editable?: (a: Args) => Record<string, string>
  /** 生成确认卡前先探一下权限 / 资源是否存在（GET，非 2xx 直接报错，不生成卡片） */
  probe?: (a: Args) => string
  /** 只有机构管理员 / 平台运营能做（生成确认卡前检查，避免给无权的人弹卡片） */
  role?: 'tenant_admin' | 'operator'
  /** 返回二进制（导出）：写进工作区，返回路径 */
  save?: (a: Args) => string
}

interface ToolSpec { name: string; description: string; input: Record<string, z.ZodTypeAny>; actions: Record<string, Op> }

export interface WorkspaceFile { bytes: Uint8Array; name: string; mime: string }

const enc = (v: unknown) => encodeURIComponent(String(v ?? ''))
const q = (o: Record<string, unknown>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${enc(v)}`)
  return p.length ? `?${p.join('&')}` : ''
}
const only = (a: Args, keys: string[]) => Object.fromEntries(keys.filter(k => a[k] !== undefined).map(k => [k, a[k]]))
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.json': 'application/json',
}

const reasonField = z.string().max(500).optional().describe('为什么要做这件事（高风险操作会显示在确认卡上，给用户看）')

/** 全部管理类工具：动作 → 接口。parity 测试按这里核对每个接口都有对应的 AI 能力。 */
export const ADMIN_TOOLS: ToolSpec[] = [
  {
    name: 'account',
    description: '当前用户的账户：view 看自己是谁（平台角色、所在机构、机构角色、是否已加入医院——AI 的权限就是这个用户的权限）；update_profile 改显示名；logout_everywhere 让用户在所有设备上下线（需用户确认）。加入医院（个人空间 / 知家保留）：invites 发给本人的邀请；view_invite 看某个邀请（code，含链接邀请）；join_tenant 接受邀请 code 加入医院（权限变更，需用户确认）；decline_invite 拒绝邀请 code；leave_tenant 退出当前医院、回到个人空间（需用户确认）。',
    input: { action: z.enum(['view', 'update_profile', 'logout_everywhere', 'invites', 'view_invite', 'join_tenant', 'decline_invite', 'leave_tenant']), display_name: z.string().max(40).optional(), code: z.string().optional(), reason: reasonField },
    actions: {
      view: { method: 'GET', path: () => '/api/me' },
      invites: { method: 'GET', path: () => '/api/me/invites' },
      view_invite: { method: 'GET', path: a => `/api/me/invites/${enc(a.code)}` },
      join_tenant: { method: 'POST', path: a => `/api/me/invites/${enc(a.code)}/accept`, confirm: true, probe: a => `/api/me/invites/${enc(a.code)}`, summary: a => `接受邀请 ${a.code}，加入这家医院（工作台的患者、研究、科室、机构模板改按医院走；你的个人文档和知家家人档案不受影响）` },
      decline_invite: { method: 'POST', path: a => `/api/me/invites/${enc(a.code)}/decline` },
      leave_tenant: { method: 'POST', path: () => '/api/tenant/leave', confirm: true, summary: () => '退出当前医院，回到个人空间（医院里的研究成员身份、科室归属会去掉；还负责本院研究的要先转交）' },
      update_profile: { method: 'PATCH', path: () => '/api/me', body: a => ({ json: only(a, ['display_name']) }) },
      logout_everywhere: { method: 'POST', path: () => '/api/auth/logout-everywhere', confirm: true, summary: () => '让你在所有设备上的登录全部失效（需要重新登录）' },
    },
  },
  {
    name: 'tenant_admin',
    description: '机构管理（只有机构管理员能做，和界面「机构管理」一致）：invite_user 按用户名邀请平台上已有的账户加入本院（对方本人接受后加入、个人空间保留；需确认）；remove_member 把成员移出本院（回到他自己的个人空间；需确认）。view 机构信息与设置；update_settings 改机构名称或设置（patient_module、patient_visibility tenant|care_team、ai_patient_writes review|direct、external_model_for_patients；需用户确认）；members 成员；set_member 改成员角色 admin|member 或停用（需确认）；invites / invite（需确认）/ revoke_invite 邀请；audit 本机构审计日志；colleagues 同事；studies 本机构研究（交接用）；handover 把离职成员负责的研究交给 to_user_id（需确认）。科室（知家家庭分享按科室投递）：departments 列出科室与成员；create_department / rename_department（name）；delete_department（需确认）；set_department_members 设置科室成员 user_ids（权限变更，需确认）。设置项 accept_patient_shares=false 时不再接受家庭分享。',
    input: {
      action: z.enum(['view', 'update_settings', 'members', 'set_member', 'remove_member', 'invites', 'invite', 'invite_user', 'revoke_invite', 'audit', 'colleagues', 'studies', 'handover', 'departments', 'create_department', 'rename_department', 'delete_department', 'set_department_members']),
      department_id: z.string().optional(), user_ids: z.array(z.string()).optional(),
      name: z.string().max(60).optional(), settings: z.record(z.unknown()).optional(),
      user_id: z.string().optional(), tenant_role: z.enum(['admin', 'member']).optional(), status: z.enum(['active', 'disabled']).optional(),
      username: z.string().max(64).optional(),
      invite_role: z.enum(['admin', 'member']).optional(), email: z.string().max(120).optional(), days: z.number().int().min(1).max(30).optional(), code: z.string().optional(),
      study_id: z.string().optional(), to_user_id: z.string().optional(), actor: z.string().optional(), filter_action: z.string().optional(), limit: z.number().int().min(1).max(500).optional(), reason: reasonField,
    },
    actions: {
      view: { method: 'GET', path: () => '/api/tenant' },
      update_settings: { method: 'PATCH', path: () => '/api/tenant', role: 'tenant_admin', confirm: true, body: a => ({ json: only(a, ['name', 'settings']) }), summary: a => `修改机构${a.name ? `名称为「${a.name}」` : ''}${a.settings ? `设置：${Object.entries(a.settings as object).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('，')}` : ''}` },
      members: { method: 'GET', path: () => '/api/tenant/members' },
      set_member: { method: 'PATCH', path: a => `/api/tenant/members/${enc(a.user_id)}`, role: 'tenant_admin', confirm: true, body: a => ({ json: only(a, ['tenant_role', 'status']) }), summary: a => `把成员 ${a.user_id} ${a.tenant_role ? `设为${a.tenant_role === 'admin' ? '机构管理员' : '普通成员'}` : ''}${a.status ? (a.status === 'disabled' ? '停用' : '恢复启用') : ''}` },
      invites: { method: 'GET', path: () => '/api/tenant/invites' },
      invite: { method: 'POST', path: () => '/api/tenant/invites', role: 'tenant_admin', confirm: true, body: a => ({ json: { role: a.invite_role ?? 'member', ...only(a, ['email', 'days']) } }), summary: a => `生成一个加入本机构的邀请链接（角色：${a.invite_role === 'admin' ? '机构管理员' : '成员'}${a.email ? `，限 ${a.email}` : ''}）` },
      invite_user: { method: 'POST', path: () => '/api/tenant/invites', role: 'tenant_admin', confirm: true, body: a => ({ json: { username: a.username, role: a.invite_role ?? 'member', ...only(a, ['days']) } }), summary: a => `邀请平台账户「${a.username}」加入本机构（角色：${a.invite_role === 'admin' ? '机构管理员' : '成员'}；对方接受后加入）` },
      remove_member: { method: 'DELETE', path: a => `/api/tenant/members/${enc(a.user_id)}`, role: 'tenant_admin', confirm: true, summary: a => `把成员 ${a.user_id} 移出本机构（回到他自己的个人空间；本院研究成员身份与科室归属去掉）` },
      revoke_invite: { method: 'DELETE', path: a => `/api/tenant/invites/${enc(a.code)}` },
      audit: { method: 'GET', path: a => `/api/tenant/audit${q({ actor: a.actor, action: a.filter_action, limit: a.limit })}` },
      colleagues: { method: 'GET', path: () => '/api/tenant/colleagues' },
      studies: { method: 'GET', path: () => '/api/tenant/studies' },
      handover: { method: 'POST', path: a => `/api/studies/${enc(a.study_id)}/handover`, role: 'tenant_admin', confirm: true, body: a => ({ json: { user_id: a.to_user_id } }), summary: a => `把研究 ${a.study_id} 的负责人交接给 ${a.to_user_id}（原负责人移出研究）` },
      departments: { method: 'GET', path: () => '/api/tenant/departments' },
      create_department: { method: 'POST', path: () => '/api/tenant/departments', body: a => ({ json: only(a, ['name']) }) },
      rename_department: { method: 'PATCH', path: a => `/api/tenant/departments/${enc(a.department_id)}`, body: a => ({ json: only(a, ['name']) }) },
      delete_department: { method: 'DELETE', path: a => `/api/tenant/departments/${enc(a.department_id)}`, role: 'tenant_admin', confirm: true, summary: a => `删除科室 ${a.department_id}（发给这个科室的家庭分享随之失效）` },
      set_department_members: { method: 'PUT', path: a => `/api/tenant/departments/${enc(a.department_id)}/members`, role: 'tenant_admin', confirm: true, body: a => ({ json: { user_ids: a.user_ids ?? [] } }), summary: a => `把科室 ${a.department_id} 的成员设为：${(a.user_ids as string[] | undefined)?.join('、') || '（清空）'}（科室成员能看到发给这个科室的家庭分享）` },
    },
  },
  {
    name: 'org_template',
    description: '机构幻灯片模板（机构管理员）：list；create / update（label、org_name、footer、description、base 骨架模板、colors 八色、preset=ahslyy 一键安徽省立医院配色）；delete（需确认）；set_logo 用工作区里的院徽文件 file_path（PNG/JPEG/SVG ≤1MB，需确认）；clear_logo（需确认）。使用模板用 deck_templates / doc_create / deck_edit apply_theme。',
    input: {
      action: z.enum(['list', 'create', 'update', 'delete', 'set_logo', 'clear_logo']), template_id: z.string().optional(),
      label: z.string().max(40).optional(), org_name: z.string().max(80).optional(), footer: z.string().max(80).optional(), description: z.string().max(200).optional(),
      base: z.string().optional(), colors: z.record(z.string()).optional(), fonts: z.record(z.string()).optional(), preset: z.enum(['ahslyy']).optional(), file_path: z.string().optional(), reason: reasonField,
    },
    actions: {
      list: { method: 'GET', path: () => '/api/tenant/templates' },
      create: { method: 'POST', path: () => '/api/tenant/templates', body: a => ({ json: only(a, ['label', 'org_name', 'footer', 'description', 'base', 'colors', 'fonts', 'preset']) }) },
      update: { method: 'PATCH', path: a => `/api/tenant/templates/${enc(a.template_id)}`, body: a => ({ json: only(a, ['label', 'org_name', 'footer', 'description', 'base', 'colors', 'fonts']) }) },
      delete: { method: 'DELETE', path: a => `/api/tenant/templates/${enc(a.template_id)}`, role: 'tenant_admin', confirm: true, summary: a => `删除机构幻灯片模板 ${a.template_id}（用过它的幻灯片会失去院徽）` },
      set_logo: { method: 'PUT', path: a => `/api/tenant/templates/${enc(a.template_id)}/logo`, role: 'tenant_admin', confirm: true, body: (a, file) => { const f = file(a.file_path); return { bytes: f.bytes, mime: f.mime } }, summary: a => `把工作区文件「${a.file_path}」设为机构模板 ${a.template_id} 的院徽（会出现在本机构所有用这套模板的幻灯片上）` },
      clear_logo: { method: 'DELETE', path: a => `/api/tenant/templates/${enc(a.template_id)}/logo`, role: 'tenant_admin', confirm: true, summary: a => `去掉机构模板 ${a.template_id} 的院徽` },
    },
  },
  {
    name: 'phr_share',
    description: '知家「分享给医生」（家人一侧，个人空间）：directory 可分享的医院 → 科室 → 医生；list 某位家人（patient_id）的分享、纳入情况；create 新建分享（tenant_id 医院、department_id 科室、可选 doctor_id、categories 类目 labs|reports|docs、since 起始日期、days 7|30|90、allow_import 是否允许纳入医院病历、display_name 给医生看的姓名）——把家庭数据交给医院属于对外披露，需用户确认；revoke 撤销（share_id）。查看记录用 patient_access_log。',
    input: {
      action: z.enum(['directory', 'list', 'create', 'revoke']), patient_id: z.string().optional(), share_id: z.string().optional(),
      tenant_id: z.string().optional(), department_id: z.string().optional(), doctor_id: z.string().optional(),
      categories: z.array(z.enum(['labs', 'reports', 'docs'])).optional(), since: z.string().optional().describe('YYYY-MM-DD'),
      days: z.number().int().optional(), allow_import: z.boolean().optional(), display_name: z.string().max(24).optional(), reason: reasonField,
    },
    actions: {
      directory: { method: 'GET', path: () => '/api/phr/directory' },
      list: { method: 'GET', path: a => `/api/phr/${enc(a.patient_id)}/shares` },
      create: {
        method: 'POST', path: a => `/api/phr/${enc(a.patient_id)}/shares`, confirm: true,
        body: a => ({ json: { ...only(a, ['tenant_id', 'department_id', 'doctor_id', 'days', 'allow_import', 'display_name']), scope: { categories: a.categories, since: a.since } } }),
        summary: a => `把家人 ${a.patient_id} 的档案（${(a.categories as string[] | undefined)?.join('、') || '化验、报告原件、简报与健康档案'}${a.since ? `，${a.since} 之后` : ''}）分享给医院 ${a.tenant_id} 的科室 ${a.department_id}${a.doctor_id ? `（医生 ${a.doctor_id}）` : ''}，${a.days ?? 30} 天有效${a.allow_import ? '，允许纳入医院病历' : ''}`,
        editable: a => ({ display_name: String(a.display_name ?? '') }),
      },
      revoke: { method: 'DELETE', path: a => `/api/phr/shares/${enc(a.share_id)}` },
    },
  },
  {
    name: 'platform_admin',
    description: '平台运营（只有平台运营账号能做）：tenants 机构列表；create_tenant 新建机构（name、admin_email；需确认）；set_tenant_status 停用（suspended）/ 启用（active）机构（需确认）；users 全部账号；update_user 改账号平台角色 user|admin 或停用（需确认）；logout_user 强制下线（需确认）；settings / update_settings 实例设置（memory_enabled=false 会删除所有人的记忆；需确认）；audit 全平台审计。重置密码不经 AI（AI 不经手密码）。',
    input: {
      action: z.enum(['tenants', 'create_tenant', 'set_tenant_status', 'users', 'update_user', 'logout_user', 'settings', 'update_settings', 'audit']),
      tenant_id: z.string().optional(), user_id: z.string().optional(), name: z.string().max(60).optional(), admin_email: z.string().max(120).optional(),
      status: z.enum(['active', 'disabled', 'suspended']).optional().describe('机构：active | suspended；账号：active | disabled'), role: z.enum(['user', 'admin']).optional(), memory_enabled: z.boolean().optional(),
      actor: z.string().optional(), filter_action: z.string().optional(), limit: z.number().int().min(1).max(500).optional(), reason: reasonField,
    },
    actions: {
      tenants: { method: 'GET', path: () => '/api/platform/tenants' },
      create_tenant: { method: 'POST', path: () => '/api/platform/tenants', role: 'operator', confirm: true, body: a => ({ json: only(a, ['name', 'admin_email']) }), summary: a => `新建机构「${a.name}」${a.admin_email ? `，管理员邀请发给 ${a.admin_email}` : ''}` },
      set_tenant_status: { method: 'PATCH', path: a => `/api/platform/tenants/${enc(a.tenant_id)}`, role: 'operator', confirm: true, body: a => ({ json: { status: a.status } }), summary: a => `把机构 ${a.tenant_id} 设为 ${a.status === 'active' ? '启用' : '停用（成员不能登录）'}` },
      users: { method: 'GET', path: () => '/api/admin/users' },
      update_user: { method: 'PATCH', path: a => `/api/admin/users/${enc(a.user_id)}`, role: 'operator', confirm: true, body: a => ({ json: only(a, ['role', 'status']) }), summary: a => `把账号 ${a.user_id} ${a.role ? `平台角色设为 ${a.role === 'admin' ? '平台运营' : '普通用户'}` : ''}${a.status ? (a.status === 'disabled' ? '停用' : '启用') : ''}` },
      logout_user: { method: 'POST', path: a => `/api/admin/users/${enc(a.user_id)}/logout`, role: 'operator', confirm: true, summary: a => `让账号 ${a.user_id} 在所有设备上下线` },
      settings: { method: 'GET', path: () => '/api/admin/settings' },
      update_settings: { method: 'PUT', path: () => '/api/admin/settings', role: 'operator', confirm: true, body: a => ({ json: only(a, ['memory_enabled']) }), summary: a => a.memory_enabled === false ? '在整个平台停用记忆，并删除所有用户的记忆（不可恢复）' : '在整个平台启用记忆' },
      audit: { method: 'GET', path: a => `/api/admin/audit${q({ actor: a.actor, action: a.filter_action, limit: a.limit })}` },
    },
  },
  {
    name: 'doc_manage',
    description: '文档管理：import 把工作区里的 docx / pptx 文件 file_path 导入为新文档（保留原格式）；rename / move_project（project_id 为空 = 移出项目）；duplicate 复制；trash 移到回收站（可恢复）；trash_list 回收站；restore 从回收站恢复；purge 彻底删除（不可恢复，需确认）；save_version 存一个版本；restore_version 恢复到版本 seq；revert_turn 撤销某一轮 AI 修改；export 导出 docx / pptx / md 到工作区（fonts=mac|win）。',
    input: {
      action: z.enum(['import', 'rename', 'move_project', 'duplicate', 'trash', 'trash_list', 'restore', 'purge', 'save_version', 'restore_version', 'revert_turn', 'export']),
      doc_id: z.string().optional(), title: z.string().max(200).optional(), project_id: z.string().nullable().optional(), seq: z.number().int().optional(), turn_id: z.string().optional(),
      format: z.enum(['docx', 'pptx', 'md']).optional(), fonts: z.enum(['mac', 'win']).optional(), file_path: z.string().optional(), reason: reasonField,
    },
    actions: {
      import: { method: 'POST', path: () => '/api/docs', body: (a, file) => ({ form: (a.project_id ? { project_id: String(a.project_id) } : {}) as Record<string, string>, file: file(a.file_path) }) },
      rename: { method: 'PATCH', path: a => `/api/docs/${enc(a.doc_id)}`, body: a => ({ json: only(a, ['title']) }) },
      move_project: { method: 'PATCH', path: a => `/api/docs/${enc(a.doc_id)}`, body: a => ({ json: { project_id: a.project_id ?? null } }) },
      duplicate: { method: 'POST', path: a => `/api/docs/${enc(a.doc_id)}/duplicate` },
      trash: { method: 'DELETE', path: a => `/api/docs/${enc(a.doc_id)}` },
      trash_list: { method: 'GET', path: () => '/api/trash' },
      restore: { method: 'POST', path: a => `/api/docs/${enc(a.doc_id)}/restore` },
      purge: { method: 'DELETE', path: a => `/api/docs/${enc(a.doc_id)}/purge`, confirm: true, probe: () => '/api/trash', summary: a => `彻底删除回收站里的文档 ${a.doc_id}（不可恢复）` },
      save_version: { method: 'POST', path: a => `/api/docs/${enc(a.doc_id)}/save` },
      restore_version: { method: 'POST', path: a => `/api/docs/${enc(a.doc_id)}/versions/${enc(a.seq)}/restore` },
      revert_turn: { method: 'POST', path: a => `/api/docs/${enc(a.doc_id)}/turns/${enc(a.turn_id)}/revert` },
      export: { method: 'GET', path: a => `/api/docs/${enc(a.doc_id)}/export.${a.format ?? 'docx'}${q({ fonts: a.fonts })}`, save: a => `exports/${a.doc_id}.${a.format ?? 'docx'}` },
    },
  },
  {
    name: 'project_manage',
    description: '文档项目（分组）：list / create(name) / rename(project_id, name) / delete(project_id；项目里的文档回到未分组，不删除)。',
    input: { action: z.enum(['list', 'create', 'rename', 'delete']), project_id: z.string().optional(), name: z.string().max(60).optional() },
    actions: {
      list: { method: 'GET', path: () => '/api/projects' },
      create: { method: 'POST', path: () => '/api/projects', body: a => ({ json: only(a, ['name']) }) },
      rename: { method: 'PATCH', path: a => `/api/projects/${enc(a.project_id)}`, body: a => ({ json: only(a, ['name']) }) },
      delete: { method: 'DELETE', path: a => `/api/projects/${enc(a.project_id)}` },
    },
  },
  {
    name: 'comment_manage',
    description: '评论：create 在 node_id 块上对 snippet 文字发起评论（text）；resolve / reopen 关闭或重开线程；delete 删除评论（不可恢复，需确认）。回复与处理评论仍用 comments_list / comment_reply / comment_resolve。',
    input: { action: z.enum(['create', 'resolve', 'reopen', 'delete']), doc_id: z.string(), comment_id: z.string().optional(), node_id: z.string().optional(), snippet: z.string().optional(), text: z.string().max(4000).optional(), reason: reasonField },
    actions: {
      create: { method: 'POST', path: a => `/api/docs/${enc(a.doc_id)}/comments`, body: a => ({ json: only(a, ['node_id', 'snippet', 'text']) }) },
      resolve: { method: 'POST', path: a => `/api/docs/${enc(a.doc_id)}/comments/${enc(a.comment_id)}/resolve` },
      reopen: { method: 'POST', path: a => `/api/docs/${enc(a.doc_id)}/comments/${enc(a.comment_id)}/reopen` },
      delete: { method: 'DELETE', path: a => `/api/docs/${enc(a.doc_id)}/comments/${enc(a.comment_id)}`, confirm: true, probe: a => `/api/docs/${enc(a.doc_id)}`, summary: a => `删除文档 ${a.doc_id} 里的评论 ${a.comment_id}（不可恢复）` },
    },
  },
  {
    name: 'dataset_manage',
    description: '数据集管理：upload 把工作区文件 file_path 上传为数据集（CSV / Excel / SAS / SPSS / Stata）；rename(name, labels)；resolve_phi 处理身份信息列（drop 删除的列、keep 确认不是身份信息的列）；delete 删除数据集（不可恢复，需确认）。看数据用 dataset_list / dataset_describe / dataset_open。',
    input: { action: z.enum(['upload', 'rename', 'resolve_phi', 'delete']), dataset_id: z.string().optional(), file_path: z.string().optional(), name: z.string().max(200).optional(), labels: z.record(z.string()).optional(), drop: z.array(z.string()).optional(), keep: z.array(z.string()).optional(), reason: reasonField },
    actions: {
      upload: { method: 'POST', path: () => '/api/datasets', body: (a, file) => ({ form: {}, file: file(a.file_path) }) },
      rename: { method: 'PATCH', path: a => `/api/datasets/${enc(a.dataset_id)}`, body: a => ({ json: only(a, ['name', 'labels']) }) },
      resolve_phi: { method: 'POST', path: a => `/api/datasets/${enc(a.dataset_id)}/phi`, body: a => ({ json: { drop: a.drop ?? [], keep: a.keep ?? [] } }) },
      delete: { method: 'DELETE', path: a => `/api/datasets/${enc(a.dataset_id)}`, confirm: true, probe: a => `/api/datasets/${enc(a.dataset_id)}`, summary: a => `删除数据集 ${a.dataset_id}（不可恢复；用它画过的图仍保留）` },
    },
  },
  {
    name: 'kb_manage',
    description: '参考资料库管理：list（project_id 筛选）；status 处理进度；upload 把工作区文件 file_path 上传进资料库（可带 project_id）；update 改名或归入项目；delete 删除资料（不可恢复，需确认）。检索与阅读用 kb_search / kb_read。',
    input: { action: z.enum(['list', 'status', 'upload', 'update', 'delete']), file_id: z.string().optional(), file_path: z.string().optional(), project_id: z.string().nullable().optional(), name: z.string().max(200).optional(), reason: reasonField },
    actions: {
      list: { method: 'GET', path: a => `/api/kb${a.project_id !== undefined ? q({ project: a.project_id ?? '' }) : ''}` },
      status: { method: 'GET', path: () => '/api/kb-status' },
      upload: { method: 'POST', path: () => '/api/kb', body: (a, file) => ({ form: (a.project_id ? { project_id: String(a.project_id) } : {}) as Record<string, string>, file: file(a.file_path) }) },
      update: { method: 'PATCH', path: a => `/api/kb/${enc(a.file_id)}`, body: a => ({ json: only(a, ['name', 'project_id']) }) },
      delete: { method: 'DELETE', path: a => `/api/kb/${enc(a.file_id)}`, confirm: true, probe: a => `/api/kb/${enc(a.file_id)}/text`, summary: a => `从资料库删除资料 ${a.file_id}（不可恢复）` },
    },
  },
  {
    name: 'memory_manage',
    description: '记忆管理（和记忆页一致）：list 全部记忆与待确认；events 一条记忆的历史；edit 改内容 / 类型；settings 看开关、pause / resume 暂停或恢复；export 导出；import 从工作区 JSON 文件 file_path 导入（同样过敏感内容拦截）；clear_all 清空全部记忆（不可恢复，需确认）。提议 / 忘记 / 检索 / 整理仍用 memory_propose / memory_forget / memory_search / memory_review；整理建议由用户采纳。',
    input: { action: z.enum(['list', 'events', 'edit', 'pause', 'resume', 'export', 'import', 'clear_all']), memory_id: z.string().optional(), content: z.string().max(500).optional(), kind: z.enum(['preference', 'fact', 'style', 'term']).optional(), file_path: z.string().optional(), reason: reasonField },
    actions: {
      list: { method: 'GET', path: () => '/api/memory' },
      events: { method: 'GET', path: a => `/api/memory/${enc(a.memory_id)}/events` },
      edit: { method: 'PATCH', path: a => `/api/memory/${enc(a.memory_id)}`, body: a => ({ json: only(a, ['content', 'kind']) }) },
      pause: { method: 'PUT', path: () => '/api/memory/settings', body: () => ({ json: { paused: true } }) },
      resume: { method: 'PUT', path: () => '/api/memory/settings', body: () => ({ json: { paused: false } }) },
      export: { method: 'GET', path: () => '/api/memory-export' },
      import: { method: 'POST', path: () => '/api/memory-import', body: (a, file) => ({ json: JSON.parse(new TextDecoder().decode(file(a.file_path).bytes)) }) },
      clear_all: { method: 'DELETE', path: () => '/api/memory', confirm: true, summary: () => '清空你的全部记忆（偏好、写法、术语、事实；不可恢复）' },
    },
  },
  {
    name: 'patient_admin',
    description: '患者的高权限操作：directory 本机构全部患者代号（紧急访问时选人；机构管理员）；break_glass 紧急访问一位不在你诊疗组的患者 24 小时（机构管理员，理由至少 10 个字，以用户本人名义承担并全程记录；需用户确认，用户可在确认卡上改理由）；delete 删除患者及其全部资料（不可恢复，需确认）。',
    input: { action: z.enum(['directory', 'break_glass', 'delete']), patient_id: z.string().optional(), reason: z.string().max(500).optional().describe('紧急访问的理由（≥10 字）或删除原因，显示在确认卡上') },
    actions: {
      directory: { method: 'GET', path: () => '/api/patients-directory' },
      break_glass: { method: 'POST', path: a => `/api/patients/${enc(a.patient_id)}/break-glass`, role: 'tenant_admin', confirm: true, body: a => ({ json: { reason: a.reason ?? '' } }), editable: a => ({ reason: String(a.reason ?? '') }), summary: a => `以你的名义紧急访问患者 ${a.patient_id}（24 小时，全程记录在访问日志）` },
      delete: { method: 'DELETE', path: a => `/api/patients/${enc(a.patient_id)}`, confirm: true, probe: a => `/api/patients/${enc(a.patient_id)}`, summary: a => `删除患者 ${a.patient_id} 及其全部报告、化验、关联（不可恢复）` },
    },
  },
  {
    name: 'study_admin',
    description: '研究项目的高权限操作：delete 删除研究（负责人；研究里的方案 / 论文 / 幻灯片进回收站，数据集保留；需确认）；transfer 把负责人转交给研究里的另一位成员 to_user_id（需确认）。成员管理用 study_members。',
    input: { action: z.enum(['delete', 'transfer']), study_id: z.string(), to_user_id: z.string().optional(), reason: reasonField },
    actions: {
      delete: { method: 'DELETE', path: a => `/api/studies/${enc(a.study_id)}`, confirm: true, probe: a => `/api/studies/${enc(a.study_id)}`, summary: a => `删除研究 ${a.study_id}（研究里的文档进回收站，数据集保留）` },
      transfer: { method: 'POST', path: a => `/api/studies/${enc(a.study_id)}/transfer`, confirm: true, probe: a => `/api/studies/${enc(a.study_id)}`, body: a => ({ json: { user_id: a.to_user_id } }), summary: a => `把研究 ${a.study_id} 的负责人转交给 ${a.to_user_id}（你变成可编辑成员）` },
    },
  },
  {
    name: 'task_queue',
    description: '用户的 AI 任务队列：list 正在执行与排队中的任务；cancel 取消排队中的任务 job_id。',
    input: { action: z.enum(['list', 'cancel']), job_id: z.string().optional() },
    actions: {
      list: { method: 'GET', path: () => '/api/queue' },
      cancel: { method: 'POST', path: a => `/api/queue/${enc(a.job_id)}/cancel` },
    },
  },
  {
    name: 'asset_provenance',
    description: '分析图（资产）的来源：生成代码、所用数据集及版本。',
    input: { action: z.enum(['read']).default('read'), asset_id: z.string() },
    actions: { read: { method: 'GET', path: a => `/api/assets/${enc(a.asset_id)}/provenance` } },
  },
]

export interface AdminToolDeps {
  store: Store
  turns: TurnRegistry
  invoke?: Invoke
  workspaceDir: (userId: string) => string
  generation?: string
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const json = (value: unknown) => text(JSON.stringify(value, null, 2))
const fail = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  isError: true as const,
  content: [{ type: 'text' as const, text: JSON.stringify({ code, message, ...extra }, null, 2) }],
})
class ToolFail extends Error { constructor(readonly code: string, message: string) { super(message) } }

export function registerAdminTools(server: McpServer, deps: AdminToolDeps, userId: string, generation?: string): void {
  const { store } = deps
  const gen = generation ?? deps.generation
  /** 工作区里的文件（不能出工作区，≤20MB） */
  const file = (p: unknown): WorkspaceFile => {
    if (typeof p !== 'string' || !p) throw new ToolFail('missing_file', '需要 file_path（工作区里的文件）')
    const root = realpathSync(deps.workspaceDir(userId))
    let f: string
    try { f = realpathSync(isAbsolute(p) ? p : join(root, p)) } catch { throw new ToolFail('file_not_found', `工作区里没有 ${p}`) }
    const rel = relative(root, f)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new ToolFail('outside_workspace', '只能用工作区里的文件')
    if (statSync(f).size > 20 * 1024 * 1024) throw new ToolFail('too_large', '文件超过 20MB')
    return { bytes: new Uint8Array(readFileSync(f)), name: basename(f), mime: MIME[extname(f).toLowerCase()] ?? 'application/octet-stream' }
  }
  const roleOk = (role: Op['role']) => {
    const u = store.getUser(userId)
    if (!role || !u) return true
    return role === 'operator' ? u.role === 'admin' : u.tenant_role === 'admin'
  }
  const errorOf = (r: { status: number; json: unknown; text: string }) => {
    const j = (r.json ?? {}) as { error?: string; code?: string; message?: string }
    const code = j.code ?? (r.status === 404 ? 'not_found' : r.status === 403 ? 'forbidden' : r.status === 401 ? 'unauthorized' : `http_${r.status}`)
    return fail(code, j.error ?? j.message ?? (r.text.slice(0, 300) || `请求失败（${r.status}）`))
  }

  for (const spec of ADMIN_TOOLS) {
    server.registerTool(spec.name, { description: spec.description, inputSchema: spec.input }, async (args: Args) => {
      const op = spec.actions[args.action as string]
      if (!op) return fail('bad_action', `不支持的 action：${args.action}`)
      if (!deps.invoke) return fail('unavailable', '平台没有接通管理接口')
      try {
        if (op.confirm) {
          if (!roleOk(op.role)) return fail('forbidden', op.role === 'operator' ? '只有平台运营能做这件事（AI 的权限与用户本人一致）' : '只有机构管理员能做这件事（AI 的权限与用户本人一致）')
          if (op.probe) {
            const r = await deps.invoke(userId, 'GET', op.probe(args))
            if (!r.ok) return errorOf(r)
          }
          const body = op.body?.(args, file)
          const stored = !body ? null : 'json' in body ? { json: body.json } : 'bytes' in body ? { bytes_b64: Buffer.from(body.bytes).toString('base64'), mime: body.mime }
            : { form: body.form, ...(body.file ? { file: { b64: Buffer.from(body.file.bytes).toString('base64'), name: body.file.name, mime: body.file.mime } } : {}) }
          const turn = deps.turns.active(userId, gen)
          const row = store.addPendingAction({
            user_id: userId, tool: spec.name, action: args.action, method: op.method, path: op.path(args), body: stored ? JSON.stringify(stored) : null,
            summary: op.summary?.(args) ?? `${spec.name}.${args.action}`, reason: typeof args.reason === 'string' ? args.reason : null,
            editable: op.editable ? JSON.stringify(op.editable(args)) : null, doc_id: turn?.docId ?? null, turn_id: turn?.turnId ?? null,
          })
          deps.turns.notify(userId, { type: 'action', action: { id: row.id, tool: row.tool, action: row.action, summary: row.summary, reason: row.reason, editable: op.editable ? op.editable(args) : null, status: 'pending', created_at: row.created_at } }, gen)
          return json({ status: 'pending_confirmation', action_id: row.id, summary: row.summary, message: '这是高风险操作，已在对话里给用户生成确认卡；用户确认后平台才会执行。向用户说明为什么要做，然后等待，不要重复提交。之后用 action_status 查结果。' })
        }
        const r = await deps.invoke(userId, op.method, op.path(args), op.body?.(args, file))
        if (!r.ok) return errorOf(r)
        if (op.save) {
          const rel = op.save(args)
          const out = join(deps.workspaceDir(userId), rel)
          // 隔离模式下 dsh 以该用户专属 uid 运行：目录与文件要让它能读（与 data/、.datasets/ 一致）
          const dir = join(out, '..')
          mkdirSync(dir, { recursive: true })
          chmodSync(dir, 0o2777)
          writeFileSync(out, r.bytes)
          chmodSync(out, 0o644)
          return json({ saved: rel, bytes: r.bytes.byteLength, message: `已导出到工作区 ${rel}` })
        }
        return json(r.json ?? (r.text || { ok: true }))
      } catch (err) {
        if (err instanceof ToolFail) return fail(err.code, err.message)
        if (err instanceof SyntaxError) return fail('bad_file', '文件不是有效的 JSON')
        throw err
      }
    })
  }

  server.registerTool('action_status', {
    description: '查 AI 发起、等用户确认的操作：给 action_id 查这一条（pending 待确认 / done 已执行 / failed 执行失败 / rejected 用户拒绝 / expired 超过 24 小时）；不给则列出最近的。AI 不能确认或拒绝操作。',
    inputSchema: { action_id: z.string().optional() },
  }, async ({ action_id }) => {
    store.expirePendingActions(24 * 3600_000)
    const view = (a: NonNullable<ReturnType<Store['getPendingAction']>>) => ({ action_id: a.id, tool: a.tool, action: a.action, summary: a.summary, status: a.status, result: a.result ? JSON.parse(a.result) as unknown : null, created_at: a.created_at, decided_at: a.decided_at })
    if (action_id) {
      const a = store.getPendingAction(action_id)
      if (!a || a.user_id !== userId) return fail('not_found', '没有这条待确认操作')
      return json(view(a))
    }
    return json(store.listPendingActions(userId).slice(0, 20).map(view))
  })
}
