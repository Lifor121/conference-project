import { useEffect, useMemo, useRef, useState } from 'react'
import { useRoom } from '../room/useRoom.js'
import { LeaveIcon, MicIcon, MicOffIcon, VideoIcon, VideoOffIcon } from './icons.jsx'

function VideoTile({ track, label, muted, fallbackInitial, detached }) {
  const ref = useRef(null)
  const stream = useMemo(() => (track ? new MediaStream([track]) : null), [track])

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])

  return (
    <div className={`video-tile${detached ? ' detached' : ''}`}>
      {stream ? (
        <video ref={ref} autoPlay playsInline muted />
      ) : (
        <div className="avatar">{fallbackInitial}</div>
      )}
      {detached && (
        <div className="tile-detached">
          <div className="spinner" />
          <span>переподключается…</span>
        </div>
      )}
      <div className="tile-label">
        {muted && <MicOffIcon className="tile-mute" />}
        {label}
      </div>
    </div>
  )
}

function AudioSink({ track }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !track) return
    el.srcObject = new MediaStream([track])
    el.play().catch(() => {
      el.muted = true
      el.play().catch(() => {})
    })
    return () => { el.srcObject = null }
  }, [track])
  if (!track) return null
  return <audio ref={ref} autoPlay />
}

function RemotePeerTiles({ peer }) {
  return (
    <>
      <VideoTile
        track={peer.tracks['webcam:video']}
        muted={!peer.tracks['webcam:audio']}
        label={peer.displayName}
        fallbackInitial={peer.displayName[0]}
        detached={Boolean(peer.detached)}
      />
      {peer.tracks['screen:video'] && (
        <VideoTile
          track={peer.tracks['screen:video']}
          label={`${peer.displayName} — экран`}
          fallbackInitial="—"
        />
      )}
    </>
  )
}

export default function RoomView({ session, onLeave }) {
  const {
    phase, error, remotePeers,
    audioEnabled, videoEnabled, localVideoTrack,
    toggleAudio, toggleVideo,
  } = useRoom({ session })

  const joined = phase === 'joined'

  // оверлей не должен мигать на коротких восстановлениях: смена сети теперь
  // лечится resume + ICE-рестарт за 1–2с — показываем его, только если
  // восстановление реально затянулось
  const [showReconnectOverlay, setShowReconnectOverlay] = useState(false)
  useEffect(() => {
    if (phase !== 'reconnecting') {
      setShowReconnectOverlay(false)
      return
    }
    const timer = setTimeout(() => setShowReconnectOverlay(true), 1200)
    return () => clearTimeout(timer)
  }, [phase])

  if (phase === 'error') {
    return (
      <main className="room">
        <div className="fullscreen-message">
          <p className="error">{error}</p>
          <button className="primary" onClick={onLeave}>На экран входа</button>
        </div>
      </main>
    )
  }

  return (
    <main className="room">
      <header className="room-header">
        <span className="muted">
          Комната {session.roomId.slice(0, 8)}… ·{' '}
          {joined ? 'в эфире' : phase === 'reconnecting' ? 'переподключение…' : 'подключение…'}
        </span>
      </header>

      <div className="video-grid">
        <VideoTile
          key="me"
          track={videoEnabled ? localVideoTrack : null}
          muted={!audioEnabled}
          label={`${session.displayName} (вы)`}
          fallbackInitial={session.displayName[0]}
        />
        {remotePeers.map((p) => (
          <RemotePeerTiles key={p.id} peer={p} />
        ))}
      </div>

      {phase === 'connecting' && (
        <div className="connecting-overlay">
          <div className="spinner" />
          Подключение к комнате…
        </div>
      )}

      {showReconnectOverlay && (
        <div className="connecting-overlay reconnecting">
          <div className="spinner" />
          Связь с сервером потеряна. Переподключаемся…
        </div>
      )}

      {remotePeers.map((p) => (
        <AudioSink key={p.id} track={p.tracks['webcam:audio']} />
      ))}

      <footer className="room-footer">
        <div className="controls">
          <button
            className={audioEnabled ? 'ctl on' : 'ctl off'}
            onClick={toggleAudio}
            disabled={!joined}
            title={audioEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
          >
            {audioEnabled ? <MicIcon /> : <MicOffIcon />}
          </button>
          <button
            className={videoEnabled ? 'ctl on' : 'ctl off'}
            onClick={toggleVideo}
            disabled={!joined}
            title={videoEnabled ? 'Выключить камеру' : 'Включить камеру'}
          >
            {videoEnabled ? <VideoIcon /> : <VideoOffIcon />}
          </button>
          <button className="ctl leave" onClick={onLeave} title="Покинуть встречу">
            <LeaveIcon />
          </button>
        </div>
      </footer>
    </main>
  )
}
