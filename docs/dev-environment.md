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

**That installer can fail behind the sandbox proxy, and retrying does not help.**
Its downloader is undici, and the 125 MB transfer dies partway through on an
internal assertion rather than a network error:

```
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
  assert(!this.paused)
    at Parser.finish (.../undici/lib/dispatcher/client-h1.js:368:5)
```

`recentRelayFailures` in the proxy status stays empty, because nothing on the
proxy side refused anything — this is the client mishandling the paused receive
the proxy uses for large downloads. `curl` handles the same download fine, so
fetch the release archive yourself and place it where `electron/index.js` looks:
`path.txt` names the executable inside `dist/`, and both together are the whole
of what the installer would have produced.

```bash
d=$(ls -d node_modules/.pnpm/electron@*/node_modules/electron)
version=$(node -p "require('./$d/package.json').version")
curl -fSL --retry 3 -o /tmp/electron.zip \
  "https://github.com/electron/electron/releases/download/v$version/electron-v$version-linux-x64.zip"
mkdir -p "$d/dist" && unzip -q -o /tmp/electron.zip -d "$d/dist"
printf 'electron' > "$d/path.txt" && chmod +x "$d/dist/electron"
rm /tmp/electron.zip
"$d/dist/electron" --version   # prints the FATAL root/sandbox notice, which is expected here
```

That last line is the check: as root with no `--no-sandbox` the binary aborts
with `Running as root without --no-sandbox is not supported`, which means it ran.
`electron-vite dev --noSandbox` passes the flag for real runs.

```bash
cp .env.example .env.local   # optional for the API, required for the desktop client
pnpm env:sync
```

`scripts/sync-dev-env.mjs` defaults `APP_ENV=development` and
`RALLY_DEV_AUTH=true` and generates stable signing and encryption material for
each configured deployment. Copy the example when running the desktop client;
its Global endpoint is `VITE_API_GLOBAL_URL`. JSON-valued Worker settings are
serialized as single-quoted dotenv values: JSON-style escaped double quotes are
preserved literally by Wrangler and make settings such as `EMAIL_LOGIN_POLICY_JSON`
unparseable. Restart the local Worker after changing its environment file.
The local development sign-in
stores the seeded workspace credential and a separate Global identity credential
so workspace discovery, activation, and creation use the ordinary account flow.

## 2. Create and seed the local database

```bash
pnpm db:migrate
pnpm db:seed
```

Both commands cover configured deployments. `db:migrate` also applies the content-free
platform D1 migration chain into the configured local-state directories, so the
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

This advances the configured local authorities to `durable_object_open` and
imports `packages/db/seed-product.json` through each Worker's development seed
route. The Workers must be running for the product import. The command is
idempotent and repairs partial imports; rerun it after starting a missing Worker.
For a custom local port, set `PUBLIC_API_BASE_URL_GLOBAL` and run the command
through `pnpm exec dotenv -e .env.local -- pnpm db:open-authority`.

The bootstrap's workspace-route upsert deliberately keeps a no-op `WHERE`
between its `SELECT ... FROM workspaces` and `ON CONFLICT`. SQLite otherwise
parses the `ON` as a possible join clause and rejects the fresh post-retirement
seed before product fixtures reach the Durable Objects.

`routes/dev.ts` seeds transcript rows through the canonical ordered-turn
storage API. It does not recreate the retired message tables or their runtime
views merely to import development fixtures.

## 3. Start the API Workers

**Inside a sandbox, use `dev:api:local`, not `dev:api`.**

```bash
pnpm dev:api:local       # configured deployments, remote bindings disabled
```

`scripts/dev-regional-api.mjs` reads configured deployments and local ports from
`config/regions.json`. It starts each Wrangler session after the preceding one
is ready to avoid concurrent builds of the shared Container image. Each session
loads the API, document-processing, and Terminal configs; Global also loads its
private telemetry-delivery service. The runner forwards termination signals to
its children.

Local mode passes `--enable-containers=false`; building the crash symbolicator
otherwise needs Docker. Use `pnpm dev:api` when testing that container itself.
For an API-only session, the equivalent command is:

```bash
pnpm --filter @rally/api exec -- wrangler dev --local \
  --config wrangler.global.jsonc --env-file .dev.vars.global \
  --persist-to .wrangler/state/global --port 8787 --inspector-port 9230 \
  --enable-containers=false
```

The `--` matters: without it pnpm 11.13.0 takes `--env-file` as its own option,
swallows the path, and fails before Wrangler sees it.

`wrangler.global.jsonc` declares an `ai` binding, and Workers AI has no local
implementation — wrangler reports it as `Mode: remote` and opens a remote proxy
session to Cloudflare to serve it. Without Cloudflare credentials, or behind a
sandbox egress policy, that session fails:

```
✘ [ERROR] Failed to start the remote proxy session.
          Error reloading remote server: Proxy response (403) !== 200 when HTTP Tunneling
```

The affected Worker exits when that proxy cannot be established.
`wrangler dev --local` disables remote bindings and avoids the proxy session.

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

Verify configured deployments:

Expect `"ok": true` with D1, R2, Durable Objects, Queues, and Workflows
available. The provider checks report `not configured` until you supply keys;
that is expected and does not block local work.

## Lite browser development

`pnpm dev:browser` builds the client, then watches source changes while Wrangler
serves port 8794. Set the API's `BROWSER_APP_ORIGIN` to the exact local browser
origin (for example `http://localhost:8794`) and use that same hostname in Chrome.
The host uses the local Global service binding; the regional API must be running.
JSON settings from older generated double-quoted `.dev.vars` files are decoded
before `env:sync` rewrites them into single-quoted dotenv values.

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
- **Dictation past the button press.** The capture half works — Electron takes
  `use-fake-device-for-media-stream` and `use-fake-ui-for-media-stream`, and
  `getUserMedia` then hands back a `Fake Default Audio Input` with no prompt —
  but `GET /realtime/transcription/socket` answers 503 *Dictation is not
  configured for this Rally region* without provider credentials, and the attempt
  ends in `error` rather than reaching `listening`. So `requesting` is as far as
  a real run gets: no live transcript, no finalization, no stop-and-send. The
  composer's dictation states are covered by
  `components/workstream-composer-dictation.test.tsx`, which drives the hook
  through a double; those states are asserted there rather than in a window,
  for the reason the entry below gives.
- **A real streaming turn, and anything a run has to produce.** `.env.local`
  ships `OPENROUTER_API_KEY` empty, so a run reaches the provider and fails —
  `harness_execution_failed`, with `Cannot read properties of undefined
  (reading 'trim')` in the Worker log where the key is read. Nothing a model
  decides can be staged here: no streaming tokens, and no elicitation, which
  means no answered question and no pending answer either.
- **Playing frames into the live screen from the CDP side.** This does not work
  and the recipe that said to wrap `window.WebSocket` in the renderer was
  wrong: the renderer opens no sockets. The Node main process owns them and
  hands frames to the renderer over `window.rally.onRealtimeSocketEvent`
  ([`websocket-architecture.md`](websocket-architecture.md)), and that bridge is
  `contextBridge`-exposed — `window.rally` is non-writable, non-configurable and
  frozen, per [the security model](security.md), so an evaluated script can
  neither replace a method nor reach the listener the app registered. Wrapping
  `window.WebSocket` on new document and reloading leaves the capture array
  empty, which is the check to repeat before believing otherwise. Anything that
  needs synthetic frames has to be played in from the main process; a state a
  component can simply be *given* belongs in a component test instead.
- **The native iOS client.** The sandbox image has no Xcode or iOS SDK.
  `apps/ios` is archived on a Mac (`docs/ios-client.md`, `apps/ios/README.md`).
  `pnpm test:scripts` still checks the packaging invariants on Linux.
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
| Migrate configured deployments and their local platform bindings | `pnpm db:migrate` |
| Regenerate the D1 baseline | `pnpm db:baseline:create <through-migration.sql>` |
| Check the baseline against the hosted databases | `pnpm db:baseline:verify` |
| Seed configured deployments | `pnpm db:seed` |
| Start the configured Workers (sandbox) | `pnpm dev:api:local` (see the [container-flag note](#3-start-the-api-workers) if neither region binds a port) |
| Start the configured Workers (workstation) | `pnpm dev:api` |
| Global health | `curl -s http://127.0.0.1:8787/health` |
| Desktop client, headless | see [§4](#4-run-the-desktop-client-headlessly) |
| iOS client (Mac + Xcode 26) | `open apps/ios/Rally.xcodeproj` — see [`ios-client.md`](ios-client.md) |
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

ESLint excludes nested `.claude/worktrees/` checkouts: each owns its own config
and should run its own gates. Walking one from its parent can also make
TypeScript ESLint infer two conflicting configuration roots.

`node_modules`, `.env.local`, `apps/api/.dev.vars.*`, and `.wrangler/state/` are
all ignored by Git and are not carried across. A new checkout needs the full
sequence from [§1](#1-install-and-prepare) — including its own migrate and seed,
because the D1 databases live under `.wrangler/state/`. Use distinct ports
(`--port`) if two checkouts must serve at once.
