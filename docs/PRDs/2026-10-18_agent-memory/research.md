# Agent memory for Rally: research and competing designs

> Created 2026-10-18. Research, not a PRD. It surveys how the major assistant
> platforms and the research literature handle long-term memory, records what
> Rally's own memory does in production today, and lays out competing designs
> for a replacement built around background memory sweeps over Channel, Thread
> and Breakout feeds. Nothing here is approved. The standing product contract is
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md);
> the current mechanism is documented in
> [`agent-harness.md`](../../agent-harness.md#scoped-durable-memory).

## 1. The ask

Treat the current memory system as fully replaceable. Design memory as a
trailing window over each conversation's message feed: a background sweep, run
on a Sol-class model or better, reads what was said since the last sweep and
decides what Rally should remember. Two kinds of memory matter: short-term
memories with a known, stated, or reasonably assumed expiry, and long-term
memories that stand until something contradicts them. Memories must be
updatable, must reach the agent without the agent asking, and must also be
available when the agent asks. The hard constraint throughout is latency: the
design may add nothing measurable to inference or to substream startup, warm or
cold, new or existing.

## 2. What Rally has today

### 2.1 The mechanism

Memory is a tool the agent may call. Every root run carries the always-active
`rally_memory` plugin (`memory_search`, `memory_add`, `memory_update`,
`memory_invalidate`) and the `rally_tables` plugin for structured collections.
A memory item is one piece of prose in `WorkspaceDO`'s `memory_items` table,
owned by a scope of kind `workspace`, `user`, `workstream` or `sidekick`, with a
revision, an optional `expires_at` the model may supply, structured provenance,
reversible invalidation, and an append-only mutation receipt per write. FTS5
indexes the text synchronously. A replayable outbox embeds each revision with
`qwen/qwen3-embedding-8b` through OpenRouter into a regional Vectorize index,
and search is hybrid with an FTS-only fallback.

The host derives the scope union from the run's frozen principal and parent
kind (`resolveMemoryAccess`); the model never names a scope. Workspace-scope
writes need a workspace principal or an owner or administrator.

Two facts about the read path decide a lot of what follows:

- **Automatic recall left the message path on 2026-09-01.** Production traces
  showed the fixed Qwen query embedding taking 8.46 to 8.83 seconds before the
  first model call on ordinary composer messages, while the vector leg failed
  and FTS returned nothing. Composer messages, elicitation answers, inbound
  email and Slack messages now go straight from the durable transcript to the
  model. Only non-message runs (Sidekick runs, timers) still freeze an admission
  recall snapshot. ([`agent-harness.md`, 2026-09-01](../../agent-harness.md#changelog).)
- **Nothing writes memory except the agent, mid-task.** No process reads a
  transcript afterwards and asks what should be kept.

Around it sit four mechanisms that are memory-shaped without being called that,
and that any redesign should reuse rather than duplicate:

| Mechanism | What it already does | Owning document |
| --- | --- | --- |
| Context compaction | Per-conversation handoff summary (request, decisions, done, facts, open) at 80% of the window; the next run replays it as its prefix. | [`context-compaction.md`](../../context-compaction.md) |
| Description loop | After every terminal run, reads a transcript window (72 h or 200 messages, cap 600), gates on *rested and changed*, asks a model one question, applies the answer under guards. | [`workstream-descriptions.md`](../../workstream-descriptions.md) |
| Personal system prompt | A `WorkspaceDO` value copied into each conversation object and refreshed in `waitUntil`, so inference never waits on `WorkspaceDO`. One-turn lag accepted. | [`personal-system-prompt.md`](../../personal-system-prompt.md) |
| Resident context | A ledger of content blocks delivered once as tail messages and moved into the system prompt only at a compaction, for a bounded number of compactions. | [`resident-context.md`](../../resident-context.md) |

### 2.2 What production says

Read on 2026-10-18 through the engineering MCP, read-only, from the Global
region. Thirty-five Organizations exist there. Juno Labs is the dogfooding
Organization and by far the most active.

| Organization | Threads (open) | Breakouts | Memory items (active) | Memory writes, lifetime | Items with an expiry | Workspace-scope items | Table rows |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Juno Labs | 360 (142) | 96 | 9 (8) | 12 (Aug 9, Sep 2, Oct 1) | 0 | 0 | 1,256 |
| Forward Search | 26 | 26 | 0 | 0 | 0 | 0 | 0 |
| AI Fund | 1 | 0 | 1 | 1 | 0 | 0 | 0 |
| Northstar Capital | 1 | 0 | 0 | 0 | 0 | 0 | 0 |

The nine Juno Labs items split 4 `user` and 5 `workstream`. Every one is a
standing instruction or recurring fact that somebody told Rally to keep:
Linear ticket-writing guidelines, Slack-to-Linear triage rules, a personal
summary format, a nickname, and the schedules of three recurring meetings. The
four `user` items account for 389 of the 405 lifetime reads. Nothing came from
ordinary conversation, nothing is short-term, and no Organization-wide memory
exists anywhere.

The tables tell the opposite story: 11 Sidekick tables with 1,250 rows,
written today. That is the `polling-for-events` pattern, a keyed table that
stops a run re-reporting what the last one saw. It works because a Sidekick's
instructions tell it to use the table on every run.

### 2.3 What that means for the redesign

- **Agent-initiated writing does not happen in ordinary work.** Two and a half
  months of heavy dogfooding produced twelve writes. The model is busy with the
  task; "notice this is worth keeping" is a second job it does not do. The
  platforms and the research both moved the write to a background process for
  this reason (sections 3 and 4). The ask is right to start there.
- **Automatic recall was priced out by the embedding, not by the idea.** FTS in
  the object is synchronous and costs milliseconds. The design below keeps
  embeddings off every hot path and treats semantic recall as optional.
- **Expiry exists as a column nobody fills.** Short-term memory needs the
  writer to decide the horizon, which again points at a sweep that sees the
  whole exchange rather than a tool call made mid-sentence.
- **Tables are not the problem.** They are structured run state and should
  stay as they are. This research is about prose memory.
- **There is no Organization memory.** Everything stored is private to a
  person or a thread, so a second person asking the same question in a second
  thread starts from nothing.

## 3. How the major platforms do memory

<!-- fill: platform survey from the commercial research agent -->

## 4. What the research says

<!-- fill: academic and open-source survey from the research agent -->

## 5. What Rally imposes on any design

These are not preferences. Each is a rule the tree already enforces, with the
document that owns it.

1. **Inference never waits on another object.** The personal system prompt is
   the precedent: the conversation object renders from a local copy, and the
   refresh runs after the turn. The 2026-09-01 removal of admission recall is
   the other precedent. A memory read at run start is a synchronous read of the
   conversation object's own SQLite, or it is nothing. No `WorkspaceDO` RPC, no
   D1, no KV, no embedding call sits between a message landing and the first
   provider request. ([`personal-system-prompt.md`](../../personal-system-prompt.md),
   [`agent-harness.md`](../../agent-harness.md#changelog).)
2. **The prefix is byte-stable within a run.** Per-run values ride a user-role
   message, never the system message. The system prompt changes only at a
   compaction, where the provider's cache is already lost, or at a source
   invalidation. So injected memory goes in the per-run context message, and
   may enter the prefix only at a compaction, through the resident-context
   ledger. ([`writing-prompts.md` §13](../../writing-prompts.md),
   [`resident-context.md`](../../resident-context.md).)
3. **Memory is data, never policy.** A remembered fact was said by a person, or
   by a Slack user, or by a tool. It renders under a heading that denies it
   authority, and text that came from an external actor stays evidence.
   Carrying a new kind of content into the prefix at compaction is "a new
   decision in a new PRD", which this folder can become.
   ([`writing-prompts.md` §12](../../writing-prompts.md).)
4. **Memory may not widen who learns what.** The listing ladder decides what
   may be named and each conversation's own authority decides what may be read.
   The search index "does not grant access": hits are reloaded and
   reauthorized. Memory follows the same rule, so a memory derived from a
   Breakout is readable only by somebody who may open that Breakout, however it
   is stored or indexed. ([`listing-rules.md`](../../listing-rules.md),
   [`text-search.md`](../../text-search.md), [`authorization.md`](../../authorization.md).)
5. **No guessed limits.** Every cap, floor, horizon and token budget in this
   document is named and handed back in section 9. The implementing change
   writes each one open.
   ([`adding-security-defensive-and-other-limits.md`](../../adding-security-defensive-and-other-limits.md).)
6. **Hops ride the platform's primitives.** A Queue is the default between a
   Worker and an object; an object has one alarm and a shared list of reasons;
   every model call goes through the structured-inference gateway under a flag
   role and a metered activity. ([`choosing-queues-or-rpc.md`](../../choosing-queues-or-rpc.md),
   [`durable-object-alarms.md`](../../durable-object-alarms.md),
   [`feature-flags.md`](../../feature-flags.md), [`usage-metering.md`](../../usage-metering.md).)
7. **Build for the product that exists.** Thirty-five Organizations, a few
   hundred threads in the largest, no metrics stack. Prefer the option that is
   cheapest to reverse and whose failure we would notice.
8. **Server-side.** Memory is a server capability every client gets for free.
   Review and editing surfaces land on desktop and web first.

A note on the model named in the ask. `openai/gpt-6.1-sol` is the checked-in
primary for the work-stream agent; the live flag currently routes that role to
`openai/gpt-5.6-terra` with Gemini 3.8 Flash and Grok 4.6 as fallbacks, and the
description loop also runs live on Terra. A sweep role gets its own flag, so
"Sol or higher" is a flag value, not a code change.

## 6. The building blocks

Platform mindset first: the designs in section 7 are compositions of the
blocks below, and most blocks are shared. A block that two designs would build
differently is marked.

**B1. Sweep cursor.** One row per conversation in the conversation object:
`swept_through_seq`, `rest_until`, `consecutive_quiet`, `last_outcome`. It is
the transcript's own cursor, so it lives beside the transcript, exactly where
the description loop keeps its `rest_until`. A Channel's own feed
(`space_messages`, eight rows in the dogfood Organization) gets the same cursor
in `WorkspaceDO`.

**B2. Sweep gate.** The description loop's conjunction, minus the novelty gate
it has no description to compare against: the conversation has *rested* (a
stored instant, doubling on consecutive quiet sweeps up to a ceiling, reset by a
sweep that wrote something) *and* has *changed* (new human-authored messages
above a floor, new human text above a character floor). Agent turns and tool
rows never count. External actors (Slack, email) count as people. Both floors
are the team's numbers.

**B3. Sweep trigger.** Two sources, both already in the tree: run settlement
(the moment the description loop uses) and a derived alarm candidate for
"unswept human messages exist and `rest_until` has passed", which covers people
talking to each other in a thread without waking Rally. The conversation object
publishes a `memory_sweep` job to a Queue with `(conversation, from_seq,
to_seq)`; it does not call the model itself.

**B4. Sweep job.** The consumer reads the window from the conversation object
(the messages after the cursor plus a fixed overlap of earlier messages for
coreference, tool rows excluded), reads the memories already held for the
conversation's subjects (FTS over the window's terms, plus every unexpired
short-term memory on those subjects), and makes one structured call on the
`memory_sweep` role. The prompt sees both the window and the existing memories
and answers with operations, not with a fresh list. The call is metered as its
own activity, paid by the Organization.

**B5. Reconciliation.** The operation set is the one Mem0 and Graphiti
converged on and section 4 details: `add`, `update` (which supersedes the
earlier revision rather than editing it), `retract` (the fact is now false), and
`confirm` (nothing new, bump `last_confirmed_at`). Applied in one `WorkspaceDO`
transaction that is fenced on the cursor: the job carries the `from_seq` it
read, and a write whose cursor has moved is dropped. That is `redescribe`'s
compare-and-swap, applied to memory.

**B6. Two axes: subject and source.** A memory has a *subject*, which decides
where it is relevant, and a *source conversation*, which decides who may see
it. Subjects are `organization`, `channel:<spaceId>`, `thread:<channelId>`,
`breakout:<channelId>/<breakoutId>` and `person:<userId>`. The sweep picks the
subject from the conversation's placement: a fact from a thread placed in an
Organization-wide Channel may be filed under the thread, the Channel or the
Organization; a fact from a private Channel's thread can rise no higher than
that Channel; a fact from a Breakout defaults to the Breakout. Visibility is
never a stored list. At read time a memory is visible to a person if they may
open its source conversation today (`mainOpenableSql` and the Breakout rule,
the same fragments the directory renders), so adding somebody to a Breakout
shows them its memories and removing them hides them, with no fan-out write.

**B7. The record.** Design A stores facts, Design B stores notes, Design C
stores facts in two places. The fact shape is bi-temporal, following Graphiti:
when it was true (`observed_at`, `valid_from`, `valid_until`) separately from
when Rally knew it (`recorded_at`, `superseded_at`, `retracted_at`). `kind` is
`standing` or `situational`; a situational fact always has a `valid_until`, and
`valid_until_basis` records whether the person stated it, the sweep inferred it
from an event, or a default horizon was assumed. `derived_from` records the
trust class of the evidence (`person`, `external`, `agent`, `mixed`).
`evidence` lists the message sequences the fact came from, which is also what a
"where did Rally learn this" link renders. There is no confidence column; the
current system decided against one and nothing here needs it.

**B8. Expiry by predicate.** Reads filter `valid_until IS NULL OR valid_until >
now` and `superseded_at IS NULL AND retracted_at IS NULL`. Expiry therefore
costs nothing at inference and needs no alarm. An occasional cleanup of
long-expired rows is housekeeping, not correctness.

**B9. Digest render.** A pure function from a set of facts to bounded text:
grouped by subject from widest to narrowest, standing facts first, situational
facts with their "until" date, each line ending in a short id, sorted
deterministically, truncated newest-first under a token budget with the
truncation stated. Its hash is the digest's identity, so an unchanged digest
costs no write and no delivery.

**B10. Projection to the conversation object.** The digest a conversation will
inject is computed where the facts live (`WorkspaceDO`) and copied into the
conversation object ahead of time, by the same copy-and-refresh pattern the
personal system prompt uses, and additionally written straight to the swept
conversation by the sweep job so the conversation that just produced new memory
sees it on its very next run. A per-person digest for the acting member is a
second copy keyed by user, refreshed the same way.

**B11. Injection slot.** The run already sends one per-run user-role message
carrying time, reason and ids. The digest rides in it, under a heading that
names it remembered context and denies it authority. It is delivered once per
run, at the first model call; a digest that changes mid-run waits for the next
run. Promotion into the system prompt at a compaction is possible through a new
resident-context kind, and is a separate decision (section 9).

**B12. Recall tools.** `memory_recall(query, scope?)` runs FTS in `WorkspaceDO`
over the facts the acting person may see, intersected with what the
conversation's participants may see, and returns facts with their dates and a
source link. `memory_remember(text, kind, valid_until?)` writes a fact when a
person asks Rally to remember something, under the conversation as source.
`memory_forget(id)` retracts. Three tools; no scope parameter the model could
widen. Semantic recall over facts, if wanted, rides the existing Turbopuffer
pipeline asynchronously; the Vectorize path and its embedding-on-read are
retired.

**B13. Review surface.** A person's memories are listed and editable in their
Personal Channel; a Channel's and the Organization's in the Channel's details
rail. Each row shows its evidence link and its horizon. Out of scope for this
document beyond naming where it goes.

## 7. Competing designs

Each design is described the same way: what is stored, how memory is written,
how it reaches a run, how it is updated and expires, how multiple people are
kept apart, where the latency goes on each startup path, what it costs, what it
reuses, and where it fails.

The startup paths that matter, from
[`performance-tracing.md`](../../performance-tracing.md) and
[`substream-creation.md`](../../substream-creation.md):

| Path | What happens today | Where memory could add time |
| --- | --- | --- |
| Warm existing conversation | The persistent loop is resident; run context, tools, transcript bootstrap and attachment replay run concurrently. | A read inside `run_context_ms`. |
| Cold existing conversation | The object wakes, runs migrations, rebuilds the projection from SQLite. | The same local read, after wake. |
| New Breakout | `prepare` freezes and summarizes context while the person types; `confirm` carries the message. Target P50 under 1 s, P90 under 2 s. | Seeding the child's copy during `prepare`. |
| New thread | Creation writes the provisional row and defers the model-dependent steps. | Seeding the child's copy at creation, inside `WorkspaceDO`. |
| Sidekick run | Non-message run; freezes admission recall today. | Replacing that recall with the home conversation's digest. |

### 7.0 Baseline: recall only

Nothing is injected. Facts are swept and stored (B1 to B8), and the agent has
the recall tools (B12). The per-run context message carries one line: how many
memories exist for this conversation's subjects and when the newest was
recorded, so the model knows there is something to ask for.

- **Latency.** Zero on every path; the one line is computed from a count the
  conversation object already holds.
- **Cost.** Sweeps only. No per-run tokens unless the model recalls.
- **Weakness.** Everything rests on the model deciding to call the tool.
  Section 4 records what the literature says about agents under-using
  retrieval; the dogfood evidence above (twelve writes in ten weeks) is the
  same failure on the write side. A Sol-class model does better than a small
  one, but routing is a flag and the fallbacks are small models.
- **Why it is here.** It is phase one of every other design, and the control
  the others are judged against.

### 7.1 Design A: fact ledger with projected digests

The industry-mainstream shape (ChatGPT's compiled profile plus recent
conversation summaries, Mem0's fact store, Zep's temporal facts), fitted to
Rally's objects.

**Stored.** Facts (B7) in `WorkspaceDO`, FTS-indexed, with subject and source
(B6). Digests (B9) per conversation and per person in `WorkspaceDO`, copied
into conversation objects (B10).

**Written.** Sweeps (B1 to B5) over every Thread Main, Breakout and Channel
feed. The sweep prompt is asked for facts a colleague joining the work later
would need and would not find in the current transcript: decisions,
constraints, preferences, commitments with dates, who owns what. It is told the
conversation's placement so it can pick a subject level, and told to prefer
`update` and `confirm` over `add` when the existing memories already say it.
People can also write directly with `memory_remember`.

**Read.** The run's per-run context message carries the conversation digest and,
when the conversation's audience is the acting person alone, their personal
digest (B11). The agent can go deeper with `memory_recall` (B12).

**Updated and expired.** Reconciliation at sweep time (B5); people edit or
retract in the review surface (B13); expiry by predicate (B8). A standing fact
nobody has restated in a long time is not expired, but `last_confirmed_at`
lets the review surface show it as unconfirmed.

**Multiple people.** Visibility is the source conversation's authority at read
time (B6). For *injection* the rule is intersection: a run in a shared
conversation is given only memories every current participant may see, because
Rally's reply will be read by all of them. Personal memories are injected only
where the person is alone with Rally (their Personal Channel, a Breakout of
their own). Whether `preference`-shaped personal facts (how this person likes
answers formatted) may cross into shared rooms is a decision for the team
(section 9). Explicit recall uses the same intersection, so an agent cannot be
talked into quoting a private Breakout in a public thread.

**Latency.**

| Path | Memory's cost |
| --- | --- |
| Warm existing | One synchronous SQLite read of the local digest copy, inside the run-context region that already runs concurrently with tools and transcript. No RPC. |
| Cold existing | The same read after wake. The copy is a row in the object's own storage, so a cold object has it. |
| New Breakout | `prepare` already runs during typing and already reads the parent; it reads the Thread's digest and the person's digest with it and writes them as the child's first copy. `confirm` adds nothing. |
| New thread | Creation runs inside `WorkspaceDO`, where the Channel and Organization digests live; the child's seed is one local read written with the provisional row. |
| Sidekick run | The home conversation's digest replaces the frozen admission recall, which removes the embedding call those runs still pay. |

The one-turn lag of the copy-and-refresh pattern applies to digest changes
made elsewhere (another thread's sweep promoted an Organization fact), and is
removed for the swept conversation itself because the sweep writes its copy
directly.

**Cost.** Sweeps: with the dogfood Organization's 142 open threads, suppose 30
conversations are active on a given day and each clears the gate twice, so 60
sweeps a day at roughly 4,000 input tokens (window plus existing memories plus
prompt) and 400 output. That is about 260,000 tokens a day for the busiest
Organization, at whatever the chosen model's rate is; the flag decides the rate
and the gate floors decide the count. Per run: the digest's token budget, paid
once per run, cached for the run's later turns. Storage: one FTS table in an
object that already holds one.

**Reuses.** The description loop's gate and settlement trigger, the
structured-inference gateway and a new flag role, the usage meter, the Queue
pattern of thread backfill, the personal-prompt copy pattern, the per-run
context message, `memory_items`' provenance and invalidation columns (renamed
and extended rather than rebuilt), the listing SQL fragments.

**New.** The sweep prompt and its operation schema, the reconciliation
transaction, the digest renderer, the subject and source axes, the recall
tools' wording, the review surface.

**Fails how.** A sweep that over-generalizes writes catch-all facts, the
description loop's known failure; the same guards apply (prefer the smallest
edit, refuse attractors). A sweep over an injection-laden transcript can be
talked into writing a memory; `derived_from` and the evidence link make the
provenance visible, and section 9 asks whether external-derived facts should
enter digests at all or stay recall-only. Digest budgets cut the long tail,
which is what recall is for.

### 7.2 Design B: curated memory notes

The Claude Code and Letta shape: memory as a small number of human-readable
documents that a background curator rewrites, rather than rows.

**Stored.** One Markdown note per subject (B6's subjects) in `WorkspaceDO`:
`memory_notes(subject_kind, subject_id, markdown, revision, updated_at)`. The
note has a fixed skeleton, `## Standing` and `## Current (with dates)`, so
short-term memory has a home and a horizon per line. Source visibility applies
per note: a Breakout's note is visible to who may open the Breakout, a person's
note to that person.

**Written.** The same sweep gate and trigger (B1 to B3). The job hands the
curator the window and the current notes for the conversation's subjects and
asks for the rewritten notes, each bounded in size. Update, dedupe and expiry
are the curator's job in one place: it drops a line that is no longer true,
merges two lines that say the same thing, and moves a dated line out when its
date has passed. A person edits the note directly, like a page.

**Read.** The conversation's notes (its own, its Channel's, the Organization's,
and the acting person's where allowed) are injected whole, through the same
copy and slot (B10, B11). Recall is `memory_read_note(subject)` for a note not
already injected, and FTS over notes for a question that spans many threads.

**Updated and expired.** By rewrite. There is no per-fact revision history
beyond the note's revisions, so "when did Rally first learn this" is a diff,
not a column.

**Multiple people.** Same intersection rule, applied per note.

**Latency.** Identical to Design A: a local copy read at run start on every
path. The injected text is larger, because a note is prose with headings and a
whole note is injected even when one line is relevant.

**Cost.** Each sweep reads and rewrites whole notes, so output tokens scale
with note size rather than with what changed. Per run, the token cost is the
notes' size, not a budget-trimmed digest.

**Reuses.** Everything Design A reuses except the reconciliation transaction
and the digest renderer, which it does not need.

**New.** The curator prompt and skeleton, the note editor.

**Fails how.** Coarse provenance: a note cannot say which message a line came
from, so trust and review are weaker and an injected sentence is harder to
trace. Coarse visibility: a Channel note's lines all share the Channel's
audience, which is right for a Channel, but a thread with Breakouts beneath it
cannot hold one note that mixes their audiences, so Breakout memory stays
Breakout-only. Rewrites drift: a curator that rewrites a note dozens of times
paraphrases facts away, the failure the description loop's "smallest edit"
rule exists for. Cross-thread recall needs an index over notes anyway, at which
point rows have been rebuilt inside Markdown.

### 7.3 Design C: conversation-local memory with promotion

Memory where the transcript is. Each conversation object owns the memory of
its own conversation; only memory that matters beyond it crosses to
`WorkspaceDO`.

**Stored.** Thread and Breakout facts (B7) in the conversation object's own
SQLite, beside the transcript, with their own FTS. Channel, Organization and
person facts in `WorkspaceDO`, as in Design A. A conversation object keeps a
copy of the wider digests (B10).

**Written.** The sweep is triggered and *run* from the conversation's own
settlement lane, the way the description loop is, with the model call in the
same lane. Local facts are written locally in the settlement transaction, with
no cross-object hop and no cursor fence, because the object is the only writer.
Facts the sweep files above the thread (subject `channel`, `organization` or
`person`) ride the existing effect Queue leg to `WorkspaceDO` as promotions,
where B5's reconciliation applies.

**Read.** Local facts are read from the object's own table at run start: no
copy, no lag, no projection. Wider digests come from the copy. A Breakout's
loop may also read its Thread Main's facts, through the conversation-tools
scope that already lets it read Main.

**Updated and expired.** Locally by the sweep; above the thread by
reconciliation in `WorkspaceDO`; expiry by predicate everywhere.

**Multiple people.** Local facts inherit the conversation's audience by
construction: a Breakout's object holds the Breakout's memory and nobody who
cannot open the Breakout reaches that object. Promoted facts carry their
source as in Design A.

**Latency.** Zero on the hot path, and better than A on freshness for the
conversation's own memory: there is no copy to lag. New Breakout: `prepare`
seeds the wider digests as in A; local memory starts empty, as it should.

**Cost.** Sweeps as in A. Storage spreads across objects instead of
concentrating in `WorkspaceDO`, which is already the busiest object in an
Organization.

**Reuses.** The settlement lane and its alarm recovery, the effect Queue leg,
everything A reuses.

**New.** A second home for facts, two schemas and two migration ledgers, a
promotion message type, and a decision rule for what is local and what is
promoted.

**Fails how.** Cross-thread recall only sees promoted facts, so a question
about work done in another thread finds its memory only if the sweep chose to
promote it; a wrong level at sweep time is invisible later. Archiving a thread
archives its memory, which is right, but a Breakout's facts die with the
Breakout even when they were about the thread. The review surface has to fan
out to objects to list a person's thread memories. Two stores to keep in step
is the kind of duplication `choosing-queues-or-rpc.md` and the self-RPC audit
warn about.

## 8. Comparison and recommendation

| | Baseline | A: fact ledger | B: notes | C: local-first |
| --- | --- | --- | --- | --- |
| Hot-path latency | none | local read | local read | local read |
| Freshness of own-conversation memory | n/a | next run (sweep writes copy) | next run | next run |
| Freshness of wider memory | n/a | one turn lag | one turn lag | one turn lag |
| Per-run tokens | one line | bounded digest | whole notes | bounded digest |
| Update precision | per fact | per fact, with history | per note, by rewrite | per fact |
| Expiry precision | per fact | per fact, predicate | per line, curator | per fact |
| Visibility precision | per fact via source | per fact via source | per note | per object, per fact above |
| Provenance to message | yes | yes | no | yes |
| Human legibility and editing | list | list with evidence | best: a page | list, fanned out |
| Cross-thread recall | all facts | all facts | notes index | promoted facts only |
| Depends on model calling a tool | entirely | for the long tail | for the long tail | for the long tail |
| New code | least | moderate | least after baseline | most |
| Stores to keep consistent | 1 | 1 (+ copies) | 1 (+ copies) | 2 (+ copies) |

**Recommendation: Design A, with two things borrowed.** From Design B, render
each digest as the readable page it already nearly is, so the review surface
shows a person or a Channel "what Rally remembers" as one document rather than
a table, with each line still backed by a fact and its evidence. From Design C,
trigger the sweep from the conversation's own settlement lane, so the sweep
rides the recovery and ordering that lane already has; the work still runs in
a Queue consumer and writes to one store.

Why not B: Rally is a multi-person product, and the per-fact source is what
makes "who may see this" exact. Notes make that coarse, and the week a private
Breakout's line surfaces in a public thread is the week memory gets turned
off. Why not C: two stores for one concept, and the conversation object is the
wrong unit for the memories people most want (what the team decided, what a
colleague prefers), which are the ones C has to promote and then cannot find if
it promoted wrong.

Why not stop at the baseline: it is phase one of A and should ship first, but
the evidence in 2.2 is that nothing happens when the model has to ask.

## 9. Numbers the team has to set, and open decisions

Every number below is written open in the implementing change, per the limits
rule. The arithmetic is here so the team can pick.

| Number | What it bounds | Arithmetic |
| --- | --- | --- |
| Sweep rest floor and ceiling | How soon after activity a conversation is swept again, and how far the doubling goes | The description loop uses 6 h to 48 h for a question that moves slowly. Memory moves faster: a decision made at 10:00 should be known in the thread next door by lunch. Each halving of the floor roughly doubles sweep count on active conversations. |
| Human-message and character floors | What counts as enough new conversation to pay for a sweep | The description loop uses 10 messages and 600 characters. A sweep that sees one message can still learn one fact; the floor trades model calls against lag. |
| Window overlap | Messages before the cursor re-read for coreference | A few messages resolve most "that", "it", "Friday". Each message in the overlap is paid on every sweep. |
| Digest token budget, per conversation and per person | What a run pays on every first turn | 40 facts at 25 tokens is 1,000 tokens. Prompt caching makes this cheap after the first turn of a run and expensive at the first turn of every run. |
| Default horizons for situational facts with no stated end | What "for now" means per class (availability, status, plan, blocker) | The sweep records the basis as `assumed`, so a wrong default is visible and reviewable. |
| Facts per subject before consolidation | When the sweep is asked to merge rather than add | Decides the ceiling on a digest's size before truncation starts cutting. |
| Sweep model and payer | Quality against cost | The ask names Sol or higher. Flag role `memory_sweep`, metered activity `memory_sweep`, Organization pays, like the description loop. |

Decisions that are not numbers:

1. **The intersection rule.** Injected memory in a shared conversation is
   limited to what every participant may see. Do `preference`-shaped personal
   facts cross into shared rooms? Default proposed: no, until the review
   surface exists.
2. **External-derived facts.** Does a fact whose only evidence is Slack or
   email text enter digests, or stay recall-only with its trust class shown?
   Default proposed: recall-only.
3. **Prefix residency.** Should a digest move into the system prompt at a
   compaction through a new resident-context kind, for cache and for survival
   across compactions? It is the §12 decision `writing-prompts.md` reserves
   for a PRD. Default proposed: not in phase one; the per-run slot is enough
   and keeps the prefix untouched.
4. **Semantic recall.** FTS only in phase one, or facts indexed into the
   existing Turbopuffer pipeline from day one? Default proposed: FTS only;
   facts are short and the sweep writes them in plain words, which is what
   BM25 wants.
5. **Sidekick runs.** Replace their frozen admission recall with the home
   conversation's digest, and leave Sidekick tables alone. Proposed: yes.
6. **Existing items.** The nine dogfood items import as `standing` facts with
   `person` or `thread` subjects. Trivial, and the only migration of data.
7. **Guests.** A guest admitted to a Channel may open its Main; the
   `organizationWide` leaf never admits a guest. Organization facts therefore
   never reach a guest's run, and Channel facts do only where the guest may
   open the Channel. Proposed: no special casing; the source rule already says
   this.

## 10. Sources

<!-- fill: consolidated source list -->
