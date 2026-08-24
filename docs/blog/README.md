# Blog source

Put posts here. The `/docs` page (no login) compiles this folder.

```
docs/blog/my-note.zh.md
docs/blog/my-note.en.md
docs/blog/pic.png          # optional, referenced from the md
```

Same slug, two files: switching EN / 中文 on the site picks the matching body. `README.md` and `welcome.md` are ignored.

Front matter:

```md
---
title: Short title
date: 2026-08-24
summary: One line on the index.
---

Paragraphs, lists, `code`, fenced blocks, **bold**, and images:

![alt](pic.png)
```

Then `npm run pack:blog` (also runs at `vite` start). Skip `README.md` and files that start with `_`.
