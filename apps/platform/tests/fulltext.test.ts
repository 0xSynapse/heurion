/**
 * 开放获取全文客户端单元测试：验证相关段落检索、PMC 全文 / XML 表格与图注抽取、
 * 缓存机制以及 pmid:xxx 与 ref:xxx 合成键的处理。
 */
import { describe, expect, it } from 'vitest'
import { FullTextClient, relevantPassages } from '../src/literature/fulltext.ts'
import { Store } from '../src/store/db.ts'

const TEXT = `Title of the trial

Background paragraph about cardiovascular disease, obesity and the rationale for this randomized controlled trial in adults.

Results: dapagliflozin reduced plasma IL-1B at 12 months, but not IL-6 or TNF-alpha; hsCRP was unchanged (p = 0.41) in 62 participants.

Discussion paragraph discussing limitations of the small sample and the need for larger trials of SGLT2 inhibitors.

References

1. Some cited paper about IL-6 and TNF-alpha 12 months 62 participants.`

describe('开放获取全文', () => {
  it('片段：按数字与实词挑最相关的段落，跳过参考文献表', () => {
    const out = relevantPassages(TEXT, '达格列净 12 个月降低了 IL-6 与 TNF-alpha（62 例）')
    expect(out[0]).toContain('reduced plasma IL-1B at 12 months')
    expect(out.join(' ')).not.toContain('Some cited paper')
    expect(relevantPassages(TEXT, '无关的话')).toEqual([])
  })

  it('PMC：DOI → PMC id → 开放数据最新版本的纯文本；结果缓存，没有全文也缓存', async () => {
    const calls: string[] = []
    const fake = async (url: string) => {
      calls.push(url)
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('idconv')) return json({ records: [{ pmcid: url.includes('10.1%2Fopen') ? 'PMC1' : undefined }] })
      if (url.endsWith('/metadata/PMC1.1.json')) return json({ is_pmc_openaccess: true, license_code: 'CC BY', text_url: 's3://pmc-oa-opendata/PMC1.1/PMC1.1.txt?md5=x' })
      if (url.endsWith('/metadata/PMC1.2.json')) return json({ is_pmc_openaccess: true, license_code: 'CC BY', text_url: 's3://pmc-oa-opendata/PMC1.2/PMC1.2.txt?md5=y' })
      if (url.includes('/metadata/')) return new Response('', { status: 404 })
      if (url.endsWith('/PMC1.2/PMC1.2.txt')) return new Response(TEXT)
      return new Response('', { status: 404 })
    }
    const store = new Store(':memory:')
    const ft = new FullTextClient(store, fake as never, '')
    const got = await ft.get('10.1/open')
    expect(got).toMatchObject({ source: 'pmc', license: 'CC BY', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC1/' })
    expect(got!.text).toContain('IL-1B')
    const n = calls.length
    await ft.get('10.1/open')
    expect(calls.length).toBe(n) // 缓存
    expect(await ft.get('10.1/closed')).toBeNull()
    const m = calls.length
    expect(await ft.get('10.1/closed')).toBeNull()
    expect(calls.length).toBe(m) // 没有全文也缓存
  })

  it('PMC XML：优先解析 xml_url 中的表格 (table-wrap) 与图注，保留结构化证据', async () => {
    const XML = `<?xml version="1.0"?>
    <article>
      <front>
        <article-meta>
          <article-title>SELECT Trial Extended Analysis</article-title>
          <abstract><p>Semaglutide reduced CV death in overweight adults.</p></abstract>
        </article-meta>
      </front>
      <body>
        <p>A total of 17,604 patients were enrolled across 41 countries.</p>
        <table-wrap id="T1">
          <label>Table 1</label>
          <caption><p>Primary and Secondary Cardiovascular Endpoints at 3 Years</p></caption>
          <table>
            <thead>
              <tr><th>Endpoint</th><th>Semaglutide (N=8803)</th><th>Placebo (N=8801)</th><th>Hazard Ratio (95% CI)</th></tr>
            </thead>
            <tbody>
              <tr><td>Major adverse cardiovascular events</td><td>569 (6.5%)</td><td>701 (8.0%)</td><td>0.80 (0.72-0.90)</td></tr>
              <tr><td>Cardiovascular death</td><td>223 (2.5%)</td><td>262 (3.0%)</td><td>0.85 (0.71-1.01)</td></tr>
            </tbody>
          </table>
        </table-wrap>
        <fig id="F1">
          <label>Figure 1</label>
          <caption><p>Cumulative incidence of composite cardiovascular endpoints over 48 months.</p></caption>
        </fig>
      </body>
    </article>`

    const fake = async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('idconv')) return json({ records: [{ pmcid: 'PMC999' }] })
      if (url.endsWith('/metadata/PMC999.1.json')) {
        return json({ is_pmc_openaccess: true, license_code: 'CC BY', xml_url: 's3://pmc-oa-opendata/PMC999.1/PMC999.1.xml?md5=z', text_url: 's3://pmc-oa-opendata/PMC999.1/PMC999.1.txt?md5=w' })
      }
      if (url.endsWith('/PMC999.1/PMC999.1.xml')) return new Response(XML)
      return new Response('', { status: 404 })
    }
    const store = new Store(':memory:')
    const ft = new FullTextClient(store, fake as never, '')
    const got = await ft.get('10.1056/nejm.select')
    expect(got).not.toBeNull()
    expect(got!.text).toContain('[Table 1: Primary and Secondary Cardiovascular Endpoints at 3 Years]')
    expect(got!.text).toContain('0.80 (0.72-0.90)')
    expect(got!.text).toContain('[Figure 1: Cumulative incidence of composite cardiovascular endpoints')

    // 验证相关切片抓取：针对具体表格数值论断，精准命中 Table 1 证据块
    const passages = relevantPassages(got!.text, '司美格鲁肽显著降低主要心血管不良事件发生率（HR 0.80，95% CI 0.72-0.90）')
    expect(passages.length).toBeGreaterThan(0)
    expect(passages[0]).toContain('Table 1')
    expect(passages[0]).toContain('0.80 (0.72-0.90)')
  })

  it('合成键处理：pmid:xxx 调用 NCBI 转换时剥除 pmid: 前缀且不调 Unpaywall；ref:xxx 直接返回 null', async () => {
    const calls: string[] = []
    const fake = async (url: string) => {
      calls.push(url)
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url.includes('idconv')) {
        // 确保传给 NCBI idconv 的 ids 参数已去掉 pmid: 前缀
        if (url.includes('ids=123456')) return json({ records: [{ pmcid: 'PMC123' }] })
        return json({ records: [{}] })
      }
      if (url.endsWith('/metadata/PMC123.1.json')) {
        return json({ is_pmc_openaccess: true, license_code: 'CC BY', text_url: 's3://pmc-oa-opendata/PMC123.1/PMC123.1.txt' })
      }
      if (url.includes('/metadata/')) return new Response('', { status: 404 })
      if (url.endsWith('/PMC123.1/PMC123.1.txt')) return new Response(TEXT)
      return new Response('', { status: 404 })
    }
    const store = new Store(':memory:')
    const ft = new FullTextClient(store, fake as never, 'test@example.com')

    // ref:xxx 与空白直接返回 null，不发任何请求
    expect(await ft.get('ref:abcd1234')).toBeNull()
    expect(await ft.get('   ')).toBeNull()
    expect(calls).toHaveLength(0)

    // pmid:123456 剥除 pmid: 后查到 PMC123 全文，并以 pmid:123456 为键缓存
    const got = await ft.get('pmid:123456')
    expect(got).toMatchObject({ source: 'pmc', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC123/' })
    expect(calls.some(u => u.includes('ids=123456'))).toBe(true)
    expect(calls.some(u => u.includes('pmid%3A'))).toBe(false)
    expect(store.getFullText('pmid:123456')?.text).toContain('IL-1B')

    // 不在 PMC 的纯 PMID（pmid:999999）：跳过 Unpaywall（即使配置了 email），不向 unpaywall.org 发请求
    calls.length = 0
    expect(await ft.get('pmid:999999')).toBeNull()
    expect(calls.some(u => u.includes('idconv') && u.includes('ids=999999'))).toBe(true)
    expect(calls.some(u => u.includes('unpaywall.org'))).toBe(false)
  })
})
