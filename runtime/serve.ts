// Serves the GEMS Playground, one emulator and one game, cross-origin isolated.
//
//   node runtime/serve.ts --emulator <dir> --game <dir> [--port 8080]
//
// The page loads an emulator only through an update feed, so the emulator's directory is zipped
// and served with a generated feed at /emulator/latest.json: that URL is what is typed into the page.
// The game is served at /game/ with a generated /game/index.json. This file and the runtime's other .ts files run as they
// are: Node strips their types itself, and so does this server before the browser sees them.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const RUNTIME = path.dirname(fileURLToPath(import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

export interface Served {
  readonly server: Server;
  /** The page, with the game's launch arguments and loopback ports. */
  readonly url: string;
  /** The emulator's feed: what is typed into the page. */
  readonly emulatorUrl: string;
}

export async function serve(options: {
  /** The emulator's directory: it is zipped, so it must hold everything it loads. */
  emulator: string;
  game: string;
  port?: number;
  /** The game's launch arguments (§7.5). */
  args?: readonly string[];
  /** Loopback ports the game may connect to (§14): each connection is a WebSocket from the page to
   *  /net/<port>, piped here to 127.0.0.1:<port>. */
  net?: readonly number[];
}): Promise<Served> {
  const net = options.net ?? [];
  let emulatorUrl = "";
  const emulator = path.resolve(options.emulator);
  const { id, version } = JSON.parse(readFileSync(path.join(emulator, "plugin.json"), "utf8"));
  const scratch = mkdtempSync(path.join(tmpdir(), "gems-serve-"));
  execFileSync("zip", ["-qrX", path.join(scratch, "emulator.zip"), "."], { cwd: emulator });
  const zip = readFileSync(path.join(scratch, "emulator.zip"));
  rmSync(scratch, { recursive: true });
  const game = path.resolve(options.game);
  const index = await listGame(game);

  const server = createServer(async (request, response) => {
    // Cross-origin isolation, which a plugin that blocks a worker on a dialog needs (Annex A.5).
    response.setHeader("cross-origin-opener-policy", "same-origin");
    response.setHeader("cross-origin-embedder-policy", "require-corp");
    response.setHeader("cache-control", "no-store");
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = decodeURIComponent(url.pathname);
    try {
      if (route === "/game/index.json") return send(response, 200, TYPES[".json"], JSON.stringify(index));
      if (route === "/emulator/latest.json") {
        const sha256 = createHash("sha256").update(zip).digest("hex");
        const feed = { id, latest: version, versions: { [version]: { url: new URL("/emulator/emulator.zip", emulatorUrl).href, sha256 } } };
        return send(response, 200, TYPES[".json"], JSON.stringify(feed));
      }
      if (route === "/emulator/emulator.zip") {
        response.writeHead(200, { "content-type": "application/zip", "content-length": zip.length });
        return void response.end(zip);
      }
      const file =
        route.startsWith("/game/") ? within(game, route.slice(6)) :
        within(RUNTIME, route === "/" ? "index.html" : route.slice(1));
      const info = file ? await stat(file).catch(() => null) : null;
      if (!file || !info?.isFile()) return send(response, 404, "text/plain", "not found");

      const type = TYPES[path.extname(file)] ?? "application/octet-stream";
      if (file.startsWith(RUNTIME) && file.endsWith(".ts")) {
        return send(response, 200, type, stripTypeScriptTypes(await readFile(file, "utf8")));
      }
      response.writeHead(200, { "content-type": type, "content-length": info.size });
      createReadStream(file).pipe(response);
    } catch (error) {
      send(response, 500, "text/plain", String(error));
    }
  });

  server.on("upgrade", (request, socket: Socket) => {
    const port = Number(/^\/net\/(\d+)$/.exec(request.url ?? "")?.[1]);
    const { origin, "sec-websocket-key": key } = request.headers;
    // Only the ports it was started with, and only for the page at the address it prints: a
    // WebSocket is not held to the same-origin policy, and a Host header can be a rebound domain.
    if (!net.includes(port) || !key || (origin !== undefined && origin !== new URL(url).origin)) {
      socket.destroy();
      return;
    }
    pipe(socket, key, port);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  emulatorUrl = `http://127.0.0.1:${port}/emulator/latest.json`;
  const query = new URLSearchParams();
  for (const arg of options.args ?? []) query.append("arg", arg);
  for (const port of net) query.append("net", String(port));
  const url = `http://127.0.0.1:${port}/?${query}`;
  return { server, url, emulatorUrl };
}

/**
 * A WebSocket's binary messages to 127.0.0.1:`port` and back. The game's bytes are a stream, so
 * message boundaries mean nothing either way. The WebSocket is accepted only once the port is.
 */
function pipe(socket: Socket, key: string, port: number) {
  const tcp = connect(port, "127.0.0.1");
  socket.on("error", () => tcp.destroy());
  socket.on("close", () => tcp.destroy());
  tcp.once("error", (error) => {
    console.error(`net ${port}: ${error.message}`);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  tcp.once("connect", () => {
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    tcp.removeAllListeners("error");
    tcp.on("error", () => socket.destroy());
    tcp.on("data", (bytes) => socket.write(frame(2, bytes)));
    tcp.on("end", () => socket.end(frame(8, Buffer.alloc(0))));

    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      // RFC 6455 §5.2. A browser masks every frame it sends.
      for (;;) {
        if (pending.length < 2) return;
        const opcode = pending[0]! & 0x0f;
        let length = pending[1]! & 0x7f;
        const at = length === 126 ? 4 : length === 127 ? 10 : 2;
        if (pending.length < at) return;
        if (length === 126) length = pending.readUInt16BE(2);
        else if (length === 127) length = Number(pending.readBigUInt64BE(2));
        if (pending.length < at + 4 + length) return;
        const mask = pending.subarray(at, at + 4);
        const payload = Buffer.from(pending.subarray(at + 4, at + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
        pending = pending.subarray(at + 4 + length);
        if (opcode <= 2) tcp.write(payload); // continuation, text or binary
        else if (opcode === 8) tcp.end();
        else if (opcode === 9) socket.write(frame(10, payload));
      }
    });
  });
}

/** One unmasked, final server frame. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header =
    length < 126 ? Buffer.from([0x80 | opcode, length]) :
    length < 65536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]) :
    Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.alloc(8)]);
  if (length >= 65536) header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

/** `relative` inside `root`, or null if it would climb out. */
function within(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

function send(response: ServerResponse, status: number, type: string, body: string) {
  response.writeHead(status, { "content-type": type });
  response.end(body);
}

/** Every file under `root`, "/"-separated and relative to it (§5). */
async function listGame(root: string): Promise<{ path: string; size: number }[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.push({ path: path.relative(root, full).split(path.sep).join("/"), size: (await stat(full)).size });
  }
  return files;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { emulator: { type: "string" }, game: { type: "string" }, port: { type: "string" } },
  });
  if (!values.emulator || !values.game) {
    console.error("usage: node runtime/serve.ts --emulator <dir> --game <dir> [--port 8080]");
    process.exit(1);
  }
  const { url, emulatorUrl } = await serve({ emulator: values.emulator, game: values.game, port: Number(values.port ?? 8080) });
  console.log(`${url}\nemulator URL to type in: ${emulatorUrl}`);
}
