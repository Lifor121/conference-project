module.exports = {
  httpPort: parseInt(process.env.HTTP_PORT || '4443', 10),
  listenIp: process.env.LISTEN_IP || '0.0.0.0',
  backendUrl: process.env.BACKEND_URL || 'http://backend:8000',

  app: {
    maxPeersPerRoom: parseInt(process.env.MAX_PEERS_PER_ROOM || '50', 10),
    // пустая комната живёт ещё 15с
    roomCloseDelayMs: parseInt(process.env.ROOM_CLOSE_DELAY_MS || '15000', 10),
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
