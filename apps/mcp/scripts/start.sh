#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
mkdir -p "$DATA_DIR"
PID_FILE="$DATA_DIR/server.pid"
if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "Noa Court MCP already running (pid $pid)"
    exit 0
  fi
fi
nohup "$APP_DIR/scripts/run-forever.sh" </dev/null >> "$DATA_DIR/server.log" 2>&1 &
echo "$!" > "$PID_FILE"
echo "Started Noa Court MCP (pid $!)"
