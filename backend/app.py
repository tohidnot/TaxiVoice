"""TaxiVoice local API — import, transcribe, cut, export."""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import uuid
import wave
from pathlib import Path

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from agent import plan
from cut_engine import float_to_pcm16, refine_words, render_keep_ranges, waveform_peaks, keep_ranges
from transcribe import have_parakeet, is_video, to_wav, transcribe_wav

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
FRONT = ROOT / "frontend"
DATA.mkdir(exist_ok=True)

app = FastAPI(title="TaxiVoice")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _proj_dir(pid: str) -> Path:
    p = DATA / pid
    if not p.is_dir():
        raise HTTPException(404, "project not found")
    return p


def _load(pid: str) -> dict:
    return json.loads((_proj_dir(pid) / "project.json").read_text())


def _save(meta: dict) -> None:
    meta["updated_at"] = time.time()
    if "created_at" not in meta:
        meta["created_at"] = meta["updated_at"]
    path = DATA / meta["id"] / "project.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, indent=2))


def _empty_session(name: str = "New chat") -> dict:
    pid = uuid.uuid4().hex[:12]
    return {
        "id": pid,
        "name": name,
        "kind": None,
        "original": None,
        "wav44": None,
        "duration": 0,
        "model": None,
        "words": [],
        "deleted": [],
        "undo": [],
        "redo": [],
        "peaks": [],
        "thumbs": [],
        "messages": [
            {
                "role": "assistant",
                "text": "This is a new workspace. Drop an audio or video file to transcribe it.",
            }
        ],
    }


def _summarize(meta: dict, path: Path) -> dict:
    words = meta.get("words") or []
    deleted = set(meta.get("deleted") or [])
    kept = [w.get("word", "") for w in words if int(w.get("id", -1)) not in deleted]
    msgs = meta.get("messages") or []
    last_user = next((m.get("text") for m in reversed(msgs) if m.get("role") == "user"), "")
    preview = " ".join(kept)[:90] or last_user[:90]
    return {
        "id": meta["id"],
        "name": meta.get("name") or "New chat",
        "kind": meta.get("kind"),
        "duration": meta.get("duration") or 0,
        "has_audio": bool(words),
        "word_count": len(kept),
        "preview": preview,
        "updated_at": meta.get("updated_at") or path.stat().st_mtime,
    }


def _read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
        pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        ch = w.getnchannels()
        if ch > 1:
            pcm = pcm.reshape(-1, ch).mean(axis=1)
    return pcm, sr


def _write_wav(path: Path, pcm: np.ndarray, sr: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(float_to_pcm16(pcm))


def _public(meta: dict) -> dict:
    words = meta["words"]
    deleted = set(meta.get("deleted") or [])
    ranges = keep_ranges(words, deleted)
    edited = sum(b - a for a, b in ranges)
    return {
        "id": meta["id"],
        "name": meta["name"],
        "kind": meta["kind"],
        "duration": meta["duration"],
        "edited_duration": round(edited, 3),
        "model": meta.get("model"),
        "text": " ".join(w["word"] for w in words if w["id"] not in deleted),
        "words": [
            {**w, "deleted": w["id"] in deleted}
            for w in words
        ],
        "keep_ranges": ranges,
        "peaks": meta.get("peaks") or [],
        "thumbs": meta.get("thumbs") or [],
        "messages": meta.get("messages") or [],
        "can_undo": bool(meta.get("undo")),
        "can_redo": bool(meta.get("redo")),
        "parakeet": have_parakeet(),
    }


@app.get("/api/health")
def health():
    return {"ok": True, "parakeet": have_parakeet()}


@app.get("/api/projects")
def list_projects():
    items = []
    for path in DATA.glob("*/project.json"):
        try:
            meta = json.loads(path.read_text())
            items.append(_summarize(meta, path))
        except Exception:
            continue
    items.sort(key=lambda x: x.get("updated_at") or 0, reverse=True)
    return {"projects": items}


@app.post("/api/projects")
def create_project():
    meta = _empty_session()
    _save(meta)
    return _public(meta)


@app.post("/api/projects/import")
async def import_media(file: UploadFile = File(...), session_id: str | None = Form(None)):
    if not have_parakeet():
        raise HTTPException(500, "Parakeet v3 is not installed on this Mac")

    existing = None
    if session_id:
        try:
            existing = _load(session_id)
        except HTTPException:
            existing = None
    reuse = bool(existing and not (existing.get("words") or []))
    pid = existing["id"] if reuse else uuid.uuid4().hex[:12]
    dest = DATA / pid
    dest.mkdir(parents=True, exist_ok=True)
    original = dest / f"original{Path(file.filename or 'media.bin').suffix.lower() or '.bin'}"
    original.write_bytes(await file.read())

    kind = "video" if is_video(original) else "audio"
    wav16 = dest / "audio.16k.wav"
    wav44 = dest / "audio.44100.wav"
    to_wav(original, wav16, 16000)
    to_wav(original, wav44, 44100)

    asr = transcribe_wav(wav16)
    pcm, sr = _read_wav(wav44)
    words = refine_words(asr["words"], pcm, sr)
    peaks = waveform_peaks(pcm, 1600)
    duration = round(len(pcm) / sr, 3)

    thumbs: list[str] = []
    if kind == "video":
        tdir = dest / "thumbs"
        tdir.mkdir(exist_ok=True)
        n = 5
        for i in range(n):
            t = duration * (i + 0.5) / n
            out = tdir / f"{i}.jpg"
            subprocess.run(
                [
                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-ss", f"{t:.3f}", "-i", str(original),
                    "-frames:v", "1", "-vf", "scale=320:-1",
                    str(out),
                ],
                check=False,
            )
            if out.exists():
                thumbs.append(f"/api/projects/{pid}/thumbs/{i}.jpg")

    name = Path(file.filename or "Untitled").stem.replace("_", " ")[:48]
    prior_msgs = list((existing or {}).get("messages") or [])
    prior_msgs.append(
        {
            "role": "assistant",
            "text": (
                f"Transcribed {len(words)} words with Parakeet v3. "
                "Delete any word, or ask me to remove fillers and repeats."
            ),
        }
    )
    meta = {
        "id": pid,
        "name": name or "Untitled",
        "kind": kind,
        "original": str(original),
        "wav44": str(wav44),
        "duration": duration,
        "model": asr.get("model"),
        "words": words,
        "deleted": [],
        "undo": [],
        "redo": [],
        "peaks": peaks,
        "thumbs": thumbs,
        "messages": prior_msgs,
        "created_at": (existing or {}).get("created_at"),
    }
    _save(meta)
    return _public(meta)


class IdsBody(BaseModel):
    ids: list[int]


class ChatBody(BaseModel):
    message: str


class BoundsBody(BaseModel):
    updates: list[dict]


@app.get("/api/projects/latest")
def latest_project():
    files = sorted(DATA.glob("*/project.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return {"id": None, "words": []}
    return _public(json.loads(files[0].read_text()))


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    return _public(_load(pid))


@app.post("/api/projects/{pid}/delete")
def delete_words(pid: str, body: IdsBody):
    meta = _load(pid)
    deleted = set(meta.get("deleted") or [])
    before = set(deleted)
    deleted.update(int(i) for i in body.ids)
    if deleted != before:
        meta.setdefault("undo", []).append(meta.get("deleted") or [])
        meta["redo"] = []
        meta["deleted"] = sorted(deleted)
        _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/restore")
def restore_words(pid: str, body: IdsBody):
    meta = _load(pid)
    deleted = set(meta.get("deleted") or [])
    before = set(deleted)
    deleted.difference_update(int(i) for i in body.ids)
    if deleted != before:
        meta.setdefault("undo", []).append(meta.get("deleted") or [])
        meta["redo"] = []
        meta["deleted"] = sorted(deleted)
        _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/undo")
def undo(pid: str):
    meta = _load(pid)
    undo = meta.get("undo") or []
    if not undo:
        return _public(meta)
    meta.setdefault("redo", []).append(meta.get("deleted") or [])
    meta["deleted"] = undo.pop()
    meta["undo"] = undo
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/redo")
def redo(pid: str):
    meta = _load(pid)
    redo = meta.get("redo") or []
    if not redo:
        return _public(meta)
    meta.setdefault("undo", []).append(meta.get("deleted") or [])
    meta["deleted"] = redo.pop()
    meta["redo"] = redo
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/bounds")
def update_bounds(pid: str, body: BoundsBody):
    meta = _load(pid)
    by_id = {int(w["id"]): w for w in meta["words"]}
    changed = False
    for item in body.updates:
        w = by_id.get(int(item.get("id", -1)))
        if not w:
            continue
        if "cut_start" in item and item["cut_start"] is not None:
            w["cut_start"] = round(float(item["cut_start"]), 4)
            changed = True
        if "cut_end" in item and item["cut_end"] is not None:
            w["cut_end"] = round(float(item["cut_end"]), 4)
            changed = True
        if w.get("cut_end", w["end"]) < w.get("cut_start", w["start"]) + 0.03:
            w["cut_end"] = round(w.get("cut_start", w["start"]) + 0.03, 4)
    if changed:
        _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/agent")
def agent_chat(pid: str, body: ChatBody):
    meta = _load(pid)
    deleted = set(meta.get("deleted") or [])
    meta.setdefault("messages", []).append({"role": "user", "text": body.message})
    result = plan(body.message, meta["words"], deleted)
    new_ids = [i for i in result["delete_ids"] if i not in deleted]
    if new_ids:
        meta.setdefault("undo", []).append(meta.get("deleted") or [])
        meta["redo"] = []
        deleted.update(new_ids)
        meta["deleted"] = sorted(deleted)
    meta["messages"].append({"role": "assistant", "text": result["reply"]})
    _save(meta)
    return _public(meta)


@app.get("/api/projects/{pid}/media")
def media(pid: str):
    meta = _load(pid)
    path = Path(meta["original"])
    return FileResponse(path, filename=path.name)


@app.get("/api/projects/{pid}/audio")
def preview_audio(pid: str):
    """PCM wav for sample-accurate preview (MP3 seeking drifts by tens of ms)."""
    meta = _load(pid)
    path = Path(meta["wav44"])
    return FileResponse(path, filename=path.name, media_type="audio/wav")


@app.get("/api/projects/{pid}/thumbs/{name}")
def thumb(pid: str, name: str):
    path = _proj_dir(pid) / "thumbs" / name
    if not path.is_file():
        raise HTTPException(404, "thumb missing")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/api/projects/{pid}/export")
def export_media(pid: str):
    meta = _load(pid)
    pcm, sr = _read_wav(Path(meta["wav44"]))
    ranges = keep_ranges(meta["words"], meta.get("deleted") or [])
    out_pcm = render_keep_ranges(pcm, sr, ranges)
    dest = _proj_dir(pid)
    wav_out = dest / "edited.wav"
    _write_wav(wav_out, out_pcm, sr)

    if meta["kind"] == "video":
        mp4_out = dest / "edited.mp4"
        _export_video(Path(meta["original"]), ranges, wav_out, mp4_out)
        return FileResponse(mp4_out, filename=f"{meta['name']}-edited.mp4")

    mp3_out = dest / "edited.mp3"
    subprocess.check_call(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(wav_out), "-codec:a", "libmp3lame", "-q:a", "2",
            str(mp3_out),
        ]
    )
    return FileResponse(mp3_out, filename=f"{meta['name']}-edited.mp3")


def _export_video(src: Path, ranges: list[tuple[float, float]], wav: Path, dest: Path) -> None:
    if not ranges:
        raise HTTPException(400, "nothing left to export")
    filters = []
    concat = []
    for i, (a, b) in enumerate(ranges):
        filters.append(
            f"[0:v]trim=start={a:.4f}:end={b:.4f},setpts=PTS-STARTPTS[v{i}]"
        )
        concat.append(f"[v{i}]")
    filters.append("".join(concat) + f"concat=n={len(ranges)}:v=1:a=0[v]")
    subprocess.check_call(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(src),
            "-i", str(wav),
            "-filter_complex", ";".join(filters),
            "-map", "[v]", "-map", "1:a",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-shortest",
            str(dest),
        ]
    )


@app.post("/api/projects/{pid}/rename")
def rename(pid: str, body: dict):
    meta = _load(pid)
    name = str(body.get("name") or "").strip()[:64]
    if name:
        meta["name"] = name
        _save(meta)
    return _public(meta)


if FRONT.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONT), html=True), name="front")
