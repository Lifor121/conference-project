import { useCallback, useEffect, useRef, useState } from 'react'
import ThemeToggle from './ThemeToggle.jsx'
import {
  MicIcon,
  MicOffIcon,
  VideoIcon,
  VideoOffIcon,
  CopyIcon,
  CheckIcon,
} from './icons.jsx'

const DEFAULT_NAME = 'Гость'

export default function PreJoinScreen({ roomId, onJoin }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  if (streamRef.current === null) streamRef.current = new MediaStream()
  const handedOffRef = useRef(false)
  const aliveRef = useRef(true)

  const [displayName, setDisplayName] = useState(
    () => localStorage.getItem('vc:displayName') || '',
  )
  const [audio, setAudio] = useState({ status: 'requesting', on: true, error: null })
  const [video, setVideo] = useState({ status: 'requesting', on: true, error: null })
  const [selected, setSelected] = useState({ cameraId: '', micId: '' })
  const [devices, setDevices] = useState({ cameras: [], mics: [] })
  const [copied, setCopied] = useState(false)

  const acquire = useCallback(async (kind, deviceId) => {
    const setState = kind === 'audio' ? setAudio : setVideo
    setState((s) => ({ ...s, status: 'requesting', error: null }))
    try {
      const constraints =
        kind === 'audio'
          ? {
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
              },
            }
          : { video: deviceId ? { deviceId: { exact: deviceId } } : true }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      const track = stream.getTracks()[0]
      if (!aliveRef.current) {
        track.stop()
        return
      }

      const old = streamRef.current.getTracks().find((t) => t.kind === kind)
      if (old) {
        streamRef.current.removeTrack(old)
        old.stop()
      }
      streamRef.current.addTrack(track)
      track.enabled = true
      setState((s) => ({ ...s, status: 'ready', error: null }))

      const all = await navigator.mediaDevices.enumerateDevices()
      if (!aliveRef.current) return
      setDevices({
        cameras: all.filter((d) => d.kind === 'videoinput'),
        mics: all.filter((d) => d.kind === 'audioinput'),
      })
      const { deviceId: usedId } = track.getSettings()
      setSelected((prev) =>
        kind === 'video'
          ? { ...prev, cameraId: usedId ?? prev.cameraId }
          : { ...prev, micId: usedId ?? prev.micId },
      )
    } catch (e) {
      if (!aliveRef.current) return
      if (e.name === 'NotAllowedError') {
        setState((s) => ({ ...s, status: 'denied' }))
      } else {
        setState((s) => ({ ...s, status: 'error', error: `${e.name}: ${e.message}` }))
      }
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    acquire('audio')
    acquire('video')
    return () => {
      aliveRef.current = false
      if (!handedOffRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop())
      }
    }
  }, [acquire])

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = streamRef.current
  }, [video.status])

  function toggle(kind) {
    const track = streamRef.current.getTracks().find((t) => t.kind === kind)
    if (!track) return
    track.enabled = !track.enabled
    ;(kind === 'audio' ? setAudio : setVideo)((s) => ({ ...s, on: track.enabled }))
  }

  function handleCopyRoomId() {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  function handleJoin() {
    const name = displayName.trim()
    if (name) localStorage.setItem('vc:displayName', name)
    const stream = streamRef.current
    handedOffRef.current = true
    onJoin({
      roomId,
      displayName: name || DEFAULT_NAME,
      stream,
      audioEnabled: stream.getAudioTracks().length > 0 && audio.on,
      videoEnabled: stream.getVideoTracks().length > 0 && video.on,
      devices: { ...selected },
    })
  }

  const isVideoLive = video.status === 'ready' && video.on
  const isAudioLive = audio.status === 'ready' && audio.on

  return (
    <div className="prejoin-layout">
      <header className="prejoin-topbar">
        <span className="prejoin-brand">VC</span>
        <ThemeToggle />
      </header>

      <main className="prejoin-card-container">
        <section className="prejoin-stage">
          <div className="prejoin-preview-box">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`preview-video ${isVideoLive ? 'visible' : 'hidden'}`}
            />

            {!isVideoLive && (
              <div className="preview-fallback">
                <div className="fallback-avatar">
                  {(displayName.trim() || DEFAULT_NAME)[0].toUpperCase()}
                </div>
                <span className="fallback-text">
                  {video.status === 'requesting'
                    ? 'Запрашиваем камеру…'
                    : video.status === 'denied'
                      ? 'Доступ к камере запрещён'
                      : 'Камера выключена'}
                </span>
                {video.status === 'denied' && (
                  <button type="button" className="btn-retry" onClick={() => acquire('video')}>
                    Повторить
                  </button>
                )}
              </div>
            )}

            <div className="preview-quick-controls">
              <button
                type="button"
                className={`quick-ctl-btn ${isAudioLive ? 'active' : 'muted'}`}
                onClick={() => toggle('audio')}
                disabled={audio.status !== 'ready'}
                title={isAudioLive ? 'Выключить микрофон' : 'Включить микрофон'}
              >
                {isAudioLive ? <MicIcon size={20} /> : <MicOffIcon size={20} />}
              </button>
              <button
                type="button"
                className={`quick-ctl-btn ${isVideoLive ? 'active' : 'muted'}`}
                onClick={() => toggle('video')}
                disabled={video.status !== 'ready'}
                title={isVideoLive ? 'Выключить камеру' : 'Включить камеру'}
              >
                {isVideoLive ? <VideoIcon size={20} /> : <VideoOffIcon size={20} />}
              </button>
            </div>
          </div>
        </section>

        <aside className="prejoin-form-panel">
          <div className="form-panel-header">
            <h2>Вход во встречу</h2>
            <button
              type="button"
              className="room-id-pill"
              onClick={handleCopyRoomId}
              title="Скопировать ссылку"
            >
              <span>Комната {roomId.slice(0, 8)}…</span>
              {copied ? <CheckIcon size={14} className="copied-icon" /> : <CopyIcon size={14} />}
            </button>
          </div>

          <label>
            Ваше имя
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              placeholder="Гость"
              autoFocus
              maxLength={64}
            />
          </label>

          <label>
            Микрофон
            <select
              value={selected.micId}
              disabled={audio.status !== 'ready'}
              onChange={(e) => acquire('audio', e.target.value)}
            >
              {devices.mics.length === 0 ? (
                <option value="">{audio.status === 'ready' ? 'По умолчанию' : 'Не найден'}</option>
              ) : (
                devices.mics.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Микрофон'}
                  </option>
                ))
              )}
            </select>
          </label>

          <label>
            Камера
            <select
              value={selected.cameraId}
              disabled={video.status !== 'ready'}
              onChange={(e) => acquire('video', e.target.value)}
            >
              {devices.cameras.length === 0 ? (
                <option value="">{video.status === 'ready' ? 'По умолчанию' : 'Не найдена'}</option>
              ) : (
                devices.cameras.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || 'Камера'}
                  </option>
                ))
              )}
            </select>
          </label>

          {audio.status === 'denied' && (
            <div className="permission-alert">
              <span>Доступ к микрофону запрещён в настройках браузера.</span>
              <button type="button" className="btn-link" onClick={() => acquire('audio')}>
                Повторить
              </button>
            </div>
          )}

          <button type="button" className="primary btn-join-room" onClick={handleJoin}>
            Присоединиться
          </button>
        </aside>
      </main>
    </div>
  )
}
