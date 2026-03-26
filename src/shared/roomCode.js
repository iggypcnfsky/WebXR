/** Room codes are stored uppercase (A–Z + 0–9); input is normalized for joins and URLs. */
export function normalizeRoomCode(s) {
  return String(s ?? "").trim().toUpperCase();
}
