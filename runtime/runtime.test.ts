import assert from "node:assert/strict";
import { test } from "node:test";
import { fileIndex } from "./files.ts";
import { toGamePixels } from "./host.ts";
import { defaultSettings, errorCode, parseUpdateFeed, PluginRefused, validateManifest } from "./plugin.ts";
import { createReplica, decodeKey } from "./replica.ts";
import { serve } from "./serve.ts";
import { unzip } from "./zip.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const manifest = {
  id: "demo",
  version: "1.0.0",
  apiVersion: 5,
  entry: "entry.js",
  capabilities: { settings: [{ kind: "choice", key: "mode", default: "a", values: ["a", "b"] }] },
};

test("a valid manifest is accepted", () => {
  assert.equal(validateManifest(manifest).id, "demo");
});

test("a manifest is refused for what §3 refuses", () => {
  const refused = (patch: object) =>
    assert.throws(() => validateManifest({ ...manifest, ...patch }), PluginRefused);
  refused({ id: "" });
  refused({ apiVersion: 4 });
  refused({ apiVersion: 4.5 });
  refused({ entry: "https://elsewhere/entry.js" });
  refused({ entry: "//elsewhere/entry.js" });
  refused({ capabilities: { settings: [], mods: true } });
  refused({ capabilities: { settings: [], clock: "wall" } });
});

test("a manifest's name and formats load, unknown ids included (§3.2)", () => {
  const m = validateManifest({ ...manifest, name: "Demo", formats: ["gm8", "someday"] });
  assert.equal(m.name, "Demo");
  assert.deepEqual(m.formats, ["gm8", "someday"]);
});

test("a malformed name or formats is ignored, not refused (§3.2)", () => {
  assert.equal(validateManifest({ ...manifest, name: "" }).name, undefined);
  assert.equal(validateManifest({ ...manifest, name: 3 }).name, undefined);
  assert.equal(validateManifest({ ...manifest, formats: "gm8" }).formats, undefined);
  const ids = ["gms1", "GMS2", "a b", "x".repeat(25), 7];
  assert.deepEqual(validateManifest({ ...manifest, formats: ids }).formats, ["gms1"]);
});

test("a manifest's description, homepage, author and updates load, trimmed (§3.2)", () => {
  const m = validateManifest({
    ...manifest,
    description: "  Runs demos.  ",
    homepage: "https://example.org/demo",
    author: " Someone ",
    updates: "https://example.org/demo/latest.json",
  });
  assert.equal(m.description, "Runs demos.");
  assert.equal(m.homepage, "https://example.org/demo");
  assert.equal(m.author, "Someone");
  assert.equal(m.updates, "https://example.org/demo/latest.json");
});

test("a malformed description, homepage, author or updates is dropped, not refused (§3.2)", () => {
  const dropped = (patch: Partial<Record<"description" | "homepage" | "author" | "updates", unknown>>) => {
    const m = validateManifest({ ...manifest, ...patch });
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) assert.equal(m[key], undefined, key);
  };
  dropped({ description: "   " });
  dropped({ description: "x".repeat(281) });
  dropped({ author: 7 });
  dropped({ author: "x".repeat(81) });
  dropped({ homepage: "http://example.org" });
  dropped({ homepage: "not a url" });
  dropped({ updates: `https://example.org/${"x".repeat(2048)}` });
  assert.equal(validateManifest({ ...manifest, author: ` ${"x".repeat(80)} ` }).author, "x".repeat(80));
});

test("a manifest's credits keep valid entries and drop malformed ones (§3.2)", () => {
  const ok = { name: "Core", license: "MIT", url: "https://example.org/core" };
  const credits = validateManifest({
    ...manifest,
    credits: [
      { ...ok, name: " Core ", copyright: "(c) A", upstream: "http://x.org", note: 7 },
      { ...ok, url: "http://example.org" },
      { ...ok, license: "" },
      "nope",
      ...Array.from({ length: 25 }, () => ok),
    ],
  }).credits;
  assert.deepEqual(credits?.[0], { ...ok, copyright: "(c) A" });
  assert.equal(credits?.length, 20);
  assert.equal(validateManifest({ ...manifest, credits: "x" }).credits, undefined);
});

test("a manifest with a bad homepage loads without it (§3.2)", () => {
  for (const homepage of ["not a url", "http://example.org"]) {
    assert.equal(validateManifest({ ...manifest, homepage }).homepage, undefined, homepage);
  }
});

const sha = "a".repeat(64);
const feed = {
  id: "demo",
  latest: "1.1.0",
  versions: {
    "1.1.0": { url: "https://example.org/demo/1.1.0.zip", sha256: sha },
    "1.0.0": { url: "https://example.org/demo/1.0.0.zip", sha256: sha },
  },
};

test("an update feed is parsed, unknown keys ignored (§3.4)", () => {
  const extra = { ...feed, mirror: 1, versions: { "1.1.0": { ...feed.versions["1.1.0"], size: 9 } } };
  assert.deepEqual(parseUpdateFeed(JSON.stringify(feed), "demo"), feed);
  assert.deepEqual(parseUpdateFeed(JSON.stringify(extra)), {
    id: "demo",
    latest: "1.1.0",
    versions: { "1.1.0": feed.versions["1.1.0"] },
  });
});

test("an update feed's icon is kept when https, dropped when malformed, never refused (§3.4)", () => {
  const icon = "https://example.org/demo/icon.svg";
  assert.equal(parseUpdateFeed(JSON.stringify({ ...feed, icon })).icon, icon);
  for (const bad of ["http://example.org/i.png", "javascript:alert(1)", "data:image/png;base64,AAAA", "not a url", 5, null, {}, `https://example.org/${"x".repeat(2048)}`]) {
    const parsed = parseUpdateFeed(JSON.stringify({ ...feed, icon: bad }));
    assert.equal(Object.hasOwn(parsed, "icon"), false, String(bad));
    assert.deepEqual(parsed, feed);
  }
});

test("an update feed is refused for what §3.4 refuses", () => {
  const entry = (patch: object) => ({ ...feed, versions: { "1.1.0": { ...feed.versions["1.1.0"], ...patch } } });
  const many = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`1.0.${i}`, feed.versions["1.0.0"]]));
  const cases: [string, unknown, string?][] = [
    ["not JSON", "{"],
    ["not an object", null],
    ["no id", { ...feed, id: undefined }],
    ["uppercase id", { ...feed, id: "Demo" }],
    ["oversize id", { ...feed, id: "x".repeat(129) }],
    ["another plugin's feed", feed, "other"],
    ["versions is an array", { ...feed, versions: [] }],
    ["latest not in versions", { ...feed, latest: "2.0.0" }],
    ["no latest", { ...feed, latest: undefined }],
    ["latest inherited, not listed", { ...feed, latest: "toString" }],
    ["http url", entry({ url: "http://example.org/demo.zip" })],
    ["oversize url", entry({ url: `https://example.org/${"x".repeat(2048)}` })],
    ["short sha256", entry({ sha256: "a".repeat(63) })],
    ["uppercase sha256", entry({ sha256: "A".repeat(64) })],
    ["entry not an object", { ...feed, versions: { "1.1.0": "https://example.org/demo.zip" } }],
    ["empty version", { ...feed, latest: "", versions: { "": feed.versions["1.0.0"] } }],
    ["oversize version", { ...feed, latest: "1".repeat(129), versions: { ["1".repeat(129)]: feed.versions["1.0.0"] } }],
    ["too many versions", { ...feed, latest: "1.0.0", versions: many }],
    ["over 64 KiB", { ...feed, padding: "x".repeat(64 * 1024) }],
  ];
  for (const [why, json, id] of cases) {
    const text = typeof json === "string" ? json : JSON.stringify(json);
    assert.throws(() => parseUpdateFeed(text, id), PluginRefused, why);
  }
});

test("an engine may own the clock (§8.1)", () => {
  const caps = { settings: [], clock: "engine" };
  assert.equal(validateManifest({ ...manifest, capabilities: caps }).capabilities.clock, "engine");
});

test("another revision is named as such", () => {
  assert.throws(() => validateManifest({ ...manifest, apiVersion: 6 }), /revision 6/);
});

test("every declared setting gets its default (§11)", () => {
  const descriptors = [
    { kind: "number", key: "n", default: 5 },
    { kind: "flag", key: "f", default: false },
  ] as never;
  assert.deepEqual(defaultSettings(descriptors), { n: 5, f: false });
});

test("limited-resources mode takes `limited` where it is declared and well typed (§11)", () => {
  const descriptors = [
    { kind: "number", key: "n", default: 5, limited: 2 },
    { kind: "flag", key: "f", default: false, limited: true },
    { kind: "flag", key: "g", default: false },
    { kind: "number", key: "bad", default: 5, limited: "x" },
  ] as never;
  assert.deepEqual(defaultSettings(descriptors), { n: 5, f: false, g: false, bad: 5 });
  assert.deepEqual(defaultSettings(descriptors, true), { n: 2, f: true, g: false, bad: 5 });
});

test("errors are known by their brand (§12)", () => {
  assert.deepEqual(errorCode({ engineError: true, code: "corrupt-game", detail: "x" }), {
    code: "corrupt-game",
    detail: "x",
  });
  assert.equal(errorCode({ engineError: true, code: "made-up" }).code, "internal");
  assert.equal(errorCode({ code: "corrupt-game" }).code, "internal");
  assert.equal(errorCode(new Error("boom")).code, "internal");
});

test("store keys decode by §13.4, with the path after the fourth colon", () => {
  assert.deepEqual(decodeKey("gems:file:g1:appdata:Save/a%3Ab"), {
    tag: "file",
    game: "g1",
    mount: "appdata",
    path: "Save/a%3Ab",
  });
  assert.equal(decodeKey("gems:file:g1:appdata:")?.path, "");
  assert.equal(decodeKey("gems:meta:g1:appdata:x"), null);
  assert.equal(decodeKey("gems:file:g1:temp:x"), null);
  assert.equal(decodeKey("other:file:g1:game:x"), null);
});

test("the replica sees only its own game's entries", () => {
  const storage = fakeStorage({
    "gems:file:g1:game:a": "QQ==",
    "gems:gone:g1:game:b": "1",
    "gems:file:g2:game:a": "Qg==",
    "gems:meta:g1:game:a": "host's own",
    unrelated: "x",
  });
  const replica = createReplica(storage, "g1");
  assert.deepEqual(replica.seed(), { "gems:file:g1:game:a": "QQ==", "gems:gone:g1:game:b": "1" });
  replica.set("gems:dir:g1:appdata:Save", "1");
  replica.remove("gems:file:g2:game:a");
  assert.equal(storage.getItem("gems:dir:g1:appdata:Save"), "1");
  assert.equal(storage.getItem("gems:file:g2:game:a"), "Qg==");
  assert.throws(() => replica.set("gems:file:g2:game:a", ""));
  assert.throws(() => createReplica(storage, "a:b"));
});

test("pointer positions map into game pixels through the letterbox (§9)", () => {
  // A 400x300 game in an 800x400 box: scale 4/3, 133.33 px bars left and right.
  assert.deepEqual(toGamePixels(400, 200, { width: 800, height: 400 }, { width: 400, height: 300 }), {
    x: 200,
    y: 150,
  });
  assert.deepEqual(toGamePixels(134, 0, { width: 800, height: 400 }, { width: 400, height: 300 }), {
    x: 0,
    y: 0,
  });
});

test("a file index finds files by exact path and sums their sizes (§5)", () => {
  const file = (path: string, size: number) => ({ path, size, read: async () => new Uint8Array(size) });
  const index = fileIndex([file("data.win", 10), file("mus/a.ogg", 5)]);
  assert.equal(index.totalBytes, 15);
  assert.equal(index.get("mus/a.ogg")?.size, 5);
  assert.equal(index.get("Data.win"), null);
});

function fakeStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

test("a zipped plugin unzips to its files, stored or deflated", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gems-zip-"));
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  writeFileSync(path.join(dir, "sub", "big.txt"), "gems ".repeat(10_000));
  for (const level of ["-0", "-9"]) {
    execFileSync("zip", ["-qr", level, "out.zip", "plugin.json", "sub"], { cwd: dir });
    const files = await unzip(new Uint8Array(readFileSync(path.join(dir, "out.zip"))));
    assert.deepEqual([...files.keys()].sort(), ["plugin.json", "sub/big.txt"]);
    assert.equal(await files.get("sub/big.txt")!.text(), "gems ".repeat(10_000));
    execFileSync("rm", [path.join(dir, "out.zip")]);
  }
  await assert.rejects(unzip(new Uint8Array(64)), /not a zip archive/);
});

test("a --net port is piped to the same port on this machine, and only for its own page (§14)", async () => {
  const echo = createServer((socket) => socket.pipe(socket));
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const port = (echo.address() as AddressInfo).port;
  const dir = mkdtempSync(path.join(tmpdir(), "gems-net-"));
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  const { server, url } = await serve({ emulator: dir, game: dir, args: ["--x=1"], net: [port] });
  assert.deepEqual(new URL(url).searchParams.getAll("arg"), ["--x=1"]);
  const at = (route: string, origin?: string) =>
    new WebSocket(new URL(route, url.replace("http", "ws")), origin ? { headers: { origin } } as never : undefined);

  // Three frame lengths: 7-bit, 16-bit and 64-bit.
  const sent = Buffer.concat([Buffer.from("hi"), Buffer.alloc(300, 1), Buffer.alloc(70_000, 2)]);
  const socket = at(`/net/${port}`);
  socket.binaryType = "arraybuffer";
  const chunks: Buffer[] = [];
  await new Promise((resolve) => (socket.onopen = resolve));
  for (const part of [sent.subarray(0, 2), sent.subarray(2, 302), sent.subarray(302)]) socket.send(part);
  await new Promise<void>((resolve) => {
    socket.onmessage = (event) => {
      chunks.push(Buffer.from(event.data as ArrayBuffer));
      if (Buffer.concat(chunks).length >= sent.length) resolve();
    };
  });
  assert.deepEqual(Buffer.concat(chunks), sent);
  socket.close();

  const refused = (socket: WebSocket) => new Promise((resolve) => (socket.onerror = resolve));
  await refused(at(`/net/${port + 1}`));
  await refused(at(`/net/${port}`, "http://elsewhere.example"));
  server.closeAllConnections();
  server.close();
  echo.close();
});
