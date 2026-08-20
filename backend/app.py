"""TaxiVoice local API — import, transcribe, cut, export."""

from __future__ import annotations

import copy
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


@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


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
        "clips": [],
        "needs_retranscribe": False,
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


def _new_clip_id() -> str:
    return "c" + uuid.uuid4().hex[:8]


def _push_undo(meta: dict) -> None:
    meta.setdefault("undo", []).append({
        "deleted": list(meta.get("deleted") or []),
        "words": copy.deepcopy(meta.get("words") or []),
        "clips": copy.deepcopy(meta.get("clips") or []),
        "needs_retranscribe": bool(meta.get("needs_retranscribe")),
    })
    meta["redo"] = []


def _restore_snapshot(meta: dict, snap) -> None:
    if isinstance(snap, dict):
        meta["deleted"] = snap.get("deleted", [])
        if "words" in snap:
            meta["words"] = snap["words"]
        if "clips" in snap:
            meta["clips"] = snap["clips"]
        if "needs_retranscribe" in snap:
            meta["needs_retranscribe"] = bool(snap["needs_retranscribe"])
    elif isinstance(snap, list):
        meta["deleted"] = snap


def _word_span(w: dict) -> tuple[float, float]:
    return float(w.get("cut_start", w["start"])), float(w.get("cut_end", w["end"]))


def _clips_from_ranges(ranges: list[tuple[float, float]]) -> list[dict]:
    return [
        {
            "id": _new_clip_id(),
            "in": round(a, 4),
            "out": round(b, 4),
            "origin_in": round(a, 4),
            "origin_out": round(b, 4),
        }
        for a, b in ranges
        if b - a > 0.02
    ]


def _ensure_clips(meta: dict) -> list[dict]:
    clips = list(meta.get("clips") or [])
    if clips:
        return clips
    words = meta.get("words") or []
    deleted = set(meta.get("deleted") or [])
    clips = _clips_from_ranges(keep_ranges(words, deleted))
    meta["clips"] = clips
    return clips


def _clip_ranges(meta: dict) -> list[tuple[float, float]]:
    clips = meta.get("clips") or []
    if clips:
        return [
            (float(c["in"]), float(c["out"]))
            for c in clips
            if float(c["out"]) - float(c["in"]) > 0.02
        ]
    return keep_ranges(meta.get("words") or [], meta.get("deleted") or [])


def _delete_word_ids(meta: dict, ids: list[int]) -> None:
    deleted = set(meta.get("deleted") or [])
    by_id = {int(w["id"]): w for w in (meta.get("words") or [])}
    clips = _ensure_clips(meta)
    for wid in ids:
        deleted.add(int(wid))
        w = by_id.get(int(wid))
        if not w:
            continue
        s, e = _word_span(w)
        clips = _subtract_from_clips(clips, s, e)
    meta["deleted"] = sorted(deleted)
    meta["clips"] = clips


def _subtract_from_clips(clips: list[dict], a: float, b: float) -> list[dict]:
    new = []
    for c in clips:
        cin, cout = float(c["in"]), float(c["out"])
        if b <= cin + 0.005 or a >= cout - 0.005:
            new.append(c)
            continue
        if a - cin > 0.04:
            left = dict(c)
            left["out"] = round(a, 4)
            new.append(left)
        if cout - b > 0.04:
            right = dict(c)
            right["id"] = _new_clip_id()
            right["in"] = round(b, 4)
            new.append(right)
    return new


def _public(meta: dict) -> dict:
    words = meta.get("words") or []
    deleted = set(meta.get("deleted") or [])
    clips = list(meta.get("clips") or [])
    if not clips:
        clips = _clips_from_ranges(keep_ranges(words, deleted))
    ranges = [
        (float(c["in"]), float(c["out"]))
        for c in clips
        if float(c["out"]) - float(c["in"]) > 0.02
    ] or keep_ranges(words, deleted)
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
        "clips": clips,
        "needs_retranscribe": bool(meta.get("needs_retranscribe")),
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


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    import shutil
    dest = DATA / pid
    if dest.exists() and dest.is_dir():
        shutil.rmtree(dest)
    return {"ok": True}


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
            "role": "user",
            "text": f"Import {file.filename}",
        }
    )
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
        "clips": [
            {
                "id": _new_clip_id(),
                "in": 0.0,
                "out": duration,
                "origin_in": 0.0,
                "origin_out": duration,
            }
        ] if duration > 0.02 else [],
        "needs_retranscribe": False,
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


class SplitBody(BaseModel):
    time: float


class TrimBody(BaseModel):
    start: float
    end: float


class ReorderBody(BaseModel):
    order: list[list[int]] | None = None
    clip_ids: list[str] | None = None


class DuplicateBody(BaseModel):
    ids: list[int]


class ClipTrimBody(BaseModel):
    id: str
    in_point: float | None = None
    out_point: float | None = None


class ClipIdBody(BaseModel):
    id: str


@app.get("/api/projects/latest")
def latest_project():
    files = sorted(DATA.glob("*/project.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return {"id": None, "words": []}
    return _public(json.loads(files[0].read_text()))


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    meta = _load(pid)
    if (meta.get("words") or []) and not (meta.get("clips") or []):
        _ensure_clips(meta)
        _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/delete")
def delete_words(pid: str, body: IdsBody):
    meta = _load(pid)
    before = set(meta.get("deleted") or [])
    ids = [int(i) for i in body.ids]
    if any(i not in before for i in ids):
        _push_undo(meta)
        _delete_word_ids(meta, ids)
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
    undo_stack = meta.get("undo") or []
    if not undo_stack:
        return _public(meta)
    prev = undo_stack.pop()
    meta.setdefault("redo", []).append({
        "deleted": list(meta.get("deleted") or []),
        "words": copy.deepcopy(meta.get("words") or []),
        "clips": copy.deepcopy(meta.get("clips") or []),
        "needs_retranscribe": bool(meta.get("needs_retranscribe")),
    })
    _restore_snapshot(meta, prev)
    meta["undo"] = undo_stack
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/redo")
def redo(pid: str):
    meta = _load(pid)
    redo_stack = meta.get("redo") or []
    if not redo_stack:
        return _public(meta)
    nxt = redo_stack.pop()
    meta.setdefault("undo", []).append({
        "deleted": list(meta.get("deleted") or []),
        "words": copy.deepcopy(meta.get("words") or []),
        "clips": copy.deepcopy(meta.get("clips") or []),
        "needs_retranscribe": bool(meta.get("needs_retranscribe")),
    })
    _restore_snapshot(meta, nxt)
    meta["redo"] = redo_stack
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/bounds")
def update_bounds(pid: str, body: BoundsBody):
    meta = _load(pid)
    words = meta.get("words") or []
    by_id = {int(w["id"]): w for w in words}
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
        if w.get("cut_end", w["end"]) < w.get("cut_start", w["start"]) + 0.02:
            w["cut_end"] = round(w.get("cut_start", w["start"]) + 0.02, 4)
    if changed:
        meta.setdefault("undo", []).append({
            "deleted": list(meta.get("deleted") or []),
            "words": copy.deepcopy(words),
        })
        meta["redo"] = []
        _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/split")
def split_at_time(pid: str, body: SplitBody):
    meta = _load(pid)
    t = round(float(body.time), 4)
    clips = _ensure_clips(meta)
    target_i = next(
        (
            i
            for i, c in enumerate(clips)
            if float(c["in"]) + 0.05 < t < float(c["out"]) - 0.05
        ),
        -1,
    )
    if target_i < 0:
        raise HTTPException(400, "playhead is not inside a clip")

    _push_undo(meta)
    c = dict(clips[target_i])
    left = dict(c)
    left["out"] = t
    left["origin_out"] = min(float(c.get("origin_out", c["out"])), t)
    right = dict(c)
    right["id"] = _new_clip_id()
    right["in"] = t
    right["origin_in"] = max(float(c.get("origin_in", c["in"])), t)
    clips[target_i : target_i + 1] = [left, right]
    meta["clips"] = clips
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/trim")
def trim_range(pid: str, body: TrimBody):
    meta = _load(pid)
    t0 = round(float(body.start), 4)
    t1 = round(float(body.end), 4)
    if t1 <= t0:
        raise HTTPException(400, "invalid trim range")

    words = meta.get("words") or []
    if not words:
        raise HTTPException(400, "no words to trim")

    meta.setdefault("undo", []).append({
        "deleted": list(meta.get("deleted") or []),
        "words": copy.deepcopy(words),
    })
    meta["redo"] = []

    deleted = set(meta.get("deleted") or [])
    for w in words:
        wid = int(w["id"])
        ws = float(w.get("cut_start", w["start"]))
        we = float(w.get("cut_end", w["end"]))
        if we <= t0 or ws >= t1:
            deleted.add(wid)
        else:
            if ws < t0:
                w["cut_start"] = t0
            if we > t1:
                w["cut_end"] = t1

    meta["deleted"] = sorted(deleted)
    meta["words"] = words
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/append")
async def append_media(pid: str, file: UploadFile = File(...)):
    if not have_parakeet():
        raise HTTPException(500, "Parakeet v3 is not installed on this Mac")
    meta = _load(pid)
    dest = DATA / pid
    dest.mkdir(parents=True, exist_ok=True)

    clip_stamp = int(time.time() * 1000)
    clip_ext = Path(file.filename or "media.bin").suffix.lower() or ".bin"
    clip_file = dest / f"clip_{clip_stamp}{clip_ext}"
    clip_file.write_bytes(await file.read())

    is_vid = is_video(clip_file)
    if is_vid and meta.get("kind") != "video":
        meta["kind"] = "video"
        meta["original"] = str(clip_file)

    wav16 = dest / f"temp_{clip_stamp}.16k.wav"
    wav44 = dest / f"temp_{clip_stamp}.44100.wav"
    to_wav(clip_file, wav16, 16000)
    to_wav(clip_file, wav44, 44100)

    asr = transcribe_wav(wav16)
    new_pcm, sr = _read_wav(wav44)

    old_wav_path = Path(meta["wav44"]) if meta.get("wav44") else None
    if old_wav_path and old_wav_path.exists():
        old_pcm, old_sr = _read_wav(old_wav_path)
        prior_duration = round(len(old_pcm) / old_sr, 4)
        combined_pcm = np.concatenate([old_pcm, new_pcm])
    else:
        prior_duration = 0.0
        combined_pcm = new_pcm
        meta["wav44"] = str(dest / "audio.44100.wav")
        if not meta.get("original"):
            meta["original"] = str(clip_file)
            meta["kind"] = "video" if is_vid else "audio"

    _write_wav(Path(meta["wav44"]), combined_pcm, 44100)

    if wav16.exists():
        wav16.unlink()
    if wav44.exists():
        wav44.unlink()

    refined = refine_words(asr.get("words", []), new_pcm, 44100)
    existing_words = meta.get("words") or []
    max_id = max((int(w["id"]) for w in existing_words), default=-1)

    for i, w in enumerate(refined):
        w["id"] = max_id + 1 + i
        w["start"] = round(float(w["start"]) + prior_duration, 4)
        w["end"] = round(float(w["end"]) + prior_duration, 4)
        w["cut_start"] = round(float(w.get("cut_start", w["start"])) + prior_duration, 4)
        w["cut_end"] = round(float(w.get("cut_end", w["end"])) + prior_duration, 4)

    all_words = existing_words + refined
    meta.setdefault("undo", []).append({
        "deleted": list(meta.get("deleted") or []),
        "words": copy.deepcopy(existing_words),
        "clips": copy.deepcopy(meta.get("clips") or []),
        "needs_retranscribe": bool(meta.get("needs_retranscribe")),
    })
    meta["redo"] = []
    meta["words"] = all_words
    meta["peaks"] = waveform_peaks(combined_pcm, 1600)
    meta["duration"] = round(len(combined_pcm) / 44100, 3)
    clips = list(meta.get("clips") or [])
    if not clips:
        clips = _clips_from_ranges(keep_ranges(existing_words, meta.get("deleted") or []))
    new_end = float(meta["duration"])
    clips.append({
        "id": _new_clip_id(),
        "in": round(prior_duration, 4),
        "out": round(new_end, 4),
        "origin_in": round(prior_duration, 4),
        "origin_out": round(new_end, 4),
    })
    meta["clips"] = clips

    if is_vid:
        tdir = dest / "thumbs"
        tdir.mkdir(exist_ok=True)
        curr_thumbs = list(meta.get("thumbs") or [])
        n = 5
        new_dur = len(new_pcm) / 44100
        for i in range(n):
            t = new_dur * (i + 0.5) / n
            thumb_idx = len(curr_thumbs) + i
            out = tdir / f"{thumb_idx}.jpg"
            subprocess.run(
                [
                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                    "-ss", f"{t:.3f}", "-i", str(clip_file),
                    "-frames:v", "1", "-vf", "scale=320:-1",
                    str(out),
                ],
                check=False,
            )
            if out.exists():
                curr_thumbs.append(f"/api/projects/{pid}/thumbs/{thumb_idx}.jpg")
        meta["thumbs"] = curr_thumbs

    meta.setdefault("messages", []).append({
        "role": "assistant",
        "text": f"Added clip '{Path(file.filename or 'clip').name}' with {len(refined)} words to the timeline.",
    })
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/reorder_clips")
def reorder_clips(pid: str, body: ReorderBody):
    meta = _load(pid)
    clips = _ensure_clips(meta)
    _push_undo(meta)
    if body.clip_ids:
        by_id = {c["id"]: c for c in clips}
        new_clips = [by_id[i] for i in body.clip_ids if i in by_id]
        for c in clips:
            if c["id"] not in body.clip_ids:
                new_clips.append(c)
        meta["clips"] = new_clips
        clips = new_clips
    elif body.order:
        words = meta.get("words") or []
        word_map = {int(w["id"]): w for w in words}
        reordered = []
        seen_ids = set()
        for clip in body.order:
            for wid in clip:
                if int(wid) in word_map and int(wid) not in seen_ids:
                    reordered.append(word_map[int(wid)])
                    seen_ids.add(int(wid))
        for w in words:
            if int(w["id"]) not in seen_ids:
                reordered.append(w)
        meta["words"] = reordered
    meta["needs_retranscribe"] = True
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/clips/trim")
def trim_clip(pid: str, body: ClipTrimBody):
    meta = _load(pid)
    clips = _ensure_clips(meta)
    idx = next((i for i, c in enumerate(clips) if c["id"] == body.id), -1)
    if idx < 0:
        raise HTTPException(404, "clip not found")
    c = dict(clips[idx])
    old_in, old_out = float(c["in"]), float(c["out"])
    origin_in = float(c.get("origin_in", old_in))
    origin_out = float(c.get("origin_out", old_out))
    new_in = old_in if body.in_point is None else float(body.in_point)
    new_out = old_out if body.out_point is None else float(body.out_point)
    new_in = max(origin_in, new_in)
    new_out = min(origin_out, new_out)
    for j, other in enumerate(clips):
        if j == idx:
            continue
        oi, oo = float(other["in"]), float(other["out"])
        if oo <= new_in or oi >= new_out:
            continue
        if oi < old_in:
            new_in = max(new_in, oo)
        else:
            new_out = min(new_out, oi)
    if new_out - new_in < 0.08:
        raise HTTPException(400, "clip too short")

    _push_undo(meta)
    words = meta.get("words") or []
    deleted = set(meta.get("deleted") or [])

    if new_in > old_in + 0.001:
        for w in words:
            s, e = _word_span(w)
            if e <= old_in + 0.005 or s >= new_in - 0.005:
                continue
            if e <= new_in + 0.02:
                deleted.add(int(w["id"]))
            else:
                w["cut_start"] = round(new_in, 4)
                deleted.discard(int(w["id"]))
    elif new_in < old_in - 0.001:
        for w in words:
            orig_s, orig_e = float(w["start"]), float(w["end"])
            if orig_e <= new_in + 0.005 or orig_s >= old_in - 0.005:
                continue
            deleted.discard(int(w["id"]))
            w["cut_start"] = round(max(orig_s, new_in), 4)
            w["cut_end"] = round(min(float(w.get("cut_end", orig_e)), orig_e), 4)

    if new_out < old_out - 0.001:
        for w in words:
            s, e = _word_span(w)
            if e <= new_out + 0.005 or s >= old_out - 0.005:
                continue
            if s >= new_out - 0.02:
                deleted.add(int(w["id"]))
            else:
                w["cut_end"] = round(new_out, 4)
                deleted.discard(int(w["id"]))
    elif new_out > old_out + 0.001:
        for w in words:
            orig_s, orig_e = float(w["start"]), float(w["end"])
            if orig_e <= old_out + 0.005 or orig_s >= new_out - 0.005:
                continue
            deleted.discard(int(w["id"]))
            w["cut_start"] = round(max(float(w.get("cut_start", orig_s)), orig_s), 4)
            w["cut_end"] = round(min(orig_e, new_out), 4)

    c["in"] = round(new_in, 4)
    c["out"] = round(new_out, 4)
    clips[idx] = c
    meta["clips"] = clips
    meta["deleted"] = sorted(deleted)
    meta["needs_retranscribe"] = True
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/clips/delete")
def delete_clip(pid: str, body: ClipIdBody):
    meta = _load(pid)
    clips = _ensure_clips(meta)
    clip = next((c for c in clips if c["id"] == body.id), None)
    if not clip:
        raise HTTPException(404, "clip not found")
    _push_undo(meta)
    cin, cout = float(clip["in"]), float(clip["out"])
    deleted = set(meta.get("deleted") or [])
    for w in meta.get("words") or []:
        s, e = _word_span(w)
        if e > cin and s < cout:
            deleted.add(int(w["id"]))
    meta["deleted"] = sorted(deleted)
    meta["clips"] = [c for c in clips if c["id"] != body.id]
    meta["needs_retranscribe"] = True
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/retranscribe")
def retranscribe(pid: str):
    if not have_parakeet():
        raise HTTPException(500, "Parakeet v3 is not installed on this Mac")
    meta = _load(pid)
    dest = _proj_dir(pid)
    wav44 = Path(meta.get("wav44") or "")
    if not wav44.is_file():
        raise HTTPException(400, "no audio to re-transcribe")
    pcm, sr = _read_wav(wav44)
    ranges = _clip_ranges(meta)
    if not ranges:
        raise HTTPException(400, "nothing left to re-transcribe")
    out_pcm = render_keep_ranges(pcm, sr, ranges)
    _write_wav(wav44, out_pcm, sr)
    wav16 = dest / "audio.16k.wav"
    to_wav(wav44, wav16, 16000)
    asr = transcribe_wav(wav16)
    words = refine_words(asr.get("words") or [], out_pcm, sr)
    duration = round(len(out_pcm) / float(sr), 3)
    meta["words"] = words
    meta["deleted"] = []
    meta["duration"] = duration
    meta["peaks"] = waveform_peaks(out_pcm, 1600)
    meta["model"] = asr.get("model")
    meta["clips"] = [
        {
            "id": _new_clip_id(),
            "in": 0.0,
            "out": duration,
            "origin_in": 0.0,
            "origin_out": duration,
        }
    ] if duration > 0.02 else []
    meta["needs_retranscribe"] = False
    meta["undo"] = []
    meta["redo"] = []
    meta.setdefault("messages", []).append({
        "role": "assistant",
        "text": f"Re-transcribed {len(words)} words from the current timeline.",
    })
    _save(meta)
    return _public(meta)


@app.post("/api/projects/{pid}/duplicate_clip")
def duplicate_clip(pid: str, body: DuplicateBody):
    meta = _load(pid)
    words = meta.get("words") or []
    by_id = {int(w["id"]): w for w in words}
    target_words = [by_id[int(i)] for i in body.ids if int(i) in by_id]
    if not target_words:
        raise HTTPException(400, "no words to duplicate")

    max_id = max((int(w["id"]) for w in words), default=0)
    new_words = []
    for i, w in enumerate(target_words):
        nw = dict(w)
        nw["id"] = max_id + 1 + i
        new_words.append(nw)

    last_idx = max(i for i, w in enumerate(words) if int(w["id"]) in set(body.ids))
    words[last_idx + 1 : last_idx + 1] = new_words

    meta.setdefault("undo", []).append({
        "deleted": list(meta.get("deleted") or []),
        "words": copy.deepcopy(words),
    })
    meta["redo"] = []
    meta["words"] = words
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
        _push_undo(meta)
        _delete_word_ids(meta, new_ids)
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
    ranges = _clip_ranges(meta) or keep_ranges(meta["words"], meta.get("deleted") or [])
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
