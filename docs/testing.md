# Writing a test

Which suite a new test belongs in, which runtime it runs on, and the check that
has to pass before it is worth keeping. Read it before adding tests to a change.

Two rules run through everything below. **Default to the real Cloudflare
pipeline**: workerd, a real Durable Object, real SQLite, the checked-in
migrations — a double stands in for something that *cannot* be run here, never
for setup that was inconvenient. And **prove the test can fail**: a test that
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
| `apps/api/test/**/*.test.ts` | `pnpm --filter @avalon/api exec vitest run` | Node. Services and route handlers with bindings supplied by the typed builders, and real SQL through `node:sqlite`. |
| `apps/desktop/src/{renderer,main,common}/**/*.test.{ts,tsx}` | `pnpm --filter @avalon/desktop test` | jsdom. Asserts on the DOM, which is not the same as looking at the screen — see [verifying visible changes](../AGENTS.md#verifying-visible-changes). |
| `packages/*/src/**/*.test.ts` | `pnpm --filter @avalon/<pkg> test` | Node. Pure contract, harness, and connector logic. |
| `scripts/*.test.mjs` | `pnpm test:scripts` | `node --test`. The repository's own tooling and the ESLint boundary rules. |
| `apps/desktop/scripts/*.test.mjs` | `pnpm --filter @avalon/desktop test:release` | `node --test`. The release planner and workflow invariants — **not** covered by `pnpm test:scripts`, whose name suggests otherwise. |
| `apps/api/scripts/test-crash-symbolicator-container.mjs` | `pnpm --filter @avalon/api test:crash-symbolicator-container` | Docker. Builds and exercises the symbolicator image. |
| `scripts/smoke-local.mjs` | `pnpm smoke:local` against a running `pnpm dev:api:local` | Two real regional Workers under `wrangler dev`, with the local D1 database. |

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
  stands in a fake one that validates nothing; a rebuild that workerd rejects at
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
- `test/helpers/sql-storage.ts` — `createTestSqlStorage()` does the same for
  object-local `SqlStorage`, and turns foreign keys on because `node:sqlite`
  defaults them off while workerd enforces them. Without that, an object-side
  foreign key is unenforced in tests and enforced in production.

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

The last resort, and rare on purpose — seventeen files in the API suite. Mocking
a module replaces code the change is supposed to protect, and the mock keeps
passing after the real module's contract moves. If the subject's dependencies are
all mocked, the test covers the wiring of the mocks.

## Writing a workerd test

```ts
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await reset();
});
```

- **`await reset()` in `beforeEach`.** Durable Object and D1 state persists
  between tests in the same file otherwise, and the second test starts depending
  on the first having run.
- **Bindings come from `apps/api/wrangler.test.jsonc`**, not from the production
  configs. A new Durable Object class needs both a binding and its name in the
  `new_sqlite_classes` migration tag, or the object has no SQLite storage.
- **D1 starts empty.** The test config sets no `migrations_dir`, so a test that
  needs a control-plane table creates it — `durable-object-runtime.test.ts` does
  this in its `seedOpenAuthority` helper. Declare only the columns the behavior
  reads, and check them against `packages/db/migrations`, because this suite will
  not notice that the real table moved. A test *about* a query belongs on rung 2,
  where the migrations are applied for real.
- **`SELF.fetch` reaches the real Hono app**, but `wrangler.test.jsonc` declares
  a subset of the env contract, so any route currently answers `503`
  `env_contract_failed` with the missing keys listed. Route-level tests on
  workerd are possible — add the vars and bindings that log names to
  `wrangler.test.jsonc` first. Never relax `src/env.ts` to make a test pass; the
  contract is what stops a half-configured Worker serving traffic.
- **One file at a time** needs the config named, and the path is
  package-relative:
  `pnpm --filter @avalon/api exec vitest run --config vitest.workers.config.ts test-workers/<file>.test.ts`.
- **A passing run is noisy.** workerd prints `disconnected: other end of
  WebSocketPipe was destroyed`, `NOSENTRY SQLite alarm overdue`, and stack
  addresses on a completely green run. Read the summary line, and capture the
  output to a file as [AGENTS.md](../AGENTS.md#capturing-command-output) requires
  rather than judging it through a truncating pipe.
- **Budget about 25 seconds** for the whole suite from cold; most of that is
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
- **`toHaveBeenCalled()` as the whole assertion**, when the thing that matters is
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

## Recording what you covered

Every module document carries a **Testing** section listing the suites that cover
it, the command that runs each, and the traps
([`module-documents.md`](module-documents.md#the-sections-of-a-module-document)).
Update it in the same change: a suite nobody knows about is a suite the next
person duplicates. The pull request's **Validation** section names what was
actually run — see [`pull-requests.md`](pull-requests.md).
