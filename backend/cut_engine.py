"""Energy-refined word bounds and click-free keep-range rendering.

TDT / Parakeet timestamps are on an 80 ms grid. Empirically, on real speech:

* word START is late (onset, especially fricatives, lives 20–120 ms earlier)
* word END is closer, but adjacent words often share the same frame
* the leftover "pre/post syllable" you hear after a cut is that late-start
  bleed: the deleted word's onset still sits in the previous word's window

Fix that is file-agnostic:

1. Split every adjacent pair at the energy valley between them.
2. Pull each keep-word end back to that valley (drops the next word's onset).
3. Push each keep-word start forward to its own energy rise.
4. Snap joins to zero-crossings and apply a short equal-power fade.
"""

from __future__ import annotations

import math
from typing import Iterable

import numpy as np


HOP_S = 0.002
WIN_S = 0.010
FADE_S = 0.010
GUARD_S = 0.012


def _rms_envelope(pcm: np.ndarray, sr: int) -> tuple[np.ndarray, int]:
    hop = max(1, int(sr * HOP_S))
    win = max(hop, int(sr * WIN_S))
    if len(pcm) < win:
        return np.array([float(np.sqrt(np.mean(pcm * pcm) + 1e-12))], dtype=np.float64), hop
    n = 1 + (len(pcm) - win) // hop
    # strided windows
    shape = (n, win)
    strides = (pcm.strides[0] * hop, pcm.strides[0])
    frames = np.lib.stride_tricks.as_strided(pcm, shape=shape, strides=strides)
    rms = np.sqrt(np.mean(frames * frames, axis=1) + 1e-12)
    return rms.astype(np.float64), hop


def _thr(rms: np.ndarray) -> float:
    noise = float(np.percentile(rms, 12))
    med = float(np.median(rms))
    return max(noise * 6.0, med * 0.18, 0.006)


def _t2i(t: float, hop: int, sr: int, n: int) -> int:
    return int(np.clip(round(t * sr / hop), 0, max(0, n - 1)))


def _i2t(i: int, hop: int, sr: int) -> float:
    return i * hop / sr


def _argmin_t(rms: np.ndarray, hop: int, sr: int, t0: float, t1: float) -> float:
    n = len(rms)
    i0, i1 = _t2i(t0, hop, sr, n), _t2i(t1, hop, sr, n)
    if i1 <= i0:
        return (t0 + t1) / 2.0
    sl = rms[i0 : i1 + 1]
    if sl.size == 0:
        return (t0 + t1) / 2.0
    return _i2t(i0 + int(np.argmin(sl)), hop, sr)


def _onset_t(rms: np.ndarray, hop: int, sr: int, t0: float, t1: float, thr: float) -> float:
    n = len(rms)
    i0, i1 = _t2i(t0, hop, sr, n), _t2i(t1, hop, sr, n)
    sl = rms[i0 : i1 + 1]
    if sl.size == 0:
        return t0
    need = max(3, int(0.012 / HOP_S))
    for k in range(0, max(0, len(sl) - need + 1)):
        if sl[k] >= thr and np.mean(sl[k : k + need]) >= thr:
            return _i2t(i0 + k, hop, sr)
    above = np.where(sl >= thr)[0]
    if len(above):
        return _i2t(i0 + int(above[0]), hop, sr)
    return t0


def _offset_t(rms: np.ndarray, hop: int, sr: int, t0: float, t1: float, thr: float) -> float:
    n = len(rms)
    i0, i1 = _t2i(t0, hop, sr, n), _t2i(t1, hop, sr, n)
    sl = rms[i0 : i1 + 1]
    if sl.size == 0:
        return t1
    need = max(3, int(0.012 / HOP_S))
    last = None
    for k in range(0, max(0, len(sl) - need + 1)):
        if sl[k] >= thr and np.mean(sl[k : k + need]) >= thr:
            last = k + need
    if last is None:
        above = np.where(sl >= thr)[0]
        last = int(above[-1]) + 1 if len(above) else 0
    return _i2t(i0 + last, hop, sr)


def _peak_in(rms: np.ndarray, hop: int, sr: int, t0: float, t1: float) -> float:
    n = len(rms)
    i0, i1 = _t2i(t0, hop, sr, n), _t2i(t1, hop, sr, n)
    sl = rms[i0 : i1 + 1]
    return float(np.max(sl)) if len(sl) else 0.0


def refine_words(words: list[dict], pcm: np.ndarray, sr: int) -> list[dict]:
    """Return copies with cut_start / cut_end snapped to energy valleys."""
    if not words:
        return []
    dur = len(pcm) / float(sr)
    rms, hop = _rms_envelope(pcm, sr)
    thr = _thr(rms)
    n = len(words)
    out = [dict(w) for w in words]

    # Pass 1: valley between every adjacent pair — shared, exclusive boundary.
    splits = [0.0]
    for i in range(n - 1):
        a, b = out[i], out[i + 1]
        # Search around the shared ASR boundary. Include a bit of each word
        # so a late start still has a valley to the left of the ASR stamp.
        lo = max(0.0, min(a["end"], b["start"]) - 0.080)
        hi = min(dur, max(a["end"], b["start"]) + 0.080)
        # Don't walk into the previous / next pair.
        if i:
            lo = max(lo, float(out[i - 1]["end"]))
        if i + 2 < n:
            hi = min(hi, float(out[i + 2]["start"]))
        if hi <= lo + 0.004:
            splits.append((float(a["end"]) + float(b["start"])) / 2.0)
        else:
            splits.append(_argmin_t(rms, hop, sr, lo, hi))
    splits.append(dur)

    # Pass 2: onset / offset inside each [split_i, split_{i+1}] window.
    for i, w in enumerate(out):
        left, right = splits[i], splits[i + 1]
        asr_s, asr_e = float(w["start"]), float(w["end"])
        peak = _peak_in(rms, hop, sr, asr_s, asr_e)
        local_thr = max(thr, peak * 0.22)

        on = _onset_t(rms, hop, sr, left, min(right, asr_s + 0.060), local_thr)
        # Keep a few ms of attack, but never cross the valley into the previous word.
        cut_s = max(left, on - 0.008)

        off = _offset_t(rms, hop, sr, max(left, asr_e - 0.060), right, local_thr)
        cut_e = min(right, off + 0.006)

        # If the word is attached to the next one, prefer the valley (right)
        # over a late offset that would leak the next onset.
        if i + 1 < n and float(out[i + 1]["start"]) - asr_e < 0.050:
            cut_e = min(cut_e, right)

        if cut_e <= cut_s + 0.025:
            cut_s, cut_e = max(left, asr_s - 0.010), min(right, asr_e)

        w["cut_start"] = round(float(cut_s), 4)
        w["cut_end"] = round(float(cut_e), 4)
        w["split_left"] = round(float(left), 4)
        w["split_right"] = round(float(right), 4)

    # Guarantee monotonic exclusive ranges.
    for i in range(n - 1):
        mid = min(out[i]["cut_end"], out[i + 1]["cut_start"])
        mid = max(mid, out[i]["cut_start"] + 0.02)
        out[i]["cut_end"] = round(float(mid), 4)
        out[i + 1]["cut_start"] = round(float(mid), 4)

    return out


def keep_ranges(words: list[dict], deleted: Iterable[int]) -> list[tuple[float, float]]:
    """Contiguous kept [start, end) ranges using refined cut_* bounds."""
    gone = set(int(i) for i in deleted)
    ranges: list[tuple[float, float]] = []
    cur: tuple[float, float] | None = None
    for i, w in enumerate(words):
        if i in gone:
            if cur:
                ranges.append(cur)
                cur = None
            continue
        s = float(w.get("cut_start", w["start"]))
        e = float(w.get("cut_end", w["end"]))
        if cur is None:
            cur = (s, e)
        else:
            cur = (cur[0], e)
    if cur:
        ranges.append(cur)
    return [(round(a, 4), round(b, 4)) for a, b in ranges if b - a > 0.02]


def _nearest_zero(pcm: np.ndarray, idx: int, sr: int, window_s: float = 0.004) -> int:
    span = max(2, int(sr * window_s))
    lo = max(1, idx - span)
    hi = min(len(pcm) - 1, idx + span)
    sl = pcm[lo:hi]
    if len(sl) < 3:
        return int(np.clip(idx, 0, len(pcm) - 1))
    sign = np.signbit(sl)
    changes = np.where(np.diff(sign.astype(np.int8)))[0]
    if len(changes) == 0:
        return int(np.clip(idx, 0, len(pcm) - 1))
    target = idx - lo
    best = changes[np.argmin(np.abs(changes - target))]
    return int(lo + best)


def render_keep_ranges(
    pcm: np.ndarray,
    sr: int,
    ranges: list[tuple[float, float]],
    fade_s: float = FADE_S,
) -> np.ndarray:
    """Concatenate keep ranges with zero-crossing snaps and equal-power fades."""
    if not ranges:
        return np.zeros(int(sr * 0.1), dtype=np.float32)

    fade_n = max(8, int(sr * fade_s))
    pieces: list[np.ndarray] = []
    for a, b in ranges:
        i0 = _nearest_zero(pcm, int(a * sr), sr)
        i1 = _nearest_zero(pcm, int(b * sr), sr)
        if i1 <= i0 + fade_n:
            continue
        pieces.append(pcm[i0:i1].astype(np.float32, copy=True))

    if not pieces:
        return np.zeros(int(sr * 0.1), dtype=np.float32)

    out = pieces[0]
    fo = np.sqrt(np.linspace(1.0, 0.0, fade_n, dtype=np.float32))
    fi = np.sqrt(np.linspace(0.0, 1.0, fade_n, dtype=np.float32))
    for p in pieces[1:]:
        n = min(fade_n, len(out) // 4, len(p) // 4)
        if n < 8:
            out = np.concatenate([out, p])
            continue
        mid = out[-n:] * fo[-n:] + p[:n] * fi[-n:]
        out = np.concatenate([out[:-n], mid, p[n:]])

    edge = max(4, int(sr * 0.004))
    if len(out) > edge * 2:
        out[:edge] *= np.linspace(0.0, 1.0, edge, dtype=np.float32)
        out[-edge:] *= np.linspace(1.0, 0.0, edge, dtype=np.float32)

    peak = float(np.max(np.abs(out))) if len(out) else 0.0
    if peak > 0.99:
        out = out * (0.99 / peak)
    return out.astype(np.float32)


def waveform_peaks(pcm: np.ndarray, buckets: int = 1400) -> list[float]:
    if len(pcm) == 0:
        return [0.0] * buckets
    n = len(pcm)
    step = max(1, n // buckets)
    peaks = []
    for i in range(0, n, step):
        sl = pcm[i : i + step]
        peaks.append(float(np.max(np.abs(sl))))
        if len(peaks) >= buckets:
            break
    while len(peaks) < buckets:
        peaks.append(0.0)
    m = max(peaks) or 1.0
    return [round(p / m, 4) for p in peaks]


def float_to_pcm16(pcm: np.ndarray) -> bytes:
    x = np.clip(pcm * 32767.0, -32768, 32767).astype(np.int16)
    return x.tobytes()
