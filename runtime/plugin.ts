// Loading a plugin: §3 of SPEC.md, in the order a host meets it.

import {
  ERROR_CODES,
  REVISION,
  type EnginePlugin,
  type ErrorCode,
  type PluginManifest,
  type SettingDescriptor,
  type SettingValue,
  type UpdateFeed,
} from "./spec.ts";

/** Why a plugin was refused. A host says which, rather than only "not a plugin" (§2). */
export class PluginRefused extends Error {}

/** §3.2: a manifest, checked. Throws `PluginRefused` with the first thing wrong with it. */
export function validateManifest(json: unknown): PluginManifest {
  const m = json as Partial<PluginManifest> | null;
  if (typeof m !== "object" || m === null) throw new PluginRefused("plugin.json is not an object");
  for (const key of ["id", "version", "entry"] as const) {
    if (typeof m[key] !== "string" || m[key] === "") {
      throw new PluginRefused(`plugin.json: "${key}" must be a non-empty string`);
    }
  }
  if (!Number.isInteger(m.apiVersion)) {
    throw new PluginRefused(`plugin.json: "apiVersion" must be an integer`);
  }
  if (m.apiVersion !== REVISION) {
    throw new PluginRefused(
      `built for GEMS revision ${m.apiVersion}; this host implements revision ${REVISION}`,
    );
  }
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(m.entry!)) {
    throw new PluginRefused(`plugin.json: "entry" must be relative to the plugin directory`);
  }
  const caps = m.capabilities as Record<string, unknown> | undefined;
  if (typeof caps !== "object" || caps === null || !Array.isArray(caps.settings)) {
    throw new PluginRefused(`plugin.json: "capabilities.settings" must be an array`);
  }
  if (caps.clock !== undefined && caps.clock !== "host" && caps.clock !== "engine") {
    throw new PluginRefused(`plugin.json: "capabilities.clock" must be "host" or "engine"`);
  }
  const unknown = Object.keys(caps).filter((key) => key !== "settings" && key !== "clock");
  if (unknown.length > 0) {
    throw new PluginRefused(`plugin.json declares capabilities this host lacks: ${unknown}`);
  }
  // Advisory display fields: a malformed value is dropped, never refused (§3.2).
  if (typeof m.name !== "string" || m.name === "") delete m.name;
  if (!Array.isArray(m.formats)) delete m.formats;
  else m.formats = m.formats.filter((f) => typeof f === "string" && /^[a-z0-9_-]{1,24}$/.test(f));
  for (const [key, max] of [["description", 280], ["author", 80]] as const) {
    const text = typeof m[key] === "string" ? m[key].trim() : "";
    if (text === "" || text.length > max) delete m[key];
    else m[key] = text;
  }
  for (const key of ["homepage", "updates"] as const) if (!isHttpsUrl(m[key])) delete m[key];
  return m as PluginManifest;
}

// Not URL.parse: it needs a 2024 browser, and older ones would throw on a field meant to be dropped.
function isHttpsUrl(url: unknown, loopback = false): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || (loopback && protocol === "http:" && hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/**
 * §3.4: a feed's text, checked. Throws `PluginRefused` with the first thing wrong with it.
 * Pass `id` when the feed was named by a manifest, so a feed for another plugin is refused too.
 * `loopback` also accepts http://127.0.0.1 URLs, for a development server; a host never sets it.
 */
export function parseUpdateFeed(text: string, id?: string, loopback = false): UpdateFeed {
  if (new TextEncoder().encode(text).length > 64 * 1024) throw new PluginRefused("feed: over 64 KiB");
  let feed: Partial<Record<keyof UpdateFeed, unknown>> | null;
  try {
    feed = JSON.parse(text);
  } catch {
    throw new PluginRefused("feed: not JSON");
  }
  const isName = (s: unknown): s is string => typeof s === "string" && s !== "" && s.length <= 128;
  if (typeof feed !== "object" || feed === null) throw new PluginRefused("feed: not an object");
  if (!isName(feed.id) || feed.id !== feed.id.toLowerCase()) {
    throw new PluginRefused(`feed: "id" must be a lowercase string of 1 to 128 characters`);
  }
  if (id !== undefined && feed.id !== id) throw new PluginRefused(`feed: for "${feed.id}", not "${id}"`);
  const versions = feed.versions;
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) {
    throw new PluginRefused(`feed: "versions" must be an object`);
  }
  const entries = Object.entries(versions);
  if (entries.length > 256) throw new PluginRefused("feed: over 256 versions");
  const checked = entries.map(([version, entry]: [string, { url?: unknown; sha256?: unknown }]) => {
    if (!isName(version)) throw new PluginRefused("feed: a version must be 1 to 128 characters");
    if (typeof entry !== "object" || entry === null || !isHttpsUrl(entry.url, loopback)) {
      throw new PluginRefused(`feed: version ${version} needs an https "url"`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new PluginRefused(`feed: version ${version} needs a "sha256" of 64 lowercase hex digits`);
    }
    return [version, { url: entry.url, sha256: entry.sha256 }] as const;
  });
  if (typeof feed.latest !== "string" || !Object.hasOwn(versions, feed.latest)) {
    throw new PluginRefused(`feed: "latest" must be a key of "versions"`);
  }
  // fromEntries defines own keys, so a version named "__proto__" stays data.
  const parsed: UpdateFeed = { id: feed.id, latest: feed.latest, versions: Object.fromEntries(checked) };
  // Advisory, like a manifest's homepage: a malformed icon is dropped, never refused (§3.4).
  if (isHttpsUrl(feed.icon)) parsed.icon = feed.icon;
  return parsed;
}

/**
 * §11: a value for every declared key. This host stores no choices, so every value is the default,
 * or the `limited` one in limited-resources mode.
 */
export function defaultSettings(
  descriptors: readonly SettingDescriptor[],
  limited = false,
): Record<string, SettingValue> {
  return Object.fromEntries(
    descriptors.map((d) => [d.key, limited && typeof d.limited === typeof d.default ? d.limited! : d.default]),
  );
}

export interface LoadedPlugin {
  readonly base: string;
  readonly manifest: PluginManifest;
  readonly engine: EnginePlugin;
}

/** §3: fetch the manifest, import the entry, and check the two agree. */
export async function loadPlugin(baseUrl: string): Promise<LoadedPlugin> {
  const base = baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/plugin.json`);
  if (!response.ok) throw new PluginRefused(`no plugin.json at ${base} (${response.status})`);
  const manifest = validateManifest(await response.json());

  const module = (await import(new URL(manifest.entry, `${base}/`).href)) as {
    default?: Partial<EnginePlugin>;
  };
  const engine = module.default;
  if (
    typeof engine !== "object" ||
    engine === null ||
    typeof engine.id !== "string" ||
    typeof engine.accepts !== "function" ||
    typeof engine.create !== "function"
  ) {
    throw new PluginRefused(`${manifest.entry} does not export an engine`);
  }
  if (engine.id !== manifest.id || engine.apiVersion !== manifest.apiVersion) {
    throw new PluginRefused(
      `the engine says ${engine.id} revision ${engine.apiVersion}, ` +
        `plugin.json says ${manifest.id} revision ${manifest.apiVersion}`,
    );
  }
  return { base, manifest, engine: engine as EnginePlugin };
}

/** §12: an error is known by its brand, and anything else is `"internal"`. */
export function errorCode(error: unknown): { code: ErrorCode; detail?: string } {
  const e = error as { engineError?: unknown; code?: unknown; detail?: unknown } | null;
  if (e?.engineError === true && ERROR_CODES.includes(e.code as ErrorCode)) {
    return { code: e.code as ErrorCode, detail: typeof e.detail === "string" ? e.detail : undefined };
  }
  return { code: "internal", detail: String(error) };
}
