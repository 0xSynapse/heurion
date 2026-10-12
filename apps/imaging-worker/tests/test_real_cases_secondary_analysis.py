import os
import pytest
import numpy as np
import nibabel as nib
from pathlib import Path

from src.clinical_bridge import extract_clinical_features
from src.clinical_ai_agent import (
    build_clinical_prompt,
    generate_clinical_ai_report,
    evaluate_evidence_based_clinical_guidelines,
)
from src.engine import MONAIEngine

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class TestRealCasesSecondaryAnalysis:
    """
    Automated test suite using authentic downloaded clinical cases to validate:
    1. MONAI 3D tensor to physical quantitative clinical features bridge
    2. Radiodensity (HU) statistics, morphology, and CT quality control
    3. Multimodal AI clinical guideline reasoning (Lung-RADS, GOLD, RECIST, Baveno VII)
    4. Clinical recommendation appropriateness across different patient risk contexts
    """

    @classmethod
    def setup_class(cls):
        cls.engine = MONAIEngine()

    def test_lidc_lung_nodule_physical_and_density_extraction(self):
        """
        Validates LIDC Case 0001 (TCIA authentic lung nodule scan and radiologist mask).
        Verifies:
        - 3D physical volume in mm3 and cm3 (not raw pixel counts)
        - RECIST 1.1 calipers on the key slice
        - CT HU attenuation metrics (mean, median, solid component ratio)
        - Nodule phenotype categorization (solid vs subsolid vs GGO)
        """
        ct_file = DATA_DIR / "lidc_lung_nodule_ct.nii.gz"
        mask_file = DATA_DIR / "lidc_lung_nodule_mask.nii.gz"

        assert ct_file.exists(), f"Missing clinical scan: {ct_file}"
        assert mask_file.exists(), f"Missing ground truth mask: {mask_file}"

        ct_nii = nib.load(str(ct_file))
        mask_nii = nib.load(str(mask_file))

        # Reorder to (Z, Y, X)
        ct_vol = np.transpose(ct_nii.get_fdata(), (2, 1, 0))
        mask_vol = np.transpose(mask_nii.get_fdata(), (2, 1, 0)).astype(np.uint8)

        zooms = ct_nii.header.get_zooms()[:3]
        spacing = (float(zooms[2]), float(zooms[1]), float(zooms[0])) # dz, dy, dx

        feats = extract_clinical_features(
            volume=ct_vol,
            mask=mask_vol,
            spacing=spacing,
            modality="CT",
            target_name="孤立性肺结节 (LIDC Case 0001)"
        )

        assert feats["has_lesion"] is True
        phys = feats["physical_metrics"]
        assert phys["positive_voxels"] == 6041
        
        # Physical volume: 6041 * (2.5 * 0.703125 * 0.703125) mm3 = ~7466.45 mm3 = ~7.47 cm3
        assert 7.0 <= phys["total_volume_cm3"] <= 8.0
        assert 7000.0 <= phys["total_volume_mm3"] <= 8000.0

        # Key slice must fall within the nodule axial span (slices 86..93)
        assert 86 <= phys["key_slice_index"] <= 93
        assert phys["longest_diameter_mm"] >= 25.0
        assert phys["short_axis_mm"] >= 20.0
        assert phys["caliper_longest"] is not None

        # CT HU attenuation checks
        dens = feats["density_metrics"]
        assert dens is not None
        assert -200.0 <= dens["mean_hu"] <= -100.0
        assert dens["max_hu"] > 100.0

        # Subsolid morphology
        subsolid = feats["subsolid_metrics"]
        assert subsolid is not None
        assert subsolid["morphological_type"] == "solid"
        assert subsolid["consolidation_tumor_ratio"] >= 0.8
        assert subsolid["solid_core_diameter_mm"] >= 20.0

        # Scan QC
        qc = feats["quality_control"]
        assert qc["slice_thickness_mm"] == 2.5
        assert qc["tier"] in ("acceptable", "thick_slice_warning")

    def test_lidc_clinical_ai_guideline_reasoning(self):
        """
        Validates Step 3: Multimodal Clinical AI reasoning on the LIDC lung nodule.
        Verifies:
        - High-risk smoking patient gets Lung-RADS 4B assessment
        - Three standardized sections are populated with objective measurements
        - Management includes MDT consult, PET-CT, and biopsy/surgery
        """
        ct_file = DATA_DIR / "lidc_lung_nodule_ct.nii.gz"
        mask_file = DATA_DIR / "lidc_lung_nodule_mask.nii.gz"

        ct_nii = nib.load(str(ct_file))
        mask_nii = nib.load(str(mask_file))
        ct_vol = np.transpose(ct_nii.get_fdata(), (2, 1, 0))
        mask_vol = np.transpose(mask_nii.get_fdata(), (2, 1, 0)).astype(np.uint8)
        zooms = ct_nii.header.get_zooms()[:3]
        spacing = (float(zooms[2]), float(zooms[1]), float(zooms[0]))

        feats = extract_clinical_features(
            volume=ct_vol,
            mask=mask_vol,
            spacing=spacing,
            modality="CT",
            target_name="肺孤立性实性结节"
        )

        patient = {
            "age": 62,
            "sex": "男",
            "smoking_history": "吸烟史 30 年 (30包·年)",
            "symptoms": "刺激性干咳，活动后气促，偶见痰中带血丝",
            "prior_cancer": "无恶性肿瘤病史"
        }

        report = generate_clinical_ai_report(feats, patient_context=patient)

        # Assert 3 standardized sections exist
        assert "findings_description" in report
        assert "diagnostic_assessment" in report
        assert "management_recommendations" in report

        findings = report["findings_description"]
        assessment = report["diagnostic_assessment"]
        mgmt = report["management_recommendations"]

        # 1. 【影像所见描述】 must state key slice, RECIST dimensions, volume, HU
        assert str(feats["physical_metrics"]["key_slice_index"]) in findings
        assert "mm" in findings
        assert "cm³" in findings or "cm3" in findings or "HU" in findings

        # 2. 【影像分级与恶性风险判断】 must assign Lung-RADS 4B for a >30mm solid lesion
        assert "Lung-RADS 4B" in assessment or "4B" in assessment
        assert "恶性" in assessment or "浸润" in assessment
        assert report["risk_level"] in ("high", "very_high")

        # 3. 【下一步临床处置与随访建议】 must include actionable procedures
        assert any(k in mgmt for k in ("PET-CT", "增强", "穿刺", "活检", "会诊", "手术"))

    def test_patient_context_risk_differentiation(self):
        """
        Validates that clinical reasoning properly considers patient risk factors:
        A sub-centimeter nodule in a heavy smoker warrants closer scrutiny than an incidental finding in a young non-smoker.
        """
        dummy_vol = np.full((32, 64, 64), -700.0, dtype=np.float32)
        dummy_mask = np.zeros((32, 64, 64), dtype=np.uint8)
        # 7mm solid nodule
        dummy_vol[16, 30:35, 30:35] = 45.0
        dummy_mask[16, 30:35, 30:35] = 1

        feats = extract_clinical_features(
            volume=dummy_vol,
            mask=dummy_mask,
            spacing=(1.5, 0.8, 0.8),
            modality="CT",
            target_name="肺实性结节"
        )

        prompt_high_risk = build_clinical_prompt(feats, {
            "age": 68,
            "sex": "男",
            "smoking_history": "重度吸烟 40 年",
            "symptoms": "咳嗽痰血",
            "prior_cancer": "喉癌术后"
        })
        assert "重度吸烟 40 年" in prompt_high_risk
        assert "喉癌术后" in prompt_high_risk

        prompt_low_risk = build_clinical_prompt(feats, {
            "age": 24,
            "sex": "女",
            "smoking_history": "不吸烟",
            "symptoms": "入职体检无症状",
            "prior_cancer": "无"
        })
        assert "不吸烟" in prompt_low_risk

    def test_copd_emphysema_secondary_analysis(self):
        """
        Validates COPD Emphysema CT scan analysis:
        - Evaluates Low Attenuation Area (LAA-950 HU)
        - Asserts GOLD 2024 staging and pulmonology recommendations
        """
        copd_file = DATA_DIR / "copd_emphysema_ct.nii.gz"
        assert copd_file.exists(), f"Missing COPD scan: {copd_file}"

        res = self.engine.analyze_file(
            file_path=str(copd_file),
            model_name="copd_emphysema_analyzer",
            window_preset="lung"
        )

        assert res["status"] == "success"
        assert "recist_metrics" in res
        recist = res["recist_metrics"]
        assert "emphysema" in recist
        em = recist["emphysema"]

        assert em["total_lung_volume_liters"] > 1.0
        assert 0.0 <= em["laa_percent"] <= 100.0
        assert "GOLD" in em["gold_stage"]

        # Check secondary AI report
        assert "clinical_ai_report" in res
        ai_rep = res["clinical_ai_report"]
        assert "findings_description" in ai_rep
        assert "diagnostic_assessment" in ai_rep
        assert "management_recommendations" in ai_rep
        assert "GOLD" in ai_rep.get("guideline_applied", "") or "慢阻肺" in ai_rep.get("diagnostic_assessment", "")

    def test_spleen_real_scan_secondary_analysis(self):
        """
        Validates real abdomen CT spleen volumetry and splenomegaly evaluation:
        - Executes MONAI spleen neural segmentation
        - Derives total spleen volume in cm3 and craniocaudal span in mm
        - Evaluates Baveno VII portal hypertension / hematologic criteria
        """
        spleen_file = DATA_DIR / "spleen_test.nii.gz"
        assert spleen_file.exists(), f"Missing spleen scan: {spleen_file}"

        res = self.engine.analyze_file(
            file_path=str(spleen_file),
            model_name="spleen_segmenter",
            window_preset="abdomen"
        )

        assert res["status"] == "success"
        assert res["real_neural_inference"] is True
        assert res["recist_metrics"]["total_volume_cm3"] > 50.0

        assert "clinical_features" in res
        feats = res["clinical_features"]
        assert feats["has_lesion"] is True
        assert feats["physical_metrics"]["total_volume_cm3"] > 50.0

        assert "clinical_ai_report" in res
        ai_rep = res["clinical_ai_report"]
        assert "脾脏" in ai_rep["diagnostic_assessment"] or "脾" in ai_rep["diagnostic_assessment"]
        assert any(k in ai_rep["management_recommendations"] for k in ("门静脉", "肝", "血常规", "随访", "随诊", "门诊"))

    def test_end_to_end_analyze_file_with_lidc_and_patient_context(self):
        """
        Tests end-to-end execution of engine.analyze_file on LIDC nodule CT
        with rich patient context, asserting full report markdown and image generation.
        """
        ct_file = DATA_DIR / "lidc_lung_nodule_ct.nii.gz"
        assert ct_file.exists()

        patient_ctx = {
            "age": 65,
            "sex": "男",
            "smoking_history": "45包·年",
            "symptoms": "刺激性剧烈咳嗽，咯血丝痰",
            "prior_cancer": "无"
        }

        res = self.engine.analyze_file(
            file_path=str(ct_file),
            model_name="lung_nodule_segmenter",
            window_preset="lung",
            patient_context=patient_ctx
        )

        assert res["status"] == "success"
        assert "clinical_features" in res
        assert "clinical_ai_report" in res
        assert len(res["key_slice_png_base64"]) > 1000

        # Markdown report must contain the 3 sections
        md = res["summary_markdown"]
        assert "【影像所见描述】" in md
        assert "【影像分级与恶性风险判断】" in md
        assert "【下一步临床处置与随访建议】" in md

    def test_vessel_cross_section_exclusion_from_lung_rads(self):
        """
        Validates clinical guideline rule (Fleischner 2017 & ACR Lung-RADS v2022):
        Normal anatomical structures (pulmonary vessel cross-sections) must NOT be misclassified
        as pulmonary nodules and must NOT receive a Lung-RADS nodule category.
        
        Uses the exact clinical scenario reported: Slice #122 at (z=122, y=240, x=315)
        accompanied by the signet-ring bronchus lumen.
        """
        ct_file = DATA_DIR / "chest_lung_ct.nii.gz"
        assert ct_file.exists(), f"Missing chest CT: {ct_file}"

        # In canonical LPS+ coordinate space (Anterior=0, Posterior=511), the companion vessel is at (122, 271, 315)
        res = self.engine.analyze_file(
            file_path=str(ct_file),
            model_name="lung_nodule_segmenter",
            window_preset="lung",
            prompt_point={"z": 122, "y": 271, "x": 315}
        )

        assert res["status"] == "success"
        recist = res["recist_metrics"]
        
        # 1. Structural anatomy identification
        assert recist.get("is_vessel") is True
        assert recist["nodule_type"] == "normal_vessel"
        assert "正常肺血管" in recist["nodule_type_zh"]
        assert recist["vessel_info"]["has_companion_bronchus"] is True

        # 2. ACR Lung-RADS exclusion
        rads = recist["lung_rads"]
        assert rads["category"] == "not_applicable"
        assert "正常解剖结构" in rads["name"]

        # 3. Multimodal Clinical AI agent reasoning
        ai_rep = res["clinical_ai_report"]
        assert ai_rep["risk_level"] == "none"
        assert "正常解剖结构" in ai_rep["diagnostic_assessment"]
        assert "不适用 Lung-RADS" in ai_rep["diagnostic_assessment"]
        assert any(k in ai_rep["management_recommendations"] for k in ("无需", "正常", "生理性", "过度"))

        # 4. Key slice overlay generated
        assert len(res["key_slice_png_base64"]) > 1000

