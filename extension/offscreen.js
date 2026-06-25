// Lives in a hidden offscreen document so playback survives the popup
// closing. Owns the only <audio> element used by the popup's player.
//
// Message protocol (chrome.runtime.sendMessage):
//
//   incoming { type: "audio-cmd", cmd, ...args }
//   outgoing { type: "audio-state", state }
//
// The cmd "state" returns a synchronous response with the current state.

const HELPER = "http://127.0.0.1:7531";
const POSITION_THROTTLE_MS = 2000;

const audio = document.getElementById("audio");
let current = null; // { root, rel_path, title, completed }
let lastSaveAt = 0;

function snapshot() {
  return {
    current,
    paused: audio.paused,
    currentTime: audio.currentTime || 0,
    duration: audio.duration || 0,
  };
}

function broadcast() {
  // Best-effort fan-out to popup. If no listeners, ignore the rejection.
  try {
    chrome.runtime.sendMessage({ type: "audio-state", state: snapshot() }).catch(() => {});
  } catch (_) {}
}

function flushPosition(immediate = false) {
  if (!current) return;
  const now = audio.currentTime;
  if (!now) return;
  if (!immediate) {
    const wallNow = performance.now();
    if (wallNow - lastSaveAt < POSITION_THROTTLE_MS) return;
    lastSaveAt = wallNow;
  } else {
    lastSaveAt = performance.now();
  }
  fetch(`${HELPER}/db/position`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root: current.root,
      path: current.rel_path,
      position_sec: now,
      duration_sec: audio.duration || null,
    }),
  }).catch(() => {});
}

function markCompleted() {
  if (!current) return;
  fetch(`${HELPER}/db/completed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root: current.root,
      path: current.rel_path,
      completed: true,
    }),
  }).catch(() => {});
}

audio.addEventListener("timeupdate", () => {
  if (!current) return;
  flushPosition();
  if (audio.duration && !current.completed && audio.currentTime / audio.duration > 0.9) {
    current.completed = true;
    markCompleted();
  }
  broadcast();
});
audio.addEventListener("pause", () => { flushPosition(true); broadcast(); });
audio.addEventListener("ended", () => {
  if (current && !current.completed) {
    current.completed = true;
    markCompleted();
  }
  broadcast();
});
audio.addEventListener("play", broadcast);
audio.addEventListener("loadedmetadata", broadcast);

async function fetchResumePoint(root, path) {
  try {
    const r = await fetch(`${HELPER}/db/file?root=${root}&path=${encodeURIComponent(path)}`);
    if (!r.ok) return { resumeAt: 0, completed: false };
    const rec = await r.json();
    const completed = !!rec?.completed;
    const resumeAt = !completed && rec?.position_sec > 0 ? rec.position_sec : 0;
    return { resumeAt, completed };
  } catch {
    return { resumeAt: 0, completed: false };
  }
}

async function handleCmd(msg) {
  switch (msg.cmd) {
    case "play": {
      // If switching tracks mid-playback, persist the old position first.
      if (current) flushPosition(true);

      const root = msg.root;
      const path = msg.path;
      const title = msg.title || null;

      // CRITICAL: fetch the resume point BEFORE setting audio.src.
      // Setting src starts loading; if metadata loads while we await the
      // fetch, the loadedmetadata event fires before we can attach a
      // listener and the seek is silently dropped (this was the bug in
      // 0.10.x).
      const { resumeAt, completed } = await fetchResumePoint(root, path);

      current = { root, rel_path: path, title, completed };
      lastSaveAt = 0;

      audio.addEventListener(
        "loadedmetadata",
        () => {
          if (resumeAt > 0 && resumeAt < (audio.duration || Infinity) - 2) {
            audio.currentTime = resumeAt;
          }
          audio.play().catch(() => {});
          broadcast();
        },
        { once: true },
      );

      audio.src = `${HELPER}/file?root=${root}&path=${encodeURIComponent(path)}`;
      broadcast();
      return snapshot();
    }
    case "pause":
      audio.pause();
      flushPosition(true);
      broadcast();
      return snapshot();
    case "resume":
      audio.play().catch(() => {});
      broadcast();
      return snapshot();
    case "toggle":
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
      broadcast();
      return snapshot();
    case "seek":
      if (typeof msg.to === "number" && !Number.isNaN(msg.to)) {
        audio.currentTime = Math.max(0, msg.to);
      }
      broadcast();
      return snapshot();
    case "close":
      if (current) flushPosition(true);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      current = null;
      broadcast();
      return snapshot();
    case "state":
      return snapshot();
    default:
      return { error: `unknown cmd: ${msg.cmd}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "audio-cmd") return;
  handleCmd(msg).then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
  return true;
});
