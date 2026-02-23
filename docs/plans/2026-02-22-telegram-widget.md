# Telegram Widget Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a full-featured Telegram widget for LobsterBoard — send/receive messages, browse groups and forum topics, upload attachments, with real-time SSE updates.

**Architecture:** Server-side bot using `node-telegram-bot-api` in polling mode within `server.cjs`. In-memory message cache (`Map<chatId, Message[]>`). REST endpoints under `/api/telegram/`. SSE stream for real-time message push. Custom responsive widget in `js/widgets.js` modeled after Telegram's app UI.

**Tech Stack:** `node-telegram-bot-api` (npm), vanilla JS DOM manipulation (no innerHTML — blocked by hook), SSE for real-time, multipart form parsing for file uploads.

**Design doc:** `docs/plans/2026-02-22-telegram-widget-design.md`

---

### Task 1: Install dependency and configure env var

**Files:**
- Modify: `package.json` (add `node-telegram-bot-api` to dependencies)
- Modify: `server.cjs:16` (add require)
- Reference: `.env` (add `TELEGRAM_BOT_TOKEN` — gitignored, production only)

**Step 1: Install the npm package**

Run:
```bash
npm install node-telegram-bot-api
```

Expected: `node-telegram-bot-api` added to `package.json` dependencies, `node_modules` updated.

**Step 2: Add require to server.cjs**

At line 16 (after `const WebSocket = require('ws');`), add:

```js
const TelegramBot = require('node-telegram-bot-api');
```

**Step 3: Add env var documentation**

The `.env` file in production (`~/lobsterboard/.env`) needs `TELEGRAM_BOT_TOKEN=<token>`. This is gitignored and must be added manually to production only. Do NOT commit the token.

**Step 4: Commit**

```bash
git add package.json package-lock.json server.cjs
git commit -m "feat(telegram): add node-telegram-bot-api dependency"
```

---

### Task 2: Bot initialization and message cache

**Files:**
- Modify: `server.cjs` — add Telegram bot init block between line 657 (end of `parseCalendar`) and line 658 (`const server = http.createServer`)

**Step 1: Add bot initialization and cache data structures**

Insert before `const server = http.createServer(...)` (line 658):

```js
// ─────────────────────────────────────────────
// Telegram Bot — polling mode via getUpdates
// ─────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let tgBot = null;
const tgMessageCache = new Map();       // chatId -> Message[]
const tgChatMeta = new Map();           // chatId -> { id, title, type, topics: Map }
const tgSseClients = new Set();         // SSE response objects
const TG_CACHE_LIMIT = 100;             // max messages per chat

if (TELEGRAM_TOKEN) {
  tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('🤖 Telegram bot started (polling mode)');

  tgBot.on('message', (msg) => {
    const chatId = msg.chat.id;

    // Track chat metadata
    if (!tgChatMeta.has(chatId)) {
      tgChatMeta.set(chatId, {
        id: chatId,
        title: msg.chat.title || msg.chat.first_name || String(chatId),
        type: msg.chat.type,
        topics: new Map()
      });
    }

    // Track forum topics
    if (msg.forum_topic_created) {
      const meta = tgChatMeta.get(chatId);
      meta.topics.set(msg.message_thread_id, {
        id: msg.message_thread_id,
        name: msg.forum_topic_created.name
      });
    }
    if (msg.message_thread_id && msg.chat.is_forum) {
      const meta = tgChatMeta.get(chatId);
      if (!meta.topics.has(msg.message_thread_id)) {
        meta.topics.set(msg.message_thread_id, {
          id: msg.message_thread_id,
          name: 'Topic ' + msg.message_thread_id
        });
      }
    }

    // Cache message
    if (!tgMessageCache.has(chatId)) tgMessageCache.set(chatId, []);
    const cache = tgMessageCache.get(chatId);
    cache.push(msg);
    if (cache.length > TG_CACHE_LIMIT) cache.shift();

    // Broadcast to SSE clients
    const ssePayload = JSON.stringify({ type: 'message', chatId, message: msg });
    for (const client of tgSseClients) {
      client.write(`data: ${ssePayload}\n\n`);
    }
  });

  tgBot.on('polling_error', (err) => {
    console.error('Telegram polling error:', err.message);
  });
} else {
  console.log('⚠️  TELEGRAM_BOT_TOKEN not set — Telegram widget disabled');
}
```

**Step 2: Verify server still starts**

Run:
```bash
node server.cjs
```

Expected: Server starts. If `TELEGRAM_BOT_TOKEN` is not set, prints the warning message. No crash. Ctrl+C to stop.

**Step 3: Commit**

```bash
git add server.cjs
git commit -m "feat(telegram): add bot init, message cache, and SSE broadcast"
```

---

### Task 3: REST API endpoints

**Files:**
- Modify: `server.cjs` — add endpoints after the Todoist proxy block (after line 1132, before `// GET /api/cron`)

**Step 1: Add the Telegram API route block**

Insert after line 1132 (end of Todoist proxy block) and before line 1134 (`// GET /api/cron`):

```js
  // ── Telegram API ──

  // GET /api/telegram/chats — list all known chats
  if (req.method === 'GET' && pathname === '/api/telegram/chats') {
    if (!tgBot) { sendError(res, 'Telegram not configured', 503); return; }
    const chats = [];
    for (const [id, meta] of tgChatMeta) {
      const msgs = tgMessageCache.get(id) || [];
      const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
      chats.push({
        id: meta.id,
        title: meta.title,
        type: meta.type,
        topics: Array.from(meta.topics.values()),
        lastMessage: lastMsg ? (lastMsg.text || '[media]') : '',
        lastMessageDate: lastMsg ? lastMsg.date : 0,
        messageCount: msgs.length
      });
    }
    chats.sort((a, b) => b.lastMessageDate - a.lastMessageDate);
    sendJson(res, 200, chats);
    return;
  }

  // GET /api/telegram/chats/:chatId/topics — list forum topics for a group
  const topicsMatch = pathname.match(/^\/api\/telegram\/chats\/(-?\d+)\/topics$/);
  if (req.method === 'GET' && topicsMatch) {
    if (!tgBot) { sendError(res, 'Telegram not configured', 503); return; }
    const chatId = Number(topicsMatch[1]);
    const meta = tgChatMeta.get(chatId);
    if (!meta) { sendError(res, 'Chat not found', 404); return; }
    sendJson(res, 200, Array.from(meta.topics.values()));
    return;
  }

  // GET /api/telegram/messages — fetch messages for a chat
  if (req.method === 'GET' && pathname === '/api/telegram/messages') {
    if (!tgBot) { sendError(res, 'Telegram not configured', 503); return; }
    const chatId = Number(parsedUrl.searchParams.get('chat_id'));
    const topicId = parsedUrl.searchParams.get('topic_id');
    const limit = Math.min(Number(parsedUrl.searchParams.get('limit') || 50), 200);
    const offset = Number(parsedUrl.searchParams.get('offset') || 0);
    if (!chatId) { sendError(res, 'chat_id required', 400); return; }
    let msgs = tgMessageCache.get(chatId) || [];
    if (topicId) {
      const tid = Number(topicId);
      msgs = msgs.filter(m => m.message_thread_id === tid);
    }
    const sliced = msgs.slice(offset, offset + limit);
    sendJson(res, 200, { messages: sliced, total: msgs.length });
    return;
  }

  // POST /api/telegram/send — send a text message
  if (req.method === 'POST' && pathname === '/api/telegram/send') {
    if (!tgBot) { sendError(res, 'Telegram not configured', 503); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { chat_id, text, topic_id, reply_to } = JSON.parse(body);
        if (!chat_id || !text) { sendError(res, 'chat_id and text required', 400); return; }
        const opts = {};
        if (topic_id) opts.message_thread_id = Number(topic_id);
        if (reply_to) opts.reply_to_message_id = Number(reply_to);
        const sent = await tgBot.sendMessage(chat_id, text, opts);
        sendJson(res, 200, sent);
      } catch (e) { sendError(res, e.message); }
    });
    return;
  }

  // POST /api/telegram/upload — send a file (multipart form-data)
  if (req.method === 'POST' && pathname === '/api/telegram/upload') {
    if (!tgBot) { sendError(res, 'Telegram not configured', 503); return; }
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) { sendError(res, 'multipart boundary required', 400); return; }
    const chunks = [];
    req.on('data', chunk => {
      chunks.push(chunk);
      if (chunks.reduce((s, c) => s + c.length, 0) > 50 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(chunks);
        const boundary = '--' + boundaryMatch[1];
        const parts = [];
        let pos = 0;
        while (pos < buf.length) {
          const bStart = buf.indexOf(boundary, pos);
          if (bStart === -1) break;
          const bEnd = bStart + boundary.length;
          if (buf.slice(bEnd, bEnd + 2).toString() === '--') break;
          const headerEnd = buf.indexOf('\r\n\r\n', bEnd);
          if (headerEnd === -1) break;
          const headers = buf.slice(bEnd + 2, headerEnd).toString();
          const nextBoundary = buf.indexOf(boundary, headerEnd + 4);
          const content = buf.slice(headerEnd + 4, nextBoundary - 2);
          const nameMatch = headers.match(/name="([^"]+)"/);
          const fileMatch = headers.match(/filename="([^"]+)"/);
          const ctMatch = headers.match(/Content-Type:\s*(.+)/i);
          parts.push({
            name: nameMatch ? nameMatch[1] : '',
            filename: fileMatch ? fileMatch[1] : null,
            contentType: ctMatch ? ctMatch[1].trim() : null,
            data: content
          });
          pos = nextBoundary;
        }
        const chatIdPart = parts.find(p => p.name === 'chat_id');
        const filePart = parts.find(p => p.filename);
        const captionPart = parts.find(p => p.name === 'caption');
        const topicPart = parts.find(p => p.name === 'topic_id');
        if (!chatIdPart || !filePart) { sendError(res, 'chat_id and file required', 400); return; }
        const chatId = Number(chatIdPart.data.toString());
        const opts = {};
        if (captionPart) opts.caption = captionPart.data.toString();
        if (topicPart) opts.message_thread_id = Number(topicPart.data.toString());
        const sent = await tgBot.sendDocument(chatId, filePart.data, opts, {
          filename: filePart.filename,
          contentType: filePart.contentType || 'application/octet-stream'
        });
        sendJson(res, 200, sent);
      } catch (e) { sendError(res, e.message); }
    });
    return;
  }

  // GET /api/telegram/stream — SSE for real-time messages
  if (req.method === 'GET' && pathname === '/api/telegram/stream') {
    if (!tgBot) { sendError(res, 'Telegram not configured', 503); return; }
    if (tgSseClients.size >= 5) { sendError(res, 'Too many Telegram SSE connections', 429); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    tgSseClients.add(res);
    req.on('close', () => tgSseClients.delete(res));
    return;
  }
```

**Step 2: Verify endpoints load without errors**

Run:
```bash
node server.cjs
```

Expected: Server starts without errors. Test with curl:
```bash
curl http://127.0.0.1:8080/api/telegram/chats
```
Expected: `[]` (empty array, no chats cached yet) or 503 if token not set.

**Step 3: Commit**

```bash
git add server.cjs
git commit -m "feat(telegram): add REST API endpoints and SSE stream"
```

---

### Task 4: Widget HTML structure

**Files:**
- Modify: `js/widgets.js:3136-3138` — insert `telegram` widget entry before the closing `};`

**Step 1: Add the telegram widget definition with generateHtml**

Insert before line 3138 (`};`) in the WIDGETS object — after the last widget entry's closing `},`:

```js
  'telegram': {
    name: 'Telegram',
    icon: '📱',
    category: 'large',
    description: 'Full-featured Telegram messaging widget. Send/receive messages, browse groups and forum topics, upload files. Requires TELEGRAM_BOT_TOKEN env var on server.',
    defaultWidth: 500,
    defaultHeight: 550,
    hasApiKey: false,
    properties: {
      title: 'Telegram',
      pollInterval: '5',
      messageLimit: '100',
      showAvatars: 'true',
    },
    preview: `<div style="padding:4px;font-size:11px;">
      <div style="display:flex;gap:4px;">
        <div style="width:35%;border-right:1px solid rgba(255,255,255,0.1);padding-right:4px;">
          <div style="font-weight:600;opacity:0.6;margin-bottom:2px;">Chats</div>
          <div style="background:rgba(255,255,255,0.05);padding:2px 4px;border-radius:3px;margin-bottom:2px;">📱 Group Chat</div>
          <div style="padding:2px 4px;">👤 Private</div>
        </div>
        <div style="width:65%;padding-left:4px;">
          <div style="font-weight:600;margin-bottom:4px;">Group Chat</div>
          <div style="opacity:0.7;font-size:10px;">Alice: Hello there!</div>
          <div style="opacity:0.7;font-size:10px;">Bob: How are you?</div>
        </div>
      </div>
    </div>`,
    generateHtml: (props) => `
      <div class="dash-card" id="widget-${props.id}" style="height:100%;display:flex;flex-direction:column;">
        <div class="dash-card-head" style="flex-shrink:0;">
          <span class="dash-card-title">${props.title || 'Telegram'}</span>
          <span class="dash-card-badge" id="${props.id}-badge" style="display:none;">0</span>
        </div>
        <div id="${props.id}-container" style="flex:1;display:flex;overflow:hidden;min-height:0;"></div>
      </div>
    `,
```

Note: `generateJs` will be added in Task 5. For now, add a placeholder:

```js
    generateJs: (props) => `
      // Telegram widget JS — placeholder
      console.log('Telegram widget loaded: ${props.id}');
    `
  },
```

**Step 2: Verify the widget appears in the builder**

Run:
```bash
node server.cjs
```

Open `http://127.0.0.1:8080` in browser. The Telegram widget should appear in the widget picker under "large" category. It should render the preview and be draggable onto the canvas.

**Step 3: Commit**

```bash
git add js/widgets.js
git commit -m "feat(telegram): add widget HTML structure and preview"
```

---

### Task 5: Widget client JS logic

**Files:**
- Modify: `js/widgets.js` — replace the `generateJs` placeholder from Task 4

This is the largest task. The `generateJs` function returns a template literal string containing all the client-side JavaScript for the widget. It must:
1. Build the responsive two-pane / single-pane layout using `createElement`
2. Fetch chat list from `/api/telegram/chats`
3. Connect to `/api/telegram/stream` (SSE)
4. Render messages when a chat is selected
5. Handle send (text) and upload (file) actions
6. Auto-scroll on new messages
7. Use ResizeObserver for responsive breakpoint switching

**Step 1: Write the full generateJs**

Replace the placeholder `generateJs` in the telegram widget with the complete implementation. This is a long function. Key sections:

**a) DOM structure builder** — creates chatListPanel, messagePanel, composer bar, all using `createElement` + `textContent` (never innerHTML).

**b) Chat list renderer** — fetches `/api/telegram/chats`, creates elements for each chat. Groups with `is_forum` type get expandable topic sub-items.

**c) Message renderer** — fetches `/api/telegram/messages?chat_id=X(&topic_id=Y)`, creates message bubbles with sender name, timestamp, text.

**d) Send handler** — POST to `/api/telegram/send` with JSON body.

**e) Upload handler** — hidden file input, FormData POST to `/api/telegram/upload`.

**f) SSE connection** — EventSource to `/api/telegram/stream`, appends new messages to the current chat view.

**g) ResizeObserver** — toggles between side-by-side (>=400px) and single-pane (<400px) modes.

The full code for generateJs (all createElement-based, no innerHTML):

```js
    generateJs: (props) => `
      (function() {
        const container = document.getElementById('${props.id}-container');
        const badge = document.getElementById('${props.id}-badge');
        if (!container) return;

        let currentChatId = null;
        let currentTopicId = null;
        let isSmallMode = false;
        let chatData = [];

        // ── Build DOM structure ──
        const chatListPanel = document.createElement('div');
        chatListPanel.style.cssText = 'width:35%;min-width:120px;border-right:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;overflow:hidden;';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search chats...';
        searchInput.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:inherit;font-size:12px;margin:6px;width:calc(100% - 12px);outline:none;';

        const chatListEl = document.createElement('div');
        chatListEl.style.cssText = 'flex:1;overflow-y:auto;';

        chatListPanel.appendChild(searchInput);
        chatListPanel.appendChild(chatListEl);

        const messagePanel = document.createElement('div');
        messagePanel.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;';

        const msgHeader = document.createElement('div');
        msgHeader.style.cssText = 'padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.1);font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;flex-shrink:0;';

        const backBtn = document.createElement('button');
        backBtn.textContent = '←';
        backBtn.style.cssText = 'background:none;border:none;color:inherit;font-size:16px;cursor:pointer;padding:0 4px;display:none;';
        backBtn.addEventListener('click', () => showChatList());

        const headerTitle = document.createElement('span');
        headerTitle.textContent = 'Select a chat';

        msgHeader.appendChild(backBtn);
        msgHeader.appendChild(headerTitle);

        const msgList = document.createElement('div');
        msgList.style.cssText = 'flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:4px;';

        const composer = document.createElement('div');
        composer.style.cssText = 'padding:6px;border-top:1px solid rgba(255,255,255,0.1);display:flex;gap:4px;align-items:center;flex-shrink:0;';

        const attachBtn = document.createElement('button');
        attachBtn.textContent = '📎';
        attachBtn.style.cssText = 'background:none;border:none;font-size:16px;cursor:pointer;padding:2px;';
        attachBtn.title = 'Upload file';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.style.display = 'none';

        const msgInput = document.createElement('input');
        msgInput.type = 'text';
        msgInput.placeholder = 'Type a message...';
        msgInput.style.cssText = 'flex:1;padding:6px 10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;color:inherit;font-size:12px;outline:none;';

        const sendBtn = document.createElement('button');
        sendBtn.textContent = '➤';
        sendBtn.style.cssText = 'background:#2AABEE;border:none;color:white;border-radius:50%;width:28px;height:28px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;';

        composer.appendChild(attachBtn);
        composer.appendChild(fileInput);
        composer.appendChild(msgInput);
        composer.appendChild(sendBtn);

        messagePanel.appendChild(msgHeader);
        messagePanel.appendChild(msgList);
        messagePanel.appendChild(composer);

        container.appendChild(chatListPanel);
        container.appendChild(messagePanel);

        // ── Responsive layout ──
        function updateLayout() {
          const w = container.offsetWidth;
          const small = w < 400;
          if (small === isSmallMode) return;
          isSmallMode = small;
          if (small) {
            chatListPanel.style.width = '100%';
            chatListPanel.style.borderRight = 'none';
            if (currentChatId) {
              chatListPanel.style.display = 'none';
              messagePanel.style.display = 'flex';
            } else {
              chatListPanel.style.display = 'flex';
              messagePanel.style.display = 'none';
            }
            backBtn.style.display = 'block';
          } else {
            chatListPanel.style.width = '35%';
            chatListPanel.style.borderRight = '1px solid rgba(255,255,255,0.1)';
            chatListPanel.style.display = 'flex';
            messagePanel.style.display = 'flex';
            backBtn.style.display = 'none';
          }
        }

        const ro = new ResizeObserver(() => updateLayout());
        ro.observe(container);

        function showChatList() {
          if (isSmallMode) {
            chatListPanel.style.display = 'flex';
            messagePanel.style.display = 'none';
          }
          currentChatId = null;
          currentTopicId = null;
          highlightActive();
        }

        function showMessages() {
          if (isSmallMode) {
            chatListPanel.style.display = 'none';
            messagePanel.style.display = 'flex';
          }
        }

        // ── Chat list ──
        function renderChatList(filter) {
          while (chatListEl.firstChild) chatListEl.removeChild(chatListEl.firstChild);
          const filtered = filter ? chatData.filter(c => c.title.toLowerCase().includes(filter.toLowerCase())) : chatData;
          for (const chat of filtered) {
            const item = document.createElement('div');
            item.style.cssText = 'padding:8px 10px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid rgba(255,255,255,0.05);';
            item.dataset.chatId = chat.id;
            item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.05)'; });
            item.addEventListener('mouseleave', () => { if (String(currentChatId) !== String(chat.id)) item.style.background = 'none'; });

            if (${props.showAvatars !== 'false'}) {
              const avatar = document.createElement('div');
              const initial = chat.title ? chat.title.charAt(0).toUpperCase() : '?';
              avatar.textContent = initial;
              const colors = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F'];
              const colorIdx = Math.abs(chat.id) % colors.length;
              avatar.style.cssText = 'width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:14px;flex-shrink:0;background:' + colors[colorIdx] + ';color:#000;';
              item.appendChild(avatar);
            }

            const info = document.createElement('div');
            info.style.cssText = 'flex:1;min-width:0;';
            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            titleEl.textContent = (chat.type === 'supergroup' || chat.type === 'group' ? '👥 ' : '👤 ') + chat.title;
            const preview = document.createElement('div');
            preview.style.cssText = 'font-size:11px;opacity:0.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            preview.textContent = chat.lastMessage || 'No messages';
            info.appendChild(titleEl);
            info.appendChild(preview);
            item.appendChild(info);

            item.addEventListener('click', () => selectChat(chat.id, null));
            chatListEl.appendChild(item);

            // Forum topics as sub-items
            if (chat.topics && chat.topics.length > 0) {
              for (const topic of chat.topics) {
                const topicEl = document.createElement('div');
                topicEl.style.cssText = 'padding:5px 10px 5px 40px;cursor:pointer;font-size:11px;opacity:0.7;border-bottom:1px solid rgba(255,255,255,0.03);';
                topicEl.textContent = '💬 ' + topic.name;
                topicEl.addEventListener('mouseenter', () => { topicEl.style.opacity = '1'; topicEl.style.background = 'rgba(255,255,255,0.03)'; });
                topicEl.addEventListener('mouseleave', () => { topicEl.style.opacity = '0.7'; topicEl.style.background = 'none'; });
                topicEl.addEventListener('click', (e) => { e.stopPropagation(); selectChat(chat.id, topic.id); });
                chatListEl.appendChild(topicEl);
              }
            }
          }
          highlightActive();
        }

        function highlightActive() {
          const items = chatListEl.querySelectorAll('[data-chat-id]');
          items.forEach(el => {
            el.style.background = String(el.dataset.chatId) === String(currentChatId) ? 'rgba(42,171,238,0.15)' : 'none';
          });
        }

        searchInput.addEventListener('input', () => renderChatList(searchInput.value));

        // ── Messages ──
        async function selectChat(chatId, topicId) {
          currentChatId = chatId;
          currentTopicId = topicId;
          showMessages();
          highlightActive();

          const chat = chatData.find(c => String(c.id) === String(chatId));
          let title = chat ? chat.title : 'Chat';
          if (topicId && chat) {
            const topic = chat.topics.find(t => t.id === topicId);
            if (topic) title = chat.title + ' › ' + topic.name;
          }
          headerTitle.textContent = title;

          while (msgList.firstChild) msgList.removeChild(msgList.firstChild);
          const loadingEl = document.createElement('div');
          loadingEl.textContent = 'Loading messages...';
          loadingEl.style.cssText = 'text-align:center;opacity:0.5;padding:20px;font-size:12px;';
          msgList.appendChild(loadingEl);

          try {
            let url = '/api/telegram/messages?chat_id=' + chatId + '&limit=${props.messageLimit || 100}';
            if (topicId) url += '&topic_id=' + topicId;
            const resp = await fetch(url);
            const data = await resp.json();
            while (msgList.firstChild) msgList.removeChild(msgList.firstChild);
            if (data.messages) {
              for (const msg of data.messages) appendMessage(msg);
            }
            msgList.scrollTop = msgList.scrollHeight;
          } catch (e) {
            while (msgList.firstChild) msgList.removeChild(msgList.firstChild);
            const errEl = document.createElement('div');
            errEl.textContent = 'Failed to load messages';
            errEl.style.cssText = 'text-align:center;color:#ff6b6b;padding:20px;font-size:12px;';
            msgList.appendChild(errEl);
          }
        }

        function appendMessage(msg) {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:6px;align-items:flex-start;';

          if (${props.showAvatars !== 'false'}) {
            const av = document.createElement('div');
            const name = msg.from ? (msg.from.first_name || msg.from.username || '?') : '?';
            av.textContent = name.charAt(0).toUpperCase();
            const colors = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F'];
            const colorIdx = Math.abs(msg.from ? msg.from.id : 0) % colors.length;
            av.style.cssText = 'width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0;background:' + colors[colorIdx] + ';color:#000;';
            row.appendChild(av);
          }

          const bubble = document.createElement('div');
          bubble.style.cssText = 'flex:1;min-width:0;';
          const meta = document.createElement('div');
          meta.style.cssText = 'display:flex;align-items:baseline;gap:6px;margin-bottom:1px;';
          const senderEl = document.createElement('span');
          senderEl.style.cssText = 'font-weight:600;font-size:11px;color:#2AABEE;';
          senderEl.textContent = msg.from ? (msg.from.first_name || msg.from.username || 'Unknown') : 'System';
          const timeEl = document.createElement('span');
          timeEl.style.cssText = 'font-size:10px;opacity:0.4;';
          const d = new Date(msg.date * 1000);
          timeEl.textContent = d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
          meta.appendChild(senderEl);
          meta.appendChild(timeEl);
          bubble.appendChild(meta);

          const textEl = document.createElement('div');
          textEl.style.cssText = 'font-size:12px;word-break:break-word;';
          if (msg.text) {
            textEl.textContent = msg.text;
          } else if (msg.document) {
            textEl.textContent = '📎 ' + (msg.document.file_name || 'Document');
          } else if (msg.photo) {
            textEl.textContent = '🖼 Photo';
          } else if (msg.sticker) {
            textEl.textContent = msg.sticker.emoji || '🏷 Sticker';
          } else if (msg.voice) {
            textEl.textContent = '🎤 Voice message';
          } else if (msg.video) {
            textEl.textContent = '🎥 Video';
          } else {
            textEl.textContent = '[unsupported message type]';
          }
          if (msg.caption) {
            const capEl = document.createElement('div');
            capEl.style.cssText = 'font-size:11px;opacity:0.7;margin-top:2px;';
            capEl.textContent = msg.caption;
            bubble.appendChild(capEl);
          }
          bubble.appendChild(textEl);
          row.appendChild(bubble);
          msgList.appendChild(row);
        }

        // ── Send message ──
        async function sendMessage() {
          const text = msgInput.value.trim();
          if (!text || !currentChatId) return;
          msgInput.value = '';
          try {
            const body = { chat_id: currentChatId, text: text };
            if (currentTopicId) body.topic_id = currentTopicId;
            await fetch('/api/telegram/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
          } catch (e) { console.error('Send failed:', e); }
        }

        sendBtn.addEventListener('click', sendMessage);
        msgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

        // ── File upload ──
        attachBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files[0];
          if (!file || !currentChatId) return;
          const fd = new FormData();
          fd.append('chat_id', currentChatId);
          fd.append('file', file);
          if (currentTopicId) fd.append('topic_id', currentTopicId);
          try {
            await fetch('/api/telegram/upload', { method: 'POST', body: fd });
          } catch (e) { console.error('Upload failed:', e); }
          fileInput.value = '';
        });

        // ── SSE real-time ──
        let evtSource = null;
        function connectSSE() {
          if (evtSource) evtSource.close();
          evtSource = new EventSource('/api/telegram/stream');
          evtSource.onmessage = (event) => {
            try {
              const payload = JSON.parse(event.data);
              if (payload.type === 'message' && payload.message) {
                // Update chat list data
                const existing = chatData.find(c => String(c.id) === String(payload.chatId));
                if (existing) {
                  existing.lastMessage = payload.message.text || '[media]';
                  existing.lastMessageDate = payload.message.date;
                  existing.messageCount++;
                }
                // Append to current view if matching
                if (String(payload.chatId) === String(currentChatId)) {
                  const topicMatch = !currentTopicId || payload.message.message_thread_id === currentTopicId;
                  if (topicMatch) {
                    appendMessage(payload.message);
                    msgList.scrollTop = msgList.scrollHeight;
                  }
                }
                // Refresh chat list order
                chatData.sort((a, b) => b.lastMessageDate - a.lastMessageDate);
                renderChatList(searchInput.value);
              }
            } catch (e) {}
          };
          evtSource.onerror = () => {
            evtSource.close();
            setTimeout(connectSSE, 5000);
          };
        }

        // ── Initial load ──
        async function loadChats() {
          try {
            const resp = await fetch('/api/telegram/chats');
            chatData = await resp.json();
            renderChatList('');
          } catch (e) {
            const errEl = document.createElement('div');
            errEl.textContent = 'Failed to load chats';
            errEl.style.cssText = 'padding:10px;color:#ff6b6b;font-size:12px;text-align:center;';
            chatListEl.appendChild(errEl);
          }
        }

        loadChats();
        connectSSE();
        updateLayout();

        // Poll for new chats periodically
        setInterval(async () => {
          try {
            const resp = await fetch('/api/telegram/chats');
            chatData = await resp.json();
            renderChatList(searchInput.value);
          } catch (e) {}
        }, ${(props.pollInterval || 30) * 1000});
      })();
    `
  },
```

**Step 2: Test the widget end-to-end**

1. Set `TELEGRAM_BOT_TOKEN` in `.env` (production dir or run locally with env var)
2. Run: `TELEGRAM_BOT_TOKEN=<token> node server.cjs`
3. Open `http://127.0.0.1:8080` in browser
4. Add Telegram widget to canvas
5. Send a message to the bot via Telegram app — it should appear in the widget chat list
6. Click a chat — messages should load
7. Type a reply and press Enter or click send — it should send via bot
8. Resize widget below 400px — should switch to single-pane mode with back button

**Step 3: Commit**

```bash
git add js/widgets.js
git commit -m "feat(telegram): add full widget client JS with responsive UI"
```

---

### Task 6: End-to-end test and polish

**Files:**
- Modify: `server.cjs` (bug fixes as found)
- Modify: `js/widgets.js` (UI tweaks as found)

**Step 1: Test all features**

Test matrix:
- [ ] Widget loads and shows "Select a chat" in message pane
- [ ] Chat list populates after receiving messages via Telegram
- [ ] Click chat → messages load with sender, time, text
- [ ] Send text message via composer → appears in Telegram
- [ ] Upload file via attachment button → sends document in Telegram
- [ ] SSE real-time: new messages appear without refresh
- [ ] Responsive: widget below 400px shows single pane with back button
- [ ] Responsive: widget above 400px shows side-by-side panels
- [ ] Search/filter input filters chat list
- [ ] Forum topics appear as indented sub-items under groups
- [ ] Click topic → shows only messages from that topic
- [ ] No innerHTML usage anywhere (hook compliance)
- [ ] Server starts cleanly without TELEGRAM_BOT_TOKEN (warning only, no crash)

**Step 2: Fix any issues found during testing**

Apply fixes iteratively. Each fix gets its own commit.

**Step 3: Commit any remaining fixes**

```bash
git add server.cjs js/widgets.js
git commit -m "fix(telegram): polish and bug fixes from e2e testing"
```

---

### Task 7: Final commit and push

**Files:**
- None new — just git operations

**Step 1: Review all changes**

```bash
git log --oneline feature/telegram-widget ^main
git diff main..feature/telegram-widget --stat
```

**Step 2: Push to fork**

```bash
git push fork feature/telegram-widget
```

**Step 3: Deploy to production (optional — user decides)**

```bash
rsync -a --exclude='.git' --exclude='.claude' --exclude='node_modules' \
  --exclude='config.json' --exclude='todos.json' --exclude='notes.json' \
  --exclude='auth.json' --exclude='secrets.json' --exclude='data' \
  --exclude='.env' --exclude='.openclaw-device-identity.json' \
  ./ /Users/douglasjerum/lobsterboard/

# Add TELEGRAM_BOT_TOKEN to ~/lobsterboard/.env manually
# Then install the new dependency:
cd ~/lobsterboard && npm install

# Restart:
launchctl kickstart -k gui/$(id -u)/com.lobsterboard.server
```
