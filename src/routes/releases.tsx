import { createFileRoute } from "@tanstack/react-router";
import { ReleasesPanel } from "@/components/releases-panel";
import { SiteHeader } from "@/components/site-header";

export const Route = createFileRoute("/releases")({ component: ReleasesPage });

function ReleasesPage() {
  return (
    <main className="bg-bg text-fg min-h-svh">
      <SiteHeader brand="Fleet" />
      <div className="mx-auto max-w-[1400px] p-4 md:p-6">
        <ReleasesPanel />
      </div>
    </main>
  );
}
