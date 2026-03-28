import { Document, NodeIO, ImageUtils } from "@gltf-transform/core";
import {
  EXTTextureWebP,
  KHRDracoMeshCompression,
  KHRMeshQuantization,
  KHRTextureBasisu,
} from "@gltf-transform/extensions";
import { dedup, draco, prune, textureCompress } from "@gltf-transform/functions";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import type { Texture } from "@gltf-transform/core";

const requireFromHere = createRequire(import.meta.url);

export type WaldenGlbOptimizeResult = {
  buffer: Buffer;
  compressionApplied: boolean;
  stages: { webp: boolean; draco: boolean };
};

function getTextureMaxEdgePx(): number | null {
  const raw = process.env.WALDEN_GLB_TEXTURE_MAX_EDGE?.trim();
  const n =
    raw != null && raw !== "" ? parseInt(String(raw), 10) : 1024;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(16384, n);
}

function getWebpQuality(): number {
  const raw = process.env.WALDEN_GLB_WEBP_QUALITY?.trim();
  const n = raw != null && raw !== "" ? Number(raw) : 78;
  if (!Number.isFinite(n)) return 78;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function resolveDracoEncoderWasmPath(): string {
  const tryPath = (base: string) =>
    path.join(base, "node_modules", "draco3d", "draco_encoder.wasm");
  const list: string[] = [tryPath(process.cwd())];
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 18; i++) {
    list.push(tryPath(dir));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const p of list) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("draco_encoder.wasm not found under node_modules/draco3d");
}

function resolveLoadersGlTexturesLibsDir(): string | null {
  const tryDir = (base: string) => {
    const d = path.join(
      base,
      "node_modules",
      "@loaders.gl",
      "textures",
      "dist",
      "libs",
    );
    return fs.existsSync(path.join(d, "basis_encoder.js")) ? d : null;
  };
  let d = tryDir(process.cwd());
  if (d) return d;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 18; i++) {
    d = tryDir(dir);
    if (d) return d;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let dracoEncoderPromise: Promise<unknown> | null = null;

async function getDracoEncoderModule(): Promise<unknown> {
  dracoEncoderPromise ??= (async () => {
    const wasmPath = resolveDracoEncoderWasmPath();
    const buf = fs.readFileSync(wasmPath);
    const wasmBinary = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    );
    const draco3d = (await import("draco3d")).default;
    return draco3d.createEncoderModule({ wasmBinary });
  })();
  return dracoEncoderPromise;
}

const BASIS_RGBA32 = 13;

function textureIsNormalMap(texture: Texture, document: Document): boolean {
  for (const m of document.getRoot().listMaterials()) {
    if (m.getNormalTexture() === texture) return true;
  }
  return false;
}

function inferTextureMimeTypes(document: Document): void {
  for (const texture of document.getRoot().listTextures()) {
    const mime = texture.getMimeType();
    const image = texture.getImage();
    if (!image) continue;
    if (!mime || mime === "application/octet-stream") {
      const detected = ImageUtils.getMimeType(image);
      if (detected) texture.setMimeType(detected);
    }
  }
}

async function convertKtx2TexturesToWebpRasters(document: Document): Promise<void> {
  const libsDir = resolveLoadersGlTexturesLibsDir();
  if (!libsDir) return;

  let KTX2File: new (data: Uint8Array) => {
    startTranscoding: () => boolean;
    getImageLevelInfo: (
      level: number,
      layer: number,
      face: number,
    ) => { width: number; height: number; alphaFlag: boolean };
    getImageTranscodedSizeInBytes: (
      level: number,
      layer: number,
      face: number,
      format: number,
    ) => number;
    transcodeImage: (
      dst: Uint8Array,
      level: number,
      layer: number,
      face: number,
      format: number,
      a: number,
      b: number,
      c: number,
    ) => boolean;
    close: () => void;
    delete: () => void;
  };
  let initializeBasis: () => void;

  try {
    const wasmPath = path.join(libsDir, "basis_encoder.wasm");
    const jsPath = path.join(libsDir, "basis_encoder.js");
    if (!fs.existsSync(wasmPath) || !fs.existsSync(jsPath)) return;

    const buf = fs.readFileSync(wasmPath);
    const wasmBinary = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BasisEncoderFactory = requireFromHere(jsPath) as (
      opts: { wasmBinary?: ArrayBuffer },
    ) => Promise<Record<string, unknown>>;
    const mod = (await BasisEncoderFactory({ wasmBinary })) as {
      KTX2File: typeof KTX2File;
      initializeBasis: () => void;
    };
    KTX2File = mod.KTX2File;
    initializeBasis = mod.initializeBasis;
    initializeBasis();
  } catch {
    return;
  }

  const maxEdge = getTextureMaxEdgePx();
  const webpQ = getWebpQuality();
  let hadKtx2 = false;

  for (const texture of document.getRoot().listTextures()) {
    if (texture.getMimeType() !== "image/ktx2") continue;
    const image = texture.getImage();
    if (!image) continue;
    hadKtx2 = true;

    const ktx2File = new KTX2File(new Uint8Array(image));
    try {
      if (!ktx2File.startTranscoding()) continue;
      const level = 0;
      const { width, height } = ktx2File.getImageLevelInfo(level, 0, 0);
      const decodedSize = ktx2File.getImageTranscodedSizeInBytes(
        level,
        0,
        0,
        BASIS_RGBA32,
      );
      const decodedData = new Uint8Array(decodedSize);
      if (
        !ktx2File.transcodeImage(
          decodedData,
          level,
          0,
          0,
          BASIS_RGBA32,
          0,
          -1,
          -1,
        )
      ) {
        continue;
      }
      const isNormal = textureIsNormalMap(texture, document);
      let pipeline = sharp(Buffer.from(decodedData), {
        raw: { width, height, channels: 4 },
      });
      if (maxEdge != null) {
        pipeline = pipeline.resize(maxEdge, maxEdge, {
          fit: "inside",
          withoutEnlargement: true,
        });
      }
      const webpBuf = isNormal
        ? await pipeline.webp({ quality: 92, nearLossless: true }).toBuffer()
        : await pipeline.webp({ quality: webpQ }).toBuffer();
      texture.setImage(new Uint8Array(webpBuf));
      texture.setMimeType("image/webp");
    } finally {
      ktx2File.close();
      ktx2File.delete();
    }
  }

  if (hadKtx2) {
    const stillKtx2 = document
      .getRoot()
      .listTextures()
      .some((t) => t.getMimeType() === "image/ktx2");
    if (!stillKtx2) {
      document.disposeExtension(KHRTextureBasisu.EXTENSION_NAME);
    }
  }
}

/**
 * Walden-style GLB optimize: WebP textures, Draco meshes, size gate (keep original if not smaller).
 */
export async function optimizeWaldenGlbBuffer(
  input: Buffer,
): Promise<WaldenGlbOptimizeResult> {
  const bytesBefore = input.length;
  const encoder = await getDracoEncoderModule();
  const io = new NodeIO()
    .registerExtensions([
      EXTTextureWebP,
      KHRTextureBasisu,
      KHRDracoMeshCompression,
      KHRMeshQuantization,
    ])
    .registerDependencies({
      "draco3d.encoder": encoder,
    });

  let document: Document;
  try {
    document = await io.readBinary(input);
  } catch (e) {
    console.warn("[waldenGlbOptimize] readBinary failed, returning original", e);
    return {
      buffer: input,
      compressionApplied: false,
      stages: { webp: false, draco: false },
    };
  }

  document.createExtension(EXTTextureWebP).setRequired(true);

  inferTextureMimeTypes(document);
  await convertKtx2TexturesToWebpRasters(document);

  const maxEdge = getTextureMaxEdgePx();
  const webpQuality = getWebpQuality();
  const resizeTuple: [number, number] | undefined =
    maxEdge != null ? [maxEdge, maxEdge] : undefined;

  const baseCompress = {
    encoder: sharp,
    targetFormat: "webp" as const,
    limitInputPixels: false as const,
    ...(resizeTuple ? { resize: resizeTuple } : {}),
  };

  try {
    await document.transform(
      dedup(),
      prune(),
      textureCompress({
        ...baseCompress,
        quality: webpQuality,
        slots: /^(?!.*normal).*$/i,
      }),
      textureCompress({
        ...baseCompress,
        quality: 92,
        nearLossless: true,
        slots: /normal/i,
      }),
      draco(),
      prune(),
    );
  } catch (e) {
    console.warn("[waldenGlbOptimize] transform failed, returning original", e);
    return {
      buffer: input,
      compressionApplied: false,
      stages: { webp: false, draco: false },
    };
  }

  const out = Buffer.from(await io.writeBinary(document));
  const candidateLen = out.length;

  if (candidateLen < bytesBefore) {
    return {
      buffer: out,
      compressionApplied: true,
      stages: { webp: true, draco: true },
    };
  }

  return {
    buffer: input,
    compressionApplied: false,
    stages: { webp: false, draco: false },
  };
}
