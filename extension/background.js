// Reserved for future use (e.g., context menu, badge updates).
// Currently a no-op; all logic runs in content.js and popup.js.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
