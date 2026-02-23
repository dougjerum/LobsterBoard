/**
 * LobsterBoard Builder Server
 * 
 * A simple server to:
 * - Serve builder static files
 * - Handle loading and saving of config.json for the builder
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const si = require('systeminformation');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '127.0.0.1';

// ─────────────────────────────────────────────
// OpenClaw WebSocket RPC Client
// Connects to OpenClaw gateway over SSH tunnel
// ─────────────────────────────────────────────
const OC_WS_URL = process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789';
let OC_TOKEN = process.env.OPENCLAW_TOKEN || '';
const OC_IDENTITY_FILE = path.join(__dirname, '.openclaw-device-identity.json');
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function _b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function _ocLoadIdentity() {
  try {
    const data = JSON.parse(fs.readFileSync(OC_IDENTITY_FILE, 'utf8'));
    if (data.deviceId && data.publicKeyPem && data.privateKeyPem) {
      const pub = crypto.createPublicKey(data.publicKeyPem);
      const spki = pub.export({ type: 'spki', format: 'der' });
      data.rawPubKeyBase64Url = _b64url(spki.subarray(ED25519_SPKI_PREFIX.length));
      return data;
    }
  } catch {}
  return null;
}

function _ocBuildAuthPayload(p) {
  const v = p.nonce ? 'v2' : 'v1';
  const base = [v, p.deviceId, p.clientId, p.clientMode, p.role, p.scopes.join(','), String(p.signedAtMs), p.token || ''];
  if (v === 'v2') base.push(p.nonce || '');
  return base.join('|');
}

function _ocSign(privPem, payload) {
  return _b64url(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privPem)));
}

const _ocIdentity = _ocLoadIdentity();
// Fall back to deviceToken from identity file if env var not set
if (!OC_TOKEN && _ocIdentity && _ocIdentity.deviceToken) {
  OC_TOKEN = _ocIdentity.deviceToken;
}
let _ocWs = null;
let _ocAuthenticated = false;
let _ocPending = new Map(); // id -> { resolve, timer }
let _ocReconnectTimer = null;

function ocConnect() {
  if (!_ocIdentity || !OC_TOKEN) {
    console.log('[openclaw] No identity or token — WS client disabled');
    return;
  }
  if (_ocWs) return;

  try {
    _ocWs = new WebSocket(OC_WS_URL, { headers: { 'Origin': 'http://127.0.0.1:18789' } });
  } catch (e) {
    console.log('[openclaw] WS connect error:', e.message);
    _ocScheduleReconnect();
    return;
  }

  _ocWs.on('open', () => console.log('[openclaw] WS connected'));

  _ocWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Handle challenge → send connect with device identity
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const role = 'operator';
      const clientId = 'webchat-ui';
      const clientMode = 'ui';
      const scopes = ['operator.admin', 'operator.approvals', 'operator.pairing'];
      const signedAtMs = Date.now();
      const nonce = msg.payload?.nonce;
      const payload = _ocBuildAuthPayload({ deviceId: _ocIdentity.deviceId, clientId, clientMode, role, scopes, signedAtMs, token: OC_TOKEN, nonce });
      const signature = _ocSign(_ocIdentity.privateKeyPem, payload);
      _ocWs.send(JSON.stringify({
        type: 'req', id: crypto.randomUUID(), method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: clientId, displayName: 'LobsterBoard', version: '1.0.0', platform: 'darwin', mode: clientMode, instanceId: crypto.randomUUID() },
          role, scopes, caps: [],
          auth: { token: OC_TOKEN },
          device: { id: _ocIdentity.deviceId, publicKey: _ocIdentity.rawPubKeyBase64Url, signature, signedAt: signedAtMs, nonce },
          userAgent: 'LobsterBoard/1.0', locale: 'en-US'
        }
      }));
      return;
    }

    // Handle connect response
    if (msg.type === 'res' && !_ocAuthenticated) {
      if (msg.ok) {
        _ocAuthenticated = true;
        console.log('[openclaw] Authenticated — scopes:', msg.payload?.auth?.scopes?.join(', '));
      } else {
        console.log('[openclaw] Connect failed:', msg.error?.message || JSON.stringify(msg.error));
      }
      return;
    }

    // Handle RPC responses
    if (msg.type === 'res') {
      const p = _ocPending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        _ocPending.delete(msg.id);
        p.resolve(msg);
      }
    }
  });

  _ocWs.on('close', () => {
    console.log('[openclaw] WS closed');
    _ocCleanup();
    _ocScheduleReconnect();
  });

  _ocWs.on('error', (e) => {
    console.log('[openclaw] WS error:', e.message);
    _ocCleanup();
    _ocScheduleReconnect();
  });
}

function _ocCleanup() {
  _ocAuthenticated = false;
  _ocWs = null;
  // Reject all pending requests
  for (const [, p] of _ocPending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, error: { message: 'connection lost' } });
  }
  _ocPending.clear();
}

function _ocScheduleReconnect() {
  if (_ocReconnectTimer) return;
  _ocReconnectTimer = setTimeout(() => {
    _ocReconnectTimer = null;
    ocConnect();
  }, 5000);
}

/** Send an RPC request to OpenClaw, returns a promise that resolves to the response */
function ocRpc(method, params = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (!_ocWs || !_ocAuthenticated) {
      resolve({ ok: false, error: { message: 'not connected' } });
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      _ocPending.delete(id);
      resolve({ ok: false, error: { message: 'timeout' } });
    }, timeoutMs);
    _ocPending.set(id, { resolve, timer });
    try {
      _ocWs.send(JSON.stringify({ type: 'req', id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      _ocPending.delete(id);
      resolve({ ok: false, error: { message: e.message } });
    }
  });
}

// Boot the OpenClaw WS client
ocConnect();

// ─────────────────────────────────────────────
// Pages System — auto-discovery and mounting
// ─────────────────────────────────────────────
const PAGES_DIR = path.join(__dirname, 'pages');
const PAGES_JSON = path.join(__dirname, 'pages.json');
const DATA_DIR = path.join(__dirname, 'data');

let loadedPages = []; // { id, title, icon, description, order, routes: { 'METHOD /path': handler } }

function loadPages() {
  const pages = [];
  let overrides = { pages: {} };
  try { overrides = JSON.parse(fs.readFileSync(PAGES_JSON, 'utf8')); } catch (_) {}

  let dirs;
  try { dirs = fs.readdirSync(PAGES_DIR); } catch (_) { return pages; }

  for (const dir of dirs) {
    if (dir.startsWith('_')) continue;
    const metaPath = path.join(PAGES_DIR, dir, 'page.json');
    if (!fs.existsSync(metaPath)) continue;

    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { continue; }

    const override = overrides.pages[meta.id] || {};
    meta.enabled = override.enabled ?? meta.enabled ?? true;
    meta.order = override.order ?? meta.order ?? 99;

    if (!meta.enabled) continue;

    // Ensure data dir
    const dataDir = path.join(DATA_DIR, meta.id);
    fs.mkdirSync(dataDir, { recursive: true });

    // Load API routes if api.cjs (or api.js) exists
    let apiPath = path.join(PAGES_DIR, dir, 'api.cjs');
    if (!fs.existsSync(apiPath)) apiPath = path.join(PAGES_DIR, dir, 'api.js');
    let routes = {};
    if (fs.existsSync(apiPath)) {
      try {
        const ctx = {
          dataDir,
          readData: (filename) => JSON.parse(fs.readFileSync(path.join(dataDir, filename), 'utf8')),
          writeData: (filename, obj) => {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(path.join(dataDir, filename), JSON.stringify(obj, null, 2));
          }
        };
        const pageModule = require(apiPath)(ctx);
        routes = pageModule.routes || {};
      } catch (e) {
        console.error(`Error loading page API for ${meta.id}:`, e.message);
      }
    }

    pages.push({
      id: meta.id,
      title: meta.title,
      icon: meta.icon,
      description: meta.description,
      order: meta.order,
      nav: meta.nav !== false,
      routes
    });
  }

  return pages.sort((a, b) => a.order - b.order);
}

// Parse a route pattern like 'GET /items/:id' into a regex + param names
function compileRoute(pattern) {
  const [method, ...pathParts] = pattern.split(' ');
  const routePath = pathParts.join(' ');
  const paramNames = [];

  // Handle wildcard * segments
  let regexStr = routePath.replace(/\*/g, '(.+)').replace(/:([^/]+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });

  // Track if wildcard was used
  const hasWildcard = routePath.includes('*');
  if (hasWildcard && !paramNames.includes('*')) {
    // Insert wildcard param name at the position it appears
    const parts = routePath.split('/');
    let wildcardIdx = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '*') {
        paramNames.splice(wildcardIdx, 0, '*');
        break;
      }
      if (parts[i].startsWith(':')) wildcardIdx++;
      if (parts[i] === '*') break;
    }
  }

  return { method: method.toUpperCase(), regex: new RegExp('^' + regexStr + '$'), paramNames };
}

// Try to match a request against page routes
function matchPageRoute(pages, method, pathname, parsedUrl) {
  // Check /api/pages listing endpoint
  if (method === 'GET' && pathname === '/api/pages') {
    return { type: 'list' };
  }

  // Check /pages/<id> for static file serving
  const pagesMatch = pathname.match(/^\/pages\/([^/]+)(\/.*)?$/);
  if (pagesMatch) {
    const pageId = pagesMatch[1];
    if (pageId === '_shared') {
      return { type: 'static', filePath: path.join(PAGES_DIR, '_shared', (pagesMatch[2] || '/').slice(1)) };
    }
    const page = pages.find(p => p.id === pageId);
    if (page) {
      const subPath = pagesMatch[2] || '/';
      if (subPath === '/' || subPath === '') {
        return { type: 'static', filePath: path.join(PAGES_DIR, pageId, 'index.html') };
      }
      return { type: 'static', filePath: path.join(PAGES_DIR, pageId, subPath.slice(1)) };
    }
  }

  // Check /api/pages/<id>/* for API routes
  const apiMatch = pathname.match(/^\/api\/pages\/([^/]+)(\/.*)?$/);
  if (apiMatch) {
    const pageId = apiMatch[1];
    const page = pages.find(p => p.id === pageId);
    if (!page) return null;

    const subPath = apiMatch[2] || '/';
    const routeEntries = Object.entries(page.routes);

    // Sort routes: specific before wildcard, longer before shorter
    routeEntries.sort((a, b) => {
      const aHasWild = a[0].includes('*');
      const bHasWild = b[0].includes('*');
      if (aHasWild !== bHasWild) return aHasWild ? 1 : -1;
      return b[0].length - a[0].length;
    });

    for (const [pattern, handler] of routeEntries) {
      const compiled = compileRoute(pattern);
      if (compiled.method !== method) continue;
      const match = subPath.match(compiled.regex);
      if (match) {
        const params = {};
        compiled.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]);
        });
        const query = {};
        parsedUrl.searchParams.forEach((v, k) => { query[k] = v; });
        return { type: 'api', handler, params, query, pageId };
      }
    }
  }

  return null;
}

// Initialize pages
loadedPages = loadPages();
console.log(`📄 Loaded ${loadedPages.length} page(s): ${loadedPages.map(p => p.icon + ' ' + p.title).join(', ') || 'none'}`);

// ─────────────────────────────────────────────
// System Stats Collection (cached, tiered intervals)
// ─────────────────────────────────────────────
const cachedStats = {
  cpu: null,
  memory: null,
  disk: null,
  network: null,
  docker: null,
  uptime: null,
  timestamp: null
};

const sseClients = new Set();

function broadcastStats() {
  const payload = `data: ${JSON.stringify(cachedStats)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// Guard against overlapping async calls when si.* is slow
let _cpuNetRunning = false;
let _memRunning = false;
let _diskRunning = false;
let _dockerRunning = false;

// CPU + Network: every 2s
setInterval(async () => {
  if (_cpuNetRunning) return;
  _cpuNetRunning = true;
  try {
    const [cpu, net] = await Promise.all([
      si.currentLoad(),
      si.networkStats()
    ]);
    cachedStats.cpu = { currentLoad: cpu.currentLoad, cpus: cpu.cpus.map(c => c.load) };
    cachedStats.network = net.map(n => ({
      iface: n.iface, rx_sec: n.rx_sec, tx_sec: n.tx_sec,
      rx_bytes: n.rx_bytes, tx_bytes: n.tx_bytes
    }));
    cachedStats.timestamp = Date.now();
    broadcastStats();
  } catch (e) { console.error('Stats error (cpu/net):', e.message); }
  _cpuNetRunning = false;
}, 2000);

// Memory: every 5s
setInterval(async () => {
  if (_memRunning) return;
  _memRunning = true;
  try {
    const mem = await si.mem();
    cachedStats.memory = { total: mem.total, used: mem.used, free: mem.free, active: mem.active };
  } catch (e) { console.error('Stats error (mem):', e.message); }
  _memRunning = false;
}, 5000);

// Disk: every 30s
setInterval(async () => {
  if (_diskRunning) return;
  _diskRunning = true;
  try {
    const disk = await si.fsSize();
    cachedStats.disk = disk.map(d => ({
      fs: d.fs, mount: d.mount, size: d.size, used: d.used, available: d.available, use: d.use
    }));
  } catch (e) { console.error('Stats error (disk):', e.message); }
  _diskRunning = false;
}, 30000);

// Docker: every 5s (graceful fail)
setInterval(async () => {
  if (_dockerRunning) return;
  _dockerRunning = true;
  try {
    cachedStats.docker = await si.dockerContainers();
  } catch (_) { cachedStats.docker = []; }
  _dockerRunning = false;
}, 5000);

// Uptime: every 60s
setInterval(async () => {
  try {
    cachedStats.uptime = si.time().uptime;
  } catch (e) { console.error('Stats error (uptime):', e.message); }
}, 60000);

// Initial fetch
(async () => {
  try {
    const [cpu, mem, disk, net] = await Promise.all([
      si.currentLoad(), si.mem(), si.fsSize(), si.networkStats()
    ]);
    cachedStats.cpu = { currentLoad: cpu.currentLoad, cpus: cpu.cpus.map(c => c.load) };
    cachedStats.memory = { total: mem.total, used: mem.used, free: mem.free, active: mem.active };
    cachedStats.disk = disk.map(d => ({ fs: d.fs, mount: d.mount, size: d.size, used: d.used, available: d.available, use: d.use }));
    cachedStats.network = net.map(n => ({ iface: n.iface, rx_sec: n.rx_sec, tx_sec: n.tx_sec, rx_bytes: n.rx_bytes, tx_bytes: n.tx_bytes }));
    cachedStats.uptime = si.time().uptime;
    cachedStats.timestamp = Date.now();
    try { cachedStats.docker = await si.dockerContainers(); } catch (_) { cachedStats.docker = []; }
  } catch (e) { console.error('Initial stats fetch error:', e.message); }
})();

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.map': 'application/json' // For sourcemaps
};

const CONFIG_FILE = path.join(__dirname, 'config.json');
const AUTH_FILE = path.join(__dirname, 'auth.json');
const SECRETS_FILE = path.join(__dirname, 'secrets.json');

// ─────────────────────────────────────────────
// Security helpers
// ─────────────────────────────────────────────

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

function readJsonFile(filepath, fallback) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); } catch (_) { return fallback; }
}

function writeJsonFile(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

function getAuth() { return readJsonFile(AUTH_FILE, {}); }
function getSecrets() { return readJsonFile(SECRETS_FILE, {}); }

const SENSITIVE_KEYS = ['apiKey', 'api_key', 'token', 'secret', 'password', 'icalUrl'];

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.includes(key);
}

function isPublicMode() {
  const auth = getAuth();
  return auth.publicMode === true;
}

/** Mask sensitive fields in config before sending to browser */
function maskConfig(config) {
  const secrets = getSecrets();
  const masked = JSON.parse(JSON.stringify(config));
  if (masked.widgets) {
    masked.widgets.forEach(w => {
      if (!w.properties) return;
      const widgetSecrets = secrets[w.id] || {};
      for (const key of Object.keys(w.properties)) {
        if (isSensitiveKey(key) && (w.properties[key] === '__SECRET__' || widgetSecrets[key])) {
          w.properties[key] = '••••••••';
        }
      }
    });
  }
  return masked;
}

/** On save: extract sensitive values into secrets.json, replace with __SECRET__ in config */
function extractSecrets(config) {
  const secrets = getSecrets();
  if (config.widgets) {
    config.widgets.forEach(w => {
      if (!w.properties) return;
      for (const key of Object.keys(w.properties)) {
        if (isSensitiveKey(key)) {
          const val = w.properties[key];
          if (val && val !== '__SECRET__' && val !== '••••••••') {
            if (!secrets[w.id]) secrets[w.id] = {};
            secrets[w.id][key] = val;
            w.properties[key] = '__SECRET__';
          } else if (val === '••••••••') {
            // User didn't change it — keep existing secret, restore placeholder
            w.properties[key] = '__SECRET__';
          }
        }
      }
    });
  }
  writeJsonFile(SECRETS_FILE, secrets);
  return config;
}

// Scan templates directory for meta.json files
function scanTemplates(templatesDir) {
  const templates = [];
  try {
    const dirs = fs.readdirSync(templatesDir);
    for (const dir of dirs) {
      if (dir === 'templates.json' || dir === 'README.md' || dir.startsWith('.')) continue;
      const metaPath = path.join(templatesDir, dir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          templates.push(meta);
        } catch (_) {}
      }
    }
  } catch (_) {}
  return templates;
}

// Release check cache (1 hour TTL)
let _releaseCache = null;
let _releaseCacheTime = 0;
let _lbReleaseCache = null;
let _lbReleaseCacheTime = 0;

function sendResponse(res, statusCode, contentType, data, extraHeaders = {}) {
  res.writeHead(statusCode, { 'Content-Type': contentType, ...extraHeaders });
  res.end(data);
}

function sendJson(res, statusCode, data) {
  sendResponse(res, statusCode, 'application/json', JSON.stringify(data), { 'Access-Control-Allow-Origin': '*' });
}

function sendError(res, message, statusCode = 500) {
  sendJson(res, statusCode, { status: 'error', message });
}

// Parse iCal (.ics) text into sorted upcoming events
function parseIcal(text, maxEvents) {
  const now = new Date();
  const events = [];
  // Unfold continuation lines (RFC 5545: lines starting with space/tab are continuations)
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.split('BEGIN:VEVENT');
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    if (!block) continue;
    const get = (key) => { const m = block.match(new RegExp('^' + key + '(?:;[^:]*)?:(.*)$', 'm')); return m ? m[1].trim() : ''; };
    const getWithParams = (key) => { const m = block.match(new RegExp('^' + key + '((?:;[^:]*)?):(.*)$', 'm')); return m ? { params: m[1], value: m[2].trim() } : { params: '', value: '' }; };
    const summary = get('SUMMARY').replace(/\\,/g, ',').replace(/\\n/g, ' ');
    const location = get('LOCATION').replace(/\\,/g, ',').replace(/\\n/g, ' ');
    const dtstart = get('DTSTART');
    const dtstartFull = getWithParams('DTSTART');
    const dtendFull = getWithParams('DTEND');
    if (!dtstart) continue;
    // Parse iCal date: 20260210T150000Z or 20260210 (all-day)
    const allDay = dtstart.length === 8;
    // Map Windows/iCal TZID names to UTC offset (hours). Covers common zones.
    const tzOffsets = {
      'eastern standard time': -5, 'eastern daylight time': -4, 'us/eastern': -5, 'america/new_york': -5,
      'central standard time': -6, 'central daylight time': -5, 'us/central': -6, 'america/chicago': -6,
      'central america standard time': -6,
      'mountain standard time': -7, 'mountain daylight time': -6, 'us/mountain': -7, 'america/denver': -7,
      'pacific standard time': -8, 'pacific daylight time': -7, 'us/pacific': -8, 'america/los_angeles': -8,
      'pacific standard time (mexico)': -8,
      'india standard time': 5.5, 'asia/kolkata': 5.5,
      'sri lanka standard time': 5.5,
      'singapore standard time': 8, 'asia/singapore': 8,
      'china standard time': 8, 'asia/shanghai': 8,
      'tokyo standard time': 9, 'asia/tokyo': 9,
      'e. africa standard time': 3,
      'romance standard time': 1,
      'gmt standard time': 0, 'utc': 0, 'gmt': 0,
      'w. europe standard time': 1, 'europe/berlin': 1, 'europe/paris': 1,
    };
    const parseIcalDate = (s, params) => {
      if (!s) return null;
      if (s.length === 8) return new Date(s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8) + 'T00:00:00');
      // 20260210T150000Z or 20260210T150000
      const d = s.replace(/Z$/, '');
      const iso = d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8) + 'T' + d.slice(9,11) + ':' + d.slice(11,13) + ':' + d.slice(13,15);
      if (s.endsWith('Z')) return new Date(iso + 'Z');
      // Check for TZID parameter
      const tzMatch = (params || '').match(/TZID=([^;:]+)/i);
      if (tzMatch) {
        const tzName = tzMatch[1].trim().toLowerCase();
        const offsetHours = tzOffsets[tzName];
        if (offsetHours !== undefined) {
          // Convert from source timezone to UTC by appending the UTC offset
          const sign = offsetHours >= 0 ? '+' : '-';
          const absH = Math.floor(Math.abs(offsetHours));
          const absM = Math.round((Math.abs(offsetHours) - absH) * 60);
          const offsetStr = sign + String(absH).padStart(2, '0') + ':' + String(absM).padStart(2, '0');
          return new Date(iso + offsetStr);
        }
      }
      // No timezone info — treat as local
      return new Date(iso);
    };
    const start = parseIcalDate(dtstart, dtstartFull.params);
    const end = parseIcalDate(dtendFull.value, dtendFull.params);
    if (!start || isNaN(start.getTime())) continue;
    // Only future events (for all-day, include today)
    const cutoff = allDay ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : now;
    if (start < cutoff && (!end || end < cutoff)) continue;
    events.push({ summary: summary || 'Untitled', start: start.toISOString(), end: end ? end.toISOString() : null, location: location || null, allDay });
  }
  events.sort((a, b) => new Date(a.start) - new Date(b.start));
  return events.slice(0, maxEvents);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // CORS preflight for /config
  if (req.method === 'OPTIONS' && pathname === '/config') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // GET /config - Load dashboard configuration
  if (req.method === 'GET' && pathname === '/config') {
    fs.readFile(CONFIG_FILE, 'utf8', (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          // If config.json doesn't exist, return empty config
          sendJson(res, 200, { canvas: { width: 1920, height: 1080 }, widgets: [] });
        } else {
          sendError(res, `Failed to read config file: ${err.message}`);
        }
        return;
      }
      try {
        const config = JSON.parse(data);
        sendJson(res, 200, maskConfig(config));
      } catch (parseErr) {
        sendError(res, `Failed to parse config file: ${parseErr.message}`);
      }
    });
    return;
  }

  // POST /config - Save dashboard configuration
  if (req.method === 'POST' && pathname === '/config') {
    const MAX_BODY = 1024 * 1024; // 1 MB limit
    let body = '';
    let overflow = false;
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > MAX_BODY) { overflow = true; req.destroy(); }
    });
    req.on('end', () => {
      if (overflow) { sendError(res, 'Request body too large', 413); return; }
      try {
        let config = JSON.parse(body);
        config = extractSecrets(config);
        fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8', (err) => {
          if (err) {
            sendError(res, `Failed to write config file: ${err.message}`);
            return;
          }
          sendJson(res, 200, { status: 'success', message: 'Config saved' });
        });
      } catch (parseErr) {
        sendError(res, `Invalid JSON in request body: ${parseErr.message}`, 400);
      }
    });
    return;
  }

  // CORS preflight for /api/*
  if (req.method === 'OPTIONS' && (pathname.startsWith('/api/') || pathname === '/api/pages')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // ── Security: PIN auth endpoints ──
  if (req.method === 'GET' && pathname === '/api/auth/status') {
    const auth = getAuth();
    sendJson(res, 200, { hasPin: !!auth.pinHash, publicMode: !!auth.publicMode });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/set-pin') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { pin, currentPin } = JSON.parse(body);
        if (!pin || pin.length < 4 || pin.length > 6 || !/^\d+$/.test(pin)) {
          sendJson(res, 400, { error: 'PIN must be 4-6 digits' }); return;
        }
        const auth = getAuth();
        // If PIN already set, require current PIN
        if (auth.pinHash && (!currentPin || hashPin(currentPin) !== auth.pinHash)) {
          sendJson(res, 403, { error: 'Current PIN is incorrect' }); return;
        }
        auth.pinHash = hashPin(pin);
        writeJsonFile(AUTH_FILE, auth);
        sendJson(res, 200, { status: 'ok' });
      } catch (e) { sendError(res, e.message, 400); }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/verify-pin') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { pin } = JSON.parse(body);
        const auth = getAuth();
        if (!auth.pinHash) { sendJson(res, 200, { valid: true }); return; }
        const valid = hashPin(pin) === auth.pinHash;
        sendJson(res, 200, { valid });
      } catch (e) { sendError(res, e.message, 400); }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/remove-pin') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { pin } = JSON.parse(body);
        const auth = getAuth();
        if (auth.pinHash && hashPin(pin) !== auth.pinHash) {
          sendJson(res, 403, { error: 'PIN is incorrect' }); return;
        }
        delete auth.pinHash;
        writeJsonFile(AUTH_FILE, auth);
        sendJson(res, 200, { status: 'ok' });
      } catch (e) { sendError(res, e.message, 400); }
    });
    return;
  }

  // ── Security: Public mode ──
  if (req.method === 'GET' && pathname === '/api/mode') {
    const auth = getAuth();
    sendJson(res, 200, { publicMode: !!auth.publicMode });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/mode') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { publicMode, pin } = JSON.parse(body);
        const auth = getAuth();
        // Require PIN to toggle mode if PIN is set
        if (auth.pinHash && (!pin || hashPin(pin) !== auth.pinHash)) {
          sendJson(res, 403, { error: 'PIN required' }); return;
        }
        auth.publicMode = !!publicMode;
        writeJsonFile(AUTH_FILE, auth);
        sendJson(res, 200, { status: 'ok', publicMode: auth.publicMode });
      } catch (e) { sendError(res, e.message, 400); }
    });
    return;
  }

  // ── Security: Secrets management ──
  if (req.method === 'POST' && pathname.match(/^\/api\/secrets\/[^/]+$/)) {
    if (isPublicMode()) { sendJson(res, 403, { error: 'Forbidden in public mode' }); return; }
    const widgetId = pathname.split('/')[3];
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const secrets = getSecrets();
        if (!secrets[widgetId]) secrets[widgetId] = {};
        Object.assign(secrets[widgetId], updates);
        writeJsonFile(SECRETS_FILE, secrets);
        sendJson(res, 200, { status: 'ok' });
      } catch (e) { sendError(res, e.message, 400); }
    });
    return;
  }

  if (req.method === 'DELETE' && pathname.match(/^\/api\/secrets\/[^/]+\/[^/]+$/)) {
    if (isPublicMode()) { sendJson(res, 403, { error: 'Forbidden in public mode' }); return; }
    const parts = pathname.split('/');
    const widgetId = parts[3];
    const key = parts[4];
    const secrets = getSecrets();
    if (secrets[widgetId]) {
      delete secrets[widgetId][key];
      if (Object.keys(secrets[widgetId]).length === 0) delete secrets[widgetId];
      writeJsonFile(SECRETS_FILE, secrets);
    }
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // ── Public mode guard: block edit-related APIs ──
  if (isPublicMode()) {
    const editPaths = ['/config'];
    const isEditApi = (req.method === 'POST' && editPaths.includes(pathname)) ||
                      (req.method === 'POST' && pathname.startsWith('/api/templates/')) ||
                      (req.method === 'DELETE' && pathname.startsWith('/api/templates/'));
    if (isEditApi) {
      sendJson(res, 403, { error: 'Dashboard is in public mode. Editing is disabled.' });
      return;
    }
  }

  // ── Pages system routing ──
  const pageMatch = matchPageRoute(loadedPages, req.method, pathname, parsedUrl);
  if (pageMatch) {
    if (pageMatch.type === 'list') {
      sendJson(res, 200, loadedPages.filter(p => p.nav !== false).map(p => ({ id: p.id, title: p.title, icon: p.icon, description: p.description, order: p.order })));
      return;
    }
    if (pageMatch.type === 'static') {
      const resolved = path.resolve(pageMatch.filePath);
      if (!resolved.startsWith(path.resolve(PAGES_DIR))) {
        sendResponse(res, 403, 'text/plain', 'Forbidden');
        return;
      }
      const ext = path.extname(resolved).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      fs.readFile(resolved, (err, data) => {
        if (err) { sendResponse(res, 404, 'text/plain', 'Not Found'); return; }
        sendResponse(res, 200, contentType, data);
      });
      return;
    }
    if (pageMatch.type === 'api') {
      // Parse body for non-GET requests
      if (req.method === 'GET') {
        try {
          const result = await pageMatch.handler(req, res, { query: pageMatch.query, body: {}, params: pageMatch.params });
          if (result !== undefined && !res.writableEnded) sendJson(res, res.statusCode || 200, result);
        } catch (e) { sendError(res, e.message); }
        return;
      }
      // Parse JSON body
      const MAX_BODY = 1024 * 1024;
      let body = '';
      let overflow = false;
      req.on('data', chunk => { body += chunk.toString(); if (body.length > MAX_BODY) { overflow = true; req.destroy(); } });
      req.on('end', async () => {
        if (overflow) { sendError(res, 'Request body too large', 413); return; }
        let parsed = {};
        try { if (body) parsed = JSON.parse(body); } catch (_) {}
        try {
          const result = await pageMatch.handler(req, res, { query: pageMatch.query, body: parsed, params: pageMatch.params });
          if (result !== undefined && !res.writableEnded) sendJson(res, res.statusCode || 200, result);
        } catch (e) { sendError(res, e.message); }
      });
      return;
    }
  }

  // GET/POST /api/todos - Read/write todo list
  if (pathname === '/api/todos') {
    const todosFile = path.join(__dirname, 'todos.json');
    if (req.method === 'GET') {
      fs.readFile(todosFile, 'utf8', (err, data) => {
        if (err) {
          if (err.code === 'ENOENT') return sendJson(res, 200, []);
          return sendError(res, err.message);
        }
        try { sendJson(res, 200, JSON.parse(data)); }
        catch (e) { sendJson(res, 200, []); }
      });
      return;
    }
    if (req.method === 'POST') {
      const MAX_TODO_BODY = 256 * 1024; // 256 KB limit
      let body = '';
      let overflow = false;
      req.on('data', chunk => {
        body += chunk.toString();
        if (body.length > MAX_TODO_BODY) { overflow = true; req.destroy(); }
      });
      req.on('end', () => {
        if (overflow) { sendError(res, 'Request body too large', 413); return; }
        try {
          const todos = JSON.parse(body);
          fs.writeFile(todosFile, JSON.stringify(todos, null, 2), 'utf8', (err) => {
            if (err) return sendError(res, err.message);
            sendJson(res, 200, { status: 'ok' });
          });
        } catch (e) { sendError(res, 'Invalid JSON', 400); }
      });
      return;
    }
  }

  // GET/POST /api/notes - Read/write notes content
  if (pathname === '/api/notes') {
    const notesFile = path.join(__dirname, 'notes.json');
    if (req.method === 'GET') {
      fs.readFile(notesFile, 'utf8', (err, data) => {
        if (err) {
          if (err.code === 'ENOENT') return sendJson(res, 200, {});
          return sendError(res, err.message);
        }
        try { sendJson(res, 200, JSON.parse(data)); }
        catch (e) { sendJson(res, 200, {}); }
      });
      return;
    }
    if (req.method === 'POST') {
      const MAX_NOTES_BODY = 512 * 1024;
      let body = '';
      let overflow = false;
      req.on('data', chunk => {
        body += chunk.toString();
        if (body.length > MAX_NOTES_BODY) { overflow = true; req.destroy(); }
      });
      req.on('end', () => {
        if (overflow) { sendError(res, 'Request body too large', 413); return; }
        try {
          const notes = JSON.parse(body);
          fs.writeFile(notesFile, JSON.stringify(notes, null, 2), 'utf8', (err) => {
            if (err) return sendError(res, err.message);
            sendJson(res, 200, { status: 'ok' });
          });
        } catch (e) { sendError(res, 'Invalid JSON', 400); }
      });
      return;
    }
  }

  // ── Todoist API v1 proxy ─────────────────────────────────
  const TODOIST_TOKEN = process.env.TODOIST_API_TOKEN || '';
  if (pathname.startsWith('/api/todoist/')) {
    if (!TODOIST_TOKEN) { sendError(res, 'TODOIST_API_TOKEN not set', 503); return; }

    // Parse: /api/todoist/tasks, /api/todoist/tasks/12345, /api/todoist/tasks/12345/close
    const sub = pathname.slice('/api/todoist'.length); // e.g. "/tasks" or "/tasks/123/close"

    function todoistReq(method, apiPath, body) {
      return new Promise((resolve, reject) => {
        const opts = {
          hostname: 'api.todoist.com',
          path: '/api/v1' + apiPath,
          method,
          headers: {
            'Authorization': 'Bearer ' + TODOIST_TOKEN,
            'Content-Type': 'application/json'
          }
        };
        const r = https.request(opts, (resp) => {
          let data = '';
          resp.on('data', c => { data += c; });
          resp.on('end', () => {
            if (resp.statusCode === 204) return resolve({ _status: 204 });
            try { resolve(JSON.parse(data)); }
            catch (_) { resolve({ _raw: data, _status: resp.statusCode }); }
          });
        });
        r.on('error', reject);
        if (body) r.write(JSON.stringify(body));
        r.end();
      });
    }

    // GET /api/todoist/tasks?filter=...&project_id=...
    if (req.method === 'GET' && sub === '/tasks') {
      (async () => {
        try {
          const qs = new URL(req.url, 'http://localhost').searchParams;
          const baseParams = [];
          if (qs.get('filter')) baseParams.push('filter=' + encodeURIComponent(qs.get('filter')));
          if (qs.get('project_id')) baseParams.push('project_id=' + encodeURIComponent(qs.get('project_id')));
          if (qs.get('label')) baseParams.push('label=' + encodeURIComponent(qs.get('label')));
          // Paginate through all results (v1 API uses next_cursor)
          let allTasks = [];
          let cursor = null;
          do {
            const params = [...baseParams];
            if (cursor) params.push('cursor=' + encodeURIComponent(cursor));
            const apiPath = '/tasks' + (params.length ? '?' + params.join('&') : '');
            const resp = await todoistReq('GET', apiPath);
            if (Array.isArray(resp)) {
              allTasks = allTasks.concat(resp);
              cursor = null; // flat array = no pagination
            } else {
              allTasks = allTasks.concat(resp.results || []);
              cursor = resp.next_cursor || null;
            }
          } while (cursor);
          sendJson(res, 200, allTasks);
        } catch (e) { sendError(res, e.message); }
      })();
      return;
    }

    // POST /api/todoist/tasks - Create task
    if (req.method === 'POST' && sub === '/tasks') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const result = await todoistReq('POST', '/tasks', payload);
          sendJson(res, 200, result);
        } catch (e) { sendError(res, e.message); }
      });
      return;
    }

    // POST /api/todoist/tasks/:id/close
    const closeMatch = sub.match(/^\/tasks\/([^/]+)\/close$/);
    if (req.method === 'POST' && closeMatch) {
      (async () => {
        try {
          await todoistReq('POST', '/tasks/' + closeMatch[1] + '/close');
          sendJson(res, 200, { ok: true });
        } catch (e) { sendError(res, e.message); }
      })();
      return;
    }

    // POST /api/todoist/tasks/:id/reopen
    const reopenMatch = sub.match(/^\/tasks\/([^/]+)\/reopen$/);
    if (req.method === 'POST' && reopenMatch) {
      (async () => {
        try {
          await todoistReq('POST', '/tasks/' + reopenMatch[1] + '/reopen');
          sendJson(res, 200, { ok: true });
        } catch (e) { sendError(res, e.message); }
      })();
      return;
    }

    // DELETE /api/todoist/tasks/:id
    const delMatch = sub.match(/^\/tasks\/([^/]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      (async () => {
        try {
          await todoistReq('DELETE', '/tasks/' + delMatch[1]);
          sendJson(res, 200, { ok: true });
        } catch (e) { sendError(res, e.message); }
      })();
      return;
    }

    // POST /api/todoist/tasks/:id - Update task
    const updateMatch = sub.match(/^\/tasks\/([^/]+)$/);
    if (req.method === 'POST' && updateMatch) {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const result = await todoistReq('POST', '/tasks/' + updateMatch[1], payload);
          sendJson(res, 200, result);
        } catch (e) { sendError(res, e.message); }
      });
      return;
    }

    // GET /api/todoist/projects
    if (req.method === 'GET' && sub === '/projects') {
      (async () => {
        try {
          const resp = await todoistReq('GET', '/projects');
          const projects = Array.isArray(resp) ? resp : (resp.results || []);
          sendJson(res, 200, projects);
        } catch (e) { sendError(res, e.message); }
      })();
      return;
    }

    sendError(res, 'Not found', 404);
    return;
  }

  // ── Telegram Bridge proxy ─────────────────────────────────
  const TG_BRIDGE_PORT = process.env.TG_BRIDGE_PORT || 18790;
  const TG_BRIDGE = `http://127.0.0.1:${TG_BRIDGE_PORT}`;

  if (pathname.startsWith('/api/telegram/')) {
    const bridgePath = pathname.slice('/api/telegram'.length); // e.g. "/chats", "/auth/status"

    // SSE streaming — pipe directly from bridge
    if (req.method === 'GET' && bridgePath === '/stream') {
      const proxyReq = http.request(
        { hostname: '127.0.0.1', port: TG_BRIDGE_PORT, path: '/stream', method: 'GET' },
        (proxyRes) => {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });
          proxyRes.pipe(res);
        }
      );
      proxyReq.on('error', () => {
        sendError(res, 'Telegram bridge unavailable', 502);
      });
      proxyReq.end();
      return;
    }

    // All other telegram endpoints — proxy GET/POST to bridge
    (async () => {
      try {
        let body = null;
        if (req.method === 'POST') {
          body = await new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => data += chunk);
            req.on('end', () => {
              try { resolve(JSON.parse(data)); } catch { resolve(data); }
            });
            req.on('error', reject);
          });
        }

        const result = await new Promise((resolve, reject) => {
          const url = new URL(bridgePath, TG_BRIDGE);
          // Forward query string for GET requests
          if (req.method === 'GET' && parsedUrl.search) {
            url.search = parsedUrl.search;
          }
          const opts = {
            method: req.method,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search
          };
          if (body && typeof body === 'object') {
            opts.headers = { 'Content-Type': 'application/json' };
          }
          const proxyReq = http.request(opts, (proxyRes) => {
            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => resolve({ status: proxyRes.statusCode, body: data }));
          });
          proxyReq.on('error', reject);
          if (body) {
            proxyReq.write(typeof body === 'object' ? JSON.stringify(body) : body);
          }
          proxyReq.end();
        });

        res.writeHead(result.status, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(result.body);
      } catch (e) {
        sendError(res, 'Telegram bridge unavailable: ' + e.message, 502);
      }
    })();
    return;
  }

  // GET /api/cron - Cron jobs from OpenClaw via WS RPC
  if (req.method === 'GET' && pathname === '/api/cron') {
    (async () => {
      try {
        const result = await ocRpc('cron.list', {});
        if (!result.ok) {
          sendJson(res, 200, { jobs: [] });
          return;
        }
        const raw = result.payload?.jobs || result.payload || [];
        const jobs = (Array.isArray(raw) ? raw : []).map(j => ({
          name: j.name || j.label || j.jobId || '?',
          schedule: j.schedule?.expr || j.schedule || j.cron || '—',
          tz: j.schedule?.tz || j.tz || '',
          enabled: j.enabled !== false,
          lastRun: j.state?.lastRunAtMs ? new Date(j.state.lastRunAtMs).toISOString() : null,
          lastStatus: j.state?.lastStatus || null,
          nextRun: j.state?.nextRunAtMs ? new Date(j.state.nextRunAtMs).toISOString() : null
        }));
        sendJson(res, 200, { jobs });
      } catch (e) {
        sendError(res, e.message);
      }
    })();
    return;
  }

  // GET /api/system-log - Structured system log entries
  if (req.method === 'GET' && pathname === '/api/system-log') {
    try {
      const logPath = path.join(os.homedir(), '.openclaw', 'logs', 'gateway.log');
      if (!fs.existsSync(logPath)) {
        sendJson(res, 200, { status: 'ok', entries: [] });
        return;
      }
      const content = fs.readFileSync(logPath, 'utf8');
      const maxLines = Math.min(Math.max(parseInt(parsedUrl.searchParams.get('max')) || 50, 1), 200);
      const lines = content.split('\n').filter(l => l.trim());
      const entries = lines.slice(-maxLines).reverse().map(line => {
        let level = 'INFO';
        let category = 'system';
        if (/\b(error|fatal)\b/i.test(line)) level = 'ERROR';
        else if (/\bwarn/i.test(line)) level = 'WARN';
        else if (/\b(ok|success|ready|started|connected)\b/i.test(line)) level = 'OK';
        const tsMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
        const time = tsMatch ? tsMatch[1] : new Date().toISOString();
        if (/\b(cron|schedule)\b/i.test(line)) category = 'cron';
        else if (/\b(auth|login|token)\b/i.test(line)) category = 'auth';
        else if (/\b(session|agent)\b/i.test(line)) category = 'session';
        else if (/\b(exec|command)\b/i.test(line)) category = 'exec';
        else if (/\b(file|read|write)\b/i.test(line)) category = 'file';
        else if (/\b(restart|gateway|start)\b/i.test(line)) category = 'gateway';
        let message = line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s*/, '').trim();
        return { time, level, category, message };
      });
      sendJson(res, 200, { status: 'ok', entries });
    } catch (e) {
      sendJson(res, 200, { status: 'ok', entries: [{ time: new Date().toISOString(), level: 'ERROR', category: 'system', message: 'Error reading log: ' + e.message }] });
    }
    return;
  }

  // GET /api/logs - Read last 50 lines from gateway log
  if (req.method === 'GET' && pathname === '/api/logs') {
    const logFile = path.join(os.homedir(), '.openclaw', 'logs', 'gateway.log');
    fs.readFile(logFile, 'utf8', (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') return sendJson(res, 200, { lines: [] });
        return sendError(res, err.message);
      }
      const allLines = data.split('\n').filter(l => l.trim());
      const lines = allLines.slice(-50);
      sendJson(res, 200, { lines });
    });
    return;
  }

  // GET /api/auth - OpenClaw auth status
  if (req.method === 'GET' && pathname === '/api/auth') {
    try {
      const home = os.homedir();
      const configPath = path.join(home, '.openclaw', 'openclaw.json');
      const authProfilesPath = path.join(home, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const authProfiles = JSON.parse(fs.readFileSync(authProfilesPath, 'utf8'));

      // Get primary anthropic profile
      const anthropicOrder = config.auth?.order?.anthropic || [];
      const primaryId = anthropicOrder[0] || 'anthropic:default';
      const profileKey = primaryId.includes(':') ? primaryId : `anthropic:${primaryId}`;
      const profileType = authProfiles.profiles?.[profileKey]?.type;
      const mode = profileType === 'token' ? 'Monthly' : 'API';

      sendJson(res, 200, { status: 'ok', mode, primary: profileKey });
    } catch (e) {
      sendError(res, `Auth status error: ${e.message}`);
    }
    return;
  }

  // GET /api/sessions - Active sessions from OpenClaw via WS RPC
  if (req.method === 'GET' && pathname === '/api/sessions') {
    (async () => {
      try {
        const result = await ocRpc('sessions.list', {});
        const raw = result.payload?.sessions || result.payload || [];
        const sessions = Array.isArray(raw) ? raw : [];
        const active = sessions.filter(s => s.status === 'active' || s.active !== false).length;
        sendJson(res, 200, { data: { active, total: sessions.length, sessions } });
      } catch (e) {
        sendJson(res, 200, { data: { active: 0, total: 0, sessions: [] }, error: e.message });
      }
    })();
    return;
  }

  // GET /api/releases - OpenClaw release info via WS RPC + GitHub (cached 1hr)
  if (req.method === 'GET' && pathname === '/api/releases') {
    const now = Date.now();
    if (_releaseCache && (now - _releaseCacheTime) < 3600000) {
      sendJson(res, 200, _releaseCache);
      return;
    }
    (async () => {
      try {
        // Get running version from OpenClaw via WS RPC
        let currentVersion = 'unknown';
        try {
          const cfg = await ocRpc('config.get', {});
          if (cfg.ok && cfg.payload) {
            const v = cfg.payload.parsed?.meta?.lastTouchedVersion
                   || cfg.payload.resolved?.meta?.lastTouchedVersion
                   || cfg.payload.config?.meta?.lastTouchedVersion;
            if (v) currentVersion = v;
          }
        } catch (_) {}

        const ghRes = await fetch('https://api.github.com/repos/openclaw/openclaw/releases/latest');
        const ghData = await ghRes.json();
        const result = {
          status: 'ok',
          current: currentVersion,
          latest: ghData.tag_name,
          latestUrl: ghData.html_url,
          publishedAt: ghData.published_at
        };
        _releaseCache = result;
        _releaseCacheTime = now;
        sendJson(res, 200, result);
      } catch (e) {
        sendError(res, `Release check error: ${e.message}`);
      }
    })();
    return;
  }

  // GET /api/lb-release - LobsterBoard version check
  if (req.method === 'GET' && pathname === '/api/lb-release') {
    const now = Date.now();
    if (_lbReleaseCache && (now - _lbReleaseCacheTime) < 3600000) {
      sendJson(res, 200, _lbReleaseCache);
      return;
    }
    (async () => {
      try {
        let currentVersion = 'unknown';
        try {
          const pkgPath = path.join(__dirname, 'package.json');
          currentVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
        } catch (_) {}

        const ghRes = await fetch('https://api.github.com/repos/lobsterboard/lobsterboard/releases/latest');
        const ghData = await ghRes.json();
        const result = {
          status: 'ok',
          current: currentVersion,
          latest: ghData.tag_name || currentVersion,
          latestUrl: ghData.html_url || '',
          publishedAt: ghData.published_at || null
        };
        _lbReleaseCache = result;
        _lbReleaseCacheTime = now;
        sendJson(res, 200, result);
      } catch (e) {
        sendError(res, `LB Release check error: ${e.message}`);
      }
    })();
    return;
  }

  // GET /api/today - Today's activity summary (port 3000 style)
  if (req.method === 'GET' && pathname === '/api/today') {
    try {
      const { execSync } = require('child_process');
      const now = new Date();
      const dateStr = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
      const activities = [];

      // 1. Today's memory file headers
      const memoryDir = path.join(os.homedir(), 'clawd', 'memory');
      const todayFile = path.join(memoryDir, `${dateStr}.md`);
      if (fs.existsSync(todayFile)) {
        const content = fs.readFileSync(todayFile, 'utf8');
        content.split('\n').forEach(line => {
          if (line.startsWith('#')) {
            const text = line.replace(/^#+\s*/, '').trim();
            if (text && !/session notes/i.test(text)) {
              activities.push({ type: 'note', icon: '📝', text, source: 'memory' });
            }
          }
        });
      }

      // 2. Git commits from today
      try {
        const commits = execSync(
          `cd ~/clawd && git log --since="today 00:00" --pretty=format:"%s" 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        if (commits) {
          commits.split('\n').slice(0, 10).forEach(msg => {
            if (msg.trim()) {
              activities.push({ type: 'commit', icon: '💾', text: msg.trim(), source: 'git' });
            }
          });
        }
      } catch (_) {}

      // 3. Cron job runs from today
      const cronFile = path.join(os.homedir(), '.openclaw', 'cron', 'jobs.json');
      if (fs.existsSync(cronFile)) {
        try {
          const cronData = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
          (cronData.jobs || []).forEach(job => {
            const lastMs = job.state && job.state.lastRunAtMs;
            if (lastMs) {
              const runDate = new Date(lastMs);
              const runDateStr = [runDate.getFullYear(), String(runDate.getMonth()+1).padStart(2,'0'), String(runDate.getDate()).padStart(2,'0')].join('-');
              if (runDateStr === dateStr) {
                activities.push({ type: 'cron', icon: '⏰', text: `${job.name} ran`, source: 'cron', status: job.state.lastStatus || 'ok' });
              }
            }
          });
        } catch (_) {}
      }

      // Dedupe
      const seen = new Set();
      const unique = activities.filter(a => {
        const key = a.text.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      sendJson(res, 200, { date: dateStr, activities: unique.slice(0, 15), count: unique.length });
    } catch (e) {
      const now = new Date();
      const dateStr = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
      sendJson(res, 200, { date: dateStr, activities: [], count: 0, error: e.message });
    }
    return;
  }

  // GET /api/activity - Recent activity from today's memory file
  if (req.method === 'GET' && pathname === '/api/activity') {
    try {
      const now = new Date();
      // Use local date (EST), not UTC
      const dateStr = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
      const memoryDir = path.join(__dirname, '..', 'memory');
      const todayFile = path.join(memoryDir, `${dateStr}.md`);
      const items = [];
      if (fs.existsSync(todayFile)) {
        const content = fs.readFileSync(todayFile, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          // Extract bullet points and headings as activity items
          if (trimmed.startsWith('- ') && trimmed.length > 4) {
            items.push({ text: trimmed.slice(2), time: dateStr });
          } else if (trimmed.startsWith('## ') && trimmed.length > 4) {
            items.push({ text: '📌 ' + trimmed.slice(3), time: dateStr });
          }
        }
      }
      // If no memory file, show a placeholder
      if (items.length === 0) {
        items.push({ text: 'No activity logged yet today.' });
      }
      sendJson(res, 200, { items: items.slice(-20).reverse() });
    } catch (e) {
      sendJson(res, 200, { items: [{ text: 'Error loading activity: ' + e.message }] });
    }
    return;
  }

  // GET /api/rss?url=<feedUrl>&widgetId=<id>&secretKey=<key> - Server-side RSS proxy
  if (req.method === 'GET' && pathname === '/api/rss') {
    let feedUrl = parsedUrl.searchParams.get('url');
    const rssWidgetId = parsedUrl.searchParams.get('widgetId');
    const rssSecretKey = parsedUrl.searchParams.get('secretKey') || 'feedUrl';
    if ((!feedUrl || feedUrl === '••••••••' || feedUrl === '__SECRET__') && rssWidgetId) {
      const secrets = getSecrets();
      feedUrl = secrets[rssWidgetId]?.[rssSecretKey] || null;
    }
    if (!feedUrl) { sendError(res, 'Missing url parameter', 400); return; }

    // Validate URL: only http/https, block private/internal IPs (SSRF protection)
    function isPrivateHost(hostname) {
      const patterns = [
        /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
        /^169\.254\./, /^0\./, /^localhost$/i, /^\[?::1\]?$/, /^\[?fc/i, /^\[?fd/i
      ];
      return patterns.some(p => p.test(hostname));
    }
    try {
      const parsed = new URL(feedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        sendError(res, 'Only http and https URLs are allowed', 400); return;
      }
      if (isPrivateHost(parsed.hostname)) {
        sendError(res, 'URLs pointing to private/internal addresses are not allowed', 400); return;
      }
    } catch (urlErr) {
      sendError(res, 'Invalid URL', 400); return;
    }

    try {
      const https = require('https');
      const http2 = require('http');
      function fetchFeed(url, redirects) {
        if (redirects > 3) { sendError(res, 'Too many redirects'); return; }
        // Validate each URL (including redirects) against SSRF
        try {
          const rp = new URL(url);
          if (rp.protocol !== 'http:' && rp.protocol !== 'https:') { sendError(res, 'Redirect to disallowed scheme', 400); return; }
          if (isPrivateHost(rp.hostname)) { sendError(res, 'Redirect to private address blocked', 400); return; }
        } catch (_) { sendError(res, 'Invalid redirect URL', 400); return; }
        const mod = url.startsWith('https') ? https : http2;
        const req2 = mod.get(url, { headers: { 'User-Agent': 'LobsterBoard/1.0' }, timeout: 15000 }, (proxyRes) => {
          if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            proxyRes.resume();
            fetchFeed(proxyRes.headers.location, redirects + 1);
            return;
          }
          let body = '';
          proxyRes.on('data', c => { body += c; if (body.length > 5000000) proxyRes.destroy(); });
          proxyRes.on('end', () => { sendResponse(res, 200, 'application/xml', body, { 'Access-Control-Allow-Origin': '*' }); });
        });
        req2.on('error', e => sendError(res, e.message));
        req2.on('timeout', () => { req2.destroy(); sendError(res, 'Feed request timed out'); });
      }
      fetchFeed(feedUrl, 0);
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/calendar?url=<icalUrl>&max=<maxEvents>&widgetId=<id>&secretKey=<key> - iCal feed proxy + parser
  if (req.method === 'GET' && pathname === '/api/calendar') {
    let icalUrl = parsedUrl.searchParams.get('url');
    const maxEvents = Math.min(parseInt(parsedUrl.searchParams.get('max')) || 10, 50);
    const widgetId = parsedUrl.searchParams.get('widgetId');
    const secretKey = parsedUrl.searchParams.get('secretKey') || 'icalUrl';
    // If url is masked/placeholder, resolve from secrets
    if ((!icalUrl || icalUrl === '••••••••' || icalUrl === '__SECRET__') && widgetId) {
      const secrets = getSecrets();
      icalUrl = secrets[widgetId]?.[secretKey] || null;
    }
    if (!icalUrl) { sendError(res, 'Missing url parameter', 400); return; }

    // Validate URL: only http/https, block private/internal IPs
    function isPrivateHost(hostname) {
      const patterns = [
        /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
        /^169\.254\./, /^0\./, /^localhost$/i, /^\[?::1\]?$/, /^\[?fc/i, /^\[?fd/i
      ];
      return patterns.some(p => p.test(hostname));
    }
    try {
      const parsed = new URL(icalUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        sendError(res, 'Only http and https URLs are allowed', 400); return;
      }
      if (isPrivateHost(parsed.hostname)) {
        sendError(res, 'URLs pointing to private/internal addresses are not allowed', 400); return;
      }
    } catch (urlErr) {
      sendError(res, 'Invalid URL', 400); return;
    }

    // 5-minute cache keyed by url+max
    if (!global._calendarCache) global._calendarCache = {};
    const cacheKey = icalUrl + '|' + maxEvents;
    const cached = global._calendarCache[cacheKey];
    if (cached && Date.now() - cached.ts < 300000) {
      sendJson(res, 200, cached.data);
      return;
    }

    try {
      const https = require('https');
      const http2 = require('http');
      function fetchIcal(url, redirects) {
        if (redirects > 3) { sendError(res, 'Too many redirects'); return; }
        // Validate each URL (including redirects) against SSRF
        try {
          const rp = new URL(url);
          if (rp.protocol !== 'http:' && rp.protocol !== 'https:') { sendError(res, 'Redirect to disallowed scheme', 400); return; }
          if (isPrivateHost(rp.hostname)) { sendError(res, 'Redirect to private address blocked', 400); return; }
        } catch (_) { sendError(res, 'Invalid redirect URL', 400); return; }
        const mod = url.startsWith('https') ? https : http2;
        const req2 = mod.get(url, { headers: { 'User-Agent': 'LobsterBoard/1.0' }, timeout: 15000 }, (proxyRes) => {
          if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            proxyRes.resume();
            fetchIcal(proxyRes.headers.location, redirects + 1);
            return;
          }
          let body = '';
          proxyRes.on('data', c => { body += c; if (body.length > 5000000) proxyRes.destroy(); });
          proxyRes.on('end', () => {
            try {
              const events = parseIcal(body, maxEvents);
              global._calendarCache[cacheKey] = { ts: Date.now(), data: events };
              sendJson(res, 200, events);
            } catch (e) { sendError(res, 'Failed to parse iCal: ' + e.message); }
          });
        });
        req2.on('error', e => sendError(res, e.message));
        req2.on('timeout', () => { req2.destroy(); sendError(res, 'Request timed out'); });
      }
      fetchIcal(icalUrl, 0);
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/usage/claude - Anthropic Claude usage proxy
  if (req.method === 'GET' && pathname === '/api/usage/claude') {
    let apiKey = process.env.ANTHROPIC_ADMIN_KEY;
    if (!apiKey) {
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const w = (cfg.widgets || []).find(w => w.type === 'ai-usage-claude');
        if (w && w.properties && w.properties.apiKey && w.properties.apiKey !== '__SECRET__') {
          apiKey = w.properties.apiKey;
        } else if (w) {
          // Check secrets store
          const secrets = getSecrets();
          apiKey = secrets[w.id]?.apiKey || null;
        }
      } catch(e) {}
    }
    if (!apiKey) { sendJson(res, 200, { error: 'No API key configured. Add your Anthropic Admin key in the widget properties.', tokens: 0, cost: 0, models: [] }); return; }
    (async () => {
      try {
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
        // Week: Monday of current week
        const dayOfWeek = now.getDay();
        const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const weekStart = new Date(now.getTime() - mondayOffset * 86400000).toISOString().slice(0, 10);
        // Month: 1st of current month
        const monthStart = today.slice(0, 8) + '01';
        const headers = { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey };
        const base = 'https://api.anthropic.com/v1/organizations/usage_report/messages';

        function aggregateBuckets(data) {
          let totalTokens = 0, totalCost = 0;
          const modelMap = {};
          for (const bucket of (data.data || [])) {
            const input = bucket.input_tokens || 0;
            const output = bucket.output_tokens || 0;
            const tokens = input + output;
            const cost = (bucket.input_cost || 0) + (bucket.output_cost || 0);
            totalTokens += tokens;
            totalCost += cost;
            const model = bucket.model || 'unknown';
            if (!modelMap[model]) modelMap[model] = { name: model, tokens: 0, cost: 0 };
            modelMap[model].tokens += tokens;
            modelMap[model].cost += cost;
          }
          return { tokens: totalTokens, cost: totalCost, models: Object.values(modelMap) };
        }

        const [todayResp, weekResp, monthResp] = await Promise.all([
          fetch(`${base}?starting_at=${today}T00:00:00Z&ending_at=${tomorrow}T00:00:00Z&bucket_width=1d&group_by[]=model`, { headers }),
          fetch(`${base}?starting_at=${weekStart}T00:00:00Z&ending_at=${tomorrow}T00:00:00Z&bucket_width=1d&group_by[]=model`, { headers }),
          fetch(`${base}?starting_at=${monthStart}T00:00:00Z&ending_at=${tomorrow}T00:00:00Z&bucket_width=1d&group_by[]=model`, { headers })
        ]);

        const todayData = await todayResp.json();
        if (!todayResp.ok) { sendJson(res, 200, { error: todayData.error?.message || 'API error', tokens: 0, cost: 0, models: [] }); return; }
        const weekData = await weekResp.json();
        const monthData = await monthResp.json();

        const todayAgg = aggregateBuckets(todayData);
        const weekAgg = aggregateBuckets(weekData);
        const monthAgg = aggregateBuckets(monthData);

        sendJson(res, 200, {
          tokens: todayAgg.tokens, cost: todayAgg.cost, models: todayAgg.models,
          week: { tokens: weekAgg.tokens, cost: weekAgg.cost },
          month: { tokens: monthAgg.tokens, cost: monthAgg.cost }
        });
      } catch (e) {
        sendJson(res, 200, { error: e.message, tokens: 0, cost: 0, models: [] });
      }
    })();
    return;
  }

  // GET /api/usage/openai - OpenAI usage proxy
  if (req.method === 'GET' && pathname === '/api/usage/openai') {
    let apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const w = (cfg.widgets || []).find(w => w.type === 'ai-usage-openai');
        if (w && w.properties && w.properties.apiKey && w.properties.apiKey !== '__SECRET__') {
          apiKey = w.properties.apiKey;
        } else if (w) {
          const secrets = getSecrets();
          apiKey = secrets[w.id]?.apiKey || null;
        }
      } catch(e) {}
    }
    if (!apiKey) { sendJson(res, 200, { error: 'No API key configured. Add your OpenAI key in the widget properties.', tokens: 0, cost: 0, models: [] }); return; }
    (async () => {
      try {
        const now = new Date();
        const todayUnix = Math.floor(new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getTime() / 1000);
        const dayOfWeek = now.getDay();
        const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        const weekStartUnix = todayUnix - mondayOffset * 86400;
        const monthStartUnix = Math.floor(new Date(now.toISOString().slice(0, 8) + '01T00:00:00Z').getTime() / 1000);
        const headers = { 'Authorization': `Bearer ${apiKey}` };
        const base = 'https://api.openai.com/v1/organization/costs';

        function aggregateOpenAI(data) {
          let totalCost = 0;
          const modelMap = {};
          for (const bucket of (data.data || [])) {
            for (const lineItem of (bucket.results || [])) {
              const cost = (lineItem.amount?.value || 0);
              totalCost += cost;
              const model = lineItem.line_item || 'unknown';
              if (!modelMap[model]) modelMap[model] = { name: model, tokens: 0, cost: 0 };
              modelMap[model].cost += cost;
            }
          }
          return { cost: totalCost / 100, models: Object.values(modelMap).map(m => ({ ...m, cost: m.cost / 100 })) };
        }

        const [todayResp, weekResp, monthResp] = await Promise.all([
          fetch(`${base}?start_time=${todayUnix}&bucket_width=1d`, { headers }),
          fetch(`${base}?start_time=${weekStartUnix}&bucket_width=1d`, { headers }),
          fetch(`${base}?start_time=${monthStartUnix}&bucket_width=1d`, { headers })
        ]);

        const todayData = await todayResp.json();
        if (!todayResp.ok) {
          const errMsg = todayData.error?.message || todayData.error || 'API error';
          const hint = typeof errMsg === 'string' && errMsg.includes('scope') ? ' Enable "Usage: Read" scope on your API key.' : '';
          sendJson(res, 200, { error: errMsg + hint, tokens: 0, cost: 0, models: [] }); return;
        }
        const weekData = await weekResp.json();
        const monthData = await monthResp.json();

        const todayAgg = aggregateOpenAI(todayData);
        const weekAgg = aggregateOpenAI(weekData);
        const monthAgg = aggregateOpenAI(monthData);

        sendJson(res, 200, {
          tokens: 0, cost: todayAgg.cost, models: todayAgg.models,
          week: { tokens: 0, cost: weekAgg.cost },
          month: { tokens: 0, cost: monthAgg.cost }
        });
      } catch (e) {
        sendJson(res, 200, { error: e.message, tokens: 0, cost: 0, models: [] });
      }
    })();
    return;
  }

  // GET /api/stats - Return cached system stats
  if (req.method === 'GET' && pathname === '/api/stats') {
    sendJson(res, 200, cachedStats);
    return;
  }

  // GET /api/stats/stream - SSE endpoint for live stats
  if (req.method === 'GET' && pathname === '/api/stats/stream') {
    if (sseClients.size >= 10) {
      sendError(res, 'Too many SSE connections', 429);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify(cachedStats)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── Templates API ──
  const TEMPLATES_DIR = path.join(__dirname, 'templates');

  // GET /api/templates — list all templates
  if (req.method === 'GET' && pathname === '/api/templates') {
    try {
      const templates = scanTemplates(TEMPLATES_DIR);
      sendJson(res, 200, templates);
    } catch (e) {
      sendError(res, `Failed to list templates: ${e.message}`);
    }
    return;
  }

  // GET /api/templates/:id — get a template's config.json
  if (req.method === 'GET' && pathname.match(/^\/api\/templates\/([^/]+)$/) && !pathname.endsWith('/preview')) {
    const id = pathname.split('/')[3];
    const configPath = path.join(TEMPLATES_DIR, id, 'config.json');
    if (!fs.existsSync(configPath)) { sendJson(res, 404, { error: 'Template not found' }); return; }
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      sendJson(res, 200, config);
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // GET /api/templates/:id/preview — serve preview image
  if (req.method === 'GET' && pathname.match(/^\/api\/templates\/([^/]+)\/preview$/)) {
    const id = pathname.split('/')[3];
    const metaPath = path.join(TEMPLATES_DIR, id, 'meta.json');
    let previewFile = 'preview.png';
    try { previewFile = JSON.parse(fs.readFileSync(metaPath, 'utf8')).preview || 'preview.png'; } catch (_) {}
    const previewPath = path.join(TEMPLATES_DIR, id, previewFile);
    if (!fs.existsSync(previewPath)) { sendResponse(res, 404, 'text/plain', 'No preview'); return; }
    const ext = path.extname(previewPath).toLowerCase();
    const ct = MIME_TYPES[ext] || 'application/octet-stream';
    fs.readFile(previewPath, (err, data) => {
      if (err) { sendResponse(res, 404, 'text/plain', 'Not found'); return; }
      sendResponse(res, 200, ct, data);
    });
    return;
  }

  // POST /api/templates/import — import a template
  if (req.method === 'POST' && pathname === '/api/templates/import') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { id, mode } = JSON.parse(body);
        const tplConfigPath = path.join(TEMPLATES_DIR, id, 'config.json');
        if (!fs.existsSync(tplConfigPath)) { sendJson(res, 404, { error: 'Template not found' }); return; }
        const tplConfig = JSON.parse(fs.readFileSync(tplConfigPath, 'utf8'));

        if (mode === 'replace') {
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(tplConfig, null, 2));
          sendJson(res, 200, { status: 'success', message: 'Template imported (replace)' });
        } else if (mode === 'merge') {
          let currentConfig = { canvas: { width: 1920, height: 1080 }, widgets: [] };
          try { currentConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
          // Find max Y of existing widgets
          let maxY = 0;
          for (const w of (currentConfig.widgets || [])) {
            const bottom = (w.y || 0) + (w.height || 100);
            if (bottom > maxY) maxY = bottom;
          }
          const offset = maxY + 100;
          const newWidgets = (tplConfig.widgets || []).map(w => ({
            ...w,
            id: w.id + '-tpl-' + Date.now(),
            y: (w.y || 0) + offset
          }));
          currentConfig.widgets = [...(currentConfig.widgets || []), ...newWidgets];
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(currentConfig, null, 2));
          sendJson(res, 200, { status: 'success', message: `Merged ${newWidgets.length} widgets` });
        } else {
          sendJson(res, 400, { error: 'Invalid mode. Use "replace" or "merge"' });
        }
      } catch (e) { sendError(res, e.message); }
    });
    return;
  }

  // POST /api/templates/export — export current config as template
  // GET /api/quote - proxy for zenquotes.io (CORS blocked in browser)
  if (req.method === 'GET' && pathname === '/api/quote') {
    const https = require('https');
    https.get('https://zenquotes.io/api/random', { headers: { 'User-Agent': 'LobsterBoard/1.0' }, timeout: 5000 }, (proxyRes) => {
      let body = '';
      proxyRes.on('data', c => body += c);
      proxyRes.on('end', () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        sendResponse(res, 200, 'application/json', body);
      });
    }).on('error', (e) => {
      sendResponse(res, 200, 'application/json', JSON.stringify([{ q: 'Stay hungry, stay foolish.', a: 'Steve Jobs' }]));
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/latest-image') {
    return latestImageHandler(parsedUrl, res);
  }

  // GET /api/browse-dirs?dir=<path> - list subdirectories for folder picker
  if (req.method === 'GET' && pathname === '/api/browse-dirs') {
    const dir = parsedUrl.searchParams.get('dir') || os.homedir();
    const resolved = path.resolve(dir.replace(/^~/, os.homedir()));
    const home = os.homedir();
    if (!resolved.startsWith(home + path.sep) && resolved !== home) {
      return sendResponse(res, 200, 'application/json', JSON.stringify({ status: 'error', message: 'Must be under home directory' }));
    }
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b));
      const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
      const imageCount = fs.readdirSync(resolved).filter(f => imageExts.includes(path.extname(f).toLowerCase())).length;
      sendResponse(res, 200, 'application/json', JSON.stringify({ status: 'ok', path: resolved, dirs: entries, imageCount }));
    } catch (error) { sendResponse(res, 200, 'application/json', JSON.stringify({ status: 'error', message: error.message })); }
  }

  if (req.method === 'POST' && pathname === '/api/templates/export') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name, description, author, tags, widgetTypes } = JSON.parse(body);
        if (!name) { sendJson(res, 400, { error: 'Name is required' }); return; }
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const tplDir = path.join(TEMPLATES_DIR, id);
        fs.mkdirSync(tplDir, { recursive: true });

        // Read current config and strip sensitive data
        let config = { canvas: { width: 1920, height: 1080 }, widgets: [] };
        try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}

        const sensitiveKeys = ['apiKey', 'api_key', 'token', 'secret', 'password'];
        const privateIpRegex = /^https?:\/\/(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|localhost|127\.0\.0\.1)/i;
        // URLs that may contain private auth tokens — strip them in templates
        const privateUrlKeys = ['icalUrl'];
        const privateUrlPatterns = [/[?&/]private[-_]?[a-f0-9]/i, /caldav\.icloud\.com/i, /\/private\//i];

        function stripSensitive(props) {
          if (!props || typeof props !== 'object') return props;
          let stripped = false;
          const result = Array.isArray(props) ? [...props] : { ...props };
          for (const key of Object.keys(result)) {
            if (sensitiveKeys.includes(key)) {
              result[key] = 'YOUR_API_KEY_HERE';
              stripped = true;
            } else if ((key === 'url' || key === 'endpoint') && typeof result[key] === 'string' && privateIpRegex.test(result[key])) {
              result[key] = 'http://your-server:port/path';
              stripped = true;
            } else if (privateUrlKeys.includes(key) && typeof result[key] === 'string') {
              // Always strip private calendar/feed URLs — they contain auth tokens
              if (result[key] && (result[key].length > 0)) {
                const hasPrivateToken = privateUrlPatterns.some(p => p.test(result[key]));
                if (hasPrivateToken) {
                  result[key] = '';
                  stripped = true;
                }
              }
            } else if (typeof result[key] === 'object' && result[key] !== null) {
              const inner = stripSensitive(result[key]);
              result[key] = inner.result;
              if (inner.stripped) stripped = true;
            }
          }
          return { result, stripped };
        }

        const cleanWidgets = (config.widgets || []).map(w => {
          const cleaned = { ...w };
          if (cleaned.properties) {
            const { result, stripped } = stripSensitive(cleaned.properties);
            cleaned.properties = result;
            if (stripped) cleaned._templateNote = '⚠️ Configure this widget\'s settings after import';
          }
          return cleaned;
        });

        const cleanConfig = { canvas: config.canvas, widgets: cleanWidgets };
        fs.writeFileSync(path.join(tplDir, 'config.json'), JSON.stringify(cleanConfig, null, 2));

        const canvasSize = config.canvas ? `${config.canvas.width}x${config.canvas.height}` : '1920x1080';
        const meta = {
          id,
          name,
          description: description || '',
          author: author || 'anonymous',
          tags: tags || [],
          canvasSize,
          widgetCount: cleanWidgets.length,
          widgetTypes: widgetTypes || [],
          requiresSetup: [],
          preview: 'preview.png'
        };
        fs.writeFileSync(path.join(tplDir, 'meta.json'), JSON.stringify(meta, null, 2));

        // Rebuild templates.json
        const templates = scanTemplates(TEMPLATES_DIR);
        fs.writeFileSync(path.join(TEMPLATES_DIR, 'templates.json'), JSON.stringify(templates, null, 2));

        sendJson(res, 200, { status: 'success', id, message: `Template "${name}" exported` });
      } catch (e) { sendError(res, e.message); }
    });
    return;
  }

  // POST /api/templates/:id/screenshot — upload preview image
  if (req.method === 'POST' && pathname.match(/^\/api\/templates\/[^/]+\/screenshot$/)) {
    const tplId = pathname.split('/')[3];
    const tplDir = path.join(TEMPLATES_DIR, tplId);
    if (!fs.existsSync(tplDir)) { sendJson(res, 404, { error: 'Template not found' }); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { data } = JSON.parse(body);
        const match = data.match(/^data:image\/(\w+);base64,(.+)$/);
        if (!match) { sendJson(res, 400, { error: 'Invalid image data' }); return; }
        const buf = Buffer.from(match[2], 'base64');
        fs.writeFileSync(path.join(tplDir, 'preview.png'), buf);
        sendJson(res, 200, { status: 'ok' });
      } catch (e) { sendError(res, e.message); }
    });
    return;
  }

  // DELETE /api/templates/:id — delete a template
  if (req.method === 'DELETE' && pathname.match(/^\/api\/templates\/[^/]+$/)) {
    const tplId = pathname.split('/')[3];
    const tplDir = path.join(TEMPLATES_DIR, tplId);
    if (!fs.existsSync(tplDir)) { sendJson(res, 404, { error: 'Template not found' }); return; }
    try {
      fs.rmSync(tplDir, { recursive: true, force: true });
      sendJson(res, 200, { status: 'success', message: `Template "${tplId}" deleted` });
    } catch (e) { sendError(res, e.message); }
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, pathname);
  if (pathname === '/') {
    filePath = path.join(__dirname, 'app.html');
  }

  // Prevent path traversal — ensure resolved path stays within __dirname
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(__dirname + path.sep) && resolved !== __dirname) {
    sendResponse(res, 403, 'text/plain', 'Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        sendResponse(res, 404, 'text/plain', 'Not Found');
      } else {
        sendError(res, `Server error: ${err.message}`);
      }
      return;
    }
    sendResponse(res, 200, contentType, data);
  });
});

// GET /api/latest-image?dir=<path> - newest image from a directory
// (inserted before graceful shutdown)
const latestImageHandler = (parsedUrl, res) => {
  const dir = parsedUrl.searchParams.get('dir');
  if (!dir) return sendResponse(res, 200, 'application/json', JSON.stringify({ status: 'error', message: 'Missing dir parameter' }));
  const resolved = path.resolve(dir.replace(/^~/, os.homedir()));
  const home = os.homedir();
  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    return sendResponse(res, 200, 'application/json', JSON.stringify({ status: 'error', message: 'Directory must be under home' }));
  }
  try {
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    const files = fs.readdirSync(resolved)
      .filter(f => imageExts.includes(path.extname(f).toLowerCase()))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(resolved, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return sendResponse(res, 200, 'application/json', JSON.stringify({ status: 'ok', image: null, message: 'No images found' }));
    const latest = files[0];
    const ext = path.extname(latest.name).toLowerCase().replace('.', '');
    const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const data = fs.readFileSync(path.join(resolved, latest.name));
    const b64 = data.toString('base64');
    sendResponse(res, 200, 'application/json', JSON.stringify({ status: 'ok', image: { name: latest.name, mtime: latest.mtime, dataUrl: `data:${mime};base64,${b64}` }, total: files.length }));
  } catch (error) { sendResponse(res, 200, 'application/json', JSON.stringify({ status: 'error', message: error.message })); }
};

// Graceful shutdown
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

server.listen(PORT, HOST, () => {
  console.log(`
🦞 LobsterBoard Builder Server running at http://${HOST}:${PORT}

   Press Ctrl+C to stop
`);
});
