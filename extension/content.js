(function () {
  const HELPER = "http://127.0.0.1:7531";
  const WRAP_ID = "ytd-dj-buttons";

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

  async function handleClick(btn, kind, defaultLabel) {
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
    } catch (e) {
      const msg = e.message || String(e);
      const short = msg.length > 60 ? msg.slice(0, 57) + "..." : msg;
      setState(btn, "err", short);
      console.error("[YTD DJ]", e);
    } finally {
      setTimeout(() => {
        setState(btn, null, defaultLabel);
        btn.disabled = false;
      }, 4000);
    }
  }

  function makeButton(kind, label, klass) {
    const btn = document.createElement("button");
    btn.className = klass;
    btn.dataset.baseClass = klass;
    btn.textContent = label;
    btn.addEventListener("click", () => handleClick(btn, kind, label));
    return btn;
  }

  function injectButtons() {
    if (!location.href.includes("youtube.com/watch")) return;
    if (document.getElementById(WRAP_ID)) return;
    const anchor = findAnchor();
    if (!anchor) return;
    const wrap = document.createElement("span");
    wrap.id = WRAP_ID;
    wrap.appendChild(makeButton("audio", "Download MP3", "ytd-dj-btn ytd-dj-audio"));
    wrap.appendChild(makeButton("video", "Download Video", "ytd-dj-btn ytd-dj-video"));
    anchor.appendChild(wrap);
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
