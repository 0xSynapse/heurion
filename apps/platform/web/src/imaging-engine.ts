/** 影像分析引擎类型（与 imaging-worker 的 engine_type 一致） */
export const ENGINE_LABEL: Record<string, string> = { deep_learning: '深度学习', quantitative_ct: '定量 CT', rule_based: '规则算法' }
export const ENGINE_GROUP: Record<string, string> = { rule_based: '规则算法（阈值 / 形态学，非神经网络）', quantitative_ct: '定量 CT（HU 密度测量）', deep_learning: '深度学习模型（MONAI 权重）' }
export const ENGINE_STYLE: Record<string, string> = {
  deep_learning: 'background: rgba(16, 185, 129, 0.18); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3)',
  quantitative_ct: 'background: rgba(147, 51, 234, 0.15); color: #c084fc; border: 1px solid rgba(147, 51, 234, 0.3)',
  rule_based: 'background: rgba(234, 179, 8, 0.15); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.3)',
}


/** 模型选项的类型与可用状态文字：未就绪的显示原因 */
export function modelOptionTag(m: { engine_type?: string; is_ready?: boolean; unavailable_reason?: string | null }): string {
  const type = ENGINE_LABEL[m.engine_type ?? ''] ?? '类型未标注'
  return m.is_ready === false ? `[${type}] (不可用：${m.unavailable_reason || '未就绪'})` : `[${type}]`
}
