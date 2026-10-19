const express = require('express');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { workerPool } = require('./workers');
const { roomStats, checkAllRoomsMediaHealth } = require('./rooms');
const { Peer } = require('./Peer');
const { handlers } = require('./handlers');

const app = express();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'media-server' });
});

app.get('/stats', (_req, res) => {
  res.json({ workers: workerPool.size, rooms: roomStats() });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

// heartbeat: браузеры отвечают на protocol-level ping автоматически.
// Нет ответа два цикла подряд — соединение мертво:
// terminate -> 'close' -> removePeer
const HEARTBEAT_MS = 10000;

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, HEARTBEAT_MS);

// app-level ping: protocol-ping из heartbeat браузер видит, но не отдаёт
// странице — поэтому дублируем его обычным сообщением. Если клиент не видит
// ping'и N интервалов подряд, соединение half-open и его надо пересоздавать
const appPing = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify({ notification: 'ping', data: {} }));
    }
  }
}, config.app.pingIntervalMs);

// здоровье медиа: score producers всех комнат → mediaStalled «замолчавшим»
const mediaHealth = setInterval(checkAllRoomsMediaHealth, config.app.mediaHealthIntervalMs);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(appPing);
  clearInterval(mediaHealth);
});

wss.on('connection', (socket, req) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('roomId');
  const peerId = url.searchParams.get('peerId');

  if (!roomId) {
    socket.send(JSON.stringify({ notification: 'error', data: { message: 'roomId query param is required' } }));
    socket.close();
    return;
  }

  // стабильный id вкладки: по нему опознаём вернувшегося участника.
  // отсутствует только у старых клиентов — тогда id сгенерируем сами
  if (peerId && !/^[A-Za-z0-9_-]{8,64}$/.test(peerId)) {
    socket.send(JSON.stringify({ notification: 'error', data: { message: 'Invalid peerId' } }));
    socket.close();
    return;
  }

  const peer = new Peer({ socket, id: peerId });
  console.log(`[ws] connect peer=${peer.id.slice(0, 8)} room=${roomId}`);

  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // битый JSON игнорируем
    }
    if (typeof msg?.method !== 'string') return;

    const handler = handlers[msg.method];
    if (!handler) {
      socket.send(JSON.stringify({ id: msg.id ?? null, ok: false, error: `Unknown method: ${msg.method}` }));
      return;
    }

    try {
      const data = await handler(peer, roomId, msg.data ?? {});
      socket.send(JSON.stringify({ id: msg.id ?? null, ok: true, data: data ?? {} }));
    } catch (err) {
      console.error(`[ws] ${msg.method} error (peer=${peer.id.slice(0, 8)}): ${err.message}`);
      socket.send(JSON.stringify({ id: msg.id ?? null, ok: false, error: err.message, code: err.code ?? null }));
    }
  });

  socket.on('close', () => {
    console.log(`[ws] disconnect peer=${peer.id.slice(0, 8)}`);
    if (peer.room) {
      try {
        // сессия не сносится сразу: grace-период на возвращение тем же
        // peerId (смена сети) — см. Room.onPeerSocketClose
        peer.room.onPeerSocketClose(peer);
      } catch (err) {
        console.error(`[ws] cleanup error: ${err.message}`);
      }
    }
  });

  socket.on('error', (err) => console.error(`[ws] socket error peer=${peer.id.slice(0, 8)}: ${err.message}`));
});

const start = async () => {
  await workerPool.start();
  server.listen(config.httpPort, config.listenIp, () => {
    console.log(`[media-server] signaling on ${config.listenIp}:${config.httpPort}`);
  });
};

start().catch((err) => {
  console.error('[media-server] startup failed:', err);
  process.exit(1);
});
