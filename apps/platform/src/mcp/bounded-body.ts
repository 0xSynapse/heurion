/**
 * 有界 HTTP 请求体流式读取器，防止外部伪造或超大 JSON-RPC 请求在进入 MCP 传输层前耗尽内存。
 */

export const MAX_PUBLIC_MCP_BODY_BYTES = 1 * 1024 * 1024
export const MAX_AUTH_MCP_BODY_BYTES = 20 * 1024 * 1024

function payloadTooLargeResponse(maxBytes: number): Response {
  const mb = maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / (1024 * 1024))}MB` : `${maxBytes}B`
  return new Response(
    JSON.stringify({
      error: `请求体超过 ${mb} 上限 / Request body exceeds ${mb} limit`,
      code: 'payload_too_large',
    }),
    {
      status: 413,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    },
  )
}

/** 流式读取 `Request` 请求体并强制字节上限，超出即取消流并返回 `413 Payload Too Large`。 */
export async function readBoundedBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; response: Response }> {
  const clRaw = req.headers.get('content-length')
  if (clRaw !== null) {
    const cl = Number(clRaw)
    if (Number.isFinite(cl) && cl > maxBytes) {
      return { ok: false, response: payloadTooLargeResponse(maxBytes) }
    }
  }
  if (!req.body) {
    return { ok: true, bytes: new Uint8Array(0) }
  }

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, response: payloadTooLargeResponse(maxBytes) }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  if (chunks.length === 0) return { ok: true, bytes: new Uint8Array(0) }
  if (chunks.length === 1) return { ok: true, bytes: chunks[0]! }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes: merged }
}

/** 将 `Uint8Array` 切片为独立的 `ArrayBuffer`，直接兼容标准 `Request` constructor 的 `BodyInit`。 */
export function toRequestBody(bytes: Uint8Array): ArrayBuffer | undefined {
  if (bytes.byteLength === 0) return undefined
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
