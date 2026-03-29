import * as THREE from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/** Matches `draco3d@1.5.7` encoder in `next-upload-api` Walden optimizer. */
const DRACO_DECODER_VERSION = "1.5.7";

const loader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(
  `https://www.gstatic.com/draco/versioned/decoders/${DRACO_DECODER_VERSION}/`,
);
loader.setDRACOLoader(dracoLoader);

function disposeSubtreeGeometry(root) {
  const seen = new Set();
  root.traverse((obj) => {
    const g = obj.geometry;
    if (g && !seen.has(g)) {
      seen.add(g);
      g.dispose();
    }
  });
}

/**
 * Deep-clone scene graph while reusing BufferGeometry and Materials (extra “instances” without re-upload).
 * SkinnedMesh / skeleton-heavy nodes use full `clone(true)` so bones stay consistent.
 * @param {THREE.Object3D} source
 * @returns {THREE.Object3D}
 */
export function cloneObject3DSharingGeometry(source) {
  if (source.isSkinnedMesh) {
    return /** @type {THREE.SkinnedMesh} */ (source.clone(true));
  }
  if (source.isMesh) {
    const mesh = new THREE.Mesh(source.geometry, source.material);
    mesh.name = source.name;
    mesh.position.copy(source.position);
    mesh.quaternion.copy(source.quaternion);
    mesh.scale.copy(source.scale);
    mesh.visible = source.visible;
    mesh.castShadow = source.castShadow;
    mesh.receiveShadow = source.receiveShadow;
    mesh.renderOrder = source.renderOrder;
    mesh.frustumCulled = source.frustumCulled;
    Object.assign(mesh.userData, source.userData);
    for (let i = 0; i < source.children.length; i++) {
      mesh.add(cloneObject3DSharingGeometry(source.children[i]));
    }
    return mesh;
  }
  if (source.isLineSegments) {
    const line = new THREE.LineSegments(source.geometry, source.material);
    line.name = source.name;
    line.position.copy(source.position);
    line.quaternion.copy(source.quaternion);
    line.scale.copy(source.scale);
    line.visible = source.visible;
    Object.assign(line.userData, source.userData);
    for (let i = 0; i < source.children.length; i++) {
      line.add(cloneObject3DSharingGeometry(source.children[i]));
    }
    return line;
  }
  if (source.isLine) {
    const line = new THREE.Line(source.geometry, source.material);
    line.name = source.name;
    line.position.copy(source.position);
    line.quaternion.copy(source.quaternion);
    line.scale.copy(source.scale);
    line.visible = source.visible;
    Object.assign(line.userData, source.userData);
    for (let i = 0; i < source.children.length; i++) {
      line.add(cloneObject3DSharingGeometry(source.children[i]));
    }
    return line;
  }
  if (source.isPoints) {
    const pts = new THREE.Points(source.geometry, source.material);
    pts.name = source.name;
    pts.position.copy(source.position);
    pts.quaternion.copy(source.quaternion);
    pts.scale.copy(source.scale);
    pts.visible = source.visible;
    Object.assign(pts.userData, source.userData);
    for (let i = 0; i < source.children.length; i++) {
      pts.add(cloneObject3DSharingGeometry(source.children[i]));
    }
    return pts;
  }
  if (source.isInstancedMesh) {
    const inst = new THREE.InstancedMesh(
      source.geometry,
      source.material,
      source.count,
    );
    inst.name = source.name;
    inst.position.copy(source.position);
    inst.quaternion.copy(source.quaternion);
    inst.scale.copy(source.scale);
    inst.visible = source.visible;
    inst.instanceMatrix.copy(source.instanceMatrix);
    inst.instanceMatrix.needsUpdate = true;
    if (source.instanceColor)
      inst.instanceColor = source.instanceColor.clone();
    Object.assign(inst.userData, source.userData);
    for (let i = 0; i < source.children.length; i++) {
      inst.add(cloneObject3DSharingGeometry(source.children[i]));
    }
    return inst;
  }
  const group = new THREE.Group();
  group.name = source.name;
  group.position.copy(source.position);
  group.quaternion.copy(source.quaternion);
  group.scale.copy(source.scale);
  group.visible = source.visible;
  Object.assign(group.userData, source.userData);
  for (let i = 0; i < source.children.length; i++) {
    group.add(cloneObject3DSharingGeometry(source.children[i]));
  }
  return group;
}

/**
 * Loads a glTF/glb URL into `group` (replaces prior loaded children). Wrapper `userData` stays intact.
 * @param {import("three").Group} group
 * @param {string} url
 * @returns {Promise<void>}
 */
export function loadGltfIntoGroup(group, url) {
  const u = typeof url === "string" ? url.trim() : "";
  if (!u) return Promise.resolve();

  const token = crypto.randomUUID();
  group.userData.gltfLoadToken = token;
  group.userData.gltfLoaded = false;

  return loader
    .loadAsync(u)
    .then((gltf) => {
      if (group.userData.gltfLoadToken !== token) {
        disposeSubtreeGeometry(gltf.scene);
        return;
      }
      if (!group.parent) {
        disposeSubtreeGeometry(gltf.scene);
        group.userData.gltfLoadToken = null;
        return;
      }
      while (group.children.length) {
        const ch = group.children[0];
        disposeSubtreeGeometry(ch);
        group.remove(ch);
      }
      group.add(gltf.scene);
      gltf.scene.traverse((o) => {
        if (o.isMesh || o.isInstancedMesh) {
          let opaque = true;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (m && m.transparent) {
              opaque = false;
              break;
            }
          }
          if (opaque) o.castShadow = true;
        }
      });
      group.userData.gltfLoaded = true;
      delete group.userData.centerLocal;
    })
    .catch((err) => {
      if (group.userData.gltfLoadToken === token) {
        group.userData.gltfLoadError =
          err && typeof err.message === "string" ? err.message : "load_failed";
        console.warn("[gltf room asset]", err);
      }
    });
}
