import { useEffect, useRef } from "react";
import { useI18n } from "@/lib/i18n/use-i18n";
import { cn } from "@/lib/utils";

export function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();
  const segRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-Hant" : "en";
  }, [locale]);
  useEffect(() => {
    const seg = segRef.current;
    if (!seg) return;
    const sync = () => {
      const active = seg.querySelector<HTMLButtonElement>("button[data-on='true']") ?? seg.querySelector<HTMLButtonElement>("button");
      if (!active) return;
      const s = seg.getBoundingClientRect();
      const b = active.getBoundingClientRect();
      seg.style.setProperty("--seg-x", `${b.left - s.left}px`);
      seg.style.setProperty("--seg-w", `${b.width}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(seg);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [locale, t]);
  return (
    <div ref={segRef} className="glass-seg" role="group" aria-label="Language">
      <span className="glass-seg-thumb" aria-hidden="true" />
      <button
        type="button"
        onClick={() => setLocale("en")}
        data-on={locale === "en" ? "true" : "false"}
        className={cn(
          "glass-seg-btn h-8 min-w-9 rounded-full px-2 text-xs active:scale-[0.98]",
          locale === "en" ? "text-fg" : "text-muted hover:text-fg",
        )}
      >
        {t("lang.en")}
      </button>
      <button
        type="button"
        onClick={() => setLocale("zh")}
        data-on={locale === "zh" ? "true" : "false"}
        className={cn(
          "glass-seg-btn h-8 min-w-9 rounded-full px-2 text-xs active:scale-[0.98]",
          locale === "zh" ? "text-fg" : "text-muted hover:text-fg",
        )}
      >
        {t("lang.zh")}
      </button>
    </div>
  );
}
