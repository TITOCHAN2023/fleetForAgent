import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAgent } from "@/lib/agent/use-agent";
import {
  agentApprove,
  agentConnect,
  agentDeny,
  agentDisconnect,
  agentIncoming,
  agentSetEnabled,
  agentSetPermit,
  agentTick,
} from "@/lib/agent/store";
import type { Permit } from "@/lib/agent/runtime";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/use-i18n";
import type { MessageKey } from "@/lib/i18n/messages";

const LEVEL_KEYS: { id: Permit; title: MessageKey; body: MessageKey }[] = [
  { id: "off", title: "permit.off", body: "permit.offBody" },
  { id: "ask", title: "permit.ask", body: "permit.askBody" },
  { id: "allow", title: "permit.allow", body: "permit.allowBody" },
];

const CONN_TONE: Record<string, { key: MessageKey; tone: "muted" | "ok" | "warn" | "bad" }> = {
  offline: { key: "conn.offline", tone: "muted" },
  connecting: { key: "conn.connecting", tone: "warn" },
  online: { key: "conn.online", tone: "ok" },
  error: { key: "conn.error", tone: "bad" },
};

export function AgentSettings({ defaultHub = "" }: { defaultHub?: string }) {
  const { t } = useI18n();
  const snap = useAgent();
  const [hub, setHub] = useState(snap.hubInput || defaultHub);
  const [busy, setBusy] = useState(false);
  const [demoCmd, setDemoCmd] = useState("uname -a");

  useEffect(() => {
    const timer = setInterval(() => agentTick(), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hub && defaultHub) setHub(defaultHub);
  }, [defaultHub, hub]);

  async function onConnect() {
    setBusy(true);
    try {
      agentSetEnabled(true);
      const s = await agentConnect(hub.trim());
      if (s.conn === "online") toast.success(t("agent.connected", { host: s.hub && s.hub.ok ? s.hub.host : "" }));
      else toast.error(s.error || t("agent.fail"));
    } finally {
      setBusy(false);
    }
  }

  const conn = CONN_TONE[snap.conn] ?? CONN_TONE.offline;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="grid gap-4">
        <section className="rounded-xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-medium">{t("agent.title")}</h2>
              <p className="mt-1 text-sm text-muted">{t("agent.body")}</p>
            </div>
            <Badge tone={conn.tone}>{t(conn.key)}</Badge>
          </div>

          <label className="mt-5 flex items-center justify-between gap-3 rounded-lg border border-border bg-elevated px-4 py-3">
            <span className="text-sm">{t("agent.allow")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={snap.enabled}
              onClick={() => {
                const next = !snap.enabled;
                agentSetEnabled(next);
                if (!next) toast.message(t("agent.off"));
              }}
              className={cn(
                "relative h-7 w-12 rounded-full transition-colors duration-150",
                snap.enabled ? "bg-ok/40" : "bg-border",
              )}
            >
              <span
                className={cn(
                  "absolute top-1 size-5 rounded-full bg-fg transition-transform duration-150",
                  snap.enabled ? "translate-x-6" : "translate-x-1",
                )}
              />
            </button>
          </label>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Input
              value={hub}
              onChange={(e) => setHub(e.target.value)}
              placeholder="keel.example.workers.dev"
              aria-label={t("agent.domain")}
            />
            {snap.conn === "online" ? (
              <Button type="button" variant="secondary" onClick={() => agentDisconnect()}>
                {t("agent.disconnect")}
              </Button>
            ) : (
              <Button type="button" disabled={busy} onClick={() => void onConnect()}>
                {busy ? t("agent.connecting") : t("agent.connect")}
              </Button>
            )}
          </div>
          {snap.error && <p className="mt-2 text-sm text-bad">{snap.error}</p>}
          {snap.hub && snap.hub.ok && (
            <p className="mt-2 font-mono text-xs text-subtle">{snap.hub.wss}</p>
          )}
        </section>

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-base font-medium">{t("permit.title")}</h2>
          <p className="mt-1 text-sm text-muted">{t("permit.body")}</p>
          <div className="mt-4 grid gap-2">
            {LEVEL_KEYS.map((lv) => (
              <button
                key={lv.id}
                type="button"
                onClick={() => agentSetPermit(lv.id)}
                className={cn(
                  "rounded-lg border px-4 py-3 text-left transition-[border-color,background-color] duration-150",
                  snap.permit === lv.id
                    ? "border-accent/40 bg-elevated"
                    : "border-border bg-bg hover:border-accent/25",
                )}
              >
                <span className="text-sm font-medium">{t(lv.title)}</span>
                <span className="mt-1 block text-sm text-muted">{t(lv.body)}</span>
              </button>
            ))}
          </div>
        </section>

        {snap.pending && (
          <section className="rounded-xl border border-warn/30 bg-surface p-5">
            <h2 className="text-base font-medium">{t("consent.title")}</h2>
            <pre className="mt-3 overflow-x-auto rounded-sm bg-elevated p-3 font-mono text-sm">
              {snap.pending.command}
            </pre>
            <div className="mt-4 flex gap-2">
              <Button type="button" onClick={() => agentApprove()}>
                {t("consent.allow")}
              </Button>
              <Button type="button" variant="danger" onClick={() => agentDeny()}>
                {t("consent.deny")}
              </Button>
            </div>
          </section>
        )}

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="text-base font-medium">{t("try.title")}</h2>
          <p className="mt-1 text-sm text-muted">{t("try.body")}</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Input
              value={demoCmd}
              onChange={(e) => setDemoCmd(e.target.value)}
              placeholder="uname -a"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                if (snap.conn !== "online") {
                  toast.error(t("agent.needHub"));
                  return;
                }
                const out = agentIncoming(demoCmd);
                if (out.status === "pending") toast.message(t("try.wait"));
                else if (out.status === "refused") toast.error(out.stderr);
                else toast.success(out.stdout.slice(0, 80) || "ok");
              }}
            >
              {t("try.send")}
            </Button>
          </div>
          {snap.lastOutcome && (
            <pre className="mt-4 max-h-40 overflow-auto rounded-sm bg-elevated p-3 font-mono text-xs text-muted">
              {snap.lastOutcome.stdout || snap.lastOutcome.stderr}
            </pre>
          )}
        </section>
      </div>

      <aside className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">{t("logs.title")}</h2>
        <ul className="mt-4 max-h-[32rem] space-y-2 overflow-auto font-mono text-xs">
          {snap.logs.length === 0 && <li className="text-subtle">{t("logs.empty")}</li>}
          {snap.logs.map((l) => (
            <li key={l.id} className={cn(l.level === "error" ? "text-bad" : l.level === "warn" ? "text-warn" : "text-muted")}>
              <span className="text-subtle">{new Date(l.t).toISOString().slice(11, 19)}</span>{" "}
              {l.msg}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
