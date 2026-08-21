import { createFileRoute } from "@tanstack/react-router";
import { handleHubHttp } from "@/lib/fleet/v1.server";

export const Route = createFileRoute("/v1/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleHubHttp(request),
      POST: ({ request }) => handleHubHttp(request),
      OPTIONS: ({ request }) => handleHubHttp(request),
    },
  },
});
