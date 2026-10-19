import { describe, expect, it } from 'vitest'
import {
  assertLocalPhiEndpoint,
  redactPhi,
  redactPhiCascaded,
  scanPhi,
  validateIdCard,
  validateLuhn,
} from '../src/ops/phi-scan.ts'

describe('PHI 扫描与脱敏测试 (Track D)', () => {
  describe('validateIdCard', () => {
    it('正确验证中国大陆 18 位身份证校验码', () => {
      // 真实有效结构的模拟测试身份证号（满足 MOD 11-2 校验）
      // 11010519491231002X (110105 19491231 002 X)
      // 计算：
      // 1*7 + 1*9 + 0*10 + 1*5 + 0*8 + 5*4 + 1*2 + 9*1 + 4*6 + 9*3 + 1*7 + 2*9 + 3*10 + 1*5 + 0*8 + 0*4 + 2*2
      // = 7+9+0+5+0+20+2+9+24+27+7+18+30+5+0+0+4 = 167
      // 167 % 11 = 2 -> 校验码 checks[2] = 'X'
      expect(validateIdCard('11010519491231002X')).toBe(true)
      expect(validateIdCard('11010519491231002x')).toBe(true)

      // 错误校验码：末位改成 1
      expect(validateIdCard('110105194912310021')).toBe(false)
      // 非法月份 (13月)
      expect(validateIdCard('11010519491331002X')).toBe(false)
      // 非法日期 (2月31日)
      expect(validateIdCard('11010519490231002X')).toBe(false)
      // 长度不合规
      expect(validateIdCard('11010519491231002')).toBe(false)
    })
  })

  describe('validateLuhn', () => {
    it('正确识别符合 Luhn 算法的卡号', () => {
      // 经典的有效 Luhn 卡号 (测试用标准号 49927398716)
      expect(validateLuhn('49927398716')).toBe(true)
      // 常见银行测试卡号 6222020200001234568
      expect(validateLuhn('49927398717')).toBe(false)
    })
  })

  describe('scanPhi & redactPhi', () => {
    it('扫描身份证并脱敏', () => {
      const text = '患者身份证号为 11010519491231002X，请妥善保管。'
      const findings = scanPhi(text)
      expect(findings).toHaveLength(1)
      expect(findings[0]!.type).toBe('id_card')
      expect(findings[0]!.value).toBe('11010519491231002X')
      expect(findings[0]!.redacted).toBe('110105********002X')

      const redacted = redactPhi(text)
      expect(redacted).toBe('患者身份证号为 110105********002X，请妥善保管。')
    })

    it('扫描手机号并脱敏', () => {
      const text = '家属联系电话：13812345678，如有突发情况请致电。'
      const findings = scanPhi(text)
      expect(findings).toHaveLength(1)
      expect(findings[0]!.type).toBe('phone')
      expect(findings[0]!.value).toBe('13812345678')
      expect(findings[0]!.redacted).toBe('138****5678')

      const redacted = redactPhi(text)
      expect(redacted).toBe('家属联系电话：138****5678，如有突发情况请致电。')
    })

    it('扫描就诊号和住院号', () => {
      const text = '门诊就诊记录，住院号: H20261005-01，就诊号：OPD-998877。'
      const findings = scanPhi(text)
      expect(findings.length).toBeGreaterThanOrEqual(2)
      const types = findings.map(f => f.type)
      expect(types).toContain('medical_record_no')
    })

    it('扫描患者姓名与敏感诊断关联（含字母/数字/罗马数字分型及病程叙事）', () => {
      const text = '患者姓名：李晓华，经病理检查确诊为浸润性乳腺癌；患者王建国（男，58岁），入院诊断为2型糖尿病肾病；受试者：张伟，确诊为弥漫大B细胞淋巴瘤。'
      const findings = scanPhi(text)
      const nameDiags = findings.filter(f => f.type === 'name_with_diagnosis')
      expect(nameDiags).toHaveLength(3)

      const redacted = redactPhi(text)
      expect(redacted).not.toContain('李晓华')
      expect(redacted).not.toContain('王建国')
      expect(redacted).not.toContain('张伟')
      expect(redacted).toContain('李**')
      expect(redacted).toContain('王**')
      expect(redacted).toContain('张*')
    })

    it('综合场景：同时存在多种 PHI 实体', () => {
      const complex = `
病历摘要：
患者姓名：王建国，临床确诊为慢性肾衰竭。
住院号: IPD-889922
联系手机: 13900112233
身份证件: 11010519491231002X
`
      const findings = scanPhi(complex)
      expect(findings.length).toBeGreaterThanOrEqual(4)

      const redacted = redactPhi(complex)
      expect(redacted).not.toContain('13900112233')
      expect(redacted).not.toContain('11010519491231002X')
      expect(redacted).toContain('139****2233')
      expect(redacted).toContain('110105********002X')
    })

    it('普通学术论文、零填充 DOI 后缀或化验指标不发生误报', () => {
      const cleanText = `
Study showed that 5-year overall survival was 78.4% (95% CI 72.1-84.7%).
WBC 6.5 x10^9/L, Platelets 220 x10^9/L, ALT 24 U/L.
Reference date was 2026-05-18. DOI: 10.1097/0000000000000406.
`
      const findings = scanPhi(cleanText)
      expect(findings).toHaveLength(0)
      expect(redactPhi(cleanText)).toBe(cleanText)
    })

    it('两阶段漏斗式脱敏 (redactPhiCascaded)：Stage-2 仅接收 Stage-1 预脱敏文本并兜底自由叙事姓名', async () => {
      const note = '身份证: 11010519491231002X，主治医师查房记录：老刘今日精神可，诉夜间偶有胸闷。'
      let stage2Input = ''
      const res = await redactPhiCascaded(note, async masked => {
        stage2Input = masked
        return [{ value: '老刘', redacted: '老*' }]
      })
      expect(stage2Input).not.toContain('11010519491231002X')
      expect(stage2Input).toContain('110105********002X')
      expect(res.stage2Count).toBe(1)
      expect(res.stage2Findings[0]!.source).toBe('stage2_local_slm')
      expect(res.redacted).not.toContain('老刘')
      expect(res.redacted).toContain('老*')
    })

    it('本地端点边界守卫 (assertLocalPhiEndpoint)：禁止公网云端 API 作为 PHI 扫描端点', () => {
      expect(() => assertLocalPhiEndpoint('http://127.0.0.1:11434')).not.toThrow()
      expect(() => assertLocalPhiEndpoint('http://localhost:11434')).not.toThrow()
      expect(() => assertLocalPhiEndpoint('http://192.168.1.20:11434')).not.toThrow()
      expect(() => assertLocalPhiEndpoint('https://api.deepseek.com/v1')).toThrow(/phi_external_endpoint_forbidden/)
      expect(() => assertLocalPhiEndpoint('https://api.openai.com/v1')).toThrow(/phi_external_endpoint_forbidden/)
    })
  })
})

