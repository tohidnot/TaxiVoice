"""Parakeet TDT 0.6B v3 transcription wrapper."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

PARAKEET_ROOT = Path(os.environ.get("PARAKEET_ROOT", "/Users/apple/asr/parakeet-tdt-v3"))
CLI = PARAKEET_ROOT / "bin/parakeet-v0.5.0-bin-macos-metal-arm64/parakeet-cli"
MODEL = PARAKEET_ROOT / "models/tdt-0.6b-v3-q5_k.gguf"


def have_parakeet() -> bool:
    return CLI.is_file() and MODEL.is_file()


def to_wav(src: Path, dest: Path, sr: int = 16000) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.check_call(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(src),
            "-vn", "-ac", "1", "-ar", str(sr), "-sample_fmt", "s16",
            str(dest),
        ]
    )
    return dest


def is_video(path: Path) -> bool:
    return path.suffix.lower() in {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}


def transcribe_wav(wav_16k: Path) -> dict:
    if not have_parakeet():
        raise RuntimeError(
            "Parakeet v3 is not installed. Expected CLI at "
            f"{CLI} and model at {MODEL}"
        )
    proc = subprocess.run(
        [
            str(CLI), "transcribe",
            "--model", str(MODEL),
            "--input", str(wav_16k),
            "--decoder", "tdt",
            "--timestamps",
            "--json",
            "--threads", "4",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    # stdout is the JSON object; Metal logs go to stderr
    raw = proc.stdout.strip()
    if not raw:
        raise RuntimeError(proc.stderr[-2000:] or "empty transcription")
    # last JSON object in case anything leaked
    start = raw.find("{")
    data = json.loads(raw[start:])
    words = []
    for i, w in enumerate(data.get("words") or []):
        token = w.get("w") or w.get("word") or ""
        words.append(
            {
                "id": i,
                "word": token,
                "start": float(w["start"]),
                "end": float(w["end"]),
                "confidence": float(w.get("conf", w.get("confidence", 1.0))),
            }
        )
    return {
        "text": data.get("text") or " ".join(x["word"] for x in words),
        "frame_sec": float(data.get("frame_sec") or 0.08),
        "words": words,
        "model": "nvidia/parakeet-tdt-0.6b-v3",
    }
