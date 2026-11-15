# 论文一：来源等级

AI 修改临床论文时，写入不能降低内容的来源等级，且只能写它看到过的东西。本目录是论文一的大纲、系统设计初稿、实验脚本、全部实验数据与结果。

| 路径 | 内容 |
|---|---|
| `OUTLINE.md` | 论文大纲：各章要点、讨论、局限 |
| `SYSTEM_DESIGN.md` | 「系统设计」一节初稿（只讲逻辑，不写代码位置） |
| `corpus/README.md` | 测试稿怎么生成、每份测试稿包含什么、评分口径 |
| `corpus/scripts/` | 生成、运行、评分、汇总、核验的全部脚本（见下） |
| `dataset/` | 测试稿、全文、各组运行结果、汇总与核验 |
| `results/final_table.md` | 结果总表（与 `dataset/results/final_table.md` 相同） |

## dataset/

| 路径 | 内容 |
|---|---|
| `corpus/<编号>/` | 30 份测试稿（Q01–Q12 钱医生团队论文，P01–P18 其他专科论文）：`manuscript.docx` 测试稿；`meta.json` 种入的导师修订与批注；`tasks.json` / `tasks_b.json` / `tasks_c.json` 第一组、第二组、对抗组任务；`sources/` S1 文献的摘要（`S1.txt`）与开放获取全文（`S1.full.txt`）；`reviews.txt` 公开审稿记录（只有 P 组） |
| `runs/<编号>/<组>/` | 每份测试稿在每组做法下的结果：`result.docx` 改完（Heurion 组为导出）的 Word；`score.json` 评分；`log.json` 每项任务的对话轮数、工具调用（入参与截断的输出）、用量与耗时 |
| `results/` | 各组汇总（`<组>.json`）、`summary_all.txt`、结果总表 `final_table.md`、引用核验 `doi_check.json` / `ref_check*.json` |
| `logs/` | 各组运行时的逐篇输出 |
| `sources/` | 选文清单（`qian.json`、`others.json`）与 30 篇论文的 JATS 全文 XML |

组名：`paste` 复制粘贴；`skill` docx 技能；`gongrzhe` GongRzhe MCP；`ronin` 罗宁 MCP；`heurion` Heurion；`heurion-doc` Heurion + 模拟医生。无后缀 = 第一组任务（T1–T6），`-b` = 第二组（S1–S4），`-c` = 对抗组（用户施压）。`skill-b`、`gongrzhe-b` 按决定中途停止（分别 11 篇、12 篇），只有日志，不进总表。

所有做法用同一个模型（deepseek-flash，温度 0，默认开深度思考）；各做法怎么模拟见 `corpus/scripts/run_agent.py`、`run_paste.py` 文件头。

## 没有入库的

- 每次运行留下的数据库与工作目录（共约 1 GB）：Heurion 组可用 `corpus/scripts/reexport.py` 从数据库重新导出 Word，需要时向作者索取。
- 两组早期版本的运行（`heurion-v1nousernum`、`heurion-b-v1precoauthor`，被修复后的结果取代）。
- 专家盲评的题目包与组别对照表：评审结束后再公开，以免影响盲评。
- 日志里的本机路径与用户名已替换为 `<bench>`、`~`、`user`。

## 复现

脚本假定实验目录结构为 `<ROOT>/scripts`、`<ROOT>/out/<编号>`、`<ROOT>/env`：把 `corpus/scripts/` 复制为 `<ROOT>/scripts`，`dataset/corpus/` 复制为 `<ROOT>/out`，`dataset/runs/<编号>/<组>` 放到 `<ROOT>/out/<编号>/runs/<组>`。

- 评分：`python3 scripts/score.py out/<编号> <改后的 docx> [tasks_b.json]`；全部重评 `scripts/rescore.py`；汇总 `scripts/summarize.py <组…>`；总表 `scripts/final_table.py`
- 引用核验：`scripts/verify_dois.py`、`scripts/verify_refs.py`（Crossref）；S1 全文：`scripts/fetch_fulltext.py`（Europe PMC）
- 重新运行：`DEEPSEEK_API_KEY=… python3 scripts/run_agent.py <skill|gongrzhe|ronin|heurion> [--taskset a|b|c] [--doctor]`、`scripts/run_paste.py`（环境变量见各文件头）

## 许可

测试稿由 CC BY 论文改编：正文来自原文，导师修订、批注、修改任务与部分改动过的数字是构造内容（测试稿内有说明），不代表原研究结果。改编后的测试稿与实验数据按 CC BY 4.0 发布，使用时请注明原论文（`dataset/sources/qian.json`、`others.json` 有 DOI）；脚本按仓库的 MIT 许可。钱医生已同意用其团队论文生成测试稿并公开。
