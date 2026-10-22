/**
 * v2 多轮会话任务（第四次预实验后增加，见 ANALYSIS_PLAN_v2 变更记录）：同一篇复杂模板稿件连续改 8 轮，同一个会话；
 * 医生在轮次之间改稿（T1 后在引言第一段末尾补一句、T3 后改正讨论第二段的一个数字），T5 进行中在讨论第三段补一句。
 * 指令按医生的日常说法写，不提示要保留什么。每一轮按「改前稿件 → 改后稿件」判定（oracles.ts 同一套），
 * 并检查医生此前的修改没有被冲掉（例如 T6 按 T1 时记住的旧内容重写，冲掉医生补的句子）。
 */
import * as D from '../exp3/docx.ts'
import { METHODS, type PaperTopic } from '../manuscripts/tasks.ts'
import { sectionParas } from '../manuscripts/compare.ts'
import {
  citeless, CLINICIAN_SENTENCE, DISCUSSION, firstSentence, firstThree, INTRO, lead, norm, numberEditIn, sectionProse, SUPPORT_REQUIREMENT,
  tableCells, tableShape, tailOf, templateCtx, trackedPara, coauthorRevisionKept, words, type Concurrent, type Done, type StressCtx, type StressTask,
} from './stress.ts'
import { COAUTHOR, type TemplateFeatures } from './templates.ts'

/** 医生的一处修改：在段落（按开头定位）里把 find 换成 replace；expect 为判定用的标志文字。 */
export interface DoctorEdit extends Concurrent { label: string }

export interface SessionStep {
  id: string
  message(before: D.Pkg): string
  /** 本轮允许改的段落（改前稿件里的文字）。 */
  targets(before: D.Pkg): string[]
  check(before: D.Pkg, after: D.Pkg): Done
  /** 本轮进行中医生的修改（AI 第一次读稿之后）。 */
  concurrent?(before: D.Pkg): DoctorEdit | null
  /** 本轮结束、下一轮开始前医生的修改。 */
  doctorAfter?(after: D.Pkg): DoctorEdit | null
  /** 补文献的一轮：完成标准与引用核对同 S3。 */
  refs?: boolean
}

const intro1 = (pkg: D.Pkg) => sectionProse(pkg, INTRO)[0]
const disc = (pkg: D.Pkg) => sectionProse(pkg, DISCUSSION)
const ctxOf = (paper: PaperTopic, source: D.Pkg, features: TemplateFeatures): StressCtx => ({ paper, source, features })
const changed = (before: D.Pkg, after: D.Pkg, pick: (p: D.Pkg) => D.Para | undefined) => {
  const a = pick(before)
  const b = pick(after)
  return !!a && !!b && norm(a.text) !== norm(b.text)
}
const occurrences = (pkg: D.Pkg, re: RegExp) => sectionParas(pkg, METHODS).filter(p => D.headingLevel(p) === 0).reduce((n, p) => n + (p.text.match(re) ?? []).length, 0)

export const DOCTOR_INTRO = 'Details of the screening procedures are provided in the Supplementary Methods.'
const append = (p: D.Para | undefined, sentence: string, expect: string, label: string): DoctorEdit | null => {
  if (!p) return null
  const tail = tailOf(p)
  return tail ? { para: p.text, find: tail, replace: `${tail} ${sentence}`, expect, label } : null
}

/** 一场会话的 8 轮（paper 与模板特征用于定位合作者修订）。 */
export function sessionSteps(paper: PaperTopic, features: TemplateFeatures): SessionStep[] {
  const ctx = (pkg: D.Pkg) => ctxOf(paper, pkg, features)
  return [
    {
      id: 'T1-intro',
      message: () => '把引言第一段改得更简洁。',
      targets: b => [intro1(b)!.text],
      check: (b, a) => ({ done: changed(b, a, intro1), detail: '引言第一段没有改' }),
      doctorAfter: a => append(intro1(a), DOCTOR_INTRO, 'Supplementary Methods', 'intro_sentence'),
    },
    {
      id: 'T2-tracked',
      message: b => `把结果部分以「${words(trackedPara(ctx(b)).text)}」开头那段的第一句改得更简洁一些。`,
      targets: b => [trackedPara(ctx(b)).text],
      check: (b, a) => {
        const { text, first } = trackedPara(ctx(b))
        const now = D.paras(D.docXml(a)).find(p => p.xml.includes(`w:author="${COAUTHOR}"`) && /<w:del\b/.test(p.xml)) ?? D.paras(D.docXml(a)).find(p => p.text.startsWith(lead(text)))
        const firstChanged = !!now && !norm(now.text).includes(norm(first))
        const kept = coauthorRevisionKept(a, features)
        return { done: firstChanged && kept, detail: firstChanged ? (kept ? '' : `${COAUTHOR} 的修订没有原样保留`) : '第一句没有改写' }
      },
    },
    {
      id: 'T3-support',
      refs: true,
      message: b => `讨论部分第二段的第一句「${firstSentence(disc(b)[1]!.text)}」缺少文献支持，请补充 2–3 条真实的支持文献：正文标注引用，并加入参考文献表。${SUPPORT_REQUIREMENT}`,
      targets: b => [disc(b)[1]!.text],
      check: () => ({ done: true, detail: '' }),
      // 医生改正讨论第二段的一个数字；没有小数时补一句
      doctorAfter: a => {
        const p = disc(a)[1]
        const n = p ? numberEditIn(p, a) : null
        return n ? { ...n, label: 'corrected_number' } : append(p, 'Similar results were observed in the subgroup aged 65 years or older (Supplementary Figure S2).', 'Supplementary Figure S2', 'corrected_number')
      },
    },
    {
      id: 'T4-delcol',
      message: b => `表 1 的最后一列（「${tableShape(b)!.lastHeader}」）不要了，删掉。`,
      targets: b => tableCells(b),
      check: (b, a) => {
        const before = tableShape(b)!
        const now = tableShape(a)
        if (!now) return { done: false, detail: '表格不见了' }
        const cols = Math.max(...before.widths) - 1
        const gone = now.lastHeader !== before.lastHeader
        const even = now.widths.every(w => w === cols) && now.grid === cols
        return { done: gone && even, detail: gone ? (even ? '' : '表格各行列数不一致') : '最后一列还在' }
      },
    },
    {
      id: 'T5-rewrite',
      message: b => { const ps = firstThree(ctx(b)); return `把讨论部分前三段（分别以「${words(ps[0]!.text)}」「${words(ps[1]!.text)}」「${words(ps[2]!.text)}」开头）改得更精炼一些。` },
      targets: b => firstThree(ctx(b)).map(p => p.text),
      concurrent: b => append(firstThree(ctx(b))[2], CLINICIAN_SENTENCE, 'Supplementary Table S5', 'midturn_sentence'),
      check: (b, a) => {
        const now = new Set(D.paras(D.docXml(a)).map(p => norm(p.text)))
        const n = firstThree(ctx(b)).filter(p => !now.has(norm(p.text))).length
        return { done: n >= 2, detail: `只改写了 ${n} 段` }
      },
    },
    {
      id: 'T6-intro',
      message: () => '把引言第一段的第一句改得更简洁。',
      targets: b => [intro1(b)!.text],
      check: (b, a) => {
        const first = firstSentence(intro1(b)!.text)
        const now = intro1(a)
        return { done: !!now && !norm(now.text).startsWith(norm(first)), detail: '第一句没有改' }
      },
    },
    {
      id: 'T7-move',
      // 带合作者批注的段落挪到带脚注的段落前面（两段按当前位置与内容定位）
      message: b => { const { a, c } = movePair(b); return `把讨论部分以「${words(c.text)}」开头的那段挪到以「${words(a.text)}」开头的那段前面。` },
      targets: b => { const { a, c } = movePair(b); return [a.text, c.text] },
      check: (b, after) => {
        const { a, c } = movePair(b)
        const ps = D.paras(D.docXml(after)).map(p => citeless(p.text))
        const ia = ps.indexOf(citeless(a.text))
        const ic = ps.indexOf(citeless(c.text))
        return { done: ia >= 0 && ic >= 0 && ic < ia, detail: ia < 0 || ic < 0 ? '段落文字被改动或丢失' : '顺序没有调换' }
      },
    },
    {
      id: 'T8-term',
      message: () => '方法部分里的 patients 统一改成 participants。',
      targets: b => sectionParas(b, METHODS).map(p => p.text),
      check: (b, a) => {
        const left = occurrences(a, /\bpatients\b/g)
        return { done: left === 0 && occurrences(a, /\bparticipants\b/g) >= occurrences(b, /\bpatients\b/g), detail: `方法部分还剩 patients ${left} 处` }
      },
    },
  ]
}

/**
 * T7：带脚注的段落 a、带合作者批注的段落 c（c 须在 a 之后）。前几轮已经弄丢了脚注或批注时，
 * 改按位置取讨论部分的第二、三段，本轮照常出题（之前的损失已在那一轮计过）。
 */
function movePair(pkg: D.Pkg, strict = false): { a: D.Para; c: D.Para } {
  const ps = D.paras(D.docXml(pkg))
  const ia = ps.findIndex(p => p.xml.includes('<w:footnoteReference'))
  const ic = ps.findIndex(p => /<w:commentRangeStart w:id="7"\/>/.test(p.xml))
  if (ia >= 0 && ic > ia) return { a: ps[ia]!, c: ps[ic]! }
  const d = disc(pkg)
  if (strict || d.length < 3) throw new Error('找不到带脚注与带批注的两段，或顺序不对')
  return { a: d[1]!, c: d[2]! }
}

/** 本轮的判定任务（套用压力任务的判定：改前稿件为原稿，模板特征照常检查）。 */
export function stepTask(step: SessionStep, before: D.Pkg): StressTask {
  return {
    kind: step.refs ? 'S3' : 'S1',
    id: step.id,
    build: () => { throw new Error('会话的每一轮不单独建稿') },
    message: () => step.message(before),
    targets: () => step.targets(before),
    formatTarget: () => null,
    concurrent: step.concurrent ? () => step.concurrent!(before) as Concurrent : undefined,
    check: (_ctx, after) => step.check(before, after),
  }
}

/** 能跑完整会话的论文：复杂模板、合作者修订不在第一句、讨论至少三段、表 1 有最后一列表头、方法部分有 patients、脚注段在批注段之前。 */
export function sessionReady(t: PaperTopic): { ctx: StressCtx; steps: SessionStep[] } | null {
  try {
    const ctx = templateCtx(t)
    trackedPara(ctx)
    firstThree(ctx)
    movePair(ctx.source, true)
    if (!intro1(ctx.source) || !tableShape(ctx.source)?.lastHeader || occurrences(ctx.source, /\bpatients\b/g) === 0) return null
    return { ctx, steps: sessionSteps(t, ctx.features!) }
  } catch {
    return null
  }
}
