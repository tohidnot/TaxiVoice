"""Local edit agent: turn a chat request into word deletions."""

from __future__ import annotations

import re

FILLERS = {"uh", "um", "er", "ah", "hmm", "huh", "mm", "mmm", "uhh", "umm"}
DISCOURSE_LIKE = True


def _norm(w: str) -> str:
    return re.sub(r"[^\w']+", "", w).lower()


def suggest_cleanup(words: list[dict]) -> list[int]:
    ids: set[int] = set()
    norms = [_norm(w["word"]) for w in words]
    for i, n in enumerate(norms):
        if n in FILLERS:
            ids.add(int(words[i]["id"]))
        if n == "like":
            ids.add(int(words[i]["id"]))
        if i and n == "know" and norms[i - 1] == "you":
            ids.add(int(words[i - 1]["id"]))
            ids.add(int(words[i]["id"]))
        if i and n == "mean" and norms[i - 1] == "i":
            ids.add(int(words[i - 1]["id"]))
            ids.add(int(words[i]["id"]))
        if i and n and n == norms[i - 1]:
            ids.add(int(words[i]["id"]))
        # "I think I think" / "the uh the" style 2-grams
        if i + 3 < len(norms) and (norms[i], norms[i + 1]) == (norms[i + 2], norms[i + 3]) and norms[i]:
            ids.add(int(words[i + 2]["id"]))
            ids.add(int(words[i + 3]["id"]))

    # After dropping fillers, collapse leftover duplicates in the remaining stream
    # e.g. "the uh the" → delete uh → "the the" → drop the second the.
    remaining = [w for w in words if int(w["id"]) not in ids]
    prev_n = None
    for w in remaining:
        n = _norm(w["word"])
        if n and n == prev_n:
            ids.add(int(w["id"]))
        else:
            prev_n = n

    if remaining:
        first = _norm(remaining[0]["word"])
        if first in {"so", "well", "okay", "ok"}:
            ids.add(int(remaining[0]["id"]))
    return sorted(ids)


def plan(message: str, words: list[dict], already_deleted: set[int]) -> dict:
    text = (message or "").strip()
    low = text.lower()
    active = [w for w in words if int(w["id"]) not in already_deleted]

    if not text:
        return {
            "reply": "Tell me what to cut — fillers, repeats, or a specific word.",
            "delete_ids": [],
        }

    # "delete/remove the word X"
    m = re.search(r"(?:delete|remove|cut)\s+(?:the\s+)?(?:word\s+)?[\"']?([a-zA-Z']+)[\"']?", low)
    targeted: list[int] = []
    if m and not any(k in low for k in ("filler", "repeat", "false start", "noise", "clean", "edit")):
        needle = _norm(m.group(1))
        targeted = [int(w["id"]) for w in active if _norm(w["word"]) == needle]

    cleanup = any(
        k in low
        for k in (
            "filler",
            "false start",
            "repeat",
            "ums",
            "uhs",
            "clean",
            "edit the audio",
            "edit this",
            "remove any",
            "cut the fat",
            "tighten",
        )
    )

    delete_ids: list[int] = []
    if targeted:
        delete_ids = targeted
        reply = f"Removed {len(delete_ids)} instance(s) of “{m.group(1)}”."
    elif cleanup or "edit" in low or "ready" in low or "go ahead" in low:
        delete_ids = [i for i in suggest_cleanup(active) if i not in already_deleted]
        if delete_ids:
            labels = []
            by_id = {int(w["id"]): w["word"] for w in words}
            for i in delete_ids:
                labels.append(by_id.get(i, "?"))
            shown = ", ".join(labels[:8])
            extra = f" and {len(labels) - 8} more" if len(labels) > 8 else ""
            reply = (
                "Your audio is ready. I removed fillers, false starts, and repeats "
                f"({shown}{extra}). Review the remaining words, then hit play."
            )
        else:
            reply = "I didn't find fillers or repeats left to cut. Delete any word chip with ×."
    else:
        reply = (
            "I can remove fillers, repeats, and false starts, or delete a specific word. "
            "Try “remove fillers” or click × on a word."
        )

    return {"reply": reply, "delete_ids": delete_ids}
