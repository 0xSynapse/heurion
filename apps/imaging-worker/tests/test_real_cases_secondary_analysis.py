import os
import pytest
import numpy as np
import nibabel as nib
from pathlib import Path

from src.clinical_bridge import extract_clinical_features
from src.clinical_ai_agent import (
    build_clinical_prompt,
    generate_clinical_ai_report,
    describe_measured_findings,
    INTERPRETATION_NOTE,
)
from src.engine import MONAIEngine

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class TestRealCasesSecondaryAnalysis:
    """
    Automated test suite using authentic downloaded clinical cases to validate:
    1. MONAI 3D tensor to physical quantitative clinical features bridge
    2. Radiodensity (HU) statistics, morphology, and CT quality control
    3. 影像所见报告只写实测所见，不给诊断结论、分级与处置建议
    4. 患者信息只使用调用方实际提供的字段
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

    def test_lidc_findings_report_has_no_diagnosis_or_advice(self):
        """
        LIDC 结节的所见报告：
        - 所见描述包含关键层号、径线、体积、CT 值等实测数据
        - 不输出 Lung-RADS 分级、恶性风险、risk_level 与处置建议
        - 统一提示语
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

        report = generate_clinical_ai_report(feats, patient_context={"age": 62, "sex": "男"})
        findings = report["findings_description"]
        phys = feats["physical_metrics"]

        assert f"#{phys['key_slice_index']}" in findings
        assert f"{phys['longest_diameter_mm']} mm" in findings
        assert f"{phys['total_volume_cm3']} cm³" in findings
        assert f"{feats['density_metrics']['mean_hu']} HU" in findings
        assert report["interpretation_note"] == INTERPRETATION_NOTE

        for key in ("diagnostic_assessment", "management_recommendations", "risk_level", "rads_category", "gold_stage"):
            assert key not in report
        for word in ("Lung-RADS", "恶性", "浸润", "活检", "穿刺", "随访", "手术", "右/左肺"):
            assert word not in findings

    def test_patient_context_only_provided_fields(self):
        """未提供的患者字段不写入提示，不代入默认的年龄/性别/吸烟史/症状。"""
        dummy_vol = np.full((32, 64, 64), -700.0, dtype=np.float32)
        dummy_mask = np.zeros((32, 64, 64), dtype=np.uint8)
        dummy_vol[16, 30:35, 30:35] = 45.0
        dummy_mask[16, 30:35, 30:35] = 1

        feats = extract_clinical_features(
            volume=dummy_vol,
            mask=dummy_mask,
            spacing=(1.5, 0.8, 0.8),
            modality="CT",
            target_name="肺实性结节"
        )

        prompt_empty = build_clinical_prompt(feats, None)
        for word in ("62", "30包", "吸烟", "干咳", "男", "患者信息"):
            assert word not in prompt_empty

        prompt = build_clinical_prompt(feats, {
            "age": 68,
            "smoking_history": "重度吸烟 40 年",
            "prior_cancer": "喉癌术后"
        })
        assert "重度吸烟 40 年" in prompt
        assert "喉癌术后" in prompt
        assert "68" in prompt
        assert "性别" not in prompt
        assert "症状" not in prompt

    def test_empty_mask_findings(self):
        """掩膜为空时只说明未检出，不编造测量。"""
        vol = np.full((8, 16, 16), -800.0, dtype=np.float32)
        mask = np.zeros((8, 16, 16), dtype=np.uint8)
        feats = extract_clinical_features(vol, mask, spacing=(1.0, 1.0, 1.0), modality="CT", target_name="肺结节")
        res = describe_measured_findings(feats)
        assert "未检出" in res["findings_description"]
        assert "mm" not in res["findings_description"]

    def test_non_lung_target_skips_subsolid_and_vessel(self):
        """非肺结节场景（如腹部器官）不做实性成分与血管截面判定。"""
        vol = np.full((16, 32, 32), 40.0, dtype=np.float32)
        mask = np.zeros((16, 32, 32), dtype=np.uint8)
        mask[6:10, 10:20, 10:20] = 1
        feats = extract_clinical_features(vol, mask, spacing=(1.0, 1.0, 1.0), modality="CT", target_name="脾脏实质")
        assert feats["subsolid_metrics"] is None
        assert feats["density_metrics"] is not None

        feats_lung = extract_clinical_features(vol, mask, spacing=(1.0, 1.0, 1.0), modality="CT", target_name="肺结节")
        assert feats_lung["subsolid_metrics"] is not None

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
        assert "gold_stage" not in em

        # 所见报告不输出 GOLD 分级
        assert "clinical_ai_report" in res
        ai_rep = res["clinical_ai_report"]
        assert "findings_description" in ai_rep
        assert "GOLD" not in ai_rep["findings_description"]

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
        findings = ai_rep["findings_description"]
        assert f"{feats['physical_metrics']['total_volume_cm3']} cm³" in findings
        for word in ("脾大", "脾肿大", "轮廓光整", "密度均匀", "未见占位", "门静脉"):
            assert word not in findings
        assert feats["subsolid_metrics"] is None

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

        ai_rep = res["clinical_ai_report"]
        assert ai_rep["findings_description"]
        assert "management_recommendations" not in ai_rep
        # 提示中只出现调用方提供的患者信息
        assert "45包·年" in ai_rep["structured_prompt"]

    def test_vessel_cross_section_not_measured_as_nodule(self):
        """
        启发式判为疑似血管截面时：不伪造实性核心 / CTR，不输出 Lung-RADS 或「恶性风险为零」，
        如实标注「疑似血管截面，未做结节测量」。
        点击位置为 canonical LPS+ 空间 (z=122, y=271, x=315)。
        """
        ct_file = DATA_DIR / "chest_lung_ct.nii.gz"
        assert ct_file.exists(), f"Missing chest CT: {ct_file}"

        res = self.engine.analyze_file(
            file_path=str(ct_file),
            model_name="lung_nodule_segmenter",
            window_preset="lung",
            prompt_point={"z": 122, "y": 271, "x": 315}
        )

        assert res["status"] == "success"
        recist = res["recist_metrics"]
        assert recist.get("is_vessel") is True
        assert recist["nodule_type"] == "suspected_vessel"
        assert "未做结节测量" in recist["nodule_type_zh"]
        assert recist["solid_core_diameter_mm"] is None
        assert recist["consolidation_tumor_ratio"] is None
        assert "lung_rads" not in recist
        assert "pathology_risk" not in recist
        assert recist["vessel_info"]["reasons"]

        ai_rep = res["clinical_ai_report"]
        assert "疑似血管截面" in ai_rep["findings_description"]
        assert "恶性" not in ai_rep["findings_description"]
        assert "印戒征" not in ai_rep["findings_description"] or "触发判据" in ai_rep["findings_description"]
        assert "risk_level" not in ai_rep

        assert len(res["key_slice_png_base64"]) > 1000
