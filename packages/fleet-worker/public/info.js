// Presentation only. No API calls, cookies, credentials, machine connections or task execution.
const root = document.documentElement;
function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key, value) { try { localStorage.setItem(key, value); } catch { /* Storage may be disabled; retain the in-memory preference. */ } }
let locale = stored("fleet-locale") === "zh" ? "zh" : "en";
let theme = stored("fleet-theme") || "system";
function render() {
  root.lang = locale === "zh" ? "zh-CN" : "en";
  root.dataset.theme = theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  document.querySelectorAll("[data-language]").forEach(el => { el.hidden = el.dataset.language !== locale; });
  document.querySelectorAll("[data-locale]").forEach(el => { el.setAttribute("aria-pressed", String(el.dataset.locale === locale)); });
  document.querySelectorAll("[data-theme-set]").forEach(el => {
    const value = el.dataset.themeSet;
    el.textContent = (locale === "zh" ? { light: "浅色", dark: "深色", system: "系统" } : { light: "Light", dark: "Dark", system: "System" })[value];
    el.classList.toggle("on", theme === value);
    el.setAttribute("aria-pressed", String(theme === value));
  });
}
document.querySelectorAll("[data-locale]").forEach(el => el.addEventListener("click", () => { locale = el.dataset.locale; save("fleet-locale", locale); render(); }));
document.querySelectorAll("[data-theme-set]").forEach(el => el.addEventListener("click", () => { theme = el.dataset.themeSet; save("fleet-theme", theme); render(); }));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
render();
