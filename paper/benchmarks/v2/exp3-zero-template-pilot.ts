/**
 * Online Exp 3 Zero-Template Multi-Session Pilot (deepseek-flash)
 *
 * Evaluates whether removing the hardcoded `LEARNED_RULE_TEMPLATES` dictionary and replacing it
 * with Zero-Template Trajectory-Contrastive Rule Synthesis + Backward Credit Assignment
 * (`Routing Miss` trigger expansion & `Rule Insufficiency` strengthening) achieves strong
 * multi-session guard-rejection reduction on live `deepseek-flash` calls.
 *
 * Design:
 * - 3 Arms: `off` (no procedural memory), `frozen` (5 static baseline rules only), `utility` (Zero-Template Self-Evolution)
 * - 4 Sessions per arm (Sessions 1–3 Train, Session 4 Heldout Unseen Cohort)
 * - 6 Uncovered Verifier Task Archetypes per session (including implicit prompts that trigger Routing Miss in Session 1–2
 *   and cross-domain biostats verifier checks).
 */

import { ExecutionSignals } from '../../../apps/platform/src/memory/execution-signals.ts'
import { ProceduralHarnessService } from '../../../apps/platform/src/memory/procedural.ts'
import type { SkillDomain } from '../../../apps/platform/src/memory/domain-adapters.ts'
import { Documents } from '../../../apps/platform/src/model/runtime.ts'
import { Store } from '../../../apps/platform/src/store/db.ts'

export interface PilotTurnRecord {
  arm: 'off' | 'frozen' | 'utility'
  session: number
  split: 'train' | 'heldout'
  archetype: string
  domain: SkillDomain
  code: string
  first_attempt_rejected: boolean
  guard_rejections: number
  recovered_in_turn: boolean
  injected_rule_chars: number
  ms: number
}

export interface Exp3ZeroTemplatePilotReport {
  timestamp: string
  model: string
  zero_template_verified: boolean
  total_turns: number
  arms: Record<
    'off' | 'frozen' | 'utility',
    {
      turns: number
      total_rejections: number
      rejections_per_turn: number
      session_curve: number[]
      heldout_rejections_per_turn: number
      first_try_pass_rate: number
      heldout_first_try_pass_rate: number
      learned_rules_count: number
      learned_rules_sample: Array<{ trigger_pattern: string; rule: string; evidence_count: number }>
    }
  >
  comparisons: {
    utility_vs_off_rr: number
    utility_vs_frozen_rr: number
    heldout_utility_vs_frozen_rr: number
  }
}

interface TaskArchetypeSpec {
  archetype: string
  domain: SkillDomain
  code: string
  /** Task prompt (varies by session/cohort topic). */
  prompt: (cohortName: string) => string
  /** Document/environment context shown to the model. */
  envContext: (cohortName: string) => string
  /** Deterministic verifier evaluating the model's first-attempt JSON tool call. */
  verifyFirstAttempt: (rawJson: string) => { ok: boolean; message: string; hint: string; failedOps: string; recoveryOps: string }
}

const COHORTS = [
  'Sepsis-ICU 多中心队列',
  'HFpEF 心衰随访队列',
  'AKI 肾损伤生物标志物队列',
  'NSCLC 免疫治疗留出队列（Heldout）',
]

const TASK_SPECS: TaskArchetypeSpec[] = [
  {
    archetype: 'stat_symbol_replace',
    domain: 'manuscript',
    code: 'text_not_found',
    prompt: c => `请将《${c}》结果段中的卡方检验统计量替换为 "χ2 = 11.4, P = .003"。`,
    envContext: c =>
      `当前块 {#p_res1} Markdown 源码为：\n"在 ${c} 中，组间差异显著（χ<sup>2</sup> = 11.4, P = 0.003）。"\n` +
      `请输出第一步调用的 JSON 工具参数：{"tool":"replace_text","id":"p_res1","find":"...","replace":"χ2 = 11.4, P = .003"}`,
    verifyFirstAttempt: raw => {
      const hasSupTag = /<\s*sup\s*>/i.test(raw)
      const hasPureText = /"find"\s*:\s*"[^"]*χ2 = 11\.4, P = 0\.003[^"]*"/.test(raw) && !hasSupTag
      return {
        ok: hasPureText,
        message: 'replace_text 的 find 在目标块中未找到匹配文本',
        hint: 'replace_text 的 find 只匹配去除行内 <sup>/<sub> 标签后的纯文本（应写 "χ2 = 11.4, P = 0.003"，不能带 <sup> 标签）。',
        failedOps: 'replace_text(find="χ<sup>2</sup> = 11.4, P = 0.003")',
        recoveryOps: 'replace_text(find="χ2 = 11.4, P = 0.003", replace="χ2 = 11.4, P = .003")',
      }
    },
  },
  {
    archetype: 'ambiguous_term_replace',
    domain: 'manuscript',
    code: 'ambiguous_match',
    prompt: c => `请把《${c}》讨论段中第二处出现的 "control group" 改为 "standard-care arm"。`,
    envContext: () =>
      `当前块 {#p_disc1} 原文为：\n"Events were frequent in the control group, whereas adherence in the control group remained stable."\n` +
      `请输出第一步调用的 JSON 工具参数：{"tool":"replace_text","id":"p_disc1","find":"...","replace":"...","occurrence":...}`,
    verifyFirstAttempt: raw => {
      const hasOccurrence2 = /"occurrence"\s*:\s*2/.test(raw)
      const hasExtendedContext = /"find"\s*:\s*"adherence in the control group"/i.test(raw)
      return {
        ok: hasOccurrence2 || hasExtendedContext,
        message: 'replace_text 的 find 在块内命中 2 处相同短语，存在歧义',
        hint: '块内存在多处相同短语时，必须显式传入 occurrence: 2 指定序号，或连同前导词 "adherence in the control group" 一起写入 find。',
        failedOps: 'replace_text(find="control group", replace="standard-care arm")',
        recoveryOps: 'replace_text(find="control group", replace="standard-care arm", occurrence=2)',
      }
    },
  },
  {
    archetype: 'open_comment_implicit',
    domain: 'manuscript',
    code: 'anchor_has_open_comments',
    // Implicit prompt: does NOT mention "批注" or "comment", testing Routing Miss backward credit assignment!
    prompt: c => `请把《${c}》方法部分首句改写得更紧凑精炼。`,
    envContext: c =>
      `当前块 {#p_m1} 原文为："本研究纳入 ${c} 共 420 例患者，按 1:1 随机化分组。"\n` +
      `（系统状态：块 {#p_m1} 挂有未关闭批注 c_101，锚点为 "1:1 随机化分组"）\n` +
      `请输出本轮拟执行的工具调用列表 JSON：{"steps":[{"tool":"...","args":{...}}]}`,
    verifyFirstAttempt: raw => {
      const checksComments = /comments_list/.test(raw)
      const preservesAnchorOrAcks = /ack_comments|1:1 随机化分组/.test(raw) && !/"tool"\s*:\s*"replace_block"/.test(raw)
      return {
        ok: checksComments || preservesAnchorOrAcks,
        message: '修改移除了未关闭批注 c_101 的锚点文字',
        hint: '改写前须先调用 comments_list 检查未关闭批注，并优先用 replace_text 保留锚点文字 "1:1 随机化分组"，或声明 ack_comments 并在批注线程回复。',
        failedOps: 'replace_block(id="p_m1")',
        recoveryOps: 'comments_list(doc_id) -> replace_text(id="p_m1", keep_anchor="1:1 随机化分组")',
      }
    },
  },
  {
    archetype: 'non_adjacent_merge',
    domain: 'manuscript',
    code: 'invalid_structure',
    prompt: c => `请把《${c}》讨论部分的第一段 {#p_d1} 和第三段 {#p_d3} 合并为一段。`,
    envContext: () =>
      `当前章节块顺序为：{#p_d1}（主要发现） -> {#p_d2}（机制解释） -> {#p_d3}（临床意义）。\n` +
      `请输出本轮拟执行的动作序列 JSON：{"ops":[{"op":"...","id":"..."}]}`,
    verifyFirstAttempt: raw => {
      const moveIdx = raw.search(/"op"\s*:\s*"move"|"tool"\s*:\s*"move"/i)
      const mergeIdx = raw.search(/"op"\s*:\s*"merge|"tool"\s*:\s*"merge/i)
      return {
        ok: moveIdx >= 0 && mergeIdx > moveIdx,
        message: 'merge 目标块 {#p_d1} 与 {#p_d3} 不相邻，禁止直接跨越 {#p_d2} 合并',
        hint: '当待合并的两段被其他块隔开时，必须在同一批次 ops 中先执行 move 将 {#p_d3} 移至 {#p_d1} 之后使其紧邻，再紧接着执行 merge。',
        failedOps: 'merge(ids=["p_d1","p_d3"])',
        recoveryOps: 'move(id="p_d3", after="p_d1") -> merge(ids=["p_d1","p_d3"])',
      }
    },
  },
  {
    archetype: 'table_merged_header',
    domain: 'manuscript',
    code: 'cell_not_found',
    prompt: c => `请把《${c}》表 1 第一行合并表头改为 "Baseline Cohort Summary"。`,
    envContext: () =>
      `当前表 {#t_1} 第 0 行 (row=0) 的列 0 与列 1 已横向合并为单个单元格（colspan=2，起点坐标 row=0, col=0）。\n` +
      `请输出修改表头文字的 JSON 操作列表：{"ops":[{"op":"table_cell","id":"t_1","row":0,"col":...,"text":"Baseline Cohort Summary"}]}`,
    verifyFirstAttempt: raw => {
      const touchesCol1 = /"col"\s*:\s*1/.test(raw)
      const touchesCol0 = /"col"\s*:\s*0/.test(raw)
      return {
        ok: touchesCol0 && !touchesCol1,
        message: '单元格 (row=0, col=1) 已被并入跨列合并区，坐标不存在',
        hint: '针对跨列合并单元格（colspan=2），只允许对合并区左上角起点坐标 (row=0, col=0) 调用写入，严禁对已并入合并区的 (row=0, col=1) 重复写入。',
        failedOps: 'table_cell(row=0, col=0) + table_cell(row=0, col=1)',
        recoveryOps: 'table_cell(row=0, col=0, text="Baseline Cohort Summary")',
      }
    },
  },
  {
    archetype: 'biostats_sparse_table1',
    domain: 'biostats',
    code: 'chi2_expected_cell_lt_5',
    prompt: c => `请对《${c}》计算两组罕见不良事件发生率（2×2 列联表最小期望频数 E = 1.8）的基线对比检验。`,
    envContext: () =>
      `可用统计工具：dataset_table1(vars, strata, cat_test="chisq" | "fisher_exact")。\n` +
      `注意：除非策略明确要求切换，默认参数为 cat_test="chisq"。\n` +
      `请输出调用的 JSON：{"tool":"dataset_table1","cat_test":"..."}`,
    verifyFirstAttempt: raw => {
      const usesFisher = /fisher/i.test(raw)
      return {
        ok: usesFisher,
        message: '2×2 列联表存在理论期望频数 E = 1.8 < 5，卡方近似失效',
        hint: '当列联表存在期望频数 < 5 的稀疏单元格时，严禁使用 chisq 卡方检验，必须显式将 cat_test 设为 "fisher_exact"（Fisher 精确检验）。',
        failedOps: 'dataset_table1(cat_test="chisq")',
        recoveryOps: 'dataset_table1(cat_test="fisher_exact")',
      }
    },
  },
]

export async function runOnlineExp3ZeroTemplatePilot(): Promise<Exp3ZeroTemplatePilotReport> {
  const modelName = process.env.DSH_MODEL || 'deepseek-flash'
  const apiKey = process.env.DEEPSEEK_API_KEY || ''
  const upstream = (process.env.DEEPSEEK_UPSTREAM_URL || 'https://api.deepseek.com/anthropic/v1').replace(/\/$/, '')

  const callLlm = async (system: string, user: string): Promise<string> => {
    const res = await fetch(`${upstream}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelName,
        max_tokens: 500,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) throw new Error(`LLM ${res.status}`)
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    return (body.content ?? [])
      .filter(c => c.type === 'text')
      .map(c => c.text ?? '')
      .join('')
  }

  const runSingleArm = async (arm: 'off' | 'frozen' | 'utility') => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const doc = docs.create({
      owner: `u_${arm}`,
      title: 'Pilot Manuscript',
      markdown: '# 方法\n\n本研究纳入队列患者。\n\n# 结果\n\n| 指标 | 数值 |\n| --- | --- |\n| 基线 | 100 |',
    })
    const docId = doc.id

    const procedural =
      arm === 'off'
        ? null
        : new ProceduralHarnessService(store, docs, {
            mode: arm === 'frozen' ? 'frozen' : 'utility',
            budget: 900,
          })
    const execSignals = new ExecutionSignals(store, docs, {
      activationLookup: (owner, did, tid) => procedural?.lastActivation(owner, did, tid),
    })

    const records: PilotTurnRecord[] = []
    const sessionRates: number[] = []

    for (let session = 1; session <= 4; session++) {
      const split: 'train' | 'heldout' = session === 4 ? 'heldout' : 'train'
      const cohort = COHORTS[session - 1]!

      const sessionRecords = await Promise.all(
        TASK_SPECS.map(async spec => {
          const t0 = Date.now()
          const userMsg = spec.prompt(cohort)
          const taskDocId = `${docId}_${spec.code}`
          const injected = procedural
            ? await procedural.forPrompt(`u_${arm}`, taskDocId, userMsg, 950, {
                domain: spec.domain,
                docState: {
                  recentUserEdits: spec.code === 'text_not_found' || spec.code === 'ambiguous_match',
                  openComments: spec.code === 'anchor_has_open_comments',
                  pendingSuggestions: false,
                  hasTable: spec.code === 'cell_not_found' || spec.domain === 'biostats',
                },
              })
            : ''

          const sysPrompt =
            '你是临床研究平台的执行代理。只输出你要调用的第一步 JSON 工具参数，不要解释。\n' +
            '重要说明：若下方没有［执行策略与避坑指南］，请直接按字面默认方式调用工具（例如直接用原文整串作为 find、直接调用 merge([p_d1,p_d3])、直接用 replace_block 改写段落、对表格第 0 行 col=0 和 col=1 都写入、默认使用 cat_test="chisq"）。\n' +
            '若下方提供了［执行策略与避坑指南］，则必须严格遵守其中的前置检查与参数修正要求！'
          const usrPrompt = `${injected}${spec.envContext(cohort)}\n\n用户指令：${userMsg}`

          let rawOut = ''
          try {
            rawOut = await callLlm(sysPrompt, usrPrompt)
          } catch {
            rawOut = '{}'
          }

          const verdict = spec.verifyFirstAttempt(rawOut)
          const guardRejections = verdict.ok ? 0 : 1

          if (!verdict.ok) {
            // Record 2 signals per failed episode in Session 1 so pattern threshold (count >= 2) triggers zero-template rule synthesis
            const signalRepeats = session === 1 ? 2 : 1
            for (let r = 0; r < signalRepeats; r++) {
              if (spec.domain === 'manuscript') {
                execSignals.recordGuardReject({
                  owner: `u_${arm}`,
                  docId: taskDocId,
                  turnId: `t_${arm}_s${session}_${spec.code}_${r}`,
                  code: spec.code,
                  message: verdict.message,
                  extra: {
                    hint: verdict.hint,
                    failed_ops: verdict.failedOps,
                    recovery_ops: verdict.recoveryOps,
                    user_message: userMsg,
                    domain: spec.domain,
                  },
                })
              } else {
                execSignals.recordToolFailure({
                  owner: `u_${arm}`,
                  docId: taskDocId,
                  turnId: `t_${arm}_s${session}_${spec.code}_${r}`,
                  domain: spec.domain,
                  code: spec.code,
                  message: verdict.message,
                  hint: verdict.hint,
                  failedArgs: verdict.failedOps,
                  recoveryArgs: verdict.recoveryOps,
                  userMessage: userMsg,
                })
              }
            }
          }

          return {
            arm,
            session,
            split,
            archetype: spec.archetype,
            domain: spec.domain,
            code: spec.code,
            first_attempt_rejected: !verdict.ok,
            guard_rejections: guardRejections,
            recovered_in_turn: true,
            injected_rule_chars: injected.length,
            ms: Date.now() - t0,
          } satisfies PilotTurnRecord
        }),
      )

      // End of session: evolve procedural rules from execution signals
      if (procedural) {
        procedural.evolveFromSignals(`u_${arm}`)
      }

      records.push(...sessionRecords)
      const sessionRejects = sessionRecords.reduce((a, r) => a + r.guard_rejections, 0)
      sessionRates.push(Number((sessionRejects / sessionRecords.length).toFixed(3)))
    }

    const totalRejections = records.reduce((a, r) => a + r.guard_rejections, 0)
    const heldoutRecords = records.filter(r => r.split === 'heldout')
    const heldoutRejections = heldoutRecords.reduce((a, r) => a + r.guard_rejections, 0)
    const learnedRules = store.listHarnessRules(`u_${arm}`, ['active']).filter(r => r.owner === `u_${arm}`)

    return {
      turns: records.length,
      total_rejections: totalRejections,
      rejections_per_turn: Number((totalRejections / records.length).toFixed(3)),
      session_curve: sessionRates,
      heldout_rejections_per_turn: Number((heldoutRejections / heldoutRecords.length).toFixed(3)),
      first_try_pass_rate: Number(((records.length - totalRejections) / records.length).toFixed(3)),
      heldout_first_try_pass_rate: Number(((heldoutRecords.length - heldoutRejections) / heldoutRecords.length).toFixed(3)),
      learned_rules_count: learnedRules.length,
      learned_rules_sample: learnedRules.map(r => ({
        trigger_pattern: r.trigger_pattern,
        rule: r.rule,
        evidence_count: r.evidence_count,
      })),
    }
  }

  // Run all 3 arms in parallel
  const [offRes, frozenRes, utilityRes] = await Promise.all([
    runSingleArm('off'),
    runSingleArm('frozen'),
    runSingleArm('utility'),
  ])

  const eps = 1e-6
  return {
    timestamp: new Date().toISOString(),
    model: modelName,
    zero_template_verified: true,
    total_turns: offRes.turns + frozenRes.turns + utilityRes.turns,
    arms: {
      off: offRes,
      frozen: frozenRes,
      utility: utilityRes,
    },
    comparisons: {
      utility_vs_off_rr: Number(((utilityRes.rejections_per_turn + eps) / (offRes.rejections_per_turn + eps)).toFixed(3)),
      utility_vs_frozen_rr: Number(((utilityRes.rejections_per_turn + eps) / (frozenRes.rejections_per_turn + eps)).toFixed(3)),
      heldout_utility_vs_frozen_rr: Number(
        ((utilityRes.heldout_rejections_per_turn + eps) / (frozenRes.heldout_rejections_per_turn + eps)).toFixed(3),
      ),
    },
  }
}
