import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";

export const Route = createFileRoute("/docs")({ component: DocsLayout });

function DocsLayout() {
  return (
    <main className="min-h-svh bg-bg text-fg">
      <SiteHeader />
      <div className="px-5 py-12 md:py-16">
        <Outlet />
      </div>
    </main>
  );
}
