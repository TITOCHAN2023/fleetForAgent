import { createFileRoute } from "@tanstack/react-router";
import { handleMcpSse } from "@/lib/fleet/mcp-sse.server";

export const Route = createFileRoute("/mcp/sse")({
  server: {
    handlers: {
      GET: ({ request }) => handleMcpSse(request),
      POST: ({ request }) => handleMcpSse(request),
    },
  },
});
