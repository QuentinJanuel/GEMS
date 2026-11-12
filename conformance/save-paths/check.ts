// Compares the store a save-path probe run left behind against the §13.5 table.
//
//   node conformance/save-paths/check.ts --format gm8|gms1|gms2 --dump store.json [--name <Name>]
//
// The dump is `drive.ts --dump` from a run of a game patched with probe.js. Every probe file
// holds its form id, so each form's key is found by content, not by guessing its path. `--name`
// fills `<Name>` (a Studio game's project name). Exits 1 on any difference.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { format: { type: "string" }, dump: { type: "string" }, name: { type: "string", default: "" } },
});
const table = JSON.parse(readFileSync(new URL("expected.json", import.meta.url), "utf8"));
// gms2 shares gms1's profile (§13.5).
const expected: Record<string, string | null> | undefined = table[values.format === "gms2" ? "gms1" : (values.format ?? "")];
if (!expected || !values.dump) {
  console.error("usage: check.ts --format gm8|gms1|gms2 --dump store.json [--name <Name>]");
  process.exit(2);
}
const store: Record<string, string> = JSON.parse(readFileSync(values.dump, "utf8"));

// key = gems:file:<game>:<mount>:<path> (§13.4); everything after the fourth ":" is the path.
const found = new Map<string, string>();
const vars: string[] = [];
for (const [key, value] of Object.entries(store)) {
  const parts = key.split(":");
  if (parts.length < 5) continue;
  const where = `${parts[3]}:${parts.slice(4).join(":").split("/").map(decodeURIComponent).join("/")}`;
  if (parts[1] === "dir" && /p_emptydir$/i.test(where)) found.set("emptydir", where);
  if (parts[1] !== "file") continue;
  const text = Buffer.from(value, "base64").toString("latin1");
  if (/p_var_/i.test(where)) vars.push(`${where} = ${JSON.stringify(text)}`);
  else found.set(/form\s*=\s*"?ini/.test(text) ? "ini" : text, where);
}

let failures = 0;
for (const [form, want] of Object.entries(expected)) {
  const wantKey = want?.replaceAll("<Name>", values.name);
  const got = found.get(form) ?? null;
  const ok = (got?.toLowerCase() ?? null) === (wantKey?.toLowerCase() ?? null);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${form.padEnd(12)} want ${wantKey ?? "(no key)"}${ok ? "" : `, got ${got ?? "(no key)"}`}`);
}
for (const line of vars) console.log(`var  ${line}`);
process.exit(failures ? 1 : 0);
