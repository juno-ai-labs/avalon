# Merging work back up

> Created 2026-10-16.
>
> How a Breakout hands its result to its Thread, and a Thread hands its result
> to its Channel, without copying the conversation. Companion:
> [state](state.md), [design](design.html). Related:
> [the navigation PRD](../2026-10-10_channels-threads-navigation/prd.md),
> [Spaces](../../spaces.md), [conversation tools](../../conversation-tools.md),
> [authorization](../../authorization.md),
> [markdown rendering](../../markdown-rendering.md).

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
- **Edit and delete are the ones messages already have.** Merging again is an
  edit.
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

Research on chat summaries says they are often unfaithful, so an AI-written
merge is always a draft the person edits before posting.

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
| More work after a merge                        | Edit the merge.                                                                                                                                                                                        |
| A private Breakout's result                    | Becomes visible to the Thread, which the audience line says. Embedded artifacts become readable by the Thread's readers (see [Who can open the merged artifacts](#who-can-open-the-merged-artifacts)). |
| Can't post in the target                       | You don't see Merge.                                                                                                                                                                                   |
| Everything else                                | Last write wins, removal follows message deletion rules, and every card renders with the reader's own access, as today.                                                                                |

## Architecture

### Breakout → Thread: a message

The merge is posted through the normal send path into the Thread's Main
conversation, with `structuredContent: { mergedFrom: breakoutId }`.
`MessageSchema` already has an open `structuredContent` and is not strict, so
released clients render it as a plain message. Because it is an ordinary
message, unread, mentions, the Thread's agent seeing it, later Breakouts
capturing it, edit and delete all work with no new code. The client adds the
"merged by" line and the Breakout chip's **Merged** state, read from that
field.

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
```

- **Posting.** The first route over `postMessages` (none exists yet;
  [`spaces.md`](../../spaces.md) says the first feature that needs one adds
  it). Author is the person who merged, key is `merge:<threadId>`, body is the
  markdown. It checks the person can post in the thread and the thread is
  Organization-wide.
- **Merging again** moves it back to the bottom. `postMessages` gains one option
  for a keyed draft: replace instead of skip, rewriting the body and
  `posted_at` and taking a fresh ordinal. Generic: any platform message that
  should update in place can use it.
- **Remove** deletes the message by id, a small new call.
- **Chronological for free.** A message's `posted_at` is when it was merged,
  and the feed already orders by it.

### Latency

No change to what a feed page costs. `feedPage` already runs two index seeks
and merges them in memory: placements through migration 97's index, messages
through `space_messages_feed_idx (space_id, posted_at, message_id)`, each
`LIMIT` one page plus one, then a sort of at most two pages of rows. A merge is
a message, so it adds rows to the second seek, not a third query. Both seeks run
in the WorkspaceDO's own SQLite, in process, so a page costs well under a
millisecond of SQL; the socket or HTTP round trip is what a person waits on.

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
- `channelStats`, `space_reads`, acknowledgement and the feed's
  `latestAttentionSequenceNumber` are unchanged: they already read one counter
  and do not care what advanced it.
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
embedded resource to a conversation whose readers are exactly the people who can
see the merge, and adds no new access source.

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
  Personal Channel.
- **Guests in a Channel** see a merge only if they can open its thread. The feed
  filters merge messages with the same openable-thread check it already applies
  to thread items. That keeps the rule exact: seeing the merge means you can
  open the thread, so you can open what is attached to it.
- **Order and failure.** Attach first, then post. Attaching is idempotent, so a
  retry after a failed post repeats nothing. If any attach is refused (for
  example, a personal-connection resource the merger does not own), the merge is
  refused and the code names the field that failed (`body.resources[2]`), never
  the resource's content.
- **Rendering in a Channel.** A `resource://` embed only resolves against the
  loaded conversation's resource set, and a Channel feed has none. So a merge
  message in the feed carries the metadata (title, kind, id) of each embedded
  resource the viewer may read, checked per viewer, and the renderer uses it as
  that message's resource set. A resource the viewer may not read renders as
  unavailable, as it does today.
- **Edit and remove.** Editing a merge attaches anything newly embedded.
  Removing an embed or the whole merge leaves the attachments in place, since
  people may already rely on them. Detaching is the existing separate action.

### Agent tool: `conversation_merge`

- One argument, `body` (markdown, may embed `resource://` links). No target
  argument: a Breakout loop always merges into its Thread, and a Thread's Main
  loop into its home Channel.
- Added to `rally:conversations`. `conversationToolAccess` gains `merge` on the
  Breakout arm (today `list`, `read`) and a new Thread Main arm that returns
  `merge` alone (today that loop gets no conversation tools).
- It calls the same server write as the Merge button, as the person the run
  serves (`actingUserId`), with `actingAgent: true` in the message's
  `structuredContent` for the byline. One write path, one access check.
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
| Post the merge into a Thread        | The normal message send path                                                     |
| Tag it                              | `structuredContent` on `MessageSchema`                                           |
| Show artifacts                      | `resource://` embeds in `MarkdownBody`                                           |
| Let Thread readers open them        | Attach to thread (`POST /conversations/:parentId/resources`)                     |
| Merge into a Channel                | Channel messages (`space_messages`, `postMessages`), already in the feed by time |
| Channel dot                         | The Channel waterline, generalized from placements to any Channel news           |
| Older clients                       | Client contract numbers                                                          |
| Edit, delete, unread, mentions      | Existing message behaviour                                                       |
| Agent access to other conversations | `rally:conversations` and `conversationToolAccess`                               |

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
- Statuses, update streams, citations, versions, "new since merge" markers,
  length guides.

## Open questions

- **Name.** "Merge" fits the founder's model; our users are recruiters and
  operators. "Bring back" or "Share result" are the alternatives.
