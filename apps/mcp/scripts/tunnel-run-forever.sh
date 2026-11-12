#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
mkdir -p "${DATA_DIR:?}"

child=""
stopping=0
stop() {
  stopping=1
  if [[ -n "$child" ]]; then
    kill "${child:?}" 2>/dev/null || true
    wait "${child:?}" 2>/dev/null || true
  fi
}
trap stop TERM INT

backoff=1
while (( stopping == 0 )); do
  cloudflared tunnel --config /root/.cloudflared/noacourt-mcp.yml run noacourt-mcp >> "${DATA_DIR:?}/tunnel.log" 2>&1 &
  child="$!"
  wait "${child:?}" || true
  child=""
  if (( stopping != 0 )); then
    break
  fi
  sleep "$backoff" || true
  if (( backoff < 30 )); then
    backoff=$((backoff * 2))
  fi
done
