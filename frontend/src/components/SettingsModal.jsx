import { useEffect, useRef, useState } from 'react'
import {
  CloseIcon,
  MicIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
  VideoIcon,
} from './icons.jsx'

export default function SettingsModal({
  isOpen,
  onClose,
  selectedMicId,
  selectedCameraId,
  onSelectMic,
  onSelectCamera,
  deepFilterEnabled,
  onToggleDeepFilter,
  attenuationDb,
  onSelectAttenuation,
  theme,
  onSelectTheme,
}) {
  const modalRef = useRef(null)
  const [devices, setDevices] = useState({ cameras: [], mics: [] })
  const [switchingMic, setSwitchingMic] = useState(false)
  const [switchingCamera, setSwitchingCamera] = useState(false)

  // Обновление списка доступных устройств
  useEffect(() => {
    if (!isOpen) return

    let alive = true
    async function loadDevices() {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return
        const all = await navigator.mediaDevices.enumerateDevices()
        if (!alive) return
        setDevices({
          cameras: all.filter((d) => d.kind === 'videoinput'),
          mics: all.filter((d) => d.kind === 'audioinput'),
        })
      } catch (err) {
        console.warn('[SettingsModal] Ошибка получения устройств:', err)
      }
    }

    loadDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', loadDevices)

    return () => {
      alive = false
      navigator.mediaDevices?.removeEventListener?.('devicechange', loadDevices)
    }
  }, [isOpen])

  // Закрытие по Escape и клику вне модального окна
  useEffect(() => {
    if (!isOpen) return

    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    function handlePointerDown(e) {
      if (modalRef.current && !modalRef.current.contains(e.target)) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerdown', handlePointerDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  async function handleMicChange(deviceId) {
    setSwitchingMic(true)
    try {
      await onSelectMic(deviceId)
    } finally {
      setSwitchingMic(false)
    }
  }

  async function handleCameraChange(deviceId) {
    setSwitchingCamera(true)
    try {
      await onSelectCamera(deviceId)
    } finally {
      setSwitchingCamera(false)
    }
  }

  const attenuationLevels = [
    { value: 15, label: 'Мягкое', desc: '15 дБ' },
    { value: 25, label: 'Стандарт', desc: '25 дБ' },
    { value: 40, label: 'Максимум', desc: '40 дБ' },
  ]

  const themes = [
    { value: 'light', label: 'Светлая', icon: SunIcon },
    { value: 'dark', label: 'Тёмная', icon: MoonIcon },
    { value: 'system', label: 'Авто', icon: MonitorIcon },
  ]

  return (
    <div className="room-modal-backdrop">
      <div
        ref={modalRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Настройки"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-modal-header">
          <div className="settings-modal-title">
            <SettingsIcon size={20} className="settings-header-icon" />
            <h2>Настройки</h2>
          </div>
          <button
            type="button"
            className="settings-modal-close"
            onClick={onClose}
            title="Закрыть"
            aria-label="Закрыть настройки"
          >
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="settings-modal-content">
          {/* Секция: Устройства ввода */}
          <section className="settings-section">
            <div className="settings-section-header">
              <span className="settings-section-title">Устройства</span>
            </div>

            <div className="settings-form-group">
              <label htmlFor="settings-mic-select" className="settings-field-label">
                <MicIcon size={16} />
                <span>Микрофон</span>
              </label>
              <select
                id="settings-mic-select"
                className="settings-select"
                value={selectedMicId || ''}
                disabled={switchingMic}
                onChange={(e) => handleMicChange(e.target.value)}
              >
                {devices.mics.length === 0 ? (
                  <option value="">По умолчанию</option>
                ) : (
                  devices.mics.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Микрофон (${d.deviceId.slice(0, 6)})`}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="settings-form-group">
              <label htmlFor="settings-camera-select" className="settings-field-label">
                <VideoIcon size={16} />
                <span>Камера</span>
              </label>
              <select
                id="settings-camera-select"
                className="settings-select"
                value={selectedCameraId || ''}
                disabled={switchingCamera}
                onChange={(e) => handleCameraChange(e.target.value)}
              >
                {devices.cameras.length === 0 ? (
                  <option value="">По умолчанию</option>
                ) : (
                  devices.cameras.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Камера (${d.deviceId.slice(0, 6)})`}
                    </option>
                  ))
                )}
              </select>
            </div>
          </section>

          {/* Секция: Шумоподавление */}
          <section className="settings-section">
            <div className="settings-section-header">
              <span className="settings-section-title">Шумоподавление</span>
            </div>

            <div className="settings-switch-row">
              <div className="settings-switch-info">
                <div className="settings-switch-label">
                  <span>DeepFilterNet3</span>
                </div>
                <span className="settings-switch-hint">
                  Подавляет шум клавиатуры, улицы и фоновые звуки
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={deepFilterEnabled}
                className={`settings-toggle-switch ${deepFilterEnabled ? 'active' : ''}`}
                onClick={onToggleDeepFilter}
              >
                <span className="settings-toggle-knob" />
              </button>
            </div>

            {deepFilterEnabled && (
              <div className="settings-levels-group">
                <span className="settings-sublabel">Уровень подавления</span>
                <div className="settings-segmented-control" role="radiogroup">
                  {attenuationLevels.map((lvl) => {
                    const isSelected = (attenuationDb || 25) === lvl.value
                    return (
                      <button
                        key={lvl.value}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        className={`segmented-btn ${isSelected ? 'active' : ''}`}
                        onClick={() => onSelectAttenuation(lvl.value)}
                      >
                        <span className="segmented-label">{lvl.label}</span>
                        <span className="segmented-desc">{lvl.desc}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </section>

          {/* Секция: Тема оформления */}
          <section className="settings-section">
            <div className="settings-section-header">
              <span className="settings-section-title">Тема оформления</span>
            </div>

            <div className="settings-theme-group" role="radiogroup">
              {themes.map((t) => {
                const IconComponent = t.icon
                const isSelected = theme === t.value
                return (
                  <button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    className={`theme-chip-btn ${isSelected ? 'active' : ''}`}
                    onClick={() => onSelectTheme(t.value)}
                  >
                    <IconComponent size={16} />
                    <span>{t.label}</span>
                  </button>
                )
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
