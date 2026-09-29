export type RoomAgent = {
  id: string;
  name: string;
  mode: "mcp" | "runtime";
  online: boolean;
  callable: boolean;
  capacity: number;
  running: number;
  leader: boolean;
};

export type Room = {
  id: string;
  name: string;
  leaderId: string;
  memberIds: string[];
  defaultDeviceId: string;
  membershipVersion: number;
  configVersion: number;
  controlEpoch: number;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
};

export type RoomDevice = {
  id: string;
  alias: string;
  name: string;
  online: boolean;
};

/** Account session only. Never persist Room contents in browser storage. */
export async function roomRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await response.json();
  if (!response.ok || result.error) {
    throw new Error(
      typeof result.error === "string" ? result.error : `Request failed (${response.status})`,
    );
  }
  return result as T;
}

export function roomControl<T>(
  leaderId: string,
  action: string,
  input: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  return roomRequest<T>("/v1/room-control", { leaderId, action, input }, signal);
}
