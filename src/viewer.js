import * as THREE from "three";
import Menu from "lucide/dist/esm/icons/menu.js";
import Pen from "lucide/dist/esm/icons/pen.js";
import Rotate3d from "lucide/dist/esm/icons/rotate-3d.js";
import Scan from "lucide/dist/esm/icons/scan.js";
import { TubePainter } from "three/examples/jsm/misc/TubePainter.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  applyScenePayloadIncremental,
  disposeSceneGeometrySubtree,
  matrix4FromArray,
  mergeScenePayloads,
  mergeScenePayloadsForViewerPoll,
  mergeScenePayloadsWithRemovals,
  nodeIdFromPayload,
  sceneNodeIdFromObject3D,
  serializeStrokesGroup,
  strokeWidthFromPressure,
} from "./shared/sceneCodec.js";
import { normalizeRoomCode } from "./shared/roomCode.js";
import {
  defaultPresenceLabel,
  getOrCreateDeviceId,
  getShowOthersPreference,
  pruneStalePresencePeers,
  setPresenceTargetsFromPayload,
  setShowOthersPreference,
  smoothPresencePeers,
} from "./shared/sketcharPresence.js";
import {
  fetchRoomBySlug,
  getSketcharSupabase,
  isSketcharConfigured,
  subscribeRoom,
  upsertPin,
  upsertSnapshot,
} from "./shared/sketcharSupabase.js";

/**
 * Lucide ESM icon → SVG element (viewBox 24×24).
 * @param {unknown} icon
 */
function lucideIconToSvg(icon) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const item of icon) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [tag, attrs] = item;
    if (tag === "path" && attrs && attrs.d) {
      const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", attrs.d);
      svg.appendChild(p);
    }
  }
  return svg;
}

function newStrokeSyncId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

const canvas = document.getElementById("c");
const elRoom = document.getElementById("room");
const elStatus = document.getElementById("status");
const btnAr = document.getElementById("btn-ar");
const btnPinPhone = document.getElementById("btn-pin-phone");
const elStylusDrawWrap = document.getElementById("stylus-draw-wrap");
const btnStylusDraw = document.getElementById("btn-stylus-draw");
const elStylusFabIcon = document.querySelector("#btn-stylus-draw .stylus-fab-icon");
if (elStylusFabIcon) elStylusFabIcon.appendChild(lucideIconToSvg(Pen));

const elSelectModeWrap = document.getElementById("select-mode-wrap");
const btnSelectMode = document.getElementById("btn-select-mode");
const elSelectFabIcon = document.querySelector("#btn-select-mode .select-fab-icon");
const elSelectionRectOverlay = document.getElementById("selection-rect-overlay");
const elMultiSelectToolbar = document.getElementById("multi-select-toolbar");
const btnDeleteSelection = document.getElementById("btn-delete-selection");
if (elSelectFabIcon) elSelectFabIcon.appendChild(lucideIconToSvg(Scan));

const elAxisViewWrap = document.getElementById("axis-view-wrap");
const btnAxisX = document.getElementById("btn-axis-view-x");
const btnAxisY = document.getElementById("btn-axis-view-y");
const btnAxisZ = document.getElementById("btn-axis-view-z");
const elAutoOrbitWrap = document.getElementById("auto-orbit-wrap");
const btnAutoOrbit = document.getElementById("btn-auto-orbit");
const elAutoOrbitFabIcon = document.querySelector("#btn-auto-orbit .auto-orbit-fab-icon");
if (elAutoOrbitFabIcon) elAutoOrbitFabIcon.appendChild(lucideIconToSvg(Rotate3d));

const btnMenuToggle = document.getElementById("btn-menu-toggle");
const elSettingsPanel = document.getElementById("settings-panel");
const elMenuBackdrop = document.getElementById("menu-backdrop");
const elMenuToggleIcon = document.querySelector("#btn-menu-toggle .btn-menu-toggle-icon");
if (elMenuToggleIcon) elMenuToggleIcon.appendChild(lucideIconToSvg(Menu));

function setSettingsMenuOpen(open) {
  if (!btnMenuToggle || !elSettingsPanel) return;
  btnMenuToggle.setAttribute("aria-expanded", open ? "true" : "false");
  elSettingsPanel.classList.toggle("is-open", open);
  if (elMenuBackdrop) {
    if (open) {
      elMenuBackdrop.hidden = false;
      elMenuBackdrop.setAttribute("aria-hidden", "false");
    } else {
      elMenuBackdrop.hidden = true;
      elMenuBackdrop.setAttribute("aria-hidden", "true");
    }
  }
}

function toggleSettingsMenu() {
  const open = btnMenuToggle?.getAttribute("aria-expanded") === "true";
  setSettingsMenuOpen(!open);
}

btnMenuToggle?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSettingsMenu();
});

elMenuBackdrop?.addEventListener("click", () => setSettingsMenuOpen(false));

const params = new URLSearchParams(location.search);
if (params.get("room")) elRoom.value = normalizeRoomCode(params.get("room"));

const modeParam = params.get("mode");
if (modeParam === "ar" || modeParam === "align" || modeParam === "2d") {
  const r = document.querySelector(`input[name="mode"][value="${modeParam}"]`);
  if (r) r.checked = true;
}

function setStatus(msg, cls) {
  elStatus.textContent = msg;
  elStatus.className = "status status-bar" + (cls ? ` ${cls}` : "");
}

function isIosWebKit() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isAndroid() {
  return /Android/i.test(navigator.userAgent);
}

function webXrUnavailableMessage() {
  if (!window.isSecureContext) {
    return "WebXR needs HTTPS (or localhost), not plain http:// to a LAN IP.";
  }
  if (isIosWebKit()) {
    return "AR mode needs WebXR; iPhone/iPad browsers don’t expose it yet. Use an Android phone with Chrome for AR in-browser, or 3D orbit here.";
  }
  if (isAndroid()) {
    return "WebXR unavailable — try updated Chrome, ARCore, and HTTPS.";
  }
  return "WebXR unavailable here. Try Chrome on a supported Android phone.";
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1e28);

const camera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / window.innerHeight,
  0.01,
  200,
);
camera.position.set(1.75, 1.15, 1.75);

/** Phones: lower GPU load (recent viewer changes + poll merge made crashes more likely on low-memory devices). */
const isMobileViewer =
  typeof window !== "undefined" &&
  (window.matchMedia?.("(max-width: 768px)")?.matches === true ||
    /Android|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: !isMobileViewer,
  alpha: false,
  powerPreference: "default",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobileViewer ? 1.25 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x1a1e28, 1);
/* iPhone Safari: initializing the WebXR stack with xr.enabled=true is a common crash/OOM source; orbit + drawing don't need it (AR is unsupported on iOS anyway). */
const viewerIosPhone = /iPhone|iPod/i.test(navigator.userAgent || "");
renderer.xr.enabled = !viewerIosPhone;

canvas.addEventListener(
  "webglcontextlost",
  (ev) => {
    try {
      ev.preventDefault();
    } catch (_) {
      /* ignore */
    }
    renderer.setAnimationLoop(null);
    setStatus("WebGL lost — reload the page.", "err");
  },
  false,
);

const material = new THREE.MeshNormalMaterial({
  flatShading: true,
  side: THREE.DoubleSide,
});

const alignmentGroup = new THREE.Group();
const contentGroup = new THREE.Group();
alignmentGroup.add(contentGroup);
scene.add(alignmentGroup);

const remotePresenceGroup = new THREE.Group();
remotePresenceGroup.name = "remote-presence";
remotePresenceGroup.renderOrder = 1000;
contentGroup.add(remotePresenceGroup);
/** @type {Map<string, THREE.Group>} */
const viewerRemotePeers = new Map();
let viewerLastPresenceSmoothMs = performance.now();
const viewerDeviceId = getOrCreateDeviceId();
let viewerShowOthers = getShowOthersPreference();
/** @type {{ unsubscribe: () => void, sendPresence: (p: import("./shared/sketcharPresence.js").SketcharPresencePayload) => void } | null} */
let viewerRoomRealtime = null;
let lastViewerPresenceSendMs = 0;
const VIEWER_PRESENCE_SEND_MS = 120;
const _vCamPosW = new THREE.Vector3();
const _vCamQuatW = new THREE.Quaternion();
const _vParentInv = new THREE.Quaternion();
const _vCamLocalPos = new THREE.Vector3();
const _vCamLocalQuat = new THREE.Quaternion();
const _presenceSizeScratch = new THREE.Vector3();
const _presenceStrokeBounds = new THREE.Box3();

/** Ground plane grid at y=0 — sketch is framed so its bottom sits on the floor; origin is 0,0,0. */
const GRID_SIZE = 8;
const gridDivisions = isMobileViewer ? 20 : 40;
const gridHelper = new THREE.GridHelper(
  GRID_SIZE,
  gridDivisions,
  0x4a5568,
  0x2d3748,
);
gridHelper.position.y = 0;
gridHelper.name = "viewer-ground-grid";
scene.add(gridHelper);

scene.add(new THREE.HemisphereLight(0x8899aa, 0x445566, 2.5));
const dl = new THREE.DirectionalLight(0xffffff, 1.2);
dl.position.set(2, 6, 3);
scene.add(dl);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0);
controls.minDistance = 0.15;
controls.maxDistance = 80;
controls.update();

/** OrbitControls `autoRotateSpeed` scale when auto-orbit is on (lower = slower; default Three.js is 2). */
const AUTO_ORBIT_SPEED = 0.55;

function setAutoOrbitUi(on) {
  if (!btnAutoOrbit) return;
  btnAutoOrbit.classList.toggle("active", on);
  btnAutoOrbit.setAttribute("aria-pressed", on ? "true" : "false");
}

function disableAutoOrbit() {
  controls.autoRotate = false;
  setAutoOrbitUi(false);
}

/** @type {null | "X" | "Y" | "Z"} — set before syncOrbitWithGizmo (touch pan rule for Y plan). */
let axisViewActive = null;

const raycaster = new THREE.Raycaster();
raycaster.params.Line = { threshold: 0.12 };
const pointerNdc = new THREE.Vector2();
/** World-space plane for stylus: normal = camera forward through orbit target (frozen when draw mode turns on). */
const _drawPlaneWorld = new THREE.Plane();
const _fwdWorld = new THREE.Vector3();
const _axisPlaneNorm = new THREE.Vector3();
const _hitWorld = new THREE.Vector3();
let stylusDrawPlaneReady = false;

let stylusDrawMode = false;
let stylusDrawActive = false;
/** @type {number} */
let stylusPointerId = -1;
/** @type {THREE.Vector3[]} */
let stylusPoints = [];
let stylusPressureSum = 0;
let stylusPressureCount = 0;
/** Live stroke preview while dragging; finalized mesh stays in scene after stroke end. */
let stylusPreviewPainter = null;
/** Skip poll deserialize while POSTing a stroke so the server cannot briefly overwrite the local line. */
let viewerStrokePosting = false;
/** Serialize viewer POSTs so rapid strokes don't GET a stale remote and drop prior strokes from the payload. */
let viewerSnapshotPostChain = Promise.resolve();
/** Stroke syncIds from this viewer not yet confirmed by a successful POST (see mergeScenePayloadsForViewerPoll). */
const viewerPendingSyncIds = new Set();
const _orbitBox = new THREE.Box3();
/** Preview strokes (viewer only): shorter segments + interpolation between sparse pointer events for smoother tubes. */
const VIEWER_STROKE_MIN_SEGMENT = 0.0024;
const VIEWER_STROKE_MAX_INSERTS_PER_MOVE = 40;
const _stylusLerp = new THREE.Vector3();
const _orbitCenter = new THREE.Vector3();
/** First snapshot in a room: center content on floor. Later Quest updates only replace geometry — never re-frame so camera/orbit stay put. */
let viewerDidInitialFraming = false;

const transformControl = new TransformControls(camera, canvas);
transformControl.setMode("translate");
transformControl.setSpace("world");
transformControl.setSize(0.85);
transformControl.addEventListener("dragging-changed", (event) => {
  /* While dragging the gizmo, disable OrbitControls entirely so touch/mouse goes to TransformControls. */
  controls.enabled = !event.value;
});
scene.add(transformControl);

transformControl.addEventListener("objectChange", () => {
  if (transformControl.object != null) {
    applySelectionOrbitTarget(transformControl.object);
  }
});

function isCoarsePointer() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/**
 * `transformControl.object` is `undefined` when detached — use `!= null`, not `!== null`
 * (`undefined !== null` is true and would wrongly treat “no selection” as “has selection”).
 *
 * Desktop + selection: full orbit + WASD; TransformControls wins on gizmo handles.
 * Touch + selection: disable one-finger orbit/pan so drags move the gizmo; pinch zoom still works.
 * Y-axis plan view: keep pan enabled on touch so the scene can be panned on the floor plane.
 */
function syncOrbitWithGizmo() {
  const has = transformControl.object != null;
  if (!has) {
    controls.enableRotate = true;
    controls.enablePan = true;
    controls.enableZoom = true;
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
    return;
  }
  controls.enableZoom = true;
  if (isCoarsePointer()) {
    controls.enableRotate = false;
    controls.enablePan = axisViewActive === "Y";
  } else {
    controls.enableRotate = true;
    controls.enablePan = true;
    controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
  }
}
syncOrbitWithGizmo();

const keys = {
  forward: false,
  back: false,
  left: false,
  right: false,
  up: false,
  down: false,
};
const WASD_SPEED = 0.045;
const _moveFwd = new THREE.Vector3();
const _moveRight = new THREE.Vector3();
const _wasdDelta = new THREE.Vector3();

function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const t = el.tagName.toLowerCase();
  return t === "input" || t === "textarea" || t === "select" || el.isContentEditable;
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !isTypingTarget(e.target)) {
    if (btnMenuToggle?.getAttribute("aria-expanded") === "true") {
      setSettingsMenuOpen(false);
      e.preventDefault();
      return;
    }
    if (rectSelectDrag.active) {
      rectSelectDrag.active = false;
      if (elSelectionRectOverlay) elSelectionRectOverlay.hidden = true;
      controls.enabled = true;
      e.preventDefault();
      return;
    }
    if (multiSelectedRoots.size > 0) {
      clearMultiSelection();
      e.preventDefault();
      return;
    }
    if (stylusDrawActive) {
      cancelStylusDraw();
      return;
    }
    detachTransformKeepOrbitTarget();
    return;
  }
  if (isTypingTarget(e.target)) return;
  if (renderer.xr.isPresenting) return;
  if (transformControl.object) {
    if (e.key === "t" || e.key === "T") {
      transformControl.setMode("translate");
      transformControl.setSpace("world");
      e.preventDefault();
      return;
    }
    if (e.key === "r" || e.key === "R") {
      transformControl.setMode("rotate");
      transformControl.setSpace("world");
      e.preventDefault();
      return;
    }
  }
  switch (e.code) {
    case "KeyW":
      keys.forward = true;
      e.preventDefault();
      break;
    case "KeyS":
      keys.back = true;
      e.preventDefault();
      break;
    case "KeyA":
      keys.left = true;
      e.preventDefault();
      break;
    case "KeyD":
      keys.right = true;
      e.preventDefault();
      break;
    case "KeyQ":
      keys.up = true;
      e.preventDefault();
      break;
    case "KeyE":
      keys.down = true;
      e.preventDefault();
      break;
    default:
      break;
  }
});

window.addEventListener("keyup", (e) => {
  switch (e.code) {
    case "KeyW":
      keys.forward = false;
      break;
    case "KeyS":
      keys.back = false;
      break;
    case "KeyA":
      keys.left = false;
      break;
    case "KeyD":
      keys.right = false;
      break;
    case "KeyQ":
      keys.up = false;
      break;
    case "KeyE":
      keys.down = false;
      break;
    default:
      break;
  }
});

function applyWasdMovement() {
  if (renderer.xr.isPresenting) return;
  if (getViewMode() !== "2d" && getViewMode() !== "align") return;
  if (
    !keys.forward &&
    !keys.back &&
    !keys.left &&
    !keys.right &&
    !keys.up &&
    !keys.down
  ) {
    return;
  }
  camera.getWorldDirection(_moveFwd);
  _moveFwd.y = 0;
  if (_moveFwd.lengthSq() < 1e-8) return;
  _moveFwd.normalize();
  _moveRight.crossVectors(_moveFwd, camera.up).normalize();

  _wasdDelta.set(0, 0, 0);
  if (keys.forward) _wasdDelta.addScaledVector(_moveFwd, WASD_SPEED);
  if (keys.back) _wasdDelta.addScaledVector(_moveFwd, -WASD_SPEED);
  if (keys.left) _wasdDelta.addScaledVector(_moveRight, -WASD_SPEED);
  if (keys.right) _wasdDelta.addScaledVector(_moveRight, WASD_SPEED);
  if (keys.up) _wasdDelta.y += WASD_SPEED;
  if (keys.down) _wasdDelta.y -= WASD_SPEED;

  camera.position.add(_wasdDelta);
  controls.target.add(_wasdDelta);
}

/**
 * Gizmo at mesh origin is wrong for InstancedMesh (instances use matrices) and some tubes.
 * Put a pivot at the selection's bounding-box center and attach the gizmo to that.
 */
function attachTransformToSelection(root) {
  detachTransformKeepOrbitTarget();
  if (!root || !root.parent) return;

  if (root.userData.skViewerPivot) {
    transformControl.attach(root);
    syncOrbitWithGizmo();
    applySelectionOrbitTarget(transformControl.object);
    if (axisViewActive) applyAxisView(axisViewActive);
    return;
  }
  if (root.parent?.userData?.skViewerPivot) {
    transformControl.attach(root.parent);
    syncOrbitWithGizmo();
    applySelectionOrbitTarget(transformControl.object);
    if (axisViewActive) applyAxisView(axisViewActive);
    return;
  }

  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    transformControl.attach(root);
    syncOrbitWithGizmo();
    applySelectionOrbitTarget(transformControl.object);
    if (axisViewActive) applyAxisView(axisViewActive);
    return;
  }

  const center = new THREE.Vector3();
  box.getCenter(center);
  const parent = root.parent;
  const pivot = new THREE.Group();
  pivot.userData.skViewerPivot = true;
  const lc = center.clone();
  parent.worldToLocal(lc);
  pivot.position.copy(lc);
  parent.add(pivot);
  pivot.attach(root);
  transformControl.attach(pivot);
  syncOrbitWithGizmo();
  if (transformControl.object) applySelectionOrbitTarget(transformControl.object);
  if (axisViewActive) applyAxisView(axisViewActive);
}

function detachTransformClean() {
  const attached = transformControl.object;
  transformControl.detach();
  if (attached && attached.userData && attached.userData.skViewerPivot) {
    const parent = attached.parent;
    if (parent) {
      while (attached.children.length) {
        const ch = attached.children[0];
        parent.attach(ch);
      }
      parent.remove(attached);
    }
  }
  controls.target.set(0, 0, 0);
  transformControl.visible = false;
  syncOrbitWithGizmo();
}

/** Detach gizmo without resetting orbit target — avoids snapping the camera toward the origin. */
function detachTransformKeepOrbitTarget() {
  const attached = transformControl.object;
  transformControl.detach();
  if (attached && attached.userData && attached.userData.skViewerPivot) {
    const parent = attached.parent;
    if (parent) {
      while (attached.children.length) {
        const ch = attached.children[0];
        parent.attach(ch);
      }
      parent.remove(attached);
    }
  }
  transformControl.visible = false;
  syncOrbitWithGizmo();
}

/** Orbit pivots around the selected object’s bounds center (world). */
function applySelectionOrbitTarget(object3d) {
  _orbitBox.setFromObject(object3d);
  if (!_orbitBox.isEmpty()) {
    _orbitBox.getCenter(_orbitCenter);
    controls.target.copy(_orbitCenter);
  }
}

const arRig = new THREE.Group();
arRig.position.set(0, 0, -1.35);

let lastSnapshotKey = "";
let pollBusy = false;
/** @type {string} */
let viewerRoomId = "";

/**
 * Cheap content fingerprint when `snapshotUpdatedAt` is missing — never JSON.stringify
 * the full snapshot (large scenes OOM / freeze Safari & Chrome on phones every ~320ms poll).
 */
function snapshotContentFingerprint(snapshot) {
  if (!snapshot || snapshot.v !== 1 || !Array.isArray(snapshot.nodes)) {
    return "empty";
  }
  const nodes = snapshot.nodes;
  let h = 2166136261;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || typeof n !== "object") continue;
    const id = typeof n.id === "string" ? n.id : "";
    const t = n.t || "";
    h ^= id.length * 73856093 + t.length * 19349663;
    const pts = n.points;
    if (Array.isArray(pts)) {
      h ^= pts.length * 83492791;
      const p0 = pts[0];
      const pL = pts[pts.length - 1];
      if (p0 && Array.isArray(p0) && p0.length >= 3) {
        h ^=
          (Math.round(p0[0] * 1e4) ^ Math.round(p0[1] * 1e4) ^ Math.round(p0[2] * 1e4)) |
          0;
      }
      if (pL && pL !== p0 && Array.isArray(pL) && pL.length >= 3) {
        h ^=
          (Math.round(pL[0] * 1e4) ^ Math.round(pL[1] * 1e4) ^ Math.round(pL[2] * 1e4)) |
          0;
      }
    }
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) | 0;
  }
  return `${nodes.length}|${(h >>> 0).toString(16)}`;
}

/** Prefer server timestamps; fallback must stay tiny for mobile browsers. */
function getSnapshotChangeKey(data) {
  const snapAt = data.snapshotUpdatedAt;
  const snapAtStr =
    snapAt != null && snapAt !== ""
      ? typeof snapAt === "string"
        ? snapAt
        : String(snapAt)
      : "";
  const al = data.alignment ?? null;
  const alTime = al?.updatedAt ?? "";
  let alMat = "";
  if (al && al.matrix != null) {
    const m = al.matrix;
    if (typeof m === "string") alMat = m;
    else if (Array.isArray(m)) alMat = m.join(",");
    else if (m && typeof m === "object" && Array.isArray(m.elements))
      alMat = m.elements.join(",");
    else alMat = JSON.stringify(m);
  }
  if (snapAtStr !== "") {
    return `${snapAtStr}|${alTime}|${alMat}`;
  }
  const alKey =
    al == null
      ? "noal"
      : `${alTime}|${alMat.length}|${alMat.slice(0, 64)}`;
  return `legacy|${snapshotContentFingerprint(data.snapshot)}|${alKey}`;
}

function getViewMode() {
  return document.querySelector('input[name="mode"]:checked')?.value || "2d";
}

const _savedCamPos = new THREE.Vector3();
const _savedCamQuat = new THREE.Quaternion();
const _savedCamUp = new THREE.Vector3();
const _savedOrbitTarget = new THREE.Vector3();
let axisSavedStateCaptured = false;

const ORBIT_LOCK_EPS = 0.002;

function clearAxisOrbitConstraints() {
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;
  controls.minAzimuthAngle = -Infinity;
  controls.maxAzimuthAngle = Infinity;
}

/**
 * After camera is placed, lock OrbitControls so only one spherical dimension can change:
 * Y = plan (lock polar, orbit around world Y); X/Z = side (lock azimuth, tilt in meridian).
 * @param {"X" | "Y" | "Z"} axis
 */
function applyAxisOrbitConstraints(axis) {
  controls.update();
  const phi = controls.getPolarAngle();
  const theta = controls.getAzimuthalAngle();
  if (axis === "Y") {
    const p = THREE.MathUtils.clamp(phi, 1e-4, Math.PI - 1e-4);
    controls.minPolarAngle = p;
    controls.maxPolarAngle = p;
    controls.minAzimuthAngle = -Infinity;
    controls.maxAzimuthAngle = Infinity;
  } else {
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = Math.PI;
    const t = theta;
    controls.minAzimuthAngle = t - ORBIT_LOCK_EPS;
    controls.maxAzimuthAngle = t + ORBIT_LOCK_EPS;
  }
  controls.update();
}

function saveAxisViewBaselineState() {
  if (axisSavedStateCaptured) return;
  _savedCamPos.copy(camera.position);
  _savedCamQuat.copy(camera.quaternion);
  _savedCamUp.copy(camera.up);
  _savedOrbitTarget.copy(controls.target);
  axisSavedStateCaptured = true;
}

function updateAxisFabActiveState() {
  const pairs = [
    [btnAxisX, "X"],
    [btnAxisY, "Y"],
    [btnAxisZ, "Z"],
  ];
  for (const [el, ax] of pairs) {
    if (!el) continue;
    const on = axisViewActive === ax;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  }
}

function exitAxisViewIfNeeded() {
  if (!axisViewActive) return;
  clearAxisOrbitConstraints();
  camera.position.copy(_savedCamPos);
  camera.quaternion.copy(_savedCamQuat);
  camera.up.copy(_savedCamUp);
  controls.target.copy(_savedOrbitTarget);
  controls.update();
  axisViewActive = null;
  axisSavedStateCaptured = false;
  updateAxisFabActiveState();
  syncOrbitWithGizmo();
}

/**
 * Y = plan (from +Y), X = from +X, Z = from +Z — all look at orbit target.
 * @param {"X" | "Y" | "Z"} axis
 */
function applyAxisView(axis) {
  const t = controls.target;
  saveAxisViewBaselineState();
  const dist = THREE.MathUtils.clamp(
    camera.position.distanceTo(t),
    1.25,
    40,
  );
  if (axis === "Y") {
    camera.position.set(t.x, t.y + dist, t.z);
    camera.up.set(0, 0, -1);
    camera.lookAt(t);
  } else if (axis === "X") {
    camera.position.set(t.x + dist, t.y, t.z);
    camera.up.set(0, 1, 0);
    camera.lookAt(t);
  } else {
    camera.position.set(t.x, t.y, t.z + dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(t);
  }
  controls.update();
  applyAxisOrbitConstraints(axis);
  axisViewActive = axis;
  updateAxisFabActiveState();
  syncOrbitWithGizmo();
}

function toggleAxisView(axis) {
  if (getViewMode() !== "2d" && getViewMode() !== "align") return;
  if (renderer.xr.isPresenting) return;
  if (axisViewActive === axis) {
    exitAxisViewIfNeeded();
    return;
  }
  applyAxisView(axis);
}

function syncAxisViewFabVisibility() {
  const hide = getViewMode() === "ar" || renderer.xr.isPresenting;
  if (elAxisViewWrap) {
    elAxisViewWrap.hidden = hide;
    if (hide) exitAxisViewIfNeeded();
  }
  if (elAutoOrbitWrap) {
    elAutoOrbitWrap.hidden = hide;
    if (hide) disableAutoOrbit();
  }
}

/**
 * Place sketch so world origin is meaningful: center XZ at 0, bottom of bounds on y=0 (floor grid).
 * Excludes `remotePresenceGroup` so orbit framing targets strokes only (presence is not part of the sketch).
 */
function frameContentAtOrigin() {
  contentGroup.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const ch of contentGroup.children) {
    if (ch === remotePresenceGroup) continue;
    box.expandByObject(ch);
  }
  if (box.isEmpty()) {
    contentGroup.position.set(0, 0, 0);
    return;
  }
  const center = new THREE.Vector3();
  box.getCenter(center);
  contentGroup.position.set(-center.x, -box.min.y, -center.z);
  contentGroup.updateMatrixWorld(true);
}

/**
 * Remote head/cone primitives are ~0.1 m; orbit cameras sit several meters away, so markers read as invisible.
 * Scale presence to the stroke bounds (excluding presence) so peers stay visible in preview.
 */
function updateRemotePresenceViewerScale() {
  _presenceStrokeBounds.makeEmpty();
  for (const ch of contentGroup.children) {
    if (ch === remotePresenceGroup) continue;
    _presenceStrokeBounds.expandByObject(ch);
  }
  if (_presenceStrokeBounds.isEmpty()) {
    remotePresenceGroup.scale.setScalar(1);
    return;
  }
  const size = _presenceStrokeBounds.getSize(_presenceSizeScratch);
  const maxDim = Math.max(size.x, size.y, size.z, 0.01);
  const s = THREE.MathUtils.clamp(Math.max(2.4, maxDim * 0.16), 2.4, 18);
  remotePresenceGroup.scale.setScalar(s);
}

/** Draw-through strokes so orange/blue markers are not lost behind thick tubes on preview. */
function applyViewerPresenceRenderHints() {
  remotePresenceGroup.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
      o.frustumCulled = false;
      o.renderOrder = 1000;
    }
    const mats = o.material
      ? Array.isArray(o.material)
        ? o.material
        : [o.material]
      : [];
    for (const m of mats) {
      if (m) {
        m.depthTest = false;
        m.transparent = true;
        m.needsUpdate = true;
      }
    }
  });
}

/**
 * Walk up to the direct child of `contentGroup` (stroke mesh, cluster group, or voxel block).
 * @param {THREE.Intersection} hit
 * @returns {THREE.Object3D | null}
 */
function getMovableRoot(hit) {
  let o = hit.object;
  if (!o) return null;
  while (o.parent && o.parent !== contentGroup) {
    o = o.parent;
  }
  return o.parent === contentGroup ? o : null;
}

function normalizeClientRect(x0, y0, x1, y1) {
  return {
    left: Math.min(x0, x1),
    right: Math.max(x0, x1),
    top: Math.min(y0, y1),
    bottom: Math.max(y0, y1),
  };
}

function rectsOverlap2D(a, b) {
  return !(
    a.right < b.left ||
    a.left > b.right ||
    a.bottom < b.top ||
    a.top > b.bottom
  );
}

function getScreenBoundsForContentRoot(root, canvasRect) {
  _bbWorld.setFromObject(root);
  if (_bbWorld.isEmpty()) return null;
  const min = _bbWorld.min;
  const max = _bbWorld.max;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (let i = 0; i < 8; i++) {
    _bbProj.set(
      (i & 1) !== 0 ? max.x : min.x,
      (i & 2) !== 0 ? max.y : min.y,
      (i & 4) !== 0 ? max.z : min.z,
    );
    _bbProj.project(camera);
    if (_bbProj.z > 1) continue;
    any = true;
    const sx = (_bbProj.x * 0.5 + 0.5) * canvasRect.width + canvasRect.left;
    const sy = (-_bbProj.y * 0.5 + 0.5) * canvasRect.height + canvasRect.top;
    minX = Math.min(minX, sx);
    minY = Math.min(minY, sy);
    maxX = Math.max(maxX, sx);
    maxY = Math.max(maxY, sy);
  }
  if (!any) return null;
  return { left: minX, top: minY, right: maxX, bottom: maxY };
}

function collectObjectsInScreenRect(sel) {
  const out = [];
  const canvasRect = canvas.getBoundingClientRect();
  for (const ch of contentGroup.children) {
    if (ch === remotePresenceGroup) continue;
    const bounds = getScreenBoundsForContentRoot(ch, canvasRect);
    if (bounds && rectsOverlap2D(sel, bounds)) out.push(ch);
  }
  return out;
}

function updateSelectionRectOverlay() {
  if (!elSelectionRectOverlay) return;
  const { x0, y0, x1, y1 } = rectSelectDrag;
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  elSelectionRectOverlay.style.left = `${left}px`;
  elSelectionRectOverlay.style.top = `${top}px`;
  elSelectionRectOverlay.style.width = `${Math.abs(x1 - x0)}px`;
  elSelectionRectOverlay.style.height = `${Math.abs(y1 - y0)}px`;
}

function clearMultiSelection() {
  multiSelectedRoots.clear();
  if (elMultiSelectToolbar) elMultiSelectToolbar.hidden = true;
}

function pruneMultiSelection() {
  for (const r of [...multiSelectedRoots]) {
    if (!r.parent || r.parent !== contentGroup) multiSelectedRoots.delete(r);
  }
  if (multiSelectedRoots.size === 0 && elMultiSelectToolbar) {
    elMultiSelectToolbar.hidden = true;
  }
}

function updateMultiSelectToolbarPosition() {
  if (!elMultiSelectToolbar || multiSelectedRoots.size === 0) return;
  let first = true;
  for (const r of multiSelectedRoots) {
    _bbWorld.setFromObject(r);
    if (_bbWorld.isEmpty()) continue;
    if (first) {
      _bbUnion.copy(_bbWorld);
      first = false;
    } else _bbUnion.union(_bbWorld);
  }
  if (first) return;
  _bbUnion.getCenter(_bbProj);
  _bbProj.project(camera);
  const rect = canvas.getBoundingClientRect();
  const sx = (_bbProj.x * 0.5 + 0.5) * rect.width + rect.left;
  const sy = (-_bbProj.y * 0.5 + 0.5) * rect.height + rect.top;
  elMultiSelectToolbar.style.left = `${sx}px`;
  elMultiSelectToolbar.style.top = `${Math.max(8, sy - 52)}px`;
}

function setMultiSelection(roots) {
  multiSelectedRoots.clear();
  for (const r of roots) multiSelectedRoots.add(r);
  if (elMultiSelectToolbar) {
    elMultiSelectToolbar.hidden = multiSelectedRoots.size === 0;
  }
  updateMultiSelectToolbarPosition();
}

function clearViewerRemotePeers() {
  for (const g of viewerRemotePeers.values()) {
    remotePresenceGroup.remove(g);
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
  }
  viewerRemotePeers.clear();
}

function handleViewerRemotePresence(p) {
  if (!p || p.deviceId === viewerDeviceId) return;
  if (!viewerShowOthers) return;
  let g = viewerRemotePeers.get(p.deviceId);
  if (!g) {
    g = new THREE.Group();
    g.name = `peer-${p.deviceId}`;
    remotePresenceGroup.add(g);
    viewerRemotePeers.set(p.deviceId, g);
  }
  g.userData.lastMs = performance.now();
  setPresenceTargetsFromPayload(p, g);
}

function applyAlignmentPayload(alignment) {
  if (!alignment || alignment.matrix == null) {
    alignmentGroup.matrix.identity();
    alignmentGroup.matrixAutoUpdate = true;
    return;
  }
  let raw = alignment.matrix;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    raw = raw.elements ?? null;
  }
  if (!Array.isArray(raw) || raw.length !== 16) {
    alignmentGroup.matrix.identity();
    alignmentGroup.matrixAutoUpdate = true;
    return;
  }
  alignmentGroup.matrix.copy(matrix4FromArray(raw));
  alignmentGroup.matrixAutoUpdate = false;
  alignmentGroup.updateMatrixWorld(true);
}

function stopViewerSubscription() {
  if (viewerRoomRealtime) {
    viewerRoomRealtime.unsubscribe();
    viewerRoomRealtime = null;
  }
  lastViewerPresenceSendMs = 0;
  clearViewerRemotePeers();
}

/** @param {{ snapshot?: unknown, snapshotUpdatedAt?: unknown, alignment?: unknown }} data */
function applyRemoteRoomData(data) {
  if (!data) return;
  const remotePayload =
    data.snapshot && data.snapshot.v === 1 && Array.isArray(data.snapshot.nodes)
      ? data.snapshot
      : { v: 1, nodes: [] };
  if (!data.snapshot) {
    setStatus("No drawing yet — enable Broadcast on Quest, then draw.", "");
  }
  const key = getSnapshotChangeKey(data);
  if (key !== lastSnapshotKey) {
    /* Do not replace the scene while a stroke is live — scene apply would invalidate TubePainter mid-drag (GPU crash). */
    if (stylusDrawActive || viewerStrokePosting) {
      return;
    }
    lastSnapshotKey = key;
    /* Do not reset orbit target to origin — that “snaps” the view and has caused preview crashes on tablets. */
    detachTransformKeepOrbitTarget();
    try {
      if (!viewerDidInitialFraming) {
        contentGroup.position.set(0, 0, 0);
        contentGroup.quaternion.identity();
        contentGroup.scale.set(1, 1, 1);
      }
      const localPayload = serializeStrokesGroup(contentGroup);
      const merged = mergeScenePayloadsForViewerPoll(
        remotePayload,
        localPayload,
        viewerPendingSyncIds,
      );
      applyScenePayloadIncremental(merged, material, contentGroup);
      if (!viewerDidInitialFraming) {
        frameContentAtOrigin();
        viewerDidInitialFraming = true;
      }
      if (getViewMode() === "align") {
        applyAlignmentPayload(data.alignment);
      } else {
        alignmentGroup.matrix.identity();
        alignmentGroup.matrixAutoUpdate = true;
      }
      controls.update();
      setStatus("Updated.", "ok");
    } catch (err) {
      console.warn(err);
      try {
        applyScenePayloadIncremental({ v: 1, nodes: [] }, material, contentGroup);
      } catch (_) {
        /* ignore */
      }
      if (!viewerDidInitialFraming) {
        frameContentAtOrigin();
        viewerDidInitialFraming = true;
      }
      controls.update();
      setStatus("Scene data error — check Quest broadcast.", "err");
    }
  }
}

async function refreshViewerRoomFromServer() {
  const room = normalizeRoomCode(elRoom.value || "");
  if (!room || !viewerRoomId) return;
  if (viewerStrokePosting || stylusDrawActive) return;
  if (pollBusy) return;
  const sb = getSketcharSupabase();
  if (!sb) return;
  pollBusy = true;
  try {
    const data = await fetchRoomBySlug(sb, room);
    if (!data) return;
    applyRemoteRoomData(data);
  } catch (e) {
    console.warn(e);
    setStatus("Realtime sync failed — check Supabase env.", "err");
  } finally {
    pollBusy = false;
  }
}

function startRoomSync() {
  stopViewerSubscription();
  viewerRoomId = "";
  const room = normalizeRoomCode(elRoom.value || "");
  if (!room) {
    setStatus("Enter a room code.", "err");
    return;
  }
  if (!isSketcharConfigured()) {
    setStatus("Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (build must include them).", "err");
    return;
  }
  const sb = getSketcharSupabase();
  if (!sb) {
    setStatus("Supabase client unavailable.", "err");
    return;
  }
  setStatus("Loading room…", "");
  void (async () => {
    pollBusy = true;
    try {
      const data = await fetchRoomBySlug(sb, room);
      if (!data) {
        setStatus(
          "Room not found. Use the exact 4-character code from Quest (New room), or create a room first.",
          "err",
        );
        return;
      }
      viewerRoomId = data.roomId;
      applyRemoteRoomData(data);
      viewerRoomRealtime = subscribeRoom(sb, data.roomId, {
        onSnapshot: () => {
          void refreshViewerRoomFromServer();
        },
        onAlignment: () => {
          void refreshViewerRoomFromServer();
        },
        onPresence: handleViewerRemotePresence,
      });
    } catch (e) {
      console.warn(e);
      setStatus("Could not load room — check console / Supabase embed.", "err");
    } finally {
      pollBusy = false;
    }
  })();
}

elRoom.addEventListener("input", () => {
  updateStylusDrawRoomAvailability();
});
elRoom.addEventListener("change", () => {
  updateStylusDrawRoomAvailability();
  lastSnapshotKey = "";
  viewerDidInitialFraming = false;
  startRoomSync();
});
elRoom.addEventListener("keydown", (e) => {
  if (e.key === "Enter") startRoomSync();
});

for (const el of document.querySelectorAll('input[name="mode"]')) {
  el.addEventListener("change", () => {
    const m = document.querySelector('input[name="mode"]:checked')?.value;
    const u = new URL(window.location.href);
    if (m) u.searchParams.set("mode", m);
    history.replaceState({}, "", u);
    lastSnapshotKey = "";
    void refreshViewerRoomFromServer();
    syncAxisViewFabVisibility();
  });
}

function ensureSceneGraphFor2d() {
  if (arRig.parent === camera) {
    camera.remove(arRig);
    scene.add(alignmentGroup);
  }
  alignmentGroup.position.set(0, 0, 0);
  alignmentGroup.quaternion.identity();
  alignmentGroup.scale.set(1, 1, 1);
  controls.enabled = true;
  gridHelper.visible = true;
  transformControl.visible = transformControl.object != null;
  syncAxisViewFabVisibility();
}

function ensureSceneGraphForAr() {
  exitAxisViewIfNeeded();
  disableAutoOrbit();
  controls.enabled = false;
  detachTransformClean();
  transformControl.visible = false;
  gridHelper.visible = false;
  if (alignmentGroup.parent === scene) scene.remove(alignmentGroup);
  arRig.add(alignmentGroup);
  camera.add(arRig);
  syncAxisViewFabVisibility();
}

function wireAxisViewButton(el, axis) {
  el?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleAxisView(axis);
  });
}
wireAxisViewButton(btnAxisX, "X");
wireAxisViewButton(btnAxisY, "Y");
wireAxisViewButton(btnAxisZ, "Z");

btnAutoOrbit?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (getViewMode() !== "2d" && getViewMode() !== "align") return;
  if (renderer.xr.isPresenting) return;
  if (controls.autoRotate) {
    disableAutoOrbit();
    return;
  }
  controls.target.set(0, 0, 0);
  controls.autoRotateSpeed = AUTO_ORBIT_SPEED;
  controls.autoRotate = true;
  controls.update();
  setAutoOrbitUi(true);
});

btnAr.addEventListener("click", async () => {
  const mode = getViewMode();
  if (mode === "2d") {
    const s = renderer.xr.getSession?.();
    if (s) await s.end();
    ensureSceneGraphFor2d();
    setStatus("3D orbit mode.", "ok");
    return;
  }

  if (!navigator.xr) {
    setStatus(webXrUnavailableMessage(), "err");
    return;
  }
  try {
    const ok = await navigator.xr.isSessionSupported("immersive-ar");
    if (!ok) {
      setStatus(
        isIosWebKit()
          ? "immersive-ar not supported on iPhone/iPad. Use 3D orbit, or Chrome on an ARCore Android phone for AR."
          : "immersive-ar not supported on this device. Try Chrome on an ARCore phone with HTTPS.",
        "err",
      );
      return;
    }
  } catch {
    setStatus("Could not query immersive-ar support. Check HTTPS and try again.", "err");
    return;
  }

  try {
    const session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["local"],
      optionalFeatures: ["dom-overlay", "hand-tracking", "layers"],
    });
    ensureSceneGraphForAr();
    await renderer.xr.setSession(session);
    setStatus("AR active — sketch floats in front of you.", "ok");
  } catch (e) {
    console.warn(e);
    ensureSceneGraphFor2d();
    setStatus("AR session failed or denied.", "err");
  }
});

renderer.xr.addEventListener("sessionend", () => {
  ensureSceneGraphFor2d();
});

btnPinPhone.addEventListener("click", async () => {
  const room = normalizeRoomCode(elRoom.value || "");
  if (!room) {
    setStatus("Enter room code first.", "err");
    return;
  }
  const p = new THREE.Vector3();
  camera.getWorldPosition(p);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  p.addScaledVector(fwd, 0.45);
  try {
    const sb = getSketcharSupabase();
    if (!sb || !viewerRoomId) {
      setStatus("Room not loaded — enter code and wait for sync.", "err");
      return;
    }
    const j = await upsertPin(sb, viewerRoomId, "phone", [p.x, p.y, p.z]);
    setStatus(
      j.alignmentReady
        ? "Pins matched — alignment saved."
        : "Phone pin sent — waiting for Quest pin.",
      "ok",
    );
    void refreshViewerRoomFromServer();
  } catch (e) {
    console.warn(e);
    setStatus("Pin request failed.", "err");
  }
});

if (btnStylusDraw) {
  btnStylusDraw.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    stylusDrawMode = !stylusDrawMode;
    btnStylusDraw.classList.toggle("active", stylusDrawMode);
    btnStylusDraw.setAttribute("aria-pressed", String(stylusDrawMode));
    if (stylusDrawMode) {
      rectSelectMode = false;
      if (btnSelectMode) {
        btnSelectMode.classList.remove("active");
        btnSelectMode.setAttribute("aria-pressed", "false");
      }
      detachTransformKeepOrbitTarget();
      syncStylusDrawPlaneFromCamera();
    } else {
      stylusDrawPlaneReady = false;
      /* End any in-progress stroke — otherwise plane sync / poll deserialize fights TubePainter mid-gesture (tablet crash). */
      if (stylusDrawActive) cancelStylusDraw();
    }
  });
}

if (btnSelectMode) {
  btnSelectMode.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    rectSelectMode = !rectSelectMode;
    btnSelectMode.classList.toggle("active", rectSelectMode);
    btnSelectMode.setAttribute("aria-pressed", String(rectSelectMode));
    if (rectSelectMode) {
      stylusDrawMode = false;
      if (btnStylusDraw) {
        btnStylusDraw.classList.remove("active");
        btnStylusDraw.setAttribute("aria-pressed", "false");
      }
      stylusDrawPlaneReady = false;
      if (stylusDrawActive) cancelStylusDraw();
      detachTransformKeepOrbitTarget();
      clearMultiSelection();
    }
  });
}

if (btnDeleteSelection) {
  btnDeleteSelection.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (multiSelectedRoots.size === 0) return;
    const removed = new Set();
    for (const root of multiSelectedRoots) {
      const id = sceneNodeIdFromObject3D(root);
      if (id) removed.add(id);
      disposeSceneGeometrySubtree(root);
      contentGroup.remove(root);
    }
    clearMultiSelection();
    await postViewerSnapshot(removed);
  });
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  updateMultiSelectToolbarPosition();
}
window.addEventListener("resize", onResize);

const ptrDown = { x: 0, y: 0, t: 0, id: -1 };
/** OrbitControls wins pointerdown before we can "click" strokes — disable orbit while a tap may select content. */
let pendingSelectFromPointer = null;

let rectSelectMode = false;
const rectSelectDrag = {
  active: false,
  pointerId: -1,
  x0: 0,
  y0: 0,
  x1: 0,
  y1: 0,
};
const MIN_RECT_SEL_PX = 12;
const multiSelectedRoots = new Set();
const _bbWorld = new THREE.Box3();
const _bbUnion = new THREE.Box3();
const _bbProj = new THREE.Vector3();

function ndcFromClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
}

/** When draw mode is on: pen, finger (touch), or mouse left button. */
function isDrawModePointer(e) {
  if (e.pointerType === "pen") return true;
  if (e.pointerType === "touch") return true;
  if (e.pointerType === "mouse") return e.button === 0;
  return false;
}

/** Drawing plane through orbit target; when an axis view is locked, use that world plane so strokes stay on XZ / YZ / XY. */
function syncStylusDrawPlaneFromCamera() {
  contentGroup.updateMatrixWorld(true);
  const t = controls.target;
  if (axisViewActive === "Y") {
    _drawPlaneWorld.setFromNormalAndCoplanarPoint(_axisPlaneNorm.set(0, 1, 0), t);
  } else if (axisViewActive === "X") {
    _drawPlaneWorld.setFromNormalAndCoplanarPoint(_axisPlaneNorm.set(1, 0, 0), t);
  } else if (axisViewActive === "Z") {
    _drawPlaneWorld.setFromNormalAndCoplanarPoint(_axisPlaneNorm.set(0, 0, 1), t);
  } else {
    camera.getWorldDirection(_fwdWorld);
    _fwdWorld.normalize();
    _drawPlaneWorld.setFromNormalAndCoplanarPoint(_fwdWorld, t);
  }
  stylusDrawPlaneReady = true;
}

function intersectStylusDrawPlaneLocal(clientX, clientY) {
  if (!stylusDrawPlaneReady) {
    if (!stylusDrawMode) return null;
    syncStylusDrawPlaneFromCamera();
  }
  ndcFromClient(clientX, clientY);
  raycaster.setFromCamera(pointerNdc, camera);
  if (!raycaster.ray.intersectPlane(_drawPlaneWorld, _hitWorld)) return null;
  const local = _hitWorld.clone();
  contentGroup.worldToLocal(local);
  return local;
}

/**
 * Append points along the segment from the last sample to `hit` so fast strokes stay smooth even when pointer events are sparse.
 */
function appendViewerStylusSegment(hit, pressureSample) {
  const p =
    typeof pressureSample === "number" && pressureSample > 0
      ? pressureSample
      : 0.5;
  const last = stylusPoints[stylusPoints.length - 1];
  if (!last) {
    stylusPoints.push(hit.clone());
    return;
  }
  const step = VIEWER_STROKE_MIN_SEGMENT;
  let d = last.distanceTo(hit);
  if (d <= 1e-12) return;
  let cur = last;
  let inserts = 0;
  while (d > step && inserts < VIEWER_STROKE_MAX_INSERTS_PER_MOVE) {
    _stylusLerp.lerpVectors(cur, hit, step / d);
    const next = _stylusLerp.clone();
    stylusPoints.push(next);
    stylusPressureSum += p;
    stylusPressureCount += 1;
    if (stylusPreviewPainter) {
      stylusPreviewPainter.lineTo(next);
      stylusPreviewPainter.update();
    }
    cur = next;
    d = cur.distanceTo(hit);
    inserts++;
  }
  if (cur.distanceTo(hit) > 1e-9) {
    stylusPoints.push(hit.clone());
    stylusPressureSum += p;
    stylusPressureCount += 1;
    if (stylusPreviewPainter) {
      stylusPreviewPainter.lineTo(hit);
      stylusPreviewPainter.update();
    }
  }
}

function disposeStylusPreviewMesh() {
  if (!stylusPreviewPainter) return;
  const mesh = stylusPreviewPainter.mesh;
  contentGroup.remove(mesh);
  mesh.geometry?.dispose();
  stylusPreviewPainter = null;
}

function cancelStylusDraw() {
  disposeStylusPreviewMesh();
  stylusDrawActive = false;
  stylusPoints.length = 0;
  stylusPointerId = -1;
  stylusPressureSum = 0;
  stylusPressureCount = 0;
  controls.enabled = true;
}

function updateStylusDrawRoomAvailability() {
  const code = normalizeRoomCode(elRoom.value || "");
  const inRoom = code.length === 4;
  if (elStylusDrawWrap) elStylusDrawWrap.hidden = !inRoom;
  if (elSelectModeWrap) elSelectModeWrap.hidden = !inRoom;
  if (!inRoom && stylusDrawMode) {
    stylusDrawMode = false;
    if (btnStylusDraw) {
      btnStylusDraw.classList.remove("active");
      btnStylusDraw.setAttribute("aria-pressed", "false");
    }
    if (stylusDrawActive) cancelStylusDraw();
  }
  if (!inRoom && rectSelectMode) {
    rectSelectMode = false;
    if (btnSelectMode) {
      btnSelectMode.classList.remove("active");
      btnSelectMode.setAttribute("aria-pressed", "false");
    }
  }
}
updateStylusDrawRoomAvailability();

/**
 * Push full scene: merge serialize(contentGroup) with remote (same as Quest push).
 * Never send only the latest stroke — a stale GET would drop previous strokes and corrupt the room.
 */
async function postViewerSnapshot(removedIds) {
  const room = normalizeRoomCode(elRoom.value || "");
  if (!room || !viewerRoomId) return;
  const removedSet =
    removedIds instanceof Set
      ? removedIds
      : new Set(Array.isArray(removedIds) ? removedIds : []);
  contentGroup.updateMatrixWorld(true);
  const localPayload = serializeStrokesGroup(contentGroup);
  if (!localPayload.nodes.length && removedSet.size === 0) return;

  viewerStrokePosting = true;
  try {
    const sb = getSketcharSupabase();
    if (!sb) throw new Error("supabase_unconfigured");
    const roomData = await fetchRoomBySlug(sb, room);
    let remoteSnap = roomData?.snapshot ?? null;
    const remote =
      remoteSnap && remoteSnap.v === 1 && Array.isArray(remoteSnap.nodes)
        ? remoteSnap
        : { v: 1, nodes: [] };
    const merged =
      removedSet.size > 0
        ? mergeScenePayloadsWithRemovals(localPayload, remote, removedSet)
        : mergeScenePayloads(localPayload, remote);
    await upsertSnapshot(sb, viewerRoomId, merged);
    for (const n of merged.nodes) {
      viewerPendingSyncIds.delete(nodeIdFromPayload(n));
    }
    lastSnapshotKey = "";
    setStatus(removedSet.size > 0 ? "Scene updated." : "Stroke synced.", "ok");
  } catch (err) {
    console.warn(err);
    setStatus("Stroke sync failed — check Supabase env.", "err");
  } finally {
    viewerStrokePosting = false;
  }
}

function queueViewerSnapshotPost() {
  viewerSnapshotPostChain = viewerSnapshotPostChain
    .then(() => postViewerSnapshot())
    .catch((err) => {
      console.warn(err);
    });
}

function finishStylusStroke() {
  const pts = stylusPoints.map((p) => p.clone());
  const avgP =
    stylusPressureCount > 0 ? stylusPressureSum / stylusPressureCount : 0.5;
  const mesh = stylusPreviewPainter?.mesh;

  stylusDrawActive = false;
  stylusPoints.length = 0;
  stylusPointerId = -1;
  stylusPressureSum = 0;
  stylusPressureCount = 0;
  controls.enabled = true;

  if (!mesh || pts.length < 2) {
    disposeStylusPreviewMesh();
    return;
  }

  mesh.userData.points = pts.map((p) => p.clone());
  mesh.userData.strokeWidth = strokeWidthFromPressure(avgP);
  const syncId = newStrokeSyncId();
  mesh.userData.syncId = syncId;
  viewerPendingSyncIds.add(syncId);
  delete mesh.userData.isViewerPreviewStroke;
  stylusPreviewPainter = null;

  queueViewerSnapshotPost();
}

function clearPendingSelect() {
  if (pendingSelectFromPointer) {
    controls.enabled = true;
    pendingSelectFromPointer = null;
  }
}

canvas.addEventListener("pointerdown", (e) => {
  ptrDown.x = e.clientX;
  ptrDown.y = e.clientY;
  ptrDown.t = performance.now();
  ptrDown.id = e.pointerId;

  if (
    stylusDrawMode &&
    (getViewMode() === "2d" || getViewMode() === "align") &&
    !renderer.xr.isPresenting &&
    isDrawModePointer(e)
  ) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const hit = intersectStylusDrawPlaneLocal(e.clientX, e.clientY);
    if (!hit) return;
    detachTransformKeepOrbitTarget();
    disposeStylusPreviewMesh();
    const p0 =
      typeof e.pressure === "number" && e.pressure > 0 ? e.pressure : 0.5;
    stylusPreviewPainter = new TubePainter();
    stylusPreviewPainter.mesh.material = material;
    const w = strokeWidthFromPressure(p0);
    stylusPreviewPainter.setSize(w);
    stylusPreviewPainter.mesh.userData.strokeWidth = w;
    stylusPreviewPainter.mesh.userData.isViewerPreviewStroke = true;
    contentGroup.add(stylusPreviewPainter.mesh);
    stylusPreviewPainter.moveTo(hit);
    stylusDrawActive = true;
    stylusPointerId = e.pointerId;
    stylusPoints = [hit];
    stylusPressureSum = p0;
    stylusPressureCount = 1;
    controls.enabled = false;
    clearPendingSelect();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    return;
  }

  if (
    rectSelectMode &&
    !stylusDrawMode &&
    (getViewMode() === "2d" || getViewMode() === "align") &&
    !renderer.xr.isPresenting &&
    isDrawModePointer(e)
  ) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    rectSelectDrag.active = true;
    rectSelectDrag.pointerId = e.pointerId;
    rectSelectDrag.x0 = e.clientX;
    rectSelectDrag.y0 = e.clientY;
    rectSelectDrag.x1 = e.clientX;
    rectSelectDrag.y1 = e.clientY;
    controls.enabled = false;
    clearPendingSelect();
    detachTransformKeepOrbitTarget();
    clearMultiSelection();
    if (elSelectionRectOverlay) {
      elSelectionRectOverlay.hidden = false;
      elSelectionRectOverlay.setAttribute("aria-hidden", "false");
      updateSelectionRectOverlay();
    }
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    return;
  }

  if (getViewMode() !== "2d" && getViewMode() !== "align") return;
  if (renderer.xr.isPresenting) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;

  ndcFromClient(e.clientX, e.clientY);
  raycaster.setFromCamera(pointerNdc, camera);
  if (transformControl.object != null && transformControl.visible) {
    const gizmoHits = raycaster.intersectObject(transformControl, true);
    if (gizmoHits.length > 0) return;
  }
  const hits = raycaster.intersectObjects(contentGroup.children, true);
  if (hits.length > 0) {
    const root = getMovableRoot(hits[0]);
    if (root) {
      pendingSelectFromPointer = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        root,
      };
      controls.enabled = false;
    }
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (stylusDrawActive && e.pointerId === stylusPointerId) {
    const hit = intersectStylusDrawPlaneLocal(e.clientX, e.clientY);
    if (hit) {
      const pr =
        typeof e.pressure === "number" && e.pressure > 0 ? e.pressure : 0.5;
      appendViewerStylusSegment(hit, pr);
    }
    return;
  }
  if (rectSelectDrag.active && e.pointerId === rectSelectDrag.pointerId) {
    rectSelectDrag.x1 = e.clientX;
    rectSelectDrag.y1 = e.clientY;
    updateSelectionRectOverlay();
    return;
  }
  if (!pendingSelectFromPointer || pendingSelectFromPointer.pointerId !== e.pointerId)
    return;
  const dx = e.clientX - pendingSelectFromPointer.x;
  const dy = e.clientY - pendingSelectFromPointer.y;
  if (dx * dx + dy * dy > 144) {
    controls.enabled = true;
    pendingSelectFromPointer = null;
  }
});

canvas.addEventListener("pointercancel", () => {
  if (stylusDrawActive) {
    cancelStylusDraw();
    return;
  }
  if (rectSelectDrag.active) {
    rectSelectDrag.active = false;
    if (elSelectionRectOverlay) {
      elSelectionRectOverlay.hidden = true;
      elSelectionRectOverlay.setAttribute("aria-hidden", "true");
    }
    controls.enabled = true;
    return;
  }
  clearPendingSelect();
});

canvas.addEventListener("pointerup", (e) => {
  if (stylusDrawActive && e.pointerId === stylusPointerId) {
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    finishStylusStroke();
    return;
  }
  if (rectSelectDrag.active && e.pointerId === rectSelectDrag.pointerId) {
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    const { x0, y0, x1, y1 } = rectSelectDrag;
    rectSelectDrag.active = false;
    if (elSelectionRectOverlay) {
      elSelectionRectOverlay.hidden = true;
      elSelectionRectOverlay.setAttribute("aria-hidden", "true");
    }
    controls.enabled = true;
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    if (w >= MIN_RECT_SEL_PX && h >= MIN_RECT_SEL_PX) {
      const sel = normalizeClientRect(x0, y0, x1, y1);
      setMultiSelection(collectObjectsInScreenRect(sel));
    } else {
      clearMultiSelection();
    }
    return;
  }
  if (e.pointerId !== ptrDown.id) return;
  if (getViewMode() !== "2d" && getViewMode() !== "align") return;
  if (renderer.xr.isPresenting) return;
  if (transformControl.dragging) return;

  if (pendingSelectFromPointer && pendingSelectFromPointer.pointerId === e.pointerId) {
    const dx = e.clientX - pendingSelectFromPointer.x;
    const dy = e.clientY - pendingSelectFromPointer.y;
    const tol =
      e.pointerType === "touch" || e.pointerType === "pen" ? 900 : 400;
    const t = performance.now() - ptrDown.t;
    controls.enabled = true;
    if (dx * dx + dy * dy <= tol && t < 850) {
      clearMultiSelection();
      attachTransformToSelection(pendingSelectFromPointer.root);
    }
    pendingSelectFromPointer = null;
    return;
  }

  const dx = e.clientX - ptrDown.x;
  const dy = e.clientY - ptrDown.y;
  if (dx * dx + dy * dy > 400) return;
  if (performance.now() - ptrDown.t > 850) return;

  if (e.pointerType === "mouse" && e.button !== 0) return;

  ndcFromClient(e.clientX, e.clientY);
  raycaster.setFromCamera(pointerNdc, camera);
  if (transformControl.object != null && transformControl.visible) {
    const gizmoHits = raycaster.intersectObject(transformControl, true);
    if (gizmoHits.length > 0) return;
  }

  const hits = raycaster.intersectObjects(contentGroup.children, true);
  if (hits.length > 0) {
    const root = getMovableRoot(hits[0]);
    if (root) {
      clearMultiSelection();
      attachTransformToSelection(root);
    }
  } else {
    detachTransformKeepOrbitTarget();
    clearMultiSelection();
  }
});

renderer.setAnimationLoop(() => {
  const xr = renderer.xr.isPresenting;
  const mode2d = getViewMode() === "2d" || getViewMode() === "align";
  gridHelper.visible = !xr;
  transformControl.visible =
    !xr &&
    mode2d &&
    transformControl.object != null &&
    !stylusDrawActive &&
    multiSelectedRoots.size === 0;
  pruneMultiSelection();
  if (elMultiSelectToolbar && !elMultiSelectToolbar.hidden) {
    updateMultiSelectToolbarPosition();
  }
  applyWasdMovement();
  controls.update();

  if (viewerRoomId && viewerRoomRealtime) {
    const now = performance.now();
    if (now - lastViewerPresenceSendMs >= VIEWER_PRESENCE_SEND_MS) {
      lastViewerPresenceSendMs = now;
      camera.getWorldPosition(_vCamPosW);
      camera.getWorldQuaternion(_vCamQuatW);
      contentGroup.updateMatrixWorld(true);
      contentGroup.worldToLocal(_vCamLocalPos.copy(_vCamPosW));
      contentGroup.getWorldQuaternion(_vParentInv);
      _vParentInv.invert();
      _vCamLocalQuat.copy(_vParentInv).multiply(_vCamQuatW);
      viewerRoomRealtime.sendPresence({
        deviceId: viewerDeviceId,
        label: defaultPresenceLabel(),
        mode: "viewer_camera",
        x: _vCamLocalPos.x,
        y: _vCamLocalPos.y,
        z: _vCamLocalPos.z,
        qx: _vCamLocalQuat.x,
        qy: _vCamLocalQuat.y,
        qz: _vCamLocalQuat.z,
        qw: _vCamLocalQuat.w,
      });
    }
  }
  if (viewerRemotePeers.size > 0) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - viewerLastPresenceSmoothMs) / 1000);
    viewerLastPresenceSmoothMs = now;
    smoothPresencePeers(viewerRemotePeers, dt);
    updateRemotePresenceViewerScale();
    applyViewerPresenceRenderHints();
    remotePresenceGroup.visible = viewerShowOthers;
    pruneStalePresencePeers(viewerRemotePeers, now, 6000);
  }

  renderer.render(scene, camera);
});

syncAxisViewFabVisibility();

const elViewerShowOthers = document.getElementById("viewer-show-others");
if (elViewerShowOthers) {
  elViewerShowOthers.checked = viewerShowOthers;
  elViewerShowOthers.addEventListener("change", () => {
    viewerShowOthers = elViewerShowOthers.checked;
    setShowOthersPreference(viewerShowOthers);
    remotePresenceGroup.visible = viewerShowOthers;
  });
}

startRoomSync();
