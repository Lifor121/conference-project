from fastapi import FastAPI

from app.api import rooms
from app.core.config import settings

app = FastAPI(title=settings.app_name)
app.include_router(rooms.router)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "backend"}
