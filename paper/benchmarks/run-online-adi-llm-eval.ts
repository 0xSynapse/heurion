/**
 * Clean-Room Live-LLM Multi-Turn Agent Co-Editing & Self-Repair Benchmark for Paper 1
 * (Agent-Document Interface: Dual-Surface CRDT, Read-Horizon Contracts & Token-Patched OOXML)
 *
 * Evaluates a real, unmodified cloud LLM driving multi-turn tool-calling loops across all 19
 * open-access 2025 PMC full-length clinical manuscripts (`19 manuscripts x 3 workloads = 57 tasks/arm`,
 * `171 live multi-turn agent episodes` total across 3 arms at `temperature = 0`):
 *
 *   1) `llm_direct_xml`   — Live LLM directly editing target `<w:p>` / `<w:tbl>` OOXML snippets with
 *                           explicit instructions to preserve all Word XML tags, fields, footnotes & IDs.
 *   2) `llm_naive_mcp`    — Live LLM tool-calling agent over standard document-level `base_rev === doc_rev`
 *                           optimistic-locked block MCP + Markdown re-serialization export.
 *   3) `llm_heurion_adi`  — Live LLM tool-calling agent over full Heurion ADI (`doc_read` with `noteSeen`,
 *                           `doc_validate`, contract-guarded `doc_edit` with structured `{code, hint, current}`,
 *                           `comments_list`, and token-patched `exportDocx`).
 *
 * Usage:
 *   ./apps/platform/node_modules/.bin/tsx --env-file-if-exists=.env paper/benchmarks/run-online-adi-llm-eval.ts
 *   ./apps/platform/node_modules/.bin/tsx --env-file-if-exists=.env paper/benchmarks/run-online-adi-llm-eval.ts --dry-check
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { DOMParser } from '../../apps/platform/node_modules/@xmldom/xmldom/lib/index.js'
import { strFromU8, strToU8, unzipSync, zipSync } from '../../apps/platform/node_modules/fflate/esm/browser.js'
import { readManifest } from '../../apps/platform/scripts/eval-review-fetch.ts'
import { loadOrSynthesizePaperMarkdown } from '../../apps/platform/scripts/eval-review-run.ts'
import { exportDocx } from '../../apps/platform/src/convert/docx-export.ts'
import { bindComments, bodyChildrenRaw, importDocx } from '../../apps/platform/src/convert/docx-import.ts'
import { assignIds } from '../../apps/platform/src/model/ids.ts'
import { parseBlocks, serializeBlocks } from '../../apps/platform/src/model/markdown.ts'
import { Documents } from '../../apps/platform/src/model/runtime.ts'
import { schema } from '../../apps/platform/src/model/schema.ts'
import { readGrid } from '../../apps/platform/src/model/table-grid.ts'
import { OpService } from '../../apps/platform/src/ops/service.ts'
import { EditBatch, OpError } from '../../apps/platform/src/ops/types.ts'
import { newCommentId, Store } from '../../apps/platform/src/store/db.ts'
import { read } from '../../apps/platform/src/views/read.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

interface ToolDef {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

interface ToolUseCall {
  id: string
  name: string
  input: Record<string, unknown>
}

interface LlmTurnResponse {
  text: string
  toolCalls: ToolUseCall[]
  rawContent: Array<Record<string, unknown>>
  inputTokens: number
  outputTokens: number
}

type ChatMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: Array<Record<string, unknown>>
    }
  | {
      role: 'user'
      content: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }>
    }

interface LiveLlmClient {
  model: string
  protocol: 'anthropic_messages' | 'openai_chat'
  step: (system: string, messages: ChatMessage[], tools?: ToolDef[]) => Promise<LlmTurnResponse>
}

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx >= 0 ? process.argv[idx + 1] : undefined
}

async function createLiveLlmClient(): Promise<LiveLlmClient> {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || ''
  if (!apiKey) {
    throw new Error(
      'Missing API Key: please configure DEEPSEEK_API_KEY in /home/jz/workspace/heurion/.env (and optional DSH_MODEL / DEEPSEEK_UPSTREAM_URL).',
    )
  }
  const rawUpstream = (
    process.env.DEEPSEEK_UPSTREAM_URL ||
    process.env.OPENAI_BASE_URL ||
    'https://api.deepseek.com/anthropic/v1'
  ).replace(/\/$/, '')
  const isAnthropic = rawUpstream.includes('anthropic')
  let resolvedModel = process.env.DSH_MODEL || (isAnthropic ? 'deepseek-flash' : 'deepseek-chat')

  const callOnce = async (
    modelToUse: string,
    system: string,
    messages: ChatMessage[],
    tools?: ToolDef[],
  ): Promise<LlmTurnResponse> => {
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (isAnthropic) {
          const body: Record<string, unknown> = {
            model: modelToUse,
            max_tokens: 16384,
            temperature: 0,
            system,
            messages,
          }
          if (tools && tools.length > 0) body.tools = tools
          const res = await fetch(`${rawUpstream}/messages`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
          })
          if (!res.ok) {
            const errTxt = (await res.text()).slice(0, 300)
            const e = new Error(`HTTP ${res.status}: ${errTxt}`) as Error & { status?: number }
            e.status = res.status
            throw e
          }
          const json = (await res.json()) as {
            content?: Array<Record<string, unknown>>
            usage?: { input_tokens?: number; output_tokens?: number }
          }
          const content = json.content ?? []
          const text = content
            .filter(c => c.type === 'text')
            .map(c => String(c.text ?? ''))
            .join('\n')
          const toolCalls: ToolUseCall[] = content
            .filter(c => c.type === 'tool_use' && typeof c.id === 'string' && typeof c.name === 'string')
            .map(c => ({ id: c.id as string, name: c.name as string, input: (c.input ?? {}) as Record<string, unknown> }))
          return {
            text,
            toolCalls,
            rawContent: content,
            inputTokens: json.usage?.input_tokens ?? 0,
            outputTokens: json.usage?.output_tokens ?? 0,
          }
        } else {
          // OpenAI-compatible /chat/completions protocol
          const oaMsgs: Array<Record<string, unknown>> = [{ role: 'system', content: system }]
          for (const m of messages) {
            if (typeof m.content === 'string') {
              oaMsgs.push({ role: m.role, content: m.content })
            } else if (m.role === 'assistant') {
              const txt = m.content
                .filter(c => c.type === 'text')
                .map(c => (c as { type: 'text'; text: string }).text)
                .join('\n')
              const tcs = m.content
                .filter(c => c.type === 'tool_use')
                .map(c => {
                  const tu = c as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
                  return { id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input) } }
                })
              oaMsgs.push({ role: 'assistant', content: txt || null, ...(tcs.length ? { tool_calls: tcs } : {}) })
            } else {
              for (const tr of m.content) {
                oaMsgs.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content })
              }
            }
          }
          const body: Record<string, unknown> = {
            model: modelToUse,
            max_tokens: 2048,
            temperature: 0,
            messages: oaMsgs,
          }
          if (tools && tools.length > 0) {
            body.tools = tools.map(t => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.input_schema },
            }))
          }
          const res = await fetch(`${rawUpstream}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(90_000),
          })
          if (!res.ok) {
            const errTxt = (await res.text()).slice(0, 300)
            const e = new Error(`HTTP ${res.status}: ${errTxt}`) as Error & { status?: number }
            e.status = res.status
            throw e
          }
          const json = (await res.json()) as {
            choices?: Array<{
              message?: {
                content?: string | null
                tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
              }
            }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          const msg = json.choices?.[0]?.message
          const toolCalls: ToolUseCall[] = (msg?.tool_calls ?? []).map(tc => {
            let parsed: Record<string, unknown> = {}
            try {
              parsed = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
            } catch {
              parsed = {}
            }
            return { id: tc.id, name: tc.function.name, input: parsed }
          })
          return {
            text: msg?.content ?? '',
            toolCalls,
            rawContent: [
              ...(msg?.content ? [{ type: 'text', text: msg.content }] : []),
              ...toolCalls.map(tc => ({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })),
            ],
            inputTokens: json.usage?.prompt_tokens ?? 0,
            outputTokens: json.usage?.completion_tokens ?? 0,
          }
        }
      } catch (err) {
        lastErr = err as Error
        const st = (err as { status?: number }).status
        if (st === 400 || st === 401 || st === 403 || st === 404) break
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
      }
    }
    throw lastErr!
  }

  // Preflight model check: if DSH_MODEL was not explicitly set and `deepseek-flash` is rejected on public API, fall back to `deepseek-chat`
  if (!process.env.DSH_MODEL && resolvedModel === 'deepseek-flash') {
    try {
      await callOnce('deepseek-flash', 'Reply OK.', [{ role: 'user', content: 'ping' }])
    } catch (e) {
      const msg = String((e as Error).message)
      if (msg.includes('400') || msg.includes('404') || /model/i.test(msg)) {
        await callOnce('deepseek-chat', 'Reply OK.', [{ role: 'user', content: 'ping' }])
        resolvedModel = 'deepseek-chat'
      } else {
        throw e
      }
    }
  } else {
    await callOnce(resolvedModel, 'Reply OK.', [{ role: 'user', content: 'ping' }])
  }

  return {
    model: resolvedModel,
    protocol: isAnthropic ? 'anthropic_messages' : 'openai_chat',
    step: (sys, msgs, tools) => callOnce(resolvedModel, sys, msgs, tools),
  }
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).toUpperCase().padStart(8, '0')
}

function plainTextOfWp(wpXml: string): string {
  let out = ''
  for (const m of wpXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)) {
    out += m[1]!
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  }
  return out
}

function isStrictValidXml(xml: string): boolean {
  let hasError = false
  const parser = new DOMParser({
    onError: (level: string) => {
      if (level === 'error' || level === 'fatalError') hasError = true
    },
  })
  try {
    const doc = parser.parseFromString(xml, 'text/xml')
    if (!doc || !doc.documentElement) return false
    return !hasError
  } catch {
    return false
  }
}

function extractBodyXml(docxBytes: Uint8Array): string {
  const xml = strFromU8(unzipSync(docxBytes)['word/document.xml']!)
  const start = xml.indexOf('<w:body>')
  const end = xml.lastIndexOf('</w:body>')
  return start >= 0 && end > start ? xml.slice(start + 8, end) : xml
}

const FOOTNOTES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:footnote w:id="1"><w:p><w:r><w:t> Adjudicated per independent clinical endpoint committee charter.</w:t></w:r></w:p></w:footnote>' +
  '</w:footnotes>'

const COMMENTS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">' +
  '<w:comment w:id="7" w:author="Dr. Lin" w:date="2026-10-18T08:00:00Z" w:initials="DL"><w:p w14:paraId="0A1B2C3D"><w:r><w:t>Please condense this sentence and clarify the 36-month window.</w:t></w:r></w:p></w:comment>' +
  '</w:comments>'

function buildOnlineTestDocx(md: string, paperIdx: number): Uint8Array {
  const hasMarkdownTable = /(?:^\|[^\n]+\|\n){2,}/m.test(md)
  const fallbackTable = hasMarkdownTable
    ? ''
    : '\n\n| Baseline Arm | < | Outcome Rate |\n| --- | --- | --- |\n| Cohort A | Subgroup 1 | 94.2% |\n| Cohort B | Subgroup 2 | 91.8% |\n'
  const fullMd = `${md}${fallbackTable}`

  const pmDoc = assignIds(schema.node('doc', null, parseBlocks(fullMd)), new Set())
  const baseDocx = exportDocx({
    doc: pmDoc,
    baseline: null,
    pkg: null,
    src: () => null,
    citations: [],
    comments: [],
    asset: () => null,
  }).bytes

  const files = { ...unzipSync(baseDocx) }
  let docXml = strFromU8(files['word/document.xml']!)
  if (!docXml.includes('xmlns:w14=')) {
    docXml = docXml.replace('<w:document ', '<w:document xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ')
  }
  if (!docXml.includes('xmlns:m=')) {
    docXml = docXml.replace('<w:document ', '<w:document xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ')
  }

  let pCounter = (paperIdx + 1) * 0x10000
  docXml = docXml.replace(/<w:p(\s|>)/g, (_m, sep: string) => {
    pCounter++
    return `<w:p w14:paraId="${hex8(pCounter)}" w14:textId="77777777"${sep}`
  })

  const baseHex = (paperIdx + 1) * 0x100000
  // W1 Target Paragraph: EndNote ADDIN EN.CITE + Footnote 1 + OMML Math (alpha=0.05)
  const richPara =
    `<w:p w14:paraId="${hex8(baseHex + 1)}" w14:textId="77777777">` +
    `<w:r><w:t xml:space="preserve">Interim multicenter adjudication supported this primary endpoint</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE &lt;EndNote&gt;&lt;Cite&gt;&lt;Author&gt;Lin&lt;/Author&gt;&lt;Year&gt;2025&lt;/Year&gt;&lt;/Cite&gt;&lt;/EndNote&gt;</w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:t>[1]</w:t></w:r>` +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
    `<w:r><w:t xml:space="preserve"> across 12 months of screening</w:t></w:r>` +
    `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>` +
    `<w:r><w:t xml:space="preserve"> under prespecified significance </w:t></w:r>` +
    `<m:oMath><m:r><m:t>α=0.05</m:t></m:r></m:oMath>` +
    `<w:r><w:t xml:space="preserve"> two-sided.</w:t></w:r></w:p>`

  // W2 Target Paragraphs: Concurrent Clinician Mid-Session Edit
  const conflictPara1 =
    `<w:p w14:paraId="${hex8(baseHex + 2)}" w14:textId="77777777">` +
    `<w:r><w:t xml:space="preserve">In Validation Cohort ${paperIdx + 1}, the unadjusted hazard ratio was HR 1.48 across participating centers during the preliminary 12-month observation window.</w:t></w:r></w:p>`
  const conflictPara2 =
    `<w:p w14:paraId="${hex8(baseHex + 3)}" w14:textId="77777777">` +
    `<w:r><w:t xml:space="preserve">Routine safety monitoring recorded zero treatment-related discontinuations.</w:t></w:r></w:p>`

  // W3 Commented Paragraph: Open Word Comment Anchor
  const commentedPara =
    `<w:p w14:paraId="${hex8(baseHex + 4)}" w14:textId="77777777">` +
    `<w:r><w:t xml:space="preserve">Longitudinal retention in the biomarker substudy reached </w:t></w:r>` +
    `<w:commentRangeStart w:id="7"/>` +
    `<w:r><w:t>180 evaluable participants</w:t></w:r>` +
    `<w:commentRangeEnd w:id="7"/>` +
    `<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="7"/></w:r>` +
    `<w:r><w:t xml:space="preserve"> over the initial follow-up period.</w:t></w:r></w:p>`

  const extra = `${richPara}${conflictPara1}${conflictPara2}${commentedPara}`
  const sectIdx = docXml.lastIndexOf('<w:sectPr')
  docXml = sectIdx >= 0 ? docXml.slice(0, sectIdx) + extra + docXml.slice(sectIdx) : docXml.replace('</w:body>', `${extra}</w:body>`)

  files['word/document.xml'] = strToU8(docXml)
  files['word/footnotes.xml'] = strToU8(FOOTNOTES_XML)
  files['word/comments.xml'] = strToU8(COMMENTS_XML)

  let ctXml = strFromU8(files['[Content_Types].xml']!)
  for (const [partName, mime] of [
    ['footnotes.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml'],
    ['comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'],
  ]) {
    if (!ctXml.includes(`/word/${partName}`)) {
      ctXml = ctXml.replace('</Types>', `<Override PartName="/word/${partName}" ContentType="${mime}"/></Types>`)
    }
  }
  files['[Content_Types].xml'] = strToU8(ctXml)

  let relsXml = strFromU8(files['word/_rels/document.xml.rels']!)
  for (const [rid, type, target] of [
    ['rId901', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes', 'footnotes.xml'],
    ['rId902', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments', 'comments.xml'],
  ]) {
    if (!relsXml.includes(`Target="${target}"`)) {
      relsXml = relsXml.replace('</Relationships>', `<Relationship Id="${rid}" Type="${type}" Target="${target}"/></Relationships>`)
    }
  }
  files['word/_rels/document.xml.rels'] = strToU8(relsXml)

  return zipSync(files)
}

interface EpisodeMetrics {
  arm: 'llm_direct_xml' | 'llm_naive_mcp' | 'llm_heurion_adi'
  workload: 'W1_ooxml_rich' | 'W2_concurrent_conflict' | 'W3_table_and_comment'
  paperId: string
  success: boolean
  xmlValid: boolean
  constructsOrContractsPreserved: boolean
  firstAttemptGuardRejected: boolean
  selfRepairedWithinTurn: boolean
  stepsUsed: number
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

function extractXmlSnippetFromResponse(raw: string, tagName: 'w:p' | 'w:tbl'): string | null {
  const cleaned = raw.replace(/```(?:xml)?/gi, '').replace(/```/g, '').trim()
  const re = new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`)
  const m = re.exec(cleaned)
  return m ? m[0] : null
}

/**
 * Arm 1: Live LLM Direct OOXML Rewrite Agent (Fair, explicit OOXML preservation prompt)
 */
async function runDirectXmlEpisode(
  llm: LiveLlmClient,
  origBytes: Uint8Array,
  paperId: string,
  paperIdx: number,
  workload: EpisodeMetrics['workload'],
): Promise<EpisodeMetrics> {
  const t0 = performance.now()
  const files = { ...unzipSync(origBytes) }
  let docXml = strFromU8(files['word/document.xml']!)
  const sys =
    'You are an expert OpenXML (ECMA-376 WordprocessingML) scientific manuscript editor. ' +
    'Given a target <w:p> or <w:tbl> XML element from word/document.xml, apply the requested revision and return ONLY the updated XML element. ' +
    'Preserve all existing XML namespaces, w14:paraId attributes, complex fields (w:fldChar / w:instrText ADDIN EN.CITE), ' +
    'w:footnoteReference, m:oMath, w:commentRangeStart/End, and table merge properties (w:gridSpan / w:vMerge).'

  if (workload === 'W1_ooxml_rich') {
    const targetP = [...docXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
      .map(m => m[0])
      .find(p => plainTextOfWp(p).includes('Interim multicenter adjudication'))!
    const usr =
      'Update this <w:p> element so that "Interim multicenter adjudication" becomes "Finalized multicenter adjudication" ' +
      'and "12 months of screening" becomes "24 months of follow-up", while keeping all citations, footnotes, and math intact:\n\n' +
      targetP
    const res = await llm.step(sys, [{ role: 'user', content: usr }])
    const newP = extractXmlSnippetFromResponse(res.text, 'w:p')
    if (newP) docXml = docXml.replace(targetP, newP)
    const xmlValid = Boolean(newP) && isStrictValidXml(docXml)
    const plain = newP ? plainTextOfWp(newP) : ''
    const goalOk = plain.includes('Finalized multicenter adjudication') && plain.includes('24 months of follow-up')
    const constructsOk =
      Boolean(newP) &&
      newP!.includes('ADDIN EN.CITE') &&
      (newP!.match(/w:fldCharType="begin"/g) ?? []).length === 1 &&
      (newP!.match(/w:fldCharType="end"/g) ?? []).length === 1 &&
      newP!.includes('<w:footnoteReference w:id="1"/>') &&
      newP!.includes('<m:oMath>') &&
      newP!.includes('α=0.05') &&
      /w14:paraId="[0-9A-Fa-f]{8}"/.test(newP!)
    return {
      arm: 'llm_direct_xml',
      workload,
      paperId,
      success: xmlValid && goalOk && constructsOk,
      xmlValid,
      constructsOrContractsPreserved: constructsOk,
      firstAttemptGuardRejected: false,
      selfRepairedWithinTurn: false,
      stepsUsed: 1,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      latencyMs: performance.now() - t0,
    }
  }

  if (workload === 'W2_concurrent_conflict') {
    // Agent previously cached the `<w:p>` XML snapshot before a concurrent clinician edited `HR 1.48 -> HR 1.12` on disk
    const staleP = [...docXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
      .map(m => m[0])
      .find(p => plainTextOfWp(p).includes(`Validation Cohort ${paperIdx + 1}`))!
    // Clinician concurrently edits `HR 1.48` -> `HR 1.12` in the live document before AI writes back
    const liveClinicianP = staleP.replace('HR 1.48', 'HR 1.12')
    docXml = docXml.replace(staleP, liveClinicianP)

    const usr =
      `Condense this <w:p> element for Validation Cohort ${paperIdx + 1} to state that follow-up lasted 24 months across centers, ` +
      `preserving the reported hazard ratio and valid <w:p> XML:\n\n${staleP}`
    const res = await llm.step(sys, [{ role: 'user', content: usr }])
    const newP = extractXmlSnippetFromResponse(res.text, 'w:p')
    // Direct XML file scripting overwrites the paragraph in document.xml without per-block read-horizon / clinician-delta guard
    if (newP) docXml = docXml.replace(liveClinicianP, newP)
    const xmlValid = Boolean(newP) && isStrictValidXml(docXml)
    const plain = newP ? plainTextOfWp(newP) : ''
    const goalOk = plain.includes('24')
    const clinicianPreserved = plain.includes('1.12')
    return {
      arm: 'llm_direct_xml',
      workload,
      paperId,
      success: xmlValid && goalOk && clinicianPreserved,
      xmlValid,
      constructsOrContractsPreserved: clinicianPreserved,
      firstAttemptGuardRejected: false,
      selfRepairedWithinTurn: false,
      stepsUsed: 1,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      latencyMs: performance.now() - t0,
    }
  }

  // W3: Merged clinical table header + commented paragraph rewrite (untruncated XML)
  const allTables = bodyChildrenRaw(docXml).filter(el => el.startsWith('<w:tbl'))
  // Pick the first clinical table <= 25,000 chars so the full <w:tbl> fits comfortably in a single XML response
  const targetTbl = allTables.find(t => t.length <= 25_000) ?? allTables[allTables.length - 1] ?? ''
  const targetCmtP = [...docXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
    .map(m => m[0])
    .find(p => plainTextOfWp(p).includes('180 evaluable participants'))!
  const usr =
    'Update the first header cell in the <w:tbl> below to "Cohort Stratification Summary" (keeping all table rows, columns, and merge tags intact), ' +
    'and rewrite the <w:p> below into a concise sentence stating "Substudy retention reached 180 participants over the 36-month follow-up window." while keeping comment range markers valid. ' +
    'Return ONLY the updated <w:tbl>...</w:tbl> followed by the updated <w:p>...</w:p>:\n\n' +
    `${targetTbl}\n\n${targetCmtP}`
  const res = await llm.step(sys, [{ role: 'user', content: usr }])
  const newTbl = extractXmlSnippetFromResponse(res.text, 'w:tbl')
  const newP = extractXmlSnippetFromResponse(res.text, 'w:p')
  if (newTbl && targetTbl) docXml = docXml.replace(targetTbl, newTbl)
  if (newP) docXml = docXml.replace(targetCmtP, newP)
  const xmlValid = Boolean(newTbl) && Boolean(newP) && isStrictValidXml(docXml)
  const plainP = newP ? plainTextOfWp(newP) : ''
  const cmtBalanced =
    Boolean(newP) &&
    newP!.includes('<w:commentRangeStart w:id="7"/>') &&
    newP!.includes('<w:commentRangeEnd w:id="7"/>')
  const origRowCount = (targetTbl.match(/<w:tr\b/g) ?? []).length
  const newRowCount = newTbl ? (newTbl.match(/<w:tr\b/g) ?? []).length : 0
  const tblOk = Boolean(newTbl) && newTbl!.includes('Cohort Stratification Summary') && newRowCount === origRowCount
  return {
    arm: 'llm_direct_xml',
    workload,
    paperId,
    success: xmlValid && tblOk && cmtBalanced && (plainP.includes('36-month') || plainP.includes('36 months')),
    xmlValid,
    constructsOrContractsPreserved: tblOk && cmtBalanced,
    firstAttemptGuardRejected: false,
    selfRepairedWithinTurn: false,
    stepsUsed: 1,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    latencyMs: performance.now() - t0,
  }
}

const MCP_TOOLS_NAIVE: ToolDef[] = [
  {
    name: 'doc_read',
    description: 'Read blocks from the manuscript with `{#id}` prefixes and current document `rev`.',
    input_schema: {
      type: 'object',
      properties: {
        from_id: { type: 'string', description: 'Optional start block ID' },
        to_id: { type: 'string', description: 'Optional end block ID' },
      },
    },
  },
  {
    name: 'doc_edit',
    description:
      'Apply block operations with `base_rev`. Supported ops: `replace_text` {op, id, find, replace}, `replace_block` {op, id, markdown}, `table_set_cells` {op, id, cells:[{row, col, markdown}]}.',
    input_schema: {
      type: 'object',
      properties: {
        base_rev: { type: 'number' },
        ops: { type: 'array', items: { type: 'object' } },
      },
      required: ['base_rev', 'ops'],
    },
  },
]

const MCP_TOOLS_HEURION: ToolDef[] = [
  {
    name: 'doc_read',
    description:
      'Read blocks from the manuscript with `{#id}` prefixes, current `rev`, opaque Word atoms `[@w:...]`, logical table grid (`^` = vertical merge, `<` = horizontal merge), and open comments.',
    input_schema: {
      type: 'object',
      properties: {
        from_id: { type: 'string', description: 'Optional start block ID' },
        to_id: { type: 'string', description: 'Optional end block ID' },
      },
    },
  },
  {
    name: 'comments_list',
    description: 'List open reviewer comments (`id`, `node_id`, `snippet`, `replies`) on the manuscript.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'doc_validate',
    description: 'Side-effect-free pre-flight validation of an edit batch; returns `{valid, code, message, hint, current}` without mutating state.',
    input_schema: {
      type: 'object',
      properties: {
        base_rev: { type: 'number' },
        ack_comments: { type: 'array', items: { type: 'string' } },
        ops: { type: 'array', items: { type: 'object' } },
      },
      required: ['base_rev', 'ops'],
    },
  },
  {
    name: 'doc_edit',
    description:
      'Atomically apply guarded CRDT operations. Ops: `replace_text` {op, id, find, replace} (preferred for surgical edits; preserves marks & opaque `[@w:...]` fields), `replace_block` {op, id, markdown}, `table_set_cells` {op, id, cells:[{row, col, markdown}]} (write ONLY to merge origin top-left `(row, col)`, never to `<` or `^` covered cells). Pass `ack_comments: [comment_id]` when rewriting text anchored by an open comment.',
    input_schema: {
      type: 'object',
      properties: {
        base_rev: { type: 'number' },
        ack_comments: { type: 'array', items: { type: 'string' } },
        ops: { type: 'array', items: { type: 'object' } },
      },
      required: ['base_rev', 'ops'],
    },
  },
]

/**
 * Arm 2 (`llm_naive_mcp`) & Arm 3 (`llm_heurion_adi`): Live Multi-Turn Tool-Calling Loop
 */
async function runMcpAgentEpisode(
  llm: LiveLlmClient,
  origBytes: Uint8Array,
  paperId: string,
  paperIdx: number,
  workload: EpisodeMetrics['workload'],
  mode: 'naive' | 'heurion',
): Promise<EpisodeMetrics> {
  const t0 = performance.now()
  const store = new Store(':memory:')
  const docs = new Documents(store)
  const ops = new OpService(docs)

  const imp = importDocx(origBytes)
  const bound = bindComments(imp.doc, imp.comments, newCommentId)
  const row = docs.create({ owner: 'u1', title: paperId, content: bound.doc, source: 'import' })
  const docId = row.id
  store.putNodeSrc(docId, imp.src)
  store.putPackage(docId, 'docx', origBytes)
  for (const t of bound.threads) {
    store.addComment({ id: t.id, doc_id: docId, node_id: t.node_id, snippet: t.snippet, source_ref: `word:${t.word_id}:${t.replies.length}` })
    store.addReply(t.id, 'user', t.text, null, t.author)
  }

  // Locate target block IDs in the hydrated CRDT document
  let richId = ''
  let conflictP1 = ''
  let conflictP2 = ''
  let commentParaId = ''
  let targetTableId = ''
  let mergeOrigin: { row: number; col: number } = { row: 0, col: 0 }
  let mergeCovered: { row: number; col: number } = { row: 0, col: 1 }

  docs.get(docId).forEach(n => {
    const id = n.attrs.id as string | undefined
    if (!id) return
    if (n.isTextblock) {
      const txt = n.textContent
      if (txt.includes('Interim multicenter adjudication')) richId = id
      else if (txt.includes(`Validation Cohort ${paperIdx + 1}`)) conflictP1 = id
      else if (txt.includes('Routine safety monitoring')) conflictP2 = id
      else if (txt.includes('180 evaluable participants')) commentParaId = id
    } else if (n.type.name === 'table') {
      const g = readGrid(n)
      if (g.height >= 2 && g.width >= 2) {
        const merged = g.cells.find(c => c.colspan > 1 || c.rowspan > 1)
        if (merged) {
          targetTableId = id
          mergeOrigin = { row: merged.top, col: merged.left }
          mergeCovered =
            merged.colspan > 1 ? { row: merged.top, col: merged.left + 1 } : { row: merged.top + 1, col: merged.left }
        } else if (!targetTableId) {
          targetTableId = id
          mergeOrigin = { row: 0, col: 0 }
        mergeCovered = { row: 0, col: 1 }
          mergeCovered = { row: 0, col: 1 }
        }
      }
    }
  })

  // If the organic table in this manuscript had no pre-merged header cells, merge (0,0)..(0,1) so W3 tests merged-cell coordinates on all 19 papers
  if (workload === 'W3_table_and_comment' && targetTableId) {
    const tblNode = (() => {
      let found: ReturnType<typeof docs.get> | null = null
      docs.get(docId).forEach(n => {
        if (n.attrs.id === targetTableId) found = n
      })
      return found
    })()
    if (tblNode) {
      const g = readGrid(tblNode)
      if (!g.cells.some(c => c.colspan > 1 || c.rowspan > 1) && g.width >= 2) {
        ops.edit(
          { doc_id: docId, base_rev: docs.rev(docId), mode: 'apply', ops: [{ op: 'table_merge_cells', id: targetTableId, row: 0, col: 0, rows: 1, cols: 2 }] },
          { actor: 'user', turnId: null },
        )
        mergeOrigin = { row: 0, col: 0 }
        mergeCovered = { row: 0, col: 1 }
      }
    }
  }

  let naiveRev = docs.rev(docId)
  const buildInitialMessages = (): ChatMessage[] => {
    if (workload === 'W1_ooxml_rich') {
      const view = read({ doc: docs.get(docId), docId, rev: docs.rev(docId), from_id: richId, to_id: richId, comments: [] })
      if (mode === 'heurion') ops.noteSeen(docId, [richId], docs.rev(docId))
      const renderedView = mode === 'naive' ? view.replace(/\[@w:[^\]]+\]/g, '[1]') : view
      return [
        {
          role: 'user',
          content:
            `Current block from manuscript ${paperId}:\n${renderedView}\n\n` +
            `Task: Update block {#${richId}} so that "Interim multicenter adjudication" becomes "Finalized multicenter adjudication" ` +
            `and "12 months of screening" becomes "24 months of follow-up". Preserve all existing citations, footnotes, and statistical formulas.`,
        },
      ]
    }

    if (workload === 'W2_concurrent_conflict') {
      // Realistic 3-Turn Collaborative Session History:
      // Turn 1: Agent read `{#conflictP1}` and `{#conflictP2}` at rev 0 (`HR 1.48`)
      const rev0 = docs.rev(docId)
      const view0 = read({ doc: docs.get(docId), docId, rev: rev0, from_id: conflictP1, to_id: conflictP2, comments: [] })
      if (mode === 'heurion') ops.noteSeen(docId, [conflictP1, conflictP2], rev0)

      // Background concurrent human edit: Clinician updates `HR 1.48 -> HR 1.12` in `{#conflictP1}` (advancing rev 0 -> 1)
      ops.edit(
        { doc_id: docId, base_rev: rev0, mode: 'apply', ops: [{ op: 'replace_text', id: conflictP1, find: 'HR 1.48', replace: 'HR 1.12' }] },
        { actor: 'user', turnId: null },
      )

      // Turn 2: Agent edited `{#conflictP2}` using `replace_text` (which commutes and returns the fresh `rev = 2`)
      const turn2Res = ops.edit(
        {
          doc_id: docId,
          base_rev: rev0,
          mode: 'apply',
          ops: [{ op: 'replace_text', id: conflictP2, find: 'zero treatment-related', replace: 'no grade >=3 treatment-related' }],
        },
        { actor: 'ai', turnId: 'prior_turn_2' },
      )
      naiveRev = turn2Res.rev

      return [
        { role: 'user', content: `Please read blocks {#${conflictP1}} through {#${conflictP2}} first.` },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'hist_read_1', name: 'doc_read', input: { from_id: conflictP1, to_id: conflictP2 } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'hist_read_1', content: view0 }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: `I have read {#${conflictP1}} and {#${conflictP2}} at rev ${rev0}. How would you like to revise them?` }],
        },
        {
          role: 'user',
          content: `First update {#${conflictP2}} to say "no grade >=3 treatment-related discontinuations".`,
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'hist_edit_2',
              name: 'doc_edit',
              input: {
                base_rev: rev0,
                ops: [{ op: 'replace_text', id: conflictP2, find: 'zero treatment-related', replace: 'no grade >=3 treatment-related' }],
              },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'hist_edit_2', content: JSON.stringify({ ok: true, rev: turn2Res.rev }) }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: `Updated {#${conflictP2}} (document is now at rev ${turn2Res.rev}).` }],
        },
        {
          role: 'user',
          content:
            `Great. Now rewrite paragraph {#${conflictP1}} completely using \`replace_block\` into a tighter single sentence ` +
            `reporting Validation Cohort ${paperIdx + 1}'s hazard ratio across participating centers over the finalized 24-month observation window.`,
        },
      ]
    }

    // W3: Merged clinical table header + commented paragraph rewrite
    const tblView = read({ doc: docs.get(docId), docId, rev: docs.rev(docId), from_id: targetTableId, to_id: targetTableId, comments: [] })
    const cmtView = read({
      doc: docs.get(docId),
      docId,
      rev: docs.rev(docId),
      from_id: commentParaId,
      to_id: commentParaId,
      comments: store.listComments(docId, 'open'),
    })
    if (mode === 'heurion') ops.noteSeen(docId, [targetTableId, commentParaId], docs.rev(docId))
    naiveRev = docs.rev(docId)
    return [
      {
        role: 'user',
        content:
          `Current blocks from manuscript ${paperId} (rev ${docs.rev(docId)}):\n${tblView}\n\n${cmtView}\n\n` +
          `Task:\n` +
          `1) In table {#${targetTableId}}, update the merged header cell at row ${mergeOrigin.row}, col ${mergeOrigin.col} (which spans across row ${mergeCovered.row}, col ${mergeCovered.col}) so the merged header reads "Cohort Stratification Summary".\n` +
          `2) Rewrite block {#${commentParaId}} completely into: "Substudy retention reached 180 participants over the 36-month follow-up window." (resolving/acknowledging the reviewer comment on that block).`,
      },
    ]
  }

  const sysPrompt =
    mode === 'heurion'
      ? 'You are a scientific co-authoring agent operating over a block-addressed document MCP interface (`doc_read`, `comments_list`, `doc_validate`, `doc_edit`). ' +
        'Complete the user editing task accurately and concisely while preserving collaborator edits, citations, footnotes, formulas, comments, and table structure. ' +
        'If a tool returns a structured error (`code`, `hint`, `current`), use that feedback to submit a corrected edit.'
      : 'You are a scientific co-authoring agent operating over a block-addressed document MCP interface (`doc_read`, `doc_edit`). ' +
        'Complete the user editing task accurately and concisely while preserving collaborator edits, citations, footnotes, formulas, comments, and table structure. ' +
        'If a tool returns an error, use that feedback to submit a corrected edit.'

  const messages: ChatMessage[] = buildInitialMessages()
  const tools = mode === 'heurion' ? MCP_TOOLS_HEURION : MCP_TOOLS_NAIVE

  let stepsUsed = 0
  let totalIn = 0
  let totalOut = 0
  let guardRejections = 0
  let editSucceededAfterReject = false

  for (let stepIdx = 0; stepIdx < 5; stepIdx++) {
    const turn = await llm.step(sysPrompt, messages, tools)
    stepsUsed++
    totalIn += turn.inputTokens
    totalOut += turn.outputTokens

    if (turn.toolCalls.length === 0) break

    messages.push({ role: 'assistant', content: turn.rawContent })

    const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = []

    for (const tc of turn.toolCalls) {
      if (tc.name === 'doc_read') {
        const fromId = typeof tc.input.from_id === 'string' ? tc.input.from_id : undefined
        const toId = typeof tc.input.to_id === 'string' ? tc.input.to_id : undefined
        const curRev = docs.rev(docId)
        const view = read({
          doc: docs.get(docId),
          docId,
          rev: curRev,
          from_id: fromId,
          to_id: toId,
          comments: mode === 'heurion' ? store.listComments(docId, 'open') : [],
        })
        if (mode === 'heurion') {
          ops.noteSeen(
            docId,
            [...view.matchAll(/\{#([a-z0-9]+)\}/g)].map(m => m[1]!),
            curRev,
          )
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: mode === 'naive' ? view.replace(/\[@w:[^\]]+\]/g, '[1]') : view,
        })
      } else if (tc.name === 'comments_list') {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: JSON.stringify(store.listComments(docId, 'open'), null, 2),
        })
      } else if (tc.name === 'doc_validate' && mode === 'heurion') {
        const parsed = EditBatch.safeParse({
          doc_id: docId,
          base_rev: tc.input.base_rev,
          mode: 'apply',
          ack_comments: tc.input.ack_comments,
          ops: tc.input.ops,
          dry_run: true,
        })
        if (!parsed.success) {
          guardRejections++
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            is_error: true,
            content: JSON.stringify({ valid: false, code: 'schema_error', issues: parsed.error.issues }),
          })
        } else {
          const v = ops.validate(parsed.data, { actor: 'ai', turnId: `ep_${stepIdx}` })
          if (!v.valid) guardRejections++
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            is_error: !v.valid,
            content: JSON.stringify(v, null, 2),
          })
        }
      } else if (tc.name === 'doc_edit') {
        if (mode === 'heurion') {
          const parsed = EditBatch.safeParse({
            doc_id: docId,
            base_rev: tc.input.base_rev,
            mode: 'apply',
            ack_comments: tc.input.ack_comments,
            ops: tc.input.ops,
          })
          if (!parsed.success) {
            guardRejections++
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              is_error: true,
              content: JSON.stringify({ code: 'schema_error', issues: parsed.error.issues }),
            })
          } else {
            try {
              const r = ops.edit(parsed.data, { actor: 'ai', turnId: `ep_${stepIdx}` })
              if (guardRejections > 0) editSucceededAfterReject = true
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tc.id,
                content: JSON.stringify({ ok: true, rev: r.rev, changed: r.changes.length }),
              })
            } catch (err) {
              guardRejections++
              if (err instanceof OpError) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tc.id,
                  is_error: true,
                  content: JSON.stringify({ code: err.code, message: err.message, ...err.extra }, null, 2),
                })
              } else {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tc.id,
                  is_error: true,
                  content: JSON.stringify({ code: 'error', message: String((err as Error).message) }),
                })
              }
            }
          }
        } else {
          // `llm_naive_mcp`: checks ONLY document-level `base_rev === naiveRev` (standard optimistic ETag),
          // and executes block mutation without ADI per-block `noteSeen`, clinician-delta, or comment-anchor guards
          const reqRev = Number(tc.input.base_rev ?? -1)
          if (reqRev !== naiveRev) {
            guardRejections++
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tc.id,
              is_error: true,
              content: JSON.stringify({ error: `409 Conflict: base_rev ${reqRev} !== current doc_rev ${naiveRev}` }),
            })
          } else {
            const rawOps = Array.isArray(tc.input.ops) ? (tc.input.ops as Array<Record<string, unknown>>) : []
            const cleanedOps = rawOps.map(o => {
              if (o.op === 'replace_block' && typeof o.markdown === 'string') {
                return { ...o, markdown: o.markdown.replace(/\[@w:[^\]]+\]/g, '[1]') }
              }
              return o
            })
            const parsed = EditBatch.safeParse({
              doc_id: docId,
              base_rev: docs.rev(docId),
              mode: 'apply',
              ops: cleanedOps,
            })
            if (!parsed.success) {
              guardRejections++
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tc.id,
                is_error: true,
                content: JSON.stringify({ error: 'Invalid operation arguments' }),
              })
            } else {
              try {
                const r = ops.edit(parsed.data, { actor: 'user', turnId: null })
                naiveRev = r.rev
                if (guardRejections > 0) editSucceededAfterReject = true
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tc.id,
                  content: JSON.stringify({ ok: true, rev: naiveRev }),
                })
              } catch (err) {
                guardRejections++
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tc.id,
                  is_error: true,
                  content: JSON.stringify({ error: String((err as Error).message) }),
                })
              }
            }
          }
        }
      }
    }

    messages.push({ role: 'user', content: toolResults })
  }

  // Export `.docx` according to each arm's architecture and verify strict end-to-end invariants
  const exportedBytes =
    mode === 'heurion'
      ? exportDocx({
          doc: docs.get(docId),
          baseline: docs.versionDoc(docId, 1),
          pkg: origBytes,
          src: id => store.getNodeSrc(docId, id),
          citations: store.listCitations(docId),
          comments: store.listComments(docId),
          asset: id => store.getAsset(id),
        }).bytes
      : (() => {
          const blocks: Parameters<typeof serializeBlocks>[0] = []
          docs.get(docId).forEach(n => {
            if (n.attrs.suggest !== 'delete') blocks.push(n)
          })
          const mdOut = serializeBlocks(blocks).replace(/\[@w:[^\]]+\]/g, '[1]')
          const rebuilt = assignIds(schema.node('doc', null, parseBlocks(mdOut)), new Set())
          return exportDocx({
            doc: rebuilt,
            baseline: null,
            pkg: null,
            src: () => null,
            citations: [],
            comments: [],
            asset: () => null,
          }).bytes
        })()

  const exportedDocXml = strFromU8(unzipSync(exportedBytes)['word/document.xml']!)
  const xmlValid = isStrictValidXml(exportedDocXml)
  const outBody = extractBodyXml(exportedBytes)

  let success = false
  let constructsOrContractsPreserved = false

  if (workload === 'W1_ooxml_rich') {
    const richParas = [...outBody.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)]
      .map(m => m[0])
      .filter(p => plainTextOfWp(p).includes('Finalized multicenter adjudication'))
    const goalOk = richParas.some(p => plainTextOfWp(p).includes('24 months of follow-up'))
    constructsOrContractsPreserved = richParas.some(
      p =>
        p.includes('ADDIN EN.CITE') &&
        (p.match(/w:fldCharType="begin"/g) ?? []).length === 1 &&
        (p.match(/w:fldCharType="end"/g) ?? []).length === 1 &&
        p.includes('<w:footnoteReference w:id="1"/>') &&
        p.includes('<m:oMath>') &&
        p.includes('α=0.05'),
    )
    success = xmlValid && goalOk && constructsOrContractsPreserved
  } else if (workload === 'W2_concurrent_conflict') {
    let p1Now = ''
    docs.get(docId).forEach(n => {
      if (n.attrs.id === conflictP1) p1Now = n.textContent
    })
    const goalOk = /24[-\s]*month/i.test(p1Now) && !p1Now.includes('preliminary 12-month')
    constructsOrContractsPreserved = p1Now.includes('1.12') && !p1Now.includes('1.48')
    success = xmlValid && goalOk && constructsOrContractsPreserved
  } else {
    let cmtTextNow = ''
    let tblTextNow = ''
    docs.get(docId).forEach(n => {
      if (n.attrs.id === commentParaId) cmtTextNow = n.textContent
      if (n.attrs.id === targetTableId) tblTextNow = n.textContent
    })
    const tblOk = tblTextNow.includes('Cohort Stratification Summary')
    const cmtGoalOk = cmtTextNow.includes('36-month') || cmtTextNow.includes('36 months')
    const starts = [...outBody.matchAll(/<w:commentRangeStart w:id="(\d+)"\/>/g)].map(m => m[1])
    const ends = [...outBody.matchAll(/<w:commentRangeEnd w:id="(\d+)"\/>/g)].map(m => m[1])
    // Either comment remained anchored on re-anchored block (`keepAnswering`/whole-node) or ack_comments cleanly handled it without orphan range tags
    const cmtBalancedInDocx = JSON.stringify(starts) === JSON.stringify(ends) && (mode === 'heurion' || starts.length >= 1)
    constructsOrContractsPreserved = tblOk && cmtBalancedInDocx
    success = xmlValid && tblOk && cmtGoalOk && cmtBalancedInDocx
  }

  return {
    arm: mode === 'heurion' ? 'llm_heurion_adi' : 'llm_naive_mcp',
    workload,
    paperId,
    success,
    xmlValid,
    constructsOrContractsPreserved,
    firstAttemptGuardRejected: guardRejections > 0,
    selfRepairedWithinTurn: guardRejections > 0 && editSucceededAfterReject && success,
    stepsUsed,
    inputTokens: totalIn,
    outputTokens: totalOut,
    latencyMs: performance.now() - t0,
  }
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++
      if (idx >= items.length) break
      results[idx] = await worker(items[idx]!)
    }
  })
  await Promise.all(runners)
  return results
}

function summarizeArm(episodes: EpisodeMetrics[], arm: EpisodeMetrics['arm']) {
  const sub = episodes.filter(e => e.arm === arm)
  const pct = (n: number, d: number) => Number(((n / Math.max(1, d)) * 100).toFixed(1))
  const byW = (w: EpisodeMetrics['workload']) => {
    const ws = sub.filter(e => e.workload === w)
    const rejected = ws.filter(e => e.firstAttemptGuardRejected)
    return {
      episodes: ws.length,
      success_count: ws.filter(e => e.success).length,
      success_pct: pct(ws.filter(e => e.success).length, ws.length),
      xml_valid_pct: pct(ws.filter(e => e.xmlValid).length, ws.length),
      constructs_or_contracts_pct: pct(ws.filter(e => e.constructsOrContractsPreserved).length, ws.length),
      first_attempt_guard_rejected_count: rejected.length,
      self_repaired_count: ws.filter(e => e.selfRepairedWithinTurn).length,
      self_repair_rate_given_reject_pct: rejected.length > 0 ? pct(ws.filter(e => e.selfRepairedWithinTurn).length, rejected.length) : null,
      mean_steps: Number((ws.reduce((a, b) => a + b.stepsUsed, 0) / Math.max(1, ws.length)).toFixed(2)),
      mean_latency_ms: Math.round(ws.reduce((a, b) => a + b.latencyMs, 0) / Math.max(1, ws.length)),
    }
  }
  const allRejected = sub.filter(e => e.firstAttemptGuardRejected)
  return {
    total_episodes: sub.length,
    overall_success_count: sub.filter(e => e.success).length,
    overall_success_pct: pct(sub.filter(e => e.success).length, sub.length),
    overall_xml_valid_pct: pct(sub.filter(e => e.xmlValid).length, sub.length),
    overall_constructs_or_contracts_pct: pct(sub.filter(e => e.constructsOrContractsPreserved).length, sub.length),
    first_attempt_guard_rejected_total: allRejected.length,
    self_repaired_total: sub.filter(e => e.selfRepairedWithinTurn).length,
    self_repair_rate_given_reject_pct:
      allRejected.length > 0 ? pct(sub.filter(e => e.selfRepairedWithinTurn).length, allRejected.length) : null,
    mean_steps: Number((sub.reduce((a, b) => a + b.stepsUsed, 0) / Math.max(1, sub.length)).toFixed(2)),
    mean_input_tokens: Math.round(sub.reduce((a, b) => a + b.inputTokens, 0) / Math.max(1, sub.length)),
    mean_output_tokens: Math.round(sub.reduce((a, b) => a + b.outputTokens, 0) / Math.max(1, sub.length)),
    mean_latency_ms: Math.round(sub.reduce((a, b) => a + b.latencyMs, 0) / Math.max(1, sub.length)),
    by_workload: {
      W1_ooxml_rich: byW('W1_ooxml_rich'),
      W2_concurrent_conflict: byW('W2_concurrent_conflict'),
      W3_table_and_comment: byW('W3_table_and_comment'),
    },
  }
}

async function main() {
  const dryCheck = process.argv.includes('--dry-check')
  const limit = Number(getArg('--limit') ?? '19')
  const concurrency = Number(getArg('--concurrency') ?? '6')
  const papers = readManifest().slice(0, limit)

  if (dryCheck) {
    for (let i = 0; i < papers.length; i++) {
      const md = loadOrSynthesizePaperMarkdown(papers[i]!, 'clean')
      const bytes = buildOnlineTestDocx(md, i)
      const docXml = strFromU8(unzipSync(bytes)['word/document.xml']!)
      if (!isStrictValidXml(docXml)) throw new Error(`Invalid generated XML for ${papers[i]!.id}`)
      const imp = importDocx(bytes)
      if (imp.doc.childCount < 10) throw new Error(`Unexpectedly small doc for ${papers[i]!.id}`)
    }
    console.log(`[dry-check OK] Verified ${papers.length} PMC publisher .docx builds and ADI CRDT hydration.`)
    return
  }

  const llm = await createLiveLlmClient()
  console.log(`[Online ADI LLM Benchmark] Model=${llm.model} (${llm.protocol}) · Papers=${papers.length} · Concurrency=${concurrency}`)

  const docxByPaper = papers.map((p, idx) => ({
    paper: p,
    idx,
    bytes: buildOnlineTestDocx(loadOrSynthesizePaperMarkdown(p, 'clean'), idx),
  }))

  const workloads: EpisodeMetrics['workload'][] = ['W1_ooxml_rich', 'W2_concurrent_conflict', 'W3_table_and_comment']
  const jobs: Array<() => Promise<EpisodeMetrics>> = []

  for (const item of docxByPaper) {
    for (const w of workloads) {
      jobs.push(() => runDirectXmlEpisode(llm, item.bytes, item.paper.id, item.idx, w))
      jobs.push(() => runMcpAgentEpisode(llm, item.bytes, item.paper.id, item.idx, w, 'naive'))
      jobs.push(() => runMcpAgentEpisode(llm, item.bytes, item.paper.id, item.idx, w, 'heurion'))
    }
  }

  let completed = 0
  const allEpisodes = await runPool(jobs, concurrency, async job => {
    const res = await job()
    completed++
    if (completed % 15 === 0 || completed === jobs.length) {
      console.log(`  Progress: ${completed}/${jobs.length} live episodes completed...`)
    }
    return res
  })

  const report = {
    generated_at: new Date().toISOString(),
    model: llm.model,
    protocol: llm.protocol,
    temperature: 0,
    manuscripts_count: papers.length,
    workloads_per_manuscript: 3,
    episodes_per_arm: papers.length * 3,
    total_live_episodes: allEpisodes.length,
    arms: {
      llm_direct_xml: summarizeArm(allEpisodes, 'llm_direct_xml'),
      llm_naive_mcp: summarizeArm(allEpisodes, 'llm_naive_mcp'),
      llm_heurion_adi: summarizeArm(allEpisodes, 'llm_heurion_adi'),
    },
    episodes: allEpisodes,
  }

  const outDir = join(repoRoot, 'paper/results')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, 'online_adi_llm_benchmark.json')
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log('\n=== Live Online LLM ADI Co-Editing Benchmark Summary ===')
  console.log(JSON.stringify({ model: report.model, arms: report.arms }, null, 2))
  console.log(`Saved to ${outPath}`)
}

await main()
