module.exports = {
  httpPort: parseInt(process.env.HTTP_PORT || '4443', 10),
  listenIp: process.env.LISTEN_IP || '0.0.0.0',
  backendUrl: process.env.BACKEND_URL || 'http://backend:8000',

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
      enableTcp: true,
      preferUdp: true,
    },
  },
};
