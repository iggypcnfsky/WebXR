import * as THREE from "three";
import Axis3d from "lucide/dist/esm/icons/axis-3d.js";
import Boxes from "lucide/dist/esm/icons/boxes.js";
import Clock from "lucide/dist/esm/icons/clock.js";
import Grid3x3 from "lucide/dist/esm/icons/grid-3x3.js";
import { TubePainter } from "three/examples/jsm/misc/TubePainter.js";
import {
  computeTubePainterMaxVertices,
  createTubePainterSized,
} from "./misc/TubePainterSized.js";
import { XRButton } from "three/examples/jsm/webxr/XRButton.js";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import {
  applyScenePayloadIncremental,
  deserializeSceneV1,
  mergeScenePayloads,
  serializeStrokesGroup,
} from "./shared/sceneCodec.js";
import { normalizeRoomCode } from "./shared/roomCode.js";

let camera, scene, renderer;
let controller1, controller2;
let controllerGrip1, controllerGrip2;
let stylus;
/** @type {"left"|"right"|"none"} */
let stylusHandedness = "none";
let gamepad1;
let isDrawing = false;
let prevIsDrawing = false;
/** Set each frame: cluster_front active (eraser). */
let _eraserThisFrame = false;

const strokesGroup = new THREE.Group();
/** Parent for drawable content + grid; transformed by thumb–middle scene manip (HUD/controllers stay on scene). */
const sceneContentRoot = new THREE.Group();
sceneContentRoot.name = "scene-content-root";

const sm_middleTip = new THREE.Vector3();
/** @type {"none"|"one"|"two"} */
let sceneManipMode = "none";
/** @type {XRInputSource | null} */
let sceneGrabL = null;
/** @type {XRInputSource | null} */
let sceneGrabR = null;
/** @type {XRInputSource | null} */
let sceneOneSrc = null;
/** null = two XR hands; "right" = left thumb–middle anchor + stylus tip; "left" = stylus + right anchor */
let sceneTwoHandStylusSide = null;
/** For detecting rear-button edge when upgrading one-hand scene → hand+stylus two-hand */
let scenePrevStylusRearGrab = false;
const sm_oneAnchor0 = new THREE.Vector3();
const sceneOnePos0 = new THREE.Vector3();
const sm_box = new THREE.Box3();
const sm_thPL0 = new THREE.Vector3();
const sm_thPR0 = new THREE.Vector3();
const sm_thV0 = new THREE.Vector3();
let sm_thDist0 = 1;
const sm_thMid0 = new THREE.Vector3();
const sm_thO0 = new THREE.Vector3();
let sm_thBaseScale = 1;
const sm_thQuat0 = new THREE.Quaternion();
const sm_centerLocal = new THREE.Vector3();
const sm_thPL = new THREE.Vector3();
const sm_thPR = new THREE.Vector3();
const sm_thV = new THREE.Vector3();
const sm_thV0n = new THREE.Vector3();
const sm_thVn = new THREE.Vector3();
const sm_qAlign = new THREE.Quaternion();
const sm_thMid = new THREE.Vector3();
const sm_thOScaled = new THREE.Vector3();
const sm_thTargetCenter = new THREE.Vector3();
const sm_thQuatCombined = new THREE.Quaternion();
const sm_axis = new THREE.Vector3();
const sm_anchorScratch = new THREE.Vector3();

const smSlotL = {
  valid: false,
  isPinched: false,
  wasPinched: false,
  inputSource: null,
  hand: null,
  anchor: new THREE.Vector3(),
};
const smSlotR = {
  valid: false,
  isPinched: false,
  wasPinched: false,
  inputSource: null,
  hand: null,
  anchor: new THREE.Vector3(),
};

/** Sketchar: live snapshot sync to Neon (see server/index.mjs). */
const SKETCHAR_BASE = (import.meta.env.VITE_SKETCHAR_API ?? "").replace(/\/$/, "");
let sketcharRoomSlug = "";
let sketcharBroadcast = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let sketcharPushTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let sketcharPollTimer = null;
/** @type {string | null} */
let lastSketcharRemoteSeen = null;
let sketcharPollBusy = false;
/** Set when a remote poll was skipped while drawing/grabbing; flushed once idle. */
let sketcharPollDeferred = false;

/** Full-scene rebuild was blocking XR for large rooms; incremental apply + lower poll rate. */
const SKETCHAR_POLL_MS = 4000;

function sketcharApiUrl(path) {
  return `${SKETCHAR_BASE}${path}`;
}

function scheduleSketcharPush() {
  if (!sketcharBroadcast || !sketcharRoomSlug) return;
  if (sketcharPushTimer) clearTimeout(sketcharPushTimer);
  sketcharPushTimer = setTimeout(() => {
    sketcharPushTimer = null;
    pushSketcharSnapshot();
  }, 500);
}

async function pushSketcharSnapshot() {
  if (!sketcharBroadcast || !sketcharRoomSlug) return;
  if (shouldDeferSketcharSceneApply()) {
    scheduleSketcharPush();
    return;
  }
  strokesGroup.updateMatrixWorld(true);
  const statusEl = document.getElementById("sketchar-status");
  try {
    let remoteSnapshot = null;
    /** @type {string | null} */
    let snapshotAtFromGet = null;
    const gr = await fetch(
      sketcharApiUrl(`/api/rooms/${encodeURIComponent(sketcharRoomSlug)}`),
    );
    if (gr.ok) {
      const data = await gr.json();
      remoteSnapshot = data.snapshot ?? null;
      if (data.snapshotUpdatedAt != null) {
        snapshotAtFromGet = String(data.snapshotUpdatedAt);
      }
    }
    if (shouldDeferSketcharSceneApply()) {
      scheduleSketcharPush();
      return;
    }
    const localPayload = serializeStrokesGroup(strokesGroup);
    const merged = mergeScenePayloads(localPayload, remoteSnapshot);
    applyScenePayloadIncremental(merged, material, strokesGroup);
    strokesGroup.updateMatrixWorld(true);
    const r = await fetch(
      sketcharApiUrl(`/api/rooms/${encodeURIComponent(sketcharRoomSlug)}/snapshot`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: merged }),
      },
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (snapshotAtFromGet != null) lastSketcharRemoteSeen = snapshotAtFromGet;
    if (statusEl) {
      statusEl.textContent = "Sketchar: synced";
      statusEl.dataset.state = "ok";
    }
  } catch (e) {
    console.warn("Sketchar push failed", e);
    if (statusEl) {
      statusEl.textContent = "Sketchar: sync error";
      statusEl.dataset.state = "err";
    }
  }
}

async function pollSketcharRemote() {
  if (!sketcharRoomSlug || sketcharPollBusy) return;
  if (shouldDeferSketcharSceneApply()) return;
  sketcharPollBusy = true;
  try {
    const r = await fetch(
      sketcharApiUrl(`/api/rooms/${encodeURIComponent(sketcharRoomSlug)}`),
    );
    if (!r.ok) return;
    const data = await r.json();
    if (shouldDeferSketcharSceneApply()) {
      sketcharPollDeferred = true;
      return;
    }
    const at =
      data.snapshotUpdatedAt != null ? String(data.snapshotUpdatedAt) : null;
    if (at !== null && at === lastSketcharRemoteSeen) {
      sketcharPollDeferred = false;
      return;
    }
    const remoteSnapshot = data.snapshot ?? null;
    strokesGroup.updateMatrixWorld(true);
    const localPayload = serializeStrokesGroup(strokesGroup);
    const merged = mergeScenePayloads(localPayload, remoteSnapshot);
    applyScenePayloadIncremental(merged, material, strokesGroup);
    strokesGroup.updateMatrixWorld(true);
    if (at !== null) lastSketcharRemoteSeen = at;
    sketcharPollDeferred = false;
  } catch (e) {
    console.warn("Sketchar poll failed", e);
  } finally {
    sketcharPollBusy = false;
  }
}

function startSketcharPoll() {
  if (sketcharPollTimer) clearInterval(sketcharPollTimer);
  sketcharPollTimer = null;
  if (!sketcharRoomSlug) return;
  pollSketcharRemote();
  sketcharPollTimer = setInterval(pollSketcharRemote, SKETCHAR_POLL_MS);
}

function initSketcharUI() {
  const elCreate = document.getElementById("sketchar-create");
  const elJoin = document.getElementById("sketchar-join");
  const elSlug = document.getElementById("sketchar-slug");
  const elBroadcast = document.getElementById("sketchar-broadcast");
  const elCopy = document.getElementById("sketchar-copy");
  const elViewerLink = document.getElementById("sketchar-viewer-link");
  const elPinQuest = document.getElementById("sketchar-pin-quest");
  if (!elSlug) return;

  if (elBroadcast) {
    sketcharBroadcast = elBroadcast.checked;
    elBroadcast.addEventListener("change", () => {
      sketcharBroadcast = elBroadcast.checked;
      if (sketcharBroadcast) scheduleSketcharPush();
    });
  }
  if (elCreate) {
    elCreate.addEventListener("click", async () => {
      try {
        const r = await fetch(sketcharApiUrl("/api/rooms"), { method: "POST" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const code =
          typeof data.slug === "string" ? data.slug.trim() : "";
        if (code.length !== 4) {
          console.warn("Sketchar: expected 4-char slug, got:", data);
          throw new Error("bad_room_code");
        }
        sketcharRoomSlug = normalizeRoomCode(code);
        elSlug.value = sketcharRoomSlug;
        lastSketcharRemoteSeen = null;
        updateSketcharViewerLink(elViewerLink);
        startSketcharPoll();
      } catch (e) {
        console.warn("Sketchar create room failed", e);
        alert("Could not create room. Is the API running? (npm run dev:api)");
      }
    });
  }
  if (elJoin) {
    elJoin.addEventListener("click", async () => {
      const normalized = normalizeRoomCode(elSlug.value || "");
      if (!normalized) {
        alert("Enter a room code.");
        return;
      }
      const statusEl = document.getElementById("sketchar-status");
      try {
        const r = await fetch(
          sketcharApiUrl(`/api/rooms/${encodeURIComponent(normalized)}`),
        );
        if (r.status === 404) {
          if (statusEl) {
            statusEl.textContent = "Sketchar: room not found";
            statusEl.dataset.state = "err";
          } else {
            alert("Room not found.");
          }
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const canonical =
          typeof data.slug === "string" && data.slug.trim()
            ? normalizeRoomCode(data.slug)
            : normalized;
        sketcharRoomSlug = canonical;
        elSlug.value = canonical;
        currentStrokePainter = null;
        currentStrokePointsLocal.length = 0;
        lastThreeCompletedStrokes.length = 0;
        if (data.snapshot && data.snapshot.v === 1 && Array.isArray(data.snapshot.nodes)) {
          deserializeSceneV1(data.snapshot, material, strokesGroup);
        } else {
          deserializeSceneV1({ v: 1, nodes: [] }, material, strokesGroup);
        }
        lastSketcharRemoteSeen =
          data.snapshotUpdatedAt != null ? String(data.snapshotUpdatedAt) : null;
        updateSketcharViewerLink(elViewerLink);
        startSketcharPoll();
        if (statusEl) {
          statusEl.textContent = data.snapshot
            ? "Sketchar: room loaded from cloud"
            : "Sketchar: room empty — draw to sync";
          statusEl.dataset.state = "ok";
        }
      } catch (e) {
        console.warn("Sketchar join room failed", e);
        if (statusEl) {
          statusEl.textContent = "Sketchar: could not load room";
          statusEl.dataset.state = "err";
        } else {
          alert("Could not load room. Is the API running?");
        }
      }
    });
  }
  if (elCopy && elViewerLink) {
    elCopy.addEventListener("click", async () => {
      const t = elViewerLink.textContent || "";
      if (!t || t === "—") return;
      try {
        await navigator.clipboard.writeText(t);
      } catch (_) {
        /* ignore */
      }
    });
  }
  if (elPinQuest) {
    elPinQuest.addEventListener("click", async () => {
      if (!sketcharRoomSlug) return;
      const p = new THREE.Vector3();
      if (stylus && stylus.position) p.copy(stylus.position);
      else camera.getWorldPosition(p);
      try {
        const r = await fetch(
          sketcharApiUrl(`/api/rooms/${encodeURIComponent(sketcharRoomSlug)}/pin`),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              device: "quest",
              position: [p.x, p.y, p.z],
            }),
          },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch (e) {
        console.warn("Sketchar pin failed", e);
      }
    });
  }
  updateSketcharViewerLink(elViewerLink);
}

function updateSketcharViewerLink(elViewerLink) {
  if (!elViewerLink) return;
  if (!sketcharRoomSlug) {
    elViewerLink.textContent = "—";
    return;
  }
  const u = new URL("viewer.html", window.location.href);
  u.searchParams.set("room", sketcharRoomSlug);
  elViewerLink.textContent = u.href;
}

let currentStrokePainter = null;
/** Polyline in mesh-local space; copied to mesh.userData.points when stroke ends (for partial erase). */
let currentStrokePointsLocal = [];

/** Last three completed stroke meshes (FIFO) for box sketch → block mode. */
/** @type {THREE.Mesh[]} */
const lastThreeCompletedStrokes = [];

const material = new THREE.MeshNormalMaterial({
  flatShading: true,
  side: THREE.DoubleSide,
});

const cursor = new THREE.Vector3();
/** Scratch for snapped stroke points (never mutate controller positions). */
const _snapScratch = new THREE.Vector3();
const _snapNext = new THREE.Vector3();
const _manhSeg = new THREE.Vector3();
/** TubePainter geometry is mesh-local; stylus positions are world — convert before moveTo/lineTo. */
const _strokeMeshLocal = new THREE.Vector3();
/** Last accepted freehand sample (world) for min-distance decimation. */
const _lastStrokeSampleWorld = new THREE.Vector3();
/** Skip samples closer than this (world meters, squared) to shrink snapshots / rebuild cost. */
const STROKE_MIN_SAMPLE_DIST_SQ = 0.00035 * 0.00035;
const STROKE_MAX_POINTS = 100000;

const raycaster = new THREE.Raycaster();
const _indexTipPos = new THREE.Vector3();
const _thumbTipPos = new THREE.Vector3();
const _pinkyTipPos = new THREE.Vector3();
const _grabTargetWorld = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _rayDir = new THREE.Vector3();
const _meshWorld = new THREE.Vector3();
const _pickSphere = new THREE.Sphere();
const pinchPrev = new Map();
/** Thumb–middle pinch for scene translate / two-hand scale–rotate (separate hysteresis). */
const thumbMiddlePinchPrev = new Map();
/** Thumb–pinky pinch: left = block mode, right = snap-to-grid toggle (separate maps keys per hand). */
const thumbPinkyPinchPrev = new Map();

/** When true, stroke points snap to world grid intersections (drawing only). */
let snapToGridEnabled = false;
/** Last drawn snapped point for current stroke (Manhattan segments when snap on). */
const _lastStrokeSnapWorld = new THREE.Vector3();
/** Right-pinky grid affordance sprites; redraw when snap toggles. */
/** @type {THREE.Sprite[]} */
const ringGridSnapSprites = [];
let lastRingSnapSpriteState = null;

/** @type {"none"|"one"|"two"} */
let grabMode = "none";
/** Previous frame grab mode — for flushing deferred Sketchar poll when grab ends. */
let prevGrabModeForSketchar = "none";
let grabbedMesh = null;
const grabOffsetWorld = new THREE.Vector3();
/** Snapshot of ref tip/stylus at grab so offset math is not affected by shared Vector3 refs. */
const _grabRefSnap = new THREE.Vector3();
let grabInputSource = null;
/** True when one-hand grab is driven by stylus position + grab button (not a hand pinch). */
let grabInputIsStylus = false;
/** In two-hand mode: which side uses the MX Ink tip instead of a second hand index tip. */
let twoHandStylusSide = null;

let twoGrabLeft = null;
let twoGrabRight = null;
const thPL0 = new THREE.Vector3();
const thPR0 = new THREE.Vector3();
const thV0 = new THREE.Vector3();
let thDist0 = 1;
const thMid0 = new THREE.Vector3();
const thO0 = new THREE.Vector3();
let thBaseScale = 1;
const thQuatMesh0 = new THREE.Quaternion();
const thMid = new THREE.Vector3();
const thPL = new THREE.Vector3();
const thPR = new THREE.Vector3();
const thV = new THREE.Vector3();
const thV0n = new THREE.Vector3();
const thVn = new THREE.Vector3();
const qAlign = new THREE.Quaternion();
const thTargetCenter = new THREE.Vector3();
const thOScaled = new THREE.Vector3();
const thLeftMid0 = new THREE.Vector3();
const thRightMid0 = new THREE.Vector3();
const thWRef0 = new THREE.Vector3();
const thWRef = new THREE.Vector3();
const thLM = new THREE.Vector3();
const thRM = new THREE.Vector3();
const _wL = new THREE.Vector3();
const _wR = new THREE.Vector3();
const _wL0 = new THREE.Vector3();
const _wR0 = new THREE.Vector3();
const qTwist = new THREE.Quaternion();
const _projT = new THREE.Vector3();
const _eraseWorld = new THREE.Vector3();
const _axis = new THREE.Vector3();
const thQuatCombined = new THREE.Quaternion();
const _centerLocal = new THREE.Vector3();
const _penForward = new THREE.Vector3();
const _snapDeltaWorld = new THREE.Vector3();
const _snapTargetCenter = new THREE.Vector3();
const _qWorldGrab = new THREE.Quaternion();
const _qSnapRot = new THREE.Quaternion();
const _eulerGrabSnap = new THREE.Euler();
const _snapParentQuat = new THREE.Quaternion();

const PINCH_CLOSE_DIST = 0.015;
const PINCH_OPEN_DIST = 0.025;
const SCENE_MANIP_SCALE_MIN = 0.05;
const SCENE_MANIP_SCALE_MAX = 5;

/**
 * Single world-space lattice: `cellSize = GRID_WORLD_EXTENT / divisions` (only source of truth).
 * Changing `snapToGridEnabled` does not change this — same grid for draw/snap on or off.
 * @type {{ divisions: number }}
 */
const gridLattice = { divisions: 32 };
/** Fixed world extent (m) for GridHelper — matches logical cell spacing everywhere. */
const GRID_WORLD_EXTENT = 3.2;
/** Raises the whole lattice in world Y (m) — same value in `snapWorldPointToGrid` and grid dots. */
const GRID_LATTICE_Y_OFFSET = 0.32;
/** @type {THREE.Group | null} */
let grid3dGroupRef = null;
/** @type {THREE.MeshBasicMaterial | null} */
let gridDotsMaterialRef = null;

function gridCellSize() {
  return GRID_WORLD_EXTENT / gridLattice.divisions;
}

const GRID_LATTICE_STORAGE_KEY = "mxink-grid-divisions";

/** Slider “target” cell (m) → integer division count so visuals and snap stay identical. */
function applyGridLatticeFromSliderTarget(targetCellM) {
  if (!Number.isFinite(targetCellM) || targetCellM < 0.001) return;
  gridLattice.divisions = Math.max(1, Math.round(GRID_WORLD_EXTENT / targetCellM));
}

function persistGridLatticeDivisions() {
  try {
    localStorage.setItem(GRID_LATTICE_STORAGE_KEY, String(gridLattice.divisions));
  } catch (_) {
    /* ignore quota / private mode */
  }
}

/** Instanced sphere radius (m) at each voxel center — real meshes, not gl.POINTS (reliable on Quest). */
const GRID_DOT_RADIUS = 0.0018;
/** Visual-only: place dots every Nth lattice step along each axis (snap math unchanged). */
const GRID_DOT_VERTEX_STRIDE = 2;
const PICK_PROXIMITY_MAX_DIST = 0.35;
/** Endpoints closer than this (m) link strokes into one cluster (same grab object; separate meshes). */
const MERGE_STROKE_DIST = 0.048;
/**
 * MX Ink → WebXR Gamepad (Quest). Logitech OpenXR: cluster_front=click, cluster_middle=force, tip=force.
 * This app: draw = middle (force), erase = front (click). On Quest Browser, cluster_front is usually buttons[0], not [2].
 */
const CLUSTER_MIDDLE_DRAW_BTN_INDEX = 4;
const CLUSTER_FRONT_ERASER_BTN_INDEX = 0;
/** Rear: cluster_back_logitech/click — grab “pinch” with the other hand (never eraser). */
const REAR_PINCH_BTN_INDEX = 1;
/** Tip / axis force above this starts a stroke when middle barrel is not pressed firmly (surface drawing). */
const TIP_FORCE_DRAW_THRESHOLD = 0.008;
/** cluster_middle_logitech/force — firm press counts as barrel draw. */
const CLUSTER_MIDDLE_DRAW_THRESHOLD = 0.22;
/** cluster_front_logitech/click — light press activates eraser (boolean / short travel). */
const CLUSTER_FRONT_ERASER_ACTIVATE = 0.02;
const STROKE_WIDTH_MIN = 0.04;
const STROKE_WIDTH_MAX = 0.2;
const ERASE_RADIUS = 0.038;
const ERASE_RADIUS_SQ = ERASE_RADIUS * ERASE_RADIUS;

/** Voxel resolution along the shortest box edge (min edge / N). */
const BLOCK_VOXEL_DIV_N = 12;
const BLOCK_MAX_INSTANCES = 8192;
/** Warn if raw edge directions are farther than this from perpendicular (unit vectors dot). */
const BLOCK_EDGE_NON_ORTHOGONAL_DOT = 0.35;

/** Set each frame before input handlers; used to ignore select when stylus-side hand is pinching. */
let lastFingerPinchBlocksPen = false;

const _pickV = new THREE.Vector3();
const _pickMin = new THREE.Vector3();
const _pickMax = new THREE.Vector3();

const _ex = new THREE.Vector3();
const _ey = new THREE.Vector3();
const _ez = new THREE.Vector3();
const _ux = new THREE.Vector3();
const _uy = new THREE.Vector3();
const _uz = new THREE.Vector3();
const _oCorner = new THREE.Vector3();
const _voxelCenterW = new THREE.Vector3();
const _basisMat = new THREE.Matrix4();
const _voxelQuat = new THREE.Quaternion();
const _voxelScale = new THREE.Vector3();
const _instWorld = new THREE.Matrix4();
const _instLocal = new THREE.Matrix4();
const _parentInv = new THREE.Matrix4();

const FINGER_DEBUG_DEFS = [
  { joint: "thumb-tip", color: 0xff4444, label: "T" },
  { joint: "index-finger-tip", color: 0x44ff44, label: "I" },
  { joint: "middle-finger-tip", color: 0x4444ff, label: "M" },
  { joint: "ring-finger-tip", color: 0xffff44, label: "R" },
  { joint: "pinky-finger-tip", color: 0xff44ff, label: "P" },
];

/** @type {Array<{ joint: string; group: THREE.Group }>} */
let leftFingerDebugGroups = [];
/** @type {Array<{ joint: string; group: THREE.Group }>} */
let rightFingerDebugGroups = [];

const sizes = {
  width: window.innerWidth,
  height: window.innerHeight,
};

/** HUD in world space; eased toward camera-local offset (not rigid head-child). */
let hudGroup = null;
/** @type {THREE.Mesh | null} */
let hudTimePlane = null;
let hudLastClockSec = -1;
/** Camera-local anchor: +Y up, −Z forward (m). */
const HUD_LOCAL_OFFSET = new THREE.Vector3(0, 0.12, -2);
/** World size vs previous design (0.38 m tall): 70% smaller → 30% scale. */
const HUD_WORLD_SCALE = 0.3;
/** Exponential follow ~stiffness (higher = snappier). */
const HUD_FOLLOW_LAMBDA = 6.5;
const _hudTargetWorld = new THREE.Vector3();
const _hudTargetQuat = new THREE.Quaternion();
let hudFollowLastMs = null;

init();

/** Lucide icon tree: array of [tag, attrs] (see lucide package). ViewBox is 24×24. */
function drawLucideIconNode(ctx, iconNode) {
  for (const item of iconNode) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [tag, attrs] = item;
    if (tag === "path" && attrs && attrs.d) {
      const p = new Path2D(attrs.d);
      if (attrs.fill && attrs.fill !== "none") {
        ctx.fill(p);
      }
      if (attrs.stroke === "none") continue;
      ctx.stroke(p);
    } else if (tag === "circle" && attrs) {
      const cx = Number(attrs.cx);
      const cy = Number(attrs.cy);
      const r = Number(attrs.r);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (attrs.fill && attrs.fill !== "none") {
        ctx.fill();
      }
      if (attrs.stroke === "none") continue;
      ctx.stroke();
    }
  }
}

/** Sprite label using a Lucide icon (e.g. pinky blocks mode, left index 3D transform). */
function makeLucideFingerSprite(iconNode, lucideIconId = "lucide") {
  const size = 72;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  paintLucideFingerSpriteCanvas(ctx, size, iconNode, {
    bgFill: "rgba(0,0,0,0.55)",
    borderStroke: "rgba(255,255,255,0.9)",
  });
  const tex = new THREE.CanvasTexture(canvas);
  if ("colorSpace" in tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, toneMapped: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.011, 0.011, 0.011);
  sprite.userData.lucideIcon = lucideIconId;
  return sprite;
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size
 * @param {unknown} iconNode
 * @param {{ bgFill: string; borderStroke: string }} style
 */
function paintLucideFingerSpriteCanvas(ctx, size, iconNode, style) {
  ctx.fillStyle = style.bgFill;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = style.borderStroke;
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, size - 4, size - 4);
  const pad = 10;
  const side = size - pad * 2;
  ctx.save();
  ctx.translate(pad, pad);
  ctx.scale(side / 24, side / 24);
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawLucideIconNode(ctx, iconNode);
  ctx.restore();
}

/** Redraw ring-finger grid sprites when snap mode changes (background shows active state). */
function updateRingGridSnapIndicatorSprites() {
  if (lastRingSnapSpriteState === snapToGridEnabled && lastRingSnapSpriteState !== null) return;
  lastRingSnapSpriteState = snapToGridEnabled;
  const active = snapToGridEnabled;
  const bgFill = active ? "rgba(0,72,48,0.88)" : "rgba(0,0,0,0.5)";
  const borderStroke = active ? "rgba(140,255,190,0.95)" : "rgba(255,255,255,0.75)";
  for (const sprite of ringGridSnapSprites) {
    const iconNode = sprite.userData.gridSnapIconNode;
    const tex = sprite.material.map;
    const canvas = tex && tex.image;
    if (!iconNode || !canvas || !canvas.getContext) continue;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    paintLucideFingerSpriteCanvas(ctx, canvas.width, iconNode, { bgFill, borderStroke });
    tex.needsUpdate = true;
  }
}

function makeFingerLabelSprite(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 48;
  canvas.height = 48;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, 48, 48);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 46, 46);
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 24, 24);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, toneMapped: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.006, 0.006, 0.006);
  return sprite;
}

function createTimeHud() {
  const canvas = document.createElement("canvas");
  canvas.width = 840;
  canvas.height = 168;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const tex = new THREE.CanvasTexture(canvas);
  if ("colorSpace" in tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  // 2 m viewing distance; plane size scaled by HUD_WORLD_SCALE (70% smaller than prior).
  const planeH = 0.38 * HUD_WORLD_SCALE;
  const aspect = canvas.width / canvas.height;
  const planeW = planeH * aspect;
  const geom = new THREE.PlaneGeometry(planeW, planeH);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 999999;
  mesh.frustumCulled = false;
  mesh.userData.hudCanvas = canvas;
  mesh.userData.hudCtx = ctx;
  mesh.userData.hudTex = tex;
  mesh.userData.hudClockIcon = Clock;
  const group = new THREE.Group();
  group.name = "hud-time";
  group.frustumCulled = false;
  group.add(mesh);
  return { group, mesh };
}

/**
 * Ease HUD position/orientation toward the rigid head-locked target (camera-local offset).
 * Call each frame before render; uses exponential smoothing for a slight lag behind the head.
 */
function updateHudFollow(timeMs) {
  if (!hudGroup) return;
  const t = typeof timeMs === "number" && Number.isFinite(timeMs) ? timeMs : performance.now();
  const dtSec =
    hudFollowLastMs == null ? 0 : Math.min(0.1, Math.max(0, (t - hudFollowLastMs) * 0.001));
  hudFollowLastMs = t;

  _hudTargetWorld.copy(HUD_LOCAL_OFFSET);
  camera.localToWorld(_hudTargetWorld);
  camera.getWorldQuaternion(_hudTargetQuat);

  if (dtSec <= 0) {
    hudGroup.position.copy(_hudTargetWorld);
    hudGroup.quaternion.copy(_hudTargetQuat);
    return;
  }

  const alpha = 1 - Math.exp(-HUD_FOLLOW_LAMBDA * dtSec);
  hudGroup.position.lerp(_hudTargetWorld, alpha);
  hudGroup.quaternion.slerp(_hudTargetQuat, alpha);
}

function updateHudClock() {
  if (!hudTimePlane) return;
  const { hudCanvas: canvas, hudCtx: ctx, hudTex: tex, hudClockIcon: iconNode } = hudTimePlane.userData;
  if (!canvas || !ctx || !tex) return;
  const t = Math.floor(Date.now() / 1000);
  if (t === hudLastClockSec) return;
  hudLastClockSec = t;
  const timeStr = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const margin = 10;
  const rx = 26;
  const x0 = margin;
  const y0 = margin;
  const bw = w - margin * 2;
  const bh = h - margin * 2;

  const g = ctx.createLinearGradient(x0, y0, x0 + bw, y0 + bh);
  g.addColorStop(0, "rgba(18, 24, 34, 0.94)");
  g.addColorStop(0.5, "rgba(12, 16, 24, 0.92)");
  g.addColorStop(1, "rgba(8, 11, 18, 0.9)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(x0, y0, bw, bh, rx);
  ctx.fill();

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.strokeStyle = "rgba(120, 190, 255, 0.45)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x0 + 0.5, y0 + 0.5, bw - 1, bh - 1, rx - 0.5);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x0 + 1.5, y0 + 1.5, bw - 3, bh - 3, rx - 2);
  ctx.stroke();

  const iconPx = 64;
  const iconPad = 28;
  const iconY = h / 2 - iconPx / 2;
  ctx.save();
  ctx.translate(iconPad, iconY);
  ctx.scale(iconPx / 24, iconPx / 24);
  ctx.strokeStyle = "rgba(186, 220, 255, 0.95)";
  ctx.fillStyle = "rgba(186, 220, 255, 0.95)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (iconNode) {
    drawLucideIconNode(ctx, iconNode);
  }
  ctx.restore();

  const textX = iconPad + iconPx + 22;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = '600 52px "SF Pro Display", system-ui, sans-serif';
  ctx.fillStyle = "rgba(248, 250, 255, 0.98)";
  ctx.fillText(timeStr, textX, h / 2 - 10);
  ctx.font = '500 15px system-ui, sans-serif';
  ctx.fillStyle = "rgba(180, 195, 220, 0.65)";
  ctx.fillText("Local time", textX, h / 2 + 24);

  tex.needsUpdate = true;
}

function axisToTip01(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  const abs = Math.abs(v);
  if (abs < 1e-4) return 0;
  return Math.min(1, v >= 0 && v <= 1 ? v : v >= -1 && v <= 1 ? (v + 1) * 0.5 : abs);
}

/** True if that gamepad slot exists and is pressed/touched or over threshold (avoids silent fail on missing index). */
function isGamepadButtonActive(gp, index, valueThreshold) {
  if (!gp || !gp.buttons || index < 0 || index >= gp.buttons.length) return false;
  const b = gp.buttons[index];
  if (!b) return false;
  return (
    (b.value ?? 0) > valueThreshold || b.pressed === true || b.touched === true
  );
}

/**
 * Tip / surface pressure: axes + optional button 0 only when 0 is NOT cluster_front (eraser).
 * If cluster_front maps to buttons[0], including b0 here makes “erase” also drive tipDraw — front must not add to draw.
 */
function getTipForce01() {
  if (!gamepad1) return 0;
  let t = 0;
  const b0 = gamepad1.buttons[0];
  if (b0 && CLUSTER_FRONT_ERASER_BTN_INDEX !== 0) {
    t = Math.max(t, b0.value ?? 0);
  }
  const ax = gamepad1.axes;
  if (!ax || ax.length === 0) return Math.min(1, Math.max(0, t));

  let tAxis = 0;
  const skipStick = ax.length >= 4;
  for (let i = 0; i < ax.length; i++) {
    if (skipStick && (i === 0 || i === 1)) continue;
    tAxis = Math.max(tAxis, axisToTip01(ax[i]));
  }
  if (tAxis < 0.02 && skipStick) {
    for (let i = 0; i < Math.min(2, ax.length); i++) {
      tAxis = Math.max(tAxis, axisToTip01(ax[i]));
    }
  }
  if (tAxis < 0.02 && ax.length <= 3) {
    for (let i = 0; i < ax.length; i++) {
      tAxis = Math.max(tAxis, axisToTip01(ax[i]));
    }
  }
  t = Math.max(t, tAxis);
  return Math.min(1, Math.max(0, t));
}

function getPressureStrokeWidth() {
  if (!gamepad1) return (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
  const btn = gamepad1.buttons[CLUSTER_MIDDLE_DRAW_BTN_INDEX];
  const btnT = btn ? Math.min(1, Math.max(0, btn.value ?? 0)) : 0;
  const tipT = getTipForce01();
  const t = Math.min(1, Math.max(btnT, tipT));
  return STROKE_WIDTH_MIN + t * (STROKE_WIDTH_MAX - STROKE_WIDTH_MIN);
}

/** Pen body direction in world space (tip −Z in controller space), for twist like a finger vector. */
function penAxisWorldInto(out) {
  if (!stylus) return false;
  stylus.getWorldQuaternion(_quat);
  out.set(0, 0, -1).applyQuaternion(_quat).normalize();
  return true;
}

/**
 * Snap to the same axis lines as THREE.GridHelper (see GridHelper: k = -halfSize + i * step).
 * Using round(v/step)*step is wrong when divisions is odd — lines are not all multiples of step from 0.
 * Operates in `sceneContentRoot` local space so the lattice stays aligned when the content root moves.
 */
function snapWorldPointToGrid(out) {
  sceneContentRoot.updateMatrixWorld(true);
  sceneContentRoot.worldToLocal(out);
  const size = GRID_WORLD_EXTENT;
  const div = gridLattice.divisions;
  const step = size / div;
  const halfSize = size * 0.5;
  const oy = GRID_LATTICE_Y_OFFSET;
  const snapAxis = (v) => {
    const i = Math.round((v + halfSize) / step);
    return -halfSize + i * step;
  };
  const snapAxisY = (v) => {
    const i = Math.round((v - oy + halfSize) / step);
    return oy + (-halfSize + i * step);
  };
  out.x = snapAxis(out.x);
  out.y = snapAxisY(out.y);
  out.z = snapAxis(out.z);
  sceneContentRoot.localToWorld(out);
}

/**
 * Snap stroke root: world rotation to 90° steps, then translate so bbox center sits on a lattice
 * point (same as drawing snap). Does not check snapToGridEnabled — use for grab + “snap all”.
 *
 * Rotation must be applied before choosing the target lattice point: snapping the pre-rotation
 * center then rotating leaves an inconsistent pose vs the grid; we snap center after rotation.
 */
function snapMeshStrokeToGrid(mesh) {
  if (!mesh) return;
  strokesGroup.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  const cl = ensureMeshCenterLocal(mesh);

  mesh.getWorldQuaternion(_qWorldGrab);
  _eulerGrabSnap.setFromQuaternion(_qWorldGrab, "YXZ");
  _eulerGrabSnap.order = "YXZ";
  const halfPi = Math.PI / 2;
  _eulerGrabSnap.x = Math.round(_eulerGrabSnap.x / halfPi) * halfPi;
  _eulerGrabSnap.y = Math.round(_eulerGrabSnap.y / halfPi) * halfPi;
  _eulerGrabSnap.z = Math.round(_eulerGrabSnap.z / halfPi) * halfPi;
  _qSnapRot.setFromEuler(_eulerGrabSnap);
  if (mesh.parent) {
    mesh.parent.getWorldQuaternion(_snapParentQuat);
    mesh.quaternion.copy(_snapParentQuat).invert().multiply(_qSnapRot);
  } else {
    mesh.quaternion.copy(_qSnapRot);
  }

  strokesGroup.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  _pickV.copy(cl);
  mesh.localToWorld(_pickV);
  snapWorldPointToGrid(_pickV);
  _snapTargetCenter.copy(_pickV);

  mesh.position.set(0, 0, 0);
  strokesGroup.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  _pickV.copy(cl);
  mesh.localToWorld(_pickV);
  _snapDeltaWorld.copy(_snapTargetCenter).sub(_pickV);
  mesh.getWorldPosition(_meshWorld);
  _meshWorld.add(_snapDeltaWorld);
  mesh.position.copy(_meshWorld);
  if (mesh.parent) mesh.parent.worldToLocal(mesh.position);
}

/**
 * Snap stroke center to lattice without re-quantizing rotation. Use while dragging one-hand so
 * float drift in quaternions cannot re-round euler and shift the mesh on the first move frame.
 */
function snapMeshStrokeToGridTranslateOnly(mesh) {
  if (!mesh) return;
  strokesGroup.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  const cl = ensureMeshCenterLocal(mesh);
  _pickV.copy(cl);
  mesh.localToWorld(_pickV);
  snapWorldPointToGrid(_pickV);
  _snapTargetCenter.copy(_pickV);

  mesh.position.set(0, 0, 0);
  strokesGroup.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  _pickV.copy(cl);
  mesh.localToWorld(_pickV);
  _snapDeltaWorld.copy(_snapTargetCenter).sub(_pickV);
  mesh.getWorldPosition(_meshWorld);
  _meshWorld.add(_snapDeltaWorld);
  mesh.position.copy(_meshWorld);
  if (mesh.parent) mesh.parent.worldToLocal(mesh.position);
}

/**
 * @param {boolean} [rotateSnap] When true (two-hand), full rotation+position snap. One-hand drag should pass false.
 */
function snapGrabbedMeshStrokeToGrid(mesh, rotateSnap = true) {
  if (!snapToGridEnabled || !mesh) return;
  if (rotateSnap) snapMeshStrokeToGrid(mesh);
  else snapMeshStrokeToGridTranslateOnly(mesh);
}

function invalidateStrokeMeshCenterLocals() {
  strokesGroup.traverse((o) => {
    if (o.userData) delete o.userData.centerLocal;
  });
}

function snapAllStrokeRootsToGrid() {
  strokesGroup.updateMatrixWorld(true);
  for (const ch of strokesGroup.children) {
    snapMeshStrokeToGrid(ch);
  }
}

/** New grab while snap is on: align root to lattice once, then offset = origin − ref (same frame). */
function snapGrabbedRootAtGrabStart(root, refWorldPos) {
  if (!snapToGridEnabled || !root) return;
  _grabRefSnap.copy(refWorldPos);
  snapMeshStrokeToGrid(root);
  strokesGroup.updateMatrixWorld(true);
  root.getWorldPosition(_meshWorld);
  grabOffsetWorld.copy(_meshWorld).sub(_grabRefSnap);
}

/** After snap moves the mesh, resync grab offset so the next frame uses stylus + correct offset. */
function refreshGrabOffsetAfterSnapStylus() {
  if (!grabbedMesh || !stylus) return;
  strokesGroup.updateMatrixWorld(true);
  grabbedMesh.updateMatrixWorld(true);
  grabbedMesh.getWorldPosition(_meshWorld);
  grabOffsetWorld.copy(_meshWorld).sub(stylus.position);
}

function refreshGrabOffsetAfterSnapIndex(indexTipWorld) {
  if (!grabbedMesh) return;
  strokesGroup.updateMatrixWorld(true);
  grabbedMesh.updateMatrixWorld(true);
  grabbedMesh.getWorldPosition(_meshWorld);
  grabOffsetWorld.copy(_meshWorld).sub(indexTipWorld);
}

function updateGridDotsInkUniform() {
  const u = gridDotsMaterialRef?.userData?.gridInkUniforms;
  if (!u) return;
  if (renderer?.xr?.isPresenting && stylus) {
    u.uInkPos.value.copy(stylus.position);
    u.uInkActive.value = 1.0;
  } else {
    u.uInkActive.value = 0.0;
  }
}

/**
 * Dots on a subsampled set of lattice vertices (same spacing as snap; see GRID_DOT_VERTEX_STRIDE).
 */
function rebuildGrid3dVisuals() {
  if (!grid3dGroupRef) return;
  gridDotsMaterialRef = null;
  const divisions = gridLattice.divisions;
  while (grid3dGroupRef.children.length) {
    const ch = grid3dGroupRef.children[0];
    grid3dGroupRef.remove(ch);
    if (ch.geometry) ch.geometry.dispose();
    if (ch.material) ch.material.dispose();
  }

  const size = GRID_WORLD_EXTENT;
  const div = divisions;
  const step = size / div;
  const halfSize = size * 0.5;
  const n = div + 1;
  const s = Math.max(1, GRID_DOT_VERTEX_STRIDE);
  const nAxis = 1 + Math.floor((n - 1) / s);

  const count = nAxis * nAxis * nAxis;
  const positions = new Float32Array(count * 3);
  let p = 0;
  const oy = GRID_LATTICE_Y_OFFSET;
  for (let ii = 0; ii < nAxis; ii++) {
    const i = ii * s;
    const x = -halfSize + i * step;
    for (let jj = 0; jj < nAxis; jj++) {
      const j = jj * s;
      const y = -halfSize + j * step + oy;
      for (let kk = 0; kk < nAxis; kk++) {
        const k = kk * s;
        const z = -halfSize + k * step;
        positions[p++] = x;
        positions[p++] = y;
        positions[p++] = z;
      }
    }
  }

  const sphereGeom = new THREE.SphereGeometry(GRID_DOT_RADIUS, 6, 6);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xe8e8e8,
    transparent: true,
    opacity: 0.52,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  mat.userData.gridInkUniforms = null;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uInkPos = { value: new THREE.Vector3(0, -999, 0) };
    shader.uniforms.uInkActive = { value: 0 };
    shader.uniforms.uGlowRadius = { value: 0.105 };
    shader.uniforms.uAlphaDim = { value: 0.11 };
    shader.uniforms.uAlphaBright = { value: 0.7 };
    mat.userData.gridInkUniforms = shader.uniforms;

    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
varying vec3 vGridWorldPos;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `#include <project_vertex>
vec4 _wp = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
_wp = instanceMatrix * _wp;
#endif
vGridWorldPos = ( modelMatrix * _wp ).xyz;`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
varying vec3 vGridWorldPos;
uniform vec3 uInkPos;
uniform float uInkActive;
uniform float uGlowRadius;
uniform float uAlphaDim;
uniform float uAlphaBright;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      `{
float inkD = distance( vGridWorldPos, uInkPos );
float inkG = uInkActive > 0.5 ? exp( -(inkD * inkD) / max(uGlowRadius * uGlowRadius, 1e-6) ) : 0.0;
diffuseColor.a *= mix( uAlphaDim, uAlphaBright, inkG );
}
#include <opaque_fragment>`,
    );
  };

  gridDotsMaterialRef = mat;

  const inst = new THREE.InstancedMesh(sphereGeom, mat, count);
  const mtx = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < count; i++) {
    pos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    mtx.compose(pos, quat, scl);
    inst.setMatrixAt(i, mtx);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  inst.renderOrder = -50;
  grid3dGroupRef.add(inst);
}

function initGridLatticeFromSliderDom() {
  const slider = document.getElementById("grid-cell-slider");
  if (!slider) return;
  try {
    const raw = localStorage.getItem(GRID_LATTICE_STORAGE_KEY);
    if (raw != null) {
      const d = parseInt(raw, 10);
      if (Number.isFinite(d) && d >= 1 && d <= 100000) {
        gridLattice.divisions = d;
        slider.value = String((GRID_WORLD_EXTENT / d).toFixed(5));
        return;
      }
    }
  } catch (_) {
    /* ignore */
  }
  applyGridLatticeFromSliderTarget(parseFloat(slider.value));
}

function wireGridCellSlider() {
  const slider = document.getElementById("grid-cell-slider");
  const valEl = document.getElementById("grid-cell-value");
  if (!slider || !valEl) return;
  valEl.textContent = gridCellSize().toFixed(4);
  slider.addEventListener("input", () => {
    const t = parseFloat(slider.value);
    if (!Number.isFinite(t)) return;
    applyGridLatticeFromSliderTarget(t);
    persistGridLatticeDivisions();
    valEl.textContent = gridCellSize().toFixed(4);
    rebuildGrid3dVisuals();
  });
}

/**
 * Axis-aligned steps from p0Ref toward p1 (both on grid). Keeps tube segments on grid edges only.
 * Updates p0Ref to p1 when done.
 */
function emitManhattanSnapSegments(painter, strokeWidth, p0Ref, p1) {
  const eps = 1e-6;
  let x = p0Ref.x;
  let y = p0Ref.y;
  let z = p0Ref.z;
  const step = (nx, ny, nz) => {
    if (Math.abs(nx - x) < eps && Math.abs(ny - y) < eps && Math.abs(nz - z) < eps) return;
    _manhSeg.set(nx, ny, nz);
    strokeMeshLocalFromWorld(_strokeMeshLocal, _manhSeg);
    painter.setSize(strokeWidth);
    painter.mesh.userData.strokeWidth = strokeWidth;
    painter.lineTo(_strokeMeshLocal);
    painter.update();
    appendStrokePointWorld(_manhSeg);
    x = nx;
    y = ny;
    z = nz;
  };
  if (Math.abs(p1.x - x) > eps) step(p1.x, y, z);
  if (Math.abs(p1.y - y) > eps) step(x, p1.y, z);
  if (Math.abs(p1.z - z) > eps) step(x, y, p1.z);
  p0Ref.copy(p1);
}

/**
 * TubePainter writes buffer positions in mesh space; MX Ink gives world-space tip positions.
 * Must match `appendStrokePointWorld` (used for userData.points / serialize) or strokes drift until rebuild.
 */
function strokeMeshLocalFromWorld(out, worldVec) {
  if (!currentStrokePainter) return out.set(0, 0, 0);
  const mesh = currentStrokePainter.mesh;
  strokesGroup.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  out.copy(worldVec);
  mesh.worldToLocal(out);
  return out;
}

function appendStrokePointWorld(worldVec) {
  if (!currentStrokePainter) return;
  strokeMeshLocalFromWorld(_pickV, worldVec);
  currentStrokePointsLocal.push(_pickV.clone());
}

function beginStroke(worldPoint) {
  if (!currentStrokePainter) {
    currentStrokePainter = new TubePainter();
    currentStrokePainter.mesh.material = material;
    const w = getPressureStrokeWidth();
    currentStrokePainter.setSize(w);
    currentStrokePainter.mesh.userData.strokeWidth = w;
    strokesGroup.add(currentStrokePainter.mesh);
    currentStrokePointsLocal = [];
  }
  _snapScratch.copy(worldPoint);
  if (snapToGridEnabled) snapWorldPointToGrid(_snapScratch);
  _lastStrokeSnapWorld.copy(_snapScratch);
  strokeMeshLocalFromWorld(_strokeMeshLocal, _snapScratch);
  currentStrokePainter.moveTo(_strokeMeshLocal);
  appendStrokePointWorld(_snapScratch);
  _lastStrokeSampleWorld.copy(_snapScratch);
}

function isStrokeActive() {
  if (!gamepad1) return false;
  if (isDrawing) return true;
  return !!(currentStrokePainter && _eraserThisFrame);
}

/** Avoid deserializeSceneV1 while a stroke or grab holds live scene refs (sync is secondary to local UX). */
function shouldDeferSketcharSceneApply() {
  return (
    isStrokeActive() ||
    currentStrokePainter !== null ||
    grabMode !== "none"
  );
}

function isDrawingOrSelecting() {
  if (!gamepad1) return false;
  return isDrawing || _eraserThisFrame;
}

function isRearButtonHeld() {
  if (!gamepad1 || !gamepad1.buttons[REAR_PINCH_BTN_INDEX]) return false;
  const b = gamepad1.buttons[REAR_PINCH_BTN_INDEX];
  return (b.value > 0.45 || b.pressed) === true;
}

/** cluster_front (eraser) — handleErase still ray-picks strokes at the tip. */
function isEraserHeld() {
  if (!gamepad1) return false;
  return _eraserThisFrame;
}

/** While drawing with MX Ink, block pinch-grab only on the hand that matches the stylus. */
function handGrabBlockedWhileDrawing(inputSource) {
  if (!isDrawingOrSelecting()) return false;
  if (stylusHandedness === "none" || inputSource.handedness === "none") {
    return false;
  }
  return inputSource.handedness === stylusHandedness;
}

function init() {
  const canvas = document.querySelector("canvas.webgl");
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222222);
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 50);
  camera.position.set(0, 1.6, 3);
  // Must be in the scene graph so renderer traversal reaches camera children (HUD, etc.).
  scene.add(camera);

  const timeHud = createTimeHud();
  if (timeHud) {
    hudGroup = timeHud.group;
    hudTimePlane = timeHud.mesh;
    scene.add(hudGroup);
    hudFollowLastMs = null;
    hudLastClockSec = -1;
    updateHudClock();
  }

  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("/draco/");

  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  grid3dGroupRef = new THREE.Group();
  grid3dGroupRef.name = "grid-3d";
  grid3dGroupRef.visible = snapToGridEnabled;
  sceneContentRoot.add(strokesGroup);
  sceneContentRoot.add(grid3dGroupRef);
  scene.add(sceneContentRoot);
  initGridLatticeFromSliderDom();
  rebuildGrid3dVisuals();
  wireGridCellSlider();
  persistGridLatticeDivisions();

  scene.add(new THREE.HemisphereLight(0x888877, 0x777788, 3));

  const light = new THREE.DirectionalLight(0xffffff, 1.5);
  light.position.set(0, 4, 0);
  scene.add(light);

  const dbgGeom = new THREE.SphereGeometry(0.007, 10, 10);
  function addHandFingerMarkers(targetArr, handName) {
    for (const def of FINGER_DEBUG_DEFS) {
      const group = new THREE.Group();
      group.name = `finger-debug-${handName}-${def.joint}`;
      group.visible = false;
      group.renderOrder = 5;
      const sphere = new THREE.Mesh(
        dbgGeom,
        new THREE.MeshBasicMaterial({
          color: def.color,
          depthTest: true,
          depthWrite: true,
          toneMapped: false,
        }),
      );
      group.add(sphere);
      let label = null;
      if (def.joint === "pinky-finger-tip") {
        if (handName === "left") {
          label = makeLucideFingerSprite(Boxes, "boxes");
        } else {
          label = makeLucideFingerSprite(Grid3x3, "grid-3x3");
          if (label) {
            label.userData.gridSnapIconNode = Grid3x3;
            ringGridSnapSprites.push(label);
          }
        }
      } else if (def.joint === "ring-finger-tip") {
        label = makeFingerLabelSprite(def.label);
      } else if (handName === "left" && def.joint === "index-finger-tip") {
        label = makeLucideFingerSprite(Axis3d, "axis3d");
      } else {
        label = makeFingerLabelSprite(def.label);
      }
      if (label) {
        label.position.set(0.012, 0.008, 0);
        label.renderOrder = 6;
        group.add(label);
      }
      scene.add(group);
      targetArr.push({ joint: def.joint, group });
    }
  }
  addHandFingerMarkers(leftFingerDebugGroups, "left");
  addHandFingerMarkers(rightFingerDebugGroups, "right");
  lastRingSnapSpriteState = null;
  updateRingGridSnapIndicatorSprites();

  renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
  renderer.setPixelRatio(window.devicePixelRatio, 2);
  renderer.setSize(sizes.width, sizes.height);
  renderer.setAnimationLoop(animate);
  renderer.xr.enabled = true;
  document.body.appendChild(
    XRButton.createButton(renderer, { optionalFeatures: ["unbounded", "hand-tracking"] }),
  );

  const controllerModelFactory = new XRControllerModelFactory();

  controller1 = renderer.xr.getController(0);
  controller1.addEventListener("connected", onControllerConnected);
  controller1.addEventListener("selectstart", onSelectStart);
  controller1.addEventListener("selectend", onSelectEnd);
  controllerGrip1 = renderer.xr.getControllerGrip(0);
  controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
  scene.add(controllerGrip1);
  scene.add(controller1);

  controller2 = renderer.xr.getController(1);
  controller2.addEventListener("connected", onControllerConnected);
  controller2.addEventListener("selectstart", onSelectStart);
  controller2.addEventListener("selectend", onSelectEnd);
  controllerGrip2 = renderer.xr.getControllerGrip(1);
  controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
  scene.add(controllerGrip2);
  scene.add(controller2);

  initSketcharUI();
}

window.addEventListener("resize", () => {
  sizes.width = window.innerWidth;
  sizes.height = window.innerHeight;

  camera.aspect = sizes.width / sizes.height;
  camera.updateProjectionMatrix();

  renderer.setSize(sizes.width, sizes.height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

function jointPositionFromPose(pose, target) {
  const p = pose.transform.position;
  target.set(p.x, p.y, p.z);
  return target;
}

function rayDirFromIndexTipPose(pose) {
  const o = pose.transform.orientation;
  _quat.set(o.x, o.y, o.z, o.w);
  _rayDir.set(0, 0, -1).applyQuaternion(_quat).normalize();
  return _rayDir;
}

function updateStrokeBoundingSphereFromDrawRange(mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  if (!pos) return;
  const dr = geo.drawRange;
  const start = dr.start;
  const count = dr.count;
  if (count === 0) return;
  _pickV.fromBufferAttribute(pos, start);
  _pickMin.copy(_pickV);
  _pickMax.copy(_pickV);
  for (let i = 1; i < count; i++) {
    _pickV.fromBufferAttribute(pos, start + i);
    _pickMin.min(_pickV);
    _pickMax.max(_pickV);
  }
  const cx = (_pickMin.x + _pickMax.x) * 0.5;
  const cy = (_pickMin.y + _pickMax.y) * 0.5;
  const cz = (_pickMin.z + _pickMax.z) * 0.5;
  let maxR2 = 0;
  for (let i = 0; i < count; i++) {
    _pickV.fromBufferAttribute(pos, start + i);
    const dx = _pickV.x - cx;
    const dy = _pickV.y - cy;
    const dz = _pickV.z - cz;
    maxR2 = Math.max(maxR2, dx * dx + dy * dy + dz * dz);
  }
  if (!geo.boundingSphere) geo.boundingSphere = new THREE.Sphere();
  geo.boundingSphere.center.set(cx, cy, cz);
  geo.boundingSphere.radius = Math.sqrt(maxR2) + 0.003;
}

/** Walk up to the stroke cluster group (or the mesh) used for grab / two-hand pivot. */
function getStrokeGrabRoot(obj) {
  let o = obj;
  while (o.parent && o.parent.userData && o.parent.userData.isStrokeCluster) {
    o = o.parent;
  }
  return o;
}

function sameGrabTarget(a, b) {
  return getStrokeGrabRoot(a) === getStrokeGrabRoot(b);
}

function pickStrokeMesh(origin, direction) {
  raycaster.set(origin, direction);
  raycaster.far = 10;
  const hits = raycaster.intersectObjects(strokesGroup.children, true);
  if (hits.length > 0) return hits[0].object;

  let best = null;
  let bestDist = Infinity;
  strokesGroup.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry) return;
    if (mesh.isInstancedMesh) {
      if (mesh.boundingSphere === null) mesh.computeBoundingSphere();
      _pickSphere.copy(mesh.boundingSphere);
    } else {
      updateStrokeBoundingSphereFromDrawRange(mesh);
      if (!mesh.geometry.boundingSphere) return;
      _pickSphere.copy(mesh.geometry.boundingSphere);
    }
    _pickSphere.applyMatrix4(mesh.matrixWorld);
    const d = _pickSphere.distanceToPoint(origin);
    if (d < PICK_PROXIMITY_MAX_DIST && d < bestDist) {
      best = mesh;
      bestDist = d;
    }
  });
  return best;
}

function pickStrokeMeshFromStylusTip() {
  if (!stylus) return null;
  stylus.getWorldQuaternion(_quat);
  _rayDir.set(0, 0, -1).applyQuaternion(_quat).normalize();
  return pickStrokeMesh(stylus.position, _rayDir);
}

function updateFingerDebugGroups(frame, session, refSpace, groups, handedness) {
  for (const { group } of groups) {
    group.visible = false;
  }

  let src = null;
  for (const inputSource of session.inputSources) {
    if (inputSource.hand && inputSource.handedness === handedness) {
      src = inputSource;
      break;
    }
  }
  if (!src) return;

  const hand = src.hand;
  for (const { joint, group } of groups) {
    const space = hand.get(joint);
    if (!space) continue;
    const pose = frame.getPose(space, refSpace);
    if (!pose) continue;
    const p = pose.transform.position;
    const o = pose.transform.orientation;
    group.position.set(p.x, p.y, p.z);
    group.quaternion.set(o.x, o.y, o.z, o.w);
    group.visible = true;
  }
}

function updateFingerDebug(frame, session) {
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) return;
  updateFingerDebugGroups(frame, session, refSpace, leftFingerDebugGroups, "left");
  updateFingerDebugGroups(frame, session, refSpace, rightFingerDebugGroups, "right");
}

function releaseGrab() {
  grabbedMesh = null;
  grabInputSource = null;
  grabInputIsStylus = false;
  twoHandStylusSide = null;
  grabMode = "none";
  twoGrabLeft = null;
  twoGrabRight = null;
}

/** Rear “pinch” when not drawing — grab / two-hand with the other hand. */
function isStylusGrabForManip() {
  return isRearButtonHeld() && !isDrawingOrSelecting();
}

function getIndexTipWorldInto(frame, refSpace, hand, target) {
  const indexTip = hand.get("index-finger-tip");
  if (!indexTip) return false;
  const pose = frame.getPose(indexTip, refSpace);
  if (!pose) return false;
  jointPositionFromPose(pose, target);
  return true;
}

function getMiddleFingerWorldInto(frame, refSpace, hand, target) {
  const mid = hand.get("middle-finger-tip");
  if (!mid) return false;
  const pose = frame.getPose(mid, refSpace);
  if (!pose) return false;
  jointPositionFromPose(pose, target);
  return true;
}

/** Midpoint between thumb-tip and middle-finger-tip (thumb–middle pinch anchor). */
function getThumbMiddleAnchorWorldInto(frame, refSpace, hand, target) {
  const thumbTip = hand.get("thumb-tip");
  const midTip = hand.get("middle-finger-tip");
  if (!thumbTip || !midTip) return false;
  const tp = frame.getPose(thumbTip, refSpace);
  const mp = frame.getPose(midTip, refSpace);
  if (!tp || !mp) return false;
  jointPositionFromPose(tp, _thumbTipPos);
  jointPositionFromPose(mp, sm_middleTip);
  target.copy(_thumbTipPos).add(sm_middleTip).multiplyScalar(0.5);
  return true;
}

function fillThumbMiddleSceneSlot(inputSource, frame, refSpace, slot) {
  slot.valid = false;
  const hand = inputSource.hand;
  if (!hand) return;
  const thumbTip = hand.get("thumb-tip");
  const indexTip = hand.get("index-finger-tip");
  const midTip = hand.get("middle-finger-tip");
  if (!thumbTip || !indexTip || !midTip) return;
  const tp = frame.getPose(thumbTip, refSpace);
  const ip = frame.getPose(indexTip, refSpace);
  const mp = frame.getPose(midTip, refSpace);
  if (!tp || !ip || !mp) return;
  jointPositionFromPose(tp, _thumbTipPos);
  jointPositionFromPose(ip, _indexTipPos);
  jointPositionFromPose(mp, sm_middleTip);
  const dTm = _thumbTipPos.distanceTo(sm_middleTip);
  const dTi = _thumbTipPos.distanceTo(_indexTipPos);
  const wasPinched = thumbMiddlePinchPrev.get(inputSource) === true;
  const isPinched = wasPinched ? dTm < PINCH_OPEN_DIST : dTm < PINCH_CLOSE_DIST;
  thumbMiddlePinchPrev.set(inputSource, isPinched);
  const stylusSideSceneOk =
    stylusHandedness !== "none" &&
    inputSource.handedness === stylusHandedness &&
    isStylusGrabForManip();
  if (dTi <= PINCH_OPEN_DIST && !stylusSideSceneOk) return;
  slot.valid = true;
  slot.isPinched = isPinched;
  slot.wasPinched = wasPinched;
  slot.inputSource = inputSource;
  slot.hand = hand;
  slot.anchor.copy(_thumbTipPos).add(sm_middleTip).multiplyScalar(0.5);
}

function canSceneManip() {
  if (grabMode !== "none") return false;
  if (isDrawing || isStrokeActive()) return false;
  if (isEraserHeld()) return false;
  return true;
}

function releaseSceneManip() {
  sceneManipMode = "none";
  sceneGrabL = null;
  sceneGrabR = null;
  sceneOneSrc = null;
  sceneTwoHandStylusSide = null;
  scenePrevStylusRearGrab = false;
}

function initSceneOneHandGrab(_frame, _refSpace, inputSource, anchor) {
  sceneManipMode = "one";
  sceneOneSrc = inputSource;
  sceneGrabL = null;
  sceneGrabR = null;
  sm_oneAnchor0.copy(anchor);
  sceneOnePos0.copy(sceneContentRoot.position);
}

function updateSceneOneHandGrab(frame, refSpace, slot) {
  if (!getThumbMiddleAnchorWorldInto(frame, refSpace, slot.hand, sm_anchorScratch)) return;
  _snapDeltaWorld.copy(sm_anchorScratch).sub(sm_oneAnchor0);
  sceneContentRoot.position.copy(sceneOnePos0).add(_snapDeltaWorld);
}

function transitionSceneTwoToOne(slot, frame, refSpace) {
  sceneGrabL = null;
  sceneGrabR = null;
  sceneTwoHandStylusSide = null;
  sceneManipMode = "one";
  sceneOneSrc = slot.inputSource;
  getThumbMiddleAnchorWorldInto(frame, refSpace, slot.hand, sm_oneAnchor0);
  sceneOnePos0.copy(sceneContentRoot.position);
}

function sceneTwoHandGrabFinishInit() {
  sm_thV0.copy(sm_thPR0).sub(sm_thPL0);
  sm_thDist0 = Math.max(sm_thV0.length(), 0.02);
  sm_thMid0.copy(sm_thPL0).add(sm_thPR0).multiplyScalar(0.5);
  sceneContentRoot.updateMatrixWorld(true);
  sm_box.setFromObject(strokesGroup);
  if (sm_box.isEmpty()) {
    _meshWorld.set(0, 0, 0);
    sm_thO0.copy(_meshWorld).sub(sm_thMid0);
    sceneContentRoot.worldToLocal(sm_centerLocal.copy(_meshWorld));
  } else {
    sm_box.getCenter(_meshWorld);
    sm_thO0.copy(_meshWorld).sub(sm_thMid0);
    sm_centerLocal.copy(_meshWorld);
    sceneContentRoot.worldToLocal(sm_centerLocal);
  }
  sm_thBaseScale = sceneContentRoot.scale.x;
  sceneContentRoot.getWorldQuaternion(sm_thQuat0);
}

function initSceneTwoHandGrab(frame, refSpace, leftSrc, rightSrc) {
  if (!leftSrc?.hand || !rightSrc?.hand) return;
  if (!getThumbMiddleAnchorWorldInto(frame, refSpace, leftSrc.hand, sm_thPL0)) return;
  if (!getThumbMiddleAnchorWorldInto(frame, refSpace, rightSrc.hand, sm_thPR0)) return;
  sceneManipMode = "two";
  sceneTwoHandStylusSide = null;
  sceneGrabL = leftSrc;
  sceneGrabR = rightSrc;
  sceneOneSrc = null;
  sceneTwoHandGrabFinishInit();
}

/** Second point = stylus tip (same sides as stroke two-hand: "right" = non-stylus left hand). */
function initSceneTwoHandGrabWithStylus(frame, refSpace, handSrc, stylusSide) {
  if (!handSrc?.hand || !stylus) return;
  if (stylusSide === "right") {
    if (!getThumbMiddleAnchorWorldInto(frame, refSpace, handSrc.hand, sm_thPL0)) return;
    sm_thPR0.copy(stylus.position);
  } else {
    sm_thPL0.copy(stylus.position);
    if (!getThumbMiddleAnchorWorldInto(frame, refSpace, handSrc.hand, sm_thPR0)) return;
  }
  sceneManipMode = "two";
  sceneTwoHandStylusSide = stylusSide;
  sceneOneSrc = null;
  if (stylusSide === "right") {
    sceneGrabL = handSrc;
    sceneGrabR = null;
  } else {
    sceneGrabL = null;
    sceneGrabR = handSrc;
  }
  sceneTwoHandGrabFinishInit();
}

function updateSceneTwoHandGrab(frame, refSpace) {
  if (sceneTwoHandStylusSide === null) {
    if (!sceneGrabL?.hand || !sceneGrabR?.hand) return;
    if (!getThumbMiddleAnchorWorldInto(frame, refSpace, sceneGrabL.hand, sm_thPL)) return;
    if (!getThumbMiddleAnchorWorldInto(frame, refSpace, sceneGrabR.hand, sm_thPR)) return;
  } else if (sceneTwoHandStylusSide === "right") {
    if (!sceneGrabL?.hand || !stylus) return;
    if (!getThumbMiddleAnchorWorldInto(frame, refSpace, sceneGrabL.hand, sm_thPL)) return;
    sm_thPR.copy(stylus.position);
  } else if (sceneTwoHandStylusSide === "left") {
    if (!sceneGrabR?.hand || !stylus) return;
    sm_thPL.copy(stylus.position);
    if (!getThumbMiddleAnchorWorldInto(frame, refSpace, sceneGrabR.hand, sm_thPR)) return;
  } else {
    return;
  }

  sm_thV.copy(sm_thPR).sub(sm_thPL);
  const dist = sm_thV.length();
  if (dist < 1e-5 || sm_thDist0 < 1e-5) return;

  let s = dist / sm_thDist0;
  s = Math.min(SCENE_MANIP_SCALE_MAX, Math.max(SCENE_MANIP_SCALE_MIN, s));

  sm_thV0n.copy(sm_thV0).normalize();
  sm_thVn.copy(sm_thV).normalize();
  // Yaw-only (world +Y): project inter-hand direction onto XZ, match initial vs current angle.
  const y0x = sm_thV0n.x;
  const y0z = sm_thV0n.z;
  const len0 = Math.hypot(y0x, y0z);
  const y1x = sm_thVn.x;
  const y1z = sm_thVn.z;
  const len1 = Math.hypot(y1x, y1z);
  if (len0 < 1e-5 || len1 < 1e-5) {
    sm_qAlign.identity();
  } else {
    const ax = y0x / len0;
    const az = y0z / len0;
    const bx = y1x / len1;
    const bz = y1z / len1;
    const crossY = ax * bz - az * bx;
    const dot = ax * bx + az * bz;
    sm_qAlign.setFromAxisAngle(sm_axis.set(0, 1, 0), -Math.atan2(crossY, dot));
  }

  sm_thMid.copy(sm_thPL).add(sm_thPR).multiplyScalar(0.5);

  sm_thQuatCombined.copy(sm_qAlign);
  sm_thOScaled.copy(sm_thO0).applyQuaternion(sm_thQuatCombined).multiplyScalar(s);
  sm_thTargetCenter.copy(sm_thMid).add(sm_thOScaled);

  sceneContentRoot.scale.setScalar(sm_thBaseScale * s);
  sceneContentRoot.quaternion.copy(sm_thQuat0).premultiply(sm_qAlign);
  sceneContentRoot.position.set(0, 0, 0);
  sceneContentRoot.updateMatrixWorld(true);
  _pickV.copy(sm_centerLocal);
  sceneContentRoot.localToWorld(_pickV);
  _snapDeltaWorld.copy(sm_thTargetCenter).sub(_pickV);
  sceneContentRoot.getWorldPosition(_meshWorld);
  _meshWorld.add(_snapDeltaWorld);
  sceneContentRoot.position.copy(_meshWorld);
  if (sceneContentRoot.parent) sceneContentRoot.parent.worldToLocal(sceneContentRoot.position);
}

function handleSceneManip(frame) {
  if (!frame || !renderer.xr.isPresenting) return;
  const refSpace = renderer.xr.getReferenceSpace();
  const session = renderer.xr.getSession();
  if (!refSpace || !session) return;

  if (!canSceneManip()) {
    if (sceneManipMode !== "none") releaseSceneManip();
    return;
  }

  smSlotL.valid = false;
  smSlotR.valid = false;
  for (const inputSource of session.inputSources) {
    if (!inputSource.hand) continue;
    if (inputSource.handedness === "left") fillThumbMiddleSceneSlot(inputSource, frame, refSpace, smSlotL);
    else if (inputSource.handedness === "right") fillThumbMiddleSceneSlot(inputSource, frame, refSpace, smSlotR);
  }

  const L = smSlotL.valid ? smSlotL : null;
  const R = smSlotR.valid ? smSlotR : null;
  const lP = !!(L && L.isPinched);
  const rP = !!(R && R.isPinched);

  const stylusRearGrab = !!(stylus && isStylusGrabForManip());
  const stylusRearJustPressed = stylusRearGrab && !scenePrevStylusRearGrab;
  scenePrevStylusRearGrab = stylusRearGrab;

  if (sceneManipMode === "two" && sceneTwoHandStylusSide !== null) {
    const handSlot = sceneTwoHandStylusSide === "right" ? L : R;
    if (handSlot && handSlot.isPinched && stylusRearGrab) {
      updateSceneTwoHandGrab(frame, refSpace);
      return;
    }
    if (handSlot && handSlot.isPinched && !stylusRearGrab) {
      transitionSceneTwoToOne(handSlot, frame, refSpace);
      return;
    }
    if ((!handSlot || !handSlot.isPinched) && stylusRearGrab) {
      releaseSceneManip();
      return;
    }
    releaseSceneManip();
    return;
  }

  if (sceneManipMode === "two") {
    if (lP && rP) {
      updateSceneTwoHandGrab(frame, refSpace);
      return;
    }
    if (lP && !rP && L) {
      transitionSceneTwoToOne(L, frame, refSpace);
      return;
    }
    if (rP && !lP && R) {
      transitionSceneTwoToOne(R, frame, refSpace);
      return;
    }
    releaseSceneManip();
    return;
  }

  if (sceneManipMode === "one") {
    if (
      stylus &&
      L &&
      sceneOneSrc === L.inputSource &&
      lP &&
      !rP &&
      stylusHandedness === "right" &&
      stylusRearJustPressed &&
      isStylusGrabForManip()
    ) {
      initSceneTwoHandGrabWithStylus(frame, refSpace, L.inputSource, "right");
      return;
    }
    if (
      stylus &&
      R &&
      sceneOneSrc === R.inputSource &&
      rP &&
      !lP &&
      stylusHandedness === "left" &&
      stylusRearJustPressed &&
      isStylusGrabForManip()
    ) {
      initSceneTwoHandGrabWithStylus(frame, refSpace, R.inputSource, "left");
      return;
    }
    if (lP && rP && L && R) {
      initSceneTwoHandGrab(frame, refSpace, L.inputSource, R.inputSource);
      return;
    }
    const slot =
      sceneOneSrc && L && sceneOneSrc === L.inputSource
        ? L
        : sceneOneSrc && R && sceneOneSrc === R.inputSource
          ? R
          : null;
    if (!slot || !slot.isPinched) {
      releaseSceneManip();
      return;
    }
    updateSceneOneHandGrab(frame, refSpace, slot);
    return;
  }

  if (lP && rP && L && R && (!L.wasPinched || !R.wasPinched)) {
    initSceneTwoHandGrab(frame, refSpace, L.inputSource, R.inputSource);
    return;
  }
  if (
    stylus &&
    lP &&
    !rP &&
    L &&
    !L.wasPinched &&
    isStylusGrabForManip() &&
    stylusHandedness === "right"
  ) {
    initSceneTwoHandGrabWithStylus(frame, refSpace, L.inputSource, "right");
    return;
  }
  if (
    stylus &&
    rP &&
    !lP &&
    R &&
    !R.wasPinched &&
    isStylusGrabForManip() &&
    stylusHandedness === "left"
  ) {
    initSceneTwoHandGrabWithStylus(frame, refSpace, R.inputSource, "left");
    return;
  }
  if (lP && !rP && L && !L.wasPinched) {
    initSceneOneHandGrab(frame, refSpace, L.inputSource, L.anchor);
    return;
  }
  if (rP && !lP && R && !R.wasPinched) {
    initSceneOneHandGrab(frame, refSpace, R.inputSource, R.anchor);
  }
}

function projectOnPlanePerpToAxis(axisUnit, vec, out) {
  const t = axisUnit.dot(vec);
  _projT.copy(axisUnit).multiplyScalar(t);
  return out.copy(vec).sub(_projT);
}

/** True if the hand matching the MX Ink side has thumb–index pinch (blocks drawing). */
function isStylusHandFingerPinching(frame, session) {
  if (stylusHandedness === "none") return false;
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) return false;
  for (const inputSource of session.inputSources) {
    if (!inputSource.hand || inputSource.handedness !== stylusHandedness) continue;
    const thumbTip = inputSource.hand.get("thumb-tip");
    const indexTip = inputSource.hand.get("index-finger-tip");
    if (!thumbTip || !indexTip) continue;
    const tp = frame.getPose(thumbTip, refSpace);
    const ip = frame.getPose(indexTip, refSpace);
    if (!tp || !ip) continue;
    jointPositionFromPose(tp, _thumbTipPos);
    jointPositionFromPose(ip, _indexTipPos);
    if (_thumbTipPos.distanceTo(_indexTipPos) < PINCH_OPEN_DIST) return true;
  }
  return false;
}

function leftRightSources(a, b) {
  if (a.handedness === "left" && b.handedness === "right") return { left: a, right: b };
  if (a.handedness === "right" && b.handedness === "left") return { left: b, right: a };
  return null;
}

function initTwoHandGrab(mesh, pL, pR, leftSrc, rightSrc, frame, refSpace) {
  if (!leftSrc && !rightSrc) return;
  grabbedMesh = mesh;
  grabMode = "two";
  grabInputSource = null;
  grabInputIsStylus = false;
  twoGrabLeft = leftSrc;
  twoGrabRight = rightSrc;
  if (leftSrc && rightSrc) {
    twoHandStylusSide = null;
  } else if (leftSrc && !rightSrc) {
    twoHandStylusSide = "right";
  } else {
    twoHandStylusSide = "left";
  }
  thPL0.copy(pL);
  thPR0.copy(pR);
  thV0.copy(thPR0).sub(thPL0);
  thDist0 = Math.max(thV0.length(), 0.02);
  thMid0.copy(thPL0).add(thPR0).multiplyScalar(0.5);
  mesh.updateMatrixWorld(true);
  const centerLocal = ensureMeshCenterLocal(mesh);
  _meshWorld.copy(centerLocal);
  mesh.localToWorld(_meshWorld);
  thO0.copy(_meshWorld).sub(thMid0);
  thBaseScale = mesh.scale.x;
  mesh.getWorldQuaternion(thQuatMesh0);

  if (leftSrc && rightSrc) {
    const hasMid =
      getMiddleFingerWorldInto(frame, refSpace, leftSrc.hand, thLeftMid0) &&
      getMiddleFingerWorldInto(frame, refSpace, rightSrc.hand, thRightMid0);
    if (hasMid) {
      _axis.copy(thV0).normalize();
      projectOnPlanePerpToAxis(_axis, _wL.copy(thLeftMid0).sub(thPL0), _wL0);
      projectOnPlanePerpToAxis(_axis, _wR.copy(thRightMid0).sub(thPR0), _wR0);
      thWRef0.copy(_wL0).add(_wR0);
      if (thWRef0.lengthSq() < 1e-10) thWRef0.set(0, 1, 0);
      else thWRef0.normalize();
    } else {
      thWRef0.set(0, 1, 0);
    }
  } else if (leftSrc && twoHandStylusSide === "right") {
    _axis.copy(thV0).normalize();
    let hV = false;
    let pV = false;
    _wL0.set(0, 0, 0);
    _wR0.set(0, 0, 0);
    if (getMiddleFingerWorldInto(frame, refSpace, leftSrc.hand, thLeftMid0)) {
      projectOnPlanePerpToAxis(_axis, _wL.copy(thLeftMid0).sub(thPL0), _wL0);
      hV = _wL0.lengthSq() > 1e-10;
    }
    if (penAxisWorldInto(_penForward)) {
      projectOnPlanePerpToAxis(_axis, _penForward, _wR0);
      pV = _wR0.lengthSq() > 1e-10;
    }
    if (hV && pV) {
      thWRef0.copy(_wL0).add(_wR0);
    } else if (hV) {
      thWRef0.copy(_wL0);
    } else if (pV) {
      thWRef0.copy(_wR0);
    } else {
      thWRef0.set(0, 1, 0);
    }
    if (thWRef0.lengthSq() < 1e-10) thWRef0.set(0, 1, 0);
    else thWRef0.normalize();
  } else if (rightSrc && twoHandStylusSide === "left") {
    _axis.copy(thV0).normalize();
    let hV = false;
    let pV = false;
    _wL0.set(0, 0, 0);
    _wR0.set(0, 0, 0);
    if (getMiddleFingerWorldInto(frame, refSpace, rightSrc.hand, thRightMid0)) {
      projectOnPlanePerpToAxis(_axis, _wL.copy(thRightMid0).sub(thPR0), _wL0);
      hV = _wL0.lengthSq() > 1e-10;
    }
    if (penAxisWorldInto(_penForward)) {
      projectOnPlanePerpToAxis(_axis, _penForward, _wR0);
      pV = _wR0.lengthSq() > 1e-10;
    }
    if (hV && pV) {
      thWRef0.copy(_wL0).add(_wR0);
    } else if (hV) {
      thWRef0.copy(_wL0);
    } else if (pV) {
      thWRef0.copy(_wR0);
    } else {
      thWRef0.set(0, 1, 0);
    }
    if (thWRef0.lengthSq() < 1e-10) thWRef0.set(0, 1, 0);
    else thWRef0.normalize();
  } else {
    thWRef0.set(0, 1, 0);
  }
}

function updateTwoHandGrab(frame, refSpace) {
  const mesh = grabbedMesh;
  if (!mesh) return;

  if (twoHandStylusSide === null) {
    if (!twoGrabLeft || !twoGrabRight) return;
    const handL = twoGrabLeft.hand;
    const handR = twoGrabRight.hand;
    if (!handL || !handR) return;
    if (!getIndexTipWorldInto(frame, refSpace, handL, thPL)) return;
    if (!getIndexTipWorldInto(frame, refSpace, handR, thPR)) return;
  } else if (twoHandStylusSide === "right") {
    if (!twoGrabLeft || !stylus) return;
    if (!getIndexTipWorldInto(frame, refSpace, twoGrabLeft.hand, thPL)) return;
    thPR.copy(stylus.position);
  } else if (twoHandStylusSide === "left") {
    if (!twoGrabRight || !stylus) return;
    thPL.copy(stylus.position);
    if (!getIndexTipWorldInto(frame, refSpace, twoGrabRight.hand, thPR)) return;
  } else {
    return;
  }

  thV.copy(thPR).sub(thPL);
  const dist = thV.length();
  if (dist < 1e-5 || thDist0 < 1e-5) return;

  const s = dist / thDist0;
  thV0n.copy(thV0).normalize();
  thVn.copy(thV).normalize();
  qAlign.setFromUnitVectors(thV0n, thVn);

  thMid.copy(thPL).add(thPR).multiplyScalar(0.5);

  qTwist.identity();
  if (twoHandStylusSide === null && twoGrabLeft && twoGrabRight) {
    const handL = twoGrabLeft.hand;
    const handR = twoGrabRight.hand;
    if (
      getMiddleFingerWorldInto(frame, refSpace, handL, thLM) &&
      getMiddleFingerWorldInto(frame, refSpace, handR, thRM)
    ) {
      _axis.copy(thV).normalize();
      projectOnPlanePerpToAxis(_axis, _wL.copy(thLM).sub(thPL), _wL);
      projectOnPlanePerpToAxis(_axis, _wR.copy(thRM).sub(thPR), _wR);
      thWRef.copy(_wL).add(_wR);
      if (thWRef.lengthSq() > 1e-10) {
        thWRef.normalize();
        _wL.copy(thWRef0).applyQuaternion(qAlign).normalize();
        qTwist.setFromUnitVectors(_wL, thWRef);
      }
    }
  } else if (twoHandStylusSide === "right" && twoGrabLeft) {
    _axis.copy(thV).normalize();
    let hV = false;
    let pV = false;
    _wL0.set(0, 0, 0);
    _wR0.set(0, 0, 0);
    if (getMiddleFingerWorldInto(frame, refSpace, twoGrabLeft.hand, thLM)) {
      projectOnPlanePerpToAxis(_axis, _wL.copy(thLM).sub(thPL), _wL0);
      hV = _wL0.lengthSq() > 1e-10;
    }
    if (penAxisWorldInto(_penForward)) {
      projectOnPlanePerpToAxis(_axis, _penForward, _wR0);
      pV = _wR0.lengthSq() > 1e-10;
    }
    if (hV && pV) {
      thWRef.copy(_wL0).add(_wR0);
    } else if (hV) {
      thWRef.copy(_wL0);
    } else if (pV) {
      thWRef.copy(_wR0);
    }
    if (thWRef.lengthSq() > 1e-10) {
      thWRef.normalize();
      _wL.copy(thWRef0).applyQuaternion(qAlign).normalize();
      qTwist.setFromUnitVectors(_wL, thWRef);
    }
  } else if (twoHandStylusSide === "left" && twoGrabRight) {
    _axis.copy(thV).normalize();
    let hV = false;
    let pV = false;
    _wL0.set(0, 0, 0);
    _wR0.set(0, 0, 0);
    if (getMiddleFingerWorldInto(frame, refSpace, twoGrabRight.hand, thRM)) {
      projectOnPlanePerpToAxis(_axis, _wL.copy(thRM).sub(thPR), _wL0);
      hV = _wL0.lengthSq() > 1e-10;
    }
    if (penAxisWorldInto(_penForward)) {
      projectOnPlanePerpToAxis(_axis, _penForward, _wR0);
      pV = _wR0.lengthSq() > 1e-10;
    }
    if (hV && pV) {
      thWRef.copy(_wL0).add(_wR0);
    } else if (hV) {
      thWRef.copy(_wL0);
    } else if (pV) {
      thWRef.copy(_wR0);
    }
    if (thWRef.lengthSq() > 1e-10) {
      thWRef.normalize();
      _wL.copy(thWRef0).applyQuaternion(qAlign).normalize();
      qTwist.setFromUnitVectors(_wL, thWRef);
    }
  }

  thQuatCombined.copy(qTwist).multiply(qAlign);
  thOScaled.copy(thO0).applyQuaternion(thQuatCombined).multiplyScalar(s);
  thTargetCenter.copy(thMid).add(thOScaled);

  const centerLocal = ensureMeshCenterLocal(mesh);
  // Pinch distance scales the mesh uniformly (stroke path and tube thickness).
  mesh.scale.setScalar(thBaseScale * s);
  mesh.quaternion.copy(thQuatMesh0).premultiply(qAlign).premultiply(qTwist);
  mesh.position.set(0, 0, 0);
  strokesGroup.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  _pickV.copy(centerLocal);
  mesh.localToWorld(_pickV);
  _snapDeltaWorld.copy(thTargetCenter).sub(_pickV);
  mesh.getWorldPosition(_meshWorld);
  _meshWorld.add(_snapDeltaWorld);
  mesh.position.copy(_meshWorld);
  if (mesh.parent) mesh.parent.worldToLocal(mesh.position);
  snapGrabbedMeshStrokeToGrid(mesh);
  if (snapToGridEnabled) {
    strokesGroup.updateMatrixWorld(true);
    mesh.updateMatrixWorld(true);
    _pickV.copy(ensureMeshCenterLocal(mesh));
    mesh.localToWorld(_pickV);
    thO0.copy(_pickV).sub(thMid);
  }
}

function transitionTwoHandToOne(remainingSource, frame, refSpace) {
  const mesh = grabbedMesh;
  if (!mesh || !remainingSource.hand) return;
  grabMode = "one";
  twoGrabLeft = null;
  twoGrabRight = null;
  twoHandStylusSide = null;
  grabInputIsStylus = false;
  grabInputSource = remainingSource;
  if (!getIndexTipWorldInto(frame, refSpace, remainingSource.hand, _indexTipPos)) return;
  mesh.getWorldPosition(_meshWorld);
  grabOffsetWorld.copy(_meshWorld).sub(_indexTipPos);
  snapGrabbedRootAtGrabStart(mesh, _indexTipPos);
}

function transitionTwoHandToStylusOne(frame, refSpace) {
  const mesh = grabbedMesh;
  if (!mesh || !stylus) return;
  grabMode = "one";
  twoGrabLeft = null;
  twoGrabRight = null;
  twoHandStylusSide = null;
  grabInputIsStylus = true;
  grabInputSource = null;
  mesh.getWorldPosition(_meshWorld);
  grabOffsetWorld.copy(_meshWorld).sub(stylus.position);
  snapGrabbedRootAtGrabStart(mesh, stylus.position);
}

function ensureMeshCenterLocal(mesh) {
  if (mesh.userData.centerLocal) return mesh.userData.centerLocal;
  if (mesh.isGroup && mesh.userData.isStrokeCluster) {
    _centerLocal.set(0, 0, 0);
    let n = 0;
    for (const ch of mesh.children) {
      if (!ch.isMesh) continue;
      const cl = ensureMeshCenterLocal(ch);
      _pickV.copy(cl).multiplyScalar(ch.scale.x);
      _pickV.applyQuaternion(ch.quaternion);
      _pickV.add(ch.position);
      _centerLocal.add(_pickV);
      n++;
    }
    if (n > 0) _centerLocal.multiplyScalar(1 / n);
    mesh.userData.centerLocal = _centerLocal.clone();
    return mesh.userData.centerLocal;
  }
  if (mesh.userData.points && mesh.userData.points.length > 0) {
    _centerLocal.set(0, 0, 0);
    for (const p of mesh.userData.points) _centerLocal.add(p);
    _centerLocal.multiplyScalar(1 / mesh.userData.points.length);
    mesh.userData.centerLocal = _centerLocal.clone();
    return mesh.userData.centerLocal;
  }
  if (mesh.isInstancedMesh) {
    if (mesh.boundingSphere === null) mesh.computeBoundingSphere();
    mesh.userData.centerLocal = mesh.boundingSphere.center.clone();
    return mesh.userData.centerLocal;
  }
  updateStrokeBoundingSphereFromDrawRange(mesh);
  if (mesh.geometry.boundingSphere) {
    mesh.userData.centerLocal = mesh.geometry.boundingSphere.center.clone();
    return mesh.userData.centerLocal;
  }
  mesh.userData.centerLocal = new THREE.Vector3(0, 0, 0);
  return mesh.userData.centerLocal;
}

function buildStrokeMeshFromPoints(pointsLocal, strokeWidth) {
  const w = strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
  const tp = createTubePainterSized(
    computeTubePainterMaxVertices(pointsLocal.length),
  );
  tp.mesh.material = material;
  tp.setSize(w);
  tp.mesh.userData.strokeWidth = w;
  tp.moveTo(pointsLocal[0]);
  for (let i = 1; i < pointsLocal.length; i++) {
    tp.lineTo(pointsLocal[i]);
  }
  tp.update();
  return tp.mesh;
}

function tryBuildMergedWorldPolyline(meshA, meshB) {
  const pa = meshA.userData.points;
  const pb = meshB.userData.points;
  if (!pa || !pb || pa.length < 2 || pb.length < 2) return null;

  const worldA = pa.map((p) => meshA.localToWorld(p.clone()));
  const worldB = pb.map((p) => meshB.localToWorld(p.clone()));

  const nA = worldA.length;
  const nB = worldB.length;
  const a0 = worldA[0];
  const a1 = worldA[nA - 1];
  const b0 = worldB[0];
  const b1 = worldB[nB - 1];

  const candidates = [
    { d: a1.distanceTo(b0), build: () => [...worldA, ...worldB] },
    { d: a1.distanceTo(b1), build: () => [...worldA, ...worldB.slice().reverse()] },
    { d: a0.distanceTo(b0), build: () => [...worldA.slice().reverse(), ...worldB] },
    { d: a0.distanceTo(b1), build: () => [...worldB, ...worldA] },
  ];

  candidates.sort((x, y) => x.d - y.d);
  const best = candidates[0];
  if (best.d > MERGE_STROKE_DIST) return null;

  return best.build();
}

function invalidateStrokeClusterCenters(node) {
  let p = node;
  while (p) {
    if (p.userData && p.userData.isStrokeCluster) delete p.userData.centerLocal;
    p = p.parent;
  }
}

function areSameStrokeCluster(a, b) {
  if (a === b) return true;
  if (a.parent && a.parent.userData && a.parent.userData.isStrokeCluster && a.parent === b.parent) return true;
  return false;
}

function findProximityStrokePartner(mesh) {
  if (!mesh.userData.points || mesh.userData.points.length < 2) return null;
  const candidates = [];
  strokesGroup.traverse((o) => {
    if (!o.isMesh || o === mesh) return;
    if (!o.userData.points || o.userData.points.length < 2) return;
    if (areSameStrokeCluster(o, mesh)) return;
    candidates.push(o);
  });
  for (const other of candidates) {
    if (tryBuildMergedWorldPolyline(mesh, other)) return other;
  }
  return null;
}

/** Link endpoint-near strokes into one `THREE.Group` (same grab object; meshes stay separate). */
function linkStrokeClusterIfNeeded(mesh) {
  const other = findProximityStrokePartner(mesh);
  if (!other) return;

  if (areSameStrokeCluster(mesh, other)) return;

  if (other.parent && other.parent.userData && other.parent.userData.isStrokeCluster) {
    const g = other.parent;
    if (mesh.parent !== g) {
      if (mesh.parent) mesh.parent.remove(mesh);
      else strokesGroup.remove(mesh);
      g.attach(mesh);
      invalidateStrokeClusterCenters(g);
    }
    return;
  }

  if (mesh.parent && mesh.parent.userData && mesh.parent.userData.isStrokeCluster) {
    const g = mesh.parent;
    if (other.parent !== g) {
      if (other.parent) other.parent.remove(other);
      else strokesGroup.remove(other);
      g.attach(other);
      invalidateStrokeClusterCenters(g);
    }
    return;
  }

  const group = new THREE.Group();
  group.userData.isStrokeCluster = true;
  strokesGroup.remove(mesh);
  strokesGroup.remove(other);
  strokesGroup.add(group);
  group.attach(mesh);
  group.attach(other);
  invalidateStrokeClusterCenters(group);
}

function eraseStrokeAtWorld(mesh, eraseWorldPt) {
  const pts = mesh.userData.points;
  if (!pts || pts.length < 2) {
    const parent = mesh.parent;
    mesh.removeFromParent();
    mesh.geometry.dispose();
    if (parent && parent.userData && parent.userData.isStrokeCluster) {
      invalidateStrokeClusterCenters(parent);
      dissolveStrokeClusterIfSingleton(parent);
    }
    scheduleSketcharPush();
    return;
  }

  const keep = [];
  for (let i = 0; i < pts.length; i++) {
    _pickV.copy(pts[i]);
    mesh.localToWorld(_pickV);
    keep.push(_pickV.distanceToSquared(eraseWorldPt) > ERASE_RADIUS_SQ);
  }

  const runs = [];
  let start = -1;
  for (let i = 0; i < keep.length; i++) {
    if (keep[i]) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= 2) {
        runs.push(pts.slice(start, i));
      }
      start = -1;
    }
  }
  if (start >= 0 && keep.length - start >= 2) {
    runs.push(pts.slice(start));
  }

  if (runs.length === 0) {
    const parent = mesh.parent;
    mesh.removeFromParent();
    mesh.geometry.dispose();
    if (parent && parent.userData && parent.userData.isStrokeCluster) {
      invalidateStrokeClusterCenters(parent);
      dissolveStrokeClusterIfSingleton(parent);
    }
    scheduleSketcharPush();
    return;
  }

  const pos = mesh.position.clone();
  const quat = mesh.quaternion.clone();
  const sc = mesh.scale.clone();

  const eraseParent = mesh.parent;
  mesh.removeFromParent();
  mesh.geometry.dispose();

  const sw = mesh.userData.strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
  const addTo = eraseParent && eraseParent.userData && eraseParent.userData.isStrokeCluster ? eraseParent : strokesGroup;
  for (const run of runs) {
    const localPts = run.map((p) => p.clone());
    const newMesh = buildStrokeMeshFromPoints(localPts, sw);
    newMesh.position.copy(pos);
    newMesh.quaternion.copy(quat);
    newMesh.scale.copy(sc);
    newMesh.userData.points = localPts.map((p) => p.clone());
    addTo.add(newMesh);
  }
  if (eraseParent && eraseParent.userData && eraseParent.userData.isStrokeCluster) {
    invalidateStrokeClusterCenters(eraseParent);
    dissolveStrokeClusterIfSingleton(eraseParent);
  }
  scheduleSketcharPush();
}

function dissolveStrokeClusterIfSingleton(cluster) {
  if (!cluster.userData || !cluster.userData.isStrokeCluster) return;
  if (cluster.children.length === 0) {
    cluster.removeFromParent();
    return;
  }
  if (cluster.children.length !== 1) return;
  const ch = cluster.children[0];
  cluster.remove(ch);
  strokesGroup.add(ch);
  cluster.removeFromParent();
  invalidateStrokeClusterCenters(ch);
}

function handleEraseWithStylus() {
  if (!stylus || !gamepad1) return;
  if (!isEraserHeld()) return;
  if (grabMode !== "none") return;
  const hit = pickStrokeMeshFromStylusTip();
  if (!hit) return;
  _eraseWorld.copy(stylus.position);
  if (hit.userData.points && hit.userData.points.length >= 2) {
    eraseStrokeAtWorld(hit, _eraseWorld);
  } else {
    const parent = hit.parent;
    hit.removeFromParent();
    hit.geometry.dispose();
    if (hit.material && hit.material !== material) hit.material.dispose();
    if (parent && parent.userData && parent.userData.isStrokeCluster) {
      invalidateStrokeClusterCenters(parent);
      dissolveStrokeClusterIfSingleton(parent);
    }
    scheduleSketcharPush();
  }
}

function pushCompletedStrokeForBlockMode(mesh) {
  if (!mesh || !mesh.isMesh) return;
  lastThreeCompletedStrokes.push(mesh);
  if (lastThreeCompletedStrokes.length > 3) lastThreeCompletedStrokes.shift();
}

function meshIsUnderStrokesGroup(mesh) {
  let p = mesh;
  while (p) {
    if (p === strokesGroup) return true;
    p = p.parent;
  }
  return false;
}

/**
 * Gram–Schmidt: ex → ux, ey → uy, ez → uz. Returns false if degenerate.
 * @param {THREE.Vector3} ex
 * @param {THREE.Vector3} ey
 * @param {THREE.Vector3} ez
 * @param {THREE.Vector3} outUx
 * @param {THREE.Vector3} outUy
 * @param {THREE.Vector3} outUz
 */
function orthogonalizeEdges(ex, ey, ez, outUx, outUy, outUz) {
  outUx.copy(ex);
  const lenX = outUx.length();
  if (lenX < 1e-6) return false;
  outUx.multiplyScalar(1 / lenX);
  _projT.copy(outUx).multiplyScalar(ey.dot(outUx));
  outUy.copy(ey).sub(_projT);
  if (outUy.lengthSq() < 1e-10) return false;
  outUy.normalize();
  _projT.copy(outUx).multiplyScalar(ez.dot(outUx));
  outUz.copy(ez).sub(_projT);
  _projT.copy(outUy).multiplyScalar(outUz.dot(outUy));
  outUz.sub(_projT);
  if (outUz.lengthSq() < 1e-10) return false;
  outUz.normalize();
  return true;
}

function removeStrokeMeshFromScene(mesh) {
  if (!mesh) return;
  const parent = mesh.parent;
  mesh.removeFromParent();
  mesh.geometry.dispose();
  if (parent && parent.userData && parent.userData.isStrokeCluster) {
    invalidateStrokeClusterCenters(parent);
    dissolveStrokeClusterIfSingleton(parent);
  }
}

function strokeEndpointsWorld(mesh, outStart, outEnd) {
  const pts = mesh.userData.points;
  if (!pts || pts.length < 2) return false;
  outStart.copy(pts[0]);
  mesh.localToWorld(outStart);
  outEnd.copy(pts[pts.length - 1]);
  mesh.localToWorld(outEnd);
  return true;
}

function tryBuildVoxelBlockFromLastThreeStrokes() {
  if (grabMode !== "none") return;
  if (lastThreeCompletedStrokes.length < 3) return;

  const m0 = lastThreeCompletedStrokes[lastThreeCompletedStrokes.length - 3];
  const m1 = lastThreeCompletedStrokes[lastThreeCompletedStrokes.length - 2];
  const m2 = lastThreeCompletedStrokes[lastThreeCompletedStrokes.length - 1];
  if (!meshIsUnderStrokesGroup(m0) || !meshIsUnderStrokesGroup(m1) || !meshIsUnderStrokesGroup(m2)) {
    lastThreeCompletedStrokes.length = 0;
    return;
  }
  if (!m0.userData.points || !m1.userData.points || !m2.userData.points) return;
  if (m0.userData.points.length < 2 || m1.userData.points.length < 2 || m2.userData.points.length < 2) return;

  const s0 = _pickMin;
  const e0 = _pickMax;
  const s1 = _wL0;
  const e1 = _wR0;
  const s2 = _wL;
  const e2 = _wR;
  if (!strokeEndpointsWorld(m0, s0, e0)) return;
  _oCorner.copy(s0);
  if (!strokeEndpointsWorld(m1, s1, e1)) return;
  if (!strokeEndpointsWorld(m2, s2, e2)) return;

  _ex.subVectors(e0, s0);
  _ey.subVectors(e1, s1);
  _ez.subVectors(e2, s2);

  _pickV.copy(_ex).normalize();
  _pickMin.copy(_ey).normalize();
  _pickMax.copy(_ez).normalize();
  if (Math.abs(_pickV.dot(_pickMin)) > BLOCK_EDGE_NON_ORTHOGONAL_DOT) {
    console.warn("[block mode] X and Y sketch edges are not very perpendicular; voxel frame may be approximate.");
  }
  if (Math.abs(_pickMin.dot(_pickMax)) > BLOCK_EDGE_NON_ORTHOGONAL_DOT) {
    console.warn("[block mode] Y and Z sketch edges are not very perpendicular; voxel frame may be approximate.");
  }
  if (Math.abs(_pickV.dot(_pickMax)) > BLOCK_EDGE_NON_ORTHOGONAL_DOT) {
    console.warn("[block mode] X and Z sketch edges are not very perpendicular; voxel frame may be approximate.");
  }

  if (!orthogonalizeEdges(_ex, _ey, _ez, _ux, _uy, _uz)) {
    console.warn("[block mode] Could not build orthogonal frame from the three strokes (edges too parallel).");
    return;
  }

  const Lx = _ex.length();
  const Ly = _ey.length();
  const Lz = _ez.length();
  if (Lx < 1e-5 || Ly < 1e-5 || Lz < 1e-5) return;

  let s = Math.min(Lx, Ly, Lz) / BLOCK_VOXEL_DIV_N;
  let nx = Math.max(1, Math.floor(Lx / s));
  let ny = Math.max(1, Math.floor(Ly / s));
  let nz = Math.max(1, Math.floor(Lz / s));
  let count = nx * ny * nz;
  if (count > BLOCK_MAX_INSTANCES) {
    const factor = Math.pow(count / BLOCK_MAX_INSTANCES, 1 / 3);
    s *= factor;
    nx = Math.max(1, Math.floor(Lx / s));
    ny = Math.max(1, Math.floor(Ly / s));
    nz = Math.max(1, Math.floor(Lz / s));
    count = nx * ny * nz;
  }

  const geom = new THREE.BoxGeometry(1, 1, 1);
  const inst = new THREE.InstancedMesh(geom, material, count);
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.userData.isVoxelBlock = true;
  inst.frustumCulled = false;

  _basisMat.makeBasis(_ux, _uy, _uz);
  _voxelQuat.setFromRotationMatrix(_basisMat);
  _voxelScale.set(s, s, s);

  strokesGroup.updateMatrixWorld(true);
  _parentInv.copy(strokesGroup.matrixWorld).invert();

  let idx = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        _voxelCenterW
          .copy(_oCorner)
          .addScaledVector(_ux, (i + 0.5) * s)
          .addScaledVector(_uy, (j + 0.5) * s)
          .addScaledVector(_uz, (k + 0.5) * s);
        _instWorld.compose(_voxelCenterW, _voxelQuat, _voxelScale);
        _instLocal.multiplyMatrices(_parentInv, _instWorld);
        inst.setMatrixAt(idx, _instLocal);
        idx++;
      }
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.computeBoundingSphere();

  strokesGroup.add(inst);
  scheduleSketcharPush();

  removeStrokeMeshFromScene(m0);
  removeStrokeMeshFromScene(m1);
  removeStrokeMeshFromScene(m2);
  lastThreeCompletedStrokes.length = 0;
}

function handleGridSnapTogglePinch(frame) {
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) return;
  const session = renderer.xr.getSession();
  if (!session) return;

  if (grabMode !== "none" || isDrawing || isStrokeActive()) return;

  scene.updateMatrixWorld(true);

  for (const inputSource of session.inputSources) {
    const hand = inputSource.hand;
    if (!hand) continue;
    if (inputSource.handedness !== "right") continue;

    const thumbTip = hand.get("thumb-tip");
    const pinkyTip = hand.get("pinky-finger-tip");
    if (!thumbTip || !pinkyTip) continue;

    const thumbPose = frame.getPose(thumbTip, refSpace);
    const pinkyPose = frame.getPose(pinkyTip, refSpace);
    if (!thumbPose || !pinkyPose) continue;

    jointPositionFromPose(thumbPose, _thumbTipPos);
    jointPositionFromPose(pinkyPose, _pinkyTipPos);

    const d = _thumbTipPos.distanceTo(_pinkyTipPos);
    const wasPinched = thumbPinkyPinchPrev.get(inputSource) === true;
    const isPinched = wasPinched ? d < PINCH_OPEN_DIST : d < PINCH_CLOSE_DIST;
    thumbPinkyPinchPrev.set(inputSource, isPinched);

    if (isPinched && !wasPinched) {
      const next = !snapToGridEnabled;
      snapToGridEnabled = next;
      if (next) {
        invalidateStrokeMeshCenterLocals();
        snapAllStrokeRootsToGrid();
      }
      return;
    }
  }
}

function handleBlockModePinch(frame) {
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) return;
  const session = renderer.xr.getSession();
  if (!session) return;

  if (grabMode !== "none" || isDrawing || isStrokeActive()) return;

  scene.updateMatrixWorld(true);

  for (const inputSource of session.inputSources) {
    const hand = inputSource.hand;
    if (!hand) continue;
    if (inputSource.handedness !== "left") continue;

    const thumbTip = hand.get("thumb-tip");
    const pinkyTip = hand.get("pinky-finger-tip");
    if (!thumbTip || !pinkyTip) continue;

    const thumbPose = frame.getPose(thumbTip, refSpace);
    const pinkyPose = frame.getPose(pinkyTip, refSpace);
    if (!thumbPose || !pinkyPose) continue;

    jointPositionFromPose(thumbPose, _thumbTipPos);
    jointPositionFromPose(pinkyPose, _pinkyTipPos);

    const d = _thumbTipPos.distanceTo(_pinkyTipPos);
    const wasPinched = thumbPinkyPinchPrev.get(inputSource) === true;
    const isPinched = wasPinched ? d < PINCH_OPEN_DIST : d < PINCH_CLOSE_DIST;
    thumbPinkyPinchPrev.set(inputSource, isPinched);

    if (isPinched && !wasPinched) {
      tryBuildVoxelBlockFromLastThreeStrokes();
      return;
    }
  }
}

function handleHandGrab(frame) {
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) return;

  const session = renderer.xr.getSession();
  if (!session) return;

  scene.updateMatrixWorld(true);

  /** @type {Array<{ inputSource: XRInputSource; hand: XRHand; indexPose: XRPose; indexPos: THREE.Vector3; thumbPos: THREE.Vector3; pinchDist: number; isPinched: boolean; wasPinched: boolean }>} */
  const handStates = [];

  for (const inputSource of session.inputSources) {
    const hand = inputSource.hand;
    if (!hand) continue;

    const indexTip = hand.get("index-finger-tip");
    const thumbTip = hand.get("thumb-tip");
    if (!indexTip || !thumbTip) continue;

    const indexPose = frame.getPose(indexTip, refSpace);
    const thumbPose = frame.getPose(thumbTip, refSpace);
    if (!indexPose || !thumbPose) continue;

    jointPositionFromPose(indexPose, _indexTipPos);
    jointPositionFromPose(thumbPose, _thumbTipPos);

    const pinchDist = _indexTipPos.distanceTo(_thumbTipPos);
    const wasPinched = pinchPrev.get(inputSource) === true;
    const isPinched = wasPinched ? pinchDist < PINCH_OPEN_DIST : pinchDist < PINCH_CLOSE_DIST;

    pinchPrev.set(inputSource, isPinched);

    handStates.push({
      inputSource,
      hand,
      indexPose,
      indexPos: _indexTipPos.clone(),
      pinchDist,
      isPinched,
      wasPinched,
    });
  }

  const findState = (src) => handStates.find((h) => h.inputSource === src);

  if (grabMode === "two" && grabbedMesh) {
    if (twoHandStylusSide === null) {
      const stL = twoGrabLeft ? findState(twoGrabLeft) : null;
      const stR = twoGrabRight ? findState(twoGrabRight) : null;

      if (!stL || !stR) {
        releaseGrab();
        return;
      }

      if (stL.isPinched && stR.isPinched) {
        updateTwoHandGrab(frame, refSpace);
        return;
      }

      if (stL.isPinched && !stR.isPinched) {
        transitionTwoHandToOne(twoGrabLeft, frame, refSpace);
        return;
      }
      if (stR.isPinched && !stL.isPinched) {
        transitionTwoHandToOne(twoGrabRight, frame, refSpace);
        return;
      }

      releaseGrab();
      return;
    }

    const stylusGrab = isStylusGrabForManip();
    const handSrc = twoHandStylusSide === "right" ? twoGrabLeft : twoGrabRight;
    const stHand = handSrc ? findState(handSrc) : null;
    const pinchingHand = !!(stHand && stHand.isPinched);

    if (pinchingHand && stylusGrab) {
      updateTwoHandGrab(frame, refSpace);
      return;
    }
    if (pinchingHand && !stylusGrab) {
      transitionTwoHandToOne(handSrc, frame, refSpace);
      return;
    }
    if (!pinchingHand && stylusGrab) {
      transitionTwoHandToStylusOne(frame, refSpace);
      return;
    }
    releaseGrab();
    return;
  }

  if (grabMode === "one" && grabbedMesh && grabInputIsStylus) {
    if (!isStylusGrabForManip()) {
      releaseGrab();
      return;
    }
    _grabTargetWorld.copy(stylus.position).add(grabOffsetWorld);
    const grabPar = grabbedMesh.parent;
    if (grabPar) grabPar.worldToLocal(_grabTargetWorld);
    else strokesGroup.worldToLocal(_grabTargetWorld);
    grabbedMesh.position.copy(_grabTargetWorld);
    snapGrabbedMeshStrokeToGrid(grabbedMesh, false);
    if (snapToGridEnabled) refreshGrabOffsetAfterSnapStylus();

    for (const hs of handStates) {
      if (!hs.isPinched || hs.wasPinched) continue;
      if (handGrabBlockedWhileDrawing(hs.inputSource)) continue;
      rayDirFromIndexTipPose(hs.indexPose);
      const picked = pickStrokeMesh(hs.indexPos, _rayDir);
      if (!sameGrabTarget(picked, grabbedMesh)) continue;
      if (hs.inputSource.handedness === "left") {
        getIndexTipWorldInto(frame, refSpace, hs.hand, thPL);
        thPR.copy(stylus.position);
        initTwoHandGrab(grabbedMesh, thPL, thPR, hs.inputSource, null, frame, refSpace);
        return;
      }
      if (hs.inputSource.handedness === "right") {
        thPL.copy(stylus.position);
        getIndexTipWorldInto(frame, refSpace, hs.hand, thPR);
        initTwoHandGrab(grabbedMesh, thPL, thPR, null, hs.inputSource, frame, refSpace);
        return;
      }
    }
    return;
  }

  if (grabMode === "one" && grabbedMesh && grabInputSource) {
    const st = findState(grabInputSource);
    if (!st || !st.isPinched) {
      releaseGrab();
      return;
    }

    jointPositionFromPose(st.indexPose, _indexTipPos);
    _grabTargetWorld.copy(_indexTipPos).add(grabOffsetWorld);
    const grabParIdx = grabbedMesh.parent;
    if (grabParIdx) grabParIdx.worldToLocal(_grabTargetWorld);
    else strokesGroup.worldToLocal(_grabTargetWorld);
    grabbedMesh.position.copy(_grabTargetWorld);
    snapGrabbedMeshStrokeToGrid(grabbedMesh, false);
    if (snapToGridEnabled) refreshGrabOffsetAfterSnapIndex(_indexTipPos);

    for (const hs of handStates) {
      if (hs.inputSource === grabInputSource) continue;
      if (!hs.isPinched || hs.wasPinched) continue;
      if (handGrabBlockedWhileDrawing(hs.inputSource)) continue;
      rayDirFromIndexTipPose(hs.indexPose);
      const picked = pickStrokeMesh(hs.indexPos, _rayDir);
      if (!sameGrabTarget(picked, grabbedMesh)) continue;

      const lr = leftRightSources(grabInputSource, hs.inputSource);
      if (!lr) continue;
      if (!getIndexTipWorldInto(frame, refSpace, lr.left.hand, thPL)) continue;
      if (!getIndexTipWorldInto(frame, refSpace, lr.right.hand, thPR)) continue;
      initTwoHandGrab(grabbedMesh, thPL, thPR, lr.left, lr.right, frame, refSpace);
      break;
    }

    if (grabMode === "one" && grabbedMesh && grabInputSource && isStylusGrabForManip()) {
      const pickStylus = pickStrokeMeshFromStylusTip();
      if (sameGrabTarget(pickStylus, grabbedMesh)) {
        if (grabInputSource.handedness === "left") {
          getIndexTipWorldInto(frame, refSpace, grabInputSource.hand, thPL);
          thPR.copy(stylus.position);
          initTwoHandGrab(grabbedMesh, thPL, thPR, grabInputSource, null, frame, refSpace);
        } else if (grabInputSource.handedness === "right") {
          thPL.copy(stylus.position);
          getIndexTipWorldInto(frame, refSpace, grabInputSource.hand, thPR);
          initTwoHandGrab(grabbedMesh, thPL, thPR, null, grabInputSource, frame, refSpace);
        }
      }
    }
    return;
  }

  const starters = handStates.filter(
    (h) => h.isPinched && !h.wasPinched && !handGrabBlockedWhileDrawing(h.inputSource),
  );

  if (starters.length === 2) {
    const [a, b] = starters;
    const lr = leftRightSources(a.inputSource, b.inputSource);
    if (lr) {
      rayDirFromIndexTipPose(a.indexPose);
      const pickA = pickStrokeMesh(a.indexPos, _rayDir);
      rayDirFromIndexTipPose(b.indexPose);
      const pickB = pickStrokeMesh(b.indexPos, _rayDir);
      if (pickA && pickB && sameGrabTarget(pickA, pickB)) {
        const pL = lr.left === a.inputSource ? a.indexPos : b.indexPos;
        const pR = lr.right === a.inputSource ? a.indexPos : b.indexPos;
        initTwoHandGrab(getStrokeGrabRoot(pickA), pL, pR, lr.left, lr.right, frame, refSpace);
        return;
      }
    }
  }

  if (stylus && gamepad1) {
    for (const hs of starters) {
      if (handGrabBlockedWhileDrawing(hs.inputSource)) continue;
      if (!isStylusGrabForManip()) continue;
      if (hs.inputSource.handedness !== "left" && hs.inputSource.handedness !== "right") continue;
      rayDirFromIndexTipPose(hs.indexPose);
      const pickH = pickStrokeMesh(hs.indexPos, _rayDir);
      const pickStylus = pickStrokeMeshFromStylusTip();
      if (pickH && pickStylus && sameGrabTarget(pickH, pickStylus)) {
        if (hs.inputSource.handedness === "left") {
          getIndexTipWorldInto(frame, refSpace, hs.hand, thPL);
          thPR.copy(stylus.position);
          initTwoHandGrab(getStrokeGrabRoot(pickH), thPL, thPR, hs.inputSource, null, frame, refSpace);
          return;
        }
        if (hs.inputSource.handedness === "right") {
          thPL.copy(stylus.position);
          getIndexTipWorldInto(frame, refSpace, hs.hand, thPR);
          initTwoHandGrab(getStrokeGrabRoot(pickH), thPL, thPR, null, hs.inputSource, frame, refSpace);
          return;
        }
      }
    }
  }

  for (const hs of starters) {
    rayDirFromIndexTipPose(hs.indexPose);
    const picked = pickStrokeMesh(hs.indexPos, _rayDir);
    if (picked) {
      const root = getStrokeGrabRoot(picked);
      grabbedMesh = root;
      grabInputSource = hs.inputSource;
      grabInputIsStylus = false;
      grabMode = "one";
      jointPositionFromPose(hs.indexPose, _indexTipPos);
      root.getWorldPosition(_meshWorld);
      grabOffsetWorld.copy(_meshWorld).sub(_indexTipPos);
      snapGrabbedRootAtGrabStart(root, _indexTipPos);
      break;
    }
  }

  if (grabMode === "none" && stylus && gamepad1 && isStylusGrabForManip()) {
    const picked = pickStrokeMeshFromStylusTip();
    if (picked) {
      const root = getStrokeGrabRoot(picked);
      grabbedMesh = root;
      grabMode = "one";
      grabInputIsStylus = true;
      grabInputSource = null;
      root.getWorldPosition(_meshWorld);
      grabOffsetWorld.copy(_meshWorld).sub(stylus.position);
      snapGrabbedRootAtGrabStart(root, stylus.position);
    }
  }
}

function animate(time, frame) {
  refreshMxInkGamepad();
  _eraserThisFrame = false;

  let pinchBlocksPen = false;
  if (frame && renderer.xr.isPresenting) {
    const session = renderer.xr.getSession();
    if (session) pinchBlocksPen = isStylusHandFingerPinching(frame, session);
  }
  lastFingerPinchBlocksPen = pinchBlocksPen;

  if (gamepad1) {
    const mid = gamepad1.buttons[CLUSTER_MIDDLE_DRAW_BTN_INDEX];
    const midFirm = !!(mid && mid.value > CLUSTER_MIDDLE_DRAW_THRESHOLD);
    const tipF = getTipForce01();
    const tipDraw = tipF > TIP_FORCE_DRAW_THRESHOLD;
    _eraserThisFrame = isGamepadButtonActive(
      gamepad1,
      CLUSTER_FRONT_ERASER_BTN_INDEX,
      CLUSTER_FRONT_ERASER_ACTIVATE
    );

    prevIsDrawing = isDrawing;
    const rawDraw = (midFirm || tipDraw) && !_eraserThisFrame && !pinchBlocksPen;
    isDrawing = rawDraw && !pinchBlocksPen;

    if (isDrawing && !prevIsDrawing && stylus && !pinchBlocksPen) {
      beginStroke(stylus.position);
    }
  }

  if (!isEraserHeld()) {
    handleDrawing(stylus);
  }

  if (currentStrokePainter && !isStrokeActive()) {
    const mesh = currentStrokePainter.mesh;
    mesh.userData.points = currentStrokePointsLocal.map((p) => p.clone());
    delete mesh.userData.centerLocal;
    mesh.userData.syncId = crypto.randomUUID();
    currentStrokePainter = null;
    currentStrokePointsLocal.length = 0;
    linkStrokeClusterIfNeeded(mesh);
    pushCompletedStrokeForBlockMode(mesh);
    scheduleSketcharPush();
    if (sketcharPollDeferred) pollSketcharRemote();
  }

  if (frame && renderer.xr.isPresenting) {
    handleHandGrab(frame);
  }

  if (stylus && gamepad1 && isEraserHeld()) {
    handleEraseWithStylus();
  }

  if (frame && renderer.xr.isPresenting) {
    const session = renderer.xr.getSession();
    if (session) updateFingerDebug(frame, session);
    handleGridSnapTogglePinch(frame);
    handleBlockModePinch(frame);
    handleSceneManip(frame);
    updateRingGridSnapIndicatorSprites();
  }

  if (
    grabMode === "none" &&
    prevGrabModeForSketchar !== "none" &&
    sketcharPollDeferred
  ) {
    pollSketcharRemote();
  }
  prevGrabModeForSketchar = grabMode;

  updateHudFollow(time);
  updateHudClock();

  if (grid3dGroupRef) {
    grid3dGroupRef.visible = snapToGridEnabled;
    updateGridDotsInkUniform();
  }

  renderer.render(scene, camera);
}

function handleDrawing(controller) {
  if (!controller || !currentStrokePainter) return;

  const userData = controller.userData;

  if (gamepad1) {
    _snapNext.copy(stylus.position);
    if (snapToGridEnabled) snapWorldPointToGrid(_snapNext);

    if (isDrawing) {
      const w = getPressureStrokeWidth();
      if (snapToGridEnabled) {
        emitManhattanSnapSegments(currentStrokePainter, w, _lastStrokeSnapWorld, _snapNext);
      } else {
        cursor.copy(_snapNext);
        if (currentStrokePointsLocal.length >= STROKE_MAX_POINTS) {
          return;
        }
        if (
          currentStrokePointsLocal.length > 0 &&
          cursor.distanceToSquared(_lastStrokeSampleWorld) < STROKE_MIN_SAMPLE_DIST_SQ
        ) {
          return;
        }
        currentStrokePainter.setSize(w);
        currentStrokePainter.mesh.userData.strokeWidth = w;
        strokeMeshLocalFromWorld(_strokeMeshLocal, cursor);
        currentStrokePainter.lineTo(_strokeMeshLocal);
        currentStrokePainter.update();
        appendStrokePointWorld(cursor);
        _lastStrokeSampleWorld.copy(cursor);
      }
    } else {
      cursor.copy(_snapNext);
    }
  }
}

/** XR session gamepad is the live source for tip axes; controller `connected` gamepad can lag. */
function refreshMxInkGamepad() {
  if (!renderer.xr.isPresenting) return;
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const src of session.inputSources) {
    if (!src.gamepad) continue;
    const isInk = src.profiles && src.profiles.some((p) => p.includes("mx-ink"));
    if (!isInk) continue;
    if (stylusHandedness === "none" || src.handedness === "none" || src.handedness === stylusHandedness) {
      gamepad1 = src.gamepad;
      return;
    }
  }
}

function onControllerConnected(e) {
  if (e.data.profiles.includes("logitech-mx-ink")) {
    stylus = e.target;
    stylusHandedness = e.data.handedness === "left" || e.data.handedness === "right" ? e.data.handedness : "none";
    gamepad1 = e.data.gamepad;
  }
}

function onSelectStart(e) {
  if (e.target !== stylus) return;
  // Ink: gamepad cluster_front / cluster_middle / tip — not XR select.
  this.userData.isSelecting = false;
}

function onSelectEnd() {
  this.userData.isSelecting = false;
}

function debugGamepad(gamepad) {
  gamepad.buttons.forEach((btn, index) => {
    if (btn.pressed) {
      console.log(`BTN ${index} - Pressed: ${btn.pressed} - Touched: ${btn.touched} - Value: ${btn.value}`);
    }

    if (btn.touched) {
      console.log(`BTN ${index} - Pressed: ${btn.pressed} - Touched: ${btn.touched} - Value: ${btn.value}`);
    }
  });
}
