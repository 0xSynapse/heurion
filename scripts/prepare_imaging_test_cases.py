#!/usr/bin/env python3
"""
Medical Imaging Test Data Packager for Heurion
Organizes and generates authentic clinical DICOM series & NIfTI files
structured by patient into a dedicated user folder.
"""

import os
import sys
import shutil
import zipfile
import urllib.request
import json
from pathlib import Path
import numpy as np
import nibabel as nib
import pydicom
from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

BASE_DIR = Path("/Users/huizhao/Downloads/medical_imaging_test_cases")
SOURCE_DATA = Path(__file__).resolve().parent.parent / "apps" / "imaging-worker" / "data"

def create_dicom_slice(
    pixel_slice: np.ndarray,
    output_path: Path,
    patient_id: str,
    patient_name: str,
    patient_sex: str,
    birth_date: str,
    study_date: str,
    study_time: str,
    modality: str,
    study_desc: str,
    series_desc: str,
    study_uid: str,
    series_uid: str,
    slice_idx: int,
    total_slices: int,
    pixel_spacing: tuple,
    slice_thickness: float,
    slice_location: float,
    window_center: int,
    window_width: int,
    rescale_intercept: float = 0.0,
    rescale_slope: float = 1.0,
):
    sop_class_uid = "1.2.840.10008.5.1.4.1.1.2" if modality == "CT" else "1.2.840.10008.5.1.4.1.1.4"
    sop_instance_uid = generate_uid()

    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = sop_class_uid
    meta.MediaStorageSOPInstanceUID = sop_instance_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    meta.ImplementationClassUID = "1.2.826.0.1.3680043.9.7133.1.1"
    meta.FileMetaInformationVersion = b"\x00\x01"

    ds = FileDataset(str(output_path), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    # Patient tags
    ds.PatientName = patient_name
    ds.PatientID = patient_id
    ds.PatientBirthDate = birth_date
    ds.PatientSex = patient_sex

    # Study / Series tags
    ds.StudyDate = study_date
    ds.StudyTime = study_time
    ds.AccessionNumber = f"ACC-{patient_id}-{study_date}"
    ds.Modality = modality
    ds.StudyDescription = study_desc
    ds.SeriesDescription = series_desc
    ds.Manufacturer = "Heurion Medical Instruments & Imaging"
    ds.InstitutionName = "Heurion Medical Center / 临床影像研发中心"
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.SOPInstanceUID = sop_instance_uid
    ds.SOPClassUID = sop_class_uid
    ds.InstanceNumber = slice_idx + 1

    # Geometry tags
    rows, cols = pixel_slice.shape
    ds.Rows = rows
    ds.Columns = cols
    ds.PixelSpacing = [float(pixel_spacing[0]), float(pixel_spacing[1])]
    ds.SliceThickness = float(slice_thickness)
    ds.SliceLocation = float(slice_location)
    ds.ImagePositionPatient = [
        -float(cols * pixel_spacing[1] / 2.0),
        -float(rows * pixel_spacing[0] / 2.0),
        float(slice_location),
    ]
    ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]

    # Pixel Presentation & Calibration
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15

    if modality == "CT":
        # Signed int16 for HU (-1024 ~ 3071)
        ds.PixelRepresentation = 1
        ds.RescaleIntercept = float(rescale_intercept)
        ds.RescaleSlope = float(rescale_slope)
        pixel_data = np.clip(pixel_slice, -1024, 3071).astype(np.int16)
    else:
        # Unsigned int16 for MRI
        ds.PixelRepresentation = 0
        ds.RescaleIntercept = 0.0
        ds.RescaleSlope = 1.0
        pixel_data = np.clip(pixel_slice, 0, 65535).astype(np.uint16)

    ds.WindowCenter = window_center
    ds.WindowWidth = window_width
    ds.PixelData = pixel_data.tobytes()

    ds.save_as(str(output_path), write_like_original=False)


def convert_nifti_to_dicom(
    nii_path: Path,
    out_dicom_dir: Path,
    patient_id: str,
    patient_name: str,
    patient_sex: str,
    birth_date: str,
    study_date: str,
    study_time: str,
    modality: str,
    study_desc: str,
    series_desc: str,
    window_center: int,
    window_width: int,
    volume_transform_fn=None,
):
    out_dicom_dir.mkdir(parents=True, exist_ok=True)
    img = nib.load(str(nii_path))
    data = img.get_fdata(dtype=np.float32)
    if data.ndim == 4:
        data = data[..., 0]

    if volume_transform_fn:
        data = volume_transform_fn(data)

    zooms = img.header.get_zooms()[:3]
    dx, dy, dz = float(zooms[0]), float(zooms[1]), float(zooms[2])

    study_uid = generate_uid()
    series_uid = generate_uid()

    num_slices = data.shape[2]
    print(f"  -> Converting {nii_path.name} ({data.shape}) to {num_slices} DICOM slices in {out_dicom_dir.name}...")

    prefix = "CT" if modality == "CT" else "MR"
    for z in range(num_slices):
        slice_2d = np.rot90(data[:, :, z]) # orient upright
        slice_loc = (z - num_slices / 2.0) * dz
        out_file = out_dicom_dir / f"{prefix}_{z+1:04d}.dcm"
        create_dicom_slice(
            pixel_slice=slice_2d,
            output_path=out_file,
            patient_id=patient_id,
            patient_name=patient_name,
            patient_sex=patient_sex,
            birth_date=birth_date,
            study_date=study_date,
            study_time=study_time,
            modality=modality,
            study_desc=study_desc,
            series_desc=series_desc,
            study_uid=study_uid,
            series_uid=series_uid,
            slice_idx=z,
            total_slices=num_slices,
            pixel_spacing=(dx, dy),
            slice_thickness=dz,
            slice_location=slice_loc,
            window_center=window_center,
            window_width=window_width,
        )


def write_test_info(case_dir: Path, test_id: str, source: str, notes: list) -> None:
    """写出测试用例说明。只写数据来源与用途，不编造任何临床信息（姓名、主诉、诊断、分期、疗效等）。"""
    info = {
        "test_id": test_id,
        "data_source": source,
        "clinical_information": "无：公开数据集样本不附带临床信息，DICOM 头中的姓名与日期均为测试占位值",
        "notes": notes,
    }
    (case_dir / "patient_info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = "\n".join(f"- {n}" for n in notes)
    (case_dir / "README.md").write_text(
        f"# 测试用例 {test_id}\n\n- **数据来源**：{source}\n"
        f"- **临床信息**：无（DICOM 头中的姓名与日期均为测试占位值）\n\n## 说明\n{lines}\n",
        encoding="utf-8",
    )


def main():
    print("==================================================================")
    print("🚀 Heurion 原始医学影像测试文件生成与归档系统")
    print(f"目标目录: {BASE_DIR}")
    print("==================================================================")

    BASE_DIR.mkdir(parents=True, exist_ok=True)

    # -------------------------------------------------------------
    # 1. 测试用例 01 · 公开胸部 CT 样本
    # -------------------------------------------------------------
    p1_base_dir = BASE_DIR / "01_Test_Chest_CT"
    p1_base_dcm = p1_base_dir / "dicom"
    p1_base_nii = p1_base_dir / "nifti"
    p1_base_nii.mkdir(parents=True, exist_ok=True)

    shutil.copyfile(SOURCE_DATA / "chest_lung_ct.nii.gz", p1_base_nii / "chest_lung_baseline.nii.gz")
    convert_nifti_to_dicom(
        nii_path=SOURCE_DATA / "chest_lung_ct.nii.gz",
        out_dicom_dir=p1_base_dcm,
        patient_id="P-1001",
        patient_name="TEST^CHEST001",
        patient_sex="M",
        birth_date="19740518",
        study_date="20260315",
        study_time="093000",
        modality="CT",
        study_desc="Thorax HRCT Routine Scan (Chest Lung)",
        series_desc="Axial Lung Window 1.25mm Baseline",
        window_center=-600,
        window_width=1500,
    )

    write_test_info(p1_base_dir, "TEST-CHEST-001", "公开数据集样本 chest_lung_ct（胸部 CT）", [
        "用于测试上传、DICOM 解析、三正交 MPR 与 NiiVue 渲染",
        "样本不附带病灶标注或临床结论，算法输出需自行核对",
    ])

    # -------------------------------------------------------------
    # 2. 测试用例 01 · 人工合成的第二期数据（不是真实随访）
    # -------------------------------------------------------------
    p1_fup_dir = BASE_DIR / "01_Test_Chest_CT_Synthetic_Second_Phase"
    p1_fup_dcm = p1_fup_dir / "dicom"
    p1_fup_nii = p1_fup_dir / "nifti"
    p1_fup_nii.mkdir(parents=True, exist_ok=True)

    # 合成第二期数据：仅用于测试双期对比界面，不是真实随访，也不代表任何治疗效果
    def simulate_followup_absorption(vol: np.ndarray) -> np.ndarray:
        vol_copy = vol.copy()
        # 把 65–130 HU 体素按固定公式衰减（人工构造的差异）
        mask = (vol_copy > 65.0) & (vol_copy < 130.0)
        vol_copy[mask] = vol_copy[mask] * 0.45 - 250.0  # 人工衰减
        return vol_copy

    img_fup = nib.load(str(SOURCE_DATA / "chest_lung_ct.nii.gz"))
    fup_data = simulate_followup_absorption(img_fup.get_fdata(dtype=np.float32))
    fup_nii_obj = nib.Nifti1Image(fup_data, img_fup.affine, img_fup.header)
    nib.save(fup_nii_obj, str(p1_fup_nii / "chest_lung_followup.nii.gz"))

    convert_nifti_to_dicom(
        nii_path=p1_fup_nii / "chest_lung_followup.nii.gz",
        out_dicom_dir=p1_fup_dcm,
        patient_id="P-1001",
        patient_name="TEST^CHEST001",
        patient_sex="M",
        birth_date="19740518",
        study_date="20260620",
        study_time="141500",
        modality="CT",
        study_desc="SYNTHETIC second phase (not a real follow-up)",
        series_desc="Synthetic HU attenuation test",
        window_center=-600,
        window_width=1500,
    )

    write_test_info(p1_fup_dir, "TEST-CHEST-001-SYNTH", "由 chest_lung_ct 人工合成（把 65–130 HU 体素按固定公式衰减）", [
        "这是合成数据，不是真实随访扫描，不代表任何治疗效果",
        "仅用于测试双期对比界面与差分图功能是否能运行",
    ])

    # -------------------------------------------------------------
    # 3. 测试用例 02 · 公开腹部 CT 样本
    # -------------------------------------------------------------
    p2_dir = BASE_DIR / "02_Test_Abdomen_CT"
    p2_dcm = p2_dir / "dicom"
    p2_nii = p2_dir / "nifti"
    p2_nii.mkdir(parents=True, exist_ok=True)

    shutil.copyfile(SOURCE_DATA / "spleen_test.nii.gz", p2_nii / "abdomen_spleen_ct.nii.gz")
    convert_nifti_to_dicom(
        nii_path=SOURCE_DATA / "spleen_test.nii.gz",
        out_dicom_dir=p2_dcm,
        patient_id="P-1002",
        patient_name="TEST^ABDOMEN002",
        patient_sex="M",
        birth_date="19800822",
        study_date="20260410",
        study_time="102000",
        modality="CT",
        study_desc="Abdomen & Pelvis Plain CT Scan",
        series_desc="Abdominal Soft Tissue 5.0mm",
        window_center=40,
        window_width=400,
    )

    write_test_info(p2_dir, "TEST-ABDOMEN-002", "公开数据集样本 spleen_test（腹部 CT）", [
        "用于测试腹部窗显示与 MONAI 脾脏分割",
        "样本不附带临床信息，不要据此写任何诊断描述",
    ])

    # -------------------------------------------------------------
    # 4. 测试用例 03 · 公开前列腺 T2 MRI 样本
    # -------------------------------------------------------------
    p3_dir = BASE_DIR / "03_Test_Prostate_MRI"
    p3_dcm = p3_dir / "dicom"
    p3_nii = p3_dir / "nifti"
    p3_nii.mkdir(parents=True, exist_ok=True)

    shutil.copyfile(SOURCE_DATA / "prostate_mri.nii.gz", p3_nii / "prostate_t2_mri.nii.gz")
    convert_nifti_to_dicom(
        nii_path=SOURCE_DATA / "prostate_mri.nii.gz",
        out_dicom_dir=p3_dcm,
        patient_id="P-1003",
        patient_name="TEST^PROSTATE003",
        patient_sex="M",
        birth_date="19611105",
        study_date="20260512",
        study_time="160500",
        modality="MR",
        study_desc="Prostate Multiparametric MRI Exam",
        series_desc="T2 TSE Axial Thin 3.0mm",
        window_center=500,
        window_width=1000,
    )

    write_test_info(p3_dir, "TEST-PROSTATE-003", "公开数据集样本 prostate_mri（盆腔 T2 MRI）", [
        "用于测试 MR 模态显示与窗宽调节",
        "MONAI 前列腺模型在该样本上目前输出为空，不要据此写分区或评分结论",
    ])

    # -------------------------------------------------------------
    # 5. TCIA 真实肺癌 CT 数据集 (Patient 04: TCIA 4D-Lung)
    # -------------------------------------------------------------
    p4_dir = BASE_DIR / "04_Patient_TCIA_100_HM10395_Lung_Cancer_CT"
    p4_dcm = p4_dir / "dicom"
    p4_dcm.mkdir(parents=True, exist_ok=True)

    print("  -> Downloading authentic clinical DICOM series from TCIA (4D-Lung: 100_HM10395)...")
    tcia_url = "https://services.cancerimagingarchive.net/nbia-api/services/v1/getImage?SeriesInstanceUID=1.3.6.1.4.1.14519.5.2.1.6834.5010.189721824525842725510380467695"
    zip_path = p4_dir / "tcia_download.zip"
    try:
        req = urllib.request.Request(tcia_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp, open(zip_path, "wb") as f_out:
            shutil.copyfileobj(resp, f_out)

        with zipfile.ZipFile(zip_path, "r") as zf:
            for member in zf.infolist():
                if member.filename.endswith(".dcm"):
                    zf.extract(member, p4_dcm)
                elif member.filename == "LICENSE":
                    zf.extract(member, p4_dir)
        if zip_path.exists():
            zip_path.unlink()
        print(f"  -> Successfully extracted {len(list(p4_dcm.glob('*.dcm')))} DICOM slices from TCIA.")
    except Exception as e:
        print(f"  -> Note: TCIA remote download encountered {e}, copying cached sample.")
        if Path("/tmp/tcia_test/series.zip").exists():
            with zipfile.ZipFile("/tmp/tcia_test/series.zip", "r") as zf:
                for member in zf.infolist():
                    if member.filename.endswith(".dcm"):
                        zf.extract(member, p4_dcm)
                    elif member.filename == "LICENSE":
                        zf.extract(member, p4_dir)

    (p4_dir / "patient_info.json").write_text(json.dumps({
        "patient_id": "100_HM10395",
        "dataset_source": "The Cancer Imaging Archive (TCIA) - 4D-Lung Collection",
        "modality": "CT",
        "body_part": "Thorax / Lung",
        "series_description": "P4^P100^S113^I0, Gated, 70.0%",
        "slice_count": len(list(p4_dcm.glob("*.dcm"))),
        "license": "Creative Commons Attribution 3.0 Unported (CC BY 3.0)",
        "recommended_tests": [
            "测试第三方医院真实原生 PACS 导出 DICOM 文件的兼容性",
            "测试机房复杂 DICOM Header 字段的解析与脱敏"
        ]
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    (p4_dir / "README.md").write_text("""# 患者 04: TCIA 真实肺癌 4D-CT 临床序列

- **患者代号**: `100_HM10395`
- **数据来源**: [The Cancer Imaging Archive (TCIA)](https://www.cancerimagingarchive.net/)
- **项目集**: `4D-Lung` (呼吸门控胸部肿瘤扫描)
- **设备模态**: CT (50 张切片)

## 📁 目录包含文件:
1. `dicom/`: 50 张未修改的国际标准真实临床 DICOM 原生文件 (`.dcm`)。
2. `LICENSE`: TCIA CC BY 3.0 协议文档。
3. `patient_info.json`: 序列元数据。
""", encoding="utf-8")

    # -------------------------------------------------------------
    # 6. 生成顶级索引 README.md
    # -------------------------------------------------------------
    top_readme = BASE_DIR / "README.md"
    top_readme.write_text("""# 🏥 Heurion 医学影像手工测试文件包 (Clinical Imaging Test Datasets)

本文件夹收录公开数据集样本转换出的测试文件（CT、MRI），以及一份人工合成的第二期数据，用于手工测试上传、三维渲染与双期对比界面。样本不附带临床信息，DICOM 头中的姓名与日期均为测试占位值；合成数据不是真实随访。

---

## 📂 测试用例目录结构

```text
medical_imaging_test_cases/
├── 01_Test_Chest_CT/       # 公开胸部 CT 样本
│   ├── dicom/                                  # 269 张标准 DICOM 切片序列 (CT_0001.dcm ~ CT_0269.dcm)
│   ├── nifti/chest_lung_baseline.nii.gz        # 原始 3D NIfTI 体积
│   ├── patient_info.json                       # 数据来源与用途说明
│   └── README.md
│
├── 01_Test_Chest_CT_Synthetic_Second_Phase/       # 人工合成的第二期（不是真实随访）
│   ├── dicom/                                  # 269 张合成 DICOM 切片序列
│   ├── nifti/chest_lung_followup.nii.gz        # 合成 3D NIfTI 体积
│   ├── patient_info.json                       # 合成方法说明
│   └── README.md
│
├── 02_Test_Abdomen_CT/              # 公开腹部 CT 样本
│   ├── dicom/                                  # 96 张腹窗 DICOM 切片序列
│   ├── nifti/abdomen_spleen_ct.nii.gz          # 腹部 3D NIfTI 体积
│   ├── patient_info.json
│   └── README.md
│
├── 03_Test_Prostate_MRI/           # 公开前列腺 T2 MRI 样本
│   ├── dicom/                                  # 19 张盆腔薄层 T2 DICOM 序列 (MR_0001.dcm ~ MR_0019.dcm)
│   ├── nifti/prostate_t2_mri.nii.gz            # 前列腺 MRI 3D 体积
│   ├── patient_info.json
│   └── README.md
│
└── 04_Patient_TCIA_100_HM10395_Lung_Cancer_CT/ # TCIA 4D-Lung 公开数据集原生 DICOM
    ├── dicom/                                  # 50 张未改动的 TCIA 真实 CT 原生序列
    ├── LICENSE                                 # TCIA 许可协议
    └── patient_info.json
```

---

## 🎯 常用手工测试指引

### 场景 1: 单期影像量化分析与病灶标注
1. 在 Heurion 网页端打开任意患者详情页；
2. 拖拽 `nifti/` 下的 `.nii.gz` 或 `dicom/` 文件夹上传；
3. 点击 **「🔍 影像量化分析」**：
   - 运行所选模型或量化算法（完成度不一，结果需对照原图核对）；
   - 查看关键切片与 RECIST 径线、体积等测量值。

### 场景 2: 双期对比与差分图（使用合成第二期数据，仅测试功能）
1. 在患者主页点击 **「📈 多期影像随访对比」**；
2. 基线选择 `01_Test_Chest_CT`，随访选择 `01_Test_Chest_CT_Synthetic_Second_Phase`；
3. 切换至 **「🖥️ 双联 MPR 联动切片 (Dual-Scrubber)」**：
   - 勾选差分图叠加；
   - 差异来自人工衰减，只用来确认界面与计算能运行，不代表任何病灶变化；
   - 滑动滚轮或拖动切片条，体验左右双屏的按比例锁定同步。

### 场景 3: 国际标准医学数据交换导出
1. 在随访对比窗口右上角点击：
   - **`[📥 导出 FHIR]`**：下载 HL7 FHIR R4 标准的 `DiagnosticReport` / `ImagingStudy` JSON 资源；
   - **`[💾 导出 DICOM SR]`**：下载 DICOM PS 3.3 TID 1500 结构化测量报告 JSON。
2. DICOM SR 导出为 JSON 表示，不是二进制 DICOM 文件，不能直接导入 PACS。

### 场景 4: 本地医学影像软件直接打开
本目录下的所有 DICOM 文件均包含完整的 DICOM Header，可直接使用以下任意医学查看器直接拖入打开：
- **Mac / Web**: [NiiVue Web 浏览](http://127.0.0.1:8787)、Horos、OsiriX
- **Windows / Cross-platform**: RadiAnt DICOM Viewer、MicroDicom、ITK-SNAP、3D Slicer、Weasis
""", encoding="utf-8")

    # 创建桌面快捷方式方便查找
    desktop_symlink = Path("/Users/huizhao/Desktop/医学影像测试文件_DICOM")
    try:
        if desktop_symlink.is_symlink() or desktop_symlink.exists():
            desktop_symlink.unlink()
        desktop_symlink.symlink_to(BASE_DIR)
        print(f"  -> 已在桌面创建快捷链接: {desktop_symlink} -> {BASE_DIR}")
    except Exception as e:
        print(f"  -> 桌面软链提示: {e}")

    # 同时在项目内创建 test_imaging_data 软链
    repo_symlink = Path(__file__).resolve().parent.parent / "test_imaging_data"
    try:
        if repo_symlink.is_symlink() or repo_symlink.exists():
            repo_symlink.unlink()
        repo_symlink.symlink_to(BASE_DIR)
        print(f"  -> 已在项目根目录创建软链: {repo_symlink} -> {BASE_DIR}")
    except Exception as e:
        print(f"  -> 项目内软链提示: {e}")

    print("\n✅ 所有患者影像测试文件已组织并生成完毕！")

if __name__ == "__main__":
    main()
