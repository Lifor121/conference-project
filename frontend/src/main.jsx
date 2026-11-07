import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './styles.css'
import { applyTheme, getSavedTheme } from './theme.js'
import HomePage from './pages/HomePage.jsx'
import RoomPage from './pages/RoomPage.jsx'

// Применяем тему до монтирования, чтобы избежать мерцания
applyTheme(getSavedTheme())

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/room/:roomId" element={<RoomPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
