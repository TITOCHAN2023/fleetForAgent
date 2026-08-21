import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { kickUser } from "./live";
import { mintHubToken } from "./token";

export type HubTokenMeta = {
  hasToken: boolean;
  prefix: string;
  createdAt: string;
};

export const getHubTokenMeta = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<HubTokenMeta> => {
    const sql = await getSql();
    const rows = await sql<{ token_prefix: string; created_at: string | Date }>`
      select token_prefix, created_at from hub_tokens where user_id = ${context.userId}
    `;
    const row = rows[0];
    if (!row) return { hasToken: false, prefix: "", createdAt: "" };
    return {
      hasToken: true,
      prefix: row.token_prefix,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    };
  });

export const issueHubToken = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(() => true)
  .handler(async ({ context }) => {
    const minted = mintHubToken();
    const sql = await getSql();
    await sql`
      insert into hub_tokens (user_id, token_hash, token_prefix, created_at)
      values (${context.userId}, ${minted.hash}, ${minted.prefix}, now())
      on conflict (user_id) do update
        set token_hash = excluded.token_hash,
            token_prefix = excluded.token_prefix,
            created_at = now()
    `;
    kickUser(context.userId);
    return { token: minted.raw, prefix: minted.prefix };
  });
