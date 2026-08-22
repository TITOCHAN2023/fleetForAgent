import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AgentSettings } from "@/components/agent-settings";
import { SiteHeader } from "@/components/site-header";

export const Route = createFileRoute("/agent")({ component: AgentPage });

function AgentPage() {
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.origin), []);

  return (
    <main className="bg-bg text-fg min-h-svh">
      <SiteHeader brand="Fleet agent" />
      <div className="mx-auto max-w-[1400px] p-4 md:p-6">
        <AgentSettings defaultHub={host} />
      </div>
    </main>
  );
}
