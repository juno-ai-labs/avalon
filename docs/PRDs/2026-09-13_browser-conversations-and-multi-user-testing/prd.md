# Browser conversations and multi-user testing

> Created 2026-09-13.
>
> Member-authenticated browser conversations and reproducible multiplayer verification.
> Companion: [state](state.md).
> Foundation for [message-only guest sessions](../2026-09-13_message-only-guest-sessions/prd.md).
> Standing contract: [Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Workspace members open an existing Rally conversation in a browser, sign in with
Google, and participate alongside desktop users. The transcript, composer,
optimistic messages, paging, and realtime recovery use the same implementation
as Electron. Browser support is a focused conversation experience, not a second
full workspace application.

Developers and testers run independent sessions as distinct people against the
same local or staging conversation. A reproducible harness verifies that sends,
receipts, reconnection, authorization, and visible updates agree across browser
and desktop clients. This establishes the browser foundation that message-only
guest sessions extend with a different authority boundary.

## Motivation

The product discussion on 2026-09-12–13 identified a concrete obstacle: testing a
multiplayer conversation needs an easy way to put different people in the same
room without installing and managing several desktop clients. That same browser
surface is needed for the separately scoped guest-sharing experience. No
incident count or measured latency baseline was supplied; this proposal does
not claim either.

Current code provides useful seams but not that outcome. The browser fallback
in `apps/desktop/src/renderer/lib/platform.ts` keeps authentication in memory,
and `realtime-socket.ts` can use native WebSocket. However,
`AuthService.createDevelopmentSession` and `createDevelopmentIdentitySession`
always use `DEVELOPMENT_USER_ID`. Two windows therefore exercise one person's
sessions, not distinct authors, membership, or permission loss. Leaving this
gap makes apparent multiplayer success weak evidence for actual collaboration.

## Goals

1. An authorized member signs in and opens an existing work-stream conversation
   in a browser without an Electron installation.
2. Two or more distinct members concurrently send and receive in one canonical
   backend conversation, including a mixed browser/Electron pair.
3. Both clients converge on the same ordered transcript after concurrent sends,
   lost receipts, interrupted connections, backgrounding, and reloads.
4. A documented local/staging harness reproduces these behaviors and reports
   comparable message latency without collecting conversation content.
5. Shared conversation behavior has one implementation, while browser session
   and transport responsibilities remain explicit and independently testable.

## Non-goals

1. Full browser workspace parity, new-workspace setup, workspace administration,
   automation management, connectors, meetings, and native desktop utilities are
   deferred; the immediate need is existing conversation participation.
2. Guest principals, grants, guest-visible history, and anonymous posting belong
   to [message-only guest sessions](../2026-09-13_message-only-guest-sessions/prd.md).
   Giving a guest a hidden workspace membership is rejected.
3. Guest-to-account linking and desktop conversion are deferred to the later
   guest-to-account conversion PRD. Ordinary member Google login is in scope here.
4. Recipient-restricted sharing is deferred to its later PRD; a member link
   grants no authority and is not a guest invitation.
5. A generic client framework, new messaging authority, and replacement telemetry
   stack are rejected for this change. The existing Electron and new browser
   clients are the two concrete consumers.

## Product behavior

### Entry and scope

An existing workspace-addressed work-stream link offers browser participation
alongside the desktop handoff. Its region and IDs are routing context, never
credentials. Google authentication starts through Global identity and returns
to the requested conversation after the owning region activates the authorized
workspace. A wrong account or missing membership shows an access-unavailable
state and an account-switch action; it does not create a workspace or silently
open a different conversation. The member browser route does not accept guest
tokens. [Work-stream links](../../workstream-links.md) owns compatibility with
existing HTTPS and desktop links.

The browser shows the conversation title, attributed transcript, connection
state, and composer. V1 supports text sending, streamed agent output, and
transcript paging through the shared family. Browser file uploads and
resource/artifact previews are deferred; existing Electron capabilities remain.
Native-only controls are absent or explicitly
unavailable; no dead native action appears functional. Workspace navigation and
management chrome are outside this surface. Opening a conversation does not
make the viewer a participant; posting follows the existing participation rule.

### Conversation states

Loading shows the shared loading treatment until authoritative state arrives.
An empty conversation shows its composer and empty state. Populated history
uses canonical ordering and cursor/range coverage, preserves the reader's
position while paging, and offers **Jump to latest** when the reader leaves the
latest edge. Streaming, human attribution, pending messages, and failures have
the same rendering and semantics in both clients.

Sending immediately paints the author's optimistic row with its actual text
and a pending cue. Durable acceptance reconciles that row to its canonical
identity; other members see the authoritative turn once. Concurrent sends follow
server order, not local clocks. A lost receipt after commit is an ambiguous
outcome: recovery reuses the operation/client-turn identity rather than creating
a fresh message. Durable acceptance is distinct from an agent finishing a run.

Offline or reconnecting state remains visible and retains the draft. The UI
never labels an unconfirmed send delivered. On reconnect, foreground return,
and reload, the session is restored or sign-in is requested, then authoritative
history reconciles pending outcomes and gaps without duplicate turns or silent
loss. Pending-operation identity survives the recovery needed to resolve a send
interrupted by reload. No unlimited offline sending feature is implied.

An expired session requests renewed authentication. A definitive access denial
disables sending, clears protected conversation state, and closes its sockets;
recovery cannot keep displaying new content through an old connection. Account
switch and sign-out clear identity-scoped caches and drafts so another person
cannot inherit them.

### Independent sessions

Local development offers explicit, distinguishable seeded member identities with
separate identity and regional credentials. The harness verifies different
server user IDs and authors, not merely different session IDs. Each browser
profile or isolated test context owns its credentials; a desktop session remains
independent. Staging uses actual distinct Google accounts and ordinary membership
admission. Development identity selection remains unavailable outside the
existing development-auth gate.

## Impact on the product contract

This extends the implementation brief's delivery surface beyond its required
Electron prototype. The work stream remains the durable multiplayer home;
viewing still does not imply participation, and posting still does. It adds no
channels, global inbox, search, guest membership, or agent authority. The later
guest PRD owns any additional principal contract.

## Decision log

None yet.

## Key design decisions

1. Extract only the shared conversation composition, session-facing interfaces,
   and transport seams needed by these two clients. Start from
   `ConversationSurface`, `MessageFeed`, and existing composer/reconciliation
   hooks rather than copying a browser transcript or embedding the full desktop
   shell. [Conversation surfaces](../../conversation-surfaces.md) owns this boundary.
2. Preserve SubstreamAgent as the feed and command authority. Current
   `use-workstream-socket.ts` sends `create_message` directly and correlates
   private receipts by operation ID. Older parent-routed wording in
   [WebSocket architecture](../../websocket-architecture.md) is not a reason to
   revive WorkspaceDO message relay. Native browser WebSocket and Electron's
   main-process broker share the protocol, not TCP implementation details.
3. Separate member host dependencies from feed/composer mechanics. A later guest
   host must operate without workspace or parent metadata sockets; do not make
   their presence a new invariant of the common surface. Member-only metadata
   stays authorized by existing rules; this does not implement guest endpoints.

## Regional impact

Follow [regionalization](../../regionalization.md): Global owns identity and
opaque workspace discovery; activation yields a credential for the workspace's
immutable region. Transcript, attachments, commands, and authoritative reads
remain regional. A browser entry or callback does not proxy EU conversation
content through Global. Browser diagnostics obey the same regional routing and
analytics preferences as existing telemetry; EU never falls back to Global
PostHog or the Global lakehouse.

## Security and trust model

The browser is untrusted. Member authorization remains server-side for reads,
tickets, commands, and revocation. Reuse purpose-bound, one-use socket tickets
in `Sec-WebSocket-Protocol`; never place them or session credentials in URLs,
logs, telemetry, or public caches. Explicit browser origins must pass both HTTP
CORS and upgrade checks; no wildcard relaxation substitutes for admission.

The current in-memory development session fallback is insufficient for supported
reload behavior. Browser credential persistence, refresh, callback correlation,
and cross-tab sign-out need a reviewed browser-specific lifecycle under
[security](../../security.md), without weakening Electron's main-process boundary.
OAuth state and one-use exchanges remain verified; content stays untrusted under
CSP and existing Markdown rules. New numeric defensive limits follow the
[limits policy](../../adding-security-defensive-and-other-limits.md), not guessed values.

## Provider configuration

Configure the selected browser origin, Global Google return flow, regional API
CORS/upgrade allowlists, and browser route hosting for local and staging use
before validation. Production origin and callback registration are explicit
deployment inputs. An unregistered origin or callback must fail closed.

## Rollout

The product owner has been asked whether this and guest sessions use separate
flags, one flag, or no flags; the answer is pending. This blocks rollout
implementation. If separate flags are approved, the recommendation is
`browser-conversations-enabled`, default off for everyone, with explicit
targeting and Ace registration in the same implementation change per
[feature flags](../../feature-flags.md). It must not accidentally enable guests.
The final decision must define disable behavior for already-open browser sessions.

Begin verification locally, then with real member accounts in staging before
customer enablement. Preserve desktop operation and existing link handoffs if
the browser surface is disabled. The [private-access PRD](../2026-09-09_private-access/prd.md)
gates acquisition/download distribution and explicitly rejects an account
approval list; this change does not introduce one.

## Acceptance

1. Two distinct browser members and a browser/Electron pair join the same
   conversation, send concurrently, page history, and show correct authors,
   canonical ordering, one optimistic reconciliation, and no duplicate turns.
2. Drop a receipt after durable commit; reconnect, background/foreground, and
   reload each client. Verify the committed turn and retry identity against
   authority, not a fabricated socket frame. Exercise permission loss during
   activity, account switching, and independent sign-out.
3. Real workerd covers admission, storage, replay, and revocation; migrated SQL
   tests cover any new query/schema. The local/staging harness drives real
   clients against real regional backends. Integration behaviors receive the
   production-mutation failure proof required by [testing](../../testing.md).
   Inspect screenshots from real browser and Electron windows for all changed
   states; component assertions alone do not satisfy visible QA.
4. Extend existing [performance tracing](../../performance-tracing.md) and governed
   [telemetry](../../telemetry.md) with browser client attribution. Record send
   intent→optimistic paint, intent→durable receipt, and intent→peer paint, using
   existing correlation IDs. Measure cross-client intervals with a common harness
   clock or explicit clock alignment, never subtract unrelated monotonic clocks.
   Report p50/p95, sample counts, region, foreground/background, connection warmth,
   and transport. Keep content and credentials out of results.
5. Implementation passes lint, typecheck, relevant tests, and the multiplayer
   harness; durable behavior and runnable checks land in their owning documents,
   including development setup and [e2e](../../e2e.md).

## Open questions

- **Build-blocking before rollout implementation:** flag policy and behavior when
  disabled with active sessions; replace the conditional recommendation with the
  product owner's answer.
- **Build-blocking before browser authentication:** choose the browser credential
  persistence/refresh mechanism and exact hosted origins/callbacks after security
  review. This determines reload continuity and cross-tab logout enforcement.
- **Acceptance-blocking:** agree supported browser families and performance
  budgets. Earlier p95 suggestions of under 100 ms optimistic paint, 500 ms
  durable acceptance, and 1 s peer paint are proposals, not approved thresholds.
  The harness reports measurements regardless; no unagreed target becomes a gate.
