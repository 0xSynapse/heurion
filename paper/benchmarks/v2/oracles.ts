/**
 * v2 主要终点「本回合是否需要人工返工」（ANALYSIS_PLAN_v2 §2.3）的综合判定，平台组与脚本组共用，只看改完的 .docx：
 * 1 任务未完成；2 非目标段落内容被改动；3 被修改段落丢失原有格式；4 医生内容丢失（并发插入的文字、合作者的
 * 修订与批注、待采纳修订）；5 新增引用不存在或与编号不符，或正文出现未登记的裸 DOI / PMID；
 * 6 新增引用不支持所引的句子（评判模型读 PubMed 摘要判定），或正文没有引用它；
 * 7 没让改的块文字没变、规范化 XML 却变了（悄悄改了格式或结构）；8 文件新出现结构问题或 LibreOffice 打不开。
 * 4、5、6、裸编号与文件损坏（打不开、XML 坏、引用指向不存在）为严重，其余（含 ID 重复、标记不成对）为一般。S1 稿件另查模板特征。
 */
import type { Task } from '../exp3/tasks.ts'
import * as D from '../exp3/docx.ts'
import { measureTarget, type Checks } from '../manuscripts/compare.ts'
import { firstTable, type PaperTopic } from '../manuscripts/tasks.ts'
import { bodyChildrenRaw } from '../../../apps/platform/src/convert/docx-import.ts'
import { canonical, integrity, opensAsync, wellFormed } from './fidelity/check.ts'
import { checkReferences, splitParts } from './refcheck/refcheck.ts'
import { checkSupport, type SupportDetail } from './refcheck/support.ts'
import { citeless, CLINICIAN_SENTENCE, matchPara, RECENT_YEAR, type StressCtx, type StressTask } from './stress.ts'
import { featureState } from './templates.ts'

export interface RefSummary {
  added: number; verified: number; mismatched: number; fabricated: number; raw_ids_in_body: number; citation_markers_added: number
  /** 核实且记录出版年 ≥ RECENT_YEAR 的新增文献数（S3-recent 的完成标准）。 */
  verified_recent: number
  /** 新增且核实存在的文献的支持度（refcheck/support.ts，评判模型 deepseek-flash）。 */
  supported: number; partial: number; not_supported: number; uncited: number; no_abstract: number; unjudged: number
  support: SupportDetail[]
}

export interface Rework {
  rework: boolean
  /** 满足的返工条件（为空 = 不需要返工）。 */
  reasons: string[]
  done: boolean
  detail: string
  untouched: number
  collateral: number
  format_lost: string[]
  human_lost: string[]
  features_lost: string[]
  refs: RefSummary
  /** 没让改的块：文字没变、规范化 XML 却变了（格式或结构被悄悄改动）的个数。 */
  silent_changes: number
  /** 文件本身的问题（原稿没有、改完才有）：XML 不完整、引用 id 对不上、LibreOffice 打不开。 */
  file_problems: string[]
  /** none / moderate / severe：丢医生或合作者内容、引用有问题、文件损坏为严重，其余为一般。 */
  severity: 'none' | 'moderate' | 'severe'
}

const lead = (s: string) => s.slice(0, 60)

/** 不该动的段落里内容被改动的个数（排除目标段；S3 另排除参考文献表；统一忽略方括号引用编号变化）。 */
function collateral(source: D.Pkg, after: D.Pkg, targets: string[], references: boolean): { untouched: number; changed: number } {
  const ps = D.paras(D.docXml(source))
  const refAt = ps.findIndex(p => D.headingLevel(p) > 0 && /^(References|参考文献)\s*$/.test(p.text.trim()))
  const keep = ps.filter((p, i) => p.text.trim() !== '' && !targets.some(t => citeless(p.text).startsWith(citeless(lead(t)))) && !(references && refAt >= 0 && i > refAt))
  const now = new Set(D.paras(D.docXml(after)).map(p => citeless(p.text)))
  return { untouched: keep.length, changed: keep.filter(p => !now.has(citeless(p.text))).length }
}

/**
 * 被修改段落丢失的格式（段落 ID、版式、字体字号、强调）。对应段落先按段落 ID 找，再按表号（表题）或字符重合度
 * （v1 的 formatKept 只按重合度找，短段落如表题会被长段落「覆盖」而找错）；找不到对应段落时由完成判定负责。
 */
function formatLost(source: D.Pkg, after: D.Pkg, target: string | null): string[] {
  if (!target) return []
  const src = D.paras(D.docXml(source)).find(p => p.text.startsWith(lead(target)))
  if (!src) return []
  const table = /^Table\s*(\d+)\b/.exec(src.text)
  const id = /w14:paraId="([0-9A-F]+)"/.exec(src.xml)?.[1]
  // 段落 ID 还在就是同一段（改写后的段落与相邻段落文字重合度可能更高，按重合度会找错）
  const now = (id ? D.paras(D.docXml(after)).find(p => p.xml.includes(`w14:paraId="${id}"`)) : undefined)
    ?? (table ? D.paras(D.docXml(after)).find(p => new RegExp(`^Table\\s*${table[1]}\\b`).test(p.text)) : matchPara(after, src.text))
  if (!now) return []
  const runs = (xml: string) => [...xml.matchAll(/<w:r\b[^>]*>((?:(?!<\/w:r>)[\s\S])*)<\/w:r>/g)].map(m => m[1]!).filter(r => /<w:t\b/.test(r))
  const layout = (xml: string) => /<w:spacing w:line="480"/.test(xml) && /<w:jc w:val="both"\/>/.test(xml)
  const fonts = (xml: string) => runs(xml).every(r => /w:ascii="Times New Roman"/.test(r) && /<w:sz w:val="24"\/>/.test(r))
  const marked = (xml: string, tag: RegExp) => runs(xml).filter(r => tag.test(r)).length
  const lost: string[] = []
  if (id && !now.xml.includes(`w14:paraId="${id}"`)) lost.push('para_id')
  if (layout(src.xml) && !layout(now.xml)) lost.push('layout')
  if (fonts(src.xml) && !fonts(now.xml)) lost.push('fonts')
  // 原段落有加粗 / 斜体时至少保留一处（改写后的文字不要求同样多）
  if ((marked(src.xml, /<w:b\/>/) > 0 && marked(now.xml, /<w:b\/>/) === 0) || (marked(src.xml, /<w:i\/>/) > 0 && marked(now.xml, /<w:i\/>/) === 0)) lost.push('emphasis')
  return lost
}

async function refs(source: D.Pkg, after: D.Pkg): Promise<RefSummary> {
  const r = await checkReferences(source, after)
  const raw = r.raw_ids_in_body as unknown
  const recent = r.details.filter(d => d.status === 'verified' && (d.matched_year ?? 0) >= RECENT_YEAR).length
  const a = splitParts(source)
  const b = splitParts(after)
  const support = await checkSupport(r.details, b.refs, b.body, a.body)
  const n = (k: SupportDetail['support']) => support.filter(x => x.support === k).length
  return {
    added: r.added, verified: r.verified, mismatched: r.mismatched, fabricated: r.fabricated, raw_ids_in_body: Array.isArray(raw) ? raw.length : Number(raw) || 0, citation_markers_added: r.citation_markers_added, verified_recent: recent,
    supported: n('supported'), partial: n('partial'), not_supported: n('not_supported'), uncited: n('uncited'), no_abstract: n('no_abstract'), unjudged: n('unjudged'), support,
  }
}

function finish(x: Omit<Rework, 'rework' | 'reasons' | 'severity'>): Rework {
  const reasons: string[] = []
  if (!x.done) reasons.push('task_not_done')
  if (x.collateral > 0) reasons.push('collateral_change')
  if (x.format_lost.length > 0) reasons.push('format_lost')
  if (x.human_lost.length > 0) reasons.push('human_content_lost')
  if (x.features_lost.length > 0) reasons.push('template_feature_lost')
  if (x.refs.fabricated + x.refs.mismatched > 0) reasons.push('bad_reference')
  // 新增文献不支持所引的句子，或正文里没有引用它（部分支持不算返工，单独报告）
  if (x.refs.not_supported + x.refs.uncited > 0) reasons.push('unsupported_reference')
  if (x.refs.raw_ids_in_body > 0) reasons.push('raw_id_in_body')
  if (x.silent_changes > 0) reasons.push('silent_change')
  // 文件问题分两级：打不开、XML 坏了、引用指向不存在的部件为严重；ID 重复、标记不成对为一般（Word 通常能自动修复）
  const fatal = (p: string) => /LibreOffice|\.(xml|rels): |不存在的关系|不存在的部件|没有正文|没有条目|没有内容类型/.test(p)
  if (x.file_problems.some(fatal)) reasons.push('file_invalid')
  else if (x.file_problems.length > 0) reasons.push('file_inconsistent')
  const SEVERE = ['human_content_lost', 'bad_reference', 'unsupported_reference', 'raw_id_in_body', 'file_invalid']
  const severity = reasons.some(r => SEVERE.includes(r)) ? 'severe' : reasons.length > 0 ? 'moderate' : 'none'
  return { ...x, rework: reasons.length > 0, reasons, severity }
}

/**
 * 通用完整性（三组同一标准）：没让改的顶层块按规范化 XML 比较（文字没变而 XML 变了 = 悄悄改了格式或结构；
 * 文字变了的由附带损伤负责）；文件新出现的结构问题与 LibreOffice 能否打开。exclude：本任务允许改的块（按块的文字判断）。
 */
async function generic(source: D.Pkg, after: D.Pkg, exclude: (text: string, index: number) => boolean): Promise<{ silent: number; problems: string[] }> {
  const blockText = (xml: string) => D.paras(xml).map(p => p.text).join('\n')
  const src = bodyChildrenRaw(D.docXml(source)).filter(b => !/^<w:sectPr\b/.test(b))
  const out = bodyChildrenRaw(D.docXml(after))
  const outCanon = new Set(out.map(canonical))
  const outTexts = new Set(out.map(blockText))
  let silent = 0
  src.forEach((b, i) => {
    const t = blockText(b)
    if (!t.trim() || exclude(t, i)) return
    if (!outCanon.has(canonical(b)) && outTexts.has(t)) silent++
  })
  const before = new Set([...wellFormed(source), ...integrity(source)])
  const problems = [...wellFormed(after), ...integrity(after)].filter(x => !before.has(x))
  // LibreOffice 转出的纯文本里至少有 200 个字母（正文读得出来）
  const office = await opensAsync(after, /(?:\p{L}[^\p{L}]{0,3}){200}/u)
  if (office) problems.push(office)
  return { silent, problems }
}

/** 压力任务。 */
/**
 * keep：医生此前的修改（多轮会话），其标志文字在改完的稿件里出现次数不能比改前少。
 * injected：本轮进行中医生的修改是否真的写进去了（AI 一次都没读稿时注入不会触发，此时不查）。
 */
export async function evaluateStress(task: StressTask, ctx: StressCtx, after: D.Pkg, keep: Array<{ label: string; expect: string }> = [], injected: boolean | null = null, savedRefs?: RefSummary): Promise<Rework> {
  const r = savedRefs ?? await refs(ctx.source, after)
  const d = task.check(ctx, after)
  // S3 的完成标准：新增了参考文献，正文也标注了引用；S3-recent 另要求至少 2 条核实为 RECENT_YEAR 年及以后发表
  const recentShort = task.id === 'S3-recent' && r.verified_recent < 2
  const done = task.kind === 'S3' ? r.added >= 1 && r.citation_markers_added >= 1 && !recentShort : d.done
  const detail = task.kind === 'S3' ? (done ? '' : r.added === 0 ? '没有新增参考文献' : r.citation_markers_added === 0 ? '正文没有标注新引用' : `核实为 ${RECENT_YEAR} 年及以后发表的只有 ${r.verified_recent} 条`) : d.detail
  const c = collateral(ctx.source, after, task.targets(ctx), task.kind === 'S3')
  const human: string[] = []
  const features: string[] = []
  // S2：医生的改动（补的一句或改的数字）仍在——出现次数比原稿多
  const cc = injected === false ? null : task.concurrent?.(ctx)
  if (cc) {
    const count = (pkg: D.Pkg) => D.paras(D.docXml(pkg)).map(p => p.text).join('\n').split(cc.expect).length - 1
    if (count(after) <= count(ctx.source)) human.push('concurrent_edit_lost')
  }
  const occurrences = (pkg: D.Pkg, x: string) => D.paras(D.docXml(pkg)).map(p => p.text).join('\n').split(x).length - 1
  for (const k of keep) if (occurrences(after, k.expect) < occurrences(ctx.source, k.expect)) human.push(`doctor_edit_lost:${k.label}`)
  if (ctx.features) {
    // 只计本轮造成的损失：改前还在、改后没了（多轮会话里前几轮丢的不重复计）
    const was = featureState(ctx.source, ctx.features)
    const st = featureState(after, ctx.features)
    if (was.tracked_kept && !st.tracked_kept) human.push('coauthor_tracked_change')
    if (was.comment_kept && !st.comment_kept) human.push('coauthor_comment')
    for (const k of ['list_numbered', 'table_merged', 'caption_fields', 'footnote_kept', 'section_break_kept'] as const) if (was[k] && !st[k]) features.push(k)
  }
  const leads = task.targets(ctx).map(lead)
  const blocks = bodyChildrenRaw(D.docXml(ctx.source))
  const refAt = blocks.findIndex(b => D.paras(b).some(p => D.headingLevel(p) > 0 && /^(References|参考文献)\s*$/.test(p.text.trim())))
  const g = await generic(ctx.source, after, (t, i) => leads.some(l => t.includes(l)) || (task.kind === 'S3' && refAt >= 0 && i >= refAt))
  return finish({ done, detail, untouched: c.untouched, collateral: c.changed, format_lost: formatLost(ctx.source, after, task.formatTarget(ctx)), human_lost: human, features_lost: features, refs: r, silent_changes: g.silent, file_problems: g.problems })
}

/** 日常任务（v1 的 9 类任务）：沿用 v1 的完成判定与内容改动度量（manuscripts/compare.ts），格式按上面的 formatLost，再加引用核对。 */
export async function evaluateNatural(task: Task<PaperTopic>, paper: PaperTopic, source: D.Pkg, after: D.Pkg, checks: Checks, measured: { damage: D.Damage }, savedRefs?: RefSummary): Promise<Rework> {
  const r = savedRefs ?? await refs(source, after)
  // 格式：与压力任务同一套找段方法（先按段落 ID），不用 v1 只按重合度找段的 formatKept
  const formatLostKeys = formatLost(source, after, measureTarget(task, paper) ?? null)
  const target = measureTarget(task, paper)
  const sectionWide = ['term_unify', 'p_value_format', 'move_subsection', 'table_row', 'citation'].includes(task.archetype)
  const g = await generic(source, after, t => sectionWide || (!!target && t.includes(lead(target))) || /^(References|参考文献)/.test(t.trim()))
  const table = task.archetype === 'table_row' ? firstTable(paper) : null
  const done = table ? tableRowDone(after, table.row, table.newRow) : checks.done
  return finish({
    done, detail: table && !done ? '新行没有加在指定行（或其分组）之后' : checks.detail,
    untouched: measured.damage.untouched, collateral: measured.damage.content_changed,
    format_lost: formatLostKeys, human_lost: checks.human_kept === false ? ['clinician_content'] : [], features_lost: [],
    refs: { ...r, raw_ids_in_body: Math.max(r.raw_ids_in_body, checks.raw_id_added ? 1 : 0) },
    silent_changes: g.silent, file_problems: g.problems,
  })
}

/**
 * 医生的待采纳修订是否还在（各组同一标准，只看 .docx）：新增的文字仍以 Word 修订（w:ins）存在。
 * v1 平台组看数据库里是否还有待采纳修订、脚本组看文件里是否有任意修订，都会放过「修订版被改成普通正文」
 * 或「医生加的文字被 AI 改没了」的情况（v2 预实验发现）。
 */
export const HUMAN_REVISION_TEXT = 'intention-to-treat population'
export const humanRevisionKept = (after: D.Pkg): boolean =>
  [...D.docXml(after).matchAll(/<w:ins\b[^>]*>((?:(?!<\/w:ins>)[\s\S])*)<\/w:ins>/g)].map(m => m[1]!).join('').includes(HUMAN_REVISION_TEXT)

/**
 * 表格加行是否完成。v1 要求新行紧跟在指定行之后；指定行是带子行的分组行（如 Age 下分 ≤ 60 / > 60）时，
 * 插在整组之后同样正确（v2 预实验三组都这样插，v1 判为未完成）。这里接受：新行在指定行之后 40 格以内，
 * 新行名之后到下一个有内容的格之前全是 NR 或空格，且至少 2 个 NR。
 */
export function tableRowDone(after: D.Pkg, row: string, newRow: string): boolean {
  const ps = D.paras(D.docXml(after)).map(p => p.text.trim())
  const i = ps.indexOf(row)
  const k = ps.indexOf(newRow, i + 1)
  if (i < 0 || k < 0 || k - i > 40) return false
  let nr = 0
  for (let j = k + 1; j < ps.length && (ps[j] === 'NR' || ps[j] === ''); j++) if (ps[j] === 'NR') nr++
  return nr >= 2
}

export { CLINICIAN_SENTENCE }
