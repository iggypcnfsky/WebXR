import { normalizeRoomCode } from "./roomCode.js";

const STORAGE_KEY = "sketchar_room_history_v1";
const MAX_ENTRIES = 20;

/**
 * @returns {{ code: string, at: number }[]}
 */
export function loadRoomHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out = [];
    const seen = new Set();
    for (const x of arr) {
      if (!x || typeof x.code !== "string") continue;
      const code = normalizeRoomCode(x.code);
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        at: typeof x.at === "number" && Number.isFinite(x.at) ? x.at : 0,
      });
    }
    return out.slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * @param {string} rawCode
 */
export function rememberRoom(rawCode) {
  const code = normalizeRoomCode(rawCode || "");
  if (!code) return;
  let list = loadRoomHistory().filter((x) => x.code !== code);
  list.unshift({ code, at: Date.now() });
  list = list.slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
