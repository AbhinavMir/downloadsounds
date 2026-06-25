const HELPER = "http://127.0.0.1:7531";
const VERSION_URL = "https://raw.githubusercontent.com/AbhinavMir/downloadsounds/main/VERSION";

const $ = (id) => document.getElementById(id);
let allItems = [];
let libraryRoot = "";
let currentRoot = "audio";

// Popup-scoped player state
let ppCurrent = null; // {root, rel_path, stem, ext, completed}
let ppLastSaveAt = 0;
const PP_THROTTLE_MS = 2000;

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ppFlushPosition() {
  if (!ppCurrent) return;
  const audio = $("pp-audio");
  if (!audio.currentTime) return;
  fetch(`${HELPER}/db/position`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root: ppCurrent.root,
      path: ppCurrent.rel_path,
      position_sec: audio.currentTime,
      duration_sec: audio.duration || null,
    }),
  }).catch(() => {});
}

function ppFlushBeacon() {
  if (!ppCurrent) return;
  const audio = $("pp-audio");
  if (!audio.currentTime) return;
  try {
    navigator.sendBeacon(
      `${HELPER}/db/position`,
      new Blob(
        [
          JSON.stringify({
            root: ppCurrent.root,
            path: ppCurrent.rel_path,
            position_sec: audio.currentTime,
            duration_sec: audio.duration || null,
          }),
        ],
        { type: "application/json" },
      ),
    );
  } catch (_) {}
}

function ppMarkCompleted() {
  if (!ppCurrent) return;
  fetch(`${HELPER}/db/completed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: ppCurrent.root, path: ppCurrent.rel_path, completed: true }),
  }).catch(() => {});
}

async function ppPlay(rel_path, info = {}) {
  const audio = $("pp-audio");
  const bar = $("pp-bar");

  // Persist whatever was playing before swapping.
  if (ppCurrent) ppFlushPosition();

  // Audio-only in popup. Video plays in the library tab.
  const ext = (rel_path.split(".").pop() || "").toLowerCase();
  if (currentRoot !== "audio" || (ext !== "mp3" && ext !== "m4a")) {
    chrome.tabs.create({
      url: chrome.runtime.getURL("library.html") + "?root=" + currentRoot,
    });
    return;
  }

  ppCurrent = {
    root: currentRoot,
    rel_path,
    completed: false,
  };
  ppLastSaveAt = 0;

  audio.src = `${HELPER}/file?root=${currentRoot}&path=${encodeURIComponent(rel_path)}`;
  $("pp-title").textContent = info.title || rel_path.split("/").pop().replace(/\.[^.]+$/, "");
  $("pp-meta").textContent = rel_path;

  let resumeAt = 0;
  try {
    const r = await fetch(`${HELPER}/db/file?root=${currentRoot}&path=${encodeURIComponent(rel_path)}`);
    if (r.ok) {
      const rec = await r.json();
      if (rec && rec.position_sec > 0 && !rec.completed) resumeAt = rec.position_sec;
      ppCurrent.completed = !!rec?.completed;
    }
  } catch (_) {}

  audio.addEventListener(
    "loadedmetadata",
    () => {
      if (resumeAt > 0 && resumeAt < (audio.duration || Infinity) - 2) {
        audio.currentTime = resumeAt;
      }
      audio.play().catch(() => {});
    },
    { once: true },
  );

  highlightPlayingRow(rel_path);
  bar.classList.remove("hidden");
}

function highlightPlayingRow(rel_path) {
  document.querySelectorAll(".item.playing").forEach((el) => el.classList.remove("playing"));
  document.querySelectorAll(".item").forEach((el) => {
    if (el.dataset.path === rel_path) el.classList.add("playing");
  });
}

function ppClose() {
  const audio = $("pp-audio");
  if (ppCurrent) ppFlushPosition();
  audio.pause();
  audio.removeAttribute("src");
  ppCurrent = null;
  $("pp-bar").classList.add("hidden");
  document.querySelectorAll(".item.playing").forEach((el) => el.classList.remove("playing"));
}

$("pp-audio").addEventListener("timeupdate", () => {
  if (!ppCurrent) return;
  const audio = $("pp-audio");
  const now = performance.now();
  if (now - ppLastSaveAt >= PP_THROTTLE_MS) {
    ppLastSaveAt = now;
    ppFlushPosition();
  }
  if (audio.duration && !ppCurrent.completed && audio.currentTime / audio.duration > 0.9) {
    ppCurrent.completed = true;
    ppMarkCompleted();
  }
});
$("pp-audio").addEventListener("pause", () => {
  if (ppCurrent) {
    ppLastSaveAt = performance.now();
    ppFlushPosition();
  }
});
$("pp-audio").addEventListener("ended", () => {
  if (ppCurrent && !ppCurrent.completed) {
    ppCurrent.completed = true;
    ppMarkCompleted();
  }
});
$("pp-close").addEventListener("click", ppClose);
window.addEventListener("beforeunload", ppFlushBeacon);

async function renderContinueSection() {
  const section = $("continue-section");
  const list = $("continue-list");
  if (currentRoot !== "audio") {
    section.classList.add("hidden");
    return;
  }
  try {
    const r = await fetch(`${HELPER}/db/continue?root=${currentRoot}&limit=6`);
    if (!r.ok) throw new Error();
    const data = await r.json();
    if (!data.items?.length) {
      section.classList.add("hidden");
      return;
    }
    list.innerHTML = "";
    for (const it of data.items) {
      const row = document.createElement("div");
      row.className = "continue-row";
      const dur = it.duration_sec || 0;
      const pct = dur ? Math.min(100, Math.round((100 * it.position_sec) / dur)) : 0;
      const stem = it.rel_path.split("/").pop().replace(/\.[^.]+$/, "");
      row.innerHTML = `
        <span class="ttl"></span>
        <span class="pos">${fmtTime(it.position_sec)}${dur ? " / " + fmtTime(dur) : ""}</span>
        <div class="bar"><div style="width:${pct}%"></div></div>
      `;
      row.querySelector(".ttl").textContent = it.title || stem;
      row.title = it.rel_path;
      row.addEventListener("click", () => ppPlay(it.rel_path, { title: it.title }));
      list.appendChild(row);
    }
    section.classList.remove("hidden");
  } catch {
    section.classList.add("hidden");
  }
}

async function checkForUpdate() {
  const local = chrome.runtime.getManifest().version;
  let latest = null;
  try {
    const r = await fetch(VERSION_URL, { cache: "no-store" });
    if (r.ok) latest = (await r.text()).trim();
  } catch {}
  if (!latest || latest === local) return;

  const banner = $("update-banner");
  $("update-text").textContent = `Update available: ${local} → ${latest}`;
  banner.classList.remove("hidden", "success", "error");
}

async function applyUpdate() {
  const banner = $("update-banner");
  const btn = $("update-btn");
  btn.disabled = true;
  $("update-text").textContent = "Updating...";
  try {
    const res = await fetch(`${HELPER}/update`, { method: "POST" });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    if (!res.ok) throw new Error(data.detail || text || "Update failed");
    if (data.updated) {
      $("update-text").textContent = `Updated ${data.before} → ${data.after}. Reloading...`;
      banner.classList.add("success");
      setTimeout(() => chrome.runtime.reload(), 2500);
    } else {
      $("update-text").textContent = "Already up to date.";
      banner.classList.add("success");
      setTimeout(() => banner.classList.add("hidden"), 2000);
    }
  } catch (e) {
    $("update-text").textContent = `Update failed: ${e.message}`;
    banner.classList.add("error");
    btn.disabled = false;
  }
}

async function checkStatus() {
  const el = $("status");
  try {
    const res = await fetch(`${HELPER}/status`);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    const parts = [];
    if (!data.ffmpeg) parts.push("ffmpeg missing");
    if (!data.has_api_key) parts.push("no API key");
    if (parts.length) {
      el.className = "status err";
      el.textContent = "Helper up — " + parts.join(", ");
    } else {
      el.className = "status ok";
      el.textContent = `Helper up`;
    }
  } catch (e) {
    el.className = "status err";
    el.textContent = "Helper not running — start helper/run.sh";
  }
}

async function loadLibrary() {
  const lib = $("library");
  lib.textContent = "Loading...";
  try {
    const res = await fetch(`${HELPER}/library?root=${currentRoot}`);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    allItems = data.items;
    libraryRoot = data.root;
    render();
  } catch (e) {
    lib.innerHTML = `<div class="empty">Couldn't load library.<br>Is the helper running?</div>`;
    $("count").textContent = "";
  }
}

function render() {
  const lib = $("library");
  const q = ($("filter").value || "").toLowerCase().trim();
  const items = q
    ? allItems.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.top_folder.toLowerCase().includes(q) ||
          i.sub_folder.toLowerCase().includes(q),
      )
    : allItems;

  $("count").textContent = `${items.length} ${currentRoot === "video" ? "video" : "track"}${items.length === 1 ? "" : "s"}`;

  if (!items.length) {
    lib.innerHTML = q
      ? `<div class="empty">No matches.</div>`
      : `<div class="empty">${currentRoot === "video" ? "Video" : "Audio"} library is empty.</div>`;
    return;
  }

  const groups = new Map();
  for (const it of items) {
    const key = it.top_folder + (it.sub_folder ? " / " + it.sub_folder : "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }

  const frag = document.createDocumentFragment();
  for (const [key, list] of groups) {
    const g = document.createElement("div");
    g.className = "group";
    const h = document.createElement("div");
    h.className = "group-header";
    h.textContent = key || "(root)";
    g.appendChild(h);
    for (const it of list) {
      const item = document.createElement("div");
      item.className = "item";
      item.textContent = it.name;
      item.title = it.rel_path;
      item.dataset.path = it.rel_path;
      item.addEventListener("click", () => ppPlay(it.rel_path, { title: it.name }));
      g.appendChild(item);
    }
    frag.appendChild(g);
  }
  lib.innerHTML = "";
  lib.appendChild(frag);
}

document.querySelectorAll(".tab[data-root]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab[data-root]").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentRoot = tab.dataset.root;
    loadLibrary();
    renderContinueSection();
  });
});

$("open-browser").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("library.html") + "?root=" + currentRoot });
});

$("open-settings").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

$("refresh").addEventListener("click", () => {
  checkStatus();
  loadLibrary();
});
$("filter").addEventListener("input", render);
$("open-folder").addEventListener("click", (e) => {
  e.preventDefault();
  if (libraryRoot) {
    navigator.clipboard?.writeText(libraryRoot);
    const a = e.currentTarget;
    const orig = a.textContent;
    a.textContent = "copied";
    setTimeout(() => (a.textContent = orig), 1500);
  }
});

$("update-btn").addEventListener("click", applyUpdate);

checkStatus();
loadLibrary();
renderContinueSection();
checkForUpdate();
