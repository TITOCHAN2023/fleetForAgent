export type ThemePref = "light" | "dark" | "system";
export type ThemeResolved = "light" | "dark";

const KEY = "fleet-theme";
const listeners = new Set<() => void>();
let pref: ThemePref = "system";
let resolved: ThemeResolved = "light";
let media: MediaQueryList | null = null;

function darkQuery(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(p: ThemePref): ThemeResolved {
  if (p === "system") return darkQuery() ? "dark" : "light";
  return p;
}

function paint() {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-pref", pref);
  document.documentElement.style.colorScheme = resolved;
}

function readPref(): ThemePref {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function onMedia() {
  if (pref !== "system") return;
  resolved = resolve(pref);
  paint();
  for (const l of listeners) l();
}

export function initTheme() {
  if (typeof window === "undefined") return;
  pref = readPref();
  resolved = resolve(pref);
  paint();
  if (!media) {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", onMedia);
  }
}

export function getThemePref(): ThemePref {
  return pref;
}

export function getThemeResolved(): ThemeResolved {
  return resolved;
}

export function setThemePref(next: ThemePref) {
  pref = next === "light" || next === "dark" ? next : "system";
  resolved = resolve(pref);
  if (typeof window !== "undefined") window.localStorage.setItem(KEY, pref);
  paint();
  for (const l of listeners) l();
}

export function subscribeTheme(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== "undefined") initTheme();
