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
attachments are [`automation-lifecycle.md`](automation-lifecycle.md)'s.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/conversation-tools.ts` | The plugin: `conversationToolAccess` (the one place a scope and tool set are derived from a loop), the four tools, the refusal table (`conversationRefusalError`), the system message, the page-size and character-budget placeholders, and `conversationToolPorts`, the calls the tools make. |
| `apps/api/src/services/integrations.ts` | `loadHarnessTools` builds the plugin next to the Sidekick plugin and passes the pagination wrapper under the `conversation` prefix. |
| `apps/api/src/durable-objects/workspace-conversation-tool-protocol.ts` | The scope, the WorkspaceDO request schemas and discriminated outcomes with the refusal codes, and the post request `appendConversationPost` takes. |
| `apps/api/src/durable-objects/workspace-sidekick-conversation-storage.ts` | Conversation ids, the scope read over `channels`, `breakouts` and their viewer rows, title lookup, and the attachment write. |
| `apps/api/src/durable-objects/workspace-do.ts` | `conversationToolScope`, `resolveConversationToolTarget`, `attachSidekickConversation`: scope from the directories, then admission through the hosted parent's `authorizeViewer`. |
| `apps/api/src/durable-objects/substream-agent.ts` | `appendConversationPost`: a post appended to any Channel or Breakout conversation, keyed on its client message id, without waking that conversation's agent. |
| `apps/api/src/durable-objects/workstream-message-storage.ts` | `readableMessagesBefore`: a conversation's messages newest first, without tool cards or suggestions. |
| `packages/agent-harness/src/tool-activity.ts` | The transcript wording for each `conversation_*` tool. |

## How it works

### Scope

| Loop | Scope | Tools | Acts as |
| --- | --- | --- | --- |
| Breakout (`parentKind: workstream`, substream not `"0"`) | Its own conversation and its Channel's Main | list, read | The person it works for |
| Sidekick configuration (`parentKind: automation`, substream `"0"`, no run) | The Sidekick's home and attachments | list, read, post, attach | The person talking to it |
| Sidekick run (`automationRun` present) | The Sidekick's home and attachments | list, read, post | The run-as user |

A Channel's Main loop gets no plugin: the only conversation it would reach is
the one it is in. Neither does a loop under workspace authority, nor a run
child woken without its `automationRun`. The plugin is `preload: true` and
`explicit: true`, and loading it reads nothing: the first tool call is the
first read.

### Tools

Wire names are `conversation_list`, `conversation_list_next`,
`conversation_read`, `conversation_read_next`, `conversation_post` and
`conversation_attach`. A `conversationId` is `<channelId>` for a Main
conversation and `<channelId>/<breakoutId>` for a Breakout, because a Breakout
id is unique only within its Channel. `conversation` accepts that id or the
exact title of a conversation in scope (compared without case); `attach` also
accepts a Rally link, which the Worker turns into an id before WorkspaceDO sees
it.

- **list** returns `{ conversations: [{ conversationId, kind, title, isHome, isOwn }] }`
  and a `nextPageId`. The home comes first, then (for a Breakout loop) Main,
  then attachments in the order they were made. Every call re-reads the
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
- **attach** takes `conversation` and returns
  `{ conversationId, kind, title, alreadyAttached }`. It writes one
  `sidekick_conversation_attachments` row per Sidekick and conversation.

### Admission

WorkspaceDO answers each read or post in one call: it builds the scope from its
own `automation_directory`, attachment rows, `channels`, `breakouts`,
`channel_viewers` and `breakout_viewers`, matches the reference against it,
and then admits the acting person to that one conversation: an active
relationship in `workspace_member_status`, then the hosted parent's
`authorizeViewer`, the same admission the conversation's transport uses, with
`requireGrantAuthority` for a guest so a guest reaches only what a grant gives
them. A list re-admits the same way: nothing for a person whose membership
ended, the directories' viewer rows for a member, and for a guest each
unarchived candidate's admission, since the viewer rows record no grants and
would drop what a grant gives. Attach admits the same way and additionally refuses an archived target,
which is the rule a write through `ConversationService.writableClient` follows:
attaching is the consent to publish there.

## Invariants

- **The scope is host-derived, from the loop input, in one function.**
  `conversationToolAccess` is the only place a scope or a tool set is decided. A
  scope that took a model argument would let a run widen its own reach.
- **Only a Sidekick's configuration conversation attaches.** A run is offered
  no attach, so it cannot reach anything its configuration did not grant.
- **A post never wakes the target's agent.** It is something people read, not a
  request to the agent there. Reusing `appendAutomationActivation` would start
  that agent on every forwarded reply, and it refuses any substream but Main.
- **A post is keyed on the receipt, not the run.** A retried receipt posts once;
  a new call in a later wake of the same run is a new post. Keying on the run
  alone, as `post_result` did, would swallow every reply after the first.
- **Every read and post admits the acting person again.** A continuation page
  or a listed id is never standing access; losing a Channel stops the next call.
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
Sidekick's home and attachments are, and who may change them, belongs to
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
| read, post, attach | `conversation_ambiguous` | `available` |
| attach | `conversation_not_found` | `field` |
| read, post, attach | `conversation_archived` | `resourceId` |
| read, post, attach | `conversation_access_denied` | `resourceId` |
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
  ledgers applied): the migrations, the attachment key, and the scope and title
  queries.
- `apps/api/test-workers/conversation-tools.test.ts` (workerd): the home
  projection, archive pausing a Breakout-homed Sidekick, attach refusal and
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
is what that user may read, within the Sidekick's attachments. What a run posts
is published to the target's audience; the person who attached that
conversation chose that audience.

## Changelog

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
