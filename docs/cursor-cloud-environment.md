# Cursor Cloud environment

How a [Cursor Cloud Agent](https://cursor.com/docs/cloud-agent/setup) brings
Rally up on its own ephemeral VM. This is the Cursor counterpart to
[the Claude Code sandbox](sandbox.md): same repository, same commands, a
different agent platform whose base image and PATH differ enough to need their
own bootstrap. For the day-to-day commands each step wraps, read
[the development environment guide](dev-environment.md); this document owns only
what is specific to running inside a Cloud Agent.

Rally needs no database server — D1 is local SQLite under `.wrangler/state/` — so
there is exactly one environment to keep working here.

## Where the configuration lives

| File | Responsibility |
| --- | --- |
| [`.cursor/environment.json`](../.cursor/environment.json) | The environment definition: the run user, the exposed API ports, and the `install`/`terminals` lifecycle. Committed, so it follows branches and pull requests and is the highest-precedence environment source. |
| [`.cursor/install.sh`](../.cursor/install.sh) | The idempotent `install` step: the Node shim, dependency install, the Electron binary fetch, the generated Worker env, and the local D1 migrate and seed. |

A committed `.cursor/environment.json` overrides any personal or team
dashboard-managed environment for this repository, so there is no second place to
keep in sync.

## Lifecycle

Cursor prepares the base image, checks out the repository, then runs the phases
in order. Work is placed by the lifetime of the state it produces:

- **`install` → [`.cursor/install.sh`](../.cursor/install.sh).** Durable setup
  tied to the checkout: `pnpm install`, the Electron binary, `pnpm env:sync`,
  `pnpm db:migrate`, and `pnpm db:seed`. With environment builds this runs once
  to create the baseline snapshot and is not rerun on later boots, so it holds
  only work whose product is a file on disk. It is idempotent — a warm re-run
  finishes in seconds and rewrites nothing it does not have to.

There is no `start` phase: nothing here needs per-boot reconciliation that the
migrate/seed in `install` and the health-gated seed terminal do not already
cover.

## The Node shim

The one thing this environment does that a workstation does not: it repoints
`node`.

The Cloud Agent exec-daemon puts its own **Node 22.14** first on `PATH`. That
minor predates two APIs the test suites depend on:

- `tls.getCACertificates` (Node ≥ 22.15), used by the desktop realtime socket
  broker — without it `@rally/desktop` fails with
  `getCACertificates is not a function`;
- `node:sqlite`'s built-in **FTS5** module, used by the `@rally/db` and
  `@rally/api` migration tests — without it they fail with
  `no such module: fts5`.

The image already ships the repo's documented **22.22.2** parity through nvm, but
it sits behind the exec-daemon on `PATH`. `install` therefore symlinks `node` and
`npx` from the newest installed nvm `v22.x` into `/usr/local/cargo/bin`, a
writable directory that sits ahead of the exec-daemon, so `install`, the
terminals, and the agent's own shell all resolve the Node the project is built
and gated against. The exec-daemon invokes its own Node by absolute path for its
native addons, so the shim does not disturb it.

If a future image orders `PATH` so nvm already wins, the shim becomes a no-op and
can be removed; until then it is what makes `pnpm test` green in a Cloud Agent.

## Running the desktop client

The Electron client is not a terminal — it is launched on demand for UI work,
under Xvfb, exactly as [the development environment guide](dev-environment.md#4-run-the-desktop-client-headlessly)
describes. The base image carries Xvfb and the Electron system libraries. It does
**not** carry Playwright (the sandbox image's `/opt/node22/...` path does not
exist here); install `playwright-core` into a scratch directory and attach to the
running app over the DevTools protocol on `--remoteDebuggingPort` when you need to
drive or screenshot it.

## What cannot be verified here

Everything [the sandbox's list](dev-environment.md#what-cannot-be-verified-in-a-sandbox)
names, for the same reasons — Workers AI and Flagship bindings, real
OAuth callbacks, a real streaming turn, the macOS-only surfaces, and anything
needing Cloudflare credentials. A Cloud Agent adds no capability there; provider
keys, if a session needs them, are added as environment secrets and reach the
Workers through `.env.local`.

## Quality gates

The CI gates run unchanged in a Cloud Agent: `pnpm lint`, `pnpm typecheck`, and
`pnpm test` (and `pnpm test:scripts`, the Wrangler dry runs, and the desktop
release invariants) all pass once the Node shim is in place. See
[the quality-gate section of AGENTS.md](../AGENTS.md#quality-gates).
