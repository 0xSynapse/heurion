"""
按内存预算排队的推理闸门与有上限的体积缓存，防止多用户同时分析时撑爆内存。

- MemoryGate：每个任务声明预计内存峰值（GB），在跑任务的占用之和不超过预算、并发数不超过上限时才放行；
  严格先来先到（队首放不下时后面的小任务也等），大任务不会被源源不断的小任务饿死；
  单个任务的声明超过整个预算时，等前面的都跑完后独占运行。
- VolumeCache：体积缓存按字节数设上限，超出时淘汰最久未用的（及其掩膜缓存）。

预算与各任务的峰值由环境变量配置；默认值来自本机实测（docs/design/IMAGING_STUDIES.md「资源与排队」）。
"""
from __future__ import annotations

import os
import threading
import time
from collections import OrderedDict
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, MutableMapping, Optional, Tuple

import numpy as np

GB = 1024 ** 3

# 各类任务的预计内存峰值（GB）。肺结节模型链：CPU 实测峰值 RSS 17.3 GB，GPU（MPS）实测内存占用峰值 11.7 GB
DEFAULT_COSTS_GB = {
    "lung_nodule_pipeline:cpu": 18.0,
    "lung_nodule_pipeline:gpu": 12.0,
    "default": 6.0,
}


def _env_float(name: str) -> Optional[float]:
    v = os.environ.get(name)
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def task_cost_gb(task: str, device_type: str = "cpu") -> float:
    """任务的预计峰值：环境变量 IMAGING_COST_<TASK>_GB 优先（如 IMAGING_COST_LUNG_NODULE_PIPELINE_GB），否则用默认表"""
    override = _env_float(f"IMAGING_COST_{task.upper()}_GB")
    if override is not None:
        return override
    kind = "cpu" if device_type == "cpu" else "gpu"
    return DEFAULT_COSTS_GB.get(f"{task}:{kind}", DEFAULT_COSTS_GB.get(task, DEFAULT_COSTS_GB["default"]))


def detect_memory_limit_bytes() -> Optional[int]:
    """容器内存上限（cgroup v2 / v1）；不在容器里时取物理内存"""
    for path in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = open(path).read().strip()
            if raw and raw != "max" and int(raw) < (1 << 60):
                return int(raw)
        except (OSError, ValueError):
            pass
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return None


def default_budget_gb() -> float:
    """IMAGING_MEMORY_BUDGET_GB；没配时取内存上限的 80%（留给体积缓存、框架与 Python 本身）"""
    env = _env_float("IMAGING_MEMORY_BUDGET_GB")
    if env is not None:
        return env
    limit = detect_memory_limit_bytes()
    return round(limit / GB * 0.8, 1) if limit else 16.0


class MemoryGate:
    def __init__(self, budget_gb: float, max_concurrent: int = 2):
        self.budget_gb = float(budget_gb)
        self.max_concurrent = max(1, int(max_concurrent))
        self._cond = threading.Condition()
        self._queue: List[int] = []
        self._running: Dict[int, Tuple[str, float, float]] = {}
        self._seq = 0

    def _fits(self, cost: float) -> bool:
        if not self._running:
            return True  # 空闲时任何任务都能跑（包括超过预算的，独占）
        used = sum(c for _, c, _ in self._running.values())
        return len(self._running) < self.max_concurrent and used + cost <= self.budget_gb

    @contextmanager
    def acquire(self, cost_gb: float, label: str = "task") -> Iterator[None]:
        with self._cond:
            self._seq += 1
            ticket = self._seq
            self._queue.append(ticket)
            while not (self._queue[0] == ticket and self._fits(cost_gb)):
                self._cond.wait()
            self._queue.pop(0)
            self._running[ticket] = (label, float(cost_gb), time.time())
            self._cond.notify_all()  # 下一个队首也许也放得下
        try:
            yield
        finally:
            with self._cond:
                self._running.pop(ticket, None)
                self._cond.notify_all()

    def slot(self, cost_gb: float, label: str = "task") -> "_Slot":
        """可直接用于 with 的对象（兼容原来的 `with INFERENCE_SEMAPHORE:` 写法）"""
        return _Slot(self, cost_gb, label)

    def status(self) -> Dict[str, Any]:
        with self._cond:
            now = time.time()
            return {
                "budget_gb": self.budget_gb, "max_concurrent": self.max_concurrent,
                "in_use_gb": round(sum(c for _, c, _ in self._running.values()), 1),
                "running": [{"label": l, "cost_gb": c, "seconds": round(now - t, 1)} for l, c, t in self._running.values()],
                "queued": len(self._queue),
            }


class _Slot:
    """全局共享、多线程同时使用：每个线程的进出栈分开保存"""

    def __init__(self, gate: MemoryGate, cost: float, label: str):
        self.gate, self.cost, self.label = gate, cost, label
        self._local = threading.local()

    def __enter__(self):
        cm = self.gate.acquire(self.cost, self.label)
        stack = getattr(self._local, "stack", None)
        if stack is None:
            stack = self._local.stack = []
        stack.append(cm)
        return cm.__enter__()

    def __exit__(self, *exc):
        return self._local.stack.pop().__exit__(*exc)


def _nbytes(entry: Any) -> int:
    arr = entry[0] if isinstance(entry, tuple) else entry
    return int(arr.nbytes) if isinstance(arr, np.ndarray) else 0


class VolumeCache(MutableMapping):
    """按字节数设上限的 LRU 体积缓存（值为 (volume, spacing, modality)）；淘汰时调用 on_evict(key)"""

    def __init__(self, max_bytes: int, on_evict: Optional[Callable[[str], None]] = None):
        self.max_bytes = int(max_bytes)
        self.on_evict = on_evict
        self._d: "OrderedDict[str, Any]" = OrderedDict()
        self._bytes = 0
        self._lock = threading.RLock()

    def __getitem__(self, key: str) -> Any:
        with self._lock:
            value = self._d[key]
            self._d.move_to_end(key)
            return value

    def __setitem__(self, key: str, value: Any) -> None:
        with self._lock:
            if key in self._d:
                self._bytes -= _nbytes(self._d.pop(key))
            self._d[key] = value
            self._bytes += _nbytes(value)
            # 刚放进来的那个不淘汰（哪怕它自己就超过上限）
            while self._bytes > self.max_bytes and len(self._d) > 1:
                old, val = self._d.popitem(last=False)
                self._bytes -= _nbytes(val)
                if self.on_evict:
                    self.on_evict(old)

    def __delitem__(self, key: str) -> None:
        with self._lock:
            self._bytes -= _nbytes(self._d.pop(key))

    def __contains__(self, key: object) -> bool:
        with self._lock:
            return key in self._d

    def __iter__(self):
        with self._lock:
            return iter(list(self._d))

    def __len__(self) -> int:
        return len(self._d)

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {"volumes": len(self._d), "bytes_gb": round(self._bytes / GB, 2), "max_gb": round(self.max_bytes / GB, 2)}


def default_cache_bytes() -> int:
    """IMAGING_VOLUME_CACHE_GB，默认 6 GB"""
    return int((_env_float("IMAGING_VOLUME_CACHE_GB") or 6.0) * GB)
