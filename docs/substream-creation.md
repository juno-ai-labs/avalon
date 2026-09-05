# Substream creation

Substreams are private conversations inside an existing work stream. Creation
freezes an initial context from its main conversation (`0`), shows that context
for review, then opens an idle child. It does not create another work stream,
copy running work, or send an instruction on the creator's behalf.

The platform currently uses summary-based context with
`google/gemini-2.5-flash-lite` and creator-only membership. These are shared
platform policies, not controls offered to the user.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/substream-creation.ts` | Versioned recipes, frozen captures, context parts and preview contracts. |
| `apps/api/src/services/substream-context.ts` | Static strategy, selector, transform and membership registries; platform policies; validation and hashes. |
| `apps/api/src/services/substream-context-summary.ts` | Structured Gemini summary through the shared inference gateway. |
| `apps/api/src/services/substream-creation-service.ts` | Authenticated prepare, confirm, cancel and participant coordination. |
| `apps/api/src/durable-objects/workstream-do.ts` | Creation receipts, ready-child directory and authoritative private membership. |
| `apps/api/src/durable-objects/workstream-transcript-storage.ts` | Frozen source export and immutable inert child seed. |
| `apps/api/src/durable-objects/substream-context-transfer.ts` | Frame-sized initial-context snapshot transfer. |
| `apps/api/src/services/substream-initial-context.ts` | Inert seed to model-context conversion. |
| `apps/desktop/src/renderer/screens/workstream.tsx` | Main/child navigation and prepare-preview-confirm dialog. |
| `apps/desktop/src/renderer/lib/use-workstream-socket.ts` | Authoritative baseline, initial-context assembly and readiness. |

## How it works

The middle sidebar puts **Main log** first, then indented child rows with creator
avatars and Tabler `border-corner-pill` connectors, and finally a dashed
**New substream** row with Tabler `plus`. It retains the existing sidebar colors,
row sizing, drag width and icon-only collapse; compact mode hides connectors and
labels. A creator absent from the available roster uses a conversation icon
rather than invented identity. A completed
main-feed message also offers **New substream** with that message as the cutoff.
Both enter the same creation flow; there is no context-strategy picker.

Every section of the center sidebar belongs to the parent work stream. Switching
substreams changes the conversation, not the sidebar's artifact inventory,
participant roster or management target. The parent socket remains retained on
direct child links. This shared chrome does not publish private child resources
or replace the child's creator-only conversation membership.

1. The renderer assigns one operation ID and freezes its title and optional
   message cutoff. Retrying the same attempt keeps that ID.
2. WorkstreamDO reserves one child ID and pins the resolved context recipe and
   membership initializer receipt. Reserved children are not discoverable or
   readable as conversations.
3. The source SubstreamAgent captures a completed main-conversation prefix in
   a synchronous storage transaction. Subsequent messages and edits do not
   change this operation's capture. An explicit unfinished cutoff is rejected.
4. The coordinator runs the pinned recipe outside the storage transaction.
   Completed parts are durably checkpointed. The summary adapter has no tools
   or fallback model and records requested/resolved model and token usage.
5. The creator reviews the selected context. The preview is read-only and does
   not return the unselected source capture. Cancellation prevents publication.
6. Confirmation claims the operation, provisions the same child, installs its
   immutable seed, mirrors its roster and marks it ready. Retrying confirmation
   resumes the same operation, not another child.
7. The parent's existing control socket publishes viewer-filtered ready
   children. The child's socket supplies its own transcript and initial context.
   The child is idle until the creator sends a new instruction.

### Extending initial context

A strategy plans a recipe; selectors identify source turns; transforms produce
validated summary or history parts. Built-ins include summary, all eligible
history, empty, last-N, range and summary-plus-recent-tail. Add a statically
registered, versioned plugin and change the one platform policy to select it.
Do not add conditionals to the coordinator or expose a user picker.

Each plugin validates its configuration. Persisted recipes retain plugin
versions and canonical hashes; retries validate the old recipe rather than
substituting the current deployment's policy. Keep old plugin versions available
while their preparations may still be retried. Membership is a separate
initializer receiving the creator and validated configuration; a future policy
that needs the main roster must obtain it from the parent's authority, not infer
it from the current viewer or copy a client-provided list.

“Full history” means eligible participant text, attribution, mentions and
attachment references. It is not a clone of the tool protocol: tool inputs and
results, thinking, run state, elicitation state and queued instructions are not
inherited. [Agent harness](agent-harness.md) owns how these inert records enter
the first model context without becoming executable historical work.

## Invariants

- Parent visibility **and** explicit child membership are required. Parent
  participants cannot enumerate or open someone else's private child; adding a
  child member does not grant parent or sibling access.
- One operation pins one capture, recipe, child ID and membership receipt.
  Replanning a retry would silently change the context the creator reviewed.
- Context installation writes no live transcript turn, pending input or run.
  Treating inherited text as a new instruction could execute old requests.
- Feed and model use the same installed selected parts. The complete source
  capture is preparation provenance, not a second hidden model-context source.
- Child membership versions fence signed admission and live commands. Removing
  a participant must invalidate an existing socket as well as future tickets.
  Re-adding them does not revive an old ticket: its version must match exactly.
- Child events do not overwrite main-conversation title, activity or roster.
  Child navigation must retain the parent shell while addressing all draft,
  transcript and pending-input state by the selected conversation.
- Execution RPC ports carry the external child address; the child database's
  local `substreams` root remains `0`. Run SQL references that local root while
  its saved workflow input retains the external address. Mixing those identities
  prevents the first instruction from activating.
- Child discovery uses a dedicated control-owned cache, fenced by authority
  generation and `privateChildrenWaterline`. This local `children:<user>` clock
  never advances the workspace notification `user:<user>` clock. Feed snapshots and list-page refreshes cannot
  erase it, even when control metadata arrives before the first feed snapshot.
  Archived readable parents retain child navigation even though they are not listable.
- A canonical reset is socket-only. Reintroducing REST boot recovery would
  create a second baseline authority and resurrect race-prone stale state.

## Boundary

This subsystem owns child creation from main substream `0` of a work stream.
It does not create children from children, expose strategy selection, inherit
participants by default, create another email route, or auto-run the child.
Prepared context is immutable; normal new messages remain editable according to
the existing transcript rules.

The parent owns child discovery and membership; the child owns its transcript,
seed and execution. [Workstream Durable Object](workstream-durable-object.md)
owns that authority hierarchy. [Conversation surfaces](conversation-surfaces.md)
owns shared rendering and lightboxes. Main-addressed managed-resource mutation
controls are not exposed inside child previews.

## Failure modes and limits

An inference failure leaves the operation and capture available for retry. A
completed part is reused rather than intentionally regenerated. No automatic
strategy/model fallback changes the reviewed meaning. A lost response can be
retried with the same operation ID; mismatched title or cutoff is a conflict.
Confirmation cannot be cancelled after its durable claim; it can be resumed.

Source access is checked before capture and again after preparation. Reserved,
failed or incompletely installed children never become readable. Membership
mirroring must complete before readiness is published, including deliveries
deferred for retry. The parent rechecks authority without an intervening await
at the prepared-context commit and confirmation transitions. The title is locked
while a request is pending; editing after failure clears the error and cancels
the prior attempt once. Cancellation accepts the endpoint's empty 204 response.

Context snapshot frames respect the existing realtime frame-byte limit, rather
than imposing a new product history cap. Missing or partial baseline data is
recovered from the canonical socket; the composer does not become ready on a
partially assembled child seed. Large histories still cost source export,
provider context and transfer time: no silent truncation is used to hide it.
The source capture currently crosses the source-agent and parent RPC boundaries
as one value. A history larger than the platform RPC payload allowance therefore
fails preparation visibly; supporting that case requires a durable paged capture
protocol, not a guessed truncation cap. The frame chunker solves only delivery
of the selected seed to a connected desktop and does not remove this RPC limit.

Creation targets remain **P50 <1 second and P90 <2 seconds**, including summary
preparation. The September 4 synthetic ten-call Gemini preflight measured
summary-only P50 1,861 ms and P90 2,221 ms; this is not a production percentile
or an end-to-end success claim, and already misses the combined target.
The chosen model was retained at the user's instruction. See
[performance tracing](performance-tracing.md) for preparation and confirmation
timers, operation correlation and system-wait measurement excluding only the
human review interval. Instrumented targets are not asserted achievements.

## Testing

- `apps/api/test/substream-context.test.ts`: plugin extensibility, policies,
  recipe validation, frozen selection, checkpoint provenance and hashes.
- Summary and initial-context unit suites: pinned inference routing, inert
  model rendering and provenance.
- `apps/api/test/substream-context-storage.test.ts`: real SQLite schema,
  completed-prefix capture, frozen retry, excluded execution blocks and idle
  immutable installation. Mutation proof removes the cutoff turn.
- `apps/api/test-workers/substream-creation-runtime.test.ts`: real workerd
  parent/source/child prepare-confirm with only provider HTTP doubled;
  duplicate confirmation, creator-only access, cancellation and no initial run.
  Mutation proof skips target seed installation. The first-instruction test
  reaches a provider double through the real loop, checks the frozen seed and
  new child instruction, and excludes a later conflicting Main message.
- `apps/api/test-workers/conversation-parent-contract.test.ts`: private child
  readiness, membership and authority fences. Mutation proof removes readiness
  from admission.
- Desktop socket, sidebar, draft, navigation and performance suites exercise
  cache isolation, recovery and operation correlation. Real Electron QA is
  additionally required for expanded/compact sidebar, preview, child navigation,
  themes, drag width and composer readiness.

Run the focused suites with the package-local Vitest paths per
[testing](testing.md), then full lint and typecheck. Runtime tests are not a
substitute for real-provider latency or window-level acceptance.

## Changelog

### 2026-09-05 — Review closes authority, delivery and ordering gaps

Child admission now requires current parent access as well as exact-version
child membership. Preparation commits and confirmation transitions check the
parent's current authority, and readiness refuses any undelivered membership
effect. Earlier service-level checks alone left gaps across awaited RPCs.
Child-only projections are receipted without aggregating a nonexistent Main
viewer; automation parents keep their local aggregation callbacks. Discovery
has its own control clock because consuming unpublished workspace viewer
versions could strand notifications. The creation dialog locks pending inputs,
clears failed-attempt state on edit and handles cancellation's empty response;
inviters update the selected child's roster cache on successful admission.
Regression tests deliberately remove each backend fix to prove these failures.

### 2026-09-05 — Separate parent sidebar context from child conversation context

Sidebar data, previews and management now use the retained parent snapshot. The
previous selected-feed wiring made shared chrome change when a child was selected
and could apply parent API responses to a child cache. Keep the two contexts
explicit; selecting a child must not change the scope of sidebar actions.

### 2026-09-05 — Show the relationship between Main and its substreams

The center sidebar now groups indented child rows beneath Main, with the create
action last. Corner connectors and creator avatars make the hierarchy visible
without adopting the reference mockup's separate palette or oversized cards.
Collapsed mode keeps the same navigable icon rail and the resize logic is
unchanged; this presentation must not change child discovery or membership.
Connectors use the sidebar-border token, not muted text: Grok Bot's packaged
weak-border palette uses approximately 10% foreground opacity, so the hierarchy
stays subordinate to the conversation labels in both appearances.

### 2026-09-04 — Private substreams with replaceable starting context

Added a single parent-owned creation flow with versioned strategy/selector/
transform hooks, independently pinned creator-only membership and a Gemini
summary policy. The requirement is to evolve how every substream starts without
building multiple creation implementations or offering a strategy picker.
Persisted capture and selected seed were chosen over copying live transcript
and run state so retries keep the reviewed context and inherited instructions
cannot execute. The parent remains the discovery and membership authority;
creating another work stream or relying on broad parent membership was rejected
because either would break private child semantics. Socket-only baseline reset
and end-to-end timing prevent REST recovery races and misleading latency claims.
Real-window acceptance exposed a local-root/external-address FK mismatch on the
first instruction and a Main snapshot that erased control-owned child discovery;
both now have regression coverage. Private directory suppression is specific to
WorkstreamDO: automation parents still consume child status locally even when
they do not forward the original child projection. Preview and feed share one
read-only renderer so history strategies display their actual selected text,
not just a message count.
