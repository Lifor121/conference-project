up:
	docker compose up -d --build

down:
	docker compose down

stop:
	docker compose stop

start:
	docker compose start

logs:
	docker compose logs -f

migrate:
	docker compose exec backend alembic upgrade head

migration:
	docker compose exec backend alembic revision --autogenerate -m "$(m)"

psql:
	docker compose exec db sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

rebuild:
	docker compose up -d --build --renew-anon-volumes

set-announced-ip:
	@LAN_IP=$$(ip -4 route get 1.1.1.1 | grep -oP 'src \K[0-9.]+'); \
	echo "MEDIASOUP_ANNOUNCED_IP=$$LAN_IP" >> /dev/null; \
	sed -i "s/^MEDIASOUP_ANNOUNCED_IP=.*/MEDIASOUP_ANNOUNCED_IP=$$LAN_IP/" .env; \
	docker compose up -d media; \
	echo "announced ip → $$LAN_IP"

.PHONY: up down logs migrate migration psql rebuild
