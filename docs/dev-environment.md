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
The desktop's “Use local development account” action stores both the seeded
workspace credential and a separate Global identity credential. That mirrors a
real signed-in account closely enough for the workspace menu to discover,
activate, and create workspaces without returning to sign-in.

## 2. Create and seed the local database

```bash
pnpm db:migrate
pnpm db:seed
```

Both commands cover Global and EU. `db:migrate` also applies the content-free
platform D1 migration chain into both regional local-state directories, so the
shared `PLATFORM_DB` binding has the same route table whichever local Worker
opens it. Run them before starting a Worker: the migration and seed tooling
writes to the same `.wrangler/state/<region>` SQLite files that a running
`wrangler dev` holds open.

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

`routes/dev.ts` seeds transcript rows through the canonical ordered-turn
storage API. It does not recreate the retired message tables or their runtime
views merely to import development fixtures.

This walks both **Global and EU** authorities to `durable_object_open`, so the
local stack serves the same post-cutover Durable-Object model production runs,
and seeds the product fixtures from `packages/db/seed-product.json` into both
regions' Durable Objects through their Worker dev-only seed routes — which is
why the Workers must be up first; run without them, the walk completes and the
script says to re-run for the import. Opening both is required to exercise a
real cross-region desktop switch; leaving EU at `legacy_open` makes its product
preflight honestly return maintenance after activation. Skipping this step
leaves local development on the unsupported legacy path, where none of the
object-authority code executes — the gap that once hid a defect failing every
production harness run. The script is idempotent and re-runs repair partial
imports.

## 3. Start the API Workers

**Inside a sandbox, use `dev:api:local`, not `dev:api`.**

```bash
pnpm dev:api:local       # both regions, remote bindings disabled
```

If that command exits without either Worker binding a port, read the
container-flag note below before debugging anything else.

`scripts/dev-regional-api.mjs` starts Global first and waits for Wrangler's
ready signal before starting EU. The Workers then run concurrently as before.
`pnpm env:sync` writes the EU Worker's local URL into Global's
`EU_PUBLIC_API_BASE_URL`; the control plane uses it to validate the route in an
EU session instead of comparing that local session with the production host.
Each regional command supplies the API, document-processing, and Terminal
provider configs to one Wrangler multi-Worker session; Global also supplies its
private telemetry-delivery config. Local calls therefore use the same typed
Service Bindings as production without loading provider modules from a request
handler.
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

**That flag does not survive a multi-config session in every wrangler, and
`dev:api:local` is one.** The symptom is `Preparing container image(s)…`
followed by the Docker error above, in spite of `--enable-containers=false`; the
Workers never bind their ports, so the whole command fails rather than starting
without containers. The EU command passes three `--config` files — the API,
document-processing, and Terminal Workers — while Global passes those plus its
private telemetry-delivery Worker. Auxiliary configs can lose the flag: the same
command with one `--config` is ready in about two seconds and builds no image.
`"dev": { "enable_containers": false }` in the config is ignored the same way,
in the main config and across the multi-config session. Observed on
4.126.0, which the `wrangler: latest` in `apps/api/package.json` resolved to at
the time of writing — check which version you have before assuming the note
still applies, and delete it once a newer one honours the flag.

Until then, and where one region is enough — anything that does not cross into
EU, and does not call the document-processing, Terminal, or telemetry-delivery
Workers over their service bindings — run Global on its own config, where the
flag is honoured and nothing on disk changes:

```bash
pnpm --filter @rally/api exec wrangler dev --local \
  --config wrangler.global.jsonc --env-file .dev.vars.global \
  --persist-to .wrangler/state/global --port 8787 --inspector-port 9230 \
  --enable-containers=false
```

`pnpm db:open-authority` then seeds Global and says to re-run for EU, which is
the same "start the Workers and re-run" message it gives for any region that is
down. Where both regions are needed, the local workaround is to delete the
`containers` array from `wrangler.global.jsonc` and `wrangler.eu.jsonc` for the
session; the
`CRASH_SYMBOLICATOR` Durable Object binding can stay, and both regions come up
normally. **That edit must not be committed, and while it is in place
`pnpm test` is red** — `apps/api/test/crash-symbolicator-config.test.ts` asserts
the exact `containers` entry in both files, deliberately, so that an accidental
commit fails the gate rather than silently shipping a deploy with no
symbolicator. A red `crash symbolicator deployment` suite while this workaround
is applied is that guard working; restore the configs rather than changing the
test.

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

What that costs: `env.AI` is unavailable, so Cloudflare-backed PDF OCR cannot
run. Memory embeddings use OpenRouter instead, but `env.MEMORY_INDEX`
(Vectorize) is reported as `not supported` by `wrangler dev` in every local run,
remote bindings or not, so end-to-end hybrid retrieval is still unavailable.
`env.FLAGS` (Flagship) is also
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

Set `RALLY_RENDERER_PORT` and choose a matching non-default debugging port when
another visual exploration is already running. For example,
`RALLY_RENDERER_PORT=54731 ... --remoteDebuggingPort=59422` keeps both listeners
isolated without changing the checked-in defaults.

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

- **Workers AI PDF OCR** (`env.AI`), **Vectorize** (`env.MEMORY_INDEX`), and **Flagship**
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
| Migrate both regions and their local platform bindings | `pnpm db:migrate` |
| Regenerate the D1 baseline | `pnpm db:baseline:create <through-migration.sql>` |
| Check the baseline against the hosted databases | `pnpm db:baseline:verify` |
| Seed both regions | `pnpm db:seed` |
| Start both Workers (sandbox) | `pnpm dev:api:local` (see the [container-flag note](#3-start-the-api-workers) if neither region binds a port) |
| Start both Workers (workstation) | `pnpm dev:api` |
| Global health | `curl -s http://127.0.0.1:8787/health` |
| EU health | `curl -s http://127.0.0.1:8788/health` |
| Desktop client, headless | see [§4](#4-run-the-desktop-client-headlessly) |
| Lint / typecheck / test | `pnpm lint`, `pnpm typecheck`, `pnpm test` |
| Lint, ignoring the cache | `pnpm lint:fresh` |

## Quality gate caches

`pnpm lint` and `pnpm typecheck` both cache, which is the difference between a
warm run of a few seconds and a cold one of about a minute. Both caches are
gitignored, and CI checks out fresh, so neither changes what CI proves.

| Gate | Cold | Warm | Cache |
| --- | --- | --- | --- |
| `pnpm lint` | ~60s | ~2s | `.eslintcache` |
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
- **A verdict that depends on another file is too**, and one rule reaches for
  exactly that. `rally/durable-object-sync-transaction` asks the type checker
  whether the callback handed to a synchronous boundary returns a Promise, which
  an imported callee's own signature decides. Demonstrated: a helper exporting
  `() => string`, passed as `transactionSync(() => prepare())`, lints clean;
  flipping *only* the helper to `async` leaves the calling file byte-identical,
  so a warm run reuses its cached pass while a cold run reports the violation.
  **Run `pnpm lint:fresh` after changing the return type of anything passed into
  `transactionSync`, `commitRuntimeMutation`, or `commitWithRegionalEffects`.**

  `consistent-type-imports` used to be named here as a second such case, on the
  belief that it asks the exporting file whether a symbol is a type. It does not:
  it reads only how the import is used in the importing file, and flipping an
  export from `const Thing` to `type Thing` leaves its verdict unchanged.

Both were accepted deliberately: the p90 run changes neither, and CI runs cold.
When a local green looks implausible, `pnpm lint:fresh` is the first thing to
try.

**Both caches are per *checkout*, not per session.** The `*.tsbuildinfo` file
beside each package's tsconfig and the root `.eslintcache` live at fixed paths
in the tree, so two
sessions running the gates at the same time in one clone write the same files
non-atomically. The usual outcome is a discarded cache and a slower full check;
the one that matters is a buildinfo that parses yet describes a graph state that
never existed, letting `tsc` skip files it should have re-checked — a green
typecheck that proves less than it says. CI runs cold, so the merge gate is
unaffected; locally, give the second session
[its own worktree](#working-in-a-second-checkout-or-worktree) rather than
sharing the clone.

## What `pnpm lint` costs in memory

**A cold `pnpm lint` peaks at about 4 GB of resident memory, and almost none of
that is work — it is TypeScript programs the run never releases and a heap
ceiling nothing bounds.** Two things decide the number:

- **Type-aware parsing is per tsconfig, and nothing frees it.**
  `parserOptions.projectService` opens each linted file in a TypeScript language
  service, which loads that file's whole tsconfig program and keeps it for the
  life of the process. So the cost is the *sum* over every package the run
  touches: linted alone, `apps/api` measured 2.7 GB, `apps/desktop` 1.9 GB, and
  `packages/*` 1.1 GB; a repo-wide `projectService` over the whole tree cost
  4.7 GB against 0.9 GB with no type information at all. `eslint.config.mjs`
  therefore scopes it to `apps/api/src`, and puts it in the same config object
  as the rule that needs it so the two cannot drift apart. **Every figure in
  this section is peak resident memory summed across the run's Node processes**
  — what the machine has to supply, which is what a runner runs out of.
- **V8's default heap limit is half of physical memory, so RSS tracks the
  machine rather than the workload.** The live set is far smaller than the peak:
  the same run completes under `--max-old-space-size=1536` at 1.6 GB, and only
  fails below about 1 GB. Everything above that is a garbage collector with no
  reason to run yet.

**`--concurrency` multiplies both.** ESLint's parallelism is worker threads, and
each thread builds its own programs *and* gets its own copy of the heap ceiling —
so on a four-core machine the repo-wide config peaked at 6.5 GB and bought 12
seconds. `pnpm lint` runs single-threaded for that reason, and CI is the case
that forced it: Node sets its default ceiling at roughly half of physical memory
(8.2 GB of a 16 GB sandbox, measured), so on a 7 GB runner two worker threads at
about 3.5 GB each are the whole machine before the first program is even built.
That arithmetic is why the fix is structural rather than a larger runner.

`pnpm lint` itself pins no heap ceiling, so a local run gets Node's default.
CI sets one: the `lint` and `typecheck-and-build-invariants` lanes in
`ci.yml` carry `NODE_OPTIONS: --max-old-space-size=8192`, as do the desktop
release workflow's Ubuntu verification steps. **A matrix key named `env` is only a
variable — Actions gives it no meaning of its own** — so `ci.yml` names it
explicitly on the run step, and a lane that sets nothing gets an empty
`NODE_OPTIONS`, which Node ignores. A ceiling that is never named there is a
ceiling that never applies, and the step's own `env:` group in the job log is
where to check.

Lowering that ceiling is the remaining lever if a runner still runs out, and it
cuts both ways: `--max-old-space-size=2048` brought the same run to 1.9 GB in
53s, faster than the 4.0 GB it takes unbounded, because a smaller heap is less
to mark and compact. Below about 1 GB the run dies; at 1024 MB it survives but
takes 98s, thrashing the collector.

**That number is not lint's alone.** The same 8192 is on
`typecheck-and-build-invariants`, which runs `pnpm typecheck`, two Wrangler
dry-run builds, and the desktop release invariants — four Node processes whose
memory nobody here has measured. It caps how large any of that may grow, so it
is the team's to move rather than a measurement's to set, and a lane that starts
failing on it wants its own measurement first.

## How many test workers to run

`pnpm test` starts every package's suite at once, and `apps/api` and
`apps/desktop` each claim `availableParallelism()` workers (four on the sandbox)
while the rest claim three — so one session peaks at roughly sixteen worker
threads on four cores, and `pnpm --filter @rally/api test` is itself a Node run
followed by a workerd run. The configs' comments record that this costs nothing
in total runtime, and that measurement stands: capping every run at two workers
came out at 233s against 234s uncapped.

**It was measured for one session on an otherwise idle machine, which is the
axis that matters least here.** What a timeout is measured against is the
maximum stall a single thread sees between schedules, and that grows with the
oversubscription: two sessions on this box is ~32 worker threads on four cores,
three is ~48. Every fixed budget in the suites — the 15s in
`packages/db`, `apps/api`, `apps/desktop`, `packages/agent-harness`,
`packages/connectors`, `apps/ace` and `apps/site`, and the 30s in
`apps/api/vitest.workers.config.ts` — is a floor sized for contention from
sibling suites, not a ceiling.

The lever is `VITEST_MAX_WORKERS`, which Vitest applies *after* the config
resolves and therefore overrides an explicit `maxWorkers`:

```bash
VITEST_MAX_WORKERS=2 pnpm test
```

Reach for it when a machine is hosting more than one session, or when a suite
starts timing out in a different test on every run. The committed defaults are
right for a solo run and are deliberately left alone.

## Working in a second checkout or worktree

`node_modules`, `.env.local`, `apps/api/.dev.vars.*`, and `.wrangler/state/` are
all ignored by Git and are not carried across. A new checkout needs the full
sequence from [§1](#1-install-and-prepare) — including its own migrate and seed,
because the D1 databases live under `.wrangler/state/`. Use distinct ports
(`--port`) if two checkouts must serve at once.
