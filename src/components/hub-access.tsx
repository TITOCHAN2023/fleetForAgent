import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getHubTokenMeta, issueHubToken } from "@/lib/fleet/token-actions";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/use-i18n";

function copy(text: string) {
  return navigator.clipboard.writeText(text);
}

export function HubAccess() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [origin, setOrigin] = useState("");
  const [secret, setSecret] = useState("");

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
      void qc.invalidateQueries({ queryKey: ["hub-token"] });
      toast.success(t("hub.issued"));
    },
    onError: (e: Error) => toast.error(e.message),
  });

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
        <Button type="button" disabled={issue.isPending} onClick={() => issue.mutate()}>
          {meta?.hasToken ? t("hub.reset") : t("hub.generate")}
        </Button>
        {meta?.hasToken && <p className="self-center text-xs text-subtle">{t("hub.resetHint")}</p>}
      </div>

      <p className="mt-4 text-sm text-muted">{t("hub.toolHint")}</p>
    </section>
  );
}
