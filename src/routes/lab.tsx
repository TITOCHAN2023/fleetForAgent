import { createFileRoute } from "@tanstack/react-router";
import { LabPanel } from "@/components/lab-panel";
import { SiteHeader } from "@/components/site-header";

export const Route = createFileRoute("/lab")({ component: LabPage });

function LabPage() {
  return (
    <main className="bg-bg text-fg min-h-svh">
      <SiteHeader brand="Fleet lab" />
      <div className="mx-auto max-w-[1400px] p-4 md:p-6">
        <LabPanel />
      </div>
    </main>
  );
}
