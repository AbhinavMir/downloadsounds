// The popup's audio commands route through here so the offscreen
// document is guaranteed to exist before the command is sent.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

const OFFSCREEN_URL = "offscreen.html";

let creating = null;

async function ensureOffscreen() {
  // hasDocument() exists on Chrome 116+; fall back to a creation attempt.
  try {
    const has = await chrome.offscreen.hasDocument?.();
    if (has) return;
  } catch (_) {}
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Persistent media playback when the popup is closed.",
    })
    .catch((e) => {
      // Already exists race -> ignore. Anything else, propagate.
      if (!String(e).includes("Only a single offscreen document")) throw e;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ensure-audio") {
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
});
