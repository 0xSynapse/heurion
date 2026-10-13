import pytest
import os
import sys
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from engine import MONAIEngine
from task_queue import process_cohort_case, batch_process_cohort
from server import app


@pytest.fixture
def engine():
    return MONAIEngine()


def test_process_cohort_case_lung(engine):
    case = {
        "subject_id": "TEST_SUBJ_001",
        "sample_id": "chest_lung_ct",
        "model_name": "lung_nodule_segmenter",
    }
    res = process_cohort_case(engine, case)
    assert res["subject_id"] == "TEST_SUBJ_001"
    assert res["status"] == "success"
    assert "longest_diameter_mm" in res
    assert "total_volume_cm3" in res
    assert "lung_rads" not in res


def test_process_cohort_case_whole_body(engine):
    case = {
        "subject_id": "TEST_SUBJ_002",
        "sample_id": "spleen_test",
        "model_name": "whole_body_ct_segmenter",
        "patient_sex": "M",
        "patient_height_m": 1.75,
        "patient_weight_kg": 70.0,
    }
    res = process_cohort_case(engine, case)
    assert res["subject_id"] == "TEST_SUBJ_002"
    assert res["status"] == "success"
    assert "smi_cm2_m2" in res
    assert "sarcopenia" not in res
    assert "vat_to_sat_ratio" in res


def test_batch_process_cohort(engine):
    cases = [
        {
            "subject_id": "SUBJ_101",
            "sample_id": "chest_lung_ct",
            "model_name": "lung_nodule_segmenter",
        },
        {
            "subject_id": "SUBJ_102",
            "sample_id": "spleen_test",
            "model_name": "whole_body_ct_segmenter",
            "patient_sex": "F",
            "patient_height_m": 1.62,
        },
    ]
    batch_res = batch_process_cohort(engine, cases, study_id="STUDY_ONCOLOGY_2026")
    assert batch_res["status"] == "success"
    assert batch_res["study_id"] == "STUDY_ONCOLOGY_2026"
    assert batch_res["total_cases"] == 2
    assert batch_res["successful_cases"] == 2
    assert batch_res["failed_cases"] == 0
    assert "columns" in batch_res
    assert len(batch_res["columns"]) > 0
    assert "dataframe_rows" in batch_res
    assert len(batch_res["dataframe_rows"]) == 2
    assert "csv_content" in batch_res
    assert "SUBJ_101" in batch_res["csv_content"]
    assert "SUBJ_102" in batch_res["csv_content"]


def test_cohort_batch_api_endpoint():
    client = TestClient(app)
    payload = {
        "study_id": "STUDY_BATCH_API_TEST",
        "cases": [
            {
                "subject_id": "PATIENT_A",
                "sample_id": "chest_lung_ct",
                "model_name": "lung_nodule_segmenter",
            },
            {
                "subject_id": "PATIENT_B",
                "sample_id": "spleen_test",
                "model_name": "whole_body_ct_segmenter",
            }
        ]
    }
    resp = client.post("/api/v1/cohort/batch-analyze", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert data["study_id"] == "STUDY_BATCH_API_TEST"
    assert data["total_cases"] == 2
    assert len(data["dataframe_rows"]) == 2
    assert "csv_content" in data


def test_cohort_batch_api_empty_validation():
    client = TestClient(app)
    resp = client.post("/api/v1/cohort/batch-analyze", json={"cases": []})
    assert resp.status_code == 400


def test_cohort_case_missing_inputs_fail_without_defaults():
    """缺影像、缺模型、样本不存在都如实失败，不代入默认样本或合成体。"""
    eng = MONAIEngine()
    assert process_cohort_case(eng, {"subject_id": "S1", "model_name": "lung_nodule_segmenter"})["status"] == "failed"
    assert process_cohort_case(eng, {"subject_id": "S1", "sample_id": "chest_lung_ct"})["status"] == "failed"
    res = process_cohort_case(eng, {"subject_id": "S1", "sample_id": "no_such_sample", "model_name": "lung_nodule_segmenter"})
    assert res["status"] == "failed"


def test_cohort_case_does_not_inject_demographics():
    """人口学字段缺失即不传；不输出肌少症判定与 Lung-RADS 列。"""
    import numpy as np

    class FakeEngine:
        def __init__(self):
            self.kwargs = None

        def load_volume_data(self, target):
            return np.zeros((4, 4, 4), dtype=np.float32), (1.0, 1.0, 1.0), "CT"

        def analyze_volume(self, **kw):
            self.kwargs = kw
            if kw["model_name"] == "whole_body_ct_segmenter":
                return {"body_composition": {"skeletal_muscle_index_cm2_m2": None}, "organ_volumetry_cm3": {}}
            return {"recist_metrics": {"has_lesion": None}}

    fe = FakeEngine()
    row = process_cohort_case(fe, {"subject_id": "S2", "sample_id": "x", "model_name": "whole_body_ct_segmenter"})
    assert row["status"] == "success"
    for k in ("patient_sex", "patient_height_m", "patient_weight_kg"):
        assert k not in fe.kwargs
    assert "sarcopenia" not in row
    assert row["smi_cm2_m2"] is None

    row2 = process_cohort_case(fe, {"subject_id": "S3", "sample_id": "x", "model_name": "lung_nodule_segmenter"})
    assert "lung_rads" not in row2
    assert row2["has_lesion"] is None
