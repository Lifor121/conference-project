// WebSocket-клиент signaling-протокола (docs/PROTOCOL.md).
//
// Сам переподключается при обрыве: экспоненциальная задержка + мгновенная
// попытка по событию online. Останавливается только если соединение закрыли
// мы (close) или сервер кодом 4000 "replaced" — вход с того же peerId
// из другой вкладки.
//
// Статусы (onStatusChange): 'connecting' | 'open' | 'reconnecting' | 'closed' | 'replaced'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 10000
const CLOSE_CODE_REPLACED = 4000

export class SignalingClient {
  constructor({ roomId, peerId, onNotification, onOpen, onStatusChange, onReplaced }) {
    this.roomId = roomId
    this.peerId = peerId
    this.onNotification = onNotification
    this.onOpen = onOpen
    this.onStatusChange = onStatusChange
    this.onReplaced = onReplaced

    this.nextId = 1
    this.pending = new Map()
    this.closedByUs = false
    this.status = 'connecting'
    this.attempt = 0
    this.retryTimer = 0
    this.ws = null
    this.ready = Promise.resolve()
    this._settle = null // { reject } текущего подключения — чтобы «подвешенные» ожидания не висели вечно

    // сеть пропала — рвём сокет сразу, не ждём, пока ОС заметит сама;
    // сеть вернулась — переподключаемся немедленно, без догорания backoff
    this._onOffline = () => this.ws?.close()
    this._onOnline = () => this.connectNow()
    window.addEventListener('offline', this._onOffline)
    window.addEventListener('online', this._onOnline)

    this._connect()
  }

  _setStatus(status) {
    if (this.status === status) return
    this.status = status
    this.onStatusChange?.(status)
  }

  // соединение завершено без перспективы переподключения?
  get terminal() {
    return this.closedByUs || this.status === 'replaced'
  }

  _connect() {
    // прошлый сокет больше не актуален (например, online пришёл раньше,
    // чем закрылся старый) — его ожидающие запросы должны упасть, а не висеть
    this._settle?.reject(new Error('Соединение перезапущено'))

    // относительный путь: в dev проксирует Vite, в прод — nginx
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let url = `${proto}://${location.host}/ws?roomId=${encodeURIComponent(this.roomId)}`
    if (this.peerId) url += `&peerId=${encodeURIComponent(this.peerId)}`

    const ws = new WebSocket(url)
    this.ws = ws

    const settle = {}
    this.ready = new Promise((resolve, reject) => {
      settle.resolve = resolve
      settle.reject = reject
    })
    this.ready.catch(() => {}) // reject без ждущих не должен давать unhandled rejection
    this._settle = settle

    ws.onopen = () => {
      if (ws !== this.ws) return // событие устаревшего сокета
      this.attempt = 0
      this._setStatus('open')
      settle.resolve()
      this.onOpen?.()
    }

    ws.onerror = () => {
      if (ws !== this.ws) return
      settle.reject(new Error('Не удалось подключиться к серверу'))
    }

    ws.onmessage = (event) => {
      if (ws !== this.ws) return
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

    ws.onclose = (event) => {
      settle.reject(new Error('Соединение с сервером потеряно')) // no-op, если уже был open

      if (ws !== this.ws) return
      for (const { reject } of this.pending.values()) {
        reject(new Error('Соединение с сервером потеряно'))
      }
      this.pending.clear()

      if (this.closedByUs) {
        this._setStatus('closed')
        return
      }
      if (event.code === CLOSE_CODE_REPLACED) {
        // та же вкладка открыла комнату заново (дубликат вкладки) —
        // переподключаться нельзя, иначе две вкладки будут воевать за комнату
        this._setStatus('replaced')
        this.onReplaced?.()
        return
      }
      this._scheduleReconnect()
    }
  }

  _scheduleReconnect() {
    this._setStatus('reconnecting')
    clearTimeout(this.retryTimer)
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS)
    this.attempt += 1
    const jitter = delay * (0.75 + Math.random() * 0.5)
    this.retryTimer = setTimeout(() => this._connect(), jitter)
  }

  // внешняя команда «пробуй сейчас» (событие online)
  connectNow() {
    if (this.closedByUs || this.status === 'open' || this.status === 'replaced') return
    this.attempt = 0
    clearTimeout(this.retryTimer)
    this._connect()
  }

  async request(method, data = {}) {
    await this.ready
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('Соединение не открыто')
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, data }))
    })
  }

  close() {
    if (this.closedByUs) return
    this.closedByUs = true
    clearTimeout(this.retryTimer)
    window.removeEventListener('online', this._onOnline)
    window.removeEventListener('offline', this._onOffline)
    this._settle?.reject(new Error('Соединение закрыто'))
    try {
      this.ws?.close()
    } catch {
      // уже закрыт
    }
  }
}
