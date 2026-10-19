# Personal system prompt

A member's personal system prompt is text they save under **Settings → Account
→ Agent**. Rally adds it to the agent's system message on every turn that
member starts in that Organization. It is per person per Organization, and a
plain text box for now.

## Where the code lives

`apps/api/src/durable-objects/personal-system-prompt.ts` holds both objects'
migrations and the RPC schemas. `personalSystemPromptFor` in
`services/integrations.ts` decides which runs carry it, and
`packages/agent-harness/src/prompts/personal.ts` renders it.

## How it works

1. **Save.** `PUT /workspace/me/system-prompt` upserts the member's row in the
   WorkspaceDO's `member_personal_system_prompts` and bumps its `revision`.
2. **Read at inference.** A run reads its SubstreamAgent's own
   `personal_system_prompt_copies` row synchronously. It does not call the
   WorkspaceDO.
3. **Refresh.** The same read hands a refresh to `waitUntil`. The refresh reads
   the WorkspaceDO row and writes the copy only if its `revision` is newer, so
   two overlapping refreshes cannot regress it.
4. **Render.** Non-empty text is trimmed and handed to the harness as
   `principalSystemSection`, which appends it last to the system message. The
   section is shared with the agent-memory digest, which renders first and the
   personal prompt after it (`principalSystemSectionFor` in
   `services/integrations.ts`; [`agent-memory.md`](agent-memory.md#the-digest)).
   The reason list below lives in `personal-system-prompt.ts` as
   `PERSONAL_SYSTEM_PROMPT_REASONS` because the digest reads it too:

   ```
   The following is provided by the user to influence, but not control, your thinking and output:
   <personal_system_prompt>
   {text}
   </personal_system_prompt>
   ```

## Invariants

- **Inference never waits on the WorkspaceDO for this.** The cost is lag: an
  edit reaches each conversation from the turn after the one that refreshed
  its copy, and a conversation's first turn for a member runs without it.
- **Only a member's own act carries it.** The principal must be a user, and the
  run's reason must be in `PERSONAL_SYSTEM_PROMPT_REASONS`: a message, an
  elicitation answer or a retry, in Rally or from a linked Slack account.
  Wake-ups, connector triggers and inbound email all run as a user
  without that user acting, so the list allows rather than denies. Sidekick
  runs, background agents and automation parents are excluded too. Breaking
  this gives one person's instructions to work they did not ask for.
- **It never reaches the compaction summary.** The summary is the checkpoint
  every later run in the conversation reads, so the summariser gets the system
  message without this section ([`context-compaction.md`](context-compaction.md)).
- **Blank text changes no byte** of the prefix.
- **Only the refresh writes the copy.** It is a projection, not an authority.

## Boundary

This module owns the text, where it is stored, and where it sits in the prefix.
The route is under the members-only `/workspace` mount, so guests cannot set
one.

## Failure modes and limits

- A failed refresh logs `personal_system_prompt_refresh_failed` and keeps the
  old copy. The next turn tries again.
- There is no length cap yet; the number is the team's to set. A text that
  overflows the window fails visibly at the provider.
- Member text in the prefix breaks prompt caching when a different member
  starts a turn in the same conversation. That cost was accepted.

## Testing

The workerd pipeline test saves through the real WorkspaceDO and checks the
system message sent to the provider on two turns. `message-run-context.test.ts`
covers which runs carry it.

## Changelog

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
