import { useEffect, useMemo, useRef, useState } from 'react'
import { useRoom } from '../room/useRoom.js'
import { useAudioActivity } from '../room/useAudioActivity.js'
import ThemeToggle from './ThemeToggle.jsx'
import {
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  VideoIcon,
  VideoOffIcon,
  ScreenShareIcon,
  CopyIcon,
  CheckIcon,
  UsersIcon,
} from './icons.jsx'

function VideoTile({ track, label, muted, fallbackInitial, detached, isLocal, speaking }) {
  const ref = useRef(null)
  const stream = useMemo(() => (track ? new MediaStream([track]) : null), [track])

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])

  return (
    <div
      className={`video-tile${detached ? ' detached' : ''}${isLocal ? ' is-local' : ''}${speaking ? ' is-speaking' : ''}`}
    >
      {stream ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={isLocal}
          className="tile-video-element"
        />
      ) : (
        <div className="tile-avatar-wrapper">
          <div className="tile-avatar-circle">
            {fallbackInitial || '?'}
          </div>
        </div>
      )}

      {detached && (
        <div className="tile-detached-overlay">
          <div className="mini-spinner" />
          <span>Переподключение…</span>
        </div>
      )}

      <div className="tile-info-badge">
        {muted && <MicOffIcon size={14} className="badge-muted-icon" />}
        <span className="badge-name">{label}</span>
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
    return () => {
      el.srcObject = null
    }
  }, [track])
  if (!track) return null
  return <audio ref={ref} autoPlay />
}

function RemotePeerTiles({ peer }) {
  const audioTrack = peer.tracks['webcam:audio']
  const isSpeaking = useAudioActivity(audioTrack, Boolean(audioTrack))

  return (
    <>
      <VideoTile
        track={peer.tracks['webcam:video']}
        muted={!audioTrack}
        label={peer.displayName}
        fallbackInitial={(peer.displayName || '?')[0].toUpperCase()}
        detached={Boolean(peer.detached)}
        isLocal={false}
        speaking={isSpeaking}
      />
      {peer.tracks['screen:video'] && (
        <VideoTile
          track={peer.tracks['screen:video']}
          label={`${peer.displayName} · Экран`}
          fallbackInitial="Э"
          isLocal={false}
          speaking={false}
        />
      )}
    </>
  )
}

export default function RoomView({ session, onLeave }) {
  const {
    phase,
    error,
    remotePeers,
    audioEnabled,
    videoEnabled,
    localVideoTrack,
    localAudioTrack,
    screenEnabled,
    localScreenTrack,
    toggleAudio,
    toggleVideo,
    toggleScreenShare,
  } = useRoom({ session })

  const joined = phase === 'joined'
  const [copied, setCopied] = useState(false)
  const localSpeaking = useAudioActivity(localAudioTrack, audioEnabled)

  const [showReconnectOverlay, setShowReconnectOverlay] = useState(false)
  useEffect(() => {
    if (phase !== 'reconnecting') {
      setShowReconnectOverlay(false)
      return
    }
    const timer = setTimeout(() => setShowReconnectOverlay(true), 1200)
    return () => clearTimeout(timer)
  }, [phase])

  function copyMeetingLink() {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  const totalTiles =
    1 +
    (screenEnabled && localScreenTrack ? 1 : 0) +
    remotePeers.length +
    remotePeers.filter((p) => Boolean(p.tracks['screen:video'])).length

  if (phase === 'error') {
    return (
      <main className="room-viewport error-state">
        <div className="error-dialog-box">
          <div className="error-icon-circle">!</div>
          <h2>Ошибка подключения</h2>
          <p className="error-desc">{error}</p>
          <button className="primary" onClick={onLeave}>
            Вернуться на главную
          </button>
        </div>
      </main>
    )
  }

  return (
    <div className="room-viewport">
      {/* Шапка звонка */}
      <header className="room-topbar">
        <div className="topbar-left">
          <span className="room-title">Комната {session.roomId.slice(0, 8)}…</span>
          <button
            type="button"
            className="btn-copy-link"
            onClick={copyMeetingLink}
            title="Скопировать ссылку"
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            <span>{copied ? 'Скопировано' : 'Копировать ссылку'}</span>
          </button>
        </div>

        <div className="topbar-right">
          <div className="participants-badge" title="Количество участников">
            <UsersIcon size={15} />
            <span>{remotePeers.length + 1}</span>
          </div>

          {!joined && (
            <div
              className={`connection-pill ${
                phase === 'reconnecting' ? 'reconnecting' : 'connecting'
              }`}
            >
              <span className="status-dot-pulse" />
              <span className="status-text">
                {phase === 'reconnecting'
                  ? 'Переподключение…'
                  : 'Подключение…'}
              </span>
            </div>
          )}

          <ThemeToggle />
        </div>
      </header>

      {/* Основная рабочая область видео */}
      <section className="room-video-stage">
        <div className="video-grid" data-count={totalTiles}>
          <VideoTile
            key="me"
            track={videoEnabled ? localVideoTrack : null}
            muted={!audioEnabled}
            label={`${session.displayName} (Вы)`}
            fallbackInitial={(session.displayName || 'Я')[0].toUpperCase()}
            isLocal={true}
            speaking={localSpeaking}
          />
          {screenEnabled && localScreenTrack && (
            <VideoTile
              key="screen-local"
              track={localScreenTrack}
              label={`${session.displayName} · Экран (Вы)`}
              fallbackInitial="Э"
              isLocal={false}
              speaking={false}
            />
          )}
          {remotePeers.map((p) => (
            <RemotePeerTiles key={p.id} peer={p} />
          ))}
        </div>
      </section>

      {/* Оверлей начального подключения */}
      {phase === 'connecting' && (
        <div className="room-modal-backdrop">
          <div className="modal-content-card">
            <div className="stage-spinner" />
            <p>Входим в комнату…</p>
          </div>
        </div>
      )}

      {/* Оверлей долгого переподключения */}
      {showReconnectOverlay && (
        <div className="room-modal-backdrop reconnecting">
          <div className="modal-content-card">
            <div className="stage-spinner amber" />
            <p>Связь с сервером потеряна. Переподключение…</p>
          </div>
        </div>
      )}

      {/* Аудио потоки участников */}
      {remotePeers.map((p) => (
        <AudioSink key={p.id} track={p.tracks['webcam:audio']} />
      ))}

      {/* Фиксированная нижняя панель управления */}
      <footer className="room-bottom-dock">
        <div className="dock-container">
          <button
            type="button"
            className={`dock-btn ${audioEnabled ? 'active' : 'danger-state'}`}
            onClick={toggleAudio}
            disabled={!joined}
            title={audioEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
          >
            {audioEnabled ? <MicIcon size={22} /> : <MicOffIcon size={22} />}
          </button>

          <button
            type="button"
            className={`dock-btn ${videoEnabled ? 'active' : 'danger-state'}`}
            onClick={toggleVideo}
            disabled={!joined}
            title={videoEnabled ? 'Выключить камеру' : 'Включить камеру'}
          >
            {videoEnabled ? <VideoIcon size={22} /> : <VideoOffIcon size={22} />}
          </button>

          <button
            type="button"
            className={`dock-btn ${screenEnabled ? 'active' : 'secondary'}`}
            onClick={toggleScreenShare}
            disabled={!joined}
            title={screenEnabled ? 'Остановить демонстрацию' : 'Демонстрация экрана'}
          >
            <ScreenShareIcon size={22} />
          </button>

          <button
            type="button"
            className="dock-btn leave-action"
            onClick={onLeave}
            title="Покинуть встречу"
          >
            <LeaveIcon size={22} />
          </button>
        </div>
      </footer>
    </div>
  )
}
