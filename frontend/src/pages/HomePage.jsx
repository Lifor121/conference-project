import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'

export default function HomePage() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState(null)
  const [joinValue, setJoinValue] = useState('')

  async function createMeeting() {
    setCreating(true)
    setError(null)
    try {
      const room = await api.createRoom(`Встреча ${new Date().toLocaleString('ru-RU')}`)
      navigate(`/room/${room.id}`)
    } catch (e) {
      setError(`Не удалось создать встречу: ${e.message}`)
      setCreating(false)
    }
  }

  function joinMeeting() {
    const value = joinValue.trim()
    if (!value) return
    // принимаем и голый uuid, и полную ссылку http://.../room/<uuid>
    const match = value.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )
    navigate(`/room/${match ? match[0] : value}`)
  }

  return (
    <main className="home">
      <div className="home-hero">
        <h1>VC</h1>
        <p>Открытые видеовстречи</p>
      </div>

      <div className="home-cards">
        <section className="card">
          <h2>Новая встреча</h2>
          <p>Создайте комнату и отправьте ссылку участникам</p>
          <button className="primary" onClick={createMeeting} disabled={creating}>
            {creating ? 'Создаём…' : 'Создать встречу'}
          </button>
        </section>

        <section className="card">
          <h2>Присоединиться</h2>
          <p>Вставьте ссылку на встречу или id комнаты</p>
          <div className="join-row">
            <input
              value={joinValue}
              onChange={(e) => setJoinValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && joinMeeting()}
              placeholder="https://…/room/…"
            />
            <button onClick={joinMeeting}>Войти</button>
          </div>
        </section>
      </div>

      {error && <div className="error">{error}</div>}
    </main>
  )
}
