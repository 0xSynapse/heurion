/**
 * 工作空间（左侧图标栏）：写作 / 患者 / 临床研究。每个空间在内容栏里有自己的标题、主操作、列表与搜索提示。
 * 切换时：中间区域如果停在开始页或别的空间的页面上（患者页、研究页），换成新空间的开始页；正在编辑的文档保留。
 */
export type Space = 'patients' | 'research' | 'write' | 'studio' | 'calendar' | 'mail'

export interface SpaceDef {
  title: string
  /** 列表上方的小标题 */
  label: string
  /** 内容栏里的主操作区、列表的元素 id */
  actions: string
  list: string
  placeholder: string
  /** 进入空间 */
  enter(): void | Promise<void>
}

const KEY = 'heurion.space'

export function initSpaces(defs: Record<Space, SpaceDef>) {
  const $ = (id: string) => document.getElementById(id)!
  let cur: Space = 'patients'
  const hidden = new Set<Space>()

  function set(space: Space): void {
    if (hidden.has(space)) space = 'patients'
    cur = space
    for (const [k, d] of Object.entries(defs) as Array<[Space, SpaceDef]>) {
      const on = k === space
      const btn = document.querySelector<HTMLElement>(`.rail-btn[data-space="${k}"]`)!
      btn.classList.toggle('on', on)
      btn.setAttribute('aria-selected', String(on))
      $(d.actions).hidden = !on
      $(d.list).hidden = !on
    }
    const d = defs[space]
    $('spaceTitle').textContent = d.title
    $('navLabel').textContent = d.label
    $('newProject').hidden = space !== 'write'
    ;($('docSearch') as HTMLInputElement).placeholder = d.placeholder
    try { localStorage.setItem(KEY, space) } catch { /* 无痕模式 */ }
    void d.enter()
  }

  document.querySelector('.rail-spaces')!.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.rail-btn[data-space]')
    if (b) set(b.dataset.space as Space)
  })

  return {
    set,
    current: () => cur,
    /** 上次停在哪个空间（兼容旧的 heurion.navMode） */
    saved(): Space {
      try {
        const v = localStorage.getItem(KEY) ?? (localStorage.getItem('heurion.navMode') === 'patients' ? 'patients' : null)
        const valid: Space[] = ['patients', 'research', 'write', 'studio', 'calendar', 'mail']
        return valid.includes(v as Space) ? (v as Space) : 'patients'
      } catch { return 'patients' }
    },
    /** 机构没开患者模块时隐藏患者空间 */
    setEnabled(space: Space, on: boolean): void {
      document.querySelector<HTMLElement>(`.rail-btn[data-space="${space}"]`)!.hidden = !on
      if (on) hidden.delete(space)
      else { hidden.add(space); if (cur === space) set('research') }
    },
  }
}
