import os
import hashlib
import json
import urllib.request
import urllib.error
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Dict, Any, List, Optional, Callable

# Default model directory: configurable via HEURION_MODEL_DIR or defaults to user cache
DEFAULT_CACHE_DIR = Path(os.environ.get("HEURION_MODEL_DIR", Path.home() / ".cache" / "heurion" / "models"))

@dataclass
class ModelSpec:
    name: str
    display_name: str
    modality: str
    version: str
    size_mb: float
    sha256: str
    urls: List[str]
    description: str
    architecture: str
    clinical_targets: List[str]
    file_name: str
    engine_type: str = "deep_learning"  # "deep_learning" or "quantitative_ct"
    body_part: str = "chest"  # "chest", "abdomen", "brain", "pelvis", "cardiac", "pathology", "whole_body", "breast", "endoscopy", "general"
    category: str = "胸部与呼吸科"
    # 引擎（engine.MonaiNeuralInferencePipeline.NEURAL_LOADERS）中是否真有该权重的加载与推理路径。
    # 只有加载+推理路径存在、且本地权重 SHA-256 校验通过时才算 is_ready；权重文件存在本身不代表可用。
    engine_implemented: bool = False

OFFICIAL_MODEL_REGISTRY: Dict[str, ModelSpec] = {
    "spleen_ct": ModelSpec(
        name="spleen_ct",
        display_name="MONAI 脾脏全自动三维分割与体积测算模型 (3D-UNet)",
        modality="Abdomen CT",
        version="v0.5.3",
        size_mb=18.4,
        sha256="502c312893994ec071a85c4f2e7d83a43f7789969faa73dae62f1291177f50fe",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/spleen_ct_segmentation_v0.5.3.zip"
        ],
        description="MONAI spleen_ct_segmentation bundle（3D-UNet）腹部 CT 脾脏分割，输出脾脏体积与径线。",
        architecture="UNet-3D",
        clinical_targets=["脾脏分割", "脾脏体积"],
        # 文件名沿用旧缓存名；实际内容来自 spleen_ct_segmentation_v0.5.3 bundle 的 models/model.pt
        file_name="spleen_ct_v0.4.0.pt",
        engine_type="deep_learning",
        body_part="abdomen",
        category="腹部、消化与泌尿",
        engine_implemented=True
    ),
    "lung_nodule_ct": ModelSpec(
        name="lung_nodule_ct",
        display_name="MONAI Model Zoo 肺结节检出模型 (3D RetinaNet)",
        modality="Chest CT",
        version="v0.5.9",
        size_mb=79.83,
        sha256="b5e79231466adae93a6fe8e8594029e9add142914e223b879aa0343bb2402d01",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/lung_nodule_ct_detection_v0.5.9.zip"
        ],
        description="MONAI lung_nodule_ct_detection bundle（3D ResNet50-FPN RetinaNet），胸部 CT 肺结节三维候选框检出与置信度评分。",
        architecture="RetinaNet-3D",
        clinical_targets=["肺结节", "磨玻璃结节 (GGO)", "部分实性结节 (PSN)", "实性结节 (SN)"],
        file_name="lung_nodule_ct_v0.5.9.pt",
        engine_type="deep_learning",
        body_part="chest",
        category="胸部与呼吸科",
        engine_implemented=True
    ),
    "swinunetr_btcv": ModelSpec(
        name="swinunetr_btcv",
        display_name="MONAI SwinUNETR 腹部多器官解剖分割模型 (BTCV 国际竞赛)",
        modality="Abdomen CT",
        version="v0.5.0",
        size_mb=244.46,
        sha256="52e7c3114444e41bb14f644e0dd2b7d42d70ad4b4dec0c1bfa4a552a4b92a096",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/swin_unetr_btcv_segmentation_v0.5.0.zip"
        ],
        description="MONAI swin_unetr_btcv_segmentation bundle，BTCV 腹部 13 类器官（肝、脾、双肾、胰腺、胆囊、食管、胃、主动脉、下腔静脉、门静脉/脾静脉、双侧肾上腺）分割。",
        architecture="SwinUNETR-Large",
        clinical_targets=["肝脏", "脾脏", "双肾", "胰腺", "腹部大血管"],
        file_name="swinunetr_btcv_v0.5.0.pt",
        engine_type="deep_learning",
        body_part="abdomen",
        category="腹部、消化与泌尿",
        engine_implemented=True
    ),
    "brats_mri": ModelSpec(
        name="brats_mri",
        display_name="MONAI BraTS 颅脑多模态胶质瘤亚区精细分割 (T1/T1c/T2/FLAIR)",
        modality="Brain MRI",
        version="v0.4.8",
        size_mb=17.97,
        sha256="860ccb3f1c21c99d0410ad8a1ac4ef6b8fab60cec0a503b0ba42675741a750ae",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/brats_mri_segmentation_v0.4.8.zip"
        ],
        description="MONAI brats_mri_segmentation bundle（SegResNet），输入须为 4 通道 MRI（通道顺序 T1c, T1, T2, FLAIR），输出 TC/WT/ET 三个子区。",
        architecture="SegResNet-3D",
        clinical_targets=["全脑胶质瘤 (WT)", "肿瘤增强核心 (ET)", "坏死囊变区 (TC)"],
        file_name="brats_mri_v0.4.8.pt",
        engine_type="deep_learning",
        body_part="brain",
        category="颅脑与神经系统",
        engine_implemented=True
    ),
    "wholebody_ct": ModelSpec(
        name="wholebody_ct",
        display_name="MONAI 全身 CT 多器官全景分割模型",
        modality="Body CT",
        version="v0.1.9",
        size_mb=71.74,
        sha256="80b429fb4b080df11c9ed0b0bdaa8a615ff083921bb213a512cf285afbc4e3fe",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/wholeBody_ct_segmentation_v0.1.9.zip"
        ],
        description="MONAI wholeBody_ct_segmentation bundle（SegResNet，104 类结构，1.5 mm 高分辨率版权重）。",
        architecture="SegResNet-3D",
        clinical_targets=["胸部器官", "腹部器官", "纵隔血管", "骨骼解剖"],
        file_name="wholebody_ct_v0.1.9.pt",
        engine_type="deep_learning",
        body_part="whole_body",
        category="骨科与全身体素",
        engine_implemented=True
    ),
    "prostate_mri": ModelSpec(
        name="prostate_mri",
        display_name="MONAI 前列腺多参数 MRI 3D 解剖分带模型",
        modality="Pelvic MRI",
        version="v0.3.2",
        size_mb=145.73,
        sha256="3c18e4c658bb088f551b1d63219ef8340fe6256d016c75fc140d3da49dda696d",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/prostate_mri_anatomy_v0.3.2.zip"
        ],
        description="MONAI prostate_mri_anatomy bundle（3D UNet），T2W MRI 前列腺中央腺体与外周带分割。",
        architecture="UNet-3D",
        clinical_targets=["前列腺全腺体", "中央腺体", "外周带 (PZ)"],
        file_name="prostate_mri_v0.3.2.pt",
        engine_type="deep_learning",
        body_part="pelvis",
        category="腹部、消化与泌尿",
        engine_implemented=True
    ),
    "renal_structures_cect": ModelSpec(
        name="renal_structures_cect",
        display_name="MONAI 增强 CT 肾脏精细解剖分割模型",
        modality="Abdomen CECT",
        version="v0.1.0",
        size_mb=72.41,
        sha256="ef934ae5b6fdf9a19b83ab9ec28b64d63dca43aea8ef3e177724c3076170a21f",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/renalStructures_CECT_segmentation_v0.1.0.zip"
        ],
        description="MONAI renalStructures_CECT_segmentation bundle（SegResNet），提取肾动脉、肾静脉、输尿管/肾盂、肾占位与肾实质。",
        architecture="SegResNet-3D",
        clinical_targets=["肾实质", "肾盂输尿管", "肾血管", "肾占位/囊肿"],
        file_name="renal_structures_cect_v0.1.0.pt",
        engine_type="deep_learning",
        body_part="abdomen",
        category="腹部、消化与泌尿",
        engine_implemented=True
    ),
    "ventricular_short_axis": ModelSpec(
        name="ventricular_short_axis",
        display_name="MONAI 心脏短轴 Cine-MRI 3标签腔室分割模型",
        modality="Cardiac MRI",
        version="v0.3.2",
        size_mb=6.32,
        sha256="27d5532401fa6c1883872fa21635adbb7615981e7f385d0c58dd75b355e340b3",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/ventricular_short_axis_3label_v0.3.2.zip"
        ],
        description="MONAI ventricular_short_axis_3label bundle（2D UNet，TorchScript），短轴 cine SSFP 逐层分割左室血池、心肌、右室血池。单期相输入不能计算射血分数。",
        architecture="UNet-2D/3D",
        clinical_targets=["左室血池", "左室心肌", "右室血池"],
        file_name="ventricular_short_axis_v0.3.2.pt",
        engine_type="deep_learning",
        body_part="cardiac",
        category="心血管系统",
        engine_implemented=True
    ),
    "wholebrainseg_large_unest": ModelSpec(
        name="wholebrainseg_large_unest",
        display_name="MONAI 全脑多结构 MRI 大规模分割模型 (Large UNEST)",
        modality="Brain MRI",
        version="v0.2.3",
        size_mb=332.74,
        sha256="79a52ccd77bc35d05410f39788a1b063af3eb3b809b42241335c18aed27ec422",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/wholeBrainSeg_Large_UNEST_segmentation_v0.2.3.zip"
        ],
        description="MONAI wholeBrainSeg_Large_UNEST_segmentation bundle，全脑 132 类灰白质与皮层下核团精细解剖分割。",
        architecture="UNEST-Large-3D",
        clinical_targets=["大脑皮层", "白质", "双侧海马体", "脑室系统", "基底节区"],
        file_name="wholebrainseg_large_unest_v0.2.3.pt",
        engine_type="deep_learning",
        body_part="brain",
        category="颅脑与神经系统",
        engine_implemented=True
    ),
    "pancreas_ct_dints": ModelSpec(
        name="pancreas_ct_dints",
        display_name="MONAI 胰腺与胰腺肿物 CT 神经架构搜索分割模型 (DiNTS)",
        modality="Abdomen CT",
        version="v0.4.3",
        size_mb=528.17,
        sha256="a18ae8b837f6affe778d7e9f130e6045c04a6f7d5b5dd8470155b9a18b6bcb65",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/pancreas_ct_dints_segmentation_v0.4.3.zip"
        ],
        description="MONAI pancreas_ct_dints_segmentation bundle，基于可微神经架构搜索 (DiNTS) 的胰腺实质与胰腺肿瘤三维分割。",
        architecture="DiNTS-3D-NAS",
        clinical_targets=["胰腺实质", "胰头/胰体/胰尾", "胰腺囊实性占位", "胰腺导管腺癌 (PDAC)"],
        file_name="pancreas_ct_dints_v0.4.3.pt",
        engine_type="deep_learning",
        body_part="abdomen",
        category="腹部、消化与泌尿",
        engine_implemented=True
    ),
    "pathology_tumor_detection": ModelSpec(
        name="pathology_tumor_detection",
        display_name="MONAI 数字病理全视野切片 (WSI) 肿瘤转移灶检出模型",
        modality="Digital Pathology (WSI)",
        version="v0.5.7",
        size_mb=42.71,
        sha256="5a0d9b9e714e18a90c1f7f7d9c7e47f807c59f9f8c681b84865fae208fcbb4d6",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/pathology_tumor_detection_v0.5.7.zip"
        ],
        description="MONAI pathology_tumor_detection bundle（ResNet18 网格滑窗概率图），针对数字病理切片的肿瘤区域检出。",
        architecture="ResNet18-FCN-2D",
        clinical_targets=["前哨淋巴结转移", "微浸润灶", "肿瘤细胞团", "病理分期辅助"],
        file_name="pathology_tumor_detection_v0.5.7.pt",
        engine_type="deep_learning",
        body_part="pathology",
        category="病理与微观形态",
        engine_implemented=True
    ),
    "pathology_nuclei": ModelSpec(
        name="pathology_nuclei",
        display_name="MONAI 病理切片细胞核多类别精细分割与分类模型",
        modality="Digital Pathology",
        version="v0.2.1",
        size_mb=144.22,
        sha256="cf6eb5a0467422c2c1ffbff72e2b4aca17dcdd8d2087bd1a27ce86fea98a1ab6",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/pathology_nuclei_segmentation_classification_v0.2.1.zip"
        ],
        description="MONAI pathology_nuclei_segmentation_classification bundle（HoVer-Net fast 模式），细胞核分割与 4 类表型分类。",
        architecture="HoVer-Net-2D",
        clinical_targets=["肿瘤浸润淋巴细胞 (TILs)", "核异型性", "核质比测算", "细胞增殖指数"],
        file_name="pathology_nuclei_v0.2.1.pt",
        engine_type="deep_learning",
        body_part="pathology",
        category="病理与微观形态",
        engine_implemented=True
    ),
    "valve_landmarks": ModelSpec(
        name="valve_landmarks",
        display_name="MONAI 心脏超声/CT 瓣膜关键解剖地标检测模型",
        modality="Cardiac CT/Echo",
        version="v0.4.3",
        size_mb=12.73,
        sha256="b0187ee65b150c0c693b16e6a65d0b3f659bed163423a1e4a5a6b3bb4fbeb7bf",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/valve_landmarks_v0.4.3.zip"
        ],
        description="MONAI valve_landmarks bundle（PointRegressor 2D），逐帧/逐层回归心脏瓣膜 10 个关键解剖地标坐标。",
        architecture="PointRegressor-2D",
        clinical_targets=["主动脉瓣环", "二尖瓣前后瓣叶地标", "冠状动脉开口高度", "瓣膜置换规划"],
        file_name="valve_landmarks_v0.4.3.pt",
        engine_type="deep_learning",
        body_part="cardiac",
        category="心血管系统",
        engine_implemented=True
    ),
    "breast_density": ModelSpec(
        name="breast_density",
        display_name="MONAI 乳腺钼靶 X 射线致密度与 BI-RADS 分类模型",
        modality="Mammography (MG)",
        version="v0.1.5",
        size_mb=96.16,
        sha256="710a49172243ea9972bec5dc717382c294ed77310596b6ad0df9bb83f7ceafce",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/breast_density_classification_v0.1.5.zip"
        ],
        description="MONAI breast_density_classification bundle（InceptionV3），ACR BI-RADS 乳腺致密度四分类（A/B/C/D 概率分布）。",
        architecture="InceptionV3-2D",
        clinical_targets=["BI-RADS 腺体致密度", "脂肪型", "散在纤维腺体型", "不均匀致密型", "极度致密型"],
        file_name="breast_density_v0.1.5.pt",
        engine_type="deep_learning",
        body_part="breast",
        category="乳腺钼靶与妇科",
        engine_implemented=True
    ),
    "endoscopic_tool": ModelSpec(
        name="endoscopic_tool",
        display_name="MONAI 微创腹腔镜/胸腔镜手术器械动态语义分割模型",
        modality="Endoscopic Video",
        version="v0.5.5",
        size_mb=44.15,
        sha256="1a24d5f1d30a44474e8bb87abb62f289add2c40a291eac67138242679e928729",
        urls=[
            "https://github.com/Project-MONAI/model-zoo/releases/download/hosting_storage_v1/endoscopic_tool_segmentation_v0.5.5.zip"
        ],
        description="MONAI endoscopic_tool_segmentation bundle（FlexibleUNet EfficientNet-B2），内镜图像/序列中手术器械像素级分割。",
        architecture="FlexibleUNet-EfficientNetB2",
        clinical_targets=["抓钳", "超声刀", "双极电凝", "视野遮挡剔除", "术中安全边界"],
        file_name="endoscopic_tool_v0.5.5.pt",
        engine_type="deep_learning",
        body_part="endoscopy",
        category="微创外科与内窥镜",
        engine_implemented=True
    ),
    "totalsegmentator": ModelSpec(
        name="totalsegmentator",
        display_name="TotalSegmentator 全身 117 类解剖器官与骨骼全景分割",
        modality="Body CT",
        version="v2.0.5",
        size_mb=480.0,
        # 无官方单文件权重与可核对的 SHA-256（TotalSegmentator 以 nnU-Net 多折权重包分发），本引擎未接入，仅作规划项
        sha256="",
        urls=[],
        description="覆盖全身 117 种器官、骨骼、大血管与肌肉群的全景 CT 分割基础模型，用于精准解剖包络与假阳性剔除。",
        architecture="nnUNet-ResNet50-3D",
        clinical_targets=["双肺五叶", "气管树", "纵隔大血管", "肝脾胰肾", "骨骼肋骨系统"],
        file_name="totalsegmentator_v2.0.5.pt",
        engine_type="deep_learning",
        body_part="whole_body",
        category="骨科与全身体素"
    ),
    "vista3d": ModelSpec(
        name="vista3d",
        display_name="MONAI VISTA-3D 医生交互式点选/多类别三维分割基座模型",
        modality="Multi-modality (CT / MRI)",
        version="v0.5.7",
        size_mb=831.57,
        sha256="c92bab26d00b4a5d89fa8a383900cdeb88302fd318e5e816df0bbec7106d9a1b",
        urls=[
            "https://api.ngc.nvidia.com/v2/models/nvidia/monaihosting/vista3d/versions/0.5.7/files/vista3d_v0.5.7.zip"
        ],
        description="MONAI VISTA-3D bundle（vista3d132），支持 3D 提示点交互式分割与类别提示分割。",
        architecture="VISTA-3D-Transformer",
        clinical_targets=["任意未知靶病灶", "淋巴结转移灶", "软组织肉瘤", "囊实性混合占位"],
        file_name="vista3d_v0.5.7.pt",
        engine_type="deep_learning",
        body_part="general",
        category="交互式万物分割",
        engine_implemented=True
    )
}

def get_model_cache_dir() -> Path:
    """Returns the local cache directory for storing model weights."""
    raw = os.environ.get("HEURION_MODEL_DIR")
    cache_dir = Path(raw) if raw else DEFAULT_CACHE_DIR
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir

def compute_sha256(file_path: Path) -> str:
    """Computes SHA-256 hash of a local file."""
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()

_SHA_CACHE: Dict[str, tuple] = {}

def _cached_sha256(file_path: Path) -> str:
    """按 (路径, 大小, 修改时间) 缓存哈希，并优先复用同名 .meta.json 中已记录的哈希，避免容器冷启动时重算 2.2GB 权重文件。"""
    st = file_path.stat()
    key = str(file_path)
    hit = _SHA_CACHE.get(key)
    if hit and hit[0] == st.st_size and hit[1] == st.st_mtime:
        return hit[2]
    meta_file = Path(f"{file_path}.meta.json")
    if meta_file.exists():
        try:
            with open(meta_file, "r", encoding="utf-8") as mf:
                meta = json.load(mf)
            saved_sha = meta.get("actual_sha256")
            saved_mtime = meta.get("pulled_at")
            saved_size = meta.get("size_bytes")
            if (
                isinstance(saved_sha, str)
                and len(saved_sha) == 64
                and (
                    (saved_size is not None and int(saved_size) == st.st_size)
                    or (saved_mtime is not None and abs(float(saved_mtime) - st.st_mtime) < 1.0)
                )
            ):
                _SHA_CACHE[key] = (st.st_size, st.st_mtime, saved_sha)
                return saved_sha
        except Exception:
            pass
    digest = compute_sha256(file_path)
    _SHA_CACHE[key] = (st.st_size, st.st_mtime, digest)
    try:
        meta_data = {}
        if meta_file.exists():
            with open(meta_file, "r", encoding="utf-8") as mf:
                meta_data = json.load(mf)
        meta_data.update({
            "pulled_at": str(st.st_mtime),
            "size_bytes": st.st_size,
            "actual_sha256": digest,
        })
        with open(meta_file, "w", encoding="utf-8") as mf:
            json.dump(meta_data, mf, indent=2)
    except Exception:
        pass
    return digest

def get_model_status(name: str) -> Dict[str, Any]:
    """Inspects the local presence, size, and integrity of a registered model."""
    spec = OFFICIAL_MODEL_REGISTRY.get(name)
    if not spec:
        return {"name": name, "exists_in_registry": False, "installed": False}

    cache_dir = get_model_cache_dir()
    local_file = cache_dir / spec.file_name
    meta_file = cache_dir / f"{spec.file_name}.meta.json"

    installed = local_file.exists() and local_file.stat().st_size > 0
    size_bytes = local_file.stat().st_size if installed else 0
    size_mb = round(size_bytes / (1024 * 1024), 2)

    # 校验只认登记的真实 SHA-256；没有登记哈希的条目一律视为未校验
    verified = False
    actual_sha = None
    if installed:
        actual_sha = _cached_sha256(local_file)
        verified = bool(spec.sha256) and (actual_sha.lower() == spec.sha256.lower())

    meta = {}
    if meta_file.exists():
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            pass

    # is_ready 由「引擎确有该权重的加载与推理路径」且「本地权重哈希校验通过」共同决定，
    # 不因 engine_type 或文件存在而自动就绪
    is_ready = bool(spec.engine_implemented and installed and verified)
    if not spec.engine_implemented:
        unavailable_reason = "引擎未实现该模型的加载与推理路径"
    elif not installed:
        unavailable_reason = "本地权重未安装"
    elif not verified:
        unavailable_reason = "本地权重 SHA-256 校验未通过"
    else:
        unavailable_reason = None

    return {
        "name": spec.name,
        "display_name": spec.display_name,
        "modality": spec.modality,
        "version": spec.version,
        "architecture": spec.architecture,
        "engine_type": spec.engine_type,
        "body_part": spec.body_part,
        "category": spec.category,
        "expected_size_mb": spec.size_mb,
        "expected_sha256": spec.sha256,
        "clinical_targets": spec.clinical_targets,
        "installed": installed,
        "verified": verified,
        "engine_implemented": spec.engine_implemented,
        "is_ready": is_ready,
        "unavailable_reason": unavailable_reason,
        "actual_sha256": actual_sha,
        "local_path": str(local_file) if installed else None,
        "local_size_mb": size_mb,
        "last_pulled_at": meta.get("pulled_at"),
        "exists_in_registry": True
    }

def list_registered_models() -> List[Dict[str, Any]]:
    """Returns the list of all registered models with their local download status."""
    return [get_model_status(name) for name in OFFICIAL_MODEL_REGISTRY.keys()]

def pull_model(
    name: str,
    force: bool = False,
    progress_callback: Optional[Callable[[int, int], None]] = None
) -> Dict[str, Any]:
    """
    Pulls a model from official repository or mirror, saves to cache directory,
    and performs SHA-256 integrity verification.
    """
    spec = OFFICIAL_MODEL_REGISTRY.get(name)
    if not spec:
        raise ValueError(f"Model '{name}' is not in the official model registry.")

    cache_dir = get_model_cache_dir()
    local_file = cache_dir / spec.file_name
    meta_file = cache_dir / f"{spec.file_name}.meta.json"

    # If already installed and verified, skip unless force=True
    if local_file.exists() and not force:
        stat = get_model_status(name)
        if stat["installed"]:
            return {
                "status": "already_installed",
                "message": f"模型 '{spec.display_name}' 已在本地就绪",
                "model": stat
            }

    if not spec.urls:
        raise RuntimeError(f"模型 '{name}' 没有登记可核对的官方权重下载地址，无法拉取。")

    download_success = False
    last_error = None

    # Try mirrors sequentially
    for url in spec.urls:
        try:
            temp_file = cache_dir / f"{spec.file_name}.download"
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Heurion-MONAI-Worker/2.0"}
            )
            with urllib.request.urlopen(req, timeout=30) as resp, open(temp_file, "wb") as out_f:
                total_len = int(resp.headers.get("Content-Length", 0))
                downloaded = 0
                while chunk := resp.read(64 * 1024):
                    out_f.write(chunk)
                    downloaded += len(chunk)
                    if progress_callback:
                        progress_callback(downloaded, total_len)

            if temp_file.exists() and temp_file.stat().st_size > 0:
                # If downloaded a zip archive (MONAI bundle), extract models/model.pt
                if url.endswith(".zip") or temp_file.suffix == ".zip":
                    import zipfile, shutil
                    try:
                        with zipfile.ZipFile(temp_file, "r") as zf:
                            pt_entries = [n for n in zf.namelist() if n.endswith("model.pt")]
                            if pt_entries:
                                with zf.open(pt_entries[0]) as zf_in, open(local_file, "wb") as out_f:
                                    shutil.copyfileobj(zf_in, out_f)
                                download_success = True
                            else:
                                raise RuntimeError(f"Zip archive does not contain a valid model.pt: {url}")
                    finally:
                        temp_file.unlink(missing_ok=True)
                else:
                    temp_file.rename(local_file)
                    download_success = True
                break
        except Exception as e:
            last_error = str(e)
            if temp_file.exists():
                temp_file.unlink(missing_ok=True)
            continue

    if not download_success:
        raise RuntimeError(
            f"无法从官方仓库下载模型 '{name}' 权重: {last_error}。"
            "不会以其他权重或规则算法替代。"
        )

    actual_sha = compute_sha256(local_file)
    meta = {
        "name": spec.name,
        "version": spec.version,
        "pulled_at": str(Path(local_file).stat().st_mtime),
        "actual_sha256": actual_sha,
        "url_source": spec.urls[0]
    }
    with open(meta_file, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    stat = get_model_status(name)
    return {
        "status": "success",
        "message": f"模型 '{spec.display_name}' 成功安装至本地 (大小: {stat['local_size_mb']} MB)",
        "model": stat
    }

def verify_model(name: str) -> Dict[str, Any]:
    """Verifies SHA-256 integrity of an installed model."""
    status = get_model_status(name)
    if not status["installed"]:
        return {
            "name": name,
            "installed": False,
            "verified": False,
            "error": "Model weights file does not exist locally"
        }
    return {
        "name": name,
        "installed": True,
        "verified": status["verified"],
        "expected_sha256": status["expected_sha256"],
        "actual_sha256": status["actual_sha256"],
        "local_path": status["local_path"],
        "local_size_mb": status["local_size_mb"]
    }
