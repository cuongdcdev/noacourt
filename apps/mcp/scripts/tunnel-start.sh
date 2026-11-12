#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
mkdir -p "${DATA_DIR:?}"
PID_FILE="$DATA_DIR/tunnel.pid"
if [[ -f "${PID_FILE:?}" ]]; then
  pid="$(cat "${PID_FILE:?}")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "${pid:?}" 2>/dev/null; then
    command_line="$(ps -p "${pid:?}" -o args= || true)"
    if [[ "$command_line" == *"tunnel-run-forever.sh"* || "$command_line" == *"cloudflared tunnel --config /root/.cloudflared/noacourt-mcp.yml run noacourt-mcp"* ]]; then
      echo "Noa Court tunnel already running (pid $pid)"
      exit 0
    fi
    echo "PID file points to an unrelated process; refusing to replace it" >&2
    exit 1
  fi
fi
nohup "${APP_DIR:?}/scripts/tunnel-run-forever.sh" </dev/null >> "${DATA_DIR:?}/tunnel.log" 2>&1 &
pid="$!"
echo "${pid:?}" > "${PID_FILE:?}"
echo "Started Noa Court tunnel wrapper (pid ${pid:?})"
