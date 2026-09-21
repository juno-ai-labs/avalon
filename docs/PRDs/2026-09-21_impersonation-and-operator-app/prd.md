# Impersonation as a product capability, and the Rally Operator app

> Created 2026-09-21.
>
> A member an Organization's owner has authorized may post as another member of
> that Organization, in any Organization, from **Rally Operator** — a separate
> installed desktop application built from the same monorepo packages as Rally.
> Companion state: [`state.md`](state.md). Supersedes
> [the impersonation platform and demo messaging sidecar PRD](../2026-09-19_impersonation-platform/prd.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [security](../../security.md),
> [demo workspaces](../../demo-workspaces.md),
> [multiple workspaces](../../multiple-workspaces.md), and
> [the agent harness](../../agent-harness.md).

## Summary

An Organization owner can grant one member the ability to act as another member:
a directed **can impersonate** relationship, granted and revoked from
Organization settings, audited on both sides. A member who holds at least one
such grant can open **Rally Operator**, a separate desktop app they install
alongside Rally, choose a person they may represent, choose a Channel or Breakout
that person can post to, write a message, and send it. The message is admitted
through Rally's ordinary message path, authored by the represented participant,
and answered by the ordinary Sidekick harness. The audit record keeps both
identities.

This replaces the previous design in two ways. There is no `@rallywith.ai` email
check and no demo-Organization check: the grant is the authority, everywhere, so
customers get the capability rather than Juno Labs keeping a private one. And the
operator surface is its own application rather than a second window inside Rally,
so Rally's window, session, menu, and IPC surface are untouched by it. Demo
preparation keeps creating the grants it needs, but it now does so as one
ordinary caller of a generic writer; nothing on the send path knows what a demo
is.

## Motivation

Two pressures arrived together.

**The demo need is real but narrow.** A live Rally demo has to show multiplayer
work. Today the presenter either coordinates colleagues mid-presentation or seeds
the whole conversation in advance; the first is fragile, the second cannot react
to the room. Seeded turns come from `demo_seed`, which deliberately bypasses
message addressing and substitutes a scripted response, so it cannot stand in for
a live participant turn.

**The capability is worth more than the demo.** Acting as a colleague — a chief
of staff posting for an executive, an operations lead covering an absent
teammate, a support engineer reproducing a customer's Channel — is a capability
customers ask software for, and the authority question it raises is one we have
to answer once, well, rather than twice: a private demo bypass now and an
unrelated "log in as" mechanism later. Building the customer-facing version costs
almost nothing more than the demo version, because the hard part — a directed
grant, an authorization branch, correlated audit — is identical. The demo-only
gates were the expensive part: a company-email predicate, a demo-publication
predicate, a recorded-cast predicate, and a catalog that reads demo state, all of
which exist only to keep a general mechanism private.

The earlier PRD took the private route and was reviewed against its
implementation in [#877](https://github.com/juno-ai-labs/avalon/pull/877). Both
decisions were reversed in review: the demo/domain gating and the in-Rally
window. This PRD is the redraft.

No frequency, throughput, or fleet-capacity evidence exists for either surface,
so this proposal adds no cache, queue, rate limit, or bespoke metrics service,
and prefers a visible, attributable failure to a background retry.

## Goals

1. An Organization owner can grant, see, and revoke a directed **can impersonate**
   relationship between two current members of that Organization, and the effect
   of a revocation is immediate at the next authorization check.
2. Any member holding at least one active grant in any Organization — a customer
   Organization, Juno Labs' own Organization, or a demo Organization — can send
   as the people they may represent. Nothing on the authorization or send path
   consults an email domain, a demo record, or an app entitlement.
3. Every represented send enters the same message-admission path as the
   represented participant's own send: same persistence, same idempotency, same
   addressing decision, same persistent harness, same realtime publication. There
   is no second writer, pre-classifier, or scripted response.
4. The represented participant is the canonical author everywhere a message is
   read — transcript, exports, harness prompt, notifications — and the audit
   record durably identifies the operator who actually submitted it, the grant
   relied on, and the resulting turn.
5. A represented participant can see, without asking anyone, who may act as them
   and which messages were sent as them by someone else.
6. Rally Operator is a separately installed application with its own identity,
   installer, update channel, and authentication callback, sharing `@rally/ui`,
   `@rally/contracts`, and Rally's theme contract rather than reimplementing them.
7. Demo preparation produces grants through the same generic writer any other
   producer uses, and demo retirement revokes the grants it created. No other
   code distinguishes a demo.
8. A retry, double click, or lost response produces at most one turn and at most
   one harness activation for one logical send.

## Non-goals

1. **Operate-as sessions — deferred, not rejected.** A grant authorizes posting
   as someone, not browsing Rally as them. Reading another member's Channels,
   inbox, or private Breakouts through impersonation needs its own product
   behavior, notification, expiry, and review; it is not in this release, and the
   grant is not narrowed to make room for it later.
2. **Credential or session recovery — rejected, permanently.** Impersonation
   never reveals a participant's password, OAuth grant, refresh token, cookie, or
   Rally session. A later operate-as session would mint its own distinct
   credential.
3. **Impersonation inside the Rally client — rejected for this release.** Rally's
   own window keeps one identity: the signed-in person. The operator surface is
   Rally Operator, which is where the persistent "acting as" framing belongs. A
   composer switch inside Rally is how someone posts as a colleague by accident.
4. **Cross-Organization grants — rejected.** A grant is scoped to one
   Organization and never implies authority in another, including between two
   Organizations that share both members.
5. **Self-service grants — rejected.** A member cannot grant themselves a
   relationship, request one in-product, or widen one they hold. Owners grant;
   this release adds no request-and-approve workflow.
6. **Answering elicitations — deferred.** Operator sends new ordinary messages
   only. It lists no open elicitations and submits no answers. This is a missing
   surface, not a sub-permission on the grant: the grant is all-or-nothing, and a
   later elicitation surface reuses it unchanged.
7. **Organization administration in Operator — rejected.** The app does not
   create, rename, or retire Organizations, Spaces, Channels, or Breakouts,
   change membership or roles, manage connections or Sidekicks, or grant
   impersonation. Grants are managed in Rally's Organization settings.
8. **A second transcript or composer — rejected.** Operator does not read
   conversation history, render private content, edit, delete, react, or attach
   files. It is a send surface with a result line.
9. **Bulk, scheduled, or unattended sending — deferred.** No templates, macros,
   schedules, bulk send, or API for arbitrary callers. Each card is one
   deliberate action.
10. **Per-tool approval — rejected.** Once a represented message starts a run,
    ordinary typed-tool capability checks, receipts, and retry policy apply.
    Rally never asks a person to confirm individual tool calls.
11. **New defensive limits — rejected for this change.** No new message-size,
    card-count, grant-count, concurrency, request, rate, expiry, or session limit
    is introduced. Existing platform and route limits apply unchanged. Where a
    guard may later be wanted, [Open questions](#open-questions) names it and
    leaves the number to the team.
12. **A separate repository for Operator — rejected.** The app lives in this
    monorepo beside `apps/desktop`, because it consumes `@rally/ui`,
    `@rally/contracts`, and the shared theme runtime, and those must not drift.
    Separate packaging, not separate source control, is what makes it a separate
    app.

## Product behavior

### Granting

Organization settings gains an **Impersonation** section, visible to owners. It
lists current grants as *operator → represented*, with who granted each one and
when. **Add** selects two current members and creates the directed grant;
**Revoke** ends one. Revocation is immediate: the next catalog read or send by
that operator for that person is denied. A revoked grant is never silently
revived — re-granting is a new, deliberate act, and replaying any automated
producer leaves a revocation in place.

Direction is the whole model. `A → B` lets A act as B and says nothing about B
acting as A. A self-grant `A → A` exists so that acting as yourself needs no
special case in authorization; owners do not create these by hand.

An Organization with no grants shows an empty section and a one-line explanation.
Nothing about impersonation appears for members who are not owners, except the
transparency surface below.

### Seeing what was done as you

Every member's account settings shows **Acting as you**: who currently holds a
grant to represent them in each Organization, and a reverse-chronological list of
messages sent as them by someone else — when, by whom, and in which conversation,
linking to the message. The list is read from the existing audit record, not from
a new message field. A member cannot revoke a grant from here — an owner grants
and revokes — but they can see every one, which is what makes the capability
something we can hand to customers rather than something that has to stay
private.

### Rally Operator

Operator is a separate installed desktop app. It is signed, distributed, and
updated on its own channel, and it appears in the operating system as its own
application. It is not bundled into Rally's window, menu, IPC surface, or
release. Rally continues to own the `rallywithai:` scheme and its existing deep
links; Operator registers its own scheme and its own allowlisted OAuth callback
host and path, because two installed applications cannot reliably share one
custom scheme.

Operator signs the person in with Rally's standard Google identity flow — the
same `POST /auth/google/start`, state, PKCE, single-use ticket, session storage,
and refresh behavior — and then activates an Organization. Its header shows the
signed-in operator, the current Organization, and a persistent **Impersonation**
marker stating that represented messages are audited and visible to the person
represented.

Operator presents the Organizations the signed-in person is a member of *and*
holds at least one active grant in. Choosing one loads the catalog for it.
Changing Organization reloads the catalog and leaves existing draft cards
untouched only where their selections remain valid; anything now ineligible is
cleared. A person with no grants anywhere sees an explanation and no sendable
card — which is the only "access denied" state the app has, because holding a
grant is the entire entitlement.

The main view is a vertical stack of cards. The first is empty; **Add card** adds
another and a draft card can be removed. Each card has a searchable
**Participant** selector, a searchable **Destination** selector grouping each
Channel with its eligible Breakouts, a multiline **Message** field, a summary
reading **Sending as _participant_ to _destination_**, one **Send** button, and
one inline result area. There is no confirmation modal: the summary is the
confirmation.

A new card may reuse the previous card's participant and destination with empty
text and a fresh idempotency key, so an operator can keep a conversation going.
Cards and results live in memory only; closing the app or signing out clears
them, and relaunch does not restore them.

### Loading and selection

On launch, on Organization change, and on explicit refresh, the regional service
returns the members the signed-in operator holds an active grant for in that
Organization, and for each, the Channels and Breakouts that person may post to.
The catalog is convenience, never a permission lease: everything in it is
rechecked on send.

| State | Behavior |
| --- | --- |
| Loading | Existing drafts remain visible; **Send** is disabled; selectors show loading. |
| No grants anywhere | The app explains that impersonation must be granted by an Organization owner, and offers no card. |
| No grants in this Organization | The Organization is listed but its catalog is empty and no card can send. |
| Empty destinations | The selected participant has no conversation they may post to; the card cannot send. |
| Populated | Searchable participant and destination choices are available. |
| Catalog error | Draft text remains; stale choices are labelled and unsendable; **Retry** reloads. |
| Offline | Last loaded labels remain for orientation; no send can start and no outcome is inferred. |

Changing the participant revalidates the destination and clears it if it is not
eligible for the new person. Choosing a different Channel clears an incompatible
Breakout. Anything removed after loading is refused at send.

### Sending

Operator uses HTTP for catalog reads and sends, and opens no socket. The send
route is an HTTP adapter over the same server-side admission implementation the
conversation socket uses — new transport, not a second writer.

1. Operator generates one idempotency key per logical card send and passes only
   the selected IDs, the exact text, the key, and bounded app metadata through a
   typed preload bridge to the main process, which makes the request.
2. The route performs ordinary authentication and authorization. The only
   extension is an impersonation branch: an authenticated operator, an active
   exact grant from that operator to the represented participant in that
   Organization, both parties current active members, and the represented
   participant's ordinary authority over the destination.
3. The impersonation attempt is recorded durably before admission. If it cannot
   be recorded, nothing is admitted.
4. Admission proceeds exactly as for the represented person's own send: their
   turn is persisted as canonical author, participation and realtime behavior are
   ordinary, and the ordinary message identity is returned.
5. The admitted message runs through the unchanged addressing cascade. If it
   addresses Rally, the ordinary persistent harness starts under the represented
   participant's authority. If it does not, the message simply stands in the
   conversation.
6. The card shows **Sending**, then **Sent** with the returned turn reference, or
   **Failed** with safe copy.
7. Operator stops there. It does not wait for a run, poll status, open a socket,
   or infer a harness outcome.

Cards send independently. A submitted card's payload and key are frozen. A
**Sent** card cannot resend. An unknown-outcome card may retry that exact payload
and key, which returns the original admission result rather than creating a
second turn; editing any field is a new card, not a retry.

### Failure states

| Failure | Product behavior |
| --- | --- |
| Authentication missing, expired, or revoked | The shell locks and resumes standard Google sign-in through Operator's own callback. |
| No active grant for the chosen participant | The send is denied before admission and the selection is marked stale. |
| Either party is no longer an active member | Denied before admission; the selection is marked stale. |
| Destination is absent, archived for mutation, or unauthorized for the represented participant | Denied before admission; the destination is marked stale. |
| Message empty or over the existing platform message guard | Inline validation names the rejected field; no request starts. |
| Addressing says `human_only` | The admitted message stands; no run starts. |
| Audit attempt cannot be recorded | No represented admission begins. |
| Admission rejects the turn | The card reports a stable, non-sensitive category. |
| Harness fails after the response | Operator does nothing; Rally owns the downstream outcome. |
| Response lost | The card reports an unknown outcome; retry reuses the same key. |
| Offline | Drafts remain; sending is disabled. |

Client errors carry no credential, private participant data, addressing
rationale, stack trace, or provider response. A schema rejection names the
declared field and a safe issue code rather than collapsing into a generic error,
per [naming a schema failure](../../naming-a-schema-failure.md).

## Impact on the product contract

This changes one clause of [the Rally implementation
brief](../2026-08-05_avalon-implementation-brief/prd.md). That clause currently
says a participant action may be performed under an approved represented-user
delegation while retaining operator attribution, and then restricts the first
such surface to verified `@rallywith.ai` operators in eligible demo
Organizations. This PRD removes the restriction: delegation is a capability of
every Organization, authorized by an owner's grant, and exercised from a separate
operator application. The brief must be updated to that wording in the same
product decision that approves this PRD; leaving the old sentence would describe
a product we no longer ship.

The rest of the contract holds. A Channel remains the durable multiplayer home,
Rally remains inherent, agent work uses the full persistent harness and typed
authorized tools, and writes remain idempotent, visible, and audited.
Impersonation creates no channel, direct message, global inbox, alternate
transcript, or removable Rally participant.

## Decision log

None yet.

## Key design decisions

1. **The grant is the entire authority.** Authorization asks one question: does an
   active directed grant exist from this operator to this person in this
   Organization, and may that person do what is being asked? The rejected
   alternative is the previous design's stack of surface predicates — company
   email domain, demo publication state, recorded original cast — which made a
   general mechanism private at the cost of four extra failure modes, a
   demo-aware catalog, and a capability customers could not have. Restricting who
   may hold a grant is the owner's decision at grant time, not a predicate in the
   send path.
2. **A separate application, not a second Rally window.** Operator is installed,
   signed, updated, and launched on its own. The rejected alternative — a secured
   second window inside Rally, as built in #877 — put a second identity's surface
   inside the client that holds the first identity's session, and paid for it
   with credential-pinning rules, window-retargeting rules, navigation-closes-it
   rules, and an IPC exclusion list, all of which exist only because the window
   lived in Rally. A separate process has one Organization, one identity, and one
   job. It costs a second installer and a second OAuth callback registration.
3. **One monorepo, two products.** Operator lives beside `apps/desktop` and
   consumes `@rally/ui`, `@rally/contracts`, and the shared theme runtime. A
   separate repository was rejected: it would fork presentation and contracts
   within a week. Shared presentation gaps are filled by adding generic
   components to `@rally/ui`, never by copying Rally CSS or starting a second
   component stack.
4. **Demo preparation is only a grant producer.** Preparation calls the same
   generic writer an owner's grant does, for the pairs it seats, and retirement
   revokes what it created. Nothing else in the system asks whether an
   Organization is a demo. This is what removes the one-off demo code the earlier
   design required.
5. **Do not reuse `demo_seed`.** It bypasses addressing and injects a scripted
   turn. Impersonation extends the authorization context instead, so every claim
   about ordinary admission, addressing, and the live harness stays true.
6. **Keep both identities separate end to end.** The relationship stores
   `operator → represented`; authorization resolves both and never treats the
   edge as symmetric; the writer sees the represented participant exactly as it
   sees an ordinary sender; audit keeps both plus the grant relied on and the
   canonical turn. Collapsing them into one session would destroy the fact that
   makes impersonation governable.
7. **Transparency instead of consent-at-grant.** The represented person sees who
   may act as them and everything sent as them. The rejected alternative — the
   represented person must accept each grant — was rejected for this release
   because an owner already controls membership, roles, and data in their
   Organization, and a pending-acceptance state would leave demo preparation and
   coverage scenarios half-granted. If a customer requires acceptance, it becomes
   a grant-time state, not a change to the relationship.
8. **No impersonation field on messages.** Transcripts, exports, imported-session
   provenance, and the harness projection are unchanged; correlation lives in
   audit. Adding a provenance variant would change every reader of a message for
   a fact the audit system already owns.
9. **Each audit event is its own record.** The attempt written before admission
   and the outcome written after are separate rows with separate identifiers,
   correlated by request. Reusing one identifier makes the outcome overwrite the
   attempt, which is the exact evidence a revoked-mid-flight or denied case
   needs. (This defect was found in review of #877 and is fixed here by
   specification.)
10. **No guessed limits.** This PRD names where a guard could go and leaves every
    number to the team.

## Data model

A directed, all-or-nothing **can impersonate** relationship, scoped to one
Organization: the Organization, the operator, the represented member, the
authority basis (which producer created it — an owner grant, a demo preparation
operation), creation time, and revocation time. It carries no capability,
purpose, destination, action, or read/write sub-permission. `A → B` never implies
`B → A`; `A → A` is an ordinary row.

Revocation is a timestamp, not a delete, so the record of what was possible
survives. Any producer's replay inserts only missing pairs and never clears a
revocation.

No message or transcript column is added. Audit events reference both members,
the Organization, the destination, the authority basis, and the canonical turn.

## Regional impact

A grant is regional control-plane authority, stored alongside membership in the
Organization's configured region, and every read and send executes there.
Global identity establishes the operator and activates the Organization but never
receives the message body or performs the represented action. Operator has no
region picker; it uses the region that owns the chosen Organization. A missing
regional service makes that Organization unavailable rather than falling back.

Read [regionalization](../../regionalization.md) before changing any of this.

## Security and trust model

Operator's renderer, its IDs, its text, and its cached labels are untrusted. Its
main process is trusted to hold the operator session, enforce a narrow preload
contract, and contact the configured regional API. The regional API derives the
authorization context; the request body can never choose the operator identity,
role, or principal.

Operator follows Rally's Electron boundary: context isolation and sandboxing on,
renderer Node integration off, navigation and new-window requests denied, no
remote content, every IPC argument parsed, and named operations rather than raw
`ipcRenderer`. No privileged API key is packaged, placed behind a `VITE_` name,
exposed to the renderer or devtools, written to local storage, or logged. No
represented participant credential of any kind is issued, and no demo-operations
bearer credential or `demos` role is reused.

Every catalog read and every send checks, server-side:

1. The operator is authenticated and is a current active member of the
   Organization.
2. An active exact grant points from this operator to this represented member in
   this Organization.
3. The represented member is a current active member of that Organization.
4. The destination belongs to that Organization and currently accepts a post from
   the represented member.
5. The idempotency key has not already produced a different action.
6. The attempt is durably attributable before admission.

These apply to direct API calls and altered clients identically; there is no
client-supplied marker that participates in the decision. The durable object
boundary revalidates the actual operator's session — not just the Worker's
initial authorization — so a session revoked mid-flight stops the send, and it
admits an impersonated principal only for creating an ordinary message.

Addressing is deliberately absent from that list: it runs after admission, as it
does for every message.

Audit uses its existing retention and access controls and records, per event: the
timestamp; both member IDs; Organization and destination; the grant relied on;
app and version and authentication mechanism; request, idempotency, turn, and
trace correlations; the decision; and a safe failure code. It never stores the
message body, a credential, a raw addressing prompt, or a provider response; a
content digest and the canonical turn reference provide correlation. Denied and
failed attempts are recorded too, and the attempt record is never overwritten by
the outcome.

Live harness and tool authorization continue to revalidate the effective
participant, conversation state, connections, grants, and capabilities at their
existing boundaries. Impersonation grants no connector or tool authority the
represented member does not already hold.

## Agent behavior

No agent tool or plugin is added. A represented message starts the existing full
harness through ordinary admission and receives the same system policy, plugin
catalog, skills, connection eligibility, persistent loop, tool receipts, and live
reauthorization the person's own message would. Prompt context names the
represented participant as the human speaker; the operator is audit metadata, not
a second speaker or an instruction. Loading a plugin or running a tool neither
widens the grant nor converts the operator into the represented member for
anything outside that run.

## Rollout

Rally Operator is a new application: it ships to everybody who holds a grant, on
merge, with no feature flag and no staged audience. Grants ship with it — the
Organization settings section and the transparency surface are part of Rally and
appear on the same release. Distribution is not authorization: installing
Operator without a grant shows an empty app.

Order of work: the generic grant, its writer, and the authorization branch first,
provable on their own; then the HTTP catalog and send adapter with audit; then
the grant and transparency surfaces in Rally; then Operator itself; then
switching demo preparation onto the generic writer and deleting the demo-specific
gates. Turning it off means revoking grants, which takes effect at the next check
and leaves prior turns, runs, and audit evidence intact.

## Acceptance

1. An owner can grant, list, and revoke a directed relationship between two
   current members; a revoked grant denies the next catalog read and the next
   send, and re-granting is an explicit new act.
2. Direction holds: granting `A → B` never authorizes `B → A`, and revoking one
   never revokes the other.
3. A member holding a grant in an ordinary customer Organization — no demo
   record, no company email — can load a catalog and send as the person they may
   represent. No email domain, demo state, or app entitlement appears anywhere in
   the decision.
4. A member holding no grant in an Organization gets no catalog and no send
   there, including by direct API call with forged client metadata.
5. The catalog lists only members with an active grant from this operator, and
   only destinations the represented member may post to; nothing from another
   Organization is returned or selectable.
6. Every send, including a same-key retry, rechecks the grant, both memberships,
   the represented member's destination authority, Organization lifecycle, and
   idempotency.
7. The exact message is persisted through the unchanged admission path with the
   represented participant as canonical author, then runs through the unchanged
   addressing path; `human_only` leaves the turn visible and starts no run.
8. An addressing result that invokes Rally creates exactly one subordinate
   execution receipt and uses the full persistent harness under the represented
   member's authority.
9. Transcripts, pagination, exports, imported-session provenance, and the harness
   projection remain contract-compatible and gain no impersonation field.
10. Both the attempt record and the terminal record survive for each request,
    with distinct identifiers, and identify both members, the Organization, the
    destination, the grant, the turn, and the outcome. Denied and failed attempts
    are present, with no body and no credential.
11. If the attempt cannot be recorded, no admission starts.
12. A revoked operator session stops an in-flight send at the durable object
    boundary, not only at the Worker.
13. Double clicks, replays, and a lost response with the same key produce at most
    one turn; a retry returns the original admission result without polling.
14. The represented member's **Acting as you** view lists current grants over
    them and every message another member sent as them, sourced from audit.
15. Demo preparation creates grants through the generic writer, replay creates no
    duplicates and revives no revocation, and retirement revokes what preparation
    created while preserving turns, runs, and audit. No code outside preparation
    and retirement branches on demo state.
16. Rally Operator installs and runs as its own application with its own
    identity, installer, and update channel; Rally's window, menu, IPC surface,
    and release contain nothing for it.
17. Operator completes Google sign-in through its own allowlisted callback and
    its own scheme, and does not register `rallywithai:`. Its package contains no
    operator key or participant credential, and its renderer reaches no session,
    arbitrary IPC, Node, or arbitrary network destination.
18. Operator imports shared presentation from `@rally/ui` and the shared theme
    contract, with no copied Rally stylesheet and no second component stack;
    shared component tests cover presentation once and host tests cover only
    adapter behavior.
19. A sent card cannot resend; an unknown-outcome card retries its exact payload
    and key; a new card clears text and allocates a fresh key; cards and results
    are gone after relaunch or sign-out.
20. Automated coverage exercises direction, self-grants, revocation and replay,
    missing grants, stale membership, unauthorized destinations, cross-
    Organization IDs, direct-API bypass attempts, mid-flight session revocation,
    audit correlation with both records surviving, unchanged transcript
    contracts, duplicate requests, and same-key retry — against the real
    migrations and the real object runtime wherever those semantics matter.
21. Operator is inspected in a real window in loading, no-grant, populated,
    sending, sent, failed, unknown-outcome, and offline states, in light and dark
    appearance, before this is called done.

## Open questions

1. **Does a grant expire?** This release writes the guard open: grants last until
   revoked. If the team wants a maximum lifetime or an inactivity expiry, the
   number is theirs to set; adding it later is a column and a predicate, and
   nothing in this design assumes permanence.
2. **Is the represented member notified when a grant is created, or only able to
   see it?** This release does the latter. Notification is additive and does not
   change the relationship; requiring *acceptance* would add a pending state to
   the grant and would change demo preparation, so it is the one answer that is
   not cheap to adopt later.
3. **Does an owner's own grant to themselves over every member exist implicitly?**
   This release says no: an owner holds only grants that were created. The
   alternative — ownership implies representation — is a much larger claim about
   what ownership means and should not be decided as a side effect of this PRD.
