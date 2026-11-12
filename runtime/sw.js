// Serves an emulator the page holds (the zip it fetched) from this page's own origin.
//
// A plugin is loaded by URL and may start workers and import siblings, all of which a browser only
// allows from a real same-origin URL. So /local/<path> is answered here, by asking the page that
// holds the files for that one file. Nothing is copied, and nothing is kept here: a service
// worker can be stopped at any moment, and the page is what lives as long as the game does.

const TYPES = { js: "text/javascript", mjs: "text/javascript", json: "application/json", wasm: "application/wasm" };

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith("/local/")) return;
  event.respondWith(serve(decodeURIComponent(url.pathname.slice("/local/".length))));
});

async function serve(path) {
  for (const client of await self.clients.matchAll({ type: "window" })) {
    const file = await ask(client, path);
    if (file) {
      const type = TYPES[path.split(".").pop().toLowerCase()] ?? "application/octet-stream";
      return new Response(file, {
        headers: {
          "content-type": type,
          // So a worker started from here is cross-origin isolated like the page.
          "cross-origin-embedder-policy": "require-corp",
          "cross-origin-resource-policy": "same-origin",
        },
      });
    }
  }
  return new Response("not found", { status: 404 });
}

/** The page's `File` for `path`, or null. A window that never answers (one still loading) is null. */
function ask(client, path) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    client.postMessage({ gemsLocalFile: path }, [channel.port2]);
    setTimeout(() => resolve(null), 5000);
  });
}
