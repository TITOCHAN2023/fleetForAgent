import { useState } from "react";
import { Apple, Monitor, Server, Circle, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DeviceDto } from "@/lib/fleet/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { OsKind } from "@/lib/fleet/protocol";
import { useI18n } from "@/lib/i18n/use-i18n";
import { deviceTitle, locationLabel } from "@/lib/i18n/labels";

const OS: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function OsIcon({ os }: { os: string }) {
  if (os === "darwin") return <Apple className="size-4" strokeWidth={1.75} />;
  if (os === "windows") return <Monitor className="size-4" strokeWidth={1.75} />;
  return <Server className="size-4" strokeWidth={1.75} />;
}

export function DeviceRail({
  devices,
  onSelect,
  onToggle,
  onSetAlias,
  onAdd,
  onRemove,
}: {
  devices: DeviceDto[];
  onSelect: (id: string) => void;
  onToggle: (id: string, status: "online" | "offline") => void;
  onSetAlias: (id: string, alias: string) => Promise<void> | void;
  onAdd: (p: { name: string; os: OsKind; locationTag: string }) => Promise<void> | void;
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [os, setOs] = useState<OsKind>("linux");
  const [locationTag, setLocationTag] = useState("home");
  const [busy, setBusy] = useState(false);
  const [aliasBusy, setAliasBusy] = useState<string | null>(null);

  return (
    <aside className="flex min-h-0 flex-col gap-2">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-xs font-medium tracking-[0.18em] text-muted uppercase">
          {t("fleet.title")}
        </h2>
        <span className="font-mono text-xs tabular-nums text-subtle">
          {devices.filter((d) => d.status === "online").length}/{devices.length}
          <span className="ml-1 text-subtle">{t("fleet.uncapped")}</span>
        </span>
      </div>
      <ul className="flex gap-2 overflow-x-auto pb-1 md:max-h-[calc(100svh-14rem)] md:flex-col md:overflow-y-auto">
        {devices.length === 0 && (
          <li className="rounded-lg border border-dashed border-border bg-surface px-3 py-4 text-sm text-muted">
            {t("fleet.empty")}
          </li>
        )}
        {devices.map((d) => (
          <li key={d.id} className="min-w-56 flex-1 md:min-w-0 md:flex-none">
            <button
              type="button"
              onClick={() => onSelect(d.id)}
              className={cn(
                "w-full rounded-lg border px-3 py-3 text-left transition-[border-color,background-color] duration-150",
                d.selected
                  ? "border-accent/40 bg-elevated"
                  : "border-border bg-surface hover:border-accent/25",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 text-fg">
                  <OsIcon os={d.os} />
                  <span className="text-sm font-medium">
                    {d.alias || deviceTitle(d.slug, d.name)}
                  </span>
                </div>
                <span className="flex items-center gap-1 text-xs text-muted">
                  <Circle
                    className={cn(
                      "size-2 fill-current",
                      d.status === "online" ? "text-ok" : "text-subtle",
                    )}
                    strokeWidth={0}
                  />
                  {d.status === "online" ? t("fleet.online") : t("fleet.offline")}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge>{OS[d.os] ?? d.os}</Badge>
                <Badge>{locationLabel(d.locationTag)}</Badge>
                <Badge className="font-mono">{d.arch}</Badge>
                {d.agentVer && <Badge className="font-mono">Agent {d.agentVer}</Badge>}
              </div>
              <p className="mt-2 font-mono text-xs text-subtle">
                {d.alias ? `${d.name} · ` : ""}
                {d.slug} · {t("fleet.noLan")}
              </p>
            </button>
            <form
              className="mt-1 flex gap-1"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                setAliasBusy(d.id);
                try {
                  await onSetAlias(d.id, String(form.get("alias") ?? ""));
                } catch {
                  // The parent mutation owns the user-facing error toast.
                } finally {
                  setAliasBusy(null);
                }
              }}
            >
              <Input
                key={`${d.id}:${d.alias ?? ""}`}
                name="alias"
                defaultValue={d.alias ?? ""}
                maxLength={64}
                className="h-8 min-w-0 text-xs"
                placeholder={t("fleet.aliasPh")}
                aria-label={t("fleet.alias")}
              />
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                disabled={aliasBusy === d.id}
              >
                {t("fleet.aliasSave")}
              </Button>
            </form>
            <div className="mt-1 flex justify-between px-1 text-xs">
              <button
                type="button"
                onClick={() =>
                  onToggle(d.id, d.status === "online" ? "offline" : "online")
                }
                className="text-subtle hover:text-muted"
              >
                {d.status === "online" ? t("fleet.simOff") : t("fleet.simOn")}
              </button>
              <button
                type="button"
                onClick={() => onRemove(d.id)}
                className="text-subtle hover:text-bad"
              >
                {t("fleet.remove")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {open ? (
        <form
          className="rounded-lg border border-border bg-surface p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await onAdd({ name: name.trim() || "node", os, locationTag });
              setName("");
              setOpen(false);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("fleet.namePh")}
            aria-label={t("join.name")}
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select
              value={os}
              onChange={(e) => setOs(e.target.value as OsKind)}
              className="h-11 rounded-sm border border-border bg-elevated px-2 text-sm text-fg"
              aria-label={t("join.os")}
            >
              <option value="linux">Linux</option>
              <option value="darwin">macOS</option>
              <option value="windows">Windows</option>
            </select>
            <select
              value={locationTag}
              onChange={(e) => setLocationTag(e.target.value)}
              className="h-11 rounded-sm border border-border bg-elevated px-2 text-sm text-fg"
              aria-label={t("join.loc")}
            >
              <option value="home">{t("loc.home")}</option>
              <option value="colo">{t("loc.colo")}</option>
              <option value="cloud">{t("loc.cloud")}</option>
            </select>
          </div>
          <div className="mt-2 flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {t("fleet.join")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t("fleet.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          <Plus className="size-4" strokeWidth={1.75} />
          {t("fleet.add")}
        </Button>
      )}
    </aside>
  );
}
