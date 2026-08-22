"""Pad each scene clip to at least its visual target, concat, write sceneFrames."""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from pydub import AudioSegment

ROOT = Path(__file__).resolve().parents[1]
FPS = 30


def align(lang: str) -> dict:
    timing_path = ROOT / "vo" / lang / "timing.json"
    spec = json.loads(timing_path.read_text(encoding="utf-8"))
    parts = []
    frames = []
    rows = []
    for scene in spec["scenes"]:
        wav = Path(scene["file"])
        clip = AudioSegment.from_wav(wav)
        target_ms = int(round(float(scene["target_s"]) * 1000))
        if len(clip) < target_ms:
            clip = clip + AudioSegment.silent(duration=target_ms - len(clip))
        parts.append(clip)
        scene_frames = max(1, int(math.ceil(len(clip) / 1000.0 * FPS)))
        # snap clip to exact frame length so mux lines up
        frame_ms = int(round(scene_frames * 1000 / FPS))
        if len(clip) < frame_ms:
            clip = clip + AudioSegment.silent(duration=frame_ms - len(clip))
        elif len(clip) > frame_ms:
            clip = clip[:frame_ms]
        parts[-1] = clip
        frames.append(scene_frames)
        rows.append(
            {
                "id": scene["id"],
                "target_s": scene["target_s"],
                "audio_s": scene["audio_s"],
                "aligned_s": round(len(clip) / 1000.0, 3),
                "frames": scene_frames,
            }
        )
    merged = sum(parts[1:], parts[0])
    dest = ROOT / "vo" / lang / "full-aligned.wav"
    merged.export(dest, format="wav")
    payload = {
        "lang": lang,
        "full_s": round(len(merged) / 1000.0, 3),
        "sceneFrames": frames,
        "scenes": rows,
        "file": str(dest),
    }
    (ROOT / "vo" / lang / "aligned.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    locale = "zh" if lang == "zh" else lang
    (ROOT / "vo" / lang / "props.json").write_text(
        json.dumps({"locale": locale, "sceneFrames": frames}, ensure_ascii=False),
        encoding="utf-8",
    )
    print(lang, "full_s", payload["full_s"], "frames", frames, "sum", sum(frames))
    return payload


def main() -> None:
    langs = sys.argv[1:] or ["zh", "en"]
    for lang in langs:
        align(lang)


if __name__ == "__main__":
    main()
