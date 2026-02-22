#!/usr/bin/env bash
# LobsterBoard startup script
# Opens SSH tunnel to Mac Mini (OpenClaw) and starts the server

set -euo pipefail

MINI_TS_IP="100.114.198.62"
OC_PORT=18789
LB_PORT="${PORT:-8080}"

# ── Colors ──
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'

cleanup() {
  echo -e "\n${CYAN}Shutting down...${NC}"
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null && echo "  SSH tunnel stopped"
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null && echo "  Server stopped"
  exit 0
}
trap cleanup INT TERM

# ── Resolve project dir (works from any CWD) ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Load Todoist token from 1Password (if available) ──
if command -v op &>/dev/null; then
  echo -e "${CYAN}Loading Todoist API token from 1Password...${NC}"
  export TODOIST_API_TOKEN=$(op item get 5znlqyiphlgseypq37fwusbwme --fields label="API Key" --reveal 2>/dev/null || true)
  [ -n "$TODOIST_API_TOKEN" ] && echo -e "  ${GREEN}Todoist token loaded${NC}" || echo -e "  ${RED}Failed to load token (Todoist widget will be disabled)${NC}"
fi

# ── SSH tunnel to Mac Mini for OpenClaw ──
echo -e "${CYAN}Opening SSH tunnel to Mac Mini ($MINI_TS_IP:$OC_PORT)...${NC}"
ssh -f -N -L "$OC_PORT:127.0.0.1:$OC_PORT" "$MINI_TS_IP" 2>/dev/null
TUNNEL_PID=$(lsof -ti:"$OC_PORT" -sTCP:LISTEN 2>/dev/null | head -1)

if [ -n "$TUNNEL_PID" ]; then
  echo -e "  ${GREEN}Tunnel active (PID $TUNNEL_PID)${NC}"
else
  echo -e "  ${RED}Tunnel failed — OpenClaw widgets will show fallback data${NC}"
fi

# ── Start LobsterBoard server ──
echo -e "${CYAN}Starting LobsterBoard on port $LB_PORT...${NC}"
cd "$SCRIPT_DIR"
node server.cjs &
SERVER_PID=$!
sleep 1

if kill -0 "$SERVER_PID" 2>/dev/null; then
  echo -e "  ${GREEN}Server running at http://127.0.0.1:$LB_PORT${NC}"
  echo ""
  echo -e "  Press ${RED}Ctrl+C${NC} to stop"
  wait "$SERVER_PID"
else
  echo -e "  ${RED}Server failed to start${NC}"
  cleanup
fi
