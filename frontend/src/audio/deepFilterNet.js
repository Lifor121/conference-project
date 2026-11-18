import {
  createDeepFilterNetAudioWorklet,
  DEEPFILTERNET_SAMPLE_RATE,
} from '@workadventure/noise-suppression/deepfilternet'

const STORAGE_KEY = 'pettyconf:deepfilternet'
const ATTENUATION_KEY = 'pettyconf:attenuationDb'
export const DEFAULT_ATTENUATION_DB = 25

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

export function getSavedAttenuationDb() {
  try {
    const val = localStorage.getItem(ATTENUATION_KEY)
    const num = Number(val)
    return num && !isNaN(num) ? num : DEFAULT_ATTENUATION_DB
  } catch {
    return DEFAULT_ATTENUATION_DB
  }
}

export function setSavedAttenuationDb(val) {
  try {
    localStorage.setItem(ATTENUATION_KEY, String(val))
  } catch {}
}

/**
 * Оборачивает аудиодорожку микрофона в AudioWorklet с DeepFilterNet3.
 * Возвращает { track, rawTrack, cleanup, setEnabled, isEnabled, setLevel, getLevel, isFiltered, ready }
 */
export async function createDeepFilterPipeline(rawTrack, options = {}) {
  if (!rawTrack || rawTrack.kind !== 'audio') {
    return {
      track: rawTrack,
      rawTrack,
      cleanup: () => {},
      setEnabled: () => {},
      isEnabled: () => false,
      setLevel: () => {},
      getLevel: () => DEFAULT_ATTENUATION_DB,
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
      setLevel: () => {},
      getLevel: () => DEFAULT_ATTENUATION_DB,
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
  let currentAttenuationDb = options.speechAttenuationDb ?? getSavedAttenuationDb()

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

    // Устанавливаем исходные значения gain до подключения, чтобы избежать щелчков
    if (isEnabled) {
      dryGain.gain.value = 0
      wetGain.gain.value = 1
    } else {
      dryGain.gain.value = 1
      wetGain.gain.value = 0
    }

    // Прямой путь (dry, без шумоподавления)
    sourceNode.connect(dryGain)
    dryGain.connect(destNode)

    // Инициализация Wasm-ноды DeepFilterNet3
    workletHandle = await createDeepFilterNetAudioWorklet(audioContext, {
      speechAttenuationDb: currentAttenuationDb,
      pauseAttenuationDb: Math.min(currentAttenuationDb + 20, 60),
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

    const setLevel = async (newDb) => {
      const db = Number(newDb)
      if (isNaN(db) || db === currentAttenuationDb) return
      currentAttenuationDb = db
      setSavedAttenuationDb(db)
      if (!audioContext || audioContext.state === 'closed') return

      try {
        const now = audioContext.currentTime
        dryGain.gain.setValueAtTime(1, now)
        wetGain.gain.setValueAtTime(0, now)

        const oldHandle = workletHandle
        const newHandle = await createDeepFilterNetAudioWorklet(audioContext, {
          speechAttenuationDb: db,
          pauseAttenuationDb: Math.min(db + 20, 60),
          bypassUntilReady: true,
          readyTimeoutMs: 15000,
          ...options,
        })

        try { sourceNode?.disconnect(oldHandle.node) } catch {}
        try { oldHandle?.node?.disconnect() } catch {}
        try { oldHandle?.dispose?.() } catch {}

        workletHandle = newHandle
        sourceNode.connect(workletHandle.node)
        workletHandle.node.connect(wetGain)

        applyGains(isEnabled)
      } catch (err) {
        console.warn('[DeepFilterNet] Ошибка смены уровня:', err)
        applyGains(isEnabled)
      }
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
      setLevel,
      getLevel: () => currentAttenuationDb,
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
      setLevel: () => {},
      getLevel: () => DEFAULT_ATTENUATION_DB,
      isFiltered: false,
      error: err,
    }
  }
}
