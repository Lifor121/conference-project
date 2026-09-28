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

  // mediasoup-объекты — в ref: их изменения не должны вызывать рендеры
  const r = useRef({
    signaling: null,
    device: null,
    sendTransport: null,
    recvTransport: null,
    recvTransportPromise: null,
    consumers: new Map(), // consumerId -> { consumer, peerId, key }
  })

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

      setRemotePeers((prev) =>
        prev.map((p) =>
          p.id === data.peerId ? { ...p, tracks: { ...p.tracks, [key]: consumer.track } } : p,
        ),
      )

      // track готов к воспроизведению — снимаем паузу на сервере и локально
      await refs.signaling.request('resumeConsumer', { consumerId: consumer.id })
      //await consumer.resume()
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
          refs.recvTransport?.close()
          refs.recvTransport = null
          setPhase('error')
          setError('Соединение с комнатой потеряно')
        },
      })
      refs.signaling = signaling

      // 1) вход
      const joined = await signaling.request('join', { displayName: session.displayName })
      if (disposed) return
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
      refs.signaling = null
      refs.device = null
      refs.sendTransport = null
    }
  }, [session])

  return { phase, error, remotePeers }
}
