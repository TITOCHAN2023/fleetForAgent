import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileBlog, langFromName, mdToHtml, parseFrontmatter, pickLocale, slugFromName } from "./pack-blog.mjs";

test("frontmatter and slug", () => {
  const { meta, body } = parseFrontmatter("---\ntitle: Hello\ndate: 2026-08-24\n---\n\nHi.\n");
  assert.equal(meta.title, "Hello");
  assert.equal(meta.date, "2026-08-24");
  assert.equal(body.trim(), "Hi.");
  assert.equal(slugFromName("idle-sleep.zh.md"), "idle-sleep");
  assert.equal(slugFromName("welcome.md"), "welcome");
  assert.equal(langFromName("idle-sleep.zh.md"), "zh");
  assert.equal(langFromName("idle-sleep.en.md"), "en");
  assert.equal(langFromName("welcome.md"), "");
});

test("mdToHtml headings, images, code", () => {
  const html = mdToHtml("## Title\n\nSee ![shot](/blog/media/x.png).\n\n```bash\necho hi\n```\n");
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<img src="\/blog\/media\/x.png" alt="shot" \/>/);
  assert.match(html, /<pre><code class="language-bash">echo hi<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script/);
});

test("mdToHtml emits an escaped lazy Mermaid block", () => {
  const html = mdToHtml(
    ['```mermaid', "flowchart TD", '  A["<script>alert(1)</script>"] --> B', "```", ""].join("\n"),
  );
  assert.match(html, /<figure class="blog-mermaid" data-mermaid-state="pending">/);
  assert.match(html, /<pre class="blog-mermaid-source"><code>flowchart TD/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /language-mermaid/);
});

test("compileBlog skips README and copies relative images", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-blog-"));
  try {
    writeFileSync(join(dir, "README.md"), "# skip\n");
    writeFileSync(
      join(dir, "hello.md"),
      "---\ntitle: Hello\ndate: 2026-08-24\nsummary: A stub.\n---\n\n![pic](pic.png)\n",
    );
    writeFileSync(join(dir, "pic.png"), "png");
    const { posts, compiled } = compileBlog({ srcDir: dir });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].slug, "hello");
    assert.deepEqual(posts[0].langs.sort(), ["en", "zh"]);
    assert.equal(compiled[0].images.length, 1);
    assert.match(compiled[0].variants.en.html, /src="\/blog\/media\/hello\/pic.png"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compileBlog merges .zh.md/.en.md and skips welcome.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-blog-i18n-"));
  try {
    writeFileSync(join(dir, "welcome.md"), "---\ntitle: Skip\n---\nnope\n");
    writeFileSync(join(dir, "README.md"), "skip\n");
    writeFileSync(join(dir, "safe.zh.md"), "---\ntitle: 中文\ndate: 2026-08-21\n---\n中文正文\n");
    writeFileSync(join(dir, "safe.en.md"), "---\ntitle: English\ndate: 2026-08-21\n---\nEnglish body\n");
    const { posts, compiled } = compileBlog({ srcDir: dir });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].slug, "safe");
    assert.equal(pickLocale(posts[0].title, "zh"), "中文");
    assert.equal(pickLocale(posts[0].title, "en"), "English");
    assert.match(compiled[0].variants.zh.html, /中文正文/);
    assert.match(compiled[0].variants.en.html, /English body/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
