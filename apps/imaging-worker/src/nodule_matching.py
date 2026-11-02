"""
随访对比（PRD T2.4 / W3.2）：两期胸部 CT 的结节对应。

不需要两期的体素数据，只用两期结节的病人坐标（DICOM LPS，mm）、平均径、肺叶，以及可选的「肺部锚点」：
1. 肺部锚点（lung_anchor）：分析时顺带从体积里按 CT 值阈值粗分出肺（体内含气区），给出肺的质心、肺尖高度与包围盒。
   不同日期检查的 LPS 坐标原点由扫描床位置决定，两期之间可相差几百毫米；锚点给出两期之间的粗平移。
2. 刚性配准：以结节对为平移假设（有锚点时只取锚点平移 ±ANCHOR_SEARCH_MM 内的假设），按一对一内点数选最优，
   再用内点做迭代最近点（Kabsch 刚性，旋转超过 MAX_ROTATION_DEG 时退回只平移）。医生已确认的对应关系（fixed_pairs）
   作为已知内点参与配准，不再参与指派。
3. 指派：配准后按质心距离做匈牙利指派（scipy.optimize.linear_sum_assignment），距离门限与结节大小相关，
   肺叶不同的加罚分；门限内还有其它候选时标为「有歧义」，给出候选，供医生重新对应。

配准质量（registration.quality）：
- fine：至少 3 个一致的结节对；或 2 个且与锚点一致；或有医生确认的对应关系。
- coarse：只有锚点（或只有 2 个结节对而没有锚点）——对应关系要医生核对。
- none：既没有锚点也没有一致的结节对，按原始坐标比对，结果不可靠，如实说明。
不做形变配准：呼吸幅度不同造成的下叶结节位移由门限吸收，超出时如实给出「新发 / 消失」并标注配准质量。
"""
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy import ndimage as ndi
from scipy.optimize import linear_sum_assignment

# —— 配准参数 ——
# 内点容差：6 mm + 0.5 × 两者较大的平均径（两期独立检出的质心偏差 + 吸气程度不同的位移）
INLIER_BASE_MM = 6.0
INLIER_DIAM_FACTOR = 0.5
# 有锚点时，结节对给出的平移须在锚点平移 ±35 mm 内（锚点的误差主要来自吸气程度不同，肺尖高度一般在 1~2 cm 内）
ANCHOR_SEARCH_MM = 35.0
# 刚性配准允许的最大旋转；超过视为体位差异过大，只做平移
MAX_ROTATION_DEG = 10.0
MAX_HYPOTHESES = 4000
ICP_ITERATIONS = 10

# —— 指派参数 ——
# 门限 = max(10 mm, 1.0 × 两者较大的平均径) + 配准不确定度
GATE_MIN_MM = 10.0
GATE_DIAM_FACTOR = 1.0
# 只有锚点（coarse）时的附加门限
COARSE_EXTRA_MM = 12.0
# 两侧肺叶都已知且不同：代价加 5 mm（不影响门限；肺叶分割在叶间裂附近可能出错，所以不作硬约束）
LOBE_MISMATCH_PENALTY_MM = 5.0
_BIG = 1e6

# —— 肺部锚点参数 ——
ANCHOR_GRID_MM = 4.0
AIR_HU = -500.0
MIN_LUNG_ML = 500.0
MIN_COMPONENT_ML = 100.0
APEX_AREA_MM2 = 1000.0


# ---------------------------------------------------------------------------
# 肺部锚点
# ---------------------------------------------------------------------------
def lung_anchor(volume: np.ndarray, spacing: Sequence[float], geometry: Optional[Dict[str, Any]],
                grid_mm: float = ANCHOR_GRID_MM) -> Dict[str, Any]:
    """
    按 CT 值阈值粗分肺（降采样到约 4 mm）：体表（最大的软组织连通域）逐层填洞后，其中 < -500 HU 的区域为体内含气，
    取体积不小于最大者 15%、且 ≥ 100 ml 的连通域作为肺（含气管；胃泡等小气腔被排除）。
    返回 {ok, centroid_lps_mm, apex_z_mm, base_z_mm, bbox_lps_mm, volume_ml, apex_in_fov, note}；
    体积没有 DICOM 几何或找不到肺时 ok = False 并写明原因。只用于随访对比的粗配准，不作任何测量。
    """
    a = (geometry or {}).get("affine_zyx_to_lps")
    if a is None:
        return {"ok": False, "note": "体积没有 DICOM 病人坐标几何"}
    a = np.asarray(a, dtype=np.float64)
    vol = np.asarray(volume)
    if vol.ndim != 3:
        return {"ok": False, "note": f"需要三维体积，收到 {vol.ndim} 维"}
    sp = [float(s) for s in spacing]
    step = [max(1, int(round(grid_mm / s))) for s in sp]
    v = vol[::step[0], ::step[1], ::step[2]]
    vox_ml = float(np.prod([s * k for s, k in zip(sp, step)])) / 1000.0

    body = v > AIR_HU
    lab, n = ndi.label(body)
    if n == 0:
        return {"ok": False, "note": "找不到体表"}
    sizes = ndi.sum(body, lab, index=np.arange(1, n + 1))
    body = lab == (int(np.argmax(sizes)) + 1)
    filled = np.zeros_like(body)
    for k in range(body.shape[0]):
        filled[k] = ndi.binary_fill_holes(body[k])
    air = (v <= AIR_HU) & filled
    lab, n = ndi.label(air)
    if n == 0:
        return {"ok": False, "note": "体内没有含气区域"}
    sizes = ndi.sum(air, lab, index=np.arange(1, n + 1)) * vox_ml
    keep = [i + 1 for i, s in enumerate(sizes) if s >= max(MIN_COMPONENT_ML, 0.15 * float(sizes.max()))]
    lungs = np.isin(lab, keep)
    volume_ml = float(lungs.sum()) * vox_ml
    if volume_ml < MIN_LUNG_ML:
        return {"ok": False, "note": f"体内含气区域只有 {volume_ml:.0f} ml，可能不是胸部 CT 或肺未包全"}

    idx = np.argwhere(lungs).astype(np.float64) * np.asarray(step, dtype=np.float64)
    lps = idx @ a[:3, :3].T + a[:3, 3]
    z = lps[:, 2]
    centroid = lps.mean(axis=0)
    # 肺尖：从头侧往下第一层含气面积 ≥ 10 cm² 的轴位层（气管约 2~3 cm²，不算）；
    # 最头侧一层的含气面积就已 ≥ 10 cm² 时，肺尖不在扫描范围内
    area = lungs.reshape(lungs.shape[0], -1).sum(axis=1) * (sp[1] * step[1]) * (sp[2] * step[2])
    big = np.nonzero(area >= APEX_AREA_MM2)[0]
    superior_last = a[2, 0] > 0   # 规范化 z 下标哪一端是头侧：看仿射里 z 下标对 LPS Z 的贡献
    top_k = lungs.shape[0] - 1 if superior_last else 0
    apex_k = int(big.max() if superior_last else big.min()) if len(big) else None
    apex_in_fov = apex_k is not None and apex_k != top_k
    cv = idx.mean(axis=0)

    def slice_z(k: int) -> float:
        return float(a[2, 0] * k * step[0] + a[2, 1] * cv[1] + a[2, 2] * cv[2] + a[2, 3])
    return {
        "ok": True,
        "centroid_lps_mm": [round(float(c), 1) for c in centroid],
        "apex_z_mm": round(slice_z(apex_k), 1) if apex_k is not None else None,
        # 足侧 1% 分位（膈顶以下的肺底，受吸气程度影响大，只作参考）
        "base_z_mm": round(float(np.percentile(z, 1)), 1),
        "bbox_lps_mm": [round(float(x), 1) for x in list(lps.min(axis=0)) + list(lps.max(axis=0))],
        "volume_ml": round(volume_ml, 0),
        "apex_in_fov": apex_in_fov,
        "grid_mm": [round(s * k, 2) for s, k in zip(sp, step)],
        "method": "hu_threshold",
        "note": None if apex_in_fov else "肺尖不在扫描范围内，头足方向只按肺质心对齐",
    }


def anchor_translation(prior: Optional[Dict[str, Any]], current: Optional[Dict[str, Any]]) -> Tuple[Optional[np.ndarray], Optional[str]]:
    """
    两期肺部锚点给出的平移（前片 → 当前，mm）：左右、前后取肺质心之差；头足方向两期肺尖都在扫描范围内时取肺尖高度之差
    （肺尖受吸气程度影响小于质心与膈顶），否则取质心之差。任一期没有锚点时返回 (None, 原因)。
    """
    if not (prior and prior.get("ok")) or not (current and current.get("ok")):
        missing = [name for name, x in (("前片", prior), ("本次", current)) if not (x and x.get("ok"))]
        return None, f"{'、'.join(missing)}没有肺部锚点"
    cp = np.asarray(prior["centroid_lps_mm"], dtype=np.float64)
    cc = np.asarray(current["centroid_lps_mm"], dtype=np.float64)
    t = cc - cp
    if prior.get("apex_in_fov") and current.get("apex_in_fov") and prior.get("apex_z_mm") is not None and current.get("apex_z_mm") is not None:
        t[2] = float(current["apex_z_mm"]) - float(prior["apex_z_mm"])
        return t, None
    return t, "肺尖不全在扫描范围内，头足方向按肺质心对齐（受吸气程度影响较大）"


# ---------------------------------------------------------------------------
# 结节点集配准
# ---------------------------------------------------------------------------
def _parse(nodules: Sequence[Dict[str, Any]], side: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    ok, skipped = [], []
    for n in nodules or []:
        nid = str(n.get("id"))
        c = n.get("center_lps_mm")
        if not isinstance(c, (list, tuple)) or len(c) != 3 or not all(isinstance(x, (int, float)) and np.isfinite(x) for x in c):
            skipped.append({"id": nid, "side": side, "reason": "没有病人坐标（LPS）"})
            continue
        d = n.get("mean_diameter_mm")
        ok.append({"id": nid, "c": np.asarray(c, dtype=np.float64),
                   "d": float(d) if isinstance(d, (int, float)) and np.isfinite(d) and d > 0 else 0.0,
                   "lobe": n.get("lobe") or None})
    return ok, skipped


def rotation_deg(R: np.ndarray) -> float:
    return float(np.degrees(np.arccos(np.clip((np.trace(R) - 1.0) / 2.0, -1.0, 1.0))))


def kabsch(P: np.ndarray, C: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """最小二乘刚性变换 C ≈ R·P + t（不含缩放，保证 det(R) = +1）。"""
    mp, mc = P.mean(axis=0), C.mean(axis=0)
    H = (P - mp).T @ (C - mc)
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T)) or 1.0
    R = Vt.T @ np.diag([1.0, 1.0, d]) @ U.T
    return R, mc - R @ mp


def _inlier_tol(dP: np.ndarray, dC: np.ndarray) -> np.ndarray:
    return INLIER_BASE_MM + INLIER_DIAM_FACTOR * np.maximum(dP[:, None], dC[None, :])


def greedy_inliers(P: np.ndarray, C: np.ndarray, dP: np.ndarray, dC: np.ndarray, R: np.ndarray, t: np.ndarray,
                   fixed: Sequence[Tuple[int, int]] = ()) -> List[Tuple[int, int, float]]:
    """变换后一一对应的内点（距离由近到远贪心）；fixed 为已知对应，只要在容差内就算内点且优先占位。"""
    if not len(P) or not len(C):
        return []
    Pt = P @ R.T + t
    D = np.linalg.norm(Pt[:, None, :] - C[None, :, :], axis=2)
    tol = _inlier_tol(dP, dC)
    used_p, used_c, out = set(), set(), []
    for i, j in fixed:
        if D[i, j] <= tol[i, j]:
            used_p.add(i); used_c.add(j); out.append((i, j, float(D[i, j])))
    cand = np.argwhere(D <= tol)
    order = np.argsort(D[cand[:, 0], cand[:, 1]]) if len(cand) else []
    for k in order:
        i, j = int(cand[k, 0]), int(cand[k, 1])
        if i in used_p or j in used_c:
            continue
        used_p.add(i); used_c.add(j); out.append((i, j, float(D[i, j])))
    return out


def _refine(P, C, dP, dC, t0: np.ndarray, fixed) -> Tuple[np.ndarray, np.ndarray, List[Tuple[int, int, float]], List[str]]:
    """从平移假设出发做迭代最近点：内点 ≥ 3 时解刚性变换（旋转超限则只平移），否则内点平均平移。"""
    R, t = np.eye(3), np.asarray(t0, dtype=np.float64)
    notes: List[str] = []
    prev = None
    inl = greedy_inliers(P, C, dP, dC, R, t, fixed)
    for _ in range(ICP_ITERATIONS):
        if not inl:
            break
        ii = [i for i, _, _ in inl]
        jj = [j for _, j, _ in inl]
        if len(inl) >= 3:
            R2, t2 = kabsch(P[ii], C[jj])
            if rotation_deg(R2) > MAX_ROTATION_DEG:
                if not notes:
                    notes.append(f"按结节估计的旋转 {rotation_deg(R2):.0f}° 超过 {MAX_ROTATION_DEG:g}°（体位差异大或对应有误），只做平移")
                R2, t2 = np.eye(3), (C[jj] - P[ii]).mean(axis=0)
        else:
            R2, t2 = np.eye(3), (C[jj] - P[ii]).mean(axis=0)
        R, t = R2, t2
        key = tuple(sorted((i, j) for i, j, _ in inl))
        inl = greedy_inliers(P, C, dP, dC, R, t, fixed)
        if key == tuple(sorted((i, j) for i, j, _ in inl)) and key == prev:
            break
        prev = key
    return R, t, inl, notes


def _best_hypothesis(P, C, dP, dC, hyps: List[np.ndarray], fixed) -> Tuple[Optional[np.ndarray], List[Tuple[int, int, float]]]:
    best, best_inl, best_key = None, [], None
    for h in hyps:
        inl = greedy_inliers(P, C, dP, dC, np.eye(3), h, fixed)
        key = (len(inl), -sum(d for _, _, d in inl))
        if best_key is None or key > best_key:
            best, best_inl, best_key = h, inl, key
    return best, best_inl


def register(prior: List[Dict[str, Any]], current: List[Dict[str, Any]], t_anchor: Optional[np.ndarray],
             fixed: Sequence[Tuple[int, int]] = ()) -> Dict[str, Any]:
    """
    估计前片 → 本次的刚性变换。返回 {R, t, quality, inliers, rms_mm, notes, anchor_used}（R、t 为 numpy）。
    """
    P = np.array([n["c"] for n in prior]).reshape(-1, 3)
    C = np.array([n["c"] for n in current]).reshape(-1, 3)
    dP = np.array([n["d"] for n in prior], dtype=np.float64)
    dC = np.array([n["d"] for n in current], dtype=np.float64)
    notes: List[str] = []
    hyps_all: List[np.ndarray] = [C[j] - P[i] for i, j in fixed]
    pairs = [(i, j) for i in range(len(P)) for j in range(len(C))]
    if len(pairs) > MAX_HYPOTHESES:
        rng = np.random.default_rng(0)
        pairs = [pairs[k] for k in rng.choice(len(pairs), MAX_HYPOTHESES, replace=False)]
    hyps_all += [C[j] - P[i] for i, j in pairs]

    if t_anchor is not None:
        windowed = [h for h in hyps_all if np.linalg.norm(h - t_anchor) <= ANCHOR_SEARCH_MM] + [np.asarray(t_anchor, dtype=np.float64)]
        h_win, inl_win = _best_hypothesis(P, C, dP, dC, windowed, fixed)
        h_all, inl_all = _best_hypothesis(P, C, dP, dC, hyps_all, fixed) if hyps_all else (None, [])
        # 锚点可能出错（肺分割失败、扫描范围差异大）：锚点窗外有明显更多一致结节对时以结节为准
        if h_all is not None and len(inl_all) >= max(3, len(inl_win) + 2):
            notes.append(f"肺部锚点与结节配准不一致（相差 {np.linalg.norm(h_all - t_anchor):.0f} mm），按结节配准")
            h0, anchor_used = h_all, False
        else:
            h0, anchor_used = h_win, True
    else:
        h0, _ = _best_hypothesis(P, C, dP, dC, hyps_all + [np.zeros(3)], fixed) if (len(P) and len(C)) else (np.zeros(3), [])
        anchor_used = False
    if h0 is None:
        h0 = np.zeros(3) if t_anchor is None else np.asarray(t_anchor, dtype=np.float64)

    R, t, inl, rnotes = _refine(P, C, dP, dC, h0, fixed) if (len(P) and len(C)) else (np.eye(3), h0, [], [])
    notes += rnotes
    k = len(inl)
    fixed_set = set(fixed)
    fixed_in = sum(1 for i, j, _ in inl if (i, j) in fixed_set)
    anchor_ok = t_anchor is not None and float(np.linalg.norm(t - t_anchor)) <= ANCHOR_SEARCH_MM
    if fixed_in >= 1 or k >= 3 or (k == 2 and anchor_ok):
        quality = "fine"
    elif t_anchor is not None:
        quality = "coarse"
        if k <= 1 or not anchor_ok:
            R, t = np.eye(3), np.asarray(t_anchor, dtype=np.float64)
            inl = greedy_inliers(P, C, dP, dC, R, t, fixed)
        notes.append("一致的结节对不足，只按肺部锚点粗配准，对应关系请核对")
    elif k == 2:
        quality = "coarse"
        notes.append("只有 2 个结节对互相印证、没有肺部锚点，对应关系请核对")
    else:
        quality = "none"
        R, t = np.eye(3), np.zeros(3)
        inl = greedy_inliers(P, C, dP, dC, R, t, fixed)
        notes.append("没有肺部锚点、也没有互相印证的结节对，按两期原始坐标比对：不同检查的坐标原点可能不同，结果不可靠，请逐一核对")
    rms = float(np.sqrt(np.mean([d * d for _, _, d in inl]))) if inl else None
    return {"R": R, "t": t, "quality": quality, "inliers": inl, "rms_mm": rms, "notes": notes, "anchor_used": anchor_used and quality != "none"}


# ---------------------------------------------------------------------------
# 指派
# ---------------------------------------------------------------------------
def match_nodules(prior_nodules: Sequence[Dict[str, Any]], current_nodules: Sequence[Dict[str, Any]],
                  prior_anchor: Optional[Dict[str, Any]] = None, current_anchor: Optional[Dict[str, Any]] = None,
                  fixed_pairs: Sequence[Sequence[str]] = ()) -> Dict[str, Any]:
    """
    两期结节对应。nodules 项：{id, center_lps_mm, mean_diameter_mm?, lobe?}；fixed_pairs：医生已确认的 [前片 id, 本次 id]，
    只参与配准，不再指派（结果里不重复列出）。没有病人坐标的结节不参与，列在 skipped。
    返回契约见 POST /api/v1/pipeline/lung-nodule/match。
    """
    prior, sk1 = _parse(prior_nodules, "prior")
    current, sk2 = _parse(current_nodules, "current")
    pidx = {n["id"]: i for i, n in enumerate(prior)}
    cidx = {n["id"]: j for j, n in enumerate(current)}
    fixed: List[Tuple[int, int]] = []
    for fp in fixed_pairs or []:
        if len(fp) == 2 and str(fp[0]) in pidx and str(fp[1]) in cidx:
            fixed.append((pidx[str(fp[0])], cidx[str(fp[1])]))
    t_anchor, anchor_note = anchor_translation(prior_anchor, current_anchor)
    reg = register(prior, current, t_anchor, fixed)
    notes = ([anchor_note] if anchor_note else []) + reg["notes"]

    R, t = reg["R"], reg["t"]
    fixed_p = {i for i, _ in fixed}
    fixed_c = {j for _, j in fixed}
    rows = [i for i in range(len(prior)) if i not in fixed_p]
    cols = [j for j in range(len(current)) if j not in fixed_c]
    extra = {"fine": max(2.0, 2.0 * (reg["rms_mm"] or 0.0)), "coarse": COARSE_EXTRA_MM, "none": 0.0}[reg["quality"]]
    pairs_out: List[Dict[str, Any]] = []
    matched_r, matched_c = set(), set()
    if rows and cols:
        P = np.array([prior[i]["c"] for i in rows]) @ R.T + t
        C = np.array([current[j]["c"] for j in cols])
        D = np.linalg.norm(P[:, None, :] - C[None, :, :], axis=2)
        dP = np.array([prior[i]["d"] for i in rows])
        dC = np.array([current[j]["d"] for j in cols])
        gate = np.maximum(GATE_MIN_MM, GATE_DIAM_FACTOR * np.maximum(dP[:, None], dC[None, :])) + extra
        lobe_diff = np.array([[1.0 if (prior[i]["lobe"] and current[j]["lobe"] and prior[i]["lobe"] != current[j]["lobe"]) else 0.0
                               for j in cols] for i in rows])
        cost = D + LOBE_MISMATCH_PENALTY_MM * lobe_diff
        within = D <= gate
        cost = np.where(within, cost, _BIG)
        ri, ci = linear_sum_assignment(cost)
        for a, b in zip(ri, ci):
            if cost[a, b] >= _BIG:
                continue
            i, j = rows[a], cols[b]
            matched_r.add(i); matched_c.add(j)
            alt_p = [prior[rows[x]]["id"] for x in range(len(rows)) if x != a and within[x, b]]
            alt_c = [current[cols[y]]["id"] for y in range(len(cols)) if y != b and within[a, y]]
            pairs_out.append({
                "prior_id": prior[i]["id"], "current_id": current[j]["id"],
                "distance_mm": round(float(D[a, b]), 1), "gate_mm": round(float(gate[a, b]), 1),
                "lobe_match": None if not (prior[i]["lobe"] and current[j]["lobe"]) else prior[i]["lobe"] == current[j]["lobe"],
                "ambiguous": bool(alt_p or alt_c), "alternatives_prior": alt_p, "alternatives_current": alt_c,
            })
    fixed_out = []
    for i, j in fixed:
        d = float(np.linalg.norm(R @ prior[i]["c"] + t - current[j]["c"]))
        fixed_out.append({"prior_id": prior[i]["id"], "current_id": current[j]["id"], "distance_mm": round(d, 1)})

    return {
        "method": "lung_anchor+point_set_rigid",
        "registration": {
            "quality": reg["quality"],
            "reliable": reg["quality"] == "fine",
            "rotation_deg": round(rotation_deg(R), 2),
            "rotation_matrix": [[round(float(x), 5) for x in row] for row in R],
            "translation_mm": [round(float(x), 1) for x in t],
            "anchor_used": bool(reg["anchor_used"]),
            "anchor_translation_mm": None if t_anchor is None else [round(float(x), 1) for x in t_anchor],
            "inliers": len(reg["inliers"]),
            "rms_mm": None if reg["rms_mm"] is None else round(reg["rms_mm"], 2),
            "notes": notes,
        },
        "pairs": pairs_out,
        "fixed": fixed_out,
        "unmatched_prior": [prior[i]["id"] for i in rows if i not in matched_r],
        "unmatched_current": [current[j]["id"] for j in cols if j not in matched_c],
        "skipped": sk1 + sk2,
        "params": {
            "inlier_base_mm": INLIER_BASE_MM, "inlier_diam_factor": INLIER_DIAM_FACTOR, "anchor_search_mm": ANCHOR_SEARCH_MM,
            "max_rotation_deg": MAX_ROTATION_DEG, "gate_min_mm": GATE_MIN_MM, "gate_diam_factor": GATE_DIAM_FACTOR,
            "gate_extra_mm": round(extra, 1), "lobe_mismatch_penalty_mm": LOBE_MISMATCH_PENALTY_MM,
        },
    }
