// WebSocket-клиент signaling-протокола (docs/PROTOCOL.md).
//
// Сам переподключается при обрыве: экспоненциальная задержка + мгновенная
// попытка по событию online. Останавливается только если соединение закрыли
// мы (close) или сервер кодом 4000 "replaced" — вход с того же peerId
// из другой вкладки.
//
// Дополнительно переживает полумёртвые соединения, которые браузер сам
// не замечает:
//  - watchdog тишины: сервер шлёт notification 'ping' каждые несколько
//    секунд; если сообщений нет дольше pingSilenceMs — соединение
//    half-open, пересоздаём его, не дожидаясь onclose (его может не быть);
//  - смена типа сети (wifi <-> мобильный интернет): navigator.connection
//    даёт событие мгновенно (type — на Android/ChromeOS, effectiveType —
//    и на десктопе), тогда как offline/online при таком переключении может
//    вообще не прийти — форсируем переподключение сразу. Ложная тревога
//    дёшева: сервер узнаёт вернувшегося peerId и возобновляет сессию;
//  - offline: рвём сокет немедленно и не создаём новый, пока браузер
//    считает сеть отсутствующей;
//  - проба сети: в цикле переподключения раз в секунду стучимся лёгким
//    HTTP-запросом на тот же origin. Сеть часто оживает БЕЗ события online
//    (смена wifi <-> мобильный на Firefox/iOS, «недоготовность» новой сети
//    после online) — тогда пришлось бы досиживать остаток backoff-таймера.
//    Любой HTTP-ответ значит «до сервера проходим» — подключаемся сразу.
//    Пока соединение «открыто», но молчит дольше fastSilenceMs, та же проба
//    отличает «сеть пропала» (ждём) от «наш сокет мёртв» (чиним немедленно).
//
// Статусы (onStatusChange): 'connecting' | 'open' | 'reconnecting' | 'closed' | 'replaced'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 10000
const CLOSE_CODE_REPLACED = 4000

// проба сети: раз в секунду, пока ждём следующей попытки подключения;
// любой HTTP-ответ (даже 4xx/5xx) — путь до сервера жив
const NET_PROBE_INTERVAL_MS = 1000
const NET_PROBE_TIMEOUT_MS = 2500
// не срываем свежую попытку подключения ради пробы: между probe-запущенными
// подключениями держим паузу (не чаще раза в 1.5с)
const NET_PROBE_MIN_ATTEMPT_GAP_MS = 1500
// повторять быструю пробу «тишины при живой сети» чаще бессмысленно
const FAST_PROBE_RETRY_MS = 2000

// классы сетей, между переходами которых старое TCP/TLS-соединение
// почти наверняка мертво (и медиа-транспорты вместе с ним)
const NET_TYPES = new Set(['wifi', 'cellular', 'ethernet'])

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false
const netConnection = () =>
  typeof navigator !== 'undefined' ? navigator.connection ?? null : null

export class SignalingClient {
  constructor({
    roomId, peerId, onNotification, onOpen, onStatusChange, onReplaced,
    requestTimeoutMs = 10000,
    pingSilenceMs = 15000,
    // сервер пингует каждые 5с: 7с тишины = пропущен один пинг с запасом.
    // Дальше решает HTTP-проба: сеть жива — сокет half-open, чиним; мертва
    // — ждём полного watchdog-порога pingSilenceMs
    fastSilenceMs = 7000,
    probeNetwork,
  }) {
    this.roomId = roomId
    this.peerId = peerId
    this.onNotification = onNotification
    this.onOpen = onOpen
    this.onStatusChange = onStatusChange
    this.onReplaced = onReplaced
    this.requestTimeoutMs = requestTimeoutMs
    this.pingSilenceMs = pingSilenceMs
    this.fastSilenceMs = fastSilenceMs
    this._probeNetworkImpl = probeNetwork ?? this._defaultProbeNetwork.bind(this)

    this.probeTimer = 0        // цикл проб сети в состоянии reconnecting
    this._probeBusy = false    // параллельные пробы не нужны
    this._fastProbeAt = 0      // троттлинг быстрой пробы тишины
    this._lastConnectAt = 0    // чтобы проба не срывала свежий хендшейк

    this.nextId = 1
    this.pending = new Map()
    this.closedByUs = false
    this.status = 'connecting'
    this.everOpened = false
    this.attempt = 0
    this.retryTimer = 0
    this.ws = null
    this.ready = Promise.resolve()
    this._settle = null // { reject } текущего подключения — чтобы «подвешенные» ожидания не висели вечно
    this._lastMessageAt = Date.now() // живое соединение не молчит дольше pingSilenceMs

    // сеть пропала — рвём сокет сразу (не ждём, пока ОС заметит сама) и
    // уходим в цикл ретраев: при offline попытки упираются в guard в _connect
    // и перепроверяются раз в 3с; сеть вернулась — online подхватит мгновенно
    this._onOffline = () => {
      this._teardown('Сеть недоступна')
      if (!this.closedByUs && this.status !== 'replaced') this._scheduleReconnect()
    }
    this._onOnline = () => this.connectNow()
    window.addEventListener('offline', this._onOffline)
    window.addEventListener('online', this._onOnline)

    // wifi <-> мобильный интернет без полной потери сети: offline/online
    // может не прийти, а старое соединение уже мертво — начинаем заново.
    // type есть только на Android/ChromeOS, поэтому дополнительно следим за
    // effectiveType (грубый класс сети, доступен и на десктопе): при переходе
    // wifi <-> cellular он почти наверняка меняется
    const conn = netConnection()
    this._netType = conn?.type ?? null
    this._netEffType = conn?.effectiveType ?? null
    this._onNetChange = () => {
      const c = netConnection()
      const type = c?.type ?? null
      const effType = c?.effectiveType ?? null
      const prevType = this._netType
      const prevEffType = this._netEffType
      this._netType = type
      this._netEffType = effType
      if (this.closedByUs || this.status === 'replaced') return
      const typeSwitched = NET_TYPES.has(prevType) && NET_TYPES.has(type) && prevType !== type
      const effTypeSwitched = Boolean(prevEffType && effType && prevEffType !== effType)
      if (typeSwitched || effTypeSwitched) {
        this.forceReconnect()
      }
    }
    conn?.addEventListener?.('change', this._onNetChange)

    // watchdog: опрашиваем соединение чаще, чем ждём тишину
    this._watchdog = setInterval(
      () => this._checkSilence(),
      Math.min(1000, Math.max(50, Math.round(this.pingSilenceMs / 5))),
    )

    this._connect()
  }

  _setStatus(status) {
    if (this.status === status) return
    this.status = status
    if (status !== 'reconnecting') this._stopProbeLoop()
    this.onStatusChange?.(status)
  }

  // соединение завершено без перспективы переподключения?
  get terminal() {
    return this.closedByUs || this.status === 'replaced'
  }

  _connect() {
    // пока браузер считает, что сети нет, новые сокеты не открываем:
    // ждём online (или периодически перепроверяем — вдруг событие потерялось)
    if (isOffline()) {
      if (this.everOpened) this._setStatus('reconnecting')
      clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => this._connect(), 3000)
      return
    }

    // прошлый сокет больше не актуален (watchdog, смена сети, online пришёл
    // раньше закрытия старого) — его ожидающие запросы должны упасть, а не висеть;
    // this.ws обнуляем: события умирающего сокета игнорируются как устаревшие
    this._teardown('Соединение перезапущено')
    this._lastConnectAt = Date.now()

    // относительный путь: в dev проксирует Vite, в прод — nginx
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    let url = `${proto}://${location.host}/ws?roomId=${encodeURIComponent(this.roomId)}`
    if (this.peerId) url += `&peerId=${encodeURIComponent(this.peerId)}`

    const ws = new WebSocket(url)
    this.ws = ws
    this._lastMessageAt = Date.now()

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
      this.everOpened = true
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
      this._lastMessageAt = Date.now()
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.notification === 'ping') return // метка живого соединения, наверх не нужна
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

  // прибрать текущее соединение: ожидающие запросы падают сразу,
  // onclose старого сокета (который при мёртвой сети может не прийти
  // или прийти через минуты) игнорируется как устаревший
  _teardown(reason, { reconnect = true } = {}) {
    this._settle?.reject(new Error(reason))
    for (const { reject } of this.pending.values()) {
      reject(new Error(reason))
    }
    this.pending.clear()

    const ws = this.ws
    if (!ws) return
    if (reconnect) this.ws = null // события старого сокета больше не актуальны
    try {
      ws.close()
    } catch {
      // уже закрыт
    }
  }

  _checkSilence() {
    if (this.closedByUs || this.status === 'replaced' || !this.ws) return
    const silentFor = Date.now() - this._lastMessageAt
    if (silentFor < this.pingSilenceMs) {
      // тишина подозрительно долгая (fastSilenceMs), но до полного таймаута
      // ещё далеко: HTTP-проба различает «сеть пропала» и «наш сокет мёртв»
      if (this.status === 'open' && silentFor >= this.fastSilenceMs) {
        this._probeFast()
      }
      return
    }

    if (this.status === 'open') {
      // сервер обязан пинговать открытое соединение, но молчит: TCP жив
      // наполовину — onclose может не прийти вообще, пересоздаём сами
      this.forceReconnect()
      return
    }
    if (this.ws.readyState === WebSocket.CONNECTING) {
      // сокет завис в подключении (браузер не отдаёт ошибку): бросаем его
      // и начинаем новый цикл
      this._teardown('Подключение зависло')
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
    // пока ждём — раз в секунду спрашиваем у сети «ты уже ожила?»;
    // оживёт раньше таймера — подключимся не дожидаясь backoff
    this._startProbeLoop()
  }

  // ---------- проба сети ----------

  // лёгкий HTTP-запрос на тот же origin; важен сам факт ответа —
  // 4xx/5xx тоже значит, что маршрут до сервера работает
  async _defaultProbeNetwork() {
    if (typeof fetch !== 'function') return false
    const url = `${location.protocol}//${location.host}/?netprobe=${Date.now()}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), NET_PROBE_TIMEOUT_MS)
    try {
      await fetch(url, { cache: 'no-store', signal: ac.signal })
      return true
    } catch {
      return false // сетевая ошибка/таймаут — сети нет (или она ещё не готова)
    } finally {
      clearTimeout(timer)
    }
  }

  async _probeOnce() {
    if (this._probeBusy) return false
    this._probeBusy = true
    try {
      return Boolean(await this._probeNetworkImpl())
    } catch {
      return false
    } finally {
      this._probeBusy = false
    }
  }

  _startProbeLoop() {
    if (this.probeTimer || this.terminal) return
    this.probeTimer = setInterval(() => { this._probeTick() }, NET_PROBE_INTERVAL_MS)
  }

  _stopProbeLoop() {
    clearInterval(this.probeTimer)
    this.probeTimer = 0
  }

  async _probeTick() {
    // подключились (или терминальный статус) — проба больше не нужна
    if (this.terminal || this.status !== 'reconnecting') {
      this._stopProbeLoop()
      return
    }
    if (!(await this._probeOnce())) return
    // сеть ожила, пока мы досиживали backoff — подключаемся немедленно.
    // Свежую попытку (ей меньше NET_PROBE_MIN_ATTEMPT_GAP_MS) не срываем:
    // может, это как раз она и прорвётся
    if (this.terminal || this.status !== 'reconnecting') return
    if (Date.now() - this._lastConnectAt < NET_PROBE_MIN_ATTEMPT_GAP_MS) return
    this.connectNow()
  }

  // «тишина при живой сети»: сокет выглядит открытым, но сервер молчит
  // дольше fastSilenceMs (сервер пингует каждые 5с — столько молчать он
  // не может). Если HTTP-проба проходит — сокет half-open, пересоздаём
  // не дожидаясь полного watchdog-таймаута pingSilenceMs
  _probeFast() {
    const now = Date.now()
    if (now - this._fastProbeAt < FAST_PROBE_RETRY_MS) return
    this._fastProbeAt = now
    this._probeOnce().then((up) => {
      if (!up) return
      if (this.terminal || this.status !== 'open') return
      // за время пробы само ожило — не трогаем
      if (Date.now() - this._lastMessageAt < this.fastSilenceMs) return
      this.forceReconnect()
    })
  }

  // внешняя команда «пробуй сейчас» (событие online)
  connectNow() {
    if (this.closedByUs || this.status === 'open' || this.status === 'replaced') return
    this.attempt = 0
    clearTimeout(this.retryTimer)
    this._connect()
  }

  // безусловное немедленное переподключение (смена типа сети): старое
  // соединение может выглядеть живым, но после смены сети оно мертво
  forceReconnect() {
    if (this.closedByUs || this.status === 'replaced') return
    this.attempt = 0
    clearTimeout(this.retryTimer)
    this._connect()
  }

  async request(method, data = {}) {
    await this.ready
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('Соединение не открыто')
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        // ответ потерялся вместе с сетью — не ждём вечно (join повис бы
        // и вместе с ним весь авто-реконнект)
        this.pending.delete(id)
        reject(new Error(`Превышено время ожидания ответа: ${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, data }))
    })
  }

  close() {
    if (this.closedByUs) return
    this.closedByUs = true
    clearInterval(this._watchdog)
    clearTimeout(this.retryTimer)
    this._stopProbeLoop()
    window.removeEventListener('online', this._onOnline)
    window.removeEventListener('offline', this._onOffline)
    netConnection()?.removeEventListener?.('change', this._onNetChange)
    this._teardown('Соединение закрыто', { reconnect: false })
  }
}
