/**
 * 第一阶段 1b 语料遴选与转换（ANALYSIS_PLAN_v2 §4b.3）：
 * 按事先写定的 Europe PMC 检索式、按发表时间倒序（sort_date:y）扫描候选，排除 1a 的 10 篇，
 * 逐篇下载 JATS XML 并用 convert.ts 转成 markdown 与期刊格式 .docx，检验 §4b.3 预设结构条件，
 * 取前 10 篇满足条件且使 1b 会话可用篇数 ≥ 8 的论文（前 7 篇 train、后 3 篇 heldout），
 * 完整遴选日志写入 corpus-1b-selection.json，入选清单写入 corpus-1b.json。
 *
 *   cd apps/platform && npx tsx ../../paper/benchmarks/manuscripts/select-1b.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { docxFor } from '../../../apps/platform/src/convert/exports.ts'
import { setup } from '../../../apps/platform/tests/helpers.ts'
import * as D from '../exp3/docx.ts'
import { COMMENTS, check, measure, sectionParas } from './compare.ts'
import { convert } from './convert.ts'
import type { Paper } from './fetch.ts'
import {
  blocks, citeRef, DISCUSSION, firstTable, INTRO, isPara, loadCorpus, METHODS, movable,
  P_GOOD, P_GOOD_NOZERO, P_VALUE, PAPERS, plain, pTarget, RESULTS, section, targets, type PaperTopic,
} from './tasks.ts'
import { evaluateNatural, evaluateStress, humanRevisionKept, type RefSummary } from '../v2/oracles.ts'
import { integrity, wellFormed } from '../v2/fidelity/check.ts'
import { sessionReady, stepTask } from '../v2/sessions.ts'
import { firstThree, numberEditIn, plainCtx, sectionProse, STRESS, stressSchedule } from '../v2/stress.ts'
import { complexTemplate } from '../v2/templates.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest'
const ALLOWED = /^(cc[ -]?by|cc0)$/i

if (process.argv.includes('--dry-run')) {
  process.env.REEVAL_SKIP_SOFFICE = '1'
  const emptyRefs: RefSummary = {
    added: 0, verified: 0, mismatched: 0, fabricated: 0, raw_ids_in_body: 0, citation_markers_added: 0,
    verified_recent: 0, supported: 0, partial: 0, not_supported: 0, uncited: 0, no_abstract: 0, unjudged: 0, support: [],
  }
  const all = loadCorpus('corpus-1b.json')
  console.log('Total papers in corpus-1b.json:', all.length)
  const sessPapers = all.filter(p => sessionReady(p) !== null)
  console.log('sessionReady papers:', sessPapers.length, sessPapers.map(p => p.pmcid))
  for (const t of STRESS) {
    const ok = all.filter(p => { try { t.build(p); return true } catch { return false } })
    console.log(`Stress task ${t.id}: ${ok.length} eligible papers -> ${ok.map(p => p.pmcid).join(', ')}`)
  }
  const seeds = [401, 402, 403]
  const stressJobs = stressSchedule(seeds)
  const naturalJobsCount = seeds.length * 3 * PAPERS.tasks.length
  console.log(`stressSchedule([401,402,403]): ${stressJobs.length} jobs`)
  console.log(`naturalSchedule([401,402,403]): ${naturalJobsCount} jobs`)
  console.log(`Total single-turn jobs per arm: ${stressJobs.length + naturalJobsCount}`)

  let stressChecks = 0, stressErrors = 0
  for (const t of STRESS) {
    for (const p of all) {
      let ctx
      try { ctx = t.build(p) } catch { continue }
      stressChecks++
      const wf = wellFormed(ctx.source)
      const intg = integrity(ctx.source)
      const ev = await evaluateStress(t, ctx, ctx.source, [], false, emptyRefs)
      if (wf.length || intg.length || ev.collateral > 0 || ev.silent_changes > 0 || ev.file_problems.length > 0 || ev.features_lost.length > 0 || ev.human_lost.length > 0 || ev.format_lost.length > 0) {
        stressErrors++
        console.error('Stress dry-run problem:', t.id, p.pmcid, { wf, intg, ev })
      }
    }
  }
  console.log(`Stress dry-run: checked ${stressChecks} (paper, task) pairs, errors = ${stressErrors}`)

  let sessStepChecks = 0, sessErrors = 0
  for (const p of sessPapers) {
    const ready = sessionReady(p)!
    const wf = wellFormed(ready.ctx.source)
    const intg = integrity(ready.ctx.source)
    if (wf.length || intg.length) {
      sessErrors++
      console.error('Session template wf/intg error:', p.pmcid, { wf, intg })
    }
    for (const step of ready.steps) {
      sessStepChecks++
      const st = stepTask(step, ready.ctx.source)
      const msg = st.message(ready.ctx)
      const tgs = st.targets(ready.ctx)
      const ev = await evaluateStress(st, ready.ctx, ready.ctx.source, [], false, emptyRefs)
      if (!msg || !tgs.length || ev.collateral > 0 || ev.silent_changes > 0 || ev.file_problems.length > 0 || ev.features_lost.length > 0 || ev.human_lost.length > 0) {
        sessErrors++
        console.error('Session step dry-run problem:', p.pmcid, step.id, { ev })
      }
    }
  }
  console.log(`Session dry-run: checked ${sessStepChecks} (paper, step) pairs across ${sessPapers.length} papers, errors = ${sessErrors}`)

  let natChecks = 0, natErrors = 0
  for (const p of all) {
    const src = D.openDocx(new Uint8Array(readFileSync(join(here, 'data', 'docx', `${p.pmcid}.docx`))))
    const wf = wellFormed(src)
    const intg = integrity(src)
    if (wf.length || intg.length) {
      natErrors++
      console.error('Natural base docx wf/intg error:', p.pmcid, { wf, intg })
    }
    const tg = targets(p)
    for (const task of PAPERS.tasks) {
      natChecks++
      let start: D.Pkg | null = src
      if (task.archetype === 'pending_suggestion') start = D.humanTrackedChange(src, tg.res1.slice(0, 60), tg.res1Phrase, `${tg.res1Phrase} (intention-to-treat population)`, 'Dong Qian')
      if (task.archetype === 'open_comment_anchor') {
        start = D.humanComment(src, tg.methods.first.slice(0, 60), tg.methods.snippets[0], COMMENTS[0], 'Dong Qian', 0)
        start = start && D.humanComment(start, tg.methods.first.slice(0, 60), tg.methods.snippets[1], COMMENTS[1], 'Dong Qian', 1)
      }
      if (!start) { natErrors++; console.error('Natural start failed:', p.pmcid, task.archetype); continue }
      const ev = await evaluateNatural(task, p, src, start, check(task, p, src, start, {}, humanRevisionKept(start)), measure(task, p, src, start), emptyRefs)
      if (ev.collateral > 0 || ev.silent_changes > 0 || ev.file_problems.length > 0 || ev.format_lost.length > 0 || ev.human_lost.length > 0) {
        natErrors++
        console.error('Natural dry-run problem:', p.pmcid, task.archetype, ev)
      }
    }
  }
  console.log(`Natural dry-run: checked ${natChecks} (paper, task) pairs, errors = ${natErrors}`)
  process.exit(stressErrors + sessErrors + natErrors > 0 ? 1 : 0)
}

export const QUERY_1B =
  'TITLE:("esophageal" OR "lung cancer" OR "gastric cancer" OR "colorectal cancer" OR "breast cancer" OR "hepatocellular carcinoma" OR "chemoradiotherapy" OR "neoadjuvant") ' +
  'AND TITLE:("randomized" OR "randomised" OR "clinical trial" OR "phase" OR "cohort" OR "retrospective" OR "prospective") ' +
  'NOT TITLE:("meta-analysis" OR "systematic review" OR "protocol" OR "comment" OR "correction" OR "erratum") ' +
  'AND OPEN_ACCESS:y AND HAS_FT:y AND (LICENSE:"cc by" OR LICENSE:"cc0") sort_date:y'

async function getJson(url: string): Promise<any> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (res.ok) return await res.json()
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)))
  }
  throw new Error(`请求失败：${url}`)
}

async function getXml(pmcid: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${EPMC}/${pmcid}/fullTextXML`, { signal: AbortSignal.timeout(120_000) })
      if (res.ok) return await res.text()
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)))
  }
  throw new Error(`${pmcid} 全文 XML 下载失败`)
}

function classifyType(title: string, pubTypes: string[]): 'rct' | 'cohort' | null {
  const t = title.toLowerCase()
  const pts = pubTypes.map(x => x.toLowerCase())
  if (/\b(meta-analysis|systematic review|study protocol|protocol for|case report|comment|erratum|correction|letter|editorial|narrative review|scoping review)\b/i.test(t)) return null
  if (pts.some(p => /review|meta-analysis|case reports|clinical trial protocol|editorial|letter|comment|published erratum/.test(p))) return null
  if (/\b(randomi[sz]ed|clinical trial|phase\s*(i|ii|iii|1|2|3|1\/2|2\/3))\b/i.test(t) || pts.some(p => /randomized controlled trial|clinical trial/.test(p))) return 'rct'
  if (/\b(cohort|retrospective|prospective|propensity)\b/i.test(t)) return 'cohort'
  return null
}

interface CandidateLog {
  rank: number
  pmcid: string
  pmid: string | null
  pubYear: number
  firstPublicationDate: string
  journal: string
  license: string | null
  type: 'rct' | 'cohort' | null
  title: string
  status: 'selected' | 'skipped'
  reason?: string
  words?: number
  tables?: number
  refs?: number
  sessionReady?: boolean
  s2CorrectReady?: boolean
}

const corpus1a = new Set((JSON.parse(readFileSync(join(here, 'corpus.json'), 'utf8')) as Paper[]).map(p => p.pmcid))
const xmlDir = join(here, 'data', 'xml')
const mdDir = join(here, 'data', 'md')
const refsDir = join(here, 'data', 'refs')
const docxDir = join(here, 'data', 'docx')
mkdirSync(xmlDir, { recursive: true })
mkdirSync(mdDir, { recursive: true })
mkdirSync(refsDir, { recursive: true })
mkdirSync(docxDir, { recursive: true })

const searchUrl = `${EPMC}/search?query=${encodeURIComponent(QUERY_1B)}&format=json&resultType=core&pageSize=100`
const searchData = await getJson(searchUrl)
const results: any[] = searchData.resultList?.result ?? []
console.log(`Europe PMC 返回 ${results.length} 条候选（总命中 ${searchData.hitCount ?? '?'}）`)

const logs: CandidateLog[] = []
const selected: Paper[] = []
let sessionReadyCount = 0
let s2CorrectCount = 0
let rank = 0

for (const item of results) {
  if (selected.length >= 10) break
  const pmcid = String(item.pmcid ?? '').trim()
  if (!pmcid) continue
  rank++
  const rawTitle = String(item.title ?? '').replace(/<[^>]+>/g, '').replace(/\.$/, '').trim()
  const journal = String(item.journalInfo?.journal?.title ?? item.journalInfo?.journal?.medlineAbbreviation ?? '').trim()
  const firstPublicationDate = String(item.firstPublicationDate ?? '')
  const pubYear = Number(item.pubYear || firstPublicationDate.slice(0, 4) || 0)
  const license = item.license ? String(item.license).trim() : null
  const pubTypes: string[] = item.pubTypeList?.pubType ?? []
  const type = classifyType(rawTitle, pubTypes)

  const baseLog: Omit<CandidateLog, 'status'> = {
    rank, pmcid, pmid: item.pmid ? String(item.pmid) : null, pubYear, firstPublicationDate, journal, license, type, title: rawTitle,
  }

  if (corpus1a.has(pmcid)) {
    logs.push({ ...baseLog, status: 'skipped', reason: 'in_1a_corpus' })
    continue
  }
  if (!license || !ALLOWED.test(license)) {
    logs.push({ ...baseLog, status: 'skipped', reason: `license_not_allowed:${license}` })
    continue
  }
  if (!type) {
    logs.push({ ...baseLog, status: 'skipped', reason: `not_rct_or_cohort:${pubTypes.join('/')}` })
    continue
  }

  const xmlPath = join(xmlDir, `${pmcid}.xml`)
  const mdPath = join(mdDir, `${pmcid}.md`)
  const refsPath = join(refsDir, `${pmcid}.json`)
  const docxPath = join(docxDir, `${pmcid}.docx`)
  const hadXml = existsSync(xmlPath)

  const cleanup = () => {
    if (!hadXml && existsSync(xmlPath)) rmSync(xmlPath, { force: true })
    if (existsSync(mdPath)) rmSync(mdPath, { force: true })
    if (existsSync(refsPath)) rmSync(refsPath, { force: true })
    if (existsSync(docxPath)) rmSync(docxPath, { force: true })
  }

  try {
    const xml = hadXml ? readFileSync(xmlPath, 'utf8') : await getXml(pmcid)
    if (!hadXml) writeFileSync(xmlPath, xml)
    const r = convert(xml)
    writeFileSync(mdPath, r.markdown)
    writeFileSync(refsPath, JSON.stringify(r.refList, null, 1))
    const { docs, docId } = setup(r.markdown)
    const pkg = D.journalize(D.openDocx(docxFor(docs, docId).bytes), [], { percentItalic: false })
    writeFileSync(docxPath, D.saveDocx(pkg))

    const topic: PaperTopic = { pmcid, type, refs: r.refList }
    const view = r.markdown.split(/\n{2,}/).map((chunk, i) => (chunk.startsWith('|') ? `{#b${i}}\n${chunk}` : `{#b${i}} ${chunk}`)).join('\n')
    const bs = blocks(view)

    // 1. 四节齐全且各有正文段，讨论至少 3 段正文
    const introMd = section(bs, INTRO).filter(isPara)
    const methodsMd = section(bs, METHODS).filter(isPara)
    const resultsMd = section(bs, RESULTS).filter(isPara)
    const discMd = section(bs, DISCUSSION).filter(isPara)
    const introDocx = sectionProse(pkg, INTRO)
    const methodsDocx = sectionProse(pkg, METHODS)
    const resultsDocx = sectionProse(pkg, RESULTS)
    const discDocx = sectionProse(pkg, DISCUSSION)
    if (!introMd.length || !introDocx.length) { cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: 'missing_introduction_prose' }); continue }
    if (!methodsMd.length || !methodsDocx.length) { cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: 'missing_methods_prose' }); continue }
    if (!resultsMd.length || !resultsDocx.length) { cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: 'missing_results_prose' }); continue }
    if (discMd.length < 3 || discDocx.length < 3) { cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: `discussion_paras_lt_3:${Math.min(discMd.length, discDocx.length)}` }); continue }

    // 2. 方法部分含 patients
    const patientsMd = section(bs, METHODS).filter(b => b.level === 0).reduce((a, b) => a + (plain(b.raw).match(/\bpatients\b/g) ?? []).length, 0)
    const patientsDocx = sectionParas(pkg, METHODS).filter(p => D.headingLevel(p) === 0).reduce((a, p) => a + (p.text.match(/\bpatients\b/g) ?? []).length, 0)
    if (patientsMd === 0 || patientsDocx === 0) { cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: 'no_patients_in_methods' }); continue }

    // 3. 至少一张带 Table 1 题注的表，且 firstTable 成功
    if (r.tables < 1 || !D.paras(D.docXml(pkg)).some(p => /^Table 1\b/.test(p.text))) {
      cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: 'missing_table_1_caption' }); continue
    }
    const ft = firstTable(topic)
    if (!ft.row) { cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: 'firstTable_no_row' }); continue }

    // 4. 日常任务前提检查（targets、movable、citeRef、p_value_format、pending_suggestion、open_comment_anchor、concurrent_edit）
    const tg = targets(topic)
    const mv = movable(topic)
    const res0 = section(bs, RESULTS)
    const mvAlreadyLast = mv.kind === 'sub'
      ? res0.filter(b => b.level === 3).at(-1)?.text === mv.title
      : plain(res0.filter(isPara).at(-1)?.raw ?? '').startsWith(mv.lead)
    if (mvAlreadyLast) { cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: 'movable_already_last' }); continue }

    const cr = citeRef(topic)
    if (!cr?.title) { cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: 'no_usable_reference' }); continue }

    const pvMd = resultsMd.flatMap(b => [...plain(b.raw).matchAll(P_VALUE)].map(m => m[0]))
    const goodRe = pTarget(topic) === 'zero' ? P_GOOD : P_GOOD_NOZERO
    if (pvMd.length === 0 || pvMd.every(x => goodRe.test(x))) {
      cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: `p_value_format_trivial:${pvMd.length}` }); continue
    }

    const trackedStart = D.humanTrackedChange(pkg, tg.res1.slice(0, 60), tg.res1Phrase, `${tg.res1Phrase} (intention-to-treat population)`, 'Dong Qian')
    let commentStart = D.humanComment(pkg, tg.methods.first.slice(0, 60), tg.methods.snippets[0], COMMENTS[0], 'Dong Qian', 0)
    commentStart = commentStart && D.humanComment(commentStart, tg.methods.first.slice(0, 60), tg.methods.snippets[1], COMMENTS[1], 'Dong Qian', 1)
    const concStart = D.humanReplace(pkg, tg.disc1.slice(0, 60), tg.discAnchor, `${tg.discAnchor} (see Supplementary Table S2)`)
    if (!trackedStart || !commentStart || !concStart) {
      cleanup(); logs.push({ ...baseLog, status: 'skipped', reason: 'natural_human_injection_failed' }); continue
    }

    // 5. 模板与会话、S2-correct 可用性检查（确保 10 篇中至少 8 篇满足 sessionReady）
    let isSessionReady = false
    try {
      complexTemplate(pkg)
      isSessionReady = sessionReady(topic) !== null
    } catch {
      isSessionReady = false
    }
    let isS2CorrectReady = false
    try {
      const pctx = plainCtx(topic)
      isS2CorrectReady = numberEditIn(firstThree(pctx)[1]!, pctx.source, true) !== null
    } catch {
      isS2CorrectReady = false
    }

    // 若剩余名额不足以凑够 8 篇 sessionReady 或 3 篇 S2-correct，则要求当前候选必须满足相应条件
    const remainingSlots = 10 - selected.length
    const neededSessionReady = Math.max(0, 8 - sessionReadyCount)
    const neededS2Correct = Math.max(0, 3 - s2CorrectCount)
    if (!isSessionReady && remainingSlots <= neededSessionReady) {
      cleanup()
      logs.push({ ...baseLog, status: 'skipped', reason: 'need_session_ready_for_8_of_10_quota', words: r.words, tables: r.tables, refs: r.refs, sessionReady: false, s2CorrectReady: isS2CorrectReady })
      continue
    }
    if (!isS2CorrectReady && remainingSlots <= neededS2Correct) {
      cleanup()
      logs.push({ ...baseLog, status: 'skipped', reason: 'need_s2_correct_for_3_of_10_quota', words: r.words, tables: r.tables, refs: r.refs, sessionReady: isSessionReady, s2CorrectReady: false })
      continue
    }
    if (!isSessionReady && !isS2CorrectReady && remainingSlots <= neededSessionReady + neededS2Correct) {
      cleanup()
      logs.push({ ...baseLog, status: 'skipped', reason: 'need_session_or_s2_correct_quota', words: r.words, tables: r.tables, refs: r.refs, sessionReady: false, s2CorrectReady: false })
      continue
    }

    if (isSessionReady) sessionReadyCount++
    if (isS2CorrectReady) s2CorrectCount++
    const split: Paper['split'] = selected.length < 7 ? 'train' : 'heldout'
    selected.push({
      pmcid,
      type,
      split,
      title: rawTitle,
      journal,
      year: pubYear,
      license,
      attribution: `${rawTitle}. ${journal}, ${pubYear}. ${pmcid}. Licensed under ${license.toUpperCase()}; adapted for a manuscript-revision benchmark.`,
    })
    logs.push({
      ...baseLog,
      status: 'selected',
      words: r.words,
      tables: r.tables,
      refs: r.refs,
      sessionReady: isSessionReady,
      s2CorrectReady: isS2CorrectReady,
    })
    console.log(`✓ [${selected.length}/10] ${pmcid} (${type}/${split}, ${pubYear}, sessionReady=${isSessionReady}, s2Correct=${isS2CorrectReady}) · ${ r.words } 词 ${ r.tables } 表 ${ r.refs } 引文 · ${rawTitle.slice(0, 65)}`)
  } catch (err) {
    cleanup()
    logs.push({ ...baseLog, status: 'skipped', reason: `exception:${String((err as Error).message ?? err).slice(0, 120)}` })
  }
}

if (selected.length < 10) {
  throw new Error(`只选出 ${selected.length} 篇论文，不足 10 篇`)
}

const keepIds = new Set([...corpus1a, ...selected.map(p => p.pmcid)])
for (const dir of [xmlDir, mdDir, refsDir, docxDir]) {
  for (const f of readdirSync(dir)) {
    const id = f.replace(/\.(xml|md|json|docx)$/, '')
    if (!keepIds.has(id)) rmSync(join(dir, f), { force: true })
  }
}

writeFileSync(join(here, 'corpus-1b.json'), JSON.stringify(selected, null, 2) + '\n')
writeFileSync(join(here, 'corpus-1b-selection.json'), JSON.stringify({
  selected_at: new Date().toISOString(),
  query: QUERY_1B,
  examined_count: logs.length,
  selected_count: selected.length,
  session_ready_count: sessionReadyCount,
  s2_correct_count: s2CorrectCount,
  candidates: logs,
}, null, 2) + '\n')

console.log(`完成：检查 ${logs.length} 篇候选，入选 ${selected.length} 篇（sessionReady=${sessionReadyCount}/10, s2Correct=${s2CorrectCount}/10）→ corpus-1b.json, corpus-1b-selection.json`)
