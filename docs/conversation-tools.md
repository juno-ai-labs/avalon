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
| `apps/api/src/durable-objects/workspace-conversation-tool-protocol.ts` | The WorkspaceDO request schemas and discriminated outcomes, with the refusal codes. |
| `apps/api/src/durable-objects/workspace-sidekick-conversation-storage.ts` | Conversation ids, the scope read over `channels`, `breakouts` and their viewer rows, title lookup, and the attachment write. |
| `apps/api/src/durable-objects/workspace-do.ts` | `conversationToolScope`, `resolveConversationToolTarget`, `attachSidekickConversation`: scope from the directories, then admission through the hosted parent's `authorizeViewer`. |
| `apps/api/src/durable-objects/substream-agent.ts` | `appendConversationPost`: a post appended to any Channel or Breakout conversation, keyed on its client message id, without waking that conversation's agent. |
| `apps/api/src/durable-objects/workstream-message-storage.ts` | `readableMessagesBefore`: a conversation's messages newest first, without tool cards or suggestions. |
| `packages/agent-harness/src/tool-activity.ts` | The transcript wording for each `conversation_*` tool. |

## How it works

### Scope

| Loop | Scope | Tools | Acts as |
| --- | --- | --- | --- |
| Channel Main or Breakout (`parentKind: workstream`) | Its own conversation and its Channel's Main | list, read | The person it works for |
| Sidekick configuration (`parentKind: automation`, substream `"0"`, no run) | The Sidekick's home and attachments | list, read, post, attach | The person talking to it |
| Sidekick run (`automationRun` present) | The Sidekick's home and attachments | list, read, post | The run-as user |

A loop under workspace authority, and a run child woken without its
`automationRun`, get no plugin. The plugin is `preload: true` and
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
- **post** takes `text` and an optional `conversation`, which defaults to the
  Sidekick's home, and returns `{ conversationId, messageId, replayed }`. The
  host derives the key `conversation-post:<harnessRunId>:<receiptId>`, looks it
  up on the target first, and returns the stored message with `replayed: true`
  if it is there. Otherwise the target's `appendConversationPost` writes an
  `automation_activation` message whose structured content names the Sidekick
  (and the run and its trigger, for a run), so the client renders it under the
  Sidekick's name. When the run was woken by an external message (a bound
  thread's reply), the host copies that sender into `externalSource`.
- **attach** takes `conversation` and returns
  `{ conversationId, kind, title, alreadyAttached }`. It writes one
  `sidekick_conversation_attachments` row per Sidekick and conversation.

### Admission

WorkspaceDO answers each read or post in one call: it builds the scope from its
own `automation_directory`, attachment rows, `channels`, `breakouts`,
`channel_viewers` and `breakout_viewers`, matches the reference against it,
and then admits the acting person to that one conversation through the hosted
parent's `authorizeViewer`, the same admission the conversation's transport
uses. Attach admits the same way and additionally refuses an archived target,
which is the rule a write through `ConversationService.writableClient` follows:
attaching is the consent to publish there.

## Invariants

- **The scope is host-derived, from the loop input, in one function.**
  `conversationToolAccess` is the only place a scope or a tool set is decided. A
  scope that took a model argument would let a run widen its own reach, which
  the PRD forbids outright.
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
external replies into a run or continue a run; those belong to the external
bindings and run continuation work in the same PRD. There is no detach tool.

## Failure modes and limits

Each refusal is a typed failure with a stable `code`, a model-visible sentence,
and only allowlisted `details`:

| Tools | `code` | Sentence | `details` |
| --- | --- | --- | --- |
| read, post | `conversation_not_in_scope` | You cannot reach "<value>". Call conversation_list and use one of its ids. | `available` |
| read, post, attach | `conversation_ambiguous` | Several conversations are titled "<value>". Use one of the ids in details.available. | `available` |
| attach | `conversation_not_found` | No Channel or Breakout matches "<value>". Ask the person for its link. | `field` |
| read, post, attach | `conversation_archived` | That conversation is archived, so it cannot be read or posted to. Tell the person. | `resourceId` |
| read, post, attach | `conversation_access_denied` | The account this runs as cannot open that conversation. Ask someone with access to attach it or share it. | `resourceId` |
| post | `invalid_arguments` | A Sidekick with no home left `conversation` out. | `field`, `expected` |
| read_next, list_next | the wrapper's page codes | As [`tool-pagination.md`](tool-pagination.md) says. | as there |

A post refused inside the target for any other reason throws
`conversation_post_refused:<code>`.

Limits, all placeholders for the team to set per
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md),
written as the numbers the design named: a page of 25 by default and at most 50
for list and read (`list_resources`' numbers), and a read budget of 12,000
characters per page (`read_resource`'s). They live as constants at the top of
`conversation-tools.ts`. The echo of a refused value is cut to 160 characters,
the shared failure-detail bound.

## Testing

- `apps/api/test/conversation-tools.test.ts` (Node): which loop gets which
  tools, the wire names and their order, each schema's required, optional and
  forbidden arguments with the explicit unspecified value, the pinned
  system-message lines, each refusal's sentence and details, the post key and
  replay-first lookup, the read budget and continuation, and link parsing.
  WorkspaceDO and the target are a typed double there; everything they decide
  is proved on workerd.
- `apps/api/test/sidekick-conversation-storage.test.ts` (Node, the object
  ledgers applied): the migrations, the attachment key, and the scope and title
  queries.
- `apps/api/test-workers/conversation-tools.test.ts` (workerd): the home
  projection, archive pausing a Breakout-homed Sidekick, attach refusal and
  idempotency, scope refusal, list re-admission after leaving a Breakout,
  archived refusal, and an append that lands once without waking.
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

### 2026-09-27: The conversation tools replace post_result

**What changed:** Agents gained `rally:conversations`, with a scope per loop:
a Channel or Breakout loop can list and read its own conversation and its
Channel's Main, and a Sidekick can list, read and post to its home and
attachments, attaching only from its configuration conversation.

**Why:** A Sidekick run had one way into a room, `post_result`, fixed to the
owning Channel's Main conversation and deduplicated on the run id, and no way
to read anything. The Mucker weekly call prep flow needs one run to leave
answers in a Breakout that a later run reads, and a continued run to forward
each reply once.

**Considered and rejected:** Adding list and read to the Sidekick plugin. The
same tools serve Channel and Breakout agents, and a Sidekick-only surface
would have meant a second set later. Keeping `post_result` beside
`conversation_post`: a model offered both would not know which to use.
Making `conversation_list` single-page: its output has a `nextPageId`, and a
list that truncated silently at its limit would hide attachments, so it pages
through the wrapper like read.

**Consequences:** A new kind of loop gets these tools only through a new arm of
`conversationToolAccess`. The limits are placeholders. Posting from a Channel
or Breakout agent to its Main is an open question in the PRD, not a gap.

Design: [`docs/PRDs/2026-09-23_external-conversation-bindings/design.md`](PRDs/2026-09-23_external-conversation-bindings/design.md).
