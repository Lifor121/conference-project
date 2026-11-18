import { useEffect, useState } from 'react'

let sharedAudioContext = null

function getAudioContext() {
  if (typeof window === 'undefined') return null
  try {
    if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext
      if (AudioCtx) sharedAudioContext = new AudioCtx()
    }
    if (sharedAudioContext && sharedAudioContext.state === 'suspended') {
      sharedAudioContext.resume().catch(() => {})
    }
  } catch {
    return null
  }
  return sharedAudioContext
}

/**
 * Отслеживает активность речи (audio volume) в MediaStreamTrack
 * @param {MediaStreamTrack|null} track
 * @param {boolean} enabled - включен ли микрофон
 * @param {number} threshold - порог громкости (0-255), по умолчанию 16
 * @returns {boolean} speaking - говорит ли участник прямо сейчас
 */
export function useAudioActivity(track, enabled = true, threshold = 16) {
  const [speaking, setSpeaking] = useState(false)

  useEffect(() => {
    setSpeaking(false)
    if (!track || !enabled || track.readyState !== 'live' || track.kind !== 'audio') {
      return
    }

    const ctx = getAudioContext()
    if (!ctx) return

    let source = null
    let analyser = null
    let intervalId = null
    let disposed = false
    let warmupTicks = 2 // Первые 180 мс отсекают переходные импульсы при подключении ноды
    let isSpeaking = false
    let lastSpeechTime = 0

    try {
      source = ctx.createMediaStreamSource(new MediaStream([track]))
      analyser = ctx.createAnalyser()
      analyser.fftSize = 128
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)
    } catch {
      return
    }

    const buffer = new Uint8Array(analyser.frequencyBinCount)

    const checkVolume = () => {
      if (disposed) return

      if (warmupTicks > 0) {
        warmupTicks--
        return
      }

      analyser.getByteFrequencyData(buffer)

      let sum = 0
      for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i]
      }
      const avg = sum / buffer.length
      const now = Date.now()

      if (avg >= threshold) {
        lastSpeechTime = now
        if (!isSpeaking) {
          isSpeaking = true
          setSpeaking(true)
        }
      } else if (isSpeaking && now - lastSpeechTime > 350) {
        isSpeaking = false
        setSpeaking(false)
      }
    }

    // Проверяем каждые 90 мс — плавно и не грузит процессор
    intervalId = setInterval(checkVolume, 90)

    return () => {
      disposed = true
      clearInterval(intervalId)
      setSpeaking(false)
      try {
        source?.disconnect()
      } catch {
        // no-op
      }
    }
  }, [track, enabled, threshold])

  return speaking
}
