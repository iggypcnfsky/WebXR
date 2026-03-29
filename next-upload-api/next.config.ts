import { loadEnvConfig } from "@next/env";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repo root — same `.env.local` as Vite (`envDir` in `vite.config.js`). */
const repoRoot = path.join(__dirname, "..");

loadEnvConfig(repoRoot, process.env.NODE_ENV !== "production");

/** Monorepo: trace deps from repo root (parent of `next-upload-api/`). */
const nextConfig: NextConfig = {
  outputFileTracingRoot: repoRoot,
  /** WASM / native deps read from node_modules at runtime (Walden GLB optimizer). */
  serverExternalPackages: ["@loaders.gl/textures", "draco3d", "sharp"],
  /**
   * Serve Vite-built `public/index.html` at `/` (synced from `dist/` before `next build`).
   * Runs before App Router so we do not need `app/page.tsx` for the main WebXR entry.
   */
  async rewrites() {
    return {
      beforeFiles: [{ source: "/", destination: "/index.html" }],
    };
  },
};

export default nextConfig;
