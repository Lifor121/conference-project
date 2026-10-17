# Signaling-протокол media-server

## Подключение

`ws(s)://<host>/ws?roomId=<uuid комнаты из backend>&peerId=<id вкладки>`

`peerId` — опциональный стабильный идентификатор клиента (uuid, живёт в sessionStorage
одну вкладку). По нему сервер опознаёт вернувшегося участника.

## Формат сообщений

```
Запрос C→S:   { "id": 1, "method": "join", "data": { ... } }
Ответ S→C:    { "id": 1, "ok": true, "data": { ... } }              
              { "id": 1, "ok": false, "error": "...", "code": "..." }
Уведомление:  { "notification": "newPeer", "data": { ... } }   — в обе стороны, без ответа
```

id генерирует клиентом (инкремент), сервер копирует его в ответ.Запросы можно слать параллельно, не дожидаясь ответов.

## Методы

| Метод                    | Запрос                                          | Ответ                                                             |
| ------------------------ | ----------------------------------------------- | ----------------------------------------------------------------- |
| join | { displayName } | { rtpCapabilities, peers: [{id, displayName, producers: [{producerId, kind, source}]}] } |
| createWebRtcTransport  | { direction: "send"\|"recv" }                 | { id, direction, iceParameters, iceCandidates, dtlsParameters } |
| connectWebRtcTransport | { transportId, dtlsParameters }               | {}                                                              |
| restartIce             | { transportId }                               | { iceParameters } — свежие параметры для transport.restartIce() |
| produce                | { transportId, kind, rtpParameters, source? } | { id } — id нового producer                                     |
| consume                | { transportId, producerId, rtpCapabilities }  | { id, producerId, peerId, kind, rtpParameters, source }         |
| resumeConsumer         | { consumerId }                                | {}                                                              |
| pauseProducer | { producerId } | {} |
| resumeProducer | { producerId } | {} |

Правила:

- до join все методы кроме join → Not joined
- повторный join **на том же соединении** идемпотентен: сервер просто возвращает
  текущее состояние комнаты (клиент так переживает ретраи после сбоя);
  join с другого соединения — это новый участник
- source в produce: "webcam" (default) | "screen"
- повторный createWebRtcTransport с тем же direction закрывает старый транспорт(используется при переподключении)
- consume создаёт consumer **на паузе**: клиент получил ответ → собрал track →вызвал resumeConsumer. Так не теряются первые RTP-пакеты.
- restartIce запускает ICE restart серверного транспорта (медисуп ≥3.13):
  клиент должен передать полученные iceParameters в свой transport.restartIce() —
  это штатный способ оживить транспорт после смены сети, не пересоздавая его

Ошибки join: room_not_found, room_closed, room_full (в поле code).

### Takeover: участник вернулся с тем же peerId

Если при join в комнате уже есть участник с таким peerId (старое соединение
умерло — например, телефон переключил сеть), сервер:

1. закрывает старую сессию: остальным уходит `peerClosed`, затем `newPeer`
   (тот же peerId), транспорты/producers/consumers старой сессии закрываются;
2. рвёт старый сокет **close-кодом 4000 ("replaced")** — такой клиент не должен
   переподключаться, иначе две вкладки будут воевать за комнату.

Лимит участников (room_full) проверяется после takeover — «призрак» не занимает место.

## Уведомления S→C

| notification     | data                                                          |
| ---------------- | ------------------------------------------------------------- |
| newPeer        | { peerId, displayName }                                     |
| peerClosed     | { peerId } — участник вышел, убрать все его треки           |
| newProducer    | { peerId, producerId, kind, source } — можно делать consume |
| producerClosed | { peerId, producerId } — источник выключен/заменён          |
| consumerClosed | { consumerId } — ваш consumer умер (источник пропал)        |
| producerPaused | { peerId, producerId } — источник на паузе (mute / камера выкл) |
| producerResumed | { peerId, producerId } — источник снова активен |
| ping           | {} — метка живого соединения (см. «Переподключение»), клиенту наверх не отдаётся |
| mediaStalled   | { producers: [{ producerId, kind, source }] } — сервер не получает ваше медиа |

## Переподключение

Клиент держит стабильный peerId (один на вкладку) и при обрыве:

1. сам переподключает WebSocket (экспоненциальная задержка, мгновенная попытка
   по событию `online`);
2. заново выполняет join с тем же peerId — сервер заменяет старую сессию
   (takeover), остальные участники получают `peerClosed` + `newPeer`;
3. пересоздаёт транспорты и producers, переиспользуя живые локальные треки
   (getUserMedia не зависит от сети).

Мёртвые соединения сервер ловит heartbeat-пингами каждые 10 с (terminate,
если два цикла подряд нет ответа; браузеры отвечают на ping автоматически) —
на случай, когда клиент не успел переподключиться, а сокет «завис».

### Смена сети без обрыва signaling (мобильный ↔ wifi)

Signaling-сокет может пережить смену сети, а вот медиа-транспорты — нет:
получится «частично живой» участник (входящее видит, исходящее у остальных
заморожено). Две защиты:

1. **Сервер**: раз в `MEDIA_HEALTH_INTERVAL_MS` (по умолчанию 5 с) проверяет
   score всех активных (не paused) producers участника. Если все нулевые
   `MEDIA_STALLED_TICKS` проверок подряд (по умолчанию 2) — участнику уходит
   `mediaStalled`. Клиент должен пересобрать транспорты: сперва дёшево —
   `restartIce` для проблемного транспорта, если не помогло — полный re-join
   по живому соединению (join идемпотентен, createWebRtcTransport заменит
   старые транспорты).
2. **Клиент**: слушает `connectionstatechange` транспортов; при `failed` —
   ICE restart сразу, при `disconnected` — через 5 с. Не ожил за 10 с —
   полный re-join.

### Half-open соединения

Protocol-уровневые ping-и браузер не отдаёт странице, поэтому сервер
продублирует их сообщением `ping` каждые `SIGNALING_PING_INTERVAL_MS`
(по умолчанию 5 с). Клиент держит watchdog: нет сообщений дольше трёх
интервалов — соединение считается мёртвым и пересоздаётся, не дожидаясь
`onclose` (при смене сети его может не быть вовсе).

Смена **типа** сети (wifi ↔ cellular) на Android часто не даёт `offline`/
`online`, поэтому клиент дополнительно слушает `navigator.connection`
(Chrome/Android) и при переходе между известными типами немедленно
форсирует переподключение. Пока `navigator.onLine === false`, клиент новых
сокетов не открывает — ждёт `online` (периодически перепроверяя флаг).

Все запросы клиент сопровождает таймаутом (10 с): потерянный ответ не
должен подвешивать восстановление.
