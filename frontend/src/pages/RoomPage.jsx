import { useState } from 'react'
import { useParams } from 'react-router-dom'
import PreJoinScreen from '../components/PreJoinScreen.jsx'
import RoomView from '../components/RoomView.jsx'

export default function RoomPage() {
  const { roomId } = useParams()
  // null, пока участник не прошёл экран входа
  const [session, setSession] = useState(null)

  if (!session) {
    return <PreJoinScreen roomId={roomId} onJoin={setSession} />
  }

  function handleLeave() {
    session.stream?.getTracks().forEach((t) => t.stop())
    setSession(null) // назад на prejoin — можно войти снова
  }

  return <RoomView session={session} onLeave={handleLeave} />
}
