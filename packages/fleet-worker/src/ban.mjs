/** User-row `banned` / `bannedAt`. Login and invoke return 403. Ops may set the flag; Ban cannot operate machines. */

export function isBanned(user) {
  return Boolean(user && user.banned);
}

export function rejectIfBanned(user) {
  if (isBanned(user)) return { error: "banned", status: 403 };
  return null;
}

export function applyBanFields(user, now = Date.now()) {
  user.banned = true;
  if (user.bannedAt == null) user.bannedAt = now;
  return user;
}

export function applyBannedState(user, banned, now = Date.now()) {
  if (banned) return applyBanFields(user, now);
  user.banned = false;
  return user;
}

export function oauthCallbackFail(body) {
  const err = body && typeof body.error === "string" ? body.error : "";
  if (err === "banned") return { message: "账号已停用", status: 403 };
  return { message: err || "oauth failed", status: 400 };
}
