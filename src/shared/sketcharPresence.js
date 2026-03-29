import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { HTMLMesh } from "../misc/HTMLMesh.js";

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

/** Inner group: network-smoothed content; peer root holds layout offset slot (unused when not host-moving previews). */
const PRESENCE_NETWORK_NAME = "presence-network";

/** Multi-material meshes use `material[]`; calling `.dispose()` on the array throws. */
function disposeMaterialsSafe(m) {
  if (!m) return;
  const mats = Array.isArray(m) ? m : [m];
  for (const x of mats) {
    if (!x || typeof x.dispose !== "function") continue;
    if (x.map) x.map.dispose();
    x.dispose();
  }
}

/**
 * HTMLMesh plane uses 0.001 m per CSS px; legacy sprite used 0.0045 * px — target 1/4 sprite world size.
 * @see makeLabelSprite scale `sc`
 */
const PRESENCE_VIEWER_LABEL_HTML_SCALE = 0.25 * (0.0045 / 0.001);

/** @type {import("three").WebGLRenderer | null} */
let presenceLabelRenderer = null;

/**
 * Optional: anisotropy for presence HTMLMesh labels (call from main XR init).
 * @param {import("three").WebGLRenderer | null} r
 */
export function setPresenceLabelRenderer(r) {
  presenceLabelRenderer = r;
}

/**
 * Ensures `peerRoot` has a `presence-network` child holding all meshes; migrates legacy flat peers.
 * @param {THREE.Group} peerRoot
 * @returns {THREE.Group}
 */
export function ensurePresenceNetworkGroup(peerRoot) {
  const existing = /** @type {THREE.Group | undefined} */ (peerRoot.userData.networkSync);
  if (existing && existing.parent === peerRoot && existing.name === PRESENCE_NETWORK_NAME) {
    return existing;
  }
  for (let i = 0; i < peerRoot.children.length; i++) {
    const ch = peerRoot.children[i];
    if (ch.name === PRESENCE_NETWORK_NAME && ch instanceof THREE.Group) {
      peerRoot.userData.networkSync = ch;
      return ch;
    }
  }
  const net = new THREE.Group();
  net.name = PRESENCE_NETWORK_NAME;
  peerRoot.userData.networkSync = net;
  while (peerRoot.children.length > 0) {
    net.add(peerRoot.children[0]);
  }
  peerRoot.add(net);
  return net;
}

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
 *   lf?: number[],
 *   rf?: number[],
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

/** Five tips × xyz in stroke space (thumb → pinky), matches Quest finger-debug colors. */
const PRESENCE_FINGER_TIP_COLORS = [0xff4444, 0x44ff44, 0x4444ff, 0xffff44, 0xff44ff];

/** @type {THREE.SphereGeometry | null} */
let _presenceFingerSphereGeom = null;

function getPresenceFingerSphereGeometry() {
  if (!_presenceFingerSphereGeom) {
    _presenceFingerSphereGeom = new THREE.SphereGeometry(0.012, 10, 10);
  }
  return _presenceFingerSphereGeom;
}

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
 * @param {unknown} arr
 * @returns {boolean}
 */
function isFingerTipArray15(arr) {
  if (!Array.isArray(arr) || arr.length < 15) return false;
  for (let i = 0; i < 15; i++) {
    if (!Number.isFinite(Number(arr[i]))) return false;
  }
  return true;
}

/**
 * @param {SketcharPresencePayload} p
 */
function hasLeftFingerTipsPayload(p) {
  return p.mode === "xr_head" && isFingerTipArray15(p.lf);
}

/**
 * @param {SketcharPresencePayload} p
 */
function hasRightFingerTipsPayload(p) {
  return p.mode === "xr_head" && isFingerTipArray15(p.rf);
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
    if (o.userData.presenceLabelHtmlMesh && typeof o.dispose === "function") {
      o.dispose();
      return;
    }
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
 * @param {THREE.Object3D} root
 */
function markPresenceGltfMeshesCastShadow(root) {
  root.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
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
  markPresenceGltfMeshesCastShadow(head);
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
  markPresenceGltfMeshesCastShadow(pen);
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
 * @param {THREE.Group} group
 * @param {"left"|"right"} side
 */
function ensurePresenceFingerSphereGroup(group, side) {
  const name = `presence-fingers-${side}`;
  if (group.getObjectByName(name)) return;
  const parent = new THREE.Group();
  parent.name = name;
  parent.visible = false;
  const geom = getPresenceFingerSphereGeometry();
  for (let i = 0; i < 5; i++) {
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({
        color: PRESENCE_FINGER_TIP_COLORS[i],
        depthTest: true,
        toneMapped: false,
      }),
    );
    mesh.name = `presence-finger-${i}`;
    parent.add(mesh);
  }
  group.add(parent);
}

/**
 * @param {THREE.Group} group
 */
function ensurePresenceFingerProxies(group) {
  ensurePresenceFingerSphereGroup(group, "left");
  ensurePresenceFingerSphereGroup(group, "right");
}

/**
 * @param {THREE.Group} group
 */
function removePresenceFingerProxies(group) {
  for (const side of ["left", "right"]) {
    const h = group.getObjectByName(`presence-fingers-${side}`);
    if (!h) continue;
    group.remove(h);
    h.traverse((o) => {
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
        disposeMaterialsSafe(o.material);
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
            disposeMaterialsSafe(o.material);
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
          disposeMaterialsSafe(o.material);
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
    ensurePresenceFingerProxies(group);
  } else {
    removePresenceStylusGltf(group);
    removePresenceFingerProxies(group);
    removePresenceHeadGltf(group);
    if (sphere) {
      group.remove(sphere);
      sphere.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        disposeMaterialsSafe(o.material);
      });
    }
    const h = VIEWER_FRUSTUM_H;
    const r = VIEWER_FRUSTUM_R;
    if (cone && cone.userData.presenceViewerWireframe !== true) {
      group.remove(cone);
      cone.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        disposeMaterialsSafe(o.material);
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
      if (label.userData.presenceLabelHtmlMesh && typeof label.dispose === "function") {
        label.dispose();
      } else {
        label.traverse((o) => {
          disposeMaterialsSafe(o.material);
        });
      }
    }
    const lab = makeViewerPresenceLabelHtmlMesh(p.label || "Viewer", 0x44aaff);
    if (lab) {
      lab.name = "presence-label";
      group.add(lab);
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
    if (p) ensurePresenceMeshes(p, ensurePresenceNetworkGroup(g));
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
 * Wrist-panel–style label (HTMLMesh + system-ui 12px) for viewer_camera frustums; rounded rect, ~4× smaller than legacy sprite.
 * @param {string} text
 * @param {number} colorHex
 * @returns {InstanceType<typeof HTMLMesh> | null}
 */
function makeViewerPresenceLabelHtmlMesh(text, colorHex) {
  const div = document.createElement("div");
  div.setAttribute("lang", "en");
  const r = (colorHex >> 16) & 0xff;
  const g = (colorHex >> 8) & 0xff;
  const b = colorHex & 0xff;
  div.style.cssText = [
    "box-sizing:border-box",
    "display:inline-block",
    "font:12px/1.35 system-ui,sans-serif",
    "padding:4px 10px",
    "border-radius:8px",
    "white-space:nowrap",
    `background:rgba(${r},${g},${b},0.92)`,
    "color:#0d0f14",
    `border:1px solid rgba(${Math.min(255, r + 50)},${Math.min(255, g + 50)},${Math.min(255, b + 50)},0.5)`,
  ].join(";");
  div.textContent = text;

  const mesh = new HTMLMesh(div);
  mesh.name = "presence-label";
  mesh.userData.presenceLabelHtmlMesh = true;
  mesh.scale.setScalar(PRESENCE_VIEWER_LABEL_HTML_SCALE);
  const map = mesh.material.map;
  if (map && presenceLabelRenderer) {
    map.anisotropy = Math.min(16, presenceLabelRenderer.capabilities.getMaxAnisotropy());
  }
  mesh.position.set(0, 0.22, 0);
  return mesh;
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
  if (
    !fwd ||
    !Number.isFinite(fwd.x) ||
    !Number.isFinite(fwd.y) ||
    !Number.isFinite(fwd.z) ||
    fwd.lengthSq() < 1e-12
  ) {
    return;
  }
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
 * @param {THREE.Group} peerRoot Outer group (layout offset); inner `presence-network` holds smoothed network pose.
 */
export function setPresenceTargetsFromPayload(p, peerRoot) {
  peerRoot.userData.lastPresencePayload = p;
  peerRoot.userData.mode = p.mode;

  const net = ensurePresenceNetworkGroup(peerRoot);

  const prevMode = peerRoot.userData.presenceMode;
  if (prevMode !== p.mode) {
    net.userData.presenceInitialized = false;
    peerRoot.userData.presenceMode = p.mode;
  }

  ensurePresenceMeshes(p, net);

  if (!net.userData.targetPos) net.userData.targetPos = new THREE.Vector3();
  net.userData.targetPos.set(p.x, p.y, p.z);

  if (p.mode === "viewer_camera") {
    net.userData.hasStylus = false;
    net.userData.hasStylusQuat = false;
    net.userData.targetStylusPos = null;
    net.userData.targetStylusQuat = null;
    net.userData.smoothStylusPos = null;
    net.userData.smoothStylusQuat = null;
    net.userData.hasLeftFingerTips = false;
    net.userData.targetLeftFingerTips = null;
    net.userData.smoothLeftFingerTips = null;
    net.userData.hasRightFingerTips = false;
    net.userData.targetRightFingerTips = null;
    net.userData.smoothRightFingerTips = null;
    const qw = p.qw ?? 1;
    const qx = p.qx ?? 0;
    const qy = p.qy ?? 0;
    const qz = p.qz ?? 0;
    const haveQ =
      Number.isFinite(p.qx) &&
      Number.isFinite(p.qy) &&
      Number.isFinite(p.qz) &&
      Number.isFinite(p.qw);
    if (!net.userData.targetFwd) net.userData.targetFwd = new THREE.Vector3();
    if (!net.userData.smoothFwd) net.userData.smoothFwd = new THREE.Vector3();
    if (haveQ) {
      const ql = new THREE.Quaternion(qx, qy, qz, qw).normalize();
      _fwdWork.set(0, 0, -1).applyQuaternion(ql);
      if (_fwdWork.lengthSq() < 1e-8) _fwdWork.set(0, 0, -1);
      _fwdWork.normalize();
      /** Match remote camera look direction (negate fixes inverted cone on receivers). */
      _fwdWork.negate();
      net.userData.targetFwd.copy(_fwdWork);
    } else if (net.userData.targetFwd.lengthSq() < 1e-8) {
      net.userData.targetFwd.set(0, 0, -1);
    }

    if (!net.userData.presenceInitialized) {
      net.position.copy(net.userData.targetPos);
      net.userData.smoothFwd.copy(net.userData.targetFwd);
      applyConeOrientationToGroup(net, net.userData.smoothFwd);
      net.userData.presenceInitialized = true;
    }
    applyViewerCameraFollowVisibility(net, p);
  } else if (p.mode === "xr_head") {
    const haveQ =
      Number.isFinite(p.qx) &&
      Number.isFinite(p.qy) &&
      Number.isFinite(p.qz) &&
      Number.isFinite(p.qw);
    if (!net.userData.targetQuat) net.userData.targetQuat = new THREE.Quaternion();
    if (haveQ) {
      net.userData.targetQuat.set(p.qx, p.qy, p.qz, p.qw).normalize();
      net.userData.hasHeadQuat = true;
    } else {
      net.userData.hasHeadQuat = false;
    }

    if (!net.userData.presenceInitialized) {
      net.position.copy(net.userData.targetPos);
      if (haveQ) {
        net.quaternion.copy(net.userData.targetQuat);
      } else {
        net.quaternion.identity();
      }
      net.userData.presenceInitialized = true;
    }
    if (!haveQ) {
      net.quaternion.identity();
    }

    if (hasStylusPayload(p)) {
      if (!net.userData.targetStylusPos) net.userData.targetStylusPos = new THREE.Vector3();
      net.userData.targetStylusPos.set(
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
        if (!net.userData.targetStylusQuat) net.userData.targetStylusQuat = new THREE.Quaternion();
        net.userData.targetStylusQuat
          .set(
            /** @type {number} */ (p.sqx),
            /** @type {number} */ (p.sqy),
            /** @type {number} */ (p.sqz),
            /** @type {number} */ (p.sqw),
          )
          .normalize();
        net.userData.hasStylusQuat = true;
      } else {
        net.userData.hasStylusQuat = false;
      }
      net.userData.hasStylus = true;
    } else {
      net.userData.hasStylus = false;
      net.userData.hasStylusQuat = false;
      net.userData.targetStylusPos = null;
      net.userData.targetStylusQuat = null;
      net.userData.smoothStylusPos = null;
      net.userData.smoothStylusQuat = null;
    }

    if (hasLeftFingerTipsPayload(p)) {
      const src = /** @type {number[]} */ (p.lf);
      if (!net.userData.targetLeftFingerTips) net.userData.targetLeftFingerTips = new Array(15);
      for (let i = 0; i < 15; i++) {
        net.userData.targetLeftFingerTips[i] = Number(src[i]);
      }
      net.userData.hasLeftFingerTips = true;
    } else {
      net.userData.hasLeftFingerTips = false;
      net.userData.targetLeftFingerTips = null;
      net.userData.smoothLeftFingerTips = null;
    }

    if (hasRightFingerTipsPayload(p)) {
      const src = /** @type {number[]} */ (p.rf);
      if (!net.userData.targetRightFingerTips) net.userData.targetRightFingerTips = new Array(15);
      for (let i = 0; i < 15; i++) {
        net.userData.targetRightFingerTips[i] = Number(src[i]);
      }
      net.userData.hasRightFingerTips = true;
    } else {
      net.userData.hasRightFingerTips = false;
      net.userData.targetRightFingerTips = null;
      net.userData.smoothRightFingerTips = null;
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

/**
 * @param {THREE.Group} g
 * @param {"left"|"right"} side
 * @param {THREE.Vector3[] | null} tips
 */
function updatePresenceFingerTipsGroupTransform(g, side, tips) {
  const grp = g.getObjectByName(`presence-fingers-${side}`);
  if (!grp || !tips || tips.length !== 5) {
    if (grp) grp.visible = false;
    return;
  }
  grp.visible = true;
  const H = g.position;
  const qh = g.quaternion;
  for (let i = 0; i < 5; i++) {
    const child = grp.children[i];
    if (!child) continue;
    const S = tips[i];
    _stylusDelta.copy(S).sub(H);
    _qHeadInvStylus.copy(qh).invert();
    _stylusDelta.applyQuaternion(_qHeadInvStylus);
    child.position.copy(_stylusDelta);
    child.quaternion.identity();
  }
}

function expSmoothFactor(deltaSec, lambda) {
  const d = Math.max(0, deltaSec);
  return 1 - Math.exp(-lambda * d);
}

/** @param {THREE.Quaternion} q */
function presenceQuatFinite(q) {
  return (
    Number.isFinite(q.x) &&
    Number.isFinite(q.y) &&
    Number.isFinite(q.z) &&
    Number.isFinite(q.w) &&
    q.lengthSq() > 1e-20
  );
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
  for (const [deviceId, peerRoot] of peers) {
    const g = ensurePresenceNetworkGroup(peerRoot);
    if (typeof window !== "undefined" && window.__mxInkPresenceAssert) {
      let netChildren = 0;
      for (let ci = 0; ci < peerRoot.children.length; ci++) {
        if (peerRoot.children[ci].name === PRESENCE_NETWORK_NAME) netChildren++;
      }
      if (netChildren > 1) {
        console.warn("[mxink presence] multiple presence-network children on peer", deviceId, netChildren);
      }
    }
    if (!g.userData.presenceInitialized || !g.userData.targetPos) continue;
    const mode = peerRoot.userData.mode;
    _presenceLerpCompTarget.copy(g.userData.targetPos).multiplyScalar(c);
    g.position.lerp(_presenceLerpCompTarget, a);
    if (mode === "viewer_camera" && g.userData.smoothFwd && g.userData.targetFwd) {
      g.userData.smoothFwd.lerp(g.userData.targetFwd, a).normalize();
      applyConeOrientationToGroup(g, g.userData.smoothFwd);
    }
    if (mode === "xr_head" && g.userData.hasHeadQuat && g.userData.targetQuat) {
      g.quaternion.slerp(g.userData.targetQuat, a);
      if (!presenceQuatFinite(g.quaternion)) {
        g.quaternion.copy(g.userData.targetQuat);
      }
      if (presenceQuatFinite(g.quaternion)) {
        g.quaternion.normalize();
      } else {
        g.quaternion.identity();
      }
    }
    if (mode === "xr_head" && g.userData.hasStylus && g.userData.targetStylusPos) {
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
          if (!presenceQuatFinite(g.userData.smoothStylusQuat)) {
            g.userData.smoothStylusQuat.copy(g.userData.targetStylusQuat);
          }
          if (presenceQuatFinite(g.userData.smoothStylusQuat)) {
            g.userData.smoothStylusQuat.normalize();
          } else {
            g.userData.smoothStylusQuat.identity();
          }
        }
      }
      updatePresenceStylusChildTransform(g);
    } else {
      const pen = g.getObjectByName("presence-stylus-gltf");
      if (pen) pen.visible = false;
    }

    if (mode === "xr_head" && g.userData.hasLeftFingerTips && g.userData.targetLeftFingerTips) {
      const tgt = g.userData.targetLeftFingerTips;
      if (!g.userData.smoothLeftFingerTips) {
        g.userData.smoothLeftFingerTips = [];
        for (let i = 0; i < 5; i++) {
          g.userData.smoothLeftFingerTips.push(
            new THREE.Vector3(
              tgt[i * 3] * c,
              tgt[i * 3 + 1] * c,
              tgt[i * 3 + 2] * c,
            ),
          );
        }
      } else {
        for (let i = 0; i < 5; i++) {
          _presenceLerpCompTarget.set(
            tgt[i * 3] * c,
            tgt[i * 3 + 1] * c,
            tgt[i * 3 + 2] * c,
          );
          g.userData.smoothLeftFingerTips[i].lerp(_presenceLerpCompTarget, a);
        }
      }
      updatePresenceFingerTipsGroupTransform(g, "left", g.userData.smoothLeftFingerTips);
    } else {
      g.userData.smoothLeftFingerTips = null;
      const gl = g.getObjectByName("presence-fingers-left");
      if (gl) gl.visible = false;
    }

    if (mode === "xr_head" && g.userData.hasRightFingerTips && g.userData.targetRightFingerTips) {
      const tgt = g.userData.targetRightFingerTips;
      if (!g.userData.smoothRightFingerTips) {
        g.userData.smoothRightFingerTips = [];
        for (let i = 0; i < 5; i++) {
          g.userData.smoothRightFingerTips.push(
            new THREE.Vector3(
              tgt[i * 3] * c,
              tgt[i * 3 + 1] * c,
              tgt[i * 3 + 2] * c,
            ),
          );
        }
      } else {
        for (let i = 0; i < 5; i++) {
          _presenceLerpCompTarget.set(
            tgt[i * 3] * c,
            tgt[i * 3 + 1] * c,
            tgt[i * 3 + 2] * c,
          );
          g.userData.smoothRightFingerTips[i].lerp(_presenceLerpCompTarget, a);
        }
      }
      updatePresenceFingerTipsGroupTransform(g, "right", g.userData.smoothRightFingerTips);
    } else {
      g.userData.smoothRightFingerTips = null;
      const gr = g.getObjectByName("presence-fingers-right");
      if (gr) gr.visible = false;
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
