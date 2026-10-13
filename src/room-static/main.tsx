import { createRoot } from "react-dom/client";
import { useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RoomConsole } from "@/components/room-console";
import { LocaleSwitch } from "@/components/locale-switch";
import { ThemeSwitch } from "@/components/theme-switch";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/use-i18n";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export function StaticRoomPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [logoutState, setLogoutState] = useState<"idle" | "pending" | "error">("idle");
  const session = useQuery({
    queryKey: ["room-account"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/v1/me", {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok)
        throw new Error(zh ? "无法读取登录状态。" : "Unable to read account session.");
      const user = await response.json();
      return typeof user.id === "string" && user.id
        ? { id: user.id, email: String(user.email || ""), ops: Boolean(user.ops) }
        : null;
    },
    refetchOnWindowFocus: true,
    gcTime: 0,
  });
  return (
    <div className="min-h-svh bg-bg text-fg">
      <header className="fleet-top">
        <a href="/" className="fleet-brand">
          <img src="/logo.png" alt="" width={28} height={28} />
          Fleet
        </a>
        <nav className="fleet-nav" aria-label={zh ? "主导航" : "Main navigation"}>
          <a href="/#machines">{zh ? "机器" : "Machines"}</a>
          <a href="/rooms/" aria-current="page">
            {zh ? "房间" : "Rooms"}
          </a>
          <a href="/plugins">{zh ? "插件" : "Plugins"}</a>
        </nav>
        <div className="fleet-tools">
          <details className="fleet-menu fleet-menu-resources">
            <summary>{zh ? "资源" : "Resources"} ▾</summary>
            <div className="fleet-menu-pop">
              <a href="/help">{zh ? "帮助" : "Help"}</a>
              <a href="/docs">{zh ? "文档" : "Docs"}</a>
              <a href="/trust">{zh ? "源码" : "Source"}</a>
              <a
                href="https://github.com/TITOCHAN2023/fleetForAgent"
                target="_blank"
                rel="noreferrer"
              >
                GitHub ↗
              </a>
            </div>
          </details>
          {session.data && (
            <details className="fleet-menu">
              <summary aria-label={zh ? "账号" : "Account"}>
                <span className="fleet-avatar">
                  {(session.data.email || "F").slice(0, 1).toUpperCase()}
                </span>
              </summary>
              <div className="fleet-menu-pop">
                <span className="fleet-account-email">{session.data.email}</span>
                <a href="/#settings">{zh ? "接入与设置" : "Setup & settings"}</a>
                {session.data.ops && <a href="/ops">{zh ? "管理" : "Ops"}</a>}
                <button
                  type="button"
                  disabled={logoutState === "pending"}
                  onClick={async () => {
                    setLogoutState("pending");
                    try {
                      const response = await fetch("/v1/logout", {
                        method: "POST",
                        credentials: "same-origin",
                        headers: { "content-type": "application/json" },
                        body: "{}",
                      });
                      if (!response.ok) throw new Error("logout failed");
                      queryClient.clear();
                      location.assign("/");
                    } catch {
                      setLogoutState("error");
                    }
                  }}
                >
                  {zh ? "退出" : "Sign out"}
                </button>
              </div>
            </details>
          )}
          <ThemeSwitch />
          <LocaleSwitch />
        </div>
      </header>
      {logoutState === "error" && (
        <p role="alert" className="p-6">
          {zh ? "退出失败，请重试。" : "Sign out failed. Please try again."}
        </p>
      )}
      {session.isPending ? (
        <p role="status" className="p-6">
          {zh ? "正在加载账号…" : "Loading account…"}
        </p>
      ) : session.isError ? (
        <div className="space-y-3 p-6">
          <p role="alert">{session.error.message}</p>
          <Button onClick={() => void session.refetch()}>{zh ? "重试" : "Retry"}</Button>
        </div>
      ) : session.data ? (
        <RoomConsole key={session.data.id} accountId={session.data.id} />
      ) : (
        <section className="mx-auto max-w-xl space-y-4 p-6">
          <h1 className="text-2xl font-semibold">Fleet Room</h1>
          <p>
            {zh
              ? "请先使用现有 Fleet 账号登录，再打开 Rooms。"
              : "Sign in to your Fleet account, then open Rooms."}
          </p>
          <a href="/" className="underline underline-offset-4">
            {zh ? "前往 Fleet 登录" : "Sign in to Fleet"}
          </a>
        </section>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <StaticRoomPage />
  </QueryClientProvider>,
);
