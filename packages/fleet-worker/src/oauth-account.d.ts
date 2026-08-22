export function xAccountEmail(xid: string | null | undefined): string;
export function googleProfileEmail(
  me: { email?: string; verified_email?: boolean } | null | undefined,
): { ok: true; email: string } | { ok: false; error: string };
