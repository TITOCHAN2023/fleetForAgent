import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/use-i18n";
import type { MessageKey } from "@/lib/i18n/messages";

const HUB = "https://fleet.ginfo.cc";
const TOOL_PATH = "/absolute/path/to/packages/fleet-tool/index.mjs";

const MCP_TOOLS: { name: string; key: MessageKey }[] = [
  { name: "list_computers", key: "guide.tool.list_computers" },
  { name: "run", key: "guide.tool.run" },
  { name: "get_result", key: "guide.tool.get_result" },
  { name: "wait", key: "guide.tool.wait" },
  { name: "read_screen", key: "guide.tool.read_screen" },
  { name: "type", key: "guide.tool.type" },
  { name: "set_computer", key: "guide.tool.set_computer" },
  { name: "get_current_computer", key: "guide.tool.get_current_computer" },
];

const CLONE = `git clone https://github.com/TITOCHAN2023/fleetForAgent.git
cd fleetForAgent`;

const MCP_ENV = `FLEET_URL=${HUB}
FLEET_TOKEN=flt_...`;

const CURSOR_MCP = `{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["${TOOL_PATH}"]
    }
  }
}`;

const CURSOR_MCP_ENV = `{
  "mcpServers": {
    "fleet": {
      "command": "node",
      "args": ["${TOOL_PATH}"],
      "env": {
        "FLEET_URL": "${HUB}",
        "FLEET_TOKEN": "flt_..."
      }
    }
  }
}`;

const LINUX_ENV = `export FLEET_URL=${HUB}
export FLEET_TOKEN=flt_...
./fleet-agent`;

const MAC_BIN = `"/Applications/Fleet Agent.app/Contents/MacOS/FleetAgent"`;

const MAC_CLI = `${MAC_BIN} start --hub ${HUB} --token flt_...
${MAC_BIN} status
${MAC_BIN} permit ask
${MAC_BIN} install
# often sudo; then fleet is on PATH`;

const WIN_CLI = `FleetAgent.exe start --hub ${HUB} --token flt_...
FleetAgent.exe status
FleetAgent.exe permit ask
FleetAgent.exe install
# copies to %LOCALAPPDATA%\\Fleet\\fleet.exe — add that folder to PATH`;

const LINUX_CLI = `./fleet start --hub ${HUB} --token flt_...
./fleet status
./fleet permit ask`;

const CLI_LIST = `node packages/fleet-tool/index.mjs list`;

function copy(text: string) {
  return navigator.clipboard.writeText(text);
}

function CodeBlock({ label, text }: { label: string; text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4">
      <p className="mb-2 font-mono text-xs text-subtle">{label}</p>
      <div className="relative">
        <pre className="overflow-auto rounded-md bg-elevated p-4 pr-20 font-mono text-xs leading-relaxed text-muted">
          {text}
        </pre>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="absolute top-2 right-2"
          onClick={() => {
            void copy(text).then(() => {
              setCopied(true);
              toast.message(t("hub.copied"));
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? t("hub.copied") : t("hub.copy")}
        </Button>
      </div>
    </div>
  );
}

export function GuidePanel() {
  const { t } = useI18n();
  return (
    <div className="grid gap-4">
      <section className="rounded-xl border border-border bg-surface p-5">
        <p className="font-mono text-xs tracking-[0.22em] text-muted uppercase">{t("guide.kicker")}</p>
        <h1 className="mt-3 text-2xl font-medium tracking-tight md:text-3xl">{t("guide.title")}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.lead")}</p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-fg">{t("guide.arch")}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild variant="secondary">
            <Link to="/" search={{ tab: "agent" }}>
              {t("guide.openHub")}
            </Link>
          </Button>
          <Button asChild variant="ghost">
            <Link to="/releases">{t("nav.downloads")}</Link>
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">{t("guide.s1")}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s1Body")}</p>
        <ol className="mt-5 max-w-xl list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>{t("guide.s1a")}</li>
          <li>{t("guide.s1b")}</li>
          <li>{t("guide.s1c")}</li>
          <li>{t("guide.s1d")}</li>
        </ol>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">{t("guide.s2")}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s2Body")}</p>
        <p className="mt-3 text-sm">
          <Link to="/releases" className="underline underline-offset-4 hover:text-fg">
            {t("nav.downloads")}
          </Link>
          <span className="text-subtle"> · </span>
          <a
            className="underline underline-offset-4 hover:text-fg"
            href="https://github.com/TITOCHAN2023/fleetForAgent/releases/latest"
          >
            GitHub Releases
          </a>
        </p>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <article className="rounded-md border border-border bg-elevated p-4">
            <h3 className="text-sm font-medium">{t("guide.s2Mac")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{t("guide.s2MacBody")}</p>
            <p className="mt-2 font-mono text-xs text-subtle">FleetAgent-macos-arm64.dmg</p>
            <p className="font-mono text-xs text-subtle">FleetAgent-macos-amd64.dmg</p>
          </article>
          <article className="rounded-md border border-border bg-elevated p-4">
            <h3 className="text-sm font-medium">{t("guide.s2Win")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{t("guide.s2WinBody")}</p>
            <p className="mt-2 font-mono text-xs text-subtle">FleetAgent-windows-amd64.exe</p>
          </article>
          <article className="rounded-md border border-border bg-elevated p-4">
            <h3 className="text-sm font-medium">{t("guide.s2Linux")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">{t("guide.s2LinuxBody")}</p>
            <p className="mt-2 font-mono text-xs text-subtle">fleet-agent-linux-amd64.tar.gz</p>
          </article>
        </div>
        <CodeBlock label="Linux env" text={LINUX_ENV} />
        <h3 className="mt-6 text-sm font-medium">{t("guide.s2Cli")}</h3>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s2CliBody")}</p>
        <CodeBlock label="macOS" text={MAC_CLI} />
        <CodeBlock label="Windows" text={WIN_CLI} />
        <CodeBlock label="Linux" text={LINUX_CLI} />
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s2Ui")}</p>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">{t("guide.s3")}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s3Body")}</p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s3Clone")}</p>
        <CodeBlock label="git clone" text={CLONE} />
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s3Env")}</p>
        <CodeBlock label="~/.fleet/mcp.env" text={MCP_ENV} />
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s3Cursor")}</p>
        <CodeBlock label="~/.cursor/mcp.json" text={CURSOR_MCP} />
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s3EnvAlt")}</p>
        <CodeBlock label="mcp.json env" text={CURSOR_MCP_ENV} />
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s3Claude")}</p>
        <CodeBlock label="claude_desktop_config.json" text={CURSOR_MCP} />
        <CodeBlock label="node packages/fleet-tool/index.mjs list" text={CLI_LIST} />
        <h3 className="mt-6 text-sm font-medium">{t("guide.s3Tools")}</h3>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{t("guide.s3ToolsBody")}</p>
        <ol className="mt-5 space-y-3">
          {MCP_TOOLS.map((tool) => (
            <li key={tool.name} className="rounded-md border border-border bg-elevated px-3 py-3">
              <p className="font-mono text-sm text-accent">{tool.name}</p>
              <p className="mt-1 text-sm text-muted">{t(tool.key)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">{t("guide.check")}</h2>
        <ol className="mt-4 max-w-xl list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>{t("guide.check1")}</li>
          <li>{t("guide.check2")}</li>
          <li>{t("guide.check3")}</li>
        </ol>
      </section>
    </div>
  );
}
