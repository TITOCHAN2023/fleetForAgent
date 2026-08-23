export type BanActorUser = {
  id?: string;
  email?: string;
  banned?: boolean;
  bannedAt?: number;
};

export function isBanned(user: { banned?: boolean } | null | undefined): boolean;
export function rejectIfBanned(
  user: { banned?: boolean } | null | undefined,
): { error: "banned"; status: 403 } | null;
export function applyBanFields<T extends BanActorUser>(user: T, now?: number): T;
export function oauthCallbackFail(body: { error?: string } | null | undefined): {
  message: string;
  status: number;
};
