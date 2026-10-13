"""服务行为（不需要模型）：离线环境变量、缺模型即报错、预热前 not ready、接口校验。"""

from __future__ import annotations

import os
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src import parser as parser_mod
from src import server, settings
from src.sample_pdf import minimal_pdf


def test_enforce_offline_sets_env() -> None:
    settings.enforce_offline()
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    assert os.environ["TRANSFORMERS_OFFLINE"] == "1"


def test_server_import_forces_offline() -> None:
    # 导入 server 模块即进入离线模式
    assert os.environ["HF_HUB_OFFLINE"] == "1"


def test_missing_models_raise_with_prefetch_hint(tmp_path: Path) -> None:
    with pytest.raises(parser_mod.ModelsMissingError) as ei:
        parser_mod.ensure_models(tmp_path)
    assert "prefetch_models" in str(ei.value)
    assert all(v is False for v in parser_mod.check_models(tmp_path).values())


def test_startup_fails_without_models(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "MODELS_DIR", tmp_path)
    with pytest.raises(parser_mod.ModelsMissingError):
        with TestClient(server.app):
            pass


class _FakeParser:
    """代替 Docling：预热时阻塞在事件上，模拟模型加载中。"""

    gate = threading.Event()
    calls: list[str] = []

    def __init__(self) -> None:
        pass

    capabilities = {"table_structure": True, "formula": False, "ocr": True}

    def parse(self, data: bytes, filename: str) -> dict:
        if filename == "warmup.pdf":
            _FakeParser.gate.wait(5)
        _FakeParser.calls.append(filename)
        return {"engine": "docling", "page_count": 1, "blocks": [{"type": "paragraph", "text": "ok", "page": 1}], "scanned_pages": [], "warnings": []}


def test_health_not_ready_until_warmup_done(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "ensure_models", lambda _d: {})
    monkeypatch.setattr(server, "Parser", _FakeParser)
    server.state.status, server.state.parser, server.state.error = "starting", None, ""
    _FakeParser.gate.clear()
    _FakeParser.calls.clear()
    with TestClient(server.app) as client:
        r = client.get("/health")
        assert r.status_code == 503
        assert r.json()["ready"] is False
        assert r.json()["status"] in ("starting", "warming")
        # 未就绪时解析请求返回 503（平台据此退回 poppler）
        r = client.post("/parse", files={"file": ("a.pdf", minimal_pdf(), "application/pdf")})
        assert r.status_code == 503

        _FakeParser.gate.set()
        for _ in range(100):
            if client.get("/health").status_code == 200:
                break
            threading.Event().wait(0.05)
        body = client.get("/health").json()
        assert body["ready"] is True and body["status"] == "ready"
        assert _FakeParser.calls[0] == "warmup.pdf"

        r = client.post("/parse", files={"file": ("a.pdf", minimal_pdf(), "application/pdf")})
        assert r.status_code == 200
        assert r.json()["blocks"][0]["text"] == "ok"
        # 非 PDF 拒绝
        r = client.post("/parse", files={"file": ("a.txt", b"hello", "text/plain")})
        assert r.status_code == 400


def test_warmup_failure_stays_not_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    class Broken:
        def __init__(self) -> None:
            raise RuntimeError("模型损坏")

    monkeypatch.setattr(server, "ensure_models", lambda _d: {})
    monkeypatch.setattr(server, "Parser", Broken)
    server.state.status, server.state.parser, server.state.error = "starting", None, ""
    with TestClient(server.app) as client:
        for _ in range(100):
            if server.state.status == "error":
                break
            threading.Event().wait(0.05)
        r = client.get("/health")
        assert r.status_code == 503
        assert r.json()["status"] == "error"
        assert "模型损坏" in r.json()["error"]


def test_sample_pdf_has_text_layer() -> None:
    chars = parser_mod.page_text_chars(minimal_pdf())
    assert len(chars) == 1 and chars[0] > 50
