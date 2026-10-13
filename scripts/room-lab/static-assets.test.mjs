import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const publicDir = new URL("../../packages/fleet-worker/public/", import.meta.url);

test("Worker ships a separate Room entry with every referenced local asset", () => {
  const home = readFileSync(new URL("index.html", publicDir), "utf8");
  assert.match(home, /href="\/rooms\/"/);
  assert.match(home, /href="\/hub-ui\.css"/);
  const page = readFileSync(new URL("rooms/index.html", publicDir), "utf8");
  assert.match(page, /<title>Fleet Room<\/title>/);
  assert.match(page, /href="\/hub-ui\.css"/);
  for (const file of [
    "hub-ui.css",
    "fonts/Inter-400.ttf",
    "fonts/Inter-500.ttf",
    "fonts/Inter-600.ttf",
  ])
    assert(existsSync(fileURLToPath(new URL(file, publicDir))), file);
  assert(!page.includes("main.tsx"), "Serve compiled JavaScript, not a Vite development entry");
  const assets = [...page.matchAll(/(?:src|href)="(\/rooms\/assets\/[^"]+)"/g)].map((m) => m[1]);
  assert(assets.some((path) => path.endsWith(".js")));
  assert(assets.some((path) => path.endsWith(".css")));
  for (const path of assets)
    assert(existsSync(fileURLToPath(new URL(path.slice(1), publicDir))), path);
  const css = assets
    .filter((path) => path.endsWith(".css"))
    .map((path) => readFileSync(new URL(path.slice(1), publicDir), "utf8"))
    .join("\n");
  assert.match(css, /\.fleet-room-shell/);
  const sharedComponent = readFileSync(
    new URL("../../src/components/room-console.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    sharedComponent,
    /import "\.\/room-console\.css"/,
    "Node and Worker must both load the Room layout with the component",
  );
});

test("Room static path is excluded from Worker-first API dispatch", () => {
  const config = readFileSync(
    new URL("../../packages/fleet-worker/wrangler.toml", import.meta.url),
    "utf8",
  );
  const first = config.match(/^run_worker_first\s*=\s*(\[[^\n]+\])/m);
  assert(first, "Worker routing must explicitly reserve API paths");
  const routes = JSON.parse(first[1]);
  for (const path of ["/rooms/", "/rooms/index.html", "/rooms/assets/app.js"]) {
    assert(
      !routes.some(
        (route) => route === path || (route.endsWith("*") && path.startsWith(route.slice(0, -1))),
      ),
    );
  }
  assert.match(config, /directory\s*=\s*"\.\/public"/);
});
