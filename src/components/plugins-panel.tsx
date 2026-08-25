import { useState } from "react";
import { Check, Copy, ExternalLink, FileText, PackageCheck, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { officialPlugins, pluginRegistrySource, type OfficialPlugin } from "@/lib/fleet/plugin-registry";
import { useI18n } from "@/lib/i18n/use-i18n";

function installPrompt(plugin: OfficialPlugin, zh: boolean) {
  return zh
    ? `使用 Fleet Tool 安装官方插件：先调用 list_computers 并选中目标机器，再调用 install_plugin，plugin_id 填 ${plugin.id}。拿到 corr 后持续调用 get_plugin_task，直到完成。不要用 run 手工下载安装。`
    : `Use Fleet Tool to install the official plugin: call list_computers and select the target, then call install_plugin with plugin_id ${plugin.id}. Poll get_plugin_task with the returned corr until it finishes. Do not download it manually through run.`;
}

function platformLabels(plugin: OfficialPlugin) {
  const grouped = new Map<string, Set<string>>();
  for (const artifact of plugin.artifacts) {
    const label = artifact.os === "darwin" ? "macOS" : artifact.os === "windows" ? "Windows" : "Linux";
    const arches = grouped.get(label) ?? new Set<string>();
    arches.add(artifact.arch);
    grouped.set(label, arches);
  }
  return [...grouped].map(([os, arches]) => `${os} ${[...arches].join(" / ")}`);
}

function PluginCard({ plugin, zh }: { plugin: OfficialPlugin; zh: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copyInstall() {
    await navigator.clipboard.writeText(installPrompt(plugin, zh));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return (
    <article className="flex min-h-80 flex-col rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-subtle">{plugin.id}</p>
          <h2 className="mt-2 text-lg font-medium">{plugin.name}</h2>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-bg px-2.5 py-1 font-mono text-[11px] text-subtle">
          v{plugin.version}
        </span>
      </div>

      <p className="mt-4 flex-1 text-sm leading-6 text-muted">
        {plugin.description[zh ? "zh" : "en"]}
      </p>

      <div className="mt-5 flex flex-wrap gap-1.5">
        {plugin.categories.map((category) => (
          <span key={category} className="rounded-full border border-border px-2.5 py-1 text-xs text-subtle">
            {category}
          </span>
        ))}
      </div>

      <div className="mt-4 min-h-12 border-t border-border pt-4 text-xs leading-5 text-subtle">
        {plugin.installable
          ? platformLabels(plugin).join(" · ")
          : zh ? "已收录，暂未开放 Fleet 远程安装" : "Curated, but not yet available for remote installation"}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {plugin.installable ? (
          <Button type="button" onClick={copyInstall}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? (zh ? "已复制" : "Copied") : (zh ? "复制安装指令" : "Copy install prompt")}
          </Button>
        ) : (
          <Button type="button" disabled>{zh ? "仅收录" : "Catalog only"}</Button>
        )}
        <Button asChild variant="secondary">
          <a href={plugin.repository} target="_blank" rel="noreferrer">
            GitHub <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </div>

      <p className="mt-3 text-center text-[11px] text-subtle">
        {plugin.license} · {plugin.publisher}
      </p>
    </article>
  );
}

export function PluginsPanel() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="grid gap-5">
      <section className="rounded-xl border border-border bg-surface p-6 md:p-8">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-subtle">Official plugin registry</p>
            <h1 className="mt-3 text-2xl font-medium tracking-tight md:text-3xl">
              {zh ? "官方收录的开源插件" : "Officially curated open-source plugins"}
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted">
              {zh
                ? "每个插件来自注册表仓库中的一个 Markdown 文件。网站、Fleet Tool 和 Hub 使用同一份固定快照。"
                : "Each plugin comes from one Markdown file in the registry repository. The website, Fleet Tool, and Hub use the same pinned snapshot."}
            </p>
          </div>
          <Button asChild variant="secondary" className="shrink-0">
            <a href={pluginRegistrySource.repository} target="_blank" rel="noreferrer">
              <FileText className="size-4" /> {zh ? "查看注册表" : "View registry"}
            </a>
          </Button>
        </div>
        <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-5 text-xs text-subtle">
          <span className="flex items-center gap-2"><ShieldCheck className="size-4" />{zh ? "设备端确认" : "Device approval"}</span>
          <span className="flex items-center gap-2"><PackageCheck className="size-4" />Release + SHA-256</span>
          <span className="font-mono">{pluginRegistrySource.commit.slice(0, 12)}</span>
        </div>
      </section>

      <section className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
        {officialPlugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} zh={zh} />)}
      </section>
    </div>
  );
}
