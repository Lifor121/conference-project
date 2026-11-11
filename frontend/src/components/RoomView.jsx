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
  ScreenShareOffIcon,
  CopyIcon,
  CheckIcon,
  UsersIcon,
  PlayIcon,
  VolumeIcon,
  VolumeOffIcon,
  MaximizeIcon,
  MinimizeIcon,
} from './icons.jsx'

function SpotlightStage({ children, aspectRatio }) {
  const stageRef = useRef(null)
  const [stageBounds, setStageBounds] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      setStageBounds({ width: rect.width, height: rect.height })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fittedStyle = useMemo(() => {
    if (!stageBounds.width || !stageBounds.height) return undefined
    const padX = 16
    const padY = 16
    const maxW = Math.max(100, stageBounds.width - padX)
    const maxH = Math.max(100, stageBounds.height - padY)

    let ratio = 16 / 9
    if (aspectRatio && typeof aspectRatio === 'string' && aspectRatio.includes('/')) {
      const [w, h] = aspectRatio.split('/').map(Number)
      if (w > 0 && h > 0) ratio = w / h
    }

    let width = maxW
    let height = width / ratio

    if (height > maxH) {
      height = maxH
      width = height * ratio
    }

    return {
      width: `${Math.round(width)}px`,
      height: `${Math.round(height)}px`,
      aspectRatio: `${ratio}`,
    }
  }, [stageBounds, aspectRatio])

  return (
    <div className="spotlight-stage" ref={stageRef}>
      {children(fittedStyle)}
    </div>
  )
}

function VideoTile({
  track,
  label,
  muted,
  userMuted,
  fallbackInitial,
  detached,
  isLocal,
  speaking,
  isScreen,
  isFocused,
  isThumbnail,
  onClick,
  onContextMenu,
  fittedStyle,
  onAspectRatioChange,
  children,
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
      const ratio = `${el.videoWidth} / ${el.videoHeight}`
      setAspectRatio(ratio)
      onAspectRatioChange?.(ratio)
    }
  }, [onAspectRatioChange])

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

  const dynamicStyle = isFocused
    ? fittedStyle || (aspectRatio ? { aspectRatio } : undefined)
    : undefined

  return (
    <div
      className={`video-tile${stream ? ' has-video' : ' no-video'}${detached ? ' detached' : ''}${isLocal ? ' is-local' : ''}${speaking ? ' is-speaking' : ''}${isScreen ? ' is-screen-tile' : ''}${isFocused ? ' is-focused' : ''}${isThumbnail ? ' is-thumbnail' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
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

      {children}

      <div className="tile-info-badge">
        {muted && <MicOffIcon size={14} className="badge-muted-icon" />}
        {userMuted && (
          <VolumeOffIcon
            size={14}
            className="badge-user-muted-icon"
            title="Вы заглушили этот звук"
          />
        )}
        <span className="badge-name">{label}</span>
      </div>
    </div>
  )
}

function AudioSink({ track, volume = 100, muted = false }) {
  const ref = useRef(null)
  const ctxRef = useRef(null)
  const sourceRef = useRef(null)
  const gainRef = useRef(null)

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
      if (sourceRef.current) {
        try { sourceRef.current.disconnect() } catch { /* ignore */ }
        sourceRef.current = null
      }
      if (gainRef.current) {
        try { gainRef.current.disconnect() } catch { /* ignore */ }
        gainRef.current = null
      }
      if (ctxRef.current) {
        ctxRef.current.close().catch(() => {})
        ctxRef.current = null
      }
    }
  }, [track])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const isMuted = Boolean(muted)

    if (volume <= 100 && !ctxRef.current) {
      // Обычная громкость (0–100%) — управляем напрямую через HTML-элемент
      el.volume = Math.max(0, Math.min(1, volume / 100))
      el.muted = isMuted
      return
    }

    // Если потребовалось усиление (>100%), инициализируем Web Audio API (GainNode)
    if (!ctxRef.current && track) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (AudioCtx) {
        const ctx = new AudioCtx()
        const source = ctx.createMediaStreamSource(new MediaStream([track]))
        const gain = ctx.createGain()
        source.connect(gain)
        gain.connect(ctx.destination)
        ctxRef.current = ctx
        sourceRef.current = source
        gainRef.current = gain
      }
    }

    if (ctxRef.current) {
      if (ctxRef.current.state === 'suspended') {
        ctxRef.current.resume().catch(() => {})
      }
      // Звук идёт через Web Audio — глушим html-элемент во избежание дублирования
      el.muted = true
      if (gainRef.current) {
        gainRef.current.gain.value = isMuted ? 0 : Math.max(0, volume / 100)
      }
    } else {
      el.volume = Math.max(0, Math.min(1, volume / 100))
      el.muted = isMuted
    }
  }, [volume, muted, track])

  if (!track) return null
  return <audio ref={ref} autoPlay />
}

function RemotePeerTile({
  peer,
  isThumbnail,
  isFocused,
  onFocus,
  onContextMenu,
  userMuted,
  fittedStyle,
  onAspectRatioChange,
}) {
  const audioTrack = peer.tracks['webcam:audio']
  const isSpeaking = useAudioActivity(audioTrack, Boolean(audioTrack))

  return (
    <VideoTile
      track={peer.tracks['webcam:video']}
      muted={!audioTrack}
      userMuted={userMuted}
      label={peer.displayName}
      fallbackInitial={(peer.displayName || '?')[0].toUpperCase()}
      detached={Boolean(peer.detached)}
      isLocal={false}
      speaking={isSpeaking}
      isThumbnail={isThumbnail}
      isFocused={isFocused}
      onClick={onFocus}
      onContextMenu={onContextMenu}
      fittedStyle={fittedStyle}
      onAspectRatioChange={onAspectRatioChange}
    />
  )
}

function RemoteScreenTile({
  peer,
  isThumbnail,
  isFocused,
  onFocus,
  isWatching,
  onWatch,
  onStopWatch,
  onContextMenu,
  userMuted,
  fittedStyle,
  onAspectRatioChange,
}) {
  if (!isWatching) {
    return (
      <div
        className={`video-tile is-screen-tile stream-placeholder${isFocused ? ' is-focused' : ''}${isThumbnail ? ' is-thumbnail' : ''}`}
        onClick={onFocus}
        onContextMenu={onContextMenu}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onFocus()
          }
        }}
        title="Нажмите, чтобы развернуть"
        style={isFocused ? fittedStyle : undefined}
      >
        <div className="stream-placeholder-content">
          <div className="stream-placeholder-icon-wrap">
            <ScreenShareIcon size={isThumbnail ? 20 : 30} />
            <span className="stream-live-badge">LIVE</span>
          </div>
          {!isThumbnail && (
            <div className="stream-placeholder-text">
              <span className="stream-placeholder-author">{peer.displayName}</span>
              <span className="stream-placeholder-sub">ведёт трансляцию</span>
            </div>
          )}
          <button
            type="button"
            className="stream-watch-btn"
            onClick={(e) => {
              e.stopPropagation()
              onWatch()
            }}
          >
            <PlayIcon size={12} />
            <span>{isThumbnail ? 'Смотреть' : 'Смотреть стрим'}</span>
          </button>
        </div>
        <div className="tile-info-badge">
          <ScreenShareIcon size={13} className="badge-screen-icon" />
          {userMuted && (
            <VolumeOffIcon
              size={14}
              className="badge-user-muted-icon"
              title="Вы заглушили этот стрим"
            />
          )}
          <span className="badge-name">{peer.displayName} · Экран</span>
        </div>
      </div>
    )
  }

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
      userMuted={userMuted}
      onClick={onFocus}
      onContextMenu={onContextMenu}
      fittedStyle={fittedStyle}
      onAspectRatioChange={onAspectRatioChange}
    >
      <button
        type="button"
        className="stream-stop-watch-btn"
        onClick={(e) => {
          e.stopPropagation()
          onStopWatch()
        }}
        title="Прекратить просмотр трансляции"
      >
        Прекратить просмотр
      </button>
    </VideoTile>
  )
}

function TileContextMenu({
  menu,
  onClose,
  volume,
  isMuted,
  onVolumeChange,
  onToggleMute,
  isFocused,
  onToggleFocus,
  isWatching,
  onWatch,
  onStopWatch,
  audioEnabled,
  videoEnabled,
  toggleAudio,
  toggleVideo,
}) {
  const menuRef = useRef(null)

  useEffect(() => {
    function handlePointerDown(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose()
      }
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    function handleScrollOrResize() {
      onClose()
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleScrollOrResize)
    window.addEventListener('scroll', handleScrollOrResize, true)

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleScrollOrResize)
      window.removeEventListener('scroll', handleScrollOrResize, true)
    }
  }, [onClose])

  if (!menu) return null

  const isLocal = menu.type === 'me'
  const isLocalScreen = menu.type === 'screen-local'
  const currentVolume = isMuted ? 0 : volume
  const fillPercent = currentVolume / 2

  return (
    <div
      ref={menuRef}
      className="tile-context-menu"
      style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="menu-header">
        <span className="menu-header-name" title={menu.label}>
          {menu.label}
        </span>
      </div>

      <div className="menu-divider" />

      {isLocal ? (
        <div className="menu-actions">
          <button
            type="button"
            className="menu-item-btn"
            onClick={() => {
              toggleAudio()
              onClose()
            }}
          >
            {audioEnabled ? <MicOffIcon size={16} /> : <MicIcon size={16} />}
            <span>{audioEnabled ? 'Выключить микрофон' : 'Включить микрофон'}</span>
          </button>
          <button
            type="button"
            className="menu-item-btn"
            onClick={() => {
              toggleVideo()
              onClose()
            }}
          >
            {videoEnabled ? <VideoOffIcon size={16} /> : <VideoIcon size={16} />}
            <span>{videoEnabled ? 'Выключить камеру' : 'Включить камеру'}</span>
          </button>
        </div>
      ) : isLocalScreen ? null : (
        <>
          <div className="menu-volume-section">
            <div className="menu-volume-header">
              <span className="menu-section-label">Громкость</span>
              <span className="menu-volume-value">{currentVolume}%</span>
            </div>
            <div className="menu-slider-row">
              <input
                type="range"
                min="0"
                max="200"
                value={currentVolume}
                onChange={(e) => onVolumeChange(Number(e.target.value))}
                className="menu-volume-slider"
                style={{
                  background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${fillPercent}%, var(--border) ${fillPercent}%, var(--border) 100%)`,
                }}
              />
            </div>
          </div>

          <div className="menu-actions">
            <button
              type="button"
              className={`menu-item-btn${isMuted ? ' active-danger' : ''}`}
              onClick={() => onToggleMute()}
            >
              {isMuted ? <VolumeIcon size={16} /> : <VolumeOffIcon size={16} />}
              <span>{isMuted ? 'Включить звук' : 'Заглушить'}</span>
            </button>

            {menu.type === 'remote-screen' && (
              isWatching ? (
                <button
                  type="button"
                  className="menu-item-btn danger-text"
                  onClick={() => {
                    onStopWatch()
                    onClose()
                  }}
                >
                  <ScreenShareIcon size={16} />
                  <span>Прекратить просмотр</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="menu-item-btn accent-text"
                  onClick={() => {
                    onWatch()
                    onClose()
                  }}
                >
                  <PlayIcon size={16} />
                  <span>Смотреть стрим</span>
                </button>
              )
            )}
          </div>
        </>
      )}

      <div className="menu-divider" />

      <div className="menu-actions">
        <button
          type="button"
          className="menu-item-btn"
          onClick={() => {
            onToggleFocus()
            onClose()
          }}
        >
          {isFocused ? <MinimizeIcon size={16} /> : <MaximizeIcon size={16} />}
          <span>{isFocused ? 'Свернуть' : 'Развернуть'}</span>
        </button>
      </div>
    </div>
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
  const [focusedAspectRatio, setFocusedAspectRatio] = useState(null)
  const [watchedStreams, setWatchedStreams] = useState(() => new Set())
  const [contextMenu, setContextMenu] = useState(null)
  const [volumeMap, setVolumeMap] = useState({})
  const [mutedMap, setMutedMap] = useState({})
  const localSpeaking = useAudioActivity(localAudioTrack, audioEnabled)

  useEffect(() => {
    setFocusedAspectRatio(null)
  }, [focusedTileId])

  const getVolume = useCallback(
    (id) => (volumeMap[id] !== undefined ? volumeMap[id] : 100),
    [volumeMap],
  )
  const isMuted = useCallback((id) => Boolean(mutedMap[id]), [mutedMap])

  const setVolume = useCallback((id, val) => {
    setVolumeMap((prev) => ({ ...prev, [id]: val }))
    if (val > 0) {
      setMutedMap((prev) => (prev[id] ? { ...prev, [id]: false } : prev))
    }
  }, [])

  const toggleMute = useCallback((id) => {
    setMutedMap((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const handleContextMenu = useCallback((e, targetInfo) => {
    e.preventDefault()
    e.stopPropagation()
    const menuWidth = 240
    const menuHeight = 220
    const x = Math.max(12, Math.min(window.innerWidth - menuWidth - 12, e.clientX || 12))
    const y = Math.max(12, Math.min(window.innerHeight - menuHeight - 12, e.clientY || 12))
    setContextMenu({ x, y, ...targetInfo })
  }, [])

  // Удаляем из watchedStreams стримы, показ которых завершился
  useEffect(() => {
    setWatchedStreams((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const id of next) {
        const peerId = id.slice(0, -7)
        const peer = remotePeers.find((p) => p.id === peerId)
        if (!peer || !peer.tracks['screen:video']) {
          next.delete(id)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [remotePeers])

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

  function renderTile(id, { isThumbnail, isFocused, fittedStyle }) {
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
          fittedStyle={fittedStyle}
          onAspectRatioChange={isFocused ? setFocusedAspectRatio : undefined}
          onClick={handleToggle}
          onContextMenu={(e) =>
            handleContextMenu(e, {
              id: 'me',
              type: 'me',
              label: `${session.displayName} (Вы)`,
            })
          }
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
          fittedStyle={fittedStyle}
          onAspectRatioChange={isFocused ? setFocusedAspectRatio : undefined}
          onClick={handleToggle}
          onContextMenu={(e) =>
            handleContextMenu(e, {
              id: 'screen-local',
              type: 'screen-local',
              label: `${session.displayName} · Экран (Вы)`,
            })
          }
        />
      )
    }

    if (id.endsWith('-screen')) {
      const peerId = id.slice(0, -7)
      const peer = remotePeers.find((p) => p.id === peerId)
      if (!peer || !peer.tracks['screen:video']) return null
      const isWatching = watchedStreams.has(id)
      return (
        <RemoteScreenTile
          key={id}
          peer={peer}
          isThumbnail={isThumbnail}
          isFocused={isFocused}
          isWatching={isWatching}
          userMuted={isMuted(id)}
          fittedStyle={fittedStyle}
          onAspectRatioChange={isFocused ? setFocusedAspectRatio : undefined}
          onWatch={() => setWatchedStreams((prev) => new Set([...prev, id]))}
          onStopWatch={() =>
            setWatchedStreams((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
          }
          onFocus={handleToggle}
          onContextMenu={(e) =>
            handleContextMenu(e, {
              id,
              peerId,
              type: 'remote-screen',
              label: `${peer.displayName} · Экран`,
            })
          }
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
        userMuted={isMuted(id)}
        fittedStyle={fittedStyle}
        onAspectRatioChange={isFocused ? setFocusedAspectRatio : undefined}
        onFocus={handleToggle}
        onContextMenu={(e) =>
          handleContextMenu(e, {
            id,
            type: 'remote-peer',
            label: peer.displayName,
          })
        }
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
            <SpotlightStage aspectRatio={focusedAspectRatio}>
              {(fittedStyle) =>
                renderTile(activeFocusedId, {
                  isThumbnail: false,
                  isFocused: true,
                  fittedStyle,
                })
              }
            </SpotlightStage>
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
        <AudioSink
          key={p.id}
          track={p.tracks['webcam:audio']}
          volume={getVolume(p.id)}
          muted={isMuted(p.id)}
        />
      ))}

      {/* Аудио потоки демонстраций экранов (только для просматриваемых) */}
      {remotePeers.map((p) => {
        const screenAudio = p.tracks['screen:audio']
        if (!screenAudio) return null
        const streamId = `${p.id}-screen`
        if (!watchedStreams.has(streamId)) return null
        return (
          <AudioSink
            key={streamId}
            track={screenAudio}
            volume={getVolume(streamId)}
            muted={isMuted(streamId)}
          />
        )
      })}

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
              className={`dock-btn ${screenEnabled ? 'screen-active' : 'secondary'}`}
              onClick={toggleScreenShare}
              disabled={!joined}
              title={screenEnabled ? 'Остановить демонстрацию' : 'Демонстрация экрана'}
            >
              {screenEnabled ? <ScreenShareOffIcon size={22} /> : <ScreenShareIcon size={22} />}
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

      {/* Контекстное меню по ПКМ */}
      {contextMenu && (
        <TileContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          volume={getVolume(contextMenu.id)}
          isMuted={isMuted(contextMenu.id)}
          onVolumeChange={(val) => setVolume(contextMenu.id, val)}
          onToggleMute={() => toggleMute(contextMenu.id)}
          isFocused={activeFocusedId === contextMenu.id}
          onToggleFocus={() => {
            setFocusedTileId((prev) => (prev === contextMenu.id ? null : contextMenu.id))
          }}
          isWatching={watchedStreams.has(contextMenu.id)}
          onWatch={() => setWatchedStreams((prev) => new Set([...prev, contextMenu.id]))}
          onStopWatch={() =>
            setWatchedStreams((prev) => {
              const next = new Set(prev)
              next.delete(contextMenu.id)
              return next
            })
          }
          audioEnabled={audioEnabled}
          videoEnabled={videoEnabled}
          toggleAudio={toggleAudio}
          toggleVideo={toggleVideo}
        />
      )}
    </div>
  )
}
