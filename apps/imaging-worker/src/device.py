import platform
import os
import torch

def get_optimal_device() -> torch.device:
    """
    Selects the optimal hardware acceleration device:
    1. Apple Silicon MPS (Metal Performance Shaders on macOS)
    2. NVIDIA CUDA (Linux / Windows with GPU)
    3. CPU (Multi-core with AVX acceleration)
    """
    force = os.environ.get("IMAGING_DEVICE", "").strip().lower()
    if force == "cpu":
        return torch.device("cpu")
    if force == "mps" and torch.backends.mps.is_available():
        return torch.device("mps")
    if force == "cuda" and torch.cuda.is_available():
        return torch.device("cuda")

    if torch.backends.mps.is_available() and torch.backends.mps.is_built():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")

_DEVICE_INFO_CACHE: dict = {}

def get_device_info() -> dict:
    force = os.environ.get("IMAGING_DEVICE", "").strip().lower()
    if force in _DEVICE_INFO_CACHE:
        return dict(_DEVICE_INFO_CACHE[force])

    device = get_optimal_device()
    info = {
        "device_type": device.type,
        "platform": platform.platform(),
        "processor": platform.processor() or platform.machine(),
        "python_version": platform.python_version(),
        "torch_version": torch.__version__,
    }

    if device.type == "mps":
        info["accelerator"] = "Apple Silicon Metal (MPS)"
        info["unified_memory"] = True
        # Check system memory on macOS
        try:
            import subprocess
            mem_out = subprocess.check_output(["sysctl", "-n", "hw.memsize"]).decode().strip()
            total_ram_gb = round(int(mem_out) / (1024 ** 3), 1)
            info["total_unified_ram_gb"] = total_ram_gb
        except Exception:
            info["total_unified_ram_gb"] = None
    elif device.type == "cuda":
        info["accelerator"] = f"NVIDIA CUDA ({torch.cuda.get_device_name(0)})"
        info["cuda_device_count"] = torch.cuda.device_count()
        vram_bytes = torch.cuda.get_device_properties(0).total_memory
        info["vram_gb"] = round(vram_bytes / (1024 ** 3), 2)
    else:
        info["accelerator"] = "CPU (Multi-threaded)"
        info["cpu_count"] = os.cpu_count()

    _DEVICE_INFO_CACHE[force] = dict(info)
    return info
