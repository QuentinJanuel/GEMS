// A GEMS host: everything SPEC.md asks of one, as plainly as it can be written.
//
// This is the GEMS Playground's importable half. `page.ts` is one caller of it; anything else that
// needs to run a plugin outside a host application (a test, a command-line tool) is another.

import { defaultSettings, errorCode, type LoadedPlugin } from "./plugin.ts";
import { createReplica } from "./replica.ts";
import type {
  DialogRequest,
  DialogResult,
  EngineSession,
  ErrorCode,
  FileIndex,
  GameInfo,
  GameInput,
  HostServices,
  NetworkServices,
  PointerButton,
} from "./spec.ts";

export interface RunOptions {
  plugin: LoadedPlugin;
  files: FileIndex;
  /** The element the game is shown in. The host makes its own canvas inside it. */
  stage: HTMLElement;
  /** The session's game id (§13.4): scopes its saves. No ":". */
  gameId: string;
  dialogs: { show(request: DialogRequest): Promise<DialogResult> };
  log?: (line: string) => void;
  /** §7.5. Default: none. */
  launchArgs?: readonly string[];
  /** §14. Default: nothing listens. */
  network?: NetworkServices;
  /** §11: start from each setting's `limited` value. Default: off. */
  limited?: boolean;
}

export type Outcome = { ended: true } | { ended: false; code: ErrorCode; detail?: string };

export interface Running {
  /** Frames whose `step` has settled. */
  readonly frames: number;
  /** Settles when the game ends or fails, never before. */
  readonly outcome: Promise<Outcome>;
}

/** Why a game would not start: the engine's code, or that no engine claimed it. */
export class StartFailed extends Error {
  readonly code: ErrorCode | "not-recognised";
  readonly detail?: string;
  constructor(code: ErrorCode | "not-recognised", detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export async function run(options: RunOptions): Promise<Running> {
  const { plugin, stage, gameId } = options;
  const log = options.log ?? (() => {});

  // §6: asked first, and a "no" is not an error.
  const acceptance = await plugin.engine.accepts(options.files).catch(() => null);
  if (acceptance === null) throw new StartFailed("not-recognised", `${plugin.manifest.id} declined`);
  log(`accepted (${acceptance.confidence}) ${acceptance.entry}`);
  const files = acceptance.files ?? options.files;

  const canvas = document.createElement("canvas");
  stage.replaceChildren(canvas);
  // The game's size: whatever the engine last reported, else what `start` said.
  let size = { width: 0, height: 0 };

  let session: EngineSession | null = null;
  let detachInput = () => {};
  let frame = 0;
  const teardown = () => {
    cancelAnimationFrame(frame);
    detachInput();
    session?.dispose();
  };

  let finish!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => (finish = resolve));
  let over = false;
  const end = (result: Outcome) => {
    if (over) return;
    over = true;
    finish(result);
    teardown();
  };

  const replica = createReplica(localStorage, gameId, () => log("saved"));
  const host: HostServices = {
    surface: {
      canvas: canvas.transferControlToOffscreen(),
      reportSize: (width, height) => (size = { width, height }),
      reportSmoothing: (enabled) => (canvas.style.imageRendering = enabled ? "auto" : "pixelated"),
    },
    game: gameId,
    replica,
    dialogs: options.dialogs,
    window: {
      setTitle: (title) => (document.title = title),
      setFullscreen: (enabled) => {
        if (enabled) stage.requestFullscreen().catch(() => {});
        else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      },
      // Read from the document each time, so it is never stale (§7.2).
      isFullscreen: () => document.fullscreenElement === stage,
    },
    assets: { base: plugin.base },
    settings: defaultSettings(plugin.manifest.capabilities.settings, options.limited),
    events: {
      onSave: () => replica.save(),
      onEnded: () => end({ ended: true }),
      onError: (code, detail) => end({ ended: false, ...errorCode({ engineError: true, code, detail }) }),
    },
    launchArgs: options.launchArgs ?? [],
    network: options.network ?? { ports: [], connect: () => null },
  };

  let info: GameInfo;
  try {
    session = await plugin.engine.create(host);
    info = await session.start(files);
  } catch (error) {
    teardown();
    const { code, detail } = errorCode(error);
    throw new StartFailed(code, detail);
  }
  if (size.width === 0 || size.height === 0) size = { width: info.width, height: info.height };
  log(`started ${info.width}x${info.height}`);

  const live = session;
  // An engine may have reported an error while starting, which has already torn this down.
  if (!over) detachInput = attachInput(canvas, (input) => live.sendInput(input), () => size);

  // §8: one frame at a time, the next only once the last has settled. An engine that owns the clock
  // (§8.1) is stepped again as soon as it settles; otherwise once per display frame.
  let frames = 0;
  let pending = false;
  const engineClock = plugin.manifest.capabilities.clock === "engine";
  const tick = (now: number) => {
    if (over) return;
    if (!engineClock) frame = requestAnimationFrame(tick);
    if (pending) return;
    pending = true;
    Promise.resolve()
      .then(() => live.step(now))
      .then(
        (running) => {
          pending = false;
          frames++;
          if (!running) end({ ended: true });
          else if (engineClock) tick(performance.now());
        },
        (error) => end({ ended: false, ...errorCode(error) }),
      );
  };
  frame = requestAnimationFrame(tick);

  return {
    get frames() {
      return frames;
    },
    outcome,
  };
}

/** §9: a point in the canvas's box, in game pixels, given the game letterboxed inside that box. */
export function toGamePixels(
  x: number,
  y: number,
  box: { width: number; height: number },
  game: { width: number; height: number },
): { x: number; y: number } {
  const scale = Math.min(box.width / game.width, box.height / game.height);
  // Measured from the centre, which both share, so a point on a pixel boundary lands on it exactly.
  return {
    x: Math.floor((x - box.width / 2) / scale + game.width / 2),
    y: Math.floor((y - box.height / 2) / scale + game.height / 2),
  };
}

const BUTTONS: Record<number, PointerButton> = { 0: "left", 1: "middle", 2: "right" };

/** §9: the host owns every listener. Returns the function that removes them. */
function attachInput(
  canvas: HTMLCanvasElement,
  send: (input: GameInput) => void,
  game: () => { width: number; height: number },
): () => void {
  const listeners = new AbortController();
  const { signal } = listeners;
  // A key typed into a dialog is the dialog's, not the game's.
  const forGame = (event: Event) => !(event.target as Element | null)?.closest?.("dialog");
  const at = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return toGamePixels(event.clientX - rect.left, event.clientY - rect.top, rect, game());
  };

  window.addEventListener("keydown", (event) => {
    if (!forGame(event)) return;
    event.preventDefault();
    if (!event.repeat) send({ kind: "key-down", code: event.code });
  }, { signal });
  window.addEventListener("keyup", (event) => {
    if (!forGame(event)) return;
    event.preventDefault();
    send({ kind: "key-up", code: event.code });
  }, { signal });
  window.addEventListener("blur", () => send({ kind: "focus-lost" }), { signal });

  canvas.addEventListener("pointermove", (event) => send({ kind: "pointer-move", ...at(event) }), { signal });
  canvas.addEventListener("pointerdown", (event) => {
    const button = BUTTONS[event.button];
    if (button) send({ kind: "pointer-down", button, ...at(event) });
  }, { signal });
  window.addEventListener("pointerup", (event) => {
    const button = BUTTONS[event.button];
    if (button) send({ kind: "pointer-up", button });
  }, { signal });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (event.deltaY !== 0) send({ kind: "wheel", delta: event.deltaY });
  }, { signal, passive: false });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });

  return () => listeners.abort();
}
