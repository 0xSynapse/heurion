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
| `DOC_PARSER_FORMULA` | `1` | 公式识别；生产 compose 设为 `1`，内存紧的机器设为 `0` |
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
    {"type": "paragraph", "text": "risk3,4. M. tuberculosis …", "page": 1, "marks": [[4, 7, "sup"], [9, 24, "italic"]]},
    {"type": "list", "ordered": true, "start": 1, "items": ["…"], "page": 1},
    {"type": "table", "rows": [["…"]], "header_rows": 1, "caption": "…", "page": 1, "spans": [[0, 1, 1, 2]]},
    {"type": "figure", "mime": "image/png", "data": "<base64>", "caption": "…", "page": 1},
    {"type": "formula", "latex": "\\frac{1}{1+e^{-x}}", "page": 1}
  ],
  "scanned_pages": [{"page": 2, "ocr": true}],   // OCR 没识别出文字时附 mime + data（整页图）
  "warnings": []
}
```

页眉页脚不输出；表格是规则网格，合并单元格的文字在左上角格，被覆盖的格为空；`spans` 列出合并区 `[起始行, 起始列, 跨行数, 跨列数]`（没有合并时省略），与别的合并区重叠或盖住有字单元格的合并区不输出。未就绪时 `/parse` 返回 503。

### 版面整理（`_postprocess`，按位置与字号，不需要模型）

学术论文的期刊排版会让版面模型认错不少东西，输出前统一整理：

- **论文标题**：第一页上估算字号最大、至少 4 个词的文字（期刊名、logo 文字不足 4 个词），提到最前面作 1 级标题。
- **期刊版面杂物**：没有图注、面积不到页面 2% 的图（期刊 logo、页眉标志、「Check for updates」、许可证图标）不输出；
  被认成标题的版面标签（OPEN ACCESS、REVIEWED BY、CORRESPONDENCE、KEYWORDS 等）、第一页上字号明显小于正文的侧栏标题（含编辑、通讯作者姓名）、
  作者行、DOI / 日期还原成段落；图表下方的对象 DOI（`…g001`、`…t001`）去掉。
- **图里的文字**：挂在图片或表格下面的文字（坐标轴、图例、森林图里的数字）不进正文；图框外紧挨着图的短碎片（不超过 3 个词）去掉。
- **图注**：图注被并进图里时从图内文字找回（「FIGURE 2」加其下方对齐的文字）；独立成段的图注并回相邻的图
  （图注在前、在后、隔着一段图内注释、图注在页底而图在下一页顶部都认）。
- **子图**：同一页上连续的几张图、至少一张没有图注且图号不超过一个时合成一张，按合并后的区域从 PDF 重新裁图。
- **不是表格的「表格」**：题注是「Figure n」或没有内容、底下挂着一堆文字的（森林图等）按区域从 PDF 裁成图；只有一格字的（表注、图题）还原成段落。
  图表的脚注紧跟在图表后输出。
- **标题层级**：带编号的按编号深度；不带编号、能认出至少 3 个标准一级章节（引言、方法、结果、讨论、文末声明等）时，以这些为一级、其余为下级，
  Docling 的字号层级只用来判断是否再下一级；结构式摘要的小标题放到「Abstract」下一级。
- **断开的段落**：句子没写完的段落，与后面以小写开头或明显接续的正文段落接上，断词连字符去掉，中间隔着的块留在段后。
  可以跨过图、表、图表题注和字号明显比正文小的段落（脚注、表注、作者单位）；续段以小写开头时还能跨过标题和列表（换栏时版面顺序把下一栏的标题、文献表排在前面）；
  隔着整页的图表时续段可以在两页之后；行末断开的网址、中文（上一段末尾不是句末标点、下一段以汉字开头）也接上。
- **每页重复的页眉**：页面边缘、不带数字、三页以上都有的短文字（「Articles」「Author Manuscript」）去掉。
- **正文开始前的标题**：第一页上、第一个标准章节之前的标题（期刊名、文章类型、侧栏标签）还原成段落，导读框（Key Points、Research in context 等）除外。
- **被认成标题的图表题注**（「Figure 1 …」「TABLE 2 …」「表3 …」）还原成段落，按题注处理；只有图号的图注（「FIG. 1.」）并入图后紧跟的说明；
  前后都不挨着图的带图号图注给前面最近的、还没有带图号图注的图。

### 按 PDF 文字层修文字（`pdf_text.py`）

Docling 的块只有纯文字和位置。用 pypdfium2 逐字读出文字层（位置、字号、字体与粗斜体、基线、方向），与块文字逐字对齐后：

- **补回 Docling 弄丢的字**：两个词之间 PDF 里有间隔、Docling 拼接时丢了空格（「OtherMenopausal」）；行末的区间短横被当成断词去掉（「8.8–30.6」变成「8.830.6」，
  短横一律补回，普通连字符一边是数字时补回）；排版断词的软连字符（pdfium 记作 `\x02`）留下的「dia- betes」接成一个词。字距拉开的字（「T A B L E」）不补空格。
- **上下标与斜体**：比本行主字号小两成以上、基线抬高 / 降低的字是上 / 下标；Docling 在上标两边加的空格去掉（「risk 3,4 .」→「risk³,⁴.」）。
  段落与标题输出 `marks`：`[[起, 止, "sup" | "sub" | "italic"], …]`（按 `text` 的字符下标），平台据此加格式。表格单元格只补字，不去上标两边的空格、不给格式（单元格没有格式通道，去掉空格会把「10 9 /L」拼成「109/L」）。
- **段首小标题**：块开头一段粗体（或与本块正文不是同一种字体：有的 PDF 字体名是乱码、读不出粗细）、以句号或冒号结尾的，拆成标题 + 段落，放到所在章节下一级。
  版权页标签、作者贡献（人名后面是 CRediT 角色）、图表与附件编号、摘要里的「Background:」不拆。
- **标题层级**：有文字层的字样（字号、粗斜体、全大写）时，正文里不带编号、不是标准章节的小标题按字样分级：同一字样同一层级，先出现的层级高；没有字样信息时仍用 Docling 的层级。
- **论文标题**：按字号挑标题时词少的打折（刊头上的期刊名只有几个词）；版面模型漏掉了标题（文字层里有、不在任何块里）时，从第一页文字层找回字号最大的几行。
- **竖排印刷的表**：表格区域六成以上的字是竖排时，表格模型读出的行列是转置的，转回原来的行列（合并单元格丢弃）。
- 页面设了 `/Rotate` 的横向页：字的位置与方向换算到显示方向，与 Docling 的坐标一致。

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

- 标题层级按编号、标准章节名与文字层字样推断（见上）；正文第一个小标题若用的是三级字样，整篇的小标题层级会偏高一级。
- 段首小标题靠文字层的粗体 / 字体差异识别；没有文字层的扫描页认不出。
- 嵌套列表平铺为一层。
- 行内格式只保留上下标与斜体（段落、标题），表格单元格与列表项没有；粗体、链接不保留；行内公式随段落以纯文字输出。
  文字层读不出格式时，平台把无歧义的上标写法（kg/m²、I²、10⁹/L）还原成上标。
- 竖排印刷的表转回行列后，原表的分组表头（跨列合并的一行）常被表格模型漏掉。
- 公式在平台里没有专用节点，用代码样式段落（`style: 'Code'`）保存 `$$LaTeX$$` 源码。
- CPU 上每页约 0.5–3 秒；单个请求串行处理（避免并发时内存翻倍）。
- 内存紧的机器（如 8 GB）上扫描页多的 PDF 峰值会超过 `mem_limit`，要靠 swap（`memswap_limit`），这时会明显变慢；被 OOM 杀掉时容器自动重启，期间平台退回 poppler。生产服务器的上限见 `deploy/docker-compose.yml`。
- OCR 模型在第一次遇到扫描页时才加载（预热 PDF 没有位图），首个扫描页多约 1 秒。
