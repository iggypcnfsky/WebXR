/**
 * Grid snap strokes as merged axis-aligned rectangular prisms (true boxes), not swept tubes.
 * Matches TubePainter-sized stroke width convention: half-thickness = 0.01 * setSize().
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from "three";

/** Non-indexed box triangle count per segment. */
const VERTS_PER_BOX = 36;

/**
 * @param {number} pointCount
 */
export function computeGridBoxStrokeMaxVertices(pointCount) {
  const n = Math.max(0, pointCount | 0);
  if (n < 2) return 128;
  const segments = n - 1;
  return Math.min(1_000_000, segments * VERTS_PER_BOX + 64);
}

/**
 * @param {Float32Array} positions
 * @param {Float32Array} normals
 * @param {Float32Array} colors
 * @param {number} baseVertexIndex
 * @param {import("three").Vector3} a
 * @param {import("three").Vector3} b
 * @param {number} strokeSize
 * @param {import("three").Color} color
 * @returns {number} next vertex index
 */
function appendAxisAlignedBoxSegment(
  positions,
  normals,
  colors,
  baseVertexIndex,
  a,
  b,
  strokeSize,
  color,
) {
  const r = 0.01 * strokeSize;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const eps = 1e-7;
  let hx;
  let hy;
  let hz;
  let cx;
  let cy;
  let cz;
  if (Math.abs(dx) > eps && Math.abs(dy) < eps && Math.abs(dz) < eps) {
    hx = Math.abs(dx) / 2;
    hy = r;
    hz = r;
    cx = (a.x + b.x) / 2;
    cy = a.y;
    cz = a.z;
  } else if (Math.abs(dy) > eps && Math.abs(dx) < eps && Math.abs(dz) < eps) {
    hx = r;
    hy = Math.abs(dy) / 2;
    hz = r;
    cx = a.x;
    cy = (a.y + b.y) / 2;
    cz = a.z;
  } else if (Math.abs(dz) > eps && Math.abs(dx) < eps && Math.abs(dy) < eps) {
    hx = r;
    hy = r;
    hz = Math.abs(dz) / 2;
    cx = a.x;
    cy = a.y;
    cz = (a.z + b.z) / 2;
  } else {
    const ax = Math.min(a.x, b.x);
    const bx = Math.max(a.x, b.x);
    const ay = Math.min(a.y, b.y);
    const by = Math.max(a.y, b.y);
    const az = Math.min(a.z, b.z);
    const bz = Math.max(a.z, b.z);
    const ex = Math.max((bx - ax) / 2, r);
    const ey = Math.max((by - ay) / 2, r);
    const ez = Math.max((bz - az) / 2, r);
    hx = ex;
    hy = ey;
    hz = ez;
    cx = (a.x + b.x) / 2;
    cy = (a.y + b.y) / 2;
    cz = (a.z + b.z) / 2;
  }

  const g = new BoxGeometry(2 * hx, 2 * hy, 2 * hz);
  g.translate(cx, cy, cz);
  const ng = g.toNonIndexed();
  const pa = ng.attributes.position;
  const na = ng.attributes.normal;
  let o = baseVertexIndex;
  for (let i = 0; i < pa.count; i++) {
    positions[o * 3] = pa.getX(i);
    positions[o * 3 + 1] = pa.getY(i);
    positions[o * 3 + 2] = pa.getZ(i);
    normals[o * 3] = na.getX(i);
    normals[o * 3 + 1] = na.getY(i);
    normals[o * 3 + 2] = na.getZ(i);
    colors[o * 3] = color.r;
    colors[o * 3 + 1] = color.g;
    colors[o * 3 + 2] = color.b;
    o++;
  }
  g.dispose();
  ng.dispose();
  return o;
}

/**
 * @param {number} maxVertices Upper bound on vertex count after all segments.
 */
export function createGridBoxStrokePainter(maxVertices) {
  const maxV = Math.max(64, Math.min(1_000_000, maxVertices | 0));
  const positions = new Float32Array(maxV * 3);
  const normals = new Float32Array(maxV * 3);
  const colors = new Float32Array(maxV * 3);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.drawRange.count = 0;

  const material = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
  });

  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;

  const color = new Color(0xffffff);
  let size = 1;
  const prev = new Vector3();
  let vertexCount = 0;

  function moveTo(position) {
    prev.copy(position);
  }

  function lineTo(position) {
    if (prev.distanceToSquared(position) < 1e-18) return;
    if (vertexCount + VERTS_PER_BOX > maxV) return;
    vertexCount = appendAxisAlignedBoxSegment(
      positions,
      normals,
      colors,
      vertexCount,
      prev,
      position,
      size,
      color,
    );
    geometry.drawRange.count = vertexCount;
    prev.copy(position);
  }

  function setSize(value) {
    size = value;
  }

  let lastCommitted = 0;

  function update() {
    const start = lastCommitted;
    const end = geometry.drawRange.count;
    if (start === end) return;
    const pos = geometry.attributes.position;
    const norm = geometry.attributes.normal;
    const col = geometry.attributes.color;
    pos.addUpdateRange(start * 3, (end - start) * 3);
    pos.needsUpdate = true;
    norm.addUpdateRange(start * 3, (end - start) * 3);
    norm.needsUpdate = true;
    col.addUpdateRange(start * 3, (end - start) * 3);
    col.needsUpdate = true;
    lastCommitted = end;
  }

  return {
    mesh,
    moveTo,
    lineTo,
    setSize,
    update,
  };
}
