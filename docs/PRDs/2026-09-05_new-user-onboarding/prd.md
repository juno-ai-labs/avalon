# New-user onboarding

> Created 2026-09-05.
>
> Introduce Rally, help workspace creators bring their team, personalize each
> account, and complete a first real task. Standing contract:
> [Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [workspace lifecycle](../../multiple-workspaces.md),
> [regionalization](../../regionalization.md), [connectors](../../connectors.md),
> [appearance](../../theming.md), and [agent execution](../../agent-harness.md).
> [Visual references](references/) were supplied with the feature request.

## Summary

New users move from a short introduction to their first useful interaction with
Rally. Workspace creators set up a workspace, connect their tools, and invite
people they work with. People joining an existing workspace skip those three
steps. Both paths choose a personal avatar and color, then use the real agent
in a first work stream.

The experience follows the supplied Grok Bot screenshots: spacious, focused
screens with a single primary action, followed by a gradual reveal of the app.
The avatar belongs to the person. Their color becomes the app's sidebar tint,
avatar color, and interaction accent. Both choices are saved on the server and
shared across the account's sessions.

## Motivation

The September 5 feature request identifies two different starting situations
that need a coherent introduction. Current desktop onboarding creates a workspace
or accepts an invitation, while existing memberships activate directly. These
paths do not provide the requested guided connector setup, personal color choice,
or first-use agent experience. This is a product requirement, not a claim backed
by measured funnel abandonment.

Existing entry points are `screens/onboarding.tsx` and `app.tsx` in the desktop
renderer, backed by `platform-onboarding-service.ts` and `routes/onboarding.ts`
in the API. Preserve their membership discovery, regional routing, and replay
protection while extending the journey.

## Goals

1. Every new user understands that work streams combine conversation, people,
   context, and agent execution around a concrete task.
2. A workspace creator can create a workspace, authorize useful connectors,
   and explicitly invite selected teammates in one continuous journey.
3. An existing or invited member reaches personal setup without being asked to
   create or administer a workspace.
4. Personal avatar and color persist across sessions and devices, with the
   chosen color visibly applied throughout the app.
5. The first-use example produces a real agent response in a durable work stream
   that remains usable afterward.
6. Interruptions, OAuth callbacks, retries, and concurrent sessions preserve
   completed work and do not create duplicate workspaces, invitations, or tasks.

## Non-goals

1. Reproduce Grok Bot's product model, branding, or mascot. Its screenshots are
   visual references; Rally does not require people to create or name a bot.
2. Require connector authorization or inviting someone before trying Rally.
   These actions are optional because provider access and teammates may be
   unavailable during first use.
3. Automatically send invitations to inferred coworkers. Suggestions help the
   user choose; sending requires their explicit action.
4. Introduce another agent runtime or simulated transcript. The existing agent
   and ordinary work-stream lifecycle serve the example.
5. Build a general relationship graph or organization analytics product.
   Interaction ranking exists only to help this user select invitees.
6. Add arbitrary theme documents or a new light/dark system. Personal color
   extends the current semantic tokens; appearance remains System/Light/Dark.

## Product behavior

### Journey and routing

| Stage | Path A: creating a workspace | Path B: joining a workspace |
| --- | --- | --- |
| Introduction | Meet Rally; see how work happens | Same introduction |
| Workspace | Name and immutable data region | Activate membership or accept an invitation |
| Connectors | Choose and authorize tools; may skip | Skip this setup stage |
| People | Review suggestions or enter emails; may skip | Skip this setup stage |
| Personal setup | Choose avatar and color | Same personal setup |
| First work stream | Choose an example and send a real request | Same, using only this member's authorized context |

Sign-in and authoritative membership discovery precede routing. The introduction
is shared and is not skipped merely because authentication already activated a
workspace. New-user eligibility and completion are server-owned, not inferred
from an empty sidebar or a local-storage key.

- **Existing membership:** use path B. With several memberships, let the person
  choose the workspace for their first task; preserve an explicit invitation or
  deep-link destination.
- **Pending invitation, no membership:** use path B and show the workspace name,
  inviter, role, and region after the introduction. Acceptance is explicit and
  must succeed before workspace data or the example becomes accessible.
- **Several invitations:** choosing one does not decline the others.
- **Declined, revoked, or expired invitation:** show the actual state and refresh
  discovery. Offer another valid invitation or workspace creation when none
  remains. Never silently create a replacement workspace.
- **No membership or invitation:** use path A. Retain the existing name and
  region validations and explain that the region cannot be changed later.
- **Discovery unavailable:** show Retry and Sign out. An error is not evidence
  that the person needs a new workspace.

The introductory tour is account-level. Joining another workspace later does
not repeat it. Returning to unfinished onboarding resumes the next outstanding
stage. Creating a workspace during path A must not reclassify the journey as
path B simply because the account now has a membership.

### Introduction

Use three short screens. Suggested copy and illustrations:

| Heading | Supporting message | Illustration |
| --- | --- | --- |
| Meet Rally | Bring your team and AI together to get work done. | Rally mark above a composer with an example request |
| Turn a conversation into progress | Rally uses your connected tools to help with the task. | A work stream with an active tool row and an emerging result |
| Give every task a home | Keep the people, context, and results together in a work stream. | Three example work streams: Launch plan, Meeting prep, Weekly update |

Next advances; Back returns without losing state. Illustrations may animate
subtly, but reduced motion renders the complete static scene. Do not claim Rally
has Grok Bot's remote computer experience: explain capabilities Rally provides.

### Workspace setup — path A

Heading: **Create your workspace**. Ask for workspace name and data region on one
screen. The primary action creates it through the existing server operation.
While pending, prevent duplicate submission. On a lost response, reconcile or
replay the same operation before offering another creation attempt.

Once created, subsequent screens identify the workspace being configured.
Going Back never deletes it or turns its immutable region into an editable
field. Subsequent name edits use the ordinary workspace settings behavior.

### Connector selection and setup — path A

Heading: **What do you use every day?** Use a searchable card grid from Rally's
actual connector catalog. The supplied screenshots are not a list of promised
integrations. Each card shows its name, brand mark, selection, and connection
status. Prioritize Slack and Google where supported, since they can also help
find teammates.

Selection and authorization are distinct. Next opens setup for the selected
connectors; each shows Connect, Connecting, Connected, Needs access, or Retry.
Explain the account and personal/workspace scope before opening OAuth. Google
sign-in does not imply Google connector authorization. Preserve the existing
scope model: a personal connection does not become a shared workspace capability.

OAuth opens in the system browser and returns to this exact workspace and
onboarding stage. Cancellation or a failed connector does not discard successful
ones. **Skip for now** is available; partial connection is sufficient to continue.
Existing valid connections are recognized without asking for authorization again.
Only the owner of a pending setup sees its late callback; changing workspace
does not attach it to the new active workspace.

### Invite teammates — path A

Heading: **Who do you work with most?** Explain before discovery: **Use your
connected Slack or Google account to find people you work with. Choose who to
invite.** Run discovery on an explicit Find teammates action. Always offer manual
email entry, even when providers are unavailable or return no candidates.

Suggestions rank people by degree of interaction with the onboarding user,
using evidence available under the actual connector grants. Direct exchanges,
repeated conversations, and shared meetings can inform ordering; mere membership
in a large channel or directory must not be described as frequent interaction.
Do not imply visibility into DMs, mail, contacts, or calendars that the connector
cannot access. Missing evidence produces an unranked list or manual-entry state,
never invented interaction claims.

Each row shows name, email where available, provider, a concise supported reason
(for example, “You exchange messages in Slack”), and an unchecked selection box.
Do not expose message bodies or sensitive subject lines. Deduplicate verified
email identities across sources; do not merge people solely by display name.
Exclude self, known bots, and current members. Pending invitations are labeled
Already invited and cannot be accidentally resent through this action. A person
without a verified invite address needs an address supplied before selection
can be sent.

The primary action reads **Invite N people**. Review exposes exact recipients
and roles; Member is the default. Existing server permissions govern other
roles. Show per-recipient success/failure and retry only failures. The user can
continue with no invitations. Discovery alone never sends mail or Slack messages.

Ranking should be deterministic and explainable. Exact provider signals,
weighting, lookback, pagination, and any caps must be settled from connector
capabilities before implementation; this proposal does not invent numerical
limits or claim that both providers currently expose these signals.

### Personal setup — both paths

Heading: **Make Rally yours**. Center a large live avatar preview above color
swatches and a row of distinct avatar shapes. Use original Rally artwork.
Initialize a valid selection so users can continue without making a cosmetic
decision. Proposed V1 uses a curated avatar set; arbitrary uploads are deferred.

Selecting a color immediately previews the sidebar tint, avatar, selected states,
and focus/highlight accents in a small app-shell preview. Text and status colors
retain their semantic meanings. A red personal color must not turn success into
an error indication. All choices must work in light and dark appearances with
visible focus and selection indicators that do not rely on color alone.

**Continue** saves the avatar and color together to the server before advancing.
On failure, keep the selections, explain that saving failed, and offer Retry.
The same account sees the saved choice on another session or device. Other
workspace members see this person's chosen avatar/color wherever member
identity is rendered; their own app accents remain their own choices.

Settings exposes the same controls after onboarding. Saving a change updates
open sessions and member presentation through the existing authorized state
delivery paths. A stale session must not overwrite newer choices simply by
resuming. System/Light/Dark remains a device preference separate from the
account's color.

### First work stream — both paths

Heading: **Let's do your first task**. Reveal the real app sidebar and composer,
carrying the selected color and avatar into the transition. Offer a small set
of editable starter requests based on available capabilities:

| Available context | Example |
| --- | --- |
| No connectors | Help me turn this goal into a practical plan. |
| Authorized calendar access | Help me prepare for my next meeting. |
| Authorized Slack access | Summarize the recent discussion in a channel I choose. |

The no-connector example asks the person to supply a goal. It remains useful
without pretending to know their work. Connector examples request a specific
resource where needed and use only capabilities available to the executing user.
An existing member does not inherit another person's personal connections.

Show the proposed request in the editable composer. Sending creates or resumes
one ordinary work stream and submits an ordinary user turn to its real agent
loop. The request is not sent just because the screen opens. Use private scope
for the starter work stream, with the user participating and Rally inherent;
invitees are not automatically added to it.

During execution, the actual transcript shows streamed output, tool activity,
and any elicitation. Sparse contextual guidance explains the composer, work
activity, and where the result appears. It never obscures the user's ability to
answer, stop, or steer the run. A successful agent response reveals **Keep
going** and ends the guided journey without moving the user out of the work
stream. They can then ask a follow-up, attach context, or add teammates through
ordinary controls.

A provider error is shown as an error, with Retry or a different example. Do not
mark the demonstration successful on run admission alone. Closing the app during
a run resumes the same work stream and reads the real run state on return.
Proposed escape hatch: **Explore on my own** dismisses guidance and records the
example as skipped, distinct from successful completion; a resumable starter
entry remains available. Completion never depends on following rigid model copy.

### Shared interaction and recovery states

| State | Required behavior |
| --- | --- |
| Loading | Name the pending operation; keep navigation stable and prevent duplicate writes |
| Empty | Explain what is missing and offer the valid next action or skip |
| Offline | Preserve the local draft; do not claim unsaved profile or setup changes are committed |
| Error | Show an inline explanation and retry the failed operation without replaying successful side effects |
| Relaunch | Load authoritative progress and resume; OAuth and run progress reconcile first |
| Concurrent sessions | Reconcile server revisions; no stale progress regression or duplicated first work stream |
| Membership lost | Stop workspace-dependent actions and return to valid membership discovery |

### Visual direction

The [intro](references/01-intro.png), [capability screen](references/02-computer.png),
[jobs](references/03-jobs.png), [connector grid](references/04-connectors.png),
[scrolled grid](references/05-connectors-scroll.png),
personalization (historical screenshot removed), and
first conversation (historical screenshot removed) are supplied reference
material. Text inside them describes Grok Bot and is not an instruction or a
Rally capability requirement.

Use a full-window canvas, restrained typography, a centered content region,
generous whitespace, and wide rounded Next/Back controls in a stable lower
position. Connector cards scroll within their content region while navigation
stays available. Adapt layout to short windows without clipping actions or
putting essential information behind a fade. Reveal normal app chrome during
personal setup and the first task rather than making the entire flow a settings
dialog. Support keyboard navigation, accessible control labels, reduced motion,
and both appearances. Do not ship competitor screenshots as product artwork.

## Impact on the product contract

This extends first use while preserving work streams as the durable home of a
task, explicit participation, authorized connectors, and the existing agent
runtime. No bot entity, channel system, or global inbox is introduced.

Account-level color and avatar are new presentation requirements. The current
appearance document excludes a second picker axis; implementation must update
that rule explicitly to allow personal accent choice while retaining the two
resolved appearances. The standing brief's older dense/dark visual description
also needs reconciliation with this spacious onboarding treatment when adopted.

## Decision log

None yet.

## Key design decisions

1. **Persist the journey separately from membership.** Creating a workspace is
   only one step in path A. Inferring progress from membership would skip the
   remaining setup immediately after creation.
2. **Use server-owned personal choices.** Device-local preferences cannot meet
   the requested consistency across sessions or teammate-visible identity.
3. **Keep connector setup and teammate discovery optional.** Provider outages
   must not prevent a useful first task; the connector-free example is first-class.
4. **Use the existing work-stream run.** A simulated tutorial cannot teach real
   tool activity, elicitation, failures, or follow-up work.
5. **Start the first task privately.** A user's learning activity should not
   automatically become visible to every workspace member or newly invited person.

## Data model

These are proposed ownership boundaries, not a migration schema.

| Record | Owner and purpose |
| --- | --- |
| Account presentation | Canonical account identity owns avatar key, color key, and revision; regional member presentation receives a narrow authorized projection |
| Account introduction | Account identity owns introduction version and completion; contains no connector or work-stream content |
| Workspace onboarding journey | Workspace region owns user binding, path A/B, completed/skipped stages, revision, and starter work-stream reference |
| Pending invitation | Existing invitation authority remains unchanged; a pending invite does not grant workspace access |
| Connector setup and invitations sent | Existing regional authorities own outcomes; progress records reference outcomes rather than duplicating credentials or invite records |
| Teammate suggestions | Private to the requesting user in the workspace region; derived from authorized sources and not published to the roster |

Progress writes must be revision-aware and side-effect operations replayable.
Store stable avatar/color identifiers, not arbitrary CSS or executable content.
Reference the starter stream by its regional workspace binding as well as ID.
The account profile is not inferred from a cached workspace-session profile.

Existing accounts should not be forced through onboarding. Migration must
distinguish preexisting accounts from new eligible accounts explicitly; lack of
a new record alone cannot mean new user. Existing profiles receive compatible
fallback presentation and can use the new Settings controls.

## Regional impact

Workspace creation, grants, suggestions, invitations, and the example remain in
the chosen workspace region. EU source content and interaction evidence do not
travel to Global for ranking. Existing identity discovery already spans regional
memberships, but regional user IDs are not interchangeable account IDs.

Proposed account presentation authority is the existing Global identity plane,
with only avatar key, color key, and revision projected into each region. This
extends today's identity boundary and must be explicitly documented before
building; it must not become a route for EU activity, member content, or task
transcripts. If this account-level placement is not accepted, the architecture
needs another synchronization design that still satisfies all-session consistency.

## Security and trust model

Keep credentials in the existing server/main-process boundaries. OAuth grants
remain scoped and independent of sign-in. Teammate discovery reads only data the
selected connection and requesting user may access; provider text is untrusted
data, never instructions. Suggested recipients are private until the user sends
an invitation, and sending uses existing role checks and invitation semantics.

Use ordinary work-stream access control for the example and ordinary profile
authorization for personal changes. No onboarding endpoint may accept another
user's identity or bypass acceptance because an invitation was discovered.
Analytics must not capture addresses, interaction evidence, prompt bodies, or
profile payloads.

## Agent behavior

No new model tool or plugin is proposed. The example enters the existing
work-stream main feed and executes through its ordinary agent loop, scope,
typed tools, audit, and authorization. Guidance is UI-owned and does not depend
on the model emitting special completion phrases. Select read-oriented starter
requests; do not authorize external writes through hidden tutorial instructions.
User follow-ups retain the normal product authority model.

## Provider configuration

Before implementation, map Slack and Google discovery signals to actual
connector scopes and API availability. Record any new grant or provider review
needed in the corresponding provider documents. Do not assume directory access
proves interaction, or Google login grants mail/calendar access. Existing
connections lacking a required grant show an explicit reconnect or manual-entry
alternative. No provider configuration changes are made by this spec.

## Rollout

Ship directly for new users, without a feature flag, as requested by the product
owner on September 5. This is the default new-user experience rather than a
targeted rollout. Eligibility must cover genuinely new users on both paths and
exempt existing accounts, before workspace creation as well as after activation.

Deploy compatible server storage and contracts before the desktop starts using
them. Older clients continue to use existing workspace entry. If a release must
be rolled back, preserve created workspaces, invitations, profile choices, and
starter work streams and restore functional existing sign-in/workspace entry.
There is no feature-flag kill switch; rollback is a release operation.

## Acceptance

1. A new uninvited account completes intro → workspace → connectors → invites
   → personal setup → a successful real first run, with the result still usable.
2. A new account with an existing membership receives intro → personal setup →
   first run, without creator setup screens.
3. A new invited account sees intro, explicitly accepts, then follows path B.
   Pending, expired, revoked, declined, and multiple invitations behave as above.
4. Skipping all connectors and invitations still permits a useful first run.
5. OAuth cancellation, partial success, relaunch, and a callback after workspace
   switching preserve the correct workspace and next step.
6. Suggestions reflect authorized interaction evidence; duplicate identities,
   bots, self, existing members, and pending invites receive the defined handling.
   Discovery sends nothing; only selected recipients receive invitations.
7. Avatar/color save is visible on a second session and to an authorized teammate.
   Both appearances remain legible; another user's app keeps its own accent.
8. A dropped create/save/send response and two simultaneous sessions do not
   duplicate side effects or regress progress.
9. The first task streams real agent activity, supports elicitation, cancellation,
   and follow-up, and distinguishes failure, successful response, and skipping.
10. Global and EU flows retain their authority boundaries. Existing accounts
    enter normally. Keyboard-only, reduced-motion, short-window, and light/dark
    flows are inspected in a real Electron window before implementation is done.

## Implementation decisions

The implementation uses distinct shared Google Calendar meetings as the initial
interaction signal. The person explicitly chooses the date range and loads more
provider pages; there is no arbitrary lookback or weighted activity score.
Slack ranking remains a future source; manual email invitations work without a
connector. The narrow Global profile projection described above is implemented.
The avatar set uses six original vector shapes and eight colors from Rally's
existing palette, with action text selected for contrast.

The installed Grok Bot 0.43.0 bundle was inspected in addition to the screenshots.
[The motion audit](motion-reference.md) records verified timings, source chunks,
and Rally adaptations, including the three spring curves and first-task handoff.
[The module document](../../new-user-onboarding.md) records implementation
boundaries and validation. Unsent invitation drafts remain in the current
renderer; durable progress resumes their step. Actual model completion and
external OAuth require configured providers in acceptance QA.
