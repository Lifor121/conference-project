import { useEffect, useRef, useState } from 'react'
import { Device } from 'mediasoup-client'
import { SignalingClient } from '../signaling/SignalingClient.js'

const ERROR_TEXT = {
  room_not_found: 'Встреча не найдена',
  room_closed: 'Встреча уже закрыта',
  room_full: 'Встреча заполнена',
}

// remotePeers: [{ id, displayName, tracks: { 'webcam:audio' | 'webcam:video' | 'screen:video': MediaStreamTrack } }]
export function useRoom({ session }) {
  const [phase, setPhase] = useState('connecting') // connecting | joined | error
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
    extraLocalTracks: new Set(), // треки, полученные уже внутри комнаты  })
  })

  // регистрируем producer + реакция на выдёргивание устройства
  function watchProducer(producer, key) {
    r.current.producers.set(key, producer)
    producer.on('trackended', () => {
      console.warn(`[producer] ${key}: трек закончился (устройство отключилось?)`)
      r.current.signaling
        ?.request('pauseProducer', { producerId: producer.id })
        .catch(() => {})
      if (key === 'webcam:audio') setAudioEnabled(false)
      if (key === 'webcam:video') setVideoEnabled(false)
    })
  }

  // --- контролы (вызываются из RoomView) ---

  async function toggleAudio() {
    const refs = r.current
    if (!refs.signaling) return
    const producer = refs.producers.get('webcam:audio')
    try {
      if (audioEnabledRef.current && producer) {
        await refs.signaling.request('pauseProducer', { producerId: producer.id })
        setAudioEnabled(false)
      } else if (producer) {
        await refs.signaling.request('resumeProducer', { producerId: producer.id })
        setAudioEnabled(true)
      } else {
        // микрофона при входе не было — получаем и публикуем сейчас
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: session.devices?.micId || undefined },
        })
        const track = stream.getAudioTracks()[0]
        if (!track) throw new Error('Микрофон не найден')
        try {
          const p = await refs.sendTransport.produce({ track, appData: { source: 'webcam' } })
          watchProducer(p, 'webcam:audio')
          refs.extraLocalTracks.add(track)
          setAudioEnabled(true)
        } catch (e) {
          track.stop() // публикация не удалась — камеру... микрофон не оставляем включённым
          throw e
        }
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
      if (videoEnabledRef.current && producer) {
        await refs.signaling.request('pauseProducer', { producerId: producer.id })
        setVideoEnabled(false)
      } else if (producer) {
        await refs.signaling.request('resumeProducer', { producerId: producer.id })
        setVideoEnabled(true)
      } else {
        // камеры при входе не было — получаем и публикуем сейчас
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: session.devices?.cameraId || undefined },
        })
        const track = stream.getVideoTracks()[0]
        if (!track) throw new Error('Камера не найдена')
        try {
          const p = await refs.sendTransport.produce({ track, appData: { source: 'webcam' } })
          watchProducer(p, 'webcam:video')
          refs.extraLocalTracks.add(track)
          setLocalVideoTrack(track)
          setVideoEnabled(true)
        } catch (e) {
          track.stop() // publish не удался — не оставляем камеру включённой
          throw e
        }
      }
    } catch (e) {
      console.error('[toggleVideo]', e.message)
    }
  }

  useEffect(() => {
    let disposed = false
    const refs = r.current

    // producers, о которых узнали до готовности Device — попробуем после
    const pendingProducerIds = new Set()
    const triedProducerIds = new Set() // защита от двойного consume одного producer

    // состояние списка участников

    function addPeer(peerId, displayName) {
      setRemotePeers((prev) =>
        prev.some((p) => p.id === peerId)
          ? prev
          : [...prev, { id: peerId, displayName, tracks: {} }],
      )
    }

    function removePeer(peerId) {
      for (const [id, entry] of [...refs.consumers]) {
        if (entry.peerId === peerId) removeConsumerTrack(id)
      }
      setRemotePeers((prev) => prev.filter((p) => p.id !== peerId))
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

    // подключение

    async function start() {
      const signaling = new SignalingClient({
        roomId: session.roomId,
        onNotification: handleNotification,
        onClosed: () => {
          if (disposed) return
          refs.sendTransport?.close()
          refs.sendTransport = null
          setPhase('error')
          setError('Соединение с комнатой потеряно')
        },
      })
      refs.signaling = signaling

      // 1) вход
      const joined = await signaling.request('join', { displayName: session.displayName })
      if (disposed) return
      refs.iceServers = joined.iceServers ?? []
      setRemotePeers(
        joined.peers.map((p) => ({ id: p.id, displayName: p.displayName, tracks: {} })),
      )

      // 2) Device с capabilities роутера
      const device = new Device()
      await device.load({ routerRtpCapabilities: joined.rtpCapabilities })
      if (disposed) return
      refs.device = device

      // 3) send-транспорт: параметры с сервера, события — протокол
      const sendTransport = device.createSendTransport(
        await signaling.request('createWebRtcTransport', { direction: 'send' }),
        { iceServers: refs.iceServers },
      )
      if (disposed) return
      sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        signaling
          .request('connectWebRtcTransport', { transportId: sendTransport.id, dtlsParameters })
          .then(callback)
          .catch(errback)
      })
      sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        signaling
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

      // 4) публикация своих дорожек
      const publishes = []
      const audioTrack = session.stream?.getAudioTracks()[0]
      const videoTrack = session.stream?.getVideoTracks()[0]
      if (audioTrack)
        publishes.push(sendTransport.produce({ track: audioTrack, appData: { source: 'webcam' } }))
      if (videoTrack)
        publishes.push(sendTransport.produce({ track: videoTrack, appData: { source: 'webcam' } }))
      await Promise.all(publishes)
      if (disposed) return

      setPhase('joined')

      // 5) потоки тех, кто уже в комнате
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

    start().catch((e) => {
      if (disposed) return
      setPhase('error')
      setError(ERROR_TEXT[e.code] ?? e.message)
    })

    // cleanup — выполняется при размонтировании (в т.ч. при выходе из комнаты)
    return () => {
      disposed = true
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
  }, [session])

  return {
    phase, error, remotePeers,
    audioEnabled, videoEnabled, localVideoTrack,
    toggleAudio, toggleVideo,
  }
}
