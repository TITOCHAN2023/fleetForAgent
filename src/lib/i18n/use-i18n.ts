import { useSyncExternalStore } from "react";
import { getLocale, setLocale, subscribeLocale, tr } from "./locale";
import type { Locale } from "./messages";

export function useI18n() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => "en" as Locale);
  return { locale, t: tr, setLocale };
}
