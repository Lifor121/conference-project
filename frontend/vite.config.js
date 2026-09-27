import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // слушать 0.0.0.0 — иначе из контейнера порт не достучится
    port: 5173,
    proxy: {
      // относительные /api/* работают и в dev (прокси), и в prod (nginx) —
      '/api': {
        target: 'http://backend:8000',
        changeOrigin: true,
      },
    },
  },
})
