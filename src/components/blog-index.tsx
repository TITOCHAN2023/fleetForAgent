import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchBlogIndex, pickLocale } from "@/lib/blog";
import { useI18n } from "@/lib/i18n/use-i18n";

export function BlogIndex() {
  const { t, locale } = useI18n();
  const q = useQuery({ queryKey: ["blog-index"], queryFn: fetchBlogIndex });
  const posts = q.data ?? [];
  return (
    <div className="mx-auto max-w-[42rem]">
      <p className="text-sm font-medium tracking-[0.18em] text-muted uppercase">{t("docs.kicker")}</p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">{t("docs.title")}</h1>
      <p
        lang={locale === "zh" ? "zh-CN" : "en"}
        className="mt-4 font-hand text-lg leading-relaxed text-muted"
      >
        {t("docs.lead")}
      </p>
      {q.isPending ? (
        <p className="mt-16 text-sm text-subtle">{t("docs.loading")}</p>
      ) : posts.length === 0 ? (
        <p className="mt-16 text-sm text-muted">{t("docs.empty")}</p>
      ) : (
        <ul className="mt-14">
          {posts.map((p) => {
            const title = pickLocale(p.title, locale) || p.slug;
            const summary = pickLocale(p.summary, locale) || "";
            return (
            <li key={p.slug} className="border-t border-border">
              <Link
                to="/docs/$slug"
                params={{ slug: p.slug }}
                className="group flex flex-col gap-2 py-7 sm:flex-row sm:items-baseline sm:gap-10"
              >
                <time
                  lang={locale === "zh" ? "zh-CN" : "en"}
                  className="w-28 shrink-0 font-hand text-sm text-subtle"
                >
                  {p.date || "—"}
                </time>
                <span className="min-w-0">
                  <span className="text-lg font-medium tracking-tight text-fg group-hover:underline group-hover:underline-offset-4">
                    {title}
                  </span>
                  {summary ? (
                    <span
                      lang={locale === "zh" ? "zh-CN" : "en"}
                      className="mt-1 block font-hand text-base leading-relaxed text-muted"
                    >
                      {summary}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
