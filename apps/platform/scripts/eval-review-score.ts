/**
 * 深度审稿评测打分：读取一次运行的结果，自动匹配植入错误，合并人工判定，输出指标与待判清单。
 *   pnpm --filter @heurion2/platform eval:review:score --run <run_id>
 * - 自动匹配：问题的原句 / 批注原文含有植入改动后新出现的数字或词，且与植入原文有重叠，记为候选命中（仍需人工确认）。
 * - 人工判定：eval/deep-review/adjudications/*.jsonl，按 finding_key 复用（干净版判过的问题在植入版原样出现时直接沿用）。
 * - 输出：runs/<run_id>/report.md 与 pending.jsonl（尚未判定的问题，供标注）。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVAL_DIR, labelsFor, readInjections, readManifest, type Label } from './eval-review-fetch.ts'
import { normText, RUNS_DIR, type RunFinding, type RunRecord } from './eval-review-run.ts'

export type Verdict = 'true_positive' | 'unexpected_true' | 'false_positive' | 'duplicate' | 'unclear'
export interface Adjudication {
  run_id?: string
  paper_id: string
  variant?: 'clean' | 'injected'
  finding_key: string
  verdict: Verdict
  matched_label?: string | null
  severity_ok?: boolean | null
  anchor_ok?: boolean | null
  annotator: string
  note?: string
}

const ADJ_DIR = join(EVAL_DIR, 'adjudications')
const SEVS = ['critical', 'major', 'minor'] as const

/** 植入改动后新出现的词元（数字优先，含正负号变化）：用来判断一条问题是否指向这处植入 */
export function changedTokens(find: string, replace: string): string[] {
  const tok = (s: string) => normText(s).match(/[−-]?\d+(?:\.\d+)?%?|[a-z一-龥]{3,}/g) ?? []
  const before = new Set(tok(find))
  const added = tok(replace).filter(t => !before.has(t))
  const nums = added.filter(t => /\d/.test(t))
  return nums.length ? nums : added
}

/** 一条问题是否命中某个标准答案 */
export function matches(f: RunFinding, label: Label, added: string[]): boolean {
  const text = normText(`${f.sentence} ${f.anchor} ${f.reason}`)
  const quote = normText(label.quote)
  const overlap = text.includes(quote.slice(0, 40)) || quote.includes(normText(f.anchor).slice(0, 40))
    || (label.related_quotes ?? []).some(r => text.includes(normText(r).slice(0, 40)))
  return overlap && added.length > 0 && added.every(t => text.includes(t))
}

export interface KnownOrganicError {
  id: string
  paper_id: string
  required_tokens: string[]
  note: string
}

export function readKnownOrganicErrors(): KnownOrganicError[] {
  const p = join(EVAL_DIR, 'known-organic-errors.json')
  if (!existsSync(p)) return []
  return JSON.parse(readFileSync(p, 'utf8')) as KnownOrganicError[]
}

export function matchesKnownOrganicError(
  paperId: string,
  f: RunFinding,
  knownList: KnownOrganicError[] = readKnownOrganicErrors(),
): KnownOrganicError | null {
  const blob = normText(`${f.sentence} ${f.anchor} ${f.reason}`)
  for (const item of knownList) {
    if (item.paper_id !== paperId) continue
    if (item.required_tokens.length > 0 && item.required_tokens.every(tok => blob.includes(normText(tok)))) {
      return item
    }
  }
  return null
}

export function readAdjudications(): Map<string, Adjudication> {
  const out = new Map<string, Adjudication>()
  if (!existsSync(ADJ_DIR)) return out
  for (const f of readdirSync(ADJ_DIR).filter(x => x.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(ADJ_DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const a = JSON.parse(line) as Adjudication
      out.set(`${a.paper_id}|${a.finding_key}`, a) // 后写的覆盖先写的
    }
  }
  return out
}

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—')
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

function main(): void {
  const runId = process.argv[process.argv.indexOf('--run') + 1]
  if (!runId || !process.argv.includes('--run')) throw new Error('用法：eval:review:score --run <run_id>')
  const dir = join(RUNS_DIR, runId)
  const records = readdirSync(dir).filter(f => /\.r\d+\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunRecord)
  const manifest = new Map(readManifest().map(p => [p.id, p]))
  const adj = readAdjudications()
  const knownOrganic = readKnownOrganicErrors()

  const pending: Array<Record<string, unknown>> = []
  const pendingSeen = new Set<string>()
  // 指标按「第 1 次运行」统计；稳定性单独比较各次之间的差异
  const primary = records.filter(r => r.repeat === 1)
  const fpPerClean: number[] = []
  const bySev = Object.fromEntries(SEVS.map(s => [s, { total: 0, tp: 0, fp: 0, pending: 0 }])) as Record<string, { total: number; tp: number; fp: number; pending: number }>
  const recall = new Map<string, { total: number; hit: number }>()
  const failures: string[] = []

  for (const r of primary) {
    if (!r.ok) failures.push(`${r.paper_id} ${r.variant}：${r.error}`)
    const labels = r.variant === 'injected' ? labelsFor(r.paper_id) : []
    const injections = new Map(readInjections(r.paper_id).map(i => [i.label_id, i]))
    const hitLabels = new Set<string>()
    let cleanFp = 0
    for (const f of r.findings) {
      const auto = labels.find(l => { const inj = injections.get(l.label_id)!; return matches(f, l, changedTokens(inj.find, inj.replace)) })
      const organic = !auto ? matchesKnownOrganicError(r.paper_id, f, knownOrganic) : null
      const a = adj.get(`${r.paper_id}|${f.finding_key}`)
      const s = bySev[f.severity]!
      s.total++
      const verdict: Verdict | 'auto_match' | null = a?.verdict ?? (auto ? 'auto_match' : organic ? 'unexpected_true' : null)
      if (verdict === 'true_positive' || verdict === 'unexpected_true' || verdict === 'auto_match') {
        s.tp++
        const lid = a?.matched_label ?? auto?.label_id
        if (lid) hitLabels.add(lid)
      } else if (verdict === 'false_positive') {
        s.fp++
        if (r.variant === 'clean' && f.severity !== 'minor') cleanFp++
      } else if (verdict !== 'duplicate') {
        s.pending++
      }
      if ((!a || verdict === 'auto_match') && !pendingSeen.has(`${r.paper_id}|${f.finding_key}`)) {
        pendingSeen.add(`${r.paper_id}|${f.finding_key}`)
        pending.push({
          paper_id: r.paper_id, variant: r.variant, finding_key: f.finding_key,
          suggested: auto
            ? { verdict: 'true_positive', matched_label: auto.label_id }
            : organic
              ? { verdict: 'unexpected_true', note: organic.note }
              : null,
          severity: f.severity, category: f.category, subtype: f.subtype, section: f.section_title,
          anchor: f.anchor, reason: f.reason, suggestion: f.suggestion,
          verdict: null, annotator: null, note: null,
        })
      }
    }
    if (r.variant === 'clean') fpPerClean.push(cleanFp)
    for (const l of labels) {
      const k = recall.get(l.type) ?? { total: 0, hit: 0 }
      k.total++
      if (hitLabels.has(l.label_id)) k.hit++
      recall.set(l.type, k)
    }
  }

  // 稳定性：同一稿件各次运行报出问题集合的 Jaccard 重合度
  const groups = new Map<string, RunRecord[]>()
  for (const r of records) groups.set(`${r.paper_id}|${r.variant}`, [...(groups.get(`${r.paper_id}|${r.variant}`) ?? []), r])
  const jaccards: number[] = []
  for (const rs of groups.values()) {
    if (rs.length < 2) continue
    const [a, b] = [new Set(rs[0]!.findings.map(f => f.finding_key)), new Set(rs[1]!.findings.map(f => f.finding_key))]
    const inter = [...a].filter(x => b.has(x)).length
    const union = new Set([...a, ...b]).size
    jaccards.push(union ? inter / union : 1)
  }

  const ok = primary.filter(r => r.ok)
  const lines = [
    `# 深度审稿评测 · ${runId}`,
    '',
    `稿件 ${primary.length} 份（干净 ${primary.filter(r => r.variant === 'clean').length} / 植入 ${primary.filter(r => r.variant === 'injected').length}），失败 ${failures.length}；切分：${[...new Set(primary.map(r => manifest.get(r.paper_id)?.split))].join(' / ')}`,
    '',
    '## 主指标：干净稿件上的致命 + 重要误报（只计已人工判定的）',
    '',
    `每篇平均 ${avg(fpPerClean).toFixed(2)} 条（${fpPerClean.length} 篇）；待判定问题 ${pending.length} 条，判定完成前此数偏低。`,
    '',
    '## 按严重度',
    '',
    '| 严重度 | 报出 | 判为真 | 判为误报 | 待判定 | 精确率（已判定部分） |',
    '|---|---|---|---|---|---|',
    ...SEVS.map(s => { const x = bySev[s]!; return `| ${s} | ${x.total} | ${x.tp} | ${x.fp} | ${x.pending} | ${pct(x.tp, x.tp + x.fp)} |` }),
    '',
    '「判为真」含自动匹配到植入错误、尚未人工确认的条目。',
    '',
    '## 召回（植入错误）',
    '',
    '| 类型 | 植入 | 检出 | 召回率 |',
    '|---|---|---|---|',
    ...[...recall.entries()].sort().map(([t, k]) => `| ${t} | ${k.total} | ${k.hit} | ${pct(k.hit, k.total)} |`),
    '',
    '## 成本与耗时（每份稿件平均）',
    '',
    `模型调用 ${avg(ok.map(r => r.calls)).toFixed(1)} 次 · 输入 ${Math.round(avg(ok.map(r => r.input_tokens)))} token · 输出 ${Math.round(avg(ok.map(r => r.output_tokens)))} token · 耗时 ${(avg(ok.map(r => r.ms)) / 1000).toFixed(1)} s`,
    '',
    '## 稳定性',
    '',
    jaccards.length ? `同一稿件两次运行的问题重合度（Jaccard）平均 ${avg(jaccards).toFixed(2)}（${jaccards.length} 组）` : '只跑了一次，未统计。',
    ...(failures.length ? ['', '## 失败', '', ...failures.map(f => `- ${f}`)] : []),
    '',
  ]
  writeFileSync(join(dir, 'report.md'), lines.join('\n'))
  writeFileSync(join(dir, 'pending.jsonl'), pending.map(p => JSON.stringify(p)).join('\n') + (pending.length ? '\n' : ''))
  console.log(lines.join('\n'))
  console.log(`待判定 ${pending.length} 条：${join(dir, 'pending.jsonl')}（判定后存入 eval/deep-review/adjudications/）`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main() } catch (err) { console.error(err instanceof Error ? err.message : err); process.exitCode = 1 }
}
