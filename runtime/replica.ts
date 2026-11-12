// §13.3 and §13.4: the persisted half of a game's filesystem, kept in a `Storage` (localStorage).
//
// The engine mints every key and this side stores it verbatim, so the only grammar a host needs is
// enough to tell which keys belong to which game.

import type { ReplicaServices, ReplicaSink } from "./spec.ts";

const PREFIX = "gems";
const TAGS = ["file", "gone", "dir"];
const MOUNTS = ["game", "appdata"];

/** A key's parts, or null for a key that is not one of §13.4's. */
export function decodeKey(key: string): { tag: string; game: string; mount: string; path: string } | null {
  const [prefix, tag, game, mount, ...rest] = key.split(":");
  if (prefix !== PREFIX || !TAGS.includes(tag) || !game || !MOUNTS.includes(mount)) return null;
  return { tag, game, mount, path: rest.join(":") };
}

export interface Replica extends ReplicaServices {
  /** The sink the engine installed, for a host that adds or removes a file while it runs. */
  readonly sink: ReplicaSink | null;
  /** How many real saves the engine reported. */
  readonly saves: number;
}

export function createReplica(storage: Storage, game: string, onSave: () => void = () => {}): Replica {
  if (game === "" || game.includes(":")) throw new Error(`a game id may not be empty or hold ":"`);
  let sink: ReplicaSink | null = null;
  let saves = 0;
  return {
    seed() {
      const entries: Record<string, string> = {};
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)!;
        if (decodeKey(key)?.game === game) entries[key] = storage.getItem(key)!;
      }
      return entries;
    },
    set(key, value) {
      if (decodeKey(key)?.game !== game) throw new Error(`${key} is not this game's`);
      storage.setItem(key, value);
    },
    remove(key) {
      if (decodeKey(key)?.game === game) storage.removeItem(key);
    },
    save() {
      saves++;
      onSave();
    },
    watch(s) {
      sink = s;
    },
    get sink() {
      return sink;
    },
    get saves() {
      return saves;
    },
  };
}
