/**
 * 医生科研写作与 AI 使用问卷（论文一的形成性研究）。
 *
 * 题目定义只在这里维护一份：官网问卷页（/survey）渲染时注入同一份定义，
 * 服务端按它校验提交，管理员导出 CSV 时按它展开列。改题目时同时改 SURVEY_VERSION，
 * 旧版本的答卷仍按提交时的版本号保存，导出时原样带出。
 */

export const SURVEY_ID = 'clinician-writing'
export const SURVEY_VERSION = '2026-11-13'

export type QuestionType = 'single' | 'multi' | 'scale' | 'text'

export interface SurveyQuestion {
  id: string
  type: QuestionType
  t: string
  /** 选项（单选 / 多选） */
  o?: string[]
  /** 多选上限 */
  max?: number
  /** 互斥选项：选了它就不能再选其他项（如「以上都没有」） */
  none?: string[]
  /** 场景描述（显示在题干下方） */
  s?: string
  /** 选项竖排 */
  stack?: boolean
  /** 1–5 分量表两端的说明 */
  ends?: [string, string]
  optional?: boolean
}

export interface SurveySection { id: string; title: string; qs: SurveyQuestion[] }

export const SURVEY_SECTIONS: SurveySection[] = [
  { id: 's1', title: '关于您', qs: [
    { id: 'q01', type: 'single', t: '您目前的职位是？', o: ['主任 / PI', '副主任医师', '主治医师', '住院医师', '博士研究生', '硕士研究生', '博士后 / 研究员', '其他'] },
    { id: 'q02', type: 'single', t: '您主要做哪类研究？', o: ['临床研究为主', '基础研究为主', '两者都有'] },
    { id: 'q03', type: 'single', t: '近两年，您作为主笔完成的论文大约有几篇？', o: ['0 篇', '1–2 篇', '3–5 篇', '6–10 篇', '10 篇以上'] },
  ] },
  { id: 's2', title: '写作与协作', qs: [
    { id: 'q04', type: 'multi', t: '您写论文主要用什么工具？', o: ['Word', 'WPS', 'LaTeX / Overleaf', '腾讯文档等在线文档', 'Pages', '其他'] },
    { id: 'q05', type: 'multi', t: '您用什么管理参考文献？', o: ['EndNote', 'Zotero', 'NoteExpress', 'Mendeley', '手动输入', '其他'] },
    { id: 'q06', type: 'multi', t: '稿件在您和合作者之间通常怎么传递？', o: ['微信', '邮件', '网盘或共享文件夹', '在线文档实时协作', '其他'] },
    { id: 'q07', type: 'single', t: '统计结果通常怎么进入 Word？', o: ['手动抄写', '从统计软件复制粘贴', '软件自动生成表格后插入', '由别人整理好给我', '其他'] },
    { id: 'q08', type: 'multi', t: '近两年写论文时，您遇到过以下哪些情况？', o: [
      '引用的格式或编号乱了', '引用字段损坏，EndNote 等无法更新', '引错了文献',
      '摘要、正文、表格里的同一个数字不一致', '数字抄错或算错',
      '自己改好的内容被别人改回去或改丢了', '多个版本需要手动合并', '以上都没有遇到过'], none: ['以上都没有遇到过'] },
    { id: 'q09', type: 'single', t: '这类问题最常在什么阶段被发现？', o: ['自己检查时', '合作者或导师审稿时', '期刊审稿人指出', '发表以后', '没遇到过这类问题'] },
  ] },
  { id: 's3', title: 'AI 工具的使用', qs: [
    { id: 'q10', type: 'multi', t: '写论文时，您用过哪些 AI 工具？', o: ['ChatGPT', 'DeepSeek', 'Kimi', '豆包', '通义千问', 'Claude', 'Microsoft Copilot', 'Paperpal / Writefull 等写作插件', '其他', '都没用过'], none: ['都没用过'] },
    { id: 'q11', type: 'single', t: '您写论文时使用 AI 的频率是？', o: ['几乎每天', '每周几次', '偶尔', '从不'] },
    { id: 'q12', type: 'multi', t: '您主要用 AI 做什么？', o: ['翻译', '润色语言', '写初稿', '找文献或总结文献', '写审稿回复信', '解释或检查统计结果', '不使用'], none: ['不使用'] },
    { id: 'q13', type: 'single', t: '您通常怎么把 AI 的结果放进稿件？', o: ['把内容复制到聊天窗口，再把结果粘回 Word', '在 Word 里用插件（如 Copilot、Paperpal）直接修改', '让 AI 直接读取并修改整个文件', '不使用 AI', '其他'] },
    { id: 'q14', type: 'multi', t: 'AI 给您带来过以下哪些问题？', o: ['编造了不存在的文献', '改错了数字', '改变了原意，或把结论说得更强', '粘回后格式或引用字段坏了', '改得不像自己写的', '没遇到过问题', '不使用 AI'], none: ['没遇到过问题', '不使用 AI'] },
    { id: 'q15', type: 'single', t: '对 AI 给出的修改，您通常怎么检查？', o: ['逐句和原文对照', '大概看一遍', '只检查数字和文献', '基本直接使用', '不使用 AI'] },
  ] },
  { id: 's4', title: 'AI 改稿的底线', qs: [
    { id: 'q16', type: 'multi', max: 3, t: 'AI 帮忙改论文时，以下哪些您最不能接受被它改动或弄错？', o: [
      '自己或合作者亲手改过的内容', '参考文献和引用', '统计数字和表格', 'Word 格式、修订痕迹和批注',
      '原文的意思和措辞强度（如「可能相关」变成「显著相关」）', '写作风格'] },
    { id: 'q17', type: 'single', stack: true, t: '遇到下面的情况，您希望系统怎么处理？',
      s: '您导师刚改过某一段，AI 还没看到这些修改，就要按自己之前读到的内容重写这一段。',
      o: ['拦下 AI，让它先看最新内容再改', '拦下 AI，先问我怎么办', '让 AI 照改，但提醒我', '不需要特别处理'] },
    { id: 'q18', type: 'single', stack: true, t: '您更希望 AI 怎样修改您的稿件？', o: ['直接改，我事后再看', '只提修改建议，由我逐条确认', '小改直接改，大改先给建议', '不希望 AI 修改我的稿件'] },
    { id: 'q19', type: 'scale', t: '如果系统为了保护您和合作者的内容，有时会拦下 AI 的修改，您能接受吗？', ends: ['完全不能接受', '完全可以接受'] },
    { id: 'q20', type: 'text', t: '关于论文写作和 AI 工具，还有什么想告诉我们的？', optional: true },
  ] },
]

export const SURVEY_QUESTIONS: SurveyQuestion[] = SURVEY_SECTIONS.flatMap(s => s.qs)

const TEXT_MAX = 2000
const OTHER_MAX = 200

export type SurveyAnswer = string | string[] | number | null

export interface SurveySubmission {
  answers: Record<string, SurveyAnswer>
  /** 选「其他」时的补充说明，按题号 */
  other: Record<string, string>
  started_at: string | null
}

export class SurveyError extends Error {
  constructor(message: string, readonly code: string) { super(message) }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 校验并规整一份提交：只收定义里有的题和选项，未答的题记为 null（多选记为 []）。
 * 必答题允许为空：问卷可以中途提交，导出时如实带出空值。
 */
export function validateSubmission(raw: unknown): SurveySubmission {
  if (!isObj(raw)) throw new SurveyError('提交格式不对', 'bad_request')
  if (raw.consent !== true) throw new SurveyError('请先勾选同意说明', 'consent_required')
  const inAnswers = isObj(raw.answers) ? raw.answers : {}
  const inOther = isObj(raw.other) ? raw.other : {}
  const answers: Record<string, SurveyAnswer> = {}
  const other: Record<string, string> = {}
  let answered = 0

  for (const q of SURVEY_QUESTIONS) {
    const v = inAnswers[q.id]
    if (q.type === 'single') {
      if (v == null || v === '') { answers[q.id] = null; continue }
      if (typeof v !== 'string' || !q.o!.includes(v)) throw new SurveyError(`第 ${q.id} 题的选项无效`, 'bad_option')
      answers[q.id] = v
    } else if (q.type === 'multi') {
      if (v == null) { answers[q.id] = []; continue }
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !q.o!.includes(x))) throw new SurveyError(`第 ${q.id} 题的选项无效`, 'bad_option')
      const picked = q.o!.filter(o => (v as string[]).includes(o))
      if (q.max && picked.length > q.max) throw new SurveyError(`第 ${q.id} 题最多选 ${q.max} 项`, 'too_many')
      const nones = q.none ?? []
      if (picked.some(p => nones.includes(p)) && picked.length > 1) throw new SurveyError(`第 ${q.id} 题的「${nones.join('／')}」不能和其他选项同时选`, 'exclusive_option')
      answers[q.id] = picked
    } else if (q.type === 'scale') {
      if (v == null || v === '') { answers[q.id] = null; continue }
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1 || n > 5) throw new SurveyError(`第 ${q.id} 题应为 1–5 分`, 'bad_option')
      answers[q.id] = n
    } else {
      const s = typeof v === 'string' ? v.trim().slice(0, TEXT_MAX) : ''
      answers[q.id] = s || null
    }
    const a = answers[q.id]
    if (Array.isArray(a) ? a.length > 0 : a != null) answered++

    const chose = Array.isArray(a) ? a.includes('其他') : a === '其他'
    const note = inOther[q.id]
    if (chose && typeof note === 'string' && note.trim()) other[q.id] = note.trim().slice(0, OTHER_MAX)
  }
  if (answered === 0) throw new SurveyError('还没有回答任何问题', 'empty')

  const started = typeof raw.started_at === 'string' && !Number.isNaN(Date.parse(raw.started_at)) ? new Date(raw.started_at).toISOString() : null
  return { answers, other, started_at: started }
}

export interface SurveyResponseRow {
  id: string
  version: string
  created_at: string
  data: SurveySubmission
}

/** 导出 JSON：每份答卷带上题目原文，单独拿出来也能看懂。 */
export function exportJson(rows: SurveyResponseRow[]) {
  return {
    survey: SURVEY_ID,
    current_version: SURVEY_VERSION,
    exported_at: new Date().toISOString(),
    count: rows.length,
    questions: SURVEY_QUESTIONS.map(q => ({ id: q.id, type: q.type, question: q.t, scenario: q.s, options: q.o, max_choices: q.max, scale_ends: q.ends })),
    responses: rows.map(r => ({ id: r.id, version: r.version, submitted_at: r.created_at, started_at: r.data.started_at, answers: r.data.answers, other: r.data.other })),
  }
}

const csvCell = (v: unknown): string => {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * 导出 CSV（Excel / SPSS / R 可直接读）：单选、量表、文字各占一列；
 * 多选每个选项一列（选了记 1，没选记 0，整题未答留空），带「其他」说明的题另加一列。
 * 文件以 UTF-8 BOM 开头，Excel 打开中文不乱码。
 */
export function exportCsv(rows: SurveyResponseRow[]): string {
  const header: string[] = ['response_id', 'version', 'submitted_at', 'started_at']
  const cols: Array<(r: SurveyResponseRow) => unknown> = [r => r.id, r => r.version, r => r.created_at, r => r.data.started_at]
  for (const q of SURVEY_QUESTIONS) {
    if (q.type === 'multi') {
      for (const o of q.o!) {
        header.push(`${q.id}:${o}`)
        cols.push(r => {
          const a = r.data.answers[q.id]
          return Array.isArray(a) && a.length ? (a.includes(o) ? 1 : 0) : ''
        })
      }
    } else {
      header.push(q.id)
      cols.push(r => r.data.answers[q.id])
    }
    if (q.o?.includes('其他')) {
      header.push(`${q.id}:其他说明`)
      cols.push(r => r.data.other[q.id] ?? '')
    }
  }
  const lines = [header.map(csvCell).join(','), ...rows.map(r => cols.map(f => csvCell(f(r))).join(','))]
  return '﻿' + lines.join('\r\n') + '\r\n'
}
