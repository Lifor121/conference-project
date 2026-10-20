module.exports = {
  httpPort: parseInt(process.env.HTTP_PORT || '4443', 10),
  listenIp: process.env.LISTEN_IP || '0.0.0.0',
  backendUrl: process.env.BACKEND_URL || 'http://backend:8000',

  app: {
    maxPeersPerRoom: parseInt(process.env.MAX_PEERS_PER_ROOM || '50', 10),
    // пустая комната живёт ещё 15с
    roomCloseDelayMs: parseInt(process.env.ROOM_CLOSE_DELAY_MS || '15000', 10),

    // app-level ping: браузерный WebSocket не отдаёт protocol-ping'и наверх,
    // поэтому сервер дублирует их видимым сообщением — по его тишине клиент
    // понимает, что соединение мертво (half-open TCP), и не ждёт onclose
    pingIntervalMs: parseInt(process.env.SIGNALING_PING_INTERVAL_MS || '5000', 10),

    // здоровье медиа: как часто опрашивать score producers и после скольких
    // «мёртвых» тиков подряд (интервалов) слать участнику mediaStalled
    mediaHealthIntervalMs: parseInt(process.env.MEDIA_HEALTH_INTERVAL_MS || '5000', 10),
    mediaStalledTicks: parseInt(process.env.MEDIA_STALLED_TICKS || '2', 10),

    // сколько времени после НЕнамеренного обрыва signaling-сокета (сеть
    // умерла — close 1006/4001; намеренный выход кодом 1000 убирает
    // участника сразу, без grace) сервер хранит сессию (транспорты,
    // producers, consumers): даём шанс вернуться тем же peerId с нового
    // соединения (смена сети) и оживить медиа ICE-рестартом. 30с с запасом
    // перекрывают возврат wifi на телефоне (переассоциация радиомодуля
    // после обрыва мобильной сети занимает 10–30с). Не вернулся —
    // обычный peerClosed остальным
    peerDetachGraceMs: parseInt(process.env.PEER_DETACH_GRACE_MS || '30000', 10),

    // через сколько молчания участника (обрыв signaling, медиа замерло)
    // сообщать ОСТАЛЬНЫМ peerDetached — его плитка показывает
    // «переподключается…» вместо замершего кадра. Короче 5с не нужно:
    // обычный resume при смене сети укладывается в 1–3с и не должен
    // мигать бейджем
    peerDetachNotifyMs: parseInt(process.env.PEER_DETACH_NOTIFY_MS || '5000', 10),

    // время жизни TURN-кредов, выпускаемых при join (REST API coturn).
    // 6 часов с запасом перекрывают любую встречу; при re-join выпускаются заново
    turnCredTtlSec: parseInt(process.env.TURN_CRED_TTL_SEC || '21600', 10),
  },

  mediasoup: {
    worker: {
      rtcMinPort: parseInt(process.env.MEDIASOUP_RTC_MIN_PORT || '40000', 10),
      rtcMaxPort: parseInt(process.env.MEDIASOUP_RTC_MAX_PORT || '40100', 10),
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    },

    webRtcTransport: {
      listenIps: [
        {
          ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
          announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
        },
      ],
      enableUdp: true,
      enableTcp: false,
      preferUdp: true,
    },
  },
};
