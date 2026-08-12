# Development environment

How to get Avalon fully running — the API Workers, the local database, and the
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
`AVALON_DEV_AUTH=true` and generates stable per-region signing and encryption
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

## 3. Start the API Workers

**Inside a sandbox, use `dev:api:local`, not `dev:api`.**

```bash
pnpm dev:api:local       # both regions, remote bindings disabled
```

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
  pnpm --filter @avalon/desktop exec electron-vite dev --noSandbox --remoteDebuggingPort=9222
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

## Known issue: `pnpm smoke:local` cannot pass locally

`scripts/smoke-local.mjs:157` asserts that the seeded work stream carries at
least one connector connection:

```javascript
assert(detail.body?.connections?.length > 0, "The right-rail connection fixture is missing");
```

`packages/db/seed.sql` inserts into fourteen tables and `connector_connections`
is not one of them, so that assertion fails on any freshly seeded database. Every
check before it — development authentication, protected routes, work-stream
creation, the invitation lifecycle including revocation — passes. This is a
repository bug rather than an environment problem; either the seed needs a
connection fixture or the assertion needs to go.

## Quick reference

| Task | Command |
| --- | --- |
| Install dependencies | `pnpm install --frozen-lockfile` |
| Sync development Worker vars | `pnpm env:sync` |
| Migrate both regions | `pnpm db:migrate` |
| Seed both regions | `pnpm db:seed` |
| Start both Workers (sandbox) | `pnpm dev:api:local` |
| Start both Workers (workstation) | `pnpm dev:api` |
| Global health | `curl -s http://127.0.0.1:8787/health` |
| EU health | `curl -s http://127.0.0.1:8788/health` |
| Desktop client, headless | see [§4](#4-run-the-desktop-client-headlessly) |
| Lint / typecheck / test | `pnpm lint`, `pnpm typecheck`, `pnpm test` |

## Working in a second checkout or worktree

`node_modules`, `.env.local`, `apps/api/.dev.vars.*`, and `.wrangler/state/` are
all ignored by Git and are not carried across. A new checkout needs the full
sequence from [§1](#1-install-and-prepare) — including its own migrate and seed,
because the D1 databases live under `.wrangler/state/`. Use distinct ports
(`--port`) if two checkouts must serve at once.
