import { OpError } from './types.ts'

/**
 * 患者红线守卫（docs/design/PATIENT.md §3）：知家成员「健康档案」（doc 归属 doc_kind=archive）的 AI 写入，
 * 写前硬闸、只对 AI。目标不是医疗审查，而是拦住「AI 越界给出诊疗结论」：
 * - 记录口径放行（「医生诊断为…」「出院诊断：…」「每天 0.4mg，医生交代的」）；
 * - AI 自己下诊断、提用药 / 剂量 / 停换建议、无出处的统计论断、缺就医引导的急症与异常指标、肿瘤内容解读性展开 → 拦截，
 *   失败码与 hint 告诉模型怎么改写（改成记录 + 引导就医）。
 * 模式匹配是 v1 的口径：宁可拦下让模型改写，不放行越界内容；评测集（PATIENT.md §8）持续回归。
 */

export interface PhrMember { tags: string[]; birth_year: number | null }

/** 诊断结论句式：判断 / 怀疑 / 可能是 / 是典型的 + 医学名词，或确诊 / 符合诊断；英文同理。 */
const DIAG = /(?:诊断[为是]|确诊[为是]|考虑[是为]|判断[为是]|怀疑(?:是)?|可能是|是典型的)[^。]{0,10}(?:炎|症|病|瘤|癌|疹|综合征|感染|结石|结节|甲流|乙流|流感)|符合[^。]{0,16}(?:诊断|表现)|\b(?:diagnos(?:is|ed)(?:\s+with)?|you\s+have|likely\s+[a-z]+)\b/i
/**
 * 引述口径才放行：引述者要紧邻结论（医生诊断为…／医生说…／医生建议…／出院诊断：…／体检报告查出…）。
 * 引述者与结论之间出现「不 / 没 / 我 / 你 / 他 / 她 / 家」即不是引述——「医生不在，我判断是肺炎」拦下。
 */
const QGAP = '[^。；！？，,不没我你他她家]{0,6}'
const QUOTED = new RegExp(
  `(?:医生|大夫|医院|门诊|出院|入院|体检报告|随访|复查|检查)${QGAP}(?:诊断[为是]|确诊[为是]|考虑[是为]|判断[为是]|说|交代|开了?|让|查出|告知|建议)|(?:出院|入院|门诊)诊断[:：]|\\b(?:doctor|hospital)[^。]{0,6}(?:diagnos|said|told|prescrib)`,
  'i',
)
/** 用药 / 剂量建议（指令式；「可以吃」「建议吃」「加到每次 X 片」都算——记录医嘱走引述口径）。 */
const DOSAGE = /(?:改用|换用|停用|停掉|加量|减量|剂量[^。]{0,8}(?:改|调)|(?:加|减)(?:到|为)[^。]{0,6}\d+(?:\.\d+)?\s*(?:mg|毫克|片|粒|ml|毫升|滴)|(?:建议|应当?|需要|推荐|不妨|试试)[^。]{0,16}(?:服用|口服|外用|注射|静点|输注|使用|加用|吃)|(?:可以|不妨|试试)[^。]{0,6}(?:吃|服用|用上|注射)|(?:每日|每天|每次|一天)\s*\d+(?:\.\d+)?\s*(?:mg|毫克|微克|μg|ml|毫升|片|粒|支|袋|喷|滴|iu|国际单位)[^。]{0,10}(?:建议|应|需|即可|就行)|\b(?:take|prescrib)\w*[^。]{0,12}\d+\s*mg\b)/i
/** 统计性论断（研究口径的数字）＋断言词：要有出处。 */
const STAT = /\b(?:HR|OR|RR|CI)\b|\d+(?:\.\d+)?\s*[%％]|\b[Pp]\s*[<=＜]\s*0?\.\d+/
const ASSERT = /(?:风险|有效|相关|导致|预防|获益|复发|存活|死亡)/
/** 急症表现：出现就只允许「立即就医」类内容。 */
const CRITICAL = /(?:剧烈胸痛|胸痛[^。]{0,6}(?:持续|不缓解)|大汗|呼吸困难|意识不清|意识丧失|晕厥|抽搐[^。]{0,4}(?:不止|持续)|剧烈[^。]{0,4}(?:腹痛|头痛)|大量出血|高热惊厥|胎动[^。]{0,4}减少|一侧(?:肢体|手脚)?无力|言语不清)/
/** 就医引导话术（急症 / 异常指标块里必须有其一）。 */
const SEEK = /(?:立即|马上|尽快|及时)(?:就医|去?急诊|到医院|看医生)|(?:拨打|打)\s*120|急诊(?:科|室)/
/**
 * 异常指标块里认可的「引导就医」说法（日常口语也算：去看医生、找医生看看、去医院查一下、带给医生看、复查……）。
 * 急症仍要求 SEEK 里的「立即 / 尽快就医、120」。
 */
const GUIDE = /(?:咨询|问问?|找|去看|看看?|请教)[^。；！？]{0,6}(?:医生|大夫)|(?:医生|大夫)[^。；！？]{0,4}(?:看看|看一下|评估|判断|定)|(?:带|拿)[^。；！？]{0,10}(?:给|去)[^。；！？]{0,4}(?:医生|大夫|医院)|去医院|到医院|就诊|就医|复诊|复查|门诊|遵医嘱|挂[^。；！？]{0,4}号/
/** 肿瘤相关：数值可以记录，解读性展开拦下。 */
const ONCO = /(?:肿瘤标志物|甲胎蛋白|\bAFP\b|癌胚抗原|\bCEA\b|\bCA\s?-?125\b|\bCA\s?-?19-?9\b|\bCA\s?-?153\b|\bPSA\b|前列腺特异(?:性)?抗原|\bNSE\b|鳞状细胞癌)/i
const ONCO_INTERPRET = /(?:提示|考虑|可能是|复发|转移|恶化|晚期|倾向)/
/** 异常指标（块级检查：整块里要有引导就医的话）。 */
const ABNORMAL = /(?:偏高|偏低|超标|阳性|高于参考|低于参考|超出参考)/
/** 特殊人群（孕产 / 哺乳 / 儿童）的用药建议（含问句口径的「可以吃」）。 */
const SPECIAL_MED = /(?:(?:建议|应当?|需要|推荐|不妨)[^。]{0,16}(?:吃|服用|口服|使用|注射|外用|喝)|(?:可以|能不能|能否|该不该|要不要)(?:吃|用|服|喝|打))/

const sentences = (text: string): string[] => text.split(/(?<=[。！？；!?])|\r?\n/)

/** 分句之间的连接词：转折、递进、插入的个人判断（引述不跨过它们）。 */
const CONNECTOR = /(?:但是|不过|然而|可是|另外|而且|并且|同时|此外|其实|所以|因此|我看|我觉得|我认为|个人认为|但)/
/**
 * 把一句拆成分句（逗号、顿号与连接词处断开），标出每个分句是否属于引述：
 * 分句自己含引述（医生说… / 出院诊断：…），或紧跟在引述分句之后且没有另起主语（不以连接词或「我 / 你」开头）。
 */
function clauses(s: string): Array<{ text: string; quoted: boolean }> {
  const parts = s.split(/[，,、]|(?=(?:但是|不过|然而|可是|另外|而且|并且|同时|此外|其实|所以|因此|我看|我觉得|我认为|个人认为))/).map(x => x.trim()).filter(Boolean)
  const out: Array<{ text: string; quoted: boolean }> = []
  let lead = false
  for (const text of parts) {
    const own = QUOTED.test(text)
    // 紧跟引述、没有另起主语的分句仍是引述（「医生让停用阿司匹林，改用氯吡格雷」）；
    // 以连接词或「我 / 你」开头的分句是另起的话（「…，另外建议…」「…，我看…」），不沿用引述
    const quoted: boolean = own || (lead && !CONNECTOR.test(text.slice(0, 4)) && !/^(?:我|你)/.test(text))
    out.push({ text, quoted })
    lead = quoted
  }
  return out
}

/** 单句的越界建议（诊断 / 用药），返回违规信息（合规返回 null）。 */
function adviceViolation(s: string): 'diag' | 'dosage' | null {
  if (DIAG.test(s)) return 'diag'
  if (DOSAGE.test(s)) return 'dosage'
  return null
}

/** 对一句越界建议抛 OpError。 */
function throwAdvice(kind: 'diag' | 'dosage', opIndex: number): never {
  if (kind === 'diag') {
    throw new OpError('health_advice_forbidden', '不能由 AI 给出诊断结论', {
      op_index: opIndex,
      hint: '诊断只能来自医生的病历：改成引述口径（如「医生诊断为…」「出院诊断：…」），或改为描述症状并建议咨询医生。',
    })
  }
  throw new OpError('health_advice_forbidden', '不能由 AI 提出用药 / 剂量 / 停换药建议', {
    op_index: opIndex,
    hint: '医生交代的用法可以记录（写明「医生交代 / 医嘱」）；不要由你提出用药、剂量或停换药建议。',
  })
}

/** 对一段 AI 拟写入的文字做红线检查；违规抛 OpError（带失败码与 hint）。 */
export function guardPhrRedlines(text: string, opIndex: number, member: PhrMember | null): void {
  for (const para of text.split(/\r?\n+/)) {
    const sents = sentences(para).map(x => x.trim()).filter(Boolean)
    for (let i = 0; i < sents.length; i++) {
      const s = sents[i]!
      // 引述只豁免它所在的分句：按逗号与连接词拆成分句逐个查（「医生说按时吃药，另外建议加到 2 片」后一句照拦）
      for (const part of clauses(s)) {
        const advice = adviceViolation(part.text)
        if (advice && !part.quoted) throwAdvice(advice, opIndex)
      }
      if (STAT.test(s) && ASSERT.test(s) && !/\[@c:[a-z0-9]+\]/.test(s)) {
        throw new OpError('unsourced_claim', '这句统计性论断没有出处', {
          op_index: opIndex,
          hint: '用 pubmed_search 找证据 → insert_citation 登记 → 正文写返回的 [@c:id]；或改写为不含统计结论的记录。',
        })
      }
      if (CRITICAL.test(s) && !SEEK.test(s)) {
        throw new OpError('emergency_overreach', '出现急症表现的描述但缺少就医引导', {
          op_index: opIndex,
          hint: '涉及急症表现时只记录事实，并写明「出现这些情况请立即就医 / 拨打 120」；不要展开分析。',
        })
      }
      if (ONCO.test(s) && ONCO_INTERPRET.test(s)) {
        throw new OpError('presentation_tier', '肿瘤相关内容不要做解读性展开', {
          op_index: opIndex,
          hint: '只记录数值、日期与医生交代；解读与随访安排由医生进行，可写「具体听复查医生的建议」。',
        })
      }
      if (ABNORMAL.test(s)) {
        const win = sents.slice(i, i + 3).join('')
        if (!SEEK.test(win) && !GUIDE.test(win)) {
          throw new OpError('guidance_required', '提到异常指标但没有引导就医', {
            op_index: opIndex,
            hint: '在本块末尾加一句「以上异常项建议带上原始报告咨询医生」。',
          })
        }
      }
    }
  }
  if (member) {
    const year = new Date().getFullYear()
    const special = member.tags.includes('孕产') || member.tags.includes('哺乳') || (member.birth_year !== null && year - member.birth_year < 12)
    if (special) {
      for (const s of sentences(text)) {
        for (const part of clauses(s)) {
          if (SPECIAL_MED.test(part.text) && !part.quoted) {
            throw new OpError('special_population', '对孕产 / 哺乳 / 儿童成员不能给用药建议', {
              op_index: opIndex,
              hint: '这类成员的用药与检查必须由医生决定：医生交代的可以记录（写明「医生交代」），其余改为建议咨询医生。',
            })
          }
        }
      }
    }
  }
}

// —— 知家对话回复：比写入档案宽松（PATIENT.md §3：对话是答疑，档案是长期记录） ——

/** 泛泛的常识口吻（「一般来说…」「常见原因是…」）：不是在给这位成员下结论。 */
const GENERAL = /(?:一般|通常|常见|多见|多数|大多|很多人|有些人|有的人|往往|常常|可能的原因|原因有|一类)/
/** 指向这位成员 / 这次结果的说法：有它才算「给这位成员下诊断」。 */
const MEMBER_REF = /(?:爸爸|妈妈|爸|妈|宝宝|孩子|老人|爷爷|奶奶|外公|外婆|老公|老婆|你|您|他|她|这次|本次|这个结果|这项|目前|现在)/

/** 冲着这位成员下的诊断（「爸爸这次可能是痛风」「你这是痛风」）：病名不限于 炎 / 症 / 病 结尾。 */
const DISEASE = '(?:炎|症|病|瘤|癌|疹|综合征|感染|结石|结节|流感|痛风|高血压|糖尿病|贫血|甲亢|甲减|衰竭|不全|中风|脑梗|心梗|哮喘)'
const MEMBER_DIAG = new RegExp(`(?:你|您|他|她|爸爸|妈妈|爸|妈|宝宝|孩子|老人|这次|目前)[^。，；]{0,6}(?:这是|就是|得了|患了|属于|应该是|可能是|是不是|考虑是)[^。]{0,8}${DISEASE}`)

/** 一句回复是否越过硬红线（诊断这位成员、用药 / 剂量建议、特殊人群用药、肿瘤解读）。 */
function replyHardLine(s: string, member: PhrMember | null): string | null {
  for (const part of clauses(s)) {
    if (part.quoted) continue
    if (MEMBER_DIAG.test(part.text)) return 'diagnosis'
    const advice = adviceViolation(part.text)
    if (advice === 'diag' && GENERAL.test(part.text) && !MEMBER_REF.test(part.text)) continue
    if (advice) return advice === 'diag' ? 'diagnosis' : 'dosage'
  }
  if (ONCO.test(s) && ONCO_INTERPRET.test(s)) return 'oncology'
  if (member) {
    const special = member.tags.includes('孕产') || member.tags.includes('哺乳') || (member.birth_year !== null && new Date().getFullYear() - member.birth_year < 12)
    if (special) {
      for (const part of clauses(s)) {
        if (SPECIAL_MED.test(part.text) && !part.quoted) return 'special_population'
      }
    }
  }
  return null
}

export const PHR_REPLY_NOTICE = '（知家安全提示）这个问题涉及诊断或用药的判断，知家不能替医生说。建议把症状、检查和日期整理好，当面问医生；紧急情况请立即就医。'

/**
 * 过滤一条知家对话回复：只去掉越过硬红线的句子（给这位成员下诊断、用药 / 剂量建议等），其余照常显示并加一句说明；
 * 常识口吻不算诊断；提到异常指标没引导就医、提到急症没让立即就医的，不拦，自动补一句提醒；对话里的统计数字不要求出处。
 * 剩下的内容太少时整条换成安全提示。返回过滤后的文字与触发的规则（只用于日志）。
 */
export function filterPhrReply(text: string, member: PhrMember | null): { text: string; codes: string[] } {
  const codes: string[] = []
  let removed = 0
  const lines = text.split('\n').map(line => {
    if (!line.trim()) return line
    const kept = sentences(line).filter(s => {
      const hit = s.trim() ? replyHardLine(s, member) : null
      if (hit) { codes.push(hit); removed++ }
      return !hit
    }).join('')
    // 整行（例如一个列表项）都去掉了：连同列表符号一起去掉
    return kept.replace(/^\s*(?:[-*•]|\d+[.、])\s*$/, '')
  })
  let out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (removed && out.replace(/[\s\-*•#>（）()。，、：:]/g, '').length < 12) return { text: PHR_REPLY_NOTICE, codes }
  const tail: string[] = []
  if (CRITICAL.test(out) && !SEEK.test(out)) { tail.push('如果出现这些情况，请立即就医或拨打 120。'); codes.push('emergency_reminder') }
  if (ABNORMAL.test(out) && !SEEK.test(out) && !GUIDE.test(out)) { tail.push('上面偏高或偏低的项目，建议带上报告找医生看看。'); codes.push('guidance_reminder') }
  if (removed) tail.push(`（有 ${removed} 句涉及诊断或用药的判断，知家不能替医生说，已略去；这部分请当面问医生。）`)
  if (tail.length) out = `${out}\n\n${tail.join('\n')}`
  return { text: out, codes }
}
