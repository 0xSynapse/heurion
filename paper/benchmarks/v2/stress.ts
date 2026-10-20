/**
 * v2 压力任务（ANALYSIS_PLAN_v2 §2.2）：平台组与两个脚本组共用的任务定义。
 * - S1 复杂期刊模板（templates.ts 生成）：在编号列表里加条目、表格加行、改表题、改带脚注的段落、按合作者批注改写并回复；
 * - S2 真实并发修改：AI 第一次读稿后，医生在 AI 要改写的段落末尾补一句；
 * - S3 文献补充：要求补充真实的支持文献。
 * 每个任务给出：起始稿件、指令（中文）、目标段落（不计入附带损伤）、可选的并发注入、完成判定。
 * 任务与判定在预实验之前写定（计划 §2.2），文字全部来自 CC BY 原文或下列固定句子，不含患者信息。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8 } from '../../../apps/platform/node_modules/fflate/esm/browser.js'
import * as D from '../exp3/docx.ts'
import { firstTable, PAPERS, type PaperTopic } from '../manuscripts/tasks.ts'
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
  /** 医生插入内容所在段落的首句（定位用）。 */
  para: string
  /** 段落末尾、落在同一个 run 里的一段原文（插在它后面）。 */
  tail: string
  sentence: string
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
const plainCtx = (t: PaperTopic): StressCtx => ({ paper: t, source: sourceDocx(t), features: null })
const templateCtx = (t: PaperTopic): StressCtx => {
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

const lead = (s: string) => s.slice(0, 60)
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const firstSentence = (s: string) => /^.+?[.;](?=\s+[A-Z(]|$)/.exec(s)?.[0] ?? s
const texts = (pkg: D.Pkg) => D.paras(D.docXml(pkg)).map(p => p.text)
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
function tailOf(p: D.Para): string {
  const runs = [...p.xml.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)].map(m => m[1]!)
  const last = runs.at(-1) ?? ''
  return last.slice(-Math.min(20, last.length)).replace(/^\s+/, '')
}
const commentsXml = (pkg: D.Pkg) => (pkg['word/comments.xml'] ? strFromU8(pkg['word/comments.xml']) : '')
/** 正文里有引用标记（Word 里看得到）的批注 id。没有 commentReference 的批注 Word 不显示。 */
const visibleComments = (pkg: D.Pkg) => {
  const referenced = new Set([...D.docXml(pkg).matchAll(/<w:commentReference\b[^>]*w:id="(\d+)"/g)].map(m => m[1]!))
  return [...commentsXml(pkg).matchAll(/<w:comment\b[^>]*w:id="(\d+)"/g)].map(m => m[1]!).filter(id => referenced.has(id))
}

// —— S1 复杂模板 ——

const NEW_ITEM = 'All analyses followed the prespecified statistical analysis plan.'
const NEW_CAPTION = 'Baseline characteristics of the study participants'

const S1: StressTask[] = [
  {
    kind: 'S1', id: 'S1-list',
    build: templateCtx,
    message: () => `在方法部分的编号列表里，在第 2 条之后新增一条：「${NEW_ITEM}」。其余条目不要改。`,
    targets: ctx => ctx.features!.list.items,
    formatTarget: () => null,
    check(ctx, after) {
      const items = ctx.features!.list.items
      const ps = D.paras(D.docXml(after))
      const at = ps.findIndex(p => p.text.startsWith(lead(items[1]!)))
      const next = ps[at + 1]
      const numId = (p: D.Para | undefined) => /<w:numId w:val="(\d+)"\/>/.exec(p?.xml ?? '')?.[1] ?? null
      if (at < 0 || !next) return { done: false, detail: '找不到原列表第 2 条' }
      const inserted = norm(next.text).includes(NEW_ITEM.slice(0, 40))
      const sameList = numId(next) !== null && numId(next) === numId(ps[at])
      const rest = items.slice(2).every(s => texts(after).some(x => x.startsWith(lead(s))))
      return { done: inserted && sameList && rest, detail: inserted ? (sameList ? (rest ? '' : '后面的条目丢了') : '新条目不在同一个编号列表里（编号会断）') : '第 2 条之后不是新条目' }
    },
  },
  {
    kind: 'S1', id: 'S1-table',
    build: templateCtx,
    message: ctx => { const x = firstTable(ctx.paper); return `在 ${x.label} 中「${x.row}」那一行下面插入一行「${x.newRow}」，其余各列填 NR。表头的合并单元格保持不变。` },
    // 表格单元格逐格是段落：整张表不计入附带损伤（与 v1 表格任务一致）
    targets: ctx => tableCells(ctx.source),
    formatTarget: () => null,
    check(ctx, after) {
      const { row, newRow } = firstTable(ctx.paper)
      const ps = texts(after).map(x => x.trim())
      const i = ps.indexOf(row)
      const width = ps.slice(i + 1).findIndex(x => x === newRow) + 1
      const ok = i >= 0 && width > 0 && width <= 12 && ps.slice(i + width + 1, i + width * 2).every(x => x === 'NR')
      return { done: ok, detail: ok ? '' : '新行没有按要求插在指定位置' }
    },
  },
  {
    kind: 'S1', id: 'S1-caption',
    build: templateCtx,
    message: () => `把表 1 的标题改为「${NEW_CAPTION}」，表号不变。`,
    targets: ctx => [ctx.features!.captions[0]!],
    formatTarget: ctx => ctx.features!.captions[0]!,
    check(_ctx, after) {
      const cap = D.paras(D.docXml(after)).find(p => /^Table\s*1\b/.test(p.text))
      const ok = !!cap && norm(cap.text).includes(NEW_CAPTION)
      return { done: ok, detail: ok ? '' : '表 1 的标题没有改成要求的文字' }
    },
  },
  {
    kind: 'S1', id: 'S1-footnote',
    build: templateCtx,
    message: () => '把讨论部分第二段的第一句改写得更简洁明确；这一段的其余句子和脚注保持不变。',
    targets: ctx => [ctx.features!.footnote.para],
    formatTarget: ctx => ctx.features!.footnote.para,
    check(ctx, after) {
      const src = D.paras(D.docXml(ctx.source)).find(p => p.text.startsWith(lead(ctx.features!.footnote.para)))!
      const now = matchPara(after, src.text)
      if (!now) return { done: false, detail: '找不到这一段' }
      const first = firstSentence(src.text)
      const rest = norm(src.text.slice(first.length))
      const changed = !norm(now.text).startsWith(norm(first))
      const restKept = norm(now.text).endsWith(rest.slice(-80))
      return { done: changed && restKept, detail: changed ? (restKept ? '' : '其余句子被改动') : '第一句没有改写' }
    },
  },
  {
    kind: 'S1', id: 'S1-comment',
    build: templateCtx,
    message: () => `请按合作者 ${COAUTHOR} 在讨论部分第三段留下的批注修改这一段，并在批注里回复说明改了什么。`,
    targets: ctx => [ctx.features!.comment.para],
    formatTarget: ctx => ctx.features!.comment.para,
    check(ctx, after) {
      const src = D.paras(D.docXml(ctx.source)).find(p => p.text.startsWith(lead(ctx.features!.comment.para)))!
      const now = matchPara(after, src.text)
      const changed = !!now && norm(now.text) !== norm(src.text)
      // 回复：多了一条 Word 里看得到的批注（正文有引用标记；是否挂在原批注下的线程里不作要求）
      const before = new Set(visibleComments(ctx.source))
      const replied = visibleComments(after).some(id => !before.has(id))
      return { done: changed && replied, detail: changed ? (replied ? '' : '没有可见的批注回复') : '这一段没有修改' }
    },
  },
]

function tableCells(pkg: D.Pkg): string[] {
  const tbl = /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(D.docXml(pkg))
  return tbl ? D.paras(tbl[0]).map(p => p.text).filter(Boolean) : []
}

// —— S2 真实并发修改 ——

export const CLINICIAN_SENTENCE = 'This finding was confirmed in the per-protocol sensitivity analysis (Supplementary Table S5).'

const S2: StressTask[] = [
  {
    kind: 'S2', id: 'S2-rewrite',
    build: plainCtx,
    message: () => '把讨论部分第一段改写得更精炼、更有条理，保留其中的所有信息。',
    targets: ctx => [sectionProse(ctx.source, DISCUSSION)[0]!.text],
    formatTarget: ctx => sectionProse(ctx.source, DISCUSSION)[0]!.text,
    concurrent: ctx => {
      const p = sectionProse(ctx.source, DISCUSSION)[0]!
      return { para: p.text, tail: tailOf(p), sentence: CLINICIAN_SENTENCE }
    },
    check(ctx, after) {
      const src = sectionProse(ctx.source, DISCUSSION)[0]!.text
      const now = matchPara(after, src)
      const changed = !!now && norm(now.text.replace(CLINICIAN_SENTENCE, '')) !== norm(src)
      return { done: changed, detail: changed ? '' : '这一段没有改写' }
    },
  },
]

// —— S3 文献补充 ——

const S3: StressTask[] = [
  {
    kind: 'S3', id: 'S3-support',
    build: plainCtx,
    message: ctx => `讨论部分第二段的第一句「${firstSentence(sectionProse(ctx.source, DISCUSSION)[1]!.text)}」缺少文献支持，请补充 2–3 条真实的支持文献：正文标注引用，并加入参考文献表。`,
    targets: ctx => [sectionProse(ctx.source, DISCUSSION)[1]!.text],
    formatTarget: ctx => sectionProse(ctx.source, DISCUSSION)[1]!.text,
    check: () => ({ done: true, detail: '' }),
  },
  {
    kind: 'S3', id: 'S3-update',
    build: plainCtx,
    message: () => '请用近 5 年发表的随机对照试验或荟萃分析证据，在讨论部分第二段末尾补充一句话，并加上相应引用（正文标注引用，并加入参考文献表）。',
    targets: ctx => [sectionProse(ctx.source, DISCUSSION)[1]!.text],
    formatTarget: ctx => sectionProse(ctx.source, DISCUSSION)[1]!.text,
    check: () => ({ done: true, detail: '' }),
  },
  {
    kind: 'S3', id: 'S3-intro',
    build: plainCtx,
    message: () => '引言第一段的论述需要更新：请在这一段末尾补充 2 条近 3 年发表的相关研究，并引用（正文标注引用，并加入参考文献表）。',
    targets: ctx => [sectionProse(ctx.source, INTRO)[0]!.text],
    formatTarget: ctx => sectionProse(ctx.source, INTRO)[0]!.text,
    check: () => ({ done: true, detail: '' }),
  },
]

export const STRESS: StressTask[] = [...S1, ...S2, ...S3]
export { COAUTHOR_COMMENT }

/**
 * 压力任务的排程（计划 §2.2 每组配对数：S1 45、S2 30、S3 45）：种子 × 论文 × 任务，确定性轮转。
 * S1 只用能生成复杂模板的论文（有表题与表格）。
 */
export function stressSchedule(seeds: number[]): Array<{ seed: number; task: StressTask; paper: PaperTopic }> {
  const all = [...PAPERS.train, ...PAPERS.heldout]
  const templated = all.filter(t => { try { complexTemplate(sourceDocx(t)); return true } catch { return false } })
  const out: Array<{ seed: number; task: StressTask; paper: PaperTopic }> = []
  seeds.forEach((seed, si) => {
    // S1：5 类任务 × 每个种子 3 篇论文（错开起点，3 个种子覆盖 9 篇）
    S1.forEach((task, ti) => { for (let k = 0; k < 3; k++) out.push({ seed, task, paper: templated[(si * 3 + k + ti) % templated.length]! }) })
    // S2：每个种子 10 篇论文全部
    for (const paper of all) out.push({ seed, task: S2[0]!, paper })
    // S3：3 类任务 × 每个种子 5 篇论文
    S3.forEach((task, ti) => { for (let k = 0; k < 5; k++) out.push({ seed, task, paper: all[(si * 5 + ti * 2 + k) % all.length]! }) })
  })
  return out
}
