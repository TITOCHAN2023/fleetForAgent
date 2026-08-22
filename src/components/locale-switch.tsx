import { useEffect } from "react";
import { useI18n } from "@/lib/i18n/use-i18n";
import { cn } from "@/lib/utils";

export function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-Hant" : "en";
  }, [locale]);
  return (
    <div className="inline-flex rounded-full border border-border p-0.5" role="group" aria-label="Language">
      <button
        type="button"
        onClick={() => setLocale("en")}
        className={cn(
          "h-8 min-w-9 rounded-full px-2 text-xs",
          locale === "en" ? "bg-fg text-bg" : "text-muted hover:text-fg",
        )}
      >
        {t("lang.en")}
      </button>
      <button
        type="button"
        onClick={() => setLocale("zh")}
        className={cn(
          "h-8 min-w-9 rounded-full px-2 text-xs",
          locale === "zh" ? "bg-fg text-bg" : "text-muted hover:text-fg",
        )}
      >
        {t("lang.zh")}
      </button>
    </div>
  );
}
