import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeIngest } from '../src/datasets/ingest.ts'
import { DatasetError, DatasetService, parseCsv } from '../src/datasets/service.ts'
import { Store } from '../src/store/db.ts'

// 用仓库里的 .venv-compute（与容器里 /opt/compute 同一组包）真实运行导入脚本；没有这个环境时跳过
const PY_REL = fileURLToPath(new URL('../../../.venv-compute/bin/python3', import.meta.url))
const PY_HOST = '/Users/huizhao/Downloads/workspace/heurion2/.venv-compute/bin/python3'
const PY = existsSync(PY_REL) ? PY_REL : existsSync(PY_HOST) ? PY_HOST : PY_REL
const SCRIPT = fileURLToPath(new URL('../scripts/dataset_ingest.py', import.meta.url))
const real = existsSync(PY)

function env() {
  const store = new Store(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'heurion-datasets-'))
  const svc = new DatasetService(store, dir, makeIngest({ python: PY, script: SCRIPT }))
  return { store, svc }
}
const csv = (text: string) => new TextEncoder().encode(text)

describe.skipIf(!real)('数据集：导入与概况', () => {
  it('CSV 导入：列类型、缺失、摘要；重复上传返回已有的；不支持的格式报错', async () => {
    const t = env()
    const body = 'id,group,age,crp,visit\n1,A,62,12.5,2024-03-01\n2,B,55,,2024-04-11\n3,A,70,8.1,2024-05-02\n4,B,48,20.3,2024-06-15\n5,A,66,9.9,2024-07-20\n6,B,59,15.0,2024-08-30\n7,A,61,11.2,2024-09-09\n'
    const { dataset } = t.svc.upload('u1', '队列.csv', csv(body))
    expect(dataset.status).toBe('processing')
    await t.svc.idle()
    const d = t.svc.get('u1', dataset.id)
    expect([d.status, d.rows, d.cols, d.format, d.name]).toEqual(['ready', 7, 5, 'CSV', '队列'])
    const col = Object.fromEntries(d.columns.map(c => [c.name, c]))
    expect(col.group!.type).toBe('categorical')
    expect(col.crp!.type).toBe('numeric')
    expect(col.crp!.missing).toBe(1)
    expect(col.visit!.type).toBe('date')
    expect(t.svc.upload('u1', '另一个名字.csv', csv(body)).duplicate).toBe(true)
    expect(() => t.svc.upload('u1', 'x.pdf', csv('x'))).toThrow(DatasetError)
    expect(t.svc.preview('u1', d.id, 2)).toEqual({ header: ['id', 'group', 'age', 'crp', 'visit'], rows: [['1', 'A', '62', '12.5', '2024-03-01'], ['2', 'B', '55', '', '2024-04-11']] })
  })

  it('疑似身份信息：列名与取值都能标出；每列须删掉或确认，处理完才能给 AI 用', async () => {
    const t = env()
    const body = 'pid,姓名,contact,age,score\n1,张三,13812345678,62,1.5\n2,李四,13987654321,55,2.5\n3,王五,13700001111,48,3.0\n'
    const { dataset } = t.svc.upload('u1', 'phi.csv', csv(body))
    await t.svc.idle()
    const d = t.svc.get('u1', dataset.id)
    expect(d.status).toBe('review')
    expect(d.phi.map(p => p.name)).toEqual(['姓名', 'contact'])
    expect(d.phi[1]!.reason).toContain('手机号')
    expect(() => t.svc.readyCsv('u1', d.id)).toThrow('身份信息')
    await expect(t.svc.resolvePhi('u1', d.id, ['姓名'], [])).rejects.toThrow('contact')

    const done = await t.svc.resolvePhi('u1', d.id, ['姓名', 'contact'], [])
    expect([done.status, done.cols, done.columns.map(c => c.name)]).toEqual(['ready', 3, ['pid', 'age', 'score']])
    const { path } = t.svc.readyCsv('u1', d.id)
    expect(readFileSync(path, 'utf8')).not.toContain('张三')
    expect(readFileSync(path, 'utf8')).not.toContain('13812345678')
  })

  it('确认「不是身份信息」的列保留并记下；别人的数据集碰不到；删除连文件一起删', async () => {
    const t = env()
    const { dataset } = t.svc.upload('u1', 'a.csv', csv('name,value\nalpha,1\nbeta,2\n'))
    await t.svc.idle()
    expect(t.svc.get('u1', dataset.id).phi.map(p => p.name)).toEqual(['name'])
    const done = await t.svc.resolvePhi('u1', dataset.id, [], ['name'])
    expect([done.status, done.cols]).toEqual(['ready', 2])
    expect(JSON.parse(t.store.getDataset(dataset.id)!.profile!).phi_resolved.kept).toEqual(['name'])

    expect(() => t.svc.get('u2', dataset.id)).toThrow('不存在')
    expect(() => t.svc.readyCsv('u2', dataset.id)).toThrow('不存在')
    expect(t.svc.list('u2')).toEqual([])

    const updated = t.svc.update('u1', dataset.id, { name: '试验', labels: { value: '数值（mg/L）', nope: 'x' } })
    expect([updated.name, updated.labels]).toEqual(['试验', { value: '数值（mg/L）' }])
    const { path } = t.svc.readyCsv('u1', dataset.id)
    t.svc.remove('u1', dataset.id)
    expect(existsSync(path)).toBe(false)
  })

  it('解析失败的文件如实标为失败', async () => {
    const t = env()
    const { dataset } = t.svc.upload('u1', 'bad.xlsx', csv('这不是 Excel'))
    await t.svc.idle()
    const d = t.svc.get('u1', dataset.id)
    expect(d.status).toBe('failed')
    expect(d.error).toBeTruthy()
  })

  it('多工作表 Excel（数据表 + 数据字典 Tab，含字典在第一页场景）：自动识别并关联变量中文标签、单位与分类取值编码，联动 Table 1', async () => {
    const t = env()
    const tmpDir = mkdtempSync(join(tmpdir(), 'heurion-xlsx-test-'))
    const xlsx1 = join(tmpDir, 'cohort_with_dict.xlsx')
    const xlsx2 = join(tmpDir, 'dict_first_tab.xlsx')

    // 用 Python openpyxl 构造两个真实的多 Tab Excel 文件：
    // 1) Tab1=临床数据, Tab2=数据字典, Tab3=亚组数据
    // 2) Tab1=变量说明(数据字典在第一个Tab), Tab2=主数据表(含多行编码字典)
    execFileSync(PY, [
      '-c',
      `
import pandas as pd
with pd.ExcelWriter(${JSON.stringify(xlsx1)}, engine='openpyxl') as w:
    df_data = pd.DataFrame({
        'pid': ['P01', 'P02', 'P03', 'P04', 'P05', 'P06'],
        'group': [0, 1, 0, 1, 0, 1],
        'age': [62, 68, 59, 71, 64, 66],
        'lvef': [31.5, 34.0, 29.8, 36.2, 30.5, 35.1],
        'outcome': [1, 0, 1, 0, 0, 0],
    })
    df_dict = pd.DataFrame({
        '变量名': ['pid', 'group', 'age', 'lvef', 'outcome'],
        '中文名称': ['研究对象编号', '治疗分组', '入组年龄', '左室射血分数', '主要复合终点事件'],
        '单位': ['', '', '岁', '%', ''],
        '取值说明': ['', '0=标准对照组; 1=达格列净干预组', '', '', '0=未发生事件; 1=心衰再住院或全因死亡'],
    })
    df_sub = pd.DataFrame({
        'pid': ['P01', 'P02', 'P03'],
        'group': [0, 1, 0],
        'age': [62, 68, 59],
    })
    df_data.to_excel(w, sheet_name='患者基线与结局', index=False)
    df_dict.to_excel(w, sheet_name='数据字典', index=False)
    df_sub.to_excel(w, sheet_name='亚组队列', index=False)

with pd.ExcelWriter(${JSON.stringify(xlsx2)}, engine='openpyxl') as w:
    # 字典放在第一个 Tab，且采用「同一变量多行编码」的经典医学 Codebook 格式
    df_dict2 = pd.DataFrame({
        '字段编码': ['subj_id', 'sex_code', '', 'nyha_class', '', ''],
        '字段含义': ['受试者编号', '性别', '', 'NYHA心功能分级', '', ''],
        '编码值': ['', '1', '2', '2', '3', '4'],
        '值含义': ['', '男性', '女性', 'II级', 'III级', 'IV级'],
    })
    df_data2 = pd.DataFrame({
        'subj_id': ['S01', 'S02', 'S03', 'S04'],
        'sex_code': [1, 2, 1, 2],
        'nyha_class': [2, 3, 4, 2],
    })
    df_dict2.to_excel(w, sheet_name='Codebook数据字典', index=False)
    df_data2.to_excel(w, sheet_name='患者主表', index=False)
`,
    ])

    const { dataset: d1Lite } = t.svc.upload('u1', 'cohort_with_dict.xlsx', readFileSync(xlsx1))
    await t.svc.idle()
    const d1 = t.svc.get('u1', d1Lite.id)
    expect(d1.status).toBe('ready')
    expect(d1.active_sheet).toBe('患者基线与结局')
    expect(d1.dictionary_sheet).toBe('数据字典')
    expect(d1.sheets?.length).toBe(3)
    // 自动提取的中文标签、单位与分类取值编码
    expect(d1.labels.group).toBe('治疗分组')
    expect(d1.labels.lvef).toBe('左室射血分数 (%)')
    const lvefCol = d1.columns.find(c => c.name === 'lvef')!
    expect(lvefCol.unit).toBe('%')
    expect(d1.value_labels?.group).toEqual({ '0': '标准对照组', '1': '达格列净干预组' })
    expect(d1.value_labels?.outcome).toEqual({ '0': '未发生事件', '1': '心衰再住院或全因死亡' })

    // 验证 Table 1 自动把分组编码 0 / 1 和结局编码 0 / 1 映射为数据字典含义
    const tb1 = t.svc.table1('u1', d1.id, { group_col: 'group' })
    expect(tb1.headers.some(h => h.includes('标准对照组'))).toBe(true)
    expect(tb1.headers.some(h => h.includes('达格列净干预组'))).toBe(true)
    expect(tb1.rows.some(r => r.label.includes('心衰再住院或全因死亡') || r.label.includes('主要复合终点事件'))).toBe(true)

    // 验证手动切换工作表 (selectSheets)
    const switched = await t.svc.selectSheets('u1', d1.id, { sheet: '亚组队列', dict_sheet: '数据字典' })
    expect(switched.active_sheet).toBe('亚组队列')
    expect(switched.rows).toBe(3)
    expect(switched.labels.group).toBe('治疗分组')

    // 验证数据字典在第一个 Tab、数据在第二个 Tab 的工作簿自动识别
    const { dataset: d2Lite } = t.svc.upload('u1', 'dict_first_tab.xlsx', readFileSync(xlsx2))
    await t.svc.idle()
    const d2 = t.svc.get('u1', d2Lite.id)
    expect(d2.status).toBe('ready')
    expect(d2.active_sheet).toBe('患者主表')
    expect(d2.dictionary_sheet).toBe('Codebook数据字典')
    expect(d2.labels.sex_code).toBe('性别')
    expect(d2.value_labels?.sex_code).toEqual({ '1': '男性', '2': '女性' })
    expect(d2.value_labels?.nyha_class).toEqual({ '2': 'II级', '3': 'III级', '4': 'IV级' })
  })

  it('双行表头 CSV（第1行英文变量名 + 第2行中文说明/单位/取值编码）：自动剥离说明行并提取字典元数据', async () => {
    const t = env()
    const twoRowCsv = [
      'subjid,arm,age,egfr',
      '受试者编号,"治疗分组 (0=安慰剂组, 1=试验药组)",入组年龄 (岁),估算肾小球滤过率 (mL/min)',
      'S001,0,65,52.4',
      'S002,1,61,58.1',
      'S003,0,70,44.9',
      'S004,1,58,63.0',
    ].join('\n')
    const { dataset } = t.svc.upload('u1', 'two_row_header.csv', csv(twoRowCsv))
    await t.svc.idle()
    const d = t.svc.get('u1', dataset.id)
    expect(d.status).toBe('ready')
    expect(d.two_row_header).toBe(true)
    expect(d.rows).toBe(4)
    expect(d.labels.arm).toBe('治疗分组')
    expect(d.labels.age).toBe('入组年龄 (岁)')
    expect(d.value_labels?.arm).toEqual({ '0': '安慰剂组', '1': '试验药组' })
    const ageCol = d.columns.find(c => c.name === 'age')!
    expect(ageCol.type).toBe('numeric')
    expect(ageCol.unit).toBe('岁')
  })

  it('AI 工作簿与数据字典语义核验：自然语言赋值解析、字典变量模糊匹配、0/1 分类修正与严格隐私隔离', async () => {
    const t = env()
    const tmpDir = mkdtempSync(join(tmpdir(), 'heurion-xlsx-ai-'))
    const xlsxAi = join(tmpDir, 'messy_clinical_workbook.xlsx')
    execFileSync(PY, [
      '-c',
      `
import pandas as pd
with pd.ExcelWriter(${JSON.stringify(xlsxAi)}, engine='openpyxl') as w:
    # 数据表含敏感姓名列 + 拼写微差的 egfr_base + 自然语言赋值的 group + 未说明 0/1 编码的 smoke
    pd.DataFrame({
        'subjid': ['S001', 'S002', 'S003', 'S004'],
        'patient_name': ['王五', '赵六', '孙七', '周八'],
        'group': [1, 0, 1, 0],
        'egfr_base': [52.1, 61.4, 48.0, 70.2],
        'smoke': [0, 1, 0, 1],
    }).to_excel(w, sheet_name='入组分析集', index=False)
    # 字典表使用自然语言描述赋值，且变量名写成了 eGFR_baseline（与表头 egfr_base 微差）
    pd.DataFrame({
        '字段': ['subjid', 'group', 'eGFR_baseline'],
        '含义': ['研究编号', '治疗组别', '基线肾小球滤过率'],
        '赋值与单位': ['文本', '1代表达格列净组，0代表常规对照组', '单位 mL/min/1.73m2'],
    }).to_excel(w, sheet_name='变量说明', index=False)
      `,
    ])

    let capturedPromptUser = ''
    t.svc.complete = async (_sys: string, userPrompt: string) => {
      capturedPromptUser = userPrompt
      return JSON.stringify({
        recommended_data_sheet: '入组分析集',
        recommended_dict_sheet: '变量说明',
        confidence: 'high',
        summary: 'AI 已核验「入组分析集」与「变量说明」，自动对齐 eGFR_baseline → egfr_base 并补全吸烟史编码。',
        columns: {
          egfr_base: {
            label: '基线肾小球滤过率',
            unit: 'mL/min/1.73m²',
            type: 'numeric',
            matched_dict_var: 'eGFR_baseline',
          },
          smoke: {
            label: '吸烟史',
            type: 'categorical',
            type_reason: '二分类吸烟史指标',
            value_labels: { '0': '不吸烟', '1': '吸烟' },
          },
        },
        warnings: ['列 smoke 原字典未注明 0/1 含义，已按常规 0=不吸烟, 1=吸烟 预填，请复核。'],
      })
    }

    const { dataset: dLite } = t.svc.upload('u1', 'messy_clinical_workbook.xlsx', readFileSync(xlsxAi))
    await t.svc.idle()
    const d = t.svc.get('u1', dLite.id)

    // 1. 严格隐私红线验证：发给外部 LLM 的 payload 绝不包含患者真实姓名（王五/赵六）
    expect(capturedPromptUser).toBeTruthy()
    expect(capturedPromptUser).not.toContain('王五')
    expect(capturedPromptUser).not.toContain('赵六')

    // 2. 验证自然语言编码 ("1代表达格列净组，0代表常规对照组") 被成功解析
    expect(d.value_labels?.group).toEqual({ '0': '常规对照组', '1': '达格列净组' })

    // 3. 验证模糊匹配与 AI 补全的标签、单位、分类编码与核验报告
    expect(d.labels.egfr_base).toContain('基线肾小球滤过率')
    expect(d.value_labels?.smoke).toEqual({ '0': '不吸烟', '1': '吸烟' })
    expect(d.ai_audit).toBeDefined()
    expect(d.ai_audit?.mode).toBe('ai')
    expect(d.ai_audit?.fuzzy_matches.some(fm => fm.column === 'egfr_base' && fm.dict_var === 'eGFR_baseline')).toBe(true)
    expect(d.ai_audit?.warnings.length).toBeGreaterThan(0)
  })
})

describe('数据集：CSV 解析', () => {
  it('引号、转义引号、引号内换行与逗号', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n"line1\nline2",3\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['line1\nline2', '3']])
  })
})
