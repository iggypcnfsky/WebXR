import * as THREE from "three";
import Axis3d from "lucide/dist/esm/icons/axis-3d.js";
import Boxes from "lucide/dist/esm/icons/boxes.js";
import Copy from "lucide/dist/esm/icons/copy.js";
import Trash2 from "lucide/dist/esm/icons/trash-2.js";
import Grid3x3 from "lucide/dist/esm/icons/grid-3x3.js";
import Link2 from "lucide/dist/esm/icons/link-2.js";
import LogIn from "lucide/dist/esm/icons/log-in.js";
import MapPin from "lucide/dist/esm/icons/map-pin.js";
import Monitor from "lucide/dist/esm/icons/monitor.js";
import Smartphone from "lucide/dist/esm/icons/smartphone.js";
import Menu from "lucide/dist/esm/icons/menu.js";
import PenLine from "lucide/dist/esm/icons/pen-line.js";
import Radio from "lucide/dist/esm/icons/radio.js";
import Users from "lucide/dist/esm/icons/users.js";
import Undo2 from "lucide/dist/esm/icons/undo-2.js";
import Redo2 from "lucide/dist/esm/icons/redo-2.js";
import CloudUpload from "lucide/dist/esm/icons/cloud-upload.js";
import { TubePainter } from "three/examples/jsm/misc/TubePainter.js";
import {
  computeGridBoxStrokeMaxVertices,
  createGridBoxStrokePainter,
} from "./misc/GridBoxStrokePainter.js";
import {
  computeTubePainterMaxVertices,
  createTubePainterSized,
} from "./misc/TubePainterSized.js";
import { patchWebXRDepthSensingMeshIfNeeded } from "./misc/xrDepthFeather.js";
import { HTMLMesh } from "three/examples/jsm/interactive/HTMLMesh.js";
import { InteractiveGroup } from "three/examples/jsm/interactive/InteractiveGroup.js";
import { XRButton } from "three/examples/jsm/webxr/XRButton.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import {
  applyScenePayloadIncremental,
  deserializeSceneV1,
  disposeSceneGeometrySubtree,
  mergeScenePayloadsForPush,
  mergeScenePayloadsForViewerPoll,
  nodeIdFromPayload,
  sceneNodeIdFromObject3D,
  scenePayloadsEqual,
  serializeStrokesGroup,
  snapshotTimestampIsStrictlyOlder,
  snapshotTimestampsEqual,
} from "./shared/sceneCodec.js";
import {
  DEFAULT_STROKE_COLOR_HEX,
  getStrokeMaterialForHex,
  voxelMaterial,
} from "./shared/strokeMaterial.js";
import {
  deleteRoomGlbFromR2,
  exportSketchToGlbArrayBuffer,
  uploadGlbArrayBuffer,
} from "./shared/glbExport.js";
import { normalizeRoomCode } from "./shared/roomCode.js";
import { loadRoomHistory, rememberRoom } from "./shared/sketcharRoomHistory.js";
import {
  defaultPresenceLabel,
  disposePresencePeerSubtree,
  getOrCreateDeviceId,
  getShowOthersPreference,
  preloadPresenceHeadModel,
  preloadPresenceStylusModel,
  pruneStalePresencePeers,
  refreshPresenceVisualsFromStoredPayload,
  setPresenceLabelRenderer,
  setPresenceTargetsFromPayload,
  setShowOthersPreference,
  SKETCHAR_PRESENCE_HEAD_GLB_URL,
  SKETCHAR_PRESENCE_STYLUS_GLB_URL,
  smoothPresencePeers,
} from "./shared/sketcharPresence.js";
import { smoothSceneNetworkTransforms } from "./shared/sceneNetworkTransformSmooth.js";
import {
  createRoom,
  fetchRoomBySlug,
  getSketcharSupabase,
  isSketcharConfigured,
  subscribeRoom,
  upsertPin,
  upsertSnapshot,
} from "./shared/sketcharSupabase.js";

let camera, scene, renderer;
let controller1, controller2;
let controller3, controller4;
/** @type {THREE.Group[]} Target-ray groups used for wrist HTMLMesh XR interaction (slots 0–3). */
const xrWristUiControllers = [];
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

/** Axes + optional floor at content origin (0,0,0); shown in XR only. */
let originGizmoGroup = null;
/** @type {THREE.GridHelper | null} */
let originFloorGrid = null;
let showOriginFloor = true;
/** Debug: wireframe sphere + ray at index tip matching `pickStrokeMesh` reach. */
let showPickStrokeDebug = false;
/** @type {THREE.Group | null} */
let pickStrokeDebugLeft = null;
/** @type {THREE.Group | null} */
let pickStrokeDebugRight = null;
/** MX Ink tip pick preview (same cone as `pickStrokeMeshFromStylusTip`; warm = free, cool = grid snap). */
/** @type {THREE.Group | null} */
let pickStrokeDebugStylus = null;

const remotePresenceGroup = new THREE.Group();
remotePresenceGroup.name = "remote-presence";
/** @type {Map<string, THREE.Group>} */
const sketcharRemotePeers = new Map();
const sketcharDeviceId = getOrCreateDeviceId();
let sketcharShowOthers = getShowOthersPreference();
let lastPresenceSmoothMs = performance.now();
let lastSceneNetworkSmoothMs = performance.now();

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
/** Last `sceneContentRoot.scale.x` that `refreshAllStrokesTubeGeometryForWorldWidth` was applied for (two-hand manip). */
let sceneTwoHandStrokeRefreshAtScale = 1;
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
/** Raw thumb–middle anchors before two-hand smoothing (scene manip). */
const _smRawL = new THREE.Vector3();
const _smRawR = new THREE.Vector3();
/** First successful `updateSceneTwoHandGrab` frame: snap smoothed state to raw. */
let sceneTwoHandSmoothInit = true;
/** Low-pass of `dist / sm_thDist0` — raw distance jitters while rotating, which looked like scale jitter. */
let sceneTwoHandScaleSmoothed = 1;

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

/** Sketchar: Supabase Postgres + Realtime (see src/shared/sketcharSupabase.js). */
let sketcharRoomSlug = "";
/** @type {string} */
let sketcharRoomId = "";
let sketcharBroadcast = true;
/** @type {ReturnType<typeof setTimeout> | null} */
let sketcharPushTimer = null;
let sketcharGrabTransformPushLastMs = 0;
let sketcharGrabPushInFlight = false;
const SKETCHAR_GRAB_TRANSFORM_PUSH_MS = 120;
/** @type {{ unsubscribe: () => void, sendPresence: (p: import("./shared/sketcharPresence.js").SketcharPresencePayload) => void } | null} */
let sketcharRoomRealtime = null;
/** @type {string | null} */
let lastSketcharRemoteSeen = null;
/** Stroke syncIds from Quest not yet confirmed by a successful upsert (see mergeScenePayloadsForViewerPoll). */
const sketcharPendingSyncIds = new Set();
/** Locally removed ids (tombstones) until the next merged upsert omits them or remote confirms. */
const sketcharDeletedSyncIds = new Set();
let sketcharPollBusy = false;
/** Set when a remote update was skipped while drawing/grabbing; flushed once idle. */
let sketcharPollDeferred = false;

let lastSketcharPresenceSendMs = 0;
const SKETCHAR_PRESENCE_SEND_MS = 100;
const _questHeadWorld = new THREE.Vector3();
const _questHeadLocal = new THREE.Vector3();
const _questHeadQuatWorld = new THREE.Quaternion();
const _questHeadLocalQuat = new THREE.Quaternion();
const _strokesWorldQuatForPresence = new THREE.Quaternion();
const _stylusWorld = new THREE.Vector3();
const _stylusLocal = new THREE.Vector3();
const _stylusQuatWorld = new THREE.Quaternion();
const _stylusLocalQuat = new THREE.Quaternion();
const _tipWorld = new THREE.Vector3();
const _tipLocal = new THREE.Vector3();

/** Order matches presence preview finger spheres (thumb → pinky). */
const PRESENCE_STREAM_FINGER_JOINTS = [
  "thumb-tip",
  "index-finger-tip",
  "middle-finger-tip",
  "ring-finger-tip",
  "pinky-finger-tip",
];

/** Left-wrist settings panel in XR (HTMLMesh + InteractiveGroup). */
/** @type {THREE.Group | null} */
let wristMenuGroup = null;
/** @type {THREE.Group | null} */
let wristMenuOffsetGroup = null;
/** @type {InteractiveGroup | null} */
let wristInteractiveGroup = null;
/** @type {InstanceType<typeof HTMLMesh> | null} */
let wristHtmlMesh = null;

/** Left-palm circular stroke-color panel (HTMLMesh + InteractiveGroup). */
/** @type {THREE.Group | null} */
let palmMenuGroup = null;
/** @type {THREE.Group | null} */
let palmMenuOffsetGroup = null;
/** @type {InteractiveGroup | null} */
let palmInteractiveGroup = null;
/** @type {InstanceType<typeof HTMLMesh> | null} */
let palmHtmlMesh = null;

/** World scale for HTMLMesh (3× smaller than prior 0.5, then 1.5× larger). */
const WRIST_MENU_CONTENT_SCALE = (0.5 / 3) * 1.5;
/** Circular palm menu: slightly larger in world space (radial color wheel needs readable pixels). */
const PALM_MENU_CONTENT_SCALE = WRIST_MENU_CONTENT_SCALE * 1.12;
/** Palm outward offset (m): panel sits in front of palm surface, not behind the hand. */
const WRIST_MENU_PALM_OFFSET_M = 0.048;
/** Small shift along finger direction (toward tips) — lower than before “above wrist”. */
const WRIST_MENU_FINGER_SHIFT_M = 0.022;
/** Proximal shift (toward elbow) from wrist along the forearm axis — places the settings panel on the forearm. */
const WRIST_MENU_FOREARM_SHIFT_M = 0.09;
/** min dot(palmNormal, toCamera) to show menu — palm toward headset. */
const WRIST_MENU_PALM_FACE_DOT_MIN = 0.52;
/** Left palm menu: anchor between wrist and middle metacarpal (palm center). */
const PALM_MENU_CENTER_LERP = 1.3;
/** Offset along palm X (thumb +); 0 centers the color wheel on the palm. */
const PALM_MENU_LATERAL_SHIFT_M = 0;
/** Palm menu sits slightly farther out along volar normal than the wrist panel. */
const PALM_MENU_PALM_OFFSET_M = 0.038;
/** Toward fingertips along forearm/finger axis (m); shifts color wheel onto palm (away from floating above it). */
const PALM_MENU_FINGER_SHIFT_M = 0.048;
/** Half-thickness (m) of the touch slab around each HTMLMesh plane: |tipDistance| ≤ this counts as contact. */
const STYLUS_UI_TOUCH_SLAB_M = 0.005;
/** Must match `.palm-hue-ring` mask inner radius (SV disc outer radius / wheel radius). */
const PALM_WHEEL_SV_RADIUS_NORM = 0.76;
/** Outer edge of hue ring (wheel radius fraction). */
const PALM_WHEEL_HUE_OUTER_NORM = 0.998;
/** Hue cursor sits mid-band between SV disc and outer rim (matches CSS). */
const PALM_WHEEL_HUE_CURSOR_NORM = 0.87;
const _palmAnchorPos = new THREE.Vector3();
const _palmScratchPos = new THREE.Vector3();
const _wristMenuScratchPos = new THREE.Vector3();
const _wristMenuPos = new THREE.Vector3();
const _wristMiddleMeta = new THREE.Vector3();
const _wristIndexMeta = new THREE.Vector3();
const _wristToMiddle = new THREE.Vector3();
const _wristToIndex = new THREE.Vector3();
const _wristPalmNormal = new THREE.Vector3();
const _wristToCamera = new THREE.Vector3();
const _wristX = new THREE.Vector3();
const _wristY = new THREE.Vector3();
const _wristZ = new THREE.Vector3();
const _wristBasis = new THREE.Matrix4();

const wristUiRaycaster = new THREE.Raycaster();
const _wristUiOrigin = new THREE.Vector3();
const _wristUiDir = new THREE.Vector3();
const wristMenuLastUv = new THREE.Vector2();
const _wristUiPointerData = new THREE.Vector2();
/** @type {{ type: string; data: THREE.Vector2 }} */
const _wristUiSyntheticEvent = { type: "", data: _wristUiPointerData };
let wristMenuUvValid = false;
const palmMenuLastUv = new THREE.Vector2();
let palmMenuUvValid = false;
/** @type {InstanceType<typeof HTMLMesh> | null} */
let lastStylusUiMesh = null;
let wristUiSqueezePrev = false;
/** True while stylus tip is dragging on the palm color wheel after plane penetration. */
let palmWheelDragActive = false;
const _palmWheelLastDragUv = new THREE.Vector2(-1, -1);
/** Previous frame: stylus tip was inside the touch slab for each UI plane (for rising-edge click). */
let wristUiTouchSlabPrev = false;
let palmUiTouchSlabPrev = false;
const _persistWristUv = new THREE.Vector2();
let persistWristUvValid = false;
const _persistPalmUv = new THREE.Vector2();
let persistPalmUvValid = false;
const _meshPlaneNormal = new THREE.Vector3();
const _meshPlaneTipDelta = new THREE.Vector3();
const _meshPlaneCenter = new THREE.Vector3();
const _wristUiInvMatrix = new THREE.Matrix4();
const _tipLocalForUi = new THREE.Vector3();
/** Last stylus–mesh hit distance (m) after pointer assist; Infinity if no hit. */
let lastStylusUiWristHitDist = Infinity;
let lastStylusUiPalmHitDist = Infinity;

/** Active stroke color (left palm palette); synced on stroke complete. */
let activeStrokeColorHex = DEFAULT_STROKE_COLOR_HEX;

function hexToRgb(hex) {
  const h = hex >>> 0;
  return { r: (h >> 16) & 255, g: (h >> 8) & 255, b: h & 255 };
}

function rgbToHex(r, g, b) {
  return (((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0;
}

/** @returns {{ h: number; s: number; v: number }} */
function rgbToHsv(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let hh = 0;
  if (d !== 0) {
    if (max === rn) hh = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) hh = ((bn - rn) / d + 2) / 6;
    else hh = ((rn - gn) / d + 4) / 6;
  }
  const s = max === 0 ? 0 : d / max;
  return { h: hh * 360, s, v: max };
}

function hsvToRgb(h, s, v) {
  const hh = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hh < 60) {
    rp = c;
    gp = x;
  } else if (hh < 120) {
    rp = x;
    gp = c;
  } else if (hh < 180) {
    gp = c;
    bp = x;
  } else if (hh < 240) {
    gp = x;
    bp = c;
  } else if (hh < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

function forcePalmHtmlTextureUpdate() {
  const root = document.getElementById("palm-color-menu");
  if (root) root.setAttribute("data-fresh", String(Date.now()));
  const map = palmHtmlMesh?.material?.map;
  if (map && typeof map.update === "function") map.update();
}

function forceWristHtmlTextureUpdate() {
  const root = document.getElementById("sketchar-advanced");
  if (root) root.setAttribute("data-fresh", String(Date.now()));
  const map = wristHtmlMesh?.material?.map;
  if (map && typeof map.update === "function") map.update();
}

/** Pixel size of #palm-color-wheel-canvas (must match CSS .palm-color-wheel). */
const PALM_WHEEL_CANVAS_PX = 248;

/**
 * Paint hue ring + SV disc. HTMLMesh rasterizes canvas pixels; it does not render CSS gradients/masks.
 */
function drawPalmColorWheelCanvas() {
  const canvas = document.getElementById("palm-color-wheel-canvas");
  if (!canvas) return;
  const rgb = hexToRgb(activeStrokeColorHex);
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  const hueDeg = hsv.h;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = PALM_WHEEL_CANVAS_PX;
  const h = PALM_WHEEL_CANVAS_PX;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2;
  const rInner = R * PALM_WHEEL_SV_RADIUS_NORM;
  const rOuter = R;

  ctx.clearRect(0, 0, w, h);

  for (let i = 0; i < 360; i++) {
    const a0 = ((-90 + i) * Math.PI) / 180;
    const a1 = ((-90 + i + 1) * Math.PI) / 180;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, a0, a1);
    ctx.arc(cx, cy, rInner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = `hsl(${i}, 100%, 50%)`;
    ctx.fill();
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
  ctx.clip();
  const gradH = ctx.createLinearGradient(cx - rInner, cy, cx + rInner, cy);
  gradH.addColorStop(0, "#ffffff");
  gradH.addColorStop(1, `hsl(${hueDeg}, 100%, 50%)`);
  ctx.fillStyle = gradH;
  ctx.fillRect(cx - rInner, cy - rInner, 2 * rInner, 2 * rInner);
  const gradV = ctx.createLinearGradient(0, cy - rInner, 0, cy + rInner);
  gradV.addColorStop(0, "rgba(0,0,0,0)");
  gradV.addColorStop(1, "#000000");
  ctx.fillStyle = gradV;
  ctx.fillRect(cx - rInner, cy - rInner, 2 * rInner, 2 * rInner);
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1;
  ctx.stroke();

  canvas.setAttribute("data-palm-draw", String(Date.now()));
}

/**
 * @param {number} u UV.x on #palm-color-menu (0–1)
 * @param {number} v UV.y on #palm-color-menu (0–1)
 */
function applyPalmWheelFromUv(u, v) {
  const palmRoot = document.getElementById("palm-color-menu");
  const wheel = document.getElementById("palm-color-wheel");
  if (!palmRoot || !wheel) return;
  const pr = palmRoot.getBoundingClientRect();
  const wr = wheel.getBoundingClientRect();
  const screenX = pr.left + u * pr.width;
  const screenY = pr.top + v * pr.height;
  const cx = wr.left + wr.width / 2;
  const cy = wr.top + wr.height / 2;
  const dx = screenX - cx;
  const dy = screenY - cy;
  const R = Math.min(wr.width, wr.height) / 2;
  if (R < 1e-6) return;
  const rNorm = Math.hypot(dx, dy) / R;
  if (rNorm > PALM_WHEEL_HUE_OUTER_NORM) return;
  const rgb0 = hexToRgb(activeStrokeColorHex);
  const prevHsv = rgbToHsv(rgb0.r, rgb0.g, rgb0.b);
  if (rNorm <= PALM_WHEEL_SV_RADIUS_NORM) {
    let nx = dx / (R * PALM_WHEEL_SV_RADIUS_NORM);
    let ny = dy / (R * PALM_WHEEL_SV_RADIUS_NORM);
    const len = Math.hypot(nx, ny);
    if (len > 1) {
      nx /= len;
      ny /= len;
    }
    const ss = 0.5 * (nx + 1);
    const vv = 0.5 * (1 - ny);
    const rgb = hsvToRgb(prevHsv.h, ss, vv);
    activeStrokeColorHex = rgbToHex(rgb.r, rgb.g, rgb.b);
  } else {
    const hh = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const h = ((hh % 360) + 360) % 360;
    const rgb = hsvToRgb(h, prevHsv.s, prevHsv.v);
    activeStrokeColorHex = rgbToHex(rgb.r, rgb.g, rgb.b);
  }
  syncPalmPaletteSelectedUi();
  forcePalmHtmlTextureUpdate();
}

function clearSketcharRemotePeers() {
  for (const g of sketcharRemotePeers.values()) {
    remotePresenceGroup.remove(g);
    disposePresencePeerSubtree(g);
  }
  sketcharRemotePeers.clear();
}

function handleSketcharRemotePresence(p) {
  if (!p || p.deviceId === sketcharDeviceId) return;
  if (!sketcharShowOthers) return;
  let g = sketcharRemotePeers.get(p.deviceId);
  if (!g) {
    g = new THREE.Group();
    g.name = `peer-${p.deviceId}`;
    g.userData.isPresencePeerRoot = true;
    remotePresenceGroup.add(g);
    sketcharRemotePeers.set(p.deviceId, g);
  }
  g.userData.lastMs = performance.now();
  setPresenceTargetsFromPayload(p, g);
}

function stopSketcharSubscription() {
  if (sketcharRoomRealtime) {
    sketcharRoomRealtime.unsubscribe();
    sketcharRoomRealtime = null;
  }
  lastSketcharPresenceSendMs = 0;
  clearSketcharRemotePeers();
}

function startSketcharSubscription() {
  stopSketcharSubscription();
  if (!sketcharRoomId) return;
  const sb = getSketcharSupabase();
  if (!sb) return;
  sketcharRoomRealtime = subscribeRoom(sb, sketcharRoomId, {
    onSnapshot: (ev) => {
      void handleSketcharRemoteSnapshot(ev);
    },
    onAlignment: () => {},
    onPresence: handleSketcharRemotePresence,
  });
}

function recordSketcharDeletionForObject3D(o) {
  if (!o) return;
  const raw =
    o.userData && typeof o.userData.syncId === "string"
      ? o.userData.syncId.trim()
      : "";
  const id = raw || sceneNodeIdFromObject3D(o);
  if (id) sketcharDeletedSyncIds.add(id);
}

function scheduleSketcharPush() {
  if (!sketcharBroadcast || !sketcharRoomSlug) return;
  if (sketcharPushTimer) clearTimeout(sketcharPushTimer);
  sketcharPushTimer = setTimeout(() => {
    sketcharPushTimer = null;
    pushSketcharSnapshot();
  }, 500);
}

/** While grabbing/moving scene content, push transforms at a low rate so other clients see motion live. */
function maybePushSketcharDuringGrabTransform() {
  if (!sketcharBroadcast || !sketcharRoomSlug) return;
  if (grabMode === "none" || !grabbedMesh) return;
  if (isStrokeActive() || currentStrokePainter !== null) return;
  const t = performance.now();
  if (t - sketcharGrabTransformPushLastMs < SKETCHAR_GRAB_TRANSFORM_PUSH_MS) return;
  if (sketcharGrabPushInFlight) return;
  sketcharGrabTransformPushLastMs = t;
  sketcharGrabPushInFlight = true;
  void pushSketcharSnapshot().finally(() => {
    sketcharGrabPushInFlight = false;
  });
}

async function pushSketcharSnapshot() {
  if (!sketcharBroadcast || !sketcharRoomSlug || !sketcharRoomId) return;
  /* Defer entire push only while a stroke is in progress (TubePainter / points in flux). Grab does not block upload. */
  if (isStrokeActive() || currentStrokePainter !== null) {
    scheduleSketcharPush();
    return;
  }
  strokesGroup.updateMatrixWorld(true);
  const statusEl = document.getElementById("sketchar-status");
  try {
    const sb = getSketcharSupabase();
    if (!sb) throw new Error("supabase_unconfigured");
    let remoteSnapshot = null;
    const roomData = await fetchRoomBySlug(sb, sketcharRoomSlug);
    if (roomData) remoteSnapshot = roomData.snapshot ?? null;
    if (isStrokeActive() || currentStrokePainter !== null) {
      scheduleSketcharPush();
      return;
    }
    const localPayload = serializeStrokesGroup(strokesGroup);
    const merged = mergeScenePayloadsForPush(
      localPayload,
      remoteSnapshot,
      sketcharDeletedSyncIds,
      sketcharPendingSyncIds,
    );
    if (!scenePayloadsEqual(localPayload, merged)) {
      if (!shouldDeferSketcharSceneApply()) {
        applyScenePayloadIncremental(merged, voxelMaterial, strokesGroup);
      }
    }
    strokesGroup.updateMatrixWorld(true);
    const { updatedAt } = await upsertSnapshot(sb, sketcharRoomId, merged);
    for (const n of merged.nodes) {
      sketcharPendingSyncIds.delete(nodeIdFromPayload(n));
    }
    for (const id of [...sketcharDeletedSyncIds]) {
      if (!merged.nodes.some((n) => nodeIdFromPayload(n) === id)) {
        sketcharDeletedSyncIds.delete(id);
      }
    }
    if (updatedAt != null) lastSketcharRemoteSeen = String(updatedAt);
    if (statusEl) {
      statusEl.textContent = "Sketchar: synced";
      statusEl.dataset.state = "ok";
    }
    forceWristHtmlTextureUpdate();
  } catch (e) {
    console.warn("Sketchar push failed", e);
    if (statusEl) {
      statusEl.textContent = "Sketchar: sync error";
      statusEl.dataset.state = "err";
    }
    forceWristHtmlTextureUpdate();
  }
}

/**
 * @param {{ payload?: unknown, updatedAt?: string | null }} ev
 */
async function handleSketcharRemoteSnapshot(ev) {
  if (!sketcharRoomSlug || sketcharPollBusy) return;
  if (shouldDeferSketcharSceneApply()) {
    sketcharPollDeferred = true;
    return;
  }
  sketcharPollBusy = true;
  try {
    const at = ev.updatedAt != null ? String(ev.updatedAt) : null;
    if (
      at != null &&
      lastSketcharRemoteSeen != null &&
      snapshotTimestampsEqual(at, lastSketcharRemoteSeen)
    ) {
      sketcharPollDeferred = false;
      return;
    }
    if (
      at != null &&
      lastSketcharRemoteSeen != null &&
      snapshotTimestampIsStrictlyOlder(at, lastSketcharRemoteSeen)
    ) {
      sketcharPollDeferred = false;
      return;
    }
    const remoteSnapshot = ev.payload ?? null;
    if (shouldDeferSketcharSceneApply()) {
      sketcharPollDeferred = true;
      return;
    }
    strokesGroup.updateMatrixWorld(true);
    const localPayload = serializeStrokesGroup(strokesGroup);
    const merged = mergeScenePayloadsForViewerPoll(
      remoteSnapshot,
      localPayload,
      sketcharPendingSyncIds,
      sketcharDeletedSyncIds,
    );
    for (const id of [...sketcharDeletedSyncIds]) {
      if (!merged.nodes.some((n) => nodeIdFromPayload(n) === id)) {
        sketcharDeletedSyncIds.delete(id);
      }
    }
    if (!scenePayloadsEqual(localPayload, merged)) {
      applyScenePayloadIncremental(merged, voxelMaterial, strokesGroup, {
        smoothNetworkTransforms: true,
        isLocalAuthority: sceneNetworkIsLocalAuthority,
      });
    }
    strokesGroup.updateMatrixWorld(true);
    if (at !== null) lastSketcharRemoteSeen = at;
    sketcharPollDeferred = false;
  } catch (e) {
    console.warn("Sketchar remote failed", e);
  } finally {
    sketcharPollBusy = false;
  }
}

async function flushSketcharRemote() {
  if (!sketcharRoomSlug || sketcharPollBusy) return;
  if (shouldDeferSketcharSceneApply()) return;
  const sb = getSketcharSupabase();
  if (!sb) return;
  sketcharPollBusy = true;
  try {
    const data = await fetchRoomBySlug(sb, sketcharRoomSlug);
    if (!data) return;
    if (shouldDeferSketcharSceneApply()) {
      sketcharPollDeferred = true;
      return;
    }
    const at =
      data.snapshotUpdatedAt != null ? String(data.snapshotUpdatedAt) : null;
    if (
      at != null &&
      lastSketcharRemoteSeen != null &&
      snapshotTimestampsEqual(at, lastSketcharRemoteSeen)
    ) {
      sketcharPollDeferred = false;
      return;
    }
    if (
      at != null &&
      lastSketcharRemoteSeen != null &&
      snapshotTimestampIsStrictlyOlder(at, lastSketcharRemoteSeen)
    ) {
      sketcharPollDeferred = false;
      return;
    }
    const remoteSnapshot = data.snapshot ?? null;
    strokesGroup.updateMatrixWorld(true);
    const localPayload = serializeStrokesGroup(strokesGroup);
    const merged = mergeScenePayloadsForViewerPoll(
      remoteSnapshot,
      localPayload,
      sketcharPendingSyncIds,
      sketcharDeletedSyncIds,
    );
    for (const id of [...sketcharDeletedSyncIds]) {
      if (!merged.nodes.some((n) => nodeIdFromPayload(n) === id)) {
        sketcharDeletedSyncIds.delete(id);
      }
    }
    if (!scenePayloadsEqual(localPayload, merged)) {
      applyScenePayloadIncremental(merged, voxelMaterial, strokesGroup, {
        smoothNetworkTransforms: true,
        isLocalAuthority: sceneNetworkIsLocalAuthority,
      });
    }
    strokesGroup.updateMatrixWorld(true);
    if (at !== null) lastSketcharRemoteSeen = at;
    sketcharPollDeferred = false;
  } catch (e) {
    console.warn("Sketchar flush failed", e);
  } finally {
    sketcharPollBusy = false;
  }
}

/**
 * @param {boolean} open
 */
function setSketcharAdvancedDrawerOpen(open) {
  const adv = document.getElementById("sketchar-advanced");
  const toggle = document.getElementById("sketchar-menu-toggle");
  const backdrop = document.getElementById("sketchar-menu-backdrop");
  if (!adv || !toggle) return;
  adv.classList.toggle("is-open", open);
  adv.setAttribute("aria-hidden", open ? "false" : "true");
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (backdrop) {
    backdrop.hidden = !open;
    backdrop.setAttribute("aria-hidden", open ? "false" : "true");
  }
}

function initSketcharMenuChrome() {
  const toggle = document.getElementById("sketchar-menu-toggle");
  const backdrop = document.getElementById("sketchar-menu-backdrop");
  if (toggle) {
    toggle.replaceChildren();
    const menuSvg = createLucideSvgDom(Menu, 22);
    menuSvg.setAttribute("aria-hidden", "true");
    toggle.appendChild(menuSvg);
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      setSketcharAdvancedDrawerOpen(!expanded);
    });
  }
  if (backdrop) {
    backdrop.addEventListener("click", () => setSketcharAdvancedDrawerOpen(false));
  }
}

/**
 * Lucide default export → inline SVG for DOM (wrist panel / settings).
 * @param {unknown} iconNode
 * @param {number} [sizePx]
 */
function createLucideSvgDom(iconNode, sizePx = 18, strokeColor = "#e8f0ff") {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(sizePx));
  svg.setAttribute("height", String(sizePx));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", strokeColor);
  svg.setAttribute("stroke-width", "2.25");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (!Array.isArray(iconNode)) return svg;
  for (const item of iconNode) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [tag, attrs] = item;
    const el = document.createElementNS(ns, tag);
    if (attrs && typeof attrs === "object") {
      for (const [k, v] of Object.entries(attrs)) {
        if (v != null && v !== "") el.setAttribute(k, String(v));
      }
    }
    svg.appendChild(el);
  }
  return svg;
}

function initSketcharLobbyIcons() {
  const elCreate = document.getElementById("sketchar-create");
  const elJoin = document.getElementById("sketchar-join");
  const elCreatePreview = document.getElementById("sketchar-create-preview");
  const elJoinPreview = document.getElementById("sketchar-join-preview");
  const iconCreate = elCreate?.querySelector(".sketchar-btn-icon");
  const iconJoin = elJoin?.querySelector(".sketchar-btn-icon");
  const iconCreatePreview = elCreatePreview?.querySelector(".sketchar-btn-icon");
  const iconJoinPreview = elJoinPreview?.querySelector(".sketchar-btn-icon");
  if (iconCreate) {
    iconCreate.replaceChildren();
    const svg = createLucideSvgDom(PenLine, 20);
    svg.setAttribute("aria-hidden", "true");
    iconCreate.appendChild(svg);
  }
  if (iconJoin) {
    iconJoin.replaceChildren();
    const svg = createLucideSvgDom(LogIn, 20);
    svg.setAttribute("aria-hidden", "true");
    iconJoin.appendChild(svg);
  }
  if (iconCreatePreview) {
    iconCreatePreview.replaceChildren();
    const svg = createLucideSvgDom(Monitor, 20);
    svg.setAttribute("aria-hidden", "true");
    iconCreatePreview.appendChild(svg);
  }
  if (iconJoinPreview) {
    iconJoinPreview.replaceChildren();
    const svg = createLucideSvgDom(Smartphone, 20);
    svg.setAttribute("aria-hidden", "true");
    iconJoinPreview.appendChild(svg);
  }
}

function initSketcharAdvancedIcons() {
  const adv = document.getElementById("sketchar-advanced");
  if (!adv) return;
  adv.querySelectorAll(".sketchar-broadcast__ico").forEach((el) => el.remove());
  adv.querySelectorAll(".sketchar-grid__ico").forEach((el) => el.remove());
  adv.dataset.lucideIcons = "1";
  const iconStroke = "#e8f0ff";
  const pin = document.getElementById("sketchar-pin-quest");
  const copy = document.getElementById("sketchar-copy");
  if (pin) {
    pin.replaceChildren();
    pin.appendChild(createLucideSvgDom(MapPin, 28, iconStroke));
  }
  if (copy) {
    copy.replaceChildren();
    copy.appendChild(createLucideSvgDom(Link2, 28, iconStroke));
  }
  const undoEl = document.getElementById("sketchar-undo");
  const redoEl = document.getElementById("sketchar-redo");
  if (undoEl) {
    undoEl.replaceChildren();
    undoEl.appendChild(createLucideSvgDom(Undo2, 28, iconStroke));
  }
  if (redoEl) {
    redoEl.replaceChildren();
    redoEl.appendChild(createLucideSvgDom(Redo2, 28, iconStroke));
  }
  const exportGlbBtn = document.getElementById("sketchar-export-glb");
  const exportGlbIcon = exportGlbBtn?.querySelector(".sketchar-wrist-export-cta__icon");
  if (exportGlbIcon) {
    exportGlbIcon.replaceChildren();
    exportGlbIcon.appendChild(createLucideSvgDom(CloudUpload, 26, iconStroke));
  }
  const swLab = document.querySelector(
    "#stroke-width-controls label[for='stroke-width-slider']",
  );
  if (swLab) {
    const svg = createLucideSvgDom(PenLine, 14, "#9ec5ff");
    svg.classList.add("sketchar-grid__ico");
    swLab.insertBefore(svg, swLab.firstChild);
  }
  const elBroadcast = document.getElementById("sketchar-broadcast");
  const elShowOthers = document.getElementById("sketchar-show-others");
  if (elBroadcast?.parentElement?.classList.contains("sketchar-broadcast")) {
    const lab = elBroadcast.parentElement;
    const svg = createLucideSvgDom(Radio, 15, "#8eb8ff");
    svg.classList.add("sketchar-broadcast__ico");
    lab.insertBefore(svg, elBroadcast);
  }
  if (elShowOthers?.parentElement?.classList.contains("sketchar-broadcast")) {
    const lab = elShowOthers.parentElement;
    const svg = createLucideSvgDom(Users, 15, "#8eb8ff");
    svg.classList.add("sketchar-broadcast__ico");
    lab.insertBefore(svg, elShowOthers);
  }
  const gridLab = document.querySelector("#grid-controls label[for='grid-cell-slider']");
  if (gridLab) {
    const svg = createLucideSvgDom(Grid3x3, 14, "#9ec5ff");
    svg.classList.add("sketchar-grid__ico");
    gridLab.insertBefore(svg, gridLab.firstChild);
  }
}

function setupSketcharWristXR() {
  const adv = document.getElementById("sketchar-advanced");
  if (!adv || !scene) return;

  document.body.classList.add("xr-presenting");
  setSketcharAdvancedDrawerOpen(false);
  adv.classList.add("sketchar-advanced--xr-source");

  wristInteractiveGroup = new InteractiveGroup();
  for (let i = 0; i < xrWristUiControllers.length; i++) {
    const c = xrWristUiControllers[i];
    if (c) wristInteractiveGroup.listenToXRControllerEvents(c);
  }

  if (wristHtmlMesh) {
    wristInteractiveGroup.remove(wristHtmlMesh);
    wristHtmlMesh.dispose();
    wristHtmlMesh = null;
  }
  if (wristInteractiveGroup.parent) {
    wristInteractiveGroup.parent.remove(wristInteractiveGroup);
  }

  /* HTMLMesh bakes the DOM to a bitmap; use a tall, narrow panel in CSS and scale here for world size.
     For truly crisp text at distance, SDF approaches (e.g. troika-three-text, as in XRBlocks SpatialPanel) replace this. */
  wristHtmlMesh = new HTMLMesh(adv);
  wristHtmlMesh.name = "sketchar-wrist-html";
  const wristMap = wristHtmlMesh.material.map;
  if (wristMap && renderer) {
    wristMap.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  }
  wristInteractiveGroup.add(wristHtmlMesh);

  wristMenuOffsetGroup = new THREE.Group();
  wristMenuOffsetGroup.name = "wrist-menu-offset";
  wristMenuOffsetGroup.scale.setScalar(WRIST_MENU_CONTENT_SCALE);
  wristMenuOffsetGroup.add(wristInteractiveGroup);

  if (wristMenuGroup) {
    scene.remove(wristMenuGroup);
    wristMenuGroup = null;
  }
  wristMenuGroup = new THREE.Group();
  wristMenuGroup.name = "wrist-menu-root";
  wristMenuGroup.add(wristMenuOffsetGroup);
  scene.add(wristMenuGroup);
  delete adv.dataset.lucideIcons;
  initSketcharAdvancedIcons();
  forceWristHtmlTextureUpdate();
}

function setupPalmMenuXR() {
  const palmEl = document.getElementById("palm-color-menu");
  if (!palmEl || !scene) return;

  palmEl.removeAttribute("hidden");
  palmEl.setAttribute("aria-hidden", "false");
  palmEl.classList.add("palm-menu--xr-source");

  palmInteractiveGroup = new InteractiveGroup();
  for (let i = 0; i < xrWristUiControllers.length; i++) {
    const c = xrWristUiControllers[i];
    if (c) palmInteractiveGroup.listenToXRControllerEvents(c);
  }

  if (palmHtmlMesh) {
    palmInteractiveGroup.remove(palmHtmlMesh);
    palmHtmlMesh.dispose();
    palmHtmlMesh = null;
  }
  if (palmInteractiveGroup.parent) {
    palmInteractiveGroup.parent.remove(palmInteractiveGroup);
  }

  palmHtmlMesh = new HTMLMesh(palmEl);
  palmHtmlMesh.name = "palm-color-html";
  const palmMap = palmHtmlMesh.material.map;
  if (palmMap && renderer) {
    palmMap.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  }
  palmInteractiveGroup.add(palmHtmlMesh);

  palmMenuOffsetGroup = new THREE.Group();
  palmMenuOffsetGroup.name = "palm-menu-offset";
  palmMenuOffsetGroup.scale.setScalar(PALM_MENU_CONTENT_SCALE);
  palmMenuOffsetGroup.add(palmInteractiveGroup);

  if (palmMenuGroup) {
    scene.remove(palmMenuGroup);
    palmMenuGroup = null;
  }
  palmMenuGroup = new THREE.Group();
  palmMenuGroup.name = "palm-menu-root";
  palmMenuGroup.add(palmMenuOffsetGroup);
  scene.add(palmMenuGroup);
  syncPalmPaletteSelectedUi();
  forcePalmHtmlTextureUpdate();
}

function teardownPalmMenuXR() {
  palmWheelDragActive = false;
  _palmWheelLastDragUv.set(-1, -1);
  wristUiTouchSlabPrev = false;
  palmUiTouchSlabPrev = false;
  persistWristUvValid = false;
  persistPalmUvValid = false;
  const palmEl = document.getElementById("palm-color-menu");
  if (palmHtmlMesh && palmInteractiveGroup) {
    palmInteractiveGroup.remove(palmHtmlMesh);
    palmHtmlMesh.dispose();
    palmHtmlMesh = null;
  }
  if (palmMenuGroup && scene) {
    scene.remove(palmMenuGroup);
    palmMenuGroup = null;
  }
  palmMenuOffsetGroup = null;
  palmInteractiveGroup = null;
  if (palmEl) {
    palmEl.classList.remove("palm-menu--xr-source");
    palmEl.setAttribute("hidden", "");
    palmEl.setAttribute("aria-hidden", "true");
  }
}

function teardownSketcharWristXR() {
  const adv = document.getElementById("sketchar-advanced");
  if (wristHtmlMesh && wristInteractiveGroup) {
    wristInteractiveGroup.remove(wristHtmlMesh);
    wristHtmlMesh.dispose();
    wristHtmlMesh = null;
  }
  if (wristMenuGroup && scene) {
    scene.remove(wristMenuGroup);
    wristMenuGroup = null;
  }
  wristMenuOffsetGroup = null;
  wristInteractiveGroup = null;
  if (adv) adv.classList.remove("sketchar-advanced--xr-source");
  teardownPalmMenuXR();
  document.body.classList.remove("xr-presenting");
}

/**
 * @param {XRFrame} frame
 * @param {XRSession} session
 */
function updateWristMenuPose(frame, session) {
  if (!wristMenuGroup) return;
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) return;

  let src = null;
  for (const inputSource of session.inputSources) {
    if (inputSource.hand && inputSource.handedness === "left") {
      src = inputSource;
      break;
    }
  }
  if (!src) {
    wristMenuGroup.visible = false;
    return;
  }
  const hand = src.hand;
  const wristSpace = hand.get("wrist");
  const middleSpace = hand.get("middle-finger-metacarpal");
  const indexSpace = hand.get("index-finger-metacarpal");
  if (!wristSpace || !middleSpace || !indexSpace) {
    wristMenuGroup.visible = false;
    return;
  }
  const wristPose = frame.getPose(wristSpace, refSpace);
  const middlePose = frame.getPose(middleSpace, refSpace);
  const indexPose = frame.getPose(indexSpace, refSpace);
  if (!wristPose || !middlePose || !indexPose) {
    wristMenuGroup.visible = false;
    return;
  }

  const wp = wristPose.transform.position;
  _wristMenuPos.set(wp.x, wp.y, wp.z);
  const mp = middlePose.transform.position;
  _wristMiddleMeta.set(mp.x, mp.y, mp.z);
  const ip = indexPose.transform.position;
  _wristIndexMeta.set(ip.x, ip.y, ip.z);

  _wristToMiddle.subVectors(_wristMiddleMeta, _wristMenuPos);
  _wristToIndex.subVectors(_wristIndexMeta, _wristMenuPos);
  /* Left hand: middle × index gives normal out of the palm (volar). index × middle puts the panel on the dorsal side — wrong. Do not flip toward camera — that made the back-of-hand case pass and look inverted. */
  _wristPalmNormal.crossVectors(_wristToMiddle, _wristToIndex);
  if (_wristPalmNormal.lengthSq() < 1e-10) {
    wristMenuGroup.visible = false;
    return;
  }
  _wristPalmNormal.normalize();

  camera.getWorldPosition(_wristToCamera);
  _wristToCamera.sub(_wristMenuPos).normalize();

  if (_wristPalmNormal.dot(_wristToCamera) < WRIST_MENU_PALM_FACE_DOT_MIN) {
    wristMenuGroup.visible = false;
    return;
  }

  _wristToMiddle.normalize();
  _wristZ.copy(_wristPalmNormal);
  _wristY.copy(_wristToMiddle);
  _wristX.crossVectors(_wristY, _wristZ).normalize();
  _wristY.crossVectors(_wristZ, _wristX).normalize();
  _wristBasis.makeBasis(_wristX, _wristY, _wristZ);
  wristMenuGroup.quaternion.setFromRotationMatrix(_wristBasis);

  _wristMenuScratchPos.copy(_wristZ).multiplyScalar(WRIST_MENU_PALM_OFFSET_M);
  _wristMenuScratchPos.addScaledVector(_wristY, WRIST_MENU_FINGER_SHIFT_M);
  _wristMenuScratchPos.addScaledVector(_wristY, -WRIST_MENU_FOREARM_SHIFT_M);
  wristMenuGroup.position.copy(_wristMenuPos).add(_wristMenuScratchPos);
  wristMenuGroup.visible = true;
}

/**
 * @param {XRFrame} frame
 * @param {XRSession} session
 * @param {XRReferenceSpace} refSpace
 * @returns {boolean}
 */
function tryRightWristHudFromHand(frame, session, refSpace) {
  /* Hide HUD while MX Ink is in the right hand; only show when that wrist is free (hand tracking only). */
  if (stylusHandedness === "right" && stylus) return false;

  let src = null;
  for (const inputSource of session.inputSources) {
    if (inputSource.hand && inputSource.handedness === "right") {
      src = inputSource;
      break;
    }
  }
  if (!src) return false;
  const hand = src.hand;
  const wristSpace = hand.get("wrist");
  const middleSpace = hand.get("middle-finger-metacarpal");
  const indexSpace = hand.get("index-finger-metacarpal");
  if (!wristSpace || !middleSpace || !indexSpace) return false;
  const wristPose = frame.getPose(wristSpace, refSpace);
  const middlePose = frame.getPose(middleSpace, refSpace);
  const indexPose = frame.getPose(indexSpace, refSpace);
  if (!wristPose || !middlePose || !indexPose) return false;

  const wp = wristPose.transform.position;
  _wristMenuPos.set(wp.x, wp.y, wp.z);
  const mp = middlePose.transform.position;
  _wristMiddleMeta.set(mp.x, mp.y, mp.z);
  const ip = indexPose.transform.position;
  _wristIndexMeta.set(ip.x, ip.y, ip.z);

  _wristToMiddle.subVectors(_wristMiddleMeta, _wristMenuPos);
  _wristToIndex.subVectors(_wristIndexMeta, _wristMenuPos);
  _wristPalmNormal.crossVectors(_wristToIndex, _wristToMiddle);
  if (_wristPalmNormal.lengthSq() < 1e-10) return false;
  _wristPalmNormal.normalize();

  camera.getWorldPosition(_wristToCamera);
  _wristToCamera.sub(_wristMenuPos).normalize();

  if (_wristPalmNormal.dot(_wristToCamera) < WRIST_MENU_PALM_FACE_DOT_MIN) return false;

  _wristToMiddle.normalize();
  _wristZ.copy(_wristPalmNormal);
  _wristY.copy(_wristToMiddle);
  _wristX.crossVectors(_wristY, _wristZ).normalize();
  _wristY.crossVectors(_wristZ, _wristX).normalize();
  _wristBasis.makeBasis(_wristX, _wristY, _wristZ);
  hudGroup.quaternion.setFromRotationMatrix(_wristBasis);

  _wristMenuScratchPos.copy(_wristZ).multiplyScalar(HUD_WRIST_PALM_OFFSET_M);
  _wristMenuScratchPos.addScaledVector(_wristY, HUD_WRIST_FINGER_SHIFT_M);
  _wristMenuScratchPos.addScaledVector(_wristY, -HUD_WRIST_FOREARM_SHIFT_M);
  hudGroup.position.copy(_wristMenuPos).add(_wristMenuScratchPos);
  return true;
}

/**
 * Right-wrist HUD: right hand tracking only, palm toward camera; hidden while MX Ink is in the right hand.
 * @param {XRFrame} frame
 * @param {XRSession} session
 */
function updateRightWristHudPose(frame, session) {
  if (!hudGroup) return;
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) {
    hudGroup.visible = false;
    return;
  }
  if (tryRightWristHudFromHand(frame, session, refSpace)) {
    hudGroup.visible = true;
    return;
  }
  hudGroup.visible = false;
}

/**
 * @param {XRFrame} frame
 * @param {XRSession} session
 */
function updatePalmMenuPose(frame, session) {
  if (!palmMenuGroup) return;
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) return;

  let src = null;
  for (const inputSource of session.inputSources) {
    if (inputSource.hand && inputSource.handedness === "left") {
      src = inputSource;
      break;
    }
  }
  if (!src) {
    palmMenuGroup.visible = false;
    return;
  }
  const hand = src.hand;
  const wristSpace = hand.get("wrist");
  const middleSpace = hand.get("middle-finger-metacarpal");
  const indexSpace = hand.get("index-finger-metacarpal");
  if (!wristSpace || !middleSpace || !indexSpace) {
    palmMenuGroup.visible = false;
    return;
  }
  const wristPose = frame.getPose(wristSpace, refSpace);
  const middlePose = frame.getPose(middleSpace, refSpace);
  const indexPose = frame.getPose(indexSpace, refSpace);
  if (!wristPose || !middlePose || !indexPose) {
    palmMenuGroup.visible = false;
    return;
  }

  const wp = wristPose.transform.position;
  _wristMenuPos.set(wp.x, wp.y, wp.z);
  const mp = middlePose.transform.position;
  _wristMiddleMeta.set(mp.x, mp.y, mp.z);
  const ip = indexPose.transform.position;
  _wristIndexMeta.set(ip.x, ip.y, ip.z);

  _wristToMiddle.subVectors(_wristMiddleMeta, _wristMenuPos);
  _wristToIndex.subVectors(_wristIndexMeta, _wristMenuPos);
  _wristPalmNormal.crossVectors(_wristToMiddle, _wristToIndex);
  if (_wristPalmNormal.lengthSq() < 1e-10) {
    palmMenuGroup.visible = false;
    return;
  }
  _wristPalmNormal.normalize();

  camera.getWorldPosition(_wristToCamera);
  _wristToCamera.sub(_wristMenuPos).normalize();

  if (_wristPalmNormal.dot(_wristToCamera) < WRIST_MENU_PALM_FACE_DOT_MIN) {
    palmMenuGroup.visible = false;
    return;
  }

  _wristToMiddle.normalize();
  _wristZ.copy(_wristPalmNormal);
  _wristY.copy(_wristToMiddle);
  _wristX.crossVectors(_wristY, _wristZ).normalize();
  _wristY.crossVectors(_wristZ, _wristX).normalize();
  _wristBasis.makeBasis(_wristX, _wristY, _wristZ);
  palmMenuGroup.quaternion.setFromRotationMatrix(_wristBasis);

  _palmAnchorPos.lerpVectors(_wristMenuPos, _wristMiddleMeta, PALM_MENU_CENTER_LERP);
  _palmScratchPos.set(0, 0, 0);
  _palmScratchPos.addScaledVector(_wristX, PALM_MENU_LATERAL_SHIFT_M);
  _palmScratchPos.addScaledVector(_wristZ, PALM_MENU_PALM_OFFSET_M);
  _palmScratchPos.addScaledVector(_wristY, PALM_MENU_FINGER_SHIFT_M);
  palmMenuGroup.position.copy(_palmAnchorPos).add(_palmScratchPos);
  palmMenuGroup.visible = true;
}

function updateWristPalmMenuStylusPointerAssist() {
  wristMenuUvValid = false;
  palmMenuUvValid = false;
  lastStylusUiMesh = null;
  lastStylusUiWristHitDist = Infinity;
  lastStylusUiPalmHitDist = Infinity;
  if (!stylus) return;

  stylus.getWorldPosition(_wristUiOrigin);
  stylus.getWorldQuaternion(_quat);
  _wristUiDir.set(0, 0, -1).applyQuaternion(_quat).normalize();
  wristUiRaycaster.set(_wristUiOrigin, _wristUiDir);
  wristUiRaycaster.far = 1.5;

  let distW = Infinity;
  let distP = Infinity;
  let wristHit = false;
  let palmHit = false;
  let wristFromRay = false;
  let palmFromRay = false;
  /** @type {import("three").Vector2 | undefined} */
  let wristUvThree;
  /** @type {import("three").Vector2 | undefined} */
  let palmUvThree;

  if (wristMenuGroup?.visible && wristHtmlMesh) {
    wristMenuGroup.updateMatrixWorld(true);
    wristHtmlMesh.updateMatrixWorld(true);
    const hw = wristUiRaycaster.intersectObject(wristHtmlMesh, false);
    if (hw.length > 0) {
      wristHit = true;
      wristFromRay = true;
      distW = hw[0].distance;
      wristUvThree = hw[0].uv;
    } else {
      const dW = getTipSignedDistanceToMeshPlane(wristHtmlMesh);
      if (
        Number.isFinite(dW) &&
        Math.abs(dW) <= STYLUS_UI_TOUCH_SLAB_M &&
        tipWorldToHtmlMeshUv(wristHtmlMesh, _wristUiOrigin, wristMenuLastUv)
      ) {
        wristHit = true;
        distW = Math.abs(dW);
      }
    }
  }
  if (palmMenuGroup?.visible && palmHtmlMesh) {
    palmMenuGroup.updateMatrixWorld(true);
    palmHtmlMesh.updateMatrixWorld(true);
    const hp = wristUiRaycaster.intersectObject(palmHtmlMesh, false);
    if (hp.length > 0) {
      palmHit = true;
      palmFromRay = true;
      distP = hp[0].distance;
      palmUvThree = hp[0].uv;
    } else {
      const dP = getTipSignedDistanceToMeshPlane(palmHtmlMesh);
      if (
        Number.isFinite(dP) &&
        Math.abs(dP) <= STYLUS_UI_TOUCH_SLAB_M &&
        tipWorldToHtmlMeshUv(palmHtmlMesh, _wristUiOrigin, palmMenuLastUv)
      ) {
        palmHit = true;
        distP = Math.abs(dP);
      }
    }
  }

  if (wristHit && distW <= distP) {
    if (wristFromRay && wristUvThree) {
      wristMenuLastUv.set(wristUvThree.x, 1 - wristUvThree.y);
    }
    wristMenuUvValid = true;
    lastStylusUiMesh = wristHtmlMesh;
    lastStylusUiWristHitDist = distW;
  } else if (palmHit) {
    if (palmFromRay && palmUvThree) {
      palmMenuLastUv.set(palmUvThree.x, 1 - palmUvThree.y);
    }
    palmMenuUvValid = true;
    lastStylusUiMesh = palmHtmlMesh;
    lastStylusUiPalmHitDist = distP;
  }
}

/**
 * Signed distance (m) from stylus tip to mesh plane (+Z local = panel front normal in world space).
 * @param {THREE.Mesh} mesh
 */
function getTipSignedDistanceToMeshPlane(mesh) {
  if (!mesh || !stylus) return Number.NaN;
  stylus.getWorldPosition(_wristUiOrigin);
  mesh.getWorldPosition(_meshPlaneCenter);
  mesh.getWorldQuaternion(_quat);
  _meshPlaneNormal.set(0, 0, 1).applyQuaternion(_quat).normalize();
  camera.getWorldPosition(_wristToCamera);
  _wristToCamera.sub(_meshPlaneCenter);
  if (_meshPlaneNormal.dot(_wristToCamera) < 0) {
    _meshPlaneNormal.negate();
  }
  _meshPlaneTipDelta.subVectors(_wristUiOrigin, _meshPlaneCenter);
  return _meshPlaneTipDelta.dot(_meshPlaneNormal);
}

/**
 * Project stylus tip onto HTMLMesh plane in local space; UV matches Three.js PlaneGeometry + same Y flip as raycast.
 * @param {THREE.Mesh} mesh
 * @param {THREE.Vector3} tipWorld
 * @param {THREE.Vector2} outDomUv output (u, 1-v_three) for {@link dispatchHtmlMeshPointerEvent}
 * @returns {boolean}
 */
function tipWorldToHtmlMeshUv(mesh, tipWorld, outDomUv) {
  const geom = mesh.geometry;
  const w = geom?.parameters?.width;
  const h = geom?.parameters?.height;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return false;
  mesh.updateMatrixWorld(true);
  _wristUiInvMatrix.copy(mesh.matrixWorld).invert();
  _tipLocalForUi.copy(tipWorld).applyMatrix4(_wristUiInvMatrix);
  const uThree = _tipLocalForUi.x / w + 0.5;
  const vThree = 0.5 - _tipLocalForUi.y / h;
  if (uThree < -1e-3 || uThree > 1 + 1e-3 || vThree < -1e-3 || vThree > 1 + 1e-3) return false;
  outDomUv.set(uThree, 1 - vThree);
  return true;
}

/**
 * @param {THREE.Mesh} mesh
 * @param {THREE.Vector2} uv
 * @param {string} syntheticType
 */
function dispatchHtmlMeshPointerEvent(mesh, uv, syntheticType) {
  if (!mesh || !uv) return;
  _wristUiPointerData.copy(uv);
  _wristUiSyntheticEvent.type = syntheticType;
  mesh.dispatchEvent(_wristUiSyntheticEvent);
}

/**
 * Wrist / palm HTMLMesh: MX Ink tip enters touch slab near the panel → one click (rising edge), not plane penetration.
 */
function processStylusUiPlanePenetration() {
  if (!stylus) return;
  if (isDrawing || currentStrokePainter) return;

  let dW = Number.NaN;
  let dP = Number.NaN;
  if (wristMenuGroup?.visible && wristHtmlMesh) {
    wristHtmlMesh.updateMatrixWorld(true);
    dW = getTipSignedDistanceToMeshPlane(wristHtmlMesh);
  }
  if (palmMenuGroup?.visible && palmHtmlMesh) {
    palmHtmlMesh.updateMatrixWorld(true);
    dP = getTipSignedDistanceToMeshPlane(palmHtmlMesh);
  }

  const wristInSlab =
    wristMenuGroup?.visible &&
    wristHtmlMesh &&
    Number.isFinite(dW) &&
    Math.abs(dW) <= STYLUS_UI_TOUCH_SLAB_M;
  const palmInSlab =
    palmMenuGroup?.visible &&
    palmHtmlMesh &&
    Number.isFinite(dP) &&
    Math.abs(dP) <= STYLUS_UI_TOUCH_SLAB_M;

  const wristSlabEdge = wristInSlab && !wristUiTouchSlabPrev;
  const palmSlabEdge = palmInSlab && !palmUiTouchSlabPrev;

  const wristEligible =
    (wristMenuUvValid && lastStylusUiMesh === wristHtmlMesh) || persistWristUvValid;
  const palmEligible =
    (palmMenuUvValid && lastStylusUiMesh === palmHtmlMesh) || persistPalmUvValid;

  const pickWristUv = () => {
    if (wristMenuUvValid && lastStylusUiMesh === wristHtmlMesh) {
      return wristMenuLastUv;
    }
    if (persistWristUvValid) return _persistWristUv;
    return null;
  };
  const pickPalmUv = () => {
    if (palmMenuUvValid && lastStylusUiMesh === palmHtmlMesh) {
      return palmMenuLastUv;
    }
    if (persistPalmUvValid) return _persistPalmUv;
    return null;
  };

  let didWrist = false;
  if (wristSlabEdge && wristEligible) {
    const uv = pickWristUv();
    const palmAlso = palmSlabEdge && palmEligible;
    const palmCloser =
      palmAlso &&
      Number.isFinite(lastStylusUiWristHitDist) &&
      Number.isFinite(lastStylusUiPalmHitDist) &&
      lastStylusUiPalmHitDist < lastStylusUiWristHitDist;
    const wristWins = uv && !palmCloser;
    if (wristWins) {
      dispatchHtmlMeshPointerEvent(wristHtmlMesh, uv, "mousedown");
      dispatchHtmlMeshPointerEvent(wristHtmlMesh, uv, "mouseup");
      dispatchHtmlMeshPointerEvent(wristHtmlMesh, uv, "click");
      didWrist = true;
      forceWristHtmlTextureUpdate();
    }
  }

  if (!didWrist && palmSlabEdge && palmEligible) {
    const uv = pickPalmUv();
    if (uv) {
      palmWheelDragActive = true;
      _palmWheelLastDragUv.set(-1, -1);
      applyPalmWheelFromUv(uv.x, uv.y);
      _palmWheelLastDragUv.copy(uv);
      forcePalmHtmlTextureUpdate();
    }
  }

  if (palmWheelDragActive && (!palmMenuUvValid || lastStylusUiMesh !== palmHtmlMesh)) {
    palmWheelDragActive = false;
    _palmWheelLastDragUv.set(-1, -1);
    forcePalmHtmlTextureUpdate();
  }

  wristUiTouchSlabPrev = wristInSlab;
  palmUiTouchSlabPrev = palmInSlab;

  if (wristMenuUvValid && lastStylusUiMesh === wristHtmlMesh) {
    _persistWristUv.copy(wristMenuLastUv);
    persistWristUvValid = true;
  } else if (!wristMenuGroup?.visible) {
    persistWristUvValid = false;
  }

  if (palmMenuUvValid && lastStylusUiMesh === palmHtmlMesh) {
    _persistPalmUv.copy(palmMenuLastUv);
    persistPalmUvValid = true;
  } else if (!palmMenuGroup?.visible) {
    persistPalmUvValid = false;
  }
}

/** @type {"immersive-ar"|"immersive-vr"|null} */
let cachedImmersiveSessionMode = null;

async function resolveImmersiveSessionMode() {
  if (cachedImmersiveSessionMode) return cachedImmersiveSessionMode;
  if (!navigator.xr) return null;
  try {
    if (await navigator.xr.isSessionSupported("immersive-ar")) {
      cachedImmersiveSessionMode = "immersive-ar";
      return "immersive-ar";
    }
  } catch (_) {}
  try {
    if (await navigator.xr.isSessionSupported("immersive-vr")) {
      cachedImmersiveSessionMode = "immersive-vr";
      return "immersive-vr";
    }
  } catch (_) {}
  return null;
}

async function startImmersiveSession() {
  if (!renderer?.xr) return;
  if (renderer.xr.isPresenting) return;
  const mode = await resolveImmersiveSessionMode();
  if (!mode) {
    alert("Immersive AR/VR is not available in this browser.");
    return;
  }
  try {
    const session = await navigator.xr.requestSession(mode, {
      optionalFeatures: [
        "local-floor",
        "bounded-floor",
        "layers",
        "unbounded",
        "hand-tracking",
        "depth-sensing",
      ],
    });
    await renderer.xr.setSession(session);
  } catch (e) {
    console.warn("XR session failed", e);
    alert("Could not enter immersive mode. Check headset or permissions.");
  }
}

function syncPalmPaletteSelectedUi() {
  const palmRoot = document.getElementById("palm-color-menu");
  const wheel = document.getElementById("palm-color-wheel");
  const hueCur = document.getElementById("palm-hue-cursor");
  const svCur = document.getElementById("palm-sv-cursor");
  if (!palmRoot || !wheel || !hueCur || !svCur) return;
  drawPalmColorWheelCanvas();
  const rgb = hexToRgb(activeStrokeColorHex);
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  const wr = wheel.getBoundingClientRect();
  const R = Math.min(wr.width, wr.height) / 2;
  const rMid = R * PALM_WHEEL_HUE_CURSOR_NORM;
  const hr = (hsv.h * Math.PI) / 180;
  const hox = Math.sin(hr) * rMid;
  const hoy = -Math.cos(hr) * rMid;
  hueCur.style.left = "50%";
  hueCur.style.top = "50%";
  hueCur.style.margin = "0";
  hueCur.style.transform = `translate(calc(-50% + ${hox}px), calc(-50% + ${hoy}px))`;
  const nx = 2 * hsv.s - 1;
  const ny = 1 - 2 * hsv.v;
  const rsv = R * PALM_WHEEL_SV_RADIUS_NORM;
  const svx = nx * rsv;
  const svy = ny * rsv;
  svCur.style.left = "50%";
  svCur.style.top = "50%";
  svCur.style.margin = "0";
  svCur.style.transform = `translate(calc(-50% + ${svx}px), calc(-50% + ${svy}px))`;
  const label = `#${(activeStrokeColorHex >>> 0).toString(16).padStart(6, "0")}`;
  wheel.setAttribute("aria-valuetext", label);
  palmRoot.setAttribute("data-fresh", String(Date.now()));
}

function initSketcharUI() {
  const elCreate = document.getElementById("sketchar-create");
  const elJoin = document.getElementById("sketchar-join");
  const elCreatePreview = document.getElementById("sketchar-create-preview");
  const elJoinPreview = document.getElementById("sketchar-join-preview");
  const elSlug = document.getElementById("sketchar-slug");
  const elBroadcast = document.getElementById("sketchar-broadcast");
  const elCopy = document.getElementById("sketchar-copy");
  const elViewerLink = document.getElementById("sketchar-viewer-link");
  const elPinQuest = document.getElementById("sketchar-pin-quest");
  const statusEl = document.getElementById("sketchar-status");
  const recentList = document.getElementById("sketchar-recent-list");

  const palmWheel = document.getElementById("palm-color-wheel");
  if (palmWheel) {
    let domDrag = false;
    const applyFromClient = (clientX, clientY) => {
      const palmRoot = document.getElementById("palm-color-menu");
      if (!palmRoot) return;
      const pr = palmRoot.getBoundingClientRect();
      const u = (clientX - pr.left) / Math.max(pr.width, 1e-6);
      const v = (clientY - pr.top) / Math.max(pr.height, 1e-6);
      applyPalmWheelFromUv(u, v);
    };
    palmWheel.addEventListener("pointerdown", (e) => {
      domDrag = true;
      palmWheel.setPointerCapture(e.pointerId);
      applyFromClient(e.clientX, e.clientY);
    });
    palmWheel.addEventListener("pointermove", (e) => {
      if (!domDrag) return;
      applyFromClient(e.clientX, e.clientY);
    });
    palmWheel.addEventListener("pointerup", (e) => {
      domDrag = false;
      try {
        palmWheel.releasePointerCapture(e.pointerId);
      } catch (_) {}
      forcePalmHtmlTextureUpdate();
    });
    palmWheel.addEventListener("pointercancel", () => {
      domDrag = false;
    });
    syncPalmPaletteSelectedUi();
  }

  if (!elSlug) return;

  /* Quest / touch: focus the field so the OS keyboard can open; stop bubbling to WebGL layer.
     Note: in immersive WebXR the page is not focusable — enter the room code in the browser before Enter VR. */
  elSlug.addEventListener(
    "touchstart",
    () => {
      if (document.activeElement !== elSlug) elSlug.focus();
    },
    { passive: true },
  );

  if (elBroadcast) {
    sketcharBroadcast = elBroadcast.checked;
    elBroadcast.addEventListener("change", () => {
      sketcharBroadcast = elBroadcast.checked;
      if (sketcharBroadcast) {
        scheduleSketcharPush();
      }
      forceWristHtmlTextureUpdate();
    });
  }
  const elShowOthers = document.getElementById("sketchar-show-others");
  if (elShowOthers) {
    elShowOthers.checked = sketcharShowOthers;
    elShowOthers.addEventListener("change", () => {
      sketcharShowOthers = elShowOthers.checked;
      setShowOthersPreference(sketcharShowOthers);
      remotePresenceGroup.visible = sketcharShowOthers;
      forceWristHtmlTextureUpdate();
    });
  }
  const elOriginFloor = document.getElementById("sketchar-origin-floor");
  if (elOriginFloor) {
    try {
      const raw = localStorage.getItem(ORIGIN_FLOOR_STORAGE_KEY);
      if (raw === "0") {
        elOriginFloor.checked = false;
        showOriginFloor = false;
      } else if (raw === "1") {
        elOriginFloor.checked = true;
        showOriginFloor = true;
      }
    } catch (_) {
      /* ignore */
    }
    elOriginFloor.addEventListener("change", () => {
      showOriginFloor = elOriginFloor.checked;
      try {
        localStorage.setItem(ORIGIN_FLOOR_STORAGE_KEY, showOriginFloor ? "1" : "0");
      } catch (_) {
        /* ignore */
      }
      forceWristHtmlTextureUpdate();
    });
  }
  const elPickDebug = document.getElementById("sketchar-pick-debug");
  if (elPickDebug) {
    try {
      const raw = localStorage.getItem(PICK_STROKE_DEBUG_STORAGE_KEY);
      if (raw === "1") {
        elPickDebug.checked = true;
        showPickStrokeDebug = true;
      } else if (raw === "0") {
        elPickDebug.checked = false;
        showPickStrokeDebug = false;
      }
    } catch (_) {
      /* ignore */
    }
    elPickDebug.addEventListener("change", () => {
      showPickStrokeDebug = elPickDebug.checked;
      try {
        localStorage.setItem(PICK_STROKE_DEBUG_STORAGE_KEY, showPickStrokeDebug ? "1" : "0");
      } catch (_) {
        /* ignore */
      }
      forceWristHtmlTextureUpdate();
    });
  }
  async function applyJoinSuccess(data, canonical) {
    stopSketcharSubscription();
    sketcharRoomId = data.roomId;
    sketcharRoomSlug = canonical;
    elSlug.value = canonical;
    currentStrokePainter = null;
    currentStrokePointsLocal.length = 0;
    currentStrokeWidthsLocal.length = 0;
    lastThreeCompletedStrokes.length = 0;
    clearStrokeUndoStacks();
    if (data.snapshot && data.snapshot.v === 1 && Array.isArray(data.snapshot.nodes)) {
      deserializeSceneV1(data.snapshot, voxelMaterial, strokesGroup);
    } else {
      deserializeSceneV1({ v: 1, nodes: [] }, voxelMaterial, strokesGroup);
    }
    sketcharPendingSyncIds.clear();
    sketcharDeletedSyncIds.clear();
    lastSketcharRemoteSeen =
      data.snapshotUpdatedAt != null ? String(data.snapshotUpdatedAt) : null;
    updateSketcharViewerLink(elViewerLink);
    startSketcharSubscription();
    if (statusEl) {
      statusEl.textContent = data.snapshot
        ? "Sketchar: room loaded from cloud"
        : "Sketchar: room empty — draw to sync";
      statusEl.dataset.state = "ok";
    }
    forceWristHtmlTextureUpdate();
    rememberRoom(canonical);
    renderSketcharRecentRooms();
    invalidateHudClock();
    await startImmersiveSession();
  }

  function renderSketcharRecentRooms() {
    if (!recentList) return;
    recentList.replaceChildren();
    const items = loadRoomHistory();
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "sketchar-recent-empty";
      li.textContent = "No recent rooms yet";
      recentList.appendChild(li);
      return;
    }
    for (const { code } of items) {
      const li = document.createElement("li");
      li.className = "sketchar-recent-row";
      const codeEl = document.createElement("span");
      codeEl.className = "sketchar-recent-code";
      codeEl.textContent = code;
      const actions = document.createElement("div");
      actions.className = "sketchar-recent-actions";
      const btnXr = document.createElement("button");
      btnXr.type = "button";
      btnXr.className = "sketchar-recent-btn sketchar-recent-btn--xr";
      btnXr.textContent = "XR";
      btnXr.title = `Join room ${code} in XR`;
      btnXr.setAttribute("aria-label", `Join room ${code} in XR`);
      btnXr.addEventListener("click", () => {
        elSlug.value = code;
        void joinRoomAndEnterXr();
      });
      const btnPreview = document.createElement("button");
      btnPreview.type = "button";
      btnPreview.className = "sketchar-recent-btn sketchar-recent-btn--preview";
      btnPreview.textContent = "Preview";
      btnPreview.title = `Open preview for room ${code}`;
      btnPreview.setAttribute("aria-label", `Open room ${code} in preview viewer`);
      btnPreview.addEventListener("click", () => {
        elSlug.value = code;
        void joinRoomPreviewWithCode(code);
      });
      actions.appendChild(btnXr);
      actions.appendChild(btnPreview);
      li.appendChild(codeEl);
      li.appendChild(actions);
      recentList.appendChild(li);
    }
  }

  async function joinRoomAndEnterXr() {
    const normalized = normalizeRoomCode(elSlug.value || "");
    if (!normalized) {
      alert("Enter a room code.");
      return;
    }
    if (!isSketcharConfigured()) {
      alert(
        "Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local (see Supabase dashboard).",
      );
      return;
    }
    const sb = getSketcharSupabase();
    if (!sb) return;
    try {
      const data = await fetchRoomBySlug(sb, normalized);
      if (!data) {
        if (statusEl) {
          statusEl.textContent = "Sketchar: room not found";
          statusEl.dataset.state = "err";
          forceWristHtmlTextureUpdate();
        } else {
          alert("Room not found.");
        }
        return;
      }
      const canonical = normalizeRoomCode(data.slug);
      await applyJoinSuccess(data, canonical);
    } catch (e) {
      console.warn("Sketchar join room failed", e);
      if (statusEl) {
        statusEl.textContent = "Sketchar: could not load room";
        statusEl.dataset.state = "err";
        forceWristHtmlTextureUpdate();
      } else {
        alert("Could not load room. Check Supabase env.");
      }
    }
  }

  async function createNewSketchAndEnterXr() {
    if (!isSketcharConfigured()) {
      alert(
        "Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local (see Supabase dashboard).",
      );
      return;
    }
    const sb = getSketcharSupabase();
    if (!sb) return;
    try {
      const { id, slug } = await createRoom(sb);
      stopSketcharSubscription();
      sketcharRoomId = id;
      sketcharRoomSlug = normalizeRoomCode(slug);
      elSlug.value = sketcharRoomSlug;
      lastSketcharRemoteSeen = null;
      sketcharPendingSyncIds.clear();
      sketcharDeletedSyncIds.clear();
      currentStrokePainter = null;
      currentStrokePointsLocal.length = 0;
      currentStrokeWidthsLocal.length = 0;
      lastThreeCompletedStrokes.length = 0;
      clearStrokeUndoStacks();
      deserializeSceneV1({ v: 1, nodes: [] }, voxelMaterial, strokesGroup);
      updateSketcharViewerLink(elViewerLink);
      startSketcharSubscription();
      if (statusEl) {
        statusEl.textContent = "Sketchar: new room — draw to sync";
        statusEl.dataset.state = "ok";
      }
      forceWristHtmlTextureUpdate();
      rememberRoom(sketcharRoomSlug);
      renderSketcharRecentRooms();
      invalidateHudClock();
      await startImmersiveSession();
    } catch (e) {
      console.warn("Sketchar create room failed", e);
      alert("Could not create room. Check Supabase env and project.");
    }
  }

  async function joinRoomPreview() {
    const normalized = normalizeRoomCode(elSlug.value || "");
    if (!normalized) {
      alert("Enter a room code.");
      return;
    }
    if (!isSketcharConfigured()) {
      alert(
        "Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local (see Supabase dashboard).",
      );
      return;
    }
    const sb = getSketcharSupabase();
    if (!sb) return;
    try {
      const data = await fetchRoomBySlug(sb, normalized);
      if (!data) {
        if (statusEl) {
          statusEl.textContent = "Sketchar: room not found";
          statusEl.dataset.state = "err";
          forceWristHtmlTextureUpdate();
        } else {
          alert("Room not found.");
        }
        return;
      }
      const canonical = normalizeRoomCode(data.slug);
      elSlug.value = canonical;
      rememberRoom(canonical);
      renderSketcharRecentRooms();
      location.assign(viewerUrlForRoomSlug(canonical));
    } catch (e) {
      console.warn("Sketchar join preview failed", e);
      if (statusEl) {
        statusEl.textContent = "Sketchar: could not load room";
        statusEl.dataset.state = "err";
        forceWristHtmlTextureUpdate();
      } else {
        alert("Could not load room. Check Supabase env.");
      }
    }
  }

  async function joinRoomPreviewWithCode(code) {
    elSlug.value = code;
    await joinRoomPreview();
  }

  async function createNewSketchPreview() {
    if (!isSketcharConfigured()) {
      alert(
        "Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local (see Supabase dashboard).",
      );
      return;
    }
    const sb = getSketcharSupabase();
    if (!sb) return;
    try {
      const { slug } = await createRoom(sb);
      const canonical = normalizeRoomCode(slug);
      rememberRoom(canonical);
      renderSketcharRecentRooms();
      location.assign(viewerUrlForRoomSlug(canonical));
    } catch (e) {
      console.warn("Sketchar create room failed", e);
      alert("Could not create room. Check Supabase env and project.");
    }
  }

  if (elCreate) {
    elCreate.addEventListener("click", () => {
      void createNewSketchAndEnterXr();
    });
  }
  if (elJoin) {
    elJoin.addEventListener("click", () => {
      void joinRoomAndEnterXr();
    });
  }
  if (elCreatePreview) {
    elCreatePreview.addEventListener("click", () => {
      void createNewSketchPreview();
    });
  }
  if (elJoinPreview) {
    elJoinPreview.addEventListener("click", () => {
      void joinRoomPreview();
    });
  }
  renderSketcharRecentRooms();
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
      if (!sketcharRoomSlug || !sketcharRoomId) return;
      const sb = getSketcharSupabase();
      if (!sb) return;
      const p = new THREE.Vector3();
      if (stylus && stylus.position) p.copy(stylus.position);
      else camera.getWorldPosition(p);
      try {
        await upsertPin(sb, sketcharRoomId, "quest", [p.x, p.y, p.z]);
      } catch (e) {
        console.warn("Sketchar pin failed", e);
      }
    });
  }
  const elUndo = document.getElementById("sketchar-undo");
  const elRedo = document.getElementById("sketchar-redo");
  if (elUndo) {
    elUndo.addEventListener("click", () => {
      undoLastStroke();
    });
  }
  if (elRedo) {
    elRedo.addEventListener("click", () => {
      redoLastStroke();
    });
  }
  const elExportGlb = document.getElementById("sketchar-export-glb");
  if (elExportGlb) {
    const syncExportGlbDisabled = () => {
      const raw = import.meta.env.VITE_EXPORT_GLB_URL;
      const url = typeof raw === "string" ? raw.trim() : "";
      elExportGlb.disabled = !url;
    };
    syncExportGlbDisabled();
    elExportGlb.addEventListener("click", async () => {
      const rawUrl = import.meta.env.VITE_EXPORT_GLB_URL;
      const rawTok = import.meta.env.VITE_EXPORT_GLB_TOKEN;
      const exportUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
      const exportTok = typeof rawTok === "string" ? rawTok.trim() : "";
      if (!exportUrl) {
        if (statusEl) {
          statusEl.textContent =
            "GLB export: set VITE_EXPORT_GLB_URL in project-root .env.local";
          statusEl.dataset.state = "err";
          forceWristHtmlTextureUpdate();
        }
        return;
      }
      elExportGlb.disabled = true;
      elExportGlb.dataset.state = "uploading";
      if (statusEl) {
        statusEl.textContent = "GLB export: encoding…";
        statusEl.removeAttribute("data-state");
        forceWristHtmlTextureUpdate();
      }
      try {
        const buffer = await exportSketchToGlbArrayBuffer(sceneContentRoot, strokesGroup);
        if (statusEl) {
          statusEl.textContent = "GLB export: uploading…";
          forceWristHtmlTextureUpdate();
        }
        const result = await uploadGlbArrayBuffer(buffer, {
          url: exportUrl,
          token: exportTok,
          roomSlug: sketcharRoomSlug || "",
        });
        const key = result && typeof result.key === "string" ? result.key : "";
        const pubUrl = result && typeof result.url === "string" ? result.url : "";
        if (statusEl) {
          statusEl.textContent = pubUrl
            ? `GLB export: saved — ${pubUrl}`
            : key
              ? `GLB export: saved (${key})`
              : "GLB export: saved";
          statusEl.dataset.state = "ok";
          forceWristHtmlTextureUpdate();
        }
      } catch (e) {
        console.warn("GLB export failed", e);
        if (statusEl) {
          const msg = e && typeof e.message === "string" ? e.message : String(e);
          statusEl.textContent = "GLB export failed: " + msg;
          statusEl.dataset.state = "err";
          forceWristHtmlTextureUpdate();
        }
      } finally {
        delete elExportGlb.dataset.state;
        syncExportGlbDisabled();
        forceWristHtmlTextureUpdate();
      }
    });
  }
  updateStrokeUndoRedoButtons();
  updateSketcharViewerLink(elViewerLink);
  initSketcharMenuChrome();
  initSketcharLobbyIcons();
  initSketcharAdvancedIcons();
}

function viewerUrlForRoomSlug(slug) {
  const u = new URL("viewer.html", window.location.href);
  u.searchParams.set("room", slug);
  return u.href;
}

function updateSketcharViewerLink(elViewerLink) {
  if (!elViewerLink) return;
  if (!sketcharRoomSlug) {
    elViewerLink.textContent = "—";
    forceWristHtmlTextureUpdate();
    return;
  }
  elViewerLink.textContent = viewerUrlForRoomSlug(sketcharRoomSlug);
  forceWristHtmlTextureUpdate();
}

let currentStrokePainter = null;
/** Polyline in mesh-local space; copied to mesh.userData.points when stroke ends (for partial erase). */
let currentStrokePointsLocal = [];
/** Parallel to currentStrokePointsLocal: width for segment ending at vertex i (i>=1); index 0 mirrors stroke start. */
let currentStrokeWidthsLocal = [];

/** Last three completed stroke meshes (FIFO) for box sketch → block mode. */
/** @type {THREE.Mesh[]} */
const lastThreeCompletedStrokes = [];

const cursor = new THREE.Vector3();
/** Scratch for snapped stroke points (never mutate controller positions). */
const _snapScratch = new THREE.Vector3();
const _snapNext = new THREE.Vector3();
const _manhSeg = new THREE.Vector3();
/** Manhattan / draft jitter lock in `sceneContentRoot` local space (grid axes). */
const _manhLocalA = new THREE.Vector3();
const _manhLocalB = new THREE.Vector3();
const _draftSnapLocalLast = new THREE.Vector3();
const _draftSnapLocalNext = new THREE.Vector3();
/** TubePainter geometry is mesh-local; stylus positions are world — convert before moveTo/lineTo. */
const _strokeMeshLocal = new THREE.Vector3();
/** Last accepted freehand sample (world) for min-distance decimation. */
const _lastStrokeSampleWorld = new THREE.Vector3();
/** Start of current freeform subdivide chord (scratch; lerp toward `cursor`). */
const _strokeFreeformFromWorld = new THREE.Vector3();
/** Interpolated tip position along chord (scratch). */
const _strokeInterpWorld = new THREE.Vector3();
/** Skip samples closer than this (world meters, squared) to shrink snapshots / rebuild cost. */
const STROKE_MIN_SAMPLE_DIST_SQ = 0.00035 * 0.00035;
const STROKE_MAX_POINTS = 100000;
/** Freeform: max edge length (m) between polyline points — subdivide long motion so tubes stay smooth. */
const STROKE_FREEFORM_MAX_SEGMENT_M = 0.0015;

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
/** Left hand: thumb–ring duplicate while stylus rear-grab (edge-detect). */
const thumbRingDupPinchPrev = new Map();
/** Left hand: thumb–pinky delete while stylus rear-grab (edge-detect). */
const thumbPinkyDelPinchPrev = new Map();

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
/** One-hand multi-grab: all stroke roots; `grabbedMesh` is always `grabbedGrabRoots[0]` when non-empty. */
const grabbedGrabRoots = [];
/** Per-root world offset from ref (index / stylus) for one-hand drag. */
const grabbedOneHandEntries = [];
const grabOffsetWorld = new THREE.Vector3();
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
/** World AABB for GLB grab roots (Groups have no mesh.geometry). */
const _gltfGrabBounds = new THREE.Box3();
const _penForward = new THREE.Vector3();
const _snapDeltaWorld = new THREE.Vector3();
const _snapTargetCenter = new THREE.Vector3();
/** World-space stroke center before lattice snap (translate-only path). */
const _snapPreWorld = new THREE.Vector3();
const _qWorldGrab = new THREE.Quaternion();
const _qSnapRot = new THREE.Quaternion();
const _eulerGrabSnap = new THREE.Euler();
const _snapParentQuat = new THREE.Quaternion();

const PINCH_CLOSE_DIST = 0.015;
const PINCH_OPEN_DIST = 0.025;
const SCENE_MANIP_SCALE_MIN = 0.05;
const SCENE_MANIP_SCALE_MAX = 5;
/** EMA blend toward raw thumb–middle anchors per frame (reduces hand-tracking noise during world yaw). */
const SCENE_TWO_HAND_HAND_SMOOTH = 0.38;
/** EMA blend toward raw pinch scale ratio — inter-hand distance wiggles when rotating, not only when scaling. */
const SCENE_TWO_HAND_SCALE_SMOOTH = 0.32;

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
const ORIGIN_FLOOR_STORAGE_KEY = "mxink-origin-floor";
const PICK_STROKE_DEBUG_STORAGE_KEY = "mxink-pick-stroke-debug";
/** XR origin floor `GridHelper` — keep in sync with viewer sketch-origin grid. */
const ORIGIN_FLOOR_GRID_SIZE = 12;
const ORIGIN_FLOOR_GRID_DIVISIONS = 80;
const ORIGIN_FLOOR_GRID_COLOR1 = 0x4a5568;
const ORIGIN_FLOOR_GRID_COLOR2 = 0x2d3748;

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
const GRID_DOT_RADIUS = 0.0014;
/** Visual-only: place dots every Nth lattice step along each axis (snap math unchanged). */
const GRID_DOT_VERTEX_STRIDE = 1;
/**
 * Stroke grab / erase picker (meters). Same for MX Ink and hands — change both at once:
 * `PICK_PROXIMITY_MAX_DIST` (no ray hit: strokes within this distance) and
 * `PICK_RAY_MAX_DIST` (ray from index tip / pen −Z; keep equal to proximity for one tuning knob).
 */
const PICK_PROXIMITY_MAX_DIST = 0.013;
/** Max ray length for stroke pick (finger/stylus); matches proximity fallback so one tuning knob. */
const PICK_RAY_MAX_DIST = PICK_PROXIMITY_MAX_DIST;
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
/** Upper bound for pressure mapping; slider-adjustable (min stays STROKE_WIDTH_MIN). */
let userStrokeWidthMax = STROKE_WIDTH_MAX;
const STROKE_WIDTH_MAX_STORAGE_KEY = "mxink-stroke-width-max";

/** LIFO completed stroke roots for wrist undo (meshes still in `strokesGroup`). */
const strokeUndoStack = [];
/** Detached roots after undo, for redo. */
const strokeRedoStack = [];
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
/** @type {THREE.Sprite | null} */
let leftRingFingerSprite = null;
/** @type {THREE.Sprite | null} */
let leftPinkyFingerSprite = null;
/** Avoid redundant finger-sprite texture rebuilds. */
let lastLeftStylusGrabFingerMode = null;

const sizes = {
  width: window.innerWidth,
  height: window.innerHeight,
};

/** HUD in world space; eased toward camera-local offset (not rigid head-child). */
let hudGroup = null;
/** @type {THREE.Mesh | null} */
let hudTimePlane = null;
let hudLastClockSec = -1;
let hudLastRoomDisplay = "";
let hudLastContentScale = -1;
/** Camera-local anchor: +Y up, −Z forward (m). */
const HUD_LOCAL_OFFSET = new THREE.Vector3(0, 0.12, -2);
/** World size vs previous design (0.38 m tall): 70% smaller → 30% scale. */
const HUD_WORLD_SCALE = 0.3;
/** Figma 10:9 frame 256×347 design units; 3× raster for sharpness; extra vertical room for spacing. */
const HUD_CANVAS_W = 768;
const HUD_CANVAS_H = 1240;
/** Narrow edge world width (m) for vertical wrist HUD strip. */
const HUD_WRIST_PLANE_WIDTH_M = 0.09;
/** Wrist HUD: closer to skin than settings panel; shifted toward forearm/elbow. */
const HUD_WRIST_PALM_OFFSET_M = 0.03;
const HUD_WRIST_FINGER_SHIFT_M = 0.019;
const HUD_WRIST_FOREARM_SHIFT_M = 0.132;
/** Staggered pill entrance timing (ms). */
const HUD_PILL_STAGGER_DELAY_MS = 150;
const HUD_PILL_ENTER_DURATION_MS = 520;
/** Keep redrawing while entrance animation runs (ms). */
const HUD_APPEAR_TOTAL_MS = 1850;
/** Exponential follow ~stiffness (higher = snappier). */
const HUD_FOLLOW_LAMBDA = 6.5;
const _hudTargetWorld = new THREE.Vector3();
const _hudTargetQuat = new THREE.Quaternion();
let hudFollowLastMs = null;
/** Preload Sketchar wordmark for wrist HUD (`/sketchar-logo.svg`). */
let hudLogoImage = null;
const SKETCHAR_LOGO_URL = "/sketchar-logo.svg?v=1";
/** @type {number | null} */
let hudAppearStartMs = null;
let hudAppearPrevVisible = false;

function ensureHudLogoImage() {
  if (hudLogoImage) return;
  const img = new Image();
  img.onload = () => {
    invalidateHudClock();
  };
  img.onerror = () => {
    hudLogoImage = null;
  };
  img.src = SKETCHAR_LOGO_URL;
  hudLogoImage = img;
}

/**
 * @param {number} nowMs
 */
function tickHudAppearState(nowMs) {
  if (!hudGroup) return;
  if (!hudGroup.visible) {
    hudAppearPrevVisible = false;
    return;
  }
  if (!hudAppearPrevVisible) {
    hudAppearStartMs = nowMs;
  }
  hudAppearPrevVisible = true;
}

/** @param {number} t */
function hudSmoothStep01(t) {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

/**
 * @param {number} elapsedMs
 * @param {number} index
 */
function hudPillEnterPhase(elapsedMs, index) {
  const delay = index * HUD_PILL_STAGGER_DELAY_MS;
  const dur = HUD_PILL_ENTER_DURATION_MS;
  return hudSmoothStep01((elapsedMs - delay) / dur);
}

function initOriginGizmoAndFloor() {
  originGizmoGroup = new THREE.Group();
  originGizmoGroup.name = "origin-gizmo";
  const axes = new THREE.AxesHelper(0.16);
  axes.renderOrder = 10;
  originGizmoGroup.add(axes);
  const originDot = new THREE.Mesh(
    new THREE.SphereGeometry(0.007, 10, 10),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: true,
      toneMapped: false,
    }),
  );
  originGizmoGroup.add(originDot);

  originFloorGrid = new THREE.GridHelper(
    ORIGIN_FLOOR_GRID_SIZE,
    ORIGIN_FLOOR_GRID_DIVISIONS,
    ORIGIN_FLOOR_GRID_COLOR1,
    ORIGIN_FLOOR_GRID_COLOR2,
  );
  originFloorGrid.name = "origin-floor-grid";
  originFloorGrid.renderOrder = -5;
  originFloorGrid.visible = showOriginFloor;
  originGizmoGroup.add(originFloorGrid);
  originGizmoGroup.traverse((o) => {
    if (o.isLineSegments) o.raycast = () => {};
  });

  sceneContentRoot.add(originGizmoGroup);
}

function syncOriginGizmoVisibility() {
  if (!originGizmoGroup || !renderer) return;
  originGizmoGroup.visible = renderer.xr.isPresenting;
  if (originFloorGrid) originFloorGrid.visible = showOriginFloor;
}

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
    } else if (tag === "rect" && attrs) {
      const x = Number(attrs.x);
      const y = Number(attrs.y);
      const w = Number(attrs.width);
      const h = Number(attrs.height);
      const rx = attrs.rx != null ? Number(attrs.rx) : 0;
      ctx.beginPath();
      if (rx > 0 && typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, rx);
      } else {
        ctx.rect(x, y, w, h);
      }
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
  canvas.width = HUD_CANVAS_W;
  canvas.height = HUD_CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const tex = new THREE.CanvasTexture(canvas);
  if ("colorSpace" in tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const planeW = HUD_WRIST_PLANE_WIDTH_M * HUD_WORLD_SCALE / 0.3;
  const planeH = planeW * (canvas.height / canvas.width);
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
  const group = new THREE.Group();
  group.name = "hud-time";
  group.frustumCulled = false;
  group.add(mesh);
  ensureHudLogoImage();
  return { group, mesh };
}

/**
 * XR: right-wrist pose. Non-XR: ease HUD toward camera-local offset.
 * @param {number} timeMs
 * @param {XRFrame | undefined} frame
 */
function updateHudFollow(timeMs, frame) {
  if (!hudGroup) return;

  if (renderer?.xr?.isPresenting) {
    if (frame) {
      const session = renderer.xr.getSession();
      if (session) {
        updateRightWristHudPose(frame, session);
        return;
      }
    }
    hudGroup.visible = false;
    return;
  }

  hudGroup.visible = true;
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

function invalidateHudClock() {
  hudLastClockSec = -1;
  hudLastRoomDisplay = "";
  hudLastContentScale = -1;
  updateHudClock();
}

function updateHudClock() {
  if (!hudTimePlane) return;
  const { hudCanvas: canvas, hudCtx: ctx, hudTex: tex } = hudTimePlane.userData;
  if (!canvas || !ctx || !tex) return;
  const t = Math.floor(Date.now() / 1000);
  const roomDisp = sketcharRoomSlug || "";
  const contentScale = sceneContentRoot.scale.x;
  /** Match `toFixed(2)` in the HUD — tiny float drift during two-hand world manip was forcing a full canvas redraw every frame. */
  const contentScaleKey = Number(contentScale.toFixed(2));
  const now = performance.now();
  const elapsed =
    hudAppearStartMs != null && hudGroup?.visible ? now - hudAppearStartMs : HUD_APPEAR_TOTAL_MS + 1;
  const animating = elapsed < HUD_APPEAR_TOTAL_MS;
  const logoImg = hudLogoImage;
  const logoPending = !!(logoImg && !logoImg.complete);
  if (
    !animating &&
    !logoPending &&
    t === hudLastClockSec &&
    roomDisp === hudLastRoomDisplay &&
    contentScaleKey === hudLastContentScale
  ) {
    return;
  }
  hudLastClockSec = t;
  hudLastRoomDisplay = roomDisp;
  hudLastContentScale = contentScaleKey;
  const timeStr = new Date().toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const pillBorder = "rgba(47, 47, 47, 0.92)";
  const pillFill = "rgba(20, 20, 24, 0.82)";
  const textMuted = "#c8c8d0";
  const borderW = 9;

  const cx = w * 0.5;
  const logoPhase = hudSmoothStep01(elapsed / 520);

  const logoImgOk = logoImg && logoImg.complete && logoImg.naturalWidth > 0;
  if (logoImgOk) {
    const maxLogoW = Math.min(420, w - 48);
    const ar = logoImg.naturalWidth / logoImg.naturalHeight;
    let lw = maxLogoW;
    let lh = lw / ar;
    const maxH = 54;
    if (lh > maxH) {
      lh = maxH;
      lw = lh * ar;
    }
    const lx = cx - lw * 0.5;
    const ly = 22 + (1 - logoPhase) * 28;
    ctx.save();
    ctx.globalAlpha = logoPhase;
    ctx.drawImage(logoImg, lx, ly, lw, lh);
    ctx.restore();
  }

  const pillW = 256 * 3;
  const hPill12 = 82 * 3;
  const hPill3 = 122 * 3;
  const gapLogoToPill = 52;
  const gapBetweenPills = 56;
  /** Vertical-only stagger (no horizontal shift): alternating extra spacing along Y. */
  const staggerV2 = 14;
  const staggerV3 = 22;
  const yPill1 = 22 + 54 + gapLogoToPill;
  const yPill2 = yPill1 + hPill12 + gapBetweenPills + staggerV2;
  const yPill3 = yPill2 + hPill12 + gapBetweenPills + staggerV3;
  const pxAll = (w - pillW) * 0.5;

  const drawStadiumPill = (px, py, pw, ph, phase) => {
    const slide = (1 - phase) * 48;
    const r = ph * 0.5;
    const pyDraw = py + slide;
    ctx.save();
    ctx.globalAlpha = phase;
    ctx.fillStyle = pillFill;
    ctx.beginPath();
    ctx.roundRect(px, pyDraw, pw, ph, r);
    ctx.fill();
    ctx.strokeStyle = pillBorder;
    ctx.lineWidth = borderW;
    ctx.beginPath();
    ctx.roundRect(px, pyDraw, pw, ph, r);
    ctx.stroke();
    ctx.restore();
  };

  const ph0 = hudPillEnterPhase(elapsed, 0);
  const ph1 = hudPillEnterPhase(elapsed, 1);
  const ph2 = hudPillEnterPhase(elapsed, 2);

  drawStadiumPill(pxAll, yPill1, pillW, hPill12, ph0);
  drawStadiumPill(pxAll, yPill2, pillW, hPill12, ph1);
  drawStadiumPill(pxAll, yPill3, pillW, hPill3, ph2);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const slide0 = (1 - ph0) * 48;
  const slide1 = (1 - ph1) * 48;
  const slide2 = (1 - ph2) * 48;

  const cxPill = pxAll + pillW * 0.5;

  ctx.save();
  ctx.globalAlpha = ph0;
  ctx.font = "500 68px system-ui, -apple-system, sans-serif";
  ctx.fillStyle = textMuted;
  ctx.fillText(timeStr, cxPill, yPill1 + hPill12 * 0.5 + slide0);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = ph1;
  const roomLine = roomDisp ? `Room: ${roomDisp}` : "No room — lobby";
  ctx.font = "400 68px system-ui, -apple-system, sans-serif";
  ctx.fillStyle = textMuted;
  ctx.fillText(roomLine, cxPill, yPill2 + hPill12 * 0.5 + slide1);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = ph2;
  ctx.font = "500 130px system-ui, -apple-system, sans-serif";
  ctx.fillStyle = textMuted;
  ctx.fillText(`${contentScale.toFixed(2)}×`, cxPill, yPill3 + hPill3 * 0.5 + slide2);
  ctx.restore();

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
  const lo = STROKE_WIDTH_MIN;
  const hi = Math.max(lo + 1e-6, userStrokeWidthMax);
  if (!gamepad1) return (lo + hi) * 0.5;
  const btn = gamepad1.buttons[CLUSTER_MIDDLE_DRAW_BTN_INDEX];
  const btnT = btn ? Math.min(1, Math.max(0, btn.value ?? 0)) : 0;
  const tipT = getTipForce01();
  const t = Math.min(1, Math.max(btnT, tipT));
  return lo + t * (hi - lo);
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
 * Operates in `sceneContentRoot` local space so the lattice moves with world/scene transforms.
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
 * Snap stroke geometry center to lattice vertices without re-quantizing rotation. Aligns visible ink
 * with the grid the same way draw-time `snapWorldPointToGrid` does; pivot/origin can stay off-lattice
 * when tube or box profile is not centered on the mesh origin (fixes constant Y/axis offset vs dots).
 * Used on grab release when snap is on.
 */
function snapMeshStrokeToGridTranslateOnly(mesh) {
  if (!mesh) return;
  strokesGroup.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  const cl = ensureMeshCenterLocal(mesh);
  _pickV.copy(cl);
  mesh.localToWorld(_pickV);
  _snapPreWorld.copy(_pickV);
  snapWorldPointToGrid(_pickV);
  _snapTargetCenter.copy(_pickV);
  _snapDeltaWorld.copy(_snapTargetCenter).sub(_snapPreWorld);
  const SNAP_TRANSLATE_EPS = 1e-6;
  if (_snapDeltaWorld.lengthSq() < SNAP_TRANSLATE_EPS * SNAP_TRANSLATE_EPS) {
    return;
  }

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

/** World-space Y span of polyline samples (path points); 0 if none. Used for release snap strategy. */
function getStrokePathWorldYSpan(root) {
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  function visit(mesh) {
    if (!mesh) return;
    mesh.updateMatrixWorld(true);
    if (mesh.isGroup && mesh.userData && mesh.userData.isStrokeCluster) {
      for (const ch of mesh.children) visit(ch);
      return;
    }
    const pts = mesh.userData && mesh.userData.points;
    if (!pts || pts.length === 0) return;
    for (let i = 0; i < pts.length; i++) {
      _pickV.copy(pts[i]);
      mesh.localToWorld(_pickV);
      if (_pickV.y < minY) minY = _pickV.y;
      if (_pickV.y > maxY) maxY = _pickV.y;
      count++;
    }
  }
  visit(root);
  if (count === 0) return 0;
  return maxY - minY;
}

/**
 * Mean world delta (snap(p) - p) over path samples; same lattice rule as draw-time per point.
 */
function snapMeshStrokeToGridPathConsensus(root) {
  if (!root) return;
  strokesGroup.updateMatrixWorld(true);
  root.updateMatrixWorld(true);

  _snapScratch.set(0, 0, 0);
  let n = 0;
  function visit(meshNode) {
    if (!meshNode) return;
    meshNode.updateMatrixWorld(true);
    if (meshNode.isGroup && meshNode.userData && meshNode.userData.isStrokeCluster) {
      for (const ch of meshNode.children) visit(ch);
      return;
    }
    const pts = meshNode.userData && meshNode.userData.points;
    if (!pts || pts.length === 0) return;
    for (let i = 0; i < pts.length; i++) {
      _pickV.copy(pts[i]);
      meshNode.localToWorld(_pickV);
      _snapPreWorld.copy(_pickV);
      snapWorldPointToGrid(_snapPreWorld);
      _snapDeltaWorld.copy(_snapPreWorld).sub(_pickV);
      _snapScratch.add(_snapDeltaWorld);
      n++;
    }
  }
  visit(root);
  if (n === 0) {
    snapMeshStrokeToGridTranslateOnly(root);
    return;
  }
  _snapDeltaWorld.copy(_snapScratch).multiplyScalar(1 / n);

  root.getWorldPosition(_snapPreWorld);
  _meshWorld.copy(_snapPreWorld).add(_snapDeltaWorld);

  const SNAP_RELEASE_EPS = 1e-6;
  if (_meshWorld.distanceToSquared(_snapPreWorld) < SNAP_RELEASE_EPS * SNAP_RELEASE_EPS) return;

  root.position.copy(_meshWorld);
  if (root.parent) root.parent.worldToLocal(root.position);
}

/**
 * Grab release with snap on: flat polylines use pivot X/Z + centroid Y; non-flat use path-consensus.
 */
function snapMeshStrokeToGridReleaseHybrid(mesh) {
  if (!mesh) return;
  strokesGroup.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);

  const cell = gridCellSize();
  const spanY = getStrokePathWorldYSpan(mesh);
  const flatEps = Math.max(1e-5, cell * 1e-4);
  if (spanY > flatEps) {
    snapMeshStrokeToGridPathConsensus(mesh);
    return;
  }

  const cl = ensureMeshCenterLocal(mesh);

  mesh.getWorldPosition(_snapPreWorld);
  _pickV.copy(cl);
  mesh.localToWorld(_pickV);

  _snapTargetCenter.copy(_snapPreWorld);
  snapWorldPointToGrid(_snapTargetCenter);

  _snapScratch.copy(_pickV);
  snapWorldPointToGrid(_snapScratch);

  const oy = _snapPreWorld.y + (_snapScratch.y - _pickV.y);
  _meshWorld.set(_snapTargetCenter.x, oy, _snapTargetCenter.z);

  const SNAP_RELEASE_EPS = 1e-6;
  if (_meshWorld.distanceToSquared(_snapPreWorld) < SNAP_RELEASE_EPS * SNAP_RELEASE_EPS) return;

  mesh.position.copy(_meshWorld);
  if (mesh.parent) mesh.parent.worldToLocal(mesh.position);
}

/** Drop cached stroke centers so lattice snap uses current geometry (cluster + child meshes). */
function invalidateStrokeRootCenterCacheForGrab(root) {
  if (!root) return;
  delete root.userData.centerLocal;
  invalidateStrokeClusterCenters(root);
  if (root.isGroup && root.userData && root.userData.isStrokeCluster) {
    for (const ch of root.children) {
      if (ch.isMesh) delete ch.userData.centerLocal;
    }
  }
}

/**
 * While snap is on: refresh grab offset from mesh origin only — translate-only snap is deferred to
 * the drag loop so the stroke does not jump off the finger on grab start.
 */
function snapGrabbedRootAtGrabStart(root, refWorldPos) {
  if (!snapToGridEnabled || !root) return;
  invalidateStrokeRootCenterCacheForGrab(root);
  strokesGroup.updateMatrixWorld(true);
  root.getWorldPosition(_meshWorld);
  grabOffsetWorld.copy(_meshWorld).sub(refWorldPos);
  if (typeof window !== "undefined" && window.__mxInkGrabDebug) {
    console.debug("[mxink grab start]", { deferredSnap: true, grabOffsetLen: grabOffsetWorld.length() });
  }
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
    forceWristHtmlTextureUpdate();
  });
}

function initStrokeWidthFromStorage() {
  const slider = document.getElementById("stroke-width-slider");
  if (!slider) return;
  try {
    const raw = localStorage.getItem(STROKE_WIDTH_MAX_STORAGE_KEY);
    if (raw != null) {
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v >= STROKE_WIDTH_MIN && v <= STROKE_WIDTH_MAX) {
        userStrokeWidthMax = v;
        slider.value = String(v);
      }
    }
  } catch (_) {
    /* ignore */
  }
  const valEl = document.getElementById("stroke-width-value");
  if (valEl) valEl.textContent = userStrokeWidthMax.toFixed(3);
}

function persistStrokeWidthMax() {
  try {
    localStorage.setItem(STROKE_WIDTH_MAX_STORAGE_KEY, String(userStrokeWidthMax));
  } catch (_) {
    /* ignore */
  }
}

function wireStrokeWidthSlider() {
  const slider = document.getElementById("stroke-width-slider");
  const valEl = document.getElementById("stroke-width-value");
  if (!slider || !valEl) return;
  valEl.textContent = userStrokeWidthMax.toFixed(3);
  slider.addEventListener("input", () => {
    const t = parseFloat(slider.value);
    if (!Number.isFinite(t)) return;
    userStrokeWidthMax = Math.min(
      STROKE_WIDTH_MAX,
      Math.max(STROKE_WIDTH_MIN + 1e-6, t),
    );
    valEl.textContent = userStrokeWidthMax.toFixed(3);
    persistStrokeWidthMax();
    forceWristHtmlTextureUpdate();
  });
}

/**
 * Reduce perpendicular stair-steps from hand jitter: lock non-dominant axes until movement exceeds
 * half a cell on that axis (dominant axis = largest |Δ| from last snapped vertex).
 * Uses `sceneContentRoot` local axes so behavior stays correct when the world is rotated.
 */
function applyDraftSnapConstraint(out, lastWorld, snappedWorld) {
  const cell = gridCellSize();
  const half = cell * 0.5;
  sceneContentRoot.updateMatrixWorld(true);
  _draftSnapLocalLast.copy(lastWorld);
  sceneContentRoot.worldToLocal(_draftSnapLocalLast);
  _draftSnapLocalNext.copy(snappedWorld);
  sceneContentRoot.worldToLocal(_draftSnapLocalNext);

  const lx = _draftSnapLocalLast.x;
  const ly = _draftSnapLocalLast.y;
  const lz = _draftSnapLocalLast.z;
  const sx = _draftSnapLocalNext.x;
  const sy = _draftSnapLocalNext.y;
  const sz = _draftSnapLocalNext.z;
  const dx = Math.abs(sx - lx);
  const dy = Math.abs(sy - ly);
  const dz = Math.abs(sz - lz);
  if (dx < 1e-9 && dy < 1e-9 && dz < 1e-9) {
    out.copy(lastWorld);
    return;
  }
  let dom = 0;
  if (dy > dx && dy >= dz) dom = 1;
  else if (dz > dx && dz > dy) dom = 2;
  else if (dx >= dy && dx >= dz) dom = 0;
  else if (dy >= dz) dom = 1;
  else dom = 2;

  _draftSnapLocalNext.set(sx, sy, sz);
  if (dom !== 0 && dx < half) _draftSnapLocalNext.x = lx;
  if (dom !== 1 && dy < half) _draftSnapLocalNext.y = ly;
  if (dom !== 2 && dz < half) _draftSnapLocalNext.z = lz;

  out.copy(_draftSnapLocalNext);
  sceneContentRoot.localToWorld(out);
}

/**
 * Axis-aligned steps from p0Ref toward p1 (both on grid, world space). Segments follow **grid**
 * axes (`sceneContentRoot` local X/Y/Z), not world Cartesian — required when the scene is rotated.
 */
function emitManhattanSnapSegments(painter, strokeWidth, p0Ref, p1) {
  const eps = 1e-6;
  sceneContentRoot.updateMatrixWorld(true);
  _manhLocalA.copy(p0Ref);
  sceneContentRoot.worldToLocal(_manhLocalA);
  _manhLocalB.copy(p1);
  sceneContentRoot.worldToLocal(_manhLocalB);

  let x = _manhLocalA.x;
  let y = _manhLocalA.y;
  let z = _manhLocalA.z;
  const tx = _manhLocalB.x;
  const ty = _manhLocalB.y;
  const tz = _manhLocalB.z;

  const emitStep = (nx, ny, nz) => {
    if (Math.abs(nx - x) < eps && Math.abs(ny - y) < eps && Math.abs(nz - z) < eps) return;
    _manhSeg.set(nx, ny, nz);
    sceneContentRoot.localToWorld(_manhSeg);
    strokeMeshLocalFromWorld(_strokeMeshLocal, _manhSeg);
    painter.setSize(strokeWidth);
    painter.mesh.userData.strokeWidth = strokeWidth;
    painter.lineTo(_strokeMeshLocal);
    painter.update();
    appendStrokePointWorld(_manhSeg, strokeWidth);
    x = nx;
    y = ny;
    z = nz;
  };
  const dabs = [
    Math.abs(tx - x),
    Math.abs(ty - y),
    Math.abs(tz - z),
  ];
  const axOrder = [0, 1, 2].sort((a, b) => {
    const da = dabs[a];
    const db = dabs[b];
    if (db !== da) return db - da;
    return a - b;
  });
  for (const ax of axOrder) {
    if (ax === 0 && Math.abs(tx - x) > eps) emitStep(tx, y, z);
    else if (ax === 1 && Math.abs(ty - y) > eps) emitStep(x, ty, z);
    else if (ax === 2 && Math.abs(tz - z) > eps) emitStep(x, y, tz);
  }
  p0Ref.copy(p1);
}

/**
 * TubePainter builds geometry in mesh-local space; mesh is a direct child of `strokesGroup` at origin while drawing.
 * Use strokesGroup (not mesh) for world→local so sampling matches serialization and is not affected by mesh matrix drift.
 * Must match `appendStrokePointWorld` (userData.points / sceneCodec).
 */
function strokeMeshLocalFromWorld(out, worldVec) {
  if (!currentStrokePainter) return out.set(0, 0, 0);
  strokesGroup.updateMatrixWorld(true);
  out.copy(worldVec);
  strokesGroup.worldToLocal(out);
  return out;
}

function appendStrokePointWorld(worldVec, width) {
  if (!currentStrokePainter) return;
  strokeMeshLocalFromWorld(_pickV, worldVec);
  currentStrokePointsLocal.push(_pickV.clone());
  const w =
    typeof width === "number" && Number.isFinite(width)
      ? width
      : (STROKE_WIDTH_MIN + userStrokeWidthMax) * 0.5;
  currentStrokeWidthsLocal.push(w);
}

function beginStroke(worldPoint) {
  const startW = getPressureStrokeWidth();
  if (!currentStrokePainter) {
    if (snapToGridEnabled) {
      currentStrokePainter = createGridBoxStrokePainter(
        computeGridBoxStrokeMaxVertices(STROKE_MAX_POINTS),
      );
      {
        const m = getStrokeMaterialForHex(activeStrokeColorHex).clone();
        m.flatShading = true;
        currentStrokePainter.mesh.material = m;
      }
      currentStrokePainter.setSize(startW);
      currentStrokePainter.mesh.userData.strokeWidth = startW;
      currentStrokePainter.mesh.userData.strokeProfile = "square";
      strokesGroup.add(currentStrokePainter.mesh);
    } else {
      currentStrokePainter = new TubePainter();
      currentStrokePainter.mesh.material =
        getStrokeMaterialForHex(activeStrokeColorHex);
      currentStrokePainter.setSize(startW);
      currentStrokePainter.mesh.userData.strokeWidth = startW;
      strokesGroup.add(currentStrokePainter.mesh);
    }
    currentStrokePointsLocal = [];
    currentStrokeWidthsLocal = [];
  }
  _snapScratch.copy(worldPoint);
  if (snapToGridEnabled) snapWorldPointToGrid(_snapScratch);
  _lastStrokeSnapWorld.copy(_snapScratch);
  strokeMeshLocalFromWorld(_strokeMeshLocal, _snapScratch);
  currentStrokePainter.moveTo(_strokeMeshLocal);
  appendStrokePointWorld(_snapScratch, startW);
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

/** Remote scene transform smoothing: skip lerp while this client is grabbing the same root. */
function sceneNetworkIsLocalAuthority(obj) {
  if (grabMode === "none") return false;
  if (grabbedGrabRoots.length > 0) return grabbedGrabRoots.includes(obj);
  return grabbedMesh === obj;
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

  void preloadPresenceHeadModel(SKETCHAR_PRESENCE_HEAD_GLB_URL)
    .then(() => {
      refreshPresenceVisualsFromStoredPayload(sketcharRemotePeers);
    })
    .catch(() => {});
  void preloadPresenceStylusModel(SKETCHAR_PRESENCE_STYLUS_GLB_URL)
    .then(() => {
      refreshPresenceVisualsFromStoredPayload(sketcharRemotePeers);
    })
    .catch(() => {});

  grid3dGroupRef = new THREE.Group();
  grid3dGroupRef.name = "grid-3d";
  grid3dGroupRef.visible = snapToGridEnabled;
  sceneContentRoot.add(strokesGroup);
  sceneContentRoot.add(grid3dGroupRef);
  sceneContentRoot.add(remotePresenceGroup);
  initOriginGizmoAndFloor();
  scene.add(sceneContentRoot);
  initGridLatticeFromSliderDom();
  rebuildGrid3dVisuals();
  wireGridCellSlider();
  initStrokeWidthFromStorage();
  wireStrokeWidthSlider();
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
          if (label) leftPinkyFingerSprite = label;
        } else {
          label = makeLucideFingerSprite(Grid3x3, "grid-3x3");
          if (label) {
            label.userData.gridSnapIconNode = Grid3x3;
            ringGridSnapSprites.push(label);
          }
        }
      } else if (def.joint === "ring-finger-tip") {
        label = makeFingerLabelSprite(def.label);
        if (label && handName === "left") leftRingFingerSprite = label;
      } else if (
        (handName === "left" || handName === "right") &&
        def.joint === "index-finger-tip"
      ) {
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
  pickStrokeDebugLeft = createPickStrokeDebugHandGroup();
  pickStrokeDebugLeft.name = "pick-stroke-debug-left";
  pickStrokeDebugLeft.visible = false;
  scene.add(pickStrokeDebugLeft);
  pickStrokeDebugRight = createPickStrokeDebugHandGroup();
  pickStrokeDebugRight.name = "pick-stroke-debug-right";
  pickStrokeDebugRight.visible = false;
  scene.add(pickStrokeDebugRight);
  pickStrokeDebugStylus = createPickStrokeDebugStylusGroup();
  pickStrokeDebugStylus.name = "pick-stroke-debug-stylus";
  pickStrokeDebugStylus.visible = false;
  scene.add(pickStrokeDebugStylus);
  lastRingSnapSpriteState = null;
  lastLeftStylusGrabFingerMode = "default";
  updateRingGridSnapIndicatorSprites();

  renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
  setPresenceLabelRenderer(renderer);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(sizes.width, sizes.height);
  renderer.setAnimationLoop(animate);
  renderer.xr.enabled = true;
  /** Last-resort stability: `?xrSafe=1` or `window.__SKETCH_XR_SAFE === true` drops depth-sensing and lowers framebuffer scale. */
  let sketcharXrOptionalFeatures = ["unbounded", "hand-tracking", "depth-sensing"];
  try {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("xrSafe") === "1" || window.__SKETCH_XR_SAFE === true) {
      sketcharXrOptionalFeatures = ["unbounded", "hand-tracking"];
      if (typeof renderer.xr.setFramebufferScaleFactor === "function") {
        renderer.xr.setFramebufferScaleFactor(0.85);
      }
    }
  } catch (_) {
    /* ignore */
  }
  document.body.appendChild(
    XRButton.createButton(renderer, {
      optionalFeatures: sketcharXrOptionalFeatures,
    }),
  );
  const xrEnterBtn = document.getElementById("XRButton");
  if (xrEnterBtn) {
    xrEnterBtn.style.display = "none";
    xrEnterBtn.setAttribute("aria-hidden", "true");
  }

  renderer.xr.addEventListener("sessionstart", () => {
    if (typeof window !== "undefined") window.__sketcharXRDepthSensing = false;
    try {
      setupSketcharWristXR();
      setupPalmMenuXR();
    } catch (e) {
      console.warn("[Sketchar] XR wrist/palm HTMLMesh setup failed", e);
    }
  });
  renderer.xr.addEventListener("sessionend", () => {
    if (typeof window !== "undefined") window.__sketcharXRDepthSensing = false;
    teardownSketcharWristXR();
  });

  controller1 = renderer.xr.getController(0);
  controller1.addEventListener("connected", onControllerConnected);
  controller1.addEventListener("selectstart", onSelectStart);
  controller1.addEventListener("selectend", onSelectEnd);
  controllerGrip1 = renderer.xr.getControllerGrip(0);
  scene.add(controllerGrip1);
  scene.add(controller1);

  controller2 = renderer.xr.getController(1);
  controller2.addEventListener("connected", onControllerConnected);
  controller2.addEventListener("selectstart", onSelectStart);
  controller2.addEventListener("selectend", onSelectEnd);
  controllerGrip2 = renderer.xr.getControllerGrip(1);
  scene.add(controllerGrip2);
  scene.add(controller2);

  controller3 = renderer.xr.getController(2);
  controller3.addEventListener("connected", onControllerConnected);
  controller3.addEventListener("selectstart", onSelectStart);
  controller3.addEventListener("selectend", onSelectEnd);
  scene.add(controller3);

  controller4 = renderer.xr.getController(3);
  controller4.addEventListener("connected", onControllerConnected);
  controller4.addEventListener("selectstart", onSelectStart);
  controller4.addEventListener("selectend", onSelectEnd);
  scene.add(controller4);

  xrWristUiControllers.length = 0;
  xrWristUiControllers.push(controller1, controller2, controller3, controller4);

  initSketcharUI();
  initWristUiHitDebugFromUrl();
}

/** URL `?debugWristHits=1` or `window.__SKETCH_DEBUG_WRIST_HITS === true` — outline wrist HTMLMesh hit targets in the rasterized panel. */
function initWristUiHitDebugFromUrl() {
  try {
    const q = new URLSearchParams(window.location.search);
    const fromUrl =
      q.get("debugWristHits") === "1" ||
      q.get("debugWristHits") === "true" ||
      q.get("debugWristHits") === "yes";
    const fromGlobal =
      typeof window !== "undefined" && window.__SKETCH_DEBUG_WRIST_HITS === true;
    if (fromUrl || fromGlobal) {
      document.body.classList.add("sketchar-debug-wrist-hits");
    }
  } catch (_) {}
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
  if (!geo || !geo.attributes) return;
  const pos = geo.attributes.position;
  if (!pos) return;
  const posCount = pos.count;
  if (posCount <= 0) return;
  const dr = geo.drawRange;
  const rawStart = dr ? dr.start : 0;
  const start = Math.max(0, Math.min(rawStart, posCount));
  let count = dr?.count;
  if (!Number.isFinite(count)) {
    count = posCount - start;
  } else {
    count = Math.min(count, posCount - start);
  }
  if (count <= 0) return;
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
  /* Prefer GLB wrapper group (tagged on the direct strokesGroup child) so grab uses one root. */
  let p = o;
  while (p && p !== strokesGroup) {
    if (p.userData && p.userData.isGltfAsset && p.isGroup) {
      return p;
    }
    p = p.parent;
  }
  /* Nested GLB meshes: walk up to the direct child of strokesGroup (matches viewer getMovableRoot). */
  let walk = o;
  while (walk.parent && walk.parent !== strokesGroup) {
    walk = walk.parent;
  }
  return walk.parent === strokesGroup ? walk : o;
}

function sameGrabTarget(a, b) {
  return getStrokeGrabRoot(a) === getStrokeGrabRoot(b);
}

/** Single best target for erase / legacy callers (closest proximity if no ray hit). */
function pickStrokeMeshFirst(origin, direction) {
  raycaster.set(origin, direction);
  raycaster.far = PICK_RAY_MAX_DIST;
  const hits = raycaster.intersectObjects(strokesGroup.children, true);
  if (hits.length > 0) {
    if (typeof window !== "undefined" && window.__mxInkGrabDebug) {
      console.debug("[mxink pick]", { via: "ray", rayDist: hits[0].distance });
    }
    return hits[0].object;
  }

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
  if (typeof window !== "undefined" && window.__mxInkGrabDebug) {
    console.debug("[mxink pick]", {
      via: best ? "proximity" : "none",
      proximityDist: best ? bestDist : null,
    });
  }
  return best;
}

/**
 * All stroke grab roots along the ray (in hit order) or within proximity (closest first).
 * Eraser still uses `pickStrokeMesh` (first/closest only).
 */
function pickStrokeRoots(origin, direction) {
  const seen = new Set();
  const out = [];
  const addFromObj = (obj) => {
    const r = getStrokeGrabRoot(obj);
    if (!seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  };

  raycaster.set(origin, direction);
  raycaster.far = PICK_RAY_MAX_DIST;
  const hits = raycaster.intersectObjects(strokesGroup.children, true);
  for (let i = 0; i < hits.length; i++) {
    addFromObj(hits[i].object);
  }
  if (out.length > 0) return out;

  const candidates = [];
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
    if (d < PICK_PROXIMITY_MAX_DIST) {
      candidates.push({ mesh, d });
    }
  });
  candidates.sort((a, b) => a.d - b.d);
  for (let i = 0; i < candidates.length; i++) {
    addFromObj(candidates[i].mesh);
  }
  return out;
}

function pickStrokeMesh(origin, direction) {
  return pickStrokeMeshFirst(origin, direction);
}

function pickStrokeMeshFromStylusTip() {
  if (!stylus) return null;
  stylus.getWorldQuaternion(_quat);
  _rayDir.set(0, 0, -1).applyQuaternion(_quat).normalize();
  return pickStrokeMesh(stylus.position, _rayDir);
}

function pickStrokeRootsFromStylusTip() {
  if (!stylus) return [];
  stylus.getWorldQuaternion(_quat);
  _rayDir.set(0, 0, -1).applyQuaternion(_quat).normalize();
  return pickStrokeRoots(stylus.position, _rayDir);
}

function pickMatchesGrabSelection(picked) {
  if (!picked) return false;
  const r = getStrokeGrabRoot(picked);
  if (grabbedGrabRoots.length > 0) return grabbedGrabRoots.includes(r);
  return grabbedMesh && r === grabbedMesh;
}

function beginOneHandGrabWithRoots(roots, refPos, inputSource, isStylus) {
  grabbedGrabRoots.length = 0;
  grabbedOneHandEntries.length = 0;
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    grabbedGrabRoots.push(root);
    if (snapToGridEnabled) invalidateStrokeRootCenterCacheForGrab(root);
  }
  strokesGroup.updateMatrixWorld(true);
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    root.getWorldPosition(_meshWorld);
    grabbedOneHandEntries.push({
      root,
      offsetWorld: new THREE.Vector3().copy(_meshWorld).sub(refPos),
    });
  }
  grabbedMesh = roots[0];
  grabOffsetWorld.copy(grabbedOneHandEntries[0].offsetWorld);
  grabInputSource = inputSource ?? null;
  grabInputIsStylus = isStylus;
  grabMode = "one";
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

function createPickStrokeDebugHandGroup() {
  const g = new THREE.Group();
  g.name = "pick-stroke-debug-hand";
  g.renderOrder = 4;
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(PICK_RAY_MAX_DIST, 20, 14),
    new THREE.MeshBasicMaterial({
      color: 0x44ddaa,
      wireframe: true,
      transparent: true,
      opacity: 0.38,
      depthTest: true,
      toneMapped: false,
    }),
  );
  sphere.raycast = () => {};
  g.add(sphere);
  const rayGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -PICK_RAY_MAX_DIST),
  ]);
  const line = new THREE.Line(
    rayGeom,
    new THREE.LineBasicMaterial({
      color: 0x44ffcc,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
      toneMapped: false,
    }),
  );
  line.raycast = () => {};
  g.add(line);
  return g;
}

function createPickStrokeDebugStylusGroup() {
  const g = new THREE.Group();
  g.name = "pick-stroke-debug-stylus-inner";
  g.renderOrder = 4;
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(PICK_RAY_MAX_DIST, 20, 14),
    new THREE.MeshBasicMaterial({
      color: 0xff8844,
      wireframe: true,
      transparent: true,
      opacity: 0.42,
      depthTest: true,
      toneMapped: false,
    }),
  );
  sphere.raycast = () => {};
  g.add(sphere);
  const rayGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -PICK_RAY_MAX_DIST),
  ]);
  const line = new THREE.Line(
    rayGeom,
    new THREE.LineBasicMaterial({
      color: 0xffaa66,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
      toneMapped: false,
    }),
  );
  line.raycast = () => {};
  g.add(line);
  g.userData.sphereMat = sphere.material;
  g.userData.lineMat = line.material;
  return g;
}

/** Colors: free transform (warm) vs grid snap (cool) — pick distance is identical (`pickStrokeMeshFromStylusTip`). */
function applyPickStrokeDebugStylusModeColors(group) {
  const sm = group.userData.sphereMat;
  const lm = group.userData.lineMat;
  if (!sm || !lm) return;
  if (snapToGridEnabled) {
    sm.color.setHex(0x44aaff);
    lm.color.setHex(0x88ccff);
  } else {
    sm.color.setHex(0xff8844);
    lm.color.setHex(0xffaa66);
  }
}

function updatePickStrokeDebugStylus() {
  if (!pickStrokeDebugStylus) return;
  if (!showPickStrokeDebug || !renderer?.xr?.isPresenting) {
    pickStrokeDebugStylus.visible = false;
    return;
  }
  if (!stylus) {
    pickStrokeDebugStylus.visible = false;
    return;
  }
  pickStrokeDebugStylus.position.copy(stylus.position);
  stylus.getWorldQuaternion(pickStrokeDebugStylus.quaternion);
  applyPickStrokeDebugStylusModeColors(pickStrokeDebugStylus);
  pickStrokeDebugStylus.visible = true;
}

function updatePickStrokeDebugGroups(frame, session, refSpace, group, handedness) {
  if (!group) return;
  if (!showPickStrokeDebug) {
    group.visible = false;
    return;
  }
  let src = null;
  for (const inputSource of session.inputSources) {
    if (inputSource.hand && inputSource.handedness === handedness) {
      src = inputSource;
      break;
    }
  }
  if (!src) {
    group.visible = false;
    return;
  }
  const hand = src.hand;
  const indexTip = hand.get("index-finger-tip");
  if (!indexTip) {
    group.visible = false;
    return;
  }
  const pose = frame.getPose(indexTip, refSpace);
  if (!pose) {
    group.visible = false;
    return;
  }
  const p = pose.transform.position;
  const o = pose.transform.orientation;
  group.position.set(p.x, p.y, p.z);
  group.quaternion.set(o.x, o.y, o.z, o.w);
  group.visible = true;
}

function updatePickStrokeDebug(frame, session) {
  if (!renderer?.xr?.isPresenting) {
    if (pickStrokeDebugLeft) pickStrokeDebugLeft.visible = false;
    if (pickStrokeDebugRight) pickStrokeDebugRight.visible = false;
    if (pickStrokeDebugStylus) pickStrokeDebugStylus.visible = false;
    return;
  }
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) {
    return;
  }
  updatePickStrokeDebugGroups(frame, session, refSpace, pickStrokeDebugLeft, "left");
  updatePickStrokeDebugGroups(frame, session, refSpace, pickStrokeDebugRight, "right");
  updatePickStrokeDebugStylus();
}

function releaseGrab() {
  const roots = grabbedGrabRoots.length > 0 ? grabbedGrabRoots.slice() : grabbedMesh ? [grabbedMesh] : [];
  if (snapToGridEnabled) {
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      if (root && root.parent) {
        invalidateStrokeRootCenterCacheForGrab(root);
        snapMeshStrokeToGridReleaseHybrid(root);
      }
    }
    strokesGroup.updateMatrixWorld(true);
  }
  grabbedGrabRoots.length = 0;
  grabbedOneHandEntries.length = 0;
  grabbedMesh = null;
  grabInputSource = null;
  grabInputIsStylus = false;
  twoHandStylusSide = null;
  grabMode = "none";
  twoGrabLeft = null;
  twoGrabRight = null;
  /* Push was deferred while grabMode !== "none" (see shouldDeferSketcharSceneApply). */
  scheduleSketcharPush();
}

function updateLeftHandStylusGrabFingerAffordances() {
  const want = !!(grabInputIsStylus && grabMode === "one");
  const mode = want ? "stylusGrab" : "default";
  if (mode === lastLeftStylusGrabFingerMode) return;
  lastLeftStylusGrabFingerMode = mode;
  if (!leftRingFingerSprite || !leftPinkyFingerSprite) return;
  if (mode === "stylusGrab") {
    paintLucideSpriteTexture(leftRingFingerSprite, Copy, {
      bgFill: "rgba(0,72,56,0.88)",
      borderStroke: "rgba(140,255,190,0.95)",
    });
    leftRingFingerSprite.scale.set(0.011, 0.011, 0.011);
    paintLucideSpriteTexture(leftPinkyFingerSprite, Trash2, {
      bgFill: "rgba(72,24,0,0.88)",
      borderStroke: "rgba(255,180,140,0.95)",
    });
  } else {
    restoreLeftRingFingerSpriteDefault();
    restoreLeftPinkyFingerSpriteDefault();
    leftRingFingerSprite.scale.set(0.006, 0.006, 0.006);
  }
}

/**
 * @param {THREE.Sprite} sprite
 * @param {unknown} iconNode
 * @param {{ bgFill: string; borderStroke: string }} style
 */
function paintLucideSpriteTexture(sprite, iconNode, style) {
  const tex = sprite.material.map;
  const canvas = tex && tex.image;
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (canvas.width !== 72 || canvas.height !== 72) {
    canvas.width = 72;
    canvas.height = 72;
  }
  paintLucideFingerSpriteCanvas(ctx, 72, iconNode, style);
  tex.needsUpdate = true;
}

function restoreLeftRingFingerSpriteDefault() {
  if (!leftRingFingerSprite) return;
  const s = makeFingerLabelSprite("R");
  if (!s) return;
  const newMap = s.material.map;
  const old = leftRingFingerSprite.material.map;
  leftRingFingerSprite.material.map = newMap;
  leftRingFingerSprite.material.needsUpdate = true;
  s.material.map = null;
  s.material.dispose();
  if (old) old.dispose();
}

function restoreLeftPinkyFingerSpriteDefault() {
  if (!leftPinkyFingerSprite) return;
  const s = makeLucideFingerSprite(Boxes, "boxes");
  if (!s) return;
  const newMap = s.material.map;
  const old = leftPinkyFingerSprite.material.map;
  leftPinkyFingerSprite.material.map = newMap;
  leftPinkyFingerSprite.material.needsUpdate = true;
  s.material.map = null;
  s.material.dispose();
  if (old) old.dispose();
}

function duplicateGrabbedStrokeRoot() {
  const roots = grabbedGrabRoots.length > 0 ? grabbedGrabRoots.slice() : grabbedMesh ? [grabbedMesh] : [];
  if (roots.length === 0) return;
  const baseOff = new THREE.Vector3(0.05, 0.05, 0.05);
  for (let ri = 0; ri < roots.length; ri++) {
    const root = roots[ri];
    const parent = root.parent || strokesGroup;
    const offset = baseOff.clone().multiplyScalar(ri + 1);
    if (root.userData && root.userData.isStrokeCluster && root.isGroup) {
      const g = new THREE.Group();
      g.userData.isStrokeCluster = true;
      g.userData.syncId = crypto.randomUUID();
      sketcharPendingSyncIds.add(g.userData.syncId);
      g.position.copy(root.position).add(offset);
      g.quaternion.copy(root.quaternion);
      g.scale.copy(root.scale);
      for (const ch of root.children) {
        if (!ch.isMesh || ch.isInstancedMesh || !ch.userData.points) continue;
        const pts = ch.userData.points.map((p) => p.clone());
        const chHex =
          typeof ch.userData.strokeColorHex === "number" &&
          Number.isFinite(ch.userData.strokeColorHex)
            ? ch.userData.strokeColorHex >>> 0
            : DEFAULT_STROKE_COLOR_HEX;
        const nm = buildStrokeMeshFromPoints(
          pts,
          ch.userData.strokeWidth,
          ch.userData.strokeWidths,
          chHex,
          ch.userData.strokeProfile,
        );
        nm.position.copy(ch.position);
        nm.quaternion.copy(ch.quaternion);
        nm.scale.copy(ch.scale);
        nm.userData.syncId = crypto.randomUUID();
        sketcharPendingSyncIds.add(nm.userData.syncId);
        g.add(nm);
      }
      parent.add(g);
      invalidateStrokeClusterCenters(g);
    } else if (root.isMesh && root.userData.points && root.userData.points.length >= 2) {
      const pts = root.userData.points.map((p) => p.clone());
      const rootHex =
        typeof root.userData.strokeColorHex === "number" &&
        Number.isFinite(root.userData.strokeColorHex)
          ? root.userData.strokeColorHex >>> 0
          : DEFAULT_STROKE_COLOR_HEX;
      const nm = buildStrokeMeshFromPoints(
        pts,
        root.userData.strokeWidth,
        root.userData.strokeWidths,
        rootHex,
        root.userData.strokeProfile,
      );
      nm.position.copy(root.position).add(offset);
      nm.quaternion.copy(root.quaternion);
      nm.scale.copy(root.scale);
      nm.userData.syncId = crypto.randomUUID();
      sketcharPendingSyncIds.add(nm.userData.syncId);
      parent.add(nm);
      delete nm.userData.centerLocal;
    }
  }
  scheduleSketcharPush();
}

function deleteGrabbedStrokeRoot() {
  const roots = grabbedGrabRoots.length > 0 ? grabbedGrabRoots.slice() : grabbedMesh ? [grabbedMesh] : [];
  if (roots.length === 0) return;
  for (let ri = 0; ri < roots.length; ri++) {
    const root = roots[ri];
    if (root.userData && root.userData.isGltfAsset && root.isGroup) {
      recordSketcharDeletionForObject3D(root);
      const u = typeof root.userData.gltfUrl === "string" ? root.userData.gltfUrl.trim() : "";
      if (u) {
        const rawUrl = import.meta.env.VITE_EXPORT_GLB_URL;
        const rawTok = import.meta.env.VITE_EXPORT_GLB_TOKEN;
        const exportUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";
        const exportTok = typeof rawTok === "string" ? rawTok.trim() : "";
        void deleteRoomGlbFromR2(u, { url: exportUrl, token: exportTok });
      }
      disposeSceneGeometrySubtree(root);
      root.removeFromParent();
    } else if (root.userData && root.userData.isStrokeCluster && root.isGroup) {
      recordSketcharDeletionForObject3D(root);
      root.traverse((o) => {
        if (o.isMesh && o.geometry) o.geometry.dispose();
      });
      root.removeFromParent();
    } else {
      removeStrokeMeshFromScene(root);
    }
  }
  releaseGrab();
  scheduleSketcharPush();
}

function handleStylusGrabAuxPinches(frame) {
  if (!grabInputIsStylus || grabMode !== "one" || !grabbedMesh) return;
  if (!frame || !renderer.xr.isPresenting) return;
  const refSpace = renderer.xr.getReferenceSpace();
  const session = renderer.xr.getSession();
  if (!refSpace || !session) return;

  for (const inputSource of session.inputSources) {
    if (!inputSource.hand || inputSource.handedness !== "left") continue;
    const hand = inputSource.hand;
    const thumbTip = hand.get("thumb-tip");
    const ringTip = hand.get("ring-finger-tip");
    const pinkyTip = hand.get("pinky-finger-tip");
    if (!thumbTip || !ringTip || !pinkyTip) continue;
    const tp = frame.getPose(thumbTip, refSpace);
    const rp = frame.getPose(ringTip, refSpace);
    const pp = frame.getPose(pinkyTip, refSpace);
    if (!tp || !rp || !pp) continue;
    jointPositionFromPose(tp, _thumbTipPos);
    jointPositionFromPose(rp, _pickV);
    const dRing = _thumbTipPos.distanceTo(_pickV);
    jointPositionFromPose(pp, _pinkyTipPos);
    const dPinky = _thumbTipPos.distanceTo(_pinkyTipPos);

    const wasRing = thumbRingDupPinchPrev.get(inputSource) === true;
    const isRing = wasRing ? dRing < PINCH_OPEN_DIST : dRing < PINCH_CLOSE_DIST;
    thumbRingDupPinchPrev.set(inputSource, isRing);
    if (isRing && !wasRing) duplicateGrabbedStrokeRoot();

    const wasDel = thumbPinkyDelPinchPrev.get(inputSource) === true;
    const isDel = wasDel ? dPinky < PINCH_OPEN_DIST : dPinky < PINCH_CLOSE_DIST;
    thumbPinkyDelPinchPrev.set(inputSource, isDel);
    if (isDel && !wasDel) deleteGrabbedStrokeRoot();
  }
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

function refreshSceneStrokesOnTwoHandEnd() {
  refreshAllStrokesTubeGeometryForWorldWidth();
  sceneTwoHandStrokeRefreshAtScale = sceneContentRoot.scale.x;
}

function releaseSceneManip() {
  const wasTwo = sceneManipMode === "two";
  sceneManipMode = "none";
  sceneGrabL = null;
  sceneGrabR = null;
  sceneOneSrc = null;
  sceneTwoHandStylusSide = null;
  scenePrevStylusRearGrab = false;
  if (wasTwo) refreshSceneStrokesOnTwoHandEnd();
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
  if (snapToGridEnabled) {
    sceneContentRoot.updateMatrixWorld(true);
    _meshWorld.set(0, 0, 0);
    sceneContentRoot.localToWorld(_meshWorld);
    _snapScratch.copy(_meshWorld);
    snapWorldPointToGrid(_snapScratch);
    const parent = sceneContentRoot.parent;
    if (parent) {
      parent.updateMatrixWorld(true);
      const aP = _meshWorld.clone();
      parent.worldToLocal(aP);
      const bP = _snapScratch.clone();
      parent.worldToLocal(bP);
      sceneContentRoot.position.add(bP.sub(aP));
    } else {
      sceneContentRoot.position.copy(_snapScratch);
    }
  }
}

function transitionSceneTwoToOne(slot, frame, refSpace) {
  sceneGrabL = null;
  sceneGrabR = null;
  sceneTwoHandStylusSide = null;
  sceneManipMode = "one";
  sceneOneSrc = slot.inputSource;
  getThumbMiddleAnchorWorldInto(frame, refSpace, slot.hand, sm_oneAnchor0);
  sceneOnePos0.copy(sceneContentRoot.position);
  refreshSceneStrokesOnTwoHandEnd();
}

function sceneTwoHandGrabFinishInit() {
  sm_thV0.copy(sm_thPR0).sub(sm_thPL0);
  sm_thDist0 = Math.max(sm_thV0.length(), 0.02);
  sm_thMid0.copy(sm_thPL0).add(sm_thPR0).multiplyScalar(0.5);
  sceneContentRoot.updateMatrixWorld(true);
  try {
    sm_box.setFromObject(strokesGroup);
  } catch (e) {
    console.warn("[scene manip] strokesGroup bounds failed", e);
    sm_box.makeEmpty();
  }
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
  sceneTwoHandStrokeRefreshAtScale = sceneContentRoot.scale.x;
  sceneTwoHandSmoothInit = true;
  sceneTwoHandScaleSmoothed = 1;
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
    if (!getThumbMiddleAnchorWorldInto(frame, refSpace, sceneGrabL.hand, _smRawL)) return;
    if (!getThumbMiddleAnchorWorldInto(frame, refSpace, sceneGrabR.hand, _smRawR)) return;
  } else if (sceneTwoHandStylusSide === "right") {
    if (!sceneGrabL?.hand || !stylus) return;
    if (!getThumbMiddleAnchorWorldInto(frame, refSpace, sceneGrabL.hand, _smRawL)) return;
    _smRawR.copy(stylus.position);
  } else if (sceneTwoHandStylusSide === "left") {
    if (!sceneGrabR?.hand || !stylus) return;
    _smRawL.copy(stylus.position);
    if (!getThumbMiddleAnchorWorldInto(frame, refSpace, sceneGrabR.hand, _smRawR)) return;
  } else {
    return;
  }

  if (sceneTwoHandSmoothInit) {
    sm_thPL.copy(_smRawL);
    sm_thPR.copy(_smRawR);
  } else {
    sm_thPL.lerp(_smRawL, SCENE_TWO_HAND_HAND_SMOOTH);
    sm_thPR.lerp(_smRawR, SCENE_TWO_HAND_HAND_SMOOTH);
  }

  sm_thV.copy(sm_thPR).sub(sm_thPL);
  const dist = sm_thV.length();
  if (dist < 1e-5 || sm_thDist0 < 1e-5) return;

  let sRaw = dist / sm_thDist0;
  sRaw = Math.min(SCENE_MANIP_SCALE_MAX, Math.max(SCENE_MANIP_SCALE_MIN, sRaw));
  if (sceneTwoHandSmoothInit) {
    sceneTwoHandScaleSmoothed = sRaw;
  } else {
    sceneTwoHandScaleSmoothed = THREE.MathUtils.lerp(
      sceneTwoHandScaleSmoothed,
      sRaw,
      SCENE_TWO_HAND_SCALE_SMOOTH,
    );
  }
  const s = sceneTwoHandScaleSmoothed;
  if (sceneTwoHandSmoothInit) sceneTwoHandSmoothInit = false;

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
      (stylusHandedness === "right" || stylusHandedness === "left") &&
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
    (stylusHandedness === "right" || stylusHandedness === "left")
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
  grabbedGrabRoots.length = 0;
  grabbedGrabRoots.push(mesh);
  grabbedOneHandEntries.length = 0;
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
  // Pinch distance scales the mesh uniformly; tube thickness is rebuilt to stay constant in world space.
  mesh.scale.setScalar(thBaseScale * s);
  /* thQuatMesh0 is world space from init; mesh.quaternion is parent-local — convert so grab start pose is preserved. */
  _qWorldGrab.copy(thQuatMesh0).premultiply(qAlign).premultiply(qTwist);
  if (mesh.parent) {
    mesh.parent.updateMatrixWorld(true);
    mesh.parent.getWorldQuaternion(_snapParentQuat);
    mesh.quaternion.copy(_snapParentQuat).invert().multiply(_qWorldGrab);
  } else {
    mesh.quaternion.copy(_qWorldGrab);
  }
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
  /* Lattice alignment on release only (releaseGrab); free transform while pinching. */
  strokesGroup.updateMatrixWorld(true);
  mesh.updateMatrixWorld(true);
  refreshStrokeRootForWorldWidth(mesh);
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
  grabbedGrabRoots.length = 0;
  grabbedGrabRoots.push(mesh);
  grabbedOneHandEntries.length = 0;
  grabbedOneHandEntries.push({
    root: mesh,
    offsetWorld: new THREE.Vector3().copy(grabOffsetWorld),
  });
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
  grabbedGrabRoots.length = 0;
  grabbedGrabRoots.push(mesh);
  grabbedOneHandEntries.length = 0;
  grabbedOneHandEntries.push({
    root: mesh,
    offsetWorld: new THREE.Vector3().copy(grabOffsetWorld),
  });
}

function ensureMeshCenterLocal(mesh) {
  if (!mesh?.userData) return new THREE.Vector3(0, 0, 0);
  if (mesh.userData.centerLocal) return mesh.userData.centerLocal;
  if (mesh.userData.isGltfAsset && mesh.isGroup) {
    mesh.updateMatrixWorld(true);
    try {
      _gltfGrabBounds.setFromObject(mesh);
      if (_gltfGrabBounds.isEmpty()) {
        mesh.userData.centerLocal = new THREE.Vector3(0, 0, 0);
      } else {
        _gltfGrabBounds.getCenter(_centerLocal);
        mesh.worldToLocal(_centerLocal);
        mesh.userData.centerLocal = _centerLocal.clone();
      }
    } catch (e) {
      console.warn("[gltf] ensureMeshCenterLocal bounds failed", e);
      mesh.userData.centerLocal = new THREE.Vector3(0, 0, 0);
    }
    return mesh.userData.centerLocal;
  }
  if (mesh.isGroup && mesh.userData && mesh.userData.isStrokeCluster) {
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
  if (mesh.geometry && mesh.geometry.boundingSphere) {
    mesh.userData.centerLocal = mesh.geometry.boundingSphere.center.clone();
    return mesh.userData.centerLocal;
  }
  mesh.userData.centerLocal = new THREE.Vector3(0, 0, 0);
  return mesh.userData.centerLocal;
}

function buildStrokeMeshFromPoints(
  pointsLocal,
  strokeWidth,
  strokeWidths,
  strokeColorHex,
  strokeProfile,
) {
  const fallback = strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
  const hex =
    typeof strokeColorHex === "number" && Number.isFinite(strokeColorHex)
      ? strokeColorHex >>> 0
      : DEFAULT_STROKE_COLOR_HEX;
  const n = pointsLocal.length;
  const square = strokeProfile === "square";
  const useWidths =
    Array.isArray(strokeWidths) &&
    strokeWidths.length === n &&
    strokeWidths.every((x) => typeof x === "number" && Number.isFinite(x));

  if (square) {
    const gp = createGridBoxStrokePainter(computeGridBoxStrokeMaxVertices(n));
    {
      const m = getStrokeMaterialForHex(hex).clone();
      m.flatShading = true;
      gp.mesh.material = m;
    }
    gp.mesh.userData.strokeColorHex = hex;
    gp.mesh.userData.strokeProfile = "square";
    if (useWidths) {
      gp.moveTo(pointsLocal[0]);
      for (let i = 1; i < n; i++) {
        gp.setSize(strokeWidths[i]);
        gp.mesh.userData.strokeWidth = strokeWidths[i];
        gp.lineTo(pointsLocal[i]);
      }
      gp.mesh.userData.strokeWidths = strokeWidths.slice();
    } else {
      gp.setSize(fallback);
      gp.mesh.userData.strokeWidth = fallback;
      gp.moveTo(pointsLocal[0]);
      for (let i = 1; i < n; i++) {
        gp.lineTo(pointsLocal[i]);
      }
      gp.mesh.userData.strokeWidths = pointsLocal.map(() => fallback);
    }
    gp.update();
    gp.mesh.userData.points = pointsLocal.map((p) => p.clone());
    return gp.mesh;
  }

  const tp = createTubePainterSized(computeTubePainterMaxVertices(n));
  tp.mesh.material = getStrokeMaterialForHex(hex);
  tp.mesh.userData.strokeColorHex = hex;
  if (useWidths) {
    tp.moveTo(pointsLocal[0]);
    for (let i = 1; i < n; i++) {
      tp.setSize(strokeWidths[i]);
      tp.mesh.userData.strokeWidth = strokeWidths[i];
      tp.lineTo(pointsLocal[i]);
    }
    tp.mesh.userData.strokeWidths = strokeWidths.slice();
  } else {
    tp.setSize(fallback);
    tp.mesh.userData.strokeWidth = fallback;
    tp.moveTo(pointsLocal[0]);
    for (let i = 1; i < n; i++) {
      tp.lineTo(pointsLocal[i]);
    }
    tp.mesh.userData.strokeWidths = pointsLocal.map(() => fallback);
  }
  tp.update();
  tp.mesh.userData.points = pointsLocal.map((p) => p.clone());
  return tp.mesh;
}

/**
 * Product of uniform scale from `obj` through `sceneContentRoot` (inclusive).
 * Stops at `sceneContentRoot` so we never multiply unrelated scene graph scales.
 */
function getStrokeWorldUniformScale(obj) {
  let s = 1;
  let o = obj;
  while (o && o !== sceneContentRoot) {
    s *= o.scale.x;
    o = o.parent;
  }
  if (o === sceneContentRoot) s *= o.scale.x;
  return Math.max(s, 1e-6);
}

/**
 * Stroke material after rebuild: grid/box strokes need flat shading (cloned so cache is unchanged).
 */
function applyStrokeMaterialAfterRebuild(mesh, colorHex) {
  const h =
    typeof colorHex === "number" && Number.isFinite(colorHex)
      ? colorHex >>> 0
      : DEFAULT_STROKE_COLOR_HEX;
  const m = getStrokeMaterialForHex(h).clone();
  if (mesh.userData.strokeProfile === "square") m.flatShading = true;
  mesh.material = m;
  mesh.userData.strokeColorHex = h;
}

/**
 * Rebuild tube geometry so world stroke width matches canonical `userData.strokeWidths`
 * after hierarchy scale changes. Does not alter serialized/sync stroke width values.
 */
function refreshStrokeTubeGeometryForWorldWidth(mesh) {
  if (!mesh || !mesh.isMesh || mesh.isInstancedMesh) return;
  const pts = mesh.userData.points;
  if (!pts || pts.length < 2) return;

  const canonicalStrokeWidth =
    mesh.userData.strokeWidth ??
    (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
  const canonicalWidths = mesh.userData.strokeWidths;
  const widthsOk =
    Array.isArray(canonicalWidths) &&
    canonicalWidths.length === pts.length &&
    canonicalWidths.every((x) => typeof x === "number" && Number.isFinite(x));

  mesh.updateMatrixWorld(true);
  const s = getStrokeWorldUniformScale(mesh);
  const effectiveFallback = canonicalStrokeWidth / s;
  const effectiveWidths = widthsOk
    ? canonicalWidths.map((w) => w / s)
    : null;

  const localPts = pts.map((p) => p.clone());
  const colorHex =
    typeof mesh.userData.strokeColorHex === "number" &&
    Number.isFinite(mesh.userData.strokeColorHex)
      ? mesh.userData.strokeColorHex >>> 0
      : DEFAULT_STROKE_COLOR_HEX;
  const built = buildStrokeMeshFromPoints(
    localPts,
    effectiveFallback,
    effectiveWidths,
    colorHex,
    mesh.userData.strokeProfile,
  );

  const oldG = mesh.geometry;
  mesh.geometry = built.geometry;
  built.geometry = null;
  oldG.dispose();

  mesh.userData.points = localPts.map((p) => p.clone());
  if (widthsOk) {
    mesh.userData.strokeWidths = canonicalWidths.slice();
  } else {
    mesh.userData.strokeWidths = pts.map(() => canonicalStrokeWidth);
  }
  mesh.userData.strokeWidth = canonicalStrokeWidth;
  applyStrokeMaterialAfterRebuild(mesh, colorHex);
  delete mesh.userData.centerLocal;
  invalidateStrokeClusterCenters(mesh);
  updateStrokeBoundingSphereFromDrawRange(mesh);
}

/** Stroke mesh or cluster group under `strokesGroup`. */
function refreshStrokeRootForWorldWidth(root) {
  if (!root) return;
  if (root.userData && root.userData.isStrokeCluster && root.isGroup) {
    for (const ch of root.children) {
      if (ch.isMesh && ch.userData && ch.userData.points) {
        refreshStrokeTubeGeometryForWorldWidth(ch);
      }
    }
    return;
  }
  if (root.isMesh && root.userData && root.userData.points) {
    refreshStrokeTubeGeometryForWorldWidth(root);
  }
}

function refreshAllStrokesTubeGeometryForWorldWidth() {
  strokesGroup.updateMatrixWorld(true);
  for (const ch of strokesGroup.children) {
    refreshStrokeRootForWorldWidth(ch);
  }
}

function invalidateStrokeClusterCenters(node) {
  let p = node;
  while (p) {
    if (p.userData && p.userData.isStrokeCluster) delete p.userData.centerLocal;
    p = p.parent;
  }
}

function eraseStrokeAtWorld(mesh, eraseWorldPt) {
  recordSketcharDeletionForObject3D(mesh);
  const pts = mesh.userData.points;
  const strokeWidthsFull = mesh.userData.strokeWidths;
  const widthsOk =
    Array.isArray(strokeWidthsFull) &&
    strokeWidthsFull.length === pts?.length;
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
  /** @type {number[][]} */
  const runWidths = [];
  let start = -1;
  for (let i = 0; i < keep.length; i++) {
    if (keep[i]) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= 2) {
        runs.push(pts.slice(start, i));
        if (widthsOk) {
          runWidths.push(strokeWidthsFull.slice(start, i));
        }
      }
      start = -1;
    }
  }
  if (start >= 0 && keep.length - start >= 2) {
    runs.push(pts.slice(start));
    if (widthsOk) {
      runWidths.push(strokeWidthsFull.slice(start));
    }
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
  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri];
    const localPts = run.map((p) => p.clone());
    const rw =
      widthsOk && runWidths[ri] && runWidths[ri].length === localPts.length
        ? runWidths[ri]
        : null;
    const splitColorHex =
      typeof mesh.userData.strokeColorHex === "number" &&
      Number.isFinite(mesh.userData.strokeColorHex)
        ? mesh.userData.strokeColorHex >>> 0
        : DEFAULT_STROKE_COLOR_HEX;
    const newMesh = buildStrokeMeshFromPoints(
      localPts,
      sw,
      rw,
      splitColorHex,
      mesh.userData.strokeProfile,
    );
    newMesh.position.copy(pos);
    newMesh.quaternion.copy(quat);
    newMesh.scale.copy(sc);
    newMesh.userData.points = localPts.map((p) => p.clone());
    const splitId = crypto.randomUUID();
    newMesh.userData.syncId = splitId;
    sketcharPendingSyncIds.add(splitId);
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
    recordSketcharDeletionForObject3D(cluster);
    cluster.removeFromParent();
    return;
  }
  if (cluster.children.length !== 1) return;
  const ch = cluster.children[0];
  cluster.remove(ch);
  strokesGroup.add(ch);
  recordSketcharDeletionForObject3D(cluster);
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
    recordSketcharDeletionForObject3D(hit);
    hit.removeFromParent();
    hit.geometry.dispose();
    /* Stroke materials are shared/cached — dispose geometry only. */
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

function detachStrokeRootForUndo(root) {
  if (!root) return;
  recordSketcharDeletionForObject3D(root);
  const parent = root.parent;
  root.removeFromParent();
  if (parent && parent.userData && parent.userData.isStrokeCluster) {
    invalidateStrokeClusterCenters(parent);
    dissolveStrokeClusterIfSingleton(parent);
  }
}

function clearStrokeUndoStacks() {
  strokeUndoStack.length = 0;
  strokeRedoStack.length = 0;
}

function updateStrokeUndoRedoButtons() {
  const u = document.getElementById("sketchar-undo");
  const r = document.getElementById("sketchar-redo");
  if (u) u.disabled = strokeUndoStack.length === 0;
  if (r) r.disabled = strokeRedoStack.length === 0;
  forceWristHtmlTextureUpdate();
}

function undoLastStroke() {
  while (strokeUndoStack.length > 0) {
    const root = strokeUndoStack.pop();
    if (!root || !meshIsUnderStrokesGroup(root)) continue;
    detachStrokeRootForUndo(root);
    strokeRedoStack.push(root);
    scheduleSketcharPush();
    updateStrokeUndoRedoButtons();
    return;
  }
  updateStrokeUndoRedoButtons();
}

function redoLastStroke() {
  if (strokeRedoStack.length === 0) {
    updateStrokeUndoRedoButtons();
    return;
  }
  const root = strokeRedoStack.pop();
  const id =
    root.userData && typeof root.userData.syncId === "string"
      ? root.userData.syncId.trim()
      : "";
  if (id) sketcharDeletedSyncIds.delete(id);
  strokesGroup.add(root);
  strokesGroup.updateMatrixWorld(true);
  strokeUndoStack.push(root);
  scheduleSketcharPush();
  updateStrokeUndoRedoButtons();
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
  recordSketcharDeletionForObject3D(mesh);
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
  const inst = new THREE.InstancedMesh(geom, voxelMaterial, count);
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
      snapToGridEnabled = !snapToGridEnabled;
      return;
    }
  }
}

function handleBlockModePinch(frame) {
  const refSpace = renderer.xr.getReferenceSpace();
  if (!refSpace) return;
  const session = renderer.xr.getSession();
  if (!session) return;

  /* Thumb+pinky on left is delete while rear-grabbing an object — block voxel affordance. */
  if (grabInputIsStylus && grabMode !== "none") return;

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

  /* Scene/world manip uses rear+stylus; do not compete with stroke grab in the same frame. */
  if (sceneManipMode !== "none") return;

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
    const entries =
      grabbedOneHandEntries.length > 0
        ? grabbedOneHandEntries
        : [{ root: grabbedMesh, offsetWorld: grabOffsetWorld }];
    for (let gi = 0; gi < entries.length; gi++) {
      const { root, offsetWorld: offW } = entries[gi];
      _grabTargetWorld.copy(stylus.position).add(offW);
      const grabPar = root.parent;
      if (grabPar) grabPar.worldToLocal(_grabTargetWorld);
      else strokesGroup.worldToLocal(_grabTargetWorld);
      root.position.copy(_grabTargetWorld);
    }

    for (const hs of handStates) {
      if (!hs.isPinched || hs.wasPinched) continue;
      if (handGrabBlockedWhileDrawing(hs.inputSource)) continue;
      rayDirFromIndexTipPose(hs.indexPose);
      const picked = pickStrokeMesh(hs.indexPos, _rayDir);
      if (!pickMatchesGrabSelection(picked)) continue;
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
    const entries =
      grabbedOneHandEntries.length > 0
        ? grabbedOneHandEntries
        : [{ root: grabbedMesh, offsetWorld: grabOffsetWorld }];
    for (let gi = 0; gi < entries.length; gi++) {
      const { root, offsetWorld: offW } = entries[gi];
      _grabTargetWorld.copy(_indexTipPos).add(offW);
      const grabParIdx = root.parent;
      if (grabParIdx) grabParIdx.worldToLocal(_grabTargetWorld);
      else strokesGroup.worldToLocal(_grabTargetWorld);
      root.position.copy(_grabTargetWorld);
    }
    if (snapToGridEnabled) {
      for (let gi = 0; gi < entries.length; gi++) {
        snapMeshStrokeToGridTranslateOnly(entries[gi].root);
      }
      strokesGroup.updateMatrixWorld(true);
      for (let gi = 0; gi < entries.length; gi++) {
        const ent = entries[gi];
        ent.root.getWorldPosition(_meshWorld);
        ent.offsetWorld.copy(_meshWorld).sub(_indexTipPos);
      }
    }

    for (const hs of handStates) {
      if (hs.inputSource === grabInputSource) continue;
      if (!hs.isPinched || hs.wasPinched) continue;
      if (handGrabBlockedWhileDrawing(hs.inputSource)) continue;
      rayDirFromIndexTipPose(hs.indexPose);
      const picked = pickStrokeMesh(hs.indexPos, _rayDir);
      if (!pickMatchesGrabSelection(picked)) continue;

      const lr = leftRightSources(grabInputSource, hs.inputSource);
      if (!lr) continue;
      if (!getIndexTipWorldInto(frame, refSpace, lr.left.hand, thPL)) continue;
      if (!getIndexTipWorldInto(frame, refSpace, lr.right.hand, thPR)) continue;
      initTwoHandGrab(grabbedMesh, thPL, thPR, lr.left, lr.right, frame, refSpace);
      break;
    }

    if (grabMode === "one" && grabbedMesh && grabInputSource && isStylusGrabForManip()) {
      const pickStylus = pickStrokeMeshFromStylusTip();
      if (pickMatchesGrabSelection(pickStylus)) {
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
    jointPositionFromPose(hs.indexPose, _indexTipPos);
    const roots = pickStrokeRoots(hs.indexPos, _rayDir);
    if (roots.length === 0) continue;
    beginOneHandGrabWithRoots(roots, _indexTipPos, hs.inputSource, false);
    break;
  }

  if (
    grabMode === "none" &&
    sceneManipMode === "none" &&
    stylus &&
    gamepad1 &&
    isStylusGrabForManip()
  ) {
    const roots = pickStrokeRootsFromStylusTip();
    if (roots.length > 0) {
      beginOneHandGrabWithRoots(roots, stylus.position, null, true);
    }
  }
}

function animate(time, frame) {
  if (renderer?.xr && !renderer.xr.isPresenting) {
    if (pickStrokeDebugLeft) pickStrokeDebugLeft.visible = false;
    if (pickStrokeDebugRight) pickStrokeDebugRight.visible = false;
    if (pickStrokeDebugStylus) pickStrokeDebugStylus.visible = false;
  }
  if (renderer.xr.isPresenting && typeof window !== "undefined") {
    window.__sketcharXRDepthSensing = renderer.xr.hasDepthSensing();
  }
  syncOriginGizmoVisibility();
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
    /* Thumb+index pinch on stylus hand: prefer transform over accidental cluster_front (eraser). */
    if (pinchBlocksPen) _eraserThisFrame = false;

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
    mesh.userData.strokeWidths = currentStrokeWidthsLocal.slice();
    mesh.userData.strokeWidth =
      currentStrokeWidthsLocal.length > 0
        ? currentStrokeWidthsLocal[currentStrokeWidthsLocal.length - 1]
        : mesh.userData.strokeWidth ??
          (STROKE_WIDTH_MIN + userStrokeWidthMax) * 0.5;
    delete mesh.userData.centerLocal;
    mesh.userData.syncId = crypto.randomUUID();
    mesh.userData.strokeColorHex = activeStrokeColorHex;
    sketcharPendingSyncIds.add(mesh.userData.syncId);
    strokeRedoStack.length = 0;
    strokeUndoStack.push(mesh);
    updateStrokeUndoRedoButtons();
    currentStrokePainter = null;
    currentStrokePointsLocal.length = 0;
    currentStrokeWidthsLocal.length = 0;
    pushCompletedStrokeForBlockMode(mesh);
    scheduleSketcharPush();
    if (sketcharPollDeferred) void flushSketcharRemote();
  }

  if (frame && renderer.xr.isPresenting) {
    /* Scene/world manip must run before hand grab: rear+stylus would otherwise pick a stroke and block canSceneManip(). */
    handleSceneManip(frame);
    handleHandGrab(frame);
    maybePushSketcharDuringGrabTransform();
    updateLeftHandStylusGrabFingerAffordances();
    handleStylusGrabAuxPinches(frame);
  }

  if (stylus && gamepad1 && isEraserHeld()) {
    handleEraseWithStylus();
  }

  if (frame && renderer.xr.isPresenting) {
    const session = renderer.xr.getSession();
    if (session) updateFingerDebug(frame, session);
    if (session) updatePickStrokeDebug(frame, session);
    if (session) {
      updateWristMenuPose(frame, session);
      updatePalmMenuPose(frame, session);
    }
    if (
      stylus &&
      (wristMenuGroup?.visible || palmMenuGroup?.visible)
    ) {
      updateWristPalmMenuStylusPointerAssist();
      processStylusUiPlanePenetration();
      if (
        palmWheelDragActive &&
        palmMenuUvValid &&
        lastStylusUiMesh === palmHtmlMesh &&
        !_palmWheelLastDragUv.equals(palmMenuLastUv)
      ) {
        _palmWheelLastDragUv.copy(palmMenuLastUv);
        applyPalmWheelFromUv(palmMenuLastUv.x, palmMenuLastUv.y);
      }
    }
    handleGridSnapTogglePinch(frame);
    handleBlockModePinch(frame);
    updateRingGridSnapIndicatorSprites();
  }

  if (
    grabMode === "none" &&
    prevGrabModeForSketchar !== "none" &&
    sketcharPollDeferred
  ) {
    void flushSketcharRemote();
  }
  prevGrabModeForSketchar = grabMode;

  updateHudFollow(time, frame);
  tickHudAppearState(performance.now());
  updateHudClock();

  if (grid3dGroupRef) {
    grid3dGroupRef.visible = snapToGridEnabled;
    updateGridDotsInkUniform();
  }

  if (frame && renderer.xr.isPresenting && sketcharBroadcast && sketcharRoomRealtime) {
    const t = performance.now();
    if (t - lastSketcharPresenceSendMs >= SKETCHAR_PRESENCE_SEND_MS) {
      lastSketcharPresenceSendMs = t;
      const refSpace = renderer.xr.getReferenceSpace();
      if (refSpace) {
        const pose = frame.getViewerPose(refSpace);
        if (pose) {
          strokesGroup.updateMatrixWorld(true);
          strokesGroup.getWorldQuaternion(_strokesWorldQuatForPresence);
          const p = pose.transform.position;
          _questHeadWorld.set(p.x, p.y, p.z);
          strokesGroup.worldToLocal(_questHeadLocal.copy(_questHeadWorld));
          const o = pose.transform.orientation;
          /** @type {{ deviceId: string, label: string, mode: "xr_head", x: number, y: number, z: number, qx?: number, qy?: number, qz?: number, qw?: number, sx?: number, sy?: number, sz?: number, sqx?: number, sqy?: number, sqz?: number, sqw?: number, lf?: number[], rf?: number[] }} */
          const payload = {
            deviceId: sketcharDeviceId,
            label: defaultPresenceLabel(),
            mode: "xr_head",
            x: _questHeadLocal.x,
            y: _questHeadLocal.y,
            z: _questHeadLocal.z,
          };
          if (o) {
            _questHeadQuatWorld.set(o.x, o.y, o.z, o.w).normalize();
            _questHeadLocalQuat
              .copy(_strokesWorldQuatForPresence)
              .invert()
              .multiply(_questHeadQuatWorld);
            payload.qx = _questHeadLocalQuat.x;
            payload.qy = _questHeadLocalQuat.y;
            payload.qz = _questHeadLocalQuat.z;
            payload.qw = _questHeadLocalQuat.w;
          }
          if (stylus) {
            stylus.getWorldPosition(_stylusWorld);
            strokesGroup.worldToLocal(_stylusLocal.copy(_stylusWorld));
            payload.sx = _stylusLocal.x;
            payload.sy = _stylusLocal.y;
            payload.sz = _stylusLocal.z;
            stylus.getWorldQuaternion(_stylusQuatWorld);
            _stylusLocalQuat
              .copy(_strokesWorldQuatForPresence)
              .invert()
              .multiply(_stylusQuatWorld);
            payload.sqx = _stylusLocalQuat.x;
            payload.sqy = _stylusLocalQuat.y;
            payload.sqz = _stylusLocalQuat.z;
            payload.sqw = _stylusLocalQuat.w;
          }

          const session = renderer.xr.getSession();
          if (session) {
            for (const inputSource of session.inputSources) {
              if (!inputSource.hand) continue;
              if (inputSource.handedness !== "left" && inputSource.handedness !== "right") continue;
              const chunk = [];
              let ok = true;
              for (let fi = 0; fi < PRESENCE_STREAM_FINGER_JOINTS.length; fi++) {
                const joint = inputSource.hand.get(PRESENCE_STREAM_FINGER_JOINTS[fi]);
                if (!joint) {
                  ok = false;
                  break;
                }
                const tipPose = frame.getPose(joint, refSpace);
                if (!tipPose) {
                  ok = false;
                  break;
                }
                const tp = tipPose.transform.position;
                _tipWorld.set(tp.x, tp.y, tp.z);
                strokesGroup.worldToLocal(_tipLocal.copy(_tipWorld));
                chunk.push(_tipLocal.x, _tipLocal.y, _tipLocal.z);
              }
              if (!ok || chunk.length !== 15) continue;
              if (inputSource.handedness === "left") {
                payload.lf = chunk;
              } else {
                payload.rf = chunk;
              }
            }
          }

          sketcharRoomRealtime.sendPresence(payload);
        }
      }
    }
  }

  if (sketcharRemotePeers.size > 0) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastPresenceSmoothMs) / 1000);
    lastPresenceSmoothMs = now;
    smoothPresencePeers(sketcharRemotePeers, dt);
    remotePresenceGroup.visible = sketcharShowOthers;
    pruneStalePresencePeers(sketcharRemotePeers, now, 6000);
  }

  {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastSceneNetworkSmoothMs) / 1000);
    lastSceneNetworkSmoothMs = now;
    smoothSceneNetworkTransforms(strokesGroup, dt, {
      lambda: 14,
      isLocalAuthority: sceneNetworkIsLocalAuthority,
    });
  }

  renderer.render(scene, camera);
}

function handleDrawing(controller) {
  if (!controller || !currentStrokePainter) return;

  const userData = controller.userData;

  if (gamepad1) {
    _snapNext.copy(stylus.position);
    if (snapToGridEnabled) {
      snapWorldPointToGrid(_snapNext);
      applyDraftSnapConstraint(_snapNext, _lastStrokeSnapWorld, _snapNext);
    }

    if (isDrawing) {
      const w = getPressureStrokeWidth();
      if (snapToGridEnabled) {
        emitManhattanSnapSegments(currentStrokePainter, w, _lastStrokeSnapWorld, _snapNext);
      } else {
        cursor.copy(_snapNext);
        const maxSteps = STROKE_MAX_POINTS - currentStrokePointsLocal.length;
        if (maxSteps <= 0) {
          return;
        }
        if (
          currentStrokePointsLocal.length > 0 &&
          cursor.distanceToSquared(_lastStrokeSampleWorld) < STROKE_MIN_SAMPLE_DIST_SQ
        ) {
          return;
        }
        const preW =
          currentStrokeWidthsLocal.length > 0
            ? currentStrokeWidthsLocal[currentStrokeWidthsLocal.length - 1]
            : w;
        _strokeFreeformFromWorld.copy(_lastStrokeSampleWorld);
        const d = cursor.distanceTo(_strokeFreeformFromWorld);
        let steps = Math.max(1, Math.ceil(d / STROKE_FREEFORM_MAX_SEGMENT_M));
        steps = Math.min(steps, maxSteps);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          _strokeInterpWorld.lerpVectors(_strokeFreeformFromWorld, cursor, t);
          const wi = preW + (w - preW) * t;
          currentStrokePainter.setSize(wi);
          currentStrokePainter.mesh.userData.strokeWidth = wi;
          strokeMeshLocalFromWorld(_strokeMeshLocal, _strokeInterpWorld);
          currentStrokePainter.lineTo(_strokeMeshLocal);
          currentStrokePainter.update();
          appendStrokePointWorld(_strokeInterpWorld, wi);
          _lastStrokeSampleWorld.copy(_strokeInterpWorld);
        }
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
