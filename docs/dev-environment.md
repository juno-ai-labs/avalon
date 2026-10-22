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
`Error: Electron uninstall`. `pnpm dev:desktop` (and so `pnpm dev`) now runs
`scripts/ensure-electron.mjs` first, which runs the package's own installer and
returns at once when the binary is already there, so a workstation repairs this
on the next start. To fetch it by hand — the step below is the same installer:

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
opens it. It also applies `TELEMETRY_DB`, `AUDIT_DB`, `USAGE_DB` and `MESSAGE_ISSUES_DB` schemas to Global
local state. `pnpm --filter @rally/api db:observability:migrate` applies just these two;
CI uses `db:observability:migrate:remote` before activating the API Worker.
Run them before starting a Worker: the migration and seed tooling
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

If the Worker logs a `workspace_do_schema_hash_mismatch:<n>` warning for a
Durable Object migration that has not shipped yet, local state holds a receipt
written before that migration's DDL was last edited: delete
`apps/api/.wrangler/state` and re-run `pnpm db:migrate` and `pnpm db:seed`.
The warning does not block local construction. Wiping remains the remedy only
while the migration is unreleased; a shipped schema change appends a migration.

### Resetting local state

Local state drifts in two halves nothing reconciles. Re-running `db:migrate` and
`db:seed` brings D1 up to date, but every Durable Object keeps what an older
checkout's code wrote into it. A stack left for weeks then serves Channels whose
parent conversation no longer exists: the API logs
`conversation_parent_missing` and `conversation_not_found`, the sidebar stays on
**Rally is opening this organization**, and a Channel shows **Channel could not
be opened**. The desktop client drifts with it: its stored session names an
account in the old database (`account_reconnect_required`) and its caches still
list the old Channels. Reset both at once:

```bash
pnpm dev:reset          # stop `pnpm dev` and quit Rally Development first
pnpm dev                # then, once the API answers:
pnpm db:open-authority
```

`dev:reset` refuses while a local Worker or the development client is running,
because both hold these files open. It deletes `apps/api/.wrangler/state` and
everything in the client's `Rally Development` userData directory except
`Partitions/` — the sign-ins to claude.ai, ChatGPT and other sites made inside
Rally's browser — and the window and application settings, then runs
`db:migrate` and `db:seed`.

After the Workers are running (§3), open the authority. `pnpm dev:api:local`
does this itself once its Workers are ready; `pnpm dev:api` and `pnpm dev` do
not:

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

It also places every Channel it seeds in the Organization's General Space,
through the same `placeConnectorChannelInGeneral` the Slack agent uses, because
every non-deleted Channel belongs to a Space and this route does not go through
the creation coordinator. That is why the command can take a few seconds longer
on a cold container than the import itself explains: each Channel's placement
waits for the Organization to see it, which happens when the Channel's parent
authority publishes its first directory projection.
[`spaces.md`](spaces.md) owns the mechanism.

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

**That flag is ignored once more than one `--config` is passed**, which is every
invocation the runner makes (wrangler 4.126.0), and Wrangler then reaches for
Docker and dies before any Worker binds:

```
✘ [ERROR] The Docker CLI is needed to build the configured image before running dev
```

`"dev": { "enable_containers": false }` in the config does not suppress it
either — only the absence of the `containers` block does. So in local mode the
runner writes **`apps/api/wrangler.<region>.scratch.jsonc`**, the region's main
config without that block, and starts Wrangler against it. It is rewritten on
every start, so it cannot go stale, and it is in `.gitignore`.

**Use that name, in that directory.** `scripts/migrate-d1.mjs` discovers a
region from every `wrangler.<name>.jsonc` carrying a migratable D1 binding, and
`<name>` admits a single segment — so a copy called
`wrangler.devlocal-global.jsonc` becomes a region named `devlocal-global`, and
`pnpm db:migrate` then fails for want of a `.dev.vars.devlocal-global` that
will never exist. Two segments is what already keeps
`wrangler.artifacts.global.jsonc` and its siblings out of the region list, and
it is what keeps this copy out; `scripts/migrate-d1.test.mjs` pins that. The
copy belongs beside the original because the config's `main`, `migrations_dir`
and `.dev.vars` paths are relative to `apps/api/`.

Once every Worker is ready, local mode also runs `pnpm db:open-authority`
(§2). Until that has run, the workspace socket answers 503
`workstream_maintenance` and the client sits on **Opening channels…** with an
empty sidebar. A failure there is printed and leaves the Workers running; run
the command by hand once the cause is fixed.

For an API-only session, the equivalent command is:

```bash
pnpm --filter @rally/api exec -- wrangler dev --local \
  --config wrangler.global.jsonc --env-file .dev.vars.global \
  --persist-to .wrangler/state/global --port 8787 --inspector-port 9230 \
  --enable-containers=false
```

The `--` matters: without it pnpm 11.13.0 takes `--env-file` as its own option,
swallows the path, and fails before Wrangler sees it.

That single-config session serves `GET /health` and little else a client needs:
`POST /auth/dev/session` answers **503** without the document, Terminal and
telemetry services bound alongside it, so the desktop client cannot sign in
against it. Use it to inspect the Worker, not to drive the app.

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
run. `env.FLAGS` (Flagship) is also
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
Add the same origin to `ALLOWED_ORIGINS` in `.env.local` and re-run
`pnpm env:sync`: every conversation socket checks it, so without it a signed-in
tab opens each conversation to **Channel could not be opened** and the Worker
logs `socket_origin_forbidden`.
The host uses the local Global service binding; the regional API must be running.

The development seed gives its people no verified email, so email sign-in
refuses them with `verified_identity_required`. Link one in the local database
before signing in as them:

```bash
pnpm --filter @rally/api exec -- wrangler d1 execute avalon-global --local \
  --persist-to .wrangler/state/global --config wrangler.global.jsonc --command \
  "INSERT OR IGNORE INTO user_verified_emails (email, user_id, verified_at)
     SELECT email, id, '2026-01-01T00:00:00.000Z' FROM users WHERE email = 'adam@avalon.local';
   INSERT OR IGNORE INTO user_login_identities (provider, subject, user_id, verified_at)
     SELECT 'email', email, id, '2026-01-01T00:00:00.000Z' FROM users WHERE email = 'adam@avalon.local';"
```

The `dev` script passes `--local-upstream localhost:8794`. Without it, `wrangler
dev` takes its upstream from the production Custom Domain route in
`apps/browser/wrangler.jsonc` (`app.rallywith.ai`) and rewrites each request's
URL and `Origin` to that host. The Worker forwards the request unchanged, so the
API's browser adapter compares `https://app.rallywith.ai` with
`BROWSER_APP_ORIGIN` and refuses every non-GET call, sign-in included, with 403
`browser_origin_required` ("Reload Rally before trying again"). The Worker's own
socket `Origin` check survives the rewrite, because URL and header move together;
only the comparison with a configured origin fails. Keep the flag's port equal to
`--port`.

A fresh local database also needs `pnpm db:open-authority` (§2) before a
selected workspace can load: until it runs, the seeded workspace's Durable
Object has no identity and `/sharing/navigation` returns 500
`workspace_object_identity_mismatch`. Email sign-in needs
`EMAIL_LOGIN_POLICY_JSON` as well as `BROWSER_APP_ORIGIN`; development sends no
email, so a local-only policy such as
`{"otpDigits":1,"ttlSeconds":600,"maxFailedAttempts":null}` lets a script try
each code.
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

Two more things have to move with that renderer port, and both fail in ways that
do not mention it:

- **Add the port to `ALLOWED_ORIGINS` in `.env.local`** and re-run
  `pnpm env:sync`. The example file lists 5173 and 5174 only, so a renderer on
  any other port is refused by CORS and the client paints **Rally cannot reach
  this region** — the Worker is running, is reachable by `curl`, and logs no
  failure, because the preflight is what it refuses.
- **Give the second client its own `XDG_CONFIG_HOME`.** The app takes a
  single-instance lock keyed on its Electron userData directory, which is
  `$XDG_CONFIG_HOME/Rally Development`. A second checkout launched with the
  default hands its window to the app that is already running and exits **0**,
  so `electron-vite` reports nothing and the only symptom is a debugging port
  that stops answering.

Both of those matter more than they look on a shared container, where another
agent's session may already hold 5173, 9222, 8787 and 9230. The API's port moves
the same way: `--port`, plus `VITE_API_GLOBAL_URL` in `.env.local` and
`PUBLIC_API_BASE_URL` in the synced `.dev.vars.<region>`.

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

A change to `packages/ui/src/styles/app.css` can reach the window stale: the
desktop's `styles/app.css` only `@import`s it, and Vite can re-serve the old
inlined copy after an edit. When a computed style disagrees with the file,
`touch apps/desktop/src/renderer/styles/app.css` to rebuild it.

**Every visible change must be looked at in a real window before it is called
done.** A passing component test asserts on the DOM, which says nothing about
whether an element is visible, positioned, legible, or covered by something else.
Capture the screens you touched and read the images.

Development sign-in works end to end in this setup: **Use local development
account** authenticates against the local Global Worker and opens the seeded
workspace with its work streams, automations, and onboarding checklist.

## What cannot be verified in a sandbox

- **Workers AI PDF OCR** (`env.AI`) and **Flagship**
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
- **So is a rule that reads a list from source.**
  `rally/durable-object-workspace-table-routing` takes its table names from
  `WORKSPACE_LOCAL_TABLES` and `AUTHORIZATION_STORAGE_TABLES` when it loads. The
  cache keys on each linted file and the config, so a Durable Object file that
  already passed is not re-checked when a table joins either list. Demonstrated:
  adding `users`, which objects already query on `this.env.DB`, left a warm
  `pnpm lint` clean, and `pnpm lint:fresh` reported 8 misrouted statements.
  **Run `pnpm lint:fresh` after changing either list.**

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

**The ceiling lives in the root scripts, not the workflows.** The root `lint`
and `typecheck` scripts in `package.json` put `--max-old-space-size=8192` at the
front of `NODE_OPTIONS`, and `pnpm -r` passes it on to every package's
`typecheck`, so every caller, local or any workflow, gets it. Do not add it to a
workflow's `env:`: a copy there is one the next workflow forgets.

Lowering that ceiling is the remaining lever if a runner still runs out. The
caller's own `NODE_OPTIONS` comes after the script's and the last flag wins, so
`NODE_OPTIONS=--max-old-space-size=2048 pnpm lint` pulls it. It cuts both ways: `--max-old-space-size=2048` brought the same run to 1.9 GB in
53s, faster than the 4.0 GB it takes unbounded, because a smaller heap is less
to mark and compact. Below about 1 GB the run dies; at 1024 MB it survives but
takes 98s, thrashing the collector.

**That number is not lint's alone.** The same 8192 is on `pnpm typecheck`,
whose largest program, `apps/api`, dies below about 1 GB of old space here. It
caps how large any of that may grow, so it is the team's to move rather than a
measurement's to set, and a gate that starts failing on it wants its own
measurement first.

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
`apps/api/vitest.workers.config.ts` and `apps/browser/vitest.config.ts` (the
same workerd pool) — is a floor sized for contention from sibling suites, not a
ceiling.

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
(`--port`) if two checkouts must serve at once. Give each concurrent Wrangler
stack its own `WRANGLER_REGISTRY_PATH` as well, for example
`WRANGLER_REGISTRY_PATH=/tmp/rally-my-worktree-registry pnpm dev:api:local`.
Wrangler's default registry is global and resolves named local services across
processes; separate listening ports alone do not isolate those bindings.
