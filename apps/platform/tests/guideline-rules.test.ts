import { describe, expect, it } from 'vitest';
import {
  GUIDELINE_PROVENANCE_LABEL,
  evaluateFleischner2017,
  evaluateLungRads2022,
  evaluateNoduleGuidelines,
} from '../src/imaging/guideline-rules.js';

describe('T3.5: ACR Lung-RADS v2022 & Fleischner 2017 rule engine', () => {
  describe('ACR Lung-RADS v2022', () => {
    it('classifies negative and benign calcified nodules as Category 1', () => {
      const noneRes = evaluateLungRads2022({ nodule_type: 'none' });
      expect(noneRes.category).toBe('1');
      expect(noneRes.follow_up_months).toBe(12);
      expect(noneRes.status_label).toBe('规则推算，待医生确认');
      expect(noneRes.requires_confirmation).toBe(true);
      expect(noneRes.clause_citation).toContain('Category 1');

      const calcRes = evaluateLungRads2022({ nodule_type: 'calcified_benign', mean_diameter_mm: 9.2 });
      expect(calcRes.category).toBe('1');
    });

    it('classifies baseline solid nodules across Categories 2, 3, 4A, and 4B', () => {
      expect(evaluateLungRads2022({ nodule_type: 'solid', mean_diameter_mm: 4.5 }).category).toBe('2');
      expect(evaluateLungRads2022({ nodule_type: 'solid', mean_diameter_mm: 6.5 }).category).toBe('3');
      expect(evaluateLungRads2022({ nodule_type: 'solid', mean_diameter_mm: 10.2 }).category).toBe('4A');
      expect(evaluateLungRads2022({ nodule_type: 'solid', mean_diameter_mm: 16.0 }).category).toBe('4B');
    });

    it('classifies new and growing (> 1.5 mm) solid nodules per Lung-RADS v2022', () => {
      expect(evaluateLungRads2022({ nodule_type: 'solid', mean_diameter_mm: 3.5, is_new: true }).category).toBe('2');
      expect(evaluateLungRads2022({ nodule_type: 'solid', mean_diameter_mm: 5.0, is_new: true }).category).toBe('3');
      expect(evaluateLungRads2022({ nodule_type: 'solid', mean_diameter_mm: 6.8, is_new: true }).category).toBe('4A');
      expect(evaluateLungRads2022({ nodule_type: 'solid', mean_diameter_mm: 8.2, is_new: true }).category).toBe('4B');

      // Growing (> 1.5 mm)
      expect(
        evaluateLungRads2022({
          nodule_type: 'solid',
          mean_diameter_mm: 7.2,
          delta_mean_diameter_mm: 2.0,
        }).category,
      ).toBe('4A');
      expect(
        evaluateLungRads2022({
          nodule_type: 'solid',
          mean_diameter_mm: 8.5,
          delta_mean_diameter_mm: 1.8,
        }).category,
      ).toBe('4B');
    });

    it('classifies part-solid and pure GGO nodules accurately', () => {
      // Part-solid baseline
      expect(
        evaluateLungRads2022({ nodule_type: 'part_solid', mean_diameter_mm: 5.2, solid_core_diameter_mm: 2.0 }).category,
      ).toBe('2');
      expect(
        evaluateLungRads2022({ nodule_type: 'part_solid', mean_diameter_mm: 8.0, solid_core_diameter_mm: 4.5 }).category,
      ).toBe('3');
      expect(
        evaluateLungRads2022({ nodule_type: 'part_solid', mean_diameter_mm: 11.0, solid_core_diameter_mm: 6.5 }).category,
      ).toBe('4A');
      expect(
        evaluateLungRads2022({ nodule_type: 'part_solid', mean_diameter_mm: 14.0, solid_core_diameter_mm: 8.5 }).category,
      ).toBe('4B');

      // Pure GGO
      expect(evaluateLungRads2022({ nodule_type: 'pure_ggo', mean_diameter_mm: 18.0 }).category).toBe('2');
      expect(evaluateLungRads2022({ nodule_type: 'pure_ggo', mean_diameter_mm: 32.0 }).category).toBe('3');
      expect(
        evaluateLungRads2022({
          nodule_type: 'pure_ggo',
          mean_diameter_mm: 32.0,
          scan_context: 'followup',
          is_new: false,
          delta_mean_diameter_mm: 0.4,
        }).category,
      ).toBe('2');
    });

    it('supports Lung-RADS v2022 step-down for Category 3 and 4A stable at >= 3 months', () => {
      const stepDown2 = evaluateLungRads2022({
        nodule_type: 'solid',
        mean_diameter_mm: 6.8,
        scan_context: 'followup',
        prior_category: '3',
        stable_months: 6,
        delta_mean_diameter_mm: 0.2,
      });
      expect(stepDown2.category).toBe('2');

      const stepDown3 = evaluateLungRads2022({
        nodule_type: 'solid',
        mean_diameter_mm: 9.5,
        scan_context: 'followup',
        prior_category: '4A',
        stable_months: 3,
        delta_mean_diameter_mm: 0.0,
      });
      expect(stepDown3.category).toBe('3');
    });
  });

  describe('Fleischner Society 2017', () => {
    it('enforces exclusion criteria (< 35 years, known malignancy, immunocompromise, screening)', () => {
      const young = evaluateFleischner2017({ nodule_type: 'solid', mean_diameter_mm: 7.0, age_years: 28 });
      expect(young.applicable).toBe(false);
      expect(young.exclusion_reason_zh).toContain('< 35 岁');
      expect(young.status_label).toBe(GUIDELINE_PROVENANCE_LABEL);

      expect(
        evaluateFleischner2017({ nodule_type: 'solid', mean_diameter_mm: 7.0, has_known_malignancy: true }).applicable,
      ).toBe(false);
      expect(
        evaluateFleischner2017({ nodule_type: 'solid', mean_diameter_mm: 7.0, is_immunocompromised: true }).applicable,
      ).toBe(false);
      expect(
        evaluateFleischner2017({ nodule_type: 'solid', mean_diameter_mm: 7.0, is_screening: true }).applicable,
      ).toBe(false);
    });

    it('evaluates single and multiple solid nodules across size and risk tiers (Table 1)', () => {
      const sLowSmall = evaluateFleischner2017({
        nodule_type: 'solid',
        mean_diameter_mm: 4.5,
        multiplicity: 'single',
        risk_level: 'low',
        age_years: 52,
      });
      expect(sLowSmall.applicable).toBe(true);
      expect(sLowSmall.follow_up_months_range).toBeNull();
      expect(sLowSmall.recommendation_zh).toContain('无需常规随访');

      const sHighSmall = evaluateFleischner2017({
        nodule_type: 'solid',
        mean_diameter_mm: 5.0,
        multiplicity: 'single',
        risk_level: 'high',
        age_years: 60,
      });
      expect(sHighSmall.follow_up_months_range).toEqual([12, 12]);

      const sMed = evaluateFleischner2017({
        nodule_type: 'solid',
        mean_diameter_mm: 7.0,
        multiplicity: 'single',
        risk_level: 'high',
      });
      expect(sMed.follow_up_months_range).toEqual([6, 12]);
      expect(sMed.clause_citation).toContain('Table 1: Single solid nodule 6–8 mm, high risk');

      const sLarge = evaluateFleischner2017({
        nodule_type: 'solid',
        mean_diameter_mm: 10.5,
        multiplicity: 'single',
        risk_level: 'low',
      });
      expect(sLarge.follow_up_months_range).toEqual([3, 3]);
      expect(sLarge.recommendation_zh).toContain('PET/CT');

      const mLarge = evaluateFleischner2017({
        nodule_type: 'solid',
        mean_diameter_mm: 7.5,
        multiplicity: 'multiple',
        risk_level: 'high',
      });
      expect(mLarge.follow_up_months_range).toEqual([3, 6]);
    });

    it('evaluates subsolid nodules (pure_ggo, part_solid, multiple) per Table 2', () => {
      const ggoSmall = evaluateFleischner2017({ nodule_type: 'pure_ggo', mean_diameter_mm: 4.8 });
      expect(ggoSmall.follow_up_months_range).toBeNull();

      const ggoLarge = evaluateFleischner2017({ nodule_type: 'pure_ggo', mean_diameter_mm: 8.5 });
      expect(ggoLarge.follow_up_months_range).toEqual([6, 12]);
      expect(ggoLarge.recommendation_zh).toContain('5 年');

      const psSmallCore = evaluateFleischner2017({
        nodule_type: 'part_solid',
        mean_diameter_mm: 9.0,
        solid_core_diameter_mm: 4.0,
      });
      expect(psSmallCore.follow_up_months_range).toEqual([3, 6]);
      expect(psSmallCore.recommendation_zh).toContain('每年行 CT 随访持续 5 年');

      const psLargeCore = evaluateFleischner2017({
        nodule_type: 'part_solid',
        mean_diameter_mm: 12.0,
        solid_core_diameter_mm: 7.0,
      });
      expect(psLargeCore.follow_up_months_range).toEqual([3, 6]);
      expect(psLargeCore.recommendation_zh).toContain('实性成分 ≥ 6 mm 高度可疑');
    });
  });

  describe('Combined evaluateNoduleGuidelines', () => {
    it('returns both guidelines with mandatory provenance label and confirmation flag', () => {
      const combined = evaluateNoduleGuidelines({
        nodule_type: 'solid',
        mean_diameter_mm: 7.2,
        risk_level: 'high',
        age_years: 58,
      });
      expect(combined.status_label).toBe('规则推算，待医生确认');
      expect(combined.requires_confirmation).toBe(true);
      expect(combined.lung_rads_2022.category).toBe('3');
      expect(combined.fleischner_2017.applicable).toBe(true);
      expect(combined.fleischner_2017.follow_up_months_range).toEqual([6, 12]);
    });
  });
});
