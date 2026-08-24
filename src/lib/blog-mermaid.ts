import type { ThemeResolved } from "@/lib/theme";

type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<MermaidApi> | null = null;
let diagramId = 0;

function getThemeVariables(theme: ThemeResolved) {
  const dark = theme === "dark";
  return {
    darkMode: dark,
    background: dark ? "#2d2d2d" : "#fbfbfc",
    primaryColor: dark ? "#2f2f2f" : "#ffffff",
    primaryTextColor: dark ? "#ececec" : "#0d0d0d",
    primaryBorderColor: dark ? "#454545" : "#e5e5e5",
    secondaryColor: dark ? "#3a3a3a" : "#ececec",
    secondaryTextColor: dark ? "#ececec" : "#0d0d0d",
    secondaryBorderColor: dark ? "#505050" : "#dedede",
    tertiaryColor: dark ? "#292929" : "#f7f7f8",
    tertiaryTextColor: dark ? "#b4b4b4" : "#6e6e80",
    tertiaryBorderColor: dark ? "#454545" : "#e5e5e5",
    lineColor: dark ? "#8f8f8f" : "#8e8ea0",
    arrowheadColor: dark ? "#b4b4b4" : "#6e6e80",
    textColor: dark ? "#ececec" : "#0d0d0d",
    nodeBkg: dark ? "#2f2f2f" : "#ffffff",
    mainBkg: dark ? "#2f2f2f" : "#ffffff",
    nodeBorder: dark ? "#454545" : "#e5e5e5",
    nodeTextColor: dark ? "#ececec" : "#0d0d0d",
    clusterBkg: dark ? "#292929" : "#f7f7f8",
    clusterBorder: dark ? "#454545" : "#e5e5e5",
    defaultLinkColor: dark ? "#8f8f8f" : "#8e8ea0",
    edgeLabelBackground: dark ? "#2d2d2d" : "#fbfbfc",
    titleColor: dark ? "#ececec" : "#0d0d0d",
    fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
    fontSize: "14px",
    radius: 12,
  };
}

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
    theme: "base",
    darkMode: theme === "dark",
    fontFamily: '"Inter", ui-sans-serif, system-ui, sans-serif',
    themeVariables: getThemeVariables(theme),
    htmlLabels: true,
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
