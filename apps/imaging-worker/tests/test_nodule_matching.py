"""
随访对比的结节对应（nodule_matching，T2.4）：合成点集验证
- 已知平移 / 小角度旋转下的配准与对应；新发、消失；
- 坐标原点相差几百毫米（不同日期扫描床位置不同）时靠肺部锚点或结节点集找回；
- 密集结节时匈牙利指派优于逐个最近邻，并标出歧义候选；
- 没有锚点、只有一对结节时如实给出「不可靠」；旋转过大时退回只平移；
- 医生确认的对应关系参与配准、不再指派；缺坐标的结节跳过；
- 肺部锚点：合成胸部体积上找到两肺、肺尖高度与扫描床平移一致；
- 接口 /api/v1/pipeline/lung-nodule/match 与 /anchor。
"""
import os
import sys

import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

import server
from nodule_matching import anchor_translation, kabsch, lung_anchor, match_nodules, rotation_deg


def _rz(deg):
    t = np.deg2rad(deg)
    return np.array([[np.cos(t), -np.sin(t), 0], [np.sin(t), np.cos(t), 0], [0, 0, 1.0]])


def nod(i, c, d=6.0, lobe=None):
    return {"id": str(i), "center_lps_mm": [float(x) for x in c], "mean_diameter_mm": d, "lobe": lobe}


PRIOR_PTS = np.array([
    [-80.0, 20.0, 150.0], [70.0, 10.0, 120.0], [-60.0, -30.0, 60.0], [50.0, 40.0, 80.0], [-20.0, 60.0, 30.0],
])


def anchor(centroid, apex):
    return {"ok": True, "centroid_lps_mm": list(centroid), "apex_z_mm": apex, "apex_in_fov": True}


def test_known_translation_and_small_rotation_with_new_and_gone():
    R, t = _rz(4.0), np.array([12.0, -7.0, -230.0])   # 两期坐标原点差 230 mm（扫描床位置不同）
    cur = PRIOR_PTS @ R.T + t + np.random.default_rng(1).normal(0, 1.0, PRIOR_PTS.shape)
    prior = [nod(f"p{i}", c) for i, c in enumerate(PRIOR_PTS)]
    current = [nod(f"c{i}", c) for i, c in enumerate(cur[:4])] + [nod("c_new", [0.0, 0.0, -150.0])]   # p4 消失，c_new 新发
    r = match_nodules(prior, current)
    reg = r["registration"]
    assert reg["quality"] == "fine" and reg["reliable"]
    assert reg["inliers"] == 4
    assert abs(reg["rotation_deg"] - 4.0) < 1.5
    assert np.allclose(reg["translation_mm"], t, atol=15)   # 旋转中心不同，平移与旋转耦合
    assert {(p["prior_id"], p["current_id"]) for p in r["pairs"]} == {(f"p{i}", f"c{i}") for i in range(4)}
    assert r["unmatched_prior"] == ["p4"]
    assert r["unmatched_current"] == ["c_new"]
    assert all(p["distance_mm"] < 5 for p in r["pairs"])


def test_lung_anchor_resolves_single_nodule_and_coarse_quality():
    """只有一个结节：没有锚点时不可靠（不自证），有锚点时为粗配准且能对上。"""
    t = np.array([5.0, -3.0, -310.0])
    prior = [nod("p", [-60, 10, 100], d=8)]
    current = [nod("c", np.array([-60, 10, 100]) + t + [2, 1, 6], d=9)]   # 吸气差异导致 6 mm 头足偏移
    r0 = match_nodules(prior, current)
    assert r0["registration"]["quality"] == "none" and not r0["registration"]["reliable"]
    assert r0["pairs"] == [] and r0["unmatched_prior"] == ["p"] and r0["unmatched_current"] == ["c"]
    assert any("不可靠" in n for n in r0["registration"]["notes"])

    r1 = match_nodules(prior, current, anchor([0, 0, 50], 180), anchor(np.array([0, 0, 50]) + t + [1, 0, 4], 180 + t[2] + 3))
    assert r1["registration"]["quality"] == "coarse" and r1["registration"]["anchor_used"]
    assert [(p["prior_id"], p["current_id"]) for p in r1["pairs"]] == [("p", "c")]


def test_anchor_window_and_wrong_anchor_overridden_by_nodules():
    t = np.array([0.0, 0.0, -200.0])
    prior = [nod(f"p{i}", c) for i, c in enumerate(PRIOR_PTS)]
    current = [nod(f"c{i}", c + t) for i, c in enumerate(PRIOR_PTS)]
    ok = match_nodules(prior, current, anchor([0, 0, 0], 100), anchor(t, 100 + t[2]))
    assert ok["registration"]["quality"] == "fine" and ok["registration"]["anchor_used"]
    assert len(ok["pairs"]) == 5
    # 锚点错了 120 mm：结节有 5 对互相印证，以结节为准并写明
    bad = match_nodules(prior, current, anchor([0, 0, 0], 100), anchor([0, 0, -80], 20))
    assert bad["registration"]["quality"] == "fine" and not bad["registration"]["anchor_used"]
    assert len(bad["pairs"]) == 5
    assert any("锚点与结节配准不一致" in n for n in bad["registration"]["notes"])


def test_dense_nodules_hungarian_beats_greedy_and_flags_ambiguity():
    """
    密集结节：前片 p1、p2 相距 4 mm；本次 c1、c2 在其附近。逐个取最近邻时 p1 先拿走 c1，p2 只能配到 6.9 mm 外的 c2；
    匈牙利按总距离最小得到 p1→c2、p2→c1（总 4.3 mm < 9.5 mm），并因门限内还有另一候选而标为有歧义。
    """
    base = [nod("x1", [-90, 0, 200], d=5), nod("x2", [90, 0, 200], d=5), nod("x3", [0, 50, 40], d=5), nod("x4", [0, -60, -50], d=5)]
    prior = base + [nod("p1", [0, 0, 100], d=5), nod("p2", [4, 0, 100], d=5)]
    current = [dict(n, id=n["id"] + "'") for n in base] + [nod("c1", [1.5, 0, 100], d=5), nod("c2", [-4, 0, 100], d=5)]
    r = match_nodules(prior, current)
    pairs = {p["prior_id"]: p for p in r["pairs"]}
    assert pairs["p1"]["current_id"] == "c2" and pairs["p2"]["current_id"] == "c1"
    assert pairs["p1"]["ambiguous"] and "c1" in pairs["p1"]["alternatives_current"]
    assert not pairs["x1"]["ambiguous"]


def test_lobe_penalty_breaks_tie():
    base = [nod("x1", [-90, 0, 200]), nod("x2", [90, 0, 200]), nod("x3", [0, 50, 40])]
    prior = base + [nod("a", [0, 0, 100], lobe="RML"), nod("b", [8, 0, 100], lobe="RLL")]
    # 本次两枚都恰在两者中间附近：只有肺叶能区分
    current = [dict(n, id=n["id"] + "'") for n in base] + [nod("a'", [4.5, 0, 100], lobe="RML"), nod("b'", [3.5, 0, 100], lobe="RLL")]
    r = match_nodules(prior, current)
    pairs = {p["prior_id"]: p["current_id"] for p in r["pairs"]}
    assert pairs["a"] == "a'" and pairs["b"] == "b'"


def test_size_dependent_gate():
    """大结节质心随生长偏移较多仍能对上；小结节相同偏移不对应（新发 + 消失）。"""
    base = [nod("x1", [-90, 0, 200]), nod("x2", [90, 0, 200]), nod("x3", [0, 50, 40])]
    cur_base = [dict(n, id=n["id"] + "'") for n in base]
    big = match_nodules(base + [nod("m", [0, 0, 100], d=25)], cur_base + [nod("m'", [0, 0, 118], d=30)])
    assert ("m", "m'") in {(p["prior_id"], p["current_id"]) for p in big["pairs"]}
    small = match_nodules(base + [nod("s", [0, 0, 100], d=4)], cur_base + [nod("s'", [0, 0, 118], d=4)])
    assert "s" in small["unmatched_prior"] and "s'" in small["unmatched_current"]


def test_large_rotation_falls_back_to_translation():
    R = _rz(25.0)
    cur = PRIOR_PTS @ R.T + [0, 0, -50]
    r = match_nodules([nod(f"p{i}", c) for i, c in enumerate(PRIOR_PTS)], [nod(f"c{i}", c) for i, c in enumerate(cur)])
    reg = r["registration"]
    assert reg["rotation_deg"] <= 10.0
    assert any("只做平移" in n for n in reg["notes"]) or reg["inliers"] < 3


def test_fixed_pairs_drive_registration_and_are_not_reassigned():
    t = np.array([0.0, 0.0, -250.0])
    prior = [nod("p", [-60, 10, 100]), nod("q", [50, 0, 60])]
    current = [nod("c", np.array([-60, 10, 100]) + t), nod("d", np.array([50, 0, 60]) + t + [0, 0, 3])]
    r = match_nodules(prior, current, fixed_pairs=[["p", "c"]])
    assert r["registration"]["quality"] == "fine"
    # 平移按两对内点平均：医生确认的那对残差 1.5 mm
    assert [(f["prior_id"], f["current_id"]) for f in r["fixed"]] == [("p", "c")] and r["fixed"][0]["distance_mm"] <= 2
    # 只有这一对结节、又没有锚点时，医生的对应关系使配准可信（否则为 none）
    assert match_nodules(prior[:1], current[:1], fixed_pairs=[["p", "c"]])["registration"]["quality"] == "fine"
    assert [(p["prior_id"], p["current_id"]) for p in r["pairs"]] == [("q", "d")]


def test_empty_sides_and_missing_coordinates():
    r = match_nodules([], [nod("c", [0, 0, 0])])
    assert r["pairs"] == [] and r["unmatched_current"] == ["c"] and r["unmatched_prior"] == []
    r = match_nodules([nod("p", [0, 0, 0])], [])
    assert r["unmatched_prior"] == ["p"]
    r = match_nodules([{"id": "p", "center_lps_mm": None}], [nod("c", [0, 0, 0])])
    assert r["skipped"] == [{"id": "p", "side": "prior", "reason": "没有病人坐标（LPS）"}]
    assert r["unmatched_prior"] == []


def test_kabsch_recovers_rotation():
    R = _rz(7.0)
    P = PRIOR_PTS
    R2, t2 = kabsch(P, P @ R.T + [1, 2, 3])
    assert abs(rotation_deg(R2) - 7.0) < 1e-6
    assert np.allclose(t2, [1, 2, 3], atol=1e-6)


def test_anchor_translation_prefers_apex_for_z():
    t, note = anchor_translation(anchor([0, 0, 0], 100), {"ok": True, "centroid_lps_mm": [2, 3, -220], "apex_z_mm": -110, "apex_in_fov": True})
    assert note is None and np.allclose(t, [2, 3, -210])
    t, note = anchor_translation(anchor([0, 0, 0], 100), {"ok": True, "centroid_lps_mm": [2, 3, -220], "apex_z_mm": -110, "apex_in_fov": False})
    assert np.allclose(t, [2, 3, -220]) and "质心" in note
    t, note = anchor_translation(None, anchor([0, 0, 0], 1))
    assert t is None and "前片" in note


def _chest(z0_mm: float, nz=90):
    """合成胸部：体表（软组织 40 HU）内两个椭球肺（-850 HU），体外空气（-1000 HU）；层间距 2 mm，层面 2 mm。"""
    vol = np.full((nz, 128, 128), -1000.0, dtype=np.float32)
    zz, yy, xx = np.mgrid[0:nz, 0:128, 0:128]
    body = ((yy - 64) / 50.0) ** 2 + ((xx - 64) / 60.0) ** 2 <= 1.0
    vol[body] = 40.0
    for cx in (40, 88):
        lung = ((zz - 50) / 30.0) ** 2 + ((yy - 64) / 30.0) ** 2 + ((xx - cx) / 18.0) ** 2 <= 1.0
        vol[lung & body] = -850.0
    # 气管：从两肺之间一直通到最头侧一层（真实胸部 CT 常见），并与两肺相连
    trachea = ((yy - 64) ** 2 + (xx - 64) ** 2 <= 16) & (zz >= 60)
    bronchi = (np.abs(yy - 64) <= 2) & (zz >= 60) & (zz <= 62) & (xx >= 40) & (xx <= 88)
    vol[(trachea | bronchi) & body] = -950.0
    # 规范化 z 下标 0 在足侧：LPS Z = z0 + 2·z
    affine = np.array([[0, 0, 2.0, -128.0], [0, 2.0, 0, -128.0], [2.0, 0, 0, z0_mm], [0, 0, 0, 1.0]])
    return vol, (2.0, 2.0, 2.0), {"affine_zyx_to_lps": affine.tolist()}


def test_lung_anchor_on_synthetic_chest():
    v1, sp, g1 = _chest(-300.0)
    v2, _, g2 = _chest(-80.0)   # 同一人，扫描床位置差 220 mm
    a1, a2 = lung_anchor(v1, sp, g1), lung_anchor(v2, sp, g2)
    # 气管通到顶层但面积 < 10 cm²：仍判为肺尖在扫描范围内；肺尖 = 椭球顶 z=80 层附近
    assert a1["ok"] and a2["ok"] and a1["apex_in_fov"]
    assert abs(a1["apex_z_mm"] - (-300 + 2 * 78)) <= 6
    assert 1000 < a1["volume_ml"] < 2000   # 两个椭球 ≈ 2 × 4/3π·60·60·36 mm³ ≈ 1086 ml
    t, note = anchor_translation(a1, a2)
    assert note is None and np.allclose(t, [0, 0, 220], atol=2.5)
    # 质心在两肺中间（左右对称）
    assert abs(a1["centroid_lps_mm"][0] - 0.0) < 3
    assert lung_anchor(v1, sp, None)["ok"] is False
    assert lung_anchor(np.full((40, 64, 64), 40.0, dtype=np.float32), sp, g1)["ok"] is False


def test_match_and_anchor_endpoints():
    client = TestClient(server.app)
    body = {
        "prior": {"nodules": [nod(f"p{i}", c) for i, c in enumerate(PRIOR_PTS)]},
        "current": {"nodules": [nod(f"c{i}", c + [0, 0, -100]) for i, c in enumerate(PRIOR_PTS)]},
    }
    r = client.post("/api/v1/pipeline/lung-nodule/match", json=body)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["registration"]["quality"] == "fine" and len(j["pairs"]) == 5
    assert client.post("/api/v1/pipeline/lung-nodule/match", json={"prior": {"nodules": "x"}}).status_code == 422
    too_many = {"prior": {"nodules": [nod(i, [i, 0, 0]) for i in range(301)]}, "current": {"nodules": []}}
    assert client.post("/api/v1/pipeline/lung-nodule/match", json=too_many).status_code == 400

    v, sp, g = _chest(-300.0)
    from volume_geometry import CachedVolume
    server.engine.volume_cache["anchor_test"] = CachedVolume(v, sp, "CT", geometry=g)
    try:
        r = client.post("/api/v1/pipeline/lung-nodule/anchor", json={"volume_id": "anchor_test"})
        assert r.status_code == 200, r.text
        assert r.json()["anchor"]["ok"] is True
    finally:
        if "anchor_test" in server.engine.volume_cache:
            del server.engine.volume_cache["anchor_test"]
    assert client.post("/api/v1/pipeline/lung-nodule/anchor", json={"volume_id": "nope"}).status_code == 404
