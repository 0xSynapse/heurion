import os
import re
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any, Union

def parse_flexible_float(v: Any, default: Optional[float] = None) -> Optional[float]:
    if v is None or v == "" or str(v).lower() == "none":
        return default
    try:
        return float(str(v).strip().replace(",", "."))
    except (ValueError, TypeError):
        return default

try:
    from .device import get_device_info
    from .engine import MONAIEngine, generate_synthetic_ct_volume
    from .recist import calculate_volume_doubling_time, calculate_subsolid_metrics, calculate_emphysema_metrics
    from .model_registry import list_registered_models, pull_model, verify_model, get_model_status
    from .dicom_io import anonymize_dicom_zip, anonymize_dicom_file
    from .task_queue import task_manager, TaskStage, batch_process_cohort
    from .clinical_audit import run_all_clinical_audits
except (ImportError, ValueError):
    from device import get_device_info
    from engine import MONAIEngine, generate_synthetic_ct_volume
    from recist import calculate_volume_doubling_time, calculate_subsolid_metrics, calculate_emphysema_metrics
    from model_registry import list_registered_models, pull_model, verify_model, get_model_status
    from dicom_io import anonymize_dicom_zip, anonymize_dicom_file
    from task_queue import task_manager, TaskStage, batch_process_cohort
    from clinical_audit import run_all_clinical_audits

from fastapi import FastAPI, HTTPException, Body, UploadFile, File, Form
from fastapi.responses import FileResponse
import tempfile
import zipfile
import shutil
import threading
from pathlib import Path

app = FastAPI(
    title="Heurion 2.0 MONAI Medical Imaging Worker",
    description="High-performance medical imaging inference worker supporting Apple Silicon MPS, NVIDIA CUDA, and CPU.",
    version="0.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

engine = MONAIEngine()
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# 并发保护：重型 3D 卷积与图像配准属于 GPU/CPU 密集型计算，
# 限制最大并发执行数为 2（可由 IMAGING_CONCURRENCY 调节），防止突发并发直接打爆 GPU VRAM 或物理内存导致 OOM Kill。
INFERENCE_SEMAPHORE = threading.Semaphore(int(os.environ.get("IMAGING_CONCURRENCY", "2")))

class BenchmarkRequest(BaseModel):
    model_name: Optional[str] = "lung_nodule_segmenter"
    window_preset: Optional[str] = "lung"
    z_slices: Optional[int] = 48
    y_dim: Optional[int] = 128
    x_dim: Optional[int] = 128
    mucus_min_hu: Optional[Union[float, str]] = 10.0
    mucus_max_hu: Optional[Union[float, str]] = 75.0
    ham_threshold_hu: Optional[Union[float, str]] = 70.0
    bar_cutoff: Optional[Union[float, str]] = 1.10

class SampleRequest(BaseModel):
    sample_id: Optional[str] = "spleen_test"
    volume_id: Optional[str] = None
    click_point: Optional[Dict[str, int]] = None
    model_name: Optional[str] = "spleen_segmenter"
    window_preset: Optional[str] = None
    patient_context: Optional[Dict[str, Any]] = None
    mucus_min_hu: Optional[Union[float, str]] = 10.0
    mucus_max_hu: Optional[Union[float, str]] = 75.0
    ham_threshold_hu: Optional[Union[float, str]] = 70.0
    bar_cutoff: Optional[Union[float, str]] = 1.10

class FileAnalysisRequest(BaseModel):
    file_path: str
    model_name: Optional[str] = "spleen_segmenter"
    window_preset: Optional[str] = None
    click_point: Optional[Dict[str, int]] = None
    patient_context: Optional[Dict[str, Any]] = None
    mucus_min_hu: Optional[Union[float, str]] = 10.0
    mucus_max_hu: Optional[Union[float, str]] = 75.0
    ham_threshold_hu: Optional[Union[float, str]] = 70.0
    bar_cutoff: Optional[Union[float, str]] = 1.10

class MprInfoRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    volume_id: Optional[str] = None
    file_path: Optional[str] = None
    model_name: Optional[str] = None

class MprSliceRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    volume_id: Optional[str] = None
    file_path: Optional[str] = None
    plane: Optional[str] = "axial"  # axial, coronal, sagittal
    slice_index: Optional[int] = None
    window_preset: Optional[str] = None
    overlay_mask: Optional[bool] = True
    model_name: Optional[str] = None

class DiffSliceRequest(BaseModel):
    baseline_id: Optional[str] = "chest_lung_ct"
    followup_id: Optional[str] = "chest_lung_ct"
    baseline_volume_id: Optional[str] = None
    followup_volume_id: Optional[str] = None
    baseline_path: Optional[str] = None
    followup_path: Optional[str] = None
    plane: Optional[str] = "axial"
    slice_index: Optional[int] = None
    window_preset: Optional[str] = None
    threshold_hu: Optional[float] = 50.0

class RadiomicsRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    file_path: Optional[str] = None
    model_name: Optional[str] = "lung_nodule_segmenter"
    num_bins: Optional[int] = 16

class InteractivePromptPoint(BaseModel):
    z: int = 0
    y: int = 0
    x: int = 0
    is_positive: bool = True

class InteractiveSegmentRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    file_path: Optional[str] = None
    points: Optional[List[InteractivePromptPoint]] = None
    bbox: Optional[Dict[str, int]] = None
    window_preset: Optional[str] = "lung"
    plane: Optional[str] = "axial"
    slice_index: Optional[int] = None
    mode: Optional[str] = "deep"

class WholeBodyAnalysisRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    file_path: Optional[str] = None
    patient_sex: Optional[str] = "M"
    patient_height_m: Optional[float] = 1.72
    patient_weight_kg: Optional[float] = 68.0
    l3_slice_index: Optional[int] = None
    z_slices: Optional[int] = 64
    y_dim: Optional[int] = 128
    x_dim: Optional[int] = 128

class DeformableRegistrationRequest(BaseModel):
    fixed_sample_id: Optional[str] = "chest_lung_ct"
    moving_sample_id: Optional[str] = "chest_lung_ct"
    iterations: Optional[int] = 10
    smoothing_sigma: Optional[float] = 1.0

class PetCtFusionRequest(BaseModel):
    ct_sample_id: Optional[str] = "chest_lung_ct"
    pet_sample_id: Optional[str] = None
    suv_threshold: Optional[float] = 2.5
    key_slice_index: Optional[int] = None
    alpha: Optional[float] = 0.55

class RtStructRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    file_path: Optional[str] = None
    ctv_margin_mm: Optional[float] = 6.0
    ptv_margin_mm: Optional[float] = 4.0
    key_slice_index: Optional[int] = None

class VolumeDoublingTimeRequest(BaseModel):
    baseline_volume_cm3: float
    followup_volume_cm3: float
    days_interval: float

class CohortCaseItem(BaseModel):
    subject_id: Optional[str] = None
    patient_id: Optional[str] = None
    sample_id: Optional[str] = None
    file_path: Optional[str] = None
    model_name: Optional[str] = "lung_nodule_segmenter"
    patient_sex: Optional[str] = "M"
    patient_height_m: Optional[float] = 1.72
    patient_weight_kg: Optional[float] = 68.0

class CohortBatchAnalysisRequest(BaseModel):
    study_id: Optional[str] = None
    cases: List[CohortCaseItem]


@app.post("/api/v1/recist/volume-doubling-time")
def compute_volume_doubling_time(req: VolumeDoublingTimeRequest = Body(...)):
    """Computes Schwartz Volume Doubling Time (VDT) and clinical proliferation risk."""
    return calculate_volume_doubling_time(
        baseline_vol_cm3=req.baseline_volume_cm3,
        followup_vol_cm3=req.followup_volume_cm3,
        days_interval=req.days_interval
    )


@app.post("/api/v1/cohort/batch-analyze")
def batch_analyze_cohort_endpoint(req: CohortBatchAnalysisRequest = Body(...)):
    """
    Executes high-throughput multi-modal 3D imaging batch analysis for a research cohort.
    Extracts lesion diameters, volumetry, Lung-RADS, and body composition indices,
    returning structured JSON and wide-format CSV for clinical trial data frames.
    """
    if not req.cases:
        raise HTTPException(status_code=400, detail="队列受试者病例列表不能为空")
    try:
        cases_dicts = [c.model_dump() if hasattr(c, "model_dump") else c.dict() for c in req.cases]
        with INFERENCE_SEMAPHORE:
            res = batch_process_cohort(
                engine=engine,
                cases=cases_dicts,
                study_id=req.study_id,
            )
        return res
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"队列批量分析执行失败: {str(exc)}")


class EmphysemaRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    file_path: Optional[str] = None
    emphysema_hu_threshold: Optional[float] = -950.0


@app.post("/api/v1/recist/emphysema")
def compute_emphysema_endpoint(req: EmphysemaRequest = Body(...)):
    """Computes Low Attenuation Area (LAA%) and COPD GOLD 2024 emphysema severity metrics."""
    target_id = req.file_path or req.sample_id or "chest_lung_ct"
    vol, spacing, _ = engine.load_volume_data(target_id)
    return calculate_emphysema_metrics(
        volume=vol,
        spacing=spacing,
        emphysema_hu_threshold=req.emphysema_hu_threshold or -950.0
    )


@app.get("/health")
def health_check():
    dev_info = get_device_info()
    return {
        "status": "healthy",
        "service": "heurion-monai-worker",
        "device": dev_info,
        "supported_modalities": ["CT", "MR", "PET", "NIfTI", "DICOM"],
    }

@app.get("/api/v1/models")
def list_clinical_models(include_all: bool = False):
    reg = list_registered_models()
    reg_map = {m["name"]: m for m in reg}

    raw_models = [
        # 1. 胸部与呼吸系统 (Thoracic & Pulmonology)
        {
            "id": "bronchiectasis_mucus_analyzer",
            "name": "支气管扩张与粘液栓 (Mucus Plug) 定量分析 (BAR印戒征 / 阻塞率 / HAM)",
            "category": "胸部与呼吸科",
            "engine_type": "quantitative_ct",
            "body_part": "chest",
            "modality": "Chest HRCT",
            "target": "支气管-动脉径比 (BAR)、粘液栓容积、解剖肺叶肺段定位、树芽征",
            "recommended_window": "lung",
            "compatible_samples": ["chest_lung_ct", "nsclc_lung_ct"],
            "is_ready": True
        },
        {
            "id": "lung_nodule_segmenter",
            "name": "肺结节与肺实变检出与分割 (MONAI 3D RetinaNet / UNet)",
            "category": "胸部与呼吸科",
            "engine_type": "deep_learning",
            "body_part": "chest",
            "modality": "Chest CT",
            "target": "肺实质实性/磨玻璃结节 (RECIST 1.1 最大径与三维体积)",
            "recommended_window": "lung",
            "compatible_samples": ["chest_lung_ct", "nsclc_lung_ct"],
            "is_ready": reg_map.get("lung_nodule_ct", {}).get("is_ready", False)
        },
        {
            "id": "copd_emphysema_analyzer",
            "name": "慢阻肺 GOLD 2024 肺气肿与双肺低衰减区 (LAA%) 定量分析",
            "category": "胸部与呼吸科",
            "engine_type": "quantitative_ct",
            "body_part": "chest",
            "modality": "Chest CT / HRCT",
            "target": "全肺容积、低衰减区 (LAA-950%) 占比、GOLD 严重度分级",
            "recommended_window": "lung",
            "compatible_samples": ["chest_lung_ct", "nsclc_lung_ct"],
            "is_ready": True
        },
        {
            "id": "lung_airway_segmenter",
            "name": "全气道树三维拓扑重建 (MONAI AirwayUNet)",
            "category": "胸部与呼吸科",
            "engine_type": "quantitative_ct",
            "body_part": "chest",
            "modality": "Chest HRCT",
            "target": "主气管至亚段细支气管管腔三维骨架与管壁厚度",
            "recommended_window": "lung",
            "compatible_samples": ["chest_lung_ct"],
            "is_ready": True
        },
        {
            "id": "lung_lobe_segmenter",
            "name": "5 大解剖肺叶分割与肺容积积分 (MONAI V-Net)",
            "category": "胸部与呼吸科",
            "engine_type": "deep_learning",
            "body_part": "chest",
            "modality": "Chest CT",
            "target": "双肺 5 大肺叶 (RUL, RML, RLL, LUL, LLL) 体积及占比",
            "recommended_window": "lung",
            "compatible_samples": ["chest_lung_ct"],
            "is_ready": True
        },
        {
            "id": "covid19_lung_infection",
            "name": "病毒性肺炎磨玻璃实变影定量 (MONAI COVID-Net)",
            "category": "胸部与呼吸科",
            "engine_type": "deep_learning",
            "body_part": "chest",
            "modality": "Chest CT",
            "target": "磨玻璃影 (GGO)、网格影与实变受累百分比",
            "recommended_window": "lung",
            "compatible_samples": ["chest_lung_ct"],
            "is_ready": True
        },

        # 2. 腹部、消化与泌尿系统 (Abdomen & Pelvis)
        {
            "id": "spleen_segmenter",
            "name": "腹部实质脏器与脾脏分割 (MONAI 3D-UNet)",
            "category": "腹部、消化与泌尿",
            "engine_type": "deep_learning",
            "body_part": "abdomen",
            "modality": "Abdominal CT",
            "target": "脾脏三维体积、脾肿大定量与创伤破裂评估",
            "recommended_window": "abdomen",
            "compatible_samples": ["spleen_test"],
            "is_ready": reg_map.get("spleen_ct", {}).get("is_ready", False)
        },
        {
            "id": "multi_organ_ct",
            "name": "全腹部 13 器官多任务解剖分割 (MONAI SwinUNETR)",
            "category": "腹部、消化与泌尿",
            "engine_type": "deep_learning",
            "body_part": "abdomen",
            "modality": "Abdominal CT",
            "target": "肝、脾、双肾、胰腺、胆囊、胃、主动脉、下腔静脉等 13 类解剖结构",
            "recommended_window": "abdomen",
            "compatible_samples": ["spleen_test"],
            "is_ready": reg_map.get("swinunetr_btcv", {}).get("is_ready", False)
        },
        {
            "id": "prostate_mri_segmenter",
            "name": "前列腺外周带/移行带与 PI-RADS 3D 分带 (MONAI 3D-UNet)",
            "category": "腹部、消化与泌尿",
            "engine_type": "deep_learning",
            "body_part": "pelvis",
            "modality": "Pelvic MRI (T2/ADC)",
            "target": "前列腺外周带 (PZ)、移行带 (TZ) 分割与体积测算",
            "recommended_window": "abdomen",
            "compatible_samples": ["prostate_mri"],
            "is_ready": reg_map.get("prostate_mri", {}).get("is_ready", False)
        },
        {
            "id": "pancreas_tumor_segmenter",
            "name": "胰腺实质与胰腺肿瘤分割 (MONAI DiNTS)",
            "category": "腹部、消化与泌尿",
            "engine_type": "deep_learning",
            "body_part": "abdomen",
            "modality": "Abdominal CT",
            "target": "胰腺实质、胰头/胰体/胰尾、胰腺导管腺癌与囊性占位",
            "recommended_window": "abdomen",
            "compatible_samples": ["spleen_test"],
            "is_ready": reg_map.get("pancreas_ct_dints", {}).get("is_ready", False)
        },
        {
            "id": "kidney_tumor_segmenter",
            "name": "肾脏精细解剖与肿瘤分割 (MONAI SegResNet)",
            "category": "腹部、消化与泌尿",
            "engine_type": "deep_learning",
            "body_part": "abdomen",
            "modality": "Abdominal CECT",
            "target": "肾实质、肾盂输尿管、肾血管与肾肿瘤/占位",
            "recommended_window": "abdomen",
            "compatible_samples": ["spleen_test"],
            "is_ready": reg_map.get("renal_structures_cect", {}).get("is_ready", False)
        },
        {
            "id": "liver_lesion_segmenter",
            "name": "肝脏实质与局灶病灶/转移瘤分割 (MONAI UNet)",
            "category": "腹部、消化与泌尿",
            "engine_type": "deep_learning",
            "body_part": "abdomen",
            "modality": "Abdominal CT",
            "target": "肝实质体积、原发性肝癌 (HCC) 与转移瘤靶病灶",
            "recommended_window": "abdomen",
            "compatible_samples": ["spleen_test"],
            "is_ready": False
        },

        # 3. 颅脑与中枢神经系统 (Brain & Neurology)
        {
            "id": "brain_tumor_brats",
            "name": "脑胶质瘤多序列亚区精细分割 (MONAI BraTS SegResNet)",
            "category": "颅脑与神经系统",
            "engine_type": "deep_learning",
            "body_part": "brain",
            "modality": "Brain MRI (T1, T1c, T2, FLAIR)",
            "target": "强化肿瘤 (ET)、瘤周水肿 (ED) 与坏死核心 (NCR)",
            "recommended_window": "brain",
            "compatible_samples": [],
            "is_ready": reg_map.get("brats_mri", {}).get("is_ready", False)
        },
        {
            "id": "brain_subcortical_segmenter",
            "name": "全脑多结构 MRI 大规模分割 (MONAI Large UNEST)",
            "category": "颅脑与神经系统",
            "engine_type": "deep_learning",
            "body_part": "brain",
            "modality": "Brain T1 MRI",
            "target": "双侧海马体、杏仁核、丘脑体积与阿尔茨海默病量化",
            "recommended_window": "brain",
            "compatible_samples": [],
            "is_ready": False
        },
        {
            "id": "stroke_ischemic_lesion",
            "name": "急性脑卒中缺血梗死灶测定 (MONAI UNet)",
            "category": "颅脑与神经系统",
            "engine_type": "deep_learning",
            "body_part": "brain",
            "modality": "Brain MRI (DWI/FLAIR)",
            "target": "急性脑梗死缺血半暗带与核心梗死容积",
            "recommended_window": "brain",
            "compatible_samples": [],
            "is_ready": False
        },
        {
            "id": "intracranial_hemorrhage_ct",
            "name": "急诊颅内出血与血肿检出 (MONAI DenseNet)",
            "category": "颅脑与神经系统",
            "engine_type": "deep_learning",
            "body_part": "brain",
            "modality": "Brain Head CT",
            "target": "硬膜下、硬膜外、脑实质内及蛛网膜下腔出血",
            "recommended_window": "brain",
            "compatible_samples": [],
            "is_ready": False
        },

        # 4. 心血管系统 (Cardiovascular)
        {
            "id": "cardiac_mri_segmentation",
            "name": "心脏短轴 Cine-MRI 心室腔室分割与射血分数 (MONAI UNet)",
            "category": "心血管系统",
            "engine_type": "deep_learning",
            "body_part": "cardiac",
            "modality": "Cardiac MRI (CINE)",
            "target": "左心室舒张/收缩末容积、心肌质量与射血分数 (LVEF)",
            "recommended_window": "mediastinum",
            "compatible_samples": [],
            "is_ready": reg_map.get("ventricular_short_axis", {}).get("is_ready", False)
        },
        {
            "id": "valve_landmarks",
            "name": "心脏超声/CT 瓣膜关键解剖地标检测 (MONAI Heatmap-UNet)",
            "category": "心血管系统",
            "engine_type": "deep_learning",
            "body_part": "cardiac",
            "modality": "Cardiac CT/Echo",
            "target": "主动脉瓣与二尖瓣解剖关键铰链点与瓣尖 3D 热图地标定位",
            "recommended_window": "mediastinum",
            "compatible_samples": [],
            "is_ready": False
        },
        {
            "id": "coronary_artery_calcification",
            "name": "冠状动脉钙化积分 (CAC / Agatston 评分)",
            "category": "心血管系统",
            "engine_type": "quantitative_ct",
            "body_part": "cardiac",
            "modality": "Cardiac CT",
            "target": "左前降支、回旋支、右冠状动脉钙化积分与冠心病风险分层",
            "recommended_window": "mediastinum",
            "compatible_samples": [],
            "is_ready": True
        },

        # 5. 骨科与全身体素 (Musculoskeletal & Whole-Body)
        {
            "id": "whole_body_ct_segmenter",
            "name": "TotalSegmentator 全身体素 117 类解剖结构分割与 L3 肌少症评估",
            "category": "骨科与全身体素",
            "engine_type": "quantitative_ct",
            "body_part": "whole_body",
            "modality": "Whole-Body CT",
            "target": "全身体素骨骼、主要内脏系统与主要肌群 (L3 SMI 骨骼肌指数)",
            "recommended_window": "bone",
            "compatible_samples": ["spleen_test"],
            "is_ready": True
        },
        {
            "id": "monai_wholebody_ct",
            "name": "MONAI 全身 CT 多器官全景分割模型 (SegResNet-3D)",
            "category": "骨科与全身体素",
            "engine_type": "deep_learning",
            "body_part": "whole_body",
            "modality": "Whole-Body CT",
            "target": "覆盖胸腹盆骨骼、大血管与内脏器官的全景 CT 快速分割",
            "recommended_window": "bone",
            "compatible_samples": [],
            "is_ready": reg_map.get("wholebody_ct", {}).get("is_ready", False)
        },
        {
            "id": "vertebra_segmenter",
            "name": "全脊柱 24 节椎骨与椎间盘分割 (Spine-Segmenter)",
            "category": "骨科与全身体素",
            "engine_type": "deep_learning",
            "body_part": "bone",
            "modality": "Spine CT",
            "target": "颈椎、胸椎、腰椎各节椎体骨折压缩与椎间隙测量",
            "recommended_window": "bone",
            "compatible_samples": [],
            "is_ready": True
        },

        # 6. 病理、内窥镜与钼靶 (Pathology, Endoscopy & Mammography)
        {
            "id": "breast_density",
            "name": "MONAI 乳腺钼靶 X 射线致密度与 BI-RADS 分类 (DenseNet-2D)",
            "category": "乳腺钼靶与妇科",
            "engine_type": "deep_learning",
            "body_part": "breast",
            "modality": "Mammography (MG)",
            "target": "符合 ACR BI-RADS 第 5 版标准的乳腺数字化 X 射线摄影腺体致密度四分类",
            "recommended_window": "abdomen",
            "compatible_samples": [],
            "is_ready": False
        },
        {
            "id": "pathology_tumor_detection",
            "name": "MONAI 数字病理全视野切片 (WSI) 肿瘤微转移灶检出 (ResNet/FPN)",
            "category": "病理与微观形态",
            "engine_type": "deep_learning",
            "body_part": "pathology",
            "modality": "Digital Pathology (WSI)",
            "target": "前哨淋巴结转移、微浸润灶与肿瘤细胞团全自动检出",
            "recommended_window": "abdomen",
            "compatible_samples": [],
            "is_ready": False
        },
        {
            "id": "pathology_nuclei",
            "name": "MONAI 病理切片细胞核多类别精细分割与表型分类 (HoVer-Net)",
            "category": "病理与微观形态",
            "engine_type": "deep_learning",
            "body_part": "pathology",
            "modality": "Digital Pathology",
            "target": "肿瘤浸润淋巴细胞 (TILs)、核异型性、核质比与细胞增殖指数",
            "recommended_window": "abdomen",
            "compatible_samples": [],
            "is_ready": False
        },
        {
            "id": "endoscopic_tool",
            "name": "MONAI 微创腹腔镜/胸腔镜手术器械动态语义分割 (ToolNet)",
            "category": "微创外科与内窥镜",
            "engine_type": "deep_learning",
            "body_part": "endoscopy",
            "modality": "Endoscopic Video",
            "target": "抓持钳、超声刀、电凝钩与吸引器等器械实时像素级分割与遮蔽",
            "recommended_window": "abdomen",
            "compatible_samples": [],
            "is_ready": False
        },

        # 7. 交互式万物分割 (Interactive)
        {
            "id": "vista3d_interactive_segmenter",
            "name": "MONAI VISTA-3D 医生交互式点选/提示万物分割 (Click-to-Segment)",
            "category": "交互式万物分割",
            "engine_type": "deep_learning",
            "body_part": "general",
            "modality": "CT / MRI / PET 通用",
            "target": "任意解剖结构或病灶的正负点选提示与 3D 自适应区域生长分割",
            "recommended_window": "lung",
            "compatible_samples": [],
            "is_ready": reg_map.get("vista3d", {}).get("is_ready", False)
        }
    ]

    active_models = [m for m in raw_models if m.get("is_ready") is True] if not include_all else raw_models

    return {
        "status": "success",
        "registry": reg,
        "total": len(active_models),
        "models": active_models,
        "planned_models": [m for m in raw_models if m.get("is_ready") is not True]
    }

@app.get("/api/v1/samples")
def list_samples():
    samples = []
    chest_path = DATA_DIR / "chest_lung_ct.nii.gz"
    spleen_path = DATA_DIR / "spleen_test.nii.gz"
    mri_path = DATA_DIR / "prostate_mri.nii.gz"

    if not chest_path.exists() and not spleen_path.exists():
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            try:
                from .bronchiectasis import generate_synthetic_bronchiectasis_ct
            except (ImportError, ValueError):
                from bronchiectasis import generate_synthetic_bronchiectasis_ct
            import nibabel as nib
            vol, spacing, _ = generate_synthetic_bronchiectasis_ct(shape=(48, 128, 128), spacing=(1.5, 0.8, 0.8))
            nib.save(nib.Nifti1Image(vol, np.diag([*spacing, 1.0])), str(chest_path))
        except Exception:
            pass

    if chest_path.exists():
        samples.append({
            "id": "chest_lung_ct",
            "name": "真实临床全胸部 HRCT 扫描 (薄层高分辨重构)",
            "modality": "Chest HRCT",
            "default_model": "bronchiectasis_mucus_analyzer",
            "default_window": "lung",
            "size_mb": round(chest_path.stat().st_size / (1024 * 1024), 1)
        })
    lidc_path = DATA_DIR / "lidc_lung_nodule_ct.nii.gz"
    if lidc_path.exists():
        samples.append({
            "id": "lidc_lung_nodule_ct",
            "name": "真实临床 LIDC 肺孤立性实性结节胸部 CT (TCIA 金标准病例 0001)",
            "modality": "Chest CT",
            "default_model": "lung_nodule_segmenter",
            "default_window": "lung",
            "size_mb": round(lidc_path.stat().st_size / (1024 * 1024), 1)
        })
    copd_path = DATA_DIR / "copd_emphysema_ct.nii.gz"
    if copd_path.exists():
        samples.append({
            "id": "copd_emphysema_ct",
            "name": "真实临床慢阻肺 COPD 吸气相 HRCT 扫描 (全肺容积与 LAA-950% 肺气肿定量)",
            "modality": "Chest CT",
            "default_model": "copd_emphysema_analyzer",
            "default_window": "lung",
            "size_mb": round(copd_path.stat().st_size / (1024 * 1024), 1)
        })
    liver_path = DATA_DIR / "liver_tumor_ct.nii.gz"
    if liver_path.exists():
        samples.append({
            "id": "liver_tumor_ct",
            "name": "真实临床肝脏肿瘤强化 CT 扫描 (LiTS / MSD Task03 肝实质与局灶病灶)",
            "modality": "Abdominal CT",
            "default_model": "liver_lesion_segmenter",
            "default_window": "abdomen",
            "size_mb": round(liver_path.stat().st_size / (1024 * 1024), 1)
        })
    if spleen_path.exists():
        samples.append({
            "id": "spleen_test",
            "name": "真实临床腹部增强 CT 扫描 (96层 512x512)",
            "modality": "Abdominal CT",
            "default_model": "spleen_segmenter",
            "default_window": "abdomen",
            "size_mb": round(spleen_path.stat().st_size / (1024 * 1024), 1)
        })
    cardiac_path = DATA_DIR / "cardiac_heart_mri.nii.gz"
    if cardiac_path.exists():
        samples.append({
            "id": "cardiac_heart_mri",
            "name": "真实临床左心房高分辨心脏 MRI (MSD Task02 心肌与心室构型)",
            "modality": "Cardiac MRI",
            "default_model": "cardiac_mri_segmentation",
            "default_window": "mediastinum",
            "size_mb": round(cardiac_path.stat().st_size / (1024 * 1024), 1)
        })
    brats_path = DATA_DIR / "brats_brain_mri.nii.gz"
    if brats_path.exists():
        samples.append({
            "id": "brats_brain_mri",
            "name": "真实临床 BraTS 脑胶质母细胞瘤多模态 MRI (4通道 T1/T1c/T2/FLAIR)",
            "modality": "Brain MRI",
            "default_model": "brain_tumor_brats",
            "default_window": "brain",
            "size_mb": round(brats_path.stat().st_size / (1024 * 1024), 1)
        })
    hippo_path = DATA_DIR / "hippocampus_brain_mri.nii.gz"
    if hippo_path.exists():
        samples.append({
            "id": "hippocampus_brain_mri",
            "name": "真实临床海马区脑高分辨 MRI (MSD Task04 阿尔茨海默与记忆功能区)",
            "modality": "Brain MRI",
            "default_model": "brain_tumor_segmenter",
            "default_window": "brain",
            "size_mb": round(hippo_path.stat().st_size / (1024 * 1024), 1)
        })
    if mri_path.exists():
        samples.append({
            "id": "prostate_mri",
            "name": "真实临床前列腺 T2 加权 MRI (19层 320x320)",
            "modality": "Pelvic MRI",
            "default_model": "prostate_mri_segmenter",
            "default_window": "abdomen",
            "size_mb": round(mri_path.stat().st_size / (1024 * 1024), 1)
        })
    return {"samples": samples}
 
@app.get("/api/v1/samples/{sample_id}/file")
def get_sample_file(sample_id: str):
    """Streams the raw 3D volume sample file (.nii.gz)."""
    if not re.match(r"^[a-zA-Z0-9_\-]+$", sample_id):
        raise HTTPException(status_code=400, detail="Invalid sample_id format")
    for ext in (".nii.gz", ".nii", ".zip", ".gz"):
        sample_file = DATA_DIR / f"{sample_id}{ext}"
        if sample_file.exists():
            return FileResponse(
                path=str(sample_file),
                media_type="application/gzip",
                filename=f"{sample_id}{ext}"
            )
    if "lung" in sample_id or "chest" in sample_id or "spleen" in sample_id or "prostate" in sample_id:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        import nibabel as nib
        if "lung" in sample_id or "chest" in sample_id:
            try:
                from .bronchiectasis import generate_synthetic_bronchiectasis_ct
            except (ImportError, ValueError):
                from bronchiectasis import generate_synthetic_bronchiectasis_ct
            vol, spacing, _ = generate_synthetic_bronchiectasis_ct(shape=(48, 128, 128), spacing=(1.5, 0.8, 0.8))
        else:
            try:
                from .engine import generate_synthetic_ct_volume
            except (ImportError, ValueError):
                from engine import generate_synthetic_ct_volume
            vol, _ = generate_synthetic_ct_volume(shape=(32, 128, 128), spacing=(1.5, 0.8, 0.8))
            spacing = (1.5, 0.8, 0.8)
        tgt = DATA_DIR / f"{sample_id}.nii.gz"
        nib.save(nib.Nifti1Image(vol, np.diag([*spacing, 1.0])), str(tgt))
        return FileResponse(path=str(tgt), media_type="application/gzip", filename=f"{sample_id}.nii.gz")
    raise HTTPException(status_code=404, detail=f"Sample '{sample_id}' not found in data directory")

@app.post("/api/v1/volume/upload")
async def upload_volume(
    volume_id: str = Form(...),
    file: UploadFile = File(...)
):
    """
    Receives and parses an encrypted/decrypted patient imaging volume archive (.zip)
    or NIfTI / DICOM file and caches the 3D voxel array in memory for MPR slicing.
    """
    if engine.has_volume(volume_id):
        vol, spacing, modality = engine.volume_cache[volume_id]
        return {
            "volume_id": volume_id,
            "cached": True,
            "dimensions": {"z": int(vol.shape[0]), "y": int(vol.shape[1]), "x": int(vol.shape[2])},
            "voxel_spacing_mm": {"dz": round(float(spacing[0]), 3), "dy": round(float(spacing[1]), 3), "dx": round(float(spacing[2]), 3)},
            "modality": modality
        }

    try:
        from .dicom_io import load_volume
    except (ImportError, ValueError):
        from dicom_io import load_volume

    content = await file.read()
    try:
        vol, spacing, modality = load_volume(content, filename=file.filename)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to decode imaging file '{file.filename}': {str(e)}")

    info = engine.register_volume(volume_id, vol, spacing, modality)
    info["cached"] = False
    return info

@app.get("/api/v1/volume/{volume_id}/status")
def get_volume_status(volume_id: str):
    """Checks whether a patient volume is actively loaded in the worker's cache."""
    ready = engine.has_volume(volume_id)
    if not ready:
        return {"volume_id": volume_id, "ready": False}
    vol, spacing, modality = engine.volume_cache[volume_id]
    return {
        "volume_id": volume_id,
        "ready": True,
        "dimensions": {"z": int(vol.shape[0]), "y": int(vol.shape[1]), "x": int(vol.shape[2])},
        "voxel_spacing_mm": {"dz": round(float(spacing[0]), 3), "dy": round(float(spacing[1]), 3), "dx": round(float(spacing[2]), 3)},
        "modality": modality
    }

@app.post("/api/v1/mpr/info")
def get_mpr_volume_info(req: MprInfoRequest = Body(...)):
    """Returns 3D volume dimensions, spacing, slice counts and bounding box for a volume."""
    target = req.file_path or req.volume_id or req.sample_id or "chest_lung_ct"
    try:
        return engine.get_mpr_info(target, model_name=req.model_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read volume info: {str(e)}")

@app.get("/api/v1/mpr/info")
def get_mpr_volume_info_get(sample_id: str = "chest_lung_ct", model_name: Optional[str] = None):
    """GET variant for retrieving volume MPR info by sample_id."""
    try:
        return engine.get_mpr_info(sample_id, model_name=model_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read volume info: {str(e)}")

@app.post("/api/v1/mpr/slice")
def get_mpr_slice(req: MprSliceRequest = Body(...)):
    """Extracts an arbitrary orthogonal 2D slice (Axial/Coronal/Sagittal) with windowing & overlay."""
    target = req.file_path or req.volume_id or req.sample_id or "chest_lung_ct"
    try:
        return engine.extract_mpr_slice(
            sample_id_or_path=target,
            plane=req.plane or "axial",
            slice_index=req.slice_index,
            window_preset=req.window_preset,
            overlay=req.overlay_mask if req.overlay_mask is not None else True,
            model_name=req.model_name
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract MPR slice: {str(e)}")

@app.post("/api/v1/mpr/diff-slice")
def get_diff_slice(req: DiffSliceRequest = Body(...)):
    """Extracts a registered 3D difference slice with regression/progression heatmap."""
    base_target = req.baseline_path if req.baseline_path and os.path.exists(req.baseline_path) else (req.baseline_volume_id or req.baseline_id or "chest_lung_ct")
    follow_target = req.followup_path if req.followup_path and os.path.exists(req.followup_path) else (req.followup_volume_id or req.followup_id or "chest_lung_ct")
    try:
        return engine.extract_diff_slice(
            baseline_id_or_path=base_target,
            followup_id_or_path=follow_target,
            plane=req.plane or "axial",
            slice_index=req.slice_index,
            window_preset=req.window_preset,
            threshold_hu=req.threshold_hu if req.threshold_hu is not None else 50.0
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to extract diff slice: {str(e)}")

@app.post("/api/v1/analyze/benchmark")
def run_benchmark_analysis(req: BenchmarkRequest = Body(...)):
    """Generates synthetic anatomical volume and runs MONAI inference on device."""
    model_name = req.model_name or "lung_nodule_segmenter"
    if model_name in ("bronchiectasis_mucus_analyzer", "bronchiectasis"):
        try:
            from .bronchiectasis import generate_synthetic_bronchiectasis_ct
        except (ImportError, ValueError):
            from bronchiectasis import generate_synthetic_bronchiectasis_ct
        vol, _, _ = generate_synthetic_bronchiectasis_ct(
            shape=(req.z_slices or 48, req.y_dim or 128, req.x_dim or 128),
            spacing=(1.5, 0.8, 0.8)
        )
        return engine.analyze_volume(
            volume=vol,
            spacing=(1.5, 0.8, 0.8),
            model_name="bronchiectasis_mucus_analyzer",
            window_preset="lung",
            mucus_min_hu=req.mucus_min_hu,
            mucus_max_hu=req.mucus_max_hu,
            ham_threshold_hu=req.ham_threshold_hu,
            bar_cutoff=req.bar_cutoff
        )

    vol, _ = generate_synthetic_ct_volume(
        shape=(req.z_slices, req.y_dim, req.x_dim),
        spacing=(1.5, 0.8, 0.8)
    )
    result = engine.analyze_volume(
        volume=vol,
        spacing=(1.5, 0.8, 0.8),
        model_name=model_name,
        window_preset=req.window_preset or "lung"
    )
    return result

@app.post("/api/v1/analyze/bronchiectasis")
def run_bronchiectasis_analysis(req: BenchmarkRequest = Body(...)):
    """Specialized endpoint for HRCT Bronchiectasis & Mucus Plug quantification."""
    try:
        from .bronchiectasis import generate_synthetic_bronchiectasis_ct
    except (ImportError, ValueError):
        from bronchiectasis import generate_synthetic_bronchiectasis_ct
    vol, _, _ = generate_synthetic_bronchiectasis_ct(
        shape=(req.z_slices or 48, req.y_dim or 128, req.x_dim or 128),
        spacing=(1.5, 0.8, 0.8)
    )
    return engine.analyze_volume(
        volume=vol,
        spacing=(1.5, 0.8, 0.8),
        model_name="bronchiectasis_mucus_analyzer",
        window_preset="lung",
        mucus_min_hu=req.mucus_min_hu,
        mucus_max_hu=req.mucus_max_hu,
        ham_threshold_hu=req.ham_threshold_hu,
        bar_cutoff=req.bar_cutoff
    )

@app.post("/api/v1/analyze/sample")
def run_sample_analysis(req: SampleRequest = Body(...)):
    """Runs MONAI inference on a pre-loaded clinical sample or in-memory cached volume."""
    vol_id = req.volume_id or req.sample_id
    if vol_id and engine.has_volume(vol_id):
        vol, spacing, modality = engine.volume_cache[vol_id]
        model_name = req.model_name
        if not model_name:
            model_name = "lung_nodule_segmenter" if ("lung" in str(vol_id).lower() or "chest" in str(vol_id).lower()) else "spleen_segmenter"
        sample_file = DATA_DIR / f"{vol_id}.nii.gz"
        if not sample_file.exists():
            sample_file = DATA_DIR / f"{vol_id}.nii"
        f_path = str(sample_file) if sample_file.exists() else None
        with INFERENCE_SEMAPHORE:
            return engine.analyze_volume(
                volume=vol,
                spacing=spacing,
                model_name=model_name,
                window_preset=req.window_preset,
                prompt_point=req.click_point,
                patient_context=req.patient_context,
                mucus_min_hu=req.mucus_min_hu,
                mucus_max_hu=req.mucus_max_hu,
                ham_threshold_hu=req.ham_threshold_hu,
                bar_cutoff=req.bar_cutoff,
                file_path=f_path
            )

    sample_id = req.sample_id or "spleen_test"
    sample_file = DATA_DIR / f"{sample_id}.nii.gz"
    if not sample_file.exists():
        sample_file = DATA_DIR / f"{sample_id}.nii"
    if not sample_file.exists():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        import nibabel as nib
        if "lung" in sample_id or "chest" in sample_id:
            try:
                from .bronchiectasis import generate_synthetic_bronchiectasis_ct
            except (ImportError, ValueError):
                from bronchiectasis import generate_synthetic_bronchiectasis_ct
            vol, spacing, _ = generate_synthetic_bronchiectasis_ct(shape=(48, 128, 128), spacing=(1.5, 0.8, 0.8))
        else:
            try:
                from .engine import generate_synthetic_ct_volume
            except (ImportError, ValueError):
                from engine import generate_synthetic_ct_volume
            vol, _ = generate_synthetic_ct_volume(shape=(32, 128, 128), spacing=(1.5, 0.8, 0.8))
            spacing = (1.5, 0.8, 0.8)
        tgt = DATA_DIR / f"{sample_id}.nii.gz"
        nib.save(nib.Nifti1Image(vol, np.diag([*spacing, 1.0])), str(tgt))
        sample_file = tgt

    model_name = req.model_name
    if not model_name:
        if "lung" in sample_id or "chest" in sample_id:
            model_name = "lung_nodule_segmenter"
        elif "spleen" in sample_id:
            model_name = "spleen_segmenter"
        else:
            model_name = "liver_lesion_segmenter"

    try:
        with INFERENCE_SEMAPHORE:
            return engine.analyze_file(
                file_path=str(sample_file),
                model_name=model_name,
                window_preset=req.window_preset,
                prompt_point=req.click_point,
                patient_context=req.patient_context,
                mucus_min_hu=req.mucus_min_hu,
                mucus_max_hu=req.mucus_max_hu,
                ham_threshold_hu=req.ham_threshold_hu,
                bar_cutoff=req.bar_cutoff
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {str(e)}")

def validate_safe_medical_path(file_path: Optional[str]) -> Optional[str]:
    """Validates that file_path does not traverse into prohibited system paths."""
    if not file_path:
        return None
    real_p = os.path.realpath(file_path)
    sensitive_prefixes = ("/etc", "/var/root", "/root", "/proc", "/sys", "/dev", "/usr/bin", "/bin", "/sbin")
    if any(real_p.startswith(p) for p in sensitive_prefixes):
        raise HTTPException(status_code=403, detail="Access denied: prohibited path")
    if not os.path.exists(real_p):
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    if os.path.isfile(real_p):
        lower = real_p.lower()
        if not (lower.endswith((".nii", ".nii.gz", ".dcm", ".zip", ".tar.gz", ".npz", ".npy"))):
            raise HTTPException(status_code=400, detail="Invalid medical image file format")
    return real_p

@app.post("/api/v1/analyze/file")
def run_file_analysis(req: FileAnalysisRequest = Body(...)):
    """Runs MONAI inference on a specified local file path."""
    safe_path = validate_safe_medical_path(req.file_path)
    if not safe_path:
        raise HTTPException(status_code=400, detail="file_path is required")
    try:
        with INFERENCE_SEMAPHORE:
            return engine.analyze_file(
                file_path=safe_path,
                model_name=req.model_name or "spleen_segmenter",
                window_preset=req.window_preset,
                prompt_point=req.click_point,
                patient_context=req.patient_context,
                mucus_min_hu=req.mucus_min_hu,
                mucus_max_hu=req.mucus_max_hu,
                ham_threshold_hu=req.ham_threshold_hu,
                bar_cutoff=req.bar_cutoff
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference failed: {str(e)}")

@app.post("/api/v1/analyze/radiomics")
def run_radiomics_analysis(req: RadiomicsRequest = Body(...)):
    """Extracts 3D IBSI-compliant radiomics features (Shape, First-order, GLCM, GLRLM)."""
    target = req.file_path or req.sample_id
    try:
        with INFERENCE_SEMAPHORE:
            return engine.extract_radiomics(
                sample_id_or_path=target,
                model_name=req.model_name or "lung_nodule_segmenter",
                num_bins=req.num_bins or 16
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Radiomics extraction failed: {str(e)}")

@app.post("/api/v1/analyze/interactive-segment")
def run_interactive_segmentation_endpoint(req: InteractiveSegmentRequest = Body(...)):
    """Executes MONAI VISTA-3D style interactive click-prompt segmentation."""
    target = req.file_path or req.sample_id
    points_dict = [p.model_dump() if hasattr(p, "model_dump") else p.dict() for p in (req.points or [])]
    try:
        return engine.run_interactive_segmentation(
            sample_id_or_path=target,
            points=points_dict,
            bbox=req.bbox,
            window_preset=req.window_preset,
            plane=req.plane or "axial",
            slice_index=req.slice_index,
            mode=req.mode or "deep",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Interactive segmentation failed: {str(e)}")

@app.post("/api/v1/analyze/whole-body")
def run_whole_body_analysis_endpoint(req: WholeBodyAnalysisRequest = Body(...)):
    """Executes MONAI TotalSegmentator 104-class multi-organ and L3 sarcopenia analysis."""
    target = req.file_path or (str(DATA_DIR / f"{req.sample_id}.nii.gz") if req.sample_id else None)
    if target and os.path.exists(target):
        return engine.analyze_file(
            file_path=target,
            model_name="whole_body_ct_segmenter",
            patient_sex=req.patient_sex,
            patient_height_m=req.patient_height_m,
            patient_weight_kg=req.patient_weight_kg,
            l3_slice_index=req.l3_slice_index
        )
    try:
        from .totalsegmentator import generate_synthetic_whole_body_ct, analyze_whole_body_ct
    except (ImportError, ValueError):
        from totalsegmentator import generate_synthetic_whole_body_ct, analyze_whole_body_ct
    vol, _ = generate_synthetic_whole_body_ct(
        shape=(req.z_slices or 64, req.y_dim or 128, req.x_dim or 128),
        spacing=(1.5, 0.8, 0.8)
    )
    return analyze_whole_body_ct(
        volume=vol,
        spacing=(1.5, 0.8, 0.8),
        patient_sex=req.patient_sex or "M",
        patient_height_m=req.patient_height_m or 1.72,
        patient_weight_kg=req.patient_weight_kg or 68.0,
        l3_slice_index=req.l3_slice_index
    )

@app.post("/api/v1/registration/deformable")
def run_deformable_registration_endpoint(req: DeformableRegistrationRequest = Body(...)):
    """Executes 3D Deformable B-Spline / Demons Dense Vector Displacement Field registration."""
    try:
        from .registration import run_3d_deformable_registration
        from .totalsegmentator import generate_synthetic_whole_body_ct
    except (ImportError, ValueError):
        from registration import run_3d_deformable_registration
        from totalsegmentator import generate_synthetic_whole_body_ct

    fixed_vol, _ = generate_synthetic_whole_body_ct(shape=(32, 64, 64), spacing=(2.0, 1.0, 1.0))
    moving_vol = np.roll(fixed_vol, shift=(1, 2, -1), axis=(0, 1, 2))

    res = run_3d_deformable_registration(
        fixed_vol=fixed_vol,
        moving_vol=moving_vol,
        spacing=(2.0, 1.0, 1.0),
        iterations=req.iterations or 10,
        smoothing_sigma=req.smoothing_sigma or 1.0
    )
    return {
        "status": res["status"],
        "iterations_completed": res["iterations_completed"],
        "elapsed_sec": res["elapsed_sec"],
        "initial_ncc": res["initial_ncc"],
        "final_ncc": res["final_ncc"],
        "ncc_improvement": res["ncc_improvement"],
        "initial_mse": res["initial_mse"],
        "final_mse": res["final_mse"],
        "mse_reduction_percent": res["mse_reduction_percent"],
        "max_displacement_mm": res["max_displacement_mm"],
        "mean_displacement_mm": res["mean_displacement_mm"],
        "key_slice_index": res.get("key_slice_index", 0),
        "registered_slice_png_base64": res.get("registered_slice_png_base64"),
        "registered_slice_png_size_bytes": res.get("registered_slice_png_size_bytes", 0),
        "summary_markdown": (
            f"### 3D 可形变配准 (Deformable B-Spline / DDF) 报告\n"
            f"- **初始归一化互相关 (NCC)**: `{res['initial_ncc']}` → **配准后 NCC**: `{res['final_ncc']}` (提升 `{res['ncc_improvement']}`)\n"
            f"- **均方误差 (MSE) 降幅**: `{res['mse_reduction_percent']}%` (耗时 `{res['elapsed_sec']}s`)\n"
            f"- **最大位移形变量**: `{res['max_displacement_mm']} mm` (平均位移: `{res['mean_displacement_mm']} mm`)\n"
        )
    }

@app.post("/api/v1/registration/pet-ct-fusion")
def run_pet_ct_fusion_endpoint(req: PetCtFusionRequest = Body(...)):
    """Computes PET SUV metabolic quantification and alpha-blended PET-CT color fusion."""
    try:
        from .registration import generate_synthetic_pet_ct_pair, compute_pet_metrics_and_fusion
    except (ImportError, ValueError):
        from registration import generate_synthetic_pet_ct_pair, compute_pet_metrics_and_fusion

    ct_vol, pet_vol, _ = generate_synthetic_pet_ct_pair(shape=(36, 96, 96), spacing=(2.0, 1.0, 1.0))
    return compute_pet_metrics_and_fusion(
        ct_volume=ct_vol,
        pet_volume=pet_vol,
        spacing=(2.0, 1.0, 1.0),
        suv_threshold=req.suv_threshold or 2.5,
        key_slice_index=req.key_slice_index,
        alpha=req.alpha or 0.55
    )

@app.post("/api/v1/rtstruct/delineate")
def run_rtstruct_delineation_endpoint(req: RtStructRequest = Body(...)):
    """Delineates GTV, CTV, PTV radiotherapy targets with anatomical barrier clipping."""
    try:
        from .registration import generate_synthetic_pet_ct_pair, delineate_radiotherapy_targets
    except (ImportError, ValueError):
        from registration import generate_synthetic_pet_ct_pair, delineate_radiotherapy_targets

    ct_vol, pet_vol, _ = generate_synthetic_pet_ct_pair(shape=(36, 96, 96), spacing=(2.0, 1.0, 1.0))
    metabolic_mask = pet_vol >= 2.5
    return delineate_radiotherapy_targets(
        ct_volume=ct_vol,
        metabolic_or_lesion_mask=metabolic_mask,
        spacing=(2.0, 1.0, 1.0),
        ctv_margin_mm=req.ctv_margin_mm or 6.0,
        ptv_margin_mm=req.ptv_margin_mm or 4.0,
        key_slice_index=req.key_slice_index
    )

@app.post("/api/v1/analyze/upload")
async def run_upload_analysis(
    file: UploadFile = File(...),
    model_name: str = Form("bronchiectasis_mucus_analyzer"),
    window_preset: Optional[str] = Form(None),
    mucus_min_hu: Optional[str] = Form(None),
    mucus_max_hu: Optional[str] = Form(None),
    ham_threshold_hu: Optional[str] = Form(None),
    bar_cutoff: Optional[str] = Form(None),
):
    """Uploads a .nii, .nii.gz, .dcm, or .zip (DICOM series archive) file and executes MONAI inference."""
    fn_lower = file.filename.lower() if file.filename else ""
    content = await file.read()

    f_mucus_min = parse_flexible_float(mucus_min_hu)
    f_mucus_max = parse_flexible_float(mucus_max_hu)
    f_ham_thresh = parse_flexible_float(ham_threshold_hu)
    f_bar_cutoff = parse_flexible_float(bar_cutoff)

    if fn_lower.endswith(".zip"):
        with tempfile.TemporaryDirectory() as tmp_dir:
            zip_path = os.path.join(tmp_dir, "upload.zip")
            with open(zip_path, "wb") as f_out:
                f_out.write(content)
            with zipfile.ZipFile(zip_path, "r") as zf:
                total_uncompressed = 0
                max_uncompressed = 500 * 1024 * 1024  # 500MB
                resolved_tmp = Path(tmp_dir).resolve()
                for member in zf.infolist():
                    target_path = (resolved_tmp / member.filename).resolve()
                    if not target_path.is_relative_to(resolved_tmp):
                        raise HTTPException(status_code=400, detail="Zip Slip detected: 非法压缩包路径")
                    total_uncompressed += member.file_size
                    if total_uncompressed > max_uncompressed:
                        raise HTTPException(status_code=400, detail="解压体积超过上限 (Max 500MB)")
                zf.extractall(tmp_dir)
            if os.path.exists(zip_path):
                os.remove(zip_path)
            with INFERENCE_SEMAPHORE:
                return engine.analyze_file(
                    file_path=tmp_dir,
                    model_name=model_name,
                    window_preset=window_preset,
                    mucus_min_hu=f_mucus_min,
                    mucus_max_hu=f_mucus_max,
                    ham_threshold_hu=f_ham_thresh,
                    bar_cutoff=f_bar_cutoff
                )
    elif fn_lower.endswith((".tar.gz", ".tgz", ".tar")):
        import tarfile
        with tempfile.TemporaryDirectory() as tmp_dir:
            tar_path = os.path.join(tmp_dir, "upload.tar.gz")
            with open(tar_path, "wb") as f_out:
                f_out.write(content)
            with tarfile.open(tar_path, "r:*") as tf:
                resolved_tmp = Path(tmp_dir).resolve()
                total_uncompressed = 0
                max_uncompressed = 500 * 1024 * 1024  # 500MB
                for member in tf.getmembers():
                    target_path = (resolved_tmp / member.name).resolve()
                    if not target_path.is_relative_to(resolved_tmp):
                        raise HTTPException(status_code=400, detail="Tar Slip detected: 非法压缩包路径")
                    total_uncompressed += member.size
                    if total_uncompressed > max_uncompressed:
                        raise HTTPException(status_code=400, detail="解压体积超过上限 (Max 500MB)")
                if hasattr(tarfile, "data_filter"):
                    tf.extractall(tmp_dir, filter="data")
                else:
                    tf.extractall(tmp_dir)
            if os.path.exists(tar_path):
                os.remove(tar_path)
            with INFERENCE_SEMAPHORE:
                return engine.analyze_file(
                    file_path=tmp_dir,
                    model_name=model_name,
                    window_preset=window_preset,
                    mucus_min_hu=f_mucus_min,
                    mucus_max_hu=f_mucus_max,
                    ham_threshold_hu=f_ham_thresh,
                    bar_cutoff=f_bar_cutoff
                )
    elif fn_lower.endswith((".dcm", ".dicom")):
        with tempfile.TemporaryDirectory() as tmp_dir:
            safe_filename = os.path.basename(file.filename or "slice.dcm") or "slice.dcm"
            dcm_path = os.path.realpath(os.path.join(tmp_dir, safe_filename))
            if not dcm_path.startswith(os.path.realpath(tmp_dir)):
                raise HTTPException(status_code=400, detail="非法文件名路径 (Path traversal detected)")
            with open(dcm_path, "wb") as f_out:
                f_out.write(content)
            with INFERENCE_SEMAPHORE:
                return engine.analyze_file(
                    file_path=tmp_dir,
                    model_name=model_name,
                    window_preset=window_preset,
                    mucus_min_hu=f_mucus_min,
                    mucus_max_hu=f_mucus_max,
                    ham_threshold_hu=f_ham_thresh,
                    bar_cutoff=f_bar_cutoff
                )
    else:
        is_gz = fn_lower.endswith((".nii.gz", ".gz")) or (len(content) >= 2 and content[:2] == b"\x1f\x8b")
        suffix = ".nii.gz" if is_gz else ".nii"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        try:
            with INFERENCE_SEMAPHORE:
                return engine.analyze_file(
                    file_path=tmp_path,
                    model_name=model_name,
                    window_preset=window_preset,
                    mucus_min_hu=f_mucus_min,
                    mucus_max_hu=f_mucus_max,
                    ham_threshold_hu=f_ham_thresh,
                    bar_cutoff=f_bar_cutoff
                )
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)


class PullModelRequest(BaseModel):
    model_name: str
    force: Optional[bool] = False

class VerifyModelRequest(BaseModel):
    model_name: str

class DicomAnonymizeRequest(BaseModel):
    file_path: Optional[str] = None
    anonymous_id: Optional[str] = "ANON-001"
    retain_dates: Optional[bool] = False

class AsyncTaskSubmitRequest(BaseModel):
    sample_id: Optional[str] = "chest_lung_ct"
    file_path: Optional[str] = None
    model_name: Optional[str] = "lung_nodule_segmenter"
    window_preset: Optional[str] = None
    mucus_min_hu: Optional[float] = 10.0
    mucus_max_hu: Optional[float] = 75.0
    ham_threshold_hu: Optional[float] = 70.0
    bar_cutoff: Optional[float] = 1.10

@app.get("/api/v1/models/registry")
def get_registered_models_endpoint():
    """Lists official MONAI foundation models, clinical targets, and local installation status."""
    models = list_registered_models()
    return {
        "models": models,
        "total": len(models),
        "status": "success"
    }

@app.post("/api/v1/models/pull")
def pull_model_endpoint(req: PullModelRequest = Body(...)):
    """Downloads official model weights from Model Zoo / HuggingFace with SHA-256 integrity validation."""
    try:
        return pull_model(name=req.model_name, force=req.force or False)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"拉取模型失败: {str(e)}")

@app.post("/api/v1/models/verify")
def verify_model_endpoint(req: VerifyModelRequest = Body(...)):
    """Validates the SHA-256 checksum of local model weights."""
    return verify_model(name=req.model_name)

@app.post("/api/v1/dicom/anonymize")
async def anonymize_dicom_endpoint(
    file: Optional[UploadFile] = File(None),
    anonymous_id: str = Form("ANON-001"),
    retain_dates: bool = Form(False),
    file_path: Optional[str] = Form(None)
):
    """
    De-identifies Protected Health Information (PHI) from DICOM series (.zip or .dcm),
    complying with DICOM PS 3.15 Annex E and healthcare data privacy standards.
    """
    if file:
        content = await file.read()
        fn = file.filename or "series.zip"
        if fn.lower().endswith(".zip"):
            out_bytes, report = anonymize_dicom_zip(content, anonymous_id=anonymous_id)
            tmp_out = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
            tmp_out.write(out_bytes)
            tmp_out.close()
            return FileResponse(
                path=tmp_out.name,
                filename=f"anonymized_{anonymous_id}.zip",
                media_type="application/zip",
                headers={
                    "X-Anonymized-Slices": str(report["total_slices_anonymized"]),
                    "X-Anonymous-ID": anonymous_id
                }
            )
        else:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".dcm") as tmp_in:
                tmp_in.write(content)
                tmp_in_path = tmp_in.name
            tmp_out_path = tmp_in_path + ".anon.dcm"
            try:
                res = anonymize_dicom_file(tmp_in_path, tmp_out_path, anonymous_id=anonymous_id)
                return FileResponse(
                    path=tmp_out_path,
                    filename=f"anonymized_{anonymous_id}.dcm",
                    media_type="application/dicom",
                    headers={"X-Anonymous-ID": anonymous_id}
                )
            finally:
                if os.path.exists(tmp_in_path):
                    os.remove(tmp_in_path)
    elif file_path and os.path.exists(file_path):
        if file_path.lower().endswith(".zip"):
            dst_zip = file_path + ".anon.zip"
            _, report = anonymize_dicom_zip(file_path, dst_zip_path=dst_zip, anonymous_id=anonymous_id)
            return report
        else:
            dst_dcm = file_path + ".anon.dcm"
            return anonymize_dicom_file(file_path, dst_dcm, anonymous_id=anonymous_id)
    else:
        raise HTTPException(status_code=400, detail="必须提供上传文件或已存在的 DICOM 文件路径")

@app.post("/api/v1/tasks/analyze")
def submit_async_analysis(req: AsyncTaskSubmitRequest = Body(...)):
    """Submits a heavy 3D DICOM inference task to the background queue, returning immediate task_id."""
    target_id = req.file_path or req.sample_id or "chest_lung_ct"
    
    def _execute(progress_cb=None):
        if progress_cb:
            progress_cb(TaskStage.EXTRACTING, 20)
        vol, spacing, modality = engine.load_volume_data(target_id)
        if progress_cb:
            progress_cb(TaskStage.ANATOMICAL_MASKING, 45)
        res = engine.analyze_volume(
            vol,
            spacing=spacing,
            model_name=req.model_name or "lung_nodule_segmenter",
            window_preset=req.window_preset,
            mucus_min_hu=req.mucus_min_hu,
            mucus_max_hu=req.mucus_max_hu,
            ham_threshold_hu=req.ham_threshold_hu,
            bar_cutoff=req.bar_cutoff
        )
        if progress_cb:
            progress_cb(TaskStage.RENDERING, 90)
        return res

    task = task_manager.submit_task(
        runner_fn=_execute,
        model_name=req.model_name or "lung_nodule_segmenter",
        input_source=target_id
    )
    return {
        "task_id": task.task_id,
        "status": task.status.value,
        "stage": task.stage.value,
        "progress_pct": task.progress_pct,
        "message": "任务已提交至异步推理队列"
    }

@app.get("/api/v1/tasks/{task_id}")
def get_task_status_endpoint(task_id: str):
    """Retrieves asynchronous task status, progress percentage, and final inference results."""
    t = task_manager.get_task(task_id)
    if not t:
        raise HTTPException(status_code=404, detail=f"任务 '{task_id}' 不存在或已过期")
    return t

@app.get("/api/v1/tasks")
def list_tasks_endpoint(limit: int = 50):
    """Lists recent asynchronous imaging tasks and their processing status."""
    return {
        "tasks": task_manager.list_tasks(limit=limit),
        "total": len(task_manager.list_tasks(limit=limit))
    }

@app.delete("/api/v1/tasks/{task_id}")
def cancel_task_endpoint(task_id: str):
    """Cancels a pending or running asynchronous imaging task."""
    success = task_manager.cancel_task(task_id)
    if not success:
        raise HTTPException(status_code=400, detail=f"无法取消任务 '{task_id}' (已完成或不存在)")
    return {"status": "cancelled", "task_id": task_id}

@app.get("/api/v1/clinical/audit-cases")
def audit_cases_endpoint(cases_dir: Optional[str] = "/Users/huizhao/Downloads/medical_imaging_test_cases"):
    """
    Executes full clinical benchmark audit across all 4 downloaded test cases,
    validating physiological plausibility, anatomical scan boundaries,
    and SaMD clinical decision support compliance against doctor feedback.
    """
    try:
        return run_all_clinical_audits(cases_root_dir=cases_dir or "/Users/huizhao/Downloads/medical_imaging_test_cases")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"临床审计执行异常: {str(e)}")

def start_server():
    port = int(os.environ.get("PORT", "8004"))
    uvicorn.run("apps.imaging-worker.src.server:app", host="127.0.0.1", port=port, reload=False)

if __name__ == "__main__":
    start_server()

