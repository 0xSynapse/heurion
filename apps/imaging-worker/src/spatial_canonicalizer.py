"""
Canonical Anatomical Spatial Normalizer for Medical Imaging (LPS+ Standard)
Strictly adheres to DICOM PS 3.3 Patient Coordinate System and NIfTI orientation standards:
- Axis 0 (Z): Inferior -> Superior (Slice order from feet to head)
- Axis 1 (Y): Anterior -> Posterior (Row order from chest/sternum to back/spine)
- Axis 2 (X): Right -> Left (Column order from patient right to patient left)

In radiological viewing of an Axial slice:
- Top: Anterior (A)
- Bottom: Posterior (P)
- Left: Patient Right (R)
- Right: Patient Left (L)

Core Design Principles (Research Imaging Workstation):
1. Coordinate integrity: Never perform heuristic single-axis flipping (prevents mirror chirality inversion).
2. Data provenance: All spatial orientations are strictly derived from DICOM IOP/IPP headers or NIfTI affines.
3. Sanity audits: Anatomical contradictions trigger QA warnings for manual review; pixel data is preserved intact.
"""

import numpy as np
from typing import Tuple, Dict, Any, Optional, List
import nibabel as nib


def build_dicom_affine(
    iop: List[float],
    ipp_list: List[List[float]],
    pixel_spacing: Tuple[float, float]
) -> np.ndarray:
    """
    Constructs standardized 4x4 patient coordinate affine matrix from DICOM headers:
    - ImageOrientationPatient (IOP): [rx, ry, rz, cx, cy, cz]
    - ImagePositionPatient (IPP): [[x, y, z], ...] for each slice
    - PixelSpacing: (dy, dx) in mm
    """
    r = np.array(iop[:3], dtype=np.float64)
    c = np.array(iop[3:], dtype=np.float64)
    s = np.cross(r, c)
    s_norm = np.linalg.norm(s)
    if s_norm > 1e-6:
        s = s / s_norm
    else:
        s = np.array([0.0, 0.0, 1.0], dtype=np.float64)

    dy, dx = float(pixel_spacing[0]), float(pixel_spacing[1])

    # Compute physical slice spacing along normal vector
    if len(ipp_list) >= 2:
        p0 = np.array(ipp_list[0], dtype=np.float64)
        p1 = np.array(ipp_list[1], dtype=np.float64)
        dz = float(abs(np.dot(p1 - p0, s)))
        if dz < 1e-4:
            dz = 1.0
    else:
        dz = 1.0

    ipp0 = np.array(ipp_list[0], dtype=np.float64) if ipp_list else np.zeros(3, dtype=np.float64)

    affine = np.eye(4, dtype=np.float64)
    affine[:3, 0] = r * dx
    affine[:3, 1] = c * dy
    affine[:3, 2] = s * dz
    affine[:3, 3] = ipp0
    return affine


def to_canonical_lps(
    data: np.ndarray,
    affine: np.ndarray
) -> Tuple[np.ndarray, np.ndarray, Tuple[float, float, float]]:
    """
    Transforms arbitrary NIfTI/DICOM array and affine into canonical LPS+ (Z, Y, X) volume.
    Preserves exact 3D geometric chirality and physical orientation.
    
    Returns:
        vol_zyx: np.ndarray with shape (Z, Y, X) where:
            - z: Inferior -> Superior (0 = inferior, Z-1 = superior)
            - y: Anterior -> Posterior (0 = anterior/sternum, Y-1 = posterior/spine)
            - x: Right -> Left (0 = patient right, X-1 = patient left)
        affine_lps: 4x4 affine in LPS space
        spacing_zyx: (dz, dy, dx) voxel spacing in mm
    """
    # 1. Determine orientation transform from current affine to LPS
    orig_ornt = nib.io_orientation(affine)
    target_ornt = nib.orientations.axcodes2ornt(('L', 'P', 'S'))
    transform_ornt = nib.orientations.ornt_transform(orig_ornt, target_ornt)

    # 2. Apply orientation to voxel data
    if data.ndim == 4:
        data = data[..., 0]
    data_lps = nib.orientations.apply_orientation(data, transform_ornt)

    # 3. Compute new LPS affine
    affine_lps = nib.orientations.inv_ornt_aff(transform_ornt, data.shape) @ affine

    # 4. Extract physical spacing (dx, dy, dz) from affine
    zooms = nib.affines.voxel_sizes(affine_lps)
    dx, dy, dz = float(zooms[0]), float(zooms[1]), float(zooms[2])

    # 5. Transpose from (X, Y, Z) to (Z, Y, X) for standard axial slice indexing
    vol_zyx = np.transpose(data_lps, (2, 1, 0))
    spacing_zyx = (dz, dy, dx)

    return vol_zyx.astype(np.float32), affine_lps, spacing_zyx


def check_anatomical_orientation_sanity(
    vol_zyx: np.ndarray,
    modality: str = "CT",
    patient_position: str = "HFS"
) -> Dict[str, Any]:
    """
    Quality Assurance Audit:
    Evaluates whether high-density structures (>250 HU) in CT align with standard patient posture.
    Does NOT mutate or flip data (preserves physical provenance and chirality).
    """
    if str(modality).upper() != "CT":
        return {
            "status": "pass",
            "modality": modality,
            "anomaly_detected": False,
            "message": f"{modality} modality: Hounsfield unit bone distribution heuristics not applicable."
        }

    # In canonical LPS+ space (Z, Y, X), Y axis is strictly Anterior -> Posterior.
    # Therefore, regardless of whether the patient was scanned supine (HFS/FFS) or prone (HFP/FFP),
    # the anatomical spine is always posterior (higher Y indices, bottom half).
    pos = str(patient_position).upper()

    z_dim, y_dim, x_dim = vol_zyx.shape
    if z_dim < 5:
        return {"status": "pass", "anomaly_detected": False, "message": "Volume too small for landmark audit."}

    # Sample mid-thoracic/abdominal slices
    mid_start = int(z_dim * 0.35)
    mid_end = int(z_dim * 0.65)
    sample_slices = vol_zyx[mid_start:mid_end:2]

    half_y = y_dim // 2
    top_bone = int(np.sum(sample_slices[:, :half_y, :] > 250.0))
    bot_bone = int(np.sum(sample_slices[:, half_y:, :] > 250.0))

    if top_bone > bot_bone * 2.5 and top_bone > 1000:
        return {
            "status": "warning",
            "patient_position": pos,
            "anomaly_detected": True,
            "top_bone_voxels": top_bone,
            "bot_bone_voxels": bot_bone,
            "message": "解剖方位可疑异常：CT 骨质高密度区显著偏向前侧（胸壁侧），疑似头信息与实际体位不一致，建议人工复核。原始体素与坐标矩阵已完整保留。"
        }

    return {
        "status": "pass",
        "patient_position": pos,
        "anomaly_detected": False,
        "top_bone_voxels": top_bone,
        "bot_bone_voxels": bot_bone,
        "message": "解剖方位正常：高密度骨骼结构符合后侧（脊柱侧）分布。"
    }


def verify_and_enforce_anatomical_landmarks(vol_zyx: np.ndarray) -> np.ndarray:
    """
    Backward-compatible non-destructive spatial passthrough.
    Never alters voxel coordinates or swaps chirality.
    """
    return vol_zyx


def get_radiological_orientation_labels(plane: str = "axial") -> Dict[str, str]:
    """
    Returns international standard radiological compass labels for any viewport plane.
    """
    plane = plane.lower()
    if plane == "axial":
        return {
            "top": "A",      # Anterior (胸骨侧)
            "bottom": "P",   # Posterior (脊柱侧)
            "left": "R",     # Patient Right (患者右侧)
            "right": "L"     # Patient Left (患者左侧)
        }
    elif plane == "coronal":
        return {
            "top": "S",      # Superior (头侧)
            "bottom": "I",   # Inferior (足侧)
            "left": "R",     # Patient Right
            "right": "L"     # Patient Left
        }
    elif plane == "sagittal":
        return {
            "top": "S",      # Superior (头侧)
            "bottom": "I",   # Inferior (足侧)
            "left": "A",     # Anterior (胸骨侧)
            "right": "P"     # Posterior (脊柱侧)
        }
    return {"top": "", "bottom": "", "left": "", "right": ""}
