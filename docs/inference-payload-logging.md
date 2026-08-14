# Inference payload logging and improvement sharing

Every request Avalon sends to a model is recorded: the exact OpenRouter body, the
routing metadata around it, and the outcome it produced. That record is a
compliance obligation and has no workspace preference in front of it — a run that
reaches a provider leaves a row and an object, in the workspace's own region.

Whether Avalon may then *use* one of those records for anything beyond
investigating the run it belongs to is a separate question, asked separately, and
answered by the workspace: **Share work streams for platform improvement**,
default off. Its answer is kept as a ledger of periods rather than a single flag,
so a payload can be attributed to the consent that was in force at the moment it
was captured. This document owns both halves and the line between them.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/agent-inference-logging.ts` | The whole capture path: the R2 object, the D1 ledger row, the outcome update, and the best-effort wrapper that keeps all of it off a run's critical path. |
| `apps/api/src/services/workspace-service.ts` | `updateWorkspace` — the one writer of the preference and of `workspace_improvement_sharing_periods`, in a single batch. |
| `packages/db/migrations/0077_workstream_sharing_consent.sql` | The preference column, the period table, and the partial unique index that keeps periods disjoint. |
| `packages/db/migrations/0034_agent_inference_payload_logging.sql` | `agent_inference_payload_logs` and its two indexes. |
| `packages/contracts/src/index.ts` | `WorkspaceSchema.shareWorkstreamsForImprovement` and the `PATCH /workspace` request shape. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | The Workspace preferences row an admin toggles. |

## How it works

### Capture

`createAgentInferenceLogger` is handed to the harness for the length of an agent
run, with the workspace, the request, the source (`workstream`,
`automation_compiler`, `inline_child`, `hypersight`, `meeting_notes`), and the
work stream when there is one.

`onRequest` serializes `{metadata, request}` — the request being the OpenRouter
body as the model received it: the frozen system prompt, every message, and the
full tool schemas — and writes it to the region's payload bucket under
`agent-inference/<workspace-id>/<YYYY-MM-DD>/<inference-request-id>.json`. It then
inserts the indexing row into `agent_inference_payload_logs` with the object key,
the payload's SHA-256, its byte length, and the routing metadata. If that insert
fails, the object it would have pointed at is deleted, because an object no row
names is unreadable by every path that reads these back.

`onAttempt` updates that row in place with the provider's verdict: disposition,
failure classification, latency, time to first token, the token counts OpenRouter
actually reported, cost in micro-USD, and response bytes. A failed attempt that
was not cancelled also emits an `agent_inference_attempt_failed` structured log
line, so a refused call is visible in Workers Logs without a D1 query. The
provider's free-text error message is deliberately not recorded anywhere — some
upstreams quote the request back inside it.

Both halves run inside `bestEffort`, which catches everything and emits
`agent_inference_payload_log_failed`. Capture can never fail an agent run.

### Consent

An admin toggles **Share work streams for platform improvement** in Workspace
preferences. `updateWorkspace` writes, in one D1 batch, the
`workspaces.share_workstreams_for_improvement` column and the matching move in
`workspace_improvement_sharing_periods`: turning it on inserts a period with
`started_at` and the admin who agreed, turning it off stamps `ended_at` and the
admin who withdrew on the open one.

Both ledger statements are conditional on the state already stored — the insert
carries `WHERE NOT EXISTS (… ended_at IS NULL)`, the close targets only the open
row — so re-sending an answer the workspace already holds writes nothing.

Nothing consumes the ledger yet. It exists now because consent cannot be
reconstructed later: a workspace that shared for three months and then stopped is
indistinguishable, from the flag alone, from one that never shared at all, and
every payload captured in those three months would have to be treated as the
latter.

## Invariants

1. **Capture has no preference in front of it.** There is no branch in
   `agent-inference-logging.ts` that skips the write, and adding one — a flag, a
   sampling rate, a per-source exclusion — puts a hole in the compliance record
   that is invisible until someone asks for a run that was never written.
2. **A payload object is only reachable through its row.** The insert failing
   deletes the object. Code that lists the bucket directly instead of joining
   through `agent_inference_payload_logs` will find orphans from crashed writes
   and will not find the consent that governs them.
3. **A workspace has at most one open period**, enforced by
   `idx_workspace_improvement_sharing_open`. Periods are disjoint half-open
   intervals; two open rows would double the result of every interval join, which
   is a silent wrong answer rather than an error.
4. **The preference column and the ledger move together, in one batch.** The
   column is a cache of "is there an open period"; a reader that finds them
   disagreeing should trust the ledger, and a writer that updates one without the
   other has created that disagreement.
5. **A captured payload may be used for platform improvement only if its
   `created_at` falls inside a period of the workspace that produced it.**
   Consent is not retroactive in either direction: turning sharing on does not
   admit what came before it, and turning it off does not withdraw what a period
   already covered.
6. **Capture consent and improvement consent are never inferred from each
   other.** The retired `log_agent_inference` opt-in said "capture my payloads so
   they can be debugged" and was deliberately not backfilled into the new column.

## Boundary

This module owns what is recorded of a model call, where it comes to rest, and
the record of who allowed what to be done with it. It does not own:

| For | Read |
| --- | --- |
| The run loop that produces the requests, and the inference ledger of routing decisions | [`agent-harness.md`](agent-harness.md) |
| Turning a work-stream URL back into the payload a model received | [`runbook.md`](runbook.md#inspecting-a-runs-raw-inference) |
| The tables themselves and the schema rules around them | [`data-model.md`](data-model.md) |
| Which region a payload comes to rest in and what may cross | [`regionalization.md`](regionalization.md) |
| Product analytics and crash diagnostics, which are a different collection boundary with their own preference | [`telemetry.md`](telemetry.md) |

The harness calls into this module and never the reverse; nothing here reads a
transcript, a resource, or a connector. The desktop client's only surface is the
preference toggle.

## Failure modes and limits

- **R2 unavailable, or D1 unavailable.** The failure is swallowed, one
  `agent_inference_payload_log_failed` line is emitted with the phase, and the
  run proceeds. The consequence is a missing record, which is why that log line
  is the thing to alert on rather than a run failure.
- **Insert fails after the object is written.** The object is deleted, then the
  error is re-thrown into `bestEffort`. A delete that itself fails leaves an
  orphaned object, which no reader will find and which retention removes.
- **`onAttempt` arrives for a request whose insert failed.** The update matches no
  row and is a no-op; the run still ends normally.
- **Every request is captured, so cost scales with turns, not with workspaces.**
  A payload is the whole conversation as sent, so successive turns of one run
  store overlapping content — the last turn's `messages` is a superset of the
  earlier ones. This is deliberate: the recorded thing has to be what the model
  was actually given, not a reconstruction.
- **A period is open-ended until it is closed.** There is no expiry and no
  renewal prompt; consent stands until an admin withdraws it.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test/agent-inference-logging.test.ts` | That capture reads no preference, that the object and row are written together, that outcomes land on the row, and that the whole path is best-effort. |
| `apps/api/test/workspace-and-invitations.test.ts` | The preference read, the batch that opens and closes a period, that a timezone-only update leaves the ledger alone, and that the whole thing is admin-only. |
| `packages/db/test/migrations.test.ts` | The default-off column, and that a second open period for one workspace is rejected. |
| `apps/desktop/src/renderer/screens/workspace-settings.test.tsx` | The Workspace preferences toggle and the request it sends. |

Run one with
`pnpm --filter @avalon/api exec vitest run test/agent-inference-logging.test.ts` —
the path is package-relative.

The API tests stub D1 rather than using a real database, so a statement's SQL is
asserted as text. A rewrite that changes the wording of a `WHERE` clause without
changing its meaning will fail those assertions; that is the intended cost of
pinning the conditional-write guards, which are the part that must not be lost.

## Data model

`agent_inference_payload_logs` is keyed by `inference_request_id` and carries
`workspace_id` on every read path; its two indexes lead with `workspace_id`, so
any query that filters on the work stream alone still answers but scans.

`workspace_improvement_sharing_periods` holds one row per period of consent:
`started_at`, a nullable `ended_at`, and the admin on each end. `ON DELETE SET
NULL` on both user references, because losing the name of who agreed must never
lose the window they authorized.

`workspaces.log_agent_inference` still exists and is read by nothing. It is the
first half of a two-phase drop — the deploy job applies migrations before it
deploys either Worker, so dropping a column in the same change that stops reading
it fails every request the previous Worker serves in that window. The second
phase is a later migration.

## Regional impact

A payload never leaves its workspace's region: the object goes to that region's
payload bucket (`avalon-global-payloads`, or the EU-jurisdiction
`avalon-eu-payloads`) and the row to that region's D1. The consent ledger is
regional for the same reason — it is a workspace-owned row, and a workspace's
region is immutable. Any future use of shared payloads is therefore a per-region
selection, and an EU workspace's consent authorizes nothing about a Global
workspace's payloads.

## Security and trust model

A captured payload contains the prompt, the connector data pulled into it, and
whatever a person wrote. It is production user content and is treated as such:
readable only with regional operator credentials, never copied into logs,
tickets, or commits, and deleted from a scratch directory when an investigation
ends — [`runbook.md`](runbook.md#inspecting-a-runs-raw-inference) is the
procedure. The structured log lines this module emits carry only identifiers,
model names, sizes, and hashes; the provider's free text and the response body
are excluded because these lines are written for every workspace into Workers
Logs and 90-day Logpush storage, where the key-based redactor cannot recognise
quoted request content.

The improvement-sharing toggle is admin-only, like every workspace preference,
and its subheading is a promise the consuming code has to keep: anonymized and
generalized prompts, never personal details or specific parts of a person's
messages. Whatever eventually reads the ledger owes that promise its own review;
the ledger says only which payloads it may look at.

## Open questions

- **What "anonymized and generalized" means mechanically.** The selection and
  transformation that turns a consented payload into training input does not
  exist yet. When it does, it needs its own document and its own review against
  the promise in the toggle's subheading.
- **Whether consent should be re-confirmed rather than standing indefinitely.**
  A period has no expiry today.

## Changelog

### 2026-08-14 — Capture becomes unconditional and consent becomes a ledger

**What changed:** `workspaces.log_agent_inference` no longer gates anything —
every model request is captured to R2 and D1 for every workspace. The Workspace
preferences row it backed is now **Share work streams for platform improvement**,
default off, backed by `workspaces.share_workstreams_for_improvement` and by
`workspace_improvement_sharing_periods`, which records the interval each answer
was in force for.

**Why:** Two different questions had been collapsed into one toggle. Keeping a
record of what we asked a model is a compliance obligation that a workspace
cannot opt out of, and making it optional meant the one investigation that
mattered was usually the one with no rows. Being allowed to *learn* from that
record is a genuine choice, and it is the one the toggle should have been asking.

Consent is stored as periods rather than as the flag alone because of what it
will be read for: selecting the payloads a workspace has allowed us to use. That
question is "was sharing on when this row was written", which a flag cannot
answer once it has been changed — a workspace that shared for three months and
then stopped reads identically to one that never shared.

**Considered and rejected:** An append-only log of on/off *events*, which is the
same information but answers the interval question only by replaying every prior
event in order, and makes the disjointness rule an application-level convention
instead of a partial unique index. Also rejected: backfilling workspaces that had
capture enabled into the new column. That opt-in was for debugging, and reading
it as agreement to be learned from is exactly the conflation this change exists
to undo — so every workspace, including those, starts at off.

**Consequences:** Payload volume is now every run in every workspace rather than
the handful that opted in; retention and bucket cost are sized against that.
`log_agent_inference` remains in the schema, read by nothing, until a later
migration completes the two-phase drop. Any future consumer of these payloads
must join through the period ledger and must not treat the boolean column as
sufficient — it says only what is true now.

Shipped in the pull request for this change.
