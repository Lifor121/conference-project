async function request(path, options = {}) {
  let res
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    })
  } catch {
    throw new Error('Сервер недоступен')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const detail =
      typeof body.detail === 'string'
        ? body.detail
        : JSON.stringify(body.detail ?? `HTTP ${res.status}`)
    throw new Error(detail)
  }
  return res.status === 204 ? null : res.json()
}

export const api = {
  createRoom: (name) =>
    request('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) }),
}
