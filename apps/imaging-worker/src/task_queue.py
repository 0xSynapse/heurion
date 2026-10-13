import os
import time
import uuid
import threading
from enum import Enum
from pathlib import Path
from dataclasses import dataclass, asdict
from concurrent.futures import ThreadPoolExecutor, Future
from typing import Dict, Any, List, Optional, Callable

class TaskStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"

class TaskStage(str, Enum):
    QUEUED = "queued"
    PREPARING = "preparing"
    EXTRACTING = "extracting_volume"
    ANATOMICAL_MASKING = "anatomical_masking"
    SEGMENTING = "inference_segmentation"
    RECIST_CALCULATION = "recist_calculation"
    RENDERING = "rendering_publication_slice"
    COMPLETED = "completed"
    FAILED = "failed"

@dataclass
class AsyncTask:
    task_id: str
    status: TaskStatus
    stage: TaskStage
    progress_pct: int
    created_at: float
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    duration_sec: Optional[float] = None
    model_name: Optional[str] = None
    input_source: str = "volume"
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

class TaskManager:
    def __init__(self, max_workers: int = 2):
        self.lock = threading.Lock()
        self.tasks: Dict[str, AsyncTask] = {}
        self.futures: Dict[str, Future] = {}
        self.executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="HeurionImagingWorker")

    def submit_task(
        self,
        runner_fn: Callable[..., Dict[str, Any]],
        model_name: str,
        input_source: str,
        *args,
        **kwargs
    ) -> AsyncTask:
        task_id = f"task_{int(time.time())}_{uuid.uuid4().hex[:8]}"
        task = AsyncTask(
            task_id=task_id,
            status=TaskStatus.QUEUED,
            stage=TaskStage.QUEUED,
            progress_pct=0,
            created_at=time.time(),
            model_name=model_name,
            input_source=input_source
        )

        with self.lock:
            self._prune_expired_tasks()
            self.tasks[task_id] = task

        def _worker_wrapper():
            with self.lock:
                task.status = TaskStatus.RUNNING
                task.stage = TaskStage.PREPARING
                task.started_at = time.time()
                task.progress_pct = 10

            def progress_callback(stage: TaskStage, pct: int):
                with self.lock:
                    task.stage = stage
                    task.progress_pct = min(max(pct, 0), 99)

            try:
                # Execute user inference function with optional progress callback
                if "progress_cb" in kwargs or any(p in kwargs for p in ("progress_callback", "cb")):
                    res = runner_fn(*args, **kwargs)
                else:
                    try:
                        res = runner_fn(*args, progress_cb=progress_callback, **kwargs)
                    except TypeError:
                        res = runner_fn(*args, **kwargs)

                with self.lock:
                    task.status = TaskStatus.COMPLETED
                    task.stage = TaskStage.COMPLETED
                    task.progress_pct = 100
                    task.completed_at = time.time()
                    task.duration_sec = round(task.completed_at - (task.started_at or task.created_at), 3)
                    task.result = res
            except Exception as exc:
                with self.lock:
                    task.status = TaskStatus.FAILED
                    task.stage = TaskStage.FAILED
                    task.completed_at = time.time()
                    task.duration_sec = round(task.completed_at - (task.started_at or task.created_at), 3)
                    task.error = str(exc)

        future = self.executor.submit(_worker_wrapper)
        with self.lock:
            self.futures[task_id] = future

        return task

    def update_progress(self, task_id: str, stage: TaskStage, progress_pct: int):
        with self.lock:
            task = self.tasks.get(task_id)
            if task and task.status == TaskStatus.RUNNING:
                task.stage = stage
                task.progress_pct = min(max(progress_pct, 0), 99)

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            task = self.tasks.get(task_id)
            if not task:
                return None
            res = asdict(task)
            res["status"] = task.status.value
            res["stage"] = task.stage.value
            if task.started_at and task.status == TaskStatus.RUNNING:
                res["elapsed_sec"] = round(time.time() - task.started_at, 2)
            return res

    def list_tasks(self, limit: int = 50) -> List[Dict[str, Any]]:
        with self.lock:
            sorted_tasks = sorted(self.tasks.values(), key=lambda t: t.created_at, reverse=True)[:limit]
            results = []
            for t in sorted_tasks:
                d = asdict(t)
                d["status"] = t.status.value
                d["stage"] = t.stage.value
                results.append(d)
            return results

    def cancel_task(self, task_id: str) -> bool:
        with self.lock:
            task = self.tasks.get(task_id)
            future = self.futures.get(task_id)
            if not task:
                return False
            if task.status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED):
                return False

            if future and future.cancel():
                task.status = TaskStatus.CANCELLED
                task.stage = TaskStage.FAILED
                task.error = "Task cancelled by client"
                return True
            else:
                task.status = TaskStatus.CANCELLED
                task.stage = TaskStage.FAILED
                task.error = "Task marked for cancellation"
                return True

    def _prune_expired_tasks(self, ttl_seconds: int = 7200):
        """Removes completed or failed tasks older than TTL."""
        now = time.time()
        to_del = [
            tid for tid, t in self.tasks.items()
            if t.status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED)
            and (now - t.created_at) > ttl_seconds
        ]
        for tid in to_del:
            self.tasks.pop(tid, None)
            self.futures.pop(tid, None)

# Global singleton task manager for the imaging worker process
task_manager = TaskManager(max_workers=int(os.environ.get("IMAGING_CONCURRENCY", "2")))


def process_cohort_case(
    engine: Any,
    case: Dict[str, Any],
) -> Dict[str, Any]:
    """Processes a single patient/subject scan within a cohort batch."""
    subject_id = case.get("subject_id") or case.get("patient_id")
    sample_id = case.get("sample_id")
    file_path = case.get("file_path")
    model_name = case.get("model_name")
    target = file_path or sample_id
    if not subject_id:
        return {"subject_id": None, "model_name": model_name, "status": "failed", "error": "缺失受试者标识 (subject_id / patient_id)"}
    if not model_name:
        return {"subject_id": subject_id, "model_name": None, "status": "failed", "error": "缺失分析模型 (model_name)"}
    if not target:
        return {
            "subject_id": subject_id,
            "model_name": model_name,
            "status": "failed",
            "error": "缺失受试者影像文件路径 (file_path) 或有效样本标识",
        }

    row: Dict[str, Any] = {
        "subject_id": subject_id,
        "model_name": model_name,
        "status": "success",
    }
    try:
        vol, spacing, modality = engine.load_volume_data(target)
        if model_name in ("whole_body_ct_segmenter", "totalsegmentator"):
            # 人口学信息只传调用方实际给出的字段，缺失即不传，不代入默认性别/身高/体重
            demo = {k: case[k] for k in ("patient_sex", "patient_height_m", "patient_weight_kg") if case.get(k) is not None}
            res = engine.analyze_volume(
                volume=vol,
                spacing=spacing,
                model_name=model_name,
                modality=modality,
                **demo,
            )
            bc = res.get("body_composition", {}) or {}
            ov = res.get("organ_volumetry_cm3", {}) or {}
            row.update({
                "sma_cm2": bc.get("skeletal_muscle_area_cm2"),
                "smi_cm2_m2": bc.get("skeletal_muscle_index_cm2_m2"),
                "vat_cm2": bc.get("visceral_adipose_cm2"),
                "sat_cm2": bc.get("subcutaneous_adipose_cm2"),
                "vat_to_sat_ratio": bc.get("vat_to_sat_ratio"),
                "muscle_hu": bc.get("muscle_radiodensity_hu"),
                "liver_volume_cm3": ov.get("liver"),
                "spleen_volume_cm3": ov.get("spleen"),
            })
        else:
            res = engine.analyze_volume(
                volume=vol,
                spacing=spacing,
                model_name=model_name,
                modality=modality,
            )
            rec = res.get("recist_metrics", {}) or {}
            has_lesion = rec.get("has_lesion")
            row.update({
                "longest_diameter_mm": rec.get("longest_diameter_mm"),
                "short_axis_mm": rec.get("short_axis_mm"),
                "total_volume_cm3": rec.get("total_volume_cm3"),
                "has_lesion": None if has_lesion is None else (1 if has_lesion else 0),
            })
            em = rec.get("emphysema")
            if isinstance(em, dict):
                row.update({
                    "laa_percent": em.get("laa_percent"),
                    "total_lung_volume_liters": em.get("total_lung_volume_liters"),
                    "perc15_hu": em.get("perc15_hu"),
                })
    except Exception as exc:
        row["status"] = "failed"
        row["error"] = str(exc)

    return row


def batch_process_cohort(
    engine: Any,
    cases: List[Dict[str, Any]],
    study_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Executes high-throughput batch processing for a cohort of patients.
    Aggregates multi-modal 3D imaging metrics into a clean Wide-Format Research DataFrame.
    """
    import io
    import csv

    results = []
    for c in cases:
        row = process_cohort_case(engine, c)
        results.append(row)

    all_keys = []
    priority = ["subject_id", "status", "longest_diameter_mm", "short_axis_mm", "total_volume_cm3", "smi_cm2_m2", "vat_to_sat_ratio"]
    for p in priority:
        if any(p in r for r in results) and p not in all_keys:
            all_keys.append(p)
    for r in results:
        for k in r.keys():
            if k not in all_keys and k != "error":
                all_keys.append(k)

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=all_keys, extrasaction="ignore")
    writer.writeheader()
    for r in results:
        writer.writerow(r)

    csv_content = output.getvalue()

    return {
        "status": "success",
        "study_id": study_id,
        "total_cases": len(cases),
        "successful_cases": sum(1 for r in results if r.get("status") == "success"),
        "failed_cases": sum(1 for r in results if r.get("status") == "failed"),
        "columns": all_keys,
        "dataframe_rows": results,
        "csv_content": csv_content,
        "summary_markdown": f"### 临床研究队列影像特征批量流水线完成\n- **入组受试者数**: {len(cases)} 例\n- **提取特征列数**: {len(all_keys)} 列\n- **已生成科研宽表 DataFrame**，可直接用于 Table 1 基线表或生存分析。"
    }

