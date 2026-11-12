// Reads a zip archive into its files, so an emulator can be loaded from the one URL its feed gives.
//
// Stored and deflated entries only, which is what `zip` writes. Deflate is the browser's own
// `DecompressionStream`, so this needs no dependency.

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;

/** Every file in `zip` by its path inside the archive. Directories are left out. */
// shortcut: no ZIP64 (archives over 4 GiB or 65535 entries); a plugin is far below either.
export async function unzip(zip: Uint8Array<ArrayBuffer>): Promise<Map<string, Blob>> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record is the last thing in the file, followed only by a comment of up to 64 KiB.
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) end--;
  if (end < 0) throw new Error("not a zip archive");

  const files = new Map<string, Blob>();
  const names = new TextDecoder();
  let at = view.getUint32(end + 16, true);
  for (let count = view.getUint16(end + 10, true); count > 0; count--) {
    if (view.getUint32(at, true) !== CENTRAL_FILE_HEADER) throw new Error("corrupt zip archive");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    if (name.endsWith("/")) continue;

    // The local header's own name and extra field may differ in length from the central copy's.
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = new Blob([zip.subarray(start, start + size)]);
    if (method === 0) files.set(name, data);
    else if (method === 8) {
      const inflated = data.stream().pipeThrough(new DecompressionStream("deflate-raw"));
      files.set(name, await new Response(inflated).blob());
    } else throw new Error(`${name}: zip compression method ${method} is not supported`);
  }
  return files;
}
