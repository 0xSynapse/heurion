"""
VISTA-3D 与 lung_nodule_ct_detection 的 bundle 约定预处理：
- 用假模型验证坐标换算（各向异性间距、RAS 翻转、重采样后能回到原网格 zyx 体素约定）；
- 本机有真实权重与 LIDC 样本时，infer_vista3d 点提示分割与标注的 Dice ≥ 0.6。
"""
import os
import sys
from pathlib import Path

import numpy as np
import pytest
import torch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from engine import MONAIEngine, MonaiNeuralInferencePipeline
from model_registry import get_model_status


@pytest.fixture
def neural(monkeypatch):
    n = MonaiNeuralInferencePipeline(torch.device("cpu"))
    monkeypatch.setattr(n, "_base_meta", lambda name, arch, t0: {"real_neural_inference": True})
    return n


class FakeVista:
    """假 VISTA-3D：在输入网格上以点提示（或无点时网格中心）为球心、半径 r 体素输出正 logit。"""

    def __init__(self, radius=6.0):
        self.radius = radius
        self.calls = []

    def __call__(self, input_images, point_coords=None, point_labels=None, class_vector=None, prompt_class=None):
        shape = input_images.shape[2:]
        self.calls.append({"shape": tuple(shape), "point": None if point_coords is None else point_coords[0, 0].tolist(),
                           "class": None if class_vector is None else int(class_vector.flatten()[0]),
                           "max": float(input_images.max()), "min": float(input_images.min())})
        c = point_coords[0, 0].tolist() if point_coords is not None else [s / 2.0 for s in shape]
        grids = torch.meshgrid(*[torch.arange(s, dtype=torch.float32) for s in shape], indexing="ij")
        dist = torch.sqrt(sum((g - ci) ** 2 for g, ci in zip(grids, c)))
        return (self.radius - dist)[None, None]


@pytest.mark.parametrize("spacing,point", [
    ((2.5, 0.7, 0.7), (20, 100, 140)),
    ((1.0, 0.6, 0.9), (5, 10, 150)),     # 靠近体积边缘：窗口被截断、补边
    ((1.5, 1.5, 1.5), (30, 60, 60)),
])
def test_vista3d_point_maps_back_to_zyx(neural, monkeypatch, spacing, point):
    """球形输出的质心应回到提示点（原网格 zyx），球半径按 1.5 mm 网格换算成物理尺寸。"""
    fake = FakeVista(radius=6.0)
    monkeypatch.setattr(neural, "get_vista3d_model", lambda: fake)
    vol = np.full((48, 200, 160), -800.0, dtype=np.float32)
    mask, meta = neural.infer_vista3d(vol, spacing, prompt_point={"z": point[0], "y": point[1], "x": point[2]})
    assert mask.shape == vol.shape and mask.dtype == np.uint8
    assert meta["prompt_point_zyx"] == list(point)
    assert meta["label_prompt"] is None
    zz, yy, xx = np.where(mask > 0)
    assert zz.size > 0
    # 质心偏差 ≤ 1 个原网格体素（边缘处球被截断时只检查未截断方向的包含关系）
    if 0 < point[0] < 47 and point[1] > 10 and point[2] < 150:
        assert abs(zz.mean() - point[0]) <= 1.0
        assert abs(yy.mean() - point[1]) <= 1.0
        assert abs(xx.mean() - point[2]) <= 1.0
    assert mask[point] == 1
    # 物理半径约 6 × 1.5 = 9 mm：沿 x 方向的半宽（mm）
    half_x_mm = (xx.max() - xx.min() + 1) * spacing[2] / 2.0
    if point[2] < 150:
        assert abs(half_x_mm - 9.0) <= 1.5 * spacing[2] + 1.5
    # 输入：1.5 mm 各向同性、bundle HU 窗、各边为 16 的倍数且 ≥ 96
    call = fake.calls[-1]
    assert all(s % 16 == 0 and s >= 96 for s in call["shape"])
    assert call["max"] <= 1.0 and call["min"] >= 0.0
    expected_norm = (-800.0 + 963.8247715525971) / (1053.678477684517 + 963.8247715525971)
    assert abs(call["max"] - expected_norm) < 1e-3


def test_vista3d_ras_axis_order(neural, monkeypatch):
    """送入模型的数组为 RAS：原网格 x 增大（患者左）对应 RAS 第 0 轴减小，y 增大（后）对应第 1 轴减小。"""
    fake = FakeVista()
    monkeypatch.setattr(neural, "get_vista3d_model", lambda: fake)
    vol = np.full((40, 160, 160), -800.0, dtype=np.float32)
    # 两个点都靠近体积起始边，窗口起点同为 0，便于在同一窗口坐标系内比较方向
    neural.infer_vista3d(vol, (1.5, 1.5, 1.5), prompt_point=[20, 10, 10])
    a = fake.calls[-1]["point"]
    neural.infer_vista3d(vol, (1.5, 1.5, 1.5), prompt_point=[30, 20, 20])
    b = fake.calls[-1]["point"]
    assert b[0] < a[0] and b[1] < a[1]   # x、y 翻转
    assert b[2] > a[2]                   # z 不翻转


def test_vista3d_label_prompt_compat(neural, monkeypatch):
    """给出 label_prompt 时只用类别提示（与原行为一致），掩膜形状与 meta 键保持不变。"""
    fake = FakeVista(radius=10.0)
    monkeypatch.setattr(neural, "get_vista3d_model", lambda: fake)
    vol = np.full((30, 120, 120), -800.0, dtype=np.float32)
    mask, meta = neural.infer_vista3d(vol, (2.0, 1.0, 1.0), label_prompt=3)
    assert mask.shape == vol.shape
    assert fake.calls[-1]["point"] is None and fake.calls[-1]["class"] == 3
    assert meta["label_prompt"] == 3 and meta["prompt_point_zyx"] == [15, 60, 60]
    assert {"positive_voxels", "prompt_point_zyx", "label_prompt"} <= set(meta)


def test_vista3d_non_ct_uses_min_max(neural, monkeypatch):
    """非 CT（最小值 ≥ -200）沿用原实现的体积自身最小/最大值归一化。"""
    fake = FakeVista()
    monkeypatch.setattr(neural, "get_vista3d_model", lambda: fake)
    vol = np.zeros((20, 100, 100), dtype=np.float32)
    vol[10, 50, 50] = 500.0
    _, meta = neural.infer_vista3d(vol, (1.5, 1.5, 1.5), prompt_point=[10, 50, 50])
    assert meta["intensity_range"] == [0.0, 500.0]


class FakeDetector:
    """假 RetinaNet：把输入中 ≥ 0.99 的体素外接盒作为检出框（重采样 RAS 网格的体素边界坐标）。"""

    def __init__(self):
        self.shapes = []

    def __call__(self, inputs, use_inferer=False):
        x = inputs[0][0]
        self.shapes.append(tuple(x.shape))
        idx = torch.nonzero(x >= 0.99)
        lo = idx.min(dim=0).values.float()
        hi = idx.max(dim=0).values.float() + 1.0
        return [{"boxes": torch.cat([lo, hi])[None], "labels_scores": torch.tensor([0.9])}]


@pytest.mark.parametrize("spacing", [(2.5, 0.8, 0.6), (1.25, 0.703125, 0.703125), (0.625, 0.5, 0.5)])
def test_lung_nodule_detector_resample_and_box_mapping(neural, monkeypatch, spacing):
    """检出前重采样到 0.703125 × 0.703125 × 1.25 mm（RAS），框映射回原网格 zyx 后与真实位置一致。"""
    fake = FakeDetector()
    monkeypatch.setattr(neural, "get_lung_nodule_model", lambda: fake)
    shape = (40, 120, 100)
    vol = np.full(shape, -900.0, dtype=np.float32)
    z0, y0, x0, z1, y1, x1 = 10, 30, 60, 22, 50, 80
    vol[z0:z1, y0:y1, x0:x1] = 400.0
    boxes, scores = neural._run_lung_nodule_detector(vol, spacing)
    dz, dy, dx = spacing
    expected_in = [int(round(n * d / t)) for n, d, t in zip((shape[2], shape[1], shape[0]), (dx, dy, dz), (0.703125, 0.703125, 1.25))]
    assert list(fake.shapes[-1]) == expected_in
    bx1, by1, bz1, bx2, by2, bz2 = boxes[0]
    # 原网格体素边界坐标：误差 ≤ 1 个重采样体素（换算成原网格体素，至少 1 个）
    tz, ty, tx = [max(1.0, t / d) + 1e-6 for t, d in zip((1.25, 0.703125, 0.703125), spacing)]
    for got, want, tol in ((bz1, z0, tz), (bz2, z1, tz), (by1, y0, ty), (by2, y1, ty), (bx1, x0, tx), (bx2, x1, tx)):
        assert abs(got - want) <= tol, (got, want, tol)
    dets, _ = neural.detect_lung_nodules(vol, spacing)
    box = dets[0]["box_zyx"]
    tols = [tz, ty, tx] * 2
    assert all(abs(a - b) <= np.ceil(t) for a, b, t in zip(box, [z0, y0, x0, z1, y1, x1], tols))


LIDC_SAMPLE = Path(__file__).resolve().parent.parent / "data" / "lidc_lung_nodule_ct.nii.gz"
_REAL_VISTA = (
    LIDC_SAMPLE.exists()
    and LIDC_SAMPLE.with_name("lidc_lung_nodule_mask.nii.gz").exists()
    and get_model_status("vista3d").get("is_ready", False)
)


@pytest.mark.skipif(not _REAL_VISTA, reason="本机缺少 vista3d 校验通过的权重或 LIDC 样本")
def test_real_infer_vista3d_point_dice_lidc():
    """infer_vista3d（交互分割与 /analyze 共用的入口）以标注结节质心为点提示，Dice ≥ 0.6。"""
    import scipy.ndimage as ndi
    eng = MONAIEngine()
    vol, sp, _ = eng.load_volume_data("lidc_lung_nodule_ct")
    gt = eng.load_volume_data("lidc_lung_nodule_mask")[0] > 0
    lab, _ = ndi.label(gt)
    gt = lab == (np.argmax(np.bincount(lab.flat)[1:]) + 1)
    cz, cy, cx = [int(round(c)) for c in ndi.center_of_mass(gt)]
    mask, meta = eng.neural_pipeline.infer_vista3d(vol, sp, prompt_point={"z": cz, "y": cy, "x": cx})
    # 与原接口一样返回整幅掩膜；这里只评估与提示点所在结节相连的部分
    mlab, _ = ndi.label(mask > 0)
    mask = mlab == mlab[cz, cy, cx] if mlab[cz, cy, cx] else mask > 0
    dice = 2.0 * float((mask & gt).sum()) / float(mask.sum() + gt.sum())
    assert dice >= 0.6, dice
    assert meta["real_neural_inference"] is True and meta["prompt_point_zyx"] == [cz, cy, cx]
