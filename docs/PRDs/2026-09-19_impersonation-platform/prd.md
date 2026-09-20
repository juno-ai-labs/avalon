# Impersonation platform and demo messaging sidecar

> Created 2026-09-19.
>
> An authenticated `@rallywith.ai` operator uses a separate Electron sidecar to submit a
> message through Rally’s standard message flow as a selected participant in a
> demo workspace; demo setup provisions these relationships for its users.
> This is the first surface of Rally's shared impersonation platform.
> Companion state: [`state.md`](state.md). Standing contract:
> [the Rally implementation brief](https://github.com/juno-ai-labs/avalon/blob/main/docs/PRDs/2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [demo workspaces](https://github.com/juno-ai-labs/avalon/blob/main/docs/demo-workspaces.md),
> [security](https://github.com/juno-ai-labs/avalon/blob/main/docs/security.md), and
> [the agent harness](https://github.com/juno-ai-labs/avalon/blob/main/docs/agent-harness.md).

## Summary

A presenter signed in with a verified `@rallywith.ai` email chooses **Demo sidecar** from Rally’s workspace/account menu alongside **Sidekicks** and **Settings**. This opens a separate sidecar window bound to the demo workspace it was opened from, where the presenter composes a stack of participant messages. The sidecar is unavailable to every other user and in every regular workspace, even if an impersonation relationship exists. Each card asks only for the represented participant, the destination
work stream or substream, and the message. Sending a card enters Rally’s HTTP message-admission endpoint and admission flow. That flow persists the participant’s turn, runs the existing message-addressing decision, and starts the ordinary persistent Rally harness when the message addresses Rally. Impersonation adds only an alternative authorization path for establishing who may submit as that participant; it does not add a classifier, reorder message admission, or create a special harness path. The turn and resulting work appear in Rally as that participant. The existing audit database stores that the message was admitted through impersonation, the operator who actually submitted it, the represented participant, and the resulting canonical message ID. The message and transcript schemas remain unchanged; audit correlation, not a second provenance field, preserves the actual sender.

The sidecar is the first client of a cohesive impersonation platform, not a one-off demo bypass. The platform represents an operator acting as a participant through one platform-level, directed, all-or-nothing **can impersonate** relationship, a typed impersonation authorization context, and correlated audit events. If `A can impersonate B`, A may act as B wherever an impersonation-aware product surface exists; the relationship is scoped to one workspace and has no capability, purpose, destination, action, or read/write sub-permissions within that workspace. Each surface still applies its own availability rules and B’s ordinary authorization. Existing message contracts, message storage, addressing, transcripts, and harness execution remain unchanged.

The first impersonation-aware surface is new-message sending in the sidecar. It requires a verified operator email whose domain is exactly `rallywith.ai`, a current eligible demo workspace, the platform relationship, and ordinary workspace authorization. Demo preparation creates relationships among the users seated in a demo workspace. The relationship remains a reusable platform primitive, but does not authorize this surface outside that boundary. A later support surface can use the same all-or-nothing relationship without issuing the represented participant’s real credentials.

## Motivation

A live Rally demo has to make multiplayer work visible. Today that means either
coordinating several colleagues during the presentation or preparing all of the
conversation beforehand. The first is fragile; the second cannot react naturally
to the presenter or change the conversation's order mid-demo. The presenter needs
to create believable participant turns at the moment the audience needs them,
without leaving the primary Rally experience or manually signing several people
in and out.

The existing demo-workspace system already casts real colleagues into each fresh
demo and can seed their turns under a server-created `demo_seed` principal. That
proves Rally can verify a represented participant against current membership and
write through production message and harness paths without minting a participant
session. It does not solve the live-demo need: a seed is a checked-in script,
bypasses message addressing by carrying the pack's decision, and substitutes a
scripted provider response. Reusing it for arbitrary live input would make the
standard addressing and full live harness claims untrue.

The need was agreed in this work stream by the demo operators: the presenter has
Rally and a small internal app open side by side, prepares multiple participant
messages, and sends each at the appropriate moment. No frequency, throughput, or
fleet-capacity evidence was supplied. The proposal therefore adds no cache,
queue, guessed rate limit, or bespoke metrics service. It prefers an attributable,
visible failure over a background retry whose result could surprise a live demo.

## Goals

1. Only an authenticated user with a verified `@rallywith.ai` email and an active workspace-scoped **can impersonate** relationship to another current member can post as that member through the sidecar, and only in an eligible demo workspace, including through a self-relationship.
2. The sidecar obtains participants, work streams, and substreams dynamically
   from the current workspace; no cast or destination list is packaged into the
   app.
3. Each card requires only a participant, destination, and message, so a
   presenter can prepare and send several independent moments without exposing
   harness controls.
4. The sidecar reuses `@rally/ui` components, theme tokens, and interaction states shared by Rally’s Electron and browser hosts, so visual and accessibility changes apply consistently across all products.
5. Every send enters Rally’s HTTP message-admission endpoint and preserves its existing order: authorization, ordinary message admission and persistence, existing addressing, and the persistent conversation loop/full harness when addressed. There is no direct transcript write, pre-admission classifier, or scripted response.
6. The existing audit system durably attributes every represented send to both identities: the represented participant remains the canonical author, while the audit event records the authenticated operator who actually submitted it and the canonical message ID.
7. The sidecar is fire-and-forget after the direct message API response; it does not observe, poll, subscribe to, or report subsequent addressing or harness execution.
8. The sidecar denies all other email domains and every regular workspace, even with an active **can impersonate** relationship. Every catalog read and represented send rechecks the operator email domain, canonical demo eligibility, and exact active relationship server-side.
9. The platform expresses impersonation as one all-or-nothing directed relationship, so later support surfaces share its authority, attribution, audit, and revocation instead of inventing capability-specific grants.
10. A retry or lost response produces at most one participant turn and one harness
   activation for the logical send.

## Non-goals

1. **Support operate-as sessions — deferred, not rejected.** The platform model
   accommodates a later time-bounded support session, but this release neither
   exposes nor authorizes one. That capability needs its own product behavior,
   customer policy, notification, read/write boundaries, high-risk action rules,
   reauthentication, and security/privacy review.
2. **Participant credential or session recovery — rejected.** The platform never
   reveals a participant's password, OAuth grant, refresh token, cookie, or
   ordinary Rally session. A future operate-as session may use a distinct impersonation session credential, but the underlying **can impersonate** relationship remains all-or-nothing.
3. **Sidecar access outside company demo workspaces — rejected.** Only verified `@rallywith.ai` operators in eligible demo workspaces may use this surface. Ownership, administrator role, the `demos` role, possession of the app, a workspace name, or an impersonation relationship cannot bypass either gate. The generic relationship carries no demo-specific sub-permission; these are mandatory surface availability checks alongside relationship authorization. This release authorizes no impersonated messaging in regular workspaces.
4. **Managing impersonation relationships in the sidecar — deferred.** The backend stores the platform-level **can impersonate** relationship, and demo preparation creates the required relationships automatically. The sidecar cannot create, widen, revoke, or administer relationships. A general administrative UI and support approval workflow are deferred.
5. **Workspace administration — rejected.** The app does not create, retire,
   rename, or change membership, roles, work streams, substreams, permissions,
   connections, or Sidekicks.
6. **A second composer or transcript browser — rejected.** The sidecar does not read conversation history, display private content, edit or delete turns, react, attach files, or replace Rally's collaboration UI.
7. **Answering elicitations — deferred.** The first sidecar submits only new ordinary participant messages. It does not list open elicitations, address an elicitation ID, or submit an answer as a represented user. This is a missing product surface, not a restriction inside the **can impersonate** relationship; a future elicitation UI uses the same all-or-nothing relationship and the elicitation route’s ordinary authorization and audit behavior.
8. **A sidecar-specific component library or visual stack — rejected.** The app does not recreate Rally controls in Vue, copy CSS, or maintain lookalike components. New presentation primitives required by the card stack are added generically to `@rally/ui` and consumed by every applicable host.
9. **Bulk and unattended execution — deferred.** Scheduling, templates, macros,
   bulk send, automation, and API access for arbitrary callers are absent. Each
   card is a deliberate operator action.
10. **Per-tool approval — rejected.** Once a represented message starts a Rally
   run, ordinary typed-tool capability checks, receipts, and retry policy apply;
   the sidecar adds no confirmation dialog or approval queue.
11. **New defensive limits — rejected for this change.** The sidecar and future support work introduce no new message-size, card-count, concurrency, timeout, request, rate, or session limit. Every existing platform and route limit continues unchanged; this PRD neither raises, lowers, nor duplicates one.

## Product behavior

### Shared Rally presentation

The sidecar is a new host, not a new visual product. Its host adapter owns authentication, API calls, app lifecycle, routing to Rally, and Electron capabilities. `@rally/ui` owns presentation and receives data plus callbacks; shared components never import the sidecar, fetch authority, establish sessions, or call Electron directly.

Existing shared primitives are used wherever they satisfy the card stack. If a card, selector, status treatment, or compact shell primitive is missing, it is introduced as a generic browser-safe `@rally/ui` component with semantic inputs and stable product copy, then used by the sidecar. Host-only behavior remains outside the package. Loading, empty, denied, offline, sending, sent, and failed are explicit semantic states supplied by the host rather than inferred from absent data.

The sidecar stamps the same `data-theme` contract before first render, uses the shared theme runtime, and supports the same light, dark, and system appearance behavior as the main clients. It does not embed remote fonts or a separate token set. Component and style changes belong to the shared package so Electron, browser, and sidecar cannot drift through copied implementations.

### The operator surface

The sidecar is an internal Electron host opened in a separate window from Rally’s workspace/account menu over Rally’s existing shared collaboration UI package, `@rally/ui`. It reuses the same production components, semantic styles, design tokens, typography, theme runtime, controls, menus, fields, buttons, cards, loading/empty/error presentation, accessibility behavior, and interaction conventions used by the main Rally Electron app and browser app. It does not copy styles into a lookalike, fork components, or introduce Vue as a second presentation stack. Sidecar-specific code composes shared presentation components and supplies host callbacks; it does not create a sidecar design system. Its header shows the
current workspace, authenticated operator, and a persistent **Impersonation**
marker with the statement that represented messages are audited.

The **Demo sidecar** menu action appears alongside **Sidekicks** and **Settings** only for an eligible original-cast operator in an eligible demo workspace. Clicking it opens the separate sidecar window with that workspace as its fixed target. The host passes the source workspace through the launch handoff; the backend validates the authenticated operator and that workspace before authorizing any catalog read or send. A client-supplied workspace ID alone never grants access.

Each sidecar window can connect only to the workspace it was opened from. There is no workspace picker or arbitrary workspace-ID field. Switching workspaces in the main Rally window never retargets an existing sidecar or its cards. Navigation to a non-demo workspace, including through a deep link, closes the sidecar and clears its cards and results. Opening the menu action from another eligible demo opens a window bound to that demo; reopening it for the same operator and demo focuses the existing window. A launch without a source-workspace handoff cannot choose a default workspace and instead directs the operator to open the sidecar from Rally’s workspace/account menu. If the operator email or current workspace fails the access boundary below, the shell shows access denied, no participant or destination catalog, and no sendable card. An eligible operator in an eligible demo workspace with no active **can impersonate** relationships sees no eligible participants and no sendable card.

The main view is a vertical stack of cards. The first card is empty. **Add card**
adds another; a draft card can be removed. A new card may reuse the previous card’s participant and work stream/substream, with an empty message field and freshly validated selections, so an operator can keep messaging the same conversation. Each new message uses a new card and a new idempotency key. Each card contains:

1. A searchable **Participant** selector.
2. A searchable **Destination** selector that groups a work stream with its
   eligible substreams.
3. A multiline **Message** field.
4. A compact summary, **Sending as _participant_ to _destination_**.
5. One **Send** button.
6. One inline request-result area for validation, sending, accepted, or rejected.

There is no confirmation modal. The explicit card summary is the confirmation,
and Rally does not interpose approval prompts on individual actions. The destination is a conversation for a new ordinary message, never an open elicitation. The UI has no elicitation selector, answer control, or elicitation identifier field.

### Sidecar access boundary

Access requires both an authenticated operator whose verified email domain is exactly `rallywith.ai` and a current workspace canonically recognized as a published, active demo workspace. The backend derives the email from trusted identity data and demo eligibility from the regional demo register plus ordinary workspace lifecycle authority. A workspace name, client-supplied email or demo marker, app metadata, or membership alone proves neither condition. Other domains, subdomains, and lookalike suffixes are denied. Regular workspaces are always denied, including those owned by staff or containing valid impersonation relationships. The demo template, unpublished candidates, abandoned demos, and retired or closed demos are unavailable.

These two checks define internal-sidecar access; no separate app entitlement or `demos` role is required or sufficient. The existing exact relationship, current membership, and destination authorization checks remain additional requirements. The email restriction applies to the authenticated operator accessing the app. Both operator and represented participant must belong to the demo’s recorded original cast (including its presenter) and still be active members. Later workspace members receive no sidecar access or impersonation eligibility, even if they have company emails or a relationship was created by another producer.

The server checks this boundary before returning any participant or destination catalog and on every represented send through the HTTP message-admission endpoint. It also applies to direct API calls, altered clients, and same-key retries: omitting sidecar metadata cannot bypass it. This release exposes no alternate impersonated-message route for regular workspaces. Missing or unverifiable identity or demo eligibility fails closed. The window’s workspace binding cannot change. Signing out clears its cards and session; a different operator must be authorized afresh for the same source workspace. Switching the main Rally window to another demo leaves this window bound to its original demo; navigation into a non-demo workspace closes the sidecar. Loss of eligibility denies the next request even if the app remains open.

### Authentication and app targeting

The sidecar uses Rally’s standard Google identity sign-in and workspace-session activation for the workspace supplied by the launch handoff. Authentication preserves that target and cannot select or fall back to another workspace; if the operator cannot activate it, access is denied. It calls the existing `POST /auth/google/start` flow with a dedicated callback URI registered to the sidecar. The backend validates and preserves that caller-supplied `returnUri`, so the operating system opens the sidecar when Google authentication completes.

The sidecar must register a callback scheme/URI distinct from the main Rally app. Two installed applications cannot reliably share ownership of the same custom URL scheme, and the backend cannot choose which application the operating system launches after both claim it. The backend allowlists the sidecar’s exact callback host and path alongside Rally’s existing callback rather than accepting arbitrary return destinations. The OAuth state, PKCE, single-use ticket, activation of the launch-bound workspace, session storage, and refresh behavior remain the standard Rally authentication flow.

The sidecar does not register Rally’s existing `rallywithai:` scheme. That scheme remains owned by the main Rally app.

### Loading and selection

On launch and explicit refresh, the regional service resolves the current operator and workspace and returns only the minimum selection fields for participants connected to that operator by an active workspace-scoped **can impersonate** relationship and their eligible destinations. It checks the operator’s verified email domain and canonical demo eligibility before returning any catalog data. The
renderer never supplies an operator identity, region, workspace eligibility,
role, or delegation as an authoritative fact.

The app renders these states:

| State | Behavior |
| --- | --- |
| Loading | Existing drafts remain visible but **Send** is disabled; selectors show loading. |
| Empty participants | No cards can send; the app says the current workspace has no eligible participant. |
| Empty destinations | No cards can send; the app says the selected participant has no eligible destination. |
| Populated | Searchable participant and destination choices are available. |
| Catalog error | Draft text remains; stale choices are labelled and unsendable; **Retry** reloads canonical data. |
| Offline | Last loaded labels may remain for orientation, but no represented action can start and no outcome is inferred. |
| Ineligible operator or workspace | The app is locked and does not return the privileged catalog; only verified `@rallywith.ai` operators in eligible demo workspaces may proceed. |

A participant is selectable only when they belong to the demo’s recorded original cast, remain a current active member of the workspace, and an active **can impersonate** relationship points from the original-cast operator to that participant. Acting as oneself uses the same rule and therefore requires the self-pair created during demo preparation. A destination is a current, active work stream or
substream in that workspace that the represented participant may post to. The
server decides eligibility from canonical membership and conversation authority;
the catalog is convenience, never a permission lease.

Changing the participant revalidates the destination. If the prior destination
is not eligible for the new participant, the app clears it. Selecting a different
work stream necessarily clears an incompatible substream. A participant or
destination removed after loading is refused during send revalidation.

### Sending a card

The sidecar uses HTTP for catalog reads and message submission and opens no WebSocket. The current main client sends `create_message` through a conversation socket; this PRD explicitly adds an HTTP adapter over the same server-side message-admission implementation. The HTTP route is new transport, not a second writer, classifier, or harness path. It validates the bound workspace, destination, both identities, original-cast eligibility, company-email/demo gates, and the exact relationship before calling shared admission, and preserves durable idempotency, realtime publication to ordinary clients, and ordinary loop activation. Its direct response reports admission only. Implementation must update the transport documentation to record this HTTP entry point; this PRD does not require a transport migration for the main client.

**Send** is enabled only when the current catalog has loaded, the three fields are
present, and the card has no unresolved request. The card keeps its message while
an attempt runs and rejects repeat clicks.

A send proceeds as one logical operation through the standard message flow:

1. Electron generates one idempotency key for the logical card send and passes
   only the selected IDs, exact message, key, and bounded app metadata through a
   typed preload bridge to the HTTP message-admission endpoint.
2. The endpoint performs its ordinary authentication and authorization step. The
   only extension is that authorization may validate an impersonation context:
   authenticated operator with a verified `@rallywith.ai` email, canonical eligibility of the current demo workspace, an active **can impersonate** relationship from operator to represented participant in the window’s bound workspace, original-cast eligibility of both users, current membership, destination authority, and idempotency. These sidecar availability checks are mandatory even when the relationship exists, and cannot be bypassed by calling the endpoint directly.
3. Once authorization succeeds, the request enters the same message-admission implementation as a participant’s own send. It persists the represented participant as the canonical author, applies ordinary participation and realtime behavior, and returns the ordinary message identity. The admission result is correlated to the operator and impersonation decision through the audit path, not through a new message field.
4. The persisted message proceeds through Rally’s existing message-addressing
   cascade with the same conversation context, labels, confidence, fallback,
   diagnostics, and availability behavior as every other message. The sidecar
   neither runs this decision early nor overrides its result.
5. If ordinary addressing invokes Rally, the existing admission path links the
   subordinate execution receipt to the destination’s persistent loop and starts
   the full live harness. If it does not invoke Rally, the represented
   participant’s message remains in the conversation exactly as an ordinary
   human-only message does, and no harness run starts.
6. The card shows **Sending** while the direct request is in flight. A successful direct API response changes it to **Sent** and may include the ordinary canonical message ID returned by that response. A direct rejection changes it to **Failed** with safe response copy.
7. The sidecar stops there. It does not wait for addressing, a run ID, first token, completion, or failure; open a socket; poll a status route; or infer a harness outcome. Rally owns all work after the direct message API response. Deep links continue through Rally’s existing routing behavior. The sidecar neither intercepts nor retargets them and adds no separate **Open in Rally** requirement. When a deep link successfully navigates Rally into a non-demo workspace, the sidecar closes and clears its in-memory cards and results. Closing the sidecar does not undo a message already admitted or claim to cancel an in-flight request.

The first sidecar invokes only the HTTP new-message route specified here. It has no elicitation-answer operation, even though the underlying **can impersonate** relationship is not subdivided by action.

A rejected impersonation authorization stops at the same boundary as any other authorization denial: before message admission. The standard admission writer is unchanged; it receives the effective represented participant from the expanded authorization context and returns its ordinary canonical message identity. After authorization and audit, no sidecar-specific policy, schema, persistence writer, classifier, dispatcher, prompt, or harness path remains. “Classification” in this PRD means only the existing
post-admission message-addressing behavior; it is not a new impersonation safety
gate.

### Independent cards and uncertain outcomes

Cards send independently. Once a card is submitted, its participant, destination, message, and idempotency key are fixed for that attempt. A **Sent** card is a read-only result and cannot send again. An unknown-outcome card may retry only that exact attempt with the same key; editing its text or changing its participant or destination is not a retry. Every different message requires a new card. A denied or failed direct request retains its submitted text; a known rejection can be copied into a new draft card for correction and a new logical send. Other cards remain usable unless the denial invalidates access to the whole sidecar. If the client loses the response, the card reports **Send outcome unknown** and does not inspect downstream Rally state. Retrying the same logical send reuses the original idempotency key, so the standard message API returns its existing admission result rather than creating a second turn. This is ordinary API retry safety, not sidecar status tracking.

Cards and their direct API results remain in memory for as long as the sidecar process stays open. Closing the app clears drafts and results; relaunch does not restore them. Signing out also clears them. The sidecar creates no local history database and does not refetch downstream message or run state.

### Failure states

| Failure | Product behavior |
| --- | --- |
| Operator authentication missing, expired, or revoked | The shell locks and starts or resumes standard Google authentication through the sidecar callback. |
| Operator email is outside `rallywith.ai` or unverified, workspace is not an eligible demo, or the exact relationship is absent | Access denied without enumerating participants or destinations; no represented message is admitted. |
| Catalog read fails or is malformed | Selections are unsendable and reload is offered. |
| Participant is removed, suspended, or no longer delegable | Send is denied at authorization before message admission and the selection is marked stale. |
| Destination is absent, archived for mutation, or unauthorized | Send is denied at authorization before message admission and the destination is marked stale. |
| Message is absent or violates the selected platform message guard | Inline validation names the rejected field; no request starts. |
| Ordinary addressing says `human_only` | The represented participant’s admitted message remains posted; no harness run starts. |
| Ordinary addressing uses its existing fallback or availability behavior | The message follows the same outcome as any standard participant message; the sidecar adds no special retry or denial. |
| Audit attempt cannot be durably recorded | No represented effect begins. |
| Admission rejects the turn | The card reports a stable, non-sensitive category and no success. |
| Harness fails after the message API responds | The sidecar does nothing; Rally owns and displays the ordinary downstream outcome. |
| Network response is lost | The card reports an unknown direct-request outcome; a retry reuses the same idempotency key and does not poll harness state. |
| Duplicate submission | The service returns the first operation's result; no second turn or run is created. |
| App is offline | Draft cards remain in memory; sending is disabled. |

Client errors contain no credential, participant-private data, raw policy prompt,
addressing rationale, stack trace, or provider response. Schema rejections name
the declared field and safe issue code instead of collapsing known failures into
a generic error.

## Impact on the product contract

This changes one clause of the Rally implementation brief. Today the contract
says that creating, posting, answering an elicitation, or being explicitly added
creates participation, with the ordinary assumption that the signed-in
participant performs their own action. The impersonation platform adds an
explicitly delegated, auditable way for an operator to perform the posting action
as a represented participant. The visible conversation still has that
participant's post and ordinary participation semantics; the security record also
retains the initiating operator.

The change preserves the rest of the contract. A work stream remains the durable
multiplayer home, Rally remains inherent, agent work uses the full persistent
harness and typed authorized tools, and writes remain idempotent, visible, and
audited. The sidecar creates no channel, direct message, global inbox, alternate
transcript, removable Rally participant, or user-visible terminal.

Before this PRD reaches implementation, the standing implementation brief must be
updated in the same product decision to state that a participant action may be
performed under an approved represented-user delegation while retaining operator
attribution. Treating this as “none” would leave the new authority model outside
Rally's product contract. The first surface is restricted to verified `@rallywith.ai` operators in eligible demo workspaces; the general delegation clause does not authorize this sidecar or impersonated messaging in regular workspaces.

## Decision log

### 2026-09-20 — The menu-launched window shares Rally authentication

**Decided:** Implement the sidecar as a separate secured Electron window in Rally, using the main process’s existing authenticated session pinned to the launching organization. No standalone app, separate Google sign-in, or callback scheme is introduced.

**Why:** The agreed menu launch and closure on navigation make this a window lifecycle within Rally. A separately installed app and OAuth target would duplicate authentication without adding a product capability.

**Changes:** Supersedes the separate callback and app-distribution requirements in Authentication and app targeting, Security, and acceptance 17. HTTP-only messaging, server authorization, original-cast eligibility, and session secrecy remain required.

## Key design decisions

1. **One all-or-nothing impersonation relationship, multiple product surfaces.** The backend primitive is a directed **can impersonate** relationship, its typed authorization branch, and impersonation audit events. The relationship is scoped to one workspace and contains no action, capability, purpose, destination, or read/write sub-permissions within it. Product surfaces decide whether they support impersonation at all, then apply the represented user’s ordinary authorization. This does not create a new message or execution subsystem. The rejected alternative is a demo-only endpoint
   followed later by an unrelated support “login as” mechanism; that creates two
   ways to answer the same high-risk authority question.
2. **Reuse shared presentation rather than imitate it.** The sidecar is a host adapter over `@rally/ui`, following the same boundary as Rally’s Electron and browser clients. The rejected alternatives are a Vue component stack and copied Rally CSS: both make a single look and feel depend on manually synchronizing separate implementations.

3. **Do not reuse `demo_seed`.** The live sidecar extends the standard authorization context with impersonation rather than adding another message producer. `demo_seed` intentionally bypasses addressing and injects a scripted provider turn, so reusing it would violate goals 4 and 5. The useful pattern is its server-derived represented identity and current-membership verification, not its principal or behavior.
4. **Preserve the standard message sequence.** Impersonation is checked in authorization, then the ordinary flow persists the represented participant’s turn before ordinary addressing decides whether Rally runs. The rejected alternative pre-classifies or conditionally persists sidecar messages, which creates a second message flow with different human-only semantics.
5. **Defer the elicitation surface without narrowing the relationship.** Answering an elicitation is a different mutation against pending input, not an ordinary new message, so the first sidecar exposes no such route or UI. If that surface is added later, the same all-or-nothing relationship establishes who may impersonate whom; the elicitation route still applies the represented user’s ordinary authorization and audit behavior.
6. **Keep operator and represented participant separate in relationship, authorization, and audit.** A directed relationship stores `impersonator → represented user`; authorization resolves both identities and never treats the edge as symmetric. The standard message writer sees the represented participant exactly as it sees an ordinary authorized sender; audit retains both identities, the relationship basis, and the canonical message ID. Replacing the operator with the participant in one undifferentiated session loses the fact that makes impersonation governable.
7. **Do not generalize imported-session provenance in this change.** `ImportedMessageProvenanceSchema` is product content used to explain custody of imported Claude/ChatGPT history. Impersonation is an authorization fact. Reusing that schema would change transcript contracts, renderers, exports, and the harness for information already owned by the audit system. The rejected alternative is a new `impersonated_action` message-provenance variant.
8. **Use production admission and the persistent conversation loop.** A direct
   transcript insert, renderer event, or bespoke harness call is rejected because
   it bypasses participation, receipts, addressing, live reauthorization,
   realtime delivery, and durable loop behavior.
9. **Demo preparation is only a relationship producer.** When a demo workspace is prepared, the preparation operation idempotently calls the generic relationship writer for every ordered pair of users seated there, including each self-pair. The generic relationship remains independent of demo status, while this sidecar’s catalog and represented-message authorization additionally check the verified operator email and canonical demo eligibility. The `demos` role and demo credential grant no sidecar access. Ordinary addressing happens only after admission and is not an authorization input.
10. **No represented-user credential reaches Electron.** The renderer gets a
   narrow sidecar API, not an admin key or participant session. A server-side
   operator credential proves the operator; a request-scoped represented context
   proves the action.
11. **No guessed defensive limits.** The contract names where guards belong but
   leaves their numbers open for team decision. Existing platform and provider
   ceilings remain enforceable.

## Data model

The platform stores a directed, all-or-nothing **can impersonate** relationship. Each relationship identifies the workspace, impersonating user, represented user, authority basis, and creation/revocation state. Within that workspace it carries no capability, purpose, destination, action, or read/write sub-permissions.

Direction is load-bearing: `A → B` never implies `B → A`. Self-impersonation is represented by `A → A`, not by a special authorization case. An active exact relationship answers only whether A may impersonate B in that workspace. The impersonation-aware route then evaluates B’s ordinary authorization and its own product availability; it does not consult sub-permissions on the relationship. For this release, surface availability requires a verified `@rallywith.ai` operator in an eligible demo workspace; a relationship in a regular workspace never permits sidecar reads or represented sends.

Demo preparation creates the Cartesian product of its recorded original cast, including the presenter and self-pairs, as directed relationships through one idempotent call to the generic platform relationship writer. This cast is the original preparation roster, not the workspace’s changing membership list. Provisioning for an already-created demo must use that recorded original roster; it cannot infer the cast from current membership. If that roster is unavailable, sidecar access remains unavailable. Later additions to the workspace never expand the sidecar cast. Replaying preparation or provisioning must not reactivate explicitly revoked relationships. Every relationship is scoped to that workspace. Retrying preparation cannot duplicate or widen an existing relationship. From then on the relationship behaves exactly like one created by any future producer. This does not bypass the sidecar’s independent email-domain and canonical demo-workspace checks.

No impersonation field is added to a message or transcript row. Audit events reference the relationship or its authority basis together with both users and the canonical message ID.

## Regional impact

The action executes in the immutable configured region that owns the window’s launch-bound workspace. The regional service validates that workspace against authenticated
context and rejects a destination from another region or workspace. Participant,
destination, message, addressing diagnostics, impersonation audit, harness state,
and audit writes remain in that configured deployment's existing stores.

Global identity may establish the operator and activate the launch-bound workspace, but it does
not receive the message body or become the represented-action executor. The app
has no region picker. A missing configured bridge or regional service makes the
workspace unavailable; it never falls back to another region.

## Security and trust model

The Electron renderer, its IDs, message text, cached labels, and network responses
are untrusted. The main process is trusted only to hold the operator session,
enforce the narrow preload contract, and contact the configured regional API.
The regional API is trusted to derive a canonical authorization context containing the actual operator and effective represented participant. The workspace-scoped **can impersonate** relationship establishes who may represent whom. This surface additionally requires trusted verification of the operator’s exact `rallywith.ai` email domain and canonical demo eligibility; neither the relationship nor a demo principal bypasses those gates.

The sidecar follows Rally's Electron boundary: `contextIsolation` and sandboxing
are enabled, renderer Node integration is disabled, navigation and new windows
are denied, remote content is absent, every IPC argument is parsed, and the
preload exposes named operations rather than `ipcRenderer` or arbitrary URLs.
The privileged API key mentioned in the product concept is never packaged,
placed behind `VITE_`, exposed to renderer/devtools, written to local storage, or
logged. The sidecar authenticates an ordinary Rally user through the standard Google identity, PKCE, ticket redemption, launch-bound workspace activation, and session boundary. Its dedicated callback URI selects the sidecar as the completion target; the backend allowlists that exact host/path and accepts no arbitrary destination. The sidecar does not reuse the regional demo-operations bearer credential or `demos` role, and the request body cannot choose the operator identity or role.

Every catalog read and send checks all of these server-side:

1. The operator is authenticated and their trusted, verified email domain is exactly `rallywith.ai`; the current workspace is canonically a published, active demo and passes ordinary lifecycle checks.
2. An active exact **can impersonate** relationship points from this operator to this represented participant in the current workspace.
3. The operator and represented participant are both in that demo’s recorded original cast and remain current active members of the window’s bound workspace.
4. The destination is in that workspace and currently accepts a post from the represented participant.
5. The idempotency key has not already produced a different action.
6. The attempted action is durably attributable before represented admission.

The demo eligibility check reads canonical regional demo status and workspace lifecycle authority. The `demos` operator role and demo-specific credentials never substitute for the verified company email, eligible demo workspace, or exact relationship. These checks apply to every represented-message request regardless of claimed client identity.

The existing message-addressing decision is deliberately absent from this authorization list. It runs after the message is admitted, just as it does for a direct participant send.

Checks repeat on every send. Live harness and tool authorization continue to
revalidate the effective participant, work-stream state, connections,
grants, capabilities, and disablement at the existing boundaries. Impersonation authorization does not add connector or tool authority that the effective participant would not otherwise hold.

The **can impersonate** relationship is the durable authority fact; the existing independent audit database is the durable record that an ordinary message exercised it. The synchronous audit path stores both identities, the relationship or authority-basis identifier, and the canonical message ID returned by direct admission. Ordinary downstream audit producers may later correlate a run independently; the sidecar does not wait for or update that outcome. No impersonation field is added to transcript blocks, message contracts, imported-session provenance, or the harness projection.

Audit uses its existing retention/access controls. Each applicable event includes timestamp; operator and represented
participant IDs; workspace and destination IDs; relationship/authority basis; app/version and auth-mechanism identifier; request/idempotency,
addressing, turn, run, and trace correlations; decision/outcome; and a safe
failure code. It never stores the privileged credential, raw addressing prompt,
provider response, or message body. A content digest and canonical turn reference
provide correlation without copying sensitive bodies. Denied and failed attempts
are audited too.

The authorization decision writes its impersonation-attempt audit event before calling ordinary message admission. The direct response path records the canonical message ID returned by admission. It does not wait for addressing or a run outcome and adds no transaction, outbox, receipt table, polling route, or recovery system outside the existing audit writer and standard message idempotency. An audit-write failure follows that writer’s existing failure policy and is never reported as successful audit.

The sidecar provides no participant session. A future support operate-as session
uses the same all-or-nothing relationship and authorization/audit primitive but needs its own surface-level approval, expiry, visible operator indication, continuous attribution, and high-risk action handling. It still never reveals the participant's
real credential.

## Agent behavior

The sidecar adds no agent tool or plugin. It starts the existing full Rally
harness through ordinary participant message admission, so the represented run
receives the same system policy, typed plugin catalog, skills, connection
eligibility, persistent loop, tool receipts, and live reauthorization that the
participant's own admitted message would receive.

The impersonation authorization context is host-derived and cannot be supplied by the model or renderer. Prompt context identifies only the represented participant as the human speaker; the operator identity remains audit metadata, not a second speaker or user-authored instruction. The canonical message ID correlates the ordinary turn and any resulting run back to the impersonation audit event. The
model is not told to ask for approval before tools. Loading a plugin or using a
tool neither widens impersonation authority nor converts the operator into the represented
participant for any action outside this run.

After impersonation authorization and ordinary message admission, the message-addressing result is unchanged and is not a model-visible tool decision. It remains the
production `agent_action`, `human_only`, `both`, or `uncertain` contract. An outcome that does not invoke Rally leaves the admitted human turn in place and starts no run. There is no sidecar override,
special prompt, model selector, tool selector, system-prompt field, or scripted
provider seam.

## Rollout

The messaging sidecar is distributed through the approved internal desktop distribution and opened through **Demo sidecar** in Rally’s workspace/account menu alongside **Sidekicks** and **Settings**. The launch opens a separate window bound to the source demo workspace. Server-side access is restricted to authenticated users with verified `@rallywith.ai` emails in canonically eligible demo workspaces. Distribution is not authorization. The exact workspace-scoped **can impersonate** relationship, current memberships, and the represented participant’s ordinary destination authorization are additional controls. Every regular workspace and every other operator email domain is denied, even when a relationship exists. This change adds no feature flag or kill switch.

Demo preparation creates the complete directed relationship set for the users it seats; runtime sidecar access also checks canonical demo eligibility. Rollout first verifies the platform relationship and authorization path independently, then verifies that demo setup invokes the same generic relationship writer. It also verifies dual-principal audit correlation, ordinary message behavior, and same-key direct-response retry.

Revoking the exact relationship, removing either membership, losing the verified company email, losing demo eligibility, or closing the workspace prevents catalog reads and new represented sends at the next canonical authorization check. Demo publication and retirement are inputs to sidecar availability. It does not delete prior turns, runs, or audit evidence.

## Acceptance

1. Demo preparation idempotently creates a directed **can impersonate** relationship for every ordered pair of seated users, including every self-pair; replay creates no duplicates or wider authority.
2. Only for a verified `@rallywith.ai` operator in an eligible current demo workspace, the sidecar loads current members for whom an active workspace-scoped relationship points from the operator to that member, plus eligible work streams and substreams; no object from another workspace is returned or selectable. The backend verifies canonical demo status and the operator email before exposing the catalog.
3. The operator can select themselves through their self-pair or another related participant, select an eligible destination, enter a message, and send without configuring a model, prompt, tool, or harness option.
4. Changing the participant or work stream clears any destination that is no longer compatible.
5. A modified renderer cannot retrieve or send for a cross-workspace or unrelated user. A regular workspace with a valid relationship is always denied, including for a verified `@rallywith.ai` owner or administrator. A non-company or unverified operator is denied even in an eligible demo with a valid relationship. Direct API calls and missing or forged app metadata cannot bypass either gate.
6. Every send, including a same-key retry, rechecks the trusted verified `rallywith.ai` operator email and canonical demo eligibility, the exact directed relationship, current memberships, the represented participant’s ordinary destination authority, workspace lifecycle, and idempotency.
7. After impersonation authorization, the exact message is persisted through the unchanged standard admission path as a direct participant send, with the represented participant as author.
8. The admitted message then runs through the unchanged production addressing path; `human_only` leaves the participant turn visible and starts no harness.
9. An invoking addressing result creates exactly one subordinate execution receipt in the selected conversation and uses the full persistent Rally harness under the represented participant authority.
10. Rally shows the represented participant as the message author and processes participation, realtime, transcript, and run lifecycle through unchanged production paths.
11. Transcript snapshots, pagination, rendering, exports, imported-session provenance, and harness projection remain contract-compatible with ordinary messages; none gains an impersonation field.
12. The impersonation attempt and direct-response audit events identify the actual operator, represented participant, exact relationship or authority basis, workspace, destination, canonical message ID, and direct outcome; denied and failed direct requests are present without message bodies or credentials. Existing downstream producers remain responsible for any later addressing or run audit.
13. Double-clicks, replays, and a lost response with the same logical idempotency key produce at most one turn; retrying returns the standard API’s existing direct admission result without sidecar polling.
14. If required impersonation audit recording fails, no represented admission starts.
15. After a successful direct message API response, the sidecar performs no follow-up read and reports no addressing or harness status; any later failure is owned and displayed by Rally’s ordinary surfaces.
16. Revoking the exact relationship, removing either membership, losing the verified company email, attempting to retarget the sidecar to another workspace, losing demo eligibility, or retiring the demo blocks the next catalog read or represented send without a client update. Demo retirement revokes the workspace-scoped relationships it created while preserving prior turns, runs, and audit evidence.
17. Standard Google sign-in returns to the sidecar through its dedicated allowlisted callback URI, while the sidecar does not register the main app’s `rallywithai:` scheme. The packaged app contains no internal operator key or represented participant credential; its renderer cannot access sessions, arbitrary IPC, Node, or arbitrary network destinations.
18. Automated coverage exercises relationship directionality, self-pairs, complete demo pair creation, idempotent setup, revoked and missing relationships, self-send, cross-participant send, stale membership, unauthorized destination, denial in regular workspaces even with a valid relationship, denial of non-company and unverified emails in demos, exact-domain matching against subdomains and lookalike suffixes, denial of template/unpublished/abandoned/retired demos, fail-closed eligibility lookup, direct-API and forged-client bypass attempts, account/workspace changes, cross-workspace IDs, impersonation audit correlation, unchanged transcript/imported-session contracts, direct API rejection, duplicate requests, lost-response retry with the same idempotency key, and the absence of sidecar polling/subscriptions against the real migrations and object runtime where those semantics depend on them.
19. The sidecar imports shared presentation from `@rally/ui`, uses the shared theme contract and semantic states, and introduces no copied Rally stylesheet, sidecar component library, or Vue presentation implementation. Shared component tests exercise presentation once; host tests cover only adapter behavior.
20. Deep links retain their existing Rally routing behavior. A successful deep-link navigation to a non-demo workspace closes the sidecar and clears its cards/results; no link can retarget the sidecar to that workspace. Already admitted messages remain admitted, and closing does not imply cancellation of an in-flight request.
21. The sidecar exposes no elicitation list or answer control and invokes no elicitation-answer path; this deferred UI does not create an elicitation sub-permission on the **can impersonate** relationship.
22. Direct API results remain in memory until sign-out or the sidecar process closes and are absent after relaunch.
23. The finished sidecar is inspected in a real Electron window in loading, populated, denied, offline, sending, sent, failed, and unknown-direct-outcome states before completion.
24. **Demo sidecar** appears in Rally’s workspace/account menu alongside **Sidekicks** and **Settings** only for eligible original-cast operators in eligible demos. It opens a separate window bound to the source workspace; a missing or forged handoff grants no access.
25. Switching the main Rally workspace never retargets an open sidecar; navigation to a non-demo workspace closes it. Reopening the same operator/demo focuses its window; opening another eligible demo creates a separately bound window. Every catalog read and send is constrained to its window’s original workspace, including across authentication.
26. Only the recorded original demo cast, including its presenter, is eligible. Later-added members cannot operate the sidecar or be selected, even with company emails and valid relationships. Existing-demo provisioning uses only the recorded original cast; missing cast data denies access, and replay never restores revoked relationships.
27. The operator can send successive new cards to the same work stream/substream. A new card may retain validated participant/destination selections but starts with empty message text and a fresh key. Sent cards cannot resend; submitted and unknown-outcome cards cannot change their payload, and retries reuse the exact original payload and key.

28. Catalog reads and new-message submission use HTTP only. The sidecar opens no sockets, and the HTTP admission adapter preserves the shared authorization, persistence, idempotency, realtime publication, and harness behavior without observing subsequent execution.

## Open questions

N/A — the menu entry point, launch-bound workspace, original-cast eligibility, new-card message lifecycle, company-email/demo-workspace access boundary, authentication target, Rally navigation target, and in-memory result lifetime are decided above. Implementation-specific callback registration values are recorded in the design and configuration that introduce the sidecar.
