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
| `apps/api/src/durable-objects/workspace-space-storage.ts` | `channelMergeTarget`, `mergeThreadIntoChannel`, `postMessage` with replace, news and operation id, `stampChannelNews`, `removeMessage`, `breakoutMergeTitles`. Migration 108 (`SPACE_MESSAGE_MERGES_MIGRATION`). |
| `apps/api/src/durable-objects/workspace-do.ts` | The RPCs: `channelMergeTarget`, `mergeThreadIntoChannel`, `removeChannelMessage`, `breakoutMergeTitles`. |
| `apps/api/src/routes/spaces.ts` | The feed's contract-7 stripping, and `DELETE /spaces/:id/messages/:messageId` (Remove). |
| `apps/api/src/services/conversation-tools.ts` | `conversation_merge`; see [`conversation-tools.md`](conversation-tools.md). |
| `apps/desktop/src/renderer/screens/conversation-surface.tsx` | `mergeTargetFor` (who can merge where), the composer's merge mode, the audience line, the Breakout card's **Merged** chip. |
| `packages/ui/src/components/merge-message.tsx` | `MergeMessage`, the one block every merge is drawn with, in a Thread and in a Channel. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | `MergeButton`, after New breakout in both hover rows, and a Thread merge drawn as `MergeMessage`. |
| `apps/desktop/src/renderer/screens/channel.tsx` | `MergeCard`, a Channel merge in the feed as `MergeMessage`, with Remove. |
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
   still replays. The composer's mentions and confirmed people travel with it,
   as with any message. With `merge` present the
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
   `through_channel`, and the thread must be Organization-wide.
2. **Embeds.** As above, attached to the **thread's** Main: a Channel has no
   conversation to attach to, and an Organization-wide thread's readers are
   every member, which covers any Channel's audience. The resources' titles and
   kinds come back for the message.
3. **Post.** `mergeThreadIntoChannel` resolves the target again inside its
   transaction and calls `postMessage` with key `merge:<threadId>`,
   `replace: true`, `sourceWorkstreamId`, `embeds` and the request's
   `clientMessageId` as `operationId`. Any operation that already wrote this
   message (`space_message_operations`) answers `replayed: true` and writes
   nothing, however late it arrives. Otherwise the row is written or
   rewritten with a fresh `posted_at`, so it moves to the bottom of the feed,
   and takes the Channel's next attention ordinal. The WorkspaceDO then
   publishes `spaceIds: [channel]`, which refetches the feed and the stats.

The feed shows a merge only to who can open its thread, through the placement
seek's own `mainOpenableSql`, and joins the thread's current title and
description for the card. The card draws its embeds from the stored titles: the
feed does no per-viewer resource lookup, and opening an artifact opens the
thread it is attached to. **Remove** deletes the row; its author or an
Organization owner or admin may.

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
- **A quote line,** in a Channel only, of the thread's first line.
- **The body,** as markdown with its embeds.
- **The host's actions** under it: the hover row in a Thread, Remove in a
  Channel.

### The waterline

A Channel's waterline is one counter for Channel news of any kind; see
[`spaces.md`](spaces.md#the-channels-read-state). A merge is news, so it lights
the dot for everyone who can see it but its author.

### Client contract 7

`ChannelMessageSchema` and the feed's message item are strict, so `merge` and a
message item's `attentionSequenceNumber` go only to builds at
`CHANNEL_MERGES_CLIENT_CONTRACT` (7) or later. An older build is served each
merge as a plain message from the person who merged.

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
Main into its Channels when it is Organization-wide, the reader is a member,
and the Channel is in their directory. "Merge to thread" or "Merge to <first
Channel>" is the second hover action on every settled text message, after
**New breakout**, and a row in the title menu that names the target at its
end (the Thread, or "Channel"). Either opens the composer's merge mode with
its own draft key (`…:merge`), prefilled with the message's words (empty from
the menu). As the design's 5c·6 draws it, merge mode is the composer itself,
in its tall form, not a bar over it:
- an audience line naming who will see it and the artifacts the draft cites
  ("The 6 people in Cold Outreach will see this and can open Sequence B");
- a green target pill among the tools, whose menu picks a thread's Channel
  and cancels;
- "Enter to merge · Esc to cancel", and a labelled **Merge** button.

These are generic `ComposerInput` slots (`notice`, `toolsAccessory`,
`submitContent`) plus `WorkstreamComposer`'s `onCancel`, so another composer
mode can use them. Merge
keeps one `clientMessageId` for the same words and target until it succeeds,
so a send whose response was lost is retried as a replay; new words or a new
target are a new merge. A merge that finishes after its composer was cancelled
and another opened leaves the newer one and its draft alone. A Channel the
reader reaches only `through_channel` is not offered. The thread's Channels
come from its directory row, which keeps placements current, not from the
conversation detail, which a socket install leaves without them. Their order
is the server's: `GET /conversations/:parentId/merge-channels` lists the
Channels this person can merge into, earliest placement first, read in the
background (`useMergeChannelOrder`). The Merge label, the title menu and the
picker therefore lead with the Channel the server would choose, as the PRD
sets the default. Until that read lands, the directory's order stands in. The merge
composer has no attach control: a merge embeds artifacts by link. Stop still
stops the run. A title-menu request opens merge mode once; returning to the
pane does not reopen it. A Channel merge card's artifact opens in its thread
with the artifact's panel open.

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
- **Whoever sees the merge can open what it embeds.** A Thread merge attaches to
  the Thread's Main; a Channel merge attaches to the Organization-wide thread,
  and the feed shows the merge only to who can open that thread. Breaking the
  second half shows a guest a card for an artifact they cannot open. Guard:
  "a merge whose thread was made private since" (workerd).
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
| `merge_thread_private` | 409 | A Channel merge from a thread that is not Organization-wide |
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

- `apps/api/test-workers/channels-threads-navigation.test.ts`, "Channel
  merges" (workerd): bottom of the feed with its thread named, news to the
  member and not the merger, replay and replace, refusals for a private thread
  and an unplaced Channel, Remove by author only, and a merge hidden once its
  thread is private.
- `apps/api/test-workers/conversation-tools.test.ts`, "a Breakout's merge into
  its Thread" (workerd): tags, no run, replay, a replay after a rename,
  atomic embeds, embeds cited by alias and by footnote, a foreign Breakout. Resources are seeded in the WorkspaceDO's own `resources` and
  `connector_connections`, which is the runtime database the attach check reads.
- `apps/api/test-workers/space-routes.test.ts`: contract 7 versus 6 on the feed.
- `apps/api/test-workers/space-message-merges-migration.test.ts`: migration 108
  over a populated 107.
- `apps/api/test/conversation-tools.test.ts` (Node): the tool.
- Renderer: `workstream-blocks.test.tsx` "MessageBlock merge-back",
  `screens/channel.test.tsx` (the merge card), `title-pill-menu.test.tsx`.

## Data model

WorkspaceDO migration 108 adds `source_workstream_id`, `attention_ordinal`,
`embeds_json` and `merge_operation_id` to `space_messages`, and
`space_message_operations`, one receipt per operation that wrote a message; see
[`spaces.md`](spaces.md#data-model). A Thread merge stores nothing new: its tags
are the message's `structured_content_json`.

## Security and trust model

A merge widens who can read an embedded artifact to the merge's audience. In a
private or Personal Channel that is wider than the merge: the artifact becomes
readable by everyone who can open the Organization-wide thread, which the
composer's audience line says before anything is attached. A personal
connection's resource can be embedded only by its owner. Removing a merge
leaves its attachments, since people may already rely on them.

## Changelog

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
