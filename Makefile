up:
    docker compose up -d --build

down:
    docker compose down

logs:
    docker compose logs -f

migrate:
    docker compose exec backend alembic upgrade head

migration:
    docker compose exec backend alembic revision --autogenerate -m "$(m)"

psql:
    docker compose exec db sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

.PHONY: up down logs migrate migration psql
