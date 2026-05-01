/**
 * Fibre Topology Workspace
 * Canvas-based topology with explicit view/arrange/connect modes.
 */
import { BarcodeScanner, showSignalModal } from "./barcode_scanner.js";

const PALETTE = [
  "#4A90D9", "#4A148C", "#1B5E20", "#E65100", "#880E4F",
  "#00695C", "#1565C0", "#6A1B9A", "#37474F", "#BF360C",
  "#006064", "#1A237E", "#33691E", "#4E342E", "#263238",
];

function hashColor(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

function hexToRgb(hex) {
  const h = String(hex || "#3d6fa8").replace("#", "");
  const n = parseInt(
    h.length === 3 ? h.split("").map((c) => c + c).join("") : h,
    16,
  );
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

class DeviceNode {
  constructor(data) {
    this.id = data.id;
    this.label = data.label || `Device ${data.id}`;
    this.url = data.url || "";
    this.manufacturer = data.manufacturer || "";
    this.deviceType = data.device_type || "";
    this.site = data.site || "";
    this.siteId = data.site_id || null;
    this.rackId = data.rack_id || null;
    this.rack = data.rack || "Unracked";
    this.role = data.role || "";
    this.parentId = data.parent_id || null;
    this.parentBay = data.parent_bay || "";
    this.children = data.children || [];
    this.modules = data.modules || [];
    this.ports = data.ports || [];
    this.color = hashColor(this.role || this.rack || this.deviceType || this.id);
    this.x = data.x ?? 0;
    this.y = data.y ?? 0;
    this.width = 210;
    this.height = this.hasChildren() ? 82 : 68;
    this.selected = false;
    this.collapsed = this.hasChildren();
    this.hiddenByParent = false;
  }

  hasChildren() {
    return this.children.length > 0 || this.modules.length > 0;
  }

  visible() {
    return !this.hiddenByParent;
  }

  centre() {
    return { x: this.x + this.width / 2, y: this.y + this.height / 2 };
  }

  hitTest(wx, wy) {
    return (
      this.visible() &&
      wx >= this.x &&
      wx <= this.x + this.width &&
      wy >= this.y &&
      wy <= this.y + this.height
    );
  }

  toggleHitTest(wx, wy) {
    if (!this.hasChildren() || !this.visible()) return false;
    return wx >= this.x + 8 && wx <= this.x + 28 && wy >= this.y + 28 && wy <= this.y + 48;
  }

  draw(ctx) {
    if (!this.visible()) return;
    const { x, y, width: w, height: h, color, selected } = this;
    const r = 7;
    const [cr, cg, cb] = hexToRgb(color);
    const alpha = this.parentId ? 0.84 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = `rgba(${cr},${cg},${cb},0.35)`;
    ctx.shadowBlur = selected ? 20 : 10;
    ctx.shadowOffsetY = 3;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = this.parentId ? "#131923" : "#161920";
    ctx.fill();
    ctx.strokeStyle = selected ? "#ffffff" : color;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.roundRect(x, y, w, 24, [r, r, 0, 0]);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.font = 'bold 11px "Segoe UI", system-ui, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.fillText(this._clip(ctx, this.label, w - 14), x + w / 2, y + 12);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#8d9ab5";
    ctx.fillText(this._clip(ctx, [this.manufacturer, this.deviceType].filter(Boolean).join(" - "), w - 12), x + w / 2, y + 39);
    ctx.fillStyle = "#4e5d75";
    ctx.font = '9px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(this._clip(ctx, [this.rack, this.role].filter(Boolean).join(" - "), w - 12), x + w / 2, y + 57);
    ctx.restore();

    if (this.hasChildren()) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x + 8, y + 30, 20, 18, 4);
      ctx.fillStyle = this.collapsed ? "#20324b" : "#24402f";
      ctx.fill();
      ctx.strokeStyle = this.collapsed ? "#4a9eff" : "#34d399";
      ctx.stroke();
      ctx.fillStyle = "#d5e8ff";
      ctx.font = 'bold 13px "Segoe UI", system-ui';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.collapsed ? "+" : "-", x + 18, y + 39);
      ctx.font = '9px "Segoe UI", system-ui';
      ctx.fillStyle = "#6f809c";
      const count = this.children.length + this.modules.length;
      ctx.fillText(`${count} child${count === 1 ? "" : "ren"}`, x + w / 2, y + 73);
      ctx.restore();
    }
  }

  _clip(ctx, text, maxW) {
    if (!text) return "";
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 0 && ctx.measureText(t + "...").width > maxW) t = t.slice(0, -1);
    return t + "...";
  }
}

class CableEdge {
  constructor(data, srcNode, tgtNode, manager) {
    this.id = data.id;
    this.label = data.label || "";
    this.srcNode = srcNode;
    this.tgtNode = tgtNode;
    this.manager = manager;
    this.srcPort = data.source_port || "";
    this.tgtPort = data.target_port || "";
    this.srcSignal = data.source_signal_channel || 1;
    this.tgtSignal = data.target_signal_channel || 1;
    const raw = data.color ? data.color.replace("#", "") : "";
    this.color = raw.length >= 6 ? `#${raw}` : "#3d6fa8";
    this.edgeIndex = 0;
    this.totalEdges = 1;
    this.highlighted = false;
    this.hovered = false;
  }

  displayNodes() {
    return {
      src: this.manager.displayNodeFor(this.srcNode),
      tgt: this.manager.displayNodeFor(this.tgtNode),
      srcGhost: this.srcNode && !this.srcNode.visible(),
      tgtGhost: this.tgtNode && !this.tgtNode.visible(),
    };
  }

  _cp(sc, tc) {
    const dx = tc.x - sc.x;
    const dy = tc.y - sc.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const offset = (this.edgeIndex - (this.totalEdges - 1) / 2) * 14;
    return { mx: (sc.x + tc.x) / 2 + nx * offset * 2.5, my: (sc.y + tc.y) / 2 + ny * offset * 2.5, nx, ny };
  }

  geometry() {
    const { src, tgt } = this.displayNodes();
    if (!src || !tgt) return null;
    const sc = src.centre();
    const tc = tgt.centre();
    if (sc.x === tc.x && sc.y === tc.y) return null;
    const dx = tc.x - sc.x;
    const dy = tc.y - sc.y;
    const sa = _rectEdgePoint(sc.x, sc.y, dx, dy, src);
    const ta = _rectEdgePoint(tc.x, tc.y, -dx, -dy, tgt);
    return { sa, ta, ...this._cp(sc, tc) };
  }

  hitTest(wx, wy, threshold) {
    const g = this.geometry();
    if (!g) return false;
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      const mt = 1 - t;
      const bx = mt * mt * g.sa.x + 2 * mt * t * g.mx + t * t * g.ta.x;
      const by = mt * mt * g.sa.y + 2 * mt * t * g.my + t * t * g.ta.y;
      if (Math.hypot(wx - bx, wy - by) <= threshold) return true;
    }
    return false;
  }

  draw(ctx, pulsePhase = 0) {
    const g = this.geometry();
    if (!g) return;
    const drawColor = this.highlighted ? "#7dd3fc" : this.hovered ? "#bae6fd" : this.color;
    const width = this.highlighted ? 2.8 : this.hovered ? 2.2 : 1.35;
    ctx.save();
    if (this.highlighted || this.hovered) {
      ctx.shadowColor = drawColor;
      ctx.shadowBlur = this.highlighted ? 14 : 8;
    }
    ctx.beginPath();
    ctx.moveTo(g.sa.x, g.sa.y);
    ctx.quadraticCurveTo(g.mx, g.my, g.ta.x, g.ta.y);
    ctx.strokeStyle = drawColor;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();

    if (this.highlighted) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(g.sa.x, g.sa.y);
      ctx.quadraticCurveTo(g.mx, g.my, g.ta.x, g.ta.y);
      ctx.strokeStyle = "rgba(186,230,253,0.86)";
      ctx.lineWidth = 3.6;
      ctx.setLineDash([14, 28]);
      ctx.lineDashOffset = -pulsePhase;
      ctx.stroke();
      ctx.restore();
    }

    this._arrowHead(ctx, g.mx, g.my, g.ta.x, g.ta.y, drawColor);
    this._drawGhostEndpoint(ctx, g.sa, this.displayNodes().srcGhost);
    this._drawGhostEndpoint(ctx, g.ta, this.displayNodes().tgtGhost);
  }

  drawAnnotations(ctx, scale = 1) {
    const g = this.geometry();
    if (!g) return;
    const showLabels = this.highlighted || this.hovered || scale >= 0.72;
    const showPorts = this.highlighted || this.hovered || scale >= 1.05;
    if (!showLabels && !showPorts) return;
    const lx = 0.25 * g.sa.x + 0.5 * g.mx + 0.25 * g.ta.x;
    const ly = 0.25 * g.sa.y + 0.5 * g.my + 0.25 * g.ta.y;
    const fs = Math.max(8, Math.round(10 / Math.max(scale, 0.75)));
    ctx.save();
    ctx.font = `${fs}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 4;
    ctx.fillStyle = this.highlighted || this.hovered ? "#bae6fd" : "#9eaec8";
    if (showLabels && this.label) ctx.fillText(this.label, lx, ly - 8);
    if (showPorts) this._drawPortLabels(ctx, g, scale);
    ctx.restore();
  }

  _drawPortLabels(ctx, g) {
    const perp = 13;
    const draw = (text, t) => {
      const mt = 1 - t;
      const lx = mt * mt * g.sa.x + 2 * mt * t * g.mx + t * t * g.ta.x + g.nx * perp;
      const ly = mt * mt * g.sa.y + 2 * mt * t * g.my + t * t * g.ta.y + g.ny * perp;
      ctx.fillText(text, lx, ly);
    };
    if (this.srcPort) draw(`${this.srcPort}${this.srcSignal > 1 ? `:${this.srcSignal}` : ""}`, 0.15);
    if (this.tgtPort) draw(`${this.tgtPort}${this.tgtSignal > 1 ? `:${this.tgtSignal}` : ""}`, 0.85);
  }

  _drawGhostEndpoint(ctx, point, active) {
    if (!active) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.78)";
    ctx.fill();
    ctx.strokeStyle = "#7dd3fc";
    ctx.stroke();
    ctx.restore();
  }

  _arrowHead(ctx, cx, cy, tx, ty, color) {
    const angle = Math.atan2(ty - cy, tx - cx);
    const size = 7;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - size * Math.cos(angle - Math.PI / 6), ty - size * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(tx - size * Math.cos(angle + Math.PI / 6), ty - size * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }
}

class CanvasManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.nodes = new Map();
    this.edges = [];
    this.mode = "view";
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this._dragging = null;
    this._panning = null;
    this._dirty = true;
    this._pulse = 0;
    this._animating = false;
    this._hoverEdge = null;
    this.onSelectNode = null;
    this.onContextEdge = null;
    this.onLayoutChange = null;
    this.onHoverEdge = null;
    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
    this._loop();
  }

  load(data, layoutConfig = {}) {
    this.nodes.clear();
    this.edges = [];
    const savedNodes = layoutConfig.nodes || {};
    const savedCollapsed = layoutConfig.collapsed || {};
    for (const nd of data.nodes || []) {
      const pos = savedNodes[nd.id] || savedNodes[String(nd.id)];
      const node = new DeviceNode({ ...nd, x: pos?.x ?? 0, y: pos?.y ?? 0 });
      if (Object.prototype.hasOwnProperty.call(savedCollapsed, nd.id)) node.collapsed = !!savedCollapsed[nd.id];
      if (Object.prototype.hasOwnProperty.call(savedCollapsed, String(nd.id))) node.collapsed = !!savedCollapsed[String(nd.id)];
      this.nodes.set(nd.id, node);
    }
    const missing = [...this.nodes.values()].filter((n) => !savedNodes[n.id] && !savedNodes[String(n.id)]);
    if (missing.length) _rackLaneLayout(missing, this.nodes);
    this._applyHierarchyVisibility();

    const pairCount = new Map();
    for (const e of data.edges || []) pairCount.set(_pairKey(e.source, e.target), (pairCount.get(_pairKey(e.source, e.target)) || 0) + 1);
    const pairIdx = new Map();
    for (const e of data.edges || []) {
      const src = this.nodes.get(e.source);
      const tgt = this.nodes.get(e.target);
      if (!src || !tgt) continue;
      const key = _pairKey(e.source, e.target);
      const idx = pairIdx.get(key) || 0;
      pairIdx.set(key, idx + 1);
      const edge = new CableEdge(e, src, tgt, this);
      edge.edgeIndex = idx;
      edge.totalEdges = pairCount.get(key);
      this.edges.push(edge);
    }
    this.fitView();
  }

  setMode(mode) {
    this.mode = mode;
    this._dragging = null;
    this._panning = null;
    this.canvas.style.cursor = "default";
    this._dirty = true;
  }

  exportLayout() {
    const nodes = {};
    const collapsed = {};
    this.nodes.forEach((n, id) => {
      nodes[id] = { x: Math.round(n.x * 100) / 100, y: Math.round(n.y * 100) / 100 };
      if (n.hasChildren()) collapsed[id] = !!n.collapsed;
    });
    return { nodes, collapsed };
  }

  resetLayout() {
    _rackLaneLayout([...this.nodes.values()], this.nodes);
    this.nodes.forEach((n) => {
      if (n.hasChildren()) n.collapsed = true;
    });
    this._applyHierarchyVisibility();
    this.fitView();
    this.onLayoutChange?.();
  }

  displayNodeFor(node) {
    if (!node) return null;
    if (node.visible()) return node;
    let cur = node;
    while (cur?.parentId) {
      const parent = this.nodes.get(cur.parentId);
      if (!parent) break;
      if (parent.visible()) return parent;
      cur = parent;
    }
    return node;
  }

  selectNode(node, zoom = false) {
    this.nodes.forEach((n) => (n.selected = false));
    if (node) {
      this._ensureNodeVisible(node);
      node.selected = true;
      if (zoom) this.zoomToNode(node);
    }
    this.onSelectNode?.(node || null);
    this._dirty = true;
  }

  zoomToNode(node, targetScale = 1.25) {
    if (!node) return;
    this.scale = Math.max(0.25, Math.min(3.2, targetScale));
    this.panX = this.canvas.width / 2 - (node.x + node.width / 2) * this.scale;
    this.panY = this.canvas.height / 2 - (node.y + node.height / 2) * this.scale;
    this._dirty = true;
  }

  fitView() {
    const visible = [...this.nodes.values()].filter((n) => n.visible());
    if (!visible.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    visible.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });
    const pad = 90;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.scale = Math.min(cw / (maxX - minX + pad * 2), ch / (maxY - minY + pad * 2), 1.5);
    this.panX = (cw - (maxX - minX) * this.scale) / 2 - minX * this.scale;
    this.panY = (ch - (maxY - minY) * this.scale) / 2 - minY * this.scale;
    this._dirty = true;
  }

  zoomBy(factor) {
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    const ns = Math.max(0.08, Math.min(4, this.scale * factor));
    this.panX = cx - (cx - this.panX) * (ns / this.scale);
    this.panY = cy - (cy - this.panY) * (ns / this.scale);
    this.scale = ns;
    this._dirty = true;
  }

  screenToWorld(sx, sy) {
    return { x: (sx - this.panX) / this.scale, y: (sy - this.panY) / this.scale };
  }

  clearTrace() {
    this.edges.forEach((e) => (e.highlighted = false));
    this._animating = false;
    this._dirty = true;
  }

  highlightEdges(idSet) {
    this.edges.forEach((e) => (e.highlighted = idSet.has(e.id)));
    this._animating = idSet.size > 0;
    this._dirty = true;
  }

  _ensureNodeVisible(node) {
    const chain = [];
    let cur = node;
    while (cur?.parentId) {
      const parent = this.nodes.get(cur.parentId);
      if (!parent) break;
      chain.push(parent);
      cur = parent;
    }
    chain.forEach((parent) => (parent.collapsed = false));
    this._applyHierarchyVisibility();
  }

  _applyHierarchyVisibility() {
    this.nodes.forEach((n) => (n.hiddenByParent = false));
    this.nodes.forEach((n) => {
      if (!n.parentId) return;
      const parent = this.nodes.get(n.parentId);
      n.hiddenByParent = !!(parent && (parent.collapsed || parent.hiddenByParent));
      if (parent && !parent.collapsed) {
        const idx = [...this.nodes.values()].filter((x) => x.parentId === parent.id).indexOf(n);
        if (!Number.isFinite(n.x) || n.x === 0) n.x = parent.x + 34;
        if (!Number.isFinite(n.y) || n.y === 0) n.y = parent.y + parent.height + 18 + idx * 92;
      }
    });
  }

  _loop() {
    if (this._animating) {
      this._pulse = (performance.now() * 0.05) % 42;
      this._dirty = true;
    }
    if (this._dirty) {
      this._render();
      this._dirty = false;
    }
    requestAnimationFrame(() => this._loop());
  }

  _render() {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0A0C10";
    ctx.fillRect(0, 0, w, h);
    _drawGrid(ctx, w, h, this.scale, this.panX, this.panY);
    ctx.save();
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.scale, this.scale);
    _drawRackZones(ctx, [...this.nodes.values()].filter((n) => n.visible() && !n.parentId));
    for (const e of this.edges) e.draw(ctx, this._pulse);
    this.nodes.forEach((n) => n.draw(ctx));
    for (const e of this.edges) e.drawAnnotations(ctx, this.scale);
    ctx.restore();
    _drawHUD(ctx, w, h, this.scale, this.nodes.size, this.edges.length, this.mode);
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener("mousedown", (e) => this._onDown(e));
    c.addEventListener("mousemove", (e) => this._onMove(e));
    c.addEventListener("mouseup", () => this._onUp());
    c.addEventListener("mouseleave", () => this._onUp());
    c.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    c.addEventListener("dblclick", () => this.fitView());
    c.addEventListener("contextmenu", (e) => this._onContextMenu(e));
  }

  _canvasXY(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _hitNode(wx, wy) {
    const arr = [...this.nodes.values()].reverse();
    return arr.find((n) => n.hitTest(wx, wy)) || null;
  }

  _onContextMenu(e) {
    e.preventDefault();
    const s = this._canvasXY(e);
    const w = this.screenToWorld(s.x, s.y);
    const edge = this.edges.find((edge) => edge.hitTest(w.x, w.y, 8 / this.scale));
    if (edge && this.onContextEdge) this.onContextEdge(edge, e.clientX, e.clientY);
  }

  _onDown(e) {
    if (e.button !== 0) return;
    const s = this._canvasXY(e);
    const w = this.screenToWorld(s.x, s.y);
    const hit = this._hitNode(w.x, w.y);
    if (hit?.toggleHitTest(w.x, w.y)) {
      hit.collapsed = !hit.collapsed;
      this._applyHierarchyVisibility();
      this.selectNode(hit);
      this.onLayoutChange?.();
      return;
    }
    if (hit) {
      this.selectNode(hit);
      if (this.mode === "arrange") {
        this._dragging = { node: hit, ox: w.x - hit.x, oy: w.y - hit.y };
        this.canvas.style.cursor = "grabbing";
      }
    } else {
      this.selectNode(null);
      this._panning = { sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY };
      this.canvas.style.cursor = "grabbing";
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
      return;
    }
    if (this._panning) {
      this.panX = this._panning.px + (e.clientX - this._panning.sx);
      this.panY = this._panning.py + (e.clientY - this._panning.sy);
      this._dirty = true;
      return;
    }
    const s = this._canvasXY(e);
    const w = this.screenToWorld(s.x, s.y);
    const node = this._hitNode(w.x, w.y);
    const edge = !node ? this.edges.find((ed) => ed.hitTest(w.x, w.y, 6 / this.scale)) || null : null;
    if (edge !== this._hoverEdge) {
      if (this._hoverEdge) this._hoverEdge.hovered = false;
      this._hoverEdge = edge;
      if (edge) edge.hovered = true;
      this.onHoverEdge?.(edge);
      this._dirty = true;
    }
    this.canvas.style.cursor = node ? (this.mode === "arrange" ? "grab" : "pointer") : edge ? "context-menu" : "default";
  }

  _onUp() {
    if (this._dragging) this.onLayoutChange?.();
    this._dragging = null;
    this._panning = null;
    this.canvas.style.cursor = "default";
  }

  _onWheel(e) {
    e.preventDefault();
    const s = this._canvasXY(e);
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.max(0.08, Math.min(4, this.scale * f));
    this.panX = s.x - (s.x - this.panX) * (ns / this.scale);
    this.panY = s.y - (s.y - this.panY) * (ns / this.scale);
    this.scale = ns;
    this._dirty = true;
  }

  _resize() {
    const p = this.canvas.parentElement;
    this.canvas.width = p.clientWidth;
    this.canvas.height = p.clientHeight;
    this._dirty = true;
  }
}

function _pairKey(a, b) {
  return `${Math.min(a, b)}_${Math.max(a, b)}`;
}

function _rectEdgePoint(cx, cy, dx, dy, node) {
  const hw = node.width / 2;
  const hh = node.height / 2;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  let t = Infinity;
  if (dx > 0) t = Math.min(t, hw / dx);
  if (dx < 0) t = Math.min(t, -hw / dx);
  if (dy > 0) t = Math.min(t, hh / dy);
  if (dy < 0) t = Math.min(t, -hh / dy);
  return { x: cx + t * dx, y: cy + t * dy };
}

function _rackLaneLayout(nodes, allNodes) {
  const roots = nodes.filter((n) => !n.parentId);
  const byRack = new Map();
  roots.forEach((n) => {
    const key = n.rack || "Unracked";
    if (!byRack.has(key)) byRack.set(key, []);
    byRack.get(key).push(n);
  });
  const laneGap = 290;
  const rowGap = 125;
  [...byRack.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([rack, laneNodes], laneIdx) => {
    laneNodes.sort((a, b) => a.label.localeCompare(b.label)).forEach((n, rowIdx) => {
      n.x = laneIdx * laneGap;
      n.y = rowIdx * rowGap;
    });
  });
  if (!allNodes) return;
  allNodes.forEach((n) => {
    if (!n.parentId) return;
    const parent = allNodes.get(n.parentId);
    if (!parent) return;
    const siblings = [...allNodes.values()].filter((x) => x.parentId === n.parentId);
    const idx = siblings.indexOf(n);
    n.x = parent.x + 34;
    n.y = parent.y + parent.height + 18 + idx * 92;
  });
}

function _drawRackZones(ctx, nodes) {
  const byRack = new Map();
  nodes.forEach((n) => {
    const key = n.rack || "Unracked";
    if (!byRack.has(key)) byRack.set(key, []);
    byRack.get(key).push(n);
  });
  byRack.forEach((items, rack) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    items.forEach((n) => {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(minX - 28, minY - 38, maxX - minX + 56, maxY - minY + 64, 10);
    ctx.fillStyle = "rgba(24,32,44,0.18)";
    ctx.fill();
    ctx.strokeStyle = "rgba(125,145,175,0.16)";
    ctx.stroke();
    ctx.font = 'bold 12px "Segoe UI", system-ui';
    ctx.fillStyle = "rgba(180,195,220,0.45)";
    ctx.fillText(rack, minX - 14, minY - 17);
    ctx.restore();
  });
}

function _drawGrid(ctx, w, h, scale, panX, panY) {
  const size = 40 * scale;
  const ox = ((panX % size) + size) % size;
  const oy = ((panY % size) + size) % size;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (let x = ox - size; x < w + size; x += size) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = oy - size; y < h + size; y += size) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();
}

function _drawHUD(ctx, w, h, scale, nodeCount, edgeCount, mode) {
  const label = `${mode.toUpperCase()}  ${Math.round(scale * 100)}%  -  ${nodeCount} devices  -  ${edgeCount} cables`;
  ctx.save();
  ctx.font = "10px monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.fillText(label, w - 10, h - 8);
  ctx.restore();
}

document.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("topo-canvas");
  const loading = document.getElementById("topo-loading");
  const emptyMsg = document.getElementById("topo-empty");
  const detail = document.getElementById("topo-detail");
  const detailTitle = document.getElementById("topo-detail-title");
  const detailBody = document.getElementById("topo-detail-body");
  const filterSite = document.getElementById("filter-site");
  const filterRole = document.getElementById("filter-role");
  const connectBar = document.getElementById("topo-connect-bar");
  const connectLabel = document.getElementById("topo-connect-label");
  const ctxMenu = document.getElementById("topo-ctx-menu");
  const ctxEdgeLabel = document.getElementById("topo-ctx-edge-label");
  const btnClearTrace = document.getElementById("btn-clear-trace");
  const searchInput = document.getElementById("topo-search");
  const searchResults = document.getElementById("topo-search-results");
  const saveStatus = document.getElementById("topo-save-status");
  const btnSaveLayout = document.getElementById("btn-save-layout");

  const mgr = new CanvasManager(canvas);
  let topologyData = { nodes: [], edges: [] };
  let layoutVersionId = null;
  let layoutDirty = false;
  const connectState = { active: false, fromNode: null, fromPort: null, fromChannel: 1 };

  mgr.onLayoutChange = () => {
    layoutDirty = true;
    updateSaveStatus();
  };

  function setMode(mode) {
    mgr.setMode(mode);
    document.querySelectorAll(".topo-mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    if (mode !== "connect") exitConnectMode(false);
    connectBar.style.display = mode === "connect" && connectState.active ? "" : "none";
    renderDetail([...mgr.nodes.values()].find((n) => n.selected) || null);
  }

  document.querySelectorAll(".topo-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  function enterConnectMode(node, port, channel) {
    setMode("connect");
    connectState.active = true;
    connectState.fromNode = node;
    connectState.fromPort = port;
    connectState.fromChannel = channel || 1;
    connectLabel.textContent = `${node.label} / ${port.name}:${connectState.fromChannel}`;
    connectBar.style.display = "";
  }

  function exitConnectMode(render = true) {
    connectState.active = false;
    connectState.fromNode = null;
    connectState.fromPort = null;
    connectState.fromChannel = 1;
    connectBar.style.display = "none";
    if (render) renderDetail([...mgr.nodes.values()].find((n) => n.selected) || null);
  }

  document.getElementById("btn-cancel-connect").addEventListener("click", () => exitConnectMode());

  async function createCable(toPort, channel) {
    const body = {
      a_terminations: [{ object_type: connectState.fromPort.object_type, object_id: connectState.fromPort.id }],
      b_terminations: [{ object_type: toPort.object_type, object_id: toPort.id }],
      custom_fields: {
        source_signal_channel: connectState.fromChannel || 1,
        target_signal_channel: channel || 1,
      },
    };
    try {
      const res = await fetch("/api/dcim/cables/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": _csrf() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msgs = Object.entries(err).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n");
        alert(`Could not create cable:\n${msgs || res.statusText}`);
        return;
      }
      exitConnectMode(false);
      await loadTopology();
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  }

  let ctxEdge = null;
  function hideCtxMenu() {
    ctxMenu.style.display = "none";
    ctxEdge = null;
  }

  mgr.onContextEdge = (edge, screenX, screenY) => {
    ctxEdge = edge;
    ctxEdgeLabel.textContent = `${_short(edge.srcNode.label)}:${edge.srcPort} -> ${_short(edge.tgtNode.label)}:${edge.tgtPort}`;
    document.getElementById("ctx-trace-ab").textContent = `Trace into ${_short(edge.tgtNode.label)} at ${edge.tgtPort}`;
    document.getElementById("ctx-trace-ba").textContent = `Trace into ${_short(edge.srcNode.label)} at ${edge.srcPort}`;
    ctxMenu.style.display = "block";
    const mw = ctxMenu.offsetWidth;
    const mh = ctxMenu.offsetHeight;
    ctxMenu.style.left = `${Math.min(screenX + 2, window.innerWidth - mw - 8)}px`;
    ctxMenu.style.top = `${Math.min(screenY + 2, window.innerHeight - mh - 8)}px`;
  };

  document.getElementById("ctx-trace-ab").addEventListener("click", async () => {
    if (!ctxEdge) return;
    const edge = ctxEdge;
    hideCtxMenu();
    const ids = await _traceSignal(edge.tgtNode.id, edge.tgtPort, edge.tgtSignal || 1);
    ids.add(edge.id);
    mgr.highlightEdges(ids);
    btnClearTrace.style.display = "";
  });

  document.getElementById("ctx-trace-ba").addEventListener("click", async () => {
    if (!ctxEdge) return;
    const edge = ctxEdge;
    hideCtxMenu();
    const ids = await _traceSignal(edge.srcNode.id, edge.srcPort, edge.srcSignal || 1);
    ids.add(edge.id);
    mgr.highlightEdges(ids);
    btnClearTrace.style.display = "";
  });

  document.getElementById("ctx-disconnect").addEventListener("click", async () => {
    if (!ctxEdge) return;
    const edge = ctxEdge;
    hideCtxMenu();
    if (!confirm(`Disconnect cable between ${edge.srcNode.label}:${edge.srcPort} and ${edge.tgtNode.label}:${edge.tgtPort}?`)) return;
    try {
      const res = await fetch(`/api/dcim/cables/${edge.id}/`, { method: "DELETE", headers: { "X-CSRFToken": _csrf() } });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const msgs = Object.entries(err).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n");
        alert(`Could not disconnect cable:\n${msgs || res.statusText}`);
        return;
      }
      mgr.clearTrace();
      btnClearTrace.style.display = "none";
      detail.classList.add("topo-detail-hidden");
      await loadTopology();
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  });

  document.getElementById("ctx-clear-trace").addEventListener("click", () => {
    hideCtxMenu();
    mgr.clearTrace();
    btnClearTrace.style.display = "none";
  });

  btnClearTrace.addEventListener("click", () => {
    mgr.clearTrace();
    btnClearTrace.style.display = "none";
  });

  document.addEventListener("click", (e) => {
    if (!ctxMenu.contains(e.target)) hideCtxMenu();
    if (!searchResults.contains(e.target) && e.target !== searchInput) searchResults.style.display = "none";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideCtxMenu();
      exitConnectMode();
      searchResults.style.display = "none";
      if (mgr._animating) {
        mgr.clearTrace();
        btnClearTrace.style.display = "none";
      }
    }
  });

  async function _traceSignal(startDeviceId, startPort, startSignal = 1) {
    const tracedIds = new Set();
    const queue = [{ deviceId: startDeviceId, portName: startPort, signal: startSignal }];
    const visited = new Set();
    while (queue.length > 0) {
      const { deviceId, portName, signal } = queue.shift();
      const logicalPort = _logicalPortName(portName);
      const key = `${deviceId}:${logicalPort}:${signal}`;
      if (visited.has(key)) continue;
      visited.add(key);
      let data;
      try {
        const res = await fetch(`/api/plugins/innovace-fibre/trace/device/${deviceId}/?port=${encodeURIComponent(logicalPort)}&signal=${signal}`, {
          headers: { "X-CSRFToken": _csrf() },
        });
        if (!res.ok) continue;
        data = await res.json();
      } catch {
        continue;
      }
      for (const branch of data.paths || []) {
        if (!branch.length) {
          _followCableFrom(deviceId, logicalPort, signal, tracedIds, queue);
          continue;
        }
        const last = branch[branch.length - 1];
        _followCableFrom(deviceId, last.to_port, last.to_signal, tracedIds, queue);
      }
    }
    return tracedIds;
  }

  function _followCableFrom(deviceId, portName, signal, tracedIds, queue) {
    for (const edge of mgr.edges) {
      if (edge.srcNode.id === deviceId && _samePortName(edge.srcPort, portName) && _signalsCompatible(signal, edge.srcSignal)) {
        tracedIds.add(edge.id);
        queue.push({
          deviceId: edge.tgtNode.id,
          portName: edge.tgtPort,
          signal: _nextCableSignal(signal, edge.tgtSignal),
        });
      } else if (edge.tgtNode.id === deviceId && _samePortName(edge.tgtPort, portName) && _signalsCompatible(signal, edge.tgtSignal)) {
        tracedIds.add(edge.id);
        queue.push({
          deviceId: edge.srcNode.id,
          portName: edge.srcPort,
          signal: _nextCableSignal(signal, edge.srcSignal),
        });
      }
    }
  }

  function _signalsCompatible(routeSignal, cableSignal) {
    const route = Math.max(1, parseInt(routeSignal || "1", 10) || 1);
    const cable = Math.max(1, parseInt(cableSignal || "1", 10) || 1);
    return route === 1 || cable === 1 || route === cable;
  }

  function _nextCableSignal(routeSignal, cableSignal) {
    const route = Math.max(1, parseInt(routeSignal || "1", 10) || 1);
    const cable = Math.max(1, parseInt(cableSignal || "1", 10) || 1);
    return cable > 1 ? cable : route;
  }

  function _samePortName(a, b) {
    return _logicalPortName(a) === _logicalPortName(b);
  }

  function _logicalPortName(name) {
    return String(name || "").replace(/_(front|rear)$/i, "");
  }

  function renderDetail(node) {
    if (!node) {
      detail.classList.add("topo-detail-hidden");
      return;
    }
    detailTitle.textContent = node.label;
    const ports = node.ports || [];
    const grouped = _groupPorts(node, ports);
    let html = [
      row("Manufacturer", node.manufacturer),
      row("Device type", node.deviceType),
      row("Rack", node.rack),
      row("Role", node.role),
      node.parentBay ? row("Parent bay", node.parentBay) : "",
      `<div class="topo-detail-actions">
        <a href="${node.url}" target="_blank">Open in NetBox</a>
        ${node.hasChildren() ? `<button class="topo-inline-btn" id="btn-toggle-node">${node.collapsed ? "Expand" : "Collapse"}</button>` : ""}
      </div>`,
      `<input id="topo-port-filter" class="topo-panel-search" placeholder="Filter ports..." autocomplete="off">`,
    ].join("");

    html += `<div class="topo-port-groups">`;
    grouped.forEach((group) => {
      html += `<div class="topo-port-group" data-group="${_esc(group.label.toLowerCase())}">
        <div class="topo-port-group-title">${_esc(group.label)} <span>${group.ports.length}</span></div>`;
      group.ports.forEach((port, idx) => {
        const key = `${group.key}:${idx}`;
        const maxChannel = Math.max(1, port.channel_count || 1);
        const channel = `<select class="topo-channel-select" data-key="${key}">
          ${Array.from({ length: maxChannel }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("")}
        </select>`;
        let btn = "";
        const sameSource =
          connectState.active &&
          connectState.fromPort?.object_type === port.object_type &&
          connectState.fromPort?.id === port.id;
        if (mgr.mode === "connect" && connectState.active && !sameSource) {
          btn = `<button class="topo-port-btn select" data-key="${key}">Target</button>`;
        } else {
          btn = `<button class="topo-port-btn" data-key="${key}">${sameSource ? "Source" : mgr.mode === "connect" ? "Source" : "Connect"}</button>`;
        }
        html += `<div class="topo-port-row" data-port="${_esc(port.name.toLowerCase())}">
          <span class="topo-port-name">${_esc(port.name)}</span>
          <span class="topo-port-type">${_esc(port.type)}</span>
          ${maxChannel > 1 ? channel : `<input type="hidden" class="topo-channel-select" data-key="${key}" value="1">`}
          ${btn}
        </div>`;
      });
      html += `</div>`;
    });
    html += `</div>`;

    detailBody.innerHTML = html;
    detail.classList.remove("topo-detail-hidden");

    const portByKey = new Map();
    grouped.forEach((group) => group.ports.forEach((port, idx) => portByKey.set(`${group.key}:${idx}`, port)));

    detailBody.querySelector("#btn-toggle-node")?.addEventListener("click", () => {
      node.collapsed = !node.collapsed;
      mgr._applyHierarchyVisibility();
      mgr.onLayoutChange?.();
      renderDetail(node);
    });

    detailBody.querySelector("#topo-port-filter")?.addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      detailBody.querySelectorAll(".topo-port-row").forEach((rowEl) => {
        rowEl.style.display = !q || rowEl.dataset.port.includes(q) ? "" : "none";
      });
    });

    detailBody.querySelectorAll(".topo-port-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const port = portByKey.get(btn.dataset.key);
        const channelInput = detailBody.querySelector(`.topo-channel-select[data-key="${btn.dataset.key}"]`);
        const channel = Math.max(1, parseInt(channelInput?.value || "1", 10) || 1);
        if (btn.classList.contains("select")) {
          createCable(port, channel);
        } else {
          enterConnectMode(node, port, channel);
          renderDetail(node);
        }
      });
    });
  }

  function _groupPorts(node, ports) {
    const groups = [{ key: "device", label: node.label, ports: [] }];
    const moduleGroups = new Map();
    ports.forEach((port) => {
      if (port.owner_kind === "module" && port.owner_id) {
        const key = `module-${port.owner_id}`;
        if (!moduleGroups.has(key)) moduleGroups.set(key, { key, label: port.owner_name || "Module", ports: [] });
        moduleGroups.get(key).ports.push(port);
      } else {
        groups[0].ports.push(port);
      }
    });
    node.children.forEach((child) => {
      const childNode = mgr.nodes.get(child.id);
      groups.push({
        key: `child-${child.id}`,
        label: `${child.name} (${child.bay_name})`,
        ports: childNode?.ports || [],
      });
    });
    return groups.concat([...moduleGroups.values()]).filter((g) => g.ports.length || g.key.startsWith("child-"));
  }

  mgr.onSelectNode = renderDetail;

  function row(label, value) {
    if (!value) return "";
    return `<div class="topo-detail-row"><span class="topo-detail-label">${label}</span><span class="topo-detail-value">${_esc(value)}</span></div>`;
  }

  function buildSearchIndex() {
    const items = [];
    mgr.nodes.forEach((node) => {
      items.push({ type: "device", label: node.label, sub: [node.rack, node.role].filter(Boolean).join(" - "), node });
      node.children.forEach((child) => items.push({ type: "child", label: child.name, sub: `${node.label} / ${child.bay_name}`, node }));
      node.modules.forEach((mod) => items.push({ type: "module", label: mod.name, sub: `${node.label} / ${mod.bay_name}`, node }));
      node.ports.forEach((port) => items.push({ type: "port", label: port.name, sub: node.label, node, port }));
    });
    mgr.edges.forEach((edge) => items.push({ type: "cable", label: edge.label || `Cable #${edge.id}`, sub: `${edge.srcNode.label}:${edge.srcPort} -> ${edge.tgtNode.label}:${edge.tgtPort}`, edge }));
    return items;
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      searchResults.style.display = "none";
      return;
    }
    const matches = buildSearchIndex().filter((item) => `${item.type} ${item.label} ${item.sub}`.toLowerCase().includes(q)).slice(0, 12);
    searchResults.innerHTML = matches.map((item, idx) => `<button class="topo-search-result" data-idx="${idx}">
      <span>${_esc(item.label)}</span><small>${_esc(item.type)} - ${_esc(item.sub || "")}</small>
    </button>`).join("") || `<div class="topo-search-empty">No matches</div>`;
    searchResults.style.display = "block";
    searchResults.querySelectorAll(".topo-search-result").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = matches[+btn.dataset.idx];
        searchResults.style.display = "none";
        searchInput.value = item.label;
        if (item.edge) {
          mgr.clearTrace();
          mgr.highlightEdges(new Set([item.edge.id]));
          mgr.selectNode(item.edge.srcNode, true);
          btnClearTrace.style.display = "";
        } else {
          mgr.selectNode(item.node, true);
        }
      });
    });
  });

  document.getElementById("btn-close-detail").addEventListener("click", () => detail.classList.add("topo-detail-hidden"));
  document.getElementById("btn-zoom-in").addEventListener("click", () => mgr.zoomBy(1.2));
  document.getElementById("btn-zoom-out").addEventListener("click", () => mgr.zoomBy(1 / 1.2));
  document.getElementById("btn-fit").addEventListener("click", () => mgr.fitView());
  document.getElementById("btn-reset-layout").addEventListener("click", () => mgr.resetLayout());
  btnSaveLayout.addEventListener("click", saveLayout);

  async function loadTopology() {
    loading.style.display = "";
    emptyMsg.style.display = "none";
    const params = new URLSearchParams();
    if (filterSite.value) params.set("site_id", filterSite.value);
    if (filterRole.value) params.set("role_id", filterRole.value);
    try {
      const res = await fetch(`/api/plugins/innovace-fibre/topology/?${params}`, { headers: { "X-CSRFToken": _csrf() } });
      const data = await res.json();
      topologyData = data;
      populateFilters(data);
      loading.style.display = "none";
      if (!data.nodes || data.nodes.length === 0) {
        emptyMsg.style.display = "";
        emptyMsg.textContent = "No devices with ports found. Add devices in NetBox and reload.";
        return;
      }
      const layout = await loadLayout();
      mgr.load(data, layout);
      layoutDirty = false;
      updateSaveStatus();
    } catch (err) {
      loading.style.display = "none";
      emptyMsg.style.display = "";
      emptyMsg.textContent = `Failed to load topology: ${err.message}`;
      console.error(err);
    }
  }

  function populateFilters(data) {
    if (filterSite.dataset.populated) return;
    for (const s of data.filters?.sites || []) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.name;
      filterSite.appendChild(o);
    }
    for (const r of data.filters?.roles || []) {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = r.name;
      filterRole.appendChild(o);
    }
    filterSite.dataset.populated = "1";
    filterRole.dataset.populated = "1";
  }

  async function loadLayout() {
    if (!filterSite.value) {
      layoutVersionId = null;
      return {};
    }
    const res = await fetch(`/api/plugins/innovace-fibre/topology-layout/?site_id=${encodeURIComponent(filterSite.value)}`, {
      headers: { "X-CSRFToken": _csrf() },
    });
    if (!res.ok) return {};
    const data = await res.json();
    layoutVersionId = data.version_id || null;
    return data.config || {};
  }

  async function saveLayout() {
    if (!filterSite.value) {
      alert("Choose a specific site before saving a shared topology layout.");
      return;
    }
    try {
      btnSaveLayout.disabled = true;
      saveStatus.textContent = "Saving...";
      const res = await fetch("/api/plugins/innovace-fibre/topology-layout/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": _csrf() },
        body: JSON.stringify({ site_id: filterSite.value, config: mgr.exportLayout() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Could not save layout: ${data.error || res.statusText}`);
        return;
      }
      layoutVersionId = data.version_id;
      layoutDirty = false;
      updateSaveStatus();
    } finally {
      btnSaveLayout.disabled = false;
    }
  }

  function updateSaveStatus() {
    saveStatus.textContent = filterSite.value
      ? layoutDirty
        ? "Unsaved layout"
        : layoutVersionId
          ? "Layout saved"
          : "No saved layout"
      : "Select a site to save layout";
  }

  document.getElementById("btn-apply-filter").addEventListener("click", loadTopology);
  filterSite.addEventListener("change", updateSaveStatus);

  function _csrf() {
    if (window.CSRF_TOKEN) return window.CSRF_TOKEN;
    const raw = document.cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith("csrftoken="))?.split("=")[1] ?? "";
    return decodeURIComponent(raw);
  }

  function _esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function _short(s, max = 14) {
    s = String(s ?? "");
    return s.length > max ? s.slice(0, max - 1) + "..." : s;
  }

  new BarcodeScanner({
    onDeviceMatch(data) {
      const node = mgr.nodes.get(data.id);
      if (!node) {
        BarcodeScanner.showToast(`Device "${data.name}" is not visible in the current topology view. Try applying the correct site filter.`, "warning");
        return;
      }
      mgr.clearTrace();
      btnClearTrace.style.display = "none";
      mgr.selectNode(node, true);
      const connectedEdges = mgr.edges.filter((e) => e.srcNode?.id === data.id || e.tgtNode?.id === data.id);
      const edgeIds = new Set(connectedEdges.map((e) => e.id));
      mgr.highlightEdges(edgeIds);
      btnClearTrace.style.display = edgeIds.size > 0 ? "" : "none";
      const portsTraced = new Set();
      for (const edge of connectedEdges) {
        const portName = edge.srcNode?.id === data.id ? edge.srcPort : edge.tgtPort;
        const signal = edge.srcNode?.id === data.id ? edge.srcSignal : edge.tgtSignal;
        if (portName && !portsTraced.has(portName)) {
          portsTraced.add(portName);
          _traceSignal(data.id, portName, signal || 1).then((ids) => {
            ids.forEach((id) => edgeIds.add(id));
            mgr.highlightEdges(edgeIds);
          });
        }
      }
      BarcodeScanner.showToast(`Found: ${data.name} - ${data.site || ""}`, "success");
    },

    onCableMatch(data) {
      const edgeId = data.id;
      const matchedEdge = mgr.edges.find((e) => e.id === edgeId);
      if (!matchedEdge) {
        BarcodeScanner.showToast(`Cable #${edgeId} not found in current topology view`, "warning");
        return;
      }
      mgr.clearTrace();
      mgr.highlightEdges(new Set([edgeId]));
      mgr.selectNode(matchedEdge.srcNode, true);
      btnClearTrace.style.display = "";
      const matchedEnd = data.matched_end;
      const terms = matchedEnd === "a" ? data.a_terminations : data.b_terminations;
      if (!terms?.length) {
        BarcodeScanner.showToast(`Tracing cable #${edgeId}`, "success");
        return;
      }
      const startDeviceId = terms[0].device_id;
      const startPort = terms[0].port_name;
      if (data.signals.length <= 1) {
        _traceSignal(startDeviceId, startPort, 1).then((ids) => {
          ids.add(edgeId);
          mgr.highlightEdges(ids);
        });
        BarcodeScanner.showToast(`Tracing cable${data.label ? ` "${data.label}"` : ` #${edgeId}`}`, "success");
      } else {
        showSignalModal(data, (selectedSignals) => {
          const allIds = new Set([edgeId]);
          Promise.all(selectedSignals.map((sig) => _traceSignal(startDeviceId, startPort, sig))).then((results) => {
            results.forEach((ids) => ids.forEach((id) => allIds.add(id)));
            mgr.highlightEdges(allIds);
            btnClearTrace.style.display = "";
          });
        });
      }
    },
  });

  setMode("view");
  loadTopology();
});
