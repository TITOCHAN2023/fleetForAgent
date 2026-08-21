import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AgentSettings } from "@/components/agent-settings";
import { LocaleSwitch } from "@/components/locale-switch";
import { useI18n } from "@/lib/i18n/use-i18n";

export const Route = createFileRoute("/agent")({ component: AgentPage });

function AgentPage() {
  const { t } = useI18n();
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.host), []);

  return (
    <main className="bg-bg text-fg min-h-svh">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <span className="font-mono text-xs tracking-[0.22em] uppercase">Keel agent</span>
        <nav className="flex items-center gap-4 text-sm text-muted">
          <LocaleSwitch />
          <Link to="/releases" className="hover:text-fg">
            {t("nav.downloads")}
          </Link>
          <Link to="/" className="hover:text-fg">
            {t("nav.back")}
          </Link>
        </nav>
      </header>
      <div className="mx-auto max-w-[1400px] p-4 md:p-6">
        <AgentSettings defaultHub={host} />
      </div>
    </main>
  );
}
