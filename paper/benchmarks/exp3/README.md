# 实验 3：真实 LLM 多会话评测（程序性记忆）

用真实的 dsh + 模型跑多会话任务序列，比较不同程序性记忆配置下守卫拦截是否随会话减少。取代 `run_eval.ts` 里的模拟版（那一版的覆盖判定是循环的，只能算机制演示）。

## 文件

- `tasks.ts`：7 个任务 archetype 与 3 个合成主题（2 个训练、1 个留出）。诱发条件由脚本以人类身份布置，任务消息里不出现守卫码。
- `run.ts`：对一个运行中的平台实例跑一组会话，每个回合写一行 JSONL。
- `pilot.ts`：编排。每个实验组起一个独立平台实例（独立数据目录），并行跑，结束后调用 `analyze.ts`。
- `analyze.ts`：汇总回合记录与平台数据库里的执行信号、习得规则，写 `summary.json`。

## 平台开关（`apps/platform/src/config.ts`）

| 环境变量 | 取值 | 说明 |
|---|---|---|
| `PROCEDURAL_MODE` | `off` / `frozen` / `fifo` / `utility`（默认） | 不注入 / 只注入已有规则 / 按创建顺序 / 按效用排序 |
| `PROCEDURAL_BUDGET` | 默认 `1000` | 每轮注入的字符预算 |
| `HARNESS_EVOLVE` | `1`（默认）/ `0` | Layer 3 后台演进与 overlay 挂载 |
| `HARNESS_FRESH_SESSION` | `0`（默认）/ `1` | 每个回合新开 dsh 会话，排除会话内上下文带来的跨任务学习 |

`pilot.ts` 固定设置 `HARNESS_EVOLVE=0`、`HARNESS_FRESH_SESSION=1`、`MEMORY_AUTO_REVIEW=0`，回合请求带 `memory: false`、`suggest: false`。

## 运行

需要根目录 `.env` 配置 `DEEPSEEK_API_KEY`。不改 `heurion.cordis.yml`，不开 web 工具。

```bash
cd apps/platform
# 预跑：A 无记忆 vs D 完整，1 个用户，4 个会话（最后 1 个用留出主题），共 56 个回合
npx tsx ../../paper/benchmarks/exp3/pilot.ts --arms off,utility --sessions 4 --heldout 1 --seed 1
```

结果写到 `paper/results/exp3/<时间戳>/`，包括 `turns-<组>.jsonl`、`summary.json`、`meta.json`（commit、模型、参数）和各组服务日志。平台数据在 `paper/benchmarks/exp3/data/`，已被 git 忽略。

## 预跑要回答的问题

1. 每个 archetype 的目标守卫码是否真的被诱发（`summary.json` → `by_archetype.*.induced`）。诱发率低的布置需要先改。
2. 单个回合的耗时与工具调用数，据此估算正式实验的规模。token 用量目前没有采集，需要从模型账单估算，或之后在 `llm-proxy.ts` 补计数。
3. 学到的规则文本（`learned_rules`），供人工检查。

## 已知限制

- 冲突任务里人类编辑发生在回合中途，所以本轮开始时的「近期用户编辑」状态线索不会命中。这条规则只能靠证据数排序。
- `user_reverted_turn` 依赖 AI 改动请求范围以外的块，可能很少发生，需要预跑确认。
- 紧预算档（B=300 + 干扰规则）与 Layer 3 组（`HARNESS_EVOLVE=1`，需要会话之间触发 `evolve`）还没有实现。
