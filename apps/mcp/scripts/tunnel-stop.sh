#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
PID_FILE="$DATA_DIR/tunnel.pid"
[[ -f "${PID_FILE:?}" ]] || { echo "Noa Court tunnel is not running"; exit 0; }
pid="$(cat "${PID_FILE:?}")"
[[ "$pid" =~ ^[0-9]+$ ]] || { echo "Invalid pid file" >&2; exit 1; }
if kill -0 "${pid:?}" 2>/dev/null; then
  command_line="$(ps -p "${pid:?}" -o args= || true)"
  [[ "$command_line" == *"tunnel-run-forever.sh"* || "$command_line" == *"cloudflared tunnel --config /root/.cloudflared/noacourt-mcp.yml run noacourt-mcp"* ]] || { echo "PID does not belong to this tunnel" >&2; exit 1; }
  kill "${pid:?}"
fi
rm -- "${PID_FILE:?}"
