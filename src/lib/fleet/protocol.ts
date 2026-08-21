export const PROTOCOL_VERSION = 1 as const;

export type OsKind = "darwin" | "linux" | "windows";
export type LocationTag = "home" | "colo" | "cloud";
export type DeviceStatus = "online" | "offline";
export type Direction = "up" | "down";

export type Envelope = {
  v: typeof PROTOCOL_VERSION;
  type: string;
  id: string;
  corr?: string;
  t: number;
  body: Record<string, unknown>;
};

export function makeEnvelope(
  type: string,
  body: Record<string, unknown> = {},
  corr?: string,
): Envelope {
  const env: Envelope = {
    v: PROTOCOL_VERSION,
    type,
    id: crypto.randomUUID(),
    t: Date.now(),
    body,
  };
  if (corr) env.corr = corr;
  return env;
}

export const TOOLS = [
  {
    name: "list_computers",
    description:
      "List every machine in the fleet. Returns id, name, os, location tag, and online state. Never returns IPs.",
    input: {},
  },
  {
    name: "select_computer",
    description:
      "Bind subsequent run calls to one device. Pass the id from list_computers.",
    input: { id: "string" },
  },
  {
    name: "run",
    description:
      "Execute a shell command on the currently selected device. Short commands return stdout; long commands return running + corr.",
    input: { command: "string" },
  },
  {
    name: "get_result",
    description: "Fetch a previous run by corr id.",
    input: { corr: "string" },
  },
] as const;
