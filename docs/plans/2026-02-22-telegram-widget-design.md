# Telegram Widget Design

**Date:** 2026-02-22
**Branch:** `feature/telegram-widget`
**Status:** Approved

## Goal

Full-featured Telegram widget for LobsterBoard — send/receive messages, read feeds, browse groups and forum topics, upload attachments. Modeled after the Telegram app UI. Built with `node-telegram-bot-api` server-side in `server.cjs`, custom widget in `widgets.js`.

## Architecture

```
server.cjs (local, MacBook Air)
├── TELEGRAM_BOT_TOKEN from .env
├── node-telegram-bot-api (polling mode)
├── In-memory message cache (Map<chatId, Message[]>)
├── SSE broadcast for real-time updates
└── REST endpoints under /api/telegram/

widgets.js
└── 'telegram' widget (responsive, Telegram-style UI)
```

## Server Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/telegram/chats` | GET | List all chats the bot is in |
| `/api/telegram/chats/:chatId/topics` | GET | List forum topics for a group |
| `/api/telegram/messages` | GET | Fetch messages — `?chat_id=&topic_id=&limit=50&offset=` |
| `/api/telegram/send` | POST | Send text — `{ chat_id, text, topic_id?, reply_to? }` |
| `/api/telegram/upload` | POST | Send file — multipart form with `chat_id`, `file`, `caption?`, `topic_id?` |
| `/api/telegram/stream` | GET | SSE — pushes new messages in real-time |

## Backend Details

- `node-telegram-bot-api` in polling mode via `getUpdates`
- Messages cached in-memory: last N per chat (configurable, default 100)
- Chat list built from incoming messages (bot must be a member)
- SSE broadcasts new messages to connected widget clients
- No database — cache resets on server restart
- Multipart file upload handled with raw body parsing (no multer — keep zero-framework approach)

## Widget UI

### Responsive Layout

**Large (>=400px wide):** Side-by-side — chat list (~35%) + message pane (~65%)
**Small (<400px wide):** Single-pane — chat list OR messages with back button

### Chat List Panel

- Search/filter input at top
- Groups expandable with forum topics as indented sub-items
- Private chats listed flat
- Unread count badges
- Active chat highlighted

### Message Pane

- Header: chat/topic name with back button (small mode)
- Scrollable message list: sender name, avatar initial, timestamp, text/media
- Composer bar: attachment button (file picker) + text input + send button
- Auto-scroll to bottom on new messages

### Widget Properties

```js
properties: {
  title: 'Telegram',
  pollInterval: '5',
  messageLimit: '100',
  showAvatars: 'true',
}
```

## Data Flow

1. Server starts -> bot begins polling with getUpdates
2. Messages arrive -> cached in Map, broadcast via SSE
3. Widget loads -> fetches /api/telegram/chats, connects to /api/telegram/stream
4. User selects chat -> fetches /api/telegram/messages?chat_id=X(&topic_id=Y)
5. User sends message -> POST /api/telegram/send, SSE confirms
6. User uploads file -> POST multipart /api/telegram/upload

## New Dependencies

- `node-telegram-bot-api` (npm) — added to package.json

## New Env Var

- `TELEGRAM_BOT_TOKEN` in `.env` (production only, gitignored)

## Constraints

- innerHTML blocked by hook — use createElement + textContent
- Follows existing patterns: Todoist proxy for endpoint style, SSE for real-time
- Push to `fork` remote, not `origin`
- Deploy via rsync to ~/lobsterboard/ (exclude .env)
