import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { signOut } from "@/lib/auth/client";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import {
  addDevice,
  createJoinCode,
  listCommands,
  listDevices,
  listJoinCodes,
  listProtocol,
  redeemJoinCode,
  removeDevice,
  runCommand,
  selectDevice,
  setDeviceAlias,
  toggleDevice,
  type DeviceDto,
} from "@/lib/fleet/actions";
import { TOOLS } from "@/lib/fleet/protocol";
import { DeviceRail } from "@/components/device-rail";
import { ConsolePanel } from "@/components/console-panel";
import { ProtocolPanel } from "@/components/protocol-panel";
import { LabPanel } from "@/components/lab-panel";
import { AgentSettings } from "@/components/agent-settings";
import { HubAccess } from "@/components/hub-access";
import { ReleasesPanel } from "@/components/releases-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LocaleSwitch } from "@/components/locale-switch";
import { ThemeSwitch } from "@/components/theme-switch";
import { useI18n } from "@/lib/i18n/use-i18n";
import type { MessageKey } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import type { OsKind } from "@/lib/fleet/protocol";

type Tab = "console" | "join" | "tools" | "lab" | "spec" | "agent" | "releases";

const TABS: { id: Tab; label: MessageKey }[] = [
  { id: "console", label: "tab.console" },
  { id: "releases", label: "tab.releases" },
  { id: "lab", label: "tab.lab" },
  { id: "join", label: "tab.join" },
  { id: "tools", label: "tab.tools" },
  { id: "spec", label: "tab.spec" },
  { id: "agent", label: "tab.agent" },
];

function isTab(value: string | undefined): value is Tab {
  return TABS.some((item) => item.id === value);
}

export function FleetConsole({ initialTab }: { initialTab?: string } = {}) {
  const { t } = useI18n();
  const user = useCurrentUser();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>(() => (isTab(initialTab) ? initialTab : "console"));
  const [running, setRunning] = useState(false);

  const devicesQ = useQuery({
    queryKey: ["devices"],
    queryFn: () => listDevices(),
    refetchInterval: 4000,
  });
  const commandsQ = useQuery({
    queryKey: ["commands"],
    queryFn: () => listCommands(),
  });
  const protoQ = useQuery({
    queryKey: ["protocol"],
    queryFn: () => listProtocol(),
    refetchInterval: 4000,
  });
  const codesQ = useQuery({
    queryKey: ["codes"],
    queryFn: () => listJoinCodes(),
  });

  const devices = devicesQ.data ?? [];
  const selected = devices.find((d) => d.selected);

  function invalidateAll() {
    void qc.invalidateQueries({ queryKey: ["devices"] });
    void qc.invalidateQueries({ queryKey: ["commands"] });
    void qc.invalidateQueries({ queryKey: ["protocol"] });
    void qc.invalidateQueries({ queryKey: ["codes"] });
  }

  const selectMut = useMutation({
    mutationFn: (id: string) => selectDevice({ data: id }),
    onSuccess: invalidateAll,
    onError: (e: Error) => toast.error(e.message),
  });
  const toggleMut = useMutation({
    mutationFn: (p: { id: string; status: "online" | "offline" }) =>
      toggleDevice({ data: p }),
    onSuccess: invalidateAll,
    onError: (e: Error) => toast.error(e.message),
  });
  const aliasMut = useMutation({
    mutationFn: (p: { id: string; alias: string }) => setDeviceAlias({ data: p }),
    onSuccess: () => {
      toast.success(t("fleet.aliasSaved"));
      void qc.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const addMut = useMutation({
    mutationFn: (p: { name: string; os: OsKind; locationTag: string }) =>
      addDevice({ data: p }),
    onSuccess: () => {
      toast.success(t("fleet.added"));
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeMut = useMutation({
    mutationFn: (id: string) => removeDevice({ data: id }),
    onSuccess: () => {
      toast.message(t("fleet.removed"));
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function onRun(command: string) {
    setRunning(true);
    try {
      const res = await runCommand({ data: command });
      if (res.status === "offline") toast.error(res.stderr);
      invalidateAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("toast.runFail"));
    } finally {
      setRunning(false);
    }
  }

  const label = user?.displayName ?? user?.primaryEmail ?? "Account";

  return (
    <div className="bg-bg text-fg flex min-h-svh flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="" width={28} height={28} className="size-7" />
          <span className="font-medium tracking-tight">Fleet</span>
          <span className="hidden text-xs text-subtle sm:inline">{t("header.subtitle")}</span>
        </div>
        <nav className="flex flex-1 flex-wrap gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                "rounded-sm px-3 py-2 text-sm transition-colors duration-150",
                tab === item.id ? "bg-elevated text-fg" : "text-muted hover:text-fg",
              )}
            >
              {t(item.label)}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <Link to="/help" className="text-sm text-muted hover:text-fg">
            {t("header.guide")}
          </Link>
          <Link to="/docs" className="text-sm text-muted hover:text-fg">
            {t("nav.docs")}
          </Link>
          <ThemeSwitch />
          <LocaleSwitch />
          <span className="max-w-32 truncate text-sm text-muted">{label}</span>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            {t("header.signOut")}
          </Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-4 p-4 md:p-6">
        {tab === "console" && (
          <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)_22rem] lg:items-stretch">
            <DeviceRail
              devices={devices}
              onSelect={(id) => selectMut.mutate(id)}
              onToggle={(id, status) => toggleMut.mutate({ id, status })}
              onSetAlias={async (id, alias) => {
                await aliasMut.mutateAsync({ id, alias });
              }}
              onAdd={async (p) => {
                await addMut.mutateAsync(p);
              }}
              onRemove={(id) => removeMut.mutate(id)}
            />
            <ConsolePanel
              device={selected}
              history={commandsQ.data ?? []}
              pending={running}
              onRun={onRun}
            />
            <ProtocolPanel events={protoQ.data ?? []} />
          </div>
        )}
        {tab === "lab" && <LabPanel />}
        {tab === "agent" && (
          <div className="grid gap-4">
            <HubAccess />
            <AgentSettings defaultHub={typeof window !== "undefined" ? window.location.origin : ""} />
          </div>
        )}
        {tab === "releases" && <ReleasesPanel />}
        {tab === "join" && (
          <JoinView
            codes={codesQ.data ?? []}
            onCreated={invalidateAll}
          />
        )}
        {tab === "tools" && <ToolsView devices={devices} selected={selected} />}
        {tab === "spec" && <SpecView />}
      </div>
    </div>
  );
}

function JoinView({
  codes,
  onCreated,
}: {
  codes: Awaited<ReturnType<typeof listJoinCodes>>;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("studio-pc");
  const [os, setOs] = useState<OsKind>("linux");
  const [locationTag, setLocationTag] = useState("home");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">{t("join.code")}</h2>
        <p className="mt-2 text-sm text-muted">{t("join.codeBody")}</p>
        <Button
          className="mt-5"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await createJoinCode({ data: true });
              setCode(r.code);
              toast.success(t("join.codeToast", { code: r.code }));
              onCreated();
            } catch (e) {
              toast.error(e instanceof Error ? e.message : t("join.fail"));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("join.gen")}
        </Button>
        <ul className="mt-6 space-y-2 font-mono text-sm">
          {codes.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2">
              <span className="tracking-widest">{c.code}</span>
              {c.usedAt ? <Badge tone="muted">{t("join.used")}</Badge> : <Badge tone="ok">{t("join.valid")}</Badge>}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">{t("join.sim")}</h2>
        <p className="mt-2 text-sm text-muted">{t("join.simBody")}</p>
        <form
          className="mt-5 grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await redeemJoinCode({
                data: { code, name, os, locationTag },
              });
              toast.success(t("join.ok"));
              onCreated();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : t("join.fail"));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="grid gap-1 text-xs text-muted">
            {t("join.codeField")}
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              className="font-mono tracking-widest"
              placeholder="ABCD2345"
              required
            />
          </label>
          <label className="grid gap-1 text-xs text-muted">
            {t("join.name")}
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-xs text-muted">
              {t("join.os")}
              <select
                value={os}
                onChange={(e) => setOs(e.target.value as OsKind)}
                className="h-11 rounded-sm border border-border bg-elevated px-3 text-sm text-fg"
              >
                <option value="darwin">macOS</option>
                <option value="linux">Linux</option>
                <option value="windows">Windows</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted">
              {t("join.loc")}
              <select
                value={locationTag}
                onChange={(e) => setLocationTag(e.target.value)}
                className="h-11 rounded-sm border border-border bg-elevated px-3 text-sm text-fg"
              >
                <option value="home">{t("loc.home")}</option>
                <option value="colo">{t("loc.colo")}</option>
                <option value="cloud">{t("loc.cloud")}</option>
              </select>
            </label>
          </div>
          <Button type="submit" disabled={busy}>
            {t("join.submit")}
          </Button>
        </form>
      </section>
    </div>
  );
}

function ToolsView({
  devices,
  selected,
}: {
  devices: DeviceDto[];
  selected: DeviceDto | undefined;
}) {
  const { t } = useI18n();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const payload = devices.map((d) => ({
    id: d.id,
    alias: d.alias,
    name: d.name,
    os: d.os,
    agentVer: d.agentVer,
    where: d.locationTag,
    online: d.status === "online",
    arch: d.arch,
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">{t("tools.title")}</h2>
        <p className="mt-2 text-sm text-muted">{t("tools.body")}</p>
        <pre className="mt-4 overflow-auto rounded-md bg-elevated p-4 font-mono text-xs text-muted">
{`FLEET_URL=${origin || "https://your.site"}
FLEET_TOKEN=flt_…          # generate under Settings
npx -y https://fleet.ginfo.cc/fleet-tool.tgz`}
        </pre>
        <ol className="mt-5 space-y-3">
          {TOOLS.map((tool) => (
            <li key={tool.name} className="rounded-md border border-border bg-elevated px-3 py-3">
              <p className="font-mono text-sm text-accent">{tool.name}</p>
              <p className="mt-1 text-sm text-muted">{tool.description}</p>
            </li>
          ))}
        </ol>
      </section>
      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-medium">{t("tools.list")}</h2>
          <Badge tone="ok">
            {selected ? `selected ${selected.alias || selected.slug}` : "unselected"}
          </Badge>
        </div>
        <pre className="mt-4 overflow-auto rounded-md bg-elevated p-4 font-mono text-xs leading-relaxed text-muted">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </section>
    </div>
  );
}

function SpecView() {
  const { t } = useI18n();
  const cards: { title: MessageKey; body: MessageKey }[] = [
    { title: "spec.link", body: "spec.linkBody" },
    { title: "spec.env", body: "spec.envBody" },
    { title: "spec.sec", body: "spec.secBody" },
    { title: "spec.fleet", body: "spec.fleetBody" },
    { title: "spec.pod", body: "spec.podBody" },
    { title: "spec.deploy", body: "spec.deployBody" },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {cards.map((c) => (
        <section key={c.title} className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-base font-medium">{t(c.title)}</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">{t(c.body)}</p>
        </section>
      ))}
    </div>
  );
}

export function FleetSkeleton() {
  return (
    <div className="bg-bg min-h-svh">
      <div className="h-14 border-b border-border" />
      <div className="mx-auto grid max-w-[1400px] gap-4 p-6 lg:grid-cols-[17rem_1fr_22rem]">
        <div className="bg-surface h-64 animate-pulse rounded-xl" />
        <div className="bg-surface h-96 animate-pulse rounded-xl" />
        <div className="bg-surface h-64 animate-pulse rounded-xl" />
      </div>
    </div>
  );
}
