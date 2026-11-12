# GEMS

The Game Emulation Model Specification: a versioned, language-neutral protocol between a host (a
web page that shows games to a player) and a game emulator packaged as a plugin.

This repository holds the specification, the GEMS Playground (a minimal reference host) and a
conformance suite. It ships no client libraries.

## The protocol

The specification is [SPEC.md](SPEC.md), at revision 5. It defines:

- the plugin: a directory served over HTTP, described by its `plugin.json` manifest (§3.1–3.3),
  with an ES entry module whose default export is the engine (§4);
- the update feed: a `latest.json` that lists a plugin's versions and their zips, which a host uses
  to install an emulator and keep it up to date (§3.4, Annex C);
- the host services a session gets: a surface, window, assets, events, launch arguments, input,
  dialogs and the clock (§7–10);
- settings, which an engine declares and the host resolves, including a `limited` value to start
  from in the host's limited-resources mode (§11);
- the filesystem: mounts, the overlay, the replica, store keys, and the save-path profiles for
  the `gm8`, `gms1` and `gms2` formats (§13);
- loopback networking: a game's TCP connections to its own machine, which the host answers (§14).

## The GEMS Playground

The GEMS Playground, in `runtime/`, is a host for SPEC.md and nothing more: a canvas, input,
dialogs, localStorage-backed saves and a clock. It is meant to be read beside the spec, and to run
an emulator on its own. An emulator may use it in its own tests; nothing in production should
import it.

It is hosted at <https://gems.dappermink.me>: open the page, type in an emulator's update feed URL
(its `latest.json`, §3.4; the last one is remembered) and pick a game folder. An emulator is
loaded only through its feed: the page downloads the latest version's zip, checks its sha256 and
`runtime/sw.js` serves it from the page's own origin, file by file on request. Nothing picked
leaves the browser. `?limited` starts settings from their `limited` values.

To run it locally you need Node 24 or later, which runs its TypeScript directly.

```sh
pnpm install
# Serve an emulator directory and a game folder, then open the printed URL and type in the feed URL it prints
node runtime/serve.ts --emulator <emulator dir> --game <game dir>
# Or run the game headless for a while and report whether it ran
node runtime/drive.ts --emulator <emulator dir> --game <game dir> --seconds 20 --out shot.png
```

`serve.ts` zips the directory it is given and serves a feed for it, so the directory must hold
everything the emulator loads. `drive.ts` takes `--keys Code@seconds[:holdMs],…` to press keys,
`--profile <dir>` to keep saves between runs and `--dump store.json` to write the persisted store.
It needs Playwright's Chromium (`pnpm exec playwright install chromium`). `pnpm run build` builds
the hosted page into `site/`.

`host.ts` is the importable half: `run()` takes a loaded plugin, a game and an element to show it
in. `page.ts` is one thin caller of it.

`serve()` in `serve.ts` also takes the game's launch arguments (`args`, the page's `?arg=`) and
loopback ports (`net`, the page's `?net=`): a game's connection to one is a WebSocket from the page
to `/net/<port>`, which the server pipes to that port on its own machine.

What it leaves out: the hosted copy has nothing listening on the network, settings are never
changed from their starting values, and game files are read whole.

## Conformance

`conformance/save-paths/` checks an engine against the save-path profiles of §13.5. `probe.js` is a
mod that writes one file through each path form; run the patched game with
`drive.ts --dump store.json`, then:

```sh
node conformance/save-paths/check.ts --format gm8|gms1|gms2 --dump store.json [--name <Name>]
```

It compares the keys against `expected.json` and exits 1 on any difference.

## Checks

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
```

## Contributing

Issues and pull requests are welcome. A change to SPEC.md follows §2: say whether it needs a new
revision, and add it to Annex B. Every pull request must pass the checks above.

MIT. See [LICENSE](LICENSE).
