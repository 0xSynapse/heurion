import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chmodIfOwned } from '../src/mcp/admin-tools.ts'

describe('导出到工作区的权限', () => {
  it('自己建的目录照常改权限，让隔离 uid 能读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heurion-perm-'))
    try {
      chmodIfOwned(dir, 0o2777)
      expect(statSync(dir).mode & 0o7777).toBe(0o2777)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('别的 uid 拥有的目录（如 AI 自己建的 exports/）不改权限、不抛 EPERM', () => {
    // 以 root 拥有的系统目录代替隔离 uid 建的目录；以 root 运行测试时跳过
    if (process.getuid?.() === 0) return
    expect(() => chmodIfOwned('/usr/bin', 0o2777)).not.toThrow()
  })
})
