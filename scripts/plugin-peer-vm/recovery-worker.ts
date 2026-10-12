import fixture from "./worker";
import {
  DeviceDO as ProductionDeviceDO, FleetDO, McpDO, PeerSessionDO, RevocationDO, RoomRelayDO, type Env,
} from "../../packages/fleet-worker/src/index";

export { FleetDO, McpDO, PeerSessionDO, RevocationDO, RoomRelayDO };
type LabEnv = Env & { VM_SEED_KEY?: string };

// Fault injection belongs in the lab entry point, never in the public Worker.
export class DeviceDO extends ProductionDeviceDO {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/__lab_fault") return super.fetch(request);
    const secret = (this.env as LabEnv).VM_SEED_KEY;
    if (!secret || request.headers.get("x-fleet-vm-key") !== secret) return new Response(null, { status: 404 });
    const body = await request.json() as { action: string; drop?: boolean };
    if (body.action === "drop_results") await this.ctx.storage.put("lab:drop", body.drop === true);
    else if (body.action === "clear_cache") {
      // Simulate complete hub-side session loss without fabricating a result.
      await this.ctx.storage.deleteAll();
    } else return new Response(null, { status: 400 });
    return Response.json({ ok: true, dropped: await this.ctx.storage.get<number>("lab:dropped") ?? 0 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === "string" && await this.ctx.storage.get<boolean>("lab:drop")) {
      const type = (JSON.parse(message) as { type?: string }).type;
      if (type === "result") {
        await this.ctx.storage.put("lab:dropped", (await this.ctx.storage.get<number>("lab:dropped") ?? 0) + 1);
        return;
      }
    }
    return super.webSocketMessage(ws, message);
  }
}

export default {
  async fetch(request: Request, env: LabEnv, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== "/__fleet_vm__/recovery") return fixture.fetch(request, env, ctx);
    if (request.method !== "POST" || !env.VM_SEED_KEY || request.headers.get("x-fleet-vm-key") !== env.VM_SEED_KEY) {
      return new Response(null, { status: 404 });
    }
    const body = await request.json() as { device_id: string; action: string; drop?: boolean };
    if (!/^[0-9a-f-]{36}$/.test(body.device_id)) return new Response(null, { status: 400 });
    const stub = env.DEVICE.get(env.DEVICE.idFromName(body.device_id));
    return stub.fetch(new Request("http://lab/__lab_fault", {
      method: "POST", headers: { "x-fleet-vm-key": env.VM_SEED_KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  },
};
