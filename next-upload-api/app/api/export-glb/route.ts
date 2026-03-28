import { loadEnvConfig } from "@next/env";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config as dotenvConfig } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest, NextResponse } from "next/server";
import { getWaldenGlbMaxBytes } from "../../../lib/waldenGlbMaxUploadBytes";
import { optimizeWaldenGlbBuffer } from "../../../lib/waldenGlbOptimize";

export const runtime = "nodejs";

const ROOT_PKG_NAME = "sketchar-webxr";

/** GLBs smaller than this are uploaded unchanged (Walden optimizer skipped). */
const SKIP_COMPRESS_BELOW_BYTES = 1024 * 1024;

function isSketcharRepoRoot(dir: string): boolean {
  const pkgPath = path.join(dir, "package.json");
  const vitePath = path.join(dir, "vite.config.js");
  if (!fs.existsSync(pkgPath) || !fs.existsSync(vitePath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
    return pkg.name === ROOT_PKG_NAME;
  } catch {
    return false;
  }
}

/**
 * Monorepo root: same folder as root `package.json` (name sketchar-webxr) + `vite.config.js`.
 */
function findRepoRoot(): string {
  const cwd = process.cwd();
  if (isSketcharRepoRoot(cwd)) return cwd;
  const parent = path.resolve(cwd, "..");
  if (isSketcharRepoRoot(parent)) return parent;

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 20; i++) {
    if (isSketcharRepoRoot(dir)) return dir;
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return cwd;
}

function ensureRepoEnvLoaded() {
  const root = findRepoRoot();
  loadEnvConfig(root, process.env.NODE_ENV !== "production");
  const envLocal = path.join(root, ".env.local");
  if (fs.existsSync(envLocal)) {
    dotenvConfig({ path: envLocal, override: true });
  }
}

function parseBearerToken(request: NextRequest): string | null {
  const raw = request.headers.get("authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

function corsHeaders(request: NextRequest): Headers {
  const origin = request.headers.get("origin");
  const h = new Headers();
  if (origin) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Vary", "Origin");
  } else {
    h.set("Access-Control-Allow-Origin", "*");
  }
  h.set("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
  h.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Sketchar-Room",
  );
  h.set(
    "Access-Control-Expose-Headers",
    "X-Glb-Bytes-Before, X-Glb-Bytes-After, X-Glb-Compression-Applied",
  );
  h.set("Access-Control-Max-Age", "86400");
  return h;
}

function encodePublicPath(key: string): string {
  return key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/** Only room sketch uploads use this prefix (see POST key). */
function isAllowedR2Key(key: string): boolean {
  if (!key || key.includes("..") || key.startsWith("/")) return false;
  return key.startsWith("sketches/");
}

function keyFromPublicReadUrl(fullUrl: string, publicBase: string): string | null {
  const b = publicBase.replace(/\/$/, "");
  const u = fullUrl.trim();
  if (!u.startsWith(`${b}/`)) return null;
  const rest = u.slice(b.length + 1);
  if (!rest || rest.includes("..")) return null;
  return rest.split("/").map((s) => decodeURIComponent(s)).join("/");
}

export async function OPTIONS(request: NextRequest) {
  ensureRepoEnvLoaded();
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request: NextRequest) {
  ensureRepoEnvLoaded();
  const cors = corsHeaders(request);

  const expected = process.env.EXPORT_UPLOAD_TOKEN?.trim();
  if (!expected) {
    const root = findRepoRoot();
    const envLocal = path.join(root, ".env.local");
    const payload: Record<string, unknown> = {
      error: "server_misconfigured",
      reason: "missing_EXPORT_UPLOAD_TOKEN",
    };
    if (process.env.NODE_ENV === "development") {
      payload.debug = {
        resolvedRoot: root,
        envLocalPath: envLocal,
        envLocalExists: fs.existsSync(envLocal),
      };
    }
    return NextResponse.json(payload, { status: 503, headers: cors });
  }

  const got = parseBearerToken(request);
  if (!got || got !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: cors });
  }

  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET_NAME?.trim();

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    const missing: string[] = [];
    if (!accountId) missing.push("R2_ACCOUNT_ID");
    if (!accessKeyId) missing.push("R2_ACCESS_KEY_ID");
    if (!secretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
    if (!bucket) missing.push("R2_BUCKET_NAME");
    const root = findRepoRoot();
    const envLocal = path.join(root, ".env.local");
    const payload: Record<string, unknown> = {
      error: "server_misconfigured",
      reason: "missing_r2_env",
      missing,
    };
    if (process.env.NODE_ENV === "development") {
      payload.debug = {
        resolvedRoot: root,
        envLocalPath: envLocal,
        envLocalExists: fs.existsSync(envLocal),
      };
    }
    return NextResponse.json(payload, { status: 503, headers: cors });
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  const roomRaw = request.headers.get("x-sketchar-room") ?? "unknown";
  const safeRoom =
    roomRaw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "unknown";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const key = `sketches/${safeRoom}/${ts}-${rand}.glb`;

  const rawBody = Buffer.from(await request.arrayBuffer());
  if (rawBody.length === 0) {
    return NextResponse.json({ error: "empty_body" }, { status: 400, headers: cors });
  }

  const maxBytes = getWaldenGlbMaxBytes();
  if (rawBody.length > maxBytes) {
    return NextResponse.json(
      { error: "payload_too_large", maxBytes },
      { status: 413, headers: cors },
    );
  }

  const bytesBefore = rawBody.length;
  let uploadBody: Buffer;
  let compressionApplied = false;
  if (rawBody.length < SKIP_COMPRESS_BELOW_BYTES) {
    uploadBody = rawBody;
    compressionApplied = false;
  } else {
    try {
      const opt = await optimizeWaldenGlbBuffer(rawBody);
      uploadBody = opt.buffer;
      compressionApplied = opt.compressionApplied;
    } catch (e) {
      console.warn("[export-glb] optimizeWaldenGlbBuffer failed, uploading original", e);
      uploadBody = rawBody;
      compressionApplied = false;
    }
  }

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: uploadBody,
      ContentType: "model/gltf-binary",
    }),
  );

  const publicBase = process.env.PUBLIC_R2_READ_URL?.trim();
  const url = publicBase
    ? `${publicBase.replace(/\/$/, "")}/${encodePublicPath(key)}`
    : undefined;

  cors.set("X-Glb-Bytes-Before", String(bytesBefore));
  cors.set("X-Glb-Bytes-After", String(uploadBody.length));
  cors.set("X-Glb-Compression-Applied", compressionApplied ? "1" : "0");

  return NextResponse.json(
    url
      ? { ok: true, key, url, compressionApplied, bytesBefore, bytesAfter: uploadBody.length }
      : { ok: true, key, compressionApplied, bytesBefore, bytesAfter: uploadBody.length },
    { status: 201, headers: cors },
  );
}

/**
 * Remove a room GLB from R2. Body: `{ "url": "<PUBLIC_R2_READ_URL>/sketches/…" }`.
 * URL must match `PUBLIC_R2_READ_URL` and key must start with `sketches/`.
 */
export async function DELETE(request: NextRequest) {
  ensureRepoEnvLoaded();
  const cors = corsHeaders(request);

  const expected = process.env.EXPORT_UPLOAD_TOKEN?.trim();
  if (!expected) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 503, headers: cors });
  }

  const got = parseBearerToken(request);
  if (!got || got !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: cors });
  }

  const publicBase = process.env.PUBLIC_R2_READ_URL?.trim();
  if (!publicBase) {
    return NextResponse.json(
      { error: "server_misconfigured", reason: "missing_PUBLIC_R2_READ_URL" },
      { status: 503, headers: cors },
    );
  }

  let body: { url?: unknown };
  try {
    body = (await request.json()) as { url?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: cors });
  }
  const urlStr = typeof body.url === "string" ? body.url.trim() : "";
  if (!urlStr) {
    return NextResponse.json({ error: "missing_url" }, { status: 400, headers: cors });
  }

  const key = keyFromPublicReadUrl(urlStr, publicBase);
  if (!key || !isAllowedR2Key(key)) {
    return NextResponse.json({ error: "invalid_or_forbidden_url" }, { status: 400, headers: cors });
  }

  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET_NAME?.trim();

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    return NextResponse.json({ error: "server_misconfigured", reason: "missing_r2_env" }, { status: 503, headers: cors });
  }

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    console.warn("[export-glb] DeleteObject failed", e);
    return NextResponse.json({ error: "delete_failed" }, { status: 502, headers: cors });
  }

  return NextResponse.json({ ok: true, key }, { status: 200, headers: cors });
}
