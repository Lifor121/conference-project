// WebSocket-клиент signaling-протокола (docs/PROTOCOL.md).
// request() -> Promise; уведомления сервера -> onNotification.

export class SignalingClient {
  constructor({ roomId, onNotification, onClosed }) {
    this.onNotification = onNotification
    this.onClosed = onClosed
    this.nextId = 1
    this.pending = new Map()
    this.closedByUs = false

    // относительный путь: в dev проксирует Vite, в прод — nginx
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    this.ws = new WebSocket(`${proto}://${location.host}/ws?roomId=${encodeURIComponent(roomId)}`)

    this.openPromise = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve()
      this.ws.onerror = () => reject(new Error('Не удалось подключиться к серверу'))
    })

    this.ws.onmessage = (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.ok
          ? resolve(msg.data)
          : reject(Object.assign(new Error(msg.error), { code: msg.code ?? null }))
      } else if (msg.notification) {
        this.onNotification?.(msg.notification, msg.data ?? {})
      }
    }

    this.ws.onclose = () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error('Соединение с сервером потеряно'))
      }
      this.pending.clear()
      if (!this.closedByUs) this.onClosed?.()
    }

    this._onOffline = () => this.ws.close()
    window.addEventListener('offline', this._onOffline)
  }

  async request(method, data = {}) {
    await this.openPromise
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, data }))
    })
  }

  close() {
    this.closedByUs = true
    window.removeEventListener('offline', this._onOffline)
    this.ws.close()
  }
}
