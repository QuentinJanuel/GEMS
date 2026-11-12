// Runs a game in the GEMS Playground in headless Chromium, and says whether it ran.
//
//   node runtime/drive.ts --emulator <dir> --game <dir> [--seconds 20] [--out shot.png]
//                         [--keys Code@seconds[:holdMs],…]
//                         [--profile <dir>] [--dump store.json]
//
// --profile keeps the browser's storage in <dir>, so a second run finds the first run's saves. The
// port is fixed (--port, default 4747) because storage belongs to an origin, and the port is part
// of it. --dump writes every persisted `gems:` entry, key to value, as JSON (for conformance/).
// Exits non-zero if the game failed to start, failed while running, or presented no frames.
// WebGL2 comes from SwiftShader, on the CPU: frame rates here are not a benchmark.

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { serve } from "./serve.ts";

const { values } = parseArgs({
  options: {
    emulator: { type: "string" },
    game: { type: "string" },
    seconds: { type: "string", default: "20" },
    out: { type: "string" },
    keys: { type: "string", default: "" },
    profile: { type: "string" },
    port: { type: "string", default: "4747" },
    dump: { type: "string" },
  },
});
if (!values.emulator || !values.game) {
  console.error("usage: node runtime/drive.ts --emulator <dir> --game <dir> [--seconds N] [--out shot.png]");
  process.exit(1);
}

const keys = values.keys
  .split(",")
  .filter(Boolean)
  .map((key) => {
    const [code, when = "0"] = key.split("@");
    const [at, hold = "120"] = when.split(":");
    return { code, at: Number(at) * 1000, hold: Number(hold) };
  })
  .sort((a, b) => a.at - b.at);

const { server, url, emulatorUrl } = await serve({ emulator: values.emulator, game: values.game, port: Number(values.port) });
const launch = {
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--autoplay-policy=no-user-gesture-required",
  ],
  viewport: { width: 960, height: 760 },
};
const browser = values.profile
  ? await chromium.launchPersistentContext(values.profile, launch)
  : await (await chromium.launch(launch)).newContext(launch);
const page = await browser.newPage();
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning" || message.text().startsWith("[gems]")) {
    console.log(`[page:${message.type()}] ${message.text()}`);
  }
});
page.on("pageerror", (error) => console.log(`[page:uncaught] ${error.message}`));

type State = { status: string; running: { frames: number } | null };
const read = () =>
  page.evaluate(() => {
    const s = (globalThis as unknown as { gems?: State }).gems;
    const saved = Object.keys(localStorage).filter((key) => key.startsWith("gems:file:"));
    return { status: s?.status ?? "no page", frames: s?.running?.frames ?? 0, saved };
  });

await page.goto(url);
await page.fill("#emulator-url", emulatorUrl);
await page.click("#emulator-form button");
await page.waitForFunction(
  () => {
    const s = (globalThis as unknown as { gems?: State }).gems?.status ?? "";
    return s === "running" || s.startsWith("error") || s.startsWith("refused");
  },
  undefined,
  { timeout: 120_000 },
);

const started = Date.now();
const first = await read();
for (const key of keys) {
  if (first.status !== "running") break;
  await page.waitForTimeout(Math.max(0, key.at - (Date.now() - started)));
  await page.keyboard.down(key.code);
  await page.waitForTimeout(key.hold);
  await page.keyboard.up(key.code);
}
const seconds = Number(values.seconds);
if (first.status === "running") await page.waitForTimeout(Math.max(0, seconds * 1000 - (Date.now() - started)));

const last = await read();
if (values.out) await page.screenshot({ path: values.out });
const elapsed = (Date.now() - started) / 1000;
console.log(
  `${last.status}: ${last.frames} frames in ${elapsed.toFixed(1)}s (${(last.frames / elapsed).toFixed(1)} fps)`,
);
for (const key of last.saved) console.log(`stored ${key}`);
if (values.dump) {
  const store = await page.evaluate(() =>
    Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("gems:"))),
  );
  writeFileSync(values.dump, JSON.stringify(store, null, 2));
}
await browser.close();
server.close();
process.exit(last.status === "running" && last.frames > 0 ? 0 : 1);
