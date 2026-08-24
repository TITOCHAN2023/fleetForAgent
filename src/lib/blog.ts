export type BlogLocale = "en" | "zh";

export type BlogCopy = {
  title: string;
  summary: string;
  html?: string;
  lang?: string;
};

export type BlogListItem = {
  slug: string;
  date: string;
  langs: BlogLocale[];
  title: Partial<Record<BlogLocale, string>> | string;
  summary: Partial<Record<BlogLocale, string>> | string;
};

export type BlogPost = {
  slug: string;
  date: string;
  langs: BlogLocale[];
  variants: Partial<Record<BlogLocale | "", BlogCopy>>;
};

export function pickLocale<T>(map: Partial<Record<string, T>> | T | undefined, locale: string): T | null {
  if (map == null) return null;
  if (typeof map !== "object" || !("en" in (map as object) || "zh" in (map as object) || "" in (map as object))) {
    return map as T;
  }
  const m = map as Partial<Record<string, T>>;
  const loc = locale === "zh" ? "zh" : "en";
  return m[loc] ?? m.en ?? m.zh ?? m[""] ?? null;
}

export async function fetchBlogIndex(): Promise<BlogListItem[]> {
  const res = await fetch("/blog/index.json");
  if (!res.ok) return [];
  const data = (await res.json()) as { posts?: BlogListItem[] };
  return Array.isArray(data.posts) ? data.posts : [];
}

export async function fetchBlogPost(slug: string): Promise<BlogPost | null> {
  if (!slug || slug.includes("/") || slug.includes("..")) return null;
  const res = await fetch(`/blog/posts/${encodeURIComponent(slug)}.json`);
  if (!res.ok) return null;
  const data = (await res.json()) as BlogPost;
  if (!data || typeof data.variants !== "object") return null;
  return data;
}
