import { messages, type Locale, type MessageKey } from "./messages";

const KEY = "fleet-locale";
const listeners = new Set<() => void>();
let current: Locale = "en";

function read(): Locale {
  if (typeof window === "undefined") return "en";
  return window.localStorage.getItem(KEY) === "zh" ? "zh" : "en";
}

if (typeof window !== "undefined") {
  current = read();
}

export function getLocale(): Locale {
  return current;
}

export function subscribeLocale(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setLocale(next: Locale) {
  current = next === "zh" ? "zh" : "en";
  if (typeof window !== "undefined") {
    window.localStorage.setItem(KEY, current);
    document.documentElement.lang = current === "zh" ? "zh-Hant" : "en";
  }
  for (const l of listeners) l();
}

export function tr(key: MessageKey, vars?: Record<string, string | number>) {
  const table = messages[current] ?? messages.en;
  let s: string = table[key] ?? messages.en[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
