import io
import os
import time
import numpy as np
import torch
from typing import Dict, Any, Tuple, Optional, List
from PIL import Image, ImageDraw, ImageFont
import scipy.ndimage as ndi
from scipy.ndimage import label, binary_dilation, binary_fill_holes, find_objects, sum as ndimage_sum

try:
    from .device import get_optimal_device, get_device_info
    from .dicom_io import apply_ct_window
    from .renderer import png_to_base64
except (ImportError, ValueError):
    from device import get_optimal_device, get_device_info
    from dicom_io import apply_ct_window
    from renderer import png_to_base64


try:
    from .font_utils import get_cjk_font, get_sans_font, sanitize_text
except (ImportError, ValueError):
    from font_utils import get_cjk_font, get_sans_font, sanitize_text


TOTAL_SEGMENTATOR_CLASSES = {
    # 1. 内脏器官 (Visceral Organs - 24 类)
    "spleen": {"zh": "脾脏", "group": "organs", "color": (168, 85, 247, 120)},
    "kidney_right": {"zh": "右肾", "group": "organs", "color": (234, 88, 12, 120)},
    "kidney_left": {"zh": "左肾", "group": "organs", "color": (234, 88, 12, 120)},
    "gallbladder": {"zh": "胆囊", "group": "organs", "color": (34, 197, 94, 120)},
    "liver": {"zh": "肝脏", "group": "organs", "color": (16, 185, 129, 120)},
    "stomach": {"zh": "胃", "group": "organs", "color": (217, 70, 239, 120)},
    "pancreas": {"zh": "胰腺", "group": "organs", "color": (245, 158, 11, 120)},
    "adrenal_gland_right": {"zh": "右侧肾上腺", "group": "organs", "color": (251, 191, 36, 120)},
    "adrenal_gland_left": {"zh": "左侧肾上腺", "group": "organs", "color": (251, 191, 36, 120)},
    "lung_upper_lobe_left": {"zh": "左肺上叶", "group": "organs", "color": (56, 189, 248, 110)},
    "lung_lower_lobe_left": {"zh": "左肺下叶", "group": "organs", "color": (14, 165, 233, 110)},
    "lung_upper_lobe_right": {"zh": "右肺上叶", "group": "organs", "color": (56, 189, 248, 110)},
    "lung_middle_lobe_right": {"zh": "右肺中叶", "group": "organs", "color": (2, 132, 199, 110)},
    "lung_lower_lobe_right": {"zh": "右肺下叶", "group": "organs", "color": (14, 165, 233, 110)},
    "esophagus": {"zh": "食管", "group": "organs", "color": (244, 63, 94, 120)},
    "trachea": {"zh": "主气管", "group": "organs", "color": (125, 211, 252, 120)},
    "thyroid_gland": {"zh": "甲状腺", "group": "organs", "color": (236, 72, 153, 120)},
    "small_bowel": {"zh": "小肠", "group": "organs", "color": (249, 115, 22, 110)},
    "duodenum": {"zh": "十二指肠", "group": "organs", "color": (251, 146, 60, 110)},
    "colon": {"zh": "结肠", "group": "organs", "color": (180, 83, 9, 110)},
    "urinary_bladder": {"zh": "膀胱", "group": "organs", "color": (250, 204, 21, 120)},
    "prostate": {"zh": "前列腺", "group": "organs", "color": (192, 132, 252, 120)},
    "heart": {"zh": "心脏/心室", "group": "organs", "color": (239, 68, 68, 130)},

    # 2. 脊柱椎体 (Vertebrae - 26 类: C1-C7, T1-T12, L1-L5, Sacrum, Coccyx)
    **{f"vertebrae_C{i}": {"zh": f"颈椎 C{i}", "group": "vertebrae", "color": (254, 240, 138, 140)} for i in range(1, 8)},
    **{f"vertebrae_T{i}": {"zh": f"胸椎 T{i}", "group": "vertebrae", "color": (253, 224, 71, 140)} for i in range(1, 13)},
    **{f"vertebrae_L{i}": {"zh": f"腰椎 L{i}", "group": "vertebrae", "color": (250, 204, 21, 150)} for i in range(1, 6)},
    "sacrum": {"zh": "骶骨", "group": "vertebrae", "color": (234, 179, 8, 140)},
    "coccyx": {"zh": "尾骨", "group": "vertebrae", "color": (202, 138, 4, 140)},

    # 3. 骨骼系统 (Bones - 28 类)
    "hip_left": {"zh": "左侧髋骨", "group": "bones", "color": (254, 249, 195, 140)},
    "hip_right": {"zh": "右侧髋骨", "group": "bones", "color": (254, 249, 195, 140)},
    "femur_left": {"zh": "左侧股骨", "group": "bones", "color": (254, 240, 138, 140)},
    "femur_right": {"zh": "右侧股骨", "group": "bones", "color": (254, 240, 138, 140)},
    "clavicula_left": {"zh": "左侧锁骨", "group": "bones", "color": (254, 240, 138, 140)},
    "clavicula_right": {"zh": "右侧锁骨", "group": "bones", "color": (254, 240, 138, 140)},
    "scapula_left": {"zh": "左侧肩胛骨", "group": "bones", "color": (254, 240, 138, 140)},
    "scapula_right": {"zh": "右侧肩胛骨", "group": "bones", "color": (254, 240, 138, 140)},
    "sternum": {"zh": "胸骨", "group": "bones", "color": (253, 224, 71, 140)},
    **{f"rib_left_{i}": {"zh": f"左侧第{i}肋骨", "group": "bones", "color": (254, 249, 195, 130)} for i in range(1, 13)},
    **{f"rib_right_{i}": {"zh": f"右侧第{i}肋骨", "group": "bones", "color": (254, 249, 195, 130)} for i in range(1, 13)},
    "skull": {"zh": "颅骨", "group": "bones", "color": (254, 240, 138, 140)},

    # 4. 肌少症核心肌群 (Skeletal Muscle & Sarcopenia - 14 类)
    "gluteus_maximus_left": {"zh": "左侧臀大肌", "group": "muscles", "color": (239, 68, 68, 120)},
    "gluteus_maximus_right": {"zh": "右侧臀大肌", "group": "muscles", "color": (239, 68, 68, 120)},
    "gluteus_medius_left": {"zh": "左侧臀中肌", "group": "muscles", "color": (248, 113, 113, 120)},
    "gluteus_medius_right": {"zh": "右侧臀中肌", "group": "muscles", "color": (248, 113, 113, 120)},
    "gluteus_minimus_left": {"zh": "左侧臀小肌", "group": "muscles", "color": (252, 165, 165, 120)},
    "gluteus_minimus_right": {"zh": "右侧臀小肌", "group": "muscles", "color": (252, 165, 165, 120)},
    "autochthon_left": {"zh": "左侧竖脊肌", "group": "muscles", "color": (220, 38, 38, 120)},
    "autochthon_right": {"zh": "右侧竖脊肌", "group": "muscles", "color": (220, 38, 38, 120)},
    "iliopsoas_left": {"zh": "左侧髂腰肌", "group": "muscles", "color": (185, 28, 28, 120)},
    "iliopsoas_right": {"zh": "右侧髂腰肌", "group": "muscles", "color": (185, 28, 28, 120)},
    "psoas_major_left": {"zh": "左侧腰大肌", "group": "muscles", "color": (239, 68, 68, 140)},
    "psoas_major_right": {"zh": "右侧腰大肌", "group": "muscles", "color": (239, 68, 68, 140)},
    "rectus_abdominis_left": {"zh": "左侧腹直肌", "group": "muscles", "color": (248, 113, 113, 120)},
    "rectus_abdominis_right": {"zh": "右侧腹直肌", "group": "muscles", "color": (248, 113, 113, 120)},

    # 5. 大血管系统 (Vessels - 8 类)
    "aorta": {"zh": "主动脉", "group": "vessels", "color": (225, 29, 72, 130)},
    "inferior_vena_cava": {"zh": "下腔静脉", "group": "vessels", "color": (37, 99, 235, 130)},
    "portal_vein_and_splenic_vein": {"zh": "门静脉与脾静脉", "group": "vessels", "color": (59, 130, 246, 130)},
    "iliac_artery_left": {"zh": "左侧髂总动脉", "group": "vessels", "color": (225, 29, 72, 120)},
    "iliac_artery_right": {"zh": "右侧髂总动脉", "group": "vessels", "color": (225, 29, 72, 120)},
    "iliac_vena_left": {"zh": "左侧髂总静脉", "group": "vessels", "color": (37, 99, 235, 120)},
    "iliac_vena_right": {"zh": "右侧髂总静脉", "group": "vessels", "color": (37, 99, 235, 120)},
    "pulmonary_artery": {"zh": "肺动脉干", "group": "vessels", "color": (99, 102, 241, 130)},

    # 6. 脂肪组织表征 (Adipose Tissue Compartments - 2 类: 用于 VAT/SAT 比值与肌少性肥胖评价)
    "visceral_adipose_tissue": {"zh": "内脏脂肪 (VAT)", "group": "adipose", "color": (234, 179, 8, 110)},
    "subcutaneous_adipose_tissue": {"zh": "皮下脂肪 (SAT)", "group": "adipose", "color": (56, 189, 248, 100)},
}


def generate_synthetic_whole_body_ct(
    shape: Tuple[int, int, int] = (64, 128, 128),
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8)
) -> Tuple[np.ndarray, Dict[str, np.ndarray]]:
    """
    Synthesizes a realistic 3D whole-body / thoraco-abdominal CT dataset with HU calibrations:
    - Air background: -1000 HU
    - Subcutaneous Adipose Tissue (SAT): -110 HU
    - Abdominal wall & Psoas skeletal muscle: +45 HU
    - Visceral Adipose Tissue (VAT): -95 HU
    - L3 lumbar vertebra and posterior spine: +450 HU
    - Liver parenchymal organ: +60 HU
    - Spleen: +48 HU
    - Bilateral kidneys: +38 HU
    - Aorta: +42 HU
    """
    z_dim, y_dim, x_dim = shape
    volume = np.full(shape, -1000.0, dtype=np.float32)

    z_coords, y_coords, x_coords = np.meshgrid(
        np.arange(z_dim), np.arange(y_dim), np.arange(x_dim), indexing="ij"
    )
    cy, cx = y_dim // 2, x_dim // 2

    # 1. Outer Body Contour (Ellipsoid)
    body_mask = ((y_coords - cy) / (y_dim * 0.45))**2 + ((x_coords - cx) / (x_dim * 0.45))**2 <= 1.0

    # 2. Subcutaneous Adipose Tissue (SAT: outer layer)
    inner_wall = ((y_coords - cy) / (y_dim * 0.38))**2 + ((x_coords - cx) / (x_dim * 0.38))**2 <= 1.0
    sat_mask = body_mask & (~inner_wall)
    volume[sat_mask] = -110.0 + np.random.normal(0, 10, int(np.sum(sat_mask)))

    # 3. Skeletal Muscle Ring (Abdominal Wall & Posterior back muscles)
    peritoneal_cavity = ((y_coords - cy) / (y_dim * 0.33))**2 + ((x_coords - cx) / (x_dim * 0.33))**2 <= 1.0
    muscle_wall_mask = inner_wall & (~peritoneal_cavity)

    # Psoas major muscles bilateral to spine in peritoneal retroperitoneum
    spine_y = cy + int(y_dim * 0.16)
    psoas_left = ((y_coords - spine_y) / (y_dim * 0.08))**2 + ((x_coords - (cx - int(x_dim * 0.12))) / (x_dim * 0.07))**2 <= 1.0
    psoas_right = ((y_coords - spine_y) / (y_dim * 0.08))**2 + ((x_coords - (cx + int(x_dim * 0.12))) / (x_dim * 0.07))**2 <= 1.0
    muscle_mask = (muscle_wall_mask | psoas_left | psoas_right) & body_mask
    volume[muscle_mask] = 45.0 + np.random.normal(0, 8, int(np.sum(muscle_mask)))

    # 4. Visceral Adipose Tissue (VAT inside peritoneal cavity)
    vat_mask = peritoneal_cavity & (~muscle_mask)
    volume[vat_mask] = -95.0 + np.random.normal(0, 12, int(np.sum(vat_mask)))

    # 5. Spine & L3 Vertebra (Bones)
    spine_mask = ((y_coords - spine_y) / (y_dim * 0.09))**2 + ((x_coords - cx) / (x_dim * 0.09))**2 <= 1.0
    volume[spine_mask] = 450.0 + np.random.normal(0, 40, int(np.sum(spine_mask)))

    # 6. Liver in right upper/mid quadrant (Observer left: x < cx)
    liver_z = (z_coords >= int(z_dim * 0.35)) & (z_coords <= int(z_dim * 0.75))
    liver_mask = liver_z & (((y_coords - (cy - int(y_dim * 0.08))) / (y_dim * 0.18))**2 + ((x_coords - (cx - int(x_dim * 0.16))) / (x_dim * 0.14))**2 <= 1.0)
    liver_mask = liver_mask & (~spine_mask) & (~muscle_mask)
    volume[liver_mask] = 60.0 + np.random.normal(0, 9, int(np.sum(liver_mask)))

    # 7. Spleen in left upper quadrant (Observer right: x > cx)
    spleen_z = (z_coords >= int(z_dim * 0.40)) & (z_coords <= int(z_dim * 0.65))
    spleen_mask = spleen_z & (((y_coords - (cy - int(y_dim * 0.06))) / (y_dim * 0.11))**2 + ((x_coords - (cx + int(x_dim * 0.18))) / (x_dim * 0.10))**2 <= 1.0)
    spleen_mask = spleen_mask & (~spine_mask) & (~muscle_mask) & (~liver_mask)
    volume[spleen_mask] = 48.0 + np.random.normal(0, 8, int(np.sum(spleen_mask)))

    # 8. Bilateral Kidneys
    kidney_z = (z_coords >= int(z_dim * 0.25)) & (z_coords <= int(z_dim * 0.50))
    kidney_r_mask = kidney_z & (((y_coords - (cy + int(y_dim * 0.05))) / (y_dim * 0.08))**2 + ((x_coords - (cx - int(x_dim * 0.15))) / (x_dim * 0.06))**2 <= 1.0)
    kidney_l_mask = kidney_z & (((y_coords - (cy + int(y_dim * 0.05))) / (y_dim * 0.08))**2 + ((x_coords - (cx + int(x_dim * 0.15))) / (x_dim * 0.06))**2 <= 1.0)
    kidney_r_mask = kidney_r_mask & (~spine_mask) & (~muscle_mask)
    kidney_l_mask = kidney_l_mask & (~spine_mask) & (~muscle_mask)
    volume[kidney_r_mask] = 38.0 + np.random.normal(0, 7, int(np.sum(kidney_r_mask)))
    volume[kidney_l_mask] = 38.0 + np.random.normal(0, 7, int(np.sum(kidney_l_mask)))

    # 9. Abdominal Aorta
    aorta_mask = ((y_coords - (cy + int(y_dim * 0.04))) / (y_dim * 0.04))**2 + ((x_coords - (cx - int(x_dim * 0.03))) / (x_dim * 0.04))**2 <= 1.0
    aorta_mask = aorta_mask & (~spine_mask)
    volume[aorta_mask] = 42.0 + np.random.normal(0, 6, int(np.sum(aorta_mask)))

    masks = {
        "sat": sat_mask.astype(np.uint8),
        "muscle": muscle_mask.astype(np.uint8),
        "vat": vat_mask.astype(np.uint8),
        "spine": spine_mask.astype(np.uint8),
        "liver": liver_mask.astype(np.uint8),
        "spleen": spleen_mask.astype(np.uint8),
        "kidney_right": kidney_r_mask.astype(np.uint8),
        "kidney_left": kidney_l_mask.astype(np.uint8),
        "aorta": aorta_mask.astype(np.uint8),
    }

    return volume, masks


def analyze_whole_body_ct(
    volume: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
    patient_sex: Optional[str] = None,
    patient_height_m: Optional[float] = None,
    patient_weight_kg: Optional[float] = None,
    l3_slice_index: Optional[int] = None
) -> Dict[str, Any]:
    """
    HU 阈值法体成分分析（非 TotalSegmentator 神经网络模型）：
    - 骨骼肌 / 内脏脂肪 / 皮下脂肪按 HU 区间划分；未给 L3 层号时取下段骨像素最多的一层（启发式选层，未做椎体识别）。
    - SMI 需要身高、肌少症判定需要性别；缺失时不代入缺省值，相应结果为空。
    - 阈值法分不开肝、脾、肾，不输出这些器官体积；肺容积用质控模块的双肺分割计算。
    """
    t0 = time.time()
    z_dim, y_dim, x_dim = volume.shape
    device = get_optimal_device()
    dev_info = get_device_info()

    pixel_area_cm2 = (spacing[1] * spacing[2]) / 100.0
    voxel_vol_cm3 = (spacing[0] * spacing[1] * spacing[2]) / 1000.0

    # 1. 3D Body segmentation & Tissue classification
    # Body contour mask (HU > -700)
    body_mask = volume > -700.0
    # Bones (HU > 200)
    bone_mask = (volume > 200.0) & body_mask
    # Fat tissues (HU -190 to -30)
    fat_mask = (volume >= -190.0) & (volume <= -30.0) & body_mask
    # Muscle tissues (HU -29 to +150)
    skeletal_muscle_mask = (volume >= -29.0) & (volume <= 150.0) & body_mask & (~bone_mask)

    # 2. Automatically locate the L3 vertebral level
    # In standard CT, L3 is situated in the mid-lower lumbar section
    if l3_slice_index is None or l3_slice_index < 0 or l3_slice_index >= z_dim:
        # Locate slice with prominent spine and psoas muscles in the lower third
        lower_bound = int(z_dim * 0.20)
        upper_bound = int(z_dim * 0.60)
        bone_slice_counts = [np.sum(bone_mask[z]) for z in range(lower_bound, upper_bound)]
        if len(bone_slice_counts) > 0 and np.max(bone_slice_counts) > 0:
            l3_slice_index = lower_bound + int(np.argmax(bone_slice_counts))
        else:
            l3_slice_index = z_dim // 2

    # 3. L3 Cross-Sectional Body Composition Quantification (Sarcopenia Assessment)
    l3_slice_ct = volume[l3_slice_index]
    l3_body = body_mask[l3_slice_index]
    l3_bone = bone_mask[l3_slice_index]
    l3_muscle = skeletal_muscle_mask[l3_slice_index]
    l3_fat = fat_mask[l3_slice_index]

    # Distinguish SAT (subcutaneous fat) vs VAT (visceral fat) on L3 slice
    # SAT is on the peripheral outer ring, VAT is surrounded by abdominal wall muscles
    filled_inner = binary_fill_holes(l3_muscle | l3_bone)
    l3_vat = l3_fat & filled_inner & (~l3_bone) & (~l3_muscle)
    l3_sat = l3_fat & (~filled_inner)

    # Metric areas in cm²
    muscle_pixels = int(np.sum(l3_muscle))
    vat_pixels = int(np.sum(l3_vat))
    sat_pixels = int(np.sum(l3_sat))
    bone_pixels = int(np.sum(l3_bone))

    sma_cm2 = round(muscle_pixels * pixel_area_cm2, 2) # Skeletal Muscle Area
    vat_cm2 = round(vat_pixels * pixel_area_cm2, 2)    # Visceral Adipose Tissue
    sat_cm2 = round(sat_pixels * pixel_area_cm2, 2)    # Subcutaneous Adipose Tissue
    tat_cm2 = round(vat_cm2 + sat_cm2, 2)              # Total Adipose Tissue
    vat_to_sat_ratio = round(vat_cm2 / max(sat_cm2, 0.01), 3)

    # Muscle Radiodensity / Attenuation (Mean HU at L3, indicates Myosteatosis)
    muscle_hu_vals = l3_slice_ct[l3_muscle]
    muscle_attenuation_mean_hu: Optional[float] = round(float(np.mean(muscle_hu_vals)), 1) if len(muscle_hu_vals) > 0 else None

    # SMI = SMA / 身高²（cm²/m²）；没有身高就不计算
    smi_val: Optional[float] = None
    if patient_height_m is not None and patient_height_m > 0:
        smi_val = round(sma_cm2 / (patient_height_m * patient_height_m), 2)

    # 不由平台判定肌少症：切点因人群而异，由研究者在分析时自行选择，这里只输出 SMI 数值
    is_sarcopenic: Optional[bool] = None
    sarcopenia_cutoff: Optional[float] = None
    sarcopenia_risk = "未判定（平台只提供 SMI 数值，切点由研究者选择）"

    # 肌脂肪浸润：肌肉平均 HU < 40（未按 BMI 分层，近似判断）
    is_myosteatotic: Optional[bool] = bool(muscle_attenuation_mean_hu < 40.0) if muscle_attenuation_mean_hu is not None else None

    sarcopenic_obesity: Optional[bool] = None

    # 4. 器官体积：阈值法无法区分肝、脾、肾，不输出；肺用双肺分割，骨用 >200 HU 阈值
    try:
        from .quality_assurance import segment_lungs
    except (ImportError, ValueError):
        from quality_assurance import segment_lungs
    lung_mask = segment_lungs(volume, voxel_vol_cm3)
    lungs_vol_cm3: Optional[float] = round(float(np.sum(lung_mask) * voxel_vol_cm3), 1) if lung_mask is not None else None
    bones_vol_cm3 = round(int(np.sum(bone_mask)) * voxel_vol_cm3, 1)
    liver_vol_cm3: Optional[float] = None
    spleen_vol_cm3: Optional[float] = None
    kidneys_vol_cm3: Optional[float] = None
    splenomegaly: Optional[bool] = None
    hepatomegaly: Optional[bool] = None

    # 5. Render key L3 axial slice PNG with multi-tissue HUD and color-coded overlays
    png_bytes = render_totalsegmentator_l3_slice(
        slice_ct=l3_slice_ct,
        muscle_mask=l3_muscle,
        vat_mask=l3_vat,
        sat_mask=l3_sat,
        bone_mask=l3_bone,
        l3_index=l3_slice_index,
        total_slices=z_dim,
        sma_cm2=sma_cm2,
        smi_val=smi_val,
        vat_cm2=vat_cm2,
        sat_cm2=sat_cm2,
        vat_to_sat_ratio=vat_to_sat_ratio,
        muscle_hu=muscle_attenuation_mean_hu,
        sarcopenia_risk=sarcopenia_risk,
        is_sarcopenic=is_sarcopenic,
        pixel_spacing_mm=spacing[1]
    )

    elapsed_sec = round(time.time() - t0, 3)

    # 6. Structured Clinical & Radiomics Markdown Report
    report_md = generate_totalsegmentator_report_markdown(
        accelerator=dev_info.get("accelerator", str(device)),
        elapsed_sec=elapsed_sec,
        volume_shape=volume.shape,
        spacing=spacing,
        l3_index=l3_slice_index,
        patient_sex=patient_sex,
        height_m=patient_height_m,
        weight_kg=patient_weight_kg,
        sma_cm2=sma_cm2,
        smi_val=smi_val,
        sarcopenia_cutoff=sarcopenia_cutoff,
        sarcopenia_risk=sarcopenia_risk,
        is_sarcopenic=is_sarcopenic,
        is_myosteatotic=is_myosteatotic,
        sarcopenic_obesity=sarcopenic_obesity,
        vat_cm2=vat_cm2,
        sat_cm2=sat_cm2,
        tat_cm2=tat_cm2,
        vat_to_sat_ratio=vat_to_sat_ratio,
        muscle_hu=muscle_attenuation_mean_hu,
        liver_vol_cm3=liver_vol_cm3,
        spleen_vol_cm3=spleen_vol_cm3,
        kidneys_vol_cm3=kidneys_vol_cm3,
        lungs_vol_cm3=lungs_vol_cm3,
        bones_vol_cm3=bones_vol_cm3,
        splenomegaly=splenomegaly,
        hepatomegaly=hepatomegaly
    )

    return {
        "status": "success",
        "model_name": "whole_body_ct_segmenter",
        "modality": "Whole-Body / Abdominal CT",
        "accelerator": dev_info.get("accelerator", str(device)),
        "inference_duration_sec": elapsed_sec,
        "volume_dimensions": list(volume.shape),
        "voxel_spacing_mm": list(spacing),
        "l3_vertebra_slice_index": l3_slice_index,
        "method": "HU 阈值法体成分分析，非 TotalSegmentator 神经网络模型；L3 层为启发式选层（下段骨像素最多的一层），未做椎体识别",
        "data_warnings": [w for w in [
            None if patient_height_m else "缺身高：未计算 SMI",
                    ] if w],
        "body_composition": {
            "skeletal_muscle_area_cm2": sma_cm2,
            "skeletal_muscle_index_cm2_m2": smi_val,
            "myosteatosis_detected": is_myosteatotic,
            "muscle_radiodensity_hu": muscle_attenuation_mean_hu,
            "visceral_adipose_cm2": vat_cm2,
            "subcutaneous_adipose_cm2": sat_cm2,
            "total_adipose_cm2": tat_cm2,
            "vat_to_sat_ratio": vat_to_sat_ratio,
        },
        "organ_volumetry_cm3": {
            "liver": liver_vol_cm3,
            "spleen": spleen_vol_cm3,
            "kidneys": kidneys_vol_cm3,
            "lungs": lungs_vol_cm3,
            "skeleton_bones": bones_vol_cm3,
            "splenomegaly": splenomegaly,
            "hepatomegaly": hepatomegaly,
            "note": "肝、脾、肾体积需真实器官分割模型，阈值法不计算；骨为 >200 HU 阈值体积（含钙化与对比剂）",
        },
        "key_slice_png_base64": png_to_base64(png_bytes),
        "key_slice_png_size_bytes": len(png_bytes),
        "summary_markdown": report_md
    }


def render_totalsegmentator_l3_slice(
    slice_ct: np.ndarray,
    muscle_mask: np.ndarray,
    vat_mask: np.ndarray,
    sat_mask: np.ndarray,
    bone_mask: np.ndarray,
    l3_index: int,
    total_slices: int,
    sma_cm2: float,
    smi_val: Optional[float],
    vat_cm2: float,
    sat_cm2: float,
    vat_to_sat_ratio: float,
    muscle_hu: Optional[float],
    sarcopenia_risk: str,
    is_sarcopenic: Optional[bool],
    pixel_spacing_mm: float
) -> bytes:
    """
    Renders an academic publication-ready L3 slice image with multi-tissue color overlay
    (Muscle in Coral, VAT in Amber, SAT in Cyan, Bones in Gold/White) and clinical HUD.
    """
    h, w = slice_ct.shape
    # Soft tissue window (-125 to +225 HU)
    windowed = apply_ct_window(slice_ct, window_name="abdomen")
    base_img = Image.fromarray(windowed).convert("RGBA")

    # Composite Color Overlays
    overlay = np.zeros((h, w, 4), dtype=np.uint8)

    # 1. Muscle: Coral Red (239, 68, 68, 130)
    overlay[muscle_mask > 0] = [239, 68, 68, 130]
    # 2. VAT: Amber/Gold (245, 158, 11, 120)
    overlay[vat_mask > 0] = [245, 158, 11, 120]
    # 3. SAT: Sky Blue/Cyan (56, 189, 248, 110)
    overlay[sat_mask > 0] = [56, 189, 248, 110]
    # 4. Bones: Warm Ivory/Gold (254, 240, 138, 150)
    overlay[bone_mask > 0] = [254, 240, 138, 150]

    overlay_img = Image.fromarray(overlay, mode="RGBA")
    base_img = Image.alpha_composite(base_img, overlay_img)

    draw = ImageDraw.Draw(base_img)
    font_bold = get_sans_font(12, bold=True)
    font_reg = get_sans_font(11, bold=False)
    font_cjk, supports_cjk = get_cjk_font(11)

    # Top-Left HUD Header
    hud_bg = [(8, 8), (280, 112)]
    draw.rounded_rectangle(hud_bg, radius=4, fill=(15, 23, 42, 210), outline=(51, 65, 85, 255))
    draw.text((16, 12), "Body Composition (HU threshold)", font=font_bold, fill=(241, 245, 249, 255))
    draw.text((16, 28), f"Slice: #{l3_index}/{total_slices} (heuristic L3)", font=font_reg, fill=(148, 163, 184, 255))
    draw.text((16, 44), f"Skeletal Muscle (SMA): {sma_cm2} cm2", font=font_reg, fill=(248, 113, 113, 255))
    smi_text = f"{smi_val} cm2/m2" if smi_val is not None else "n/a (height missing)"
    draw.text((16, 60), f"Muscle Index (SMI): {smi_text}", font=font_reg, fill=(251, 146, 60, 255))
    draw.text((16, 76), f"Visceral Fat (VAT): {vat_cm2} cm2 (VAT/SAT: {vat_to_sat_ratio})", font=font_reg, fill=(250, 204, 21, 255))
    status_color = (239, 68, 68, 255) if is_sarcopenic else ((52, 211, 153, 255) if is_sarcopenic is False else (148, 163, 184, 255))
    draw.text((16, 92), "Research use only, no diagnosis", font=font_reg, fill=(148, 163, 184, 255))

    # Top-Right Color Legend
    legend_bg = [(w - 145, 8), (w - 8, 92)]
    draw.rounded_rectangle(legend_bg, radius=4, fill=(15, 23, 42, 210), outline=(51, 65, 85, 255))
    
    legend_items = [
        ("Skeletal Muscle", (239, 68, 68, 255)),
        ("Visceral Fat (VAT)", (245, 158, 11, 255)),
        ("Subcut Fat (SAT)", (56, 189, 248, 255)),
        ("Spine Bone (L3)", (254, 240, 138, 255)),
    ]
    for i, (name, col) in enumerate(legend_items):
        ly = 14 + i * 18
        draw.rectangle([(w - 138, ly + 2), (w - 128, ly + 12)], fill=col)
        draw.text((w - 122, ly), name, font=font_reg, fill=(226, 232, 240, 255))

    # Bottom Scale Bar (5cm = 50mm)
    bar_px = int(50.0 / max(pixel_spacing_mm, 0.1))
    bx = 16
    by = h - 20
    draw.line([(bx, by), (bx + bar_px, by)], fill=(255, 255, 255, 255), width=3)
    draw.line([(bx, by - 4), (bx, by + 4)], fill=(255, 255, 255, 255), width=2)
    draw.line([(bx + bar_px, by - 4), (bx + bar_px, by + 4)], fill=(255, 255, 255, 255), width=2)
    draw.text((bx + bar_px // 2 - 12, by - 14), "5 cm", font=font_reg, fill=(255, 255, 255, 255))

    buf = io.BytesIO()
    base_img.convert("RGB").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def generate_totalsegmentator_report_markdown(
    accelerator: str,
    elapsed_sec: float,
    volume_shape: Tuple[int, int, int],
    spacing: Tuple[float, float, float],
    l3_index: int,
    patient_sex: Optional[str],
    height_m: Optional[float],
    weight_kg: Optional[float],
    sma_cm2: float,
    smi_val: Optional[float],
    sarcopenia_cutoff: Optional[float],
    sarcopenia_risk: str,
    is_sarcopenic: Optional[bool],
    is_myosteatotic: Optional[bool],
    sarcopenic_obesity: Optional[bool],
    vat_cm2: float,
    sat_cm2: float,
    tat_cm2: float,
    vat_to_sat_ratio: float,
    muscle_hu: Optional[float],
    liver_vol_cm3: Optional[float],
    spleen_vol_cm3: Optional[float],
    kidneys_vol_cm3: Optional[float],
    lungs_vol_cm3: Optional[float],
    bones_vol_cm3: Optional[float],
    splenomegaly: Optional[bool],
    hepatomegaly: Optional[bool]
) -> str:
    """生成体成分分析报告（Markdown）。缺失项写「未测得 / 未评估」，不代入典型值。"""
    def fmt(v: Optional[float], unit: str = "") -> str:
        return f"`{v}{(' ' + unit) if unit else ''}`" if v is not None else "未测得"

    sex_text = patient_sex if patient_sex else "未提供"
    height_text = f"{height_m}m" if height_m else "未提供"
    weight_text = f"{weight_kg}kg" if weight_kg else "未提供"
    cutoff_text = f"Prado 切点: {sarcopenia_cutoff} cm²/m²" if sarcopenia_cutoff is not None else "缺性别，未取切点"
    steat_text = "未测得" if is_myosteatotic is None else ("提示肌脂肪浸润 (<40 HU)" if is_myosteatotic else "肌肉密度未见降低")
    obesity_text = "未评估" if sarcopenic_obesity is None else ("提示肌少性肥胖" if sarcopenic_obesity else "未见肌少性肥胖")

    return f"""### 体成分分析报告（HU 阈值法）

> 方法说明：本结果由 HU 阈值划分骨骼肌、内脏脂肪、皮下脂肪得到，**不是 TotalSegmentator 神经网络分割**；L3 层为启发式选层（下段骨像素最多的一层），未做椎体识别，请人工核对层面。仅供科研参考。

- **计算设备**: `{accelerator}`（耗时 `{elapsed_sec}s`）
- **体素维度**: `{volume_shape[0]} 层 × {volume_shape[1]} × {volume_shape[2]}`（层厚 `{spacing[0]}mm`，像素间距 `{spacing[1]} × {spacing[2]}mm`）
- **分析层面**: `#{l3_index}`（启发式 L3） | 性别: {sex_text} | 身高: {height_text} | 体重: {weight_text}

#### 1. 分析层面体成分

| 指标 | 测值 | 参考 / 说明 |
| :--- | :--- | :--- |
| 骨骼肌面积 (SMA) | {fmt(sma_cm2, 'cm²')} | -29 ~ +150 HU |
| 骨骼肌指数 (SMI) | {fmt(smi_val, 'cm²/m²')} | SMA / 身高²；不做肌少症判定，切点由研究者选择 |
| 肌肉平均密度 | {fmt(muscle_hu, 'HU')} | {steat_text} |
| 内脏脂肪面积 (VAT) | {fmt(vat_cm2, 'cm²')} | -190 ~ -30 HU，腹壁肌层以内 |
| 皮下脂肪面积 (SAT) | {fmt(sat_cm2, 'cm²')} | -190 ~ -30 HU，腹壁肌层以外 |
| 脂肪总面积 (TAT) | {fmt(tat_cm2, 'cm²')} | VAT + SAT |
| VAT/SAT | {fmt(vat_to_sat_ratio)} | 内脏 / 皮下脂肪面积比 |

#### 2. 体积

| 结构 | 体积 | 说明 |
| :--- | :--- | :--- |
| 双肺 | {fmt(lungs_vol_cm3, 'cm³')} | 阈值法双肺分割（排除体外空气） |
| 骨 | {fmt(bones_vol_cm3, 'cm³')} | >200 HU 阈值体积，含钙化与对比剂 |
| 肝 / 脾 / 肾 | 未计算 | 阈值法无法区分，需真实器官分割模型 |
"""


def extract_anatomical_compartments_3d(
    volume: np.ndarray,
    spacing: Tuple[float, float, float] = (1.5, 0.8, 0.8),
) -> Dict[str, np.ndarray]:
    """
    Extracts core 3D anatomical organ and structural compartments from CT scans
    using TotalSegmentator standardized anatomical groupings:
    - lung_parenchyma: intrapulmonary bilateral lung volume strictly excluding chest wall/mediastinum
    - bone_skeleton: dense cortical/trabecular skeleton (ribs, spine, sternum, clavicles, scapulae)
    - mediastinum_central: central cardiac and great vessel vascular envelope
    - thoracic_cage: chest wall soft tissues (intercostal muscles, pectoralis, subcutaneous fat)
    """
    z_dim, y_dim, x_dim = volume.shape
    dz, dy, dx = [float(s) for s in spacing]

    # 1. Whole Body Envelope (slice by slice to avoid memory issues and properly fill internal thoracic cavity)
    body_mask = np.zeros(volume.shape, dtype=bool)
    for z in range(z_dim):
        sl = volume[z]
        sl_thresh = sl > -500.0
        if np.sum(sl_thresh) > 100:
            body_mask[z] = binary_fill_holes(sl_thresh)

    # 2. Bone Skeleton (dense cortical & trabecular bone: HU > 200)
    bone_raw = (volume > 200.0) & body_mask
    struct3d = ndi.generate_binary_structure(3, 1)
    bone_skeleton = binary_dilation(bone_raw, structure=struct3d, iterations=1)

    # 3. Lung Parenchyma: 3D intrapulmonary air cavities within body envelope
    lung_air = (volume >= -980.0) & (volume <= -450.0) & body_mask & (~bone_skeleton)
    lbl_air, num_air = label(lung_air)
    lung_parenchyma = np.zeros(volume.shape, dtype=bool)
    if num_air > 0:
        counts = np.bincount(lbl_air.flat)
        counts[0] = 0
        sorted_indices = np.argsort(counts)[::-1]
        for l_idx in sorted_indices[:4]:
            if counts[l_idx] > 1500:
                comp = (lbl_air == l_idx)
                for z in range(z_dim):
                    if np.any(comp[z]):
                        lung_parenchyma[z] |= binary_fill_holes(comp[z])

    # Strictly ensure bone skeleton is excluded
    if np.any(lung_parenchyma):
        lung_parenchyma &= (~bone_skeleton)

    # 4. Central Mediastinum: Anatomical zone between lungs containing heart, aorta, pulmonary trunk
    mediastinum_central = np.zeros(volume.shape, dtype=bool)
    if np.any(lung_parenchyma):
        for z in range(z_dim):
            sl_lung = lung_parenchyma[z]
            if np.sum(sl_lung) > 300:
                hull = binary_fill_holes(sl_lung)
                med_zone = hull & (~sl_lung) & (~bone_skeleton[z])
                # Soft tissue density inside mediastinum (-50 to +160 HU)
                sl_vol = volume[z]
                mediastinum_central[z] = med_zone & (sl_vol >= -50.0) & (sl_vol <= 160.0)

    # 5. Thoracic Cage / Chest Wall: Body mask excluding lungs and mediastinum
    thoracic_cage = body_mask & (~lung_parenchyma) & (~mediastinum_central)

    return {
        "body_mask": body_mask,
        "bone_skeleton": bone_skeleton,
        "lung_parenchyma": lung_parenchyma,
        "mediastinum_central": mediastinum_central,
        "thoracic_cage": thoracic_cage,
    }

