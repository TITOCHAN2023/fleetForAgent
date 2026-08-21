import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { LoginLanding } from "@/components/login-landing";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const { user } = useCurrentUserState();
  if (user) return <Navigate to="/" />;
  return <LoginLanding />;
}
