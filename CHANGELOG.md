# Changelog

## [0.3.1] - 2026-02-28

### Fixed
- **Edit mode header clutter** — page navigation links now hide when entering edit mode to reduce header crowding

## [0.3.0] - 2026-02-28

### Added
- **Theme switcher** — 5 themes: Default (dark), Feminine (pastel pink/lavender), Feminine Dark, Terminal (green CRT), Paper (cream/sepia)
- **Phosphor icon system** — themed widgets use Phosphor icons; Default theme keeps emoji
- **Theme selector dropdown** in edit mode header
- Theme persists to localStorage and dashboard config

## [0.2.5] - 2026-02-19

### Fixed
- **iCal timezone parsing** — calendar events now display at correct times regardless of timezone (TZID parameter support) — thanks @jlgrimes!

### Added
- **Clickable URLs in calendar** — Zoom/Teams links in event summaries and locations are now hyperlinks — thanks @jlgrimes!

## [0.2.4] - 2026-02-17

### Fixed
- SSRF vulnerability in RSS feed proxy (thanks @jlgrimes for the security report!)

## [0.2.3] - 2026-02-16

### Added
- **PIN-locked edit mode** — set a 4-6 digit PIN to prevent unauthorized editing (SHA-256 hashed, server-side only)
- **Server-side secrets store** — API keys, calendar URLs, and tokens stored in `secrets.json`, never sent to browser
- **Public Mode** — hides edit button and blocks config APIs; subtle 🔒 unlock button for admin access
- **Privacy warnings** on sensitive widgets (System Log, Activity List, Cron Jobs, Calendar, Todo List) — ⚠️ badge in widget panel + orange warning in properties panel
- **Community Widgets** — contribution guide, templates, and PR checklist for community widget submissions

### Fixed
- Private calendar URLs (Google Calendar, iCloud CalDAV) no longer leak in template exports
- Template export `stripSensitive()` now detects URLs with auth tokens
- Public mode toggle uses masked PIN modal instead of plain-text `prompt()`
- `closePinModal()` no longer kills pending callbacks

### Security
- `auth.json` and `secrets.json` added to `.gitignore`
- Pre-commit hook blocks private data patterns in template files

## [0.2.2] - 2026-02-16

### Fixed
- Removed private Google Calendar URL accidentally included in template config
- Fixed `stripSensitive()` to detect and blank URLs with embedded auth tokens

## [0.2.1] - 2026-02-15

### Fixed
- Minor bug fixes and stability improvements

## [0.2.0] - 2026-02-15

### Added
- **Template Gallery** — export, import, and share dashboard layouts with auto-screenshot previews
  - `js/templates.js` — new template gallery UI and export system
  - Templates API: list, get, preview, import (merge/replace), export, delete
  - `templates/` directory with bundled starter templates
  - Template modal with search, preview lightbox, and import options
- **Notes widget** — persistent rich-text notes with auto-save via `/api/notes`
- **Browse button** for directory selection in image widgets (Image, Random Image, Latest Image)
- **GitHub Stats widget rework** — profile contributions, stars, and activity with property bindings
- **LobsterBoard Release widget** — version update checker via `/api/lb-release`
- **SSE streaming** for system stats (`/api/stats/stream`)
- **Browse directories API** (`/api/browse-dirs`) for server-side directory picker
- Sidebar reorder, verified checkmarks, delete button, tooltips in editor
- html2canvas-based dashboard screenshot export
- Scrollable canvas mode

### Changed
- Stock Ticker widget — fixed `hasApiKey` check
- Builder — contenteditable keyboard fix, null-checks throughout
- License changed from MIT to BSL-1.1
- Widget count: 47 → 50

### Removed
- GPT Usage widget (standalone) — use AI Cost Tracker or Claude Usage instead

## [0.1.6] - 2025-02-14

- Initial public npm release
- 47 widgets, drag-and-drop editor, custom pages system
- SSRF protection for proxy endpoints
