import { useEffect, useMemo, useRef } from 'react'
import { useRoom } from '../room/useRoom.js'

// Видеотайл: принимает ОДИН трек (или null → аватар).
// muted обязателен: аудио играем отдельными элементами ниже, иначе эхо.
function VideoTile({ track, label, fallbackInitial }) {
  const ref = useRef(null)
  const stream = useMemo(() => (track ? new MediaStream([track]) : null), [track])

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])

  return (
    <div className="video-tile">
      {stream ? (
        <video ref={ref} autoPlay playsInline muted />
      ) : (
        <div className="avatar">{fallbackInitial}</div>
      )}
      <div className="tile-label">{label}</div>
    </div>
  )
}

// Скрытый <audio> на каждый голосовой трек удалённого участника
function AudioSink({ track }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current && track) ref.current.srcObject = new MediaStream([track])
  }, [track])
  if (!track) return null
  return <audio ref={ref} autoPlay />
}

function RemotePeerTiles({ peer }) {
  return (
    <>
      <VideoTile
        track={peer.tracks['webcam:video']}
        label={peer.displayName}
        fallbackInitial={peer.displayName[0]}
      />
      {peer.tracks['screen:video'] && (
        <VideoTile
          track={peer.tracks['screen:video']}
          label={`${peer.displayName} — экран`}
          fallbackInitial="🖥"
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

  const hasMic = !!session.stream?.getAudioTracks().length
  const joined = phase === 'joined'

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
          Комната {session.roomId.slice(0, 8)}… · {joined ? 'в эфире' : 'подключение…'}
        </span>
      </header>

      <div className="video-grid">
        <VideoTile
          key="me"
          track={videoEnabled ? localVideoTrack : null}
          label={`${session.displayName} (вы)${audioEnabled ? '' : ' 🔇'}`}
          fallbackInitial={session.displayName[0]}
        />
        {remotePeers.map((p) => (
          <RemotePeerTiles key={p.id} peer={p} />
        ))}
      </div>

      {remotePeers.map((p) => (
        <AudioSink key={p.id} track={p.tracks['webcam:audio']} />
      ))}

      <footer className="room-footer">
        <div className="controls">
          <button
            className={audioEnabled ? 'ctl on' : 'ctl off'}
            onClick={toggleAudio}
            disabled={!joined || !hasMic}
            title={hasMic ? (audioEnabled ? 'Выключить микрофон' : 'Включить микрофон') : 'Микрофона нет'}
          >
            {audioEnabled ? '🎙' : '🔇'}
          </button>
          <button
            className={videoEnabled ? 'ctl on' : 'ctl off'}
            onClick={toggleVideo}
            disabled={!joined}
            title={videoEnabled ? 'Выключить камеру' : 'Включить камеру'}
          >
            {videoEnabled ? '📹' : '📷'}
          </button>
          <button className="ctl leave" onClick={onLeave}>Покинуть</button>
        </div>
      </footer>
    </main>
  )
}
