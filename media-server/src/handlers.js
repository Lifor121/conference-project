const config = require('./config');
const { getOrCreateRoom } = require('./rooms');
const { validateRoomForJoin } = require('./backend');
const { workerPool } = require('./workers');

// все хендлеры: (peer, roomId, data) => data для ответа.
// ошибка = throw Error, уйдёт клиенту как {ok: false, error}

function peerInfo(peer) {
  return {
    id: peer.id,
    displayName: peer.displayName,
    producers: [...peer.producers.values()].map((p) => ({
      producerId: p.id,
      kind: p.kind,
      source: p.appData.source,
    })),
  }
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

  console.log(
    `[transport ${direction}] ports: ${transport.iceCandidates.map((c) => `${c.port}/${c.protocol}`).join(', ')}`,
  );

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

//  публикация и приём потоков

function notifyProducerClosed(peer, producer) {
  for (const other of peer.room.peers.values()) {
    if (other.id !== peer.id) {
      other.send('producerClosed', { peerId: peer.id, producerId: producer.id });
    }
  }
}

async function produce(peer, _roomId, data) {
  assertJoined(peer);

  const transport = peer.transports.get(data.transportId);
  if (!transport) throw new Error('Transport not found');
  if (transport.appData.direction !== 'send') throw new Error('Not a send transport');
  if (data.kind !== 'audio' && data.kind !== 'video') throw new Error('Invalid kind');
  if (!data.rtpParameters) throw new Error('rtpParameters required');

  const source = data.source === 'screen' ? 'screen' : 'webcam';

  // повторная публикация того же источника (переключение камеры и т.п.):
  // старый producer закрываем, остальные получат producerClosed
  for (const [id, prod] of peer.producers) {
    if (prod.kind === data.kind && prod.appData.source === source) {
      peer.producers.delete(id);
      prod.close();
      notifyProducerClosed(peer, prod);
    }
  }

  const producer = await transport.produce({
    kind: data.kind,
    rtpParameters: data.rtpParameters,
    appData: { source },
  });
  peer.producers.set(producer.id, producer);

  producer.on('score', (score) =>
    console.log(`[score] producer ${data.kind}/${source}: ${JSON.stringify(score)}`),
  )

  producer.on('transportclose', () => peer.producers.delete(producer.id));

  for (const other of peer.room.peers.values()) {
    if (other.id !== peer.id) {
      other.send('newProducer', { peerId: peer.id, producerId: producer.id, kind: producer.kind, source });
    }
  }

  console.log(`[producer] ${peer.displayName}: ${data.kind}/${source} (${producer.id.slice(0, 8)})`);
  return { id: producer.id };
}

async function consume(peer, _roomId, data) {
  assertJoined(peer);

  const transport = peer.transports.get(data.transportId);
  if (!transport) throw new Error('Transport not found');
  if (transport.appData.direction !== 'recv') throw new Error('Not a recv transport');
  if (!data.rtpCapabilities) throw new Error('rtpCapabilities required');

  const found = peer.room.findProducer(data.producerId);
  if (!found) throw new Error('Producer not found');
  const [owner, producer] = found;
  if (owner.id === peer.id) throw new Error('Cannot consume own producer');

  // создаём consumer на паузе — клиент подготовит track и вызовет resumeConsumer
  const consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities: data.rtpCapabilities,
    paused: true,
  });
  peer.consumers.set(consumer.id, consumer);

  consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
  consumer.on('producerclose', () => {
    peer.consumers.delete(consumer.id);
    peer.send('consumerClosed', { consumerId: consumer.id });
  });
  consumer.on('score', (score) =>
    console.log(
      `[score] consumer ${producer.appData.source}/${consumer.kind} → ${peer.displayName}: ${JSON.stringify(score)}`,
    ),
  );

  console.log(`[consumer] ${owner.displayName} → ${peer.displayName}: ${producer.appData.source}/${consumer.kind}`);

  return {
    id: consumer.id,
    producerId: producer.id,
    peerId: owner.id,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    source: producer.appData.source,
  };
}

async function resumeConsumer(peer, _roomId, data) {
  assertJoined(peer);
  const consumer = peer.consumers.get(data.consumerId);
  if (!consumer) throw new Error('Consumer not found');
  console.log(
    `[resumeConsumer] ${peer.displayName}: ${data.consumerId.slice(0, 8)}, был на паузе: ${consumer.paused}`
  )
  await consumer.resume();
  return {};
}

const handlers = {
  join,
  createWebRtcTransport,
  connectWebRtcTransport,
  produce,
  consume,
  resumeConsumer,
};

module.exports = { handlers };
