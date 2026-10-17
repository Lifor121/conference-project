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
