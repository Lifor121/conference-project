const config = require('./config');
const { mediaCodecs } = require('./codecs');

class Room {
  constructor({ roomId, worker, maxPeers }) {
    this.id = roomId;
    this.worker = worker;
    this.maxPeers = maxPeers;
    this.router = null;
    this.peers = new Map(); // peerId -> Peer
    this.closed = false;
    this._closeTimer = null;
    this._routerPromise = null;
    this.onClosed = null; // колбэк реестра (rooms.js)
  }

  // роутер создаётся один раз; повторные вызовы ждут тот же промис
  async init() {
    if (!this._routerPromise) {
      this._routerPromise = this.worker
        .createRouter({ mediaCodecs })
        .then((router) => {
          this.router = router;
          console.log(`[room ${this.id}] router создан (worker pid=${this.worker.pid})`);
          return router;
        });
    }
    return this._routerPromise;
  }

  get rtpCapabilities() {
    if (!this.router) throw new Error('Router not ready');
    return this.router.rtpCapabilities;
  }

  isFull() {
    return this.peers.size >= this.maxPeers;
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer);
    peer.room = this;
    clearTimeout(this._closeTimer);
    console.log(`[room ${this.id}] +peer ${peer.displayName}, участников: ${this.peers.size}`);
  }

  // ищем producer по id среди всех участников
  findProducer(producerId) {
    for (const peer of this.peers.values()) {
      const producer = peer.producers.get(producerId);
      if (producer) return [peer, producer];
    }
    return null;
  }

  // участник вернулся с новым соединением (переключение сети, перезагрузка
  // вкладки): убираем его старую сессию, уведомив остальных, и рвём старый
  // сокет кодом 4000 ("replaced") — чтобы вкладки не воевали за комнату
  replaceSameIdPeer(peer) {
    const existing = this.peers.get(peer.id);
    if (!existing || existing === peer) return false;
    console.log(`[room ${this.id}] peer ${peer.displayName ?? peer.id.slice(0, 8)} переподключился — заменяем старую сессию`);
    this.removePeer(peer.id);
    existing.socket.close(4000, 'replaced');
    return true;
  }

  // Здоровье исходящего медиа участника. Вызывается интервалом из rooms.js.
  //
  // Сценарий: телефон переключил сеть — signaling-сокет выжил (или уже
  // восстановился), а старый send-транспорт умер: ICE consent истёк,
  // RTP больше не приходит, у остальных — замороженный кадр. Сам клиент
  // этого может не замечать. Сервер видит score=0 у всех активных
  // producers — сообщаем участнику mediaStalled, чтобы тот пересоздал
  // транспорты (или сделал ICE restart), не покидая комнату.
  checkMediaHealth() {
    if (this.closed) return;
    for (const peer of this.peers.values()) {
      if (!peer.joined || peer.closed) continue;

      // paused producers не шлют RTP по своей воле — не считаем их мёртвыми
      const active = [...peer.producers.values()].filter((p) => !p.paused && !p.closed);
      if (active.length === 0) {
        peer.mediaStalledTicks = 0;
        continue;
      }

      // score: [{ ssrc, score }]; 0 или пустой список — входящего RTP нет.
      // Достаточно одного живого producer, чтобы участник считался здоровым
      const anyAlive = active.some((p) => (p.score ?? []).some((s) => s.score > 0));
      if (anyAlive) {
        peer.mediaStalledTicks = 0;
        continue;
      }

      peer.mediaStalledTicks += 1;
      if (peer.mediaStalledTicks >= config.app.mediaStalledTicks) {
        // сбрасываем: следующая порция уведомлений — не раньше, чем через
        // ещё mediaStalledTicks интервалов (защита от спама)
        peer.mediaStalledTicks = 0;
        console.warn(
          `[room ${this.id}] у ${peer.displayName} не приходит исходящее медиа — mediaStalled`,
        );
        peer.send('mediaStalled', {
          producers: active.map((p) => ({ producerId: p.id, kind: p.kind, source: p.appData.source })),
        });
      }
    }
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    peer.close();
    for (const other of this.peers.values()) other.send('peerClosed', { peerId });
    console.log(`[room ${this.id}] -peer ${peer.displayName}, осталось: ${this.peers.size}`);
    if (this.peers.size === 0) this.scheduleClose();
  }

  scheduleClose() {
    clearTimeout(this._closeTimer);
    this._closeTimer = setTimeout(() => this.close(), config.app.roomCloseDelayMs);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._closeTimer);
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    if (this.router) this.router.close();
    console.log(`[room ${this.id}] закрыта`);
    this.onClosed?.();
  }
}

module.exports = { Room };
