"""
Self-contained network definitions for official MONAI Model Zoo bundles that
use custom bundle-local scripts or TorchVision-wrapped backbones:
- wholebrainseg_large_unest (UNesT 3D 133-class brain parcellation)
- valve_landmarks (PointRegressor 2D 10-landmark regressor)
- lung_nodule_ct (3D ResNet50-FPN RetinaNet + RetinaNetDetector)
- pancreas_ct_dints (DiNTS 3D NAS pancreas & tumor segmentation)
- pathology_tumor_detection (2D ResNet18 + 1x1 Conv WSI patch tumor classifier)
- breast_density (2D InceptionV3 4-class BI-RADS mammography density classifier)
"""
import math
from collections import OrderedDict
from typing import Any, Dict, Sequence, Tuple

import numpy as np
import torch
from torch import nn
import torch.nn.functional as F
import monai.networks.nets as nets
from monai.networks.blocks import ConvDenseBlock, Convolution, FeaturePyramidNetwork
from monai.networks.blocks.backbone_fpn_utils import LastLevelMaxPool
from monai.networks.blocks.dynunet_block import UnetBasicBlock, UnetOutBlock, UnetResBlock, get_conv_layer
from monai.networks.layers import Flatten, Reshape
from monai.apps.detection.networks.retinanet_network import RetinaNet
from monai.apps.detection.networks.retinanet_detector import RetinaNetDetector
from monai.apps.detection.utils.anchor_utils import AnchorGeneratorWithAnchorShape


# ---------------------------------------------------------------------------
# 1. wholeBrainSeg_Large_UNEST_segmentation (UNesT 3D, 133 classes)
# ---------------------------------------------------------------------------

class _PatchEmbed3D(nn.Module):
    def __init__(
        self,
        img_size: Tuple[int, int, int] = (96, 96, 96),
        patch_size: Tuple[int, int, int] = (4, 4, 4),
        in_chans: int = 1,
        embed_dim: int = 128,
    ):
        super().__init__()
        self.proj = nn.Conv3d(in_chans, embed_dim, kernel_size=patch_size, stride=patch_size)
        self.num_patches = (
            (img_size[0] // patch_size[0])
            * (img_size[1] // patch_size[1])
            * (img_size[2] // patch_size[2])
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.proj(x)


class _Mlp(nn.Module):
    def __init__(self, in_features: int, hidden_features: int, act_layer=nn.GELU, drop: float = 0.0):
        super().__init__()
        self.fc1 = nn.Linear(in_features, hidden_features)
        self.act = act_layer()
        self.drop1 = nn.Dropout(drop)
        self.fc2 = nn.Linear(hidden_features, in_features)
        self.drop2 = nn.Dropout(drop)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.drop2(self.fc2(self.drop1(self.act(self.fc1(x)))))


class _Attention(nn.Module):
    def __init__(self, dim: int, num_heads: int = 8, qkv_bias: bool = True, attn_drop: float = 0.0, proj_drop: float = 0.0):
        super().__init__()
        self.num_heads = num_heads
        self.scale = (dim // num_heads) ** -0.5
        self.qkv = nn.Linear(dim, 3 * dim, bias=qkv_bias)
        self.attn_drop = nn.Dropout(attn_drop)
        self.proj = nn.Linear(dim, dim)
        self.proj_drop = nn.Dropout(proj_drop)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, t, n, c = x.shape
        qkv = self.qkv(x).reshape(b, t, n, 3, self.num_heads, c // self.num_heads).permute(3, 0, 4, 1, 2, 5)
        q, k, v = qkv.unbind(0)
        attn = ((q @ k.transpose(-2, -1)) * self.scale).softmax(dim=-1)
        x = (self.attn_drop(attn) @ v).permute(0, 2, 3, 4, 1).reshape(b, t, n, c)
        return self.proj_drop(self.proj(x))


class _TransformerLayer(nn.Module):
    def __init__(self, dim: int, num_heads: int, mlp_ratio: float = 4.0, qkv_bias: bool = True):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim, eps=1e-6)
        self.attn = _Attention(dim, num_heads=num_heads, qkv_bias=qkv_bias)
        self.norm2 = nn.LayerNorm(dim, eps=1e-6)
        self.mlp = _Mlp(dim, int(dim * mlp_ratio))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.norm1(x))
        x = x + self.mlp(self.norm2(x))
        return x


class _ConvPool3D(nn.Module):
    def __init__(self, in_ch: int, out_ch: int):
        super().__init__()
        self.conv = nn.Conv3d(in_ch, out_ch, kernel_size=3, padding=1, bias=True)
        self.norm = nn.LayerNorm(out_ch, eps=1e-6)
        self.pool = nn.MaxPool3d(kernel_size=3, stride=2, padding=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.conv(x)
        x = self.norm(x.permute(0, 2, 3, 4, 1)).permute(0, 4, 1, 2, 3)
        return self.pool(x)


def _blockify(x: torch.Tensor, bs: int) -> torch.Tensor:
    b, d, h, w, c = x.shape
    gd, gh, gw = d // bs, h // bs, w // bs
    return x.reshape(b, gd, bs, gh, bs, gw, bs, c).permute(0, 1, 3, 5, 2, 4, 6, 7).reshape(b, gd * gh * gw, -1, c)


def _deblockify(x: torch.Tensor, bs: int) -> torch.Tensor:
    b, t, _, c = x.shape
    gs = round(math.pow(t, 1 / 3))
    d = h = w = gs * bs
    return x.reshape(b, gs, gs, gs, bs, bs, bs, c).permute(0, 1, 4, 2, 5, 3, 6, 7).reshape(b, d, h, w, c)


class _NestLevel(nn.Module):
    def __init__(
        self,
        num_blocks: int,
        block_size: int,
        seq_length: int,
        num_heads: int,
        depth: int,
        embed_dim: int,
        prev_embed_dim: int = None,
    ):
        super().__init__()
        self.block_size = block_size
        self.pos_embed = nn.Parameter(torch.zeros(1, num_blocks, seq_length, embed_dim))
        self.pool = _ConvPool3D(prev_embed_dim, embed_dim) if prev_embed_dim is not None else nn.Identity()
        self.transformer_encoder = nn.Sequential(*[_TransformerLayer(embed_dim, num_heads) for _ in range(depth)])

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.pool(x).permute(0, 2, 3, 4, 1)
        x = _blockify(x, self.block_size) + self.pos_embed
        x = self.transformer_encoder(x)
        return _deblockify(x, self.block_size).permute(0, 4, 1, 2, 3)


class _NestTransformer3D(nn.Module):
    def __init__(
        self,
        img_size: int = 96,
        in_chans: int = 1,
        patch_size: int = 4,
        num_levels: int = 3,
        embed_dims: Sequence[int] = (128, 256, 512),
        num_heads: Sequence[int] = (4, 8, 16),
        depths: Sequence[int] = (2, 2, 8),
    ):
        super().__init__()
        self.num_blocks = (8 ** torch.arange(num_levels)).flip(0).tolist()
        self.block_size = int((img_size // patch_size) // round(math.pow(self.num_blocks[0], 1 / 3)))
        self.patch_embed = _PatchEmbed3D((img_size,) * 3, (patch_size,) * 3, in_chans, embed_dims[0])
        self.seq_length = self.patch_embed.num_patches // self.num_blocks[0]
        levels = []
        prev_dim = None
        for i in range(num_levels):
            levels.append(
                _NestLevel(
                    self.num_blocks[i],
                    self.block_size,
                    self.seq_length,
                    num_heads[i],
                    depths[i],
                    embed_dims[i],
                    prev_dim,
                )
            )
            prev_dim = embed_dims[i]
        self.levels = nn.ModuleList(levels)
        self.norm = nn.LayerNorm(embed_dims[-1], eps=1e-6)

    def forward(self, x: torch.Tensor):
        x = self.patch_embed(x)
        hidden = [x]
        for lvl in self.levels:
            x = lvl(x)
            hidden.append(x)
        x = self.norm(x.permute(0, 2, 3, 4, 1)).permute(0, 4, 1, 2, 3)
        return x, hidden


class _UNesTBlock(nn.Module):
    def __init__(self, in_ch: int, out_ch: int, norm_name: str = "instance", res_block: bool = True):
        super().__init__()
        self.transp_conv = get_conv_layer(3, in_ch, out_ch, kernel_size=2, stride=2, conv_only=True, is_transposed=True)
        blk = UnetResBlock if res_block else UnetBasicBlock
        self.conv_block = blk(3, out_ch * 2, out_ch, kernel_size=3, stride=1, norm_name=norm_name)

    def forward(self, inp: torch.Tensor, skip: torch.Tensor) -> torch.Tensor:
        return self.conv_block(torch.cat((self.transp_conv(inp), skip), dim=1))


class _UNestUpBlock(nn.Module):
    def __init__(self, in_ch: int, out_ch: int, num_layer: int = 1):
        super().__init__()
        self.transp_conv_init = get_conv_layer(3, in_ch, out_ch, kernel_size=2, stride=2, conv_only=True, is_transposed=True)
        self.blocks = nn.ModuleList(
            [get_conv_layer(3, out_ch, out_ch, kernel_size=1, stride=1, conv_only=True, is_transposed=True) for _ in range(num_layer)]
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.transp_conv_init(x)
        for b in self.blocks:
            x = b(x)
        return x


class _UNesTConvBlock(nn.Module):
    def __init__(self, in_ch: int, out_ch: int, norm_name: str = "instance", res_block: bool = True):
        super().__init__()
        blk = UnetResBlock if res_block else UnetBasicBlock
        self.layer = blk(3, in_ch, out_ch, kernel_size=3, stride=1, norm_name=norm_name)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.layer(x)


class UNesT(nn.Module):
    def __init__(
        self,
        in_channels: int = 1,
        out_channels: int = 133,
        patch_size: int = 4,
        depths: Sequence[int] = (2, 2, 8),
        embed_dim: Sequence[int] = (128, 256, 512),
        num_heads: Sequence[int] = (4, 8, 16),
        feature_size: int = 16,
        norm_name: str = "instance",
        res_block: bool = True,
    ):
        super().__init__()
        self.nestViT = _NestTransformer3D(96, in_channels, patch_size, 3, embed_dim, num_heads, depths)
        self.encoder1 = _UNesTConvBlock(in_channels, feature_size * 2, norm_name, res_block)
        self.encoder2 = _UNestUpBlock(embed_dim[0], feature_size * 4, 1)
        self.encoder3 = _UNesTConvBlock(embed_dim[0], feature_size * 8, norm_name, res_block)
        self.encoder4 = _UNesTConvBlock(embed_dim[1], feature_size * 16, norm_name, res_block)
        self.decoder5 = _UNesTBlock(2 * embed_dim[2], feature_size * 32, norm_name, res_block)
        self.decoder4 = _UNesTBlock(embed_dim[2], feature_size * 16, norm_name, res_block)
        self.decoder3 = _UNesTBlock(feature_size * 16, feature_size * 8, norm_name, res_block)
        self.decoder2 = _UNesTBlock(feature_size * 8, feature_size * 4, norm_name, res_block)
        self.decoder1 = _UNesTBlock(feature_size * 4, feature_size * 2, norm_name, res_block)
        self.encoder10 = Convolution(
            spatial_dims=3,
            in_channels=32 * feature_size,
            out_channels=64 * feature_size,
            strides=2,
            adn_ordering="ADN",
            dropout=0.0,
        )
        self.out = UnetOutBlock(spatial_dims=3, in_channels=feature_size * 2, out_channels=out_channels)

    def forward(self, x_in: torch.Tensor) -> torch.Tensor:
        x, h = self.nestViT(x_in)
        enc0 = self.encoder1(x_in)
        enc1 = self.encoder2(h[0])
        enc2 = self.encoder3(h[1])
        enc3 = self.encoder4(h[2])
        enc4 = h[3]
        dec4 = self.encoder10(x)
        dec3 = self.decoder5(dec4, enc4)
        dec2 = self.decoder4(dec3, enc3)
        dec1 = self.decoder3(dec2, enc2)
        dec0 = self.decoder2(dec1, enc1)
        out = self.decoder1(dec0, enc0)
        return self.out(out)


# ---------------------------------------------------------------------------
# 2. valve_landmarks (PointRegressor 2D, 10 landmarks)
# ---------------------------------------------------------------------------

class ParallelCat(nn.Module):
    def __init__(self, catmodules: Sequence[nn.Module], cat_dim: int = 1):
        super().__init__()
        self.cat_dim = cat_dim
        for i, s in enumerate(catmodules):
            self.add_module(f"catmodule_{i}", s)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.cat([s(x) for s in self.children()], self.cat_dim)


class PointRegressor(nets.Regressor):
    def _get_layer(self, in_channels: int, out_channels: int, strides: int, is_last: bool) -> nn.Module:
        dout = out_channels - in_channels
        dchannels = [dout // 3, dout // 3, dout // 3 + dout % 3]
        db = ConvDenseBlock(
            spatial_dims=self.dimensions,
            in_channels=in_channels,
            channels=dchannels,
            dilations=[1, 2, 4],
            kernel_size=self.kernel_size,
            num_res_units=self.num_res_units,
            act=self.act,
            norm=self.norm,
            dropout=self.dropout,
            bias=self.bias,
        )
        conv = Convolution(
            spatial_dims=self.dimensions,
            in_channels=out_channels,
            out_channels=out_channels,
            strides=strides,
            kernel_size=self.kernel_size,
            act=self.act,
            norm=self.norm,
            dropout=self.dropout,
            bias=self.bias,
            conv_only=is_last,
        )
        return nn.Sequential(db, conv)

    def _get_final_layer(self, in_shape: Sequence[int]) -> nn.Module:
        point_paths = []
        for _ in range(self.out_shape[1]):
            conv = Convolution(
                spatial_dims=self.dimensions,
                in_channels=in_shape[0],
                out_channels=in_shape[0] * 2,
                strides=2,
                kernel_size=self.kernel_size,
                act=self.act,
                norm=self.norm,
                dropout=self.dropout,
                conv_only=True,
            )
            linear = nn.Linear(int(np.prod(in_shape)) // 2, self.out_shape[0])
            point_paths.append(nn.Sequential(conv, Flatten(), linear))
        return nn.Sequential(ParallelCat(point_paths), Reshape(*self.out_shape))


# ---------------------------------------------------------------------------
# 3. lung_nodule_ct_detection (3D ResNet50-FPN RetinaNet + Detector)
# ---------------------------------------------------------------------------

class _IntermediateLayerGetter(nn.ModuleDict):
    def __init__(self, model: nn.Module, return_layers: Dict[str, str]):
        orig_return_layers = dict(return_layers)
        remaining = {str(k): str(v) for k, v in return_layers.items()}
        layers = OrderedDict()
        for name, module in model.named_children():
            layers[name] = module
            if name in remaining:
                del remaining[name]
            if not remaining:
                break
        super().__init__(layers)
        self.return_layers = orig_return_layers

    def forward(self, x: torch.Tensor) -> OrderedDict:
        out = OrderedDict()
        for name, module in self.items():
            x = module(x)
            if name in self.return_layers:
                out[self.return_layers[name]] = x
        return out


class _CustomBackboneWithFPN(nn.Module):
    def __init__(self, backbone: nn.Module, return_layers: Dict[str, str], in_channels_list: Sequence[int], out_channels: int, spatial_dims: int = 3):
        super().__init__()
        self.body = _IntermediateLayerGetter(backbone, return_layers=return_layers)
        self.fpn = FeaturePyramidNetwork(
            spatial_dims=spatial_dims,
            in_channels_list=list(in_channels_list),
            out_channels=out_channels,
            extra_blocks=LastLevelMaxPool(spatial_dims),
        )
        self.out_channels = out_channels

    def forward(self, x: torch.Tensor) -> Dict[str, torch.Tensor]:
        return self.fpn(self.body(x))


def build_lung_nodule_retinanet_detector(state_dict: Dict[str, Any], device: torch.device) -> RetinaNetDetector:
    backbone = nets.resnet.resnet50(
        spatial_dims=3,
        n_input_channels=1,
        conv1_t_stride=[2, 2, 1],
        conv1_t_size=[7, 7, 7],
    )
    return_layers = {"layer1": "0", "layer2": "1"}
    in_planes = getattr(backbone, "in_planes", getattr(backbone, "inplanes", 64))
    in_channels_list = [in_planes // 8 * 2 ** (i - 1) for i in [1, 2]]
    fe = _CustomBackboneWithFPN(backbone, return_layers, in_channels_list, 256, spatial_dims=3)
    net = RetinaNet(
        spatial_dims=3,
        num_classes=1,
        num_anchors=3,
        feature_extractor=fe,
        size_divisible=[16, 16, 8],
    ).to(device)
    net.load_state_dict(state_dict)
    net.eval()

    anchor_gen = AnchorGeneratorWithAnchorShape(
        feature_map_scales=[1, 2, 4],
        base_anchor_shapes=[[6, 8, 4], [8, 6, 5], [10, 10, 6]],
    )
    detector = RetinaNetDetector(
        network=net,
        anchor_generator=anchor_gen,
        spatial_dims=3,
        num_classes=1,
        size_divisible=[16, 16, 8],
    ).to(device)
    detector.set_box_selector_parameters(
        score_thresh=0.02,
        topk_candidates_per_level=100,
        nms_thresh=0.22,
        detections_per_img=20,
    )
    detector.set_sliding_window_inferer(
        roi_size=[192, 192, 80],
        overlap=0.25,
        sw_batch_size=1,
        mode="constant",
        device="cpu",
    )
    detector.eval()
    return detector


# ---------------------------------------------------------------------------
# 4. pancreas_ct_dints_segmentation (DiNTS 3D NAS, 3 classes)
# ---------------------------------------------------------------------------

def build_dints_from_state_dict(state_dict: Dict[str, Any], device: torch.device) -> nn.Module:
    from monai.networks.nets import TopologyInstance, DiNTS

    arch_a = np.zeros((12, 10), dtype=int)
    arch_c = np.zeros((12, 10), dtype=int)
    k_map = {(3, 3, 3): 1, (3, 3, 1): 2, (3, 1, 3): 3, (1, 3, 3): 4}
    for b in range(12):
        for p in range(10):
            prefix = f"dints_space.cell_tree.({b}, {p})."
            if any(k.startswith(prefix) for k in state_dict):
                arch_a[b, p] = 1
                op_w = [
                    v.shape[2:]
                    for k, v in state_dict.items()
                    if k.startswith(prefix + "op.") and k.endswith(".conv.weight") and v.ndim == 5 and v.shape[2:] != (1, 1, 1)
                ]
                arch_c[b, p] = k_map.get(tuple(op_w[0]), 0) if op_w else 0

    topo = TopologyInstance(
        arch_code=[arch_a, arch_c],
        channel_mul=1.0,
        num_blocks=12,
        num_depths=4,
        spatial_dims=3,
        use_downsample=True,
        device=device,
    )
    model = DiNTS(
        dints_space=topo,
        in_channels=1,
        num_classes=3,
        use_downsample=True,
    ).to(device)
    model.load_state_dict(state_dict)
    model.eval()
    return model


# ---------------------------------------------------------------------------
# 5. pathology_tumor_detection (TorchVisionFCModel ResNet18 + 1x1 conv fc)
# ---------------------------------------------------------------------------

class _BasicBlock2d(nn.Module):
    def __init__(self, in_planes: int, planes: int, stride: int = 1):
        super().__init__()
        self.conv1 = nn.Conv2d(in_planes, planes, 3, stride=stride, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(planes)
        self.relu = nn.ReLU(inplace=True)
        self.conv2 = nn.Conv2d(planes, planes, 3, stride=1, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(planes)
        self.downsample = None
        if stride != 1 or in_planes != planes:
            self.downsample = nn.Sequential(
                nn.Conv2d(in_planes, planes, 1, stride=stride, bias=False),
                nn.BatchNorm2d(planes),
            )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        identity = x if self.downsample is None else self.downsample(x)
        out = self.relu(self.bn1(self.conv1(x)))
        out = self.bn2(self.conv2(out))
        return self.relu(out + identity)


class PathologyResNet18FC(nn.Module):
    def __init__(self, num_classes: int = 1):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(3, 64, kernel_size=7, stride=2, padding=3, bias=False),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(kernel_size=3, stride=2, padding=1),
            nn.Sequential(_BasicBlock2d(64, 64, 1), _BasicBlock2d(64, 64, 1)),
            nn.Sequential(_BasicBlock2d(64, 128, 2), _BasicBlock2d(128, 128, 1)),
            nn.Sequential(_BasicBlock2d(128, 256, 2), _BasicBlock2d(256, 256, 1)),
            nn.Sequential(_BasicBlock2d(256, 512, 2), _BasicBlock2d(512, 512, 1)),
            nn.AdaptiveAvgPool2d((1, 1)),
        )
        self.fc = nn.Conv2d(512, num_classes, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.features(x)
        x = self.fc(x)
        return x.flatten(1)


# ---------------------------------------------------------------------------
# 6. breast_density_classification (TorchVisionFCModel InceptionV3, 4 classes)
# ---------------------------------------------------------------------------

class _BasicConv2d(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, **kwargs):
        super().__init__()
        self.conv = nn.Conv2d(in_channels, out_channels, bias=False, **kwargs)
        self.bn = nn.BatchNorm2d(out_channels, eps=0.001)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return F.relu(self.bn(self.conv(x)), inplace=True)


class _InceptionA(nn.Module):
    def __init__(self, in_channels: int, pool_features: int):
        super().__init__()
        self.branch1x1 = _BasicConv2d(in_channels, 64, kernel_size=1)
        self.branch5x5_1 = _BasicConv2d(in_channels, 48, kernel_size=1)
        self.branch5x5_2 = _BasicConv2d(48, 64, kernel_size=5, padding=2)
        self.branch3x3dbl_1 = _BasicConv2d(in_channels, 64, kernel_size=1)
        self.branch3x3dbl_2 = _BasicConv2d(64, 96, kernel_size=3, padding=1)
        self.branch3x3dbl_3 = _BasicConv2d(96, 96, kernel_size=3, padding=1)
        self.branch_pool = _BasicConv2d(in_channels, pool_features, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b1 = self.branch1x1(x)
        b5 = self.branch5x5_2(self.branch5x5_1(x))
        b3 = self.branch3x3dbl_3(self.branch3x3dbl_2(self.branch3x3dbl_1(x)))
        bp = self.branch_pool(F.avg_pool2d(x, kernel_size=3, stride=1, padding=1))
        return torch.cat([b1, b5, b3, bp], 1)


class _InceptionB(nn.Module):
    def __init__(self, in_channels: int):
        super().__init__()
        self.branch3x3 = _BasicConv2d(in_channels, 384, kernel_size=3, stride=2)
        self.branch3x3dbl_1 = _BasicConv2d(in_channels, 64, kernel_size=1)
        self.branch3x3dbl_2 = _BasicConv2d(64, 96, kernel_size=3, padding=1)
        self.branch3x3dbl_3 = _BasicConv2d(96, 96, kernel_size=3, stride=2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b1 = self.branch3x3(x)
        b2 = self.branch3x3dbl_3(self.branch3x3dbl_2(self.branch3x3dbl_1(x)))
        bp = F.max_pool2d(x, kernel_size=3, stride=2)
        return torch.cat([b1, b2, bp], 1)


class _InceptionC(nn.Module):
    def __init__(self, in_channels: int, channels_7x7: int):
        super().__init__()
        self.branch1x1 = _BasicConv2d(in_channels, 192, kernel_size=1)
        c7 = channels_7x7
        self.branch7x7_1 = _BasicConv2d(in_channels, c7, kernel_size=1)
        self.branch7x7_2 = _BasicConv2d(c7, c7, kernel_size=(1, 7), padding=(0, 3))
        self.branch7x7_3 = _BasicConv2d(c7, 192, kernel_size=(7, 1), padding=(3, 0))
        self.branch7x7dbl_1 = _BasicConv2d(in_channels, c7, kernel_size=1)
        self.branch7x7dbl_2 = _BasicConv2d(c7, c7, kernel_size=(7, 1), padding=(3, 0))
        self.branch7x7dbl_3 = _BasicConv2d(c7, c7, kernel_size=(1, 7), padding=(0, 3))
        self.branch7x7dbl_4 = _BasicConv2d(c7, c7, kernel_size=(7, 1), padding=(3, 0))
        self.branch7x7dbl_5 = _BasicConv2d(c7, 192, kernel_size=(1, 7), padding=(0, 3))
        self.branch_pool = _BasicConv2d(in_channels, 192, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b1 = self.branch1x1(x)
        b7 = self.branch7x7_3(self.branch7x7_2(self.branch7x7_1(x)))
        b7d = self.branch7x7dbl_5(self.branch7x7dbl_4(self.branch7x7dbl_3(self.branch7x7dbl_2(self.branch7x7dbl_1(x)))))
        bp = self.branch_pool(F.avg_pool2d(x, kernel_size=3, stride=1, padding=1))
        return torch.cat([b1, b7, b7d, bp], 1)


class _InceptionD(nn.Module):
    def __init__(self, in_channels: int):
        super().__init__()
        self.branch3x3_1 = _BasicConv2d(in_channels, 192, kernel_size=1)
        self.branch3x3_2 = _BasicConv2d(192, 320, kernel_size=3, stride=2)
        self.branch7x7x3_1 = _BasicConv2d(in_channels, 192, kernel_size=1)
        self.branch7x7x3_2 = _BasicConv2d(192, 192, kernel_size=(1, 7), padding=(0, 3))
        self.branch7x7x3_3 = _BasicConv2d(192, 192, kernel_size=(7, 1), padding=(3, 0))
        self.branch7x7x3_4 = _BasicConv2d(192, 192, kernel_size=3, stride=2)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b1 = self.branch3x3_2(self.branch3x3_1(x))
        b2 = self.branch7x7x3_4(self.branch7x7x3_3(self.branch7x7x3_2(self.branch7x7x3_1(x))))
        bp = F.max_pool2d(x, kernel_size=3, stride=2)
        return torch.cat([b1, b2, bp], 1)


class _InceptionE(nn.Module):
    def __init__(self, in_channels: int):
        super().__init__()
        self.branch1x1 = _BasicConv2d(in_channels, 320, kernel_size=1)
        self.branch3x3_1 = _BasicConv2d(in_channels, 384, kernel_size=1)
        self.branch3x3_2a = _BasicConv2d(384, 384, kernel_size=(1, 3), padding=(0, 1))
        self.branch3x3_2b = _BasicConv2d(384, 384, kernel_size=(3, 1), padding=(1, 0))
        self.branch3x3dbl_1 = _BasicConv2d(in_channels, 448, kernel_size=1)
        self.branch3x3dbl_2 = _BasicConv2d(448, 384, kernel_size=3, padding=1)
        self.branch3x3dbl_3a = _BasicConv2d(384, 384, kernel_size=(1, 3), padding=(0, 1))
        self.branch3x3dbl_3b = _BasicConv2d(384, 384, kernel_size=(3, 1), padding=(1, 0))
        self.branch_pool = _BasicConv2d(in_channels, 192, kernel_size=1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b1 = self.branch1x1(x)
        b3 = self.branch3x3_1(x)
        b3 = torch.cat([self.branch3x3_2a(b3), self.branch3x3_2b(b3)], 1)
        b3d = self.branch3x3dbl_2(self.branch3x3dbl_1(x))
        b3d = torch.cat([self.branch3x3dbl_3a(b3d), self.branch3x3dbl_3b(b3d)], 1)
        bp = self.branch_pool(F.avg_pool2d(x, kernel_size=3, stride=1, padding=1))
        return torch.cat([b1, b3, b3d, bp], 1)


class _InceptionAux(nn.Module):
    def __init__(self, in_channels: int, num_classes: int):
        super().__init__()
        self.conv0 = _BasicConv2d(in_channels, 128, kernel_size=1)
        self.conv1 = _BasicConv2d(128, 768, kernel_size=5)
        self.fc = nn.Linear(768, num_classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x


class _InceptionFeatures(nn.Module):
    def __init__(self):
        super().__init__()
        self.Conv2d_1a_3x3 = _BasicConv2d(3, 32, kernel_size=3, stride=2)
        self.Conv2d_2a_3x3 = _BasicConv2d(32, 32, kernel_size=3)
        self.Conv2d_2b_3x3 = _BasicConv2d(32, 64, kernel_size=3, padding=1)
        self.maxpool1 = nn.MaxPool2d(kernel_size=3, stride=2)
        self.Conv2d_3b_1x1 = _BasicConv2d(64, 80, kernel_size=1)
        self.Conv2d_4a_3x3 = _BasicConv2d(80, 192, kernel_size=3)
        self.maxpool2 = nn.MaxPool2d(kernel_size=3, stride=2)
        self.Mixed_5b = _InceptionA(192, pool_features=32)
        self.Mixed_5c = _InceptionA(256, pool_features=64)
        self.Mixed_5d = _InceptionA(288, pool_features=64)
        self.Mixed_6a = _InceptionB(288)
        self.Mixed_6b = _InceptionC(768, channels_7x7=128)
        self.Mixed_6c = _InceptionC(768, channels_7x7=160)
        self.Mixed_6d = _InceptionC(768, channels_7x7=160)
        self.Mixed_6e = _InceptionC(768, channels_7x7=192)
        self.AuxLogits = _InceptionAux(768, 1000)
        self.Mixed_7a = _InceptionD(768)
        self.Mixed_7b = _InceptionE(1280)
        self.Mixed_7c = _InceptionE(2048)
        self.avgpool = nn.AdaptiveAvgPool2d((1, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.Conv2d_1a_3x3(x)
        x = self.Conv2d_2a_3x3(x)
        x = self.Conv2d_2b_3x3(x)
        x = self.maxpool1(x)
        x = self.Conv2d_3b_1x1(x)
        x = self.Conv2d_4a_3x3(x)
        x = self.maxpool2(x)
        x = self.Mixed_5b(x)
        x = self.Mixed_5c(x)
        x = self.Mixed_5d(x)
        x = self.Mixed_6a(x)
        x = self.Mixed_6b(x)
        x = self.Mixed_6c(x)
        x = self.Mixed_6d(x)
        x = self.Mixed_6e(x)
        x = self.Mixed_7a(x)
        x = self.Mixed_7b(x)
        x = self.Mixed_7c(x)
        return self.avgpool(x)


class BreastDensityInceptionV3(nn.Module):
    def __init__(self, num_classes: int = 4):
        super().__init__()
        self.features = _InceptionFeatures()
        self.fc = nn.Linear(2048, num_classes)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.features(x)
        return self.fc(torch.flatten(x, 1))
