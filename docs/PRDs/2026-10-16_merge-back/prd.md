# Merging work back up

> Created 2026-10-16.
>
> How a Breakout hands its result to its Thread, and a Thread hands its result
> to its Channel, without copying the conversation. Companion:
> [state](state.md), [design](design.html),
> [agent behavior](agent-behavior.md). Related:
> [the navigation PRD](../2026-10-10_channels-threads-navigation/prd.md),
> [Spaces](../../spaces.md), [conversation tools](../../conversation-tools.md),
> [authorization](../../authorization.md),
> [markdown rendering](../../markdown-rendering.md).
>
> Earlier explorations, kept for the record and superseded by this PRD and the
> design file: [the first design document](explorations/first-draft-design-doc.html),
> [the first mockup set](explorations/first-set-mockups.html), and
> [the full 5c set](explorations/5c-full-set.html).

## Summary

- **One representation: X merged into Y.** Who merged which Breakout or Thread
  into which Thread or Channel, when, and a short piece of markdown. Nothing
  else.
- **No new table.** A Breakout merge is an ordinary message in the Thread,
  tagged `mergedFrom`. A Thread merge is a **Channel message**, the building
  block #1227 added for Rally's opening messages, posted at the time of the
  merge.
- **Channels stay chronological.** A merge appears at the bottom of the
  Channel, when it was merged, not up beside its thread. Merging again moves it
  to the bottom again.
- **Artifacts ride inside the text** as `resource://` embeds, which the
  renderer already draws as cards.
- **One merge route, and the server owns the tags.** A merge goes through its
  own route, which checks the source and the target, shares the embedded
  artifacts, and writes the `mergedFrom` tag itself. A client can never claim
  one through the ordinary send path.
- **Merging again** posts a new merge in a Thread, and replaces the earlier one
  in a Channel. Messages have no edit or delete today, and this change adds
  neither.
- **Rally can merge when asked**, through one tool that calls the same write as
  the Merge button.
- **One hop at a time:** Breakout to Thread, Thread to Channel.

## What a merge is, and what it is not

A merge moves the _resolution_ up a level. The source stays where it is, whole
and reachable. The parent gains one small item: "Sequence B · merged by Alex",
a few lines, a link back.

- **It is** a short note for the parent's readers, with the work linked. A
  squash commit message, not the history.
- **It is not** moving messages, forwarding a transcript, or reprinting a long
  answer.

The navigation PRD already promises it: "When a thread is done, its result goes
back to the channel, where the next person finds it." Today the Channel feed
shows what a thread is _about_, never what it _concluded_.

## Prior art

| Product                       | What we take                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------- |
| Slack "Also send to #channel" | Promoting a result is a per-message action, done when you choose.             |
| GitHub squash merge           | The merge carries a short, editable message; the history stays on the branch. |
| Claude Code subagents         | Only a final report comes back to the caller, written for the caller.         |

Studies of dialogue summarization find a large share of generated summaries
unfaithful to the conversation, and model judges poor at catching it (Wang et
al., EMNLP 2022, [arXiv:2210.11777](https://arxiv.org/abs/2210.11777); Tang et
al., TofuEval, NAACL 2024, [arXiv:2402.13249](https://arxiv.org/abs/2402.13249)),
so an AI-written merge is always a draft the person edits before posting.

## How it works

### Breakout → Thread

- **Merge to thread** is the first of a message's hover actions, before Copy,
  Speak, Image and PDF, and a row in the Breakout's title menu.
- It opens the composer in Merge mode, prefilled with that message's text (or
  empty from the menu). You edit and post. Phase 2 adds a **Summarize** button
  that drafts the text on click.
- One line under the composer says who will see it and open its artifacts: "The
  6 people in Cold Outreach will see this and can open Sequence B."
- In the Thread it is a normal message with a "↳ Sequence B · merged by Alex"
  line that opens the Breakout. The Breakout's chip shows **Merged**.

### Thread → Channel

- The same composer mode, from the thread's hover actions (**Merge to GTM**)
  and its title menu.
- **Which Channel.** A thread can sit in several Channels and has no stored
  home. The target defaults to the thread's earliest current placement (the
  Channel it was started in, unless it was taken out of it), and the button
  names it. A thread in more than one Channel turns the button's label into a
  menu of its Channels. One merge goes to one Channel.
- In the Channel feed the thread goes out on the right when it starts. Its
  merge comes back on the left at the bottom of the feed, when it is merged, so
  the Channel reads in time order. The merge names its thread and quotes its
  first line, and that name opens the thread.
- Only Organization-wide threads can merge into a Channel in this version. A
  private thread is made public first.

### Icon

- Breakouts use Tabler's `IconCornerDownRight` (chips, the sidebar, "Start a
  breakout from this message"). Merge uses the same path rotated 180°, which
  Tabler ships as `IconCornerUpLeft`: same set, same import, at the same sizes
  and the 1.9 stroke the breakout mark uses. Work goes down into a Breakout and
  comes back up.
- Where a merge names its source Breakout, the source keeps the unrotated
  breakout icon.

### Rally merges on request

- "Merge B into the thread once Samantha approves" or "merge this back" is a
  person's instruction. Rally writes the text and merges it, with no
  confirmation dialog, per the tool execution product policy.
- It shows as Rally's merge for that person: "↳ Sequence B · merged by Rally for
  Alex". In the Breakout, Rally's reply says where it went and links there.
- Rally merges only when someone asks. It never merges on its own judgement.

## Edge cases

| Case                                           | Handling                                                                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Last message is Q&A, not the result            | You click Merge on the message that is the result, not the last one.                                                                                                                                   |
| The result changed after small follow-up edits | Embed the artifact, which holds every edit, or edit the text, or Summarize (phase 2).                                                                                                                  |
| Several artifacts                              | Embed as many as you like; each is one link in the text.                                                                                                                                               |
| No real result                                 | Don't merge. Nothing forces one.                                                                                                                                                                       |
| More work after a merge                        | Merge again. In a Thread that posts a new merge, and the Breakout's chip and byline point to the newest. In a Channel it replaces the earlier one.                                                     |
| Merged by mistake                              | A Channel merge has **Remove**. A Thread merge cannot be removed in this version, like any message today; its artifacts can be detached with the existing action.                                      |
| Thread moved to another Channel                | The merge stays in the Channel it was posted to, as part of that Channel's history. Merging again goes to the thread's current default Channel.                                                        |
| A private Breakout's result                    | Becomes visible to the Thread, which the audience line says. Embedded artifacts become readable by the Thread's readers (see [Who can open the merged artifacts](#who-can-open-the-merged-artifacts)). |
| Can't post in the target                       | You don't see Merge.                                                                                                                                                                                   |
| Everything else                                | Last write wins, and every card renders with the reader's own access, as today.                                                                                                                        |

## Architecture

### One merge route

`POST /conversations/:parentId/merge`, body `{ body, clientMessageId,
breakoutId?, channelId? }`: with `breakoutId` it merges that Breakout into
this Thread; without it, it merges this Thread into a Channel. It is its own
route because `CreateMessageRequestSchema` carries no `structuredContent`, and
because the merge's tags must never come from a client:

- `mergedFrom` is written by the server, after it checks that `breakoutId` is a
  Breakout of this Thread and that the caller can read it. Otherwise anyone
  could post a "↳ Sequence B · merged by Alex" byline pointing anywhere.
- `actingAgent` is set only on the agent tool's path, never from a request
  body.
- The caller must be able to post in the target.
- The embedded resources are checked, then attached, then the merge is posted
  (see [Who can open the merged artifacts](#who-can-open-the-merged-artifacts)).

### Breakout → Thread: a message

The route appends to the Thread's Main conversation through the same append
the send path uses (`appendPreparedMessage`), with `structuredContent:
{ mergedFrom: breakoutId }`. `MessageSchema` already has an open
`structuredContent` and is not strict, so released clients render it as a plain
message. Because it is stored as an ordinary message, unread, mentions, the
Thread's agent seeing it and later Breakouts capturing it all work as they do
for any message. The client adds the "merged by" line and the Breakout chip's
**Merged** state, read from that field.

### Thread → Channel: a Channel message

Rally already has messages in a Channel itself, outside any thread
(`space_messages`, WorkspaceDO migration 104): an author (`rally` or a member),
a markdown body, a time, and an optional key that makes a post idempotent. The
feed already merges them with the threads by time. A merge into a Channel is
one of these, plus one column saying which thread it came from.

```sql
-- WorkspaceDO
ALTER TABLE space_messages ADD COLUMN source_workstream_id TEXT;  -- the thread a message is about
ALTER TABLE space_messages ADD COLUMN attention_ordinal INTEGER;  -- see "One Channel waterline"
ALTER TABLE space_messages ADD COLUMN embeds_json TEXT;           -- [{id, title, kind}] at merge time
ALTER TABLE space_messages ADD COLUMN merge_operation_id TEXT;    -- the clientMessageId that last wrote it
```

- **Posting.** The merge route is the first caller of `postMessages` from
  outside WorkspaceDO ([`spaces.md`](../../spaces.md) says the first feature
  that needs one adds it). Author is the person who merged, key is
  `merge:<threadId>`, body is the markdown. It checks the person can post in the
  thread and the thread is Organization-wide.
- **Merging again** moves it back to the bottom. `postMessages` gains one option
  for a keyed draft: replace instead of skip, rewriting the body and
  `posted_at` and taking a fresh ordinal. Generic: any platform message that
  should update in place can use it. Moving a row in a keyset-paged feed means
  a client paging older items can miss it or see it twice; the live socket
  update that announces the merge is what puts it in front of people, so that
  is accepted.
- **Retries.** The route's `clientMessageId` is the operation id, and the row
  stores the one that last wrote it (`merge_operation_id`). A request whose id
  matches the row's returns the stored result without rewriting the row or
  taking an ordinal, in the same transaction as the check, so a retry after a
  lost response moves nothing and lights no dot. A request with a new id is a
  new merge and wins, last write wins; a client only retries the attempt it is
  still waiting on.
- **Moves.** The message id derives from the Channel and the key, so a merge
  belongs to the Channel it was posted in. After a thread moves, the old merge
  stays where it was and a new merge goes to the thread's current default
  Channel.
- **Remove** deletes the message by id, a small new call.
- **Chronological for free.** A message's `posted_at` is when it was merged,
  and the feed already orders by it.

### Latency

Still two seeks per feed page. `feedPage` already runs two index seeks and
merges them in memory: placements through migration 97's index, messages
through `space_messages_feed_idx (space_id, posted_at, message_id)`, each
`LIMIT` one page plus one, then a sort of at most two pages of rows. A merge is
a message, so it adds rows to the second seek, not a third query.

What does change: the message seek gains the openable-thread check for rows
with a `source_workstream_id`, a primary-key join to `channels` and
`channel_viewers`, the same predicate the placement seek already runs. That is
at most one page plus one key lookups, in the WorkspaceDO's own SQLite, in
process. Embedded artifacts add no lookup at all: their title and kind are
stored with the message when it is merged (see
[Rendering in a Channel](#who-can-open-the-merged-artifacts)), and access is
enforced when a card is opened, as everywhere else. The socket or HTTP round
trip is still what a person waits on.

### One Channel waterline

Today only a placement moves a Channel's unread dot, and a Channel message "has
no sequence number and moves no read state". Merges need the dot, and so will
other platform messages, so the waterline becomes one counter for **Channel
news** of any kind, not a placement feature:

- `stampPlacements` is split. Its core becomes
  `stampChannelNews(spaceId, actorUserId)`: increment
  `spaces.latest_attention_ordinal`, return the ordinal, raise the actor's
  `space_reads` position (your own news is not news to you; Rally as author
  raises nobody). `stampPlacements` calls it per placement as now;
  `postMessages` calls it per message and writes the ordinal to
  `space_messages.attention_ordinal`.
- `channelStats` gains a second arm. Today it counts a Channel's fresh items
  from `space_channel_memberships` alone and reports `hasUnread` only when a
  visible placement is above the reader's position, so a stamped message on its
  own would not light the dot. It now also counts visible `space_messages`
  above the position (a merge message is visible when its source thread is
  openable, the same check the feed uses) and takes the first unread ordinal
  across both arms.
- `space_reads`, acknowledgement and the feed's `latestAttentionSequenceNumber`
  are unchanged: they already read the one counter and do not care what
  advanced it.
- Opening messages posted with a new Channel (`postStartingMessages`) take no
  ordinal, and existing messages stay `NULL`, reported as zero, which is how
  migration 98 treated rows that predate it. So nobody's General turns unread on
  deploy.
- Whether a future platform message counts as news is the poster's choice, one
  flag on the draft, defaulting to yes. Nothing in the waterline knows what a
  message is for, matching how `space_messages` was built.

### Released desktops

`ChannelMessageSchema` and the feed's message item are strict, so the two new
fields (`sourceThreadId`, `attentionSequenceNumber`) go out only to builds at a
new client contract, 7, the mechanism contract 6 used for message items. A
contract-6 build still gets the merge, as a plain message from the person who
merged. No query flag.

### Who can open the merged artifacts

**Rule: whoever can see a merge can open every artifact it embeds.** Today a
person can read a resource when it is attached to a conversation they can
read, and any one attachment location is enough
([`authorization.md`](../../authorization.md)). So the merge attaches each
embedded resource to a conversation that everyone who can see the merge can
read, and adds no new access source. For a Thread target that conversation's
readers are exactly the merge's audience. For a Channel target they can be
wider, as below, and the composer says so.

- **Which resources.** The route reads the `resource://` ids out of the body
  with the parser the citation code already uses. It does not take a separate
  list from the client.
- **Breakout → Thread.** Each one is attached to the Thread's Main with the
  existing Attach to thread path (`POST /conversations/:parentId/resources`).
  Main's readers can then open it: everyone in the Organization if the thread
  is Organization-wide, its participants if it is private, plus any guest added
  to it.
- **Thread → Channel.** A Channel has no conversation to attach to, so each
  resource is attached to the source thread's Main, the same call. A Channel
  merge needs an Organization-wide thread, so that thread's readers are every
  member, which covers any Channel's audience: Organization-wide, private, or a
  Personal Channel. In a private or Personal Channel this is **wider than the
  merge**: the merge is seen by the Channel's members, but its artifacts become
  readable by everyone in the Organization through the thread. Anyone in the
  Organization could already open that thread, so this only matters for an
  artifact that was not attached to it yet, such as one from a private
  Breakout. The composer's audience line names both audiences in that case
  ("Visible in Pricing. Everyone in Acme can open Price model."), and nothing
  is attached until the person merges.
- **Guests in a Channel** see a merge only if they can open its thread. The feed
  filters merge messages with the same openable-thread check it already applies
  to thread items. That keeps the rule exact: seeing the merge means you can
  open the thread, so you can open what is attached to it.
- **Order and failure.** Check every resource first, then attach them all,
  then post. The check is the attach path's own source check, run without
  writing, so a refusal (for example, a personal-connection resource the merger
  does not own) refuses the whole merge before anything is shared, and the code
  names the field that failed (`body.resources[2]`), never the resource's
  content. Attaching is idempotent, so a retry after a failed post repeats
  nothing. If the post fails for good after the attaches, the resources stay
  readable by the target's readers with no merge beside them. That is the same
  reach the merger already has with Attach to thread, to the same people, so
  it is accepted rather than rolled back.
- **Rendering in a Channel.** A `resource://` embed only resolves against the
  loaded conversation's resource set, and a Channel feed has none. So the merge
  route stores each embed's id, title and kind with the message
  (`embeds_json`), and the renderer uses that as the message's resource set.
  The feed does no per-viewer resource check: everyone who sees the merge can
  open its thread, so they can open what is attached to it, and opening a card
  checks access as it does today.
- **Removal leaves attachments.** Removing a Channel merge leaves the
  attachments it made, since people may already rely on them. Detaching is the
  existing separate action. [Security and trust model](#security-and-trust-model)
  says what that means.

### Agent tool: `conversation_merge`

The full tool contract (catalog, wire shapes, failures and recovery, replay,
and model-usability acceptance) is in [agent-behavior.md](agent-behavior.md).
This section is the summary.

- `body` (markdown, may embed `resource://` links), and for a Thread's Main
  loop an optional `channel`. A Breakout loop always merges into its Thread. A
  Thread's Main loop merges into the default Channel described under
  [Which Channel](#thread--channel), or the one `channel` names among the
  thread's current Channels; any other value is refused as
  `merge_channel_not_placed`, naming the field.
- Added to `rally:conversations`. `conversationToolAccess` gains `merge` on the
  Breakout arm (today `list`, `read`) and a new Thread Main arm that returns
  `merge` alone (today that loop gets no conversation tools).
- It calls the merge route's service, the same write as the Merge button, as
  the person the run serves (`actingUserId`). One write path, one access check.
- **Attribution.** Into a Thread, the message carries `actingAgent: true` in its
  `structuredContent`, and the byline reads "merged by Rally for Alex". A
  Channel message has no structured content, and a merge there is authored by
  the person who asked, so the Channel shows "merged by Alex". The Thread keeps
  the record that Rally did the work. Adding a column for it is listed under
  [Not now](#not-now).
- That check answers the open question in
  [`conversation-tools.md`](../../conversation-tools.md) about a Breakout agent
  posting to Main: admission re-checks that the acting person can post in the
  target, so a Breakout member outside the Thread is refused. Refusals name
  their reason (`merge_target_not_writable`, `merge_thread_private`).
- Into a Thread, the tool call id is the message's client id, so a retried call
  does not post twice. A second, separate call posts a new merge. Into a
  Channel, the post is keyed by the thread, so a second call replaces the first
  and moves it to the bottom.
- The tool description says to merge only when a person asked. The policy
  prompt's rules apply as for any write tool.

### Summarize (phase 2)

One call on click: `runStructuredInference` over `readableMessagesBefore` of
the source, returning markdown into the composer. Same model setting as the
Breakout handoff summary. Stores nothing.

### What this reuses

| Need                                | Existing piece                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Post the merge into a Thread        | `appendPreparedMessage`, the append the send path uses, behind the merge route   |
| Tag it                              | `structuredContent` on `MessageSchema`                                           |
| Show artifacts                      | `resource://` embeds in `MarkdownBody`                                           |
| Let Thread readers open them        | Attach to thread (`POST /conversations/:parentId/resources`)                     |
| Merge into a Channel                | Channel messages (`space_messages`, `postMessages`), already in the feed by time |
| Channel dot                         | The Channel waterline, generalized from placements to any Channel news           |
| Older clients                       | Client contract numbers                                                          |
| Unread, mentions, Breakout capture  | Existing message behaviour                                                       |
| Agent access to other conversations | `rally:conversations` and `conversationToolAccess`                               |

## Security and trust model

- **A merge changes who can read a resource.** Each embedded artifact becomes
  readable by everyone who can read the target: a Thread's readers for a
  Breakout merge, every member for a Channel merge, even when the Channel
  itself is private. The composer's audience line
  names who will see the merge and open its artifacts before anything is posted
  ("The 6 people in Cold Outreach will see this and can open Sequence B").
- **It is not undone by removing the merge.** The attachments stay until someone
  detaches them, so a mistaken merge from a private Breakout leaves its
  artifacts readable by the Thread, and a Channel merge leaves them readable by
  the Organization. That is the same reach the merger has today with Attach to
  thread, so the merge adds no new power, only a faster path to it.
- **The server owns every tag.** `mergedFrom` is checked against the Thread's
  own Breakouts and the caller's access to the source. `actingAgent` is set only
  by the agent tool's path. Neither is accepted from a request body.
- **Private stays private.** The Breakout itself stays private after a merge,
  and a private thread cannot merge into a Channel in this version. A guest sees
  a Channel merge only if they can open its thread.
- **Rejections name their field**, through `describeZodIssues`, and never echo a
  resource's content.

## Rollout

- Ships on merge with no feature flag, macOS and the browser together. iOS
  shows Thread merges as plain messages and gains no new UI.
- The new Channel-message fields go out only to client contract 7. A
  contract-6 build sees a Channel merge as a plain message from the person who
  merged.
- The WorkspaceDO migration adds nullable columns only. Existing messages stay
  as they are, and nobody's Channel turns unread on deploy.
- Summarize is phase 2, after the merge route and both levels ship.

## Not now

Cut until someone asks. Nothing above blocks adding any of them later.

- A separate merges table.
- Rally suggesting a merge on its own.
- A default-choice heuristic, prefetching a summary, a source picker.
- Merging a private thread into a Channel, and the exposure rules that would
  need.
- An artifact share checkbox for Channel merges; cards render with each
  reader's access.
- "Ask to merge" for people who can't post in the target.
- Merging one thread into several Channels.
- A new Activity row type.
- Marking a Channel merge as made by Rally.
- Editing a merge, or removing one from a Thread. Messages have neither today.
- Statuses, update streams, citations, versions, "new since merge" markers,
  length guides.

## Open questions

- **Name.** "Merge" fits the founder's model; our users are recruiters and
  operators. "Bring back" or "Share result" are the alternatives. Settle it
  before implementation: it names the route, the tool (`conversation_merge`),
  the tag (`mergedFrom`) and the button labels.
