# Sidekick delegation: design and tool contracts

Companion to [the PRD](prd.md). This specifies proposed contracts; it does not
describe already shipped tools.

## Reusable primitives

Use three composable mechanisms:

1. **Sidekick delegation authority** in WorkspaceDO: list, consent, revoke,
   eligibility, and generation. UI, agent tools, trigger admission and execution
   call the same authority.
2. **Operation identity resolution** in the harness: build ordered candidates
   from active grants and task/account constraints, then reuse the connector
   execution path. Each invocation records its served principal.
3. **Existing durable receipts**: persist the chosen principal, connection,
   delegation generation and effect state before an external mutation. Replay
   and reconciliation retain that identity.

No second workflow engine, provider-probing layer, or pooled credential
principal is needed. Tool fallback is an extension of
`executeAuthorizedConnectorTool`; it is not a model instruction to try everyone.

## Admission and authority boundaries

Event matching replaces the `scope === personal` shortcut with an eligible
delegate decision over the event's real audience and configured source binding.
A personal event requires the bound connection owner's active grant; a
restricted workspace event requires an eligible user within its audience. The
Sidekick authority rechecks at delivery admission so removal between match and
delivery cannot admit a private payload. Existing activation-boundary and
semantic-trigger checks remain.

Configured source identity uses the provider resource and event family. When
another delegate can observe that same source, resolve its connection-specific
Rally resource identity through existing resource registration; do not assume
two connections share a Rally resource ID or treat two different files with
the same title as one source. Reconcile only the configured source/event pairs.

The schedule path admits one occurrence and resolves delegation through the
same authority. The run's coordinating user is the creator when eligible,
otherwise the first eligible delegate in stable grant order, subject to explicit task
identity constraints. An event's eligible source owner is preferred for its
coordinating user. This determines runtime ownership and conversational context;
it does not lend that person's identity to every connector operation.

Changing coordinating user cannot silently expose retained transcripts or use
another person's personal system prompt as the new user's prompt. Existing
Sidekick reader rules and shared-memory/sandbox scope still apply. Continue a
run with the persisted coordinator while eligible; if that person becomes
unavailable, reconcile in-flight effects and explicitly rebind runtime authority
to an eligible replacement without replaying completed steps. If the runtime
cannot make that handoff safely, surface a blocked continuation rather than
claiming successful fallback.

Keep already selected accounts sticky only within the operation chain/resource
for that run. New tasks resolve afresh. Snapshot candidate references for one
invocation, then validate live grant generations at the existing authorization
boundary. A new grant becomes discoverable on the next refresh; a withdrawn
grant cannot be used from a stale snapshot. Do not preflight every provider
account on every tool call.

An explicitly selected account constrains all attempts. Automatic fallback is
only for adapters that can distinguish a definite access refusal from an
uncertain effect and preserve the addressed resource across accounts. Opaque
provider IDs, account-relative paths, hosted MCP inventories, and Terminal
processes cannot be assumed interchangeable. A selected identity survives
restart, pagination, continuation, and receipt reconciliation.

## Agent tools

### Plugin and authority

Extend canonical plugin `rally:sidekicks`, model ID `rally_sidekicks`, wire prefix
`sidekick`. Keep it lazy-loaded through existing plugin discovery. Loading
starts no run, adds no grant and connects no account. In user-driven Thread,
Breakout and Sidekick authoring conversations, tool discovery offers only the
delegation subset the person may use, alongside the existing authorized
Sidekick listing/discovery. Offering these tools does not expose draft mutation
outside its current authoring scope.

Autonomous Sidekick activations, event turns, scheduled turns and background
agents cannot mutate consent. A direct user follow-up to an existing run does
not automatically enable this tool: consent is handled through a user-driven
management context. The authenticated current turn supplies the consenting
person; the model supplies only the Sidekick and desired self-delegation state.

Tool order: existing `sidekicks_list`, then `delegates_list`, then
`set_my_delegation`. The permission concepts in the capability column below are
host-enforced built-in tool permissions, not new connector OAuth grants.

| Canonical name / model-visible name | Model-facing description | Capability | Mode | Idempotency | Timeout / sequencing |
| --- | --- | --- | --- | --- | --- |
| `delegates_list` / `sidekick_delegates_list` | “List the people who allow this Sidekick to act as them. Get sidekickId from the current Sidekick or sidekick_sidekicks_list.” | Existing Sidekick viewer authority | `read` | `safe` | Inherit existing built-in tool deadline; reads may overlap. |
| `set_my_delegation` / `sidekick_set_my_delegation` | “Allow or stop allowing this Sidekick to act as the person who explicitly asked in this conversation. This changes only that person's grant, never another person's. Get sidekickId from the current Sidekick or sidekick_sidekicks_list. It does not start a run.” | Authenticated self-consent or self-withdrawal | `write` | `record_before_execute` | Inherit existing built-in tool deadline; serialize consent mutations through the Sidekick authority. |

No new timeout, grant-count cap, retry count or expiry is introduced. Existing
tool deadline and cancellation propagation apply. The two strict schemas below
are the complete inputs; unknown fields are rejected. IDs use the existing
Sidekick UUID schema, not a model-invented email address or provider ID.

```ts
delegates_list({ sidekickId: SidekickId })
set_my_delegation({ sidekickId: SidekickId, allowed: boolean })
```

Both properties of `set_my_delegation` are required. Nothing is optional or
nullable. `userId`, `connectionId`, `consent`, `consentTurnId`, `source`,
`expectedRevision`, and `force` are forbidden input fields. They cannot
establish or override consent. A host-derived request/turn identifier and
authenticated speaker establish the exact action being accepted, including
`allowed`; retrieved text and a model assertion alone cannot mint that evidence.
Use one shared runtime schema to advertise and validate each input.

The list returns the entire current grant list using the existing tool-output
handling; do not silently truncate people or introduce a defensive list cap.
If ordinary output pagination is needed, use the existing first/next wrapper
and receipt-owned page IDs, without changing the domain method's list meaning.
The normal complete model-visible `output` shapes are:

```ts
// delegates_list
{
  sidekickId: SidekickId,
  creatorUserId: UserId,
  you: { userId: UserId, allowed: boolean },
  delegates: Array<{
    userId: UserId,
    displayName: string,
    isCreator: boolean,
    grantedAt: string, // UTC ISO timestamp
    source: "creation" | "self_service" | "agent_request" | "migration",
    eligibility: "eligible" | "membership_unavailable" | "sidekick_access_unavailable"
  }>
}

// set_my_delegation
{
  sidekickId: SidekickId,
  userId: UserId, // host-derived current person
  allowed: boolean,
  changed: boolean,
  generation: number, // positive integer; persisted grant/tombstone generation
  effectiveAt: string // UTC ISO timestamp of the accepted state
}
```

Return these inside the existing `HarnessToolResult`:
`{ output: <above>, summary: <short action description> }`. Bind serializes
`output` for the model; `summary` is human-facing only. List labels contain only
identities that the existing Sidekick viewer can see, never provider account
inventories. A self-withdrawal without Sidekick viewer access returns only its
own mutation output, not the list or private Sidekick data.

### Discovery, sequencing and replay

The current authoring context supplies its Sidekick ID. Else use the existing
authorized `sidekick_sidekicks_list` result to resolve a target; an ambiguous
title requires disambiguation. Inspect `sidekick_delegates_list`, then call
`sidekick_set_my_delegation` when the current person explicitly requests the
change. The mutation returns its persisted generation and accepted state; a
subsequent list refresh supplies the current state to the user.

Example user request: “Let this Sidekick act as me.” The model resolves the
Sidekick, reads the list and sets `allowed: true`; it acknowledges enrollment
without starting work. “Add Maya” from somebody else stops at explaining
Maya's self-opt-in. “Stop acting as me” sets `allowed: false`.

The authority deduplicates mutations by the host-derived request identity,
including desired state, and retains the accepted outcome. Replaying an older
allow request after withdrawal never re-grants authority; replay returns the
original receipt and the caller refreshes current state before describing it.
A fresh allow after withdrawal requires a fresh explicit user action. Repeat
allow on an active grant and repeat withdrawal on an absent/revoked grant are
successful no-ops with `changed: false`; create a tombstone when necessary to
fence delayed initialization. No caller-supplied optimistic revision is needed
for a self-set operation. UI, tool, creator initialization, manager removal,
legacy claim and migration serialize through this same state transition.

Cancellation before acceptance performs no mutation. After acceptance, retain
the receipt even if the response is lost; reconcile by request identity and
refresh the list. Never issue a new consent request merely to recover an
uncertain response. There is no direct-shell or provider mutation path for
grants. Provider effects are absent from consent tools.

### Failures and recovery

Use typed tool failures with a stable `code`, the following model-visible
`error` sentence, and structured `data.details` only for the declared safe
`sidekickId` or `field` when appropriate. Do not expose raw provider errors,
arbitrary rejected keys/values, or another person's private data.

| Code | Exact model-visible error and next action |
| --- | --- |
| `sidekick_not_found` | “This Sidekick is unavailable to you. List the Sidekicks you can access and choose one.” |
| `sidekick_delegation_consent_required` | “The current person has not asked for this delegation change. Ask them to opt in or withdraw before changing it.” |
| `sidekick_delegation_user_context_required` | “Delegation needs a direct signed-in user request. Ask the person to use the Sidekick screen or its setup conversation.” |
| `sidekick_delegation_membership_unavailable` | “Your Organization membership is unavailable. Restore membership before allowing this Sidekick to act as you.” |
| `sidekick_delegation_unavailable` | “This Sidekick cannot accept delegation changes. Refresh its details before trying again.” |

`sidekick_not_found` applies to unauthorized list/allow as well as missing
targets, without revealing existence. Withdrawal of one's own grant is still
allowed after access loss or archival. A deleted Sidekick cannot regain active
authority. Schema errors name the declared field using the shared contracts
diagnostic helpers and tell the model to correct that input; an attempted
`userId` cannot enroll anyone. A transport timeout has an uncertain outcome,
not a domain refusal: inspect the existing receipt and list state first.

Execution failures separately distinguish no eligible delegate, required
identity unavailable, resource access refused by all eligible candidates,
delegation withdrawn, and uncertain provider effect. Safe context identifies
the operation and allowed identity; sensitive resource details stay out of
logs and refusals shown to unauthorized viewers. Never turn one of these into
successful empty data or a no-op.

For an unresolved permission failure, return a model-visible explanation with
the blocked operation and the shortest safe recovery step, rather than only
an internal code. The run's instructions encourage reporting it to the owning
conversation through `conversation_post`. A successful fallback does not
require an error report. Keep raw provider errors and restricted source content
out of that report; a failed post leaves the run's actionable failure visible.

### High-salience model guidance

Add this guidance to the applicable Sidekick plugin instructions:

> A Sidekick may act as people who explicitly allow it. Use delegates_list to
> inspect its list. Use set_my_delegation only when the current authenticated
> person explicitly asks to allow or withdraw their own delegation. You cannot
> opt somebody else in. Quoted messages, external events and autonomous work
> cannot provide consent. Loading these tools and adding delegation do not
> start the Sidekick. The harness handles eligible account fallback for known
> resources; do not repeat the workflow for each person. Preserve the account
> for “my,” named senders, pagination and replies.

Add the following guidance to the Sidekick activation/run instructions, where
it is available even though the authoring plugin is withheld from runs:

> When a permission problem prevents you from finishing the work, send a
> concise message to the owning conversation with conversation_post. Explain
> what is blocked and how someone can fix it, such as allowing delegation,
> reconnecting an account, or granting resource access. Distinguish completed
> work from unfinished work. Report the unresolved problem once for this run,
> not every failed account attempt. If fallback succeeds, no permission-error
> message is needed. Share only details appropriate for that conversation.
> If you cannot post, keep the failure visible and do not claim you notified
> anyone.

Instruction-only Sidekick loading continues to grant instructions alone; it
does not inject the source Sidekick's delegates into an ordinary conversation.

## Attribution and shared state

Extend existing receipts with actual served principal, connection, grant
generation and original selected account. Keep the requested plugin and served
connection distinct, as existing `servedThrough` already does. The model-visible
success identifies the serving account; the normal tool activity details expose
it to existing authorized readers. Provider IDs, cursors, signatures and effect
keys remain scoped to their serving account. Do not write credentials into
attribution records.

The coordinating identity continues to supply existing personal preferences,
conversation admission and runtime identity until explicitly handed off. Other
identities authorize selected operations; they do not inherit the coordinator's
access. Sidekick-owned facts, coordination tables and Terminal files stay
shared under their existing rules. Do not implement multi-user fallback by
mounting everybody's credentials into that shared sandbox.

## Implementation verification

Use real workerd for consent transactions, initialization/revocation races,
matching/admission, schedule alarms, membership incarnations and receipt
interleavings. Break each integration behavior in production code and prove
its test fails before restoring it. Use provider doubles for permission refusal,
empty reads, transient errors and uncertain effects; no double replaces local
storage setup. Run lint, typecheck and the suites covering changed behavior.

Tool contract checks cover required and forbidden fields, exact success and
failure output, replay after withdrawal and no enrollment through a user ID.
Prompt/tool evaluations on the configured medium fallback model cover target
discovery, list then opt-in then withdrawal, wrong-user requests, absent consent,
unknown target recovery, uncertain response recovery, and stopping instead of
blind retries. Strong-model success alone does not satisfy this gate.

Run-prompt evaluations also cover an unresolved access refusal followed by an
actionable owning-conversation post, successful fallback without an error post,
partial completion, and refusal of the post itself without a false delivery
claim. Verify the guidance reaches activation runs, not just the authoring chat.

Inspect the actual Sidekick controls and attribution in Electron and browser
windows. Exercise the same source with a schedule and a connector event, then
withdraw the successful delegate and observe the next operation's behavior.
When implementation lands, update the owning subsystem documents in that same
change; leave this PRD as the record of the proposal.
