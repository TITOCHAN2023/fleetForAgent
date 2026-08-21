import { i as TSS_SERVER_FUNCTION, r as createServerFn } from "./ssr.mjs";
import { r as getSql } from "./db-CqKjSrkl.mjs";
import { t as authMiddleware } from "./middleware-Bfun67SM.mjs";
import { a as dispatchHello, c as resolveNode, o as dispatchRun, s as makeEnvelope } from "./hub-AQG3plA7.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/actions-agK0gp3h.js
var createServerRpc = (serverFnMeta, splitImportFn) => {
	const url = "/_serverFn/" + serverFnMeta.id;
	return Object.assign(splitImportFn, {
		url,
		serverFnMeta,
		[TSS_SERVER_FUNCTION]: true
	});
};
function iso(v) {
	if (!v) return "";
	return v instanceof Date ? v.toISOString() : String(v);
}
function mapDevice(row) {
	const net = resolveNode({
		slug: row.slug,
		name: row.name,
		os: row.os,
		arch: row.arch,
		locationTag: row.location_tag
	});
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		os: row.os,
		arch: row.arch,
		locationTag: row.location_tag,
		status: row.status === "offline" ? "offline" : "online",
		caps: (row.caps || "shell").split(",").filter(Boolean),
		lastSeen: iso(row.last_seen),
		selected: row.selected_device_id === row.id,
		overlayIp: net.overlayIp,
		lanIp: net.lanIp
	};
}
var SEED = [
	{
		slug: "mac-mini-home",
		name: "Mac mini",
		os: "darwin",
		arch: "arm64",
		locationTag: "home",
		caps: "shell"
	},
	{
		slug: "linux-colo-1",
		name: "机房 Linux",
		os: "linux",
		arch: "x86_64",
		locationTag: "colo",
		caps: "shell"
	},
	{
		slug: "win-cloud-gpu",
		name: "云上 Windows",
		os: "windows",
		arch: "x86_64",
		locationTag: "cloud",
		caps: "shell"
	}
];
async function ensureFleet(userId) {
	const sql = await getSql();
	if (((await sql`select count(*)::int as n from devices where user_id = ${userId}`)[0]?.n ?? 0) > 0) return;
	let firstId = null;
	for (const d of SEED) {
		const id = crypto.randomUUID();
		if (!firstId) firstId = id;
		await sql`
      insert into devices (id, user_id, slug, name, os, arch, location_tag, status, caps)
      values (${id}, ${userId}, ${d.slug}, ${d.name}, ${d.os}, ${d.arch}, ${d.locationTag}, ${"online"}, ${d.caps})
      on conflict do nothing
    `;
	}
	if (firstId) await sql`
      insert into hub_sessions (user_id, selected_device_id, selected_at)
      values (${userId}, ${firstId}, now())
      on conflict (user_id) do nothing
    `;
}
async function recordEvent(userId, deviceId, direction, env) {
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
var listDevices_createServerFn_handler = createServerRpc({
	id: "aff8864b0eee3ba0f2e7ba3b4b880c6ab09f0c96667d52ae7e925bcbea533e0c",
	name: "listDevices",
	filename: "src/lib/fleet/actions.ts"
}, (opts) => listDevices.__executeServer(opts));
var listDevices = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(listDevices_createServerFn_handler, async ({ context }) => {
	await ensureFleet(context.userId);
	const sql = await getSql();
	await sql`
      update devices set last_seen = now()
      where user_id = ${context.userId} and status = 'online'
    `;
	return (await sql`
      select d.id, d.slug, d.name, d.os, d.arch, d.location_tag, d.status, d.caps, d.last_seen,
             s.selected_device_id
      from devices d
      left join hub_sessions s on s.user_id = d.user_id
      where d.user_id = ${context.userId}
      order by d.created_at asc
    `).map(mapDevice);
});
var selectDevice_createServerFn_handler = createServerRpc({
	id: "17db7a4fb25efa3ca913c0069de1fd8f19ea53f4079785ac1caf2d7c4dba0f96",
	name: "selectDevice",
	filename: "src/lib/fleet/actions.ts"
}, (opts) => selectDevice.__executeServer(opts));
var selectDevice = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator((id) => id).handler(selectDevice_createServerFn_handler, async ({ context, data: id }) => {
	const sql = await getSql();
	if (!(await sql`
      select id from devices where id = ${id} and user_id = ${context.userId}
    `)[0]) throw new Error("Device not found");
	await sql`
      insert into hub_sessions (user_id, selected_device_id, selected_at)
      values (${context.userId}, ${id}, now())
      on conflict (user_id) do update set selected_device_id = excluded.selected_device_id, selected_at = now()
    `;
	const env = makeEnvelope("hello_ok", { selected: id });
	await recordEvent(context.userId, id, "down", env);
	return {
		ok: true,
		id
	};
});
var toggleDevice_createServerFn_handler = createServerRpc({
	id: "5f00ad34f5b9e4fc2bb1175f62b9cb6daf136b531220a9086c8b461978160164",
	name: "toggleDevice",
	filename: "src/lib/fleet/actions.ts"
}, (opts) => toggleDevice.__executeServer(opts));
var toggleDevice = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator((input) => input).handler(toggleDevice_createServerFn_handler, async ({ context, data }) => {
	const sql = await getSql();
	await sql`
      update devices
      set status = ${data.status}, last_seen = now()
      where id = ${data.id} and user_id = ${context.userId}
    `;
	const env = makeEnvelope(data.status === "online" ? "hello" : "offline", { device_id: data.id });
	await recordEvent(context.userId, data.id, "up", env);
	if (data.status === "online") {
		const row = await sql`
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
				os: row[0].os,
				arch: row[0].arch,
				locationTag: row[0].location_tag
			});
			for (const ev of hello) await recordEvent(context.userId, data.id, ev.direction, ev.envelope);
		}
	}
	return { ok: true };
});
var runCommand_createServerFn_handler = createServerRpc({
	id: "0f11145a64b95525cbdd07a774bcbc7010fc3cdfce8cdfd96704248cdee8a742",
	name: "runCommand",
	filename: "src/lib/fleet/actions.ts"
}, (opts) => runCommand.__executeServer(opts));
var runCommand = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator((command) => command).handler(runCommand_createServerFn_handler, async ({ context, data: raw }) => {
	const command = raw.trim();
	if (!command) return {
		id: "",
		status: "error",
		exitCode: 1,
		stdout: "",
		stderr: "empty command",
		deviceId: ""
	};
	const sql = await getSql();
	const deviceId = (await sql`
      select selected_device_id from hub_sessions where user_id = ${context.userId}
    `)[0]?.selected_device_id;
	if (!deviceId) return {
		id: crypto.randomUUID(),
		status: "error",
		exitCode: 1,
		stdout: "",
		stderr: "no computer selected — call select_computer first",
		deviceId: ""
	};
	const device = (await sql`
      select d.id, d.slug, d.name, d.os, d.arch, d.location_tag, d.status, d.caps, d.last_seen,
             s.selected_device_id
      from devices d
      left join hub_sessions s on s.user_id = d.user_id
      where d.id = ${deviceId} and d.user_id = ${context.userId}
    `)[0];
	if (!device) return {
		id: crypto.randomUUID(),
		status: "error",
		exitCode: 1,
		stdout: "",
		stderr: "selected computer is gone",
		deviceId
	};
	const shellDevice = {
		name: device.name,
		slug: device.slug,
		os: device.os,
		arch: device.arch,
		locationTag: device.location_tag
	};
	const dispatched = dispatchRun({
		device: shellDevice,
		online: device.status === "online",
		command
	});
	for (const ev of dispatched.events) await recordEvent(context.userId, device.id, ev.direction, ev.envelope);
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
		deviceId: device.id
	};
});
var listCommands_createServerFn_handler = createServerRpc({
	id: "60cac36ada08725fecf090a8e839feb4b0c05d5cb2d19cc4cf3125b92405d7eb",
	name: "listCommands",
	filename: "src/lib/fleet/actions.ts"
}, (opts) => listCommands.__executeServer(opts));
var listCommands = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(listCommands_createServerFn_handler, async ({ context }) => {
	return (await (await getSql())`
      select id, device_id, command, exit_code, stdout, stderr, status, created_at
      from commands
      where user_id = ${context.userId}
      order by created_at desc
      limit 20
    `).map((r) => ({
		id: r.id,
		deviceId: r.device_id,
		command: r.command,
		exitCode: r.exit_code,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		status: r.status,
		createdAt: iso(r.created_at)
	}));
});
var listProtocol_createServerFn_handler = createServerRpc({
	id: "87b4a29f8e6e052c501dc016a220fd0726665a6f36bdfeb0e5bc4ccb160e8e7e",
	name: "listProtocol",
	filename: "src/lib/fleet/actions.ts"
}, (opts) => listProtocol.__executeServer(opts));
var listProtocol = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(listProtocol_createServerFn_handler, async ({ context }) => {
	return (await (await getSql())`
      select id, device_id, direction, type, envelope, created_at
      from protocol_events
      where user_id = ${context.userId}
      order by created_at desc
      limit 40
    `).map((r) => ({
		id: r.id,
		deviceId: r.device_id,
		direction: r.direction === "up" ? "up" : "down",
		type: r.type,
		envelope: r.envelope,
		createdAt: iso(r.created_at)
	}));
});
var createJoinCode_createServerFn_handler = createServerRpc({
	id: "ac2cf358f25de4570c9176d1b33257afbf607a44bdf69f9921cfd060a87606cc",
	name: "createJoinCode",
	filename: "src/lib/fleet/actions.ts"
}, (opts) => createJoinCode.__executeServer(opts));
var createJoinCode = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator(() => true).handler(createJoinCode_createServerFn_handler, async ({ context }) => {
	const sql = await getSql();
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	let code = "";
	for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * 32)];
	const id = crypto.randomUUID();
	await sql`
      insert into enroll_codes (id, user_id, code, expires_at)
      values (${id}, ${context.userId}, ${code}, now() + interval '15 minutes')
    `;
	const rows = await sql`
      select code, expires_at from enroll_codes where id = ${id}
    `;
	return {
		code: rows[0].code,
		expiresAt: iso(rows[0].expires_at)
	};
});
var listJoinCodes_createServerFn_handler = createServerRpc({
	id: "9cac52f975dc0d93a16fc6a6ad32f17793d3d904d819293f7ec1527b5a88ad8d",
	name: "listJoinCodes",
	filename: "src/lib/fleet/actions.ts"
}, (opts) => listJoinCodes.__executeServer(opts));
var listJoinCodes = createServerFn({ method: "GET" }).middleware([authMiddleware]).handler(listJoinCodes_createServerFn_handler, async ({ context }) => {
	return (await (await getSql())`
      select id, code, expires_at, used_at
      from enroll_codes
      where user_id = ${context.userId}
      order by created_at desc
      limit 8
    `).map((r) => ({
		id: r.id,
		code: r.code,
		expiresAt: iso(r.expires_at),
		usedAt: r.used_at ? iso(r.used_at) : null
	}));
});
var redeemJoinCode_createServerFn_handler = createServerRpc({
	id: "d0eda07b4b534d43d1b9fa1b0a09f5ca4ed9a682809f660b81260d6bd1e289e8",
	name: "redeemJoinCode",
	filename: "src/lib/fleet/actions.ts"
}, (opts) => redeemJoinCode.__executeServer(opts));
var redeemJoinCode = createServerFn({ method: "POST" }).middleware([authMiddleware]).validator((input) => input).handler(redeemJoinCode_createServerFn_handler, async ({ context, data }) => {
	const sql = await getSql();
	const code = data.code.trim().toUpperCase();
	const row = (await sql`
      select id, expires_at, used_at from enroll_codes
      where user_id = ${context.userId} and code = ${code}
    `)[0];
	if (!row) throw new Error("无效的接入码");
	if (row.used_at) throw new Error("这个接入码已经用过了");
	if (new Date(row.expires_at).getTime() < Date.now()) throw new Error("接入码已过期");
	const slug = `${data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "node"}-${crypto.randomUUID().slice(0, 4)}`;
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
		agent_ver: "0.1.0"
	});
	await recordEvent(context.userId, id, "up", hello);
	const ok = makeEnvelope("hello_ok", {
		session_id: id,
		heartbeat_s: 25
	}, hello.id);
	await recordEvent(context.userId, id, "down", ok);
	return {
		id,
		slug
	};
});
//#endregion
export { createJoinCode_createServerFn_handler, listCommands_createServerFn_handler, listDevices_createServerFn_handler, listJoinCodes_createServerFn_handler, listProtocol_createServerFn_handler, redeemJoinCode_createServerFn_handler, runCommand_createServerFn_handler, selectDevice_createServerFn_handler, toggleDevice_createServerFn_handler };
