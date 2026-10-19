# Agent memory: background sweeps, bi-temporal facts, and per-activation digests

> Created 2026-10-18.
>
> Rally gathers memory from its conversations in the background and brings a
> bounded digest to every run at no cost to latency. Companions:
> [`research.md`](research.md), [`design.md`](design.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Replaces [`agent-harness.md` scoped durable memory](../../agent-harness.md#scoped-durable-memory).

## Summary

Today Rally remembers something only when the agent, mid-task, decides to
call a memory tool. In ten weeks of dogfooding that happened twelve times,
nothing stored has an expiry, and no Organization-wide memory exists. This
PRD replaces that with memory Rally gathers on its own. After a Thread, a
Breakout or a Sidekick's conversation has been active and then rests, a sweep
on a Sol-class model reads what was said since the last sweep, together with
what Rally already remembers about that place, and records facts: standing ones
that hold until contradicted, and situational ones with a horizon ("out until
Thursday", "using the old endpoint until the migration lands"). Every fact
knows which conversation it came from, who said it, and when it was true.

A run then starts with a digest of what is relevant to its conversation and
to the person who started it, attached to their message and never shown in
the feed, with no new wait on any object and no model or embedding call. The
agent can ask for more with one recall tool, a person can tell Rally to
remember or forget something, and a person can see and prune what Rally
remembers about them. Short-term facts expire by their own date. A
disagreement between two people becomes a shared memory rather than a quiet
winner.

## Motivation

The current memory system is a well-built store that nothing writes to.
Production counts read on 2026-10-18 ([research.md §2.2](research.md#22-what-production-says)):
the dogfooding Organization, with 360 threads and 96 breakouts, holds nine
prose memory items from twelve lifetime writes, none with an expiry and none
at workspace scope; three other Organizations hold zero to one. Every stored
item is a standing instruction a person asked Rally to keep. Sidekick memory
tables, by contrast, hold 1,250 rows and are written daily, because a
Sidekick's instructions tell it to use them. The agent does not notice, mid
task, that something is worth keeping. The platforms and the literature
reached the same conclusion and moved the write to a background process
([research.md §3](research.md#3-how-the-major-platforms-do-memory),
[§4.2](research.md#42-when-to-extract-per-segment-not-per-message)).

The read side was priced out, not disproved. Automatic recall left the
message path on 2026-09-01 because the query embedding took 8.5 seconds and
returned nothing. Since then recall depends on the model choosing to call a
tool, which the evidence says it rarely does unprompted.

The cost of leaving it is that every Thread starts from nothing. A decision
taken in one Thread is unknown in the next; a colleague's preference stated
on Monday is gone by Tuesday; a deadline agreed in a Breakout is not known to
the Thread above it. The product's promise is an agent that works inside the
team's conversations, and an agent with no memory of them is a chat window.

The scope model also has gaps the redesign closes: a Breakout shares its
Thread's memory scope, one person's memories can be recalled into a Thread
others read, guests are checked by role but not access class, and no item
records which conversation it came from
([research.md §2.3](research.md#23-what-that-means-for-the-redesign)).

## Goals

1. A fact stated in a conversation is known to later runs in that
   conversation, in the conversations above it (its Thread, its Channels, the
   Organization where the placement allows), and to the person who stated it
   wherever they act, without anyone telling Rally to remember it.
2. A fact with a stated or reasonably inferred horizon stops being used when
   the horizon passes, with no action by anyone.
3. A fact that is contradicted by the same person is replaced; a fact
   contradicted by a different person becomes a shared memory of the
   disagreement; a fact a person retracts never returns from recall and
   leaves every conversation's digest as the retraction reaches its copy.
4. Memory adds no new wait between a message landing and the first provider
   request, on every path: a warm conversation, a cold one, a new Breakout, a
   new Thread, a Sidekick run.
5. A fact reaches an activation only if the person acting may open every
   conversation it came from today, and personal memory reaches only that
   person's own activations. The one widening this design accepts is named,
   not hidden: in a shared room, Rally's reply to a person may draw on what
   only that person told it (design decision 7).
6. The agent can ask for memory the digest left out, and a person can ask
   Rally to remember or forget something, each through one tool.
7. A person can see what Rally remembers about them and where each fact came
   from, and remove any of it.
8. The whole mechanism is a composition of blocks already in the tree where
   one exists: the description loop's gate and trigger, the structured
   inference gateway and a flag role, the usage meter, the activity Queue, the
   personal-prompt copy pattern, the per-run tail slot, the listing rules.

## Non-goals

1. **Semantic (vector) recall in the first release.** Facts are short and
   written in plain words to be found; FTS5 in `WorkspaceDO` is competitive
   and costs milliseconds. Deferred: when wanted, facts are indexed as one
   more source in the existing Turbopuffer pipeline, and the memory-only
   Vectorize index is retired with the old path
   ([research.md §9, decision 4](research.md#9-numbers-the-team-has-to-set-and-open-decisions)).
2. **Changing Sidekick memory tables.** They work and are structured run
   state, not prose memory. Unchanged.
3. **Memory in the system prompt.** The prefix stays byte-stable within a run
   and already varies per member. Promotion of a digest into the prefix at a
   compaction, through a resident-context kind, is deferred to its own
   decision and is not built here.
4. **A confidence score the model emits.** No published rule weighs one
   person's claim against another's; this PRD stores the inputs such a rule
   would need and leaves judgment to people. Rejected for now, not deferred.
5. **Memory for guests beyond what the two visibility predicates give.** A
   guest's run receives a Thread's facts where an explicit grant lets them
   open it, a Channel's facts only where the Channel is listed to them, and
   never Organization facts, because Organization facts carry a second
   predicate, `admitsOrganizationWide`, which admits no guest. No further
   special casing is built.
6. **Rewriting the compaction checkpoint.** It stays the per-conversation
   handoff summary. Memory is the cross-conversation layer beside it.
7. **A memory editor for Channel or Organization facts in the first release.**
   The personal review surface ships first; Channel and Organization facts are
   visible there with their source and removable by an administrator. A
   Channel-side editor is deferred.
8. **A second region.** Nothing here crosses the regional boundary; a second
   region gets its own store the way it gets its own `WorkspaceDO`.
9. **Sweeping a Channel's own feed.** `space_messages` lives in `WorkspaceDO`
   with text ids and `posted_at`, has no agent run to settle and no transcript
   sequence, and holds eight rows in the dogfooding Organization, most of them
   merge-back posts whose content a Thread sweep already saw. Deferred: it
   needs a `WorkspaceDO`-side lane with a `(posted_at, message_id)` cursor
   that survives keyed `replace` reposts and message-id evidence. The
   `space:<spaceId>` source shape is defined now so that lane can use it.

## Product behavior

**Vocabulary.** A *fact* is one or two sentences Rally remembers. A fact has a
*subject* (the Organization, a Channel, a Thread, a Breakout, or a person),
which decides where it is relevant, and a *source conversation*, which decides
who may see it. A fact is *standing* or *situational*; a situational fact has
a horizon. The *digest* is the bounded text of the facts relevant to one
activation.

**Nothing to do.** People use Threads, Breakouts and Channels as they do now.
There is no "remember this" step. A person may still say "remember that …" or
"forget that …" in a message, and Rally does, through the tools below.

**What a run sees.** Each activation receives, attached to the message that
started it and visible only to the model, a digest headed as fallible
remembered context: Organization facts, then the Channel's, the Thread's, and
in a Breakout the Breakout's, then the acting person's own. Standing facts
come first; situational facts carry their horizon ("until 2026-10-23").
The Organization, Channel, Thread and Breakout facts are those every current
participant of the conversation may see, the same rule recall applies, so a
Breakout member acting in the Thread above it is not handed the Breakout's
facts where others would read the reply; the acting person's own facts are
included whatever the room (design decision 7). The digest is bounded; when
it is cut, the oldest facts of the widest subject go first, so this
conversation's and the person's own facts are kept longest, and the digest
says how many were left out.
Nothing of this appears in the feed, and nothing of it is replayed into an
activation another person starts.

**Empty.** A new Organization, Channel, Thread or Breakout has no facts and
the digest is omitted entirely; the run is byte-identical to today's. A new
Breakout inherits its Thread's and Channel's digest from its first run; a new
Thread inherits its Channel's and the Organization's.

**Sweeping.** After a conversation has been active and has rested, Rally
sweeps the messages since the last sweep. The person sees nothing. Agent turns
and tool rows are not read; messages from people inside Rally and from
external actors (Slack, email) are. The sweep records new facts, updates or
retracts facts the conversation contradicted, confirms facts it restated, and
records a disagreement between two people as one shared fact carrying both
claims, their authors and their dates.

**Horizons.** When a person states a horizon, the sweep uses it. When the
horizon is implied by an event ("until the migration lands") the fact carries
that basis and a review date. When nothing is stated, a default horizon for
that class of fact applies and the fact records that it was assumed. A fact
past its horizon is not used, is not deleted, and is shown as expired in the
review surface.

**Asking for more.** The agent has `memory_recall`, which searches the facts
the acting person may see, intersected with what this conversation's
participants may see, and returns facts with their dates and a link to the
message each came from. It has `memory_remember`, which writes a fact under
the current conversation as source when a person asks, and `memory_forget`,
which retracts one. A member may forget their own facts and facts the
current conversation established; a Channel's or the Organization's facts
are forgotten only when an administrator asks, and the tool says so to
anyone else. The transcript shows these as ordinary tool activity rows.

**Reviewing.** In their Personal Channel a person sees "What Rally
remembers": their own facts, each with the message it came from, its horizon
if any, and whether it is expired. They can remove any fact. Removal is
immediate for recall, which reads the store, and reaches each conversation's
digest copy through the copy-sync lane within one alarm tick; a run that
starts in a conversation in the moments before its copy is refreshed can see
the fact once more, and that is the whole lag ([`design.md` §7](design.md#7-digest)).
Facts about the Organization and about Channels the person may open are
listed below their own, read-only for a member and removable by an
administrator.

**Sidekicks.** A Sidekick keeps memory of its own, as its `sidekick` scope
does today: facts with subject `sidekick:<automationId>`, swept from the
Sidekick's drafting conversation and its runs, visible wherever the Sidekick's
own authority reaches and nowhere else. A run receives the digest of its home
conversation, when it has one, plus the Sidekick's own facts, in place of the
automatic recall it freezes today, which also removes the embedding call
those runs still make. A personal or workspace Sidekick with no home receives
its own facts alone. Sidekick tables are unchanged.

**Failure.** A sweep that fails leaves the previous facts in force and is
retried by its lane; a digest copy that is stale by one turn is used as is;
a run with no digest copy at all runs as today. Memory never blocks a run and
never fails one.

## Impact on the product contract

None in the brief's clauses on what a work stream is, on participation, on
channels, or on global search. One sentence of the brief's spirit moves from
implicit to explicit: the agent now carries knowledge *between* conversations
in an Organization, scoped by what the acting person may open. Viewing still
does not imply participation; a fact's reach is the reach of the conversation
that produced it, evaluated at read time.

## Key design decisions

1. **Background sweeps, not agent-initiated writes.** Twelve writes in ten
   weeks; every platform surveyed moved the write offline; per-segment
   extraction beats per-message on cost and accuracy. Rejected: keeping the
   tool-call write as the primary path with a better prompt.
2. **Facts in rows, not notes.** Rally's hierarchy nests Breakouts inside
   Threads inside Channels, and only per-fact source gives exact visibility.
   Rows also carry temporal validity and a supersession chain; every study of
   repeated note rewriting found drift. Rejected: curated Markdown notes per
   place (the Claude Tag shape), which fits Slack's flat channels and not
   Rally's. Borrowed from it: the digest renders as a readable page in the
   review surface.
3. **One store in `WorkspaceDO`, digests copied out.** Rejected:
   conversation-local memory with promotion, which makes two stores for one
   concept and loses cross-Thread recall of anything the sweep did not
   promote.
4. **Subject and source as two axes.** Subject decides relevance; the source
   conversation decides visibility, evaluated at read time through the same
   SQL fragments the directory renders, so membership changes need no fan-out.
   Rejected: a stored audience list per fact.
5. **Bi-temporal facts, superseded by the sweep with the existing facts in
   view.** `valid_from`, `valid_until` for when a fact was true;
   `recorded_at`, `superseded_at`, `retracted_at` for when Rally knew; nothing
   is deleted. The sweep model decides `update`, `retract` or `confirm` with
   the matching existing facts beside the new text, and writes the
   disagreement fact of decision 8 when the contradiction is between two
   people. Rejected: similarity-gated updates, which cannot tell a
   contradiction from a duplicate. Deferred: a host-parsed `(subject,
   relation)` key with deterministic supersession (the MemStrata result in
   [research.md §4.3](research.md#43-time-bi-temporal-rows-deterministic-supersession-no-access-decay-for-deadlines));
   with the model already deciding over the same facts it would be a second
   mechanism for one decision, and the key it would run on is model-written
   anyway. It is one column away if the measured stale rate asks for it.
6. **Expiry by predicate.** Reads filter on `valid_until`; nothing is deleted
   and no alarm fires. Rejected: access-based decay, which keeps a deadline
   alive as long as it is read.
7. **Digest attached to the triggering message, per activation.** Decided
   with the product owner on 2026-10-18: personal memory follows the acting
   person into every activation they start, attached to their message, hidden
   from the feed, never replayed into another person's activation; Channel
   and Thread memory nest the same way. The accepted consequence is that
   Rally's reply in a shared room may draw on what only the asker told it.
   Rejected: an intersection rule that withholds personal memory in shared
   rooms. Left to the build: ephemeral decoration of the rendered request
   (safer default) or a principal-filtered durable derived input (cache
   optimization), per [research.md B11](research.md#6-the-building-blocks).
   In either form the digest is excluded from the compaction summariser's
   input and from the checkpoint, so one person's digest cannot reach a later
   speaker through the shared summary ([`design.md` §7](design.md#7-digest)).
8. **A disagreement between people is a shared memory.** Decided 2026-10-18:
   the sweep writes one Channel-level or Organization-level fact carrying both
   claims, their authors and dates, superseded when the team settles it. One
   person contradicting themselves is an ordinary update. Rejected: newest
   wins, and a model-emitted confidence.
9. **FTS only in the first release; Turbopuffer, not Vectorize or a new
   vendor, when semantic recall is wanted.** The text-search pipeline already
   has per-Organization namespaces, the embedding path, the outbox and
   audience groups that map onto the source rule, and Turbopuffer fuses BM25
   and vectors server-side in one request. Embeddings only ever run inside an
   explicit recall call, never at run start.
10. **The sweep is a flag role on a strong model.** `agent-model-memory-sweep`,
    default Sol-class. At Rally's volume a strong model is affordable, the
    judgments (what a colleague would need later, a fact's horizon, which fact
    a sentence supersedes) are the ones small models get wrong, and the flag
    makes the choice reversible. Metered as `memory_sweep`, Organization pays.
11. **External-derived facts are recall-only.** A fact whose only evidence is
    Slack or email text does not enter the digest; it is returned by
    `memory_recall` with its trust class shown. Rejected: treating all
    evidence alike, given the measured success of poisoning writes from
    external content.
12. **No feature flag.** The sweep ships on for every Organization on merge
    and is not gated or staged behind a product flag (team decision,
    2026-10-19). Stopping it is a revert or a deploy, the same as any other
    lane. The `agent-model-memory-sweep` role is model routing with a
    checked-in default, not a switch: its resolver falls back to the Worker
    model when no flag exists, so no Flagship entry is needed to ship it.
    Rejected: a `memory-sweep-enabled` kill switch, which the earlier draft
    carried.
13. **Every fact keeps its source, Organization facts included.** Visibility
    follows the source conversation's current reach, so narrowing a Channel
    to private withdraws the facts promoted from it at the next read.
    Rejected: a null source for promoted facts.
14. **Forgetting is authorized apart from seeing.** Members retract their own
    and the current conversation's facts; Channel and Organization facts need
    an administrator. Rejected: letting any participant who can recall a
    shared fact retract it.
15. **A sweep sees only what its conversation's participants may see, and a
    derived fact keeps every source.** Candidates handed to the sweep model
    are restricted to facts every current participant of the swept
    conversation may open, and an update or disagreement derived from a
    candidate carries the candidate's source as well as the sweep's.
    Rejected: candidates by subject alone, which would let a public Thread's
    sweep restate a private Breakout's words under the public source.

## Data model

Sketch; the migration and [`data-model.md`](../../data-model.md) are
authoritative.

`WorkspaceDO`:

- `memory_facts`: `fact_id`, `subject_kind` (`organization` | `channel` |
  `thread` | `breakout` | `person` | `sidekick`), `subject_id`,
  `source_conversation` (`<channelId>` for a Thread's Main,
  `<channelId>/<breakoutId>` for a Breakout, `sidekick:<automationId>` for a
  Sidekick's own conversation or run, `space:<spaceId>` for a Channel's own
  feed once that lane exists; never null, an
  Organization fact included, so a fact promoted from a Channel that is later
  narrowed to private follows the Channel's current reach; a fact derived
  from a candidate carries the union of its sources, and a reader needs
  access to every one), `kind` (`standing` | `situational`),
  `text`, `valid_from`, `valid_until`, `valid_until_basis` (`stated` |
  `event` | `assumed`), `recorded_at`, `superseded_at`, `superseded_by`,
  `retracted_at`, `retracted_by_json`, `retraction_reason`,
  `last_confirmed_at`, `derived_from` (`person` | `external` | `agent` |
  `mixed`), `evidence_json` (message references with author and time, which
  is where "when it was said" lives), `revision`. FTS5 over `text`.
  `valid_from` is kept because a future-start fact must render as upcoming,
  not current; `last_confirmed_at` because `confirm` and the review surface
  read it.
- `memory_sweep_receipts`: one row per applied sweep, `conversation`,
  `from_seq`, `to_seq`, operations applied, the model and usage, and the
  fact list the swept conversation's copy is refreshed from; the
  compare-and-swap on `from_seq` lives here. There is no separate digest
  table in `WorkspaceDO`: a copy is rendered from the facts when it is
  refreshed, and the copy is the only thing the hot path reads.
- Existing `memory_items`, `memory_mutations` and `memory_index_outbox`:
  every active item in every Organization imports as a `standing` fact in
  step 1, before the tables retire. Scope kind maps to subject: `user` to
  `person:<userId>`, `workstream` to `thread:<workstreamId>`, `sidekick` to
  `sidekick:<automationId>`, `workspace` to `organization`. The source is
  `provenance_json.workstreamId` when the item has one; otherwise a `person`
  fact takes the person's Personal Channel (`space:<personalSpaceId>`), a
  `sidekick` fact takes `sidekick:<automationId>`, and an `organization`
  fact takes the Organization's General Channel (`space:<generalSpaceId>`),
  which is Organization-wide. Expired and invalidated items are not imported.
  These three tables and the Vectorize projection then retire with the old
  plugin. **`memory_scopes` stays**: `memory_tables` and
  `memory_table_rows` reference it with cascading foreign keys and the table
  tools resolve scopes through it, so retiring it would delete Sidekick table
  state. `memory_tables*` are untouched.

`SubstreamAgent` (each conversation object):

- `memory_sweep_state`: `swept_through_seq`, `rest_until`,
  `consecutive_quiet`, `last_outcome`, beside `description_refresh_state`.
- `memory_digest_copies`: `user_id` (nullable), `source_revision`,
  `refreshed_at`, and `facts_json`: the digest's facts as structured rows
  (`fact_id`, `subject_kind`, `subject_label`, `kind`, `text`, `valid_from`,
  `valid_until`, `conflict`), not rendered text. The run renders the digest
  locally at start, applying the date predicates then, so a fact that
  expired or has not started yet is handled exactly without any read beyond
  the object. Retraction and visibility narrowing reach copies through the
  copy-sync lane (the Channel colour-sync shape: a trigger marks the affected
  conversations with a revision, the `WorkspaceDO` alarm sends one batch to
  the activity Queue, the consumer refreshes each copy), and through the
  ordinary refresh after each run.

Backfill: none required. Existing conversations are swept forward from their
current head; the team may run a `thread_backfill` job over open Threads if
historical memory is wanted.

## Security and trust model

- **Memory is data.** The digest renders under a heading that denies it
  authority; the sweep prompt rejects imperative content; a fact is never an
  instruction. Text from external actors stays evidence and, by design
  decision 11, out of the digest.
- **Write authorization.** Only the sweep lane and the two person-initiated
  tools write. Every fact records its evidence and author; every sweep
  records its receipt. Retraction is authorized separately from visibility:
  a member may retract their own facts and the current conversation's;
  Channel and Organization facts need an administrator
  ([`design.md` §5](design.md#5-authority-safety-lifecycle)).
- **Principal-scoped reads.** `memory_recall` and the digest both filter by
  what the acting person may open, through the listing rules, and the
  intersection with the conversation's participants is applied to recall.
  The index never grants access; hits are reloaded from `WorkspaceDO`.
- **Personal memory in shared rooms** is the accepted exposure of design
  decision 7, limited to the acting person's own activations and reviewable
  in their Personal Channel.
- **Open limits**, each written at its open value with the `LIMIT UNSET`
  marker and handed back under Rollout: sweep rest floor and ceiling,
  human-message and character floors, window overlap, digest token budget per
  conversation and per person, default horizon per situational class, facts
  per subject before consolidation.

## Agent behavior

The `rally_memory` plugin is replaced by one with three tools, always active
in root runs: `memory_recall(query, limit?)`, `memory_remember(text, kind,
validUntil?, about?)`, `memory_forget(factId)`. The model never names a scope
or a subject for recall; the host derives both. A fact written by
`memory_remember` takes the trust class of the input that started the run, so
a Slack or email message that talks the model into "remembering" writes an
`external` fact, which stays out of digests (design decision 11). The model
is told that remembered context is fallible and is the asker's, and is no
longer told to search before writing, because it no longer writes on its own. Sidekick runs receive the
home conversation's digest and lose the frozen admission recall. Inline child
runs receive nothing, as today.

## Rollout

Ships to everybody on merge, in three steps, each a pull request:

1. **Store, sweep and tools**, with the digest *not yet injected*: the
   recall-only baseline of [research.md §7.0](research.md#70-baseline-recall-only).
   The old plugin's tools are removed, its items imported, and
   `freezeRunMemoryContext` is deleted for every run kind that still calls
   it (Sidekick runs, scheduled wake-ups, connector and activity triggers,
   manual retries, agent-to-agent messages), so no run reads the retired
   store or pays the admission embedding. Until step 2 every run kind is
   recall-only; `memory_recall` is the only read.
2. **Digest copies and injection** for every run kind, attached to the
   triggering input per design decision 7: a person's message, a Sidekick
   run's trigger, a wake-up, a connector event. A Sidekick run's digest is
   its home conversation's, when it has one, plus the Sidekick's own facts.
3. **Review surface** in the Personal Channel.

Turning it off: there is no feature flag (design decision 12). The lane is
stopped the way any other background lane is, by reverting or deploying.
Each step merges complete and on; a step that is not ready does not merge.

Numbers for the team, each open in step 1 ([research.md §9](research.md#9-numbers-the-team-has-to-set-and-open-decisions)
has the arithmetic): sweep rest floor and ceiling; human-message and
character floors; window overlap; digest token budget per conversation and
per person; default horizon per situational class; facts per subject before
consolidation.

## Decision log

- **2026-10-19, no feature flags.** The team struck the `memory-sweep-enabled`
  kill switch from step 1 before implementation began. Design decision 12 and
  Rollout now say the lane ships on, ungated, and is stopped by a revert or a
  deploy. No product flag is created for memory.
- **2026-10-19, digest injection form.** Step 2 carries the digest in the
  harness's per-principal system section (`principalSystemSection`), the field
  the personal system prompt already uses: rendered per request for the acting
  principal, never written to the transcript or the ledger, excluded from the
  compaction summary. Design decision 7 left the form to the build; this is the
  ephemeral form, chosen over decorating the committed user message, which a
  persistent loop would replay. Copies are refreshed at settlement, after a
  sweep, by a forget, and by a copy-sync lane that marks every holder on a
  retraction or a scope narrowing ([`plan.md` §7](plan.md#7-step-2-digest-copies-and-injection)).
