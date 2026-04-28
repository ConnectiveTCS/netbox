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

function orientToRad(o) {
    return { N: 0, E: Math.PI / 2, S: Math.PI, W: -Math.PI / 2 }[o] || 0;
}

function getCsrfToken() {
    if (window.CSRF_TOKEN) return window.CSRF_TOKEN;
    const match = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='));
    return match ? match.trim().split('=')[1] : '';
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
        const s = this._css2d.domElement.style;
        s.position = 'absolute';
        s.top = '0';
        s.left = '0';
        s.width = '100%';
        s.height = '100%';
        s.pointerEvents = 'none';
        s.overflow = 'hidden';
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
        this._controls.enableDamping   = true;
        this._controls.dampingFactor   = 0.12;   // snappier response
        this._controls.minDistance     = 2;
        this._controls.maxDistance     = 600;
        // Left-drag = pan (matches floor-plan / CAD conventions)
        // Right-drag = orbit/spin
        this._controls.mouseButtons    = {
            LEFT:   THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT:  THREE.MOUSE.PAN,
        };
        // Pan follows the screen axes (mouse left ↔ view left, mouse up ↔ view up)
        this._controls.screenSpacePanning = true;
        this._controls.panSpeed        = 2.0;    // 1:1 — viewport unit per pixel
        this._controls.rotateSpeed     = 0.6;    // slightly slower for precision
        this._controls.zoomSpeed       = 1.2;

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

    /**
     * Render multiple racks on a floor plan.
     * placements: [{rackId, x, z, orientation}]  (x/z in world units = inches)
     * settings must include floorWidth, floorDepth
     */
    loadLayout(placements, rackDataMap, settings) {
        this._settings = settings;
        this._updateSceneBg(settings);
        this._clear();
        if (!placements.length) return;

        const fw = parseFloat(settings.floorWidth) || 400;
        const fd = parseFloat(settings.floorDepth) || 300;
        const cx = fw / 2;
        const cz = fd / 2;

        this._buildFloor(fw, fd, settings);

        for (const p of placements) {
            const rd = rackDataMap[p.rackId];
            if (!rd) continue;

            const group = new THREE.Group();
            group.position.set(p.x - cx, 0, p.z - cz);
            group.rotation.y = orientToRad(p.orientation || 'N');
            this._scene.add(group);
            this._meshes.push(group);

            const zero = new THREE.Vector3(0, 0, 0);
            this._buildRackFrame(rd.rack, settings, zero, group);
            this._buildDevices(rd.devices, rd.rack, settings, zero, group);
            if (settings.showEmpty) this._buildEmptySlots(rd, settings, zero, group);
        }

        this.fitView();
    }

    setTheme(theme) {
        this._settings = { ...this._settings, theme };
        this._updateSceneBg({ theme });
    }

    setLabelMode(mode) {
        this._settings = { ...this._settings, labels: mode };
        this._applyLabelMode(mode);
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
        const hits = this._raycaster.intersectObjects(this._scene.children, true).filter(h => h.object.userData.deviceId);
        return hits.length ? hits[0].object.userData.deviceData : null;
    }

    dispose() {
        cancelAnimationFrame(this._animId);
        this._resizeObserver.disconnect();
        this._clear();
        this._renderer.dispose();
    }

    // ── Private: scene building ───────────────────────────────────────────────

    _buildFloor(w, d, settings) {
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

    _buildRackFrame(rack, settings, offset, parent) {
        const target = parent || this._scene;
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

        const corners = [
            { sx: -1, zSign: -1, rd: railFL },
            { sx: 1, zSign: -1, rd: railFR },
            { sx: -1, zSign: 1, rd: railRL },
            { sx: 1, zSign: 1, rd: railRR },
        ];
        for (const { sx, zSign, rd } of corners) {
            const postGeo = new THREE.BoxGeometry(POST_W, totalH, rd);
            const zPos = zSign * (depth / 2 + rd / 2);
            const m = new THREE.Mesh(postGeo, mat);
            m.position.set(offset.x + sx * hw, offset.y + totalH / 2, offset.z + zPos);
            target.add(m);
            if (!parent) this._meshes.push(m);
        }

        const frontExt = Math.max(railFL, railFR);
        const rearExt = Math.max(railRL, railRR);
        const railSpan = depth + frontExt + rearExt;
        const railZOff = (rearExt - frontExt) / 2;
        const railGeo = new THREE.BoxGeometry(RACK_WIDTH + POST_W * 2 + 0.1, RAIL_H, railSpan);
        for (const y of [0, totalH]) {
            const m = new THREE.Mesh(railGeo, mat);
            m.position.set(offset.x, offset.y + y, offset.z + railZOff);
            target.add(m);
            if (!parent) this._meshes.push(m);
        }

        const sideMat = new THREE.MeshStandardMaterial({
            color: colors.side, transparent: true, opacity: 0.06, side: THREE.DoubleSide,
        });
        const sideGeo = new THREE.PlaneGeometry(railSpan, totalH);
        for (const sx of [-1, 1]) {
            const m = new THREE.Mesh(sideGeo, sideMat);
            m.rotation.y = Math.PI / 2;
            m.position.set(offset.x + sx * (RACK_WIDTH / 2 + POST_W), offset.y + totalH / 2, offset.z + railZOff);
            target.add(m);
            if (!parent) this._meshes.push(m);
        }
    }

    _buildDevices(devices, rack, settings, offset, parent) {
        const target = parent || this._scene;
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

            // Align device Z with its mounting rail:
            //   full-depth  → centred across full depth
            //   front-face  → flush with the +Z (camera-side) inner rail face
            //   rear-face   → flush with the -Z inner rail face
            let deviceZ;
            if (dev.is_full_depth) {
                deviceZ = offset.z;
            } else if (dev.face === 'front') {
                deviceZ = offset.z + depth / 2 - deviceDepth / 2;
            } else {
                deviceZ = offset.z - depth / 2 + deviceDepth / 2;
            }

            const geo = new THREE.BoxGeometry(RACK_WIDTH - POST_W * 2, deviceH, deviceDepth);
            const materials = [
                darkMat, darkMat,
                darkMat, darkMat,
                this._faceMat(dev, 'front', loader, settings, colors),
                this._faceMat(dev, 'rear', loader, settings, colors),
            ];

            const mesh = new THREE.Mesh(geo, materials);
            mesh.position.set(offset.x, offset.y + yBottom + deviceH / 2, deviceZ);
            mesh.userData = { deviceId: dev.id, deviceData: dev };
            target.add(mesh);
            if (!parent) this._meshes.push(mesh);

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
        if (settings.colorBy === 'image') {
            if (url) {
                const tex = loader.load(url);
                tex.colorSpace = THREE.SRGBColorSpace;
                this._textures.push(tex);
                return new THREE.MeshBasicMaterial({ map: tex });
            }
            // No image — fall back to device-type hash
            return new THREE.MeshStandardMaterial({
                color: hashColor(dev.device_type || String(dev.id)),
                metalness: 0.3, roughness: 0.6,
            });
        }
        let color;
        if (settings.colorBy === 'role') {
            color = dev.role_color ? roleColorInt(dev.role_color) : hashColor(dev.role || 'unassigned');
        } else {
            // manufacturer (or unknown fallback)
            color = hashColor(dev.manufacturer || dev.device_type || String(dev.id));
        }
        return new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.6 });
    }

    _buildEmptySlots(rackData, settings, offset, parent) {
        // Blank panels are front-mounted only — skip entirely for rear-only view
        if (settings.face === 'rear') return;
        const target = parent || this._scene;
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
        const depth = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
        // Blank panels sit flush with the front (+Z) mounting rail, same as front-mounted devices
        const blankZ = offset.z + depth / 2 - BLANK_DEPTH / 2;

        for (let u = rack.starting_unit; u < rack.starting_unit + rack.u_height; u++) {
            if (occupied.has(u * 2)) continue;
            const geo = new THREE.BoxGeometry(RACK_WIDTH - POST_W * 2 - 0.05, slotH - 0.08, BLANK_DEPTH);
            const m = new THREE.Mesh(geo, mat);
            m.position.set(offset.x, offset.y + this._calcYFromUnit(u, rack, sc) + slotH / 2, blankZ);
            target.add(m);
            if (!parent) this._meshes.push(m);
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
        for (const obj of this._meshes) {
            this._scene.remove(obj);
            obj.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                const mats = Array.isArray(child.material) ? child.material : (child.material ? [child.material] : []);
                mats.forEach(m => m.dispose());
            });
        }
        for (const t of this._textures) t.dispose();
        this._meshes = [];
        this._labels = [];
        this._textures = [];
    }

    _applyLabelMode(mode) {
        if (mode === 'on') { this._labels.forEach(l => { l.visible = true; }); return; }
        if (mode === 'off') { this._labels.forEach(l => { l.visible = false; }); return; }
        this._updateLabelVisibility();
    }

    _updateLabelVisibility() {
        const dist = this._camera.position.distanceTo(this._controls.target);
        const show = dist < LABEL_SHOW_DIST;
        this._labels.forEach(l => { l.visible = show; });
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

// ── FloorCanvas ───────────────────────────────────────────────────────────────
// 2D canvas-based floor plan editor with drag-and-drop placement, snap-to-grid,
// click-to-select, drag-to-reposition, and right-click context menu.

class FloorCanvas {
    constructor(canvasEl, onSelectionChange) {
        this._canvas = canvasEl;
        this._ctx = canvasEl.getContext('2d');
        this._onSelectionChange = onSelectionChange;

        // Placements: rackId (string) → {x, z, orientation}
        this._placements = new Map();
        this._allRacks = [];
        this._selectedId = null;
        this._config = { width: 400, depth: 300, gridSnap: 12, snapEnabled: true, rackDepth: 40, unit: 'in' };

        // pixels per world unit (auto-computed)
        this._scale = 2;

        // Mouse drag state
        this._dragState = null;

        // Right-click menu target
        this._ctxMenuRackId = null;

        this._bindEvents();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    setConfig(cfg) {
        this._config = { ...this._config, ...cfg };
        this._computeScale();
        this.render();
    }

    setRacks(allRacks) { this._allRacks = allRacks; }

    setPlacements(placements) {
        this._placements = new Map();
        for (const p of placements) {
            this._placements.set(String(p.rackId), { x: p.x, z: p.z, orientation: p.orientation || 'N' });
        }
        this.render();
    }

    getPlacements() {
        return [...this._placements.entries()].map(([rackId, p]) => ({
            rackId: parseInt(rackId, 10) || rackId,
            x: p.x, z: p.z, orientation: p.orientation,
        }));
    }

    placeRack(rackId, x, z, orientation = 'N') {
        this._placements.set(String(rackId), { x: this._snap(x), z: this._snap(z), orientation });
        this.render();
    }

    removeRack(rackId) {
        this._placements.delete(String(rackId));
        if (String(this._selectedId) === String(rackId)) {
            this._selectedId = null;
            this._onSelectionChange(null);
        }
        this.render();
    }

    rotateRack(rackId, dir) {
        const p = this._placements.get(String(rackId));
        if (!p) return;
        const order = ['N', 'E', 'S', 'W'];
        const idx = order.indexOf(p.orientation);
        p.orientation = order[(idx + (dir > 0 ? 1 : 3)) % 4];
        this.render();
        if (String(this._selectedId) === String(rackId)) {
            this._onSelectionChange(this._getSelected());
        }
    }

    updateSelected(x, z, orientation) {
        if (!this._selectedId) return;
        const p = this._placements.get(String(this._selectedId));
        if (!p) return;
        p.x = this._snap(parseFloat(x) || 0);
        p.z = this._snap(parseFloat(z) || 0);
        p.orientation = orientation;
        this.render();
    }

    clearSelection() {
        this._selectedId = null;
        this._onSelectionChange(null);
        this.render();
    }

    isPlaced(rackId) { return this._placements.has(String(rackId)); }

    render() {
        const { width, depth, gridSnap, unit } = this._config;
        const sc = this._scale;
        const cw = Math.max(1, Math.round(width * sc));
        const ch = Math.max(1, Math.round(depth * sc));

        this._canvas.width = cw;
        this._canvas.height = ch;

        const ctx = this._ctx;
        const isLight = (document.getElementById('rack3d-root')?.getAttribute('data-theme') || 'dark') === 'light';

        // Floor background
        ctx.fillStyle = isLight ? '#dde4ef' : '#0d1018';
        ctx.fillRect(0, 0, cw, ch);

        // Grid lines
        ctx.strokeStyle = isLight ? '#c8d0e0' : '#1a2030';
        ctx.lineWidth = 0.5;
        const step = gridSnap * sc;
        if (step > 3) {
            for (let x = 0; x <= cw; x += step) {
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
            }
            for (let z = 0; z <= ch; z += step) {
                ctx.beginPath(); ctx.moveTo(0, z); ctx.lineTo(cw, z); ctx.stroke();
            }
        }

        // Grid number labels every 5 snaps (or fewer if large)
        const labelEvery = Math.max(gridSnap * 5, Math.ceil(50 / sc / gridSnap) * gridSnap);
        const labelStep = labelEvery * sc;
        ctx.fillStyle = isLight ? '#8899aa' : '#3a4a5a';
        ctx.font = '9px monospace';
        if (labelStep > 20) {
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            for (let ww = labelEvery; ww < width; ww += labelEvery) {
                const px = Math.round(ww * sc);
                ctx.fillText(`${ww}${unit}`, px + 2, 2);
            }
            for (let dd = labelEvery; dd < depth; dd += labelEvery) {
                const pz = Math.round(dd * sc);
                ctx.fillText(`${dd}`, 2, pz + 2);
            }
        }

        // Border
        ctx.strokeStyle = isLight ? '#8899cc' : '#2a3a5a';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(0.75, 0.75, cw - 1.5, ch - 1.5);

        // Draw racks
        const rackW = 19 * sc;
        const rackD = this._config.rackDepth * sc;

        for (const [rackId, p] of this._placements) {
            const rack = this._allRacks.find(r => String(r.id) === String(rackId));
            const px = p.x * sc;
            const pz = p.z * sc;
            const isSelected = String(rackId) === String(this._selectedId);

            ctx.save();
            ctx.translate(px, pz);
            ctx.rotate(this._orientRad(p.orientation));

            // Fill
            ctx.fillStyle = isSelected
                ? (isLight ? '#93c5fd' : '#1a3a6a')
                : (isLight ? '#c8daf5' : '#1e2d42');
            ctx.fillRect(-rackW / 2, -rackD / 2, rackW, rackD);

            // Border
            ctx.strokeStyle = isSelected ? '#4a9eff' : (isLight ? '#7799cc' : '#2a4a6a');
            ctx.lineWidth = isSelected ? 2.5 : 1;
            ctx.strokeRect(-rackW / 2, -rackD / 2, rackW, rackD);

            // Front face indicator (thin bar at z = -rackD/2)
            ctx.fillStyle = isSelected ? '#4a9eff' : (isLight ? '#4488cc' : '#3a6a9a');
            ctx.fillRect(-rackW / 2, -rackD / 2, rackW, Math.max(2, rackD * 0.08));

            // Orientation letter
            const fontSize = Math.max(8, Math.min(16, rackD * 0.35));
            ctx.fillStyle = isLight ? '#1a1a2e' : '#c9d1e0';
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(p.orientation, 0, rackD * 0.12);

            ctx.restore();

            // Rack name label (unrotated, above rack)
            if (rack) {
                const label = rack.name.length > 18 ? rack.name.slice(0, 17) + '…' : rack.name;
                ctx.fillStyle = isLight ? '#1a1a2e' : '#c9d1e0';
                ctx.font = '9px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(label, px, pz - rackD / 2 - 3);
            }
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    _computeScale() {
        const MAX_PX = 1100;
        const byWidth = MAX_PX / (this._config.width || 1);
        const byDepth = MAX_PX / (this._config.depth || 1);
        this._scale = Math.min(Math.max(byWidth, byDepth, 0.5), 4, Math.min(byWidth, byDepth) * 1.1);
        // Clamp to reasonable range
        this._scale = Math.min(this._scale, 4);
        this._scale = Math.max(this._scale, 0.5);
    }

    _snap(v) {
        if (!this._config.snapEnabled) return Math.round(v * 10) / 10;
        const s = this._config.gridSnap;
        return Math.round(v / s) * s;
    }

    _orientRad(o) {
        return { N: 0, E: Math.PI / 2, S: Math.PI, W: -Math.PI / 2 }[o] || 0;
    }

    _rackAt(px, pz) {
        const sc = this._scale;
        const rackW = 19 * sc;
        const rackD = this._config.rackDepth * sc;
        // Iterate in reverse so topmost-drawn rack is hit first
        for (const [rackId, p] of [...this._placements].reverse()) {
            const cx = p.x * sc;
            const cz = p.z * sc;
            const angle = -this._orientRad(p.orientation);
            const dx = px - cx, dz = pz - cz;
            const lx = dx * Math.cos(angle) - dz * Math.sin(angle);
            const lz = dx * Math.sin(angle) + dz * Math.cos(angle);
            if (Math.abs(lx) <= rackW / 2 && Math.abs(lz) <= rackD / 2) return rackId;
        }
        return null;
    }

    _getSelected() {
        if (!this._selectedId) return null;
        const p = this._placements.get(String(this._selectedId));
        if (!p) return null;
        const rack = this._allRacks.find(r => String(r.id) === String(this._selectedId));
        return { rackId: this._selectedId, rack, ...p };
    }

    _canvasPos(e) {
        const rect = this._canvas.getBoundingClientRect();
        const scaleX = this._canvas.width / rect.width;
        const scaleY = this._canvas.height / rect.height;
        return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
    }

    _bindEvents() {
        const canvas = this._canvas;

        // Click: select / deselect
        canvas.addEventListener('click', e => {
            const [px, pz] = this._canvasPos(e);
            const id = this._rackAt(px, pz);
            this._selectedId = id || null;
            this.render();
            this._onSelectionChange(this._getSelected());
        });

        // Mousedown: start drag
        canvas.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            const [px, pz] = this._canvasPos(e);
            const id = this._rackAt(px, pz);
            if (!id) return;
            const p = this._placements.get(id);
            this._dragState = {
                rackId: id,
                startMouseX: px, startMouseZ: pz,
                startX: p.x, startZ: p.z,
            };
            this._selectedId = id;
            this.render();
            this._onSelectionChange(this._getSelected());
            e.preventDefault();
        });

        canvas.addEventListener('mousemove', e => {
            if (!this._dragState) return;
            const [px, pz] = this._canvasPos(e);
            const sc = this._scale;
            const dx = (px - this._dragState.startMouseX) / sc;
            const dz = (pz - this._dragState.startMouseZ) / sc;
            const p = this._placements.get(this._dragState.rackId);
            if (p) {
                p.x = this._snap(this._dragState.startX + dx);
                p.z = this._snap(this._dragState.startZ + dz);
                this.render();
                this._onSelectionChange(this._getSelected());
            }
        });

        canvas.addEventListener('mouseup', () => { this._dragState = null; });
        canvas.addEventListener('mouseleave', () => { this._dragState = null; });

        // Right-click: show context menu
        canvas.addEventListener('contextmenu', e => {
            e.preventDefault();
            const [px, pz] = this._canvasPos(e);
            const id = this._rackAt(px, pz);
            this._ctxMenuRackId = id;
            if (id) {
                this._selectedId = id;
                this.render();
                this._onSelectionChange(this._getSelected());
                const menu = document.getElementById('r3d-ctx-menu');
                menu.style.left = e.clientX + 'px';
                menu.style.top = e.clientY + 'px';
                menu.classList.remove('r3d-ctx-hidden');
            }
        });

        // Drag-and-drop from unplaced rack list
        canvas.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            canvas.classList.add('drag-over');
        });
        canvas.addEventListener('dragleave', () => canvas.classList.remove('drag-over'));
        canvas.addEventListener('drop', e => {
            e.preventDefault();
            canvas.classList.remove('drag-over');
            const rackId = e.dataTransfer.getData('text/plain');
            if (!rackId) return;
            const [px, pz] = this._canvasPos(e);
            const sc = this._scale;
            const wx = this._snap(px / sc);
            const wz = this._snap(pz / sc);
            this._placements.set(String(rackId), { x: wx, z: wz, orientation: 'N' });
            this._selectedId = String(rackId);
            this.render();
            this._onSelectionChange(this._getSelected());
        });
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
        this._saveStatus = document.getElementById('r3d-save-status');

        this._allRacks = [];
        this._loadedRacks = {};   // rackId → rackData (cache)
        this._loadId = 0;
        this._currentData = null; // single-rack mode
        this._layoutMode = false;

        /** @type {FloorCanvas|null} */
        this._canvas = null;

        this._restoreSettings();
        this._scene = new RackScene(this._viewport);
        this._wireEvents();
        this._loadSitesAndRacks();
    }

    // ── Settings persistence ──────────────────────────────────────────────────

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
        // Site/rack selectors
        this._siteSel.addEventListener('change', () => {
            this._updateRackDropdown();
            const siteId = this._siteSel.value;
            if (siteId) this._autoLoadFloorPlan(siteId);
        });
        this._rackSel.addEventListener('change', () => {
            const id = this._rackSel.value;
            if (id) { this._layoutMode = false; this._loadRack(id); }
        });

        // Face toggle
        document.querySelectorAll('.r3d-face-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.r3d-face-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._rebuildScene();
            });
        });

        // Camera controls
        document.getElementById('btn-reset-cam').addEventListener('click', () => {
            if (this._currentData) this._scene.resetCamera(this._currentData.rack, this._settings());
            else this._scene.fitView();
        });
        document.getElementById('btn-fit-rack').addEventListener('click', () => this._scene.fitView());

        // Config panel
        document.getElementById('btn-config-toggle').addEventListener('click', () => {
            this._configPanel.classList.toggle('r3d-config-hidden');
        });
        document.getElementById('btn-config-close').addEventListener('click', () => {
            this._configPanel.classList.add('r3d-config-hidden');
        });
        // Labels toggle: update visibility only — no scene rebuild needed
        this._configPanel.querySelectorAll('input[name="labels"]').forEach(radio => {
            radio.addEventListener('change', e => {
                this._scene.setLabelMode(e.target.value);
                this._saveSettings();
            });
        });
        this._configPanel.addEventListener('change', e => {
            // Skip labels — handled above without a rebuild
            if (e.target.name === 'labels') return;
            this._rebuildScene();
            this._saveSettings();
        });

        // Theme
        document.getElementById('btn-theme-toggle').addEventListener('click', () => this._toggleTheme());

        // Layout panel open
        document.getElementById('btn-layout').addEventListener('click', () => this._openLayoutPanel());
        document.getElementById('btn-layout-close').addEventListener('click', () => this._closeLayoutPanel());
        document.getElementById('btn-layout-apply').addEventListener('click', () => this._applyLayout());
        document.getElementById('btn-layout-save').addEventListener('click', () => this._saveLayout());

        // Floor config inputs: re-render canvas on change
        ['cfg-floor-w', 'cfg-floor-d', 'cfg-grid-snap', 'cfg-floor-unit', 'cfg-snap-on', 'cfg-rack-depth'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', () => this._syncCanvasConfig());
        });

        // Properties panel
        const propX = document.getElementById('prop-x');
        const propZ = document.getElementById('prop-z');
        const propOrient = document.getElementById('prop-orient');

        const onPropChange = () => {
            if (!this._canvas) return;
            this._canvas.updateSelected(propX.value, propZ.value, propOrient.value);
        };
        propX?.addEventListener('change', onPropChange);
        propZ?.addEventListener('change', onPropChange);
        propOrient?.addEventListener('change', onPropChange);

        document.getElementById('btn-prop-remove')?.addEventListener('click', () => {
            if (this._canvas?._selectedId) {
                this._canvas.removeRack(this._canvas._selectedId);
                this._updateUnplacedList();
            }
        });

        // Context menu
        document.getElementById('r3d-ctx-menu').addEventListener('click', e => {
            const item = e.target.closest('.r3d-ctx-item');
            if (!item) return;
            const action = item.dataset.action;
            const id = this._canvas?._ctxMenuRackId;
            if (id) {
                if (action === 'rotateCW') this._canvas.rotateRack(id, 1);
                if (action === 'rotateCCW') this._canvas.rotateRack(id, -1);
                if (action === 'remove') { this._canvas.removeRack(id); this._updateUnplacedList(); }
            }
            document.getElementById('r3d-ctx-menu').classList.add('r3d-ctx-hidden');
        });

        // Dismiss context menu on any click outside
        document.addEventListener('click', () => {
            document.getElementById('r3d-ctx-menu').classList.add('r3d-ctx-hidden');
        });

        // Device picking in 3D viewport
        document.getElementById('btn-info-close').addEventListener('click', () => this._hideInfo());
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

            // Auto-load floor plan for the first site if present
            const firstSite = (data.sites || [])[0];
            if (firstSite) {
                this._siteSel.value = firstSite.id;
                this._updateRackDropdown();
                await this._autoLoadFloorPlan(firstSite.id);
            }
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

    // ── Server layout persistence ─────────────────────────────────────────────

    async _autoLoadFloorPlan(siteId) {
        try {
            const res = await fetch(`/api/plugins/innovace-fibre/floor-plan/?site_id=${siteId}`);
            if (!res.ok) return;
            const data = await res.json();
            const cfg = data.config || {};
            if (!cfg.racks || !cfg.racks.length) return;

            // Populate floor config inputs
            if (cfg.floor) {
                if (cfg.floor.width) document.getElementById('cfg-floor-w').value = cfg.floor.width;
                if (cfg.floor.depth) document.getElementById('cfg-floor-d').value = cfg.floor.depth;
                if (cfg.floor.gridSnap) document.getElementById('cfg-grid-snap').value = cfg.floor.gridSnap;
                if (cfg.floor.unit) document.getElementById('cfg-floor-unit').value = cfg.floor.unit;
            }
            if (cfg.railFL != null) document.getElementById('cfg-rail-fl').value = cfg.railFL;
            if (cfg.railFR != null) document.getElementById('cfg-rail-fr').value = cfg.railFR;
            if (cfg.railRL != null) document.getElementById('cfg-rail-rl').value = cfg.railRL;
            if (cfg.railRR != null) document.getElementById('cfg-rail-rr').value = cfg.railRR;

            // Fetch rack data and render 3D
            const rackIds = cfg.racks.map(r => r.rackId);
            this._showLoading(true);
            await this._fetchMissingRacks(rackIds);
            this._showLoading(false);
            this._layoutMode = true;
            this._currentData = null;
            this._scene.loadLayout(cfg.racks, this._loadedRacks, {
                ...this._settings(),
                floorWidth: cfg.floor?.width || 400,
                floorDepth: cfg.floor?.depth || 300,
            });
        } catch (e) { console.error('Auto-load floor plan failed:', e); }
    }

    async _saveLayout() {
        const siteId = this._siteSel.value;
        if (!siteId) {
            this._showToast('Select a site first');
            return;
        }
        if (!this._canvas) return;

        const floor = {
            width: parseFloat(document.getElementById('cfg-floor-w').value) || 400,
            depth: parseFloat(document.getElementById('cfg-floor-d').value) || 300,
            gridSnap: parseFloat(document.getElementById('cfg-grid-snap').value) || 12,
            unit: document.getElementById('cfg-floor-unit').value || 'in',
        };

        const config = {
            floor,
            racks: this._canvas.getPlacements(),
            railFL: parseFloat(document.getElementById('cfg-rail-fl').value) || 2,
            railFR: parseFloat(document.getElementById('cfg-rail-fr').value) || 2,
            railRL: parseFloat(document.getElementById('cfg-rail-rl').value) || 2,
            railRR: parseFloat(document.getElementById('cfg-rail-rr').value) || 2,
        };

        this._saveStatus.textContent = 'Saving…';
        try {
            const res = await fetch('/api/plugins/innovace-fibre/floor-plan/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCsrfToken(),
                },
                body: JSON.stringify({ site_id: parseInt(siteId, 10), config }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this._saveStatus.textContent = '';
            this._showToast('Layout saved ✓');
        } catch (e) {
            this._saveStatus.textContent = 'Save failed';
            console.error('Save layout failed:', e);
        }
    }

    // ── Layout panel ──────────────────────────────────────────────────────────

    _openLayoutPanel() {
        this._layoutPanel.classList.remove('r3d-layout-hidden');

        if (!this._canvas) {
            const canvasEl = document.getElementById('r3d-floor-canvas');
            this._canvas = new FloorCanvas(canvasEl, sel => this._onCanvasSelection(sel));
            this._canvas.setRacks(this._allRacks);
        }

        this._syncCanvasConfig();

        // Load current server placements if canvas is empty
        const siteId = this._siteSel.value;
        if (siteId && this._canvas.getPlacements().length === 0) {
            this._loadCanvasFromServer(siteId);
        }

        this._updateUnplacedList();
    }

    _closeLayoutPanel() {
        this._layoutPanel.classList.add('r3d-layout-hidden');
    }

    async _applyLayout() {
        if (!this._canvas) return;
        const placements = this._canvas.getPlacements();
        if (!placements.length) { this._closeLayoutPanel(); return; }

        this._closeLayoutPanel();
        this._showLoading(true);
        this._layoutMode = true;
        this._currentData = null;

        const rackIds = placements.map(p => p.rackId);
        await this._fetchMissingRacks(rackIds);
        this._showLoading(false);

        const floor = {
            width: parseFloat(document.getElementById('cfg-floor-w').value) || 400,
            depth: parseFloat(document.getElementById('cfg-floor-d').value) || 300,
        };
        this._scene.loadLayout(placements, this._loadedRacks, {
            ...this._settings(),
            floorWidth: floor.width,
            floorDepth: floor.depth,
        });
    }

    async _loadCanvasFromServer(siteId) {
        try {
            const res = await fetch(`/api/plugins/innovace-fibre/floor-plan/?site_id=${siteId}`);
            if (!res.ok) return;
            const data = await res.json();
            const cfg = data.config || {};
            if (cfg.floor) {
                if (cfg.floor.width) document.getElementById('cfg-floor-w').value = cfg.floor.width;
                if (cfg.floor.depth) document.getElementById('cfg-floor-d').value = cfg.floor.depth;
                if (cfg.floor.gridSnap) document.getElementById('cfg-grid-snap').value = cfg.floor.gridSnap;
                if (cfg.floor.unit) document.getElementById('cfg-floor-unit').value = cfg.floor.unit;
                this._syncCanvasConfig();
            }
            if (cfg.racks?.length) {
                this._canvas.setPlacements(cfg.racks);
                this._updateUnplacedList();
            }
        } catch (e) { console.error('Load canvas from server failed:', e); }
    }

    _syncCanvasConfig() {
        if (!this._canvas) return;
        this._canvas.setConfig({
            width: parseFloat(document.getElementById('cfg-floor-w').value) || 400,
            depth: parseFloat(document.getElementById('cfg-floor-d').value) || 300,
            gridSnap: parseFloat(document.getElementById('cfg-grid-snap').value) || 12,
            snapEnabled: document.getElementById('cfg-snap-on').checked,
            rackDepth: parseFloat(document.getElementById('cfg-rack-depth').value) || 40,
            unit: document.getElementById('cfg-floor-unit').value || 'in',
        });
    }

    _updateUnplacedList() {
        const wrap = document.getElementById('r3d-unplaced-wrap');
        if (!wrap || !this._canvas) return;
        wrap.innerHTML = '';
        const siteId = this._siteSel.value;
        const racks = siteId ? this._allRacks.filter(r => String(r.site_id) === siteId) : this._allRacks;
        for (const rack of racks) {
            const chip = document.createElement('div');
            chip.className = 'r3d-unplaced-rack';
            chip.draggable = true;
            chip.textContent = rack.name;
            chip.title = rack.site ? `${rack.site} / ${rack.name}` : rack.name;
            if (this._canvas.isPlaced(rack.id)) {
                chip.style.opacity = '0.4';
                chip.draggable = false;
            }
            chip.addEventListener('dragstart', e => {
                e.dataTransfer.setData('text/plain', String(rack.id));
                e.dataTransfer.effectAllowed = 'copy';
                chip.classList.add('dragging');
            });
            chip.addEventListener('dragend', () => {
                chip.classList.remove('dragging');
                this._updateUnplacedList();
            });
            wrap.appendChild(chip);
        }
    }

    _onCanvasSelection(sel) {
        const propName = document.getElementById('prop-rack-name');
        const propX = document.getElementById('prop-x');
        const propZ = document.getElementById('prop-z');
        const propOrient = document.getElementById('prop-orient');
        const propsPanel = document.getElementById('r3d-rack-props');

        if (!sel) {
            propsPanel?.classList.add('r3d-props-hidden');
            return;
        }

        propsPanel?.classList.remove('r3d-props-hidden');
        if (propName) propName.textContent = sel.rack?.name || `Rack ${sel.rackId}`;
        if (propX) propX.value = sel.x;
        if (propZ) propZ.value = sel.z;
        if (propOrient) propOrient.value = sel.orientation;
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
        // Re-render canvas if open
        this._canvas?.render();
    }

    _updateThemeBtn() {
        const theme = this._root.getAttribute('data-theme') || 'dark';
        this._themeBtn.textContent = theme === 'dark' ? '☀' : '☾';
        this._themeBtn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    }

    // ── Scene rebuild ─────────────────────────────────────────────────────────

    _rebuildScene() {
        if (this._layoutMode && this._canvas) {
            const placements = this._canvas.getPlacements();
            if (placements.length) {
                const floor = {
                    width: parseFloat(document.getElementById('cfg-floor-w').value) || 400,
                    depth: parseFloat(document.getElementById('cfg-floor-d').value) || 300,
                };
                this._scene.loadLayout(placements, this._loadedRacks, {
                    ...this._settings(),
                    floorWidth: floor.width,
                    floorDepth: floor.depth,
                });
            }
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

    _showToast(msg) {
        const t = document.getElementById('r3d-save-toast');
        if (!t) return;
        t.textContent = msg;
        t.classList.add('visible');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => t.classList.remove('visible'), 2500);
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => new AppController());
