import DOMPurify from 'dompurify'

/**
 * 写入 innerHTML 前净化 SVG 文本。
 * SVG 来源很多（服务端图表、沙箱 R/Python 输出、归档资产、导入文档），任何一处漏转义都会让
 * `<svg><image onerror>` 之类在平台同源执行；这里统一去掉脚本、事件属性、foreignObject 与 javascript: 链接。
 */
export function safeSvg(markup: string | null | undefined): string {
  if (!markup) return ''
  return DOMPurify.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject'],
  })
}
