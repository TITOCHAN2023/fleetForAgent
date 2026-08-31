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
      "List every machine in the fleet. Returns immutable id, optional alias, name, Agent version, OS, location tag, and online state. Never returns IPs.",
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
    description: "Peek this operator's live session. Pending if the pane is still alive.",
    input: {},
  },
  {
    name: "read_screen",
    description:
      "Snapshot this operator's pane current frame. Does not attach, does not stream.",
    input: {},
  },
  {
    name: "type",
    description:
      "Fire-and-forget keystrokes into this operator's pane stdin. Never waits for the process.",
    input: { keys: "string?", key: "string?" },
  },
  {
    name: "list_panes",
    description: "List live panes on the selected machine: id, command, running.",
    input: {},
  },
  {
    name: "desktop_screenshot",
    description: "Primary display JPEG. Pixel coordinates of this image. Requires computer_use.",
    input: { device_id: "string?" },
  },
  {
    name: "desktop_action",
    description: "HID on the last screenshot. Requires computer_use.",
    input: { action: "string", x: "number?", y: "number?" },
  },
] as const;
