import pytest
import numpy as np
from fastapi.testclient import TestClient

import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from device import get_optimal_device, get_device_info
from engine import generate_synthetic_ct_volume, MONAIEngine
from recist import calculate_recist_metrics
from renderer import render_key_slice_png
from server import app

def test_device_detection():
    device = get_optimal_device()
    assert device is not None
    info = get_device_info()
    assert "device_type" in info
    assert info["device_type"] in ["mps", "cuda", "cpu"]

def test_synthetic_volume_and_recist():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    assert vol.shape == (32, 64, 64)
    assert gt_mask.shape == (32, 64, 64)
    
    metrics = calculate_recist_metrics(gt_mask, spacing=(2.0, 1.0, 1.0))
    assert metrics["has_lesion"] is True
    assert metrics["total_volume_cm3"] > 0.0
    assert metrics["longest_diameter_mm"] > 0.0
    assert metrics["caliper_longest"] is not None

def test_key_slice_png_rendering():
    vol, gt_mask = generate_synthetic_ct_volume(shape=(16, 64, 64), spacing=(2.0, 1.0, 1.0))
    metrics = calculate_recist_metrics(gt_mask, spacing=(2.0, 1.0, 1.0))
    key_slice = metrics["key_slice_index"]
    
    ct_slice = np.clip(vol[key_slice], 0, 255).astype(np.uint8)
    mask_slice = gt_mask[key_slice]
    
    png_bytes = render_key_slice_png(
        ct_slice_uint8=ct_slice,
        mask_slice_2d=mask_slice,
        recist=metrics,
        modality="CT",
        lesion_name="Test Nodule"
    )
    assert len(png_bytes) > 100
    # PNG signature header: 89 50 4E 47 0D 0A 1A 0A
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n"

def test_api_health_and_benchmark():
    client = TestClient(app)
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "healthy"
    assert "device" in data
    
    res_bench = client.post("/api/v1/analyze/benchmark", json={
        "model_name": "lung_nodule_segmenter",
        "z_slices": 24,
        "y_dim": 64,
        "x_dim": 64
    })
    assert res_bench.status_code == 200
    bench_data = res_bench.json()
    assert bench_data["status"] == "success"
    assert bench_data["is_synthetic"] is True
    assert "recist_metrics" in bench_data
    assert "key_slice_png_base64" in bench_data
    assert bench_data["key_slice_png_base64"].startswith("data:image/png;base64,")

def test_api_models_and_samples():
    client = TestClient(app)
    res_models = client.get("/api/v1/models")
    assert res_models.status_code == 200
    assert len(res_models.json()["models"]) >= 3

    res_samples = client.get("/api/v1/samples")
    assert res_samples.status_code == 200
    samples = res_samples.json()["samples"]
    assert len(samples) >= 1
    assert all(s["is_synthetic"] is False for s in samples)
    ids = [s["id"] for s in samples]
    assert "lidc_lung_nodule_ct" in ids

    # 缺模型 400；样本不存在 404（不再生成合成体顶替）
    assert client.post("/api/v1/analyze/sample", json={"sample_id": "lidc_lung_nodule_ct"}).status_code == 400
    assert client.post("/api/v1/analyze/sample", json={"sample_id": "no_such_sample", "model_name": "lung_nodule_segmenter"}).status_code == 404
    assert client.get("/api/v1/samples/no_such_sample/file").status_code == 404

    res_sample_ana = client.post("/api/v1/analyze/sample", json={"sample_id": "lidc_lung_nodule_ct", "model_name": "lung_nodule_segmenter"})
    assert res_sample_ana.status_code == 200
    data = res_sample_ana.json()
    assert data["status"] == "success"
    assert data["engine_type"] == "rule_based"
    assert data["real_neural_inference"] is False
    assert data["key_slice_png_base64"].startswith("data:image/png;base64,")

def test_bronchiectasis_and_mucus_analysis():
    client = TestClient(app)
    res = client.post("/api/v1/analyze/bronchiectasis", json={
        "model_name": "bronchiectasis_mucus_analyzer",
        "z_slices": 32,
        "y_dim": 128,
        "x_dim": 128
    })
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["is_synthetic"] is True
    assert data["analysis_type"] == "bronchiectasis_and_mucus"
    # 支扩分析没有病灶径线：RECIST 字段为空，只保留关键层号
    assert data["recist_metrics"]["longest_diameter_mm"] is None
    assert data["recist_metrics"]["has_lesion"] is None
    assert isinstance(data["recist_metrics"]["key_slice_index"], int)
    assert "metrics" in data
    assert data["metrics"]["broncho_arterial_ratio"] is not None
    assert 0.5 <= data["metrics"]["broncho_arterial_ratio"] <= 3.0
    assert data["metrics"]["total_mucus_volume_cm3"] > 0
    assert any("指套征" in s or "树芽征" in s or "印戒征" in s for s in data["metrics"]["signs_detected"])
    assert data["key_slice_png_base64"].startswith("data:image/png;base64,")


def test_subsolid_metrics_calculations():
    from recist import calculate_subsolid_metrics, calculate_volume_doubling_time
    # 1. Pure GGO: HU values around -450 HU (< -150 HU)
    vol_ggo = np.full((16, 32, 32), -800.0, dtype=np.float32)
    mask_ggo = np.zeros((16, 32, 32), dtype=np.uint8)
    mask_ggo[8, 12:20, 12:20] = 1
    vol_ggo[mask_ggo == 1] = -450.0

    res_ggo = calculate_subsolid_metrics(vol_ggo, mask_ggo, spacing=(1.0, 1.0, 1.0))
    assert res_ggo["nodule_type"] == "pure_ggo"
    assert res_ggo["solid_core_diameter_mm"] == 0.0
    assert res_ggo["consolidation_tumor_ratio"] == 0.0
    # 不再输出 Lung-RADS 分类与病理倾向，只给测量值
    assert "lung_rads" not in res_ggo
    assert "pathology_risk" not in res_ggo

    # 2. Part-solid / subsolid: outer rim -450 HU, central core +40 HU (> -150 HU)
    vol_part = np.full((16, 32, 32), -800.0, dtype=np.float32)
    mask_part = np.zeros((16, 32, 32), dtype=np.uint8)
    mask_part[8, 10:22, 10:22] = 1 # 12x12 total nodule
    vol_part[mask_part == 1] = -450.0
    # Center 6x6 core is solid
    mask_solid = np.zeros((16, 32, 32), dtype=bool)
    mask_solid[8, 13:19, 13:19] = True
    vol_part[mask_solid] = 40.0

    res_part = calculate_subsolid_metrics(vol_part, mask_part, spacing=(1.0, 1.0, 1.0))
    assert res_part["nodule_type"] == "part_solid"
    assert res_part["solid_core_diameter_mm"] > 0.0
    assert 0.0 < res_part["consolidation_tumor_ratio"] < 0.8
    assert res_part["solid_core_diameter_mm"] == 7.1  # 6x6 体素实性核心对角线
    assert "lung_rads" not in res_part

    # 3. Schwartz 体积倍增时间：只给计算值，不按区间给恶性风险或建议
    vdt_up = calculate_volume_doubling_time(baseline_vol_cm3=1.0, followup_vol_cm3=2.0, days_interval=180.0)
    assert vdt_up["vdt_days"] == 180.0
    assert vdt_up["category"] == "increased"
    for key in ("risk_level", "clinical_alert", "recommendation"):
        assert key not in vdt_up

    vdt_slow = calculate_volume_doubling_time(baseline_vol_cm3=1.0, followup_vol_cm3=2.0, days_interval=800.0)
    assert vdt_slow["vdt_days"] == 800.0

    vdt_down = calculate_volume_doubling_time(baseline_vol_cm3=2.0, followup_vol_cm3=1.0, days_interval=100.0)
    assert vdt_down["category"] == "decreased"
    assert vdt_down["vdt_days"] is None
    assert vdt_down["volume_change_percent"] == -50.0

    vdt_bad = calculate_volume_doubling_time(baseline_vol_cm3=0.0, followup_vol_cm3=1.0, days_interval=100.0)
    assert vdt_bad["vdt_days"] is None and vdt_bad["volume_change_cm3"] is None


def test_vdt_endpoint():
    client = TestClient(app)
    res = client.post("/api/v1/recist/volume-doubling-time", json={
        "baseline_volume_cm3": 1.2,
        "followup_volume_cm3": 2.4,
        "days_interval": 120.0
    })
    assert res.status_code == 200
    data = res.json()
    assert data["vdt_days"] == 120.0
    assert data["category"] == "increased"
    assert "clinical_alert" not in data


def test_quality_control_without_pathology_risk():
    from recist import calculate_subsolid_metrics
    vol = np.full((16, 32, 32), -800.0, dtype=np.float32)
    mask = np.zeros((16, 32, 32), dtype=np.uint8)
    mask[8, 12:20, 12:20] = 1
    vol[mask == 1] = -450.0  # pure GGO

    # Case A: Thin-slice (1.0 mm)
    res_thin = calculate_subsolid_metrics(vol, mask, spacing=(1.0, 0.8, 0.8))
    assert res_thin["quality_control"]["is_thin_slice"] is True
    assert res_thin["quality_control"]["tier"] == "optimal"
    assert res_thin["quality_control"]["warning"] is None
    assert "pathology_risk" not in res_thin

    # Case B: Thick-slice (5.0 mm) -> triggers warning
    res_thick = calculate_subsolid_metrics(vol, mask, spacing=(5.0, 0.8, 0.8))
    assert res_thick["quality_control"]["is_thin_slice"] is False
    assert res_thick["quality_control"]["tier"] == "thick_slice_warning"
    assert "HRCT" in res_thick["quality_control"]["warning"]


def test_emphysema_metrics_and_endpoint():
    from recist import calculate_emphysema_metrics
    # 合成体：体外空气 -1000（与边界相连）、软组织体壁、两侧封闭的肺 -850，其中一块 -970
    vol = np.full((24, 64, 64), -1000.0, dtype=np.float32)
    vol[:, 6:58, 6:58] = 40.0
    vol[2:22, 14:50, 12:30] = -850.0
    vol[2:22, 14:50, 34:52] = -850.0
    vol[4:20, 20:30, 14:24] = -970.0

    # 体素取大一些，使每侧肺超过 segment_lungs 的 50 cm³ 最小体积
    em = calculate_emphysema_metrics(vol, spacing=(5.0, 2.0, 2.0))
    assert em["status"] == "success"
    vx_l = 5.0 * 2.0 * 2.0 / 1e6
    lung_vox = 2 * 20 * 36 * 18
    laa_vox = 16 * 10 * 10
    assert em["total_lung_volume_liters"] == round(lung_vox * vx_l, 2)
    assert em["laa_percent"] == round(laa_vox / lung_vox * 100.0, 1)
    assert "gold_stage" not in em
    assert "recommendation" not in em

    # 分不出肺（低密度区与图像边界相连）时返回空值与原因，不给估计值
    open_vol = np.full((24, 64, 64), -850.0, dtype=np.float32)
    em_fail = calculate_emphysema_metrics(open_vol, spacing=(1.5, 0.8, 0.8))
    assert em_fail["status"] == "lung_segmentation_failed"
    assert em_fail["laa_percent"] is None

    # Test API endpoint
    client = TestClient(app)
    res = client.post("/api/v1/recist/emphysema", json={
        "sample_id": "chest_lung_ct",
        "emphysema_hu_threshold": -950.0
    })
    assert res.status_code == 200
    data = res.json()
    assert "laa_percent" in data
    assert "gold_stage" not in data
    assert "total_lung_volume_liters" in data


def test_strict_neural_inference_and_missing_weight_rejection():
    from engine import MONAIEngine, generate_synthetic_ct_volume
    engine = MONAIEngine()
    vol, _ = generate_synthetic_ct_volume(shape=(32, 64, 64), spacing=(1.5, 0.8, 0.8))

    # Test COPD Emphysema Analyzer model execution
    res_copd = engine.analyze_volume(volume=vol, spacing=(1.5, 0.8, 0.8), model_name="copd_emphysema_analyzer")
    assert res_copd["status"] == "success"
    assert "emphysema" in res_copd["recist_metrics"]
    # LAA% 不再塞进径线字段，也不输出 GOLD 分级
    assert res_copd["recist_metrics"]["longest_diameter_mm"] is None
    assert res_copd["recist_metrics"]["short_axis_mm"] is None
    assert "lung_rads" not in res_copd["recist_metrics"]
    assert "GOLD" not in res_copd["summary_markdown"]
    assert res_copd["key_slice_png_base64"].startswith("data:image/png;base64,")

    # Test Real Neural Inference for installed MONAI Spleen 3D-UNet model
    res_spleen = engine.analyze_volume(volume=vol, spacing=(1.5, 0.8, 0.8), model_name="spleen_segmenter")
    assert res_spleen["status"] == "success"
    assert res_spleen["real_neural_inference"] is True
    assert "spleen_ct_segmentation" in res_spleen["neural_info"]["neural_architecture"]

    # Verify that requesting an uninstalled model strictly raises RuntimeError rather than degrading to heuristic fake rules
    with pytest.raises(RuntimeError) as exc_info:
        engine.analyze_volume(volume=vol, spacing=(1.5, 0.8, 0.8), model_name="uninstalled_custom_model")
    assert "未实现" in str(exc_info.value)


def test_model_registry_and_endpoints():
    from model_registry import list_registered_models, pull_model, verify_model, OFFICIAL_MODEL_REGISTRY
    models = list_registered_models()
    assert len(models) >= 5
    names = [m["name"] for m in models]
    assert "lung_nodule_ct" in names
    assert "totalsegmentator" in names
    assert "vista3d" in names

    client = TestClient(app)
    # Test GET /api/v1/models
    res = client.get("/api/v1/models")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "success"
    assert data["total"] >= 5

    # Test POST /api/v1/models/pull
    res_pull = client.post("/api/v1/models/pull", json={"model_name": "spleen_ct", "force": False})
    assert res_pull.status_code == 200
    pull_data = res_pull.json()
    assert pull_data["status"] in ("success", "already_installed")

    # Test POST /api/v1/models/verify
    res_v = client.post("/api/v1/models/verify", json={"model_name": "spleen_ct"})
    assert res_v.status_code == 200
    assert "installed" in res_v.json()


def test_dicom_anonymization_and_endpoint():
    import io
    import zipfile
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, CTImageStorage, generate_uid
    from dicom_io import anonymize_dicom_dataset, anonymize_dicom_zip

    # Create synthetic pydicom dataset with PHI
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta.MediaStorageSOPClassUID = CTImageStorage
    ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
    ds.Modality = "CT"
    ds.PatientName = "Zhang^San"
    ds.PatientID = "HOSP-998877"
    ds.PatientBirthDate = "19750512"
    ds.InstitutionName = "First Affiliated Hospital"
    ds.ReferringPhysicianName = "Dr^Li"
    ds.Rows = 16
    ds.Columns = 16
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 1
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelSpacing = [1.0, 1.0]
    ds.SliceThickness = "2.0"
    ds.ImagePositionPatient = [0.0, 0.0, 10.0]
    ds.PixelData = np.zeros((16, 16), dtype=np.int16).tobytes()

    # Test in-memory dataset anonymization
    anon_ds = anonymize_dicom_dataset(ds, anonymous_id="TEST01")
    assert "ANONYMIZED^TEST01" == str(anon_ds.PatientName)
    assert "ANON-TEST01" == str(anon_ds.PatientID)
    assert "Heurion" in str(anon_ds.InstitutionName)

    # Test zip anonymization
    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    dcm_bytes = buf.getvalue()

    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w") as zf:
        zf.writestr("slice_001.dcm", dcm_bytes)
        zf.writestr("__MACOSX/._slice_001.dcm", b"junk")
    
    zip_bytes = zip_buf.getvalue()
    out_bytes, report = anonymize_dicom_zip(zip_bytes, anonymous_id="BATCH01")
    assert report["total_slices_anonymized"] == 1
    assert report["skipped_files_count"] == 1
    assert len(out_bytes) > 0

    # Test API endpoint
    client = TestClient(app)
    res = client.post(
        "/api/v1/dicom/anonymize",
        data={"anonymous_id": "API01", "retain_dates": "false"},
        files={"file": ("test_series.zip", zip_bytes, "application/zip")}
    )
    assert res.status_code == 200
    assert res.headers["x-anonymous-id"] == "API01"
    assert res.headers["x-anonymized-slices"] == "1"


def test_async_task_queue_and_endpoints():
    client = TestClient(app)

    # 1. Submit async inference task
    res_submit = client.post("/api/v1/tasks/analyze", json={
        "sample_id": "chest_lung_ct",
        "model_name": "lung_nodule_segmenter"
    })
    assert res_submit.status_code == 200
    data = res_submit.json()
    assert "task_id" in data
    assert data["status"] in ("queued", "running")
    task_id = data["task_id"]

    # 2. Poll task status
    import time
    max_wait = 25
    start = time.time()
    final_task = None
    while time.time() - start < max_wait:
        res_poll = client.get(f"/api/v1/tasks/{task_id}")
        assert res_poll.status_code == 200
        poll_data = res_poll.json()
        if poll_data["status"] == "completed":
            final_task = poll_data
            break
        time.sleep(0.3)

    assert final_task is not None
    assert final_task["status"] == "completed"
    assert final_task["progress_pct"] == 100
    assert "recist_metrics" in final_task["result"]
    assert "key_slice_png_base64" in final_task["result"]

    # 3. List tasks
    res_list = client.get("/api/v1/tasks")
    assert res_list.status_code == 200
    tasks_list = res_list.json()
    assert any(t["task_id"] == task_id for t in tasks_list["tasks"])


def test_gz_and_tar_gz_volume_loading():
    import gzip, tarfile, tempfile, shutil
    from pathlib import Path
    from dicom_io import load_volume, load_nifti
    
    # 1. Test .gz extension loading (where filename is just .gz, not .nii.gz)
    src_sample = Path(__file__).parent.parent / "data" / "lidc_lung_nodule_mask.nii.gz"
    with tempfile.NamedTemporaryFile(suffix=".gz", delete=False) as tmp_gz:
        shutil.copyfile(src_sample, tmp_gz.name)
        tmp_gz_path = tmp_gz.name
    try:
        vol, spacing, mod = load_volume(tmp_gz_path)
        assert vol.shape == (133, 512, 512)
        assert mod in ("CT", "MRI")
    finally:
        if os.path.exists(tmp_gz_path):
            os.remove(tmp_gz_path)

    # 2. Test upload with .tar.gz archive
    client = TestClient(app)
    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp_tar:
        with tarfile.open(fileobj=tmp_tar, mode="w:gz") as tf:
            tf.add(src_sample, arcname="scan.nii.gz")
        tar_path = tmp_tar.name

    try:
        with open(tar_path, "rb") as f_tar:
            res_up = client.post(
                "/api/v1/analyze/upload",
                files={"file": ("archive.tar.gz", f_tar, "application/gzip")},
                data={"model_name": "lung_nodule_segmenter"}
            )
        assert res_up.status_code == 200
        res_data = res_up.json()
        assert res_data["status"] == "success"
    finally:
        if os.path.exists(tar_path):
            os.remove(tar_path)


def test_synthetic_dicom_canonical_lps_orientation():
    """
    Validates DICOM patient coordinate system (LPS) orientation integrity:
    Ensures that standard supine axial CT (IOP = [1,0,0, 0,1,0]) is correctly converted
    to canonical LPS+ (Z, Y, X) space without accidental 180-degree in-plane rotation:
    - Anterior landmark must remain in anterior half (small Y, row ~0)
    - Posterior spine landmark must remain in posterior half (large Y, row ~255)
    - Patient right landmark must remain on patient right (small X, col ~0)
    - Patient left landmark must remain on patient left (large X, col ~255)
    - Anatomical QA audit passes for both Supine (HFS) and Prone (HFP) postures
    """
    import pydicom
    from pydicom.dataset import Dataset, FileMetaDataset
    from dicom_io import _build_volume_from_slices
    from spatial_canonicalizer import check_anatomical_orientation_sanity

    class MockDicomSlice:
        def __init__(self, arr, z_pos, z_idx):
            self.pixel_array = arr
            self.Modality = "CT"
            self.PatientPosition = "HFS"
            self.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
            self.ImagePositionPatient = [0.0, 0.0, float(z_pos)]
            self.PixelSpacing = [1.0, 1.0]
            self.SliceThickness = 2.0
            self.RescaleSlope = 1.0
            self.RescaleIntercept = 0.0
            self.SeriesInstanceUID = "1.2.3.4.5"
            self.SOPInstanceUID = f"1.2.3.4.5.6.{z_idx}"
            self.Rows = arr.shape[0]
            self.Columns = arr.shape[1]

    slices = []
    num_slices = 16
    h, w = 256, 256

    for z_idx in range(num_slices):
        arr = np.full((h, w), -800.0, dtype=np.float32) # Lung parenchyma baseline
        # Anterior landmark (e.g. sternum, small row index Y=25)
        arr[20:30, 120:136] = 500.0
        # Posterior landmark (e.g. thoracic spine, large row index Y=230)
        arr[210:245, 105:150] = 1200.0
        # Patient right landmark (small column index X=25)
        arr[120:136, 20:30] = 180.0
        # Patient left landmark (large column index X=230)
        arr[120:136, 220:230] = 200.0

        slices.append(MockDicomSlice(arr, z_idx * 2.0, z_idx))

    vol_lps, spacing_lps, meta = _build_volume_from_slices(slices)

    assert vol_lps.shape == (num_slices, h, w)
    # Z spacing = 2.0, Y spacing = 1.0, X spacing = 1.0
    assert spacing_lps == (2.0, 1.0, 1.0)

    # Verify landmarks in canonical LPS+ (Z, Y, X):
    mid_z = num_slices // 2
    slice_mid = vol_lps[mid_z]

    # 1. Anterior landmark must be at Y < h//2 (near y=25)
    y_ant, x_ant = np.unravel_index(np.argmax(slice_mid[:h//2, 120:136]), (h//2, 16))
    assert slice_mid[:h//2, 120:136].max() >= 500.0
    # 2. Posterior spine landmark must be at Y > h//2 (near y=230)
    assert slice_mid[h//2:, 105:150].max() >= 1000.0
    # 3. Patient right landmark must be at X < w//2
    assert slice_mid[120:136, :w//2].max() >= 180.0
    # 4. Patient left landmark must be at X > w//2
    assert slice_mid[120:136, w//2:].max() >= 200.0

    # 5. Anatomical QA check: Supine patient must PASS without warnings
    qa_supine = check_anatomical_orientation_sanity(vol_lps, modality="CT", patient_position="HFS")
    assert qa_supine["status"] == "pass"
    assert qa_supine["anomaly_detected"] is False

    # 6. Anatomical QA check: Prone patient (HFP) must also pass because spine is still posterior in LPS
    qa_prone = check_anatomical_orientation_sanity(vol_lps, modality="CT", patient_position="HFP")
    assert qa_prone["status"] == "pass"
    assert qa_prone["anomaly_detected"] is False

    # 7. Negative test: Inverted volume (spine placed in anterior half) must trigger warning
    inverted_vol = vol_lps[:, ::-1, :]
    qa_inv = check_anatomical_orientation_sanity(inverted_vol, modality="CT", patient_position="HFS")
    assert qa_inv["status"] == "warning"
    assert qa_inv["anomaly_detected"] is True


def test_qa_kernel_classification():
    """
    Validates vendor CT reconstruction kernel classification precision:
    - GE STANDARD must be classified as smooth_mediastinum (not sharp lung!)
    - Siemens Qr40d must be classified as smooth_mediastinum (not sharp lung!)
    - Siemens B70s and BL64 must be classified as sharp_lung
    - Canon FC52 and GE LUNG must be classified as sharp_lung
    """
    from quality_assurance import parse_reconstruction_kernel

    # GE
    ge_std = parse_reconstruction_kernel("STANDARD")
    assert ge_std["is_sharp_lung"] is False
    assert ge_std["category"] == "smooth_mediastinum"

    ge_lung = parse_reconstruction_kernel("LUNG")
    assert ge_lung["is_sharp_lung"] is True
    assert ge_lung["category"] == "sharp_lung"

    # Siemens
    siemens_qr40d = parse_reconstruction_kernel("Qr40d")
    assert siemens_qr40d["is_sharp_lung"] is False
    assert siemens_qr40d["category"] == "smooth_mediastinum"

    siemens_b70 = parse_reconstruction_kernel("B70s")
    assert siemens_b70["is_sharp_lung"] is True
    assert siemens_b70["category"] == "sharp_lung"

    siemens_bl64 = parse_reconstruction_kernel("BL64")
    assert siemens_bl64["is_sharp_lung"] is True
    assert siemens_bl64["category"] == "sharp_lung"

    # Canon
    canon_fc52 = parse_reconstruction_kernel("FC52")
    assert canon_fc52["is_sharp_lung"] is True
    assert canon_fc52["category"] == "sharp_lung"

    canon_fc18 = parse_reconstruction_kernel("FC18")
    assert canon_fc18["is_sharp_lung"] is False
    assert canon_fc18["category"] == "smooth_mediastinum"




def test_qa_lung_volume_excludes_external_air():
    """质控肺容积只计双肺，不把体外空气算进去；样例胸部 CT 应落在成人正常肺容积范围内。"""
    from dicom_io import load_nifti
    from quality_assurance import assess_ct_quality
    vol, sp = load_nifti(os.path.join(os.path.dirname(__file__), "..", "data", "chest_lung_ct.nii.gz"))
    qa = assess_ct_quality(vol, sp, {})
    assert qa["total_lung_volume_cm3"] is not None
    assert 2500.0 <= qa["total_lung_volume_cm3"] <= 8000.0


def test_qa_lung_volume_unavailable_when_not_segmentable():
    """分不出肺时不给估计值，吸气程度标为未评估。"""
    from quality_assurance import assess_ct_quality
    vol = np.full((200, 64, 64), -1000.0, dtype=np.float32)
    qa = assess_ct_quality(vol, (1.0, 1.0, 1.0), {})
    assert qa["total_lung_volume_cm3"] is None
    assert qa["is_inspiratory_adequate"] is None


def test_qa_kernel_multivalue_siemens():
    """Siemens 多值卷积核字段取主名称再分类。"""
    from quality_assurance import parse_reconstruction_kernel
    assert parse_reconstruction_kernel(["Br64d", "3"])["category"] == "sharp_lung"
    assert parse_reconstruction_kernel("['Br40d', '3']")["category"] == "smooth_mediastinum"
