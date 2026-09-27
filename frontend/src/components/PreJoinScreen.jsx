import { useEffect, useRef, useState } from 'react'

const DEFAULT_NAME = 'Гость'

// Экран перед входом: имя, превью, выбор устройств, вкл/выкл микрофона и камеры.
// Итог сессии (владение stream, выбранные устройства, что включено) уезжает наверх
export default function PreJoinScreen({ roomId, onJoin }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  // когда поток передаётся в комнату, останавливать его при размонтировании нельзя
  const handedOffRef = useRef(false)

  const [displayName, setDisplayName] = useState(
    () => localStorage.getItem('vc:displayName') || '',
  )
  const [mediaOn, setMediaOn] = useState({ audio: true, video: true })
  const [selected, setSelected] = useState({ cameraId: '', micId: '' })
  const [devices, setDevices] = useState({ cameras: [], mics: [] })
  const [status, setStatus] = useState('requesting') // requesting | ready | denied | error
  const [error, setError] = useState(null)

  // (пере)запрашиваем поток: при монтировании, смене устройства, вкл/выкл
  useEffect(() => {
    let cancelled = false

    async function start() {
      if (!mediaOn.audio && !mediaOn.video) {
        // getUserMedia с audio:false, video:false — TypeError. Просто чистим превью.
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        if (videoRef.current) videoRef.current.srcObject = null
        setStatus('ready')
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // deviceId без exact = «предпочтительно»: пропавший id не уронит запрос
          audio: mediaOn.audio
            ? { deviceId: selected.micId || undefined }
            : false,
          video: mediaOn.video
            ? { deviceId: selected.cameraId || undefined }
            : false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop()) // размонтировались, пока ждали
          return
        }
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        setStatus('ready')

        // названия устройств доступны только после выдачи разрешения
        const all = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        setDevices({
          cameras: all.filter((d) => d.kind === 'videoinput'),
          mics: all.filter((d) => d.kind === 'audioinput'),
        })
        // фиксируем устройства по умолчанию, чтобы селекты показывали истину
        setSelected((prev) => ({
          cameraId: prev.cameraId || (stream.getVideoTracks()[0]?.getSettings().deviceId ?? ''),
          micId: prev.micId || (stream.getAudioTracks()[0]?.getSettings().deviceId ?? ''),
        }))
      } catch (e) {
        if (cancelled) return
        if (e.name === 'NotAllowedError') {
          setStatus('denied')
          setError(null)
        } else {
          setStatus('error')
          setError(e.message)
        }
      }
    }

    start()
    return () => {
      cancelled = true
      // StrictMode в dev запускает эффект дважды: без cleanup потекла бы камера
      // (и горел бы индикатор). Плюс это же — остановка при уходе с экрана.
      if (!handedOffRef.current) {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
      }
    }
  }, [mediaOn.audio, mediaOn.video, selected.cameraId, selected.micId])

  function handleJoin() {
    const name = displayName.trim()
    if (name) localStorage.setItem('vc:displayName', name) // дефолт не запоминаем
    const stream = streamRef.current
    handedOffRef.current = true // владение потоком переезжает в RoomPage
    onJoin({
      roomId,
      displayName: name || DEFAULT_NAME,
      stream,
      // истина — по фактически существующим трекам, а не по тумблерам
      audioEnabled: !!stream?.getAudioTracks().length,
      videoEnabled: !!stream?.getVideoTracks().length,
      devices: { ...selected },
    })
  }

  return (
    <main className="prejoin">
      <div className="prejoin-video">
        <video ref={videoRef} autoPlay playsInline muted />
        {status === 'requesting' && <div className="video-overlay">Запрашиваем доступ к устройствам…</div>}
        {status === 'denied' && (
          <div className="video-overlay">
            Доступ запрещён. Разрешите его в настройках сайта или войдите
            без камеры и микрофона.
          </div>
        )}
        {!mediaOn.video && status === 'ready' && <div className="video-overlay">Камера выключена</div>}
      </div>

      <aside className="prejoin-panel">
        <h2>Вход во встречу</h2>
        <p className="muted">Комната {roomId.slice(0, 8)}…</p>

        <label>
          Ваше имя
          <input
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
            placeholder="Гость"
            autoFocus
          />
        </label>

        <div className="device-row">
          <button
            className={mediaOn.audio ? 'toggle on' : 'toggle'}
            onClick={() => setMediaOn((m) => ({ ...m, audio: !m.audio }))}
          >
            {mediaOn.audio ? '🎙 Микрофон вкл' : '🔇 Микрофон выкл'}
          </button>
          <button
            className={mediaOn.video ? 'toggle on' : 'toggle'}
            onClick={() => setMediaOn((m) => ({ ...m, video: !m.video }))}
          >
            {mediaOn.video ? '📹 Камера вкл' : '📷 Камера выкл'}
          </button>
        </div>

        <label>
          Микрофон
          <select
            value={selected.micId}
            onChange={(e) => setSelected((s) => ({ ...s, micId: e.target.value }))}
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
            onChange={(e) => setSelected((s) => ({ ...s, cameraId: e.target.value }))}
          >
            {devices.cameras.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || 'Камера'}</option>
            ))}
          </select>
        </label>

        {error && <div className="error">{error}</div>}

        <button className="primary" onClick={handleJoin}>
          Присоединиться
        </button>
      </aside>
    </main>
  )
}
