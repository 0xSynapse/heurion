import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schema } from '../../apps/platform/src/model/schema.ts'
import { ClaimService, synthesizeSanitizedBoundaryRule, type DeepReviewMode, type FourStageReviewResult, type SynthesizedReviewComment } from '../../apps/platform/src/claims/service.ts'
import { makeComplete } from '../../apps/platform/src/harness/complete.ts'
import { getDomainSkillAdapter } from '../../apps/platform/src/memory/domain-adapters.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

function loadApiKey(): string {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const envText = readFileSync(resolve(repoRoot, '.env'), 'utf8')
    const m = /^DEEPSEEK_API_KEY=(.+)$/m.exec(envText)
    if (m && m[1]) return m[1].trim()
  } catch {}
  return ''
}

function p(id: string, text: string) {
  return {
    type: 'paragraph',
    attrs: { id },
    content: [{ type: 'text', text }],
  }
}

function h(id: string, level: number, text: string) {
  return {
    type: 'heading',
    attrs: { id, level },
    content: [{ type: 'text', text }],
  }
}

function tbl(id: string, rows: string[][]) {
  return {
    type: 'table',
    attrs: { id },
    content: rows.map((r, rIdx) => ({
      type: 'table_row',
      content: r.map((cell, cIdx) => ({
        type: 'table_cell',
        attrs: {},
        content: [p(`${id}_r${rIdx}_c${cIdx}`, cell)],
      })),
    })),
  }
}

export interface PaperSpec {
  paper_id: string
  short_name: string
  journal_year: string
  title: string
  family: 'translational_radiobiology' | 'clinical_trial_escc' | 'observational_tte' | 'spatial_multiomics'
  pdf_path: string
  known_organic_errors: Array<{
    error_id: string
    subtype: string
    location: string
    verbatim: string
    ground_truth_description: string
    match_keywords: string[]
  }>
  doc_json: Record<string, unknown>
}

export const SEVEN_PAPERS: PaperSpec[] = [
  {
    paper_id: 'P1_2024_JTM_BIBR1532',
    short_name: '代表作1 (2024 JTM - BIBR1532)',
    journal_year: 'Journal of Translational Medicine (2024)',
    title: 'Telomerase inhibitor BIBR1532 combined with radiotherapy induces systemic antitumor immunity via the cGAS-STING pathway in non-small cell lung cancer',
    family: 'translational_radiobiology',
    pdf_path: '近5年代表作1-2024-JTM-BIBR1532.pdf',
    known_organic_errors: [],
    doc_json: {
      type: 'doc',
      content: [
        h('p1_h_abs', 1, 'Abstract'),
        p(
          'p1_abs_1',
          'Background: Radiotherapy (RT) can trigger antitumor immune responses, but radioresistance and immunosuppressive tumor microenvironment limit its systemic abscopal efficacy in non-small cell lung cancer (NSCLC). Here we investigated whether the telomerase inhibitor BIBR1532 sensitizes NSCLC to RT and promotes systemic antitumor immunity.',
        ),
        p(
          'p1_abs_2',
          'Methods: Colony formation, comet assays, and cytosolic dsDNA quantification were performed in A549, H460, and LLC cell lines treated with BIBR1532 (60 μM) and RT (8 Gy). Bilateral subcutaneous LLC xenograft models in immunocompetent C57BL/6 mice were randomized into four groups (Control, BIBR1532, RT, and BIBR1532+RT; n = 5 mice per group for tumor volume growth curves; n = 6 mice per group for survival monitoring; n = 3 independent biological replicates per group for flow cytometry immune profiling). Clinical relevance of TERT expression and CD8+ T cell infiltration was evaluated in a human NSCLC tissue microarray (TMA) cohort (n = 90).',
        ),
        p(
          'p1_abs_3',
          'Results: BIBR1532 combined with RT synergistically increased telomeric DNA damage, cytosolic dsDNA accumulation, and phosphorylation of cGAS, STING, TBK1, and IRF3, promoting dendritic cell (DC) maturation and CD8+ T-cell activation. In bilateral LLC mouse models, BIBR1532 + RT significantly inhibited both irradiated primary tumors and unirradiated abscopal tumors (n = 5 per group, P < 0.001) and prolonged median survival (n = 6 per group, P = 0.004). In the clinical NSCLC TMA cohort (n = 90), high TERT protein expression was negatively correlated with CD8+ T-cell infiltration (r = -0.34, P < 0.001) and associated with worse overall survival (HR = 1.89, 95% CI = 1.15–3.10, P = 0.012).',
        ),
        h('p1_h_methods', 1, 'Materials and Methods'),
        p(
          'p1_m_1',
          'Patient tissue microarray (TMA) cohort: Formalin-fixed paraffin-embedded tumor specimens were retrospectively collected from 90 patients with pathologically confirmed NSCLC who underwent curative resection without prior neoadjuvant therapy. Animal experiments: Six-week-old female C57BL/6 mice were subcutaneously inoculated with 5×10^5 LLC cells in the right flank (primary tumor) and 2×10^5 LLC cells in the left flank (abscopal tumor). Mice were randomly assigned into Control, BIBR1532 (50 mg/kg i.p.), RT (8 Gy×3 fractions to primary tumor), or Combination groups (n = 5 mice/group for tumor volume measurement; a separate cohort of n = 6 mice/group was followed for survival analysis).',
        ),
        p(
          'p1_m_2',
          'Statistical analysis: All quantitative data from at least three independent experiments were expressed as mean ± SD. Comparisons between two groups were analyzed using two-tailed unpaired Student t-test, and multi-group comparisons were performed using one-way ANOVA with Tukey post-hoc test. Survival curves were plotted by the Kaplan-Meier method and compared using the log-rank test.',
        ),
        h('p1_h_results', 1, 'Results'),
        p(
          'p1_r_1',
          'Combination of BIBR1532 and RT induces potent radiosensitization in vitro: Colony formation assays showed sensitizer enhancement ratios (SER) of 1.42 in A549 cells and 1.38 in H460 cells. Flow cytometry analysis (n = 3 per group) demonstrated that CD80+CD86+ mature dendritic cells in tumor-draining lymph nodes increased from 14.2 ± 1.8% in the Control group and 19.5 ± 2.1% in the RT alone group to 31.8 ± 2.7% in the BIBR1532 + RT group (P < 0.001).',
        ),
        p('p1_r_tbl_cap', 'Table 1 Association between TERT expression and clinicopathological characteristics in the NSCLC TMA cohort (N=90)'),
        tbl('p1_tbl_1', [
          ['Characteristic', 'Total (N=90)', 'Low TERT (n=42)', 'High TERT (n=48)', 'P value'],
          ['Sex: Male, n (%)', '58 (64.4%)', '26 (61.9%)', '32 (66.7%)', '0.638'],
          ['TNM Stage III, n (%)', '39 (43.3%)', '13 (31.0%)', '26 (54.2%)', '0.027'],
          ['High CD8+ T infiltration, n (%)', '44 (48.9%)', '28 (66.7%)', '16 (33.3%)', '0.002'],
        ]),
        h('p1_h_disc', 1, 'Discussion'),
        p(
          'p1_d_1',
          'Our study demonstrates that telomerase inhibition with BIBR1532 amplifies RT-induced cytosolic DNA sensing via the cGAS-STING pathway, converting local tumor irradiation into systemic antitumor immunity in NSCLC.',
        ),
      ],
    },
  },
  {
    paper_id: 'P2_2024_JTM_PINX1',
    short_name: '代表作2 (2024 JTM - PINX1)',
    journal_year: 'Journal of Translational Medicine (2024)',
    title: 'Targeting PINX1-mediated telomere maintenance sensitizes non-small cell lung cancer to radiotherapy by promoting ferroptosis',
    family: 'translational_radiobiology',
    pdf_path: '近5年代表作2-2024-JTM-PINX1.pdf',
    known_organic_errors: [
      {
        error_id: 'P2_ERR_1',
        subtype: 'sd_vs_sem_mismatch',
        location: 'Materials and Methods p.4 vs. Results p.4 right column',
        verbatim: 'Statistical analysis: expressed as mean ± SD ... Results: (mean tumor volume ± SEM: 838.55 ± 123.90 mm³ vs. 1756.34 ± 205.23 mm³, P < 0.01)',
        ground_truth_description: '统计方法段声明所有计量资料以均数±标准差（mean ± SD）表示，但结果段体内荷瘤小鼠体积却以均数±标准误（mean ± SEM）报告，前后统计指标混淆。',
        match_keywords: ['SEM', 'SD', '838.55'],
      },
      {
        error_id: 'P2_ERR_2',
        subtype: 'abbreviation_definition_conflict',
        location: 'Abbreviations p.13',
        verbatim: 'Abbreviations: NSCLC: Non-small cell lung cancer; PINX1: PIN2/TERF1-interacting telomerase inhibitor 1; RT: Room temperature',
        ground_truth_description: '全文核心干预手段 RT 均指代放射治疗（Radiotherapy），但文末 Abbreviations 缩略语表却将 RT 错误定义为“Room temperature（室温）”。',
        match_keywords: ['Room temperature', 'Radiotherapy', 'RT'],
      },
    ],
    doc_json: {
      type: 'doc',
      content: [
        h('p2_h_abs', 1, 'Abstract'),
        p(
          'p2_abs_1',
          'Background: Radioresistance remains a major obstacle in non-small cell lung cancer (NSCLC) treated with radiotherapy (RT). PINX1 is a telomerase-binding protein involved in telomere maintenance, yet its role in RT-induced ferroptosis is unclear.',
        ),
        p(
          'p2_abs_2',
          'Methods: PINX1 expression was analyzed in TCGA-LUAD/LUSC datasets and an institutional NSCLC cohort (n = 92) receiving definitive RT. Lipid peroxidation, malondialdehyde (MDA), intracellular Fe2+, and GPX4/SLC7A11 levels were measured in A549 and H1299 cells following shPINX1 knockdown and 8 Gy irradiation. Subcutaneous xenograft models in BALB/c nude mice (n = 5 mice per group) were used to evaluate radiosensitization in vivo.',
        ),
        h('p2_h_methods', 1, 'Materials and Methods'),
        p(
          'p2_m_1',
          'Clinical specimens and xenograft models: Tumor biopsies from 92 NSCLC patients treated with thoracic radiotherapy (60 Gy in 30 fractions) were collected. For in vivo xenograft studies, BALB/c nude mice were randomized into shNC, shPINX1, shNC + RT (8 Gy), and shPINX1 + RT (8 Gy) groups (n = 5 mice per group).',
        ),
        p(
          'p2_m_stat',
          'Statistical analysis: All statistical analyses were performed using GraphPad Prism 9.0. Data from at least three independent experiments were expressed as mean ± SD. Comparisons between two groups were performed using Student t-test, and comparisons among multiple groups were analyzed by one-way ANOVA.',
        ),
        h('p2_h_results', 1, 'Results'),
        p(
          'p2_r_1',
          'PINX1 depletion promotes RT-induced ferroptosis and radiosensitization in vivo: Knockdown of PINX1 significantly elevated lipid ROS and MDA levels while downregulating SLC7A11 and GPX4 after 8 Gy RT. In the subcutaneous xenograft model, PINX1 knockdown significantly enhanced the efficacy of RT in inhibiting tumor growth (mean tumor volume ± SEM: 838.55 ± 123.90 mm³ vs. 1756.34 ± 205.23 mm³, P < 0.01).',
        ),
        p('p2_r_tbl_cap', 'Table 1 Clinical correlation of PINX1 expression with radiotherapy response in NSCLC patients (N=92)'),
        tbl('p2_tbl_1', [
          ['Variable', 'Low PINX1 (n=45)', 'High PINX1 (n=47)', 'P value'],
          ['Objective response (CR+PR), n (%)', '31 (68.9%)', '19 (40.4%)', '0.006'],
          ['Non-response (SD+PD), n (%)', '14 (31.1%)', '28 (59.6%)', '0.006'],
        ]),
        h('p2_h_disc', 1, 'Discussion and Abbreviations'),
        p(
          'p2_d_1',
          'In conclusion, our findings reveal that PINX1 suppresses RT-induced ferroptosis by stabilizing telomeric shelterin and upregulating GPX4, and targeting PINX1 is a promising radiosensitization strategy for NSCLC. Abbreviations: NSCLC: Non-small cell lung cancer; PINX1: PIN2/TERF1-interacting telomerase inhibitor 1; RT: Room temperature; ROS: Reactive oxygen species; GPX4: Glutathione peroxidase 4; MDA: Malondialdehyde.',
        ),
      ],
    },
  },
  {
    paper_id: 'P3_2026_eClinicalMedicine',
    short_name: '代表作3 (2026 eClinicalMedicine)',
    journal_year: 'eClinicalMedicine (2026)',
    title: 'Consolidation immunotherapy after definitive chemoradiotherapy in older patients with esophageal squamous cell carcinoma: a target trial emulation across eight centers',
    family: 'observational_tte',
    pdf_path: '近5年代表作3-2026-eClinicalMedicine.pdf',
    known_organic_errors: [
      {
        error_id: 'P3_ERR_1',
        subtype: 'table_cell_formatting_typo',
        location: 'Table 3 p.10 (Grade 5 Treatment-Related Adverse Events)',
        verbatim: 'Grade 5 radiation pneumonitis: 00 (0.0%); Grade 5 esophageal fistula: 00 (0.0%)',
        ground_truth_description: 'Table 3 安全性不良事件表中多处零事件单元格存在前导双零排版笔误“00 (0.0%)”（应为“0 (0.0%)”）。',
        match_keywords: ['00 (0.0%)', '前导零', '双零'],
      },
    ],
    doc_json: {
      type: 'doc',
      content: [
        h('p3_h_abs', 1, 'Abstract'),
        p(
          'p3_abs_1',
          'Background: Randomized trials of consolidation immune checkpoint inhibitors (ICIs) after definitive chemoradiotherapy (dCRT) in locally advanced esophageal squamous cell carcinoma (ESCC) have largely excluded older patients aged 65 years or older. We aimed to evaluate the effectiveness and safety of consolidation ICI following dCRT in older patients with ESCC.',
        ),
        p(
          'p3_abs_2',
          'Methods: We conducted a multicenter target trial emulation across eight academic cancer centers in China. Eligible patients aged ≥ 65 years with unresectable locally advanced ESCC who completed dCRT without progression were included. To eliminate immortal time bias during the 6-week post-dCRT grace period, we applied a clone-censor-weight (CCW) framework with inverse probability of censoring weights. Primary endpoint was overall survival (OS), quantified via non-parametric bootstrap absolute risk differences (RD) and relative risks (RR) at 24 months.',
        ),
        p(
          'p3_abs_3',
          'Findings: Between January 2019 and December 2023, 1242 eligible patients were included (400 in the dCRT+ICI group and 842 in the dCRT alone group). In the CCW pseudo-population (clones = 1242 in the dCRT+ICI arm vs clones = 977 in the dCRT alone arm), 24-month OS was 68.4% versus 57.1% (RD = +11.3%, 95% CI 5.2%–17.4%; RR = 1.20, 95% CI 1.09–1.32, P < 0.001). Grade ≥ 3 treatment-related adverse events occurred in 31.5% (126/400) vs 28.4% (239/842) of patients.',
        ),
        h('p3_h_methods', 1, 'Methods'),
        p(
          'p3_m_1',
          'Study design and target trial emulation: We specified a hypothetical pragmatic randomized trial and emulated it using observational data from 1242 older ESCC patients across eight centers. Because consolidation ICI could be initiated within a 6-week grace period after completing dCRT, naive group assignment would introduce immortal time bias. Following the Hernan clone-censor-weight (CCW) methodology, each eligible patient was cloned at time zero into both strategies: Strategy 1 (initiate consolidation ICI within 6 weeks, clones = 1242) and Strategy 2 (no consolidation ICI, clones = 977 after grace-period artificial censoring), weighted by inverse probability of censoring weights (IPCW).',
        ),
        h('p3_h_results', 1, 'Results'),
        p(
          'p3_r_1',
          'Baseline characteristics and survival outcomes: Among the 1242 unique patients enrolled at baseline (Table 1), 400 received consolidation ICI and 842 received dCRT alone. After CCW adjustment (Table 2), consolidation ICI significantly improved 24-month OS and PFS compared with dCRT alone.',
        ),
        p('p3_r_t1_cap', 'Table 1 Baseline characteristics of the original cohort before cloning (N=1242)'),
        tbl('p3_tbl_1', [
          ['Characteristic', 'dCRT + ICI (n=400)', 'dCRT alone (n=842)', 'SMD'],
          ['Age ≥ 75 years, n (%)', '112 (28.0%)', '256 (30.4%)', '0.053'],
          ['Male sex, n (%)', '316 (79.0%)', '657 (78.0%)', '0.024'],
          ['Clinical stage III–IVA, n (%)', '334 (83.5%)', '711 (84.4%)', '0.025'],
        ]),
        p('p3_r_t2_cap', 'Table 2 Survival outcomes in the clone-censor-weight (CCW) emulated target trial population'),
        tbl('p3_tbl_2', [
          ['Outcome', 'dCRT + ICI (clones = 1242)', 'dCRT alone (clones = 977)', 'Risk Difference (95% CI)'],
          ['24-month OS rate (%)', '68.4%', '57.1%', '+11.3% (5.2% to 17.4%)'],
          ['24-month PFS rate (%)', '51.2%', '39.8%', '+11.4% (4.9% to 17.9%)'],
        ]),
        p('p3_r_t3_cap', 'Table 3 Treatment-related adverse events in the safety population (N=1242)'),
        tbl('p3_tbl_3', [
          ['Adverse Event', 'dCRT + ICI (n=400)', 'dCRT alone (n=842)'],
          ['Any Grade ≥ 3 TRAE', '126 (31.5%)', '239 (28.4%)'],
          ['Grade 5 radiation pneumonitis', '2 (0.5%)', '00 (0.0%)'],
          ['Grade 5 esophageal fistula', '00 (0.0%)', '1 (0.1%)'],
        ]),
        h('p3_h_disc', 1, 'Discussion'),
        p(
          'p3_d_1',
          'In this eight-center target trial emulation of 1242 older patients with locally advanced ESCC, consolidation immunotherapy after dCRT was associated with a clinically meaningful 11.3% absolute improvement in 2-year overall survival with manageable toxicity.',
        ),
      ],
    },
  },
  {
    paper_id: 'P4_2025_JITC',
    short_name: '代表作4 (2025 JITC)',
    journal_year: 'Journal for ImmunoTherapy of Cancer (2025)',
    title: 'Spatial multi-omics and machine learning reveal tertiary lymphoid structure maturation and predict neoadjuvant immunochemotherapy response in esophageal squamous cell carcinoma',
    family: 'spatial_multiomics',
    pdf_path: '近5年代表作4-2025-JITC.pdf',
    known_organic_errors: [],
    doc_json: {
      type: 'doc',
      content: [
        h('p4_h_abs', 1, 'Abstract'),
        p(
          'p4_abs_1',
          'Background: Pathological response to neoadjuvant immunochemotherapy (nICT) varies substantially among patients with locally advanced esophageal squamous cell carcinoma (ESCC). We integrated spatial multi-omics and machine learning to characterize tertiary lymphoid structure (TLS) maturation and predict nICT efficacy.',
        ),
        p(
          'p4_abs_2',
          'Methods: A total of 254 ESCC patients treated with nICT followed by esophagectomy were included across three cohorts: a spatial multi-omics discovery cohort (n = 42, profiled by NanoString GeoMx Digital Spatial Profiler and 7-color multiplex immunofluorescence), an institutional training cohort (n = 148), and an external validation cohort (n = 64). Normality of continuous variables was assessed by the Shapiro-Wilk test; normally distributed variables were compared using Student t-test (mean ± SD) and skewed variables using the Mann-Whitney U test (median [IQR]).',
        ),
        p(
          'p4_abs_3',
          'Results: In the discovery cohort (n = 42), pathological complete response (pCR) was achieved in 20 patients (20/42, 47.6%). Responders exhibited significantly higher intratumoral density of mature CXCL13+CD20+CD21+ follicular dendritic cell-containing TLSs (median [IQR]: 4.8 [2.9–7.4] vs 1.2 [0.4–2.3] structures/mm², P < 0.001). The machine learning TLS-pathomics signature achieved an AUC of 0.892 (95% CI = 0.838–0.946) in the training cohort (n = 148) and 0.864 (95% CI = 0.775–0.953) in the external validation cohort (n = 64).',
        ),
        h('p4_h_methods', 1, 'Methods'),
        p(
          'p4_m_1',
          'Study cohorts and spatial profiling: The discovery cohort comprised 42 resected ESCC specimens analyzed by spatial transcriptomics and multiplex immunofluorescence. The predictive model was trained on whole-slide H&E and IHC images from 148 patients at Center 1 and externally validated on 64 patients from Center 2. Statistical comparisons used Student t-test for normal continuous variables and Mann-Whitney U test for non-normal continuous variables; DeLong test was used for ROC AUC comparisons.',
        ),
        h('p4_h_results', 1, 'Results'),
        p('p4_r_t1_cap', 'Table 1 Characteristics across the discovery, training, and external validation cohorts (Total N=254)'),
        tbl('p4_tbl_1', [
          ['Characteristic', 'Discovery Cohort (n=42)', 'Training Cohort (n=148)', 'Validation Cohort (n=64)'],
          ['Male sex, n (%)', '34 (81.0%)', '119 (80.4%)', '51 (79.7%)'],
          ['pCR achieved, n (%)', '20 (47.6%)', '56 (37.8%)', '24 (37.5%)'],
          ['MPR achieved, n (%)', '28 (66.7%)', '89 (60.1%)', '38 (59.4%)'],
        ]),
        h('p4_h_disc', 1, 'Discussion'),
        p(
          'p4_d_1',
          'Our spatial multi-omics atlas demonstrates that mature Germinal-Center-like TLSs drive B-T cell cross-talk during nICT in ESCC, and our validated ML signature enables accurate pre-surgical stratification.',
        ),
      ],
    },
  },
  {
    paper_id: 'P5_2025_NCRCN_EJC',
    short_name: '代表作5 (2025 EJC - NCRCN)',
    journal_year: 'European Journal of Cancer (2025)',
    title: 'Neoadjuvant short-course radiotherapy followed by camrelizumab and chemotherapy in locally advanced esophageal squamous cell carcinoma (NCRCN): a single-arm phase II trial',
    family: 'clinical_trial_escc',
    pdf_path: '近5年代表作5-2025-NCRCN-EJC.pdf',
    known_organic_errors: [
      {
        error_id: 'P5_ERR_1',
        subtype: 'cross_section_endpoint_denominator_switch',
        location: 'Abstract & Results p.4 (37%, 11/30) vs. Discussion p.5 (31%)',
        verbatim: 'Results: The pCR rate was 37% (11/30) ... Discussion: Compared with the CROSS trial, the pCR rate was only 31% in our study.',
        ground_truth_description: '摘要与结果段按接受手术切除的30例患者报告主要终点 pCR 率为 37% (11/30)，但讨论段突然改用全入组 ITT 人群（11/35 = 31.4%）声称“the pCR rate was only 31% in our study”且未标注分母切换，造成主要终点前后矛盾。',
        match_keywords: ['37%', '31%', 'pCR'],
      },
    ],
    doc_json: {
      type: 'doc',
      content: [
        h('p5_h_abs', 1, 'Abstract'),
        p(
          'p5_abs_1',
          'Background: Conventional long-course neoadjuvant chemoradiotherapy (41.4 Gy in 23 fractions) combined with PD-1 blockade carries substantial lymphopenia and esophageal toxicity. This single-arm phase II trial (NCRCN) evaluated neoadjuvant short-course radiotherapy (SCRT) followed by camrelizumab and chemotherapy in resectable locally advanced esophageal squamous cell carcinoma (ESCC).',
        ),
        p(
          'p5_abs_2',
          'Patients and Methods: Patients with stage II–IVA resectable ESCC received SCRT (25 Gy in 5 daily fractions) followed by two cycles of camrelizumab (200 mg) plus nab-paclitaxel and carboplatin, and subsequent radical esophagectomy. Using a Simon two-stage single-arm phase II design against a historical control pCR rate of 20%, a total of 35 patients were enrolled.',
        ),
        p(
          'p5_abs_3',
          'Results: All 35 enrolled patients completed SCRT and immunochemotherapy (intention-to-treat population, N = 35). Five patients did not undergo surgery (3 refused surgery after clinical complete response, 2 experienced disease progression); 30 patients underwent McKeown or Ivor-Lewis esophagectomy with a 100% R0 resection rate (30/30). Among resected patients, the pathological complete response (pCR) rate was 37% (11/30) and the major pathological response (MPR) rate was 60% (18/30). Grade 3–4 treatment-related adverse events occurred in 12 patients (12/35, 34.3%), with no treatment-related deaths.',
        ),
        h('p5_h_methods', 1, 'Patients and Methods'),
        p(
          'p5_m_1',
          'Study design and participants: NCRCN was a prospective, single-center, single-arm phase II clinical trial. Sample size was calculated via Simon optimal two-stage design (H0: pCR ≤ 20% based on historical control vs H1: pCR ≥ 40%, alpha = 0.05, power = 80%), requiring 35 enrolled patients. Pathological response was assessed in patients who underwent surgical resection (n = 30), while safety and survival were evaluated in all enrolled patients (N = 35).',
        ),
        h('p5_h_results', 1, 'Results'),
        p(
          'p5_r_1',
          'Efficacy and pathological outcomes: Between May 2022 and October 2023, 35 eligible ESCC patients were enrolled (Table 1). Thirty patients proceeded to surgery. In the surgical population (n = 30), the pCR rate was 37% (11/30) and the MPR rate was 60% (18/30). With a median follow-up of 18.5 months, 1-year OS in the ITT population (N = 35) was 91.4% (32/35).',
        ),
        p('p5_r_t1_cap', 'Table 1 Baseline characteristics of enrolled patients in the single-arm NCRCN phase II trial (N=35)'),
        tbl('p5_tbl_1', [
          ['Characteristic', 'Enrolled Cohort (n=35)'],
          ['Male sex, n (%)', '29 (82.9%)'],
          ['Clinical Stage III, n (%)', '26 (74.3%)'],
          ['Underwent R0 surgery, n (%)', '30 (85.7%)'],
        ]),
        h('p5_h_disc', 1, 'Discussion'),
        p(
          'p5_d_1',
          'In this phase II study, sequential SCRT and camrelizumab plus chemotherapy demonstrated encouraging activity and favorable safety in locally advanced ESCC. Compared with the CROSS and NEOCRTEC5010 trials, the pCR rate was only 31% in our study, which may be attributed to the shorter interval between radiotherapy and surgery or conservative tumor bed sampling.',
        ),
      ],
    },
  },
  {
    paper_id: 'P6_2022_GREEN_J',
    short_name: '代表作6 (2022 Green Journal - Radiother Oncol)',
    journal_year: 'Radiotherapy and Oncology (2022)',
    title: 'Surgery versus definitive chemoradiotherapy for patients with esophageal squamous cell carcinoma achieving clinical complete response after neoadjuvant chemoradiotherapy',
    family: 'clinical_trial_escc',
    pdf_path: '近5年代表作6-2022-GREEN J.pdf',
    known_organic_errors: [
      {
        error_id: 'P6_ERR_1',
        subtype: 'ci_bounds_inverted_or_missing_decimal',
        location: 'Abstract p.1 (Results)',
        verbatim: 'HR = 0.824, 95% CI = 403–1.688, P = 0.594',
        ground_truth_description: '摘要中报告中位 DFS 的 95% 置信区间下界漏掉小数点“0.”，印成了“95% CI = 403–1.688”（下界 403 > 上界 1.688，对照正文表2应为 0.403–1.688）。',
        match_keywords: ['403', '1.688', '0.403'],
      },
      {
        error_id: 'P6_ERR_2',
        subtype: 'uncleaned_revision_merge_artifact',
        location: 'Results p.3 right column & Abstract vs Results OS HR',
        verbatim: 'The 3-year OS rates in the S group and C group were 69.5% versus 60.062.3%, HR = 0.824 0.841, 95% CI = 0.369–1.919, P = 0.680',
        ground_truth_description: '正文第3页右栏存在未清理干净的 Word 修订粘连字符“60.062.3%”与双风险比并列“HR = 0.824 0.841”，且摘要报告 3-year OS HR = 0.824 而结果/图2B报告 HR = 0.841。',
        match_keywords: ['60.062.3%', '0.824', '0.841'],
      },
      {
        error_id: 'P6_ERR_3',
        subtype: 'fraction_percentage_arithmetic_error',
        location: 'Results p.3 bottom right (Postoperative complications)',
        verbatim: 'pulmonary infection (3/26, 8.3%)',
        ground_truth_description: '手术组（S group）实际样本量为 n = 36，3/36 = 8.3%，但正文将分母 36 笔误印成 26（写成“3/26, 8.3%”，而 3/26 实为 11.5%）。',
        match_keywords: ['3/26', '8.3%', '36'],
      },
      {
        error_id: 'P6_ERR_4',
        subtype: 'table_cell_percentage_arithmetic_error',
        location: 'Table 3 p.5 (Neutropenia Any Grade in C group, n=35)',
        verbatim: 'Neutropenia Any Grade | C group (n=35): 21 (84)',
        ground_truth_description: 'Table 3 中根治性放化疗组（C group, n=35）Neutropenia Any Grade 印为“21 (84)”，既漏标百分号（%），且算术严重错误（21/35 = 60.0% ≠ 84%）。',
        match_keywords: ['21 (84)', '60.0%', '84'],
      },
    ],
    doc_json: {
      type: 'doc',
      content: [
        h('p6_h_abs', 1, 'Abstract'),
        p(
          'p6_abs_1',
          'Background and purpose: Whether esophagectomy is necessary for esophageal squamous cell carcinoma (ESCC) patients who achieve clinical complete response (cCR) after neoadjuvant chemoradiotherapy (nCRT) remains controversial. We compared surgery (S group) versus definitive chemoradiotherapy (C group) in cCR patients.',
        ),
        p(
          'p6_abs_2',
          'Materials and methods: Out of 256 ESCC patients receiving induction chemoradiotherapy (40 Gy plus cisplatin/paclitaxel), 71 patients achieved cCR and were randomly assigned to the C group (n=35, boost radiotherapy to 60 Gy) or S group (n=36, radical esophagectomy), while 185 non-cCR patients (including 91 who underwent salvage treatment) were followed in a parallel observational cohort.',
        ),
        p(
          'p6_abs_3',
          'Results: With a median follow-up of 38.2 months in the randomized cCR cohort (n=71), median disease-free survival (DFS) was not reached in the S group versus 24.4 months in the C group (HR = 0.824, 95% CI = 403–1.688, P = 0.594). The 3-year OS rates were 69.5% vs 62.3% (HR = 0.824, P = 0.625).',
        ),
        h('p6_h_methods', 1, 'Materials and Methods'),
        p(
          'p6_m_1',
          'Study design and patient cohorts: A total of 256 consecutive patients with locally advanced thoracic ESCC underwent initial chemoradiotherapy. Restaging after 40 Gy identified 71 patients with clinical complete response (cCR), who were randomized 1:1 to definitive CRT (C group, n=35) or surgery (S group, n=36). The remaining 185 non-cCR patients were excluded from randomization, and 91 non-cCR patients completing salvage therapy were analyzed in a separate observational comparison. Categorical variables were compared by Chi-square test or Fisher exact test; survival was analyzed using Kaplan-Meier curves and Cox proportional hazards regression.',
        ),
        h('p6_h_results', 1, 'Results'),
        p(
          'p6_r_1',
          'Survival outcomes in the randomized cCR cohort: Baseline characteristics were well balanced between the C group (n=35) and S group (n=36) (Table 1). The 3-year OS rates in the S group and C group were 69.5% versus 60.062.3%, HR = 0.824 0.841, 95% CI = 0.369–1.919, P = 0.680.',
        ),
        p(
          'p6_r_2',
          'Safety and postoperative complications: Treatment-related toxicities are summarized in Table 3. In the S group (n=36), major postoperative complications included anastomotic leakage (4/36, 11.1%), recurrent laryngeal nerve palsy (5/36, 13.9%), and pulmonary infection (3/26, 8.3%).',
        ),
        p('p6_r_t1_cap', 'Table 1 Baseline characteristics of randomized cCR patients (n=71)'),
        tbl('p6_tbl_1', [
          ['Characteristic', 'C group (n=35)', 'S group (n=36)', 'P value'],
          ['Male sex, n (%)', '28 (80.0%)', '29 (80.6%)', '0.953'],
          ['Middle thoracic location, n (%)', '22 (62.9%)', '23 (63.9%)', '0.928'],
        ]),
        p('p6_r_t3_cap', 'Table 3 Acute treatment-related adverse events in the randomized cCR cohort (n=71)'),
        tbl('p6_tbl_3', [
          ['Adverse Event', 'C group (n=35)', 'S group (n=36)', 'P value'],
          ['Neutropenia Any Grade', '21 (84)', '22 (61.1%)', '0.924'],
          ['Neutropenia Grade 3–4', '7 (20.0%)', '8 (22.2%)', '0.819'],
          ['Radiation esophagitis Any Grade', '19 (54.3%)', '18 (50.0%)', '0.718'],
        ]),
        h('p6_h_disc', 1, 'Discussion'),
        p(
          'p6_d_1',
          'In ESCC patients achieving cCR after induction CRT, esophagectomy and definitive chemoradiotherapy yielded comparable 3-year overall survival, although surgery reduced locoregional recurrence.',
        ),
      ],
    },
  },
  {
    paper_id: 'P7_2022_CDDisc',
    short_name: '代表作7 (2022 Cell Death Discovery)',
    journal_year: 'Cell Death Discovery (2022)',
    title: 'RBM15-mediated m6A modification of SRSF1 promotes radioresistance in non-small cell lung cancer through alternative splicing of BCL-X',
    family: 'translational_radiobiology',
    pdf_path: '近5年代表作7-2022-CDDisc.pdf',
    known_organic_errors: [],
    doc_json: {
      type: 'doc',
      content: [
        h('p7_h_abs', 1, 'Abstract'),
        p(
          'p7_abs_1',
          'Background: Dysregulated N6-methyladenosine (m6A) RNA methylation is implicated in cancer progression, but its role in radiotherapy (RT) resistance in non-small cell lung cancer (NSCLC) remains poorly understood.',
        ),
        p(
          'p7_abs_2',
          'Methods: Expression of the m6A methyltransferase RBM15 was analyzed in TCGA-NSCLC and 86 clinical NSCLC tumor specimens. MeRIP-qPCR, RIP, RNA stability assays, and RT-PCR for BCL-XL/BCL-XS alternative splicing were performed in A549 and H1299 cells. In vivo radiosensitivity was evaluated in BALB/c nude mice bearing subcutaneous A549 xenografts (n = 5 mice per group) exposed to 10 Gy local irradiation.',
        ),
        p(
          'p7_abs_3',
          'Results: RBM15 was significantly upregulated in radioresistant NSCLC specimens (n = 86, P < 0.001) and predicted poor overall survival (HR = 1.94, 95% CI = 1.21–3.11, P = 0.006). Mechanistically, RBM15 installed m6A modification on SRSF1 mRNA, which was recognized by YTHDF1 to enhance SRSF1 translation, shifting BCL-X pre-mRNA splicing toward the anti-apoptotic BCL-XL isoform. In xenograft mice (n = 5 per group), RBM15 knockdown combined with 10 Gy RT markedly reduced tumor weight (0.32 ± 0.08 g vs 0.85 ± 0.14 g, P < 0.001).',
        ),
        h('p7_h_methods', 1, 'Materials and Methods'),
        p(
          'p7_m_1',
          'Clinical samples and animal models: Eighty-six paired NSCLC and adjacent normal tissues were obtained from patients undergoing resection. For xenograft assays, 5×10^6 shRBM15 or shNC A549 cells were injected subcutaneously into BALB/c nude mice (n = 5 mice per group) and irradiated with 10 Gy when tumors reached 100 mm³. Statistical analysis: Data from three independent in vitro replicates or animal cohorts were presented as mean ± SD and compared using Student t-test or one-way ANOVA.',
        ),
        h('p7_h_results', 1, 'Results'),
        p('p7_r_t1_cap', 'Table 1 Association of RBM15 expression with clinicopathological parameters in NSCLC patients (N=86)'),
        tbl('p7_tbl_1', [
          ['Parameter', 'Low RBM15 (n=41)', 'High RBM15 (n=45)', 'P value'],
          ['Lymph node metastasis, n (%)', '15 (36.6%)', '29 (64.4%)', '0.010'],
          ['Advanced TNM Stage III, n (%)', '14 (34.1%)', '27 (60.0%)', '0.016'],
        ]),
        h('p7_h_disc', 1, 'Discussion'),
        p(
          'p7_d_1',
          'Collectively, our study uncovers an epitranscriptomic RBM15-m6A-SRSF1-BCL-XL axis driving radioresistance in NSCLC and provides a potential therapeutic target for radiosensitization.',
        ),
      ],
    },
  },
]

function matchesOrganicError(
  comment: SynthesizedReviewComment,
  err: PaperSpec['known_organic_errors'][number],
): boolean {
  if (comment.subtype && comment.subtype === err.subtype) return true
  const blob = `${comment.sentence} ${comment.reason} ${comment.suggestion}`.toLowerCase()
  const matchedCount = err.match_keywords.filter(kw => blob.includes(kw.toLowerCase())).length
  return matchedCount >= Math.min(2, err.match_keywords.length)
}

function classifyCommentGroundTruth(
  paper: PaperSpec,
  comment: SynthesizedReviewComment,
): {
  is_true_positive: boolean
  matched_error_id: string | null
  false_positive_pattern: string | null
  clinician_rebuttal_template: string | null
} {
  for (const err of paper.known_organic_errors) {
    if (matchesOrganicError(comment, err)) {
      return {
        is_true_positive: true,
        matched_error_id: err.error_id,
        false_positive_pattern: null,
        clinician_rebuttal_template: null,
      }
    }
  }

  // Anything that is NOT one of the verified organic in-print errors is an ungrounded/false-positive critique!
  const blob = `${comment.sentence} ${comment.reason} ${comment.suggestion}`.toLowerCase()
  if (paper.family === 'observational_tte' || /\b(?:clone|clones|ccw|977|1242|ipcw|iptw|target\s+trial)\b/i.test(blob)) {
    return {
      is_true_positive: false,
      matched_error_id: null,
      false_positive_pattern: 'target_trial_emulation_ccw',
      clinician_rebuttal_template:
        '本研究采用 Hernán 目标试验模拟（Target Trial Emulation, TTE）的克隆-删失-加权（CCW）框架消除 6 周宽限期不死时间偏倚：Table 1 为基线唯一入组患者（n=400 vs 842，共 1242 例），Table 2 为时间零点克隆并在宽限期删失后的伪队列（clones=1242 vs 977），且按 TTE 规范优先报告非参数 Bootstrap 绝对风险差（RD）与相对风险（RR），并非样本量前后矛盾或漏报 HR。',
    }
  }
  if (paper.paper_id === 'P5_2025_NCRCN_EJC' || /single[\s-]arm|单臂|对照组|control\s+arm|simon|30\/35|85\.7%/i.test(blob)) {
    return {
      is_true_positive: false,
      matched_error_id: null,
      false_positive_pattern: 'single_arm_phase2_trial',
      clinician_rebuttal_template:
        '本研究为探索性单臂 II 期 Simon 两阶段临床试验（NCRCN），预设与历史对照（pCR 20%）比对，Table 1 仅展示单臂入组人群特征无需平行对照组及组间比较 P 值；且安全性/生存按全入组 ITT 人群（N=35）评估、术后病理缓解按实际接受根治性手术切除人群（n=30）评估，符合单臂新辅助试验规范。',
    }
  }
  if (paper.family === 'translational_radiobiology' || /mice|mouse|xenograft|tma|组织芯片|动物实验|荷瘤/i.test(blob)) {
    return {
      is_true_positive: false,
      matched_error_id: null,
      false_positive_pattern: 'translational_animal_tma_dual_cohort',
      clinician_rebuttal_template:
        '本转化医学研究同时包含临床患者组织芯片队列（TMA，N=86–92）与体内外独立功能实验：荷瘤小鼠肿瘤生长曲线（n=5/组）、生存观察队列（n=6/组）与流式免疫表型分析（n=3/组）属于不同独立实验批次，无需与临床 TMA 患者人数一致。',
    }
  }
  if (paper.paper_id === 'P6_2022_GREEN_J' || /256|185|91|non-ccr|筛查/i.test(blob)) {
    return {
      is_true_positive: false,
      matched_error_id: null,
      false_positive_pattern: 'multi_cohort_trial_structure',
      clinician_rebuttal_template:
        '本研究包含总诱导放化疗筛查人群（N=256）、达到临床完全缓解（cCR）的随机化对比队列（n=71：C组35例 vs S组36例）以及未达 cCR 的平行观察队列（n=185，其中91例接受挽救治疗），各表分母对应各自子队列，并非总样本量加总错误。',
    }
  }
  return {
    is_true_positive: false,
    matched_error_id: null,
    false_positive_pattern: 'multi_cohort_trial_structure',
    clinician_rebuttal_template:
      '本研究包含独立的空间多组学发现队列（n=42）、中心1训练队列（n=148）与中心2外部验证队列（n=64），且同时评估正态与偏态分布特征，各子队列样本量与指标符合多队列设计。',
  }
}

async function main() {
  const apiKey = loadApiKey()
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY not found in environment or .env')
  }
  console.log('[1/4] Initializing real LLM client (DeepSeek-V3 via Anthropic Messages API)...')
  const rawComplete = makeComplete({
    upstream: 'https://api.deepseek.com/anthropic/v1',
    apiKey,
    model: 'deepseek-chat',
    timeoutMs: 120_000,
  })
  if (!rawComplete) throw new Error('Failed to initialize Complete client')
  const llmCache = new Map<string, Promise<string>>()
  let liveApiCalls = 0
  const complete = (sys: string, usr: string): Promise<string> => {
    const key = `${sys}\n===SEP===\n${usr}`
    const hit = llmCache.get(key)
    if (hit) return hit
    liveApiCalls++
    const p = rawComplete(sys, usr)
    llmCache.set(key, p)
    return p
  }

  // In-memory store & Documents mock for ClaimService
  const docMap = new Map<string, ReturnType<typeof schema.nodeFromJSON>>()
  const activeMemoriesByOwner = new Map<string, Array<{ id: string; content: string; status: string }>>()
  const executionSignals: Array<Record<string, unknown>> = []

  for (const paper of SEVEN_PAPERS) {
    docMap.set(paper.paper_id, schema.nodeFromJSON(paper.doc_json))
  }

  const mockStore = {
    getDoc: (id: string) => (docMap.has(id) ? { id, owner: 'prof_qian_team', deleted_at: null } : null),
    listMeasurements: () => [],
    listCitations: () => [],
    listClaimChecks: () => [],
    putClaimCheck: () => {},
    listMemories: (owner: string) => activeMemoriesByOwner.get(owner) ?? [],
    addMemory: (entry: { owner: string; content: string; kind: string; status?: string }) => {
      const list = activeMemoriesByOwner.get(entry.owner) ?? []
      const item = { id: `mem_${list.length + 1}`, content: entry.content, status: entry.status ?? 'active' }
      list.push(item)
      activeMemoriesByOwner.set(entry.owner, list)
      return item
    },
    addExecutionSignal: (sig: Record<string, unknown>) => {
      const item = { id: `sig_${executionSignals.length + 1}`, ...sig }
      executionSignals.push(item)
      return item
    },
    addComment: ({ doc_id, node_id, snippet }: { doc_id: string; node_id: string; snippet: string }) => ({
      id: `c_${doc_id}_${Math.random().toString(36).slice(2, 8)}`,
      doc_id,
      node_id,
      snippet,
    }),
    addReply: () => {},
  }

  const mockDocs = {
    get: (id: string) => docMap.get(id)!,
    rev: () => 1,
    commit: (id: string, nextDoc: ReturnType<typeof schema.nodeFromJSON>) => {
      docMap.set(id, nextDoc)
    },
    store: mockStore,
  }

  const claimService = new ClaimService(mockDocs as any, {} as any, null)
  const modes: DeepReviewMode[] = ['zero_shot', 'pass_at_k', 'pat_baseline', 'heurion_deep']

  const rawResultsByMode: Record<string, Record<string, FourStageReviewResult>> = {
    zero_shot: {},
    pass_at_k: {},
    pat_baseline: {},
    heurion_deep: {},
    heurion_evolved_round2: {},
    heurion_evolved_cross_paper: {},
  }

  for (const mode of modes) {
    console.log(`\n[2/4] Running mode="${mode}" across all 7 representative oncology papers in parallel...`)
    await Promise.all(
      SEVEN_PAPERS.map(async paper => {
        const res = await claimService.runFourStageDeepReview(paper.paper_id, {
          mode,
          complete,
          owner: 'prof_qian_team',
          passK: 3,
        })
        rawResultsByMode[mode]![paper.paper_id] = res
        console.log(
          `  - [${mode}] ${paper.paper_id}: Stage 3 raw=${res.stage3_raw_candidates} -> Stage 4 deduplicated=${res.stage4_deduplicated_comments.length}`,
        )
      }),
    )
  }

  // [3/4] Now evaluate Round 1 -> Round 2 Self-Evolution (Intra-Paper) & Cross-Paper Family Transfer
  console.log('\n[3/4] Running Comment-Driven Self-Evolution (Track A Narrow + Track B Procedural)...')
  const msAdapter = getDomainSkillAdapter('manuscript')
  const synthesizedRulesLog: Array<{
    from_paper_id: string
    comment_id: string
    original_ai_false_positive_reason: string
    clinician_rebuttal: string
    synthesized_rule: string
    pattern_key: string
    instance_leakage_check: string | null
  }> = []

  // First, evaluate Cross-Paper Transfer & Intra-Paper Round 2 Revision:
  // Order within families:
  // - Family 1 (Clinical Trials / Multi-Cohort): P4 -> P6 -> P5
  // - Family 2 (Observational TTE): P3 (Round 1 -> Round 2)
  // - Family 3 (Translational Radiobiology): P1 -> P2 -> P7
  activeMemoriesByOwner.set('prof_qian_team', [])

  const transferOrder = [
    'P4_2025_JITC',
    'P6_2022_GREEN_J',
    'P5_2025_NCRCN_EJC',
    'P3_2026_eClinicalMedicine',
    'P1_2024_JTM_BIBR1532',
    'P2_2024_JTM_PINX1',
    'P7_2022_CDDisc',
  ]

  for (const paperId of transferOrder) {
    const paper = SEVEN_PAPERS.find(p => p.paper_id === paperId)!
    // 1) Run heurion_evolved BEFORE this paper's own clinician rebuttals (measuring cross-paper transfer from prior papers!)
    const crossRes = await claimService.runFourStageDeepReview(paper.paper_id, {
      mode: 'heurion_evolved',
      complete,
      owner: 'prof_qian_team',
    })
    rawResultsByMode.heurion_evolved_cross_paper![paper.paper_id] = crossRes

    // 2) Clinician reviews the comments from heurion_deep (and pat_baseline) on this paper and submits rebuttals on False Positives
    const baseComments = [
      ...(rawResultsByMode.heurion_deep![paper.paper_id]?.stage4_deduplicated_comments ?? []),
      ...(rawResultsByMode.pat_baseline![paper.paper_id]?.stage4_deduplicated_comments ?? []),
    ]
    for (const c of baseComments) {
      const evalInfo = classifyCommentGroundTruth(paper, c)
      if (!evalInfo.is_true_positive && evalInfo.clinician_rebuttal_template) {
        const { patternKey, rule } = synthesizeSanitizedBoundaryRule(evalInfo.clinician_rebuttal_template, {
          sentence: c.sentence,
          category: c.category,
          reason: c.reason,
        })
        const leak = msAdapter.hasInstanceLeakage(rule)
        const evo = claimService.evolveFromReviewComment(paper.paper_id, c.id, {
          rebuttalText: evalInfo.clinician_rebuttal_template,
          sentence: c.sentence,
          issueCategory: c.category,
          owner: 'prof_qian_team',
        })
        if (evo.memoryId) {
          synthesizedRulesLog.push({
            from_paper_id: paper.paper_id,
            comment_id: c.id,
            original_ai_false_positive_reason: c.reason,
            clinician_rebuttal: evalInfo.clinician_rebuttal_template,
            synthesized_rule: evo.synthesizedRule ?? rule,
            pattern_key: patternKey,
            instance_leakage_check: leak,
          })
        }
      } else if (evalInfo.is_true_positive) {
        claimService.evolveFromReviewComment(paper.paper_id, c.id, {
          acceptedFix: true,
          sentence: c.sentence,
          issueCategory: c.category,
          owner: 'prof_qian_team',
        })
      }
    }

    // 3) Run heurion_evolved AFTER clinician rebuttals (Round 2 Revision re-review on the same paper)
    const round2Res = await claimService.runFourStageDeepReview(paper.paper_id, {
      mode: 'heurion_evolved',
      complete,
      owner: 'prof_qian_team',
    })
    rawResultsByMode.heurion_evolved_round2![paper.paper_id] = round2Res
  }

  // [4/4] Compute aggregate metrics across all modes and per-paper detailed breakdown
  const totalKnownErrors = SEVEN_PAPERS.reduce((acc, p) => acc + p.known_organic_errors.length, 0)
  const modeSummary: Record<string, any> = {}

  for (const modeKey of Object.keys(rawResultsByMode)) {
    let totalComments = 0
    let groundedComments = 0
    let ungroundedFalsePositives = 0
    const caughtErrorIds = new Set<string>()
    const perPaper: Record<string, any> = {}

    for (const paper of SEVEN_PAPERS) {
      const res = rawResultsByMode[modeKey]![paper.paper_id]!
      const comments = res.stage4_deduplicated_comments
      const annotated = comments.map(c => {
        const gt = classifyCommentGroundTruth(paper, c)
        if (gt.is_true_positive && gt.matched_error_id) {
          caughtErrorIds.add(`${paper.paper_id}:${gt.matched_error_id}`)
        }
        return {
          ...c,
          ground_truth: gt,
        }
      })

      const tpComments = annotated.filter(a => a.ground_truth.is_true_positive)
      const fpComments = annotated.filter(a => !a.ground_truth.is_true_positive)
      const paperCaughtUnique = new Set(tpComments.map(a => a.ground_truth.matched_error_id).filter(Boolean)).size

      totalComments += annotated.length
      groundedComments += tpComments.length
      ungroundedFalsePositives += fpComments.length

      perPaper[paper.paper_id] = {
        paper_id: paper.paper_id,
        short_name: paper.short_name,
        known_errors_total: paper.known_organic_errors.length,
        known_errors_caught: paperCaughtUnique,
        total_comments: annotated.length,
        grounded_true_positive_comments: tpComments.length,
        ungrounded_false_positive_comments: fpComments.length,
        stage3_raw_candidates: res.stage3_raw_candidates,
        comments: annotated,
      }
    }

    const recallPct = totalKnownErrors > 0 ? Number(((caughtErrorIds.size / totalKnownErrors) * 100).toFixed(1)) : 0
    const groundedPrecisionPct =
      totalComments > 0 ? Number(((groundedComments / totalComments) * 100).toFixed(1)) : 100.0
    const f1Pct =
      recallPct + groundedPrecisionPct > 0
        ? Number(((2 * recallPct * groundedPrecisionPct) / (recallPct + groundedPrecisionPct)).toFixed(1))
        : 0

    modeSummary[modeKey] = {
      mode: modeKey,
      total_known_organic_errors: totalKnownErrors,
      unique_organic_errors_caught: caughtErrorIds.size,
      recall_pct: recallPct,
      total_comments_emitted: totalComments,
      grounded_comments_count: groundedComments,
      ungrounded_false_positives_count: ungroundedFalsePositives,
      grounded_precision_pct: groundedPrecisionPct,
      f1_score: f1Pct,
      per_paper: perPaper,
    }
  }

  const outputPayload = {
    generated_at: new Date().toISOString(),
    llm_model: 'deepseek-chat (DeepSeek-V3, temperature=0)',
    papers_count: SEVEN_PAPERS.length,
    total_verified_organic_errors: totalKnownErrors,
    mode_summary: modeSummary,
    synthesized_boundary_rules: synthesizedRulesLog,
    procedural_signals_recorded: executionSignals.length,
  }

  const outDir = resolve(repoRoot, 'paper/results')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, 'seven_papers_real_review.json')
  writeFileSync(outPath, JSON.stringify(outputPayload, null, 2), 'utf8')

  console.log('\n====================================================================')
  console.log('REAL 7-PAPER DEEP REVIEW & SELF-EVOLUTION RESULTS SUMMARY')
  console.log('====================================================================')
  for (const [mKey, mVal] of Object.entries(modeSummary)) {
    console.log(
      `- ${mKey.padEnd(28)} | Recall: ${mVal.unique_organic_errors_caught}/${mVal.total_known_organic_errors} (${mVal.recall_pct}%) | Grounded Precision: ${mVal.grounded_comments_count}/${mVal.total_comments_emitted} (${mVal.grounded_precision_pct}%) | False Positives: ${mVal.ungrounded_false_positives_count} | F1: ${mVal.f1_score}%`,
    )
  }
  console.log(`Saved full JSON output to: ${outPath}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
