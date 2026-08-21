import { createFileRoute, Link } from "@tanstack/react-router";
import { LabPanel } from "@/components/lab-panel";
import { LocaleSwitch } from "@/components/locale-switch";
import { useI18n } from "@/lib/i18n/use-i18n";

export const Route = createFileRoute("/lab")({ component: LabPage });

function LabPage() {
  const { t } = useI18n();
  return (
    <main className="bg-bg text-fg min-h-svh">
      <header className="flex items-center justify-between border-b border-border px-4 py-3 md:px-6">
        <span className="font-mono text-xs tracking-[0.22em] uppercase">Fleet lab</span>
        <nav className="flex items-center gap-4 text-sm text-muted">
          <LocaleSwitch />
          <Link to="/" className="hover:text-fg">
            {t("nav.back")}
          </Link>
        </nav>
      </header>
      <div className="mx-auto max-w-[1400px] p-4 md:p-6">
        <LabPanel />
      </div>
    </main>
  );
}
