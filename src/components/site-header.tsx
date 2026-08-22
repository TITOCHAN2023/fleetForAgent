import { Link } from "@tanstack/react-router";
import { LocaleSwitch } from "@/components/locale-switch";
import { ThemeSwitch } from "@/components/theme-switch";
import { useI18n } from "@/lib/i18n/use-i18n";

export function SiteHeader({ brand = "Fleet" }: { brand?: string }) {
  const { t } = useI18n();
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-5 py-3">
        <Link to="/" className="flex items-center gap-2 font-medium tracking-tight text-fg">
          <img src="/logo.png" alt="" width={28} height={28} className="size-7" />
          {brand}
        </Link>
        <nav className="ml-auto flex flex-wrap items-center gap-3 text-sm text-muted">
          <Link to="/help" className="hover:text-fg">
            {t("nav.help")}
          </Link>
          <Link to="/releases" className="hover:text-fg">
            {t("nav.downloads")}
          </Link>
          <ThemeSwitch />
          <LocaleSwitch />
        </nav>
      </div>
    </header>
  );
}
