import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";

const DEVICE_ID_KEY = "sketchar_device_id";
const SHOW_OTHERS_KEY = "sketchar_show_others";

/** Served from Vite `static/` → site root. */
export const SKETCHAR_PRESENCE_HEAD_GLB_URL = "/3d-models/meta_quest_3-compressed.glb";
export const SKETCHAR_PRESENCE_STYLUS_GLB_URL = "/3d-models/logitech_mx_ink.glb";

/** Normalized headset model: largest bbox dimension (meters). */
const HEAD_MODEL_TARGET_MAX_DIM_M = 0.09;

/** Normalized MX Ink model: largest bbox dimension (meters). */
const STYLUS_MODEL_TARGET_MAX_DIM_M = 0.07;

/** Desktop/preview viewer frustum marker: square pyramid (cone with 4 segments), wireframe. */
const VIEWER_FRUSTUM_H = 0.42;
const VIEWER_FRUSTUM_R = 0.1;
const VIEWER_FRUSTUM_SEGMENTS = 4;

/** Align MX Ink GLB to tracked pose: 180° about Y. */
const STYLUS_MODEL_FIX_QUAT = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  Math.PI,
);

/** Align GLB to tracked head pose: 180° about Y. */
const HEAD_MODEL_FIX_QUAT = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  Math.PI,
);

/** @typedef {"xr_head"|"viewer_camera"} SketcharPresenceMode */

/**
 * @typedef {{
 *   deviceId: string,
 *   label: string,
 *   mode: SketcharPresenceMode,
 *   x: number, y: number, z: number,
 *   qx?: number, qy?: number, qz?: number, qw?: number,
 *   sx?: number, sy?: number, sz?: number,
 *   sqx?: number, sqy?: number, sqz?: number, sqw?: number,
 *   followActive?: boolean
 * }} SketcharPresencePayload
 */

/** @type {THREE.Group | null} */
let presenceHeadTemplateRoot = null;
let presenceHeadLoadPromise = /** @type {Promise<void> | null} */ (null);

/** @type {THREE.Group | null} */
let presenceStylusTemplateRoot = null;
let presenceStylusLoadPromise = /** @type {Promise<void> | null} */ (null);

const _stylusDelta = new THREE.Vector3();
const _qHeadInvStylus = new THREE.Quaternion();
const _qsRel = new THREE.Quaternion();
const _presenceLerpCompTarget = new THREE.Vector3();

/**
 * @param {SketcharPresencePayload} p
 */
function hasStylusPayload(p) {
  return (
    p.mode === "xr_head" &&
    Number.isFinite(p.sx) &&
    Number.isFinite(p.sy) &&
    Number.isFinite(p.sz)
  );
}

/**
 * Presence GLB (head + stylus): fully opaque — no alpha blending, transmission, or alpha maps.
 * @param {THREE.Material} m
 */
function forcePresenceHeadMaterialOpaque(m) {
  if (!m) return;
  m.userData.presenceHeadOpaque = true;
  m.opacity = 1;
  m.transparent = false;
  m.alphaTest = 0;
  m.alphaMap = null;
  m.premultipliedAlpha = false;
  m.blending = THREE.NormalBlending;
  m.depthTest = true;
  m.depthWrite = true;
  if ("alphaToCoverage" in m) /** @type {THREE.Material & { alphaToCoverage?: boolean }} */ (m).alphaToCoverage = false;

  if (m instanceof THREE.MeshPhysicalMaterial) {
    m.transmission = 0;
    m.thickness = 0;
    m.transmissionMap = null;
    m.attenuationDistance = Infinity;
    m.clearcoat = 0;
    m.clearcoatMap = null;
    m.sheen = 0;
    m.sheenRoughness = 0;
    if (m.sheenColor) m.sheenColor.setRGB(0, 0, 0);
    m.specularIntensity = 1;
    m.ior = 1.5;
  }

  const texKeys = [
    "map",
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
    "emissiveMap",
    "bumpMap",
    "displacementMap",
    "clearcoatNormalMap",
    "specularMap",
    "specularIntensityMap",
  ];
  for (const key of texKeys) {
    if (key in m && /** @type {Record<string, unknown>} */ (m)[key]) {
      const tex = /** @type {THREE.Texture} */ (/** @type {Record<string, unknown>} */ (m)[key]);
      if (tex && typeof tex === "object" && "premultiplyAlpha" in tex) {
        tex.premultiplyAlpha = false;
      }
    }
  }
  m.needsUpdate = true;
}

/**
 * Disposes GPU resources under a peer group. Skips meshes marked `userData.presenceGpuShared`
 * (cloned from a shared GLB template so geometry/materials must not be freed per peer).
 * @param {THREE.Object3D} root
 */
export function disposePresencePeerSubtree(root) {
  root.traverse((o) => {
    if (o.userData.presenceGpuShared) return;
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && m.map) m.map.dispose();
        if (m) m.dispose();
      }
    }
  });
}

/**
 * Match preview [`applyViewerPresenceRenderHints`](viewer.js).
 * GLB head/stylus: depth test on so multi-material meshes sort correctly (draw-through disabled for those).
 * Sprites / other markers: depth test off so they stay readable.
 * @param {THREE.Object3D} root
 */
export function applyPresenceHeadMaterialHints(root) {
  root.traverse((o) => {
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
        if (m.userData.presenceHeadOpaque) {
          m.depthTest = true;
          m.depthWrite = true;
          m.opacity = 1;
          m.transparent = false;
          m.premultipliedAlpha = false;
          m.blending = THREE.NormalBlending;
        } else if (o instanceof THREE.Sprite) {
          m.depthTest = false;
          m.transparent = true;
        } else {
          m.depthTest = false;
          if (m.opacity !== undefined && m.opacity < 1) m.transparent = true;
        }
        m.needsUpdate = true;
      }
    }
  });
}

/**
 * Loads the Quest 3 GLB once and builds a template root for {@link clonePresenceHeadVisual}.
 * Safe to call multiple times; subsequent calls return the same promise.
 * @param {string} [url]
 * @returns {Promise<void>}
 */
export function preloadPresenceHeadModel(url = SKETCHAR_PRESENCE_HEAD_GLB_URL) {
  if (presenceHeadTemplateRoot) return Promise.resolve();
  if (presenceHeadLoadPromise) return presenceHeadLoadPromise;

  presenceHeadLoadPromise = new Promise((resolve, reject) => {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath("/draco/");
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    loader.load(
      url,
      (gltf) => {
        try {
          const root = new THREE.Group();
          root.name = "presence-head-template";
          const scene = gltf.scene;
          root.add(scene);

          const box = new THREE.Box3().setFromObject(root);
          const center = new THREE.Vector3();
          const size = new THREE.Vector3();
          box.getCenter(center);
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
          const s = HEAD_MODEL_TARGET_MAX_DIM_M / maxDim;
          root.scale.setScalar(s);
          box.setFromObject(root);
          box.getCenter(center);
          root.position.sub(center);

          root.quaternion.copy(HEAD_MODEL_FIX_QUAT);

          root.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.userData.presenceGpuShared = true;
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              for (const mat of mats) forcePresenceHeadMaterialOpaque(mat);
            }
          });

          presenceHeadTemplateRoot = root;
          resolve();
        } catch (e) {
          console.warn("[sketcharPresence] head model normalize failed", e);
          reject(e);
        }
      },
      undefined,
      (err) => {
        console.warn("[sketcharPresence] head GLB load failed — using orb fallback", err);
        presenceHeadLoadPromise = null;
        reject(err);
      },
    );
  });

  return presenceHeadLoadPromise;
}

/**
 * Loads the MX Ink GLB once for remote stylus visualization.
 * @param {string} [url]
 * @returns {Promise<void>}
 */
export function preloadPresenceStylusModel(url = SKETCHAR_PRESENCE_STYLUS_GLB_URL) {
  if (presenceStylusTemplateRoot) return Promise.resolve();
  if (presenceStylusLoadPromise) return presenceStylusLoadPromise;

  presenceStylusLoadPromise = new Promise((resolve, reject) => {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath("/draco/");
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);
    loader.load(
      url,
      (gltf) => {
        try {
          const root = new THREE.Group();
          root.name = "presence-stylus-template";
          const scene = gltf.scene;
          root.add(scene);

          const box = new THREE.Box3().setFromObject(root);
          const center = new THREE.Vector3();
          const size = new THREE.Vector3();
          box.getCenter(center);
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
          const s = STYLUS_MODEL_TARGET_MAX_DIM_M / maxDim;
          root.scale.setScalar(s);
          box.setFromObject(root);
          box.getCenter(center);
          root.position.sub(center);

          root.quaternion.copy(STYLUS_MODEL_FIX_QUAT);

          root.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.userData.presenceGpuShared = true;
              const mats = Array.isArray(o.material) ? o.material : [o.material];
              for (const mat of mats) forcePresenceHeadMaterialOpaque(mat);
            }
          });

          presenceStylusTemplateRoot = root;
          resolve();
        } catch (e) {
          console.warn("[sketcharPresence] stylus model normalize failed", e);
          reject(e);
        }
      },
      undefined,
      (err) => {
        console.warn("[sketcharPresence] stylus GLB load failed", err);
        presenceStylusLoadPromise = null;
        reject(err);
      },
    );
  });

  return presenceStylusLoadPromise;
}

/**
 * @param {THREE.Group} group
 */
function clonePresenceHeadVisual(group) {
  if (!presenceHeadTemplateRoot) return false;
  const head = /** @type {THREE.Group} */ (presenceHeadTemplateRoot.clone(true));
  head.name = "presence-head-gltf";
  group.add(head);
  applyPresenceHeadMaterialHints(head);
  return true;
}

/**
 * @param {THREE.Group} group
 */
function clonePresenceStylusVisual(group) {
  if (!presenceStylusTemplateRoot) return false;
  const pen = /** @type {THREE.Group} */ (presenceStylusTemplateRoot.clone(true));
  pen.name = "presence-stylus-gltf";
  group.add(pen);
  applyPresenceHeadMaterialHints(pen);
  return true;
}

/**
 * @param {THREE.Group} group
 */
function removePresenceStylusGltf(group) {
  const pen = group.getObjectByName("presence-stylus-gltf");
  if (pen) {
    group.remove(pen);
    pen.traverse((o) => {
      if (o.userData.presenceGpuShared) return;
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m && m.map) m.map.dispose();
          if (m) m.dispose();
        }
      }
    });
  }
}

/**
 * @param {THREE.Group} group
 */
function ensurePresenceStylusVisual(group) {
  if (!presenceStylusTemplateRoot) return;
  if (group.getObjectByName("presence-stylus-gltf")) return;
  clonePresenceStylusVisual(group);
}

/**
 * @param {THREE.Object3D | null} obj
 */
function removeAndDisposePresenceOrb(obj) {
  if (!obj) return;
  const parent = obj.parent;
  if (parent) parent.remove(obj);
  obj.traverse((o) => {
    if (o.userData.presenceGpuShared) return;
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && m.map) m.map.dispose();
        if (m) m.dispose();
      }
    }
  });
}

/**
 * @param {THREE.Group} group
 */
function removePresenceHeadGltf(group) {
  const head = group.getObjectByName("presence-head-gltf");
  if (head) {
    group.remove(head);
    head.traverse((o) => {
      if (o.userData.presenceGpuShared) return;
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m && m.map) m.map.dispose();
          if (m) m.dispose();
        }
      }
    });
  }
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

    const useGltf = presenceHeadTemplateRoot != null;
    const existingHead = group.getObjectByName("presence-head-gltf");

    if (useGltf) {
      if (!existingHead) {
        removeAndDisposePresenceOrb(sphere);
        if (label) {
          group.remove(label);
          label.traverse((o) => {
            if (o.material && o.material.map) o.material.map.dispose();
            if (o.material) o.material.dispose();
          });
        }
        clonePresenceHeadVisual(group);
      }
    } else {
      removePresenceHeadGltf(group);
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
    }

    if (hasStylusPayload(p)) {
      ensurePresenceStylusVisual(group);
    } else {
      removePresenceStylusGltf(group);
      group.userData.hasStylus = false;
    }
  } else {
    removePresenceStylusGltf(group);
    removePresenceHeadGltf(group);
    if (sphere) {
      group.remove(sphere);
      sphere.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    const h = VIEWER_FRUSTUM_H;
    const r = VIEWER_FRUSTUM_R;
    if (cone && cone.userData.presenceViewerWireframe !== true) {
      group.remove(cone);
      cone.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      cone = null;
    }
    if (!cone) {
      cone = new THREE.Mesh(
        new THREE.ConeGeometry(r, h, VIEWER_FRUSTUM_SEGMENTS),
        new THREE.MeshBasicMaterial({
          color: 0x44aaff,
          wireframe: true,
          depthTest: true,
        }),
      );
      cone.name = "presence-cone";
      cone.userData.presenceViewerWireframe = true;
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

/**
 * Rebuild orb/GLB/labels after the head model finishes loading.
 * @param {Map<string, THREE.Group>} peers
 */
export function refreshPresenceVisualsFromStoredPayload(peers) {
  for (const g of peers.values()) {
    const p = /** @type {SketcharPresencePayload | undefined} */ (g.userData.lastPresencePayload);
    if (p) ensurePresenceMeshes(p, g);
  }
}

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
    cone.position.copy(fwd).multiplyScalar(-VIEWER_FRUSTUM_H * 0.5);
  }
}

/** Hide desktop frustum + label when that client is in Quest follow mode (broadcast to Quest + others). */
function applyViewerCameraFollowVisibility(group, p) {
  if (p.mode !== "viewer_camera") return;
  const hide = p.followActive === true;
  const cone = group.getObjectByName("presence-cone");
  const label = group.getObjectByName("presence-label");
  if (cone) cone.visible = !hide;
  if (label) label.visible = !hide;
}

/**
 * Updates remote presence targets from a payload. Call each frame: {@link smoothPresencePeers}.
 * @param {SketcharPresencePayload} p
 * @param {THREE.Group} group
 */
export function setPresenceTargetsFromPayload(p, group) {
  group.userData.lastPresencePayload = p;

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
    group.userData.hasStylus = false;
    group.userData.hasStylusQuat = false;
    group.userData.targetStylusPos = null;
    group.userData.targetStylusQuat = null;
    group.userData.smoothStylusPos = null;
    group.userData.smoothStylusQuat = null;
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
    applyViewerCameraFollowVisibility(group, p);
  } else if (p.mode === "xr_head") {
    const haveQ =
      Number.isFinite(p.qx) &&
      Number.isFinite(p.qy) &&
      Number.isFinite(p.qz) &&
      Number.isFinite(p.qw);
    if (!group.userData.targetQuat) group.userData.targetQuat = new THREE.Quaternion();
    if (haveQ) {
      group.userData.targetQuat.set(p.qx, p.qy, p.qz, p.qw).normalize();
      group.userData.hasHeadQuat = true;
    } else {
      group.userData.hasHeadQuat = false;
    }

    if (!group.userData.presenceInitialized) {
      group.position.copy(group.userData.targetPos);
      if (haveQ) {
        group.quaternion.copy(group.userData.targetQuat);
      } else {
        group.quaternion.identity();
      }
      group.userData.presenceInitialized = true;
    }
    if (!haveQ) {
      group.quaternion.identity();
    }

    if (hasStylusPayload(p)) {
      if (!group.userData.targetStylusPos) group.userData.targetStylusPos = new THREE.Vector3();
      group.userData.targetStylusPos.set(
        /** @type {number} */ (p.sx),
        /** @type {number} */ (p.sy),
        /** @type {number} */ (p.sz),
      );
      const hasSq =
        Number.isFinite(p.sqx) &&
        Number.isFinite(p.sqy) &&
        Number.isFinite(p.sqz) &&
        Number.isFinite(p.sqw);
      if (hasSq) {
        if (!group.userData.targetStylusQuat) group.userData.targetStylusQuat = new THREE.Quaternion();
        group.userData.targetStylusQuat
          .set(
            /** @type {number} */ (p.sqx),
            /** @type {number} */ (p.sqy),
            /** @type {number} */ (p.sqz),
            /** @type {number} */ (p.sqw),
          )
          .normalize();
        group.userData.hasStylusQuat = true;
      } else {
        group.userData.hasStylusQuat = false;
      }
      group.userData.hasStylus = true;
    } else {
      group.userData.hasStylus = false;
      group.userData.hasStylusQuat = false;
      group.userData.targetStylusPos = null;
      group.userData.targetStylusQuat = null;
      group.userData.smoothStylusPos = null;
      group.userData.smoothStylusQuat = null;
    }
  }
}

/**
 * @param {THREE.Group} g
 */
function updatePresenceStylusChildTransform(g) {
  const child = g.getObjectByName("presence-stylus-gltf");
  if (!child || !g.userData.smoothStylusPos) {
    if (child) child.visible = false;
    return;
  }
  child.visible = true;
  const H = g.position;
  const qh = g.quaternion;
  const S = g.userData.smoothStylusPos;
  _stylusDelta.copy(S).sub(H);
  _qHeadInvStylus.copy(qh).invert();
  _stylusDelta.applyQuaternion(_qHeadInvStylus);
  child.position.copy(_stylusDelta);
  if (g.userData.hasStylusQuat && g.userData.smoothStylusQuat) {
    _qsRel.copy(_qHeadInvStylus).multiply(g.userData.smoothStylusQuat);
    child.quaternion.copy(_qsRel).multiply(STYLUS_MODEL_FIX_QUAT);
  } else {
    child.quaternion.copy(STYLUS_MODEL_FIX_QUAT);
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
 * @param {number} [positionScaleCompensation] Multiply network-space targets by this before lerping (e.g. 1/remotePresenceGroup.scale when parent is scaled).
 */
export function smoothPresencePeers(peers, deltaSec, lambda = 14, positionScaleCompensation = 1) {
  const a = expSmoothFactor(deltaSec, lambda);
  const c = positionScaleCompensation;
  for (const g of peers.values()) {
    if (!g.userData.presenceInitialized || !g.userData.targetPos) continue;
    _presenceLerpCompTarget.copy(g.userData.targetPos).multiplyScalar(c);
    g.position.lerp(_presenceLerpCompTarget, a);
    if (g.userData.mode === "viewer_camera" && g.userData.smoothFwd && g.userData.targetFwd) {
      g.userData.smoothFwd.lerp(g.userData.targetFwd, a).normalize();
      applyConeOrientationToGroup(g, g.userData.smoothFwd);
    }
    if (
      g.userData.mode === "xr_head" &&
      g.userData.hasHeadQuat &&
      g.userData.targetQuat
    ) {
      g.quaternion.slerp(g.userData.targetQuat, a);
    }
    if (
      g.userData.mode === "xr_head" &&
      g.userData.hasStylus &&
      g.userData.targetStylusPos
    ) {
      if (!g.userData.smoothStylusPos) {
        g.userData.smoothStylusPos = new THREE.Vector3().copy(g.userData.targetStylusPos).multiplyScalar(c);
        g.userData.smoothStylusQuat = new THREE.Quaternion();
        if (g.userData.hasStylusQuat && g.userData.targetStylusQuat) {
          g.userData.smoothStylusQuat.copy(g.userData.targetStylusQuat);
        } else {
          g.userData.smoothStylusQuat.identity();
        }
      } else {
        _presenceLerpCompTarget.copy(g.userData.targetStylusPos).multiplyScalar(c);
        g.userData.smoothStylusPos.lerp(_presenceLerpCompTarget, a);
        if (g.userData.hasStylusQuat && g.userData.targetStylusQuat) {
          g.userData.smoothStylusQuat.slerp(g.userData.targetStylusQuat, a);
        }
      }
      updatePresenceStylusChildTransform(g);
    } else {
      const pen = g.getObjectByName("presence-stylus-gltf");
      if (pen) pen.visible = false;
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
      disposePresencePeerSubtree(g);
      peers.delete(id);
    }
  }
}
