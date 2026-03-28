import { createClient } from "@supabase/supabase-js";

/** @type {import("@supabase/supabase-js").SupabaseClient | null} */
let _client = null;

export function isSketcharConfigured() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  return !!(url && key && String(url).trim() && String(key).trim());
}

export function getSketcharSupabase() {
  if (!isSketcharConfigured()) return null;
  if (!_client) {
    _client = createClient(
      String(import.meta.env.VITE_SUPABASE_URL).trim(),
      String(import.meta.env.VITE_SUPABASE_ANON_KEY).trim(),
    );
  }
  return _client;
}

/** Same alphabet as legacy server (digits + A–Z). */
const ROOM_CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function randomRoomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @returns {Promise<{ id: string, slug: string }>}
 */
export async function createRoom(supabase) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const slug = randomRoomCode();
    const { data, error } = await supabase
      .from("rooms")
      .insert({ slug, name: "Sketchar" })
      .select("id, slug")
      .single();
    if (error) {
      if (error.code === "23505") continue;
      throw error;
    }
    if (!data?.slug || String(data.slug).trim().length !== 4) {
      throw new Error("bad_room_code");
    }
    return { id: data.id, slug: String(data.slug).trim() };
  }
  throw new Error("could_not_allocate_code");
}

function mapAlignmentRow(al) {
  if (!al) return null;
  return {
    matrix: al.matrix_json,
    questPin: al.quest_pin_json,
    phonePin: al.phone_pin_json,
    updatedAt: al.updated_at,
  };
}

/** Normalize PostgREST 1:1 embed (object | single-element array | null). */
function oneToOneRow(embed) {
  if (embed == null) return null;
  if (Array.isArray(embed)) return embed[0] ?? null;
  return embed;
}

/**
 * Single round-trip load (avoids N+1 sequential queries per Supabase Postgres data-access guidance).
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} slugNormalized
 */
export async function fetchRoomBySlug(supabase, slugNormalized) {
  const { data, error } = await supabase
    .from("rooms")
    .select(
      `
      id,
      slug,
      room_snapshots ( payload, updated_at ),
      room_alignment ( matrix_json, quest_pin_json, phone_pin_json, updated_at )
    `,
    )
    .eq("slug", slugNormalized)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const snap = oneToOneRow(data.room_snapshots);
  const alRow = oneToOneRow(data.room_alignment);

  return {
    slug: data.slug,
    roomId: data.id,
    snapshot: snap?.payload ?? null,
    snapshotUpdatedAt: snap?.updated_at ?? null,
    alignment: mapAlignmentRow(alRow),
  };
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} roomId
 * @param {unknown} payload
 */
export async function upsertSnapshot(supabase, roomId, payload) {
  const { data, error } = await supabase
    .from("room_snapshots")
    .upsert(
      { room_id: roomId, last_event_id: 0, payload },
      { onConflict: "room_id" },
    )
    .select("updated_at")
    .single();
  if (error) throw error;
  return { updatedAt: data?.updated_at ?? null };
}

/**
 * Atomic merge + upsert in Postgres (`merge_room_pin`): one round trip, short transaction.
 *
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} roomId
 * @param {"quest"|"phone"} device
 * @param {[number, number, number]} position
 */
export async function upsertPin(supabase, roomId, device, position) {
  const { data, error } = await supabase.rpc("merge_room_pin", {
    p_room_id: roomId,
    p_device: device,
    p_position: position,
  });
  if (error) throw error;
  return { alignmentReady: data?.alignmentReady === true };
}

/** Realtime Broadcast — head + viewer cameras. Requires Broadcast enabled in Supabase Realtime settings. */
export const SKETCHAR_PRESENCE_EVENT = "sketchar_presence";

function num(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Left/right hand: 5 finger tips × xyz in stroke space. */
function parseFingerTipArray15(raw) {
  if (!Array.isArray(raw) || raw.length < 15) return null;
  const out = /** @type {number[]} */ ([]);
  for (let i = 0; i < 15; i++) {
    const v = num(raw[i]);
    if (!Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
}

/**
 * Supabase Realtime may deliver broadcast as `msg.payload`, nested `payload.payload`,
 * `msg.data`, or the body itself (see Realtime server / client version).
 */
function extractPresenceBroadcastRaw(msg) {
  if (msg == null || typeof msg !== "object") return null;
  const m = /** @type {Record<string, unknown>} */ (msg);
  /** @param {unknown} o */
  const looksLikePresence = (o) =>
    o != null &&
    typeof o === "object" &&
    "deviceId" in /** @type {object} */ (o) &&
    ("mode" in /** @type {object} */ (o) || "x" in /** @type {object} */ (o));

  if (looksLikePresence(m)) return /** @type {Record<string, unknown>} */ (m);

  let raw = m.payload;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object") {
    const inner = /** @type {Record<string, unknown>} */ (raw);
    if (looksLikePresence(inner)) {
      return /** @type {Record<string, unknown>} */ (inner);
    }
    if (
      typeof inner.payload === "object" &&
      inner.payload !== null &&
      "deviceId" in /** @type {object} */ (inner.payload)
    ) {
      raw = inner.payload;
    }
    if (
      inner.type === "broadcast" &&
      typeof inner.payload === "object" &&
      inner.payload !== null &&
      "deviceId" in /** @type {object} */ (inner.payload)
    ) {
      raw = inner.payload;
    }
  }
  if (raw == null || typeof raw !== "object") {
    if ("deviceId" in m) return m;
    if (typeof m.data === "object" && m.data !== null && "deviceId" in /** @type {object} */ (m.data)) {
      return /** @type {Record<string, unknown>} */ (m.data);
    }
    return null;
  }
  return /** @type {Record<string, unknown>} */ (raw);
}

function dispatchPresenceFromBroadcastMsg(
  msg,
  onPresence,
) {
  if (!onPresence) return;
  let pr = parsePresenceBroadcastMessage(msg);
  if (!pr) pr = parsePresenceBroadcastMessage({ payload: msg });
  if (!pr && msg && typeof msg === "object" && "payload" in msg) {
    pr = parsePresenceBroadcastMessage(/** @type {Record<string, unknown>} */ (msg).payload);
  }
  if (pr) {
    try {
      onPresence(pr);
    } catch (e) {
      console.warn("[sketchar] presence handler failed", e);
    }
  }
}

function parsePresenceBroadcastMessage(msg) {
  const raw = extractPresenceBroadcastRaw(msg);
  if (!raw) return null;
  const p = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
  if (!p) return null;
  const deviceId = typeof p.deviceId === "string" ? p.deviceId.trim() : "";
  if (!deviceId) return null;
  const label = typeof p.label === "string" ? p.label : "Device";
  const mode = p.mode === "xr_head" || p.mode === "viewer_camera" ? p.mode : null;
  if (!mode) return null;
  const x = num(p.x);
  const y = num(p.y);
  const z = num(p.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  /** @type {import("./sketcharPresence.js").SketcharPresencePayload} */
  const out = { deviceId, label, mode, x, y, z };
  const qx = num(p.qx);
  const qy = num(p.qy);
  const qz = num(p.qz);
  const qw = num(p.qw);
  const haveQ =
    Number.isFinite(qx) &&
    Number.isFinite(qy) &&
    Number.isFinite(qz) &&
    Number.isFinite(qw);
  if (mode === "viewer_camera" && haveQ) {
    out.qx = qx;
    out.qy = qy;
    out.qz = qz;
    out.qw = qw;
  }
  if (mode === "viewer_camera" && p.followActive === true) {
    out.followActive = true;
  }
  if (mode === "xr_head" && haveQ) {
    out.qx = qx;
    out.qy = qy;
    out.qz = qz;
    out.qw = qw;
  }
  if (mode === "xr_head") {
    const sx = num(p.sx);
    const sy = num(p.sy);
    const sz = num(p.sz);
    if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sz)) {
      out.sx = sx;
      out.sy = sy;
      out.sz = sz;
      const sqx = num(p.sqx);
      const sqy = num(p.sqy);
      const sqz = num(p.sqz);
      const sqw = num(p.sqw);
      const haveSq =
        Number.isFinite(sqx) &&
        Number.isFinite(sqy) &&
        Number.isFinite(sqz) &&
        Number.isFinite(sqw);
      if (haveSq) {
        out.sqx = sqx;
        out.sqy = sqy;
        out.sqz = sqz;
        out.sqw = sqw;
      }
    }
    const lf = parseFingerTipArray15(p.lf);
    if (lf) out.lf = lf;
    const rf = parseFingerTipArray15(p.rf);
    if (rf) out.rf = rf;
  }
  return out;
}

/**
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} roomId
 * @param {{ onSnapshot?: (ev: { payload: unknown, updatedAt: string | null }) => void, onAlignment?: (ev: { matrix: unknown, questPin: unknown, phonePin: unknown, updatedAt: string | null }) => void, onPresence?: (p: import("./sketcharPresence.js").SketcharPresencePayload) => void }} handlers
 * @returns {{ unsubscribe: () => void, sendPresence: (payload: import("./sketcharPresence.js").SketcharPresencePayload) => void }}
 */
export function subscribeRoom(supabase, roomId, handlers) {
  const { onSnapshot, onAlignment, onPresence } = handlers;

  /** Postgres + DB sync only — keeps presence independent so preview browsers are not tied to postgres join health. */
  const dataChannel = supabase
    .channel(`sketchar:${roomId}`, {
      config: { broadcast: { ack: false } },
    })
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "room_snapshots",
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") return;
        const row = payload.new;
        if (!row) return;
        onSnapshot?.({
          payload: row.payload,
          updatedAt: row.updated_at != null ? String(row.updated_at) : null,
        });
      },
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "room_alignment",
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") return;
        const row = payload.new;
        if (!row) return;
        onAlignment?.({
          matrix: row.matrix_json,
          questPin: row.quest_pin_json,
          phonePin: row.phone_pin_json,
          updatedAt: row.updated_at != null ? String(row.updated_at) : null,
        });
      },
    )
    .subscribe();

  /** Dedicated topic so broadcast is not coupled to postgres_changes subscription (Quest vs desktop can differ). */
  const presenceChannel = supabase
    .channel(`sketchar-presence:${roomId}`, {
      config: { broadcast: { ack: false } },
    })
    .on("broadcast", { event: "*" }, (msg) => {
      dispatchPresenceFromBroadcastMsg(msg, onPresence);
    })
    .subscribe();

  const sendPresence = (
    /** @type {import("./sketcharPresence.js").SketcharPresencePayload} */ payload,
  ) => {
    try {
      void presenceChannel.send({
        type: "broadcast",
        event: SKETCHAR_PRESENCE_EVENT,
        payload,
      });
    } catch (e) {
      console.warn("[sketchar] sendPresence failed", e);
    }
  };

  return {
    unsubscribe: () => {
      void supabase.removeChannel(dataChannel);
      void supabase.removeChannel(presenceChannel);
    },
    sendPresence,
  };
}

/** Same topic as `subscribeRoom` postgres/data channel. */
export function sketcharRoomChannelName(roomId) {
  return `sketchar:${roomId}`;
}

/** Broadcast-only topic for presence (head + preview cameras). */
export function sketcharPresenceChannelName(roomId) {
  return `sketchar-presence:${roomId}`;
}

