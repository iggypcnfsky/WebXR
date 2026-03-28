export default function Home() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Sketchar upload API</h1>
      <p>
        GLB uploads: <code>POST /api/export-glb</code> — run the Vite app and set{" "}
        <code>VITE_EXPORT_GLB_URL</code> to this origin.
      </p>
    </main>
  );
}
