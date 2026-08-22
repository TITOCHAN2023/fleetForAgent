import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/guide")({ component: GuideRedirect });

function GuideRedirect() {
  return <Navigate to="/help" replace />;
}
