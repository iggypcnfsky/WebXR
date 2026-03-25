## Learned User Preferences

- Prefers WebXR hand tracking and Logitech MX Ink drawing at the same time: draw with the stylus and manipulate strokes with hands.
- Wants grab and move of drawn strokes to use pinch gestures, not finger-based drawing from hand tracking.
- When tuning interaction, pinch should be strict enough to avoid accidental grabs before a real pinch.
- Thumb–ring pinch toggles snap-to-grid; the ring-finger marker shows the Lucide grid affordance (separate from thumb–index grab and thumb–pinky block mode).
- With grid snap enabled, expects grabbed move/rotate to respect the shared lattice and to rotate about the stroke/object center (not an offset pivot).

## Learned Workspace Facts

- Documented GitHub remote for this project: `https://github.com/iggypcnfsky/WebXR.git`.
- WebXR behavior, drawing, and input handling live primarily in `src/script.js` (Three.js, `TubePainter`, MX Ink controller profile `logitech-mx-ink`).
- One lattice drives both visuals and snap: `cellSize = GRID_WORLD_EXTENT / gridLattice.divisions`; vertex snap matches the same spacing as the grid helpers/markers (origin-centered extent with half-size + integer × step).
- Grid cell size is adjustable in the UI and the division count is persisted in browser `localStorage` so the lattice stays consistent across reloads.
- Block mode: thumb–pinky pinch builds a voxel `InstancedMesh` from the last three completed strokes as orthogonal box-edge sketches.
- Grid intersection markers use instanced sphere meshes instead of `THREE.PointS` so they stay visible on Quest-class WebGL (point sprites and `gl_PointSize` are unreliable there).
