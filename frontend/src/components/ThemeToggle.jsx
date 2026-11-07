import { useTheme } from '../theme.js'
import { SunIcon, MoonIcon, MonitorIcon } from './icons.jsx'

export default function ThemeToggle({ className = '' }) {
  const { theme, cycleTheme } = useTheme()

  const labels = {
    system: 'Тема: системная',
    light: 'Тема: светлая',
    dark: 'Тема: тёмная',
  }

  return (
    <button
      type="button"
      className={`theme-toggle-btn ${className}`}
      onClick={cycleTheme}
      title={`${labels[theme]} (нажмите для переключения)`}
      aria-label={labels[theme]}
    >
      {theme === 'system' && <MonitorIcon size={18} />}
      {theme === 'light' && <SunIcon size={18} />}
      {theme === 'dark' && <MoonIcon size={18} />}
      <span className="theme-toggle-label">
        {theme === 'system' ? 'Авто' : theme === 'light' ? 'Светлая' : 'Тёмная'}
      </span>
    </button>
  )
}
