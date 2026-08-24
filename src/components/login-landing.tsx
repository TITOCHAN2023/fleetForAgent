import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import { ArchFan } from "@/components/arch-fan";
import { SiteHeader } from "@/components/site-header";
import { useI18n } from "@/lib/i18n/use-i18n";

export function LoginLanding() {
  const { t } = useI18n();
  const keys = [
    { t: t("home.k1t"), s: t("home.k1s") },
    { t: t("home.k2t"), s: t("home.k2s") },
    { t: t("home.k3t"), s: t("home.k3s") },
    { t: t("home.k4t"), s: t("home.k4s") },
  ];
  return (
    <main className="min-h-svh bg-bg text-fg">
      <SiteHeader />
      <div className="mx-auto max-w-5xl px-5 py-16 md:py-24">
        <p className="text-sm font-medium tracking-[0.18em] text-muted uppercase">{t("home.kicker")}</p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight md:text-6xl">{t("home.hero")}</h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted">{t("home.sub")}</p>
        <div className="mt-8 flex max-w-md flex-col gap-3">
          {authEnabled ? (
            GROK_PROVIDERS.map((p) => (
              <Button
                key={p.providerId}
                type="button"
                variant="default"
                onClick={() => signIn(p.providerId, { callbackURL: "/" })}
              >
                {t("login.continue", { label: p.label })}
              </Button>
            ))
          ) : (
            <p className="text-sm text-muted">{t("login.authOff")}</p>
          )}
          <Link to="/help" className="text-center text-sm text-muted underline underline-offset-4 hover:text-fg">
            {t("nav.help")}
          </Link>
          <Link to="/docs" className="text-center text-sm text-muted underline underline-offset-4 hover:text-fg">
            {t("nav.docs")}
          </Link>
        </div>
      </div>

      <section className="mx-auto max-w-5xl px-5 pb-16">
        <h2 className="text-xl font-semibold tracking-tight">{t("home.archTitle")}</h2>
        <p className="mt-2 mb-6 max-w-2xl text-sm text-muted">{t("home.archHint")}</p>
        <ArchFan />
      </section>

      <section className="mx-auto max-w-5xl px-5 pb-20">
        <h2 className="text-xl font-semibold tracking-tight">{t("home.keysTitle")}</h2>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {keys.map((k, i) => (
            <article key={k.t} className="rounded-2xl border border-border bg-surface p-5">
              <p className="text-xs font-medium text-muted">0{i + 1}</p>
              <h3 className="mt-3 text-base font-semibold">{k.t}</h3>
              <p className="mt-1 text-sm text-muted">{k.s}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
