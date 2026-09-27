import { useEffect, useRef } from 'react'

// локальное превью без signaling.
// потом здесь будут mediasoup-client и удалённые участники.
export default function RoomView({ session, onLeave }) {
  const videoRef = useRef(null)

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = session.stream
  }, [session.stream])

  return (
    <main className="room">
      <header className="room-header">
        <span className="muted">Комната {session.roomId.slice(0, 8)}…</span>
        <button onClick={onLeave}>Покинуть встречу</button>
      </header>

      <div className="video-grid">
        <div className="video-tile">
          {session.videoEnabled ? (
            <video ref={videoRef} autoPlay playsInline muted />
          ) : (
            <div className="avatar">{session.displayName[0]}</div>
          )}
          <div className="tile-label">
            {session.displayName} (вы){session.audioEnabled ? '' : ' 🔇'}
          </div>
        </div>
      </div>

      <footer className="room-footer"></footer>
    </main>
  )
}
