import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

function VideoTile({
  track,
  label,
  muted,
  fallbackInitial,
  detached,
  isLocal,
  speaking,
  isScreen,
  isFocused,
  isThumbnail,
  onClick,
}) {
  const ref = useRef(null)
  const stream = useMemo(() => (track ? new MediaStream([track]) : null), [track])
  const [aspectRatio, setAspectRatio] = useState(null)

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])

  const updateAspectRatio = useCallback(() => {
    const el = ref.current
    if (el && el.videoWidth > 0 && el.videoHeight > 0) {
      setAspectRatio(`${el.videoWidth} / ${el.videoHeight}`)
    }
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('loadedmetadata', updateAspectRatio)
    el.addEventListener('resize', updateAspectRatio)
    updateAspectRatio()
    return () => {
      el.removeEventListener('loadedmetadata', updateAspectRatio)
      el.removeEventListener('resize', updateAspectRatio)
    }
  }, [stream, updateAspectRatio])

  const dynamicStyle = isFocused && aspectRatio ? { aspectRatio } : undefined

  return (
    <div
      className={`video-tile${stream ? ' has-video' : ' no-video'}${detached ? ' detached' : ''}${isLocal ? ' is-local' : ''}${speaking ? ' is-speaking' : ''}${isScreen ? ' is-screen-tile' : ''}${isFocused ? ' is-focused' : ''}${isThumbnail ? ' is-thumbnail' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onClick()
        }
      }}
      title={isFocused ? 'Нажмите, чтобы свернуть' : 'Нажмите, чтобы развернуть'}
      style={dynamicStyle}
    >
      {stream ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={isLocal}
          className={`tile-video-element${isScreen ? ' is-screen' : ''}`}
          onLoadedMetadata={updateAspectRatio}
          onResize={updateAspectRatio}
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

function RemotePeerTile({ peer, isThumbnail, isFocused, onFocus }) {
  const audioTrack = peer.tracks['webcam:audio']
  const isSpeaking = useAudioActivity(audioTrack, Boolean(audioTrack))

  return (
    <VideoTile
      track={peer.tracks['webcam:video']}
      muted={!audioTrack}
      label={peer.displayName}
      fallbackInitial={(peer.displayName || '?')[0].toUpperCase()}
      detached={Boolean(peer.detached)}
      isLocal={false}
      speaking={isSpeaking}
      isThumbnail={isThumbnail}
      isFocused={isFocused}
      onClick={onFocus}
    />
  )
}

function RemoteScreenTile({ peer, isThumbnail, isFocused, onFocus }) {
  return (
    <VideoTile
      track={peer.tracks['screen:video']}
      label={`${peer.displayName} · Экран`}
      fallbackInitial="Э"
      isLocal={false}
      speaking={false}
      isScreen={true}
      isThumbnail={isThumbnail}
      isFocused={isFocused}
      onClick={onFocus}
    />
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
    supportsScreenShare,
    toggleAudio,
    toggleVideo,
    toggleScreenShare,
  } = useRoom({ session })

  const joined = phase === 'joined'
  const [copied, setCopied] = useState(false)
  const [focusedTileId, setFocusedTileId] = useState(null)
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

  const tileIds = useMemo(() => [
    'me',
    ...(screenEnabled && localScreenTrack ? ['screen-local'] : []),
    ...remotePeers.flatMap((p) => [
      p.id,
      ...(p.tracks['screen:video'] ? [`${p.id}-screen`] : []),
    ]),
  ], [screenEnabled, localScreenTrack, remotePeers])

  const activeFocusedId = tileIds.includes(focusedTileId) ? focusedTileId : null

  const totalTiles = tileIds.length

  function renderTile(id, { isThumbnail, isFocused }) {
    const handleToggle = () => {
      setFocusedTileId((prev) => (prev === id ? null : id))
    }

    if (id === 'me') {
      return (
        <VideoTile
          key="me"
          track={videoEnabled ? localVideoTrack : null}
          muted={!audioEnabled}
          label={`${session.displayName} (Вы)`}
          fallbackInitial={(session.displayName || 'Я')[0].toUpperCase()}
          isLocal={true}
          speaking={localSpeaking}
          isThumbnail={isThumbnail}
          isFocused={isFocused}
          onClick={handleToggle}
        />
      )
    }

    if (id === 'screen-local') {
      return (
        <VideoTile
          key="screen-local"
          track={localScreenTrack}
          label={`${session.displayName} · Экран (Вы)`}
          fallbackInitial="Э"
          isLocal={false}
          speaking={false}
          isScreen={true}
          isThumbnail={isThumbnail}
          isFocused={isFocused}
          onClick={handleToggle}
        />
      )
    }

    if (id.endsWith('-screen')) {
      const peerId = id.slice(0, -7)
      const peer = remotePeers.find((p) => p.id === peerId)
      if (!peer || !peer.tracks['screen:video']) return null
      return (
        <RemoteScreenTile
          key={id}
          peer={peer}
          isThumbnail={isThumbnail}
          isFocused={isFocused}
          onFocus={handleToggle}
        />
      )
    }

    const peer = remotePeers.find((p) => p.id === id)
    if (!peer) return null
    return (
      <RemotePeerTile
        key={id}
        peer={peer}
        isThumbnail={isThumbnail}
        isFocused={isFocused}
        onFocus={handleToggle}
      />
    )
  }

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
        {activeFocusedId ? (
          <div className="spotlight-layout">
            <div className="spotlight-filmstrip">
              {tileIds
                .filter((id) => id !== activeFocusedId)
                .map((id) => renderTile(id, { isThumbnail: true, isFocused: false }))}
            </div>
            <div className="spotlight-stage">
              {renderTile(activeFocusedId, { isThumbnail: false, isFocused: true })}
            </div>
          </div>
        ) : (
          <div className="video-grid" data-count={totalTiles}>
            {tileIds.map((id) => renderTile(id, { isThumbnail: false, isFocused: false }))}
          </div>
        )}
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

          {supportsScreenShare && (
            <button
              type="button"
              className={`dock-btn ${screenEnabled ? 'active' : 'secondary'}`}
              onClick={toggleScreenShare}
              disabled={!joined}
              title={screenEnabled ? 'Остановить демонстрацию' : 'Демонстрация экрана'}
            >
              <ScreenShareIcon size={22} />
            </button>
          )}

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
