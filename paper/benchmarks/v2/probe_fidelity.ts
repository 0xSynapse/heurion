/**
 * Word 往返保真度检查（不调用模型）：每篇论文的四种起始稿（原稿、复杂模板、带医生待采纳修订、带医生批注）
 * 导入平台后不做任何修改直接导出，与原文件逐项比对：正文段落 XML、表格、各部件文件、模板特征、修订与批注。
 * 用于确认「导入 → 导出」本身不丢东西，再比较编辑层面的差异（ANALYSIS_PLAN_v2 §2.7）。
 *   cd apps/platform && npx tsx --env-file-if-exists=../../.env ../../paper/benchmarks/v2/probe_fidelity.ts [--port 8893]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { client, type Client } from '../exp3/client.ts'
import * as D from '../exp3/docx.ts'
import { repoRoot, startServer, stopServer } from '../exp3/server.ts'
import { COMMENTS } from '../manuscripts/compare.ts'
import { PAPERS, targets, type PaperTopic } from '../manuscripts/tasks.ts'
import { complexTemplate, featureState } from './templates.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const { values } = parseArgs({ options: { port: { type: 'string', default: '8893' } } })

async function upload(c: Client, pkg: D.Pkg, title: string): Promise<string> {
  const form = new FormData()
  form.append('file', new File([Buffer.from(D.saveDocx(pkg))], `${title}.docx`))
  const res = await fetch(`${c.base}/api/docs`, { method: 'POST', headers: { Authorization: c.auth }, body: form })
  if (!res.ok) throw new Error(`导入失败 ${res.status} ${await res.text()}`)
  return ((await res.json()) as { id: string }).id
}
async function exportOf(c: Client, docId: string): Promise<D.Pkg> {
  const res = await fetch(`${c.base}/api/docs/${docId}/export.docx`, { headers: { Authorization: c.auth } })
  return D.openDocx(new Uint8Array(await res.arrayBuffer()))
}

const sameBytes = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i])
const body = (pkg: D.Pkg) => { const x = D.docXml(pkg); return x.slice(x.indexOf('<w:body>'), x.indexOf('</w:body>')) }

/** 逐项比对：正文是否逐字节一致；不一致时列出变了的段落与部件。 */
function compare(src: D.Pkg, out: D.Pkg) {
  const srcParas = D.paras(body(src))
  const outBody = body(out)
  const changedParas = srcParas.filter(p => !outBody.includes(p.xml))
  const tables = (pkg: D.Pkg) => [...body(pkg).matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map(m => m[0])
  const srcTables = tables(src)
  const parts = [...new Set([...Object.keys(src), ...Object.keys(out)])].filter(k => k !== 'word/document.xml' && !sameBytes(src[k], out[k]))
  return {
    body_identical: body(src) === outBody,
    paras: srcParas.length,
    paras_changed: changedParas.length,
    changed_examples: changedParas.slice(0, 3).map(p => ({ text: p.text.slice(0, 80), xml: p.xml.slice(0, 300) })),
    tables: srcTables.length,
    tables_changed: srcTables.filter(t => !outBody.includes(t)).length,
    parts_changed: parts,
    text_identical: D.paras(body(src)).map(p => p.text).join('\n') === D.paras(outBody).map(p => p.text).join('\n'),
  }
}

/** 一篇论文的四种起始稿。 */
function variants(t: PaperTopic): Array<{ name: string; pkg: D.Pkg; check?: (out: D.Pkg) => Record<string, boolean> }> {
  const src = D.openDocx(new Uint8Array(readFileSync(join(here, '../manuscripts/data/docx', `${t.pmcid}.docx`))))
  const out: ReturnType<typeof variants> = [{ name: 'plain', pkg: src }]
  try {
    const { pkg, features } = complexTemplate(src)
    out.push({ name: 'template', pkg, check: o => ({ ...featureState(o, features) }) })
  } catch { /* 不能生成复杂模板的论文跳过 */ }
  const tg = targets(t)
  const tracked = D.humanTrackedChange(src, tg.res1.slice(0, 60), tg.res1Phrase, `${tg.res1Phrase} (intention-to-treat population)`, 'Dong Qian')
  if (tracked) out.push({ name: 'tracked', pkg: tracked, check: o => ({ tracked_kept: /<w:ins\b[^>]*w:author="Dong Qian"/.test(D.docXml(o)) && /<w:del\b[^>]*w:author="Dong Qian"/.test(D.docXml(o)) }) })
  let commented: D.Pkg | null = D.humanComment(src, tg.methods.first.slice(0, 60), tg.methods.snippets[0], COMMENTS[0], 'Dong Qian', 0)
  commented = commented && D.humanComment(commented, tg.methods.first.slice(0, 60), tg.methods.snippets[1], COMMENTS[1], 'Dong Qian', 1)
  if (commented) out.push({ name: 'comments', pkg: commented, check: o => Object.fromEntries(COMMENTS.map((c, i) => [`comment_${i}`, D.commentAnchored(o, c)])) })
  return out
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const server = await startServer('fidelity', Number(values.port), join(here, '../exp3/data', `fidelity-${stamp}`), join(here, '../exp3/data', 'fidelity-server.log'), { PROCEDURAL_MODE: 'off' })
const rows: Array<Record<string, unknown>> = []
try {
  const c = client(server.base, 'fidelity')
  for (const t of [...PAPERS.train, ...PAPERS.heldout]) {
    for (const v of variants(t)) {
      const id = await upload(c, v.pkg, `${t.pmcid}-${v.name}`)
      const out = await exportOf(c, id)
      const cmp = compare(v.pkg, out)
      const features = v.check?.(out) ?? {}
      const lost = Object.entries(features).filter(([, ok]) => !ok).map(([k]) => k)
      rows.push({ paper: t.pmcid, variant: v.name, ...cmp, features_lost: lost })
      console.log(`${t.pmcid} ${v.name.padEnd(9)} 正文${cmp.body_identical ? '一致' : `不一致：段落 ${cmp.paras_changed}/${cmp.paras}，表格 ${cmp.tables_changed}/${cmp.tables}，文字${cmp.text_identical ? '一致' : '不同'}`}；部件变化 ${cmp.parts_changed.join(',') || '无'}；特征丢失 ${lost.join(',') || '无'}`)
    }
  }
} finally {
  stopServer(server)
}
const dir = join(repoRoot, 'paper/results/v2-fidelity')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(rows, null, 2))
console.log(`结果：${join(dir, `${stamp}.json`)}`)
