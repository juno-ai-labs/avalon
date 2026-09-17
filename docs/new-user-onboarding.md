# New-user onboarding

Rally introduces new accounts, helps workspace creators connect their tools and
invite teammates, then guides each person through personal appearance. Invitations finish creator
setup and open the main app at New. Existing accounts are exempted when the migration runs. This
ships directly for newly created accounts, with no feature flag.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/onboarding.ts` | Account appearance and scoped journey contracts. |
| `packages/db/migrations/0099_account_onboarding.sql` | Global identity preferences and regional projections; existing-account exemption. |
| `apps/api/src/services/account-onboarding-service.ts` | Revision-checked account saves. |
| `apps/api/src/services/platform-onboarding-service.ts` | Narrow profile projection through the existing regional identity bridge. |
| `apps/api/src/durable-objects/onboarding-journey.ts` | WorkspaceDO-owned per-person setup progress. |
| `apps/api/src/services/onboarding-journey-service.ts` | Membership, eligibility and completion checks. |
| `apps/api/src/routes/onboarding.ts`, `workspace.ts` | Identity and workspace API boundaries. |
| `apps/desktop/src/renderer/lib/account-profile-editor.ts` | Account-scoped immediate drafts and serial revision-checked autosave. |
| `apps/desktop/src/renderer/screens/guided-onboarding.tsx` | Introduction, connector setup, invitations and personal setup. |
| `apps/desktop/src/renderer/components/personal-avatar.tsx`, `lib/onboarding-motion.ts`, `styles/onboarding.css` | Appearance and reference-derived motion. |

## How it works

The three introduction screens appear before sign-in. After authentication,
completion is saved on the account before workspace activation; eligible accounts
arriving through a signed-in handoff still receive the introduction.
Existing [workspace discovery and invitation acceptance](multiple-workspaces.md)
choose the regional workspace. Its creator starts at connectors; invited or
existing members start at personal setup. Optional connector and invitation
steps can be skipped. OAuth uses the existing connector authorization and
workspace-addressed callback machinery. The actions read **Connect for me** and
**Connect for workspace**, matching Settings. Ashby and Granola workspace setup
opens Settings → Connections for the API key and event configuration; their
personal connections continue through browser authorization.

WorkspaceDO migration 34 adds `onboarding_journeys`, keyed by regional user ID.
This migration includes the persisted scoped connector selection. Deploy the identity migration
and API before releasing the desktop client; existing accounts are exempted by
the identity migration, with no feature flag.
The journey owns setup stage and revision. Creators proceed through connectors,
personal appearance, then invitations; members finish after personal appearance.
Finishing saves `complete` and then leaves for the first work stream through
`useOpenFirstWorkstream` — the composer only when the workspace is empty, as a
creator's is. No workstream or
agent run is created by onboarding. The unshipped starter columns and removed first-task stages are not part of the schema.

The invite page uses manual email chips separated by spaces, commas or semicolons.
Before sending, it reconciles pending invitations and active members so retrying a
lost response does not replace an invitation already sent. Failed addresses stay
editable. Onboarding has no teammate discovery API.

## Invariants

- Appearance is identity-owned; storing it only in a renderer would make devices
  disagree and prevent other members from seeing it.
- Existing accounts have explicit eligibility false; absence of a journey never
  forces them through a new flow.
- The workspace object owns progress. Generic SQL cannot address its typed-only
  onboarding table.
- Finishing onboarding saves completion before opening New; it never creates a workstream or sends an agent prompt.
- The visible email list and invitation action authorize sending through the existing workspace service.

## Boundary

This module owns learning progress and appearance. Authentication, workspace
creation, invite tokens, OAuth, transcript execution and permissions remain with
their existing modules. Only a Global identity credential can update appearance;
regional workspace credentials can update only their own eligible journey.

## Failure modes and limits

Failed saves preserve the current screen and offer retry. Competing revisions
refresh the appearance draft before another save. A failed identity lookup does
not lock out a valid regional workspace session. A restored workspace opens
immediately, including while the first account lookup is pending. Account providers remain mounted as background details arrive, so
exempt accounts keep their workspace and socket rather than remounting them.
Account appearance editing shows a loading status until the authoritative profile
loads; a settled failure remains an error.
An identity without a workspace still waits for its introduction status and
retains the retry/sign-out flow. Eligible accounts still receive their unfinished
introduction and workspace journey when account details arrive. Workspace journey
progress also loads without replacing the app with a loading screen; only known
unfinished setup or a journey failure interrupts the workspace. While either
lookup is pending, nested conversation-admission providers keep warmed feeds
speculative and message sending disabled. Completion releases admission without
reconnecting; an unfinished result replaces the workspace without first marking
its conversations opened.
Background refetch failures keep cached onboarding state. OAuth is retryable or skippable and callbacks return to
the onboarding flow that opened them.

Connector choices retain both provider and access scope, using `workspace:` and
`you:` prefixes. Refetches do not erase unsaved choices. Unsent invitation inputs
remain in the renderer; successful connections and invitations remain on the
server. Global account saves return independently of regional discovery and sync
notifications. Subsequent identity discovery reconciles regional projections;
equal projections do not emit repeated invalidations.

## Testing

Run API Node tests `account-onboarding.test.ts`,
`platform-onboarding.test.ts`, and `workspace-do-schema.test.ts`, plus workerd
`test-workers/onboarding-journey.test.ts`. Account tests apply the actual regional
migrations; journey tests apply the actual WorkspaceDO migrations in workerd.
The write-loss and profile-update mutation checks demonstrate those integration
tests fail when persistence is broken. Desktop session-gate and app-session suites
cover existing authentication and activation behavior.

Visual verification uses the isolated local Electron window. The reference
inventory is [the PRD motion audit](PRDs/2026-09-05_new-user-onboarding/motion-reference.md).
Real external OAuth requires configured provider credentials; onboarding no longer starts an agent run.

### 2026-09-17 — Derive the selectable connector ids from the connection-card catalog

The journey's connector enum was a hand-kept copy of the ids in the
connection-card catalog. Fireflies was added to that catalog and to the picker
but never to the enum, so its tile was offered and then refused: the selection is
saved as one array, so a new account that chose Fireflies had every other choice
rejected with it and could connect nothing at all. The enum is now derived from
`ConnectorConnectionCardIds` plus the three identities that have no card — Custom
MCP, inbound webhook, and X — and the renderer catalog asserts at compile time
that every tile it draws is a selection the schema accepts. The alternative, just
adding `fireflies` to the list, leaves the next connector to break the same way.
A connector that must be offered in onboarding but not as a connection card needs
a second derived source rather than a return to a hand-kept list.

While picking, tiles now share one row height (`grid-auto-rows: 1fr`), because a
name that wraps to two lines made its entire row taller than the rows below it.
Configuring keeps intrinsic heights: those cards carry descriptions of genuinely
different lengths.

### 2026-09-09 — Keep pending onboarding from admitting conversations

Review confirmed that mounting the workspace early also mounted its feed consumer,
which could mark a conversation opened before an unfinished introduction or
journey replaced it. Account and workspace-journey gates now compose a separate
conversation-admission context around the pool. Lookups still run alongside
workspace rendering and warming, but pending setup cannot mark feeds opened or
send messages. Completion admits the same sockets. Account settings also shows
loading rather than an unavailable error while its authoritative profile is pending.

### 2026-09-09 — Open restored workspaces before account details

Returning users were stuck at Opening Rally while the Global account lookup and
its credential refresh or retries completed. An existing workspace session now
admits the workspace immediately and refreshes account details in the background.
Keeping the provider tree stable avoids reconnecting the workspace when the
lookup succeeds; profile editing waits for authoritative data to avoid saving a
placeholder profile. We removed the initial network dependency instead of adding
a timeout. Accounts without a workspace still wait for introduction status, and
known incomplete introductions and workspace journeys remain enforced. Journey
progress also loads in the background so completed eligible accounts do not flash
a second loading gate.

### 2026-09-09 — Keep workspace access stable through identity retries

The account gate now retains its authenticated-workspace fallback while a failed
identity lookup retries. React Query clears the current error during a refetch;
using that error alone switched back to Opening Rally, unmounted the workspace,
and caused its next initial socket sync to retry the account query again. The
query's recorded error timestamp preserves the fallback within its account cache
scope without disabling profile refreshes or exempting unaffiliated identities.
Future changes must preserve access through retries without bypassing the first
lookup or admitting an identity that has no workspace session.

### 2026-09-09 — Finishing lands on the first work stream

Finishing used to set the hash to `/workstreams/new`. It now leaves through
`useOpenFirstWorkstream`, which replaces the journey's entry and resolves to
the first sidebar work stream, so a member joining a workspace that already
has conversations enters one rather than an empty draft; a creator's empty
workspace still opens the composer. The rule and the reason are in
[`workstream-pinning.md`](workstream-pinning.md#leaving-for-the-first-work-stream).

### 2026-09-08 — Save profile changes immediately and move personal appearance to Account

Account settings now uses compact settings rows for name, initials and color,
with a small live avatar and no Save action. The onboarding editor keeps its
guided layout. Both use the same revision-checked account save path; the
oversized onboarding preview no longer appears in Application.

### 2026-09-07 — Remove unshipped starter storage

The first-task design was removed before release, so no production journey needs
its starter IDs, prompt or example/skipped stages. Removed those fields and
collapsed the two unshipped migrations into version 34. Keeping compatibility
for a design that never shipped would permanently enlarge the storage contract.

### 2026-09-07 — Introduce guided account and workspace onboarding with shared account appearance

New creators need setup guidance while invited members need a shorter path.
The flow reuses existing workspace, connector and agent authorities so onboarding
cannot become a second execution system. Server-owned identity appearance replaces
per-session choices; WorkspaceDO owns resumable progress and the starter request.
The installed Grok Bot animation implementation supplies motion parameters, while
Rally retains its own artwork and actual workstream lifecycle. Future work must
preserve these ownership and replay boundaries.

The initial implementation showed the tour after login and only offered avatar
shape and color. The integration moves the three product introductions before
sign-in and adds editable name and initials to the account-owned presentation.
Google sign-in preserves a chosen name. The imported WorkspaceDO migrations
follow the existing search migration, rather than reusing its released version.
Settings marks prefilled fields as saved so they do not block Escape; unsaved
edits still prevent accidental closing.

The earlier generic scenes and question-first examples delayed the payoff and
could make the chosen user avatar look like a configured bot. The replacement
shows one result evolving across private thinking and shared contribution, then
offers those same actions in the real work stream. Copy-only tour instructions
were rejected in favor of the existing review, participant and composer controls.
The original setup order is retained with direct skip paths; the proposed larger
reordering and server-synced pre-submit task drafts are not introduced here.
Future changes must preserve explicit sends and private-child boundaries.

The first introduction depicts two humans and Rally in one shared message feed,
with right-aligned solid person-colored message bubbles and names above them,
left-aligned Rally replies without a message bubble, and a short welcome-session
draft. The simplified preview omits the sidebar. Each human message is followed
by a Rally reply. The resulting file uses the shared ResourceEmbedCard, with a
small local example preview when opened, instead of a separate onboarding card
style. The conversation reveals each alternating turn in sequence, followed by
the embed, using the shared motion timing. It plays once per scene visit,
reserves layout space to prevent jumps, and shows all content immediately with
reduced motion. The previous conversation/document split obscured how teammates
actually work with Rally. Messages are limited to three visible lines; keep this
introduction readable without expanding it into a full application walkthrough.

The second introduction shows only a simplified sidebar. New workstreams appear,
and incoming human messages or Rally responses travel in from the right and
fall into their destination row. These use the same message classes as screen
one: names above blue Aspen and magenta Harper bubbles, with unbubbled Rally
replies and a monochrome mark. Only after the message lands does that stream
move to the top, connecting new activity to the changed order. Stable row
identities let transforms animate the changing activity order. Reduced motion
shows the final populated sidebar immediately.

The third introduction animates the actual sequence: a completed Main reply,
Start substream, review of initial context, then a private Feedback questions
branch where Aspen asks Rally for a useful file. The middle sidebar retains Main
above the child. The result uses the shared embed card and message styling.
Nothing animates back into Main, because results are not automatically shared.
Reduced motion shows the completed private conversation immediately.

Personal setup is limited to color, name, and initials: shape selection was
removed from the shared onboarding and Settings appearance editor. The avatar
uses the standard circle; the existing wire field remains fixed to circle for
compatibility.

Setup finishes in New. The guided first-task screen, its starter endpoint and
prompt claim, and the in-stream coaching components were removed. Creators set
appearance before invitations so inviting or skipping goes directly to New.
Members finish after appearance. Completion no longer requires an agent run; old
unfinished example journeys complete on read without deleting their existing
workstreams.

The invite page accepts typed or pasted addresses separated by whitespace,
commas, or semicolons and turns them into removable chips. It deduplicates
addresses, retains failed invitations for retry, and includes an unfinished
address when Invite is clicked. Calendar discovery controls were removed from
this page to keep the invitation step focused on explicit recipients.

Connector setup presents workspace connections first and personal connections
second. Each page filters providers, authorization actions, and connected status
by scope. Workspace copy states that all members can use the granted access;
personal copy distinguishes owner-only connection use from results posted into a
shared stream. Skipping workspace connections still opens the personal page.
Both pages remain inside the existing connectors journey stage.
