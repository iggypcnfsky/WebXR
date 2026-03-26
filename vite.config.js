import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import restart from "vite-plugin-restart";
import basicSsl from "@vitejs/plugin-basic-ssl";
import glsl from "vite-plugin-glsl";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default {
  root: "src/", // Sources files (typically where index.html is)
  publicDir: "../static/", // Path from "root" to static assets (files that are served as they are)
  server: {
    host: true, // Open to local network and display URL
    open: !("SANDBOX_URL" in process.env || "CODESANDBOX_HOST" in process.env), // Open if it's not a CodeSandbox
    https: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: "../dist", // Output in the dist/ folder
    emptyOutDir: true, // Empty the folder first
    sourcemap: true, // Add sourcemap
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
        viewer: resolve(__dirname, "src/viewer.html"),
      },
    },
  },
  plugins: [
    restart({ restart: ["../static/**"] }), // Restart server on static file change
    basicSsl(),
    glsl(),
  ],
};
