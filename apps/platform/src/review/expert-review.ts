/**
 * 专家审阅页（论文一需要医生配合的工作：使用与公开的同意、文献全文核对、测试稿真实性抽查、结果判定）。
 *
 * - 题目包由平台管理员上传（含测试稿 docx），存在数据库里，不进代码仓库（仓库公开，题目包含未公开的测试稿与实验输出）。
 * - 医生用私密链接 /review/<token> 打开，免登录；库里只存 token 的哈希。答案逐题自动保存，可以分几次做完。
 * - 重新上传题目包（补题、改题）时链接不变、已填答案按题目键保留。
 * - 页面只拿到题目本身：实验组别、评分脚本的结论等「答案」放在本地的对照表里，不进题目包（盲评）。
 */
import { createHash, randomBytes } from 'node:crypto'

export class ReviewError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export interface ReviewQuestion {
  key: string
  label: string
  type: 'choice' | 'text'
  options?: string[]
  /** 选了这些选项之一时才需要回答（例如「没有」时填写说明） */
  when?: { key: string; values: string[] }
  optional?: boolean
}
export interface ReviewBlock {
  label: string
  text: string
  /** 要在文字里标出的片段（例如待核对的数字） */
  highlight?: string[]
  /** 对照显示：与 text 一起左右并排（修改前 / 修改后） */
  compare?: { label: string; text: string; highlight?: string[] }
}
export interface ReviewItem {
  key: string
  title?: string
  blocks?: ReviewBlock[]
  links?: Array<{ label: string; url: string }>
  files?: string[]
  questions: ReviewQuestion[]
}
export interface ReviewSection {
  id: string
  title: string
  /** 说明文字：段落数组 */
  intro?: string[]
  /** 预计耗时（分钟），显示在目录里 */
  minutes?: number
  items: ReviewItem[]
}
export interface ReviewPackage {
  title: string
  intro?: string[]
  sections: ReviewSection[]
}
export interface ReviewFile { name: string; mime: string; bytes: Uint8Array }

const KEY = /^[A-Za-z0-9_.-]{1,80}$/
const FILE = /^[A-Za-z0-9_.-]{1,120}$/
const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new ReviewError('bad_package', `${what} 缺失或过长`)
  return v
}
const strs = (v: unknown, max: number, what: string): string[] | undefined => {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new ReviewError('bad_package', `${what} 应为数组`)
  return v.map((x, i) => str(x, max, `${what}[${i}]`))
}

/** 校验上传的题目包与附件；返回规整后的题目包（只保留已知字段）。 */
export function validatePackage(raw: unknown, fileNames: Set<string>): ReviewPackage {
  if (!raw || typeof raw !== 'object') throw new ReviewError('bad_package', '题目包格式不对')
  const p = raw as Record<string, unknown>
  if (!Array.isArray(p.sections) || p.sections.length === 0) throw new ReviewError('bad_package', '题目包没有章节')
  const itemKeys = new Set<string>()
  const sections = p.sections.map((s0, si): ReviewSection => {
    const s = s0 as Record<string, unknown>
    const id = str(s.id, 40, `章节 ${si} 的 id`)
    if (!KEY.test(id)) throw new ReviewError('bad_package', `章节 id「${id}」不合法`)
    if (!Array.isArray(s.items)) throw new ReviewError('bad_package', `章节 ${id} 没有题目`)
    const items = s.items.map((i0, ii): ReviewItem => {
      const it = i0 as Record<string, unknown>
      const key = str(it.key, 80, `${id} 第 ${ii} 题的键`)
      if (!KEY.test(key) || itemKeys.has(key)) throw new ReviewError('bad_package', `题目键「${key}」不合法或重复`)
      itemKeys.add(key)
      const qs = Array.isArray(it.questions) ? it.questions : []
      if (qs.length === 0) throw new ReviewError('bad_package', `题目 ${key} 没有问题`)
      const qKeys = new Set<string>()
      const questions = qs.map((q0): ReviewQuestion => {
        const q = q0 as Record<string, unknown>
        const qk = str(q.key, 40, `${key} 的问题键`)
        if (!KEY.test(qk) || qKeys.has(qk)) throw new ReviewError('bad_package', `${key} 的问题键「${qk}」不合法或重复`)
        qKeys.add(qk)
        const type = q.type === 'choice' ? 'choice' : q.type === 'text' ? 'text' : null
        if (!type) throw new ReviewError('bad_package', `${key}.${qk} 的类型只能是 choice 或 text`)
        const options = type === 'choice' ? strs(q.options, 200, `${key}.${qk} 的选项`) : undefined
        if (type === 'choice' && (!options || options.length < 2)) throw new ReviewError('bad_package', `${key}.${qk} 至少要两个选项`)
        const w = q.when as { key?: unknown; values?: unknown } | undefined
        const when = w ? { key: str(w.key, 40, `${key}.${qk} 的条件`), values: strs(w.values, 200, `${key}.${qk} 的条件值`) ?? [] } : undefined
        if (when && !qKeys.has(when.key)) throw new ReviewError('bad_package', `${key}.${qk} 的条件要指向它前面的问题`)
        return { key: qk, label: str(q.label, 1000, `${key}.${qk} 的题干`), type, ...(options ? { options } : {}), ...(when ? { when } : {}), ...(q.optional ? { optional: true } : {}) }
      })
      const blocks = it.blocks === undefined ? undefined : (Array.isArray(it.blocks) ? it.blocks : []).map((b0): ReviewBlock => {
        const b = b0 as Record<string, unknown>
        const c = b.compare as Record<string, unknown> | undefined
        return {
          label: str(b.label, 200, `${key} 的材料标题`), text: str(b.text, 20000, `${key} 的材料`),
          ...(b.highlight ? { highlight: strs(b.highlight, 200, `${key} 的标注`) } : {}),
          ...(c ? { compare: { label: str(c.label, 200, `${key} 的对照标题`), text: str(c.text, 20000, `${key} 的对照材料`), ...(c.highlight ? { highlight: strs(c.highlight, 200, `${key} 的对照标注`) } : {}) } } : {}),
        }
      })
      const links = it.links === undefined ? undefined : (Array.isArray(it.links) ? it.links : []).map(l0 => {
        const l = l0 as Record<string, unknown>
        const url = str(l.url, 500, `${key} 的链接`)
        if (!/^https:\/\//.test(url)) throw new ReviewError('bad_package', `${key} 的链接只能是 https`)
        return { label: str(l.label, 200, `${key} 的链接文字`), url }
      })
      const files = strs(it.files, 120, `${key} 的附件`)
      for (const f of files ?? []) if (!fileNames.has(f)) throw new ReviewError('bad_package', `${key} 引用的附件 ${f} 没有上传`)
      return { key, ...(it.title ? { title: str(it.title, 300, `${key} 的标题`) } : {}), ...(blocks ? { blocks } : {}), ...(links ? { links } : {}), ...(files ? { files } : {}), questions }
    })
    return { id, title: str(s.title, 200, `章节 ${id} 的标题`), ...(s.intro ? { intro: strs(s.intro, 4000, `章节 ${id} 的说明`) } : {}), ...(typeof s.minutes === 'number' ? { minutes: s.minutes } : {}), items }
  })
  return { title: str(p.title, 200, '标题'), ...(p.intro ? { intro: strs(p.intro, 4000, '说明') } : {}), sections }
}

/** 上传请求体：{ package, files: { 文件名: { mime, b64 } } } */
export function parseUpload(body: unknown): { pkg: ReviewPackage; files: ReviewFile[] } {
  const b = (body ?? {}) as { package?: unknown; files?: Record<string, { mime?: unknown; b64?: unknown }> }
  const files: ReviewFile[] = Object.entries(b.files ?? {}).map(([name, f]) => {
    if (!FILE.test(name)) throw new ReviewError('bad_package', `附件名「${name}」不合法`)
    if (typeof f?.b64 !== 'string') throw new ReviewError('bad_package', `附件 ${name} 没有内容`)
    const mime = typeof f.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(f.mime) ? f.mime : 'application/octet-stream'
    return { name, mime, bytes: new Uint8Array(Buffer.from(f.b64, 'base64')) }
  })
  return { pkg: validatePackage(b.package, new Set(files.map(f => f.name))), files }
}

/** 找到题目里的某个问题 */
function findQuestion(pkg: ReviewPackage, answerKey: string): ReviewQuestion | null {
  const dot = answerKey.lastIndexOf('.')
  if (dot <= 0) return null
  const itemKey = answerKey.slice(0, dot)
  const qKey = answerKey.slice(dot + 1)
  for (const s of pkg.sections) for (const it of s.items) if (it.key === itemKey) return it.questions.find(q => q.key === qKey) ?? null
  return null
}

/** 校验一条答案（键是「题目键.问题键」）；value 为 null 表示清除。 */
export function validateAnswer(pkg: ReviewPackage, key: unknown, value: unknown): { key: string; value: string | null } {
  if (typeof key !== 'string') throw new ReviewError('bad_answer', '答案缺少题目')
  const q = findQuestion(pkg, key)
  if (!q) throw new ReviewError('bad_answer', `没有这道题：${key}`)
  if (value === null || value === '') return { key, value: null }
  if (typeof value !== 'string' || value.length > 4000) throw new ReviewError('bad_answer', '答案过长')
  if (q.type === 'choice' && !q.options!.includes(value)) throw new ReviewError('bad_answer', `「${value}」不是这道题的选项`)
  return { key, value }
}

/** 进度：必答题里已答的数量（条件题只在条件满足时计入） */
export function progress(pkg: ReviewPackage, answers: Record<string, string>): { answered: number; total: number; bySection: Record<string, { answered: number; total: number }> } {
  const bySection: Record<string, { answered: number; total: number }> = {}
  let answered = 0, total = 0
  for (const s of pkg.sections) {
    const t = { answered: 0, total: 0 }
    for (const it of s.items) for (const q of it.questions) {
      if (q.optional) continue
      if (q.when && !q.when.values.includes(answers[`${it.key}.${q.when.key}`] ?? '')) continue
      t.total++
      if (answers[`${it.key}.${q.key}`]) t.answered++
    }
    bySection[s.id] = t
    answered += t.answered
    total += t.total
  }
  return { answered, total, bySection }
}

export const newReviewToken = () => randomBytes(24).toString('base64url')
export const hashReviewToken = (token: string) => createHash('sha256').update(token).digest('hex')
