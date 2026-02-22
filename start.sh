#!/usr/bin/env bash
# LobsterBoard startup script
# Opens SSH tunnel to Mac Mini (OpenClaw) and starts the server
# Works both interactively and under launchd

set -euo pipefail

MINI_TS_IP="100.114.198.62"
OC_PORT=18789
LB_PORT="${PORT:-8080}"

# ── Colors (disabled if not a terminal) ──
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
else
  RED=''; GREEN=''; CYAN=''; NC=''
fi

log() { echo -e "${CYAN}$1${NC}"; }
ok()  { echo -e "  ${GREEN}$1${NC}"; }
err() { echo -e "  ${RED}$1${NC}"; }

cleanup() {
  log "Shutting down..."
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null && echo "  SSH tunnel stopped"
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null && echo "  Server stopped"
  exit 0
}
trap cleanup INT TERM

# ── Resolve project dir (works from any CWD) ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Load credentials ──
# 1. Source .env for static credentials (headless/launchd mode)
[ -f "$SCRIPT_DIR/.env" ] && set -a && source "$SCRIPT_DIR/.env" && set +a

# 2. If TODOIST_API_TOKEN still empty, try 1Password (interactive only)
if [ -z "${TODOIST_API_TOKEN:-}" ] && command -v op &>/dev/null; then
  log "Loading Todoist API token from 1Password..."
  export TODOIST_API_TOKEN=$(op item get 5znlqyiphlgseypq37fwusbwme --fields label="API Key" --reveal 2>/dev/null || true)
fi

[ -n "${TODOIST_API_TOKEN:-}" ] && ok "Todoist token loaded" || err "No Todoist token (widget will be disabled)"

# ── SSH tunnel to Mac Mini for OpenClaw ──
# Skip if tunnel already active (idempotent for launchd restarts)
if lsof -ti:"$OC_PORT" -sTCP:LISTEN &>/dev/null; then
  TUNNEL_PID=$(lsof -ti:"$OC_PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  ok "SSH tunnel already active (PID $TUNNEL_PID)"
else
  log "Opening SSH tunnel to Mac Mini ($MINI_TS_IP:$OC_PORT)..."
  if ssh -f -N -L "$OC_PORT:127.0.0.1:$OC_PORT" "$MINI_TS_IP" 2>/dev/null; then
    TUNNEL_PID=$(lsof -ti:"$OC_PORT" -sTCP:LISTEN 2>/dev/null | head -1)
    ok "Tunnel active (PID ${TUNNEL_PID:-unknown})"
  else
    err "Tunnel failed — OpenClaw widgets will show fallback data"
  fi
fi

# ── Start LobsterBoard server ──
log "Starting LobsterBoard on port $LB_PORT..."
cd "$SCRIPT_DIR"
node server.cjs &
SERVER_PID=$!
sleep 1

if kill -0 "$SERVER_PID" 2>/dev/null; then
  ok "Server running at http://127.0.0.1:$LB_PORT"
  [ -t 1 ] && echo -e "\n  Press ${RED}Ctrl+C${NC} to stop"
  wait "$SERVER_PID"
else
  err "Server failed to start"
  cleanup
fi
