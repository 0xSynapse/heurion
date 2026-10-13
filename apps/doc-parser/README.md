# doc-parser：本地 PDF 结构化解析服务（Docling）

平台 PDF 导入的主路径。用 [Docling](https://github.com/docling-project/docling)（IBM 开源，MIT 许可）做版面分析、
表格结构识别、公式识别（LaTeX）与扫描页 OCR，把 PDF 转成按阅读顺序排好的结构化块；平台
（`apps/platform/src/convert/doc-parser.ts`）再转成文档模型。服务没起来、预热未完成或解析失败时，平台自动退回
poppler 启发式方案（`pdf-import.ts` 的 `importPdfPoppler`），导入结果的 `importEngine` 记录用的是哪条路径。

**数据不出本机**：服务默认只监听 `127.0.0.1:8005`；模型在部署时预先下载，运行时强制离线
（`HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`，`artifacts_path` 显式指向本地模型目录），缺模型直接启动失败，绝不在运行时下载。
容器部署时它只接入没有出网路由的 `internal` 网络。

## 本地开发

```bash
cd apps/doc-parser
uv sync --python 3.12 --extra dev           # 安装依赖（含 PyTorch，约 1.1 GB）

# 首次使用前：联网预下载模型（约 1.4 GB）到 仓库根/data/doc-parser-models（data/ 已在 .gitignore）
HF_HUB_DISABLE_XET=1 uv run python -m src.prefetch_models
#   --output DIR    指定目录（服务用 DOC_PARSER_MODELS_DIR 指向同一目录）
#   --no-formula    不下公式模型（省 640 MB，公式识别随之关闭）

uv run python -m src.server                  # 启动：127.0.0.1:8005，启动后自动预热
curl -s localhost:8005/health                # 预热中 503 {"status":"warming"}；就绪 200 {"status":"ready"}
curl -s -F file=@paper.pdf localhost:8005/parse

uv run pytest                                # 测试；没下载模型时需要模型的用例自动跳过
```

> `HF_HUB_DISABLE_XET=1`：Hugging Face 的 Xet 传输在部分网络下会卡在 0 字节（本机实测），改走普通 HTTPS 下载。

平台侧默认连 `http://127.0.0.1:8005`（`DOC_PARSER_URL`；设为 `off` 则只用 poppler），解析超时 `DOC_PARSER_TIMEOUT_MS`（默认 10 分钟）。

## 模型清单（`prefetch_models` 下载；本机实测体积，Docling 2.138）

| 目录 | 用途 | 体积 | 必需 |
| --- | --- | --- | --- |
| `docling-project--docling-layout-heron` | 版面分析（标题 / 段落 / 列表 / 表 / 图 / 公式区域、阅读顺序） | 172 MB | 是 |
| `docling-project--docling-layout-heron-onnx` | 同一模型的 ONNX 版（下载器一并拉取；走 PyTorch 引擎用不到，实测删掉后正常，镜像里已删） | 171 MB | 否 |
| `docling-project--docling-models` | 表格结构（TableFormer，accurate 模式） | 358 MB | 是 |
| `docling-project--CodeFormulaV2` | 公式识别 → LaTeX | 640 MB | 否（缺了就不做公式识别） |
| `RapidOcr` | 扫描页 OCR（PP-OCR 检测 / 识别 / 方向分类，ONNX，中英文） | 64 MB | 是 |
| **合计** | | **约 1.4 GB（镜像里删掉 ONNX 版后约 1.23 GB；不含公式模型约 0.59 GB）** | |

模型目录：本地开发默认 `data/doc-parser-models`（仓库根下），镜像里是 `/models`；都可用 `DOC_PARSER_MODELS_DIR` 覆盖。

## 内存与配置

本机实测（macOS / Apple Silicon，进程峰值 RSS；Linux 容器里会有出入）：

| 场景 | 公式识别开 | 公式识别关（`DOC_PARSER_FORMULA=0`） |
| --- | --- | --- |
| 预热完成后空闲 | 0.6–1.1 GB | 0.6–1.0 GB |
| 纯文字 PDF（1 页）解析峰值 | 1.36 GB | 1.33–1.41 GB |
| 含扫描页的 PDF（2 页，1 页 OCR）连续解析 5 次的峰值 | 2.3 GB | 2.3–2.4 GB |
| 8 页（4 页扫描）解析峰值：不分段 / 每段 2 页 | — | 3.3 GB / 3.1 GB |
| 16 页（8 页扫描）解析峰值：不分段 / 每段 2 页 | — | 3.5 GB / 3.1 GB |

- 关公式省的是公式区域的识别计算：样例里没几个公式，所以峰值差别不大；公式多的论文差别会更明显。
  主要的内存开销是扫描页 OCR（一页扫描页约 +0.9 GB）。
- Docling 在整次转换期间持有所有页的页图，峰值随页数增长；`DOC_PARSER_PAGE_CHUNK=N` 改为每次只转换 N 页，
  结果和整篇转换一致（有测试），长文档的峰值基本固定。
- 每次解析后会 `gc` 加 `malloc_trim`（Linux）归还内存；容器里再配 `MALLOC_ARENA_MAX=2` 减少碎片。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOC_PARSER_FORMULA` | `1` | 公式识别；8 GB 生产机上 compose 设为 `0` |
| `DOC_PARSER_PAGE_CHUNK` | `0`（不分段） | 每段页数；compose 设为 `2` |
| `DOC_PARSER_THREADS` | `4`（镜像里 `2`） | CPU 线程数 |
| `DOC_PARSER_MODELS_DIR` | `data/doc-parser-models` / `/models` | 模型目录 |
| `DOC_PARSER_MAX_BYTES` / `DOC_PARSER_MAX_PAGES` | 80 MB / 400 页 | 单个 PDF 上限 |

### 在 16 GB 机器上开启公式识别

镜像默认已经带公式模型（`WITH_FORMULA=1`），不用重建镜像：

1. 在 `deploy/docker-compose.yml` 的 doc-parser 里把 `DOC_PARSER_FORMULA=0` 改成 `1`（或删掉这一行）；
2. 放宽内存：`mem_limit` 调到 `3g`、`memswap_limit` 调到 `4g`（含公式模型时空闲约 1.1 GB，峰值约 3 GB 以上）；
   同时按文件开头的预算表放宽其他服务（例如 imaging-worker 设 `mem_limit: 3.5g`）；
3. `docker compose -p heurion2 --env-file .env.production up -d doc-parser`，然后 `docker exec heurion2-doc-parser python -c "import urllib.request,json;print(json.load(urllib.request.urlopen('http://127.0.0.1:8005/health'))['capabilities'])"`
   应看到 `"formula": true`。

如果镜像是用 `--build-arg WITH_FORMULA=0` 构建的，就得先用默认参数重建；没有模型时即使设了 `DOC_PARSER_FORMULA=1`，
公式识别也会自动关闭（`/health` 的 `capabilities.formula` 为 false），服务照常运行。

## 接口

- `GET /health`：`status` = `starting | warming | ready | error`；只有 `ready` 时返回 200，其余 503。附模型是否齐全、能力、预热耗时。
- `POST /parse`（multipart，字段 `file`）：返回

```jsonc
{
  "engine": "docling", "engine_version": "2.138.0", "page_count": 2,
  "blocks": [
    {"type": "heading", "level": 1, "text": "…", "page": 1},
    {"type": "paragraph", "text": "…", "page": 1},
    {"type": "list", "ordered": true, "start": 1, "items": ["…"], "page": 1},
    {"type": "table", "rows": [["…"]], "header_rows": 1, "caption": "…", "page": 1},
    {"type": "figure", "mime": "image/png", "data": "<base64>", "caption": "…", "page": 1},
    {"type": "formula", "latex": "\\frac{1}{1+e^{-x}}", "page": 1}
  ],
  "scanned_pages": [{"page": 2, "ocr": true}],   // OCR 没识别出文字时附 mime + data（整页图）
  "warnings": []
}
```

页眉页脚不输出；表格是规则网格（合并单元格的文字在左上角格）。未就绪时 `/parse` 返回 503。

## 启动与预热

1. 启动时检查模型目录，缺必需模型直接报错退出，并提示预下载命令。
2. 后台用内置的一页小 PDF（`src/sample_pdf.py`）跑一次完整解析，把版面、表格、公式模型加载进内存（本机约 5 秒）。
3. 预热完成前 `/health` 返回 503，平台据此直接走 poppler 兜底，不排队等待。

## 构建与离线部署

镜像构建期下载模型（`Dockerfile` 第 4 步），运行期不联网：

```bash
# 在联网机器上（构建上下文是仓库根目录）
docker build -f apps/doc-parser/Dockerfile -t heurion2-doc-parser:latest .
#   --build-arg WITH_FORMULA=0   不打包公式模型（镜像小 640 MB；以后要开公式就得重建）

# 拷到离线环境
docker save heurion2-doc-parser:latest | gzip > doc-parser.tar.gz
scp doc-parser.tar.gz target:/opt/heurion2/
ssh target 'docker load < /opt/heurion2/doc-parser.tar.gz'

# deploy/docker-compose.yml 已有 doc-parser 服务（DOC_PARSER_IMAGE 指定镜像）
```

不用 Docker 的离线环境：在联网机器上运行 `prefetch_models --output DIR`，把 `DIR` 整个拷过去，
服务端设 `DOC_PARSER_MODELS_DIR=DIR`（Python 依赖用 `uv sync` 在联网机器上装好后整体拷贝，或用内网镜像源）。

生产部署（`deploy/docker-compose.yml`）：

- `doc-parser` 只接入 `parser` 网络（`internal: true`，没有默认网关，容器发不出外网请求），不映射端口；
- 平台通过 `DOC_PARSER_URL=http://doc-parser:8005` 访问；平台不等 doc-parser 预热完成就启动；
- CI（`.github/workflows/deploy-v2.yml`）构建并推送 `heurion2-doc-parser` 镜像，`deploy.sh` 需要 `DOC_PARSER_IMAGE`。

## 已知限制

- 标题层级来自 Docling 的层级推断（书签、编号、字号）加平台的修正（第一页开头不带编号的标题视为文档标题），无编号、字号接近的标题可能层级不准。
- 嵌套列表平铺为一层；表格合并单元格不保留合并关系（文字放在左上角格）。
- 行内格式（粗体、斜体、上下标、链接）暂不保留；行内公式随段落以纯文字输出。
- 公式在平台里没有专用节点，用代码样式段落（`style: 'Code'`）保存 `$$LaTeX$$` 源码。
- CPU 上每页约 0.5–3 秒；单个请求串行处理（避免并发时内存翻倍）。
- 8 GB 生产机上扫描页多的 PDF 峰值会超过 `mem_limit`，要靠 swap（`memswap_limit`），这时会明显变慢；被 OOM 杀掉时容器自动重启，期间平台退回 poppler。
- OCR 模型在第一次遇到扫描页时才加载（预热 PDF 没有位图），首个扫描页多约 1 秒。
