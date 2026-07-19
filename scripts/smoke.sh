#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-harbor:dev}"
NETWORK="harbor-smoke-$$"
PG="harbor-smoke-pg-$$"
APP="harbor-smoke-app-$$"

cleanup() {
  docker rm -f "$APP" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NETWORK" >/dev/null

docker run -d --name "$PG" --network "$NETWORK" \
  -e POSTGRES_DB=harbor -e POSTGRES_USER=harbor -e POSTGRES_PASSWORD=smoke \
  postgres:17-alpine >/dev/null

echo "waiting for postgres..."
for _ in $(seq 1 30); do
  if docker exec "$PG" pg_isready -U harbor -d harbor >/dev/null 2>&1; then break; fi
  sleep 1
done

docker run -d --name "$APP" --network "$NETWORK" -p 3000:3000 \
  -e DATABASE_URL="postgresql://harbor:smoke@$PG:5432/harbor" \
  -e HARBOR_BASE_URL=http://localhost:3000 \
  -e HARBOR_SECRET=0123456789abcdef0123456789abcdef \
  "$IMAGE" >/dev/null

echo "waiting for readiness..."
ready=false
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:3000/api/v1/health/ready >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done

if [ "$ready" != "true" ]; then
  echo "FAIL: readiness never reported true"
  docker logs "$APP"
  exit 1
fi

echo "checking endpoints..."
curl -fsS http://localhost:3000/api/v1/health/live  | grep -q '"status":"ok"'
curl -fsS http://localhost:3000/api/v1/health       | grep -q '"version"'
curl -fsS http://localhost:3000/api/v1/installation/state | grep -q '"setupComplete":false'

echo "checking API 404 shape..."
curl -sS http://localhost:3000/api/v1/nope | grep -q '"code":"NOT_FOUND"'

echo "checking no secrets in logs..."
if docker logs "$APP" 2>&1 | grep -q "0123456789abcdef0123456789abcdef"; then
  echo "FAIL: HARBOR_SECRET leaked into logs"
  exit 1
fi

echo "checking graceful shutdown..."
docker stop --timeout 20 "$APP" >/dev/null
code=$(docker inspect "$APP" --format '{{.State.ExitCode}}')
if [ "$code" != "0" ]; then
  echo "FAIL: exit code $code after SIGTERM"
  docker logs "$APP"
  exit 1
fi

echo "SMOKE PASSED"
