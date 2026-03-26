import * as THREE from "three";
import {
  computeTubePainterMaxVertices,
  createTubePainterSized,
} from "../misc/TubePainterSized.js";

export const STROKE_WIDTH_MIN = 0.04;
export const STROKE_WIDTH_MAX = 0.2;

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
 * @param {{ v?: number, nodes?: object[] } | null} remote
 * @param {{ v?: number, nodes?: object[] } | null} local
 * @param {Set<string> | string[]} pendingSyncIds
 */
export function mergeScenePayloadsForViewerPoll(remote, local, pendingSyncIds) {
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
  const map = new Map();
  for (const n of rem.nodes) {
    const id = nodeIdFromPayload(n);
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
 */
export function strokeNodeFromContentPoints(pointsLocal, strokeWidth, id) {
  const sw =
    strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
  const pts = pointsLocal.map((p) => [p.x, p.y, p.z]);
  return {
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
    /** @type {Record<string, unknown>} */
    const out = {
      t: "stroke",
      tr: decompose(o),
      points: pts.map((p) => [p.x, p.y, p.z]),
      strokeWidth:
        o.userData.strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5,
    };
    if (o.userData.syncId) out.id = o.userData.syncId;
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

function applyTr(obj, tr) {
  if (!tr) return;
  obj.position.set(tr.p[0], tr.p[1], tr.p[2]);
  obj.quaternion.set(tr.q[0], tr.q[1], tr.q[2], tr.q[3]);
  obj.scale.set(tr.s[0], tr.s[1], tr.s[2]);
}

/** Free GPU buffers for a subtree (stroke clusters nest meshes; top-level dispose was not enough). Materials are caller-owned — not disposed. */
export function disposeSceneGeometrySubtree(root) {
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

/**
 * Apply snapshot without tearing down the whole group — avoids multi‑second hitches / flicker on sync.
 * Falls back to full replace when structural edge cases appear (no syncId children).
 * @param {object} data
 * @param {THREE.Material} material
 * @param {THREE.Group} target
 */
export function applyScenePayloadIncremental(data, material, target) {
  if (!data || data.v !== 1 || !Array.isArray(data.nodes)) return;
  const desired = data.nodes.map((n) => ({ ...n, id: nodeIdFromPayload(n) }));

  const existingById = new Map();
  for (const ch of target.children) {
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

  const nextSet = new Set(next);
  while (target.children.length) {
    const ch = target.children[0];
    if (!nextSet.has(ch)) disposeSceneGeometrySubtree(ch);
    target.remove(ch);
  }
  for (const o of next) {
    target.add(o);
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
    const pts = node.points.map(
      (a) => new THREE.Vector3(a[0], a[1], a[2]),
    );
    const sw =
      node.strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
    const mesh = buildStrokeMeshFromPoints(pts, sw, material);
    applyTr(mesh, node.tr);
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
    inst.userData.syncId =
      node.id && typeof node.id === "string"
        ? node.id
        : stableIdForLegacyNode(node);
    return inst;
  }
  return null;
}

function buildStrokeMeshFromPoints(pointsLocal, strokeWidth, material) {
  const w =
    strokeWidth ?? (STROKE_WIDTH_MIN + STROKE_WIDTH_MAX) * 0.5;
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
