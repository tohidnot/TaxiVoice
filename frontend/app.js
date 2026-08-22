const $ = (id) => document.getElementById(id);

const state = {
  project: null,
  playing: false,
  editedTime: 0,
  playClipIndex: 0,
  clipSeekUntil: 0,
  raf: 0,
  zoomLevel: 1.0,
  selectedClipId: null,
  selectedClipIds: [],
  clips: [],
  retranscribeDismissed: false,
  clipboard: null,
  soloClipIndex: null,
  pendingFile: null,
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
  if (Array.isArray(clips)) {
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

function ensureClips() {
  if (!state.clips.length && state.project) buildClips();
  return state.clips;
}

function editedStartOf(idx) {
  const clips = ensureClips();
  let acc = 0;
  for (let i = 0; i < idx && i < clips.length; i++) acc += clips[i].duration;
  return acc;
}

function clipAtEditedTime(t) {
  const clips = ensureClips();
  if (!clips.length) return null;
  const time = Math.max(0, Number(t) || 0);
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = Math.max(0.01, clips[i].duration);
    if (time < acc + d) {
      return {
        i,
        clip: clips[i],
        offset: Math.min(d, Math.max(0, time - acc)),
        editedStart: acc,
        pastEnd: false,
      };
    }
    acc += d;
  }
  const last = clips[clips.length - 1];
  return {
    i: clips.length - 1,
    clip: last,
    offset: last.duration,
    editedStart: acc - last.duration,
    pastEnd: true,
  };
}

function sourceAtEdited(t) {
  const pos = clipAtEditedTime(t);
  if (!pos) return 0;
  return pos.clip.start + pos.offset;
}

function editedToSource(t) {
  return sourceAtEdited(t);
}

function mediaEl() {
  return audioEl;
}

function syncVideo(srcT, force = false) {
  if (state.project?.kind !== "video") return;
  if (!videoEl.src) return;
  videoEl.muted = true;
  try {
    if (force || Math.abs((videoEl.currentTime || 0) - srcT) > 0.05) {
      videoEl.currentTime = srcT;
    }
  } catch {}
}

function renderChat() {
  const msgs = state.project?.messages || [
    {
      role: "assistant",
      text: "Attach an audio or video file in the prompt, then tell me what to edit.",
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

function hasClips() {
  const clips = state.project?.clips;
  if (Array.isArray(clips)) return clips.length > 0;
  return hasWords();
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
  const clips = Array.isArray(p?.clips) ? p.clips : [];
  if (!clips.length) return [];
  const ordered = [];
  for (const c of clips) {
    const a = Number(c.in);
    const b = Number(c.out);
    for (const w of words) {
      if (w.deleted) continue;
      const s = w.cut_start ?? w.start;
      const e = w.cut_end ?? w.end;
      if (e > a && s < b) {
        ordered.push({ ...w, clipId: c.id });
      }
    }
  }
  return ordered;
}

function clipPlayButtonHtml(idx) {
  return `<button type="button" class="chip-play" data-play-clip="${idx}" title="Play clip">
    <svg class="icon-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    <svg class="icon-pause" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>
  </button>`;
}

function renderWords() {
  const clips = state.project ? buildClips() : [];
  if (!clips.length) {
    wordsEl.innerHTML = "";
    return;
  }
  if (state.soloClipIndex != null && (state.soloClipIndex < 0 || state.soloClipIndex >= clips.length)) {
    state.soloClipIndex = null;
  }
  wordsEl.className = "transcripts";
  wordsEl.innerHTML = clips
    .map((c, i) => {
      const chips = wordsInSpan(c.start, c.end)
        .map(
          (w) =>
            `<button type="button" class="chip" data-id="${w.id}" data-clip-id="${c.id}"><span>${escapeHtml(w.word)}</span><span class="x" data-del="${w.id}" title="Delete word">×</span></button>`
        )
        .join("");
      return `<div class="clip-transcript" data-clip-id="${c.id}" data-clip-index="${i}">
        ${clipPlayButtonHtml(i)}
        <div class="words">${chips || `<span class="empty-clip-hint">No words in this clip</span>`}</div>
      </div>`;
    })
    .join("");
  setPlayingUi(state.playing);
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
  if (Array.isArray(p?.clips)) {
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
  const usable = Math.max(120, baseW);
  return Math.max(usable, usable * state.zoomLevel);
}

function selectedIdList() {
  if (Array.isArray(state.selectedClipIds) && state.selectedClipIds.length) {
    return state.selectedClipIds.slice();
  }
  return state.selectedClipId ? [state.selectedClipId] : [];
}

function isClipSelected(id) {
  if (!id) return false;
  if (state.selectedClipId === id) return true;
  return Array.isArray(state.selectedClipIds) && state.selectedClipIds.includes(id);
}

function selectClips(ids, primary) {
  const clips = state.clips.length ? state.clips : (state.project ? buildClips() : []);
  const unique = [];
  for (const id of ids || []) {
    if (clips.some((c) => c.id === id) && !unique.includes(id)) unique.push(id);
  }
  state.selectedClipIds = unique;
  if (primary && unique.includes(primary)) state.selectedClipId = primary;
  else state.selectedClipId = unique.at(-1) || null;
  updateClipSelection();
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
  const pps = timelinePps();
  const gap = 3;
  let accEdited = 0;

  state.selectedClipIds = (state.selectedClipIds || []).filter((id) => clips.some((c) => c.id === id));
  if (state.selectedClipId && !clips.some((c) => c.id === state.selectedClipId)) {
    state.selectedClipId = state.selectedClipIds.at(-1) || null;
  }
  if (state.selectedClipId && !state.selectedClipIds.includes(state.selectedClipId)) {
    state.selectedClipIds.push(state.selectedClipId);
  }

  const html = clips.map((c, i) => {
    const leftPx = accEdited * pps;
    const widthPx = Math.max(12, c.duration * pps - gap);
    accEdited += c.duration;
    const isSelected = isClipSelected(c.id);

    return `
      <div class="timeline-clip ${isSelected ? "selected" : ""}"
           data-clip-id="${c.id}"
           data-clip-idx="${i}"
           style="left: ${leftPx.toFixed(1)}px; width: ${widthPx.toFixed(1)}px;">
        <div class="clip-wave-wrap">
          <canvas class="clip-wave-canvas" data-canvas-clip="${i}"></canvas>
        </div>
        <div class="clip-trim-handle left" data-clip-id="${c.id}" data-side="left" title="Extend / trim start">
          <span class="grip"></span>
        </div>
        <div class="clip-trim-handle right" data-clip-id="${c.id}" data-side="right" title="Extend / trim end">
          <span class="grip"></span>
        </div>
      </div>
    `;
  }).join("");

  const plusLeft = accEdited * pps + (clips.length ? 8 : 12);
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
  const totalDur = Math.max(0.01, sourceDuration());
  const pps = timelinePps();
  const dpr = window.devicePixelRatio || 1;
  const srcW = Math.max(4, totalDur * pps);

  document.querySelectorAll(".clip-wave-canvas").forEach((canvas) => {
    const clipIdx = Number(canvas.dataset.canvasClip);
    const clip = state.clips[clipIdx];
    if (!clip) return;

    const wrap = canvas.parentElement;
    const h = Math.max(8, Math.floor(wrap.getBoundingClientRect().height));

    canvas.style.width = `${srcW}px`;
    canvas.style.height = `${h}px`;
    canvas.style.left = `${(-clip.start * pps).toFixed(2)}px`;

    const bw = Math.max(1, Math.floor(srcW * dpr));
    const bh = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;

    const cctx = canvas.getContext("2d");
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.clearRect(0, 0, srcW, h);
    cctx.fillStyle = "#9a9aa2";
    const mid = h / 2;

    if (!peaks.length) {
      cctx.fillRect(0, mid - 1, srcW, 2);
      return;
    }

    const n = peaks.length;
    const bar = 2;
    const stride = 3;
    for (let x = 0; x < srcW; x += stride) {
      const t = x / pps;
      const idx = Math.min(n - 1, Math.max(0, Math.floor((t / totalDur) * n)));
      const amp = Math.max(1.2, (peaks[idx] || 0) * (h * 0.38));
      cctx.fillRect(x, mid - amp, bar, amp * 2);
    }
  });
}

function updateClipSelection() {
  document.querySelectorAll(".timeline-clip").forEach((el) => {
    el.classList.toggle("selected", isClipSelected(el.dataset.clipId));
  });
  updateClipButtons();
}

function updateClipButtons() {
  const hasSelection = selectedIdList().some((id) => state.clips.some((c) => c.id === id));
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

function timelinePps() {
  return getTimelineWidth() / Math.max(0.01, viewDuration());
}

function setPlayhead() {
  const edited = editedDuration() || 1;
  const view = viewDuration();
  const pct = Math.min(1, Math.max(0, state.editedTime / view));
  const timelineW = getTimelineWidth();
  const phX = pct * timelineW;

  const ph = $("playhead");
  ph.hidden = !hasClips();
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
    const pos = clipAtEditedTime(state.editedTime);
    const src = pos ? pos.clip.start + pos.offset : 0;
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
  if (p.kind === "video") {
    const vurl = `/api/projects/${p.id}/media`;
    if (force || !videoEl.src.includes(`${p.id}/media`)) {
      videoEl.src = vurl;
    }
    videoEl.muted = true;
  }
}

function applyProject(p) {
  state.project = p;
  if (!p?.needs_retranscribe) state.retranscribeDismissed = false;
  if (hasClips()) {
    setStageMode("ready");
  } else if (!state.importing) {
    pause();
    setStageMode("empty");
  }
  renderChat();
  renderWords();
  renderMeta();
  if (hasClips()) attachMedia(p);
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

function formatFileSize(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function isMediaFile(file) {
  if (!file) return false;
  const type = file.type || "";
  if (type.startsWith("audio/") || type.startsWith("video/")) return true;
  return /\.(mp3|wav|m4a|aac|mp4|mov|mkv|webm)$/i.test(file.name || "");
}

function setPendingFile(file) {
  state.pendingFile = file || null;
  const wrap = $("composer-attach");
  const nameEl = $("attach-name");
  const sizeEl = $("attach-size");
  const attachBtn = $("btn-import");
  if (!file) {
    if (wrap) wrap.hidden = true;
    if (nameEl) nameEl.textContent = "";
    if (sizeEl) sizeEl.textContent = "";
    if (attachBtn) attachBtn.classList.remove("has-file");
    fileEl.value = "";
    syncSend();
    return;
  }
  if (nameEl) nameEl.textContent = file.name;
  if (sizeEl) sizeEl.textContent = formatFileSize(file.size);
  if (wrap) wrap.hidden = false;
  if (attachBtn) attachBtn.classList.add("has-file");
  syncSend();
}

function attachFile(file) {
  if (!file) return;
  if (!isMediaFile(file)) {
    alert("Please attach an audio or video file.");
    return;
  }
  setPendingFile(file);
  setHistoryOpen(false);
  if ($("app").classList.contains("chat-collapsed")) setChatCollapsed(false);
  requestAnimationFrame(() => $("prompt")?.focus());
}

async function importFile(file, { silent = false, userText = "" } = {}) {
  if (!file) return null;
  const fd = new FormData();
  fd.append("file", file);
  if (silent) fd.append("silent", "1");
  state.importing = true;
  pause();
  $("loading-name").textContent = `Transcribing ${file.name}`;
  setStageMode("loading");
  const reuseSession = Boolean(state.project?.id && !hasClips());
  const sessionId = state.project?.id;
  const prior = Array.isArray(state.project?.messages) ? state.project.messages.slice() : [];
  const localMsgs = prior.slice();
  if (userText && !localMsgs.some((m) => m.role === "user" && m.text === userText)) {
    localMsgs.push({ role: "user", text: userText });
  }
  localMsgs.push({
    role: "assistant",
    text: "Transcribing with Parakeet v3. This takes a few seconds on first load…",
  });
  const pending = {
    ...(state.project || { words: [], messages: [] }),
    name: file.name.replace(/\.[^.]+$/, ""),
    messages: localMsgs,
  };
  if (!Array.isArray(pending.words)) pending.words = [];
  state.project = pending;
  renderChat();
  $("project-name").textContent = pending.name;
  try {
    if (reuseSession && sessionId) fd.append("session_id", sessionId);
    const p = await api("/api/projects/import", { method: "POST", body: fd });
    state.editedTime = 0;
    state.playClipIndex = 0;
    state.soloClipIndex = null;
    state.importing = false;
    applyProject(p);
    attachMedia(p, true);
    return p;
  } catch (err) {
    state.importing = false;
    pending.messages = [
      ...prior,
      { role: "assistant", text: `Could not import: ${err.message}` },
    ];
    applyProject({ ...pending, words: pending.words || [] });
    setStageMode("empty");
    throw err;
  }
}

async function appendClipFile(file) {
  if (!file || !state.project?.id) return null;
  document.body.classList.add("busy");
  try {
    const fd = new FormData();
    fd.append("file", file);
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
    attachMedia(updated, true);
    return updated;
  } finally {
    document.body.classList.remove("busy");
  }
}

async function submitComposer(text, file) {
  const trimmed = (text || "").trim();
  if (!trimmed && !file) return;
  if (state.importing) return;
  try {
    if (file) {
      if (hasClips() && state.project?.id) {
        await appendClipFile(file);
      } else {
        await importFile(file, { silent: Boolean(trimmed), userText: trimmed });
      }
    }
    if (trimmed) await sendChat(trimmed);
  } catch (err) {
    setPendingFile(file);
    if (trimmed) {
      $("prompt").value = text;
      $("prompt").style.height = "auto";
      $("prompt").style.height = `${Math.min(120, $("prompt").scrollHeight)}px`;
    }
    syncSend();
    console.error(err);
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

function markClipSeek() {
  state.clipSeekUntil = performance.now() + 180;
}

function clipPlayEnd(idx) {
  const clips = ensureClips();
  const clip = clips[idx];
  pause();
  state.editedTime = clip ? editedStartOf(idx) + clip.duration : editedDuration();
  highlightWord(-1);
  setPlayhead();
}

function advancePlayClip(fromIdx) {
  const clips = ensureClips();
  if (state.soloClipIndex != null) {
    clipPlayEnd(fromIdx);
    return false;
  }
  const next = fromIdx + 1;
  if (next >= clips.length) {
    pause();
    state.editedTime = editedDuration();
    highlightWord(-1);
    setPlayhead();
    return false;
  }
  state.playClipIndex = next;
  const clip = clips[next];
  const srcT = clip.start + 0.001;
  const media = mediaEl();
  try { media.currentTime = srcT; } catch {}
  syncVideo(srcT, true);
  state.editedTime = editedStartOf(next);
  markClipSeek();
  revealPlayingTranscript();
  setPlayingUi(true);
  return true;
}

function revealPlayingTranscript() {
  const row = wordsEl.querySelector(`.clip-transcript[data-clip-index="${state.playClipIndex}"]`);
  if (row) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function tick() {
  if (!state.playing) return;
  const clips = ensureClips();
  if (!clips.length) {
    pause();
    return;
  }
  let idx = state.playClipIndex ?? 0;
  if (idx < 0 || idx >= clips.length) idx = 0;
  const clip = clips[idx];
  const media = mediaEl();
  const src = media.currentTime;
  const slop = 0.05;
  const inside = src >= clip.start - slop && src <= clip.end + slop;
  const seeking = performance.now() < (state.clipSeekUntil || 0);

  if (seeking && !inside) {
    const offset = Math.min(clip.duration - 0.001, Math.max(0, state.editedTime - editedStartOf(idx)));
    const pinned = clip.start + offset;
    try { media.currentTime = pinned; } catch {}
    syncVideo(pinned, true);
  } else if (inside && src < clip.end - 0.015) {
    if (seeking) state.clipSeekUntil = 0;
    state.playClipIndex = idx;
    state.editedTime = editedStartOf(idx) + Math.max(0, Math.min(clip.duration, src - clip.start));
    syncVideo(src);
  } else if (!seeking && src >= clip.end - 0.02 && src <= clip.end + 0.3) {
    if (!advancePlayClip(idx)) return;
  } else if (!seeking) {
    const offset = Math.min(clip.duration - 0.001, Math.max(0, state.editedTime - editedStartOf(idx)));
    const pinned = clip.start + offset;
    try { media.currentTime = pinned; } catch {}
    syncVideo(pinned, true);
  }

  setPlayhead();
  const playing = clips[state.playClipIndex];
  highlightWord(playing ? playing.start + (state.editedTime - editedStartOf(state.playClipIndex)) : -1, playing?.id);
  state.raf = requestAnimationFrame(tick);
}

function highlightWord(src, clipId) {
  const t = Number(src);
  let hitId = null;
  if (Number.isFinite(t) && t >= 0) {
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
    const wordMatch = hitId !== null && Number(el.dataset.id) === hitId;
    const clipMatch = !clipId || !el.dataset.clipId || el.dataset.clipId === String(clipId);
    el.classList.toggle("active", wordMatch && clipMatch);
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

  const btnVideoPlay = $("btn-video-play");
  if (btnVideoPlay) {
    btnVideoPlay.classList.toggle("is-playing", isPlaying);
    btnVideoPlay.title = isPlaying ? "Pause" : "Play";
  }

  const currentIdx = state.playClipIndex;
  const solo = state.soloClipIndex;
  wordsEl.querySelectorAll(".clip-transcript").forEach((row) => {
    const idx = Number(row.dataset.clipIndex);
    row.classList.toggle("is-current", isPlaying && idx === currentIdx);
    const btn = row.querySelector(".chip-play");
    if (!btn) return;
    const thisPlaying = isPlaying && solo != null && idx === solo;
    btn.classList.toggle("is-playing", thisPlaying);
    btn.title = thisPlaying ? "Pause clip" : "Play clip";
  });
}

function play(fromStart = false) {
  if (!hasClips()) return;
  attachMedia(state.project);
  const clips = ensureClips();
  if (state.soloClipIndex != null && (state.soloClipIndex < 0 || state.soloClipIndex >= clips.length)) {
    state.soloClipIndex = null;
  }
  const solo = state.soloClipIndex;
  if (solo != null) {
    const startT = editedStartOf(solo);
    const endT = startT + clips[solo].duration;
    if (fromStart || state.editedTime < startT || state.editedTime >= endT - 0.02) {
      state.editedTime = startT;
    }
    state.playClipIndex = solo;
  } else {
    const dur = editedDuration();
    if (fromStart || (dur > 0 && state.editedTime >= dur - 0.02)) {
      state.editedTime = 0;
    }
    const pos = clipAtEditedTime(state.editedTime);
    if (!pos || pos.pastEnd) {
      state.editedTime = 0;
    }
    const start = clipAtEditedTime(state.editedTime);
    if (!start) return;
    state.playClipIndex = start.i;
  }
  const start = clips[state.playClipIndex];
  if (!start) return;
  const offset = Math.max(0, Math.min(start.duration - 0.001, state.editedTime - editedStartOf(state.playClipIndex)));
  markClipSeek();
  const srcT = start.start + offset;
  const media = mediaEl();
  try {
    media.currentTime = srcT;
  } catch {}
  syncVideo(srcT, true);
  if (state.project?.kind === "video" && videoEl.src) {
    videoEl.muted = true;
    videoEl.play().catch(() => {});
  }
  const kick = media.play();
  state.playing = true;
  setPlayingUi(true);
  cancelAnimationFrame(state.raf);
  revealPlayingTranscript();
  tick();
  if (kick && kick.catch) {
    kick.catch(() => pause());
  }
}

function playAllFromPlayhead(fromStart = false) {
  state.soloClipIndex = null;
  play(fromStart);
}

function playClipSolo(idx) {
  const clips = ensureClips();
  if (idx < 0 || idx >= clips.length) return;
  if (state.playing && state.soloClipIndex === idx) {
    pause();
    return;
  }
  const startT = editedStartOf(idx);
  const endT = startT + clips[idx].duration;
  const inClip = state.soloClipIndex === idx && state.editedTime >= startT && state.editedTime < endT - 0.02;
  if (!inClip) state.editedTime = startT;
  state.soloClipIndex = idx;
  play(false);
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

function seekEdited(t, opts = {}) {
  if (!opts.keepSolo) state.soloClipIndex = null;
  const edited = editedDuration();
  const view = viewDuration();
  state.editedTime = Math.max(0, Math.min(view, Number(t) || 0));
  const inTail = state.editedTime >= edited - 0.001;
  const pos = clipAtEditedTime(inTail ? Math.max(0, edited - 0.001) : state.editedTime);
  let srcT = 0;
  if (pos) {
    srcT = pos.clip.start + Math.min(pos.offset, Math.max(0, pos.clip.duration - 0.001));
    state.playClipIndex = pos.i;
    markClipSeek();
  }
  const media = mediaEl();
  if (media.src) {
    try { media.currentTime = srcT; } catch {}
  }
  syncVideo(srcT, true);
  setPlayhead();
  highlightWord(inTail ? -1 : srcT, pos?.clip?.id);
  if (state.playing) setPlayingUi(true);
}

function pickFile() {
  fileEl.value = "";
  fileEl.click();
}
$("btn-import").onclick = pickFile;
$("btn-upload-main").onclick = pickFile;
fileEl.onchange = () => {
  const f = fileEl.files?.[0];
  if (f) attachFile(f);
};
$("btn-attach-clear").onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  setPendingFile(null);
  $("prompt")?.focus();
};

$("composer").onsubmit = (e) => {
  e.preventDefault();
  const text = $("prompt").value;
  const file = state.pendingFile;
  if (!text.trim() && !file) return;
  $("prompt").value = "";
  $("prompt").style.height = "auto";
  setPendingFile(null);
  syncSend();
  submitComposer(text, file);
};

$("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

wordsEl.addEventListener("click", (e) => {
  const playBtn = e.target.closest("[data-play-clip]");
  if (playBtn) {
    e.stopPropagation();
    playClipSolo(Number(playBtn.dataset.playClip));
    return;
  }
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
  const clipId = chip.dataset.clipId;
  const clipIdx = ensureClips().findIndex((c) => c.id === clipId);
  if (clipIdx >= 0) {
    const clip = state.clips[clipIdx];
    const wordStart = Number(w.cut_start ?? w.start);
    const offset = Math.max(0, Math.min(clip.duration - 0.001, wordStart - clip.start));
    state.soloClipIndex = clipIdx;
    seekEdited(editedStartOf(clipIdx) + offset, { keepSolo: true });
  } else {
    state.soloClipIndex = null;
    seekEdited(0);
  }
  play(false);
});

$("btn-play").onclick = () => (state.playing ? pause() : playAllFromPlayhead(false));
$("btn-video-play").onclick = () => (state.playing ? pause() : playAllFromPlayhead(false));
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
  if (!state.project?.id || !hasClips()) return;
  const src = sourceAtEdited(state.editedTime);
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
  const ids = selectedIdList();
  const clips = ids.map((id) => state.clips.find((c) => c.id === id)).filter(Boolean);
  if (!clips.length) return;
  state.clipboard = { in: clips[0].start, out: clips[0].end };
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
    let nextId = clips.at(-1)?.id || null;
    if (afterId) {
      const idx = clips.findIndex((c) => c.id === afterId);
      nextId = idx >= 0 && clips[idx + 1] ? clips[idx + 1].id : clips.at(-1)?.id;
    }
    state.retranscribeDismissed = false;
    applyProject(updated);
    if (nextId) selectClips([nextId], nextId);
  } catch (err) {
    console.error("Paste failed:", err);
  }
}

async function deleteSelectedClip() {
  const ids = selectedIdList();
  if (!ids.length || !state.project) return;
  try {
    const updated = await api(`/api/projects/${state.project.id}/clips/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, id: ids[0] }),
    });
    selectClips([]);
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
    selectClips([moved.id], moved.id);
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
    selectClips([clip.id], clip.id);
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

function layoutClipsLive(clipsLayout, pps) {
  const gap = 3;
  let acc = 0;
  document.querySelectorAll(".timeline-clip").forEach((el) => {
    const clip = clipsLayout.find((c) => c.id === el.dataset.clipId);
    if (!clip) return;
    const dur = Math.max(0.08, clip.end - clip.start);
    el.style.left = `${(acc * pps).toFixed(1)}px`;
    el.style.width = `${Math.max(8, dur * pps - gap).toFixed(1)}px`;
    const canvas = el.querySelector(".clip-wave-canvas");
    if (canvas) canvas.style.left = `${(-clip.start * pps).toFixed(2)}px`;
    acc += dur;
  });
  const timelineW = getTimelineWidth();
  const content = $("timeline-content");
  if (content) content.style.width = `${Math.max(timelineW, acc * pps + 96).toFixed(1)}px`;
  const plus = document.querySelector(".clip-add-end");
  if (plus) plus.style.left = `${(acc * pps + 8).toFixed(1)}px`;
}

function setupTimelineInteractions() {
  let dragging = null;

  function timeFromClientX(clientX) {
    const wrap = $("timeline-scroll-wrap");
    if (!wrap) return 0;
    const rect = wrap.getBoundingClientRect();
    const w = Math.max(1, getTimelineWidth());
    const x = wrap.scrollLeft + (clientX - rect.left);
    const pct = Math.max(0, Math.min(1, x / w));
    return pct * viewDuration();
  }

  function contentPoint(e) {
    const wrap = $("timeline-scroll-wrap");
    const content = $("timeline-content");
    if (!wrap || !content) return { x: 0, y: 0 };
    const wrapRect = wrap.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      x: wrap.scrollLeft + (e.clientX - wrapRect.left),
      y: e.clientY - contentRect.top,
    };
  }

  function setMarqueeBox(a, b) {
    const box = $("timeline-marquee");
    if (!box) return;
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const width = Math.abs(b.x - a.x);
    const height = Math.abs(b.y - a.y);
    box.hidden = false;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${Math.max(1, width)}px`;
    box.style.height = `${Math.max(1, height)}px`;
  }

  function hideMarquee() {
    const box = $("timeline-marquee");
    if (box) {
      box.hidden = true;
      box.style.width = "0";
      box.style.height = "0";
    }
  }

  function idsInMarquee(origin, current) {
    const left = Math.min(origin.x, current.x);
    const right = Math.max(origin.x, current.x);
    const ids = [];
    document.querySelectorAll(".timeline-clip").forEach((el) => {
      const clipLeft = parseFloat(el.style.left) || 0;
      const clipRight = clipLeft + (parseFloat(el.style.width) || 0);
      if (clipLeft < right && clipRight > left) ids.push(el.dataset.clipId);
    });
    return ids;
  }

  let edgeRaf = 0;

  function stopEdgeScroll() {
    if (edgeRaf) {
      cancelAnimationFrame(edgeRaf);
      edgeRaf = 0;
    }
  }

  function nearScrollEdge(clientX) {
    const wrap = $("timeline-scroll-wrap");
    if (!wrap) return false;
    const rect = wrap.getBoundingClientRect();
    const edge = 40;
    return clientX > rect.right - edge || clientX < rect.left + edge;
  }

  function autoScrollForScrub(clientX) {
    const wrap = $("timeline-scroll-wrap");
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const edge = 40;
    if (clientX > rect.right - edge) {
      wrap.scrollLeft += Math.max(8, (clientX - (rect.right - edge)) * 0.6);
    } else if (clientX < rect.left + edge) {
      wrap.scrollLeft -= Math.max(8, (rect.left + edge - clientX) * 0.6);
    }
  }

  function startEdgeScrollLoop() {
    if (edgeRaf) return;
    const loop = () => {
      edgeRaf = 0;
      if (!dragging || dragging.lastX == null) return;
      if (dragging.type === "playhead") {
        autoScrollForScrub(dragging.lastX);
        seekEdited(timeFromClientX(dragging.lastX));
      } else if (dragging.type === "marquee") {
        autoScrollForScrub(dragging.lastX);
        const now = contentPoint({ clientX: dragging.lastX, clientY: dragging.lastY });
        setMarqueeBox(dragging.origin, now);
        applyMarqueeSelection(now);
      } else {
        return;
      }
      if (nearScrollEdge(dragging.lastX)) startEdgeScrollLoop();
    };
    edgeRaf = requestAnimationFrame(loop);
  }

  function applyMarqueeSelection(current) {
    const hit = idsInMarquee(dragging.origin, current);
    if (dragging.additive) {
      const merged = [...new Set([...(dragging.baseIds || []), ...hit])];
      selectClips(merged, hit.at(-1));
    } else {
      selectClips(hit, hit.at(-1));
    }
  }

  function hitFromPoint(e, selector) {
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of stack) {
      if (el.matches?.(selector)) return el;
      const closest = el.closest?.(selector);
      if (closest) return closest;
    }
    return null;
  }

  function isNearPlayhead(e) {
    const ph = $("playhead");
    if (!ph || ph.hidden) return false;
    const r = ph.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    return Math.abs(e.clientX - cx) <= 14 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
  }

  function scrubToClientX(clientX) {
    if (dragging && dragging.type === "playhead") dragging.lastX = clientX;
    autoScrollForScrub(clientX);
    seekEdited(timeFromClientX(clientX));
    if (nearScrollEdge(clientX)) startEdgeScrollLoop();
  }

  function startPlayheadDrag(e) {
    if (state.playing) pause();
    document.body.classList.add("scrubbing");
    dragging = {
      type: "playhead",
      pointerId: e.pointerId,
      lastX: e.clientX,
      capEl: e.currentTarget || $("timeline-container"),
    };
    try {
      if (e.pointerId != null) dragging.capEl?.setPointerCapture?.(e.pointerId);
    } catch {}
    if (e.cancelable) e.preventDefault();
    scrubToClientX(e.clientX);
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    if (!state.project || !hasClips()) return;

    if (hitFromPoint(e, ".clip-add-end") || e.target.closest(".clip-add-end")) {
      e.stopPropagation();
      $("clip-file").click();
      return;
    }

    const trimHandle = hitFromPoint(e, ".clip-trim-handle") || e.target.closest(".clip-trim-handle");
    if (trimHandle) {
      e.stopPropagation();
      e.preventDefault();
      const clip = state.clips.find((c) => c.id === trimHandle.dataset.clipId);
      if (!clip) return;
      const clipEl = trimHandle.closest(".timeline-clip");
      selectClips([clip.id], clip.id);
      trimHandle.classList.add("trimming");
      clipEl?.classList.add("trimming");
      document.body.classList.add("trimming-clip");
      dragging = {
        type: trimHandle.dataset.side === "left" ? "trim-left" : "trim-right",
        clip,
        handle: trimHandle,
        clipEl,
        startX: e.clientX,
        origIn: clip.start,
        origOut: clip.end,
        pps: timelinePps(),
        liveIn: clip.start,
        liveOut: clip.end,
      };
      return;
    }

    if (e.target.closest(".playhead") || isNearPlayhead(e)) {
      e.preventDefault();
      e.stopPropagation();
      startPlayheadDrag(e);
      return;
    }

    const clipEl = e.target.closest(".timeline-clip") || hitFromPoint(e, ".timeline-clip");
    if (clipEl) {
      e.stopPropagation();
      const clip = state.clips.find((c) => c.id === clipEl.dataset.clipId);
      if (!clip) return;
      const idx = Number(clipEl.dataset.clipIdx);
      const toggle = e.metaKey || e.ctrlKey;
      const range = e.shiftKey;
      if (range) {
        const anchor = state.clips.findIndex((c) => c.id === state.selectedClipId);
        const from = anchor >= 0 ? Math.min(anchor, idx) : 0;
        const to = Math.max(anchor >= 0 ? anchor : idx, idx);
        selectClips(state.clips.slice(from, to + 1).map((c) => c.id), clip.id);
        return;
      }
      if (toggle) {
        const cur = selectedIdList();
        if (cur.includes(clip.id)) selectClips(cur.filter((id) => id !== clip.id));
        else selectClips([...cur, clip.id], clip.id);
        return;
      }
      selectClips([clip.id], clip.id);
      dragging = {
        type: "clip-move",
        clipIdx: idx,
        clip,
        clipEl,
        startX: e.clientX,
        moved: false,
      };
      return;
    }

    const inLane = hitFromPoint(e, ".track-lane") || e.target.closest(".track-lane");
    if (inLane) {
      e.preventDefault();
      e.stopPropagation();
      const origin = contentPoint(e);
      dragging = {
        type: "pending-track",
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        origin,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
        baseIds: selectedIdList(),
        pointerId: e.pointerId,
        capEl: $("timeline-container"),
      };
      try {
        if (e.pointerId != null) dragging.capEl?.setPointerCapture?.(e.pointerId);
      } catch {}
      return;
    }

    if (e.target.closest(".timeline-container")) {
      e.preventDefault();
      startPlayheadDrag(e);
    }
  }

  function onDragMove(e) {
    if (!dragging || !state.project) return;

    if (dragging.type === "playhead") {
      if (e.cancelable) e.preventDefault();
      scrubToClientX(e.clientX);
      return;
    }

    if (dragging.type === "pending-track" || dragging.type === "marquee") {
      if (e.cancelable) e.preventDefault();
      dragging.lastX = e.clientX;
      dragging.lastY = e.clientY;
      const dist = Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY);
      if (dragging.type === "pending-track" && dist > 5) {
        dragging.type = "marquee";
        document.body.classList.add("selecting-clips");
        if (!dragging.additive) selectClips([]);
      }
      if (dragging.type === "marquee") {
        autoScrollForScrub(e.clientX);
        const now = contentPoint(e);
        setMarqueeBox(dragging.origin, now);
        applyMarqueeSelection(now);
        if (nearScrollEdge(e.clientX)) startEdgeScrollLoop();
      }
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
      const originIn = 0;
      const originOut = sourceDuration() || dragging.origOut;
      let nextIn = dragging.origIn;
      let nextOut = dragging.origOut;
      if (dragging.type === "trim-left") {
        nextIn = Math.max(originIn, Math.min(dragging.origOut - minLen, dragging.origIn + deltaSec));
      } else {
        nextOut = Math.min(originOut, Math.max(dragging.origIn + minLen, dragging.origOut + deltaSec));
      }
      dragging.liveIn = nextIn;
      dragging.liveOut = nextOut;
      const live = state.clips.map((c) =>
        c.id === dragging.clip.id ? { ...c, start: nextIn, end: nextOut } : c
      );
      layoutClipsLive(live, dragging.pps);
    }
  }

  async function onDragUp(e) {
    if (!dragging) return;
    const cur = dragging;
    dragging = null;
    document.body.classList.remove("scrubbing", "trimming-clip", "selecting-clips");
    stopEdgeScroll();
    hideMarquee();

    if (cur.type === "playhead" || cur.type === "pending-track" || cur.type === "marquee") {
      try {
        if (cur.pointerId != null && cur.capEl?.hasPointerCapture?.(cur.pointerId)) {
          cur.capEl.releasePointerCapture(cur.pointerId);
        }
      } catch {}
      if (cur.type === "pending-track") {
        if (!cur.additive) selectClips([]);
        seekEdited(timeFromClientX(e.clientX));
      }
      return;
    }

    if (cur.type === "clip-move") {
      cur.clipEl.classList.remove("dragging");
      cur.clipEl.style.transform = "";
      if (!cur.moved) return;
      const deltaX = e.clientX - cur.startX;
      if (Math.abs(deltaX) > 24) {
        const newIdx = calculateNewClipIndex(cur.clipIdx, deltaX / Math.max(1, timelinePps()));
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
    container.addEventListener("pointerdown", onPointerDown);
  }
  const playhead = $("playhead");
  if (playhead) {
    playhead.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (!state.project || !hasClips()) return;
      e.preventDefault();
      e.stopPropagation();
      startPlayheadDrag(e);
    });
  }
  document.addEventListener("pointermove", onDragMove, { capture: true, passive: false });
  document.addEventListener("pointerup", onDragUp, true);
  document.addEventListener("pointercancel", onDragUp, true);
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
  try {
    await appendClipFile(f);
  } catch (err) {
    alert("Failed to add clip: " + err.message);
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
  if (f) attachFile(f);
});

audioEl.addEventListener("ended", () => {
  if (state.playing && advancePlayClip(state.playClipIndex ?? 0)) {
    audioEl.play().catch(() => pause());
    return;
  }
  pause();
  state.editedTime = editedDuration();
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
  if (mod && e.key.toLowerCase() === "a") {
    e.preventDefault();
    if (hasClips()) selectClips(ensureClips().map((c) => c.id));
    return;
  }

  if (e.code === "Space") {
    e.preventDefault();
    if (document.activeElement && document.activeElement.tagName === "BUTTON") {
      document.activeElement.blur();
    }
    if (hasClips()) {
      state.playing ? pause() : playAllFromPlayhead(false);
    }
  } else if ((e.key === "s" || e.key === "S") && !mod) {
    e.preventDefault();
    splitAtPlayhead();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (selectedIdList().length) {
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
  $("chat-rail").hidden = !on;
  $("btn-collapse").title = "Collapse chat";
  $("btn-expand").title = "Open chat";
  $("chat-rail").title = "Open chat";
  localStorage.setItem("tv-chat-collapsed", on ? "1" : "0");
  requestAnimationFrame(() => {
    renderRuler();
    renderClips();
    setPlayhead();
  });
}

$("btn-collapse").onclick = () => setChatCollapsed(true);
$("btn-expand").onclick = () => setChatCollapsed(false);
$("chat-rail").onclick = () => setChatCollapsed(false);

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
  $("btn-send").disabled = !$("prompt").value.trim() && !state.pendingFile;
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
  state.selectedClipIds = [];
  state.clips = [];
  state.playClipIndex = 0;
  state.soloClipIndex = null;
  audioEl.removeAttribute("src");
  videoEl.removeAttribute("src");
  state.editedTime = 0;
  setPendingFile(null);
  applyProject(null);
  setStageMode("empty");
  setHistoryOpen(false);
}

async function openWorkspace(id) {
  pause();
  const p = await api(`/api/projects/${id}`);
  state.editedTime = 0;
  state.playClipIndex = 0;
  state.soloClipIndex = null;
  state.selectedClipId = null;
  state.selectedClipIds = [];
  setPendingFile(null);
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
