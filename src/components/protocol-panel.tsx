import { cn } from "@/lib/utils";
import type { ProtocolDto } from "@/lib/fleet/actions";
import { useI18n } from "@/lib/i18n/use-i18n";

function pretty(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function ProtocolPanel({ events }: { events: ProtocolDto[] }) {
  const { t } = useI18n();
  return (
    <section className="bg-surface flex min-h-0 flex-col overflow-hidden rounded-xl border border-border">
      <header className="border-b border-border px-4 py-3">
        <p className="text-sm font-medium">{t("proto.title")}</p>
        <p className="text-xs text-subtle">{t("proto.sub")}</p>
      </header>
      <div className="min-h-40 flex-1 overflow-y-auto p-3">
        {events.length === 0 ? (
          <p className="px-1 text-xs text-subtle">{t("proto.empty")}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {events.map((ev) => (
              <li
                key={ev.id}
                className="rounded-md border border-border bg-elevated px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "font-mono text-xs",
                      ev.direction === "down" ? "text-accent" : "text-ok",
                    )}
                  >
                    {ev.direction === "down" ? "DO → device" : "device → DO"}
                  </span>
                  <span className="font-mono text-xs text-subtle">{ev.type}</span>
                </div>
                <pre className="mt-2 max-h-40 overflow-auto font-mono text-xs leading-relaxed text-muted">
                  {pretty(ev.envelope)}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
