// The shapes of SPEC.md, transcribed so this runtime can be type-checked against them.
//
// Not a client library: nothing outside this directory should import it, and SPEC.md wins wherever
// the two disagree.

export const REVISION = 5;

export type SettingValue = string | number | boolean;

export type SettingDescriptor =
  | { kind: "flag"; key: string; default: boolean; limited?: boolean }
  | {
      kind: "number";
      key: string;
      default: number;
      limited?: number;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
    }
  | { kind: "choice"; key: string; default: string; limited?: string; values: string[] };

export interface EngineCapabilities {
  settings: SettingDescriptor[];
  clock?: "host" | "engine";
}

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: number;
  entry: string;
  name?: string;
  formats?: string[];
  description?: string;
  homepage?: string;
  author?: string;
  updates?: string;
  assets?: { path: string; bytes?: number; url?: string; optional?: boolean }[];
  capabilities: EngineCapabilities;
}

/** §3.4: a plugin's update feed. */
export interface UpdateFeed {
  id: string;
  latest: string;
  versions: Record<string, { url: string; sha256: string }>;
  icon?: string;
}

export interface IndexedFile {
  readonly path: string;
  readonly size: number;
  read(): Promise<Uint8Array>;
  readRange?(start: number, end: number): Promise<Uint8Array>;
}

export interface FileIndex {
  readonly files: readonly IndexedFile[];
  readonly totalBytes: number;
  get(path: string): IndexedFile | null;
}

export interface Acceptance {
  readonly confidence: "exact" | "probable";
  readonly entry: string;
  readonly files?: FileIndex;
  readonly format?: { readonly format: string; readonly facts?: Record<string, unknown> };
}

export type ErrorCode =
  | "unsupported-game"
  | "corrupt-game"
  | "out-of-memory"
  | "asset-unavailable"
  | "unsupported-environment"
  | "internal";

export const ERROR_CODES: readonly ErrorCode[] = [
  "unsupported-game",
  "corrupt-game",
  "out-of-memory",
  "asset-unavailable",
  "unsupported-environment",
  "internal",
];

export type PointerButton = "left" | "middle" | "right";

export type GameInput =
  | { kind: "key-down"; code: string }
  | { kind: "key-up"; code: string }
  | { kind: "pointer-move"; x: number; y: number }
  | { kind: "pointer-down"; button: PointerButton; x: number; y: number }
  | { kind: "pointer-up"; button: PointerButton }
  | { kind: "wheel"; delta: number }
  | { kind: "focus-lost" };

export const DIALOG_DISMISSED = -1;

export interface DialogRequest {
  text: string;
  buttons: { label: string; value: number; kind?: "primary" | "default" }[];
  input?: { kind: "string" | "integer"; initial: string };
  dismissible?: boolean;
}

export interface DialogResult {
  button: number;
  value: string | null;
}

export interface ReplicaSink {
  put(path: string, bytes: Uint8Array): void;
  drop(key: string): void;
}

export interface ReplicaServices {
  seed(): Record<string, string>;
  set(key: string, value: string): void;
  remove(key: string): void;
  save(): void;
  watch(sink: ReplicaSink): void;
}

export interface NetworkConnection {
  send(bytes: Uint8Array): void;
  receive(): Uint8Array;
  readonly closed: boolean;
  close(): void;
}

export interface NetworkServices {
  readonly ports: readonly number[];
  connect(port: number): NetworkConnection | null;
}

export interface HostServices {
  readonly surface: {
    readonly canvas: OffscreenCanvas;
    reportSize(width: number, height: number): void;
    reportSmoothing(enabled: boolean): void;
  };
  readonly game: string;
  readonly replica: ReplicaServices;
  readonly dialogs: { show(request: DialogRequest): Promise<DialogResult> };
  readonly window: {
    setTitle(title: string): void;
    setFullscreen(enabled: boolean): void;
    isFullscreen(): boolean;
  };
  readonly assets: { readonly base: string };
  readonly settings: Readonly<Record<string, SettingValue>>;
  readonly events: {
    onSave(): void;
    onEnded(): void;
    onError(code: ErrorCode, detail?: string): void;
  };
  readonly launchArgs: readonly string[];
  readonly network: NetworkServices;
}

export interface GameInfo {
  readonly width: number;
  readonly height: number;
  readonly title?: string;
}

export interface EngineSession {
  start(files: FileIndex): Promise<GameInfo>;
  step(now: number): Promise<boolean> | boolean;
  sendInput(input: GameInput): void;
  setSetting(key: string, value: SettingValue): void;
  stats?(): Record<string, unknown>;
  dispose(): void;
}

export interface EnginePlugin {
  readonly id: string;
  readonly apiVersion: number;
  readonly capabilities: EngineCapabilities;
  accepts(files: FileIndex): Promise<Acceptance | null>;
  create(host: HostServices): Promise<EngineSession>;
}
