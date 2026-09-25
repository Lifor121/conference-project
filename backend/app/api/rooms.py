import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_session
from app.models.room import Room
from app.schemas.room import RoomCreate, RoomRead

router = APIRouter(prefix="/api/rooms", tags=["rooms"])


@router.post("", response_model=RoomRead, status_code=status.HTTP_201_CREATED)
async def create_room(payload: RoomCreate, session: AsyncSession = Depends(get_session)):
    room = Room(id=str(uuid.uuid4()), name=payload.name)
    session.add(room)
    await session.commit()
    await session.refresh(room)
    return room


@router.get("", response_model=list[RoomRead])
async def list_rooms(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(Room).order_by(Room.created_at.desc()))
    return result.scalars().all()


@router.get("/{room_id}", response_model=RoomRead)
async def get_room(room_id: str, session: AsyncSession = Depends(get_session)):
    room = await session.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return room


@router.delete("/{room_id}", status_code=status.HTTP_204_NO_CONTENT)
async def close_room(room_id: str, session: AsyncSession = Depends(get_session)):
    """Закрытие комнаты — media-server не пустит новых участников."""
    room = await session.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    room.is_active = False
    await session.commit()
