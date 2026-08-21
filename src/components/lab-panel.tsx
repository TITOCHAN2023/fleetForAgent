import { useMemo, useState } from "react";
import { labTopology, runLabSuite, type LabCheck } from "@/lib/fleet/lab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/use-i18n";
import { deviceTitle } from "@/lib/i18n/labels";

export function LabPanel() {
  const { t } = useI18n();
  const topo = useMemo(() => labTopology(), []);
  const [result, setResult] = useState<ReturnType<typeof runLabSuite> | null>(null);
  const groupLabel: Record<LabCheck["group"], string> = {
    darwin: "macOS",
    linux: "Linux",
    windows: "Windows",
    net: t("lab.pods"),
    hub: "Worker",
  };

  return (
    <div className="grid gap-4">
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">{t("lab.pods")}</h2>
        <p className="mt-2 text-sm text-muted">{t("lab.podsBody")}</p>
        <div className="mt-5 grid gap-3 md:grid-cols-4">
          <article className="rounded-lg border border-border bg-elevated p-4">
            <p className="font-mono text-xs tracking-[0.18em] text-muted uppercase">Internet</p>
            <p className="mt-2 text-sm font-medium">{topo.hub.name}</p>
            <p className="mt-2 font-mono text-xs text-subtle">{topo.hub.host}</p>
            <p className="font-mono text-xs text-subtle">{topo.hub.publicIp}</p>
          </article>
          {topo.nodes.map((n) => (
            <article key={n.slug} className="rounded-lg border border-border bg-elevated p-4">
              <p className="font-mono text-xs tracking-[0.18em] text-muted uppercase">{n.podId}</p>
              <p className="mt-2 text-sm font-medium">{deviceTitle(n.slug, n.name)}</p>
              <p className="mt-2 font-mono text-xs text-subtle">{t("lab.noLan")}</p>
              <p className="font-mono text-xs text-subtle">egress NAT · {n.locationTag}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-medium">{t("lab.suite")}</h2>
            <p className="mt-1 text-sm text-muted">{t("lab.suiteBody")}</p>
          </div>
          <Button type="button" onClick={() => setResult(runLabSuite())}>
            {t("lab.run")}
          </Button>
        </div>
        {result && (
          <p className="mt-4 font-mono text-sm tabular-nums">
            {result.failed === 0 ? (
              <span className="text-ok">{result.passed} passed / {result.failed} failed</span>
            ) : (
              <span className="text-bad">{result.passed} passed / {result.failed} failed</span>
            )}
          </p>
        )}
        {result && (
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {(Object.keys(groupLabel) as LabCheck["group"][]).map((g) => {
              const rows = result.checks.filter((c) => c.group === g);
              const bad = rows.filter((c) => !c.ok).length;
              return (
                <div key={g} className="rounded-lg border border-border bg-elevated p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{groupLabel[g]}</h3>
                    <Badge tone={bad ? "bad" : "ok"}>
                      {rows.length - bad}/{rows.length}
                    </Badge>
                  </div>
                  <ul className="mt-3 space-y-2">
                    {rows.map((c) => (
                      <li key={c.id}>
                        <p className={cn("text-sm", c.ok ? "text-fg" : "text-bad")}>
                          {c.ok ? "pass" : "fail"} · {c.title}
                        </p>
                        {!c.ok && (
                          <pre className="mt-1 max-h-24 overflow-auto font-mono text-xs text-subtle">
                            {c.detail}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
