import * as THREE from "three";

const DEVICE_ID_KEY = "sketchar_device_id";
const SHOW_OTHERS_KEY = "sketchar_show_others";

/** @typedef {"xr_head"|"viewer_camera"} SketcharPresenceMode */

/**
 * @typedef {{
 *   deviceId: string,
 *   label: string,
 *   mode: SketcharPresenceMode,
 *   x: number, y: number, z: number,
 *   qx?: number, qy?: number, qz?: number, qw?: number
 * }} SketcharPresencePayload
 */

export function getOrCreateDeviceId() {
  try {
    let id = sessionStorage.getItem(DEVICE_ID_KEY);
    if (!id || typeof id !== "string") {
      id =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
      sessionStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return `d_${Date.now().toString(36)}`;
  }
}

export function getShowOthersPreference() {
  try {
    const v = localStorage.getItem(SHOW_OTHERS_KEY);
    if (v === null) return true;
    return v === "1" || v === "true";
  } catch {
    return true;
  }
}

export function setShowOthersPreference(on) {
  try {
    localStorage.setItem(SHOW_OTHERS_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function defaultPresenceLabel() {
  const ua = navigator.userAgent || "";
  if (/Quest|OculusBrowser/i.test(ua)) return "Quest";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Mobile/i.test(ua)) return "Mobile";
  return "Desktop";
}

/**
 * @param {string} text
 * @param {number} colorHex
 */
function makeLabelSprite(text, colorHex) {
  const pad = 8;
  const font = 28;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = font + pad * 2;
  canvas.width = w;
  canvas.height = h;
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  ctx.fillStyle = `rgba(${(colorHex >> 16) & 0xff},${(colorHex >> 8) & 0xff},${colorHex & 0xff},0.92)`;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#0d0f14";
  ctx.fillText(text, pad, font + pad / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
  const sprite = new THREE.Sprite(mat);
  const sc = 0.0045;
  sprite.scale.set(w * sc, h * sc, 1);
  return sprite;
}

/**
 * @param {SketcharPresencePayload} p
 * @param {THREE.Group} group
 */
function ensurePresenceMeshes(p, group) {
  const mode = p.mode;
  let sphere = group.getObjectByName("presence-sphere");
  let cone = group.getObjectByName("presence-cone");
  let label = group.getObjectByName("presence-label");

  if (mode === "xr_head") {
    if (cone) {
      group.remove(cone);
      cone.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    if (!sphere) {
      sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 20, 20),
        new THREE.MeshBasicMaterial({ color: 0xff8800, depthTest: true }),
      );
      sphere.name = "presence-sphere";
      group.add(sphere);
    }
    if (label) {
      group.remove(label);
      label.traverse((o) => {
        if (o.material && o.material.map) o.material.map.dispose();
        if (o.material) o.material.dispose();
      });
    }
    const spr = makeLabelSprite(p.label || "Quest", 0xff8800);
    if (spr) {
      spr.name = "presence-label";
      spr.position.set(0, 0.16, 0);
      group.add(spr);
    }
  } else {
    if (sphere) {
      group.remove(sphere);
      sphere.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    const h = 0.42;
    const r = 0.1;
    if (!cone) {
      cone = new THREE.Mesh(
        new THREE.ConeGeometry(r, h, 12),
        new THREE.MeshBasicMaterial({
          color: 0x44aaff,
          transparent: true,
          opacity: 0.88,
          depthTest: true,
        }),
      );
      cone.name = "presence-cone";
      group.add(cone);
    }
    if (label) {
      group.remove(label);
      label.traverse((o) => {
        if (o.material && o.material.map) o.material.map.dispose();
        if (o.material) o.material.dispose();
      });
    }
    const spr = makeLabelSprite(p.label || "Viewer", 0x44aaff);
    if (spr) {
      spr.name = "presence-label";
      spr.position.set(0, 0.22, 0);
      group.add(spr);
    }
  }
}

const _yAxis = new THREE.Vector3(0, 1, 0);
const _qAlign = new THREE.Quaternion();
const _fwdWork = new THREE.Vector3();

/**
 * @param {THREE.Group} group
 * @param {THREE.Vector3} fwd
 */
function applyConeOrientationToGroup(group, fwd) {
  const cone = group.getObjectByName("presence-cone");
  _qAlign.setFromUnitVectors(_yAxis, fwd);
  if (cone) {
    cone.quaternion.copy(_qAlign);
    const hh = 0.42;
    cone.position.copy(fwd).multiplyScalar(-hh * 0.5);
  }
}

/**
 * Updates remote presence targets from a payload. Call each frame: {@link smoothPresencePeers}.
 * @param {SketcharPresencePayload} p
 * @param {THREE.Group} group
 */
export function setPresenceTargetsFromPayload(p, group) {
  const prevMode = group.userData.presenceMode;
  if (prevMode !== p.mode) {
    group.userData.presenceInitialized = false;
    group.userData.presenceMode = p.mode;
  }

  ensurePresenceMeshes(p, group);

  if (!group.userData.targetPos) group.userData.targetPos = new THREE.Vector3();
  group.userData.targetPos.set(p.x, p.y, p.z);
  group.userData.mode = p.mode;

  if (p.mode === "viewer_camera") {
    const qw = p.qw ?? 1;
    const qx = p.qx ?? 0;
    const qy = p.qy ?? 0;
    const qz = p.qz ?? 0;
    const haveQ =
      Number.isFinite(p.qx) &&
      Number.isFinite(p.qy) &&
      Number.isFinite(p.qz) &&
      Number.isFinite(p.qw);
    if (!group.userData.targetFwd) group.userData.targetFwd = new THREE.Vector3();
    if (!group.userData.smoothFwd) group.userData.smoothFwd = new THREE.Vector3();
    if (haveQ) {
      const ql = new THREE.Quaternion(qx, qy, qz, qw).normalize();
      _fwdWork.set(0, 0, -1).applyQuaternion(ql);
      if (_fwdWork.lengthSq() < 1e-8) _fwdWork.set(0, 0, -1);
      _fwdWork.normalize();
      /** Match remote camera look direction (negate fixes inverted cone on receivers). */
      _fwdWork.negate();
      group.userData.targetFwd.copy(_fwdWork);
    } else if (group.userData.targetFwd.lengthSq() < 1e-8) {
      group.userData.targetFwd.set(0, 0, -1);
    }

    if (!group.userData.presenceInitialized) {
      group.position.copy(group.userData.targetPos);
      group.userData.smoothFwd.copy(group.userData.targetFwd);
      applyConeOrientationToGroup(group, group.userData.smoothFwd);
      group.userData.presenceInitialized = true;
    }
  } else {
    if (!group.userData.presenceInitialized) {
      group.position.copy(group.userData.targetPos);
      group.userData.presenceInitialized = true;
    }
    group.quaternion.identity();
  }
}

function expSmoothFactor(deltaSec, lambda) {
  const d = Math.max(0, deltaSec);
  return 1 - Math.exp(-lambda * d);
}

/**
 * @param {Map<string, THREE.Group>} peers
 * @param {number} deltaSec
 * @param {number} [lambda]
 */
export function smoothPresencePeers(peers, deltaSec, lambda = 14) {
  const a = expSmoothFactor(deltaSec, lambda);
  for (const g of peers.values()) {
    if (!g.userData.presenceInitialized || !g.userData.targetPos) continue;
    g.position.lerp(g.userData.targetPos, a);
    if (g.userData.mode === "viewer_camera" && g.userData.smoothFwd && g.userData.targetFwd) {
      g.userData.smoothFwd.lerp(g.userData.targetFwd, a).normalize();
      applyConeOrientationToGroup(g, g.userData.smoothFwd);
    }
  }
}

/**
 * @param {Map<string, THREE.Group>} peers
 * @param {number} nowMs
 * @param {number} maxAgeMs
 */
export function pruneStalePresencePeers(peers, nowMs, maxAgeMs) {
  for (const [id, g] of peers) {
    const t = /** @type {number} */ (g.userData.lastMs);
    if (typeof t === "number" && nowMs - t > maxAgeMs) {
      g.parent?.remove(g);
      g.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
      peers.delete(id);
    }
  }
}
