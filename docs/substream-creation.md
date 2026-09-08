# Substream creation

Substreams are private conversations inside an existing work stream. Creation
freezes an initial context from its main conversation (`0`), shows that context
for review, then opens an idle child. It does not create another work stream,
copy running work, or send an instruction on the creator's behalf.

The platform currently uses summary-based context with
`google/gemini-2.5-flash-lite` and creator-only membership. These are shared
platform policies, not controls offered to the user. Membership is creator-only
at *creation*; a member adds and removes people afterwards, and any member can
archive the substream.

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
| `apps/desktop/src/renderer/screens/workstream.tsx` | Main/child navigation, the prepare-preview-confirm dialog, and the substream rename/archive dialogs. |
| `apps/desktop/src/renderer/components/workstream-sidebar.tsx` | Child rows, their attention markers and their right-click management menu. |
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

A child row carries this viewer's own unread and mention markers, and answers a
right-click with **Participants**, **Mark as unread**, **Rename** and **Archive
substream**. Those are the work stream's own row menu less Pin and Add to
project, which place a row in the workspace directory that a private child never
enters, and less Make private, which a substream has no other state to be in.
Participants is the addition: a work stream manages its roster from the sidebar
section below, and a substream has no section of its own. Right-click rather
than a visible control, because the row is a navigation target first.

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
- A private child's **shared** surfaces stop at its parent; its **person-
  addressed** effects do not. `directory_common` and `activity_event` never
  reach the workspace, so a substream is in no feed, digest, search result or
  workspace sidebar row. `mention_notification` and `participant_notification`
  do reach it, because each names one recipient who is already an active member
  of that child. A new effect kind must be classified deliberately: forwarding a
  surface effect leaks the child, and holding a person effect is the silence
  this subsystem shipped with.
- A person notification is gated on `projection_keys['user:<recipient>']`, so
  the recipient's `directory_user` from that same child is forwarded ahead of
  it. Nothing else advances that key for a private child, and forwarding the
  notification without it throws inside the child's delivery transaction —
  a poison retry, not a missing badge.
- A member's own parent row sums the children **that member** belongs to. A
  `user:` projection is per person, so a substream's unread and mention state
  reaches the parent row of the people in it and of nobody else. Parent
  participation is still never inferred from a child: `isParticipant` reads
  Main's projection alone.
- Archiving is `archived_at` on the child registry, not a fourth creation
  status. It removes the child from every member's sidebar and refuses its
  writes and socket tickets through the same path a work stream's own archive
  takes; it changes no membership and deletes nothing.
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

This subsystem owns child creation from main substream `0` of a work stream, and
the child's lifecycle after it: membership, rename, archive and discovery.
It does not create children from children, expose strategy selection, inherit
participants by default, create another email route, or auto-run the child.
Prepared context is immutable; normal new messages remain editable according to
the existing transcript rules. A canonical link addresses the work stream and
carries no substream, so **Copy work stream link** on a child row copies the
parent's link; a substream-addressed link is a change to
[workstream links](workstream-links.md), not to this subsystem.

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

A membership change refused by the parent is answered in prose the person in
the dialog can act on — a member has to be in the work stream before they can be
in one of its substreams, an archived substream keeps the roster it had, and a
substream keeps at least one participant. Unmapped, those reached the client as
an anonymous 500.

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
  readiness, membership and authority fences; archive removing a child from
  every member's sidebar while refusing its writes and tickets and restoring
  whole; rename converging through the child's own shared projection. Mutation
  proofs remove readiness from admission, drop the archive filter from
  discovery, stop reporting a child's archive through `authorizeViewer`, invert
  the child test in the title convergence, and unmap the refusal that a
  substream member must already be in the work stream.
- `apps/api/test-workers/substream-creation-runtime.test.ts` also covers the
  two person-addressed effects: a mention written in a substream reaching the
  parent's outbox behind the recipient's own viewer row while every shared
  effect stays, and a substream seating notifying under an identity the main
  room's seating of the same person cannot collide with. Mutation proofs stop
  forwarding person notifications, which silences both, and drop the substream
  from the participant identity scope, which restores the collision.
- Desktop socket, sidebar, draft, navigation and performance suites exercise
  cache isolation, recovery and operation correlation. Real Electron QA is
  additionally required for expanded/compact sidebar, preview, child navigation,
  themes, drag width and composer readiness.

Run the focused suites with the package-local Vitest paths per
[testing](testing.md), then full lint and typecheck. Runtime tests are not a
substitute for real-provider latency or window-level acceptance.

## Changelog

### 2026-09-08 — A substream can be joined, left alone, and heard from

**What changed:** Three things a substream could not do, and one it did wrongly.
A member is added or removed through a right-click menu on the child row, which
also renames the substream and archives it (`archived_at` on
`conversation_children`, migration v8). A `mention_notification` or
`participant_notification` produced inside a private child now leaves its
parent, carrying the recipient's `directory_user` ahead of it; being added to a
substream produces that notification at all, which it never did. A member's own
parent row now sums the private children that member is in, so a substream's
unread and mention state reaches the sidebar.

**Why:** The reported symptom was one person unable to reach a substream they
had been "added" to, and getting no notification for the mentions in it. Every
part of that was real and none of it was one bug. The membership API, its route
and its client all existed and worked; the only affordances that called them
sat in a header branch disabled by `grokBotMode` and a rail behind
`RIGHT_SIDEBAR_ENABLED = false`, so the one reachable control managed the parent
and adding somebody to a substream was impossible from the product. Separately,
`forwardsChildEffect` answered `substreamId === "0"` for every effect kind, so
everything a substream produced stopped at its parent — correct for the shared
surfaces it was written for, and wrong for the two kinds addressed to one named
person, who is by construction already a member. Nothing tested it. A substream,
meanwhile, could not be archived or left: removing the last member is refused,
so a substream created by accident was permanent.

**Considered and rejected:** Making the sidebar's people row follow the
selection — that reverses the 2026-09-05 decision that the shared chrome belongs
to the parent, and a row that silently changes which conversation it manages is
worse than no row. A fourth `conversation_children.status` for archived —
archiving is orthogonal to the creation state machine, and widening that CHECK
means rebuilding a table two others reference with `ON DELETE CASCADE`, which
per [the SQLite guide](durable-object-sqlite.md) runs with enforcement on and
takes their rows with it. Evicting sockets on archive — archiving is not a
revocation; every member could read it a moment ago and any of them can restore
it, and `revokeSocketAccess` should not grow a second trigger with different
rules. Forwarding the notification without the child's viewer row — the
`enqueueImmutable` gate then throws inside the child's delivery transaction,
which is a poison retry rather than a missing badge. A substream-addressed
canonical link — the link format has no substream segment, and inventing one
belongs to [workstream links](workstream-links.md).

**Consequences:** `forwardsChildEffect` is now a decision per effect *kind*, and
a new kind has to be classified in it; the invariant above says which way, and
getting it wrong either leaks a private child into workspace surfaces or
silences it. The parent aggregates a child's user projection but never its
common one, which is why `aggregatesChildUserProjection` exists beside
`aggregatesChildProjection` — the two questions had one answer only while the
answer was always no. This supersedes the "child projections do not aggregate
Main viewers" half of the 2026-09-05 entry below: the hazard it named was a
`user:<user>` version allocated and never forwarded, and the fix here is to
forward it rather than to stop allocating it. `children:<user>` remains a
separate local clock and still never advances the workspace notification clock.
A child's registry title converges from the child's own `directory_common`
through `onChildCommonProjection`, so the naming agent and a person renaming it
land in the same place and neither needs a second write.

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
