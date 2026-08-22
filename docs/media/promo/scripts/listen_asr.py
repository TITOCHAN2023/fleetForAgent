"""ASR-listen each CosyVoice scene wav against distinctive script needles."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "vo" / "script.json"
VO = ROOT / "vo"

# Distinctive phrases taken from vo/script.json (must remain substrings of that file).
NEEDLES = {
    "zh": {
        "01-pain": "各管各的",
        "02-product": "一个工具",
        "03-principle": "家里、公司、机房",
        "04-collab": "舰队还在",
        "05-setup": "放到云上",
        "06-cta": "一个工具",
    },
    "en": {
        "01-pain": "scattered",
        "02-product": "one tool",
        "03-principle": "cloud hub",
        "04-collab": "fleet is still",
        "05-setup": "in the cloud",
        "06-cta": "open the website",
    },
}


# Whisper often emits Taiwan glyphs for this speaker; fold before match.
_TRAD = {
    "艦": "舰",
    "隊": "队",
    "還": "还",
    "沒": "没",
    "認": "认",
    "來": "来",
    "這": "这",
    "個": "个",
    "們": "们",
    "時": "时",
    "過": "过",
    "後": "后",
    "點": "点",
    "開": "开",
    "關": "关",
    "東": "东",
    "車": "车",
    "門": "门",
    "無": "无",
    "長": "长",
    "學": "学",
    "國": "国",
    "對": "对",
    "齊": "齐",
    "強": "强",
    "經": "经",
    "腦": "脑",
    "遠": "远",
    "線": "线",
    "裡": "里",
    "機": "机",
    "臺": "台",
    "導": "导",
    "客": "客",
    "戶": "户",
    "斷": "断",
    "從": "从",
    "連": "连",
    "種": "种",
    "選": "选",
    "結": "结",
    "果": "果",
    "裝": "装",
    "隨": "随",
    "際": "际",
}


def norm(text: str) -> str:
    text = text.lower().replace("’", "'")
    text = "".join(_TRAD.get(ch, ch) for ch in text)
    return re.sub(r"[^\w\u4e00-\u9fff]+", "", text, flags=re.UNICODE)


def main() -> int:
    spec = json.loads(SCRIPT.read_text(encoding="utf-8"))
    import whisper
    from pydub import AudioSegment

    model = whisper.load_model("small")
    langs = sys.argv[1:] or ["zh", "en"]
    failed = []
    for lang in langs:
        rows = []
        language = "zh" if lang == "zh" else "en"
        for scene in spec["langs"][lang]:
            wav = VO / lang / f"{scene['id']}.wav"
            if not wav.exists():
                raise SystemExit(f"missing {wav}")
            needle = NEEDLES[lang][scene["id"]]
            if needle.lower() not in scene["text"].lower() and needle not in scene["text"]:
                raise SystemExit(f"needle {needle!r} not in script {lang} {scene['id']}")
            audio_s = len(AudioSegment.from_wav(wav)) / 1000.0
            result = model.transcribe(str(wav), language=language)
            transcript = (result.get("text") or "").strip()
            ok = norm(needle) in norm(transcript)
            row = {
                "id": scene["id"],
                "script": scene["text"],
                "needle": needle,
                "transcript": transcript,
                "audio_s": round(audio_s, 3),
                "ok": ok,
            }
            rows.append(row)
            print(f"{lang} {scene['id']} ok={ok} {audio_s:.2f}s needle={needle!r}")
            print(f"  ASR: {transcript}")
            if not ok:
                failed.append(f"{lang}/{scene['id']}")
        out = VO / lang / "asr.json"
        out.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
        print("wrote", out)
    if failed:
        print("FAILED", failed)
        return 1
    print("all scenes matched distinctive needles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
