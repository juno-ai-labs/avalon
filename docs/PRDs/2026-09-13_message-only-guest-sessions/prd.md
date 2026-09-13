# Message-only Guest Sessions

> Created 2026-09-13.
>
> Share one substream's messages with name-only browser guests who can reply.
> Companion: [state](state.md).
> Depends on [Browser Conversations and Multi-user Testing](../2026-09-13_browser-conversations-and-multi-user-testing/prd.md).
> Product contract: [Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

An authorized Rally member shares an exact substream through a bearer link. A
visitor enters an unverified display name, reads the disclosed message history,
and posts text replies alongside members in the same conversation. Opening the
link needs neither an account nor workspace membership.

Guests access only messages in that substream. They receive no resources,
artifacts, previews, downloads, resource metadata, parent content, or workspace
navigation. This is a constrained surface of Rally's existing conversation
system, using the shared renderer and realtime foundation from the preceding
PRD. History selection and the safe treatment of subsequent AI output remain
explicit product decisions before implementation.

## Motivation

The September 12–13 product discussion asks for a low-friction way to bring someone
into an existing conversation without requiring account creation or exposing the
workspace. The requester clarified that guests must access no resources or
artifacts: only messages in the specific stream, with replies retained. No
frequency, adoption baseline, or measured conversion loss has been supplied.

Today private child access requires parent visibility and explicit child
membership. Reusing a member invitation would grant the wrong kind of identity
and access; copying a transcript elsewhere would lose live replies and the
canonical conversation. The browser and multi-user foundation makes it practical
to add this focused entry path without a second chat implementation.

## Goals

1. A name-only guest opens a shared substream and exchanges text messages with
   members through the same authoritative transcript and message protocol.
2. Every guest-visible response contains only the approved message projection
   for the exact grant, including after paging, reconnect, and replay.
3. Resource access and parent, sibling, and workspace discovery remain denied
   even when a guest constructs requests outside the supplied UI.
4. Members understand what the link discloses, who can use it, and what expiry or
   revocation actually stops.
5. Concurrent browser guests and Electron members retain correct attribution,
   ordering, retry behavior, and isolation under the existing multi-user tests.

## Non-goals

1. A full browser workspace, uploads, attachments, artifacts, resource previews,
   downloads, connectors, tools, and search are excluded from this guest product.
   Resource access is explicitly rejected, rather than a later guest entitlement.
2. Guest-to-account conversion, Google upgrade prompts, identity merging, and
   conversion funnels are deferred to PRD 3. This release does not require signup
   or use hidden history as a signup paywall.
3. Verified-email or recipient-restricted links are deferred to PRD 4. A display
   name is not an invitation, verified identity, or proof of intended readership.
4. Conversation import is a separate project; tool-call imports are not included.
5. Guest sharing administration, membership management, elicitation answers,
   message editing/deletion, execution controls, and guest-triggered AI are not
   included in the proposed V1. Guests retain text posting; excluding these
   commands does not turn the product into a read-only viewer.

## Product behavior

### Create and preview a share

A member with the selected sharing permission opens **Share** on an exact
substream. The share dialog previews the same message projection guests receive,
shows its history boundary, and explains that anyone holding the link can enter
and reply. The sharing-role policy is an open decision; ordinary child membership
does not silently become permission to disclose it externally.

The proposed history rule freezes the earliest disclosed point when the share is
created and includes subsequent eligible messages. It never rolls forward and
removes previously readable history as new replies arrive. Whether the member
chooses an explicit cutoff or a last-N selection, and what constitutes one
counted message/turn, is undecided. No numerical reading cap has been approved.

The preview excludes private initial-context seed, hidden older history,
thinking, tool calls/results, resource fields, and execution state. It shows only
the selected conversation's approved title, message text, timestamps, and
necessary author attribution; it does not expose emails or a workspace roster.
The member reviews the disclosed prose because a message can itself quote
sensitive information. Removing resource access cannot erase information already
written into an approved message. Unsafe or incompletely projected content makes
the share ineligible until addressed; it does not trigger a permissive fallback.

### Enter, read, and reply

The visitor sees a focused conversation entry page, enters a display name, and
receives a server-issued guest actor and scoped session. Their messages read
**Guest: Katherine**, for example, and remain distinct from a member named
Katherine. Viewing creates no participation; the first accepted post records
guest participation in this substream without creating workspace membership.

The page shows the shared transcript and text composer, with no workspace or
parent sidebar, artifact rail, roster-management surface, or sharing controls.
It retains only the selected conversation feed, never workspace or parent
control subscriptions. Empty history is a valid empty state with a usable
composer once admission completes. Loading exposes no cached content from
another guest, grant, account, or workspace.

Sending uses the canonical message operation ID, optimistic pending state,
acknowledgement, and ordering. An ambiguous retry preserves the operation ID and
cannot duplicate the accepted message. A failed send remains visibly failed with
its text available for deliberate retry. Offline and reconnecting states retain
the draft and explain that it has not been delivered; reconnect refreshes
authority before replay or submission. A guest send never silently enters the
ordinary AI invocation classifier.

### Session and share lifecycle

The browser retains the guest session across reloads within its lifetime. A
cleared or lost name-only session cannot prove ownership of the previous actor;
re-entering the same name creates a distinct identity. No identity merges by
name or asserted email occur. Separate browser sessions stay isolated even when
they use the same link or display name.

Invalid, expired, revoked, unavailable, and archived states are understandable
without revealing whether another workspace or child exists. An archived parent
cannot accept replies; any retained reading still obeys the grant. Draft text is
not reported as sent when access ends.

Revocation stops new admissions, active delivery, paging, and subsequent commands.
The server fences a racing send at its durable acceptance boundary: a post
accepted before revocation remains a message, while a later attempt fails.
Rotating the bearer grant invalidates its old link and linked sessions. Removing
one guest session alone is not effective exclusion while the same link can mint
another identity. Expiry has the same access consequences. Neither operation
can retract text already viewed, copied, or saved.

## Impact on the product contract

This changes the access contract underlying the [implementation brief](../2026-08-05_avalon-implementation-brief/prd.md):
an explicit guest grant permits reading and posting in one child without parent
visibility or workspace membership. The existing member rule—parent visibility
**and** child membership—remains intact for members. A guest session is an
additional narrow authorization basis, not a fake member or a weakened member
check.

Viewing still does not create participation; posting does, with guest scope.
There are no channels, global inbox, or global search. Rally remains inherent in
the work stream, but the AI boundary below requires an explicit decision about
execution while a guest share is active rather than assuming every participant
receives the member's execution capabilities.

## Decision log

None yet.

## Key design decisions

1. Reuse the shared browser conversation renderer, protocol, and backend
   authority. A separately implemented public chat would duplicate transcript
   ordering, reconnect, and security behavior.
2. Represent guests as distinct server-issued actors with exact scoped grants.
   Workspace membership and client-chosen author IDs would create authority the
   entry flow does not justify.
3. Project messages on the server using an explicit allowed shape. Hiding
   resource controls in the renderer leaves resource identifiers and bytes
   available to a modified client.
4. Prefer a frozen history boundary plus future eligible messages. A rolling
   window changes the conversation underneath participants; the precise
   selection mechanism remains open.

## Data model

A regional share grant binds workspace, parent kind/id, substream, issuing member,
history boundary, capabilities, lifecycle state, and a revocation/version fence.
Guest actor/session records bind to that grant and carry an unverified display
name and validity. Attribution and idempotency distinguish guest principals from
member principals. The exact storage placement and schema follow the existing
WorkspaceDO/parent/SubstreamAgent authorities during implementation; no member
backfill or guest workspace membership is implied.

## Regional impact

Grant creation, guest session authority, transcript content, and guest attribution
stay in the workspace's immutable region. A link's routing information grants no
authority; mismatched region/workspace/parent/substream tuples fail closed. Any
shared routing entry is content-free. EU guest names, content, and identifying
telemetry do not fall back to Global analytics or inference storage. Regional
privacy and telemetry preferences apply to the browser path as they do elsewhere.

## Security and trust model

The bearer link authorizes entry; the display name authorizes nothing. Session
issuance, tickets, admission, and live operations validate the grant's exact
target, capabilities, expiry, and revocation fence. Existing member session
validation cannot simply accept guest credentials. Purpose-specific socket
tickets retain the header/subprotocol transport, origin validation, one-time
admission, regional binding, and hibernation-safe identity attachment.

The capability policy covers HTTP, direct substream socket commands, snapshots,
range loads, replay, nested message fields, and resumed sockets. Guests cannot
request resource metadata, citations revealing restricted metadata, preview or
download tokens, attachment references, or inlined resource-backed media. Tools,
thinking, internal run fields, hidden seed, and unrelated participant details are
excluded. Markdown and links remain untrusted; guest rendering cannot fetch
protected resources through embeds or automatic previews. Guessed IDs and copied
member routes do not bypass authorization.

Keep bearer secrets out of telemetry, application logs, referrers, and subsequent
navigation URLs wherever possible; exchange entry material for scoped session
state and remove it from visible navigation after admission. Browser session
storage, cookie/CSRF protections where applicable, and allowed origins require
security review within PRD 1's browser foundation. Display names receive normal
untrusted-text handling. Public entry introduces abuse exposure: expiry, session
lifetime, and justified issuance/posting budgets need team-selected finite values
before exposure, per [the limits policy](../../adding-security-defensive-and-other-limits.md).
Existing limits remain; this PRD invents no replacements or numeric defaults.

## Agent behavior

The proposed V1 supports human replies and reviewed existing message text, with
guest-triggered inference and tools disabled at command admission. This alone is
insufficient isolation: a later member-triggered run may read hidden older turns,
the private seed, compaction, resources, or prior tool results and disclose them
in new prose.

Therefore ordinary member-context AI cannot publish directly into an active
guest-shared transcript. The recommended V1 boundary prevents new AI runs in that
substream while its share is active and refuses sharing during an active or
pending run; resumed runs, scheduled wake-ups, and queued inputs must obey the
same fence. This is a product choice awaiting confirmation. The alternative is
an explicitly isolated execution context derived solely from guest-disclosed
messages with no hidden seed, checkpoints, resources, tools, or memory; that
requires separate proof and is not assumed delivered here. Until a safe option
is selected and verified, the affected sharing case is ineligible. No new agent
tool, plugin, or transcript-publication review subsystem is proposed.

## Rollout

Feature-flag policy is open; the product owner has been asked. The recommendation
is a separate `message-only-guest-sessions-enabled` flag, default off for everyone,
registered in Ace in the same implementation phase and enabled through explicit
targeting. This recommendation is not recorded as approval. If selected, the
server gate covers grant issuance and existing guest access, so disabling it
closes guest authority rather than only removing **Share**.

Deploy compatible backend capability enforcement before exposing the entry UI.
Use PRD 1's local/staging sessions and multi-user harness before external rollout.
Keep existing acquisition/download gating separate from authentication: this
proposal adds no account-approval gate. Track content-free share creation, guest
entry, and first accepted reply under regional telemetry rules; conversion
measurement belongs to PRD 3.

## Acceptance

1. Two guests and an Electron member exchange text concurrently, with correct
   guest labels, ordered delivery, isolated drafts, failed-send recovery, and one
   canonical message after duplicate retries. Inspect real browser and Electron
   windows through the inherited harness.
2. Wrong region, workspace, parent, child, actor, or grant version fails on
   issuance, admission, reads, and writes. Member-only private access tests still
   pass. Guest sessions cannot subscribe to parent/workspace control feeds.
3. Snapshot, range paging, oversized-turn recovery, replay, reconnect, hibernation,
   and manually crafted HTTP/socket requests expose no pre-boundary history,
   private seed, resources, citations, downloads, nested metadata, or sibling
   identifiers. Later edits cannot bypass the approved projection.
4. Revoke/rotate/expire with sockets open and a send in flight. Subsequent data
   delivery and writes stop, accepted-before-revocation messages remain, and old
   tickets or replay cursors cannot restore access. Lost sessions do not recover
   identity by name.
5. Guest text never invokes AI. Hidden-history and private-resource fixtures
   cannot reach guests through later member runs, resumed work, compaction,
   scheduled execution, or inlined output. Exercise the chosen AI fence on the
   real execution path rather than proving only disabled UI controls.
6. Use real-workerd coverage for runtime authority and socket behavior, actual
   migrations for storage queries, and mutation-prove each new integration
   behavior per [testing](../../testing.md). Reuse latency instrumentation for
   optimistic display, server acceptance, peer delivery, and reconnect; target
   percentiles and thresholds remain team decisions, not asserted achievements.

## Open questions

- **Blocks implementation:** Who may create/revoke shares, and does loss of the
  issuer's authority immediately revoke their grants?
- **Blocks history contract:** Explicit cutoff or last-N selection; what is a
  counted message/turn; any approved numeric cap; and how edits to reviewed
  historical prose affect disclosure and preview confirmation.
- **Blocks safe exposure:** Confirm the recommended human-only active-share
  execution boundary or require isolated guest-safe AI context before launch.
- **Blocks rollout:** Feature flag policy, finite grant/session lifetime, and
  justified public-entry/posting abuse values. Set them with the team's limits
  policy rather than silently shipping an unbounded new public path.
- **Before acceptance:** Choose multi-user latency targets and test scale using
  PRD 1's measurements; no previously suggested millisecond targets are approved.
