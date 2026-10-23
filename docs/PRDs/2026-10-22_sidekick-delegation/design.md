# Sidekick delegation: design and tool contracts

Companion to [the PRD](prd.md). This specifies proposed contracts; it does not
describe already shipped tools.

## Reusable primitives

Use three composable mechanisms:

1. **Sidekick delegation authority** in WorkspaceDO: list, consent, revoke,
   eligibility, and generation. UI, agent tools, trigger admission and execution
   call the same authority.
2. **Operation identity resolution** in the harness: build ordered candidates
   from active grants and compatible connections, then reuse the connector
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
Sidekick authority uses the existing delivery-admission authz view as well as
matching. These views may lag a grant change; no new revocation barrier is
introduced. Existing activation-boundary and semantic-trigger checks remain.

Configured source identity uses the provider resource and event family. When
another delegate can observe that same source, resolve its connection-specific
Rally resource identity through existing resource registration; do not assume
two connections share a Rally resource ID or treat two different files with
the same title as one source. Reconcile only the configured source/event pairs.

The schedule path admits one occurrence and resolves delegation through the
same authority. The run's coordinating user is the creator when eligible,
otherwise the first eligible delegate in stable grant order. An event's eligible source owner is preferred for its
coordinating user; a manual run prefers its eligible requester as coordinator.
Those trigger preferences affect coordination only, not the separate tool-account
order in the PRD. This determines runtime ownership and conversational context;
it does not lend that person's identity to every connector operation.

Changing coordinating user cannot silently expose retained transcripts or use
another person's personal system prompt as the new user's prompt. Existing
Sidekick reader rules and shared-memory/sandbox scope still apply. Continue a
run with the persisted coordinator while eligible; otherwise pick another eligible
delegate and persist that coordinator before continuation. Root runs and background
workers use the replacement. If no delegate is eligible, report Needs attention.
Never write the selected coordinator into the directory's legacy run-as field
or derive reader/manager access from the new per-run coordinator field.

Each operation starts with its selected plugin, then uses configured source,
creator and stable delegate ordering after a definite pre-effect access refusal.
Remote MCP inventories retain their selected connection. There is no account
selector or account-dependent read/reply/page/handoff feature. Only recovery of
an exact uncertain effect retains its original account and provider key.
Added/withdrawn grants propagate through ordinary authorization refreshes; stale
snapshots and in-flight operations may settle without per-call grant reads.

## Agent tools

The existing `rally:sidekicks` presentation exposes three delegation tools.
Authoring and autonomous Sidekick runs use local names with the `sidekick_`
prefix; room presentations use the full wire names as their canonical names.

| Wire name | Strict model input | Behavior |
| --- | --- | --- |
| `sidekick_my_delegations_list` | `{}` | Lists the execution user's own grants, including safe stored labels after access loss. |
| `sidekick_delegates_list` | `{ sidekick: string }` | Resolves a visible UUID, Rally link or exact name and lists allowed users. |
| `sidekick_set_delegation` | `{ sidekickId: SidekickId, userId: UserId, allowed: boolean }` | Adds or withdraws the selected Organization user's delegation. |

All input properties are required and unknown fields are rejected. The actor is
the host's execution user; `userId` is the target. Direct user turns, scheduled
activations and background workers can use the tools. There is no human-message
classifier, self-only target restriction or special quotation/event consent
instruction. Changing someone else's grant requires the actor's existing
Sidekick viewer access and enrollment requires the target's active Organization
membership. Granting delegation changes no human reader or manager rights;
targets lacking Sidekick access remain unavailable for execution. Self-service
UI remains self-only, with no manager removal action.

List tools remain safe reads and return complete arrays. Mutation is a serial
`record_before_execute` write, returning `{ sidekickId, userId, allowed, changed }`.
The result names the target user. Loading tools and changing delegation starts
no run. Own withdrawal after access loss can use `my_delegations_list` routing;
other users are targeted within the current Organization.

The host durably prepares the target's observed generation under the effect ID,
then commits its mutation and immutable actor/target/intent receipt together.
A delayed old allow cannot undo a withdrawal. Completed replay and interrupted
recovery read the exact receipt and current generation without preparing a new
intent. A fresh delegation change may allow the target again. Unknown outcomes
are inspected rather than repeated with a fresh effect ID. Existing safe named
errors distinguish missing access, membership, stale actions and unavailable
allowed grants.

Every creation enrolls its creator in the creation transaction, using the
Sidekick ID as its stable action identity. This includes autonomous creation.
No `creatorConsent` marker or direct-user provenance lookup exists. Creation
replay and legacy backfill preserve existing withdrawals. Migration enrolls
missing creators and established previous task-account users without a
historical consent audit.

## Removed UI scope

The Sidekick list retains self allow/withdraw, Creator/You markers, availability
and the user's explanation sentence. The manager removal action and endpoint,
shared-history disclosure and creation opt-in screen are removed. New Sidekick
creates immediately on opening the route. There is no Account withdrawal screen.

## Attribution and shared state

Existing receipt checkpoints retain actual principal, connection, grant
generation, original selection and effect state for database debugging and exact
effect recovery. These fields are absent from normal app activity and model tool
output. Do not write credentials into them.

GitHub uses its existing mounted-credential lifecycle. Repository bootstrap and
typed publishing check the selected connection owner against the inventory's
delegation snapshot; local files remain available. No unmount protocol or
per-shell-command delegate scan is required.

The coordinating identity supplies existing personal preferences,
conversation admission and runtime identity for that run. Other
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

Tool checks cover explicit target user IDs, strict fields, direct/autonomous
availability, actor/target receipt binding, current Organization membership,
withdrawal and stale replay. Creation checks exercise the real autonomous
creation path. Inspect immediate creation and the remaining self-service UI in
real windows. Model usability checks cover discovery and changing a different
Organization user's grant without a direct-human consent requirement.

Run-prompt evaluations also cover an unresolved access refusal followed by an
actionable owning-conversation post, successful fallback without an error post,
partial completion, and refusal of the post itself without a false delivery
claim. Verify the guidance reaches activation runs, not just the authoring chat.

Inspect the actual Sidekick controls and ordinary activity in Electron and browser
windows. Exercise the same source with a schedule and a connector event, then
withdraw the successful delegate and observe the next operation's behavior.
When implementation lands, update the owning subsystem documents in that same
change; leave this PRD as the record of the proposal.
