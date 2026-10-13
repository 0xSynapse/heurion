/**
 * 外观主题：深色（默认）/ 浅色 / 跟随系统。偏好存 localStorage（heurion.theme），只影响本机界面。
 * 首帧前由 index.html 的内联脚本先设好 html[data-theme]（避免闪一下），这里负责切换与跟随系统变化。
 */
export type ThemePref = 'dark' | 'light' | 'system'
const KEY = 'heurion.theme'
const media = matchMedia('(prefers-color-scheme: light)')

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'system' ? v : 'dark'
  } catch { return 'dark' }
}

export function applyTheme(pref = themePref()): void {
  const theme = pref === 'system' ? (media.matches ? 'light' : 'dark') : pref
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#F4F7F5' : '#06110D')
}

/** 用户菜单里的三段开关：[data-theme-pref] 按钮 */
export function mountThemeSwitch(group: HTMLElement): void {
  const sync = () => group.querySelectorAll<HTMLButtonElement>('[data-theme-pref]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themePref === themePref())))
  group.onclick = e => {
    const b = (e.target as HTMLElement).closest('[data-theme-pref]') as HTMLElement | null
    if (!b) return
    e.stopPropagation()
    try { localStorage.setItem(KEY, b.dataset.themePref!) } catch { /* 无痕模式：只本次生效 */ }
    applyTheme(b.dataset.themePref as ThemePref)
    sync()
  }
  media.addEventListener('change', () => { if (themePref() === 'system') applyTheme('system') })
  sync()
}
