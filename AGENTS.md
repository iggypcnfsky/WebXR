## Learned User Preferences

- Prefers WebXR hand tracking and Logitech MX Ink drawing at the same time: draw with the stylus and manipulate strokes with hands.
- Wants grab and move of drawn strokes to use pinch gestures, not finger-based drawing from hand tracking.
- When tuning interaction, pinch should be strict enough to avoid accidental grabs before a real pinch.
- Thumb–ring pinch on the **left hand only** toggles snap-to-grid; the Lucide grid affordance on the **left** ring-finger marker shows snap state (separate from thumb–index grab and thumb–pinky block mode).
- Prioritizes smooth local Quest drawing while Sketchar/broadcast is on: remote snapshot apply must not tear down in-progress strokes (defer destructive deserialize during stroke/grab; catch up when idle).
- Thumb–middle scene manipulation: two-hand rotation is **world yaw only**; yaw direction is **inverted** from the default inter-hand alignment.
- With grid snap enabled, expects grabbed move/rotate to respect the shared lattice and to rotate about the stroke/object center (not an offset pivot).
- When snap-to-grid is off, lattice vertex markers should stay hidden; when snap is on, marker visibility should emphasize the MX Ink tip with distance falloff rather than uniform opacity across the lattice.

## Learned Workspace Facts

- Documented GitHub remote for this project: `https://github.com/iggypcnfsky/WebXR.git`.
- WebXR behavior, drawing, and input handling live primarily in `src/script.js` (Three.js, `TubePainter`, MX Ink controller profile `logitech-mx-ink`). Live phone/tablet preview is `src/viewer.html` + `src/viewer.js` + `src/viewer.css` (separate bundle).
- Scene sync / Sketchar: `src/shared/sceneCodec.js` (`serializeStrokesGroup`, `deserializeSceneV1`, `mergeScenePayloads`, incremental `applyScenePayloadIncremental`); Supabase rooms + Realtime in `src/shared/sketcharSupabase.js` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`). Strokes use `userData.syncId` for merge-by-id across clients.
- Room codes are normalized with `src/shared/roomCode.js` (`normalizeRoomCode`); API room lookup is case-insensitive so rejoin with the same code works regardless of casing.
- After moving `sceneContentRoot`, stroke tip positions must be converted **world → mesh-local** before `TubePainter` `moveTo`/`lineTo` so tubes match the pen (parent transforms are not identity).
- One lattice drives both visuals and snap: `cellSize = GRID_WORLD_EXTENT / gridLattice.divisions`; vertex snap matches the same spacing as the grid helpers/markers (origin-centered extent with half-size + integer × step).
- Grid cell size is adjustable in the UI and the division count is persisted in browser `localStorage` so the lattice stays consistent across reloads.
- Block mode: thumb–pinky pinch builds a voxel `InstancedMesh` from the last three completed strokes as orthogonal box-edge sketches.
- Grid intersection markers use instanced sphere meshes instead of `THREE.PointS` so they stay visible on Quest-class WebGL (point sprites and `gl_PointSize` are unreliable there).
- On Quest Browser MR passthrough, real hands are not in the WebGL depth buffer, so virtual content only depth-occludes against rendered scene geometry (e.g. hand debug meshes, strokes), not against real hands.
