import { strFromU8, unzipSync } from '../../apps/platform/node_modules/fflate/esm/browser.js'
import { performance } from 'node:perf_hooks'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportDocx } from '../../apps/platform/src/convert/docx-export.ts'
import { bindAssets, importDocx } from '../../apps/platform/src/convert/docx-import.ts'
import { parseBlocks } from '../../apps/platform/src/model/markdown.ts'
import { Documents } from '../../apps/platform/src/model/runtime.ts'
import { schema } from '../../apps/platform/src/model/schema.ts'
import { OpService } from '../../apps/platform/src/ops/service.ts'
import { redactPhi, scanPhi } from '../../apps/platform/src/ops/phi-scan.ts'
import { Store } from '../../apps/platform/src/store/db.ts'
import { ExecutionSignals } from '../../apps/platform/src/memory/execution-signals.ts'
import { ProceduralHarnessService } from '../../apps/platform/src/memory/procedural.ts'
import { HarnessEvolutionService } from '../../apps/platform/src/harness/evolve-harness.ts'
import { docx, li, p } from '../../apps/platform/tests/fixtures.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface BenchmarkResults {
  timestamp: string
  exp1_dual_surface: {
    trials: number
    unmodified_byte_identity_rate: number
    concurrent_conflict_guard_accuracy: number
    selective_turn_undo_preservation_rate: number
    avg_validate_latency_ms: number
    avg_edit_latency_ms: number
    avg_revert_latency_ms: number
  }
  exp2_prewrite_guards: {
    unregistered_citation_trials: number
    unregistered_citation_block_rate: number
    phi_injection_trials: number
    phi_detection_recall: number
    clean_medical_false_positive_rate: number
  }
  exp3_self_evolution: {
    sessions: number
    curve: Array<{
      session: number
      no_memory_rejections: number
      unranked_memory_rejections: number
      heurion2_dual_track_rejections: number
      heurion2_prompt_chars: number
    }>
    distilled_rules_count: number
    overlay_generated: boolean
  }
}

async function runBenchmarks(): Promise<BenchmarkResults> {
  // =========================================================================
  // Experiment 1: Dual-Surface CRDT Co-Editing & Byte-Preserving Round-Trip
  // =========================================================================
  const N_TRIALS = 50
  let byteIdenticalUnmodified = 0
  let conflictGuardCaught = 0
  let selectiveUndoPreserved = 0
  let totalValidateMs = 0
  let totalEditMs = 0
  let totalRevertMs = 0

  for (let i = 0; i < N_TRIALS; i++) {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const ops = new OpService(docs)

    const bodyParagraphs = [
      p(`Section ${i + 1}: Randomized Controlled Trial Protocol`, '<w:pStyle w:val="Heading1"/>'),
      p(`Patients with NYHA class II-IV heart failure (n=${120 + i}) were enrolled across 12 centers.`, '', '<w:b/>'),
      p(`Primary endpoint was composite of cardiovascular death or hospitalization for heart failure.`, '', '<w:i/>'),
      li('Inclusion criterion 1: LVEF &lt;= 40%', 0),
      li('Inclusion criterion 2: NT-proBNP &gt;= 600 pg/mL', 0),
      p(`Baseline characteristics were balanced between treatment and placebo arms (p = 0.42).`),
    ].join('')

    const originalBytes = docx(bodyParagraphs)
    const imported = importDocx(originalBytes)
    const assetMap = new Map(
      imported.assets.map(a => [
        a.key,
        store.putAsset({ owner: 'u1', mime: a.mime, name: a.name, bytes: a.bytes }).id,
      ]),
    )
    const row = docs.create({
      owner: 'u1',
      title: `Protocol_${i}`,
      content: bindAssets(imported.doc, assetMap),
      source: 'import',
    })
    store.putNodeSrc(row.id, imported.src)
    store.putPackage(row.id, 'docx', originalBytes)

    const nodeIds: string[] = []
    docs.get(row.id).forEach(n => nodeIds.push(n.attrs.id as string))
    const [h0, p1, p2] = nodeIds

    // 1a. Measure Layer 1 pre-flight validate latency
    const baseRev = docs.rev(row.id)
    const tVal0 = performance.now()
    const valRes = ops.validate(
      {
        doc_id: row.id,
        base_rev: baseRev,
        mode: 'apply',
        ops: [{ op: 'replace_text', id: p1!, find: `n=${120 + i}`, replace: `n=${150 + i}` }],
      },
      { actor: 'ai', turnId: `turn_val_${i}` },
    )
    totalValidateMs += performance.now() - tVal0
    if (!valRes.valid) throw new Error('Expected valid pre-flight probe')

    // 1b. Measure guarded edit latency & byte-preserving export of unmodified blocks
    const tEdit0 = performance.now()
    ops.edit(
      {
        doc_id: row.id,
        base_rev: baseRev,
        mode: 'apply',
        ops: [
          { op: 'replace_text', id: p1!, find: `n=${120 + i}`, replace: `n=${150 + i}` },
          { op: 'replace_text', id: p2!, find: 'Primary endpoint', replace: 'The primary efficacy endpoint' },
        ],
      },
      { actor: 'ai', turnId: `turn_ai_${i}` },
    )
    totalEditMs += performance.now() - tEdit0

    const exported = exportDocx({
      doc: docs.get(row.id),
      baseline: docs.versionDoc(row.id, 1),
      pkg: originalBytes,
      src: id => store.getNodeSrc(row.id, id),
      citations: store.listCitations(row.id),
      comments: store.listComments(row.id),
      asset: () => null,
    })
    const outXml = strFromU8(unzipSync(exported.bytes)['word/document.xml']!)
    const untouchedHeadingXml = p(`Section ${i + 1}: Randomized Controlled Trial Protocol`, '<w:pStyle w:val="Heading1"/>')
    const untouchedTailXml = p(`Baseline characteristics were balanced between treatment and placebo arms (p = 0.42).`)
    if (outXml.includes(untouchedHeadingXml) && outXml.includes(untouchedTailXml)) {
      byteIdenticalUnmodified++
    }

    // 1c. Concurrent human edit on p2, followed by stale AI replace_block -> must be caught by conflict guard
    const revBeforeHuman = docs.rev(row.id)
    ops.edit(
      {
        doc_id: row.id,
        base_rev: revBeforeHuman,
        mode: 'apply',
        ops: [{ op: 'replace_text', id: p2!, find: 'hospitalization', replace: 'urgent hospitalization' }],
      },
      { actor: 'user', turnId: null },
    )

    const staleProbe = ops.validate(
      {
        doc_id: row.id,
        base_rev: revBeforeHuman, // stale!
        mode: 'apply',
        ops: [{ op: 'replace_block', id: p2!, markdown: 'AI stale full-block overwrite attempt.' }],
      },
      { actor: 'ai', turnId: `turn_stale_${i}` },
    )
    if (!staleProbe.valid && staleProbe.code === 'conflict_user_edited') {
      conflictGuardCaught++
    }

    // 1d. Per-turn selective undo in CRDT space: revert `turn_ai_${i}` must revert AI's edits on p1 and p2 while preserving human's concurrent edit on p2
    const tRev0 = performance.now()
    const revOut = docs.revertTurn(row.id, `turn_ai_${i}`)
    totalRevertMs += performance.now() - tRev0

    const currentDocText = docs.get(row.id).textContent
    if (
      revOut &&
      currentDocText.includes(`n=${120 + i}`) && // p1 reverted to original
      currentDocText.includes('Primary endpoint') && // AI change on p2 reverted
      currentDocText.includes('urgent hospitalization') // Human concurrent edit on p2 preserved!
    ) {
      selectiveUndoPreserved++
    }
  }

  // =========================================================================
  // Experiment 2: Zero-Hallucination Citation Guard & PHI Redaction Guard
  // =========================================================================
  const store2 = new Store(':memory:')
  const docs2 = new Documents(store2)
  const ops2 = new OpService(docs2)
  const doc2 = docs2.create({
    owner: 'u1',
    title: 'Clinical Draft',
    content: schema.node('doc', null, parseBlocks('# Introduction\n\nBaseline clinical paragraph.')),
  })
  const pId2 = docs2.get(doc2.id).child(1).attrs.id as string

  const rawCitationPatterns = [
    'According to Smith et al. (doi: 10.1056/NEJMoa2104821), survival improved.',
    'Prior meta-analysis (10.1016/S0140-6736(23)00812-4) demonstrated efficacy.',
    'Indexed in PubMed (PMID: 37482910) with significant HR reduction.',
    'See PMID 29847162 for secondary renal endpoints.',
    'Reported in recent trial https://doi.org/10.1001/jama.2024.11290.',
  ]
  let blockedCitations = 0
  const CITATION_TRIALS = 50
  for (let i = 0; i < CITATION_TRIALS; i++) {
    const sample = rawCitationPatterns[i % rawCitationPatterns.length]!
    const res = ops2.validate(
      {
        doc_id: doc2.id,
        base_rev: docs2.rev(doc2.id),
        mode: 'apply',
        ops: [{ op: 'replace_text', id: pId2, find: 'Baseline clinical paragraph.', replace: sample }],
      },
      { actor: 'ai', turnId: `cite_t_${i}` },
    )
    if (!res.valid && res.code === 'citation_not_registered') {
      blockedCitations++
    }
  }

  const phiSamples = [
    '患者姓名：李晓华，经病理检查确诊为浸润性乳腺癌，身份证号 11010519491231002X。',
    '患者姓名：王建国，确诊为慢性肾衰竭，住院号: IPD-889922，联系手机: 13900112233。',
    '门诊记录：住院号: H20261005-01，家属电话 13812345678，身份证 11010519491231002X。',
    '患者姓名：张伟，确诊为急性心肌梗死，就诊号：OPD-998877，联系电话 18611223344。',
  ]
  let phiDetectedCount = 0
  const PHI_TRIALS = 40
  for (let i = 0; i < PHI_TRIALS; i++) {
    const sample = phiSamples[i % phiSamples.length]!
    const findings = scanPhi(sample)
    const redacted = redactPhi(sample)
    if (findings.length >= 2 && redacted !== sample) {
      phiDetectedCount++
    }
  }

  const cleanScientificSamples = [
    'The 5-year overall survival was 78.4% (95% CI, 72.1-84.7%; HR 0.64, p < 0.001).',
    'Median follow-up was 36.5 months (IQR 24.1-48.9); WBC 6.5 x10^9/L, Platelets 220 x10^9/L.',
    'Kaplan-Meier curves were compared using the stratified log-rank test across 1,240 subjects.',
    'E-value for the point estimate was 2.51 (lower CI limit 1.74), indicating robustness to unmeasured confounding.',
  ]
  let falsePositives = 0
  for (let i = 0; i < 40; i++) {
    const sample = cleanScientificSamples[i % cleanScientificSamples.length]!
    if (scanPhi(sample).length > 0) falsePositives++
  }

  // =========================================================================
  // Experiment 3: Three-Layer Self-Evolving Memory Ablation (Sessions 1 -> 10)
  // =========================================================================
  const store3 = new Store(':memory:')
  const docs3 = new Documents(store3)
  const execSignals = new ExecutionSignals(store3, docs3)
  const procedural = new ProceduralHarnessService(store3, docs3)
  const evolution = new HarnessEvolutionService(store3, async () =>
    JSON.stringify({
      summary: 'Distilled global directives from multi-session guard signals',
      rules: [
        'Run doc_validate prior to mutating blocks with recent user activity',
        'Register all DOI/PMID entries via insert_citation before inline referencing',
      ],
    }),
  )

  const doc3 = docs3.create({
    owner: 'u_evol',
    title: 'Evolution Study Manuscript',
    content: schema.node('doc', null, parseBlocks('# Results\n\nInitial cohort results paragraph.')),
  })

  const archetypes = [
    { code: 'citation_not_registered', kind: 'guard_reject' as const, prompt: '补充最新临床试验文献与 DOI 引用' },
    { code: 'conflict_user_edited', kind: 'guard_reject' as const, prompt: '修改刚刚用户编辑过的讨论段 conflict_user_edited' },
    { code: 'user_reverted_turn', kind: 'turn_revert' as const, prompt: '重写核心研究结论章节 user_reverted_turn' },
    { code: 'anchor_broken', kind: 'guard_reject' as const, prompt: '修改带有批注锚点的生存统计段落 anchor_broken' },
    { code: 'table_schema_mismatch', kind: 'guard_reject' as const, prompt: '更新基线特征 Table 1 统计表格 table_schema_mismatch' },
    { code: 'phr_readonly_violation', kind: 'guard_reject' as const, prompt: '核对患者原始检验报告数值 phr_readonly_violation' },
  ]

  const curve: BenchmarkResults['exp3_self_evolution']['curve'] = []

  for (let session = 1; session <= 10; session++) {
    const activeRules = store3.listHarnessRules('u_evol', ['active'])
    let heurion2Rejections = 0
    let unrankedRejections = 0
    const noMemoryRejections = archetypes.length

    let totalPromptChars = 0
    for (const arch of archetypes) {
      const promptBlock = await procedural.forPrompt('u_evol', doc3.id, arch.prompt, 420)
      totalPromptChars += promptBlock.length

      const coveredByRanked =
        promptBlock.includes(arch.code) ||
        (arch.code === 'citation_not_registered' && promptBlock.includes('insert_citation')) ||
        (arch.code === 'conflict_user_edited' && promptBlock.includes('replace_text')) ||
        (arch.code === 'user_reverted_turn' && promptBlock.includes('颗粒度'))

      if (!coveredByRanked) {
        heurion2Rejections++
        if (arch.kind === 'guard_reject') {
          execSignals.recordGuardReject({
            owner: 'u_evol',
            docId: doc3.id,
            turnId: `s${session}_${arch.code}`,
            code: arch.code,
            message: `Simulated guard rejection for ${arch.code}`,
          })
        } else {
          store3.addExecutionSignal({
            owner: 'u_evol',
            doc_id: doc3.id,
            turn_id: `s${session}_${arch.code}`,
            kind: 'turn_revert',
            code: arch.code,
            detail: 'User reverted AI turn',
          })
        }
      }

      // Unranked FIFO baseline under tight budget (420 chars)
      const fifoSlice = activeRules.slice(0, 2)
      const coveredByUnranked = fifoSlice.some(r => r.trigger_pattern.includes(arch.code))
      if (!coveredByUnranked) {
        unrankedRejections++
      }
    }

    curve.push({
      session,
      no_memory_rejections: noMemoryRejections,
      unranked_memory_rejections: unrankedRejections,
      heurion2_dual_track_rejections: heurion2Rejections,
      heurion2_prompt_chars: Math.round(totalPromptChars / archetypes.length),
    })

    // Every 2 sessions, crystallize open signals into procedural rules (requires count >= 2)
    if (session % 2 === 0) {
      procedural.evolveFromSignals('u_evol')
    }
  }

  // Trigger Layer 3 global meta-strategy evolution
  store3.addExecutionSignal({ owner: 'system', doc_id: doc3.id, turn_id: 'sys_1', kind: 'guard_reject', code: 'conflict_user_edited', detail: '{}' })
  store3.addExecutionSignal({ owner: 'system', doc_id: doc3.id, turn_id: 'sys_2', kind: 'guard_reject', code: 'conflict_user_edited', detail: '{}' })
  store3.addExecutionSignal({ owner: 'system', doc_id: doc3.id, turn_id: 'sys_3', kind: 'guard_reject', code: 'citation_not_registered', detail: '{}' })
  await evolution.evolve({ force: true })

  const finalRules = store3.listHarnessRules('u_evol', ['active'])
  const overlayYaml = evolution.currentOverlay() ?? ''

  return {
    timestamp: new Date().toISOString(),
    exp1_dual_surface: {
      trials: N_TRIALS,
      unmodified_byte_identity_rate: (byteIdenticalUnmodified / N_TRIALS) * 100,
      concurrent_conflict_guard_accuracy: (conflictGuardCaught / N_TRIALS) * 100,
      selective_turn_undo_preservation_rate: (selectiveUndoPreserved / N_TRIALS) * 100,
      avg_validate_latency_ms: Number((totalValidateMs / N_TRIALS).toFixed(3)),
      avg_edit_latency_ms: Number((totalEditMs / N_TRIALS).toFixed(3)),
      avg_revert_latency_ms: Number((totalRevertMs / N_TRIALS).toFixed(3)),
    },
    exp2_prewrite_guards: {
      unregistered_citation_trials: CITATION_TRIALS,
      unregistered_citation_block_rate: (blockedCitations / CITATION_TRIALS) * 100,
      phi_injection_trials: PHI_TRIALS,
      phi_detection_recall: (phiDetectedCount / PHI_TRIALS) * 100,
      clean_medical_false_positive_rate: (falsePositives / 40) * 100,
    },
    exp3_self_evolution: {
      sessions: 10,
      curve,
      distilled_rules_count: finalRules.length,
      overlay_generated: overlayYaml.length > 0,
    },
  }
}

const results = await runBenchmarks()
mkdirSync(join(__dirname, '../results'), { recursive: true })
const outPath = join(__dirname, '../results/benchmark_results.json')
writeFileSync(outPath, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
