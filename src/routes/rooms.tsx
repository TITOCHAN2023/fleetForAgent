import { createFileRoute } from "@tanstack/react-router";
import { RoomConsole } from "@/components/room-console";
import { SiteHeader } from "@/components/site-header";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { useI18n } from "@/lib/i18n/use-i18n";

export const Route = createFileRoute("/rooms")({ component: RoomsPage });

function RoomsPage() {
  const { user, isPending } = useCurrentUserState();
  const { locale } = useI18n();
  if (isPending)
    return (
      <p role="status" className="p-6">
        {locale === "zh" ? "正在加载账号…" : "Loading account…"}
      </p>
    );
  if (!user) return <RedirectToSignIn />;
  return (
    <main className="min-h-svh bg-bg text-fg">
      <SiteHeader />
      <RoomConsole key={user.id} accountId={user.id} />
    </main>
  );
}
