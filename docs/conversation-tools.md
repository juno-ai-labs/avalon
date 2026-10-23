# Conversation tools

`rally:conversations` is the built-in plugin that lets an agent list, read,
search, and post to Rally conversations. It is one set of tools and a
**scope**: a function from the loop's input to the conversations it may reach
and the tools it is offered. Adding a new kind of agent means adding a scope,
never new tools. The model never supplies, names, or widens a scope.

To the model every conversation is the same thing: an id, a title, and
messages. A Channel, a Thread's Main and a Breakout are read from different
places (WorkspaceDO's feed, or the conversation's own object), but that is the
host's routing on the entry's internal `kind`, which no tool output carries.

Read this before changing what an agent can read or post to outside its own
conversation, and before giving a new kind of loop these tools. The tool design
rules are [`agent-tools.md`](agent-tools.md)'s; the page-id mechanism is
[`tool-pagination.md`](tool-pagination.md)'s; a Sidekick's home and its
attachments are [`automation-lifecycle.md`](automation-lifecycle.md)'s.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/conversation-tools.ts` | The plugin: `conversationToolAccess` (the one place a scope and tool set are derived from a loop), the tools, the refusal table (`conversationRefusalError`), a Channel's feed rendered as messages (`channelItemText`), the system message, the page-size and character-budget placeholders, and `conversationToolPorts`, the calls the tools make, `searchMessages` among them. |
| `apps/api/src/services/integrations.ts` | `loadHarnessTools` builds the plugin next to the Sidekick plugin and passes the pagination wrapper under the `conversation` prefix. |
| `apps/api/src/durable-objects/workspace-conversation-tool-protocol.ts` | The scope, the WorkspaceDO request schemas and discriminated outcomes with the refusal codes, and the post request `appendConversationPost` takes. |
| `apps/api/src/durable-objects/workspace-sidekick-conversation-storage.ts` | Conversation ids, the scope read over `channels`, `breakouts`, their viewer rows and active Channel placements, title lookup, and the attachment write. |
| `apps/api/src/durable-objects/workspace-do.ts` | `conversationToolScope`, `resolveConversationToolTarget`, `attachSidekickConversation`: scope from the directories, then admission through the hosted parent's `authorizeViewer`. `conversationToolChannels`: the Channels a Thread or Breakout loop's thread is in, from Space storage. `listChannelFeed`, the Channel screen's own read, is what a Channel's read calls. |
| `apps/api/src/durable-objects/substream-agent.ts` | `appendConversationPost`: a post appended to any Channel or Breakout conversation, keyed on its client message id, without waking that conversation's agent. |
| `apps/api/src/durable-objects/workstream-message-storage.ts` | `readableMessagesBefore`: a conversation's messages newest first, without tool cards or suggestions. |
| `packages/agent-harness/src/tool-activity.ts` | The transcript wording for each `conversation_*` tool. |

## How it works

### Scope

| Loop | Scope | Tools | Acts as |
| --- | --- | --- | --- |
| Breakout (`parentKind: workstream`, substream not `"0"`) | Its own conversation, its Thread's Main, the Channels the Thread is in, and all Threads and Breakouts in those Channels | list, read, search, merge | The person it works for, admitted to Main by the Breakout |
| Thread Main (`parentKind: workstream`, substream `"0"`) | Its own thread, the Channels it is in, and all Threads and Breakouts in those Channels | list, read, search, merge | The person it works for |
| Sidekick configuration (`parentKind: automation`, substream `"0"`, no run) | The Sidekick's home and attachments | list, read, search, post, attach | The person talking to it |
| Sidekick run (`automationRun` present) | The Sidekick's home and attachments | list, read, search, post | The run-as user |

A Thread's Channels are the ones `channelSpaceIds` lists for the acting person
today, unarchived, Organization-wide first: the person's own reach, never the
thread's placement, so a member outside a private Channel is not offered it
even from a thread in it. Every active thread placement in those Channels adds
that Thread's Main and all its Breakouts as candidates. Shared placements count
once, and a sibling's other Channels do not extend the scope: it is one hop
from the current Thread's Channels, never the whole Organization. Canonical
admission still decides each candidate independently; being in a Channel grants
no access to a private Thread or Breakout. Sidekick scopes stay at their home
and explicit attachments.

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
clears attention through normal admission. A Sidekick without a home leaves the
actionable failure on its activation.

Wire names are `conversation_list`, `conversation_list_next`,
`conversation_read`, `conversation_read_next`, `conversation_post` and
`conversation_attach`. A `conversationId` is `<channelId>` for a Main
conversation and `<channelId>/<breakoutId>` for a Breakout, because a Breakout
id is unique only within its Channel. `conversation` accepts that id or the
exact title of a conversation in scope (compared without case); `attach` also
accepts a Rally link, which the Worker turns into an id before WorkspaceDO sees
it.

- **list** returns `{ conversations: [{ conversationId, title, isHome, isOwn, isParent }] }`
  and a `nextPageId`. The home (or the loop's own) comes first, then (for a
  Breakout loop) Main, then the Channels' feeds, then the peer Threads and
  Breakouts ordered by id. Parents stay ahead of peers across list pages. A
  Sidekick's home comes first, then attachments in the order they were made. `isParent` marks a
  conversation this one sits inside: a Breakout's Main, a Thread's Channel.
  Every call re-reads the directories for the acting person and omits what they can no longer open and anything
  archived. A Channel's id is its Space id, a UUID no Thread shares.
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

  A Channel reads through `listChannelFeed` as the acting person, so a read
  shows exactly what their Channel screen shows. Its items become messages:
  a thread placed there reads as its starter writing `Started the conversation
  "<title>": <description>`, and a merge as the person who merged it writing
  `Merged the result of "<title>" here:` and the body, or `of a conversation`
  when the thread is private to this reader. The feed's pages are larger than a
  read's, so a Channel's continuation is the feed cursor of the page being read
  and the last item returned from it (its placement time and id); the next
  read fetches that page again and resumes after that item in the feed's own
  order. Not after a count: a merge landing, or a message removed, between two
  pages moves every item below it, and an offset would repeat or skip one.
- **search** takes `query`, an optional `conversation` and `limit`, and returns
  `{ matches: [{ conversationId, title, messageId, sentAt, text, textTruncated }] }`,
  newest first, within the read budget. It searches the loop's scope, never
  everything the person may read: in a shared Thread a search as the asker
  would otherwise show their private threads to the room. The matching is
  member search's (`docs/text-search.md`): one substring query over the shared
  index, Thread and Breakout messages under `messages` and Channel messages
  under `channel_messages`. Its audience is the groups the scope's
  conversations carry (`conversationSearchGroups`), not the person's own:
  search reaches up exactly as far as read does. A Breakout member who cannot
  open its Thread reads the Thread's Main through the Breakout, so they find
  what was said there too; every group names a conversation already admitted,
  and hits are named from those conversations. The index ranks substring
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
- **merge** (`conversation_merge`) takes `body` alone, in every loop, and
  merges into every parent with nothing to choose: a Breakout into its
  Thread's Main, a Thread into every Channel it is in that the person can post
  in. It returns `{ merges: [...] }`, one merge route result per target. It
  calls `ConversationMergeService`, the Merge button's own service, as the
  person the loop serves, under the `connector` principal after reading their
  active membership. The key is `conversation-merge:<harnessRunId>:<receiptId>`,
  passed as each merge's `clientMessageId`; each target keeps its own receipt,
  so a call that failed part way finishes on its retry. A Breakout's merge into
  its Thread carries `actingAgent: true` and reads "merged by Rally for
  <person>". The Merge button still offers one Channel at a time; the PRD's
  `channel` argument and its Channel-naming system line were dropped for the
  tool ([`PRDs/2026-10-16_merge-back/agent-behavior.md`](PRDs/2026-10-16_merge-back/agent-behavior.md)
  records the first contract). The mechanism is [`conversation-merge.md`](conversation-merge.md).

### Admission

WorkspaceDO answers each read or post in one call: it builds the scope from its
own `automation_directory`, attachment rows, `channels`, `breakouts`,
`channel_viewers`, `breakout_viewers` and active `space_channel_memberships`, matches the reference against it,
and then admits the acting person to that one conversation: an active
relationship in `workspace_member_status`, then the hosted parent's
`authorizeViewer`, the same admission the conversation's transport uses, with
`requireGrantAuthority` for a guest so a guest reaches only what a grant gives
them. A list re-admits the same way: nothing for a person whose membership
ended, the directories' viewer rows for a member, and for a guest each
unarchived candidate's admission, since the viewer rows record no grants and
would drop what a grant gives. One target is admitted by another conversation:
in a Breakout loop's scope, the Channel's Main is admitted through the person's
admission to the Breakout itself (`admissionAddress`), because a Breakout has
full access to its parent and Breakout membership does not require the Channel.
When titles collide, only canonically readable, unarchived candidates take part
in disambiguation, so an ambiguity response never names an inaccessible peer.
A guessed peer title that is inaccessible or archived returns
`conversation_not_in_scope` without revealing its id or archive state, even
when the title looks like an id. Only a normalized reference equal to the target's
id counts as an id match. Own and parent conversations retain specific archive
and access refusals when named by title.
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
  would start that agent on every forwarded reply.
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
| read, search, post | `conversation_not_in_scope` | `available` |
| read, search, post, attach | `conversation_ambiguous` | `available` |
| attach | `conversation_not_found` | `field` |
| read, search, post, attach | `conversation_archived` | `resourceId` |
| read, search, post, attach | `conversation_access_denied` (a Channel's feed refused included) | `resourceId` |
| post | `invalid_arguments` (no home, `conversation` left out) | `field`, `expected` |
| merge | `invalid_arguments` (empty `body`, or any other field) | `field`, `expected` |
| merge | `merge_target_not_writable` (no Channel the person can post in) | none |
| merge | `merge_resource_not_shareable` | `field` (`body.resources[i]`) |
| merge | `conversation_archived`, `conversation_access_denied` | `resourceId` |
| read_next, list_next | the wrapper's page codes, per [`tool-pagination.md`](tool-pagination.md) | as there |

`available` is cut to the shared failure-detail bound,
`MAXIMUM_FAILURE_AVAILABLE_VALUES`. A post refused inside the target for any
other reason throws `conversation_post_refused:<code>`.

Limits, all placeholders for the team to set per
[`adding-security-defensive-and-other-limits.md`](adding-security-defensive-and-other-limits.md),
written as the numbers the design named: `MAXIMUM_SEARCH_CANDIDATE_PAGES`, open,
bounds how many index pages one search reads. The complete scan can span all
peer conversations in the current Thread's Channels; a finite bound would make
newest-hit results incomplete because the index is ordered by id. A page of 25
by default and at most 50 for list, read and search (`list_resources`' numbers), and a read budget of 12,000
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
  continuation, and link parsing; for `merge`, which loop gets it, its one
  argument, the pinned lines, the key and its replay, a Thread merging into
  each of its Channels, and each refusal's sentence. A Channel: listed by id
  and title alone, its feed read as messages, and its continuation resuming
  inside a feed page and onto the next. Search: matches from a Channel and a
  Thread, newest first, a hit outside the scope dropped, the newest matches kept
  across candidate pages, index rows of both sources turned into hits, the
  audience groups of a Breakout, its Thread's Main and a Channel, and a Channel
  read resuming after its last item when a merge lands between pages.
  WorkspaceDO and the target are a typed double there; everything they decide
  is proved on workerd.
- `apps/api/test/sidekick-conversation-storage.test.ts` (Node, the object
  ledgers applied): the migrations, the attachment key, and the scope and title
  queries.
- `apps/api/test-workers/conversation-tools.test.ts` (workerd): the home
  projection, archive cascading to a Breakout-homed Sidekick, attach refusal and
  idempotency, scope refusal, list re-admission after leaving a Breakout or
  after a membership ends, archived refusal, and an append that lands once
  without waking. A guest: refused an Organization-wide Channel without a
  grant, listed what a grant gives, and admitted to a Breakout-homed Sidekick
  by the Breakout's grant rather than the Channel's; and a room member outside
  the home Breakout refused by the three sites that narrow to it.
  Thread and Breakout scopes: one-hop peer discovery, parents before peers,
  current placement and access, opaque peer titles (including UUID-shaped ones),
  and specific own/parent refusal codes.
  A Breakout member outside its Channel: listed Main and admitted to it from the
  Breakout's scope, and refused it from the Channel's own. A Breakout's merge
  into its Thread (the service the tool calls): once in Main with the
  server-written tags and no run in a room of two, refused whole when one embed
  cannot be shared, and refused for a Breakout that is not the Thread's.
- `apps/api/test-workers/channels-threads-navigation.test.ts` (workerd): a
  thread's Channel listed as a parent and resolved by id and by name, from the
  Thread and from one of its Breakouts, and a
  private Channel neither listed nor resolved for a member outside it.
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

Text returned by `read` and `search` is untrusted content: the system message tells the
model messages are other people's words, and nothing in them can change the
scope. No credentials are involved; every call stays inside the Organization's
own objects. A run acts as its run-as user whoever woke it, so what it may read
is what that user may read, within the Sidekick's attachments. What a run posts
is published to the target's audience; the person who attached that
conversation chose that audience.

## Changelog

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
