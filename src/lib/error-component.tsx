import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { tr } from "@/lib/i18n/locale";

export function AppErrorComponent({ error }: ErrorComponentProps) {
  return (
    <main className="bg-bg text-fg flex min-h-svh flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="text-bad" aria-hidden>
        <TriangleAlert className="size-8" strokeWidth={1.75} />
      </span>
      <h1 className="text-lg font-medium">{tr("err.title")}</h1>
      <p className="max-w-md text-sm break-words text-muted">
        {error.message || tr("err.body")}
      </p>
    </main>
  );
}
