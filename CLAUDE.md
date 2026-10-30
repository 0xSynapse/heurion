# Heurion 2.0 — 协作约定

- 现行架构见 `docs/PLATFORM.md` 与 `docs/README.md`；核心代码在 `apps/platform`。
- 通用智能体能力（对话循环、工具执行、LLM 调用、子代理、压缩）一律交给 dsh，不在本仓库重复实现。
- 文档模型、结构化编辑操作与写前守卫是平台核心，由本仓库实现并经 MCP 暴露给 dsh。AI 对文档的写入只能经操作层（`apps/platform/src/ops/`）；不要增加「用文件整体替换文档」的入口。
- dsh 依赖锁定精确版本；升级单独提交，并跑 `pnpm test` 和 `pnpm --filter @heurion2/platform e2e`。
- `apps/platform/src/harness/profile/heurion.cordis.yml` 是数据外发的边界：不得重新启用 `session-log-deepseek` 或 web 工具。
- 正式引用只能来自 `insert_citation`；改动引用流程必须同步更新 `ops/service.ts` 的引用守卫和对应测试。
- 注释和文档用中文，代码标识符用英文。
