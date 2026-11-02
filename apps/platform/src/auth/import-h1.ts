import { DatabaseSync } from 'node:sqlite'
import type { Store, UserRow } from '../store/db.ts'

/**
 * 1.0 账户导入：从 1.0 的 SQLite（Prisma `users` 表）导入用户名、显示名、
 * bcrypt 密码哈希（与平台同算法，原密码可直接登录）、角色、停用状态。只读打开 1.0 的库；按 1.0 用户 id 幂等。
 * 跳过：已软删除、没有密码（无法登录）、用户名不合法；平台里已有同名用户（不是本脚本导入的）报告冲突，不覆盖。
 */

export interface ImportReport {
  imported: Array<{ username: string; role: UserRow['role']; status: UserRow['status'] }>
  already: string[]
  skipped: Array<{ username: string; reason: string }>
  conflicts: string[]
}

interface H1User {
  id: string
  username: string | null
  display_name: string
  password_hash: string | null
  role: string | null
  status: string | null
  is_admin: number | null
  disabled_at: string | null
  deleted_at: string | null
  email: string | null
  email_verified: number | null
}

/**
 * 1.0 的登录名原样保留（1.0 没有用户名时用显示名登录，常带空格），只排除控制字符与首尾空白；
 * 平台新注册的用户名规则更严（见 accounts.ts）。
 */
const USERNAME = /^(?!\s)[\p{L}\p{N}\p{P}\p{S} ]{1,64}(?<!\s)$/u

export function importH1Users(h1Path: string, store: Store, apply: boolean): ImportReport {
  const h1 = new DatabaseSync(h1Path, { readOnly: true })
  // 1.0 各版本的 users 表列不同（#1136 之前没有 username，用显示名登录；更早的还缺 email 等）：只选存在的列，缺的当作 null
  const have = new Set((h1.prepare(`SELECT name FROM pragma_table_info('users')`).all() as Array<{ name: string }>).map(c => c.name))
  for (const required of ['id', 'display_name', 'password_hash']) {
    if (!have.has(required)) { h1.close(); throw new Error(`1.0 的 users 表缺少 ${required} 列，无法导入`) }
  }
  const wanted = ['id', 'username', 'display_name', 'password_hash', 'role', 'status', 'is_admin', 'disabled_at', 'deleted_at', 'email', 'email_verified']
  const cols = wanted.map(c => (have.has(c) ? c : `NULL AS ${c}`)).join(', ')
  const rows = h1.prepare(`SELECT ${cols} FROM users ORDER BY ${have.has('created_at') ? 'created_at' : 'rowid'}`).all() as unknown as H1User[]
  h1.close()
  const report: ImportReport = { imported: [], already: [], skipped: [], conflicts: [] }
  const importedIds = new Set(store.listUsers().map(u => u.imported_from).filter(Boolean))
  for (const r of rows) {
    const username = (r.username ?? r.display_name ?? '').trim().normalize('NFKC')
    if (r.deleted_at) { report.skipped.push({ username, reason: '已删除' }); continue }
    if (!r.password_hash) { report.skipped.push({ username, reason: '没有密码，无法登录' }); continue }
    if (!/^\$2[aby]\$/.test(r.password_hash)) { report.skipped.push({ username, reason: '密码哈希不是 bcrypt' }); continue }
    if (!USERNAME.test(username)) { report.skipped.push({ username, reason: '用户名不合法' }); continue }
    if (importedIds.has(r.id)) { report.already.push(username); continue }
    if (store.getUserByName(username)) { report.conflicts.push(username); continue }
    const role: UserRow['role'] = r.role === 'admin' || r.is_admin === 1 ? 'admin' : 'user'
    const status: UserRow['status'] = r.disabled_at || (r.status && !['approved', 'active'].includes(r.status)) ? 'disabled' : 'active'
    // 已验证的邮箱一起导入（找回密码用）；平台里已被别的账户用了就不导
    const email = r.email && r.email_verified ? r.email.trim().toLowerCase() : null
    const usableEmail = email && !store.getUserByEmail(email) ? email : null
    if (apply) store.createUser({ username, display_name: r.display_name || username, password_hash: r.password_hash, role, status, imported_from: r.id, email: usableEmail })
    report.imported.push({ username, role, status })
  }
  return report
}
