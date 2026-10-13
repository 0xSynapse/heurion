import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { fileURLToPath } from 'node:url'

/**
 * 嵌入模型（MIGRATION_PLAN.md R2）：默认 Xenova/bge-m3 的 8 位量化版（约 570MB，中英文都好）；
 * EMBED_MODEL / EMBED_DTYPE 可改（如 BAAI/bge-m3 + fp32，约 2.1GB）。模型缓存在仓库 data/embedder-cache（不进 git）。
 * 国内网络可设 HF_ENDPOINT=https://hf-mirror.com。
 */
export const MODEL = process.env.EMBED_MODEL || 'Xenova/bge-m3'
export const DTYPE = (process.env.EMBED_DTYPE || 'q8') as 'q8' | 'fp32' | 'fp16' | 'int8'

env.cacheDir = process.env.EMBED_CACHE_DIR || fileURLToPath(new URL('../../../data/embedder-cache/', import.meta.url))
if (process.env.HF_ENDPOINT) env.remoteHost = process.env.HF_ENDPOINT.replace(/\/?$/, '/')

let loading: Promise<FeatureExtractionPipeline> | null = null

export function loadModel(onProgress?: (p: { file?: string; progress?: number; status?: string }) => void): Promise<FeatureExtractionPipeline> {
  loading ??= (pipeline('feature-extraction', MODEL, {
    dtype: DTYPE,
    progress_callback: onProgress as never,
  }) as unknown as Promise<FeatureExtractionPipeline>).catch(err => {
    loading = null
    throw err
  })
  return loading
}

/** 文本 → 归一化向量（bge-m3 用 CLS 池化）。 */
export async function embed(texts: string[], batch = 16): Promise<number[][]> {
  const extractor = await loadModel()
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += batch) {
    const t = await extractor(texts.slice(i, i + batch), { pooling: 'cls', normalize: true })
    out.push(...(t.tolist() as number[][]))
  }
  return out
}
