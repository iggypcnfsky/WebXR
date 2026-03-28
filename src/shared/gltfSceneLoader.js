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
