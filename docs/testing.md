# Writing a test

Which suite a new test belongs in, which runtime it runs on, and the check that
has to pass before it is worth keeping. Read it before adding tests to a change.

Two rules run through everything below. **Default to the real Cloudflare
pipeline**: real workerd and a real Durable Object for anything the runtime
decides, and the checked-in migrations against real SQLite for anything a query
decides — a double stands in for something that *cannot* be run here, never for
setup that was inconvenient. And **prove the test can fail**: a test that
stays green when the code under it is broken is not covering that code, and the
suite is worse off for it because the name says otherwise.

[`e2e.md`](e2e.md) owns the manual acceptance flows and the live-Worker smoke
check; [`type-safety-boundaries.md`](type-safety-boundaries.md) owns how a test
double is *typed*, this document owns whether it should exist at all; and
[the flaky-test rule](../AGENTS.md#flaky-tests) owns what to do when a test fails
once and passes on a rerun.

## The suites

| Suite | Command | Runs on |
| --- | --- | --- |
| `apps/api/test-workers/**/*.test.ts` | `pnpm --filter @avalon/api test:workers` | **Real workerd**, through `@cloudflare/vitest-pool-workers`. Durable Objects, their SQLite storage, alarms, hibernation, eviction, `WebSocketPair`, D1, and queue producers are the real implementations. |
| `apps/api/test/**/*.test.ts` | `pnpm --filter @avalon/api exec vitest run` | Node. Services and route handlers with bindings supplied by the typed builders, and real SQL through `node:sqlite`. `cloudflare:workers` is aliased to `test/helpers/cloudflare-workers.ts`, which stands in for the `DurableObject` base class and the `tracing` custom-span API — the stand-in keeps their contracts but nests no spans and exports nothing, so anything depending on either belongs a rung up. |
| `apps/desktop/src/{renderer,main,common}/**/*.test.{ts,tsx}` | `pnpm --filter @avalon/desktop test` | jsdom. Asserts on the DOM, which is not the same as looking at the screen — see [verifying visible changes](../AGENTS.md#verifying-visible-changes). Console output is buffered and printed only for failing tests (`silent: 'passed-only'`), because the renderer's [performance traces](performance-tracing.md) print on every create, open, and send; a test that asserts on a log line spies on `console` itself and is unaffected. |
| `packages/*/src/**/*.test.ts` | `pnpm --filter @avalon/<pkg> test` | Node. Pure contract, harness, and connector logic. |
| `packages/db/test/**/*.test.ts` | `pnpm --filter @avalon/db test` | Node. The migration sequence itself and the work-stream queries over it — where a migration's own test goes, rather than beside the package's source. |
| `apps/site/test/**/*.test.ts`, `apps/release-retention/test/**/*.test.ts` | `pnpm --filter @avalon/site test`, `pnpm --filter @avalon/release-retention test` | Node. The public site Worker and the release-retention Worker, each with its own R2 builder. |
| `scripts/*.test.mjs` | `pnpm test:scripts` | `node --test`. The repository's own tooling and the ESLint boundary rules. |
| `apps/desktop/scripts/*.test.mjs` | `pnpm --filter @avalon/desktop test:release` | `node --test`. The release planner and workflow invariants — **not** covered by `pnpm test:scripts`, whose name suggests otherwise. |
| `apps/api/scripts/test-crash-symbolicator-container.mjs` | `pnpm --filter @avalon/api test:crash-symbolicator-container` | Docker. Builds and exercises the symbolicator image. |
| `scripts/smoke-local.mjs` | `pnpm smoke:local` against a running `pnpm dev:api:local` | Two real regional Workers under `wrangler dev`, with the local D1 database. |
| `scripts/e2e-local.mjs` | `pnpm e2e:local` against a running `pnpm dev:api:local`, after `pnpm db:open-authority` | The full member pipeline over the live local stack — happy, sad, and chaos lanes, with real model calls when `OPENROUTER_API_KEY` is configured. See [`e2e.md`](e2e.md#automated-behavioral-lane). |

`pnpm test` runs every package's `test` script recursively, and `@avalon/api`'s
runs the Node suite *and then* the workerd suite — so a green `pnpm test`
includes workerd. CI splits them: `api-tests-2-of-2` appends
`pnpm --filter @avalon/api test:workers`, and the container and release suites
are their own matrix jobs.

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
  envelopes between objects.

The Node suite cannot stand in for any of it. `apps/api/vitest.config.ts` aliases
`cloudflare:workers` to `test/helpers/cloudflare-workers.ts`, a ten-line stand-in
whose `DurableObject` base class stores `ctx` and `env` and does nothing else —
so a Durable Object under Node is an ordinary class, and everything the platform
contributes is absent by construction.

### 2. Node against real SQL

When the behavior is a query or a schema rather than a runtime feature, run it
against the checked-in migrations rather than against a stub:

- `test/helpers/sqlite-d1.ts` — `migratedSqliteDatabase()` applies every
  `packages/db/migrations/*.sql` to a fresh in-memory `node:sqlite` database, and
  `sqliteD1()` presents it through the `D1Database` surface the services use.
  Sixty-odd API test files already work this way.
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
implementation (`AI`, `MEMORY_INDEX`, `FLAGS` — see
[what cannot be verified in a sandbox](dev-environment.md#what-cannot-be-verified-in-a-sandbox)),
a provider's HTTP API, a clock, a source of randomness. Double that collaborator
and nothing else, and type it per
[`type-safety-boundaries.md`](type-safety-boundaries.md): the smallest capability
the subject consumes, `satisfies` or `implements`, `createTestEnv` and friends
for platform bindings.

### 4. `vi.mock` on a module

The last resort, and rare on purpose — seventeen of the API suite's 183 files
(`grep -rl 'vi\.mock(' apps/api/test`; counting `vi.mocked` as well returns 25,
but that helper only types a value that is already mocked). Mocking a module
replaces code the change is supposed to protect, and the mock keeps passing after
the real module's contract moves. If the subject's dependencies are all mocked,
the test covers the wiring of the mocks.

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
  attached binding. For D1 that includes the *schema* — measured here, 154 tables
  before the call and none after — and it reaches Durable Object storage too: a
  table written through `runInDurableObject` is gone when the same object id is
  opened after a reset. A file that isolates its tests some other way is not
  evidence against that: `agent-run-lifecycle.test.ts` and
  `agent-run-dispatch-reliability.test.ts` take a fresh object id per test
  because they never call `reset()`, not because storage would survive one.
  `abortAllDurableObjects()` is the one that keeps persisted data, but it aborts
  instances rather than retiring them: a test *about* eviction still wants
  `evictDurableObject`, which drains in flight work and hibernates sockets.
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
  overruns Vitest's 5-second default and reads as a hang, so give the first
  route-level test in a file an explicit `timeout`.
- **One file at a time** needs the config named, and the path is
  package-relative:

  ```bash
  pnpm --filter @avalon/api exec vitest run \
    --config vitest.workers.config.ts \
    test-workers/<file>.test.ts
  ```

- **A passing run is noisy.** workerd prints `disconnected: other end of
  WebSocketPipe was destroyed`, `NOSENTRY SQLite alarm overdue`, and stack
  addresses on a completely green run. Read the summary line, and capture the
  output to a file as [AGENTS.md](../AGENTS.md#capturing-command-output) requires
  rather than judging it through a truncating pipe.
- **Budget about 30 seconds** for the whole suite from cold; most of that is
  transform and import, not the tests.

## Prove the test can fail

**Break the code the test covers, watch that test fail, then revert.** Do it
before the change is called done, for every test written or substantially
changed:

```bash
# 1. Make the production code wrong: invert the condition, delete the write,
#    return the wrong constant. One edit, in the code — never in the test.
# 2. Run only that file, and read the failure.
pnpm --filter @avalon/api exec vitest run test/<file>.test.ts &> /tmp/proof.log
# 3. Confirm it failed *for the reason the test is named after*, then revert.
```

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

What to assert instead: the observable output of the real thing — the status and
body a route returned, rows read back through the same API production reads them
with, the SQL the object actually wrote, the message a socket delivered, the
error a rejected input produced.

## Fixtures

Fixtures are scanned like source. A ticket or token fixture must not look like
the real thing: an `eyJ`-prefixed literal trips the Gitleaks `jwt` rule, and that
gate runs over the full history rather than the diff, so it fails for everyone
afterwards. `test-workers/socket-subprotocol-runtime.test.ts` keeps the
dot-separated base64url shape without the header for exactly this reason.

Ids stay UUIDv7-shaped — `00000000-0000-7000-8000-…` — wherever production uses
one. Several schemas refine on the version nibble (`value[14] === "7"` in
`packages/contracts/src/index.ts` and `telemetry.ts`), so a `test-id` placeholder
fails validation for a reason that has nothing to do with the behavior under
test.

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
  are relevant to `WorkspaceScheduler` and the `ACTIVITY_QUEUE` paths, neither of
  which is currently driven through these helpers.
- **Per-file storage isolation has preconditions.** Cloudflare documents that
  isolation only holds if every storage operation is awaited, response bodies
  from `fetch()` and `R2.get()` are fully consumed, and non-primitive RPC
  returns are held with `using`. A dangling promise or an unread body leaks
  state into the next file and surfaces as a flake somewhere else.
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
  could run both regional Workers in-process and make the smoke check a gate
  rather than a manual step.

## Recording what you covered

Every module document carries a **Testing** section listing the suites that cover
it, the command that runs each, and the traps
([`module-documents.md`](module-documents.md#the-sections-of-a-module-document)).
Update it in the same change: a suite nobody knows about is a suite the next
person duplicates. The pull request's **Validation** section names what was
actually run — see [`pull-requests.md`](pull-requests.md).
