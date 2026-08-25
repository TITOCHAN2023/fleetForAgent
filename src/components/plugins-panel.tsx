import { useState } from "react";
import { Check, Copy, Github, Network, PackageCheck, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/use-i18n";

const STEPS = {
  install: {
    zh: "使用 Fleet Tool：先 list_computers 并选择目标机器，然后 install_plugin，plugin_id 填 fleet.acp。拿到 corr 后持续调用 get_plugin_task，直到完成。不要改用 run 手工下载安装。",
    en: "Use Fleet Tool: list_computers and select the target, then call install_plugin with plugin_id fleet.acp. Poll get_plugin_task with the returned corr until done. Do not replace this with a manual download through run.",
  },
  configure: {
    zh: "在当前 Fleet 机器上调用 configure_acp：profile 用 default，command 填这台机器上已安装的 ACP Agent 启动命令，args 按需填写。然后用 get_plugin_task 等待完成。",
    en: "On the current Fleet machine call configure_acp: use profile default, set command to the ACP agent executable already installed there, and pass args if needed. Poll get_plugin_task until done.",
  },
  delegate: {
    zh: "调用 delegate_to_acp，把 cwd 设为远端机器上的绝对项目路径，prompt 设为要交给远端 Agent 的任务。默认拒绝嵌套权限；确实需要时才设 permission_mode=allow_once。用 get_plugin_task 读取结果。",
    en: "Call delegate_to_acp with cwd set to an absolute project path on the remote machine and prompt set to the delegated task. Nested permissions reject by default; use permission_mode=allow_once only when required. Read the result with get_plugin_task.",
  },
} as const;

function CopyPrompt({ title, text, index }: { title: string; text: string; index: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <article className="flex min-h-64 flex-col rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs text-subtle">{index}</p>
          <h3 className="mt-2 text-sm font-medium">{title}</h3>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="mt-5 flex-1 whitespace-pre-wrap break-words rounded-lg border border-border bg-bg p-4 font-mono text-xs leading-6 text-muted">
        {text}
      </pre>
    </article>
  );
}

export function PluginsPanel() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="grid gap-4">
      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="grid gap-8 p-6 md:grid-cols-[minmax(0,1fr)_280px] md:p-8">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-subtle">Fleet plugins</p>
            <h1 className="mt-3 text-2xl font-medium tracking-tight md:text-3xl">
              {zh ? "把能力装到远端 Agent，不把脚本塞进 Hub。" : "Install capability on the remote Agent—not scripts in the Hub."}
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-muted">
              {zh
                ? "把下面的指令复制给正在使用 Fleet Tool 的 AI。Tool 只提交官方插件 id；Hub 注入固定清单，设备核对平台和 SHA-256，并在本机确认后安装。"
                : "Copy a prompt below to the AI using Fleet Tool. The Tool submits only an official id; the Hub injects the fixed manifest, and the device verifies platform and SHA-256 before local approval."}
            </p>
          </div>
          <div className="grid content-start gap-3 rounded-xl border border-border bg-bg p-4 text-sm">
            <div className="flex items-center gap-3"><ShieldCheck className="size-4 text-fg" /><span>{zh ? "设备端确认" : "Device-side approval"}</span></div>
            <div className="flex items-center gap-3"><PackageCheck className="size-4 text-fg" /><span>{zh ? "Release + SHA-256" : "Release + SHA-256"}</span></div>
            <div className="flex items-center gap-3"><Network className="size-4 text-fg" /><span>{zh ? "异步任务票据" : "Async task tickets"}</span></div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2">
              <span className="rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs">fleet.acp</span>
              <span className="text-xs text-subtle">v0.1.0 · MIT · Fleet Official</span>
            </div>
            <h2 className="mt-4 text-lg font-medium">Fleet ACP</h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {zh
                ? "通用 Agent Client Protocol v1 桥。远端机器自己安装 ACP 兼容 Agent；Fleet 插件负责 initialize、创建会话、下发任务并收集流式结果。它不捆绑模型、账号或 API Key。"
                : "A generic Agent Client Protocol v1 bridge. The remote machine owns its ACP-compatible agent; the Fleet plugin initializes it, creates a session, delegates a task, and collects streamed output. No model, account, or API key is bundled."}
            </p>
          </div>
          <Button asChild variant="secondary">
            <a href="https://github.com/TITOCHAN2023/fleet-acp-plugin" target="_blank" rel="noreferrer">
              <Github className="size-4" /> GitHub
            </a>
          </Button>
        </div>
        <div className="mt-5 flex flex-wrap gap-2 text-xs text-subtle">
          {["macOS amd64 / arm64", "Linux amd64 / arm64", "Windows amd64 / arm64"].map((item) => (
            <span key={item} className="rounded-full border border-border px-3 py-1.5">{item}</span>
          ))}
        </div>
      </section>

      <div className="grid items-stretch gap-4 lg:grid-cols-3">
        <CopyPrompt index="01" title={zh ? "安装官方 ACP 插件" : "Install the official ACP plugin"} text={STEPS.install[locale]} />
        <CopyPrompt index="02" title={zh ? "绑定本机 ACP Agent" : "Bind a local ACP agent"} text={STEPS.configure[locale]} />
        <CopyPrompt index="03" title={zh ? "把任务交给远端 Agent" : "Delegate to the remote agent"} text={STEPS.delegate[locale]} />
      </div>
    </div>
  );
}
