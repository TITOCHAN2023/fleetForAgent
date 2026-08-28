import { Apple, Monitor, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/use-i18n";
import type { MessageKey } from "@/lib/i18n/messages";

const GH = "https://github.com/TITOCHAN2023/fleetForAgent/releases/latest/download";

const BUILDS: {
  id: string;
  os: MessageKey;
  file: string;
  hint: MessageKey;
  icon: typeof Monitor;
}[] = [
  { id: "win", os: "rel.win", file: "FleetAgent-windows-amd64.exe", hint: "rel.winHint", icon: Monitor },
  { id: "win-arm", os: "rel.winArm", file: "FleetAgent-windows-arm64.exe", hint: "rel.winArmHint", icon: Monitor },
  { id: "mac-arm", os: "rel.macArm", file: "FleetAgent-macos-arm64.dmg", hint: "rel.macArmHint", icon: Apple },
  { id: "mac-arm-zip", os: "rel.macArmZip", file: "FleetAgent-macos-arm64.zip", hint: "rel.macArmZipHint", icon: Apple },
  { id: "mac-intel", os: "rel.macIntel", file: "FleetAgent-macos-amd64.dmg", hint: "rel.macIntelHint", icon: Apple },
  { id: "mac-intel-zip", os: "rel.macIntelZip", file: "FleetAgent-macos-amd64.zip", hint: "rel.macIntelZipHint", icon: Apple },
  { id: "linux", os: "rel.linux", file: "fleet-agent-linux-amd64.tar.gz", hint: "rel.linuxHint", icon: Server },
  { id: "linux-arm", os: "rel.linuxArm", file: "fleet-agent-linux-arm64.tar.gz", hint: "rel.linuxArmHint", icon: Server },
  { id: "sum", os: "rel.checksums", file: "checksums-0.5.1.txt", hint: "rel.checksumsHint", icon: Server },
];

export function ReleasesPanel() {
  const { t, locale } = useI18n();
  return (
    <div className="grid gap-4">
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-medium">{t("rel.title")}</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">{t("rel.body")}</p>
        <p className="mt-3 text-sm">
          <a className="underline underline-offset-4" href="https://github.com/TITOCHAN2023/fleetForAgent/releases/latest">
            GitHub Releases
          </a>
          <span className="text-subtle"> · </span>
          <a className="underline underline-offset-4" href={locale === "zh" ? "https://github.com/TITOCHAN2023/fleetForAgent/blob/main/docs/zh/deploy.md" : "https://github.com/TITOCHAN2023/fleetForAgent/blob/main/docs/en/deploy.md"}>
            {t("rel.deploy")}
          </a>
        </p>
        <ol className="mt-5 max-w-xl list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>{t("rel.s1")}</li>
          <li>{t("rel.s2")}</li>
          <li>{t("rel.s3")}</li>
          <li>{t("rel.s4")}</li>
          <li>{t("rel.s5")}</li>
        </ol>
      </section>
      <div className="grid gap-3 md:grid-cols-2">
        {BUILDS.map((b) => {
          const Icon = b.icon;
          return (
            <article key={b.id} className="rounded-xl border border-border bg-surface p-5">
              <div className="flex items-center gap-2">
                <Icon className="size-4" strokeWidth={1.75} />
                <h3 className="text-sm font-medium">{t(b.os)}</h3>
              </div>
              <p className="mt-3 text-sm text-muted">{t(b.hint)}</p>
              <p className="mt-2 font-mono text-xs text-subtle">{b.file}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button asChild variant="secondary">
                  <a href={`${GH}/${b.file}`}>
                    {t("rel.download")}
                  </a>
                </Button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
