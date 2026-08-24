import type { ThemeResolved } from "@/lib/theme";

type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<MermaidApi> | null = null;
let diagramId = 0;

function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((mod) => mod.default);
  return mermaidPromise;
}

export async function renderMermaidBlocks(
  root: HTMLElement,
  theme: ThemeResolved,
  isCurrent: () => boolean,
) {
  const blocks = [...root.querySelectorAll<HTMLElement>(".blog-mermaid")];
  if (blocks.length === 0) return;

  const mermaid = await loadMermaid();
  if (!isCurrent()) return;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: theme === "dark" ? "dark" : "neutral",
    darkMode: theme === "dark",
    fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
    htmlLabels: false,
    maxTextSize: 20_000,
    maxEdges: 200,
    flowchart: {
      curve: "linear",
      nodeSpacing: 36,
      rankSpacing: 42,
      useMaxWidth: true,
    },
  });

  for (const block of blocks) {
    if (!isCurrent() || !block.isConnected) return;

    const source =
      block.dataset.mermaidSource ??
      block.querySelector<HTMLElement>(".blog-mermaid-source code")?.textContent?.trim() ??
      "";
    if (!source) {
      block.dataset.mermaidState = "error";
      continue;
    }

    block.dataset.mermaidSource = source;
    block.dataset.mermaidState = "rendering";
    try {
      const id = `fleet-mermaid-${Date.now()}-${++diagramId}`;
      const { svg, bindFunctions } = await mermaid.render(id, source, block);
      if (!isCurrent() || !block.isConnected) return;
      block.innerHTML = svg;
      block.dataset.mermaidState = "rendered";
      bindFunctions?.(block);
    } catch {
      if (isCurrent()) block.dataset.mermaidState = "error";
    }
  }
}
