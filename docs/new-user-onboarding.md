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
workspace-addressed callback machinery.

Global `users` owns the introduction flag, eligibility, appearance and revision.
Appearance includes the chosen display name and avatar initials; the name also
updates `users.name`, and subsequent Google sign-in preserves the custom choice.
An account save compares the expected revision. A replay of the same saved
appearance succeeds; a stale different choice returns a conflict. The existing
identity bridge projects these fields into EU user rows, never a workspace's
content. Workspace sync invalidations refresh the account and member roster;
focus also refreshes the account. Theme accents derive from the existing semantic
palette. Settings exposes the same appearance editor.

WorkspaceDO migration 34 adds `onboarding_journeys`, keyed by regional user ID.
Migration 35 adds the persisted connector selection. Deploy the identity migration
and API before releasing the desktop client; existing accounts are exempted by
the identity migration, with no feature flag.
The journey owns setup stage and revision. Creators proceed through connectors,
personal appearance, then invitations; members finish after personal appearance.
Finishing saves `complete` before opening `/workstreams/new`. No workstream or
agent run is created by onboarding. Legacy `example` and `skipped` journeys are
completed when read; old starter columns remain for stored-data compatibility.

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
  onboarding table, and the public API cannot assign a starter workstream ID.
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
not lock out a valid regional workspace session; background refetch failures keep
cached onboarding state. OAuth is retryable or skippable and callbacks return to
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

## Changelog

### 2026-09-07 — Address review findings

Scoped connector selections now survive both pages and refreshes. Profile drafts
refresh on conflicting revisions, partial appearance updates retain name and
initials, and regional discovery avoids repeated projection invalidations.
Identity and sync outages must not lock an already authenticated regional user
out of the app. OAuth callbacks stay in onboarding. Invitation retries reconcile
server state to avoid replacing an already delivered invitation. The unused
calendar discovery surface was removed because the final flow explicitly uses
manual email chips. Bright avatar colors use dark ink for legibility.

### 2026-09-07 — Limit personal setup to color, name, and initials

Removed shape selection from the shared onboarding and Settings appearance editor.
The avatar uses the standard circle; the existing wire field remains fixed to
circle for compatibility. Color, display name, and initials remain editable.

### 2026-09-07 — Finish setup in New

The guided first-task screen, its starter endpoint and prompt claim, and the
in-stream coaching components were removed. Creators set appearance before
invitations so inviting or skipping goes directly to New. Members finish after
appearance. Completion no longer requires an agent run; old unfinished example
journeys complete on read without deleting their existing workstreams.


### 2026-09-07 — Make invitations a simple email list

The invite page now accepts typed or pasted addresses separated by whitespace,
commas, or semicolons and turns them into removable chips. It deduplicates
addresses, retains failed invitations for retry, and includes an unfinished
address when Invite is clicked. Calendar discovery controls were removed from
this page to keep the invitation step focused on explicit recipients.

### 2026-09-07 — Separate workspace and personal connector access

Connector setup now presents workspace connections first and personal connections
second. Each page filters providers, authorization actions, and connected status
by scope. Workspace copy states that all members can use the granted access;
personal copy distinguishes owner-only connection use from results posted into a
shared stream. Skipping workspace connections still opens the personal page.
Both pages remain inside the existing connectors journey stage.

### 2026-09-07 — Align workspace creation with sign-in

Workspace creation now continues the centered monochrome sign-in layout, with
matching heading size, rounded fields and region choices, and a full-width pill
action. The account identity sits below the form so the workspace is the focus.
The region choice and its permanence remain explicit; creation behavior is unchanged.

### 2026-09-07 — Match sign-in to the current application

Sign-in now uses the monochrome Rally mark, restrained centered typography,
neutral pill buttons, and the existing Google connector mark. Short copy makes
clear the same action signs in or creates an account, without detailing the
workspace routing before authentication. Browser authentication is unchanged.


### 2026-09-07 — Demonstrate a private branch from Main

The third introduction now animates the actual sequence: a completed Main reply,
Start substream, review of initial context, then a private Feedback questions
branch where Aspen asks Rally for a useful file. The middle sidebar retains Main
above the child. The result uses the shared embed card and message styling.
Nothing animates back into Main, because results are not automatically shared.
Reduced motion shows the completed private conversation immediately.


### 2026-09-07 — Show collaboration in a simplified stream

The first introduction now depicts two humans and Rally in one shared message
feed, with right-aligned solid person-colored message bubbles and names above them, left-aligned Rally replies without a message bubble,
and a short welcome-session draft. The simplified preview omits the sidebar. Each human message is followed by a
Rally reply. The resulting file uses the shared ResourceEmbedCard, with a small
local example preview when opened, instead of a separate onboarding card style.
The second introduction shows only a simplified sidebar. New workstreams appear,
and incoming human messages or Rally responses travel in from the right and
fall into their destination row. These use the same message classes as screen
one: names above blue Aspen and magenta Harper bubbles, with unbubbled Rally
replies and a monochrome mark. Only after the message lands does that stream
move to the top, connecting new activity to the changed order. Stable row
identities let transforms animate the changing activity order. Reduced motion
shows the final populated sidebar immediately.
The conversation reveals each alternating turn in sequence, followed by the embed,
using the shared motion timing. It plays once per scene visit, reserves layout
space to prevent jumps, and shows all content immediately with reduced motion. The previous
conversation/document split obscured how teammates actually work with Rally.
Messages are limited to three visible lines; keep this introduction readable
without expanding it into a full application walkthrough.


### 2026-09-07 — Integrate the requested sign-in order and personal identity

The initial implementation showed the tour after login and only offered avatar
shape and color. This integration moves the three product introductions before
sign-in and adds editable name and initials to the account-owned presentation.
Google sign-in preserves a chosen name. The imported WorkspaceDO migrations
follow the existing search migration, rather than reusing its released version.
Settings marks prefilled fields as saved so they do not block Escape; unsaved
edits still prevent accidental closing.


### 2026-09-07 — Teach privacy and collaboration through useful work

The earlier generic scenes and question-first examples delayed the payoff and
could make the chosen user avatar look like a configured bot. The replacement
shows one result evolving across private thinking and shared contribution, then
offers those same actions in the real work stream. Copy-only tour instructions
were rejected in favor of the existing review, participant and composer controls.
The original setup order is retained with direct skip paths; the proposed larger
reordering and server-synced pre-submit task drafts are not introduced here.
Future changes must preserve explicit sends and private-child boundaries.


### 2026-09-05 — Introduce account and workspace onboarding

New creators need setup guidance while invited members need a shorter path.
The flow reuses existing workspace, connector and agent authorities so onboarding
cannot become a second execution system. Server-owned identity appearance replaces
per-session choices; WorkspaceDO owns resumable progress and the starter request.
The installed Grok Bot animation implementation supplies motion parameters, while
Rally retains its own artwork and actual workstream lifecycle. Future work must
preserve these ownership and replay boundaries.
