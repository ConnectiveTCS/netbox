/**
 * Fibre Topology Canvas
 * Dark-theme, hardware-accelerated 2D canvas with pan/zoom/drag.
 * Mirrors the visual style of Innovace_Fibre_Visualizer.
 */

// ── Colour palette (one per manufacturer/role bucket) ─────────────────────
const PALETTE = [
  '#4A90D9', '#4A148C', '#1B5E20', '#E65100', '#880E4F',
  '#00695C', '#1565C0', '#6A1B9A', '#37474F', '#BF360C',
  '#006064', '#1A237E', '#33691E', '#4E342E', '#263238',
];

function hashColor(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── Node ──────────────────────────────────────────────────────────────────
class DeviceNode {
  constructor(data) {
    this.id       = data.id;
    this.label    = data.label || `Device ${data.id}`;
    this.url      = data.url;
    this.manufacturer = data.manufacturer || '';
    this.deviceType   = data.device_type  || '';
    this.site     = data.site  || '';
    this.role     = data.role  || '';
    this.color    = hashColor(this.manufacturer || this.deviceType || String(this.id));

    this.ports = data.ports || [];

    this.x = data.x ?? 0;
    this.y = data.y ?? 0;
    this.width  = 190;
    this.height = 68;
    this.selected = false;
  }

  draw(ctx) {
    const { x, y, width: w, height: h, color, selected } = this;
    const r = 7;
    const [cr, cg, cb] = hexToRgb(color);

    // Drop shadow
    ctx.save();
    ctx.shadowColor  = `rgba(${cr},${cg},${cb},0.35)`;
    ctx.shadowBlur   = selected ? 20 : 10;
    ctx.shadowOffsetY = 3;

    // Body
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = '#161920';
    ctx.fill();

    // Border
    ctx.strokeStyle = selected ? '#ffffff' : color;
    ctx.lineWidth   = selected ? 2.5 : 1.5;
    ctx.stroke();
    ctx.restore();

    // Header bar
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, 24, [r, r, 0, 0]);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();

    // Device name in header
    ctx.save();
    ctx.font = 'bold 11px "Segoe UI", system-ui, monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = 'rgba(255,255,255,0.95)';
    ctx.fillText(this._clip(ctx, this.label, w - 12), x + w / 2, y + 12);
    ctx.restore();

    // Manufacturer + device type
    ctx.save();
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#8d9ab5';
    const sub = [this.manufacturer, this.deviceType].filter(Boolean).join(' · ');
    ctx.fillText(this._clip(ctx, sub, w - 10), x + w / 2, y + 38);
    ctx.restore();

    // Site / role footer
    if (this.site || this.role) {
      ctx.save();
      ctx.font = '9px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#4e5d75';
      const foot = [this.site, this.role].filter(Boolean).join(' — ');
      ctx.fillText(this._clip(ctx, foot, w - 10), x + w / 2, y + 56);
      ctx.restore();
    }
  }

  _clip(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  hitTest(wx, wy) {
    return wx >= this.x && wx <= this.x + this.width
        && wy >= this.y && wy <= this.y + this.height;
  }

  centre() {
    return { x: this.x + this.width / 2, y: this.y + this.height / 2 };
  }
}

// ── Edge ──────────────────────────────────────────────────────────────────
class CableEdge {
  constructor(data, srcNode, tgtNode) {
    this.id         = data.id;
    this.label      = data.label || '';
    this.srcNode    = srcNode;
    this.tgtNode    = tgtNode;
    this.srcPort    = data.source_port || '';
    this.tgtPort    = data.target_port || '';

    // Cable colour from NetBox (hex without #) or fallback
    const raw = data.color ? data.color.replace('#', '') : '';
    this.color = raw.length >= 6 ? `#${raw}` : '#3d6fa8';

    this.edgeIndex  = 0;
    this.totalEdges = 1;
  }

  draw(ctx) {
    if (!this.srcNode || !this.tgtNode) return;
    const sc = this.srcNode.centre();
    const tc = this.tgtNode.centre();

    // Self-loop guard
    if (sc.x === tc.x && sc.y === tc.y) return;

    // Perpendicular offset for parallel cables
    const dx = tc.x - sc.x;
    const dy = tc.y - sc.y;
    const len = Math.hypot(dx, dy) || 1;
    const px  = -dy / len;
    const py  =  dx / len;
    const offset = (this.edgeIndex - (this.totalEdges - 1) / 2) * 14;

    // Control point (quad bezier midpoint, pushed perpendicular)
    const mx = (sc.x + tc.x) / 2 + px * (offset * 2.5);
    const my = (sc.y + tc.y) / 2 + py * (offset * 2.5);

    ctx.beginPath();
    ctx.moveTo(sc.x, sc.y);
    ctx.quadraticCurveTo(mx, my, tc.x, tc.y);
    ctx.strokeStyle = this.color;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Arrow head at target
    this._arrowHead(ctx, mx, my, tc.x, tc.y);

    // Label at curve midpoint
    if (this.label) {
      const lx = 0.25 * sc.x + 0.5 * mx + 0.25 * tc.x;
      const ly = 0.25 * sc.y + 0.5 * my + 0.25 * tc.y;
      ctx.save();
      ctx.font         = '9px monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#6b7a99';
      ctx.fillText(this.label, lx, ly - 7);
      ctx.restore();
    }
  }

  _arrowHead(ctx, cx, cy, tx, ty) {
    const angle = Math.atan2(ty - cy, tx - cx);
    const size  = 7;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(
      tx - size * Math.cos(angle - Math.PI / 6),
      ty - size * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      tx - size * Math.cos(angle + Math.PI / 6),
      ty - size * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.restore();
  }
}

// ── CanvasManager ─────────────────────────────────────────────────────────
class CanvasManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');

    /** @type {Map<number, DeviceNode>} */
    this.nodes = new Map();
    /** @type {CableEdge[]} */
    this.edges = [];

    this.scale = 1;
    this.panX  = 0;
    this.panY  = 0;

    this._dragging  = null; // { node, ox, oy }
    this._panning   = null; // { sx, sy, px, py }
    this._dirty     = true;

    this.onSelectNode = null; // callback(node | null)

    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
    this._loop();
  }

  // ── Data loading ───────────────────────────────────────────────────────
  load(data) {
    this.nodes.clear();
    this.edges = [];

    const saved = _loadPositions();
    const noPos = [];

    for (const nd of data.nodes) {
      const pos  = saved[nd.id];
      const node = new DeviceNode({ ...nd, x: pos?.x ?? 0, y: pos?.y ?? 0 });
      this.nodes.set(nd.id, node);
      if (!pos) noPos.push(nd.id);
    }

    // Auto-layout nodes without saved positions
    _gridLayout(noPos.map(id => this.nodes.get(id)));

    // Build edges with parallel-edge indices
    const pairCount = new Map();
    for (const e of data.edges) {
      const key = _pairKey(e.source, e.target);
      pairCount.set(key, (pairCount.get(key) || 0) + 1);
    }
    const pairIdx = new Map();
    for (const e of data.edges) {
      const src  = this.nodes.get(e.source);
      const tgt  = this.nodes.get(e.target);
      if (!src || !tgt) continue;
      const key  = _pairKey(e.source, e.target);
      const idx  = pairIdx.get(key) || 0;
      pairIdx.set(key, idx + 1);
      const edge = new CableEdge(e, src, tgt);
      edge.edgeIndex  = idx;
      edge.totalEdges = pairCount.get(key);
      this.edges.push(edge);
    }

    this.fitView();
  }

  // ── View controls ──────────────────────────────────────────────────────
  fitView() {
    if (this.nodes.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    this.nodes.forEach(n => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });
    const pad = 70;
    const cw = this.canvas.width, ch = this.canvas.height;
    const scaleX = cw / (maxX - minX + pad * 2);
    const scaleY = ch / (maxY - minY + pad * 2);
    this.scale = Math.min(scaleX, scaleY, 1.8);
    this.panX  = (cw - (maxX - minX) * this.scale) / 2 - minX * this.scale;
    this.panY  = (ch - (maxY - minY) * this.scale) / 2 - minY * this.scale;
    this._dirty = true;
  }

  zoomBy(factor) {
    const cx = this.canvas.width  / 2;
    const cy = this.canvas.height / 2;
    const ns = Math.max(0.08, Math.min(4, this.scale * factor));
    this.panX = cx - (cx - this.panX) * (ns / this.scale);
    this.panY = cy - (cy - this.panY) * (ns / this.scale);
    this.scale = ns;
    this._dirty = true;
  }

  resetLayout() {
    _clearPositions();
    const nodes = [...this.nodes.values()];
    _gridLayout(nodes);
    this.fitView();
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.panX) / this.scale, y: (sy - this.panY) / this.scale };
  }

  // ── Rendering ──────────────────────────────────────────────────────────
  _loop() {
    if (this._dirty) { this._render(); this._dirty = false; }
    requestAnimationFrame(() => this._loop());
  }

  _render() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#0A0C10';
    ctx.fillRect(0, 0, w, h);

    // Grid
    _drawGrid(ctx, w, h, this.scale, this.panX, this.panY);

    // World transform
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);

    // Edges (beneath nodes)
    for (const e of this.edges) e.draw(ctx);

    // Nodes
    this.nodes.forEach(n => n.draw(ctx));

    ctx.restore();

    // HUD
    _drawHUD(ctx, w, h, this.scale, this.nodes.size, this.edges.length);
  }

  // ── Events ─────────────────────────────────────────────────────────────
  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('mousedown',   e => this._onDown(e));
    c.addEventListener('mousemove',   e => this._onMove(e));
    c.addEventListener('mouseup',     e => this._onUp(e));
    c.addEventListener('mouseleave',  e => this._onUp(e));
    c.addEventListener('wheel',       e => this._onWheel(e), { passive: false });
    c.addEventListener('dblclick',    () => this.fitView());
  }

  _canvasXY(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _onDown(e) {
    const s = this._canvasXY(e);
    const w = this.screenToWorld(s.x, s.y);
    let hit = null;
    // Iterate in reverse so topmost node wins
    const arr = [...this.nodes.values()].reverse();
    for (const n of arr) { if (n.hitTest(w.x, w.y)) { hit = n; break; } }

    this.nodes.forEach(n => n.selected = false);
    if (hit) {
      hit.selected   = true;
      this._dragging = { node: hit, ox: w.x - hit.x, oy: w.y - hit.y };
      this.canvas.style.cursor = 'grabbing';
      this.onSelectNode?.(hit);
    } else {
      this._panning = { sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY };
      this.canvas.style.cursor = 'grabbing';
      this.onSelectNode?.(null);
    }
    this._dirty = true;
  }

  _onMove(e) {
    if (this._dragging) {
      const s = this._canvasXY(e);
      const w = this.screenToWorld(s.x, s.y);
      this._dragging.node.x = w.x - this._dragging.ox;
      this._dragging.node.y = w.y - this._dragging.oy;
      this._dirty = true;
    } else if (this._panning) {
      this.panX = this._panning.px + (e.clientX - this._panning.sx);
      this.panY = this._panning.py + (e.clientY - this._panning.sy);
      this._dirty = true;
    } else {
      const s = this._canvasXY(e);
      const w = this.screenToWorld(s.x, s.y);
      let over = false;
      this.nodes.forEach(n => { if (n.hitTest(w.x, w.y)) over = true; });
      this.canvas.style.cursor = over ? 'pointer' : 'default';
    }
  }

  _onUp() {
    if (this._dragging) _savePositions(this.nodes);
    this._dragging = null;
    this._panning  = null;
    this.canvas.style.cursor = 'default';
  }

  _onWheel(e) {
    e.preventDefault();
    const s = this._canvasXY(e);
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.max(0.08, Math.min(4, this.scale * f));
    this.panX = s.x - (s.x - this.panX) * (ns / this.scale);
    this.panY = s.y - (s.y - this.panY) * (ns / this.scale);
    this.scale  = ns;
    this._dirty = true;
  }

  _resize() {
    const p = this.canvas.parentElement;
    this.canvas.width  = p.clientWidth;
    this.canvas.height = p.clientHeight;
    this._dirty = true;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function _pairKey(a, b) { return `${Math.min(a, b)}_${Math.max(a, b)}`; }

function _gridLayout(nodes) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const padX = 250, padY = 120;
  nodes.forEach((n, i) => {
    n.x = (i % cols) * padX;
    n.y = Math.floor(i / cols) * padY;
  });
}

function _savePositions(nodeMap) {
  const pos = {};
  nodeMap.forEach((n, id) => { pos[id] = { x: n.x, y: n.y }; });
  try { localStorage.setItem('iff_topo_pos', JSON.stringify(pos)); } catch {}
}

function _loadPositions() {
  try { return JSON.parse(localStorage.getItem('iff_topo_pos') || '{}'); } catch { return {}; }
}

function _clearPositions() {
  try { localStorage.removeItem('iff_topo_pos'); } catch {}
}

function _drawGrid(ctx, w, h, scale, panX, panY) {
  const size = 40 * scale;
  const ox   = ((panX % size) + size) % size;
  const oy   = ((panY % size) + size) % size;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth   = 1;
  for (let x = ox - size; x < w + size; x += size) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = oy - size; y < h + size; y += size) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.restore();
}

function _drawHUD(ctx, w, h, scale, nodeCount, edgeCount) {
  const label = `${Math.round(scale * 100)}%  ·  ${nodeCount} devices  ·  ${edgeCount} cables`;
  ctx.save();
  ctx.font         = '10px monospace';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle    = 'rgba(255,255,255,0.18)';
  ctx.fillText(label, w - 10, h - 8);
  ctx.restore();
}

// ── Page boot ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const canvas       = document.getElementById('topo-canvas');
  const loading      = document.getElementById('topo-loading');
  const emptyMsg     = document.getElementById('topo-empty');
  const detail       = document.getElementById('topo-detail');
  const detailTitle  = document.getElementById('topo-detail-title');
  const detailBody   = document.getElementById('topo-detail-body');
  const filterSite   = document.getElementById('filter-site');
  const filterRole   = document.getElementById('filter-role');
  const connectBar   = document.getElementById('topo-connect-bar');
  const connectLabel = document.getElementById('topo-connect-label');

  const mgr = new CanvasManager(canvas);

  // ── Connect mode ───────────────────────────────────────────────
  const connectState = { active: false, fromNode: null, fromPort: null };

  function enterConnectMode(node, port) {
    connectState.active   = true;
    connectState.fromNode = node;
    connectState.fromPort = port;
    connectLabel.textContent = `${node.label} › ${port.name}`;
    connectBar.style.display = '';
  }

  function exitConnectMode() {
    connectState.active   = false;
    connectState.fromNode = null;
    connectState.fromPort = null;
    connectBar.style.display = 'none';
  }

  document.getElementById('btn-cancel-connect').addEventListener('click', () => {
    exitConnectMode();
    detail.classList.add('topo-detail-hidden');
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape') exitConnectMode(); });

  async function createCable(toPort) {
    const body = {
      a_terminations: [{ object_type: connectState.fromPort.object_type, object_id: connectState.fromPort.id }],
      b_terminations: [{ object_type: toPort.object_type, object_id: toPort.id }],
    };
    try {
      const res = await fetch('/api/dcim/cables/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': _csrf() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        const msgs = Object.entries(err)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
          .join('\n');
        alert(`Could not create cable:\n${msgs}`);
        return;
      }
      exitConnectMode();
      detail.classList.add('topo-detail-hidden');
      await loadTopology();
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  }

  // ── Detail panel ───────────────────────────────────────────────
  function renderDetail(node) {
    if (!node) { detail.classList.add('topo-detail-hidden'); return; }

    detailTitle.textContent = node.label;

    let html = [
      row('Manufacturer', node.manufacturer),
      row('Device type',  node.deviceType),
      row('Site',         node.site),
      row('Role',         node.role),
      `<div style="margin-top:8px"><a href="${node.url}" target="_blank">Open in NetBox ↗</a></div>`,
    ].join('');

    const ports = node.ports || [];
    if (ports.length > 0) {
      const isSource = connectState.active && connectState.fromNode?.id === node.id;
      const isTarget = connectState.active && connectState.fromNode?.id !== node.id;

      html += `<div style="margin-top:12px;border-top:1px solid #1e2330;padding-top:10px">
        <div style="font-size:11px;color:#5c6880;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">
          Ports (${ports.length})
        </div>`;

      ports.forEach((port, i) => {
        let btn = '';
        if (isTarget) {
          btn = `<button class="topo-port-btn select" data-idx="${i}">Select</button>`;
        } else if (!isSource) {
          btn = `<button class="topo-port-btn" data-idx="${i}">Connect</button>`;
        }
        html += `<div class="topo-port-row">
          <span class="topo-port-name">${_esc(port.name)}</span>
          <span class="topo-port-type">${port.type}</span>
          ${btn}
        </div>`;
      });

      html += '</div>';
    }

    detailBody.innerHTML = html;
    detail.classList.remove('topo-detail-hidden');

    detailBody.querySelectorAll('.topo-port-btn:not(.select)').forEach(btn => {
      btn.addEventListener('click', () => {
        const port = node.ports[+btn.dataset.idx];
        enterConnectMode(node, port);
        renderDetail(node);
      });
    });

    detailBody.querySelectorAll('.topo-port-btn.select').forEach(btn => {
      btn.addEventListener('click', () => createCable(node.ports[+btn.dataset.idx]));
    });
  }

  mgr.onSelectNode = renderDetail;

  function row(label, value) {
    if (!value) return '';
    return `<div class="topo-detail-row">
      <span class="topo-detail-label">${label}</span>
      <span class="topo-detail-value">${_esc(value)}</span>
    </div>`;
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  document.getElementById('btn-close-detail').addEventListener('click', () => {
    detail.classList.add('topo-detail-hidden');
  });

  document.getElementById('btn-zoom-in') .addEventListener('click', () => mgr.zoomBy(1.2));
  document.getElementById('btn-zoom-out').addEventListener('click', () => mgr.zoomBy(1 / 1.2));
  document.getElementById('btn-fit')     .addEventListener('click', () => mgr.fitView());
  document.getElementById('btn-reset-layout').addEventListener('click', () => mgr.resetLayout());

  // ── Load data ──────────────────────────────────────────────────
  async function loadTopology() {
    loading.style.display = '';
    emptyMsg.style.display = 'none';

    const params = new URLSearchParams();
    if (filterSite.value) params.set('site_id', filterSite.value);
    if (filterRole.value) params.set('role_id', filterRole.value);

    try {
      const res  = await fetch(`/api/plugins/innovace-fibre/topology/?${params}`, {
        headers: { 'X-CSRFToken': _csrf() },
      });
      const data = await res.json();

      if (!filterSite.dataset.populated) {
        for (const s of (data.filters?.sites || [])) {
          const o = document.createElement('option');
          o.value = s.id; o.textContent = s.name;
          filterSite.appendChild(o);
        }
        for (const r of (data.filters?.roles || [])) {
          const o = document.createElement('option');
          o.value = r.id; o.textContent = r.name;
          filterRole.appendChild(o);
        }
        filterSite.dataset.populated = '1';
        filterRole.dataset.populated = '1';
      }

      loading.style.display = 'none';
      if (!data.nodes || data.nodes.length === 0) {
        emptyMsg.style.display = '';
        emptyMsg.textContent = 'No devices with ports found. Add devices in NetBox and reload.';
        return;
      }
      mgr.load(data);
    } catch (err) {
      loading.style.display = 'none';
      emptyMsg.style.display = '';
      emptyMsg.textContent = `Failed to load topology: ${err.message}`;
      console.error(err);
    }
  }

  document.getElementById('btn-apply-filter').addEventListener('click', loadTopology);

  function _csrf() {
    return document.cookie.split(';').map(c => c.trim())
      .find(c => c.startsWith('csrftoken='))?.split('=')[1] ?? '';
  }

  loadTopology();
});
