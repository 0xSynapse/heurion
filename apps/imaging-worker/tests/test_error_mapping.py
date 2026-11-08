"""raise_http / job_failure_detail 的异常分类：只有 InputError 算参数错误，库内部的 ValueError 按内部错误处理。"""
import logging
import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

from errors import InputError  # noqa: E402
from engine import ModelUnavailableError  # noqa: E402
from server import _log_level, job_failure_detail, raise_http  # noqa: E402


def _status_and_detail(exc: Exception):
    with pytest.raises(HTTPException) as info:
        raise_http(exc, "分析失败")
    return info.value.status_code, info.value.detail


def test_input_error_is_400_with_reason():
    assert _status_and_detail(InputError("至少需要一个正点（点在结节上）")) == (400, "分析失败: 至少需要一个正点（点在结节上）")


def test_plain_value_error_from_library_is_500():
    status, _ = _status_and_detail(ValueError("operands could not be broadcast together with shapes (512,512,3) (512,512)"))
    assert status == 500


def test_model_unavailable_is_501_and_missing_file_is_404():
    assert _status_and_detail(ModelUnavailableError("模型权重 lung_nodule_ct 不可用"))[0] == 501
    assert _status_and_detail(FileNotFoundError("ct.nii.gz"))[0] == 404


def test_http_exception_passes_through():
    assert _status_and_detail(HTTPException(status_code=422, detail="x")) == (422, "x")


def test_job_failure_detail_hides_internal_text():
    assert job_failure_detail(InputError("提示点须为 1~20 个")) == "提示点须为 1~20 个"
    assert "broadcast" not in job_failure_detail(ValueError("operands could not be broadcast"))
    assert "CUDA" not in job_failure_detail(HTTPException(status_code=500, detail="拉取模型失败: CUDA out of memory"))
    assert job_failure_detail(HTTPException(status_code=400, detail="缺少 model_name")) == "缺少 model_name"


def test_log_level_is_case_insensitive_and_falls_back():
    assert _log_level("debug") == logging.DEBUG
    assert _log_level(" Warning ") == logging.WARNING
    assert _log_level("verbose") == logging.INFO
    assert _log_level(None) == logging.INFO
