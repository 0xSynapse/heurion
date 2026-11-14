import type { Node as PMNode } from 'prosemirror-model'
import { orgLogo } from '../model/org-templates.ts'
import type { Documents } from '../model/runtime.ts'
import { pendingGroups, withoutPending } from '../ops/suggest.ts'
import { exportDocx } from './docx-export.ts'
import { hasAiText } from '../model/provenance.ts'
import { exportPptx } from './pptx-export.ts'
import { isPlatformPackage, pptxTemplate } from './pptx-template.ts'
import { themePhoto } from '../model/theme-photos.ts'
import type { MeasureLookup } from '../model/measurements.ts'

/** 导入时的模型（未改动判断的基准）：只有从文件导入的文档才有。 */
function baselineOf(docs: Documents, docId: string) {
  const first = docs.store.listVersions(docId).at(-1)
  return first?.source === 'import' ? docs.versionDoc(docId, first.seq) : null
}

/**
 * 导出 docx：导入的文档以原始文件包为底座、未改动的块原样写回。
 * measurements：测量原子在导出者眼里的值（与界面同一份，见 measurements/service.ts）；不给时按快照之外的「未登记」处理。
 */
/**
 * opts.clean：干净稿——AI 写的、还没人确认的文字按普通文字导出（默认写成「Heurion AI」名下的修订，在 Word 里接受即确认）。
 */
export function docxFor(docs: Documents, docId: string, measurements?: MeasureLookup, opts: { clean?: boolean } = {}) {
  docs.flush(docId)
  const store = docs.store
  const stored = store.getPackage(docId)
  // PDF 导入的文档在 doc_packages 中存的是原始 PDF 字节（%PDF-...），不能作为 docx ZIP 底座解压
  const isZip = !!(stored && stored.length >= 4 && stored[0] === 0x50 && stored[1] === 0x4B)
  const pkg = isZip ? stored : null
  const current = docs.get(docId)
  const pending = pendingGroups(current).length
  // 待采纳修订交给导出器：段落的修订写成 Word 修订，表格、列表、图的修订按未采纳导出
  const result = exportDocx({
    doc: current,
    baseline: pkg ? baselineOf(docs, docId) : null,
    pkg,
    src: id => store.getNodeSrc(docId, id),
    citations: store.listCitations(docId),
    measurements,
    comments: store.listComments(docId),
    asset: id => {
      const cleanId = String(id).replace(/^asset:/, '')
      const a = store.getAsset(cleanId)
      const bytes = a ? store.getAssetBytes(cleanId) : null
      return a && bytes ? { mime: a.mime, bytes } : null
    },
    aiAsRevisions: !opts.clean,
  })
  // AI 未确认的文字在文件里的样子：默认是 AI 名下的修订；干净稿里是普通文字（说明一句，免得以为已经确认）
  if (hasAiText(current)) {
    result.warnings.unshift(opts.clean
      ? '这是干净稿：AI 写的、还没确认的文字按普通文字导出，Word 里看不出哪些是 AI 写的'
      : 'AI 写的、还没确认的文字以「Heurion AI」名下的修订导出，在 Word 里接受修订即确认；需要不带这些修订的文件，请在导出菜单选「Word 干净稿」')
  }
  // 明确告诉用户待采纳修订在文件里的样子，免得以为已经生效
  if (pending > 0) result.warnings.unshift(`文档里还有 ${pending} 条待采纳修订：段落的修订在导出文件里是 Word 修订，可在 Word 里逐条接受或拒绝；表格、列表、图的修订导出的是采纳前的内容`)
  return result
}

/**
 * 导出 pptx：以原始文件包（平台新建的 deck 为模板）为底座、未改动的页与形状原样写回。
 * view：要导出的文档视图，默认是导出视图（待采纳修订按未采纳）；渲染预览传 slidePreviewView 的结果。
 */
export function pptxFor(docs: Documents, docId: string, measurements?: MeasureLookup, view?: PMNode) {
  docs.flush(docId)
  const store = docs.store
  const doc = view ?? withoutPending(docs.get(docId))
  const stored = store.getPackage(docId)
  // 平台模板的 deck：按当前模板重新生成底座（版式几何、母版配色跟着模板走）
  const isZip = !!(stored && stored.length >= 4 && stored[0] === 0x50 && stored[1] === 0x4B)
  const pkg = !stored || !isZip || isPlatformPackage(stored) ? pptxTemplate((doc.firstChild?.attrs.theme as string | null) ?? undefined) : stored
  return exportPptx({
    doc,
    baseline: baselineOf(docs, docId),
    pkg,
    src: id => store.getNodeSrc(docId, id),
    citations: store.listCitations(docId),
    measurements,
    asset: id => {
      const cleanId = String(id).replace(/^asset:/, '')
      const builtin = themePhoto(cleanId) ?? orgLogo(cleanId) // 带图模板的内置照片、机构模板的院徽
      if (builtin) return builtin
      const a = store.getAsset(cleanId)
      const bytes = a ? store.getAssetBytes(cleanId) : null
      return a && bytes ? { mime: a.mime, bytes } : null
    },
  })
}
