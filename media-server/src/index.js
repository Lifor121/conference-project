const express = require('express');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { workerPool } = require('./workers');
const { roomStats } = require('./rooms');

const app = express();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'media-server' });
});

app.get('/stats', (_req, res) => {
  res.json({ workers: workerPool.size, rooms: roomStats() });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  console.log('[ws] connected:', req.socket.remoteAddress);
  socket.on('close', () => console.log('[ws] closed'));
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
