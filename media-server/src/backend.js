const config = require('./config');

async function validateRoomForJoin(roomId) {
  let res;
  try {
    res = await fetch(`${config.backendUrl}/api/rooms/${encodeURIComponent(roomId)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    const err = new Error('Backend unavailable');
    err.code = 'backend_unavailable';
    throw err;
  }

  if (res.status === 404) {
    const err = new Error('Room not found');
    err.code = 'room_not_found';
    throw err;
  }
  if (!res.ok) throw new Error(`Backend error: HTTP ${res.status}`);

  const room = await res.json();
  if (!room.is_active) {
    const err = new Error('Room is closed');
    err.code = 'room_closed';
    throw err;
  }
  return room;
}

module.exports = { validateRoomForJoin };
