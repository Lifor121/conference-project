import { useCallback, useEffect, useRef, useState } from 'react'
import { Device } from 'mediasoup-client'
import { SignalingClient } from '../signaling/SignalingClient.js'

const ERROR_TEXT = {
  room_not_found: 'Встреча не найдена',
  room_closed: 'Встреча уже закрыта',
  room_full: 'Встреча заполнена',
}

const JOIN_RETRY_BASE_MS = 1000
const JOIN_RETRY_MAX_MS = 8000

// Стабильный id вкладки: хранится в sessionStorage, переживёт перезагрузку
// страницы и переключение сети. Сервер по нему опознаёт вернувшегося
// участника и заменяет старую сессию вместо создания дубля.
// Между вкладками id разные (sessionStorage не общий).
const PEER_ID_KEY = 'vc:peerId'

function getStablePeerId() {
  let id = null
  try {
    id = sessionStorage.getItem(PEER_ID_KEY)
  } catch {
    // приватный режим и т.п. — просто сгенерируем новый
  }
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    id = crypto.randomUUID?.() ?? `peer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    try {
      sessionStorage.setItem(PEER_ID_KEY, id)
    } catch {
      // не критично: без хранилища просто не сможем «вернуться» тем же id
    }
  }
  return id
}

// remotePeers: [{ id, displayName, tracks: { 'webcam:audio' | 'webcam:video' | 'screen:video': MediaStreamTrack } }]
export function useRoom({ session }) {
  const [phase, setPhase] = useState('connecting') // connecting | joined | reconnecting | error
  const [error, setError] = useState(null)
  const [remotePeers, setRemotePeers] = useState([])

  // локальное состояние и контролы
  const [audioEnabled, setAudioEnabledState] = useState(session.audioEnabled)
  const [videoEnabled, setVideoEnabledState] = useState(session.videoEnabled)
  const [localVideoTrack, setLocalVideoTrack] = useState(
    () => session.stream?.getVideoTracks()[0] ?? null,
  )
  // ref-зеркала: контролы читают актуальное значение без stale-замыканий
  const audioEnabledRef = useRef(session.audioEnabled)
  const videoEnabledRef = useRef(session.videoEnabled)

  const setAudioEnabled = (v) => { audioEnabledRef.current = v; setAudioEnabledState(v) }
  const setVideoEnabled = (v) => { videoEnabledRef.current = v; setVideoEnabledState(v) }

  // mediasoup-объекты — в ref: их изменения не должны вызывать рендеры
  const r = useRef({
    signaling: null,
    device: null,
    sendTransport: null,
    recvTransport: null,
    recvTransportPromise: null,
    iceServers: [],
    producers: new Map(),       // 'webcam:audio' | 'webcam:video' -> Producer
    consumers: new Map(),       // consumerId -> { consumer, peerId, key }
    extraLocalTracks: new Set(), // треки, полученные уже внутри комнаты
    // живые локальные треки для (пере)публикации: getUserMedia не зависит
    // от сети, треки переживают обрыв и годятся для нового транспорта
    activeTracks: {
      audio: session.stream?.getAudioTracks()[0] ?? null,
      video: session.stream?.getVideoTracks()[0] ?? null,
    },
  })

  // регистрируем producer + реакция на выдёргивание устройства
  const watchProducer = useCallback((producer, key) => {
    r.current.producers.set(key, producer)
    producer.on('trackended', () => {
      console.warn(`[producer] ${key}: трек закончился (устройство отключилось?)`)
      r.current.signaling
        ?.request('pauseProducer', { producerId: producer.id })
        .catch(() => {})
      if (key === 'webcam:audio') {
        audioEnabledRef.current = false
        setAudioEnabledState(false)
      }
      if (key === 'webcam:video') {
        videoEnabledRef.current = false
        setVideoEnabledState(false)
      }
    })
  }, [])

  // --- контролы (вызываются из RoomView) ---

  async function toggleAudio() {
    const refs = r.current
    if (!refs.signaling) return
    const producer = refs.producers.get('webcam:audio')
    try {
      if (!producer) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: session.devices?.micId || undefined },
        })
        const track = stream.getAudioTracks()[0]
        if (!track) throw new Error('Микрофон не найден')
        try {
          const p = await refs.sendTransport.produce({ track, appData: { source: 'webcam' } })
          watchProducer(p, 'webcam:audio')
          refs.extraLocalTracks.add(track)
          refs.activeTracks.audio = track
          setAudioEnabled(true)
        } catch (e) {
          track.stop()
          throw e
        }
        return
      }
      if (audioEnabledRef.current) {
        producer.pause() // локально: трек гасится, кадры не кодируются
        await refs.signaling.request('pauseProducer', { producerId: producer.id }) // серверно + нотификация другим
        setAudioEnabled(false)
      } else {
        producer.resume()
        await refs.signaling.request('resumeProducer', { producerId: producer.id })
        setAudioEnabled(true)
      }
    } catch (e) {
      console.error('[toggleAudio]', e.message)
    }
  }

  async function toggleVideo() {
    const refs = r.current
    if (!refs.signaling) return
    const producer = refs.producers.get('webcam:video')
    try {
      if (!producer) {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: session.devices?.cameraId || undefined },
        })
        const track = stream.getVideoTracks()[0]
        if (!track) throw new Error('Камера не найдена')
        try {
          const p = await refs.sendTransport.produce({ track, appData: { source: 'webcam' } })
          watchProducer(p, 'webcam:video')
          refs.extraLocalTracks.add(track)
          refs.activeTracks.video = track
          setLocalVideoTrack(track)
          setVideoEnabled(true)
        } catch (e) {
          track.stop()
          throw e
        }
        return
      }
      if (videoEnabledRef.current) {
        producer.pause()
        await refs.signaling.request('pauseProducer', { producerId: producer.id })
        setVideoEnabled(false)
      } else {
        producer.resume()
        await refs.signaling.request('resumeProducer', { producerId: producer.id })
        setVideoEnabled(true)
      }
    } catch (e) {
      console.error('[toggleVideo]', e.message)
    }
  }

  useEffect(() => {
    let disposed = false
    const refs = r.current
    const peerId = getStablePeerId()

    // producers, о которых узнали до готовности Device — попробуем после
    const pendingProducerIds = new Set()
    const triedProducerIds = new Set() // защита от двойного consume одного producer

    // защита от гонки переподключений: новый запуск отменяет последствия старого
    let joinSeq = 0
    let joinRetryTimer = 0
    let joinAttempt = 0

    // состояние списка участников

    function addPeer(peerId_, displayName) {
      setRemotePeers((prev) =>
        prev.some((p) => p.id === peerId_)
          ? prev
          : [...prev, { id: peerId_, displayName, tracks: {} }],
      )
    }

    function removePeer(peerId_) {
      for (const [id, entry] of [...refs.consumers]) {
        if (entry.peerId === peerId_) removeConsumerTrack(id)
      }
      setRemotePeers((prev) => prev.filter((p) => p.id !== peerId_))
    }

    function removeConsumerTrack(consumerId) {
      const entry = refs.consumers.get(consumerId)
      if (!entry) return
      refs.consumers.delete(consumerId)
      entry.consumer.close()
      setRemotePeers((prev) =>
        prev.map((p) =>
          p.id === entry.peerId ? { ...p, tracks: { ...p.tracks, [entry.key]: null } } : p,
        ),
      )
    }

    //  приём потоков

    function closeRecvTransport() {
      refs.recvTransport?.close()
      refs.recvTransport = null
      refs.recvTransportPromise = null
    }

    async function ensureRecvTransport() {
      // два newProducer подряд не должны создать два транспорта
      if (!refs.recvTransportPromise) {
        refs.recvTransportPromise = (async () => {
          const transport = refs.device.createRecvTransport(
            await refs.signaling.request('createWebRtcTransport', { direction: 'recv' }),
            { iceServers: refs.iceServers },
          )
          transport.on('connect', ({ dtlsParameters }, callback, errback) => {
            refs.signaling
              .request('connectWebRtcTransport', { transportId: transport.id, dtlsParameters })
              .then(callback)
              .catch(errback)
          })
          refs.recvTransport = transport
          return transport
        })()
        refs.recvTransportPromise.catch(() => {
          refs.recvTransportPromise = null // неудача — следующая попытка создаст заново
        })
      }
      return refs.recvTransportPromise
    }

    async function consumeProducer({ producerId }) {
      const transport = await ensureRecvTransport()
      const data = await refs.signaling.request('consume', {
        transportId: transport.id,
        producerId,
        rtpCapabilities: refs.device.rtpCapabilities,
      })

      // сервер создал consumer на паузе — локальный тоже, иначе потеряем первые кадры
      const consumer = await transport.consume({
        id: data.id,
        producerId: data.producerId,
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: { source: data.source },
      })

      const key = `${data.source}:${data.kind}` // webcam:audio | webcam:video | screen:video
      refs.consumers.set(consumer.id, { consumer, peerId: data.peerId, key })
      consumer.on('transportclose', () => removeConsumerTrack(consumer.id))

      // если источник уже на паузе — трек в UI не показываем, consumer не резюмим
      const track = data.producerPaused ? null : consumer.track
      setRemotePeers((prev) =>
        prev.map((p) =>
          p.id === data.peerId ? { ...p, tracks: { ...p.tracks, [key]: track } } : p,
        ),
      )
      if (!data.producerPaused) {
        await refs.signaling.request('resumeConsumer', { consumerId: consumer.id })
      }
    }

    function requestConsume(producerId) {
      if (triedProducerIds.has(producerId)) return
      triedProducerIds.add(producerId)
      if (!refs.device) {
        pendingProducerIds.add(producerId) // Device ещё не готов — отложим
        return
      }
      consumeProducer({ producerId }).catch((e) => {
        console.error('[consume] не удалось начать приём:', e.message)
        triedProducerIds.delete(producerId) // разрешаем повторную попытку
      })
    }

    // кто-то замьютился / включил камеру — обновляем треки в UI
    function setProducerPaused({ producerId }, paused) {
      for (const entry of refs.consumers.values()) {
        if (entry.consumer.producerId !== producerId) continue
        const track = paused ? null : entry.consumer.track
        setRemotePeers((prev) =>
          prev.map((p) =>
            p.id === entry.peerId ? { ...p, tracks: { ...p.tracks, [entry.key]: track } } : p,
          ),
        )
        if (!paused) {
          // consumer мог быть создан на паузе (источник был выключен) — резюмим
          refs.signaling
            .request('resumeConsumer', { consumerId: entry.consumer.id })
            .catch(() => {})
        }
      }
    }

    // уведомления сервера

    function handleNotification(notification, data) {
      switch (notification) {
        case 'newPeer':
          addPeer(data.peerId, data.displayName)
          break
        case 'peerClosed':
          removePeer(data.peerId)
          break
        case 'newProducer':
          consumeProducer({ producerId: data.producerId }).catch((e) =>
            console.error('[consume] не удалось начать приём:', e.message),
          )
          break
        case 'producerClosed':
          requestConsume(data.producerId)
          break
        case 'producerPaused':
          setProducerPaused(data, true)
          break
        case 'producerResumed':
          setProducerPaused(data, false)
          break
        case 'consumerClosed':
          removeConsumerTrack(data.consumerId)
          break
      }
    }

    // Вход в комнату: join → Device → транспорты → публикация → приём.
    // Вызывается и при первом входе, и после каждого переподключения —
    // поэтому всё идемпотентно: старые транспорты/consumers закрываются,
    // а повторный join на том же соединении сервер считает ретраем.
    async function joinAndPublish(seq) {
      // 1) вход
      const joined = await refs.signaling.request('join', { displayName: session.displayName })
      if (disposed || seq !== joinSeq) return
      refs.iceServers = joined.iceServers ?? []
      setRemotePeers(
        joined.peers.map((p) => ({ id: p.id, displayName: p.displayName, tracks: {} })),
      )

      // 2) Device с capabilities роутера — грузится один раз, возможности комнаты не меняются
      if (!refs.device) {
        const device = new Device()
        await device.load({ routerRtpCapabilities: joined.rtpCapabilities })
        if (disposed || seq !== joinSeq) return
        refs.device = device
      }

      // 3) сбрасываем всё от прошлой сессии (первый вход это тоже спокойно переживает)
      refs.sendTransport?.close()
      refs.sendTransport = null
      closeRecvTransport()
      for (const { consumer } of refs.consumers.values()) consumer.close()
      refs.consumers.clear()
      refs.producers.clear()
      triedProducerIds.clear()
      pendingProducerIds.clear()

      // 4) send-транспорт: параметры с сервера, события — протокол
      const sendTransport = refs.device.createSendTransport(
        await refs.signaling.request('createWebRtcTransport', { direction: 'send' }),
        { iceServers: refs.iceServers },
      )
      if (disposed || seq !== joinSeq) return
      sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        refs.signaling
          .request('connectWebRtcTransport', { transportId: sendTransport.id, dtlsParameters })
          .then(callback)
          .catch(errback)
      })
      sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        refs.signaling
          .request('produce', {
            transportId: sendTransport.id,
            kind,
            rtpParameters,
            source: appData?.source,
          })
          .then(({ id }) => callback({ id }))
          .catch(errback)
      })
      refs.sendTransport = sendTransport

      // 5) публикация локальных дорожек (живые треки переживают обрыв сети)
      const publishes = []
      const audioTrack = refs.activeTracks.audio
      const videoTrack = refs.activeTracks.video
      if (audioTrack) {
        audioTrack.enabled = audioEnabledRef.current
        publishes.push(
          sendTransport.produce({ track: audioTrack, appData: { source: 'webcam' } })
            .then((p) => watchProducer(p, 'webcam:audio')),
        )
      }
      if (videoTrack) {
        videoTrack.enabled = videoEnabledRef.current
        publishes.push(
          sendTransport.produce({ track: videoTrack, appData: { source: 'webcam' } })
            .then((p) => watchProducer(p, 'webcam:video')),
        )
      }
      await Promise.all(publishes)
      if (disposed || seq !== joinSeq) return

      // выключенные у участника дорожки сразу подаём как paused
      const pauses = []
      if (audioTrack && !audioEnabledRef.current) {
        pauses.push(refs.signaling.request('pauseProducer', {
          producerId: refs.producers.get('webcam:audio')?.id,
        }))
      }
      if (videoTrack && !videoEnabledRef.current) {
        pauses.push(refs.signaling.request('pauseProducer', {
          producerId: refs.producers.get('webcam:video')?.id,
        }))
      }
      await Promise.all(pauses)

      joinAttempt = 0
      setPhase('joined')

      // 6) потоки тех, кто уже в комнате
      for (const peer of joined.peers) {
        for (const producer of peer.producers ?? []) {
          requestConsume(producer.producerId)
        }
      }
      // и те, что успели появиться, пока грузился Device
      for (const producerId of [...pendingProducerIds]) {
        pendingProducerIds.delete(producerId)
        requestConsume(producerId)
      }
    }

    async function runJoin() {
      const seq = ++joinSeq
      clearTimeout(joinRetryTimer)
      if (refs.signaling?.terminal) return
      try {
        await joinAndPublish(seq)
      } catch (e) {
        if (disposed || seq !== joinSeq || refs.signaling?.terminal) return
        if (e.code && ERROR_TEXT[e.code]) {
          // комната исчезла/закрыта/переполнена — ретраями не лечится
          refs.signaling?.close()
          setPhase('error')
          setError(ERROR_TEXT[e.code])
          return
        }
        // сеть ещё не поднялась или транзиентный сбой (например, Firefox
        // отказывается создавать RTCPeerConnection, пока считает себя offline)
        // — просто пробуем снова с нарастающей задержкой
        console.warn('[room] вход не удался, повторим:', e.message)
        joinAttempt += 1
        const delay = Math.min(JOIN_RETRY_BASE_MS * 2 ** (joinAttempt - 1), JOIN_RETRY_MAX_MS)
          * (0.75 + Math.random() * 0.5)
        joinRetryTimer = setTimeout(runJoin, delay)
      }
    }

    // подключение: SignalingClient сам переживает обрывы сети,
    // каждый (пере)подъём соединения заново запускает вход в комнату
    const signaling = new SignalingClient({
      roomId: session.roomId,
      peerId,
      onNotification: handleNotification,
      onOpen: () => {
        if (!disposed) runJoin()
      },
      onStatusChange: (status) => {
        if (disposed) return
        if (status === 'reconnecting') setPhase('reconnecting')
      },
      onReplaced: () => {
        if (disposed) return
        setPhase('error')
        setError('Встреча открыта в другой вкладке — подключение перенесено туда')
      },
    })
    refs.signaling = signaling

    // cleanup — выполняется при размонтировании (в т.ч. при выходе из комнаты)
    return () => {
      disposed = true
      clearTimeout(joinRetryTimer)
      refs.signaling?.close()
      refs.sendTransport?.close()
      closeRecvTransport()
      for (const { consumer } of refs.consumers.values()) consumer.close()
      refs.consumers.clear()
      for (const track of refs.extraLocalTracks) track.stop()
      refs.extraLocalTracks.clear()
      refs.producers.clear()
      refs.signaling = null
      refs.device = null
      refs.sendTransport = null
    }
  }, [session, watchProducer])

  return {
    phase, error, remotePeers,
    audioEnabled, videoEnabled, localVideoTrack,
    toggleAudio, toggleVideo,
  }
}
