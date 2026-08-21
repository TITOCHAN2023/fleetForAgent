import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  tone = "muted",
  children,
}: {
  className?: string;
  tone?: "muted" | "ok" | "warn" | "bad" | "fg";
  children: ReactNode;
}) {
  const tones = {
    muted: "text-muted bg-elevated border-border",
    ok: "text-ok bg-ok/10 border-ok/20",
    warn: "text-warn bg-warn/10 border-warn/20",
    bad: "text-bad bg-bad/10 border-bad/20",
    fg: "text-fg bg-elevated border-border",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
