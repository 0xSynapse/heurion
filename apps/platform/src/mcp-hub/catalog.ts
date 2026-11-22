import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Embedder } from '../kb/embedder.ts'
import { MODULES, moduleOf, READ_ONLY_TOOLS, SHARED_TOOLS, type ModuleId } from '../mcp/modules.ts'
import type { Store } from '../store/db.ts'

/**
 * Heurion MCP Hub — 持久化工具目录与混合检索索引
 * - 将内置外部 MCP 工具与 3 个共享工作区工具（workspace_*）同步至 SQLite `mcp_tool_catalog` / `mcp_tool_fts`。
 * - 支持可选本地 BGE-M3 `Embedder` + FTS5 trigram + 词法前缀匹配的 Reciprocal Rank Fusion (RRF) 混合排序。
 * - 在排序截断前严格按机构外发策略（aegis_modules）、用户角色与 OAuth Scope 过滤。
 */

export type CatalogModule = ModuleId | 'workspace'
export type ToolRiskTier = 'read' | 'write' | 'confirm'

export interface CatalogToolSource {
  name: string
  description: string
  inputSchema?: Record<string, z.ZodTypeAny>
}

export interface CatalogToolClassification {
  module: CatalogModule
  requiredScope: string
  riskTier: ToolRiskTier
  readOnly: boolean
}

export interface CatalogEntry {
  tool_name: string
  module: CatalogModule
  summary: string
  description: string
  required_scope: string
  risk_tier: ToolRiskTier
  read_only: boolean
  input_schema: Record<string, unknown>
  schema_hash: string
}

interface StoredCatalogEntry extends CatalogEntry {
  embedding: Float32Array | null
}

export interface SearchToolsOptions {
  query: string
  module?: CatalogModule
  limit?: number
  filter?: (entry: CatalogEntry) => boolean
  embedder?: Embedder | null
}

export function classifyCatalogTool(name: string): CatalogToolClassification {
  const readOnly = READ_ONLY_TOOLS.has(name)
  if (SHARED_TOOLS.has(name)) {
    return {
      module: 'workspace',
      requiredScope: readOnly ? 'workspace:r' : 'workspace:rw',
      riskTier: readOnly ? 'read' : 'write',
      readOnly,
    }
  }
  const mod = moduleOf(name) ?? 'admin'
  const modDef = MODULES.find(m => m.id === mod)
  const isConfirm = Boolean(modDef?.leaseGated[name])
  const riskTier: ToolRiskTier = isConfirm ? 'confirm' : readOnly ? 'read' : 'write'
  return {
    module: mod,
    requiredScope: `${mod}:${readOnly ? 'r' : 'rw'}`,
    riskTier,
    readOnly,
  }
}

function normalizeRiskTier(tier: string): ToolRiskTier {
  if (tier === 'confirm') return 'confirm'
  if (tier === 'write') return 'write'
  return 'read'
}

function summarizeDescription(desc: string): string {
  const clean = desc.replace(/\s+/g, ' ').trim()
  if (clean.length <= 110) return clean
  const cut = clean.slice(0, 110)
  const sep = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('. '), cut.lastIndexOf('；'))
  return sep >= 36 ? cut.slice(0, sep + 1).trim() : `${cut.trimEnd()}…`
}

function zodShapeToJsonSchema(inputSchema?: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  if (!inputSchema || Object.keys(inputSchema).length === 0) {
    return { type: 'object', properties: {} }
  }
  try {
    const schema = z.toJSONSchema(z.object(inputSchema)) as Record<string, unknown>
    if ('$schema' in schema) delete schema.$schema
    return schema
  } catch {
    const properties: Record<string, unknown> = {}
    for (const key of Object.keys(inputSchema)) {
      properties[key] = { type: 'string' }
    }
    return { type: 'object', properties }
  }
}

function hashToolDefinition(name: string, description: string, schemaJson: string): string {
  return createHash('sha256').update(`${name}\n${description}\n${schemaJson}`, 'utf8').digest('hex').slice(0, 32)
}

function cosineDot(a: Float32Array, b: Float32Array): number {
  let dot = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!
  return dot
}

export class ToolCatalog {
  private readonly entries = new Map<string, StoredCatalogEntry>()
  private syncedOnce = false

  constructor(private readonly store: Store) {
    for (const row of store.listMcpToolCatalog()) {
      const meta = classifyCatalogTool(row.tool_name)
      let parsedSchema: Record<string, unknown> = { type: 'object', properties: {} }
      try { parsedSchema = JSON.parse(row.input_schema_json) as Record<string, unknown> } catch {}
      const emb = row.embedding
        ? new Float32Array(new Uint8Array(row.embedding).buffer)
        : null
      this.entries.set(row.tool_name, {
        tool_name: row.tool_name,
        module: meta.module,
        summary: row.summary,
        description: row.description,
        required_scope: meta.requiredScope,
        risk_tier: normalizeRiskTier(row.risk_tier),
        read_only: meta.readOnly,
        input_schema: parsedSchema,
        schema_hash: row.schema_hash,
        embedding: emb,
      })
    }
  }

  get size(): number {
    return this.entries.size
  }

  hasSynced(): boolean {
    return this.syncedOnce && this.entries.size > 0
  }

  syncTools(tools: ReadonlyArray<CatalogToolSource>): void {
    for (const t of tools) {
      const meta = classifyCatalogTool(t.name)
      const schemaObj = zodShapeToJsonSchema(t.inputSchema)
      const schemaJson = JSON.stringify(schemaObj)
      const schemaHash = hashToolDefinition(t.name, t.description, schemaJson)
      const existing = this.entries.get(t.name)
      if (existing && existing.schema_hash === schemaHash && existing.module === meta.module && existing.required_scope === meta.requiredScope) {
        continue
      }
      const summary = summarizeDescription(t.description)
      this.store.upsertMcpToolCatalog({
        tool_name: t.name,
        module: meta.module,
        summary,
        description: t.description,
        required_scope: meta.requiredScope,
        risk_tier: meta.riskTier,
        input_schema_json: schemaJson,
        embedding: existing?.embedding
          ? new Uint8Array(existing.embedding.buffer, existing.embedding.byteOffset, existing.embedding.byteLength)
          : null,
        schema_hash: schemaHash,
      })
      this.entries.set(t.name, {
        tool_name: t.name,
        module: meta.module,
        summary,
        description: t.description,
        required_scope: meta.requiredScope,
        risk_tier: meta.riskTier,
        read_only: meta.readOnly,
        input_schema: schemaObj,
        schema_hash: schemaHash,
        embedding: existing && existing.schema_hash === schemaHash ? existing.embedding : null,
      })
    }
    this.syncedOnce = true
  }

  describe(toolName: string): CatalogEntry | undefined {
    const e = this.entries.get(toolName)
    if (!e) return undefined
    const { embedding: _emb, ...pub } = e
    return pub
  }

  listAll(): CatalogEntry[] {
    return [...this.entries.values()].map(({ embedding: _emb, ...pub }) => pub)
  }

  async ensureEmbeddings(embedder?: Embedder | null): Promise<void> {
    if (!embedder) return
    if (!(await embedder.available().catch(() => false))) return
    const pending = [...this.entries.values()].filter(e => !e.embedding)
    if (pending.length === 0) return

    const BATCH = 32
    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH)
      const texts = slice.map(e => `${e.tool_name} (${e.module}): ${e.summary}\n${e.description.slice(0, 400)}`)
      const vecs = await embedder.embed(texts).catch(() => [])
      for (let j = 0; j < slice.length && j < vecs.length; j++) {
        const vec = vecs[j]!
        const item = slice[j]!
        item.embedding = vec
        this.store.setMcpToolEmbedding(item.tool_name, vec)
      }
    }
  }

  async search(opts: SearchToolsOptions): Promise<CatalogEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 30))
    const q = opts.query.trim()

    const candidates: StoredCatalogEntry[] = []
    for (const e of this.entries.values()) {
      if (opts.module && e.module !== opts.module) continue
      if (opts.filter && !opts.filter(e)) continue
      candidates.push(e)
    }
    if (candidates.length === 0) return []

    if (!q) {
      return candidates
        .sort((a, b) => a.module.localeCompare(b.module) || a.tool_name.localeCompare(b.tool_name))
        .slice(0, limit)
        .map(({ embedding: _emb, ...pub }) => pub)
    }

    const candidateMap = new Map(candidates.map(c => [c.tool_name, c]))
    const scores = new Map<string, number>()
    const bump = (name: string, delta: number) => {
      if (!candidateMap.has(name)) return
      scores.set(name, (scores.get(name) ?? 0) + delta)
    }

    // 1. 词法精确与前缀匹配（对短名与英文子串如 km / table1 / doc_ 特别稳健）
    const qLow = q.toLowerCase()
    const tokens = qLow.split(/\s+/).filter(Boolean)
    const lexicalScored = candidates
      .map(c => {
        const nLow = c.tool_name.toLowerCase()
        const hay = `${nLow} ${c.module} ${c.summary.toLowerCase()} ${c.description.toLowerCase()}`
        let s = 0
        if (nLow === qLow) s += 100
        else if (nLow.startsWith(qLow)) s += 40
        else if (nLow.includes(qLow)) s += 24
        for (const tok of tokens) {
          if (nLow.includes(tok)) s += 10
          if (c.module === tok) s += 8
          if (hay.includes(tok)) s += 3
        }
        return { name: c.tool_name, score: s }
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)

    lexicalScored.forEach((item, idx) => {
      const exactBoost = item.score >= 100 ? 5.0 : 0
      bump(item.name, exactBoost + 1 / (60 + idx + 1))
    })

    // 2. SQLite FTS5 trigram 检索
    const ftsHits = this.store.searchMcpToolsFts(q, 50).filter(h => candidateMap.has(h.tool_name))
    ftsHits.forEach((hit, idx) => {
      bump(hit.tool_name, 1 / (60 + idx + 1))
    })

    // 3. 可选本地 BGE-M3 向量 RRF 融合排序
    if (opts.embedder) {
      try {
        if (await opts.embedder.available()) {
          await this.ensureEmbeddings(opts.embedder)
          const qVecs = await opts.embedder.embed([q])
          const qVec = qVecs[0]
          if (qVec) {
            const vecRanked = candidates
              .filter(c => c.embedding && c.embedding.length > 0)
              .map(c => ({ name: c.tool_name, score: cosineDot(qVec, c.embedding!) }))
              .filter(x => x.score > 0.3)
              .sort((a, b) => b.score - a.score)
              .slice(0, 40)
            vecRanked.forEach((hit, idx) => {
              bump(hit.name, 1 / (60 + idx + 1))
            })
          }
        }
      } catch {
        // 向量服务不可用时静默降级至 FTS5 + 词法结果
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([name]) => candidateMap.get(name)!)
      .map(({ embedding: _emb, ...pub }) => pub)
  }
}
