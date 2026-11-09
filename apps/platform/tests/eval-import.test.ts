import { describe, expect, it } from 'vitest'
import { regressions, summarize, type PaperResult } from '../scripts/eval-import.ts'

const paper = (over: Partial<PaperResult> = {}): PaperResult => ({
  id: 'P', ok: true, error: null, seconds: 1, numbers: 100, missingNumbers: 0, extraNumbers: 0, missingWordPct: 0,
  tablesSource: 2, tablesConverted: 2, tablesDimsOk: 2, cellExact: 100, cellRecall: 100, spanCells: 0, spanHit: 0, spanExtra: 0, headingsMissing: 0,
  titleOk: true, figSource: 0, figCaptioned: 0, figImages: 0, figUncaptioned: 0, headingsExtra: 0, headingLevelWrong: 0, paraTotal: 0, paraBroken: 0,
  deletedLeaked: false, instrLeaked: false, ...over,
})

describe('导入质量评测：汇总与基线对比', () => {
  it('汇总：失败的论文不计入指标；单元格比例只在有表格的论文间平均', () => {
    const s = summarize([
      paper({ id: 'A', missingNumbers: 3, cellExact: 80, cellRecall: 90 }),
      paper({ id: 'B', tablesSource: 0, tablesDimsOk: 0, cellExact: null, cellRecall: null, deletedLeaked: true }),
      { ...paper({ id: 'C' }), ok: false, error: '退回了 poppler', missingNumbers: 999 },
    ])
    expect(s).toMatchObject({ papers: 3, failed: 1, missingNumbers: 3, cellExact: 80, cellRecall: 90, deletedLeaked: 1, tablesSource: 2 })
  })

  it('基线对比：容差内不报；变差超过容差、失败篇数或泄漏增加就报', () => {
    const base = summarize([paper({ missingNumbers: 100, cellExact: 70 })])
    expect(regressions(summarize([paper({ missingNumbers: 102, cellExact: 69.5 })]), base)).toEqual([])
    expect(regressions(summarize([paper({ missingNumbers: 110, cellExact: 65 })]), base)).toEqual(['缺失数字 100 → 110', '单元格位置精确率 70 → 65'])
    expect(regressions(summarize([paper({ missingNumbers: 100, cellExact: 70, instrLeaked: true })]), base)).toEqual(['域指令泄漏 0 → 1'])
    const withFail = summarize([paper({ missingNumbers: 100, cellExact: 70 }), { ...paper(), ok: false, error: 'x' }])
    expect(regressions(withFail, base)).toEqual(['失败篇数 0 → 1'])
  })

  it('合并单元格：召回率按覆盖格数汇总；召回下降或多出覆盖格要报', () => {
    const base = summarize([paper({ spanCells: 10, spanHit: 9 }), paper({ spanCells: 10, spanHit: 9 })])
    expect(base).toMatchObject({ spanCells: 20, spanRecall: 90, spanExtra: 0 })
    expect(summarize([paper()]).spanRecall).toBeNull()
    expect(regressions(summarize([paper({ spanCells: 10, spanHit: 5, spanExtra: 3 }), paper({ spanCells: 10, spanHit: 5 })]), base))
      .toEqual(['多出的合并覆盖格 0 → 3', '合并单元格召回率 90 → 50'])
  })
})
