# GEMS specification

**Revision 5.** The Game Emulation Model Specification: what a host must provide to run a game
emulator in a web page, and what an emulator must provide to be run.

This document is normative except where a section says otherwise. The key words MUST, MUST NOT,
SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119. Shapes are written in a TypeScript-like
notation because that is the language the boundary is crossed in. The notation describes data and
calls; it does not ask anyone to use TypeScript or any library.

## 1. Model

- A **plugin** is one emulator, packaged as a directory served over HTTP (§3).
- A **host** is the page that loads plugins and shows their games to a player.
- The plugin's **entry module** is an ES module that the host imports into its own realm. Its default
  export is the **engine** (§4). Everything else in the plugin's directory, such as wasm, workers,
  runtimes and sound banks, is the plugin's own business. The host never imports it and never sees
  what the plugin's halves say to each other.
- A **session** is one game, from `start` to `dispose` (§8).

Everything that crosses between host and engine MUST be plain data: structured-clonable, with no
reliance on `instanceof`, class identity or shared module state. The host and the plugin are
separate programs with separate module graphs, and the plugin's own halves are usually in different
threads.

A host's only knowledge of engines is a list of plugin base URLs, zips of plugin directories and
update feeds (§3.4). Nothing in this protocol names an
emulator or a host, and nothing in the host or plugin interface branches on a game format. The only
formats it names are the advisory `formats` ids of §3.2; §13.5 binds an engine that lists one of
them to that format's profile.

## 2. Revisions and compatibility

The protocol has one revision number, an integer. A plugin states the revision it implements in its
manifest (`apiVersion`) and again on its engine object. These MUST be equal.

A host implements exactly one revision. It MUST refuse a plugin whose `apiVersion` differs, and it
SHOULD say that the plugin was built for another revision, as distinct from saying that it is not
a plugin at all.

**The number moves only on a break, never on an addition.**

- *Without a new revision:* anything an existing implementation can safely ignore. This includes a
  new optional member, a new error code (§12), a new setting kind (§11) and a new fact in an open
  record (`FormatInfo.facts`).
- *With a new revision:* anything an existing implementation must understand. This includes a new
  required member, a new member of `HostServices` that an engine may rely on, or a change to what an
  existing member means. A host-provided member counts even though it only adds: an engine built for
  the new revision may rely on it, and a host that lacks it would fail that engine.

The history is in Annex B.

## 3. Packaging

### 3.1 The plugin directory

A plugin is a directory reachable at a base URL. The only file name a host knows is
`plugin.json`, at the root of that directory. The manifest names every other file.

The recommended layout is `<base>/<id>/<version>/`. A host that serves every engine from one
versioned directory MAY use `<base>/<id>/`, and a development host MAY use any path.

The host SHOULD check whatever the layout makes checkable. If the URL contains the id, it SHOULD
match the manifest's `id`; if it contains the version, that SHOULD match `version`. A mismatch is a
deploy error and SHOULD be refused rather than run.

### 3.2 The manifest

`plugin.json` is a JSON object:

```ts
interface PluginManifest {
  id: string;            // required, non-empty; lowercase, stable across versions
  version: string;       // required, non-empty; this build's version
  apiVersion: number;    // required, integer; see §2
  entry: string;         // required, non-empty; path of the entry module, relative to the directory
  name?: string;         // non-empty; a display name for the engine
  formats?: string[];    // the kinds of game this engine runs; see below
  description?: string;  // at most 280 characters; what the engine is, for a player
  homepage?: string;     // an https URL, at most 2048 characters; where to read more
  author?: string;       // at most 80 characters; who makes the engine
  updates?: string;      // an https URL, at most 2048 characters; this plugin's update feed (§3.4)
  credits?: Credit[];    // at most 20; what the plugin ships and under which licence (see below)
  assets?: PluginAsset[];
  capabilities: EngineCapabilities;  // required
}

interface Credit {
  name: string;          // at most 80 characters; the component
  license: string;       // at most 80 characters; an SPDX expression or a short licence name
  url: string;           // an https URL, at most 2048 characters; the source of what the plugin ships
  copyright?: string;    // at most 200 characters
  upstream?: string;     // an https URL, at most 2048 characters; the upstream project
  note?: string;         // at most 280 characters
}

interface PluginAsset {
  path: string;          // required, non-empty; relative to the directory
  bytes?: number;        // its size, so a host can budget or report progress
  url?: string;          // an absolute URL to fetch it from instead of the directory
  optional?: boolean;    // default false
}

interface EngineCapabilities {
  settings: SettingDescriptor[];  // required; see §11. Empty is normal
  clock?: "host" | "engine";      // default "host"; see §8.1
}
```

- `id` keys the player's settings for this engine and names it in reports. Changing it orphans
  both.
- A host MUST ignore a manifest key it does not define. This rule is for the manifest's top level
  only: `capabilities` has its own, stricter rule below.
- `name` and `formats` are advisory metadata, not capabilities. A host that does not know them is
  unaffected, so they were added without a new revision (§2). A host SHOULD ignore a malformed
  value (an empty or non-string `name`, a `formats` that is not an array, an entry that is not a
  valid id) rather than refuse the manifest.
- `description`, `homepage`, `author` and `updates` are advisory metadata too, added the same way.
  A host trims `description` and `author` of surrounding whitespace before it measures them. A host
  SHOULD drop a malformed value (a non-string, a string that is empty after trimming or over its
  limit, a URL that does not parse or is not https) rather than refuse the manifest. Absent means
  unspecified.
- `credits` is advisory too: a plugin states its own licences so a host can show them truthfully in
  its engine list. It is an array because one plugin can ship several components (an emulator and
  bundled DLLs, say). A host SHOULD drop an entry missing `name`, `license` or an https `url`, drop
  a malformed optional field of an entry, and ignore entries past the twentieth.
- `formats` lists the kinds of game file the engine can run, as ids matching `[a-z0-9_-]+`, at most
  24 characters each. The vocabulary is open. This revision defines `gm8` (GameMaker 8.x), `gms1`
  (GameMaker Studio 1.x) and `gms2` (GameMaker Studio 2, and GameMaker from 2022 on). A host MUST
  ignore an id it does not know when it displays the list, and MUST NOT refuse a plugin for one.
  An absent `formats` means unspecified, not "runs nothing".
- `accepts()` (§6) stays the authority on whether an engine runs a game. A host MAY use `formats`
  to avoid downloading a game or to disable a way to play it, but MUST NOT refuse a game that an
  engine's `accepts()` claims.
- `entry` is always resolved against the plugin's own directory. A host MUST NOT follow an
  absolute URL here.
- An asset's `url` is advisory. A host MAY serve the asset from its own mirror, and MUST refuse a
  URL it does not trust.
- If an optional asset fails to load, the engine loses a feature, not the game. If a required asset
  fails, that is `"asset-unavailable"`.
- `capabilities` MUST contain only keys this revision defines (`settings` and `clock`, in revision
  5). A host MUST refuse a plugin that declares a capability it does not know. A capability is
  something the host has to honour, and running without it would leave something quietly missing.
  That refusal is also what lets a capability be added without a new revision: a plugin that does
  not declare it is unaffected, and a host that does not know it refuses the plugin rather than
  running it wrongly.
- For each setting descriptor of a kind defined in §11, the `default` MUST have that kind's type,
  and a `choice` MUST have a non-empty `values` list that contains its `default`. A host SHOULD
  validate descriptors and refuse a manifest with an invalid one. A descriptor of an unknown kind
  is skipped, not refused.

### 3.3 The entry module

The entry module's default export is the engine object (§4). Importing it MUST NOT touch the DOM,
fetch the payload, start a worker or allocate a heap. A host may import several plugins only to ask
each whether it recognises a game, and then run none of them.

The host MUST check that the exported object has a string `id`, and functions `accepts` and
`create`. Its `id` and `apiVersion` MUST equal the manifest's, and a host MUST refuse the plugin if
they do not.

### 3.4 The update feed

A plugin's maker MAY publish an **update feed**: a JSON object at a stable https URL, typically
`latest.json` beside the versioned directories of §3.1. Each version it lists is a **plugin zip**,
a zip archive of that version's plugin directory with `plugin.json` at its root or inside a single
top-level directory.

```ts
interface UpdateFeed {
  id: string;                           // required; the plugin's manifest id
  latest: string;                       // required; a key of `versions`
  versions: Record<string, FeedEntry>;  // required; by version, at most 256 entries
  icon?: string;                        // an https URL, at most 2048 characters; a PNG or SVG shown as the plugin's icon
}

interface FeedEntry {
  url: string;     // required; the https URL of that version's plugin zip
  sha256: string;  // required; the SHA-256 of the zip's bytes, as 64 lowercase hex digits
}
```

- `id` follows the manifest's `id` rules (§3.2) and each key of `versions` the manifest's
  `version` rules, each at most 128 characters. `latest` MUST be a key of `versions`. `versions`
  MAY list older versions, so a host can roll back.
- `icon` is advisory, like the manifest's `homepage` (§3.2): a host SHOULD drop a malformed value (a
  non-string, a URL that is not https, or one over 2048 characters) rather than refuse the feed.
  It was added without a new revision (§2).
- Each entry's `url` MUST be https, at most 2048 characters, and MUST serve a plugin zip whose
  manifest has the feed's `id` and the entry's version.
- A host treats a feed as untrusted input. It MUST refuse a feed that is not https, over 64 KiB,
  or breaks a rule above, and MUST ignore keys it does not define, at every level.
- A host that takes a feed URL resolves `latest` to an entry. It MUST check the zip's SHA-256
  against the entry's `sha256` before it installs it, and MUST NOT install a zip whose manifest
  `id` or `version` differs from the feed's `id` and that entry's version.
- A host MAY take a plugin zip's URL instead of a feed. That plugin is pinned: the host never
  updates it, whatever its manifest's `updates` says.
- A host MAY check a feed periodically, and MAY keep the previous version to roll back to. How often
  it checks, and whether it installs an update without asking, is the host's business.

An example is in Annex C.

## 4. The engine

```ts
interface EnginePlugin {
  readonly id: string;
  readonly apiVersion: number;
  readonly capabilities: EngineCapabilities;
  accepts(files: FileIndex): Promise<Acceptance | null>;
  create(host: HostServices): Promise<EngineSession>;
}
```

`create` makes a session. It rejects with an error (§12) when the engine cannot run here at all:
`"unsupported-environment"`, or `"asset-unavailable"` if its own payload will not load. `create`
is called once per session, before the game's files are handed over.

## 5. The game's files

A host hands over a **normalised game**: plain files with every container already opened, rooted
at the game's own root, siblings intact. An engine MAY assume plain files and need carry no
archiver.

```ts
interface IndexedFile {
  readonly path: string;   // "/"-separated, no leading slash, relative to the game's root
  readonly size: number;   // bytes, known without reading
  read(): Promise<Uint8Array>;
  readRange?(start: number, end: number): Promise<Uint8Array>;
}

interface FileIndex {
  readonly files: readonly IndexedFile[];  // no guaranteed order
  readonly totalBytes: number;             // the sum of every size
  get(path: string): IndexedFile | null;   // exact, case-sensitive match on path
}
```

- `path` is a label, not a real filesystem path. The running game's file calls go through
  `HostServices.files` or `HostServices.replica` (§13), never through this index.
- `read` MAY be called more than once.
- `readRange` is optional for the host. An engine MUST cope without it (`file.readRange?.(0, 12)
  ?? …`). Where it exists, it returns bytes `[start, end)`, clamped by the host to the file, and
  never more than `end - start`.

## 6. Recognising a game

```ts
interface Acceptance {
  readonly confidence: "exact" | "probable";
  readonly entry: string;        // the path of the file the engine would load
  readonly files?: FileIndex;    // a replacement index; see below
  readonly format?: FormatInfo;
}

interface FormatInfo {
  readonly format: string;  // a short, stable id the engine chooses, e.g. "gm8.1"
  readonly facts?: Readonly<Record<string, string | number | boolean | null>>;
}
```

`accepts` answers "can you run this". `null` means "not mine". That is not an error, and an engine
SHOULD NOT reject.

- `"exact"`: the engine read a structure only its own games have, such as a container signature or
  a runner's header.
- `"probable"`: the engine recognised the shape but not the contents.
- `files` exists only for a wrapper that this protocol does not name and only this engine
  understands. It MUST NOT be used to unpack archives, which the host has already opened (§5). When
  present, the host hands this index to `start` instead of its own.
- `format` and `facts` are opaque to the host. It may store and group by them, and MUST NOT branch
  its play path on them.

**Choosing an engine.** A host that asks several engines SHOULD prefer an `"exact"` answer to a
`"probable"` one. Within one confidence it SHOULD refuse to guess between two answers rather than
pick one. An engine whose `accepts` rejects is treated as having declined, and MUST NOT stop the
others from being asked. A host MAY let the player override the choice.

`accepts` saying yes does not promise that `start` succeeds.

## 7. Host services

`HostServices` is handed to `create` once, and stays valid until `dispose`. An engine MAY rely on
every member below. Nothing engine-specific crosses it.

```ts
interface HostServices {
  readonly surface: Surface;
  readonly game: string;                         // §13.4
  readonly replica: ReplicaServices;             // §13
  readonly dialogs: { show(request: DialogRequest): Promise<DialogResult> };  // §10
  readonly window: WindowServices;
  readonly assets: { readonly base: string };
  readonly settings: Readonly<Record<string, SettingValue>>;  // §11
  readonly events: EventServices;
  readonly launchArgs: readonly string[];
  readonly network: NetworkServices;             // §14
}
```

### 7.1 Surface

```ts
interface Surface {
  readonly canvas: OffscreenCanvas;
  reportSize(width: number, height: number): void;
  reportSmoothing(enabled: boolean): void;
}
```

The host passes the canvas in, so an engine looks nothing up in the document. It is an
`OffscreenCanvas` so that it is the same kind of object whether the engine draws in a worker or in
the host's realm. The engine owns the backing-buffer size, and the host owns the box it is shown in.

`reportSize` is the game's real resolution, which the host cannot observe once control of a canvas
has been transferred. `reportSmoothing` is the game asking for smooth or crisp upscaling. The
player sees the host's upscale of the whole surface, so only the host can apply it.

### 7.2 Window

```ts
interface WindowServices {
  setTitle(title: string): void;
  setFullscreen(enabled: boolean): void;
  isFullscreen(): boolean;
}
```

`isFullscreen` is synchronous: it answers a call the game makes mid-frame. It returns the host's
last reported state, not an answer to a question asked now. The host MUST keep it current,
including when the player leaves fullscreen without the game knowing. An engine MUST NOT assume a
`setFullscreen` it just made is already reflected.

### 7.3 Assets

`assets.base` is the plugin directory's URL, with no trailing slash. An engine fetches its own
payload relative to it and from no hardcoded path. That is what lets one host serve several builds
of one engine at once.

### 7.4 Events

```ts
interface EventServices {
  onSave(): void;
  onEnded(): void;
  onError(code: ErrorCode, detail?: string): void;
}
```

- `onSave`: a real save was written or deleted, not a scratch write. One save is routinely several
  files. A host MAY hear about one save more than once and MUST treat this as idempotent.
- `onEnded`: the game ended itself outside a step. `step` returning `false` is the authoritative
  signal. A host may see both for one ending, so teardown MUST be idempotent.
- `onError`: the game cannot continue. It carries a code, never a sentence (§12).

### 7.5 Launch arguments

`launchArgs` are the arguments the game was launched with, after the program itself: what the
game's own "parameter count" and "parameter string" functions report. Empty is normal. An engine
MUST hand them to the game unchanged.

## 8. The session

```ts
interface GameInfo {
  readonly width: number;
  readonly height: number;
  readonly title?: string;
}

interface EngineSession {
  start(files: FileIndex): Promise<GameInfo>;
  step(now: number): Promise<boolean> | boolean;
  sendInput(input: GameInput): void;
  setSetting(key: string, value: SettingValue): void;
  stats?(): Record<string, unknown>;
  dispose(): void;
}
```

The lifecycle is `create` → `start` → `step`… → `dispose`.

- **`start`** loads the game and resolves once it is ready to run. It rejects with an error when
  the game cannot be loaded. The game arrives exactly as it will run: a host that wants anything
  changed about it, a patch included, changes the files before calling `start`.
- **`step`** runs one frame. `false` means the game ended itself.
  - It MAY return a promise, which settles only once the frame is really over. A game blocked on a
    dialog mid-frame is simply a frame that has not finished. How the engine suspends (unwinding,
    a blocked thread, a coroutine) is its own business.
  - `now` is a monotonic timestamp in milliseconds, in the host's timebase, and it is the engine's
    only clock. A host may run a game faster than real time, or deterministically, without the
    engine taking part.
  - A host MUST NOT call `step` again before the previous call has settled.
- **`sendInput`** is synchronous and non-blocking. The engine queues the input and takes it into
  account from the next frame. A host MAY send input between frames and while a frame is pending.
- **`setSetting`**: the player changed a declared setting. An engine MUST ignore a key it did not
  declare, and MUST clamp an out-of-range value rather than fail.
- **`stats`** is optional and opaque. A host MAY show or log it and MUST NOT branch on it.
- **`dispose`** releases everything promptly, audio above all. It MUST be safe after an error,
  after `step` returned `false`, and when called twice.

### 8.1 Who owns the clock

`capabilities.clock` says whose timing decides when a frame is due.

- **`"host"`** (the default): the host calls `step` on its own schedule, typically once per
  display frame, and the engine runs one frame of game time from `now`.
- **`"engine"`**: the engine keeps its own clock and its own frame rate, the game's. `step`
  grants continuation: the engine runs until its next frame is presented, waiting inside the step
  for that frame's time if it is early, and the step settles then.
  - The host SHOULD call `step` again as soon as the previous one settles, not on its own
    schedule. A host that waits for its display instead caps the game at the display's rate,
    which is wrong for a game faster than the display.
  - `now` is advisory. The engine MUST NOT require it to advance at any rate.
  - A step is one presented frame, nothing finer. Wherever the engine yields inside a frame is
    its own business, and none of it is visible to the host. A step MAY cover more than one
    frame period of game time, when the game skipped presenting one.
  - Between steps the engine is suspended, so a host pauses the game by not calling `step`. The
    engine SHOULD resume from where it stopped rather than catch up on a long pause.

## 9. Input

The host owns every listener, normalises the events, and pushes them to the engine.

```ts
type PointerButton = "left" | "middle" | "right";

type GameInput =
  | { kind: "key-down"; code: string }
  | { kind: "key-up"; code: string }
  | { kind: "pointer-move"; x: number; y: number }
  | { kind: "pointer-down"; button: PointerButton; x: number; y: number }
  | { kind: "pointer-up"; button: PointerButton }
  | { kind: "wheel"; delta: number }
  | { kind: "focus-lost" };
```

- `code` is a `KeyboardEvent.code` value (`"ArrowLeft"`, `"KeyZ"`).
- The host MUST NOT send auto-repeats. A `key-down` for a key that is already held is a deliberate
  fresh press (an on-screen control, a test), and an engine MUST treat it as one.
- Pointer coordinates are in **game pixels**. The host has already mapped them out of its own
  layout, device pixel ratio and letterbox.
- For `wheel`, only the sign of `delta` is meaningful. Positive is scrolling down, as in
  `WheelEvent.deltaY`.
- `focus-lost` means the host lost input focus. The engine MUST release everything it considers
  held, because the host cannot know what that is.

## 10. Dialogs

A game's blocking dialogs ("show a message", "ask a question", "ask for a string or an integer")
all reduce to one request.

```ts
const DIALOG_DISMISSED = -1;

interface DialogButton {
  label: string;                   // shown verbatim
  value: number;                   // returned as DialogResult.button; opaque to the host
  kind?: "primary" | "default";   // "primary" is the default choice, also triggered by Enter
}

interface DialogRequest {
  text: string;                    // shown verbatim
  buttons: DialogButton[];
  input?: { kind: "string" | "integer"; initial: string };
  dismissible?: boolean;           // default false
}

interface DialogResult {
  button: number;                  // a button's value, or DIALOG_DISMISSED
  value: string | null;            // the field's contents; null when the request had no input
}
```

- Nothing in a request describes appearance. The host renders it however it likes.
- The host MUST show `text` and `label` verbatim, because they are the game's words. The labels an
  engine puts on its own built-in dialogs ("OK", "Yes", "No", "Cancel") are engine chrome, and a host
  MAY localise exactly those.
- `"integer"` asks the host to accept only a signed whole number.
- When a dismissible dialog is dismissed, the result is `button: DIALOG_DISMISSED`. An engine MUST
  handle that on any request it marked dismissible. It SHOULD tolerate it on any other, because a
  host that loses the player has no better answer.

## 11. Settings

An engine declares its knobs. The host renders them, stores the player's choices, and passes them
back.

```ts
type SettingValue = string | number | boolean;

type SettingDescriptor =
  | { kind: "flag"; key: string; default: boolean; limited?: boolean }
  | { kind: "number"; key: string; default: number; limited?: number; min?: number; max?: number;
      step?: number; unit?: "bytes" | "seconds" | "hertz" | "count" }
  | { kind: "choice"; key: string; default: string; limited?: string; values: string[] };
```

- `limited` is the value to start from, in place of `default`, when the host is in limited-resources
  mode: a device short of memory, such as a phone. It is how an engine says which of its knobs
  trades speed for memory (decoding audio on first use rather than up front, say). The host decides
  when it is in that mode; the engine never learns it, and only receives resolved values. A host
  without the mode ignores `limited`, and a player's stored choice still wins over it. A `limited`
  that is not of `default`'s type, or outside `values`, `min` or `max`, is ignored.

- A descriptor carries no prose. The host titles a setting from its own catalogue, keyed by engine
  id and setting key, and `choice` values are ids that the host translates.
- A host formats an unknown `unit` as a bare number, and skips a descriptor of an unknown `kind`.
- `HostServices.settings` holds a value for every declared key. The host resolves defaults first,
  and drops a stored value of the wrong type, outside `values`, non-finite, or outside `min`/`max`.
  It MAY contain keys the engine did not declare, and the engine MUST ignore those.
- Later changes arrive through `EngineSession.setSetting`.

## 12. Errors

```ts
type ErrorCode =
  | "unsupported-game"         // recognised, but cannot run it (a revision it does not implement)
  | "corrupt-game"             // the right kind of file, damaged
  | "out-of-memory"
  | "asset-unavailable"        // a payload file could not be fetched; a retry may help
  | "unsupported-environment"  // the host cannot run this engine (no WebGL2, no isolation, …)
  | "internal";                // a bug

interface EngineErrorData {
  readonly engineError: true;  // the brand
  readonly code: ErrorCode;
  readonly detail?: string;    // for a log or a report; never shown to a player as prose
}
```

- A rejected `create`, `start` or `step`, and `onError`, carry an `ErrorCode`. An engine never
  sends a sentence meant for the player. The host owns every word the player reads.
- An error is identified by its `engineError: true` field, never by its class. A thrown value
  without the brand, or with an unknown code, MUST be treated as `"internal"`. That rule is what lets
  this list grow without a new revision.

## 13. The filesystem

A game reads and writes files synchronously, mid-frame. The host owns the persisted state; the
engine needs synchronous access to it.

### 13.1 Mounts and paths

Every path the game can reach resolves into exactly one **mount**:

| Mount | Root string | Persisted |
| --- | --- | --- |
| `game` | `/game/` | yes |
| `appdata` | `/appdata/` | yes |
| `temp` | `/temp/` | no; it lasts only for the session |

- The `game` mount's root is the directory that holds the file named by `Acceptance.entry` (§6),
  not the root of the `FileIndex`. A file the game ships beside its entry is at the same path in
  the bundle as the game's own relative file calls name it.
- A path is a mount plus its segments, cleaned of empty segments, `.` and `..`. A `..` that would
  climb above a root is dropped.
- Its string form is the root followed by the segments joined with `/` (`/game/Save/save1`).
- Paths compare **case-insensitively**. `Save/Game1` and `save/game1` are one file.
- What the engine reports to the game as its working, program, temp and save-id directories, and
  how the game's own path strings (backslashes, drive letters, absolute paths, environment
  variables) map onto mounts, is set by the format profile (§13.5) of the format the game is. For a
  format no profile covers, it is the engine's business.

The mapping is what makes saves portable. Two engines that map one path string to two different
paths write saves that each stores and the other never finds, and nothing reports an error. A
player who switches engines for a game then sees an empty save, and the old one is not lost but
unreachable.

### 13.2 The overlay

The filesystem is two layers:

- the **bundle**: the game's own files, read-only, re-created every session from what was handed
  to `start`
- the **store**: everything the game wrote

Its rules:

- **read** answers from the store, unless the path is whited out, and otherwise from the bundle
- **write** always lands in the store
- **delete** drops the path from the store and, if the bundle still has it, leaves a **whiteout**
  so that it stays deleted

A directory that exists while empty is its own store entry.

The engine keeps this overlay itself: the bundle from what `start` was handed, the store over the
replica (13.3). The host never sees the bundle, and holds only the store.

### 13.3 The replica

A game's file calls are synchronous, and an engine cannot call into the host synchronously, least
of all from a worker. Instead it holds a complete replica of this game's persisted entries and
mirrors every change back.

```ts
interface ReplicaServices {
  seed(): Record<string, string>;
  set(key: string, value: string): void;
  remove(key: string): void;
  save(): void;
  watch(sink: ReplicaSink): void;
}

interface ReplicaSink {
  put(path: string, bytes: Uint8Array): void;  // path in string form, see 13.1
  drop(key: string): void;
}
```

- The engine calls `seed` when it builds its replica, not before. The host may have restored a
  cloud save in between.
- Every change to a persisted entry is reported with `set` or `remove`, by store key (§13.4). The
  host persists exactly what it is given.
- `save` marks a real save, with the same idempotence as `EventServices.onSave`.
- An engine MUST call `watch` once, as early as it can. The host uses the sink to
  tell it about changes made on the host's side: `put` for a file the host added, `drop` for an entry
  it removed. The bytes passed to `put` are the engine's own copy.
- `temp` is never persisted, so a `temp` entry never appears in `seed`, `set` or `remove`.
- The replica is scoped to the session's game. A host hands out no key-level access to anything
  else.

### 13.4 Store keys

**This grammar is protocol surface and MUST be implemented exactly.** The replica mints these
keys and the host persists them verbatim. An engine that encodes a path differently writes saves
that the host stores and never finds again, and nothing reports an error.

```
key      = prefix ":" tag ":" game ":" mount ":" path
prefix   = "gems"
tag      = "file" / "gone" / "dir"
game     = HostServices.game, the session's game id; contains no ":"
mount    = "game" / "appdata"
path     = segment *( "/" segment )   ; empty at a mount's root
segment  = encodeURIComponent(name)   ; per ECMAScript, so the segment has no "/" or ":"
```

| Tag | Entry | Value |
| --- | --- | --- |
| `file` | a file in the store | the file's bytes, standard base64 with padding |
| `gone` | a whiteout over a bundle path | `"1"` |
| `dir` | a directory that exists explicitly, possibly empty | `"1"` |

- A key is decoded by splitting on `:`. Everything after the fourth `:` is the path, because a
  segment's encoding contains no literal `:`.
- Segments keep the case the game wrote them in. Comparison is case-insensitive (§13.1).
- A host MAY keep entries of its own under the same prefix with other tags. An engine MUST ignore
  any key it cannot decode as one of the three tags above.

### 13.5 Format profiles

A format profile fixes, for one `formats` id (§3.2), what the game is told about its directories
and where each of its path strings lands. An engine that lists a format id with a profile here
MUST follow that profile for every game of that format, so that any two such engines produce the
same store key for the same file call. A profile binds only an engine that lists its format; the
ids stay advisory to the host (§3.2), and nothing in the interface changes.

The profiles model the machine these games were written for: one Windows user, with the game in
its own directory. The profile text below names that machine's places, not any engine's.

**The Windows mapping.** All three profiles resolve a path string the same way, first match wins.
Matching is case-insensitive, and `\` and `/` are both separators.

1. A string that starts with a mount root (`/game`, `/appdata`, `/temp`, followed by a separator
   or the end) is in that mount. Every engine resolves these, whatever strings it reports itself.
2. A string that contains `AppData\Local\Temp\` or `Local Settings\Temp\` is in `temp`, at what
   follows it.
3. A string that contains `AppData\Local\`, `AppData\Roaming\`, `Local Settings\Application Data\`
   or `Application Data\` is in `appdata`, at what follows the first such marker. Local and
   Roaming are **one** namespace: `%LOCALAPPDATA%\X\a` and `%APPDATA%\X\a` are the same file.
4. A string that starts with `C:\game`, followed by a separator or the end, is in `game`.
5. Anything else is resolved by the profile's rules for relative, rooted and other absolute paths.

`..` and `.` are then cleaned as in §13.1, against the mount the path landed in.

Rules 1 and 4 matter beyond an engine's own strings: a game that keeps a path in its save, then
runs under another engine, hands that engine the first engine's string.

**What the game is told.** The game and save-id directories the profiles below report are either
the mount root string (`/game`, `/appdata/<Name>`) or the Windows path of the same place
(`C:\game`, `C:\Users\player\AppData\Local\<Name>`), with the separator the row says; which of
the two is the engine's choice, since both resolve alike, and so do their parents. `temp_directory`
MUST be the Windows path: games climb out of it to find the user's folders
(`filename_dir(filename_dir(filename_dir(temp_directory))) + "\Roaming\"`), and from `/temp` that
climb lands in `game`. `environment_get_variable` answers, in every profile:

| Variable | Value |
| --- | --- |
| `USERPROFILE` | `C:\Users\player` |
| `APPDATA` | `C:\Users\player\AppData\Roaming` |
| `LOCALAPPDATA` | `C:\Users\player\AppData\Local` |
| `TEMP`, `TMP` | `C:\Users\player\AppData\Local\Temp` |

An engine MAY answer other variables. It MUST NOT answer these from the machine it runs on.

**`gm8`** (GameMaker 8.0, 8.1 and 8.2):

| Builtin or form | Reported value / where it lands |
| --- | --- |
| `working_directory`, `program_directory` | the `game` root, without a trailing separator |
| `temp_directory` | a directory below `TEMP`, without a trailing separator (`…\Temp\gm_ttt_<n>`), in `temp` |
| relative (`save1`, `Data\save1`) | `game`, at that path |
| rooted (`\save1`) | `game`, at that path |
| another absolute path (`D:\x\save1`) | `game`, with the drive dropped (`x/save1`) |

**`gms1`** (GameMaker Studio 1.x) and **`gms2`** (GameMaker Studio 2 and later). `<Name>` is the
game's own name as its game file stores it (the `Name` of the general-info chunk), not its file
name or title.

| Builtin or form | Reported value / where it lands |
| --- | --- |
| `working_directory`, `program_directory` | the `game` root, with a trailing separator |
| `game_save_id` | `appdata` at `<Name>/`, with a trailing separator |
| `temp_directory` | `TEMP` itself, with a trailing separator (`C:\Users\player\AppData\Local\Temp\`) |
| a write, relative or inside the `game` root | `appdata`, at `<Name>/` followed by its path relative to the `game` root |
| a read, relative or inside the `game` root | `appdata` at `<Name>/…` if the store has it, else `game` at that path |
| a relative path whose `..` climbs out of `<Name>/` | `appdata`, cleaned against `<Name>/` (`..\x` is `appdata` at `x`) |
| a write anywhere else (rooted, another absolute path, `APPDATA` or `LOCALAPPDATA` outside `<Name>`) | refused: the call fails as it does when the file cannot be created |

A `gms2` game built with the file system sandbox disabled is outside this profile.

**Conformance.** `conformance/save-paths/` in this repository holds a probe (a mod that writes one
file through each form above) and the table of keys a conforming engine produces for it.

## 14. Network

A game talks to something running beside it, such as a helper or its own extension's sockets, over
TCP on loopback. Here the host is what listens.

```ts
interface NetworkServices {
  readonly ports: readonly number[];                 // fixed before start; empty is normal
  connect(port: number): NetworkConnection | null;   // null for any port not in ports
}

interface NetworkConnection {
  send(bytes: Uint8Array): void;   // fire-and-forget, in order
  receive(): Uint8Array;           // every byte since the last call, in order; empty when none
  readonly closed: boolean;        // either side closed it; received bytes can still be read
  close(): void;                   // safe twice
}
```

- An engine routes a game's connection to `127.0.0.1`, `localhost` or `::1` on one of `ports` to
  `connect`. A connection to anywhere else fails the way it would on a machine with nothing
  listening.
- A connection is connected at once.
- Neither direction ever blocks. A game may stall on its socket; the host must not be able to stall
  it further.
- The bytes are opaque to the engine. What they mean is between the game and the host.

## 15. Deliberately absent

Three host services an engine might expect are not part of this revision, by decision:

- **Connections beyond loopback.** A game's connection to anywhere other than §14's ports fails.
  Reaching the internet from a player's browser, through a relay, is an operational and abuse
  question for a host to answer on its own terms, not something an engine may count on.
- **A clock origin.** The game sees the real date and time, as on a real machine. A host that
  wants a reproducible date sets the clock of the environment the engine runs in.
- **Input timestamps.** `GameInput` carries no time. An engine applies input from its next
  frame (§8). If a deterministic replay ever needs the guest's clock on each event, an optional
  member adds it without a new revision.

---

## Annex A (informative): the reference wire

Nothing in this annex is required. It describes how the reference implementation connects a
plugin's main-thread half to its worker, for an implementer who wants a proven shape. A plugin MAY
use any internal protocol, because the host never sees it.

### A.1 Envelope

Messages travel over a `MessagePort`-like channel, wrapped in one of four envelopes:

```ts
type Envelope =
  | { w: "note"; body: unknown }               // no answer wanted
  | { w: "req"; id: number; body: unknown }    // answer wanted, under id
  | { w: "ok"; id: number; body: unknown }     // the answer
  | { w: "err"; id: number; error: EngineErrorData };
```

Ids are per sender and increase from 1. A message that is not an envelope is ignored, so the port
can be shared. A request with no handler is answered with `"internal"`. Closing the channel
rejects every outstanding request with `"internal"`.

### A.2 Main half to worker

| `kind` | Envelope | Body | Answer |
| --- | --- | --- | --- |
| `init` | req | `apiVersion`, `canvas` (transferred), `assetBase`, `settings`, `gameId`, `storeSeed`, `dialogBuffer` (a `SharedArrayBuffer` or null), `launchArgs`, `ports` | `{ engineId }` |
| `start` | req | `files: { path, bytes: ArrayBuffer }[]`, bytes transferred | `GameInfo` |
| `tick` | req | `now` | `{ running }`, sent once the frame is over |
| `stats` | req | none | opaque |
| `input` | note | `input: GameInput` | none |
| `setting` | note | `key`, `value` | none |
| `fs-put` | note | `path`, `bytes` (transferred) | none |
| `fs-drop` | note | `key` | none |
| `fullscreen-changed` | note | `enabled` | none |
| `net-data` / `net-close` | note | `id`, and `bytes` for data | none |
| `audio-ended` | note | `id` | none |
| `unload` | note | none | none; the main half then terminates the worker |

### A.3 Worker to main half

| `kind` | Envelope | Body |
| --- | --- | --- |
| `dialog` | req | `request: DialogRequest`; answered with `DialogResult` |
| `dialog-asked` | note | `request`; the answer comes back through the dialog buffer (A.5) |
| `resize` | note | `width`, `height` |
| `title` | note | `title` |
| `smoothing` | note | `enabled` |
| `set-fullscreen` | note | `enabled` |
| `fs-set` / `fs-remove` | note | `key`, and `value` for set; see §13.4 |
| `save` | note | none |
| `audio` | note | `command: AudioCommand` (A.4) |
| `net-open` | note | `id` (the engine's, never reused within a session), `port` |
| `net-send` | note | `id`, `bytes` |
| `net-end` | note | `id` |
| `ended` | note | none |
| `error` | note | `code`, `detail?` |

### A.4 Audio commands

Web Audio exists only on the main thread, so a worker keeps its own bookkeeping and sends only the
operations that make sound. The main half replays them on a real `AudioContext`. Node ids belong
to the engine. Id `0` is the destination and `-1` the listener; neither is ever created.

```ts
type AudioCommand =
  | { op: "create"; id: number; type: string; args: unknown[] }
  | { op: "connect"; id: number; target: number }
  | { op: "disconnect"; id: number }
  | { op: "start"; id: number; when: number; offset: number }
  | { op: "stop"; id: number }
  | { op: "param"; id: number; param: string; value: number }
  | { op: "ramp"; id: number; param: string; value: number; seconds: number }
  | { op: "cancelRamp"; id: number; param: string }
  | { op: "prop"; id: number; prop: string; value: unknown }
  | { op: "createBuffer"; id: number; channels: number; frames: number; rate: number }
  | { op: "bufferData"; id: number; ch: number; data: Float32Array; start?: number }
  | { op: "setBuffer"; id: number; bufferId: number }
  | { op: "deleteBuffer"; id: number }
  | { op: "deleteNode"; id: number }
  | { op: "onended"; id: number }
  | { op: "resume" }
  | { op: "suspend" };
```

- `ramp` is a duration, not two points on a timeline, because the worker cannot read the context's
  clock. The main half anchors it at the param's current value, and `seconds <= 0` is an immediate
  set.
- `bufferData.start` lets a long render be streamed in chunks.

### A.5 The dialog buffer

This is for an engine that blocks its worker thread on a dialog rather than awaiting one. It needs
cross-origin isolation.

| Offset | Size | Field |
| --- | --- | --- |
| 0 | int32 | `signal`: 0 while the engine waits, 1 once answered |
| 4 | int32 | `button`: the chosen value, or `DIALOG_DISMISSED` |
| 8 | int32 | `length`: bytes of `value` that are meaningful |
| 12 | int32 | reserved |
| 16 | 65520 bytes | `value`: UTF-8 |

The buffer is 64 KiB in total.

1. The engine sets `signal` to 0 **before** sending `dialog-asked`. A host that answers instantly
   would otherwise be missed.
2. The engine then waits with `Atomics.wait` on `signal`. On a timeout it reads the dialog as
   dismissed.
3. The answering side writes the value (truncating it if it is too long), then `button`, then
   `length`. It sets `signal` to 1 last, and calls `Atomics.notify`.

The question travels as a message; only the answer goes through shared memory. Only fixed scalars
and one string are shared, never a serialised object, and never a handle into either side's heap.

## Annex B: revisions

| Revision | Change |
| --- | --- |
| 1 | The first interface. |
| 2 | Added `HostServices.replica`. It is additive, but a break by §2, since an engine may rely on it. |
| 3 | Removed everything to do with mods. `start` takes the files. The game-to-host channel became neutral. |
| 4 | Replaced that channel with what a real machine offers: `HostServices.launchArgs` and loopback TCP in `HostServices.network`. |
| 5 | Added `HostServices.game`, the game id in every store key. Removed `HostServices.files`, a host-realm filesystem whose operations were never specified; the engine keeps its own over the replica. The store-key prefix became `gems`; a host holding keys under the old prefix migrates them itself. |

Added within revision 5, each behind a capability (§3.2): `capabilities.clock` (§8.1).

Added within revision 5, with no change to the host or plugin interface: the format profiles for
`gm8`, `gms1` and `gms2` (§13.5). They bind only an engine that lists the format in `formats`; such
an engine that diverges from its profile is non-conforming until it is fixed.

Added within revision 5 as advisory manifest keys, which a host may ignore (§3.2): `name`,
`formats`, `description`, `homepage`, `author` and `updates`; and, the same way, `credits`.

Added within revision 5, outside the interface, so no implementation is affected: the update feed
(§3.4), and its optional `icon`.

## Annex C (informative): an update feed

A maker serving `<base>/demo/<version>/` and a zip of each version publishes
`<base>/demo/latest.json`, and names it in every version's manifest as
`"updates": "https://example.org/demo/latest.json"`:

```json
{
  "id": "demo",
  "latest": "1.1.0",
  "icon": "https://example.org/demo/icon.png",
  "versions": {
    "1.1.0": {
      "url": "https://example.org/demo/1.1.0/demo-1.1.0.zip",
      "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    },
    "1.0.0": {
      "url": "https://example.org/demo/1.0.0/demo-1.0.0.zip",
      "sha256": "60303ae22b998861bce3b28f33eec1be758a213c86c93c076dbe9f558c11c752"
    }
  }
}
```
