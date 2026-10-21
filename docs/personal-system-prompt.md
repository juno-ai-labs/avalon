# Personal system prompt

A member's personal system prompt is text they save under **Settings → Account
→ Agent**. Rally prefixes their stored user messages with these instructions,
as though they typed them each time. The value is per person per Organization.
The displayed message keeps only the person's ordinary text.

## Where the code lives

`apps/api/src/durable-objects/personal-system-prompt.ts` holds the migrations,
RPC schemas and allowed message origins. `workstream-object-product.ts` freezes
instructions into the ordinary message text and refreshes the local copy in
the background.
`packages/agent-harness/src/prompts/personal.ts` renders the XML. The frontend
`apps/desktop/src/renderer/lib/transcript.ts` removes the block from display text
with one regular expression, for both settled and queued messages.

## How it works

1. **Save.** `PUT /workspace/me/system-prompt` upserts the member's row in the
   WorkspaceDO's `member_personal_system_prompts` and bumps its `revision`.
2. **Snapshot.** Message preparation synchronously reads this conversation's
   `personal_system_prompt_copies` row and prefixes the ordinary stored text:

   ```xml
   <user_system_prompt>
   The following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.
   <user_suppplied>
   {trimmed instructions}
   </user_suppplied>
   </user_system_prompt>

   The actual user message...
   ```

3. **Retain.** The ordinary transcript and Bind admission retain that text in history.
   Later turns replay the exact value that accompanied the earlier message.
   Editing or clearing the setting changes future messages; it never rewrites
   earlier ones. Compaction treats these instructions as user-authored history.
4. **Refresh.** The same admission read hands a refresh to `waitUntil`, without waiting for
   WorkspaceDO. It writes the copy only if the source revision is newer.

## Invariants

- **No cross-object read delays a message or inference.** An edit reaches each
  conversation after its next message admission refreshes the copy; a conversation's first
  turn for a member runs without it.
- **Only a member's own act carries it.** `PERSONAL_SYSTEM_PROMPT_REASONS`
  allows messages, elicitation answers, retries and linked Slack messages.
  Sidekick parents and background agents are excluded. A wake-up, connector
  trigger or inbound email must not acquire instructions from its principal.
- **Instructions live in user-role history, never the system prompt.** The
  XML scopes them to that speaker's requests, including when later turns or a
  compaction read them. The memory digest still uses `principalSystemSection`.
- **Only the frontend filters the block.** The server transcript contains the
  XML; frontend transcript projection removes it before display and copy.
- **Blank instructions add nothing.** Attachment parts remain intact after the
  prefix. Only the refresh writes the local copy.

## Boundary

This module owns the saved text and its placement in user messages. The route
is under the members-only `/workspace` mount, so guests cannot set one.
Bind owns model-history persistence and ordinary compaction.

## Failure modes and limits

- A failed refresh logs `personal_system_prompt_refresh_failed` and keeps the
  old copy. The next admitted message tries again.
- There is no length cap; an oversized request fails visibly at the provider.
- Each message freezes its instructions, so history repeats the text as if the
  person typed it each time.

## Testing

The real-workerd test in `message-to-output-pipeline.test.ts` saves instructions
through WorkspaceDO, verifies user-role placement, clears the setting, evicts
the conversation object, and checks that subsequent requests retain the old
message values while new messages omit the prefix. It blocks the first provider
response to prove that a queued message refreshes the copy before its run can
start. Its socket snapshot checks
that the server retains the XML. Frontend transcript tests check that settled
and queued messages display only ordinary text. Harness prompt tests cover the
XML format.

## Changelog

### 2026-10-21 — Keep personal instructions in the user's message history

**What changed:** Personal instructions prefix each stored user message in XML
instead of entering the system prompt.
Ordinary history retains that value across later turns and eviction; compaction
can read it as user history. A frontend regex removes the block for display.
Admission owns the cached read and background refresh together, including on a
new conversation's empty first read; inference does neither.

**Why:** These are the user's instructions for their requests, and should behave
as if they typed them with every message. Keeping them in the system prompt
gave them the wrong role and re-rendered current settings over past context.

**Considered and rejected:** A transient provider-request prefix excluded from
history and compaction. It loses the exact instructions later turns should read.

**Consequences:** Changing the setting affects future messages after the existing
background refresh lag. Earlier instructions remain in history, scoped by the
XML to their author's requests; clearing the setting does not erase them.

### 2026-10-05 — Personal system prompt, stored in the WorkspaceDO and copied into each conversation

**What changed:** Members can save a personal system prompt per Organization.
The WorkspaceDO holds it. Each SubstreamAgent renders from a local copy that it
refreshes in the background after each run reads it.

**Why:** Members wanted standing instructions without repeating them in each
message. Low inference latency is a goal, so a run must not wait on another
object before it starts.

**Considered and rejected:**
- A `users` column in regional D1. That is one value per account across every
  Organization, and it still adds a read to the inference path.
- Reading the WorkspaceDO at run start, overlapped with other startup work. It
  avoids the lag, but still puts a cross-object call on the run path.
- Pushing each save to every conversation. That is a fan-out for a rare write,
  and conversations created later would still need seeding.

**Consequences:** Edits show up one turn late, and a conversation's first turn
for a member runs without the prompt. If that matters, carry the text with the
message at admission or push it on save. Do not read the WorkspaceDO during
inference.

Shipped in juno-ai-labs/avalon#1097.
