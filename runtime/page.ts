// The GEMS Playground's page: one thin caller of `host.ts`.
//
// The emulator is typed into the page as the URL of its update feed (§3.4, latest.json), and the
// latest version it lists is loaded; the last URL is remembered in localStorage. The query has
// nothing about it. What it does take:
//
//   ?game=<url>     a served game: <url>/index.json lists { path, size } (default: /game, if served);
//                   without one, the page asks for a game folder
//   ?id=<id>        the game id its saves are kept under (default: the game folder's name)
//   ?arg=<arg>      a launch argument (§7.5), repeatable
//   ?limited        limited-resources mode (§11): settings start from their `limited` values
//   ?net=<port>     a loopback port the game may connect to (§14), repeatable; each connection is a
//                   WebSocket to /net/<port>, which serve.ts pipes to that port on its machine

import { showDialog } from "./dialogs.ts";
import { httpFiles, pickedFiles } from "./files.ts";
import { run, StartFailed, type Running } from "./host.ts";
import { loadPlugin, parseUpdateFeed, PluginRefused } from "./plugin.ts";
import type { FileIndex, NetworkServices } from "./spec.ts";
import { unzip } from "./zip.ts";

const query = new URLSearchParams(location.search);
const stage = document.getElementById("stage")!;
const status = document.getElementById("status")!;
const emulatorForm = document.getElementById("emulator-form") as HTMLFormElement;
const emulatorInput = document.getElementById("emulator-url") as HTMLInputElement;
const gamePicker = document.getElementById("game-picker") as HTMLInputElement;
// shortcut: ids are static in index.html, so no null check
const el = (id: string) => document.getElementById(id)!;

/** What a driver reads to tell how the game is doing. */
const state: { status: string; running: Running | null } = { status: "loading", running: null };
(globalThis as { gems?: unknown }).gems = state;

const steps = [...document.querySelectorAll("#steps li")];
let step = 0;
/** Reports a status line; `next`, the loading stage it starts (the stages are #steps). */
const say = (line: string, next?: number) => {
  state.status = line;
  const failed = /^(error|refused)/.test(line);
  status.textContent = failed ? "error" : line;
  status.title = line;
  status.className = failed ? "error" : line === "running" ? "running" : "";
  console.log(`[gems] ${line}`);
  if (state.running) return;
  // Before the game runs, the lines move the loading screen along; a failure there stays on it.
  el("live").textContent = line;
  step = next ?? step;
  steps.forEach((li, i) => {
    li.className = i < step ? "done" : i > step ? "" : failed ? "failed" : "current";
    if (i === step) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  if (failed) {
    el("loading-title").textContent = "The game could not start";
    el("failure-title").textContent = `${steps[step]!.textContent} failed`;
    el("failure-text").textContent = line.replace(/^(error|refused): (Error: )?/, "");
    el("failure").hidden = false;
    el("back").focus();
  }
};
el("back").onclick = () => location.reload();

async function served(base: string): Promise<FileIndex | null> {
  const response = await fetch(`${base}/index.json`);
  return response.ok ? httpFiles(base, await response.json()) : null;
}

/** The top folder's name, which is what a picked game's saves are kept under by default. */
const folderName = (files: FileList) => files[0]!.webkitRelativePath.split("/")[0]!.replaceAll(":", "_");

/** A zipped emulator's files, fetched from `url`; `sha256` is what its feed says they hash to. */
async function zippedPlugin(url: string, sha256?: string): Promise<Map<string, Blob>> {
  const response = await fetch(url);
  if (!response.ok) throw new PluginRefused(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256 !== undefined) {
    say("verifying", 2);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    if (Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== sha256) {
      throw new PluginRefused(`${url}: sha256 does not match the feed`);
    }
  }
  return unzip(bytes);
}

/** An update feed's latest version, as the files of its zip (§3.4). */
async function latestFromFeed(url: string): Promise<Map<string, Blob>> {
  const response = await fetch(url);
  if (!response.ok) throw new PluginRefused(`${url}: HTTP ${response.status}`);
  // Only the dev server's own feed (serve.ts) may be plain http, and only on loopback.
  const feed = parseUpdateFeed(await response.text(), undefined, location.hostname === "127.0.0.1");
  const { url: zip, sha256 } = feed.versions[feed.latest]!;
  say(`downloading ${feed.id}@${feed.latest}`, 1);
  el("loading-what").textContent = `${feed.id}@${feed.latest} · ${url}`;
  return zippedPlugin(zip, sha256);
}

/**
 * Serves a plugin's files at /local/ through sw.js, and returns the plugin's URL.
 *
 * A plugin may start workers, which a browser only allows from this page's own origin, so a folder
 * or a zip from elsewhere is served from here. The whole folder is served, because a plugin may
 * reach a sibling. Its plugin.json is at the top or one level down.
 */
async function serveLocal(files: Map<string, Blob>): Promise<string> {
  navigator.serviceWorker.onmessage = (event) => {
    const path = (event.data as { gemsLocalFile?: unknown } | null)?.gemsLocalFile;
    if (typeof path === "string") event.ports[0]?.postMessage(files.get(path) ?? null);
  };

  await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) =>
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
    );
  }

  const roots = files.has("plugin.json")
    ? [""]
    : [...files.keys()].filter((path) => /^[^/]+\/plugin\.json$/.test(path)).map((path) => path.split("/")[0]!);
  if (roots.length !== 1) {
    throw new PluginRefused(
      roots.length === 0 ? "no plugin.json in that folder" : `several plugins in that folder: ${roots}`,
    );
  }
  return new URL(`/local/${roots[0]}`, location.href).href;
}

/** §14: each connection a WebSocket to this page's server, which pipes it to the same port. */
function loopback(ports: number[]): NetworkServices {
  return {
    ports,
    connect(port) {
      if (!ports.includes(port)) return null;
      const socket = new WebSocket(new URL(`/net/${port}`, location.href));
      socket.binaryType = "arraybuffer";
      // "Connected at once" (§14): what is sent before the socket opens waits for it.
      const queued: Uint8Array[] = [];
      const received: Uint8Array[] = [];
      let closed = false;
      socket.onopen = () => queued.splice(0).forEach((bytes) => socket.send(bytes));
      socket.onmessage = (event) => received.push(new Uint8Array(event.data as ArrayBuffer));
      // Set here rather than read off readyState, which turns before the last messages are delivered.
      socket.onclose = () => (closed = true);
      return {
        send: (bytes) => {
          if (socket.readyState === WebSocket.CONNECTING) queued.push(bytes.slice());
          else if (socket.readyState === WebSocket.OPEN) socket.send(bytes);
        },
        receive: () => {
          const bytes = new Uint8Array(received.reduce((sum, chunk) => sum + chunk.length, 0));
          let at = 0;
          for (const chunk of received.splice(0)) {
            bytes.set(chunk, at);
            at += chunk.length;
          }
          return bytes;
        },
        get closed() {
          return closed;
        },
        close: () => socket.close(),
      };
    },
  };
}

/** The feed URL the player submits. The last one is filled in, since it is usually the same one. */
const REMEMBERED = "gemsPlayground.emulatorUrl";
function emulatorFeed(served: FileIndex | null): Promise<string> {
  try {
    emulatorInput.value = localStorage.getItem(REMEMBERED) ?? "";
  } catch {} // storage can be blocked; the box just starts empty
  el("game-field").hidden = served !== null;
  el("served").hidden = served === null;
  if (served) el("served-meta").textContent = `${served.files.length} files from this page's server`;
  // Each field says what is wrong with it, under it, until it changes.
  const flag = (input: HTMLInputElement, error: string, message: string) => {
    el(error).textContent = message;
    el(error).hidden = !message;
    input.setAttribute("aria-invalid", String(!!message));
  };
  gamePicker.addEventListener("change", () => {
    const files = gamePicker.files;
    if (!files?.length) return;
    el("picked").textContent = folderName(files);
    el("picked-meta").textContent = `${files.length} ${files.length === 1 ? "file" : "files"}`;
    el("browse").textContent = "Change";
    el("picker").classList.add("chosen");
    flag(gamePicker, "game-error", "");
  });
  emulatorInput.addEventListener("input", () => flag(emulatorInput, "emulator-error", ""));
  el("landing").hidden = false;
  return new Promise((resolve) =>
    emulatorForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const url = emulatorInput.value.trim();
      flag(
        emulatorInput,
        "emulator-error",
        !url ? "Enter the URL of the emulator's latest.json." :
        !/^https?:$/.test(URL.parse(url)?.protocol ?? "") ? "That is not a web address. It should start with https://" :
        "",
      );
      flag(gamePicker, "game-error", served || gamePicker.files?.length ? "" : "Choose the folder the game is in.");
      const invalid = emulatorForm.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (invalid) return invalid.focus();
      try {
        localStorage.setItem(REMEMBERED, url);
      } catch {}
      el("landing").hidden = true;
      el("loading").hidden = false;
      el("loading-what").textContent = url;
      say("fetching the feed", 0);
      resolve(url);
    }),
  );
}

async function main() {
  const fromServer = await served(new URL(query.get("game") ?? "/game", location.href).href).catch(() => null);
  const feedUrl = await emulatorFeed(fromServer);
  const zip = await latestFromFeed(feedUrl);
  say("loading the emulator", 3);
  const pluginUrl = await serveLocal(zip);
  const files = gamePicker.files;
  const game = fromServer ? { files: fromServer, id: "game" } : { files: pickedFiles(files!), id: folderName(files!) };

  const plugin = await loadPlugin(pluginUrl);
  say("reading the game", 4);
  el("emulator").textContent = `${plugin.manifest.id}@${plugin.manifest.version}`;
  el("feed").textContent = el("feed").title = feedUrl;
  const running = await run({
    plugin,
    files: game.files,
    stage,
    gameId: query.get("id") ?? game.id,
    dialogs: { show: showDialog },
    launchArgs: query.getAll("arg"),
    limited: query.has("limited"),
    network: loopback(query.getAll("net").map(Number)),
    log: (line) => {
      console.log(`[gems] ${line}`);
      if (line.startsWith("accepted")) say("starting", 5);
    },
  });
  state.running = running;
  el("loading").hidden = true;
  el("bar").hidden = false;
  const fullscreen = el("fullscreen");
  fullscreen.hidden = !document.fullscreenEnabled;
  fullscreen.onclick = () => stage.requestFullscreen().catch(() => {});
  say("running");
  const outcome = await running.outcome;
  say(outcome.ended ? "ended" : `error: ${outcome.code}${outcome.detail ? ` (${outcome.detail})` : ""}`);
}

main().catch((error: unknown) =>
  say(error instanceof StartFailed ? `error: ${error.message}` : `refused: ${String(error)}`),
);
