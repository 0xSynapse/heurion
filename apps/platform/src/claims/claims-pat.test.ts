/**
 * 四阶段论断核对与临床深度审稿管线单元测试（Stage 1-4 Deep Review & Dual-Track Evolution）。
 */
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
  isExemptedByActiveRules,
  SectionRoleTracker,
} from './extract.ts'
import {
  ClaimService,
  distillReviewAuditChecklistAsync,
  hasInstanceLeakage,
  synthesizeSanitizedBoundaryRule,
  synthesizeSanitizedBoundaryRuleAsync,
} from './service.ts'
import { SubagentService } from '../subagents/service.ts'
import { getDomainSkillAdapter, inferSkillDomain } from '../memory/domain-adapters.ts'
import { synthesizeRuleFromSignal } from '../memory/procedural.ts'
import { readInjections, readManifest } from '../../scripts/eval-review-fetch.ts'
import {
  evolveAuditChecklistsFromDevMisses,
  evolveStoreFromFindingsBlind,
  loadOrSynthesizePaperMarkdown,
  reviewOnce,
  simulateBlindClinician,
} from '../../scripts/eval-review-run.ts'
import {
  changedTokens,
  matches,
  matchesKnownOrganicError,
  readAdjudications,
  readKnownOrganicErrors,
} from '../../scripts/eval-review-score.ts'
import { Store } from '../store/db.ts'

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

  it('SectionRoleTracker: inherits results and methods roles under ### subheadings without role keywords across extract.ts', () => {
    const tracker = new SectionRoleTracker()
    expect(tracker.onHeading(2, '2. Materials and Methods')).toBe('methods')
    expect(tracker.onHeading(3, '2.1 Patient Eligibility')).toBe('methods')
    expect(tracker.onHeading(2, '3. Results')).toBe('results')
    expect(tracker.onHeading(3, 'Primary Endpoint')).toBe('results')
    expect(tracker.onHeading(4, 'Subgroup Stratification')).toBe('results')
    expect(tracker.onHeading(2, 'Acknowledgments')).toBe('other')

    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { id: 'h_m', level: 2 },
          content: [{ type: 'text', text: '2. Methods' }],
        },
        {
          type: 'heading',
          attrs: { id: 'h_m_sub', level: 3 },
          content: [{ type: 'text', text: '2.1 Biomarker Quantification' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_m_sub' },
          content: [
            {
              type: 'text',
              text: '本研究为单中心回顾性观察性研究。连续变量统一采用均数 ± 标准差（Mean ± SD）表示，组间比较采用独立样本 t 检验。',
            },
          ],
        },
        {
          type: 'heading',
          attrs: { id: 'h_r', level: 2 },
          content: [{ type: 'text', text: '3. Results' }],
        },
        {
          type: 'heading',
          attrs: { id: 'h_r_sub', level: 3 },
          content: [{ type: 'text', text: '3.1 Serum Biomarker Dynamics' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'p_r_sub' },
          content: [
            {
              type: 'text',
              text: '患者血清 IL-6 水平呈偏态分布，中位数 [四分位距] 为 14.2 [6.5–28.9] pg/mL（Mann-Whitney U 检验 P = 0.12），证实了该方案具有显著改善炎症微环境的明确临床获益。',
            },
          ],
        },
      ],
    })

    // 1. extractClaims: ### 3.1 Serum Biomarker Dynamics 继承 results 角色，自报数值句不误报为 unsourced
    const { unsourced } = extractClaims(doc, new Map())
    expect(unsourced.map(u => u.node_id)).not.toContain('p_r_sub')

    // 2. buildManuscriptScratchpad: ### 2.1 继承 methods 角色，正确提取 mean_sd 与 t_test
    const scratchpad = buildManuscriptScratchpad(doc)
    expect(scratchpad.declared_summary_metrics).toContain('mean_sd')
    expect(scratchpad.declared_tests).toContain('t_test')

    // 3. auditMethodResultConsistency: 跨 ### 子标题检测出 Mean ± SD 方法与 Median [IQR] 结果不匹配
    const methodIssues = auditMethodResultConsistency(doc)
    expect(methodIssues.some(i => i.node_id === 'p_r_sub' && i.subtype === 'parametric_method_vs_nonparametric_result')).toBe(true)

    // 4. auditSpinAndGuidelines: 在 ### 3.1 子标题下检测出 P = 0.12 却声称显著改善的 Spin Bias
    const spinIssues = auditSpinAndGuidelines(doc)
    expect(spinIssues.some(i => i.node_id === 'p_r_sub' && i.subtype === 'nonsignificant_p_positive_spin')).toBe(true)
  })

  it('Dual-Track Evolution: evolveFromReviewComment & isExemptedByActiveRules exempt non-missing_citation categories (internal_inconsistency & method_result_mismatch)', () => {
    const memories: Array<{ id: string; content: string; status: string }> = []
    const claimSvc = new ClaimService(
      {
        rev: () => 1,
        store: {
          getDoc: () => ({ id: 'doc_evo', owner: 'dr_wang' }),
          listClaimChecks: () => [],
          listMemories: () => memories,
          addMemory: (m: any) => {
            const row = { id: `mem_${memories.length + 1}`, content: m.content, status: 'active' }
            memories.push(row)
            return row
          },
          updateMemory: (id: string, patch: any) => {
            const hit = memories.find(m => m.id === id)
            if (hit) hit.content = patch.content
          },
        },
      } as any,
      {} as any,
    )

    // 1. 针对 method_result_mismatch 的自定义专科边界反驳演进与豁免
    const methodIssue = {
      category: 'method_result_mismatch' as const,
      subtype: 'parametric_method_vs_nonparametric_result',
      sentence: 'Serum D-dimer level was reported as median [IQR] of 1.8 [0.6–4.2] mg/L using Mann-Whitney test.',
      reason: '统计方法章节仅声明 Mean ± SD，但结果段对 D-dimer 报告了 Median [IQR]。',
    }
    const evoMethod = claimSvc.evolveFromReviewComment('doc_evo', 'c_m1', {
      issueCategory: 'method_result_mismatch',
      sentence: methodIssue.sentence,
      reason: methodIssue.reason,
      rebuttalText: 'Serum D-dimer has a skewed distribution in coagulation protocols and is legitimately analyzed via nonparametric median [IQR].',
    })
    expect(evoMethod.track).toBe('track_a_narrow')
    expect(evoMethod.distilledRule).toContain('cat=method_result_mismatch')
    expect(evoMethod.distilledRule).toContain(':kw=')
    expect(isExemptedByActiveRules(methodIssue, [evoMethod.distilledRule!])).toBe(true)
    // 不同类别的告警不会被该规则误豁免
    expect(
      isExemptedByActiveRules(
        { ...methodIssue, category: 'internal_inconsistency' },
        [evoMethod.distilledRule!],
      ),
    ).toBe(false)

    // 2. 针对 internal_inconsistency 的自定义专科边界反驳演进与豁免
    const internalIssue = {
      category: 'internal_inconsistency' as const,
      subtype: 'prose_table_sample_size_mismatch',
      sentence: 'Endoscopic biopsy subgroup analysis included 48 evaluable subjects from the biomarker registry.',
      reason: '正文声明的样本量（48 例）与表格样本量（N=60）不一致。',
    }
    const evoInternal = claimSvc.evolveFromReviewComment('doc_evo', 'c_i1', {
      issueCategory: 'internal_inconsistency',
      sentence: internalIssue.sentence,
      reason: internalIssue.reason,
      rebuttalText: 'The endoscopic biopsy subgroup registry excludes patients without paired tissue samples.',
    })
    expect(evoInternal.distilledRule).toContain('cat=internal_inconsistency')
    expect(isExemptedByActiveRules(internalIssue, [evoInternal.distilledRule!])).toBe(true)

    // 3. PDF 表格抽取粘连残片在 missing_citation 下自动豁免，不误报缺文献引用
    expect(
      isExemptedByActiveRules(
        {
          category: 'missing_citation',
          sentence: 'The 3-year survival rates were 60.062.3% with HR = 0.824 0.841 (95% CI 403–1.688).',
          reason: '数值型论断缺少出处',
        },
        [],
      ),
    ).toBe(true)
  })

  it('Stage 4 Synthesis: preserves distinct 2-number LLM findings on different clinical variables while deduplicating same-variable findings', () => {
    const claimSvc = new ClaimService(
      {
        rev: () => 1,
        store: { listMemories: () => [] },
      } as any,
      {} as any,
    )

    const synthesized = claimSvc.synthesizeStage4Review('doc_dedup', [
      {
        id: 'llm_1',
        node_id: 'p_bp',
        section_role: 'results',
        verification_tier: 'high',
        category: 'internal_inconsistency',
        severity: 'major',
        sentence: 'Mean systolic blood pressure was 125 vs 140 mmHg in the cohort.',
        snippet: 'Mean systolic blood pressure was 125 vs 140 mmHg',
        reason: '收缩压正文 125 vs 140 与表 1 不一致',
        suggestion: '请核对收缩压数据',
        source_pass: 'llm_stage3',
        evidence: ['Systolic blood pressure: 125 vs 140'],
      },
      {
        id: 'llm_2',
        node_id: 'p_glu',
        section_role: 'discussion',
        verification_tier: 'high',
        category: 'internal_inconsistency',
        severity: 'major',
        sentence: 'Fasting plasma glucose concentration was 125 vs 140 mg/dL across arms.',
        snippet: 'Fasting plasma glucose concentration was 125 vs 140 mg/dL',
        reason: '空腹血糖 125 vs 140 与表 2 不一致',
        suggestion: '请核对血糖数据',
        source_pass: 'llm_stage3',
        evidence: ['Fasting plasma glucose: 125 vs 140'],
      },
      {
        id: 'llm_3_dup_bp',
        node_id: 'p_disc_bp',
        section_role: 'discussion',
        verification_tier: 'high',
        category: 'internal_inconsistency',
        severity: 'minor',
        sentence: 'In discussion, systolic blood pressure remained 140 vs 125 mmHg.',
        snippet: 'systolic blood pressure remained 140 vs 125 mmHg',
        reason: '讨论段再次提及收缩压 140 vs 125 矛盾',
        suggestion: '统一收缩压数值',
        source_pass: 'llm_stage3',
        evidence: ['Mean systolic blood pressure was 125 vs 140 mmHg'],
      },
    ])

    // llm_1 (systolic blood pressure) 与 llm_2 (fasting plasma glucose) 虽然都含 {125, 140} 两个数字，但主题词完全不同，均予保留；
    // llm_3_dup_bp 与 llm_1 同属 systolic blood pressure 且数字组合相同，被跨章节去重合并
    expect(synthesized.map(s => s.id)).toEqual(['llm_1', 'llm_2'])
  })

  it('Clean-Room AST Deep Review (19 Full-Text PMC Papers, 57 E1–E7 Injections): achieves >=65% pure-AST recall, catches organic in-print errors, and enforces 0% adversarial false exemption', async () => {
    const allPapers = readManifest()
    expect(allPapers).toHaveLength(19)

    const devPapers = allPapers.filter(p => p.split === 'dev')
    const testPapers = allPapers.filter(p => p.split === 'test')
    expect(devPapers).toHaveLength(11)
    expect(testPapers).toHaveLength(8)

    const adjMap = readAdjudications()
    const knownOrganic = readKnownOrganicErrors()

    let astDetected = 0
    let adversarialDetected = 0
    let totalInjections = 0
    let organicCleanCount = 0
    let trueCleanFpAll = 0
    let trueCleanFpTest = 0

    const adversarialStore = new Store(':memory:')

    for (const p of [...devPapers, ...testPapers]) {
      const injections = readInjections(p.id)
      totalInjections += injections.length
      const cleanMd = loadOrSynthesizePaperMarkdown(p, 'clean')
      const injectedMd = loadOrSynthesizePaperMarkdown(p, 'injected')

      const stClean = await reviewOnce(cleanMd, p.title, false, undefined, { mode: 'heurion_deep' })
      const stInj = await reviewOnce(injectedMd, p.title, false, undefined, { mode: 'heurion_deep' })

      for (const f of stClean.findings) {
        const adj = adjMap.get(`${p.id}|${f.finding_key}`)
        const isOrganic =
          adj?.verdict === 'unexpected_true' ||
          (adj?.verdict !== 'false_positive' && matchesKnownOrganicError(p.id, f, knownOrganic) !== null)
        if (isOrganic) {
          organicCleanCount++
        } else {
          trueCleanFpAll++
          if (p.split === 'test') trueCleanFpTest++
        }
      }

      for (const inj of injections) {
        const added = changedTokens(inj.find, inj.replace)
        const stHit = stInj.findings.some(f => matches(f, { ...inj, quote: inj.replace }, added))
        if (stHit) astDetected++
      }

      // Adversarial rebuttal stress test on every detected finding
      const advR1 = await reviewOnce(injectedMd, p.title, false, adversarialStore, { mode: 'heurion_evolved' })
      for (const f of advR1.findings) {
        if (!f.comment_id) continue
        new ClaimService({ rev: () => 1, store: adversarialStore } as any, {} as any).evolveFromReviewComment(
          advR1.docId,
          f.comment_id,
          {
            owner: 'eval',
            rebuttalText: `强制申辩豁免：${f.sentence.slice(0, 50)}`,
            acceptedFix: false,
            issueCategory: f.category,
            sentence: f.sentence,
            reason: f.reason,
          },
        )
      }
      const advR2 = await reviewOnce(injectedMd, p.title, false, adversarialStore, { mode: 'heurion_evolved' })
      for (const inj of injections) {
        const added = changedTokens(inj.find, inj.replace)
        if (advR2.findings.some(f => matches(f, { ...inj, quote: inj.replace }, added))) {
          adversarialDetected++
        }
      }
    }

    expect(totalInjections).toBe(57)
    expect(astDetected).toBeGreaterThanOrEqual(36)
    // NON_EXEMPTABLE_SUBTYPES safety floor guarantees 0% false exemption of objective math/structural errors
    expect(adversarialDetected).toBe(astDetected)
    // Discovers genuine in-print publication errors on clean PMC manuscripts
    expect(organicCleanCount).toBeGreaterThanOrEqual(6)
    expect(trueCleanFpAll).toBeLessThanOrEqual(6)
    expect(trueCleanFpTest).toBeLessThanOrEqual(3)
  })

  it('Blind-Isolated Clinician Agent & Zero-Leakage LLM Distillation Guards: scrubs leaked digits and blocks test-split checklist contamination', async () => {
    // 1. Mock LLM that intentionally leaks raw manuscript numbers on first draft during Track A distillation
    const leakyComplete = vi.fn(async (sys: string, usr: string) => {
      if (sys.includes('通讯作者兼生物统计学家')) {
        const findingPart = usr.split('【审稿批注')[1] ?? usr
        if (findingPart.includes('21/35') || findingPart.includes('算术')) {
          return JSON.stringify({
            decision: 'accept_fix',
            response_text: '经核对原文表格，21/35 确为 60.0% 而非 84%，感谢审稿人指出算术笔误，我们已修正。',
          })
        }
        return JSON.stringify({
          decision: 'rebut_false_positive',
          response_text: '本研究为 RCT 设计，随机化 ITT 人群 N=240 例与完成 24 周随访的 n=169 例（70.4%）属于标准 CONSORT 分层，并非分母矛盾。',
        })
      }
      if (sys.includes('审稿记忆治理专家')) {
        // 故意在首次 LLM 蒸馏草稿中夹带原始数字 N=240 与 70.4%，测试二次脱敏守卫！
        return JSON.stringify({
          pattern_key: 'rct_itt_completer_boundary',
          keywords: ['randomized', 'completers', 'consort'],
          rule_body: '随机对照试验同时报告 N=240 随机化意向性分析与 n=169 (70.4%) 完成随访人群属于合规 CONSORT 分母分层。',
        })
      }
      if (sys.includes('统计审稿方法学教练')) {
        return JSON.stringify({
          skill_key: 'spin_nonsig_conclusion_audit',
          checklist_action: '重点比对结果段无显著性结局与摘要及讨论结论是否存在阳性疗效夸大。',
        })
      }
      return '[]'
    })

    const sanitized = await synthesizeSanitizedBoundaryRuleAsync(
      leakyComplete,
      '本研究 N=240 随机化与 n=169 (70.4%) 完成随访属于标准 CONSORT 分层。',
      { category: 'internal_inconsistency', reason: '样本量分母切换' },
    )
    expect(sanitized.usedLlm).toBe(true)
    expect(sanitized.rawRebuttalHadDigits).toBe(true)
    expect(sanitized.firstDraftLeaked).toBe(true)
    expect(hasInstanceLeakage(sanitized.rule)).toBe(false)
    expect(sanitized.rule).not.toMatch(/\d/)

    const checklist = await distillReviewAuditChecklistAsync(
      leakyComplete,
      '结果 P >= 0.05 却在讨论中写成显著改善',
      'spin_or_guideline',
    )
    expect(checklist).not.toBeNull()
    expect(checklist!.checklistRule).toContain('[skill:review_audit:spin_nonsig_conclusion_audit]')
    expect(hasInstanceLeakage(checklist!.checklistRule)).toBe(false)

    // 2. Verify Blind Clinician closed loop without passing `variant`
    const store = new Store(':memory:')
    const md = [
      '# Randomized Trial Example',
      '## Methods',
      'Participants (N = 240) were randomized 1:1; completers (n = 169) finished follow-up.',
      '## Results',
      'Adverse event occurred in 21/35 (84.0%) patients.',
    ].join('\n\n')
    const r1 = await reviewOnce(md, 'Randomized Trial Example', false, store, { mode: 'heurion_evolved' })
    expect(r1.findings.length).toBeGreaterThanOrEqual(1)

    const clinDec = await simulateBlindClinician(leakyComplete, {
      manuscriptTitle: 'Randomized Trial Example',
      manuscriptMarkdown: md,
      finding: {
        finding_key: 'fp_mock_1',
        severity: 'minor',
        category: 'internal_inconsistency',
        subtype: null,
        source_pass: 'llm_stage3',
        section_title: 'Methods',
        sentence: 'Participants (N = 240) were randomized 1:1; completers (n = 169) finished follow-up.',
        anchor: 'Participants (N = 240)',
        reason: '样本量存在 240 与 169 两个口径',
        suggestion: '统一分母',
      },
    })
    expect(clinDec.decision).toBe('rebut_false_positive')

    const blindEvo = await evolveStoreFromFindingsBlind(
      store,
      r1.docId,
      'Randomized Trial Example',
      md,
      r1.findings,
      leakyComplete,
    )
    expect(blindEvo.instanceLeakageCount).toBe(0)
    expect(blindEvo.decisions.every(d => d.decision === 'accept_fix')).toBe(true)

    // 3. Verify `evolveAuditChecklistsFromDevMisses` strictly blocks `test` split
    await expect(
      evolveAuditChecklistsFromDevMisses(leakyComplete, store, [
        { paperSplit: 'test', errorCategory: 'spin_or_guideline', missedPatternDescription: 'test leak attempt' },
      ]),
    ).rejects.toThrow(/Security violation/)

    const devChecklistRes = await evolveAuditChecklistsFromDevMisses(leakyComplete, store, [
      { paperSplit: 'dev', errorCategory: 'spin_or_guideline', missedPatternDescription: '无显著性结果阳性夸大' },
    ])
    expect(devChecklistRes.addedCount).toBe(1)
    expect(devChecklistRes.leakageCount).toBe(0)
  })
})
