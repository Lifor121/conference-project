import os
from pathlib import Path

import pytest
from alembic.config import Config
from testcontainers.community.postgres import PostgresContainer

from alembic import command

BACKEND_DIR = Path(__file__).resolve().parent.parent

_pg = PostgresContainer("postgres:16-alpine", driver="asyncpg")
_pg.start()

os.environ["DATABASE_URL"] = _pg.get_connection_url()

_alembic_cfg = Config(BACKEND_DIR / "alembic.ini")
_alembic_cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
command.upgrade(_alembic_cfg, "head")


@pytest.fixture
async def client():
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture(autouse=True)
async def clean_rooms():
    from sqlalchemy import text

    from app.core.database import async_session, engine

    async with async_session() as session:
        await session.execute(text("DELETE FROM rooms"))
        await session.commit()

    yield

    await engine.dispose()
