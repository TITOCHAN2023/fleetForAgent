import { useI18n } from "@/lib/i18n/use-i18n";

export function ArchFan() {
  const { t } = useI18n();
  return (
    <div className="grid items-stretch gap-3 md:grid-cols-[minmax(0,1fr)_12px_minmax(0,1.15fr)_12px_minmax(0,1fr)] md:items-start">
      <article className="rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow)]">
        <p className="text-[11px] font-medium tracking-[0.16em] text-muted uppercase">{t("home.tool")}</p>
        <h3 className="mt-2 text-lg font-semibold tracking-tight">{t("home.toolTitle")}</h3>
        <p className="mt-1 text-sm text-muted">{t("home.toolSub")}</p>
      </article>
      <p className="hidden text-center text-subtle md:block" aria-hidden>
        →
      </p>
      <article className="rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow)]">
        <p className="text-[11px] font-medium tracking-[0.16em] text-muted uppercase">{t("home.server")}</p>
        <h3 className="mt-2 text-lg font-semibold tracking-tight">fleet.ginfo.cc</h3>
        <p className="mt-1 text-sm text-muted">{t("home.serverSub")}</p>
      </article>
      <p className="hidden text-center text-subtle md:block" aria-hidden>
        →
      </p>
      <div className="grid gap-2">
        <article className="rounded-2xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] font-medium tracking-[0.16em] text-muted uppercase">{t("home.win")}</p>
          <p className="mt-1 text-sm font-medium">Windows amd64</p>
        </article>
        <article className="rounded-2xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] font-medium tracking-[0.16em] text-muted uppercase">{t("home.linux")}</p>
          <p className="mt-1 text-sm font-medium">Linux amd64 / arm64</p>
        </article>
        <article className="rounded-2xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] font-medium tracking-[0.16em] text-muted uppercase">{t("home.mac")}</p>
          <p className="mt-1 text-sm font-medium">macOS arm64 / amd64</p>
        </article>
      </div>
    </div>
  );
}
