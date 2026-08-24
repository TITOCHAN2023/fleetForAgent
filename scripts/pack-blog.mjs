/**
 * Compile docs/blog/*.md (+ images) into static JSON the /docs page reads.
 * Writes public/blog/ and packages/fleet-worker/public/blog/.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BLOG_SRC = join(ROOT, "docs/blog");
const OUTS = [join(ROOT, "public/blog"), join(ROOT, "packages/fleet-worker/public/blog")];

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export function parseFrontmatter(raw) {
  const m = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: String(raw) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: String(raw).slice(m[0].length) };
}

export function slugFromName(name) {
  return basename(name)
    .replace(/\.(en|zh)\.md$/i, "")
    .replace(/\.md$/i, "");
}

export function langFromName(name) {
  const m = basename(name).match(/\.(en|zh)\.md$/i);
  return m ? m[1].toLowerCase() : "";
}

export function pickLocale(variants, locale) {
  if (!variants || typeof variants !== "object") return null;
  const loc = locale === "zh" ? "zh" : "en";
  return variants[loc] || variants.en || variants.zh || variants[""] || null;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mdToHtml(src) {
  const fences = [];
  let text = String(src).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const i = fences.length;
    const source = escapeHtml(code.replace(/\n$/, ""));
    if (lang.toLowerCase() === "mermaid") {
      fences.push(
        `<figure class="blog-mermaid" data-mermaid-state="pending"><pre class="blog-mermaid-source"><code>${source}</code></pre></figure>`,
      );
    } else {
      fences.push(
        `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${source}</code></pre>`,
      );
    }
    return `\n\n%%FENCE${i}%%\n\n`;
  });
  text = escapeHtml(text);
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, href) => {
    return `<img src="${href}" alt="${alt}" />`;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const ext = href.startsWith("http") || href.startsWith("/") || href.startsWith("#");
    const rel = ext ? "" : ' rel="noreferrer"';
    const tgt = href.startsWith("http") ? ' target="_blank" rel="noreferrer"' : rel;
    return `<a href="${href}"${tgt}>${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  const blocks = text.split(/\n{2,}/);
  const html = blocks
    .map((block) => {
      const t = block.trim();
      if (!t) return "";
      const fence = t.match(/^%%FENCE(\d+)%%$/);
      if (fence) return fences[Number(fence[1])];
      if (t.startsWith("### ")) return `<h3>${t.slice(4)}</h3>`;
      if (t.startsWith("## ")) return `<h2>${t.slice(3)}</h2>`;
      if (t.startsWith("# ")) return `<h1>${t.slice(2)}</h1>`;
      if (/^[-*] /.test(t) || t.includes("\n- ") || t.includes("\n* ")) {
        const items = t
          .split(/\n/)
          .filter((l) => /^[-*] /.test(l))
          .map((l) => `<li>${l.replace(/^[-*] /, "")}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }
      return `<p>${t.replace(/\n/g, "<br />")}</p>`;
    })
    .join("\n");
  return html;
}

function listMarkdown(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const lower = name.toLowerCase();
    if (name.startsWith(".") || name.startsWith("_")) continue;
    if (lower === "readme.md" || lower === "welcome.md") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) continue;
    if (!name.endsWith(".md")) continue;
    out.push(full);
  }
  return out.sort();
}

function collectImages(md, file) {
  const dir = dirname(file);
  const found = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(md))) {
    const href = m[1].trim();
    if (/^https?:\/\//i.test(href) || href.startsWith("/")) continue;
    const abs = join(dir, href);
    if (existsSync(abs) && IMAGE_EXT.has(extname(abs).toLowerCase())) found.push({ href, abs });
  }
  return found;
}

function rewriteImageSrc(md, slug) {
  return md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (all, alt, href) => {
    const h = href.trim();
    if (/^https?:\/\//i.test(h) || h.startsWith("/")) return all;
    const name = posix.basename(h.split("\\").join("/"));
    return `![${alt}](/blog/media/${slug}/${name})`;
  });
}

export function compileBlog({ srcDir = BLOG_SRC } = {}) {
  const files = listMarkdown(srcDir);
  const bySlug = new Map();
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const slug = meta.slug || slugFromName(file);
    const lang = (meta.lang || langFromName(file) || "").toLowerCase();
    const title = meta.title || slug;
    const date = meta.date || "";
    const summary = meta.summary || "";
    const images = collectImages(body, file);
    const html = mdToHtml(rewriteImageSrc(body, slug));
    const cur = bySlug.get(slug) || { slug, date: "", images: [], variants: {} };
    if (date && (!cur.date || date > cur.date)) cur.date = date;
    cur.images.push(...images);
    cur.variants[lang || ""] = { title, summary, html, lang };
    bySlug.set(slug, cur);
  }
  const compiled = [...bySlug.values()].map((row) => {
    if (row.variants[""]) {
      if (!row.variants.zh) row.variants.zh = row.variants[""];
      if (!row.variants.en) row.variants.en = row.variants[""];
    }
    const langs = ["en", "zh"].filter((l) => row.variants[l]);
    return {
      slug: row.slug,
      date: row.date,
      images: row.images,
      langs,
      variants: Object.fromEntries(langs.map((l) => [l, row.variants[l]])),
      title: Object.fromEntries(langs.map((l) => [l, row.variants[l].title])),
      summary: Object.fromEntries(langs.map((l) => [l, row.variants[l].summary])),
    };
  });
  compiled.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.slug.localeCompare(b.slug));
  const posts = compiled.map((p) => ({
    slug: p.slug,
    date: p.date,
    langs: p.langs,
    title: p.title,
    summary: p.summary,
  }));
  return { posts, compiled };
}

function emptyOut(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "posts"), { recursive: true });
  mkdirSync(join(dir, "media"), { recursive: true });
}

export function packBlog({ srcDir = BLOG_SRC, outs = OUTS } = {}) {
  const { posts, compiled } = compileBlog({ srcDir });
  for (const out of outs) {
    emptyOut(out);
    writeFileSync(join(out, "index.json"), `${JSON.stringify({ posts }, null, 2)}\n`);
    for (const post of compiled) {
      writeFileSync(
        join(out, "posts", `${post.slug}.json`),
        `${JSON.stringify({ slug: post.slug, date: post.date, langs: post.langs, variants: post.variants }, null, 2)}\n`,
      );
      for (const img of post.images) {
        const destDir = join(out, "media", post.slug);
        mkdirSync(destDir, { recursive: true });
        copyFileSync(img.abs, join(destDir, basename(img.abs)));
      }
    }
  }
  return { posts: posts.length, outs };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = packBlog();
  console.log(`packed ${r.posts} posts`);
}
