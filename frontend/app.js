const $ = (id) => document.getElementById(id);

const state = {
  project: null,
  playing: false,
  editedTime: 0,
  raf: 0,
  zoomLevel: 1.0,
  selectedClipId: null,
  clips: [],
  retranscribeDismissed: false,
  clipboard: null,
};

const chatEl = $("chat");
const wordsEl = $("words");
const fileEl = $("file");
const audioEl = $("audio");
const videoEl = $("video");

function fmt(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function keepWords() {
  return (state.project?.words || []).filter((w) => !w.deleted);
}

function keepRanges() {
  const clips = state.project?.clips;
  if (Array.isArray(clips) && clips.length) {
    return clips
      .map((c) => [Number(c.in), Number(c.out)])
      .filter(([a, b]) => b - a > 0.02);
  }
  const words = keepWords();
  const ranges = [];
  let cur = null;
  for (const w of words) {
    const s = w.cut_start ?? w.start;
    const e = w.cut_end ?? w.end;
    if (!cur) cur = [s, e];
    else if (Math.abs(s - cur[1]) < 0.02) cur[1] = e;
    else {
      ranges.push(cur);
      cur = [s, e];
    }
  }
  if (cur) ranges.push(cur);
  return ranges;
}

function editedDuration() {
  return keepRanges().reduce((n, [a, b]) => n + (b - a), 0);
}

function sourceDuration() {
  return Math.max(0, Number(state.project?.duration) || 0);
}

function viewDuration() {
  const d = editedDuration();
  if (d <= 0) return 20;
  return d + Math.max(8, Math.min(28, d * 0.45));
}

function editedToSource(t) {
  let left = Math.max(0, t);
  for (const [a, b] of keepRanges()) {
    const span = b - a;
    if (left <= span) return a + left;
    left -= span;
  }
  const last = keepRanges().at(-1);
  return last ? last[1] : 0;
}

function sourceToEdited(src) {
  let acc = 0;
  for (const [a, b] of keepRanges()) {
    if (src < a) return acc;
    if (src <= b) return acc + (src - a);
    acc += b - a;
  }
  return acc;
}

function mediaEl() {
  return audioEl;
}

function renderChat() {
  const msgs = state.project?.messages || [
    {
      role: "assistant",
      text: "Drop an audio or video file and I’ll transcribe it into words you can edit.",
    },
  ];
  chatEl.innerHTML = msgs
    .map((m) => {
      const kind = m.role === "user" ? "user" : "assistant";
      return `<article class="msg ${kind}"><p>${escapeHtml(m.text)}</p></article>`;
    })
    .join("");
  requestAnimationFrame(() => {
    chatEl.scrollTop = chatEl.scrollHeight;
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function hasWords() {
  return Array.isArray(state.project?.words) && state.project.words.length > 0;
}

function setStageMode(mode) {
  $("dropzone").hidden = mode !== "empty";
  $("loading").hidden = mode !== "loading";
  $("stage-row").hidden = mode !== "ready";
  $("stage").classList.toggle("empty", mode !== "ready");
  document.querySelectorAll(".editor-only").forEach((el) => {
    el.hidden = mode !== "ready";
  });
}

function wordsForChips() {
  const p = state.project;
  const words = Array.isArray(p?.words) ? p.words : [];
  const kept = words.filter((w) => !w.deleted);
  const clips = Array.isArray(p?.clips) ? p.clips : [];
  if (!clips.length) return kept;
  const ordered = [];
  const seen = new Set();
  for (const c of clips) {
    const a = Number(c.in);
    const b = Number(c.out);
    for (const w of kept) {
      if (seen.has(w.id)) continue;
      const s = w.cut_start ?? w.start;
      const e = w.cut_end ?? w.end;
      if (e > a && s < b) {
        ordered.push(w);
        seen.add(w.id);
      }
    }
  }
  for (const w of kept) {
    if (!seen.has(w.id)) ordered.push(w);
  }
  return ordered;
}

function renderWords() {
  const p = state.project;
  const words = Array.isArray(p?.words) ? p.words : [];
  if (!words.length) {
    $("btn-play-inline").hidden = true;
    wordsEl.innerHTML = "";
    return;
  }
  const visible = wordsForChips();
  wordsEl.className = "words";
  wordsEl.innerHTML = visible
    .map(
      (w) =>
        `<button type="button" class="chip" data-id="${w.id}"><span>${escapeHtml(w.word)}</span><span class="x" data-del="${w.id}" title="Delete word">×</span></button>`
    )
    .join("");
  $("btn-play-inline").hidden = false;
}

function wordsInSpan(start, end) {
  const words = Array.isArray(state.project?.words) ? state.project.words : [];
  return words.filter((w) => {
    if (w.deleted) return false;
    const s = w.cut_start ?? w.start;
    const e = w.cut_end ?? w.end;
    return e > start && s < end;
  });
}

function createClipObj(idx, raw) {
  const start = Number(raw.in ?? raw.start);
  const end = Number(raw.out ?? raw.end);
  const words = wordsInSpan(start, end);
  const text = words.map((w) => w.word).join(" ");
  return {
    idx,
    id: raw.id || `c${idx}`,
    wordIds: words.map((w) => w.id),
    start,
    end,
    originIn: 0,
    originOut: sourceDuration() || Number(raw.origin_out ?? end),
    duration: Math.max(0.01, end - start),
    text: text.length > 28 ? text.slice(0, 26) + "…" : text,
    words,
  };
}

function buildClips() {
  const p = state.project;
  if (Array.isArray(p?.clips) && p.clips.length) {
    state.clips = p.clips.map((c, i) => createClipObj(i, c));
    return state.clips;
  }

  const words = Array.isArray(p?.words) ? p.words : [];
  if (!words.length) {
    state.clips = [];
    return [];
  }

  const clips = [];
  let curWords = [];
  let curStart = null;
  let curEnd = null;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.deleted) {
      if (curWords.length) {
        clips.push(createClipObj(clips.length, { id: `c${clips.length}`, in: curStart, out: curEnd, origin_in: curStart, origin_out: curEnd }));
        curWords = [];
        curStart = null;
        curEnd = null;
      }
      continue;
    }
    const s = w.cut_start ?? w.start;
    const e = w.cut_end ?? w.end;
    if (!curWords.length) {
      curWords = [w];
      curStart = s;
      curEnd = e;
    } else if (Math.abs(s - curEnd) > 0.08) {
      clips.push(createClipObj(clips.length, { id: `c${clips.length}`, in: curStart, out: curEnd, origin_in: curStart, origin_out: curEnd }));
      curWords = [w];
      curStart = s;
      curEnd = e;
    } else {
      curWords.push(w);
      curEnd = e;
    }
  }
  if (curWords.length) {
    clips.push(createClipObj(clips.length, { id: `c${clips.length}`, in: curStart, out: curEnd, origin_in: curStart, origin_out: curEnd }));
  }
  state.clips = clips;
  return clips;
}

function getTimelineWidth() {
  const wrap = $("timeline-scroll-wrap");
  const baseW = wrap ? wrap.clientWidth : 800;
  return Math.max(baseW, baseW * state.zoomLevel);
}

function updateHistoryButtons() {
  const canUndo = Boolean(state.project?.can_undo);
  const canRedo = Boolean(state.project?.can_redo);
  ["btn-undo", "btn-undo-tl"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !canUndo;
  });
  ["btn-redo", "btn-redo-tl"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = !canRedo;
  });
}

function renderMeta() {
  const p = state.project;
  $("project-name").textContent = p?.name || "Untitled";
  updateHistoryButtons();
  const videoMode = p?.kind === "video";
  $("video-pane").hidden = !videoMode;
  document.querySelector(".stage-row").classList.toggle("has-video", videoMode);
  $("filmstrip-wrap").hidden = !videoMode;
  if (videoMode) renderFilmstrip();
  renderRuler();
  renderClips();
}

function niceTimeStep(pxPerSec) {
  const raw = 72 / Math.max(1, pxPerSec);
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((s) => s >= raw) || 300;
}

function renderRuler() {
  const dur = state.project ? viewDuration() : 20;
  const w = getTimelineWidth();
  const content = $("timeline-content");
  if (content) {
    content.style.width = `${w}px`;
    content.classList.toggle("has-filmstrip", state.project?.kind === "video");
  }

  const pps = w / Math.max(0.01, dur);
  const major = niceTimeStep(pps);
  const minor = major >= 2 ? major / 2 : major / 5;
  const ticks = [];
  const limit = dur + 0.001;
  for (let t = 0, i = 0; t <= limit; t = Math.round((t + minor) * 1000) / 1000, i++) {
    const x = (t / dur) * w;
    const isMajor = Math.abs((t / major) - Math.round(t / major)) < 0.02;
    const label = isMajor ? `<span>${fmt(t)}</span>` : "";
    ticks.push(
      `<div class="tick${isMajor ? " major" : ""}${t === 0 ? " origin" : ""}" style="left:${x.toFixed(1)}px">${label}</div>`
    );
    if (i > 400) break;
  }
  $("ruler").innerHTML = ticks.join("");
}

function renderFilmstrip() {
  const p = state.project;
  $("filmstrip").innerHTML = (p?.thumbs || [])
    .map((src) => `<img src="${src}" alt="" />`)
    .join("");
}

function renderClips() {
  const container = $("timeline-clips");
  if (!container) return;
  const clips = buildClips();
  const edited = editedDuration();
  const dur = viewDuration();
  const timelineW = getTimelineWidth();
  const gap = 3;
  let accEdited = 0;

  if (state.selectedClipId && !clips.some((c) => c.id === state.selectedClipId)) {
    state.selectedClipId = null;
  }

  const html = clips.map((c, i) => {
    const leftPx = (accEdited / dur) * timelineW;
    const widthPx = Math.max(36, (c.duration / dur) * timelineW - gap);
    accEdited += c.duration;
    const isSelected = state.selectedClipId === c.id;

    return `
      <div class="timeline-clip ${isSelected ? "selected" : ""}"
           data-clip-id="${c.id}"
           data-clip-idx="${i}"
           style="left: ${leftPx.toFixed(1)}px; width: ${widthPx.toFixed(1)}px;">
        <div class="clip-trim-handle left" data-clip-id="${c.id}" data-side="left" title="Trim start">
          <span class="grip"></span>
        </div>
        <div class="clip-wave-wrap">
          <canvas class="clip-wave-canvas" data-canvas-clip="${i}"></canvas>
        </div>
        <div class="clip-trim-handle right" data-clip-id="${c.id}" data-side="right" title="Trim end">
          <span class="grip"></span>
        </div>
      </div>
    `;
  }).join("");

  const plusLeft = ((edited > 0 ? edited : 0) / dur) * timelineW + (clips.length ? 8 : 12);
  container.innerHTML = html + `
    <button type="button" class="clip-add-end" title="Add clip" style="left:${plusLeft.toFixed(1)}px">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>`;
  drawClipWaveforms();
  updateClipButtons();
}

function drawClipWaveforms() {
  const peaks = state.project?.peaks || [];
  const totalDur = state.project?.duration || 1;
  const dpr = window.devicePixelRatio || 1;

  document.querySelectorAll(".clip-wave-canvas").forEach((canvas) => {
    const clipIdx = Number(canvas.dataset.canvasClip);
    const clip = state.clips[clipIdx];
    if (!clip) return;

    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w < 4 || h < 4) return;

    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    const cctx = canvas.getContext("2d");
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, w, h);

    const selected = state.selectedClipId === clip.id;
    cctx.fillStyle = selected ? "#6d6d75" : "#9a9aa2";
    const mid = h / 2;

    if (!peaks.length) {
      cctx.fillRect(0, mid - 1, w, 2);
      return;
    }

    const i0 = Math.floor((clip.start / totalDur) * peaks.length);
    const i1 = Math.ceil((clip.end / totalDur) * peaks.length);
    const clipPeaks = peaks.slice(i0, Math.max(i0 + 1, i1));
    const n = clipPeaks.length;
    const bar = 2;
    const stride = 3;

    for (let x = 0; x < w; x += stride) {
      const idx = Math.min(n - 1, Math.floor((x / w) * n));
      const amp = Math.max(1.2, (clipPeaks[idx] || 0) * (h * 0.4));
      cctx.fillRect(x, mid - amp, bar, amp * 2);
    }
  });
}

function updateClipSelection() {
  document.querySelectorAll(".timeline-clip").forEach((el) => {
    el.classList.toggle("selected", el.dataset.clipId === state.selectedClipId);
  });
  updateClipButtons();
}

function updateClipButtons() {
  const hasSelection = Boolean(state.selectedClipId && state.clips.some((c) => c.id === state.selectedClipId));
  const delBtn = $("btn-delete-clip");
  if (delBtn) delBtn.disabled = !hasSelection;
  const copyBtn = $("btn-copy-clip");
  if (copyBtn) copyBtn.disabled = !hasSelection;
  const pasteBtn = $("btn-paste-clip");
  if (pasteBtn) pasteBtn.disabled = !state.clipboard;
}

function updateRetranscribeBar() {
  const bar = $("retranscribe-bar");
  if (!bar) return;
  const dirty = Boolean(state.project?.needs_retranscribe) && !state.retranscribeDismissed;
  bar.hidden = !dirty;
}

function setPlayhead() {
  const edited = editedDuration() || 1;
  const view = viewDuration();
  const pct = Math.min(1, state.editedTime / view);
  const timelineW = getTimelineWidth();
  const phX = pct * timelineW;

  const ph = $("playhead");
  ph.hidden = !hasWords();
  ph.style.left = `${phX.toFixed(1)}px`;

  const timeStr = `${fmt(state.editedTime)} / ${fmt(edited)}`;
  const tTime = $("transport-time");
  if (tTime) tTime.textContent = timeStr;

  if (state.playing) {
    const wrap = $("timeline-scroll-wrap");
    if (wrap) {
      const scrollLeft = wrap.scrollLeft;
      const viewW = wrap.clientWidth;
      if (phX > scrollLeft + viewW - 40 || phX < scrollLeft) {
        wrap.scrollLeft = Math.max(0, phX - viewW / 2);
      }
    }
  }

  if (state.project?.kind === "video") {
    $("video-time").textContent = timeStr;
    const src = editedToSource(state.editedTime);
    const hit = keepWords().find((w) => {
      const s = Number(w.cut_start ?? w.start);
      const e = Number(w.cut_end ?? w.end);
      return src >= s && src < e;
    });
    $("caption").innerHTML = hit
      ? keepWords()
          .filter((w) => Math.abs((w.start + w.end) / 2 - src) < 1.6)
          .map((w) => (w.id === hit.id ? `<b>${escapeHtml(w.word)}</b>` : escapeHtml(w.word)))
          .join(" ")
      : "";
  }
}

function attachMedia(p, force = false) {
  if (!p?.id) return;
  const url = `/api/projects/${p.id}/audio`;
  if (force || !audioEl.src.includes(`${p.id}/audio`)) {
    audioEl.src = force ? `${url}?t=${Date.now()}` : url;
    audioEl.load();
  }
  if (p.kind === "video") videoEl.src = `/api/projects/${p.id}/media`;
}

function applyProject(p) {
  state.project = p;
  if (!p?.needs_retranscribe) state.retranscribeDismissed = false;
  if (hasWords()) setStageMode("ready");
  else if (!state.importing) setStageMode("empty");
  renderChat();
  renderWords();
  renderMeta();
  attachMedia(p);
  setPlayhead();
  updateRetranscribeBar();
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.detail || JSON.stringify(j);
    } catch {}
    throw new Error(msg);
  }
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) return res.json();
  return res;
}

async function importFile(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append("file", file);
  state.importing = true;
  pause();
  $("loading-name").textContent = file.name;
  setStageMode("loading");
  const pending = {
    ...(state.project || { words: [], messages: [] }),
    name: file.name.replace(/\.[^.]+$/, ""),
    messages: [
      ...((state.project && state.project.messages) || []),
      { role: "user", text: `Import ${file.name}` },
      { role: "assistant", text: "Transcribing with Parakeet v3. This takes a few seconds on first load…" },
    ],
  };
  if (!Array.isArray(pending.words)) pending.words = [];
  state.project = pending;
  renderChat();
  $("project-name").textContent = pending.name;
  try {
    if (state.project?.id && !hasWords()) {
      fd.append("session_id", state.project.id);
    }
    const p = await api("/api/projects/import", { method: "POST", body: fd });
    state.editedTime = 0;
    state.importing = false;
    applyProject(p);
  } catch (err) {
    state.importing = false;
    pending.messages.push({ role: "assistant", text: `Could not import: ${err.message}` });
    applyProject({ ...pending, words: pending.words || [] });
    setStageMode("empty");
  }
}

async function deleteIds(ids) {
  if (!state.project || !ids.length) return;
  applyProject(await api(`/api/projects/${state.project.id}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  }));
}

async function sendChat(text) {
  if (!text.trim()) return;
  if (!state.project?.id) {
    state.project = await api("/api/projects", { method: "POST" });
  }
  if (state.project) {
    if (!Array.isArray(state.project.messages)) state.project.messages = [];
    state.project.messages.push({ role: "user", text });
    renderChat();
  }
  try {
    const updated = await api(`/api/projects/${state.project.id}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    applyProject(updated);
  } catch (err) {
    console.error(err);
    renderChat();
  }
}

function tick() {
  if (!state.playing) return;
  const media = mediaEl();
  const src = media.currentTime;
  const ranges = keepRanges();
  const inside = ranges.find(([a, b]) => src >= a - 0.01 && src < b);
  if (!inside) {
    const next = ranges.find(([a]) => a > src);
    if (next) media.currentTime = next[0] + 0.001;
    else {
      pause();
      state.editedTime = editedDuration();
      setPlayhead();
      return;
    }
  }
  state.editedTime = sourceToEdited(media.currentTime);
  setPlayhead();
  highlightWord(media.currentTime);
  state.raf = requestAnimationFrame(tick);
}

function highlightWord(src) {
  const t = Number(src);
  let hitId = null;
  if (Number.isFinite(t)) {
    for (const w of keepWords()) {
      const s = Number(w.cut_start ?? w.start);
      const e = Number(w.cut_end ?? w.end);
      if (t >= s && t < e) {
        hitId = Number(w.id);
        break;
      }
    }
  }
  for (const el of wordsEl.querySelectorAll(".chip")) {
    el.classList.toggle("active", hitId !== null && Number(el.dataset.id) === hitId);
  }
}

function setPlayingUi(on) {
  const isPlaying = Boolean(on);
  state.playing = isPlaying;

  const btnPlay = $("btn-play");
  if (btnPlay) {
    btnPlay.classList.toggle("is-playing", isPlaying);
    btnPlay.title = isPlaying ? "Pause" : "Play";
  }

  const btnPlayInline = $("btn-play-inline");
  if (btnPlayInline) {
    btnPlayInline.classList.toggle("is-playing", isPlaying);
    btnPlayInline.title = isPlaying ? "Pause" : "Play";
  }

  const btnVideoPlay = $("btn-video-play");
  if (btnVideoPlay) {
    btnVideoPlay.classList.toggle("is-playing", isPlaying);
    btnVideoPlay.title = isPlaying ? "Pause" : "Play";
  }
}

function play(fromStart = false) {
  if (!hasWords()) return;
  attachMedia(state.project);
  const dur = editedDuration();
  if (fromStart || (dur > 0 && state.editedTime >= dur - 0.02)) {
    state.editedTime = 0;
  }
  const media = mediaEl();
  try {
    media.currentTime = editedToSource(state.editedTime);
  } catch {}
  if (state.project?.kind === "video" && videoEl.src) {
    try {
      videoEl.currentTime = editedToSource(state.editedTime);
      videoEl.play().catch(() => {});
    } catch {}
  }
  const kick = media.play();
  state.playing = true;
  setPlayingUi(true);
  cancelAnimationFrame(state.raf);
  tick();
  if (kick && kick.catch) {
    kick.catch(() => pause());
  }
}

function pause() {
  state.playing = false;
  try { audioEl.pause(); } catch {}
  try { videoEl.pause(); } catch {}
  setPlayingUi(false);
  cancelAnimationFrame(state.raf);
  if (state.editedTime >= editedDuration() - 0.05) {
    highlightWord(-1);
  }
}

function seekEdited(t) {
  state.editedTime = Math.max(0, Math.min(editedDuration(), t));
  const media = mediaEl();
  if (media.src) media.currentTime = editedToSource(state.editedTime);
  setPlayhead();
  highlightWord(editedToSource(state.editedTime));
}

function pickFile() {
  fileEl.value = "";
  fileEl.click();
}
$("btn-import").onclick = pickFile;
$("btn-upload-main").onclick = pickFile;
fileEl.onchange = () => {
  const f = fileEl.files?.[0];
  if (f) importFile(f);
};

$("composer").onsubmit = (e) => {
  e.preventDefault();
  const text = $("prompt").value;
  $("prompt").value = "";
  $("prompt").style.height = "auto";
  syncSend();
  sendChat(text);
};

$("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

wordsEl.addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    deleteIds([Number(del.dataset.del)]);
    return;
  }
  const chip = e.target.closest(".chip");
  if (!chip || !state.project) return;
  const w = state.project.words.find((x) => x.id === Number(chip.dataset.id));
  if (!w) return;
  seekEdited(sourceToEdited(w.start));
  play(false);
});

$("btn-play").onclick = () => (state.playing ? pause() : play(false));
$("btn-play-inline").onclick = () => {
  if (state.playing) {
    pause();
  } else {
    const atEnd = editedDuration() > 0 && state.editedTime >= editedDuration() - 0.05;
    play(atEnd);
  }
};
$("btn-video-play").onclick = () => (state.playing ? pause() : play(false));
$("btn-back").onclick = () => seekEdited(state.editedTime - 3);
$("btn-fwd").onclick = () => seekEdited(state.editedTime + 3);

async function doUndo() {
  if (!state.project?.id || !state.project.can_undo) return;
  pause();
  applyProject(await api(`/api/projects/${state.project.id}/undo`, { method: "POST" }));
}

async function doRedo() {
  if (!state.project?.id || !state.project.can_redo) return;
  pause();
  applyProject(await api(`/api/projects/${state.project.id}/redo`, { method: "POST" }));
}

$("btn-undo").onclick = () => doUndo();
$("btn-redo").onclick = () => doRedo();
$("btn-undo-tl").onclick = () => doUndo();
$("btn-redo-tl").onclick = () => doRedo();

$("btn-export").onclick = async () => {
  if (!state.project) return;
  document.body.classList.add("busy");
  try {
    const res = await fetch(`/api/projects/${state.project.id}/export`);
    if (!res.ok) throw new Error("export failed");
    const blob = await res.blob();
    const a = document.createElement("a");
    const ext = state.project.kind === "video" ? "mp4" : "mp3";
    a.href = URL.createObjectURL(blob);
    a.download = `${state.project.name}-edited.${ext}`;
    a.click();
  } catch (err) {
    alert(err.message);
  } finally {
    document.body.classList.remove("busy");
  }
};

$("btn-share").onclick = () => {
  const t = state.project?.text || "";
  navigator.clipboard?.writeText(t);
};

$("project-name").onclick = async () => {
  if (!state.project) return;
  const name = prompt("Project name", state.project.name);
  if (!name) return;
  applyProject(await api(`/api/projects/${state.project.id}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }));
};

async function splitAtPlayhead() {
  if (!state.project?.id || !hasWords()) return;
  const src = editedToSource(state.editedTime);
  try {
    const updated = await api(`/api/projects/${state.project.id}/split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time: src }),
    });
    applyProject(updated);
  } catch (err) {
    console.error("Split failed:", err);
  }
}

function copySelectedClip() {
  const clip = state.clips.find((c) => c.id === state.selectedClipId);
  if (!clip) return;
  state.clipboard = { in: clip.start, out: clip.end };
  updateClipButtons();
}

async function pasteClip() {
  if (!state.clipboard || !state.project?.id) return;
  try {
    const updated = await api(`/api/projects/${state.project.id}/clips/paste`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        in_point: state.clipboard.in,
        out_point: state.clipboard.out,
        after_id: state.selectedClipId,
      }),
    });
    const afterId = state.selectedClipId;
    const clips = updated.clips || [];
    if (afterId) {
      const idx = clips.findIndex((c) => c.id === afterId);
      state.selectedClipId = idx >= 0 && clips[idx + 1] ? clips[idx + 1].id : clips.at(-1)?.id;
    } else {
      state.selectedClipId = clips.at(-1)?.id || null;
    }
    state.retranscribeDismissed = false;
    applyProject(updated);
  } catch (err) {
    console.error("Paste failed:", err);
  }
}

async function deleteSelectedClip() {
  if (!state.selectedClipId || !state.project) return;
  const clip = state.clips.find((c) => c.id === state.selectedClipId);
  if (!clip) return;
  try {
    const updated = await api(`/api/projects/${state.project.id}/clips/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: clip.id }),
    });
    state.selectedClipId = null;
    state.retranscribeDismissed = false;
    applyProject(updated);
  } catch (err) {
    console.error("Delete clip failed:", err);
  }
}

async function reorderClips(fromIdx, toIdx) {
  if (fromIdx === toIdx || !state.project || !state.clips.length) return;
  const newClips = [...state.clips];
  const [moved] = newClips.splice(fromIdx, 1);
  newClips.splice(toIdx, 0, moved);
  try {
    const updated = await api(`/api/projects/${state.project.id}/reorder_clips`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clip_ids: newClips.map((c) => c.id) }),
    });
    state.selectedClipId = moved.id;
    state.retranscribeDismissed = false;
    applyProject(updated);
  } catch (err) {
    console.error("Reorder failed:", err);
    renderClips();
  }
}

async function commitTrim(clip, inPoint, outPoint) {
  if (!state.project?.id || !clip) return;
  try {
    const updated = await api(`/api/projects/${state.project.id}/clips/trim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: clip.id,
        in_point: inPoint,
        out_point: outPoint,
      }),
    });
    state.selectedClipId = clip.id;
    state.retranscribeDismissed = false;
    applyProject(updated);
  } catch (err) {
    console.error("Trim failed:", err);
    renderClips();
  }
}

function calculateNewClipIndex(origIdx, deltaSec) {
  if (!state.clips.length) return origIdx;
  const dur = editedDuration();
  if (dur <= 0) return origIdx;
  
  let targetTime = 0;
  for (let i = 0; i < origIdx; i++) {
    targetTime += state.clips[i].duration;
  }
  targetTime += state.clips[origIdx].duration / 2 + deltaSec;

  let acc = 0;
  for (let i = 0; i < state.clips.length; i++) {
    const nextAcc = acc + state.clips[i].duration;
    if (targetTime <= nextAcc) {
      return i;
    }
    acc = nextAcc;
  }
  return state.clips.length - 1;
}

function setZoom(val) {
  state.zoomLevel = Math.max(1, Math.min(8, Number(val)));
  const slider = $("zoom-slider");
  if (slider) slider.value = state.zoomLevel;
  renderRuler();
  renderClips();
  setPlayhead();
}

function layoutClipsLive(clipsLayout) {
  const timelineW = getTimelineWidth();
  const baseDur = Math.max(0.01, viewDuration());
  const pps = timelineW / baseDur;
  const gap = 3;
  let acc = 0;
  document.querySelectorAll(".timeline-clip").forEach((el) => {
    const clip = clipsLayout.find((c) => c.id === el.dataset.clipId);
    if (!clip) return;
    const widthPx = Math.max(36, (clip.end - clip.start) * pps - gap);
    const leftPx = acc * pps;
    el.style.left = `${leftPx.toFixed(1)}px`;
    el.style.width = `${widthPx.toFixed(1)}px`;
    acc += Math.max(0.01, clip.end - clip.start);
  });
  const content = $("timeline-content");
  if (content) content.style.width = `${Math.max(timelineW, acc * pps).toFixed(1)}px`;
  const plus = document.querySelector(".clip-add-end");
  if (plus) plus.style.left = `${(acc * pps + 8).toFixed(1)}px`;
}

function setupTimelineInteractions() {
  let dragging = null;

  function pointerTime(e) {
    const wrap = $("timeline-scroll-wrap");
    const wrapRect = wrap.getBoundingClientRect();
    const x = e.clientX - wrapRect.left + wrap.scrollLeft;
    const timelineW = getTimelineWidth();
    const pct = Math.max(0, Math.min(1, x / timelineW));
    return Math.min(editedDuration(), pct * viewDuration());
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (!state.project || !hasWords()) return;

    if (e.target.closest(".clip-add-end")) {
      e.stopPropagation();
      $("clip-file").click();
      return;
    }

    const trimHandle = e.target.closest(".clip-trim-handle");
    if (trimHandle) {
      e.stopPropagation();
      e.preventDefault();
      const clip = state.clips.find((c) => c.id === trimHandle.dataset.clipId);
      if (!clip) return;
      const clipEl = trimHandle.closest(".timeline-clip");
      state.selectedClipId = clip.id;
      updateClipSelection();
      trimHandle.classList.add("trimming");
      clipEl?.classList.add("trimming");
      dragging = {
        type: trimHandle.dataset.side === "left" ? "trim-left" : "trim-right",
        clip,
        handle: trimHandle,
        clipEl,
        startX: e.clientX,
        origIn: clip.start,
        origOut: clip.end,
        pps: Math.max(8, getTimelineWidth() / Math.max(0.05, viewDuration())),
        liveIn: clip.start,
        liveOut: clip.end,
      };
      return;
    }

    const clipEl = e.target.closest(".timeline-clip");
    if (clipEl) {
      e.stopPropagation();
      const clip = state.clips.find((c) => c.id === clipEl.dataset.clipId);
      if (!clip) return;
      state.selectedClipId = clip.id;
      updateClipSelection();
      dragging = {
        type: "clip-move",
        clipIdx: Number(clipEl.dataset.clipIdx),
        clip,
        clipEl,
        startX: e.clientX,
        moved: false,
      };
      return;
    }

    const container = e.target.closest(".timeline-container");
    if (container) {
      e.preventDefault();
      seekEdited(pointerTime(e));
      state.selectedClipId = null;
      updateClipSelection();
      dragging = { type: "playhead" };
    }
  }

  function onMouseMove(e) {
    if (!dragging || !state.project) return;

    if (dragging.type === "playhead") {
      seekEdited(pointerTime(e));
      return;
    }

    if (dragging.type === "clip-move") {
      const deltaX = e.clientX - dragging.startX;
      if (Math.abs(deltaX) > 4) {
        dragging.moved = true;
        dragging.clipEl.classList.add("dragging");
        dragging.clipEl.style.transform = `translateX(${deltaX}px)`;
      }
      return;
    }

    if (dragging.type === "trim-left" || dragging.type === "trim-right") {
      const deltaSec = (e.clientX - dragging.startX) / dragging.pps;
      const minLen = 0.08;
      let nextIn = dragging.origIn;
      let nextOut = dragging.origOut;
      const originIn = 0;
      const originOut = sourceDuration() || dragging.origOut;
      if (dragging.type === "trim-left") {
        nextIn = Math.max(
          originIn,
          Math.min(dragging.origOut - minLen, dragging.origIn + deltaSec)
        );
      } else {
        nextOut = Math.min(
          originOut,
          Math.max(dragging.origIn + minLen, dragging.origOut + deltaSec)
        );
      }
      dragging.liveIn = nextIn;
      dragging.liveOut = nextOut;
      const live = state.clips.map((c) =>
        c.id === dragging.clip.id ? { ...c, start: nextIn, end: nextOut } : c
      );
      layoutClipsLive(live);
      return;
    }
  }

  async function onMouseUp(e) {
    if (!dragging) return;
    const cur = dragging;
    dragging = null;

    if (cur.type === "playhead") return;

    if (cur.type === "clip-move") {
      cur.clipEl.classList.remove("dragging");
      cur.clipEl.style.transform = "";
      if (!cur.moved) return;
      const deltaX = e.clientX - cur.startX;
      const timelineW = getTimelineWidth();
      const dur = editedDuration();
      const deltaSec = (deltaX / timelineW) * dur;
      if (Math.abs(deltaX) > 24) {
        const newIdx = calculateNewClipIndex(cur.clipIdx, deltaSec);
        if (newIdx !== cur.clipIdx && newIdx >= 0 && newIdx < state.clips.length) {
          await reorderClips(cur.clipIdx, newIdx);
        }
      }
      return;
    }

    if (cur.type === "trim-left" || cur.type === "trim-right") {
      cur.handle.classList.remove("trimming");
      cur.clipEl?.classList.remove("trimming");
      const changed =
        Math.abs(cur.liveIn - cur.origIn) > 0.01 || Math.abs(cur.liveOut - cur.origOut) > 0.01;
      if (changed) {
        await commitTrim(cur.clip, cur.liveIn, cur.liveOut);
      } else {
        renderClips();
      }
    }
  }

  const container = $("timeline-container");
  if (container) {
    container.addEventListener("mousedown", onMouseDown);
  }
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}

$("btn-split").onclick = () => splitAtPlayhead();
$("btn-delete-clip").onclick = () => deleteSelectedClip();
$("btn-copy-clip").onclick = () => copySelectedClip();
$("btn-paste-clip").onclick = () => pasteClip();
$("btn-add-clip").onclick = () => $("clip-file").click();

$("clip-file").onchange = async () => {
  const f = $("clip-file").files?.[0];
  if (!f || !state.project) return;
  $("clip-file").value = "";
  document.body.classList.add("busy");
  try {
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch(`/api/projects/${state.project.id}/append`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Upload failed");
    }
    const updated = await res.json();
    applyProject(updated);
  } catch (err) {
    alert("Failed to add clip: " + err.message);
  } finally {
    document.body.classList.remove("busy");
  }
};

$("btn-zoom-in").onclick = () => setZoom(state.zoomLevel + 0.5);
$("btn-zoom-out").onclick = () => setZoom(state.zoomLevel - 0.5);
$("btn-zoom-fit").onclick = () => setZoom(1.0);
$("zoom-slider").oninput = (e) => setZoom(e.target.value);

$("btn-retranscribe-dismiss").onclick = () => {
  state.retranscribeDismissed = true;
  updateRetranscribeBar();
};

$("btn-retranscribe").onclick = async () => {
  if (!state.project?.id) return;
  const btn = $("btn-retranscribe");
  btn.disabled = true;
  btn.textContent = "Transcribing…";
  document.body.classList.add("busy");
  try {
    const updated = await api(`/api/projects/${state.project.id}/retranscribe`, { method: "POST" });
    state.retranscribeDismissed = false;
    state.editedTime = 0;
    applyProject(updated);
    attachMedia(updated, true);
  } catch (err) {
    alert("Re-transcribe failed: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Re-transcribe";
    document.body.classList.remove("busy");
  }
};

window.addEventListener("resize", () => {
  renderRuler();
  renderClips();
  setPlayhead();
});

document.addEventListener("dragover", (e) => {
  e.preventDefault();
  $("dropzone").classList.add("drag");
});
document.addEventListener("dragleave", (e) => {
  if (e.target === document.documentElement) $("dropzone").classList.remove("drag");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  $("dropzone").classList.remove("drag");
  const f = e.dataTransfer?.files?.[0];
  if (f) importFile(f);
});

audioEl.addEventListener("ended", () => {
  pause();
  state.editedTime = 0;
  highlightWord(-1);
  setPlayhead();
});

window.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
    return;
  }
  if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    doRedo();
    return;
  }
  if (mod && e.key.toLowerCase() === "c") {
    e.preventDefault();
    copySelectedClip();
    return;
  }
  if (mod && e.key.toLowerCase() === "v") {
    e.preventDefault();
    pasteClip();
    return;
  }
  if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    copySelectedClip();
    pasteClip();
    return;
  }

  if (e.code === "Space") {
    e.preventDefault();
    if (document.activeElement && document.activeElement.tagName === "BUTTON") {
      document.activeElement.blur();
    }
    if (hasWords()) {
      state.playing ? pause() : play(false);
    }
  } else if ((e.key === "s" || e.key === "S") && !mod) {
    e.preventDefault();
    splitAtPlayhead();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selectedClipId) {
      e.preventDefault();
      deleteSelectedClip();
    }
  }
});

const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 520;

function applySidebarWidth(px) {
  const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, px));
  document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
  localStorage.setItem("tv-sidebar-w", String(w));
  return w;
}

function setChatCollapsed(on) {
  $("app").classList.toggle("chat-collapsed", on);
  $("btn-expand").hidden = !on;
  $("btn-collapse").title = "Collapse chat";
  $("btn-expand").title = "Open chat";
  localStorage.setItem("tv-chat-collapsed", on ? "1" : "0");
}

$("btn-collapse").onclick = () => setChatCollapsed(true);
$("btn-expand").onclick = () => setChatCollapsed(false);

(() => {
  const saved = Number(localStorage.getItem("tv-sidebar-w"));
  if (saved) applySidebarWidth(saved);
  if (localStorage.getItem("tv-chat-collapsed") === "1") setChatCollapsed(true);
})();

$("resizer").addEventListener("mousedown", (e) => {
  e.preventDefault();
  $("app").classList.add("resizing");
  const startX = e.clientX;
  const startW = $("sidebar").getBoundingClientRect().width;
  const move = (ev) => applySidebarWidth(startW + (ev.clientX - startX));
  const up = () => {
    $("app").classList.remove("resizing");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

function syncSend() {
  $("btn-send").disabled = !$("prompt").value.trim();
}
$("prompt").addEventListener("input", () => {
  const el = $("prompt");
  el.style.height = "auto";
  el.style.height = `${Math.min(120, el.scrollHeight)}px`;
  syncSend();
});
syncSend();

function setHistoryOpen(on) {
  $("history-pane").hidden = !on;
  $("chat").hidden = on;
  $("composer").hidden = on;
  $("btn-history").classList.toggle("active-icon", on);
}

function formatWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function refreshHistory() {
  const data = await api("/api/projects");
  const items = data.projects || [];
  const current = state.project?.id;
  $("history-list").innerHTML = items.length
    ? items
        .map((p) => {
          const meta = p.has_audio
            ? `${p.kind || "audio"} · ${p.word_count} words · ${formatWhen(p.updated_at)}`
            : `No audio yet · ${formatWhen(p.updated_at)}`;
          const extra = p.preview ? `<span class="h-meta">${escapeHtml(p.preview)}</span>` : "";
          return `<div class="history-item-wrap${p.id === current ? " active" : ""}">
            <button type="button" class="history-item" data-id="${p.id}">
              <span class="h-name">${escapeHtml(p.name)}</span>
              <span class="h-meta">${escapeHtml(meta)}</span>
              ${extra}
            </button>
            <button type="button" class="history-del-btn" data-del-id="${p.id}" title="Delete chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>`;
        })
        .join("")
    : `<p class="h-meta" style="padding:8px">No workspaces yet.</p>`;
}

async function createWorkspace() {
  pause();
  state.project = null;
  state.selectedClipId = null;
  state.clips = [];
  audioEl.removeAttribute("src");
  videoEl.removeAttribute("src");
  state.editedTime = 0;
  applyProject(null);
  setStageMode("empty");
  setHistoryOpen(false);
}

async function openWorkspace(id) {
  pause();
  const p = await api(`/api/projects/${id}`);
  state.editedTime = 0;
  applyProject(p);
  if (!hasWords()) setStageMode("empty");
  setHistoryOpen(false);
}

$("btn-history").onclick = async () => {
  const open = $("history-pane").hidden;
  if (open) {
    try {
      await refreshHistory();
    } catch (err) {
      console.error(err);
    }
  }
  setHistoryOpen(open);
};

$("btn-new").onclick = () => createWorkspace();
$("btn-history-new").onclick = () => createWorkspace();

$("history-list").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del-id]");
  if (del) {
    if (confirm("Are you sure you want to delete this chat?")) {
      await api(`/api/projects/${del.dataset.delId}`, { method: "DELETE" });
      if (state.project?.id === del.dataset.delId) {
        createWorkspace();
      }
      refreshHistory();
    }
    return;
  }
  const item = e.target.closest("[data-id]");
  if (item) openWorkspace(item.dataset.id);
});

function boot() {
  state.project = null;
  pause();
  setHistoryOpen(false);
  setStageMode("empty");
  renderChat();
  setupTimelineInteractions();
}
boot();
