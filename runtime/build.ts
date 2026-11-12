// Builds the hosted runtime into site/: the browser's half of runtime/, with its types stripped.
//
//   node runtime/build.ts
//
// The same files serve.ts strips on the fly, renamed to .js, because a static host serves .ts with
// a type a browser will not run as a module.

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "site");
const NODE_ONLY = new Set(["serve.ts", "drive.ts", "build.ts"]);
const toJs = (source: string) => source.replace(/(from\s+"\.\/[\w-]+)\.ts"/g, '$1.js"');

await rm(out, { recursive: true, force: true });
await mkdir(out);
for (const name of await readdir(here)) {
  if (!name.endsWith(".ts") || name.endsWith(".test.ts") || NODE_ONLY.has(name)) continue;
  const source = stripTypeScriptTypes(await readFile(path.join(here, name), "utf8"));
  await writeFile(path.join(out, name.replace(/\.ts$/, ".js")), toJs(source));
}
await copyFile(path.join(here, "sw.js"), path.join(out, "sw.js"));
const page = await readFile(path.join(here, "index.html"), "utf8");
await writeFile(path.join(out, "index.html"), page.replace('src="./page.ts"', 'src="./page.js"'));
// Cross-origin isolation, which a plugin that blocks a worker on a dialog needs (Annex A.5), and
// revalidation on every load: a CDN may otherwise give .js a browser cache of hours, and a page
// newer than its cached scripts misreads its own query.
await writeFile(
  path.join(out, "_headers"),
  "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cache-Control: no-cache\n",
);
console.log(`built ${path.relative(process.cwd(), out)}/`);
