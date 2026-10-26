"""
推理闸门与体积缓存（src/resource_gate.py）：按内存预算排队、先来先到、超预算任务独占、并发上限、
共享 slot 的多线程安全、体积缓存按字节淘汰并清掩膜；/health 暴露闸门与缓存状态。
"""
import os
import sys
import threading
import time

import numpy as np
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from resource_gate import MemoryGate, VolumeCache, task_cost_gb  # noqa: E402


def run_jobs(gate, jobs, hold=0.15):
    """jobs: [(name, cost, start_delay[, priority])]；返回每个任务开始与结束的时刻"""
    log = {}
    lock = threading.Lock()

    def work(name, cost, delay, priority=False):
        time.sleep(delay)
        with gate.acquire(cost, name, priority=priority):
            with lock:
                log[name] = [time.monotonic(), None]
            time.sleep(hold)
            with lock:
                log[name][1] = time.monotonic()

    ts = [threading.Thread(target=work, args=j) for j in jobs]
    for t in ts:
        t.start()
    for t in ts:
        t.join(10)
    return log


def overlap(a, b):
    return a[0] < b[1] and b[0] < a[1]


def test_budget_blocks_second_big_task():
    gate = MemoryGate(budget_gb=26, max_concurrent=2)
    log = run_jobs(gate, [("p1", 18, 0), ("p2", 18, 0.02)])
    assert not overlap(log["p1"], log["p2"])  # 18 + 18 > 26：第二例肺结节分析排队


def test_small_tasks_share_budget():
    gate = MemoryGate(budget_gb=26, max_concurrent=2)
    log = run_jobs(gate, [("a", 6, 0), ("b", 6, 0.02)])
    assert overlap(log["a"], log["b"])


def test_fifo_head_of_line_prevents_starvation():
    # big 排在 small2 前面：small2 虽然放得下也要等 big 先跑
    gate = MemoryGate(budget_gb=26, max_concurrent=3)
    log = run_jobs(gate, [("small1", 10, 0), ("big", 18, 0.03), ("small2", 6, 0.06)])
    assert log["big"][0] >= log["small1"][1] - 0.01
    assert log["small2"][0] >= log["big"][0]


def test_oversized_task_runs_alone():
    gate = MemoryGate(budget_gb=10, max_concurrent=2)
    log = run_jobs(gate, [("huge", 30, 0), ("x", 1, 0.03)])
    assert not overlap(log["huge"], log["x"])


def test_max_concurrent():
    gate = MemoryGate(budget_gb=100, max_concurrent=1)
    log = run_jobs(gate, [("a", 1, 0), ("b", 1, 0.02)])
    assert not overlap(log["a"], log["b"])


def test_interactive_task_does_not_wait_for_pipeline():
    # CPU 生产配置：预算 26 GB、预留 4 GB。整例分析（18 GB）在跑、另一例在排队时，点选分割（4 GB）立即放行
    gate = MemoryGate(budget_gb=26, max_concurrent=2, reserve_gb=4)
    log = run_jobs(gate, [("p1", 18, 0), ("p2", 18, 0.02), ("click", 4, 0.04, True)])
    assert overlap(log["p1"], log["click"])
    assert log["click"][0] < log["p2"][0]


def test_reserve_keeps_room_for_interactive():
    # 两个普通任务合计会吃进预留：第二个要等（预留只给交互任务用）
    gate = MemoryGate(budget_gb=26, max_concurrent=3, reserve_gb=4)
    log = run_jobs(gate, [("a", 12, 0), ("b", 12, 0.02)])
    assert not overlap(log["a"], log["b"])
    # 交互任务不占并发名额
    gate = MemoryGate(budget_gb=100, max_concurrent=1, reserve_gb=4)
    log = run_jobs(gate, [("a", 1, 0), ("click", 1, 0.02, True)])
    assert overlap(log["a"], log["click"])


def test_shared_slot_is_thread_safe_and_status():
    gate = MemoryGate(budget_gb=12, max_concurrent=2)
    slot = gate.slot(6, "inference")
    seen = []
    barrier = threading.Barrier(2)

    def work():
        with slot:
            seen.append(gate.status()["in_use_gb"])
            barrier.wait(timeout=2)

    ts = [threading.Thread(target=work) for _ in range(2)]
    [t.start() for t in ts]
    [t.join(5) for t in ts]
    assert max(seen) == 12.0
    st = gate.status()
    assert st["in_use_gb"] == 0 and st["queued"] == 0 and st["running"] == []


def test_task_cost_env_override(monkeypatch):
    assert task_cost_gb("lung_nodule_pipeline", "cpu") == 18.0
    assert task_cost_gb("lung_nodule_pipeline", "mps") == 12.0
    assert task_cost_gb("unknown_task") == 6.0
    monkeypatch.setenv("IMAGING_COST_LUNG_NODULE_PIPELINE_GB", "20")
    assert task_cost_gb("lung_nodule_pipeline", "cpu") == 20.0


def test_volume_cache_lru_by_bytes_and_evict_callback():
    evicted = []
    mb = 1024 * 1024
    cache = VolumeCache(max_bytes=10 * mb, on_evict=evicted.append)
    vol = lambda n: (np.zeros(n * mb, dtype=np.uint8), (1.0, 1.0, 1.0), "CT")
    cache["a"] = vol(4)
    cache["b"] = vol(4)
    _ = cache["a"]          # a 变成最近使用
    cache["c"] = vol(4)     # 超过 10 MB：淘汰最久未用的 b
    assert evicted == ["b"] and "a" in cache and "c" in cache and "b" not in cache
    cache["big"] = vol(20)  # 自己就超上限：其余全淘汰，自己保留
    assert list(cache) == ["big"]
    del cache["big"]
    assert cache.status()["bytes_gb"] == 0


def test_engine_evicts_masks_with_volume_and_health_reports(monkeypatch):
    import server
    eng = server.engine
    saved = eng.volume_cache.max_bytes
    eng.volume_cache.max_bytes = 2 * 1024 * 1024
    try:
        vol = np.zeros((16, 256, 256), dtype=np.float32)  # 4 MB，自己就超上限
        eng.register_volume("v1", vol, (1.0, 1.0, 1.0))
        eng.mask_cache["v1:m"] = np.zeros(1)
        eng.mask_method_cache["v1:m"] = "x"
        eng.register_volume("v2", vol, (1.0, 1.0, 1.0))
        assert not eng.has_volume("v1") and "v1:m" not in eng.mask_cache
        eng.remove_volume("v2")
    finally:
        eng.volume_cache.max_bytes = saved
    from fastapi.testclient import TestClient
    body = TestClient(server.app).get("/health").json()
    assert {"budget_gb", "in_use_gb", "queued", "running", "max_concurrent"} <= set(body["inference_gate"])
    assert {"volumes", "bytes_gb", "max_gb"} <= set(body["volume_cache"])
