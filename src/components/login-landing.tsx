import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
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
        <div className="grid items-center gap-10 md:grid-cols-[minmax(0,1fr)_22rem] md:gap-14">
          <div>
            <p className="text-sm font-medium tracking-[0.18em] text-muted uppercase">
              {t("home.kicker")}
            </p>
            <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight md:text-6xl">
              {t("home.hero")}
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted">{t("home.sub")}</p>
          </div>

          <section
            aria-label={t("home.cta")}
            className="rounded-3xl border border-border bg-surface p-4 shadow-[var(--shadow)] sm:p-5"
          >
            <p className="mb-3 text-xs font-medium tracking-[0.12em] text-muted uppercase">
              {t("home.cta")}
            </p>
            <div className="grid gap-2.5">
              {authEnabled ? (
                GROK_PROVIDERS.map((p, index) => (
                  <Button
                    key={p.providerId}
                    type="button"
                    variant={index === 0 ? "default" : "secondary"}
                    className="grid h-12 w-full grid-cols-[1.5rem_1fr_1.5rem] rounded-xl px-3"
                    onClick={() => signIn(p.providerId, { callbackURL: "/" })}
                  >
                    <span
                      aria-hidden="true"
                      className="grid size-6 place-items-center rounded-full bg-current/10 text-xs font-semibold"
                    >
                      {p.label.slice(0, 1).toUpperCase()}
                    </span>
                    <span>{t("login.continue", { label: p.label })}</span>
                    <span aria-hidden="true" />
                  </Button>
                ))
              ) : (
                <p className="py-3 text-sm text-muted">{t("login.authOff")}</p>
              )}
            </div>
          </section>
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
