import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { fetchBlogPost, pickLocale } from "@/lib/blog";
import { useI18n } from "@/lib/i18n/use-i18n";
import { getThemeResolved, subscribeTheme, type ThemeResolved } from "@/lib/theme";

export function BlogArticle({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const theme = useSyncExternalStore(
    subscribeTheme,
    getThemeResolved,
    () => "light" as ThemeResolved,
  );
  const proseRef = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ["blog-post", slug], queryFn: () => fetchBlogPost(slug) });
  const post = q.data;
  const copy = post ? pickLocale(post.variants, locale) : null;
  useEffect(() => {
    if (import.meta.env.SSR) return;

    const root = proseRef.current;
    if (!root?.querySelector(".blog-mermaid")) return;
    let current = true;
    void import("@/lib/blog-mermaid").then(({ renderMermaidBlocks }) =>
      renderMermaidBlocks(root, theme, () => current),
    );
    return () => {
      current = false;
    };
  }, [copy?.html, theme]);
  if (q.isPending) {
    return <p className="mx-auto max-w-[42rem] text-sm text-subtle">{t("docs.loading")}</p>;
  }
  if (!post) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <Link to="/docs" className="text-sm text-muted underline underline-offset-4 hover:text-fg">
          {t("docs.backToList")}
        </Link>
        <p className="mt-8 text-muted">{t("docs.missing")}</p>
      </div>
    );
  }
  if (!copy?.html) {
    return (
      <div className="mx-auto max-w-[42rem]">
        <Link to="/docs" className="text-sm text-muted underline underline-offset-4 hover:text-fg">
          {t("docs.backToList")}
        </Link>
        <p className="mt-8 text-muted">{t("docs.missing")}</p>
      </div>
    );
  }
  return (
    <article className="mx-auto max-w-[42rem]">
      <Link to="/docs" className="text-sm text-muted underline underline-offset-4 hover:text-fg">
        {t("docs.backToList")}
      </Link>
      <time className="mt-10 block font-mono text-xs tracking-[0.16em] text-subtle uppercase">{post.date}</time>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">{copy.title}</h1>
      {copy.summary ? <p className="mt-5 text-lg leading-relaxed text-muted">{copy.summary}</p> : null}
      <div ref={proseRef} className="blog-prose mt-10" dangerouslySetInnerHTML={{ __html: copy.html }} />
    </article>
  );
}
