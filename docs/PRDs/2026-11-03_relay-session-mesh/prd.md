# Relay: one person's Claude Code sessions share their decisions

> Created 2026-11-03.
>
> A person running several Claude Code sessions on the same piece of work
> links them to one Rally Thread. A decision settled in one session reaches the
> others before they act on the old one, and a contradiction between two of
> them is put to the person as one question. Inviting a teammate to that Thread
> is the later, multiplayer step. Companion: [`design.md`](design.md) (plugin
> contract, tool catalog, wire shapes). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Prototype: the local `relay` repository (a throwaway spike, not built on).

## Summary

**Relay** is a Claude Code plugin backed by Rally. Once a person has installed
it, every Claude Code session they start, in the terminal or in the Claude
desktop app, is connected to Rally without belonging to any piece of work. When
the person says "relay this" in a session, that session joins a Rally Thread
for the work (creating one if needed) and records a one-line purpose. Forks of
that session join the same Thread on their own. Other sessions the person
already has open in the same folder are offered for joining, with no restart.

From then on, when a session settles something (a direction chosen, an option
ruled out, a requirement changed), Claude pushes it to the Thread as a
**decision**. Every other session on the Thread receives it at the start of its
next turn.
Each push is checked against the Thread's earlier decisions, and when it
reverses one that a different session made, the person is asked once whether
the new decision replaces the old one. A session that joins late starts with
every active decision.

What becomes possible: a person who runs a design session and a research
session side by side stops being the courier between them. The research
session learns that the product changed direction before it spends an hour
comparing against the wrong category of product.

## Motivation

**Single-player first.** Relay's long-term product is multiplayer: each
person's own agent, connected to everyone else's through Rally. On 2026-11-03
we agreed that a multiplayer product with no value for one person does not get
installed in the first place. The same mechanism therefore has to stand on its
own for one person with several sessions before a second person is invited.

**The problem, as it was hit.** Alex ran a session shaping "Rally as an
agentic issue tracker" and forked it into a second session to audit
competitors. While switching between them he changed the core idea in the
first session: it stopped being an issue tracker and became a mesh between
Claude sessions that can become multiplayer by invitation. The competitor
session went on comparing against issue trackers, because nothing told it.
Carrying that decision across was his job, done by hand, and easy to forget.
His working day is four parallel sessions; the same thing happens between any
two of them.

**What it costs to leave alone.** The person either re-briefs every session
after every change of direction, or a session does work against a decision
that was reversed. The second cost is invisible until the result is read. The
pain research gathered for this direction (posts on X, Reddit and LinkedIn,
and an inventory of 172 of Alex's meeting notes) put siloed and duplicated AI
work among the most frequent complaints, ahead of handoffs between people.

**Why what exists does not cover it.** Claude Projects (in the claude.ai chat
app), CLAUDE.md files and Claude Code's own memory are read when a session
starts. None of them reaches a session that is already running, and none
compares two sessions' decisions. Rally's own [agent memory](../../agent-memory.md)
records decisions and disagreements, but only from conversations inside Rally,
and only after a conversation settles. Starting a new session already briefed
is therefore table stakes. Updating sessions that are already running, and
catching contradictions between them, is the part nobody covers and the part
this PRD is about.

## Goals

1. After installing Relay once, a person links a running session to a piece of
   work by saying so in that session, without restarting it, editing a file or
   passing a launch flag.
2. A fork of a linked session is linked to the same Thread without the person
   doing anything.
3. A session that was opened before the Thread existed can be linked to it
   from the session that creates the Thread, without a restart.
4. A decision pushed from one session is present in every other linked
   session's context before that session's next turn starts.
5. A session that joins a Thread starts with every active decision on it.
6. When a pushed decision reverses an active decision from a different
   session, the person is asked once, in the session they are using, whether
   the new decision replaces the old; nothing is silently overwritten.
7. Every push is visible to the person in the session that made it, and can be
   withdrawn.
8. The Thread holding the decisions is an ordinary Rally Thread, so the
   multiplayer step is adding a participant and adds no new storage.

## Non-goals

1. **Teammates.** Inviting a second person, Slack questions, and routing a
   change only to the sessions it affects. Deferred to the multiplayer PRD;
   with one person's handful of sessions, sending every decision to every
   linked session is cheap and simpler. Relevance routing returns when the
   number of sessions makes broadcast noisy.
2. **Handoffs and single-claim jobs** ("you've been rallied"). Deferred; they
   need a second person.
3. **Goals, done-conditions, or detecting when the work is finished.**
   Deferred. This keeps [Uninterrupted Workstreams non-goal 3](../2026-09-14_uninterrupted-workstreams/prd.md#non-goals)
   (no task entities) intact for now: a decision is a memory fact, not a task.
4. **Rally doing the work when no session is open.** Deferred. Rally's agent
   does not run in response to a push in this PRD.
5. **Codex, Cursor, ChatGPT or other clients.** Deferred. Claude Code only.
6. **Reading whole transcripts.** Rejected. Only decisions a session pushes, and
   its purpose, leave the machine. Rally never receives a session's conversation.
7. **A new Rally screen.** Deferred. The Thread shows pushes in its existing
   transcript; a dedicated view waits for evidence that one is needed.
8. **Measuring a person's activity.** Rejected permanently. Relay records
   decisions, never counts of sessions, turns or pushes per person.

## Product behavior

### Installing

A person installs the Relay plugin once, at user scope, from Rally's plugin
marketplace. The plugin contains no code that runs on the machine: it points
Claude Code at Rally's hosted MCP server and adds three hooks. The first time
the server is used, Claude Code opens Rally's sign-in page in the browser, the
person signs in to Rally with their usual sign-in and approves Relay, and
Claude Code stores and refreshes the resulting token itself. This is the
standard sign-in for remote MCP servers (OAuth with PKCE, Rally's server
advertising its sign-in through the standard discovery documents), the same
flow a person goes through to add Linear's or Notion's MCP server to Claude.

From then on every Claude Code session they start, in the terminal or the
desktop app, loads Relay. Until a session joins a Thread, Relay does nothing
visible and tells Rally only that the session is open: its Claude Code session
ID and working folder, with the person known from the token.

### Linking a session

The person says "relay this", "track this in Relay", or names an existing
Thread. Claude calls `relay_join`. With no Thread named, Rally creates one in
the person's Personal Channel, titled by Claude from the conversation. Claude
writes the session's **purpose** (one line: "shaping the product idea") and
pushes the decisions already settled in the conversation, so the Thread does
not start empty. Claude tells the person in one line that the session is
linked, and to which Thread.

### Forks

Claude Code starts a fork with the start hook's source set to `fork` and a new
session ID, and the fork carries its parent's conversation, including the
parent's `relay_join`. Relay's start hook tells the fork, as context before
its first prompt, its own session ID and that it is a fork. On its first turn
Claude links the fork to the Thread its parent joined, with the fork's own
purpose, and says so in one line.
The person does nothing. A fork that is about something else is unlinked with
"leave Relay" (`relay_leave`).

### Sessions opened before the Thread

When a Thread is created, Rally answers `relay_join` with the person's other
open, unlinked sessions in the same working folder. Claude names them in one
line ("Your other session in this folder, last active 4 minutes ago, may be
related. Link it?"). On yes, Rally marks the other session as invited. That
session's next turn starts with the invitation; Claude there joins, writes its
purpose and pushes what it had already decided, and those decisions are
checked against the Thread's like any push.

### Pushing a decision

Relay's instructions tell Claude to push when something is settled (a choice
made, a direction changed, an option ruled out, a requirement added or
dropped) and not while the person is still exploring. A push is one or two
sentences that stand on their own: "Direction changed: the product is a mesh
between a person's Claude sessions that becomes multiplayer by invitation; it
is no longer an agentic issue tracker." Claude tells the person in one line
what it pushed. "Undo that" withdraws it (`relay_withdraw`).

An end-of-turn check is the backstop for decisions Claude did not push. It is
**off by default** and the person turns it on in the plugin's settings. When
on, after each turn in a linked session, a hook asks a small model on the
person's own Claude subscription whether the turn settled anything not yet
pushed. If it did, Claude pushes it or drops it in view of the person. Only
what is pushed reaches Rally.

### Receiving a decision

Every other session linked to the Thread receives the decision on its next
turn: Relay's prompt hook calls Rally's server for the decisions this session
has not seen and adds them to the context of the person's next message there.
It needs no launch flag. Delivery to a session that is idle in the background,
without waiting for the person's next message, is deferred (Key design
decision 2).

Claude in the receiving session updates its working assumptions and tells the
person what the decision changes for this session's work ("The comparison set
was issue trackers. It should now include Claude Projects, agent teams and
CLAUDE.md-style shared context. Redo the table?"). It does not discard or redo
work without the person's go-ahead. It rewrites its own purpose if the
decision changed it.

### A contradiction

Every push is compared with the Thread's active decisions by one model call
on Rally's side. Three outcomes:

- **Nothing related**: recorded as a new decision.
- **An update from the same session**: the new decision supersedes the old,
  as the person's own change of mind.
- **A reversal of a decision from a different session**: the decision is
  recorded as **disputed**, stating both positions and which session made
  each, and the pushing session receives a question on its next turn: "This
  reverses what your 'competitor study' session decided at 14:12 ('compare
  against issue trackers'). Replace it?" The answer supersedes one side.
  Until it is answered, receiving sessions see the decision marked disputed,
  with both positions.

A session the person has closed is not asked anything; the question goes to
whichever linked session the person uses next.

### States

- **Not signed in, or signed out by Rally**: Claude Code shows Relay as
  needing sign-in, and Claude tells the person to sign in from `/mcp` (or the
  desktop app's connector settings). The prompt hook adds nothing.
- **Rally unreachable**: the push fails, Claude says Relay is offline and
  keeps the decision text in the conversation to push again later. The prompt
  hook adds nothing and never delays the person's message.
- **Thread deleted or access lost**: the next call answers that the Thread is
  gone; Relay unlinks the session and Claude says so.
- **A session with no new decisions**: the prompt hook adds nothing.

### In Rally

The Thread looks like any Thread in the person's Personal Channel. Each push
appears in its transcript as a decision entry attributed to the person and the
session's purpose, which does not start a Rally run. The Thread's existing
Memory pop-out lists the decisions as facts, disputed ones with both
positions, and the person can remove one there. The Thread's info lists the
linked sessions with their purposes and when each was last active.

## Impact on the product contract

**One clause moves.** The brief says creating, posting, answering an
elicitation, or being explicitly added makes a person a participant. A push
from a person's own Claude Code session is a post by that person, so this
clause holds. What is new is that a Thread may hold entries written from
outside Rally's own surfaces, by an authenticated client acting as the person.
The brief's "The agent uses typed, authorized tools" describes Rally's agent
and is unchanged; Relay's tools run in the person's Claude Code, not in
Rally's harness.

**One earlier non-goal is reversed.** [Uninterrupted Workstreams non-goal 6](../2026-09-14_uninterrupted-workstreams/prd.md#non-goals)
excluded "external agent interoperability protocol". Relay is one: a protocol
by which a person's external agent joins a Thread. Non-goal 5 of that PRD
excluded an instruction-conflict detector between sibling workers; Relay's
contradiction check is between a person's decisions, not between Rally's
workers, and [agent memory](../../agent-memory.md) already records
disagreements, so that non-goal is not reopened.

## Decision log

None yet.

## Key design decisions

1. **A Relay item is a Thread, and a decision is a memory fact.** The Thread
   gives membership, visibility and the multiplayer step for free; the fact
   store already has supersession, disputed facts with both positions, sources,
   review and removal. Rejected: a separate items table (the prototype's
   shape), which would need its own visibility rules and its own migration to
   multiplayer.
2. **Delivery on the next turn; no channels in this PRD.** Claude Code
   channels would deliver to an idle session straight away, but a channel
   must be a local process Claude Code starts, so it would need its own copy
   of the person's Rally credential. It also needs a launch flag in every
   session, a place on Anthropic's or the Organization's channel allowlist,
   and, on Team and Enterprise plans, an Owner turning channels on. The prompt
   hook needs none of these. For one person, who is the one switching between
   sessions, the next message is when the update is needed. Rejected:
   channels-only, which would fail Goal 1. Deferred: channels for the
   multiplayer PRD, where a teammate's session may sit idle.
3. **Rally hosts the MCP server; the plugin runs nothing locally except the
   fork check.** Claude Code then does the sign-in, stores and refreshes the
   token, and asks the person to sign in again when Rally revokes it. The
   hooks call the server's tools through Claude Code (`mcp_tool` hooks), so
   they use the same sign-in. Rejected: a local server holding its own
   token, which means building sign-in, token storage and refresh in the
   plugin, as the prototype would have needed.
4. **Claude Code identifies itself to Rally's sign-in by a client metadata
   document, not dynamic client registration.** Claude Code's client ID is a
   web address Anthropic hosts, pointing at a file with its name and return
   addresses; Rally reads it at sign-in. Rally stores nothing per install,
   and the "Claude Code wants access" screen is truthful because only
   Anthropic can publish that file. Neither option affects whose session is
   whose: the person comes from the account in the token, the machine from
   the grant each sign-in creates, and the session from Claude Code's session
   ID. Rejected for now: dynamic client registration, where any program can
   register under any name and Rally keeps a record per install. It is added
   only if a later client, such as Cursor or Codex, supports nothing else.
5. **Every linked session receives every decision.** One person's sessions on
   one Thread are few. Rejected for this PRD: per-session relevance routing by
   a model, which costs a model call per session per push and was the slowest
   step in the prototype (11 to 14 seconds per judgment).
6. **Rally's model checks contradictions; the person's subscription does the
   rest.** The check needs the Thread's facts, which live in Rally. It is one
   call per push, metered to the Organization's usage like any run. Rejected:
   running it on the person's machine, which would need the facts sent down
   to every session.
7. **The start hook marks a fork, and Claude links it.** Claude Code tells
   the start hook that a session is a fork, and the fork's context already
   holds the parent's conversation, including its `relay_join`, so Claude
   has the Thread in hand. Rejected: the start hook reading the parent's join
   from the fork's transcript file and linking it, which verification on
   2026-11-03 showed cannot work: the file does not yet hold the parent's
   conversation when the start hook runs, and the start hook cannot call
   Rally because Claude Code runs it before MCP servers connect.

## Data model

Sketch; the authoritative record is the migration and
[`data-model.md`](../../data-model.md).

- **Decisions** are memory facts with subject the Thread, kind `standing`,
  `derivedFrom: person`, and a new source form `session:<relaySessionId>`
  alongside the Thread's own source. A disputed decision uses the existing
  `conflict` field. Visibility is the Thread's, by the existing rules.
- **`relay_sessions`** (in the Thread's conversation object): Relay session
  ID, Claude Code session ID, person, working folder, purpose, linked-at,
  last-active, and a delivery cursor (the last fact revision the session has
  seen). Open, unlinked sessions are held per person in `WorkspaceDO` until
  they join or go quiet.
- **Tokens**: Rally's OAuth grants for the Relay client, one per person per
  machine, revoked through the existing revocation path when the person is
  removed from the Organization or removes the machine in Rally's settings.

## Security and trust model

- **Who is speaking** is decided by the OAuth token, never by anything the
  session says. A session cannot claim to be another person. The Claude Code
  session ID only distinguishes one person's sessions from each other.
- **What leaves the machine**: session ID, working folder, purpose, pushed
  decisions, and answers to Relay's questions. Never transcripts, files or
  tool output.
- **What enters a session**: only decisions from the person's own Thread,
  framed as information from Relay. Relay's instructions tell Claude that a
  decision is context to weigh, not an instruction to act on, which limits
  what a crafted decision could make a session do.
- **The working folder** is used to suggest related sessions and is shown
  only to the person.
- [`security.md`](../../security.md) and
  [`authorization.md`](../../authorization.md) govern the sign-in; Rally's
  [hosted MCP connectors](../../hosted-mcp-connectors.md) are the closest
  existing OAuth code, though there Rally is the client and here Rally is the
  server.

## Agent behavior

Rally's own agent gains nothing and does not run on a push. Relay's tools run
in the person's Claude Code, from the plugin. The plugin contract, every tool
with its input, output and failures, the hooks, and the instructions text are
in [`design.md`](design.md).

## Rollout

No flag. Relay ships on merge, per the default. It changes no existing Rally
screen or behavior: it adds an MCP server, its sign-in and its routes, which
do nothing until someone installs the plugin, and nobody has it yet. The
plugin is published to Rally's own plugin marketplace and installed first by
Juno Labs' own people, on their own work, for two weeks.

Turning it off: unpublish the plugin and make the Relay server answer that
Relay is unavailable. Decisions already recorded stay as ordinary memory facts
on their Threads.

## Acceptance

1. Install the plugin, sign in, open a session, say "relay this": the session
   is linked and the Thread appears in the Personal Channel, with the
   decisions so far.
2. Fork that session: the fork is linked before its first answer.
3. Open a second session in the same folder first, then create the Thread in
   another: the second session is offered, and on yes it joins with no
   restart.
4. Push a change of direction in session A; type anything in session B: B's
   reply accounts for the change.
5. In B, push a decision that reverses one A pushed: B asks the replace
   question; until it is answered, A sees both positions.
6. Withdraw a push: other sessions are told on their next turn that it was
   withdrawn.
7. Stop the Rally Worker, push from A: A says Relay is offline, and the
   person's next message in B is not delayed.
8. Revoke the person's Relay sign-in in Rally: the next session asks them to
   sign in again.
9. All of the above in the Claude desktop app's Code tab as well as the
   terminal.

## Open questions

1. **Is the end-of-turn check worth its friction?** Answered by the two-week
   trial: how often a decision was made but not pushed.
2. **Trial measure.** Proposed: over two weeks, the number of times a
   receiving session changed course because of a decision, and the number of
   contradictions the person confirmed were real. The team sets the bar for
   continuing.

## Verification

Run on 2026-11-03 with a throwaway plugin and a local MCP server with an
auto-approving sign-in, in Claude Code 2.1.314 (terminal) and 2.1.309 (the
copy bundled in the Claude desktop app, run directly):

1. **Sign-in to a server bundled in a plugin works.** Claude Code read the
   server's discovery documents and signed in through the browser flow, then
   showed the server as connected. It identified itself with the metadata
   document `https://claude.ai/oauth/claude-code-client-metadata` ("Claude
   Code"), whose return addresses are `http://localhost/callback` and
   `http://127.0.0.1/callback` on a port chosen per sign-in. Rally's sign-in
   must therefore accept any port on those two addresses.
2. **Revocation sends the person back to sign-in.** With Rally's tokens
   revoked, Claude Code showed the server as needing sign-in, provided Rally's
   token endpoint answers a revoked refresh token with `invalid_grant`.
   Answering `invalid_token` there instead left the server "failed to
   connect" with no sign-in prompt.
3. **The prompt hook calls Rally's tool with this session's ID and folder,
   using the plugin's sign-in.** Rally saw the person from the token and the
   session ID and folder from the hook's `${session_id}` and `${cwd}`.
4. **The tool's reply reaches Claude only as JSON.** A reply of
   `{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
   "additionalContext": "..."}}` was added to Claude's context. A plain-text
   reply ran without error but was not added, although the hooks
   documentation says plain text is read like a command hook's output.
5. **The start hook's context reaches Claude**, including in a fork, which
   started with source `fork`, a new session ID, and its parent's
   conversation.
6. **The same holds in the Claude desktop app.** With the plugin installed at
   user scope and signed in from the terminal, a session started from the
   desktop app received both its start-hook session ID and Rally's `<relay>`
   block. Sessions that were already open in the app picked up the newly
   installed plugin without a restart, and their next prompt called Rally
   with their own session ID and folder. Installing Relay therefore reaches
   sessions that are already running, which Goal 1 relies on.
