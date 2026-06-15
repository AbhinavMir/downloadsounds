const HELPER = "http://127.0.0.1:7531";
const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
let currentRoot = params.get("root") === "video" ? "video" : "audio";
let currentPath = "";
let currentData = null;

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
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
    el.textContent = parts.length ? "Helper up — " + parts.join(", ") : "Helper up";
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
    renderBrowser();
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
  if (currentPath) {
    rootEl.addEventListener("click", () => navigate(""));
  }
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

function renderBrowser() {
  const main = $("browser");
  const q = ($("filter").value || "").trim();
  const folders = applyFilter(currentData.folders, q);
  const files = applyFilter(currentData.files, q);

  if (!folders.length && !files.length) {
    main.innerHTML = `<div class="empty">${q ? "No matches." : "Empty folder."}</div>`;
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
    const e = document.createElement("div");
    e.className = "entry file";
    e.dataset.path = f.rel_path;
    e.innerHTML = `
      <div class="icon">${f.ext === "mp4" ? "🎬" : "🎵"}</div>
      <div class="body">
        <div class="name"></div>
        <div class="meta">${fmtSize(f.size_bytes)}</div>
      </div>
      <div class="actions">
        ${isPlayable ? `<button class="action-btn play" title="Play">▶</button>` : ""}
        <button class="action-btn reveal" title="Reveal in Finder">↗</button>
        <button class="action-btn danger del" title="Delete">🗑</button>
      </div>
    `;
    e.querySelector(".name").textContent = f.stem;
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
    frag.appendChild(e);
  }

  main.innerHTML = "";
  main.appendChild(frag);
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
    load();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
  }
}

function play(f) {
  const bar = $("player-bar");
  const audio = $("player-audio");
  const video = $("player-video");
  const url = `${HELPER}/file?root=${currentRoot}&path=${encodeURIComponent(f.rel_path)}`;

  document.querySelectorAll(".entry.file.playing").forEach((e) => e.classList.remove("playing"));
  const row = document.querySelector(`.entry.file[data-path="${CSS.escape(f.rel_path)}"]`);
  if (row) row.classList.add("playing");

  $("player-title").textContent = f.stem;
  $("player-path").textContent = `${currentRoot === "video" ? "~/YTD_DJ_Video/" : "~/YTD_DJ/"}${f.rel_path}`;

  if (f.ext === "mp4") {
    audio.pause();
    audio.src = "";
    audio.classList.add("hidden");
    video.classList.remove("hidden");
    video.src = url;
    video.play().catch(() => {});
  } else {
    video.pause();
    video.src = "";
    video.classList.add("hidden");
    audio.classList.remove("hidden");
    audio.src = url;
    audio.play().catch(() => {});
  }
  bar.classList.remove("hidden");
}

function closePlayer() {
  $("player-audio").pause();
  $("player-audio").src = "";
  $("player-video").pause();
  $("player-video").src = "";
  $("player-bar").classList.add("hidden");
  document.querySelectorAll(".entry.file.playing").forEach((e) => e.classList.remove("playing"));
}

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

checkStatus();
load();
