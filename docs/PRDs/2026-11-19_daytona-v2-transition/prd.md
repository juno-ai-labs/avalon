# Daytona v2 transition

> Created 2026-11-19.
>
> Moves Terminal's sandboxes from Daytona's 0.x interface to its v2 interface,
> and says what happens to every sandbox that exists on 0.x when the move
> starts. The adapter, lifecycle and network policy it changes are
> [`terminal-workspaces.md`](../../terminal-workspaces.md)'s. Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Terminal runs every Canvas's and Sidekick's sandbox through Daytona's 0.x SDK.
Daytona has shipped SDK 2.0.0 with a new v2 interface beside the old one. v2
reports whether a network policy and a secret actually took effect, returns a
command's stderr apart from its stdout, kills a command's whole process tree at
a server-side deadline, makes create a true get-or-create, and adds `pause()`
and `fork()`, which may make opening a Terminal faster.

This PRD moves Terminal to v2 in four phases: a spike that settles what we do
not know, a v2 adapter beside the v0 one, new sandboxes on v2, then old
sandboxes moved or retired until v0 can be deleted. A person using a Canvas or
a Sidekick sees nothing, except that the first Terminal call on a Canvas whose
sandbox is being moved takes longer once, and any process left running in that
sandbox ends, as it would at a stop.

## Motivation

Nothing forces this today. We pin `@daytona/sdk` to `^0.204.0`, which can never
resolve to 2.x, and every workflow installs from the lockfile. Daytona says 0.x
keeps working and that it will announce an end date months ahead. So this is
worth doing for what v2 removes and adds, not for a deadline.

What it removes is code we wrote because 0.x could not tell us things:

1. **Egress proof.** After a create or a policy change we read the sandbox back
   and infer the allow list stuck. v2's `getNetworkPolicy()` reports desired
   against applied policy, apply status, and the sandbox start that received
   it.
2. **Secret proof.** v2's `getSecrets()` reports applied or failed per revision.
3. **Command output and timeouts.** 0.x's `executeCommand` has no stderr
   channel, so we hide a private timeout marker in stdout and strip it.
   v2's `process.run()` returns both streams and takes
   `executionTimeoutSeconds`, which kills the process tree.
4. **Retried reads.** We restart every log read from scratch so a retry cannot
   duplicate a prefix. v2's `streamLogs({ cursor })` resumes from a cursor.
5. **Lost creates.** We resolve a lost create response by looking the sandbox
   up by name. v2's create is a permanent get-or-create on name or idempotency
   key, and its timeout error carries that key.
6. **Wait budgets.** 0.x reads one number in whole seconds, treats `0` as
   forever, and spends it twice, on the start request and on the poll. The
   section of `terminal-workspaces.md` that explains our deadline conversion
   exists because of this. v2 gives each call its own budget in fractional
   seconds.

What it adds is `pause()`, which keeps memory, and `fork()`, which copies a
running sandbox. Opening a Terminal today boots from the snapshot and runs
bootstrap. Forking a warm sandbox, or resuming a paused one, may be faster.
Low latency is a goal, so that is worth measuring.

The longer we wait, the more Terminal code we write against 0.x that we will
later port.

## Goals

1. Every new Terminal sandbox, in every region with Terminal enabled, is a v2
   sandbox.
2. No sandbox that existed on 0.x loses a file under `/workspace` because of
   the transition. Its conversation keeps the same Terminal identity: the same
   row, a new generation.
3. A sandbox nobody uses during the transition is never restored just to be
   moved. It retires on its existing schedule.
4. The transition ends: a measurable point after which no v0 sandbox exists,
   and the v0 adapter, the v0 snapshot steps and the v0 webhook are deleted.
5. The network policy and secrets of a v2 sandbox are confirmed applied from
   the provider's own applied state, not inferred from a read-back.
6. The spike's measured `pause()`/`resume()` and `fork()` times decide whether
   either becomes part of how Terminal starts, and the decision is recorded
   here.

## Non-goals

1. **Moving anything outside `/workspace`.** Packages a person installed into
   the system, files in the home directory, and running processes do not
   move. The snapshot supplies the system; `/workspace` is the only directory
   Terminal promises to keep. Rejected.
2. **A participant-facing migration step.** No notice, prompt or setting. The
   transition happens inside acquisition, like a restore. Rejected.
3. **Adopting `fork()` or `pause()` in this PRD.** Goal 6 measures them; using
   them is a lifecycle change with its own decisions about cost and retention,
   and gets its own PRD if the numbers earn it. Deferred.
4. **Daytona macOS sandboxes, PTYs, computer use, volumes.** v2 has them;
   Terminal does not need them. Deferred.
5. **Running v0 and v2 side by side indefinitely.** Two adapters double every
   lifecycle and policy test. The overlap lasts until goal 4. Rejected.
6. **Staying on a self-hosted or custom Daytona API URL.** SDK 2.x targets
   Daytona Cloud only. We use Cloud. Rejected.

## Product behavior

Terminal's ten tools, their names and their results do not change.

**New sandboxes.** Once a region turns v2 on, the first Terminal call in a
Canvas or Sidekick that has no sandbox creates a v2 one. The participant sees
the same loading as today.

**A v0 sandbox nobody touches.** It retires exactly as it would have without
this change. A Canvas's sandbox stops after five idle minutes, archives after
sixty, and is deleted thirty days after its last use by Rally's own alarm. A
Sidekick's is stopped by Daytona after fifteen idle minutes and deleted thirty
days after that stop. Neither is restored to be moved.

**A v0 sandbox someone uses.** Use resets those clocks, so an active Canvas
would keep its v0 sandbox forever. Once migration is on, the next acquisition
that finds a v0 sandbox moves it:

1. Restores the v0 sandbox if it is stopped or archived, as acquisition does
   today.
2. Preserves a final diff, as a stop does today.
3. Packs `/workspace` into one archive inside the v0 sandbox and downloads it
   through a signed URL, which Workers can stream.
4. Creates the v2 sandbox under the conversation's reserved next generation,
   with the workspace's current network policy and the conversation's
   repository credentials, and confirms both applied.
5. Uploads and unpacks the archive into `/workspace`, then runs the same
   restore probes a recovery runs today.
6. Commits the new generation, records a cleanup intent for the v0 sandbox,
   and deletes it through the existing cleanup path.

The tool call that triggered it waits, as it waits for a restore today, and
then runs. Background processes in the old sandbox end. The repository
checkout, branch and uncommitted changes survive because they are files under
`/workspace`.

**When the move fails.** Before step 6 nothing has changed: the row still
names the v0 sandbox, which still holds every file, and the call falls back to
using it on v0. The failure is logged with a named code
(`terminal_v2_migration_failed:<step>:<reason>`) and the next acquisition tries
again. After step 6 the v0 sandbox is only cleanup, retried by the existing
intent until Daytona confirms it gone.

**A workspace network policy change during the overlap.** The policy walk
reaches each conversation's row and applies the policy through whichever
adapter the row's `provider` names.

## Impact on the product contract

None. This refines how Terminal reaches its provider within the existing
contract. Terminal still gives a conversation one private sandbox and never
asks a person to confirm a tool call.

## Key design decisions

1. **Migrate on acquisition, not in a sweep.** Only a sandbox someone is using
   needs to move; everything else retires on its existing schedule (goal 3).
   A sweep would restore archived sandboxes nobody will open again, paying for
   compute and risking their files to move data that is about to be deleted.
   Rejected.
2. **Reuse the generation transition.** Moving providers is the same shape as
   replacing a lost sandbox: reserve a generation, build the replacement,
   commit, then clean up the old one with a fenced intent. That path already
   survives interruption at every step. A separate migration state machine was
   rejected.
3. **Copy `/workspace`, not the snapshot.** The v2 sandbox boots from the v2
   image, built by the same weekly workflow from the same bootstrap. Only the
   person's files are theirs to keep.
4. **`provider` on the row decides the adapter.** `terminal_workspace.provider`
   already exists and is `CHECK (provider = 'daytona')`. It widens to allow
   `daytona_v2`. No second ownership table.
5. **Fail back to v0 before the commit.** A failed move leaves a working
   sandbox rather than a broken one, which is the failure a person would not
   notice and the next call repairs. Deleting the v0 sandbox before the v2 one
   is proven was rejected.
6. **The archive has no size cap in this PRD.** A cap would decide which
   people lose files. If a workspace is too large to move inside the
   acquisition budget, that budget's timeout is the failure we notice, and the
   cap, if one is wanted, is the team's number to set
   ([`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md)).

## Phases

Each phase lands on its own and can stop there.

**Phase 0: spike and answers.** Before any production change:

- Ask Daytona whether v0 sandboxes, snapshots and webhooks are reachable from
  the v2 API. If they are, the migration in Product behavior is not needed: a
  v0 sandbox is opened through v2 by id and this PRD shrinks to phases 1, 2
  and 4. Record the answer in the decision log.
- Ask whether one API key serves both namespaces, or v2 needs a project key.
- Ask whether v2 has signed webhooks like `POST /ingest/daytona` uses, and
  what its Trusted-only domain allow-list limit is (0.x's is 20 targets).
- Run a v2 version of `verify-terminal-provider.ts` from a deployed Worker:
  create with a network policy, run a command, wait, pause and resume, fork,
  delete. v2 waits over a WebSocket that a Worker cannot release, so it closes
  ten seconds after the last wait, and the server allows ten socket tickets a
  minute per credential. The spike shows whether many isolates sharing one key
  hit that.
- Measure the Worker bundle with SDK 2.0.0. The root package bundles the
  vendored v0 SDK for non-Node targets.

**Phase 1: v2 adapter, off.** Install `@daytona/sdk@2.0.0`, move the existing
adapter to `daytona.v0` with no behavior change, and add a v2 adapter behind
`TerminalSandboxProvider`. Widen the `provider` check. The weekly workflow
builds a v2 image beside the v0 snapshot. The v2 acceptance probe gates it the
way the v0 one gates the snapshot. No region uses v2.

**Phase 2: new sandboxes on v2.** A region's Terminal configuration chooses the
provider for new sandboxes, the same way a region opts into Terminal today.
Turn it on in one region, then all. A generation replaced for any reason,
including a lost v0 sandbox, is created on v2. The v0 snapshot stops being
rebuilt: no new v0 sandbox is created after this, and every remaining one is
gone within thirty days of its last use or after phase 3 moves it.

**Phase 3: move what is in use.** Turn on migration on acquisition as
described above.

**Phase 4: finish.** Done when `daytona.v0.list()` returns no Terminal
sandbox. The provider is the authority, since rows live in each
conversation's object and there is no central index to count. Then delete the
v0 adapter, its snapshot steps, its webhook and its configuration, and narrow
the `provider` check to `daytona_v2`.

## Data model

`terminal_workspace.provider` widens from `'daytona'` to
`'daytona' | 'daytona_v2'`, and narrows to `'daytona_v2'` in phase 4. Existing
rows keep `'daytona'` and need no backfill: their value is already true. A
moved row changes `provider`, `sandbox_id` and `generation` in the existing
generation commit. The migration follows
[`durable-object-sqlite.md`](../../durable-object-sqlite.md), since SQLite
cannot alter a `CHECK` in place.

## Regional impact

Each region turns phases 2 and 3 on in its own Terminal configuration. v0's
`DAYTONA_TARGET` becomes v2's per-create `region`; a regional v2 endpoint, if
one is needed, is `DAYTONA_V2_API_URL`. A sandbox's files stay in the Daytona
region its conversation's region already uses. The archive moving between the
two sandboxes passes through the Worker in that region and is never stored.
Global is the only deployment today.

## Security and trust model

- The v2 sandbox gets the workspace's network policy at create, and acquisition
  admits work only once `getNetworkPolicy()` reports it applied (goal 5).
  Today's read-back is replaced, not weakened.
- Repository credentials move to v2's sandbox secrets and are confirmed
  applied the same way. No secret value is copied in the archive: credentials
  are injected by Daytona's proxy and are not files under `/workspace`.
- The archive is a person's workspace. It is streamed from one sandbox to the
  other, never written to R2 or logged, and its signed download URL lives only
  as long as the download, as file downloads do today.
- A v2 key, if Daytona requires a separate one, is a server secret beside
  `DAYTONA_API_KEY` and is never a `VITE_` name.

## Decision log

None yet.
