"""Probe the shipped zh/en intro MP4s (1920x1080, audio, ~75s)."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def probe(path: Path) -> dict:
    raw = subprocess.check_output(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        text=True,
        encoding="utf-8",
    )
    return json.loads(raw)


def check(lang: str) -> None:
    path = ROOT / "out" / f"intro-{lang}.mp4"
    assert path.exists() and path.stat().st_size > 100_000, path
    data = probe(path)
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    audio = next(s for s in data["streams"] if s["codec_type"] == "audio")
    dur = float(data["format"]["duration"])
    assert int(video["width"]) == 1920 and int(video["height"]) == 1080, video
    assert audio["codec_type"] == "audio"
    assert float(audio.get("duration") or dur) > 1
    assert 70 <= dur <= 90, dur
    print(f"ok {lang} {path.name} {video['width']}x{video['height']} {dur:.1f}s audio={audio['codec_name']}")


def main() -> int:
    check("zh")
    check("en")
    return 0


if __name__ == "__main__":
    sys.exit(main())
