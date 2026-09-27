# Signaling-протокол media-server

## Подключение

`ws(s)://<host>/ws?roomId=<uuid комнаты из backend>`

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

Правила:

- до join все методы кроме join → Not joined
- повторный join → Already joined
- source в produce: "webcam" (default) | "screen"
- повторный createWebRtcTransport с тем же direction закрывает старый транспорт(используется при переподключении)
- consume создаёт consumer **на паузе**: клиент получил ответ → собрал track →вызвал resumeConsumer. Так не теряются первые RTP-пакеты.

Ошибки join: room_not_found, room_closed, room_full (в поле code).

## Уведомления S→C

| notification     | data                                                          |
| ---------------- | ------------------------------------------------------------- |
| newPeer        | { peerId, displayName }                                     |
| peerClosed     | { peerId } — участник вышел, убрать все его треки           |
| newProducer    | { peerId, producerId, kind, source } — можно делать consume |
| producerClosed | { peerId, producerId } — источник выключен/заменён          |
| consumerClosed | { consumerId } — ваш consumer умер (источник пропал)        |

## Переподключение

Новый WebSocket → новый join (peerId будет другой) → заново create/connectтранспортов → заново produce. Клиенты получат peerClosed старого пира иnewPeer нового.
