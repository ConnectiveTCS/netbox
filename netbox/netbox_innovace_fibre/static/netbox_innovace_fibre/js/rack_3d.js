import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/addons/renderers/CSS2DRenderer.js";
import { BarcodeScanner, showSignalModal } from "./barcode_scanner.js";

// ── Constants ────────────────────────────────────────────────────────────────

const U_SCALE_BASE = 1.75;
const RACK_WIDTH = 19.0;
const POST_W = 0.5;
const RAIL_H = 0.25;
const BLANK_DEPTH = 0.5;
const LABEL_SHOW_DIST = 60;
const LS_SETTINGS = "iff_rack3d_settings";
const SS_SESSION_VIEW = "iff_rack3d_session_view";

const DEPTH_MAP = { realistic: 28.0, flat: 4.0, schematic: 1.2 };
const FRONT_DEVICE_CLEARANCE = 3.5;
const REAR_DEVICE_CLEARANCE = 2.5;
// Side cable-routing channels added to each rack, converted from mm to scene-inches.
const CABLE_CHANNEL_W = 90 / 25.4;

// Cable rendering
const CABLE_PATCH_RADIUS = 0.18; // scene-inches — intra-rack patch/fibre
const CABLE_TRUNK_RADIUS = 0.28; // scene-inches — inter-rack trunk
const CABLE_TRUNK_MAX_RADIUS = 0.9;
const CABLE_TUBE_SEGS = 8; // radial segments on TubeGeometry
const CABLE_PATH_SEGS = 20; // curve sample points
const CABLE_OVERHEAD_H = 6.0; // scene-inches above rack top for inter-rack overhead run
const CABLE_DEFAULT_COLOR = 0x607080;

const FIBRE_CABLE_TYPES = new Set([
  "smf",
  "smf-os1",
  "smf-os2",
  "mmf",
  "mmf-om1",
  "mmf-om2",
  "mmf-om3",
  "mmf-om4",
  "mmf-om5",
  "aoc",
]);
const NETWORK_CABLE_TYPES = new Set([
  "cat3",
  "cat5",
  "cat5e",
  "cat6",
  "cat6a",
  "cat7",
  "cat7a",
  "cat8",
  "dac-active",
  "dac-passive",
  "coaxial",
]);

function hashColor(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const r = 80 + (((h & 0xff0000) >> 16) % 140);
  const g = 80 + (((h & 0x00ff00) >> 8) % 140);
  const b = 80 + ((h & 0x0000ff) % 140);
  return (r << 16) | (g << 8) | b;
}

function roleColorInt(hex) {
  return parseInt(hex, 16) || 0x555555;
}

function themeColors(theme) {
  return theme === "light"
    ? {
        sceneBg: 0xf2f4f8, // near-white background
        floor: 0xc2c8d4, // tile surface
        floorLine: 0x909aaa, // grout lines
        post: 0x1c1c24, // near-black steel frame
        blank: 0x282832, // blank panel fill
        rail: 0x8a9aaa, // silver/aluminium mounting rails
        deviceDark: 0x0e1014, // equipment face (very dark)
        rackBody: 0x1a1a1e, // matte black cabinet body
      }
    : {
        sceneBg: 0x0a0c10,
        floor: 0x0c0f14,
        floorLine: 0x131820,
        post: 0x1e1e28, // near-black steel frame
        blank: 0x1a1a22, // blank panel fill
        rail: 0x5a6878, // silver/aluminium mounting rails
        deviceDark: 0x1a1e26,
        rackBody: 0x111118, // matte black cabinet body
      };
}

function orientToRad(o) {
  return { N: 0, E: Math.PI / 2, S: Math.PI, W: -Math.PI / 2 }[o] || 0;
}

function deviceClearanceForDepth(depth, side) {
  if (depth >= 10) {
    return side === "front" ? FRONT_DEVICE_CLEARANCE : REAR_DEVICE_CLEARANCE;
  }
  return depth * 0.08;
}

function deviceEnvelopeDepth(depth) {
  const front = deviceClearanceForDepth(depth, "front");
  const rear = deviceClearanceForDepth(depth, "rear");
  return Math.max(depth - front - rear, depth * 0.5);
}

function getCsrfToken() {
  if (window.CSRF_TOKEN) return window.CSRF_TOKEN;
  const match = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith("csrftoken="));
  return match ? match.trim().split("=")[1] : "";
}

// ── RackScene ────────────────────────────────────────────────────────────────

class RackScene {
  constructor(container) {
    this._container = container;
    this._meshes = [];
    this._labels = [];
    this._textures = [];
    this._animId = null;
    this._settings = { theme: "light", labels: "auto" };
    this._deviceMeshes = []; // only device meshes — for hover/selection/filter
    this._rackFrameMeshes = []; // rack shell/frame meshes — for hover transparency
    this._hoveredMesh = null;
    this._selectedMesh = null;
    this._hoveredRackId = null; // rackId of the rack currently under the cursor
    this._cameraAnim = null; // { fromPos, toPos, fromTarget, toTarget, t }
    this._onCameraChanged = null;

    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this._renderer.domElement);

    this._css2d = new CSS2DRenderer();
    this._css2d.domElement.classList.add("css2d-renderer");
    const s = this._css2d.domElement.style;
    s.position = "absolute";
    s.top = "0";
    s.left = "0";
    s.width = "100%";
    s.height = "100%";
    s.pointerEvents = "none";
    s.overflow = "hidden";
    container.appendChild(this._css2d.domElement);

    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color(0xf2f4f8);

    const { width, height } = container.getBoundingClientRect();
    this._camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);

    // Ambient: soft fill so shadows aren't pitch black
    this._scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    // Key light: top-front-right to illuminate the green rack faces
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(20, 45, 30);
    this._scene.add(dir);
    // Fill light: left rear to soften shadows
    const fill = new THREE.DirectionalLight(0xd8ecff, 0.5);
    fill.position.set(-20, 8, -25);
    this._scene.add(fill);
    // Top rim light: brightens the top edges of racks
    const rim = new THREE.DirectionalLight(0xffffff, 0.25);
    rim.position.set(0, -8, -12);
    this._scene.add(rim);

    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.12; // snappier response
    this._controls.minDistance = 2;
    this._controls.maxDistance = 600;
    // Left-drag = pan (matches floor-plan / CAD conventions)
    // Right-drag = orbit/spin
    this._controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    // Pan follows the screen axes (mouse left ↔ view left, mouse up ↔ view up)
    this._controls.screenSpacePanning = true;
    this._controls.panSpeed = 2.0; // 1:1 — viewport unit per pixel
    this._controls.rotateSpeed = 0.6; // slightly slower for precision
    this._controls.zoomSpeed = 1.2;
    this._controls.addEventListener("end", () => this._notifyCameraChanged());

    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();

    this._cableManager = new CableManager(this._scene);
    this._cableMeshes = [];
    this._traceAnimator = null;
    this._ctxCableData = null;
    this._clock = new THREE.Clock();

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
    this._buildCables(
      rackData.cables || [],
      rackData.devices,
      rackData.rack,
      settings,
      offset,
    );
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
      group.userData.rackId = p.rackId; // used by hover-transparency system
      group.position.set(p.x - cx, 0, p.z - cz);
      group.rotation.y = orientToRad(p.orientation || "N");
      this._scene.add(group);
      this._meshes.push(group);

      const zero = new THREE.Vector3(0, 0, 0);
      this._buildRackFrame(rd.rack, settings, zero, group);
      this._buildDevices(rd.devices, rd.rack, settings, zero, group);
      if (settings.showEmpty) this._buildEmptySlots(rd, settings, zero, group);
      // Rack name label floating above the cabinet
      const rackSc = parseFloat(settings.scale) || 1;
      const rackTop = rd.rack.u_height * U_SCALE_BASE * rackSc + 2.0;
      const nameDiv = document.createElement("div");
      nameDiv.className = "r3d-rack-label";
      nameDiv.textContent = rd.rack.name;
      const rackLabel = new CSS2DObject(nameDiv);
      rackLabel.position.set(0, rackTop, 0);
      group.add(rackLabel);
      this._labels.push(rackLabel);
    }

    this._buildCablesForLayout(placements, rackDataMap, settings, cx, cz);

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
    this._notifyCameraChanged();
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
    this._camera.position.set(
      center.x + dist * 0.4,
      center.y + dist * 0.5,
      center.z + dist,
    );
    this._camera.lookAt(center);
    this._controls.update();
    this._notifyCameraChanged();
  }

  getCameraState() {
    return {
      position: {
        x: this._camera.position.x,
        y: this._camera.position.y,
        z: this._camera.position.z,
      },
      target: {
        x: this._controls.target.x,
        y: this._controls.target.y,
        z: this._controls.target.z,
      },
    };
  }

  setCameraState(state) {
    const pos = state?.position;
    const target = state?.target;
    if (!pos || !target) return false;
    const vals = [pos.x, pos.y, pos.z, target.x, target.y, target.z];
    if (!vals.every((v) => Number.isFinite(v))) return false;

    this._camera.position.set(pos.x, pos.y, pos.z);
    this._controls.target.set(target.x, target.y, target.z);
    this._camera.lookAt(this._controls.target);
    this._controls.update();
    this._notifyCameraChanged();
    return true;
  }

  onCameraChanged(handler) {
    this._onCameraChanged = typeof handler === "function" ? handler : null;
  }

  pickDevice(event) {
    const rect = this._container.getBoundingClientRect();
    this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this._camera);
    const hits = this._raycaster
      .intersectObjects(this._scene.children, true)
      .filter((h) => h.object.userData.deviceId);
    return hits.length ? hits[0].object.userData.deviceData : null;
  }

  dispose() {
    cancelAnimationFrame(this._animId);
    this._resizeObserver.disconnect();
    this._clear();
    this._renderer.dispose();
  }

  _notifyCameraChanged() {
    if (this._onCameraChanged) this._onCameraChanged(this.getCameraState());
  }

  // ── Public: hover / selection / filter ───────────────────────────────────

  hoverDevice(event) {
    const rect = this._container.getBoundingClientRect();
    this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this._camera);
    const allHits = this._raycaster.intersectObjects(
      this._scene.children,
      true,
    );
    const hits = allHits.filter((h) => h.object.userData.deviceId);
    const newMesh = hits.length ? hits[0].object : null;

    // Rack hover: make the shell transparent so devices inside are visible.
    // Use the topmost hit that is either a device or a frame part.
    const rackHit = allHits.find(
      (h) => h.object.userData.deviceId || h.object.userData.isRackFrame,
    );
    const newRackId = rackHit ? this._getRackIdFromHit(rackHit.object) : null;
    if (newRackId !== this._hoveredRackId) {
      if (this._hoveredRackId !== null)
        this._setRackFrameTransparency(this._hoveredRackId, false);
      if (newRackId !== null) this._setRackFrameTransparency(newRackId, true);
      this._hoveredRackId = newRackId;
    }

    if (newMesh === this._hoveredMesh) return;

    // Restore previous hover emissive + label (unless it's the selected device)
    if (this._hoveredMesh && this._hoveredMesh !== this._selectedMesh) {
      this._setEmissive(this._hoveredMesh, 0x000000, 0);
      if (
        this._settings?.labels === "auto" &&
        this._hoveredMesh.userData.label
      ) {
        this._hoveredMesh.userData.label.visible = false;
      }
    }

    if (newMesh) {
      if (newMesh !== this._selectedMesh) {
        this._setEmissive(newMesh, 0x001a33, 0.5);
      }
      if (this._settings?.labels === "auto" && newMesh.userData.label) {
        newMesh.userData.label.visible = true;
      }
      this._container.style.cursor = "pointer";
    } else {
      this._container.style.cursor = "";
    }
    this._hoveredMesh = newMesh;

    // Cable hover — run against the flat cable mesh list (no recursion needed)
    const cableHits = this._raycaster.intersectObjects(
      this._cableMeshes,
      false,
    );
    const cableMesh = cableHits.length ? cableHits[0].object : null;
    this._cableManager.hoverCable(cableMesh);
    if (cableMesh) {
      this._showCableTooltip(cableMesh.userData.cableData, cableHits[0].point);
      this._container.style.cursor = "pointer";
    } else {
      this._hideCableTooltip();
    }
  }

  _showCableTooltip(cable, worldPoint) {
    if (!this._cableTooltipObj) {
      const div = document.createElement("div");
      div.className = "r3d-cable-tooltip";
      this._cableTooltipObj = new CSS2DObject(div);
      this._scene.add(this._cableTooltipObj);
    }
    const aT = cable.a_terminations?.[0];
    const bT = cable.b_terminations?.[0];
    this._cableTooltipObj.element.innerHTML =
      `<strong>${cable.label || "Cable #" + cable.id}</strong><br>` +
      `${cable.type || "unknown"}<br>` +
      `${aT?.port_name ?? "?"} ↔ ${bT?.port_name ?? "?"}`;
    this._cableTooltipObj.position.copy(worldPoint);
    this._cableTooltipObj.visible = true;
  }

  _hideCableTooltip() {
    if (this._cableTooltipObj) this._cableTooltipObj.visible = false;
  }

  selectDevice(event) {
    const rect = this._container.getBoundingClientRect();
    this._mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this._camera);
    const hits = this._raycaster
      .intersectObjects(this._scene.children, true)
      .filter((h) => h.object.userData.deviceId);
    const mesh = hits.length ? hits[0].object : null;

    if (!mesh) {
      this.clearSelection();
      return null;
    }

    // Toggle: clicking the already-selected device deselects
    if (mesh === this._selectedMesh) {
      this.clearSelection();
      return null;
    }

    if (this._selectedMesh) {
      this._setEmissive(this._selectedMesh, 0x000000, 0);
      if (
        this._settings?.labels !== "on" &&
        this._selectedMesh.userData.label
      ) {
        this._selectedMesh.userData.label.visible = false;
      }
    }
    this._selectedMesh = mesh;
    this._setEmissive(mesh, 0x002244, 0.7);
    this._setIsolation(mesh);
    this._zoomToDevice(mesh);
    if (this._settings?.labels !== "off" && mesh.userData.label) {
      mesh.userData.label.visible = true;
    }
    this._cableManager.dimUnrelated(new Set([mesh.userData.deviceId]));
    return mesh.userData.deviceData;
  }

  clearSelection() {
    if (this._selectedMesh) {
      this._setEmissive(this._selectedMesh, 0x000000, 0);
      if (
        this._settings?.labels !== "on" &&
        this._selectedMesh.userData.label
      ) {
        this._selectedMesh.userData.label.visible = false;
      }
    }
    this._selectedMesh = null;
    this._resetAllDeviceVisuals();
    this._cableManager.resetDim();
    this._cableManager.clearCableSelection();
  }

  filterDevices(query) {
    const q = (query || "").toLowerCase().trim();
    for (const mesh of this._deviceMeshes) {
      const dev = mesh.userData.deviceData;
      const match =
        !q ||
        (dev.name || "").toLowerCase().includes(q) ||
        (dev.role || "").toLowerCase().includes(q) ||
        (dev.device_type || "").toLowerCase().includes(q) ||
        (dev.manufacturer || "").toLowerCase().includes(q);
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      mats.forEach((m) => {
        if (!m) return;
        m.transparent = !match;
        m.opacity = match ? 1 : 0.12;
      });
    }
  }

  // ── Private: visual helpers ───────────────────────────────────────────────

  _setEmissive(mesh, hexColor, intensity) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => {
      if (m?.isMeshStandardMaterial) {
        m.emissive = new THREE.Color(hexColor);
        m.emissiveIntensity = intensity;
      }
    });
  }

  _setIsolation(activeMesh) {
    for (const mesh of this._deviceMeshes) {
      if (mesh === activeMesh) continue;
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      mats.forEach((m) => {
        if (!m) return;
        m.transparent = true;
        m.opacity = 0.18;
      });
    }
  }

  _resetAllDeviceVisuals() {
    for (const mesh of this._deviceMeshes) {
      this._setEmissive(mesh, 0x000000, 0);
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      mats.forEach((m) => {
        if (!m) return;
        m.transparent = false;
        m.opacity = 1;
      });
    }
  }

  // Returns the rackId associated with a hit mesh, either from the mesh itself
  // (frame meshes) or from a parent Group (device meshes in layout mode).
  _getRackIdFromHit(object) {
    if (object.userData.rackId) return object.userData.rackId;
    let obj = object.parent;
    while (obj) {
      if (obj.userData.rackId) return obj.userData.rackId;
      obj = obj.parent;
    }
    return null;
  }

  // Fades or restores the rack frame/shell meshes for a given rack.
  _setRackFrameTransparency(rackId, transparent) {
    const mode = this._settings?.hoverTransparency || "doors";
    for (const mesh of this._rackFrameMeshes) {
      if (mesh.userData.rackId !== rackId) continue;
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      mats.forEach((m) => {
        if (!m) return;
        // Skip the permanently-invisible front-face slot (flagged at build time)
        if (m.userData?.rackInvisible) return;
        const shouldFade =
          transparent && this._shouldFadeRackMaterial(m, mesh, mode);
        m.transparent = shouldFade;
        m.opacity = shouldFade ? 0.15 : 1.0;
      });
    }
  }

  _shouldFadeRackMaterial(material, mesh, mode) {
    const group =
      material.userData?.rackTransparencyGroup ||
      mesh.userData.rackTransparencyGroup ||
      "cabinet";
    if (mode === "full") return true;
    if (mode === "doors") return group === "door-panel";
    if (mode === "channels") return group === "cable-channel";
    if (mode === "doors-channels") {
      return group === "door-panel" || group === "cable-channel";
    }
    return group === "door-panel";
  }

  _zoomToDevice(mesh) {
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 1.6;
    const dir = this._camera.position
      .clone()
      .sub(this._controls.target)
      .normalize();
    const toPos = center.clone().add(dir.multiplyScalar(Math.max(radius, 10)));
    this._cameraAnim = {
      fromPos: this._camera.position.clone(),
      toPos,
      fromTarget: this._controls.target.clone(),
      toTarget: center.clone(),
      t: 0,
    };
  }

  _stepCameraAnim() {
    const a = this._cameraAnim;
    a.t += 0.055; // ~18 frames to reach target
    const done = a.t >= 1;
    const s = done ? 1 : 1 - Math.pow(1 - a.t, 3); // ease-out cubic
    this._camera.position.lerpVectors(a.fromPos, a.toPos, s);
    this._controls.target.lerpVectors(a.fromTarget, a.toTarget, s);
    this._controls.update();
    if (done) this._cameraAnim = null;
  }

  /**
   * Highlight a device by its NetBox id with a green pulse glow.
   * Also dims unrelated cables and zooms the camera to it.
   * Returns the matched mesh or null if not found.
   */
  highlightDeviceById(deviceId) {
    const mesh =
      this._deviceMeshes.find((m) => m.userData.deviceId === deviceId) || null;
    if (!mesh) return null;
    this.clearSelection();
    this._selectedMesh = mesh;
    this._setEmissive(mesh, 0x00ff88, 0.9);
    this._setIsolation(mesh);
    this._cableManager.dimUnrelated(new Set([deviceId]));
    this._zoomToDevice(mesh);
    return mesh;
  }

  /**
   * Pulse-highlight an enclosure device AND flash one of its device-bay slots.
   * bayName is the DeviceBay.name string stored in device_bays[].name.
   */
  highlightEnclosureAndBay(enclosureDeviceId, bayName) {
    const encMesh =
      this._deviceMeshes.find(
        (m) => m.userData.deviceId === enclosureDeviceId,
      ) || null;
    if (!encMesh) return;
    this.clearSelection();
    this._selectedMesh = encMesh;
    this._setEmissive(encMesh, 0x00ff88, 0.9);
    this._setIsolation(encMesh);
    this._zoomToDevice(encMesh);

    // Flash the bay slot mesh (child of encMesh group with matching bayName)
    const bayMesh = this._deviceMeshes.find((m) => {
      const d = m.userData.deviceData;
      return (
        d &&
        d._bayName === bayName &&
        d._parentEnclosureId === enclosureDeviceId
      );
    });
    if (bayMesh) this._pulseEmissive(bayMesh, 0xffdd00, 12);
  }

  /** Animate emissive intensity pulsing N times then reset. */
  _pulseEmissive(mesh, color, pulses) {
    let count = 0;
    const interval = setInterval(() => {
      const intensity = count % 2 === 0 ? 1.2 : 0.1;
      this._setEmissive(mesh, color, intensity);
      count++;
      if (count >= pulses * 2) {
        clearInterval(interval);
        this._setEmissive(mesh, 0x000000, 0);
      }
    }, 180);
  }

  // ── Private: scene building ───────────────────────────────────────────────

  _buildFloor(w, d, settings) {
    const isLight = settings.theme === "light";
    const fw = w + 40;
    const fd = d + 40;

    // Build a canvas texture that looks like raised data-center floor tiles
    // (24" × 24" standard tiles with darker grout lines and edge highlights)
    const tilePx = 128;
    const groutPx = 2;
    const c = document.createElement("canvas");
    c.width = tilePx;
    c.height = tilePx;
    const tc = c.getContext("2d");

    // Grout fill
    tc.fillStyle = isLight ? "#8e98a8" : "#0e1318";
    tc.fillRect(0, 0, tilePx, tilePx);
    // Tile face
    tc.fillStyle = isLight ? "#c0c8d6" : "#0d1219";
    tc.fillRect(groutPx, groutPx, tilePx - groutPx * 2, tilePx - groutPx * 2);
    // Top-left highlight (raised edge)
    tc.fillStyle = isLight ? "#d4dbe7" : "#14191f";
    tc.fillRect(groutPx, groutPx, tilePx - groutPx * 2, 4);
    tc.fillRect(groutPx, groutPx, 4, tilePx - groutPx * 2);
    // Bottom-right shadow
    tc.fillStyle = isLight ? "#a8b2c0" : "#090c10";
    tc.fillRect(groutPx, tilePx - groutPx - 4, tilePx - groutPx * 2, 4);
    tc.fillRect(tilePx - groutPx - 4, groutPx, 4, tilePx - groutPx * 2);

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(fw / 24, fd / 24); // 24" standard tile pitch
    tex.colorSpace = THREE.SRGBColorSpace;
    this._textures.push(tex);

    const floorMat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.85,
      metalness: 0.04,
    });
    const floorGeo = new THREE.PlaneGeometry(fw, fd);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.05, 0);
    this._scene.add(floor);
    this._meshes.push(floor);
  }

  _buildRackFrame(rack, settings, offset, parent) {
    const target = parent || this._scene;
    const sc = parseFloat(settings.scale) || 1;
    const totalH = rack.u_height * U_SCALE_BASE * sc;
    const depth = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
    const colors = themeColors(settings.theme);
    const showDoors = settings.showDoors !== false;
    const outerW = RACK_WIDTH + POST_W * 2; // 20" — standard device-zone width
    // Total shell width expands to include cable routing channels on each side
    const totalW = outerW + 2 * CABLE_CHANNEL_W;

    // ── Materials ────────────────────────────────────────────────────────
    const shellMat = new THREE.MeshStandardMaterial({
      color: colors.rackBody,
      metalness: 0.22,
      roughness: 0.72,
    });
    const rightSidePanelMat = shellMat.clone();
    const leftSidePanelMat = shellMat.clone();
    rightSidePanelMat.userData.rackTransparencyGroup = "door-panel";
    leftSidePanelMat.userData.rackTransparencyGroup = "door-panel";
    const steelMat = new THREE.MeshStandardMaterial({
      color: colors.rail,
      metalness: 0.82,
      roughness: 0.28,
    });
    const bezMat = new THREE.MeshStandardMaterial({
      color: colors.post,
      metalness: 0.55,
      roughness: 0.48,
    });
    const invisMat = new THREE.MeshStandardMaterial({
      transparent: true,
      opacity: 0.0,
    });
    invisMat.userData = { rackInvisible: true }; // sentinel: never affected by hover-transparency

    // ── Outer shell: solid sides/top/bottom, open front/rear for doors ───
    // Face order: [+X(right), -X(left), +Y(top), -Y(bottom), +Z(front), -Z(rear)]
    const shellMats = [
      rightSidePanelMat,
      leftSidePanelMat,
      shellMat,
      shellMat,
      invisMat,
      invisMat,
    ];
    // Helper: tags a mesh as a rack frame component for hover-transparency
    const _regFrame = (m, transparencyGroup = "cabinet") => {
      m.userData.rackId = rack.id;
      m.userData.isRackFrame = true;
      m.userData.rackTransparencyGroup = transparencyGroup;
      if (transparencyGroup === "door-panel" && !showDoors) {
        m.visible = false;
      }
      this._rackFrameMeshes.push(m);
      return m;
    };

    const shellGeo = new THREE.BoxGeometry(totalW, totalH, depth);
    const shell = new THREE.Mesh(shellGeo, shellMats);
    shell.position.set(offset.x, offset.y + totalH / 2, offset.z);
    target.add(_regFrame(shell));
    if (!parent) this._meshes.push(shell);

    // ── Cable management side channels ────────────────────────────────────
    const cableChMat = new THREE.MeshStandardMaterial({
      color: 0x131c28,
      metalness: 0.12,
      roughness: 0.94,
    });
    const chGeo = new THREE.BoxGeometry(
      CABLE_CHANNEL_W - 0.06,
      totalH - 0.06,
      depth - 0.08,
    );
    for (const side of [-1, 1]) {
      const ch = new THREE.Mesh(chGeo, cableChMat);
      ch.position.set(
        offset.x + side * (outerW / 2 + CABLE_CHANNEL_W / 2),
        offset.y + totalH / 2,
        offset.z,
      );
      target.add(_regFrame(ch, "cable-channel"));
      if (!parent) this._meshes.push(ch);
    }
    // Horizontal cable-ring bars every 4U for visual detail
    const cableTieMat = new THREE.MeshStandardMaterial({
      color: 0x2d4060,
      metalness: 0.45,
      roughness: 0.55,
    });
    const tieBarGeo = new THREE.BoxGeometry(
      CABLE_CHANNEL_W * 0.82,
      0.12,
      depth * 0.74,
    );
    for (let gy = offset.y; gy <= offset.y + totalH; gy += U_SCALE_BASE * 4) {
      for (const side of [-1, 1]) {
        const tie = new THREE.Mesh(tieBarGeo, cableTieMat);
        tie.position.set(
          offset.x + side * (outerW / 2 + CABLE_CHANNEL_W / 2),
          gy,
          offset.z,
        );
        tie.raycast = () => {}; // non-pickable
        target.add(_regFrame(tie, "cable-channel"));
        if (!parent) this._meshes.push(tie);
      }
    }

    // ── Internal mounting rails (4 vertical silver steel posts) ──────────
    const railX = RACK_WIDTH / 2 - POST_W / 2;
    const frontZ = offset.z + depth / 2;
    const rearZ = offset.z - depth / 2;
    const rInset = 0.22; // gap from inner shell face
    const rPositions = [
      { x: railX, z: frontZ - POST_W * 0.5 - rInset },
      { x: -railX, z: frontZ - POST_W * 0.5 - rInset },
      { x: railX, z: rearZ + POST_W * 0.5 + rInset },
      { x: -railX, z: rearZ + POST_W * 0.5 + rInset },
    ];
    const vRailGeo = new THREE.BoxGeometry(POST_W, totalH - RAIL_H * 2, POST_W);
    for (const { x, z } of rPositions) {
      const m = new THREE.Mesh(vRailGeo, steelMat);
      m.position.set(offset.x + x, offset.y + totalH / 2, z);
      target.add(_regFrame(m));
      if (!parent) this._meshes.push(m);
    }

    // ── Top and bottom cross-members ──────────────────────────────────────
    const crossGeo = new THREE.BoxGeometry(outerW, RAIL_H, depth * 0.92);
    for (const y of [RAIL_H / 2, totalH - RAIL_H / 2]) {
      const m = new THREE.Mesh(crossGeo, bezMat);
      m.position.set(offset.x, offset.y + y, offset.z);
      target.add(_regFrame(m));
      if (!parent) this._meshes.push(m);
    }

    // ── Front door bezel: 4 bars framing the door opening ────────────────
    const bezD = 0.32; // protrusion depth
    const bezFZ = frontZ + bezD / 2;
    const bezH = 0.6; // top/bottom bar height
    const bezSW = POST_W + 0.12; // side strip width

    const mBTop = new THREE.Mesh(
      new THREE.BoxGeometry(outerW, bezH, bezD),
      bezMat,
    );
    mBTop.position.set(offset.x, offset.y + totalH - bezH / 2, bezFZ);
    target.add(_regFrame(mBTop, "door-panel"));
    if (!parent) this._meshes.push(mBTop);

    const mBBot = new THREE.Mesh(
      new THREE.BoxGeometry(outerW, bezH, bezD),
      bezMat,
    );
    mBBot.position.set(offset.x, offset.y + bezH / 2, bezFZ);
    target.add(_regFrame(mBBot, "door-panel"));
    if (!parent) this._meshes.push(mBBot);

    const mBLeft = new THREE.Mesh(
      new THREE.BoxGeometry(bezSW, totalH, bezD),
      bezMat,
    );
    mBLeft.position.set(
      offset.x - (outerW / 2 - bezSW / 2),
      offset.y + totalH / 2,
      bezFZ,
    );
    target.add(_regFrame(mBLeft, "door-panel"));
    if (!parent) this._meshes.push(mBLeft);

    const mBRight = new THREE.Mesh(
      new THREE.BoxGeometry(bezSW, totalH, bezD),
      bezMat,
    );
    mBRight.position.set(
      offset.x + (outerW / 2 - bezSW / 2),
      offset.y + totalH / 2,
      bezFZ,
    );
    target.add(_regFrame(mBRight, "door-panel"));
    if (!parent) this._meshes.push(mBRight);

    // ── Rear door bezel: matching frame around a rear door opening ────────
    const bezRZ = rearZ - bezD / 2;
    const rBTop = new THREE.Mesh(
      new THREE.BoxGeometry(outerW, bezH, bezD),
      bezMat,
    );
    rBTop.position.set(offset.x, offset.y + totalH - bezH / 2, bezRZ);
    target.add(_regFrame(rBTop, "door-panel"));
    if (!parent) this._meshes.push(rBTop);

    const rBBot = new THREE.Mesh(
      new THREE.BoxGeometry(outerW, bezH, bezD),
      bezMat,
    );
    rBBot.position.set(offset.x, offset.y + bezH / 2, bezRZ);
    target.add(_regFrame(rBBot, "door-panel"));
    if (!parent) this._meshes.push(rBBot);

    const rBLeft = new THREE.Mesh(
      new THREE.BoxGeometry(bezSW, totalH, bezD),
      bezMat,
    );
    rBLeft.position.set(
      offset.x - (outerW / 2 - bezSW / 2),
      offset.y + totalH / 2,
      bezRZ,
    );
    target.add(_regFrame(rBLeft, "door-panel"));
    if (!parent) this._meshes.push(rBLeft);

    const rBRight = new THREE.Mesh(
      new THREE.BoxGeometry(bezSW, totalH, bezD),
      bezMat,
    );
    rBRight.position.set(
      offset.x + (outerW / 2 - bezSW / 2),
      offset.y + totalH / 2,
      bezRZ,
    );
    target.add(_regFrame(rBRight, "door-panel"));
    if (!parent) this._meshes.push(rBRight);

    // ── Perforated front door ─────────────────────────────────────────────
    const doorW = outerW - bezSW * 2 + 0.05;
    const doorH = totalH - bezH * 2 + 0.05;
    const isRealistic = (settings.depth || "realistic") === "realistic";
    const doorMat = isRealistic
      ? this._makePerforatedDoorMat(doorH, doorW, settings)
      : new THREE.MeshStandardMaterial({
          color: colors.post,
          metalness: 0.35,
          roughness: 0.65,
        });
    const doorGeo = new THREE.PlaneGeometry(doorW, doorH);
    const door = new THREE.Mesh(doorGeo, doorMat);
    door.position.set(offset.x, offset.y + totalH / 2, frontZ + 0.08);
    target.add(_regFrame(door, "door-panel"));
    if (!parent) this._meshes.push(door);

    // ── Perforated split rear doors ───────────────────────────────────────
    const rearDoorGap = 0.12;
    const rearDoorW = (doorW - rearDoorGap) / 2;
    const rearDoorGeo = new THREE.PlaneGeometry(rearDoorW, doorH);
    for (const side of [-1, 1]) {
      const rearDoor = new THREE.Mesh(rearDoorGeo, doorMat.clone());
      rearDoor.position.set(
        offset.x + side * (rearDoorW / 2 + rearDoorGap / 2),
        offset.y + totalH / 2,
        rearZ - 0.08,
      );
      target.add(_regFrame(rearDoor, "door-panel"));
      if (!parent) this._meshes.push(rearDoor);
    }

    // ── Door handle: left side ────────────────────────────────────────────
    const handleMat = new THREE.MeshStandardMaterial({
      color: 0xb0bac4,
      metalness: 0.88,
      roughness: 0.2,
    });
    const handleX = offset.x - (outerW / 2 - bezSW - 0.62);
    const handleH2 = Math.min(totalH * 0.14, 5.0);
    const handleFZ = frontZ + 0.55;

    const grip = new THREE.Mesh(
      new THREE.BoxGeometry(0.26, handleH2, 0.26),
      handleMat,
    );
    grip.position.set(handleX, offset.y + totalH / 2, handleFZ);
    target.add(_regFrame(grip, "door-panel"));
    if (!parent) this._meshes.push(grip);

    for (const dy of [-1, 1]) {
      const brkt = new THREE.Mesh(
        new THREE.BoxGeometry(0.52, 0.2, 0.48),
        handleMat,
      );
      brkt.position.set(
        handleX,
        offset.y + totalH / 2 + dy * (handleH2 / 2),
        handleFZ - 0.16,
      );
      target.add(_regFrame(brkt, "door-panel"));
      if (!parent) this._meshes.push(brkt);
    }

    // ── Rear split-door handles near the meeting edge ─────────────────────
    const rearHandleZ = rearZ - 0.55;
    const rearHandleInset = 0.36;
    for (const side of [-1, 1]) {
      const rearHandleX = offset.x + side * rearHandleInset;
      const rearGrip = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, handleH2, 0.22),
        handleMat,
      );
      rearGrip.position.set(rearHandleX, offset.y + totalH / 2, rearHandleZ);
      target.add(_regFrame(rearGrip, "door-panel"));
      if (!parent) this._meshes.push(rearGrip);

      for (const dy of [-1, 1]) {
        const rearBrkt = new THREE.Mesh(
          new THREE.BoxGeometry(0.42, 0.18, 0.42),
          handleMat,
        );
        rearBrkt.position.set(
          rearHandleX,
          offset.y + totalH / 2 + dy * (handleH2 / 2),
          rearHandleZ + 0.16,
        );
        target.add(_regFrame(rearBrkt, "door-panel"));
        if (!parent) this._meshes.push(rearBrkt);
      }
    }
  }

  _makePerforatedDoorMat(doorH, doorW, settings) {
    const isLight = settings.theme === "light";
    // Canvas tile: white = opaque metal, black circle = punched hole (transparent via alphaMap)
    const tilePx = 16;
    const holeR = 5; // ~38% open area — realistic punch-plate density
    const c = document.createElement("canvas");
    c.width = tilePx;
    c.height = tilePx;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; // white = fully opaque in alphaMap red channel
    ctx.fillRect(0, 0, tilePx, tilePx);
    ctx.fillStyle = "#000000"; // black = transparent
    ctx.beginPath();
    ctx.arc(tilePx / 2, tilePx / 2, holeR, 0, Math.PI * 2);
    ctx.fill();

    const alphaTex = new THREE.CanvasTexture(c);
    alphaTex.wrapS = THREE.RepeatWrapping;
    alphaTex.wrapT = THREE.RepeatWrapping;
    alphaTex.repeat.set(doorW * 3.5, doorH * 3.5); // ~3.5 holes per inch
    this._textures.push(alphaTex);

    return new THREE.MeshStandardMaterial({
      color: isLight ? 0x242430 : 0x0e0e16,
      metalness: 0.62,
      roughness: 0.45,
      alphaMap: alphaTex,
      alphaTest: 0.45, // hard-edge cutout — avoids depth-sort issues
      side: THREE.DoubleSide, // visible from inside when orbiting
    });
  }

  _buildDevices(devices, rack, settings, offset, parent) {
    const target = parent || this._scene;
    const sc = parseFloat(settings.scale) || 1;
    const depth = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
    const frontDeviceZ =
      offset.z + depth / 2 - deviceClearanceForDepth(depth, "front");
    const rearDeviceZ =
      offset.z - depth / 2 + deviceClearanceForDepth(depth, "rear");
    const fullDepthDeviceDepth = deviceEnvelopeDepth(depth);
    const face = settings.face || "both";
    const loader = new THREE.TextureLoader();
    const colors = themeColors(settings.theme);
    const darkMat = new THREE.MeshStandardMaterial({
      color: colors.deviceDark,
      metalness: 0.65,
      roughness: 0.45,
    });

    for (const dev of devices) {
      if (face === "front" && dev.face === "rear" && !dev.is_full_depth)
        continue;
      if (face === "rear" && dev.face === "front" && !dev.is_full_depth)
        continue;

      const deviceH = dev.u_height * U_SCALE_BASE * sc;
      const deviceDepth = dev.is_full_depth
        ? fullDepthDeviceDepth
        : fullDepthDeviceDepth * 0.55;
      const yBottom = this._calcY(dev, rack, sc);

      // Align device Z with its mounting rail:
      //   full-depth  → centred across full depth
      //   front-face  → flush with the +Z (camera-side) inner rail face
      //   rear-face   → flush with the -Z inner rail face
      let deviceZ;
      if (dev.is_full_depth) {
        deviceZ = offset.z;
      } else if (dev.face === "front") {
        deviceZ = frontDeviceZ - deviceDepth / 2;
      } else {
        deviceZ = rearDeviceZ + deviceDepth / 2;
      }

      const geo = new THREE.BoxGeometry(
        RACK_WIDTH - POST_W * 2,
        deviceH,
        deviceDepth,
      );
      const materials = [
        darkMat,
        darkMat,
        darkMat,
        darkMat,
        this._faceMat(dev, "front", loader, settings, colors),
        this._faceMat(dev, "rear", loader, settings, colors),
      ];

      const mesh = new THREE.Mesh(geo, materials);
      mesh.position.set(offset.x, offset.y + yBottom + deviceH / 2, deviceZ);
      mesh.userData = { deviceId: dev.id, deviceData: dev };
      target.add(mesh);
      if (!parent) this._meshes.push(mesh);
      this._deviceMeshes.push(mesh); // always tracked (both single and layout mode)

      // Thin edge accent on the device box
      const devEdgeMat = new THREE.LineBasicMaterial({
        color: settings.theme === "light" ? 0x5577aa : 0x2a4060,
        transparent: true,
        opacity: 0.55,
      });
      const devEdgeGeo = new THREE.EdgesGeometry(geo);
      const devEdges = new THREE.LineSegments(devEdgeGeo, devEdgeMat);
      devEdges.raycast = () => {}; // don't intercept mouse picks
      mesh.add(devEdges);

      const div = document.createElement("div");
      div.className = "r3d-device-label";
      div.textContent = dev.name;
      const label = new CSS2DObject(div);
      label.position.set(0, 0, deviceDepth / 2 + 0.1);
      label.visible = false; // hidden by default; auto=hover reveals, on=always shown
      mesh.add(label);
      mesh.userData.label = label; // back-ref so hoverDevice() can toggle it
      this._labels.push(label);

      this._buildPatchEnclosureModules(
        mesh,
        dev,
        deviceH,
        deviceDepth,
        settings,
        loader,
      );
    }

    this._applyLabelMode(settings.labels);
  }

  _buildPatchEnclosureModules(
    mesh,
    dev,
    deviceH,
    deviceDepth,
    settings,
    loader,
  ) {
    const moduleBays = Array.isArray(dev.module_bays) ? dev.module_bays : [];
    const deviceBays = Array.isArray(dev.device_bays) ? dev.device_bays : [];
    const deviceHasContent = deviceBays.some(
      (b) => !!b.device_image || !!b.occupied,
    );
    const moduleHasContent = moduleBays.some(
      (b) => !!b.module_image || !!b.module_id || !!b.module_name,
    );
    if (!deviceHasContent && (!dev.patch_enclosure || !moduleHasContent))
      return;

    // Prefer device bays when they are populated (e.g. installed splitter devices in S1..S8).
    const baysToRender = deviceHasContent ? deviceBays : moduleBays;
    if (!baysToRender.length) return;

    const mountSide = dev.face === "rear" ? "rear" : "front";
    const isRearOnly = settings.face === "rear";
    const isFrontOnly = settings.face === "front";
    if (
      !dev.is_full_depth &&
      ((isRearOnly && mountSide === "front") ||
        (isFrontOnly && mountSide === "rear"))
    ) {
      return;
    }

    const usableW = (RACK_WIDTH - POST_W * 2) * 0.92;
    const usableH = deviceH * 0.86;

    const highestSlot = Math.max(
      ...baysToRender.map((b) => parseInt(b.face_slot, 10) || 0),
      0,
    );
    const count = Math.max(baysToRender.length, highestSlot);
    const cols = Math.max(1, Math.ceil(Math.sqrt(count * 2.0)));
    const rows = Math.max(1, Math.ceil(count / cols));

    const cellW = usableW / cols;
    const cellH = usableH / rows;
    const tileW = cellW * 0.84;
    const tileH = cellH * 0.78;
    const z =
      mountSide === "front"
        ? deviceDepth / 2 + 0.012
        : -deviceDepth / 2 - 0.012;
    const yTop = usableH / 2 - cellH / 2;
    const xLeft = -usableW / 2 + cellW / 2;

    for (const bay of baysToRender) {
      const layout =
        bay.layout && typeof bay.layout === "object" ? bay.layout : null;

      let x;
      let y;
      let finalW = tileW;
      let finalH = tileH;

      if (
        layout &&
        Number.isFinite(+layout.x) &&
        Number.isFinite(+layout.y) &&
        Number.isFinite(+layout.w) &&
        Number.isFinite(+layout.h) &&
        +layout.w > 0 &&
        +layout.h > 0
      ) {
        const lx = Math.max(0, Math.min(100, +layout.x));
        const ly = Math.max(0, Math.min(100, +layout.y));
        const lw = Math.max(0.5, Math.min(100, +layout.w));
        const lh = Math.max(0.5, Math.min(100, +layout.h));

        finalW = usableW * (lw / 100);
        finalH = usableH * (lh / 100);
        x = -usableW / 2 + usableW * ((lx + lw / 2) / 100);
        y = usableH / 2 - usableH * ((ly + lh / 2) / 100);
      } else {
        const slot = Math.max((parseInt(bay.face_slot, 10) || 1) - 1, 0);
        const row = Math.floor(slot / cols);
        const col = slot % cols;
        x = xLeft + col * cellW;
        y = yTop - row * cellH;
      }

      let tileMat;
      const tileImage = bay.module_image || bay.device_image;
      if (tileImage) {
        const tex = loader.load(tileImage);
        tex.colorSpace = THREE.SRGBColorSpace;
        this._textures.push(tex);
        tileMat = new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          side: THREE.DoubleSide,
        });
      } else {
        tileMat = new THREE.MeshStandardMaterial({
          color: hashColor(
            bay.installed_device_type ||
              bay.module_type ||
              bay.installed_device_name ||
              bay.module_name ||
              bay.name ||
              String(bay.id),
          ),
          metalness: 0.25,
          roughness: 0.65,
          side: THREE.DoubleSide,
        });
      }

      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(finalW, finalH),
        tileMat,
      );
      tile.position.set(x, y, z);
      if (mountSide === "rear") tile.rotation.y = Math.PI;

      // Occupied device bays should behave like selectable devices in the 3D scene.
      if (bay.installed_device_id) {
        tile.userData = {
          deviceId: bay.installed_device_id,
          deviceData: {
            id: bay.installed_device_id,
            name: bay.installed_device_name || `${dev.name} ${bay.name}`,
            device_type: bay.installed_device_type || "",
            manufacturer: bay.installed_device_manufacturer || "",
            role: bay.installed_device_role || "",
            status: bay.installed_device_status || "",
            asset_tag: bay.installed_device_asset_tag || "",
            serial: bay.installed_device_serial || "",
            url: bay.installed_device_url || "",
            position: null,
            face: bay.installed_device_face || "",
            u_height: bay.installed_device_u_height ?? null,
            is_full_depth: !!bay.installed_device_is_full_depth,
            front_image: bay.device_image || null,
            rear_image: null,
            bay_name: bay.name,
            parent_device_name: dev.name || "",
          },
        };
        this._deviceMeshes.push(tile);
      } else {
        tile.raycast = () => {};
      }

      mesh.add(tile);
    }
  }

  _faceMat(dev, side, loader, settings, colors) {
    const mountedRear = dev.face === "rear" && !dev.is_full_depth;
    const url = mountedRear
      ? side === "rear"
        ? dev.front_image || dev.rear_image
        : dev.rear_image || dev.front_image
      : side === "front"
        ? dev.front_image
        : dev.rear_image;
    if (settings.colorBy === "image") {
      if (url) {
        const tex = loader.load(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        this._textures.push(tex);
        return new THREE.MeshBasicMaterial({ map: tex });
      }
      // No image — fall back to device-type hash
      return new THREE.MeshStandardMaterial({
        color: hashColor(dev.device_type || String(dev.id)),
        metalness: 0.3,
        roughness: 0.6,
      });
    }
    let color;
    if (settings.colorBy === "role") {
      color = dev.role_color
        ? roleColorInt(dev.role_color)
        : hashColor(dev.role || "unassigned");
    } else {
      // manufacturer (or unknown fallback)
      color = hashColor(dev.manufacturer || dev.device_type || String(dev.id));
    }
    return new THREE.MeshStandardMaterial({
      color,
      metalness: 0.3,
      roughness: 0.6,
    });
  }

  _buildEmptySlots(rackData, settings, offset, parent) {
    // Blank panels are front-mounted only — skip entirely for rear-only view
    if (settings.face === "rear") return;
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

    const mat = new THREE.MeshStandardMaterial({
      color: colors.blank,
      metalness: 0.25,
      roughness: 0.75,
    });
    const slotH = U_SCALE_BASE * sc;
    const depth = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
    // Blank panels sit flush with the front (+Z) mounting rail, same as front-mounted devices
    const blankZ =
      offset.z +
      depth / 2 -
      deviceClearanceForDepth(depth, "front") -
      BLANK_DEPTH / 2;

    for (
      let u = rack.starting_unit;
      u < rack.starting_unit + rack.u_height;
      u++
    ) {
      if (occupied.has(u * 2)) continue;
      const geo = new THREE.BoxGeometry(
        RACK_WIDTH - POST_W * 2 - 0.05,
        slotH - 0.08,
        BLANK_DEPTH,
      );
      const m = new THREE.Mesh(geo, mat);
      m.position.set(
        offset.x,
        offset.y + this._calcYFromUnit(u, rack, sc) + slotH / 2,
        blankZ,
      );
      target.add(m);
      if (!parent) this._meshes.push(m);
    }
  }

  _calcY(dev, rack, sc) {
    return this._calcYFromUnit(dev.position, rack, sc);
  }

  _calcYFromUnit(unit, rack, sc) {
    if (rack.desc_units)
      return (
        (rack.u_height - (unit - rack.starting_unit) - 1) * U_SCALE_BASE * sc
      );
    return (unit - rack.starting_unit) * U_SCALE_BASE * sc;
  }

  // ── Cable public API ──────────────────────────────────────────────────────

  applyCableSettings(settings) {
    this._cableManager.applySettings(settings);
  }

  selectCable(mesh) {
    return this._cableManager.selectCable(mesh);
  }

  startTrace(cableId) {
    const entry = this._cableManager._entries.find(
      (e) => e.cableData.id === cableId,
    );
    if (!entry) return;
    this.startTraceOnCurve(entry.mesh.userData.curve);
  }

  startTraceOnCurve(curve, options = {}) {
    if (this._traceAnimator) {
      this._traceAnimator.dispose();
      this._traceAnimator = null;
    }
    if (!curve) return;
    this._traceAnimator = new CableTraceAnimator(this._scene, curve, options);
    this._traceAnimator.start();
  }

  stopTrace() {
    if (this._traceAnimator) {
      this._traceAnimator.dispose();
      this._traceAnimator = null;
    }
  }

  getCableMeshes() {
    return this._cableMeshes;
  }

  // ── Cable build helpers ───────────────────────────────────────────────────

  _buildCables(cables, devices, rack, settings, offset) {
    const dwMap = this._buildDeviceWorldMap(devices, rack, settings, offset);
    const rwMap = new Map();
    rwMap.set(rack.id, {
      offsetX: offset.x,
      topY:
        offset.y +
        rack.u_height * U_SCALE_BASE * (parseFloat(settings.scale) || 1),
      inter_rack_exit_side: rack.inter_rack_exit_side || "right",
    });
    this._cableManager.build(cables, dwMap, rwMap);
    this._cableMeshes = this._cableManager.getMeshes();
    // Apply current settings (e.g. visibility toggles already in effect)
    const s = this._settings;
    if (s.cableSettings) this._cableManager.applySettings(s.cableSettings);
  }

  _buildCablesForLayout(placements, rackDataMap, settings, cx, cz) {
    const dwMap = new Map();
    const rwMap = new Map();
    const cableMap = new Map();
    const sc = parseFloat(settings.scale) || 1;

    for (const p of placements) {
      const rd = rackDataMap[p.rackId];
      if (!rd) continue;

      const worldOffset = new THREE.Vector3(p.x - cx, 0, p.z - cz);
      const rackDwMap = this._buildDeviceWorldMap(
        rd.devices,
        rd.rack,
        settings,
        worldOffset,
      );
      for (const [deviceId, deviceWorld] of rackDwMap.entries()) {
        dwMap.set(deviceId, deviceWorld);
      }

      rwMap.set(rd.rack.id, {
        offsetX: worldOffset.x,
        topY: worldOffset.y + rd.rack.u_height * U_SCALE_BASE * sc,
        centerZ: worldOffset.z,
        inter_rack_exit_side: rd.rack.inter_rack_exit_side || "right",
      });

      for (const cable of rd.cables || []) {
        cableMap.set(cable.id, cable);
      }
    }

    this._cableManager.build(Array.from(cableMap.values()), dwMap, rwMap);
    this._cableMeshes = this._cableManager.getMeshes();
    const s = this._settings;
    if (s.cableSettings) this._cableManager.applySettings(s.cableSettings);
  }

  _buildDeviceWorldMap(devices, rack, settings, offset) {
    const sc = parseFloat(settings.scale) || 1;
    const depth = DEPTH_MAP[settings.depth] || DEPTH_MAP.realistic;
    const frontDeviceZ =
      offset.z + depth / 2 - deviceClearanceForDepth(depth, "front");
    const rearDeviceZ =
      offset.z - depth / 2 + deviceClearanceForDepth(depth, "rear");
    const fullDepthDeviceDepth = deviceEnvelopeDepth(depth);
    const map = new Map();
    for (const dev of devices) {
      const yBottom = this._calcY(dev, rack, sc);
      const deviceH = dev.u_height * U_SCALE_BASE * sc;
      const deviceDepth = dev.is_full_depth
        ? fullDepthDeviceDepth
        : fullDepthDeviceDepth * 0.55;
      let deviceZ;
      if (dev.is_full_depth) {
        deviceZ = offset.z;
      } else if (dev.face === "front") {
        deviceZ = frontDeviceZ - deviceDepth / 2;
      } else {
        deviceZ = rearDeviceZ + deviceDepth / 2;
      }
      const mountFace = dev.face === "rear" ? "rear" : "front";
      const logicalFrontFaceZ =
        mountFace === "rear"
          ? deviceZ - deviceDepth / 2
          : deviceZ + deviceDepth / 2;
      const logicalRearFaceZ =
        mountFace === "rear"
          ? deviceZ + deviceDepth / 2
          : deviceZ - deviceDepth / 2;

      map.set(dev.id, {
        worldX: offset.x,
        worldYBot: offset.y + yBottom,
        worldYTop: offset.y + yBottom + deviceH,
        frontFaceZ: deviceZ + deviceDepth / 2,
        rearFaceZ: deviceZ - deviceDepth / 2,
        logicalFrontFaceZ,
        logicalRearFaceZ,
        mountFace,
        rackCenterZ: offset.z,
        rackOffsetX: offset.x,
        cable_exit_side: dev.cable_exit_side || "left",
        port_positions: dev.port_positions || {},
        deviceW: RACK_WIDTH - POST_W * 2,
      });

      this._addDeviceBayWorldMapEntries(map, dev, {
        offset,
        yBottom,
        deviceH,
        deviceDepth,
        deviceZ,
      });
    }
    return map;
  }

  _addDeviceBayWorldMapEntries(map, dev, geom) {
    const deviceBays = Array.isArray(dev.device_bays) ? dev.device_bays : [];
    const occupiedBays = deviceBays.filter((b) => b.installed_device_id);
    if (!occupiedBays.length) return;

    const usableW = (RACK_WIDTH - POST_W * 2) * 0.92;
    const usableH = geom.deviceH * 0.86;
    const highestSlot = Math.max(
      ...deviceBays.map((b) => parseInt(b.face_slot, 10) || 0),
      0,
    );
    const count = Math.max(deviceBays.length, highestSlot);
    const cols = Math.max(1, Math.ceil(Math.sqrt(count * 2.0)));
    const rows = Math.max(1, Math.ceil(count / cols));
    const cellW = usableW / cols;
    const cellH = usableH / rows;
    const defaultW = cellW * 0.84;
    const defaultH = cellH * 0.78;
    const yTop = usableH / 2 - cellH / 2;
    const xLeft = -usableW / 2 + cellW / 2;
    const mountSide = dev.face === "rear" ? "rear" : "front";
    const faceZ =
      mountSide === "front"
        ? geom.deviceZ + geom.deviceDepth / 2
        : geom.deviceZ - geom.deviceDepth / 2;

    for (const bay of occupiedBays) {
      const layout =
        bay.layout && typeof bay.layout === "object" ? bay.layout : null;
      let localX;
      let localY;
      let bayW = defaultW;
      let bayH = defaultH;

      if (
        layout &&
        Number.isFinite(+layout.x) &&
        Number.isFinite(+layout.y) &&
        Number.isFinite(+layout.w) &&
        Number.isFinite(+layout.h) &&
        +layout.w > 0 &&
        +layout.h > 0
      ) {
        const lx = Math.max(0, Math.min(100, +layout.x));
        const ly = Math.max(0, Math.min(100, +layout.y));
        const lw = Math.max(0.5, Math.min(100, +layout.w));
        const lh = Math.max(0.5, Math.min(100, +layout.h));

        bayW = usableW * (lw / 100);
        bayH = usableH * (lh / 100);
        localX = -usableW / 2 + usableW * ((lx + lw / 2) / 100);
        localY = usableH / 2 - usableH * ((ly + lh / 2) / 100);
      } else {
        const slot = Math.max((parseInt(bay.face_slot, 10) || 1) - 1, 0);
        const row = Math.floor(slot / cols);
        const col = slot % cols;
        localX = xLeft + col * cellW;
        localY = yTop - row * cellH;
      }

      map.set(bay.installed_device_id, {
        worldX: geom.offset.x + localX,
        worldYBot:
          geom.offset.y + geom.yBottom + geom.deviceH / 2 + localY - bayH / 2,
        worldYTop:
          geom.offset.y + geom.yBottom + geom.deviceH / 2 + localY + bayH / 2,
        frontFaceZ: faceZ,
        rearFaceZ: faceZ,
        logicalFrontFaceZ: faceZ,
        logicalRearFaceZ: faceZ,
        mountFace: bay.installed_device_face === "rear" ? "rear" : mountSide,
        rackCenterZ: geom.offset.z,
        rackOffsetX: geom.offset.x,
        cable_exit_side:
          bay.installed_device_cable_exit_side || dev.cable_exit_side || "left",
        port_positions: bay.installed_device_port_positions || {},
        deviceW: bayW,
      });
    }
  }

  // ── Private: utilities ────────────────────────────────────────────────────

  _updateSceneBg(settings) {
    const colors = themeColors(settings.theme || "dark");
    this._scene.background = new THREE.Color(colors.sceneBg);
  }

  _clear() {
    // Explicitly remove CSS2D DOM elements — the CSS2DRenderer does not
    // automatically clean them up when their objects leave the scene.
    for (const label of this._labels) {
      label.element?.parentNode?.removeChild(label.element);
    }
    for (const obj of this._meshes) {
      this._scene.remove(obj);
      obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        const mats = Array.isArray(child.material)
          ? child.material
          : child.material
            ? [child.material]
            : [];
        mats.forEach((m) => m.dispose());
      });
    }
    for (const t of this._textures) t.dispose();
    this._meshes = [];
    this._labels = [];
    this._textures = [];
    this._deviceMeshes = [];
    this._rackFrameMeshes = [];
    this._hoveredMesh = null;
    this._selectedMesh = null;
    this._hoveredRackId = null;
    this._cameraAnim = null;
    this._cableManager.clear();
    this._cableMeshes = [];
    if (this._traceAnimator) {
      this._traceAnimator.dispose();
      this._traceAnimator = null;
    }
  }

  _applyLabelMode(mode) {
    if (mode === "on") {
      this._labels.forEach((l) => {
        l.visible = true;
      });
      return;
    }
    // 'auto' and 'off': hide all; 'auto' reveals the hovered device via hoverDevice()
    this._labels.forEach((l) => {
      l.visible = false;
    });
  }

  _updateLabelVisibility() {
    const dist = this._camera.position.distanceTo(this._controls.target);
    const show = dist < LABEL_SHOW_DIST;
    this._labels.forEach((l) => {
      l.visible = show;
    });
  }

  _animate() {
    this._animId = requestAnimationFrame(() => this._animate());
    const delta = this._clock.getDelta();
    this._controls.update();
    if (this._cameraAnim) this._stepCameraAnim();
    if (this._traceAnimator) this._traceAnimator.tick(delta);
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

// ── CablePathRouter ────────────────────────────────────────────────────────────
// Pure geometry — no Three.js scene objects.  Returns CatmullRomCurve3 paths.

class CablePathRouter {
  constructor(deviceWorldMap, rackWorldMap) {
    this._dw = deviceWorldMap; // Map<deviceId, devWorld>
    this._rw = rackWorldMap; // Map<rackId, rackWorld>
  }

  computePath(cable) {
    const aT = cable.a_terminations?.[0];
    const bT = cable.b_terminations?.[0];
    if (!aT || !bT) return null;

    const aDev = this._dw.get(aT.device_id);
    const bDev = this._dw.get(bT.device_id);
    if (!aDev || !bDev) return null;

    const aEnd = this._portEndpoint(aDev, aT.port_name, aT.port_type);
    const bEnd = this._portEndpoint(bDev, bT.port_name, bT.port_type);
    const aPos = aEnd.pos;
    const bPos = bEnd.pos;

    const sameRack = aT.rack_id !== null && aT.rack_id === bT.rack_id;
    if (sameRack) {
      return this._intraRackPath(aEnd, bEnd, aDev, bDev);
    }
    const aRack = this._rw.get(aT.rack_id);
    const bRack = this._rw.get(bT.rack_id);
    if (!aRack || !bRack) {
      return new THREE.CatmullRomCurve3([aPos, bPos]);
    }
    return this._interRackPath(aEnd, bEnd, aDev, bDev, aRack, bRack);
  }

  computeTrunkBundlePaths(bundle) {
    const branchSpecs = [];
    const aBreakouts = [];
    const bBreakouts = [];
    const pairs = Math.min(
      bundle.a_terminations?.length || 0,
      bundle.b_terminations?.length || 0,
    );

    for (let i = 0; i < pairs; i++) {
      const aT = bundle.a_terminations[i];
      const bT = bundle.b_terminations[i];
      const aDev = this._dw.get(aT.device_id);
      const bDev = this._dw.get(bT.device_id);
      if (!aDev || !bDev) continue;

      const aEnd = this._portEndpoint(aDev, aT.port_name, aT.port_type);
      const bEnd = this._portEndpoint(bDev, bT.port_name, bT.port_type);
      const aBreakout = this._rearBreakoutPoint(aDev, aEnd.pos);
      const bBreakout = this._rearBreakoutPoint(bDev, bEnd.pos);

      aBreakouts.push(aBreakout);
      bBreakouts.push(bBreakout);
      branchSpecs.push({ end: aEnd, dev: aDev, breakout: aBreakout });
      branchSpecs.push({ end: bEnd, dev: bDev, breakout: bBreakout });
    }

    if (!aBreakouts.length || !bBreakouts.length) return null;

    const aAnchor = this._averagePoint(aBreakouts);
    const bAnchor = this._averagePoint(bBreakouts);
    const aRack = this._rw.get(bundle.a_terminations[0]?.rack_id);
    const bRack = this._rw.get(bundle.b_terminations[0]?.rack_id);
    if (!aRack || !bRack) return null;

    const trunk = this._rearTrunkPath(aAnchor, bAnchor, aRack, bRack);
    const branches = branchSpecs
      .map(({ end, dev, breakout }) =>
        this._branchToRearAnchor(end, dev, breakout),
      )
      .filter(Boolean);

    // Add fan-in/fan-out from each per-cable breakout to the shared trunk anchor.
    const anchorBranches = [
      ...aBreakouts.map((p) => this._breakoutToAnchorPath(p, aAnchor)),
      ...bBreakouts.map((p) => this._breakoutToAnchorPath(p, bAnchor)),
    ].filter(Boolean);

    return { trunk, branches: [...branches, ...anchorBranches] };
  }

  _portEndpoint(dw, portName, portType) {
    const pos = dw.port_positions?.[portName];
    const logicalFace = this._logicalPortFace(pos, portType);
    const face = this._physicalPortFace(dw, logicalFace);
    if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
      const x = dw.worldX + (pos.x - 0.5) * dw.deviceW;
      const y = dw.worldYBot + (1 - pos.y) * (dw.worldYTop - dw.worldYBot);
      const z = this._logicalFaceZ(dw, logicalFace);
      return { pos: new THREE.Vector3(x, y, z), face };
    }
    const faceZ = this._logicalFaceZ(dw, logicalFace);
    return {
      pos: new THREE.Vector3(
        dw.worldX,
        (dw.worldYBot + dw.worldYTop) / 2,
        faceZ,
      ),
      face,
    };
  }

  _logicalPortFace(pos, portType) {
    if (portType === "rearport") return "rear";
    if (portType === "frontport" || portType === "interface") return "front";
    return pos?.face === "rear" ? "rear" : "front";
  }

  _physicalPortFace(dw, logicalFace) {
    if (dw.mountFace !== "rear") return logicalFace;
    return logicalFace === "rear" ? "front" : "rear";
  }

  _logicalFaceZ(dw, logicalFace) {
    if (logicalFace === "rear") return dw.logicalRearFaceZ ?? dw.rearFaceZ;
    return dw.logicalFrontFaceZ ?? dw.frontFaceZ;
  }

  _channelX(dw, portWorldX) {
    const side = dw.cable_exit_side || "left";
    const off = (RACK_WIDTH + POST_W * 2) / 2 + CABLE_CHANNEL_W / 2;
    if (side === "right") return dw.rackOffsetX + off;
    if (side === "split") {
      return portWorldX >= dw.worldX
        ? dw.rackOffsetX + off
        : dw.rackOffsetX - off;
    }
    return dw.rackOffsetX - off;
  }

  _routePlaneZ(dw, face) {
    return face === "rear" ? dw.rearFaceZ - 0.65 : dw.frontFaceZ + 0.65;
  }

  _rearBreakoutPoint(dw, portPos) {
    return new THREE.Vector3(
      this._channelX(dw, portPos.x),
      portPos.y,
      this._routePlaneZ(dw, "rear"),
    );
  }

  _averagePoint(points) {
    const out = new THREE.Vector3(0, 0, 0);
    for (const p of points) out.add(p);
    return out.multiplyScalar(1 / points.length);
  }

  _branchToRearAnchor(end, dev, breakout) {
    const port = end.pos;
    const portRouteZ = this._routePlaneZ(dev, end.face);
    const pts = [port.clone()];

    if (Math.abs(port.z - portRouteZ) > 0.01) {
      pts.push(new THREE.Vector3(port.x, port.y, portRouteZ));
    }

    pts.push(new THREE.Vector3(breakout.x, port.y, portRouteZ));

    if (Math.abs(portRouteZ - breakout.z) > 0.01) {
      pts.push(new THREE.Vector3(breakout.x, port.y, breakout.z));
    }

    pts.push(breakout.clone());
    return this._curveFromPoints(pts);
  }

  _breakoutToAnchorPath(breakout, anchor) {
    if (breakout.distanceTo(anchor) < 0.01) return null;
    return this._curveFromPoints([
      breakout.clone(),
      new THREE.Vector3(breakout.x, anchor.y, breakout.z),
      anchor.clone(),
    ]);
  }

  _rearTrunkPath(aAnchor, bAnchor, aRack, bRack) {
    const overheadY = Math.max(aRack.topY, bRack.topY) + CABLE_OVERHEAD_H;
    const midZ = (aAnchor.z + bAnchor.z) / 2;
    const pts = [
      aAnchor.clone(),
      new THREE.Vector3(aAnchor.x, overheadY, aAnchor.z),
      new THREE.Vector3(aAnchor.x, overheadY, midZ),
      new THREE.Vector3(bAnchor.x, overheadY, bAnchor.z),
      new THREE.Vector3(bAnchor.x, bAnchor.y, bAnchor.z),
      bAnchor.clone(),
    ];
    return this._curveFromPoints(pts);
  }

  _curveFromPoints(points) {
    const distinct = [];
    for (const point of points) {
      if (
        !distinct.length ||
        distinct[distinct.length - 1].distanceTo(point) > 0.01
      ) {
        distinct.push(point);
      }
    }
    if (distinct.length < 2) return null;
    return new THREE.CatmullRomCurve3(distinct, false, "catmullrom", 0.5);
  }

  _intraRackPath(aEnd, bEnd, aDev, bDev) {
    const aPos = aEnd.pos;
    const bPos = bEnd.pos;
    const aChX = this._channelX(aDev, aPos.x);
    const bChX = this._channelX(bDev, bPos.x);
    const midY = (aPos.y + bPos.y) / 2;

    if (aEnd.face === bEnd.face) {
      const chZ =
        aEnd.face === "rear"
          ? Math.min(aDev.rearFaceZ, bDev.rearFaceZ) - 0.65
          : Math.max(aDev.frontFaceZ, bDev.frontFaceZ) + 0.65;
      const pts = [
        aPos.clone(),
        new THREE.Vector3(aPos.x, aPos.y, chZ),
        new THREE.Vector3(aChX, aPos.y, chZ),
        new THREE.Vector3(aChX, midY, chZ),
        new THREE.Vector3(bChX, bPos.y, chZ),
        new THREE.Vector3(bPos.x, bPos.y, chZ),
        bPos.clone(),
      ];
      return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
    }

    const aRouteZ = this._routePlaneZ(aDev, aEnd.face);
    const bRouteZ = this._routePlaneZ(bDev, bEnd.face);
    const pts = [
      aPos.clone(),
      new THREE.Vector3(aPos.x, aPos.y, aRouteZ),
      new THREE.Vector3(aChX, aPos.y, aRouteZ),
      new THREE.Vector3(aChX, midY, aRouteZ),
      new THREE.Vector3(aChX, midY, bRouteZ),
      new THREE.Vector3(bChX, midY, bRouteZ),
      new THREE.Vector3(bChX, bPos.y, bRouteZ),
      new THREE.Vector3(bPos.x, bPos.y, bRouteZ),
      bPos.clone(),
    ];
    return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
  }

  _interRackPath(aEnd, bEnd, aDev, bDev, aRack, bRack) {
    const aPos = aEnd.pos;
    const bPos = bEnd.pos;
    const overheadY = Math.max(aRack.topY, bRack.topY) + CABLE_OVERHEAD_H;
    const aChX = this._channelX(aDev, aPos.x);
    const bChX = this._channelX(bDev, bPos.x);
    const aRouteZ = this._routePlaneZ(aDev, aEnd.face);
    const bRouteZ = this._routePlaneZ(bDev, bEnd.face);
    const aChZ = aDev.rackCenterZ;
    const bChZ = bDev.rackCenterZ;
    const midZ = (aChZ + bChZ) / 2;
    const pts = [
      aPos.clone(),
      new THREE.Vector3(aPos.x, aPos.y, aRouteZ),
      new THREE.Vector3(aChX, aPos.y, aRouteZ),
      new THREE.Vector3(aChX, aPos.y, aChZ),
      new THREE.Vector3(aChX, overheadY, aChZ),
      new THREE.Vector3(aChX, overheadY, midZ),
      new THREE.Vector3(bChX, overheadY, bChZ),
      new THREE.Vector3(bChX, bPos.y, bChZ),
      new THREE.Vector3(bChX, bPos.y, bRouteZ),
      new THREE.Vector3(bPos.x, bPos.y, bRouteZ),
      bPos.clone(),
    ];
    return new THREE.CatmullRomCurve3(pts, false, "catmullrom", 0.5);
  }
}

// ── CableManager ───────────────────────────────────────────────────────────────
// Owns all cable Three.js objects and material state.

class CableManager {
  constructor(scene) {
    this._scene = scene;
    this._entries = []; // [{mesh, cableData}]
    this._group = new THREE.Group();
    scene.add(this._group);
    this._hoveredMesh = null;
    this._selectedMesh = null;
    this._settings = {
      showPatch: true,
      showNetwork: true,
      showPower: false,
      opacity: 1.0,
    };
  }

  build(cables, deviceWorldMap, rackWorldMap) {
    this.clear();
    const debug = {
      input: cables?.length || 0,
      built: 0,
      bundles: 0,
      trunkBackbones: 0,
      trunkBranches: 0,
      hiddenBySettings: 0,
      missingRoute: 0,
      deviceIds: Array.from(deviceWorldMap.keys()),
      sample: (cables || []).slice(0, 5),
    };
    if (!cables?.length) {
      window.__rack3dCableDebug = debug;
      return;
    }
    const router = new CablePathRouter(deviceWorldMap, rackWorldMap);
    const renderables = this._buildRenderables(cables);
    debug.bundles = renderables.filter((c) => c.is_trunk_bundle).length;

    for (const cable of renderables) {
      if (!this._shouldRender(cable)) {
        debug.hiddenBySettings += 1;
        continue;
      }

      if (cable.is_trunk_bundle) {
        const paths = router.computeTrunkBundlePaths(cable);
        if (!paths?.trunk) {
          debug.missingRoute += 1;
          continue;
        }

        const trunkMesh = this._makeCableMesh(
          cable,
          paths.trunk,
          this._radiusForCable(cable),
        );
        trunkMesh.userData.isTrunkBackbone = true;
        this._group.add(trunkMesh);
        this._entries.push({ mesh: trunkMesh, cableData: cable });
        debug.built += 1;
        debug.trunkBackbones += 1;

        for (const branchCurve of paths.branches || []) {
          const branchMesh = this._makeCableMesh(
            cable,
            branchCurve,
            CABLE_PATCH_RADIUS * 0.72,
          );
          branchMesh.userData.isTrunkBranch = true;
          this._group.add(branchMesh);
          this._entries.push({ mesh: branchMesh, cableData: cable });
          debug.built += 1;
          debug.trunkBranches += 1;
        }
        continue;
      }

      const curve = router.computePath(cable);
      if (!curve) {
        debug.missingRoute += 1;
        continue;
      }

      const mesh = this._makeCableMesh(
        cable,
        curve,
        this._radiusForCable(cable),
      );
      this._group.add(mesh);
      this._entries.push({ mesh, cableData: cable });
      debug.built += 1;
    }
    window.__rack3dCableDebug = debug;
    if (debug.input && !debug.built) {
      console.warn(
        "Rack 3D received cables but did not build visible meshes",
        debug,
      );
    }
  }

  clear() {
    for (const { mesh } of this._entries) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      this._group.remove(mesh);
    }
    this._entries = [];
    this._hoveredMesh = null;
    this._selectedMesh = null;
  }

  dispose() {
    this.clear();
    this._scene.remove(this._group);
  }

  getMeshes() {
    return this._entries.map((e) => e.mesh);
  }

  _makeCableMesh(cable, curve, radius) {
    const colorHex = cable.color
      ? parseInt(cable.color, 16)
      : CABLE_DEFAULT_COLOR;
    const color = isNaN(colorHex) ? CABLE_DEFAULT_COLOR : colorHex;
    const geo = new THREE.TubeGeometry(
      curve,
      CABLE_PATH_SEGS,
      radius,
      CABLE_TUBE_SEGS,
      false,
    );
    const mat = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.1,
      roughness: 0.7,
      transparent: this._settings.opacity < 1,
      opacity: this._settings.opacity,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData = {
      cableId: cable.id,
      cableData: cable,
      isCable: true,
      curve,
    };
    return mesh;
  }

  _buildRenderables(cables) {
    const regular = [];
    const bundles = new Map();

    for (const cable of cables || []) {
      if (!this._isInterRack(cable)) {
        regular.push(cable);
        continue;
      }

      const racks = this._cableRackIds(cable);
      if (racks.length < 2) {
        regular.push(cable);
        continue;
      }

      const group = this._trunkGroup(cable);
      const key = `${racks[0]}:${racks[1]}:${group}`;
      if (!bundles.has(key)) {
        bundles.set(key, {
          id: `trunk:${key}`,
          label: `Trunk ${racks[0]} ⇄ ${racks[1]}${group === "default" ? "" : ` / ${group}`}`,
          color: cable.color || "",
          type: "trunk",
          trunk_group: group,
          is_trunk_bundle: true,
          bundled_count: 0,
          bundled_cable_ids: [],
          a_terminations: [],
          b_terminations: [],
        });
      }

      const bundle = bundles.get(key);
      const terms = [
        ...(cable.a_terminations || []),
        ...(cable.b_terminations || []),
      ];
      const aTerm = terms.find((t) => String(t.rack_id) === racks[0]);
      const bTerm = terms.find((t) => String(t.rack_id) === racks[1]);
      if (!aTerm || !bTerm) continue;

      bundle.bundled_count += 1;
      bundle.bundled_cable_ids.push(cable.id);
      bundle.a_terminations.push(aTerm);
      bundle.b_terminations.push(bTerm);
      if (!bundle.color && cable.color) bundle.color = cable.color;
    }

    return [...regular, ...bundles.values()];
  }

  _radiusForCable(cable) {
    if (!cable?.is_trunk_bundle) {
      return this._isInterRack(cable) ? CABLE_TRUNK_RADIUS : CABLE_PATCH_RADIUS;
    }
    const count = Math.max(1, cable.bundled_count || 1);
    return Math.min(
      CABLE_TRUNK_MAX_RADIUS,
      CABLE_TRUNK_RADIUS + Math.sqrt(count) * 0.08,
    );
  }

  _trunkGroup(cable) {
    return (
      String(
        cable.trunk_group ||
          cable.bundle_group ||
          cable.cable_trunk_group ||
          cable.iff_trunk_group ||
          "default",
      ).trim() || "default"
    );
  }

  applySettings({ showPatch, showNetwork, showPower, opacity }) {
    this._settings = { showPatch, showNetwork, showPower, opacity };
    for (const { mesh, cableData } of this._entries) {
      mesh.visible = this._shouldRender(cableData);
      mesh.material.transparent = opacity < 1;
      mesh.material.opacity = opacity;
      mesh.material.needsUpdate = true;
    }
  }

  dimUnrelated(deviceIdSet) {
    for (const { mesh, cableData } of this._entries) {
      const connected = this._connectedTo(cableData, deviceIdSet);
      mesh.material.transparent = !connected;
      mesh.material.opacity = connected ? this._settings.opacity : 0.08;
      mesh.material.needsUpdate = true;
    }
  }

  resetDim() {
    for (const { mesh } of this._entries) {
      mesh.material.transparent = this._settings.opacity < 1;
      mesh.material.opacity = this._settings.opacity;
      mesh.material.needsUpdate = true;
    }
  }

  hoverCable(mesh) {
    if (this._hoveredMesh === mesh) return;
    if (
      this._hoveredMesh &&
      !this._sameCableMesh(this._hoveredMesh, this._selectedMesh)
    ) {
      this._setCableEmissive(this._hoveredMesh, 0x000000, 0);
    }
    this._hoveredMesh = mesh;
    if (mesh && !this._sameCableMesh(mesh, this._selectedMesh)) {
      this._setCableEmissive(mesh, 0x003060, 0.7);
    }
  }

  selectCable(mesh) {
    if (this._selectedMesh && !this._sameCableMesh(this._selectedMesh, mesh)) {
      this._setCableEmissive(this._selectedMesh, 0x000000, 0);
    }
    this._selectedMesh = mesh;
    if (mesh) {
      this._setCableEmissive(mesh, 0x0050c0, 1.0);
    }
    return mesh?.userData.cableData ?? null;
  }

  clearCableSelection() {
    this.selectCable(null);
  }

  _setCableEmissive(mesh, color, intensity) {
    const cableId = mesh?.userData?.cableId;
    const colorObj = new THREE.Color(color);
    for (const { mesh: candidate } of this._entries) {
      if (candidate.userData?.cableId !== cableId) continue;
      candidate.material.emissive = colorObj;
      candidate.material.emissiveIntensity = intensity;
    }
  }

  _sameCableMesh(a, b) {
    return !!a && !!b && a.userData?.cableId === b.userData?.cableId;
  }

  _shouldRender(cable) {
    const t = cable.type || "";
    if (FIBRE_CABLE_TYPES.has(t)) return this._settings.showPatch;
    if (NETWORK_CABLE_TYPES.has(t)) return this._settings.showNetwork;
    if (t === "power") return this._settings.showPower;
    return this._settings.showPatch || this._settings.showNetwork;
  }

  _isInterRack(cable) {
    return this._cableRackIds(cable).length > 1;
  }

  _cableRackIds(cable) {
    return Array.from(
      new Set(
        [...(cable.a_terminations || []), ...(cable.b_terminations || [])]
          .map((t) => t.rack_id)
          .filter((id) => id !== null && id !== undefined)
          .map(String),
      ),
    ).sort();
  }

  _connectedTo(cable, deviceIdSet) {
    for (const t of [
      ...(cable.a_terminations || []),
      ...(cable.b_terminations || []),
    ]) {
      if (deviceIdSet.has(t.device_id)) return true;
    }
    return false;
  }
}

// ── CableTraceAnimator ─────────────────────────────────────────────────────────
// Animates a glowing pulse traveling along a cable path.

class CableTraceAnimator {
  constructor(scene, curve, options = {}) {
    this._scene = scene;
    this._curve = curve;
    this._t = 0;
    this._loop = options.loop ?? true;
    this._duration = curve.getLength() / 20; // 20 scene-in/s constant speed
    this._active = false;

    const geo = new THREE.SphereGeometry(0.35, 8, 8);
    const mat = new THREE.MeshStandardMaterial({
      color: options.color ?? 0x00ddff,
      emissive: new THREE.Color(options.color ?? 0x00ddff),
      emissiveIntensity: 2.2,
      transparent: true,
      opacity: 0.92,
    });
    this._mesh = new THREE.Mesh(geo, mat);
    this._mesh.visible = false;

    this._light = new THREE.PointLight(options.color ?? 0x00ddff, 1.8, 8);
    this._mesh.add(this._light);
    scene.add(this._mesh);
  }

  start() {
    this._t = 0;
    this._active = true;
    this._mesh.visible = true;
  }

  stop() {
    this._active = false;
    this._mesh.visible = false;
  }

  tick(delta) {
    if (!this._active) return;
    this._t += delta / this._duration;
    if (this._t >= 1) {
      if (this._loop) {
        this._t -= 1;
      } else {
        this._t = 1;
        this.stop();
        return;
      }
    }
    this._mesh.position.copy(this._curve.getPoint(this._t));
  }

  dispose() {
    this.stop();
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
    this._scene.remove(this._mesh);
  }
}

// ── FloorCanvas ───────────────────────────────────────────────────────────────
// 2D canvas-based floor plan editor with drag-and-drop placement, snap-to-grid,
// click-to-select, drag-to-reposition, and right-click context menu.

class FloorCanvas {
  constructor(canvasEl, onSelectionChange) {
    this._canvas = canvasEl;
    this._ctx = canvasEl.getContext("2d");
    this._onSelectionChange = onSelectionChange;

    // Placements: rackId (string) → {x, z, orientation}
    this._placements = new Map();
    this._allRacks = [];
    this._selectedId = null;
    this._config = {
      width: 400,
      depth: 300,
      gridSnap: 12,
      snapEnabled: true,
      rackDepth: 40,
      unit: "in",
    };

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

  setRacks(allRacks) {
    this._allRacks = allRacks;
  }

  setPlacements(placements) {
    this._placements = new Map();
    for (const p of placements) {
      this._placements.set(String(p.rackId), {
        x: p.x,
        z: p.z,
        orientation: p.orientation || "N",
      });
    }
    this.render();
  }

  getPlacements() {
    return [...this._placements.entries()].map(([rackId, p]) => ({
      rackId: parseInt(rackId, 10) || rackId,
      x: p.x,
      z: p.z,
      orientation: p.orientation,
    }));
  }

  placeRack(rackId, x, z, orientation = "N") {
    this._placements.set(String(rackId), {
      x: this._snap(x),
      z: this._snap(z),
      orientation,
    });
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
    const order = ["N", "E", "S", "W"];
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

  isPlaced(rackId) {
    return this._placements.has(String(rackId));
  }

  render() {
    const { width, depth, gridSnap, unit } = this._config;
    const sc = this._scale;
    const cw = Math.max(1, Math.round(width * sc));
    const ch = Math.max(1, Math.round(depth * sc));

    this._canvas.width = cw;
    this._canvas.height = ch;

    const ctx = this._ctx;
    const isLight =
      (document.getElementById("rack3d-root")?.getAttribute("data-theme") ||
        "dark") === "light";

    // Floor background
    ctx.fillStyle = isLight ? "#dde4ef" : "#0d1018";
    ctx.fillRect(0, 0, cw, ch);

    // Grid lines
    ctx.strokeStyle = isLight ? "#c8d0e0" : "#1a2030";
    ctx.lineWidth = 0.5;
    const step = gridSnap * sc;
    if (step > 3) {
      for (let x = 0; x <= cw; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ch);
        ctx.stroke();
      }
      for (let z = 0; z <= ch; z += step) {
        ctx.beginPath();
        ctx.moveTo(0, z);
        ctx.lineTo(cw, z);
        ctx.stroke();
      }
    }

    // Grid number labels every 5 snaps (or fewer if large)
    const labelEvery = Math.max(
      gridSnap * 5,
      Math.ceil(50 / sc / gridSnap) * gridSnap,
    );
    const labelStep = labelEvery * sc;
    ctx.fillStyle = isLight ? "#8899aa" : "#3a4a5a";
    ctx.font = "9px monospace";
    if (labelStep > 20) {
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
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
    ctx.strokeStyle = isLight ? "#8899cc" : "#2a3a5a";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.75, 0.75, cw - 1.5, ch - 1.5);

    // Draw racks
    const rackW = 19 * sc;
    const rackD = this._config.rackDepth * sc;

    for (const [rackId, p] of this._placements) {
      const rack = this._allRacks.find((r) => String(r.id) === String(rackId));
      const px = p.x * sc;
      const pz = p.z * sc;
      const isSelected = String(rackId) === String(this._selectedId);

      ctx.save();
      ctx.translate(px, pz);
      ctx.rotate(this._orientRad(p.orientation));

      // Fill
      ctx.fillStyle = isSelected
        ? isLight
          ? "#93c5fd"
          : "#1a3a6a"
        : isLight
          ? "#c8daf5"
          : "#1e2d42";
      ctx.fillRect(-rackW / 2, -rackD / 2, rackW, rackD);

      // Border
      ctx.strokeStyle = isSelected
        ? "#4a9eff"
        : isLight
          ? "#7799cc"
          : "#2a4a6a";
      ctx.lineWidth = isSelected ? 2.5 : 1;
      ctx.strokeRect(-rackW / 2, -rackD / 2, rackW, rackD);

      // Front face indicator (thin bar at z = -rackD/2)
      ctx.fillStyle = isSelected ? "#4a9eff" : isLight ? "#4488cc" : "#3a6a9a";
      ctx.fillRect(-rackW / 2, -rackD / 2, rackW, Math.max(2, rackD * 0.08));

      // Orientation letter
      const fontSize = Math.max(8, Math.min(16, rackD * 0.35));
      ctx.fillStyle = isLight ? "#1a1a2e" : "#c9d1e0";
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(p.orientation, 0, rackD * 0.12);

      ctx.restore();

      // Rack name label (unrotated, above rack)
      if (rack) {
        const label =
          rack.name.length > 18 ? rack.name.slice(0, 17) + "…" : rack.name;
        ctx.fillStyle = isLight ? "#1a1a2e" : "#c9d1e0";
        ctx.font = "9px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(label, px, pz - rackD / 2 - 3);
      }
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _computeScale() {
    const MAX_PX = 1100;
    const byWidth = MAX_PX / (this._config.width || 1);
    const byDepth = MAX_PX / (this._config.depth || 1);
    this._scale = Math.min(
      Math.max(byWidth, byDepth, 0.5),
      4,
      Math.min(byWidth, byDepth) * 1.1,
    );
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
      const dx = px - cx,
        dz = pz - cz;
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
    const rack = this._allRacks.find(
      (r) => String(r.id) === String(this._selectedId),
    );
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
    canvas.addEventListener("click", (e) => {
      const [px, pz] = this._canvasPos(e);
      const id = this._rackAt(px, pz);
      this._selectedId = id || null;
      this.render();
      this._onSelectionChange(this._getSelected());
    });

    // Mousedown: start drag
    canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const [px, pz] = this._canvasPos(e);
      const id = this._rackAt(px, pz);
      if (!id) return;
      const p = this._placements.get(id);
      this._dragState = {
        rackId: id,
        startMouseX: px,
        startMouseZ: pz,
        startX: p.x,
        startZ: p.z,
      };
      this._selectedId = id;
      this.render();
      this._onSelectionChange(this._getSelected());
      e.preventDefault();
    });

    canvas.addEventListener("mousemove", (e) => {
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

    canvas.addEventListener("mouseup", () => {
      this._dragState = null;
    });
    canvas.addEventListener("mouseleave", () => {
      this._dragState = null;
    });

    // Right-click: show context menu
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const [px, pz] = this._canvasPos(e);
      const id = this._rackAt(px, pz);
      this._ctxMenuRackId = id;
      if (id) {
        this._selectedId = id;
        this.render();
        this._onSelectionChange(this._getSelected());
        const menu = document.getElementById("r3d-ctx-menu");
        menu.style.left = e.clientX + "px";
        menu.style.top = e.clientY + "px";
        menu.classList.remove("r3d-ctx-hidden");
      }
    });

    // Drag-and-drop from unplaced rack list
    canvas.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      canvas.classList.add("drag-over");
    });
    canvas.addEventListener("dragleave", () =>
      canvas.classList.remove("drag-over"),
    );
    canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      canvas.classList.remove("drag-over");
      const rackId = e.dataTransfer.getData("text/plain");
      if (!rackId) return;
      const [px, pz] = this._canvasPos(e);
      const sc = this._scale;
      const wx = this._snap(px / sc);
      const wz = this._snap(pz / sc);
      this._placements.set(String(rackId), { x: wx, z: wz, orientation: "N" });
      this._selectedId = String(rackId);
      this.render();
      this._onSelectionChange(this._getSelected());
    });
  }
}

// ── AppController ─────────────────────────────────────────────────────────────

class AppController {
  constructor() {
    this._viewport = document.getElementById("r3d-viewport");
    this._loading = document.getElementById("r3d-loading");
    this._empty = document.getElementById("r3d-empty");
    this._siteSel = document.getElementById("filter-site");
    this._rackSel = document.getElementById("filter-rack");
    this._configPanel = document.getElementById("r3d-config");
    this._layoutPanel = document.getElementById("r3d-layout-panel");
    this._infoPanel = document.getElementById("r3d-info");
    this._infoTitle = document.getElementById("r3d-info-title");
    this._infoBody = document.getElementById("r3d-info-body");
    this._root = document.getElementById("rack3d-root");
    this._themeBtn = document.getElementById("btn-theme-toggle");
    this._saveStatus = document.getElementById("r3d-save-status");

    this._allRacks = [];
    this._loadedRacks = {}; // rackId → rackData (cache)
    this._loadId = 0;
    this._currentData = null; // single-rack mode
    this._layoutMode = false;
    this._ctxCableData = null;
    this._sessionLoadState = this._restoreSessionState();
    this._sessionSaveTimer = null;

    /** @type {FloorCanvas|null} */
    this._canvas = null;

    this._restoreSettings();
    this._scene = new RackScene(this._viewport);
    this._scene.onCameraChanged(() => this._queueSessionSave());
    this._wireEvents();
    this._loadSitesAndRacks();
    this._initBarcodeScanner();
  }

  // ── Settings persistence ──────────────────────────────────────────────────

  _restoreSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}");
      // Default to light theme if no saved preference
      this._root.setAttribute("data-theme", s.theme || "light");
      if (s.scale)
        document
          .querySelector(`input[name="scale"][value="${s.scale}"]`)
          ?.click();
      if (s.depth)
        document
          .querySelector(`input[name="depth"][value="${s.depth}"]`)
          ?.click();
      if (s.labels)
        document
          .querySelector(`input[name="labels"][value="${s.labels}"]`)
          ?.click();
      if (s.colorby)
        document
          .querySelector(`input[name="colorby"][value="${s.colorby}"]`)
          ?.click();
      if (s.empty)
        document
          .querySelector(`input[name="empty"][value="${s.empty}"]`)
          ?.click();
      if (s.hoverTransparency)
        document
          .querySelector(
            `input[name="hover-transparency"][value="${s.hoverTransparency}"]`,
          )
          ?.click();
      if (s.showDoors !== undefined) {
        const el = document.getElementById("cfg-show-doors");
        if (el) el.checked = s.showDoors;
      }
      if (s.railFL) document.getElementById("cfg-rail-fl").value = s.railFL;
      if (s.railFR) document.getElementById("cfg-rail-fr").value = s.railFR;
      if (s.railRL) document.getElementById("cfg-rail-rl").value = s.railRL;
      if (s.railRR) document.getElementById("cfg-rail-rr").value = s.railRR;
      if (s.cablePatch !== undefined) {
        const el = document.getElementById("cfg-cable-patch");
        if (el) el.checked = s.cablePatch;
      }
      if (s.cableNetwork !== undefined) {
        const el = document.getElementById("cfg-cable-network");
        if (el) el.checked = s.cableNetwork;
      }
      if (s.cablePower !== undefined) {
        const el = document.getElementById("cfg-cable-power");
        if (el) el.checked = s.cablePower;
      }
      if (s.cableOpacity !== undefined) {
        const el = document.getElementById("cfg-cable-opacity");
        if (el) el.value = s.cableOpacity;
      }
      this._updateThemeBtn();
    } catch (_) {}
  }

  _saveSettings() {
    const s = this._settings();
    localStorage.setItem(
      LS_SETTINGS,
      JSON.stringify({
        theme: s.theme,
        scale: s.scale,
        depth: s.depth,
        labels: s.labels,
        colorby: s.colorBy,
        empty: s.showEmpty ? "yes" : "no",
        hoverTransparency: s.hoverTransparency,
        showDoors: s.showDoors,
        railFL: s.railFL,
        railFR: s.railFR,
        railRL: s.railRL,
        railRR: s.railRR,
        cablePatch: s.cableSettings.showPatch,
        cableNetwork: s.cableSettings.showNetwork,
        cablePower: s.cableSettings.showPower,
        cableOpacity: s.cableSettings.opacity,
      }),
    );
  }

  _restoreSessionState() {
    try {
      return JSON.parse(sessionStorage.getItem(SS_SESSION_VIEW) || "{}");
    } catch (_) {
      return {};
    }
  }

  _queueSessionSave() {
    clearTimeout(this._sessionSaveTimer);
    this._sessionSaveTimer = setTimeout(() => this._saveSessionState(), 150);
  }

  _saveSessionState() {
    try {
      const state = {
        siteId: this._siteSel?.value || "",
        rackId: this._layoutMode ? "" : this._rackSel?.value || "",
        layoutMode: !!this._layoutMode,
        camera: this._scene?.getCameraState?.() || null,
      };
      sessionStorage.setItem(SS_SESSION_VIEW, JSON.stringify(state));
    } catch (_) {}
  }

  _restoreCameraFromSession() {
    const camera = this._sessionLoadState?.camera;
    if (!camera) return;
    const restored = this._scene.setCameraState(camera);
    if (restored) {
      // Restore camera only once per page load.
      delete this._sessionLoadState.camera;
    }
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  _wireEvents() {
    // Site/rack selectors
    this._siteSel.addEventListener("change", () => {
      this._updateRackDropdown();
      const siteId = this._siteSel.value;
      if (siteId) this._autoLoadFloorPlan(siteId);
      this._queueSessionSave();
    });
    this._rackSel.addEventListener("change", () => {
      const id = this._rackSel.value;
      if (id) {
        this._layoutMode = false;
        this._loadRack(id);
      }
      this._queueSessionSave();
    });

    // Face toggle
    document.querySelectorAll(".r3d-face-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll(".r3d-face-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this._rebuildScene();
      });
    });

    // Camera controls
    document.getElementById("btn-reset-cam").addEventListener("click", () => {
      if (this._currentData)
        this._scene.resetCamera(this._currentData.rack, this._settings());
      else this._scene.fitView();
      this._queueSessionSave();
    });
    document.getElementById("btn-fit-rack").addEventListener("click", () => {
      this._scene.fitView();
      this._queueSessionSave();
    });

    // Config panel
    document
      .getElementById("btn-config-toggle")
      .addEventListener("click", () => {
        this._configPanel.classList.toggle("r3d-config-hidden");
      });
    document
      .getElementById("btn-config-close")
      .addEventListener("click", () => {
        this._configPanel.classList.add("r3d-config-hidden");
      });
    // Labels toggle: update visibility only — no scene rebuild needed
    this._configPanel
      .querySelectorAll('input[name="labels"]')
      .forEach((radio) => {
        radio.addEventListener("change", (e) => {
          this._scene.setLabelMode(e.target.value);
          this._saveSettings();
        });
      });
    this._configPanel.addEventListener("change", (e) => {
      // Skip labels — handled above without a rebuild
      if (e.target.name === "labels") return;
      this._rebuildScene();
      this._saveSettings();
    });

    // Theme
    document
      .getElementById("btn-theme-toggle")
      .addEventListener("click", () => this._toggleTheme());

    window.addEventListener("pagehide", () => this._saveSessionState());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this._saveSessionState();
    });

    // Layout panel open
    document
      .getElementById("btn-layout")
      .addEventListener("click", () => this._openLayoutPanel());
    document
      .getElementById("btn-layout-close")
      .addEventListener("click", () => this._closeLayoutPanel());
    document
      .getElementById("btn-layout-apply")
      .addEventListener("click", () => this._applyLayout());
    document
      .getElementById("btn-layout-save")
      .addEventListener("click", () => this._saveLayout());

    // Floor config inputs: re-render canvas on change
    [
      "cfg-floor-w",
      "cfg-floor-d",
      "cfg-grid-snap",
      "cfg-floor-unit",
      "cfg-snap-on",
      "cfg-rack-depth",
    ].forEach((id) => {
      document
        .getElementById(id)
        ?.addEventListener("change", () => this._syncCanvasConfig());
    });

    // Properties panel
    const propX = document.getElementById("prop-x");
    const propZ = document.getElementById("prop-z");
    const propOrient = document.getElementById("prop-orient");

    const onPropChange = () => {
      if (!this._canvas) return;
      this._canvas.updateSelected(propX.value, propZ.value, propOrient.value);
    };
    propX?.addEventListener("change", onPropChange);
    propZ?.addEventListener("change", onPropChange);
    propOrient?.addEventListener("change", onPropChange);

    document
      .getElementById("btn-prop-remove")
      ?.addEventListener("click", () => {
        if (this._canvas?._selectedId) {
          this._canvas.removeRack(this._canvas._selectedId);
          this._updateUnplacedList();
        }
      });

    // Context menu
    document.getElementById("r3d-ctx-menu").addEventListener("click", (e) => {
      const item = e.target.closest(".r3d-ctx-item");
      if (!item) return;
      const action = item.dataset.action;
      const id = this._canvas?._ctxMenuRackId;
      if (id) {
        if (action === "rotateCW") this._canvas.rotateRack(id, 1);
        if (action === "rotateCCW") this._canvas.rotateRack(id, -1);
        if (action === "remove") {
          this._canvas.removeRack(id);
          this._updateUnplacedList();
        }
      }
      document.getElementById("r3d-ctx-menu").classList.add("r3d-ctx-hidden");
    });

    // Dismiss context menus on any click outside
    document.addEventListener("click", () => {
      document.getElementById("r3d-ctx-menu").classList.add("r3d-ctx-hidden");
      document
        .getElementById("r3d-cable-ctx-menu")
        ?.classList.add("r3d-ctx-hidden");
    });

    // Device hover glow
    this._viewport.addEventListener("mousemove", (e) =>
      this._scene.hoverDevice(e),
    );

    // Device / cable picking in 3D viewport
    document.getElementById("btn-info-close").addEventListener("click", () => {
      this._scene.clearSelection();
      this._scene.stopTrace();
      this._hideInfo();
    });
    this._viewport.addEventListener("click", (e) => {
      // Try device first
      const dev = this._scene.selectDevice(e);
      if (dev) {
        this._showInfo(dev);
        return;
      }

      // Try cable
      const rect = this._viewport.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        ((e.clientY - rect.top) / rect.height) * -2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, this._scene._camera);
      const hits = raycaster.intersectObjects(
        this._scene.getCableMeshes(),
        false,
      );
      if (hits.length) {
        const cable = this._scene.selectCable(hits[0].object);
        if (cable) {
          this._showCableInfo(cable);
          return;
        }
      }
      this._hideInfo();
    });

    // Escape key: stop trace animation
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this._scene.stopTrace();
        this._scene.clearSelection();
        this._hideInfo();
      }
    });

    // Cable context menu actions
    const cableCtxMenu = document.getElementById("r3d-cable-ctx-menu");
    if (cableCtxMenu) {
      cableCtxMenu.addEventListener("click", (e) => {
        const item = e.target.closest(".r3d-ctx-item");
        if (!item) return;
        const action = item.dataset.action;
        const cable = this._ctxCableData;
        if (action === "traceSignal" && cable) this._traceSignal(cable);
        if (action === "openCable" && cable)
          window.open(`/dcim/cables/${cable.id}/`, "_blank");
        cableCtxMenu.classList.add("r3d-ctx-hidden");
      });
    }

    // 3D viewport right-click: cable context menu
    this._viewport.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const cableCtxMenu = document.getElementById("r3d-cable-ctx-menu");
      if (!cableCtxMenu) return;
      const rect = this._viewport.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        ((e.clientY - rect.top) / rect.height) * -2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(mouse, this._scene._camera);
      const hits = raycaster.intersectObjects(
        this._scene.getCableMeshes(),
        false,
      );
      if (hits.length) {
        this._ctxCableData = hits[0].object.userData.cableData;
        cableCtxMenu.style.left = e.clientX + "px";
        cableCtxMenu.style.top = e.clientY + "px";
        cableCtxMenu.classList.remove("r3d-ctx-hidden");
      }
    });

    // Cable settings toggles (no scene rebuild — just update material props)
    ["cfg-cable-patch", "cfg-cable-network", "cfg-cable-power"].forEach(
      (id) => {
        document.getElementById(id)?.addEventListener("change", () => {
          this._applyCableSettings();
          this._saveSettings();
        });
      },
    );
    document
      .getElementById("cfg-cable-opacity")
      ?.addEventListener("input", () => {
        this._applyCableSettings();
        this._saveSettings();
      });

    // Device filter search
    document.getElementById("r3d-search")?.addEventListener("input", (e) => {
      this._scene.filterDevices(e.target.value);
    });
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  async _loadSitesAndRacks() {
    try {
      const res = await fetch("/api/plugins/innovace-fibre/racks/");
      const data = await res.json();
      this._allRacks = data.racks || [];

      for (const site of data.sites || []) {
        const opt = document.createElement("option");
        opt.value = site.id;
        opt.textContent = site.name;
        this._siteSel.appendChild(opt);
      }

      this._updateRackDropdown();

      const savedSiteId = String(this._sessionLoadState?.siteId || "");
      const savedRackId = String(this._sessionLoadState?.rackId || "");
      const savedLayoutMode = !!this._sessionLoadState?.layoutMode;

      if (
        savedSiteId &&
        this._siteSel.querySelector(`option[value="${savedSiteId}"]`)
      ) {
        this._siteSel.value = savedSiteId;
        this._updateRackDropdown();
      }

      if (savedLayoutMode && this._siteSel.value) {
        await this._autoLoadFloorPlan(this._siteSel.value);
      }

      if (
        savedRackId &&
        this._rackSel.querySelector(`option[value="${savedRackId}"]`)
      ) {
        this._rackSel.value = savedRackId;
        this._layoutMode = false;
        await this._loadRack(savedRackId);
      } else {
        // Auto-load floor plan for the selected/first site when no saved rack is available.
        const selectedOrFirstSite =
          this._siteSel.value || String((data.sites || [])[0]?.id || "");
        if (selectedOrFirstSite) {
          this._siteSel.value = selectedOrFirstSite;
          this._updateRackDropdown();
          await this._autoLoadFloorPlan(selectedOrFirstSite);
        }
      }

      this._queueSessionSave();
    } catch (e) {
      console.error("Failed to load rack list:", e);
    }
  }

  _updateRackDropdown() {
    const siteId = this._siteSel.value;
    const racks = siteId
      ? this._allRacks.filter((r) => String(r.site_id) === siteId)
      : this._allRacks;
    this._rackSel.innerHTML = '<option value="">Select rack…</option>';
    for (const r of racks) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.site ? `${r.site} / ${r.name}` : r.name;
      this._rackSel.appendChild(opt);
    }
  }

  async _loadRack(rackId) {
    if (this._loadedRacks[rackId]) {
      this._currentData = this._loadedRacks[rackId];
      this._scene.load(this._currentData, this._settings());
      this._restoreCameraFromSession();
      this._showLoading(false);
      this._queueSessionSave();
      return;
    }
    const id = ++this._loadId;
    this._showLoading(true);
    this._hideInfo();
    try {
      const res = await fetch(
        `/api/plugins/innovace-fibre/racks/${rackId}/3d-data/`,
      );
      if (id !== this._loadId) return;
      const data = await res.json();
      this._loadedRacks[rackId] = data;
      this._currentData = data;
      this._scene.load(data, this._settings());
      this._restoreCameraFromSession();
      this._showLoading(false);
      this._queueSessionSave();
    } catch (e) {
      console.error("Rack 3D data load failed:", e);
      this._showLoading(false);
    }
  }

  async _fetchMissingRacks(rackIds) {
    const missing = rackIds.filter((id) => !this._loadedRacks[id]);
    await Promise.all(
      missing.map(async (id) => {
        try {
          const res = await fetch(
            `/api/plugins/innovace-fibre/racks/${id}/3d-data/`,
          );
          this._loadedRacks[id] = await res.json();
        } catch (e) {
          console.error(`Failed to load rack ${id}:`, e);
        }
      }),
    );
  }

  // ── Server layout persistence ─────────────────────────────────────────────

  async _autoLoadFloorPlan(siteId) {
    try {
      const res = await fetch(
        `/api/plugins/innovace-fibre/floor-plan/?site_id=${siteId}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      const cfg = data.config || {};
      if (!cfg.racks || !cfg.racks.length) return;

      // Populate floor config inputs
      if (cfg.floor) {
        if (cfg.floor.width)
          document.getElementById("cfg-floor-w").value = cfg.floor.width;
        if (cfg.floor.depth)
          document.getElementById("cfg-floor-d").value = cfg.floor.depth;
        if (cfg.floor.gridSnap)
          document.getElementById("cfg-grid-snap").value = cfg.floor.gridSnap;
        if (cfg.floor.unit)
          document.getElementById("cfg-floor-unit").value = cfg.floor.unit;
      }
      if (cfg.railFL != null)
        document.getElementById("cfg-rail-fl").value = cfg.railFL;
      if (cfg.railFR != null)
        document.getElementById("cfg-rail-fr").value = cfg.railFR;
      if (cfg.railRL != null)
        document.getElementById("cfg-rail-rl").value = cfg.railRL;
      if (cfg.railRR != null)
        document.getElementById("cfg-rail-rr").value = cfg.railRR;

      // Fetch rack data and render 3D
      const rackIds = cfg.racks.map((r) => r.rackId);
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
      this._restoreCameraFromSession();
      this._queueSessionSave();
    } catch (e) {
      console.error("Auto-load floor plan failed:", e);
    }
  }

  async _saveLayout() {
    const siteId = this._siteSel.value;
    if (!siteId) {
      this._showToast("Select a site first");
      return;
    }
    if (!this._canvas) return;

    const floor = {
      width: parseFloat(document.getElementById("cfg-floor-w").value) || 400,
      depth: parseFloat(document.getElementById("cfg-floor-d").value) || 300,
      gridSnap:
        parseFloat(document.getElementById("cfg-grid-snap").value) || 12,
      unit: document.getElementById("cfg-floor-unit").value || "in",
    };

    const config = {
      floor,
      racks: this._canvas.getPlacements(),
      railFL: parseFloat(document.getElementById("cfg-rail-fl").value) || 2,
      railFR: parseFloat(document.getElementById("cfg-rail-fr").value) || 2,
      railRL: parseFloat(document.getElementById("cfg-rail-rl").value) || 2,
      railRR: parseFloat(document.getElementById("cfg-rail-rr").value) || 2,
    };

    this._saveStatus.textContent = "Saving…";
    try {
      const res = await fetch("/api/plugins/innovace-fibre/floor-plan/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": getCsrfToken(),
        },
        body: JSON.stringify({ site_id: parseInt(siteId, 10), config }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this._saveStatus.textContent = "";
      this._showToast("Layout saved ✓");
    } catch (e) {
      this._saveStatus.textContent = "Save failed";
      console.error("Save layout failed:", e);
    }
  }

  // ── Layout panel ──────────────────────────────────────────────────────────

  _openLayoutPanel() {
    this._layoutPanel.classList.remove("r3d-layout-hidden");

    if (!this._canvas) {
      const canvasEl = document.getElementById("r3d-floor-canvas");
      this._canvas = new FloorCanvas(canvasEl, (sel) =>
        this._onCanvasSelection(sel),
      );
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
    this._layoutPanel.classList.add("r3d-layout-hidden");
  }

  async _applyLayout() {
    if (!this._canvas) return;
    const placements = this._canvas.getPlacements();
    if (!placements.length) {
      this._closeLayoutPanel();
      return;
    }

    this._closeLayoutPanel();
    this._showLoading(true);
    this._layoutMode = true;
    this._currentData = null;

    const rackIds = placements.map((p) => p.rackId);
    await this._fetchMissingRacks(rackIds);
    this._showLoading(false);

    const floor = {
      width: parseFloat(document.getElementById("cfg-floor-w").value) || 400,
      depth: parseFloat(document.getElementById("cfg-floor-d").value) || 300,
    };
    this._scene.loadLayout(placements, this._loadedRacks, {
      ...this._settings(),
      floorWidth: floor.width,
      floorDepth: floor.depth,
    });
    this._queueSessionSave();
  }

  async _loadCanvasFromServer(siteId) {
    try {
      const res = await fetch(
        `/api/plugins/innovace-fibre/floor-plan/?site_id=${siteId}`,
      );
      if (!res.ok) return;
      const data = await res.json();
      const cfg = data.config || {};
      if (cfg.floor) {
        if (cfg.floor.width)
          document.getElementById("cfg-floor-w").value = cfg.floor.width;
        if (cfg.floor.depth)
          document.getElementById("cfg-floor-d").value = cfg.floor.depth;
        if (cfg.floor.gridSnap)
          document.getElementById("cfg-grid-snap").value = cfg.floor.gridSnap;
        if (cfg.floor.unit)
          document.getElementById("cfg-floor-unit").value = cfg.floor.unit;
        this._syncCanvasConfig();
      }
      if (cfg.racks?.length) {
        this._canvas.setPlacements(cfg.racks);
        this._updateUnplacedList();
      }
    } catch (e) {
      console.error("Load canvas from server failed:", e);
    }
  }

  _syncCanvasConfig() {
    if (!this._canvas) return;
    this._canvas.setConfig({
      width: parseFloat(document.getElementById("cfg-floor-w").value) || 400,
      depth: parseFloat(document.getElementById("cfg-floor-d").value) || 300,
      gridSnap:
        parseFloat(document.getElementById("cfg-grid-snap").value) || 12,
      snapEnabled: document.getElementById("cfg-snap-on").checked,
      rackDepth:
        parseFloat(document.getElementById("cfg-rack-depth").value) || 40,
      unit: document.getElementById("cfg-floor-unit").value || "in",
    });
  }

  _updateUnplacedList() {
    const wrap = document.getElementById("r3d-unplaced-wrap");
    if (!wrap || !this._canvas) return;
    wrap.innerHTML = "";
    const siteId = this._siteSel.value;
    const racks = siteId
      ? this._allRacks.filter((r) => String(r.site_id) === siteId)
      : this._allRacks;
    for (const rack of racks) {
      const chip = document.createElement("div");
      chip.className = "r3d-unplaced-rack";
      chip.draggable = true;
      chip.textContent = rack.name;
      chip.title = rack.site ? `${rack.site} / ${rack.name}` : rack.name;
      if (this._canvas.isPlaced(rack.id)) {
        chip.style.opacity = "0.4";
        chip.draggable = false;
      }
      chip.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(rack.id));
        e.dataTransfer.effectAllowed = "copy";
        chip.classList.add("dragging");
      });
      chip.addEventListener("dragend", () => {
        chip.classList.remove("dragging");
        this._updateUnplacedList();
      });
      wrap.appendChild(chip);
    }
  }

  _onCanvasSelection(sel) {
    const propName = document.getElementById("prop-rack-name");
    const propX = document.getElementById("prop-x");
    const propZ = document.getElementById("prop-z");
    const propOrient = document.getElementById("prop-orient");
    const propsPanel = document.getElementById("r3d-rack-props");

    if (!sel) {
      propsPanel?.classList.add("r3d-props-hidden");
      return;
    }

    propsPanel?.classList.remove("r3d-props-hidden");
    if (propName) propName.textContent = sel.rack?.name || `Rack ${sel.rackId}`;
    if (propX) propX.value = sel.x;
    if (propZ) propZ.value = sel.z;
    if (propOrient) propOrient.value = sel.orientation;
  }

  // ── Theme ─────────────────────────────────────────────────────────────────

  _toggleTheme() {
    const current = this._root.getAttribute("data-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    this._root.setAttribute("data-theme", next);
    this._scene.setTheme(next);
    this._rebuildScene();
    this._updateThemeBtn();
    this._saveSettings();
    this._queueSessionSave();
    // Re-render canvas if open
    this._canvas?.render();
  }

  _updateThemeBtn() {
    const theme = this._root.getAttribute("data-theme") || "dark";
    this._themeBtn.textContent = theme === "dark" ? "☀" : "☾";
    this._themeBtn.title =
      theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }

  // ── Scene rebuild ─────────────────────────────────────────────────────────

  _rebuildScene() {
    const cameraState = this._scene.getCameraState();
    if (this._layoutMode && this._canvas) {
      const placements = this._canvas.getPlacements();
      if (placements.length) {
        const floor = {
          width:
            parseFloat(document.getElementById("cfg-floor-w").value) || 400,
          depth:
            parseFloat(document.getElementById("cfg-floor-d").value) || 300,
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
    this._scene.setCameraState(cameraState);
    this._queueSessionSave();
  }

  // ── Settings snapshot ─────────────────────────────────────────────────────

  _settings() {
    const theme = this._root.getAttribute("data-theme") || "dark";
    const cableSettings = {
      showPatch: document.getElementById("cfg-cable-patch")?.checked ?? true,
      showNetwork:
        document.getElementById("cfg-cable-network")?.checked ?? true,
      showPower: document.getElementById("cfg-cable-power")?.checked ?? false,
      opacity:
        parseFloat(document.getElementById("cfg-cable-opacity")?.value) || 1.0,
    };
    return {
      theme,
      scale:
        document.querySelector('input[name="scale"]:checked')?.value || "1",
      depth:
        document.querySelector('input[name="depth"]:checked')?.value ||
        "realistic",
      labels:
        document.querySelector('input[name="labels"]:checked')?.value || "auto",
      colorBy:
        document.querySelector('input[name="colorby"]:checked')?.value ||
        "image",
      showEmpty:
        document.querySelector('input[name="empty"]:checked')?.value === "yes",
      hoverTransparency:
        document.querySelector('input[name="hover-transparency"]:checked')
          ?.value || "doors",
      showDoors: document.getElementById("cfg-show-doors")?.checked ?? true,
      face:
        document.querySelector(".r3d-face-btn.active")?.dataset.face || "both",
      railFL: parseFloat(document.getElementById("cfg-rail-fl")?.value) || 2,
      railFR: parseFloat(document.getElementById("cfg-rail-fr")?.value) || 2,
      railRL: parseFloat(document.getElementById("cfg-rail-rl")?.value) || 2,
      railRR: parseFloat(document.getElementById("cfg-rail-rr")?.value) || 2,
      cableSettings,
    };
  }

  // ── Info panel ────────────────────────────────────────────────────────────

  _showInfo(dev) {
    this._infoTitle.textContent = dev.name;
    const statusColors = {
      active: "#22c55e",
      planned: "#3b82f6",
      staged: "#8b5cf6",
      failed: "#ef4444",
      decommissioning: "#f97316",
      inventory: "#6b7280",
      offline: "#9ca3af",
    };
    const statusColor = statusColors[dev.status] || "#6b7280";
    const statusBadge = dev.status
      ? `<span class="r3d-status-badge" style="background:${statusColor}">${dev.status}</span>`
      : "—";
    const positionText =
      dev.position !== null && dev.position !== undefined
        ? `U${dev.position}`
        : dev.bay_name
          ? `Bay ${dev.bay_name}${dev.parent_device_name ? ` (${dev.parent_device_name})` : ""}`
          : "—";
    const uHeightText =
      dev.u_height !== null && dev.u_height !== undefined
        ? `${dev.u_height}U`
        : "—";
    const faceText = dev.face || "—";
    const url = dev.url || "#";
    const signalTraceUrl = dev.id
      ? `/plugins/innovace-fibre/devices/${dev.id}/signal-trace/`
      : "#";
    const bayLayoutUrl = dev.id
      ? `/plugins/innovace-fibre/devices/${dev.id}/bay-layout/`
      : "#";

    this._infoBody.innerHTML = `
            <div class="r3d-info-row"><span class="r3d-info-lbl">Status</span><span class="r3d-info-val">${statusBadge}</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Type</span><span class="r3d-info-val">${dev.device_type || "—"}</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Maker</span><span class="r3d-info-val">${dev.manufacturer || "—"}</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Role</span><span class="r3d-info-val">${dev.role || "—"}</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Position</span><span class="r3d-info-val">${positionText}</span></div>
            <div class="r3d-info-row"><span class="r3d-info-lbl">Face</span><span class="r3d-info-val">${faceText} / ${uHeightText}${dev.is_full_depth ? " / full-depth" : ""}</span></div>
            ${dev.asset_tag ? `<div class="r3d-info-row"><span class="r3d-info-lbl">Asset tag</span><span class="r3d-info-val">${dev.asset_tag}</span></div>` : ""}
            ${dev.serial ? `<div class="r3d-info-row"><span class="r3d-info-lbl">Serial</span><span class="r3d-info-val">${dev.serial}</span></div>` : ""}
            <div class="r3d-info-actions">
                <a href="${url}" target="_blank" class="r3d-info-btn">Open in NetBox</a>
                <a href="${signalTraceUrl}" target="_blank" class="r3d-info-btn r3d-info-btn-accent">Signal Trace</a>
                <a href="${bayLayoutUrl}" target="_blank" class="r3d-info-btn">Bay Layout</a>
            </div>
            <details class="r3d-trace-details" id="r3d-trace-${dev.id}">
                <summary class="r3d-trace-summary">Internal Signal Paths</summary>
                <div class="r3d-trace-body">Loading…</div>
            </details>
        `;
    this._infoPanel.classList.remove("r3d-info-hidden");
    if (dev.device_type_id) this._loadSignalTrace(dev.device_type_id, dev.id);
  }

  async _loadSignalTrace(deviceTypeId, deviceId) {
    const detailsEl = document.getElementById(`r3d-trace-${deviceId}`);
    const bodyEl = detailsEl?.querySelector(".r3d-trace-body");
    if (!bodyEl) return;
    try {
      const res = await fetch(
        `/api/plugins/innovace-fibre/signal-routings/?device_type_id=${deviceTypeId}&limit=100`,
      );
      if (!res.ok) {
        bodyEl.textContent = "No routing data.";
        return;
      }
      const data = await res.json();
      const routes = data.results || [];
      if (!routes.length) {
        bodyEl.textContent = "No signal routings defined.";
        return;
      }
      bodyEl.innerHTML = routes
        .map(
          (r) =>
            `<div class="r3d-trace-row">
                    <span class="r3d-trace-port">${r.from_port_name}<sub>${r.from_signal}</sub></span>
                    <span class="r3d-trace-arrow">${r.bidirectional ? "↔" : "→"}</span>
                    <span class="r3d-trace-port">${r.to_port_name}<sub>${r.to_signal}</sub></span>
                </div>`,
        )
        .join("");
    } catch (_) {
      bodyEl.textContent = "Could not load routing data.";
    }
  }

  _hideInfo() {
    this._infoPanel.classList.add("r3d-info-hidden");
  }

  _applyCableSettings() {
    this._scene.applyCableSettings(this._settings().cableSettings);
  }

  _showCableInfo(cable) {
    const aTerms =
      (cable.a_terminations || [])
        .map((t) => `${t.port_name} (${t.port_type})`)
        .join(", ") || "—";
    const bTerms =
      (cable.b_terminations || [])
        .map((t) => `${t.port_name} (${t.port_type})`)
        .join(", ") || "—";
    const colorSwatch = cable.color
      ? `<span style="display:inline-block;width:12px;height:12px;background:#${cable.color};border-radius:2px;margin-right:4px;vertical-align:middle"></span>`
      : "";
    this._infoTitle.textContent = cable.label || `Cable #${cable.id}`;
    const bundleRows = cable.is_trunk_bundle
      ? `
        <div class="r3d-info-row"><span class="r3d-info-lbl">Bundled cables</span><span class="r3d-info-val">${cable.bundled_count || 0}</span></div>
        <div class="r3d-info-row"><span class="r3d-info-lbl">Bundle group</span><span class="r3d-info-val">${cable.trunk_group || "default"}</span></div>
      `
      : "";
    const actions = cable.is_trunk_bundle
      ? ""
      : `
        <div class="r3d-info-actions">
          <a href="/dcim/cables/${cable.id}/" target="_blank" class="r3d-info-btn">Open in NetBox</a>
          <button class="r3d-info-btn r3d-info-btn-accent" id="btn-trace-cable">Trace Signal</button>
        </div>
      `;
    this._infoBody.innerHTML = `
      <div class="r3d-info-row"><span class="r3d-info-lbl">Type</span><span class="r3d-info-val">${cable.type || "—"}</span></div>
      <div class="r3d-info-row"><span class="r3d-info-lbl">Color</span><span class="r3d-info-val">${colorSwatch}${cable.color ? "#" + cable.color : "—"}</span></div>
      ${bundleRows}
      <div class="r3d-info-row"><span class="r3d-info-lbl">End A</span><span class="r3d-info-val">${aTerms}</span></div>
      <div class="r3d-info-row"><span class="r3d-info-lbl">End B</span><span class="r3d-info-val">${bTerms}</span></div>
      ${actions}
    `;
    this._infoPanel.classList.remove("r3d-info-hidden");
    document
      .getElementById("btn-trace-cable")
      ?.addEventListener("click", () => {
        this._traceSignal(cable);
      });
  }

  async _traceSignal(cable) {
    const isFibre =
      typeof cable.type === "string" &&
      [
        "smf",
        "smf-os1",
        "smf-os2",
        "mmf",
        "mmf-om1",
        "mmf-om2",
        "mmf-om3",
        "mmf-om4",
        "mmf-om5",
        "aoc",
      ].includes(cable.type);

    if (!isFibre) {
      // Non-fibre: animate the cable's own curve directly
      this._scene.startTrace(cable.id);
      return;
    }

    // Fibre: fetch signal trace to build multi-hop merged curve
    const term = (cable.a_terminations || [])[0];
    if (!term) {
      this._scene.startTrace(cable.id);
      return;
    }

    try {
      const res = await fetch(
        `/api/plugins/innovace-fibre/trace/device/${term.device_id}/` +
          `?port=${encodeURIComponent(term.port_name)}&signal=1`,
      );
      if (!res.ok) {
        this._scene.startTrace(cable.id);
        return;
      }
      const data = await res.json();

      // Collect hops: each hop has {from_device_id, from_port, to_device_id, to_port}
      const hops = (data.paths || [data]).flat ? [data].flat() : [];
      const allCables = this._currentData?.cables || [];

      // Match each hop to a cable by checking termination device+port overlap
      const curves = [];
      for (const hop of hops) {
        const matched = allCables.find((c) => {
          const aMatch = (c.a_terminations || []).some(
            (t) =>
              t.device_id === hop.from_device_id &&
              t.port_name === hop.from_port,
          );
          const bMatch = (c.b_terminations || []).some(
            (t) =>
              t.device_id === hop.to_device_id && t.port_name === hop.to_port,
          );
          return aMatch && bMatch;
        });
        if (matched) {
          const mesh = this._scene
            .getCableMeshes()
            .find((m) => m.userData?.cableId === matched.id);
          if (mesh?.userData?.curve) curves.push(mesh.userData.curve);
        }
      }

      if (curves.length === 0) {
        this._scene.startTrace(cable.id);
        return;
      }
      if (curves.length === 1) {
        this._scene.startTraceOnCurve(curves[0], { loop: true });
        return;
      }

      // Merge all curve points into one continuous curve
      const allPts = curves.flatMap((c) => c.getPoints(20));
      const merged = new THREE.CatmullRomCurve3(
        allPts,
        false,
        "catmullrom",
        0.5,
      );
      this._scene.startTraceOnCurve(merged, { color: 0x00aaff, loop: true });
    } catch (_) {
      // Fallback: just animate the individual cable
      this._scene.startTrace(cable.id);
    }
  }

  // ── Barcode scanner integration ───────────────────────────────────────────

  _initBarcodeScanner() {
    this._barcodeScanner = new BarcodeScanner({
      onDeviceMatch: (data) => this._handleBarcodeDeviceMatch(data),
      onCableMatch: (data) => this._handleBarcodeCableMatch(data),
    });
  }

  async _handleBarcodeDeviceMatch(data) {
    const deviceId = data.id;
    const rackId = data.rack?.id;
    const parentDev = data.parent_device;

    if (this._layoutMode) {
      // Floor-plan mode: fly camera to the rack object, then highlight
      const highlighted = this._scene.highlightDeviceById(deviceId);
      if (!highlighted && rackId) {
        await this._fetchMissingRacks([rackId]);
        // Re-render layout with current placements to include this rack's data
        const placements = this._canvas ? this._canvas.getPlacements() : [];
        if (placements.length) {
          this._scene.loadLayout(placements, this._loadedRacks, {
            ...this._settings(),
            floorWidth:
              parseFloat(document.getElementById("cfg-floor-w")?.value) || 400,
            floorDepth:
              parseFloat(document.getElementById("cfg-floor-d")?.value) || 300,
          });
        }
        this._scene.highlightDeviceById(deviceId);
      }
      BarcodeScanner.showToast(
        `Found: ${data.name} — ${data.rack?.name || ""}`,
        "success",
      );
      return;
    }

    // Single-rack mode
    const currentRackId = this._currentData?.rack?.id;
    if (rackId && rackId !== currentRackId) {
      // Switch to the rack containing this device
      this._rackSel.value = rackId;
      await this._loadRack(rackId);
    }

    if (parentDev) {
      this._scene.highlightEnclosureAndBay(parentDev.id, parentDev.bay);
      BarcodeScanner.showToast(
        `Found: ${data.name} in ${parentDev.name} / ${parentDev.bay}`,
        "success",
      );
    } else {
      const mesh = this._scene.highlightDeviceById(deviceId);
      if (!mesh) {
        BarcodeScanner.showToast(
          `Device "${data.name}" not visible in current rack`,
          "warning",
        );
        return;
      }
      BarcodeScanner.showToast(
        `Found: ${data.name} — U${data.rack_unit || "?"} in ${data.rack?.name || ""}`,
        "success",
      );
    }

    // Show device info panel
    const devData = this._scene._deviceMeshes.find(
      (m) => m.userData.deviceId === deviceId,
    )?.userData.deviceData;
    if (devData) this._showInfo(devData);
  }

  _handleBarcodeCableMatch(data) {
    const cableId = data.id;

    // Select (highlight) the cable mesh
    const entry = this._scene._cableManager._entries?.find(
      (e) => e.cableData?.id === cableId,
    );
    if (entry) this._scene._cableManager.selectCable(entry.mesh);

    const label = data.label ? ` "${data.label}"` : "";
    if (data.signals.length <= 1) {
      this._scene.startTrace(cableId);
      BarcodeScanner.showToast(`Tracing cable #${cableId}${label}`, "success");
    } else {
      BarcodeScanner.showToast(
        `Cable #${cableId}${label} — select signals to trace`,
        "info",
      );
      showSignalModal(data, (selectedSignals) => {
        // Each signal triggers the full trace animation on this cable
        this._scene.startTrace(cableId);
      });
    }
  }

  _showLoading(on) {
    this._loading.style.display = on ? "flex" : "none";
    this._empty.style.display =
      on || this._currentData || this._layoutMode ? "none" : "";
  }

  _showToast(msg) {
    const t = document.getElementById("r3d-save-toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("visible");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove("visible"), 2500);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => new AppController());
