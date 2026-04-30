function getCsrfToken() {
  if (window.CSRF_TOKEN) return window.CSRF_TOKEN;
  const match = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith("csrftoken="));
  return match ? match.trim().split("=")[1] : "";
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function overlaps(a, b) {
  const ax2 = a.x + a.w;
  const ay2 = a.y + a.h;
  const bx2 = b.x + b.w;
  const by2 = b.y + b.h;
  return !(ax2 <= b.x || bx2 <= a.x || ay2 <= b.y || by2 <= a.y);
}

class BayCanvasEditor {
  constructor(canvas, statusSetter) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.status = statusSetter;
    this.items = [];
    this.activeId = null;
    this.drag = null;
    this.snap = true;
    this.preventOverlap = true;
    this.grid = 20;
    this.padding = 22;
    this.bound = {
      x: this.padding,
      y: this.padding,
      w: canvas.width - this.padding * 2,
      h: canvas.height - this.padding * 2,
    };
    this.onSelectionChange = null;
    this._bind();
    this.render();
  }

  setSelectionChangeHandler(handler) {
    this.onSelectionChange = handler;
    this._notifySelection();
  }

  setOptions({ snap, preventOverlap }) {
    this.snap = !!snap;
    this.preventOverlap = !!preventOverlap;
    this.render();
  }

  setItems(items) {
    this.items = items.map((it, i) => ({
      id: it.id,
      name: it.name,
      occupied: !!it.occupied,
      layout: it.layout || null,
      x: it.layout?.x ?? 5 + (i % 4) * 22,
      y: it.layout?.y ?? 6 + Math.floor(i / 4) * 26,
      w: it.layout?.w ?? 20,
      h: it.layout?.h ?? 18,
    }));
    this.activeId = this.items[0]?.id ?? null;
    this._notifySelection();
    this.render();
  }

  getActiveItem() {
    return this.items.find((v) => v.id === this.activeId) || null;
  }

  moveActive(dx, dy) {
    const it = this.getActiveItem();
    if (!it) return false;
    let nx = clamp(it.x + dx, 0, 100 - it.w);
    let ny = clamp(it.y + dy, 0, 100 - it.h);
    if (this.snap) {
      nx = clamp(this._snapVal(nx), 0, 100 - it.w);
      ny = clamp(this._snapVal(ny), 0, 100 - it.h);
    }

    const candidate = { x: nx, y: ny, w: it.w, h: it.h };
    if (this.preventOverlap) {
      const blocked = this.items.some((other) => {
        if (other.id === it.id) return false;
        return overlaps(candidate, other);
      });
      if (blocked) {
        this.status("Overlap blocked");
        return false;
      }
    }

    it.x = nx;
    it.y = ny;
    this.render();
    return true;
  }

  centerActive() {
    const it = this.getActiveItem();
    if (!it) return false;
    const nx = (100 - it.w) / 2;
    const ny = (100 - it.h) / 2;
    const candidate = { x: nx, y: ny, w: it.w, h: it.h };
    if (this.preventOverlap) {
      const blocked = this.items.some((other) => {
        if (other.id === it.id) return false;
        return overlaps(candidate, other);
      });
      if (blocked) {
        this.status("Overlap blocked");
        return false;
      }
    }

    it.x = nx;
    it.y = ny;
    this.render();
    return true;
  }

  getLayouts() {
    return this.items.map((it) => ({
      id: it.id,
      layout: {
        x: +it.x.toFixed(2),
        y: +it.y.toFixed(2),
        w: +it.w.toFixed(2),
        h: +it.h.toFixed(2),
      },
    }));
  }

  autoArrange() {
    const n = this.items.length;
    if (!n) return;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.8)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const cellW = 100 / cols;
    const cellH = 100 / rows;
    const tileW = cellW * 0.84;
    const tileH = cellH * 0.78;

    this.items.forEach((it, idx) => {
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      it.w = tileW;
      it.h = tileH;
      it.x = c * cellW + (cellW - tileW) / 2;
      it.y = r * cellH + (cellH - tileH) / 2;
    });
    this.render();
  }

  _bind() {
    this.canvas.addEventListener("mousedown", (e) => this._onDown(e));
    this.canvas.addEventListener("mousemove", (e) => this._onMove(e));
    this.canvas.addEventListener("mouseup", () => this._onUp());
    this.canvas.addEventListener("mouseleave", () => this._onUp());
  }

  _canvasPos(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((evt.clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((evt.clientY - rect.top) / rect.height) * this.canvas.height;
    return [x, y];
  }

  _toCanvasRect(it) {
    return {
      x: this.bound.x + (it.x / 100) * this.bound.w,
      y: this.bound.y + (it.y / 100) * this.bound.h,
      w: (it.w / 100) * this.bound.w,
      h: (it.h / 100) * this.bound.h,
    };
  }

  _fromCanvasDelta(dx, dy) {
    return {
      dx: (dx / this.bound.w) * 100,
      dy: (dy / this.bound.h) * 100,
    };
  }

  _snapVal(v) {
    if (!this.snap) return v;
    const s = this.grid;
    return Math.round(v / s) * s;
  }

  _hitTest(x, y) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const r = this._toCanvasRect(it);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        const hs = 10;
        const inResize = x >= r.x + r.w - hs && y >= r.y + r.h - hs;
        return { item: it, mode: inResize ? "resize" : "move", rect: r };
      }
    }
    return null;
  }

  _onDown(evt) {
    const [x, y] = this._canvasPos(evt);
    const hit = this._hitTest(x, y);
    if (!hit) return;
    this.activeId = hit.item.id;
    this._notifySelection();
    this.drag = {
      id: hit.item.id,
      mode: hit.mode,
      x,
      y,
      start: { x: hit.item.x, y: hit.item.y, w: hit.item.w, h: hit.item.h },
    };
    this.render();
  }

  _onMove(evt) {
    const [x, y] = this._canvasPos(evt);
    if (!this.drag) {
      const hit = this._hitTest(x, y);
      this.canvas.style.cursor = hit
        ? hit.mode === "resize"
          ? "nwse-resize"
          : "move"
        : "default";
      return;
    }

    const it = this.items.find((v) => v.id === this.drag.id);
    if (!it) return;

    const delta = this._fromCanvasDelta(x - this.drag.x, y - this.drag.y);
    let nx = this.drag.start.x;
    let ny = this.drag.start.y;
    let nw = this.drag.start.w;
    let nh = this.drag.start.h;

    if (this.drag.mode === "move") {
      nx = this.drag.start.x + delta.dx;
      ny = this.drag.start.y + delta.dy;
    } else {
      nw = this.drag.start.w + delta.dx;
      nh = this.drag.start.h + delta.dy;
    }

    if (this.snap) {
      nx = this._snapVal(nx);
      ny = this._snapVal(ny);
      nw = this._snapVal(nw);
      nh = this._snapVal(nh);
    }

    nw = clamp(nw, 4, 100);
    nh = clamp(nh, 4, 100);
    nx = clamp(nx, 0, 100 - nw);
    ny = clamp(ny, 0, 100 - nh);

    const candidate = { x: nx, y: ny, w: nw, h: nh };
    if (this.preventOverlap) {
      const blocked = this.items.some((other) => {
        if (other.id === it.id) return false;
        return overlaps(candidate, other);
      });
      if (blocked) {
        this.status("Overlap blocked");
        return;
      }
    }

    Object.assign(it, candidate);
    this.render();
  }

  _onUp() {
    this.drag = null;
  }

  _notifySelection() {
    if (!this.onSelectionChange) return;
    const active = this.getActiveItem();
    this.onSelectionChange(active);
  }

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = "#d0d7de";
    ctx.lineWidth = 1;
    ctx.strokeRect(this.bound.x, this.bound.y, this.bound.w, this.bound.h);

    ctx.strokeStyle = "#e5e7eb";
    for (let i = 1; i < 10; i++) {
      const gx = this.bound.x + (this.bound.w * i) / 10;
      const gy = this.bound.y + (this.bound.h * i) / 10;
      ctx.beginPath();
      ctx.moveTo(gx, this.bound.y);
      ctx.lineTo(gx, this.bound.y + this.bound.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(this.bound.x, gy);
      ctx.lineTo(this.bound.x + this.bound.w, gy);
      ctx.stroke();
    }

    for (const it of this.items) {
      const r = this._toCanvasRect(it);
      const active = it.id === this.activeId;
      ctx.fillStyle = active ? "#3b82f6" : "#2563eb";
      ctx.globalAlpha = it.occupied ? 0.92 : 0.55;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = active ? "#1e3a8a" : "#1d4ed8";
      ctx.lineWidth = active ? 2 : 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);

      ctx.fillStyle = "#ffffff";
      ctx.font = "12px sans-serif";
      ctx.fillText(it.name, r.x + 6, r.y + 16);

      const hs = 8;
      ctx.fillStyle = "#111827";
      ctx.fillRect(r.x + r.w - hs, r.y + r.h - hs, hs, hs);
    }
  }
}

class BayLayoutApp {
  constructor(root) {
    this.root = root;
    this.deviceId = root.dataset.deviceId;
    this.statusEl = document.getElementById("iff-status");
    this.snapEl = document.getElementById("iff-snap");
    this.overlapEl = document.getElementById("iff-overlap");
    this.moduleSelectedEl = document.getElementById("iff-module-selected");
    this.deviceSelectedEl = document.getElementById("iff-device-selected");

    this.moduleEditor = new BayCanvasEditor(
      document.getElementById("iff-module-canvas"),
      (msg) => this._setStatus(msg),
    );
    this.deviceEditor = new BayCanvasEditor(
      document.getElementById("iff-device-canvas"),
      (msg) => this._setStatus(msg),
    );
    this.activeEditor = null;

    this._wire();
    this.load();
  }

  _wire() {
    document
      .getElementById("iff-auto-module")
      .addEventListener("click", () => this.moduleEditor.autoArrange());
    document
      .getElementById("iff-auto-device")
      .addEventListener("click", () => this.deviceEditor.autoArrange());
    document
      .getElementById("iff-center-module")
      .addEventListener("click", () => {
        this.moduleEditor.centerActive();
        this._setStatus("Centered selected module bay");
      });
    document
      .getElementById("iff-center-device")
      .addEventListener("click", () => {
        this.deviceEditor.centerActive();
        this._setStatus("Centered selected device bay");
      });
    document
      .getElementById("iff-save")
      .addEventListener("click", () => this.save());
    document
      .getElementById("iff-reset")
      .addEventListener("click", () => this.load());

    this.moduleEditor.setSelectionChangeHandler((item) => {
      this.activeEditor = this.moduleEditor;
      this.moduleSelectedEl.textContent = item
        ? `${item.name} (${item.x.toFixed(1)}, ${item.y.toFixed(1)})`
        : "None";
    });
    this.deviceEditor.setSelectionChangeHandler((item) => {
      this.activeEditor = this.deviceEditor;
      this.deviceSelectedEl.textContent = item
        ? `${item.name} (${item.x.toFixed(1)}, ${item.y.toFixed(1)})`
        : "None";
    });

    document.addEventListener("keydown", (e) => {
      if (!this.activeEditor) return;
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      const baseStep = e.shiftKey ? 2 : 0.5;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        this.activeEditor.moveActive(-baseStep, 0);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        this.activeEditor.moveActive(baseStep, 0);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.activeEditor.moveActive(0, -baseStep);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.activeEditor.moveActive(0, baseStep);
      }

      const active = this.activeEditor.getActiveItem();
      if (active) {
        const text = `${active.name} (${active.x.toFixed(1)}, ${active.y.toFixed(1)})`;
        if (this.activeEditor === this.moduleEditor)
          this.moduleSelectedEl.textContent = text;
        if (this.activeEditor === this.deviceEditor)
          this.deviceSelectedEl.textContent = text;
      }
    });

    const applyOpts = () => {
      const options = {
        snap: this.snapEl.checked,
        preventOverlap: this.overlapEl.checked,
      };
      this.moduleEditor.setOptions(options);
      this.deviceEditor.setOptions(options);
    };

    this.snapEl.addEventListener("change", applyOpts);
    this.overlapEl.addEventListener("change", applyOpts);
    applyOpts();
  }

  _setStatus(text, isError = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("text-danger", !!isError);
    this.statusEl.classList.toggle(
      "text-success",
      !isError && text.toLowerCase().includes("saved"),
    );
  }

  async load() {
    this._setStatus("Loading...");
    try {
      const res = await fetch(
        `/api/plugins/innovace-fibre/devices/${this.deviceId}/bay-layout/`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.moduleEditor.setItems(data.module_bays || []);
      this.deviceEditor.setItems(data.device_bays || []);
      this.activeEditor = this.moduleEditor;
      this._setStatus("Loaded");
    } catch (err) {
      console.error(err);
      this._setStatus("Failed to load", true);
    }
  }

  async save() {
    this._setStatus("Saving...");
    try {
      const res = await fetch(
        `/api/plugins/innovace-fibre/devices/${this.deviceId}/bay-layout/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRFToken": getCsrfToken(),
          },
          body: JSON.stringify({
            module_bays: this.moduleEditor.getLayouts(),
            device_bays: this.deviceEditor.getLayouts(),
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        this._setStatus(data.error || `Save failed (${res.status})`, true);
        return;
      }
      this._setStatus("Saved ✓");
    } catch (err) {
      console.error(err);
      this._setStatus("Failed to save", true);
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("iff-bay-editor-root");
  if (root) new BayLayoutApp(root);
});
