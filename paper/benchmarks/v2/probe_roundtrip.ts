/**
 * 复杂模板往返探针（不调用模型）：每种版式特征单独上传一份文档，以人类身份在特征所在段落做一次编辑，
 * 导出后检查特征是否仍在；同时记录 AI 读视图里能否看到合作者批注与修订。用于在设计 S1 任务前了解平台的支持范围。
 *   cd apps/platform && npx tsx --env-file-if-exists=../../.env ../../paper/benchmarks/v2/probe_roundtrip.ts [--port 8890]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { client, readAll, type Client } from '../exp3/client.ts'
import * as D from '../exp3/docx.ts'
import { repoRoot, startServer, stopServer } from '../exp3/server.ts'
import { blocks, plain } from '../manuscripts/tasks.ts'
import { COAUTHOR_COMMENT, complexTemplate, featureState, type FeatureState, type TemplateFeatures } from './templates.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const { values } = parseArgs({ options: { port: { type: 'string', default: '8890' }, papers: { type: 'string', default: '3' } } })
const corpus = JSON.parse(readFileSync(join(here, '../manuscripts/corpus.json'), 'utf8')) as Array<{ pmcid: string }>

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

/**
 * 按文字找块：块 id 可能不在行首（列表项为 “1. {#id} …”）；去掉不可编辑块前缀 “[不可编辑·…：”、
 * 待采纳修订标签 “⟨待采纳·…⟩”、Word 行内标记 “[@w:key]” 与数字（域代码显示为标记，原文里是编号）后比较。
 */
function blockOf(view: string, leadText: string): { id: string; text: string; raw: string } | undefined {
  const norm = (s: string) => s.replace(/\[@w:[a-z0-9]+\]/g, '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim()
  const key = norm(leadText).slice(0, 36)
  for (const line of view.split('\n')) {
    const m = /\{#([a-z0-9]+)\}\s?(.*)$/.exec(line)
    if (!m) continue
    const text = plain(m[2]!).replace(/^\[不可编辑·[^：]*：/, '').replace(/^⟨待采纳·[^⟩]*⟩\s*/, '').replace(/\s+/g, ' ')
    if (norm(text).startsWith(key)) return { id: m[1]!, text, raw: line }
  }
  return undefined
}
const words = (s: string, from: number, n: number) => plain(s).split(' ').slice(from, from + n).join(' ')

type Probe = { feature: keyof FeatureState; build: (view: string, f: TemplateFeatures) => object | null }

/** 每种特征：在它所在的段落（或表格）上做一次最小编辑。 */
const PROBES: Probe[] = [
  // 列表项不能用 replace_text（平台提示改用 replace_block）
  { feature: 'list_numbered', build: (v, f) => { const b = blockOf(v, f.list.items[0]!); return b && { op: 'replace_block', id: b.id, markdown: `1. ${b.text} (revised)` } } },
  { feature: 'table_merged', build: v => { const b = blocks(v).find(x => x.raw.includes('\n|')); return b && { op: 'table_insert_rows', id: b.id, at: 2, rows: [Array(b.raw.split('\n').find(l => l.startsWith('|'))!.split('|').length - 2).fill('NR').map((x, i) => (i === 0 ? 'New row' : x))] } } },
  { feature: 'caption_fields', build: (v, f) => { const b = blockOf(v, f.captions[0]!); return b && { op: 'replace_text', id: b.id, find: words(b.text, 2, 2), replace: `${words(b.text, 2, 2)} (revised)` } } },
  { feature: 'footnote_kept', build: (v, f) => { const b = blockOf(v, f.footnote.para); return b && { op: 'replace_text', id: b.id, find: words(b.text, 0, 3), replace: `${words(b.text, 0, 3)} (revised)` } } },
  { feature: 'tracked_kept', build: (v, f) => { const b = blockOf(v, f.tracked.para); return b && { op: 'replace_text', id: b.id, find: words(b.text, 0, 3), replace: `${words(b.text, 0, 3)} (revised)` } } },
  { feature: 'comment_kept', build: (v, f) => { const b = blockOf(v, f.comment.para); return b && { op: 'replace_text', id: b.id, find: words(b.text, 0, 3), replace: `${words(b.text, 0, 3)} (revised)` } } },
  { feature: 'section_break_kept', build: (v, f) => { const b = blockOf(v, f.sectionBreakPara); return b && { op: 'replace_text', id: b.id, find: words(b.text, 0, 3), replace: `${words(b.text, 0, 3)} (revised)` } } },
]

const out: Array<Record<string, unknown>> = []
const server = await startServer('probe', Number(values.port), join(here, '../exp3/data', `probe-${Date.now()}`), join(here, '../exp3/data', 'probe-server.log'), { PROCEDURAL_MODE: 'off' })
try {
  const c = client(server.base, 'probe-u1')
  for (const { pmcid } of corpus.slice(0, Number(values.papers))) {
    const base = D.openDocx(new Uint8Array(readFileSync(join(here, '../manuscripts/data/docx', `${pmcid}.docx`))))
    let built: ReturnType<typeof complexTemplate>
    try { built = complexTemplate(base) } catch (e) {
      out.push({ pmcid, template_error: String((e as Error).message) })
      console.log(`${pmcid} 模板生成失败：${(e as Error).message}`)
      continue
    }
    const { pkg, features } = built
    const asBuilt = featureState(pkg, features)
    // 不编辑，直接往返
    const id0 = await upload(c, pkg, `probe-${pmcid}-none`)
    const view = await readAll(c, id0)
    const roundtrip = featureState(await exportOf(c, id0), features)
    const sees = {
      coauthor_comment: view.includes(COAUTHOR_COMMENT),
      tracked_as_pending: (await c.api(`/api/docs/${id0}`)).suggestions?.length > 0,
      footnote_text: view.includes('Data sources and definitions'),
      footnote_para_locked: /不可编辑|只读|opaque/i.test(blockOf(view, features.footnote.para)?.raw ?? ''),
    }
    const edits: Record<string, unknown> = {}
    for (const p of PROBES) {
      const id = await upload(c, pkg, `probe-${pmcid}-${p.feature}`)
      const v = await readAll(c, id)
      const op = p.build(v, features)
      if (!op) { edits[p.feature] = { error: '找不到目标块' }; continue }
      let error: string | null = null
      try {
        await c.api(`/api/docs/${id}/edit`, { method: 'POST', body: JSON.stringify({ base_rev: Number(/rev=(\d+)/.exec(v)![1]), mode: 'apply', ops: [op] }) })
      } catch (e) { error = String((e as Error).message).slice(0, 160) }
      edits[p.feature] = { error, kept: featureState(await exportOf(c, id), features)[p.feature] }
    }
    const row = { pmcid, as_built: asBuilt, roundtrip_no_edit: roundtrip, ai_view: sees, edit_then_export: edits }
    out.push(row)
    console.log(JSON.stringify(row, null, 1))
  }
} finally {
  stopServer(server)
}
const dir = join(repoRoot, 'paper/results/v2-probe')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(out, null, 1))
