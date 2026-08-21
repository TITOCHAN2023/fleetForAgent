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
      "Start a command on the selected device. Returns accepted immediately; the job lives in a local pane. Do not wait on the hub. Use read_screen / get_result.",
    input: { command: "string" },
  },
  {
    name: "get_result",
    description: "Fetch a previous run by corr id. Pending if the pane is still alive.",
    input: { corr: "string" },
  },
  {
    name: "read_screen",
    description:
      "Snapshot the pane current frame. Does not attach, does not stream. Latest-wins on the device.",
    input: { corr: "string?" },
  },
  {
    name: "type",
    description:
      "Fire-and-forget keystrokes into the pane stdin. Never waits for the process.",
    input: { keys: "string?", key: "string?", corr: "string?" },
  },
  {
    name: "list_panes",
    description: "List live panes on the selected machine: id, command, running.",
    input: {},
  },
] as const;
