import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import CatLogo from '../components/CatLogo.jsx'
import ThemeToggle from '../components/ThemeToggle.jsx'

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
    const match = value.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    )
    navigate(`/room/${match ? match[0] : value}`)
  }

  return (
    <div className="home-layout">
      <header className="home-topbar">
        <ThemeToggle />
      </header>

      <main className="home">
        <div className="home-hero">
          <div className="home-brand">
            <CatLogo size={76} interactive />
            <h1>PettyConf</h1>
          </div>
          <p className="home-subtitle">Открытые видеовстречи</p>
        </div>

        <div className="home-cards">
          <section className="card">
            <h2>Новая встреча</h2>
            <p>Создайте комнату и отправьте ссылку участникам</p>
            <button
              className="primary"
              onClick={createMeeting}
              disabled={creating}
            >
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
                aria-label="Ссылка или ID комнаты"
              />
              <button
                className="btn-join"
                onClick={joinMeeting}
                disabled={!joinValue.trim()}
              >
                Войти
              </button>
            </div>
          </section>
        </div>

        {error && <div className="error-banner">{error}</div>}
      </main>
    </div>
  )
}
