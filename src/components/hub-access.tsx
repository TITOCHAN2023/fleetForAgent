import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getHubTokenMeta, issueHubToken } from "@/lib/fleet/token-actions";
import { inspectTokenV1 } from "@/lib/fleet/token";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/use-i18n";

function copy(text: string) {
  return navigator.clipboard.writeText(text);
}

type Prompt = "confirm" | "busy" | "shown" | null;

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const { t } = useI18n();
  return (
    <div>
      <p className="mb-2 text-xs text-subtle">{label}</p>
      <div className="relative">
        <pre className="max-h-72 overflow-auto rounded-md border border-border bg-elevated p-4 pr-20 font-mono text-xs leading-relaxed text-muted">
          {text}
        </pre>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="absolute top-2 right-2"
          onClick={() => {
            void copy(text).then(() => toast.message(t("hub.copied")));
          }}
        >
          {t("hub.copy")}
        </Button>
      </div>
    </div>
  );
}

function ReadySetup({ origin, token }: { origin: string; token: string }) {
  const { t } = useI18n();
  const base = origin.replace(/\/+$/, "");
  const posixInstall = `curl -fsSL ${shellQuote(`${base}/install.sh`)} | sh -s -- --hub ${shellQuote(base)} --token ${shellQuote(token)} --permit ask`;
  const windowsInstall = `& ([scriptblock]::Create((irm ${powershellQuote(`${base}/install.ps1`)}))) -Hub ${powershellQuote(base)} -Token ${powershellQuote(token)} -Permit ask`;
  const mcpSseConfig = JSON.stringify(
    {
      mcpServers: {
        fleet: {
          type: "sse",
          url: `${base}/mcp/sse`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="grid gap-6">
      <div className="grid gap-3">
        <div>
          <h3 className="text-sm font-medium">{t("hub.quickTitle")}</h3>
          <p className="mt-1 max-w-3xl text-sm text-muted">{t("hub.quickBody")}</p>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <CopyBlock label={t("hub.posixInstall")} text={posixInstall} />
          <CopyBlock label={t("hub.windowsInstall")} text={windowsInstall} />
        </div>
        <p className="text-xs text-warn">{t("hub.shellHistory")}</p>
        <p className="text-sm text-muted">
          {t("hub.desktopHint")}{" "}
          <a href="/releases" className="underline underline-offset-4 hover:text-fg">
            {t("hub.desktopLink")}
          </a>
        </p>
      </div>

      <div className="grid gap-3 border-t border-border pt-6">
        <div>
          <h3 className="text-sm font-medium">{t("hub.mcpSseTitle")}</h3>
          <p className="mt-1 max-w-3xl text-sm text-muted">{t("hub.mcpSseBody")}</p>
        </div>
        <CopyBlock label={t("hub.mcpSseConfig")} text={mcpSseConfig} />
      </div>
    </div>
  );
}

function Anatomy({ token }: { token: string }) {
  const { t } = useI18n();
  const view = inspectTokenV1(token);
  if (!view) return null;
  const issued = view.iat ? new Date(view.iat).toISOString() : "";
  const rows = [
    [t("hub.anatomyPrefix"), view.prefix],
    [t("hub.anatomyAud"), view.aud],
    [t("hub.anatomyKid"), view.kid],
    [t("hub.anatomyIat"), issued],
    [t("hub.anatomySig"), `${view.sig}…`],
  ];
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">{t("hub.anatomy")}</p>
      <dl className="grid gap-1 font-mono text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-subtle">{k}</dt>
            <dd className="min-w-0 truncate text-right">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted">{t("hub.anatomyRsa")}</p>
    </div>
  );
}

export function HubAccess() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [origin, setOrigin] = useState("");
  const [secret, setSecret] = useState("");
  const [prompt, setPrompt] = useState<Prompt>(null);

  useEffect(() => setOrigin(window.location.origin), []);

  const metaQ = useQuery({
    queryKey: ["hub-token"],
    queryFn: () => getHubTokenMeta(),
  });
  const meta = metaQ.data;

  const issue = useMutation({
    mutationFn: () => issueHubToken({ data: true }),
    onSuccess: (out) => {
      setSecret(out.token);
      setPrompt("shown");
      void qc.invalidateQueries({ queryKey: ["hub-token"] });
      toast.success(t("hub.issued"));
    },
    onError: (e: Error) => {
      setPrompt(null);
      toast.error(e.message);
    },
  });

  function startMint() {
    if (metaQ.isLoading) return;
    const existing = Boolean(meta?.hasToken) || metaQ.isError;
    if (existing && prompt !== "confirm") {
      setPrompt("confirm");
      return;
    }
    setPrompt("busy");
    issue.mutate();
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <h2 className="text-base font-medium">{t("hub.title")}</h2>
      <p className="mt-1 text-sm text-muted">{t("hub.body")}</p>

      <div className="mt-4 grid gap-3">
        <label className="grid gap-1">
          <span className="text-xs text-subtle">{t("hub.url")}</span>
          <div className="flex gap-2">
            <code className="flex-1 truncate rounded-md border border-border bg-elevated px-3 py-2 font-mono text-sm">
              {origin || "…"}
            </code>
            <Button
              type="button"
              variant="secondary"
              disabled={!origin}
              onClick={() => {
                void copy(origin).then(() => toast.message(t("hub.copied")));
              }}
            >
              {t("hub.copy")}
            </Button>
          </div>
        </label>

        <label className="grid gap-1">
          <span className="text-xs text-subtle">{t("hub.token")}</span>
          {secret ? (
            <div className="grid gap-2">
              <p className="text-sm text-warn">{t("hub.secretOnce")}</p>
              <div className="flex gap-2">
                <code className="flex-1 break-all rounded-md border border-border bg-elevated px-3 py-2 font-mono text-xs">
                  {secret}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    void copy(secret).then(() => toast.message(t("hub.copied")));
                  }}
                >
                  {t("hub.copy")}
                </Button>
              </div>
            </div>
          ) : (
            <p className="font-mono text-sm text-muted">
              {meta?.hasToken ? `${meta.prefix}…` : t("hub.none")}
            </p>
          )}
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={issue.isPending || metaQ.isLoading}
          onClick={() => startMint()}
        >
          {meta?.hasToken ? t("hub.reset") : t("hub.generate")}
        </Button>
        {meta?.hasToken && <p className="self-center text-xs text-subtle">{t("hub.resetHint")}</p>}
      </div>

      <p className="mt-4 text-sm text-muted">{t("hub.toolHint")}</p>

      <div className="mt-6 border-t border-border pt-6">
        {secret && origin ? (
          <ReadySetup origin={origin} token={secret} />
        ) : (
          <div>
            <h3 className="text-sm font-medium">{t("hub.quickTitle")}</h3>
            <p className="mt-1 text-sm text-muted">{t("hub.setupNeedsToken")}</p>
          </div>
        )}
      </div>

      {prompt ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-5"
          role="dialog"
          aria-modal="true"
        >
          <div
            className={`max-h-[90vh] w-full overflow-auto rounded-2xl border border-border bg-surface p-6 shadow-lg ${prompt === "shown" ? "max-w-5xl" : "max-w-lg"}`}
          >
            {prompt === "confirm" ? (
              <div className="grid gap-4">
                <h3 className="text-base font-medium">{t("hub.resetConfirm")}</h3>
                <p className="text-sm text-muted">{t("hub.resetConfirmBody")}</p>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => setPrompt(null)}>
                    {t("hub.promptCancel")}
                  </Button>
                  <Button type="button" variant="danger" onClick={() => startMint()}>
                    {t("hub.promptContinue")}
                  </Button>
                </div>
              </div>
            ) : null}
            {prompt === "busy" ? <p className="text-sm text-muted">{t("hub.minting")}</p> : null}
            {prompt === "shown" && secret ? (
              <div className="grid gap-4">
                <p className="text-sm text-warn">{t("hub.secretOnce")}</p>
                <code className="block max-h-40 overflow-auto break-all rounded-md border border-border bg-elevated px-3 py-2 font-mono text-xs">
                  {secret}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    void copy(secret).then(() => toast.message(t("hub.copied")));
                  }}
                >
                  {t("hub.copy")}
                </Button>
                <Anatomy token={secret} />
                {origin ? <ReadySetup origin={origin} token={secret} /> : null}
                <div className="flex justify-end">
                  <Button type="button" onClick={() => setPrompt(null)}>
                    {t("hub.promptClose")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
