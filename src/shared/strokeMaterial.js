import * as THREE from "three";

/** Warm neutral default when no color is stored (legacy snapshots). */
export const DEFAULT_STROKE_COLOR_HEX = 0xbea896;

const strokeMaterialCache = new Map();

/**
 * Cached MeshStandardMaterial for TubePainter (vertexColors: true × material.color).
 * @param {number} hex
 */
export function getStrokeMaterialForHex(hex) {
  const h = (Number(hex) >>> 0) || DEFAULT_STROKE_COLOR_HEX;
  if (strokeMaterialCache.has(h)) return strokeMaterialCache.get(h);
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.42,
    metalness: 0.06,
    color: new THREE.Color(h),
  });
  strokeMaterialCache.set(h, m);
  return m;
}

/** Shared normal material for voxel blocks and non-stroke helpers. */
export const voxelMaterial = new THREE.MeshNormalMaterial({
  flatShading: true,
  side: THREE.DoubleSide,
});
