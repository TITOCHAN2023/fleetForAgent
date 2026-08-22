import { createFileRoute } from "@tanstack/react-router";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { FleetConsole } from "@/components/fleet-console";
import { LoginLanding } from "@/components/login-landing";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  component: Home,
});

function Home() {
  const { user } = useCurrentUserState();
  const { tab } = Route.useSearch();
  if (user) return <FleetConsole initialTab={tab} />;
  return <LoginLanding />;
}
