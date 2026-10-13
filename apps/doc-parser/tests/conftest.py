"""测试公共设施：模型是否已预下载、网络守卫。"""

from __future__ import annotations

import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import settings  # noqa: E402
from src.parser import check_models  # noqa: E402

HAS_MODELS = all(v for k, v in check_models(settings.MODELS_DIR).items() if k != "code_formula")
needs_models = pytest.mark.skipif(
    not HAS_MODELS,
    reason=f"需要先预下载 Docling 模型到 {settings.MODELS_DIR}（uv run python -m src.prefetch_models）",
)


class NetworkAttempt(AssertionError):
    pass


@pytest.fixture
def no_network(monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    """禁止连接本机以外的地址：任何外连都会抛错并被记录。"""
    attempts: list[tuple] = []
    real_connect = socket.socket.connect

    def guarded_connect(self: socket.socket, address: tuple) -> None:  # type: ignore[override]
        host = address[0] if isinstance(address, tuple) else str(address)
        if isinstance(host, str) and (host.startswith("127.") or host in ("localhost", "::1")):
            return real_connect(self, address)
        attempts.append(address)
        raise NetworkAttempt(f"运行时尝试联网：{address}")

    def guarded_getaddrinfo(host: str, *args, **kwargs):  # noqa: ANN002, ANN003
        if host in ("127.0.0.1", "localhost", "::1"):
            return real_getaddrinfo(host, *args, **kwargs)
        attempts.append((host,))
        raise NetworkAttempt(f"运行时尝试解析域名：{host}")

    real_getaddrinfo = socket.getaddrinfo
    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket, "getaddrinfo", guarded_getaddrinfo)
    return attempts
