import { Group } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

/**
 * Serializes drawable sketch content (strokes + voxels) as one binary GLB with the same
 * world pose as `sceneContentRoot` (strokes live under `strokesGroup`).
 * @param {import("three").Object3D} sceneContentRoot
 * @param {import("three").Group} strokesGroup
 * @returns {Promise<ArrayBuffer>}
 */
export async function exportSketchToGlbArrayBuffer(sceneContentRoot, strokesGroup) {
  sceneContentRoot.updateMatrixWorld(true);
  strokesGroup.updateMatrixWorld(true);
  const root = new Group();
  root.name = "SketcharSketch";
  root.add(strokesGroup.clone(true));
  root.applyMatrix4(sceneContentRoot.matrixWorld);
  root.updateMatrixWorld(true);

  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true });
  if (!(result instanceof ArrayBuffer)) {
    throw new Error("GLTF export expected binary GLB buffer");
  }
  return result;
}

/**
 * @param {ArrayBuffer} buffer
 * @param {{ url: string, token?: string, roomSlug?: string }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function uploadGlbArrayBuffer(buffer, options) {
  const url = options.url?.trim();
  if (!url) throw new Error("missing_export_url");

  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "model/gltf-binary",
  };
  const token = options.token?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const room = options.roomSlug?.trim();
  if (room) headers["X-Sketchar-Room"] = room;

  const res = await fetch(url, {
    method: "POST",
    body: buffer,
    headers,
    mode: "cors",
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    /* ignore */
  }

  if (!res.ok) {
    const msg =
      (json && typeof json.error === "string" && json.error) ||
      (json && typeof json.message === "string" && json.message) ||
      text ||
      res.statusText;
    throw new Error(typeof msg === "string" ? msg : `HTTP ${res.status}`);
  }

  return json && typeof json === "object" ? json : {};
}

/**
 * Deletes an object from R2 via the same upload API (`DELETE /api/export-glb`).
 * Fails quietly (logs a warning) so scene removal still succeeds if storage is unavailable.
 * @param {string} publicReadUrl Full HTTPS URL returned when the GLB was uploaded (must match server `PUBLIC_R2_READ_URL`).
 * @param {{ url: string, token?: string }} options Same `url` / `token` as `uploadGlbArrayBuffer` (`VITE_EXPORT_GLB_*`).
 */
export async function deleteRoomGlbFromR2(publicReadUrl, options) {
  const apiUrl = options.url?.trim();
  const token = options.token?.trim();
  const u = typeof publicReadUrl === "string" ? publicReadUrl.trim() : "";
  if (!apiUrl || !u || !token) return;

  try {
    const res = await fetch(apiUrl, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ url: u }),
      mode: "cors",
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn("[deleteRoomGlbFromR2]", res.status, text);
    }
  } catch (e) {
    console.warn("[deleteRoomGlbFromR2]", e);
  }
}
