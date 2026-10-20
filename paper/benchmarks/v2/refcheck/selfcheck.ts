/**
 * refcheck 自检：在一篇测试稿上追加几条已知真假的文献与一处正文裸 DOI，核对分类是否符合预期。
 *   cd apps/platform && npx tsx ../../paper/benchmarks/v2/refcheck/selfcheck.ts
 * 需要联网（Crossref、PubMed）；结果缓存在 refcheck/cache.json。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8 } from '../../../../apps/platform/node_modules/fflate/esm/browser.js'
import * as D from '../../exp3/docx.ts'
import { checkReferences, type RefStatus } from './refcheck.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const source = D.openDocx(new Uint8Array(readFileSync(join(here, '../../manuscripts/data/docx/PMC8861838.docx'))))

const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`

// 预期：真实且一致 / 真实 DOI 配错题目 / 编造 / PMID 真实 / 无编号但真实
const ENTRIES: Array<[string, RefStatus]> = [
  ['McMurray JJV, Solomon SD, Inzucchi SE, et al. Dapagliflozin in Patients with Heart Failure and Reduced Ejection Fraction. N Engl J Med. 2019;381:1995-2008. doi:10.1056/NEJMoa1911303', 'verified'],
  ['Smith J, Brown K, et al. Effect of vitamin D supplementation on knee osteoarthritis progression. Lancet. 2020;395:112-120. doi:10.1056/NEJMoa1606774', 'mismatched'],
  ['Zhang W, Liu Q, Chen H, et al. Quantum-resonance nanotherapy reverses advanced pancreatic adenocarcinoma in a randomized multicenter trial. Chin J Imaginary Med. 2023;12:45-51.', 'fabricated'],
  ['Reck M, Rodríguez-Abreu D, Robinson AG, et al. Pembrolizumab versus Chemotherapy for PD-L1-Positive Non-Small-Cell Lung Cancer. N Engl J Med. 2016;375:1823-1833. PMID: 27718847', 'verified'],
  ['Heerspink HJL, Stefánsson BV, Correa-Rotter R, et al. Dapagliflozin in Patients with Chronic Kidney Disease. N Engl J Med. 2020;383:1436-1446.', 'verified'],
]

let xml = D.docXml(source)
// 正文：参考文献标题前加一段带裸 DOI 的句子，并加一个新的引用编号
const refHead = D.paras(xml).find(p => /^References\s*$/.test(p.text.trim()))!
xml = xml.replace(refHead.xml, para('As reported previously (doi: 10.1016/S0140-6736(20)30183-5), outcomes improved [99].') + refHead.xml)
// 文献表末尾追加条目
const lastSect = xml.lastIndexOf('<w:sectPr')
xml = xml.slice(0, lastSect) + ENTRIES.map(([e]) => para(e)).join('') + xml.slice(lastSect)
const after: D.Pkg = { ...source, 'word/document.xml': strToU8(xml) }

const r = await checkReferences(source, after)
console.log(JSON.stringify({ added: r.added, verified: r.verified, mismatched: r.mismatched, fabricated: r.fabricated, raw_ids_in_body: r.raw_ids_in_body, citation_markers_added: r.citation_markers_added }, null, 1))
let ok = r.added === ENTRIES.length && r.raw_ids_in_body.length === 1 && r.citation_markers_added === 1
for (const [i, d] of r.details.entries()) {
  const want = ENTRIES[i]![1]
  const pass = d.status === want
  ok &&= pass
  console.log(`${pass ? '✓' : '✗'} ${d.status.padEnd(10)} 期望 ${want.padEnd(10)} ${d.source ?? '-'} ${d.score} ${d.note} ｜ ${d.entry.slice(0, 70)}`)
}
console.log(ok ? '自检通过' : '自检未通过')
process.exitCode = ok ? 0 : 1
