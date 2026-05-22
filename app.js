/**
 * PETA INTERAKTIF INDONESIA
 * app.js — Main Application Logic
 *
 * Architecture:
 *  - State: persisted in localStorage (pinpoints, connections)
 *  - MapView: pan/zoom on an SVG canvas
 *  - PinManager: add / render / delete pinpoints
 *  - ConnectManager: connect pinpoints with transport lines
 *  - RouteEngine: Yen's K-Shortest Paths algorithm (up to 10 routes)
 *  - UI helpers: popups, toast, autocomplete
 */

'use strict';

/* ============================================================
   CONSTANTS
   ============================================================ */
const TRANSPORT = {
  train: { label: 'Kereta Api', icon: '🚂', color: '#33E339', speed: 120, cost: 500  },
  bus:   { label: 'Bus',        icon: '🚌', color: '#A83BE8', speed: 80,  cost: 100  },
  plane: { label: 'Pesawat',    icon: '✈️',  color: '#c9d1d9', speed: 800, cost: 1000 },
};

const LS_PINS  = 'imap_pins_v2';
const LS_CONNS = 'imap_conns_v2';
const MAX_ROUTES = 10;

/* ============================================================
   STATE
   ============================================================ */
let pins        = [];   // [{ id, name, x, y }]
let connections = [];   // [{ id, fromId, toId, transport, distance }]
let selectedConnId = null;  // currently selected connection line id
let connectingFrom = null;  // pin id currently in connecting mode

// Pan / zoom state
const view = { x: 0, y: 0, scale: 1 };
let isPanning = false;
let panStart  = { x: 0, y: 0 };

// Pending add-location position
let pendingAddPos = null;

// Sort mode
let sortMode = 'time'; // 'time' | 'cost'

/* ============================================================
   PERSISTENCE
   ============================================================ */
function saveState() {
  localStorage.setItem(LS_PINS,  JSON.stringify(pins));
  localStorage.setItem(LS_CONNS, JSON.stringify(connections));
}

function loadState() {
  try { pins        = JSON.parse(localStorage.getItem(LS_PINS))  || []; } catch { pins = []; }
  try { connections = JSON.parse(localStorage.getItem(LS_CONNS)) || []; } catch { connections = []; }
}

/* ============================================================
   SVG HELPERS
   ============================================================ */
const svgEl   = document.getElementById('map-svg');
const connL   = document.getElementById('connections-layer');
const pinL    = document.getElementById('pinpoints-layer');
const mapBase = document.getElementById('map-base');

function svgNS(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Convert screen coordinates to SVG/map coordinates */
function screenToMap(sx, sy) {
  return {
    x: (sx - view.x) / view.scale,
    y: (sy - view.y) / view.scale,
  };
}

/** Apply current pan/zoom transform to the two layers */
function applyTransform() {
  const t = `translate(${view.x}, ${view.y}) scale(${view.scale})`;
  connL.setAttribute('transform', t);
  pinL.setAttribute('transform', t);
  mapBase.setAttribute('transform', t);
}

/* ============================================================
   MAP BACKGROUND (inline SVG Indonesia)
   Load external SVG; fall back to placeholder rectangle
   ============================================================ */
async function loadMapSVG() {
  try {
    const resp = await fetch('indonesia.svg');
    if (!resp.ok) throw new Error('not found');
    const text = await resp.text();
    const parser = new DOMParser();
    const doc    = parser.parseFromString(text, 'image/svg+xml');
    const src    = doc.documentElement;

    // Copy all child elements into mapBase
    Array.from(src.children).forEach(child => {
      const imported = document.importNode(child, true);
      mapBase.appendChild(imported);
    });

    // Fit to viewport
    const vb = src.getAttribute('viewBox');
    fitMapToViewport(vb);
  } catch {
    // Fallback: draw a simple placeholder
    drawFallbackMap();
  }
}

function fitMapToViewport(viewBoxStr) {
  if (!viewBoxStr) return;
  const [, , vw, vh] = viewBoxStr.split(' ').map(Number);
  const sw = svgEl.clientWidth  || window.innerWidth  - 310;
  const sh = svgEl.clientHeight || window.innerHeight;
  const scaleX = sw / vw;
  const scaleY = sh / vh;
  const s = Math.max(scaleX, scaleY) * 1.05;
  view.scale = s;
  view.x = (sw - vw * s) / 2;
  view.y = (sh - vh * s) / 2;
  applyTransform();
}

function drawFallbackMap() {
  // Simple stylized Indonesia placeholder using basic shapes
  const g = svgNS('g');

  // Ocean background
  const ocean = svgNS('rect', {
    x: -2000, y: -2000,
    width: 6000, height: 5000,
    fill: '#1a3a5c',
  });
  g.appendChild(ocean);

  // Simplified island blobs (Sumatra, Jawa, Kalimantan, Sulawesi, Papua, Bali etc.)
  const islands = [
    // Sumatra
    'M 20,180 Q 60,120 180,80 Q 300,50 420,100 Q 480,150 440,220 Q 380,280 260,300 Q 140,310 60,260 Z',
    // Jawa
    'M 280,340 Q 360,310 500,320 Q 620,330 700,360 Q 730,390 680,410 Q 580,430 440,420 Q 320,400 270,370 Z',
    // Kalimantan
    'M 480,120 Q 560,60 680,50 Q 800,45 880,100 Q 940,160 920,280 Q 890,360 800,400 Q 700,430 600,400 Q 500,360 470,270 Q 450,190 480,120 Z',
    // Sulawesi
    'M 920,140 Q 960,100 1000,120 Q 1020,160 1000,220 Q 980,260 940,280 Q 910,270 900,230 Q 890,180 920,140 Z',
    // Papua
    'M 1100,160 Q 1200,100 1380,120 Q 1480,150 1500,220 Q 1490,300 1400,340 Q 1280,360 1160,320 Q 1080,280 1080,220 Q 1085,180 1100,160 Z',
    // Bali
    'M 720,370 Q 750,360 770,375 Q 775,395 750,400 Q 725,400 720,370 Z',
    // Lombok-Flores
    'M 790,375 Q 820,362 860,370 Q 870,385 850,395 Q 820,400 795,390 Z',
    // Maluku (small dots)
    'M 1050,220 Q 1060,210 1070,218 Q 1072,228 1060,232 Z',
    'M 1080,250 Q 1092,240 1100,248 Q 1102,260 1090,264 Z',
  ];

  islands.forEach(d => {
    const path = svgNS('path', {
      d,
      fill: '#2d6a4f',
      stroke: '#1b4332',
      'stroke-width': '2',
    });
    g.appendChild(path);
  });

  mapBase.appendChild(g);

  // Fit
  view.scale = 1;
  view.x = -50;
  view.y = -30;
  applyTransform();
}

/* ============================================================
   PAN & ZOOM
   ============================================================ */
const MIN_SCALE = 0.3;
const MAX_SCALE = 10;

function clampScale(s) { return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)); }

svgEl.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();

  const rect = svgEl.getBoundingClientRect();
  const mx   = e.clientX - rect.left;
  const my   = e.clientY - rect.top;

  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  const newScale = clampScale(view.scale * factor);

  // Zoom toward cursor
  view.x = mx - (mx - view.x) * (newScale / view.scale);
  view.y = my - (my - view.y) * (newScale / view.scale);
  view.scale = newScale;
  applyTransform();
}, { passive: false });

// CTRL + / CTRL - keyboard zoom
document.addEventListener('keydown', e => {
  if (!e.ctrlKey) return;
  if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    zoomCenter(1.15);
  } else if (e.key === '-') {
    e.preventDefault();
    zoomCenter(0.87);
  }
});

function zoomCenter(factor) {
  const sw = svgEl.clientWidth  / 2;
  const sh = svgEl.clientHeight / 2;
  const newScale = clampScale(view.scale * factor);
  view.x = sw - (sw - view.x) * (newScale / view.scale);
  view.y = sh - (sh - view.y) * (newScale / view.scale);
  view.scale = newScale;
  applyTransform();
}

// Pan: mouse drag
svgEl.addEventListener('mousedown', e => {
  // Ignore if clicking on an interactive element
  if (e.target.closest('.pin-group, .pin-label-group, .conn-line, .conn-label')) return;
  if (e.button !== 0) return;
  isPanning = true;
  panStart = { x: e.clientX - view.x, y: e.clientY - view.y };
  svgEl.parentElement.classList.add('panning');
});

window.addEventListener('mousemove', e => {
  if (!isPanning) return;
  view.x = e.clientX - panStart.x;
  view.y = e.clientY - panStart.y;
  applyTransform();
});

window.addEventListener('mouseup', () => {
  isPanning = false;
  svgEl.parentElement.classList.remove('panning');
});

// Double-click on map → add location
svgEl.addEventListener('dblclick', e => {
  if (e.target.closest('.pin-group, .pin-label-group, .conn-line')) return;
  e.preventDefault();

  const rect = svgEl.getBoundingClientRect();
  const sx   = e.clientX - rect.left;
  const sy   = e.clientY - rect.top;
  pendingAddPos = screenToMap(sx, sy);

  openAddPopup();
});

/* ============================================================
   PIN RENDERING
   ============================================================ */
function renderAllPins() {
  pinL.innerHTML = '';
  pins.forEach(renderPin);
}

function renderPin(pin) {
  const isConnecting = connectingFrom === pin.id;

  // Root group — hover reveals the label
  const g = svgNS('g', {
    'class': 'pin-group',
    'data-pin-id': pin.id,
  });

  // Pin icon (always visible)
  const icon = svgNS('text', {
    'class': 'pin-icon',
    x: pin.x,
    y: pin.y - 16,
    'font-size': '26',
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
  });
  icon.textContent = '📍';
  g.appendChild(icon);

  // Invisible hit-area so hover is easy to trigger around the pin
  const hitArea = svgNS('circle', {
    cx: pin.x, cy: pin.y - 10, r: '20',
    fill: 'transparent', 'pointer-events': 'all',
  });
  g.appendChild(hitArea);

  // Label group (hidden by default, shown on hover)
  const LX     = pin.x + 14;
  const LY     = pin.y - 18;
  const PAD    = 8;
  const H      = 28;
  const BTN_W  = 22;
  const TEXT_W = estimateTextWidth(pin.name, 12) + PAD * 2;
  const TOTAL_W = TEXT_W + BTN_W * 2 + 6;

  const labelG = svgNS('g', {
    'class': isConnecting
      ? 'pin-label-group pin-label-connecting'
      : 'pin-label-group pin-label-hidden',
    'data-pin-id': pin.id,
  });

  // Background rect
  const bg = svgNS('rect', {
    'class': 'pin-label-bg',
    x: LX, y: LY - H / 2,
    width: TOTAL_W, height: H,
    rx: 8, ry: 8,
  });
  labelG.appendChild(bg);

  // Name text
  const txt = svgNS('text', {
    'class': 'pin-label-text',
    x: LX + PAD, y: LY,
    'font-size': '12',
  });
  txt.textContent = pin.name;
  labelG.appendChild(txt);

  // Connect button
  const connectBtn = svgNS('text', {
    'class': 'pin-btn',
    x: LX + TEXT_W + BTN_W / 2,
    y: LY, 'font-size': '14',
  });
  connectBtn.textContent = isConnecting ? '🔗' : '➕';
  connectBtn.addEventListener('click', e => { e.stopPropagation(); App.startConnect(pin.id); });
  labelG.appendChild(connectBtn);

  // Delete button
  const deleteBtn = svgNS('text', {
    'class': 'pin-btn',
    x: LX + TEXT_W + BTN_W + BTN_W / 2 + 4,
    y: LY, 'font-size': '13',
  });
  deleteBtn.textContent = '🗑️';
  deleteBtn.addEventListener('click', e => { e.stopPropagation(); App.deletePin(pin.id); });
  labelG.appendChild(deleteBtn);

  // Hover show/hide
  const showLabel = () => labelG.classList.remove('pin-label-hidden');
  const hideLabel = () => { if (!isConnecting) labelG.classList.add('pin-label-hidden'); };
  g.addEventListener('mouseenter', showLabel);
  g.addEventListener('mouseleave', hideLabel);
  labelG.addEventListener('mouseenter', showLabel);
  labelG.addEventListener('mouseleave', hideLabel);

  g.appendChild(labelG);

  // When in connecting mode, clicking any other pin sets it as target
  if (connectingFrom && connectingFrom !== pin.id) {
    g.style.cursor = 'pointer';
    g.addEventListener('click', e => {
      e.stopPropagation();
      App.selectConnectTarget(pin.id);
    });
  }

  pinL.appendChild(g);
}

function estimateTextWidth(text, fontSize) {
  // Rough estimate: avg char ~0.6 of font size for Plus Jakarta Sans
  return Math.max(60, text.length * fontSize * 0.6);
}

/* ============================================================
   CONNECTION RENDERING  (with parallel-line offset)
   ============================================================ */

/**
 * Return a canonical pair key regardless of direction.
 * e.g. pairKey('A','B') === pairKey('B','A')
 */
function pairKey(idA, idB) {
  return idA < idB ? `${idA}||${idB}` : `${idB}||${idA}`;
}

/**
 * For each unique pair, collect all connections that share it
 * and assign each an offset index so they spread out
 * perpendicular to the line.
 *
 * Offset spacing: 8 SVG units between parallel lines.
 * With N lines: offsets are centred around 0.
 * e.g. N=1 → [0], N=2 → [-4, +4], N=3 → [-8, 0, +8]
 */
function buildOffsetMap() {
  const SPACING = 9; // px in SVG space between parallel lines

  // Group connections by pair
  const groups = {}; // pairKey → [conn, ...]
  connections.forEach(conn => {
    const key = pairKey(conn.fromId, conn.toId);
    if (!groups[key]) groups[key] = [];
    groups[key].push(conn);
  });

  // Assign offset to each connection id
  const offsetMap = {}; // connId → { offset, totalInGroup }
  Object.values(groups).forEach(group => {
    const n = group.length;
    group.forEach((conn, i) => {
      // Centre the group around 0
      const offset = (i - (n - 1) / 2) * SPACING;
      offsetMap[conn.id] = { offset, total: n };
    });
  });

  return offsetMap;
}

function renderAllConnections() {
  connL.innerHTML = '';
  const offsetMap = buildOffsetMap();
  connections.forEach(conn => renderConnection(conn, offsetMap));
}

/**
 * Render a single connection as a quadratic Bézier curve with
 * a perpendicular offset so parallel connections don't overlap.
 *
 * Curve strategy: the control point is placed perpendicular to
 * the midpoint. For a single connection the curve is gentle;
 * parallel connections already have an offset so their curves
 * arc in opposite directions naturally.
 */
function renderConnection(conn, offsetMap) {
  const from = pins.find(p => p.id === conn.fromId);
  const to   = pins.find(p => p.id === conn.toId);
  if (!from || !to) return;

  const t          = TRANSPORT[conn.transport];
  const isSelected = selectedConnId === conn.id;
  const { offset, total } = offsetMap[conn.id] || { offset: 0, total: 1 };

  // Direction vector
  const dx  = to.x - from.x;
  const dy  = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;

  // Perpendicular unit vector
  const px = -dy / len;
  const py =  dx / len;

  // Offset endpoints perpendicular to the line
  const x1 = from.x + px * offset;
  const y1 = from.y + py * offset;
  const x2 = to.x   + px * offset;
  const y2 = to.y   + py * offset;

  // Midpoint
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;

  // Curve bulge: control point perpendicular at midpoint
  // Single lines get a small aesthetic curve; multi-lines curve more
  const BULGE = total === 1 ? len * 0.18 : len * 0.12;
  const cx = mx + px * BULGE;
  const cy = my + py * BULGE;

  // SVG quadratic bezier: M x1,y1 Q cx,cy x2,y2
  const d = `M ${x1},${y1} Q ${cx},${cy} ${x2},${y2}`;

  // --- Curve path ---
  const path = svgNS('path', {
    'class': isSelected ? 'conn-line selected' : 'conn-line',
    'data-conn-id': conn.id,
    d,
    fill: 'none',
    stroke: t.color,
  });
  path.addEventListener('click', e => {
    e.stopPropagation();
    selectConnection(conn.id);
  });

  // --- Point at ~35% along the bezier curve for the transport icon ---
  // Quadratic bezier point: B(t) = (1-t)²P0 + 2(1-t)t·CP + t²P1
  const tI = 0.35;
  const iconX = (1-tI)*(1-tI)*x1 + 2*(1-tI)*tI*cx + tI*tI*x2;
  const iconY = (1-tI)*(1-tI)*y1 + 2*(1-tI)*tI*cy + tI*tI*y2;

  const iconEl = svgNS('text', {
    x: iconX, y: iconY,
    'font-size': '13',
    'text-anchor': 'middle',
    'dominant-baseline': 'middle',
    'pointer-events': 'none',
    style: 'user-select:none',
  });
  iconEl.textContent = t.icon;

  // --- Distance label at the midpoint of the curve (t=0.5) ---
  const tM = 0.5;
  const labelX = (1-tM)*(1-tM)*x1 + 2*(1-tM)*tM*cx + tM*tM*x2;
  const labelY = (1-tM)*(1-tM)*y1 + 2*(1-tM)*tM*cy + tM*tM*y2;

  const labelG = svgNS('g', { 'pointer-events': 'none' });
  const labelText = svgNS('text', {
    'class': 'conn-label',
    x: labelX,
    y: labelY,
    'font-size': '11',
    fill: t.color,
  });
  labelText.textContent = `${conn.distance} km`;
  labelG.appendChild(labelText);

  connL.appendChild(path);
  connL.appendChild(iconEl);
  connL.appendChild(labelG);
}

function selectConnection(id) {
  selectedConnId = (selectedConnId === id) ? null : id;
  renderAllConnections();
}

// Delete selected connection with DELETE/BACKSPACE
document.addEventListener('keydown', e => {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedConnId) {
    // Don't intercept if user is typing in an input
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    App.deleteConnection(selectedConnId);
  }
});

/* ============================================================
   ADD LOCATION POPUP
   ============================================================ */
const addPopup    = document.getElementById('add-popup');
const locationInput = document.getElementById('location-name-input');

function openAddPopup() {
  locationInput.value = '';
  addPopup.classList.remove('hidden');
  setTimeout(() => locationInput.focus(), 50);
}

locationInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') App.confirmAddLocation();
  if (e.key === 'Escape') App.cancelAddLocation();
});

/* ============================================================
   CONNECT POPUP
   ============================================================ */
const connectPopup    = document.getElementById('connect-popup');
const connectDesc     = document.getElementById('connect-desc');
const connectDistance = document.getElementById('connect-distance');
const connectTransport = document.getElementById('connect-transport');
let pendingConnectTo = null;

function openConnectPopup(fromPin, toPin) {
  connectDesc.textContent = `${fromPin.name} → ${toPin.name}`;
  connectDistance.value = '';
  connectTransport.value = 'train';
  connectPopup.classList.remove('hidden');
  setTimeout(() => connectDistance.focus(), 50);
}

connectDistance.addEventListener('keydown', e => {
  if (e.key === 'Enter') App.confirmConnect();
  if (e.key === 'Escape') App.cancelConnect();
});

/* ============================================================
   TOAST
   ============================================================ */
const toastEl = document.getElementById('toast');
let toastTimer;
function showToast(msg) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

/* ============================================================
   AUTOCOMPLETE
   ============================================================ */
const fromInput     = document.getElementById('from-input');
const toInput       = document.getElementById('to-input');
const fromSuggests  = document.getElementById('from-suggestions');
const toSuggests    = document.getElementById('to-suggestions');
const searchBtn     = document.getElementById('search-btn');

function setupAutocomplete(inputEl, suggestEl) {
  inputEl.addEventListener('input', () => {
    const q = inputEl.value.trim().toLowerCase();
    suggestEl.innerHTML = '';
    if (!q) { suggestEl.classList.remove('open'); validateSearchBtn(); return; }

    const matches = pins.filter(p => p.name.toLowerCase().includes(q));
    if (!matches.length) { suggestEl.classList.remove('open'); validateSearchBtn(); return; }

    matches.forEach(p => {
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      item.textContent = p.name;
      item.addEventListener('click', () => {
        inputEl.value = p.name;
        suggestEl.innerHTML = '';
        suggestEl.classList.remove('open');
        validateSearchBtn();
      });
      suggestEl.appendChild(item);
    });
    suggestEl.classList.add('open');
    validateSearchBtn();
  });

  inputEl.addEventListener('blur', () => {
    setTimeout(() => { suggestEl.classList.remove('open'); }, 150);
  });
}

function validateSearchBtn() {
  const fromName = fromInput.value.trim();
  const toName   = toInput.value.trim();
  const fromPin  = pins.find(p => p.name === fromName);
  const toPin    = pins.find(p => p.name === toName);
  searchBtn.disabled = !(fromPin && toPin && fromPin.id !== toPin.id);
}

fromInput.addEventListener('input', validateSearchBtn);
toInput.addEventListener('input', validateSearchBtn);

/* ============================================================
   ROUTE FINDER — YEN'S K-SHORTEST PATHS
   ============================================================ */

/**
 * Build adjacency list from connections.
 * Each connection is bidirectional.
 * Returns { nodeIds[], edges[] }
 */
function buildGraph() {
  const edges = [];
  connections.forEach(c => {
    const t = TRANSPORT[c.transport];
    const duration = c.distance / t.speed * 60; // minutes
    const cost     = c.distance * t.cost;        // Rupiah

    edges.push({ from: c.fromId, to: c.toId,   distance: c.distance, transport: c.transport, duration, cost, connId: c.id });
    edges.push({ from: c.toId,   to: c.fromId, distance: c.distance, transport: c.transport, duration, cost, connId: c.id });
  });
  return edges;
}

/**
 * Dijkstra's shortest path.
 * @param {string} src  - source pin id
 * @param {string} dst  - destination pin id
 * @param {Array}  edges
 * @param {string} metric - 'duration' | 'cost'
 * @param {Set}    blockedEdges - Set of "fromId-toId-transport" strings
 * @param {Set}    blockedNodes - Set of node ids (cannot visit)
 * @returns {path, totalMetric} or null
 */
function dijkstra(src, dst, edges, metric, blockedEdges = new Set(), blockedNodes = new Set()) {
  const dist  = {}; // node -> best metric value
  const prev  = {}; // node -> { node, edge }
  const visited = new Set();

  pins.forEach(p => { dist[p.id] = Infinity; });
  dist[src] = 0;

  const pq = [{ id: src, d: 0 }]; // simple priority queue

  while (pq.length) {
    // Extract minimum
    pq.sort((a, b) => a.d - b.d);
    const { id: u } = pq.shift();
    if (visited.has(u)) continue;
    visited.add(u);
    if (u === dst) break;

    for (const e of edges) {
      if (e.from !== u) continue;
      if (blockedNodes.has(e.to) && e.to !== dst) continue;
      const edgeKey = `${e.from}-${e.to}-${e.transport}`;
      if (blockedEdges.has(edgeKey)) continue;

      const alt = dist[u] + e[metric];
      if (alt < dist[e.to]) {
        dist[e.to] = alt;
        prev[e.to] = { node: u, edge: e };
        pq.push({ id: e.to, d: alt });
      }
    }
  }

  if (dist[dst] === Infinity) return null;

  // Reconstruct path
  const path = [];
  let cur = dst;
  while (cur !== src) {
    const p = prev[cur];
    path.unshift({ node: cur, edge: p.edge });
    cur = p.node;
  }
  path.unshift({ node: src, edge: null });

  return { path, total: dist[dst] };
}

/**
 * Yen's K-shortest loopless paths algorithm.
 * @param {string} src
 * @param {string} dst
 * @param {Array}  edges
 * @param {string} metric
 * @param {number} K
 */
function yenKShortest(src, dst, edges, metric, K) {
  const A = []; // confirmed shortest paths
  const B = []; // candidate paths (heap)

  const sp = dijkstra(src, dst, edges, metric);
  if (!sp) return [];
  A.push(sp);

  for (let k = 1; k < K; k++) {
    const prevPath = A[k - 1].path;

    for (let i = 0; i < prevPath.length - 1; i++) {
      const spurNode    = prevPath[i].node;
      const rootPath    = prevPath.slice(0, i + 1);
      const rootMetric  = i === 0 ? 0 : rootPath.slice(1).reduce((s, n) => s + n.edge[metric], 0);

      // Block edges used by previous shortest paths sharing the same root
      const blockedEdges = new Set();
      A.forEach(a => {
        if (a.path.length > i) {
          const aRoot = a.path.slice(0, i + 1).map(n => n.node).join(',');
          const thisRoot = rootPath.map(n => n.node).join(',');
          if (aRoot === thisRoot) {
            const e = a.path[i + 1]?.edge;
            if (e) blockedEdges.add(`${e.from}-${e.to}-${e.transport}`);
          }
        }
      });

      // Block root nodes (except spur node)
      const blockedNodes = new Set(rootPath.slice(0, -1).map(n => n.node));

      const spurResult = dijkstra(spurNode, dst, edges, metric, blockedEdges, blockedNodes);
      if (!spurResult) continue;

      // totalPath = rootPath + spurResult.path (excluding duplicate spurNode)
      const totalPath = [
        ...rootPath,
        ...spurResult.path.slice(1),
      ];
      const totalMetric = rootMetric + spurResult.total;

      // Avoid duplicates
      const pathKey = totalPath.map(n => n.node).join(',');
      const alreadyIn = [...A, ...B].some(p => p.path.map(n => n.node).join(',') === pathKey);
      if (!alreadyIn) {
        B.push({ path: totalPath, total: totalMetric });
      }
    }

    if (!B.length) break;
    B.sort((a, b) => a.total - b.total);
    A.push(B.shift());
  }

  return A;
}

/**
 * Format route results from yenKShortest output.
 */
function formatRouteResult(result, metric) {
  const { path } = result;
  const steps = [];

  for (let i = 1; i < path.length; i++) {
    const e = path[i].edge;
    const fromPin = pins.find(p => p.id === e.from);
    const toPin   = pins.find(p => p.id === e.to);
    steps.push({
      from:      fromPin.name,
      to:        toPin.name,
      transport: e.transport,
      distance:  e.distance,
      duration:  e.duration,
      cost:      e.cost,
    });
  }

  const totalDuration = steps.reduce((s, st) => s + st.duration, 0);
  const totalCost     = steps.reduce((s, st) => s + st.cost, 0);
  const nodeNames     = path.map(n => pins.find(p => p.id === n.node)?.name || '?');

  return { steps, totalDuration, totalCost, nodeNames };
}

/* ============================================================
   MAIN App OBJECT (public API)
   ============================================================ */
const App = {

  /* --- Init --- */
  init() {
    loadState();
    loadMapSVG().then(() => {
      renderAllConnections();
      renderAllPins();
    });
    setupAutocomplete(fromInput, fromSuggests);
    setupAutocomplete(toInput, toSuggests);
    validateSearchBtn();
  },

  /* --- Add Location --- */
  confirmAddLocation() {
    const name = locationInput.value.trim();
    if (!name) { showToast('Nama lokasi tidak boleh kosong.'); return; }
    if (pins.find(p => p.name.toLowerCase() === name.toLowerCase())) {
      showToast('Nama lokasi sudah ada.'); return;
    }
    if (!pendingAddPos) return;

    const pin = {
      id: 'pin_' + Date.now(),
      name,
      x: pendingAddPos.x,
      y: pendingAddPos.y,
    };
    pins.push(pin);
    saveState();
    addPopup.classList.add('hidden');
    renderAllPins();
    validateSearchBtn();
    showToast(`📍 "${name}" ditambahkan!`);
  },

  cancelAddLocation() {
    addPopup.classList.add('hidden');
    pendingAddPos = null;
  },

  /* --- Delete Pin --- */
  deletePin(pinId) {
    const pin = pins.find(p => p.id === pinId);
    if (!pin) return;
    pins = pins.filter(p => p.id !== pinId);
    connections = connections.filter(c => c.fromId !== pinId && c.toId !== pinId);
    if (connectingFrom === pinId) connectingFrom = null;
    if (selectedConnId) {
      const stillExists = connections.find(c => c.id === selectedConnId);
      if (!stillExists) selectedConnId = null;
    }
    saveState();
    renderAllConnections();
    renderAllPins();
    validateSearchBtn();
    showToast(`🗑️ "${pin.name}" dihapus.`);
  },

  /* --- Connect Locations --- */
  startConnect(pinId) {
    if (connectingFrom === pinId) {
      connectingFrom = null;
    } else {
      connectingFrom = pinId;
      showToast('Klik lokasi tujuan untuk menghubungkan.');
    }
    renderAllPins();
  },

  selectConnectTarget(targetPinId) {
    if (!connectingFrom) return;
    pendingConnectTo = targetPinId;
    const fromPin = pins.find(p => p.id === connectingFrom);
    const toPin   = pins.find(p => p.id === targetPinId);
    openConnectPopup(fromPin, toPin);
  },

  confirmConnect() {
    const dist = parseFloat(connectDistance.value);
    if (!dist || dist <= 0) { showToast('Masukkan jarak yang valid (km).'); return; }
    const transport = connectTransport.value;

    // Check duplicate (same pair + same transport)
    const exists = connections.find(c =>
      c.transport === transport &&
      ((c.fromId === connectingFrom && c.toId === pendingConnectTo) ||
       (c.fromId === pendingConnectTo && c.toId === connectingFrom))
    );
    if (exists) { showToast('Koneksi dengan mode ini sudah ada.'); return; }

    const conn = {
      id: 'conn_' + Date.now(),
      fromId: connectingFrom,
      toId: pendingConnectTo,
      transport,
      distance: dist,
    };
    connections.push(conn);
    saveState();
    connectPopup.classList.add('hidden');
    connectingFrom = null;
    pendingConnectTo = null;
    renderAllConnections();
    renderAllPins();
    showToast('✅ Koneksi ditambahkan!');
  },

  cancelConnect() {
    connectPopup.classList.add('hidden');
    connectingFrom = null;
    pendingConnectTo = null;
    renderAllPins();
  },

  /* --- Delete Connection --- */
  deleteConnection(connId) {
    connections = connections.filter(c => c.id !== connId);
    selectedConnId = null;
    saveState();
    renderAllConnections();
    showToast('🗑️ Koneksi dihapus.');
  },

  /* --- Route Finder --- */
  setSortMode(mode) {
    sortMode = mode;
    document.getElementById('sort-time').classList.toggle('active', mode === 'time');
    document.getElementById('sort-cost').classList.toggle('active', mode === 'cost');
    // Re-run search if we have results
    const results = document.getElementById('route-results');
    if (results.innerHTML) this.findRoutes();
  },

  findRoutes() {
    const fromName = fromInput.value.trim();
    const toName   = toInput.value.trim();
    const fromPin  = pins.find(p => p.name === fromName);
    const toPin    = pins.find(p => p.name === toName);

    if (!fromPin || !toPin) { showToast('Nama lokasi tidak valid.'); return; }

    const metric = sortMode === 'time' ? 'duration' : 'cost';
    const edges  = buildGraph();
    const routes = yenKShortest(fromPin.id, toPin.id, edges, metric, MAX_ROUTES);

    this.renderRouteResults(routes, fromName, toName);
  },

  renderRouteResults(routes, fromName, toName) {
    const container = document.getElementById('route-results');

    if (!routes.length) {
      container.innerHTML = `<div class="no-routes">Tidak ada rute yang ditemukan antara <strong>${fromName}</strong> dan <strong>${toName}</strong>.</div>`;
      return;
    }

    // Find globally fastest / cheapest for badges
    const allFormatted = routes.map(r => formatRouteResult(r, sortMode));
    const minDuration  = Math.min(...allFormatted.map(r => r.totalDuration));
    const minCost      = Math.min(...allFormatted.map(r => r.totalCost));

    container.innerHTML = `<p style="font-size:11px;color:var(--text-muted);padding:4px 0 8px;text-align:center;">${routes.length} rute ditemukan</p>`;

    allFormatted.forEach((r, idx) => {
      const isFastest  = r.totalDuration === minDuration;
      const isCheapest = r.totalCost === minCost;

      const routeName = r.nodeNames.join(' → ');
      const durationStr = formatDuration(r.totalDuration);
      const costStr     = formatCost(r.totalCost);

      const stepsHTML = r.steps.map(s => {
        const t = TRANSPORT[s.transport];
        return `<div class="route-step">
          <span class="step-icon">${t.icon}</span>
          <span style="font-size:11px;color:var(--text)">${s.from}</span>
          <span class="step-line" style="border-top:2px solid ${t.color};flex:1;height:0;display:inline-block;vertical-align:middle;margin:0 4px;"></span>
          <span style="font-size:11px;color:var(--text)">${s.to}</span>
          <span style="font-size:10px;color:var(--text-muted);margin-left:4px;">${s.distance}km</span>
        </div>`;
      }).join('');

      let badges = '';
      if (isFastest)  badges += `<span class="route-badge badge-fastest">⚡ Tercepat</span>`;
      if (isCheapest) badges += `<span class="route-badge badge-cheapest">💰 Termurah</span>`;

      const card = document.createElement('div');
      card.className = 'route-card';
      card.innerHTML = `
        <div class="route-card-header">
          <div class="route-name">Rute ${idx + 1}: ${routeName}</div>
          <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end;">${badges}</div>
        </div>
        <div class="route-steps">${stepsHTML}</div>
        <div class="route-meta">
          <span>⏱ <strong>${durationStr}</strong></span>
          <span>💰 <strong>${costStr}</strong></span>
        </div>`;
      container.appendChild(card);
    });
  },
};

/* ============================================================
   FORMAT HELPERS
   ============================================================ */
function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} mnt`;
  return `${h} jam ${m} mnt`;
}

function formatCost(rp) {
  return 'Rp' + rp.toLocaleString('id-ID');
}

/* ============================================================
   BOOT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => App.init());
