#!/usr/bin/env bash
set -u
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
mkdir -p "$DATA_DIR"
cd "$APP_DIR" || exit 1
backoff=1
child=""
stop() {
  if [[ -n "$child" ]]; then kill "${child:?}" 2>/dev/null || true; fi
  exit 0
}
trap stop TERM INT
while true; do
  node dist/index.js >> "$DATA_DIR/server.log" 2>&1 &
  child="$!"
  wait "${child:?}" || true
  child=""
  sleep "$backoff"
  if (( backoff < 30 )); then backoff=$((backoff * 2)); fi
done
