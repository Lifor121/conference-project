const express = require('express');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const config = require('./config');

const app = express();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'media-server' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  console.log('[ws] connected:', req.socket.remoteAddress);
  socket.send(JSON.stringify({ notification: 'welcome', data: { message: 'signaling works' } }));

  socket.on('message', (raw) => {
    // Полноценный протокол будет потом
    try {
      console.log('[ws] message:', JSON.parse(raw.toString()));
    } catch {
      /* игнорируем битый JSON */
    }
  });

  socket.on('close', () => console.log('[ws] closed'));
});

server.listen(config.httpPort, config.listenIp, () => {
  console.log(`[media-server] signaling on ${config.listenIp}:${config.httpPort}`);
});
