import { createFileRoute, Link } from "@tanstack/react-router";
import { GuidePanel } from "@/components/guide-panel";
import { ArchFan } from "@/components/arch-fan";
import { SiteHeader } from "@/components/site-header";
import { useI18n } from "@/lib/i18n/use-i18n";

export const Route = createFileRoute("/help")({ component: HelpPage });

function HelpPage() {
  const { t } = useI18n();
  return (
    <main className="min-h-svh bg-bg text-fg">
      <SiteHeader />
      <div className="mx-auto max-w-5xl px-5 py-10 md:py-14">
        <p className="text-sm font-medium tracking-[0.18em] text-muted uppercase">{t("home.kicker")}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">{t("help.title")}</h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">{t("help.lead")}</p>
        <p className="mt-3">
          <Link to="/" className="text-sm text-muted underline underline-offset-4 hover:text-fg">
            {t("nav.back")}
          </Link>
        </p>
        <div className="mt-10">
          <h2 className="mb-4 text-lg font-semibold">{t("home.archTitle")}</h2>
          <ArchFan />
        </div>
        <div className="mt-10">
          <GuidePanel />
        </div>
      </div>
    </main>
  );
}
