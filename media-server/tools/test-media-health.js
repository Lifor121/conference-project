// Юнит-тест Room.checkMediaHealth без запущенного сервера и mediasoup:
// подсовываем Peer'ам фейковых producers и вручную тикаем сканер.
//
// Запуск: node tools/test-media-health.js
process.env.MEDIA_STALLED_TICKS = '2';

const { EventEmitter } = require('node:events');
const { Room } = require('../src/Room');
const { Peer } = require('../src/Peer');

const fail = (label, extra = '') => {
  console.log(`   ❌ ${label}${extra ? ' — ' + extra : ''}`);
  process.exitCode = 1;
};
const ok = (label, extra = '') => console.log(`   ✅ ${label}${extra ? ' — ' + extra : ''}`);

function makePeer(id, producers) {
  const peer = new Peer({ socket: null, id });
  // фейковый ws-сокет: пишем всё в массив и отдаём наружу
  peer.socket = {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
  };
  peer.room = { peers: new Map() };
  peer.joined = true;
  peer.displayName = id;
  for (const p of producers) peer.producers.set(p.id, p);
  return peer;
}

function makeProducer({ paused = false, score = [] } = {}) {
  const producer = new EventEmitter();
  producer.id = `prod-${Math.random().toString(36).slice(2, 8)}`;
  producer.kind = 'video';
  producer.appData = { source: 'webcam' };
  producer.paused = paused;
  producer.score = score;
  producer.closed = false;
  return producer;
}

const room = new Room({ roomId: 'r-health', worker: {}, maxPeers: 10 });
const stalledOf = (peer) =>
  peer.socket.sent.filter((m) => m.notification === 'mediaStalled');

(async () => {
  console.log('1. мёртвое медиа: score пустой — mediaStalled на 2-м тике, затем периодично');
  const dead = makePeer('dead-peer', [makeProducer()]);
  room.peers.set(dead.id, dead);
  room.checkMediaHealth();
  stalledOf(dead).length === 0 ? ok('первый тик — молчим') : fail('первый тик — молчим');
  room.checkMediaHealth();
  const [note] = stalledOf(dead);
  note && note.data.producers.length === 1 && note.data.producers[0].kind === 'video'
    ? ok('второй тик — mediaStalled с данными producers')
    : fail('второй тик — mediaStalled', JSON.stringify(stalledOf(dead)));
  room.checkMediaHealth();
  stalledOf(dead).length === 1 ? ok('счётчик сброшен: подряд не спамим') : fail('счётчик сброшен: подряд не спамим');
  room.checkMediaHealth();
  stalledOf(dead).length === 2 ? ok('периодические напоминания продолжаются') : fail('периодические напоминания', `уведомлений: ${stalledOf(dead).length}`);

  console.log('2. живой producer (score > 0) — участник здоров');
  const alive = makePeer('alive-peer', [makeProducer({ score: [{ ssrc: 1, score: 7 }] })]);
  room.peers.set(alive.id, alive);
  room.checkMediaHealth();
  room.checkMediaHealth();
  room.checkMediaHealth();
  stalledOf(alive).length === 0 ? ok('ни одного mediaStalled') : fail('ни одного mediaStalled');

  console.log('3. один из producers жив — participant считается здоровым');
  const mixed = makePeer('mixed-peer', [
    makeProducer(), // мёртвое видео
    makeProducer({ score: [{ ssrc: 2, score: 3 }] }), // живое аудио
  ]);
  mixed.producers.values().next().value.kind = 'video';
  room.peers.set(mixed.id, mixed);
  for (let i = 0; i < 4; i++) room.checkMediaHealth();
  stalledOf(mixed).length === 0 ? ok('ни одного mediaStalled') : fail('ни одного mediaStalled');

  console.log('4. paused producers не считаются мёртвыми');
  const muted = makePeer('muted-peer', [makeProducer({ paused: true })]);
  room.peers.set(muted.id, muted);
  for (let i = 0; i < 4; i++) room.checkMediaHealth();
  stalledOf(muted).length === 0 ? ok('ни одного mediaStalled') : fail('ни одного mediaStalled');

  console.log('5. участник без producers пропускается');
  const watcher = makePeer('watcher-peer', []);
  room.peers.set(watcher.id, watcher);
  for (let i = 0; i < 3; i++) room.checkMediaHealth();
  stalledOf(watcher).length === 0 ? ok('ни одного mediaStalled') : fail('ни одного mediaStalled');

  console.log('6. оживление: score стал положительным — счётчик сбрасывается');
  const revived = makePeer('revived-peer', [makeProducer()]);
  room.peers.set(revived.id, revived);
  room.checkMediaHealth(); // тик 1
  revived.producers.values().next().value.score = [{ ssrc: 1, score: 9 }];
  room.checkMediaHealth(); // оживил — счётчик сбросился
  room.checkMediaHealth(); // тик 1 заново
  stalledOf(revived).length === 0 ? ok('сброс счётчика после оживления') : fail('сброс счётчика после оживления');

  console.log('7. закрытая комната не сканируется');
  room.close();
  const before = stalledOf(dead).length;
  room.checkMediaHealth();
  stalledOf(dead).length === before ? ok('после close — тишина') : fail('после close — тишина');

  console.log('');
  if (process.exitCode) {
    console.log('Есть ошибки ❌');
    process.exit(1);
  }
  console.log('Все проверки media health прошли ✅');
})().catch((e) => {
  console.error('❌ неожиданная ошибка:', e);
  process.exit(1);
});
