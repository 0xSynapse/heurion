import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DatasetService } from '../src/datasets/service.ts'
import { chmodIfOwned } from '../src/mcp/admin-tools.ts'
import { Store } from '../src/store/db.ts'

describe('导出与数据集工作区目录权限', () => {
  it('自己建的目录照常改权限，让隔离 uid 能读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heurion-perm-'))
    try {
      chmodIfOwned(dir, 0o2777)
      expect(statSync(dir).mode & 0o0777).toBe(0o0777)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('别的 uid 拥有的目录（如隔离环境已接管的 .datasets/ 或 AI 建的 exports/）不改权限、不抛 EPERM', () => {
    // 以 root 拥有的系统目录代替隔离 uid 建的目录；以 root 运行测试时跳过
    if (process.getuid?.() === 0) return
    expect(() => chmodIfOwned('/usr/bin', 0o2777)).not.toThrow()
  })

  it('拒绝符号链接路径，防止工作区内软链提权修改外部目录权限', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heurion-perm-sym-'))
    try {
      const target = join(dir, 'real')
      const link = join(dir, 'link')
      writeFileSync(target, 'x')
      symlinkSync(target, link)
      expect(() => chmodIfOwned(link, 0o644)).toThrow('不允许符号链接')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('上次解析失败的数据集（如 EPERM），重新上传同一文件时自动重新解析而不是卡在 failed', async () => {
    const store = new Store(':memory:')
    const dir = mkdtempSync(join(tmpdir(), 'heurion-ds-retry-'))
    let shouldFail = true
    const svc = new DatasetService(store, dir, async () => {
      if (shouldFail) throw new Error("EPERM: operation not permitted, chmod '/app/data/platform/workspaces/u1/.datasets'")
      const csvFile = join(dir, 'ok.csv')
      writeFileSync(csvFile, 'a,b\n1,2\n')
      return {
        csv: csvFile,
        cleanup: () => {},
        profile: { ok: true, rows: 1, truncated: false, columns: [{ name: 'a', type: 'numeric', missing: 0, unique: 1 }, { name: 'b', type: 'numeric', missing: 0, unique: 1 }] },
      }
    })
    try {
      const bytes = new TextEncoder().encode('a,b\n1,2\n')
      const first = svc.upload('u1', 'cohort.xlsx', bytes)
      await svc.idle()
      expect(svc.get('u1', first.dataset.id).status).toBe('failed')

      shouldFail = false
      const second = svc.upload('u1', 'cohort.xlsx', bytes)
      expect(second.duplicate).toBe(false)
      expect(second.dataset.id).toBe(first.dataset.id)
      await svc.idle()
      expect(svc.get('u1', first.dataset.id).status).toBe('ready')
      expect(svc.get('u1', first.dataset.id).error).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('Table 1 自动跳过 date / text / id 列并识别临床中文缺失值占位符（如“缺失”）', async () => {
    const store = new Store(':memory:')
    const dir = mkdtempSync(join(tmpdir(), 'heurion-ds-t1-'))
    const csvFile = join(dir, 'ok.csv')
    writeFileSync(csvFile, [
      'id,性别,中心剂量,供血动脉扩张,第一次治疗的时间,治疗后出血',
      '1,1,16.5,1,2018-01-01 00:00:00,0',
      '2,2,18.0,缺失,2019-05-02 00:00:00,0',
      '3,1,,0,0,1',
      '4,2,20.0,1,2020-03-10 00:00:00,1',
    ].join('\n'))
    const svc = new DatasetService(store, dir, async () => ({
      csv: csvFile,
      cleanup: () => {},
      profile: {
        ok: true,
        rows: 4,
        truncated: false,
        columns: [
          { name: 'id', type: 'numeric', missing: 0, unique: 4 },
          { name: '性别', type: 'categorical', missing: 0, unique: 2 },
          { name: '中心剂量', type: 'numeric', missing: 1, unique: 3 },
          { name: '供血动脉扩张', type: 'categorical', missing: 1, unique: 2 },
          { name: '第一次治疗的时间', type: 'date', missing: 0, unique: 4 },
          { name: '治疗后出血', type: 'categorical', missing: 0, unique: 2 },
        ],
      },
    }))
    try {
      const up = svc.upload('u1', 'avm.xlsx', new TextEncoder().encode('x'))
      await svc.idle()
      const t1 = svc.table1('u1', up.dataset.id, { group_col: '治疗后出血' })
      const vars = new Set(t1.rows.map(r => r.variable))
      expect(vars.has('id')).toBe(false)
      expect(vars.has('第一次治疗的时间')).toBe(false)
      expect(vars.has('治疗后出血')).toBe(false)
      expect(vars.has('中心剂量')).toBe(true)
      expect(vars.has('供血动脉扩张')).toBe(true)
      const levels = t1.rows.filter(r => r.variable === '供血动脉扩张' && r.is_category_level).map(r => r.level)
      expect(levels).toEqual(['0', '1'])
      const mainRow = t1.rows.find(r => r.variable === '供血动脉扩张' && r.indent === 0)
      expect(mainRow?.missing?.total).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('生存分析（KM / Cox）自动剔除 group_col 或协变量为空/“缺失”的样本，不生成空字符串分组', async () => {
    const store = new Store(':memory:')
    const dir = mkdtempSync(join(tmpdir(), 'heurion-ds-surv-'))
    const csvFile = join(dir, 'ok.csv')
    writeFileSync(csvFile, [
      '随访时间,治疗后出血,栓塞策略,最大径',
      '12,0,0,2.1',
      '24,1,0,3.5',
      '36,0,1,2.8',
      '48,1,1,4.0',
      '18,0,,2.5',
      '30,0,缺失,3.0',
    ].join('\n'))
    const svc = new DatasetService(store, dir, async () => ({
      csv: csvFile,
      cleanup: () => {},
      profile: {
        ok: true,
        rows: 6,
        truncated: false,
        columns: [
          { name: '随访时间', type: 'numeric', missing: 0, unique: 6 },
          { name: '治疗后出血', type: 'categorical', missing: 0, unique: 2 },
          { name: '栓塞策略', type: 'categorical', missing: 2, unique: 2 },
          { name: '最大径', type: 'numeric', missing: 0, unique: 6 },
        ],
      },
    }))
    try {
      const up = svc.upload('u1', 'surv.xlsx', new TextEncoder().encode('x'))
      await svc.idle()
      const res = svc.survival('u1', up.dataset.id, {
        time_col: '随访时间',
        event_col: '治疗后出血',
        group_col: '栓塞策略',
        covariates: ['最大径'],
      })
      expect(res.groups.map(g => g.group).sort()).toEqual(['0', '1'])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
