# Development environment

How to get Rally fully running — the API Workers, the local database, and the
Electron desktop client — on a workstation or inside an agent sandbox.

AI coding agents: read this at the start of every session before running a setup
or browser-automation command. If a step here has drifted from reality, fix the
step in the same change rather than working around it.

The container definition that this guide assumes is documented separately in
[the sandbox environment](sandbox.md).

## Prerequisites

- **Node.js 22 or newer**
- **pnpm 11.13.0** — pinned by `packageManager`. Run `corepack enable` once;
  Corepack then honours the pin. A sandbox image that ships pnpm 10.x resolves
  dependencies differently from the pnpm that gates the pull request in CI.
- No database server. D1 is SQLite, and `wrangler` runs it locally out of
  `.wrangler/state/`.

## 1. Install and prepare

```bash
corepack enable
pnpm install --frozen-lockfile
```

This takes about thirty seconds on a warm registry connection. The `electron`
package downloads a 125 MB binary during its postinstall step; if that step
fails, read [the proxy guide](sandbox-proxy.md) before retrying.

Retrying the install is not enough on its own. Once the package is in the pnpm
store, `pnpm install` reports `Already up to date` and re-runs nothing, and
`pnpm rebuild electron` exits 0 without fetching anything either — so a missing
binary stays missing and `electron-vite dev` fails at startup with
`Error: Electron uninstall`. Run the package's own installer to fetch it:

```bash
node node_modules/.pnpm/electron@*/node_modules/electron/install.js
ls node_modules/.pnpm/electron@*/node_modules/electron/dist/electron   # exists once it worked
```

```bash
cp .env.example .env.local   # optional for the API, required for the desktop client
pnpm env:sync
```

`scripts/sync-dev-env.mjs` defaults `APP_ENV=development` and
`RALLY_DEV_AUTH=true` and generates stable per-region signing and encryption
material, so the API runs without an `.env.local` at all. Copy the example file
when you want provider keys, or when you are running the desktop client — the
renderer reads `VITE_API_GLOBAL_URL` and `VITE_API_EU_URL` from it.

## 2. Create and seed the local database

```bash
pnpm db:migrate
pnpm db:seed
```

Both commands cover Global and EU. Run them before starting a Worker: the
migration and seed tooling writes to the same `.wrangler/state/<region>` SQLite
files that a running `wrangler dev` holds open.

An **empty** database is created from the newest checked-in baseline in
`packages/db/baselines/` — a snapshot of the schema as of migration 0090 — and
Wrangler then applies whatever came after it. That is about four seconds
per region instead of about forty-three for the full chain. A database that
already has tables skips the baseline and is migrated the ordinary way, so
re-running this on a warm container does what it always did. Hosted databases
never use a baseline. [`d1-baseline-migrations.md`](d1-baseline-migrations.md)
owns the mechanism; read it before regenerating one or moving its boundary.

After the Workers are running (§3), open the authority:

```bash
pnpm db:open-authority
```

The bootstrap's workspace-route upsert deliberately keeps a no-op `WHERE`
between its `SELECT ... FROM workspaces` and `ON CONFLICT`. SQLite otherwise
parses the `ON` as a possible join clause and rejects the fresh post-retirement
seed before product fixtures reach the Durable Objects.

**Known broken as of 2026-08-27.** The product-seed step fails with
`workstream_runtime_sql_not_committed` / `no such table: _runtime_messages`:
`routes/dev.ts` seeds transcript rows through a compatibility view that
transcript retirement removed. The authority walk itself still succeeds, so the
local stack is on the Durable-Object path, and the work streams and their
descriptions do seed — it is the transcript rows that do not, so a seeded work
stream opens empty. Create one through the API if you need a populated one.

This walks the **Global** authority to `durable_object_open`, so the local
stack serves the same post-cutover Durable-Object model production runs, and
seeds the product fixtures from `packages/db/seed-product.json` into their
Durable Objects through the Worker's dev-only seed route — which is why the Workers must be up first; run without
them, the walk completes and the script says to re-run for the import. Local
EU deliberately stays `legacy_open`. Skipping this step leaves local
development on the legacy path, where none of the object-authority code
executes — the gap that once hid a defect failing every production harness
run. The script is idempotent and re-runs repair partial imports.

## 3. Start the API Workers

**Inside a sandbox, use `dev:api:local`, not `dev:api`.**

```bash
pnpm dev:api:local       # both regions, remote bindings disabled
```

`scripts/dev-regional-api.mjs` starts Global first and waits for Wrangler's
ready signal before starting EU. The Workers then run concurrently as before.
This short serialization is required because both regional configs build the
same crash-symbolicator Container image; concurrent Wrangler image builds can
remove one another's transient local tag and leave both Workers unable to start.
The runner forwards `SIGINT`/`SIGTERM` to both child processes.

Both `dev:local` scripts pass `--enable-containers=false`. Building that
Container image needs a Docker daemon, and the sandbox image has none, so
Wrangler aborts before either Worker binds its port:

```
failed to connect to the docker API at unix:///var/run/docker.sock
```

Because `concurrently` runs with `-k`, the symptom is again "no server at all"
rather than "no container". Nothing in the product reaches a container instance
during ordinary local work, so disabling them costs nothing here; `pnpm dev:api`
still builds the image and is the path to use when the symbolicator itself is
what you are working on.

`wrangler.global.jsonc` declares an `ai` binding, and Workers AI has no local
implementation — wrangler reports it as `Mode: remote` and opens a remote proxy
session to Cloudflare to serve it. Without Cloudflare credentials, or behind a
sandbox egress policy, that session fails:

```
✘ [ERROR] Failed to start the remote proxy session.
          Error reloading remote server: Proxy response (403) !== 200 when HTTP Tunneling
```

Both Workers then exit non-zero, and because `concurrently` runs with `-k` the
healthy region is torn down with the failed one, so the symptom is "no server at
all" rather than "no AI binding". `wrangler dev --local` disables remote bindings
and both regions start in about two seconds.

What that costs: `env.AI` is unavailable, so the memory-embedding paths in
`apps/api/src/services/memory-service.ts` cannot run. `env.MEMORY_INDEX`
(Vectorize) is reported as `not supported` by `wrangler dev` in every local run,
remote bindings or not, so nothing is lost there. `env.FLAGS` (Flagship) is also
reported `not supported`, because Flagship bindings are always remote — but
unlike the others the binding object is still present, and it is each *call*
that rejects with `Binding FLAGS needs to be run remotely`. Every agent then
uses the model ids in its `OPENROUTER_*` Worker variables, which is the designed
fallback rather than a degradation — see
[the feature-flag document](feature-flags.md#local-development).

Verify both regions:

```bash
curl -s http://127.0.0.1:8787/health   # Global
curl -s http://127.0.0.1:8788/health   # EU
```

Expect `"ok": true` with D1, R2, Durable Objects, Queues, and Workflows
available. The provider checks report `not configured` until you supply keys;
that is expected and does not block local work.

## 4. Run the desktop client headlessly

The Electron client runs under Xvfb. Two flags matter: the agent shell runs as
root, so Chromium's sandbox must be disabled, and a debugging port is needed to
attach a browser driver.

```bash
xvfb-run -a --server-args="-screen 0 1440x900x24" \
  pnpm exec dotenv -e .env.local -- \
  pnpm --filter @rally/desktop exec electron-vite dev --noSandbox --remoteDebuggingPort=9222
```

`--noSandbox` and `--remoteDebuggingPort` are **electron-vite's** CLI options,
not Chromium's, which is why they are camelCase here. electron-vite turns them
into `NO_SANDBOX` and `REMOTE_DEBUGGING_PORT` in the environment and appends
Electron's own `--no-sandbox` and `--remote-debugging-port` when it spawns the
app (`electron-vite/dist/cli.js`, `dist/chunks/lib-*.js`). Do not "correct" them
to the Chromium spellings — electron-vite does not define those options, and the
flags would stop reaching Electron.

The renderer's Vite server comes up on `http://localhost:5173/` and the app
window opens on the virtual display. `Failed to connect to the bus` errors from
D-Bus are expected on a container with no session bus and are harmless.
`predev` builds macOS native components only on darwin/arm64, so it is a no-op
here.

### Driving and screenshotting it

Playwright is installed globally on the sandbox image and attaches to the running
Electron process over the DevTools protocol. Nothing needs to be added to the
repository, and no browser is downloaded.

```javascript
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages().find((candidate) => candidate.url().startsWith('http'));
await page.getByText('Use local development account').click();
await page.screenshot({ path: '/tmp/avalon.png' });
await browser.close();
```

**Every visible change must be looked at in a real window before it is called
done.** A passing component test asserts on the DOM, which says nothing about
whether an element is visible, positioned, legible, or covered by something else.
Capture the screens you touched and read the images.

Development sign-in works end to end in this setup: **Use local development
account** authenticates against the local Global Worker and opens the seeded
workspace with its work streams, automations, and onboarding checklist.

## What cannot be verified in a sandbox

- **Workers AI** (`env.AI`), **Vectorize** (`env.MEMORY_INDEX`), and **Flagship**
  (`env.FLAGS`), per above. Served flag values cannot be exercised locally; the
  Worker-variable fallback they resolve to can.
- **Real OAuth callbacks.** Providers require a public HTTPS redirect; a local
  Worker has none unless a tunnel is configured.
- **A real streaming turn.** A local run has no provider credentials, so a run
  fails with `harness_execution_failed` rather than streaming, and anything that
  depends on tokens arriving over time cannot be exercised the ordinary way. A
  turn can still be played into the live screen: wrap `window.WebSocket` in the
  renderer to capture the sockets the app opens, take the one whose URL ends in
  `/substreams/0` — the work-stream socket carries metadata, the substream
  socket carries the transcript — and dispatch `MessageEvent`s onto it carrying
  `stream_started` and then `stream_delta` frames in the shape
  `@rally/contracts` accepts. Two traps: `sequence` must exceed the room's
  current one or `applyEvent` discards the frame as replay, and an in-page
  `setInterval` is throttled to once a second when the window is occluded, so
  drive the tokens from the CDP side and call `Page.bringToFront` first. A
  trackpad gesture over the result is `Input.dispatchMouseEvent` with
  `type: 'mouseWheel'`.
- **The macOS menu bar status item, and the windowless half of a login launch.**
  The item is created only on darwin, and there is no menu bar to draw it into
  here. The launch skips its window only when a status item is actually present,
  so off darwin that check is always false and `--hidden` opens a window like any
  other launch — proving the window *does not* open needs a Mac. What the sandbox
  can check is everything around it: the two Settings toggles in a real window,
  that a `--hidden` launch still loads the menu's content in the main process,
  and that a deep link delivered to that instance opens the work stream. See
  [`menu-bar.md`](menu-bar.md).
- **macOS packaging, signing, notarization, and Gatekeeper checks.**
  `package:desktop`, `start:desktop:packaged`, and the release publisher are
  macOS-only and must run on a Mac.
- **Remote D1, deploys, and anything else that needs Cloudflare credentials.**

`packages/db/seed.sql` includes the resource and connector fixtures required by
the right-rail checks in `pnpm smoke:local`. Re-run `pnpm db:seed` after updating
an older worktree so the smoke test sees both fixtures.

## Quick reference

| Task | Command |
| --- | --- |
| Install dependencies | `pnpm install --frozen-lockfile` |
| Sync development Worker vars | `pnpm env:sync` |
| Migrate both regions | `pnpm db:migrate` |
| Regenerate the D1 baseline | `pnpm db:baseline:create <through-migration.sql>` |
| Check the baseline against the hosted databases | `pnpm db:baseline:verify` |
| Seed both regions | `pnpm db:seed` |
| Start both Workers (sandbox) | `pnpm dev:api:local` |
| Start both Workers (workstation) | `pnpm dev:api` |
| Global health | `curl -s http://127.0.0.1:8787/health` |
| EU health | `curl -s http://127.0.0.1:8788/health` |
| Desktop client, headless | see [§4](#4-run-the-desktop-client-headlessly) |
| Lint / typecheck / test | `pnpm lint`, `pnpm typecheck`, `pnpm test` |
| Lint, ignoring the cache | `pnpm lint:fresh` |

## Quality gate caches

`pnpm lint` and `pnpm typecheck` both cache, which is the difference between a
warm run of a few seconds and a cold one of about forty-five. Both caches are
gitignored, and CI checks out fresh, so neither changes what CI proves.

| Gate | Cold | Warm | Cache |
| --- | --- | --- | --- |
| `pnpm lint` | ~45s | ~2s | `.eslintcache` |
| `pnpm typecheck` | ~45s | ~14s | `*.tsbuildinfo` beside each tsconfig |

**The typecheck cache is sound.** TypeScript records the module graph it actually
resolved, so editing a signature in `packages/contracts` re-checks every
dependent — verified by changing `asUserId` to take a second argument, which
surfaced 120 errors across `apps/api` on a warm run.

**The ESLint cache is not, in two ways**, because it keys on each file's own
contents and nothing else:

- **A rule implementation changing is invisible to it.** The config imports the
  17 rules in `scripts/eslint-rules/` from separate files, and those are not part
  of the key. Rewriting one to report on every file flagged 889 files cold and 1
  warm — the one being the rule file itself, which had changed. **Run
  `pnpm lint:fresh` after touching a rule.**
- **A type-aware verdict that depends on another file is too**, more narrowly.
  `consistent-type-imports` reads whether an imported symbol is a type, which
  lives in the file it came from, so turning an export from a value into a type
  does not re-lint its importers.

Both were accepted deliberately: the p90 run changes neither, and CI runs cold.
When a local green looks implausible, `pnpm lint:fresh` is the first thing to
try.

## Working in a second checkout or worktree

`node_modules`, `.env.local`, `apps/api/.dev.vars.*`, and `.wrangler/state/` are
all ignored by Git and are not carried across. A new checkout needs the full
sequence from [§1](#1-install-and-prepare) — including its own migrate and seed,
because the D1 databases live under `.wrangler/state/`. Use distinct ports
(`--port`) if two checkouts must serve at once.
