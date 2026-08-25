import { createFileRoute } from "@tanstack/react-router";
import { handleMcpHttp } from "@/lib/fleet/mcp-http.server";

export const Route = createFileRoute("/mcp/")({
  server: {
    handlers: {
      GET: ({ request }) => handleMcpHttp(request),
      POST: ({ request }) => handleMcpHttp(request),
      DELETE: ({ request }) => handleMcpHttp(request),
      OPTIONS: ({ request }) => handleMcpHttp(request),
    },
  },
});
