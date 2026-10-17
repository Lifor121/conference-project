// Тест signaling-протокола без браузера.
// Запуск: docker compose exec media node tools/test-signaling.js <roomId>
// Комнату создать заранее:
//
// ROOM_ID=$(curl -s -X POST localhost:8000/api/rooms \
//   -H 'Content-Type: application/json' \
//   -d '{"name":"signaling test"}' | jq -r .id)
//
// docker compose exec media node tools/test-signaling.js $ROOM_ID
//
// Посмотреть комнату (автоудаление через 15 секунд):
//
// curl -s localhost:4443/stats | jq


const { WebSocket } = require('ws');

const BASE = 'ws://localhost:4443/ws';

function connect(roomId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}?roomId=${roomId}`);
    ws.once('error', reject);
    ws.once('open', () => {
      let nextId = 1;
      const pending = new Map();

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve: res, reject: rej } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.ok ? res(msg.data) : rej(Object.assign(new Error(msg.error), { code: msg.code }));
        } else if (msg.notification) {
          console.log(`   [notification] ${msg.notification}`, JSON.stringify(msg.data));
        }
      });

      resolve({
        ws,
        request(method, data) {
          return new Promise((res, rej) => {
            const id = nextId++;
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, data }));
          });
        },
      });
    });
  });
}

const ok = (label, extra = '') => console.log(`   ✅ ${label}${extra ? ' — ' + extra : ''}`);

const expectFail = async (label, promise) => {
  try {
    await promise;
    console.log(`   ❌ ${label}: ошибки не было, а ожидалась`);
    process.exitCode = 1;
  } catch (e) {
    console.log(`   ✅ ${label}: ${e.message}`);
  }
};

(async () => {
  const realRoomId = process.argv[2];
  if (!realRoomId) {
    console.error('Использование: node tools/test-signaling.js <roomId>');
    process.exit(1);
  }

  console.log('1. join в несуществующую комнату — должен быть отказ');
  const bogus = await connect('00000000-0000-0000-0000-000000000000');
  await expectFail('join', bogus.request('join', { displayName: 'Bot' }));
  bogus.ws.close();

  console.log('2. join в реальную комнату');
  const client = await connect(realRoomId);
  const joined = await client.request('join', { displayName: 'Test Bot' });
  ok('join', `codecs: ${joined.rtpCapabilities.codecs.map((c) => c.mimeType).join(', ')}`);

  console.log('3. повторный join на том же соединении — идемпотентен (ретрай)');
  const again = await client.request('join', { displayName: 'Test Bot' });
  ok('duplicate join', `участников в ответе: ${again.peers.length}`);

  console.log('4. транспорты');
  const send = await client.request('createWebRtcTransport', { direction: 'send' });
  ok('send transport', `candidates: ${send.iceCandidates.map((c) => `${c.ip}:${c.port}/${c.protocol}`).join(', ')}`);
  const recv = await client.request('createWebRtcTransport', { direction: 'recv' });
  ok('recv transport');

  console.log('5. produce с битыми rtpParameters');
  await expectFail('produce', client.request('produce', { transportId: send.id, kind: 'audio', rtpParameters: {} }));

  console.log('6. consume несуществующего producer');
  await expectFail('consume', client.request('consume', {
    transportId: recv.id,
    producerId: 'no-such-producer',
    rtpCapabilities: { codecs: [], headerExtensions: [] },
  }));

  client.ws.close();

  setTimeout(() => process.exit(0), 500);
})().catch((e) => {
  console.error('❌ неожиданная ошибка:', e.message);
  process.exit(1);
});
