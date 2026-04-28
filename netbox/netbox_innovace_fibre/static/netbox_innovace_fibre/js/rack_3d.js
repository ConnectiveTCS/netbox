import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ── Constants ────────────────────────────────────────────────────────────────

const U_SCALE_BASE = 1.75;       // world units per 1U (≈ 44.45 mm)
const RACK_WIDTH   = 19.0;       // standard 19-inch rail width in world units
const POST_SIZE    = 0.5;        // corner post cross-section
const RAIL_HEIGHT  = 0.25;       // top/bottom rail thickness
const BLANK_DEPTH  = 0.5;        // blank panel protrusion
const BLANK_COLOUR = 0x1e2330;

const DEPTH_MAP = { realistic: 28.0, flat: 4.0, schematic: 1.2 };

const LABEL_SHOW_DIST = 60;      // camera distance below which labels appear

// FNV-1a 32-bit hash → THREE-compatible 0xRRGGBB integer
function hashColor(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    // Map to a mid-saturation palette so colours are legible against dark BG
    const r = 80 + ((h & 0xFF0000) >> 16) % 140;
    const g = 80 + ((h & 0x00FF00) >>  8) % 140;
    const b = 80 + ((h & 0x0000FF)      ) % 140;
    return (r << 16) | (g << 8) | b;
}

function roleColorInt(hex) {
    return parseInt(hex, 16) || 0x555555;
}

// ── RackScene ────────────────────────────────────────────────────────────────

class RackScene {
    constructor(container) {
        this._container = container;
        this._meshes    = [];   // THREE.Mesh objects (for raycasting + disposal)
        this._labels    = [];   // CSS2DObject instances
        this._textures  = [];   // THREE.Texture instances (for disposal)
        this._animId    = null;
        this._settings  = null;
        this._rackData  = null;

        // Renderer
        this._renderer = new THREE.WebGLRenderer({ antialias: true });
        this._renderer.setPixelRatio(window.devicePixelRatio);
        this._renderer.shadowMap.enabled = false;
        container.appendChild(this._renderer.domElement);

        // CSS2D overlay for labels
        this._css2d = new CSS2DRenderer();
        this._css2d.domElement.classList.add('css2d-renderer');
        container.appendChild(this._css2d.domElement);

        // Scene
        this._scene = new THREE.Scene();
        this._scene.background = new THREE.Color(0x0A0C10);

        // Camera
        const { width, height } = container.getBoundingClientRect();
        this._camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);

        // Lighting
        this._scene.add(new THREE.AmbientLight(0xffffff, 0.45));
        const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
        dirLight.position.set(15, 25, 20);
        this._scene.add(dirLight);
        const fillLight = new THREE.DirectionalLight(0x8899bb, 0.3);
        fillLight.position.set(-10, 5, -15);
        this._scene.add(fillLight);

        // Controls
        this._controls = new OrbitControls(this._camera, this._renderer.domElement);
        this._controls.enableDamping  = true;
        this._controls.dampingFactor  = 0.06;
        this._controls.minDistance    = 2;
        this._controls.maxDistance    = 400;

        // Raycaster for device picking
        this._raycaster = new THREE.Raycaster();
        this._mouse     = new THREE.Vector2();

        // Resize
        this._resizeObserver = new ResizeObserver(() => this._onResize());
        this._resizeObserver.observe(container);
        this._onResize();

        this._animate();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    load(rackData, settings) {
        this._rackData = rackData;
        this._settings = settings;
        this._clear();
        this._buildRackFrame(rackData.rack, settings);
        this._buildDevices(rackData.devices, rackData.rack, settings);
        if (settings.showEmpty) this._buildEmptySlots(rackData, settings);
        this.resetCamera(rackData.rack, settings);
    }

    resetCamera(rack, settings) {
        const sc    = parseFloat(settings.scale) || 1;
        const totalH = rack.u_height * U_SCALE_BASE * sc;
        const depth  = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
        const target = new THREE.Vector3(0, totalH * 0.5, 0);
        const dist   = Math.max(totalH, RACK_WIDTH) * 1.6 + depth;
        this._camera.position.set(RACK_WIDTH * 0.8, totalH * 0.55, dist);
        this._camera.lookAt(target);
        this._controls.target.copy(target);
        this._controls.update();
    }

    fitView() {
        if (!this._rackData) return;
        const box = new THREE.Box3().setFromObject(this._scene);
        if (box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const size   = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov    = this._camera.fov * (Math.PI / 180);
        const dist   = maxDim / (2 * Math.tan(fov / 2)) * 1.3;
        this._controls.target.copy(center);
        this._camera.position.set(center.x + dist * 0.4, center.y, center.z + dist);
        this._camera.lookAt(center);
        this._controls.update();
    }

    pickDevice(event) {
        const rect = this._container.getBoundingClientRect();
        this._mouse.x =  ((event.clientX - rect.left)  / rect.width)  * 2 - 1;
        this._mouse.y = -((event.clientY - rect.top)   / rect.height) * 2 + 1;
        this._raycaster.setFromCamera(this._mouse, this._camera);
        const targets = this._meshes.filter(m => m.userData.deviceId);
        const hits    = this._raycaster.intersectObjects(targets, false);
        return hits.length ? hits[0].object.userData.deviceData : null;
    }

    updateLabels(settings) {
        const mode = settings.labels;
        if (mode === 'on')  { this._labels.forEach(l => { l.element.style.display = ''; }); return; }
        if (mode === 'off') { this._labels.forEach(l => { l.element.style.display = 'none'; }); return; }
        // auto
        this._updateLabelVisibility();
    }

    dispose() {
        cancelAnimationFrame(this._animId);
        this._resizeObserver.disconnect();
        this._clear();
        this._renderer.dispose();
    }

    // ── Private: scene building ───────────────────────────────────────────────

    _buildRackFrame(rack, settings) {
        const sc     = parseFloat(settings.scale) || 1;
        const totalH = rack.u_height * U_SCALE_BASE * sc;
        const depth  = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
        const mat    = new THREE.MeshStandardMaterial({ color: 0x2a2e3a, metalness: 0.75, roughness: 0.35 });

        // 4 corner posts
        const postGeo = new THREE.BoxGeometry(POST_SIZE, totalH, POST_SIZE);
        const hw = RACK_WIDTH / 2 + POST_SIZE / 2;
        const hd = depth       / 2 + POST_SIZE / 2;
        for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            const m = new THREE.Mesh(postGeo, mat);
            m.position.set(sx * hw, totalH / 2, sz * hd);
            this._scene.add(m);
            this._meshes.push(m);
        }

        // Top + bottom rails
        const railGeo = new THREE.BoxGeometry(RACK_WIDTH + POST_SIZE * 2 + 0.1, RAIL_HEIGHT, depth + POST_SIZE * 2 + 0.1);
        for (const y of [0, totalH]) {
            const m = new THREE.Mesh(railGeo, mat);
            m.position.set(0, y, 0);
            this._scene.add(m);
            this._meshes.push(m);
        }

        // Translucent side panels
        const sideMat = new THREE.MeshStandardMaterial({
            color: 0x3a4a5a, transparent: true, opacity: 0.07, side: THREE.DoubleSide,
        });
        const sideGeo = new THREE.PlaneGeometry(depth, totalH);
        for (const sx of [-1, 1]) {
            const m = new THREE.Mesh(sideGeo, sideMat);
            m.rotation.y = Math.PI / 2;
            m.position.set(sx * (RACK_WIDTH / 2 + POST_SIZE), totalH / 2, 0);
            this._scene.add(m);
            this._meshes.push(m);
        }
    }

    _buildDevices(devices, rack, settings) {
        const sc    = parseFloat(settings.scale) || 1;
        const depth = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
        const face  = settings.face || 'both';
        const loader = new THREE.TextureLoader();

        const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1e26, metalness: 0.65, roughness: 0.45 });

        for (const dev of devices) {
            // Face filter
            if (face === 'front' && dev.face === 'rear' && !dev.is_full_depth) continue;
            if (face === 'rear'  && dev.face === 'front' && !dev.is_full_depth) continue;

            const deviceH = dev.u_height * U_SCALE_BASE * sc;
            const yBottom = this._calcY(dev, rack, sc);

            // Depth: non-full-depth devices are shallower
            const deviceDepth = dev.is_full_depth ? depth : depth * 0.55;

            const geo = new THREE.BoxGeometry(RACK_WIDTH - POST_SIZE * 2, deviceH, deviceDepth);

            // Build 6-material array: [+X, -X, +Y, -Y, +Z(front), -Z(rear)]
            const sideFacesMat = darkMat;
            const materials = [
                sideFacesMat, sideFacesMat,   // left/right
                sideFacesMat, sideFacesMat,   // top/bottom
                this._makeFaceMat(dev, 'front', loader, settings),
                this._makeFaceMat(dev, 'rear',  loader, settings),
            ];

            const mesh = new THREE.Mesh(geo, materials);
            mesh.position.set(0, yBottom + deviceH / 2, 0);
            mesh.userData = { deviceId: dev.id, deviceData: dev };
            this._scene.add(mesh);
            this._meshes.push(mesh);

            // CSS2D label
            const div = document.createElement('div');
            div.className = 'r3d-device-label';
            div.textContent = dev.name;
            const label = new CSS2DObject(div);
            label.position.set(0, 0, deviceDepth / 2 + 0.1);
            label.userData.isLabel = true;
            mesh.add(label);
            this._labels.push(label);
        }

        this.updateLabels(settings);
    }

    _makeFaceMat(dev, side, loader, settings) {
        const imageUrl = side === 'front' ? dev.front_image : dev.rear_image;

        if (settings.colorBy === 'image' && imageUrl) {
            const tex = loader.load(imageUrl);
            tex.colorSpace = THREE.SRGBColorSpace;
            this._textures.push(tex);
            return new THREE.MeshBasicMaterial({ map: tex });
        }

        // Colour fallback
        let color;
        if (settings.colorBy === 'role' && dev.role_color) {
            color = roleColorInt(dev.role_color);
        } else {
            color = hashColor(dev.manufacturer || dev.device_type || String(dev.id));
        }
        return new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.6 });
    }

    _buildEmptySlots(rackData, settings) {
        const { rack, devices } = rackData;
        const sc = parseFloat(settings.scale) || 1;

        // Build occupied set in 0.5U steps
        const occupied = new Set();
        for (const dev of devices) {
            let u = dev.position;
            while (u < dev.position + dev.u_height) {
                occupied.add(Math.round(u * 2));  // store as integers (×2)
                u += 0.5;
            }
        }

        const mat  = new THREE.MeshStandardMaterial({ color: BLANK_COLOUR, metalness: 0.25, roughness: 0.75 });
        const slotH = U_SCALE_BASE * sc;

        for (let u = rack.starting_unit; u < rack.starting_unit + rack.u_height; u++) {
            if (occupied.has(u * 2)) continue;
            const geo  = new THREE.BoxGeometry(RACK_WIDTH - POST_SIZE * 2 - 0.05, slotH - 0.08, BLANK_DEPTH);
            const mesh = new THREE.Mesh(geo, mat);
            const yBottom = this._calcYFromUnit(u, rack, sc);
            mesh.position.set(0, yBottom + slotH / 2, 0);
            this._scene.add(mesh);
            this._meshes.push(mesh);
        }
    }

    _calcY(dev, rack, sc) {
        return this._calcYFromUnit(dev.position, rack, sc);
    }

    _calcYFromUnit(unit, rack, sc) {
        if (rack.desc_units) {
            // U1 at top → invert
            return (rack.u_height - (unit - rack.starting_unit) - 1) * U_SCALE_BASE * sc;
        }
        // Standard: U1 at bottom
        return (unit - rack.starting_unit) * U_SCALE_BASE * sc;
    }

    // ── Private: disposal & utilities ────────────────────────────────────────

    _clear() {
        for (const mesh of this._meshes) {
            this._scene.remove(mesh);
            mesh.geometry.dispose();
            if (Array.isArray(mesh.material)) {
                mesh.material.forEach(m => m.dispose());
            } else {
                mesh.material.dispose();
            }
        }
        for (const tex of this._textures) tex.dispose();
        this._meshes  = [];
        this._labels  = [];
        this._textures = [];
    }

    _animate() {
        this._animId = requestAnimationFrame(() => this._animate());
        this._controls.update();
        if (this._settings?.labels === 'auto') this._updateLabelVisibility();
        this._renderer.render(this._scene, this._camera);
        this._css2d.render(this._scene, this._camera);
    }

    _updateLabelVisibility() {
        const dist = this._camera.position.distanceTo(this._controls.target);
        const show = dist < LABEL_SHOW_DIST;
        for (const l of this._labels) {
            l.element.style.display = show ? '' : 'none';
        }
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

// ── AppController ─────────────────────────────────────────────────────────────

class AppController {
    constructor() {
        // DOM refs
        this._viewport     = document.getElementById('r3d-viewport');
        this._loading      = document.getElementById('r3d-loading');
        this._empty        = document.getElementById('r3d-empty');
        this._siteSel      = document.getElementById('filter-site');
        this._rackSel      = document.getElementById('filter-rack');
        this._configPanel  = document.getElementById('r3d-config');
        this._infoPanel    = document.getElementById('r3d-info');
        this._infoTitle    = document.getElementById('r3d-info-title');
        this._infoBody     = document.getElementById('r3d-info-body');

        this._allRacks  = [];   // all racks from initial API load
        this._loadId    = 0;    // race-condition guard
        this._currentData = null;

        this._scene = new RackScene(this._viewport);

        this._wireEvents();
        this._loadSitesAndRacks();
    }

    // ── Initialisation ────────────────────────────────────────────────────────

    _wireEvents() {
        // Toolbar
        this._siteSel.addEventListener('change', () => this._onSiteChange());
        this._rackSel.addEventListener('change', () => this._onRackChange());

        document.querySelectorAll('.r3d-face-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.r3d-face-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (this._currentData) this._rebuildScene();
            });
        });

        document.getElementById('btn-reset-cam').addEventListener('click', () => {
            if (this._currentData) this._scene.resetCamera(this._currentData.rack, this._settings());
        });
        document.getElementById('btn-fit-rack').addEventListener('click', () => {
            this._scene.fitView();
        });
        document.getElementById('btn-config-toggle').addEventListener('click', () => {
            this._configPanel.classList.toggle('r3d-config-hidden');
        });
        document.getElementById('btn-config-close').addEventListener('click', () => {
            this._configPanel.classList.add('r3d-config-hidden');
        });

        // Config panel changes
        this._configPanel.addEventListener('change', () => {
            if (this._currentData) this._rebuildScene();
        });

        // Info panel close
        document.getElementById('btn-info-close').addEventListener('click', () => {
            this._hideInfo();
        });

        // Device picking on click
        this._viewport.addEventListener('click', e => {
            const dev = this._scene.pickDevice(e);
            if (dev) this._showInfo(dev);
            else     this._hideInfo();
        });
    }

    async _loadSitesAndRacks() {
        try {
            const res  = await fetch('/api/plugins/innovace-fibre/racks/');
            const data = await res.json();
            this._allRacks = data.racks || [];

            // Populate site dropdown
            for (const site of data.sites || []) {
                const opt = document.createElement('option');
                opt.value = site.id;
                opt.textContent = site.name;
                this._siteSel.appendChild(opt);
            }

            this._updateRackDropdown();
        } catch (e) {
            console.error('Failed to load rack list:', e);
        }
    }

    _updateRackDropdown() {
        const siteId = this._siteSel.value;
        const racks  = siteId
            ? this._allRacks.filter(r => String(r.site_id) === siteId)
            : this._allRacks;

        this._rackSel.innerHTML = '<option value="">Select rack…</option>';
        for (const rack of racks) {
            const opt = document.createElement('option');
            opt.value = rack.id;
            opt.textContent = rack.site ? `${rack.site} / ${rack.name}` : rack.name;
            this._rackSel.appendChild(opt);
        }
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    _onSiteChange() {
        this._updateRackDropdown();
    }

    _onRackChange() {
        const rackId = this._rackSel.value;
        if (rackId) this._loadRack(rackId);
    }

    async _loadRack(rackId) {
        const id = ++this._loadId;
        this._showLoading(true);
        this._hideInfo();

        try {
            const res  = await fetch(`/api/plugins/innovace-fibre/racks/${rackId}/3d-data/`);
            if (id !== this._loadId) return; // stale response
            const data = await res.json();
            this._currentData = data;
            this._scene.load(data, this._settings());
            this._showLoading(false);
        } catch (e) {
            console.error('Failed to load rack 3D data:', e);
            this._showLoading(false);
        }
    }

    _rebuildScene() {
        if (this._currentData) this._scene.load(this._currentData, this._settings());
    }

    // ── Settings snapshot ─────────────────────────────────────────────────────

    _settings() {
        return {
            scale:    document.querySelector('input[name="scale"]:checked')?.value    || '1',
            depth:    document.querySelector('input[name="depth"]:checked')?.value    || 'realistic',
            labels:   document.querySelector('input[name="labels"]:checked')?.value   || 'auto',
            colorBy:  document.querySelector('input[name="colorby"]:checked')?.value  || 'image',
            showEmpty: document.querySelector('input[name="empty"]:checked')?.value   === 'yes',
            face:     document.querySelector('.r3d-face-btn.active')?.dataset.face    || 'both',
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

    _hideInfo() {
        this._infoPanel.classList.add('r3d-info-hidden');
    }

    // ── Loading state ─────────────────────────────────────────────────────────

    _showLoading(on) {
        this._loading.style.display = on ? 'flex' : 'none';
        this._empty.style.display   = on || this._currentData ? 'none' : '';
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => new AppController());
