const CACHE_NAME = "kurochan-shell-v3";
const APP_BASE = new URL("./", self.registration.scope);
const SHELL_FILES = [
  "",
  "app.css",
  "app.js",
  "api.mjs",
  "integrations.mjs",
  "markdown.mjs",
  "manifest.webmanifest",
  "icons/kurochan.svg",
];
const SHELL = SHELL_FILES.map((path) => new URL(path, APP_BASE).pathname);
const APP_ROOT_PATH = new URL("./", APP_BASE).pathname;
const API_PATH = new URL("v1/", APP_BASE).pathname;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("kurochan-shell-") && key !== CACHE_NAME,
            )
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache conversations, run data, health responses, or any API payload.
  if (
    url.pathname.startsWith(API_PATH) ||
    url.pathname === new URL("healthz", APP_BASE).pathname ||
    url.pathname === new URL("readyz", APP_BASE).pathname
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        async () => (await caches.match(APP_BASE.href)) || Response.error(),
      ),
    );
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    }),
  );
});
