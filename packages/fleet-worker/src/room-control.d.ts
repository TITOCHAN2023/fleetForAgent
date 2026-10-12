export type RoomPrincipal = { kind: "user" | "agent"; id: string; roomId?: string };
export type RoomControlAccess = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
};
export type RoomControlStorage = RoomControlAccess & {
  transaction<T>(callback: (txn: RoomControlAccess) => Promise<T>): Promise<T>;
};
export type RoomAgent = {
  id: string;
  name: string;
  mode: "mcp" | "runtime";
  capacity: number;
  canCreateRooms: boolean;
  createdAt: number;
  updatedAt: number;
  lastSeen: number | null;
  online: boolean;
  callable: boolean;
};
export type FleetRoom = {
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
export type RoomMessage = {
  id: string;
  roomId: string;
  discussionId: string;
  authorId: string;
  authorKind: "user" | "agent";
  toAgentId: string | null;
  seq: number;
  text: string;
  createdAt: number;
};
export type RoomTaskStatus = "queued" | "running" | "waiting" | "unknown" | "cancel_requested" | "completed" | "cancelled" | "failed";
export type RoomTask = {
  id: string;
  roomId: string;
  requesterId: string;
  requesterKind: "user" | "agent";
  kind: "task" | "message";
  messageId: string | null;
  discussionId: string | null;
  assigneeId: string;
  sessionId: string;
  description: string;
  completionCriteria: string;
  parentTaskId: string | null;
  depth: number;
  resolvedDeviceId: string;
  deviceSource: "explicit" | "parent" | "room_default";
  configVersion: number;
  status: RoomTaskStatus;
  executionEpoch: number;
  renewalSeq: number;
  leaseExpiresAt: number | null;
  controlEpoch: number;
  eventCount: number;
  createdAt: number;
  updatedAt: number;
  result?: string;
  error?: string;
  checkpoint?: string;
  resume?: boolean;
};
export type RoomTaskSummary = Omit<RoomTask, "description" | "completionCriteria" | "result" | "error" | "checkpoint">;
export type RoomTaskEvent = {
  taskId: string;
  roomId: string;
  seq: number;
  type: string;
  actorId: string;
  actorKind: "user" | "agent";
  executionEpoch: number;
  status: RoomTaskStatus;
  createdAt: number;
};
export type RoomChildSummary = {
  id: string;
  status: RoomTaskStatus;
  result?: string;
  resultTruncated?: boolean;
  error?: string;
  errorTruncated?: boolean;
};
export type RoomControlResult =
  | { agent: RoomAgent }
  | { agents: RoomAgent[] }
  | { room: FleetRoom }
  | { rooms: FleetRoom[] }
  | { message: RoomMessage; contextRev: number; task?: RoomTask }
  | { messages: RoomMessage[]; contextRev: number; nextCursor: number | null; hasMore: boolean }
  | { task: RoomTask; message?: RoomMessage; contextRev?: number; events?: RoomTaskEvent[]; eventsHasMore?: boolean; eventsNextCursor?: number | null; children?: RoomChildSummary[] }
  | { tasks: RoomTaskSummary[]; nextCursor: string | null; hasMore: boolean };
export class RoomControlError extends Error {
  constructor(code: string, status: number, message: string);
  code: string;
  status: number;
}
export function roomControl(
  storage: RoomControlStorage,
  principal: RoomPrincipal,
  action: string,
  input?: Record<string, unknown>,
  now?: number,
): Promise<RoomControlResult>;
