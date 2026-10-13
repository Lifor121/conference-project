import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def test_health(client):
    res = await client.get("/health")
    assert res.status_code == 200


async def test_room_lifecycle(client):
    res = await client.post("/api/rooms", json={"name": "ci"})
    assert res.status_code == 201
    room_id = res.json()["id"]

    res = await client.get(f"/api/rooms/{room_id}")
    assert res.status_code == 200
    assert res.json()["is_active"] is True

    res = await client.delete(f"/api/rooms/{room_id}")
    assert res.status_code == 204

    res = await client.get(f"/api/rooms/{room_id}")
    assert res.json()["is_active"] is False


async def test_room_not_found(client):
    res = await client.get("/api/rooms/00000000-0000-0000-0000-000000000000")
    assert res.status_code == 404
