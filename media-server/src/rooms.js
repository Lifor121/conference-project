const config = require('./config');
const { Room } = require('./Room');

// реестр комнат этого процесса
const rooms = new Map();

async function getOrCreateRoom(roomId, workerPool) {
  let room = rooms.get(roomId);
  if (!room || room.closed) {
    rooms.delete(roomId);
    room = new Room({ roomId, worker: workerPool.next(), maxPeers: config.app.maxPeersPerRoom });
    room.onClosed = () => rooms.delete(room.id);
    rooms.set(roomId, room);
    await room.init();
    room.scheduleClose(); // если join не состоится — комната сама исчезнет через roomCloseDelayMs
  }
  return room;
}

function roomStats() {
  return [...rooms.values()].map((r) => ({ id: r.id, peers: r.peers.size }));
}

// опрос здоровья медиа во всех комнатах (интервал поднимается в index.js)
function checkAllRoomsMediaHealth() {
  for (const room of rooms.values()) room.checkMediaHealth();
}

module.exports = { getOrCreateRoom, roomStats, checkAllRoomsMediaHealth };
