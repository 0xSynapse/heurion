/**
 * 生产合规与 PHI (Protected Health Information) 敏感数据扫描与脱敏器。
 * 纯本地算法与正则实现，零网络请求、零外部模型调用。
 * 支持：
 * 1. 中国大陆 18 位居民身份证号码（含 ISO 7064:1983.MOD 11-2 校验和与出生日期校验）
 * 2. 中国大陆 11 位手机号码（严格前缀与边界防误报）
 * 3. 银行卡号（11-19 位，含 Luhn 模 10 校验和）
 * 4. 医疗记录编号（住院号、门诊号、就诊号、病案号等上下文）
 * 5. 真实姓名与敏感疾病诊断强关联组合
 */

export type PhiType =
  | 'id_card'
  | 'phone'
  | 'bank_card'
  | 'medical_record_no'
  | 'name_with_diagnosis'
  | 'unlabeled_person_name'
  | 'address_or_org'

export type PhiDetectionSource = 'stage1_deterministic' | 'stage2_local_slm'

export interface PhiFinding {
  type: PhiType
  value: string
  redacted: string
  start: number
  end: number
  score: number // 0 ~ 1.0 置信度
  description: string
  source?: PhiDetectionSource
}

// 身份证校验权重与校验码
const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const
const ID_CARD_CHECKS = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'] as const

/** 验证中国大陆 18 位身份证号码校验和与日期 */
export function validateIdCard(id: string): boolean {
  if (!/^[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(id)) {
    return false
  }
  const year = Number(id.slice(6, 10))
  const month = Number(id.slice(10, 12))
  const day = Number(id.slice(12, 14))
  const currentYear = new Date().getFullYear()
  if (year < 1900 || year > currentYear) return false

  // 验证月份天数
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return false
  }

  // 计算 MOD 11-2 校验码
  let sum = 0
  for (let i = 0; i < 17; i++) {
    const char = id[i]
    const weight = ID_CARD_WEIGHTS[i]
    if (!char || weight === undefined) return false
    sum += Number(char) * weight
  }
  const checkChar = ID_CARD_CHECKS[sum % 11]
  const lastChar = id[17]
  return lastChar !== undefined && lastChar.toUpperCase() === checkChar
}

/** 验证银行卡 Luhn 算法（模 10 校验） */
export function validateLuhn(num: string): boolean {
  if (!/^\d{11,19}$/.test(num)) return false
  let sum = 0
  let alternate = false
  for (let i = num.length - 1; i >= 0; i--) {
    const char = num[i]
    if (!char) return false
    let digit = Number(char)
    if (alternate) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    alternate = !alternate
  }
  return sum % 10 === 0
}

/** 脱敏工具函数 */
function maskMiddle(val: string, prefixLen: number, suffixLen: number): string {
  if (val.length <= prefixLen + suffixLen) return '*'.repeat(val.length)
  const maskLen = val.length - prefixLen - suffixLen
  return val.slice(0, prefixLen) + '*'.repeat(maskLen) + val.slice(val.length - suffixLen)
}

/**
 * Stage-1: 确定性扫描文本中的所有结构化与显式标签 PHI 实体。
 */
export function scanPhi(text: string): PhiFinding[] {
  if (!text || typeof text !== 'string') return []
  const findings: PhiFinding[] = []

  // 1. 身份证号（18 位带校验）
  const idCardRegex = /(?:^|[^\d])([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?=[^\d]|$)/g
  let m: RegExpExecArray | null
  while ((m = idCardRegex.exec(text)) !== null) {
    const raw = m[1]
    if (!raw) continue
    const start = m.index + (m[0].length - raw.length)
    const end = start + raw.length
    if (validateIdCard(raw)) {
      findings.push({
        type: 'id_card',
        value: raw,
        redacted: maskMiddle(raw, 6, 4),
        start,
        end,
        score: 0.99,
        description: '居民身份证号（校验和通过）',
        source: 'stage1_deterministic',
      })
    }
  }

  // 2. 手机号（11 位）
  const phoneRegex = /(?:^|[^\d])(1[3-9]\d{9})(?=[^\d]|$)/g
  while ((m = phoneRegex.exec(text)) !== null) {
    const raw = m[1]
    if (!raw) continue
    const start = m.index + (m[0].length - raw.length)
    const end = start + raw.length
    findings.push({
      type: 'phone',
      value: raw,
      redacted: maskMiddle(raw, 3, 4),
      start,
      end,
      score: 0.95,
      description: '中国大陆手机号码',
      source: 'stage1_deterministic',
    })
  }

  // 3. 银行卡号（13-19位，符合 ISO/IEC 7812 行业前缀 [3-69] 且通过 Luhn 校验，排除 DOI/URL 路径及校验失败的 18 位身份证格式串）
  const idCardShapeRegex = /^[1-9]\d{5}(?:18|19|20)\d{2}\d{7}[\dXx]$/
  const cardRegex = /(?:^|[^\d/.])([3-69]\d{12,18})(?=[^\d]|$)/g
  while ((m = cardRegex.exec(text)) !== null) {
    const raw = m[1]
    if (!raw) continue
    const start = m.index + (m[0].length - raw.length)
    const end = start + raw.length
    if (findings.some(f => f.type === 'id_card' && start >= f.start && end <= f.end)) continue
    if (raw.length === 18 && idCardShapeRegex.test(raw)) continue
    if (validateLuhn(raw)) {
      findings.push({
        type: 'bank_card',
        value: raw,
        redacted: maskMiddle(raw, 6, 4),
        start,
        end,
        score: 0.95,
        description: '银行卡/医保结算卡号（ISO 7812 + Luhn 校验通过）',
        source: 'stage1_deterministic',
      })
    }
  }

  // 4. 就诊号 / 住院号 / 病案号 / 门诊号 / 病历号 / 床号 / 影像号 / 病理号
  const medNoRegex = /(?:住院号|就诊号|病案号|门诊号|病历号|床号|影像号|病理号|检查号)[:：\s]+([A-Za-z0-9\-_]{4,24})/g
  while ((m = medNoRegex.exec(text)) !== null) {
    const full = m[0]
    const raw = m[1]
    if (!raw) continue
    const start = m.index
    const end = start + full.length
    findings.push({
      type: 'medical_record_no',
      value: full,
      redacted: full.replace(raw, maskMiddle(raw, 2, 2)),
      start,
      end,
      score: 0.9,
      description: '医疗记录编号（就诊号/住院号/病案号）',
      source: 'stage1_deterministic',
    })
  }

  // 5. 姓名与敏感疾病诊断强关联组合（支持含 ASCII 字母/数字/罗马数字分型的中西医诊断及显式患者前缀）
  const diseaseTail = '(?:癌|瘤|炎|症|病|综合征|感染|结石|结节|甲流|乙流|骨折|衰竭|梗死|狭窄|硬化|坏死|损伤|出血|血栓|栓塞|白血病|狼疮|疮|溃疡|贫血|紫癜|哮喘|癫痫|休克|水肿|积液|穿孔|破裂|畸形|肥大|增生|纤维化|房颤|心律失常|高血压|白内障|青光眼|中毒|功能不全|障碍)'
  const nameDiagRegex = new RegExp(
    `(?:(?:(?:患者|病人|受试者|患儿|产妇|家属)?(?:姓名|名字)[:：\\s]*([\\u4e00-\\u9fa5]{2,4}(?:·[\\u4e00-\\u9fa5]{2,8})?))|(?:(?:患者|病人|受试者|患儿|产妇)[:：\\s]*([\\u4e00-\\u9fa5]{2,4}(?:·[\\u4e00-\\u9fa5]{2,8})?)(?=[，,\\s（(]|(?:男|女|年龄|\\d{1,3}岁|因|确诊|诊断|患有|入院))))([^\\n。；！？]{0,36}?(?:确诊为|诊断为|确诊|诊断|患有|考虑为|临床表现为|罹患)[:：\\s]*)([\\u4e00-\\u9fa5A-Za-z0-9Ⅰ-Ⅻ\\-+/（）()]{1,22}${diseaseTail})`,
    'g',
  )
  while ((m = nameDiagRegex.exec(text)) !== null) {
    const full = m[0]
    const name = m[1] ?? m[2]
    if (!name) continue
    const start = m.index
    const end = start + full.length
    findings.push({
      type: 'name_with_diagnosis',
      value: full,
      redacted: full.replace(name, maskMiddle(name, 1, 0)),
      start,
      end,
      score: 0.85,
      description: '患者真实姓名与敏感诊断关联',
      source: 'stage1_deterministic',
    })
  }

  return deduplicateFindings(findings)
}

function deduplicateFindings(findings: PhiFinding[]): PhiFinding[] {
  findings.sort((a, b) => a.start - b.start)
  const filtered: PhiFinding[] = []
  for (const f of findings) {
    const overlap = filtered.find(existing => Math.max(existing.start, f.start) < Math.min(existing.end, f.end))
    if (!overlap) {
      filtered.push(f)
    } else if (f.score > overlap.score) {
      const idx = filtered.indexOf(overlap)
      filtered[idx] = f
    }
  }
  return filtered
}

/**
 * 将文本中识别到的所有 Stage-1 PHI 实体进行脱敏替换。
 */
export function redactPhi(text: string): string {
  const findings = scanPhi(text)
  return applyPhiRedactions(text, findings)
}

function applyPhiRedactions(text: string, findings: PhiFinding[]): string {
  if (findings.length === 0) return text
  let result = text
  for (let i = findings.length - 1; i >= 0; i--) {
    const f = findings[i]
    if (!f) continue
    result = result.slice(0, f.start) + f.redacted + result.slice(f.end)
  }
  return result
}

/**
 * Stage-2 语义/本地小模型 (Local SLM / On-Premise NER) 兜底检测器接口。
 * 架构契约：为防止将未脱敏 PHI 泄露给外部云端大模型，Stage-2 仅接收已完成 Stage-1
 * 结构化脱敏的文本（stage1RedactedText），且必须运行于本地 Loopback 或院内私有端点。
 */
export type PhiSemanticFallbackDetector = (
  stage1RedactedText: string,
) => Promise<Array<{ value: string; type?: PhiType; redacted?: string; description?: string }>>

/**
 * 校验模型端点是否为本地 Loopback 或院内私有网络地址（禁止公网云端 API 作为 PHI 扫描器）。
 */
export function assertLocalPhiEndpoint(endpointUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(endpointUrl)
  } catch {
    throw new Error(`phi_invalid_endpoint: ${endpointUrl}`)
  }
  const host = parsed.hostname.toLowerCase()
  const isLocal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  if (!isLocal) {
    throw new Error(
      `phi_external_endpoint_forbidden: Stage-2 PHI fallback must run on a local/on-premise endpoint, got ${host}`,
    )
  }
}

export interface LocalSlmPhiOptions {
  /** 默认 http://127.0.0.1:11434 */
  endpoint?: string
  /** 默认 qwen2.5:1.5b */
  model?: string
  /** 超时毫秒数，默认 15000 */
  timeoutMs?: number
  /** 是否对小模型输出做符号后置校验，默认 true；仅评测消融时关闭 */
  postValidate?: boolean
}

// 常见医学名词/非人名停用词过滤，防止小模型将医学术语误判为人名
const CLINICAL_TERM_BLOCKLIST = new Set([
  '患者', '病人', '家属', '受试者', '主治医师', '住院医师', '主任医师', '副主任医师', '知情同意', '知情同意书',
  '糖尿病', '高血压', '冠心病', '肺腺癌', '乳腺癌', '淋巴瘤', '白血病', '肝硬化', '肾衰竭', '心肌梗死',
  '阿司匹林', '二甲双胍', '奥希替尼', '帕博利珠单抗', '顺铂', '卡铂', '紫杉醇', '查房记录', '入院登记',
  '急诊分诊', '多因素', '生存率', '内分泌科', '心内科', '肿瘤科', '呼吸科', '消化科', '肾内科', '神经内科',
  '队列亚组', '临床路径', '生存期',
])

// 常见中文姓氏集合（百家姓前 120 姓），用于校验 Stage-2 小模型抽取的无标签中文姓名首字
const COMMON_CHINESE_SURNAMES = new Set(
  '李王张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文庞樊兰殷施陶洪翟安颜倪严牛温芦季俞章鲁葛伍韦申尤毕聂丛焦向柳邢路岳齐沿梅莫庄辛管祝左涂谷祁时舒耿牟卜肖詹关苗凌费纪靳盛童欧甄项曲成游阳裴席卫查屈鲍位覃霍翁隋植甘景薄单包司柏宁柯阮桂闵欧阳司马上官诸葛'.split(''),
)

const PERSON_NAME_MEDICAL_SUFFIX_RE =
  /(?:病|症|瘤|癌|炎|科|院|者|师|生|属|率|例|组|期|型|法|方|剂|素|胺|汀|抗|铂|醇|酸|酶|蛋白|综合征|同意书|委员会|方案|研究|分析|随访|化疗|手术|治疗|指标|阴性|阳性|记录|登记|分诊|复查|硬化|骨折|衰竭)$/

const ADDRESS_MARKER_RE =
  /(?:省|市|区|县|路|街|道|巷|弄|号|栋|单元|室|楼|座|大厦|广场|苑|园|村|镇|乡|小学|中学|大学|学院|集团|公司|厂|局|所)/

const CLINICAL_INST_EXCLUSION_RE =
  /(?:伦理委员会|知情同意|住院患者|多因素|回归分析|生存率|随访|化疗方案|本院|我院|主治医师|主任医师|临床路径|队列亚组)/

export function normalizeAndValidateStage2Entity(
  rawVal: string,
  rawType: string | undefined,
  sourceText: string,
): { value: string; type: PhiType } | null {
  let val = rawVal.trim()
  if (!val || val.includes('*')) return null

  // 剥离小模型可能附带的称谓前缀或住址介词前缀/后缀
  val = val
    .replace(/^(?:患者姓名|患者|病人|由其家属|其家属|家属|配偶|丈夫|妻子|女儿|儿子|母亲|父亲|女婿|儿媳|联系人|陪同人)[：:\s]*/, '')
    .replace(/(?:代签知情同意书|代签|陪同|来电|探视).*$/, '')
    .replace(/^(?:现住址|家庭住址|家住|现住|住址|地址|工作单位为|工作单位|单位)[：:\s]*/, '')
    .trim()

  if (!val || val.length < 2 || val.includes('*')) return null
  if (CLINICAL_TERM_BLOCKLIST.has(val)) return null
  if (!sourceText.includes(val)) return null

  const looksLikeAddress =
    rawType === 'address_or_org' ||
    rawType === 'address' ||
    rawType === 'location' ||
    rawType === 'org' ||
    ADDRESS_MARKER_RE.test(val)

  if (looksLikeAddress) {
    const cjkCount = (val.match(/[\u4e00-\u9fa5]/g) ?? []).length
    if (cjkCount < 4) return null
    if (!ADDRESS_MARKER_RE.test(val)) return null
    if (CLINICAL_INST_EXCLUSION_RE.test(val)) return null
    return { value: val, type: 'address_or_org' }
  }

  // 姓名结构校验：必须为 2~4 个纯汉字、首字属于常见中文姓氏，且不以疾病/医学/统计后缀结尾
  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(val)) return null
  if (!COMMON_CHINESE_SURNAMES.has(val[0]!)) return null
  if (PERSON_NAME_MEDICAL_SUFFIX_RE.test(val)) return null
  return { value: val, type: 'unlabeled_person_name' }
}

/**
 * 创建基于本地 Ollama 小模型 (如 Qwen2.5-1.5B) 的 Stage-2 PHI 语义兜底检测器。
 * 专门捕获无显式前缀标签的自由病程叙事中的：
 * 1. 无标签患者/家属真实姓名 (unlabeled_person_name)
 * 2. 具体家庭住址/门牌号/工作单位 (address_or_org)
 */
export function createLocalSlmPhiDetector(options: LocalSlmPhiOptions = {}): PhiSemanticFallbackDetector {
  const endpoint = (options.endpoint ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = options.model ?? 'qwen2.5:1.5b'
  const timeoutMs = options.timeoutMs ?? 15000
  const postValidate = options.postValidate ?? true
  assertLocalPhiEndpoint(endpoint)

  return async (stage1RedactedText: string) => {
    // 快速预筛：纯英文学术段落（无中文字符）无需调用中文临床病历小模型，避免生物统计指标误报并保持零开销
    if (!/[\u4e00-\u9fa5]/.test(stage1RedactedText)) {
      return []
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const systemPrompt = [
        '你是一个医疗隐私脱敏(PHI)实体抽取器。请从输入的中文临床病历文本中找出所有未脱敏的敏感个人身份信息（已包含*号的文本忽略）。',
        '只抽取以下两类实体，严格输出 JSON 格式 {"entities": [{"value": "原文精确子串", "type": "unlabeled_person_name" | "address_or_org"}]}：',
        '1. unlabeled_person_name：病历中出现的每一位未脱敏患者、病人、配偶、子女、家属、联系人的真实中文姓名（2-4个汉字，如"林晓峰"、"陈淑兰"；只输出纯姓名，不要包含"患者"、"家属"、"配偶"等称谓词，也不要抽取疾病名或药名）。',
        '2. address_or_org：具体的家庭住址、街道门牌号、小区楼栋室号或具体工作单位名称（如"合肥市蜀山区黄山路443号3栋502室"、"南京市鼓楼区第一中心小学"）。',
        '如果文本中没有上述个人身份实体，输出 {"entities": []}。',
      ].join('\n')

      const res = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          format: 'json',
          options: { temperature: 0, num_predict: 256 },
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content:
                '查房记录：身份证 110105********002X。孙建平诉昨日夜间胸闷加重，由其女儿孙晓莉代签知情同意书，现住上海市徐汇区医学院路138号5栋201室，工作单位为上海市第四中学教务处。',
            },
            {
              role: 'assistant',
              content: JSON.stringify({
                entities: [
                  { value: '孙建平', type: 'unlabeled_person_name' },
                  { value: '孙晓莉', type: 'unlabeled_person_name' },
                  { value: '上海市徐汇区医学院路138号5栋201室', type: 'address_or_org' },
                  { value: '上海市第四中学教务处', type: 'address_or_org' },
                ],
              }),
            },
            { role: 'user', content: stage1RedactedText },
          ],
        }),
      })
      if (!res.ok) return []
      const data = (await res.json()) as { message?: { content?: string } }
      const rawContent = data.message?.content ?? '{}'
      const parsed = JSON.parse(rawContent) as {
        entities?: Array<{ value?: string; type?: string }>
      }
      if (!Array.isArray(parsed.entities)) return []

      const results: Array<{ value: string; type?: PhiType; redacted?: string; description?: string }> = []
      const seen = new Set<string>()
      for (const item of parsed.entities) {
        const rawVal = typeof item.value === 'string' ? item.value : ''
        // 消融：不做后置校验，原样保留小模型输出的非空实体
        const validated = postValidate
          ? normalizeAndValidateStage2Entity(rawVal, item.type, stage1RedactedText)
          : rawVal.trim()
            ? { value: rawVal.trim(), type: item.type === 'address_or_org' ? ('address_or_org' as const) : ('unlabeled_person_name' as const) }
            : null
        if (!validated || seen.has(validated.value)) continue
        seen.add(validated.value)
        const redacted =
          validated.type === 'address_or_org'
            ? maskMiddle(validated.value, 2, 1)
            : maskMiddle(validated.value, 1, 0)
        results.push({
          value: validated.value,
          type: validated.type,
          redacted,
          description:
            validated.type === 'address_or_org'
              ? 'Stage-2 本地小模型识别：具体住址/单位'
              : 'Stage-2 本地小模型识别：自由叙事姓名',
        })
      }
      return results
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 两阶段漏斗式 PHI 扫描与脱敏（Stage-1 确定性校验和/规则 + Stage-2 预脱敏本地模型兜底）。
 */
export async function redactPhiCascaded(
  text: string,
  fallbackDetector?: PhiSemanticFallbackDetector,
): Promise<{
  redacted: string
  findings: PhiFinding[]
  stage1Findings: PhiFinding[]
  stage2Findings: PhiFinding[]
  stage2Count: number
}> {
  const stage1Findings = scanPhi(text)
  let redacted = applyPhiRedactions(text, stage1Findings)
  if (!fallbackDetector || !redacted.trim()) {
    return {
      redacted,
      findings: stage1Findings,
      stage1Findings,
      stage2Findings: [],
      stage2Count: 0,
    }
  }

  const extraSpans = await fallbackDetector(redacted)
  const stage2Findings: PhiFinding[] = []
  for (const span of extraSpans) {
    const raw = span.value?.trim()
    if (!raw || raw.length < 2 || raw.includes('*')) continue
    const replacement = span.redacted ?? maskMiddle(raw, 1, 0)
    const idx = redacted.indexOf(raw)
    if (idx !== -1) {
      stage2Findings.push({
        type: span.type ?? 'unlabeled_person_name',
        value: raw,
        redacted: replacement,
        start: idx,
        end: idx + raw.length,
        score: 0.8,
        description: span.description ?? 'Stage-2 本地模型语义兜底识别',
        source: 'stage2_local_slm',
      })
      redacted = redacted.split(raw).join(replacement)
    }
  }
  return {
    redacted,
    findings: [...stage1Findings, ...stage2Findings],
    stage1Findings,
    stage2Findings,
    stage2Count: stage2Findings.length,
  }
}

