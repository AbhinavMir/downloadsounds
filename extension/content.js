(function () {
  const HELPER = "http://127.0.0.1:7531";
  const WRAP_ID = "ytd-dj-buttons";
  const LABELS = { audio: "Download MP3", video: "Download Video" };
  const DONE_LABELS = { audio: "Audio downloaded", video: "Video downloaded" };

  function findAnchor() {
    return (
      document.querySelector("#top-level-buttons-computed") ||
      document.querySelector("ytd-menu-renderer #top-level-buttons-computed") ||
      document.querySelector("#actions #actions-inner") ||
      document.querySelector("#actions-inner")
    );
  }

  function setState(btn, state, text) {
    const baseCls = btn.dataset.baseClass;
    btn.className = baseCls + (state ? " ytd-dj-" + state : "");
    btn.textContent = text;
  }

  function setDownloaded(btn, kind, relPath) {
    btn.dataset.downloadedPath = relPath;
    btn.disabled = false;
    btn.title = `Saved at ${relPath} — click to reveal in Finder`;
    setState(btn, "done", DONE_LABELS[kind]);
  }

  function clearDownloaded(btn, kind) {
    delete btn.dataset.downloadedPath;
    btn.title = "";
    setState(btn, null, LABELS[kind]);
  }

  async function handleClick(btn, kind) {
    if (btn.dataset.downloadedPath) {
      try {
        await fetch(
          `${HELPER}/reveal?root=${kind}&path=${encodeURIComponent(btn.dataset.downloadedPath)}`,
          { method: "POST" },
        );
      } catch (e) {
        console.error("[YTD DJ] reveal failed", e);
      }
      return;
    }

    btn.disabled = true;
    setState(btn, null, kind === "video" ? "Downloading video..." : "Downloading...");
    try {
      const res = await fetch(`${HELPER}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: location.href, kind }),
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = text;
        try { msg = JSON.parse(text).detail || text; } catch (_) {}
        throw new Error(msg);
      }
      const data = JSON.parse(text);
      setState(btn, "ok", `Saved → ${data.folder}`);
      setTimeout(() => setDownloaded(btn, kind, data.rel_path), 2200);
    } catch (e) {
      const msg = e.message || String(e);
      const short = msg.length > 60 ? msg.slice(0, 57) + "..." : msg;
      setState(btn, "err", short);
      setTimeout(() => clearDownloaded(btn, kind), 4000);
    } finally {
      btn.disabled = false;
    }
  }

  function makeButton(kind, klass) {
    const btn = document.createElement("button");
    btn.className = klass;
    btn.dataset.baseClass = klass;
    btn.dataset.kind = kind;
    btn.textContent = LABELS[kind];
    btn.addEventListener("click", () => handleClick(btn, kind));
    return btn;
  }

  async function applyExistingStatus(audioBtn, videoBtn) {
    try {
      const res = await fetch(`${HELPER}/check?url=${encodeURIComponent(location.href)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.audio) setDownloaded(audioBtn, "audio", data.audio);
      if (data.video) setDownloaded(videoBtn, "video", data.video);
    } catch (e) {
      // Helper not running — leave buttons in default state.
    }
  }

  function injectButtons() {
    if (!location.href.includes("youtube.com/watch")) return;
    if (document.getElementById(WRAP_ID)) return;
    const anchor = findAnchor();
    if (!anchor) return;
    const wrap = document.createElement("span");
    wrap.id = WRAP_ID;
    const audioBtn = makeButton("audio", "ytd-dj-btn ytd-dj-audio");
    const videoBtn = makeButton("video", "ytd-dj-btn ytd-dj-video");
    wrap.appendChild(audioBtn);
    wrap.appendChild(videoBtn);
    anchor.appendChild(wrap);
    applyExistingStatus(audioBtn, videoBtn);
  }

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const existing = document.getElementById(WRAP_ID);
      if (existing) existing.remove();
    }
    injectButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  setTimeout(injectButtons, 800);
  setTimeout(injectButtons, 2000);
})();
