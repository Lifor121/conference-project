const crypto = require('node:crypto');

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
      paused: p.paused,
    })),
  }
}

function assertJoined(peer) {
  if (!peer.joined) throw new Error('Not joined');
}

// ICE-серверы клиента: STUN + TURN. coturn работает в режиме REST API
// (--static-auth-secret): статические логин/пароль он НЕ принимает —
// пароль должен быть HMAC от имени. Поэтому креды выпускаем на лету:
// username = "expiry:peerId" (expiry — unix-секунды),
// credential = base64(hmac-sha1(secret, username)) — так их ждёт coturn.
// Секрет один и тот же у coturn (--static-auth-secret) и здесь.
function turnIceServers(peer) {
  const servers = [];
  if (process.env.STUN_URL) servers.push({ urls: process.env.STUN_URL });

  const turnUrl = process.env.TURN_URL;
  const secret = process.env.TURN_STATIC_AUTH_SECRET || process.env.TURN_CREDENTIAL;
  if (turnUrl && secret) {
    const expiry = Math.floor(Date.now() / 1000) + config.app.turnCredTtlSec;
    const username = `${expiry}:${peer?.id ?? 'anonymous'}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    servers.push({ urls: turnUrl, username, credential });
  }
  return servers;
}

// join

async function join(peer, roomId, data) {
  const displayName = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (!displayName || displayName.length > 64) throw new Error('Invalid displayName');

  // повторный join на том же соединении — идемпотентный ретрай:
  // клиент мог упасть посреди подключения (сеть мигнула) и начать заново
  if (peer.joined) {
    return {
      rtpCapabilities: peer.room.rtpCapabilities,
      peers: [...peer.room.peers.values()].filter((p) => p.id !== peer.id).map(peerInfo),
      iceServers: turnIceServers(peer),
    };
  }

  // 1) комната существует и открыта? — решает backend
  await validateRoomForJoin(roomId);

  // 2) поднимаем Room в этом процессе (роутер создаётся при первом участнике)
  const room = await getOrCreateRoom(roomId, workerPool);

  // 3) этот участник уже в комнате со старым (умершим) соединением?
  //    Заменяем: остальные получат peerClosed + newPeer, старый сокет — close 4000
  room.replaceSameIdPeer(peer);

  // 4) лимит проверяем после takeover — призрак не должен занимать место
  if (room.isFull()) {
    const err = new Error('Room is full');
    err.code = 'room_full';
    throw err;
  }

  // 5) входим
  peer.displayName = displayName;
  peer.joined = true;
  room.addPeer(peer);

  // 6) сообщаем остальным и отдаём новичку список участников
  for (const other of room.peers.values()) {
    if (other.id !== peer.id) {
      other.send('newPeer', { peerId: peer.id, displayName });
    }
  }

  return {
    rtpCapabilities: room.rtpCapabilities,
    peers: [...room.peers.values()].filter((p) => p.id !== peer.id).map(peerInfo),
    iceServers: turnIceServers(peer),
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

// ICE restart: клиент заметил, что транспорт отвалился (смена сети на
// телефоне — классика), и хочет поднять ICE заново на новых кандидатах,
// не пересоздавая транспорт. Возвращаем свежие iceParameters — их клиент
// передаёт в transport.restartIce() на своей стороне
async function restartIce(peer, _roomId, data) {
  assertJoined(peer);
  const transport = peer.transports.get(data.transportId);
  if (!transport) throw new Error('Transport not found');
  await transport.restartIce();
  console.log(`[transport ${transport.appData.direction} ${transport.id.slice(0, 8)}] ICE restart по запросу клиента`);
  return { iceParameters: transport.iceParameters };
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
    producerPaused: producer.paused,
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

// пауза/возобновление своих producers (mute, камера)

function notifyProducerState(peer, producer, notification) {
  for (const other of peer.room.peers.values()) {
    if (other.id !== peer.id) {
      other.send(notification, { peerId: peer.id, producerId: producer.id });
    }
  }
}

async function pauseProducer(peer, _roomId, data) {
  assertJoined(peer);
  const producer = peer.producers.get(data.producerId);
  if (!producer) throw new Error('Producer not found');
  await producer.pause();
  notifyProducerState(peer, producer, 'producerPaused');
  console.log(`[producer] ${peer.displayName}: pause ${producer.appData.source}/${producer.kind}`);
  return {};
}

async function resumeProducer(peer, _roomId, data) {
  assertJoined(peer);
  const producer = peer.producers.get(data.producerId);
  if (!producer) throw new Error('Producer not found');
  await producer.resume();
  notifyProducerState(peer, producer, 'producerResumed');
  console.log(`[producer] ${peer.displayName}: resume ${producer.appData.source}/${producer.kind}`);
  return {};
}

const handlers = {
  join,
  createWebRtcTransport,
  connectWebRtcTransport,
  restartIce,
  produce,
  consume,
  resumeConsumer,
  pauseProducer,
  resumeProducer,
};

module.exports = { handlers };
