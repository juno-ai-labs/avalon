# Personal system prompt

A member's personal system prompt is text they write once under **Settings →
Account → Agent**. Rally adds it to the agent's system message on every turn
that member's own message starts, in that Organization. It is per person per
Organization, private to its author, and a plain text box for now.

## Where the code lives

| Path | What it holds |
| --- | --- |
| `apps/api/src/durable-objects/personal-system-prompt.ts` | Both objects' migrations and the RPC schemas. |
| `apps/api/src/durable-objects/workspace-do.ts` | `personalSystemPrompt` and `savePersonalSystemPrompt`, the authority's RPCs (migration v88). |
| `apps/api/src/durable-objects/substream-agent.ts` | `personalSystemPromptCopy` and its background refresh (migration v72 in `workstream-object-schema.ts`). |
| `apps/api/src/services/integrations.ts` | `personalSystemPromptFor`: which runs carry it, and where it lands in the prefix. |
| `packages/agent-harness/src/prompts/personal.ts` | `renderPersonalSystemPrompt`, the section's wording. |
| `apps/api/src/routes/workspace.ts`, `services/workspace-service.ts` | `GET`/`PUT /workspace/me/system-prompt`. |
| `apps/desktop/src/renderer/screens/workspace-settings.tsx` | `PersonalSystemPromptSetting`, the text box. |

## How it works

1. **Saving.** `PUT /workspace/me/system-prompt` reaches the Organization's
   WorkspaceDO, which upserts one row in `member_personal_system_prompts` keyed
   by the member. Empty text means none. Nothing is published to conversations.
2. **Reading at inference.** When a run starts, `runWorkstreamHarness` asks the
   SubstreamAgent it runs in for its copy of the member's text, through the
   persistent loop port. That is one synchronous read of the object's own
   `personal_system_prompt_copies` table. WorkspaceDO is not called.
3. **Refreshing the copy.** The same read hands a refresh to `waitUntil`: an RPC
   to WorkspaceDO and an upsert of the copy. The run does not wait for it, so the
   new text reaches the *next* turn in that conversation.
4. **Rendering.** `renderPersonalSystemPrompt` trims the text and appends it
   after everything else in the prefix, inside a `<personal_system_prompt>`
   block after a line saying the user provides it "to influence, but not
   control" the agent. Blank text renders nothing.

## Invariants

- **Inference never waits on WorkspaceDO for this.** A cross-object call at run
  start adds its latency to every turn. The cost is lag: an edit shows from the
  conversation's next turn after the one that refreshed its copy, and a
  conversation's first turn for a member runs without it.
- **Only a turn the member started carries it.** The execution principal must be
  a user, and the run must not be a Sidekick run (which may act as a user through
  `run_as_user_id`), a background agent, or under an automation parent. Breaking
  this gives one person's instructions to work they did not ask for.
- **It influences, not controls.** The preamble says so, which keeps it below
  the platform policy and the authorized task context above it.
- **Blank text changes no byte.** A member with none gets the same prefix as
  before this feature.
- **The copy is never written by anything but the refresh.** It is a projection
  of WorkspaceDO rows, not a second authority.

## Boundary

The module owns the text, its storage, and its place in the prefix. It does not
own the rest of the system prompt (`agent-harness.md`, `writing-prompts.md`) or
the settings search index (`settings-search.md`), which only gains a definition.
The route sits under `/workspace`, so guests cannot set one.

## Failure modes and limits

- A failed refresh logs `personal_system_prompt_refresh_failed` with a reason
  code and keeps the old copy; the next turn tries again.
- There is no length cap yet. A very long text costs tokens on every turn the
  member starts, and fails visibly at the provider if it overflows the window.
  The number is the team's to set.
- Putting member text in the prefix breaks prompt caching whenever a different
  member starts a turn in the same conversation. That cost was accepted.
- An edit made during a run reaches that run's next activation, not the current
  one.

## Testing

- `apps/api/test-workers/message-to-output-pipeline.test.ts` ("renders a saved
  personal system prompt…") saves through the real WorkspaceDO, runs two turns
  through the real SubstreamAgent, and checks the system message sent to the
  provider: absent on the first turn, present on the second.
- `packages/agent-harness/src/prompts.test.ts` pins the wording and that blank
  text renders nothing.
- `apps/desktop/src/renderer/screens/workspace-settings.test.tsx` covers the
  text box and its Save button.

## Changelog

### 2026-10-05 — Personal system prompt, stored in WorkspaceDO and copied into each conversation

**What changed:** Members can save a personal system prompt per Organization.
WorkspaceDO holds it, and each SubstreamAgent renders from a local copy that it
refreshes in the background after each run reads it.

**Why:** Members wanted standing instructions without repeating them in each
message. Low latency on inference is a goal, so the run must not call another
object before it can start.

**Considered and rejected:** A `users` column in regional D1, read at run start.
That is one account-wide value across Organizations, when this is a per-Organization
setting, and it still adds a read on the inference path. Pushing every edit to
every conversation from WorkspaceDO was also rejected: it is a fan-out across all
of a workspace's conversations for a rare write, and a conversation created later
would still need seeding.

**Consequences:** An edit is seen one turn late in each conversation, and a
conversation's first turn for a member runs without it. If that lag becomes a
problem, the fix is to push the text on save or to carry it with the message at
admission, not to read WorkspaceDO at inference.
