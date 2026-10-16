# Agent behavior: `conversation_merge`

> Companion to [the merge-back PRD](prd.md). This is the tool contract that
> [`docs/prds.md`](../../prds.md#required-documentation-for-agent-tools-and-plugins)
> requires a PRD folder to hold for a new agent tool, written to
> [`agent-tools.md`](../../agent-tools.md). The tool, its scope rules and its
> refusals extend [`conversation-tools.md`](../../conversation-tools.md), which
> becomes their durable home when this ships. The names below follow the PRD's
> working name, "merge"; if the open question on the name changes it, the
> canonical name, wire name, codes and prompt lines change with it.

## 1. Plugin contract

- **Plugin.** The existing `rally:conversations`, wire prefix `conversation`. No
  new plugin. It stays `preload: true` and `explicit: true`, and loading it
  reads or writes nothing.
- **Availability.** `conversationToolAccess` is still the only place a tool set
  is decided, from the loop input, never from a model argument:

  | Loop                                                     | Tools today | Tools after           | Merges into                  |
  | -------------------------------------------------------- | ----------- | --------------------- | ---------------------------- |
  | Breakout (`parentKind: workstream`, substream not `"0"`) | list, read  | list, read, **merge** | its Thread's Main            |
  | Thread Main (`parentKind: workstream`, substream `"0"`)  | none        | **merge**             | one of the thread's Channels |
  | Sidekick configuration or run                            | unchanged   | unchanged (no merge)  | nothing                      |

  A loop under workspace authority, and any loop whose `executionPrincipal` is
  not a user, gets no `merge`: there is no person to merge as.

- **Tool order.** Breakout: `conversation_list`, `conversation_list_next`,
  `conversation_read`, `conversation_read_next`, `conversation_merge`. Thread
  Main: `conversation_merge` alone.
- **What it does not do.** It does not wake the target's agent, does not post
  anywhere but the loop's own parent, and does not change who may read the
  source.
- **System-message lines** (added to `conversationsSystemMessage`, pinned by its
  test):
  - Breakout loop: "When a person asks you to merge, merge it back, or send the
    result to the thread, call conversation_merge once with a short message for
    the thread's readers. Merge only when a person asked; never on your own
    judgement."
  - Thread Main loop: the same sentence with "the channel", followed by the
    host-derived line "This thread's Channels: <names>. Without `channel`, a
    merge goes to <default name>."

## 2. Tool catalog

| Field                  | Value                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical name         | `merge`                                                                                                                                                                                                                                                                                                                     |
| Model-visible name     | `conversation_merge`                                                                                                                                                                                                                                                                                                        |
| Description (Breakout) | "Merge this breakout's result into its thread: post a short markdown message there for the thread's readers. Embed artifacts with `[Title](resource://id)`; they become readable by the thread's readers. Call once, only when a person asked."                                                                             |
| Description (Thread)   | "Merge this thread's result into one of its Channels: post a short markdown message at the bottom of the Channel. Embed artifacts with `[Title](resource://id)`; they become readable by everyone who can open this thread. Merging again replaces the earlier merge in that Channel. Call once, only when a person asked." |
| Capability             | `rally.conversation.merge`                                                                                                                                                                                                                                                                                                  |
| Mode                   | `write`, so Bind runs it serially, never overlapped with another call                                                                                                                                                                                                                                                       |
| Idempotency            | `provider_key`: the host derives the key and the write records it                                                                                                                                                                                                                                                           |
| Timeout                | No per-tool `timeoutMs`; it runs inside the run's limits, as `conversation_post` does                                                                                                                                                                                                                                       |
| `longRunning`          | Not set                                                                                                                                                                                                                                                                                                                     |

## 3. Wire shapes

**Input**, parsed by a `.strict()` zod schema at the top of the executor, so an
undeclared key is an error, not a silent drop:

| Property  | Breakout loop | Thread Main loop | Shape                                                                                            |
| --------- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `body`    | required      | required         | string, trimmed non-empty, at most `MESSAGE_MAX_CHARACTERS` (the send path's limit)              |
| `channel` | **forbidden** | optional         | string: the exact name of one of the thread's current Channels (compared without case) or its id |

Not accepted from the model, ever: the target, `mergedFrom`, `actingAgent`, an
author, or a client message id. The host supplies each.

**Success output:**

```json
{
  "mergedInto": {
    "kind": "thread",
    "id": "<channelId>",
    "title": "Cold Outreach"
  },
  "messageId": "<uuid>",
  "replayed": false,
  "sharedResourceIds": ["<resourceId>"]
}
```

`kind` is `thread` or `channel`; for a Channel, `id` is the Space id and
`title` the Channel's name. `sharedResourceIds` lists the embedded resources
that were attached by this call, empty when none were new. `replayed: true`
means this exact call already succeeded and nothing was written again.

## 4. Discovery and sequencing

- **Resource ids** come from `resource://` links the model already has: an
  artifact it generated in this conversation, or one `conversation_read`
  returned. There is no id to look up for the target.
- **Channel names** come from the Thread Main loop's system-message line. A
  wrong name is refused with the thread's Channels in `available`.
- **Common sequences.**
  - Breakout, asked "merge B back once Samantha approves": wait for the
    approval message, then `conversation_merge { body }`.
  - Thread, asked "post the result to GTM": `conversation_merge { body,
channel: "GTM" }`.
  - Thread in one Channel, asked "share this with the channel":
    `conversation_merge { body }`.

## 5. Failure and self-healing contract

Each refusal is a typed failure with a stable `code`, the model-visible
sentence below, and only allowlisted `details`.

| `code`                         | When                                                                        | Model-visible sentence                                                                                                                                | `details`            | Model should                    |
| ------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------- |
| `invalid_arguments`            | empty `body`, an undeclared key, or `channel` in a Breakout loop            | "The merge needs a non-empty `body` and no other fields except `channel` in a thread. Fix the arguments and call once more."                          | `field`, `expected`  | correct and retry once          |
| `merge_channel_not_placed`     | `channel` names no current Channel of this thread                           | "That Channel does not hold this thread. Use one of the Channels in `available`, or leave `channel` out for the default."                             | `field`, `available` | correct and retry once          |
| `merge_thread_private`         | Thread Main loop, the thread is not Organization-wide                       | "Only an Organization-wide thread can merge into a Channel. Tell the person; do not retry."                                                           | none                 | stop and tell the person        |
| `merge_target_not_writable`    | the person the run serves cannot post in the target                         | "The person you are working for cannot post there, so the merge was not made. Tell them; do not retry."                                               | none                 | stop and tell the person        |
| `merge_resource_not_shareable` | an embedded resource fails the attach path's source check                   | "The artifact at `field` cannot be shared there, so nothing was merged or shared. Remove that embed or ask the person to share it, then merge again." | `field`              | correct and retry once, or stop |
| `conversation_archived`        | the source or the target is archived                                        | "That conversation is archived, so the merge was not made. Tell the person; do not retry."                                                            | `resourceId`         | stop and tell the person        |
| `conversation_access_denied`   | the person lost access to the source between the loop starting and the call | "You can no longer reach this conversation for the person you are working for. Tell them; do not retry."                                              | `resourceId`         | stop and tell the person        |

`field` names a path (`body`, `channel`, `body.resources[2]`), never a value or
a resource's content, through `describeZodIssues` and `codeShaped`. A failure
after the write committed is not a refusal: the next call with the same receipt
replays it (section 7). Every refusal happens before anything is attached, so a
refused call leaves nothing shared.

## 6. Authority, safety and lifecycle

- **Host-derived:** the source (the loop's own conversation), the target (its
  Thread, or the thread's default Channel unless `channel` picks another), the
  acting person (`actingUserId`), the key, `mergedFrom` and `actingAgent`.
  **Model choice:** the words, which embeds, and, in a thread, which of its
  Channels.
- **Admission** re-runs on every call through the merge route's service, the
  same one the Merge button calls: the person can read the source, the
  Breakout belongs to this Thread, the person can post in the target, and for a
  Channel the thread is Organization-wide. A Breakout member outside the Thread
  is refused, which answers the open question in `conversation-tools.md` about
  a Breakout agent posting to Main.
- **Resources:** each embedded id is checked with the attach path's own source
  check, all before any is attached; then all are attached; then the merge is
  posted. A personal-connection resource the person does not own is refused.
  No credential passes through the tool.
- **Attribution:** a Thread merge carries `actingAgent: true` and reads "merged
  by Rally for Alex". A Channel merge is authored by the person and reads
  "merged by Alex", as the PRD records.
- **Cancellation and timeout:** a cancelled run before the write writes
  nothing. A cancellation after it leaves the merge in place, and the receipt
  replays it.
- **Cleanup:** nothing to clean up on the tool's side. Attachments stay when a
  merge is replaced or removed, as the PRD's security section says.

## 7. Next-step outputs and replay

- The key is `conversation-merge:<harnessRunId>:<receiptId>`, passed as the
  merge's `clientMessageId`.
- **Into a Thread:** the append is keyed on it, so a retried receipt answers
  with the message it already wrote, `replayed: true`.
- **Into a Channel:** the key is the row's `merge_operation_id`, so a matching
  replay returns the stored row without rewriting it or taking an ordinal.
- A new call in the same run is a new key and a new merge. In a Channel it
  replaces the earlier one.
- The output returns everything a following reply needs: where the merge went
  (`mergedInto.title`) to tell the person, and `messageId` for a link. There is
  no follow-up tool.

## 8. Model-usability acceptance

- **Contract tests** (Node, `apps/api/test/conversation-tools.test.ts`, which
  covers the other tools): which loop gets `merge`; the wire name and its
  place in the order; each schema's required, optional and forbidden
  arguments, including `channel` forbidden in a Breakout loop; the pinned
  system-message lines; each refusal's code, sentence and details; the key and
  its replay; the success shape.
- **Real-runtime tests** (workerd, `apps/api/test-workers/`): a Breakout merge
  lands once in Main without waking Main's agent and carries the server-set
  tags; a Breakout member outside the Thread is refused; a refused resource
  leaves nothing attached; a Channel merge replays without moving the row or
  lighting the dot; a private thread is refused.
- **Model evaluations** on the configured medium fallback model, scripted
  transcripts:
  - asked to merge after approval: one call after the approval, not before;
  - not asked: no call, even when a draft looks finished;
  - thread in two Channels, asked for the second by name: picks it;
  - a wrong Channel name: one corrected retry from `available`, then success;
  - `merge_thread_private` or `merge_target_not_writable`: stops and tells the
    person, no retry;
  - no loop of repeated merges and no blind retry after a refusal that says
    stop.
