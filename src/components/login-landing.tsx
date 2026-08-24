import { Link } from "@tanstack/react-router";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { ArchFan } from "@/components/arch-fan";
import { SiteHeader } from "@/components/site-header";
import { useI18n } from "@/lib/i18n/use-i18n";

export function LoginLanding() {
  const { t, locale } = useI18n();
  const keys = [
    { t: t("home.k1t"), s: t("home.k1s") },
    { t: t("home.k2t"), s: t("home.k2s") },
    { t: t("home.k3t"), s: t("home.k3s") },
    { t: t("home.k4t"), s: t("home.k4s") },
  ];
  return (
    <main className="min-h-svh bg-bg text-fg">
      <SiteHeader />
      <div className="mx-auto max-w-5xl px-5 py-20 text-center md:py-28">
        <h1 className="mx-auto max-w-4xl text-4xl font-semibold tracking-tight md:text-6xl">
          {t("home.hero")}
        </h1>
        <p
          lang={locale === "zh" ? "zh-CN" : "en"}
          className="mx-auto mt-5 max-w-2xl font-hand text-lg leading-relaxed text-muted"
        >
          {t("home.sub")}
        </p>

        <div className="mx-auto mt-8 grid max-w-xl gap-3 sm:grid-cols-2">
          {authEnabled ? (
            GROK_PROVIDERS.map((p, index) => (
              <div key={p.providerId} className="grid gap-3">
                <Button
                  type="button"
                  variant={index === 0 ? "default" : "secondary"}
                  className="h-11 w-full"
                  onClick={() => signIn(p.providerId, { callbackURL: "/" })}
                >
                  {t("login.continue", { label: p.label })}
                </Button>
                <Link
                  to={index === 0 ? "/help" : "/docs"}
                  className="inline-flex items-center justify-center gap-1 text-sm text-muted transition-colors hover:text-fg"
                >
                  {t(index === 0 ? "nav.help" : "nav.docs")}
                  <span aria-hidden="true">→</span>
                </Link>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted sm:col-span-2">{t("login.authOff")}</p>
          )}
        </div>
      </div>

      <section className="mx-auto max-w-5xl px-5 pb-16">
        <h2 className="text-xl font-semibold tracking-tight">{t("home.archTitle")}</h2>
        <p
          lang={locale === "zh" ? "zh-CN" : "en"}
          className="mt-2 mb-6 max-w-2xl font-hand text-base text-muted"
        >
          {t("home.archHint")}
        </p>
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
