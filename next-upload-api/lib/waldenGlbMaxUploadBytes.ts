/**
 * Max upload size for GLB endpoints (matches Walden-style env naming).
 * @default 100 (MB)
 */
export function getWaldenGlbMaxBytes(): number {
  const raw = process.env.WALDEN_GLB_MAX_UPLOAD_MB?.trim();
  const mb = raw != null && raw !== "" ? Number(raw) : 100;
  if (!Number.isFinite(mb) || mb <= 0) return 100 * 1024 * 1024;
  return Math.floor(mb * 1024 * 1024);
}
