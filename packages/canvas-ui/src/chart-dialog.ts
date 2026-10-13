import type { ChartData } from './deck.ts'

/**
 * 图表数据表（双击图表打开）：行是类别、列是系列；可改标题、类别、系列名与数值，增删行 / 系列。
 * 确定后返回新数据（由调用方提交 chart_set_data，与 AI 同一个操作）；取消返回 null。
 */

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
/** 能在这里改数据的类型（与服务端 EDITABLE_CHART_TYPES 一致；散点等只读）。 */
export const EDITABLE_CHART_TYPES = ['column', 'bar', 'line', 'pie', 'area', 'doughnut']

const TYPE_LABEL: Record<string, string> = { column: '柱状图', bar: '条形图', line: '折线图', pie: '饼图', area: '面积图', doughnut: '圆环图' }

export function editChartData(chart: ChartData): Promise<Omit<ChartData, 'colors'> | null> {
  return new Promise(resolve => {
    let type = chart.type
    const isRound = () => type === 'pie' || type === 'doughnut'
    let categories = [...chart.categories]
    let series = chart.series.map(s => ({ name: s.name, values: [...s.values] }))
    let title = chart.title ?? ''
    let result: Omit<ChartData, 'colors'> | null = null
    const dlg = document.getElementById('dialog')!
    const close = () => { dlg.hidden = true; dlg.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(result) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      // 回车保存（输入法组字中的回车不算）
      if (e.key === 'Enter' && !e.isComposing && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); dlg.querySelector<HTMLButtonElement>('#chartOk')?.click() }
    }
    document.addEventListener('keydown', onKey)

    /** 先把输入框里的值收回来（重画表格前）。 */
    const collect = () => {
      title = dlg.querySelector<HTMLInputElement>('#chartTitle')?.value ?? title
      dlg.querySelectorAll<HTMLInputElement>('input[data-cat]').forEach(i => { categories[Number(i.dataset.cat)] = i.value })
      dlg.querySelectorAll<HTMLInputElement>('input[data-ser]').forEach(i => { series[Number(i.dataset.ser)]!.name = i.value })
      dlg.querySelectorAll<HTMLInputElement>('input[data-v]').forEach(i => {
        const [si, ci] = i.dataset.v!.split(',').map(Number) as [number, number]
        const raw = i.value.trim().replace(/,/g, '')
        series[si]!.values[ci] = raw === '' ? null : Number(raw)
      })
    }

    const render = () => {
      const round = isRound()
      dlg.innerHTML = `<div class="dialog-card chart-dialog" role="dialog" aria-modal="true" aria-label="编辑图表数据">
        <div class="dialog-head"><h2>编辑图表数据</h2><button class="quiet" data-close aria-label="关闭">✕</button></div>
        <div class="dialog-body">
          <div class="row chart-meta"><label class="chart-title">标题<input type="text" id="chartTitle" value="${esc(title)}" placeholder="（无标题）"></label>
            <label>类型<select id="chartType">${EDITABLE_CHART_TYPES.map(t => `<option value="${t}"${t === type ? ' selected' : ''}>${TYPE_LABEL[t]}</option>`).join('')}</select></label></div>
          <div class="chart-grid-wrap"><table class="chart-grid">
            <thead><tr><th>类别</th>${series.map((s, si) => `<th><input data-ser="${si}" value="${esc(s.name)}" aria-label="系列名">${!round && series.length > 1 ? `<button class="quiet" data-del-ser="${si}" title="删除这个系列">×</button>` : ''}</th>`).join('')}${round ? '' : '<th><button data-add-ser title="加一个系列">＋系列</button></th>'}</tr></thead>
            <tbody>${categories.map((c, ci) => `<tr><td><input data-cat="${ci}" value="${esc(c)}" aria-label="类别"></td>${series.map((s, si) => `<td><input data-v="${si},${ci}" value="${s.values[ci] ?? ''}" inputmode="decimal" aria-label="数值"></td>`).join('')}${categories.length > 1 ? `<td><button class="quiet" data-del-cat="${ci}" title="删除这一行">×</button></td>` : ''}</tr>`).join('')}</tbody>
          </table></div>
          <div class="row"><button data-add-cat>＋类别</button><span class="grow"></span><span class="form-error" id="chartError"></span></div>
          <div class="row end"><button data-close>取消</button><button class="primary" id="chartOk">保存</button></div>
        </div></div>`
      dlg.hidden = false
      dlg.querySelector<HTMLSelectElement>('#chartType')!.onchange = e => { collect(); type = (e.target as HTMLSelectElement).value as ChartData['type']; render() }
    }

    dlg.onclick = e => {
      const t = e.target as HTMLElement
      if (e.target === dlg || t.closest('[data-close]')) { close(); return }
      const b = t.closest('button') as HTMLButtonElement | null
      if (!b) return
      collect()
      if (b.hasAttribute('data-add-cat')) { categories.push(`类别 ${categories.length + 1}`); series.forEach(s => s.values.push(null)); render(); return }
      if (b.hasAttribute('data-add-ser')) { series.push({ name: `系列 ${series.length + 1}`, values: categories.map(() => null) }); render(); return }
      if (b.dataset.delCat !== undefined) { const i = Number(b.dataset.delCat); categories = categories.filter((_, j) => j !== i); series = series.map(s => ({ ...s, values: s.values.filter((_, j) => j !== i) })); render(); return }
      if (b.dataset.delSer !== undefined) { const i = Number(b.dataset.delSer); series = series.filter((_, j) => j !== i); render(); return }
      if (b.id === 'chartOk') {
        const bad = series.flatMap(s => s.values).some(v => v !== null && !Number.isFinite(v))
        if (bad) { dlg.querySelector('#chartError')!.textContent = '数值要是数字（留空表示没有数据）'; return }
        if (isRound() && series.length > 1) { dlg.querySelector('#chartError')!.textContent = '饼图 / 圆环图只能有一个系列，请先删掉多余的系列'; return }
        result = { type, title: title.trim(), categories, series }
        close()
      }
    }
    render()
    dlg.querySelector<HTMLInputElement>('input[data-v]')?.focus()
  })
}
