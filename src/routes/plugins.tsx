import { createFileRoute } from "@tanstack/react-router";
import { PluginsPanel } from "@/components/plugins-panel";
import { SiteHeader } from "@/components/site-header";

export const Route = createFileRoute("/plugins")({ component: PluginsPage });

function PluginsPage() {
  return (
    <main className="min-h-svh bg-bg text-fg">
      <SiteHeader brand="Fleet" />
      <div className="mx-auto max-w-[1400px] p-4 md:p-6">
        <PluginsPanel />
      </div>
    </main>
  );
}
