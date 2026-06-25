const HELPER = "http://127.0.0.1:7531";
const VERSION_URL = "https://raw.githubusercontent.com/AbhinavMir/downloadsounds/main/VERSION";

const $ = (id) => document.getElementById(id);
let allItems = [];
let libraryRoot = "";
let currentRoot = "audio";

// All popup playback is delegated to a hidden offscreen document so audio
// survives the popup being closed. The popup is purely a remote control:
// it sends commands and renders the latest broadcast state.

let ppCurrent = null; // mirror of offscreen's current track
let ppPaused = true;
let ppDuration = 0;
let ppCurrentTime = 0;
let pollTimer = null;

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function sendAudioCmd(cmd, extra = {}) {
  try {
    await chrome.runtime.sendMessage({ type: "ensure-audio" });
    return await chrome.runtime.sendMessage({ type: "audio-cmd", cmd, ...extra });
  } catch (e) {
    console.error("[YTD DJ popup] audio cmd failed", cmd, e);
    return null;
  }
}

function renderPlayerState() {
  const bar = $("pp-bar");
  if (!ppCurrent) {
    bar.classList.add("hidden");
    highlightPlayingRow(null);
    return;
  }
  bar.classList.remove("hidden");
  const stem = ppCurrent.rel_path.split("/").pop().replace(/\.[^.]+$/, "");
  $("pp-title").textContent = ppCurrent.title || stem;
  $("pp-meta").textContent = ppCurrent.rel_path;
  $("pp-cur").textContent = fmtTime(ppCurrentTime);
  $("pp-dur").textContent = fmtTime(ppDuration);
  const pct = ppDuration ? Math.min(100, (100 * ppCurrentTime) / ppDuration) : 0;
  $("pp-bar-fill").style.width = pct + "%";
  $("pp-toggle").textContent = ppPaused ? "▶" : "❚❚";
  highlightPlayingRow(ppCurrent.rel_path);
}

function applyState(state) {
  if (!state) return;
  ppCurrent = state.current;
  ppPaused = state.paused;
  ppDuration = state.duration || 0;
  ppCurrentTime = state.currentTime || 0;
  renderPlayerState();
}

function highlightPlayingRow(rel_path) {
  document.querySelectorAll(".item.playing").forEach((el) => el.classList.remove("playing"));
  if (!rel_path) return;
  document.querySelectorAll(".item").forEach((el) => {
    if (el.dataset.path === rel_path) el.classList.add("playing");
  });
}

async function ppPlay(rel_path, info = {}) {
  // Video files: hand off to the library tab.
  const ext = (rel_path.split(".").pop() || "").toLowerCase();
  if (currentRoot !== "audio" || (ext !== "mp3" && ext !== "m4a")) {
    chrome.tabs.create({
      url: chrome.runtime.getURL("library.html") + "?root=" + currentRoot,
    });
    return;
  }
  const state = await sendAudioCmd("play", { root: currentRoot, path: rel_path, title: info.title });
  applyState(state);
}

async function ppToggle() {
  const state = await sendAudioCmd("toggle");
  applyState(state);
}

async function ppSeekBy(delta) {
  const state = await sendAudioCmd("seek", { to: ppCurrentTime + delta });
  applyState(state);
}

async function ppSeekTo(frac) {
  if (!ppDuration) return;
  const state = await sendAudioCmd("seek", { to: ppDuration * frac });
  applyState(state);
}

async function ppClose() {
  const state = await sendAudioCmd("close");
  applyState(state);
}

$("pp-toggle").addEventListener("click", ppToggle);
$("pp-back").addEventListener("click", () => ppSeekBy(-10));
$("pp-fwd").addEventListener("click", () => ppSeekBy(10));
$("pp-close").addEventListener("click", ppClose);
$("pp-bar-track").addEventListener("click", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = (e.clientX - rect.left) / rect.width;
  ppSeekTo(Math.max(0, Math.min(1, frac)));
});

// Listen for broadcast state updates from the offscreen player.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "audio-state") applyState(msg.state);
});

// Poll once on open and on a slow interval as a safety net for missed
// broadcasts. The chrome.runtime.sendMessage events are best-effort.
async function pollOffscreenState() {
  const state = await sendAudioCmd("state");
  if (state) applyState(state);
}

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
pollOffscreenState();
pollTimer = setInterval(pollOffscreenState, 1000);
window.addEventListener("beforeunload", () => {
  if (pollTimer) clearInterval(pollTimer);
});
