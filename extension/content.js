(function () {
  const HELPER = "http://127.0.0.1:7531";
  const WRAP_ID = "ytd-dj-buttons";
  const SELECT_ID = "ytd-dj-model";
  const STORAGE_KEY = "ytd-dj-model-override";
  const LABELS = { audio: "Download MP3", video: "Download Video" };
  const DONE_LABELS = { audio: "Audio downloaded", video: "Video downloaded" };

  const MODEL_PRESETS = {
    anthropic: [
      { value: "", label: "Default" },
      { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (cheap)" },
      { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
      { value: "claude-opus-4-8", label: "Opus 4.8 (best)" },
    ],
    openai: [
      { value: "", label: "Default" },
      { value: "gpt-4o-mini", label: "GPT-4o mini" },
      { value: "gpt-4o", label: "GPT-4o" },
      { value: "gpt-5", label: "GPT-5" },
    ],
    ollama: [
      { value: "", label: "Default" },
    ],
  };

  let activeProvider = null;
  let modelOverride = "";

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
      const body = { url: location.href, kind };
      if (modelOverride) body.model = modelOverride;
      const res = await fetch(`${HELPER}/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  function makeModelSelect() {
    const sel = document.createElement("select");
    sel.id = SELECT_ID;
    sel.className = "ytd-dj-select";
    sel.title = "Override the AI model for this download";
    rebuildSelectOptions(sel);
    sel.addEventListener("change", () => {
      modelOverride = sel.value;
      saveOverride(modelOverride);
    });
    return sel;
  }

  function rebuildSelectOptions(sel) {
    const presets = MODEL_PRESETS[activeProvider] || MODEL_PRESETS.anthropic;
    sel.innerHTML = "";
    let found = false;
    for (const p of presets) {
      const opt = document.createElement("option");
      opt.value = p.value;
      opt.textContent = p.label;
      sel.appendChild(opt);
      if (p.value === modelOverride) found = true;
    }
    if (modelOverride && !found) {
      const opt = document.createElement("option");
      opt.value = modelOverride;
      opt.textContent = modelOverride;
      sel.appendChild(opt);
    }
    sel.value = modelOverride || "";
  }

  function saveOverride(value) {
    try {
      if (chrome?.storage?.local) {
        chrome.storage.local.set({ [STORAGE_KEY]: value });
      } else {
        localStorage.setItem(STORAGE_KEY, value);
      }
    } catch (_) {}
  }

  function loadOverride() {
    return new Promise((resolve) => {
      try {
        if (chrome?.storage?.local) {
          chrome.storage.local.get([STORAGE_KEY], (r) => resolve(r[STORAGE_KEY] || ""));
          return;
        }
      } catch (_) {}
      resolve(localStorage.getItem(STORAGE_KEY) || "");
    });
  }

  async function fetchProvider() {
    try {
      const res = await fetch(`${HELPER}/status`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.provider && data.provider !== activeProvider) {
        activeProvider = data.provider;
        const sel = document.getElementById(SELECT_ID);
        if (sel) rebuildSelectOptions(sel);
      }
    } catch (_) {}
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
    wrap.appendChild(makeModelSelect());
    anchor.appendChild(wrap);
    applyExistingStatus(audioBtn, videoBtn);
    fetchProvider();
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

  loadOverride().then((saved) => {
    modelOverride = saved || "";
  });

  setTimeout(injectButtons, 800);
  setTimeout(injectButtons, 2000);
})();
