/**
 * Device occupancy. HTTP /v1/run already checks owns().
 * WebSocket /v1/device must use the same rule before accept + kick.
 */

export function canClaimDevice(prevUserId, actorId) {
  const prev = String(prevUserId || "").trim();
  const actor = String(actorId || "").trim();
  if (!actor) return false;
  if (!prev) return true;
  return prev === actor;
}

/** Upsert may omit userId (heartbeat). Only reject when both sides name different owners. */
export function deviceOwnerConflict(prevUserId, nextUserId) {
  const prev = String(prevUserId || "").trim();
  const next = String(nextUserId || "").trim();
  if (!prev || !next) return false;
  return prev !== next;
}
