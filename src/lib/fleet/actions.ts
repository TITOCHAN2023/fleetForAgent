import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import { makeEnvelope, type OsKind } from "./protocol";
import { type ShellDevice } from "./shell";
import { dispatchHello, dispatchRun } from "./hub";
import { resolveNode } from "./world";
import { assertCanAddDevice, makeDeviceSlug } from "./cap";

export type DeviceDto = {
  id: string;
  slug: string;
  name: string;
  os: OsKind;
  arch: string;
  locationTag: string;
  status: "online" | "offline";
  caps: string[];
  lastSeen: string;
  selected: boolean;
  podId: string;
  egress: "internet";
};

export type CommandDto = {
  id: string;
  deviceId: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  status: string;
  createdAt: string;
};

export type ProtocolDto = {
  id: string;
  deviceId: string | null;
  direction: "up" | "down";
  type: string;
  envelope: string;
  createdAt: string;
};

export type EnrollDto = {
  id: string;
  code: string;
  expiresAt: string;
  usedAt: string | null;
};

type DeviceRow = {
  id: string;
  slug: string;
  name: string;
  os: string;
  arch: string;
  location_tag: string;
  status: string;
  caps: string;
  last_seen: string | Date;
  selected_device_id: string | null;
};

type CommandRow = {
  id: string;
  device_id: string;
  command: string;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  status: string;
  created_at: string | Date;
};

type EventRow = {
  id: string;
  device_id: string | null;
  direction: string;
  type: string;
  envelope: string;
  created_at: string | Date;
};

function iso(v: string | Date | null | undefined) {
  if (!v) return "";
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapDevice(row: DeviceRow): DeviceDto {
  const net = resolveNode({
    slug: row.slug,
    name: row.name,
    os: row.os as OsKind,
    arch: row.arch,
    locationTag: row.location_tag,
  });
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    os: row.os as OsKind,
    arch: row.arch,
    locationTag: row.location_tag,
    status: row.status === "offline" ? "offline" : "online",
    caps: (row.caps || "shell").split(",").filter(Boolean),
    lastSeen: iso(row.last_seen),
    selected: row.selected_device_id === row.id,
    podId: net.podId,
    egress: "internet",
  };
}

async function dropDemoSeeds(userId: string) {
  const sql = await getSql();
  await sql`
    delete from devices
    where user_id = ${userId}
      and slug in ('mac-mini-home', 'linux-colo-1', 'win-cloud-gpu')
  `;
}

async function recordEvent(
  userId: string,
  deviceId: string | null,
  direction: "up" | "down",
  env: ReturnType<typeof makeEnvelope>,
) {
  const sql = await getSql();
  await sql`
    insert into protocol_events (id, user_id, device_id, direction, type, envelope)
    values (${env.id}, ${userId}, ${deviceId}, ${direction}, ${env.type}, ${JSON.stringify(env)})
  `;
  await sql`
    delete from protocol_events
    where user_id = ${userId}
      and id not in (
        select id from protocol_events
        where user_id = ${userId}
        order by created_at desc
        limit 80
      )
  `;
}

export const listDevices = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    await dropDemoSeeds(context.userId);
    const sql = await getSql();
    await sql`
      update devices set last_seen = now()
      where user_id = ${context.userId} and status = 'online'
    `;
    const rows = await sql<DeviceRow>`
      select d.id, d.slug, d.name, d.os, d.arch, d.location_tag, d.status, d.caps, d.last_seen,
             s.selected_device_id
      from devices d
      left join hub_sessions s on s.user_id = d.user_id
      where d.user_id = ${context.userId}
      order by d.created_at asc
    `;
    return rows.map(mapDevice);
  });

export const selectDevice = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: string) => id)
  .handler(async ({ context, data: id }) => {
    const sql = await getSql();
    const found = await sql<{ id: string }>`
      select id from devices where id = ${id} and user_id = ${context.userId}
    `;
    if (!found[0]) throw new Error("Device not found");
    await sql`
      insert into hub_sessions (user_id, selected_device_id, selected_at)
      values (${context.userId}, ${id}, now())
      on conflict (user_id) do update set selected_device_id = excluded.selected_device_id, selected_at = now()
    `;
    const env = makeEnvelope("hello_ok", { selected: id });
    await recordEvent(context.userId, id, "down", env);
    return { ok: true as const, id };
  });

export const toggleDevice = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string; status: "online" | "offline" }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    await sql`
      update devices
      set status = ${data.status}, last_seen = now()
      where id = ${data.id} and user_id = ${context.userId}
    `;
    const env = makeEnvelope(data.status === "online" ? "hello" : "offline", {
      device_id: data.id,
    });
    await recordEvent(context.userId, data.id, "up", env);
    if (data.status === "online") {
      const row = await sql<DeviceRow>`
        select d.id, d.slug, d.name, d.os, d.arch, d.location_tag, d.status, d.caps, d.last_seen,
               s.selected_device_id
        from devices d
        left join hub_sessions s on s.user_id = d.user_id
        where d.id = ${data.id} and d.user_id = ${context.userId}
      `;
      if (row[0]) {
        const hello = dispatchHello({
          name: row[0].name,
          slug: row[0].slug,
          os: row[0].os as OsKind,
          arch: row[0].arch,
          locationTag: row[0].location_tag,
        });
        for (const ev of hello) {
          await recordEvent(context.userId, data.id, ev.direction, ev.envelope);
        }
      }
    }
    return { ok: true as const };
  });

export const runCommand = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((command: string) => command)
  .handler(async ({ context, data: raw }) => {
    const command = raw.trim();
    if (!command) {
      return {
        id: "",
        status: "error" as const,
        exitCode: 1,
        stdout: "",
        stderr: "empty command",
        deviceId: "",
      };
    }
    const sql = await getSql();
    const sess = await sql<{ selected_device_id: string | null }>`
      select selected_device_id from hub_sessions where user_id = ${context.userId}
    `;
    const deviceId = sess[0]?.selected_device_id;
    if (!deviceId) {
      return {
        id: crypto.randomUUID(),
        status: "error" as const,
        exitCode: 1,
        stdout: "",
        stderr: "no computer selected — call select_computer first",
        deviceId: "",
      };
    }
    const rows = await sql<DeviceRow>`
      select d.id, d.slug, d.name, d.os, d.arch, d.location_tag, d.status, d.caps, d.last_seen,
             s.selected_device_id
      from devices d
      left join hub_sessions s on s.user_id = d.user_id
      where d.id = ${deviceId} and d.user_id = ${context.userId}
    `;
    const device = rows[0];
    if (!device) {
      return {
        id: crypto.randomUUID(),
        status: "error" as const,
        exitCode: 1,
        stdout: "",
        stderr: "selected computer is gone",
        deviceId,
      };
    }

    const shellDevice: ShellDevice = {
      name: device.name,
      slug: device.slug,
      os: device.os as OsKind,
      arch: device.arch,
      locationTag: device.location_tag,
    };
    const dispatched = dispatchRun({
      device: shellDevice,
      online: device.status === "online",
      command,
    });
    for (const ev of dispatched.events) {
      await recordEvent(context.userId, device.id, ev.direction, ev.envelope);
    }
    await sql`
      insert into commands (id, user_id, device_id, command, exit_code, stdout, stderr, status)
      values (
        ${dispatched.corr},
        ${context.userId},
        ${device.id},
        ${command},
        ${dispatched.exitCode},
        ${dispatched.stdout},
        ${dispatched.stderr},
        ${dispatched.status}
      )
    `;
    await sql`
      delete from commands
      where user_id = ${context.userId}
        and id not in (
          select id from commands where user_id = ${context.userId}
          order by created_at desc limit 40
        )
    `;
    return {
      id: dispatched.corr,
      status: dispatched.status,
      exitCode: dispatched.exitCode,
      stdout: dispatched.stdout,
      stderr: dispatched.stderr,
      deviceId: device.id,
    };
  });

export const listCommands = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<CommandRow>`
      select id, device_id, command, exit_code, stdout, stderr, status, created_at
      from commands
      where user_id = ${context.userId}
      order by created_at desc
      limit 20
    `;
    return rows.map(
      (r): CommandDto => ({
        id: r.id,
        deviceId: r.device_id,
        command: r.command,
        exitCode: r.exit_code,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        status: r.status,
        createdAt: iso(r.created_at),
      }),
    );
  });

export const listProtocol = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<EventRow>`
      select id, device_id, direction, type, envelope, created_at
      from protocol_events
      where user_id = ${context.userId}
      order by created_at desc
      limit 40
    `;
    return rows.map(
      (r): ProtocolDto => ({
        id: r.id,
        deviceId: r.device_id,
        direction: r.direction === "up" ? "up" : "down",
        type: r.type,
        envelope: r.envelope,
        createdAt: iso(r.created_at),
      }),
    );
  });

export const createJoinCode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(() => true)
  .handler(async ({ context }) => {
    const sql = await getSql();
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    const id = crypto.randomUUID();
    await sql`
      insert into enroll_codes (id, user_id, code, expires_at)
      values (${id}, ${context.userId}, ${code}, now() + interval '15 minutes')
    `;
    const rows = await sql<{ code: string; expires_at: string | Date }>`
      select code, expires_at from enroll_codes where id = ${id}
    `;
    return { code: rows[0]!.code, expiresAt: iso(rows[0]!.expires_at) };
  });

export const listJoinCodes = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSql();
    const rows = await sql<{
      id: string;
      code: string;
      expires_at: string | Date;
      used_at: string | Date | null;
    }>`
      select id, code, expires_at, used_at
      from enroll_codes
      where user_id = ${context.userId}
      order by created_at desc
      limit 8
    `;
    return rows.map(
      (r): EnrollDto => ({
        id: r.id,
        code: r.code,
        expiresAt: iso(r.expires_at),
        usedAt: r.used_at ? iso(r.used_at) : null,
      }),
    );
  });

export const redeemJoinCode = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: { code: string; name: string; os: OsKind; locationTag: string; arch?: string }) => input,
  )
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const code = data.code.trim().toUpperCase();
    const rows = await sql<{
      id: string;
      expires_at: string | Date;
      used_at: string | Date | null;
    }>`
      select id, expires_at, used_at from enroll_codes
      where user_id = ${context.userId} and code = ${code}
    `;
    const row = rows[0];
    if (!row) throw new Error("无效的接入码");
    if (row.used_at) throw new Error("这个接入码已经用过了");
    if (new Date(row.expires_at).getTime() < Date.now()) throw new Error("接入码已过期");

    const count = await sql<{ n: number }>`select count(*)::int as n from devices where user_id = ${context.userId}`;
    assertCanAddDevice(count[0]?.n ?? 0);

    const slug = makeDeviceSlug(data.name);
    const id = crypto.randomUUID();
    const arch = data.arch || (data.os === "darwin" ? "arm64" : "x86_64");
    await sql`
      insert into devices (id, user_id, slug, name, os, arch, location_tag, status, caps)
      values (${id}, ${context.userId}, ${slug}, ${data.name.trim() || slug}, ${data.os}, ${arch}, ${data.locationTag}, ${"online"}, ${"shell"})
    `;
    await sql`update enroll_codes set used_at = now() where id = ${row.id} and user_id = ${context.userId}`;
    const hello = makeEnvelope("hello", {
      os: data.os,
      arch,
      hostname: slug,
      caps: ["shell"],
      agent_ver: "0.1.0",
    });
    await recordEvent(context.userId, id, "up", hello);
    const ok = makeEnvelope("hello_ok", { session_id: id, heartbeat_s: 25 }, hello.id);
    await recordEvent(context.userId, id, "down", ok);
    return { id, slug };
  });

export const addDevice = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { name: string; os: OsKind; locationTag: string; arch?: string }) => input)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const count = await sql<{ n: number }>`select count(*)::int as n from devices where user_id = ${context.userId}`;
    assertCanAddDevice(count[0]?.n ?? 0);
    const slug = makeDeviceSlug(data.name);
    const id = crypto.randomUUID();
    const arch = data.arch || (data.os === "darwin" ? "arm64" : "x86_64");
    const name = data.name.trim() || slug;
    await sql`
      insert into devices (id, user_id, slug, name, os, arch, location_tag, status, caps)
      values (${id}, ${context.userId}, ${slug}, ${name}, ${data.os}, ${arch}, ${data.locationTag}, ${"online"}, ${"shell"})
    `;
    const hello = dispatchHello({
      name,
      slug,
      os: data.os,
      arch,
      locationTag: data.locationTag,
    });
    for (const ev of hello) {
      await recordEvent(context.userId, id, ev.direction, ev.envelope);
    }
    await sql`
      insert into hub_sessions (user_id, selected_device_id, selected_at)
      values (${context.userId}, ${id}, now())
      on conflict (user_id) do update set selected_device_id = excluded.selected_device_id, selected_at = now()
    `;
    return { id, slug };
  });

export const removeDevice = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: string) => id)
  .handler(async ({ context, data: id }) => {
    const sql = await getSql();
    const found = await sql<{ id: string }>`
      select id from devices where id = ${id} and user_id = ${context.userId}
    `;
    if (!found[0]) throw new Error("Device not found");
    await sql`delete from devices where id = ${id} and user_id = ${context.userId}`;
    await sql`
      update hub_sessions
      set selected_device_id = (
        select id from devices where user_id = ${context.userId} order by created_at asc limit 1
      )
      where user_id = ${context.userId} and selected_device_id = ${id}
    `;
    const env = makeEnvelope("offline", { device_id: id, reason: "removed" });
    await recordEvent(context.userId, id, "up", env);
    return { ok: true as const };
  });

