/**
 * 肺结节临床指南规则引擎（PRD T3.5：ACR Lung-RADS v2022 & Fleischner Society 2017）
 *
 * 设计约束：
 * 1. 纯确定性规则计算，不调用外部 LLM，不编造测值；
 * 2. 所有分级与随访周期建议一律显式标注 `status_label: "规则推算，待医生确认"` 与 `requires_confirmation: true`；
 * 3. 每条结论附带可核查的指南条款引用（`clause_citation`），供结构化报告草稿（T3.2/T3.5）与前端展示。
 */

export const GUIDELINE_PROVENANCE_LABEL = '规则推算，待医生确认' as const;

export type NoduleDensityType = 'solid' | 'part_solid' | 'pure_ggo' | 'calcified_benign' | 'none';

export type LungRadsCategory = '0' | '1' | '2' | '3' | '4A' | '4B';

export interface LungRadsInput {
  nodule_type?: NoduleDensityType | string | null;
  mean_diameter_mm?: number | null;
  solid_core_diameter_mm?: number | null;
  scan_context?: 'baseline' | 'followup';
  is_new?: boolean;
  /** 12 个月内平均径增长（mm）；ACR Lung-RADS v2022 定义 > 1.5 mm 为明确增大（growing） */
  delta_mean_diameter_mm?: number | null;
  /** 12 个月内实性成分直径增长（mm）；> 1.5 mm 为实性成分增大 */
  delta_solid_core_mm?: number | null;
  /** 前次分级（用于稳定 ≥ 3 个月时的降级判定） */
  prior_category?: LungRadsCategory | null;
  /** 结节持续稳定月数 */
  stable_months?: number | null;
}

export interface LungRadsResult {
  guideline: 'ACR Lung-RADS v2022';
  category: LungRadsCategory;
  category_label_zh: string;
  recommendation_zh: string;
  follow_up_months: number | null;
  imaging_modality: string;
  clause_citation: string;
  rationale_zh: string;
  status_label: typeof GUIDELINE_PROVENANCE_LABEL;
  requires_confirmation: true;
}

export interface FleischnerInput {
  nodule_type?: NoduleDensityType | string | null;
  mean_diameter_mm?: number | null;
  solid_core_diameter_mm?: number | null;
  multiplicity?: 'single' | 'multiple';
  risk_level?: 'low' | 'high';
  /** 患者年龄（岁）；Fleischner 2017 不适用于 < 35 岁人群 */
  age_years?: number | null;
  /** 是否有已知肺外恶性肿瘤史（有则不适用 Fleischner 2017） */
  has_known_malignancy?: boolean;
  /** 是否存在免疫抑制状态（有则不适用 Fleischner 2017） */
  is_immunocompromised?: boolean;
  /** 是否为肺癌低剂量 CT 筛查人群（筛查人群应使用 Lung-RADS） */
  is_screening?: boolean;
}

export interface FleischnerResult {
  guideline: 'Fleischner Society 2017';
  applicable: boolean;
  exclusion_reason_zh: string | null;
  recommendation_zh: string;
  follow_up_months_range: [number, number] | null;
  clause_citation: string;
  rationale_zh: string;
  status_label: typeof GUIDELINE_PROVENANCE_LABEL;
  requires_confirmation: true;
}

export interface NoduleGuidelineInput extends LungRadsInput, FleischnerInput {}

export interface NoduleGuidelineSummary {
  lung_rads_2022: LungRadsResult;
  fleischner_2017: FleischnerResult;
  status_label: typeof GUIDELINE_PROVENANCE_LABEL;
  requires_confirmation: true;
}

const LUNG_RADS_GROWTH_THRESHOLD_MM = 1.5;

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * 按 ACR Lung-RADS v2022 规则评估单个（或主导）肺结节的分类与处置建议。
 */
export function evaluateLungRads2022(input: LungRadsInput): LungRadsResult {
  const base = {
    guideline: 'ACR Lung-RADS v2022' as const,
    status_label: GUIDELINE_PROVENANCE_LABEL,
    requires_confirmation: true as const,
  };

  const type = (input.nodule_type || '').toLowerCase().trim();
  if (type === 'none') {
    return {
      ...base,
      category: '1',
      category_label_zh: '1 类（阴性：未见肺结节）',
      recommendation_zh: '12 个月后继续年度低剂量螺旋 CT（LDCT）筛查',
      follow_up_months: 12,
      imaging_modality: 'LDCT',
      clause_citation: 'ACR Lung-RADS v2022, Category 1 (Negative: No lung nodules)',
      rationale_zh: '未检出肺结节',
    };
  }
  if (type === 'calcified_benign') {
    return {
      ...base,
      category: '1',
      category_label_zh: '1 类（阴性：具有明确良性钙化特征的结节）',
      recommendation_zh: '12 个月后继续年度低剂量螺旋 CT（LDCT）筛查',
      follow_up_months: 12,
      imaging_modality: 'LDCT',
      clause_citation: 'ACR Lung-RADS v2022, Category 1 (Definitely benign nodule: complete/central/popcorn/concentric calcification)',
      rationale_zh: '结节表现为典型良性钙化',
    };
  }

  if (!isFinitePositive(input.mean_diameter_mm) || !['solid', 'part_solid', 'pure_ggo'].includes(type)) {
    return {
      ...base,
      category: '0',
      category_label_zh: '0 类（信息不完整，待补充径线或分型）',
      recommendation_zh: '需补充结节平均径与密度分型（实性 / 部分实性 / 纯磨玻璃）后再行分级',
      follow_up_months: null,
      imaging_modality: 'LDCT',
      clause_citation: 'ACR Lung-RADS v2022, Category 0 (Incomplete / prior or measurement needed)',
      rationale_zh: '缺少有效的结节平均径或密度分型（solid / part_solid / pure_ggo）',
    };
  }

  const d = round1(input.mean_diameter_mm);
  const solidCore = isFinitePositive(input.solid_core_diameter_mm) ? round1(input.solid_core_diameter_mm) : null;
  const isFollowup = input.scan_context === 'followup' || Boolean(input.is_new) || input.delta_mean_diameter_mm != null;
  const isNew = Boolean(input.is_new);
  const isGrowing =
    typeof input.delta_mean_diameter_mm === 'number' &&
    Number.isFinite(input.delta_mean_diameter_mm) &&
    input.delta_mean_diameter_mm > LUNG_RADS_GROWTH_THRESHOLD_MM;
  const isSolidGrowing =
    typeof input.delta_solid_core_mm === 'number' &&
    Number.isFinite(input.delta_solid_core_mm) &&
    input.delta_solid_core_mm > LUNG_RADS_GROWTH_THRESHOLD_MM;

  // Lung-RADS v2022 Step-down 规则：原 3 类或 4A 类结节随访 ≥ 3 个月保持稳定，可分别降为 2 类或 3 类
  if (
    isFollowup &&
    !isNew &&
    !isGrowing &&
    !isSolidGrowing &&
    typeof input.stable_months === 'number' &&
    input.stable_months >= 3
  ) {
    if (input.prior_category === '3') {
      return {
        ...base,
        category: '2',
        category_label_zh: '2 类（原 3 类结节随访 ≥ 3 个月稳定降级）',
        recommendation_zh: '12 个月后继续年度 LDCT 筛查',
        follow_up_months: 12,
        imaging_modality: 'LDCT',
        clause_citation: 'ACR Lung-RADS v2022, Category 2 (Category 3 nodule stable at ≥ 3-month follow-up CT)',
        rationale_zh: `原 3 类结节经 ${input.stable_months} 个月随访稳定（平均径 ${d} mm），按 v2022 规则降为 2 类`,
      };
    }
    if (input.prior_category === '4A') {
      return {
        ...base,
        category: '3',
        category_label_zh: '3 类（原 4A 类结节随访 ≥ 3 个月稳定降级）',
        recommendation_zh: '6 个月后行 LDCT 复查',
        follow_up_months: 6,
        imaging_modality: 'LDCT',
        clause_citation: 'ACR Lung-RADS v2022, Category 3 (Category 4A nodule stable at ≥ 3-month follow-up CT)',
        rationale_zh: `原 4A 类结节经 ${input.stable_months} 个月随访稳定（平均径 ${d} mm），按 v2022 规则降为 3 类`,
      };
    }
  }

  // 1) 实性结节 (solid)
  if (type === 'solid') {
    if (isNew) {
      if (d < 4) {
        return {
          ...base,
          category: '2',
          category_label_zh: '2 类（良性表现或行为：新发实性结节 < 4 mm）',
          recommendation_zh: '12 个月后继续年度 LDCT 筛查',
          follow_up_months: 12,
          imaging_modality: 'LDCT',
          clause_citation: 'ACR Lung-RADS v2022, Category 2 (Solid nodule: new < 4 mm)',
          rationale_zh: `随访新发实性结节，平均径 ${d} mm（< 4 mm）`,
        };
      }
      if (d < 6) {
        return {
          ...base,
          category: '3',
          category_label_zh: '3 类（可能良性：新发实性结节 4–<6 mm）',
          recommendation_zh: '6 个月后行 LDCT 复查',
          follow_up_months: 6,
          imaging_modality: 'LDCT',
          clause_citation: 'ACR Lung-RADS v2022, Category 3 (Solid nodule: new 4 to < 6 mm)',
          rationale_zh: `随访新发实性结节，平均径 ${d} mm（4–<6 mm）`,
        };
      }
      if (d < 8) {
        return {
          ...base,
          category: '4A',
          category_label_zh: '4A 类（可疑：新发实性结节 6–<8 mm）',
          recommendation_zh: '3 个月后行 LDCT 复查；若实性成分 ≥ 8 mm 可考虑 PET/CT',
          follow_up_months: 3,
          imaging_modality: 'LDCT / PET-CT',
          clause_citation: 'ACR Lung-RADS v2022, Category 4A (Solid nodule: new 6 to < 8 mm)',
          rationale_zh: `随访新发实性结节，平均径 ${d} mm（6–<8 mm）`,
        };
      }
      return {
        ...base,
        category: '4B',
        category_label_zh: '4B 类（高度可疑：新发实性结节 ≥ 8 mm）',
        recommendation_zh: '建议行诊断性胸部 CT（平扫或增强），可根据恶性概率考虑 PET/CT、组织活检或 MDT 会诊',
        follow_up_months: 0,
        imaging_modality: 'Diagnostic CT / PET-CT / Biopsy',
        clause_citation: 'ACR Lung-RADS v2022, Category 4B (Solid nodule: new ≥ 8 mm)',
        rationale_zh: `随访新发实性结节，平均径 ${d} mm（≥ 8 mm）`,
      };
    }

    if (isGrowing) {
      const delta = round1(input.delta_mean_diameter_mm!);
      if (d < 8) {
        return {
          ...base,
          category: '4A',
          category_label_zh: '4A 类（可疑：增大实性结节 < 8 mm）',
          recommendation_zh: '3 个月后行 LDCT 复查',
          follow_up_months: 3,
          imaging_modality: 'LDCT',
          clause_citation: 'ACR Lung-RADS v2022, Category 4A (Solid nodule: growing < 8 mm, growth > 1.5 mm)',
          rationale_zh: `实性结节平均径增长 +${delta} mm（> 1.5 mm），当前平均径 ${d} mm（< 8 mm）`,
        };
      }
      return {
        ...base,
        category: '4B',
        category_label_zh: '4B 类（高度可疑：增大实性结节 ≥ 8 mm）',
        recommendation_zh: '建议行诊断性胸部 CT（平扫或增强），结合恶性概率考虑 PET/CT、组织活检或 MDT 会诊',
        follow_up_months: 0,
        imaging_modality: 'Diagnostic CT / PET-CT / Biopsy',
        clause_citation: 'ACR Lung-RADS v2022, Category 4B (Solid nodule: growing ≥ 8 mm, growth > 1.5 mm)',
        rationale_zh: `实性结节平均径增长 +${delta} mm（> 1.5 mm），当前平均径 ${d} mm（≥ 8 mm）`,
      };
    }

    if (d < 6) {
      return {
        ...base,
        category: '2',
        category_label_zh: '2 类（良性表现或行为：实性结节 < 6 mm）',
        recommendation_zh: '12 个月后继续年度 LDCT 筛查',
        follow_up_months: 12,
        imaging_modality: 'LDCT',
        clause_citation: 'ACR Lung-RADS v2022, Category 2 (Solid nodule: < 6 mm at baseline)',
        rationale_zh: `实性结节平均径 ${d} mm（< 6 mm）`,
      };
    }
    if (d < 8) {
      return {
        ...base,
        category: '3',
        category_label_zh: '3 类（可能良性：实性结节 6–<8 mm）',
        recommendation_zh: '6 个月后行 LDCT 复查',
        follow_up_months: 6,
        imaging_modality: 'LDCT',
        clause_citation: 'ACR Lung-RADS v2022, Category 3 (Solid nodule: ≥ 6 to < 8 mm at baseline)',
        rationale_zh: `实性结节平均径 ${d} mm（6–<8 mm）`,
      };
    }
    if (d < 15) {
      return {
        ...base,
        category: '4A',
        category_label_zh: '4A 类（可疑：实性结节 8–<15 mm）',
        recommendation_zh: '3 个月后行 LDCT 复查；实性成分 ≥ 8 mm 时可考虑 PET/CT',
        follow_up_months: 3,
        imaging_modality: 'LDCT / PET-CT',
        clause_citation: 'ACR Lung-RADS v2022, Category 4A (Solid nodule: ≥ 8 to < 15 mm at baseline)',
        rationale_zh: `实性结节平均径 ${d} mm（8–<15 mm）`,
      };
    }
    return {
      ...base,
      category: '4B',
      category_label_zh: '4B 类（高度可疑：实性结节 ≥ 15 mm）',
      recommendation_zh: '建议行诊断性胸部 CT（平扫或增强），结合恶性概率考虑 PET/CT、组织活检或 MDT 会诊',
      follow_up_months: 0,
      imaging_modality: 'Diagnostic CT / PET-CT / Biopsy',
      clause_citation: 'ACR Lung-RADS v2022, Category 4B (Solid nodule: ≥ 15 mm at baseline)',
      rationale_zh: `实性结节平均径 ${d} mm（≥ 15 mm）`,
    };
  }

  // 2) 部分实性结节 (part_solid)
  if (type === 'part_solid') {
    const sc = solidCore ?? 0;
    if (isNew) {
      if (d < 6 && sc < 4) {
        return {
          ...base,
          category: '3',
          category_label_zh: '3 类（可能良性：新发部分实性结节总径 < 6 mm）',
          recommendation_zh: '6 个月后行 LDCT 复查',
          follow_up_months: 6,
          imaging_modality: 'LDCT',
          clause_citation: 'ACR Lung-RADS v2022, Category 3 (Part-solid nodule: new < 6 mm total diameter)',
          rationale_zh: `随访新发部分实性结节，总平均径 ${d} mm（< 6 mm）`,
        };
      }
      if (sc < 4) {
        return {
          ...base,
          category: '4A',
          category_label_zh: '4A 类（可疑：新发部分实性结节，实性成分 < 4 mm）',
          recommendation_zh: '3 个月后行 LDCT 复查',
          follow_up_months: 3,
          imaging_modality: 'LDCT',
          clause_citation: 'ACR Lung-RADS v2022, Category 4A (Part-solid nodule: new or growing solid component < 4 mm)',
          rationale_zh: `随访新发部分实性结节，总平均径 ${d} mm，实性成分 ${sc} mm（< 4 mm）`,
        };
      }
      return {
        ...base,
        category: '4B',
        category_label_zh: '4B 类（高度可疑：新发部分实性结节，实性成分 ≥ 4 mm）',
        recommendation_zh: '建议行诊断性胸部 CT，结合恶性概率考虑 PET/CT（实性成分 ≥ 8 mm）、活检或 MDT 会诊',
        follow_up_months: 0,
        imaging_modality: 'Diagnostic CT / PET-CT / Biopsy',
        clause_citation: 'ACR Lung-RADS v2022, Category 4B (Part-solid nodule: new or growing solid component ≥ 4 mm)',
        rationale_zh: `随访新发部分实性结节，总平均径 ${d} mm，实性成分 ${sc} mm（≥ 4 mm）`,
      };
    }

    if (isSolidGrowing) {
      if (sc < 4) {
        return {
          ...base,
          category: '4A',
          category_label_zh: '4A 类（可疑：部分实性结节的实性成分增大且 < 4 mm）',
          recommendation_zh: '3 个月后行 LDCT 复查',
          follow_up_months: 3,
          imaging_modality: 'LDCT',
          clause_citation: 'ACR Lung-RADS v2022, Category 4A (Part-solid nodule: growing solid component < 4 mm)',
          rationale_zh: `部分实性结节实性成分增大（+${round1(input.delta_solid_core_mm!)} mm），当前实性成分 ${sc} mm（< 4 mm）`,
        };
      }
      return {
        ...base,
        category: '4B',
        category_label_zh: '4B 类（高度可疑：部分实性结节的实性成分增大且 ≥ 4 mm）',
        recommendation_zh: '建议行诊断性胸部 CT，结合恶性概率考虑 PET/CT、活检或手术评估',
        follow_up_months: 0,
        imaging_modality: 'Diagnostic CT / PET-CT / Biopsy',
        clause_citation: 'ACR Lung-RADS v2022, Category 4B (Part-solid nodule: growing solid component ≥ 4 mm)',
        rationale_zh: `部分实性结节实性成分增大（+${round1(input.delta_solid_core_mm!)} mm），当前实性成分 ${sc} mm（≥ 4 mm）`,
      };
    }

    if (d < 6) {
      return {
        ...base,
        category: '2',
        category_label_zh: '2 类（良性表现或行为：基线部分实性结节总径 < 6 mm）',
        recommendation_zh: '12 个月后继续年度 LDCT 筛查',
        follow_up_months: 12,
        imaging_modality: 'LDCT',
        clause_citation: 'ACR Lung-RADS v2022, Category 2 (Part-solid nodule: < 6 mm total diameter at baseline)',
        rationale_zh: `部分实性结节总平均径 ${d} mm（< 6 mm）`,
      };
    }
    if (sc < 6) {
      return {
        ...base,
        category: '3',
        category_label_zh: '3 类（可能良性：部分实性结节总径 ≥ 6 mm 且实性成分 < 6 mm）',
        recommendation_zh: '6 个月后行 LDCT 复查',
        follow_up_months: 6,
        imaging_modality: 'LDCT',
        clause_citation: 'ACR Lung-RADS v2022, Category 3 (Part-solid nodule: ≥ 6 mm total diameter with solid component < 6 mm)',
        rationale_zh: `部分实性结节总平均径 ${d} mm（≥ 6 mm），实性成分 ${sc} mm（< 6 mm）`,
      };
    }
    if (sc < 8) {
      return {
        ...base,
        category: '4A',
        category_label_zh: '4A 类（可疑：部分实性结节实性成分 6–<8 mm）',
        recommendation_zh: '3 个月后行 LDCT 复查',
        follow_up_months: 3,
        imaging_modality: 'LDCT',
        clause_citation: 'ACR Lung-RADS v2022, Category 4A (Part-solid nodule: ≥ 6 mm total diameter with solid component 6 to < 8 mm)',
        rationale_zh: `部分实性结节总平均径 ${d} mm，实性成分 ${sc} mm（6–<8 mm）`,
      };
    }
    return {
      ...base,
      category: '4B',
      category_label_zh: '4B 类（高度可疑：部分实性结节实性成分 ≥ 8 mm）',
      recommendation_zh: '建议行诊断性胸部 CT，可考虑 PET/CT、组织活检或 MDT 会诊',
      follow_up_months: 0,
      imaging_modality: 'Diagnostic CT / PET-CT / Biopsy',
      clause_citation: 'ACR Lung-RADS v2022, Category 4B (Part-solid nodule: solid component ≥ 8 mm)',
      rationale_zh: `部分实性结节总平均径 ${d} mm，实性成分 ${sc} mm（≥ 8 mm）`,
    };
  }

  // 3) 纯磨玻璃结节 (pure_ggo / non-solid)
  if (d < 30) {
    return {
      ...base,
      category: '2',
      category_label_zh: '2 类（良性表现或行为：非实性/纯磨玻璃结节 < 30 mm）',
      recommendation_zh: '12 个月后继续年度 LDCT 筛查',
      follow_up_months: 12,
      imaging_modality: 'LDCT',
      clause_citation: 'ACR Lung-RADS v2022, Category 2 (Non-solid GGN: < 30 mm)',
      rationale_zh: `纯磨玻璃结节（GGN）平均径 ${d} mm（< 30 mm）`,
    };
  }
  if (isFollowup && !isNew && !isGrowing) {
    return {
      ...base,
      category: '2',
      category_label_zh: '2 类（良性表现或行为：纯磨玻璃结节 ≥ 30 mm 但稳定或缓慢生长）',
      recommendation_zh: '12 个月后继续年度 LDCT 筛查',
      follow_up_months: 12,
      imaging_modality: 'LDCT',
      clause_citation: 'ACR Lung-RADS v2022, Category 2 (Non-solid GGN: ≥ 30 mm unchanged or slowly growing)',
      rationale_zh: `纯磨玻璃结节平均径 ${d} mm（≥ 30 mm），随访稳定或缓慢生长`,
    };
  }
  return {
    ...base,
    category: '3',
    category_label_zh: '3 类（可能良性：基线或新发纯磨玻璃结节 ≥ 30 mm）',
    recommendation_zh: '6 个月后行 LDCT 复查',
    follow_up_months: 6,
    imaging_modality: 'LDCT',
    clause_citation: 'ACR Lung-RADS v2022, Category 3 (Non-solid GGN: ≥ 30 mm at baseline or new)',
    rationale_zh: `${isNew ? '随访新发' : '基线'}纯磨玻璃结节平均径 ${d} mm（≥ 30 mm）`,
  };
}

/**
 * 按 Fleischner Society 2017 偶发肺结节指南评估随访周期建议。
 */
export function evaluateFleischner2017(input: FleischnerInput): FleischnerResult {
  const base = {
    guideline: 'Fleischner Society 2017' as const,
    status_label: GUIDELINE_PROVENANCE_LABEL,
    requires_confirmation: true as const,
  };

  if (typeof input.age_years === 'number' && Number.isFinite(input.age_years) && input.age_years < 35) {
    return {
      ...base,
      applicable: false,
      exclusion_reason_zh: `患者年龄 ${input.age_years} 岁 < 35 岁，不适用 Fleischner 2017 指南（35 岁以下偶发肺结节多为感染性良性病变，应结合临床个体化处置）`,
      recommendation_zh: '不适用 Fleischner 2017 常规随访表，请结合临床感染或良性病因个体化评估',
      follow_up_months_range: null,
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Exclusion Criteria: Patients younger than 35 years',
      rationale_zh: '年龄 < 35 岁属 Fleischner 2017 指南排除人群',
    };
  }
  if (input.has_known_malignancy) {
    return {
      ...base,
      applicable: false,
      exclusion_reason_zh: '患者有已知恶性肿瘤史，不适用 Fleischner 2017 偶发结节指南（需按原发肿瘤分期/转移监测方案处置）',
      recommendation_zh: '不适用 Fleischner 2017，建议按原发肿瘤随访或肿瘤专科规范评估',
      follow_up_months_range: null,
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Exclusion Criteria: Known primary malignancy',
      rationale_zh: '已知恶性肿瘤病史属 Fleischner 2017 排除人群',
    };
  }
  if (input.is_immunocompromised) {
    return {
      ...base,
      applicable: false,
      exclusion_reason_zh: '患者处于免疫抑制状态，不适用 Fleischner 2017 偶发结节指南（短期机会性感染风险高）',
      recommendation_zh: '不适用 Fleischner 2017，建议结合抗感染及临床免疫状态个体化短期复查',
      follow_up_months_range: null,
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Exclusion Criteria: Immunocompromised patients',
      rationale_zh: '免疫抑制状态属 Fleischner 2017 排除人群',
    };
  }
  if (input.is_screening) {
    return {
      ...base,
      applicable: false,
      exclusion_reason_zh: '肺癌筛查人群不适用 Fleischner 2017 指南，请参考 ACR Lung-RADS v2022',
      recommendation_zh: '筛查人群请按 ACR Lung-RADS v2022 分级管理',
      follow_up_months_range: null,
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Exclusion Criteria: Lung cancer screening population',
      rationale_zh: '肺癌筛查人群应采用 Lung-RADS 标准',
    };
  }

  const type = (input.nodule_type || '').toLowerCase().trim();
  if (type === 'none' || type === 'calcified_benign') {
    return {
      ...base,
      applicable: true,
      exclusion_reason_zh: null,
      recommendation_zh: '无需常规随访',
      follow_up_months_range: null,
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Benign / No nodule',
      rationale_zh: type === 'none' ? '未检出结节' : '典型良性钙化结节',
    };
  }

  if (!isFinitePositive(input.mean_diameter_mm) || !['solid', 'part_solid', 'pure_ggo'].includes(type)) {
    return {
      ...base,
      applicable: false,
      exclusion_reason_zh: '缺少有效的结节平均径或密度分型（solid / part_solid / pure_ggo）',
      recommendation_zh: '待补充结节平均径与密度分型后评估',
      follow_up_months_range: null,
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243)',
      rationale_zh: '输入测值或密度分型不完整',
    };
  }

  const d = round1(input.mean_diameter_mm);
  const mult = input.multiplicity === 'multiple' ? 'multiple' : 'single';
  const risk = input.risk_level === 'high' ? 'high' : 'low';
  const riskZh = risk === 'high' ? '高危' : '低危';

  // Table 1: Solid nodules
  if (type === 'solid') {
    if (mult === 'single') {
      if (d < 6) {
        if (risk === 'low') {
          return {
            ...base,
            applicable: true,
            exclusion_reason_zh: null,
            recommendation_zh: '无需常规随访',
            follow_up_months_range: null,
            clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 1: Single solid nodule < 6 mm, low risk',
            rationale_zh: `单发实性结节，平均径 ${d} mm（< 6 mm），${riskZh}人群`,
          };
        }
        return {
          ...base,
          applicable: true,
          exclusion_reason_zh: null,
          recommendation_zh: '可选 12 个月 CT 随访（尤其结节形态可疑或位于上叶时）',
          follow_up_months_range: [12, 12],
          clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 1: Single solid nodule < 6 mm, high risk',
          rationale_zh: `单发实性结节，平均径 ${d} mm（< 6 mm），${riskZh}人群`,
        };
      }
      if (d <= 8) {
        if (risk === 'low') {
          return {
            ...base,
            applicable: true,
            exclusion_reason_zh: null,
            recommendation_zh: '6–12 个月行 CT 复查，随后根据稳定情况考虑 18–24 个月再次复查',
            follow_up_months_range: [6, 12],
            clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 1: Single solid nodule 6–8 mm, low risk',
            rationale_zh: `单发实性结节，平均径 ${d} mm（6–8 mm），${riskZh}人群`,
          };
        }
        return {
          ...base,
          applicable: true,
          exclusion_reason_zh: null,
          recommendation_zh: '6–12 个月行 CT 复查，随后于 18–24 个月再次行 CT 复查',
          follow_up_months_range: [6, 12],
          clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 1: Single solid nodule 6–8 mm, high risk',
          rationale_zh: `单发实性结节，平均径 ${d} mm（6–8 mm），${riskZh}人群`,
        };
      }
      return {
        ...base,
        applicable: true,
        exclusion_reason_zh: null,
        recommendation_zh: '建议考虑 3 个月 CT 复查、PET/CT 或组织活检',
        follow_up_months_range: [3, 3],
        clause_citation: `Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 1: Single solid nodule > 8 mm (${risk} risk)`,
        rationale_zh: `单发实性结节，平均径 ${d} mm（> 8 mm），${riskZh}人群`,
      };
    }

    // Multiple solid nodules
    if (d < 6) {
      if (risk === 'low') {
        return {
          ...base,
          applicable: true,
          exclusion_reason_zh: null,
          recommendation_zh: '无需常规随访',
          follow_up_months_range: null,
          clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 1: Multiple solid nodules < 6 mm, low risk',
          rationale_zh: `多发实性结节，主导结节平均径 ${d} mm（< 6 mm），${riskZh}人群`,
        };
      }
      return {
        ...base,
        applicable: true,
        exclusion_reason_zh: null,
        recommendation_zh: '可选 12 个月 CT 随访',
        follow_up_months_range: [12, 12],
        clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 1: Multiple solid nodules < 6 mm, high risk',
        rationale_zh: `多发实性结节，主导结节平均径 ${d} mm（< 6 mm），${riskZh}人群`,
      };
    }
    if (risk === 'low') {
      return {
        ...base,
        applicable: true,
        exclusion_reason_zh: null,
        recommendation_zh: '3–6 个月行 CT 复查，随后考虑 18–24 个月复查（以最可疑/最大结节为准）',
        follow_up_months_range: [3, 6],
        clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 1: Multiple solid nodules ≥ 6 mm, low risk',
        rationale_zh: `多发实性结节，主导结节平均径 ${d} mm（≥ 6 mm），${riskZh}人群`,
      };
    }
    return {
      ...base,
      applicable: true,
      exclusion_reason_zh: null,
      recommendation_zh: '3–6 个月行 CT 复查，随后于 18–24 个月再次行 CT 复查（以最可疑/最大结节为准）',
      follow_up_months_range: [3, 6],
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 1: Multiple solid nodules ≥ 6 mm, high risk',
      rationale_zh: `多发实性结节，主导结节平均径 ${d} mm（≥ 6 mm），${riskZh}人群`,
    };
  }

  // Table 2: Subsolid nodules (pure_ggo & part_solid)
  if (mult === 'multiple') {
    if (d < 6) {
      return {
        ...base,
        applicable: true,
        exclusion_reason_zh: null,
        recommendation_zh: '3–6 个月行 CT 复查；若稳定，根据临床风险考虑第 2 年与第 4 年 CT 随访',
        follow_up_months_range: [3, 6],
        clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 2: Multiple subsolid nodules < 6 mm',
        rationale_zh: `多发亚实性结节（${type}），主导结节平均径 ${d} mm（< 6 mm）`,
      };
    }
    return {
      ...base,
      applicable: true,
      exclusion_reason_zh: null,
      recommendation_zh: '3–6 个月行 CT 复查，后续随访周期由最可疑的主导结节决定',
      follow_up_months_range: [3, 6],
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 2: Multiple subsolid nodules ≥ 6 mm',
      rationale_zh: `多发亚实性结节（${type}），主导结节平均径 ${d} mm（≥ 6 mm）`,
    };
  }

  // Single pure GGO
  if (type === 'pure_ggo') {
    if (d < 6) {
      return {
        ...base,
        applicable: true,
        exclusion_reason_zh: null,
        recommendation_zh: '无需常规随访（若高危或径线接近 6 mm 且形态可疑，可考虑 2 年及 4 年随访）',
        follow_up_months_range: null,
        clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 2: Single ground-glass nodule < 6 mm',
        rationale_zh: `单发纯磨玻璃结节（GGN），平均径 ${d} mm（< 6 mm）`,
      };
    }
    return {
      ...base,
      applicable: true,
      exclusion_reason_zh: null,
      recommendation_zh: '6–12 个月行 CT 复查以确认持续存在；若持续存在且稳定，每 2 年行 CT 复查直至满 5 年',
      follow_up_months_range: [6, 12],
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 2: Single ground-glass nodule ≥ 6 mm',
      rationale_zh: `单发纯磨玻璃结节（GGN），平均径 ${d} mm（≥ 6 mm）`,
    };
  }

  // Single part-solid
  const sc = isFinitePositive(input.solid_core_diameter_mm) ? round1(input.solid_core_diameter_mm) : 0;
  if (d < 6) {
    return {
      ...base,
      applicable: true,
      exclusion_reason_zh: null,
      recommendation_zh: '无需常规随访',
      follow_up_months_range: null,
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 2: Single part-solid nodule < 6 mm',
      rationale_zh: `单发部分实性结节，总平均径 ${d} mm（< 6 mm）`,
    };
  }
  if (sc >= 6) {
    return {
      ...base,
      applicable: true,
      exclusion_reason_zh: null,
      recommendation_zh: '实性成分 ≥ 6 mm 高度可疑，建议 3–6 个月短期 CT 确认或直接考虑 PET/CT、活检、手术切除评估',
      follow_up_months_range: [3, 6],
      clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 2: Single part-solid nodule ≥ 6 mm with solid component ≥ 6 mm',
      rationale_zh: `单发部分实性结节，总平均径 ${d} mm（≥ 6 mm），实性成分 ${sc} mm（≥ 6 mm）`,
    };
  }
  return {
    ...base,
    applicable: true,
    exclusion_reason_zh: null,
    recommendation_zh: '3–6 个月行 CT 复查以确认持续存在；若持续存在且实性成分仍 < 6 mm，每年行 CT 随访持续 5 年',
    follow_up_months_range: [3, 6],
    clause_citation: 'Fleischner Society 2017 (MacMahon et al., Radiology 2017;284:228-243), Table 2: Single part-solid nodule ≥ 6 mm with solid component < 6 mm',
    rationale_zh: `单发部分实性结节，总平均径 ${d} mm（≥ 6 mm），实性成分 ${sc} mm（< 6 mm）`,
  };
}

/**
 * 同时计算 ACR Lung-RADS v2022（筛查口径）与 Fleischner 2017（偶发结节口径）的规则推算结果。
 */
export function evaluateNoduleGuidelines(input: NoduleGuidelineInput): NoduleGuidelineSummary {
  return {
    lung_rads_2022: evaluateLungRads2022(input),
    fleischner_2017: evaluateFleischner2017(input),
    status_label: GUIDELINE_PROVENANCE_LABEL,
    requires_confirmation: true,
  };
}
