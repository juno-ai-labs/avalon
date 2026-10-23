# Sidekick delegation

> Created 2026-10-22.
>
> Sidekicks keep an allowed-user list and enroll their creators automatically. Event-triggered and
> scheduled work use the same delegation-aware identity selection in the harness.
> Companions: [state](state.md), [design and tool contracts](design.md).
> Related: [Sidekick lifecycle](../../automation-lifecycle.md),
> [connectors](../../connectors.md), [agent harness](../../agent-harness.md),
> [conversation tools](../../conversation-tools.md), and
> [authorization](../../authorization.md). Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

Every Sidekick has a **Delegation allowed** list: people whose identity and available permissions it may use for configured work.
The person creating a Sidekick joins this list automatically. Other people can
view the list and add or remove themselves from the Sidekick screen, or ask
Rally to do it for them. Reading a Sidekick or joining its Thread grants no
delegation by itself.

Creators are enrolled immediately for every creation path, including autonomous
creation under an inherited execution user. There is no creator consent marker,
disclosure screen or extra Create action. Agents may add or withdraw delegation
for any current Organization user during direct or autonomous work.

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
2. Every creation immediately enrolls its creator, including autonomous creation.
3. An agent can add or withdraw delegation for any Organization user, including
   during autonomous work.
4. Event, schedule, manual, and continued runs use one delegation policy and
   one harness identity resolver.
5. Work on a known resource succeeds through an eligible delegate who has
   access, without asking the model to repeat the workflow under every account.
6. Every external effect and authorization-sensitive read identifies the actual
   acting user and connection in private database checkpoints; exact-effect
   recovery retains that identity.
7. Revocation prevents future operations under the withdrawn authority without
   undoing completed work or reactivating old grants, subject to normal authz
   propagation and in-flight operation semantics.

## Non-goals

1. Granting provider access, connecting accounts, or widening Google file shares.
   Delegation uses permissions the person already has; those flows remain separate.
2. Changing Sidekick ownership, management, or history visibility. Delegation
   grants execution authority and does not add readers or managers.
3. Running the entire workflow once per delegate or combining everyone's inbox
   search by default. Account-relative task identity is outside this feature.
4. Adding per-tool approval prompts, an approval queue, or an alternative
   workflow engine. Standing delegation uses Rally's ordinary execution path.
5. Native iOS UI, cross-Organization delegation, and new provider credentials.
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

Creation immediately enrolls the creator using the ordinary creation action.
This also applies when an autonomous agent creates a Sidekick. No disclosure
screen or separate opt-in is required. Replaying creation respects an existing
withdrawal and does not enroll the creator again.

### Self-service controls

An authenticated person who can access the Sidekick can choose **Allow this
Sidekick to act as me**. If already allowed, they see **Stop allowing this
Sidekick to act as me**. A person needs access to the Sidekick, not permission
to edit its definition, to grant their own authority. An existing delegate can
withdraw their own grant even if they have since lost access to the Sidekick.
This withdrawal path reveals only their own grant and safe Sidekick identity.
Use the agent's own-delegation tools for withdrawal when the Sidekick cannot
be opened. They reveal only that person's stored grant and safe label. There
is no Account settings withdrawal screen or separate account HTTP endpoint.

The list is visible to existing authorized Sidekick viewers. It exposes no
account inventory, tokens, or private provider errors. The Sidekick screen offers self-service controls only; it has no manager
removal control. Agent tools can target any current Organization user. The
creator marker survives withdrawal without implying an active grant.

The creator supplies the default identity preference; there is no user
selector. If the creator withdraws or becomes unavailable, known-resource work
can use the remaining eligible delegates. Continuation replaces an unavailable
coordinator with another eligible delegate.

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

### Agent-managed delegation

The agent tool accepts `{ sidekickId, userId, allowed }` and may add or withdraw
delegation for any current Organization user, including in autonomous Sidekick
runs and background workers. The host supplies the execution actor; `userId`
selects the target. The actor must have Sidekick access to change another user.
The target's grant does not add human reader or manager rights; ordinary
eligibility rules still decide whether it can serve work.

There is no canonical-human-speaker check and no special consent interpretation
or quoted/external-content guidance. These are ordinary agent writes with the
same durable action and replay rules. The full tool contract is in
[design.md](design.md#agent-tools).

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
| Manual | Admit once under existing request permissions. Prefer an eligible requester as coordinator only; operations use the selection rules below. Pressing Run does not opt the requester in. |
| Continuation | Keep receipts and replace an unavailable coordinator with another eligible delegate. |

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

Each operation starts with its selected plugin's eligible connection. On a
definite pre-effect access refusal, try configured source bindings, the creator
when eligible, and remaining delegates in stable grant order. Try duplicate
connections once. Workspace connections retain their normal workspace principal.
Remote inventories remain tied to their selected connection.

The first success serves the operation. Empty results, timeout, cancellation,
transient provider failure and invalid input do not trigger another account.
Healthy operations add no provider preflight. There is no `rallyAccount` selector,
account-relative task identity, or account pinning across reads, replies,
pagination and agent handoffs. Each separate operation selects independently.
Only recovery of the exact same uncertain effect retains its recorded account
and provider key, preventing duplicate external writes.

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

Run history can show the coordinating user. Actual user/connection choices and
fallback attempts remain in private database checkpoints for debugging; normal
app activity and tool results do not expose them. Background children inherit
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
have provider access. The delegation screen uses the agreed short introductory copy.

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

- 2026-10-23: Removed manager delegate removal and creator consent/disclosure.
  Every creation enrolls its creator immediately. Agent delegation accepts any
  Organization user and is available during autonomous work; removed direct-user
  consent checks and special quotation/event-consent guidance.

- 2026-10-22: Removed the dedicated Account withdrawal feature at the user's
  request. Sidekick-screen withdrawal and agent self-delegation tools remain.

## Key design decisions

1. **Consent is per Sidekick and person.** Replacing one mutable run-as user
   cannot represent several delegates or independent withdrawal. Ownership
   and reader scope continue to answer different questions.
2. **Fallback belongs in the harness.** Reuse connector selection, receipts,
   and authorization boundaries. Model-driven account loops and rerunning the
   full workflow per person repeat work and can duplicate effects.
3. **Identity is recorded per operation.** A single fixed execution identity
   cannot use independently authorized source and destination accounts. A union
   principal would lose attribution and obscure which delegate performed an operation.
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

The host supplies the execution actor. Agent input may select any current
Organization user as a delegation target, including during autonomous work.
Existing Sidekick access authorizes the actor and ordinary membership,
source/destination access and provider capability checks constrain execution.
This changes no human reader or manager rights.

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

The existing `rally:sidekicks` plugin exposes list and targeted delegation tools
in user-driven and autonomous contexts. The strict inputs include the target
userId, while the execution actor remains host-owned. Tools, outputs, receipts
and recovery behavior are specified in [design.md](design.md).

The model sees normal tool results and actionable permission failures. It does
not loop over people after access refusals; the harness owns that fallback. A successful grant
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

Backfill existing creators and established previous task-account users without
reconstructing direct-user consent provenance. Never overwrite an existing grant
or withdrawal. Preserve stable shared-file identity and existing human rights.
The creator is eligible only while current membership and Sidekick access allow
it; a stored grant alone confers neither provider access nor human visibility.
Existing runs retain receipts and selected operation identities.

Mere room participation or provider account discovery never enrolls anyone.
Backfill records its provenance and never overwrites a withdrawal.
Existing runs retain exact-effect receipts and account choices for recovery; deployment
does not restart them or replay historical events automatically.

Older clients retain the `runAsUserId` response field's legacy meaning. New
run details expose the coordinator separately. Their claim operation becomes
authenticated self-opt-in without creating additional management or reader
entitlements; existing access continues to follow the normal access rules.
It cannot replace the creator preference, remove other delegates or bypass the
new authority. Rollback stops new
delegation-aware admissions or restores a compatible single-identity executor
that still observes grants through normal authz propagation; it never restores an executor that ignores
withdrawals. Preserve consent and receipt records.

## Acceptance

1. Create personal, Thread-owned, and Organization-owned Sidekicks. Each enrolls
   its creator immediately, including creation through an autonomous worker.
   Creation replay, save, resume and migration do not undo withdrawal. Legacy
   creators are enrolled without a direct-user provenance audit; old shared-file
   bindings and existing withdrawals remain intact.
2. In real Electron and browser windows, inspect loading, empty, populated,
   unavailable, error, offline, and pending states. Two sessions converge after
   self-opt-in and withdrawal. Joining or viewing never creates delegation.
3. Ask Rally to inspect and change delegation for a target Organization user.
   The same tools work during autonomous runs and background work. Reject targets
   outside the Organization; preserve actor/target identity in action receipts.
4. With the original incident's ownership/connection shape, change a watched
   sheet and admit one run. Use an hourly schedule against the same source and
   show the same eligible accounts and successful read, without widening the
   Google share or Organization audience.
5. Fail the preferred account's known-resource access; the second consenting
   user serves the read. A non-delegate's working account is never tried.
   Revoking a delegate prevents further selection once the existing authz view
   has observed the withdrawal; an in-flight or stale-snapshot attempt may finish.
6. A continuation replaces an unavailable coordinator with another eligible
   delegate, persists that choice, and continues root and background work. With
   no eligible delegate, it reports the blocked continuation.
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
