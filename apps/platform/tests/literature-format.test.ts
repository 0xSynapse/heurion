import { fullTitle } from '../src/literature/crossref.ts'
import { describe, expect, it } from 'vitest'
import { formatAma, formatApa, formatCitation, formatGbt7714, formatVancouver } from '../src/literature/format.ts'
import type { Article } from '../src/literature/types.ts'

describe('文献引用格式化引擎（M3）', () => {
  const sampleArticle: Article = {
    pmid: '38123456',
    doi: '10.1056/nejmoa2301234',
    title: 'Tirzepatide once weekly for the treatment of obesity in adolescents.',
    authors: [
      'Armstrong SC',
      'Biro FM',
      'Dietz WH',
      'Kelly AS',
      'Michalsky MP',
      'Sabin MA',
      'Yanovski JA',
    ],
    journal: 'N Engl J Med',
    year: '2024',
    volume: '390',
    issue: '4',
    pages: '315-325',
  }

  const shortArticle: Article = {
    pmid: '12345678',
    doi: '10.1016/j.cell.2023.01.001',
    title: 'Mechanisms of cellular senescence in human tissues.',
    authors: ['Zhang W', 'Li Y'],
    journal: 'Cell',
    year: '2023',
    volume: '186',
    issue: '2',
    pages: '400-415',
  }

  const chineseArticle: Article = {
    pmid: null,
    doi: '10.3760/cma.j.cn112137-20230101-00001',
    title: '中国成人2型糖尿病胰岛素早期治疗指南',
    authors: ['中华医学会内分泌学分会', '李小英', '母义明', '周智广'],
    journal: '中华内分泌代谢杂志',
    year: '2023',
    volume: '39',
    issue: '6',
    pages: '450-462',
  }

  it('formatAma: 超过6位作者显示前3位 + et al', () => {
    const formatted = formatAma(sampleArticle)
    expect(formatted).toBe(
      'Armstrong SC, Biro FM, Dietz WH, et al. Tirzepatide once weekly for the treatment of obesity in adolescents. N Engl J Med. 2024;390(4):315-325. doi:10.1056/nejmoa2301234'
    )
  })

  it('formatVancouver: 超过6位作者显示前6位 + et al', () => {
    const formatted = formatVancouver(sampleArticle)
    expect(formatted).toBe(
      'Armstrong SC, Biro FM, Dietz WH, Kelly AS, Michalsky MP, Sabin MA, et al. Tirzepatide once weekly for the treatment of obesity in adolescents. N Engl J Med. 2024;390(4):315-325. doi:10.1056/nejmoa2301234'
    )
  })

  it('formatVancouver: 6位以下作者全部列出', () => {
    const formatted = formatVancouver(shortArticle)
    expect(formatted).toBe(
      'Zhang W, Li Y. Mechanisms of cellular senescence in human tissues. Cell. 2023;186(2):400-415. doi:10.1016/j.cell.2023.01.001'
    )
  })

  it('formatApa: 2位作者用 & 拼接，带年份括号与标准结构', () => {
    const formatted = formatApa(shortArticle)
    expect(formatted).toBe(
      'Zhang W & Li Y. (2023). Mechanisms of cellular senescence in human tissues. Cell, 186(2), 400-415. https://doi.org/10.1016/j.cell.2023.01.001'
    )
  })

  it('formatGbt7714: 英文文献超过3位作者用 et al.，中文文献用 等', () => {
    const formattedEng = formatGbt7714(sampleArticle)
    expect(formattedEng).toBe(
      'Armstrong SC, Biro FM, Dietz WH, et al. Tirzepatide once weekly for the treatment of obesity in adolescents[J]. N Engl J Med, 2024, 390(4): 315-325. DOI: 10.1056/nejmoa2301234.'
    )

    const formattedCn = formatGbt7714(chineseArticle)
    expect(formattedCn).toBe(
      '中华医学会内分泌学分会, 李小英, 母义明, 等. 中国成人2型糖尿病胰岛素早期治疗指南[J]. 中华内分泌代谢杂志, 2023, 39(6): 450-462. DOI: 10.3760/cma.j.cn112137-20230101-00001.'
    )
  })

  it('formatCitation: 根据传入 style 智能分发', () => {
    expect(formatCitation(sampleArticle, 'vancouver')).toBe(formatVancouver(sampleArticle))
    expect(formatCitation(sampleArticle, 'apa')).toBe(formatApa(sampleArticle))
    expect(formatCitation(sampleArticle, 'gbt7714')).toBe(formatGbt7714(sampleArticle))
    expect(formatCitation(sampleArticle, 'ama')).toBe(formatAma(sampleArticle))
  })
})

describe('Crossref 题目带副标题', () => {
  it('主题目 + 副标题拼成完整题目；主题目已含副标题时不重复（v2 1a：条目缺副标题被判为与文献不符）', () => {
    expect(fullTitle('Chemoradiotherapy of Locally Advanced Esophageal Cancer', 'Long-term Follow-up of a Prospective Randomized Trial (RTOG 85-01)'))
      .toBe('Chemoradiotherapy of Locally Advanced Esophageal Cancer: Long-term Follow-up of a Prospective Randomized Trial (RTOG 85-01)')
    expect(fullTitle('Global cancer statistics 2020: GLOBOCAN estimates', 'GLOBOCAN estimates')).toBe('Global cancer statistics 2020: GLOBOCAN estimates')
    expect(fullTitle('Trial A:', 'the results')).toBe('Trial A: the results')
    expect(fullTitle('Trial B', '')).toBe('Trial B')
  })
})
