import { describe, expect, it, vi } from 'vitest'
import { schema } from '../model/schema.ts'
import {
  auditInternalConsistency,
  auditMethodResultConsistency,
  auditSpinAndGuidelines,
  buildManuscriptScratchpad,
  classifySectionRole,
  classifyVerificationTier,
  extractClaims,
  extractTableSummaries,
} from './extract.ts'
import { ClaimService, synthesizeSanitizedBoundaryRule } from './service.ts'
import { SubagentService } from '../subagents/service.ts'
import { getDomainSkillAdapter, inferSkillDomain } from '../memory/domain-adapters.ts'
import { synthesizeRuleFromSignal } from '../memory/procedural.ts'

describe('4-Stage Citation & Claim Verification Pipeline', () => {
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

  it('Stage 3 Pass B & Pass C: detects real Clinical-SPOT organic errors from representative oncology papers', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { id: 'h_abs', level: 1 },
          content: [{ type: 'text', text: 'Abstract' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_abs1' },
          content: [
            {
              type: 'text',
              text: 'Median DFS was not reached vs 24.4 months (HR = 0.824, 95% CI = 403–1.688, P = 0.594). The pCR rate was 37% (11/30) among resected patients.',
            },
          ],
        },
        {
          type: 'heading',
          attrs: { id: 'h_methods', level: 1 },
          content: [{ type: 'text', text: 'Materials and Methods' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_m_stat' },
          content: [
            {
              type: 'text',
              text: 'Patients underwent thoracic radiotherapy (60 Gy in 30 fractions). Continuous variables were expressed as mean ± SD and compared using Student t-test.',
            },
          ],
        },
        {
          type: 'heading',
          attrs: { id: 'h_results', level: 1 },
          content: [{ type: 'text', text: 'Results' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_r_merge' },
          content: [
            {
              type: 'text',
              text: 'The 3-year OS rates were 69.5% versus 60.062.3%, HR = 0.824 0.841, 95% CI = 0.369–1.919. Postoperative pulmonary infection occurred in 3 patients (3/26, 8.3%) in the S group (n=36).',
            },
          ],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_r_sem' },
          content: [
            {
              type: 'text',
              text: 'In xenograft mice, PINX1 knockdown enhanced radiosensitivity (mean tumor volume ± SEM: 838.55 ± 123.90 mm³ vs 1756.34 ± 205.23 mm³, P < 0.01).',
            },
          ],
        },
        {
          type: 'table',
          attrs: { id: 'tbl_3' },
          content: [
            {
              type: 'table_row',
              content: [
                {
                  type: 'table_cell',
                  attrs: {},
                  content: [{ type: 'paragraph', attrs: { id: 'th_ae' }, content: [{ type: 'text', text: 'Adverse Event' }] }],
                },
                {
                  type: 'table_cell',
                  attrs: {},
                  content: [{ type: 'paragraph', attrs: { id: 'th_crt' }, content: [{ type: 'text', text: 'C group (n=35)' }] }],
                },
              ],
            },
            {
              type: 'table_row',
              content: [
                {
                  type: 'table_cell',
                  attrs: {},
                  content: [{ type: 'paragraph', attrs: { id: 'tc_neu' }, content: [{ type: 'text', text: 'Neutropenia Any Grade' }] }],
                },
                {
                  type: 'table_cell',
                  attrs: {},
                  content: [{ type: 'paragraph', attrs: { id: 'tc_neu_v' }, content: [{ type: 'text', text: '21 (84)' }] }],
                },
              ],
            },
            {
              type: 'table_row',
              content: [
                {
                  type: 'table_cell',
                  attrs: {},
                  content: [{ type: 'paragraph', attrs: { id: 'tc_g5' }, content: [{ type: 'text', text: 'Grade 5 TRAE' }] }],
                },
                {
                  type: 'table_cell',
                  attrs: {},
                  content: [{ type: 'paragraph', attrs: { id: 'tc_g5_v' }, content: [{ type: 'text', text: '00 (0.0%)' }] }],
                },
              ],
            },
          ],
        },
        {
          type: 'heading',
          attrs: { id: 'h_disc', level: 1 },
          content: [{ type: 'text', text: 'Discussion' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_d_pcr' },
          content: [
            {
              type: 'text',
              text: 'Compared with the CROSS trial, the pCR rate was only 31% in our study. Abbreviations: RT: Room temperature; NSCLC: non-small cell lung cancer.',
            },
          ],
        },
      ],
    })

    const tables = extractTableSummaries(doc)
    const scratchpad = buildManuscriptScratchpad(doc, tables)
    expect(scratchpad.declared_summary_metrics).toContain('mean_sd')

    const internalIssues = auditInternalConsistency(doc, tables)
    // 1. 95% CI 403-1.688 小数点遗漏
    expect(internalIssues.some(i => i.reason.includes('403') && i.reason.includes('0.403'))).toBe(true)
    // 2. 60.062.3% / HR = 0.824 0.841 修订残留
    expect(internalIssues.some(i => i.reason.includes('修订') && i.reason.includes('粘连'))).toBe(true)
    // 3. 3/26 (8.3%) 分母笔误
    expect(internalIssues.some(i => i.reason.includes('3/26') && i.reason.includes('36'))).toBe(true)
    // 4. Table 3: 21 (84) vs n=35 (21/35 = 60.0% != 84%)
    expect(internalIssues.some(i => i.reason.includes('21/35') && i.reason.includes('60.0%'))).toBe(true)
    // 5. Table 3: 00 (0.0%) 双零排版笔误
    expect(internalIssues.some(i => i.reason.includes('00 (0.0%)'))).toBe(true)
    // 6. 跨章节 pCR 37% vs 31% 分母切换未声明
    expect(internalIssues.some(i => i.reason.includes('pCR') && i.reason.includes('37%') && i.reason.includes('31%'))).toBe(true)

    const methodIssues = auditMethodResultConsistency(doc, tables)
    // 7. Mean ± SD vs Mean ± SEM
    expect(methodIssues.some(i => i.reason.includes('Mean ± SD') && i.reason.includes('SEM'))).toBe(true)
    // 8. RT: Room temperature vs Radiotherapy
    expect(methodIssues.some(i => i.reason.includes('Room temperature') || i.reason.includes('Radiotherapy'))).toBe(true)
  })

  it('Stage 3 Pass C & Pass D: detects method-result mismatches, imaging protocol violations, spin bias, and STROBE causal overclaims', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { id: 'h_methods', level: 1 },
          content: [{ type: 'text', text: '1. 资料与方法 (Materials and Methods)' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_m1' },
          content: [
            {
              type: 'text',
              text: '本研究为单中心回顾性观察性研究。胸部平扫 CT 采用常规厚层重建（层厚 5.0 mm）。连续变量采用均数 ± 标准差（Mean ± SD）表示，组间比较采用独立样本 t 检验；分类变量采用卡方检验。',
            },
          ],
        },
        {
          type: 'heading',
          attrs: { id: 'h_results', level: 1 },
          content: [{ type: 'text', text: '2. 研究结果 (Results)' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_r1' },
          content: [
            {
              type: 'text',
              text: '患者血清 D-二聚体呈偏态分布，中位数 [四分位距] 为 1.8 [0.6–4.2] mg/L（Mann-Whitney U 检验 P = 0.012）。右肺上叶结节三维体积为 142.5 mm³，体积倍增时间（VDT）为 310 天，随访长径增大 0.8 mm 提示病灶进展。',
            },
          ],
        },
        {
          type: 'heading',
          attrs: { id: 'h_disc', level: 1 },
          content: [{ type: 'text', text: '3. 讨论 (Discussion)' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_d1' },
          content: [
            {
              type: 'text',
              text: '本研究显示新辅助组总生存期达到 24.1 个月（P = 0.14），证实了该方案具有显著改善生存的明确临床获益，直接导致患者死亡风险下降。',
            },
          ],
        },
      ],
    })

    const methodIssues = auditMethodResultConsistency(doc)
    expect(methodIssues.length).toBeGreaterThanOrEqual(3)
    expect(methodIssues.some(i => i.reason.includes('Median [IQR]'))).toBe(true)
    expect(methodIssues.some(i => i.reason.includes('厚层 CT'))).toBe(true)
    expect(methodIssues.some(i => i.reason.includes('1.5 mm'))).toBe(true)

    const spinIssues = auditSpinAndGuidelines(doc)
    expect(spinIssues.length).toBeGreaterThanOrEqual(2)
    expect(spinIssues.some(i => i.reason.includes('Spin Bias'))).toBe(true)
    expect(spinIssues.some(i => i.reason.includes('STROBE'))).toBe(true)
  })

  it('5th Domain Adapter (imaging) & Comment-Driven Self-Evolution Loop (Track A narrow + Track B procedural)', () => {
    expect(inferSkillDomain('请对胸部 HRCT 薄层序列执行肺结节三维分割并生成 [@m:lesion1] 测量原子')).toBe('imaging')
    const imgAdapter = getDomainSkillAdapter('imaging')
    expect(imgAdapter.domain).toBe('imaging')

    const candidates = imgAdapter.extractContrastCandidates(
      '- 右上肺结节 12.4 mm，随访 13.0 mm',
      '右上肺见一混合磨玻璃结节，直径 12.4 mm，3个月随访直径 13.0 mm，明确为恶性浸润性腺癌。',
      '基于 HRCT 薄层（层厚 ≤ 1.25 mm）三维分割，右肺上叶尖段见部分实性结节 [@m:m_lesion_1]，扣除 BTS 2015 / Lung-RADS v2022 量测重复性误差阈值（体积变化 < 25% 且平均径变化 < 1.5 mm）后判定为随访稳定；上述为客观形态学描述，不作为临床诊断依据。',
      [],
    )
    expect(candidates.length).toBe(4)
    expect(imgAdapter.hasInstanceLeakage('Study UID 1.2.840.113619.2.55.3.2831164355')).toContain('instance_dicom_uid_leak')
    expect(imgAdapter.hasInstanceLeakage('[domain:imaging] 执行三维肺结节体积测量前先核验 CT 层厚 ≤ 1.25 mm。')).toBeNull()

    const bareRule = synthesizeRuleFromSignal({
      code: 'bare_measurement',
      kind: 'guard_reject',
      message: '正文含未绑定测量原子的病灶裸数值',
      hints: [],
      recoveryOps: ['insert_measurement → replace_text'],
      domain: 'imaging',
    })
    expect(bareRule).toContain('[domain:imaging]')
    expect(bareRule).toContain('insert_measurement')

    // 验证动态脱敏边界规则提炼（0.0% 样本数字泄露）
    const msAdapter = getDomainSkillAdapter('manuscript')
    const ccwRule = synthesizeSanitizedBoundaryRule(
      'Table 2 reports the cloned-censored-weighted (CCW) pseudo-population (clones = 1242 and 977) after artificial censoring, whereas Table 1 reports unique enrolled patients (N = 400 and 842).',
      { sentence: 'Table 2 Outcomes in the CCW population (clones = 1242 vs clones = 977)' },
    )
    expect(ccwRule.rule).toContain('[domain:manuscript]')
    expect(ccwRule.rule).toContain('review_boundary:target_trial_emulation_ccw')
    expect(msAdapter.hasInstanceLeakage(ccwRule.rule)).toBeNull()

    const customRule = synthesizeSanitizedBoundaryRule(
      'In our center protocol, 68.4% (24/35) reflects the per-protocol endoscopic biopsy subgroup after excluding 12 patients with stenosis.',
      { sentence: 'Endoscopic response was 68.4% (24/35).' },
    )
    expect(customRule.rule).toContain('[domain:manuscript]')
    expect(msAdapter.hasInstanceLeakage(customRule.rule)).toBeNull()

    // 验证 evolveFromReviewComment 双轨闭环
    const putClaimCheck = vi.fn()
    const addMemory = vi.fn().mockReturnValue({ id: 'mem_narrow_1' })
    const addExecutionSignal = vi.fn().mockReturnValue({ id: 'sig_fix_1' })
    const claimSvc = new ClaimService(
      {
        rev: () => 3,
        store: {
          getDoc: () => ({ id: 'doc_1', owner: 'dr_chen' }),
          listClaimChecks: () => [
            {
              doc_id: 'doc_1',
              claim_id: 'k_self_1',
              node_id: 'p_res_1',
              sentence: '本中心入组患者 1 年无进展生存率为 78.4%。',
              verdict: 'missing_citation',
              evidence_tier: 'none',
              evidence_quote: '',
              reason: '数值型论断缺少出处',
              comment_id: 'c_rev_1',
              rev: 2,
            },
          ],
          putClaimCheck,
          listMemories: () => [],
          addMemory,
          addExecutionSignal,
        },
      } as any,
      {} as any,
    )

    const rebuttalRes = claimSvc.evolveFromReviewComment('doc_1', 'c_rev_1', {
      rebuttalText: '该数值属于本研究自身入组队列的 1 年随访结果，并非引用外部文献。',
    })
    expect(rebuttalRes.track).toBe('track_a_narrow')
    expect(rebuttalRes.exemptedClaimId).toBe('k_self_1')
    expect(putClaimCheck).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'exempted' }))
    expect(addMemory).toHaveBeenCalled()

    const fixRes = claimSvc.evolveFromReviewComment('doc_1', 'c_rev_1', {
      acceptedFix: true,
      issueCategory: 'internal_inconsistency',
    })
    expect(fixRes.track).toBe('track_b_procedural')
    expect(addExecutionSignal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'internal_inconsistency' }),
    )
  })
})
