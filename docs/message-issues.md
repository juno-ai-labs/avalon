# Message issues

Oopsie lets a person report a problem with a sent user or assistant message on
macOS and web. Reports live in their own D1 database in Global, the only
configured deployment, so support can join stable product identities without
adding feedback state to conversations.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/message-issues.ts` | Request target and durable receipt. |
| `apps/desktop/src/renderer/components/message-issue-dialog.tsx` | One modal per feed, issue draft, and best-effort submission. |
| `apps/desktop/src/renderer/components/workstream-blocks.tsx` | Shared Oopsie action, immediately after Merge when offered. |
| `apps/api/src/routes/message-issues.ts` | Workspace-authenticated report endpoint. |
| `apps/api/src/services/message-issue-service.ts` | Exact-conversation admission, authoritative provenance, and D1 write. |
| `packages/db/message-issue-migrations/` | Dedicated `MESSAGE_ISSUES_DB` schema. |

## How it works

The action opens **Something go wrong?** with **Let us know what you expected
so we can improve Rally.** The multiline input is `ComposerInput`, including
the same message-capsule layout as Threads and Breakouts, with only the
microphone inside the input. Attachments, model selection and the inline send
arrow are absent. The modal omits its header close button. **Send** sits beside
**Cancel** in the modal footer; it still
uses the composer’s click/hold dictation and final-transcript submission path.
Enter sends the report; Shift+Enter inserts a newline. Enter and the footer
Send both start a best-effort background request and close the modal immediately.
There is no delivery confirmation or retry prompt. Cancel, Escape, and outside click discard an
unsent draft.

`POST /message-issues` uses the authenticated Organization and reporter rather
than trusting client identity fields. Conversation reports authorize the exact
parent and Breakout through `ConversationService`, then read the canonical turn
from its `SubstreamAgent`. Channel-feed reports read one message through
WorkspaceDO's Channel reach check. Channel messages do not require access to
the Thread their merge came from, just as their feed does not.

Reports retain the canonical turn ID and the displayed block ID separately:
assistant turns and their visible blocks have different identities. Thread
reports retain the canonical Channel placement, including private-only placements.
Visible Sidekick results and opening instructions are reportable despite their
system storage actor; internal host events are excluded. Malformed Breakout
addresses disable reporting without throwing during rendering. The
Breakout ID is present for a Thread's child conversation; a Sidekick run keeps
its substream identity without being mislabeled a Breakout.

## Invariants

- The server authorizes the addressed conversation before reading provenance;
  knowing an ID cannot create a report against a private Breakout.
- Reports write only to `MESSAGE_ISSUES_DB`.
- A repeated report ID with the same reporter, Organization, target and text
  returns the original receipt. Reusing it with changed content returns 409.
  The UI sends once per report and does not retry.
- The modal lives outside virtualized rows. Opening or changing a feed does
  not remount its scrolling subtree.

## Boundary

This is explicit, user-authored feedback. It is separate from product telemetry,
crash reporting, and conversation mutations. It stores issue text and stable
provenance, not another copy of the reported message body. There is no public
report listing endpoint or automatic Slack forwarding. The shared surface is
used on macOS and web.

## Failure modes and limits

Submission is best effort. A failed request logs its API code and request ID
without issue text; the modal stays closed and the draft is discarded. The API
still awaits D1 internally
and can replay an identical report ID, but the client neither awaits delivery
nor retries it. An unavailable message or lost access refuses the report.
No additional size cap, cooldown, expiry, or retention deletion is imposed.
Closing the modal discards an unsent draft.

## Testing

Run the API workerd file `test-workers/message-issues.test.ts`, the cookie-adapter
regression in `test/browser-sessions.test.ts`, the renderer
`message-issue-dialog.test.tsx`, and the existing message-action, Channel, and
composer-dictation suites. Workerd applies the checked-in issue migration to a
real D1 binding and provisions real conversation objects. Renderer tests prove
immediate dismissal with pending or failed delivery and modal controls; visible layout must also be inspected in the
running Electron client. Live dictation needs a configured transcription
provider; the composer suite covers final transcript delivery without one.

## Data model

`message_issues` stores report ID, Organization, reporter, support impersonator
when present, session, region, canonical message, parent kind/ID, substream,
Thread, Breakout, Channel, description, normalized request, provenance JSON, and
server creation time. Provenance includes author identity/type, message time,
sequence, run and attempt IDs when present, and the visible block ID. IDs refer
to other authorities; there are no cross-database foreign keys. The compound
message index supports investigating reports against one conversation message.

## Regional impact

Global currently owns `rally-global-message-issues`. New deployments need their
own binding and migration application. Report content remains in the submitting
Organization's configured deployment. `db:migrate` includes the local schema;
the API deployment applies it before promoting the new Worker.

Engineers query this store through [Engineering MCP's `run_d1_sql`](engineering-mcp.md#d1)
using `MESSAGE_ISSUES_DB` in the Organization's region.

## Changelog

### 2026-10-22 — Explicit message issues have their own store

**What changed:** Added Oopsie reporting across the shared user and assistant
message actions, with the existing dictation composer and a dedicated D1 store.
The shared Thread/Breakout capsule keeps only its microphone; a footer Send
uses the same dictation finalization path. Sending is best effort and dismisses
the modal without waiting for storage. Browser cookie routing, visible system
turns and private Channel placements use the same reporting path; malformed
Breakout addresses do not throw during render.

**Why:** A report needs to identify the exact message and execution that went
wrong without asking the person to reconstruct Organization, Thread and
Breakout context. Reporting must not interrupt the conversation with delivery
waits, confirmations, or retry prompts. Dedicated storage keeps user-written issues independently
queryable from conversation authority and telemetry delivery.

**Considered and rejected:** Writing reports into the transcript would turn
feedback into product messages. Treating them as telemetry would tie explicit
issue delivery to analytics preferences and pipelines. A new voice input would
duplicate the composer's recording and finalization lifecycle.

**Consequences:** Future message renderers must provide canonical turn identity
as well as visible block identity, and future deployments must provision the
separate database before exposing the endpoint.

PR: [#1410](https://github.com/juno-ai-labs/avalon/pull/1410).
