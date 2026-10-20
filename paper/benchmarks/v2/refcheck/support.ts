/**
 * 引用支持度（ANALYSIS_PLAN_v2 §2.3）：新增的每条文献，在正文里找到引用它的句子，取 PubMed 题目与摘要，
 * 由评判模型（deepseek-flash，不参与任何一组）判断该文献的研究结果是否支持这句话。
 * 判定按（句子, PMID）缓存在 refcheck/cache.json：同样的输入只判一次，重算结果一致。
 * 结论：supported 支持 / partial 部分支持（相关但证据较弱或只支持一部分）/ not_supported 不支持；
 * 另有 uncited（正文没有引用它）、no_abstract（查不到摘要，无法判定）、unjudged（评判输出两次都无法解析）。
 */
import { makeComplete } from '../../../../apps/platform/src/harness/complete.ts'
import { byDoiPubmed, getText, memo, type RefDetail } from './refcheck.ts'

export type Support = 'supported' | 'partial' | 'not_supported' | 'uncited' | 'no_abstract' | 'unjudged'
export interface SupportDetail { entry: string; number: number; support: Support; sentence: string | null; pmid: string | null; reason: string }

export const JUDGE_MODEL = process.env.JUDGE_MODEL || 'deepseek-flash'
let judge: ((system: string, user: string) => Promise<string>) | null | undefined
function judgeFn() {
  if (judge === undefined) judge = makeComplete({ upstream: process.env.DEEPSEEK_UPSTREAM_URL || 'https://api.deepseek.com/anthropic/v1', apiKey: process.env.DEEPSEEK_API_KEY ?? '', model: JUDGE_MODEL })
  if (!judge) throw new Error('引用支持度判定需要 DEEPSEEK_API_KEY')
  return judge
}

/** 文献表条目的编号：开头的 [n] / n. ；没有编号时按在文献表里的位置。 */
export function refNumber(entry: string, index: number): number {
  const m = /^\s*[[［]?(\d{1,3})[\]］.)、]/.exec(entry)
  return m ? Number(m[1]) : index + 1
}

/** 一个引用标记组里的编号：[3]、[3,5]、[2–4]、[[2], [5]–[7]]。 */
function numbersIn(group: string): number[] {
  const out: number[] = []
  for (const part of group.replace(/[[\]［］]/g, '').split(/[,，;；]/)) {
    const r = /^\s*(\d+)\s*(?:[–\-~～]\s*(\d+))?\s*$/.exec(part)
    if (!r) continue
    const a = Number(r[1])
    const b = r[2] ? Number(r[2]) : a
    for (let k = a; k <= b && k - a < 50; k++) out.push(k)
  }
  return out
}

const sentencesOf = (para: string) => para.split(/(?<=[.。!?！？])\s+(?=[A-Z(\[［一-鿿])/).map(s => s.trim()).filter(Boolean)

/** 正文里引用编号 n 的句子；优先选改动后新出现的句子（原稿里没有的）。 */
export function citingSentence(body: string[], before: string[], n: number): string | null {
  const old = new Set(before.flatMap(sentencesOf))
  const hits: string[] = []
  for (const para of body) {
    for (const s of sentencesOf(para)) {
      const groups = [...s.matchAll(/[[［][^\]］]*\d[^\]］]*[\]］](?:\s*[–\-]\s*[[［]\d+[\]］])?/g)].map(m => m[0])
      if (groups.some(g => numbersIn(g.replace(/\]\s*[–\-]\s*\[/, '–')).includes(n))) hits.push(s)
    }
  }
  return hits.find(s => !old.has(s)) ?? hits[0] ?? null
}

async function pmidOf(d: RefDetail): Promise<string | null> {
  if (d.matched_pmid) return d.matched_pmid
  if (d.pmid) return d.pmid
  if (d.doi) return (await byDoiPubmed(d.doi))?.pmid ?? null
  return null
}

async function abstractOf(pmid: string): Promise<{ title: string; abstract: string } | null> {
  const xml = await getText(`efetch:${pmid}`, `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=xml`, true)
  if (!xml) return null
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  const title = strip(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/.exec(xml)?.[1] ?? '')
  const abstract = [...xml.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(m => { const label = /Label="([^"]+)"/.exec(m[1]!)?.[1]; return `${label ? `${label}: ` : ''}${strip(m[2]!)}` }).join(' ')
  return abstract ? { title, abstract } : null
}

const SYSTEM = `你是医学期刊的审稿人，负责核对参考文献是否支持正文中引用它的句子。
只根据给出的文献题目与摘要判断，不要用自己的知识补充。
- supported：文献的研究结果直接支持这句话的主张（含引用它的那部分主张）。
- partial：文献与这句话相关，但只支持其中一部分，或证据较间接、较弱。
- not_supported：文献与这句话的主张无关、相矛盾，或只是题目相关而结果并不支持。
只输出一行 JSON：{"verdict":"supported|partial|not_supported","reason":"一句话理由"}`

/** 对新增的、已核实存在的文献逐条判定支持度。 */
export async function checkSupport(details: RefDetail[], afterRefs: string[], body: string[], beforeBody: string[]): Promise<SupportDetail[]> {
  const out: SupportDetail[] = []
  for (const d of details) {
    if (d.status !== 'verified') continue
    const n = refNumber(d.entry, Math.max(0, afterRefs.indexOf(d.entry)))
    const sentence = citingSentence(body, beforeBody, n)
    const base = { entry: d.entry, number: n, sentence }
    if (!sentence) { out.push({ ...base, support: 'uncited', pmid: null, reason: `正文没有引用 [${n}] 的句子` }); continue }
    const pmid = await pmidOf(d)
    const abs = pmid ? await abstractOf(pmid) : null
    if (!pmid || !abs) { out.push({ ...base, support: 'no_abstract', pmid, reason: pmid ? 'PubMed 没有摘要' : '查不到 PubMed 记录' }); continue }
    const verdict = await memo(`support:${JUDGE_MODEL}:${pmid}:${sentence}`, async () => {
      let raw = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        raw = await judgeFn()(SYSTEM, `句子：${sentence}\n\n文献题目：${abs.title}\n\n摘要：${abs.abstract.slice(0, 6000)}`)
        try {
          const v = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '') as { verdict?: string; reason?: string }
          const verdict = (['supported', 'partial', 'not_supported'] as const).find(x => x === v.verdict)
          if (verdict) return { verdict, reason: String(v.reason ?? '') }
        } catch { /* 再试一次 */ }
      }
      return { verdict: 'unjudged' as const, reason: `评判输出无法解析：${raw.slice(0, 80)}` }
    })
    out.push({ ...base, support: verdict.verdict, pmid, reason: verdict.reason })
  }
  return out
}
