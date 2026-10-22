/**
 * v2 压力任务（ANALYSIS_PLAN_v2 §2.2，预实验后按变更记录改版）：平台组与两个脚本组共用的任务定义。
 * 指令按医生的日常说法写，不提示要保留什么（合作者修订、脚注、批注、医生刚加的内容）——这些由判定检查，
 * 考的是没说出口的约束（第四次预实验后改，见变更记录）。
 * - S1 复杂期刊模板（templates.ts 生成）上的结构性操作：在有合作者修订的段落里改写别的句子、合并带脚注与批注的段落、
 *   移动带批注的段落、删除表头有合并单元格的表格的一列；
 * - S2 真实并发修改：要求改写讨论部分前三段；AI 第一次读稿后，医生在其中一段补一句或改一个数字；
 * - S3 文献补充：要求补充真实的支持文献，其中一类要求 2025 年及以后发表。
 * 每个任务给出：起始稿件、指令（中文）、目标段落（不计入附带损伤）、可选的并发注入、完成判定。
 * 任务与判定在预实验之前写定（计划 §2.2），文字全部来自 CC BY 原文或下列固定句子，不含患者信息。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as D from '../exp3/docx.ts'
import { PAPERS, type PaperTopic } from '../manuscripts/tasks.ts'
import { COAUTHOR, COAUTHOR_COMMENT, complexTemplate, type TemplateFeatures } from './templates.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

export interface StressCtx {
  paper: PaperTopic
  /** 两组共同的起始稿件。 */
  source: D.Pkg
  /** S1：模板里各特征的位置。 */
  features: TemplateFeatures | null
}

export interface Concurrent {
  /** 医生修改的段落开头（定位用）。 */
  para: string
  /** 同一个 run 里的一段原文，换成 replace。 */
  find: string
  replace: string
  /** 医生改动的标志性文字（判定用：改完的稿件里出现次数比原稿多才算保留；补的句子允许被 AI 并入改写，只看标志）。 */
  expect: string
}

export interface Done { done: boolean; detail: string }

export interface StressTask {
  kind: 'S1' | 'S2' | 'S3'
  id: string
  /** 起始稿件（S1 为复杂模板）。 */
  build(paper: PaperTopic): StressCtx
  message(ctx: StressCtx): string
  /** 本任务要改的段落（首句前缀），计算附带损伤时排除；S1 表格任务另排除整张表。 */
  targets(ctx: StressCtx): string[]
  /** 主要改写的段落（度量其格式保留）；没有单一目标段时为 null。 */
  formatTarget(ctx: StressCtx): string | null
  concurrent?(ctx: StressCtx): Concurrent
  check(ctx: StressCtx, after: D.Pkg): Done
}

// —— 稿件与段落 ——

export const sourceDocx = (t: PaperTopic): D.Pkg => D.openDocx(new Uint8Array(readFileSync(join(here, '../manuscripts/data/docx', `${t.pmcid}.docx`))))
export const plainCtx = (t: PaperTopic): StressCtx => ({ paper: t, source: sourceDocx(t), features: null })
export const templateCtx = (t: PaperTopic): StressCtx => {
  const { pkg, features } = complexTemplate(sourceDocx(t))
  return { paper: t, source: pkg, features }
}

/** 一节（二级标题匹配 title）里的正文段落。 */
export function sectionProse(pkg: D.Pkg, title: RegExp): D.Para[] {
  const ps = D.paras(D.docXml(pkg))
  const i = ps.findIndex(p => D.headingLevel(p) === 2 && title.test(p.text.trim()))
  if (i < 0) return []
  const j = ps.findIndex((p, k) => k > i && D.headingLevel(p) > 0 && D.headingLevel(p) <= 2)
  return ps.slice(i + 1, j < 0 ? undefined : j).filter(p => D.headingLevel(p) === 0 && !p.xml.includes('w:numPr') && p.text.length > 120 && !/^(Table|Figure|Fig\.?)\s*\d/.test(p.text) && !/^Abbreviations?\b/i.test(p.text))
}
export const DISCUSSION = /^discussion\b/i
export const INTRO = /^(introduction|background)\b/i

export const lead = (s: string) => s.slice(0, 60)
export const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
/** 忽略方括号引用编号变化（如 [3]、[2–4]、[[2], [5]–[7]]）：移动段落或插入引用后整体重新编号属正确行为。 */
export const citeless = (s: string) => s.replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, '[#]').replace(/\s+/g, ' ').trim()
export const firstSentence = (s: string) => /^.+?[.;](?=\s+[A-Z(]|$)/.exec(s)?.[0] ?? s
/** 改完的稿件里与源段落对应的段落：首句相同，或与源段落字符重合度最高（≥0.5）。 */
export function matchPara(after: D.Pkg, src: string): D.Para | undefined {
  const ps = D.paras(D.docXml(after))
  const same = ps.find(p => p.text.startsWith(lead(src)))
  if (same) return same
  const chars = new Set(src)
  let best: D.Para | undefined
  let score = 0
  for (const p of ps) {
    if (p.text.length < 40) continue
    const s = [...new Set(p.text)].filter(c => chars.has(c)).length / Math.max(chars.size, 1)
    if (s > score) { best = p; score = s }
  }
  return score >= 0.5 ? best : undefined
}
/** 段落最后一个文字 run 的末尾一段（医生在其后补一句）。 */
export function tailOf(p: D.Para): string {
  const runs = [...p.xml.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]!)
  const last = runs.at(-1) ?? ''
  return last.slice(-Math.min(20, last.length)).replace(/^\s+/, '')
}
/** 段落开头的前几个词（指令里用来指明段落）。 */
export const words = (s: string, n = 8) => s.split(/\s+/).slice(0, n).join(' ')
/** 段落在稿件中的位置（按开头找，找不到为 -1）。 */
const indexOf = (pkg: D.Pkg, start: string) => D.paras(D.docXml(pkg)).findIndex(p => norm(p.text).startsWith(norm(lead(start))))

// —— S1 复杂模板上的结构性操作 ——

/** S1 在模板上另需满足的前提（不满足的论文不排这个任务）。 */
function s1Ctx(t: PaperTopic, need: (ctx: StressCtx) => void): StressCtx {
  const ctx = templateCtx(t)
  need(ctx)
  return ctx
}
/** 讨论部分带脚注的段落 A 与紧随其后、带合作者批注的段落 B。 */
function pairOf(ctx: StressCtx): { a: string; b: string } {
  const f = ctx.features!
  const ia = indexOf(ctx.source, f.footnote.para)
  const ib = indexOf(ctx.source, f.comment.para)
  if (ia < 0 || ib !== ia + 1) throw new Error('带脚注的段落后面不是带批注的段落')
  const ps = D.paras(D.docXml(ctx.source))
  return { a: ps[ia]!.text, b: ps[ib]!.text }
}
/** 修订所在段落（原文，含合作者插入的文字）与它的第一句；修订不能落在第一句里。 */
export function trackedPara(ctx: StressCtx): { text: string; first: string } {
  const f = ctx.features!
  const p = D.paras(D.docXml(ctx.source)).find(x => x.xml.includes(`w:author="${COAUTHOR}"`) && /<w:del\b/.test(x.xml))
  if (!p) throw new Error('找不到合作者修订所在段落')
  const first = firstSentence(p.text)
  if (first.includes(f.tracked.ins) || first.length > p.text.length * 0.8) throw new Error('修订落在第一句里，或段落只有一句')
  return { text: p.text, first }
}
/** 合作者的修订仍在：同一段里删除的原文在 w:delText、插入的文字在 w:ins 里，作者不变。 */
export function coauthorRevisionKept(after: D.Pkg, f: TemplateFeatures): boolean {
  return D.paras(D.docXml(after)).some(p => {
    const del = [...p.xml.matchAll(/<w:del\b[^>]*w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:del>/g)].filter(m => m[1] === COAUTHOR).map(m => [...m[2]!.matchAll(/<w:delText\b[^>]*>([^<]*)</g)].map(x => x[1]).join('')).join('')
    const ins = [...p.xml.matchAll(/<w:ins\b[^>]*w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:ins>/g)].filter(m => m[1] === COAUTHOR).map(m => [...m[2]!.matchAll(/<w:t\b[^>]*>([^<]*)</g)].map(x => x[1]).join('')).join('')
    return del.includes(f.tracked.del) && ins.includes(f.tracked.ins)
  })
}

/** 表 1（模板里第一张表）：每行按 gridSpan 计的宽度、表格网格列数、最后一列表头文字。 */
export function tableShape(pkg: D.Pkg): { widths: number[]; grid: number; lastHeader: string } | null {
  const tbl = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(D.docXml(pkg))?.[0]
  if (!tbl) return null
  const rows = [...tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(m => m[0])
  const cells = (row: string) => [...row.matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map(m => m[0])
  const widths = rows.map(r => cells(r).reduce((n, c) => n + Number(/<w:gridSpan w:val="(\d+)"\/>/.exec(c)?.[1] ?? 1), 0))
  // 最后一列的表头：从原表头行（模板加的合并表头之下）往下找第一个有文字的最后一格（两行表头时第一行最后一格常为空）
  const lastText = (row: string) => { const cs = cells(row); return cs.length ? D.paras(cs.at(-1)!).map(p => p.text).join('').trim() : '' }
  const lastHeader = rows.slice(1, 4).map(lastText).find(Boolean) ?? ''
  return { widths, grid: (tbl.match(/<w:gridCol\b/g) ?? []).length, lastHeader }
}

const S1: StressTask[] = [
  {
    kind: 'S1', id: 'S1-tracked',
    build: t => s1Ctx(t, trackedPara),
    message: ctx => `把结果部分以「${words(trackedPara(ctx).text)}」开头那段的第一句改得更简洁一些。`,
    targets: ctx => [trackedPara(ctx).text],
    formatTarget: ctx => trackedPara(ctx).text,
    check(ctx, after) {
      const { text, first } = trackedPara(ctx)
      const now = matchPara(after, text)
      const changed = !!now && !norm(now.text).includes(norm(first))
      const kept = coauthorRevisionKept(after, ctx.features!)
      return { done: changed && kept, detail: changed ? (kept ? '' : `${COAUTHOR} 的修订没有原样保留`) : '第一句没有改写' }
    },
  },
  {
    kind: 'S1', id: 'S1-merge',
    build: t => s1Ctx(t, pairOf),
    message: ctx => { const { a, b } = pairOf(ctx); return `把讨论部分以「${words(a)}」开头的段落和下一段（以「${words(b)}」开头）合成一段。` },
    targets: ctx => { const { a, b } = pairOf(ctx); return [a, b] },
    // 合并后的段落沿用前一段或后一段的段落 ID 都合理（Word 里删掉段落标记后沿用后一段），不按单一目标段查格式
    formatTarget: () => null,
    check(ctx, after) {
      const { a, b } = pairOf(ctx)
      const ps = D.paras(D.docXml(after)).map(p => citeless(p.text))
      const merged = ps.find(x => x.startsWith(citeless(lead(a))))
      const tailOk = !!merged && merged.indexOf(citeless(lead(b))) > 0 && merged.endsWith(citeless(b).slice(-60))
      const separate = ps.some(x => x.startsWith(citeless(lead(b))))
      return { done: tailOk && !separate, detail: tailOk ? (separate ? '后一段仍单独存在' : '') : '两段没有合并成一段' }
    },
  },
  {
    kind: 'S1', id: 'S1-move',
    build: t => s1Ctx(t, pairOf),
    message: ctx => { const { a, b } = pairOf(ctx); return `把讨论部分以「${words(b)}」开头的那段挪到以「${words(a)}」开头的那段前面。` },
    targets: ctx => { const { a, b } = pairOf(ctx); return [a, b] },
    formatTarget: () => null,
    check(ctx, after) {
      const { a, b } = pairOf(ctx)
      const ps = D.paras(D.docXml(after)).map(p => citeless(p.text))
      const ia = ps.indexOf(citeless(a))
      const ib = ps.indexOf(citeless(b))
      const ok = ia >= 0 && ib >= 0 && ib < ia
      return { done: ok, detail: ok ? '' : ia < 0 || ib < 0 ? '段落文字被改动或丢失' : '顺序没有调换' }
    },
  },
  {
    kind: 'S1', id: 'S1-delcol',
    build: t => s1Ctx(t, ctx => { if (!tableShape(ctx.source)?.lastHeader) throw new Error('表 1 最后一列没有表头') }),
    message: ctx => `表 1 的最后一列（「${tableShape(ctx.source)!.lastHeader}」）不要了，删掉。`,
    targets: ctx => tableCells(ctx.source),
    formatTarget: () => null,
    check(ctx, after) {
      const before = tableShape(ctx.source)!
      const now = tableShape(after)
      if (!now) return { done: false, detail: '表格不见了' }
      const cols = Math.max(...before.widths) - 1
      const gone = now.lastHeader !== before.lastHeader
      const even = now.widths.every(w => w === cols) && now.grid === cols
      return { done: gone && even, detail: gone ? (even ? '' : `表格各行列数不一致（应为 ${cols}）：${now.widths.join(',')}，网格 ${now.grid}`) : '最后一列还在' }
    },
  },
]

export function tableCells(pkg: D.Pkg): string[] {
  const tbl = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(D.docXml(pkg))
  return tbl ? D.paras(tbl[0]).map(p => p.text).filter(Boolean) : []
}

// —— S2 真实并发修改 ——

export const CLINICIAN_SENTENCE = 'This finding was confirmed in the per-protocol sensitivity analysis (Supplementary Table S5).'

/** 讨论部分前三段（不足三段的论文不排 S2）。 */
export function firstThree(ctx: StressCtx): D.Para[] {
  const ps = sectionProse(ctx.source, DISCUSSION).slice(0, 3)
  if (ps.length < 3) throw new Error('讨论部分不足三段')
  return ps
}
const S2_MESSAGE = (ctx: StressCtx) => { const ps = firstThree(ctx); return `把讨论部分前三段（分别以「${words(ps[0]!.text)}」「${words(ps[1]!.text)}」「${words(ps[2]!.text)}」开头）改得更精炼一些。` }
/** 改写完成：三段里至少两段的原文不再原样存在。 */
function rewritten(ctx: StressCtx, after: D.Pkg, cc: Concurrent): Done {
  const now = new Set(D.paras(D.docXml(after)).map(p => norm(p.text.replace(cc.replace, cc.find))))
  const changed = firstThree(ctx).filter(p => !now.has(norm(p.text))).length
  return { done: changed >= 2, detail: changed >= 2 ? '' : `只改写了 ${changed} 段` }
}
/** 医生改的数字：段落里第一个全文只出现一次的带小数的数（uniqueOnly=false 时不限次数，供 1a 离线重算兼容），末位加 1。 */
export function numberEditIn(p: D.Para, pkg: D.Pkg, uniqueOnly = true): Concurrent | null {
  const body = D.paras(D.docXml(pkg)).map(x => x.text).join('\n')
  const countNum = (num: string) => [...body.matchAll(new RegExp(`(?<![\\d.])${num.replace('.', '\\.')}(?![\\d.])`, 'g'))].length
  for (const t of [...p.xml.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]!)) {
    for (const m of t.matchAll(/(?<![\d.])\d+\.\d+%?/g)) {
      const token = m[0]
      const digits = token.replace('%', '')
      if (uniqueOnly && countNum(digits) !== 1) continue
      const bumped = digits.slice(0, -1) + String((Number(digits.at(-1)) + 1) % 10) + (token.endsWith('%') ? '%' : '')
      if (body.includes(bumped) || (uniqueOnly && countNum(bumped.replace('%', '')) > 0)) continue
      const at = m.index!
      const find = t.slice(Math.max(0, at - 6), at + token.length)
      return { para: p.text, find, replace: find.slice(0, find.length - token.length) + bumped, expect: bumped }
    }
  }
  return null
}
const numberEdit = (ctx: StressCtx): Concurrent | null => numberEditIn(firstThree(ctx)[1]!, ctx.source)

const S2: StressTask[] = [
  {
    kind: 'S2', id: 'S2-append',
    build: t => { const ctx = plainCtx(t); firstThree(ctx); return ctx },
    message: S2_MESSAGE,
    targets: ctx => firstThree(ctx).map(p => p.text),
    formatTarget: ctx => firstThree(ctx)[2]!.text,
    concurrent: ctx => { const p = firstThree(ctx)[2]!; const tail = tailOf(p); return { para: p.text, find: tail, replace: `${tail} ${CLINICIAN_SENTENCE}`, expect: 'Supplementary Table S5' } },
    check(ctx, after) { return rewritten(ctx, after, this.concurrent!(ctx)) },
  },
  {
    kind: 'S2', id: 'S2-correct',
    build: t => { const ctx = plainCtx(t); if (!numberEdit(ctx)) throw new Error('第二段没有可改的小数'); return ctx },
    message: S2_MESSAGE,
    targets: ctx => firstThree(ctx).map(p => p.text),
    formatTarget: ctx => firstThree(ctx)[1]!.text,
    concurrent: ctx => numberEdit(ctx)!,
    check(ctx, after) { return rewritten(ctx, after, this.concurrent!(ctx)) },
  },
]

// —— S3 文献补充 ——

/** S3-recent 要求的最早出版年。 */
export const RECENT_YEAR = 2025

/** 三组同样的完成要求：引用须真实，且研究结果支持所在的句子（判定见 refcheck/support.ts）。 */
export const SUPPORT_REQUIREMENT = '每条引用都必须是真实存在的文献，并且其研究结果确实支持所在的句子（不能只是题目相关）。'

const S3: StressTask[] = [
  {
    kind: 'S3', id: 'S3-support',
    build: plainCtx,
    message: ctx => `讨论部分第二段的第一句「${firstSentence(sectionProse(ctx.source, DISCUSSION)[1]!.text)}」缺少文献支持，请补充 2–3 条真实的支持文献：正文标注引用，并加入参考文献表。${SUPPORT_REQUIREMENT}`,
    targets: ctx => [sectionProse(ctx.source, DISCUSSION)[1]!.text],
    formatTarget: ctx => sectionProse(ctx.source, DISCUSSION)[1]!.text,
    check: () => ({ done: true, detail: '' }),
  },
  {
    kind: 'S3', id: 'S3-update',
    build: plainCtx,
    message: () => `请用近 5 年发表的随机对照试验或荟萃分析证据，在讨论部分第二段末尾补充一句话，并加上相应引用（正文标注引用，并加入参考文献表）。${SUPPORT_REQUIREMENT}`,
    targets: ctx => [sectionProse(ctx.source, DISCUSSION)[1]!.text],
    formatTarget: ctx => sectionProse(ctx.source, DISCUSSION)[1]!.text,
    check: () => ({ done: true, detail: '' }),
  },
  {
    kind: 'S3', id: 'S3-recent',
    build: plainCtx,
    message: ctx => `讨论部分第一段的论述需要更新到最新进展：请在这一段末尾补充一句话，引用 2 条 ${RECENT_YEAR} 年及以后发表的相关研究（正文标注引用，并加入参考文献表）。${SUPPORT_REQUIREMENT}`,
    targets: ctx => [sectionProse(ctx.source, DISCUSSION)[0]!.text],
    formatTarget: ctx => sectionProse(ctx.source, DISCUSSION)[0]!.text,
    check: () => ({ done: true, detail: '' }),
  },
]

export const STRESS: StressTask[] = [...S1, ...S2, ...S3]
export { COAUTHOR_COMMENT }

/**
 * 压力任务的排程（改版后每组配对数：S1 4 类 × 4 = 16、S2 2 类 × 5 = 10、S3 3 类 × 5 = 15，每个种子 41 个，3 个种子 123 个）：
 * 种子 × 论文 × 任务，确定性轮转。每类任务只用满足其前提的论文（能生成复杂模板、讨论部分够三段、有可改的数字等）。
 */
export function stressSchedule(seeds: number[]): Array<{ seed: number; task: StressTask; paper: PaperTopic }> {
  const all = [...PAPERS.train, ...PAPERS.heldout]
  const eligible = (task: StressTask) => all.filter(t => { try { task.build(t); return true } catch { return false } })
  const out: Array<{ seed: number; task: StressTask; paper: PaperTopic }> = []
  const plan: Array<[StressTask[], number]> = [[S1, 4], [S2, 5], [S3, 5]]
  for (const [tasks, per] of plan) {
    tasks.forEach((task, ti) => {
      const ok = eligible(task)
      if (!ok.length) throw new Error(`没有论文满足 ${task.id} 的前提`)
      seeds.forEach((seed, si) => { for (let k = 0; k < per; k++) out.push({ seed, task, paper: ok[(si * per + ti * 2 + k) % ok.length]! }) })
    })
  }
  return out
}
