import { useCallback, useEffect, useRef, useState } from 'react'

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
  // { status: 'requesting' | 'ready' | 'denied' | 'error', on: bool, error: string|null }
  const [audio, setAudio] = useState({ status: 'requesting', on: true, error: null })
  const [video, setVideo] = useState({ status: 'requesting', on: true, error: null })
  const [selected, setSelected] = useState({ cameraId: '', micId: '' })
  const [devices, setDevices] = useState({ cameras: [], mics: [] })

  const acquire = useCallback(async (kind, deviceId) => {
    const setState = kind === 'audio' ? setAudio : setVideo
    setState((s) => ({ ...s, status: 'requesting', error: null }))
    try {
      const constraints =
        kind === 'audio'
          ? { audio: deviceId ? { deviceId: { exact: deviceId } } : true }
          : { video: deviceId ? { deviceId: { exact: deviceId } } : true }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      const track = stream.getTracks()[0]
      if (!aliveRef.current) {
        track.stop() // размонтировались, пока ждали ответа
        return
      }

      // заменяем трек этого вида в общем стриме (смена устройства)
      const old = streamRef.current.getTracks().find((t) => t.kind === kind)
      if (old) {
        streamRef.current.removeTrack(old)
        old.stop()
      }
      streamRef.current.addTrack(track)
      track.enabled = true
      setState((s) => ({ ...s, status: 'ready', error: null }))

      // названия устройств доступны только после выдачи разрешения
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

  function handleJoin() {
    const name = displayName.trim()
    if (name) localStorage.setItem('vc:displayName', name)
    const stream = streamRef.current
    handedOffRef.current = true // владение треками переезжает в комнату
    onJoin({
      roomId,
      displayName: name || DEFAULT_NAME,
      stream,
      // трек существует даже при выключенном тумблере — он просто disabled
      audioEnabled: stream.getAudioTracks().length > 0 && audio.on,
      videoEnabled: stream.getVideoTracks().length > 0 && video.on,
      devices: { ...selected },
    })
  }

  return (
    <main className="prejoin">
      <div className="prejoin-video">
        <video ref={videoRef} autoPlay playsInline muted />

        {video.status === 'requesting' && <div className="video-overlay">Запрашиваем камеру…</div>}

        {video.status === 'denied' && (
          <div className="video-overlay">
            <p>Доступ к камере запрещён.</p>
            <p className="muted">
              Разрешите в настройках сайта и нажмите «Повторить»
            </p>
            <button onClick={() => acquire('video')}>Повторить</button>
          </div>
        )}

        {video.status === 'error' && (
          <div className="video-overlay">
            <p>Камера недоступна</p>
            <p className="muted">{video.error}</p>
            <button onClick={() => acquire('video')}>Повторить</button>
          </div>
        )}

        {video.status === 'ready' && !video.on && (
          <div className="video-overlay">Камера выключена</div>
        )}
      </div>

      <aside className="prejoin-panel">
        <h2>Вход во встречу</h2>
        <p className="muted">Комната {roomId.slice(0, 8)}…</p>

        <label>
          Ваше имя
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
            placeholder="Гость"
            autoFocus
          />
        </label>

        <div className="device-row">
          <button
            className={audio.on && audio.status === 'ready' ? 'toggle on' : 'toggle'}
            onClick={() => toggle('audio')}
            disabled={audio.status !== 'ready'}
          >
            {audio.status !== 'ready' ? 'Микрофон недоступен' : audio.on ? 'Микрофон вкл' : 'Микрофон выкл'}
          </button>
          <button
            className={video.on && video.status === 'ready' ? 'toggle on' : 'toggle'}
            onClick={() => toggle('video')}
            disabled={video.status !== 'ready'}
          >
            {video.status !== 'ready' ? 'Камера недоступна' : video.on ? 'Камера вкл' : 'Камера выкл'}
          </button>
        </div>

        {audio.status === 'denied' && (
          <p className="error">
            Микрофон: доступ запрещён. Разрешите в настройках сайта и{' '}
            <button className="link" onClick={() => acquire('audio')}>повторите</button>.
          </p>
        )}
        {audio.status === 'error' && <p className="error">Микрофон: {audio.error}</p>}

        <label>
          Микрофон
          <select
            value={selected.micId}
            disabled={audio.status !== 'ready'}
            onChange={(e) => acquire('audio', e.target.value)}
          >
            {devices.mics.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || 'Микрофон'}</option>
            ))}
          </select>
        </label>

        <label>
          Камера
          <select
            value={selected.cameraId}
            disabled={video.status !== 'ready'}
            onChange={(e) => acquire('video', e.target.value)}
          >
            {devices.cameras.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || 'Камера'}</option>
            ))}
          </select>
        </label>

        <button className="primary" onClick={handleJoin}>Присоединиться</button>
      </aside>
    </main>
  )
}
