# Heurion 2.0 全仓库代码审查报告

- 日期：2026-10-12
- 基线提交：`2372ea73`（main）
- 范围：`apps/`（platform、imaging-worker、canvas-service、embedder、web 前端）、`deploy/`、`.github/workflows/`、Dockerfile、依赖锁定
- 方式：只读审查，未修改任何代码。按模块分 8 组并行审查，每条发现都沿真实调用链核对；最近一次提交的增量审查和收件乱码排查一并收录。

## 核实程度标记

| 标记 | 含义 |
|---|---|
| ✅ | 已人工打开代码逐行核对 |
| 🧪 | 已在本地运行代码复现（测试脚本用完即删，工作区干净） |
| （无标记） | 沿调用链阅读代码得出，未运行 |

## 严重程度与优先级

| 优先级 | 含义 | 建议时限 |
|---|---|---|
| **P0-A** | 可直接被利用的安全漏洞（提权、越权读患者数据、凭据泄露） | 立即 |
| **P0-B** | 编造或演示数据被当作真实结果写入论文、数据集或病历 | 本周 |
| **P1** | 统计或临床计算错误、守卫与权限被绕过、收件乱码 | 两周内 |
| **P2** | 稳定性、竞态、错误码、体验问题 | 排期 |

---

## P0-A　可直接利用的安全问题

### A1 ✅ 沙箱启动器：`.tmp` 符号链接导致提权到 root
- **位置**：`deploy/sandbox/heurion-sandbox-exec:33`
- **问题**：脚本以 root 执行 `mkdir -p "$WS/.tmp" && chown "$SBX_UID:$NODE_GID" "$WS/.tmp"`。脚本只检查了 `$WS` 本身是否为符号链接，没有检查 `.tmp`，而 `chown` 默认会跟随符号链接。
- **后果**：沙箱内的 AI 代码执行 `rm -rf .tmp && ln -s /usr/local/bin .tmp`，下一轮启动时 root 就把 `/usr/local/bin` 的属主交给沙箱 uid。随后沙箱代码可以替换 `heurion-sandbox-exec` 本身。平台用户 node 下一次经 sudo 调用它时，攻击者的脚本就以 root 运行，而容器带有 `NET_ADMIN` 能力。
- **修复**：先 `[ -L "$WS/.tmp" ] && die`，再用 `chown -h`；更稳妥的做法是用 `install -d -o … -g …` 原子创建，或改为 `openat`/`O_NOFOLLOW` 语义的辅助程序。

### A2 ✅ 沙箱启动器：`attachments` 符号链接导致全部数据可读
- **位置**：`deploy/sandbox/heurion-sandbox-exec:35-37`
- **问题**：`[ -d "$WS/attachments" ]` 会跟随符号链接；对命令行上给出的符号链接，`chmod -R u+rwX,g+rwX,o+rX` 和 `chown -R` 也会跟随。
- **后果**：AI 代码执行 `ln -s /app/data attachments` 后，`platform.db`、`tenants/*/patients.db` 以及所有用户的工作区都变成所有人可读，链接到 `/etc` 则 `/etc/shadow` 可读。沙箱隔离就此失效。
- **修复**：同 A1，先拒绝符号链接；`chown`/`chmod` 加 `-h` 或 `-P`，并去掉 `o+rX`。

### A3 ✅ 入站邮件密钥就是平台主密钥，且未配置时放行所有请求
- **位置**：`.github/workflows/deploy-v2.yml:126`、`.github/workflows/deploy-email-worker.yml:31`、`apps/platform/src/http/routes/mail-calendar.ts:384-387`、`deploy/cloudflare/email-worker.js:269-276`
- **问题**：
  - `MAIL_INBOUND_SECRET` 被设成 `HEURION_SECRET`。这个密钥签发所有登录和 MCP token；部署又没有设置 `HEURION_KEK`，所以机构患者数据的包装密钥也由它派生。
  - 这个值存放在 Cloudflare Worker 上，并在每封来信的 `X-Inbound-Secret` 请求头里发出。
  - 变量未设置时，`/api/mail/inbound` 不做任何校验；鉴权中间件还特意跳过了这个路径（`api.ts:300`）。
  - 两端都不核验发件人（SPF/DKIM），`from` 字段照单全收。
- **后果**：
  - 只要 Cloudflare 账号、Worker 日志或被改错的 `HEURION_INBOUND_URL` 任一处泄露，攻击者就拿到主密钥，可以伪造任意用户的 token，并解密 S3 备份里的患者数据。
  - 未配置时，匿名者可以把伪造的同事来信投进任意医生的收件箱，平台还会把它转发到医生的个人邮箱，等于一个钓鱼中继。
- **修复**：为入站邮件生成独立的随机密钥，并**轮换主密钥**；未配置时拒绝请求（fail-closed）；比较时用 `timingSafeEqual`；最好改用 HMAC 对请求体签名，而不是传输明文密钥。

### A4 canvas-service 不用登录就签发 token，默认不鉴权
- **位置**：`apps/canvas-service/src/app.ts:85-102`、`apps/canvas-service/src/index.ts:14-15`
- **问题**：
  - `GET /api/auth/session` 不需要登录，无论 `NODE_ENV` 是什么，都会为 `DEV_USER`（默认 `editor`）签发 web 和 MCP token（`d:'*'`、可读写、30 天有效）。
  - `DEV_MODE = NODE_ENV !== 'production'`，只要没设 `NODE_ENV`，鉴权就整体关闭。
  - `SECRET` 回退为硬编码的 `'omnicanvas-standalone-dev-secret'`。
  - WebSocket 升级时也不检查 Origin。
- **后果**：任何人 `curl /api/auth/session` 就能拿到对 `/api/*`、`/mcp` 和 `/collab` 都有效的 token；知道默认密钥的人还能自己伪造 token。
- **修复**：仅当显式设置 `DEV_MODE=1` 时才开放这个端点；生产环境没有 `SECRET` 就拒绝启动。

### A5 imaging-worker：上传 `.dcm` 文件可写到任意路径
- **位置**：`apps/imaging-worker/src/server.py:1254`
- **问题**：`os.path.join(tmp_dir, file.filename)` 直接使用客户端给的文件名。zip 和 tar 分支做了路径校验，这个分支没有。
- **后果**：文件名为 `/etc/cron.d/x.dcm`（绝对路径会覆盖掉 `tmp_dir`）或 `../../x.dcm` 时，可以把任意内容写到任何可写位置。
- **修复**：用 `os.path.basename` 清洗文件名，并校验 `realpath` 位于 `tmp_dir` 之内。

### A6 影像路径缺少访问控制，可读到其他租户或用户的 CT
- **位置**：
  - `apps/platform/src/http/routes/imaging.ts:180-421`（mpr/info、slice、diff-slice、radiomics 等 9 个处理函数）
  - `apps/platform/src/mcp/imaging-tools.ts:83, 152, 312, 360, 684, 831, 887, 948, 1009, 1069, 1129`
  - `apps/canvas-service/src/app.ts:447-453`
  - `apps/imaging-worker/src/server.py`：`/samples/{id}/file` 的修复用 `re.match` 加 `$`，会放过结尾的换行符（应改用 `re.fullmatch`）；约第 943 行的 `DATA_DIR / f"{sample_id}.nii.gz"` 没有校验；`server.py:809, 826` 及 `engine.py:1649-1669` 把传入的 `file_path` 当任意路径加载
- **问题**：客户端请求体或 AI 传入的 `volume_id`、`sample_id`、`file_path`、`baseline_id`/`followup_id` 原样转发给 worker，没有任何患者权限检查。worker 再按这些值去查内存缓存，或直接当文件系统路径读取。与此对照，`asset_upload` 和 `report_upload` 都有 `realpath` 检查。
- **后果**：任何登录用户（包括自助注册的个人账号）发送 `{"volume_id":"pt_<他人患者>_<文件ID>"}` 或 `{"file_path":"/app/data/platform/workspaces/<他人>/…"}`，就能拿到他人已解密 CT 的切片和指标。这也绕过了每用户一个 uid 的沙箱隔离。
- **修复**：平台侧只接受自己签发的不透明卷 ID，转发前做患者访问检查；worker 侧所有端点统一走一个路径解析函数，只允许白名单目录。

### A7 上传文件形成存储型 XSS
- **位置**：`apps/platform/src/http/api.ts:483, 491, 532`；`deploy/Caddyfile:3-6`
- **问题**：MIME 类型直接取浏览器上报的 `file.type`，返回时用 `inline`；没有 `X-Content-Type-Options: nosniff`，也没有 CSP。
- **后果**：家属（个人空间）上传 `text/html` 文件并分享给医生，医生打开 `/api/shares/:shid/files/:pfid?token=…` 时脚本在同源下执行，可以偷走 token 并读取患者数据。
- **修复**：服务端按文件内容判定类型，非图片和 PDF 一律用 `attachment` 返回；全站加 `nosniff` 和 CSP。

### A8 文档渲染形成存储型 XSS
- **位置**：`apps/platform/src/views/render.ts:62`（另见 `:28`）、`model/schema.ts:149-150`
- **问题**：`ordered_list.start` 没有转义就拼进 HTML；链接 `href` 做了转义，但没有限制协议，`javascript:` 可以通过。这两个属性可以经 Yjs 协作更新或 docx 导入写入。输出会进入 `web/src/patients.ts:4015`（医生查看家属分享文档）和 `web/src/phr.ts:859` 的 `innerHTML`。
- **复现** 🧪：把列表的 `start` 设为 `'1"><img src=x onerror=…>'`，`renderHtml` 输出了可执行的 `<img onerror>`。
- **修复**：所有属性都转义；`href` 只允许 http、https、mailto 和 `#`。

### A9 canvas 前端 XSS，可窃取 token
- **位置**：`apps/canvas-service/web/src/main.ts:113`（文档标题）、`:142-143`（幻灯片标题和版式名）
- **问题**：未转义就写入 `innerHTML`。标题可以经 PATCH 接口、MCP 或导入的 pptx 控制。
- **后果**：脚本可以读取 localStorage 里长期有效的 `omnicanvas_token` 和 `omnicanvas_mcp_token`。
- **修复**：改用 `textContent` 或统一的转义函数。

### A10 数据集导入：暂存目录可被篡改
- **位置**：`apps/platform/src/datasets/ingest.ts:54-57, 73`、`datasets/service.ts:106-110`
- **问题**：暂存目录位于用户自己的沙箱工作区内，权限是 0o2777。平台会信任其中的 `profile.json`，并用会跟随符号链接的 `copyFileSync` 复制 `out/data.csv`。
- **后果**：沙箱代码把 `data.csv` 换成指向他人 `datasets/<owner>/<id>/data.csv` 的符号链接，就能把别人的数据集复制到自己名下；改写 `profile.json` 去掉 PHI 标记，数据集就会直接变成 `ready`。
- **修复**：暂存目录放到沙箱之外；复制时用 `O_NOFOLLOW` 打开文件；PHI 识别由平台自己重新计算。

### A11 模型权重不校验，加载时可执行任意代码
- **位置**：`apps/imaging-worker/src/model_registry.py:512`（两个占位哈希在第 323 行和第 360 行）、`engine.py:432, 545, 645, 811`
- **问题**：下载的权重直接重命名进缓存，`spec.sha256` 只在显示状态时比较；加载时用 `torch.load(weights_only=False)`，只检查文件大于 1 MB。
- **后果**：被篡改的镜像源文件，或任何放进 `HEURION_MODEL_DIR` 的文件，都能通过 pickle 执行任意代码。
- **修复**：落盘前强制校验哈希，换上真实哈希，加载用 `weights_only=True`。

### A12 备份在容器内泄露，上传的备份未加密
- **位置**：`deploy/backup-to-s3.sh:41-46, 48-49, 53-68, 74-75`
- **问题**：
  - `docker exec` 以 root 身份、umask 022 运行，把 `platform.db`、`tenants/*/patients.db` 和打包文件以 0644/0755 权限写进容器共享的 `/tmp`。沙箱只重定向了 `TMPDIR`，仍然能访问 `/tmp`。
  - `platform.db`、工作区和 `datasets` 以明文 gzip 上传到 S3，`patients.db` 里的结构化列也没有加密。
- **后果**：沙箱代码在 02:20 前后轮询 `/tmp`，就能拷走全部数据库；S3 密钥一旦泄露，所有文稿和患者级科研数据都是明文。
- **修复**：备份写到 0700 的私有目录；上传前做客户端加密（age 或 gpg）。

### A13 沙箱内 shell 可访问外网，出网隔离失败时不阻止
- **位置**：`apps/platform/src/harness/pool.ts:72-87`、`harness/profile/heurion.cordis.yml:8-15`、`apps/platform/src/config.ts:60`、`deploy/entrypoint.sh:17-27`
- **问题**：
  - profile 只关闭了 web 工具，shell 仍可访问外网；`heurion-sandbox-exec` 不隔离网络命名空间。
  - `HEURION_SANDBOX` 默认为 0，此时 shell 以平台用户身份运行，能读取主密钥和数据库。
  - `entrypoint.sh` 在缺少 `NET_ADMIN` 时只打一条警告；判断「成功」只看循环里最后一条命令（ip6tables），IPv4 规则失败也会显示成功。
  - 用 `scripts/container.sh` 启动的容器没有 `cap_add`，所以隔离总是失效。
- **后果**：KB PDF 或 PubMed 摘要里的注入指令，可以让 AI 用 `curl` 把 `dataset_open`/`labs_open` 放进工作区的患者 CSV 发出去，绕过 CLAUDE.md 规定的数据外发边界。
- **修复**：沙箱进程默认放进无网络的命名空间；出网规则失败就拒绝启动（fail-closed）；生产环境强制 `HEURION_SANDBOX=1`。

### A14 token 写进 URL，被日志和 Referer 泄露
- **位置**：`apps/platform/src/http/api.ts:142`、`deploy/Caddyfile:30-33`、`deploy/Caddyfile:3-6`
- **问题**：
  - 会话 token 可以通过 `?token=` 传递，SSE、协作 WebSocket 和资源 URL 都这样用，Caddy 的 JSON 访问日志会完整记录请求 URI。
  - Caddy 只设置了 HSTS，没有 `nosniff`、`frame-ancestors`、`Referrer-Policy` 和 CSP。
  - 两个前端都把 token 存在 localStorage。
- **修复**：改用短时效的一次性票据，或使用 HttpOnly cookie；日志中脱敏 query；补齐安全响应头。

### A15 本地构建的镜像包含密钥
- **位置**：`.dockerignore:4`、`Dockerfile:21, 24`
- **问题**：只排除了根目录的 `.env`。`COPY . .` 再加 `chmod -R a+rX /app`，会把 `apps/platform/.env`（含真实的 `DEEPSEEK_API_KEY`）、`canvas.db`、`.venv-compute` 和 `imaging-worker/data` 打进镜像，且所有人可读。CI 用干净的检出构建，不受影响。
- **修复**：改用 `**/.env*` 等白名单式的 ignore；如果本地镜像曾经分发过，需要轮换 DeepSeek 密钥。

---

## P0-B　编造或演示数据被当作真实结果

这一类直接破坏科研数据的真实性，可能造成论文学术不端或误导临床，**严重程度不低于安全问题**。修复原则：**拿不到真实数据就报错，绝不用演示数据补位**；还要排查历史上已经生成的产物。

### B1 ✅ 队列批量影像分析不用患者自己的影像
- **位置**：`apps/platform/src/research/cohort.ts:151`
- **问题**：每个病例都用同一个写死的演示 `sample_id`（`chest_lung_ct`、`whole_body_ct` 或 `spleen_test`）；人口学数据是编造的，性别默认 `'M'`，身高 1.72 m，体重 68 kg。结果却作为研究数据集保存。
- **后果**：50 名入组患者的 50 行结果都来自同一个合成体积，SMI 和肌少症判定用的是虚构的身高体重。这份宽表会接着进入 Table 1 和生存分析。

### B2 队列分析在没有注入 cohort 服务时返回假受试者
- **位置**：`apps/platform/src/mcp/imaging-tools.ts:1189`
- **问题**：`deps.cohort` 缺失时，回退分支不做任何研究或患者权限检查；没传 `patient_ids` 时还会返回虚构的 `SUBJ_001`、`SUBJ_002` 作为成功结果。

### B3 投稿包基于编造的数据生成
- **位置**：`apps/platform/src/research/publication-bundle.ts:75-195, 321`，入口为 `http/routes/research.ts:198`
- **问题**：
  - 队列不足 120 人时补足到 120 人。
  - 治疗分组按行号奇偶决定；SMI、VAT/SAT、随访时间和死亡状态都由行号计算。
  - Love plot 的 SMD、CONSORT 排除人数（N 的 45%、30%、25%）、列线图系数、E 值的输入 HR 0.62，以及正文里「adjusted HR was 0.62 (95% CI 0.45–0.86, P < 0.001)」这句话，都是写死的。
- **后果**：一个只有 30 名真实患者的研究，下载到的 Table 1、KM 曲线、Cox 森林图、ROC/DCA 和方法、结果部分的文字，都建立在 90 多名虚构患者和虚构结局之上。

### B4 eCRF 自动填写用编造的值，并标注为真实来源
- **位置**：`apps/platform/src/research/ecrf.ts:198-270, 357, 381, 145`
- **问题**：
  - 编号为 S001–S004 的受试者，套用一张写死的数值表（随访、生存状态、分组、化验、影像）。
  - 其他受试者的 SMI、VAT 由行号计算，`treatment_arm = idx%2`，`os_status = idx%3==0`。
  - 这些单元格被标注为「MONAI 解剖分割自动化回填」或「临床队列基线登记」，置信度 0.92–0.98。
- **后果**：`saveDataset` 把它作为真实数据集上传，并标为可信数据，**跳过了 PHI 审核**。之后所有分析都会报告虚构的结局。

### B5 无影像文件时，演示扫描结果被写进真实病历
- **位置**：`apps/platform/src/mcp/imaging-tools.ts:104-108, 216`，经 `tenancy/patients.ts:741, 746-752`
- **问题**：`imaging_analyze` 收到 `patient_id` 但没有文件时，悄悄改用演示扫描，再经 `addImagingRecord` 以 `status:'confirmed'` 写进患者病历，并合并「ABPA疑诊」「肺结节待查」等诊断标签。这条路径不经过 `aiReview` 确认，即使机构设置了「AI 写入需医生确认」也照样写入。
- **相关**：没有患者也没有样本时，基准路径返回合成体模的测量值，图注却写着「目标病灶 RECIST 1.1 关键截面图」。

### B6 imaging-worker 找不到文件时，悄悄改用合成体模
- **位置**：`apps/imaging-worker/src/engine.py:1672`、`task_queue.py:192, 200`、`server.py:1064-1093`、`clinical_audit.py:76-127`
- **问题**：
  - `load_volume_data` 在 ID 或路径不存在时，退回到合成的 CT 体模。`process_cohort_case` 因此会对写错的 `file_path` 输出 `status: "success"` 的结果行。
  - `/analyze/whole-body` 在同样情况下返回合成的全身分析，包括 SMI 和肌少症判定，没有任何提示。
  - `clinical_audit` 返回写死的发现（结节 7.2 mm、比值 1.45、-74.9%、`clinical_audit_passed: True`）和一个看起来像真人的患者姓名；病例文件缺失时悄悄换成演示文件，`cases_dir` 取自查询参数且未校验（`server.py:1454`）。

### B7 器官体积和骨骼肌面积不是真实的测量值
- **位置**：`apps/imaging-worker/src/totalsegmentator.py:226, 232-237, 259, 270, 294-298`、`dicom_io.py:249`
- **问题**：
  - **器官体积**是按 HU 范围数体素，再乘任意系数（0.35、0.08、0.06、0.85），最后钳到「正常」范围内（例如肝 1150–2200 cm³、肾 220–400 cm³）。萎缩或肿大的器官都会报成正常，肝大、脾大标记和队列的体积列因此失真。
  - **骨骼肌面积（SMA）**是 L3 层面上 -29 到 150 HU 之间的全部像素，把肝、肾、肠壁、血管都算成了肌肉。SMA 和 SMI 严重偏高，真正的肌少症会被漏诊。名义上用的是 TotalSegmentator，实际并没有做肌肉分割。
  - **L3 定位**只是在 z 方向 20%–60% 的范围里找骨像素最多的一层；NIfTI 加载时没有重定向到标准方向，可能取到骨盆或胸椎层面。
  - **SMI** 用 `max(身高², 1.0)`，不检查单位：身高以厘米传入（172）时 SMI 约为 0.005，所有人都被判为肌少症；身高缺失时默认 1.72，算出的 SMI 看似合理，实为编造。

### B8 列线图刻度和 C-index 不是从模型算出来的
- **位置**：`apps/platform/src/research/prediction-models.ts:122, 197, 237`
- **问题**：概率刻度按 `(lp + 1.2) * (maxTotal/3)` 摆放，与预测变量得分的标定无关；基线生存率默认用虚构的 0.90/0.75/0.60；`c_index_estimate: 0.78` 是写死的。

### B9 生存分析的文字永远写「差异显著」
- **位置**：`apps/platform/src/datasets/survival.ts:1030`
- **问题**：只要有两组以上，就输出「Kaplan-Meier survival curves demonstrated a statistically significant difference」，不看 P 值。P = 0.62 时也这样写，并返回给 AI 和文档。

### B10 因果推断的模板文字与输入无关
- **位置**：`apps/platform/src/research/causal-inference.ts:49, 77`
- **问题**：接受 `rare_outcome` 参数却从不使用，常见结局的 OR/HR 没有换算成 RR，E 值被高估；第 77 行的模板对任何输入都声称研究「已全面校正…3D 影像学解剖表型」，包括不显著甚至有害的效应。

---

## P1-1　统计与临床计算错误

| # | 位置 | 问题与后果 |
|---|---|---|
| C1 | `datasets/table1.ts:473` | Mann-Whitney U 的 P 值多乘了 2：`2*erfc(z/√2)` 应为 `erfc(z/√2)`。z = 1.96 时报 P = 0.100 而不是 0.050，真实的基线不均衡被报成不显著 |
| C2 | `datasets/survival.ts:1083, 489` | 空值被当成 0（`Number('')`、`Number(null)` 都等于 0）。缺随访时间、标记为死亡的患者算作 t = 0 时死亡，KM 曲线、中位生存和 log-rank 都被拉低；Cox 的缺失协变量被当作 0 而不是剔除该行 |
| C3 | `datasets/imaging-survival.ts:118, 123` | 缺失值一律归入低值组，即「肌少症」组；性别编码不以 "F" 开头时（如「女」、2、0）都用男性切点 52.4，报告里却声称用了分性别的 Prado 切点 |
| C4 | `datasets/survival.ts:522-560` | Cox 回归处理并列时间时，风险集漏掉了排在后面的同时间受试者。结果依赖行的顺序，与 R/SAS 的 Breslow 方法不一致 |
| C5 | `datasets/survival.ts:453` | 三组以上用 Σ(O−E)²/E 的近似公式（偏保守），报告时仍称为 log-rank 检验 |
| C6 | `datasets/survival.ts:681` | `p_value_overall` 实际上是各协变量里最小的 Wald P，代码注释却说它是似然比检验的 P |
| C7 | `datasets/survival.ts:1053` | 不管时间单位是什么，都把 12 标成「1-Year Rate」；单位是天时，会把 12 天生存率显示成 1 年生存率 |
| C8 | `research/prediction-models.ts:415` | AUC 及其置信区间被钳在 0.5 以上，比随机还差的模型被掩盖 |
| C9 | `imaging-worker/recist.py:424-516` | Lung-RADS 与 v2022 不符：实性结节按最长径而不是平均径分级；部分实性结节的实性成分切点用 5 mm（应为 6 mm）；总径小于 6 mm 的部分实性结节（应为 2 类）没有处理 |
| C10 | `imaging-worker/dicom_io.py:447`（另见 `:356`） | 层间距 `dz` 取自 `SliceThickness`，而不是相邻层 `ImagePositionPatient` 的差值。重叠重建或有间隙的序列，体积会差约一倍；缺少 `PixelSpacing` 时悄悄默认为 1.0 mm |
| C11 | `imaging-worker/recist.py:37-56` | 只在面积最大的那一层测最长径，而不是在最长径实际所在的层；对包含多个连通区域的掩膜按整体计算，「直径」会跨越不同结构 |
| C12 | `imaging-worker/recist.py:661`、`engine.py:1202-1242`、`task_queue.py:228-232` | 肺气肿肺掩膜取 -980 至 -400 HU，漏掉了最严重的肺气肿体素，又混进了气管和肠气。LAA% 存进了 `longest_diameter_mm`，升数存进 `short_axis_mm`，GOLD 分级存进 `lung_rads.category`，在队列 CSV 里没有任何标注；全身分析把 √SMA 存为长径、肝体积存为总体积 |
| C13 | `imaging-worker/engine.py:1395` | 「Agatston」评分是钙化体积（cm³）× 10 × 按平均 HU 取的权重，并非 Agatston 方法（逐层面积 × 峰值密度权重），数量级都不对 |
| C14 | `imaging-worker/engine.py:1034, 1047`、`server.py:766` | 分割掩膜缓存只按文件名区分：`p1/ct.nii.gz` 和 `p2/ct.nii.gz` 形状相同时共用一份掩膜，**第二个患者会看到第一个患者的病灶**。`/volume/upload` 遇到已有的 `volume_id` 会忽略新文件；`volume_cache` 和 `mask_cache` 从不清理，大体积会一直累积直到内存耗尽 |

---

## P1-2　收件邮件内容乱码（🧪 已复现）

### 根因
收到的邮件正文要被解码三次，三处的逻辑基本相同：
1. Cloudflare Worker：`deploy/cloudflare/email-worker.js`
2. 服务端：入库前一次（`mail/service.ts:878`），每次读取时再一次（`service.ts:437`），存量邮件还有一次批量处理（`service.ts:312`）
3. 前端渲染：`web/src/mail.ts:753`

三处都不读取 `Content-Transfer-Encoding`，而是用「看起来像 Base64 / QP 就解码」的猜测，还会对已经解码过的文本再解一次。

### 复现结果

| # | 触发条件 | 输入 → 实际显示 |
|---|---|---|
| M1 | 中文正文里出现 `=` 后跟两个十六进制字符（链接 `?id=AB12`、会议链接 `pwd=3F…` 等） | `请登录 https://x.org/?id=AB12 查看` → `璇风櫥褰� https://x.org/?id�12 鏌ョ湅`，**整封信都乱** |
| M2 | 某一段只有字母、数字和空格，没有标点，且去掉空格后不少于 8 个字符（问候语、署名等） | `Hi Doctor Wang` → `"\u001e 鑢�+Y┼"`；`Received thanks` → `E�\u001e婘澏…` |
| M3 | 以 8bit 原始字节发送的 GBK 正文（国内很多客户端会这样发） | `您好` → `����`，无法恢复 |
| M4 | Big5、ISO-2022-JP、Latin-1 等其他字符集 | 一律按 UTF-8 解码，结果乱码 |
| M5 | 带附件或内嵌图片的多层嵌套 multipart 邮件 | worker 只匹配最外层 boundary，解析失败后把原始 MIME 结构整段发出，能否显示正常要看服务端第二轮能否恰好解开 |
| M6 | 只有 HTML 的邮件里有数字实体（`&#20013;`） | 实体原样显示；`&amp;lt;` 的解码顺序也不对 |

### 具体原因
- **M1**：`decodeQuotedPrintable`（worker 第 52 行，服务端和前端各有一份同样的实现）一看到 `=XX` 就开始解码。混进去的这个字节让整段文字不再是合法 UTF-8，于是退回按 GB18030 解码，整封信变成乱码。
- **M2**：`decodeBase64Chunk` 把这类段落当成 Base64 解码；解出来的随机字节按 GB18030 几乎总能凑成汉字，于是通过了「含中文就采用」的判断。
- **M3**：worker 用 `new Response(message.raw).text()` 读原始邮件，一律按 UTF-8 解码，原始字节在这一步就丢了。
- **M5**：boundary 拼进 `new RegExp` 时没有转义；含 `+`、`(` 等字符的 boundary 会导致匹配出错甚至抛异常。

### 乱码会写回数据库
`normalizeMail`（`service.ts:435`）在每次读取时重新解码，结果不同就写回存储；第 312 行对存量邮件也做同样的事。已被解坏的邮件原文已经不在库里了。

### 附带问题
- 转发到个人邮箱时，`mailer.ts:89` 只把 `\n` 换成 `<br>`，没有做 HTML 转义，正文里的 `<…>` 会消失。外部来信的 HTML 正文也会被原样转发，`fromName` 未转义就进入 From 显示名（`mailer.ts:52`）。
- worker 用的是信封发件人 `message.from`，不是信头里的 `From`，发件人常常显示成退信地址，也没有显示名。
- 主题解码时，跨多个编码词被切开的多字节字符会出错；非 GB、非 UTF-8 的字符集同样按 UTF-8 处理。

### 修复方案
1. **worker 改用真正的 MIME 解析器**（推荐 `postal-mime`，可在 Cloudflare Workers 运行）。直接解析 `message.raw` 的原始字节，按声明的传输编码和字符集解码，把 `text`、`html` 和信头 `From` 分开发给服务端。
2. **服务端原样存储**：删除 `receiveInbound`、`normalizeMail` 和第 312 行的启发式重复解码，不再写回数据库。只有 HTML 的邮件在服务端转成纯文本一次，并补上数字实体解码。
3. **前端只负责显示**：删除 `decodeEmailBody`、`parseMimeText` 等重复实现。
4. **回归测试**：邮件样本覆盖 M1–M6。
5. **已经损坏的邮件**：Cloudflare 没有保留原文。M1、M2 类或许能部分逆向恢复，M3 类已无法恢复。

---

## P1-3　引用守卫与写前守卫被绕过

> CLAUDE.md 要求：正式引用只能来自 `insert_citation`，AI 写文档只能经过操作层。改动引用流程时，必须同步更新 `ops/service.ts` 的引用守卫和对应测试。

| # | 位置 | 问题与后果 |
|---|---|---|
| G1 🧪 | `ops/deck.ts:193-206`（`deckOpTexts`）、`service.ts:88` | 校验时漏掉了 `add_slide.body2` 和 `add_image.credit`，这两个字段都会作为 markdown 写进幻灯片。复现：`body2:'见 doi:10.1056/NEJMoa1409077 [@c:zzzfake1]'` 被提交，幻灯片里出现了未登记的引用节点；`credit` 字段同样可以写进演讲者备注。PHR 红线守卫也看不到这两个字段 |
| G2 🧪 | `ops/service.ts:159-182`（`guardCitations`），另见 `:185-193` | 守卫扫描的是每个操作的原始 markdown，而不是最终的文档文本。用转义字符写 `10\.1056/NEJMoa1409077 与 PMID&#58; 25176015` 能通过；在同一批次里把 DOI 拆进两个 `replace_text` 操作也能通过，最终段落里出现完整的 DOI。PHR 红线守卫有同样的弱点 |
| G3 🧪 | `ops/service.ts:139-156`（`guardConflicts`）、`model/runtime.ts:32` | 冲突守卫只检查操作直接指向的节点。列表、列表项、幻灯片这类容器不会留下用户修改记录，所以容器内的用户修改对守卫不可见；插入位置的锚点和 move 的 `after` 锚点也不检查。复现：用户在 rev 1 修改了列表项里的段落，之后 AI 以 `base_rev:0` 执行 `delete{ids:[list]}` 被接受，用户的修改被冲掉。`delete_slide` 同理 |
| G4 🧪 | `ops/apply.ts:467-498`（`move`） | 不拒绝 `move.ids` 里的重复 id。`move{ids:[X,X]}` 执行成功，X 后面的相邻段落被悄悄删除，文档里出现两个 id 都是 X 的块 |
| G5 | `mcp/server.ts:808-818, 864-875, 926-940` | `dataset_table1`、`dataset_survival` 和 `dataset_imaging_survival` 直接调用 `deps.ops.edit`：没有 `ctx.check`（不检查 token 范围；已删除的文档对所有者照样可写；不拒绝 deck 类型的文档），写死 `mode:'apply'`（无视服务端强制的建议模式），`base_rev` 取当前 rev（冲突守卫失效），也没有 `turns.touch`。在只允许建议修改的轮次里，结果段落和表格会直接提交进稿件 |
| G6 | `mcp/server.ts:205` | `doc_create` 带 markdown 时总是以 apply 模式提交，与「建议轮次里 AI 的每次写入都必须成为修订」的约定不一致（影响限于新建的文档） |
| G7 | `mcp/server.ts:575`、`claims/service.ts:66` | `insert_citation` 不核对 AI 给出的 PMID 是否与已验证的 DOI 对应，而论断核查时优先按 PMID 取摘要。错误的 PMID 会让核查对照一篇不相干的摘要，可能把没有依据的论断标成「supported」 |
| G8 | `claims/extract.ts:86`、`claims/service.ts:121, 133` | `claim_id` 是对去掉引用后的文本做哈希。句子不变但换了引用时 id 不变，旧的核查结论会作为 `unchanged` 沿用到引用了另一篇文献的句子上；同一段里两句相同的话会在 `byId` 中冲突 |
| G9 | `ops/revert.ts:33` | 基于节点的撤销（服务重启后的回退路径）只恢复文本块、表格、图和 opaque 节点，不恢复幻灯片的 `shape`。重启后撤销一轮 AI 对幻灯片的修改实际无效，却调用了 `markTurnReverted`，并报告成功（`skipped: []`） |
| G10 | `ops/deck.ts:384-394` | 幻灯片的 `replace_text` 逐段匹配，前面段落的歧义或越界结果被记下但扫描继续，最终修改第一个唯一匹配的段落。目标在第 1 段出现两次、第 2 段出现一次时，第 2 段被悄悄修改；两段各出现一次时修改第 1 段，都不报歧义错误 |

---

## P1-4　权限、PHI 与账号安全

| # | 位置 | 问题与后果 |
|---|---|---|
| H1 | `auth/tenants.ts:237-240` | 个人空间的管理员发出邀请后，这个空间被转成机构，`personal_tenant_id` 被清空，**家属（知家）的病历数据库就变成了机构的患者库**：邀请人可以破窗访问，`patient_visibility='tenant'` 时所有成员可读。用户的知家变成一个新的空租户，原有 `space:'personal'` 的归档文档不再能找到 |
| H2 | `auth/accounts.ts:145-153`、`auth/tenants.ts:286` | 绑定了邮箱的邀请没有强制校验：`register()` 不比对 `inv.email`，账号没有邮箱时 `accept()` 也跳过校验。`createOrg` 发出的首位管理员邀请一旦泄露，任何人都能成为该医院的管理员 |
| H3 | `auth/accounts.ts:165-172` | 按用户名的登录锁定只改变错误提示：先比对密码，再检查限流，所以锁定期间输入正确密码仍能登录，暴力破解不会被拦住 |
| H4 | `auth/accounts.ts:285, 303-305` | 重置验证码的 5 次尝试上限按验证码计，每 60 秒可以重新申请一个（尝试次数随之清零）；`resetPassword` 本身没有限流和人机校验。轮换 IP 时每天约 7,200 次猜测，大约 20%/月 的概率接管账号 |
| H5 | `admin-tools.ts:217`、`datasets/service.ts:122-140` | `dataset_manage resolve_phi` 不需要用户确认，AI 可以自己把姓名、身份证号等列标为保留，数据集从 `review` 变为 `ready`，随后经 `dataset_open` 进入工作区并发给 DeepSeek |
| H6 | `datasets/service.ts:235, 267`，经 `mcp/server.ts:852, 913` | `survival()` 和 `imagingSurvival()` 直接调用 `own()`，没走 `readyCsv()`，跳过了对 `review`/`processing` 状态的拦截。疑似 PHI 列被当作 `group_col` 时，会出现在图例和生成的文字里 |
| H7 | `mcp/server.ts:1312`、`admin-tools.ts:240`、`memory/service.ts:129` | `memory_propose explicit=true` 由 AI 自行声称，记忆立即生效；`memory_manage edit` 改写已确认的记忆不需要确认，审计里记为 `actor:'user'`。生效的记忆会以「必须遵守」注入之后的每一轮，形成一条持久化的提示注入路径 |
| H8 | `tenancy/patients.ts:2475-2476` | `enrollments()` 对看不到的受试者只隐藏 `code`，`sex`、入组年龄、`tags`（诊断）和内部 `patient_id` 照常返回。只读成员或已被移出诊疗组的医生仍能拿到这些信息 |
| H9 | `tenancy/claims.ts:105-149` | `confirmClaim` 不检查医生能否访问 `claim.patient_id`，只写家属一侧的日志（注释说两侧都写）；认领相关路由不在 `api.ts` 的审计表里。任何机构成员都能把一份院内病历绑定到家属，院内不留痕迹。第 127 行的报错还会泄露认领人的出生年份 |
| H10 | `tenancy/claims.ts:162-179` | `revokeClaim` 只要求当前租户相同，没有患者访问检查，不拦截 `via==='ai'`，也不写审计，无关同事或 AI 都能解除已确认的家属关联 |
| H11 | `http/api.ts:820, 1326` | 只读成员被允许执行 `exempt-claim`（跳过文献核查）和解决评论；`addReply(cid)` 不检查评论是否属于当前文档，可以回复到无权访问的文档上 |
| H12 | `auth/accounts.ts:220`、`mail/service.ts:409, 944-962` | 工作邮箱前缀只与其他前缀比对，不与用户名比对；收件匹配会去掉 `dr.`、`dr-`、`dr_`，并取列表里第一个匹配的用户。用户 A 设置前缀 `bob`，就能以 `bob@heurion.org` 冒充同事 bob 发信，也可能收到发给 `dr.bob` 的邮件（其中可能有患者数据） |
| H13 | `routes/mail-calendar.ts:101-117`、`auth/mailer.ts:89` | 任何注册用户都能向任意外部收件人发送内容自定的邮件；`recipient` 不校验（可以是逗号分隔的列表），没有频率限制，正文以原始 HTML 发出。平台可被用作批量钓鱼邮件的发信渠道 |
| H14 | `collab/gateway.ts:36-50` | 角色、`deleted_at` 和可写权限只在 WebSocket 建立连接时检查一次。权限被撤销或文档被删除后，已连接的用户仍可继续写，修改照样作为用户提交保存 |
| H15 | `auth/accounts.ts:343-353`（经 `http/api.ts:700-710`） | 平台运营可以重置任何用户（包括医院成员）的密码，或把任何人设为管理员，然后以医生身份登录，获得完整的患者访问权限；审计只记在平台侧，不进医院的审计。这与「平台运营不读取任何租户业务数据」的设计相矛盾 |
| H16 | `auth/tenants.ts:178` | 医院管理员停用成员时（`setMember(status:'disabled')`），停用的是整个账号，对方的个人知家空间也被锁住，并且无法自行退出这家医院 |
| H17 | `tenancy/patients.ts:2451-2475` | 人工操作路径上的 `unenroll` 只检查 `ctx()`，不检查是否可见、是否在诊疗组；`cohort.ts` 只要求研究的写权限 |
| H18 | `tenancy/patients.ts:2333` | `propose()` 只要求 `visible()`，不像其他写操作那样要求 `requireTeam`。全租户可见的查看者或破窗访问的管理员（本应只读）可以提交修改提案，干扰诊疗组的待审队列 |
| H19 | `research/cohort.ts:145` | 调用方传入的 `patient_ids` 不与研究的有效入组记录比对。未入组或其他研究的患者照样被分析，并写进本研究的数据集，绕过了入组和知情同意的边界 |
| H20 | `mcp/imaging-tools.ts:95, 441, 640, 760, 790, 1180` | actor 是手写的：`space` 写死为 `'work'`，或者干脆没有 space，也没有 `turnId`。在知家个人空间的轮次里会查到工作租户的患者库，访问日志也无法追溯到对应轮次。应统一改用 `mcp/server.ts:974` 已有的 `aiActor()` |

---

## P1-5　部署与运维

| # | 位置 | 问题与后果 |
|---|---|---|
| D1 | `deploy/deploy.sh:59-62, 134` | 切换到 v2 之后，每次部署都会执行 `reclaim_disk_space`：`rm -rf /opt/heurion` 并删除 `heurion_*` 数据卷，绕过了 `cleanup-v1.sh` 要求的 `CONFIRM=DELETE-V1` 和健康检查，也不理会 `V1_DIR`，与第 134 行「1.0 仍保留」的提示相矛盾 |
| D2 | `Dockerfile:13`、`apps/imaging-worker/Dockerfile:31-46`、`deploy/deploy.sh:154`、`deploy/docker-compose.yml:81` | 依赖版本是浮动的：主镜像的 pip 包没有指定版本，worker 用 `>=` 范围（包括 `torch>=2.2.0`），在宿主机上以 root 执行 `curl https://rclone.org/install.sh \| bash`，基础镜像和 `caddy:2.8-alpine` 按 tag 而不是 digest 固定。npm 依赖受 `--frozen-lockfile` 约束；dsh 已按规定锁定精确版本（`0.2.0-rc.2`） |

---

## P2　稳定性、竞态与错误处理

| # | 位置 | 问题与后果 |
|---|---|---|
| S1 | `convert/docx-import.ts:80`、`convert/pptx-import.ts:91`（经 `http/api.ts:869, 882`、`kb/extract.ts:55, 58`） | `unzipSync` 解压时不限制总大小和条目数，几 MB 的 zip 炸弹就能让主进程内存耗尽，影响所有用户 |
| S2 | `routes/mail-calendar.ts:116`、`http/api.ts:479-483`、`routes/research.ts:220-226` | 没有设置 `bodyLimit`；邮件附件原样存储，会在内存、SQLite 和收件人的收件箱里各存一份。反复提交可以耗尽内存和磁盘 |
| S3 | `web/src/main.ts:513-573`（canvas `main.ts:156-165` 同理） | `open()` 在 await 之后不检查自己是否还是最新请求。快速点 A 再点 B，A 的 EventSource、Provider 和编辑器都不会被销毁，页面上挂着两个编辑器，用户可能在 A 里输入，而标题和操作对应的是 B |
| S4 | `web/src/main.ts:659-662` | `refresh()` 返回后不检查 `docId` 是否已经变了，旧文档的标题、评论和版本信息会覆盖新文档；`full=true` 时还会把旧文档的对话记录追加到新文档 |
| S5 | `canvas web/src/main.ts:203-216`、`web/src/deck.ts:563` | canvas 的幻灯片视图没有事件流，`onEdit` 之后也不重新加载；用户编辑不经过冲突守卫。AI 通过 MCP 改了某张幻灯片后，用户在旧页面上修改同一个形状，会悄悄覆盖 AI 的文字，`changedMeanwhile` 对比的也是同一份旧数据，不会提示 |
| S6 | `canvas-service/src/app.ts:325-336` | `/api/docs/:id/edit` 不像平台那样对 `EditBatch`/`DeckEditBatch` 做 `safeParse`，50 个操作的上限和各字段的枚举、结构约束都被绕过；缺少 `base_rev` 时默认用当前 rev |
| S7 | `canvas web/src/main.ts:234` | 图表编辑发送的是 `{chart: updated}`，而该操作要求 `categories`、`series`、`title` 放在顶层，所以每次编辑图表数据都失败，用户的修改被丢弃，也没有提示 |
| S8 | `canvas web/src/main.ts:255, 375`、`web/src/deck.ts:630` | canvas 服务端只认 `Authorization` 请求头，而前端在导出和幻灯片图片上用 `?token=`，编辑器图片干脆不带 token。开启鉴权后这些请求全部 401 |
| S9 | `canvas-service/src/app.ts:382-393, 514`、`mcp/server.ts:653-676` | `GET /api/assets/:id` 不检查资源归属；canvas MCP 的 `workspaceDir` 固定为所有用户共用的 `/tmp`，用户 A 的 AI 可以把用户 B 放在 `/tmp` 的图片上传为自己的资源。带脚本的 SVG 会以 `image/svg+xml` 从 canvas 的源返回 |
| S10 | `http/api.ts:1357` | `apply-claim-fix` 里的 `ops.edit` 没有捕获 `OpError`（`/edit` 在第 1143 行有），rev 过期或守卫拒绝时返回 500 而不是 409 |
| S11 | `routes/research.ts:66` | `cohortFailure` 不处理 `DatasetError`，超过 100 MB 的导出返回 500 而不是 400 或 413 |
| S12 | `routes/mail-calendar.ts:217-220` | 归档邮件到患者时先 `docs.create` 再 `linkDoc`，后者不在 try/catch 内。没有患者编辑权限时，403 变成 500，并留下一份含邮件正文和患者编号的孤立文档 |
| S13 | `routes/mail-calendar.ts:157` | 拆分路由时本应原样搬移，却把 `&amp;lt;${msg.sender}&amp;gt;` 改成了 `&lt;…&gt;`，markdown-it 会把它解析成自动链接或 HTML 标签，归档出来的文档内容因此改变 |
| S14 | `routes/imaging.ts:128` | `pt_` 卷 ID 按 `_` 切分，患者或文件 ID 本身含 `_` 时会查错记录；`PatientError`（403/404）被通用的 catch 吞掉，变成 503 `imaging_worker_offline`，掩盖了拒绝访问 |
| S15 | `routes/imaging.ts:142` | `id` 未经 `encodeURIComponent` 就拼进 worker URL 和 `Content-Disposition` 头 |
| S16 | `store/db.ts:2240`（经 `PATCH /api/calendar/events/:id`，`mail-calendar.ts:477`） | 更新接口接受 `tenant_id`、`mail_id`、`patient_id`，也不检查值的类型；可以把日程指向任意租户或患者，传入对象时 SQLite 绑定出错返回 500 |
| S17 | `mcp/server.ts:1495, 137`、`admin-tools.ts:336`、`server.ts:1313` | `isLiveSession` 只在请求到达时检查，轮次归属在 await 之后才去查。用户点停止后，正在执行的 30 秒 `imaging_analyze` 仍会写入病历；如果下一轮已经开始，操作卡片会挂到那一轮和那篇文档上 |
| S18 | `literature/crossref.ts:23`、`literature/pubmed.ts:36` | 请求没有超时，Crossref 卡住会让 `insert_citation` 一直挂起，直到 5 分钟空闲看门狗杀掉整个 dsh 进程 |
| S19 | `render/slides.ts:123` | LibreOffice 渲染 10 页以上时，pdftoppm 生成 `slide-01.png`，代码又补了一份 `slide-1.png`，缓存会把两份都读进来，每页出现两次 |
| S20 | `routes/imaging.ts:26`、`research/cohort.ts:169`、`mcp/imaging-tools.ts` | `ImagingRouteContext` 声明了 `docs`、`access`、`audit` 三个依赖却从不使用，让人误以为这里有审计和访问控制；`IMAGING_WORKER_URL` 的解析写了三份，应合并成一个函数 |

---

## 已检查且未发现问题

- 租户和鉴权：HMAC token 与人机校验的比较都是定时安全的；token 的版本和过期都有检查；患者相关 SQL 全部参数化；`remove()` 保留访问日志。
- 文档核心：嵌套 id 的 move/delete 会报错并整体回滚；`add_image` 检查资源归属；`putTurnBase` 的幂等写法正确。
- MCP：文档、幻灯片、评论类工具都有 `ctx.check`；`kb_read`/`kb_search` 的范围正确；导入的记忆以待确认状态进入；破坏性管理操作需要确认；LLM 代理检查会话代次。
- HTTP：Unsplash 请求固定在官方 API 主机；`/assets` 和 `/site` 使用 `basename`；CONSORT SVG 转义了研究标题；邮件附件下载使用 `attachment`。
- 前端：平台对话的 `lightMarkdown` 先转义；邮件正文渲染、幻灯片形状和图表 SVG、KM 和森林图 SVG 都有转义；没有发现 `postMessage` 处理或开放重定向。
- 存储和渲染：savepoint 事务、`commit()`、`render/diagram.ts` 的 SVG 校验、幻灯片渲染子进程（命令固定，输入经环境变量传递）均未发现问题。
- 依赖：dsh 相关包按规定锁定精确版本。

---

## 建议的修复顺序

1. **立即**
   - 修 A1、A2：沙箱启动器拒绝符号链接，`chown`/`chmod` 加 `-h`。
   - 修 A3：入站邮件换成独立密钥，未配置时拒绝请求，**并轮换主密钥**。
   - 修 A4：canvas-service 默认开启鉴权，去掉硬编码密钥。
   - 修 A15，如果本地镜像曾经外传，轮换 DeepSeek 密钥。
2. **本周**
   - P0-B 整类问题：去掉所有演示或合成数据的兜底，找不到真实数据就报错。
   - **排查历史产物**：已经生成的投稿包、eCRF 数据集、队列影像宽表、病历中的影像记录和诊断标签。
   - A5–A13：影像路径访问控制、几处 XSS、数据集导入、模型权重、备份、出网隔离。
3. **两周内**
   - 统计和临床计算（C1–C14）。**每条都要配回归测试**，最好对照 R 的 `survival` 包和 `scipy` 的结果。
   - 收件乱码（M1–M6），连同已损坏邮件的补救。
   - 守卫绕过（G1–G10）：按 CLAUDE.md 要求同步更新 `ops/service.ts` 的引用守卫和测试。
   - 权限、PHI 与账号安全（H1–H20），部署问题（D1–D2）。
4. **排期**：P2。

修改完成后，按 CLAUDE.md 要求运行 `pnpm test` 和 `pnpm --filter @heurion2/platform e2e`。
