import { describe, expect, it, vi } from 'vitest'
import { schema } from '../model/schema.ts'
import {
  classifySectionRole,
  classifyVerificationTier,
  extractClaims,
  extractTableSummaries,
} from './extract.ts'
import { SubagentService } from '../subagents/service.ts'

describe('Google PAT 4-Stage Citation & Claim Verification Pipeline', () => {
  it('Stage 1 & 2: classifies section roles, verification tiers, and filters self-study vs external unsourced claims', () => {
    expect(classifySectionRole('1. 引言与研究背景')).toBe('intro')
    expect(classifySectionRole('2. 资料与方法 (Materials and Methods)')).toBe('methods')
    expect(classifySectionRole('3. 研究结果与基线特征')).toBe('results')
    expect(classifySectionRole('4. 讨论与局限性')).toBe('discussion')

    expect(classifyVerificationTier('患者中位总生存期显著延长（HR = 0.62, 95% CI 0.48-0.81, P = 0.002）。', 1, 'results')).toBe('high')
    expect(classifyVerificationTier('免疫治疗在晚期肺癌中具有广泛应用前景。', 1, 'intro')).toBe('light')

    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { id: 'h_intro', level: 1 },
          content: [{ type: 'text', text: '1. 引言' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_intro_ext' },
          content: [
            { type: 'text', text: '晚期非小细胞肺癌患者的 5 年生存率仅为 18.5%。' },
          ],
        },
        {
          type: 'heading',
          attrs: { id: 'h_results', level: 1 },
          content: [{ type: 'text', text: '2. 研究结果' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_res_self' },
          content: [
            { type: 'text', text: '入组患者客观缓解率达到 64.2%（P = 0.003）。' },
          ],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_res_ext' },
          content: [
            { type: 'text', text: '既往研究报道二线单药化疗的客观缓解率仅为 21.0%。' },
          ],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_res_cited' },
          content: [
            { type: 'text', text: 'KEYNOTE-189 试验显示联合组客观缓解率为 47.6%' },
            { type: 'citation', attrs: { cite_id: 'c1' } },
            { type: 'text', text: '。' },
          ],
        },
      ],
    })

    const { claims, unsourced } = extractClaims(doc, new Map([['c1', 1]]))
    expect(claims).toHaveLength(1)
    expect(claims[0]?.section_role).toBe('results')
    expect(claims[0]?.section_title).toBe('2. 研究结果')
    expect(claims[0]?.verification_tier).toBe('high')

    // p_res_self 在「研究结果」章节且不含外部对比词 -> 自动识别为本研究自身结果，不报错缺出处
    // p_intro_ext 在「引言」章节 + p_res_ext 含「既往研究报道」 -> 识别为外部缺出处论断
    const unsourcedNodes = unsourced.map(u => u.node_id)
    expect(unsourcedNodes).toContain('p_intro_ext')
    expect(unsourcedNodes).toContain('p_res_ext')
    expect(unsourcedNodes).not.toContain('p_res_self')
  })

  it('Stage 1 & 3 Pass B: extracts table summaries and detects prose-vs-table sample size and percentage inconsistencies', async () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { id: 'h1', level: 1 },
          content: [{ type: 'text', text: '研究结果' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_n_mismatch' },
          content: [
            { type: 'text', text: '本研究共纳入 120 例晚期肺癌患者进行基线分析。' },
          ],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_pct_mismatch' },
          content: [
            { type: 'text', text: '如表 1 所示，男性患者占比高达 88.5%。' },
          ],
        },
        {
          type: 'table',
          attrs: { id: 'tbl_1' },
          content: [
            {
              type: 'table_row',
              content: [
                {
                  type: 'table_cell',
                  attrs: {},
                  content: [{ type: 'paragraph', attrs: { id: 'th1' }, content: [{ type: 'text', text: '特征' }] }],
                },
                {
                  type: 'table_cell',
                  attrs: {},
                  content: [{ type: 'paragraph', attrs: { id: 'th2' }, content: [{ type: 'text', text: '总体队列 (N=100)' }] }],
                },
              ],
            },
            {
              type: 'table_row',
              content: [
                {
                  type: 'table_cell',
                  attrs: {},
                  content: [{ type: 'paragraph', attrs: { id: 'tc1' }, content: [{ type: 'text', text: '男性, n (%)' }] }],
                },
                {
                  type: 'table_cell',
                  attrs: {},
                  content: [{ type: 'paragraph', attrs: { id: 'tc2' }, content: [{ type: 'text', text: '62 (62.0%)' }] }],
                },
              ],
            },
          ],
        },
      ],
    })

    const tables = extractTableSummaries(doc)
    expect(tables).toHaveLength(1)
    expect(tables[0]?.sample_sizes).toEqual([100])
    expect(tables[0]?.numbers).toContain('62.0%')

    // 验证 SubagentService.runFactChecker 的 Stage 3 (Pass A 数值等价性 + Pass B 内部自洽 + Stage 4 严重度排序)
    const mockPubmed = {
      search: vi.fn().mockResolvedValue([{ pmid: '39991111', doi: '10.1056/test', title: 'Landmark NSCLC Trial', year: '2025' }]),
      abstract: vi.fn().mockResolvedValue('RESULTS: The objective response rate was 0.74 in the combination arm, but there was no significant difference in overall survival (P=0.42).'),
    }

    const svc = new SubagentService({
      docs: { get: () => doc } as any,
      store: {
        getDoc: () => ({ id: 'd1', deleted_at: null }),
        listClaimChecks: () => [],
      } as any,
      claims: {
        evidence: async () => ({
          rev: 1,
          claims: [
            {
              claim_id: 'c_equiv',
              node_id: 'p1',
              sentence: '联合治疗组的客观缓解率达到 74% [1]。',
              section_title: '讨论',
              section_role: 'discussion',
              verification_tier: 'high',
              citations: [
                {
                  cite_id: 'cite1',
                  number: 1,
                  reference: 'Smith et al. NEJM 2024.',
                  abstract: 'RESULTS: Among 200 evaluated patients, the objective response rate was 0.74 (95% CI 0.68-0.80) in the combination arm.',
                },
              ],
            },
            {
              claim_id: 'c_dir_conflict',
              node_id: 'p2',
              sentence: '该方案显著延长了患者总生存期 [2]。',
              section_title: '讨论',
              section_role: 'discussion',
              verification_tier: 'high',
              citations: [
                {
                  cite_id: 'cite2',
                  number: 2,
                  reference: 'Jones et al. Lancet 2024.',
                  abstract: 'RESULTS: Despite higher response rates, there was no significant difference in overall survival between groups (HR 0.96, P=0.68).',
                },
              ],
            },
          ],
          unsourced: [
            {
              claim_id: 'u_ext',
              node_id: 'p3',
              sentence: '既往全球多中心研究显示二线化疗有效率仅为 19.5%。',
              section_title: '引言',
              section_role: 'intro',
              verification_tier: 'high',
            },
          ],
          tables,
          total: 2,
          next_cursor: null,
        }),
        report: vi.fn(),
      } as any,
      pubmed: mockPubmed as any,
    })

    const report = await svc.delegate('u1', { role: 'fact_checker', doc_id: 'd1', task: '核查全文引用与数据自洽性' })
    if (report.role !== 'fact_checker') throw new Error('expected fact_checker report')

    // 1) c_equiv: 74% 与摘要中的 0.74 等价 -> 判定为 supported！
    expect(report.supported_count).toBe(1)
    // 2) c_dir_conflict: 声称「显著延长」，但摘要明确写「no significant difference」 -> 判定为 unsupported！
    expect(report.unsupported_count).toBe(1)
    // 3) Pass B 检出 2 处内部自洽异常（120例 vs N=100；表1 88.5% vs 62.0%）
    expect(report.internal_inconsistency_count).toBe(2)
    // 4) Pass C 对缺出处外部论断执行了实时候选文献检索兜底
    expect(report.live_grounded_count).toBeGreaterThanOrEqual(1)
    const missingIssue = report.issues.find(i => i.category === 'missing_citation')
    expect(missingIssue?.candidate_citations?.[0]?.pmid).toBe('39991111')
    // 5) Stage 4 严重度排序：critical 排在最前
    expect(report.issues[0]?.severity).toBe('critical')
  })
})
