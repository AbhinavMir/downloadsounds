const HELPER = "http://127.0.0.1:7531";

const $ = (id) => document.getElementById(id);
let allItems = [];
let libraryRoot = "";
let currentRoot = "audio";

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
  });
});

$("open-browser").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("library.html") + "?root=" + currentRoot });
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

checkStatus();
loadLibrary();
