import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE_DIR = fileURLToPath(new URL('../../site/', import.meta.url))

describe('GEO (Generative Engine Optimization) 与 AI 搜索引擎标准化文件核验', () => {
  it('robots.txt 存在并明确配置允许主流 AI 爬虫抓取', () => {
    const robotsPath = join(SITE_DIR, 'robots.txt')
    expect(existsSync(robotsPath)).toBe(true)
    const content = readFileSync(robotsPath, 'utf8')

    expect(content).toContain('User-agent: GPTBot')
    expect(content).toContain('User-agent: ClaudeBot')
    expect(content).toContain('User-agent: PerplexityBot')
    expect(content).toContain('User-agent: Google-Extended')
    expect(content).toContain('Allow: /')
    expect(content).toContain('Sitemap: https://heurion.org/sitemap.xml')
    expect(content).toContain('https://heurion.org/llms.txt')
  })

  it('sitemap.xml 存在且包含所有核心端点与多语言配置', () => {
    const sitemapPath = join(SITE_DIR, 'sitemap.xml')
    expect(existsSync(sitemapPath)).toBe(true)
    const content = readFileSync(sitemapPath, 'utf8')

    expect(content).toContain('<urlset')
    expect(content).toContain('<loc>https://heurion.org/</loc>')
    expect(content).toContain('<loc>https://heurion.org/en</loc>')
    expect(content).toContain('<loc>https://heurion.org/phr</loc>')
    expect(content).toContain('<loc>https://heurion.org/llms.txt</loc>')
  })

  it('llms.txt 符合 llmstxt.org 规范并包含核心技术矩阵', () => {
    const llmsPath = join(SITE_DIR, 'llms.txt')
    expect(existsSync(llmsPath)).toBe(true)
    const content = readFileSync(llmsPath, 'utf8')

    expect(content).toContain('# Heurion')
    expect(content).toContain('NCBI PubMed')
    expect(content).toContain('Project MONAI')
    expect(content).toContain('Table 1')
    expect(content).toContain('VanderWeele E-value')
    expect(content).toContain('CONSORT 2010')
    expect(content).toContain('/llms-full.txt')
  })

  it('llms-full.txt 包含完整技术规格与 MCP 端点声明', () => {
    const fullPath = join(SITE_DIR, 'llms-full.txt')
    expect(existsSync(fullPath)).toBe(true)
    const content = readFileSync(fullPath, 'utf8')

    expect(content).toContain('Model Context Protocol')
    expect(content).toContain('TotalSegmentator')
    expect(content).toContain('CONSORT 2010')
    expect(content).toContain('STROBE')
    expect(content).toContain('Sandboxed Python 3')
  })

  it('官网 index.html 包含 Schema.org JSON-LD 结构化数据与对比模块', () => {
    const indexPath = join(SITE_DIR, 'index.html')
    expect(existsSync(indexPath)).toBe(true)
    const html = readFileSync(indexPath, 'utf8')

    // JSON-LD 结构验证
    expect(html).toContain('application/ld+json')
    expect(html).toContain('"SoftwareApplication"')
    expect(html).toContain('"FAQPage"')
    expect(html).toContain('"MedicalWebPage"')

    // Meta 标签
    expect(html).toContain('name="description"')
    expect(html).toContain('property="og:title"')
    expect(html).toContain('name="twitter:card"')

    // 核心双主打旗舰产品、研究范式与发表论文
    expect(html).toContain('id="flagships"')
    expect(html).toContain('id="architecture"')
    expect(html).toContain('id="research"')
    expect(html).toContain('id="aegis-os"')
    expect(html).toContain('"ScholarlyArticle"')
    expect(existsSync(join(SITE_DIR, 'architecture.svg'))).toBe(true)
  })
})
