# New-user onboarding

Rally helps organization creators connect their tools and
invite teammates, then guides each person through personal appearance. Invitations finish creator
setup and open the main app at New. Existing accounts are exempted when the migration runs. This
ships directly for newly created accounts, with no feature flag.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/onboarding.ts` | Account appearance and scoped journey contracts; the selectable connector ids, derived. |
| `packages/contracts/src/connector-connection-card.ts` | Where those connector ids originate — the catalog the journey enum derives from. |
| `packages/db/migrations/0099_account_onboarding.sql` | Global identity preferences and regional projections; existing-account exemption. |
| `apps/api/src/services/account-onboarding-service.ts` | Revision-checked account saves. |
| `apps/api/src/services/platform-onboarding-service.ts` | Narrow profile projection through the existing regional identity bridge. |
| `apps/api/src/durable-objects/onboarding-journey.ts` | WorkspaceDO-owned per-person setup progress. |
| `apps/api/src/services/onboarding-journey-service.ts` | Membership, eligibility and completion checks. |
| `apps/api/src/routes/onboarding.ts`, `workspace.ts` | Identity and workspace API boundaries. |
| `apps/desktop/src/renderer/lib/account-profile-editor.ts` | Account-scoped immediate drafts and serial revision-checked autosave. |
| `apps/api/src/services/organization-name-suggestion.ts` | The organization name prefilled at creation, read from the email domain's homepage and cached per domain. |
| `packages/db/migrations/0123_organization_name_suggestions.sql` | The per-domain suggestion cache. |
| `apps/api/src/lib/html-metadata.ts` | Reading `<title>` and `<meta>` out of page source; shared with site social previews. |
| `apps/desktop/src/renderer/screens/create-organization.tsx` | The create-organization card, shared by the Mac app and the browser. |
| `apps/desktop/src/renderer/screens/guided-onboarding.tsx` | Recording the introduction, personal setup and invitations. |
| `apps/desktop/src/renderer/components/invite-emails.tsx` | The email-chip invite field, its validation, and sending a list as member invitations; shared with the account menu's **Add new member** dialog (`add-members-dialog.tsx`). |
| `apps/desktop/src/renderer/components/personal-avatar.tsx`, `styles/onboarding.css` | Appearance and reference-derived motion. |

## How it works

There are no introduction screens: a signed-out person goes straight to
sign-in. The account still carries an `introduced` flag, because signup
completion waits on it, so an eligible account that has not recorded it shows
"Opening Rally" while the app saves it, with a retry if the save fails.
Existing [workspace discovery and invitation acceptance](multiple-workspaces.md)
choose the regional workspace. Everyone starts at personal setup. Connecting
tools is not a journey step; it lives in Settings → Connections. The invitation
step can be skipped.

WorkspaceDO migration 34 adds `onboarding_journeys`, keyed by regional user ID.
This migration includes the persisted scoped connector selection. Deploy the identity migration
and API before releasing the desktop client; existing accounts are exempted by
the identity migration, with no feature flag.
The journey owns setup stage and revision. Creators proceed through personal
appearance, then invitations; members finish after personal appearance.
Finishing saves `complete` and then leaves for the first work stream through
`useOpenFirstWorkstream` — the composer only when the workspace is empty, as a
creator's is. No workstream or
agent run is created by onboarding. The unshipped starter columns and removed first-task stages are not part of the schema.

Joining an organization, as its creator or an invited member, makes the person
a participant of General and gives them their own Personal Channel; see
[the Personal Channel](spaces.md#the-personal-channel).

Creating an organization prefills its name. `GET /onboarding/organization-suggestion`
takes the domain of the signed-in person's email and fetches `https://<domain>/`,
following redirects by hand so every hop passes `assertSafePublicUrl`. It reads
only up to the end of `<head>` (at most `MAX_HOMEPAGE_HEAD_BYTES`) and answers
`og:site_name`, or else the `<title>` segment that matches the domain ("Acme |
Tools for builders" gives "Acme"), after dropping labels such as "Home".
Personal mail domains and RFC 2606 test names are never fetched. Every failure
answers `{ name: null }`.

Answers are cached per domain in Global D1 (`organization_name_suggestions`) for
30 days, and creating an account (Google or email sign-in) fills the cache in
the background, so the create step normally answers from one D1 read. Each read
ends in one `OrganizationNameOutcome`; every outcome but `unreachable` (a
network error, a 5xx, or a redirect loop) is cached, and the row stores which
one it was. The card opens without waiting and fills the field only while it is
empty and untouched, so the suggestion never replaces what the person typed or
a remembered name.

The invite page uses manual email chips separated by spaces, commas or semicolons.
Invite stays enabled: invalid chips are highlighted, and clicking Invite checks
every address for `something@something` before sending any invitations.
Before sending, it reconciles pending invitations and active members so retrying a
lost response does not replace an invitation already sent. Failed addresses stay
editable. Onboarding has no teammate discovery API.

The same field, check and send back **Add new member** in the account menu,
which an administrator can open at any time. It closes once every address is
invited and otherwise stays open holding the addresses that failed.

## Invariants

- Appearance is identity-owned; storing it only in a renderer would make devices
  disagree and prevent other members from seeing it.
- Existing accounts have explicit eligibility false; absence of a journey never
  forces them through a new flow. Email sign-in also starts an account
  ineligible, since most arrive as guests. Once an organization is created, the
  account becomes eligible if it is a member of no other organization here and
  holds no active binding to another deployment (a local guest relationship does
  not count), so a browser creator gets the creator journey a new Mac account
  gets. A failed create changes nothing. Eligibility is set beside the
  binding's activation once the region has committed, and a retry of the same
  create sets it again, so a write that failed the first time is repaired.
- The workspace object owns progress. Generic SQL cannot address its typed-only
  onboarding table.
- Finishing onboarding saves completion before opening New; it never creates a workstream or sends an agent prompt.
- The visible email list and invitation action authorize sending through the existing workspace service.
- `connectors` stays in the stage enum, the table's check and the contract, and
  `connectorIds` stays on the journey, because rows written before the step was
  retired hold them. Reading a journey stored at `connectors` moves it to
  `profile`, and no transition leads back. Reads of a stored selection drop ids
  the catalog no longer has, so an old row stays readable.

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
On the Mac app, a missing account credential or a terminal account renewal
failure ends the complete local session and shows a native sign-in notice;
it cannot leave Account settings unavailable inside an otherwise signed-in app.
An identity without a workspace still waits for its introduction status and
retains the retry/sign-out flow. Eligible accounts still record their
introduction and resume their workspace journey when account details arrive. Workspace journey
progress also loads without replacing the app with a loading screen; only known
unfinished setup or a journey failure interrupts the workspace. While either
lookup is pending, nested conversation-admission providers keep warmed feeds
speculative and message sending disabled. Completion releases admission without
reconnecting; an unfinished result replaces the workspace without first marking
its conversations opened.
Background refetch failures keep cached onboarding state. Unsent invitation
inputs remain in the renderer; successful invitations remain on the server. Global account saves return independently of regional discovery and sync
notifications. Subsequent identity discovery reconciles regional projections;
equal projections do not emit repeated invalidations.

## Testing

Run API Node tests `account-onboarding.test.ts`,
`platform-onboarding.test.ts`, and `workspace-do-schema.test.ts`, plus workerd
`test-workers/onboarding-journey.test.ts`, whose retired-connector and
retired-stage cases cover reading old rows. The desktop journey itself is
covered by `src/renderer/screens/guided-onboarding.test.tsx`. Account tests apply the actual regional
migrations; journey tests apply the actual WorkspaceDO migrations in workerd.
The desktop tests use the real error-notice provider to cover editing without a
popup, rejected submissions without invitation requests, repeatable notices,
invalid chips, and the intentionally relaxed client email check.
The write-loss and profile-update mutation checks demonstrate those integration
tests fail when persistence is broken. Desktop session-gate and app-session suites
cover existing authentication and activation behavior.

Visual verification uses the isolated local Electron window. The reference
inventory is [the PRD motion audit](PRDs/2026-09-05_new-user-onboarding/motion-reference.md).
Onboarding no longer starts an agent run or a connector authorization.

## Changelog

### 2026-10-24 — Share the invite field with the account menu

**What changed:** The email-chip field, its `something@something` check and
the reconcile-then-send loop moved out of `guided-onboarding.tsx` into
`components/invite-emails.tsx`. The account menu's new **Add new member**
dialog uses them, shown only to administrators since the server refuses
anyone else. The pending-invitation and member reads now run together rather
than one after the other.

**Why:** Inviting people should not need onboarding or a trip into Settings,
and a second copy of the field would drift from the first on parsing,
validation or retry behaviour.

**Considered and rejected:** Reusing the Settings invite form, which takes one
address and offers a role. The ask was the onboarding list, and invitations
from the menu are always members.

**Consequences:** A change to how addresses are parsed, checked or retried now
changes both surfaces together.

### 2026-10-23 — Let creators finish typing invitation addresses

**What changed:** Invite stays enabled, and invalid addresses open a modal only
when it is clicked, before any invitation is sent. Invalid chips have a pastel
red fill. The client checks for `something@something` without requiring a dot
in the domain. Failed invitation attempts still show their error.

**Why:** During signup, entering the first letter of an address immediately
opened a modal and interrupted typing. Draft validation used the same automatic
error notice as an operational failure.

**Considered and rejected:** Opening the popup during typing or blur interrupts
editing. Disabling Invite for invalid addresses gives no explanation when a
person tries to proceed, so validation runs when they click it instead.

**Consequences:** Use the same lightweight check for chip highlighting and for
submission, including its unfinished draft. A rejected submission preserves the
addresses and opens a fresh notice on each attempt without a network request.
The invitation API owns server validation.

PR: [#1437](https://github.com/juno-ai-labs/avalon/pull/1437).

### 2026-10-13 — Prefill the organization name from the email domain

**What changed:** The create-organization card on the Mac app and in the
browser fills its name from the homepage of the person's email domain, through
a new identity route backed by a per-domain D1 cache that account creation
fills. The `<title>` and `<meta>` readers moved out of site social previews into
`lib/html-metadata.ts` so both use one copy.

**Why:** Product asked that signup suggest the organization name rather than
start empty, read at account creation and kept for 30 days. Most work addresses
sit on a domain whose homepage already names the company.

**Considered and rejected:** Returning the suggestion with `GET /onboarding`,
which gates the screen: a slow third-party homepage would have held the whole
step. Caching per user, when the answer depends only on the domain. Falling back
to the capitalized domain label when the page names nothing; it is a one-line
addition if wanted.

**Consequences:** The fetched host is chosen by whoever signs up, so every hop
must keep passing `assertSafePublicUrl`, the head read must stay bounded by
`MAX_HOMEPAGE_HEAD_BYTES` (1 MB, chosen by the product owner from the isolate
memory arithmetic in its comment), and only a validated
workspace name may leave the route. There is no timeout: nothing waits on the
read. An `unreachable` read must never be cached, or a short outage hides a name
for a month; a new outcome has to be placed on one side of that line in both the
enum and the table's check.

Shipped in juno-ai-labs/avalon#1223.

### 2026-10-12 — Remove the introduction screens

**What changed:** The three animated introduction screens are gone. A
signed-out person lands on sign-in, and an eligible account that has not been
introduced records `introduced` on arrival behind an "Opening Rally" screen,
with a retry if the save fails. This is the path the browser already took.

**Why:** The product owner asked for the app to open straight to sign-in. The
screens put three clicks in front of sign-in and showed again to new accounts
arriving through a signed-in handoff.

**Considered and rejected:** Removing the `introduced` flag along with the
screens. Signup completion telemetry (`signup_completed`) only fires for an
eligible account once the flag is set, so dropping it needs a migration and a
telemetry change for no user benefit.

**Consequences:** `introduced` now means "has reached the app", not "has seen
the introduction". Anything that stops recording it on arrival leaves eligible
accounts never counted as completed signups and their conversations unadmitted.

Shipped in juno-ai-labs/avalon#1196.

### 2026-10-07 — Connecting tools leaves the setup journey

**What changed:** The two connector pages are gone from the journey on the Mac
and in the browser. Every journey starts at personal setup; a creator then
invites teammates. The store moves a journey it finds at `connectors` to
`profile`, and no transition leads to `connectors` any more. The connector
picker's compile-time check against the journey's connector ids, and the
`onboarding` source on a pending connector authorization, went with it. The
browser also stopped showing the introduction screens and records them as seen.

**Why:** Product asked to remove connecting tools as an onboarding step on both
apps. Connections stay in Settings → Connections.

**Considered and rejected:** Dropping `connectors` from the stage enum and
`connectorIds` from the contract. Stored journeys hold both, and the read path
parses them; removing them would make those journeys unreadable.

**Consequences:** A journey stored mid-connectors resumes at personal setup,
with one revision added, so a client holding its old revision gets a conflict
and refetches. The connector enum and stored selections remain only to read old
rows.

PR: [#1129](https://github.com/juno-ai-labs/avalon/pull/1129).

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

While picking, every tile reserves two lines for its name (`min-height: 2lh` on
the label), because a name that wraps to two lines made its entire row taller
than the rows below it. Equalizing the rows with `grid-auto-rows: 1fr` was tried
first and only holds while the grid fits: at its `max-height` the container's
height is definite, so `1fr` divides that space instead of matching the tallest
row, and the mismatch came back at exactly the length the picker actually is.
Configuring keeps intrinsic heights: those cards carry descriptions of genuinely
different lengths.

The picker's own save no longer reports a `ZodError`'s JSON to the person; it
names the field through `describeZodIssues`, per `docs/naming-a-schema-failure.md`.
Reads of a stored selection now drop ids the catalog no longer offers, so
retiring a connector cannot make an existing journey unreadable — `update` reads
before it writes, so that rejection would have cost the person the ability to see
or advance their own onboarding, not just to save a selection.

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
