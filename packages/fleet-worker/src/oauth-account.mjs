/** X account key is the numeric user id. Usernames can be renamed and reused. */
export function xAccountEmail(xid) {
  const id = String(xid || "").trim();
  if (!id) return "";
  return `${id}@x.oauth.fleet`;
}

/** Google userinfo must include a verified email. */
export function googleProfileEmail(me) {
  const email = String(me?.email || "")
    .trim()
    .toLowerCase();
  if (!email) return { ok: false, error: "google 未返回邮箱" };
  if (me?.verified_email !== true) return { ok: false, error: "google 邮箱未验证" };
  return { ok: true, email };
}
