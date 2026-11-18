import {
  createDeepFilterNetAudioWorklet,
  DEEPFILTERNET_SAMPLE_RATE,
} from '@workadventure/noise-suppression/deepfilternet'

const STORAGE_KEY = 'pettyconf:deepfilternet'

export function isDeepFilterSupported() {
  if (typeof window === 'undefined') return false
  return Boolean(
    (window.AudioContext || window.webkitAudioContext) &&
    window.AudioWorklet &&
    typeof WebAssembly === 'object' &&
    typeof WebAssembly.compile === 'function'
  )
}

export function getSavedDeepFilterEnabled() {
  try {
    const val = localStorage.getItem(STORAGE_KEY)
    return val === null ? true : val === 'true'
  } catch {
    return true
  }
}

export function setSavedDeepFilterEnabled(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled))
  } catch {}
}

/**
 * Оборачивает аудиодорожку микрофона в AudioWorklet с DeepFilterNet3.
 * Возвращает { track, rawTrack, cleanup, setEnabled, isEnabled, isFiltered, ready }
 */
export async function createDeepFilterPipeline(rawTrack, options = {}) {
  if (!rawTrack || rawTrack.kind !== 'audio') {
    return {
      track: rawTrack,
      rawTrack,
      cleanup: () => {},
      setEnabled: () => {},
      isEnabled: () => false,
      isFiltered: false,
    }
  }

  const AudioCtx = window.AudioContext || window.webkitAudioContext
  if (!AudioCtx || !isDeepFilterSupported()) {
    console.warn('[DeepFilterNet] Web Audio / Wasm не поддерживается в этом браузере')
    return {
      track: rawTrack,
      rawTrack,
      cleanup: () => {},
      setEnabled: () => {},
      isEnabled: () => false,
      isFiltered: false,
    }
  }

  let audioContext = null
  let sourceNode = null
  let destNode = null
  let dryGain = null
  let wetGain = null
  let workletHandle = null
  let processedTrack = null
  let isEnabled = options.enabled ?? getSavedDeepFilterEnabled()

  const resumeContext = () => {
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {})
    }
  }

  try {
    audioContext = new AudioCtx({ sampleRate: DEEPFILTERNET_SAMPLE_RATE })
    if (audioContext.state === 'suspended') {
      await audioContext.resume().catch(() => {})
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('click', resumeContext, { once: true })
      window.addEventListener('keydown', resumeContext, { once: true })
    }

    sourceNode = audioContext.createMediaStreamSource(new MediaStream([rawTrack]))
    destNode = audioContext.createMediaStreamDestination()
    dryGain = audioContext.createGain()
    wetGain = audioContext.createGain()

    // Прямой путь (dry, без шумоподавления)
    sourceNode.connect(dryGain)
    dryGain.connect(destNode)

    // Инициализация Wasm-ноды DeepFilterNet3
    workletHandle = await createDeepFilterNetAudioWorklet(audioContext, {
      speechAttenuationDb: options.speechAttenuationDb ?? 25,
      pauseAttenuationDb: options.pauseAttenuationDb ?? 45,
      bypassUntilReady: true,
      readyTimeoutMs: 15000,
      ...options,
    })

    // Фильтрованный путь (wet, через DeepFilterNet)
    sourceNode.connect(workletHandle.node)
    workletHandle.node.connect(wetGain)
    wetGain.connect(destNode)

    const applyGains = (enabled) => {
      if (!audioContext || audioContext.state === 'closed') return
      const now = audioContext.currentTime
      if (enabled) {
        dryGain.gain.setValueAtTime(0, now)
        wetGain.gain.setValueAtTime(1, now)
      } else {
        wetGain.gain.setValueAtTime(0, now)
        dryGain.gain.setValueAtTime(1, now)
      }
    }

    applyGains(isEnabled)

    processedTrack = destNode.stream.getAudioTracks()[0]
    if (!processedTrack) {
      throw new Error('Destination node did not provide audio track')
    }

    processedTrack.enabled = rawTrack.enabled

    // Синхронизация mute/unmute
    const syncEnabled = () => {
      if (processedTrack) processedTrack.enabled = rawTrack.enabled
    }
    rawTrack.addEventListener('mute', syncEnabled)
    rawTrack.addEventListener('unmute', syncEnabled)

    const rawEnded = () => {
      try { processedTrack?.stop() } catch {}
    }
    rawTrack.addEventListener('ended', rawEnded)

    const setFilterEnabled = (val) => {
      isEnabled = Boolean(val)
      setSavedDeepFilterEnabled(isEnabled)
      applyGains(isEnabled)
    }

    const cleanup = () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('click', resumeContext)
        window.removeEventListener('keydown', resumeContext)
      }
      rawTrack.removeEventListener('mute', syncEnabled)
      rawTrack.removeEventListener('unmute', syncEnabled)
      rawTrack.removeEventListener('ended', rawEnded)
      try { sourceNode?.disconnect() } catch {}
      try { dryGain?.disconnect() } catch {}
      try { wetGain?.disconnect() } catch {}
      try { workletHandle?.node?.disconnect() } catch {}
      try { workletHandle?.dispose?.() } catch {}
      try { processedTrack?.stop?.() } catch {}
      try { audioContext?.close?.() } catch {}
      sourceNode = null
      dryGain = null
      wetGain = null
      workletHandle = null
      destNode = null
      audioContext = null
      processedTrack = null
    }

    return {
      track: processedTrack,
      rawTrack,
      cleanup,
      setEnabled: setFilterEnabled,
      isEnabled: () => isEnabled,
      isFiltered: true,
      ready: workletHandle.ready,
    }
  } catch (err) {
    console.warn('[DeepFilterNet] Ошибка запуска, откат на обычную дорожку:', err)
    if (typeof window !== 'undefined') {
      window.removeEventListener('click', resumeContext)
      window.removeEventListener('keydown', resumeContext)
    }
    try { sourceNode?.disconnect() } catch {}
    try { dryGain?.disconnect() } catch {}
    try { wetGain?.disconnect() } catch {}
    try { workletHandle?.node?.disconnect() } catch {}
    try { workletHandle?.dispose?.() } catch {}
    try { audioContext?.close?.() } catch {}
    return {
      track: rawTrack,
      rawTrack,
      cleanup: () => {},
      setEnabled: () => {},
      isEnabled: () => false,
      isFiltered: false,
      error: err,
    }
  }
}
