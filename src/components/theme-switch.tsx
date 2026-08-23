import { useEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/use-i18n";
import {
  getThemePref,
  setThemePref,
  subscribeTheme,
  type ThemePref,
} from "@/lib/theme";

const OPTS: ThemePref[] = ["light", "dark", "system"];

export function ThemeSwitch() {
  const { t } = useI18n();
  const pref = useSyncExternalStore(subscribeTheme, getThemePref, () => "system" as ThemePref);
  const segRef = useRef<HTMLDivElement>(null);
  const label: Record<ThemePref, string> = {
    light: t("theme.light"),
    dark: t("theme.dark"),
    system: t("theme.system"),
  };
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
  }, [pref, t]);
  return (
    <div ref={segRef} className="glass-seg" role="group" aria-label={t("theme.label")}>
      <span className="glass-seg-thumb" aria-hidden="true" />
      {OPTS.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => setThemePref(id)}
          data-on={pref === id ? "true" : "false"}
          className={cn(
            "glass-seg-btn h-8 rounded-full px-2.5 text-xs active:scale-[0.98]",
            pref === id ? "text-fg" : "text-muted hover:text-fg",
          )}
        >
          {label[id]}
        </button>
      ))}
    </div>
  );
}
