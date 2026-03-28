import * as THREE from "three";

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

function expSmoothFactor(deltaSec, lambda) {
  const d = Math.max(0, deltaSec);
  return 1 - Math.exp(-lambda * d);
}

function syncTargetsToCurrent(obj) {
  const t = obj.userData.networkTrTarget;
  if (!t) return;
  t.p = [obj.position.x, obj.position.y, obj.position.z];
  t.q = [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w];
  t.s = [obj.scale.x, obj.scale.y, obj.scale.z];
}

function smoothObjectSubtree(obj, a, isLocalAuthority) {
  if (!obj.userData || obj.userData.preserveInSceneApply) return;

  const tgt = obj.userData.networkTrTarget;
  if (
    tgt &&
    obj.userData.networkTrSmoothInitialized &&
    tgt.p &&
    tgt.q &&
    tgt.s
  ) {
    if (typeof isLocalAuthority === "function" && isLocalAuthority(obj)) {
      syncTargetsToCurrent(obj);
    } else {
      _v.set(tgt.p[0], tgt.p[1], tgt.p[2]);
      obj.position.lerp(_v, a);
      _q.set(tgt.q[0], tgt.q[1], tgt.q[2], tgt.q[3]);
      obj.quaternion.slerp(_q, a);
      if (obj.quaternion.lengthSq() > 1e-20) {
        obj.quaternion.normalize();
      }
      _s.set(tgt.s[0], tgt.s[1], tgt.s[2]);
      obj.scale.lerp(_s, a);
    }
  }

  for (let i = 0; i < obj.children.length; i++) {
    smoothObjectSubtree(obj.children[i], a, isLocalAuthority);
  }
}

/**
 * Exponential smoothing toward `userData.networkTrTarget` set by networked scene apply.
 * @param {THREE.Group} root e.g. strokesGroup / contentGroup
 * @param {number} deltaSec
 * @param {{ lambda?: number, isLocalAuthority?: (o: THREE.Object3D) => boolean }} [opts]
 */
export function smoothSceneNetworkTransforms(root, deltaSec, opts = {}) {
  const lambda = opts.lambda ?? 14;
  const isLocalAuthority = opts.isLocalAuthority;
  const a = expSmoothFactor(deltaSec, lambda);
  for (let i = 0; i < root.children.length; i++) {
    const ch = root.children[i];
    if (!ch.userData || ch.userData.preserveInSceneApply) continue;
    smoothObjectSubtree(ch, a, isLocalAuthority);
  }
}
