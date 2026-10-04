#!/usr/bin/env bash
# Boots a throwaway server on a random port with a clean database, runs the
# e2e suite against it, then tears everything down.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-4317}"
DATA="$(mktemp -d)"
LOG="$(mktemp)"

cleanup() {
  [[ -n "${SRV_PID:-}" ]] && kill "$SRV_PID" 2>/dev/null || true
  wait "${SRV_PID:-}" 2>/dev/null || true
  rm -rf "$DATA" "$LOG"
}
trap cleanup EXIT

DATA_DIR="$DATA" PORT="$PORT" ADMIN_PASSWORD=testadmin123 \
  node src/server.js > "$LOG" 2>&1 &
SRV_PID=$!

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/status" > /dev/null && break
  sleep 0.25
done

if ! curl -sf "http://127.0.0.1:$PORT/api/status" > /dev/null; then
  echo "server failed to start:"; cat "$LOG"; exit 1
fi

node test/e2e.js "http://127.0.0.1:$PORT" testadmin123