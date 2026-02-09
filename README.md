# 🦞 LobsterBoard

A drag-and-drop dashboard builder for creating beautiful, customizable status boards.

![LobsterBoard](lobsterboard-logo-final.png)

## Features

- **Visual Builder**: Drag and drop widgets onto a grid
- **47+ Widgets**: Weather, clocks, system stats, AI usage, and more
- **Dark Theme**: Easy on the eyes, perfect for always-on displays
- **Export to HTML**: Single-file dashboards that run anywhere
- **No Backend Required**: Many widgets work with just a browser

## Quick Start

1. Open `index.html` in your browser
2. Drag widgets from the sidebar onto the canvas
3. Click widgets to edit their properties
4. Click **Export Dashboard** to download your dashboard

## Widget Categories

### ✅ Works Out of Box (No API Needed)
These widgets work immediately with no configuration:
- Weather (wttr.in)
- Clock, World Clock
- Countdown, Pomodoro Timer
- Images (local, web, random rotation)
- Quick Links
- Iframe Embed
- Release Tracker (GitHub public API)

### 🦞 OpenClaw Widgets
These widgets connect to a running [OpenClaw](https://github.com/openclaw/openclaw) gateway:
- Auth Status
- OpenClaw Release
- Activity List
- Cron Jobs
- System Log
- Session Count
- Token Gauge

**See [Using OpenClaw Widgets](#using-openclaw-widgets) below.**

### 🔑 API Key Required
These widgets need you to provide an API key:
- News Ticker (NewsAPI)
- Stock Ticker (Finnhub)
- GitHub Stats (optional, for higher rate limits)

### ⚠️ Custom Backend Required
These widgets need custom API endpoints:
- AI Usage (Claude, GPT, Gemini)
- CPU/Memory, Disk Usage
- Docker Containers
- And more...

---

## Using OpenClaw Widgets

OpenClaw widgets fetch data from your local OpenClaw gateway. Due to browser CORS restrictions, you need to either:

### Option A: Use the Included Server (Recommended)

The server proxies API requests to OpenClaw, solving CORS issues.

1. **Export your dashboard** from the builder (Download button)

2. **Extract the ZIP** to a folder

3. **`server.js` is included** in the exported ZIP

4. **Run the server**:
   ```bash
   cd your-dashboard-folder
   node server.js
   ```

5. **Open** http://localhost:8080 in your browser

**Configuration** (environment variables):
```bash
# Custom port for the dashboard server
PORT=3000 node server.js

# Custom OpenClaw gateway URL (if not on default port 18789)
OPENCLAW_URL=http://localhost:YOUR_PORT node server.js

# Expose to network (⚠️ only on trusted networks!)
HOST=0.0.0.0 node server.js
```

> **⚠️ Non-Default Gateway Port?**
> 
> If your OpenClaw gateway runs on a port other than `18789` (the default), you **must** set the `OPENCLAW_URL` environment variable. Check your gateway port:
> ```bash
> grep '"port"' ~/.openclaw/openclaw.json
> ```
> Then start the server with:
> ```bash
> OPENCLAW_URL=http://localhost:YOUR_PORT node server.js
> ```

### Option B: Run OpenClaw with CORS Headers

If you control your OpenClaw config, you can add CORS headers directly.

---

## Exporting Dashboards

1. Click the **💾 Export** button in the toolbar
2. Choose **Download Dashboard**
3. A ZIP file is created containing:
   - `index.html` - Your complete dashboard
   - `server.js` - Server for OpenClaw widgets (optional)
   - Any embedded images

The exported HTML is self-contained and can be:
- Opened directly in a browser (for non-API widgets)
- Served via the included Node.js server
- Hosted on any static web server

---

## Development

### File Structure
```
dashboard-builder/
├── index.html          # Main builder UI
├── css/
│   └── styles.css      # Dashboard styles
├── js/
│   ├── builder.js      # Builder logic
│   └── widgets.js      # Widget definitions
├── server.js    # Node.js server for exports
└── WIDGETS-STATUS.md   # Widget verification status
```

### Adding New Widgets

See `js/widgets.js` for widget definitions. Each widget has:
- `name`, `icon`, `category`
- `description` - Shows in properties panel
- `defaultWidth`, `defaultHeight`
- `properties` - Configurable options
- `generateHtml()` - Returns widget HTML
- `generateJs()` - Returns widget JavaScript

---

## License

MIT

---

Made with 🦞 by the LobsterBoard team
