/**
 * 参考文献批量导入单元测试：验证 RIS / MEDLINE / BibTeX / EndNote XML / 纯文本解析，
 * Crossref / PubMed 核实、无 DOI 的纯 PMID 文献登记、摘要缓存（putAbstract）以及引用格式（style）。
 */
import { describe, expect, it } from 'vitest'
import type { CrossrefClient } from '../src/literature/crossref.ts'
import { importReferences, parseReferences } from '../src/literature/import-refs.ts'
import type { PubMedClient } from '../src/literature/pubmed.ts'
import { Documents } from '../src/model/runtime.ts'
import { Store } from '../src/store/db.ts'

const RIS = `TY  - JOUR
TI  - Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes
DO  - 10.1056/NEJMoa2307563
ER  - 

TY  - JOUR
TI  - Only a PubMed id
AN  - 27633186
ER  - 
`
const MEDLINE = `PMID- 27633186
TI  - Semaglutide and Cardiovascular Outcomes in Patients with Type 2
      Diabetes.
LID - 10.1056/NEJMoa1607141 [doi]

PMID- 11111111
TI  - No doi here.
`
const BIB = `@article{lincoff2023,
  title = {Semaglutide and {Cardiovascular} Outcomes},
  doi = {10.1056/NEJMoa2307563},
}
@comment{ignored}
@article{x, title={No identifiers}}`
const XML = `<xml><records><record><titles><title><style>A trial</style></title></titles><electronic-resource-num><style>10.1001/jama.2020.1</style></electronic-resource-num></record></records></xml>`

describe('参考文献导入：解析', () => {
  it('RIS / MEDLINE / BibTeX / EndNote XML / 纯文本都能取到 DOI 或 PMID', () => {
    expect(parseReferences(RIS)).toEqual([
      { doi: '10.1056/nejmoa2307563', pmid: null, label: 'Semaglutide and Cardiovascular Outcomes in Obesity without Diabetes' },
      { doi: null, pmid: '27633186', label: 'Only a PubMed id' },
    ])
    expect(parseReferences(MEDLINE).map(r => [r.pmid, r.doi])).toEqual([['27633186', '10.1056/nejmoa1607141'], ['11111111', null]])
    expect(parseReferences(MEDLINE)[0]!.label).toBe('Semaglutide and Cardiovascular Outcomes in Patients with Type 2 Diabetes.')
    expect(parseReferences(BIB).map(r => r.doi)).toEqual(['10.1056/nejmoa2307563', null])
    expect(parseReferences(XML).map(r => r.doi)).toEqual(['10.1001/jama.2020.1'])
    expect(parseReferences('https://doi.org/10.1056/NEJMoa2307563\nPMID: 27633186\n随便写的一行').map(r => [r.doi, r.pmid])).toEqual([['10.1056/nejmoa2307563', null], [null, '27633186']])
  })
})

describe('参考文献导入：核实与登记', () => {
  it('Crossref 网络出错：重试一次，仍失败时如实报告「暂时无法访问」而不是「查不到」', async () => {
    const store = new Store(':memory:')
    const d1 = new Documents(store).create({ owner: 'u', title: 'x' }).id
    let calls = 0
    const crossref = { lookup: async () => { calls++; throw new Error('Crossref HTTP 429') } } as unknown as CrossrefClient
    const r = await importReferences({ store, crossref, pubmed: { summaries: async () => [] } as unknown as PubMedClient }, d1, parseReferences('10.1056/NEJMoa2307563'))
    expect(calls).toBe(2)
    expect(r.skipped[0]!.reason).toContain('暂时无法访问')
  })

  it('DOI 经 Crossref 核实登记；只有 PMID 的经 PubMed 补 DOI；查不到的跳过；重复与已有的不重复登记', async () => {
    const store = new Store(':memory:')
    const d1 = new Documents(store).create({ owner: 'u', title: 'x' }).id
    const known: Record<string, string> = { '10.1056/nejmoa2307563': 'SELECT', '10.1056/nejmoa1607141': 'SUSTAIN-6' }
    const crossref = { lookup: async (doi: string) => known[doi] ? { doi, pmid: null, title: known[doi]!, authors: ['Doe J'], journal: 'N Engl J Med', year: '2023' } : null } as unknown as CrossrefClient
    const pubmed = { summaries: async (ids: string[]) => ids.filter(i => i === '27633186').map(() => ({ pmid: '27633186', doi: '10.1056/NEJMoa1607141', title: 'SUSTAIN-6', authors: [], journal: 'NEJM', year: '2016' })) } as unknown as PubMedClient
    store.upsertCitation({ doc_id: d1, doi: '10.1056/nejmoa1607141', pmid: null, formatted: '已有', url: null })
    const refs = [...parseReferences(RIS), ...parseReferences('10.1056/NEJMoa2307563\n10.9999/fake.1\nPMID: 22222222')]
    const r = await importReferences({ store, crossref, pubmed }, d1, refs)
    expect(r.added.map(a => a.formatted)).toEqual(['Doe J. SELECT. N Engl J Med. 2023. doi:10.1056/nejmoa2307563'])
    expect(r.already).toBe(1)
    expect(r.skipped.map(s => s.reason).sort()).toEqual(['DOI 10.9999/fake.1 在 Crossref 查不到', 'PubMed 里查不到这篇文献的 DOI'].sort())
    expect(store.listCitations(d1)).toHaveLength(2)
  })

  it('无 DOI 的纯 PMID 文献以 pmid:xxx 登记；缓存摘要到 citation_abstracts；支持指定 style 格式；已登记的 PMID 计入 already', async () => {
    const store = new Store(':memory:')
    const d1 = new Documents(store).create({ owner: 'u', title: 'x' }).id
    const crossref = {
      lookup: async (doi: string) => doi === '10.1056/nejmoa2307563'
        ? {
            doi,
            pmid: '37952131',
            title: 'Semaglutide and Cardiovascular Outcomes',
            authors: ['Lincoff AM', 'Brown-Frandsen K'],
            journal: 'N Engl J Med',
            year: '2023',
            abstract: 'Semaglutide 2.4 mg reduced major adverse cardiovascular events by 20%.',
          }
        : null,
    } as unknown as CrossrefClient
    const pubmed = {
      summaries: async (ids: string[]) => ids.filter(i => i === '38000001').map(() => ({
        pmid: '38000001',
        doi: null,
        title: 'Early Heart Failure Intervention Trial',
        authors: ['Smith J', 'Lee K'],
        journal: 'Lancet',
        year: '2024',
        abstract: 'Early intervention significantly reduced heart failure hospitalization at 12 months.',
      })),
    } as unknown as PubMedClient

    const refs = parseReferences('10.1056/NEJMoa2307563\nPMID: 38000001')
    const r1 = await importReferences({ store, crossref, pubmed }, d1, refs, 'apa')
    expect(r1.added).toHaveLength(2)
    expect(r1.already).toBe(0)
    expect(r1.skipped).toEqual([])
    // APA 格式：(2023).
    expect(r1.added.some(a => a.formatted.includes('(2023).'))).toBe(true)
    expect(r1.added.some(a => a.formatted.includes('(2024).'))).toBe(true)

    const citations = store.listCitations(d1)
    expect(citations.map(c => c.doi).sort()).toEqual(['10.1056/nejmoa2307563', 'pmid:38000001'])
    const pmidCite = citations.find(c => c.doi === 'pmid:38000001')!
    expect(pmidCite.pmid).toBe('38000001')
    expect(pmidCite.url).toBe('https://pubmed.ncbi.nlm.nih.gov/38000001/')

    // 摘要缓存验证
    expect(store.getAbstract('10.1056/nejmoa2307563')?.abstract).toContain('reduced major adverse cardiovascular events by 20%')
    expect(store.getAbstract('pmid:38000001')?.abstract).toContain('reduced heart failure hospitalization at 12 months')

    // 再次导入同一批文献：DOI 与纯 PMID 均应计入 already，不重复插入
    const r2 = await importReferences({ store, crossref, pubmed }, d1, refs, 'apa')
    expect(r2.added).toHaveLength(0)
    expect(r2.already).toBe(2)
    expect(store.listCitations(d1)).toHaveLength(2)
  })
})
