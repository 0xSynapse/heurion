import type { Hono } from 'hono'
import { calculateEValue, type EValueInput, type EValueResult } from '../../research/causal-inference.ts'
import { renderConsortMermaid, renderConsortSvg, type ConsortDiagramData } from '../../research/consort.ts'
import { generateTable1FromData, type Table1Options } from '../../datasets/table1.ts'
import { exportTable1ToDocx } from '../../datasets/table1-docx.ts'
import { scanPhi, type PhiFinding } from '../../ops/phi-scan.ts'
import type { PubMedClient } from '../../literature/pubmed.ts'
import type { CrossrefClient } from '../../literature/crossref.ts'

/**
 * 免登录临床科研微型工具公开 API（Stateless Public Mini-Tools API）
 *
 * 设计约束：
 * - 完全无状态（不读写数据库、不依赖登录 Session）
 * - 严格限制单次请求体积（CSV <= 500 行，文稿核验 <= 2000 字符）与单 IP 速率限制
 * - 复用平台核心统计、流向图、Table 1 原生 Word 导出、PHI 扫描与 PubMed 核验引擎
 */

export interface PublicToolsDeps {
  pubmed?: PubMedClient
  crossref?: CrossrefClient
}

/** 轻量内存级 IP 限流器（滑动窗口 60 秒） */
const ipBuckets = new Map<string, { count: number; resetAt: number }>()
function checkRateLimit(ip: string, limitPerMin = 40): boolean {
  const now = Date.now()
  if (ipBuckets.size > 2000) {
    for (const [k, v] of ipBuckets) {
      if (v.resetAt < now) ipBuckets.delete(k)
    }
  }
  const cur = ipBuckets.get(ip)
  if (!cur || cur.resetAt < now) {
    ipBuckets.set(ip, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (cur.count >= limitPerMin) return false
  cur.count++
  return true
}

/**
 * 绘制 VanderWeele E-value 未测量混杂偏倚阈值曲线 (SVG)
 * 横轴：混杂因素与暴露关联强度 RR_EU
 * 纵轴：混杂因素与结局关联强度 RR_UD
 * 满足 RR_EU * RR_UD / (RR_EU + RR_UD - 1) = RR_obs
 */
export function renderEValueCurveSvg(result: EValueResult, lang: 'zh' | 'en' = 'zh'): string {
  const isEn = lang === 'en'
  const ePoint = result.e_value_point
  const eCi = result.e_value_ci
  const width = 560
  const height = 340
  const padL = 62
  const padR = 30
  const padT = 38
  const padB = 48
  const plotW = width - padL - padR
  const plotH = height - padT - padB

  const maxAxis = Math.max(4.0, Math.ceil(ePoint * 2.1 * 2) / 2)
  const minAxis = 1.0
  const toX = (v: number) => padL + ((v - minAxis) / (maxAxis - minAxis)) * plotW
  const toY = (v: number) => padT + plotH - ((v - minAxis) / (maxAxis - minAxis)) * plotH

  // 由 E = RR + sqrt(RR*(RR-1)) 反推等价风险比 RR_obs (>1)
  const toEquivalentRR = (e: number) => (e <= 1 ? 1 : (e * e + 1) / (2 * e) <= 1 ? 1 : (() => {
    // E = r + sqrt(r(r-1)) => (E - r)^2 = r^2 - r => E^2 - 2Er + r^2 = r^2 - r => r(2E - 1) = E^2
    return (e * e) / (2 * e - 1)
  })())

  const buildCurvePath = (eVal: number): string => {
    if (eVal <= 1.01) return ''
    const rObs = toEquivalentRR(eVal)
    const pts: string[] = []
    const steps = 60
    const startX = rObs + 0.04
    for (let i = 0; i <= steps; i++) {
      const rrEU = startX + ((maxAxis - startX) * i) / steps
      // RR_UD = RR_obs * (RR_EU - 1) / (RR_EU - RR_obs)
      const denom = rrEU - rObs
      if (denom <= 0.02) continue
      const rrUD = (rObs * (rrEU - 1)) / denom
      if (rrUD < minAxis || rrUD > maxAxis) continue
      pts.push(`${pts.length === 0 ? 'M' : 'L'}${toX(rrEU).toFixed(1)},${toY(rrUD).toFixed(1)}`)
    }
    return pts.join(' ')
  }

  const pointPath = buildCurvePath(ePoint)
  const ciPath = eCi > 1.01 ? buildCurvePath(eCi) : ''
  const ex = toX(Math.min(ePoint, maxAxis))
  const ey = toY(Math.min(ePoint, maxAxis))

  const ticks: number[] = []
  const step = maxAxis <= 5 ? 0.5 : maxAxis <= 10 ? 1 : 2
  for (let v = minAxis; v <= maxAxis + 0.001; v += step) ticks.push(Number(v.toFixed(1)))

  const gridSvg = ticks.map(t => {
    const x = toX(t)
    const y = toY(t)
    return `
      <line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${padT + plotH}" stroke="#e2e8f0" stroke-width="1" />
      <line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1" />
      <text x="${x.toFixed(1)}" y="${padT + plotH + 18}" text-anchor="middle" font-family="Times New Roman, serif" font-size="11" fill="#475569">${t.toFixed(1)}</text>
      <text x="${padL - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="Times New Roman, serif" font-size="11" fill="#475569">${t.toFixed(1)}</text>
    `
  }).join('')

  const xLabel = isEn
    ? 'Confounder–Exposure Association (RR_EU)'
    : '混杂与暴露关联强度 RR_EU (Confounder–Exposure RR)'
  const yLabel = isEn
    ? 'Confounder–Outcome Association (RR_UD)'
    : '混杂与结局关联 RR_UD'

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect width="100%" height="100%" rx="8" fill="#ffffff" />
  <text x="${width / 2}" y="22" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="14" font-weight="bold" fill="#0f172a">VanderWeele E-value Bias Threshold Curve (${result.effect_type} = ${result.estimate})</text>
  <rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.2" />
  ${gridSvg}
  <!-- 45-degree E-value symmetry line -->
  <line x1="${toX(1)}" y1="${toY(1)}" x2="${toX(maxAxis)}" y2="${toY(maxAxis)}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,3" />
  ${ciPath ? `<path d="${ciPath}" fill="none" stroke="#f59e0b" stroke-width="2" stroke-dasharray="5,4" />` : ''}
  ${pointPath ? `<path d="${pointPath}" fill="none" stroke="#059669" stroke-width="2.4" />` : ''}
  ${ePoint <= maxAxis ? `
    <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="5" fill="#059669" stroke="#ffffff" stroke-width="1.5" />
    <text x="${Math.min(ex + 10, width - 135).toFixed(1)}" y="${Math.max(ey - 8, padT + 16).toFixed(1)}" font-family="Times New Roman, STSong, serif" font-size="12" font-weight="bold" fill="#065f46">E-value = ${ePoint.toFixed(2)}</text>
  ` : ''}
  <text x="${padL + plotW / 2}" y="${height - 10}" text-anchor="middle" font-family="Times New Roman, STSong, serif" font-size="12" font-weight="bold" fill="#1e293b">${xLabel}</text>
  <text x="18" y="${padT + plotH / 2}" text-anchor="middle" transform="rotate(-90 18 ${padT + plotH / 2})" font-family="Times New Roman, STSong, serif" font-size="12" font-weight="bold" fill="#1e293b">${yLabel}</text>
</svg>`
}

/**
 * 解析 CSV 或 TSV 文本为结构化对象数组（上限 maxRows 行）
 */
export function parseTabularText(raw: string, maxRows = 500): Array<Record<string, unknown>> {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  if (lines.length < 2) return []

  const headerLine = lines[0]!
  const delimiter = headerLine.includes('\t') ? '\t' : ','
  const splitLine = (line: string): string[] => {
    const out: string[] = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (ch === delimiter && !inQuotes) {
        out.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    out.push(cur.trim())
    return out
  }

  const headers = splitLine(headerLine).slice(0, 25)
  const rows: Array<Record<string, unknown>> = []
  const limit = Math.min(lines.length, maxRows + 1)

  for (let i = 1; i < limit; i++) {
    const cells = splitLine(lines[i]!)
    const row: Record<string, unknown> = {}
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c]
      if (!key) continue
      const val = cells[c] ?? ''
      if (val === '' || val.toLowerCase() === 'na' || val.toLowerCase() === 'null') {
        row[key] = null
      } else {
        const num = Number(val)
        row[key] = !Number.isNaN(num) && val !== '' ? num : val
      }
    }
    rows.push(row)
  }
  return rows
}

/**
 * 内置经典临床试验文献种子库（用于离线/演示秒级核验，以及回退保护）
 */
interface SeedPubMedRecord {
  pmid: string
  doi: string
  title: string
  authors: string[]
  journal: string
  year: string
  abstract: string
}

const LANDMARK_TRIALS: Record<string, SeedPubMedRecord> = {
  '31535829': {
    pmid: '31535829',
    doi: '10.1056/nejmoa1911303',
    title: 'Dapagliflozin in Patients with Heart Failure and Reduced Ejection Fraction',
    authors: ['McMurray JJV', 'Solomon SD', 'Inzucchi SE', 'Køber L', 'Kosiborod MN'],
    journal: 'N Engl J Med',
    year: '2019',
    abstract:
      'BACKGROUND: In patients with type 2 diabetes, inhibitors of sodium-glucose cotransporter 2 (SGLT2) reduce the risk of a first hospitalization for heart failure. METHODS: In this phase 3, placebo-controlled trial, we randomly assigned 4744 patients with New York Heart Association class II, III, or IV heart failure and an ejection fraction of 40% or less to receive either dapagliflozin (at a dose of 10 mg once daily) or placebo. RESULTS: Over a median of 18.2 months, the primary outcome occurred in 386 of 2373 patients (16.3%) in the dapagliflozin group and in 502 of 2371 patients (21.2%) in the placebo group (hazard ratio, 0.74; 95% confidence interval [CI], 0.65 to 0.85; P<0.001). A first worsening heart failure event occurred in 237 patients (10.0%) in the dapagliflozin group and in 326 patients (13.7%) in the placebo group (hazard ratio, 0.70; 95% CI, 0.59 to 0.83). Death from cardiovascular causes occurred in 227 patients (9.6%) in the dapagliflozin group and in 273 patients (11.5%) in the placebo group (hazard ratio, 0.82; 95% CI, 0.69 to 0.98).',
  },
  '36027570': {
    pmid: '36027570',
    doi: '10.1056/nejmoa2206286',
    title: 'Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction',
    authors: ['Solomon SD', 'McMurray JJV', 'Claggett B', 'de Boer RA', 'DeMets D'],
    journal: 'N Engl J Med',
    year: '2022',
    abstract:
      'BACKGROUND: Sodium-glucose cotransporter 2 (SGLT2) inhibitors reduce the risk of hospitalization for heart failure and cardiovascular death among patients with heart failure and a left ventricular ejection fraction of 40% or less. METHODS: We randomly assigned 6263 patients with heart failure and a left ventricular ejection fraction of more than 40% to receive dapagliflozin (at a dose of 10 mg once daily) or matching placebo. RESULTS: Over a median of 2.3 years, the primary outcome occurred in 512 of 3131 patients (16.4%) in the dapagliflozin group and in 610 of 3132 patients (19.5%) in the placebo group (hazard ratio, 0.82; 95% confidence interval [CI], 0.73 to 0.92; P<0.001). Worsening heart failure occurred in 368 patients (11.8%) in the dapagliflozin group and in 455 patients (14.5%) in the placebo group (hazard ratio, 0.79; 95% CI, 0.69 to 0.91).',
  },
  '32865377': {
    pmid: '32865377',
    doi: '10.1056/nejmoa2022190',
    title: 'Cardiovascular and Renal Outcomes with Empagliflozin in Heart Failure',
    authors: ['Packer M', 'Anker SD', 'Butler J', 'Filippatos G', 'Pocock SJ'],
    journal: 'N Engl J Med',
    year: '2020',
    abstract:
      'RESULTS: During a median of 16 months, a primary outcome event occurred in 361 of 1863 patients (19.4%) in the empagliflozin group and in 462 of 1867 patients (24.7%) in the placebo group (hazard ratio for cardiovascular death or hospitalization for heart failure, 0.75; 95% confidence interval [CI], 0.65 to 0.86; P<0.001).',
  },
}

export interface CitationVerificationItem {
  id: string
  raw_identifier: string
  pmid: string | null
  doi: string | null
  status: 'verified' | 'mismatch' | 'unverifiable'
  title: string | null
  journal: string | null
  year: string | null
  authors: string[]
  claimed_numbers: string[]
  abstract_numbers: string[]
  message_zh: string
  message_en: string
}

/**
 * 从文稿段落中提取 PMID / DOI 及其所在句子中的效应量数值，并对照 PubMed 核验
 */
export async function verifyManuscriptCitations(
  text: string,
  deps: PublicToolsDeps = {},
): Promise<{ items: CitationVerificationItem[]; summary: { total: number; verified: number; mismatch: number; unverifiable: number } }> {
  const clipped = text.slice(0, 2500)
  // 匹配 PMID: 12345678 或 DOI: 10.xxxx/xxxx
  const pmidMatches = [...clipped.matchAll(/\bPMID\s*[:：]?\s*(\d{5,9})\b/gi)]
  const doiMatches = [...clipped.matchAll(/\b(10\.\d{4,9}\/[^\s"<>)\],;]+)/gi)]

  const seen = new Set<string>()
  const targets: Array<{ kind: 'pmid' | 'doi'; value: string; contextText: string }> = []

  // 将文本按句号或换行切分以关联上下文数值
  const findContextFor = (token: string): string => {
    const lines = clipped.split(/\n+/)
    // 如果 token 出现在底部的参考文献行（如 "1. McMurray... PMID: 31535829"），尝试找正文中的 [1]
    const refLine = lines.find(l => l.includes(token)) ?? ''
    const refNumMatch = /^\s*(?:\[(\d+)\]|(\d+)\.)/.exec(refLine)
    const refNum = refNumMatch?.[1] ?? refNumMatch?.[2]
    if (refNum) {
      const citingSentences = clipped
        .split(/\n+|(?<=[。！？!?])\s*|(?<!\d)\.(?!\d)\s+/)
        .filter(s => s.includes(`[${refNum}]`) || s.includes(`(${refNum})`))
      if (citingSentences.length > 0) {
        return citingSentences.join(' ') + ' ' + refLine
      }
    }
    const idx = clipped.indexOf(token)
    if (idx === -1) return clipped
    return clipped.slice(Math.max(0, idx - 220), Math.min(clipped.length, idx + 220))
  }

  for (const m of pmidMatches) {
    const pmid = m[1]!
    const key = `pmid:${pmid}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ kind: 'pmid', value: pmid, contextText: findContextFor(m[0]) })
  }

  for (const m of doiMatches) {
    const doi = m[1]!.replace(/[.,;)]+$/, '').toLowerCase()
    const key = `doi:${doi}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ kind: 'doi', value: doi, contextText: findContextFor(m[0]) })
  }

  const extractEffectNumbers = (str: string): string[] => {
    const nums = new Set<string>()
    // 匹配 HR/OR/RR 后的小数（如 HR 0.74, hazard ratio, 0.74, 95% CI 0.65-0.85）
    const regex = /(?:HR|OR|RR|hazard\s+ratio|odds\s+ratio|relative\s+risk|CI|置信区间)[^0-9]{0,18}(\d+\.\d{1,3})/gi
    let m: RegExpExecArray | null
    while ((m = regex.exec(str)) !== null) {
      if (m[1]) nums.add(Number(m[1]).toFixed(2))
    }
    const ciRegex = /(\d+\.\d{2})\s*(?:to|–|-|~)\s*(\d+\.\d{2})/gi
    while ((m = ciRegex.exec(str)) !== null) {
      if (m[1]) nums.add(Number(m[1]).toFixed(2))
      if (m[2]) nums.add(Number(m[2]).toFixed(2))
    }
    return [...nums]
  }

  const items: CitationVerificationItem[] = []
  for (const t of targets.slice(0, 8)) {
    let pmid: string | null = t.kind === 'pmid' ? t.value : null
    let doi: string | null = t.kind === 'doi' ? t.value : null
    let title: string | null = null
    let journal: string | null = null
    let year: string | null = null
    let authors: string[] = []
    let abstractText: string | null = null

    // 1. 先检查内置权威试验种子库
    const seedByPmid = pmid ? LANDMARK_TRIALS[pmid] : undefined
    const seedByDoi = doi ? Object.values(LANDMARK_TRIALS).find(s => s.doi === doi) : undefined
    const seed = seedByPmid ?? seedByDoi

    if (seed) {
      pmid = seed.pmid
      doi = seed.doi
      title = seed.title
      journal = seed.journal
      year = seed.year
      authors = seed.authors
      abstractText = seed.abstract
    } else if (deps.pubmed) {
      try {
        if (!pmid && doi) {
          pmid = await deps.pubmed.pmidForDoi(doi)
        }
        if (pmid) {
          const summaries = await deps.pubmed.summaries([pmid])
          const art = summaries[0]
          if (art) {
            title = art.title
            journal = art.journal
            year = art.year
            authors = art.authors
            doi = art.doi ?? doi
            abstractText = await deps.pubmed.abstract(pmid).catch(() => null)
          }
        }
      } catch {
        // 网络超时或离线时安全降级
      }
    }

    if (!title && doi && deps.crossref) {
      try {
        const art = await deps.crossref.lookup(doi)
        if (art) {
          title = art.title
          journal = art.journal
          year = art.year
          authors = art.authors
        }
      } catch {
        // ignore
      }
    }

    const claimedNums = extractEffectNumbers(t.contextText)
    const abstractNums = abstractText ? extractEffectNumbers(abstractText) : []

    if (!title) {
      items.push({
        id: `${t.kind}:${t.value}`,
        raw_identifier: t.kind === 'pmid' ? `PMID: ${t.value}` : `DOI: ${t.value}`,
        pmid,
        doi,
        status: 'unverifiable',
        title: null,
        journal: null,
        year: null,
        authors: [],
        claimed_numbers: claimedNums,
        abstract_numbers: [],
        message_zh: `未能在 NCBI PubMed 或 Crossref 中查找到 ${t.kind.toUpperCase()} (${t.value}) 的真实记录，高度疑似大模型凭空捏造的幻觉文献。`,
        message_en: `No authentic record found in NCBI PubMed or Crossref for ${t.kind.toUpperCase()} (${t.value}). Flagged as a potential hallucinated reference.`,
      })
      continue
    }

    // 检查文稿中声称的效应量数值是否与摘要中的数值匹配
    const missingNums = claimedNums.filter(n => abstractNums.length > 0 && !abstractNums.includes(n))
    if (claimedNums.length > 0 && abstractNums.length > 0 && missingNums.length > 0) {
      items.push({
        id: `${t.kind}:${t.value}`,
        raw_identifier: pmid ? `PMID: ${pmid}` : `DOI: ${doi}`,
        pmid,
        doi,
        status: 'mismatch',
        title,
        journal,
        year,
        authors,
        claimed_numbers: claimedNums,
        abstract_numbers: abstractNums,
        message_zh: `文献真实存在（${journal} ${year}），但文稿引用的统计数值（${missingNums.join(', ')}）与 PubMed 原文摘要报告的效应量（${abstractNums.join(', ')}）不一致，请核查是否张冠李戴。`,
        message_en: `Authentic article found (${journal} ${year}), but cited effect size(s) (${missingNums.join(', ')}) do not match the numbers in the PubMed abstract (${abstractNums.join(', ')}).`,
      })
    } else {
      items.push({
        id: `${t.kind}:${t.value}`,
        raw_identifier: pmid ? `PMID: ${pmid}` : `DOI: ${doi}`,
        pmid,
        doi,
        status: 'verified',
        title,
        journal,
        year,
        authors,
        claimed_numbers: claimedNums,
        abstract_numbers: abstractNums,
        message_zh: claimedNums.length > 0 && abstractNums.length > 0
          ? `核验通过：文献真实存在（${journal} ${year}），且文内引用的统计效应量（${claimedNums.join(', ')}）与 PubMed 原文摘要完全一致。`
          : `核验通过：已在权威医学数据库核实该文献元数据（${journal} ${year}）。`,
        message_en: claimedNums.length > 0 && abstractNums.length > 0
          ? `Verified: Authentic PubMed record (${journal} ${year}), and cited effect sizes (${claimedNums.join(', ')}) match the original abstract.`
          : `Verified: Authentic bibliographic record confirmed in PubMed/Crossref (${journal} ${year}).`,
      })
    }
  }

  return {
    items,
    summary: {
      total: items.length,
      verified: items.filter(i => i.status === 'verified').length,
      mismatch: items.filter(i => i.status === 'mismatch').length,
      unverifiable: items.filter(i => i.status === 'unverifiable').length,
    },
  }
}

export function registerPublicToolsApi(app: Hono<any>, deps: PublicToolsDeps = {}): void {
  const getIp = (c: any): string => c.req.header('x-real-ip')?.trim() || 'local'

  /** 1. VanderWeele E-value 敏感性分析 + 审稿人回复模板 + 阈值曲线 SVG */
  app.post('/api/public/tools/e-value', async c => {
    if (!checkRateLimit(getIp(c), 60)) {
      return c.json({ error: '请求过于频繁，请稍后再试 / Rate limit exceeded' }, 429)
    }
    try {
      const body = await c.req.json<EValueInput & { lang?: 'zh' | 'en' }>()
      const lang: 'zh' | 'en' = body.lang === 'en' ? 'en' : 'zh'
      const res = calculateEValue(body)
      const svg = renderEValueCurveSvg(res, lang)
      const rebuttal_zh =
        `【审稿人回复模板 (Response to Reviewer)】\n` +
        `感谢审稿人关于潜在未测量混杂因素（unmeasured confounding）的重要指正。为定量评估本研究结论对潜在未测量混杂偏倚的稳健性，我们依据 VanderWeele 与 Ding（Ann Intern Med, 2017;167:268-274）提出的方法补充了 E-value 敏感性分析。\n\n` +
        `${res.academic_defense_zh}\n\n` +
        `我们已在修订稿的 Methods（Statistical Analysis）与 Results 章节中补充了上述 E-value 敏感性分析结果。`
      const rebuttal_en =
        `[Response to Reviewer Template]\n` +
        `We thank the Reviewer for raising this important point regarding potential residual and unmeasured confounding. To formally quantify the robustness of our primary finding against potential unmeasured confounding, we conducted an E-value sensitivity analysis following the methodology of VanderWeele and Ding (Ann Intern Med. 2017;167(4):268-274).\n\n` +
        `${res.academic_defense_en}\n\n` +
        `We have incorporated this sensitivity analysis into the revised Methods and Results sections.`
      return c.json({ ...res, svg, rebuttal_zh, rebuttal_en })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  /** 2. CONSORT 2010 / STROBE 受试者流向图生成 (SVG + Mermaid) */
  app.post('/api/public/tools/consort', async c => {
    if (!checkRateLimit(getIp(c), 60)) {
      return c.json({ error: '请求过于频繁，请稍后再试 / Rate limit exceeded' }, 429)
    }
    try {
      const body = await c.req.json<ConsortDiagramData>()
      const lang: 'zh' | 'en' = body.lang === 'en' ? 'en' : 'zh'
      const isEn = lang === 'en'
      const safeExclusions = Array.isArray(body.exclusions) ? body.exclusions.slice(0, 15) : []
      const safeArms = Array.isArray(body.arms) ? body.arms.slice(0, 4) : []
      const totalAssessed = Math.max(0, Number(body.total_assessed) || 0)
      const totalExcluded = safeExclusions.reduce((s, e) => s + (Math.max(0, Number(e.count) || 0)), 0)
      const eligibleTotal = body.eligible_total !== undefined
        ? Math.max(0, Number(body.eligible_total) || 0)
        : Math.max(0, totalAssessed - totalExcluded)
      const normalized: ConsortDiagramData = {
        title: (body.title || 'CONSORT 2010 / STROBE Flow Diagram').slice(0, 120),
        lang,
        total_assessed: totalAssessed,
        exclusions: safeExclusions.map(e => ({
          reason: String(e.reason || (isEn ? 'Did not meet inclusion criteria' : '未满足入排标准')).slice(0, 80),
          count: Math.max(0, Number(e.count) || 0),
        })),
        eligible_total: eligibleTotal,
        arms: safeArms.map(a => ({
          name: String(a.name || (isEn ? 'Study Arm' : '研究组')).slice(0, 60),
          allocated: Math.max(0, Number(a.allocated) || 0),
          lost_to_followup: Math.max(0, Number(a.lost_to_followup) || 0),
          discontinued: Math.max(0, Number(a.discontinued) || 0),
          analyzed: Math.max(0, Number(a.analyzed) || 0),
        })),
      }
      const svg = renderConsortSvg(normalized)
      const mermaid = renderConsortMermaid(normalized)
      const arithmeticWarning = totalAssessed - totalExcluded !== eligibleTotal
        ? (isEn
            ? `Arithmetic warning: Total Assessed (${totalAssessed}) minus Total Excluded (${totalExcluded}) = ${totalAssessed - totalExcluded}, which does not match Eligible (${eligibleTotal}).`
            : `注意：初筛总人数 (${totalAssessed}) 减去排除人数总和 (${totalExcluded}) = ${totalAssessed - totalExcluded}，与当前填写的合格入组人数 (${eligibleTotal}) 不一致。`)
        : null
      return c.json({ svg, mermaid, normalized, arithmetic_warning: arithmeticWarning })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  /** 3. Table 1 基线特征三线表在线生成（含 PHI 隐私扫描与 SMD 计算） */
  app.post('/api/public/tools/table1', async c => {
    if (!checkRateLimit(getIp(c), 30)) {
      return c.json({ error: '请求过于频繁，请稍后再试 / Rate limit exceeded' }, 429)
    }
    try {
      const body = await c.req.json<{
        csv?: string
        records?: Array<Record<string, unknown>>
        options?: Table1Options
      }>()
      const rawText = typeof body.csv === 'string' ? body.csv.slice(0, 200_000) : JSON.stringify(body.records ?? []).slice(0, 200_000)
      const phiFindings: PhiFinding[] = scanPhi(rawText)
      const records = typeof body.csv === 'string'
        ? parseTabularText(body.csv, 500)
        : Array.isArray(body.records)
          ? body.records.slice(0, 500)
          : []
      if (records.length === 0) {
        return c.json({ error: '未解析到有效的数据行（请至少提供表头与 2 行数据）' }, 400)
      }
      const table1 = generateTable1FromData(records, body.options ?? {})
      return c.json({
        phi_clean: phiFindings.length === 0,
        phi_findings_count: phiFindings.length,
        phi_findings: phiFindings.slice(0, 10).map(f => ({
          type: f.type,
          redacted: f.redacted,
          description: f.description,
        })),
        row_count: records.length,
        columns: Object.keys(records[0] ?? {}),
        table1,
      })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  /** 4. Table 1 原生 Word (.docx) 三线表二进制流直接下载 */
  app.post('/api/public/tools/table1-docx', async c => {
    if (!checkRateLimit(getIp(c), 20)) {
      return c.json({ error: '请求过于频繁，请稍后再试 / Rate limit exceeded' }, 429)
    }
    try {
      const body = await c.req.json<{
        csv?: string
        records?: Array<Record<string, unknown>>
        options?: Table1Options
      }>()
      const records = typeof body.csv === 'string'
        ? parseTabularText(body.csv, 500)
        : Array.isArray(body.records)
          ? body.records.slice(0, 500)
          : []
      if (records.length === 0) {
        return c.json({ error: '未解析到有效的数据行' }, 400)
      }
      const table1 = generateTable1FromData(records, body.options ?? {})
      const docxBytes = exportTable1ToDocx(table1)
      return c.body(docxBytes as unknown as ArrayBuffer, 200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="Heurion_Table1_Baseline.docx"`,
      })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  /** 5. PubMed 文献引用与效应量（HR/OR/95% CI）真实性核验 */
  app.post('/api/public/tools/citation-check', async c => {
    if (!checkRateLimit(getIp(c), 20)) {
      return c.json({ error: '请求过于频繁，请稍后再试 / Rate limit exceeded' }, 429)
    }
    try {
      const body = await c.req.json<{ text?: string }>()
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) {
        return c.json({ error: '请输入需要核验的医学论文段落或参考文献列表' }, 400)
      }
      const report = await verifyManuscriptCitations(text, deps)
      return c.json(report)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })
}
