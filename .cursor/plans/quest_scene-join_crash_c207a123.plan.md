# Quest crash after joining a Sketchar room (GLB-related)

## User-confirmed reproduction (2026-03-28)

- **Empty / no GLB in the room:** stable — can join, use preview devices, no crash.
- **After uploading a GLB and moving it, then doing more work (erase/remove strokes near the GLB):** crash reproduces.

This isolates the failure to **GLB room assets** and the **interaction of GLB transforms + stroke edits + sync**, not generic Sketchar/presence when the scene is stroke-only.

## Root cause (primary): GLB async load vs incremental apply

**Why this matches the new repro**

1. **Moving the GLB** causes frequent `serializeStrokesGroup` / merge / `upsertSnapshot` and Realtime `postgres_changes` — more `applyScenePayloadIncremental` cycles while GLB loads or shortly after.

2. **Erasing/removing strokes** changes the merged payload often (deletes, pending ids), again triggering applies — higher chance that a **second apply runs before an in-flight `loadGltfIntoGroup` completes**, or that **stale load completions** attach geometry to **detached** wrapper groups.

3. **No-GLB rooms** never hit `loadGltfIntoGroup` in [`gltfSceneLoader.js`](src/shared/gltfSceneLoader.js), so the race/leak path is absent.

**Technical summary**

- [`buildNode`](src/shared/sceneCodec.js) for `t: "gltf"` calls `loadGltfIntoGroup` and returns immediately.
- [`applyScenePayloadIncremental`](src/shared/sceneCodec.js) can remove the GLB wrapper before `loadAsync` resolves; [`disposeSceneGeometrySubtree`](src/shared/sceneCodec.js) does **not** invalidate `gltfLoadToken`.
- The loader only checks token equality, not “still in scene” → **orphaned GLB meshes / GPU leak** → Quest WebGL/browser instability (frozen UI, need to restart browser).

## Secondary contributors (optional follow-ups)

- **Duplicate presence** (`send` + `httpSend` in [`sketcharSupabase.js`](src/shared/sketcharSupabase.js)) — unlikely to be the main difference vs no-GLB rooms, but worth trimming after GLB fix.
- **In-place GLB transform updates** when `id` + `url` unchanged — reduces dispose/reload churn during grab/move (same file as incremental apply).

## Recommended implementation

| Priority | Action |
|----------|--------|
| P0 | Invalidate `gltfLoadToken` when disposing a GLB wrapper; in `loadGltfIntoGroup`, if cancelled or `!group.parent`, dispose loaded scene and return. |
| P1 | Optional: update GLB `tr` in place when serialized node matches id+url (epsilon on floats) to avoid unnecessary rebuild during move/sync. |
| P2 | Optional: dedupe `httpSend` presence if double delivery is observed. |

## Validation on Quest

- Repro script: upload GLB → move repeatedly → erase strokes near model → should stay stable after P0.
- `chrome://inspect` Console: watch for WebGL context lost; optional one-shot logs for “GLB load completed on detached group” (should be **zero** after fix).

## Todos

- [ ] P0: Invalidate token + guard/detach dispose in [`gltfSceneLoader.js`](src/shared/gltfSceneLoader.js) + [`sceneCodec.js`](src/shared/sceneCodec.js) dispose path
- [ ] P1: Optional in-place GLB transform when id+url match
- [ ] P2: Optional presence `httpSend` dedupe
