# Conversation merge

Merge-back moves a result up one level: a Breakout's result into its Thread,
or a Thread's result into one of its Channels. Only the result moves, never the
conversation. There is one representation, "X merged into Y": a short markdown
message, written by a person (or by Rally for a person), that may embed
artifacts as `resource://` links. Whoever can see the merge can open every
artifact it embeds.

The design and its reasoning are in
[`PRDs/2026-10-16_merge-back/prd.md`](PRDs/2026-10-16_merge-back/prd.md). The
agent tool, `conversation_merge`, is simpler than its first contract
([`agent-behavior.md`](PRDs/2026-10-16_merge-back/agent-behavior.md)): it takes
the words alone and merges into every parent, a Breakout into its Thread and a
Thread into every Channel it is in; [`conversation-tools.md`](conversation-tools.md)
holds it.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/conversation-merge.ts` | The request, result, error codes, the Thread merge's `structuredContent` (`ConversationMergeV1`), a Channel merge's feed shape, and `mergeResourceIds`, the one parser of a body's embeds. |
| `apps/api/src/routes/conversations.ts` | `POST /conversations/:parentId/merge`, and `GET …/merge-channels` (the Channels this person can merge into, earliest placement first). |
| `apps/api/src/services/conversation-merge-service.ts` | The one admission and write order both the route and the tool use: check, attach, post. `ConversationMergeRefusal` carries the code. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | `attachResources` (all or none) and the `merge` input on `createMessageWithAuthority`, which starts no run. |
| `apps/api/src/durable-objects/workspace-space-storage.ts` | `channelMergeTarget`, `mergeThreadIntoChannel`, `postMessage` with replace, news and operation id, `stampChannelNews`, `removeMessage`, `breakoutMergeTitles`. Migration 109 (`SPACE_MESSAGE_MERGES_MIGRATION`). |
| `apps/api/src/durable-objects/workspace-do.ts` | The RPCs: `channelMergeTarget`, `mergeThreadIntoChannel`, `removeChannelMessage`, `breakoutMergeTitles`. |
| `apps/api/src/routes/spaces.ts` | The feed's contract-7 stripping, and `DELETE /spaces/:id/messages/:messageId` (Remove). |
| `apps/api/src/services/conversation-tools.ts` | `conversation_merge`; see [`conversation-tools.md`](conversation-tools.md). |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | `mergeTargetFor` (who can merge where), the one open merge draft behind the response card, `submitMerge`, the Breakout card's **Merged** chip. |
| `packages/ui/src/components/merge-response-card.tsx` | `MergeResponseCard`, the merge as the parent will draw it, editable: where every merge is made. |
| `packages/ui/src/components/merge-message.tsx` | `MergeMessage`, the one block every merge is drawn with, in a Thread and in a Channel; `MergedIntoDivider`, the source's mark of a merge. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `MergeButton`, after New breakout in both hover rows, and a Thread merge drawn as `MergeMessage`. |
| `apps/desktop/src/renderer/screens/channel.tsx` | `MergeCard`, a Channel merge in the feed as `MergeMessage`. |
| `packages/ui/src/components/conversation-menus.tsx` | The title menu's Merge row (`ConversationRowActions.merge`). |

## How it works

### Breakout into its Thread

The route, with `breakoutId`, runs in this order:

1. **Admission.** `ConversationService.authorizeViewer(threadId, breakoutId)`
   checks the Breakout is this Thread's and the person can read it, and
   `writableClient(threadId, "0")` checks they can post in Main and that it is
   not archived. Both run at once. A parent that is not a Thread (a Sidekick
   and its runs) is refused as `conversation_access_denied`.
2. **Embeds.** `mergeResourceIds(body)` reads every `resource://` target the
   renderer draws as a link: inline chips and cards, and the citation
   footnotes the body references. A link in code or behind an escaped bracket
   is literal text and is skipped. A target is a UUID or a resource's alias
   (`resource-slug.ts`); both resolve to the one row. Main's `attach_resources` op checks every one with the attach path's
   source checks (the resource exists, a guest's read grant, a personal
   connection's owner, an upload draft already sent), and only then links all
   of them in one commit. A refusal names the position (`body.resources[2]`)
   and nothing is linked.
3. **Post.** `createMergeMessage` appends to Main through the ordinary message
   admission with a server-only `merge` input: `{ type: "conversation_merge",
   mergedFrom: { breakoutId, title }, mergedByUserId, actingAgent }`. The
   title is the Breakout's, frozen at merge time, and left out of the
   admission's replay hash: a rename between a lost response and its retry
   still replays. The `@` mentions typed in the note and the people confirmed
   for a personal Thread travel with it as with any message (see "The
   client"). With `merge` present the
   admission never classifies the message and never starts a run, whatever the
   room's size; the message still queues behind input waiting for Rally.

Because it is an ordinary message, unread, mentions, the Thread's agent reading
it later and Breakouts capturing it all work as for any message. The client
draws it as a merge, not as its author's bubble (see "Every merge looks the
same" below), and marks the Breakout's card **Merged** from the merge
messages in the transcript. Merging again posts a new merge. A Thread merge
cannot be removed, like any message.

### Thread into a Channel

The route, without `breakoutId`:

1. **Admission.** `writableClient(threadId, "0")` and the WorkspaceDO's
   `channelMergeTarget` run at once. The target is `channelId` when given, which
   must be one of the thread's current, unarchived placements; otherwise the
   earliest one. The person must reach that Channel with any reach but
   `through_channel`. The thread may be private.
2. **Embeds.** As above, attached to the **thread's** Main: a Channel has no
   conversation to attach to. An Organization-wide thread's readers are every
   member, which covers any Channel's audience; a private thread's are its
   people, and the feed withholds the embeds from everyone else (below). The
   resources' titles and kinds come back for the message.
3. **Post.** `mergeThreadIntoChannel` resolves the target again inside its
   transaction and calls `postMessage` with key `merge:<threadId>`,
   `replace: true`, `sourceWorkstreamId`, `embeds` and the request's
   `clientMessageId` as `operationId`. Any operation that already wrote this
   message (`space_message_operations`) answers `replayed: true` and writes
   nothing, however late it arrives. Otherwise the row is written or
   rewritten with a fresh `posted_at`, so it moves to the bottom of the feed,
   and takes the Channel's next attention ordinal. The WorkspaceDO then
   publishes `spaceIds: [channel]`, which refetches the feed and the stats.

The feed shows a merge to every reader of the Channel, and the stats arm counts
it as news for all of them. The placement seek's own `mainOpenableSql` decides
only what comes with it: a reader who can open the thread gets its current
title and description for the card, and the embeds; one who cannot gets the
merge with `title: ""`, `summary: null`, `embeds: []` and `private: true`, and
the client draws it as from a "Private thread", with nothing to open and no
"Request access". This is how a private thread's result reaches its Channel,
and also what a reader sees of a merge whose thread was made private since. The card draws its embeds from the stored titles: the
feed does no per-viewer resource lookup, and opening an artifact opens the
thread it is attached to. `DELETE /spaces/:id/messages/:messageId` deletes
the row; its author or an Organization owner or admin may. The client offers
no control for it.

### The source's merge divider

After either merge lands, `ConversationMergeService.markSource` appends a
system row to the source (the Breakout, or the Thread's Main) through the
message port, with `structuredContent` `{ type: "conversation_merged_into",
mergedInto: { kind, id, title }, messageId, mergedByUserId, actingAgent }`
(`ConversationMergedIntoV1`) and the text "Merged into <target>". Its client
id is a hash of the target and the merge's `clientMessageId`, so a retried
merge replays the row too, and a retry after a lost marker writes it. The
client draws it as `MergedIntoDivider`, a line across the feed like a day
separator: "↰ Adam merged this into **General** · just now", or "↰ Rally
merged this into **General** for Adam" when Rally merged it through
`conversation_merge`. The line opens the merge where it landed: a Channel
merge opens the Channel with `revealChannelMessageState(messageId,
{ searchHistory: true })`, and the feed pages back until the row is loaded,
scrolls it to the middle and lights it briefly; a Breakout merge closes the
Breakout and scrolls the Thread to the merge's turn (`scrollToTurn`). It is
the same reveal the merge itself uses to show what was just posted, which
instead waits for the message to be the Channel's newest row, and the same
brief light.

A system row is UI state: it never enters the model's history and starts no
run. It does count toward the source's unread, as any new row does. A merge
Rally makes mid-run gets its row the same way, and it draws where the merge
happened: after the tool step, before Rally's reply.

The merge lands before its marker is written, so a marker that cannot be
written is logged as `conversation_merge_source_marker_failed`, naming the
source, the target and the reason. It does not fail the merge: a reader told
"failed" about a merge everyone can already see would send it again. A reader
who reaches only the Breakout, not its thread, sees the divider as a label,
since there is nowhere for them to go.

### Every merge looks the same

`MergeMessage` (`packages/ui`) draws every merge, in a Thread and in a
Channel, on the leading side. That is the side results come back on; a
person's own words go out on the trailing side. It is drawn as the design's
5c set shows:
- **A meta line:** the source's mark and name, "merged by", the merger's
  avatar and name ("Rally for Alex" when Rally merged on Alex's request), and
  the time. The source's name opens it. A Breakout's mark is the unrotated
  breakout mark on the neutral fill. A Thread's mark is its own icon on its
  own tint.
- **A quote line,** in a Channel only, of the thread's first line. It links
  to the thread's card in the same feed, scrolls to it and moves focus to it; when that card is
  on a page not yet loaded, it opens the thread instead of fetching pages
  until the card turns up.
- **The body,** as markdown with its embeds.
- **The host's actions** under it: the hover row in a Thread; none in a
  Channel.

### The waterline

A Channel's waterline is one counter for Channel news of any kind; see
[`spaces.md`](spaces.md#the-channels-read-state). A merge is news, so it lights
the dot for everyone who can see it but its author.

### Client contracts 7 and 9

`ChannelMessageSchema` and the feed's message item are strict, so `merge` and a
message item's `attentionSequenceNumber` go only to builds at
`CHANNEL_MERGES_CLIENT_CONTRACT` (7) or later. An older build is served each
merge as a plain message from the person who merged. A merge's `private` goes
only to builds at `CHANNEL_PRIVATE_MERGES_CLIENT_CONTRACT` (9) or later; an
older build is served the feed without merges from a thread its reader cannot
open, as before they were shown. The Channel's dot still counts them for that
build.

### Activity and push

Every merge somebody else made is a `merged` row in the Activity tab
([`digests.md`](digests.md#the-activity-tab)) and is pushed, emailed or sent to
Slack per the **Merges** choice ([`push-notifications.md`](push-notifications.md#activity-rows)).
A breakout's merge is read from its message's activity event, which carries
`metadata.mergedFrom` on both write paths (written at once, and queued behind
input); a thread's merge into a Channel is read from `space_messages`. Each
opens where it landed: the thread, or the Channel.

### The client

`mergeTargetFor` decides what can merge: a Breakout into its Thread; a Thread's
Main, private or not, into its Channels when the reader is a member and the
Channel is in their directory. A private thread's target says so
(`threadPrivate`): the card then draws its source as "Private thread" with no
quote line, as the Channel's other readers will see it, and the audience line
says the thread's name stays hidden and only its people can open what it
embeds. "Merge to thread" or "Merge to <first
Channel>" is the second hover action on every settled text message, after
**New breakout**, and a row in the title menu that names the target at its
end (the Thread, or "Channel"). Either opens the response card,
`MergeResponseCard`, in the feed: under the turn the hover action or a
suggestion named, or after the newest turn from the menu. It is the merge as
the parent will draw it, `MergeMessage`'s layout made editable, under a tag
line naming the parent that will see it: the source's mark and name, "merged
by" and the person, the words in a text box prefilled with the message's
words (empty from the menu), the artifacts the words cite as removable cards,
the audience line ("The 6 people in Cold Outreach will see this and can open
Sequence B"), then a footer with the green target pill (whose menu picks a
thread's Channel), "Enter to merge · Esc to cancel", **Cancel** and
**Merge**. Enter merges, Shift+Enter breaks a line, Esc puts the chip back or
closes the card. The draft persists under the existing `…:merge` key until
merged or cancelled. The composer below stays an ordinary composer: its merge
mode is gone, and its `notice`, `toolsAccessory` and `submitContent` slots
stay for other modes. The card's body is a plain text box without the
composer's mention picker; an `@` mention typed in a Breakout merge note still
resolves against the members the way a message's does (`api.mergeConversation`),
and one that names somebody not yet in a personal Thread asks first, in the
same dialog the composer shows, before the merge carries them in. Merge
keeps one `clientMessageId` for the same words and target until it succeeds,
so a send whose response was lost is retried as a replay; new words or a new
target are a new merge. A merge that finishes after its card was cancelled
and another opened leaves the newer one and its draft alone. A Channel the
reader reaches only `through_channel` is not offered. The thread's Channels
come from its directory row, which keeps placements current, not from the
conversation detail, which a socket install leaves without them. Their order
is the server's: `GET /conversations/:parentId/merge-channels` lists the
Channels this person can merge into, earliest placement first, read in the
background (`useMergeChannelOrder`). The Merge label, the title menu and the
picker therefore lead with the Channel the server would choose, as the PRD
sets the default. Until that read lands, the directory's order stands in. The
card has no attach control: a merge embeds artifacts by link. A title-menu
request opens the card once; returning to the pane does not reopen it. A
Channel merge card's artifact opens in its thread with the artifact's panel
open.

A merge that lands takes the reader to it, through `onMerged` on
`ConversationSurface`: a Breakout's merge closes the Breakout and scrolls its
Thread to the new message; a Thread's merge opens the Channel it landed in and
scrolls the feed to it once it is the newest row. Only the merge whose
card is still open moves the reader; a pane closed mid-merge moves nobody,
and a Thread scroll still waiting for its message is dropped once the reader
scrolls.

## Invariants

- **The server writes every tag.** `mergedFrom`, `actingAgent`, the author and
  the target are never read from a request body; `CreateMessageRequestSchema`
  has no `merge` field and the socket's `create_message` payload is that
  schema. Otherwise anyone could post a byline pointing at any Breakout.
  Guard: the route's request schema is strict (`ConversationMergeRequestSchema`),
  and `test-workers/conversation-tools.test.ts` reads the stored tags back.
- **A merge into a Thread starts no run.** It is a result for the Thread's
  readers, not a request to Rally. Guard: "lands once in Main … starting no run
  in a room of two" (workerd).
- **Check every embed, then attach all, then post.** A refusal shares nothing.
  Guard: "refuses the whole merge when one embed cannot be shared" (workerd).
- **Whoever is shown an embed can open it.** A Thread merge attaches to the
  Thread's Main; a Channel merge attaches to its thread's Main, and the feed
  gives the embeds, and the thread's name, only to who can open that thread.
  Breaking it names a private thread to the Channel and shows cards for
  artifacts that do not open. Guard: "given a private thread, when its
  participant merges it" and "a merge whose thread was made private since"
  (workerd).
- **One merge per thread per Channel, at the bottom.** The key is the thread, and
  a repost moves the row and takes a fresh ordinal. A retry of the same
  operation moves nothing and lights no dot. Guard: "when the same operation
  retries, then nothing moves" (workerd).
- **A merge stays in the Channel it was posted to.** The message id derives
  from the Channel and the key, so moving the thread leaves the old merge and a
  new merge goes to the current default.

## Boundary

This module owns the merge route, its service, the two object operations it
adds (`attach_resources`, the `merge` admission input), and the Channel merge
RPCs. It depends on `ConversationService` for admission, on the attach path's
source checks, and on Channel messages and the waterline in
[`spaces.md`](spaces.md). The agent tool is
[`conversation-tools.md`](conversation-tools.md)'s. It does not summarize a
conversation (phase 2 in the PRD), edit a merge, remove a Thread merge, or
detach what a merge attached: detaching is the existing separate action.

## Failure modes and limits

| Code | Status | When |
| --- | --- | --- |
| `merge_channel_not_placed` | 409 | `channelId` names no current placement of the thread; `details.available` lists the ones the person may post in |
| `merge_target_not_writable` | 403 | The person cannot post in Main, or reaches the Channel only through a thread |
| `merge_resource_not_shareable` | 403 | An embed names nothing (an unknown id or alias) or fails a source check; `details.field` is `body.resources[i]` |
| `conversation_archived` | 409 | The source or target is archived |
| `conversation_access_denied` | 404 | The person cannot read the source, or the Breakout is not this Thread's |

A post that fails after its attaches leaves the resources readable by the
target's readers with no merge beside them: the same reach Attach to thread
already gives the merger, so it is accepted rather than rolled back, and a
retry repeats nothing. Moving a row in a keyset-paged feed means a client
paging older items can miss a replaced merge or see it twice; the socket
refetch is what shows it. A Thread merge's `replayed` comes from the
admission's own insert flag. The body's limit is the send path's
`MESSAGE_MAX_CHARACTERS`; there is no limit on embeds beyond it.

## Testing

- `apps/api/test-workers/conversation-tools.test.ts`, "leaves one Merged
  marker in the Breakout" (workerd): the marker's tags, and one row however
  often the merge is retried.
- `apps/api/test-workers/channels-threads-navigation.test.ts`, "Channel
  merges" (workerd): bottom of the feed with its thread named, news to the
  member and not the merger, replay and replace, refusal for an unplaced
  Channel, a private thread's merge shown without its thread to a member who
  cannot open it, Remove by author only, and the same once a merged thread is
  made private.
- `apps/api/test-workers/conversation-tools.test.ts`, "a Breakout's merge into
  its Thread" (workerd): tags, no run, replay, a replay after a rename,
  atomic embeds, embeds cited by alias and by footnote, a foreign Breakout. Resources are seeded in the WorkspaceDO's own `resources` and
  `connector_connections`, which is the runtime database the attach check reads.
- `apps/api/test-workers/space-routes.test.ts`: contract 7 versus 6 on the
  feed, and 9 versus 8 for a private thread's merge.
- `apps/api/test-workers/space-message-merges-migration.test.ts`: migration 109
  over a populated 108.
- `apps/api/test/conversation-tools.test.ts` (Node): the tool.
- Renderer: `workstream-blocks.test.tsx` "MessageBlock merge-back",
  `screens/channel.test.tsx` (the merge card), `title-pill-menu.test.tsx`.

## Data model

WorkspaceDO migration 109 adds `source_workstream_id`, `attention_ordinal`,
`embeds_json` and `merge_operation_id` to `space_messages`, and
`space_message_operations`, one receipt per operation that wrote a message; see
[`spaces.md`](spaces.md#data-model). A Thread merge stores nothing new: its tags
are the message's `structured_content_json`.

## Security and trust model

A merge widens who can read an embedded artifact to the merge's audience. In a
private or Personal Channel that is wider than the merge: the artifact becomes
readable by everyone who can open the Organization-wide thread, which the
composer's audience line says before anything is attached. A private thread's
merge widens nothing: its embeds go only to the thread's people, and the rest
of the Channel reads the words alone. The words are the one thing a private
thread's merge shows outside it, and the merger chose them; the feed still
carries the thread's id, which names nothing. A personal
connection's resource can be embedded only by its owner. Removing a merge
leaves its attachments, since people may already rely on them.

The source's divider names its target to everyone who reads the source. A
thread merged into a private or Personal Channel therefore shows that
Channel's name, and its id in the row, to every member who can read the
thread, which `listing-rules.md` otherwise keeps from them. This is a product
choice, made in review: a source that always says where its work went is worth
more than keeping a private Channel's name hidden.

## Changelog

### 2026-10-19 — A private thread merges into its Channel

**What changed:** A private thread's Main offers Merge into its Channels, and
the server no longer refuses it (`merge_thread_private` is gone). The feed
shows every merge to every reader of the Channel; one who cannot open the
thread gets it without the thread's title, summary or embeds and flagged
`private`, drawn as from a "Private thread", with no Request access. The
turn-disposition recommender offers `merge_up` on a private thread too.
Client contract 9 carries the flag.

**Why:** The product owner's call. A private thread's result had no way into
its Channel but making the whole thread public, which shares far more than the
result. The merge-back PRD cut this as "not now"; its first-round mockups
(5c·6, 5c·12) had already drawn it this way.

**Considered and rejected:** A share checkbox for the embedded artifacts, as
5c·12 drew it: it needs a grant from a Channel to an artifact, which nothing
has. Embeds stay with the thread's people instead. Hiding the merge from
readers who cannot open the thread, as before: that is the refusal again with
extra steps. A "Request access" link on the source, which the product
removed elsewhere.

**Consequences:** A merge whose Organization-wide thread is made private later
now stays in the Channel, redacted, where it used to vanish. Activity's
`merged` rows still go only to readers who can open the thread, since a row
names it. A desktop before contract 9 does not see these merges but its dot
counts them.

### 2026-10-18 — Every merge is made in the response card, and a merge resolves a suggestion

**What changed:** The composer's merge mode is gone. `MergeResponseCard`
(`packages/ui`) is the merge as the parent will draw it, made editable: the
tag line "Merge, as {parent} will see it", the source's mark and name,
"merged by" and the person, the words in a text box, the embeds the words cite
as removable cards, the audience line, then a footer with the target pill, the
hint, Cancel and Merge. A solid card where the chip is dashed: this one is
about to exist. It opens where the merge was asked
for: under a turn from a suggestion or that turn's Merge hover action, and at
the end of the feed, above the composer, from the title menu. Enter merges,
Shift+Enter breaks a line, Esc cancels; the route, the admission and the kept
`clientMessageId` are unchanged. The `MessageMergeAction` now names the turn
beside the words. On the server, the `conversation_merged_into` marker
`markSource` appends resolves the open merge suggestions on turns at or before
it, in the marker's own commit. This records a drift from the frozen merge-back
PRD, per `prds.md`; the suggestion that drove it is owned by
[`conversation-suggestions.md`](conversation-suggestions.md).

**Why:** the product owner's call, and it holds for every merge: the composer
is for what a person is writing to the conversation, and a merge is written to
the parent. The card is the parent's own merge block made editable, so what
the person sees is what lands, which merge mode's plain text box could not
promise. Keeping merge mode for the hover action and the title menu and using
the card only for suggestions would have been two editors for one write.

### 2026-10-16 — The source shows it was merged

**What changed:** A merge leaves a system row in its source, drawn as a
divider across the feed ("Adam merged this into **General**") that opens the
merge where it landed.

**Why:** After a merge, the Breakout or Thread it came from showed nothing.
People reading the source could not tell its result had gone up, or find
it.

**Considered and rejected:** Deriving the divider on the client from the
target's merges. The source's feed never loads the Channel's feed or the
Thread's transcript, so it would mean a second read on every open. Also
rejected: a new column or table, since a system row with structured content
already exists and stays out of the model's history. For the look, six
options were drawn: a pill chip, a quiet line, a green status pill, a preview
card, this divider, and a state on the merged message itself. The divider won
because a merge closes a chapter of the source, and the feed already marks
breaks in time with a line of this shape. The state on the message would also
need the merged message's id stored.

**Consequences:** A Channel merge's message id is stable for the thread and
Channel, so an older divider opens the current merge there, which is the right
one. A Breakout's divider names the merge it made. The marker raises the source's
unread like any row. Rally's merges leave one too, marked as Rally's for the
person it served. The Channel merge itself still names only that person: a
Channel message carries no `actingAgent`.

### 2026-10-16 — The Channel merge card loses Remove

**What changed:** The Channel feed's merge card no longer shows a Remove link,
and the desktop API client drops `removeChannelMessage`. The `DELETE` route
and its authorization stay.

**Why:** A product call to take the control out of the feed; the reasoning
was not recorded.

**Considered and rejected:** Removing the route too. It is cheap to keep, and
bringing the link back needs only the client. It has no caller in the app, but
it is not dead code.

**Consequences:** No one can retract a Channel merge in the app, an owner or
admin included. Merging the thread again overwrites the `merge:<threadId>` row
rather than removing it, so the only way to take a merge down is the `DELETE`
route.

### 2026-10-16 — A merge opens where it landed

**What changed:** After a merge the client goes up one level and scrolls to
the merge message: the Thread for a Breakout's merge, the Channel for a
Thread's.

**Why:** The merge landed out of sight. The reader stayed in the Breakout or
Thread and had to go and find the result to check it.

**Considered and rejected:** Scrolling with the existing `scrollToTurn` as is.
It pages back through older messages when the turn is not loaded, and a merge
just written is usually not in the feed yet, so it would page to the start of
the Thread. `arriving` makes it wait instead. Centering the newest row with
`scrollToIndex` also landed a screen short in a long Thread, because the rows
above it were still estimates, so the newest row goes through
`scrollTranscriptToEnd`. A replayed merge wrote nothing for the socket to
deliver, so it does not wait; it pages back like any other request. In a
Channel, revealing the message as soon as it is listed was rejected: a repeat
merge keeps its message id and moves to the bottom, and the cached feed still
holds the old card where it was, so the reveal waits for it to be the newest
row.

**Consequences:** An `arriving` request stays pending until its turn lands,
the next request replaces it, or the reader takes the transcript: a wheel, a
touch, a scrollbar drag or a scrolling key drops it, so a merge queued behind
input waiting for Rally never pulls a reader who has moved on. It reads input,
not scroll events, because the virtualizer moves the viewport on its own as
rows measure.

### 2026-10-16 — Merge-back ships

**What changed:** A Breakout's result can be merged into its Thread as a tagged
message that wakes no agent, and a Thread's result into one of its Channels as
a keyed Channel message at the bottom of the feed, by the Merge button, the
title menu, or `conversation_merge`.

**Why:** Work done in a Breakout or a Thread had no way back up except copying
text by hand, which lost who did it, where it came from, and access to the
artifacts it named.

**Considered and rejected:** Multi-source pointers and an Outcome object (the
first draft); one "X merged into Y" message is enough. Storing the Channel merge
on the thread's placement row, which breaks the Channel's time order. Checking
each viewer's access to each embed in the feed, which costs a lookup per card
on the hot read path; attaching to a conversation the whole audience can read
gives the same guarantee for free.

**Consequences:** The waterline counts messages now ([`spaces.md`](spaces.md)).
A merge's `clientMessageId` is its operation id, so a client must not reuse one
across different words. Every operation that wrote a Channel merge is kept in
`space_message_operations`, so a late retry of an older one is a replay rather
than an overwrite of a newer merge; that table grows by one row per merge a
person makes. A future message about a thread must keep the
openable-thread filter in both the feed and the stats arm. What a merge shares
is what `citedResourceIds` finds, so a new citation form the renderer draws as
a link must be added there, or its artifact stays unshared. A merge is drawn
by `MergeMessage` alone, so a change to how merges look is one change, not
one per surface; a Thread merge was first drawn as its author's bubble and
read as something they typed.

Design: [`PRDs/2026-10-16_merge-back/prd.md`](PRDs/2026-10-16_merge-back/prd.md).
