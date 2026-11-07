# Conversation tools

`rally:conversations` is the built-in plugin that lets an agent list, read,
search, and post to Rally conversations. It is one set of tools and a
**scope**: a function from the loop's input to the conversations it may reach
and the tools it is offered. Adding a new kind of agent means adding a scope,
never new tools. The model never supplies, names, or widens a scope.

To the model every conversation is the same thing: an id, a title, and
messages. A Sidekick's own conversation and a Canvas's Chat are both read from
the conversation's own object; the entry's internal `kind` (`sidekick` or
`canvas`) routes the search audience and the post's parent kind. Only
`conversation_attach`'s output carries it, as `canvas`.

Read this before changing what an agent can read or post to outside its own
conversation, and before giving a new kind of loop these tools. The tool design
rules are [`agent-tools.md`](agent-tools.md)'s; the page-id mechanism is
[`tool-pagination.md`](tool-pagination.md)'s; a Sidekick's attached
conversations are [`automation-lifecycle.md`](automation-lifecycle.md)'s.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/conversation-tools.ts` | The plugin: `conversationToolAccess` (the one place a scope and tool set are derived from a loop), the tools, the refusal table (`conversationRefusalError`), the system message, the page-size and character-budget placeholders, and `conversationToolPorts`, the calls the tools make, `searchMessages` among them. |
| `apps/api/src/services/integrations.ts` | `loadHarnessTools` builds the plugin next to the Sidekick plugin and passes the pagination wrapper under the `conversation` prefix. |
| `apps/api/src/durable-objects/workspace-conversation-tool-protocol.ts` | The scope, the WorkspaceDO request schemas and discriminated outcomes with the refusal codes, and the post request `appendConversationPost` takes. |
| `apps/api/src/durable-objects/workspace-sidekick-conversation-storage.ts` | Conversation ids, the scope read over `automation_directory`, `canvas_directory` (the Canvases a Sidekick writes) and `sidekick_conversation_attachments`, Canvas title lookup, and the attachment write. |
| `apps/api/src/durable-objects/workspace-do.ts` | `conversationToolScope`, `resolveConversationToolTarget`, `attachSidekickConversation`: scope from the directories, then admission through the hosted parent's `authorizeViewer` (`canvasAdmits` for a Canvas, `sidekickAdmits` for a Sidekick) as the acting person. |
| `apps/api/src/durable-objects/agent-loop-do.ts` | `appendConversationPost`: a post appended to a Canvas's Chat or a Sidekick's own conversation, keyed on its client message id, without waking that conversation's agent. |
| `apps/api/src/durable-objects/workstream-message-storage.ts` | `readableMessagesBefore`: a conversation's messages newest first, without tool cards or suggestions. |
| `packages/agent-harness/src/tool-activity.ts` | The transcript wording for each `conversation_*` tool. |

## How it works

### Scope

| Loop | Scope | Tools | Acts as |
| --- | --- | --- | --- |
| Sidekick configuration (`parentKind: automation`, substream `"0"`, no run) | The Sidekick's own conversation (`isOwn`), the Canvases it writes, and the Canvases attached to it | list, read, search, post, attach | The person talking to it |
| Sidekick run (`automationRun` present) | The Sidekick's own conversation (`isParent`), the Canvases it writes, and the Canvases attached to it | list, read, search, post | The run-as user |

A Canvas's Chat gets no conversation tools: its own transcript is its context.
The Canvases a Sidekick writes are those whose `writer_sidekick_id` names it
(each run's Canvas), newest made first; attachments follow in the order they were
made, a Canvas both written and attached listed once. An attachment row of a
retired Thread (`parent_kind = 'workstream'`) names nothing. Canonical
admission decides each candidate for the acting person on every call: a Canvas
by `canvasAdmits` (its visibility, creator, participants, and a writer
Sidekick's audience), a Sidekick by `sidekickAdmits`.

A Sidekick's own conversation is its shared conversation, substream `"0"`
under the Sidekick (`kind: "sidekick"` to the host). Its `conversationId` is
the Sidekick's id, it is always first in a Sidekick scope, and it is admitted by
the Sidekick (`HostedSidekick.authorizeViewer`). It is read and posted to like any other conversation.
Search asks the index for the Sidekick's group (`sidekick:<id>`), which is the
group its turns are indexed under, and which its runs' conversations share;
only hits in `"0"` are kept. A run's conversation is never in scope.

Scope discovery and list admission stay within WorkspaceDO, without
per-conversation cross-object calls.

A loop under workspace authority gets nothing, nor a
run child woken without its `automationRun`. The plugin is `preload: true` and
`explicit: true`, and loading it reads nothing: the first tool call is the
first read.

### Tools

Sidekick activation instructions direct the model to post an unresolved
permission problem to the owning conversation once for that run, naming the
blocked work and a concrete recovery action. Successful account fallback needs
no error post. This uses the same `post` authorization and receipt, and grants
no extra destination access. A refused post must stay a visible failure; its
attempt is never evidence of delivery. An activation post refused by scope,
access or archival also records the existing Sidekick attention state with a
fixed recovery message. No provider or event content is retained there, and
ordinary successful posts perform no extra RPC. A later admitted occurrence
clears attention through normal admission. The actionable failure stays on
the activation.

Wire names are `conversation_list`, `conversation_list_next`,
`conversation_read`, `conversation_read_next`, `conversation_post` and
`conversation_attach`. A `conversationId` is the parent's id: a Canvas's for
its Chat, a Sidekick's for its own conversation. `conversation` accepts that id
or the exact title of a conversation in scope (compared without case); `attach`
also accepts a Rally link, which the Worker turns into an id before WorkspaceDO
sees it, or a Canvas's title among the Canvases the person can open.

- **list** returns `{ conversations: [{ conversationId, title, isOwn, isParent }] }`
  and a `nextPageId`. The Sidekick's own conversation comes first, then the
  Canvases it writes, then its attachments. `isParent` marks the conversation a
  run sits inside, its Sidekick's. Every call re-admits each conversation for
  the acting person and omits what they can no longer open.
- **read** takes `conversation` and `limit` and returns
  `{ conversationId, title, messages, nextPageId }`, newest first. Each message
  has an author (`person`, `agent`, `sidekick`, `external`, `system`) with a
  name, `sentAt`, `text`, `textTruncated` and `externalSource`. A Sidekick's
  post reads as the Sidekick, `kind: "sidekick"` with its `sidekickId`, never as
  `agent`, which is Rally's own; its `externalSource` names the person outside
  Rally whose words it forwarded. A page stops at `limit` messages or the character budget; one
  message longer than the whole budget returns its first part, marked. The
  continuation is private: the conversation id, the sequence to read before,
  and the page size, stored by the pagination wrapper beside the loop's
  receipts. Every page is admitted again.

- **search** takes `query`, an optional `conversation` and `limit`, and returns
  `{ matches: [{ conversationId, title, messageId, sentAt, text, textTruncated }] }`,
  newest first, within the read budget. It searches the loop's scope, never
  everything the person may read. The matching is
  member search's (`docs/text-search.md`): one substring query over the shared
  index, conversation messages under `messages`. Its audience is the groups the
  scope's conversations carry (`conversationSearchGroups`: a Canvas's Chat's
  `conversation:<canvasId>/0`, a Sidekick's `sidekick:<id>`), not the person's
  own, so search reaches exactly as far as read does; every group names a
  conversation already admitted, and hits are named from those conversations. The index ranks substring
  candidates by document id, a hash, and stores `occurred_at` unindexed
  (`filterable: false`), so it cannot order by time and the newest match can be
  on any page. Candidate pages use the existing maximum conversation page size
  independently of the requested hit count, so asking for one hit does not page
  through the index one match at a time. `newestSearchHits` reads every candidate
  page and keeps the newest `limit`; `MAXIMUM_SEARCH_CANDIDATE_PAGES` is the open bound on how many
  pages one search reads (`LIMIT UNSET`). Indexing `occurred_at` would let the
  index sort, at an indexing cost on every row; that is the team's call. The
  tool has no continuation: a narrower query, or a read of the conversation,
  finds more than `limit`.
- **post** takes `text` and `conversation`, and returns
  `{ conversationId, messageId, replayed }`. `conversation` may always be left
  out: the post lands in the Sidekick's own conversation, where everyone the
  Sidekick is shared with reads it. The post request carries the target's `parentKind`
  (`automation` or `canvas`, required), and
  `appendConversationPost` refuses one that does not match the object, or an
  `automation` target that is not substream `"0"`. The host derives the key
  `conversation-post:<harnessRunId>:<receiptId>`, and the target's
  `appendConversationPost` writes once per key, answering a replay with the
  message it already wrote. It writes an `automation_activation` message whose
  structured content names the Sidekick (and the run and its trigger, for a
  run), so the client renders it under the Sidekick's name. When the run was
  woken by an external message (a bound thread's reply), the host copies that
  sender into `externalSource`. A run's system message says its final message
  is the reply on its row in the Sidekick's shared conversation, so it never
  posts that reply there again; another conversation hears a result only by a
  post ([`automation-lifecycle.md`](automation-lifecycle.md#runs-in-the-shared-conversation)). Its
  description and the plugin's instructions steer a Sidekick's own reports
  through this path.
- **attach** takes `conversation` and returns
  `{ conversationId, kind, title, alreadyAttached }`. It writes one
  `sidekick_conversation_attachments` row per Sidekick and conversation.
- **merge** (`conversation_merge`) is retired: its backend was deleted with
  `ConversationMergeService` (plan step C-2); see the changelog.

### Admission

WorkspaceDO answers each read or post in one call: it builds the scope from its
own `automation_directory`, `canvas_directory` and attachment rows, matches the reference against it,
and then admits the acting person to that one conversation: an active
relationship in `workspace_member_status`, then the hosted parent's
`authorizeViewer`, the same admission the conversation's transport uses, with
`requireGrantAuthority` for a guest so a guest reaches only what a grant gives
them. A list re-admits the same way: nothing for a person whose membership
ended, and each candidate's own admission otherwise. When titles collide, only
admitted candidates take part in disambiguation, so an ambiguity response never
names a conversation the person cannot open.
Attach admits the same way and additionally refuses an archived target,
which is the rule a write through `ConversationService.writableClient` follows:
attaching is the consent to publish there.

## Invariants

- **The scope is host-derived, from the loop input, in one function.**
  `conversationToolAccess` is the only place a scope or a tool set is decided. A
  scope that took a model argument would let a run widen its own reach.
- **Only a Sidekick's configuration conversation attaches.** A run is offered
  no attach, so it cannot reach anything its configuration did not grant.
- **A post never wakes the target's agent.** It is something people read, not a
  request to the agent there. Admitting it as loop input, as `post_result` did,
  would start that agent on every forwarded reply. The agent still reads it:
  the next run's gap-fill appends it as an aside attributed to the Sidekick
  ([`agent-harness.md`](agent-harness.md)), so "send that reply" can refer to
  it.
- **A post is keyed on the receipt, not the run.** A retried receipt posts once;
  a new call in a later wake of the same run is a new post. Keying on the run
  alone, as `post_result` did, would swallow every reply after the first.
- **Every read and post admits the acting person again.** A continuation page
  or a listed id is never standing access; losing a Canvas stops the next call.
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
Sidekick's attached conversations are, and who may change them, belongs to
[`automation-lifecycle.md`](automation-lifecycle.md). It does not route
external replies into a run, which is
[`external-conversation-bindings.md`](external-conversation-bindings.md)'s, or
continue a run, which is `automation-lifecycle.md`'s. There is no detach tool.

## Failure modes and limits

Each refusal is a typed failure with a stable `code`, a model-visible sentence
(`conversationRefusalError` holds them), and only allowlisted `details`:

| Tools | `code` | `details` |
| --- | --- | --- |
| read, search, post | `conversation_not_in_scope` | `available` |
| read, search, post, attach | `conversation_ambiguous` | `available` |
| attach | `conversation_not_found` | `field` |
| read, search, post, attach | `conversation_archived` | `resourceId` |
| read, search, post, attach | `conversation_access_denied` | `resourceId` |
| read_next, list_next | the wrapper's page codes, per [`tool-pagination.md`](tool-pagination.md) | as there |

`available` is cut to the shared failure-detail bound,
`MAXIMUM_FAILURE_AVAILABLE_VALUES`. A post refused inside the target for any
other reason throws `conversation_post_refused:<code>`.

Limits, all placeholders for the team to set per
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md),
written as the numbers the design named: `MAXIMUM_SEARCH_CANDIDATE_PAGES`, open,
bounds how many index pages one search reads. The complete scan can span every
Canvas in a Sidekick's scope; a finite bound would make
newest-hit results incomplete because the index is ordered by id. A page of 25
by default and at most 50 for list, read and search (`list_resources`' numbers), and a read budget of 12,000
characters per page (`read_resource`'s). They live as constants at the top of
`conversation-tools.ts`. The echo of a refused value in a sentence,
`MAXIMUM_ECHO_CHARACTERS`, is open (`LIMIT UNSET`); a reference has no length
bound of its own. Every cut, the read budget's included, keeps a character
whole rather than splitting it.

## Testing

- `apps/api/test/conversation-tools.test.ts` (Node): which loop gets which
  tools (none for a Canvas's Chat), the wire names and their order, each
  schema's required, optional and forbidden arguments, the pinned
  system-message lines (a run's final-message instruction among them), each
  refusal's sentence and details, the post key and its replay, the read budget
  and its cut, the continuation, link parsing, and search: matches from a
  Sidekick's conversation and a Canvas's Chat, newest first, a hit outside the
  scope dropped, the newest matches kept across candidate pages, and each
  kind's audience group. WorkspaceDO and the target are a typed double there;
  everything they decide is proved on workerd.
- `apps/api/test/sidekick-conversation-storage.test.ts` (Node, the object
  ledgers applied): the attachment key filed as `canvas`, the scope's order
  and deduplication, a deleted Canvas or Sidekick dropped, a retired Thread
  attachment ignored, the title query, and conversation ids.
- `apps/api/test-workers/conversation-tools.test.ts` (workerd), "a Sidekick's
  Canvases through the conversation tools": the real plugin over the real
  ports lists the Sidekick's conversation, its written Canvas and its attached
  Canvases as each person may open them, refuses a read of one the person
  cannot open, refuses to attach a Canvas the person cannot open (by title it
  is not found, by id access is denied), and posts into a written Canvas's
  Chat once per receipt and reads it back. Each was seen to fail with list
  admission skipped, the title match unadmitted, or the post sent under the
  Sidekick's parent kind.
- `apps/api/test-workers/automation-post-result.test.ts` (workerd): a real run,
  scripted with `useOpenRouterDouble`, calling `conversation_post`.

## Security and trust model

Text returned by `read` and `search` is untrusted content: the system message tells the
model messages are other people's words, and nothing in them can change the
scope. No credentials are involved; every call stays inside the Organization's
own objects. A run acts as its run-as user whoever woke it, so what it may read
is what that user may read, within the Sidekick's attachments. What a run posts
is published to the target's audience; the person who attached that
conversation chose that audience.

## Changelog

### 2026-11-07 — A Sidekick reaches its Canvases; Thread scopes are gone

**What changed:** The scope is a Sidekick's alone: its own conversation, the
Canvases it writes (`canvas_directory.writer_sidekick_id`) and the Canvases
attached to it, read from `automation_directory`, `canvas_directory` and
`sidekick_conversation_attachments` instead of `channels` and `breakouts`.
`conversation_attach` resolves a Canvas by link, id or title and files it as
`canvas`; `conversation_post` into a Canvas's Chat sends `parentKind: canvas`.
The Thread and Breakout scope, the Sidekick's home (`isHome`,
`conversation_home_missing`), the Channel feed read and the Breakout-to-Main
admission are deleted, and a conversation id is one UUID.

**Why:** The Canvases and Sidekicks PRD's decision log retires Threads,
Channels and Breakouts; nothing writes the directories the old scope read, so
a Canvas a Sidekick should report into was unreachable (the gap the previous
entry recorded). Each Canvas is admitted by `canvasAdmits` through its hosted
parent, the rule its own transport applies, rather than a second rule here.

**Considered and rejected:** Conversation tools for a Canvas's Chat: its own
transcript and the Canvas's content are its context (the PRD's "Agent
behavior"), and no PRD flow needs Rally in a Canvas to read another Canvas or
a Sidekick's conversation. A Sidekick's conversation as an attachment of
another Sidekick: nothing in the PRD has one Sidekick report into another, so
only a Canvas's Chat is attachable.

**Respect:** A title names only Canvases the acting person can open: an attach
by title admits every match before it reports one, so a private Canvas's id is
never disclosed by a guess.

### 2026-11-07 — The merge tool is retired

**What changed:** `conversation_merge` is no longer given to any loop, and its
backend (`ConversationMergeService`, the ports, the argument schema and the
refusal sentences) is deleted. A Thread or Breakout loop keeps list, read and
search until those loops go with Threads.

**Why:** No Thread or Breakout remains to merge from after the Canvases and
Sidekicks cutover, and the merge route went with the Thread routes. The prompt
vocabulary that named merging (`conversationsSystemMessage`'s `merges`
line, always off since then, and `mergeInstruction`) was deleted in plan step
C-2; no golden hash covered it, because no loop could turn it on.

### 2026-11-06 — A post that names no conversation lands in the Sidekick's own conversation

**What changed:** A Sidekick scope now lists the Sidekick's own shared
conversation (`"0"`, `kind: "sidekick"`, id the Sidekick's) first, admitted by
the Sidekick; `conversation_post` with no `conversation` posts there instead of
to the home, so `conversation` is never required; and `appendConversationPost`
accepts `parentKind: "automation"` substream `"0"` beside a Thread's
conversations. Attachments stay reachable by id or title. Then, with the
`workstream` scope retired (plan step A-5), a Sidekick has no home at all, and
its wizard's scope no longer lists the General or Personal Channel a review
announced in: a review announces in the Sidekick's own conversation, and
`post` to a Channel's feed is refused, so `postSidekickChannelMessage` is gone.

**Why:** The Canvases and Sidekicks pivot gives every Sidekick one shared
conversation that everyone it is shared with reads, and the plan makes it the
place a Sidekick's report goes by default. Most Sidekicks have no home, so a
run had nowhere in Rally to post without naming somewhere; the home is a Thread,
and Threads are being retired. The own conversation is derived from the
Sidekick, like the home, so it needs no `sidekick_conversation_attachments`
row and the table's `parent_kind = 'workstream'` CHECK is unchanged. The
`parentKind` field defaults to `workstream` so a post request written before it
existed still means what it meant; a Canvas's conversation joins its enum. The
review's Channel announcement went for the same reason: General and a Personal
Channel are retired surfaces, and the people a Sidekick works for read its own
conversation.

**Consequences:** A homed Sidekick's run that left `conversation` out used to
post in its Thread and now posts in its own conversation; instructions that
want the Thread must name it. The `home` option of `createConversationsPlugin`
and `conversationsSystemMessage` is gone, and so is the "conversation cannot be
left out" refusal path for a post (`conversation_home_missing` remains for the
Terminal publication home, which still resolves `reference: null` to the home).
`conversation_search` over the own conversation asks for the Sidekick's search
group, not a conversation's, because that is the group its turns carry.

### 2026-10-29 — A Sidekick's scope lists the Channel its review announces in, and `post` reaches it

**What changed:** A Sidekick's authoring conversation's scope (`authoring:
true` on the scope; a run's scope never carries it) lists one Channel beside
its home and attachments: General for an
Organization Sidekick, or its author's Personal Channel when General is
archived or absent, and the author's Personal Channel for a personal one
(`WorkspaceDO.sidekickAnnouncementSpaceId`). `post` to a Channel target
writes a message in the Channel's own feed through
`postSidekickChannelMessage`, from Rally and opening with the Sidekick's
name, keyed on the tool call's client message id; the RPC admits only that
one Channel for that Sidekick, and only a person who can read it.

**Why:** The scheduled self-review ([`automation-lifecycle.md`](automation-lifecycle.md#scheduled-self-review))
announces a change where the Sidekick's people are, and a Sidekick no room
owns has no Thread to post to. Channels hold messages of their own, so the
announcement is one of those rather than a new surface.

**Consequences:** A Channel entry in a Sidekick scope is never its home and
never `isHome`; a post with no reference still goes to the Thread or
Breakout home. A run never lists or posts to the Channel: it acts on its
trigger's content, and the Channel's feed is not its audience. The author of a Channel message is `rally` or a member, so the
Sidekick's name is in the body, not the author.

### 2026-10-23 — Guide Sidekick delivery toward its own identity

**What changed:** Posting and authoring instructions name `conversation_post`
as the delivery action for a Sidekick's reports. Both the wizard and runs receive
this guidance because either can deliver results to another conversation; the
wizard is explicitly told to answer the person inline during configuration.
Delegates without the posting tool return results to the delegating agent.
Engineering MCP's send description explains its own attribution behavior.

**Why:** A delegated reporting agent used Engineering MCP's send-as-user tool,
so its report was stored and displayed as a message from the delegating user.

**Considered and rejected:** Blocking engineering sends or narrowing connector
capabilities. The requested fix is model guidance while retaining sending.

**Consequences:** These instructions steer attribution but do not enforce a
permission boundary or change existing messages. Keep delivery instructions in
the Sidekick prompts and tool descriptions focused on their own effects.

PR: [#1438](https://github.com/juno-ai-labs/avalon/pull/1438).

### 2026-10-22 — Keep refused Sidekick posts visible

**What changed:** An activation's refused post sets the existing Sidekick
attention field, while preserving the original tool refusal and delivery receipt.

**Why:** Prompt guidance can explain a blocked destination, but finishing that
explanation otherwise left the Sidekick looking healthy without a delivered
report. People need a visible recovery action on its own screen.

**Considered and rejected:** A new notification queue or a second reporting tool.
The existing attention state and post refusal already identify the failure.

**Consequences:** Healthy posts have no additional authority read or write.
Scope and destination admission stay unchanged; a refused call never claims
delivery or falls back to a different conversation.

### 2026-10-22 — Conversation tools reach the current Thread's Channel peers

**What changed:** Thread and Breakout loops can list, read and search every
Thread and Breakout in the Channels containing their current Thread. Candidate
placements are deduplicated, directory facts are read in one batch, and every
target keeps its canonical admission.

**Why:** The product owner asked agents to work across the conversations in the
same Channels. Reading only the current conversation and its parent feeds left
peer discussions outside the tools' reach even when the person could open them.

**Considered and rejected:** Expanding to every conversation the acting person
can read would include unrelated Channels. Following a peer's placements again
would make scope transitive and spread it beyond the current Thread's Channels.
Granting access from placement alone would expose private Threads and Breakouts.

**Consequences:** List, read and search share the same expanded candidates on
every call. Channel visibility, conversation admission and archival still narrow
them. Parent feeds precede peer conversations in paginated lists. Duplicate
titles are disambiguated only among readable candidates; UUID-shaped peer titles
remain opaque, while known own/parent targets retain specific refusals. Search
fetches full candidate pages while retaining only the requested newest hits.
Sidekick attachments and merge destinations keep their existing contracts.

Pull request: [#1403](https://github.com/juno-ai-labs/avalon/pull/1403).

### 2026-10-19 — Thread and Breakout loops read and search their Channels, and every conversation looks the same

**What changed:** A Thread's Main loop gets list, read and search beside merge,
and a Breakout loop gains search. Both reach the Channels their thread is in,
read through the Channel screen's own feed. Every loop with read gets
`conversation_search`, which searches every conversation the loop reads, the
ones above it included. `conversation_list` no longer returns `kind`; it marks a
conversation the loop sits inside with `isParent`. A Breakout's instruction to
read "the Thread's Main conversation" became one line for both loops about
reading what they sit inside.

**Why:** A person writing in a new Thread said "using the ICP above", meaning
a result merged into the Channel. The Thread's agent could read nothing but
itself, so it guessed. The product owner then asked that the agent not have to
tell a Channel from a Thread from a Breakout, since that is how Rally stores
them, not something the agent decides on; and that it be able to search for a
word such as "ICP" rather than page through every conversation.

**Considered and rejected:** Putting a Channel's recent merges in a new
Thread's opening context: it costs prompt space in every Thread and goes stale
as merges land. Admitting a Channel through the thread's placement: it would
show a member a private Channel they cannot open. Searching everything the
person can read: in a shared Thread it would show the asker's private threads
to everyone in the room. Admitting search by the person's own audience groups:
a Breakout member outside its Thread could read Main but not search it, and
the owner's rule is that a loop can always search up. A search in WorkspaceDO's SQL beside the index, which
the first draft had: the owner asked for one search path, so Channel messages
went into the index instead (`text-search.md`).

**Consequences:** The scope of a Thread or Breakout loop now spans two
authorities: conversation objects for Threads and Breakouts, and WorkspaceDO's
Space storage for Channels. A new tool that acts on a listed conversation must
route on the entry's `kind` and must not expose it. A Channel cannot be posted
to or attached; neither loop with Channels in scope is offered post or attach,
and offering one would need a Channel write path first.

### 2026-10-16 — Breakout and Thread Main loops can merge their result up

**What changed:** A Breakout loop gets `conversation_merge` beside list and
read, merging into its Thread's Main; a Thread's Main loop, which had no
conversation tools, gets `conversation_merge` alone, merging into every
Channel the thread is in. The tool takes the words alone.

**Why:** People ask Rally to "merge this back once Samantha approves". The
Merge button covers the person doing it themselves, and the product owner
asked for the agent path back after an earlier draft of the design cut it.

**Considered and rejected:** A merge tool that takes a target from the model,
including the PRD's optional `channel`: the product owner asked for the tool to
stay simple and merge into all parents, and a named Channel brought ambiguity
(two Channels can share a name) for a choice the person rarely needs.
The target is host-derived from the loop, as every scope here is, so a model
cannot post somewhere the person did not open. A Breakout loop posting to Main
through `conversation_post` was rejected: it carries no merge tags and the
Thread's readers could not tell a result from a note.

**Consequences:** `conversationToolAccess` now returns a scope for a Thread's
Main loop, so anything that assumed "Main gets nothing" must read the tool
list instead. The tool runs as the person through a server-built `connector`
principal; a loop whose person has left is refused as `conversation_access_denied`.

Design: [`PRDs/2026-10-16_merge-back/agent-behavior.md`](PRDs/2026-10-16_merge-back/agent-behavior.md).

### 2026-10-08 — A Breakout reads its Channel whoever is in it

**What changed:** In a Breakout loop's scope, `conversation_list` and
`conversation_read` admit the Channel's Main through the acting person's
admission to the Breakout, not their admission to the Channel. The plugin's
system message tells a Breakout loop to read Main when it needs more than its
opening summary.

**Why:** The product rule is that a Breakout has full access to its parent's
messages. Breakout membership never required the Channel, so a member added
from outside it got `conversation_access_denied` on the one conversation the
Breakout was branched from.

**Considered and rejected:** Limiting Breakout membership to people who can read
the Channel, which would end guest-only Breakouts; and checking per run that
every Breakout member can read the Channel. The owner chose to accept that a
Breakout member reads the Channel through the agent.

**Consequences:** What is read is unchanged: `readableMessagesBefore`, what was
said, without tool cards or suggestions. A Sidekick's scope admits every target
as itself, as before. The substitution is for reading: a Breakout loop has no
post, and giving it one would let a member outside the Channel post to Main
unless `admissionAddress` learns the difference.

Shipped in #1179.

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
to read anything. The Mucker weekly call prep flow needs one run to leave
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
