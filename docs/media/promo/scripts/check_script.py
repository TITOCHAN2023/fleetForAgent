"""Assert bilingual VO script + on-screen copy stay aligned."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "vo" / "script.json"
COPY = ROOT / "src" / "copy.ts"
SCENE_IDS = ["01-pain", "02-product", "03-principle", "04-collab", "05-setup", "06-cta"]


def main() -> int:
    spec = json.loads(SCRIPT.read_text(encoding="utf-8"))
    langs = spec.get("langs") or {}
    assert set(langs) >= {"zh", "en"}, f"missing langs: {sorted(langs)}"

    zh_ids = [s["id"] for s in langs["zh"]]
    en_ids = [s["id"] for s in langs["en"]]
    assert zh_ids == SCENE_IDS, zh_ids
    assert en_ids == SCENE_IDS, en_ids
    assert zh_ids == en_ids

    for loc, scenes in langs.items():
        assert len(scenes) == 6, (loc, len(scenes))
        for scene in scenes:
            text = (scene.get("text") or "").strip()
            assert text, f"empty spoken text {loc} {scene.get('id')}"
            assert scene["id"] in SCENE_IDS

    copy_src = COPY.read_text(encoding="utf-8")
    zh_cta = re.search(r"zh:\s*\{.*?ctaUrl:\s*'([^']+)'", copy_src, re.S)
    en_cta = re.search(r"en:\s*\{.*?ctaUrl:\s*'([^']+)'", copy_src, re.S)
    assert zh_cta and "fleet.ginfo.cc" in zh_cta.group(1), zh_cta.group(1) if zh_cta else "no zh ctaUrl"
    assert en_cta and "fleet.ginfo.cc" in en_cta.group(1), en_cta.group(1) if en_cta else "no en ctaUrl"
    assert copy_src.count("fleet.ginfo.cc") >= 2

    print("ok zh/en six scenes, non-empty VO, CTA contains fleet.ginfo.cc")
    print("zh ids", zh_ids)
    print("en ids", en_ids)
    print("zh ctaUrl", zh_cta.group(1))
    print("en ctaUrl", en_cta.group(1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
