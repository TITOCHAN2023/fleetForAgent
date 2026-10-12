import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

// Worker static assets: keep output confined to /rooms; never overwrite the main site.
export default defineConfig({
  root: path("./src/room-static"),
  base: "/rooms/",
  publicDir: false,
  resolve: { alias: { "@": path("./src") } },
  plugins: [tailwindcss(), react()],
  build: {
    outDir: path("./packages/fleet-worker/public/rooms"),
    emptyOutDir: true,
    sourcemap: false,
  },
});
