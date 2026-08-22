"""Register 洞白 and synthesize per-locale per-scene VO via local CosyVoice."""
from __future__ import annotations

import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from pydub import AudioSegment

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "vo" / "script.json"
OUT_DIR = ROOT / "vo"
DB = Path(r"G:\project\cosyvoice-api4win\data\tts.db")
API = "http://127.0.0.1:8880"
GAP_MS = 280
HEAD_MS = 120
TAIL_MS = 400


def api(method: str, path: str, data=None, timeout=600):
    body = None
    headers = {}
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = urllib.request.Request(API + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def ensure_voice(name: str, position: str, prompt_text: str) -> None:
    conn = sqlite3.connect(str(DB))
    cur = conn.cursor()
    row = cur.execute(
        "SELECT voice_id, position, prompt_text FROM st_tts_voice WHERE name=?",
        (name,),
    ).fetchone()
    if row:
        cur.execute(
            "UPDATE st_tts_voice SET position=?, prompt_text=?, is_deleted=0 WHERE name=?",
            (position, prompt_text, name),
        )
        conn.commit()
        print(f"updated voice {name} id={row[0]}")
    else:
        cur.execute(
            "INSERT INTO st_tts_voice (name, position, prompt_text, create_at, is_deleted) VALUES (?,?,?,?,0)",
            (name, position, prompt_text, datetime.now().isoformat(sep=" ", timespec="seconds")),
        )
        conn.commit()
        print(f"created voice {name}")
    conn.close()


def synth(text: str, voice: str, speed: float, dest: Path) -> float:
    t0 = time.time()
    status, payload = api(
        "POST",
        "/tts",
        {
            "text": text,
            "voice": voice,
            "format": "wav",
            "speed": speed,
            "normalize": True,
        },
        timeout=900,
    )
    elapsed = time.time() - t0
    if status != 200:
        raise SystemExit(f"TTS failed {status}: {payload[:800]!r} in {elapsed:.1f}s")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(payload)
    audio = AudioSegment.from_wav(dest)
    print(f"  wrote {dest}  {len(audio)/1000:.2f}s  gen={elapsed:.1f}s  {dest.stat().st_size} bytes")
    return len(audio) / 1000.0


def concat_scenes(parts: list[AudioSegment], dest: Path) -> float:
    merged = AudioSegment.silent(duration=HEAD_MS)
    for i, part in enumerate(parts):
        if i:
            merged += AudioSegment.silent(duration=GAP_MS)
        merged += part
    merged += AudioSegment.silent(duration=TAIL_MS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    merged.export(dest, format="wav")
    return len(merged) / 1000.0


def run_lang(spec: dict, lang: str, only: list[str]) -> dict:
    scenes = spec["langs"][lang]
    voice = (spec.get("voices") or {}).get(lang) or spec["voice"]
    if only:
        scenes = [s for s in scenes if s["id"] in only or s["id"].split("-")[0] in only]
        if not scenes:
            raise SystemExit(f"no scenes matched {only} for {lang}")
    out = OUT_DIR / lang
    out.mkdir(parents=True, exist_ok=True)
    timing = []
    parts = []
    for scene in scenes:
        dest = out / f"{scene['id']}.wav"
        print(f"\n== {lang} {scene['id']} voice={voice} target={scene['seconds']}s ==")
        print(f"   {scene['text']}")
        dur = synth(scene["text"], voice, float(spec["speed"]), dest)
        timing.append(
            {
                "id": scene["id"],
                "text": scene["text"],
                "target_s": scene["seconds"],
                "audio_s": round(dur, 3),
                "file": str(dest),
            }
        )
        parts.append(AudioSegment.from_wav(dest))
    full_s = 0.0
    if parts:
        full_name = "full.wav" if len(timing) == len(spec["langs"][lang]) else "partial.wav"
        full_s = concat_scenes(parts, out / full_name)
        print(f"\n{lang} {full_name} {full_s:.2f}s")
    payload = {"voice": spec["voice"], "lang": lang, "scenes": timing, "full_s": round(full_s, 3)}
    (out / "timing.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return payload


def main() -> None:
    spec = json.loads(SCRIPT.read_text(encoding="utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ensure_voice(spec["voice"], spec["ref_audio"], spec["prompt_text"])
    if spec.get("en_ref_audio") and Path(spec["en_ref_audio"]).exists():
        ensure_voice(
            (spec.get("voices") or {}).get("en") or "洞白en",
            spec["en_ref_audio"],
            spec.get("en_prompt_text") or "",
        )

    status, payload = api("GET", "/health", timeout=5)
    print("health", status, payload.decode("utf-8", "replace"))
    status, payload = api("GET", "/voices", timeout=10)
    print("voices", payload.decode("utf-8", "replace")[:500])

    args = sys.argv[1:]
    langs = [a for a in args if a in spec["langs"]]
    only = [a for a in args if a not in spec["langs"]]
    if not langs:
        langs = ["zh", "en"]
    for lang in langs:
        run_lang(spec, lang, only)


if __name__ == "__main__":
    main()
