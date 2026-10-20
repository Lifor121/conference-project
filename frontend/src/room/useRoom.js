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

// produce() висит, пока не завершится ICE/DTLS — при мёртвой сети это
// «навсегда», и весь авто-реконнект бы встал. Даём щедрый, но конечный срок
const PRODUCE_TIMEOUT_MS = 15000

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: превышено время ожидания (${ms / 1000}с)`)),
      ms,
    )
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

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
  const phaseRef = useRef('connecting')
  const setPhaseSafe = (p) => { phaseRef.current = p; setPhase(p) }
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
    // сколько раз подряд после обрыва восстанавливались «дёшево» (ICE restart
    // выживших транспортов): если не помогает — пора в полную пересборку
    resumeAttempts: 0,
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
          const p = await withTimeout(
            refs.sendTransport.produce({ track, appData: { source: 'webcam' } }),
            PRODUCE_TIMEOUT_MS,
            'публикация аудио',
          )
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
          const p = await withTimeout(
            refs.sendTransport.produce({ track, appData: { source: 'webcam' } }),
            PRODUCE_TIMEOUT_MS,
            'публикация видео',
          )
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
          : [...prev, { id: peerId_, displayName, tracks: {}, detached: false }],
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
          watchTransport(transport, 'recv')
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

    // --- восстановление медиа без выхода из комнаты ---

    // Полный re-join по живому signaling-соединению: join идемпотентен,
    // транспорты пересоздаются (сервер сам закрывает старые того же
    // направления), consumers будут получены заново. Троттлим, чтобы
    // серверные mediaStalled и клиентские ICE-фэйлы не устроили шторм
    let lastFullRecoveryAt = 0
    function scheduleFullRecovery(reason) {
      if (disposed) return
      const now = Date.now()
      if (now - lastFullRecoveryAt < 10000) return
      lastFullRecoveryAt = now
      console.warn('[room] восстановление полным re-join:', reason)
      runJoin()
    }

    // Транспорт отвалился (смена сети на телефоне — классика): сперва
    // пробуем ICE restart — дёшево, тот же транспорт, у остальных участников
    // ничего не мигает. Не помогло — полный re-join
    function watchTransport(transport, label) {
      if (typeof transport.restartIce !== 'function') return // старый mediasoup-client
      let recoverTimer = 0
      let recovering = false

      async function recover() {
        if (recovering || transport.closed) return
        recovering = true
        try {
          console.warn(`[transport ${label}] связь потеряна — ICE restart`)
          const { iceParameters } = await refs.signaling.request('restartIce', {
            transportId: transport.id,
          })
          if (transport.closed) return
          await transport.restartIce({ iceParameters })
          // ждём восстановления связи; не дождались — re-join
          const healed = await new Promise((resolve) => {
            const isHealthy = (state = transport.connectionState) =>
              state === 'connected' || state === 'completed'
            if (isHealthy()) { resolve(true); return }
            const done = (v) => {
              clearTimeout(timer)
              transport.off('connectionstatechange', onChange)
              resolve(v)
            }
            const timer = setTimeout(() => done(false), 10000)
            function onChange(state) { if (isHealthy(state)) done(true) }
            transport.on('connectionstatechange', onChange)
          })
          if (!transport.closed && !healed) {
            scheduleFullRecovery(`транспорт ${label} не ожил после ICE restart`)
          }
        } catch (e) {
          if (!transport.closed) {
            scheduleFullRecovery(`ICE restart транспорта ${label} не удался: ${e.message}`)
          }
        } finally {
          recovering = false
        }
      }

      transport.on('connectionstatechange', (state) => {
        if (transport.closed) return
        if (state === 'connected' || state === 'completed') {
          refs.resumeAttempts = 0 // медиа пошло — ICE-рестарты сработали
          clearTimeout(recoverTimer)
          recoverTimer = 0
        } else if (state === 'failed') {
          clearTimeout(recoverTimer)
          recoverTimer = 0
          recover()
        } else if (state === 'disconnected' && !recoverTimer && !recovering) {
          // короткие сбои случаются и без смены сети — даём 5с на самооздоровление
          recoverTimer = setTimeout(() => { recoverTimer = 0; recover() }, 5000)
        }
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
        case 'peerDetached':
          // участник потерял связь (смена сети) и ещё не вернулся — его
          // плитка показывает «переподключается…», а не замерший кадр
          setRemotePeers((prev) =>
            prev.map((p) => (p.id === data.peerId ? { ...p, detached: true } : p)),
          )
          break
        case 'peerResumed':
          // вернулся на новом соединении — снимаем бейдж, медиа оживает
          setRemotePeers((prev) =>
            prev.map((p) => (p.id === data.peerId ? { ...p, detached: false } : p)),
          )
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
        case 'mediaStalled':
          // сервер не получает наше медиа (сеть сменилась под нами),
          // а signaling жив — пересобираем транспорты, не выходя из комнаты
          scheduleFullRecovery('сервер не получает наше медиа')
          break
      }
    }

    // ресинк после восстановления: пока мы были оффлайн, состав участников
    // и их producers менялся, а уведомления о событиях потерялись вместе с
    // мёртвым сокетом. Живые тайлы не сбрасываем — убираем только то, чего
    // больше нет, добавляем недостающее
    function reconcilePeers(incoming) {
      const liveProducers = new Map()
      for (const p of incoming) {
        for (const prod of p.producers ?? []) liveProducers.set(prod.producerId, prod)
      }

      // consumer'ы, чей producer исчез, пока нас не было
      for (const [id, entry] of [...refs.consumers]) {
        if (!liveProducers.has(entry.consumer.producerId)) removeConsumerTrack(id)
      }

      setRemotePeers((prev) => {
        const byId = new Map(incoming.map((p) => [p.id, p]))
        // живые тайлы не сбрасываем; статус detached подтягиваем с сервера
        const kept = prev
          .filter((p) => byId.has(p.id))
          .map((p) => ({ ...p, detached: Boolean(byId.get(p.id).detached) }))
        const keptIds = new Set(kept.map((p) => p.id))
        for (const p of incoming) {
          if (!keptIds.has(p.id)) {
            kept.push({ id: p.id, displayName: p.displayName, tracks: {}, detached: Boolean(p.detached) })
          }
        }
        return kept
      })

      for (const prod of liveProducers.values()) {
        requestConsume(prod.producerId)
        // рассинк пауз (источник замьютился, пока мы были оффлайн)
        const entry = [...refs.consumers.values()].find(
          (c) => c.consumer.producerId === prod.producerId,
        )
        if (entry) setProducerPaused({ producerId: prod.producerId }, prod.paused)
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

      // сервер узнал нас и сохранил сессию (обрыв signaling при смене сети,
      // вернулись тем же peerId): НЕ пересобираем — оживляем ICE выживших
      // транспортов и ресинкаем участников. Это в разы дешевле: без нового
      // DTLS, без re-publish/re-consume, без мигания плиток у остальных
      if (joined.resumed) {
        const serverIds = new Set((joined.transports ?? []).map((t) => t.id))
        const survivors = [refs.sendTransport, refs.recvTransport].filter(
          (t) => t && !t.closed && serverIds.has(t.id) && typeof t.restartIce === 'function',
        )
        if (survivors.length && refs.resumeAttempts < 2) {
          refs.resumeAttempts += 1
          console.warn(`[room] resume: ICE restart ${survivors.length} выживших транспортов`)
          await Promise.all(survivors.map(async (t) => {
            const { iceParameters } = await refs.signaling.request('restartIce', { transportId: t.id })
            if (disposed || seq !== joinSeq || t.closed) return
            await t.restartIce({ iceParameters })
          }))
          if (disposed || seq !== joinSeq) return
          reconcilePeers(joined.peers)
          joinAttempt = 0
          setPhaseSafe('joined')
          return
        }
        // выживших нет (перезагрузка вкладки) либо дешёвые рестарты не
        // помогают — полная пересборка ниже
      }

      setRemotePeers(
        joined.peers.map((p) => ({
          id: p.id,
          displayName: p.displayName,
          tracks: {},
          detached: Boolean(p.detached),
        })),
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
      watchTransport(sendTransport, 'send')

      // 5) публикация локальных дорожек (живые треки переживают обрыв сети)
      const publishes = []
      const audioTrack = refs.activeTracks.audio
      const videoTrack = refs.activeTracks.video
      if (audioTrack) {
        audioTrack.enabled = audioEnabledRef.current
        publishes.push(
          withTimeout(
            sendTransport.produce({ track: audioTrack, appData: { source: 'webcam' } }),
            PRODUCE_TIMEOUT_MS,
            'публикация аудио',
          ).then((p) => watchProducer(p, 'webcam:audio')),
        )
      }
      if (videoTrack) {
        videoTrack.enabled = videoEnabledRef.current
        publishes.push(
          withTimeout(
            sendTransport.produce({ track: videoTrack, appData: { source: 'webcam' } }),
            PRODUCE_TIMEOUT_MS,
            'публикация видео',
          ).then((p) => watchProducer(p, 'webcam:video')),
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
      refs.resumeAttempts = 0
      setPhaseSafe('joined')

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
      // восстановление на живом соединении (mediaStalled, ICE restart) —
      // показываем оверлей, чтобы пользователь видел, что что-то происходит
      if (phaseRef.current === 'joined') setPhaseSafe('reconnecting')
      try {
        await joinAndPublish(seq)
      } catch (e) {
        if (disposed || seq !== joinSeq || refs.signaling?.terminal) return
        if (e.code && ERROR_TEXT[e.code]) {
          // комната исчезла/закрыта/переполнена — ретраями не лечится
          refs.signaling?.close()
          setPhaseSafe('error')
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
        if (status === 'reconnecting') setPhaseSafe('reconnecting')
      },
      onReplaced: () => {
        if (disposed) return
        setPhaseSafe('error')
        setError('Встреча открыта в другой вкладке — подключение перенесено туда')
      },
    })
    refs.signaling = signaling

    // уход со страницы (закрытие вкладки, внешний переход): честно говорим
    // серверу, что уходим навсегда — он уберёт нас из комнаты сразу, а не
    // будет держать плитку-призрак весь grace-период. Перезагрузку (F5)
    // отличаем заранее через Navigation API (Chrome/Edge/Android): после
    // неё возвращаемся тем же peerId через пару секунд и сервер продолжает
    // сессию. Где Navigation API нет — считаем, что вернёмся (безопаснее)
    let pageReloading = false
    try {
      window.navigation?.addEventListener?.('navigate', (e) => {
        if (e?.navigationType === 'reload') pageReloading = true
      })
    } catch {
      // нет Navigation API — любое закрытие считаем «может вернёмся»
    }
    const onPageHide = (event) => {
      if (disposed) return
      // persisted — ушли в bfcache, страница ещё может вернуться как есть
      if (event.persisted || pageReloading) return
      refs.signaling?.close() // leave-запрос + close(1000)
    }
    window.addEventListener('pagehide', onPageHide)

    // cleanup — выполняется при размонтировании (в т.ч. при выходе из комнаты)
    return () => {
      disposed = true
      clearTimeout(joinRetryTimer)
      window.removeEventListener('pagehide', onPageHide)
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
