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
