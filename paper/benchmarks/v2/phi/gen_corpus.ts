/**
 * v2 PHI 评测语料（ANALYSIS_PLAN_v2 §3）：由与规则编写无关的大模型写病程文本，身份信息只写占位符，
 * 再由脚本用虚构的替代值填入；实体位置由填入过程确定，无需人工标注。全程不含真实患者信息。
 *   cd apps/platform && npx tsx --env-file-if-exists=../../.env ../../paper/benchmarks/v2/phi/gen_corpus.ts
 * 输出 corpus/dev.json、corpus/test.json（约 1/3 为开发集），corpus/raw/ 下保存每次请求的提示词与模型原始输出。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const OUT = join(here, 'corpus')
const RAW = join(OUT, 'raw')
const MODEL = 'deepseek-v4-pro'
const API = 'https://api.deepseek.com/chat/completions'
const SEED = 20261020
const CONCURRENCY = 4

const GENRES = ['查房记录', '入院记录', '出院小结', '护理记录', '知情同意书', '随访电话记录', '会诊意见', '手术记录', '检验报告备注', '患者来信']
const NOTE_CALLS_PER_GENRE = 5 // 每次 3 篇
const NEG_TOPICS = ['肿瘤放化疗疗效', '心血管介入研究', '糖尿病与代谢', '影像组学模型', '感染与抗菌药物', '神经内科卒中', '呼吸系统疾病', '围手术期管理', '真实世界队列方法学', '药物不良反应监测']
const NEG_CALLS_PER_TOPIC = 3 // 每次 10 句

// —— 占位符 → 实体类型 ——

type SpanType = 'person_name' | 'address' | 'workplace' | 'phone' | 'id_card' | 'medical_record_no' | 'bank_card'
const PLACEHOLDER: Record<string, SpanType> = {
  姓名: 'person_name', 患者姓名: 'person_name', 亲属姓名: 'person_name', 家属姓名: 'person_name', 联系人姓名: 'person_name',
  住址: 'address', 地址: 'address', 家庭住址: 'address',
  工作单位: 'workplace', 单位: 'workplace',
  电话: 'phone', 手机: 'phone', 联系电话: 'phone',
  身份证: 'id_card', 身份证号: 'id_card',
  病案号: 'medical_record_no', 住院号: 'medical_record_no', 门诊号: 'medical_record_no',
  银行卡: 'bank_card', 银行卡号: 'bank_card',
}
const LABEL_BEFORE = /(姓名|名字|住址|地址|电话|手机|号码|身份证号?|病案号|住院号|门诊号|卡号|单位|联系人|患者|家属)[^\n，。；,;]{0,4}[:：]\s*$/

// —— 可复现的虚构替代值 ——

let state = SEED >>> 0
const rand = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 10)).join('')

const SURNAMES = '王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文'.split('')
const GIVEN = '伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀霞平刚桂英华玉兰红建文辉宁欣怡浩然子轩梓涵雨萱晨宇佳琪志鹏淑珍德海国庆春梅秋菊建平永红丽君晓东海燕'.split('')
const CITIES = ['合肥市', '芜湖市', '安庆市', '南京市', '苏州市', '杭州市', '武汉市', '长沙市', '成都市', '西安市', '郑州市', '济南市']
const DISTRICTS = ['蜀山区', '包河区', '庐阳区', '瑶海区', '鼓楼区', '玄武区', '西湖区', '江汉区', '岳麓区', '锦江区', '雁塔区', '金水区']
const ROADS = ['长江西路', '黄山路', '望江东路', '金寨路', '中山北路', '解放大道', '人民路', '建设路', '和平街', '文化路', '翠竹路', '湖光路']
const COMMUNITIES = ['绿城玫瑰园', '万科城市花园', '幸福里', '翡翠湖畔', '阳光新村', '梧桐苑', '金色家园', '博园小区']
const ORGS = ['第三中学', '实验小学', '华科电子有限公司', '机械制造厂', '城建集团', '市自来水公司', '农业银行支行', '新华书店']
const AREA = ['340104', '340111', '320106', '330106', '420103', '430104', '510104', '610113']

function personName(): string {
  return pick(SURNAMES) + (rand() < 0.35 ? pick(GIVEN) : pick(GIVEN) + pick(GIVEN))
}
function address(): string {
  const city = pick(CITIES), district = pick(DISTRICTS)
  return rand() < 0.5
    ? `${city}${district}${pick(ROADS)}${10 + Math.floor(rand() * 900)}号${1 + Math.floor(rand() * 20)}栋${101 + Math.floor(rand() * 8) * 100 + Math.floor(rand() * 4)}室`
    : `${city}${district}${pick(COMMUNITIES)}${1 + Math.floor(rand() * 30)}栋${1 + Math.floor(rand() * 4)}单元${101 + Math.floor(rand() * 18) * 100 + Math.floor(rand() * 4)}室`
}
function workplace(): string {
  return `${pick(CITIES)}${pick(ORGS)}`
}
function idCard(): string {
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const C = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  const y = 1940 + Math.floor(rand() * 65)
  const m = String(1 + Math.floor(rand() * 12)).padStart(2, '0')
  const d = String(1 + Math.floor(rand() * 28)).padStart(2, '0')
  const body = `${pick(AREA)}${y}${m}${d}${digits(3)}`
  let sum = 0
  for (let i = 0; i < 17; i++) sum += Number(body[i]) * W[i]!
  return body + C[sum % 11]!
}
function phone(): string {
  return `1${pick(['3', '5', '7', '8', '9'])}${digits(9)}`
}
function luhnComplete(prefix: string, length: number): string {
  const body = prefix + digits(length - prefix.length - 1)
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    let n = Number(body[body.length - 1 - i])
    if (i % 2 === 0) { n *= 2; if (n > 9) n -= 9 }
    sum += n
  }
  return body + ((10 - (sum % 10)) % 10)
}
function bankCard(): string {
  return luhnComplete('629' + digits(3), rand() < 0.5 ? 16 : 19)
}
function mrn(): string {
  return rand() < 0.5 ? `ZY${digits(8)}` : digits(9)
}
const SURROGATE: Record<SpanType, () => string> = { person_name: personName, address, workplace, phone, id_card: idCard, medical_record_no: mrn, bank_card: bankCard }

// —— 填入占位符 ——

export interface Span { type: SpanType; start: number; end: number; value: string; labeled: boolean }
export interface Note { id: string; genre: string; kind: 'positive' | 'negative'; text: string; spans: Span[] }

/** 占位符 → 虚构值；同一占位符在一篇里取同一个值。返回 null 表示模型输出不合格（未知占位符、自己写了号码）。 */
function fill(template: string): { text: string; spans: Span[] } | null {
  if (/\d{6,}/.test(template.replace(/\{[^{}]*\}/g, ''))) return null
  const values = new Map<string, string>()
  const used = new Set<string>()
  const spans: Span[] = []
  let out = ''
  let last = 0
  for (const m of template.matchAll(/\{([^{}_]+)_(\d+)\}/g)) {
    const type = PLACEHOLDER[m[1]!]
    if (!type) return null
    out += template.slice(last, m.index)
    const key = `${type}:${m[1]}_${m[2]}`
    let value = values.get(key)
    if (!value) {
      do value = SURROGATE[type]()
      while (used.has(value))
      used.add(value)
      values.set(key, value)
    }
    const labeled = LABEL_BEFORE.test(out.slice(-12))
    spans.push({ type, start: out.length, end: out.length + value.length, value, labeled })
    out += value
    last = m.index! + m[0].length
  }
  out += template.slice(last)
  if (/[{}]/.test(out)) return null
  return { text: out, spans }
}

// —— 调用模型 ——

const SYSTEM = '你在为医疗隐私脱敏算法生成评测用的合成中文临床文本。文本必须完全虚构，不得包含任何真实人物或机构的信息。只输出要求的 JSON。'

function notePrompt(genre: string): string {
  return [
    `请写 3 篇互不相同的「${genre}」，每篇 120–300 字，场景、病种、写法尽量多样。要求：`,
    '1. 身份信息只能写成占位符：{姓名_1}（患者）、{亲属姓名_1}（家属、联系人或陪同人）、{住址_1}（具体到门牌或楼栋室号的住址）、{工作单位_1}、{电话_1}、{身份证_1}、{病案号_1}、{银行卡_1}；不同的人或地址用不同编号（如 {亲属姓名_2}），同一人或同一地址再次出现时用同一编号。',
    '2. 除占位符外，不要写任何具体的人名、住址、单位名、电话、证件号、病案号；医护人员只写职称（如“主治医师”“责任护士”），医院只写“本院”，日期只写“入院第3天”“术后第2天”或月日。',
    '3. 每篇至少有 2 处不带字段标签、自然出现在叙述句中的姓名或住址（例如“由其女儿{亲属姓名_1}陪同前来”“患者{姓名_1}诉夜间咳嗽加重”“现居住于{住址_1}，独居”），句式要多样；另外可以有带字段标签的信息（例如“姓名：{姓名_1}”“联系电话：{电话_1}”“病案号：{病案号_1}”）。',
    '4. 可以写真实的临床内容：诊断、药物与剂量、检验数值、体征、治疗方案。',
    '输出 JSON：{"notes": ["第一篇全文", "第二篇全文", "第三篇全文"]}',
  ].join('\n')
}

function negPrompt(topic: string): string {
  return [
    `请写 10 条互不相同的中文临床研究论文句子，主题：${topic}。风格可以是方法、结果或讨论部分，每条 30–90 字。`,
    '可以包含：药物与方案名（如 R-CHOP、FOLFOX、帕博利珠单抗、奥沙利铂）、伦理审批批号（如 2023-KY-118、IRB-2024-031）、仪器型号与序列号、样本量、随访时间、P 值、置信区间、疾病分期与分型、量表名称。',
    '绝对不能出现任何人名、住址、电话、证件号、病案号或具体的医院与单位名称。',
    '输出 JSON：{"sentences": ["……", "……"]}',
  ].join('\n')
}

let calls = 0
async function chat(prompt: string, tag: string): Promise<unknown> {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('需要 .env 里的 DEEPSEEK_API_KEY')
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      calls++
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, temperature: 1.0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] }),
      })
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
      const data = await res.json() as { choices: Array<{ message: { content: string } }> }
      const content = data.choices[0]!.message.content
      writeFileSync(join(RAW, `${tag}.json`), JSON.stringify({ model: MODEL, prompt, response: content }, null, 1))
      return JSON.parse(content)
    } catch (err) {
      console.warn(`${tag} 第 ${attempt} 次失败：${(err as Error).message}`)
      await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }
  return null
}

async function pool<T>(jobs: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = new Array(jobs.length)
  let next = 0
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!() }
  }))
  return out
}

mkdirSync(RAW, { recursive: true })
const noteJobs = GENRES.flatMap((g, gi) => Array.from({ length: NOTE_CALLS_PER_GENRE }, (_, k) => async () => ({ genre: g, data: await chat(notePrompt(g), `notes-${gi}-${k}`) as { notes?: string[] } | null })))
const negJobs = NEG_TOPICS.flatMap((t, ti) => Array.from({ length: NEG_CALLS_PER_TOPIC }, (_, k) => async () => ({ genre: `阴性：${t}`, data: await chat(negPrompt(t), `neg-${ti}-${k}`) as { sentences?: string[] } | null })))
const noteResults = await pool(noteJobs)
const negResults = await pool(negJobs)

// 结果按请求顺序处理（替代值的随机序列因此可复现，与请求完成先后无关）
const positives: Note[] = []
let rejected = 0
for (const r of noteResults) {
  for (const t of r.data?.notes ?? []) {
    const f = typeof t === 'string' ? fill(t) : null
    if (!f || f.spans.length === 0) { rejected++; continue }
    positives.push({ id: `p${positives.length + 1}`, genre: r.genre, kind: 'positive', text: f.text, spans: f.spans })
  }
}
const negatives: Note[] = []
for (const r of negResults) {
  for (const s of r.data?.sentences ?? []) {
    if (typeof s !== 'string' || /\{[^{}]*\}/.test(s)) { rejected++; continue }
    negatives.push({ id: `n${negatives.length + 1}`, genre: r.genre, kind: 'negative', text: s, spans: [] })
  }
}
const dev = [...positives.filter((_, i) => i % 3 === 0), ...negatives.filter((_, i) => i % 3 === 0)]
const test = [...positives.filter((_, i) => i % 3 !== 0), ...negatives.filter((_, i) => i % 3 !== 0)]
writeFileSync(join(OUT, 'dev.json'), JSON.stringify(dev, null, 1))
writeFileSync(join(OUT, 'test.json'), JSON.stringify(test, null, 1))

const count = (notes: Note[]) => {
  const c: Record<string, number> = {}
  for (const n of notes) for (const s of n.spans) { const k = `${s.type}${s.labeled ? '·标签' : '·叙述'}`; c[k] = (c[k] ?? 0) + 1 }
  return { notes: notes.filter(n => n.kind === 'positive').length, negatives: notes.filter(n => n.kind === 'negative').length, spans: c }
}
const meta = { generated_at: new Date().toISOString(), model: MODEL, seed: SEED, calls, rejected, genres: GENRES, dev: count(dev), test: count(test) }
writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 1))
console.log(JSON.stringify(meta, null, 1))
