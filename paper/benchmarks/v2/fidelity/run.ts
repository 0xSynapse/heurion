/**
 * 复杂格式往返保真度（不调用模型）：fixtures.ts 的每个夹具放进一篇真实论文，分四层检查导出的 .docx：
 *   L0 导入后直接导出；L1 改特征前面的普通段落；L2 在特征段落里改「句一」（表格夹具改单元格）；
 *   L3 像 AI 那样整段替换特征段落（取读视图里该段的 markdown，只改「句二」再 replace_block）。
 * 每层检查：特征标记仍在、XML 结构完整（各部件可解析、关系与引用 id 对得上、域与书签成对、段落 ID 不重复、
 * 修订 id 不重复、每个部件都有内容类型），以及 LibreOffice 能打开（转成纯文本后含特征段落文字）。
 *   cd apps/platform && npx tsx --env-file-if-exists=../../.env ../../paper/benchmarks/v2/fidelity/run.ts [--only id,...] [--port 8894] [--no-office]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { strFromU8, strToU8 } from '../../../../apps/platform/node_modules/fflate/esm/browser.js'
import { client, readAll, type Client } from '../../exp3/client.ts'
import * as D from '../../exp3/docx.ts'
import { repoRoot, startServer, stopServer } from '../../exp3/server.ts'
import { plain } from '../../manuscripts/tasks.ts'
import { bodyChildrenRaw } from '../../../../apps/platform/src/convert/docx-import.ts'
import { integrity, opens, wellFormed } from './check.ts'
import { FIXTURES, NUMBERING_ABSTRACT, NUMBERING_NUM, t, type Fixture } from './fixtures.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const { values } = parseArgs({ options: { only: { type: 'string' }, port: { type: 'string', default: '8894' }, 'no-office': { type: 'boolean', default: false }, base: { type: 'string', default: 'PMC9396773' }, lo: { type: 'boolean', default: false } } })

// —— 组装测试稿 ——

const text = (pkg: D.Pkg, name: string) => (pkg[name] ? strFromU8(pkg[name]!) : null)
const put = (pkg: D.Pkg, name: string, s: string): D.Pkg => ({ ...pkg, [name]: strToU8(s) })

function build(f: Fixture): D.Pkg {
  let pkg = D.openDocx(new Uint8Array(readFileSync(join(here, '../../manuscripts/data/docx', `${values.base}.docx`))))
  let xml = D.docXml(pkg)
  const refs = D.paras(xml).find(p => D.headingLevel(p) > 0 && /^References\s*$/.test(p.text.trim()))
  const at = refs ? xml.indexOf(refs.xml) : xml.lastIndexOf('<w:sectPr')
  const pp = (s: string) => `<w:p><w:pPr><w:spacing w:line="480" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>${t(s)}</w:p>`
  xml = xml.slice(0, at) + pp('Plain paragraph before the fixture.') + f.block + pp('Plain paragraph after the fixture.') + xml.slice(at)
  // 根元素补上夹具用到的命名空间
  const root = /<w:document\b[^>]*>/.exec(xml)![0]
  const need: Record<string, string> = { w14: 'http://schemas.microsoft.com/office/word/2010/wordml', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' }
  let nroot = root
  for (const [k, v] of Object.entries(need)) if (!nroot.includes(`xmlns:${k}=`)) nroot = nroot.replace(/>$/, ` xmlns:${k}="${v}">`)
  xml = xml.replace(root, nroot)
  pkg = put(pkg, 'word/document.xml', xml)
  for (const [name, body] of Object.entries(f.parts ?? {})) pkg = { ...pkg, [name]: typeof body === 'string' ? strToU8(body) : body }
  if (f.rels?.length) pkg = put(pkg, 'word/_rels/document.xml.rels', text(pkg, 'word/_rels/document.xml.rels')!.replace('</Relationships>', `${f.rels.join('')}</Relationships>`))
  let types = text(pkg, '[Content_Types].xml')!
  for (const ty of f.types ?? []) {
    const ext = /Extension="([^"]+)"/.exec(ty)?.[1]
    const part = /PartName="([^"]+)"/.exec(ty)?.[1]
    if ((ext && types.includes(`Extension="${ext}"`)) || (part && types.includes(`PartName="${part}"`))) continue
    types = types.replace('</Types>', `${ty}</Types>`)
  }
  pkg = put(pkg, '[Content_Types].xml', types)
  if (f.block.includes('w:numId w:val="93')) {
    const num = text(pkg, 'word/numbering.xml')
    if (num) {
      const firstNum = num.indexOf('<w:num ')
      const withAbs = firstNum >= 0 ? num.slice(0, firstNum) + NUMBERING_ABSTRACT + num.slice(firstNum) : num.replace('</w:numbering>', `${NUMBERING_ABSTRACT}</w:numbering>`)
      pkg = put(pkg, 'word/numbering.xml', withAbs.replace('</w:numbering>', `${NUMBERING_NUM}</w:numbering>`))
    } else throw new Error('底稿没有 numbering.xml')
  }
  return pkg
}

// —— 检查 ——

function markers(f: Fixture, pkg: D.Pkg): string[] {
  if (values.lo) return []
  return f.must.filter(m => !m.re.test(text(pkg, m.part ?? 'word/document.xml') ?? '')).map(m => m.label)
}

/** LibreOffice 打开并转成纯文本，看特征段落的文字是否在。 */
function opensFixture(pkg: D.Pkg): string | null {
  if (values['no-office']) return null
  return opens(pkg, /Editable sentence|Edited sentence|Rewritten sentence/)
}

/** 用 LibreOffice 另存为 docx（另一种软件写出的 docx：XML 写法、编号、样式都与 Word 不同）。 */
function resave(pkg: D.Pkg): D.Pkg | null {
  const dir = mkdtempSync(join(tmpdir(), 'fidelity-lo-'))
  mkdirSync(join(dir, 'out'))
  writeFileSync(join(dir, 'x.docx'), D.saveDocx(pkg))
  try {
    execFileSync('soffice', [`-env:UserInstallation=file://${dir}/profile`, '--headless', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', join(dir, 'out'), join(dir, 'x.docx')], { stdio: 'ignore', timeout: 90_000 })
    return D.openDocx(new Uint8Array(readFileSync(join(dir, 'out', 'x.docx'))))
  } catch {
    return null
  }
}

const bodyOf = (pkg: D.Pkg) => { const x = D.docXml(pkg); return x.slice(x.indexOf('<w:body'), x.lastIndexOf('</w:body>')) }

// —— 平台操作 ——

async function upload(c: Client, pkg: D.Pkg, title: string): Promise<string> {
  const form = new FormData()
  form.append('file', new File([Buffer.from(D.saveDocx(pkg))], `${title}.docx`))
  const res = await fetch(`${c.base}/api/docs`, { method: 'POST', headers: { Authorization: c.auth }, body: form })
  if (!res.ok) throw new Error(`导入失败 ${res.status} ${(await res.text()).slice(0, 200)}`)
  return ((await res.json()) as { id: string }).id
}
async function exportOf(c: Client, docId: string): Promise<D.Pkg> {
  const res = await fetch(`${c.base}/api/docs/${docId}/export.docx`, { headers: { Authorization: c.auth } })
  if (!res.ok) throw new Error(`导出失败 ${res.status} ${(await res.text()).slice(0, 200)}`)
  return D.openDocx(new Uint8Array(await res.arrayBuffer()))
}
/** 读视图里含某段文字的块（块 id 不一定在行首：列表项、表格）；同一段有待采纳修订时取修订版（AI 按守卫提示也会改修订版）。 */
function blockWith(view: string, needle: string): { id: string; raw: string } | null {
  let cur: { id: string; raw: string } | null = null
  const hits: Array<{ id: string; raw: string }> = []
  for (const line of view.split('\n')) {
    const m = /\{#([a-z0-9]+)\}/.exec(line)
    if (m) cur = { id: m[1]!, raw: line }
    else if (cur && line.startsWith('|')) cur.raw += '\n' + line
    if (cur && plain(line).includes(needle) && !hits.includes(cur)) hits.push(cur)
  }
  return hits.find(h => h.raw.includes('⟨待采纳·新增')) ?? hits[0] ?? null
}
async function edit(c: Client, docId: string, ops: object[]): Promise<string | null> {
  const view = await readAll(c, docId)
  const rev = Number(/rev=(\d+)/.exec(view)![1])
  try {
    await c.api(`/api/docs/${docId}/edit`, { method: 'POST', body: JSON.stringify({ base_rev: rev, mode: 'apply', ops }) })
    return null
  } catch (err) {
    return String((err as Error).message).slice(0, 200)
  }
}

type Layer = 'L0' | 'L1' | 'L2' | 'L3'
async function layer(c: Client, f: Fixture, src: D.Pkg, which: Layer): Promise<Record<string, unknown>> {
  const id = await upload(c, src, `${f.id}-${which}`)
  let opError: string | null = null
  let viewLine: string | null = null
  const view = await readAll(c, id)
  const b = blockWith(view, 'Editable sentence one')
  viewLine = b?.raw.slice(0, 400) ?? null
  if (which === 'L1') {
    const p = blockWith(view, 'Plain paragraph before the fixture')
    opError = p ? await edit(c, id, [{ op: 'replace_text', id: p.id, find: 'Plain paragraph before', replace: 'Plain paragraph (edited) before' }]) : '找不到前一段'
  } else if (which === 'L2') {
    if (!b) opError = '读视图里找不到特征段落'
    // 表格单元格里的段落也有自己的块 id，同样用 replace_text
    else opError = await edit(c, id, [{ op: 'replace_text', id: b.id, find: 'Editable sentence one', replace: 'Edited sentence one' }])
  } else if (which === 'L3') {
    const target = f.table ? blockWith(view, 'Editable sentence two') : b
    if (!target) opError = '读视图里找不到特征段落'
    else {
      // 去掉行首的块 id 与只读的提示标签，其余（含 [@w:…] 标记）原样带回
      const md = target.raw.split('\n')[0]!.replace(/\{#[a-z0-9]+\}\s?/, '').replace(/⟨待采纳[^⟩]*⟩\s*/, '')
      opError = md.includes('Editable sentence two') ? await edit(c, id, [{ op: 'replace_block', id: target.id, markdown: md.replace('Editable sentence two', 'Rewritten sentence two') }]) : '整段 markdown 里没有句二'
    }
  }
  const out = await exportOf(c, id)
  writeFileSync(join(docxDir, `${f.id}-${which}.docx`), D.saveDocx(out))
  // 改动是否写进了文件（按去掉标签的全文找：文本框里嵌套的段落会让按段落切分出错）
  const plainOut = D.docXml(out).replace(/<w:delText\b[^>]*>[^<]*<\/w:delText>/g, '').replace(/<[^>]+>/g, '')
  const textOk = which === 'L0' ? true : (which === 'L1' ? /Plain paragraph \(edited\) before/ : which === 'L2' ? /Edited sentence one/ : /Rewritten sentence two/).test(plainOut)
  // 除被改的那一块外，原文正文的每个顶层块都须原样出现在导出文件里
  const outXml = D.docXml(out)
  const untouchedLost = bodyChildrenRaw(D.docXml(src)).filter(k => !outXml.includes(k)).length - (which === 'L0' || opError ? 0 : 1)
  return {
    layer: which, op_error: opError, view: which === 'L0' ? viewLine : undefined,
    edit_applied: opError ? false : textOk,
    untouched_lost: Math.max(0, untouchedLost),
    markers_lost: markers(f, out), xml_errors: wellFormed(out), integrity: integrity(out), office: which === 'L0' || which === 'L3' ? opensFixture(out) : null,
    // 只比正文（根元素上补声明的命名空间不算差异）
    body_identical: which === 'L0' ? bodyOf(src) === bodyOf(out) : undefined,
  }
}

// —— 主流程 ——

const fixtures = values.only ? FIXTURES.filter(f => values.only!.split(',').includes(f.id)) : FIXTURES
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dir = join(repoRoot, 'paper/results/v2-fidelity')
const docxDir = join(dir, `complex${values.lo ? "-lo" : ""}-${stamp}`)
mkdirSync(docxDir, { recursive: true })
const server = await startServer('fidelity', Number(values.port), join(here, '../../exp3/data', `fidelity2-${stamp}`), join(here, '../../exp3/data', 'fidelity2-server.log'), { PROCEDURAL_MODE: 'off' })
const rows: Array<Record<string, unknown>> = []
try {
  const c = client(server.base, 'fidelity')
  for (const f of fixtures) {
    let src: D.Pkg
    try { src = build(f) } catch (err) { console.log(`${f.id}：组装失败 ${(err as Error).message}`); continue }
    if (values.lo) {
      const re = resave(src)
      if (!re) { console.log(`${f.id}：LibreOffice 另存失败`); continue }
      src = re
    }
    writeFileSync(join(docxDir, `${f.id}-source.docx`), D.saveDocx(src))
    // 夹具本身必须完整（否则是夹具写错了，不是平台的问题）
    // LibreOffice 另存后特征的写法会变，只做通用检查（不查特征标记）
    const pre = [...(values.lo ? [] : markers(f, src).map(x => `标记 ${x}`)), ...wellFormed(src), ...integrity(src)]
    if (pre.length) { console.log(`${f.id}：夹具本身有问题 ${pre.join('；')}`); rows.push({ fixture: f.id, group: f.group, fixture_error: pre }); continue }
    for (const which of ['L0', 'L1', 'L2', 'L3'] as Layer[]) {
      let r: Record<string, unknown>
      try { r = await layer(c, f, src, which) } catch (err) { r = { layer: which, fatal: String((err as Error).message).slice(0, 200) } }
      rows.push({ fixture: f.id, group: f.group, ...r })
      const problems = [
        r.fatal && `出错 ${r.fatal}`,
        r.op_error && `操作被拒 ${r.op_error}`,
        which !== 'L0' && which !== 'L1' && !r.op_error && r.edit_applied === false && '改动没有出现在导出文件里',
        (r.markers_lost as string[] | undefined)?.length && `丢失 ${(r.markers_lost as string[]).join('、')}`,
        (r.xml_errors as string[] | undefined)?.length && `XML ${(r.xml_errors as string[]).join('；')}`,
        (r.integrity as string[] | undefined)?.length && `完整性 ${(r.integrity as string[]).join('；')}`,
        r.office,
        which === 'L0' && r.body_identical === false && '正文不逐字节一致',
        (r.untouched_lost as number) > 0 && `其他块被改动 ${r.untouched_lost} 个`,
        which === 'L1' && r.edit_applied === false && !r.op_error && '改动没有出现在导出文件里',
      ].filter(Boolean)
      console.log(`${f.id.padEnd(26)} ${which} ${problems.length ? `✗ ${problems.join(' | ')}` : '✓'}`)
    }
  }
} finally {
  stopServer(server)
}
writeFileSync(join(dir, `complex${values.lo ? '-lo' : ''}-${stamp}.json`), JSON.stringify(rows, null, 2))
console.log(`结果：${join(dir, `complex${values.lo ? '-lo' : ''}-${stamp}.json`)}`)
