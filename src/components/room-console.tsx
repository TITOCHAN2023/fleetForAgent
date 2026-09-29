import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/lib/i18n/use-i18n";
import {
  roomControl,
  roomRequest,
  type Room,
  type RoomAgent,
  type RoomDevice,
} from "@/lib/fleet/rooms";

const selectClass =
  "h-11 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg disabled:opacity-40";
const panelClass = "rounded-2xl border border-border bg-surface p-5";

export function RoomConsole({ accountId }: { accountId: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const qc = useQueryClient();
  const [leaderId, setLeaderId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [name, setName] = useState("");
  const [createDeviceId, setCreateDeviceId] = useState("");
  const [notice, setNotice] = useState("");
  const agentsQ = useQuery({
    queryKey: ["room-agents", accountId],
    queryFn: ({ signal }) =>
      roomRequest<{ agents: RoomAgent[] }>("/v1/room-agents", undefined, signal),
    refetchInterval: 5000,
    retry: false,
  });
  const devicesQ = useQuery({
    queryKey: ["room-devices", accountId],
    queryFn: ({ signal }) =>
      roomRequest<{ computers: RoomDevice[] }>("/v1/list_computers", {}, signal),
    refetchInterval: 5000,
    retry: false,
  });
  const agents = agentsQ.data?.agents ?? [];
  const devices = devicesQ.data?.computers ?? [];
  const leaders = agents.filter((agent) => agent.leader);
  const leader = agents.find((agent) => agent.id === leaderId);
  const available = Boolean(leader?.online && !agentsQ.isError);
  useEffect(() => {
    if (!leaderId && agentsQ.data) {
      const first = agentsQ.data.agents.find((agent) => agent.leader && agent.online);
      if (first) setLeaderId(first.id);
    }
  }, [leaderId, agentsQ.data]);
  const roomsKey = ["rooms", accountId, leaderId];
  const roomsQ = useQuery({
    queryKey: roomsKey,
    queryFn: ({ signal }) => roomControl<{ rooms: Room[] }>(leaderId, "rooms.list", {}, signal),
    enabled: available,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const rooms = roomsQ.data?.rooms ?? [];
  const room = rooms.find((item) => item.id === roomId) ?? rooms[0];
  const change = useMutation({
    mutationFn: ({ action, input }: { action: string; input: Record<string, unknown> }) =>
      roomControl<{ room: Room }>(leaderId, action, input),
    retry: false,
    onSuccess: (result) => {
      setRoomId(result.room.id);
      qc.setQueryData<{ rooms: Room[] }>(roomsKey, (previous) => ({
        rooms: [
          ...(previous?.rooms ?? []).filter((item) => item.id !== result.room.id),
          result.room,
        ],
      }));
      setNotice(zh ? "已保存到组长设备。" : "Saved on the leader device.");
    },
  });
  function update(action: string, input: Record<string, unknown>) {
    if (!available || change.isPending) return;
    setNotice("");
    change.mutate({ action, input });
  }
  const blocked = !available || change.isPending;
  const error = agentsQ.error ?? devicesQ.error ?? roomsQ.error ?? change.error;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Fleet Room</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted">
            {zh
              ? "在线 Agent 协作，每房最多 5 位。房间历史与任务账本仅保存在组长设备；组长离线时房间不可用，不自动重跑任务。"
              : "Up to 5 agents per room. History and task records live only on the leader device. Rooms are unavailable while the leader is offline; tasks never restart automatically."}
          </p>
        </div>
        <a href="/" className="text-sm underline underline-offset-4">
          {zh ? "返回设备控制台" : "Device console"}
        </a>
      </div>
      {error && (
        <p role="alert" className="rounded-xl border border-bad/30 bg-bad/10 p-3 text-sm text-bad">
          {error.message}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      )}
      <section className={panelClass} aria-labelledby="agents-heading">
        <h2 id="agents-heading" className="font-medium">
          Fleet Agent
        </h2>
        <p className="mt-1 text-sm text-muted">
          {zh
            ? "设备在线不代表 Agent 可调用。仅 MCP 的 Agent 不能远程唤醒。"
            : "An online device does not guarantee a callable agent. MCP-only agents cannot be awakened remotely."}
        </p>
        {agentsQ.isPending ? (
          <p role="status" className="mt-4">
            {zh ? "正在加载 Agent…" : "Loading agents…"}
          </p>
        ) : null}
        {!agentsQ.isPending && agents.length === 0 && (
          <p className="mt-4 text-sm text-muted">
            {zh
              ? "尚无已登记的 Agent。请先连接 Fleet Agent。"
              : "No registered agents. Connect a Fleet Agent first."}
          </p>
        )}
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent) => (
            <li key={agent.id} className="rounded-xl border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="break-all font-medium">{agent.name}</span>
                <span className="shrink-0 text-xs text-muted">
                  {agent.online ? (zh ? "在线" : "Online") : zh ? "离线" : "Offline"}
                </span>
              </div>
              <p className="mt-1 break-all font-mono text-xs text-muted">{agent.id}</p>
              <p className="mt-1 text-xs text-muted">
                {agent.mode === "mcp"
                  ? zh
                    ? "仅 MCP · 不可远程唤醒"
                    : "MCP only · no remote wake"
                  : agent.callable
                    ? zh
                      ? "可调用"
                      : "Callable"
                    : zh
                      ? "运行器未就绪"
                      : "Runtime not ready"}
                {agent.leader ? (zh ? " · 组长" : " · Leader") : ""}
              </p>
              <p className="mt-2 text-xs text-muted">
                {zh ? "运行" : "Running"} {agent.running}/{agent.capacity}
              </p>
            </li>
          ))}
        </ul>
      </section>
      <section className={panelClass} aria-labelledby="leader-heading">
        <h2 id="leader-heading" className="font-medium">
          {zh ? "组长与房间" : "Leader and rooms"}
        </h2>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-48 flex-1 space-y-2 text-sm">
            <span>{zh ? "组长" : "Leader"}</span>
            <select
              className={selectClass}
              aria-label={zh ? "组长" : "Leader"}
              value={leaderId}
              disabled={change.isPending}
              onChange={(event) => {
                setLeaderId(event.target.value);
                setRoomId("");
                setNotice("");
                change.reset();
              }}
            >
              <option value="">{zh ? "选择组长" : "Select a leader"}</option>
              {leaderId && !leaders.some((item) => item.id === leaderId) && (
                <option value={leaderId}>
                  {leaderId} · {zh ? "离线" : "Offline"}
                </option>
              )}
              {leaders.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.id}) ·{" "}
                  {item.online ? (zh ? "在线" : "Online") : zh ? "离线" : "Offline"}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="secondary"
            disabled={!available || roomsQ.isFetching || change.isPending}
            onClick={() => void roomsQ.refetch()}
          >
            {roomsQ.isFetching ? (zh ? "加载中…" : "Loading…") : zh ? "刷新房间" : "Refresh rooms"}
          </Button>
        </div>
        {leaderId && !available && (
          <p role="status" className="mt-3 text-sm text-bad">
            {zh
              ? "组长离线或目录不可用。房间已停止操作，等待连接恢复。"
              : "The leader is offline or the directory is unavailable. Room operations are blocked until the connection returns."}
          </p>
        )}
        <form
          className="mt-5 grid gap-3 border-t border-border pt-5 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            update("rooms.create", {
              id: crypto.randomUUID(),
              name: name.trim(),
              leaderId,
              defaultDeviceId: createDeviceId,
            });
          }}
        >
          <label className="space-y-2 text-sm">
            <span>{zh ? "新房间名称" : "New room name"}</span>
            <Input
              value={name}
              maxLength={120}
              required
              disabled={blocked}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="space-y-2 text-sm">
            <span>{zh ? "默认执行设备" : "Default execution device"}</span>
            <select
              className={selectClass}
              aria-label={zh ? "默认执行设备" : "Default execution device"}
              value={createDeviceId}
              required
              disabled={blocked || devicesQ.isError}
              onChange={(event) => setCreateDeviceId(event.target.value)}
            >
              <option value="">{zh ? "选择设备" : "Select a device"}</option>
              {devices.map((device) => (
                <option key={device.id} value={device.id} disabled={!device.online}>
                  {device.alias || device.name} ·{" "}
                  {device.online ? (zh ? "在线" : "Online") : zh ? "离线" : "Offline"}
                </option>
              ))}
            </select>
          </label>
          <Button
            className="self-end"
            type="submit"
            disabled={
              blocked ||
              !name.trim() ||
              !devices.some((device) => device.id === createDeviceId && device.online) ||
              devicesQ.isError
            }
          >
            {zh ? "创建房间" : "Create room"}
          </Button>
        </form>
      </section>
      {available && (
        <div className="grid items-start gap-4 md:grid-cols-[240px_1fr]">
          <section className={panelClass} aria-labelledby="rooms-heading">
            <h2 id="rooms-heading" className="font-medium">
              {zh ? "房间" : "Rooms"}
            </h2>
            {rooms.length === 0 && (
              <p className="mt-3 text-sm text-muted">
                {roomsQ.isFetching
                  ? zh
                    ? "加载中…"
                    : "Loading…"
                  : roomsQ.isError
                    ? zh
                      ? "读取失败，请刷新。"
                      : "Could not load rooms. Refresh to retry."
                    : zh
                      ? "这位组长还没有房间。"
                      : "This leader has no rooms yet."}
              </p>
            )}
            <div className="mt-3 space-y-2">
              {rooms.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  disabled={change.isPending}
                  aria-pressed={room?.id === item.id}
                  className={`w-full rounded-xl border p-3 text-left text-sm ${room?.id === item.id ? "border-accent bg-elevated" : "border-border"}`}
                  onClick={() => {
                    setRoomId(item.id);
                    setNotice("");
                    change.reset();
                  }}
                >
                  <span className="block break-all font-medium">{item.name}</span>
                  <span className="mt-1 block text-xs text-muted">
                    {item.memberIds.length}/5 ·{" "}
                    {item.paused ? (zh ? "已暂停" : "Paused") : zh ? "开放" : "Open"}
                  </span>
                </button>
              ))}
            </div>
          </section>
          {room && (
            <RoomDetails
              key={`${leaderId}:${room.id}`}
              room={room}
              agents={agents}
              devices={devices}
              devicesAvailable={!devicesQ.isError}
              blocked={blocked}
              update={update}
              zh={zh}
            />
          )}
        </div>
      )}
      {available && room && (
        <RoomActivity
          key={`${leaderId}:${room.id}`}
          accountId={accountId}
          room={room}
          agents={agents}
          devices={devices}
          devicesAvailable={!devicesQ.isError}
          blocked={blocked}
          zh={zh}
        />
      )}
    </div>
  );
}

function RoomDetails({
  room,
  agents,
  devices,
  devicesAvailable,
  blocked,
  update,
  zh,
}: {
  room: Room;
  agents: RoomAgent[];
  devices: RoomDevice[];
  devicesAvailable: boolean;
  blocked: boolean;
  update: (action: string, input: Record<string, unknown>) => void;
  zh: boolean;
}) {
  const [deviceId, setDeviceId] = useState(room.defaultDeviceId);
  const [inviteId, setInviteId] = useState("");
  useEffect(() => setDeviceId(room.defaultDeviceId), [room.defaultDeviceId]);
  const device = devices.find((item) => item.id === room.defaultDeviceId);
  const candidates = agents.filter((agent) => !room.memberIds.includes(agent.id));
  return (
    <section className={`${panelClass} space-y-5`} aria-labelledby="room-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="room-heading" className="break-all text-lg font-medium">
          {room.name}
        </h2>
        <Button
          size="sm"
          variant="secondary"
          disabled={blocked}
          onClick={() => update(room.paused ? "rooms.resume" : "rooms.pause", { roomId: room.id })}
        >
          {room.paused ? (zh ? "恢复房间" : "Resume room") : zh ? "暂停房间" : "Pause room"}
        </Button>
      </div>
      {room.paused && (
        <p role="status" className="text-sm text-muted">
          {zh
            ? "房间已暂停。暂停不等于正在运行的任务已停止。"
            : "Room paused. This does not confirm that running tasks have stopped."}
        </p>
      )}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">{zh ? "默认执行设备" : "Default execution device"}</h3>
        <p className="break-all text-sm">
          {device?.alias || device?.name || room.defaultDeviceId} ·{" "}
          {device?.online && devicesAvailable
            ? zh
              ? "在线"
              : "Online"
            : zh
              ? "不可用，不会自动换机器"
              : "Unavailable; no automatic device switch"}
        </p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            update("rooms.device", {
              roomId: room.id,
              defaultDeviceId: deviceId,
              expectedConfigVersion: room.configVersion,
            });
          }}
        >
          <label className="min-w-40 flex-1">
            <span className="sr-only">{zh ? "更改默认设备" : "Change default device"}</span>
            <select
              className={selectClass}
              aria-label={zh ? "更改默认设备" : "Change default device"}
              value={deviceId}
              disabled={blocked || !devicesAvailable}
              onChange={(event) => setDeviceId(event.target.value)}
            >
              {!devices.some((item) => item.id === deviceId) && (
                <option value={deviceId}>{deviceId}</option>
              )}
              {devices.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.online}>
                  {item.alias || item.name} ·{" "}
                  {item.online ? (zh ? "在线" : "Online") : zh ? "离线" : "Offline"}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            variant="secondary"
            disabled={
              blocked ||
              !devicesAvailable ||
              deviceId === room.defaultDeviceId ||
              !devices.some((item) => item.id === deviceId && item.online)
            }
          >
            {zh ? "保存设备" : "Save device"}
          </Button>
        </form>
        <p className="text-xs text-muted">
          {zh
            ? "只影响之后入队的任务。已有任务保留原目标设备。"
            : "Only affects newly queued tasks. Existing tasks keep their original target device."}
        </p>
      </div>
      <div className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-medium">
          {zh ? "成员" : "Members"} · {room.memberIds.length}/5
        </h3>
        <ul className="space-y-2">
          {room.memberIds.map((id) => (
            <li key={id} className="flex items-center justify-between gap-2 text-sm">
              <span className="break-all">
                {agents.find((agent) => agent.id === id)?.name || id}
                {id === room.leaderId ? (zh ? " · 组长" : " · Leader") : ""}
                <span className="block font-mono text-xs text-muted">{id}</span>
              </span>
              {id !== room.leaderId && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={blocked}
                  onClick={() => update("rooms.remove", { roomId: room.id, agentId: id })}
                  aria-label={`${zh ? "移除" : "Remove"} ${agents.find((agent) => agent.id === id)?.name || id}`}
                >
                  {zh ? "移除" : "Remove"}
                </Button>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            update("rooms.invite", { roomId: room.id, agentId: inviteId });
          }}
        >
          <label className="min-w-40 flex-1">
            <span className="sr-only">{zh ? "邀请 Agent" : "Invite agent"}</span>
            <select
              className={selectClass}
              aria-label={zh ? "邀请 Agent" : "Invite agent"}
              value={inviteId}
              disabled={blocked || room.memberIds.length >= 5}
              onChange={(event) => setInviteId(event.target.value)}
            >
              <option value="">{zh ? "选择 Agent" : "Select an agent"}</option>
              {candidates.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.id}) ·{" "}
                  {agent.online
                    ? agent.callable
                      ? zh
                        ? "可调用"
                        : "Callable"
                      : zh
                        ? "仅登记"
                        : "Registered only"
                    : zh
                      ? "离线"
                      : "Offline"}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="submit"
            variant="secondary"
            disabled={
              blocked ||
              room.memberIds.length >= 5 ||
              !candidates.some((agent) => agent.id === inviteId)
            }
          >
            {zh ? "邀请" : "Invite"}
          </Button>
        </form>
      </div>
    </section>
  );
}

type RoomMessage = {
  id: string;
  authorKind: "user" | "agent";
  authorId: string;
  seq: number;
  text: string;
  createdAt: number;
};
type RoomTask = {
  id: string;
  assigneeId: string;
  kind: "task" | "message";
  description?: string;
  completionCriteria?: string;
  status: string;
  resolvedDeviceId: string;
  result?: unknown;
  error?: unknown;
};

function taskStatus(status: string, zh: boolean) {
  if (!zh) return status;
  const labels: Record<string, string> = {
    queued: "已入队",
    running: "执行中",
    waiting: "等待协作结果",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    cancel_requested: "取消待确认",
    unknown: "结果待确认 · 不自动重做",
  };
  return labels[status] || status;
}

function RoomActivity({
  accountId,
  room,
  agents,
  devices,
  devicesAvailable,
  blocked,
  zh,
}: {
  accountId: string;
  room: Room;
  agents: RoomAgent[];
  devices: RoomDevice[];
  devicesAvailable: boolean;
  blocked: boolean;
  zh: boolean;
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [recipient, setRecipient] = useState("");
  const [assignee, setAssignee] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");
  const [target, setTarget] = useState("");
  const [taskId, setTaskId] = useState("");
  // Keep request IDs on a failed response: an unknown outcome must not become a new task.
  const requests = useRef(new Map<string, { action: string; input: Record<string, unknown> }>());
  const messagesKey = ["room-messages", accountId, room.leaderId, room.id];
  const tasksKey = ["room-tasks", accountId, room.leaderId, room.id];
  const messagesQ = useInfiniteQuery({
    queryKey: messagesKey,
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      roomControl<{
        messages: RoomMessage[];
        contextRev: number;
        nextCursor: number | null;
        hasMore: boolean;
      }>(
        room.leaderId,
        "messages.read",
        { roomId: room.id, discussionId: "main", afterSeq: pageParam, limit: 30 },
        signal,
      ),
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const tasksQ = useInfiniteQuery({
    queryKey: tasksKey,
    initialPageParam: "",
    queryFn: ({ signal, pageParam }) =>
      roomControl<{ tasks: RoomTask[]; nextCursor: string | null; hasMore: boolean }>(
        room.leaderId,
        "tasks.list",
        { roomId: room.id, ...(pageParam ? { afterId: pageParam } : {}), limit: 30 },
        signal,
      ),
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const taskKey = ["room-task", accountId, room.leaderId, room.id, taskId];
  const taskQ = useQuery({
    queryKey: taskKey,
    queryFn: ({ signal }) =>
      roomControl<{ task: RoomTask; events: unknown[] }>(
        room.leaderId,
        "tasks.get",
        { roomId: room.id, taskId },
        signal,
      ),
    enabled: Boolean(taskId),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const messages = messagesQ.data?.pages.flatMap((page) => page.messages) ?? [];
  const tasks = tasksQ.data?.pages.flatMap((page) => page.tasks) ?? [];
  const contextRev = messagesQ.data?.pages.at(-1)?.contextRev;
  const operation = useMutation({
    mutationFn: ({ action, input }: { action: string; input: Record<string, unknown> }) =>
      roomControl<unknown>(room.leaderId, action, input),
    retry: false,
    gcTime: 0,
    onSuccess: (_result, variables) => {
      if (variables.action === "messages.send") setText("");
      if (variables.action === "tasks.delegate") {
        setDescription("");
        setCriteria("");
      }
      for (const [key, request] of requests.current) {
        if (request.input.requestId === variables.input.requestId) requests.current.delete(key);
      }
      void qc.invalidateQueries({ queryKey: messagesKey });
      void qc.invalidateQueries({ queryKey: tasksKey });
      void qc.invalidateQueries({ queryKey: taskKey });
    },
  });
  function send(action: string, input: Record<string, unknown>) {
    if (blocked || operation.isPending) return;
    // A refresh may advance contextRev after a reply was lost. Retry the exact
    // original envelope so it remains a deduplicated request, not a new wake.
    const { expectedContextRev: _revision, ...identity } = input;
    const key = JSON.stringify({ action, input: identity });
    let request = requests.current.get(key);
    if (!request) {
      request = { action, input: { ...input, requestId: crypto.randomUUID() } };
      requests.current.set(key, request);
    }
    operation.mutate(request);
  }
  const callable = agents.filter(
    (agent) =>
      room.memberIds.includes(agent.id) &&
      agent.online &&
      agent.callable &&
      agent.mode === "runtime",
  );
  const chosenDevice = devices.find((device) => device.id === (target || room.defaultDeviceId));
  const defaultDevice = devices.find((device) => device.id === room.defaultDeviceId);
  const disabled = blocked || operation.isPending;
  const error = operation.error ?? messagesQ.error ?? tasksQ.error ?? taskQ.error;
  return (
    <section className={`${panelClass} space-y-5`} aria-labelledby="activity-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="activity-heading" className="font-medium">
          {zh ? "消息与任务" : "Messages and tasks"}
        </h2>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled || messagesQ.isFetching || tasksQ.isFetching}
          onClick={() => {
            void messagesQ.refetch();
            void tasksQ.refetch();
            if (taskId) void taskQ.refetch();
          }}
        >
          {messagesQ.isFetching || tasksQ.isFetching
            ? zh
              ? "加载中…"
              : "Loading…"
            : zh
              ? "刷新消息与任务"
              : "Refresh messages and tasks"}
        </Button>
      </div>
      <p className="text-xs text-muted">
        {zh
          ? "从组长设备读取，点击刷新获取进展。普通消息只记录；指定收件人会排队唤醒该成员。"
          : "Read from the leader device; refresh for updates. Broadcast messages only enter history. Selecting a recipient queues a reply from that member."}
      </p>
      {error && (
        <p role="alert" className="rounded-xl bg-bad/10 p-3 text-sm text-bad">
          {error.message}{" "}
          {zh
            ? "请求不会自动重发。请先刷新检查结果；发言冲突需补读后修改内容。"
            : "Requests are not retried automatically. Refresh to check the outcome; revise conflicting messages after reading the latest discussion."}
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <h3 className="text-sm font-medium">{zh ? "房间消息" : "Room messages"}</h3>
          <ol
            className="max-h-96 space-y-3 overflow-y-auto rounded-xl border border-border p-3"
            aria-label={zh ? "消息历史" : "Message history"}
          >
            {messages.map((message) => (
              <li key={message.id} className="border-b border-border pb-3 last:border-0 last:pb-0">
                <p className="break-all text-xs text-muted" title={message.authorId}>
                  {message.authorKind === "user"
                    ? zh
                      ? "用户"
                      : "User"
                    : agents.find((agent) => agent.id === message.authorId)?.name ||
                      message.authorId}
                  {message.authorKind === "agent" && message.authorId === room.leaderId
                    ? zh
                      ? " · 组长"
                      : " · Leader"
                    : ""}
                  {message.authorKind === "agent" ? ` · ${message.authorId}` : ""} · #{message.seq}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">{message.text}</p>
              </li>
            ))}
            {messagesQ.isPending && (
              <li role="status" className="text-sm text-muted">
                {zh ? "读取消息中…" : "Loading messages…"}
              </li>
            )}
            {messagesQ.isSuccess && !messages.length && (
              <li className="text-sm text-muted">{zh ? "还没有消息。" : "No messages yet."}</li>
            )}
          </ol>
          {messagesQ.hasNextPage && (
            <Button
              variant="secondary"
              size="sm"
              disabled={messagesQ.isFetching}
              onClick={() => void messagesQ.fetchNextPage()}
            >
              {zh ? "加载后续消息（读完后可发送）" : "Load newer messages to enable sending"}
            </Button>
          )}
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (contextRev === undefined || messagesQ.hasNextPage) return;
              send("messages.send", {
                roomId: room.id,
                discussionId: "main",
                expectedContextRev: contextRev,
                text: text.trim(),
                ...(recipient ? { toAgentId: recipient } : {}),
              });
            }}
          >
            <label className="block space-y-2 text-sm">
              <span>{zh ? "收件人" : "Recipient"}</span>
              <select
                className={selectClass}
                aria-label={zh ? "收件人" : "Recipient"}
                value={recipient}
                disabled={disabled}
                onChange={(event) => setRecipient(event.target.value)}
              >
                <option value="">{zh ? "仅记录 · 不唤醒成员" : "Record only · no wake"}</option>
                {callable.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.id})
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2 text-sm">
              <span>{zh ? "消息内容" : "Message"}</span>
              <textarea
                className={`${selectClass} h-28 resize-y py-3`}
                maxLength={20000}
                required
                value={text}
                disabled={disabled || room.paused}
                onChange={(event) => setText(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              disabled={
                disabled ||
                room.paused ||
                !text.trim() ||
                !messagesQ.isSuccess ||
                messagesQ.hasNextPage ||
                Boolean(
                  recipient &&
                  (!callable.some((agent) => agent.id === recipient) ||
                    !devicesAvailable ||
                    !defaultDevice?.online),
                )
              }
            >
              {zh ? "发送消息" : "Send message"}
            </Button>
          </form>
        </div>
        <div className="min-w-0 space-y-4">
          <h3 className="text-sm font-medium">{zh ? "委派任务" : "Delegate task"}</h3>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              send("tasks.delegate", {
                roomId: room.id,
                assigneeId: assignee,
                sessionId: room.id,
                description: description.trim(),
                completionCriteria: criteria.trim(),
                ...(target ? { deviceId: target } : {}),
              });
            }}
          >
            <label className="block space-y-2 text-sm">
              <span>{zh ? "执行成员" : "Assignee"}</span>
              <select
                className={selectClass}
                required
                disabled={disabled || room.paused}
                aria-label={zh ? "执行成员" : "Assignee"}
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
              >
                <option value="">
                  {zh ? "选择在线可调用成员" : "Select an online callable member"}
                </option>
                {callable.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.id}) · {agent.running}/{agent.capacity}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2 text-sm">
              <span>{zh ? "目标设备" : "Target device"}</span>
              <select
                className={selectClass}
                disabled={disabled || room.paused || !devicesAvailable}
                aria-label={zh ? "目标设备" : "Target device"}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">
                  {zh ? "使用房间默认值" : "Use room default"}:{" "}
                  {defaultDevice?.alias || defaultDevice?.name || room.defaultDeviceId}
                </option>
                {devices.map((device) => (
                  <option key={device.id} value={device.id} disabled={!device.online}>
                    {device.alias || device.name}
                    {device.online ? "" : zh ? " · 离线" : " · Offline"}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2 text-sm">
              <span>{zh ? "任务目标" : "Task objective"}</span>
              <textarea
                className={`${selectClass} h-24 resize-y py-3`}
                maxLength={20000}
                required
                value={description}
                disabled={disabled || room.paused}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="block space-y-2 text-sm">
              <span>{zh ? "完成标准" : "Completion criteria"}</span>
              <Input
                maxLength={4000}
                required
                value={criteria}
                disabled={disabled || room.paused}
                onChange={(event) => setCriteria(event.target.value)}
              />
            </label>
            {!chosenDevice?.online && (
              <p className="text-xs text-bad">
                {zh
                  ? "目标设备不可用，不会自动替换。"
                  : "Target device unavailable; it will not be replaced automatically."}
              </p>
            )}
            <Button
              type="submit"
              disabled={
                disabled ||
                room.paused ||
                !devicesAvailable ||
                !chosenDevice?.online ||
                !description.trim() ||
                !criteria.trim() ||
                !callable.some((agent) => agent.id === assignee)
              }
            >
              {zh ? "委派任务" : "Delegate task"}
            </Button>
          </form>
        </div>
      </div>
      <div className="space-y-3 border-t border-border pt-4">
        <h3 className="text-sm font-medium">{zh ? "任务账本" : "Task ledger"}</h3>
        <p className="text-xs text-muted">
          {zh
            ? "入队不等于完成。取消请求需等待运行器确认；待确认任务不自动重做。"
            : "Queued does not mean completed. Cancellation requires runtime confirmation; uncertain tasks never rerun automatically."}
        </p>
        {tasksQ.isPending && (
          <p role="status" className="text-sm text-muted">
            {zh ? "读取任务中…" : "Loading tasks…"}
          </p>
        )}
        {tasksQ.isSuccess && !tasks.length && (
          <p className="text-sm text-muted">{zh ? "还没有任务。" : "No tasks yet."}</p>
        )}
        <ul className="space-y-3">
          {tasks.map((task) => (
            <li key={task.id} className="space-y-2 rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="break-all text-sm font-medium">{task.description || task.id}</p>
                <span className="text-xs text-muted">{taskStatus(task.status, zh)}</span>
              </div>
              {task.kind === "message" && (
                <p className="text-xs text-muted">
                  {zh ? "定向消息回复" : "Directed message reply"}
                </p>
              )}
              <p className="break-all text-xs text-muted">
                {agents.find((agent) => agent.id === task.assigneeId)?.name || task.assigneeId} ·{" "}
                {zh ? "目标设备" : "Target"}:{" "}
                {devices.find((device) => device.id === task.resolvedDeviceId)?.alias ||
                  devices.find((device) => device.id === task.resolvedDeviceId)?.name ||
                  task.resolvedDeviceId}
              </p>

              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => setTaskId(task.id)}
              >
                {zh ? "查看详情与结果" : "View details and result"}
              </Button>
              {task.result != null && (
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-elevated p-3 text-xs">
                  {typeof task.result === "string"
                    ? task.result
                    : JSON.stringify(task.result, null, 2)}
                </pre>
              )}
              {!["completed", "succeeded", "failed", "cancelled", "canceled"].includes(
                task.status,
              ) && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={disabled || task.status === "cancel_requested"}
                  onClick={() => send("tasks.cancel", { roomId: room.id, taskId: task.id })}
                >
                  {task.status === "cancel_requested"
                    ? zh
                      ? "取消待确认"
                      : "Cancellation pending"
                    : zh
                      ? "请求取消"
                      : "Request cancellation"}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {tasksQ.hasNextPage && (
          <Button
            variant="secondary"
            size="sm"
            disabled={tasksQ.isFetching}
            onClick={() => void tasksQ.fetchNextPage()}
          >
            {zh ? "加载更多任务" : "Load more tasks"}
          </Button>
        )}
        {taskId && taskQ.isPending && (
          <p role="status">{zh ? "读取任务详情…" : "Loading task details…"}</p>
        )}
        {taskQ.data && (
          <article
            className="space-y-3 rounded-xl border border-border bg-elevated p-4"
            aria-label={zh ? "任务详情" : "Task details"}
          >
            <h4 className="break-all text-sm font-medium">
              {taskQ.data.task.description || taskId}
            </h4>
            <p className="text-sm">
              {zh ? "完成标准" : "Completion criteria"}: {taskQ.data.task.completionCriteria}
            </p>
            <p className="text-sm">
              {zh ? "状态" : "Status"}: {taskStatus(taskQ.data.task.status, zh)}
            </p>
            {taskQ.data.task.result != null && (
              <pre className="whitespace-pre-wrap break-words text-xs">
                {typeof taskQ.data.task.result === "string"
                  ? taskQ.data.task.result
                  : JSON.stringify(taskQ.data.task.result, null, 2)}
              </pre>
            )}
            {taskQ.data.task.error != null && (
              <pre className="whitespace-pre-wrap break-words text-xs text-bad">
                {JSON.stringify(taskQ.data.task.error, null, 2)}
              </pre>
            )}
            <details>
              <summary className="cursor-pointer text-sm">
                {zh ? "任务事件" : "Task events"}
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                {JSON.stringify(taskQ.data.events, null, 2)}
              </pre>
            </details>
          </article>
        )}
      </div>
    </section>
  );
}
