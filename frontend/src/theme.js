import { useEffect, useState } from 'react'

const THEME_KEY = 'pettyconf:theme' // 'system' | 'light' | 'dark'

export function getSavedTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || localStorage.getItem('vc:theme') || 'system'
  } catch {
    return 'system'
  }
}

export function applyTheme(theme) {
  let effectiveTheme = theme
  if (theme === 'system') {
    effectiveTheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  }
  document.documentElement.setAttribute('data-theme', effectiveTheme)
}

export function useTheme() {
  const [theme, setThemeState] = useState(getSavedTheme)

  useEffect(() => {
    applyTheme(theme)

    if (theme !== 'system') return

    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme('system')
    mql.addEventListener?.('change', handler)
    return () => mql.removeEventListener?.('change', handler)
  }, [theme])

  function setTheme(newTheme) {
    try {
      localStorage.setItem(THEME_KEY, newTheme)
    } catch {
      // localStorage unavailable
    }
    setThemeState(newTheme)
    applyTheme(newTheme)
  }

  function cycleTheme() {
    // system -> light -> dark -> system
    if (theme === 'system') setTheme('light')
    else if (theme === 'light') setTheme('dark')
    else setTheme('system')
  }

  return { theme, setTheme, cycleTheme }
}
