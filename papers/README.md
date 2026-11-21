# 论文

| 目录 | 论文 | 状态 |
|---|---|---|
| [`paper1-provenance/`](paper1-provenance/) | 论文一：来源等级——AI 写入不能降低来源等级、只能写它看到过的东西 | 第一轮实验完成；正文未起草 |
| [`paper2-deep-review/`](paper2-deep-review/) | 论文二：临床深度审稿与批注驱动的自演进；以及 Heurion 2.0 整合版预印本 | 稿件与实验已完成 |

## 论文一（`paper1-provenance/`）

- `OUTLINE.md`：大纲（各章要点、讨论、局限）
- `SYSTEM_DESIGN.md`：「系统设计」一节初稿
- `corpus/`：测试稿生成、实验运行、评分、汇总的全部脚本
- `dataset/`：测试稿、全文、各组运行结果、汇总与核验（说明见 `paper1-provenance/README.md`）
- `results/final_table.md`：结果总表

产品侧的设计文档：`docs/design/PROVENANCE.md`、`docs/design/PROTECTION_RESOLUTION.md`、`docs/design/WORD_ROUNDTRIP.md`。

## 论文二（`paper2-deep-review/`）

- `main.tex` / `main.pdf`：Self-Evolving Clinical Deep Review（arXiv 提交稿；`arxiv_dist/`、`ARXIV_SUBMISSION.txt`、打包文件与 `scripts/prepare_arxiv_tar.ts`）
- `heurion2_integrated_main.tex` / `.pdf`：Heurion 2.0 整合版预印本（官网「研究发表」链接的就是它）
- `benchmarks/`：深度审稿实验（注入错误、消融与 k 折、前沿模型与交叉评审、安全）、7 篇代表作审稿、`v2/` 跨领域记忆与零模板实验（`apps/platform/tests/skill-training.test.ts` 引用）
- `results/`：上述实验的结果
- `plans/`：论文重构与两阶段泛化实验方案、给临床合作团队的协作手册
- `README_ZH.md`：导读与复现指南

2026-11-15 整理：原 `paper/` 与 `paper-deep-review/` 合并为本目录；原 `paper/main.tex`「Beyond File Scripting: … OOXML Engine」（ADI 论文）及其评测脚本已删除，需要时从 git 历史取回。
