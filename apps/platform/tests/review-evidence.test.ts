import { describe, expect, it } from 'vitest'
import { normForMatch, numberKey, parseVerdicts, quotedIn, VERIFY_SYSTEM } from '../src/claims/review-evidence.ts'
import { ClaimService } from '../src/claims/service.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'

// 深度审稿：模型意见必须带原文证据并核实、每章节最多 3 条、跨章节去重

describe('引文核实', () => {
  const corpus = normForMatch('We enrolled 412 patients\\* (Table 1).\n| Male, n (%) | 50 (40%) |\nHR 0.72 (95% CI 0.60–0.86)')

  it('规范化后是子串即可：Markdown 转义、表格竖线、短横与空白写法不同不影响', () => {
    expect(quotedIn('We enrolled 412 patients* (Table 1)', corpus)).toBe(true)
    expect(quotedIn('Male, n (%) 50 (40%)', corpus)).toBe(true)
    expect(quotedIn('HR 0.72 (95% CI 0.60-0.86)', corpus)).toBe(true)
  })

  it('编造或改了数字的引文对不上；太短的不算', () => {
    expect(quotedIn('We enrolled 421 patients', corpus)).toBe(false)
    expect(quotedIn('abc', corpus)).toBe(false)
  })

  it('长引文漏一两个字符仍算（按 8 字片段九成以上命中）', () => {
    const long = normForMatch('The primary outcome improved in the intervention group compared with controls over 26 weeks of follow-up.')
    expect(quotedIn('The primary outcome improved in the intervention group compared with control over 26 weeks of follow-up.', long)).toBe(true)
  })

  it('数字组合：同一处矛盾的不同说法得到同样的键', () => {
    expect(numberKey(['412 patients', 'abstract says 421'])).toBe(numberKey(['421 vs 412']))
    expect(numberKey(['no numbers'])).toBe('')
  })
})

describe('模型审稿意见的过滤', () => {
  const MD = `# 稿件\n\n## Abstract\n\nIn this trial of 412 patients, the primary outcome occurred in 25% of participants.\n\n## Methods\n\nContinuous variables are presented as mean ± SD and compared with t tests.\n\n## Results\n\nWe enrolled 412 patients.\n\nThe primary outcome occurred in 50 of 200 patients (40%).\n\nMedian age was 62 years (IQR 55–70).\n\n## Discussion\n\nThe intervention reduced mortality.\n\nA total of 421 patients completed follow-up.\n`

  async function run(reply: (sys: string, user: string) => unknown[]) {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const row = docs.create({ owner: 'u', title: '稿件', markdown: MD })
    const claims = new ClaimService(docs, {} as PubMedClient)
    const complete = async (sys: string, user: string) => JSON.stringify(reply(sys, user))
    return claims.runFourStageDeepReview(row.id, { mode: 'heurion_evolved', owner: 'u', complete })
  }
  const issue = (sentence: string, evidence: string[] | undefined, severity = 'major', reason = '两处数字对不上') =>
    ({ node_id: 'x', sentence, ...(evidence ? { evidence } : {}), category: 'internal_inconsistency', severity, reason, suggestion: '核对' })

  it('原句不在稿件里、或拿不出证据的意见不报', async () => {
    const r = await run(sys => sys.includes('「Results」') ? [
      issue('We enrolled 4120 patients.', ['A total of 421 patients completed follow-up.']),
      issue('We enrolled 412 patients.', undefined),
      issue('We enrolled 412 patients.', ['some sentence that is not in the paper at all']),
      issue('The primary outcome occurred in 50 of 200 patients (40%).', ['50 of 200 patients'], 'critical', '50/200 = 25%，不是 40%'),
    ] : [])
    const llm = r.stage4_deduplicated_comments.filter(c => c.source_pass === 'llm_stage3')
    expect(llm.map(c => c.reason)).toEqual(['50/200 = 25%，不是 40%'])
    expect(llm[0]!.evidence).toEqual(['50 of 200 patients'])
  })

  it('每个章节最多 3 条，按严重程度留；同一处矛盾在几个章节里重复报的合并成一条', async () => {
    const r = await run(sys => {
      if (sys.includes('「Results」')) {
        return [
          issue('Median age was 62 years (IQR 55–70).', ['presented as mean ± SD'], 'minor', 'A'),
          issue('Median age was 62 years (IQR 55–70).', ['compared with t tests'], 'minor', 'B'),
          issue('We enrolled 412 patients.', ['A total of 421 patients completed follow-up.'], 'critical', 'C'),
          issue('The primary outcome occurred in 50 of 200 patients (40%).', ['50 of 200 patients'], 'major', 'D'),
        ]
      }
      if (sys.includes('「Discussion」')) return [issue('A total of 421 patients completed follow-up.', ['We enrolled 412 patients.'], 'critical', 'E')]
      return []
    })
    const reasons = r.stage4_deduplicated_comments.filter(c => c.source_pass === 'llm_stage3').map(c => c.reason)
    // Results 留 C、D 与一条 minor（第 4 条被截掉）；Discussion 的 E 与 C 是同一处 412 / 421 矛盾，合并
    expect(reasons).toContain('C')
    expect(reasons).toContain('D')
    expect(reasons.filter(x => x === 'A' || x === 'B')).toHaveLength(1)
    expect(reasons).not.toContain('E')
  })

  it('全文复核：判为不成立的不报，判为成立或不确定的保留；复核调用失败时全部保留', async () => {
    const twoIssues = [
      issue('We enrolled 412 patients.', ['A total of 421 patients completed follow-up.'], 'critical', '412 与 421 不一致'),
      issue('The primary outcome occurred in 50 of 200 patients (40%).', ['50 of 200 patients'], 'major', '50/200 不是 40%'),
    ]
    const r = await run((sys, user) => {
      if (sys === VERIFY_SYSTEM) {
        expect(user).toContain('【论文全文】')
        expect(user).toContain('1. [critical] 原句：We enrolled 412 patients.')
        return [{ id: 1, verdict: 'unclear', why: '' }, { id: 2, verdict: 'rejected', why: '原文一致' }]
      }
      return sys.includes('「Results」') ? twoIssues : []
    })
    expect(r.stage4_deduplicated_comments.filter(c => c.source_pass === 'llm_stage3').map(c => c.reason)).toEqual(['412 与 421 不一致'])
    // 复核失败（返回不是 JSON）：照常报出
    const r2 = await run(sys => (sys === VERIFY_SYSTEM ? ('oops' as unknown as unknown[]) : sys.includes('「Results」') ? twoIssues : []))
    expect(r2.stage4_deduplicated_comments.filter(c => c.source_pass === 'llm_stage3')).toHaveLength(2)
  })

  it('复核结果解析：只认编号与三种判定', () => {
    expect([...parseVerdicts('```json\n[{"id":1,"verdict":"rejected"},{"id":"2","verdict":"holds"},{"id":3,"verdict":"maybe"}]\n```')]).toEqual([[1, 'rejected'], [2, 'holds']])
    expect(parseVerdicts('no json').size).toBe(0)
  })

  it('表格「n (%)」格子算得对、只是没写 % 号时不报；算不对的照报，不同的格分别报', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const md = `# 稿件\n\n## Results\n\nTable 1. Baseline\n\n| Characteristic | Group A N = 40 | Group B N = 20 |\n|---|---|---|\n| Medication use (n, [%]) | | |\n| Statins | 10 (25) | 0 (0) |\n| Anti-hypertensives | 4 (10) | 1 (5) |\n| Diabetes | 9 (30) | 7 (50) |\n`
    const row = docs.create({ owner: 'u', title: '稿件', markdown: md })
    const r = await new ClaimService(docs, {} as PubMedClient).runFourStageDeepReview(row.id, { mode: 'heurion_evolved', owner: 'u' })
    const cells = r.stage4_deduplicated_comments.filter(c => c.subtype === 'table_cell_percentage_arithmetic_error').map(c => c.snippet).sort()
    // 9/40 = 22.5% ≠ 30%，7/20 = 35% ≠ 50%；其余都算得对
    expect(cells).toEqual(['7 (50)', '9 (30)'])
  })

  it('同一张表上有规则意见时，模型对别的格子 / 别的问题的意见照常保留；说的是同一格才让位', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const md = `# 稿件\n\n## Results\n\nTable 1. Baseline\n\n| Characteristic | Group A N = 40 |\n|---|---|\n| Statins | 9 (30) |\n| Maculopathy | 2 (20) |\n| Age, mean (IQR) | 62 (55, 70) |\n`
    const row = docs.create({ owner: 'u', title: '稿件', markdown: md })
    let tableId = ''
    docs.get(row.id).descendants(n => { if (n.type.name === 'table') tableId = n.attrs.id as string; return !tableId })
    const onTable = (x: ReturnType<typeof issue>) => ({ ...x, node_id: tableId })
    const complete = async (sys: string) => sys === VERIFY_SYSTEM ? '[]' : sys.includes('「Results」') ? JSON.stringify([
      onTable(issue('| Statins | 9 (30) |', ['9 (30)'], 'major', '9 (30) 算不对')),
      onTable(issue('| Age, mean (IQR) | 62 (55, 70) |', ['Age, mean (IQR)'], 'major', '均值不应配 IQR')),
    ]) : '[]'
    const r = await new ClaimService(docs, {} as PubMedClient).runFourStageDeepReview(row.id, { mode: 'heurion_evolved', owner: 'u', complete })
    const llm = r.stage4_deduplicated_comments.filter(c => c.source_pass === 'llm_stage3').map(c => c.reason)
    expect(llm).toEqual(['均值不应配 IQR'])
  })

  it('提示词要求逐字引用原句与证据、不报主观意见', async () => {
    const prompts: string[] = []
    await run(sys => { prompts.push(sys); return [] })
    expect(prompts.some(p => p.includes('evidence') && p.includes('不要报告') && p.includes('宁缺毋滥'))).toBe(true)
  })

  it('各章节附上摘要作对照：摘要与正文不一致时，引用摘要原文作证据的意见能通过核实', async () => {
    const payloads: Array<[string, string]> = []
    const r = await run((sys, user) => {
      payloads.push([sys, user])
      return sys.includes('「Results」') ? [issue('The primary outcome occurred in 50 of 200 patients (40%).', ['the primary outcome occurred in 25% of participants'], 'critical', '正文 40% 与摘要 25% 不一致')] : []
    })
    const results = payloads.find(([s]) => s.includes('「Results」'))![1]
    expect(results).toContain('【摘要')
    expect(results).toContain('In this trial of 412 patients')
    // 摘要自己那一章不再附摘要
    expect(payloads.find(([s]) => s.includes('「Abstract」'))![1]).not.toContain('【摘要')
    expect(r.stage4_deduplicated_comments.some(c => c.reason === '正文 40% 与摘要 25% 不一致')).toBe(true)
  })
})
