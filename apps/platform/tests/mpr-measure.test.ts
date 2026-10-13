import { describe, expect, it } from 'vitest'
import { caliperMeasure, formatMeasure, isPhysical, largeEnough, NO_SPACING_NOTE, planeSpacing, roiMeasure } from '../web/src/mpr-measure.ts'

describe('MPR 手动测量：没有体素间距时不用默认值换算', () => {
  it('优先切片像素间距，其次按平面取体素间距，都没有为 null', () => {
    expect(planeSpacing({ horizontal: 0.7, vertical: 0.8 }, null, 'axial')).toEqual({ h: 0.7, v: 0.8 })
    expect(planeSpacing(null, { dx: 0.6, dy: 0.6, dz: 2 }, 'coronal')).toEqual({ h: 0.6, v: 2 })
    expect(planeSpacing(null, { dx: 0.6, dy: 0.5, dz: 2 }, 'sagittal')).toEqual({ h: 0.5, v: 2 })
    expect(planeSpacing(undefined, null, 'axial')).toBeNull()
    expect(planeSpacing({ horizontal: 0 }, { dx: 0.6 }, 'axial')).toBeNull()
  })

  it('有间距时以 mm / mm² 计；没有间距时以像素计并提示，不出现 mm', () => {
    const sp = { h: 0.5, v: 0.5 }
    expect(caliperMeasure(30, 40, sp)).toEqual({ value: 25, unit: 'mm' })
    expect(roiMeasure(20, 10, sp)).toEqual({ value: 50, unit: 'mm²' })
    const px = caliperMeasure(30, 40, null)
    expect(px).toEqual({ value: 50, unit: 'px' })
    expect(isPhysical(px)).toBe(false)
    expect(formatMeasure(px)).toBe(`50.0 px（${NO_SPACING_NOTE}）`)
    expect(formatMeasure(px)).not.toContain('mm ')
    const area = roiMeasure(20, 10, null)
    expect(area).toEqual({ value: 200, unit: 'px²' })
    expect(formatMeasure(area)).toContain('px²')
    expect(formatMeasure(area)).not.toMatch(/mm²|cm²/)
    expect(formatMeasure(roiMeasure(20, 20, { h: 1, v: 1 }))).toBe('400.0 mm² (4.00 cm²)')
  })

  it('误触阈值按单位区分', () => {
    expect(largeEnough({ value: 1, unit: 'mm' })).toBe(false)
    expect(largeEnough({ value: 1.5, unit: 'mm' })).toBe(true)
    expect(largeEnough({ value: 1.5, unit: 'px' })).toBe(false)
    expect(largeEnough({ value: 4, unit: 'px²' })).toBe(true)
  })
})

import { ENGINE_LABEL, modelOptionTag } from '../web/src/imaging-engine.ts'

describe('影像模型类型如实显示', () => {
  it('rule_based 显示为规则算法，不再被当成深度学习；不可用的显示原因', () => {
    expect(ENGINE_LABEL).toEqual({ deep_learning: '深度学习', quantitative_ct: '定量 CT', rule_based: '规则算法' })
    expect(modelOptionTag({ engine_type: 'rule_based', is_ready: true })).toBe('[规则算法]')
    expect(modelOptionTag({ engine_type: 'deep_learning', is_ready: false, unavailable_reason: '本地权重未安装' })).toBe('[深度学习] (不可用：本地权重未安装)')
    expect(modelOptionTag({ engine_type: 'something_new' })).toBe('[类型未标注]')
  })
})
