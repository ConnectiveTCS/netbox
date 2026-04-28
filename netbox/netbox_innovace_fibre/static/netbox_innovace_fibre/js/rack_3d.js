import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ── Constants ────────────────────────────────────────────────────────────────

const U_SCALE_BASE = 1.75;
const RACK_WIDTH = 19.0;
const POST_W = 0.5;
const RAIL_H = 0.25;
const BLANK_DEPTH = 0.5;
const LABEL_SHOW_DIST = 60;
const LS_LAYOUT = 'iff_rack3d_layout';
const LS_SETTINGS = 'iff_rack3d_settings';

const DEPTH_MAP = { realistic: 28.0, flat: 4.0, schematic: 1.2 };

function hashColor(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    const r = 80 + ((h & 0xFF0000) >> 16) % 140;
    const g = 80 + ((h & 0x00FF00) >> 8) % 140;
    const b = 80 + ((h & 0x0000FF)) % 140;
    return (r << 16) | (g << 8) | b;
}

function roleColorInt(hex) { return parseInt(hex, 16) || 0x555555; }

function themeColors(theme) {
    return theme === 'light' ? {
        sceneBg: 0xf0f2f5, floor: 0xe2e8f0, floorLine: 0xc8d0dc,
        post: 0x8899aa, blank: 0xd0d8e4, side: 0x6688aa, deviceDark: 0xdde3eb,
    } : {
        sceneBg: 0x0A0C10, floor: 0x0c0f14, floorLine: 0x182030,
        post: 0x2a2e3a, blank: 0x1e2330, side: 0x3a4a5a, deviceDark: 0x1a1e26,
    };
}

// ── RackScene ────────────────────────────────────────────────────────────────

class RackScene {
    constructor(container) {
        this._container = container;
        this._meshes = [];
        this._labels = [];
        this._textures = [];
        this._animId = null;
        this._settings = { theme: 'dark', labels: 'auto' };

        this._renderer = new THREE.WebGLRenderer({ antialias: true });
        this._renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(this._renderer.domElement);

        this._css2d = new CSS2DRenderer();
        this._css2d.domElement.classList.add('css2d-renderer');
        container.appendChild(this._css2d.domElement);

        this._scene = new THREE.Scene();
        this._scene.background = new THREE.Color(0x0A0C10);

        const { width, height } = container.getBoundingClientRect();
        this._camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);

        this._scene.add(new THREE.AmbientLight(0xffffff, 0.45));
        const dir = new THREE.DirectionalLight(0xffffff, 1.1);
        dir.position.set(15, 25, 20);
        this._scene.add(dir);
        const fill = new THREE.DirectionalLight(0x8899bb, 0.3);
        fill.position.set(-10, 5, -15);
        this._scene.add(fill);

        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.enableDamping = true;
        this._controls.dampingFactor = 0.06;
        this._controls.minDistance = 2;
        this._controls.maxDistance = 600;

        this._raycaster = new THREE.Raycaster();
        this._mouse = new THREE.Vector2();

        this._resizeObserver = new ResizeObserver(() => this._onResize());
        this._resizeObserver.observe(container);
        this._onResize();
        this._animate();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Render a single rack centred at origin */
    load(rackData, settings) {
        this._settings = settings;
        this._updateSceneBg(settings);
        this._clear();
        const offset = new THREE.Vector3(0, 0, 0);
        this._buildRackFrame(rackData.rack, settings, offset);
        this._buildDevices(rackData.devices, rackData.rack, settings, offset);
        if (settings.showEmpty) this._buildEmptySlots(rackData, settings, offset);
        this.resetCamera(rackData.rack, settings);
    }

    /** Render multiple racks on a floor plan */
    loadLayout(placements, rackDataMap, settings) {
        this._settings = settings;
        this._updateSceneBg(settings);
        this._clear();

        const cw = parseFloat(settings.cellWidth) || 30;
        const cd = parseFloat(settings.cellDepth) || 50;

        // Centre the whole floor
        const maxCol = Math.max(0, ...placements.map(p => p.col));
        const maxRow = Math.max(0, ...placements.map(p => p.row));
        const floorW = (maxCol + 1) * cw;
        const floorD = (maxRow + 1) * cd;
        const cx = floorW / 2 - cw / 2;
        const cz = floorD / 2 - cd / 2;

        this._buildFloor(floorW, floorD, settings, cx, cz);

        for (const p of placements) {
            const rd = rackDataMap[p.rackId];
            if (!rd) continue;
            const offset = new THREE.Vector3(p.col * cw - cx, 0, p.row * cd - cz);
            this._buildRackFrame(rd.rack, settings, offset);
            this._buildDevices(rd.devices, rd.rack, settings, offset);
            if (settings.showEmpty) this._buildEmptySlots(rd, settings, offset);
        }

        this.fitView();
    }

    setTheme(theme) {
        this._settings = { ...this._settings, theme };
        this._updateSceneBg({ theme });
    }

    resetCamera(rack, settings) {
        const sc = parseFloat(settings.scale) || 1;
        const totalH = rack.u_height * U_SCALE_BASE * sc;
        const depth = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
        const target = new THREE.Vector3(0, totalH * 0.5, 0);
        const dist = Math.max(totalH, RACK_WIDTH) * 1.6 + depth;
        this._camera.position.set(RACK_WIDTH * 0.8, totalH * 0.55, dist);
        this._camera.lookAt(target);
        this._controls.target.copy(target);
        this._controls.update();
    }

    fitView() {
        const box = new THREE.Box3().setFromObject(this._scene);
        if (box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = this._camera.fov * (Math.PI / 180);
        const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.4;
        this._controls.target.copy(center);
        this._camera.position.set(center.x + dist * 0.4, center.y + dist * 0.5, center.z + dist);
        this._camera.lookAt(center);
        this._controls.update();
    }

    pickDevice(event) {
        const rect = this._container.getBoundingClientRect();
        this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouse, this._camera);
        const hits = this._raycaster.intersectObjects(this._meshes.filter(m => m.userData.deviceId), false);
        return hits.length ? hits[0].object.userData.deviceData : null;
    }

    dispose() {
        cancelAnimationFrame(this._animId);
        this._resizeObserver.disconnect();
        this._clear();
        this._renderer.dispose();
    }

    // ── Private: scene building ───────────────────────────────────────────────

    _buildFloor(w, d, settings, cx, cz) {
        const colors = themeColors(settings.theme);
        const floorMat = new THREE.MeshStandardMaterial({
            color: colors.floor, roughness: 0.9, metalness: 0,
        });
        const floorGeo = new THREE.PlaneGeometry(w + 20, d + 20);
        const floor = new THREE.Mesh(floorGeo, floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set(0, -0.05, 0);
        this._scene.add(floor);
        this._meshes.push(floor);

        // Grid lines
        const lineMat = new THREE.LineBasicMaterial({ color: colors.floorLine });
        const pts = [];
        const hw = (w + 20) / 2, hd = (d + 20) / 2;
        const step = 10;
        for (let x = -hw; x <= hw; x += step) {
            pts.push(new THREE.Vector3(x, 0, -hd), new THREE.Vector3(x, 0, hd));
        }
        for (let z = -hd; z <= hd; z += step) {
            pts.push(new THREE.Vector3(-hw, 0, z), new THREE.Vector3(hw, 0, z));
        }
        const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
        const lines = new THREE.LineSegments(lineGeo, lineMat);
        this._scene.add(lines);
        this._meshes.push(lines);
    }

    _buildRackFrame(rack, settings, offset) {
        const sc = parseFloat(settings.scale) || 1;
        const totalH = rack.u_height * U_SCALE_BASE * sc;
        const depth = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
        const colors = themeColors(settings.theme);
        const mat = new THREE.MeshStandardMaterial({ color: colors.post, metalness: 0.75, roughness: 0.35 });

        const railFL = Math.max(0.5, parseFloat(settings.railFL) || 2);
        const railFR = Math.max(0.5, parseFloat(settings.railFR) || 2);
        const railRL = Math.max(0.5, parseFloat(settings.railRL) || 2);
        const railRR = Math.max(0.5, parseFloat(settings.railRR) || 2);

        const hw = RACK_WIDTH / 2 + POST_W / 2;

        // 4 corner posts with individual depths
        // Front = negative Z (facing camera), Rear = positive Z
        const corners = [
            { sx: -1, zSign: -1, rd: railFL },  // front-left
            { sx: 1, zSign: -1, rd: railFR },  // front-right
            { sx: -1, zSign: 1, rd: railRL },  // rear-left
            { sx: 1, zSign: 1, rd: railRR },  // rear-right
        ];
        for (const { sx, zSign, rd } of corners) {
            const postGeo = new THREE.BoxGeometry(POST_W, totalH, rd);
            const zPos = zSign * (depth / 2 + rd / 2);
            const m = new THREE.Mesh(postGeo, mat);
            m.position.set(offset.x + sx * hw, offset.y + totalH / 2, offset.z + zPos);
            this._scene.add(m);
            this._meshes.push(m);
        }

        // Top + bottom horizontal rails spanning full depth
        const frontExt = Math.max(railFL, railFR);
        const rearExt = Math.max(railRL, railRR);
        const railSpan = depth + frontExt + rearExt;
        const railZOff = (rearExt - frontExt) / 2;
        const railGeo = new THREE.BoxGeometry(RACK_WIDTH + POST_W * 2 + 0.1, RAIL_H, railSpan);
        for (const y of [0, totalH]) {
            const m = new THREE.Mesh(railGeo, mat);
            m.position.set(offset.x, offset.y + y, offset.z + railZOff);
            this._scene.add(m);
            this._meshes.push(m);
        }

        // Translucent side panels
        const sideMat = new THREE.MeshStandardMaterial({
            color: colors.side, transparent: true, opacity: 0.06, side: THREE.DoubleSide,
        });
        const sideGeo = new THREE.PlaneGeometry(railSpan, totalH);
        for (const sx of [-1, 1]) {
            const m = new THREE.Mesh(sideGeo, sideMat);
            m.rotation.y = Math.PI / 2;
            m.position.set(offset.x + sx * (RACK_WIDTH / 2 + POST_W), offset.y + totalH / 2, offset.z + railZOff);
            this._scene.add(m);
            this._meshes.push(m);
        }
    }

    _buildDevices(devices, rack, settings, offset) {
        const sc = parseFloat(settings.scale) || 1;
        const depth = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
        const face = settings.face || 'both';
        const loader = new THREE.TextureLoader();
        const colors = themeColors(settings.theme);
        const darkMat = new THREE.MeshStandardMaterial({ color: colors.deviceDark, metalness: 0.65, roughness: 0.45 });

        for (const dev of devices) {
            if (face === 'front' && dev.face === 'rear' && !dev.is_full_depth) continue;
            if (face === 'rear' && dev.face === 'front' && !dev.is_full_depth) continue;

            const deviceH = dev.u_height * U_SCALE_BASE * sc;
            const deviceDepth = dev.is_full_depth ? depth : depth * 0.55;
            const yBottom = this._calcY(dev, rack, sc);

            const geo = new THREE.BoxGeometry(RACK_WIDTH - POST_W * 2, deviceH, deviceDepth);
            const materials = [
                darkMat, darkMat,
                darkMat, darkMat,
                this._faceMat(dev, 'front', loader, settings, colors),
                this._faceMat(dev, 'rear', loader, settings, colors),
            ];

            const mesh = new THREE.Mesh(geo, materials);
            mesh.position.set(offset.x, offset.y + yBottom + deviceH / 2, offset.z);
            mesh.userData = { deviceId: dev.id, deviceData: dev };
            this._scene.add(mesh);
            this._meshes.push(mesh);

            const div = document.createElement('div');
            div.className = 'r3d-device-label';
            div.textContent = dev.name;
            const label = new CSS2DObject(div);
            label.position.set(0, 0, deviceDepth / 2 + 0.1);
            mesh.add(label);
            this._labels.push(label);
        }

        this._applyLabelMode(settings.labels);
    }

    _faceMat(dev, side, loader, settings, colors) {
        const url = side === 'front' ? dev.front_image : dev.rear_image;
        if (settings.colorBy === 'image' && url) {
            const tex = loader.load(url);
            tex.colorSpace = THREE.SRGBColorSpace;
            this._textures.push(tex);
            return new THREE.MeshBasicMaterial({ map: tex });
        }
        let color;
        if (settings.colorBy === 'role' && dev.role_color) color = roleColorInt(dev.role_color);
        else color = hashColor(dev.manufacturer || dev.device_type || String(dev.id));
        return new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.6 });
    }

    _buildEmptySlots(rackData, settings, offset) {
        const { rack, devices } = rackData;
        const sc = parseFloat(settings.scale) || 1;
        const colors = themeColors(settings.theme);

        const occupied = new Set();
        for (const dev of devices) {
            let u = dev.position;
            while (u < dev.position + dev.u_height) {
                occupied.add(Math.round(u * 2));
                u += 0.5;
            }
        }

        const mat = new THREE.MeshStandardMaterial({ color: colors.blank, metalness: 0.25, roughness: 0.75 });
        const slotH = U_SCALE_BASE * sc;

        for (let u = rack.starting_unit; u < rack.starting_unit + rack.u_height; u++) {
            if (occupied.has(u * 2)) continue;
            const geo = new THREE.BoxGeometry(RACK_WIDTH - POST_W * 2 - 0.05, slotH - 0.08, BLANK_DEPTH);
            const m = new THREE.Mesh(geo, mat);
            m.position.set(offset.x, offset.y + this._calcYFromUnit(u, rack, sc) + slotH / 2, offset.z);
            this._scene.add(m);
            this._meshes.push(m);
        }
    }

    _calcY(dev, rack, sc) { return this._calcYFromUnit(dev.position, rack, sc); }

    _calcYFromUnit(unit, rack, sc) {
        if (rack.desc_units) return (rack.u_height - (unit - rack.starting_unit) - 1) * U_SCALE_BASE * sc;
        return (unit - rack.starting_unit) * U_SCALE_BASE * sc;
    }

    // ── Private: utilities ────────────────────────────────────────────────────

    _updateSceneBg(settings) {
        const colors = themeColors(settings.theme || 'dark');
        this._scene.background = new THREE.Color(colors.sceneBg);
    }

    _clear() {
        for (const m of this._meshes) {
            this._scene.remove(m);
            if (m.geometry) m.geometry.dispose();
            if (Array.isArray(m.material)) m.material.forEach(x => x.dispose());
            else if (m.material) m.material.dispose();
        }
        for (const t of this._textures) t.dispose();
        this._meshes = [];
        this._labels = [];
        this._textures = [];
    }

    _applyLabelMode(mode) {
        if (mode === 'on') { this._labels.forEach(l => { l.element.style.display = ''; }); return; }
        if (mode === 'off') { this._labels.forEach(l => { l.element.style.display = 'none'; }); return; }
        this._updateLabelVisibility();
    }

    _updateLabelVisibility() {
        const dist = this._camera.position.distanceTo(this._controls.target);
        const show = dist < LABEL_SHOW_DIST;
        this._labels.forEach(l => { l.element.style.display = show ? '' : 'none'; });
    }

    _animate() {
        this._animId = requestAnimationFrame(() => this._animate());
        this._controls.update();
        if (this._settings?.labels === 'auto') this._updateLabelVisibility();
        this._renderer.render(this._scene, this._camera);
        this._css2d.render(this._scene, this._camera);
    }

    _onResize() {
        const { width, height } = this._container.getBoundingClientRect();
        if (!width || !height) return;
        this._camera.aspect = width / height;
        this._camera.updateProjectionMatrix();
        this._renderer.setSize(width, height);
        this._css2d.setSize(width, height);
    }
}

// ── LayoutManager ─────────────────────────────────────────────────────────────

class LayoutManager {
    constructor() {
        this._state = this._load();
    }

    get rows() { return this._state.rows; }
    get cols() { return this._state.cols; }
    get cellWidth() { return this._state.cellWidth; }
    get cellDepth() { return this._state.cellDepth; }
    get cells() { return this._state.cells; }   // { "r,c": rackId }

    setGridSize(rows, cols) {
        this._state.rows = rows;
        this._state.cols = cols;
        // remove cells outside new bounds
        for (const key of Object.keys(this._state.cells)) {
            const [r, c] = key.split(',').map(Number);
            if (r >= rows || c >= cols) delete this._state.cells[key];
        }
    }

    setCellSize(w, d) {
        this._state.cellWidth = w;
        this._state.cellDepth = d;
    }

    assign(row, col, rackId) {
        // unassign this rack from wherever it currently is
        for (const [k, v] of Object.entries(this._state.cells)) {
            if (v === rackId) delete this._state.cells[k];
        }
        if (rackId) this._state.cells[`${row},${col}`] = rackId;
        else delete this._state.cells[`${row},${col}`];
    }

    unassign(row, col) {
        delete this._state.cells[`${row},${col}`];
    }

    placements() {
        return Object.entries(this._state.cells).map(([key, rackId]) => {
            const [row, col] = key.split(',').map(Number);
            return { row, col, rackId };
        });
    }

    save() { localStorage.setItem(LS_LAYOUT, JSON.stringify(this._state)); }

    _load() {
        try {
            const raw = localStorage.getItem(LS_LAYOUT);
            if (raw) return JSON.parse(raw);
        } catch (_) { }
        return { rows: 2, cols: 4, cellWidth: 30, cellDepth: 50, cells: {} };
    }
}

// ── AppController ─────────────────────────────────────────────────────────────

class AppController {
    constructor() {
        this._viewport = document.getElementById('r3d-viewport');
        this._loading = document.getElementById('r3d-loading');
        this._empty = document.getElementById('r3d-empty');
        this._siteSel = document.getElementById('filter-site');
        this._rackSel = document.getElementById('filter-rack');
        this._configPanel = document.getElementById('r3d-config');
        this._layoutPanel = document.getElementById('r3d-layout-panel');
        this._infoPanel = document.getElementById('r3d-info');
        this._infoTitle = document.getElementById('r3d-info-title');
        this._infoBody = document.getElementById('r3d-info-body');
        this._root = document.getElementById('rack3d-root');
        this._themeBtn = document.getElementById('btn-theme-toggle');

        this._allRacks = [];
        this._loadedRacks = {};   // rackId → rackData (cache)
        this._loadId = 0;
        this._currentData = null; // single-rack mode
        this._layoutMode = false;
        this._layout = new LayoutManager();

        this._restoreSettings();
        this._scene = new RackScene(this._viewport);
        this._wireEvents();
        this._loadSitesAndRacks();
    }

    // ── Persistence ───────────────────────────────────────────────────────────

    _restoreSettings() {
        try {
            const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}');
            if (s.theme) this._root.setAttribute('data-theme', s.theme);
            if (s.scale) document.querySelector(`input[name="scale"][value="${s.scale}"]`)?.click();
            if (s.depth) document.querySelector(`input[name="depth"][value="${s.depth}"]`)?.click();
            if (s.labels) document.querySelector(`input[name="labels"][value="${s.labels}"]`)?.click();
            if (s.colorby) document.querySelector(`input[name="colorby"][value="${s.colorby}"]`)?.click();
            if (s.empty) document.querySelector(`input[name="empty"][value="${s.empty}"]`)?.click();
            if (s.railFL) document.getElementById('cfg-rail-fl').value = s.railFL;
            if (s.railFR) document.getElementById('cfg-rail-fr').value = s.railFR;
            if (s.railRL) document.getElementById('cfg-rail-rl').value = s.railRL;
            if (s.railRR) document.getElementById('cfg-rail-rr').value = s.railRR;
            this._updateThemeBtn();
        } catch (_) { }
    }

    _saveSettings() {
        const s = this._settings();
        localStorage.setItem(LS_SETTINGS, JSON.stringify({
            theme: s.theme, scale: s.scale, depth: s.depth,
            labels: s.labels, colorby: s.colorBy, empty: s.showEmpty ? 'yes' : 'no',
            railFL: s.railFL, railFR: s.railFR, railRL: s.railRL, railRR: s.railRR,
        }));
    }

    // ── Event wiring ──────────────────────────────────────────────────────────

    _wireEvents() {
        this._siteSel.addEventListener('change', () => this._updateRackDropdown());
        this._rackSel.addEventListener('change', () => {
            const id = this._rackSel.value;
            if (id) { this._layoutMode = false; this._loadRack(id); }
        });

        document.querySelectorAll('.r3d-face-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.r3d-face-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._rebuildScene();
            });
        });

        document.getElementById('btn-reset-cam').addEventListener('click', () => {
            if (this._currentData) this._scene.resetCamera(this._currentData.rack, this._settings());
            else this._scene.fitView();
        });
        document.getElementById('btn-fit-rack').addEventListener('click', () => this._scene.fitView());

        document.getElementById('btn-config-toggle').addEventListener('click', () => {
            this._configPanel.classList.toggle('r3d-config-hidden');
        });
        document.getElementById('btn-config-close').addEventListener('click', () => {
            this._configPanel.classList.add('r3d-config-hidden');
        });

        this._configPanel.addEventListener('change', () => {
            this._rebuildScene();
            this._saveSettings();
        });

        // Theme
        document.getElementById('btn-theme-toggle').addEventListener('click', () => this._toggleTheme());

        // Layout panel
        document.getElementById('btn-layout').addEventListener('click', () => this._openLayoutPanel());
        document.getElementById('btn-layout-close').addEventListener('click', () => this._closeLayoutPanel());
        document.getElementById('btn-layout-apply').addEventListener('click', () => this._applyLayout());
        document.getElementById('btn-update-grid').addEventListener('click', () => {
            const rows = parseInt(document.getElementById('cfg-rows').value) || 2;
            const cols = parseInt(document.getElementById('cfg-cols').value) || 4;
            this._layout.setGridSize(rows, cols);
            this._renderLayoutGrid();
        });
        // sync cell size inputs to layout immediately (no rebuild needed until Apply)
        document.getElementById('cfg-cell-w').addEventListener('change', () => {
            this._layout.setCellSize(
                parseFloat(document.getElementById('cfg-cell-w').value) || 30,
                parseFloat(document.getElementById('cfg-cell-d').value) || 50,
            );
        });
        document.getElementById('cfg-cell-d').addEventListener('change', () => {
            document.getElementById('cfg-cell-w').dispatchEvent(new Event('change'));
        });

        // Info panel
        document.getElementById('btn-info-close').addEventListener('click', () => this._hideInfo());

        // Device picking
        this._viewport.addEventListener('click', e => {
            const dev = this._scene.pickDevice(e);
            if (dev) this._showInfo(dev);
            else this._hideInfo();
        });
    }

    // ── Data loading ──────────────────────────────────────────────────────────

    async _loadSitesAndRacks() {
        try {
            const res = await fetch('/api/plugins/innovace-fibre/racks/');
            const data = await res.json();
            this._allRacks = data.racks || [];

            for (const site of data.sites || []) {
                const opt = document.createElement('option');
                opt.value = site.id;
                opt.textContent = site.name;
                this._siteSel.appendChild(opt);
            }
            this._updateRackDropdown();
        } catch (e) { console.error('Failed to load rack list:', e); }
    }

    _updateRackDropdown() {
        const siteId = this._siteSel.value;
        const racks = siteId ? this._allRacks.filter(r => String(r.site_id) === siteId) : this._allRacks;
        this._rackSel.innerHTML = '<option value="">Select rack…</option>';
        for (const r of racks) {
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = r.site ? `${r.site} / ${r.name}` : r.name;
            this._rackSel.appendChild(opt);
        }
    }

    async _loadRack(rackId) {
        if (this._loadedRacks[rackId]) {
            this._currentData = this._loadedRacks[rackId];
            this._scene.load(this._currentData, this._settings());
            this._showLoading(false);
            return;
        }
        const id = ++this._loadId;
        this._showLoading(true);
        this._hideInfo();
        try {
            const res = await fetch(`/api/plugins/innovace-fibre/racks/${rackId}/3d-data/`);
            if (id !== this._loadId) return;
            const data = await res.json();
            this._loadedRacks[rackId] = data;
            this._currentData = data;
            this._scene.load(data, this._settings());
            this._showLoading(false);
        } catch (e) {
            console.error('Rack 3D data load failed:', e);
            this._showLoading(false);
        }
    }

    async _fetchMissingRacks(rackIds) {
        const missing = rackIds.filter(id => !this._loadedRacks[id]);
        await Promise.all(missing.map(async id => {
            try {
                const res = await fetch(`/api/plugins/innovace-fibre/racks/${id}/3d-data/`);
                this._loadedRacks[id] = await res.json();
            } catch (e) { console.error(`Failed to load rack ${id}:`, e); }
        }));
    }

    // ── Layout panel ──────────────────────────────────────────────────────────

    _openLayoutPanel() {
        // Sync layout sidebar inputs from state
        document.getElementById('cfg-rows').value = this._layout.rows;
        document.getElementById('cfg-cols').value = this._layout.cols;
        document.getElementById('cfg-cell-w').value = this._layout.cellWidth;
        document.getElementById('cfg-cell-d').value = this._layout.cellDepth;

        this._layoutPanel.classList.remove('r3d-layout-hidden');
        this._renderLayoutGrid();
        this._renderAvailableList();
    }

    _closeLayoutPanel() {
        this._layoutPanel.classList.add('r3d-layout-hidden');
    }

    async _applyLayout() {
        const placements = this._layout.placements();
        if (!placements.length) {
            this._closeLayoutPanel();
            return;
        }
        this._layout.save();
        this._closeLayoutPanel();
        this._showLoading(true);
        this._layoutMode = true;
        this._currentData = null;

        const rackIds = [...new Set(placements.map(p => p.rackId))];
        await this._fetchMissingRacks(rackIds);
        this._showLoading(false);

        this._scene.loadLayout(placements, this._loadedRacks, this._settings());
    }

    _renderAvailableList() {
        const placed = new Set(Object.values(this._layout.cells));
        const el = document.getElementById('r3d-available-list');
        el.innerHTML = '';
        for (const rack of this._allRacks) {
            const chip = document.createElement('div');
            chip.className = 'available-rack-chip' + (placed.has(rack.id) ? ' placed' : '');
            chip.textContent = rack.site ? `${rack.site} / ${rack.name}` : rack.name;
            el.appendChild(chip);
        }
    }

    _renderLayoutGrid() {
        const rows = this._layout.rows;
        const cols = this._layout.cols;
        const oldGrid = document.getElementById('r3d-floor-grid');

        // Replace the element to drop any stale delegated listeners
        const grid = document.createElement('div');
        grid.id = 'r3d-floor-grid';
        grid.style.display = 'grid';
        grid.style.gap = '6px';
        oldGrid.replaceWith(grid);

        grid.style.gridTemplateColumns = `repeat(${cols}, minmax(110px, 1fr))`;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const key = `${r},${c}`;
                const rackId = this._layout.cells[key];
                const rack = rackId ? this._allRacks.find(x => String(x.id) === String(rackId)) : null;

                const cell = document.createElement('div');
                cell.className = 'layout-cell';
                cell.dataset.key = key;

                if (rack) {
                    const name = rack.site ? `${rack.site} / ${rack.name}` : rack.name;
                    cell.innerHTML = `
                        <div class="layout-cell-rack">
                          <span title="${name}">${name}</span>
                          <button class="layout-cell-remove" data-key="${key}" title="Remove">×</button>
                        </div>`;
                } else {
                    // Inline select for assignment — must have class no-ts
                    const opts = this._allRacks
                        .filter(x => {
                            // only show racks not already placed elsewhere
                            const placed = Object.entries(this._layout.cells).find(([k, v]) => String(v) === String(x.id));
                            return !placed;
                        })
                        .map(x => `<option value="${x.id}">${x.site ? x.site + ' / ' + x.name : x.name}</option>`)
                        .join('');
                    cell.innerHTML = `
                        <div class="layout-cell-empty" style="width:100%;padding:6px">
                          <select class="no-ts layout-cell-select" data-key="${key}">
                            <option value="">+ Assign rack</option>
                            ${opts}
                          </select>
                        </div>`;
                }

                grid.appendChild(cell);
            }
        }

        // Events — delegated on grid container (fresh element, no accumulation)
        grid.addEventListener('change', e => {
            const sel = e.target.closest('.layout-cell-select');
            if (!sel || !sel.value) return;
            const [row, col] = sel.dataset.key.split(',').map(Number);
            this._layout.assign(row, col, parseInt(sel.value));
            this._renderLayoutGrid();
            this._renderAvailableList();
        });

        grid.addEventListener('click', e => {
            const btn = e.target.closest('.layout-cell-remove');
            if (!btn) return;
            const [row, col] = btn.dataset.key.split(',').map(Number);
            this._layout.unassign(row, col);
            this._renderLayoutGrid();
            this._renderAvailableList();
        });
    }

    // ── Theme ─────────────────────────────────────────────────────────────────

    _toggleTheme() {
        const current = this._root.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        this._root.setAttribute('data-theme', next);
        this._scene.setTheme(next);
        this._rebuildScene();
        this._updateThemeBtn();
        this._saveSettings();
    }

    _updateThemeBtn() {
        const theme = this._root.getAttribute('data-theme') || 'dark';
        this._themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
        this._themeBtn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }

    // ── Scene rebuild ─────────────────────────────────────────────────────────

    _rebuildScene() {
        if (this._layoutMode) {
            const placements = this._layout.placements();
            if (placements.length) this._scene.loadLayout(placements, this._loadedRacks, this._settings());
        } else if (this._currentData) {
            this._scene.load(this._currentData, this._settings());
        }
    }

    // ── Settings snapshot ─────────────────────────────────────────────────────

    _settings() {
        const theme = this._root.getAttribute('data-theme') || 'dark';
        return {
            theme,
            scale: document.querySelector('input[name="scale"]:checked')?.value || '1',
            depth: document.querySelector('input[name="depth"]:checked')?.value || 'realistic',
            labels: document.querySelector('input[name="labels"]:checked')?.value || 'auto',
            colorBy: document.querySelector('input[name="colorby"]:checked')?.value || 'image',
            showEmpty: document.querySelector('input[name="empty"]:checked')?.value === 'yes',
            face: document.querySelector('.r3d-face-btn.active')?.dataset.face || 'both',
            railFL: parseFloat(document.getElementById('cfg-rail-fl')?.value) || 2,
            railFR: parseFloat(document.getElementById('cfg-rail-fr')?.value) || 2,
            railRL: parseFloat(document.getElementById('cfg-rail-rl')?.value) || 2,
            railRR: parseFloat(document.getElementById('cfg-rail-rr')?.value) || 2,
            cellWidth: parseFloat(document.getElementById('cfg-cell-w')?.value) || 30,
            cellDepth: parseFloat(document.getElementById('cfg-cell-d')?.value) || 50,
        };
    }

    // ── Info panel ────────────────────────────────────────────────────────────

    _showInfo(dev) {
        this._infoTitle.textContent = dev.name;
        this._infoBody.innerHTML = `
            <div class="r3d-info-row"><span class="r3d-info-lbl">Device</span><span class="r3d-info-val"><a href="${dev.url}" target="_blank">${dev.name}</a></span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Type</span><span class="r3d-info-val">${dev.device_type}</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Maker</span><span class="r3d-info-val">${dev.manufacturer || '—'}</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Role</span><span class="r3d-info-val">${dev.role || '—'}</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Position</span><span class="r3d-info-val">U${dev.position}</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Face</span><span class="r3d-info-val">${dev.face}</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Height</span><span class="r3d-info-val">${dev.u_height}U</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Full depth</span><span class="r3d-info-val">${dev.is_full_depth ? 'Yes' : 'No'}</span></div>
        `;
        this._infoPanel.classList.remove('r3d-info-hidden');
    }

    _hideInfo() { this._infoPanel.classList.add('r3d-info-hidden'); }

    _showLoading(on) {
        this._loading.style.display = on ? 'flex' : 'none';
        this._empty.style.display = (on || this._currentData || this._layoutMode) ? 'none' : '';
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => new AppController());
