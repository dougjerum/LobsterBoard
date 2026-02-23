#!/usr/bin/env bash
# LobsterBoard startup script
# Opens SSH tunnel to Mac Mini (OpenClaw) and starts the server
# Works both interactively and under launchd

set -uo pipefail

MINI_TS_IP="100.114.198.62"
OC_PORT=18789
TG_BRIDGE_PORT=18790
LB_PORT="${PORT:-8080}"

# ── Colors (disabled if not a terminal) ──
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
else
  RED=''; GREEN=''; CYAN=''; NC=''
fi

log() { echo "${CYAN}$1${NC}"; }
ok()  { echo "  ${GREEN}$1${NC}"; }
err() { echo "  ${RED}$1${NC}"; }

cleanup() {
  log "Shutting down..."
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null && echo "  SSH tunnel stopped"
  exit 0
}
trap cleanup INT TERM

# ── Resolve project dir (works from any CWD) ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log "LobsterBoard starting (pid $$)..."

# ── Load credentials ──
# 1. Source .env for static credentials (headless/launchd mode)
if [ -f "$SCRIPT_DIR/.env" ]; then
  source "$SCRIPT_DIR/.env" || true
  export TODOIST_API_TOKEN="${TODOIST_API_TOKEN:-}"
fi

# 2. If TODOIST_API_TOKEN still empty, try 1Password (interactive only)
if [ -z "${TODOIST_API_TOKEN:-}" ] && command -v op &>/dev/null; then
  log "Loading Todoist API token from 1Password..."
  TODOIST_API_TOKEN=$(op item get 5znlqyiphlgseypq37fwusbwme --fields label="API Key" --reveal 2>/dev/null || true)
  export TODOIST_API_TOKEN="${TODOIST_API_TOKEN:-}"
fi

if [ -n "${TODOIST_API_TOKEN:-}" ]; then
  ok "Todoist token loaded"
else
  err "No Todoist token (widget will be disabled)"
fi

# ── SSH tunnel to Mac Mini for OpenClaw + Telegram Bridge ──
# Skip if tunnel already active (idempotent for launchd restarts)
TUNNEL_PID=""
if lsof -ti:"$OC_PORT" -sTCP:LISTEN &>/dev/null && lsof -ti:"$TG_BRIDGE_PORT" -sTCP:LISTEN &>/dev/null; then
  TUNNEL_PID=$(lsof -ti:"$OC_PORT" -sTCP:LISTEN 2>/dev/null | head -1)
  ok "SSH tunnel already active (PID $TUNNEL_PID)"
else
  log "Opening SSH tunnel to Mac Mini ($MINI_TS_IP — ports $OC_PORT, $TG_BRIDGE_PORT)..."
  if ssh -f -N \
    -L "$OC_PORT:127.0.0.1:$OC_PORT" \
    -L "$TG_BRIDGE_PORT:127.0.0.1:$TG_BRIDGE_PORT" \
    "$MINI_TS_IP" 2>/dev/null; then
    TUNNEL_PID=$(lsof -ti:"$OC_PORT" -sTCP:LISTEN 2>/dev/null | head -1)
    ok "Tunnel active (PID ${TUNNEL_PID:-unknown})"
  else
    err "Tunnel failed — OpenClaw/Telegram widgets will show fallback data"
  fi
fi

# ── Start LobsterBoard server ──
cd "$SCRIPT_DIR"
[ -t 1 ] && echo "  Press Ctrl+C to stop"

if [ -t 1 ]; then
  # Interactive: run once in foreground
  log "Starting LobsterBoard on port $LB_PORT..."
  exec node server.cjs
else
  # Headless (launchd): restart loop with backoff
  RESTART_DELAY=5
  while true; do
    log "Starting LobsterBoard on port $LB_PORT..."
    node server.cjs
    EXIT_CODE=$?
    err "Server exited ($EXIT_CODE) — restarting in ${RESTART_DELAY}s..."
    sleep "$RESTART_DELAY"
  done
fi
