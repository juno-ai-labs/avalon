# Agent instructions

This is the project-wide rule sheet for AI coding agents, exposed as `CLAUDE.md`
through a symlink. Keep it short: it is read in full at the start of every
session, so detail belongs in `docs/` behind a pointer.

## Names

**Rally** is the product. **Avalon** is its internal code name, carried over from
the prototype — it is not a user-facing name, and prose that uses it as one is
stale. **Juno AI Labs Inc** (informally **Juno Labs**) is the company. Avalon
still appears throughout the tree; what it is coupled to, and what is
deliberately not being renamed, is in
[`docs/rally-rebrand-inventory.md`](docs/rally-rebrand-inventory.md).

### Rebranding Guide

We re-branded an **Automation** into a **Sidekick**.
A **Workspace** was re-branded to **Organization**.
A **Project** became a **Space** and grew in scope.
A **Work stream** became a **Channel**.
A **Substream** became a **Breakout**.

Then, in the navigation redesign ([PRD](docs/PRDs/2026-10-10_channels-threads-navigation/prd.md)),
a **Space** became a **Channel** and a **Channel** became a **Thread**.
Storage names did not change: `spaces` holds Channels, and `channels` and
`workstream` hold Threads.

## How we build

**We design using a platform mindset**. We build simple & generic re-usable building blocks that are combined into complex and emergent behavior. For example: Lego Blocks are simple in that they have a set number of modular sizes but these simple shapes can be combined to build anything as they are modular.

Before you begin see if there is one or more individual primitives that can be built that can be combined to expose the more complex final behavior. Investigate if current primitives can be re-architected or de-composed into better primitives.

Always have a platform mindset. You can always make a simple thing more complicated but never make a complex thing simpler.

Prize **low latency** of opening resources (including spaces, channels, breakouts, artifacts, etc.), opening screens, switching between these, and otherwise interacting with the app or the backend. Keep an eye out for over-engineering and over-validating, trust the platform foundations to be correct and prize low latency instead of double checks. _Low latency is a goal._

## Keeping the Legion up-to-date

If you have a Slack connector available start a thread in Channel #firehose-agents (use the channel configured in your team) when you start a working in a new session (not when you open a new session as that is too early and you don't understand your task but once you start on your actual task). Then keep sending updates to that thread every 30-60 minutes based on the complexity and size of the task.

If you are only doing (code) review then do not start a thread or send updates.

## Where we are

**Rally is a seed-stage startup iterating quickly, and the right engineering
decision here is often not the one that would be right at scale.** There is no
load history, no metrics stack, and no capacity model. Treat that as a constraint
on how a decision is made, not as something to engineer around:

- **Build for the product that exists.** No sharding, caching layer, priority
  queue, or abstraction for a second implementation nobody has asked for.
- **Never gate a decision on measurement nobody here can produce.** Reason from
  the platform's published limits and arithmetic, prefer the option that is
  cheapest to reverse, and let the platform's own failures — a non-empty
  dead-letter queue, an overloaded error — be the monitoring.
  [`docs/choosing-queues-or-rpc.md`](docs/choosing-queues-or-rpc.md#deciding-without-measurement)
  works this through in full.
- **Prefer the failure you will notice** over the one that needs tooling we do
  not have in order to find.
- **A defensive limit is a decision, not a detail.** Adding a cap, a ceiling, a
  timeout, or a cooldown needs a justification, and its _number_ is the team's to
  set rather than yours to guess — write the guard open and hand the number back.
  [`docs/adding-security-defensive-and-other-limits.md`](docs/adding-security-defensive-and-other-limits.md)
  is the rule, and it applies to any limit you are about to type.

**None of this is licence to skip the rules below.** Speed at this size comes
from not paying for the same thing twice: the quality gates take minutes, a flaky
test left alone costs somebody a day, and a change whose _why_ was never written
down gets relitigated by whoever touches it next — which, on a team this small,
is soon, and is probably you. Move fast on _what_ gets built. Do not move fast on
whether it works, or on whether the next person can follow it.

## Platform

We have a macOS Electron app and a browser SPA, and nothing else. When designing
or implementing a feature, first consider which platform or platforms it should support.
Some features are native macOS only, and others are shared across both. When in doubt ask
the (human) user before implementing the feature; if there is no answer, assume macOS and web.

## Tool execution product policy

**Rally never asks users to confirm individual tool calls.** This applies to
reads and writes, built-in tools, connectors, hosted MCP, and future tools.
Do not add tool-approval dialogs, confirmation queues, execution pauses, or model
instructions asking permission before each tool call. Authentication, capability
checks, execution receipts and safe handling of uncertain outcomes still apply.
`mode: "write"` describes execution and retry policy; it does not imply human
approval. Documentation claiming an existing tool-confirmation flow is incorrect
and must be corrected, not implemented. See
[`docs/hosted-mcp-connectors.md`](docs/hosted-mcp-connectors.md).

## Environment

**Read [`docs/dev-environment.md`](docs/dev-environment.md) at the start of every
session, before running a setup, server, or browser-automation command.** It
covers dependency installation, the local D1 database, starting both regional
Workers, and running the Electron client headlessly. The container it assumes is
defined in [`docs/sandbox.md`](docs/sandbox.md).

## Quality gates

Run lint and typecheck locally as well — both cache, so a warm run is seconds
and there is nothing to scope. Tests are the one to scope:
run the ones that cover what you touched, and
[`docs/testing.md`](docs/testing.md#how-much-to-run) says when a full run is
worth the minutes and when it is waste.

`pnpm test:scripts` covers the repository's own `scripts/`. The release
tooling under `apps/desktop/scripts/` is a separate suite that CI runs as
`pnpm --filter @rally/desktop test:release`. Run that **only** when touching
a release script.

Both gates cache; warm runs take seconds. **_Only_ after changing a rule in
`scripts/eslint-rules/`, run `pnpm lint:fresh`** — ESLint's cache keys on file
contents alone, so it clears the rest of the tree against the _old_ rule. CI
runs cold; limits in
[`docs/dev-environment.md`](docs/dev-environment.md#quality-gate-caches).

## Writing tests

**Read [`docs/testing.md`](docs/testing.md) before adding a test.** It maps the
suites to what each one can prove, and holds the rules below.

**Touching Durable Object SQLite SQL?** Both implementers and reviewers must
read [`docs/durable-object-sqlite.md`](docs/durable-object-sqlite.md).

- **Default to the real Cloudflare pipeline.** Anything that depends on the
  runtime — Durable Object storage, alarms, hibernation, WebSocket upgrades, D1
  semantics — belongs in `apps/api/test-workers/`, which runs on real workerd
  (`pnpm --filter @rally/api test:workers`). That suite's D1 starts with no
  schema, so a test there declares the tables it needs; a query or a constraint
  is proved in the Node suite instead, which applies the checked-in migrations
  rather than stubbing a database. A double stands in for something that
  _cannot_ run here — Workers AI, Flagship, a provider's API — never
  for setup that was inconvenient.
- **A test runs the subject and asserts its observable output against a
  literal.** It never asserts on the text of a source, stylesheet, HTML or
  config file, a mock's own value, or a constant against itself. This does not
  lower the bar:
  [`docs/testing.md`](docs/testing.md#what-to-test-and-what-not-to) has what to
  do instead, including when no runnable test is possible.
- **Prove every integration test can fail.** For a `test-workers/` test, a Node
  test exercising a query, schema, route, service, or object against the real
  migrations, or a local smoke or e2e lane, break the behavior it covers with one
  edit in the production code, watch that test fail for the reason its name
  claims, then revert. Break it the way production would break — a dropped write,
  a skipped check, a stale read — not by flipping the literal the assertion
  mirrors, which proves nothing. Unit-level tests, where the only break available
  is the literal the assertion mirrors, are exempt. Prove each behavior once
  rather than each case, and re-run only that one file: never the package, never
  `pnpm test`. An
  assertion that survives the break is asserting on a fixture, a mock's own
  configuration, or a value the subject computed — none of which is coverage.
  [`docs/testing.md`](docs/testing.md#prove-the-test-can-fail) has the scope in
  full, and the catalogue of assertions that survive a break.
- **Never test CI or deployment configuration.** No test reads a workflow file,
  a Wrangler or deploy config, or checks a provisioning, deploy-mode or health
  script; the run and the deploy are their test. Code that decides about data or
  a shipped build (D1 migration tooling, desktop release scripts) is still tested
  as code. [`docs/testing.md`](docs/testing.md#do-not-test-ci-or-deployment-configuration)
  has why.

## Flaky tests

**A test that fails once and passes on a rerun is a defect in the test or the
code under it — fix it in the change that encountered it, whoever wrote it.**
Rerunning until green, skipping it, or setting `retry` in a Vitest config hides
a real race that will fail for someone else; none of those are an accepted
resolution here.

- Reproduce it first, in isolation and in bulk, capturing the output to a file
  as the section below requires — the failing iteration is the evidence, and it
  is the one that gets truncated away. `--filter … exec` runs in the package
  directory, so the path is package-relative; pasting the repo-relative path a
  failure reports fails as `No test files found`, naming the file rather than
  the working directory:

  ```bash
  (for i in $(seq 20); do
     pnpm --filter @rally/<pkg> exec vitest run <path-within-the-package> \
       || { echo "failed on run $i"; exit 1; }
   done) &> /tmp/flake.log
  ```

  The subshell makes the loop exit nonzero on the first failing run rather than
  reporting the success of `break`, and the iteration number characterizes how
  often the flake fires. Add `--sequence.shuffle` to catch a test that depends
  on another in the same file having run first; cross-file interference only
  appears in a suite-wide rerun, where `--no-file-parallelism` isolates it.

- Confirm the fix by looping the test again, then run the full `pnpm test` once
  more before calling the change done. This is the deliberate exception to
  [how much to run](docs/testing.md#how-much-to-run): cross-file interference is
  what makes a flake, and a narrow run is where it hides.
- Fix the cause. A flake rooted in code the change does not touch may be left
  unfixed — only then, and only if it is named in the report and the pull
  request description. Never leave an intermittent failure unmentioned.

## Naming a schema failure

**A rejection that reaches a log, a notice, an operator, or the far side of an
RPC hop must name the field it rejected.** A `ZodError` knows exactly what was
wrong and where, and almost every boundary in this tree throws that away: a
Durable Object RPC reduces it to a bare `Error` with no `issues` and no message,
`connectorObservationErrorCode` reads it as `unexpected_error` because it is not
a `ConnectorError`, and `scheduledAlarmErrorCode` reads it as `handler_error`
because its message is a JSON blob rather than a code.

Four such boundaries lost the same information in one week, and each cost a
separate diagnosis of the same bug.
[`docs/naming-a-schema-failure.md`](docs/naming-a-schema-failure.md) records
what that cost and holds the catalogue.

- **Use `zodDiagnosticCode`, `describeZodIssues` or `codeShaped` from
  `@rally/contracts`.** They are one implementation deliberately: a boundary
  that writes its own is how the root path shipped spelled `(root)`, outside the
  character class the operator notice required.
- **Never widen what is reported to the caller.** Issue codes and _declared_
  field names are schema shape and may cross. Record keys, `unrecognized_keys`
  names from an untrusted caller, rejected values, and an adapter's `message` —
  which may hold a caught provider error's own text — are data and may not.
  Sanitizing a value to the code's character class is formatting, not redaction.
- **A generic code is a defect, not a fallback.** `unexpected_error`,
  `handler_error`, `ZodError`, `internal_error` and `unhealthy` on a path that
  had the reason in hand are each a bug to fix in the change that finds one —
  the same standing as a flaky test.
- **An adapter that returns a failure owes its reason too.** A `{ ok: false,
message }` is not exempt because it did not throw; Granola's health check
  computed "webhook endpoint identity is missing" and the log said `unhealthy`.

## Capturing command output

For any command with non-trivial output — tests, typecheck, lint, migrations,
Worker or Electron startup — write the full output to a file rather than reading
it through a truncating pipe:

```bash
pnpm test 2>&1 | tee /tmp/test.log   # inline preview plus the full file
pnpm test &> /tmp/test.log           # silent; read or grep the file afterwards
```

`2>&1` must come before the pipe, or stderr bypasses `tee`. A pipeline reports
the last command's exit code, so keep `tee` last. Delete the logs when done.

## Verifying visible changes

**Every change a user can see must be looked at in a real window before it is
called done.** A passing component test asserts on the DOM, which says nothing
about whether an element is visible, positioned, legible, or covered. Run the
desktop client under Xvfb, attach Playwright over the DevTools protocol, capture
the screens you changed, and read the images — the procedure is in
[`docs/dev-environment.md`](docs/dev-environment.md#driving-and-screenshotting-it).
Playwright is already installed globally on the sandbox image; do not add a
browser driver to the repository.

## Documentation

**Before planning or making a change, read [`docs/README.md`](docs/README.md)** —
it indexes every document and says which one owns which area. Find the ones whose
scope matches what you are touching, read them first, and update them in the same
change. When a change introduces a subsystem no existing document covers, add
`docs/<lower-kebab-name>.md` and register it in that index — the index is the one
registry that has to stay complete. Product requirement documents are the exception: they
live in dated folders under `docs/PRDs/` and are not registered, per
[`docs/prds.md`](docs/prds.md). The root [`README.md`](README.md) links only to
that index and lists no documents of its own; do not add a second list there.

**Every architecture or large module you create or substantially change gets its
own document in `docs/`, written to the shape in
[`docs/module-documents.md`](docs/module-documents.md)** — read it before writing
or editing one. It defines the threshold for what needs a document, the required
sections, and the one thing that is non-negotiable: each such document ends with
a **running changelog**, newest entry first, appended **in the same change as the
code**. An entry records what changed _and why it changed_ — the pressure that
forced it, the alternative that was rejected, and what a future change has to
respect. **Only add meaningful and material entries: one per pull request per
document, in the document that owns the mechanism, and none for a rename, a
test, a review round, or a documentation catch-up** —
[`docs/module-documents.md`](docs/module-documents.md#what-earns-an-entry) has
the full list and the test.

The code says what the module does and the diff says what moved; only
that section says why, and it is written for whoever changes this module a year
from now without you to ask. "Refactor" and "cleanup" are not a why. Never invent
one you do not know — say the earlier reasoning was not recorded.

## Pull requests

**Before opening a pull request, read
[`docs/pull-requests.md`](docs/pull-requests.md)** — it defines the required
description sections, the repository's merge style, and its rule that pull
requests are opened ready for review, never as drafts. Do not open a PR unless
you were asked to.

**Only rebase a branch in a PR if there is a conflict and not as a pre-merge ritual.**

## Security

Never commit secrets. `.env.local` and `apps/api/.dev.vars.*` are ignored and
must stay that way, server secrets must never sit behind a `VITE_` name, and
Cloudflare administration credentials belong only to the local deployment
environment — never as Worker variables. [`docs/security.md`](docs/security.md)
owns the desktop client's isolation model.
