const config = require('./config');
const { getOrCreateRoom } = require('./rooms');
const { validateRoomForJoin } = require('./backend');
const { workerPool } = require('./workers');

// все хендлеры: (peer, roomId, data) => data для ответа.
// ошибка = throw Error, уйдёт клиенту как {ok: false, error}

function peerInfo(peer) {
  return { id: peer.id, displayName: peer.displayName };
}

function assertJoined(peer) {
  if (!peer.joined) throw new Error('Not joined');
}

// join

async function join(peer, roomId, data) {
  if (peer.joined) throw new Error('Already joined');

  const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (!displayName || displayName.length > 64) throw new Error('Invalid displayName');

  // 1) комната существует и открыта? — решает backend
  await validateRoomForJoin(roomId);

  // 2) поднимаем Room в этом процессе (роутер создаётся при первом участнике)
  const room = await getOrCreateRoom(roomId, workerPool);
  if (room.isFull()) throw new Error('Room is full');

  // 3) входим
  peer.displayName = displayName;
  peer.joined = true;
  room.addPeer(peer);

  // 4) сообщаем остальным и отдаём новичку список участников
  for (const other of room.peers.values()) {
    if (other.id !== peer.id) {
      other.send('newPeer', { peerId: peer.id, displayName });
    }
  }

  return {
    rtpCapabilities: room.rtpCapabilities,
    peers: [...room.peers.values()].filter((p) => p.id !== peer.id).map(peerInfo),
  };
}

// WebRTC-транспорты

async function createWebRtcTransport(peer, _roomId, data) {
  assertJoined(peer);

  const { direction } = data;
  if (direction !== 'send' && direction !== 'recv') {
    throw new Error("direction must be 'send' or 'recv'");
  }

  // переподключение
  for (const [id, t] of peer.transports) {
    if (t.appData.direction === direction) {
      peer.transports.delete(id);
      t.close();
    }
  }

  const options = {
    listenIps: config.mediasoup.webRtcTransport.listenIps,
    enableUdp: config.mediasoup.webRtcTransport.enableUdp,
    enableTcp: config.mediasoup.webRtcTransport.enableTcp,
    preferUdp: config.mediasoup.webRtcTransport.preferUdp,
    appData: { direction },
  };
  // стартовый лимит исходящего битрейта важен для recv (поток сервер → клиент)
  if (direction === 'recv') options.initialAvailableOutgoingBitrate = 1_000_000;

  const transport = await peer.room.router.createWebRtcTransport(options);
  peer.transports.set(transport.id, transport);

  transport.on('icestatechange', (state) => {
    console.log(`[transport ${direction} ${transport.id.slice(0, 8)}] ice: ${state}`);
  });
  transport.on('dtlsstatechange', (state) => {
    if (state === 'failed' || state === 'closed') {
      console.log(`[transport ${direction} ${transport.id.slice(0, 8)}] dtls: ${state}`);
    }
  });

  return {
    id: transport.id,
    direction,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

async function connectWebRtcTransport(peer, _roomId, data) {
  assertJoined(peer);
  const transport = peer.transports.get(data.transportId);
  if (!transport) throw new Error('Transport not found');
  await transport.connect({ dtlsParameters: data.dtlsParameters });
  return {};
}

const handlers = {
  join,
  createWebRtcTransport,
  connectWebRtcTransport,
};

module.exports = { handlers };
