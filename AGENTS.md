## Learned User Preferences

- Prefers WebXR hand tracking and Logitech MX Ink drawing at the same time: draw with the stylus and manipulate strokes with hands.
- Wants grab and move of drawn strokes to use pinch gestures, not finger-based drawing from hand tracking.
- When tuning interaction, pinch should be strict enough to avoid accidental grabs before a real pinch.
- Snap-to-grid toggles with **right-hand** thumb–pinky pinch; the Lucide grid affordance sits on the **right** pinky (thumb–index grab is separate). **Block/voxel mode** uses **left-hand** thumb–pinky only so it does not clash with grid toggle.
- Prefers smooth local Quest drawing while Sketchar/broadcast is on: remote snapshot apply must not tear down in-progress strokes (defer destructive deserialize during stroke/grab; catch up when idle).
- Thumb–middle scene manipulation: two-hand rotation is **world yaw only**; yaw direction is **inverted** from the default inter-hand alignment.
- With grid snap enabled, expects grabbed move/rotate to respect the shared lattice and to rotate about the stroke/object center (not an offset pivot).
- When snap-to-grid is off, lattice vertex markers should stay hidden; when snap is on, marker visibility should emphasize the MX Ink tip with distance falloff rather than uniform opacity across the lattice.
- Preview/viewer strokes on phone, tablet, or desktop should render noticeably **thicker** (~2× world stroke width) than Quest’s default line weight for readability.
- Presence GLB meshes (Quest headset, MX Ink) should keep **opaque PBR materials** in the opaque render path; do not blanket-set `transparent: true` on every material (that breaks lighting); sprites/labels still need transparency for alpha.

## Learned Workspace Facts

- Documented GitHub remote for this project: `https://github.com/iggypcnfsky/WebXR.git`.
- WebXR behavior, drawing, and input handling live primarily in `src/script.js` (Three.js, `TubePainter`, MX Ink controller profile `logitech-mx-ink`). Live phone/tablet preview is `src/viewer.html` + `src/viewer.js` + `src/viewer.css` (separate bundle).
- Scene sync / Sketchar: `src/shared/sceneCodec.js` (`serializeStrokesGroup`, `deserializeSceneV1`, `mergeScenePayloads`, incremental `applyScenePayloadIncremental`; stroke mesh rebuild uses `src/misc/TubePainterSized.js` for bounded buffers); Supabase rooms + Realtime in `src/shared/sketcharSupabase.js` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). Strokes use `userData.syncId` for merge-by-id across clients.
- Remote presence avatars load GLBs from repo `static/3d-models/` (URLs like `/3d-models/meta_quest_3-compressed.glb`, `/3d-models/logitech_mx_ink.glb`) in `src/shared/sketcharPresence.js`; optional stylus pose fields `sx`–`sqw` on `xr_head` presence payloads align the pen with the head in strokes space.
- Room codes are normalized with `src/shared/roomCode.js` (`normalizeRoomCode`); API room lookup is case-insensitive so rejoin with the same code works regardless of casing.
- After moving `sceneContentRoot`, stroke tip positions must be converted **world → mesh-local** before `TubePainter` `moveTo`/`lineTo` so tubes match the pen (parent transforms are not identity).
- One lattice drives both visuals and snap: `cellSize = GRID_WORLD_EXTENT / gridLattice.divisions`; vertex snap matches the same spacing as the grid helpers/markers (origin-centered extent with half-size + integer × step).
- Grid cell size is adjustable in the UI and the division count is persisted in browser `localStorage` so the lattice stays consistent across reloads.
- Block mode: **left hand only** — thumb–pinky pinch builds a voxel `InstancedMesh` from the last three completed strokes as orthogonal box-edge sketches.
- Grid intersection markers use instanced sphere meshes instead of `THREE.PointS` so they stay visible on Quest-class WebGL (point sprites and `gl_PointSize` are unreliable there).
- MR depth expectations: on Quest passthrough, real hands are not in the WebGL depth buffer (virtual content occludes against rendered geometry only). Environment occlusion uses optional WebXR `depth-sensing` (`src/script.js` / `XRButton`); Three.js runs a depth prepass when the runtime supplies depth; `window.__sketcharXRDepthSensing` mirrors `renderer.xr.hasDepthSensing()`. Prefer the WebXR **layers** / `XRWebGLBinding` path; legacy `XRWebGLLayer` may not initialize depth prepass—verify on device. Wrong photoreal hand/body silhouettes after env depth may need **hand-tracking proxy geometry** as a separate follow-up.
- Vite uses `envDir: __dirname` in `vite.config.js` so `VITE_*` variables in the **project-root** `.env.local` load even when `root` is `src/`; `publicDir: "../static/"` serves repo `static/` at the site root (e.g. `/3d-models/...`, `/sketchar-logo.svg`).
