import { createFileRoute } from "@tanstack/react-router";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { FleetConsole } from "@/components/fleet-console";
import { LoginLanding } from "@/components/login-landing";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user } = useCurrentUserState();
  if (user) return <FleetConsole />;
  return <LoginLanding />;
}
