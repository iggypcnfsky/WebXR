/**
 * Copies Vite `dist/` (repo root) into `next-upload-api/public/` before `next build`.
 * Run from repo root: `node next-upload-api/scripts/sync-vite-dist.mjs`
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nextApiRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(nextApiRoot, "..");
const distDir = path.join(repoRoot, "dist");
const publicDir = path.join(nextApiRoot, "public");

async function main() {
  try {
    await fs.access(distDir);
  } catch {
    console.error("[sync-vite-dist] Missing dist/. Run `vite build` from the repo root first.");
    process.exit(1);
  }

  await fs.rm(publicDir, { recursive: true, force: true });
  await fs.mkdir(publicDir, { recursive: true });
  await fs.cp(distDir, publicDir, { recursive: true });
  console.log("[sync-vite-dist] Copied dist/ → next-upload-api/public/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
