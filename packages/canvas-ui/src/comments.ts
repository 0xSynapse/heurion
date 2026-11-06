/** 批注线程的最小状态（GET /api/docs/:id 的 comments 子集）。 */
export interface CommentThreadStatus {
  id: string
  status: string
}

/**
 * 已关闭批注的线程 id。
 *
 * 关闭批注只改线程状态，正文里的 `comment(thread)` 锚点仍保留在模型里：
 * 这样重新打开、归档定位与再次导出都能接着用。渲染层据此把已关闭线程的
 * 高亮 / 下划线去掉，避免正文看起来仍有待处理批注。
 */
export function resolvedThreadIds(comments: ReadonlyArray<CommentThreadStatus> | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const c of comments ?? []) {
    if (c.status === 'resolved') out.add(c.id)
  }
  return out
}
