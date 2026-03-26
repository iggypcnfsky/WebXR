/**
 * Sketchar API — Neon Postgres + Hono.
 * Run: node server/index.mjs  (port 3001)
 * Set DATABASE_URL in .env or .env.local (see .env.example)
 */
import dotenv from "dotenv";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";

dotenv.config({ path: resolve(process.cwd(), ".env") });
dotenv.config({ path: resolve(process.cwd(), ".env.local") });
import { Hono } from "hono";
import { cors } from "hono/cors";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  console.error("Missing DATABASE_URL. Copy .env.example to .env and set your Neon connection string.");
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);
const app = new Hono();

function normalizeRoomSlugParam(slug) {
  return String(slug ?? "").trim().toUpperCase();
}

app.use("/*", cors({ origin: "*" }));

app.get("/health", (c) => c.json({ ok: true, name: "Sketchar" }));

/** Create room with random 4-character slug (A–Z + 0–9) */
app.post("/api/rooms", async (c) => {
  for (let attempt = 0; attempt < 16; attempt++) {
    const slug = randomRoomCode();
    if (slug.length !== 4) continue;
    try {
      const rows =
        await sql`INSERT INTO rooms (slug, name) VALUES (${slug}, ${"Sketchar"}) RETURNING slug`;
      const row = rows[0];
      const out = String(
        row && typeof row === "object" ? row.slug ?? row[0] : "",
      ).trim();
      if (out.length !== 4) {
        console.error("Sketchar: unexpected slug from DB", row);
        return c.json({ error: "invalid_slug" }, 500);
      }
      // Only return `slug` so clients never confuse room code with UUID `id`.
      return c.json({ slug: out });
    } catch (e) {
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
  return c.json({ error: "could_not_allocate_code" }, 503);
});

/** Room state: snapshot + alignment pins */
app.get("/api/rooms/:slug", async (c) => {
  const normalized = normalizeRoomSlugParam(c.req.param("slug"));
  const rooms =
    await sql`SELECT id, slug FROM rooms WHERE UPPER(TRIM(slug::text)) = ${normalized} LIMIT 1`;
  if (!rooms.length) return c.json({ error: "not_found" }, 404);
  const canonicalSlug = String(rooms[0].slug ?? "").trim();
  const roomId = rooms[0].id;
  const snaps =
    await sql`SELECT payload, last_event_id, updated_at FROM room_snapshots WHERE room_id = ${roomId} LIMIT 1`;
  const aligns =
    await sql`SELECT matrix_json, quest_pin_json, phone_pin_json, updated_at FROM room_alignment WHERE room_id = ${roomId} LIMIT 1`;
  const snap = snaps[0];
  const al = aligns[0];
  return c.json({
    slug: canonicalSlug,
    roomId,
    snapshot: snap?.payload ?? null,
    snapshotUpdatedAt: snap?.updated_at ?? null,
    alignment: al
      ? {
          matrix: al.matrix_json,
          questPin: al.quest_pin_json,
          phonePin: al.phone_pin_json,
          updatedAt: al.updated_at,
        }
      : null,
  });
});

/** Upsert scene snapshot (Quest pushes) */
app.post("/api/rooms/:slug/snapshot", async (c) => {
  const normalized = normalizeRoomSlugParam(c.req.param("slug"));
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const payload = body.payload;
  if (payload === undefined) return c.json({ error: "missing_payload" }, 400);

  const rooms =
    await sql`SELECT id FROM rooms WHERE UPPER(TRIM(slug::text)) = ${normalized} LIMIT 1`;
  if (!rooms.length) return c.json({ error: "not_found" }, 404);
  const roomId = rooms[0].id;
  const jsonStr = JSON.stringify(payload);

  await sql`
    INSERT INTO room_snapshots (room_id, last_event_id, payload, updated_at)
    VALUES (${roomId}, 0, ${jsonStr}::jsonb, now())
    ON CONFLICT (room_id) DO UPDATE SET
      payload = ${jsonStr}::jsonb,
      updated_at = now()
  `;
  return c.json({ ok: true });
});

/**
 * Pin handshake: device quest | phone, position [x,y,z] in that device's space.
 * When both pins exist, stores translation matrix (phone origin offset).
 */
app.post("/api/rooms/:slug/pin", async (c) => {
  const normalized = normalizeRoomSlugParam(c.req.param("slug"));
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const device = body.device;
  const position = body.position;
  if (device !== "quest" && device !== "phone")
    return c.json({ error: "bad_device" }, 400);
  if (
    !Array.isArray(position) ||
    position.length !== 3 ||
    !position.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    return c.json({ error: "bad_position" }, 400);
  }

  const rooms =
    await sql`SELECT id FROM rooms WHERE UPPER(TRIM(slug::text)) = ${normalized} LIMIT 1`;
  if (!rooms.length) return c.json({ error: "not_found" }, 404);
  const roomId = rooms[0].id;

  const existing =
    await sql`SELECT quest_pin_json, phone_pin_json FROM room_alignment WHERE room_id = ${roomId} LIMIT 1`;

  let questPin = existing[0]?.quest_pin_json ?? null;
  let phonePin = existing[0]?.phone_pin_json ?? null;

  const newPin = { p: position };
  if (device === "quest") questPin = newPin;
  else phonePin = newPin;

  function posFromPin(j) {
    if (j == null) return null;
    const o = typeof j === "string" ? JSON.parse(j) : j;
    return o && Array.isArray(o.p) ? o.p : null;
  }

  let matrixJson = null;
  const qPos = posFromPin(questPin);
  const pPos = posFromPin(phonePin);
  if (qPos && pPos) {
    const tx = pPos[0] - qPos[0];
    const ty = pPos[1] - qPos[1];
    const tz = pPos[2] - qPos[2];
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
    matrixJson = JSON.stringify(m);
  }

  const qs = JSON.stringify(questPin);
  const ps = JSON.stringify(phonePin);

  await sql`
    INSERT INTO room_alignment (room_id, matrix_json, quest_pin_json, phone_pin_json, updated_at)
    VALUES (${roomId}, ${matrixJson}::jsonb, ${qs}::jsonb, ${ps}::jsonb, now())
    ON CONFLICT (room_id) DO UPDATE SET
      quest_pin_json = ${qs}::jsonb,
      phone_pin_json = ${ps}::jsonb,
      matrix_json = ${matrixJson}::jsonb,
      updated_at = now()
  `;

  return c.json({
    ok: true,
    alignmentReady: matrixJson != null,
  });
});

/** 4 chars: digits + uppercase letters (easy to read/type on Quest). */
const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomRoomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return out;
}

function isUniqueViolation(err) {
  const code = err?.code ?? err?.cause?.code;
  return code === "23505";
}

const port = Number(process.env.PORT) || 3001;
console.log(`Sketchar API listening on http://127.0.0.1:${port}`);
serve({ fetch: app.fetch, port });
