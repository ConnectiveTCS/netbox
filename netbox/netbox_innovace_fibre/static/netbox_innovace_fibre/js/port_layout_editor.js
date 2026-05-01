"use strict";

const PIN_RADIUS = 7; // canvas px
const PIN_COLORS = {
  front: "#2563eb",
  rear: "#16a34a",
  selected: "#f59e0b",
  positioned: "#6b7280",
};
const API_BASE = "/api/plugins/innovace-fibre";
const PORT_NAME_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function comparePorts(a, b) {
  const faceOrder = { front: 0, rear: 1 };
  const aFace = faceOrder[a.face] ?? 2;
  const bFace = faceOrder[b.face] ?? 2;
  if (aFace !== bFace) return aFace - bFace;

  const typeCompare = PORT_NAME_COLLATOR.compare(a.type || "", b.type || "");
  if (typeCompare !== 0) return typeCompare;

  return PORT_NAME_COLLATOR.compare(a.name || "", b.name || "");
}

// ── FaceEditor ─────────────────────────────────────────────────────────────────
// Manages one canvas (one device face).

class FaceEditor {
  constructor(canvas, face, imageUrl) {
    this._canvas = canvas;
    this._ctx = canvas.getContext("2d");
    this._face = face; // 'front' | 'rear'
    this._img = null;
    this._imgUrl = imageUrl;
    this._ports = []; // [{name, face}] - all ports for this face
    this._pins = {}; // portName → {x, y}  (normalised 0-1)
    this._selected = null; // portName currently selected for placement
    this._dragging = null; // portName being dragged
    this._dragOff = { x: 0, y: 0 };

    canvas.addEventListener("mousedown", (e) => this._onMouseDown(e));
    canvas.addEventListener("mousemove", (e) => this._onMouseMove(e));
    canvas.addEventListener("mouseup", () => this._onMouseUp());
    canvas.addEventListener("mouseleave", () => this._onMouseUp());
  }

  // Load the image and size the canvas to match its intrinsic aspect ratio.
  async loadImage() {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this._img = img;
        // Fix canvas resolution to image pixel dimensions (up to 1200px wide).
        const maxW = 1200;
        const scale = img.naturalWidth > maxW ? maxW / img.naturalWidth : 1;
        this._canvas.width = Math.round(img.naturalWidth * scale);
        this._canvas.height = Math.round(img.naturalHeight * scale);
        this._draw();
        resolve();
      };
      img.onerror = reject;
      img.src = this._imgUrl;
    });
  }

  setPorts(ports) {
    this._ports = ports.filter((p) => p.face === this._face || p.face == null);
    this._draw();
  }

  setPins(positionMap) {
    // positionMap: { portName: {x, y, face} }
    this._pins = {};
    for (const [name, pos] of Object.entries(positionMap)) {
      if (pos.face === this._face) this._pins[name] = { x: pos.x, y: pos.y };
    }
    this._draw();
  }

  setSelected(portName) {
    this._selected = portName;
    this._draw();
  }

  getPins() {
    const out = {};
    for (const [name, pos] of Object.entries(this._pins)) {
      out[name] = { x: pos.x, y: pos.y, face: this._face };
    }
    return out;
  }

  removePin(portName) {
    delete this._pins[portName];
    this._draw();
  }

  // ── Private drawing ──────────────────────────────────────────────────────────

  _draw() {
    const { _canvas: c, _ctx: ctx, _img: img } = this;
    ctx.clearRect(0, 0, c.width, c.height);
    if (img) ctx.drawImage(img, 0, 0, c.width, c.height);

    const color = this._face === "front" ? PIN_COLORS.front : PIN_COLORS.rear;
    for (const port of this._ports) {
      const pin = this._pins[port.name];
      const isSelected = port.name === this._selected;
      if (pin) {
        this._drawPin(
          pin.x * c.width,
          pin.y * c.height,
          port.name,
          isSelected ? PIN_COLORS.selected : color,
        );
      } else if (isSelected) {
        // Ghost cursor hint: draw small circle at canvas centre if not yet placed
      }
    }
  }

  _drawPin(px, py, label, color) {
    const ctx = this._ctx;
    ctx.beginPath();
    ctx.arc(px, py, PIN_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.font = "bold 9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label.slice(0, 4), px, py);

    ctx.fillStyle = "#111";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, px + PIN_RADIUS + 3, py + 1);
  }

  // ── Mouse events ──────────────────────────────────────────────────────────────

  _canvasXY(e) {
    const r = this._canvas.getBoundingClientRect();
    return {
      px: (e.clientX - r.left) * (this._canvas.width / r.width),
      py: (e.clientY - r.top) * (this._canvas.height / r.height),
    };
  }

  _hitPin(px, py) {
    const c = this._canvas;
    for (const [name, pos] of Object.entries(this._pins)) {
      const dx = pos.x * c.width - px;
      const dy = pos.y * c.height - py;
      if (Math.sqrt(dx * dx + dy * dy) <= PIN_RADIUS + 4) return name;
    }
    return null;
  }

  _onMouseDown(e) {
    const { px, py } = this._canvasXY(e);
    const hit = this._hitPin(px, py);
    if (hit) {
      this._dragging = hit;
      const pin = this._pins[hit];
      this._dragOff = {
        x: pin.x * this._canvas.width - px,
        y: pin.y * this._canvas.height - py,
      };
      this._onSelectPort?.(hit);
      e.preventDefault();
      return;
    }
    // Place selected port at click position.
    if (this._selected && this._ports.some((port) => port.name === this._selected)) {
      const placedPort = this._selected;
      this._pins[this._selected] = {
        x: px / this._canvas.width,
        y: py / this._canvas.height,
      };
      this._onPinPlaced?.(placedPort);
      this._onPinChange?.();
      this._draw();
    }
  }

  _onMouseMove(e) {
    if (!this._dragging) return;
    const { px, py } = this._canvasXY(e);
    this._pins[this._dragging] = {
      x: Math.max(0, Math.min(1, (px + this._dragOff.x) / this._canvas.width)),
      y: Math.max(0, Math.min(1, (py + this._dragOff.y) / this._canvas.height)),
    };
    this._draw();
  }

  _onMouseUp() {
    if (this._dragging) {
      this._onPinChange?.();
      this._dragging = null;
    }
  }
}

// ── AppController ──────────────────────────────────────────────────────────────

class PortLayoutApp {
  constructor() {
    const cfg = window.IFF_PL_CONFIG;
    this._dtId = cfg.deviceTypeId;
    this._editors = {};
    this._allPorts = [];
    this._showUnpositionedOnly = false;

    if (cfg.frontImage) {
      const canvas = document.getElementById("iff-pl-canvas-front");
      if (canvas) {
        const ed = new FaceEditor(canvas, "front", cfg.frontImage);
        ed._onPinChange = () => this._refreshPortList();
        ed._onPinPlaced = (n) => this._advanceFrom(n);
        ed._onSelectPort = (n) => this._selectPort(n);
        this._editors["front"] = ed;
      }
    }
    if (cfg.rearImage) {
      const canvas = document.getElementById("iff-pl-canvas-rear");
      if (canvas) {
        const ed = new FaceEditor(canvas, "rear", cfg.rearImage);
        ed._onPinChange = () => this._refreshPortList();
        ed._onPinPlaced = (n) => this._advanceFrom(n);
        ed._onSelectPort = (n) => this._selectPort(n);
        this._editors["rear"] = ed;
      }
    }

    this._selectedPort = null;
    this._activeFace = cfg.frontImage ? "front" : "rear";

    this._wireEvents();
    this._load();
  }

  _wireEvents() {
    document
      .getElementById("iff-pl-save")
      ?.addEventListener("click", () => this._save());
    document
      .getElementById("iff-pl-reload")
      ?.addEventListener("click", () => this._load());
    document
      .getElementById("iff-pl-unpositioned-only")
      ?.addEventListener("change", (e) => {
        this._showUnpositionedOnly = e.target.checked;
        this._refreshPortList();
      });

    document.querySelectorAll("#iff-pl-tabs .nav-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll("#iff-pl-tabs .nav-link")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const face = btn.dataset.face;
        this._activeFace = face;
        document
          .querySelectorAll(".iff-pl-pane")
          .forEach((p) => (p.style.display = "none"));
        document.getElementById(`iff-pl-pane-${face}`).style.display = "block";
        const selectedPort = this._allPorts.find((p) => p.name === this._selectedPort);
        const selectedEditor = selectedPort ? this._editorForPort(selectedPort) : null;
        if (!selectedEditor || selectedEditor._face !== face || this._mergedPins()[this._selectedPort]) {
          this._selectNextUnpositioned();
          return;
        }
        this._refreshPortList();
      });
    });
  }

  async _load() {
    this._setStatus("Loading…");
    try {
      const res = await fetch(
        `${API_BASE}/device-types/${this._dtId}/port-layout/`,
      );
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      this._allPorts = (data.ports || []).slice().sort(comparePorts);

      // Load images
      await Promise.all(
        Object.values(this._editors).map((ed) => ed.loadImage()),
      );

      // Distribute ports to editors
      for (const ed of Object.values(this._editors)) {
        ed.setPorts(this._allPorts);
      }

      // Set existing pin positions
      const positions = data.port_positions || {};
      for (const ed of Object.values(this._editors)) {
        ed.setPins(positions);
      }

      this._selectNextUnpositioned();
      this._refreshPortList();
      this._setStatus("Ready");
    } catch (err) {
      this._setStatus(`Error: ${err.message}`);
    }
  }

  async _save() {
    this._setStatus("Saving…");
    const merged = {};
    for (const ed of Object.values(this._editors)) {
      Object.assign(merged, ed.getPins());
    }
    try {
      const csrfToken = this._csrfToken();
      if (!csrfToken) {
        throw new Error("Missing CSRF token; refresh the page and try again.");
      }

      const res = await fetch(
        `${API_BASE}/device-types/${this._dtId}/port-layout/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRFToken": csrfToken,
          },
          body: JSON.stringify({ port_positions: merged }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText);
      }
      this._setStatus("Saved");
    } catch (err) {
      this._setStatus(`Save failed: ${err.message}`);
    }
  }

  _csrfToken() {
    // NetBox injects this value globally; use it first when available.
    if (window.CSRF_TOKEN && typeof window.CSRF_TOKEN === "string") {
      const token = window.CSRF_TOKEN.trim();
      if (token.length >= 32) return token;
    }

    const match = document.cookie.match(/(?:^|; )csrftoken=([^;]+)/);
    if (!match) return "";
    return decodeURIComponent(match[1]).trim();
  }

  _selectPort(portName) {
    this._selectedPort = portName;
    for (const ed of Object.values(this._editors)) ed.setSelected(portName);
    this._refreshPortList();
  }

  _advanceFrom(portName) {
    this._selectNextUnpositioned(portName);
  }

  _selectNextUnpositioned(afterPortName = null) {
    const allPins = this._mergedPins();
    const ports = this._portsForFace(this._activeFace);
    const unpositioned = ports.filter((p) => !allPins[p.name]);

    if (unpositioned.length === 0) {
      this._selectPort(null);
      return null;
    }

    if (!afterPortName) {
      this._selectPort(unpositioned[0].name);
      return unpositioned[0];
    }

    const afterIndex = ports.findIndex((p) => p.name === afterPortName);
    const next =
      unpositioned.find((p) => ports.findIndex((candidate) => candidate.name === p.name) > afterIndex) ||
      unpositioned[0];

    this._selectPort(next.name);
    return next;
  }

  _refreshPortList() {
    const list = document.getElementById("iff-pl-port-list");
    if (!list) return;

    const allPins = this._mergedPins();
    const ports = this._showUnpositionedOnly
      ? this._allPorts.filter((p) => !allPins[p.name])
      : this._allPorts;

    this._refreshCurrentPortPanel(allPins);

    list.innerHTML = "";
    let activeItem = null;
    for (const port of ports) {
      const positioned = !!allPins[port.name];
      const isActive = port.name === this._selectedPort;
      const li = document.createElement("li");
      li.className = `list-group-item list-group-item-action iff-pl-port-item d-flex justify-content-between align-items-center py-1 px-2${isActive ? " active" : ""}`;
      if (isActive) activeItem = li;
      li.innerHTML = `
        <span class="small">${port.name}</span>
        <span class="d-flex gap-1 align-items-center">
          <span class="badge ${positioned ? "bg-success" : "bg-secondary"}">${port.type}</span>
          ${positioned ? `<button class="btn btn-link btn-sm p-0 text-danger iff-pl-remove" data-port="${port.name}" title="Remove pin">✕</button>` : ""}
        </span>`;
      li.addEventListener("click", (e) => {
        if (e.target.closest(".iff-pl-remove")) return;
        this._selectPort(port.name);
        // Switch to face of this port if we know it
        const faceEd = this._editorForPort(port);
        if (faceEd && faceEd._face !== this._activeFace) {
          document.querySelector(`[data-face="${faceEd._face}"]`)?.click();
        }
        this._refreshCurrentPortPanel(this._mergedPins());
      });
      list.appendChild(li);
    }
    activeItem?.scrollIntoView({ block: "nearest" });

    // Remove pin buttons
    list.querySelectorAll(".iff-pl-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pname = btn.dataset.port;
        for (const ed of Object.values(this._editors)) ed.removePin(pname);
        const port = this._allPorts.find((p) => p.name === pname);
        const faceEd = port ? this._editorForPort(port) : null;
        if (faceEd && faceEd._face !== this._activeFace) {
          document.querySelector(`[data-face="${faceEd._face}"]`)?.click();
        }
        this._selectPort(pname);
        this._refreshPortList();
      });
    });
  }

  _refreshCurrentPortPanel(allPins = this._mergedPins()) {
    const nameEl = document.getElementById("iff-pl-current-port");
    const helpEl = document.getElementById("iff-pl-current-help");
    if (!nameEl || !helpEl) return;

    const current = this._allPorts.find((p) => p.name === this._selectedPort);
    const remaining = this._portsForFace(this._activeFace).filter((p) => !allPins[p.name]).length;

    if (!current) {
      nameEl.textContent = "All ports placed";
      helpEl.textContent = "Drag any pin to fine-tune its position, or remove a pin to place it again.";
      return;
    }

    const positioned = !!allPins[current.name];
    nameEl.textContent = current.name;
    helpEl.textContent = positioned
      ? "This port already has a pin. Drag it to reposition, or pick an unpositioned port from the list."
      : `${remaining} unpositioned ${remaining === 1 ? "port" : "ports"} left on this face. Click the image to place this one.`;
  }

  _mergedPins() {
    const out = {};
    for (const ed of Object.values(this._editors))
      Object.assign(out, ed.getPins());
    return out;
  }

  _editorForPort(port) {
    if (port.face && this._editors[port.face]) return this._editors[port.face];
    // Guess from type
    if (port.type === "front port") return this._editors["front"];
    if (port.type === "rear port") return this._editors["rear"];
    return this._editors[this._activeFace] || Object.values(this._editors)[0];
  }

  _portsForFace(face) {
    return this._allPorts.filter((port) => {
      const editor = this._editorForPort(port);
      return editor && editor._face === face;
    });
  }

  _setStatus(msg) {
    const el = document.getElementById("iff-pl-status");
    if (el) el.textContent = msg;
  }
}

document.addEventListener("DOMContentLoaded", () => new PortLayoutApp());
