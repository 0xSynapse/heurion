"""doc-parser HTTP 服务（FastAPI）。

- 默认只监听 127.0.0.1:8005（容器里由 DOC_PARSER_HOST=0.0.0.0 打开内部网络，且不映射端口）。
- 启动时检查本地模型目录：缺必需模型立即报错退出（给出预下载命令），绝不在运行时下载。
- 启动后用内置一页 PDF 预热（把模型加载进内存）；预热完成前 /health 返回 503 + status=warming，
  平台据此走 poppler 兜底。
- POST /parse：multipart 上传 PDF（字段 file）→ 结构化块（见 parser.py）。

运行：uv run python -m src.server
"""

from __future__ import annotations

import logging
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import settings

settings.enforce_offline()

from .parser import ModelsMissingError, Parser, check_models, engine_version, ensure_models  # noqa: E402
from .sample_pdf import minimal_pdf  # noqa: E402

log = logging.getLogger("doc-parser")


class State:
    status = "starting"  # starting | warming | ready | error
    error = ""
    parser: Parser | None = None
    warmup_seconds: float | None = None


state = State()


def _warmup() -> None:
    state.status = "warming"
    t0 = time.monotonic()
    try:
        parser = Parser()
        parser.parse(minimal_pdf(), "warmup.pdf")
        state.parser = parser
        state.warmup_seconds = round(time.monotonic() - t0, 1)
        state.status = "ready"
        log.info("预热完成，用时 %.1fs", state.warmup_seconds)
    except Exception as err:  # 预热失败：服务保持 not ready，平台走兜底
        state.status = "error"
        state.error = str(err)[:500]
        log.exception("预热失败")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # 缺模型时启动即失败（不进入运行状态，更不会去下载）
    ensure_models(settings.MODELS_DIR)
    threading.Thread(target=_warmup, name="doc-parser-warmup", daemon=True).start()
    yield


app = FastAPI(title="Heurion doc-parser", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> JSONResponse:
    body: dict[str, Any] = {
        "status": state.status,
        "ready": state.status == "ready",
        "engine": "docling",
        "engine_version": engine_version(),
        "models_dir": str(settings.MODELS_DIR),
        "models": check_models(settings.MODELS_DIR),
    }
    if state.parser:
        body["capabilities"] = state.parser.capabilities
    if state.warmup_seconds is not None:
        body["warmup_seconds"] = state.warmup_seconds
    if state.error:
        body["error"] = state.error
    return JSONResponse(body, status_code=200 if state.status == "ready" else 503)


@app.post("/parse")
async def parse(file: UploadFile = File(...)) -> JSONResponse:
    if state.status != "ready" or state.parser is None:
        raise HTTPException(503, detail={"status": state.status, "error": state.error or "服务尚未就绪"})
    data = await file.read(settings.MAX_BYTES + 1)
    if len(data) > settings.MAX_BYTES:
        raise HTTPException(413, detail=f"文件超过 {settings.MAX_BYTES // (1024 * 1024)} MB")
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, detail="不是 PDF 文件")
    try:
        result = await run_in_threadpool(state.parser.parse, data, file.filename or "input.pdf")
    except ValueError as err:
        raise HTTPException(400, detail=str(err)) from err
    except Exception as err:
        log.exception("解析失败")
        raise HTTPException(422, detail=f"解析失败：{str(err)[:300]}") from err
    return JSONResponse(result)


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    try:
        ensure_models(settings.MODELS_DIR)
    except ModelsMissingError as err:
        raise SystemExit(f"[doc-parser] {err}") from err
    uvicorn.run(app, host=settings.HOST, port=settings.PORT, workers=1)


if __name__ == "__main__":
    main()
