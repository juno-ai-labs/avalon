# Agent memory

Agent memory is what Rally remembers on its own from the conversations it takes
part in, and what a person asks it to remember or forget. A background **sweep**
reads a window of a Thread, Breakout or Sidekick conversation after it settles
and asks a strong model which facts to record, revise or retract; the facts live
in `WorkspaceDO`, each filed under a subject (the Organization, a Channel, a
Thread, a Breakout, a person, a Sidekick) and carrying the conversations it was
learned from. Three tools let a run recall, remember and forget. Nothing is
recalled automatically at run start in this release; the per-activation digest
is the next rollout step of the PRD.

The promise this module makes: **a fact reaches a reader only while they may
open every conversation it came from today, and only when its subject admits
them.** Visibility is computed at read time from the directory `WorkspaceDO`
already keeps, never from a scope the model names. Read this before changing the
fact store, the sweep lane, the tools, or anything that decides who may see a
conversation.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/durable-objects/workspace-memory-facts-storage.ts` | The store: migration 116, the visibility rules (`openableBy`, `subjectAdmits`, `sourcesOpenToAudience`), recall, remember, forget, sweep candidates and `applyMemorySweep`. Every rule about who sees a fact is here. |
| `apps/api/src/durable-objects/workspace-memory-facts-protocol.ts` | The typed RPC shapes, the subject and reader vocabularies, `memorySourceOf` (what a fact was learned from), `memoryConversationKeyOf` (one conversation: a sweep's cursor fence and a digest holder), `digestPrincipalKey`, the sweep operation schema and refusal codes. |
| `apps/api/src/durable-objects/workspace-do.ts` | The RPC methods (`recallMemoryFacts`, `rememberMemoryFact`, `forgetMemoryFact`, `memorySweepCandidates`, `applyMemorySweep`, `memoryDigest`, and the three copy-sync RPCs), the `memory_digest_sync` alarm lane, and the person reader's relationship read. |
| `apps/api/src/durable-objects/memory-digest-sync.ts` | The copy-sync lane: migration 117 (`memory_digest_holders`, `memory_digest_holder_facts`, `memory_digest_sync`, its revision counter, `memory_revision` and the marking triggers), `markMemoryDigestHolders`, `markMemoryDigestHoldersFor`, and the publish, work, complete and release halves, the colour-sync shape. |
| `apps/api/src/durable-objects/workstream-scheduling-storage.ts` | `memory_sweep_state`: the cursor, the rest, the claim, the settle, the release and the alarm's retry time (conversation-object migration 76). `memory_digest_copies`: one principal's copy, its store, the principal list and the per-fact removal (migration 77). `workstream-scheduling-protocol.ts` names the four sweep writes in `DERIVED_ALARM_MUTATIONS`, so the endpoint re-arms the alarm after each. |
| `apps/api/src/services/memory-digest-service.ts` | The digest's conversation half: `digestReaderFor`, the copy refreshes (`refreshMemoryDigestCopy`, `refreshMemoryDigestCopies`), `renderMemoryDigestSection`, and the digest's open limits. |
| `packages/agent-harness/src/prompts/memory-digest.ts` | `renderMemoryDigest`: the one implementation of the digest's text. Golden-hashed in `prompts.test.ts`. |
| `apps/api/src/services/memory-sweep-service.ts` | The lane: `attemptMemorySweep` (gates, claim, one Queue send) and `runMemorySweep` (window, candidates, model, apply, settle). The open limits. |
| `apps/api/src/services/memory-service.ts` | The `rally:memory` tools (`recall`, `remember`, `forget`), who a run reads as (`readerOf`), the trust class of a remembered fact, and the scope resolution `rally_tables` still uses. |
| `packages/agent-harness/src/prompts/memory-sweep.ts` | The sweep prompt and its strict JSON schema. Golden-hashed in `prompts.test.ts`. |
| `apps/api/src/durable-objects/substream-agent.ts` | The two sweep triggers (the settlement step after the description loop, and the alarm lane `nextMemorySweepAt`), the digest copy refresh at settlement, and the synchronous copy read the run renders from (`memoryDigest` on the persistent-loop runtime). |
| `apps/api/src/services/integrations.ts` | `principalSystemSectionFor`: the digest rendered into the harness's per-principal system section. |
| `apps/api/src/services/memory-review-service.ts` | The review surface's one read and one removal for every scope (`readMemoryReview`, `forgetReviewedMemory`), mapped from the `reviewMemoryFacts` and `forgetReviewedMemoryFact` RPCs to the `MemoryReview` contract by `memoryReviewFact`. |
| `apps/api/src/routes/workspace.ts`, `routes/workstreams.ts`, `routes/spaces.ts` and their services | The review routes: `/workspace/me/memory` and `/workspace/memory` (`WorkspaceService`), `/workstreams/:id/memory` (`WorkstreamService`), `/spaces/:id/memory` (`SpaceService`), each a `GET` and a `DELETE …/:factId` naming its scope. |
| `packages/contracts/src/memory.ts` | `MemoryReviewSchema`, `MemoryReviewFactSchema`, `MemoryReviewSourceSchema`, `MemoryForgetResponseSchema`: what the review surface reads. |
| `packages/ui/src/components/memory-fact-rows.tsx` | `MemoryFactRows`: one scope's facts as rows (text, disagreement, horizon, source link, Remove), shared by the title-pill Memory level (`conversation-menus.tsx`) and Settings. |
| `apps/desktop/src/renderer/components/memory-review.tsx` | `useMemoryFacts` (one scope's read and removal, cache and refusals), `MemoryFactList` (a scope on a Settings page), and opening a fact's source. Used by `screens/channel.tsx` and `screens/workstream.tsx` (the title pop-out) and `screens/workspace-settings.tsx` (Account and Organization). |
| `apps/api/src/queues/activity-consumer.ts` | The `memory_sweep` and `memory_digest_sync` Queue branches. |
| `apps/api/src/services/memory-scope-cache.ts`, `workspace-memory-storage.ts` | The scopes and typed tables of `rally_tables`, unchanged by this module and documented in [`agent-harness.md`](agent-harness.md#scoped-durable-memory). |

## How it works

### A fact

One or two plain sentences, with: a `subjectKind` and `subjectId`; a `kind`,
`standing` (true until it changes) or `situational` (with a `validUntil` and the
basis for it: `stated`, `event`, `assumed`); an optional `validFrom` for
something that starts later; `derivedFrom`, the trust class of what established
it (`person`, `agent`, `external`, or `mixed` when its evidence, or an update
and its predecessor, span two);
`conflict`, set when two people disagree and the fact states both positions;
`evidence`, transcript sequence numbers; and `sourceConversations`, one or more
of `<channelId>` (a Thread's Main), `<channelId>/<breakoutId>`,
`sidekick:<automationId>`, `space:<spaceId>`. A fact is never without a source:
an Organization fact was promoted *from* somewhere, and that somewhere decides
who may see it. A fact is **active** while it is not retracted, not superseded,
and not past `validUntil`; an upcoming fact (`validFrom` in the future) is
active and is shown as such.

### The sweep

**Trigger.** `settleAgentRun` calls `attemptMemorySweep` after the description
loop's step, for conversations whose parent is a Thread or a Sidekick (a
Channel's own feed is not swept: PRD non-goal 9). The conversation object's
alarm calls the same attempt when `memory_sweep_state.retry_at` is due.

**Gate**, cheapest first: model access; the conversation exists and is not
archived; the conversation has rested (`rest_until`); the window since the
cursor holds at least `MEMORY_SWEEP_MINIMUM_PERSON_MESSAGES` person messages
with `MEMORY_SWEEP_MINIMUM_PERSON_CHARACTERS` between them (agent turns and
tool rows never count). The rest is checked before the window is read: a
resting conversation asks one existence question (`hasMessageAfter`, any
non-tool row after the cursor) and sets `retry_at = rest_until` when the
answer is yes, so the alarm comes back and checks the floors then. Every other
skip clears `retry_at`, which is what keeps the alarm from waking into the same
answer. A window that cannot grow (a page that came back at its row limit, the
window plus its overlap plus one, or a window the character budget cut) and
still misses the floors would miss them from this cursor forever: the attempt
records what it read as swept with no model call (an empty receipt in
`WorkspaceDO`, then the settle) and reads on from there at the next rest.

**Claim.** `claimMemorySweep` pushes `rest_until` to the floor and records the
range *before* anything is sent, the description loop's claim: two runs settling
together spend one sweep, and a failing model is not retried by every run behind
it. A claim in flight blocks the next for `MEMORY_SWEEP_CLAIM_TIMEOUT_MS`; after
that a lost delivery is presumed and the next run may claim. The claim leaves
`retry_at` at its rest, so a delivery lost together with its release is claimed
again by the alarm at the rest rather than waiting for an unrelated run to
settle; a settle or release moves `retry_at` first. The claim is one
`ACTIVITY_QUEUE.send` of `{ type: "memory_sweep", region, workspaceId,
parentKind, parentId, substreamId, fromSeq, toSeq, attempt }`; a failed send
releases the claim.

**Run** (`runMemorySweep`, in the consumer). Re-read the window through the
message port from `fromSeq` minus an overlap of context messages to `toSeq`,
dropping tool rows and empty rows and labelling authors person, external, agent
or system. The context rows are kept whole; the fresh ones are kept oldest
first until `MEMORY_SWEEP_MAXIMUM_WINDOW_CHARACTERS` runs out, and the attempt
ends the range at the last one kept, so what did not fit is the next sweep's
rather than skipped. Members are named from the regional `users` table, on
their messages and in the placement's people. Ask `WorkspaceDO` for the **placement** (the conversation's subject,
its Thread, the Channels it sits in, whether it is Organization-wide, the
speakers who may be the subject of a `person` fact) and the **candidates**:
active facts on the conversation's subjects matching the window's terms, plus
every active situational fact on those subjects, **restricted to facts every
current participant of the conversation may open and whose subject the
placement admits** (`sweepVisibleFacts`: an Organization fact only in an
Organization-wide conversation, a Channel fact only for a Channel every
participant may list, a person fact only for a speaker). Render the prompt, call
`runStructuredInference` on role `memory_sweep` (flag
`agent-model-memory-sweep`, default the primary model, metered `memory_sweep`,
Organization pays). The model returns a flat list of operations (`add`,
`update`, `confirm`, `retract`). Only the envelope is held strictly: each
operation is checked on its own, and one that fails its schema (a date that is
not RFC 3339, a confidence outside 0..1, too much evidence) is dropped and
logged as `memory_sweep_operation_dropped` with its `zodDiagnosticCode`, so one
bad row does not cost the paid call. The service also drops incoherent rows (an
`add` without text, an `update` without an id), converts horizons to instants,
and sets each operation's `derivedFrom` from the authors of the messages it
cites (one class is that class, two or more are `mixed`; with nothing citable
the model's word stands and its silence is `agent`, never `person`). It mints
one fact id per operation and calls `applyMemorySweep` with the speakers and
the candidate ids it was handed.

**Apply**, one `WorkspaceDO` transaction. Compare `fromSeq` with the stored
receipt's `to_seq` for this conversation (`memoryConversationKeyOf`: a Sidekick's
own conversation and each of its runs share the fact source
`sidekick:<id>` but each keeps its own receipt, `sidekick:<id>/<substreamId>`): behind it, the range was already
applied and the stored receipt is answered; ahead of it, a range was skipped and
`cursor_ahead` names the stored `to_seq`; equal, the operations apply in order.
An `add` is refused by code when its subject is wider than the placement allows
(`subject_above_placement`), names a Channel or person outside it
(`subject_id_not_in_placement`), or is situational without a horizon
(`horizon_required`). An `update`, `confirm` or `retract` is refused when the
fact is not among the candidates this sweep was handed, or is no longer one
every participant may open under a subject the placement admits
(`fact_not_candidate`), or is missing or inactive; the model reads a fact id off
an untrusted transcript as readily as off the candidate list, so the list the
store returned is the only one it accepts back. An `update` inserts a new fact
that supersedes and links
its predecessor and carries the union of both facts' sources. An update that
cites this window puts this conversation first, because `evidence` indexes the
first source; one that cites nothing keeps the predecessor's evidence and
order. Its `derivedFrom` is the predecessor's when the two agree and `mixed`
when they do not. The receipt
(`memory_sweep_receipts`, one row per conversation) is written in the same
transaction and the refusals are returned, not thrown.

**Settle.** The consumer moves the conversation's cursor to the receipt's
`toSeq` with `settleMemorySweep`, a compare-and-swap on the claimed `fromSeq`
that is a no-op at an equal `toSeq`, so a redelivery after a committed apply
finishes from the receipt rather than wedging the conversation. A sweep that
wrote rests at the floor; a quiet one doubles the rest up to the ceiling. The
settle takes the floor and ceiling as numbers and computes the rest itself,
because it is called over the scheduling port and a function does not cross
it. It sets `retry_at` to the new rest when the transcript already holds a
message past the settled range (a run that settled mid-sweep asked the alarm
back, and clearing that would strand its messages), and clears it otherwise. On
`cursor_ahead` the cursor is rewound to the store's `to_seq`. A delivery with
nothing to sweep (the conversation gone from the directory, or no fresh
messages) writes an empty receipt before it settles, so the store's fence and
the cursor never part. A model or store failure releases the claim
(`retry_at = rest_until`) and rethrows; the consumer acks either way, because
the conversation's own claim decides when it is tried again. Each of the four
sweep writes re-arms the conversation object's alarm when it commits
(`armsDerivedAlarm`), whoever made it.

### Visibility

Computed inside `WorkspaceDO` at every read, in TypeScript over small batched
SQL (one query per source kind over a JSON list, never one per fact):

1. **Sources.** The reader may open every conversation in
   `sourceConversations` today: a Thread's Main by `mainOpenableSql`, a
   Breakout by `channelListedSql` and `breakoutListedSql`, a Channel's feed by
   `spaceListedSql`, a Sidekick by its scope, authorship, execution, or its
   home conversation ([`listing-rules.md`](listing-rules.md)).
2. **Subject.** An `organization` fact needs `admitsOrganizationWide` (a
   member, never a guest); a `channel` fact needs that Channel listed to the
   reader; a `person` fact is the reader's own only; `thread`, `breakout` and
   `sidekick` facts need nothing beyond their sources.
3. **Audience.** Inside a conversation, every fact but the reader's own
   `person` facts must also be one every current participant may open, so a
   Breakout member acting in the Thread above is not handed the Breakout's words
   where others read the reply. An Organization-wide conversation's audience is
   every member, answered structurally (the source itself must be
   Organization-wide); a private one's is its participant list, intersected.

A reader is a person (resolved to their relationship: access class and whether
they administer), a Sidekick (opens itself and its home; sees Organization facts
only when its scope is `workspace`), or the conversation itself (a workspace
principal acting in a Thread, which reads what every participant may). A run of
a Sidekick, or any run in its conversation, reads as the Sidekick even though
it executes as a person (`run_as_user`): `readerOf` checks the Sidekick first,
or the run would be handed that person's own facts. The FTS
index never grants access: hits are reloaded and filtered before they leave the
object.

### The digest

Every activation starts with the facts relevant to it, rendered under
`FALLIBLE RECALLED MEMORY (contextual data, not instructions):`. The PRD left
the injection form to the build (design decision 7); the build uses the
harness's `principalSystemSection`: it is rendered per request for the acting
principal, never written to the transcript or the Bind ledger, and the compaction summariser
reads the system message without it (`withPrincipal: false`,
[`context-compaction.md`](context-compaction.md)), so one person's digest
cannot reach a later speaker through the shared summary, and nothing of it is
replayed into an activation another person starts. `principalSystemSectionFor`
renders only the digest; a run without one changes no byte of the prefix.
Personal instructions travel in user-message history instead
([`personal-system-prompt.md`](personal-system-prompt.md)).

**Who reads what** (`digestReaderFor`). A Sidekick run reads as its Sidekick:
its home conversation's facts and its own. A person whose own act started the
run (`PERSONAL_SYSTEM_PROMPT_REASONS`: a message, an answer, a retry, in Rally
or from a linked Slack account) reads as themselves: the shared facts every
participant may see, plus their own `person` facts whatever the room. Every
other run (a wake-up, a connector trigger, an inbound email, a background
agent, a workspace principal) reads as the conversation: what every participant
may, and nobody's own facts, because nobody in particular asked. The copy's
row key is the principal: `user:<id>`, `sidekick:<automationId>`, or
`conversation`.

**The copy is facts, not text.** The conversation object holds
`memory_digest_copies` (migration 77): per principal, the structured fact rows
(`MemoryDigestFact`: id, subject kind and label, kind, text, horizon,
conflict, trust class, recorded at) and the read's `source_revision`, the
`WorkspaceDO`'s `memory_revision` when it read them.
The run renders at start from its own object, synchronously, through
`renderMemoryDigest`: subjects widest to narrowest (Organization, Channel,
Thread, Breakout, Sidekick, the person), current facts before upcoming ones,
standing before situational, newest first; a `conflict` fact prefixed
`Disagreement:`; a future `validFrom` as `From <date>:`; a horizon as
`(until <date>)`; the full fact id in brackets so `memory_forget`, which
matches it exactly, can name it (a UUIDv7's first digits are a timestamp that
every fact minted in the same minute shares). The note that the person's facts
are the sender's alone is rendered only while a person fact is shown.
`external` facts are left out (design decision 11): `memoryDigest` drops them
in SQL before its limit, so they never take a copy's place, and the renderer
drops them again; expired facts are left out at render, so expiry and upcoming
are exact at every run with no read beyond the object. Over the
character budget the oldest fact of the widest group goes first, so this
conversation's own facts and the person's own are kept longest, and one closing
line says how many were left out. Nothing current renders as the empty string.

**Refresh.** A run never reads `WorkspaceDO` for its digest; the copy is a
projection, refreshed by five writers. (1) `settleAgentRun` refreshes the run's
principal's copy after the sweep attempt: one `memoryDigest` RPC (recall with
no query, as that reader, which also records the conversation as a **holder**
of the facts it read) and one local write, never throwing. (2) The sweep
consumer refreshes every copy of the swept conversation after an apply that
wrote. (3) `memory_forget` removes the fact from this conversation's own copies
in the same call, so the person who forgot it never sees it again where they
forgot it. (4) `provisionSidekickRun` reads the Sidekick's copy into each new
run conversation before its first activation, since a run is a conversation
nobody has settled in yet. (5) The **copy-sync lane** reaches every other
conversation. A holder is keyed by `memoryConversationKeyOf` (a Thread's id, a
Breakout's `<thread>/<breakout>`, `sidekick:<id>/<substream>`, `space:<id>`),
not by the fact source, because every conversation of one Sidekick shares the
source `sidekick:<id>` but holds its own copies; `memory_digest_holder_facts`
records which facts each principal's copy there was read with. `WorkspaceDO`
marks holders in `memory_digest_sync` with a revision:

- a retraction (`memory_forget`, or a sweep's `retract`) marks only the holders
  whose copy holds that fact (`markMemoryDigestHoldersFor`). A sweep's `update`
  marks nothing: a supersede withdraws nobody's access, and the copy showing
  the old wording catches up at its next refresh, as for an add;
- a trigger marks every holder when a `channels`, `breakouts` or `spaces`
  row's `scope` or `archived_at` changes, when a `workspace_member_status` row's
  access class, role, status or `active` changes, or when an
  `automation_directory` row's `scope` changes;
- a trigger marks one conversation's holders when a participant joins or
  leaves it: an `INSERT` with `is_participant = 1` or a change of
  `is_participant` in `channel_viewers` or `breakout_viewers` marks the holders
  under that Thread, in `space_viewers` the Channel's;
- a participant leaving also marks every holder whose copy holds a fact
  sourced from what they left (the Thread and its Breakouts, the Breakout, or
  the Channel's feed), found by joining `memory_digest_holder_facts` to the
  fact's sources: the person can no longer open it, so its facts leave their
  own copies in every other conversation and every copy whose audience
  includes them. Joining marks only that conversation's holders, because a
  wider audience hides nothing.

The alarm lane `memory_digest_sync` publishes one batch of up to 100
`memory_digest_sync` messages with one batch in flight per Organization; the
consumer asks `memoryDigestSyncWork` for the conversation, refreshes each of its
copies as its own principal, and completes the row, or releases it when any
copy failed so the alarm sends it again at its gate. A row marked again while in
flight is carried by the newer message; a holder whose conversation is archived
or gone from the directory is dropped when its row comes up, and recorded again
at its next `memoryDigest` read if it is restored. Adding a fact marks nothing:
copies widen on their own refreshes.

**Ordering.** Refreshes overlap, so a copy keeps the newest read by
`memory_revision`, a counter `WorkspaceDO` advances in every transaction that
writes a fact (a remember that wrote, a retraction, a sweep that applied
anything) and with every mark, so a refresh a change asks for reads above every
read taken before it. A read lands when its revision is at least the copy's: a
read that ties read the same facts under the same marks, and a change no
trigger marks still reaches the copy at its next refresh. A forget also raises
every copy in its conversation to the retraction's revision, so a refresh that
read before the forget and lands after it is refused.

The cost is lag, as for the personal system prompt: a principal's first run in
a Thread or Breakout has no digest, a new fact reaches a run from the next
refresh, and a run that starts in the moments before the lane reaches its
conversation can see a retracted fact once more; `memory_recall` never can,
because it reads the store. There are no `DELETE` triggers on the viewer
tables: projection rebuilds delete and reinsert their rows in bulk, so a
rebuild's reinserts mark that one conversation's holders, which is bounded, and
a participant a rebuild removed reaches copies at their next refresh.

### The tools

`rally:memory` (wire prefix `memory_`) is preloaded in every root run of a
Thread Main, a Breakout, and a Sidekick's conversation and runs; an inline child
reaches nothing (`resolveMemoryAccess` answers it an empty union, the gate every
tool call passes).

- `memory_recall(query, limit?)`: FTS over the subjects of the run's
  conversation plus the acting person, filtered by the rules above, best match
  first, `limit` at most 25 (default 10). Each fact is rendered with its
  subject's display title, its horizon, `expired`, `upcoming`, and its first
  source's title. Nothing found is an empty list.
- `memory_remember(text, kind, validUntil?, about?)`: writes one fact under
  the acting person (`about: "me"`) or the conversation's own subject. The
  trust class is the input that started the run (`derivedFromOf`): a Slack or
  email trigger writes `external`, an agent exchange or a Sidekick's
  scheduled self-review `agent`. A sentence that
  matches an active fact on the subject word for word, among the facts the
  reader may see from here, returns that fact with `deduplicated: true`; a
  match they can no longer open is written again, since a dedupe against it
  would report a memory recall could never return. Every active fact of the
  subject is compared, not a page. Idempotent on the provider key: a replay answers from
  `memory_fact_receipts`.
- `memory_forget(factId)`: retracts, when the reader may. A person forgets
  their own facts and what the conversation they stand in established; a
  Channel's or the Organization's facts take an administrator (owner or admin),
  except that a Personal Channel's owner forgets its Channel facts too, since
  nobody else is listed it; a Sidekick forgets what came from itself and its
  home. Seeing a fact never
  implies the right to retract it.

Failure codes: `memory_horizon_required`, `memory_horizon_forbidden`,
`memory_personal_unavailable`, `memory_fact_not_found`,
`memory_fact_not_visible`, `memory_fact_not_forgettable`, and
`memory_unavailable` when the object cannot be reached, whose cause is logged
as `memory_tool_unavailable`. Argument shape is the harness's `validateInput`
hook, which names the field.

### The review surface

Memory is reviewed where its subject lives, so each surface shows one subject
and nothing is grouped:

| Where | Route | Lists | Removed by |
| --- | --- | --- | --- |
| A Thread's or Breakout's title pop-out | `/workstreams/:id/memory?substreamId=` (`"0"` for Main) | that conversation's own facts | anyone who may open it (a participant) |
| A Channel's title pop-out | `/spaces/:id/memory` | that Channel's facts | an administrator; a Personal Channel's, its owner |
| Settings → Account | `/workspace/me/memory` | the person's own facts | the person |
| Settings → Organization | `/workspace/memory` | the Organization's facts | an administrator |

Each `GET` answers `MemoryReview` (`facts`, newest first, expired included,
retracted and superseded excluded) and each `DELETE …/:factId` answers
`MemoryForgetResponse`. Both go through one pair of `WorkspaceDO` RPCs,
`reviewMemoryFacts` and `forgetReviewedMemoryFact`, which take a scope (`own`,
`organization`, or `conversation` with a `MemoryConversation`, a `space`
parent being a Channel) and `memory-review-service.ts` maps them for every
route. The decisions behind it:

- **One visibility rule and one removal rule.** Which facts a scope lists is
  `visibleFacts`; whether each is removable is `mayForget`, computed in the
  store and returned per fact, so no service re-derives authority and the
  Remove button and the `DELETE` cannot disagree. Seeing a fact still never
  implies removing it (design decision 14).
- **A Thread's or Breakout's facts read as recall reads them there**, audience
  intersection included: the pop-out shows what Rally would recall in that
  conversation. The store checks the conversation is open to the person in the
  same read and answers `404 conversation_not_found` otherwise, so the route
  makes no separate admission round trip. Anyone who may open it may remove
  its own facts, the same rule `memory_forget` applies to a participant.
- **A Channel's facts read with no conversation**, as the Organization's do:
  the Channel listed to the person and every source openable. Reading them
  with the Channel feed's audience would hide a Channel fact learned in a
  private Thread from everyone, administrators included, and the pop-out is
  the only place it can be removed. An unlisted Channel answers
  `404 space_not_found` from the same read. A Personal Channel is listed to
  its owner alone, so its facts are removable by its owner as well as by an
  administrator (`mayForget`, in the tool and the review alike); otherwise a
  fact the surface lists would be removable by nobody.
- **A person's own facts ignore the source rule, but their titles do not.**
  They are listed whether or not the person can still open the conversation
  each came from, because a fact about them learned in a room they have since
  left is exactly the one they most need to remove; recall and the digest
  still hold it back. The "from" link's title is resolved only for a source
  they may open today and is `null` otherwise, so a private Thread they were
  removed from does not keep telling them its name. Only the first source is
  titled, since only it is rendered.
- **The Organization's facts** are listed to a member who may open every
  source and are removable by an owner or admin; a member's `DELETE` is
  `403 memory_fact_not_removable`.
- **A fact the scope would not list answers `404 memory_fact_not_found`**,
  whatever the reason (another person's, another scope's, a source the person
  cannot open, no such fact), so a fact id learned elsewhere reveals nothing.
  A fact a sweep superseded after the list was read is `not_found` too:
  retracting the inactive predecessor would answer success while its
  successor stayed. An already-retracted fact answers `200` as the first
  removal did.
- **A removal reaches every copy.** A retraction marks every digest holder
  and wakes the alarm, so the copy-sync lane refreshes each conversation's
  digest; `memory_recall` reads the store and never shows the fact again.
- **Guests have no review surface.** Every route sits on a members-only mount
  (`/workspace`, `/workstreams`, and `spaceRoutes`, not `spaceReadRoutes`).
  If guests ever hold `person` facts, the routes need a mount of their own.

Expiry and an upcoming start are the client's to judge from `validFrom`,
`validUntil` and its own clock, so they stay right while a list is open.

### The import

Migration 116 turned every live row of the retired `memory_items` store into a
standing fact the agent recorded (`derived_from = 'agent'`, `created_by =
'import'`):

| scope kind | subject | source |
| --- | --- | --- |
| `user` | `person`, owner | provenance `workstreamId` when it is a thread, else the owner's Personal Channel, else General |
| `workstream` | `thread` (or `sidekick`, when the owner is a Sidekick) | the owner |
| `sidekick` | `sidekick`, owner | `sidekick:<owner>` |
| `workspace` | `organization` | provenance `workstreamId` when it is a thread, else General |

A row whose source could not be named (a `user` item whose owner was never
seated in an Organization with no General yet) was not imported. Production held
nine items in one Organization and none to one elsewhere when this shipped.

## Invariants

- **Every fact has at least one source, and the source decides who reads it.**
  Breaking it (a null source, a fact copied without its sources) would let a
  conversation narrowed to private keep leaking what was said in it. Guard: the
  `json_array_length > 0` check on `memory_facts`, and
  `test-workers/memory-facts.test.ts` ("hands a sweep only the facts every
  current participant may open").
- **The model never names a scope, subject owner, or conversation.** The run's
  frozen principal and conversation decide; the only ids a tool accepts are
  fact ids it was handed. Breaking it lets a prompt widen what a run reads.
  Guard: the tool input schemas and `test/scoped-memory.test.ts`.
- **A fact may be filed no wider than its conversation's placement.** An
  `organization` fact needs an Organization-wide conversation; a `channel` fact
  a Channel the conversation sits in; a `person` fact a listed speaker. Breaking
  it promotes a private room's words to everyone. Guard: `applyMemorySweep`'s
  refusal codes, `test-workers/memory-facts.test.ts`.
- **Candidates and updates are fenced by the audience and the placement.** A
  sweep is handed only facts every participant may open under a subject the
  placement admits; an `update`, `confirm` or `retract` must name one of those
  candidates; and an update carries the union of sources, so a public Thread's
  sweep can never restate a private Breakout's words under the public source,
  and a fact id quoted in a transcript cannot reach a fact the sweep was not
  shown. Guard: `sweepVisibleFacts` and `candidateFactIds` in
  `memorySweepCandidates` and `applyMemorySweep`; the workerd suite above.
- **The cursor fence is the store's, not the consumer's.** A range is applied
  once; a replay answers from the receipt; a gap is refused. Breaking it
  double-writes facts on a Queue redelivery. The cursor never moves without a
  receipt, including for a range passed with no model call, or the next sweep
  is rewound over it. Guard: `test-workers/memory-facts.test.ts`
  ("applies a sweep once behind the cursor fence…", "keeps a cursor fence per
  Sidekick conversation…") and `test/memory-sweep-service.test.ts`.
- **Every attempt moves `retry_at`.** The alarm lane reads nothing else, and
  an attempt that left it where it was would wake the object into the same
  answer forever (`onScheduledAlarmStalled`). Guard:
  `test/memory-sweep-service.test.ts` asserts the row after each path.
- **`memory_scopes` stays.** The typed tables of `rally_tables` reference it;
  `MEMORY_SCOPE_DEPENDENTS` and `WORKSPACE_FENCED_TABLES` feed frozen
  migrations and are not edited. Guard: migration hashes.
- **Forgetting is authorized apart from seeing.** Guard:
  `test/memory-facts-tools.test.ts` ("lets a member forget their own facts…").
- **A run reads its digest from its own object and nothing else.** No
  `WorkspaceDO` call sits on the run path; the copy is refreshed after the run,
  by the sweep, by a forget, and by the copy-sync lane. Breaking it puts a
  cross-object read in front of every first token. Guard: `memoryDigestCopy`
  is synchronous and refreshes nothing; `test/memory-digest-service.test.ts`.
- **The digest travels in `principalSystemSection` and nowhere else.** It is
  rendered per request for the acting principal and excluded from the
  compaction summary; appended to `systemPrompt` or to a transcript message it
  would reach the shared checkpoint. Guard: `principalSystemSectionFor` is the
  only writer; [`context-compaction.md`](context-compaction.md).
- **A copy never regresses.** `storeMemoryDigestCopy` writes only a read whose
  `memory_revision` is at least the copy's `source_revision`, and a forget
  raises every copy in its conversation to the retraction's revision, so two
  overlapping refreshes converge on the newer and a read from before a forget
  cannot restore the fact. The revision advances with every fact write and
  every mark; a clock would tie across two reads that straddle a change. Guard:
  `test/memory-digest-service.test.ts` ("an older revision never replaces it",
  "refuses a refresh that read before a forget").
- **Every input the visibility rule reads marks the copies it can change.** A
  retraction marks the holders of its fact; a change of scope, archive, access
  class, role or Sidekick scope marks every holder; a participant joining or
  leaving marks that conversation's, and leaving also marks every copy holding
  a fact sourced there. A new input to `openableByPerson` or
  `conversationAudience` needs its trigger here, or it reaches copies only at
  their next refresh. Guard: `test-workers/memory-facts.test.ts` (the
  copy-sync cases).

## Boundary

Owns: the fact store and its visibility rules, the sweep lane end to end, the
three tools, and the import. Exposes: the five `WorkspaceDO` RPCs, the
`memory_sweep` Queue message, `createMemoryTools`, and the prompt renderer.
Depends on: the directory projection and listing rules in `WorkspaceDO`
([`listing-rules.md`](listing-rules.md), [`spaces.md`](spaces.md)), the
conversation object's message, identity and scheduling ports
([`workstream-durable-object.md`](workstream-durable-object.md)), the
structured-inference gateway and model flags
([`feature-flags.md`](feature-flags.md)), usage metering
([`usage-metering.md`](usage-metering.md)), and the activity Queue.

Does not: inject anything at run start (PRD step 2, the digest); show facts to
people (step 3, the review surface); sweep a Channel's own feed; embed or
vector-index facts (Turbopuffer, when wanted:
[`text-search.md`](text-search.md)); own `rally_tables`
([`agent-harness.md`](agent-harness.md#scoped-durable-memory)).

## Failure modes and limits

- **Model unavailable or envelope schema-invalid:** the run throws after
  releasing the claim; `memory_sweep_failed` names the reason
  (`zodDiagnosticCode` for a schema failure). The alarm retries at the claim's
  rest. No cursor moves. A single malformed operation is dropped instead, and
  `memory_sweep_operation_dropped` names it.
- **`WorkspaceDO` unreachable from a tool:** `memory_unavailable` to the model,
  `memory_tool_unavailable` with the cause in the log.
- **Lost Queue delivery:** the claim times out after
  `MEMORY_SWEEP_CLAIM_TIMEOUT_MS`; the alarm, left `retry_at` at the claim's
  rest, claims again there, as does any settlement before it. The store's fence
  makes the late delivery, if it arrives, a replay.
- **Conversation archived or deleted between claim and run:** candidates
  answer `conversation_missing`; an empty receipt is written and the cursor
  settles to `toSeq`.
- **A page of tool and agent rows:** a window that cannot grow and cannot
  meet the floors is passed with an empty receipt (`memory_sweep_page_skipped`);
  the person messages in it, fewer than the floor, are not swept. It counts as a
  quiet sweep, so a long run of such pages is read at a lengthening rest.
- **A model operation outside the placement:** refused by code and logged;
  the rest of the batch applies.
- **A digest copy refresh fails:** `memory_digest_refresh_failed` with the
  reason; the old copy stands and the next refresh tries again. In the
  copy-sync consumer a failed copy releases the row (`memory_digest_sync_failed`
  when the work itself threw), so the alarm sends it again at its gate.
- **An unreadable copy:** `memory_digest_copy_unreadable` names the field
  (`zodDiagnosticCode`) and the run renders no digest rather than failing.

Limits, every one a placeholder the team has not set
([`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md)),
declared as `LIMIT UNSET` constants in `memory-sweep-service.ts`:

| Constant | Placeholder | What it bounds |
| --- | --- | --- |
| `MEMORY_SWEEP_REST_FLOOR_MS` | 1 hour | The quiet a conversation earns after a sweep that wrote |
| `MEMORY_SWEEP_REST_CEILING_MS` | 24 hours | The most a quiet conversation earns (floor doubling per quiet sweep) |
| `MEMORY_SWEEP_MINIMUM_PERSON_MESSAGES` / `_CHARACTERS` | 3 / 200 | New person conversation needed for a model call |
| `MEMORY_SWEEP_MAXIMUM_WINDOW_MESSAGES` / `_CHARACTERS` | 300 / 160,000 | The window the model reads |
| `MEMORY_SWEEP_WINDOW_OVERLAP_MESSAGES` | 20 | Messages before the cursor shown as context |
| `MEMORY_SWEEP_MAXIMUM_CANDIDATES` | 60 | Remembered facts shown to the model |
| `MEMORY_SWEEP_CLAIM_TIMEOUT_MS` | 15 minutes | How long a claim holds the lane |
| `MEMORY_DIGEST_COPY_FACT_LIMIT` (`memory-digest-service.ts`) | 120 | Facts one copy holds; twice what the render budget shows, so the renderer's cut decides |
| `MEMORY_DIGEST_BUDGET_CHARACTERS` (`memory-digest-service.ts`) | 6,000 | Characters the rendered digest may take (about 1,500 tokens, under 1% of a 200k window) |

Arithmetic the placeholders came from: a Sol-class call on a 300-message
window costs one call per conversation per rest period, and Juno Labs' busiest
Thread settles a few dozen runs a day, so the floor bounds a Thread at roughly
one call an hour and the ceiling at one a day when nothing new was learned. The
tool-side bounds (`text` at most 600 characters, `limit` at most 25, the recall
query at `MEMORY_RECALL_QUERY_LIMIT`) are from the PRD's design and are not
defensive numbers.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test-workers/memory-facts.test.ts` | Migration 116 on a populated object at 115 (subjects, sources, FTS, the drop, the retired alarm row); `applyMemorySweep`'s fence, receipt replay and `cursor_ahead`, one fence per Sidekick conversation; an update's source order and `mixed`; placement refusals; candidate and recall audience fencing; `memoryDigest`, the revision it answers and the holder and holder facts it records, one holder per conversation of a Sidekick; the copy-sync lane: a retraction marks only the holders of its fact and an update none, a participant joining marks that Thread's holders only, a participant leaving marks the copies elsewhere holding a fact learned there, a member becoming a guest and an archive mark every holder, one batch publishes, work, complete and release settle the row. Run with `pnpm --filter @rally/api test:workers`. |
| `apps/api/test/memory-facts-tools.test.ts` | The three tools over a real `WorkspaceDO` (node:sqlite) and real conversation objects: person facts follow their person and nobody else, a Sidekick run reads as the Sidekick, conversation facts stay with their subject, forget authority, dedupe, receipt replay, horizon errors. The fixture uses `migratedSqliteDatabase()` because the object reads a person's relationship from current `workspace_members`. |
| `apps/api/test/memory-sweep-service.test.ts` | The attempt's gates and claim, the Queue message, rest and `retry_at` (resting, keyless, the follow-up a settle keeps); the window's character budget, and a full page or an over-budget run of agent text passed without a model call; the run's window, names, candidates, prompt, per-operation parsing, trust class from evidence, apply, settle, the empty receipt, release on model failure, replay and rewind, quiet rests. The model is a stubbed `fetch`; `WorkspaceDO` is a stub recording its calls. |
| `apps/api/test-workers/memory-sweep-state.test.ts` | `memory_sweep_state` through the real scheduling port, as the consumer reaches it: a settle's arguments cross the binding, and a release re-arms the object's alarm at the rest. |
| `packages/agent-harness/src/prompts.test.ts` | The sweep prompt's golden hash, injection isolation, bounding, and load-bearing lines; the digest's golden hash, group order, horizons, full fact ids, the `external` exclusion, the budget cut and its trailer, and the personal note only beside a person fact. |
| `apps/api/test/memory-digest-service.test.ts` | The digest over a real `WorkspaceDO` and real conversation objects: who reads as whom (`digestReaderFor`), a copy holds what its reader may see and nobody else's facts, an older revision never replaces a newer copy, a forget drops the fact from every copy and refuses a read from before it, `external` facts never take a copy's place, and the section composes digest then personal prompt. |
| `apps/api/test-workers/sidekick-run-continuation.test.ts` | A Sidekick run's first activation starts with the Sidekick's facts, copied in at provisioning. |
| `apps/api/test/message-run-context.test.ts` | Which runs carry the personal prompt; the section is empty with no copy and no prompt. |
| `apps/api/test/memory-review.test.ts` | The four review routes over a real `WorkspaceDO`: own facts only under `/me/memory`, an own fact's source untitled once the room is closed to its person; the Organization's facts read-only to a member and removable by the owner; a Thread's own facts removable by a participant and 404 to a non-participant of a private one; a Breakout's under its `substreamId` and not under Main; a Channel's removable by an administrator and 404 where unlisted; a Personal Channel's removable by its owner; not found outside the scope and for a superseded fact; a repeat removal. |
| `apps/desktop/src/renderer/components/memory-review.test.tsx`, `title-pill-menu.test.tsx`, `screens/channel.test.tsx`, `screens/workspace-settings.test.tsx` | The rows' order, horizons judged from the fact's own dates (and turning Expired while open), Remove visibility, removal, refusal, a 404 as already removed, concurrent removals, the empty state; the pill's Memory level for a conversation and a Channel; Account's list. |
| `apps/api/test/scoped-memory.test.ts`, `test-workers/workspace-memory.test.ts` | The scopes and typed tables this module leaves in place. |

Traps: the Node fixtures seed `channels` and `channel_viewers` by hand (the
directory projection has no Node writer), so a visibility test that forgets a
participant row reads as "not a participant", which is the production default
too. `memory_sweep_state` is created by conversation migration 76; a test
object below it has no row and `nextMemorySweepAt` reads `null`.

## Data model

`WorkspaceDO`: `memory_facts` (indexed on subject and activity, FTS5 shadow
`memory_facts_fts`), `memory_sweep_receipts` (one row per conversation, keyed by
`memoryConversationKeyOf`),
`memory_fact_receipts` (tool replays), `memory_digest_holders` (every
conversation holding a digest copy, keyed by `memoryConversationKeyOf`),
`memory_digest_holder_facts` (the facts each principal's copy there was read
with), `memory_digest_sync` and `memory_digest_sync_state` (the copy-sync lane's
marks and revision counter), `memory_revision` (singleton: the ordering token of
digest reads). Conversation object: `memory_sweep_state` (singleton),
`memory_digest_copies` (one row per principal, with the `source_revision` it
was read at). Instants are Unix milliseconds. The retired
`memory_items`, `memory_items_fts`, `memory_mutations`, `memory_index_outbox`
and `run_memory_contexts` are gone; `run_scopes.memory_context_hash` stays,
always NULL, because `run_scopes` is a referenced parent.
[`data-model.md`](data-model.md) is authoritative.

## Security and trust model

Transcript text, remembered facts, titles and names are untrusted data in the
prompt's user message; the system prompt carries policy only
([`writing-prompts.md`](writing-prompts.md)). A fact's `derivedFrom` keeps the
trust class of its evidence so a later step can keep `external` facts out of
anything injected automatically (PRD design decision 11). The host computes it
from the cited messages' authors; the model's own `derivedFrom` is used only
when nothing it cites is in the window, and never defaults to `person`. The model's
`subjectKind` is a request the host checks against the placement, never an
authority. `retracted_by` records who forgot a fact.

## Changelog

### 2026-11-07 — A Canvas's Chat has its own memory source

**What changed:** A conversation whose parent is a Canvas is memory source
`canvas:<canvasId>`, filed under the stored subject kind `thread` with the
Canvas id. Its audience is the Canvas's: a person reads its facts when
`canvasReaderAllows` admits them, every member when the Canvas or its writer
Sidekick is Organization-wide.

**Why:** The Canvases and Sidekicks plan replaces `workstream:<id>` with
`canvas:<id>` for a Canvas's Chat. The stored subject kind stays `thread`
because `memory_facts.subject_kind` is under a CHECK, and widening it means
rebuilding the table, which the memory step that renames every subject kind
(plan step C-5) does once.

**Considered and rejected:** Leaving a Canvas's Chat with no memory until C-5,
which would make it the one conversation Rally forgets in.

**Consequences:** A reader of `subject_kind = 'thread'` must not assume the id
names a Channel; the titles a fact shows are looked up in `canvas_directory`
as well.

### 2026-10-19 — A person reviews and removes what Rally remembers where it lives

**What changed:** PRD rollout step 3, the last. Four reads and four removals
over one `MemoryReview` contract: `/workspace/me/memory` (the person's own
facts), `/workspace/memory` (the Organization's), `/workstreams/:id/memory`
(a Thread's or Breakout's) and `/spaces/:id/memory` (a Channel's);
`reviewMemoryFacts` on `WorkspaceDO` takes a scope and computes `removable`
through `mayForget`, and `forgetReviewedMemoryFact` is a forget with or
without a conversation. The desktop adds a **Memory** level to the title-pill
pop-out of a Channel, a Thread and a Breakout, and sections under Settings →
Account and Settings → Organization. The PRD's `state.md` moves to completed.

**Why:** Memory the person cannot see is memory they cannot trust or correct,
and the digest is what makes a wrong fact cost something. The product owner
placed the surface where each kind of fact lives: a conversation's facts beside
the conversation, a person's with their account, the Organization's with the
Organization, so nobody has to know where a fact was filed to find it. Own
facts are listed whether or not the source is still openable, because a fact
about a person they can no longer reach is exactly the one they most need to be
able to remove.

**Considered and rejected:** One panel in the Personal Channel listing
everything the person may see, built first and removed in the same pull
request: it put a Thread's facts a screen away from the Thread and the
Organization's in a place that is one person's alone. Letting any member remove
a shared fact they can see: design decision 14 keeps forgetting apart from
seeing, so a Channel's or the Organization's facts take an administrator here
as in the tool, while a Thread's take a participant, as `memory_forget` already
allows. Showing retracted facts with a restore action: nothing is deleted, so a
restore is possible, but nobody has asked for it and the chain is kept for that
day.

**Consequences:** A route never decides who sees or removes a fact; it passes a
scope and the store answers through its one visibility rule and one removal
rule. A removal reaches digest copies through the copy-sync lane, so a run that
starts in the moments before can see the fact once more. A guest has no review
surface because the `/workspace` mount is members-only; if guests ever hold
`person` facts the route needs its own mount.

### 2026-10-19 — Every activation starts with a digest rendered from its conversation's own copy

**What changed:** PRD rollout step 2. A run's system message carries the memory
digest: the facts relevant to the conversation and the acting person, rendered
by `renderMemoryDigest` from `memory_digest_copies` in the conversation object
(migration 77), composed with the personal system prompt into the harness's
`principalSystemSection`. The copy is refreshed at settlement, after a sweep
that wrote, by a forget in the same call, when a Sidekick run is provisioned,
and by the copy-sync lane (`WorkspaceDO` migration 117: holders and the facts
each copy holds, marks, triggers on every visibility input, `memory_revision`,
the `memory_digest_sync` alarm lane and Queue branch). `PERSONAL_SYSTEM_PROMPT_REASONS` moved to
`personal-system-prompt.ts` so the digest and the personal prompt share one
definition of "a run this person started".

**Why:** The PRD's reason for memory is that the model should not have to
decide to search: step 1 shipped recall-only, and a fact nobody recalls is a
fact nobody uses. Low latency is a goal, so the run reads nothing outside its
own object; the personal system prompt had already worked out the copy shape
and its lag, and the digest takes the same shape rather than a second one. The
injection form was the build's to choose (design decision 7): the per-principal
system section is rendered per request and excluded from compaction already,
which is exactly the "never replayed into another person's activation" rule,
and it costs no new mechanism.

**Considered and rejected:** Decorating the triggering user message with the
digest. With a persistent loop that message is committed to the ledger and
replayed to every later activation, so the decoration would have to be
ephemeral at render time, which is what the system section already is. Reading
`WorkspaceDO` at run start, overlapped with other startup work: no lag, but a
cross-object call in front of every first token, the trade the personal prompt
had already refused. Marking every holder on a retraction: correct, but a
forget in one Thread would refresh every copy in the Organization, so each copy
records the facts it was read with and a retraction marks only those holders.
Ordering copies by the `WorkspaceDO` clock: two reads in one millisecond
straddling a forget tie, so the order is a persisted revision instead. Keying a
holder by the fact source: every run of a Sidekick shares one. `DELETE`
triggers on the viewer tables: projection rebuilds delete and reinsert those
rows in bulk, and a mark per rebuild would refresh every conversation on every
projection.

**Consequences:** A principal's first run in a Thread or Breakout has no
digest; a new fact reaches a run from the next refresh; a retraction reaches other
conversations within one alarm tick and may be seen once more by a run that
starts before it lands. Both digest limits are placeholders the team owes.
Anything that changes what a reader may see has to reach copies either through
a mark (add a trigger, or a `markMemoryDigestHolders` or
`markMemoryDigestHoldersFor` call) or accept the next-run lag; a cache of rendered text would break expiry, which the renderer
applies at run time.

Shipped in the step-2 pull request on top of #1300.

### 2026-10-19 — Facts, sweeps and three tools replace the scoped-memory items store

**What changed:** `rally:memory` now reads a store of facts that a background
sweep writes after conversations settle, filed under subjects and carrying their
source conversations; the tools are `memory_recall`, `memory_remember` and
`memory_forget`. The prose half of scoped memory (`memory_items`, its FTS and
Vectorize index, the index outbox, the four `memory_search/add/update/invalidate`
tools) is gone, and so is admission-time recall for every run kind. Live items
were imported as facts by migration 116. The team struck the planned
`memory-sweep-enabled` kill switch before implementation; the lane ships on and
is stopped by a revert or a deploy.

**Why:** Nine memories across every production Organization after two months,
all written by the agent choosing a scope kind, is the measurement: a memory the
model has to decide to write is one it almost never writes, and one it has to
decide to search is one it rarely finds. The scope model also made the reader
pick where to look, which is the wrong party. Admission recall had already been
removed for message runs because its embedding cost 8.5 seconds on the critical
path. The PRD's research (`docs/PRDs/2026-10-18_agent-memory/research.md`)
surveys what every comparable product does instead: observe, extract in the
background, and attach. Visibility by source is what lets facts be promoted to
a Channel or the Organization without a parallel permission system: the
directory `WorkspaceDO` already keeps answers who may open the source today.

**Considered and rejected:** Running the sweep inline at settlement, as the
description loop does its model call. A Sol-class call on a 300-message window
holds a conversation object's settlement lane for the call's duration, and a
retry policy would have to be invented there; the Queue already has one, and
the thread-backfill lane had worked out one-claim-at-a-time. Keeping Vectorize
for semantic recall: the PRD chose FTS for the first release and Turbopuffer,
the text-search pipeline, when semantic recall is wanted. A kill switch: struck
by the team as a feature flag the product does not want to carry. A
per-participant join in SQL for visibility: replaced by batched queries per
source kind, because the join grew past reading.

**Consequences:** Every limit in the lane is a placeholder (`LIMIT UNSET`); the
team owes the numbers. `memory_scopes` must stay for `rally_tables`, and the
frozen lists that feed migrations 1 and 50 are not edited. `run_scopes.memory_context_hash`
is dead weight until a migration drops it. A future digest (PRD step 2) renders
from `recallMemoryFacts` with the same visibility rules and must not invent a
second one. Anything that changes who may open a conversation changes who may
read the facts learned there, with no write: that is the design, and a cache of
visibility decisions would break it.

Shipped in #1300. Design: `docs/PRDs/2026-10-18_agent-memory/prd.md` and `design.md`.
