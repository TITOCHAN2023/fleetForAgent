import { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { CommandDto, DeviceDto } from "@/lib/fleet/actions";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/use-i18n";

type Line = {
  id: string;
  kind: "cmd" | "out" | "err" | "sys";
  text: string;
};

export function ConsolePanel({
  device,
  history,
  pending,
  onRun,
}: {
  device: DeviceDto | undefined;
  history: CommandDto[];
  pending: boolean;
  onRun: (command: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const cmds = [...history].reverse();
  const lines: Line[] = [];
  if (!device) {
    lines.push({ id: "empty", kind: "sys", text: t("console.empty") });
  } else {
    lines.push({
      id: "banner",
      kind: "sys",
      text: `connected  ${device.slug}  ${device.os}/${device.arch}  ${device.status}  egress=internet  no-intranet-ip`,
    });
    for (const c of cmds) {
      lines.push({ id: `${c.id}-c`, kind: "cmd", text: c.command });
      if (c.stdout) lines.push({ id: `${c.id}-o`, kind: "out", text: c.stdout });
      if (c.stderr) lines.push({ id: `${c.id}-e`, kind: "err", text: c.stderr });
    }
  }

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, pending]);

  const past = cmds.map((c) => c.command);

  async function submit() {
    const cmd = value.trim();
    if (!cmd || pending || !device) return;
    setValue("");
    setHistIdx(-1);
    await onRun(cmd);
    inputRef.current?.focus();
  }

  return (
    <section className="bg-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-medium">{t("console.title")}</p>
          <p className="font-mono text-xs text-subtle">
            {device ? `${device.slug} · ${t("console.egress")}` : t("console.unselected")}
          </p>
        </div>
        <p className="hidden text-xs text-subtle sm:block">{t("console.hint")}</p>
      </header>
      <div
        ref={scroller}
        className="min-h-48 flex-1 overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed md:min-h-0"
      >
        {lines.map((l) => (
          <pre
            key={l.id}
            className={cn(
              "whitespace-pre-wrap break-all",
              l.kind === "cmd" && "text-accent",
              l.kind === "err" && "text-bad",
              l.kind === "sys" && "text-subtle",
              l.kind === "out" && "text-muted",
            )}
          >
            {l.kind === "cmd" ? `$ ${l.text}` : l.text}
          </pre>
        ))}
        {pending && <p className="text-subtle">…</p>}
      </div>
      <form
        className="flex items-center gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          ref={inputRef}
          value={value}
          disabled={!device || pending}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              const next = Math.min(histIdx + 1, past.length - 1);
              if (past[next]) {
                setHistIdx(next);
                setValue(past[next]!);
              }
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              const next = histIdx - 1;
              if (next < 0) {
                setHistIdx(-1);
                setValue("");
              } else if (past[next]) {
                setHistIdx(next);
                setValue(past[next]!);
              }
            }
          }}
          placeholder={device ? `${device.slug}$` : t("console.unselected")}
          className="font-mono"
        />
        <ButtonRun pending={pending} disabled={!device} />
      </form>
    </section>
  );
}

function ButtonRun({ pending, disabled }: { pending: boolean; disabled: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="inline-flex size-11 items-center justify-center rounded-sm bg-accent text-accent-fg disabled:opacity-40"
      aria-label="run"
    >
      <ArrowRight className="size-4" />
    </button>
  );
}
