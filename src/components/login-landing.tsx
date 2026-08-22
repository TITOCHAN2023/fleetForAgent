import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import { LocaleSwitch } from "@/components/locale-switch";
import { useI18n } from "@/lib/i18n/use-i18n";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="currentColor"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z"
      />
      <path
        fill="currentColor"
        className="opacity-70"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z"
      />
    </svg>
  );
}

function XMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25Zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}

export function LoginLanding() {
  const { t } = useI18n();
  return (
    <main className="bg-bg text-fg min-h-svh">
      <div className="mx-auto grid min-h-svh max-w-5xl md:grid-cols-2">
        <section className="flex flex-col justify-between border-b border-border px-6 py-10 md:border-r md:border-b-0 md:px-10 md:py-14">
          <div>
            <div className="flex items-center justify-between gap-3">
              <p className="font-mono text-xs tracking-[0.22em] text-muted uppercase">Fleet</p>
              <LocaleSwitch />
            </div>
            <h1 className="mt-6 max-w-sm text-4xl font-medium tracking-tight text-fg md:text-5xl">
              {t("login.hero1")}
              <br />
              {t("login.hero2")}
              <br />
              {t("login.hero3")}
            </h1>
            <p className="mt-6 max-w-sm text-sm leading-relaxed text-muted">{t("login.body")}</p>
            <p className="mt-4">
              <Link to="/guide" className="text-sm text-muted underline underline-offset-4 hover:text-fg">
                {t("login.guide")}
              </Link>
            </p>
          </div>
          <dl className="mt-12 grid gap-4 font-mono text-xs text-subtle">
            <div>
              <dt>{t("login.proto")}</dt>
              <dd className="mt-1 text-muted">WSS hello / run / chunk / result</dd>
            </div>
            <div>
              <dt>{t("login.hub")}</dt>
              <dd className="mt-1 text-muted">{t("login.hubImpl")}</dd>
            </div>
          </dl>
        </section>

        <section className="flex flex-col justify-center px-6 py-10 md:px-12">
          <h2 className="text-lg font-medium">{t("login.enter")}</h2>
          <p className="mt-2 text-sm text-muted">{t("login.enterBody")}</p>
          <div className="mt-8 flex max-w-sm flex-col gap-3">
            {authEnabled ? (
              GROK_PROVIDERS.map((p) => (
                <Button
                  key={p.providerId}
                  type="button"
                  variant="secondary"
                  onClick={() => signIn(p.providerId, { callbackURL: "/" })}
                >
                  {p.providerId.includes("google") ? <GoogleMark /> : <XMark />}
                  {t("login.continue", { label: p.label })}
                </Button>
              ))
            ) : (
              <p className="text-sm text-muted">{t("login.authOff")}</p>
            )}
            <Link to="/guide" className="mt-2 text-center text-sm text-muted hover:text-fg">
              {t("login.guide")}
            </Link>
            <Link to="/lab" className="text-center text-sm text-muted hover:text-fg">
              {t("login.lab")}
            </Link>
            <Link to="/releases" className="text-center text-sm text-muted hover:text-fg">
              {t("login.dl")}
            </Link>
            <Link to="/agent" className="text-center text-sm text-muted hover:text-fg">
              {t("login.settings")}
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
