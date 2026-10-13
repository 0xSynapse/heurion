import logging
from typing import Dict, Any, Optional, List

logger = logging.getLogger("heurion.clinical_ai")

# 报告只写影像所见；需要提示时统一用这一句，不给诊断结论、分级与处置建议
INTERPRETATION_NOTE = "上述所见需结合临床与实验室检查判断"

# 患者信息字段：只写调用方实际提供的项，缺失即不写，不代入默认值
_PATIENT_FIELDS = (
    ("sex", "性别"),
    ("age", "年龄"),
    ("smoking_history", "吸烟史"),
    ("symptoms", "症状"),
    ("prior_cancer", "肿瘤既往史"),
)


def _provided_patient_fields(patient_context: Optional[Dict[str, Any]]) -> List[tuple]:
    ctx = patient_context or {}
    out = []
    for key, label in _PATIENT_FIELDS:
        val = ctx.get(key)
        if val is None or (isinstance(val, str) and not val.strip()):
            continue
        out.append((label, val))
    return out


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _emphysema_metrics(features: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """COPD 结果中 LAA% 等量化值位于 emphysema 字段（特征顶层或 recist_metrics 下）。"""
    em = features.get("emphysema")
    if isinstance(em, dict):
        return em
    rm = features.get("recist_metrics")
    if isinstance(rm, dict) and isinstance(rm.get("emphysema"), dict):
        return rm["emphysema"]
    return None


def _measured_finding_sentences(features: Dict[str, Any]) -> List[str]:
    """把结构化特征中实际存在的测量值逐条转成所见描述；没有数据的项不写。"""
    modality = features.get("modality") or "影像"
    target_name = features.get("target_name") or "分割目标"
    phys = features.get("physical_metrics") or {}
    dens = features.get("density_metrics") or {}
    subsolid = features.get("subsolid_metrics") or {}
    qc = features.get("quality_control") or {}
    em = _emphysema_metrics(features)

    sentences: List[str] = []

    if em is not None:
        laa = em.get("laa_percent")
        if _is_num(laa):
            thr = em.get("emphysema_hu_threshold", -950.0)
            parts = []
            if _is_num(em.get("total_lung_volume_liters")):
                parts.append(f"双肺分割容积 {em['total_lung_volume_liters']} L")
            if _is_num(em.get("emphysema_volume_liters")):
                parts.append(f"≤{thr:.0f} HU 低衰减区容积 {em['emphysema_volume_liters']} L")
            parts.append(f"LAA{thr:.0f}% 为 {laa}%")
            if _is_num(em.get("mean_lung_attenuation_hu")):
                parts.append(f"肺平均 CT 值 {em['mean_lung_attenuation_hu']} HU")
            if _is_num(em.get("perc15_hu")):
                parts.append(f"Perc15 {em['perc15_hu']} HU")
            sentences.append(f"{modality} 肺实质低衰减区定量：" + "，".join(parts) + "。")
        elif em.get("error"):
            sentences.append(f"肺实质低衰减区定量未完成：{em['error']}。")

    if not features.get("has_lesion"):
        if not sentences:
            sentences.append(f"{modality} 分割掩膜内未检出目标体素，未做测量。")
        return sentences

    if subsolid.get("is_vessel"):
        reasons = (subsolid.get("vessel_info") or {}).get("reasons") or []
        basis = f"（触发判据：{'；'.join(reasons)}）" if reasons else ""
        key_slice = phys.get("key_slice_index")
        loc = f"关键层为轴位第 #{key_slice} 层，" if key_slice is not None else ""
        sentences.append(
            f"所选目标经启发式判定为疑似血管截面{basis}，{loc}未做结节测量；该判定未经验证，需人工复核。"
        )
        return sentences

    geo = []
    if phys.get("key_slice_index") is not None:
        geo.append(f"最大截面位于轴位第 #{phys['key_slice_index']} 层")
    if _is_num(phys.get("longest_diameter_mm")):
        geo.append(f"该层最大长径 {phys['longest_diameter_mm']} mm")
    if _is_num(phys.get("short_axis_mm")):
        geo.append(f"垂直短径 {phys['short_axis_mm']} mm")
    if _is_num(phys.get("total_volume_cm3")):
        vol = f"三维体积 {phys['total_volume_cm3']} cm³"
        if _is_num(phys.get("total_volume_mm3")):
            vol += f" ({phys['total_volume_mm3']} mm³)"
        geo.append(vol)
    if _is_num(phys.get("craniocaudal_span_mm")):
        geo.append(f"头尾跨度 {phys['craniocaudal_span_mm']} mm")
    if geo:
        sentences.append(f"{modality} 分割目标（{target_name}）：" + "，".join(geo) + "。")

    if _is_num(dens.get("mean_hu")):
        hu = [f"平均 CT 值 {dens['mean_hu']} HU"]
        if _is_num(dens.get("median_hu")):
            hu.append(f"中位数 {dens['median_hu']} HU")
        if _is_num(dens.get("min_hu")) and _is_num(dens.get("max_hu")):
            hu.append(f"范围 {dens['min_hu']} ~ {dens['max_hu']} HU")
        comp = dens.get("composition") or {}
        comp_parts = []
        if _is_num(comp.get("ground_glass_percent")):
            comp_parts.append(f"-950~-300 HU 体素 {comp['ground_glass_percent']}%")
        if _is_num(comp.get("soft_tissue_solid_percent")):
            comp_parts.append(f"-150~130 HU 体素 {comp['soft_tissue_solid_percent']}%")
        if _is_num(comp.get("calcification_percent")):
            comp_parts.append(f"≥130 HU 体素 {comp['calcification_percent']}%")
        text = "掩膜内" + "，".join(hu)
        if comp_parts:
            text += "；" + "，".join(comp_parts)
        sentences.append(text + "。")

    if subsolid:
        sub = []
        if subsolid.get("morphological_type_zh"):
            sub.append(f"按 CT 值阈值的启发式密度分型为「{subsolid['morphological_type_zh']}」")
        if _is_num(subsolid.get("solid_core_diameter_mm")):
            sub.append(f"实性成分最大径 {subsolid['solid_core_diameter_mm']} mm")
        if _is_num(subsolid.get("consolidation_tumor_ratio")):
            sub.append(f"CTR {subsolid['consolidation_tumor_ratio']}")
        if sub:
            sentences.append("，".join(sub) + "。")

    if qc.get("warning"):
        sentences.append(f"质控提示：{qc['warning']}")

    return sentences


def build_clinical_prompt(
    features: Dict[str, Any],
    patient_context: Optional[Dict[str, Any]] = None
) -> str:
    """
    组装供人工或平台受控大模型通道使用的结构化提示：
    只包含调用方实际提供的患者信息与实际计算出的测量值，并要求输出只描述影像所见。
    """
    lines = ["【影像所见整理任务】", "请仅依据下列实测数据描述影像所见。"]

    patient = _provided_patient_fields(patient_context)
    if patient:
        lines.append("")
        lines.append("### 调用方提供的患者信息")
        for label, val in patient:
            lines.append(f"• {label}：{val}")

    qc = features.get("quality_control") or {}
    tech = []
    if features.get("modality"):
        tech.append(f"• 检查模态：{features['modality']}")
    if _is_num(qc.get("slice_thickness_mm")):
        tech.append(f"• 层厚：{qc['slice_thickness_mm']} mm")
    if _is_num(qc.get("voxel_volume_mm3")):
        tech.append(f"• 体素体积：{qc['voxel_volume_mm3']} mm³")
    if tech:
        lines.append("")
        lines.append("### 扫描参数")
        lines.extend(tech)

    lines.append("")
    lines.append("### 实测数据")
    measured = _measured_finding_sentences(features)
    lines.extend(f"• {s}" for s in measured)

    lines.append("")
    lines.append("### 输出要求")
    lines.append("只描述影像所见；不给诊断结论、分级、良恶性判断，不给治疗或随访建议；")
    lines.append("未提供的数据不要推测或补写；")
    lines.append(f"如需提示，统一写「{INTERPRETATION_NOTE}」。")
    return "\n".join(lines)


def describe_measured_findings(features: Dict[str, Any]) -> Dict[str, Any]:
    """
    由实测特征生成影像所见描述（模板拼接，不做诊断推理）。
    没有数据支撑的部位、征象与结论一律不写。
    """
    sentences = _measured_finding_sentences(features)
    return {
        "findings_description": "".join(sentences),
        "interpretation_note": INTERPRETATION_NOTE,
    }


def generate_clinical_ai_report(
    features: Dict[str, Any],
    patient_context: Optional[Dict[str, Any]] = None,
    key_slice_png_base64: Optional[str] = None
) -> Dict[str, Any]:
    """
    第 3 步：影像所见报告。
    由实测特征按模板生成所见描述，并附结构化提示（structured_prompt）。
    本模块不调用外部大模型，不输出诊断结论、分级、风险等级与处置建议。
    key_slice_png_base64 仅为接口兼容保留，本模块不使用。
    """
    report = describe_measured_findings(features)
    report["reasoning_engine"] = "measured_findings_template"
    report["structured_prompt"] = build_clinical_prompt(features, patient_context)
    return report
