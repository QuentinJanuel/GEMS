// §5: the game's files, as a `FileIndex`.

import type { FileIndex, IndexedFile } from "./spec.ts";

export function fileIndex(files: readonly IndexedFile[]): FileIndex {
  const byPath = new Map(files.map((file) => [file.path, file]));
  return {
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    get: (path) => byPath.get(path) ?? null,
  };
}

/** A game served over HTTP: `index` lists `{ path, size }`, each file is at `<base>/<path>`. */
export function httpFiles(base: string, index: readonly { path: string; size: number }[]): FileIndex {
  const url = (path: string) => `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const get = async (path: string) => {
    const response = await fetch(url(path));
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  return fileIndex(
    index.map(({ path, size }) => ({
      path,
      size,
      read: () => get(path),
    })),
  );
}

/** A folder the player picked: paths lose the folder's own name, so the game's root is the top. */
export function pickedFiles(picked: Iterable<File>): FileIndex {
  return fileIndex(
    Array.from(picked, (file) => ({
      path: file.webkitRelativePath.split("/").slice(1).join("/") || file.name,
      size: file.size,
      read: async () => new Uint8Array(await file.arrayBuffer()),
      readRange: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
    })),
  );
}
