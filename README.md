# Открытая система видеоконференций
FastAPI (REST) + Node.js/mediasoup (SFU + signaling) + React + PostgreSQL + Redis + Docker.

## Быстрый старт
```zsh
cp .env.example .env && make up
```

```zsh
make up                    # стек целиком
make rebuild               # после смены package.json / requirements.txt
docker compose exec frontend npm run build   # пересборка статики для nginx
```

CI гоняет: ruff+pytest (backend), eslint (media), lint+build (frontend). 
Локально повторить:

## backend (из backend/, в venv)
```zsh
ruff check . && pytest -v
```
## media / frontend — чистой копией
```zsh
make ci-check-media
make ci-check-frontend
```
