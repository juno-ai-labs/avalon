# Sidekick delegation

> Created 2026-10-22.
>
> People explicitly allow a Sidekick to act as them. Event-triggered and
> scheduled work use the same delegation-aware identity selection in the harness.
> Companions: [state](state.md), [design and tool contracts](design.md).
> Related: [Sidekick lifecycle](../../automation-lifecycle.md),
> [connectors](../../connectors.md), [agent harness](../../agent-harness.md),
> [conversation tools](../../conversation-tools.md), and
> [authorization](../../authorization.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Every Sidekick has a **Delegation allowed** list: people who have authorized it
to perform its configured work using their identity and available permissions.
The person creating a Sidekick joins this list automatically. Other people can
view the list and add or remove themselves from the Sidekick screen, or ask
Rally to do it for them. Reading a Sidekick or joining its Thread grants no
delegation by itself.

Automatic creator opt-in applies to user-driven creation. An autonomous run
may create a Sidekick on someone's behalf, but its inherited execution user
does not consent by that act; the new Sidekick waits for a person to opt in.

A Sidekick can use any eligible delegate for its work. The harness selects the
identity for each operation, tries another eligible identity after a definite
access refusal where the operation permits fallback, and records who actually
acted. An event subscription and an hourly read of the same sheet have the same
access rules. One occurrence creates one run, which can use several delegated
identities without restarting the workflow for each person.

This ships on macOS and web through the shared Sidekick screen and backend.
iOS retains compatibility with existing detail and run reads; native delegation
controls are deferred.

## Motivation

On 2026-10-22, the [Threadbury Content Calendar refresh Sidekick](https://rallywith.ai/app/global/HayvUjzVpR4a5YDWavvbyb/sk/NLj2a9BKHWco9JZnMxXXsm/)
did not run after its source Google Sheet changed. Production inspection found
an active Sidekick, a matching sheet resource and active registration, and no
run rows. The sheet was saved at 18:39:29 UTC, its event was received at
18:42:11, and processing completed at 18:42:13 with
`deterministic_delivery_count: 0`. The event ID was
`01a164eb-b4e2-7677-8902-d6668a652009`.

The connection was personal to the Sidekick's author and run-as user, but the
Sidekick belonged to a Thread. The event matcher rejects restricted events
unless the Sidekick's scope is `personal`, discarding Thread-owned Sidekicks
before admission. Conversely, the schedule path directly admits a run, and a
Thread-owned Sidekick can use its run-as user's personal connection. Switching
from event subscription to hourly reads can therefore change whether the same
authorized work happens. This is one observed incident, not a measured failure
rate.

Relevant current mechanisms are
[`matchExternalEventDestinations`](../../../apps/api/src/durable-objects/workspace-do.ts),
[`executeSchedule` and `claimExecutionPrincipal`](../../../apps/api/src/durable-objects/hosted-sidekick.ts),
and [existing connector fallback](../../connectors.md#2026-10-15-a-connection-that-cannot-reach-a-resource-hands-the-call-to-one-that-can).
Today a Sidekick stores one mutable `run_as_user_id`; claiming it replaces that
person and can rebind connections. It cannot express several people's standing
consent. Ownership, human visibility, and authority to act need distinct rules.

## Goals

1. People can see whose authority a Sidekick may use, grant their own authority,
   and withdraw it without editing instructions or replacing another delegate.
2. User-driven creation establishes the creator's delegation once, with
   attributable consent; autonomous creation cannot opt in an inherited user.
3. An agent can record a person's explicit request to delegate through the same
   operation used by the UI, without enrolling someone who did not consent.
4. Event, schedule, manual, and continued runs use one delegation policy and
   one harness identity resolver.
5. Work on a known resource succeeds through an eligible delegate who has
   access, without asking the model to repeat the workflow under every account.
6. Every external effect and authorization-sensitive read identifies the actual
   acting user and connection; retries retain that identity when required.
7. Revocation prevents future operations under the withdrawn authority without
   undoing completed work or reactivating old grants, subject to normal authz
   propagation and in-flight operation semantics.

## Non-goals

1. Granting provider access, connecting accounts, or widening Google file shares.
   Delegation uses permissions the person already has; those flows remain separate.
2. Changing Sidekick ownership, management, or history visibility. Delegation
   grants execution authority and does not add readers or managers.
3. Letting administrators, other participants, model text, or external events
   consent on someone else's behalf. Such implicit enrollment is rejected.
4. Running the entire workflow once per delegate or combining everyone's inbox
   search by default. Explicit multi-account tasks can use named delegates.
5. Adding per-tool approval prompts, an approval queue, or an alternative
   workflow engine. Standing delegation uses Rally's ordinary execution path.
6. Native iOS UI, cross-Organization delegation, and new provider credentials.
   These are deferred; existing scope and deployment boundaries remain.

## Product behavior

### The list and what consent means

The Sidekick screen shows **Delegation allowed**, followed by:

> This Sidekick can act as the people listed here, using their current access to carry out its work.

Each row shows the person's name, their existing Rally identity indicator, and
whether their delegation is currently available. The current person is marked
**You**; the creator is marked **Creator**. Creation is the creator's opt-in,
recorded with the creation action. The creator can subsequently withdraw;
opening, saving, resuming, or migrating the Sidekick does not silently add them
again. Becoming a delegate does not start a run, publish a draft, or connect an
account.

The creation surface shows the same delegation and shared-history explanation
as self-service opt-in; creation itself records consent without an extra
confirmation step. The host checks that this is a direct user-driven creation
context, including when the agent invokes `create_sidekick`. An autonomous
Sidekick or background run cannot use creation as an alternate enrollment path;
record the creator/on-behalf-of identity without a grant and show the normal
no-delegate state until someone opts in.

The grant applies to the Sidekick's configured work across its normal definition
revisions. Existing Sidekick managers can change that work. This standing scope,
including configured result sharing and existing Sidekick history visibility,
is part of the explanatory copy, rather than an undisclosed consequence.
Delegation never authorizes a Sidekick to enroll more delegates itself.

### Self-service controls

An authenticated person who can access the Sidekick can choose **Allow this
Sidekick to act as me**. If already allowed, they see **Stop allowing this
Sidekick to act as me**. A person needs access to the Sidekick, not permission
to edit its definition, to grant their own authority. An existing delegate can
withdraw their own grant even if they have since lost access to the Sidekick.
This withdrawal path reveals only their own grant and safe Sidekick identity.
It is available in **Settings → Account → Sidekick delegation**, which lists
only the signed-in person's grants, including unavailable Sidekicks. Use the
name recorded when they granted access, or **Unavailable Sidekick** when that
label cannot safely be retained. This account-level surface needs no current
Sidekick viewer or Organization membership grant. It permits withdrawal and
own-grant reconciliation, never enrollment or reading another person's grant.

The list is visible to existing authorized Sidekick viewers. It exposes no
account inventory, tokens, or private provider errors. Other users have no
**Add person** control that grants authority on their behalf. Managers can
remove an existing delegate to stop use of their authority; only that person
can opt in again. The creator marker survives removal without implying an
active grant.

The creator supplies the default identity preference; there is no user
selector. If the creator withdraws or becomes unavailable, known-resource work
can use the remaining eligible delegates. A task tied to a specific person's
account retains that identity and reports when it is unavailable.

| State | Behavior |
| --- | --- |
| Loading | Show the section and a loading state; grant controls wait for the current person's status. |
| Empty | Show **No one currently allows this Sidekick to act as them**, with the self-service action where available. |
| Populated | Show current grants; distinguish unavailable membership or Sidekick access from active consent. |
| Mutation pending | Disable only the affected action until its outcome is known. |
| Error | Keep any last confirmed list, show a retry action, and reconcile an uncertain mutation before claiming success. |
| Offline | Label the displayed list as last known and disable mutations; no locally queued consent takes effect later without reconciliation. |

Updates reach other open Sidekick screens through the existing realtime
invalidation machinery. The UI never reports a grant or withdrawal as saved
until acknowledged by the authority.

### Agent-assisted opt-in

“Allow this Sidekick to use my account” and “Stop running as me” call typed
tools against the selected Sidekick. The target comes from the current Sidekick
or authorized Sidekick discovery. The host derives the consenting person's
identity from the authenticated user request. The model cannot provide a user
ID to substitute someone else.

“Add Maya” from Morgan does not enroll Maya. Rally explains that Maya must opt in
herself. A direct authenticated request from Maya can enroll Maya. Quoted text,
connector payloads, scheduled runs, delegated background agents, and a manager's
assertion that Maya agreed are not consent evidence. The host binds the actor
and request provenance to the authenticated user turn; the model interprets
whether that person asked to allow or withdraw delegation. This is an ordinary
authorized agent write, not a host proof of the meaning of natural language.
A mistaken or prompt-injected interpretation can change the current speaker's
grant; it cannot select another consenting person. Guidance and evaluations
address that residual risk without adding a confirmation flow. The complete
tool contract is in [design.md](design.md#agent-tools).

### One execution policy for every trigger

All runnable Sidekick scopes use the delegation list. A Thread-owned or
Organization-owned Sidekick can use a consenting person's personal connection;
the old ownership-based restriction is removed. Workspace connections remain
available according to their existing capability policy. A personal connection
can serve an operation only under its owner's active delegation.

An eligible delegate has active consent, current Organization membership and
current Sidekick access. Membership removal invalidates the grant for that
membership incarnation; rejoining requires fresh consent. Temporary loss of
Sidekick access makes the delegate unavailable until access returns, unless
they withdraw consent. Pausing or archiving a Sidekick retains the list but
prevents execution through its existing lifecycle rules.

| Trigger | Admission and preferred identity |
| --- | --- |
| Personal connector event | The bound connection's owner must be an eligible delegate and allowed to read the event. Prefer that owner for work on the event's source. |
| Workspace connector event | Apply the event's real audience restriction. At least one eligible delegate must be allowed to receive it; prefer the saved source binding when usable. |
| Schedule | Admit once per scheduled occurrence. Prefer saved source bindings, then the creator when eligible. |
| Manual | Admit once under existing request permissions. The requester is preferred only if they are already an eligible delegate; pressing Run does not opt them in. |
| Continuation | Retain operation identities and receipts; use the normal delegation authz refresh path for new operations. |

Registration, event matching, delivery admission, and harness execution all use
this policy. Ownership category alone never discards an otherwise eligible
event. When no delegate can receive an event, record the refusal without
putting its private payload into the Sidekick conversation. When runnable work
has no eligible delegate, show **Needs attention: no delegated user is
available**. A refusal is distinguishable from a successful no-op.

Changing the delegate list reconciles source registrations and future
execution. Adding a delegate does not subscribe the Sidekick to all events in
all of that person's accounts: only its configured sources are watched. The
same configured provider occurrence observed through more than one account
starts one run using provider occurrence identity where available. Where the
provider offers no common occurrence identity, retain existing connector
deduplication and the workflow's durable source-comparison logic; do not claim
cross-account exactly-once delivery.

### Identity selection inside the harness

The run keeps a coordinating identity for existing conversation/runtime
contracts. It also carries delegation authority for tool operations. One run
can read a sheet as Morgan and publish to an attached destination as Maya when
both have delegated and each operation is otherwise permitted. The model does
not receive raw credentials or impersonation powers.

For a known resource, the harness tries eligible accounts in this order:
an explicit account required by the task; an account already used successfully
for that resource in this run; the configured source binding or event owner;
the creator when eligible; then remaining delegates in grant order with
user ID as the tie-breaker. Duplicate connections are tried once. An explicit
identity constraint restricts the candidate set rather than silently falling
through to another person. Existing workspace connections participate in their
normal connector order and record their workspace principal.

The first success serves the operation. A definite resource-access refusal can
advance to the next candidate. A timeout, cancellation, transient provider
failure, or invalid input does not mean the next person should be tried.
Healthy common-case operations add no provider access probe before execution.

“My inbox,” “my calendar,” an account-relative search, and “send as Maya” have
identity-dependent meanings. Resolve them to the requesting person, a named
delegate, or an explicitly configured task account. A schedule's named account
remains that account if it becomes unavailable: surface the failure. An empty
result never triggers an account switch. An unqualified search uses the
creator's account and reports whose account it searched; if that identity is
unavailable, it reports the failure rather than searching another person's
account. Searching across delegates requires explicit task intent and preserves
attribution.

Reads used to plan a subsequent write establish that operation's identity.
Updates, pagination, replies, provider-created IDs and idempotency keys stay
with their originating account. Writes can fall back only after a refusal
known to precede any effect and only when the task permits another identity.
An ambiguous write is reconciled under its original identity. Sending a message
does not silently select another sender.

### Revocation, results, and visibility

Use existing authorization snapshots, invalidations and model/tool refresh
boundaries; eventual consistency is acceptable. Grants added or withdrawn
become effective as those views refresh. An in-flight operation or a run using
a not-yet-refreshed authorization snapshot may still act; this feature adds
no synchronous cross-object revocation barrier or per-call provider preflight.
After withdrawal is observed, new operations cannot select that grant. Work
can continue with other delegates where fallback is valid; otherwise the run
reports the specific blocked operation. In-flight
writes with uncertain outcomes retain their original account for authorized
reconciliation and never move to another identity to repeat the effect.

Run and tool details show the coordinating user and the actual user/connection
that served each operation, including fallback. Background children inherit
the same Sidekick delegation boundary and observe withdrawals through the same
authorization refresh path. Previously read content and completed publications are not erased
by withdrawal. Sidekick memory and its existing shared Terminal sandbox remain
Sidekick-scoped; switching account does not reset them or make earlier content
private to the next delegate.

Results follow existing destination authorization and explicit publication
behavior. Delegation allows configured sharing on the person's behalf; it does
not make every result private to them or grant new readers to a Thread. Event
payload visibility and the authority to publish a result are separate decisions.

## Impact on the product contract

This deliberately changes the existing privacy contract: restricted connector
events currently cannot enter a non-personal Sidekick because its run history
may be read by the owning Thread or Organization. Under this proposal, an
eligible person's standing delegation authorizes the Sidekick's configured work,
including retaining source-event and tool content in that existing shared
history and publishing configured results. Other readers need not independently
have provider access. The delegation screen must explain that history sharing
alongside its short introductory copy before the person opts in.

Organization ownership also stops implying workspace-only connections. Replace
the authoring prompt's scope-specific connection rules with the common
delegation policy; ownership continues to govern management and visibility.
Selection of a coordinator never grants or revokes human access. Preserve all
existing manager/reader entitlements independently of execution identity.

The proposal preserves typed authorized tools, existing Thread/Breakout access,
and execution without individual tool approvals. Simply joining a Thread still
does not lend credentials. The implementation must update the durable
Sidekick, connector, harness, conversation-tool, and security references together
to explain selected operation identities and consent. The standing brief's
typed-authorized-tools clause remains valid and needs no new product hierarchy.

## Decision log

None yet.

## Key design decisions

1. **Consent is per Sidekick and person.** Replacing one mutable run-as user
   cannot represent several delegates or independent withdrawal. Ownership
   and reader scope continue to answer different questions.
2. **Fallback belongs in the harness.** Reuse connector selection, receipts,
   and authorization boundaries. Model-driven account loops and rerunning the
   full workflow per person repeat work and can duplicate effects.
3. **Identity is recorded per operation.** A single fixed execution identity
   cannot use independently authorized source and destination accounts. A union
   principal would lose attribution and invalidate account-dependent semantics.
4. **Consent covers configured work and destinations.** Requiring every
   destination reader to have provider access is a valid stricter alternative:
   applying the current event restriction to schedules would make the paths
   consistent too. It is rejected because the requested product is a shared
   Sidekick carrying out work through consenting people's personal accounts.
   Standing opt-in therefore includes the existing shared run history and
   configured publication, rather than preserving the old event privacy gate.
5. **Creation opt-in happens once.** Re-adding creators after withdrawal would
   make withdrawal ineffective. No tool-by-tool confirmation flow is introduced.

## Data model

WorkspaceDO owns grants keyed by Sidekick and user, with membership incarnation,
active/revoked state, grant source, consenting actor, request/turn provenance,
timestamps, and a generation for revocation/regrant. Grant source distinguishes
creation, self-service UI, agent request, and migration of established authority.
The existing creator identity supplies the default preference; no separate
default-user setting is stored. Persist the chosen coordinator on each run,
separately from any field that authorizes human readers or managers. Do not
rewrite `automation_directory.run_as_user_id` during automatic resolution:
today that field confers reader and manager rights. Preserve legacy rights in
that field or explicit compatibility grants; candidate eligibility must consult
independent current access, never access created by coordinator selection.

Runs and tool receipts retain selected principal, connection, grant generation,
and provider-operation identity. New active rows require a new consent action;
replayed requests cannot recreate a revoked grant. Retain the existing receipt
and invalidation primitives rather than adding a separate execution ledger.

## Regional impact

Delegation stays within the Sidekick's Organization and configured region.
WorkspaceDO holds consent beside Sidekick authority. Identity and membership
remain in their existing regional stores. No cross-region credentials,
impersonation relationship, or new provider ingress deployment is introduced.
See [regionalization](../../regionalization.md).

## Security and trust model

The host derives the consenting user and authorizes selected delegate/connection
identities through the existing eventually consistent authz path. The model
interprets a direct user's consent request; it cannot substitute the consenting
user. This changes the old non-personal event privacy gate as stated in
**Impact on the product contract**. Grants cannot exceed provider capabilities,
current membership, source access or destination authorization. All Sidekick
scopes use this same rule, including Organization-owned Sidekicks.

Credentials remain encrypted server-side and are prepared only for the selected
operation. Do not copy multiple users' tokens into prompts, transcripts,
Terminal files or shared environment variables. Raw shell commands and hosted
MCP tools do not gain generic cross-account replay: adapters must declare
compatible resource identity, capabilities and safe failure semantics. Where
that contract is unavailable, use the explicitly selected connection and report
the limitation. Existing signed-in actions retain their session/impersonation
audit rules. Natural-language consent retains the ordinary risk of mistaken
or prompt-injected agent writes; there is no separate semantic-proof service.

## Agent behavior

The existing `rally:sidekicks` plugin gains read-list and self-delegation tools.
It exposes only the applicable subset in user-driven contexts and exposes no
consent mutation to autonomous Sidekick runs or background agents. The tool
names, strict inputs, outputs, error sentences, discovery, receipts, and
model-usability requirements are specified in [design.md](design.md).

The model sees which account served a tool and any actionable identity failure.
It does not loop over people after access refusals; the harness owns that
fallback. It names an account when the task depends on one. A successful grant
gets a concise acknowledgement; it does not claim that the Sidekick has run.

The Sidekick's run instructions nudge the model to post a concise message to
its owning conversation when a permission problem blocks or leaves work
incomplete. Use `conversation_post` to say what could not be done, which
account or delegation needs attention when safe to name, and the concrete
recovery step: opt in, reconnect an account, grant access to the resource, or
restore access to the destination. State what completed and what remains
blocked; do not describe the run as a successful no-op. A permission refusal
resolved by normal fallback needs no separate message.

Report the unresolved problem once for the current run rather than posting
every failed account attempt. Do not include private event contents, tokens,
or raw provider errors. If posting itself is refused, or execution was blocked
before the model could run, retain the existing **Needs attention** state and
safe failure reason; do not claim a message was delivered. A Sidekick without
an owning conversation keeps the actionable failure on its own screen.

## Provider configuration

No new provider scopes or OAuth applications are required. Existing connections
and their granted capabilities are used under the consenting owner's identity.
Disconnected accounts follow the existing reconnect flow. Delegation is not a
replacement for provider authorization.

## Rollout

The feature ships to everyone on merge, without a feature flag. Install grant
storage and compatibility reads before enabling delegation-aware execution;
then expose the controls and replace both trigger paths together. Old queued
messages remain decodable and receive current delegation checks at admission.

Backfill each existing Sidekick's current run-as user once. For a user-created
Sidekick with no later claim, this is also its creator. A replaced creator is
not enrolled merely because they remain the author: a legacy claim replaced
that execution authority and rebound its connections. They need a fresh opt-in
to become eligible again. The current run-as value is established authority:
production writes it on creation or an authenticated self-claim.
Do not require a separate historical consent record that does not exist, or
silently disable a claimed Sidekick on deploy. Preserve those users' existing
reader and manager rights independently of future coordinator selection.
Mere room participation or provider account discovery never enrolls anyone.
Backfill records its provenance and never overwrites a withdrawal.
Existing runs retain receipts and selected operation identities; deployment
does not restart them or replay historical events automatically.

Older clients retain the `runAsUserId` response field's legacy meaning. New
run details expose the coordinator separately. Their claim operation becomes
authenticated self-opt-in while preserving the existing explicit management
and reader entitlement of a successful authorized claim;
it cannot replace the creator preference, remove other delegates or bypass the
new authority. Rollback stops new
delegation-aware admissions or restores a compatible single-identity executor
that still observes grants through normal authz propagation; it never restores an executor that ignores
withdrawals. Preserve consent and receipt records.

## Acceptance

1. Create personal, Thread-owned, and Organization-owned Sidekicks. Each records
   its creator once in a direct user-driven context; autonomous creation
   records no delegation for its inherited principal. Withdrawing persists
   across saves, resume, reload and migration replay. A claimed legacy Sidekick
   migrates its current principal without re-enrolling its replaced creator.
2. In real Electron and browser windows, inspect loading, empty, populated,
   unavailable, error, offline, and pending states. Two sessions converge after
   self-opt-in and withdrawal. Joining or viewing never creates delegation.
3. Ask Rally to allow itself to act as the authenticated speaker, inspect the
   list, then withdraw. Asking to add another person, quoted consent, an event,
   and an autonomous run cannot create that person's grant.
4. With the original incident's ownership/connection shape, change a watched
   sheet and admit one run. Use an hourly schedule against the same source and
   show the same eligible accounts and successful read, without widening the
   Google share or Organization audience.
5. Fail the preferred account's known-resource access; the second consenting
   user serves the read. A non-delegate's working account is never tried.
   Revoking a delegate prevents further selection once the existing authz view
   has observed the withdrawal; an in-flight or stale-snapshot attempt may finish.
6. An empty inbox search does not switch accounts. Pagination and reply IDs
   stay with their original account. A named sender is never substituted.
7. A pre-effect access refusal permits eligible write fallback; an ambiguous
   write is reconciled with the original account and is never sent twice under
   another delegate. Cancellation does not advance the candidate list.
8. Withdrawal, Organization removal/rejoin, accepted-request replay and a delayed
   first delivery of an old allow cannot revive authority. Authorization
   snapshots may lag; after refresh, background children and receipt replay
   respect withdrawal. Coordinator selection changes no manager/reader rights,
   and migrated run-as users retain their established access.
9. A run reads through one delegate and publishes through another permitted
   identity, with both accounts attributable. Existing destination access,
   shared Sidekick state, and human history visibility remain explicit.
10. Real workerd tests cover grant lifecycle, admission, alarms, queue/RPC
    compatibility and revocation interleavings. Connector tests double only
    providers and cover fallback/receipt semantics. Integration behaviors are
    proved against a production-code break per [testing](../../testing.md).
    Tool-schema, prompt, and model-usability checks in the companion contract
    pass. No implementation is complete on DOM-only visual evidence.
11. An unresolved permission failure prompts the model to post the blocked
    work and a concrete recovery action to the owning conversation. Successful
    fallback produces no permission-error post. Multiple failed account attempts
    produce one concise report for the run. A refused post remains visible as
    **Needs attention** and is never reported as delivered.
