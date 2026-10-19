const crypto = require('node:crypto');

class Peer {
  // id можно передать с клиента (peerId из query): он стабилен на вкладку,
  // и по нему сервер опознаёт вернувшегося участника вместо создания дубля
  constructor({ socket, id }) {
    this.id = id ?? crypto.randomUUID();
    this.socket = socket;
    this.room = null;        // Room, ставится при join
    this.displayName = null; // ставится при join
    this.joined = false;
    this.transports = new Map(); // transportId -> WebRtcTransport
    this.producers = new Map();  // producerId  -> Producer
    this.consumers = new Map();  // consumerId  -> Consumer
    this.closed = false;
    // signaling-сокет умер, но медиа-сессия (транспорты, потоки) живёт ещё
    // peerDetachGraceMs — ждём возвращения участника (см. Room.onPeerSocketClose)
    this.detached = false;
    this.detachTimer = null;
    // сессия передана новому Peer (тот же peerId вернулся с нового сокета):
    // этот объект больше не представляет участника, его хендлеры ничего
    // не должны трогать (см. Room.adoptSameIdPeer)
    this.superseded = false;
    // сколько проверок здоровья подряд все активные producers молчали
    // (score 0 = RTP от участника не приходит) — см. Room.checkMediaHealth
    this.mediaStalledTicks = 0;
  }

  send(notification, data) {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify({ notification, data }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.detachTimer);
    this.detachTimer = null;
    this.detached = false;
    // joined/room сбрасываем: после close обработчики сокета и signaling
    // не должны ни чистить этого пира повторно, ни принимать его запросы
    this.joined = false;
    this.room = null;
    // закрытие транспорта закрывает и все producers/consumers на нём
    for (const transport of this.transports.values()) transport.close();
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
  }
}

module.exports = { Peer };
