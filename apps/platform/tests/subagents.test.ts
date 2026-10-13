import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { issueToken, verifyToken } from '../src/auth/token.ts'
import { ClaimService } from '../src/claims/service.ts'
import { DatasetService } from '../src/datasets/service.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import type { OpenAlexClient } from '../src/literature/openalex.ts'
import { buildMcpServer } from '../src/mcp/server.ts'
import { TurnRegistry, type TurnNotice } from '../src/mcp/turns.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { SubagentService } from '../src/subagents/service.ts'
import type { EvidenceBundle, StatisticalBundle, VerificationReport } from '../src/subagents/types.ts'
import { setup } from './helpers.ts'

const SECRET = 'test-subagents-secret'

function makeTestEnv(markdown?: string) {
  const env = setup(markdown ?? '# 临床试验研究\n\n研究纳入了200例心衰患者。')
  const dir = mkdtempSync(join(tmpdir(), 'heurion-subagents-ds-'))
  const csvContent = [
    'id,arm,age,sex,time,event',
    '1,Drug,62,M,12,0',
    '2,Control,55,F,8,1',
    '3,Drug,70,M,24,0',
    '4,Control,48,F,6,1',
    '5,Drug,66,M,18,0',
    '6,Control,59,F,10,1',
    '7,Drug,61,M,22,0',
    '8,Control,52,F,9,1',
  ].join('\n')

  const datasets = new DatasetService(env.store, dir, async () => {
    return {
      csv: '',
      cleanup: () => {},
      profile: { ok: true, rows: 8, truncated: false, columns: [] },
    }
  })

  // 预置数据集记录
  const dsRow = env.store.addDataset({
    owner: 'u1',
    name: '心衰队列研究数据',
    filename: 'study.csv',
    size: csvContent.length,
    sha256: 'mocksha',
    format: 'CSV',
  })
  env.store.updateDataset(dsRow.id, {
    status: 'ready',
    rows: 8,
    cols: 6,
    profile: JSON.stringify({
      ok: true,
      rows: 8,
      columns: [
        { name: 'id', type: 'categorical', missing: 0, unique: 8 },
        { name: 'arm', type: 'categorical', missing: 0, unique: 2 },
        { name: 'age', type: 'numeric', missing: 0, unique: 8 },
        { name: 'sex', type: 'categorical', missing: 0, unique: 2 },
        { name: 'time', type: 'numeric', missing: 0, unique: 8 },
        { name: 'event', type: 'numeric', missing: 0, unique: 2 },
      ],
      truncated: false,
    }),
  })
  const dataPath = datasets.csvPath(dsRow)
  mkdirSync(join(dir, 'u1', dsRow.id), { recursive: true })
  writeFileSync(dataPath, csvContent, 'utf8')

  const pubmed = {
    search: async (_q: string, _limit = 5) => [
      {
        pmid: '37123456',
        doi: '10.1056/nejmoa2301234',
        title: 'Dapagliflozin in Patients with Heart Failure and Reduced Ejection Fraction',
        authors: ['McMurray JJV', 'Solomon SD', 'Inzucchi SE'],
        year: '2023',
        journal: 'N Engl J Med',
      },
      {
        pmid: '37987654',
        doi: '10.1016/s0140-6736(23)01987-6',
        title: 'Empagliflozin for Heart Failure: A Systematic Review and Meta-Analysis',
        authors: ['Packer M', 'Anker SD', 'Butler J'],
        year: '2023',
        journal: 'Lancet',
      },
    ],
    abstract: async (pmid: string) => `Abstract for PMID ${pmid}. The primary composite outcome was reduced by 25% (HR 0.75; 95% CI 0.65-0.85; P<0.001).`,
    pmidForDoi: async () => '37123456',
  } as unknown as PubMedClient

  const openalex: OpenAlexClient = {
    search: async () => [],
  } as unknown as OpenAlexClient

  const claims = new ClaimService(env.docs, pubmed)

  const subagents = new SubagentService({
    docs: env.docs,
    store: env.store,
    claims,
    pubmed,
    openalex,
    datasets,
  })

  return { env, dsRow, pubmed, claims, datasets, subagents }
}

describe('Subagent 多专家架构协同服务 (SubagentService)', () => {
  it('📚 literature_researcher: 检索权威文献、自动登记引用并生成 EvidenceBundle 与引注建议', async () => {
    const { env, subagents } = makeTestEnv()
    const steps: string[] = []

    const bundle = (await subagents.delegate('u1', {
      role: 'literature_researcher',
      task: '检索 SGLT2 抑制剂治疗心力衰竭的最新 RCT 证据',
      doc_id: env.docId,
    }, {
      step: (msg, status) => {
        steps.push(`[${status ?? 'info'}] ${msg}`)
      },
    })) as EvidenceBundle

    expect(bundle.role).toBe('literature_researcher')
    expect(bundle.total_found).toBe(2)
    expect(bundle.citations.length).toBe(2)
    expect(bundle.citations[0]!.title).toContain('Dapagliflozin')
    expect(bundle.citations[0]!.pmid).toBe('37123456')
    expect(bundle.suggested_markers.length).toBe(2)
    expect(bundle.suggested_markers[0]!.marker).toMatch(/\[@c:[a-z0-9]+\]/)

    // 验证引用已自动登记到文档引用表中
    const cites = env.store.listCitations(env.docId)
    expect(cites.length).toBe(2)
    expect(cites.some(c => c.pmid === '37123456')).toBe(true)

    // 验证过程步骤已触发
    expect(steps.some(s => s.includes('PubMed'))).toBe(true)
    expect(steps.some(s => s.includes('文献证据提炼完毕'))).toBe(true)
  })

  it('📊 biostatistician: 基于数据集计算出版级 Table 1 基线特征表', async () => {
    const { env, dsRow, subagents } = makeTestEnv()
    const steps: string[] = []

    const stat = (await subagents.delegate('u1', {
      role: 'biostatistician',
      task: '请基于当前临床数据集，按 arm 分组生成基线特征表 Table 1',
      dataset_id: dsRow.id,
      doc_id: env.docId,
    }, {
      step: (msg, status) => {
        steps.push(`[${status ?? 'info'}] ${msg}`)
      },
    })) as StatisticalBundle

    expect(stat.role).toBe('biostatistician')
    expect(stat.analysis_type).toBe('table1')
    expect(stat.sample_size).toBe(8)
    expect(stat.markdown_table).toContain('| Characteristic |')
    expect(stat.markdown_table).toContain('Control')
    expect(stat.markdown_table).toContain('Drug')
    expect(stat.clinical_interpretation).toBeTruthy()
    expect(steps.some(s => s.includes('基线特征表'))).toBe(true)
  })

  it('📊 biostatistician: 自动识别生存分析意图并计算 Kaplan-Meier 与 Log-rank 检验', async () => {
    const { env, dsRow, subagents } = makeTestEnv()

    const stat = (await subagents.delegate('u1', {
      role: 'biostatistician',
      task: '进行两组患者的 Kaplan-Meier 生存分析 (KM curve & survival)',
      dataset_id: dsRow.id,
      doc_id: env.docId,
    })) as StatisticalBundle

    expect(stat.role).toBe('biostatistician')
    expect(stat.analysis_type).toBe('survival')
    expect(stat.sample_size).toBe(8)
    expect(stat.markdown_table).toContain('Survival')
    expect(stat.clinical_interpretation).toContain('Log-rank')
  })

  it('🛡️ fact_checker: 对抗式核查正文论断并扫描敏感身份数据 (PHI)', async () => {
    const { env, subagents } = makeTestEnv()

    // 登记文献并在正文写入包含 PHI（手机号与身份证）以及引用的文本
    const cite = env.store.upsertCitation({
      doc_id: env.docId,
      pmid: '37123456',
      doi: '10.1056/nejmoa2301234',
      formatted: 'McMurray et al. NEJM 2023.',
      url: null,
    })

    const p1 = env.docs.get(env.docId).child(0).attrs.id as string
    env.ops.edit({
      doc_id: env.docId,
      base_rev: 0,
      mode: 'apply',
      ops: [{
        op: 'replace_block',
        id: p1,
        markdown: `临床观察纳入受试者（联系电话 13812345678）。达格列净显著降低主要复合终点风险达 25%[@c:${cite.id}]。`,
      }],
    }, { actor: 'user', turnId: null })

    const report = (await subagents.delegate('u1', {
      role: 'fact_checker',
      task: '对当前文档进行全面的证据一致性核验与数据安全脱敏审查',
      doc_id: env.docId,
    })) as VerificationReport

    expect(report.role).toBe('fact_checker')
    // 应该检出手机号 PHI
    expect(report.phi_detected).toBe(true)
    expect(report.phi_count).toBeGreaterThanOrEqual(1)
    expect(report.total_claims_audited).toBeGreaterThanOrEqual(1)
  })

  it('fact_checker: 忽略章节标题与待定占位符，并将问题论断直接挂载为正文评论', async () => {
    const { env, subagents } = makeTestEnv('## 1. 背景与目的')
    const cite = env.store.upsertCitation({
      doc_id: env.docId,
      pmid: '37123456',
      doi: '10.1056/nejmoa2301234',
      formatted: 'McMurray et al. NEJM 2023.',
      url: null,
    })

    const p1 = env.docs.get(env.docId).child(0).attrs.id as string
    env.ops.edit({
      doc_id: env.docId,
      base_rev: 0,
      mode: 'apply',
      ops: [{
        op: 'replace_block',
        id: p1,
        markdown: [
          '## 1. 背景与目的',
          '',
          '主要终点：OS / PFS（待定）；次要终点：客观缓解率、安全性。',
          '',
          `研究显示达格列净降低主要复合终点风险达 99%[@c:${cite.id}]。`,
          '',
          '既往队列报道 5 年生存率提高 42%。',
        ].join('\n'),
      }],
    }, { actor: 'user', turnId: null })

    const report = (await subagents.delegate('u1', {
      role: 'fact_checker',
      task: '核查正文论断并在有问题处添加评论',
      doc_id: env.docId,
    })) as VerificationReport

    // 标题「1. 背景与目的」和占位符「待定」不应被误判为论断，只有后两句被审查
    expect(report.total_claims_audited).toBe(2)
    expect(report.unsupported_count).toBe(1)
    expect(report.unclear_count).toBe(1)

    // 验证有问题的论断已自动在文档上生成打开状态的 AI 评论
    const comments = env.store.listComments(env.docId).filter(c => c.status === 'open')
    expect(comments.length).toBe(2)
    expect(comments.some(c => c.replies.some(r => r.text.includes('论断核对：')))).toBe(true)
  })
})

describe('MCP delegate_task 协议集成与事件流', () => {
  it('调用 delegate_task 触发 subagent_start / step / done 并返回交付物', async () => {
    const { env, subagents, pubmed, datasets } = makeTestEnv()
    const workspace = mkdtempSync(join(tmpdir(), 'heurion-ws-subagent-'))
    const registry = new TurnRegistry()

    const notices: TurnNotice[] = []
    const turn = {
      turnId: 'turn_test_1',
      docId: env.docId,
      touched: new Set<string>(),
      notify: (n: TurnNotice) => notices.push(n),
      mode: 'apply' as const,
    }
    registry.begin('u1', turn)

    const claims = verifyToken(SECRET, issueToken(SECRET, { u: 'u1', d: '*', p: ['read', 'write'], aud: 'mcp', ttlSeconds: 60 }), 'mcp')!
    const crossref = { lookup: async () => null } as unknown as CrossrefClient

    const server = buildMcpServer({
      docs: env.docs,
      ops: env.ops,
      turns: registry,
      secret: SECRET,
      claims: new ClaimService(env.docs, pubmed),
      renderer: new SlideRenderer(workspace),
      pubmed,
      crossref,
      datasets,
      subagents,
      workspaceDir: () => workspace,
      isLiveSession: () => true,
    }, claims)

    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test-client', version: '1.0' })
    await client.connect(b)

    const res = await client.callTool({
      name: 'delegate_task',
      arguments: {
        role: 'literature_researcher',
        task: '检索心衰治疗药物 RCT 文献',
        doc_id: env.docId,
      },
    })

    expect(res.isError).toBeFalsy()
    const textContent = (res.content as any)[0]?.text
    expect(textContent).toBeTruthy()
    const resultObj = JSON.parse(textContent)
    expect(resultObj.role).toBe('literature_researcher')
    expect(resultObj.total_found).toBe(2)

    // 检查实时通知队列：应该有 subagent_start, subagent_step, subagent_done
    const startNotice = notices.find(n => n.type === 'subagent_start')
    expect(startNotice).toBeDefined()
    expect((startNotice as any).role).toBe('literature_researcher')
    expect((startNotice as any).role_label).toBe('文献证据专家')

    const stepNotice = notices.find(n => n.type === 'subagent_step')
    expect(stepNotice).toBeDefined()

    const doneNotice = notices.find(n => n.type === 'subagent_done')
    expect(doneNotice).toBeDefined()
    expect((doneNotice as any).summary).toContain('已检索到 2 篇权威文献证据')
  })
})
