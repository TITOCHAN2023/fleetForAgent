# Hub release evidence and trust limits

Maintained visual guide: [Verifying the Fleet Hub](../blog/same-source-as-github.en.md). Stable site entry: [/docs/same-source-as-github](https://fleet.ginfo.cc/docs/same-source-as-github), pinned on the docs index.

The guide maintains download and verification instructions, production adoption status, independent audit plans and trust limits. `/source` is self-reported; the legacy `verified` field only checks commit format and does not prove matching running code.

Update both languages in the same PR as release-mechanism changes, then run `npm run pack:blog` to synchronize site assets. Do not claim production adoption or an audit without a successful deployment record or audit report.
