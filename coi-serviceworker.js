// coi-serviceworker — installs a service worker that adds COOP/COEP headers
// to every response, making the page cross-origin isolated. That in turn
// unlocks SharedArrayBuffer, which lets us use the multi-threaded
// ffmpeg-core build (~4 GB heap, multi-threaded x264, much faster).
//
// Adapted from https://github.com/gzuidhof/coi-serviceworker (MIT).
// The script is dual-purpose: when loaded by the page it registers the SW;
// when fetched by the browser as the SW itself (typeof window === undefined),
// it runs the intercept logic.

(function () {
  // ============ Service-worker context ============
  if (typeof window === "undefined") {
    self.addEventListener("install", () => self.skipWaiting());
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

    self.addEventListener("fetch", (event) => {
      if (event.request.cache === "only-if-cached" && event.request.mode !== "same-origin") return;

      // For no-cors cross-origin fetches, strip credentials so the response
      // can be loaded under COEP=credentialless without needing CORP headers.
      const request = event.request.mode === "no-cors"
        ? new Request(event.request, { credentials: "omit" })
        : event.request;

      event.respondWith(
        fetch(request)
          .then((response) => {
            if (response.status === 0) return response;
            const headers = new Headers(response.headers);
            headers.set("Cross-Origin-Embedder-Policy", "credentialless");
            headers.set("Cross-Origin-Opener-Policy", "same-origin");
            return new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          })
          .catch((err) => console.error("COI sw fetch error:", err))
      );
    });
    return;
  }

  // ============ Page context ============
  if (window.crossOriginIsolated) return;            // already isolated, nothing to do
  if (!window.isSecureContext) return;               // SW needs https / localhost
  if (!("serviceWorker" in navigator)) return;       // browser support gate

  // Avoid reload loops: if we already reloaded this session and still aren't
  // isolated, give up and run single-threaded.
  const RELOAD_FLAG = "coi-sw-reloaded";
  if (sessionStorage.getItem(RELOAD_FLAG)) {
    sessionStorage.removeItem(RELOAD_FLAG);
    return;
  }

  navigator.serviceWorker
    .register(document.currentScript.src)
    .then((reg) => {
      const reload = () => {
        sessionStorage.setItem(RELOAD_FLAG, "1");
        window.location.reload();
      };
      // First-install: SW activates, then we reload so it controls this page.
      reg.addEventListener("updatefound", reload);
      if (reg.active && !navigator.serviceWorker.controller) reload();
    })
    .catch((err) => console.error("COI register failed:", err));
})();
