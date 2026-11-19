# Daytona v2 transition: design and flip-over plan

> Created 2026-11-19. Companion to [`prd.md`](prd.md).
>
> Architecture and cutover plan for moving Terminal sandboxes from Daytona's
> 0.x interface to v2 in one pull request. Read section 1 first: a live spike
> found that v2 cannot hold a Linux sandbox's files across a stop, and that
> decides whether the pull request should be written at all.
> The subsystem this changes is [`terminal-workspaces.md`](../../terminal-workspaces.md).

Every v2 claim below names the file in the unpacked SDK 2.0.0 package it comes
from (`README.md`, or `dist/esm/v2/<file>`), or is marked **spike** (measured
against real Daytona v2 on 2026-11-19, from Node, not from a Worker), or is
marked **unproven**.

## 1. The central question: v2 Linux sandboxes are ephemeral

### What was found

- **Spike.** On a v2 Linux sandbox, `stop`, `pause`, `resume` and `fork` all
  answer 409 CONFLICT: "sandbox is not persistent; ... unavailable (delete
  instead)". `start` on a running sandbox succeeds. `delete` took 2.3 s.
- The SDK agrees. `clientCreateRequests.js` passes `persistent: false` for
  every Linux create. The Linux create request in `gen/api.d.ts` has no
  `persistent` field. `EffectiveLinuxLifecyclePolicies` has only `ephemeral`;
  the macOS one has `ephemeral` and `persistent`. `Sandbox.d.ts` documents
  `persistent` as "macOS only".
- A lifecycle policy cannot stop a Linux sandbox either.
  `lifecycleActionAllowed` in `http.js` accepts `delete` everywhere, `stop`
  only for a persistent macOS sandbox, and `pause` never. The wall-clock
  timeout cannot be disabled (`types.d.ts`, `LifecyclePolicyOptions`).
- v2 has no `archive`, no `recover` and no `recoverable` flag. Its states are
  `queued`, `creating`, `starting`, `started`, `pausing`, `stopping`,
  `stopped`, `paused`, `destroying`, `destroyed`, `error`, `unknown`
  (`types.d.ts`, `SandboxState`).
- **Spike.** What does work is fast: create with
  `networkPolicy: { allowDomains: ['github.com'] }` took 966 ms and came back
  `started`; `getNetworkPolicy()` returned desired equal to applied, status
  `applied`, `appliedRevision` 1, an etag and an `appliedStartId`.
  `process.run` took 254 ms and returned stdout and stderr separately.

Terminal's contract with a person is: the sandbox stops after 5 idle minutes,
archives after 60, keeps every file for 30 days, and the next tool call
restores it. On v2 Linux today the only thing Rally can do to an idle sandbox
is leave it running or delete it. So the PRD's plan (same lifecycle, new
adapter) cannot be built as written.

### The options

Two ways exist in v2 to keep files past a sandbox's life. Both have project
limits read from `getLimits()` in the spike: 100 disk volumes and 1000
snapshots per project.

|                                     | A. Wait for persistent Linux on v2                            | B. Ephemeral sandbox + one volume per conversation                                                                                                                                                                                                                                                                                               | C. Ephemeral sandbox + snapshot on idle                                                                                                                                                                                                                                          | D. Stay on v0                                               |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| How files survive idle              | Stop keeps the disk, as today (assumed; Daytona must confirm) | A disk volume mounted at `/workspace` outlives the sandbox (`create({ volumes })`, `Volume.d.ts`)                                                                                                                                                                                                                                                | `sandbox.createSnapshot()` before delete, `createFromSnapshot()` on next use                                                                                                                                                                                                     | Unchanged                                                   |
| What a person keeps                 | Whole filesystem                                              | Only `/workspace`. System packages, the home directory and caches are lost at every idle stop, not once                                                                                                                                                                                                                                          | Whole filesystem and memory                                                                                                                                                                                                                                                      | Whole filesystem                                            |
| Latency of the next call after idle | A start. Unmeasured on v2                                     | A create (966 ms in the spike) plus the managed probe. Likely faster than today's archive restore. Volume I/O speed for `git` and `node_modules` is unmeasured                                                                                                                                                                                   | A snapshot restore, unmeasured. Each idle stop also pays a snapshot capture, unmeasured                                                                                                                                                                                          | Unchanged                                                   |
| Durability risk                     | None new                                                      | Low. Files are never in flight at idle; deleting the sandbox does not touch the volume                                                                                                                                                                                                                                                           | High. Every idle stop moves the only copy. A failed capture means keep paying for a running sandbox or lose files                                                                                                                                                                | None new                                                    |
| Network policy and secrets          | Set at create, updated in place, confirmed applied            | Set at every create and confirmed applied. The cleanest fit for PRD goal 5                                                                                                                                                                                                                                                                       | `createFromSnapshot` takes no policy, secrets, env or resources (`README.md`, "Create sources"); a restore inherits the source's policy. A policy changed while idle must be updated and confirmed after restore, and restored processes run under the old allow list until then | Read-back inference, as today                               |
| Generation and cleanup machinery    | Fits unchanged. One sandbox id per generation                 | Does not fit. Today a new sandbox id means a new generation, which drops imports, the repository bootstrap mark and credentials. With B the sandbox changes at every idle stop, so identity must split: the volume is the generation, the sandbox is a disposable instance. New columns, new lifecycle states, cleanup intents for two resources | Does not fit. Same split, with the snapshot as the durable identity, plus an intent for "capture done, delete pending" and for deleting the previous snapshot                                                                                                                    | Unchanged                                                   |
| Limits                              | Sandbox quota only                                            | 100 volumes per project. One per Canvas and Sidekick does not fit without Daytona raising it                                                                                                                                                                                                                                                     | 1000 snapshots per project. Does not fit either, later                                                                                                                                                                                                                           | None new                                                    |
| Policy walk over idle sandboxes     | Update desired policy in place                                | Nothing to walk. The next create carries the current policy                                                                                                                                                                                                                                                                                      | Nothing to walk, but the restore path owes an update-and-confirm                                                                                                                                                                                                                 | Unchanged                                                   |
| Cost of doing it                    | The PRD as written, plus section 3                            | A new lifecycle, a PRD amendment for the lost system state, and the limit raised                                                                                                                                                                                                                                                                 | A new lifecycle with the hardest failure cases                                                                                                                                                                                                                                   | Zero now. The six gains in the PRD's motivation are not had |

### Recommendation

**Do not write the cutover pull request yet. Stay on v0 (D), ask Daytona
whether and when persistent Linux sandboxes come to v2 (A), and write the pull
request in section 4 when they do.**

Reasons:

1. The PRD's own motivation says nothing forces the move. Daytona keeps 0.x
   working and will announce an end date months ahead.
2. B and C both replace Terminal's lifecycle and its identity model. That is a
   larger change than the transition itself, it changes what a person keeps,
   and neither fits the project limits. Building either now is building for a
   provider shape that Daytona may change, which is the over-engineering
   `CLAUDE.md` asks us to avoid.
3. A v2 adapter written today would be written against the wrong lifecycle.
   Its create options, its idle handling and its row state all depend on which
   option wins.

If Daytona answers "no persistent Linux, and 0.x gets an end date", choose
**B**, not C. B keeps the one promise the PRD already limits Terminal to
(`/workspace`), never has the only copy of a person's files in flight, and
confirms policy and secrets at every create. It needs a new PRD, because
losing installed packages at every idle stop is a product change, and it needs
the volume limit raised.

What is still worth doing now, without the SDK upgrade, is small and listed in
section 8 as "can land today". Nothing else should merge.

The rest of this document is the design for option A. It is conditional on
this assumption, which Daytona must confirm: **a v2 Linux sandbox can be
created persistent, `stop()` keeps its disk, and `start()` brings it back.**
Section 9 says what changes under B.

## 2. Departures from the PRD

1. **The pull request waits for Daytona.** Section 1. The PRD's phase 0 asked
   the right questions but did not expect this answer.
2. **No archive on v2.** The PRD says a sandbox "archives after sixty minutes".
   v2 has no archive. A v2 sandbox stays `stopped` from the 5 minute stop until
   the 30 day delete. What a stopped v2 sandbox costs is an open question.
3. **Sidekick retirement moves to Rally.** Today Daytona stops a Sidekick's
   sandbox after 15 idle minutes and deletes it 30 days after the stop. v2
   lifecycle policy has no "delete N after stop". Section 3.9.
4. **Repository credentials are not mounted during the move.** The PRD's step
   4 creates the v2 sandbox "with the conversation's repository credentials".
   Today credentials belong to the acting principal and are mounted by the
   repository path, and every generation bump clears
   `credential_principal_key`. The move leaves the v2 sandbox with no
   credentials; the existing mount path adds them on first use and confirms
   them applied. This keeps one mount path.
5. **The commit is not `replaceGeneration`.** That operation deletes
   `terminal_imported_resources` for the old generation and the old sandbox is
   deleted before it runs. A move must create first, keep the import rows (the
   files are still there, and an empty set reads as "nothing was revoked") and
   keep the repository bootstrap mark. Section 5.4 adds one storage operation
   for it. The shape (reserve, build, commit, fenced cleanup) is still the
   generation transition the PRD asked to reuse.
6. **The cleanup intent needs its own columns.** Today's intent is
   `failure_code` on a row whose `sandbox_id` is still the sandbox to delete.
   After a move `sandbox_id` names the v2 sandbox, so the v0 id needs a second
   slot.
7. **A move that ran out of time is not retried on every acquisition.** The
   PRD says "the next acquisition tries again". For a workspace too large to
   move inside the budget, that spends the whole budget on every tool call.
   Section 5.5.
8. **The v0 snapshot keeps being rebuilt until v0 code is deleted.** The PRD
   stops it at phase 2. Rolling the new-sandbox switch back needs a current v0
   snapshot.
9. **Logs are read with `logs({ cursor })`, not `streamLogs({ cursor })`.**
   Rally reads output only after the command ends. Paged reads resume from a
   cursor the same way and do not need a streamed response in workerd.

## 3. Architecture (option A)

### 3.1 Module layout

```
apps/api/src/services/terminal/
  provider-contract.ts        unchanged home of TerminalSandboxProvider
  daytona-provider.ts         v0 adapter, now built on `new Daytona().v0`
  daytona-v2-provider.ts      new: the only file that imports v2 types
  provider-set.ts             new: kind -> provider, lazy, disposable
  provider-migration.ts       new: the move, as one function over two providers
```

`@daytona/sdk` goes from `^0.204.0` to exactly `2.0.0`. Its README still calls
the package alpha, so it is pinned without a caret. The root client is the
only way to build either namespace client (`README.md`, "The root client is
the only way to build a client").

### 3.2 How the row selects the adapter

`TerminalSandboxRecord` gains `provider: "daytona" | "daytona_v2"`, read from
the column that already exists. Nothing reads it today.

Selection happens when a provider session is opened, not per method:

- `SupportedTerminalConfiguration` gains an optional `v2` block
  (`apiKey`, `region`, `image`) and the two switches (section 3.10).
- `TerminalProviderRpcBinding.createSession(configuration, instrumentation, kind)`
  takes the kind. `TerminalProviderSessionTarget` builds the v0 or the v2
  adapter from it. Every method on the session keeps its signature, so the RPC
  contract, the callbacks and the measurement routing do not change.
- `provider-set.ts` exports `createTerminalProviderSet(binding, configuration, instrumentation)`
  returning `{ for(kind): TerminalSandboxProvider } & Disposable`. It opens at
  most one RPC session per kind, on first use, and disposes both.
- The seven call sites that build a client today (`plugin.ts`, `webhook.ts`,
  `canvas-build-service.ts`, `workspace-schedule-execution.ts`,
  `agent-loop-do.ts`, `routes/workspace.ts`, `workstream-state.ts`) take the
  set and call `set.for(row.provider)`. `TerminalSandboxCoordinator` resolves
  the provider once per acquisition from the row it claimed.
- A row whose kind has no configuration fails by name:
  `TerminalProviderError(..., "terminal_provider_unconfigured:daytona_v2")`.

Deploy order matters once: the provider Worker must be deployed before an API
Worker that asks for `daytona_v2`. An older provider Worker ignores the extra
argument and would build a v0 client. With both switches off no caller asks
for v2, so the pull request's own deploy is safe in either order; the first
switch flip is a later deploy.

### 3.3 Provider contract changes

Kept as is: `createSandbox`, `prepareSandbox`, `getSandbox`, `startSandbox`,
`stopSandbox`, `deleteSandbox`, `updateNetworkPolicy`, `readFile`, `openFile`,
`writeFile`, `runUtilityCommand`, `runCommand`, `cleanupCommand`,
`clearGitHubReadAccess`.

Changed:

- `archiveSandbox` and `recoverSandbox` become optional, like `prepareSandbox`
  and `openFile` already are. The v2 adapter has neither. `lifecycle.ts`
  schedules no archive deadline when `archiveSandbox` is absent. The
  coordinator's recover branch is reached only when a snapshot says
  `recoverable: true`, which v2 never reports.
- `configureGitHubReadAccess` takes `TerminalSandboxWaitOptions` so the v2
  apply wait has the caller's deadline.

Added:

- `confirmNetworkPolicy(idOrName, expectedDomains, options?)` returning
  `{ status: "applied" | "pending" | "failed" }`. This is the one primitive
  worth decomposing out. Today the same "read back, sort, compare" is written
  four times: `prepareSandbox` in the adapter, `prepareReservedSandbox` and
  `reconcileNetworkPolicy` in the coordinator, and the walk in `settings.ts`.
  The v0 adapter implements it as that read-back. The v2 adapter implements it
  from applied state. Callers stop knowing which.
- `uploadFile?(idOrName, path, stream, signal)`: a streamed write, the mirror
  of `openFile`. Only the move uses it.

`TerminalSandboxSnapshot` is unchanged. On v2 `domainAllowList` is the desired
policy's `allowDomains`, and `recoverable` is always undefined.

State mapping in the v2 adapter:

| v2 state                                                              | `TerminalSandboxState` |
| --------------------------------------------------------------------- | ---------------------- |
| `started`                                                             | `running`              |
| `stopped`, `paused`                                                   | `stopped`              |
| `queued`, `creating`, `starting`, `pausing`, `stopping`, `destroying` | `starting`             |
| `destroyed`                                                           | `expired`              |
| `error`                                                               | `failed`               |
| `unknown` and anything else                                           | `unknown`              |

`error` with no recoverability verdict takes the existing row in the
acquisition table: preserve the identity and return unavailable. That can
leave a conversation stuck until a person starts fresh. It is the failure we
notice, and which v2 signal establishes loss is an open question.

### 3.4 Waits and deadlines

v2 waits ride a shared WebSocket by default. In a runtime that cannot unref
it, it closes 10 s after the last wait, and the server allows 10 ticket mints
a minute per credential (`events.d.ts`, `DEFAULT_IDLE_CLOSE_WITHOUT_UNREF_MS`).
Many isolates share one key, so the hub is a rate-limit risk in Workers.

**The adapter does not use the hub.** It builds the client with
`events: { enabled: false }` (`types.d.ts`, `SandboxEventsConfig`). With the
hub disabled, `waitForSandboxState` in `sandboxWait.js` runs a plain HTTP
long-poll loop in slices of at most 30 s (`WAIT_FOR_STATE_SLICE_MS`). No
socket, no tickets. Long-held fetches are ordinary in workerd, but this exact
loop is **unproven** there; the acceptance probe in section 6 runs it from a
deployed Worker.

What failure looks like: a wait that runs out throws `RequestTimeoutError`
(408). The coordinator already treats a failed start as "ask again":
`resumeProviderSandbox` re-observes on every path. Nothing new is needed.

Deadline conversion gets simpler. `start({ timeoutSeconds })` takes fractional
seconds and its budget is the wait's alone, so the "spent twice" paragraph in
`terminal-workspaces.md` goes for v2 rows. One rule stays: `0` means "wait
forever", so a deadline already reached passes the smallest positive value
and relies on the re-observation. `create` takes whole `waitSeconds`; the
adapter passes `waitSeconds: 0` and then waits with the fractional budget.

`DAYTONA_REQUEST_TIMEOUT_MS` (120 s, existing) becomes
`requestTimeoutSeconds: 120`. No new number.

### 3.5 Network policy

- Create passes `networkPolicy: { allowDomains }` for Trusted only and omits
  it for Full internet. `allowDomains` implies default deny
  (`README.md`, "Network policy").
- `updateNetworkPolicy` reads `getNetworkPolicy()` for the etag, then calls
  `sandbox.updateNetworkPolicy(input, { ifMatch })`, or
  `resetNetworkPolicy({ ifMatch })` for Full internet. The SDK does not
  re-read or retry on a stale etag. On `PreconditionFailedError` the adapter
  reads once more: if desired already equals what it was writing, it is done;
  otherwise it throws and the caller's existing failure path runs.
- `confirmNetworkPolicy` on v2 has two levels, because the applied policy is
  tied to a sandbox start (`appliedStartId`):
  - **accepted**: desired equals expected. This is all a stopped sandbox can
    show. The workspace policy walk requires it for stopped sandboxes.
  - **applied**: `appliedRevision === desiredRevision`, `status` is
    `applied`, and applied `allowDomains` equals expected. Every path that
    admits work requires it.
- Acquisition calls `confirmNetworkPolicy` after every transition into
  running that it performed itself: create, start, and policy reconcile. A
  healthy running sandbox whose row revision matches is reused with no extra
  request, as today. `pending` is polled until the acquisition deadline;
  `failed`, or `pending` at the deadline, stops the sandbox and returns
  `network_policy_unverified`, as a mismatch does today.
- Whether an update to a running sandbox applies live or only at the next
  start is **unproven**. The existing flow stops before the write and starts
  after, so it is correct either way.
- `TERMINAL_NETWORK_MAX_TARGETS` stays 20 for both providers during the
  overlap, because one workspace policy must fit both. v2's own limit and its
  support for `*.` wildcards in `allowDomains` are open questions; the
  acceptance probe already exercises a wildcard baseline host.

### 3.6 Secrets

v2 secrets are project secrets attached to a sandbox by name
(`Secret.d.ts`, `Sandbox.d.ts`):

- `daytona.v2.secrets.set(name, value, { allowedDomains })`, with the same
  two per-sandbox secrets as today: Git basic for `github.com`, API token for
  `api.github.com`.
- `sandbox.replaceSecrets([names], { ifMatch })`, then poll `getSecrets()`
  until `appliedRevision === desiredRevision` and `status` is `applied`.
  `failed` throws `TerminalProviderError(..., "secrets_apply_failed")`. The
  provider's `error` text is never put in the code or the message that
  crosses the hop.
- "Running processes keep their environment; processes started afterwards see
  the new names" (`Sandbox.d.ts`). So the stop and start that
  `configureGitHubReadAccess` does on v0 when it attaches a new secret goes
  away.

One gap. v0 maps an env name to a secret name
(`updateSecrets({ GH_TOKEN: name })`). v2 attaches names only, so the sandbox
sees the secret under its own per-sandbox name, not as `GH_TOKEN` or
`GITHUB_READ_BASIC`. The v2 adapter's command wrapper, which already sources
`/workspace/.rally/session.env`, exports the two fixed names from the
per-sandbox ones when they are set. This assumes the sandbox sees a secret as
an environment variable holding a placeholder the proxy substitutes, as v0
does. **Unproven**, and an open question.

Teardown order flips: the API refuses to delete a secret a sandbox still
references (`gen/api.d.ts`, `delete_secret`). Clear with
`replaceSecrets([])` first, or delete the sandbox first, then delete the
secrets. Deleting the sandbox never waits on secret cleanup, as today.

`secrets_per_project` is a limit in `gen/api.d.ts`. Two secrets per sandbox
with a repository can reach it. It surfaces as `LimitExceededError`.

### 3.7 Commands

`runUtilityCommand` becomes one call:
`process.run(command, { cwd, executionTimeoutSeconds, timeoutSeconds, tag })`.
stdout and stderr come back separately (spike). The server kills the process
tree at `executionTimeoutSeconds`. The `timeout` wrapper and the
`AVALON_COMMAND_TIMED_OUT` marker are deleted from the v2 path. Cancellation
today stops and restarts the whole sandbox; on v2 it is
`process.killAll({ tag })`, falling back to stop and start only when the
sandbox has no process containment (`UnsupportedOperationError`,
`Process.d.ts`).

`runCommand` is the durable one. Its recovery contract maps like this:

| Today (v0 session)                                                 | v2                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Session named `avalon-task-<effectIntentId>`                       | `process.start(command, { name, tag: name, keepLogs: 'until_cleanup', executionTimeoutSeconds })`                            |
| `getSession` to learn whether a command was already submitted      | `process.list({ tag: name, state: 'all' })`                                                                                  |
| More than one command, or a different command text, in the session | More than one tagged process, or `ProcessInfo.shellCommand` differs                                                          |
| Lost `createSession` response resolved by reading the name         | Lost `start` response resolved by the same list; a duplicate live name is refused with `NAME_CONFLICT`                       |
| `assertSubmissionAuthority` before every submission                | Unchanged, before `start`                                                                                                    |
| `onSubmitted(cmdId)` writes `provider_task_id`                     | `onSubmitted(handle.id)`                                                                                                     |
| Poll `getSessionCommand` with backoff                              | `handle.wait({ timeoutSeconds })` in a loop; a wait that expires returns `reason: 'timed_out'` and the process keeps running |
| `getSessionCommandLogs`, restarted from scratch on retry           | `handle.logs({ cursor })` pages, split by `frame.channel`, resumed from the last cursor                                      |
| `cleanupCommand` deletes the session; 404 is `missing`             | `handle.delete()`; `PROCESS_NOT_FOUND` is `missing`                                                                          |

`MAX_STREAMED_COMMAND_LOG_BYTES` and the observation deadline keep their
existing values. `timedOut` is read from the process `reason`; the exact value
for a server-side deadline (`PROCESS_EXECUTION_TIMEOUT` exists in `codes.d.ts`)
must be pinned in the acceptance probe.

The lifecycle rule "removing a session is not quiescence; stop the whole
sandbox" stays as it is in this pull request. `killAll` may make it
unnecessary later; that is a separate change.

### 3.8 Files in Workers

| Contract     | v2 call                                                                                             | Note                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `readFile`   | `fs.readBytes(path)`                                                                                | Whole file in memory, as today                                                                       |
| `writeFile`  | `fs.writeBytes(path, bytes)`                                                                        | The fs API is `readBytes`/`writeBytes`/`readText`/`writeText` (`FileSystem.d.ts`)                    |
| `openFile`   | `fs.presignedDownloadUrl(path, { expiresInSeconds: 120 })` then `fetch(url, { redirect: "error" })` | Same shape and same 120 s as v0. `downloadFile` is Node only                                         |
| `uploadFile` | `fs.presignedUploadUrl(path)` then a streamed `POST`                                                | `uploadFile` in the SDK is Node only. The request body the signed upload URL expects is **unproven** |

### 3.9 Lifecycle on v2 (assumes persistent Linux)

- **Canvas.** Rally's alarm stops at 5 idle minutes and deletes at 30 days, as
  today. The 60 minute archive step does not exist for a v2 row. Daytona's 15
  minute auto-stop backstop is gone unless persistent Linux gains an idle
  `stop` action.
- **Sidekick.** No sweep reaches it today; Daytona retires it. On v2 the
  conversation's own object already wakes every 60 s for a running sandbox
  and every 10 minutes for a stopped one (`terminal_observation`). The same
  entry calls `reconcileDueTerminalSandbox` for a v2 row the workspace sweep
  does not reach, using the row's existing `idle_expires_at` and
  `expire_due_at`. That makes retention one primitive for both parents. The
  Sidekick idle window stays the existing 15 minutes.
- **Observation.** The v2 SDK exposes no webhook API. v2 rows rely on the
  periodic check, which already bounds staleness when a webhook is missed.
  `POST /ingest/daytona` keeps serving v0 rows and ignores an id it cannot
  find.

What persistent Linux must provide for this section to hold is listed in the
open questions.

### 3.10 Configuration and secrets

| Name                            | Kind          | Meaning                                                                        |
| ------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `DAYTONA_V2_API_KEY`            | Worker secret | v2 project key. The v0 key is refused by v2 (probe: 401). Never a `VITE_` name |
| `DAYTONA_V2_REGION`             | var           | Per-create `region`, replacing `DAYTONA_TARGET`                                |
| `DAYTONA_V2_TERMINAL_IMAGE`     | var           | The adopted v2 image name, written by the weekly workflow                      |
| `TERMINAL_NEW_SANDBOX_PROVIDER` | var           | `daytona` (default) or `daytona_v2`                                            |
| `TERMINAL_V2_MIGRATION`         | var           | `off` (default) or an operator-chosen token; section 5.5                       |

`parseTerminalRegionConfiguration` throws when a switch asks for v2 and a v2
value is missing, as it throws on any other invalid value. `env.ts` and
`scripts/sync-dev-env.mjs` list the new names.

`DAYTONA_V2_API_URL` is read by the SDK from the process environment only,
never from the config object (`clientConfig.js`). The provider Worker receives
its configuration over RPC and has no variables of its own. If Daytona says a
regional endpoint is needed, it is a variable on `wrangler.terminal.*.jsonc`.
The default is `https://api.daytona.com`.

Sandbox size moves from the snapshot to the create call: v2 `create` takes
`resources`. Units differ: v2 `cpu` is cores and one core is two vCPUs
(`types.d.ts`, `Resources`), so today's 2 vCPU is `cpu: 1`.

### 3.11 Image build and acceptance

v2 "snapshots" are memory snapshots. The owned Terminal snapshot becomes a v2
image.

- `build-terminal-snapshot.ts` gains a v2 leg:
  `daytona.v2.images.build(ImageBuilder.fromRegistry(base).env(...).runCommands(...), { name, region })`,
  then `images.get(id, { wait: 'ready', timeoutSeconds })`, with
  `followBuildLogs` for the log. Same manifest commands, same build-time
  stamp. An image is built in one region and boots only there
  (`Daytona.d.ts`, `createFromBuild`).
- `verify-terminal-provider.ts` already drives a `TerminalSandboxProvider`. It
  takes a provider kind and runs the same gate against the v2 adapter. The
  restart check uses stop and start.
- `rebuild-terminal-snapshot.yml` runs both legs and adopts each
  independently, so a red v2 leg does not block v0 adoption while v2 is off,
  and the reverse after the flip. It needs `DAYTONA_V2_API_KEY` in the
  `api-production` environment.
- A second probe, deployed as a Worker route in a test deployment, runs
  create, wait, command, stop, start, policy update and delete through the
  provider Worker. It is the only proof for everything marked unproven.

### 3.12 Error mapping

`terminalProviderErrorCode` already builds `name:statusCode:code`, and v2
errors carry `statusCode` and `code` (`README.md`, "Errors"). So
`NotFoundError:404:NOT_FOUND` and `PreconditionFailedError:412:...` need no
work. Additions:

- `LimitExceededError`: append its `limit` name (a declared field, shaped by
  `codeShaped`), for example `LimitExceededError:429:LIMIT_EXCEEDED:max_sandboxes`.
  This is how we will notice quota.
- `SandboxNotRunningError` (409) from a toolbox call becomes
  `TerminalProviderError(..., "sandbox_not_running")`. It is not absence; only
  the metadata lookup establishes absence, as today.
- `SandboxCreateRequestTimeoutError` and `SandboxCreateConnectionError`: the
  adapter repeats the identical create once. Create by name is a permanent
  get-or-create (`README.md`), so the coordinator's "look up by stable name"
  fallback is not needed for v2 rows.
- `traceId` is logged as its own field for Daytona support. Messages never
  cross as codes.
- Move failures are `terminal_v2_migration_failed:<step>:<reason>`, where the
  reason is one of the codes above or Rally's own.

### 3.13 Schema migration

One new `AgentLoopDO` migration, the next version after 89. SQLite cannot
alter a `CHECK`, so `terminal_workspace` is rebuilt per
[`durable-object-sqlite.md`](../../durable-object-sqlite.md): create the
replacement, copy with an explicit column list, drop, rename, all with
foreign keys on.

- `provider` becomes `CHECK (provider IN ('daytona', 'daytona_v2'))`.
- New nullable columns: `pending_provider`, `pending_sandbox_id` (the v2
  sandbox being built), `retired_provider`, `retired_sandbox_id` (the v0
  sandbox awaiting delete), `migration_blocked_token`.
- A table check that each pair is set or null together.

No table references `terminal_workspace` by foreign key. The implementer must
list every view and trigger that names it before the drop (the runtime compat
schema writes `'daytona'` into it) and recreate them after. Existing rows keep
`'daytona'`; no backfill. `reserveFirstGeneration` takes the provider instead
of the literal. The fingerprint test moves forward one line.

## 4. Flip-over plan

### 4.1 The switches

Per region, in the region's wrangler config:

1. `TERMINAL_NEW_SANDBOX_PROVIDER`: which provider a sandbox created from
   nothing uses. Read wherever a generation is reserved with no sandbox: first
   use, replacement of a lost sandbox, authority replacement.
2. `TERMINAL_V2_MIGRATION`: whether acquisition moves a v0 sandbox it finds.

Both are plain variables, not Flagship flags. They are per region, change by
deploy, and nobody outside engineering turns them. This matches how a region
opts into Terminal today.

### 4.2 Order

| Step | Action                                                                          | Roll back                                   |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| 0    | Merge. Deploy provider Worker, then API. Both switches off                      | Revert the merge                            |
| 1    | Add the v2 key, region and image. Weekly workflow builds and gates the v2 image | Remove the values                           |
| 2    | Run the deployed-Worker probe                                                   | None needed                                 |
| 3    | `TERMINAL_NEW_SANDBOX_PROVIDER=daytona_v2` in one region, then all              | Set it back to `daytona`                    |
| 4    | `TERMINAL_V2_MIGRATION=<token>` in one region, then all                         | Set it back to `off`                        |
| 5    | Drain reaches zero                                                              | Not reversible; see 4.5                     |
| 6    | The removal pull request (section 8)                                            | Revert it before any narrowed `CHECK` ships |

**A deploy with both off** changes one thing a person could reach: the v0
adapter now runs on the SDK's vendored 0.x through `daytona.v0`. Behavior is
meant to be identical and the v0 acceptance gate proves it before merge. The
schema migration runs on each object's next wake. No request goes to v2.

### 4.3 Rolling back and what it does to v2 sandboxes

- **Switch 1 back to `daytona`.** New sandboxes are v0 again. Rows already on
  `daytona_v2` keep working, because the row picks the adapter, not the
  switch. Nothing is moved back. There is no v2 to v0 move.
- **Switch 2 back to `off`.** No new move starts. A move in flight finishes or
  fails back. A recorded `pending_sandbox_id` is deleted by the next
  acquisition; a recorded `retired_sandbox_id` is still deleted.
- **Removing the v2 key while v2 rows exist.** Those conversations fail with
  `terminal_provider_unconfigured:daytona_v2`. Files stay at Daytona. Putting
  the key back restores them. Do not do this as a rollback.
- **`TERMINAL_EMERGENCY_DISABLED`** stops both providers, as today.

### 4.4 Measuring drain

`daytona.v0.list()` filtered to sandboxes carrying `rally.workspace`, the same
iteration `ensure-daytona-webhook.ts` already does. A small script prints the
count and the oldest. The provider is the authority because rows live in each
conversation's object. Drain is done when the count is zero. Rally's own logs
give the other side: `terminal_v2_migration_committed` and
`terminal_v2_migration_failed` per conversation.

### 4.5 After drain

The switches are deleted with the v0 code. From then on rollback is a revert
of the removal pull request, which only works until the `CHECK` narrows.

## 5. The move, step by step

Runs inside `acquire`, after the ordinary path has made the v0 sandbox
running, under the operation lease the acquisition already holds.

### 5.1 Preconditions

All must hold, else acquisition proceeds on v0 with no log:

- `TERMINAL_V2_MIGRATION` is a token and differs from the row's
  `migration_blocked_token`.
- `row.provider` is `daytona`, the sandbox is running, and v2 is configured.
- The run is a primary run. A background agent never replaces shared files;
  same rule as authority replacement.
- No unsettled task exists for the generation.

### 5.2 Steps, state, and interruption

| #   | Step                                                                                                                             | Durable state after it                                                                     | Interrupted or failed here resolves to                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | If `pending_sandbox_id` is set from an earlier attempt, delete it on v2 and clear it                                             | Pending columns null                                                                       | Next attempt repeats this step                                                                                                                                                                                                                                                                               |
| 2   | Preserve a final diff with the existing preserver                                                                                | `final_diff_resource_id`, as a stop writes it                                              | Row still v0. Nothing to undo                                                                                                                                                                                                                                                                                |
| 3   | Pack on v0: `tar` of `/workspace` to a file outside it, and its SHA-256                                                          | None                                                                                       | Row still v0. A leftover archive file is removed by the next attempt                                                                                                                                                                                                                                         |
| 4   | Create the v2 sandbox by the conversation's stable name, labels carrying `generation + 1`, current policy, `AVALON_RESOURCE_DIR` | None yet                                                                                   | Create by name is get-or-create: the next attempt gets the same sandbox back. If the policy changed in between, the name answers 409; the attempt fails as `create:ConflictError:409:...` and step 1 of a later attempt cannot see it, so this one case also looks the name up with `findByName` and deletes |
| 5   | Record `pending_provider`, `pending_sandbox_id`, fenced on generation                                                            | Pending columns set                                                                        | Step 1 of the next attempt deletes it                                                                                                                                                                                                                                                                        |
| 6   | `prepareSandbox`, then `confirmNetworkPolicy` until `applied`                                                                    | Unchanged                                                                                  | Fail back                                                                                                                                                                                                                                                                                                    |
| 7   | Stream the archive: v0 `openFile` into v2 `uploadFile`. Never stored, never logged                                               | Unchanged                                                                                  | Fail back                                                                                                                                                                                                                                                                                                    |
| 8   | On v2: check the SHA-256, empty `/workspace`, unpack, run the restore probes (`assertTerminalSandboxReady`)                      | Unchanged                                                                                  | Fail back. Unpack replaces the directory, so a half-filled sandbox reused by a later attempt is harmless                                                                                                                                                                                                     |
| 9   | **Commit**, one object transaction (5.4)                                                                                         | Row is `daytona_v2`, new sandbox id, `generation + 1`, retired columns name the v0 sandbox | Before the transaction: fail back. After it: the move is done; only cleanup remains                                                                                                                                                                                                                          |
| 10  | Delete the v0 sandbox with `deleteTerminalSandbox` on the v0 provider, then clear the retired columns                            | Retired columns null                                                                       | Every later acquisition, and the observation alarm, retries first. It never fails the tool call. The sandbox is confirmed gone by delete or by a metadata 404                                                                                                                                                |

A v0 Canvas sandbox has no provider auto-delete, so step 10's intent is what
stops an orphan living forever. The drain count also shows any that slip.

### 5.3 Failing back

Before step 9 the row has not changed. Fail back means: delete the pending v2
sandbox if one is recorded (best effort; step 1 covers a failed delete), log
`terminal_v2_migration_failed:<step>:<reason>` with the conversation and
generation, and carry on with the v0 sandbox the acquisition already made
ready.

If the failure was the acquisition deadline, there is no time left to run the
tool. The call returns the existing retryable `sandbox_unavailable`, and the
retry runs on v0.

### 5.4 The commit

One new storage operation, `commitProviderMigration`, in a single
`transactionSync`, fenced on `generation`, `sandbox_id` (the v0 id) and
`pending_sandbox_id`:

- `provider`, `sandbox_id` from the pending columns; pending columns cleared.
- `generation + 1`, `lifecycle_state = 'running'`, deadlines refreshed.
- `retired_provider`, `retired_sandbox_id` set to the v0 values.
- `terminal_imported_resources.sandbox_generation` moved to the new
  generation. The files they describe moved with the archive.
- `terminal_repository.bootstrapped_sandbox_generation` moved too, so the
  checkout is not cloned again over uncommitted work.
- `credential_principal_key` and `read_token_expires_at` cleared, so the next
  repository use mounts credentials on v2. The implementer must confirm in
  `repository.ts` that a bootstrapped generation with an expired read token
  re-mounts without re-cloning.
- `authority_fingerprint` and `applied_network_revision` unchanged.

It is listed in `TERMINAL_OPERATIONS` and is directory-affecting.

### 5.5 A workspace that cannot move in time

The archive has no size cap (PRD decision 6). A workspace too large for the
budget would fail at step 3 or 7 on every acquisition and cost every tool call
the full budget. So a failure whose reason is the deadline records the current
`TERMINAL_V2_MIGRATION` token in `migration_blocked_token`. That row is not
tried again until an operator changes the token. No interval, no count: the
retry is an operator's act, and the number of blocked rows is visible in logs
and in the drain count. Every other failure retries on the next acquisition,
as the PRD says.

Whether the move should have a budget of its own, longer than a tool call's,
is the team's number to set. Until it is set the move uses the acquisition
deadline.

### 5.6 The workspace network-policy walk during the overlap

`policyTarget` returns the row's `provider` with the sandbox id. The walk in
`settings.ts` uses `set.for(provider)` per sandbox and
`confirmNetworkPolicy` for the read-back.

- v0 row: unchanged.
- v2 row, running: cancel tasks, final diff, stop, update, confirm
  `accepted`. Same steps as v0.
- v2 row, stopped: update, confirm `accepted`. `applied` is confirmed by the
  next acquisition after its start.
- Row's provider not configured: the step fails as
  `policy_transition:provider:terminal_provider_unconfigured`, the row gets
  applied revision 0, and the change still lands for the organization.
- A move in flight during a walk: the walk writes the v0 sandbox the row
  names. The v2 sandbox was created with the revision the acquisition read.
  The acquisition's existing last check ("policy changed during startup")
  sees the new revision, stops the sandbox and returns
  `network_policy_unverified`; the next acquisition reconciles the v2 sandbox
  and confirms `applied`. No sandbox is admitted on the old policy.
- A Sidekick's sandbox is not walked, as today. It converges at its next
  acquisition.

## 6. Test plan

Per [`testing.md`](../../testing.md). No test reads a workflow or wrangler
file.

**Real workerd (`apps/api/test-workers/`).** Each is proved able to fail by
one production edit, once per behavior.

| Test                                                                                                                                                                                                                    | Break that must turn it red                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Populated object at schema 89 upgrades: rows retained, `provider` accepts `daytona_v2`, `foreign_key_check` clean. Fixture and upgrade in separate object events                                                        | Drop a column from the copy list                                                                 |
| `commitProviderMigration` moves provider, sandbox id, generation, import rows and bootstrap mark in one commit, and is refused on a stale generation or a different pending id                                          | Remove the fence predicate; skip the import update                                               |
| Session target builds the adapter for the kind it was opened with, and every method still routes its `observeRequest`                                                                                                   | Ignore the kind argument                                                                         |
| The move against two injected providers (Daytona cannot run here): commit on success; row untouched and pending sandbox deleted on a failure at each of steps 4, 6, 7, 8; retired sandbox retried after a failed delete | Commit before the checksum; drop the pending record; clear the retired columns before the delete |
| A deadline failure records the token and the next acquisition does not attempt; a changed token does                                                                                                                    | Skip the token write                                                                             |
| Policy walk picks the adapter from the row's provider                                                                                                                                                                   | Use one provider for all rows                                                                    |
| Sidekick v2 row is stopped and expired by its own object's alarm                                                                                                                                                        | Skip the reconcile call                                                                          |

**Node, real migrations.** Query mapping for the new columns.

**Node, capability double for the SDK client** (the double stands in for
Daytona, which cannot run here): state mapping, the etag retry, applied
against accepted, the secrets apply poll, the command recovery table in 3.7,
error codes including `LimitExceededError`'s limit name, and that the client
is built with `events.enabled === false`. Assertions are on the adapter's
returned values and thrown codes against literals.

**Only against real Daytona.**

- The v0 gate after the SDK swap, before merge.
- The v2 gate, weekly: create with policy, applied confirmation, egress
  allowed and denied, wildcard host, command with separate stderr, server
  deadline kills the tree, stop and start keep `/workspace`, delete.
- From a deployed Worker: long-poll waits with the hub off, `logs` paging,
  presigned download stream, presigned upload stream, the Worker bundle size
  against the platform script limit, and that secrets appear under the alias.
- One real move of a seeded v0 sandbox in a test organization, checksum and
  a `git status` compared before and after.
- `pause`, `resume` and `fork` timings for PRD goal 6, once Linux supports
  them.

## 7. Risks

1. **The assumption in section 1 is false or late.** Then this design is not
   built and B needs its own PRD.
2. **SDK 2.0.0 in workerd is unproven**: axios transport, bundle size with the
   vendored v0, long-poll waits, streamed upload. The deployed-Worker probe
   gates the first switch.
3. **The SDK is labelled alpha** in its own README. Pinned exactly; an upgrade
   is a reviewed diff with the gate rerun.
4. **Drain never reaches zero** because some workspaces are too large to move
   and are used often enough never to expire. Visible as blocked rows; needs a
   decision then, not now.
5. **A stuck `error` sandbox** on v2 has no recoverability verdict and is
   never replaced automatically.
6. **Stopped v2 sandboxes may cost more than archived v0 ones** for up to 30
   days each.
7. **Secret alias and wildcard domains** rest on inference from v0 behavior.
8. **Two adapters double the lifecycle surface** until the removal pull
   request. The overlap is bounded by drain, which risk 4 can stretch.

## 8. Work breakdown

**Can land today, on v0, independent of section 1:**

- `confirmNetworkPolicy` on the contract with the v0 read-back
  implementation, replacing the four inline comparisons. No behavior change.

**The single pull request, when option A is confirmed, in commit order:**

1. PRD decision-log entries for section 2; tick `in progress` in `state.md`.
2. `@daytona/sdk@2.0.0`; v0 adapter and the four scripts onto `daytona.v0`.
   v0 gate green.
3. Schema migration, `provider` on the record, `reserveFirstGeneration`
   parameter, workerd upgrade test.
4. Configuration: v2 block, two switches, `env.ts`, `sync-dev-env.mjs`.
5. `provider-set.ts`, session kind across the RPC hop, call sites.
6. Contract changes: optional archive and recover, `uploadFile`, wait options
   on credential mount; lifecycle skips archive when absent.
7. `daytona-v2-provider.ts` with its Node tests.
8. Sidekick retention through the conversation's alarm for v2 rows.
9. Policy walk by row provider.
10. `provider-migration.ts`, `commitProviderMigration`, the acquisition hook,
    retired-sandbox cleanup, workerd tests.
11. v2 image build, parameterized acceptance gate, deployed-Worker probe,
    workflow legs, drain script.
12. `terminal-workspaces.md` (behavior, data model, operations, one changelog
    entry), `runbook.md` flip steps, `dev-environment.md` variables.

**The later removal pull request**, after drain is zero: delete
`daytona-provider.ts`, the v0 snapshot leg, `webhook.ts` with its route and
`ensure-daytona-webhook.ts`, the v0 configuration and both switches, the
provider set (one provider again), the move and its columns; narrow the
`CHECK` to `daytona_v2` in a new migration; tick `completed`.

## 9. What changes under option B

Only if Daytona rules out persistent Linux. Not designed here; these are the
parts of this document that would not survive:

- 3.9 is replaced. Stop becomes delete sandbox; restore becomes create with
  the volume mounted at `/workspace`; expiry deletes the volume.
- The row's identity splits: generation follows the volume, and the sandbox
  id becomes null while idle. New lifecycle meaning for `stopped`.
- Cleanup intents cover two resources.
- The policy walk has nothing to do for an idle conversation.
- The move copies into a volume; steps 3 to 8 stand.
- The PRD must say that everything outside `/workspace` is lost at every idle
  stop, and the 100 volume limit must be raised first.

## 10. Open questions

For Daytona:

1. Does Daytona plan persistent Linux sandboxes on v2 (stop and start keeping
   the disk), and when? With an idle `stop` lifecycle action?
2. Can the project limits of 100 disk volumes and 1000 snapshots be raised to
   one per Canvas and Sidekick, and what do a volume and a snapshot cost?
3. Is v2 a separate platform from v0? Are v0 sandboxes, snapshots and
   webhooks reachable from v2 at all? (The v0 key answers 401 and the API
   hosts differ.) If they are reachable, section 5 is not needed.
4. Does v2 have signed webhooks for sandbox state?
5. What does a stopped persistent sandbox cost, given there is no archive?
6. What does `error` mean on v2, and which signal says the files are gone?
7. What does the non-disablable lifecycle timeout do to a persistent Linux
   sandbox by default, and does it run while stopped?
8. How does a process see an attached secret: an environment variable named
   after the project secret? Can the name differ? What is
   `secrets_per_project`?
9. v2's limit on `allowDomains` entries, and whether `*.` wildcards work.
10. Does a policy update apply to a running sandbox, or at the next start?
11. What request body does a presigned upload URL expect?
12. Is 0.x end of life dated?
13. Is a regional `DAYTONA_V2_API_URL` needed for `us`, and which v2 region
    matches today's `DAYTONA_TARGET`?

For the team:

14. If A is not coming: is losing everything outside `/workspace` at every
    idle stop acceptable (option B)?
15. Should the move have its own time budget, and what is it?
16. Is "blocked until an operator changes the token" the right rule for a
    workspace that cannot move in time?
17. Keep `TERMINAL_NETWORK_MAX_TARGETS` at 20 for both providers during the
    overlap?
18. Who owns the deploy order guarantee (provider Worker before API)?
