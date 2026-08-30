# Slack reaction lifecycle and message formatting

> **Historical design note (2026-08-29):** This PRD records the delivery paths
> that existed when the formatting work was specified. Rally no longer calls
> `chat.startStream` or `chat.appendStream`; external result content is posted
> only after a canonical turn is saved and reloaded. See
> [`slack-integration.md`](../../slack-integration.md#changelog) for the current
> invariant.

> Created 2026-08-22.
>
> Rally's Slack presence gains a reaction that tracks a run from acknowledgement
> to outcome, and agent output that renders as formatted text rather than raw
> markdown. Companion plan: [`plan.md`](./plan.md). Subsystem document:
> [`slack-integration.md`](../../slack-integration.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

When a member mentions Rally in Slack today, Rally adds an `eyes` reaction and
never touches it again. The reaction says "received" and then says it forever —
it is still there when the task is finished, and still there when the task
failed. A member reading the channel an hour later cannot tell from the message
whether Rally is working, done, or dead.

This change makes the reaction a **state indicator with a lifecycle**: an
acknowledgement the moment the prompt is admitted, a rotating working reaction
while the run is live, and a terminal reaction naming the outcome. It also fixes
a defect in the same surface: agent output delivered outside the streaming path
is posted as raw text, so a model's `### Heading` and `**bold**` reach the
channel as literal characters. Both halves are about the same thing — what
Rally looks like in a channel someone else is reading.

## Motivation

Two concrete failures, both visible in ordinary use.

**The reaction never resolves.** `SLACK_AGENT_ACKNOWLEDGEMENT_REACTION` is the
literal `"eyes"` (`packages/connectors/src/slack.ts:545`), added once by the
activation hook (`apps/api/src/services/slack-agent-service.ts:1599`) and removed
by nothing. The Slack Agent thread status *is* cleared on completion
(`:1200`), but that status is only visible inside the Agent thread pane — the
channel message that started the run keeps its 👀 permanently. The failure mode
this produces is not cosmetic: a run that died on a provider error and a run that
completed successfully are indistinguishable at the message that started them,
and the member who asked has no signal to come back to.

**Agent output is posted as raw markdown.** `postSlackTextChunks`
(`:2937-2947`) passes the model's text straight into `chat.postMessage`'s `text:`
field. Slack parses `text` as **mrkdwn**, a dialect with no headings and no
tables, so `### Outcome` renders literally. The streaming path already does this
correctly — `chat.appendStream` is called with `markdown_text` (`:1120`) — which
means the same agent output renders well or badly depending only on which
delivery path carried it. Every automation result, every digest, and every
streaming fallback takes the bad path. This is what a member sees in
`#general` when an automation posts, and it is the most-shared surface Rally
has.

Leaving these alone costs Rally credibility in exactly the room where other
people are watching. A channel message is read by everyone in the channel, not
just the person who asked.

## Goals

1. A member can tell, from the triggering message alone, whether Rally has
   acknowledged a request, is working on it, or has finished — and with what
   outcome.
2. The working state is visibly *alive*: the reaction changes over the course of
   a run rather than sitting still.
3. A completed run ends with exactly one reaction on the triggering message,
   naming the outcome.
4. Agent output rendered in Slack uses Slack's own formatting — headings, lists,
   code blocks, quotes, tables — rather than reaching the channel as literal
   markdown characters.
5. Every delivery path renders identically. The same agent output looks the same
   whether it streamed, fell back to messages, arrived as an automation result,
   or arrived as a digest.
6. A workspace can override which emoji Rally uses, so an installation whose
   conventions differ — or whose custom emoji are part of its culture — is not
   stuck with Rally's defaults.

## Non-goals

1. **Per-user reaction preferences.** Reactions are on a message in a shared
   channel; they are read by everyone who can see it, so the unit of
   configuration is the installation, not the reader. Rejected outright.
2. **Reaction cycling driven by what the agent is actually doing** — 🔍 while it
   searches, ✍️ while it writes. The harness runs as a single Workflow step
   (`apps/api/src/workflows/workstream-loop.ts:208`), so no per-tool progress
   boundary is observable from the Slack service without threading progress
   events through the harness. Deferred; goal 2 is met by a timed rotation in
   the meantime, and the rotation's shape is deliberately compatible with a later
   progress-driven source.
3. **Reactions on commands and modal submissions.** Neither has an unambiguous
   source message to react to; they keep their existing ephemeral and modal
   acknowledgements. Unchanged from today.
4. **Tables and rich formatting in App Home.** The `markdown` block is available
   on the Messages surface only. App Home keeps its existing `section`/`mrkdwn`
   blocks, which are correct for it. Rejected as impossible rather than
   undesirable.
5. **Rewriting what the model emits.** This change alters how Rally *renders*
   agent output, not the prose the model produces. Prompt-side formatting
   guidance is a separate concern.
6. **Custom emoji validation at configuration time.** Slack exposes no
   pre-flight check that a workspace emoji name exists; `reactions.add` simply
   fails with `invalid_name`. Configuration accepts any syntactically valid name
   and falls back at use time. Deferred pending a Slack capability that does not
   currently exist.

## Product behavior

### The reaction lifecycle

A prompt with a source message — an app mention, or a DM that starts or
continues a session — moves through three visible states. **At most one Rally
reaction is on the message at any time.**

| State | Reaction | When |
| --- | --- | --- |
| Acknowledged | 👀 `eyes` | The prompt is admitted and authorized, before context gathering. Unchanged timing from today. |
| Working | 🧠 `brain` → 🔍 `mag` → ✍️ `writing_hand` → ⚙️ `gear` | Rotating while the run is live, advancing on a fixed interval, looping until the run reaches an outcome. |
| Outcome | see below | The run reaches a terminal status. |

The outcome reaction is chosen from the run's existing `outcomeStatus`:

| `outcomeStatus` | Reaction |
| --- | --- |
| `completed` | ✅ `white_check_mark` |
| `needs_input` | ❓ `question` |
| `failed` | ⚠️ `warning` |
| `stopped` | 🛑 `octagonal_sign` |

Each transition removes the previous Rally reaction and adds the next, so a
finished message carries one reaction rather than a row of them. Reactions added
by *people* are never touched: Rally removes only the emoji it most recently
added itself, and only when it is still the one on the message.

The acknowledgement is unchanged in timing and remains the first provider call
after admission — it does not wait for the rotation to start.

### Failure and degradation

Reactions are decoration on a durably-admitted request, and no reaction failure
may discard or fail a run. Today's rule holds and extends to every new
transition: a Slack-side reaction error is logged, marks the installation for
reconnect where appropriate, and is otherwise swallowed.

- A missing `reactions:write` scope discovered mid-run leaves whatever reaction
  is currently on the message and the run continues.
- `already_reacted` on an add, and `no_reaction` on a remove, are both successful
  idempotent retries.
- A configured emoji Slack rejects as `invalid_name` falls back to the built-in
  default for that state, once, and logs the rejected name. A workspace that
  configures a nonexistent emoji gets Rally's default rather than no reaction.
- If the rotation stops for any reason — the run outlives it, the ticker is
  lost — the terminal transition still fires from the delivery path and still
  leaves the correct outcome reaction. **The outcome reaction never depends on
  the rotation having run.**

### Configuration

Reaction sets resolve most-specific-wins:

1. Rally's built-in defaults, above.
2. A workspace installation override, stored on the Slack connection.
3. An automation or work-stream override, for a run whose author wants its own
   vocabulary.

An override may replace any subset — the acknowledgement, the working rotation,
or individual outcome reactions — and anything it does not name keeps the tier
below it. An override naming an emoji Slack rejects degrades per the rule above.

### Message formatting

Agent output posted to Slack renders through Slack's `markdown` block on every
delivery path: streaming, the message fallback, automation results, and digests.
Headings, ordered and unordered lists, task lists, block quotes, dividers,
inline and fenced code, and tables all render as formatted content.

An automation result gains the structure it is missing today. Its title becomes a
`header` block rather than a line of body text jammed above the content, the body
becomes a `markdown` block, and the existing action buttons and AI-fallibility
notice are unchanged.

Long output is split at Slack's 12,000-character limit for markdown blocks. The
split prefers a paragraph boundary, then a line boundary, and only breaks
mid-line when a single line exceeds the limit on its own — so a fenced code block
or table is not severed mid-structure when the text offers a safe place to break.
Every message carries plain-text fallback for notifications and screen readers.

## Impact on the product contract

None — this refines behavior within the existing contract. The reaction is
already part of the Slack surface described in
[`slack-integration.md`](../../slack-integration.md); this gives it a lifecycle
and makes its vocabulary configurable. The formatting change alters rendering
only, not what Rally reads, stores, or is permitted to do.

One documented invariant is narrowed rather than broken. The current wording —
"the `eyes` reaction is added by the host control plane after admission and
authorization but before context gathering" — becomes a statement about the
*acknowledgement* reaction specifically, with the later transitions named
alongside it. The property that mattered is unchanged: the reaction is added by
the host control plane after admission, before context gathering, and
`already_reacted` is a successful retry.

## Key design decisions

1. **One reaction slot, not an accumulating row.** The alternative — leave 👀 in
   place, add a working reaction beside it, add a checkmark beside that — ends
   with three pills on the message and makes the *current* state the thing the
   reader has to work out from a set. A single slot that changes says one thing
   at a time. The cost is that Rally issues a remove with every add, which is
   two API calls per transition rather than one; it is worth it.

2. **The rotation is timed, not progress-driven.** Progress-driven is the better
   design and is non-goal 2 for a reason: the harness is one Workflow step, so
   the Slack service cannot see tool boundaries without new plumbing through the
   harness. A timed rotation delivers goal 2 now, and the state machine is
   written so that a later progress source replaces the clock without changing
   the transitions.

3. **The ticker is a Durable Object alarm, not a delayed queue message.** The
   repository already has the delayed-queue pattern
   (`schedulePublicChannelSync`, `apps/api/src/services/slack-agent-service.ts:217`)
   and it was the first candidate, since it needs no new infrastructure. It was
   rejected: every tick would write a `slack_ingress_jobs` row, so a
   two-minute run at a few seconds per tick leaves dozens of rows behind for a
   purely decorative effect, and cancelling a scheduled queue message is not
   possible — a finished run would keep waking to discover it was over. A DO
   alarm cancels by being cleared, holds its own cursor without touching D1, and
   follows the existing `WorkspaceScheduler` precedent
   (`apps/api/src/durable-objects/workspace-scheduler.ts:156`).

4. **The terminal reaction is applied by the delivery path, not the ticker.** The
   ticker is best-effort infrastructure and may be lost; delivery is the path
   that already runs on every terminal outcome and already carries the status.
   Making delivery the authority means the outcome reaction survives a ticker
   that never started, and it is why the rotation can be treated as decoration
   without weakening goal 1.

5. **Formatting is fixed by moving to the `markdown` block, not by translating
   markdown to mrkdwn.** Writing a markdown-to-mrkdwn converter was considered:
   it would let the existing `text:` field stay. It loses on capability —
   mrkdwn has no headings and no tables, so `### Outcome` has no correct
   translation, only a lossy one — and on consistency, since the streaming path
   already passes markdown through natively and a converter would make the two
   paths differ in a new way instead of the old one.

6. **Only Rally's own last-known reaction is removed.** The transition does not
   clear the message's reactions or remove whatever Rally finds there. A member
   who reacts 👀 themselves keeps their reaction, and a Rally reaction someone
   has already removed by hand is not re-added to be removed again.

## Data model

No migration. The workspace-level override lives in the existing
`connector_connections.config_json` blob, which is already free-form JSON parsed
by the connector layer. The automation and work-stream override reuses the
existing per-run configuration surface.

The ticker's cursor — which working reaction is current, and which reaction
Rally last successfully placed — lives in Durable Object storage, keyed by the
Slack session's installation, channel, and thread. It is derived state: losing it
costs the rotation, not the outcome.

## Security and trust model

Unchanged. Reactions are written with the workspace bot token under the existing
`reactions:write` scope, which is already granted. Configured emoji names are
validated against Slack's own character set before use and are never interpolated
into anything but a `reactions.add` argument. Agent output rendered through a
`markdown` block is the same untrusted model text already delivered today; a
markdown block renders formatting, not scripts or embeds, and no new content
reaches Slack that did not reach it before.

## Provider configuration

None. `reactions:write` and `reactions:read` are already in the installed bot
scope bundle (`config/provider-apps/slack.json`), so no reconnection is required
for either half of this change.

The new Durable Object class needs a binding and a migration tag in both
`apps/api/wrangler.global.jsonc` and `apps/api/wrangler.eu.jsonc` before the
change is deployed.

## Acceptance

1. Mention Rally in a public channel. Within a second the message carries 👀,
   and no other Rally reaction.
2. While the run is live, the reaction changes at least once and is drawn from
   the working set.
3. When the run finishes, the message carries exactly one reaction, matching the
   run's outcome.
4. React to the same message yourself with an unrelated emoji. It is still there
   when the run finishes.
5. Trigger an automation whose result contains a heading, a list, a table, and a
   fenced code block. All four render as formatted content in the Agent DM, with
   no literal `#` or `**` characters.
6. Compare a streamed reply and a fallback reply carrying the same content. They
   render identically.
7. Configure a workspace override naming a nonexistent emoji. The run falls back
   to the default reaction and logs the rejected name; no run fails.

These land in [`e2e.md`](../../e2e.md) as durable checks.

## Decision log

### 2026-08-22 — Both reaction writers re-read and write conditionally

**Decided:** `applyOutcomeReaction` and `advanceSessionReaction` each re-read
`reaction_current` immediately before acting and guard their write with
`WHERE reaction_current IS ?`. The ticker re-reads its own row after the Slack
call and abandons the rotation if it was cleared or restarted meanwhile. The
rotation cursor now names the reaction being placed rather than being
pre-incremented.

**Why:** Review found three ways the single-slot rule broke. `deliverWorkstreamOutcome`
snapshots the session row at the top and reaches `applyOutcomeReaction` several
Slack round trips later, by which time a tick may have moved `reaction_current`;
removing the stale emoji answers `no_reaction`, which is swallowed as success,
so the message kept the working reaction *and* gained the outcome. A `/stop` that
arrives while `alarm()` is awaiting Slack cannot interrupt it, so the handler's
unconditional re-arm resurrected a cancelled rotation. And the pre-incremented
cursor meant a run admitted at cursor 0 showed `working[1]` first, so the
documented order never started where both the module comment and
`slack-integration.md` say it does.

**Changes:** Nothing in the agreed scope. Product behavior's "at most one Rally
reaction is on the message at any time" is unchanged as a statement and now
actually holds under concurrency; the working rotation's stated order is now the
order a member sees.

### 2026-08-22 — The markdown splitter's budget is the worst-case fence overhead

**Decided:** `splitSlackMarkdown` bounds a hard-wrapped line by the worse of the
current fence state and the state a mid-line flush produces, and measures each
piece against the fence state *after* adding it.

**Why:** The budget was computed once per source line while `carriedFence`
changes inside the hard-wrap loop, so every chunk after a mid-line flush was
sized as though it carried no reopened fence. A single line longer than the
budget with a fence open — minified JSON, a base64 payload, a long log line —
produced 12,008-character chunks against a 12,000 limit. That is not cosmetic:
`chat.appendStream` validates `markdown_text` at 12,000 before the request goes
out, the fallback's `markdown` block is over Slack's cumulative cap and is
rejected, and the member receives no result at all.

**Changes:** Nothing in the agreed scope. Product behavior already said long
output splits at Slack's limit; it now does so for fenced content too.

### 2026-08-22 — The reaction's columns live in WorkspaceDO, not regional D1

**Decided:** The four columns are added by WorkspaceDO schema migration version
8, and the ticker's liveness signal is the session's `last_delivery_key` rather
than a `harness_runs` status.

**Why:** This change was written against a base where `slack_agent_sessions` was
a regional D1 table. Rebasing onto `main` landed after the workspace Durable
Object cutover: migration `0090` drops that D1 table and
`workspace-domain-schema.ts` owns it now, so a D1 migration adding the columns
applies to a table that no longer exists. `harness_runs` moved too, to
WorkstreamDO — a different object — so the original liveness query would have
had to reach across an object boundary for a decorative effect. The delivery key
answers the same question from the row already being read, and comparing it
against the value captured when the rotation started is what keeps a follow-up
prompt in an existing thread rotating, where "has ever delivered" would stop it
immediately.

**Changes:** Supersedes the entry below, which recorded the same columns as a
D1 migration. Nothing in the agreed scope moves; the columns and their meanings
are unchanged. Design decision 4 (delivery owns the outcome reaction) is
untouched and is what makes the weaker liveness signal acceptable.

### 2026-08-22 — The reaction's position is a migration, not derived state

**Decided:** `slack_agent_sessions` gains `reaction_channel_id`,
`reaction_message_ts`, `reaction_current`, and `reaction_cursor` in migration
`0071`. The **Data model** section said no migration was needed.

**Why:** That section assumed the ticker's Durable Object storage could hold the
whole reaction state. It cannot hold the part that matters. Delivery is the
authority on the outcome reaction (key design decision 4) and runs in a different
invocation from the acknowledgement, so it has to know which message Rally
reacted to and which emoji it put there — and it has to know that *without*
depending on the ticker, which is the entire point of making delivery the
authority. Deriving the message from the session's thread root is wrong for the
common case: a reply inside an existing Rally thread has a different timestamp,
and reacting to the root would move the status off the message the member just
sent.

**Changes:** Nothing in the agreed scope; goals and behavior are unchanged. The
**Data model** section's "no migration" claim is superseded. The DO still holds
the rotation's own cursor and tick count, as described.

### 2026-08-22 — The rotation ticks every six seconds, not every three

**Decided:** The default `workingIntervalMs` is 6,000, configurable between 3,000
and 60,000.

**Why:** `reactions.add` and `reactions.remove` are Slack Tier 3 methods — about
50 calls a minute, counted per method per workspace per app — and one rotation
step spends one call in each bucket. Three seconds would spend 20 of a run's 50
per minute, leaving room for two concurrent runs in a workspace before Slack
starts refusing; six leaves room for about five. The failure is worse than it
looks, because the refusals land on whichever run happens to tick last rather than
being shared out.

**Changes:** Goal 2 (the working state is visibly alive) still holds — the
reaction changes several times in any run long enough to watch. Nothing else
moves.

### 2026-08-22 — The acknowledgement left the shared activation helper

**Decided:** The acknowledgement command is built with
`slackAgentActivationAcknowledgement` and executed with the adapter directly,
rather than through `acknowledgeConnectorAgentActivation`.

**Why:** Goal 6 asks that a workspace override apply to every reaction. The shared
helper's hook signature takes only the invocation, so it cannot be handed a
resolved reaction set, and the acknowledgement would have been the one transition
stuck on Rally's defaults. Both steps are still the adapter's own, so nothing
left the connector control plane; only the indirection did.

**Changes:** Nothing in the agreed scope. `slack-integration.md` describes the
ingress in terms of the adapter's two steps rather than the shared flow.
