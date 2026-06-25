const HELPER = "http://127.0.0.1:7531";
const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
let currentRoot = params.get("root") === "video" ? "video" : "audio";
let currentPath = "";
let currentData = null;
let currentFile = null; // {root, rel_path, stem, ext, duration_sec, completed, ...}
let lastSaveAt = 0; // wall-clock ms of the last successful position write
const POSITION_THROTTLE_MS = 2000;

function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function checkStatus() {
  const el = $("status");
  try {
    const res = await fetch(`${HELPER}/status`);
    const data = await res.json();
    const parts = [];
    if (!data.ffmpeg) parts.push("ffmpeg missing");
    if (!data.has_api_key) parts.push("no API key");
    el.className = "status " + (parts.length ? "err" : "ok");
    el.textContent = parts.length
      ? `Helper ${data.version} — ` + parts.join(", ")
      : `Helper ${data.version}`;
  } catch {
    el.className = "status err";
    el.textContent = "Helper not running";
  }
}

async function load() {
  const main = $("browser");
  main.innerHTML = `<div class="loading">Loading...</div>`;
  try {
    const url = `${HELPER}/browse?root=${currentRoot}&path=${encodeURIComponent(currentPath)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    currentData = await res.json();
    renderBreadcrumbs();
    await renderBrowser();
  } catch (e) {
    main.innerHTML = `<div class="empty">Error loading: ${e.message}</div>`;
  }
}

function renderBreadcrumbs() {
  const bc = $("breadcrumbs");
  bc.innerHTML = "";
  const root = currentRoot === "video" ? "YTD_DJ_Video" : "YTD_DJ";

  const rootEl = document.createElement("a");
  rootEl.className = "crumb" + (currentPath ? "" : " current");
  rootEl.textContent = "~/" + root;
  if (currentPath) rootEl.addEventListener("click", () => navigate(""));
  bc.appendChild(rootEl);

  if (currentPath) {
    const parts = currentPath.split("/").filter(Boolean);
    let acc = "";
    parts.forEach((p, i) => {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = " / ";
      bc.appendChild(sep);
      acc = acc ? `${acc}/${p}` : p;
      const isLast = i === parts.length - 1;
      const el = document.createElement("a");
      el.className = "crumb" + (isLast ? " current" : "");
      el.textContent = p;
      if (!isLast) {
        const target = acc;
        el.addEventListener("click", () => navigate(target));
      }
      bc.appendChild(el);
    });
  }
}

function applyFilter(items, q) {
  if (!q) return items;
  q = q.toLowerCase();
  return items.filter((i) => i.name.toLowerCase().includes(q));
}

async function renderBrowser() {
  const main = $("browser");
  const q = ($("filter").value || "").trim();
  const folders = applyFilter(currentData.folders, q);
  const files = applyFilter(currentData.files, q);

  if (!folders.length && !files.length) {
    main.innerHTML = q ? `<div class="empty">No matches.</div>` : `<div class="empty">Empty folder.</div>`;
    if (!currentPath && !q) await renderContinueListening(main);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const f of folders) {
    const e = document.createElement("div");
    e.className = "entry folder";
    e.innerHTML = `
      <div class="icon">📁</div>
      <div class="body">
        <div class="name"></div>
        <div class="meta">${f.count} item${f.count === 1 ? "" : "s"}</div>
      </div>
      <div class="actions">
        <button class="action-btn reveal" title="Reveal in Finder">↗</button>
      </div>
    `;
    e.querySelector(".name").textContent = f.name;
    e.querySelector(".body").addEventListener("click", () => navigate(f.rel_path));
    e.querySelector(".reveal").addEventListener("click", (ev) => {
      ev.stopPropagation();
      reveal(f.rel_path);
    });
    frag.appendChild(e);
  }

  for (const f of files) {
    const isPlayable = f.ext === "mp3" || f.ext === "mp4" || f.ext === "m4a";
    const completed = f.playback?.completed;
    const inProgress = f.playback?.position_sec > 0 && !completed;
    const e = document.createElement("div");
    e.className = "entry file" + (completed ? " completed" : "") + (inProgress ? " in-progress" : "");
    e.dataset.path = f.rel_path;

    let progressBar = "";
    if (inProgress && f.playback.duration_sec) {
      const pct = Math.min(100, Math.max(0, (100 * f.playback.position_sec) / f.playback.duration_sec));
      progressBar = `<div class="row-progress"><div style="width:${pct}%"></div></div>`;
    }

    const metaParts = [];
    if (f.playback?.duration_sec) metaParts.push(fmtTime(f.playback.duration_sec));
    if (inProgress) metaParts.push(`at ${fmtTime(f.playback.position_sec)}`);
    if (completed) metaParts.push("✓ listened");
    metaParts.push(fmtSize(f.size_bytes));

    e.innerHTML = `
      <div class="icon">${f.ext === "mp4" ? "🎬" : "🎵"}</div>
      <div class="body">
        <div class="name"></div>
        <div class="meta"></div>
        ${progressBar}
      </div>
      <div class="actions">
        ${isPlayable ? `<button class="action-btn play" title="Play">▶</button>` : ""}
        <button class="action-btn reveal" title="Reveal in Finder">↗</button>
        <button class="action-btn danger del" title="Delete">🗑</button>
      </div>
    `;
    e.querySelector(".name").textContent = f.title || f.stem;
    e.querySelector(".meta").textContent = metaParts.filter(Boolean).join(" · ");
    if (isPlayable) {
      const playFn = () => play(f);
      e.querySelector(".body").addEventListener("click", playFn);
      e.querySelector(".play").addEventListener("click", (ev) => { ev.stopPropagation(); playFn(); });
    }
    e.querySelector(".reveal").addEventListener("click", (ev) => {
      ev.stopPropagation();
      reveal(f.rel_path);
    });
    e.querySelector(".del").addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteFile(f);
    });
    e.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      showFileContextMenu(ev.clientX, ev.clientY, f, e);
    });
    frag.appendChild(e);
  }

  main.innerHTML = "";
  if (!currentPath && !q) await renderContinueListening(main);
  main.appendChild(frag);
}

async function renderContinueListening(container) {
  try {
    const res = await fetch(`${HELPER}/db/continue?root=${currentRoot}&limit=10`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.items?.length) return;

    const section = document.createElement("div");
    section.className = "continue-section";
    section.innerHTML = `<h2>Continue listening</h2><div class="continue-list"></div>`;
    const list = section.querySelector(".continue-list");
    for (const item of data.items) {
      const card = document.createElement("div");
      card.className = "continue-card";
      const dur = item.duration_sec || 0;
      const pct = dur ? Math.min(100, Math.round((100 * item.position_sec) / dur)) : 0;
      const stem = item.rel_path.split("/").pop().replace(/\.[^.]+$/, "");
      card.innerHTML = `
        <div class="continue-title"></div>
        <div class="continue-meta">${fmtTime(item.position_sec)}${dur ? " / " + fmtTime(dur) : ""}</div>
        <div class="continue-progress"><div style="width:${pct}%"></div></div>
      `;
      card.querySelector(".continue-title").textContent = item.title || stem;
      card.title = item.rel_path;
      card.addEventListener("click", () => {
        const ext = item.rel_path.split(".").pop().toLowerCase();
        play({
          rel_path: item.rel_path,
          stem,
          name: stem + "." + ext,
          ext,
          size_bytes: 0,
          title: item.title,
          playback: {
            position_sec: item.position_sec,
            duration_sec: dur,
            completed: false,
          },
        });
      });
      list.appendChild(card);
    }
    container.appendChild(section);
  } catch (e) {
    // silent
  }
}

function navigate(path) {
  currentPath = path;
  load();
}

async function reveal(path) {
  try {
    await fetch(`${HELPER}/reveal?root=${currentRoot}&path=${encodeURIComponent(path)}`, { method: "POST" });
  } catch (e) {
    console.error(e);
  }
}

async function deleteFile(f) {
  if (!confirm(`Delete "${f.name}"?`)) return;
  try {
    const res = await fetch(`${HELPER}/file?root=${currentRoot}&path=${encodeURIComponent(f.rel_path)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(await res.text());
    if (currentFile && currentFile.rel_path === f.rel_path) closePlayer();
    load();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
  }
}

function getActiveMedia() {
  const a = $("player-audio");
  const v = $("player-video");
  if (!a.classList.contains("hidden")) return a;
  if (!v.classList.contains("hidden")) return v;
  return null;
}

async function play(f) {
  // Persist whatever the previous track was at before swapping.
  if (currentFile) {
    const media = getActiveMedia();
    if (media && media.currentTime > 0) {
      flushPosition(currentFile, media.currentTime, media.duration);
    }
  }

  const bar = $("player-bar");
  const audio = $("player-audio");
  const video = $("player-video");
  const url = `${HELPER}/file?root=${currentRoot}&path=${encodeURIComponent(f.rel_path)}`;

  document.querySelectorAll(".entry.file.playing").forEach((el) => el.classList.remove("playing"));
  const row = document.querySelector(`.entry.file[data-path="${CSS.escape(f.rel_path)}"]`);
  if (row) row.classList.add("playing");

  $("player-title").textContent = f.title || f.stem;
  $("player-path").textContent = `${currentRoot === "video" ? "~/YTD_DJ_Video/" : "~/YTD_DJ/"}${f.rel_path}`;

  const isVideo = f.ext === "mp4";
  const media = isVideo ? video : audio;
  const other = isVideo ? audio : video;
  other.pause();
  other.removeAttribute("src");
  other.classList.add("hidden");
  media.classList.remove("hidden");
  // src is set later, after the resume fetch completes and the
  // loadedmetadata listener is attached.

  currentFile = {
    root: currentRoot,
    rel_path: f.rel_path,
    stem: f.stem,
    ext: f.ext,
    title: f.title,
    completed: false,
  };
  lastSaveAt = 0;

  // Fetch DB state for resume BEFORE setting src + attaching the
  // loadedmetadata listener. If we set src first and then awaited the
  // fetch, the metadata could load (and fire) during the await, before
  // the listener exists, and the seek would silently drop.
  let dbState = f.playback || null;
  try {
    const r = await fetch(`${HELPER}/db/file?root=${currentRoot}&path=${encodeURIComponent(f.rel_path)}`);
    if (r.ok) dbState = await r.json();
  } catch {}

  const resumeAt = dbState?.position_sec > 0 && !dbState?.completed ? dbState.position_sec : 0;
  currentFile.completed = !!dbState?.completed;

  const onLoaded = () => {
    if (resumeAt > 0 && resumeAt < (media.duration || Infinity) - 2) {
      media.currentTime = resumeAt;
      showResumeToast(resumeAt, media);
    }
    media.play().catch(() => {});
  };
  media.addEventListener("loadedmetadata", onLoaded, { once: true });

  // Setting src last ensures the listener is attached before load starts.
  media.src = url;

  bar.classList.remove("hidden");
}

function showResumeToast(at, media) {
  const toast = $("resume-toast");
  $("resume-text").textContent = `Resuming at ${fmtTime(at)}`;
  toast.classList.remove("hidden");
  const startOver = () => {
    media.currentTime = 0;
    toast.classList.add("hidden");
    startOverBtn.removeEventListener("click", startOver);
  };
  const startOverBtn = $("resume-start-over");
  startOverBtn.addEventListener("click", startOver, { once: true });
  setTimeout(() => toast.classList.add("hidden"), 6000);
}

function flushPosition(file, position, duration) {
  if (!file) return;
  fetch(`${HELPER}/db/position`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root: file.root,
      path: file.rel_path,
      position_sec: position,
      duration_sec: duration || null,
    }),
  }).catch(() => {});
}

function markCompleted(file) {
  fetch(`${HELPER}/db/completed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: file.root, path: file.rel_path, completed: true }),
  }).catch(() => {});
  const row = document.querySelector(`.entry.file[data-path="${CSS.escape(file.rel_path)}"]`);
  if (row) { row.classList.add("completed"); row.classList.remove("in-progress"); }
}

function setupMediaTracking(media) {
  media.addEventListener("timeupdate", () => {
    if (!currentFile) return;
    const wallNow = performance.now();
    if (wallNow - lastSaveAt >= POSITION_THROTTLE_MS) {
      lastSaveAt = wallNow;
      flushPosition(currentFile, media.currentTime, media.duration);
    }
    const dur = media.duration;
    if (dur && !currentFile.completed && media.currentTime / dur > 0.9) {
      currentFile.completed = true;
      markCompleted(currentFile);
    }
  });
  media.addEventListener("pause", () => {
    if (currentFile && media.currentTime > 0) {
      lastSaveAt = performance.now();
      flushPosition(currentFile, media.currentTime, media.duration);
    }
  });
  media.addEventListener("ended", () => {
    if (currentFile && !currentFile.completed) {
      currentFile.completed = true;
      markCompleted(currentFile);
    }
  });
}

function closePlayer() {
  const audio = $("player-audio");
  const video = $("player-video");
  if (currentFile) {
    const m = getActiveMedia();
    if (m && m.currentTime > 0) flushPosition(currentFile, m.currentTime, m.duration);
  }
  audio.pause(); audio.removeAttribute("src");
  video.pause(); video.removeAttribute("src");
  audio.classList.add("hidden");
  video.classList.add("hidden");
  $("player-bar").classList.add("hidden");
  $("resume-toast").classList.add("hidden");
  document.querySelectorAll(".entry.file.playing").forEach((el) => el.classList.remove("playing"));
  currentFile = null;
}

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, [contenteditable]")) return;
  if (!currentFile) return;
  const media = getActiveMedia();
  if (!media) return;
  if (e.code === "Space") {
    e.preventDefault();
    if (media.paused) media.play(); else media.pause();
  } else if (e.code === "ArrowRight") {
    e.preventDefault();
    media.currentTime = Math.min(media.duration || media.currentTime + 10, media.currentTime + 10);
  } else if (e.code === "ArrowLeft") {
    e.preventDefault();
    media.currentTime = Math.max(0, media.currentTime - 10);
  }
});

setupMediaTracking($("player-audio"));
setupMediaTracking($("player-video"));

document.querySelectorAll(".tab[data-root]").forEach((t) => {
  if (t.dataset.root === currentRoot) {
    document.querySelectorAll(".tab[data-root]").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
  }
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab[data-root]").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    currentRoot = t.dataset.root;
    currentPath = "";
    closePlayer();
    load();
  });
});

$("filter").addEventListener("input", renderBrowser);
$("refresh").addEventListener("click", () => {
  checkStatus();
  load();
});
$("player-close").addEventListener("click", closePlayer);

// ---- File ops ----

function showFileContextMenu(x, y, file, rowEl) {
  const menu = $("context-menu");
  menu.innerHTML = "";
  const isPlayable = file.ext === "mp3" || file.ext === "mp4" || file.ext === "m4a";

  const items = [];
  if (isPlayable) items.push({ label: "Play", fn: () => play(file) });
  items.push({ label: "Rename...", fn: () => beginRename(rowEl, file) });
  items.push({ label: "Move to folder...", fn: () => openMoveModal(file) });
  items.push({ label: "Reveal in Finder", fn: () => reveal(file.rel_path) });
  items.push({ label: "Re-categorize (AI)", fn: () => reclassify(file) });
  items.push({ sep: true });
  items.push({ label: "Delete", danger: true, fn: () => deleteFile(file) });

  for (const it of items) {
    if (it.sep) {
      const s = document.createElement("div");
      s.className = "sep";
      menu.appendChild(s);
      continue;
    }
    const el = document.createElement("div");
    el.className = "item" + (it.danger ? " danger" : "");
    el.textContent = it.label;
    el.addEventListener("click", () => {
      menu.classList.add("hidden");
      it.fn();
    });
    menu.appendChild(el);
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - 220) + "px";
  menu.style.top = Math.min(y, vh - 240) + "px";
  menu.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  const menu = $("context-menu");
  if (!menu.contains(e.target)) menu.classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.code === "Escape") $("context-menu").classList.add("hidden");
});

function beginRename(rowEl, file) {
  const nameEl = rowEl.querySelector(".name");
  if (!nameEl) return;
  const originalText = nameEl.textContent;
  nameEl.classList.add("editing");
  nameEl.contentEditable = "plaintext-only";
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const cleanup = () => {
    nameEl.classList.remove("editing");
    nameEl.contentEditable = "false";
    nameEl.removeEventListener("keydown", onKey);
    nameEl.removeEventListener("blur", onBlur);
  };

  const commit = async () => {
    const newName = nameEl.textContent.trim();
    cleanup();
    if (!newName || newName === originalText) {
      nameEl.textContent = originalText;
      return;
    }
    try {
      const res = await fetch(`${HELPER}/file/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: currentRoot, old_path: file.rel_path, new_name: newName }),
      });
      if (!res.ok) {
        const t = await res.text();
        let m = t;
        try { m = JSON.parse(t).detail || t; } catch {}
        throw new Error(m);
      }
      load();
    } catch (e) {
      alert(`Rename failed: ${e.message}`);
      nameEl.textContent = originalText;
    }
  };

  const onKey = (e) => {
    if (e.code === "Enter") { e.preventDefault(); commit(); }
    if (e.code === "Escape") { e.preventDefault(); cleanup(); nameEl.textContent = originalText; }
  };
  const onBlur = () => commit();
  nameEl.addEventListener("keydown", onKey);
  nameEl.addEventListener("blur", onBlur, { once: true });
}

async function openMoveModal(file) {
  const modal = $("move-modal");
  const input = $("move-input");
  const list = $("move-suggestions");
  const currentDir = file.rel_path.split("/").slice(0, -1).join("/");
  input.value = currentDir;
  list.innerHTML = `<div class="row">Loading...</div>`;
  modal.classList.remove("hidden");
  input.focus();

  let folders = [];
  try {
    const r = await fetch(`${HELPER}/folders?root=${currentRoot}`);
    if (r.ok) folders = (await r.json()).folders || [];
  } catch {}
  renderSuggestions(folders, currentDir);

  function renderSuggestions(all, q) {
    const filtered = q
      ? all.filter((f) => f.toLowerCase().includes(q.toLowerCase()))
      : all;
    list.innerHTML = "";
    if (!filtered.length) {
      list.innerHTML = `<div class="row" style="color:#777">No matching folders. The input value will be used as a new path.</div>`;
      return;
    }
    for (const f of filtered.slice(0, 50)) {
      const row = document.createElement("div");
      row.className = "row";
      row.textContent = f;
      row.addEventListener("click", () => { input.value = f; });
      list.appendChild(row);
    }
  }

  const onInput = () => renderSuggestions(folders, input.value.trim());
  const confirmBtn = $("move-confirm");
  const cancelBtn = $("move-cancel");

  const close = () => {
    modal.classList.add("hidden");
    input.removeEventListener("input", onInput);
    confirmBtn.removeEventListener("click", onConfirm);
    cancelBtn.removeEventListener("click", close);
  };
  const onConfirm = async () => {
    const target = input.value.trim();
    if (target === currentDir) { close(); return; }
    try {
      const res = await fetch(`${HELPER}/file/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: currentRoot, old_path: file.rel_path, new_dir: target }),
      });
      if (!res.ok) {
        const t = await res.text();
        let m = t;
        try { m = JSON.parse(t).detail || t; } catch {}
        throw new Error(m);
      }
      close();
      load();
    } catch (e) {
      alert(`Move failed: ${e.message}`);
    }
  };

  input.addEventListener("input", onInput);
  confirmBtn.addEventListener("click", onConfirm);
  cancelBtn.addEventListener("click", close);
}

async function reclassify(file) {
  if (!confirm(`Re-ask AI to categorize "${file.title || file.stem}"?\nFile will be moved if the AI picks a different folder.`)) return;
  try {
    const res = await fetch(`${HELPER}/file/reclassify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: currentRoot, path: file.rel_path }),
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data.detail || text);
    if (data.moved) {
      alert(`Moved to ${data.folder} (${data.content_type})`);
    } else {
      alert(`Already in ${data.folder}. Tagged as ${data.content_type}.`);
    }
    load();
  } catch (e) {
    alert(`Reclassify failed: ${e.message}`);
  }
}

async function createFolderHere() {
  const name = prompt(`New folder name (in ${currentPath || "root"}):`);
  if (!name) return;
  const clean = name.trim();
  if (!clean) return;
  const path = currentPath ? `${currentPath}/${clean}` : clean;
  try {
    const res = await fetch(`${HELPER}/folder/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root: currentRoot, path }),
    });
    if (!res.ok) throw new Error(await res.text());
    load();
  } catch (e) {
    alert(`Create folder failed: ${e.message}`);
  }
}

$("new-folder").addEventListener("click", createFolderHere);

window.addEventListener("beforeunload", () => {
  if (currentFile) {
    const m = getActiveMedia();
    if (m && m.currentTime > 0) {
      navigator.sendBeacon &&
        navigator.sendBeacon(
          `${HELPER}/db/position`,
          new Blob(
            [
              JSON.stringify({
                root: currentFile.root,
                path: currentFile.rel_path,
                position_sec: m.currentTime,
                duration_sec: m.duration || null,
              }),
            ],
            { type: "application/json" },
          ),
        );
    }
  }
});

checkStatus();
load();
