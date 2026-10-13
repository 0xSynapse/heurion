import os
import io
import base64
import time
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import torch
from typing import Dict, Any, Tuple, Optional, List
try:
    from .device import get_optimal_device, get_device_info
    from .dicom_io import apply_ct_window, CT_WINDOWS
    from .recist import calculate_recist_metrics, calculate_subsolid_metrics, calculate_volume_doubling_time
    from .renderer import render_key_slice_png, png_to_base64
    from .radiomics import extract_radiomics_features
    from .interactive import interactive_segment_3d
    from .font_utils import get_cjk_font, get_sans_font, sanitize_text
    from .clinical_bridge import extract_clinical_features
    from .clinical_ai_agent import generate_clinical_ai_report
    from .spatial_canonicalizer import to_canonical_lps
except (ImportError, ValueError):
    from device import get_optimal_device, get_device_info
    from dicom_io import apply_ct_window, CT_WINDOWS
    from recist import calculate_recist_metrics, calculate_subsolid_metrics, calculate_volume_doubling_time
    from renderer import render_key_slice_png, png_to_base64
    from radiomics import extract_radiomics_features
    from interactive import interactive_segment_3d
    from font_utils import get_cjk_font, get_sans_font, sanitize_text
    from clinical_bridge import extract_clinical_features
    from clinical_ai_agent import generate_clinical_ai_report
    from spatial_canonicalizer import to_canonical_lps


class ModelUnavailableError(RuntimeError):
    """模型未实现、或权重未安装/未通过校验时抛出；不做任何替代或降级。"""


def generate_synthetic_ct_volume(
    shape: Tuple[int, int, int] = (48, 128, 128),
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8)
) -> Tuple[np.ndarray, np.ndarray]:
    """
    合成体模（仅供单元测试与 benchmark 测速，不是任何真实患者数据）：
    - 背景空气 -1000 HU，体壁软组织 +40 HU，肺 -650 HU，脊柱 +450 HU，一个 +55 HU 的椭球靶区。
    调用方对外输出时必须带 is_synthetic: true。
    """
    z_dim, y_dim, x_dim = shape
    volume = np.full(shape, -1000.0, dtype=np.float32)
    mask = np.zeros(shape, dtype=np.uint8)

    z_coords, y_coords, x_coords = np.meshgrid(
        np.arange(z_dim), np.arange(y_dim), np.arange(x_dim), indexing="ij"
    )
    cy, cx = y_dim // 2, x_dim // 2

    body_mask = ((y_coords - cy) / (y_dim * 0.42))**2 + ((x_coords - cx) / (x_dim * 0.42))**2 <= 1.0
    volume[body_mask] = 40.0

    left_lung = ((y_coords - cy) / (y_dim * 0.28))**2 + ((x_coords - (cx - x_dim * 0.2)) / (x_dim * 0.16))**2 <= 1.0
    right_lung = ((y_coords - cy) / (y_dim * 0.28))**2 + ((x_coords - (cx + x_dim * 0.2)) / (x_dim * 0.16))**2 <= 1.0
    volume[left_lung] = -650.0
    volume[right_lung] = -650.0

    spine = ((y_coords - (cy + y_dim * 0.3)) / (y_dim * 0.08))**2 + ((x_coords - cx) / (x_dim * 0.08))**2 <= 1.0
    volume[spine] = 450.0

    lz = z_dim // 2
    ly = cy + 4
    lx = cx + int(x_dim * 0.2)
    lesion = (
        ((z_coords - lz) / 6.0)**2 +
        ((y_coords - ly) / 9.0)**2 +
        ((x_coords - lx) / 12.0)**2
    ) <= 1.0

    noise = np.random.normal(0, 12, shape).astype(np.float32)
    volume += noise

    volume[lesion] = 55.0 + np.random.normal(0, 8, int(np.sum(lesion)))
    mask[lesion] = 1

    return volume, mask

import scipy.ndimage as ndi
from scipy.ndimage import label


# ---------------------------------------------------------------------------
# 空间几何：规范 LPS+ (Z, Y, X) 体积与 NIfTI 之间的统一换算
# ---------------------------------------------------------------------------

def canonical_lps_affine(spacing: Tuple[float, float, float]) -> np.ndarray:
    """
    规范体积 vol_zyx（z: 下→上，y: 前→后，x: 右→左）转置成 (X, Y, Z) 写入 NIfTI 时使用的仿射。
    NIfTI 世界坐标是 RAS（+x 指向患者右、+y 指向前），数组 X 轴朝患者左、Y 轴朝后，
    因此 X、Y 两列取负号；方向码为 ('L', 'P', 'S')，与 spatial_canonicalizer.to_canonical_lps 的目标一致。
    """
    dz, dy, dx = [float(s) for s in spacing]
    return np.diag([-dx, -dy, dz, 1.0])


def write_canonical_nifti(vol_zyx: np.ndarray, spacing: Tuple[float, float, float]) -> str:
    """把规范 LPS+ 体积写成临时 NIfTI（带正确方向的仿射），返回路径；调用方负责删除。"""
    import nibabel as nib
    vol_xyz = np.transpose(np.asarray(vol_zyx, dtype=np.float32), (2, 1, 0))
    tmp = tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False)
    tmp.close()
    nib.save(nib.Nifti1Image(vol_xyz, canonical_lps_affine(spacing)), tmp.name)
    return tmp.name


def nifti_array_to_canonical(arr_xyz: np.ndarray, affine: np.ndarray) -> np.ndarray:
    """模型在文件原生网格上的输出（X, Y, Z）按文件仿射转回规范 LPS+ (Z, Y, X)。"""
    vol_zyx, _, _ = to_canonical_lps(np.asarray(arr_xyz), affine)
    return vol_zyx


def display_plane_slice(vol_zyx: np.ndarray, plane: str, index: int) -> np.ndarray:
    """
    从规范 LPS+ 体积取出一个可直接显示的 2D 截面（放射学约定，全工程统一使用本函数）：
    - 轴位：上 A、下 P、左 R、右 L —— 规范体积行 = y(前→后)、列 = x(右→左)，原样输出；
    - 冠状位：上 S、下 I、左 R、右 L —— 行为 z(下→上)，需上下翻转使 S 在上；
    - 矢状位：上 S、下 I、左 A、右 P —— 行为 z(下→上) 需上下翻转，列为 y(前→后)。
    与 spatial_canonicalizer.get_radiological_orientation_labels 的方位标注一致。
    """
    plane = (plane or "axial").lower()
    if plane == "axial":
        return vol_zyx[index, :, :]
    if plane == "coronal":
        return vol_zyx[::-1, index, :]
    if plane == "sagittal":
        return vol_zyx[::-1, :, index]
    raise ValueError(f"未知截面方向: {plane}")


def _plane_geometry(shape: Tuple[int, int, int], spacing: Tuple[float, float, float], plane: str) -> Tuple[int, float, float, str]:
    """返回 (该方向总层数, 显示图竖直像素间距, 水平像素间距, 中文标签)。"""
    z_dim, y_dim, x_dim = shape
    dz, dy, dx = spacing
    if plane == "axial":
        return z_dim, dy, dx, "轴位 (Axial)"
    if plane == "coronal":
        return y_dim, dz, dx, "冠状位 (Coronal)"
    return x_dim, dz, dy, "矢状位 (Sagittal)"


def extract_largest_component(binary_mask: np.ndarray) -> np.ndarray:
    """Extracts the largest 3D connected component, removing scattered noise."""
    labeled, num_features = label(binary_mask)
    if num_features == 0:
        return binary_mask
    counts = np.bincount(labeled.flat)
    counts[0] = 0
    if len(counts) <= 1 or np.max(counts) == 0:
        return binary_mask
    largest_label = int(np.argmax(counts))
    return (labeled == largest_label).astype(np.uint8)


def segment_pulmonary_nodules(
    volume: np.ndarray,
    spacing: Tuple[float, float, float],
    prompt_point: Optional[Dict[str, int]] = None
) -> Tuple[np.ndarray, Dict[str, Any], str]:
    """
    肺结节候选的 HU 阈值 + 形态学筛查（规则算法，非深度学习模型）：
    1. 由解剖分区阈值法得到肺实质包络（排除胸壁、骨与纵隔）；
    2. 给定种子点时，在种子点附近有限范围内做 HU 区域生长（interactive.interactive_segment_3d）；
    3. 否则在肺实质内取 -150 ~ +120 HU 的候选连通域，按等效直径、致密度、长宽比过滤管状血管；
    4. 返回 (二值掩膜, 测量值, 标签文字)。测量值只含径线/体积/密度分型，不含分级与处置建议。
    """
    dz, dy, dx = [float(s) for s in spacing]
    voxel_vol_mm3 = dz * dy * dx
    z_dim, y_dim, x_dim = volume.shape

    # 模式 A：种子点交互测量
    if prompt_point and "z" in prompt_point and "y" in prompt_point and "x" in prompt_point:
        pz = int(prompt_point["z"])
        py = int(prompt_point["y"])
        px = int(prompt_point["x"])

        # 以种子点为中心限定生长范围（XY 半径 18mm、Z 半径 12mm），防止沿血管树无界扩散
        rz = max(3, int(np.ceil(12.0 / dz)))
        ry = max(8, int(np.ceil(18.0 / dy)))
        rx = max(8, int(np.ceil(18.0 / dx)))
        focal_bbox = {
            "z_min": max(0, pz - rz), "z_max": min(z_dim - 1, pz + rz),
            "y_min": max(0, py - ry), "y_max": min(y_dim - 1, py + ry),
            "x_min": max(0, px - rx), "x_max": min(x_dim - 1, px + rx),
        }

        res = interactive_segment_3d(
            volume=volume,
            spacing=spacing,
            points=[{"z": pz, "y": py, "x": px, "is_positive": True}],
            bbox=focal_bbox
        )
        mask = res["mask"]
        recist = calculate_subsolid_metrics(volume, mask, spacing=spacing, key_slice_idx=pz)
        ld = recist.get("longest_diameter_mm")
        nodule_type_zh = recist.get("nodule_type_zh", "种子点区域")
        if recist.get("is_vessel"):
            return mask, recist, f"种子点区域（{nodule_type_zh}）"
        return mask, recist, f"种子点区域生长测量（{nodule_type_zh}，最大层面长径 {ld} mm）"

    # 模式 B：肺实质包络内自动筛查
    try:
        from .totalsegmentator import extract_anatomical_compartments_3d
    except (ImportError, ValueError):
        from totalsegmentator import extract_anatomical_compartments_3d

    compartments = extract_anatomical_compartments_3d(volume, spacing=spacing)
    lung_mask = compartments["lung_parenchyma"]
    bone_mask = compartments["bone_skeleton"]
    mediastinum_mask = compartments["mediastinum_central"]

    empty_recist = {
        "total_volume_cm3": 0.0,
        "key_slice_index": z_dim // 2,
        "key_slice_basis": "无候选，取层面中点仅用于显示",
        "longest_diameter_mm": None,
        "short_axis_mm": None,
        "caliper_longest": None,
        "caliper_short": None,
        "has_lesion": False,
    }
    no_candidate_label = "阈值法未检出符合形态条件的候选结节"

    if not np.any(lung_mask):
        empty_recist["key_slice_basis"] = "未分割出肺实质，取层面中点仅用于显示"
        return np.zeros_like(volume, dtype=np.uint8), empty_recist, "未分割出肺实质，未做结节筛查"

    intraparenchymal_zone = lung_mask & (~bone_mask) & (~mediastinum_mask)
    lung_cands_3d = (volume >= -150.0) & (volume <= 120.0) & intraparenchymal_zone

    lbl, n_feats = ndi.label(lung_cands_3d)
    if n_feats == 0:
        return np.zeros_like(volume, dtype=np.uint8), empty_recist, no_candidate_label

    counts = np.bincount(lbl.flat)
    counts[0] = 0

    vols_mm3 = counts[1:] * voxel_vol_mm3
    d_equivs_mm = 2.0 * ((3.0 * vols_mm3) / (4.0 * np.pi)) ** (1.0 / 3.0)

    # 候选等效直径范围 4~30 mm
    valid_indices = np.where((d_equivs_mm >= 4.0) & (d_equivs_mm <= 30.0))[0] + 1
    if len(valid_indices) == 0:
        return np.zeros_like(volume, dtype=np.uint8), empty_recist, no_candidate_label

    # 区分团块状候选与分支管状血管：外接盒最大边 <= 32mm、致密度 >= 0.20、长宽比 <= 2.5
    all_boxes = ndi.find_objects(lbl, max_label=n_feats)
    candidates = []
    for idx in valid_indices:
        sl_box = all_boxes[idx - 1]
        if sl_box is None:
            continue
        sz = (sl_box[0].stop - sl_box[0].start) * dz
        sy = (sl_box[1].stop - sl_box[1].start) * dy
        sx = (sl_box[2].stop - sl_box[2].start) * dx
        dims = [sz, sy, sx]
        max_dim = max(dims)
        min_dim = min(dims)
        aspect_ratio = max_dim / (min_dim + 1e-4)
        vol_i = counts[idx] * voxel_vol_mm3
        vol_box = sz * sy * sx
        solidity = vol_i / (vol_box + 1e-4)
        d_i = d_equivs_mm[idx - 1]

        if max_dim <= 32.0 and solidity >= 0.20 and aspect_ratio <= 2.5:
            cand_mask_i = (lbl == idx)
            cand_voxels = counts[idx]
            if cand_voxels > 0 and np.any(bone_mask):
                if np.sum(cand_mask_i & bone_mask) / cand_voxels > 0.15:
                    continue
            if cand_voxels > 0 and np.any(mediastinum_mask):
                if np.sum(cand_mask_i & mediastinum_mask) / cand_voxels > 0.25:
                    continue

            score = vol_i * solidity / (aspect_ratio ** 1.2)
            candidates.append((idx, score, d_i, vol_i, aspect_ratio, solidity))

    if not candidates:
        return np.zeros_like(volume, dtype=np.uint8), empty_recist, no_candidate_label

    candidates.sort(key=lambda x: x[1], reverse=True)
    best_idx = candidates[0][0]
    best_mask = (lbl == best_idx).astype(np.uint8)

    recist = calculate_subsolid_metrics(volume, best_mask, spacing=spacing)
    ld = recist.get("longest_diameter_mm")
    nodule_type_zh = recist.get("nodule_type_zh", "候选结节")
    lesion_label = f"阈值法候选结节（{nodule_type_zh}，最大层面长径 {ld} mm）"

    return best_mask, recist, lesion_label


# MONAI wholeBody_ct_segmentation bundle 的 105 个输出通道定义（取自 bundle metadata.json，0 为背景）
WHOLEBODY_CT_LABELS: Tuple[str, ...] = (
    'background', 'spleen', 'kidney_right', 'kidney_left', 'gallbladder', 'liver', 'stomach', 'aorta',
    'inferior_vena_cava', 'portal_vein_and_splenic_vein', 'pancreas', 'adrenal_gland_right', 'adrenal_gland_left',
    'lung_upper_lobe_left', 'lung_lower_lobe_left', 'lung_upper_lobe_right', 'lung_middle_lobe_right',
    'lung_lower_lobe_right', 'vertebrae_L5', 'vertebrae_L4', 'vertebrae_L3', 'vertebrae_L2', 'vertebrae_L1',
    'vertebrae_T12', 'vertebrae_T11', 'vertebrae_T10', 'vertebrae_T9', 'vertebrae_T8', 'vertebrae_T7',
    'vertebrae_T6', 'vertebrae_T5', 'vertebrae_T4', 'vertebrae_T3', 'vertebrae_T2', 'vertebrae_T1',
    'vertebrae_C7', 'vertebrae_C6', 'vertebrae_C5', 'vertebrae_C4', 'vertebrae_C3', 'vertebrae_C2',
    'vertebrae_C1', 'esophagus', 'trachea', 'heart_myocardium', 'heart_atrium_left', 'heart_ventricle_left',
    'heart_atrium_right', 'heart_ventricle_right', 'pulmonary_artery', 'brain', 'iliac_artery_left',
    'iliac_artery_right', 'iliac_vena_left', 'iliac_vena_right', 'small_bowel', 'duodenum', 'colon',
    'rib_left_1', 'rib_left_2', 'rib_left_3', 'rib_left_4', 'rib_left_5', 'rib_left_6', 'rib_left_7',
    'rib_left_8', 'rib_left_9', 'rib_left_10', 'rib_left_11', 'rib_left_12', 'rib_right_1', 'rib_right_2',
    'rib_right_3', 'rib_right_4', 'rib_right_5', 'rib_right_6', 'rib_right_7', 'rib_right_8', 'rib_right_9',
    'rib_right_10', 'rib_right_11', 'rib_right_12', 'humerus_left', 'humerus_right', 'scapula_left',
    'scapula_right', 'clavicula_left', 'clavicula_right', 'femur_left', 'femur_right', 'hip_left', 'hip_right',
    'sacrum', 'face', 'gluteus_maximus_left', 'gluteus_maximus_right', 'gluteus_medius_left',
    'gluteus_medius_right', 'gluteus_minimus_left', 'gluteus_minimus_right', 'autochthon_left',
    'autochthon_right', 'iliopsoas_left', 'iliopsoas_right', 'urinary_bladder',
)

# BTCV 13 类器官标签（swin_unetr_btcv_segmentation bundle）
BTCV_ORGAN_LABELS: Dict[int, str] = {
    1: "脾脏 (Spleen)", 2: "右肾 (Right Kidney)", 3: "左肾 (Left Kidney)",
    4: "胆囊 (Gallbladder)", 5: "食管 (Esophagus)", 6: "肝脏 (Liver)",
    7: "胃 (Stomach)", 8: "主动脉 (Aorta)", 9: "下腔静脉 (IVC)",
    10: "门静脉与脾静脉 (Portal & Splenic Vein)", 11: "胰腺 (Pancreas)",
    12: "右肾上腺 (Right Adrenal)", 13: "左肾上腺 (Left Adrenal)"
}

# BraTS bundle 要求的输入通道顺序（brats_mri_segmentation metadata.json channel_def）
BRATS_CHANNEL_ORDER: Tuple[str, ...] = ("T1c", "T1", "T2", "FLAIR")


class MonaiNeuralInferencePipeline:
    """
    MONAI bundle 权重推理。每个模型按对应 bundle 的 inference 配置做预处理与推理；
    权重未安装或 SHA-256 校验未通过时直接报错，不做任何替代或降级。
    输入一律是规范 LPS+ (Z, Y, X) 体积，以带正确方向仿射的 NIfTI 交给 MONAI，输出经 Invertd 回到同一网格。
    """

    # 引擎内确有加载与推理路径的登记模型 -> 加载函数名（与 model_registry 的 engine_implemented 必须一致）
    NEURAL_LOADERS: Dict[str, str] = {
        "spleen_ct": "get_spleen_model",
        "swinunetr_btcv": "get_btcv_model",
        "prostate_mri": "get_prostate_model",
        "brats_mri": "get_brats_model",
        "ventricular_short_axis": "get_cardiac_model",
        "wholebody_ct": "get_wholebody_model",
    }

    def __init__(self, device: torch.device):
        self.device = device
        self.models: Dict[str, Any] = {}

    # ---- 权重 ----
    def _verified_weights(self, registry_name: str) -> Tuple[Path, Dict[str, Any]]:
        try:
            from .model_registry import get_model_status
        except (ImportError, ValueError):
            from model_registry import get_model_status
        status = get_model_status(registry_name)
        if not status.get("is_ready"):
            raise ModelUnavailableError(
                f"模型权重 '{registry_name}' 不可用：{status.get('unavailable_reason') or '未登记'}。"
                "请先通过模型管理拉取并校验官方权重。"
            )
        return Path(status["local_path"]), status

    def _base_meta(self, registry_name: str, architecture: str, t0: float) -> Dict[str, Any]:
        _, status = self._verified_weights(registry_name)
        return {
            "real_neural_inference": True,
            "neural_architecture": architecture,
            "weights_registry_name": registry_name,
            "weights_version": status.get("version"),
            "weights_sha256": status.get("actual_sha256"),
            "weights_source": "MONAI Model Zoo bundle",
            "inference_duration_sec": round(time.time() - t0, 3),
            "accelerator": str(self.device),
        }

    def _load_state_dict_model(self, key: str, registry_name: str, build) -> torch.nn.Module:
        if key in self.models:
            return self.models[key]
        weights_path, _ = self._verified_weights(registry_name)
        model = build().to(self.device)
        sd = torch.load(str(weights_path), map_location=self.device, weights_only=False)
        model.load_state_dict(sd)
        model.eval()
        self.models[key] = model
        return model

    def get_spleen_model(self) -> torch.nn.Module:
        from monai.networks.nets import UNet
        return self._load_state_dict_model("spleen", "spleen_ct", lambda: UNet(
            spatial_dims=3, in_channels=1, out_channels=2,
            channels=[16, 32, 64, 128, 256], strides=[2, 2, 2, 2],
            num_res_units=2, norm="batch"
        ))

    def get_btcv_model(self) -> torch.nn.Module:
        from monai.networks.nets import SwinUNETR
        return self._load_state_dict_model("btcv", "swinunetr_btcv", lambda: SwinUNETR(
            in_channels=1, out_channels=14, feature_size=48
        ))

    def get_prostate_model(self) -> torch.nn.Module:
        from monai.networks.nets import UNet
        return self._load_state_dict_model("prostate", "prostate_mri", lambda: UNet(
            spatial_dims=3, in_channels=1, out_channels=3,
            channels=[16, 32, 64, 128, 256, 512], strides=[2, 2, 2, 2, 2],
            num_res_units=4, norm="batch", act="prelu", dropout=0.15
        ))

    def get_brats_model(self) -> torch.nn.Module:
        from monai.networks.nets import SegResNet
        return self._load_state_dict_model("brats", "brats_mri", lambda: SegResNet(
            spatial_dims=3, in_channels=4, out_channels=3, init_filters=16,
            blocks_down=[1, 2, 2, 4], blocks_up=[1, 1, 1], dropout_prob=0.2
        ))

    def get_wholebody_model(self) -> torch.nn.Module:
        from monai.networks.nets import SegResNet
        return self._load_state_dict_model("wholebody", "wholebody_ct", lambda: SegResNet(
            spatial_dims=3, in_channels=1, out_channels=105, init_filters=32,
            blocks_down=[1, 2, 2, 4], blocks_up=[1, 1, 1], dropout_prob=0.2
        ))

    def get_cardiac_model(self) -> Any:
        if "cardiac" in self.models:
            return self.models["cardiac"]
        weights_path, _ = self._verified_weights("ventricular_short_axis")
        # 该 bundle 发布的是 TorchScript 模型
        model = torch.jit.load(str(weights_path), map_location=self.device)
        model.eval()
        self.models["cardiac"] = model
        return model

    # ---- 通用 3D 推理：规范体积 -> 临时 NIfTI -> bundle 预处理 -> 滑窗 -> Invertd 回原网格 ----
    def _run_3d_bundle(
        self,
        vol_zyx: np.ndarray,
        spacing: Tuple[float, float, float],
        spatial_transforms: List[Any],
        model: torch.nn.Module,
        roi_size: List[int],
        sw_batch_size: int,
        overlap: float,
        invert_probabilities: bool,
        sw_mode: str = "constant",
        padding_mode: str = "constant",
        label_postprocess=None,
    ) -> np.ndarray:
        """
        invert_probabilities=True：softmax 概率经 Invertd（双线性）回原网格后再 argmax（spleen / BTCV bundle 的做法）；
        False：在模型网格上 argmax（可选标签后处理）后以最近邻 Invertd 回原网格（wholeBody / prostate）。
        返回规范 LPS+ (Z, Y, X) 的整数标签图。
        """
        from monai.transforms import Compose, LoadImaged, EnsureChannelFirstd, EnsureTyped, Invertd
        from monai.inferers import sliding_window_inference

        nii_path = write_canonical_nifti(vol_zyx, spacing)
        try:
            pre = Compose([
                LoadImaged(keys="image"),
                EnsureChannelFirstd(keys="image"),
                *spatial_transforms,
                EnsureTyped(keys="image"),
            ])
            data = pre({"image": nii_path})
            in_tensor = data["image"].unsqueeze(0).to(self.device)
            with torch.no_grad():
                logits = sliding_window_inference(
                    inputs=in_tensor, roi_size=roi_size, sw_batch_size=sw_batch_size,
                    predictor=model, overlap=overlap, mode=sw_mode, padding_mode=padding_mode,
                )
            # Invertd 在 CPU 上执行（Apple MPS 不支持 float64）
            logits = logits[0].detach().cpu().float()
            if invert_probabilities:
                data["pred"] = torch.softmax(logits, dim=0)
                inv = Invertd(keys="pred", transform=pre, orig_keys="image", nearest_interp=False, to_tensor=True)
                pred = inv(data)["pred"]
                labels_xyz = torch.argmax(pred, dim=0).numpy().astype(np.uint8)
            else:
                lab = torch.argmax(logits, dim=0, keepdim=True)
                if label_postprocess is not None:
                    lab = label_postprocess(lab)
                data["pred"] = lab.float()
                inv = Invertd(keys="pred", transform=pre, orig_keys="image", nearest_interp=True, to_tensor=True)
                pred = inv(data)["pred"]
                labels_xyz = np.rint(pred[0].numpy()).astype(np.uint8)
        finally:
            if os.path.exists(nii_path):
                os.remove(nii_path)

        labels_zyx = np.transpose(labels_xyz, (2, 1, 0))
        if labels_zyx.shape != tuple(vol_zyx.shape):
            raise RuntimeError(f"模型输出网格 {labels_zyx.shape} 与输入体积 {vol_zyx.shape} 不一致，拒绝输出")
        return labels_zyx

    def infer_spleen(self, vol_zyx: np.ndarray, spacing: Tuple[float, float, float]) -> Tuple[np.ndarray, Dict[str, Any]]:
        """spleen_ct_segmentation bundle：RAS、1.5×1.5×2.0 mm、HU -57~164 归一化、96³ 滑窗 overlap 0.5。"""
        from monai.transforms import Orientationd, Spacingd, ScaleIntensityRanged
        t0 = time.time()
        model = self.get_spleen_model()
        labels = self._run_3d_bundle(
            vol_zyx, spacing,
            [Orientationd(keys="image", axcodes="RAS"),
             Spacingd(keys="image", pixdim=[1.5, 1.5, 2.0], mode="bilinear"),
             ScaleIntensityRanged(keys="image", a_min=-57, a_max=164, b_min=0, b_max=1, clip=True)],
            model, roi_size=[96, 96, 96], sw_batch_size=4, overlap=0.5, invert_probabilities=True,
        )
        mask = (labels == 1).astype(np.uint8)
        meta = self._base_meta("spleen_ct", "MONAI 3D UNet (spleen_ct_segmentation bundle)", t0)
        meta["positive_voxels"] = int(mask.sum())
        meta["postprocessing"] = "softmax → Invertd → argmax（与 bundle 一致，未做额外连通域筛选）"
        return mask, meta

    def infer_btcv(
        self,
        vol_zyx: np.ndarray,
        spacing: Tuple[float, float, float],
        target_classes: Optional[List[int]] = None
    ) -> Tuple[np.ndarray, Dict[str, Any]]:
        """
        swin_unetr_btcv_segmentation bundle：RAS、1.5×1.5×2.0 mm、HU -175~250 归一化、96³ 滑窗 overlap 0.5。
        target_classes 给定时只返回这些类别；这些类别为空就返回空掩膜，不回退到其他器官。
        """
        from monai.transforms import Orientationd, Spacingd, ScaleIntensityRanged
        t0 = time.time()
        model = self.get_btcv_model()
        labels = self._run_3d_bundle(
            vol_zyx, spacing,
            [Orientationd(keys="image", axcodes="RAS"),
             Spacingd(keys="image", pixdim=[1.5, 1.5, 2.0], mode="bilinear"),
             ScaleIntensityRanged(keys="image", a_min=-175, a_max=250, b_min=0.0, b_max=1.0, clip=True)],
            model, roi_size=[96, 96, 96], sw_batch_size=4, overlap=0.5, invert_probabilities=True,
        )
        dz, dy, dx = spacing
        vox_cm3 = (dz * dy * dx) / 1000.0
        organ_volumetry = {name: round(int(np.sum(labels == idx)) * vox_cm3, 2) for idx, name in BTCV_ORGAN_LABELS.items()}
        if target_classes:
            mask = np.isin(labels, target_classes).astype(np.uint8)
        else:
            mask = (labels > 0).astype(np.uint8)
        meta = self._base_meta("swinunetr_btcv", "MONAI SwinUNETR (swin_unetr_btcv_segmentation bundle, BTCV 13 类器官)", t0)
        meta["positive_voxels"] = int(mask.sum())
        meta["organ_volumetry"] = organ_volumetry
        meta["target_classes"] = list(target_classes) if target_classes else None
        return mask, meta

    def infer_prostate(self, vol_zyx: np.ndarray, spacing: Tuple[float, float, float]) -> Tuple[np.ndarray, Dict[str, Any]]:
        """
        prostate_mri_anatomy bundle：RAS、0.5 mm 各向同性、ScaleIntensity(0~1) + NormalizeIntensity、96³ 滑窗 overlap 0.5；
        argmax 后对标签 1、2 各保留最大连通域。标签：1 = 中央腺体，2 = 外周带。
        """
        from monai.transforms import Orientationd, Spacingd, ScaleIntensityd, NormalizeIntensityd
        t0 = time.time()
        model = self.get_prostate_model()

        def keep_lcc(lab: torch.Tensor) -> torch.Tensor:
            # 等价于 bundle 的 KeepLargestConnectedComponentd(applied_labels=[1, 2])：各标签独立保留最大连通域
            arr = lab.cpu().numpy()[0]
            out = np.zeros_like(arr)
            for k in (1, 2):
                comp = extract_largest_component((arr == k).astype(np.uint8))
                out[comp > 0] = k
            # 在原张量上就地写回，保留 MetaTensor 的空间变换记录，供 Invertd 使用
            res = lab.clone()
            res[0] = torch.from_numpy(out).to(res.dtype)
            return res
        labels = self._run_3d_bundle(
            vol_zyx, spacing,
            [Orientationd(keys="image", axcodes="RAS"),
             Spacingd(keys="image", pixdim=[0.5, 0.5, 0.5], mode="bilinear"),
             ScaleIntensityd(keys="image", minv=0, maxv=1),
             NormalizeIntensityd(keys="image")],
            model, roi_size=[96, 96, 96], sw_batch_size=4, overlap=0.5, invert_probabilities=False,
            label_postprocess=keep_lcc,
        )
        dz, dy, dx = spacing
        vox_cm3 = (dz * dy * dx) / 1000.0
        cg_vol = round(float(np.sum(labels == 1)) * vox_cm3, 2)
        pz_vol = round(float(np.sum(labels == 2)) * vox_cm3, 2)
        meta = self._base_meta("prostate_mri", "MONAI 3D UNet (prostate_mri_anatomy bundle)", t0)
        meta.update({
            "positive_voxels": int(np.sum(labels > 0)),
            "central_gland_cm3": cg_vol,
            "peripheral_zone_cm3": pz_vol,
            "total_prostate_cm3": round(cg_vol + pz_vol, 2),
            "label_map": {"1": "central gland", "2": "peripheral zone"},
        })
        return labels.astype(np.uint8), meta

    def infer_brats(self, file_path: str, channel_order: Optional[List[str]]) -> Tuple[np.ndarray, Dict[str, Any]]:
        """
        brats_mri_segmentation bundle：输入 4 通道 MRI，通道顺序须为 T1c, T1, T2, FLAIR；
        预处理仅 NormalizeIntensity(nonzero, channel_wise)；240×240×160 滑窗 overlap 0.5；sigmoid 阈值 0.5。
        bundle 按 1 mm 各向同性数据训练且不做重采样，体素间距偏离 1 mm 时报错。
        单通道不得复制冒充多序列；未声明通道顺序时报错。
        返回规范 LPS+ 下的标签图：1 = 全肿瘤 (WT) 内非核心部分，2 = 肿瘤核心 (TC) 内非增强部分，3 = 增强肿瘤 (ET)。
        """
        import nibabel as nib
        from monai.transforms import NormalizeIntensity
        from monai.inferers import sliding_window_inference

        if not file_path or not os.path.exists(str(file_path)):
            raise ValueError("BraTS 推理需要原始 4 通道 MRI 文件路径（单通道体积不能用于该模型）")
        if not channel_order:
            raise ValueError(f"BraTS 推理需声明输入文件的通道顺序（例如 ['FLAIR','T1','T1c','T2']），模型要求顺序为 {list(BRATS_CHANNEL_ORDER)}")
        order = [str(c).strip() for c in channel_order]
        norm = {c.upper().replace("GD", "C").replace("CE", "C"): i for i, c in enumerate(order)}
        missing = [c for c in BRATS_CHANNEL_ORDER if c.upper() not in norm]
        if missing or len(order) != 4:
            raise ValueError(f"通道顺序声明须恰好包含 {list(BRATS_CHANNEL_ORDER)} 四个序列，缺少: {missing}")

        t0 = time.time()
        nimg = nib.load(str(file_path))
        data = np.asarray(nimg.get_fdata(dtype=np.float32))
        if data.ndim != 4 or data.shape[3] != 4:
            raise ValueError(f"BraTS 推理需要 4 通道体积，当前数据形状为 {data.shape}；缺序列时不能推理")
        zooms = nimg.header.get_zooms()[:3]
        if any(abs(float(z) - 1.0) > 0.1 for z in zooms):
            raise ValueError(f"BraTS bundle 要求 1 mm 各向同性输入，当前体素间距 {tuple(float(z) for z in zooms)}，请先重采样")

        idx = [norm[c.upper()] for c in BRATS_CHANNEL_ORDER]
        img = torch.from_numpy(np.transpose(data[..., idx], (3, 0, 1, 2)).copy())
        img = NormalizeIntensity(nonzero=True, channel_wise=True)(img)
        model = self.get_brats_model()
        with torch.no_grad():
            logits = sliding_window_inference(
                inputs=torch.as_tensor(img).unsqueeze(0).to(self.device).float(),
                roi_size=[240, 240, 160], sw_batch_size=1, predictor=model, overlap=0.5,
            )
        probs = torch.sigmoid(logits[0]).cpu().numpy()
        tc_xyz, wt_xyz, et_xyz = probs[0] > 0.5, probs[1] > 0.5, probs[2] > 0.5
        lab_xyz = np.zeros(tc_xyz.shape, dtype=np.uint8)
        lab_xyz[wt_xyz] = 1
        lab_xyz[tc_xyz] = 2
        lab_xyz[et_xyz] = 3
        # 输出在文件原生网格上，按文件仿射转回规范 LPS+
        labels = nifti_array_to_canonical(lab_xyz, nimg.affine).astype(np.uint8)

        vox_cm3 = float(np.prod(zooms)) / 1000.0
        meta = self._base_meta("brats_mri", "MONAI SegResNet (brats_mri_segmentation bundle, 4 通道)", t0)
        meta.update({
            "positive_voxels": int(np.sum(labels > 0)),
            "whole_tumor_cm3": round(float(np.sum(wt_xyz)) * vox_cm3, 2),
            "tumor_core_cm3": round(float(np.sum(tc_xyz)) * vox_cm3, 2),
            "enhancing_tumor_cm3": round(float(np.sum(et_xyz)) * vox_cm3, 2),
            "input_channel_order_declared": order,
            "model_channel_order": list(BRATS_CHANNEL_ORDER),
        })
        return labels, meta

    def infer_cardiac(self, vol_zyx: np.ndarray, spacing: Tuple[float, float, float]) -> Tuple[np.ndarray, Dict[str, Any]]:
        """
        ventricular_short_axis_3label bundle：整体 ScaleIntensity 到 0~1，逐层 2D 推理（SliceInferer，roi 256×256，不缩放图像）。
        标签：1 = 左室血池，2 = 心肌，3 = 右室血池。模型只适用于短轴 cine SSFP；单期相不能计算射血分数。
        """
        from monai.transforms import ScaleIntensity
        from monai.inferers import SliceInferer
        t0 = time.time()
        model = self.get_cardiac_model()
        # (Z, Y, X) -> NIfTI 式 (X, Y, Z)，逐个 Z 层做 2D 推理
        vol_xyz = np.transpose(np.asarray(vol_zyx, dtype=np.float32), (2, 1, 0))
        img = ScaleIntensity()(torch.from_numpy(vol_xyz.copy())).unsqueeze(0).unsqueeze(0).to(self.device).float()
        inferer = SliceInferer(roi_size=[256, 256], spatial_dim=2)
        with torch.no_grad():
            out = inferer(img, model)
        lab_xyz = torch.argmax(out[0], dim=0).cpu().numpy().astype(np.uint8)
        labels = np.transpose(lab_xyz, (2, 1, 0))

        dz, dy, dx = spacing
        vox_ml = (dz * dy * dx) / 1000.0
        meta = self._base_meta("ventricular_short_axis", "MONAI 2D UNet TorchScript (ventricular_short_axis_3label bundle)", t0)
        meta.update({
            "positive_voxels": int(np.sum(labels > 0)),
            "lv_pool_ml": round(float(np.sum(labels == 1)) * vox_ml, 2),
            "myocardium_ml": round(float(np.sum(labels == 2)) * vox_ml, 2),
            "rv_pool_ml": round(float(np.sum(labels == 3)) * vox_ml, 2),
            "label_map": {"1": "lv_pool", "2": "myocardium", "3": "rv_pool"},
            "input_requirement": "模型训练于心脏短轴 cine SSFP 图像；输入不是短轴 cine（例如 MSD Task02 左心房 MRI）时输出没有解剖意义",
        })
        return labels, meta

    def infer_wholebody(self, vol_zyx: np.ndarray, spacing: Tuple[float, float, float]) -> Tuple[np.ndarray, Dict[str, Any]]:
        """
        wholeBody_ct_segmentation bundle（高分辨率版权重）：RAS、1.5 mm 各向同性、NormalizeIntensity(nonzero)、
        ScaleIntensity(-1~1)、96³ 高斯加权滑窗 overlap 0.25、replicate 填充；argmax 后最近邻 Invertd。
        全分辨率推理内存占用较大（输出 105 通道），资源不足时会直接报错，不缩小体积凑合推理。
        """
        from monai.transforms import Orientationd, Spacingd, NormalizeIntensityd, ScaleIntensityd
        t0 = time.time()
        model = self.get_wholebody_model()
        labels = self._run_3d_bundle(
            vol_zyx, spacing,
            [Orientationd(keys="image", axcodes="RAS"),
             Spacingd(keys="image", pixdim=[1.5, 1.5, 1.5], mode="bilinear"),
             NormalizeIntensityd(keys="image", nonzero=True),
             ScaleIntensityd(keys="image", minv=-1.0, maxv=1.0)],
            model, roi_size=[96, 96, 96], sw_batch_size=1, overlap=0.25, invert_probabilities=False,
            sw_mode="gaussian", padding_mode="replicate",
        )
        dz, dy, dx = spacing
        vox_cm3 = (dz * dy * dx) / 1000.0
        counts = np.bincount(labels.ravel(), minlength=len(WHOLEBODY_CT_LABELS))
        structures = {
            WHOLEBODY_CT_LABELS[i]: round(int(counts[i]) * vox_cm3, 2)
            for i in range(1, len(WHOLEBODY_CT_LABELS)) if counts[i] > 0
        }
        meta = self._base_meta("wholebody_ct", "MONAI SegResNet (wholeBody_ct_segmentation bundle, 104 类结构)", t0)
        meta.update({
            "positive_voxels": int(np.sum(labels > 0)),
            "structure_volumes_cm3": structures,
        })
        return labels, meta


# 规则算法（阈值/形态学/区域生长）模型：真实计算，但不是神经网络；输出中如实标注方法
RULE_BASED_MODELS = {
    "bronchiectasis_mucus_analyzer", "bronchiectasis",
    "lung_nodule_segmenter",
    "copd_emphysema_analyzer", "copd_emphysema",
    "whole_body_ct_segmenter", "totalsegmentator",
    "vertebra_segmenter",
    "vista3d_interactive_segmenter", "vista3d", "interactive_region_growing",
}

# 没有真实实现的模型：调用即报「未实现」，不做阈值替代
NOT_IMPLEMENTED_MODELS: Dict[str, str] = {
    "lung_airway_segmenter": "气道树分割模型未接入",
    "airway_unet": "气道树分割模型未接入",
    "airway": "气道树分割模型未接入",
    "lung_lobe_segmenter": "肺叶分割模型未接入",
    "covid19_lung_infection": "病毒性肺炎病灶分割模型未接入",
    "covid19": "病毒性肺炎病灶分割模型未接入",
    "coronary_artery_calcification": "缺少心脏/冠状动脉区域来源，无法按标准 Agatston 方法逐病灶计分，已下线",
    "brain_subcortical_segmenter": "全脑结构分割模型（UNEST）未接入推理路径",
    "wholebrainseg_large_unest": "全脑结构分割模型（UNEST）未接入推理路径",
    "stroke_ischemic_lesion": "脑梗死分割模型未接入",
    "intracranial_hemorrhage_ct": "颅内出血检测模型未接入",
    "valve_landmarks": "瓣膜地标模型未接入推理路径",
    "breast_density": "乳腺密度分类模型未接入推理路径",
    "pathology_tumor_detection": "病理 WSI 模型未接入推理路径",
    "pathology_nuclei": "病理细胞核模型未接入推理路径",
    "endoscopic_tool": "内镜器械分割模型未接入推理路径",
    "renal_structures_cect": "肾脏精细结构模型未接入推理路径",
    "pancreas_ct_dints": "DiNTS 胰腺模型未接入推理路径",
}

# BTCV 器官子集（如实标注为 BTCV 器官分割，不是病灶/肿瘤模型）
BTCV_ORGAN_SUBSETS: Dict[str, Tuple[List[int], str]] = {
    "pancreas_tumor_segmenter": ([11], "BTCV 器官分割：胰腺"),
    "kidney_tumor_segmenter": ([2, 3], "BTCV 器官分割：双肾"),
    "liver_lesion_segmenter": ([6], "BTCV 器官分割：肝脏"),
    "liver_ct": ([6], "BTCV 器官分割：肝脏"),
}

INTERPRETATION_HINT = "需结合临床与实验室检查判断"


def _empty_measurements(key_slice_idx: int, basis: str) -> Dict[str, Any]:
    """没有病灶径线可测的分析：径线/体积字段为空，只保留关键层号及其依据。"""
    return {
        "longest_diameter_mm": None,
        "short_axis_mm": None,
        "total_volume_cm3": None,
        "caliper_longest": None,
        "caliper_short": None,
        "key_slice_index": int(key_slice_idx),
        "key_slice_basis": basis,
        "has_lesion": None,
    }


def _fmt(v: Any, unit: str = "") -> str:
    if v is None:
        return "n/a"
    return f"{v}{(' ' + unit) if unit else ''}"


class MONAIEngine:
    def __init__(self):
        self.device = get_optimal_device()
        self.device_info = get_device_info()
        self.volume_cache: Dict[str, Tuple[np.ndarray, Tuple[float, float, float], str]] = {}
        self.mask_cache: Dict[str, np.ndarray] = {}
        self.mask_method_cache: Dict[str, str] = {}
        self.neural_pipeline = MonaiNeuralInferencePipeline(self.device)

    # ------------------------------------------------------------------
    # MPR 叠加掩膜：只显示真实模型输出或明确标注的规则算法结果
    # ------------------------------------------------------------------
    def extract_mask_for_model(
        self,
        volume: np.ndarray,
        spacing: Tuple[float, float, float],
        model_name: str,
        sample_id_or_path: Optional[str] = None
    ) -> Tuple[Optional[np.ndarray], Optional[str]]:
        """
        返回 (掩膜, 叠加方法说明)。没有真实实现的模型返回 (None, None)，MPR 不显示叠加。
        规则算法的掩膜在说明里标「阈值示意」。
        """
        if model_name in NOT_IMPLEMENTED_MODELS:
            return None, None

        if model_name in ("bronchiectasis_mucus_analyzer", "bronchiectasis"):
            try:
                from .bronchiectasis import analyze_bronchiectasis_and_mucus
            except (ImportError, ValueError):
                from bronchiectasis import analyze_bronchiectasis_and_mucus
            b_res = analyze_bronchiectasis_and_mucus(volume, spacing=spacing, window_preset="lung", return_masks=True)
            mask = b_res.get("mucus_mask")
            if mask is None:
                mask = b_res.get("mask")
            if mask is None:
                return None, None
            return mask.astype(np.uint8), "阈值示意：粘液栓 HU 阈值/形态学候选"

        if model_name in ("whole_body_ct_segmenter", "totalsegmentator"):
            try:
                from .totalsegmentator import analyze_whole_body_ct
            except (ImportError, ValueError):
                from totalsegmentator import analyze_whole_body_ct
            wb_res = analyze_whole_body_ct(volume=volume, spacing=spacing)
            mask = wb_res.get("mask")
            if mask is None:
                return None, None
            return mask.astype(np.uint8), "阈值示意：HU 阈值体成分"

        if model_name == "lung_nodule_segmenter":
            mask, _, _ = segment_pulmonary_nodules(volume, spacing)
            return mask.astype(np.uint8), "阈值示意：肺结节候选 HU/形态学筛查"

        if model_name in ("copd_emphysema_analyzer", "copd_emphysema"):
            try:
                from .quality_assurance import segment_lungs
            except (ImportError, ValueError):
                from quality_assurance import segment_lungs
            lung = segment_lungs(volume, float(np.prod(spacing)) / 1000.0)
            if lung is None:
                return None, None
            return (lung & (volume <= -950.0)).astype(np.uint8), "阈值示意：肺内 ≤ -950 HU 低衰减区"

        if model_name == "vertebra_segmenter":
            bone = extract_largest_component((volume >= 220.0).astype(np.uint8))
            return bone, "阈值示意：≥ 220 HU 骨最大连通域"

        if model_name in ("spleen_segmenter", "spleen_ct"):
            mask, _ = self.neural_pipeline.infer_spleen(volume, spacing)
            return mask, "MONAI spleen_ct_segmentation 推理"

        if model_name in ("multi_organ_ct", "swinunetr_btcv"):
            mask, _ = self.neural_pipeline.infer_btcv(volume, spacing)
            return mask, "MONAI swin_unetr_btcv 推理"

        if model_name in BTCV_ORGAN_SUBSETS:
            classes, title = BTCV_ORGAN_SUBSETS[model_name]
            mask, _ = self.neural_pipeline.infer_btcv(volume, spacing, target_classes=classes)
            return mask, f"{title}（MONAI swin_unetr_btcv 推理）"

        if model_name in ("prostate_mri_segmenter", "prostate_mri"):
            labels, _ = self.neural_pipeline.infer_prostate(volume, spacing)
            return (labels > 0).astype(np.uint8), "MONAI prostate_mri_anatomy 推理"

        if model_name in ("cardiac_mri_segmentation", "ventricular_short_axis", "cardiac_anatomy_segmenter"):
            labels, _ = self.neural_pipeline.infer_cardiac(volume, spacing)
            return (labels > 0).astype(np.uint8), "MONAI ventricular_short_axis_3label 推理"

        if model_name in ("monai_wholebody_ct", "wholebody_ct"):
            labels, _ = self.neural_pipeline.infer_wholebody(volume, spacing)
            return (labels > 0).astype(np.uint8), "MONAI wholeBody_ct_segmentation 推理"

        # BraTS 需要 4 通道原始文件，交互分割需要种子点：MPR 叠加不支持；其他未知模型同样不叠加
        return None, None

    def get_or_compute_mask(
        self,
        sample_id_or_path: str,
        vol: np.ndarray,
        spacing: Tuple[float, float, float],
        model_name: Optional[str] = None
    ) -> Optional[np.ndarray]:
        """
        取缓存或运行指定模型得到叠加掩膜；未指定模型时不叠加（返回 None）。
        缓存以「完整路径/样本 ID + 模型」为键，避免跨患者混用。
        """
        if not model_name:
            return None
        cache_key = f"{sample_id_or_path}:{model_name}"
        if cache_key in self.mask_cache and self.mask_cache[cache_key].shape == vol.shape:
            return self.mask_cache[cache_key]

        mask, method = self.extract_mask_for_model(
            volume=vol, spacing=spacing, model_name=model_name, sample_id_or_path=sample_id_or_path
        )
        if mask is None:
            return None
        mask = mask.astype(np.uint8)
        self.mask_cache[cache_key] = mask
        self.mask_method_cache[cache_key] = method or ""
        return mask

    def register_volume(
        self,
        volume_id: str,
        volume: np.ndarray,
        spacing: Tuple[float, float, float],
        modality: str = "CT"
    ) -> Dict[str, Any]:
        """Registers a loaded 3D medical volume into the engine's memory cache."""
        self.volume_cache[volume_id] = (volume, spacing, modality)
        z, y, x = volume.shape
        dz, dy, dx = spacing
        return {
            "volume_id": volume_id,
            "dimensions": {"z": int(z), "y": int(y), "x": int(x)},
            "voxel_spacing_mm": {"dz": round(float(dz), 3), "dy": round(float(dy), 3), "dx": round(float(dx), 3)},
            "modality": modality
        }

    def has_volume(self, volume_id: str) -> bool:
        """Checks if a volume is loaded in cache."""
        return hasattr(self, "volume_cache") and volume_id in self.volume_cache

    def analyze_file(
        self,
        file_path: str,
        model_name: Optional[str] = None,
        window_preset: Optional[str] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """读取 NIfTI 或 DICOM 并运行指定模型；模型必须由调用方给出。"""
        if not model_name:
            raise ValueError("缺少 model_name：请指定要运行的分析模型")
        try:
            from .dicom_io import load_volume
        except (ImportError, ValueError):
            from dicom_io import load_volume
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"影像文件不存在: {file_path}")
        vol, spacing, modality = load_volume(file_path)
        if kwargs.get("modality"):
            modality = str(kwargs.pop("modality"))

        if not window_preset:
            window_preset = "lung" if "lung" in model_name else ("brain" if "brain" in model_name else "abdomen")

        return self.analyze_volume(
            volume=vol,
            spacing=spacing,
            model_name=model_name,
            window_preset=window_preset,
            modality=modality,
            file_path=file_path,
            **kwargs
        )

    def analyze_volume(
        self,
        volume: np.ndarray,
        spacing: Tuple[float, float, float],
        model_name: Optional[str] = None,
        window_preset: Optional[str] = None,
        modality: str = "CT",
        **kwargs
    ) -> Dict[str, Any]:
        """
        在规范 LPS+ 体积上运行指定模型：
        1. 神经网络模型按 MONAI bundle 推理；规则算法如实标注方法；未实现的模型直接报错；
        2. 测量值（径线、体积、密度或专项量化）；没有病灶径线的分析，径线字段为空；
        3. 关键层面 PNG；
        4. 影像所见描述（只写测量所见，不给诊断结论与处置建议）。
        """
        if not model_name:
            raise ValueError("缺少 model_name：请指定要运行的分析模型")
        if model_name in NOT_IMPLEMENTED_MODELS:
            raise ModelUnavailableError(f"模型 '{model_name}' 未实现：{NOT_IMPLEMENTED_MODELS[model_name]}")

        if not window_preset:
            if "lung" in model_name or "copd" in model_name or "bronch" in model_name:
                window_preset = "lung"
            elif "brain" in model_name:
                window_preset = "brain"
            else:
                window_preset = "abdomen"

        if model_name in ("bronchiectasis_mucus_analyzer", "bronchiectasis"):
            try:
                from .bronchiectasis import analyze_bronchiectasis_and_mucus
            except (ImportError, ValueError):
                from bronchiectasis import analyze_bronchiectasis_and_mucus
            b_args: Dict[str, Any] = {"volume": volume, "spacing": spacing, "window_preset": window_preset or "lung"}
            for k in ("mucus_min_hu", "mucus_max_hu", "ham_threshold_hu", "bar_cutoff"):
                if k in kwargs and kwargs[k] is not None:
                    try:
                        b_args[k] = float(str(kwargs[k]).replace(",", "."))
                    except (ValueError, TypeError):
                        pass
            b_res = analyze_bronchiectasis_and_mucus(**b_args)
            b_res["model_name"] = "bronchiectasis_mucus_analyzer"
            b_res["modality"] = modality
            b_res["engine_type"] = "rule_based"
            # 支扩分析没有病灶径线：管径、动脉径与粘液栓容积留在 metrics 里，不塞进 RECIST 字段
            b_res["recist_metrics"] = _empty_measurements(b_res.get("key_slice_index", volume.shape[0] // 2), "支扩/粘液栓分析选取的关键层面")
            return b_res

        if model_name in ("whole_body_ct_segmenter", "totalsegmentator"):
            try:
                from .totalsegmentator import analyze_whole_body_ct
            except (ImportError, ValueError):
                from totalsegmentator import analyze_whole_body_ct
            wb_args: Dict[str, Any] = {"volume": volume, "spacing": spacing}
            if "patient_sex" in kwargs and kwargs["patient_sex"]:
                wb_args["patient_sex"] = str(kwargs["patient_sex"])
            if "patient_height_m" in kwargs and kwargs["patient_height_m"] is not None:
                wb_args["patient_height_m"] = float(kwargs["patient_height_m"])
            if "patient_weight_kg" in kwargs and kwargs["patient_weight_kg"] is not None:
                wb_args["patient_weight_kg"] = float(kwargs["patient_weight_kg"])
            if "l3_slice_index" in kwargs and kwargs["l3_slice_index"] is not None:
                wb_args["l3_slice_index"] = int(kwargs["l3_slice_index"])
            wb_res = analyze_whole_body_ct(**wb_args)
            wb_res["engine_type"] = "rule_based"
            # 体成分分析没有病灶径线；recist_metrics 只保留层号，径线与体积为空，不用肌肉面积等冒充
            wb_res["recist_metrics"] = _empty_measurements(wb_res.get("l3_vertebra_slice_index", volume.shape[0] // 2), "L3 层（启发式选层）")
            return wb_res

        t0 = time.time()
        neural_meta: Dict[str, Any] = {}
        extra_md = ""
        extra_feature_fields: Dict[str, Any] = {}
        engine_type = "deep_learning"

        if model_name == "lung_nodule_segmenter":
            prompt_pt = kwargs.get("prompt_point") or kwargs.get("click_point")
            mask_np, recist, lesion_label = segment_pulmonary_nodules(volume, spacing, prompt_point=prompt_pt)
            key_slice_idx = recist["key_slice_index"]
            engine_type = "rule_based"
            neural_meta = {
                "real_neural_inference": False,
                "method": "肺实质包络内 HU 阈值 (-150~+120 HU) + 形态学筛查；给定种子点时为有限范围 HU 区域生长",
                "positive_voxels": int(np.sum(mask_np > 0)),
                "accelerator": "cpu",
            }

        elif model_name in ("copd_emphysema_analyzer", "copd_emphysema"):
            try:
                from .recist import calculate_emphysema_metrics
                from .quality_assurance import segment_lungs
            except (ImportError, ValueError):
                from recist import calculate_emphysema_metrics
                from quality_assurance import segment_lungs
            thr = float(kwargs.get("emphysema_hu_threshold") or -950.0)
            em_res = calculate_emphysema_metrics(volume, spacing=spacing, emphysema_hu_threshold=thr)
            lung_mask = segment_lungs(volume, float(np.prod(spacing)) / 1000.0)
            engine_type = "quantitative_ct"
            if lung_mask is None:
                mask_np = np.zeros(volume.shape, dtype=np.uint8)
                key_slice_idx, basis = volume.shape[0] // 2, "未分割出双肺，取层面中点仅用于显示"
            else:
                mask_np = (lung_mask & (volume <= thr)).astype(np.uint8)
                laa_per_slice = np.sum(mask_np, axis=(1, 2))
                if laa_per_slice.max() > 0:
                    key_slice_idx, basis = int(np.argmax(laa_per_slice)), "低衰减区面积最大的层面"
                else:
                    key_slice_idx, basis = int(np.argmax(np.sum(lung_mask, axis=(1, 2)))), "肺面积最大的层面（无低衰减区体素）"
            # LAA% 等定量放在 emphysema 字段；不输出 GOLD 分级（GOLD 依据肺功能，CT 不能确定）
            recist = _empty_measurements(key_slice_idx, basis)
            recist["emphysema"] = em_res
            recist["quality_control"] = em_res.get("quality_control", {})
            extra_feature_fields["emphysema"] = em_res
            lesion_label = f"肺内 ≤{thr:.0f} HU 低衰减区"
            neural_meta = {
                "real_neural_inference": False,
                "method": f"quality_assurance.segment_lungs 阈值法肺分割 + 肺内 ≤{thr:.0f} HU 体素计数 (LAA%)",
                "positive_voxels": int(np.sum(mask_np > 0)),
                "accelerator": "cpu",
            }
            extra_md += (
                f"- **双肺容积**: `{_fmt(em_res.get('total_lung_volume_liters'), 'L')}`\n"
                f"- **低衰减区 (≤{thr:.0f} HU)**: `{_fmt(em_res.get('emphysema_volume_liters'), 'L')}`，LAA% `{_fmt(em_res.get('laa_percent'), '%')}`\n"
                f"- **Perc15**: `{_fmt(em_res.get('perc15_hu'), 'HU')}`\n"
            )
            if em_res.get("error"):
                extra_md += f"- **说明**: {em_res['error']}\n"

        elif model_name in ("spleen_segmenter", "spleen_ct"):
            mask_np, neural_meta = self.neural_pipeline.infer_spleen(volume, spacing)
            lesion_label = "脾脏（MONAI spleen_ct_segmentation 分割）"
            recist = calculate_recist_metrics(mask_np, spacing=spacing)
            key_slice_idx = recist["key_slice_index"]

        elif model_name in ("multi_organ_ct", "swinunetr_btcv"):
            mask_np, neural_meta = self.neural_pipeline.infer_btcv(volume, spacing)
            lesion_label = "BTCV 腹部 13 类器官（MONAI SwinUNETR 分割）"
            recist = calculate_recist_metrics(mask_np, spacing=spacing)
            key_slice_idx = recist["key_slice_index"]

        elif model_name in BTCV_ORGAN_SUBSETS:
            classes, title = BTCV_ORGAN_SUBSETS[model_name]
            mask_np, neural_meta = self.neural_pipeline.infer_btcv(volume, spacing, target_classes=classes)
            # 目标类别为空就是空结果，不回退到其他器官
            lesion_label = title if np.any(mask_np) else f"{title}（模型未分割出该器官）"
            recist = calculate_recist_metrics(mask_np, spacing=spacing)
            key_slice_idx = recist["key_slice_index"]

        elif model_name in ("prostate_mri_segmenter", "prostate_mri"):
            labels_np, neural_meta = self.neural_pipeline.infer_prostate(volume, spacing)
            mask_np = (labels_np > 0).astype(np.uint8)
            lesion_label = "前列腺中央腺体与外周带（MONAI prostate_mri_anatomy 分割）"
            recist = calculate_recist_metrics(mask_np, spacing=spacing)
            key_slice_idx = recist["key_slice_index"]

        elif model_name in ("brain_tumor_brats", "brats_mri"):
            labels_np, neural_meta = self.neural_pipeline.infer_brats(kwargs.get("file_path"), kwargs.get("channel_order"))
            if labels_np.shape != volume.shape:
                raise RuntimeError(f"BraTS 输出网格 {labels_np.shape} 与显示体积 {volume.shape} 不一致")
            mask_np = (labels_np > 0).astype(np.uint8)
            lesion_label = "BraTS 肿瘤子区（WT/TC/ET，MONAI SegResNet 分割）"
            recist = calculate_recist_metrics(mask_np, spacing=spacing)
            key_slice_idx = recist["key_slice_index"]

        elif model_name in ("cardiac_mri_segmentation", "ventricular_short_axis", "cardiac_anatomy_segmenter"):
            labels_np, neural_meta = self.neural_pipeline.infer_cardiac(volume, spacing)
            mask_np = (labels_np > 0).astype(np.uint8)
            recist = calculate_recist_metrics(mask_np, spacing=spacing)
            key_slice_idx = recist["key_slice_index"]
            lv, myo, rv = neural_meta["lv_pool_ml"], neural_meta["myocardium_ml"], neural_meta["rv_pool_ml"]
            recist["cardiac"] = {
                "lv_pool_volume_ml": lv,
                "rv_pool_volume_ml": rv,
                "myocardium_volume_ml": myo,
                # 心肌质量 = 心肌体积 × 1.05 g/mL（心肌密度常数）
                "myocardial_mass_g": round(myo * 1.05, 1) if myo else None,
                "ejection_fraction": None,
                "ejection_fraction_note": "单期相图像无法计算射血分数",
                "input_requirement": neural_meta["input_requirement"],
            }
            lesion_label = "心室血池与心肌（MONAI ventricular_short_axis_3label 分割）"

        elif model_name in ("monai_wholebody_ct", "wholebody_ct"):
            labels_np, neural_meta = self.neural_pipeline.infer_wholebody(volume, spacing)
            mask_np = (labels_np > 0).astype(np.uint8)
            recist = calculate_recist_metrics(mask_np, spacing=spacing)
            key_slice_idx = recist["key_slice_index"]
            lesion_label = "全身 104 类解剖结构（MONAI wholeBody_ct_segmentation 分割）"

        elif model_name == "vertebra_segmenter":
            engine_type = "rule_based"
            mask_np = extract_largest_component((volume >= 220.0).astype(np.uint8))
            prompt_pt = kwargs.get("prompt_point") or kwargs.get("click_point")
            roi_radius_mm = float(kwargs.get("roi_radius_mm") or 5.0)
            roi_mean = None
            roi_info = None
            if isinstance(prompt_pt, dict) and all(k in prompt_pt for k in ("z", "y", "x")):
                pz = int(np.clip(int(prompt_pt["z"]), 0, volume.shape[0] - 1))
                py, px = int(prompt_pt["y"]), int(prompt_pt["x"])
                _, dy, dx = spacing
                yy, xx = np.ogrid[:volume.shape[1], :volume.shape[2]]
                disk = ((yy - py) * dy) ** 2 + ((xx - px) * dx) ** 2 <= roi_radius_mm ** 2
                if np.any(disk):
                    roi_mean = round(float(np.mean(volume[pz][disk])), 1)
                    roi_info = {"z": pz, "y": py, "x": px, "radius_mm": roi_radius_mm, "pixels": int(np.sum(disk))}
                key_slice_idx, basis = pz, "ROI 所在层面"
            else:
                bone_per_slice = np.sum(mask_np, axis=(1, 2))
                key_slice_idx = int(np.argmax(bone_per_slice)) if bone_per_slice.max() > 0 else volume.shape[0] // 2
                basis = "骨阈值面积最大的层面（未提供 ROI）"
            recist = _empty_measurements(key_slice_idx, basis)
            # 只给松质骨 ROI 的平均 CT 值（单位 HU），不换算 mg/cm³、不估算 T 值、不做骨量判定
            recist["spine"] = {
                "roi_mean_hu": roi_mean,
                "unit": "HU",
                "roi": roi_info,
                "method": "调用方给定的椎体松质骨种子点处、同层圆形 ROI 内 CT 值平均；未提供 ROI 时为空",
            }
            lesion_label = "骨 ≥220 HU 阈值示意" + (f"；松质骨 ROI 平均 {roi_mean} HU" if roi_mean is not None else "；未提供松质骨 ROI")
            neural_meta = {
                "real_neural_inference": False,
                "method": "骨 HU ≥ 220 最大连通域（显示用）+ 手动圆形 ROI 平均 HU",
                "positive_voxels": int(np.sum(mask_np > 0)),
                "accelerator": "cpu",
            }
            extra_md += f"- **松质骨 ROI 平均 CT 值**: `{_fmt(roi_mean, 'HU')}`（{recist['spine']['method']}）\n"

        elif model_name in ("vista3d_interactive_segmenter", "vista3d", "interactive_region_growing"):
            engine_type = "rule_based"
            prompt_pt = kwargs.get("prompt_point") or kwargs.get("click_point")
            if isinstance(prompt_pt, dict) and all(k in prompt_pt for k in ("z", "y", "x")):
                seed = (int(prompt_pt["z"]), int(prompt_pt["y"]), int(prompt_pt["x"]))
            elif isinstance(prompt_pt, (list, tuple)) and len(prompt_pt) == 3:
                seed = tuple(int(v) for v in prompt_pt)
            else:
                raise ValueError("HU 区域生长需要种子点 prompt_point={z, y, x}")
            seed = tuple(int(np.clip(s, 0, volume.shape[i] - 1)) for i, s in enumerate(seed))
            seed_val = float(volume[seed])
            tol = 45.0
            band = (volume >= seed_val - tol) & (volume <= seed_val + tol)
            lbl, _ = ndi.label(band)
            mask_np = (lbl == lbl[seed]).astype(np.uint8) if lbl[seed] > 0 else np.zeros(volume.shape, dtype=np.uint8)
            recist = calculate_recist_metrics(mask_np, spacing=spacing)
            key_slice_idx = recist["key_slice_index"]
            lesion_label = "种子点 HU 区域生长（±45 HU 连通域）"
            neural_meta = {
                "real_neural_inference": False,
                "method": f"HU 区域生长：种子点 {seed} 处 CT 值 {round(seed_val, 1)} HU ±{tol} HU，取与种子点连通的区域（不是 VISTA-3D 模型）",
                "prompt_point": list(seed),
                "positive_voxels": int(np.sum(mask_np > 0)),
                "accelerator": "cpu",
            }
        else:
            raise ModelUnavailableError(f"模型 '{model_name}' 未实现或未登记，不会以其他算法替代。")

        if model_name in ("vista3d_interactive_segmenter", "vista3d"):
            model_name = "interactive_region_growing"

        key_slice_idx = int(np.clip(int(key_slice_idx), 0, volume.shape[0] - 1))
        method_label = neural_meta.get("neural_architecture") if neural_meta.get("real_neural_inference") else (
            "Rule-based (HU threshold)" if engine_type == "rule_based" else "Quantitative CT (HU threshold)"
        )

        ct_windowed = apply_ct_window(volume, window_name=window_preset)
        png_bytes = render_key_slice_png(
            ct_slice_uint8=ct_windowed[key_slice_idx],
            mask_slice_2d=mask_np[key_slice_idx],
            recist=recist,
            modality=f"{modality} ({window_preset.title()} Window)",
            lesion_name=lesion_label,
            scale_bar_mm=50.0,
            pixel_spacing_mm=spacing[2],
            method_label=method_label,
        )

        elapsed_sec = round(time.time() - t0, 3)

        neural_md = ""
        if neural_meta.get("real_neural_inference"):
            neural_md = (
                f"- **神经网络**: `{neural_meta.get('neural_architecture')}`（权重版本 {neural_meta.get('weights_version')}，SHA-256 已校验）\n"
                f"- **分割体积**: `{_fmt(recist.get('total_volume_cm3'), 'cm³')}`（体素数 `{neural_meta.get('positive_voxels', 0)}`）\n"
            )
            if neural_meta.get("organ_volumetry"):
                organ_lines = "".join([f"  - {k}: `{v} cm³`\n" for k, v in neural_meta["organ_volumetry"].items() if v > 0])
                if organ_lines:
                    neural_md += f"- **BTCV 各器官分割体积**:\n{organ_lines}"
            if "central_gland_cm3" in neural_meta:
                neural_md += (
                    f"- **前列腺分带体积**: 全腺体 `{neural_meta['total_prostate_cm3']} cm³`，"
                    f"中央腺体 `{neural_meta['central_gland_cm3']} cm³`，外周带 `{neural_meta['peripheral_zone_cm3']} cm³`\n"
                )
            if "whole_tumor_cm3" in neural_meta:
                neural_md += (
                    f"- **BraTS 子区体积**: WT `{neural_meta['whole_tumor_cm3']} cm³`，"
                    f"TC `{neural_meta['tumor_core_cm3']} cm³`，ET `{neural_meta['enhancing_tumor_cm3']} cm³`\n"
                )
            if "cardiac" in recist:
                card = recist["cardiac"]
                neural_md += (
                    f"- **心室分割体积**: 左室血池 `{card['lv_pool_volume_ml']} mL`，右室血池 `{card['rv_pool_volume_ml']} mL`，"
                    f"心肌 `{card['myocardium_volume_ml']} mL`（按 1.05 g/mL 折合 `{_fmt(card['myocardial_mass_g'], 'g')}`）；{card['ejection_fraction_note']}\n"
                    f"- **输入要求**: {card['input_requirement']}\n"
                )
            if neural_meta.get("structure_volumes_cm3"):
                neural_md += f"- **分割出的结构数**: `{len(neural_meta['structure_volumes_cm3'])}` 类\n"
        else:
            neural_md = f"- **方法**: {neural_meta.get('method', '')}\n"

        # 结构化特征（测量值）
        try:
            clinical_feats = extract_clinical_features(
                volume=volume,
                mask=(mask_np > 0).astype(np.uint8),
                spacing=spacing,
                modality=modality,
                target_name=lesion_label,
                window_preset=window_preset,
                lung_nodule_context=(model_name == "lung_nodule_segmenter"),
            )
            clinical_feats.update(extra_feature_fields)
        except Exception as e:
            clinical_feats = {"status": "error", "error": f"结构化特征提取失败: {e}"}

        # 影像所见描述：失败时如实返回错误，不编造所见
        patient_ctx = kwargs.get("patient_context")
        if clinical_feats.get("status") == "error":
            clinical_ai = {"status": "error", "error": f"报告生成失败：{clinical_feats['error']}"}
        else:
            try:
                clinical_ai = generate_clinical_ai_report(
                    features=clinical_feats,
                    patient_context=patient_ctx,
                    key_slice_png_base64=None
                )
            except Exception as e:
                clinical_ai = {"status": "error", "error": f"报告生成失败：{e}"}

        if clinical_ai.get("status") == "error":
            ai_report_md = f"\n\n### 影像所见\n{clinical_ai['error']}\n"
        else:
            ai_report_md = (
                f"\n\n### 影像所见（按测量值生成）\n"
                f"{clinical_ai.get('findings_description', '')}\n\n"
                f"{clinical_ai.get('interpretation_note', INTERPRETATION_HINT)}\n"
            )

        ld = recist.get("longest_diameter_mm")
        measure_md = ""
        if isinstance(ld, (int, float)) and recist.get("has_lesion"):
            measure_md = (
                f"- **关键层面最大长径**: `{ld} mm`（垂直短径 `{_fmt(recist.get('short_axis_mm'), 'mm')}`）\n"
                f"- **分割总体积**: `{_fmt(recist.get('total_volume_cm3'), 'cm³')}`\n"
            )

        return {
            "status": "success",
            "model_name": model_name,
            "engine_type": engine_type,
            "modality": modality,
            "accelerator": self.device_info.get("accelerator", str(self.device)),
            "device_type": self.device.type,
            "inference_duration_sec": elapsed_sec,
            "real_neural_inference": bool(neural_meta.get("real_neural_inference", False)),
            "neural_info": neural_meta,
            "volume_dimensions": list(volume.shape),
            "voxel_spacing_mm": list(spacing),
            "recist_metrics": recist,
            "clinical_features": clinical_feats,
            "clinical_ai_report": clinical_ai,
            "key_slice_png_base64": png_to_base64(png_bytes),
            "key_slice_png_size_bytes": len(png_bytes),
            "summary_markdown": (
                f"**影像分析结果（科研用途）**\n"
                f"- **分析模型**: `{model_name}`（{lesion_label}）\n"
                f"{neural_md}"
                f"- **体积维度**: `{volume.shape[0]} 层 × {volume.shape[1]} × {volume.shape[2]}`（层厚 {spacing[0]} mm）\n"
                f"- **关键层面**: 第 `#{key_slice_idx}` 层（{recist.get('key_slice_basis', '分割面积最大的层面')}）\n"
                f"{measure_md}"
                f"{extra_md}"
                f"{ai_report_md}"
            )
        }

    def load_volume_data(self, sample_id_or_path: str) -> Tuple[np.ndarray, Tuple[float, float, float], str]:
        """按内存缓存 -> data 目录样本 ID -> 文件/目录路径的顺序读取体积；都找不到就报错，不生成合成体。"""
        if not sample_id_or_path:
            raise ValueError("缺少影像来源：请提供 sample_id、volume_id 或 file_path")
        if hasattr(self, "volume_cache") and sample_id_or_path in self.volume_cache:
            return self.volume_cache[sample_id_or_path]

        try:
            from .dicom_io import load_volume
        except (ImportError, ValueError):
            from dicom_io import load_volume

        data_dir = Path(__file__).resolve().parent.parent / "data"

        for ext in (".nii.gz", ".nii", ".zip", ".gz"):
            p = data_dir / f"{sample_id_or_path}{ext}"
            if p.exists():
                vol, spacing, modality = load_volume(str(p), filename=f"{sample_id_or_path}{ext}")
                self.volume_cache[sample_id_or_path] = (vol, spacing, modality)
                return vol, spacing, modality

        if os.path.exists(sample_id_or_path):
            vol, spacing, modality = load_volume(sample_id_or_path)
            self.volume_cache[sample_id_or_path] = (vol, spacing, modality)
            return vol, spacing, modality

        raise FileNotFoundError(f"找不到影像: '{sample_id_or_path}'（不在内存缓存、样本目录或文件系统中）")

    def get_mpr_info(self, sample_id_or_path: str, model_name: Optional[str] = None) -> Dict[str, Any]:
        """体积维度、间距、各方向层数；指定模型时附带该模型掩膜的中心与外接盒。"""
        vol, spacing, modality = self.load_volume_data(sample_id_or_path)
        z_dim, y_dim, x_dim = vol.shape
        dz, dy, dx = spacing

        lesion_mask = self.get_or_compute_mask(sample_id_or_path, vol, spacing, model_name=model_name)
        overlay_method = self.mask_method_cache.get(f"{sample_id_or_path}:{model_name}") if lesion_mask is not None else None
        idx = np.where(lesion_mask > 0) if lesion_mask is not None else (np.array([]),) * 3
        z_idx, y_idx, x_idx = idx

        if len(z_idx) > 10:
            center = {"axial": int(np.median(z_idx)), "coronal": int(np.median(y_idx)), "sagittal": int(np.median(x_idx))}
            bbox = {
                "z_min": int(np.min(z_idx)), "z_max": int(np.max(z_idx)),
                "y_min": int(np.min(y_idx)), "y_max": int(np.max(y_idx)),
                "x_min": int(np.min(x_idx)), "x_max": int(np.max(x_idx))
            }
        else:
            center = {"axial": z_dim // 2, "coronal": y_dim // 2, "sagittal": x_dim // 2}
            bbox = None

        return {
            "modality": modality,
            "dimensions": {"z": z_dim, "y": y_dim, "x": x_dim},
            "voxel_spacing_mm": {"dz": round(float(dz), 3), "dy": round(float(dy), 3), "dx": round(float(dx), 3)},
            "planes": {
                "axial": {"total_slices": z_dim, "default_slice": center["axial"], "label": "轴位 (横断面 Axial)"},
                "coronal": {"total_slices": y_dim, "default_slice": center["coronal"], "label": "冠状位 (额状面 Coronal)"},
                "sagittal": {"total_slices": x_dim, "default_slice": center["sagittal"], "label": "矢状位 (矢状面 Sagittal)"}
            },
            "center_slice": center,
            "bounding_box": bbox,
            "overlay_model": model_name if lesion_mask is not None else None,
            "overlay_method": overlay_method,
            "recommended_windows": ["lung", "mediastinum", "abdomen", "bone"] if str(modality).upper() == "CT" else [],
        }

    def _render_mpr_png(
        self,
        raw_slice: np.ndarray,
        overlays: List[Tuple[np.ndarray, Tuple[int, int, int, int]]],
        v_spacing: float,
        h_spacing: float,
        window_preset: str,
        hud: List[str],
    ) -> Tuple[bytes, int, int, float, float]:
        """窗宽窗位 + 叠加 + 物理比例重采样 + 比例尺 + HUD，返回 (png, 宽, 高, 水平间距, 竖直间距)。"""
        ct_uint8 = apply_ct_window(np.ascontiguousarray(raw_slice), window_name=window_preset)
        h, w = ct_uint8.shape
        base_img = Image.fromarray(ct_uint8).convert("RGBA")
        over = np.zeros((h, w, 4), dtype=np.uint8)
        any_over = False
        for m, color in overlays:
            mb = np.ascontiguousarray(m) > 0
            if np.any(mb):
                over[mb] = color
                any_over = True
        if any_over:
            base_img = Image.alpha_composite(base_img, Image.fromarray(over, mode="RGBA"))

        # 冠状/矢状位层厚与面内间距不同，按真实毫米比例重采样，避免压扁
        physical_aspect = (h * v_spacing) / max(w * h_spacing, 1e-4)
        target_w = 512
        target_h = max(128, min(1024, int(round(target_w * physical_aspect))))
        if (target_w, target_h) != (w, h):
            base_img = base_img.resize((target_w, target_h), resample=Image.Resampling.BILINEAR)
            h_spacing = (w * h_spacing) / target_w
            v_spacing = (h * v_spacing) / target_h
            w, h = target_w, target_h

        font, supports_cjk = get_cjk_font(13)
        font_sm = get_sans_font(11, bold=True)
        draw = ImageDraw.Draw(base_img)
        scale_bar_mm = 50.0 if w >= 256 else 20.0
        scale_px = int(scale_bar_mm / max(h_spacing, 0.01))
        margin_x = w - scale_px - 15
        margin_y = h - 20
        draw.line([(margin_x, margin_y), (margin_x + scale_px, margin_y)], fill=(255, 255, 255, 220), width=2)
        draw.text((margin_x, margin_y - 14), f"{int(scale_bar_mm / 10)} cm", fill=(255, 255, 255, 220), font=font_sm)
        y_off = 10
        for line in hud:
            draw.text((12, y_off), sanitize_text(line, supports_cjk), fill=(230, 235, 245, 230), font=font)
            y_off += 16

        buf = io.BytesIO()
        base_img.convert("RGB").save(buf, format="PNG", optimize=True)
        return buf.getvalue(), w, h, h_spacing, v_spacing

    def extract_mpr_slice(
        self,
        sample_id_or_path: str,
        plane: str = "axial",
        slice_index: Optional[int] = None,
        window_preset: Optional[str] = None,
        overlay: bool = True,
        model_name: Optional[str] = None
    ) -> Dict[str, Any]:
        """取任一正交截面（放射学显示方向），可叠加指定模型的掩膜；未指定模型不叠加。"""
        vol, spacing, modality = self.load_volume_data(sample_id_or_path)

        plane = (plane or "axial").lower()
        if plane not in ("axial", "coronal", "sagittal"):
            raise ValueError(f"未知截面方向: {plane}")

        mask = self.get_or_compute_mask(sample_id_or_path, vol, spacing, model_name=model_name) if overlay else None
        overlay_method = self.mask_method_cache.get(f"{sample_id_or_path}:{model_name}") if mask is not None else None

        window_defaulted = False
        if not window_preset:
            window_preset = "abdomen"
            window_defaulted = True

        total, v_spacing, h_spacing, plane_label = _plane_geometry(vol.shape, spacing, plane)
        idx = total // 2 if slice_index is None else max(0, min(total - 1, int(slice_index)))
        raw_slice = display_plane_slice(vol, plane, idx)
        mask_slice = display_plane_slice(mask, plane, idx) if mask is not None else None

        lesion_px = int(np.sum(mask_slice > 0)) if mask_slice is not None else 0
        win = CT_WINDOWS.get(window_preset, {"level": 40, "width": 400})
        hud = [
            f"MPR // {plane_label} #{idx}/{total}",
            f"{window_preset.title()} Window (W:{win['width']} L:{win['level']})",
            f"Voxel: {round(h_spacing, 2)}x{round(v_spacing, 2)} mm",
        ]
        if overlay_method:
            hud.append(overlay_method)
        png_bytes, w, h, out_h_spacing, out_v_spacing = self._render_mpr_png(
            raw_slice, [(mask_slice, (255, 77, 79, 110))] if mask_slice is not None else [],
            v_spacing, h_spacing, window_preset, hud,
        )

        return {
            "plane": plane,
            "slice_index": idx,
            "total_slices": total,
            "window": {"preset": window_preset, "level": win["level"], "width": win["width"], "defaulted": window_defaulted},
            "dimensions": {"width": w, "height": h},
            "pixel_spacing_mm": {"horizontal": round(float(out_h_spacing), 3), "vertical": round(float(out_v_spacing), 3)},
            "orientation_labels": _orientation_labels(plane),
            "overlay_model": model_name if mask is not None else None,
            "overlay_method": overlay_method,
            "lesion_present": lesion_px > 0,
            "lesion_pixel_count": lesion_px,
            "lesion_area_mm2": round(lesion_px * float(h_spacing) * float(v_spacing), 1),
            "slice_png_base64": png_to_base64(png_bytes),
            "slice_png_size_bytes": len(png_bytes)
        }

    def extract_diff_slice(
        self,
        baseline_id_or_path: str,
        followup_id_or_path: str,
        plane: str = "axial",
        slice_index: Optional[int] = None,
        window_preset: Optional[str] = None,
        threshold_hu: float = 50.0,
    ) -> Dict[str, Any]:
        """
        基线与随访的逐体素 CT 值差图（随访 − 基线）。
        本函数不做配准：两次扫描的体素网格（形状与间距）必须一致，否则报错；
        即使网格一致，未配准时体位差异也会产生差值，因此只输出「未配准，仅供目视」的差值分布，不给进展/吸收等趋势结论。
        红色 = CT 值升高超过阈值，绿色 = CT 值降低超过阈值。
        """
        if not baseline_id_or_path or not followup_id_or_path:
            raise ValueError("缺少基线或随访影像")
        vol_b, spacing_b, _ = self.load_volume_data(baseline_id_or_path)
        vol_f, spacing_f, _ = self.load_volume_data(followup_id_or_path)
        if vol_f.shape != vol_b.shape or not np.allclose(spacing_b, spacing_f, atol=1e-3):
            raise ValueError(
                f"基线 {vol_b.shape}/{tuple(round(float(s), 3) for s in spacing_b)} 与随访 "
                f"{vol_f.shape}/{tuple(round(float(s), 3) for s in spacing_f)} 体素网格不一致；未配准的体积不能逐体素比较，请先完成配准"
            )

        dz, dy, dx = spacing_b
        voxel_vol_cm3 = (dz * dy * dx) / 1000.0
        diff = vol_f - vol_b
        body_mask = (vol_b > -900.0) | (vol_f > -900.0)
        decreased_3d = (diff < -threshold_hu) & body_mask
        increased_3d = (diff > threshold_hu) & body_mask

        n_dec = int(np.sum(decreased_3d))
        n_inc = int(np.sum(increased_3d))

        plane = (plane or "axial").lower()
        if plane not in ("axial", "coronal", "sagittal"):
            raise ValueError(f"未知截面方向: {plane}")
        window_defaulted = False
        if not window_preset:
            window_preset = "abdomen"
            window_defaulted = True

        total, v_spacing, h_spacing, plane_label = _plane_geometry(vol_b.shape, spacing_b, plane)
        idx = total // 2 if slice_index is None else max(0, min(total - 1, int(slice_index)))
        raw_slice = display_plane_slice(vol_f, plane, idx)
        dec_slice = display_plane_slice(decreased_3d, plane, idx)
        inc_slice = display_plane_slice(increased_3d, plane, idx)

        win = CT_WINDOWS.get(window_preset, {"level": 40, "width": 400})
        hud = [
            f"体素差值（未配准，仅供目视）// {plane_label} #{idx}/{total}",
            f"{window_preset.title()} (W:{win['width']} L:{win['level']}) · 阈值 ±{int(threshold_hu)} HU",
            "红: CT 值升高  绿: CT 值降低",
        ]
        png_bytes, w, h, out_h_spacing, out_v_spacing = self._render_mpr_png(
            raw_slice, [(dec_slice, (16, 185, 129, 140)), (inc_slice, (239, 68, 68, 140))],
            v_spacing, h_spacing, window_preset, hud,
        )

        return {
            "plane": plane,
            "slice_index": idx,
            "total_slices": total,
            "registered": False,
            "registration_note": "未配准，仅供目视：差值同时包含体位/呼吸差异，不能据此判断病灶进展或吸收",
            "window": {"preset": window_preset, "level": win["level"], "width": win["width"], "defaulted": window_defaulted},
            "dimensions": {"width": w, "height": h},
            "pixel_spacing_mm": {"horizontal": round(float(out_h_spacing), 3), "vertical": round(float(out_v_spacing), 3)},
            "orientation_labels": _orientation_labels(plane),
            "threshold_hu": threshold_hu,
            "statistics_3d": {
                "hu_increased_voxels": n_inc,
                "hu_decreased_voxels": n_dec,
                "hu_increased_volume_cm3": round(n_inc * voxel_vol_cm3, 2),
                "hu_decreased_volume_cm3": round(n_dec * voxel_vol_cm3, 2),
            },
            "slice_metrics": {
                "hu_increased_pixels": int(np.sum(inc_slice)),
                "hu_decreased_pixels": int(np.sum(dec_slice)),
            },
            "slice_png_base64": png_to_base64(png_bytes),
            "slice_png_size_bytes": len(png_bytes)
        }

    def extract_radiomics(
        self,
        sample_id_or_path: Optional[str] = None,
        volume: Optional[np.ndarray] = None,
        mask: Optional[np.ndarray] = None,
        spacing: Optional[Tuple[float, float, float]] = None,
        model_name: Optional[str] = None,
        num_bins: int = 16,
        mask_id_or_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        影像组学特征。掩膜必须来自调用方：直接传入 mask、给出掩膜文件/样本（mask_id_or_path），
        或指定 model_name 使用本引擎已为该影像计算并缓存的分割结果。三者都没有就报错，不用阈值临时造掩膜。
        """
        if volume is None:
            if not sample_id_or_path:
                raise ValueError("缺少影像：请提供 sample_id / file_path 或直接传入体积")
            volume, detected_spacing, _ = self.load_volume_data(sample_id_or_path)
            if spacing is None:
                spacing = detected_spacing
        if spacing is None:
            raise ValueError("缺少体素间距 spacing")

        mask_source = "caller_array"
        if mask is None and mask_id_or_path:
            m_vol, m_spacing, _ = self.load_volume_data(mask_id_or_path)
            if m_vol.shape != volume.shape:
                raise ValueError(f"掩膜网格 {m_vol.shape} 与影像 {volume.shape} 不一致")
            mask = (m_vol > 0.5).astype(np.uint8)
            mask_source = f"mask_file:{mask_id_or_path}"
        if mask is None and model_name and sample_id_or_path:
            cache_key = f"{sample_id_or_path}:{model_name}"
            cached = self.mask_cache.get(cache_key)
            if cached is not None and cached.shape == volume.shape:
                mask = cached
                mask_source = f"cached_segmentation:{model_name}"
        if mask is None:
            raise ValueError("缺少 ROI 掩膜：请提供掩膜文件，或先用指定模型对该影像完成分割")
        if not np.any(mask):
            raise ValueError("ROI 掩膜为空，无法计算影像组学特征")

        res = extract_radiomics_features(volume=volume, mask=mask, spacing=spacing, num_bins=num_bins)
        if isinstance(res, dict):
            res["mask_source"] = mask_source
        return res

    def run_interactive_segmentation(
        self,
        sample_id_or_path: Optional[str] = None,
        volume: Optional[np.ndarray] = None,
        spacing: Optional[Tuple[float, float, float]] = None,
        points: Optional[List[Dict[str, Any]]] = None,
        bbox: Optional[Dict[str, int]] = None,
        current_mask: Optional[np.ndarray] = None,
        window_preset: Optional[str] = "lung",
        plane: str = "axial",
        slice_index: Optional[int] = None,
        mode: str = "hu_likelihood_gradient",
    ) -> Dict[str, Any]:
        """
        交互式种子点分割（interactive.interactive_segment_3d 的 HU 区域生长，不是 VISTA-3D 模型）：
        根据正/负提示点与可选外接盒得到 3D 掩膜，计算径线与体积，并渲染关键层面。
        window_preset 为 lung/mediastinum 时以阈值法肺实质包络作为生长约束。
        """
        modality = "CT"
        if volume is None:
            if not sample_id_or_path:
                raise ValueError("缺少影像：请提供 sample_id / file_path 或直接传入体积")
            volume, detected_spacing, modality = self.load_volume_data(sample_id_or_path)
            if spacing is None:
                spacing = detected_spacing
        if spacing is None:
            raise ValueError("缺少体素间距 spacing")
        if not points and not bbox:
            raise ValueError("交互分割需要至少一个提示点或外接盒")

        anatomical_prior = None
        if window_preset in ("lung", "mediastinum"):
            try:
                from .totalsegmentator import extract_anatomical_compartments_3d
            except (ImportError, ValueError):
                from totalsegmentator import extract_anatomical_compartments_3d
            comps = extract_anatomical_compartments_3d(volume, spacing=spacing)
            if np.any(comps.get("lung_parenchyma", False)):
                anatomical_prior = comps["lung_parenchyma"] & (~comps["bone_skeleton"])

        seg_res = interactive_segment_3d(
            volume=volume,
            spacing=spacing,
            points=points,
            bbox=bbox,
            current_mask=current_mask,
            mode=mode,
            anatomical_prior=anatomical_prior,
        )

        mask = seg_res["mask"]
        recist = calculate_recist_metrics(mask, spacing=spacing)
        key_slice_idx = slice_index if slice_index is not None else seg_res["key_slice_index"]
        key_slice_idx = int(np.clip(key_slice_idx, 0, volume.shape[0] - 1))

        ct_windowed = apply_ct_window(volume, window_name=window_preset or "lung")
        png_bytes = render_key_slice_png(
            ct_slice_uint8=ct_windowed[key_slice_idx],
            mask_slice_2d=mask[key_slice_idx],
            recist=recist,
            modality=f"{modality} ({(window_preset or 'lung').title()} Window)",
            lesion_name="交互式种子点区域 (HU 区域生长)",
            scale_bar_mm=50.0,
            pixel_spacing_mm=spacing[2],
            prompt_points=points,
            method_label="Interactive HU region growing",
        )

        ld = recist.get("longest_diameter_mm")
        return {
            "status": "success",
            "model_name": "interactive_region_growing",
            "engine_type": "rule_based",
            "method": "interactive.interactive_segment_3d：种子点 CT 值自适应窗口的区域生长（非 VISTA-3D 模型）",
            "engine_mode": seg_res.get("engine_mode", mode),
            "voxel_count": seg_res["voxel_count"],
            "volume_cm3": seg_res["volume_cm3"],
            "key_slice_index": key_slice_idx,
            "target_hu": seg_res["target_hu"],
            "tolerance_hu": seg_res["tolerance_hu"],
            "positive_prompts_count": seg_res["positive_prompts_count"],
            "negative_prompts_count": seg_res["negative_prompts_count"],
            "recist_metrics": recist,
            "slice_png_base64": png_to_base64(png_bytes),
            "slice_png_size_bytes": len(png_bytes),
            "summary_markdown": (
                f"**交互式种子点分割（HU 区域生长）**\n"
                f"- **提示点**: 正样本 `{seg_res['positive_prompts_count']}` 个，负样本 `{seg_res['negative_prompts_count']}` 个\n"
                f"- **生长灰度范围**: `{seg_res['target_hu']} ± {seg_res['tolerance_hu']} HU`\n"
                f"- **分割体积**: `{seg_res['volume_cm3']} cm³`（{seg_res['voxel_count']} 个体素）\n"
                f"- **关键层面最大长径**: `{_fmt(ld, 'mm')}`（垂直短径 `{_fmt(recist.get('short_axis_mm'), 'mm')}`）\n"
                f"- **显示层面**: 第 `#{key_slice_idx}` 层"
            )
        }


def _orientation_labels(plane: str) -> Dict[str, str]:
    try:
        from .spatial_canonicalizer import get_radiological_orientation_labels
    except (ImportError, ValueError):
        from spatial_canonicalizer import get_radiological_orientation_labels
    return get_radiological_orientation_labels(plane)
