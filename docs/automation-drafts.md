# Automation drafts

An automation that someone has begun setting up but has not created is a
**draft**: a real `automation_subscriptions` row, listed in the sidebar under
Automations, that never runs. It carries no schedule, holds no email address, and
is scoped to the person writing it. It stops being a draft in exactly two ways —
its author creates it, which promotes the same row to `active`, or its author
archives it, which hides it for good.

The promise this makes is that setting an automation up is visible work.
Describing one to Avalon takes several turns and can be interrupted; a
conversation that lived only in the window it was typed in was work that
disappeared the moment the window went somewhere else. Read this before changing
the automation compiler, `POST /automations`, the sidebar's automation section,
or the New automation screen.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/api/src/services/automation-service.ts` | `saveDraft` writes each compiled turn; `draftState` reads one back; `create` promotes one; `archiveDraft` hides one. `loadOwnDraft` is the single check of whether a client-supplied draft id may be written through to. |
| `apps/api/src/routes/automations.ts` | `POST /automations/draft/stream` and `POST /automations/draft` compile and persist; `GET /automations/:id/draft` returns the conversation; `POST /automations/:id/archive` hides it. |
| `packages/contracts/src/index.ts` | `AutomationDraftStateSchema` is the resumable conversation; `AutomationDraftStreamEventSchema`'s `completed` event carries the draft's id; `CreateAutomationRequestSchema.draftId` is what makes creation a promotion. |
| `apps/desktop/src/renderer/lib/api.ts` | `compileAutomation` adopts the id the API assigns; `resumeAutomationDraft` reopens one; `createAutomation` names the draft being promoted. |
| `apps/desktop/src/renderer/screens/new-automation.tsx` | The builder: resumes `?draft=<id>`, and names the draft it wrote in the URL. |
| `apps/desktop/src/renderer/components/sidebar.tsx` | Sinks drafts below the automations that run and points their rows back at the builder. |
| `packages/db/migrations/0065_automation_draft_conversation.sql` | `draft_conversation_json`, the saved transcript. |

## How it works

### A turn writes a draft

Every compile turn ends in `AutomationService.saveDraft`. The first turn inserts
a private template, its version 1, and a subscription with `status = 'draft'`;
each later turn updates those same three rows in place. The id of that
subscription is returned to the client on the stream's `completed` event, and the
client sends it back on the next turn — so the automation has one identity from
the first sentence someone types about it.

The client does not mint that id. It opens a conversation with no `draftId` at
all and adopts whatever the API answers, because an id invented in the renderer
names nothing that another surface — the sidebar, a second window, tomorrow's
session — could look up.

What the row deliberately lacks is as much of the design as what it holds:

- **No schedules.** `schedules` rows are what the workspace scheduler reads. A
  draft that carried one would be a half-written automation that fires.
- **No email address.** An address is a way to reach an automation, and there is
  nothing here to reach. Listing and reading a draft therefore never call the
  Global registry; the address is reserved when the draft is promoted, which is
  also the first moment its route could legitimately be activated.
- **No workspace scope.** The compiler's `suggestedScope` is a proposal recorded
  inside the draft, not a decision. The row stays `personal` and owned by its
  author, so an unfinished idea is never in a coworker's sidebar.

### The saved conversation

`draft_conversation_json` holds the compiler's transcript, the attachment
resources it was given, and the draft it last produced — precisely the body the
next `POST /automations/draft/stream` sends. The assistant's reply to the current
turn is appended by the service, so a resumed draft ends on the same question the
person walked away from rather than on their own last message.

`GET /automations/:id/draft` returns it. The builder renders every turn as text
except the compiler's last, which it re-renders from the draft so a choice that
was open is open again rather than being a sentence describing one.

### Promotion

`POST /automations` with a `draftId` naming a promotable draft updates that row
rather than inserting beside it: the template and version take the final draft's
content, the subscription takes the chosen scope, principal, connector bindings,
and model override, `status` becomes `active`, and `draft_conversation_json` is
cleared. Schedules, memory tables, delivery targets, and resources are inserted
in the same batch, and the email route is reserved and activated after it.

The id therefore survives, which is the point: the sidebar row someone watched
appear while they described the automation is the row that becomes the
automation. A request without a `draftId`, or with one naming anything the caller
may not write through to, inserts a new automation exactly as it always did.

## Invariants

- **A draft never runs.** Every path that starts a run — the scheduler alarm,
  activity matching, inbound email, a manual run — requires
  `status = 'active' AND lifecycle_state = 'visible'`. Adding a start path that
  checks only one of those, or that treats any non-`paused` status as runnable,
  makes a half-written automation fire against a definition its author never
  agreed to.
- **A client-supplied draft id is a claim, not an instruction.** `loadOwnDraft`
  admits only a visible draft in the caller's workspace that the caller owns.
  Both writers — `saveDraft` and `create` — go through it. A second reader that
  matches on id alone would let one request rewrite another person's automation.
- **A draft is personal until its author creates it.** `scope` is `personal` and
  `owner_user_id` is the author for the whole of a draft's life. Deriving the
  row's scope from `suggestedScope` would put unfinished drafts in every
  workspace member's sidebar.
- **Creation promotes rather than duplicates.** If `create` ever inserts a new
  subscription for a request that carried a promotable draft, the finished
  automation appears alongside the draft it came from and the draft has to be
  archived by hand.
- **A draft holds no active email route.** `list` and `get` skip address
  reconciliation for drafts. Reserving one on read would make opening the sidebar
  depend on the Global registry, and an active route on a `draft` row would mean
  mail could start a run that cannot legitimately begin.
- **The saved transcript ends with the reply on screen.** The service appends the
  assistant message it streamed. Persisting only the request's messages would
  resume every draft one turn behind what its author last read.

## Boundary

This module owns the draft's lifecycle: its row, its saved conversation, its
promotion, and its archival. It owns nothing about what the compiler decides —
the automation architect, its prompts, its tools, and the shape of an
`AutomationDraft` belong to [`AGENT_HARNESS.md`](AGENT_HARNESS.md).

It does not own an automation that runs. Once promoted, the row belongs to the
automation surfaces described in [`DATA_MODEL.md`](DATA_MODEL.md) — schedules,
runs, delivery, and the overview screen — and there is no path back to draft.

It does not own the composer's own draft text or attachment bytes, which are
cached on the device by [`composer-drafts.md`](composer-drafts.md). The two
answer different questions: that cache keeps the sentence someone was typing,
this module keeps the automation they were describing.

## Failure modes and limits

- **The compile fails.** Nothing is written. `saveDraft` runs only after the
  compiler returns a draft, so a provider error, a timeout, or invalid model
  output leaves the previous turn as the saved state and the conversation on
  screen unchanged.
- **A draft that cannot bind its activity source** is still saved, as a draft
  that is not ready with the reason as its follow-up question. That is the case
  someone most needs to come back to.
- **The database write fails.** The turn fails with it and the person retries;
  there is no path that streams a reply for a turn that was not saved, because a
  draft resumed one turn behind is worse than a turn that visibly did not land.
- **Archiving a draft that is open** navigates the builder away, since the API
  will not serve its conversation again.
- **Attachments do not come back on resumed turns.** The resource ids are
  preserved and sent on the next compile, so the compiler still sees them, but
  the transcript renders those turns without their attachment tiles — only the
  ids are persisted, not the per-message metadata.
- **No expiry.** A draft stays until its author creates or archives it. The
  transcript is bounded only by the conversation's own length, and the compile
  request carries the same messages, so a draft too large to save is a draft too
  large to compile.

## Testing

| Suite | Covers |
| --- | --- |
| `apps/api/test/automation-draft-persistence.test.ts` | The lifecycle end to end against a migrated SQLite database: a draft appearing in the list, later turns updating it in place, the conversation coming back, promotion keeping the id, and a draft id the caller may not write through to. |
| `apps/api/test/automation-lifecycle.test.ts` | Archival, and the refusal to archive an automation that runs. |
| `apps/api/test/automation-compile-source-validation.test.ts` | An unbindable activity source still saving as a draft. |
| `apps/desktop/src/renderer/screens/new-automation.test.tsx` | Resuming `?draft=`, and the screen naming the draft it wrote. |
| `apps/desktop/src/renderer/components/sidebar.test.tsx` | Draft ordering, the row's link, and the archive menu item. |

Run them with `pnpm --filter @avalon/api exec vitest run test/automation-draft-persistence.test.ts`
and `pnpm --filter @avalon/desktop exec vitest run src/renderer/screens/new-automation.test.tsx`.

Two traps in the renderer suite. `api.resumeAutomationDraft` is stubbed to
**reject** in `beforeEach`: a resolved fixture left over from another test
silently replaces the transcript under the test that follows it, which is how a
green suite hid a real defect once already. And `renderScreen` mounts a location
probe, because the screen's own URL write is otherwise invisible to a test.

## Data model

One column beyond what an automation subscription already had:

| Column | Meaning |
| --- | --- |
| `automation_subscriptions.draft_conversation_json` | The compiler transcript, attachment ids, and last draft. Written on every compile turn, `NULL` for every automation that runs. |

`status = 'draft'` and `lifecycle_state = 'visible'` together identify a live
draft; `lifecycle_state = 'archived'` is a dismissed one.
[`DATA_MODEL.md`](DATA_MODEL.md) stays authoritative for both enums.

## Security and trust model

The draft id travels through the client, which makes it attacker-controlled
input on both write paths. It is never trusted as a target: `loadOwnDraft`
resolves it against workspace, owner, status, and lifecycle, and a claim that
fails to resolve starts a new draft instead of failing loudly — a request cannot
use the difference between "not yours" and "does not exist" to enumerate other
people's automations.

The draft's contents are user-authored context and stay user-role in every
prompt, as [`AGENT_HARNESS.md`](AGENT_HARNESS.md) requires. Nothing in a saved
conversation grants authority: connector bindings are validated and frozen at
creation, not at draft time.

## Changelog

### 2026-08-11 — Automations being set up are drafts, and drafts are in the sidebar

**What changed:** The automation compiler now writes a `status = 'draft'`
subscription on its first turn and updates it on every turn after, so an
automation being set up appears in the sidebar while it is being written and
survives a restart. Creating it promotes that same row. A draft row can be
reopened in the builder from its sidebar entry.

**Why:** None of this worked before, in a way that was invisible from any single
file. `status = 'draft'` had been in the schema since `0001_initial.sql`; the
sidebar had rendered drafts, sunk them below the automations that run, and
offered **Archive draft** since drafts were given their own treatment; the
end-to-end script asked a tester to confirm all of it. But no code anywhere ever
wrote a row with that status — both `INSERT INTO automation_subscriptions`
statements hardcoded `'active'` — and the compiler's conversation lived in a
`Map` in the renderer, keyed by a `crypto.randomUUID()` the renderer minted. A
draft existed only inside the window it was typed in and was gone on reload. The
whole feature was reachable only by inserting a row by hand, which is exactly
what its tests did, so every suite passed.

**Considered and rejected:** A separate `automation_drafts` table, unioned into
the list. It duplicates the template, version, trigger, and scope columns a draft
already needs, and it forces creation to copy a draft into a subscription — which
means the finished automation gets a new id, so the sidebar row someone watched
appear is not the one they end up with, and every id already handed out for the
draft dangles. Also rejected: keeping the client's `draftId` as the subscription
primary key, which is one id collision away from a request writing into another
workspace's row.

**Consequences:** Every automation being set up now costs three rows from the
first compiled turn, including ones abandoned after a sentence — the price of a
draft being visible at all, and archiving is what clears them. Any new path that
starts a run must check `status = 'active'`, not merely that the automation is
not paused. Any new writer of a client-supplied draft id must go through
`loadOwnDraft` rather than matching on the id. And `create` now has two shapes,
promotion and insertion; a change to what a new subscription holds has to be made
in both or a promoted automation will quietly lack it.

Shipped in #TBD.
