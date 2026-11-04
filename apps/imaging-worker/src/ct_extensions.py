"""
CT 多病种定量分析引擎（PRD 第 5.4 节 / 第 8 节阶段三 T3.2–T3.4）：
1. T3.2 胸部 CT 肺炎 / 间质病变定量与 CTSS（0–25 分）评分；
2. T3.3 胸部 CT 肋骨骨折左右第 1–12 肋编号、解剖段定位与新旧程度（急性/愈合期/陈旧性）判定；
3. T3.4 头颅平扫 CT 急性脑出血（ICH）分型、体素体积与 ABC/2 体积、中线移位（mm）及急诊（stat）优先队列调度。
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple
import numpy as np

LOBE_ORDER: Tuple[str, ...] = ("RUL", "RML", "RLL", "LUL", "LLL")
LOBE_NAMES_ZH: Dict[str, str] = {
    "RUL": "右肺上叶",
    "RML": "右肺中叶",
    "RLL": "右肺下叶",
    "LUL": "左肺上叶",
    "LLL": "左肺下叶",
}


def lobe_ctss_score(involvement_pct: float) -> int:
    """
    按五肺叶受累百分比计算单肺叶 CT 严重度评分（CTSS，0–5 分）：
    - 0%       -> 0 分
    - < 5%     -> 1 分
    - 5%–25%   -> 2 分
    - 26%–49%  -> 3 分（即 >25% 且 <50%）
    - 50%–75%  -> 4 分
    - > 75%    -> 5 分
    """
    pct = float(max(0.0, min(100.0, involvement_pct)))
    if pct <= 0.0:
        return 0
    if pct < 5.0:
        return 1
    if pct <= 25.0:
        return 2
    if pct < 50.0:
        return 3
    if pct <= 75.0:
        return 4
    return 5


def quantify_pneumonia_ctss(
    hu_volume: Optional[np.ndarray] = None,
    lobe_mask: Optional[np.ndarray] = None,
    spacing_mm: Sequence[float] = (1.0, 1.0, 1.0),
    lobe_summary_override: Optional[Dict[str, Dict[str, float]]] = None,
    ggo_hu_range: Tuple[float, float] = (-750.0, -300.0),
    consolidation_hu_range: Tuple[float, float] = (-300.0, 50.0),
) -> Dict[str, Any]:
    """
    计算双肺五肺叶受累比例、磨玻璃影（GGO）与实变影（Consolidation）体积，并汇总 CTSS（0–25 分）。
    支持从 3D 体素数组 (hu_volume + lobe_mask, 1..5 对应 RUL/RML/RLL/LUL/LLL) 计算，
    或直接从各肺叶测量摘要 (lobe_summary_override) 计算。
    """
    voxel_vol_cm3 = float(np.prod(np.asarray(spacing_mm, dtype=np.float64))) / 1000.0
    lobes_out: Dict[str, Dict[str, Any]] = {}
    total_lung_cm3 = 0.0
    total_ggo_cm3 = 0.0
    total_cons_cm3 = 0.0
    total_ctss = 0

    for idx, lobe_code in enumerate(LOBE_ORDER, start=1):
        if lobe_summary_override and lobe_code in lobe_summary_override:
            ov = lobe_summary_override[lobe_code]
            lobe_vol_cm3 = float(ov.get("lobe_volume_cm3", 1000.0))
            ggo_cm3 = float(ov.get("ggo_volume_cm3", 0.0))
            cons_cm3 = float(ov.get("consolidation_volume_cm3", 0.0))
        elif hu_volume is not None and lobe_mask is not None:
            in_lobe = lobe_mask == idx
            n_lobe = int(np.count_nonzero(in_lobe))
            lobe_vol_cm3 = n_lobe * voxel_vol_cm3
            if n_lobe > 0:
                lobe_hu = hu_volume[in_lobe]
                n_ggo = int(np.count_nonzero((lobe_hu >= ggo_hu_range[0]) & (lobe_hu <= ggo_hu_range[1])))
                n_cons = int(np.count_nonzero((lobe_hu > consolidation_hu_range[0]) & (lobe_hu <= consolidation_hu_range[1])))
                ggo_cm3 = n_ggo * voxel_vol_cm3
                cons_cm3 = n_cons * voxel_vol_cm3
            else:
                ggo_cm3 = 0.0
                cons_cm3 = 0.0
        else:
            lobe_vol_cm3 = 0.0
            ggo_cm3 = 0.0
            cons_cm3 = 0.0

        affected_cm3 = min(lobe_vol_cm3, ggo_cm3 + cons_cm3)
        inv_pct = (affected_cm3 / lobe_vol_cm3 * 100.0) if lobe_vol_cm3 > 0 else 0.0
        ggo_pct = (ggo_cm3 / lobe_vol_cm3 * 100.0) if lobe_vol_cm3 > 0 else 0.0
        cons_pct = (cons_cm3 / lobe_vol_cm3 * 100.0) if lobe_vol_cm3 > 0 else 0.0
        score = lobe_ctss_score(inv_pct)

        total_lung_cm3 += lobe_vol_cm3
        total_ggo_cm3 += ggo_cm3
        total_cons_cm3 += cons_cm3
        total_ctss += score

        lobes_out[lobe_code] = {
            "lobe_code": lobe_code,
            "lobe_name_zh": LOBE_NAMES_ZH[lobe_code],
            "lobe_volume_cm3": round(lobe_vol_cm3, 2),
            "ggo_volume_cm3": round(ggo_cm3, 2),
            "consolidation_volume_cm3": round(cons_cm3, 2),
            "affected_volume_cm3": round(affected_cm3, 2),
            "ggo_pct": round(ggo_pct, 2),
            "consolidation_pct": round(cons_pct, 2),
            "involvement_pct": round(inv_pct, 2),
            "ctss_score": score,
        }

    total_affected_cm3 = min(total_lung_cm3, total_ggo_cm3 + total_cons_cm3)
    total_inv_pct = (total_affected_cm3 / total_lung_cm3 * 100.0) if total_lung_cm3 > 0 else 0.0
    if total_ctss == 0:
        severity_band = "none"
    elif total_ctss <= 7:
        severity_band = "mild"
    elif total_ctss <= 17:
        severity_band = "moderate"
    else:
        severity_band = "severe"

    return {
        "task": "pneumonia_ild_ct",
        "total_lung_volume_cm3": round(total_lung_cm3, 2),
        "total_ggo_volume_cm3": round(total_ggo_cm3, 2),
        "total_consolidation_volume_cm3": round(total_cons_cm3, 2),
        "total_affected_volume_cm3": round(total_affected_cm3, 2),
        "total_involvement_pct": round(total_inv_pct, 2),
        "total_ctss": int(total_ctss),
        "ctss_max": 25,
        "severity_reference": severity_band,
        "status_label": "规则推算，待医生确认",
        "requires_confirmation": True,
        "lobes": lobes_out,
    }


def classify_rib_fracture_acuity(
    cortical_gap_mm: float,
    callus_formation_ratio: float,
    margin_sclerosis: bool = False,
) -> Literal["acute", "subacute_healing", "chronic_old"]:
    """
    T3.3 肋骨骨折新旧程度形态学判定：
    - acute（急性骨折）：皮质中断明确（cortical_gap_mm >= 0.4），尚无骨痂形成（callus_formation_ratio < 0.15）且断端无硬化；
    - subacute_healing（亚急性/愈合期骨折）：见骨痂形成（0.15 <= callus_formation_ratio < 0.85）且骨折线尚可见（cortical_gap_mm > 0.1）；
    - chronic_old（陈旧性骨折）：骨性连接/畸形愈合（cortical_gap_mm <= 0.1 或 callus_formation_ratio >= 0.85）或断端硬化明显。
    """
    if cortical_gap_mm <= 0.1 or callus_formation_ratio >= 0.85 or (margin_sclerosis and callus_formation_ratio >= 0.5):
        return "chronic_old"
    if callus_formation_ratio >= 0.15 or margin_sclerosis:
        return "subacute_healing"
    return "acute"


def analyze_rib_fractures(
    candidates: Sequence[Dict[str, Any]],
    confidence_threshold: float = 0.30,
) -> Dict[str, Any]:
    """
    T3.3 胸部 CT 肋骨骨折检出、左右第 1–12 肋自动编号与新旧判定。
    按右侧->左侧、第 1->12 肋、急性->愈合期->陈旧性排序。
    """
    acuity_rank = {"acute": 1, "subacute_healing": 2, "chronic_old": 3}
    acuity_zh = {
        "acute": "急性骨折",
        "subacute_healing": "愈合期骨折（伴骨痂形成）",
        "chronic_old": "陈旧性骨折",
    }
    side_zh = {"right": "右侧", "left": "左侧"}
    arc_zh = {"anterior": "前肋段", "lateral": "腋段/侧肋段", "posterior": "后肋段"}

    kept: List[Dict[str, Any]] = []
    for idx, c in enumerate(candidates, start=1):
        conf = float(c.get("confidence", 0.9))
        if conf < confidence_threshold:
            continue
        side = str(c.get("side", "right")).lower().strip()
        if side not in ("right", "left"):
            raise ValueError(f"Invalid rib side: {side}")
        rib_no = int(c.get("rib_number", 0))
        if rib_no < 1 or rib_no > 12:
            raise ValueError(f"Rib number must be in 1..12, got {rib_no}")
        arc = str(c.get("anatomical_arc", "lateral")).lower().strip()
        if arc not in ("anterior", "lateral", "posterior"):
            arc = "lateral"

        gap_mm = float(c.get("cortical_gap_mm", 1.0))
        callus_ratio = float(c.get("callus_formation_ratio", 0.0))
        sclerosis = bool(c.get("margin_sclerosis", False))
        displacement_mm = float(c.get("displacement_mm", 0.0))
        acuity = c.get("acuity") or classify_rib_fracture_acuity(gap_mm, callus_ratio, sclerosis)

        kept.append({
            "fracture_id": str(c.get("fracture_id") or f"RF-{idx:02d}"),
            "side": side,
            "side_zh": side_zh[side],
            "rib_number": rib_no,
            "anatomical_arc": arc,
            "anatomical_arc_zh": arc_zh[arc],
            "location_code": f"{'R' if side == 'right' else 'L'}-Rib{rib_no}-{arc}",
            "location_zh": f"{side_zh[side]}第 {rib_no} 肋{arc_zh[arc]}",
            "acuity": acuity,
            "acuity_zh": acuity_zh[acuity],
            "cortical_gap_mm": round(gap_mm, 2),
            "callus_formation_ratio": round(callus_ratio, 2),
            "displacement_mm": round(displacement_mm, 2),
            "displaced": displacement_mm >= 2.0,
            "confidence": round(conf, 4),
            "center_lps_mm": list(c.get("center_lps_mm", [0.0, 0.0, 0.0])),
        })

    kept.sort(
        key=lambda x: (
            0 if x["side"] == "right" else 1,
            int(x["rib_number"]),
            acuity_rank.get(x["acuity"], 9),
        )
    )

    counts = {
        "total": len(kept),
        "acute": sum(1 for x in kept if x["acuity"] == "acute"),
        "subacute_healing": sum(1 for x in kept if x["acuity"] == "subacute_healing"),
        "chronic_old": sum(1 for x in kept if x["acuity"] == "chronic_old"),
    }
    return {
        "task": "rib_fracture_ct",
        "counts": counts,
        "fractures": kept,
    }


ICH_SUBTYPES_ZH: Dict[str, str] = {
    "intraparenchymal": "脑实质出血（IPH）",
    "intraventricular": "脑室出血（IVH）",
    "subarachnoid": "蛛网膜下腔出血（SAH）",
    "epidural": "硬膜外血肿（EDH）",
    "subdural": "硬膜下血肿（SDH）",
}


def analyze_head_ct_ich(
    hemorrhages: Sequence[Dict[str, Any]],
    midline_shift_mm: float = 0.0,
    priority: Literal["stat", "routine"] = "stat",
) -> Dict[str, Any]:
    """
    T3.4 头颅平扫 CT 急性脑出血（ICH）分型、出血体积（体素积分 mL 与 ABC/2 mL）、中线移位（mm）与急诊优先通道。
    遵循 PRD 第 6 节安全边界：急诊危急值标记为 `critical_alert_pending_confirmation: True`，须经当班医师确认，AI 不直接发临床警报。
    """
    items: List[Dict[str, Any]] = []
    total_vol_ml = 0.0
    subtypes_present: List[str] = []

    for idx, h in enumerate(hemorrhages, start=1):
        subtype = str(h.get("subtype", "intraparenchymal")).lower().strip()
        if subtype not in ICH_SUBTYPES_ZH:
            raise ValueError(f"Unsupported ICH subtype: {subtype}")
        if subtype not in subtypes_present:
            subtypes_present.append(subtype)

        # 支持直接给定体素体积 volume_ml，或由长轴 a_cm / 正交短轴 b_cm / 层厚和 c_cm 按多田公式 ABC/2 推算
        a_mm = float(h.get("axis_a_mm", 0.0))
        b_mm = float(h.get("axis_b_mm", 0.0))
        c_mm = float(h.get("extent_c_mm", 0.0))
        abc2_ml = round((a_mm * b_mm * c_mm) / 2000.0, 2) if (a_mm > 0 and b_mm > 0 and c_mm > 0) else None
        vol_ml = round(float(h.get("volume_ml", abc2_ml if abc2_ml is not None else 0.0)), 2)
        total_vol_ml += vol_ml

        items.append({
            "lesion_id": str(h.get("lesion_id") or f"ICH-{idx:02d}"),
            "subtype": subtype,
            "subtype_zh": ICH_SUBTYPES_ZH[subtype],
            "hemisphere": str(h.get("hemisphere", "left")),
            "location_zh": str(h.get("location_zh") or "脑内"),
            "volume_ml": vol_ml,
            "abc2_volume_ml": abc2_ml,
            "mean_hu": round(float(h.get("mean_hu", 62.0)), 1),
        })

    mls = round(float(max(0.0, midline_shift_mm)), 2)
    significant_mass_effect = mls >= 5.0 or total_vol_ml >= 30.0
    critical_pending = len(items) > 0 and (significant_mass_effect or "intraventricular" in subtypes_present or "epidural" in subtypes_present)

    return {
        "task": "head_ich_ct",
        "queue_priority": priority,
        "p90_sla_seconds": 60 if priority == "stat" else 300,
        "hemorrhage_detected": len(items) > 0,
        "subtypes_present": subtypes_present,
        "total_volume_ml": round(total_vol_ml, 2),
        "midline_shift_mm": mls,
        "significant_mass_effect": significant_mass_effect,
        "critical_alert_pending_confirmation": critical_pending,
        "status_label": "规则推算，待医生确认",
        "requires_confirmation": True,
        "lesions": items,
    }
