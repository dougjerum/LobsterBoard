# LobsterBoard TODO

## 🏗️ Architecture Ideas

### Head Widgets
Full-width widgets that span across the top of the page, above the main grid.
- Good for: market tickers, search bars, notification banners
- Implementation: separate render zone above main canvas
- Source: Glance dashboard

### Group Widget (Tabs)
Combine multiple widgets into a single tabbed container.
- Switch between widgets without taking more space
- Example: Reddit + HN + Lobsters in one widget with tabs
- Source: Glance dashboard

---

## 📊 Widget Ideas (from Glance)

### High Priority

- [ ] **Markets Widget**
  Stock/crypto ticker. Shows symbol, price, up/down with colors.
  Could be a head widget spanning full width.
  API: Yahoo Finance, Finnhub, or similar

- [ ] **Search Widget with Bangs**
  Search box with DuckDuckGo-style shortcuts.
  `!yt` → YouTube, `!gh` → GitHub, `!r` → Reddit
  Keyboard: `S` to focus, `↑` for last query
  Pure frontend, no API needed

- [ ] **Custom API Widget**
  Generic widget that fetches any JSON API and renders via template.
  User provides URL + template string.
  Unlocks infinite possibilities without new widget code.

- [ ] **DNS Stats (Pi-hole/AdGuard)**
  Blocked queries, total queries, % blocked, top blocked domains.
  API: Pi-hole Admin API or AdGuard Home API

- [ ] **Docker Containers**
  List running containers with status indicators (running/stopped/error).
  API: Docker socket or Portainer API

- [ ] **ChangeDetection.io**
  Shows tracked websites and recent changes.
  API: ChangeDetection.io REST API

### Medium Priority

- [ ] **Repository Widget**
  GitHub repo stats: stars, forks, open issues, last release, last commit.
  API: GitHub REST API (public, optional token for rate limits)

- [ ] **Twitch Channels**
  Live status, viewer counts for followed channels.
  API: Twitch Helix API (requires client ID)

- [ ] **Twitch Top Games**
  Current top games by viewership.
  API: Twitch Helix API

- [ ] **Videos Widget (YouTube)**
  Latest videos from subscribed channels.
  Supports custom frontend URLs (Invidious).
  API: YouTube RSS feeds (no API key needed) or Data API

- [ ] **Calendar Widget**
  Visual calendar with upcoming events.
  API: iCal feeds (Google, iCloud, Outlook)
  Note: Already have calendar access via OpenClaw, needs visual widget

- [ ] **RSS Feed Widget**
  Multiple display styles: vertical list, horizontal cards, detailed list.
  Aggregates multiple feeds.
  Needs CORS proxy (server already has one)

---

## 🎨 Rainmeter Ideas (NEEDS RE-RESEARCH)

Previous research from 2026-02-14 documented 25 widget ideas from Rainmeter skins.
File was lost (`lobsterboard-dev/WIDGET-IDEAS.md`).

**TODO:** Re-research popular Rainmeter skins and extract widget ideas:
- [ ] Browse DeviantArt Rainmeter section
- [ ] Check r/Rainmeter top posts
- [ ] Look at: Honeycomb, SUSPENDED, Elegance2, Mond, Fountain of Colors
- [ ] Focus on: visualizers, system monitors, launchers, info displays

---

## 🔧 Existing Widget Improvements

See `WIDGETS-STATUS.md` for current widget status and pending backends.

---

## 📝 Notes

- Skip Split Column layout — LobsterBoard already has flexible widget sizing/placement
- Icon libraries to consider: Simple Icons (`si:`), Material Design (`mdi:`), Dashboard Icons (`di:`)
- Glance source: https://github.com/glanceapp/glance/blob/main/docs/configuration.md
