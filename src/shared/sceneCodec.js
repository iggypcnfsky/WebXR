import * as THREE from "three";
import {
  computeGridBoxStrokeMaxVertices,
  createGridBoxStrokePainter,
} from "../misc/GridBoxStrokePainter.js";
import {
  computeTubePainterMaxVertices,
  createTubePainterSized,
} from "../misc/TubePainterSized.js";
import {
  DEFAULT_STROKE_COLOR_HEX,
  getStrokeMaterialForHex,
} from "./strokeMaterial.js";
import { loadGltfIntoGroup } from "./gltfSceneLoader.js";

export const STROKE_WIDTH_MIN = 0.02;
export const STROKE_WIDTH_MAX = 0.5;

/**
 * @param {number} pressure PointerEvent.pressure (0–1); 0.5 if unavailable.
 */
export function strokeWidthFromPressure(pressure) {
  const p =
    typeof pressure === "number" && Number.isFinite(pressure)
      ? Math.max(0, Math.min(1, pressure))
      : 0.5;
  return STROKE_WIDTH_MIN + p * (STROKE_WIDTH_MAX - STROKE_WIDTH_MIN);
}

/**
 * Shape used only for hashing legacy nodes that have no wire `id`.
 * Must NOT include `tr` (transform): moving a stroke/cluster would change the
 * hash and merge would treat it as a second object → duplicate strokes.
 */
function canonicalForLegacyHash(node) {
  if (!node || typeof node !== "object") return node;
  if (node.t === "stroke") {
    return {
      t: "stroke",
      points: node.points,
      strokeWidth: node.strokeWidth,
    };
  }
  if (node.t === "cluster") {
    const raw = node.nodes ?? [];
    return {
      t: "cluster",
      nodes: raw.map((n) => canonicalForLegacyHash(n)),
    };
  }
  if (node.t === "voxel") {
    return node;
  }
  if (node.t === "gltf" && typeof node.url === "string") {
    return { t: "gltf", url: node.url };
  }
  return node;
}

/**
 * Stable id for snapshots that omit `id` (merge/dedupe across clients).
 * @param {object} node
 */
export function stableIdForLegacyNode(node) {
  try {
    const canon = canonicalForLegacyHash(node);
    const s = JSON.stringify(canon, (_k, v) =>
      typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v,
    );
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return `legacy_${(h >>> 0).toString(16)}`;
  } catch {
    return `legacy_${crypto.randomUUID()}`;
  }
}

export function nodeIdFromPayload(n) {
  return n.id && typeof n.id === "string" ? n.id : stableIdForLegacyNode(n);
}

/**
 * Compare Postgres `updated_at` strings (or ISO) for realtime ordering guards.
 */
export function snapshotTimestampsEqual(a, b) {
  if (a == null || b == null) return false;
  const pa = Date.parse(String(a));
  const pb = Date.parse(String(b));
  if (Number.isFinite(pa) && Number.isFinite(pb)) return pa === pb;
  return String(a) === String(b);
}

/** True if `incoming` is strictly older than `lastSeen` (ignore out-of-order realtime payloads). */
export function snapshotTimestampIsStrictlyOlder(incoming, lastSeen) {
  if (incoming == null || lastSeen == null) return false;
  const a = Date.parse(String(incoming));
  const b = Date.parse(String(lastSeen));
  if (Number.isFinite(a) && Number.isFinite(b)) return a < b;
  return false;
}

/**
 * Union of node lists by `id`; local wins on duplicate keys.
 * @param {{ v?: number, nodes?: object[] } | null} local
 * @param {{ v?: number, nodes?: object[] } | null} remote
 */
export function mergeScenePayloads(local, remote) {
  const loc =
    local && local.v === 1 && Array.isArray(local.nodes)
      ? local
      : { v: 1, nodes: [] };
  const rem =
    remote && remote.v === 1 && Array.isArray(remote.nodes)
      ? remote
      : { v: 1, nodes: [] };
  const merged = new Map();
  for (const n of rem.nodes) {
    const id = n.id && typeof n.id === "string" ? n.id : stableIdForLegacyNode(n);
    merged.set(id, { ...n, id });
  }
  for (const n of loc.nodes) {
    const id = n.id && typeof n.id === "string" ? n.id : stableIdForLegacyNode(n);
    merged.set(id, { ...n, id });
  }
  return { v: 1, nodes: [...merged.values()] };
}

/**
 * Quest/viewer **push** merge: propagates local deletes and avoids resurrecting
 * strokes another client removed.
 *
 * - **Remote** (server) seeds the map, minus `deletedSyncIds` (local tombstones).
 * - **Local wins** on id collision (transforms / edits).
 * - **Local-only** nodes are kept only if `pendingSyncIds` (new stroke not yet on server).
 *   Other local-only ids are dropped as stale (remote already deleted them).
 *
 * @param {{ v?: number, nodes?: object[] } | null} local
 * @param {{ v?: number, nodes?: object[] } | null} remote
 * @param {Set<string> | string[]} deletedSyncIds Ids locally removed; excluded from remote seed and not re-added from stale local.
 * @param {Set<string> | string[]} pendingSyncIds New local strokes not yet confirmed by upsert.
 */
export function mergeScenePayloadsForPush(
  local,
  remote,
  deletedSyncIds,
  pendingSyncIds,
) {
  const loc =
    local && local.v === 1 && Array.isArray(local.nodes)
      ? local
      : { v: 1, nodes: [] };
  const rem =
    remote && remote.v === 1 && Array.isArray(remote.nodes)
      ? remote
      : { v: 1, nodes: [] };
  const deleted =
    deletedSyncIds instanceof Set
      ? deletedSyncIds
      : new Set(Array.isArray(deletedSyncIds) ? deletedSyncIds : []);
  const pending =
    pendingSyncIds instanceof Set
      ? pendingSyncIds
      : new Set(Array.isArray(pendingSyncIds) ? pendingSyncIds : []);
  const map = new Map();
  for (const n of rem.nodes) {
    const id = nodeIdFromPayload(n);
    if (deleted.has(id)) continue;
    map.set(id, { ...n, id });
  }
  for (const n of loc.nodes) {
    const id = nodeIdFromPayload(n);
    if (deleted.has(id)) {
      map.delete(id);
      continue;
    }
    if (map.has(id)) {
      map.set(id, { ...n, id });
    } else if (pending.has(id)) {
      map.set(id, { ...n, id });
    }
  }
  return { v: 1, nodes: [...map.values()] };
}

/**
 * Like mergeScenePayloads, but drops remote nodes whose ids are in `removedIds`
 * (used when the viewer deletes objects so they are not reintroduced from the last GET).
 * @param {{ v?: number, nodes?: object[] } | null} local
 * @param {{ v?: number, nodes?: object[] } | null} remote
 * @param {Set<string> | string[]} removedIds
 */
export function mergeScenePayloadsWithRemovals(local, remote, removedIds) {
  const loc =
    local && local.v === 1 && Array.isArray(local.nodes)
      ? local
      : { v: 1, nodes: [] };
  const rem =
    remote && remote.v === 1 && Array.isArray(remote.nodes)
      ? remote
      : { v: 1, nodes: [] };
  const remove = new Set(
    Array.isArray(removedIds) ? removedIds : [...removedIds],
  );
  const merged = new Map();
  for (const n of rem.nodes) {
    const id = n.id && typeof n.id === "string" ? n.id : stableIdForLegacyNode(n);
    if (remove.has(id)) continue;
    merged.set(id, { ...n, id });
  }
  for (const n of loc.nodes) {
    const id = n.id && typeof n.id === "string" ? n.id : stableIdForLegacyNode(n);
    merged.set(id, { ...n, id });
  }
  return { v: 1, nodes: [...merged.values()] };
}

/**
 * Viewer poll merge: **remote snapshot is authoritative** (deletions and Quest edits).
 * Local nodes are kept only if their id is in `pendingSyncIds` (viewer drew them; not yet on server).
 * Without this, `mergeScenePayloads(local, remote)` re-adds strokes that another device deleted.
 * Optional `deletedSyncIds`: skip remote nodes the user deleted locally before the next push (prevents
 * stale postgres_events from restoring them).
 * @param {{ v?: number, nodes?: object[] } | null} remote
 * @param {{ v?: number, nodes?: object[] } | null} local
 * @param {Set<string> | string[]} pendingSyncIds
 * @param {Set<string> | string[] | null | undefined} [deletedSyncIds]
 */
export function mergeScenePayloadsForViewerPoll(
  remote,
  local,
  pendingSyncIds,
  deletedSyncIds,
) {
  const rem =
    remote && remote.v === 1 && Array.isArray(remote.nodes)
      ? remote
      : { v: 1, nodes: [] };
  const loc =
    local && local.v === 1 && Array.isArray(local.nodes)
      ? local
      : { v: 1, nodes: [] };
  const pending =
    pendingSyncIds instanceof Set
      ? pendingSyncIds
      : new Set(Array.isArray(pendingSyncIds) ? pendingSyncIds : []);
  const deleted =
    deletedSyncIds != null
      ? deletedSyncIds instanceof Set
        ? deletedSyncIds
        : new Set(Array.isArray(deletedSyncIds) ? deletedSyncIds : [])
      : new Set();
  const map = new Map();
  for (const n of rem.nodes) {
    const id = nodeIdFromPayload(n);
    if (deleted.has(id)) continue;
    map.set(id, { ...n, id });
  }
  for (const n of loc.nodes) {
    const id = nodeIdFromPayload(n);
    if (map.has(id)) continue;
    if (pending.has(id)) {
      map.set(id, { ...n, id });
    }
  }
  return { v: 1, nodes: [...map.values()] };
}

/**
 * JSON stroke node for contentGroup-local points (mesh identity transform).
 * @param {THREE.Vector3[]} pointsLocal
 * @param {number} strokeWidth
 * @param {string} id
 * @param {number[] | null} [strokeWidths] Per-vertex widths (same length as points); optional.
 */
export function strokeNodeFromContentPoints(pointsLocal, strokeWidth, id, strokeWidths) {
  const sw =
    strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
  const pts = pointsLocal.map((p) => [p.x, p.y, p.z]);
  /** @type {Record<string, unknown>} */
  const out = {
    t: "stroke",
    id,
    tr: {
      p: [0, 0, 0],
      q: [0, 0, 0, 1],
      s: [1, 1, 1],
    },
    points: pts,
    strokeWidth: sw,
  };
  if (
    Array.isArray(strokeWidths) &&
    strokeWidths.length === pts.length &&
    strokeWidths.every((x) => typeof x === "number" && Number.isFinite(x))
  ) {
    out.strokeWidths = strokeWidths.map((x) => Math.round(x * 1e6) / 1e6);
  }
  return out;
}

/**
 * @param {THREE.Object3D} root
 * @returns {{ v: number, nodes: object[] }}
 */
export function serializeStrokesGroup(root) {
  const nodes = [];
  for (const ch of root.children) {
    const n = serializeNode(ch);
    if (n) nodes.push(n);
  }
  return { v: 1, nodes };
}

function serializeNode(o) {
  if (o.isInstancedMesh && o.userData && o.userData.isVoxelBlock) {
    const count = o.count;
    const arr = [];
    const _m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      o.getMatrixAt(i, _m);
      arr.push(_m.toArray());
    }
    /** @type {Record<string, unknown>} */
    const out = { t: "voxel", n: count, matrices: arr };
    if (o.userData.syncId) out.id = o.userData.syncId;
    return out;
  }
  if (o.isGroup && o.userData && o.userData.isGltfAsset) {
    const url =
      typeof o.userData.gltfUrl === "string" ? o.userData.gltfUrl.trim() : "";
    if (!url) return null;
    /** @type {Record<string, unknown>} */
    const out = { t: "gltf", tr: decompose(o), url };
    if (o.userData.syncId) out.id = o.userData.syncId;
    return out;
  }
  if (o.isGroup && o.userData && o.userData.isStrokeCluster) {
    /** @type {Record<string, unknown>} */
    const out = {
      t: "cluster",
      tr: decompose(o),
      nodes: o.children.map(serializeNode).filter(Boolean),
    };
    if (o.userData.syncId) out.id = o.userData.syncId;
    return out;
  }
  if (o.isMesh && o.userData && o.userData.points && o.userData.points.length >= 2) {
    const pts = o.userData.points;
    const sw =
      o.userData.strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
    /** @type {Record<string, unknown>} */
    const out = {
      t: "stroke",
      tr: snapStrokeTrIfNearIdentity(decompose(o)),
      points: pts.map((p) => [p.x, p.y, p.z]),
      strokeWidth: sw,
    };
    const wArr = o.userData.strokeWidths;
    if (
      Array.isArray(wArr) &&
      wArr.length === pts.length &&
      wArr.every((x) => typeof x === "number" && Number.isFinite(x))
    ) {
      out.strokeWidths = wArr.map(
        (x) => Math.round(x * 1e6) / 1e6,
      );
    }
    if (
      typeof o.userData.strokeColorHex === "number" &&
      Number.isFinite(o.userData.strokeColorHex)
    ) {
      out.strokeColor = o.userData.strokeColorHex >>> 0;
    }
    if (o.userData.syncId) out.id = o.userData.syncId;
    if (o.userData.strokeProfile === "square") out.strokeProfile = "square";
    return out;
  }
  return null;
}

/**
 * Stable snapshot id for a direct child of a strokes group (for merge/delete).
 * @param {THREE.Object3D} o
 * @returns {string | null}
 */
export function sceneNodeIdFromObject3D(o) {
  const n = serializeNode(o);
  if (!n) return null;
  return nodeIdFromPayload(n);
}

function decompose(o) {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  o.matrix.decompose(p, q, s);
  return {
    p: [p.x, p.y, p.z],
    q: [q.x, q.y, q.z, q.w],
    s: [s.x, s.y, s.z],
  };
}

/** Fresh strokes should serialize as identity transform; float noise in matrix.decompose breaks rebuild alignment. */
function snapStrokeTrIfNearIdentity(tr) {
  if (!tr || !tr.p || !tr.q || !tr.s) return tr;
  const epsP = 1e-5;
  const epsR = 1e-4;
  const epsS = 1e-4;
  const [px, py, pz] = tr.p;
  const [qx, qy, qz, qw] = tr.q;
  const [sx, sy, sz] = tr.s;
  if (
    Math.abs(px) < epsP &&
    Math.abs(py) < epsP &&
    Math.abs(pz) < epsP &&
    Math.abs(qx) < epsR &&
    Math.abs(qy) < epsR &&
    Math.abs(qz) < epsR &&
    (Math.abs(qw - 1) < epsR || Math.abs(qw + 1) < epsR) &&
    Math.abs(sx - 1) < epsS &&
    Math.abs(sy - 1) < epsS &&
    Math.abs(sz - 1) < epsS
  ) {
    return {
      p: [0, 0, 0],
      q: [0, 0, 0, 1],
      s: [1, 1, 1],
    };
  }
  return tr;
}

function applyTr(obj, tr) {
  if (!tr) return;
  obj.position.set(tr.p[0], tr.p[1], tr.p[2]);
  obj.quaternion.set(tr.q[0], tr.q[1], tr.q[2], tr.q[3]);
  obj.scale.set(tr.s[0], tr.s[1], tr.s[2]);
}

/** Free GPU buffers for a subtree (stroke clusters nest meshes; top-level dispose was not enough). Materials are caller-owned — not disposed. */
export function disposeSceneGeometrySubtree(root) {
  if (root && root.userData && root.userData.isGltfAsset) {
    root.userData.gltfLoadToken = null;
  }
  const seen = new Set();
  root.traverse((obj) => {
    const g = obj.geometry;
    if (g && !seen.has(g)) {
      seen.add(g);
      g.dispose();
    }
  });
}

/** Rounded JSON for comparing serialized mesh vs snapshot node (avoids pointless rebuilds). */
function stableStringifyNode(obj) {
  return JSON.stringify(obj, (k, v) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      return Math.round(v * 1e6) / 1e6;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted = {};
      for (const key of Object.keys(v).sort()) sorted[key] = v[key];
      return sorted;
    }
    return v;
  });
}

/** Sort cluster children by id so order differences do not force rebuilds every poll. */
function normalizeSnapshotNode(node) {
  if (!node || typeof node !== "object") return node;
  const id = nodeIdFromPayload(node);
  if (node.t === "cluster" && Array.isArray(node.nodes)) {
    const nodes = [...node.nodes]
      .map((n) => normalizeSnapshotNode(n))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { ...node, id, nodes };
  }
  return { ...node, id };
}

function payloadsEqualSerialized(ser, node) {
  if (!ser || !node) return false;
  const a = normalizeSnapshotNode(ser);
  const b = normalizeSnapshotNode(node);
  return stableStringifyNode(a) === stableStringifyNode(b);
}

/** Deep strip `tr` for geometry-only comparison (recursive for cluster nodes). */
function stripTrRecursive(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripTrRecursive);
  const out = {};
  for (const k of Object.keys(obj).sort()) {
    if (k === "tr") continue;
    out[k] = stripTrRecursive(obj[k]);
  }
  return out;
}

/**
 * True if serialized scene node matches incoming payload on everything except transform.
 * @param {object} ser from serializeNode(existing)
 * @param {object} node incoming payload node
 */
export function payloadsGeometryEqual(ser, node) {
  if (!ser || !node) return false;
  const a = normalizeSnapshotNode(ser);
  const b = normalizeSnapshotNode(node);
  return (
    stableStringifyNode(stripTrRecursive(a)) ===
    stableStringifyNode(stripTrRecursive(b))
  );
}

/**
 * Same GLB / stroke / cluster asset: update transform only (avoids dispose/reload).
 * @param {THREE.Object3D} existing
 * @param {object} node
 */
export function canApplyTransformOnlyInPlace(existing, node) {
  if (!existing || !node) return false;
  const ser = serializeNode(existing);
  if (!ser) return false;
  if (ser.t !== node.t) return false;
  if (nodeIdFromPayload(ser) !== nodeIdFromPayload(node)) return false;
  if (node.t === "gltf") return canApplyGltfPayloadInPlace(existing, node);
  if (node.t === "stroke" || node.t === "cluster") {
    return payloadsGeometryEqual(ser, node);
  }
  return false;
}

function clearNetworkTransformSmoothState(obj) {
  if (!obj.userData) return;
  delete obj.userData.networkTrTarget;
  delete obj.userData.networkTrSmoothInitialized;
}

function clearAllNetworkTransformSmoothState(target) {
  target.traverse((obj) => {
    clearNetworkTransformSmoothState(obj);
  });
}

function setNetworkTargetFromTr(obj, tr) {
  if (!tr || !tr.p || !tr.q || !tr.s) return;
  obj.userData.networkTrTarget = {
    p: [tr.p[0], tr.p[1], tr.p[2]],
    q: [tr.q[0], tr.q[1], tr.q[2], tr.q[3]],
    s: [tr.s[0], tr.s[1], tr.s[2]],
  };
}

function syncNetworkTargetsToCurrent(obj) {
  if (!obj.userData.networkTrTarget) obj.userData.networkTrTarget = {};
  const t = obj.userData.networkTrTarget;
  t.p = [obj.position.x, obj.position.y, obj.position.z];
  t.q = [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w];
  t.s = [obj.scale.x, obj.scale.y, obj.scale.z];
}

/**
 * @param {THREE.Object3D} obj
 * @param {object} tr
 * @param {{ smoothNetworkTransforms?: boolean, isLocalAuthority?: (o: THREE.Object3D) => boolean }} [applyOpts]
 */
function applyNetworkTransform(obj, tr, applyOpts) {
  if (!tr) return;
  const smooth = applyOpts?.smoothNetworkTransforms === true;
  const isAuthFn = applyOpts?.isLocalAuthority;
  if (!smooth) {
    applyTr(obj, tr);
    clearNetworkTransformSmoothState(obj);
    return;
  }
  const localAuth =
    typeof isAuthFn === "function" ? !!isAuthFn(obj) : false;
  setNetworkTargetFromTr(obj, tr);
  if (localAuth) {
    applyTr(obj, tr);
    syncNetworkTargetsToCurrent(obj);
    obj.userData.networkTrSmoothInitialized = true;
    return;
  }
  if (!obj.userData.networkTrSmoothInitialized) {
    applyTr(obj, tr);
    syncNetworkTargetsToCurrent(obj);
    obj.userData.networkTrSmoothInitialized = true;
  }
}

/**
 * Compare two scene payloads ignoring top-level node order (merge uses Map insertion order).
 * Use to skip applyScenePayloadIncremental when merge did not change anything vs local — avoids
 * rebuilding TubePainter meshes in place (rebuild can shift strokes by float/tube tessellation).
 */
export function scenePayloadsEqual(a, b) {
  if (!a || !b || a.v !== 1 || b.v !== 1) return false;
  const na = [...(a.nodes || [])]
    .map((n) => normalizeSnapshotNode(n))
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));
  const nb = [...(b.nodes || [])]
    .map((n) => normalizeSnapshotNode(n))
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));
  return stableStringifyNode({ v: 1, nodes: na }) === stableStringifyNode({ v: 1, nodes: nb });
}

/** Direct children with this flag are kept across apply (e.g. viewer presence, origin gizmo). */
function shouldPreserveSceneChild(obj) {
  return !!(obj && obj.userData && obj.userData.preserveInSceneApply);
}

/**
 * Same GLB asset id + URL: update transform only (avoids dispose/reload during grab/sync).
 * @param {THREE.Object3D} existing
 * @param {object} node
 */
function canApplyGltfPayloadInPlace(existing, node) {
  if (!existing || !node || node.t !== "gltf") return false;
  if (!existing.isGroup || !existing.userData || !existing.userData.isGltfAsset) {
    return false;
  }
  const url = typeof node.url === "string" ? node.url.trim() : "";
  const cur =
    typeof existing.userData.gltfUrl === "string"
      ? existing.userData.gltfUrl.trim()
      : "";
  if (!url || url !== cur) return false;
  const sid =
    existing.userData.syncId && typeof existing.userData.syncId === "string"
      ? existing.userData.syncId
      : "";
  return sid !== "" && sid === node.id;
}

/**
 * Apply snapshot without tearing down the whole group — avoids multi‑second hitches / flicker on sync.
 * Optional `smoothNetworkTransforms` lerps remote transform updates each frame (see `sceneNetworkTransformSmooth.js`).
 * @param {object} data
 * @param {THREE.Material} material
 * @param {THREE.Group} target
 * @param {{ smoothNetworkTransforms?: boolean, isLocalAuthority?: (o: THREE.Object3D) => boolean }} [applyOpts]
 */
export function applyScenePayloadIncremental(data, material, target, applyOpts) {
  if (!data || data.v !== 1 || !Array.isArray(data.nodes)) return;
  const smooth = applyOpts?.smoothNetworkTransforms === true;
  if (!smooth) {
    clearAllNetworkTransformSmoothState(target);
  }
  const desired = data.nodes.map((n) => ({ ...n, id: nodeIdFromPayload(n) }));

  const existingById = new Map();
  for (const ch of target.children) {
    if (shouldPreserveSceneChild(ch)) continue;
    const id = ch.userData && ch.userData.syncId;
    if (typeof id === "string") existingById.set(id, ch);
  }

  const next = [];
  for (const node of desired) {
    const id = node.id;
    const existing = existingById.get(id);
    if (existing) {
      const ser = serializeNode(existing);
      if (ser && payloadsEqualSerialized(ser, node)) {
        next.push(existing);
        existingById.delete(id);
        continue;
      }
      if (canApplyTransformOnlyInPlace(existing, node)) {
        applyNetworkTransform(existing, node.tr, applyOpts);
        next.push(existing);
        existingById.delete(id);
        continue;
      }
      disposeSceneGeometrySubtree(existing);
      if (existing.parent) existing.parent.remove(existing);
      existingById.delete(id);
    }
    const o = buildNode(node, material);
    if (o) next.push(o);
  }

  for (const ch of existingById.values()) {
    disposeSceneGeometrySubtree(ch);
    if (ch.parent) ch.parent.remove(ch);
  }

  const preserved = [];
  for (const ch of [...target.children]) {
    if (shouldPreserveSceneChild(ch)) {
      preserved.push(ch);
      target.remove(ch);
    }
  }

  const nextSet = new Set(next);
  while (target.children.length) {
    const ch = target.children[0];
    if (!nextSet.has(ch)) disposeSceneGeometrySubtree(ch);
    target.remove(ch);
  }
  for (const o of next) {
    target.add(o);
  }
  for (const p of preserved) {
    target.add(p);
  }
}

/**
 * @param {object} data
 * @param {THREE.Material} material
 * @param {THREE.Group} target
 */
export function deserializeSceneV1(data, material, target) {
  while (target.children.length) {
    const ch = target.children[0];
    disposeSceneGeometrySubtree(ch);
    target.remove(ch);
  }
  if (!data || data.v !== 1 || !Array.isArray(data.nodes)) return;
  for (const node of data.nodes) {
    const o = buildNode(node, material);
    if (o) target.add(o);
  }
}

function buildNode(node, material) {
  if (node.t === "stroke") {
    if (!Array.isArray(node.points) || node.points.length === 0) return null;
    const pts = node.points.map(
      (a) => new THREE.Vector3(a[0], a[1], a[2]),
    );
    const sw =
      node.strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
    const swArr = node.strokeWidths;
    const strokeWidths =
      Array.isArray(swArr) &&
      swArr.length === pts.length &&
      swArr.every((x) => typeof x === "number" && Number.isFinite(x))
        ? swArr
        : null;
    const strokeColorHex =
      typeof node.strokeColor === "number" && Number.isFinite(node.strokeColor)
        ? node.strokeColor >>> 0
        : DEFAULT_STROKE_COLOR_HEX;
    const strokeProfile =
      node.strokeProfile === "square" ? "square" : undefined;
    const mesh = buildStrokeMeshFromPoints(
      pts,
      sw,
      strokeWidths,
      strokeColorHex,
      strokeProfile,
    );
    applyTr(mesh, node.tr);
    mesh.castShadow = true;
    mesh.userData.syncId =
      node.id && typeof node.id === "string"
        ? node.id
        : stableIdForLegacyNode(node);
    return mesh;
  }
  if (node.t === "cluster") {
    const g = new THREE.Group();
    g.userData.isStrokeCluster = true;
    g.userData.syncId =
      node.id && typeof node.id === "string"
        ? node.id
        : stableIdForLegacyNode(node);
    applyTr(g, node.tr);
    for (const n of node.nodes || []) {
      const o = buildNode(n, material);
      if (o) g.add(o);
    }
    return g;
  }
  if (node.t === "voxel") {
    const count = node.n || (node.matrices && node.matrices.length) || 0;
    if (!count) return null;
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const inst = new THREE.InstancedMesh(geom, material, count);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.userData.isVoxelBlock = true;
    inst.frustumCulled = false;
    const _m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      if (node.matrices && node.matrices[i]) {
        _m.fromArray(node.matrices[i]);
        inst.setMatrixAt(i, _m);
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.castShadow = true;
    inst.userData.syncId =
      node.id && typeof node.id === "string"
        ? node.id
        : stableIdForLegacyNode(node);
    return inst;
  }
  if (node.t === "gltf") {
    const url = typeof node.url === "string" ? node.url.trim() : "";
    if (!url) return null;
    const g = new THREE.Group();
    g.userData.isGltfAsset = true;
    g.userData.gltfUrl = url;
    g.frustumCulled = false;
    applyTr(g, node.tr);
    g.userData.syncId =
      node.id && typeof node.id === "string"
        ? node.id
        : stableIdForLegacyNode(node);
    loadGltfIntoGroup(g, url);
    return g;
  }
  return null;
}

function buildStrokeMeshFromPoints(
  pointsLocal,
  strokeWidth,
  strokeWidths,
  strokeColorHex,
  strokeProfile,
) {
  const w =
    strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
  const n = pointsLocal.length;
  const square = strokeProfile === "square";
  const hex =
    typeof strokeColorHex === "number" && Number.isFinite(strokeColorHex)
      ? strokeColorHex >>> 0
      : DEFAULT_STROKE_COLOR_HEX;
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
      gp.setSize(w);
      gp.mesh.userData.strokeWidth = w;
      gp.moveTo(pointsLocal[0]);
      for (let i = 1; i < n; i++) {
        gp.lineTo(pointsLocal[i]);
      }
      gp.mesh.userData.strokeWidths = pointsLocal.map(() => w);
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
    tp.setSize(w);
    tp.mesh.userData.strokeWidth = w;
    tp.moveTo(pointsLocal[0]);
    for (let i = 1; i < n; i++) {
      tp.lineTo(pointsLocal[i]);
    }
    tp.mesh.userData.strokeWidths = pointsLocal.map(() => w);
  }
  tp.update();
  tp.mesh.userData.points = pointsLocal.map((p) => p.clone());
  return tp.mesh;
}

/**
 * @param {number[]|null} m16
 * @returns {THREE.Matrix4}
 */
export function matrix4FromArray(m16) {
  const m = new THREE.Matrix4();
  if (m16 && m16.length === 16) m.fromArray(m16);
  else m.identity();
  return m;
}
