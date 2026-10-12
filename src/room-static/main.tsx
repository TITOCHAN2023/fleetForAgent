import { createRoot } from "react-dom/client";
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
      return typeof user.id === "string" && user.id ? { id: user.id } : null;
    },
    refetchOnWindowFocus: true,
    gcTime: 0,
  });
  return (
    <main className="min-h-svh bg-bg text-fg">
      <header className="border-b border-border bg-bg/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-3">
          <a href="/" className="flex items-center gap-2 font-medium text-fg">
            <img src="/logo.png" alt="" width={28} height={28} />
            Fleet
          </a>
          <nav className="ml-auto flex flex-wrap items-center gap-3 text-sm text-muted">
            <a href="/">{zh ? "设备控制台" : "Machines"}</a>
            <a href="/help">{zh ? "帮助" : "Help"}</a>
            <ThemeSwitch />
            <LocaleSwitch />
          </nav>
        </div>
      </header>
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <StaticRoomPage />
  </QueryClientProvider>,
);
