"""
肺结节模型链评估（PRD T1.7）：在锁定测试集上跑 /api/v1/pipeline/lung-nodule 同一套推理，按 src/nodule_eval.py 的口径出报告。

用法（在 apps/imaging-worker 下）：
    .venv/bin/python scripts/eval_nodule.py --manifest scripts/manifests/lidc-sample.json --out eval-results/lidc-sample

清单（JSON）：
    {
      "name": "锁定测试集 v1",
      "cases": [
        {
          "case_id": "c001",                      # 只用编号，不写姓名、住院号等身份信息
          "volume": "data/c001.nii.gz",           # 相对清单所在目录；NIfTI、DICOM zip 或 DICOM 目录
          "reference_mask": "data/c001_mask.nii.gz",  # 可选：参考标注标签图
          "reference_per_label": false,           # true 时每个标签值是一个结节，否则每个连通域一个
          "nodules": [                            # 可选：直接给参考结节（坐标为 worker 规范化后的 zyx 体素坐标）
            {"id": "n1", "center_vox_zyx": [z, y, x], "diameter_mm": 7.2, "type": "solid"}
          ],
          "meta": {"scanner": "...", "dose": "LDCT", "slice_thickness_mm": 1.0}
        }
      ]
    }
同一病例同时给 nodules 与 reference_mask 时以 nodules 为准（mask 只用来补体积，按中心落在哪个连通域对应）。
推理结果按病例缓存在 <out>/predictions/，重复评估（例如只改分析口径）不重跑模型；--rerun 强制重跑。
锁定测试集与预测缓存都含患者影像衍生数据，只能放在院内。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nodule_eval import Case, PredNodule, RefNodule, evaluate, refs_from_mask, render_markdown  # noqa: E402


def _git_commit() -> str:
    """当前提交；工作区有未提交改动时注明（报告要能复现）"""
    here = Path(__file__).parent
    try:
        head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, cwd=here, check=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no", "--", str(here.parent)], capture_output=True, text=True, cwd=here, check=True).stdout.strip()
        return f"{head}（含未提交改动）" if dirty else head
    except Exception:
        return "未知"


def _predict(engine, volume: str, cache: Path, args, need_masks: bool = False) -> dict:
    if cache.exists() and not args.rerun and not need_masks:
        return json.loads(cache.read_text())
    result = engine.run_lung_nodule_pipeline(
        volume,
        max_nodules=args.max_nodules,
        min_score=args.min_score,
        seg=False,
        vista_class_prompt=args.vista_class_prompt,
        filter_edge_extrapulmonary=bool(args.filter_edge_extrapulmonary),
        detector_sw_overlap=args.sw_overlap,
        return_masks=need_masks,
    )
    masks = result.pop("_masks", None)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    if masks is not None:
        result["_masks"] = masks
    return result


def _refs(engine, entry: dict, base: Path, spacing) -> list:
    mask_refs = []
    if entry.get("reference_mask"):
        mask, _, _ = engine.load_volume_data(str(base / entry["reference_mask"]))
        mask_refs = refs_from_mask(mask, spacing, per_label=bool(entry.get("reference_per_label")))
    if not entry.get("nodules"):
        return mask_refs
    refs = []
    for n in entry["nodules"]:
        r = RefNodule(id=str(n["id"]), center_vox_zyx=tuple(n["center_vox_zyx"]), diameter_mm=float(n["diameter_mm"]), type=n.get("type", "unknown"),
                      volume_mm3=n.get("volume_mm3"))
        if mask_refs:
            # 体积与分割体素掩码取中心最近、且距离在半径内的标注连通域
            near = min(mask_refs, key=lambda m: math.dist([a * s for a, s in zip(m.center_vox_zyx, spacing)], [a * s for a, s in zip(r.center_vox_zyx, spacing)]))
            if math.dist([a * s for a, s in zip(near.center_vox_zyx, spacing)], [a * s for a, s in zip(r.center_vox_zyx, spacing)]) <= max(r.diameter_mm / 2, 2.5):
                if r.volume_mm3 is None:
                    r.volume_mm3 = near.volume_mm3
                r.mask_vox_zyx = near.mask_vox_zyx
        refs.append(r)
    return refs


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="肺结节模型链评估（T1.7 / B.2 / B.3）")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True, help="输出目录：report.json、report.md、predictions/")
    ap.add_argument("--operating-threshold", type=float, default=0.15, help="报告工作点的检出分数阈值（默认 0.15）")
    ap.add_argument("--target-sensitivity", type=float, default=0.95, help="推荐工作点目标敏感度（默认 0.95）")
    ap.add_argument("--max-fp-per-scan", type=float, default=1.0, help="推荐工作点每例最大假阳性上限（默认 1.0）")
    ap.add_argument("--min-score", type=float, default=0.02, help="推理时保留候选的最低分数；要低于扫描网格，才能画 FROC")
    ap.add_argument("--max-nodules", type=int, default=50)
    ap.add_argument("--vista-class-prompt", type=int, default=None, help="消融实验：VISTA-3D 点提示类别（例如 23=lung tumor）")
    ap.add_argument("--filter-edge-extrapulmonary", action="store_true", help="消融实验：过滤首尾层/边缘及肺叶外假阳性候选")
    ap.add_argument("--sw-overlap", type=float, default=None, help="消融实验：RetinaNet 滑窗 overlap（例如 0.25 vs 0.5）")
    ap.add_argument("--rerun", action="store_true", help="忽略缓存重跑推理")
    args = ap.parse_args(argv)

    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text())
    base = manifest_path.parent
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    from engine import MONAIEngine  # 推迟导入：只看帮助时不加载 torch
    engine = MONAIEngine()

    cases, versions, devices = [], set(), set()
    for entry in manifest["cases"]:
        cid = str(entry["case_id"])
        print(f"[{len(cases) + 1}/{len(manifest['cases'])}] {cid}", flush=True)
        has_ref_mask = bool(entry.get("reference_mask"))
        pred = _predict(engine, str(base / entry["volume"]), out / "predictions" / f"{cid}.json", args, need_masks=has_ref_mask)
        pred_masks = pred.get("_masks") or {}
        versions.add(pred.get("model_version"))
        devices.add(pred.get("device"))
        spacing = tuple(float(x) for x in pred["series_qc"]["spacing_mm"])
        preds = [
            PredNodule(
                score=float(n["detection_score"]),
                center_vox_zyx=tuple(n["center_vox_zyx"]),
                mean_diameter_mm=(n.get("metrics") or {}).get("mean_diameter_mm"),
                volume_mm3=(n.get("metrics") or {}).get("volume_mm3"),
                mask_vox_zyx=pred_masks.get(int(n["index"])) if "index" in n else None,
            )
            for n in pred["nodules"]
        ]
        cases.append(Case(case_id=cid, spacing_zyx=spacing, refs=_refs(engine, entry, base, spacing), preds=preds,
                          elapsed_ms=pred.get("elapsed_ms"), meta=entry.get("meta", {})))

    report = evaluate(
        cases,
        args.operating_threshold,
        target_sensitivity=args.target_sensitivity,
        max_fp_per_scan=args.max_fp_per_scan,
    )
    report["meta"] = {
        "manifest": manifest.get("name", manifest_path.name), "model_version": " / ".join(sorted(v for v in versions if v)) or "未知",
        "device": " / ".join(sorted(d for d in devices if d)) or "未知", "git_commit": _git_commit(),
        "generated_at": _dt.datetime.now().isoformat(timespec="seconds"), "min_score": args.min_score,
        "ablation": {
            "vista_class_prompt": args.vista_class_prompt,
            "filter_edge_extrapulmonary": bool(args.filter_edge_extrapulmonary),
            "sw_overlap": args.sw_overlap,
        },
    }
    report["per_case"] = [{"case_id": c.case_id, "references": len(c.refs), "candidates": len(c.preds), "elapsed_ms": c.elapsed_ms} for c in cases]
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    (out / "report.md").write_text(render_markdown(report))
    print(f"报告：{out / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
