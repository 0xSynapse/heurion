import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { apiSecurityHeaders, sniffInlineMime, userFileHeaders } from '../src/http/file-headers.ts'

describe('用户内容下发策略（file-headers）', () => {
  it('只按魔数识别 PDF 与常见位图，声明类型不参与判断', () => {
    expect(sniffInlineMime(new TextEncoder().encode('%PDF-1.7\n...'))).toBe('application/pdf')
    expect(sniffInlineMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png')
    expect(sniffInlineMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffInlineMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffInlineMime(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull()
    expect(sniffInlineMime(new TextEncoder().encode('<html><script>'))).toBeNull()
  })

  it('识别不出的原件一律二进制附件；文件名按 RFC 5987 编码', () => {
    const h = userFileHeaders('化验单.html', new TextEncoder().encode('<html>'))
    expect(h['Content-Type']).toBe('application/octet-stream')
    expect(h['Content-Disposition']).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('化验单.html')}`)
    expect(userFileHeaders('a.pdf', new TextEncoder().encode('%PDF-1.4'))['Content-Disposition']).toMatch(/^inline;/)
  })

  it('所有 /api 响应加 nosniff；SVG / HTML / XML 再加 CSP sandbox，JSON 与 PDF 不加', async () => {
    const app = new Hono()
    app.use('/api/*', apiSecurityHeaders)
    app.get('/api/svg', c => c.body('<svg/>', 200, { 'Content-Type': 'image/svg+xml; charset=utf-8' }))
    app.get('/api/html', c => c.body('<p>', 200, { 'Content-Type': 'text/html' }))
    app.get('/api/json', c => c.json({ ok: true }))
    app.get('/api/pdf', c => c.body('%PDF-', 200, { 'Content-Type': 'application/pdf' }))
    for (const path of ['/api/svg', '/api/html']) {
      const res = await app.request(path)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('Content-Security-Policy')).toMatch(/^sandbox;/)
    }
    for (const path of ['/api/json', '/api/pdf']) {
      const res = await app.request(path)
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(res.headers.get('Content-Security-Policy')).toBeNull()
    }
  })
})
