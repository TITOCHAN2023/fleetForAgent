import { useSyncExternalStore } from "react";
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
  const label: Record<ThemePref, string> = {
    light: t("theme.light"),
    dark: t("theme.dark"),
    system: t("theme.system"),
  };
  return (
    <div className="inline-flex rounded-full border border-border p-0.5" role="group" aria-label={t("theme.label")}>
      {OPTS.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => setThemePref(id)}
          className={cn(
            "h-8 rounded-full px-2.5 text-xs transition-colors",
            pref === id ? "bg-fg text-bg" : "text-muted hover:text-fg",
          )}
        >
          {label[id]}
        </button>
      ))}
    </div>
  );
}
