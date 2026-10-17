// Тест переподключения (takeover) без браузера: «телефон переключил сеть».
// Запуск: docker compose exec media node tools/test-reconnect.js <roomId>
// (комнату создать заранее — см. test-signaling.js)
//
// Сценарий: Alice входит → её соединение «умирает» (на самом деле живо,
// но сервер об этом не знает) → Alice входит с нового сокета с тем же peerId.
// Ожидаем: старый сокет закрыт кодом 4000, наблюдатель получил peerClosed
// и newPeer с тем же peerId, дубля участника нет.

const { WebSocket } = require('ws');

const BASE = 'ws://localhost:4443/ws';

function connect(roomId, peerId) {
  return new Promise((resolve, reject) => {
    let url = `${BASE}?roomId=${roomId}`;
    if (peerId) url += `&peerId=${peerId}`;
    const ws = new WebSocket(url);
    const notifications = [];
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
          notifications.push({ notification: msg.notification, data: msg.data ?? {} });
        }
      });

      resolve({
        ws,
        notifications,
        closed: new Promise((res) => ws.once('close', (code, reason) => res({ code, reason: reason.toString() }))),
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
const fail = (label, extra = '') => {
  console.log(`   ❌ ${label}${extra ? ' — ' + extra : ''}`);
  process.exitCode = 1;
};

// ждём, пока накопится count уведомлений name
function waitNotifications(client, name, count, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`нет ${count} уведомлений ${name}`)), timeoutMs);
    const iv = setInterval(() => {
      const found = client.notifications.filter((n) => n.notification === name);
      if (found.length >= count) {
        clearTimeout(timer);
        clearInterval(iv);
        resolve(found);
      }
    }, 50);
  });
}

(async () => {
  const roomId = process.argv[2];
  if (!roomId) {
    console.error('Использование: node tools/test-reconnect.js <roomId>');
    process.exit(1);
  }

  console.log('1. наблюдатель входит в комнату');
  const observer = await connect(roomId, 'test-observer-peer');
  await observer.request('join', { displayName: 'Observer' });
  ok('join наблюдателя');

  console.log('2. Alice входит (peerId=test-alice-peer)');
  const alice = await connect(roomId, 'test-alice-peer');
  const joinedA = await alice.request('join', { displayName: 'Alice' });
  ok('join Alice', `других участников в ответе: ${joinedA.peers.length}`);
  const [newPeer1] = await waitNotifications(observer, 'newPeer', 1);
  newPeer1.data.peerId === 'test-alice-peer' && newPeer1.data.displayName === 'Alice'
    ? ok('наблюдатель получил newPeer Alice')
    : fail('наблюдатель получил newPeer Alice', JSON.stringify(newPeer1.data));

  console.log('3. повторный join на том же соединении — идемпотентный ретрай');
  const again = await alice.request('join', { displayName: 'Alice' });
  ok('повторный join', `других участников в ответе: ${again.peers.length}`);
  const newPeersOnly1 = (await waitNotifications(observer, 'newPeer', 1)).length === 1;
  newPeersOnly1 ? ok('дубль newPeer не разослан') : fail('дубль newPeer не разослан');

  console.log('4. Alice «переподключилась»: новый сокет, тот же peerId (takeover)');
  const alice2 = await connect(roomId, 'test-alice-peer');
  const joinedB = await alice2.request('join', { displayName: 'Alice' });
  ok('join новой сессии Alice', `других участников в ответе: ${joinedB.peers.length}`);

  const closeInfo = await alice.closed;
  closeInfo.code === 4000
    ? ok('старый сокет закрыт кодом 4000', `reason="${closeInfo.reason}"`)
    : fail('старый сокет закрыт кодом 4000', `код ${closeInfo.code}, reason="${closeInfo.reason}"`);

  const [peerClosed] = await waitNotifications(observer, 'peerClosed', 1);
  peerClosed.data.peerId === 'test-alice-peer'
    ? ok('наблюдатель получил peerClosed старой сессии')
    : fail('peerClosed старой сессии', JSON.stringify(peerClosed.data));

  const newPeers = await waitNotifications(observer, 'newPeer', 2);
  const newPeer2 = newPeers[1];
  newPeer2.data.peerId === 'test-alice-peer' && newPeer2.data.displayName === 'Alice'
    ? ok('наблюдатель получил newPeer той же Alice (без дубля участника)')
    : fail('newPeer той же Alice', JSON.stringify(newPeer2.data));

  console.log('5. клиент без peerId (старая версия клиента) — работает');
  const legacy = await connect(roomId);
  await legacy.request('join', { displayName: 'Legacy' });
  const newPeers3 = await waitNotifications(observer, 'newPeer', 3);
  /^[0-9a-f-]{36}$/.test(newPeers3[2].data.peerId)
    ? ok('сервер сгенерировал peerId сам', newPeers3[2].data.peerId)
    : fail('сервер сгенерировал peerId сам', newPeers3[2].data.peerId);

  console.log('6. битый peerId в query — отказ');
  const bad = await connect(roomId, 'x');
  await bad.closed;
  bad.notifications.some((n) => n.notification === 'error' && /peerId/i.test(n.data.message ?? ''))
    ? ok('отказ с notification error: Invalid peerId')
    : fail('отказ с notification error: Invalid peerId', JSON.stringify(bad.notifications));

  // 7-10 — транспортные кейсы: в песочнице (run-media-fake.js) фейковые
  // транспорты принимают любые параметры; в Docker с настоящим mediasoup
  // пустые rtpParameters не пройдут валидацию — кейсы мягко пропускаются.
  // Таймауты щедрые: под прод-интервалы (5с) mediaStalled приходит ~10-11с
  console.log('7. сервер пингует открытые соединения (app-level ping)');
  const bob = await connect(roomId, 'test-bob-peer');
  await bob.request('join', { displayName: 'Bob' });
  try {
    await waitNotifications(bob, 'ping', 2, 15000);
    ok('ping-и приходят регулярно');
  } catch {
    fail('ping-и приходят регулярно');
  }

  console.log('8. restartIce: транспорт получает свежие iceParameters');
  let transport = null;
  try {
    transport = await bob.request('createWebRtcTransport', { direction: 'send' });
    const before = transport.iceParameters.usernameFragment;
    const restarted = await bob.request('restartIce', { transportId: transport.id });
    typeof restarted.iceParameters?.usernameFragment === 'string' &&
    restarted.iceParameters.usernameFragment !== before
      ? ok('iceParameters обновлены', `${before} → ${restarted.iceParameters.usernameFragment}`)
      : fail('iceParameters обновлены', JSON.stringify(restarted.iceParameters));
  } catch (e) {
    console.log(`   ⏭  пропущено (нужен фейк-режим песочницы): ${e.message}`);
  }

  if (transport) {
    console.log('9. mediaStalled: producer молчит (score 0) → сервер сообщает владельцу');
    let producerId = null;
    try {
      const prod = await bob.request('produce', {
        transportId: transport.id,
        kind: 'video',
        rtpParameters: {
          codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
          headerExtensions: [],
        },
        source: 'webcam',
      });
      producerId = prod.id;
    } catch (e) {
      console.log(`   ⏭  пропущено (нужен фейк-режим песочницы): ${e.message}`);
    }
    if (producerId) {
      try {
        const [stalled] = await waitNotifications(bob, 'mediaStalled', 1, 15000);
        const info = stalled.data.producers?.[0];
        info && info.producerId === producerId && info.kind === 'video'
          ? ok('mediaStalled получен, данные producer корректны')
          : fail('mediaStalled получен', JSON.stringify(stalled.data));
      } catch {
        fail('mediaStalled получен');
      }

      console.log('10. paused producer не считается мёртвым — mediaStalled прекращаются');
      await bob.request('pauseProducer', { producerId });
      await new Promise((r) => setTimeout(r, 1200));
      const stalledCount = bob.notifications.filter((n) => n.notification === 'mediaStalled').length;
      stalledCount === 1
        ? ok('после pause новых mediaStalled нет')
        : fail('после pause новых mediaStalled нет', `уведомлений: ${stalledCount}`);
    }
  }

  observer.ws.close();
  alice2.ws.close();
  legacy.ws.close();
  bob.ws.close();
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
})().catch((e) => {
  console.error('❌ неожиданная ошибка:', e.message);
  process.exit(1);
});
