"""Mux aligned 洞白 wav onto a silent Remotion intro."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def mux(lang: str) -> None:
    silent = ROOT / "out" / f"intro-{lang}-silent.mp4"
    wav = ROOT / "vo" / lang / "full-aligned.wav"
    dest = ROOT / "out" / f"intro-{lang}.mp4"
    if not silent.exists():
        raise SystemExit(f"missing {silent}")
    if not wav.exists():
        raise SystemExit(f"missing {wav}")
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(silent),
        "-i",
        str(wav),
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-shortest",
        str(dest),
    ]
    subprocess.run(cmd, check=True)
    print("wrote", dest, dest.stat().st_size)


def main() -> None:
    langs = sys.argv[1:] or ["zh", "en"]
    for lang in langs:
        mux(lang)


if __name__ == "__main__":
    main()
