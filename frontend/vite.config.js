import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { noiseSuppressionAudioWorkletVitePlugin } from '@workadventure/noise-suppression/vite'

export default defineConfig({
  plugins: [react(), noiseSuppressionAudioWorkletVitePlugin()],
  server: {
    host: true, // слушать 0.0.0.0 — иначе из контейнера порт не достучится
    port: 5173,
    proxy: {
      // относительные /api/* работают и в dev (прокси), и в prod (nginx) —
      '/api': {
        target: 'http://backend:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://media:4443',
        ws: true,
        changeOrigin: true
      },
    },
  },
})
