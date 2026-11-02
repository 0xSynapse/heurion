import { describe, expect, it } from 'vitest'
import { ClaimService } from '../src/claims/service.ts'
import { Documents } from '../src/model/runtime.ts'
import { OpService } from '../src/ops/service.ts'
import { Store } from '../src/store/db.ts'
import { buildApi } from '../src/http/api.ts'
import { TurnService } from '../src/turns/service.ts'
import { TurnRegistry } from '../src/mcp/turns.ts'
import { PostCheck } from '../src/collab/postcheck.ts'
import { SlideRenderer } from '../src/render/slides.ts'
import { Accounts } from '../src/auth/accounts.ts'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import type { HarnessPool } from '../src/harness/pool.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

describe('论断核对临床闭环 (Claim Actions & Exemption)', () => {
  it('store.exemptClaim：将论断标记为豁免，关闭关联评论且后续核对不再重复报错', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const doc = docs.create({ owner: 'u1', title: '心血管研究' })
    const claimService = new ClaimService(docs, {} as PubMedClient)
    const ops = new OpService(docs)

    const cite = store.upsertCitation({ doc_id: doc.id, doi: '10.1056/nejmoa2307563', pmid: null, formatted: 'SELECT. NEJM 2023.', url: null })
    const p1 = docs.get(doc.id).child(0).attrs.id as string
    ops.edit({
      doc_id: doc.id,
      base_rev: 0,
      mode: 'apply',
      ops: [{ op: 'replace_block', id: p1, markdown: `在临床试验中将尿白蛋白降低 15%[@c:${cite.id}]。` }],
    }, { actor: 'user', turnId: null })

    const ev = await claimService.evidence(doc.id)
    const claim = ev.claims[0]!
    expect(claim).toBeDefined()

    // 写入一个有出处问题的论断记录与关联评论
    const row = store.addComment({ doc_id: doc.id, node_id: claim.node_id, snippet: '降低 15%' })
    store.putClaimCheck({
      doc_id: doc.id,
      claim_id: claim.claim_id,
      node_id: claim.node_id,
      sentence: claim.sentence,
      verdict: 'unsupported',
      reason: '文献明确为降低 30%，非 15%。【建议修改为】：降低 30%',
      comment_id: row.id,
      rev: 0,
    })

    // 医生标记为临床经验豁免
    store.exemptClaim(doc.id, claim.claim_id, '结合本科室真实世界队列观察')
    const check = store.getClaimCheck(doc.id, claim.claim_id)
    expect(check?.verdict).toBe('exempted')
    expect(check?.reason).toContain('结合本科室真实世界队列观察')

    // 关联评论已被自动关闭
    const comments = store.listComments(doc.id)
    expect(comments[0]!.status).toBe('resolved')
    expect(comments[0]!.replies.some(r => r.text.includes('临床经验豁免'))).toBe(true)

    // 模拟新一轮回合再次提交 unsupported，已被豁免的论断保持 unchanged，不新建警告评论
    const res = claimService.report(doc.id, [{ claim_id: claim.claim_id, verdict: 'unsupported', reason: '仍然与文献矛盾' }])
    expect(res[0]?.status).toBe('unchanged')
  })

  it('HTTP API：POST /api/docs/:id/comments/:cid/apply-claim-fix 一键采纳建议并更新正文', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const doc = docs.create({ owner: 'u1', title: '试验总结' })
    const ops = new OpService(docs)
    const turns = new TurnService(docs, {} as HarnessPool, new TurnRegistry())
    const postcheck = new PostCheck(docs)
    const accounts = new Accounts(store, { secret: 's', devMode: true, devToken: 'dev-token', devUser: 'u1' })

    const app = buildApi({
      docs, ops, turns, postcheck, crossref: {} as CrossrefClient,
      renderer: new SlideRenderer(mkdtempSync(join(tmpdir(), 'claim-fix-'))),
      accounts, devMode: true, devUser: 'u1',
    })

    // 正文写入一个待修正数字
    const p1 = docs.get(doc.id).child(0).attrs.id as string
    ops.edit({
      doc_id: doc.id,
      base_rev: 0,
      mode: 'apply',
      ops: [{ op: 'replace_block', id: p1, markdown: '试验结果显示尿蛋白降低 15%。' }],
    }, { actor: 'user', turnId: null })

    // 添加一条带修复建议的评论
    const comment = store.addComment({ doc_id: doc.id, node_id: p1, snippet: '降低 15%' })
    store.addReply(comment.id, 'ai', '论断核对：所引文献不支持该论断。文献明确显示降低 30%。\n【建议修改为】：降低 30%')

    // 调用一键采纳建议接口
    const res = await app.request(`/api/docs/${doc.id}/comments/${comment.id}/apply-claim-fix`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    const resText = await res.text()
    expect(res.status).toBe(200)
    const body = JSON.parse(resText)
    expect(body.ok).toBe(true)
    expect(body.replaced).toEqual({ find: '降低 15%', replace: '降低 30%' })

    // 正文已被修改为 30%
    const updated = docs.get(doc.id).child(0).textContent
    expect(updated).toContain('降低 30%')

    // 评论已被关闭并记录回复
    const c = store.getComment(doc.id, comment.id)
    expect(c?.status).toBe('resolved')
    expect(c?.replies.some(r => r.text.includes('已将「降低 15%」替换为「降低 30%」'))).toBe(true)
  })

  it('表格单元格数值与本研究自报数据不误报为 missing_citation，不挂无意义评论', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const doc = docs.create({ owner: 'u1', title: '队列研究' })
    const claimService = new ClaimService(docs, {} as PubMedClient)
    const ops = new OpService(docs)

    const p1 = docs.get(doc.id).child(0).attrs.id as string
    ops.edit({
      doc_id: doc.id,
      base_rev: 0,
      mode: 'apply',
      ops: [
        {
          op: 'replace_block',
          id: p1,
          markdown: [
            '| 特征 | 比例 |',
            '| --- | --- |',
            '| 饮酒（从不） | 40.4% |',
            '',
            '## 研究结果',
            '',
            '本研究共纳入 45 例患者，表 1 显示从不饮酒者占 40.4%。',
            '',
            '## 讨论',
            '',
            '既往研究显示戒酒干预可使复发率降低 35%。',
            '',
            '文献报道同类人群饮酒比例达 65.0%，而本研究表 1 中仅为 51.1%。',
          ].join('\n'),
        },
      ],
    }, { actor: 'user', turnId: null })

    const ev = await claimService.evidence(doc.id)
    // 1. 表格单元格 40.4% 与纯自报句子（本研究共纳入 45 例...）不进入 unsourced
    // 2. 引述外部研究的句子、以及含外部研究对比的混合句均保留在 unsourced 中，绝不漏报
    expect(ev.unsourced).toHaveLength(2)
    expect(ev.unsourced[0]!.sentence).toContain('既往研究显示戒酒干预可使复发率降低 35%')
    expect(ev.unsourced[1]!.sentence).toContain('文献报道同类人群饮酒比例达 65.0%')

    // 即便模型对某条 unsourced 误传 missing_citation 但在理由中写明属于本研究自报基线数据，也不挂评论
    const res = claimService.report(doc.id, [
      {
        claim_id: ev.unsourced[0]!.claim_id,
        verdict: 'missing_citation',
        reason: '属本研究自报基线数据，无需挂文献引用。',
      },
    ])
    expect(res[0]?.status).toBe('recorded')
    expect(store.listComments(doc.id, 'open')).toHaveLength(0)
  })

  it('SafeVantage 证据层级与原文摘录：light/medium 背景论断仅凭摘要 supported 时自动提取原文且不挂打扰评论', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const doc = docs.create({ owner: 'u1', title: 'NSCLC 综述' })
    const claimService = new ClaimService(docs, {} as PubMedClient)
    const ops = new OpService(docs)

    const doi = '10.1056/nejmoa1801005'
    const cite = store.upsertCitation({ doc_id: doc.id, doi, pmid: '29658856', formatted: 'Gandhi L et al. NEJM 2018.', url: null })
    store.putAbstract(
      doi,
      '29658856',
      'BACKGROUND: First-line therapy for advanced NSCLC lacking targetable mutations has been platinum-based chemotherapy. RESULTS: Pembrolizumab plus pemetrexed and platinum significantly improved overall survival.',
    )

    const p1 = docs.get(doc.id).child(0).attrs.id as string
    ops.edit({
      doc_id: doc.id,
      base_rev: 0,
      mode: 'apply',
      ops: [
        {
          op: 'replace_block',
          id: p1,
          markdown: [
            '## 1. 引言',
            '',
            `免疫联合化疗已成为无驱动基因晚期非小细胞肺癌的一线标准方案[@c:${cite.id}]。`,
          ].join('\n'),
        },
      ],
    }, { actor: 'user', turnId: null })

    const ev = await claimService.evidence(doc.id)
    const claim = ev.claims[0]!
    expect(claim.verification_tier).toBe('light')

    // 调用方未传 evidence_tier / evidence_quote，平台自动从缓存摘要匹配原文句子
    const res = claimService.report(doc.id, [
      {
        claim_id: claim.claim_id,
        verdict: 'supported',
        reason: '摘要明确支持帕博利珠单抗联合化疗改善总生存。',
      },
    ])

    expect(res[0]?.status).toBe('recorded')
    expect(res[0]?.comment_id).toBeUndefined()
    expect(store.listComments(doc.id, 'open')).toHaveLength(0)

    const check = store.getClaimCheck(doc.id, claim.claim_id)
    expect(check?.verdict).toBe('supported')
    expect(check?.evidence_tier).toBe('abstract')
    expect(check?.evidence_quote).toContain('Pembrolizumab plus pemetrexed and platinum significantly improved overall survival')
    expect(check?.comment_id).toBeNull()
  })

  it('SafeVantage 高危定量/亚组论断（high-tier）：仅由摘要支持时自动附加软提示评论并展示匹配摘要原文', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const doc = docs.create({ owner: 'u1', title: '亚组分析对比' })
    const claimService = new ClaimService(docs, {} as PubMedClient)
    const ops = new OpService(docs)

    const doi = '10.1056/nejmoa2307563'
    const cite = store.upsertCitation({ doc_id: doc.id, doi, pmid: '37952131', formatted: 'Lincoff AM et al. NEJM 2023.', url: null })
    store.putAbstract(
      doi,
      '37952131',
      'BACKGROUND: Semaglutide was evaluated in cardiovascular disease. RESULTS: A primary cardiovascular end-point event occurred in 6.5% of the semaglutide group and in 8.0% of the placebo group (hazard ratio, 0.80; 95% CI, 0.72 to 0.90; P<0.001).',
    )

    const p1 = docs.get(doc.id).child(0).attrs.id as string
    ops.edit({
      doc_id: doc.id,
      base_rev: 0,
      mode: 'apply',
      ops: [
        {
          op: 'replace_block',
          id: p1,
          markdown: [
            '## 讨论',
            '',
            `SELECT 试验亚组数据显示司美格鲁肽组主要心血管不良事件发生率为 6.5%，显著低于安慰剂组的 8.0%（HR = 0.80, 95% CI 0.72-0.90, P < 0.001）[@c:${cite.id}]。`,
          ].join('\n'),
        },
      ],
    }, { actor: 'user', turnId: null })

    const ev = await claimService.evidence(doc.id)
    const claim = ev.claims[0]!
    expect(claim.verification_tier).toBe('high')

    const res = claimService.report(doc.id, [
      {
        claim_id: claim.claim_id,
        verdict: 'supported',
        reason: '摘要结果中事件发生率 6.5% vs 8.0% 及 HR 0.80 均一致。',
      },
    ])

    expect(res[0]?.status).toBe('commented')
    expect(res[0]?.comment_id).toBeDefined()

    const check = store.getClaimCheck(doc.id, claim.claim_id)
    expect(check?.verdict).toBe('supported')
    expect(check?.evidence_tier).toBe('abstract')
    expect(check?.evidence_quote).toContain('6.5%')
    expect(check?.evidence_quote).toContain('0.80')

    const comments = store.listComments(doc.id, 'open')
    expect(comments).toHaveLength(1)
    expect(comments[0]?.replies[0]?.text).toContain('仅由摘要支持')
    expect(comments[0]?.replies[0]?.text).toContain('【匹配摘要原文】：')
    expect(comments[0]?.replies[0]?.text).toContain('6.5%')
  })

  it('SafeVantage 开放全文与表格验证（table / fulltext）：精准提取表格行作为 evidence_quote，且 high-tier supported 不挂警告评论', async () => {
    const store = new Store(':memory:')
    const docs = new Documents(store)
    const doc = docs.create({ owner: 'u1', title: '全文表格核验测试' })
    const claimService = new ClaimService(docs, {} as PubMedClient)
    const ops = new OpService(docs)

    const doi = '10.1016/j.lancet.2024.01.001'
    const cite = store.upsertCitation({ doc_id: doc.id, doi, pmid: '38000001', formatted: 'Zhang et al. Lancet 2024.', url: null })
    store.putAbstract(
      doi,
      '38000001',
      'BACKGROUND: We evaluated overall survival in gastric cancer. RESULTS: Overall survival was improved in the combination group.',
    )
    store.putFullText(doi, {
      source: 'pmc',
      url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC9999999/',
      license: 'CC-BY',
      text: [
        'Introduction paragraph discussing gastric cancer treatment landscape and prior trials in detail.',
        '[Table 2: Subgroup analysis of overall survival by PD-L1 CPS status]\nSubgroup | Experimental (n=150) | Control (n=150) | HR (95% CI) | P value\nPD-L1 CPS >= 5 | 18.4 months | 11.2 months | 0.62 (0.48-0.81) | 0.002\nPD-L1 CPS < 5 | 12.1 months | 11.8 months | 0.94 (0.71-1.24) | 0.65',
      ].join('\n\n'),
    })

    const p1 = docs.get(doc.id).child(0).attrs.id as string
    ops.edit({
      doc_id: doc.id,
      base_rev: 0,
      mode: 'apply',
      ops: [
        {
          op: 'replace_block',
          id: p1,
          markdown: [
            '## 讨论',
            '',
            `在 PD-L1 CPS >= 5 亚组中，联合治疗组中位总生存期达 18.4 个月，显著优于对照组的 11.2 个月（HR = 0.62, 95% CI 0.48-0.81, P = 0.002）[@c:${cite.id}]。`,
          ].join('\n'),
        },
      ],
    }, { actor: 'user', turnId: null })

    const ev = await claimService.evidence(doc.id)
    const claim = ev.claims[0]!
    expect(claim.verification_tier).toBe('high')

    const res = claimService.report(doc.id, [
      {
        claim_id: claim.claim_id,
        verdict: 'supported',
        reason: '经开放全文 Table 2 核实，PD-L1 CPS >= 5 亚组 HR 0.62 (0.48-0.81), P=0.002 完全吻合。',
      },
    ])

    // 因为已有开放全文表格佐证（table 层级），即使是 high-tier 论断也不挂警告评论
    expect(res[0]?.status).toBe('recorded')
    expect(res[0]?.comment_id).toBeUndefined()
    expect(store.listComments(doc.id, 'open')).toHaveLength(0)

    const check = store.getClaimCheck(doc.id, claim.claim_id)
    expect(check?.verdict).toBe('supported')
    expect(check?.evidence_tier).toBe('table')
    expect(check?.evidence_quote).toContain('PD-L1 CPS >= 5')
    expect(check?.evidence_quote).toContain('0.62 (0.48-0.81)')
  })
})
