# Writing a test

Which suite a new test belongs in, which runtime it runs on, and the check that
has to pass before it is worth keeping. Read it before adding tests to a change.

Two rules run through everything below, and one boundary sits beside them.
**Default to the real Cloudflare pipeline**: real workerd and a real Durable
Object for anything the runtime decides, and the checked-in migrations against
real SQLite for anything a query decides — a double stands in for something that *cannot* be run here, never for
setup that was inconvenient. And **prove the test can fail**, at the integration
rungs: an integration test that stays green while the behavior under it is broken
is not covering that behavior, and the suite is worse off for it because the name
says otherwise. The boundary: [do not test CI or deployment
configuration](#do-not-test-ci-or-deployment-configuration). Beneath both sits a
rule for every test at every rung, in
[What to test and what not to](#what-to-test-and-what-not-to): a test runs the
subject and asserts on what it produced, never on the text of a source file.

[`e2e.md`](e2e.md) owns the manual acceptance flows and the live-Worker smoke
check; [`type-safety-boundaries.md`](type-safety-boundaries.md) owns how a test
double is *typed*, this document owns whether it should exist at all; and
[the flaky-test rule](../AGENTS.md#flaky-tests) owns what to do when a test fails
once and passes on a rerun.

## The suites

| Suite | Command | Runs on |
| --- | --- | --- |
| `apps/api/test-workers/**/*.test.ts` | `pnpm --filter @rally/api test:workers` | **Real workerd**, through `@cloudflare/vitest-pool-workers`. Durable Objects, their SQLite storage, alarms, hibernation, eviction, `WebSocketPair`, D1, and queue producers are the real implementations. |
| `apps/api/test/**/*.test.ts` | `pnpm --filter @rally/api exec vitest run` | Node. Services and route handlers with bindings supplied by the typed builders, and real SQL through `node:sqlite`. `cloudflare:workers` is aliased to `test/helpers/cloudflare-workers.ts`, which stands in for the `DurableObject` base class and the `tracing` custom-span API — the stand-in keeps their contracts but nests no spans and exports nothing, so anything depending on either belongs a rung up. |
| `apps/desktop/src/{renderer,main,common}/**/*.test.{ts,tsx}` | `pnpm --filter @rally/desktop test` | Two projects. `renderer` runs on jsdom; `main` and `common` run on node, because a main-process module that reaches for `document` should fail rather than find a window Electron's main process does not have. A main or common test that genuinely needs a DOM opts back in with a `// @vitest-environment jsdom` docblock. Asserts on the DOM, which is not the same as looking at the screen — see [verifying visible changes](../AGENTS.md#verifying-visible-changes). Console output is buffered and printed only for failing tests (`silent: 'passed-only'`), because the renderer's [performance traces](performance-tracing.md) print on every create, open, and send; a test that asserts on a log line spies on `console` itself and is unaffected. |
| `packages/*/src/**/*.test.ts` | `pnpm --filter @rally/<pkg> test` | Node. Pure contract, harness, and connector logic. |
| `packages/db/test/**/*.test.ts` | `pnpm --filter @rally/db test` | Node. The [local baseline](d1-baseline-migrations.md), the development seed, and the work-stream queries over a migrated database. There is no per-migration suite: every migration is at or below the baseline boundary and immutable, and the manifest digest fails if one is edited or inserted. A *new* migration is tested through the baseline equivalence check and by whatever service test covers the behaviour it enables. |
| `apps/site/test/**/*.test.ts`, `apps/release-retention/test/**/*.test.ts` | `pnpm --filter @rally/site test`, `pnpm --filter @rally/release-retention test` | Node. The public site Worker and the release-retention Worker, each with its own R2 builder. |
| `scripts/*.test.mjs` | `pnpm test:scripts` | `node --test`. The repository's own tooling and the ESLint boundary rules. |
| `apps/ios/RallyTests`, `apps/ios/RallyUITests` | Xcode → Product → Test on the Rally scheme | XCTest on the iOS 26 SDK. PKCE, deep links, transcript mapping, and sign-in chrome. **Not** covered by `pnpm test`; the sandbox has no iOS SDK. |
| `apps/desktop/scripts/*.test.mjs` | `pnpm --filter @rally/desktop test:release` | `node --test`. The release planner and release scripts — **not** covered by `pnpm test:scripts`, whose name suggests otherwise. |
| `apps/api/scripts/test-crash-symbolicator-container.mjs` | `pnpm --filter @rally/api test:crash-symbolicator-container` | Docker. Builds and exercises the symbolicator image. |
| `scripts/smoke-local.mjs` | `pnpm smoke:local` against a running `pnpm dev:api:local` | Configured regional Workers under `wrangler dev`, with the local D1 database. |
| `scripts/e2e-local.mjs` | `pnpm e2e:local` against a running `pnpm dev:api:local`, after `pnpm db:open-authority` | The full member pipeline over the live local stack — happy, sad, and chaos lanes, with real model calls when `OPENROUTER_API_KEY` is configured. See [`e2e.md`](e2e.md#automated-behavioral-lane). |

`pnpm test` runs every package's `test` script recursively, and `@rally/api`'s
runs the Node suite *and then* the workerd suite — so a green `pnpm test`
includes workerd. CI splits them across `api-tests-workers-1-of-n` through
`api-tests-workers-8-of-n`; each runs the package-owned workers command with a
Vitest shard, and the container and release suites are their own matrix jobs.
`deploy-api.yml` must use those same eight workers shards rather than appending
unsharded `test:workers` onto a Node lane: that dumps the whole suite into one
Miniflare, which is more `reset()` interleave than PR CI ever sees, and it is
how a green pull request has already failed deploy verify on the same SHA.

A test in any of these that fails once and passes on a rerun is a defect to fix
in the change that met it —
[the flaky-test rule](../AGENTS.md#flaky-tests) is binding for every suite in the
table, and it is where the reproduction levers live: the bulk loop, plus
`--sequence.shuffle` for a test that depends on another in its own file having
run first and `--no-file-parallelism` for interference between files. A `retry`
in a Vitest config is never the answer, here or anywhere below.

## Where a new test goes

Pick the highest rung the behavior can actually be exercised on. Dropping a rung
is allowed; doing it silently is not — say in a comment what could not be run.

### 1. Real workerd — `apps/api/test-workers/`

The default for anything whose truth depends on the runtime rather than on the
shape of your own code:

- Durable Object storage: `state.storage.sql`, foreign keys (workerd enforces
  them and refuses to let a `PRAGMA` turn them off), `blockConcurrencyWhile`,
  constructor migrations, transactions.
- Alarms, hibernation, eviction, and what survives each — `runDurableObjectAlarm`
  and `evictDurableObject` are the only honest way to test them.
- WebSocket upgrades. Node's `Response` refuses status 101, so the Node suite
  substitutes a fake one that validates nothing; a rebuild that workerd rejects at
  runtime constructs happily there. That has already cost one bug, and the
  detail is in [`realtime-sockets.md`](realtime-sockets.md#testing).
- Anything reached through a real binding: D1 semantics, queue sends, RPC
  envelopes between objects. `test-workers/terminal-authority.test.ts` is the
  worked example: it drives Terminal's whole object authority through
  `/internal/terminal`, so the operation lease is decided against real `runs`
  rows, the two sequences that used to span statements are proved atomic, and
  the constraints promoted out of `lifecycle_json` are enforced by workerd
  rather than asserted about.
- Platform APIs the code imports but the Node suite can only stub.
  `tracing.enterSpan` from `cloudflare:workers` is the standing example: the
  tracing tests in `test/` run against a hand-written stub, which is right for
  asserting span names and attributes cheaply, but it means nothing there ever
  resolves the real import.
  `test-workers/tracing-runtime.test.ts` is the smoke test that does — the API
  is reachable, it runs the callback, it awaits the promise, it propagates a
  throw — and it is deliberately shallow, because the runtime exposes no way to
  read a finished span back and anything deeper would be asserting on the stub
  again. A beta platform API that only a double has ever exercised is not
  covered.

The Node suite cannot stand in for any of it. `apps/api/vitest.config.ts` aliases
`cloudflare:workers` to `test/helpers/cloudflare-workers.ts`, a ten-line stand-in
whose `DurableObject` base class stores `ctx` and `env` and does nothing else —
so a Durable Object under Node is an ordinary class, and everything the platform
contributes is absent by construction.

#### Declaring a table the region does not have

This suite's D1 starts empty and each test declares what it needs, which makes it
easy to declare something a real region does not have. Every table in
`WORKSPACE_LOCAL_TABLES` — `connector_connections`, `slack_user_links`,
`resources`, the memory and digest families, and the rest — lives in WorkspaceDO,
and migration 0090 dropped them from regional D1. A fixture that creates one in
D1 hands the code under test an authority production retired, and a statement
sent to the wrong one then passes here and 500s in production. It has: a
delivery destination could not be saved on any automation for as long as that
statement went to `env.DB`, and eleven fixtures in
`test-workers/durable-object-runtime.test.ts` still declare `connector_connections`
in D1 today, where they prove nothing about the routed reads they sit beside.

Seed those tables in the object that owns them — `initializeWorkspace`, then
`runInDurableObject(workspaceStub(), …)`. Where the absence is the point,
`test-workers/automation-acceptance-bindings.test.ts` asserts it in its first test
rather than trusting a comment to survive. On the production side,
`rally/durable-object-workspace-table-routing` refuses a `WORKSPACE_LOCAL_TABLES`
name on `env.DB` in any object.

### 2. Node against real SQL

When the behavior is a query or a schema rather than a runtime feature, run it
against the checked-in migrations rather than against a stub:

- `test/helpers/sqlite-d1.ts` — `migratedSqliteDatabase()` applies every
  `packages/db/migrations/*.sql` to a fresh in-memory `node:sqlite` database, and
  `sqliteD1()` presents it through the `D1Database` surface the services use.
  Sixty-odd API test files already work this way. Its `run` answers a
  statement's rows as D1's does, so a read placed inside a batch is read off
  the batch's results in a test exactly as in production.
- `test/helpers/sql-storage.ts` — `createTestSqlStorage()` presents a
  `node:sqlite` database through the object-local `SqlStorage` surface, and turns
  foreign keys on because `node:sqlite` defaults them off while workerd enforces
  them. Without that, an object-side foreign key is unenforced in tests and
  enforced in production. **It applies no schema of its own** — unlike
  `migratedSqliteDatabase()`, it adapts whatever database it is handed, so the
  test has to run the object's real schema into it (the exported
  `*_SCHEMA_MIGRATIONS` arrays) rather than hand-build the tables it expects.
  A test that skips that step is asserting against its own fixture schema, which
  is the drift this rung exists to catch.

A wrong column name, a broken join, or a constraint the migration actually
declares fails here. Assert by reading rows back, not by trusting the write.

### 3. Node with a capability double

For the one collaborator that genuinely cannot run: a binding with no local
implementation (`AI`, `FLAGS` — see
[what cannot be verified in a sandbox](dev-environment.md#what-cannot-be-verified-in-a-sandbox)),
a provider's HTTP API, a clock, a source of randomness. Double that collaborator
and nothing else, and type it per
[`type-safety-boundaries.md`](type-safety-boundaries.md): the smallest capability
the subject consumes, `satisfies` or `implements`, `createTestEnv` and friends
for platform bindings.

**A clock is one of those collaborators, and no real wall-clock timer decides a
test's outcome.** A deadline a helper mints — `AbortSignal.timeout(…)`,
`maxWallClockMs`, `toolTimeoutMs`, `idleTimeoutMilliseconds` — is set far above
any legitimate run; a small one appears only in a test whose subject *is* the
deadline, and says so at that call site. These hide behind helper names that read
as inert setup, which is why a fixture that mints a deadline is worth reading
rather than reusing: the connectors suite alone reaches `AbortSignal.timeout`
about 150 times through such helpers.

Double it or leave it alone, but never half-way. A pinned fake clock reading a
fixture epoch that was itself taken from the real one is worse than no double at
all: it looks deterministic and is not, so its failures arrive as flakes in
whichever test the drift happened to reach.

**Where the interleaving is the point, stage it causally** — hold the
collaborator on a promise the test resolves, assert the intermediate state, then
release — rather than sizing a sleep to win the race. `test/slack-account-link.test.ts`
parks both `views.open` calls on one barrier until each has arrived, so both
modals provably exist before either click retires anything; a sleep would have
asserted the same thing only on a machine that was fast enough.

Loop-storage tests that admit another input while settling a step must read a
fresh loop fence before the next assistant reservation, just as `SubstreamAgent`
does. The settlement result is a snapshot, not a live revision: a late admission
can commit after it. `workstream-transcript-storage.test.ts` exercises both a
concurrent arrival and an arrival explicitly sequenced after settlement so the
stale-snapshot failure does not depend on which payload hash finishes first.

### 4. `vi.mock` on a module

The last resort, and rare on purpose — seventeen of the API suite's 183 files
(`grep -rl 'vi\.mock(' apps/api/test`; counting `vi.mocked` as well returns 25,
but that helper only types a value that is already mocked). Mocking a module
replaces code the change is supposed to protect, and the mock keeps passing after
the real module's contract moves. If the subject's dependencies are all mocked,
the test covers the wiring of the mocks.

## Do not test CI or deployment configuration

**Never write a test whose subject is CI or deployment.** That covers a test
that reads a `.github/workflows` file, a Wrangler or deploy config, or the order
of deploy steps, and a test of a script whose only job is to provision, select a
deploy mode, or check health around a deploy. Such a test restates the
configuration in a second place, so it fails exactly when somebody changes the
configuration on purpose: disabling the Azure reviewer workflow on 2026-09-26
turned `main` red for no reason but its test. It also proves nothing the run
itself does not: a workflow that is wrong fails when it runs, and a deploy that
is wrong fails the deploy. That is the monitoring this team relies on
([`AGENTS.md`](../AGENTS.md#where-we-are)).

What stays tested is code that decides something about data or a shipped
artifact, however it is invoked: the D1 migration tooling (`migrate-d1`,
`d1-baseline`, `classify-pending-d1-migrations`) and the desktop release
scripts that plan, sign, notarize and publish a build. Test that logic as code,
through its own functions, never by asserting where a workflow calls it.

## Timeouts and waiting

**Every new or edited `vi.waitFor(…)` and `expect.poll(…)` passes an explicit
`timeout`.** The number is the author's to choose, but it has to be chosen: both
default to one second with a 50ms interval, which is sized for nothing in
particular. Most existing `vi.waitFor` sites still ride that default — the rule
is binding for the code you touch, and the backlog converts as files are
edited, not in one sweep.
`packages/agent-harness`, `packages/connectors`, `apps/ace` and `apps/site` raise
the `expect.poll` default in their configs; `apps/api`, `apps/desktop` and
`packages/db` do not. No config raises `vi.waitFor` anywhere, because Vitest
exposes `expect.poll.{timeout,interval}` and no knob at all for `vi.waitFor` —
the call site is the only place its budget can live. The desktop renderer's
`configure({ asyncUtilTimeout: 5_000 })` reaches @testing-library's `waitFor`
only, and only in the `renderer` project.

**The poll's budget sits comfortably below the enclosing test's.** That ordering
is the whole reason to write a poll: it fails with `expected 1 to be +0` and a
line number, where a harness timeout names no assertion at all. A poll budgeted
at the test budget is a poll whose message nobody will ever read.

One thing not to over-correct for: a poll does not falsely expire because the box
is loaded. Node fires the 50ms interval timer ahead of the one-second timeout
timer when both come due together, so a stall alone cannot expire a poll — only
real work outlasting the budget does.

**A per-test or per-hook timeout argument may only widen the project default,
never narrow it, and it carries a comment naming the wait it is budgeting for.**
Every example in this document widens, which is exactly why a narrowing reads as
deliberate when it is almost always a number that was typed before the config had
one. The project defaults are floors sized for contention from the sibling suites
`pnpm test` starts at the same time — see
[how many test workers to run](dev-environment.md#how-many-test-workers-to-run) —
not ceilings anyone measured a single test against.

**Never install fake timers mid-test, after a setup path has already armed real
ones.** Vitest's switch does not migrate timers that are already pending, so
anything the setup armed keeps running on the real clock while the test advances
a fake one. Where a late switch has to stay, the test names in a comment the
armed timer it depends on having already been cleared — otherwise the next change
to that path silently removes the reason it works.

Two @testing-library interactions follow from the same area, and neither is
visible in the failure it causes. Under Vitest there is no global `jest`, so
`jestFakeTimersAreEnabled()` is hard-wired false: @testing-library's `waitFor`
under a plain `vi.useFakeTimers()` cannot poll at all, and hangs to the full test
timeout unless its condition is already true on the first synchronous check. And
`shouldAdvanceTime: true` advances the fake clock by a fixed 20ms per firing of a
real 20ms interval, so on a contended box a faked timeout quietly becomes more
patient in real seconds while the harness timeout around it does not.

## Writing a workerd test

```ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers"; // add `exports` for a route-level test
import { reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await reset();
});
```

- **`env` and the Worker come from `cloudflare:workers`.** `cloudflare:test`
  still exports `env` and `SELF`, and both are deprecated as of
  `@cloudflare/vitest-pool-workers` 0.21: import `env` and `exports` from
  `cloudflare:workers` instead, and reach the Worker through
  `exports.default.fetch()`. Everything else —
  `reset`, `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject`,
  `listDurableObjectIds`, `createExecutionContext` — stays on `cloudflare:test`.
- **`await reset()` between tests.** Storage isolation is per *file*, not per
  test: Cloudflare gives each test file its own storage environment, and within
  one file the second test inherits whatever the first wrote. Cloudflare's
  example puts `reset()` in `afterEach`; `beforeEach` is what
  `durable-object-runtime.test.ts` does, and it is the one to copy — it holds
  even for a test that inherited state because a previous test's own cleanup
  never ran.
- **Know what `reset()` reaches: everything.** It deletes all data from every
  attached binding. For D1 that includes the *schema* — the complete migrated
  schema before the call and no tables after — and it reaches Durable Object storage too: a
  table written through `runInDurableObject` is gone when the same object id is
  opened after a reset. A file that isolates its tests some other way is not
  evidence against that: `agent-run-lifecycle.test.ts` and
  `agent-run-dispatch-reliability.test.ts` take a fresh object id per test
  because they never call `reset()`, not because storage would survive one.
  `abortAllDurableObjects()` is the one that keeps persisted data, but it aborts
  instances rather than retiring them: a test *about* eviction still wants
  `evictDurableObject`, which drains in flight work and hibernates sockets.
- **A native RPC method that throws can leave an unhandled rejection, and that
  fails the run while every test in it passes.** Calling one on a *stub*
  (`stub.someMethod(…)`, not `exports.default.fetch` or a `worker.queue` call)
  can leave two rejected promises — the one the caller awaits and one the RPC
  layer holds for the remote call — and `await expect(…).rejects` handles only
  the first. Vitest reports the other as `Unhandled Rejection` and exits
  non-zero under a summary reading `222 passed`. The tell is the serialized
  error: `{ durableObjectId: …, remote: true }`. Assert the throwing path inside
  `runInDurableObject` instead, where it stays in one isolate, and cover the RPC
  hop with a call that resolves. Not every `.rejects` on a stub does this —
  `forced-migration.test.ts` and `queue-dispatch.test.ts` have several that do
  not — so treat the unhandled-rejection report as the signal rather than
  rewriting assertions pre-emptively.
- **Read the exit code, not the summary.** The line above is the reason: `Tests
  222 passed (222)` is printed by a run that exited 1. `grep`ping a vitest run
  for `Tests ` proves the specs passed and nothing else — capture `$?`, or run
  `pnpm --filter @rally/api test` and let its failure surface.
- **`reset()` is not confined to the file that calls it.** Storage is isolated
  per file, but the reset itself takes every object's input gate, so a file that
  never calls one can still be made to wait for a sibling's. That surfaces as a
  `beforeAll`/`beforeEach` timing out on its *first* test and passing when the
  file is run alone — which reads as flakiness and is not. Two things fix it,
  and `workspace-directory-reads.test.ts` does both: the `beforeEach` rule
  below, and a hook budget well above the work the hook does. The suite-wide
  budget in `vitest.workers.config.ts` is now that budget, 30 seconds for every
  test and hook in the directory, so a hook writes its own only to ask for
  *more* — with a comment saying the wait is the interleave and not the query.
  The same interleave can also leave an object authoritative across tests in one
  file. `initialize` on an already-authoritative root is the documented replay
  path — 200, directory snapshot re-enqueued, notifications not re-emitted —
  so a later create that reuses a workstream id / `clientMessageId` looks like
  a silent product miss (`[]` where the named people should have been told).
  Tests that are not *about* that replay must not share an `initialize` identity
  with a neighbour that already opened that object. More importantly, a test
  that asserts pre-inference state must not start a model loop merely to create
  its fixture: `participant-notification.test.ts` provisions existing rooms and
  calls the create mutation without the endpoint's activation step. Minting a
  fresh id for every case does not fix unnecessary draining work; under a
  sharded workers run it only leaves more live objects for promotion polls to
  contend with.
- **Set up in `beforeEach`. No `beforeAll` in this directory.** A `beforeAll`
  that opens an object while a sibling file is resetting waits until it times
  out, and a wipe landing mid-file is then inherited by every test after it
  rather than repaired. Paying for setup per test costs milliseconds, because
  every seed here is already idempotent — `CREATE TABLE IF NOT EXISTS`,
  `INSERT OR REPLACE`, `ON CONFLICT DO UPDATE`.
  `workspace-directory-reads.test.ts`'s `establishWorkspace` is the worked
  example. The directory holds no `beforeAll` today; the rule is what keeps the
  next one from being reintroduced as an optimization.
- **Object names are not isolated per file — storage is.** Two files naming the
  same object are two files queueing on one input gate, and the symptom is again
  a hook timing out in whichever lost the race rather than a failure anyone can
  read. `scripts/check-durable-object-test-names.mjs` fails
  `pnpm test:scripts` when two files spell out the same workspace id, so give a
  new file its own rather than copying a neighbour's.
- **Bindings come from `apps/api/wrangler.test.jsonc`**, not from the production
  configs. A new Durable Object class needs both a binding and its name in the
  `new_sqlite_classes` migration tag, or the object has no SQLite storage.
- **D1 starts empty.** The test config sets no `migrations_dir`, so a test that
  needs a control-plane table creates it — `durable-object-runtime.test.ts` does
  this in its `seedOpenAuthority` helper. Declare only the columns the behavior
  reads, and check them against `packages/db/migrations`, because this suite will
  not notice that the real table moved. A test *about* a query belongs on rung 2,
  where the migrations are applied for real. Applying them here instead is
  possible and has been tried — see
  [Worth doing, not done](#worth-doing-not-done) for what it costs and what
  breaks.
- **`exports.default.fetch()` reaches the real Hono app**, but
  `wrangler.test.jsonc` declares a subset of the env contract, so any route
  currently answers `503` `env_contract_failed` with the missing keys listed.
  Route-level tests on workerd are possible — add the vars and bindings whose
  names that error lists to `wrangler.test.jsonc` first. Never relax `src/env.ts` to make a test
  pass; the contract is what stops a half-configured Worker serving traffic.
- **The first call into the Worker costs about 14 seconds** while its module
  graph is instantiated; later calls in the same file take milliseconds. That
  overran Vitest's 5-second default and read as a hang, which is part of what the
  suite-wide 30-second budget in `vitest.workers.config.ts` is sized for; a test
  that needs longer than that floor still asks for it explicitly.
- **One file at a time** needs the config named, and the path is
  package-relative:

  ```bash
  pnpm --filter @rally/api exec vitest run \
    --config vitest.workers.config.ts \
    test-workers/<file>.test.ts
  ```

- **A passing run is noisy.** workerd prints `disconnected: other end of
  WebSocketPipe was destroyed`, `NOSENTRY SQLite alarm overdue`, and stack
  addresses on a completely green run. Read the summary line, and capture the
  output to a file as [AGENTS.md](../AGENTS.md#capturing-command-output) requires
  rather than judging it through a truncating pipe.
- **An assertion placed after an `await` is racing the object's own background
  work.** A real Durable Object keeps running between your awaits: its alarm
  fires, and anything it dispatched keeps executing. Two tests here asserted
  through that gap and passed only because they were faster — one counted
  `durable_outbox` rows that the delivery alarm drains as soon as it forwards
  them, the other read a run's status after `POST /internal/run-dispatch`, which
  *starts* that run, and a run started in this suite dies on the bare D1 and
  terminalizes its own row. Both stayed green in isolation and failed under
  whole-monorepo load; both were reproduced on demand by inserting a two-second
  wait before the assertion, which is how to check whether a green test here is
  proving anything.

  Two fixes work. **Assert on state the background work cannot reach** —
  `durable-object-runtime.test.ts` counts `projection_keys`, written per effect
  in the same transaction as the outbox row it stands for and deleted by
  nothing, rather than counting the outbox rows themselves. Or **keep the call
  and its check inside one invocation the object cannot interleave**, as
  `dispatchWithoutDraining` in `agent-run-lifecycle.test.ts` does by dispatching
  and parking the alarm in a single `runInDurableObject`.

  **Do not build that fence with `state.blockConcurrencyWhile`.** It is for an
  object initializing itself, and calling it re-entrantly from inside
  `runInDurableObject` holds the very input gate `reset()` needs in order to
  clear storage between tests. It was tried here: the guarded test passed, and
  the *next* test in the file started finding a work stream the previous one had
  left behind, failing with `workstream_create_replay_incomplete` — in CI only,
  where the object is under enough load for it to matter.

  Two more forms of the same gap, each of which failed one CI shard:

  - **A fixture dated in the past is fair game for a sweep.** Deleting an
    alarm does not stop a handler that is already running, and that handler
    runs everything due, the expired-draft sweep included. A draft dated weeks
    ago is "expired" to that sweep, so it can vanish mid-test.
    `workspace-resources-inventory.test.ts` dates the drafts it is not testing
    for expiry to now, so no sweep can reach them.
  - **"Nothing is owed now" must name what may be.** Closing the Space cutover
    queues the seating pass (`personal_channel_backfill`) due at once, and under
    load it can still be pending when the object next wakes.
    `space-bootstrap.test.ts` accepts an alarm due now only when that pass is
    what is due.

  `runDurableObjectAlarm` introduces its own variant of the race when the alarm
  it is meant to force is already overdue: workerd clears the alarm slot for the
  entire duration of a firing invocation — the same platform behavior
  [`durable-object-alarms.md`](durable-object-alarms.md) records as a trap,
  where `getAlarm()` returns `null` inside a running handler until `setAlarm`
  is called again — so between an automatic fire and the handler's own
  re-arm the helper finds no alarm, returns `false`, and runs nothing — while
  the auto-fired drain is still in flight for the next assertion to interleave
  with. A test that arms an overdue alarm and must prove work that *moves
  durable state* ran should not force delivery at all: `expect.poll` a read
  of the state the drain settles, and let the timeout be the failure, as the
  semantic-recovery test in `durable-object-runtime.test.ts` does. Polling
  proves nothing about a handler whose success leaves the rows as they were —
  a hold, a deferral, a no-op — because a poll cannot tell "never fired" from
  "fired and held"; there, assert a side effect only the handler writes, or
  drive the handler's work directly, knowing what a concurrent auto-fire
  converges with. A probe may well run while the
  drain is still in flight — reads interleave at the handler's awaits like
  any other invocation, and a probe can observe the unsettled row — but the
  poll tolerates that intermediate answer and retries, a read-only probe can
  neither advance nor duplicate delivery, and it reports success only once
  the drain has synchronously settled the state it asserts on. And unlike a direct
  `instance.alarm()` call, it still fails when construction stops arming the
  alarm, which is half of what such a test exists to prove. Letting the poll's
  timeout be the failure requires that it actually gets to fire: the test budget
  covers the test's setup too, so the poll's own `timeout` has to sit
  comfortably under it (see [Timeouts and waiting](#timeouts-and-waiting)) —
  otherwise a loaded machine turns the poll's legible `expected 1 to be +0` into
  an opaque harness timeout.
- **Budget about 30 seconds** for the whole suite from cold; most of that is
  transform and import, not the tests.

## How much to run

**Match the run to the size of the change.** A full `pnpm test` takes minutes and
most changes do not need one locally. `ci.yml` runs the suites for every revision
of an open pull request, so running those locally buys confidence rather than
correctness. Two things qualify that. The gates outside the matrix have no
backstop at all — `pnpm docs:check`, `pnpm smoke:local`, `pnpm e2e:local` are in
no lane — and that is the distinction the bullets below draw. And `ci.yml`
triggers on `pull_request` alone, so a
branch with no pull request open runs nothing; since a pull request here is
opened ready for review rather than as a draft, that is most of a change's life.

- **Documentation-only changes: run the documentation gates, not the suites.** No
  suite covers prose, but two things do. `pnpm docs:check` scans every file under
  `docs/` for a heading a rebase truncated and for a lakehouse table reference
  that does not match its manifest in `config/`, and only the second of those
  runs in CI — through `pnpm test:scripts` — so a documentation change that
  skips `docs:check` is one whose headings nothing checked.
  And two documents are executable contracts, read off disk and checked against
  what the code produces: `docs/connector-digestibility.md` by
  `packages/connectors/src/digestibility-doc.test.ts`, and
  `docs/workstream-email-addresses.md` by
  `apps/api/test/workstream-email-address.test.ts`. Editing one of those runs
  its test too. For a document not on
  that list,
  `grep -rn 'docs/<file>.md' --include='*.test.*' .` finds the tests that name
  it; most hits only cite a document in a comment, and those need nothing.
  A change inside a source file is not a documentation change even when it
  touches only comments: `// @vitest-environment jsdom` and its neighbours are
  directives, and they decide how the file runs.
- **Ordinary changes: run the tests that cover what you touched.** One file, one
  test name, or the one package's suite. Add a second package only when the
  change crosses into it. Fixing a flake is the exception:
  [the flaky-test rule](../AGENTS.md#flaky-tests) wants the full run, because
  cross-file interference is what makes a flake.
- **Large changes: run `pnpm test` once** before calling it done — every package,
  not the whole suite of the one package you were in, which the bullet above
  already allows. It catches a suite you had no reason to think about.

  The trigger is roughly 20 files, and files in `docs/` do not count toward it.
  The number is the team's and it is approximate, because a file count is a weak
  proxy for what it stands in for: three files in `packages/contracts` or the
  harness reach further than forty independent route handlers. Reach is the real
  trigger — a change to a shared package, or one whose blast radius you cannot
  enumerate, earns the run at any size.

A narrow run you actually read beats a wide one you skim. If a test outside what
you touched fails, that is a real result and it belongs to this change, whether
or not you planned to run it.

## What to test and what not to

**This applies to every test at every rung**, unit suites included. A test runs
the subject and asserts its observable output against a literal: the status and
body a route returned, the rows read back, the message a socket delivered, the
state a reducer settled into, the string a function returned for a fixed input.
Its name says what behavior it covers, and it fails when that behavior breaks.

**A test never reads a production source, stylesheet, HTML, or deploy/config
file and asserts on its text.** `readFileSync` of a `src/` module, `app.css`,
an `index.html`, a Wrangler config or `_headers` followed by `toContain` or
`toMatch` is not a test of anything: it cannot fail for the reason its name
claims, only for the string having moved, and the repair every time is to
paste the new spelling in. `ordinary-harness-run-selection.test.ts` did exactly
that through a rewrite that moved its four queries into a Durable Object: the
assertions were retargeted and stayed green while nobody re-checked the rule.
It is now a workerd suite that seeds the three run shapes and reads. The same
rule covers a test that walks a directory and greps which files import a
module, a test that asserts a declaration is present in a stylesheet, and a
test that restates a config file's contents. If a rule is worth pinning,
something has to _run_ it, or lint has to enforce it.

Each of those tests was written to enforce something real. Enforce it with the
tool built for that shape:

| You want to enforce | Do this |
| --- | --- |
| Only some files may import a module, or call an export | `no-restricted-imports` in `eslint.config.mjs`, with `files` and `ignores` naming who may. The `authorizedConnection` block there is the pattern: everyone under `apps/api/src/` is refused the import except the one module allowed to hold it. |
| A code-shape rule: a class must call a gate in its constructor, a method must stay a prototype method, a statement must not name a table | A rule in `scripts/eslint-rules/`, registered in `eslint.config.mjs`. The rule sees the AST, so it fails on the shape rather than on a spelling, and it runs on every file including the one added next month. |
| Handler wiring in `apps/desktop/src/main/index.ts` | Extract the decision into a module that takes its dependencies as an argument and test that module. `apps/desktop/src/main/workspace-activation.ts` is the pattern: `revalidateWorkspaceActivation(target, operationId, dependencies)` owns the request shape and the error mapping, `index.ts` calls it with the real bridge, and `workspace-activation-wiring.test.ts` drives it with a recording double. What stays in `index.ts` is one call, which a test cannot reach and does not need to. |
| A CSS declaration, a layout, a color | No unit test. jsdom lays nothing out and a stylesheet scan proves only that a string is present. Verify in a real window per [verifying visible changes](../AGENTS.md#verifying-visible-changes), and state that in the pull request's **Validation** section. |
| A config or deploy setting: a route list, a header file, a workflow step | Not testable, and not to be tested; the deploy is the test. See [Do not test CI or deployment configuration](#do-not-test-ci-or-deployment-configuration). |
| A flag list or constant must match across packages | Import the constant from the package that owns it and assert against it, or derive the second list from the first so there is nothing to match. Never scan a source file for the spelling. |
| A doc table must match the code | Allowed only when the test executes the code side. `packages/connectors/src/digestibility-doc.test.ts` reads the document and compares it to what `createConnectorRegistry` produces; a test that reads the document and a source file and compares two strings is the scrape above with a second file. A page scan is allowed on the same terms: `apps/site/test/site.test.ts` checks the landing page's tracked link ids against `SITE_ACTION_LINKS` and `siteActionForLink`, which the code resolves at runtime. |
| A mock was called | Assert the state the call produced, or the argument it was called with. `toHaveBeenCalled()` alone, or `mockResolvedValue(row)` followed by `expect(result).toEqual(row)`, asserts that Vitest works. |
| A constant has its value | Nothing. `expect(LIMIT).toBe(50)` is the constant written twice. A test covers what the code _does_ with the constant. |

A lint rule could enforce this mechanically by refusing any `node:fs` read of a
production source from a test file. None exists yet, so reviewers enforce it by
hand. A few scans that predate this rule remain, such as the whole-stylesheet
checks in `themes.css.node.test.ts` and `palette.css.node.test.ts`; they are not
precedent for a new one.

**A good test:**

- fails when the behavior it is named after breaks, and for that reason;
- asserts a literal the test wrote, not a value the subject or a mock produced;
- survives a refactor that keeps the behavior: renaming a variable, moving a
  query into an object, restyling a rule, changing which file holds a function.

**None of this lowers the bar.** Every behavior change still needs a test that
can fail for the reason it names, and a behavior change without one is a review
finding. The one exception is a change with no runnable test possible: a pure
CSS declaration, unexported Electron wiring, a deploy setting. There the author
verifies another way, a real-window screenshot or an extraction into a module
that can be tested, and says so in the pull request. "No test, verified by
screenshot" is an honest answer; a source scan named as if it were coverage is
not. The choice is never between a scraping test and no test; it is between a
test that runs the subject and a stated, non-test verification.

## Prove the test can fail

**This applies to integration tests only**, and what makes a test one is what
it runs against rather than what it calls. That means rung 1 and rung 2 above:
real workerd in `apps/api/test-workers/`, and any Node test that exercises
production queries, schemas, routes, services, or objects against the checked-in
migrations — `packages/db/test/` included, where the migration itself is the
subject and no route or service is involved. It also applies to the local smoke
and e2e lanes.

Everything else is exempt from the break-and-revert cycle, because nothing real
is underneath it to break: rung 3 and rung 4, pure `packages/*` logic, most
desktop component tests, and the site and release-retention suites, which call
pure functions. At that level the only break available is
usually flipping the literal the assertion already mirrors, which costs a cycle
and proves nothing. When writing one of those, read the list of assertions that
survive a break, below, instead of running the check.

The exemption is from the cycle only. It is not an exemption from
[What to test and what not to](#what-to-test-and-what-not-to): a unit test still
runs its subject and asserts a literal, and a test that reads a source or config
file off disk is out at every rung, exempt or not.

The exemption is by the shape of the test, not the suite it sits in. A renderer
test that drives a real reducer or store through a state transition and reads the
result has a subject a break can teach you something about, and it is worth the
cycle even though it lives in a unit suite. A snapshot or a label assertion in
the same file does not.

**Break the behavior the test names, watch that test fail, then revert.** Make
one edit in the production code. Never edit the test. Run only what you are
proving, one file or a single test name, capturing the output to a file rather
than reading it through a truncating pipe
([capturing command output](../AGENTS.md#capturing-command-output)) — the failure
you are here to read is the one a pipe eats. Under `--filter … exec` the path is
package-relative, so the repo-relative path a failure reports fails as `No test
files found`. Check that it failed for the reason the test is named after, then
revert.

**Break it the way production would break.** Drop the write, skip the lease
check, return the row without its fence, send the message to the wrong work
stream, serve the stale value. What you want to learn is whether the test notices
a defect a member could feel. Flipping a `true` into a `false` on the one line
the assertion mirrors teaches you nothing: it is the same statement written
twice. If that flip is the only break you can find, the test is pinned to a
literal rather than to behavior. At rung 1 there is no rung above it to move to,
so the fix is a better assertion — read the row back, the message the socket
delivered, the status a refused request returned — rather than a promotion.

**Prove each behavior once, not each `it()`.** If one break turns several tests
in the file red, that single run proves all of them. Ten cases covering one
decision need one cycle.

**Keep the run narrow.** This costs two runs of that one file: one with the
break, and one after reverting it, which is the pass that shows the restored code
is green. Confirm the revert by reading the diff for the mutation specifically,
since `git diff` also carries the rest of the change you have not committed. Never
widen the confirmation to the package suite or `pnpm test`.

**The smoke and e2e lanes are not on that budget.** They need a running
`pnpm dev:api:local`, a migrated database, and — for e2e — an OpenRouter key, so
two cycles is a chunk of a session rather than a minute
([`e2e.md`](e2e.md)). Break one production path, run that one lane, revert.

A failure that names something else — a fixture that threw, a schema parse, a
timeout — proves the test runs, not that it observes the behavior. An assertion
that survives the break is asserting on something other than the subject, and it
is usually one of these:

- **The double's own configuration.** `mock.mockResolvedValue(row)` and then
  `expect(result).toEqual(row)` asserts that Vitest works.
- **The expectation computed by the subject.** Calling the function under test —
  or the helper it calls — to build the expected value makes any consistent
  wrong answer pass. Write the literal.
- **Types restated as assertions.** `toBeDefined()`, `toBeTruthy()`, or
  `typeof x === "string"` on a value whose type already says so. `pnpm typecheck`
  covers it; the test spends a name on nothing.
- **The seed, not the result.** Asserting on a row the test inserted, without the
  operation under test having read, moved, or rewritten it.
- **`toHaveBeenCalled()` as the whole assertion.** When the thing that matters is
  the state the call produces. Assert the row, the response body, or the event
  that reached the socket — on rungs 1 and 2 those are all readable, which is
  most of why the real pipeline is the default.
- **A round trip through one module.** Parse-then-serialize with no fixed literal
  on either end passes for any self-consistent format, including a broken one.
- **A snapshot of a stub**, which pins the fixture and re-baselines the moment it
  is wrong.
- **The test's own elapsed setup time.** An assertion never budgets wall clock it
  did not mean to include: a bound built from a `Date.now()` the test captured
  before its own setup ran, or one wide enough to swallow whatever the call did
  in between, is asserting on the machine, and it passes for the wrong reason far
  more often than it fails. Compare two timestamps the *subject* wrote
  adjacently — `test-workers/scheduled-alarms.test.ts` reads the object's own
  pair — rather than the subject's answer against the test's clock.
- **The source text.** `expect(source(file)).toContain("SELECT … WHERE …")` reads
  a module off disk and asserts a string is in it. It cannot fail for the reason
  it is named after, only for the string having moved. This one is not specific
  to integration tests: it is ruled out at every rung, and
  [What to test and what not to](#what-to-test-and-what-not-to) has the history
  and the table of what to do instead.

What to assert instead: the observable output of the real thing — the status and
body a route returned, rows read back through the same API production reads them
with, the SQL the object actually wrote, the message a socket delivered, the
error a rejected input produced.

## Fixtures

Fixtures are scanned like source. A ticket or token fixture must not look like
the real thing: an `eyJ`-prefixed literal trips the Gitleaks `jwt` rule and fails
the `secrets` gate on the pull request that adds it. The scan reads commits
rather than the working tree, so deleting the fixture in a later commit does not
clear it — the branch's history has to be rewritten. `test-workers/socket-subprotocol-runtime.test.ts` keeps the
dot-separated base64url shape without the header for exactly this reason.

Ids stay UUIDv7-shaped — `00000000-0000-7000-8000-…` — wherever production uses
one. Several schemas refine on the version nibble (`value[14] === "7"` in
`packages/contracts/src/index.ts` and `telemetry.ts`), so a `test-id` placeholder
fails validation for a reason that has nothing to do with the behavior under
test.

### Installing and restoring state

**Global and timer state is installed and restored in hooks, never in a test
body.** `vi.useFakeTimers()` is paired with `vi.useRealTimers()` in an
`afterEach`; `vi.stubGlobal` with `vi.unstubAllGlobals()` or the config's
`unstubGlobals`; a database opened during a test is closed by an `afterEach`
rather than by the last line of the body. `test/agent-model-flags.test.ts` states
the reason where it does it — "Closed by `afterEach` rather than by the caller: a
failing assertion throws past any close at the end of a case and leaks the handle
into the rest of the file." A restore that a throwing assertion can skip is not a
restore, and the test it leaks into is the one that gets blamed.

The configs cover half of this and only half. Most package configs now set
`restoreMocks`, `unstubGlobals` and `unstubEnvs`, which closes the stub leak —
but `restoreMocks` does not restore timers, and Vitest's default
`fakeTimers.toFake` includes `setImmediate`, so a file that installs fake timers
and never restores them hands the next file in that worker a clock that does not
advance.

### The migrated database fixtures

`apps/api/test/helpers/sqlite-d1.ts` hands out a migrated regional database in
one of three shapes: `migratedSqliteDatabase()` for the current schema,
`legacyProductSqliteDatabase()` for the product tables as they stood before
`0090` dropped them, and `preRetirementProductSqliteDatabase()` for that same
shape with the work-stream foreign keys the object import has to detach. Use one
of them rather than replaying the migration directory in your own file — sixteen
tests used to, and that is where most of the suite's runtime sat.

`migratedObservabilityFixture()` is a compatibility helper for focused query
tests: it adds the complete telemetry and audit migration chains to a regional
fixture. Because all three schemas share a connection, it cannot prove binding
isolation or disallow cross-database joins. Routing tests must use separate
connections; the collector and delivery tests show that pattern.

The three regional shapes do not replay the migrations per call. The sequence runs once for the whole
run, in `test/global-setup.ts`, and each call rebuilds the shape it ended in
against an empty database: ~7ms rather than ~800ms. Global setup carries both the
compact rebuild snapshot and a full description of the replayed database into
the workers; `test/sqlite-d1-snapshot.test.ts` compares the rebuilt database to
that original description instead of replaying all migrations again under
contended test-file load. The schema is still derived from the checked-in
migrations on every run, so it cannot drift from them — but the rebuild is a
second implementation of *what the migrations produce*, and that fidelity test
is what keeps the two honest. It diffs every `sqlite_master` entry, column,
foreign key, index and row count. **If you teach the rebuild a new trick —
another kind of schema object, another pragma — assert it there**, or the next
person gets a database that is subtly not the one the migrations describe.
It has already caught one: FTS5 index triggers share a name prefix with the
shadow tables a virtual table creates for itself, and the first shadow-table
filter took the triggers with them, leaving every memory-search test green
against an index nothing wrote to.

One thing the fixtures make explicit that the old copies left implicit: seven
migrations set `PRAGMA foreign_keys = ON` themselves, so a replay ends with
enforcement on however the connection was opened. Ten of the sixteen private
copies never wrote that pragma and were relying on it anyway.

## Holding the effect queue

The test Worker binds `ACTIVITY_QUEUE` as a producer with no consumer, and
Miniflare accepts a `sendBatch` to such a queue: an object's drain alarm sends,
deletes its outbox rows, and the envelope is gone before a test can read it. A
test that asserts on what a child or a parent queued, or that wants to deliver
those envelopes at a moment of its choosing, calls `useHeldEffectQueue()` from
`./helpers/effect-queue-hold` at file scope. It refuses effect envelopes only,
the way a Queue outage refuses them, so the producer defers the rows and keeps
them `pending`; the helpers in `./helpers/conversation-effects`
(`pendingChildEffects`, `deliverChildEffects`, `deliverParentEffects`,
`deliverEffectsToWorkspace`) then read exactly those rows and hand them to the
real consumer. The real drain, with its delete on success, is proved once in
`conversation-effect-queue.test.ts`; every other test only needs the effects to
arrive when it says so.

## Letting a run reach the model

**Decide deliberately whether your test lets a run get as far as inference, and
say which you chose.** The workers suite has no provider double and
`wrangler.test.jsonc` carries a placeholder `OPENROUTER_API_KEY`, so a run that
reaches the model makes a real outbound request. That request cannot succeed
here — and it does not fail quickly either. The harness spends an establishment
timeout, then a transport retry, then each configured fallback model before it
gives up, which is far longer than a test's budget. The run stays `executing`,
and the test waiting on it times out on an assertion that has nothing to do with
what broke.

That failure is worse than it sounds, because the passing case is not
necessarily better. `participant-notification.test.ts` used to start an opening
model run in every fixture even though it asserted only committed product state
and regional effects. Under shard contention those live alarms crossed the
next test's `reset()`: one create silently replayed against the previous root,
one parent receipt was absent, and an elicitation precondition stayed
`executing:1`. Isolating selected object ids reduced the frequency but could not
remove a run the tests had no reason to start.

`unseen-workstream-state.test.ts` hit the same failure in PR #630: a speculative
open case inherited the previous case's first-open timestamp before connecting
its socket. The original fixture failed its first shuffled repetition. Its
creation now calls the real product service before endpoint execution activation,
and each case has a fresh workstream identity; removing activation alone still
left a projection failure on the second shuffled repetition. The combined
fixture passed twenty shuffled repetitions, preserving real storage, effects,
and socket assertions rather than hiding the race with retries.

Once the endpoint *does* activate the run, it still does not drain it in the
same request: product `initialize` commits the admitted run, then the endpoint
writes the execution receipt and arms a +1ms alarm
(`requestExecutionReceiptActivation`). A read-only `expect.poll` on loop SQL
then depends on workerd auto-firing that alarm. Under a contended workers shard
the poll's own `runInDurableObject` calls keep the input gate busy, the alarm
never gets a slot, and the wait expires on `executing:1`. Force the wake with
`runDurableObjectAlarm` before polling, the same way
`message-to-output-pipeline.test.ts`'s `settledRunForTrigger` does. The
helper returning false (no alarm, or auto-fire already in flight) is the race
in [Writing a workerd test](#writing-a-workerd-test); keep the poll as the wait
for that case.

So: if what you are testing happens before inference, keep the run away from the
model. Existing-room cases can use the real `bootstrapRuntime` plus the
system-provision `provision` path when that is the state shape under test. A
create-effects case can invoke the real product `initialize` mutation
without the endpoint's later execution-receipt activation. An elicitation-answer
case can use a settled parent-run row when run execution is not the subject. If
the run really has to complete, install the double, and give the run a model to
route to: `wrangler.test.jsonc` deliberately leaves `OPENROUTER_PRIMARY_MODEL`
unset so a run nobody meant to reach inference cannot, and a file that installs
the double calls `useSelectedModel()` from `./helpers/selected-model` at file
scope so its runs do not die on an empty route plan before they reach it.

```ts
import { useOpenRouterDouble } from "./helpers/openrouter-double";

// File scope: every test in the file gets it, and the assertions below hold.
const provider = useOpenRouterDouble((call) => {
  expect(call.toolNames).toContain("memory_recall");
  return { say: "Noted." };
});

it("...", async () => {
  // ... drive the run ...
  expect(provider.calls).toHaveLength(1);
});
```

The handler is a function, not a script: it receives the model, the protocol
transcript, and the tool names offered on that turn, and returns what the
provider should answer — `{ say }` to end the turn — the loop stops on an
assistant message with no tool calls — `{ callTool }` to drive a tool round trip
and be called again with the result, `{ httpError }` for a refusal, `{ raw }`
for a `Response` you build yourself. So a test can assert on
*what the model was asked*, which is usually the more interesting half.

The helper also installs a test Typesafe key and answers the JEV completion
question with a confident `answer_or_result`, restoring the key after each test.
Other JEV questions receive an unavailable response. This keeps scripted final
answers terminal while exercising the real completion policy: omitting this
provider boundary activates the unavailable-judge recovery and consumes another
scripted turn. Completion recovery tests use `installScriptedProvider` with
explicit `completionAnswers` to cover unfinished work, uncertainty and outages.

Streamed turns reach the double as OpenRouter Responses requests, and it answers
with Responses events. `call.messages` and `call.toolNames` read the request
back as Chat messages and tool names through `providerRequestView`, and the raw
items stay on `call.body.input`. The Responses fixture vocabulary lives in one
place, `@rally/agent-harness/test-support/responses-stream`: harness and API
suites describe a turn in Chat chunks (`{ choices: [{ delta, finish_reason }],
usage }`) and `responsesStreamResponse` sends them as the events OpenRouter
streams. An Azure turn is still Chat Completions, so a fetcher that serves both
uses `providerStreamResponse(request, chunks)`.

Four things about it are deliberate:

- **It is opt-in per file, not installed suite-wide.** A file that does not ask
  for it behaves exactly as it did before, so adopting this does not quietly
  change what every other file is asserting.
- **Hosts other than OpenRouter and the explicit Typesafe endpoint are refused, and the refusal is recorded as well as
  thrown.** Production turns a failed provider fetch into a run failure and a
  failed catalog fetch into a shrug, so a throw on its own gets swallowed on the
  way out and the surprise is lost. The recorded list is asserted empty after
  every test, which is what makes an unexpected call visible instead of a
  mystery later. `vi.stubGlobal` replaces `fetch` for the whole isolate, so this
  is the only thing standing between you and a silently swallowed call.
- **The model catalog answers empty on purpose.** The harness falls back to its
  own documented context window for a model the catalog does not describe, and a
  test double is not the place to invent that number
  ([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)).
- **It uses `vi.stubGlobal`, not `fetchMock` from `cloudflare:test`.** That
  export does not exist in `@cloudflare/vitest-pool-workers` 0.22.0, the newest
  published version, nor in the Miniflare it carries — checked 0.18.0, 0.20.0
  and 0.21.3 as well. The package still ships the `MockAgent` and
  `MockReplyOptionsCallback` types and its README still advertises "a
  declarative interface for mocking outbound requests", so the API looks
  available and is not; the runtime export list stops at `SELF`, `env`,
  `runInDurableObject`, `reset` and friends. `vi.stubGlobal` works because the
  test file, the production modules, and the code running inside a Durable
  Object share one isolate here.

## Advisements, to-dos, and traps from Cloudflare's own docs

Checked against Cloudflare's [Vitest integration
documentation](https://developers.cloudflare.com/workers/testing/vitest-integration/)
on 2026-08-20, against `@cloudflare/vitest-pool-workers` 0.21.3 as installed.
Nothing here is blocking; each item is either a rule to follow when you next
touch this area or a change worth making that has not been made.

### Follow these when writing a workerd test

- **Settle `waitUntil` work before asserting.** A handler called directly needs
  `const ctx = createExecutionContext()` and `await waitOnExecutionContext(ctx)`
  before the assertions, or the test observes the state *before* the deferred
  work ran. That race is exactly the kind of intermittent failure
  [the flaky-test rule](../AGENTS.md#flaky-tests) forbids leaving in place.
  Queue consumers have the equivalent: `createMessageBatch()` plus
  `getQueueResult(batch, ctx)`, which reports ack/retry state *and* waits.
  `createScheduledController()` only builds the controller for a cron handler and
  waits for nothing, so a scheduled test still needs its own
  `createExecutionContext()` and a closing `waitOnExecutionContext(ctx)`. Both
  are relevant to the `ACTIVITY_QUEUE` paths, which are not currently driven
  through these helpers. Durable Object alarms are: `runDurableObjectAlarm(stub)`
  invokes the handler and reports whether one was armed, which is how
  `test-workers/scheduled-alarms.test.ts` drives the shared alarm list.
- **Per-file storage isolation has preconditions.** Cloudflare documents that
  isolation only holds if every storage operation is awaited, response bodies
  from `fetch()` and `R2.get()` are fully consumed, and non-primitive RPC
  returns are held with `using`. A dangling promise or an unread body leaks
  state into the next file and surfaces as a flake somewhere else. So **every
  `Response` a Durable Object stub hands back is drained before the test moves
  on**, through `helpers/substream-fixture.ts`'s `boot()` or
  `durable-object-runtime.test.ts`'s `fetchAndDrain` rather than a fourth private
  copy — three files arrived at that helper independently and one missed the
  precondition entirely, which is what an invariant everybody assumes and nothing
  checks looks like. The `using` half needs nothing today only because no stub
  here returns a non-primitive across RPC; the first helper that does has to hold
  it.
- **Mock outbound HTTP with `fetchMock`, not by replacing `globalThis.fetch`.**
  The documented recipes are `fetchMock` (an undici `MockAgent`) or MSW; both
  leave the runtime's request path intact, where a swapped global does not and
  will not catch a malformed `Request`.
- **`additionalExports`** in the pool options is the escape hatch when the pool
  cannot infer a Durable Object or entrypoint class through a build indirection.
  Reach for it before restructuring production code to be testable.
- **Do not enable the `remoteBindings` pool option.** It makes tests reach real
  Cloudflare resources; CI has no credentials for that, and the failure mode is
  a suite that depends on account state.

### Known issues that will otherwise look like our bugs

- **WebSockets in a Durable Object are not supported under per-file storage
  isolation.** Cloudflare's documented workaround is
  `--max-workers=1 --no-isolate`. `durable-object-runtime.test.ts` exercises
  hibernating sockets and passes today, and the `disconnected: other end of
  WebSocketPipe was destroyed` line on a green run comes from this area. If a
  socket test in `test-workers/` ever starts failing intermittently, this is the
  documented cause and that flag pair is the documented fix — not a `retry`.
- **Vitest's fake timers do not reach the KV, R2, and cache simulators.** You
  cannot expire a KV key by advancing fake time; alarms have
  `runDurableObjectAlarm` precisely because the clock is not the lever.
- **Coverage on this suite must use Istanbul.** V8 coverage is unsupported in
  the Workers pool; `apps/api/vitest.config.ts` configures coverage for the Node
  suite only, and adding it to `vitest.workers.config.ts` means setting
  `provider: "istanbul"`.
- **Dynamic `import()` does not work inside a `fetch` handler or a Durable
  Object event handler** under the pool. Static imports at module scope do.
- **The pool pins the Vitest versions it supports** (`assertCompatibleVitestVersion`
  runs at startup). `@cloudflare/vitest-pool-workers` is `latest` in
  `apps/api/package.json` and `vitest` is `latest` through the
  `pnpm-workspace.yaml` catalog, so a Vitest major can arrive ahead of pool
  support and the failure is at startup rather than in a test; the package ships
  a codemod at
  `dist/codemods/vitest-v3-to-v4.mjs` for the last such migration, and the
  configuration API itself was rearchitected onto the `cloudflareTest()` plugin
  in 0.13 — a config found online using `test.poolOptions.workers` predates it.

### Worth doing, not done

- **Apply the real D1 migrations in `test-workers/` instead of hand-written
  `CREATE TABLE`s.** Cloudflare's recipe reads them in Node and applies them
  inside the runtime:

  ```ts
  // vitest.workers.config.ts
  cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.test.jsonc" },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsPath) } },
  }))
  // test-workers/helpers/apply-migrations.ts, named in test.setupFiles
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  ```

  Tried here on 2026-08-20 against `32f1c40`, and the result is worth having
  before someone tries it again. The mechanics work: all 154 tables from
  `packages/db/migrations` apply, `readD1Migrations` is exported from the package
  root in 0.21.3 rather than the `/config` subpath the prose still names, and the
  whole suite stays green. But a green suite is not evidence the tests ran
  against the real schema, and here they mostly did not — **`reset()` drops the
  D1 schema**, so in `durable-object-runtime.test.ts` and
  `message-to-output-pipeline.test.ts` the migrations are undone by the first
  `beforeEach` and the hand-written `CREATE TABLE`s go on running against an
  empty database exactly as before. Only the two files that never reset —
  `agent-run-lifecycle.test.ts` and `agent-run-dispatch-reliability.test.ts` —
  actually see it. Adopting the recipe therefore means applying the migrations
  *after* each reset rather than once in a setup file, and it costs about 14
  seconds per test file either way.

  One more thing that run turned up: against the previous base, the same
  experiment failed `agent-run-lifecycle.test.ts` →
  *"resumes an admitted run after the object is evicted before it starts"*, which
  settled with `agent_run_settlement_failed` and scheduled no wake-up once real
  tables existed. It passes on `32f1c40`, consistent with the trigger-rounding
  fix that landed there — a run stuck behind a `terminalized_at` guard is the
  same symptom. Worth remembering that the hand-rolled schema hid a real bug
  from this suite for as long as it stood in.
- **Consider Wrangler's `createTestHarness()` for the smoke check.** Cloudflare
  now ships an integration harness in the `wrangler` package that starts
  production Worker builds behind their configured HTTP routes and works with any
  Node test runner. `scripts/smoke-local.mjs` currently requires a human to have
  started `pnpm dev:api:local` first, which is why it is not in CI; a harness
  could run the configured regional Workers in-process and make the smoke check a gate
  rather than a manual step.

## Staging a race against an object operation

A receipt or terminal operation used to be a D1 batch, and a test staged a race
by intercepting `batch` and writing between its statements. Those operations are
now one `transactionSync` inside the object, so there is no gap to write into and
that instrument silently never fires — the test still passes, asserting nothing.
Two hooks on `testToolReceiptPort` replace it:

- `beforeTransaction` runs as the transaction opens, before any fence is read.
  The latest a competing write can still be *seen* by the operation.
- `afterStatement` runs after each statement, with its SQL. The earliest a
  competing write lands *behind* a decision the operation has already made.

Between them they cover what the two-batch interception used to: "does the
decision repeat against current rows" and "does an admitted operation finish".
Assert the hook fired — an interception that never runs is the failure mode this
whole section exists for.

**When the property itself is gone, say so rather than simulating it.** Some of
these tests asserted a compensation for a hazard the single transaction removed
— a settlement surviving a lease that lapsed between two statements, a CAS
repeating a predicate a stale read had already answered. Rewriting them to
re-create the old two-step shape would be testing a structure the code no longer
has. Assert the property that replaced it, and put the reason in the test.

## What the objects' RPC surface has, and has not

Every public `async` method on `WorkspaceDO` and `SubstreamAgent` is an interface some Worker calls across a stub. Coverage counts are mechanical,
so re-derive them rather than trusting a checked-in number after a change:

```bash
grep -c "^  \(override \)\?async " apps/api/src/durable-objects/workspace-do.ts
```

The receipt storage class is covered differently, and better: `tool-receipt-authority.test.ts`
reflects over `WorkstreamToolReceiptStorage`'s own methods and drives each one
through the real endpoint, so a method added without a dispatch entry fails there
without anyone remembering to add a case. That is worth copying for the next
typed port rather than maintaining another hand-written list.

The remaining methods without a workerd RPC exercise are:

| Object | Unexercised |
| --- | --- |
| `WorkspaceDO` | `activityEventSource`, `applyWorkstreamRegionalEffect`, `dueWorkstreamDirectory`, `existingOpportunities`, `getOpportunity`, `notificationDirectoryState`, `opportunityWindow`, `resourceAccess`, `workstreamScheduleTargets` |
| `SubstreamAgent` | `publishEvent` |

**Uncovered here does not mean untested** — several have Node suites over their
storage class, which is the right rung for what the SQL decides. It means
nothing has driven them across the RPC boundary against real workerd, so a
protocol change, an identity check or a transaction boundary would not be caught.
Adding a method to one of these classes is the moment to add its workerd
exercise, not later: the Worker-side caller's own suite will reach it through a
double, and a double answers whatever it was told to.

## Recording what you covered

Every module document carries a **Testing** section listing the suites that cover
it, the command that runs each, and the traps
([`module-documents.md`](module-documents.md#the-sections-of-a-module-document)).
Update it in the same change: a suite nobody knows about is a suite the next
person duplicates. The pull request's **Validation** section names what was
actually run — see [`pull-requests.md`](pull-requests.md).
