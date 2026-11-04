import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from server import app  # noqa: E402

client = TestClient(app)


def test_recist_11_pipeline_endpoint():
    resp = client.post(
        "/api/v1/pipeline/recist-11",
        json={
            "baseline_lesions": [{"id": "L1", "organ": "lung", "longest_diameter_mm": 50.0}],
            "followup_lesions": [{"id": "L1", "organ": "lung", "longest_diameter_mm": 32.0}],
            "prior_timepoints": [[{"id": "L1", "organ": "lung", "longest_diameter_mm": 25.0}]],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["category"] == "PD"
    assert body["nadir_sum_mm"] == 25.0
    assert body["followup_sum_mm"] == 32.0


def test_pneumonia_ctss_pipeline_endpoint():
    resp = client.post(
        "/api/v1/pipeline/pneumonia-ctss",
        json={
            "lobes": [
                {"lobe": "RUL", "lobe_volume_ml": 1000, "ggo_volume_ml": 30, "consolidation_volume_ml": 10},
                {"lobe": "RLL", "lobe_volume_ml": 1200, "ggo_volume_ml": 300, "consolidation_volume_ml": 120},
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["task"] == "pneumonia_ild_ct"
    assert body["total_ctss"] == 4
    assert body["status_label"] == "规则推算，待医生确认"


def test_rib_fractures_pipeline_endpoint():
    resp = client.post(
        "/api/v1/pipeline/rib-fractures",
        json={
            "candidates": [
                {
                    "side": "right",
                    "rib_number": 5,
                    "anatomical_arc": "lateral",
                    "cortical_gap_mm": 1.6,
                    "callus_formation_ratio": 0.05,
                    "displacement_mm": 2.4,
                    "confidence": 0.94,
                }
            ]
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["counts"]["acute"] == 1
    assert body["fractures"][0]["location_code"] == "R-Rib5-lateral"


def test_head_ich_pipeline_endpoint_stat_priority():
    resp = client.post(
        "/api/v1/pipeline/head-ich",
        json={
            "hemorrhages": [
                {
                    "subtype": "intraparenchymal",
                    "hemisphere": "left",
                    "location_zh": "左侧基底节区",
                    "axis_a_mm": 40.0,
                    "axis_b_mm": 30.0,
                    "extent_c_mm": 30.0,
                    "volume_ml": 18.5,
                    "mean_hu": 65.0,
                }
            ],
            "midline_shift_mm": 6.2,
            "priority": "stat",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["queue_priority"] == "stat"
    assert body["p90_sla_seconds"] == 60
    assert body["critical_alert_pending_confirmation"] is True
