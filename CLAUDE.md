# LobsterBoard — Project Context

## Overview

LobsterBoard v0.2.5 — self-hosted drag-and-drop dashboard builder. Vanilla Node.js, zero build steps, no frameworks. 50 widgets, template gallery, custom pages, real-time system stats via SSE.

**Upstream**: `origin` → github.com/Curbob/LobsterBoard (no push access)
**Fork**: `fork` → github.com/dougjerum/LobsterBoard (push here)

---

## Architecture

```
MacBook Air (LobsterBoard)          Mac Mini (OpenClaw)
┌────────────────────────┐          ┌──────────────────┐
│  ~/lobsterboard/       │          │  OpenClaw Gateway │
│  ├── server.cjs        │   SSH    │  port 18789       │
│  ├── start.sh ─────────┼──tunnel──┼──────────────────►│
│  ├── .env              │  via     │                    │
│  ├── .openclaw-device-  │ Tailscale│  Tailscale IP:    │
│  │   identity.json     │          │  100.114.198.62   │
│  └── config.json       │          └──────────────────┘
│                        │
│  launchd manages bash  │     Todoist API
│  bash manages node     │     api.todoist.com/api/v1
│  node listens :8080    │◄───────────────────────────
└────────────────────────┘
```

### Key files

| File | Lines | Purpose |
|------|-------|---------|
| `server.cjs` | ~2050 | HTTP server, OpenClaw WS RPC client, all API endpoints, SSE stats |
| `js/widgets.js` | ~3140 | 50 widget definitions (generateHtml + generateJs) |
| `app.html` | ~840 | SPA shell — drag-and-drop editor, canvas, properties panel |
| `js/builder.js` | | Editor UI logic |
| `js/templates.js` | | Template gallery UI |
| `css/builder.css` | | Editor styles |
| `start.sh` | ~90 | Startup: load creds, SSH tunnel, run server with crash recovery |
| `com.lobsterboard.server.plist` | ~46 | macOS launchd auto-start config |
| `config.json` | | Runtime dashboard layout (gitignored) |
| `package.json` | | v0.2.5, deps: `ws`, `systeminformation` |

### Gitignored (never commit)

| File | Contents |
|------|----------|
| `.env` | `TODOIST_API_TOKEN=...` |
| `.openclaw-device-identity.json` | Ed25519 keypair + deviceId + deviceToken |
| `config.json` | User's dashboard layout |
| `auth.json` | PIN hash + public mode flag |
| `secrets.json` | Encrypted API keys/URLs |
| `todos.json` / `notes.json` | Widget user data |

---

## Deployment

### Two directories

| Location | Purpose |
|----------|---------|
| `~/Documents/Coding/LobsterBoard/.claude/worktrees/elated-matsumoto` | Git worktree for development |
| `~/lobsterboard/` | Production — real directory (NOT symlink), rsync'd from worktree |

**Why ~/lobsterboard/?** macOS TCC (Transparency, Consent, Control) blocks launchd processes from accessing `~/Documents/.claude/` paths. Symlinks don't work because macOS resolves them to real paths for TCC checks. Solution: deploy to a path outside TCC-protected areas.

### Deploy changes to production

```bash
# From the worktree directory:
rsync -a --exclude='.git' --exclude='.claude' --exclude='node_modules' \
  --exclude='config.json' --exclude='todos.json' --exclude='notes.json' \
  --exclude='auth.json' --exclude='secrets.json' --exclude='data' \
  ./ /Users/douglasjerum/lobsterboard/

# Do NOT rsync .env or .openclaw-device-identity.json — they already exist in production
# and contain credentials that aren't in the worktree

# Restart the server:
launchctl kickstart -k gui/$(id -u)/com.lobsterboard.server
```

### launchd service

**Plist**: `~/Library/LaunchAgents/com.lobsterboard.server.plist`
**Installed from**: repo's `com.lobsterboard.server.plist` (copy, not symlink)

| Setting | Value | Why |
|---------|-------|-----|
| RunAtLoad | true | Start on login |
| KeepAlive.SuccessfulExit | false | Restart only if bash crashes |
| ThrottleInterval | 5 | 5s cooldown between restarts |

**Crash recovery architecture**: launchd manages bash → bash's while-true loop manages node. If node crashes, bash restarts it after 5s. If bash itself crashes, launchd restarts it. This avoids macOS's "inefficient" process marking that blocks KeepAlive=true from working with fast-restarting processes.

**Logs**: `/private/tmp/lobsterboard.log` and `/private/tmp/lobsterboard.err`

**Common commands**:
```bash
# View status
launchctl print gui/$(id -u)/com.lobsterboard.server

# Restart
launchctl kickstart -k gui/$(id -u)/com.lobsterboard.server

# Stop
launchctl kill SIGTERM gui/$(id -u)/com.lobsterboard.server

# Full reset (uninstall + reinstall)
launchctl bootout gui/$(id -u)/com.lobsterboard.server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lobsterboard.server.plist

# View logs
tail -f /private/tmp/lobsterboard.log
```

---

## start.sh Flow

1. Set `MINI_TS_IP=100.114.198.62`, `OC_PORT=18789`, `LB_PORT=8080`
2. Source `.env` for `TODOIST_API_TOKEN` (headless/launchd mode)
3. If token still empty and interactive, try `op item get` from 1Password
4. Open SSH tunnel: `ssh -f -N -L 18789:127.0.0.1:18789 100.114.198.62`
   - Reuses existing tunnel if port already listening (idempotent)
5. Start server:
   - **Interactive** (tty): `exec node server.cjs` (foreground, Ctrl+C to stop)
   - **Headless** (launchd): `while true` loop, restart node on exit with 5s delay

---

## OpenClaw WebSocket RPC

### Authentication

- **Identity file**: `.openclaw-device-identity.json` in `__dirname`
  - Fields: `deviceId`, `publicKeyPem`, `privateKeyPem`, `deviceToken`
- **Token**: Reads `OPENCLAW_TOKEN` env var, falls back to `deviceToken` from identity file
- **Handshake**: Ed25519 signature over `v2|deviceId|clientId|mode|role|scopes|signedAt|token|nonce`
- **Scopes**: `operator.admin`, `operator.approvals`, `operator.pairing`
- **Auto-reconnect**: 5s interval on disconnect

### Registered devices

Two devices are registered with OpenClaw: `LobsterBoard` and `LobsterBoard Dashboard`. The identity file in `~/lobsterboard/` corresponds to one of these.

### RPC endpoints

| Server endpoint | RPC method | Notes |
|----------------|------------|-------|
| `GET /api/sessions` | `gateway.sessions.list` | Active sessions (Telegram, cron, subagents) |
| `GET /api/cron` | `gateway.cron.list` | Cron job definitions + last run status |
| `GET /api/releases` | `config.get` + GitHub API | Current version vs latest release (1hr cache) |
| `GET /api/auth` | Direct WS state | Gateway auth status |
| `GET /api/system-log` | File read | Parsed gateway.log entries |
| `GET /api/logs` | File read | Last 50 lines of gateway.log |
| `GET /api/today` | Port 3000 compat | Daily activity summary |
| `GET /api/activity` | File read | Recent activity from memory file |

---

## Todoist API Proxy

**Base**: `https://api.todoist.com/api/v1` proxied through `/api/todoist/`
**Auth**: `Bearer` token from `TODOIST_API_TOKEN` env var

| Proxy endpoint | Method | Todoist API | Notes |
|---------------|--------|-------------|-------|
| `/api/todoist/tasks` | GET | `/api/v1/tasks` | Paginates all `next_cursor` pages, supports `filter`, `project_id`, `label` params |
| `/api/todoist/tasks` | POST | `/api/v1/tasks` | Create task |
| `/api/todoist/tasks/:id` | POST | `/api/v1/tasks/:id` | Update task |
| `/api/todoist/tasks/:id` | DELETE | `/api/v1/tasks/:id` | Delete task |
| `/api/todoist/tasks/:id/close` | POST | `/api/v1/tasks/:id/close` | Complete task |
| `/api/todoist/tasks/:id/reopen` | POST | `/api/v1/tasks/:id/reopen` | Reopen task |
| `/api/todoist/projects` | GET | `/api/v1/projects` | List all projects |

**Pagination**: v1 API returns `{ results: [...], next_cursor }`. Proxy loops through all pages and returns the concatenated flat array.

---

## Other API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/config` | GET/POST | Load/save dashboard layout (1 MB limit) |
| `/api/pages` | GET | List enabled custom pages |
| `/pages/<id>/*` | GET | Serve page static files |
| `/api/pages/<id>/*` | ANY | Route page API handlers |
| `/api/auth/status` | GET | PIN status + public mode |
| `/api/auth/set-pin` | POST | Set 4-6 digit PIN (SHA-256) |
| `/api/auth/verify-pin` | POST | Verify PIN |
| `/api/auth/remove-pin` | POST | Clear PIN |
| `/api/mode` | GET/POST | Toggle public mode |
| `/api/todos` | GET/POST | Local todo.json |
| `/api/notes` | GET/POST | Local notes.json |
| `/api/stats` | GET | CPU/memory/disk/network/docker/uptime |
| `/api/stats/stream` | GET | SSE real-time stats (2-30s intervals) |
| `/api/rss` | GET | SSRF-protected RSS/Atom proxy |
| `/api/calendar` | GET | iCal parser with TZID support |
| `/api/usage/claude` | GET | Anthropic usage proxy |
| `/api/usage/openai` | GET | OpenAI usage proxy |
| `/api/usage/gemini` | GET | Gemini usage proxy |
| `/api/quote` | GET | zenquotes.io CORS proxy |
| `/api/lb-release` | GET | LobsterBoard version check (1hr cache) |
| `/api/latest-image` | GET | Latest image from folder |
| `/api/browse-dirs` | GET | Directory browser for folder picker |
| `/api/templates` | GET | List templates |
| `/api/templates/import` | POST | Import template |
| `/api/templates/export` | POST | Export current config as template |
| `/api/templates/:id` | DELETE | Delete template |

---

## Widget System

50 widgets in `js/widgets.js`. Each widget has:
- `generateHtml(props)` → static HTML structure
- `generateJs(props)` → async update function + setInterval

**Categories**: System Monitoring (5), Weather (2), Time/Productivity (6), Media/Content (5), OpenClaw (5), AI Usage (4), Finance (3), Display (7), Smart Home (3), GitHub/Dev (2), Misc (8)

**Custom widgets added in this branch**:
- `todoist` — Todoist task list with today-only filtering, project grouping, priority coloring, complete/delete actions

---

## Constraints

- **Do NOT alter OpenClaw config files** on the Mac Mini
- **Do NOT rsync** `.env`, `.openclaw-device-identity.json`, `config.json`, `auth.json`, `secrets.json` — these are production-only files that exist in `~/lobsterboard/` but not the worktree
- **Todoist API is v1** (not v2 which is deprecated). Returns paginated `{ results, next_cursor }`
- **innerHTML is blocked** by a hook — use `createElement` + `textContent` for DOM manipulation in widget code
- **Push to `fork` remote**, not `origin`

---

## Gotchas Learned

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| launchd "Operation not permitted" | macOS TCC blocks ~/Documents/.claude/ paths | Deploy to ~/lobsterboard/ (real dir, not symlink) |
| launchd won't restart process | KeepAlive=true marks fast-dying processes "inefficient" | Bash while-true loop handles node restarts; launchd only manages bash |
| OpenClaw WS disabled | `OPENCLAW_TOKEN` env var not set | Falls back to `deviceToken` from identity file |
| Todoist showing only ~30 tasks | Proxy returned first page only | Paginate through all `next_cursor` pages |
| 1Password token empty | `op item get` needs `--reveal` flag | Added `--reveal` to op command |
| Symlinks don't bypass TCC | macOS resolves symlinks to real paths | Use real directory instead |
