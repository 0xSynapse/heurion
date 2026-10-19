import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store/db.ts'
import { HarnessEvolutionService } from '../src/harness/evolve-harness.ts'
import { HarnessPool, PROFILE_PATCH } from '../src/harness/pool.ts'
import type { Config } from '../src/config.ts'

describe('Layer 3: Dynamic Profile Overlay & Strategy Evolution', () => {
  it('不足 3 条信号且未指定 force 时跳过演进', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-test-'))
    try {
      const store = new Store(join(dir, 'test.db'))
      const service = new HarnessEvolutionService(store, async () => '{}')
      const res = await service.evolve({ force: false })
      expect(res).toEqual({ skipped: 'insufficient_signals' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('分析执行失败并生成符合 dsh 规范的动态 YAML 补丁', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-test-'))
    try {
      const store = new Store(join(dir, 'test.db'))
      // 记录 3 次守卫拦截
      store.addExecutionSignal({ owner: 'system', doc_id: 'd1', turn_id: 't1', kind: 'guard_reject', code: 'conflict_user_edited', detail: '{}' })
      store.addExecutionSignal({ owner: 'system', doc_id: 'd1', turn_id: 't2', kind: 'guard_reject', code: 'conflict_user_edited', detail: '{}' })
      store.addExecutionSignal({ owner: 'system', doc_id: 'd1', turn_id: 't3', kind: 'guard_reject', code: 'citation_not_registered', detail: '{}' })

      const mockComplete = async (_sys: string, user: string) => {
        expect(user).toContain('conflict_user_edited')
        return JSON.stringify({
          summary: '针对用户编辑冲突与引用拦截自适应加固指令',
          rules: [
            '遇到 conflict_user_edited 时必须调用 doc_validate 预检',
            '遇到 citation_not_registered 时强制先调用 insert_citation',
          ],
        })
      }

      const service = new HarnessEvolutionService(store, mockComplete)
      const res = await service.evolve({ force: true })

      if ('skipped' in res) throw new Error('should not skip')
      expect(res.summary).toContain('自适应加固指令')
      expect(res.rules).toHaveLength(2)
      expect(res.overlayYaml).toContain('system-prompt')
      expect(res.overlayYaml).toContain('Self-Improvement Execution Directives')
      expect(res.overlayYaml).toContain('doc_validate')

      // 已落盘到平台设置
      expect(service.currentOverlay()).toBe(res.overlayYaml)

      // reset 可回退重置
      service.reset()
      expect(service.currentOverlay()).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('HarnessPool 动态加载演进后的 Profile 补丁', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-test-'))
    try {
      const dshHome = join(dir, 'dsh-home')
      const mockConfig = {
        workspacesDir: join(dir, 'ws'),
        dshHomesDir: join(dir, 'homes'),
        dshHome,
        sandbox: false,
      } as unknown as Config

      let dynamicYaml: string | null = null
      const pool = new HarnessPool(mockConfig, undefined, () => dynamicYaml)

      // 1. 无演进补丁时：只返回基础 PROFILE_PATCH
      const basePatches = pool.getPatches(dshHome)
      expect(basePatches).toEqual([PROFILE_PATCH])

      // 2. 演进出动态补丁时：自动写入 dshHome 并挂载为第二层补丁
      dynamicYaml = '- id: system-prompt\n  config:\n    personaSuffix: test-overlay'
      const patchesWithOverlay = pool.getPatches(dshHome)
      expect(patchesWithOverlay).toHaveLength(2)
      expect(patchesWithOverlay[0]).toBe(PROFILE_PATCH)
      expect(patchesWithOverlay[1]).toBe(join(dshHome, 'evolved.cordis.yml'))

      // 验证文件真实存在且内容一致
      const written = readFileSync(patchesWithOverlay[1]!, 'utf8')
      expect(written).toBe(dynamicYaml)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
