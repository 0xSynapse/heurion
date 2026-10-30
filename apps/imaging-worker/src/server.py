import os
import re
import time
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
    from .engine import MONAIEngine, generate_synthetic_ct_volume, ModelUnavailableError
    from .recist import calculate_volume_doubling_time, calculate_subsolid_metrics, calculate_emphysema_metrics
    from .model_registry import list_registered_models, pull_model, verify_model, get_model_status
    from .dicom_io import anonymize_dicom_zip, anonymize_dicom_file
    from .task_queue import task_manager, TaskStage, batch_process_cohort
except (ImportError, ValueError):
    from device import get_device_info
    from engine import MONAIEngine, generate_synthetic_ct_volume, ModelUnavailableError
    from recist import calculate_volume_doubling_time, calculate_subsolid_metrics, calculate_emphysema_metrics
    from model_registry import list_registered_models, pull_model, verify_model, get_model_status
    from dicom_io import anonymize_dicom_zip, anonymize_dicom_file
    from task_queue import task_manager, TaskStage, batch_process_cohort

from fastapi import FastAPI, HTTPException, Body, UploadFile, File, Form
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
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


def raise_http(exc: Exception, prefix: str) -> None:
    """把引擎异常如实映射为 HTTP 状态：缺影像 404、参数/输入问题 400、模型不可用 501，其余 500。"""
    if isinstance(exc, HTTPException):
        raise exc
    if isinstance(exc, FileNotFoundError):
        raise HTTPException(status_code=404, detail=f"{prefix}: {exc}")
    if isinstance(exc, ValueError):
        raise HTTPException(status_code=400, detail=f"{prefix}: {exc}")
    if isinstance(exc, ModelUnavailableError):
        raise HTTPException(status_code=501, detail=f"{prefix}: {exc}")
    raise HTTPException(status_code=500, detail=f"{prefix}: {exc}")

class BenchmarkRequest(BaseModel):
    model_name: Optional[str] = "lung_nodule_segmenter"
    window_preset: Optional[str] = "lung"
    # 以下为合成体模尺寸，仅用于测速/联调
    z_slices: Optional[int] = 48
    y_dim: Optional[int] = 128
    x_dim: Optional[int] = 128
    mucus_min_hu: Optional[Union[float, str]] = 10.0
    mucus_max_hu: Optional[Union[float, str]] = 75.0
    ham_threshold_hu: Optional[Union[float, str]] = 70.0
    bar_cutoff: Optional[Union[float, str]] = 1.10

class SampleRequest(BaseModel):
    sample_id: Optional[str] = None
    volume_id: Optional[str] = None
    click_point: Optional[Dict[str, int]] = None
    model_name: Optional[str] = None
    channel_order: Optional[List[str]] = None
    window_preset: Optional[str] = None
    patient_context: Optional[Dict[str, Any]] = None
    mucus_min_hu: Optional[Union[float, str]] = 10.0
    mucus_max_hu: Optional[Union[float, str]] = 75.0
    ham_threshold_hu: Optional[Union[float, str]] = 70.0
    bar_cutoff: Optional[Union[float, str]] = 1.10

class FileAnalysisRequest(BaseModel):
    file_path: str
    model_name: Optional[str] = None
    channel_order: Optional[List[str]] = None
    modality: Optional[str] = None
    window_preset: Optional[str] = None
    click_point: Optional[Dict[str, int]] = None
    patient_context: Optional[Dict[str, Any]] = None
    mucus_min_hu: Optional[Union[float, str]] = 10.0
    mucus_max_hu: Optional[Union[float, str]] = 75.0
    ham_threshold_hu: Optional[Union[float, str]] = 70.0
    bar_cutoff: Optional[Union[float, str]] = 1.10

class MprInfoRequest(BaseModel):
    sample_id: Optional[str] = None
    volume_id: Optional[str] = None
    file_path: Optional[str] = None
    model_name: Optional[str] = None

class MprSliceRequest(BaseModel):
    sample_id: Optional[str] = None
    volume_id: Optional[str] = None
    file_path: Optional[str] = None
    plane: Optional[str] = "axial"  # axial, coronal, sagittal
    slice_index: Optional[int] = None
    window_preset: Optional[str] = None
    overlay_mask: Optional[bool] = True
    model_name: Optional[str] = None

class DiffSliceRequest(BaseModel):
    baseline_id: Optional[str] = None
    followup_id: Optional[str] = None
    baseline_volume_id: Optional[str] = None
    followup_volume_id: Optional[str] = None
    baseline_path: Optional[str] = None
    followup_path: Optional[str] = None
    plane: Optional[str] = "axial"
    slice_index: Optional[int] = None
    window_preset: Optional[str] = None
    threshold_hu: Optional[float] = 50.0

class RadiomicsRequest(BaseModel):
    sample_id: Optional[str] = None
    file_path: Optional[str] = None
    # ROI 掩膜来源：掩膜文件/样本，或已对该影像运行过的分割模型名（使用其缓存结果）
    mask_file_path: Optional[str] = None
    mask_sample_id: Optional[str] = None
    model_name: Optional[str] = None
    num_bins: Optional[int] = 16

class InteractivePromptPoint(BaseModel):
    z: int = 0
    y: int = 0
    x: int = 0
    is_positive: bool = True

class InteractiveSegmentRequest(BaseModel):
    sample_id: Optional[str] = None
    file_path: Optional[str] = None
    points: Optional[List[InteractivePromptPoint]] = None
    bbox: Optional[Dict[str, int]] = None
    window_preset: Optional[str] = "lung"
    plane: Optional[str] = "axial"
    slice_index: Optional[int] = None
    mode: Optional[str] = "hu_likelihood_gradient"

class WholeBodyAnalysisRequest(BaseModel):
    sample_id: Optional[str] = None
    file_path: Optional[str] = None
    patient_sex: Optional[str] = None
    patient_height_m: Optional[float] = None
    patient_weight_kg: Optional[float] = None
    l3_slice_index: Optional[int] = None
    z_slices: Optional[int] = 64
    y_dim: Optional[int] = 128
    x_dim: Optional[int] = 128

class DeformableRegistrationRequest(BaseModel):
    fixed_sample_id: Optional[str] = None
    moving_sample_id: Optional[str] = None
    fixed_file_path: Optional[str] = None
    moving_file_path: Optional[str] = None
    iterations: Optional[int] = 10
    smoothing_sigma: Optional[float] = 1.0

class PetCtFusionRequest(BaseModel):
    ct_sample_id: Optional[str] = None
    ct_file_path: Optional[str] = None
    pet_sample_id: Optional[str] = None
    pet_file_path: Optional[str] = None
    # PET 体素值必须已换算为 SUV（本接口不做 Bq/mL -> SUV 换算），调用方需显式确认
    pet_values_are_suv: Optional[bool] = False
    # 统计范围：ROI 掩膜（与 CT 同网格）或说明 PET 体积已如何排除生理性摄取，二者必须给一个
    roi_mask_file_path: Optional[str] = None
    roi_mask_sample_id: Optional[str] = None
    physiological_exclusion_note: Optional[str] = None
    tracer: Optional[str] = None
    suv_threshold: Optional[float] = 2.5
    key_slice_index: Optional[int] = None
    alpha: Optional[float] = 0.55

class RtStructRequest(BaseModel):
    sample_id: Optional[str] = None
    file_path: Optional[str] = None
    # 靶区掩膜（GTV）来源：与 CT 同网格的掩膜文件或样本
    gtv_mask_file_path: Optional[str] = None
    gtv_mask_sample_id: Optional[str] = None
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
    model_name: Optional[str] = None
    patient_sex: Optional[str] = None
    patient_height_m: Optional[float] = None
    patient_weight_kg: Optional[float] = None

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
    队列批量分析：逐例运行调用方指定的模型，汇总测量值为宽表（JSON + CSV）。
    缺影像、缺模型的病例标为 failed，不代入任何默认样本或人口学数据。
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
        raise_http(exc, "队列批量分析执行失败")


class EmphysemaRequest(BaseModel):
    sample_id: Optional[str] = None
    file_path: Optional[str] = None
    emphysema_hu_threshold: Optional[float] = -950.0


@app.post("/api/v1/recist/emphysema")
def compute_emphysema_endpoint(req: EmphysemaRequest = Body(...)):
    """肺内低衰减区定量（LAA%、Perc15）；不输出 GOLD 分级。"""
    target_id = req.file_path or req.sample_id
    if not target_id:
        raise HTTPException(status_code=400, detail="缺少影像：请提供 sample_id 或 file_path")
    try:
        vol, spacing, _ = engine.load_volume_data(target_id)
    except Exception as e:
        raise_http(e, "读取影像失败")
    return calculate_emphysema_metrics(
        volume=vol,
        spacing=spacing,
        emphysema_hu_threshold=req.emphysema_hu_threshold or -950.0
    )


@app.get("/health")
async def health_check():
    dev_info = get_device_info()
    return {
        "status": "healthy",
        "service": "heurion-monai-worker",
        "device": dev_info,
        "supported_modalities": ["CT", "MR", "PET", "NIfTI", "DICOM"],
    }

@app.get("/api/v1/models")
async def list_clinical_models(include_all: bool = False):
    """
    分析模型清单。is_ready 规则：
    - deep_learning：引擎确有该权重的加载与推理路径，且本地权重 SHA-256 校验通过（见 model_registry.get_model_status）；
    - rule_based / quantitative_ct：引擎内有真实实现的阈值/形态学/定量算法，名称中如实标明方法；
    - 没有实现的模型 is_ready=False，并给出原因。
    """
    reg = list_registered_models()
    reg_map = {m["name"]: m for m in reg}

    def dl(registry_name: str) -> Dict[str, Any]:
        st = reg_map.get(registry_name, {})
        return {
            "weights_registry_name": registry_name,
            "is_ready": bool(st.get("is_ready", False)),
            "unavailable_reason": st.get("unavailable_reason") if st else "未登记权重",
        }

    def off(reason: str) -> Dict[str, Any]:
        return {"is_ready": False, "unavailable_reason": reason}

    ready = {"is_ready": True, "unavailable_reason": None}

    raw_models = [
        # 1. 胸部
        {"id": "bronchiectasis_mucus_analyzer", "name": "支气管扩张与粘液栓定量（HU 阈值/形态学规则算法：支气管-动脉径比、粘液栓容积）",
         "category": "胸部与呼吸科", "engine_type": "rule_based", "body_part": "chest", "modality": "Chest HRCT",
         "target": "支气管-动脉径比 (BAR)、粘液栓容积", "recommended_window": "lung", **ready},
        {"id": "lung_nodule_segmenter", "name": "肺结节候选筛查与测量（HU 阈值 + 形态学规则算法，非深度学习）",
         "category": "胸部与呼吸科", "engine_type": "rule_based", "body_part": "chest", "modality": "Chest CT",
         "target": "肺实质内团块状候选的最大层面长径、体积与密度分型", "recommended_window": "lung", **ready},
        {"id": "lung_nodule_ct", "name": "肺结节三维目标检测（MONAI lung_nodule_ct_detection，3D RetinaNet）",
         "category": "胸部与呼吸科", "engine_type": "deep_learning", "body_part": "chest", "modality": "Chest CT",
         "target": "肺结节三维候选框检出、置信度评分与长径", "recommended_window": "lung", **dl("lung_nodule_ct")},
        {"id": "copd_emphysema_analyzer", "name": "肺气肿 CT 密度定量（阈值法肺分割 + LAA-950%、Perc15）",
         "category": "胸部与呼吸科", "engine_type": "quantitative_ct", "body_part": "chest", "modality": "Chest CT",
         "target": "双肺容积、≤-950 HU 低衰减区容积与占比（不做 GOLD 分级）", "recommended_window": "lung", **ready},
        {"id": "lung_airway_segmenter", "name": "气道树分割", "category": "胸部与呼吸科", "engine_type": "deep_learning",
         "body_part": "chest", "modality": "Chest CT", "target": "气道树", "recommended_window": "lung", **off("未实现")},
        {"id": "lung_lobe_segmenter", "name": "肺叶分割", "category": "胸部与呼吸科", "engine_type": "deep_learning",
         "body_part": "chest", "modality": "Chest CT", "target": "五个肺叶", "recommended_window": "lung", **off("未实现")},
        {"id": "covid19_lung_infection", "name": "病毒性肺炎病灶分割", "category": "胸部与呼吸科", "engine_type": "deep_learning",
         "body_part": "chest", "modality": "Chest CT", "target": "磨玻璃影/实变", "recommended_window": "lung", **off("未实现")},

        # 2. 腹盆部
        {"id": "spleen_segmenter", "name": "脾脏分割（MONAI spleen_ct_segmentation，3D UNet）",
         "category": "腹部、消化与泌尿", "engine_type": "deep_learning", "body_part": "abdomen", "modality": "Abdominal CT",
         "target": "脾脏体积与径线", "recommended_window": "abdomen", **dl("spleen_ct")},
        {"id": "multi_organ_ct", "name": "BTCV 腹部 13 类器官分割（MONAI SwinUNETR）",
         "category": "腹部、消化与泌尿", "engine_type": "deep_learning", "body_part": "abdomen", "modality": "Abdominal CT",
         "target": "肝、脾、双肾、胰腺、胆囊、胃、主动脉、下腔静脉等 13 类器官体积", "recommended_window": "abdomen", **dl("swinunetr_btcv")},
        {"id": "pancreas_tumor_segmenter", "name": "BTCV 器官分割：胰腺（MONAI SwinUNETR BTCV 第 11 类）",
         "category": "腹部、消化与泌尿", "engine_type": "deep_learning", "body_part": "abdomen", "modality": "Abdominal CT",
         "target": "胰腺器官体积（不识别病灶）", "recommended_window": "abdomen", **dl("swinunetr_btcv")},
        {"id": "pancreas_ct_dints", "name": "胰腺实质与胰腺占位分割（MONAI pancreas_ct_dints_segmentation，DiNTS 3D NAS）",
         "category": "腹部、消化与泌尿", "engine_type": "deep_learning", "body_part": "abdomen", "modality": "Abdominal CT",
         "target": "胰腺实质体积与胰腺占位/肿物体积", "recommended_window": "abdomen", **dl("pancreas_ct_dints")},
        {"id": "kidney_tumor_segmenter", "name": "BTCV 器官分割：双肾（MONAI SwinUNETR BTCV 第 2、3 类）",
         "category": "腹部、消化与泌尿", "engine_type": "deep_learning", "body_part": "abdomen", "modality": "Abdominal CT",
         "target": "双肾器官体积（不识别病灶）", "recommended_window": "abdomen", **dl("swinunetr_btcv")},
        {"id": "renal_structures_cect", "name": "肾脏精细结构与占位分割（MONAI renalStructures_CECT_segmentation，SegResNet）",
         "category": "腹部、消化与泌尿", "engine_type": "deep_learning", "body_part": "abdomen", "modality": "Abdominal CECT",
         "target": "肾实质、肾动静脉、肾盂输尿管及肾占位/囊肿体积", "recommended_window": "abdomen", **dl("renal_structures_cect")},
        {"id": "liver_lesion_segmenter", "name": "BTCV 器官分割：肝脏（MONAI SwinUNETR BTCV 第 6 类）",
         "category": "腹部、消化与泌尿", "engine_type": "deep_learning", "body_part": "abdomen", "modality": "Abdominal CT",
         "target": "肝脏器官体积（不识别病灶）", "recommended_window": "abdomen", **dl("swinunetr_btcv")},
        {"id": "prostate_mri_segmenter", "name": "前列腺分带分割（MONAI prostate_mri_anatomy，3D UNet：中央腺体/外周带）",
         "category": "腹部、消化与泌尿", "engine_type": "deep_learning", "body_part": "pelvis", "modality": "Pelvic MRI (T2W)",
         "target": "前列腺中央腺体与外周带体积", "recommended_window": "abdomen", **dl("prostate_mri")},

        # 3. 颅脑
        {"id": "brain_tumor_brats", "name": "BraTS 胶质瘤子区分割（MONAI SegResNet，需 4 通道 MRI 并声明通道顺序）",
         "category": "颅脑与神经系统", "engine_type": "deep_learning", "body_part": "brain", "modality": "Brain MRI (T1c, T1, T2, FLAIR)",
         "target": "肿瘤核心 (TC)、全肿瘤 (WT)、增强肿瘤 (ET) 体积", "recommended_window": "brain", **dl("brats_mri")},
        {"id": "brain_subcortical_segmenter", "name": "全脑 132 类结构分割（MONAI wholeBrainSeg_Large_UNEST，3D UNesT）", "category": "颅脑与神经系统",
         "engine_type": "deep_learning", "body_part": "brain", "modality": "Brain T1 MRI", "target": "全脑 132 类灰白质与皮层下核团体积",
         "recommended_window": "brain", **dl("wholebrainseg_large_unest")},
        {"id": "stroke_ischemic_lesion", "name": "脑梗死分割", "category": "颅脑与神经系统", "engine_type": "deep_learning",
         "body_part": "brain", "modality": "Brain MRI", "target": "梗死区", "recommended_window": "brain", **off("未实现")},
        {"id": "intracranial_hemorrhage_ct", "name": "颅内出血检测", "category": "颅脑与神经系统", "engine_type": "deep_learning",
         "body_part": "brain", "modality": "Head CT", "target": "颅内出血", "recommended_window": "brain", **off("未实现")},

        # 4. 心血管
        {"id": "cardiac_mri_segmentation", "name": "心室短轴 cine MRI 分割（MONAI ventricular_short_axis_3label：左室血池/心肌/右室血池）",
         "category": "心血管系统", "engine_type": "deep_learning", "body_part": "cardiac", "modality": "Cardiac MRI (短轴 cine SSFP)",
         "target": "单期相左室血池、心肌、右室血池体积（单期相不能计算射血分数）", "recommended_window": "mediastinum",
         **dl("ventricular_short_axis")},
        {"id": "valve_landmarks", "name": "心脏瓣膜解剖地标检测（MONAI valve_landmarks，2D PointRegressor）", "category": "心血管系统", "engine_type": "deep_learning",
         "body_part": "cardiac", "modality": "Cardiac CT/Echo", "target": "瓣膜 10 个关键解剖地标坐标", "recommended_window": "mediastinum",
         **dl("valve_landmarks")},
        {"id": "coronary_artery_calcification", "name": "冠状动脉钙化积分", "category": "心血管系统", "engine_type": "quantitative_ct",
         "body_part": "cardiac", "modality": "Cardiac CT", "target": "Agatston 积分", "recommended_window": "mediastinum",
         **off("已下线：缺少心脏/冠状动脉区域来源，无法按标准 Agatston 方法逐病灶计分")},

        # 5. 全身与骨
        {"id": "whole_body_ct_segmenter", "name": "L3 层体成分测量（HU 阈值法骨骼肌/内脏脂肪/皮下脂肪面积，非 TotalSegmentator 模型）",
         "category": "骨科与全身体素", "engine_type": "rule_based", "body_part": "whole_body", "modality": "Abdominal CT",
         "target": "启发式 L3 层骨骼肌面积、SMI（需身高）、脂肪面积", "recommended_window": "abdomen", **ready},
        {"id": "monai_wholebody_ct", "name": "全身 104 类结构分割（MONAI wholeBody_ct_segmentation，SegResNet 1.5 mm）",
         "category": "骨科与全身体素", "engine_type": "deep_learning", "body_part": "whole_body", "modality": "CT",
         "target": "器官、骨骼、血管、肌肉 104 类结构体积", "recommended_window": "bone", **dl("wholebody_ct")},
        {"id": "vertebra_segmenter", "name": "椎体松质骨 ROI 平均 CT 值（手动 ROI；骨 ≥220 HU 阈值示意）",
         "category": "骨科与全身体素", "engine_type": "rule_based", "body_part": "bone", "modality": "CT",
         "target": "松质骨 ROI 平均 HU（不换算骨密度、不估算 T 值）", "recommended_window": "bone", **ready},

        # 6. 其他模态
        {"id": "breast_density", "name": "乳腺致密度 BI-RADS 分类（MONAI breast_density_classification，InceptionV3）", "category": "乳腺钼靶与妇科", "engine_type": "deep_learning",
         "body_part": "breast", "modality": "Mammography", "target": "ACR BI-RADS A/B/C/D 四分类概率", "recommended_window": "abdomen", **dl("breast_density")},
        {"id": "pathology_tumor_detection", "name": "数字病理 WSI 肿瘤区域检出（MONAI pathology_tumor_detection，ResNet18-FCN）", "category": "病理与微观形态", "engine_type": "deep_learning",
         "body_part": "pathology", "modality": "WSI", "target": "肿瘤转移灶空间概率图与高概率区", "recommended_window": "abdomen", **dl("pathology_tumor_detection")},
        {"id": "pathology_nuclei", "name": "病理细胞核分割与表型分类（MONAI pathology_nuclei，HoVerNet）", "category": "病理与微观形态", "engine_type": "deep_learning",
         "body_part": "pathology", "modality": "WSI", "target": "细胞核分割与 5 类表型计数", "recommended_window": "abdomen", **dl("pathology_nuclei")},
        {"id": "endoscopic_tool", "name": "内镜手术器械分割（MONAI endoscopic_tool_segmentation，FlexibleUNet）", "category": "微创外科与内窥镜", "engine_type": "deep_learning",
         "body_part": "endoscopy", "modality": "Endoscopic Video", "target": "微创手术器械像素分割与视野占比", "recommended_window": "abdomen", **dl("endoscopic_tool")},

        # 7. 交互
        {"id": "vista3d", "name": "MONAI VISTA-3D 三维交互式与多类别分割基座模型（vista3d132）",
         "category": "交互式分割", "engine_type": "deep_learning", "body_part": "general", "modality": "CT / MRI",
         "target": "基于 3D 提示点或类别索引的三维分割", "recommended_window": "abdomen", **dl("vista3d")},
        {"id": "vista3d_interactive_segmenter", "name": "种子点 HU 区域生长（规则算法，非 VISTA-3D 模型）",
         "category": "交互式分割", "engine_type": "rule_based", "body_part": "general", "modality": "CT",
         "target": "与种子点连通、CT 值在 ±45 HU 内的区域", "recommended_window": "lung", **ready},
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
    """列出 data 目录中真实存在的公开数据集样本；缺失的样本不生成、不列出。"""
    catalog = [
        ("chest_lung_ct", "公开数据集胸部 CT（薄层）", "Chest CT", "bronchiectasis_mucus_analyzer", "lung", None),
        ("lidc_lung_nodule_ct", "LIDC-IDRI 胸部 CT（TCIA 病例 0001，含放射科医师结节标注）", "Chest CT", "lung_nodule_segmenter", "lung", None),
        ("copd_emphysema_ct", "公开数据集胸部 CT（用于肺气肿密度定量）", "Chest CT", "copd_emphysema_analyzer", "lung", None),
        ("liver_tumor_ct", "公开数据集肝脏 CT（LiTS / MSD Task03）", "Abdominal CT", "liver_lesion_segmenter", "abdomen", None),
        ("spleen_test", "公开数据集腹部增强 CT（96 层 512×512）", "Abdominal CT", "spleen_segmenter", "abdomen", None),
        ("cardiac_heart_mri", "MSD Task02 左心房 MRI（不是短轴 cine，与心室分割模型不匹配）", "Cardiac MRI", None, "mediastinum",
         "该样本不是短轴 cine SSFP，平台内没有与之匹配的模型"),
        ("brats_brain_mri", "公开数据集脑肿瘤多序列 MRI（BraTS，4 通道）", "Brain MRI", "brain_tumor_brats", "brain",
         "通道顺序未在文件中登记；调用 BraTS 模型时需通过 channel_order 声明"),
        ("hippocampus_brain_mri", "MSD Task04 海马区 MRI", "Brain MRI", "brain_subcortical_segmenter", "brain", None),
        ("prostate_mri", "公开数据集前列腺 MRI（单通道体积，19 层 384×384）", "Pelvic MRI", "prostate_mri_segmenter", "abdomen", None),
    ]
    samples = []
    for sid, name, modality, default_model, window, note in catalog:
        path = DATA_DIR / f"{sid}.nii.gz"
        if not path.exists():
            continue
        item = {
            "id": sid,
            "name": name,
            "modality": modality,
            "default_model": default_model,
            "default_window": window,
            "is_synthetic": False,
            "size_mb": round(path.stat().st_size / (1024 * 1024), 1),
        }
        if note:
            item["note"] = note
        samples.append(item)
    return {"samples": samples}
 
@app.get("/api/v1/samples/{sample_id}/file")
def get_sample_file(sample_id: str):
    """下载样本原始文件；样本不存在返回 404，不生成任何替代数据。"""
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
        vol, spacing, modality = await run_in_threadpool(load_volume, content, file.filename)
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


def _require_target(*candidates: Optional[str]) -> str:
    """取第一个给出的影像来源；都没有则 400。"""
    for c in candidates:
        if c:
            return c
    raise HTTPException(status_code=400, detail="缺少影像来源：请提供 file_path、volume_id 或 sample_id")


@app.post("/api/v1/mpr/info")
def get_mpr_volume_info(req: MprInfoRequest = Body(...)):
    """Returns 3D volume dimensions, spacing, slice counts and bounding box for a volume."""
    target = _require_target(req.file_path, req.volume_id, req.sample_id)
    try:
        return engine.get_mpr_info(target, model_name=req.model_name)
    except Exception as e:
        raise_http(e, "读取体积信息失败")

@app.get("/api/v1/mpr/info")
def get_mpr_volume_info_get(sample_id: Optional[str] = None, model_name: Optional[str] = None):
    """GET variant for retrieving volume MPR info by sample_id."""
    target = _require_target(sample_id)
    try:
        return engine.get_mpr_info(target, model_name=model_name)
    except Exception as e:
        raise_http(e, "读取体积信息失败")

@app.post("/api/v1/mpr/slice")
def get_mpr_slice(req: MprSliceRequest = Body(...)):
    """Extracts an arbitrary orthogonal 2D slice (Axial/Coronal/Sagittal) with windowing & overlay."""
    target = _require_target(req.file_path, req.volume_id, req.sample_id)
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
        raise_http(e, "提取 MPR 截面失败")

@app.post("/api/v1/mpr/diff-slice")
def get_diff_slice(req: DiffSliceRequest = Body(...)):
    """基线/随访逐体素 CT 值差图（未配准，仅供目视，不给趋势结论）。"""
    for p in (req.baseline_path, req.followup_path):
        if p and not os.path.exists(p):
            raise HTTPException(status_code=404, detail=f"影像文件不存在: {p}")
    base_target = _require_target(req.baseline_path, req.baseline_volume_id, req.baseline_id)
    follow_target = _require_target(req.followup_path, req.followup_volume_id, req.followup_id)
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
        raise_http(e, "生成差值截面失败")

@app.post("/api/v1/analyze/benchmark")
def run_benchmark_analysis(req: BenchmarkRequest = Body(...)):
    """在合成体模上运行指定算法，用于测速与联调；输出带 is_synthetic: true，不代表任何真实数据。"""
    model_name = req.model_name or "lung_nodule_segmenter"
    try:
        if model_name in ("bronchiectasis_mucus_analyzer", "bronchiectasis"):
            try:
                from .bronchiectasis import generate_synthetic_bronchiectasis_ct
            except (ImportError, ValueError):
                from bronchiectasis import generate_synthetic_bronchiectasis_ct
            vol, _, _ = generate_synthetic_bronchiectasis_ct(
                shape=(req.z_slices or 48, req.y_dim or 128, req.x_dim or 128),
                spacing=(1.5, 0.8, 0.8)
            )
            result = engine.analyze_volume(
                volume=vol,
                spacing=(1.5, 0.8, 0.8),
                model_name="bronchiectasis_mucus_analyzer",
                window_preset="lung",
                mucus_min_hu=req.mucus_min_hu,
                mucus_max_hu=req.mucus_max_hu,
                ham_threshold_hu=req.ham_threshold_hu,
                bar_cutoff=req.bar_cutoff
            )
        else:
            vol, _ = generate_synthetic_ct_volume(
                shape=(req.z_slices or 48, req.y_dim or 128, req.x_dim or 128),
                spacing=(1.5, 0.8, 0.8)
            )
            result = engine.analyze_volume(
                volume=vol,
                spacing=(1.5, 0.8, 0.8),
                model_name=model_name,
                window_preset=req.window_preset or "lung"
            )
    except Exception as e:
        raise_http(e, "合成体模测试失败")
    result["is_synthetic"] = True
    result["data_source"] = "synthetic_phantom"
    return result

@app.post("/api/v1/analyze/bronchiectasis")
def run_bronchiectasis_analysis(req: BenchmarkRequest = Body(...)):
    """支扩/粘液栓算法在合成体模上的联调接口；输出带 is_synthetic: true。真实影像请用 /analyze/sample 或 /analyze/file。"""
    try:
        from .bronchiectasis import generate_synthetic_bronchiectasis_ct
    except (ImportError, ValueError):
        from bronchiectasis import generate_synthetic_bronchiectasis_ct
    vol, _, _ = generate_synthetic_bronchiectasis_ct(
        shape=(req.z_slices or 48, req.y_dim or 128, req.x_dim or 128),
        spacing=(1.5, 0.8, 0.8)
    )
    result = engine.analyze_volume(
        volume=vol,
        spacing=(1.5, 0.8, 0.8),
        model_name="bronchiectasis_mucus_analyzer",
        window_preset="lung",
        mucus_min_hu=req.mucus_min_hu,
        mucus_max_hu=req.mucus_max_hu,
        ham_threshold_hu=req.ham_threshold_hu,
        bar_cutoff=req.bar_cutoff
    )
    result["is_synthetic"] = True
    result["data_source"] = "synthetic_phantom"
    return result


def _sample_file(sample_id: str) -> Optional[Path]:
    for ext in (".nii.gz", ".nii"):
        p = DATA_DIR / f"{sample_id}{ext}"
        if p.exists():
            return p
    return None


@app.post("/api/v1/analyze/sample")
def run_sample_analysis(req: SampleRequest = Body(...)):
    """在内存缓存的体积或 data 目录样本上运行指定模型；缺样本 404，缺模型 400。"""
    if not req.model_name:
        raise HTTPException(status_code=400, detail="缺少 model_name：请指定要运行的分析模型")
    vol_id = req.volume_id or req.sample_id
    if not vol_id:
        raise HTTPException(status_code=400, detail="缺少 sample_id 或 volume_id")
    common = dict(
        window_preset=req.window_preset,
        prompt_point=req.click_point,
        patient_context=req.patient_context,
        mucus_min_hu=req.mucus_min_hu,
        mucus_max_hu=req.mucus_max_hu,
        ham_threshold_hu=req.ham_threshold_hu,
        bar_cutoff=req.bar_cutoff,
        channel_order=req.channel_order,
    )
    try:
        if engine.has_volume(vol_id):
            vol, spacing, modality = engine.volume_cache[vol_id]
            sample_file = _sample_file(vol_id)
            with INFERENCE_SEMAPHORE:
                return engine.analyze_volume(
                    volume=vol,
                    spacing=spacing,
                    model_name=req.model_name,
                    modality=modality,
                    file_path=str(sample_file) if sample_file else None,
                    **common
                )

        sample_file = _sample_file(vol_id)
        if sample_file is None:
            raise HTTPException(status_code=404, detail=f"样本 '{vol_id}' 不存在")
        with INFERENCE_SEMAPHORE:
            return engine.analyze_file(file_path=str(sample_file), model_name=req.model_name, **common)
    except Exception as e:
        raise_http(e, "分析失败")

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
    """在本地文件上运行指定模型。"""
    safe_path = validate_safe_medical_path(req.file_path)
    if not safe_path:
        raise HTTPException(status_code=400, detail="file_path is required")
    if not req.model_name:
        raise HTTPException(status_code=400, detail="缺少 model_name：请指定要运行的分析模型")
    try:
        with INFERENCE_SEMAPHORE:
            return engine.analyze_file(
                file_path=safe_path,
                model_name=req.model_name,
                window_preset=req.window_preset,
                prompt_point=req.click_point,
                patient_context=req.patient_context,
                mucus_min_hu=req.mucus_min_hu,
                mucus_max_hu=req.mucus_max_hu,
                ham_threshold_hu=req.ham_threshold_hu,
                bar_cutoff=req.bar_cutoff,
                channel_order=req.channel_order,
                modality=req.modality,
            )
    except Exception as e:
        raise_http(e, "分析失败")

@app.post("/api/v1/analyze/radiomics")
def run_radiomics_analysis(req: RadiomicsRequest = Body(...)):
    """影像组学特征；ROI 掩膜必须由调用方提供（掩膜文件/样本，或已运行过的分割模型）。"""
    target = _require_target(req.file_path, req.sample_id)
    mask_src = req.mask_file_path or req.mask_sample_id
    if req.mask_file_path:
        validate_safe_medical_path(req.mask_file_path)
    try:
        with INFERENCE_SEMAPHORE:
            return engine.extract_radiomics(
                sample_id_or_path=target,
                model_name=req.model_name,
                num_bins=req.num_bins or 16,
                mask_id_or_path=mask_src,
            )
    except Exception as e:
        raise_http(e, "影像组学特征提取失败")

@app.post("/api/v1/analyze/interactive-segment")
def run_interactive_segmentation_endpoint(req: InteractiveSegmentRequest = Body(...)):
    """交互式种子点分割（HU 区域生长，非 VISTA-3D 模型）。"""
    target = _require_target(req.file_path, req.sample_id)
    points_dict = [p.model_dump() if hasattr(p, "model_dump") else p.dict() for p in (req.points or [])]
    try:
        return engine.run_interactive_segmentation(
            sample_id_or_path=target,
            points=points_dict,
            bbox=req.bbox,
            window_preset=req.window_preset,
            plane=req.plane or "axial",
            slice_index=req.slice_index,
            mode=req.mode or "hu_likelihood_gradient",
        )
    except Exception as e:
        raise_http(e, "交互分割失败")

@app.post("/api/v1/analyze/whole-body")
def run_whole_body_analysis_endpoint(req: WholeBodyAnalysisRequest = Body(...)):
    """L3 层 HU 阈值法体成分测量（非 TotalSegmentator 模型）。"""
    target = req.file_path or (str(DATA_DIR / f"{req.sample_id}.nii.gz") if req.sample_id else None)
    if target and os.path.exists(target):
        try:
            return engine.analyze_file(
                file_path=target,
                model_name="whole_body_ct_segmenter",
                patient_sex=req.patient_sex,
                patient_height_m=req.patient_height_m,
                patient_weight_kg=req.patient_weight_kg,
                l3_slice_index=req.l3_slice_index
            )
        except Exception as e:
            raise_http(e, "体成分分析失败")
    # 没有给出真实影像时不再用合成体数据冒充分析结果
    raise HTTPException(status_code=400, detail="缺少影像文件：请提供 file_path 或有效的 sample_id")


def _load_required(label: str, *candidates: Optional[str]):
    """读取必需的影像；未给出 400，找不到 404。"""
    target = next((c for c in candidates if c), None)
    if not target:
        raise HTTPException(status_code=400, detail=f"缺少{label}：请提供 sample_id 或 file_path")
    try:
        return engine.load_volume_data(target)
    except Exception as e:
        raise_http(e, f"读取{label}失败")


@app.post("/api/v1/registration/deformable")
def run_deformable_registration_endpoint(req: DeformableRegistrationRequest = Body(...)):
    """在请求给出的固定/浮动影像上做形变配准；两者须为同一体素网格（本接口不做重采样）。"""
    try:
        from .registration import run_3d_deformable_registration
    except (ImportError, ValueError):
        from registration import run_3d_deformable_registration

    fixed_vol, fixed_sp, _ = _load_required("固定图像", req.fixed_file_path, req.fixed_sample_id)
    moving_vol, moving_sp, _ = _load_required("浮动图像", req.moving_file_path, req.moving_sample_id)
    if fixed_vol.shape != moving_vol.shape or not np.allclose(fixed_sp, moving_sp, atol=1e-3):
        raise HTTPException(
            status_code=400,
            detail=f"固定图像 {fixed_vol.shape} 与浮动图像 {moving_vol.shape} 体素网格不一致；请先重采样到同一网格"
        )

    try:
        with INFERENCE_SEMAPHORE:
            res = run_3d_deformable_registration(
                fixed_vol=fixed_vol,
                moving_vol=moving_vol,
                spacing=tuple(fixed_sp),
                iterations=req.iterations or 10,
                smoothing_sigma=req.smoothing_sigma or 1.0
            )
    except Exception as e:
        raise_http(e, "配准失败")
    keys = (
        "status", "method", "method_zh", "iterations_completed", "elapsed_sec", "initial_ncc", "final_ncc",
        "ncc_improvement", "initial_mse", "final_mse", "mse_reduction_percent", "max_displacement_mm",
        "mean_displacement_mm", "key_slice_index", "registered_slice_png_base64", "registered_slice_png_size_bytes",
        "summary_markdown",
    )
    out = {k: res.get(k) for k in keys if k in res}
    out["fixed_source"] = req.fixed_file_path or req.fixed_sample_id
    out["moving_source"] = req.moving_file_path or req.moving_sample_id
    return out

@app.post("/api/v1/registration/pet-ct-fusion")
def run_pet_ct_fusion_endpoint(req: PetCtFusionRequest = Body(...)):
    """在请求给出的 CT 与 PET 上计算 SUV 指标与融合图；PET 须已换算为 SUV 且与 CT 同一网格。"""
    try:
        from .registration import compute_pet_metrics_and_fusion
    except (ImportError, ValueError):
        from registration import compute_pet_metrics_and_fusion

    ct_vol, ct_sp, _ = _load_required("CT 影像", req.ct_file_path, req.ct_sample_id)
    pet_vol, pet_sp, _ = _load_required("PET 影像", req.pet_file_path, req.pet_sample_id)
    if not req.pet_values_are_suv:
        raise HTTPException(status_code=400, detail="PET 体素值须已换算为 SUV；请确认后设置 pet_values_are_suv=true")
    if ct_vol.shape != pet_vol.shape or not np.allclose(ct_sp, pet_sp, atol=1e-3):
        raise HTTPException(status_code=400, detail=f"CT {ct_vol.shape} 与 PET {pet_vol.shape} 体素网格不一致；请先配准并重采样到同一网格")
    roi_mask = None
    if req.roi_mask_file_path or req.roi_mask_sample_id:
        roi_vol, _, _ = _load_required("ROI 掩膜", req.roi_mask_file_path, req.roi_mask_sample_id)
        if roi_vol.shape != ct_vol.shape:
            raise HTTPException(status_code=400, detail=f"ROI 掩膜 {roi_vol.shape} 与 CT {ct_vol.shape} 网格不一致")
        roi_mask = roi_vol > 0.5
    elif not req.physiological_exclusion_note:
        raise HTTPException(status_code=400, detail="需提供 ROI 掩膜，或说明 PET 体积已如何排除生理性摄取 (physiological_exclusion_note)")
    metadata: Dict[str, Any] = {"Units": "SUV"}
    if req.tracer:
        metadata["tracer"] = req.tracer
    try:
        return compute_pet_metrics_and_fusion(
            ct_volume=ct_vol,
            pet_volume=pet_vol,
            spacing=tuple(ct_sp),
            suv_threshold=req.suv_threshold or 2.5,
            key_slice_index=req.key_slice_index,
            alpha=req.alpha or 0.55,
            roi_mask=roi_mask,
            physiological_exclusion_note=req.physiological_exclusion_note,
            metadata=metadata,
        )
    except Exception as e:
        raise_http(e, "PET-CT 计算失败")

@app.post("/api/v1/rtstruct/delineate")
def run_rtstruct_delineation_endpoint(req: RtStructRequest = Body(...)):
    """以调用方给出的 GTV 掩膜为起点做 CTV/PTV 外扩；CT 与掩膜须为同一网格。"""
    try:
        from .registration import delineate_radiotherapy_targets
    except (ImportError, ValueError):
        from registration import delineate_radiotherapy_targets

    ct_vol, ct_sp, _ = _load_required("CT 影像", req.file_path, req.sample_id)
    mask_vol, _, _ = _load_required("GTV 掩膜", req.gtv_mask_file_path, req.gtv_mask_sample_id)
    if mask_vol.shape != ct_vol.shape:
        raise HTTPException(status_code=400, detail=f"GTV 掩膜 {mask_vol.shape} 与 CT {ct_vol.shape} 网格不一致")
    gtv = mask_vol > 0.5
    if not np.any(gtv):
        raise HTTPException(status_code=400, detail="GTV 掩膜为空")
    try:
        return delineate_radiotherapy_targets(
            ct_volume=ct_vol,
            metabolic_or_lesion_mask=gtv,
            spacing=tuple(ct_sp),
            ctv_margin_mm=req.ctv_margin_mm or 6.0,
            ptv_margin_mm=req.ptv_margin_mm or 4.0,
            key_slice_index=req.key_slice_index
        )
    except Exception as e:
        raise_http(e, "靶区外扩失败")

ACTIVE_UPLOAD_JOBS: Dict[str, Dict[str, Any]] = {}


def _update_upload_job(job_id: Optional[str], stage: str, percent: int, detail: str = "", status: str = "running"):
    if not job_id:
        return
    now = time.time()
    entry = ACTIVE_UPLOAD_JOBS.get(job_id) or {"job_id": job_id, "started_at": now}
    entry.update({
        "status": status,
        "stage": stage,
        "percent": int(percent),
        "detail": detail,
        "updated_at": now,
    })
    ACTIVE_UPLOAD_JOBS[job_id] = entry
    if len(ACTIVE_UPLOAD_JOBS) > 200:
        cutoff = now - 1800
        for k in [k for k, v in list(ACTIVE_UPLOAD_JOBS.items()) if v.get("updated_at", 0) < cutoff]:
            ACTIVE_UPLOAD_JOBS.pop(k, None)


@app.get("/api/v1/analyze/jobs/{job_id}")
async def get_upload_job_progress(job_id: str):
    """Non-blocking endpoint returning live stage/percent telemetry for an in-flight upload analysis job."""
    entry = ACTIVE_UPLOAD_JOBS.get(job_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Job not found")
    return entry


@app.post("/api/v1/analyze/upload")
async def run_upload_analysis(
    file: UploadFile = File(...),
    model_name: str = Form(...),
    window_preset: Optional[str] = Form(None),
    mucus_min_hu: Optional[str] = Form(None),
    mucus_max_hu: Optional[str] = Form(None),
    ham_threshold_hu: Optional[str] = Form(None),
    bar_cutoff: Optional[str] = Form(None),
    job_id: Optional[str] = Form(None),
):
    """上传 .nii/.nii.gz/.dcm/.zip/.tar.gz 影像并运行指定模型（model_name 必填）。"""
    try:
        return await _run_upload_analysis(
            file, model_name, window_preset, mucus_min_hu, mucus_max_hu, ham_threshold_hu, bar_cutoff, job_id=job_id
        )
    except Exception as e:
        if job_id:
            _update_upload_job(job_id, "推理异常中断", 100, str(e), status="failed")
        raise_http(e, "分析失败")


async def _run_upload_analysis(
    file, model_name, window_preset, mucus_min_hu, mucus_max_hu, ham_threshold_hu, bar_cutoff, job_id: Optional[str] = None
):
    filename = file.filename or ""
    _update_upload_job(job_id, "接收并校验上传影像字节流", 10, f"正在读取 {filename} ...")
    content = await file.read()
    return await run_in_threadpool(
        _run_upload_analysis_sync,
        content,
        filename,
        model_name,
        window_preset,
        mucus_min_hu,
        mucus_max_hu,
        ham_threshold_hu,
        bar_cutoff,
        job_id,
    )


def _run_upload_analysis_sync(
    content: bytes,
    filename: str,
    model_name,
    window_preset,
    mucus_min_hu,
    mucus_max_hu,
    ham_threshold_hu,
    bar_cutoff,
    job_id: Optional[str] = None,
):
    fn_lower = filename.lower() if filename else ""

    f_mucus_min = parse_flexible_float(mucus_min_hu)
    f_mucus_max = parse_flexible_float(mucus_max_hu)
    f_ham_thresh = parse_flexible_float(ham_threshold_hu)
    f_bar_cutoff = parse_flexible_float(bar_cutoff)

    def _progress_cb(stage: str, pct: int, detail: str = ""):
        _update_upload_job(job_id, stage, pct, detail, status="running")

    is_zip = fn_lower.endswith(".zip") or (len(content) >= 4 and content[:4] == b"PK\x03\x04")
    is_dicom_magic = len(content) >= 132 and content[128:132] == b"DICM"

    if is_zip:
        _progress_cb("解包 DICOM ZIP 序列归档", 14, f"正在校验并解压 {filename} ...")
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
                res = engine.analyze_file(
                    file_path=tmp_dir,
                    model_name=model_name,
                    window_preset=window_preset,
                    mucus_min_hu=f_mucus_min,
                    mucus_max_hu=f_mucus_max,
                    ham_threshold_hu=f_ham_thresh,
                    bar_cutoff=f_bar_cutoff,
                    progress_cb=_progress_cb,
                )
                _update_upload_job(job_id, "分析完成", 100, "已完成三维量化分析与关键截面生成", status="completed")
                return res
    elif fn_lower.endswith((".tar.gz", ".tgz", ".tar")):
        import tarfile
        _progress_cb("解包 TAR 序列归档", 14, f"正在校验并解压 {filename} ...")
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
                res = engine.analyze_file(
                    file_path=tmp_dir,
                    model_name=model_name,
                    window_preset=window_preset,
                    mucus_min_hu=f_mucus_min,
                    mucus_max_hu=f_mucus_max,
                    ham_threshold_hu=f_ham_thresh,
                    bar_cutoff=f_bar_cutoff,
                    progress_cb=_progress_cb,
                )
                _update_upload_job(job_id, "分析完成", 100, "已完成三维量化分析与关键截面生成", status="completed")
                return res
    elif fn_lower.endswith((".dcm", ".dicom", ".ima")) or is_dicom_magic:
        with tempfile.TemporaryDirectory() as tmp_dir:
            safe_filename = os.path.basename(filename or "slice.dcm") or "slice.dcm"
            if not safe_filename.lower().endswith((".dcm", ".dicom", ".ima")):
                safe_filename = f"{safe_filename}.dcm"
            dcm_path = os.path.realpath(os.path.join(tmp_dir, safe_filename))
            if not dcm_path.startswith(os.path.realpath(tmp_dir)):
                raise HTTPException(status_code=400, detail="非法文件名路径 (Path traversal detected)")
            with open(dcm_path, "wb") as f_out:
                f_out.write(content)
            with INFERENCE_SEMAPHORE:
                res = engine.analyze_file(
                    file_path=tmp_dir,
                    model_name=model_name,
                    window_preset=window_preset,
                    mucus_min_hu=f_mucus_min,
                    mucus_max_hu=f_mucus_max,
                    ham_threshold_hu=f_ham_thresh,
                    bar_cutoff=f_bar_cutoff,
                    progress_cb=_progress_cb,
                )
                _update_upload_job(job_id, "分析完成", 100, "已完成三维量化分析与关键截面生成", status="completed")
                return res
    else:
        is_gz = fn_lower.endswith((".nii.gz", ".gz")) or (len(content) >= 2 and content[:2] == b"\x1f\x8b")
        suffix = ".nii.gz" if is_gz else ".nii"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(content)
            tmp_path = tmp.name
        try:
            with INFERENCE_SEMAPHORE:
                res = engine.analyze_file(
                    file_path=tmp_path,
                    model_name=model_name,
                    window_preset=window_preset,
                    mucus_min_hu=f_mucus_min,
                    mucus_max_hu=f_mucus_max,
                    ham_threshold_hu=f_ham_thresh,
                    bar_cutoff=f_bar_cutoff,
                    progress_cb=_progress_cb,
                )
                _update_upload_job(job_id, "分析完成", 100, "已完成三维量化分析与关键截面生成", status="completed")
                return res
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
    sample_id: Optional[str] = None
    file_path: Optional[str] = None
    model_name: Optional[str] = None
    window_preset: Optional[str] = None
    mucus_min_hu: Optional[float] = 10.0
    mucus_max_hu: Optional[float] = 75.0
    ham_threshold_hu: Optional[float] = 70.0
    bar_cutoff: Optional[float] = 1.10

@app.get("/api/v1/models/registry")
async def get_registered_models_endpoint():
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
            out_bytes, report = await run_in_threadpool(anonymize_dicom_zip, content, None, anonymous_id)
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
                res = await run_in_threadpool(anonymize_dicom_file, tmp_in_path, tmp_out_path, anonymous_id)
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
            _, report = await run_in_threadpool(anonymize_dicom_zip, file_path, dst_zip, anonymous_id)
            return report
        else:
            dst_dcm = file_path + ".anon.dcm"
            return await run_in_threadpool(anonymize_dicom_file, file_path, dst_dcm, anonymous_id)
    else:
        raise HTTPException(status_code=400, detail="必须提供上传文件或已存在的 DICOM 文件路径")

@app.post("/api/v1/tasks/analyze")
def submit_async_analysis(req: AsyncTaskSubmitRequest = Body(...)):
    """提交后台分析任务；影像来源与模型均须由调用方给出。"""
    target_id = req.file_path or req.sample_id
    if not target_id:
        raise HTTPException(status_code=400, detail="缺少影像来源：请提供 file_path 或 sample_id")
    if not req.model_name:
        raise HTTPException(status_code=400, detail="缺少 model_name：请指定要运行的分析模型")

    def _execute(progress_cb=None):
        if progress_cb:
            progress_cb(TaskStage.EXTRACTING, 20)
        vol, spacing, modality = engine.load_volume_data(target_id)
        if progress_cb:
            progress_cb(TaskStage.ANATOMICAL_MASKING, 45)
        res = engine.analyze_volume(
            vol,
            spacing=spacing,
            model_name=req.model_name,
            modality=modality,
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
        model_name=req.model_name,
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

def start_server():
    port = int(os.environ.get("PORT", "8004"))
    uvicorn.run("apps.imaging-worker.src.server:app", host="127.0.0.1", port=port, reload=False)

if __name__ == "__main__":
    start_server()

