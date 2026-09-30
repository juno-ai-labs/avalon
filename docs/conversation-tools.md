# Conversation tools

`rally:conversations` is the built-in plugin that lets an agent list, read, and
post to Rally conversations (a Channel's Main conversation or a Breakout). It is
one set of tools and a **scope**: a function from the loop's input to the
conversations it may reach and the tools it is offered. Adding a new kind of
agent means adding a scope, never new tools. The model never supplies, names,
or widens a scope.

Read this before changing what an agent can read or post to outside its own
conversation, and before giving a new kind of loop these tools. The tool design
rules are [`agent-tools.md`](agent-tools.md)'s; the page-id mechanism is
[`tool-pagination.md`](tool-pagination.md)'s; a Sidekick's home and its
linked conversations are [`automation-lifecycle.md`](automation-lifecycle.md)'s.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/conversation-tools.ts` | The plugin: `conversationToolAccess` (the one place a scope and tool set are derived from a loop), the four tools, the refusal table (`conversationRefusalError`), the system message, the page-size and character-budget placeholders, and `conversationToolPorts`, the calls the tools make. |
| `apps/api/src/services/integrations.ts` | `loadHarnessTools` builds the plugin next to the Sidekick plugin and passes the pagination wrapper under the `conversation` prefix. |
| `apps/api/src/durable-objects/workspace-conversation-tool-protocol.ts` | The scope, the WorkspaceDO request schemas and discriminated outcomes with the refusal codes, and the post request `appendConversationPost` takes. |
| `apps/api/src/durable-objects/workspace-sidekick-conversation-storage.ts` | Conversation ids, the scope read over `channels`, `breakouts` and their viewer rows, title lookup, and the link write. |
| `apps/api/src/durable-objects/workspace-do.ts` | `conversationToolScope`, `resolveConversationToolTarget`, `linkSidekickConversation`: scope from the directories, then admission through the hosted parent's `authorizeViewer`. |
| `apps/api/src/durable-objects/substream-agent.ts` | `appendConversationPost`: a post appended to any Channel or Breakout conversation, keyed on its client message id, without waking that conversation's agent. |
| `apps/api/src/durable-objects/workstream-message-storage.ts` | `readableMessagesBefore`: a conversation's messages newest first, without tool cards or suggestions. |
| `packages/agent-harness/src/tool-activity.ts` | The transcript wording for each `conversation_*` tool. |

## How it works

### Scope

| Loop | Scope | Tools | Acts as |
| --- | --- | --- | --- |
| Breakout (`parentKind: workstream`, substream not `"0"`) | Its own conversation and its Channel's Main | list, read | The person it works for |
| Sidekick configuration (`parentKind: automation`, substream `"0"`, no run) | The Sidekick's home and linked conversations, plus any conversation the person talking to it can open | list, read, post, link | The person talking to it |
| Sidekick run (`automationRun` present) | The Sidekick's home and linked conversations, plus any conversation the run-as user can open | list, read, post | The run-as user |

A Channel's Main loop gets no plugin: the only conversation it would reach is
the one it is in. Neither does a loop under workspace authority, nor a run
child woken without its `automationRun`. The plugin is `preload: true` and
`explicit: true`, and loading it reads nothing: the first tool call is the
first read.

### Tools

Wire names are `conversation_list`, `conversation_list_next`,
`conversation_read`, `conversation_read_next`, `conversation_post` and
`conversation_link`. A `conversationId` is `<channelId>` for a Main
conversation and `<channelId>/<breakoutId>` for a Breakout, because a Breakout
id is unique only within its Channel. `conversation` accepts that id or the
exact title of a conversation in scope (compared without case); `link` also
accepts a Rally link, which the Worker turns into an id before WorkspaceDO sees
it.

- **list** returns `{ conversations: [{ conversationId, kind, title, isHome, isOwn }] }`
  and a `nextPageId`. The home comes first, then (for a Breakout loop) Main,
  then linked conversations in the order they were linked. Every call re-reads the
  directories for the acting person and omits what they can no longer open
  and anything archived.
- **read** takes `conversation` and `limit` and returns
  `{ conversationId, title, messages, nextPageId }`, newest first. Each message
  has an author (`person`, `agent`, `external`, `system`) with a name, `sentAt`,
  `text`, `textTruncated` and `externalSource`. A Sidekick's post reads as the
  Sidekick, and its `externalSource` names the person outside Rally whose words
  it forwarded. A page stops at `limit` messages or the character budget; one
  message longer than the whole budget returns its first part, marked. The
  continuation is private: the conversation id, the sequence to read before,
  and the page size, stored by the pagination wrapper beside the loop's
  receipts. Every page is admitted again.
- **post** takes `text` and `conversation`, and returns
  `{ conversationId, messageId, replayed }`. `conversation` may be left out to
  post to the Sidekick's home when there is one: a run knows from its
  definition, and for a homeless Sidekick's run the argument is required and
  its description says nothing of a home; the configuration conversation does
  not read the definition, so there the description says a home is used when
  `conversation_list` marks one. The host derives the key
  `conversation-post:<harnessRunId>:<receiptId>`, and the target's
  `appendConversationPost` writes once per key, answering a replay with the
  message it already wrote. It writes an `automation_activation` message whose
  structured content names the Sidekick (and the run and its trigger, for a
  run), so the client renders it under the Sidekick's name. When the run was
  woken by an external message (a bound thread's reply), the host copies that
  sender into `externalSource`. A run's system message says its final message
  stays in the run, so a conversation hears a result only by a post.
- **link** takes `conversation` and returns
  `{ conversationId, kind, title, alreadyLinked }`. It writes one
  `sidekick_conversation_attachments` row per Sidekick and conversation; the
  table keeps the name the tool had when it shipped. Linking is not attaching
  a Sidekick to a work stream (`parent_sidekicks`), which only recommends it
  there, and the system message says so because a model offered both reads
  them as one.

### Admission

WorkspaceDO answers each read or post in one call. It builds the scope from
its own `automation_directory`, link rows, `channels`, `breakouts`,
`channel_viewers` and `breakout_viewers` and matches the reference against it.

A Sidekick's reach is the **union** of its own permission and its acting
person's. Its home and linked conversations are its own: a read or post there
is admitted on the link alone, refused only when the conversation is archived.
A reference that names none of them is resolved among the conversations the
acting person can open (an id directly, anything else as a title) and admitted
for that person: an active relationship in `workspace_member_status`, then the
hosted parent's `authorizeViewer`, the same admission the conversation's
transport uses, with `requireGrantAuthority` for a guest so a guest reaches
only what a grant gives them. A Channel or Breakout loop has no permission of
its own, so every conversation in its scope is admitted for its person that
way.

A list shows a Sidekick its home and linked conversations, archived ones
omitted, whoever it acts as; it does not enumerate the person's other
conversations, which a run names by id or title. For any other loop a list
re-admits the person: nothing for one whose membership ended, the
directories' viewer rows for a member, and for a guest each unarchived
candidate's admission, since the viewer rows record no grants and would drop
what a grant gives. Link admits the same way and additionally refuses an archived target,
which is the rule a write through `ConversationService.writableClient` follows:
linking is the consent to publish there.

## Invariants

- **The scope is host-derived, from the loop input, in one function.**
  `conversationToolAccess` is the only place a scope or a tool set is decided. A
  scope that took a model argument would let a run widen its own reach.
- **Only a Sidekick's configuration conversation links.** A run is offered
  no link, so it cannot widen the Sidekick's own permission; beyond it, a run
  reaches only what its run-as user can open.
- **A post never wakes the target's agent.** It is something people read, not a
  request to the agent there. Admitting it as loop input, as `post_result` did,
  would start that agent on every forwarded reply.
- **A post is keyed on the receipt, not the run.** A retried receipt posts once;
  a new call in a later wake of the same run is a new post. Keying on the run
  alone, as `post_result` did, would swallow every reply after the first.
- **A link is standing access; anything else is admitted again.** A read or
  post in a Sidekick's home or a linked conversation needs no person, so the
  run-as user losing that room changes nothing. Every other read and post
  admits the acting person again: a continuation page or a listed id is never
  standing access there, and losing the Channel stops the next call.
- **The external-source marking is the host's.** The model cannot set or clear
  it, so a later reader can trust that a marked post forwarded someone else's
  words.

## Boundary

The plugin owns the tools, their scope and their refusals. It depends on
WorkspaceDO for the directories and admission
([`hosted-conversation-parents.md`](hosted-conversation-parents.md)), on each
conversation's SubstreamAgent for messages
([`workstream-durable-object.md`](workstream-durable-object.md)), and on the
pagination wrapper ([`tool-pagination.md`](tool-pagination.md)). What a
Sidekick's home and linked conversations are, and who may change them, belongs to
[`automation-lifecycle.md`](automation-lifecycle.md). It does not route
external replies into a run, which is
[`external-conversation-bindings.md`](external-conversation-bindings.md)'s, or
continue a run, which is `automation-lifecycle.md`'s. There is no detach tool.

## Failure modes and limits

Each refusal is a typed failure with a stable `code`, a model-visible sentence
(`conversationRefusalError` holds them), and only allowlisted `details`:

| Tools | `code` | `details` |
| --- | --- | --- |
| read, post | `conversation_not_in_scope` | `available` |
| read, post, link | `conversation_ambiguous` | `available` |
| link | `conversation_not_found` | `field` |
| read, post, link | `conversation_archived` | `resourceId` |
| read, post, link | `conversation_access_denied` | `resourceId` |
| post | `invalid_arguments` (no home, `conversation` left out) | `field`, `expected` |
| read_next, list_next | the wrapper's page codes, per [`tool-pagination.md`](tool-pagination.md) | as there |

`available` is cut to the shared failure-detail bound,
`MAXIMUM_FAILURE_AVAILABLE_VALUES`. A post refused inside the target for any
other reason throws `conversation_post_refused:<code>`.

Limits, all placeholders for the team to set per
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md),
written as the numbers the design named: a page of 25 by default and at most 50
for list and read (`list_resources`' numbers), and a read budget of 12,000
characters per page (`read_resource`'s). They live as constants at the top of
`conversation-tools.ts`. The echo of a refused value in a sentence,
`MAXIMUM_ECHO_CHARACTERS`, is open (`LIMIT UNSET`); a reference has no length
bound of its own. Every cut, the read budget's included, keeps a character
whole rather than splitting it.

## Testing

- `apps/api/test/conversation-tools.test.ts` (Node): which loop gets which
  tools, the wire names and their order, each schema's required, optional and
  forbidden arguments with the explicit unspecified value, the pinned
  system-message lines (a run's final-message instruction among them), a
  homeless Sidekick's required `conversation`, each refusal's sentence and
  details, the post key and its replay, the read budget and its cut, the
  continuation, and link parsing.
  WorkspaceDO and the target are a typed double there; everything they decide
  is proved on workerd.
- `apps/api/test/sidekick-conversation-storage.test.ts` (Node, the object
  ledgers applied): the migrations, the link key, and the scope and title
  queries.
- `apps/api/test-workers/conversation-tools.test.ts` (workerd): the home
  projection, archive pausing a Breakout-homed Sidekick, link refusal and
  idempotency, scope refusal, list re-admission after leaving a Breakout or
  after a membership ends, archived refusal, and an append that lands once
  without waking. A guest: refused an Organization-wide Channel without a
  grant, listed what a grant gives, and admitted to a Breakout-homed Sidekick
  by the Breakout's grant rather than the Channel's; and a room member outside
  the home Breakout refused by the three sites that narrow to it.
- `apps/api/test-workers/external-bindings-mucker-flow.test.ts` (workerd): the
  whole flow, a continued run's forward landing in the home Breakout.
- `apps/api/test-workers/automation-post-result.test.ts` (workerd): a real run,
  scripted with `useOpenRouterDouble`, calling `conversation_post` into its home.

A Breakout's viewer rows reach WorkspaceDO through the hosted parent when the
Breakout's own effects are delivered (`deliverChildEffects`). The re-admission
test stops there: adding a Breakout member also queues a
`participant_notification` parent effect, and the workers suite's empty D1 has
none of the notification tables it needs, so draining the parent outbox would
retry it until the helper gives up.

## Security and trust model

Text returned by `read` is untrusted content: the system message tells the
model messages are other people's words, and nothing in them can change the
scope. No credentials are involved; every call stays inside the Organization's
own objects. A run acts as its run-as user whoever woke it, so what it may read
is what that user may read, plus the Sidekick's home and linked conversations.
A link outlives the linking person's access: whoever can manage the Sidekick
can have its runs read a linked conversation and post what they read into
another it reaches, so linking is a decision about that conversation's
contents as well as its audience. What a run posts is published to the
target's audience; the person who linked that conversation chose that
audience.

## Changelog

### 2026-09-30 — A Sidekick reaches its own rooms and its person's, and a link is its own permission

**What changed:** A Sidekick's reach became the union of two permissions. Its
home and linked conversations are its own: reads and posts there are admitted
on the link alone, refused only when the conversation is archived, and a list
shows them whoever the Sidekick acts as. Any other conversation its acting
person can open is reachable by id or title and admitted for that person as
before. The tool that makes a link was renamed from `conversation_attach` to
`conversation_link`, and the system message says linking is not attaching a
Sidekick to a work stream.

**Why:** Linking a room to a Sidekick is the decision that it should work
there, and it was being undone by an unrelated event: the run-as user leaving
that Breakout stopped the Sidekick reading and posting in it. At the same
time a run could not reach a room its own person could open unless someone
linked it first, which made linking a chore rather than a decision. The
product rule is that a Sidekick's permission is its own plus its person's.
The rename followed from the same review: "attach" already meant recommending
a Sidekick to a work stream, which grants its runs nothing, and a model
offered both read them as one act.

**Considered and rejected:** Keeping an active Organization membership check
for the run-as user on linked conversations, so offboarding someone would stop
their Sidekicks there. The product rule is that a link grants by itself. If a
departed person's Sidekicks should stop, that is a decision about the Sidekick
(pausing it), and this change does not make it. Listing every conversation the person can open: a large
Organization would page through dozens of rooms on every list for a Sidekick
that uses two, so the list stays the Sidekick's own and a run names the rest.
Renaming `sidekick_conversation_attachments`: a migration for no change in
behavior, so the table keeps the tool's first name.

**Consequences:** Nothing re-checks a person on a linked conversation, so the
check when a link is made (the linking person can post there now) is the only
gate on it. A change that loosens that check loosens every run afterwards. A
future unlink tool is the only way to take a linked room back.

### 2026-09-27 — The conversation tools replace post_result

**What changed:** Agents gained `rally:conversations`, with a scope per loop:
a Breakout loop can list and read its own conversation and its Channel's Main,
and a Sidekick can list, read and post to its home and attachments, attaching
only from its configuration conversation. `post_result`, its
`rally:sidekick-result` plugin and the prompt's `# Result delivery` section
are gone; a run's system message now says its final message stays in the run
and a conversation hears a result only by `conversation_post`.

**Why:** A Sidekick run had one way into a room, `post_result`, fixed to the
owning Channel's Main conversation and deduplicated on the run id, and no way
to read anything. The Northstar weekly call prep flow needs one run to leave
answers in a Breakout that a later run reads, and a continued run to forward
each reply once, which a run-id key forbids.

**Considered and rejected:** Adding list and read to the Sidekick plugin. The
same tools serve Breakout agents, and a Sidekick-only surface would have meant
a second set later. Keeping `post_result` beside `conversation_post`: a model
offered both would not know which to use. Offering the tools to a Channel's
Main loop: the only conversation in its scope is itself. Making
`conversation_list` single-page: a list that truncated silently at its limit
would hide attachments, so it pages through the wrapper like read.

**Consequences:** A new kind of loop gets these tools only through a new arm of
`conversationToolAccess`. The limits are placeholders. Whether a post may leave
out `conversation` depends on the Sidekick having a home, which only a run
knows when the tools are built. Posting from a Breakout agent to its Main is
an open question in the PRD, not a gap.

Shipped in #1006. Design: [`docs/PRDs/2026-09-23_external-conversation-bindings/design.md`](PRDs/2026-09-23_external-conversation-bindings/design.md).
