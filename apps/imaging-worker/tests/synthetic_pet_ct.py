"""
测试专用的合成 PET-CT 体模。只供测试使用，服务端和引擎不得引用（合成数据不能冒充真实影像）。
"""
from typing import Dict, Any, Tuple
import numpy as np


def generate_synthetic_pet_ct_pair(
    shape: Tuple[int, int, int] = (36, 96, 96),
    spacing: Tuple[float, float, float] = (2.0, 1.0, 1.0)
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    """
    Synthesizes a realistic paired CT and PET dataset:
    - CT: Thoraco-abdominal volume with anatomy (-1000 to +450 HU)
    - PET: Metabolic volume in SUV units (0.0 to 12.5 SUV) with hypermetabolic malignant tumor
    """
    z_dim, y_dim, x_dim = shape
    ct_vol = np.full(shape, -1000.0, dtype=np.float32)
    pet_vol = np.full(shape, 0.2, dtype=np.float32) # physiological background SUV

    z_coords, y_coords, x_coords = np.meshgrid(
        np.arange(z_dim), np.arange(y_dim), np.arange(x_dim), indexing="ij"
    )
    cy, cx = y_dim // 2, x_dim // 2

    # Body contour
    body = ((y_coords - cy) / (y_dim * 0.44))**2 + ((x_coords - cx) / (x_dim * 0.44))**2 <= 1.0
    ct_vol[body] = 40.0
    pet_vol[body] = 0.8 + np.random.normal(0, 0.1, int(np.sum(body))) # soft tissue background SUV

    # Bilateral lungs
    left_lung = ((y_coords - cy) / (y_dim * 0.26))**2 + ((x_coords - (cx - int(x_dim * 0.2))) / (x_dim * 0.16))**2 <= 1.0
    right_lung = ((y_coords - cy) / (y_dim * 0.26))**2 + ((x_coords - (cx + int(x_dim * 0.2))) / (x_dim * 0.16))**2 <= 1.0
    ct_vol[left_lung] = -700.0
    ct_vol[right_lung] = -700.0
    pet_vol[left_lung] = 0.35 # low lung background
    pet_vol[right_lung] = 0.35

    # Spine bone in posterior
    spine = ((y_coords - (cy + int(y_dim * 0.28))) / (y_dim * 0.08))**2 + ((x_coords - cx) / (x_dim * 0.08))**2 <= 1.0
    ct_vol[spine] = 450.0

    # Hypermetabolic malignant tumor in right lung / hilar region
    tz = z_dim // 2
    ty = cy + 2
    tx = cx + int(x_dim * 0.18)
    tumor_radius = 8.0
    dist_sq = (
        ((z_coords - tz) / (tumor_radius * 0.7))**2 +
        ((y_coords - ty) / tumor_radius)**2 +
        ((x_coords - tx) / (tumor_radius * 1.2))**2
    )
    tumor_mask = dist_sq <= 1.0

    # CT hyperdense lesion
    ct_vol[tumor_mask] = 55.0 + np.random.normal(0, 8, int(np.sum(tumor_mask)))
    # PET hypermetabolism (SUV peaks at 11.8)
    tumor_suv = 11.8 * np.exp(-1.5 * dist_sq[tumor_mask])
    pet_vol[tumor_mask] = np.maximum(pet_vol[tumor_mask], tumor_suv)

    meta = {
        "tumor_center": (tz, ty, tx),
        "tumor_radius": tumor_radius,
        "max_suv_ground_truth": 11.8,
    }
    return ct_vol, pet_vol, meta
