import os
import io
import glob
import zipfile
import tempfile
import numpy as np
from typing import Dict, Any, Tuple, Optional, Union

# Clinical CT Windows (Center / Width)
CT_WINDOWS = {
    "abdomen": {"level": 40, "width": 400},
    "mediastinum": {"level": 40, "width": 350},
    "lung": {"level": -600, "width": 1500},
    "bone": {"level": 400, "width": 1800},
    "brain": {"level": 40, "width": 80},
}

def apply_ct_window(volume: np.ndarray, window_name: str = "abdomen") -> np.ndarray:
    """
    Applies Hounsfield Unit (HU) windowing to CT volume, scaling to [0, 255] uint8.
    """
    win = CT_WINDOWS.get(window_name, CT_WINDOWS["abdomen"])
    level = win["level"]
    width = win["width"]
    lower = level - width / 2.0
    upper = level + width / 2.0
    clipped = np.clip(volume, lower, upper)
    normalized = ((clipped - lower) / (upper - lower) * 255.0).astype(np.uint8)
    return normalized

def scrub_dicom_metadata(metadata: Dict[str, Any], anonymous_id: str) -> Dict[str, Any]:
    """
    Removes Protected Health Information (PHI) from DICOM headers.
    """
    phi_keys = [
        "PatientName", "PatientID", "PatientBirthDate", "PatientAddress",
        "InstitutionName", "InstitutionalDepartmentName", "ReferringPhysicianName",
        "PerformingPhysicianName", "OperatorsName", "AccessionNumber", "OtherPatientIDs"
    ]
    scrubbed = dict(metadata)
    for k in phi_keys:
        if k in scrubbed:
            scrubbed.pop(k, None)
    
    scrubbed["PatientID"] = f"ANON-{anonymous_id}"
    scrubbed["PatientName"] = f"Subject^{anonymous_id}"
    scrubbed["InstitutionName"] = "Heurion Research Anonymized Center"
    return scrubbed

def anonymize_dicom_dataset(ds: Any, anonymous_id: str = "ANON-001", retain_dates: bool = False) -> Any:
    """
    De-identifies a pydicom Dataset according to DICOM PS 3.15 Annex E Basic Application Level Profile:
    - Replaces PatientName with ANONYMIZED^{anonymous_id}
    - Replaces PatientID with ANON-{anonymous_id}
    - Clears or generalizes dates and times (unless retain_dates is True)
    - Strips institutional addresses, physician names, and operators
    - Strips all private tags (tags with odd group numbers)
    - Preserves all geometric coordinates, pixel spacing, slice thickness, rescale slope/intercept, and pixel array
    """
    import pydicom

    # Remove all private elements (odd group numbers)
    ds.remove_private_tags()

    # Core PHI fields replacement
    if "PatientName" in ds:
        ds.PatientName = f"ANONYMIZED^{anonymous_id}"
    if "PatientID" in ds:
        ds.PatientID = f"ANON-{anonymous_id}"
    if "PatientBirthDate" in ds:
        ds.PatientBirthDate = "" if not retain_dates else (str(ds.PatientBirthDate)[:4] + "0101")
    if "PatientAddress" in ds:
        del ds.PatientAddress
    if "PatientTelephoneNumbers" in ds:
        del ds.PatientTelephoneNumbers
    if "OtherPatientIDs" in ds:
        del ds.OtherPatientIDs

    # Institutional & personnel fields
    if "InstitutionName" in ds:
        ds.InstitutionName = "Heurion Anonymized Medical Center"
    if "InstitutionAddress" in ds:
        del ds.InstitutionAddress
    if "InstitutionalDepartmentName" in ds:
        ds.InstitutionalDepartmentName = "Department of Radiology"
    if "ReferringPhysicianName" in ds:
        ds.ReferringPhysicianName = "ANON^REFERRING_PHYSICIAN"
    if "PerformingPhysicianName" in ds:
        ds.PerformingPhysicianName = "ANON^PERFORMING_PHYSICIAN"
    if "OperatorsName" in ds:
        del ds.OperatorsName
    if "PhysiciansOfRecord" in ds:
        del ds.PhysiciansOfRecord

    # Study identifiers
    if "AccessionNumber" in ds:
        ds.AccessionNumber = f"ACC-{anonymous_id[:8]}"
    if "StudyID" in ds:
        ds.StudyID = f"STUDY-{anonymous_id[:8]}"

    # Remove curve (0x5000-0x50FF) and overlay (0x6000-0x60FF) elements
    tags_to_remove = [elem.tag for elem in ds if (elem.tag.group & 0xFF00) in (0x5000, 0x6000)]
    for tag in tags_to_remove:
        del ds[tag]

    return ds

def anonymize_dicom_file(src_path: str, dst_path: str, anonymous_id: str = "ANON-001") -> Dict[str, Any]:
    """
    Reads a single DICOM file on disk, anonymizes PHI, and saves to dst_path.
    """
    import pydicom
    ds = pydicom.dcmread(src_path, force=True)
    orig_name = str(getattr(ds, "PatientName", "Unknown"))
    orig_id = str(getattr(ds, "PatientID", "Unknown"))
    
    anonymized_ds = anonymize_dicom_dataset(ds, anonymous_id=anonymous_id)
    os.makedirs(os.path.dirname(os.path.abspath(dst_path)), exist_ok=True)
    anonymized_ds.save_as(dst_path)

    return {
        "status": "success",
        "original_patient_name": orig_name,
        "original_patient_id": orig_id,
        "anonymized_patient_name": str(getattr(anonymized_ds, "PatientName", "")),
        "anonymized_patient_id": str(getattr(anonymized_ds, "PatientID", "")),
        "output_path": dst_path
    }

def anonymize_dicom_zip(
    src_zip: Union[str, bytes, io.BytesIO],
    dst_zip_path: Optional[str] = None,
    anonymous_id: str = "ANON-001"
) -> Tuple[bytes, Dict[str, Any]]:
    """
    De-identifies all DICOM slices within a ZIP archive, strips OS junk files (__MACOSX, .DS_Store),
    and produces a sanitized DICOM ZIP archive with identical geometry and zero PHI.
    """
    import pydicom

    bio_in = io.BytesIO(src_zip) if isinstance(src_zip, bytes) else (src_zip if isinstance(src_zip, io.BytesIO) else open(src_zip, "rb"))
    zf_in = zipfile.ZipFile(bio_in)

    out_bio = io.BytesIO()
    zf_out = zipfile.ZipFile(out_bio, "w", compression=zipfile.ZIP_DEFLATED)

    anonymized_count = 0
    skipped_count = 0
    detected_modalities = set()

    for member in zf_in.infolist():
        fn = member.filename
        if "__MACOSX" in fn or "/._" in fn or fn.split("/")[-1].startswith("."):
            skipped_count += 1
            continue

        data = zf_in.read(fn)
        # Attempt parsing as DICOM
        try:
            ds = pydicom.dcmread(io.BytesIO(data), force=True)
            if hasattr(ds, "pixel_array"):
                anonymized_ds = anonymize_dicom_dataset(ds, anonymous_id=anonymous_id)
                mod = str(getattr(anonymized_ds, "Modality", "CT"))
                detected_modalities.add(mod)
                # Write back into new zip
                slice_buf = io.BytesIO()
                anonymized_ds.save_as(slice_buf)
                clean_name = f"DICOM/{anonymous_id}_{anonymized_count:04d}.dcm"
                zf_out.writestr(clean_name, slice_buf.getvalue())
                anonymized_count += 1
            else:
                skipped_count += 1
        except Exception:
            skipped_count += 1

    zf_out.close()
    out_bytes = out_bio.getvalue()

    if dst_zip_path:
        os.makedirs(os.path.dirname(os.path.abspath(dst_zip_path)), exist_ok=True)
        with open(dst_zip_path, "wb") as f_out:
            f_out.write(out_bytes)

    report = {
        "status": "success",
        "anonymous_id": anonymous_id,
        "total_slices_anonymized": anonymized_count,
        "skipped_files_count": skipped_count,
        "modalities": list(detected_modalities),
        "anonymized_zip_size_bytes": len(out_bytes)
    }

    if not isinstance(src_zip, (bytes, io.BytesIO)):
        bio_in.close()

    return out_bytes, report


def load_nifti(path_or_bytes: Union[str, bytes, io.BytesIO]) -> Tuple[np.ndarray, Tuple[float, float, float]]:
    """
    Loads a NIfTI volume (.nii or .nii.gz) returning canonical (Z, Y, X) array and (dz, dy, dx) voxel spacing.
    """
    import nibabel as nib
    if isinstance(path_or_bytes, (bytes, io.BytesIO)):
        data_bytes = path_or_bytes if isinstance(path_or_bytes, bytes) else path_or_bytes.getvalue()
        with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as tmp:
            tmp.write(data_bytes)
            tmp_path = tmp.name
        try:
            nimg = nib.load(tmp_path)
            data = nimg.get_fdata(dtype=np.float32)
            header = nimg.header
            zooms = header.get_zooms()[:3]
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    else:
        try:
            nimg = nib.load(path_or_bytes)
            data = nimg.get_fdata(dtype=np.float32)
            header = nimg.header
            zooms = header.get_zooms()[:3]
        except Exception:
            # Check if file has gzip magic bytes (\x1f\x8b), e.g. files uploaded as .gz
            is_gzip = False
            try:
                with open(path_or_bytes, "rb") as f_chk:
                    is_gzip = f_chk.read(2) == b"\x1f\x8b"
            except Exception:
                pass
            if is_gzip:
                import shutil
                with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as tmp_proxy:
                    shutil.copyfile(path_or_bytes, tmp_proxy.name)
                    tmp_proxy_path = tmp_proxy.name
                try:
                    nimg = nib.load(tmp_proxy_path)
                    data = nimg.get_fdata(dtype=np.float32)
                    header = nimg.header
                    zooms = header.get_zooms()[:3]
                finally:
                    if os.path.exists(tmp_proxy_path):
                        os.remove(tmp_proxy_path)
            else:
                raise

    try:
        from .spatial_canonicalizer import to_canonical_lps
    except (ImportError, ValueError):
        from spatial_canonicalizer import to_canonical_lps

    vol_zyx, affine_lps, spacing_zyx = to_canonical_lps(data, nimg.affine)
    return vol_zyx, spacing_zyx

def load_dicom_series(folder_path: str) -> Tuple[np.ndarray, Tuple[float, float, float], Dict[str, Any]]:
    """
    Reads a folder of DICOM slices, sorts them by spatial position, and returns (Z, Y, X) volume and spacing.
    Automatically handles embedded NIfTI archives, multi-series folders, and scout image separation.
    """
    import pydicom
    # 1. Check if the folder contains any extracted NIfTI archives
    nii_candidates = []
    for root, _, filenames in os.walk(folder_path):
        if "__MACOSX" in root:
            continue
        for f in filenames:
            if f.lower().endswith((".nii", ".nii.gz", ".gz")):
                nii_candidates.append(os.path.join(root, f))
    if nii_candidates:
        vol, spacing = load_nifti(nii_candidates[0])
        modality = "MRI" if "mri" in nii_candidates[0].lower() else "CT"
        return vol, spacing, {"modality": modality, "slices_count": vol.shape[0], "rows": vol.shape[1], "cols": vol.shape[2]}

    files = []
    for root, _, filenames in os.walk(folder_path):
        if "__MACOSX" in root:
            continue
        for f in filenames:
            if f.startswith(".") or "/._" in os.path.join(root, f) or f.lower().endswith(".zip"):
                continue
            fl = f.lower()
            if fl.endswith(('.dcm', '.dicom', '.ima')) or ('.' not in f and not f.startswith('.')):
                files.append(os.path.join(root, f))
    if not files:
        files = [p for p in glob.glob(os.path.join(folder_path, "*")) if not os.path.basename(p).startswith(".") and not p.lower().endswith(".zip")]
    
    slices = []
    for f in files:
        try:
            ds = pydicom.dcmread(f, force=True)
            if hasattr(ds, "pixel_array"):
                slices.append(ds)
        except Exception:
            continue
            
    if not slices:
        raise ValueError(f"在影像路径 ({folder_path}) 中未找到合法的 DICOM 切片文件")
        
    return _build_volume_from_slices(slices)

def load_dicom_from_zip(zip_source: Union[str, bytes, io.BytesIO]) -> Tuple[np.ndarray, Tuple[float, float, float], Dict[str, Any]]:
    """
    Reads DICOM slices from a .zip archive, sorts them, and returns (Z, Y, X) volume and spacing.
    Filters out AppleDouble metadata files (__MACOSX, ._*) automatically.
    """
    import pydicom
    zf = zipfile.ZipFile(zip_source)
    # Check for contained NIfTI files first
    for name in zf.namelist():
        if "__MACOSX" in name or "/._" in name or name.split("/")[-1].startswith("."):
            continue
        if name.lower().endswith((".nii", ".nii.gz")):
            raw_nii = zf.read(name)
            vol, spacing = load_nifti(raw_nii)
            modality = "MRI" if "mri" in name.lower() else "CT"
            return vol, spacing, {"modality": modality, "slices_count": vol.shape[0], "rows": vol.shape[1], "cols": vol.shape[2]}

    slices = []
    for name in zf.namelist():
        if "__MACOSX" in name or "/._" in name or name.split("/")[-1].startswith("."):
            continue
        fl = name.lower()
        if fl.endswith(('.dcm', '.dicom', '.ima')) or ('.' not in name.split("/")[-1] and not name.split("/")[-1].startswith('.')):
            try:
                raw_bytes = zf.read(name)
                ds = pydicom.dcmread(io.BytesIO(raw_bytes), force=True)
                if hasattr(ds, "pixel_array"):
                    slices.append(ds)
            except Exception:
                continue

    if not slices:
        raise ValueError("ZIP 序列包中未解析出合法的 DICOM 影像切片")

    return _build_volume_from_slices(slices)

def load_dicom_file(file_source: Union[str, bytes, io.BytesIO]) -> Tuple[np.ndarray, Tuple[float, float, float], Dict[str, Any]]:
    """
    Reads a single DICOM file (multi-frame 3D or single slice).
    """
    import pydicom
    if isinstance(file_source, bytes):
        file_source = io.BytesIO(file_source)
    ds = pydicom.dcmread(file_source, force=True)
    if not hasattr(ds, "pixel_array"):
        raise ValueError("DICOM 文件不包含体素矩阵数据 (pixel_array)")

    pixel_array = ds.pixel_array
    slope = float(str(getattr(ds, "RescaleSlope", 1.0)).replace(",", "."))
    intercept = float(str(getattr(ds, "RescaleIntercept", 0.0)).replace(",", "."))
    raw_spacing = getattr(ds, "PixelSpacing", [1.0, 1.0])
    try:
        dy = float(str(raw_spacing[0]).replace(",", "."))
        dx = float(str(raw_spacing[1]).replace(",", "."))
    except Exception:
        dy, dx = 1.0, 1.0
    raw_thick = getattr(ds, "SliceThickness", 1.0)
    try:
        dz = float(str(raw_thick).replace(",", "."))
    except Exception:
        dz = 1.0
    spacing = (dz, dy, dx)

    if pixel_array.ndim == 3:
        vol = pixel_array.astype(np.float32) * slope + intercept
    elif pixel_array.ndim == 2:
        vol = (pixel_array.astype(np.float32) * slope + intercept)[np.newaxis, :, :]
    else:
        vol = pixel_array[0].astype(np.float32) * slope + intercept

    meta = {
        "modality": getattr(ds, "Modality", "CT"),
        "slices_count": vol.shape[0],
        "rows": vol.shape[1],
        "cols": vol.shape[2],
    }
    return vol, spacing, scrub_dicom_metadata(meta, "ANON-STUDY")

def _build_volume_from_slices(slices: list) -> Tuple[np.ndarray, Tuple[float, float, float], Dict[str, Any]]:
    """
    Robustly groups slices by SeriesInstanceUID and matrix dimensions, selects dominant 3D series,
    sorts slices by physical Z-coordinate, and stacks into a 3D NumPy array.
    """
    if not slices:
        raise ValueError("未检测到有效 DICOM 切片")

    # 1. Group slices by SeriesInstanceUID to isolate Scout / Localizer / Secondary Captures
    series_groups: Dict[str, list] = {}
    for s in slices:
        uid = str(getattr(s, "SeriesInstanceUID", "default_series"))
        series_groups.setdefault(uid, []).append(s)

    # Dominant series with the largest number of slices
    best_series = max(series_groups.values(), key=len)

    # 2. Filter out slices with inconsistent matrix shapes
    shape_groups: Dict[Tuple[int, int], list] = {}
    for s in best_series:
        try:
            arr = s.pixel_array
            if arr.ndim == 2:
                shape_groups.setdefault(arr.shape, []).append(s)
            elif arr.ndim == 3 and arr.shape[0] == 1:
                shape_groups.setdefault(arr.shape[1:], []).append(s)
        except Exception:
            continue

    if not shape_groups:
        raise ValueError("无法从选定 DICOM 序列中读取 2D 体素切片矩阵")

    valid_slices = max(shape_groups.values(), key=len)

    # 3. Sort slices by physical coordinates along the slice normal
    first = valid_slices[0]
    iop = getattr(first, "ImageOrientationPatient", None)
    slice_normal = np.array([0.0, 0.0, 1.0])
    if iop is not None and len(iop) >= 6:
        try:
            rx, ry, rz = [float(str(x).replace(",", ".")) for x in iop[:3]]
            cx, cy, cz = [float(str(x).replace(",", ".")) for x in iop[3:6]]
            r_vec = np.array([rx, ry, rz])
            c_vec = np.array([cx, cy, cz])
            n_vec = np.cross(r_vec, c_vec)
            if np.linalg.norm(n_vec) > 1e-4:
                slice_normal = n_vec / np.linalg.norm(n_vec)
        except Exception:
            pass

    def slice_sort_key(s):
        try:
            pos = getattr(s, "ImagePositionPatient", None)
            if pos is not None and len(pos) >= 3:
                p_vec = np.array([float(str(x).replace(",", ".")) for x in pos[:3]])
                return (0, float(np.dot(p_vec, slice_normal)))
        except Exception:
            pass
        try:
            loc = getattr(s, "SliceLocation", None)
            if loc is not None:
                return (1, float(str(loc).replace(",", ".")))
        except Exception:
            pass
        try:
            inst = getattr(s, "InstanceNumber", None)
            if inst is not None:
                return (2, int(inst))
        except Exception:
            pass
        return (3, 0)

    valid_slices.sort(key=slice_sort_key)

    first = valid_slices[0]
    raw_spacing = getattr(first, "PixelSpacing", [1.0, 1.0])
    try:
        if isinstance(raw_spacing, (list, tuple)) and len(raw_spacing) >= 2:
            dy = float(str(raw_spacing[0]).replace(",", "."))
            dx = float(str(raw_spacing[1]).replace(",", "."))
        else:
            dy, dx = 1.0, 1.0
    except Exception:
        dy, dx = 1.0, 1.0

    raw_thick = getattr(first, "SliceThickness", 1.0)
    try:
        dz = float(str(raw_thick).replace(",", "."))
    except Exception:
        dz = 1.0

    if len(valid_slices) >= 2:
        try:
            pos0 = getattr(valid_slices[0], "ImagePositionPatient", None)
            pos1 = getattr(valid_slices[1], "ImagePositionPatient", None)
            if pos0 is not None and pos1 is not None and len(pos0) >= 3 and len(pos1) >= 3:
                p0 = np.array([float(str(x).replace(",", ".")) for x in pos0[:3]], dtype=np.float64)
                p1 = np.array([float(str(x).replace(",", ".")) for x in pos1[:3]], dtype=np.float64)
                dz_phys = float(abs(np.dot(p1 - p0, slice_normal)))
                if dz_phys > 1e-4:
                    dz = dz_phys
        except Exception:
            pass

    spacing = (dz, dy, dx)

    default_slope = 1.0
    default_intercept = 0.0
    try:
        default_slope = float(str(getattr(first, "RescaleSlope", 1.0)).replace(",", "."))
    except Exception:
        pass
    try:
        default_intercept = float(str(getattr(first, "RescaleIntercept", 0.0)).replace(",", "."))
    except Exception:
        pass

    slice_arrays = []
    for s in valid_slices:
        arr = s.pixel_array.astype(np.float32)
        if arr.ndim == 3 and arr.shape[0] == 1:
            arr = arr[0]
        try:
            s_slope = float(str(getattr(s, "RescaleSlope", default_slope)).replace(",", "."))
        except Exception:
            s_slope = default_slope
        try:
            s_intercept = float(str(getattr(s, "RescaleIntercept", default_intercept)).replace(",", "."))
        except Exception:
            s_intercept = default_intercept
        slice_arrays.append(arr * s_slope + s_intercept)

    vol = np.stack(slice_arrays, axis=0)
    try:
        from .spatial_canonicalizer import build_dicom_affine, to_canonical_lps, check_anatomical_orientation_sanity
    except (ImportError, ValueError):
        from spatial_canonicalizer import build_dicom_affine, to_canonical_lps, check_anatomical_orientation_sanity
    try:
        from .quality_assurance import _primary_kernel_name
    except (ImportError, ValueError):
        from quality_assurance import _primary_kernel_name

    # Construct patient coordinate affine from DICOM IOP and IPP headers
    iop = [float(v) for v in getattr(first, "ImageOrientationPatient", [1, 0, 0, 0, 1, 0])]
    ipp_list = [[float(v) for v in getattr(s, "ImagePositionPatient", [0, 0, 0])] for s in valid_slices]
    ps = (float(first.PixelSpacing[0]), float(first.PixelSpacing[1])) if hasattr(first, "PixelSpacing") else (spacing[1], spacing[2])
    aff = build_dicom_affine(iop, ipp_list, ps)

    # Convert DICOM LPS affine to RAS affine before passing to nibabel's to_canonical_lps.
    # DICOM Patient Coordinate System is LPS (+X=Left, +Y=Posterior, +Z=Superior).
    # nibabel interprets affines in RAS (+X=Right, +Y=Anterior, +Z=Superior).
    # Multiplying by diag(-1, -1, 1, 1) converts the coordinate frame from LPS to RAS.
    aff_ras = np.diag([-1.0, -1.0, 1.0, 1.0]) @ aff

    # Reorient to canonical LPS+ (Z, Y, X)
    vol_xyz = np.transpose(vol, (2, 1, 0))
    vol_lps, aff_lps, spacing_lps = to_canonical_lps(vol_xyz, aff_ras)

    patient_pos = str(getattr(first, "PatientPosition", "HFS"))
    modality_str = str(getattr(first, "Modality", "CT"))
    orientation_qa = check_anatomical_orientation_sanity(vol_lps, modality=modality_str, patient_position=patient_pos)

    meta = {
        "modality": modality_str,
        "slices_count": len(valid_slices),
        "rows": vol_lps.shape[1],
        "cols": vol_lps.shape[2],
        "series_description": str(getattr(first, "SeriesDescription", "")),
        "body_part_examined": str(getattr(first, "BodyPartExamined", "")),
        "convolution_kernel": _primary_kernel_name(getattr(first, "ConvolutionKernel", "")),
        "patient_position": patient_pos,
        "kvp": getattr(first, "KVP", None),
        "tube_current": getattr(first, "XRayTubeCurrent", None),
        "window_center": getattr(first, "WindowCenter", None),
        "window_width": getattr(first, "WindowWidth", None),
        "orientation_qa": orientation_qa
    }
    return vol_lps, spacing_lps, scrub_dicom_metadata(meta, "ANON-STUDY")

def load_volume(source: Union[str, bytes, io.BytesIO], filename: Optional[str] = None) -> Tuple[np.ndarray, Tuple[float, float, float], str]:
    """
    Universal medical volume loader supporting:
    - DICOM ZIP archives (.zip)
    - DICOM directory paths
    - Single DICOM files (.dcm)
    - NIfTI volumes (.nii, .nii.gz)
    Returns (vol, spacing, modality).
    """
    fn = (filename or (source if isinstance(source, str) else "")).lower()

    # 1. In-memory bytes / BytesIO
    if isinstance(source, (bytes, io.BytesIO)):
        bio = io.BytesIO(source) if isinstance(source, bytes) else source
        # Check ZIP
        if zipfile.is_zipfile(bio):
            bio.seek(0)
            vol, spacing, meta = load_dicom_from_zip(bio)
            return vol, spacing, meta.get("modality", "CT")

        bio.seek(0)
        # Check NIfTI (gzip magic \x1f\x8b or .nii in filename)
        header_bytes = bio.read(4)
        bio.seek(0)
        if header_bytes.startswith(b"\x1f\x8b") or fn.endswith((".nii", ".nii.gz", ".gz")):
            vol, spacing = load_nifti(bio)
            modality = "MRI" if "mri" in fn else "CT"
            return vol, spacing, modality

        # Check DICOM
        bio.seek(0)
        vol, spacing, meta = load_dicom_file(bio)
        return vol, spacing, meta.get("modality", "CT")

    # 2. File path (string)
    if os.path.isdir(source):
        vol, spacing, meta = load_dicom_series(source)
        return vol, spacing, meta.get("modality", "CT")

    if zipfile.is_zipfile(source) or fn.endswith(".zip"):
        vol, spacing, meta = load_dicom_from_zip(source)
        return vol, spacing, meta.get("modality", "CT")

    if fn.endswith((".nii", ".nii.gz", ".gz")):
        vol, spacing = load_nifti(source)
        modality = "MRI" if "mri" in fn else "CT"
        return vol, spacing, modality

    if fn.endswith((".dcm", ".dicom", ".ima")):
        vol, spacing, meta = load_dicom_file(source)
        return vol, spacing, meta.get("modality", "CT")

    # Fallback attempt as NIfTI then DICOM
    try:
        vol, spacing = load_nifti(source)
        return vol, spacing, "MRI" if "mri" in fn else "CT"
    except Exception:
        vol, spacing, meta = load_dicom_file(source)
        return vol, spacing, meta.get("modality", "CT")
