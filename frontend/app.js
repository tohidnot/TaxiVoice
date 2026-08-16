const $ = (id) => document.getElementById(id);

const state = {
  project: null,
  playing: false,
  editedTime: 0,
  raf: 0,
};

const chatEl = $("chat");
const wordsEl = $("words");
const fileEl = $("file");
const audioEl = $("audio");
const videoEl = $("video");
const wave = $("wave");
const ctx = wave.getContext("2d");

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
  chatEl.scrollTop = chatEl.scrollHeight;
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

function renderWords() {
  const p = state.project;
  const words = Array.isArray(p?.words) ? p.words : [];
  if (!words.length) {
    $("btn-play-inline").hidden = true;
    wordsEl.innerHTML = "";
    return;
  }
  const visible = words.filter((w) => !w.deleted);
  wordsEl.className = "words";
  wordsEl.innerHTML = visible
    .map(
      (w) =>
        `<button type="button" class="chip" data-id="${w.id}"><span>${escapeHtml(w.word)}</span><span class="x" data-del="${w.id}" title="Delete word">×</span></button>`
    )
    .join("");
  $("btn-play-inline").hidden = false;
}

function renderMeta() {
  const p = state.project;
  $("project-name").textContent = p?.name || "Untitled";
  $("btn-undo").disabled = !p?.can_undo;
  $("btn-redo").disabled = !p?.can_redo;
  const videoMode = p?.kind === "video";
  $("video-pane").hidden = !videoMode;
  document.querySelector(".stage-row").classList.toggle("has-video", videoMode);
  $("wave-wrap").hidden = videoMode;
  $("filmstrip-wrap").hidden = !videoMode;
  if (videoMode) renderFilmstrip();
  renderRuler();
  drawWave();
}

function renderRuler() {
  const dur = state.project ? editedDuration() || state.project.duration : 20;
  const steps = 5;
  $("ruler").innerHTML = Array.from({ length: steps }, (_, i) => {
    const t = (dur * i) / (steps - 1);
    return `<span>${fmt(t)}</span>`;
  }).join("");
}

function renderFilmstrip() {
  const p = state.project;
  $("filmstrip").innerHTML = (p.thumbs || [])
    .map((src) => `<img src="${src}" alt="" />`)
    .join("");
}

function drawWave() {
  const wrap = $("wave-wrap");
  if (wrap.hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (w < 8) return;
  wave.width = Math.floor(w * dpr);
  wave.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const peaks = state.project?.peaks || [];
  const mid = h / 2;
  ctx.strokeStyle = "#ff5a1f";
  ctx.lineWidth = 1.2;
  if (!peaks.length) {
    ctx.beginPath();
    ctx.moveTo(12, mid);
    ctx.lineTo(w - 12, mid);
    ctx.stroke();
    return;
  }

  const dur = state.project.duration || 1;
  const ranges = keepRanges();
  const stitched = [];
  if (!ranges.length) {
    for (const pk of peaks) stitched.push(pk);
  } else {
    for (const [a, b] of ranges) {
      const i0 = Math.floor((a / dur) * peaks.length);
      const i1 = Math.ceil((b / dur) * peaks.length);
      for (let i = i0; i < i1; i++) stitched.push(peaks[i] || 0);
    }
  }

  const n = stitched.length;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const i = Math.min(n - 1, Math.floor((x / w) * n));
    const amp = (stitched[i] || 0) * (h * 0.42);
    ctx.moveTo(x + 0.5, mid - amp);
    ctx.lineTo(x + 0.5, mid + amp);
  }
  ctx.stroke();
}

function setPlayhead() {
  const dur = editedDuration() || 1;
  const pct = Math.min(1, state.editedTime / dur) * 100;
  const ph = $("playhead");
  ph.hidden = !hasWords();
  ph.style.left = `${pct}%`;
  const fh = $("film-playhead");
  if (fh) fh.style.left = `${pct}%`;
  if (state.project?.kind === "video") {
    $("video-time").textContent = `${fmt(state.editedTime)} / ${fmt(dur)}`;
    const src = editedToSource(state.editedTime);
    const hit = keepWords().find((w) => src >= w.start && src <= w.end);
    $("caption").innerHTML = hit
      ? keepWords()
          .filter((w) => Math.abs((w.start + w.end) / 2 - src) < 1.6)
          .map((w) => (w.id === hit.id ? `<b>${escapeHtml(w.word)}</b>` : escapeHtml(w.word)))
          .join(" ")
      : "";
  }
}

function attachMedia(p) {
  if (!p?.id) return;
  const url = `/api/projects/${p.id}/audio`;
  if (!audioEl.src.includes(`${p.id}/audio`)) {
    audioEl.src = url;
    audioEl.load();
  }
  if (p.kind === "video") videoEl.src = `/api/projects/${p.id}/media`;
}

function applyProject(p) {
  state.project = p;
  if (hasWords()) setStageMode("ready");
  else if (!state.importing) setStageMode("empty");
  renderChat();
  renderWords();
  renderMeta();
  attachMedia(p);
  setPlayhead();
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
    await createWorkspace();
  }
  applyProject(await api(`/api/projects/${state.project.id}/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: text }),
  }));
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
  const words = keepWords();
  const hit = words.find((w, i) => {
    const next = words[i + 1];
    const end = next ? next.start : w.end;
    return src >= w.start && src < end;
  });
  for (const el of wordsEl.querySelectorAll(".chip")) {
    el.classList.toggle("active", hit && Number(el.dataset.id) === hit.id);
  }
}

function setPlayingUi(on) {
  $("icon-play").hidden = on;
  $("icon-pause").hidden = !on;
}

function play(fromStart = false) {
  if (!hasWords()) return;
  attachMedia(state.project);
  if (fromStart) state.editedTime = 0;
  const media = mediaEl();
  try {
    media.currentTime = editedToSource(state.editedTime);
  } catch {}
  const kick = media.play();
  state.playing = true;
  setPlayingUi(true);
  cancelAnimationFrame(state.raf);
  tick();
  if (kick && kick.catch) kick.catch(() => pause());
}

function pause() {
  state.playing = false;
  audioEl.pause();
  videoEl.pause();
  setPlayingUi(false);
  cancelAnimationFrame(state.raf);
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
$("btn-play-inline").onclick = () => (state.playing ? pause() : play(true));
$("btn-video-play").onclick = () => (state.playing ? pause() : play(true));
$("btn-back").onclick = () => seekEdited(state.editedTime - 3);
$("btn-fwd").onclick = () => seekEdited(state.editedTime + 3);

$("btn-undo").onclick = async () => {
  if (!state.project) return;
  applyProject(await api(`/api/projects/${state.project.id}/undo`, { method: "POST" }));
};
$("btn-redo").onclick = async () => {
  if (!state.project) return;
  applyProject(await api(`/api/projects/${state.project.id}/redo`, { method: "POST" }));
};

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

$("wave-wrap").addEventListener("click", (e) => {
  if (!state.project) return;
  const r = $("wave-wrap").getBoundingClientRect();
  seekEdited(((e.clientX - r.left) / r.width) * editedDuration());
});
$("filmstrip-wrap").addEventListener("click", (e) => {
  if (!state.project) return;
  const r = $("filmstrip-wrap").getBoundingClientRect();
  seekEdited(((e.clientX - r.left) / r.width) * editedDuration());
});

window.addEventListener("resize", drawWave);
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

audioEl.addEventListener("timeupdate", () => {
  if (!state.playing) return;
  highlightWord(audioEl.currentTime);
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
          return `<button type="button" class="history-item${p.id === current ? " active" : ""}" data-id="${p.id}">
            <span class="h-name">${escapeHtml(p.name)}</span>
            <span class="h-meta">${escapeHtml(meta)}</span>
            ${extra}
          </button>`;
        })
        .join("")
    : `<p class="h-meta" style="padding:8px">No workspaces yet.</p>`;
}

async function createWorkspace() {
  pause();
  const p = await api("/api/projects", { method: "POST" });
  audioEl.removeAttribute("src");
  state.editedTime = 0;
  applyProject(p);
  setStageMode("empty");
  setHistoryOpen(false);
  return p;
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

$("history-list").addEventListener("click", (e) => {
  const item = e.target.closest("[data-id]");
  if (item) openWorkspace(item.dataset.id);
});

function boot() {
  state.project = null;
  pause();
  setHistoryOpen(false);
  setStageMode("empty");
  renderChat();
}
boot();
