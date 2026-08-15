# User-flow architecture stress studies

> Companion to
> [`prd.md`](prd.md). These studies exercise the proposed `WorkspaceDO`,
> `WorkstreamDO`, `substreams`, `parts`, and generic agent-run host through
> Avalon product behavior. They are design probes, not an implementation plan
> or a second source of requirements.

## How to read these studies

Each study is deliberately labelled:

- **Showcase** studies describe behavior the proposed architecture should make
  simpler, safer, or cheaper than a shared relational authority.
- **Break attempt** studies put pressure on an ownership boundary or invariant.
  Passing one does not necessarily mean the product should support the
  scenario; a clear refusal without corruption or disclosure may be the right
  result.

The studies use concrete scale and timing to expose hidden state transitions.
They assume model time to first token is normally one to five seconds, ordinary
tools usually settle in seconds, Terminal p95 is under one minute, and a
Terminal tail may run for three to five minutes. A full agent loop normally
lasts two to thirty minutes and can rarely exceed two hours for coding/research;
that lifetime is distinct from any one model turn or tool call. Illustrative
workspace sizes are stress inputs, not launch commitments.

Every failure oracle is intentionally user-observable or operator-verifiable.
"An invariant should hold" is insufficient if nobody can tell whether it did.

## Personas

| Persona | Context |
| --- | --- |
| Maya | Workspace owner responsible for access, retention, and a large team's sidebar. |
| Priya | EU workspace administrator responsible for residency and audit commitments. |
| Mateo | Engineer collaborating with Avalon from a laptop and an intermittently connected second device. |
| Samantha | Project lead who uses the shared main feed, private chats, and forks to explore alternatives. |
| Ren | Operations engineer investigating stuck runs and migrations without routine access to customer content. |
| Elena | Automation owner connecting Slack, Google, Linear, Notion, email, and scheduled jobs. |
| Avalon | The inherent work-stream agent, including the sub-agents it starts through recorded tool calls. |

## Showcase studies

### S01 — A shared investigation remains one ordered conversation

**Mode:** Showcase

**Persona:** Samantha leads an incident investigation with Mateo and Avalon.

**Preconditions:** Both people are participants in one work stream. A third
workspace member may view it but has never posted or been added.

**Flow:**

1. Samantha posts a diagnosis with a PDF attachment from one client.
2. Avalon starts a turn and streams an explanation after a typical one-to-five
   second time to first token.
3. Mateo queues a non-urgent correction while viewing the same transcript.
4. The third member opens and closes the work stream without posting.
5. Both participants reload and inspect the transcript and People rail.

**Expected user-visible behavior:** Everyone sees one stable order for the
attachment, both human turns, Avalon's bounded streaming checkpoints, and the
terminal results. The first turn completes, then Mateo's admitted follow-up is
handled without having interrupted it. Optimistic messages reconcile in place
rather than appearing twice. Samantha and Mateo remain participants; the viewer
does not become one.

**Architecture stress:** The `WorkstreamDO` allocates the one sequence across
main-feed `parts`, groups each logical turn by `turn_id`, and projects a
provider-valid message array without joining independent message and tool
histories. Mateo's arrival and later model admission are separately durable.
Presence remains ephemeral and outside participant state.

**Failure oracle:** The architecture fails this study if two clients observe
different committed orders, an assistant response is duplicated on reload, a
queued-only message interrupts the first answer, a viewer becomes a participant,
or the next model request contains a different order from the people-visible
transcript without an explicit projection rule.

**Unresolved pressure:** Define whether edits and redactions append replacement
parts or mutate existing content, and how both operations affect model fences.

### S02 — Unread and mentions follow the main-feed waterline

**Mode:** Showcase

**Persona:** Mateo reads a busy work stream on a laptop and later opens Avalon
on a second device.

**Preconditions:** Mateo has seen main-feed attention ordinal 100. A hidden
sub-agent appends parts at arrival sequences 401–408 without advancing attention;
Samantha posts at attention ordinal 101, mentions Mateo at attention ordinal
102, and a private chat owned by Samantha appends without advancing attention.

**Flow:**

1. Mateo's closed laptop receives no live events.
2. His second device loads the workspace sidebar from the `WorkspaceDO`.
3. He opens the work stream, reads through the mention, and the device advances
   his seen attention ordinal to 102.
4. The older laptop reconnects and submits its stale "seen through 100" update.
5. Mateo pins the work stream and reorders it among two other pins.

**Expected user-visible behavior:** The sidebar shows unread main-feed activity
and the mention, but never counts hidden sub-agent or Samantha's private-chat
activity. Reading through attention ordinal 102 clears both signals. The stale
device cannot make
the work stream unread again. Pin order converges on both devices.

**Architecture stress:** Per-person sidebar state is a monotonic projection of
main-feed attention, not every value in the work stream's global sequence.
Waterline writes require max semantics or an equivalent monotonic comparison;
person-scoped pin membership and dense order are owned by the parent.

**Failure oracle:** The study fails if hidden activity lights the sidebar, the
mention clears before Mateo sees its part, a stale device moves his waterline
backward, or pin order depends on which child responds first.

**Unresolved pressure:** Specify whether the product displays a count, a boolean,
or a capped count, and which people-visible part kinds advance the attention
ordinal.

### S03 — A disconnected client rejoins an active stream exactly once

**Mode:** Showcase

**Persona:** Mateo moves between networks while Avalon is producing a long
answer.

**Preconditions:** His client has committed through sequence 420. The next
assistant turn has two durable mutable-tail checkpoints, a tool call, and a
result.

**Flow:**

1. Mateo loses connectivity after seeing some uncommitted token deltas.
2. The admitted run continues without his socket, mutates bounded active-output
   chunks, and commits semantic tool boundaries immediately.
3. The `WorkstreamDO` is evicted once while the run host and provider stream
   survive.
4. Mateo reconnects with cursor 420 after the run completes.
5. The client replays committed parts and reconciles its transient text.

**Expected user-visible behavior:** Mateo may briefly rewind at most one
configured provisional checkpoint interval before executor replay restores it.
Reconnect produces one complete assistant turn with one tool lifecycle and one
terminal state. No acknowledged human input is lost, and the transcript does
not gain a second synthetic final answer.

**Architecture stress:** Active checkpoints mutate one bounded operational tail,
while finalized `parts` are immutable and token deltas remain transport. Resume
uses the work-stream sequence and active revision rather than an independently
assembled message response. Run identity and producing attempt support
reconciliation after host loss.

**Failure oracle:** The study fails if replay duplicates text, omits a committed
tool result, loses an acknowledged message, or requires the client to guess
which of two final answers is canonical.

**Unresolved pressure:** Set the retention and compaction rules for realtime
resume cursors so a very old offline client receives an explicit snapshot reset
instead of a silent gap.

### S04 — A private evidence chat cannot become shared history

**Mode:** Showcase

**Persona:** Samantha privately asks Avalon to critique a sensitive draft while
the rest of the team continues in the main feed.

**Preconditions:** The chat is `kind=chat`, `audience=owner`, document-inherits
the main feed, and has `tool_policy=read_only`.

**Flow:**

1. Samantha starts the chat from the current work stream.
2. The chat receives a labelled transcript document describing main-feed
   authorship, attachments, and completed tool activity.
3. Samantha attaches a private note and asks for criticism.
4. Another participant guesses the substream ID and requests its transcript.
5. A digest, workspace summary, search job, and main-feed compaction run later.

**Expected user-visible behavior:** Samantha sees a coherent answer grounded in
the main conversation. The model does not claim that it performed the main
agent's tool calls. The guessed read is denied, the private note is absent from
the shared surfaces, and no other participant receives an unread signal.

**Architecture stress:** Document inheritance is evidence, not literal model
history. `audience=owner` is checked by storage reads, projection, referenced
content hydration, summaries, exports, notifications, and diagnostics.

**Failure oracle:** Any private phrase in another participant's model request,
sidebar, digest, search result, log, or export is a failure. So is a model array
that presents a main-feed tool result as a call made inside the chat.

**Unresolved pressure:** Decide whether an authorized workspace compliance
export may include owner-only chats and, if so, make that authority visibly
different from an ordinary administrator export.

### S05 — A fork preserves the exact completed past

**Mode:** Showcase

**Persona:** Samantha explores a second implementation after Avalon has already
called a tool in the main feed.

**Preconditions:** The chosen fork fence follows a completed assistant tool call
and its result. The main feed continues after the fork is created.

**Flow:**

1. Samantha creates a human fork at the completed turn.
2. The main feed receives a new constraint from Mateo.
3. Samantha asks the fork to continue the original approach.
4. She closes and later reopens the fork.

**Expected user-visible behavior:** The fork sees literal model-visible turns
through its immutable fence, including the paired historical tool result, but
not Mateo's later constraint. Its turns neither alter nor mark the main feed
unread. Closing makes it read-only without deleting it.

**Architecture stress:** An immutable `inherit_fence_seq` and one work-stream
sequence provide causal history without timestamps or a copied transcript.
Projection refuses a fence inside a turn or between a call and result.

**Failure oracle:** The study fails if the fork changes when the main feed
advances, omits the tool result, re-executes the historical tool, or moves main
attention before a result is deliberately posted there.

**Unresolved pressure:** There is no defined product operation for publishing a
useful fork result back into the main feed; it needs an explicit authored part
rather than an implicit merge.

### S06 — Sub-agents branch without becoming sidebar conversations

**Mode:** Showcase

**Persona:** Avalon delegates independent research and one context-sensitive
review from the main feed.

**Preconditions:** Three fresh child agents inherit no transcript. One forked
child inherits through a completed fence. All are within depth four.

**Flow:**

1. The parent appends four pending spawn tool calls with stable idempotency
   keys.
2. Each child runs in an `agent` substream under an explicit tool policy and
   budget.
3. One run host fails after the child completes but before the result reaches
   the parent.
4. The spawn call is retried.
5. The children settle, and the parent receives one result for each call.

**Expected user-visible behavior:** Participants see progress associated with
the parent operation and eventually four results, not four top-level work
streams. Hidden child parts do not change last activity or unread state before
their results land. The retry reuses the existing child and result.

**Architecture stress:** A child substream is created as part of a durable tool
lifecycle. `origin_part_id`, `return_mode=tool_result`, and call-level
idempotency bind exactly one child and one answer to the parent.

**Failure oracle:** Duplicate children, duplicate tool results, ambient main
history in a fresh child, inherited authority not allowed by the child's tool
policy, or hidden child token traffic reaching the `WorkspaceDO` all fail the
study.

**Unresolved pressure:** Depth alone does not bound breadth. A separate total
child count, concurrency, cost, and aggregate-output budget is still required.

### S07 — A steering correction during time to first token interrupts cleanly

**Mode:** Showcase

**Persona:** Mateo immediately corrects a mistaken instruction.

**Preconditions:** Avalon has admitted a run and projected a completed fence,
but the provider has not produced its first token within the usual one-to-five
second interval. The executing Workflow step holds an authenticated internal
`run-control` WebSocket to the hibernating `WorkstreamDO` beside its provider
`AbortController`.

**Flow:**

1. Mateo sends the correction with `Steer` two seconds after the first
   instruction.
2. The `WorkstreamDO` atomically commits the message and steering request, then
   advances the substream input revision.
3. The owner sends the committed revision over `run-control`; the executing
   step aborts the provider request when supported.
4. The interrupted attempt records a terminal outcome.
5. A new turn projects through the correction and resumes.

**Expected user-visible behavior:** Mateo sees his correction acknowledged
immediately and a brief `Interrupting` state. Avalon answers the corrected
request. No stale tool begins, and no phantom empty assistant message remains.

**Architecture stress:** Admission fences model input; revision checks happen
before inference and every following step. The internal socket is a Cloudflare-
native low-latency carrier, while durable revision fencing remains correct if
the socket is lost. Interruption is not inferred from model output or client
socket timing.

**Failure oracle:** A tool or user-visible conclusion based solely on the stale
instruction, loss of the correction, or two simultaneously authoritative runs
for the substream fails the study.

**Unresolved pressure:** Define the brief UI coalescing window for several
steering corrections arriving before restart without weakening their durable
arrival order.

### S08 — A steering correction during an ordinary tool waits only as needed

**Mode:** Showcase

**Persona:** Samantha corrects a filter while Avalon performs a read that
normally takes several seconds.

**Preconditions:** A recorded read-only tool call is running and supports safe
cancellation, or can settle without an external mutation.

**Flow:**

1. The tool begins against revision 12.
2. Samantha sends a new filter with `Steer` at revision 13.
3. The owner records the message and steering request before signalling
   interruption.
4. The adapter cancels safely or returns its bounded result.
5. The old turn closes with a paired tool result and terminal part; the next
   turn includes the new filter.
6. Repeat with two parallel tool results that arrive in the opposite order from
   their provider call positions.

**Expected user-visible behavior:** The UI briefly shows `Interrupting`, then
resumes within the ordinary seconds-long tool window. Samantha does not have to
resend the correction and never sees a permanently spinning tool card.

**Architecture stress:** Revision checks surround tool execution, but the
conversation still satisfies the model requirement that every emitted tool
call has exactly one result before the turn fence advances. Arrival sequence
records the correction before the late result, while logical turn and part order
project the complete older tool turn before the admitted steering batch.

**Failure oracle:** Cancellation that leaves an unanswered call, a projected
`tool_call -> user -> tool_result` order, parallel results reordered against
their call positions, a result attached to the restarted turn, or a second tool
invocation without an explicit new call fails the study.

**Unresolved pressure:** Each tool adapter needs a declared cancellation class;
"read" alone does not prove cancellation is cheap or side-effect free.

### S09 — A Terminal tail does not make a steering correction disappear

**Mode:** Showcase

**Persona:** Mateo changes a requirement while Avalon runs a command.

**Preconditions:** Exercise both a typical 40-second Terminal operation and a
four-minute tail. The command cannot always be terminated safely.

**Flow:**

1. Avalon records the Terminal call and begins execution.
2. Mateo sends a correction with `Steer` after 15 seconds.
3. The `WorkstreamDO` commits it with the steering request, advances the
   revision, and signals the host.
4. The adapter either cancels safely or allows the command to settle.
5. The host records `completed`, `failed`, `cancelled`, `budget`, or
   `ambiguous`, then resumes only if safe.

**Expected user-visible behavior:** Mateo sees `Interrupting` or `Waiting for
the current tool`, with elapsed state that remains credible through the
three-to-five-minute tail. His message is visibly accepted. Avalon never claims
to be considering it while continuing stale tool work invisibly.

**Architecture stress:** The work-stream owner remains the stream authority
while the generic host owns durable execution. The parent workspace receives no
token or command-output stream. Multiple steering corrections coalesce under
one monotonic input revision without losing their individual parts.

**Failure oracle:** Losing or delaying acknowledgement of Mateo's message until
the command ends, starting another state-mutating tool meanwhile, or blindly
repeating an uncertain command fails the study.

**Unresolved pressure:** Define the maximum time the UI waits for an unsafe-to-
cancel command and whether a participant can explicitly abandon the run while
the provider resource continues toward cleanup.

### S10 — An uncertain external write asks instead of guessing

**Mode:** Showcase

**Persona:** Elena asks Avalon to create a Linear issue, and the provider times
out after receiving the request.

**Preconditions:** A pending write receipt exists with a causal
`effect_intent_id` allocated before execution and stable across retries of this
one action. The provider response is lost, and provider-side lookup cannot
immediately prove the outcome.

**Flow:**

1. Avalon records the call before execution.
2. The provider connection times out after the request leaves Avalon.
3. The tool part becomes `ambiguous`; the run terminates as `needs_input`.
4. Elena adds a message asking Avalon to check rather than retry.
5. A read reconciliation either finds the original issue or proves no issue was
   created before a deliberate retry.

**Expected user-visible behavior:** The transcript says the outcome is unknown
and gives Elena a safe next action. The sidebar shows `needs_input`, not generic
failure or false completion. Recovery finds one issue or creates one after proof
of absence.

**Architecture stress:** Tool status is the one deliberately mutable portion of
an otherwise append-oriented record. The causal effect intent spans attempts and
explicit continuation of this action—but not a later equal request—and
interruption cannot transform uncertainty into permission to repeat.

**Failure oracle:** Two issues, an unqualified success claim, an automatic
retry while status is ambiguous, or a completed turn without a paired result
fails the study.

**Unresolved pressure:** Provider-specific reconciliation may outlive a user
session; define who owns its retry schedule and how long ambiguity remains
visible.

### S11 — Shared provider ingress reaches one regional owner once

**Mode:** Showcase

**Persona:** Elena uses a Slack Agent thread and the permanent inbound email
address for a work stream.

**Preconditions:** The provider account route is held in the minimal Global
directory. The owning workspace and work stream are EU-resident. Both
deliveries have stable provider IDs.

**Flow:**

1. Slack sends a root mention and a threaded follow-up while Resend delivers an
   email to the work-stream address.
2. The shared ingress verifies each provider envelope and resolves only the
   opaque regional route.
3. The EU regional plane stores and normalizes the bodies.
4. Providers replay every delivery.
5. The client opens the work stream and observes the committed order.

**Expected user-visible behavior:** Each source appears once with clear
authorship. A follow-up reuses the existing work stream. Replays produce no
duplicate message, resource, notification, or agent run.

**Architecture stress:** Global holds a routing envelope, never EU bodies or
titles. The regional `WorkstreamDO` is the final ordering and idempotency
authority even when two ingress paths arrive concurrently.

**Failure oracle:** EU content at rest in Global, different work streams for a
root and follow-up, duplicate parts after replay, or ordering based only on
provider timestamps fails the study.

**Unresolved pressure:** Define whether a provider event automatically starts a
run, only appends a part, or follows a connector-specific policy, and record
that decision alongside the ingress part.

### S12 — A planned automation work stream accepts pre-run collaboration

**Mode:** Showcase

**Persona:** Elena opens next Monday's scheduled automation run and gives Avalon
extra instructions before it begins.

**Preconditions:** The automation occurrence already owns one scheduled work
stream. Its schedule and subscription remain regional query data as needed.

**Flow:**

1. Elena opens the planned work stream and posts pre-run context.
2. A repeated scheduler alarm attempts to start the same occurrence twice.
3. The target adapter admits exactly one run against the existing
   `WorkstreamDO`.
4. The projected message array includes Elena's committed instruction.
5. Completion creates the following occurrence without changing this history.

**Expected user-visible behavior:** There is one planned work stream, then one
running work stream with the same identity, then one completed result. Elena's
message is visible before the run and affects it. The duplicate alarm creates
nothing visible.

**Architecture stress:** Workspace/work-stream product state belongs to the DOs
while scheduling may remain in regional D1. Stable occurrence idempotency and
the generic run host bridge those owners without making the Workflow the
conversation authority.

**Failure oracle:** Two run work streams, two agent turns, missing pre-run
context, or a schedule cursor advancing before durable admission fails the
study.

**Unresolved pressure:** Specify the transaction boundary between regional
scheduler state and work-stream admission when either side is temporarily
unavailable.

### S13 — A scoped export reflects the conversation model

**Mode:** Showcase

**Persona:** Samantha exports one work stream she is authorized to read.

**Preconditions:** The work stream contains the main feed, Samantha's private
chat, another participant's private chat, a closed fork, hidden agent
substreams, attachments in regional R2, compactions, and tool receipts.

**Flow:**

1. Samantha requests a personal export at a declared fence.
2. Export traverses local `substreams` and `parts` in the one object, then
   hydrates only authorized regional references.
3. One R2 object is temporarily unavailable, so its bounded summary and a clear
   missing-payload marker are returned.
4. Samantha downloads and verifies the manifest.

**Expected user-visible behavior:** The export has deterministic ordering and
includes the main feed, Samantha's private chat, readable forks, and relevant
receipts. It excludes the other participant's private chat and secret-bearing
internal inputs. Missing bytes are disclosed rather than silently omitted.

**Architecture stress:** One sequence makes causal export possible across
substreams. Audience checks are re-evaluated for the exporter, and
`content_ref` is not treated as authority. Hashes and fallback summaries make
partial hydration auditable.

**Failure oracle:** Another owner's private content, a secret or signed URL,
non-deterministic order, an unreported missing object, or a part beyond the
declared export fence fails the study.

**Unresolved pressure:** Define export snapshot lifetime and whether a user may
continue writing while a large export hydrates external content.

### S14 — Work-stream deletion cannot be undone by a late projection

**Mode:** Showcase

**Persona:** Maya deletes a completed work stream under its retention policy.

**Preconditions:** The child has a pending sidebar-summary retry and referenced
attachments. No active external write exists.

**Flow:**

1. Maya confirms deletion.
2. The parent records a deletion tombstone and removes the sidebar entry.
3. The child closes access, enumerates substreams, receipts, and referenced
   payloads, and completes cleanup according to policy.
4. The delayed pre-deletion sidebar event reaches the parent.
5. An old client tries to reconnect by work-stream cursor.

**Expected user-visible behavior:** The card disappears and never returns. Old
links and cursors produce a stable deleted/not-found result rather than a blank
work stream. No attachment remains retrievable through an old reference.

**Architecture stress:** Parent tombstones dominate lower projection versions,
and deletion traverses the object-owned graph. A child ID or R2 reference is not
an access token.

**Failure oracle:** Sidebar resurrection, a reconnect that recreates the
object, readable residual content after the deletion contract completes, or a
second authority retaining current content fails the study.

**Unresolved pressure:** Define grace periods, legal holds, recovery windows,
and whether deletion means cryptographic inaccessibility before physical purge.

### S15 — An EU work stream never needs a Global content path

**Mode:** Showcase

**Persona:** Priya creates an EU workspace, connects Notion, and runs a work
stream using Terminal and a model provider approved for that region.

**Preconditions:** The EU hostname, jurisdictional DO namespaces, regional R2,
D1, Queue/Workflow configuration, logs, secrets, and subprocessors have passed
deployment verification.

**Flow:**

1. Priya signs in through the thin identity plane and activates the EU
   workspace.
2. The EU Worker resolves its `WorkspaceDO` and creates a same-jurisdiction
   `WorkstreamDO`.
3. A Notion ingress delivery routes through an opaque Global directory entry.
4. The regional generic host performs inference and Terminal execution.
5. Priya requests an audit of routing, storage, and processing locations.

**Expected user-visible behavior:** The product behaves like Global without a
fallback banner or reduced consistency. The audit shows only the enumerated
opaque locator in Global and shows content-bearing processing in approved EU
services.

**Architecture stress:** Region is selected before object identity is resolved;
an `eu` string in a name is not relied on. Workflow inputs carry region and
opaque identifiers, not prompts or member metadata.

**Failure oracle:** Any title, description, member ID, prompt, output,
credential, provider body, or content-bearing log in Global fails the study, as
does silent Global fallback for an unavailable EU dependency.

**Unresolved pressure:** Cloudflare and every external subprocessor need an
explicit, periodically reverified statement of where background execution,
subrequests, support access, and logs occur.

### S16 — Dormant work streams migrate only when touched

**Mode:** Showcase

**Persona:** Ren migrates a workspace with 250,000 historical work streams, of
which 400 are active in a typical week.

**Preconditions:** D1 is authoritative. Empty regional object namespaces,
migration manifests, leases, parity checks, and object route states are
deployed.

**Flow:**

1. Shadow import verifies selected fixtures without executing tools or sending
   notifications.
2. The 400 active work streams migrate on access or in bounded canary batches.
3. A provider delivery touches one dormant work stream and claims its migration
   lease before appending.
4. A pre-cutover canary fails parity and rolls back to D1.
5. A post-cutover repair remains forward-only in its `WorkstreamDO`.

**Expected user-visible behavior:** Active work remains available with at most
an explicit retryable transition. Dormant history incurs no wake-up merely
because a deployment occurred. Failed shadow work produces no transcript,
notification, external tool call, or duplicate card.

**Architecture stress:** Migration is routed per work stream, uses a snapshot
plus bounded tail and a final write fence, and does not enumerate or instantiate
the fleet. Authority is a route state, not a caller choice.

**Failure oracle:** Eager creation of all 250,000 objects, shadow side effects,
accepted writes in both D1 and a child, or post-cutover fallback to stale D1
fails the study.

**Unresolved pressure:** Quantify lease duration, tail bounds, regional
concurrency, and the user-facing response when on-demand migration exceeds an
interactive request budget.

### S17 — Non-work-stream loops share execution without sharing domain state

**Mode:** Showcase

**Persona:** Elena receives a digest while Maya opens Suggested work and a
meeting owner runs a Control Tower refresh.

**Preconditions:** Digest generation, work-opportunity admission/ranking,
meeting summarization, work-stream naming/description, and automation compiling
each have a target adapter for the generic agent-run host.

**Flow:**

1. A regional scheduler admits a digest with a frozen activity window.
2. Suggested work ranks a bounded set of candidates.
3. Control Tower coalesces repeated refresh demand into one current meeting
   summary.
4. A work-stream description refresh runs against a committed projection.
5. One host retry occurs in every domain.

**Expected user-visible behavior:** Elena receives one digest, Maya sees one
stable ranked list, the meeting shows the newest briefing, and the sidebar
description changes once. None of these loops appears as an accidental
participant conversation unless the owning product deliberately presents one.

**Architecture stress:** The host shares durable retry, model/tool execution,
budgets, receipts, and interruption mechanics. Each adapter owns input
projection, compare-and-set semantics, output persistence, visibility, and
terminal state.

**Failure oracle:** A universal transcript schema imposed on a ranking job, raw
domain payload in Workflow inputs, duplicate delivery after retry, or one
domain reading or mutating another domain's owner fails the study.

**Unresolved pressure:** Define a conformance suite that every target adapter
must pass, including idempotent append/settle behavior, authority derivation,
payload opacity, revision conflicts, and cancellation.

### S18 — Teammates queue follow-ups and then steer one active turn

**Mode:** Showcase

**Persona:** Mateo and Samantha are collaborating while Avalon streams an
answer whose time to first token was two seconds.

**Preconditions:** One main-feed agent turn is active. The composer offers
explicit `Queue` and `Steer` actions, and neither client has privileged ordering
authority over the other.

**Flow:**

1. Mateo queues “After this, compare the two error logs.”
2. Samantha queues “Also list the owners of the affected services.”
3. Both messages commit, appear individually as `Queued`, and survive Mateo
   disconnecting.
4. Samantha sends “Steer: stop recommending the rollout; production is already
   frozen.”
5. The owner commits the message and steering request, advances the input
   revision, and stops the old turn at its earliest safe boundary.
6. One admission cut selects Mateo's message, Samantha's first message, and the
   steering correction in arrival order. A later queued message remains pending.
7. Mateo reconnects while the admitted batch is running.

**Expected user-visible behavior:** Everyone sees which messages are queued,
which one triggered steering, and which batch Avalon is considering. The old
answer stops without an invalid tool turn. The next answer addresses all three
admitted messages with correct authorship; the later message remains visibly
queued and is handled after that answer completes.

**Architecture stress:** Arrival order, steering revision, and model admission
are separate durable facts. One input-admission record maps several individual
people-visible messages into one logical user turn without making a Workflow per
message or keeping queue state only in a client.

**Failure oracle:** The study fails if queueing alone interrupts the answer, the
steering message jumps over earlier queued context, a reconnect loses or
duplicates a message, later input leaks across the admission cut, or the model
cannot distinguish Mateo's words from Samantha's.

**Unresolved pressure:** Set maximum batch messages and bytes, and decide whether
the UI permits a participant to reorder only their own queued messages without
changing the global arrival audit.

### S19 — Messages remain safe while compaction summarizes an older prefix

**Mode:** Showcase

**Persona:** Mateo and Samantha keep working in a long incident conversation
while Avalon prepares model context.

**Preconditions:** The main substream exceeds its prompt threshold. The owner has
atomically appended `compaction_start` for completed turn fence `C=800`, and the
summary model call takes twelve seconds. The active run shows `Preparing
context`.

**Flow:**

1. The compactor loads the authorized projection through `C` with its input hash
   and revision vector.
2. Mateo queues “Check the European error rate too” while compaction is running.
3. Samantha sends “Steer: customer traffic is now disabled” before the summary
   returns.
4. Both messages commit and stream to clients immediately; the steering revision
   supersedes the waiting run but does not cancel the still-valid prefix summary.
5. `compaction_complete` commits after validating the original prefix and
   revisions.
6. The owner admits Mateo's queued input and Samantha's steering input in one
   ordered batch and starts the replacement run.
7. A reconnect projects the summary through `C`, followed by that admitted raw
   user turn and later assistant output.

**Expected user-visible behavior:** Neither send waits twelve seconds for
compaction. Both users see durable queue or steering state immediately. Avalon
does not answer from stale pre-steering input, yet it reuses the valid compacted
prefix. Reload shows every individual message once and the same resulting
conversation.

**Architecture stress:** The compaction source fence, message arrival sequence,
steering revision, input-admission cut, and completion sequence are different
facts. Benign tail growth must preserve the summary while projection emits the
tail after its waterline.

**Failure oracle:** A blocked send, a message absorbed into a summary that never
saw it, omission or duplication after reload, cancellation of useful compaction
for ordinary tail growth, or use of the summary before its completion breaks the
design.

**Unresolved pressure:** Set the `Preparing context` budget and decide how much
progress the UI exposes when repeated high-volume input keeps the raw tail near
the next compaction threshold.

### S20 — Sidebar and home share one work-stream-of-interest projection

**Mode:** Showcase

**Persona:** Mateo moves between the workspace sidebar and home screen while
Samantha and Avalon update several work streams.

**Preconditions:** The workspace has 20,000 work streams. One is running, one is
completed, one failed, Mateo is newly mentioned in a fourth, and he has pinned a
quiet fifth. The current page spans Today and Yesterday in Mateo's locale.

**Flow:**

1. Each affected `WorkstreamDO` commits its source fact and emits a complete
   common or Mateo-specific replacement through its coalesced outbox.
2. The `WorkspaceDO` applies the replacements in a different order from their
   commits and derives collection membership after each apply.
3. Mateo loads the sidebar's Work Streams, In Progress, and Completed sections.
4. He opens home, which requests work streams of interest at the same workspace
   snapshot revision.
5. He reads through the mention, then an older device submits a stale waterline.

**Expected user-visible behavior:** One card body supplies every section. The
running, completed, and failed streams appear only in their correct lifecycle
collections; recency labels use Mateo's locale. Home and sidebar agree that the
mentioned and pinned streams are interesting without duplicates. Reading clears
the mention and unread signals everywhere, and the stale device cannot restore
them.

**Architecture stress:** Common card facts, sparse personal overlays, parent-
owned pins, derived indexed collections, independent projection-key versions,
one item dictionary, and a shared workspace cursor all participate without child
fan-out or one personal row per member.

**Failure oracle:** A title differs between home and sidebar, Error appears as
Completed, a date label is stored in the child's timezone, a common status update
fans out to every member, the mention patch is dropped behind a common version,
or one page wakes children.

**Unresolved pressure:** Set the exact interest precedence, count caps, active-
family membership for `needs_input`, and whether the initial product exposes an
Error heading.

### S21 — Unclaimed connector activity becomes one suggested work stream

**Mode:** Showcase

**Persona:** Elena connects Linear at workspace scope, and Maya starts a useful
suggestion from the Avalon home screen.

**Preconditions:** A signed Linear delivery is not claimed by an explicit watch
or automation. Its title and summary are compact, while the exact payload is too
large for the queue. Maya and Mateo are both active members with different prior
dismissals.

**Flow:**

1. Regional ingress verifies exact bytes, retains the large payload in regional
   R2, and inserts one normalized regional D1 activity and receipt.
2. It enqueues only region, workspace ID, and activity ID.
3. Deterministic routing claims nothing, so admission groups the event into a
   bounded workspace window and creates or updates one opportunity.
4. Background ranking stores different four-card sets for Maya and Mateo and
   publishes bounded per-person display projections to the `WorkspaceDO`.
5. Maya starts the opportunity; the promotion initializes one hidden child and
   opening user part, revalidates its source epochs, and D1 finalizes.
6. The parent atomically masks the opportunity and exposes the child from the
   finalization receipt.

**Expected user-visible behavior:** Maya sees a useful stored suggestion without
waiting for inference on page load. Starting shows a bounded `Starting` state,
then one real work stream appears in Work Streams and In Progress. Mateo's own
ranked set and dismissal state remain independent. Nobody sees raw payload data
outside its authorized regional surfaces.

**Architecture stress:** R2 payload ownership, normalized D1 activity,
deterministic claims, batch admission, per-person stored ranking, rebuildable
parent display cache with source deny floors, current-epoch promotion receipts,
and a hidden parent gate each own a different fact.

**Failure oracle:** Ranking runs on the request, the queue carries the payload,
Maya's start creates two children, an opportunity appears as unread before
promotion, a child and Starting card appear together, source revocation is
ignored, Mateo's card disappears because Maya acted, or provider content lands
in Global.

**Unresolved pressure:** Define ranking freshness and what home shows when the
stored set is expired but replacement ranking is delayed.

### S22 — Suggested context becomes a targeted action in an existing stream

**Mode:** Showcase

**Persona:** Samantha owns a work stream about a release while a GitHub review
arrives that may require Mateo's decision.

**Preconditions:** Contextual routing has passed its future re-enable quality
gate. The GitHub activity is workspace-visible, matches the work stream, and the
admission result targets Mateo rather than every participant.

**Flow:**

1. The regional activity domain records the classifier/admission decision and
   enqueues one stable delivery to the existing `WorkstreamDO`.
2. The child rechecks current visibility, deduplicates the delivery, and inserts
   one Mateo-audience operational action with version, expiry, and source epochs.
3. Its Mateo-specific projection adds Needs Your Input without touching every
   other member's personal row.
4. Mateo accepts the action while the D1 feedback writer is temporarily down.
5. The child resolves the action once, appends audience-safe accepted evidence
   to the main feed only if Mateo explicitly shares it, clears Needs Your Input,
   and later replays feedback to D1.

**Expected user-visible behavior:** Mateo sees one relevant card inside the work
stream as a private overlay and in his interest list. Acceptance clears the
prompt immediately and does not wait for the learning corpus. Other members do
not see the pending card; they see evidence only after an explicit authorized
share, at which point the transcript changes once.

**Architecture stress:** D1 owns routing and cross-workstream feedback, while the
child owns an audience-scoped operational row and resolution. Personal
projection and feedback outboxes may lag independently without making the
pending action a conversation part or a second UI authority.

**Failure oracle:** Duplicate cards, a workspace-wide personal fan-out, a D1
outage preventing acceptance, a resolved card returning after replay, or an
unauthorized source snippet entering shared transcript/model/export breaks the
split.

**Unresolved pressure:** Product research must define which action types exist
and whether any explicit acceptance can satisfy a separate write-tool approval
contract; ordinary Accept must not imply that authority.

### S23 — An additive schema change remains lazy

**Mode:** Showcase

**Persona:** Ren deploys a nullable sidebar-projection field to `WorkspaceDO`
and a small receipt index to `WorkstreamDO` while most objects are dormant.

**Preconditions:** New code reads the old and expanded schemas. Each constructor
has a fast, idempotent DDL migration tracked by implementation hash in
`_sql_schema_migrations` and runs it under `blockConcurrencyWhile`.

**Flow:**

1. The stateful Worker deploys the additive code and class definitions without
   enumerating either namespace.
2. Active objects wake normally, apply the DDL before serving the triggering
   event, and asynchronously report their observed versions to regional D1.
3. A dormant workspace remains untouched for three months.
4. Its first later sidebar request wakes it, applies the same migration once,
   and serves the request under the expanded schema.
5. The constructor runs again after an object restart.

**Expected user-visible behavior:** Deployment creates no fleet-wide latency or
cost spike. An active user sees at most the measured small first-wake overhead,
and the three-month-dormant workspace incurs no migration wake merely for
existing. Restart does not repeat or corrupt the DDL.

**Architecture stress:** Class deployment, Worker code version, and object-local
schema version are independent facts. Lazy convergence is visible through
regional inventory reports without making full convergence a correctness
condition for an additive release.

**Failure oracle:** Namespace enumeration during deployment, an event served
before required DDL, a second index/table creation error on restart, or a
constructor scan of transcript/product rows fails this study.

**Unresolved pressure:** Set a p99 constructor time and object-size threshold
for each allowed DDL form; anything that exceeds it must become a sliced data
campaign rather than being labelled additive.

### S24 — A fleet sweep backfills online and pauses safely

**Mode:** Showcase

**Persona:** Ren must converge a projection change before removing the old
field, while Mateo continues using an affected work stream.

**Preconditions:** Expanded code dual-reads and dual-writes old and new shapes.
A signed `online_backfill` campaign has regional D1 jobs, a campaign Workflow,
a `RegionalMigrationDO`, a fixed set of jurisdictional `MigrationShardDO`s,
Queue/DLQ shard wake-ups, expiring shard admission permits, and checksummed
object-local cursors.

**Flow:**

1. Workflow enqueues only `{region, campaign_id, shard_id, wake_nonce}`; the
   jurisdictional shard claims its D1 stable-hash cohort.
2. The shard issues bounded permits and invokes `applyMigrationSlice` RPCs.
3. Mateo posts and receives streaming output between two slices.
4. Queue delay and slice latency cross the campaign ceiling, automatically
   entering `pausing`; every shard fences new permits while already admitted
   bounded slices settle or expire, then acknowledges `paused`.
5. Ren reduces concurrency and resumes; verification then proves hashes,
   parent projection parity, and sample message arrays before commit.

**Expected user-visible behavior:** Mateo's conversation remains responsive and
ordered. Migration may defer a busy object but never holds its event loop for a
fleet-sized transform. Pause and resume are operationally invisible except for
bounded migration delay.

**Architecture stress:** Regional SQL selects and leases the fleet only after a
jurisdictional shard is entered. Queue wakes shards at least once, each shard
gates local admission, and the target object's journal is the authority for
slice progress. No campaign Workflow exists per product object.

**Failure oracle:** A user write omitted from the transformed result, `paused`
acknowledged before every shard fences and drains permits, a stale wake issuing
new work, cursor progress stored outside the object transaction, or cleanup
before fleet verification fails this study.

**Unresolved pressure:** Publish the Queue depth, user-latency, error, mismatch,
and cost thresholds that pause each region, plus who may resume and with what
evidence.

### S25 — D1 and R2 data copy while held writes remain durable

**Mode:** Showcase

**Persona:** Samantha uses a work stream throughout its authority move from D1
and R2-backed records into a `WorkstreamDO`.

**Preconditions:** A revision-stamped D1 snapshot and hashed R2 chunks feed a
hidden object generation. Every legacy writer uses the same D1 authority-row
transaction, the old authority owns an outbox/tail cursor, and held commands
have stable IDs.

**Flow:**

1. Snapshot and shadow import begin while Samantha and a provider continue to
   append through the old authority.
2. Idempotent object RPC imports chunks and verifies counts, hashes, message
   arrays, sidebar projection, and authorization without side effects.
3. One D1 transaction changes `legacy -> holding`; newly arriving desktop,
   provider, scheduler, and tool-result inputs receive explicit
   `accepted_pending_migration` receipts only after durable hold insertion.
4. The controller enters `closing_hold`, stops acknowledging new ingress,
   records the final hold sequence, imports/verifies every accepted command, and
   prepares the target without side effects.
5. One D1 CAS publishes the DO route. The first routed request opens the
   prepared epoch; no accepted held item needs release after route, and source/
   hold receipts remain retained for the rollback window.

**Expected user-visible behavior:** Samantha may see a brief `Upgrading work
stream` state, but every acknowledged or held action appears exactly once. No
shadow notification, tool, sidebar card, or activity is visible before
cutover.

**Architecture stress:** Large input lives in regional R2; the regional D1
authority row atomically gates every old mutation, hold insertion, and route
CAS; and the side-effect-free target is not externally authoritative before
route publication. Closing the hold creates a finite verified set without
asking D1 and DO SQLite to share a transaction.

**Failure oracle:** Acknowledgement before durable hold, post-route release
needed for correctness, a lost/duplicate input, a shadow side effect, route CAS
before final-sequence verification, or a direct legacy writer escaping the
authority-row gate fails this study.

**Unresolved pressure:** Bound hold duration and bytes, define backpressure when
the bound is reached, and specify how users distinguish held from fully
committed optimistic actions.

### S26 — Parents learn a wire protocol before children use it

**Mode:** Showcase

**Persona:** Maya sees a sidebar projection evolve while a workspace parent and
its children run mixed Worker and schema versions.

**Preconditions:** Projection, authorization, directory, revocation, and
migration envelopes carry `contract_version`, `sender_schema_version`, a
complete replacement key, and an idempotency ID. Parent N accepts N and N+1.

**Flow:**

1. The expanded `WorkspaceDO` receiver deploys first and reports N+1 support.
2. Regional inventory proves a canary parent acknowledged that support.
3. Its children migrate and begin sending the N+1 complete replacement form.
4. A delayed N outbox event arrives after an N+1 replacement.
5. Remaining parents and children converge before a later campaign removes N.

**Expected user-visible behavior:** Sidebar collections remain internally
consistent through mixed versions. A delayed old event is applied wholly when
valid and newer, ignored by version, or sent to typed reconciliation; it is
never partially interpreted.

**Architecture stress:** Schema version alone does not establish RPC
compatibility. The child's acknowledged parent contract gates its emitted form,
and inventory provides the proof required before contraction.

**Failure oracle:** A child publishing N+1 before acknowledgement, field-level
partial application, removal of N while an old outbox can still arrive, or a
rollback to a parent that cannot parse already-acknowledged traffic fails this
study.

**Unresolved pressure:** Define acknowledgement durability across parent
restart, the rollback-compatible protocol floor, and the maximum age or repair
path for delayed old envelopes.

### S27 — An EU migration wakes only a jurisdictional shard

**Mode:** Showcase

**Persona:** Priya audits an EU online-backfill campaign launched by a
Cloudflare Workflow and delivered through Queue.

**Preconditions:** The Queue/Workflow-triggered wake Worker has no product D1,
R2, `WorkspaceDO`, or `WorkstreamDO` binding. Its envelope is limited to region,
campaign ID, shard ID, and wake nonce, and it can call only an explicitly EU-
jurisdictional `MigrationShardDO`.

**Flow:**

1. Workflow creates a campaign step and Queue delivers the non-product shard
   wake envelope to its least-privilege Worker.
2. The Worker calls the named EU-jurisdictional shard directly; it does not
   POST to a regionalized hostname to claim subrequest placement.
3. Only that shard resolves object jobs in EU D1, reads hashed input from EU R2,
   issues admission permits, and invokes EU-jurisdictional product objects.
4. Duplicate dispatch returns the object's recorded command result.
5. Priya inspects bindings, traces, logs, and stored records.

**Expected user-visible behavior:** The migration completes normally without a
Global-content fallback. The audit can prove that the non-regional hop handled
only a non-product wake and could not read product storage. It also discloses
and contractually accounts for Cloudflare's documented out-of-jurisdiction
billing/debug logging of opaque Durable Object IDs; it does not label that
platform metadata as customer content or pretend it does not exist.

**Architecture stress:** Queue/Workflow triggers and Worker subrequests are not
covered by Regional Services. Payload minimization plus a wake Worker bound only
to a jurisdictional shard makes that DO the first content-processing boundary.

**Failure oracle:** A workspace/work-stream/object ID, manifest payload, error
text copied from content, or product binding accessible to the wake Worker is a
failure, as is resolving a regional job outside the jurisdictional shard,
embedding names in object IDs, or omitting Cloudflare's documented operational
ID logging from EU/EEA legal and DPA review.

**Unresolved pressure:** Add deployment assertions that inspect wake bindings,
shard jurisdiction, and sample payloads, and periodically reconfirm
Cloudflare's Queue, Workflow, logging, trace, DO-jurisdiction, and internal-
binding residency contract.

### S28 — Two hibernating sockets cover one foreground workspace

**Mode:** Showcase

**Persona:** Mateo works in one foreground work stream, backgrounds Avalon for
an hour, and later resumes it.

**Preconditions:** The desktop has at most one hibernatable socket to the
selected `WorkspaceDO` and one to the foreground `WorkstreamDO`. Both use
Cloudflare WebSocket hibernation, serialized attachments, and a static
auto-response pair.

**Flow:**

1. In the foreground, Mateo receives token batches directly from the child and
   sidebar/interest changes through the parent.
2. He switches work streams; the old child socket closes after its short grace
   and one new child socket opens from a durable cursor.
3. He backgrounds the app. The child closes, the client sends zero
   application-level heartbeat traffic, and the parent may remain hibernating.
4. The network silently drops the parent connection; Avalon does not run a
   periodic reconnect or ticket-rotation timer.
5. Foreground resume reconnects with jitter and a durable `resume_after`
   cursor, then receives replay or one snapshot/reset.

**Expected user-visible behavior:** Background completions, mentions, unread,
and `needs_input` converge in the parent view without maintaining a socket to
every child. Resume does not lose or duplicate transcript state, and the app
does not reconnect every two or three minutes.

**Architecture stress:** Hibernation removes idle object duration while
retaining connection state. The handshake ticket expires without expiring an
established socket; authorization epochs and material-event checks provide
revocation instead of reconnect churn.

**Failure oracle:** A child socket per running/unread stream, background
application pings, intentional periodic reconnect, token frames through the
parent, or reconnect caused only by short-lived ticket expiry fails this study.

**Unresolved pressure:** Measure NAT, desktop, sleep, and mobile behavior to set
the foreground auto-response interval and decide on which operating systems the
background parent socket is worth retaining.

### S29 — UI frames and durable checkpoints keep independent time

**Mode:** Showcase

**Persona:** Mateo watches a fast model response followed by a seconds-long tool
and a Terminal tail.

**Preconditions:** The first token flushes immediately. Later deltas coalesce
for roughly 50–75 ms and never exceed 30 UI frames per second. A mutable active
tail checkpoints every 250–500 ms while observed and may slow toward a measured
one-second target without an observer, with byte and semantic-boundary caps.
Provisional frames and durable `(event_seq, through_frame_seq)` checkpoints are
separate lanes.

**Flow:**

1. The provider produces its first token after three seconds, then emits
   hundreds of deltas per second.
2. The child broadcasts bounded provisional UI frames while the executor
   retains them; at the independently selected durable cadence, one transaction
   stores text through a named frame and advances the durable cursors.
3. A tool call and status boundary commit immediately rather than waiting for a
   checkpoint timer.
4. The client backgrounds during Terminal; checkpoint cadence slows within its
   bound while no browser socket receives token frames.
5. Normal completion seals the tail, writes immutable adjacent `parts`, the
   terminal fact, and executor cursor in one transaction, then removes active
   rows.

**Expected user-visible behavior:** First-token latency is not extended, later
text looks smooth without exceeding 30 fps, and tool/status changes appear
immediately. Reload shows one exact final answer, not the active tail plus a
duplicate final message.

**Architecture stress:** Provider, UI, and persistence cadences are independent.
UI delivery never acknowledges executor retention. Mutable operational chunks
bound SQLite page rewrites during generation, while durable-through-frame
acknowledgements and immutable final parts preserve projection/replay semantics.

**Failure oracle:** One row per frame/token, persistence at 30 writes per
second because the UI is 30 fps, durable cursor advancement ahead of stored
text, delayed tool boundaries, a mutable canonical final message, or two final
answers after sealing fails this study.

**Unresolved pressure:** Benchmark 250 ms, 500 ms, and one-second policies for
row/index writes, latency, page amplification, PITR growth, prompt reads, and
maximum provisional rewind at representative concurrency.

### S30 — An exceptional transform uses a bounded scale-to-zero Container

**Mode:** Showcase

**Persona:** Ren migrates an immutable legacy archive whose codec cannot run
within the tested Worker CPU/runtime envelope.

**Preconditions:** A reviewed campaign explicitly allows the optional
Cloudflare Container path. The Container receives an opaque job plus regional
R2 input/output references, has no product routing authority or browser socket,
and checkpoints progress in regional D1.

**Flow:**

1. The regional Worker proves the transform is not safely sliceable in its own
   runtime and admits one bounded Container job under campaign concurrency and
   cost ceilings.
2. The Container reads the immutable regional chunk, writes a hashed output
   chunk, and reports only enumerated status through the normal regional job
   contract.
3. The target object verifies and imports the output by idempotent RPC.
4. The Container loses its process and retries from the regional checkpoint.
5. With no work remaining, Container capacity scales to zero.

**Expected user-visible behavior:** Migration remains resumable and has no
always-on service cost. The Container never becomes a transcript, socket, route,
or migration-truth owner, so its loss does not alter accepted product activity.

**Architecture stress:** Cloudflare-only fleet-migration execution still permits
an exceptional Linux/runtime boundary, but all authority, idempotency, regional
placement, and verification remain in existing D1/R2/DO contracts.

**Failure oracle:** Persistent Container state as authority, direct browser
connections, unbounded product bindings, non-regional chunks, or completion
inferred only from process exit fails this study.

**Unresolved pressure:** Define the proof required to admit a Container instead
of Worker slices, plus image allowlists, egress, resource, concurrency, idle,
and cost ceilings.

### S31 — A thirty-minute agent loop spans durable Workflow actions

**Mode:** Showcase

**Persona:** Samantha asks Avalon to investigate a production issue, inspect
several systems, run tests, and prepare a fix; the complete loop takes twenty-
seven minutes across many model iterations rather than one long model turn.

**Preconditions:** One Workflow instance represents the full loop. Bind exposes
checkpoint/resume or next-action boundaries; provider requests, tool
occurrences, settlements, compactions, reconciliation, and terminalization have
deterministic step identities. The domain owner stores the loop ledger and
transcript. Workers Paid defaults remain 30 seconds of active CPU, 10,000 steps,
and 10,000 subrequests; events and non-stream results remain below one MiB and
per-instance state below 1 GB.

**Flow:**

1. The owner admits the loop and the Workflow loads its projection fence.
2. Several one-to-five-second first-token waits and seconds-long tools execute
   as separate bounded steps, with output committed through owner receipts.
3. The loop compacts context and continues from its next-action cursor without
   embedding the transcript in Workflow state.
4. A six-minute passive dependency wait uses `waitForEvent`, releases running
   concurrency, and holds no run-control socket.
5. The Workflow reconciles the durable owner fact on wake, performs later model
   and tool steps, and terminalizes once after twenty-seven minutes.

**Expected user-visible behavior:** Samantha sees one continuously progressing
agent session, honest waiting/tool states, steering availability during active
operations, and one final answer. Workflow boundaries do not appear as separate
conversation turns or duplicate status cards.

**Architecture stress:** Full-loop wall time belongs to the Workflow instance;
retry scope belongs to one model/tool/reconcile step. Bounded references keep
step results and state below platform limits, while `step.sleep` consumes no
step and passive waits stop consuming a running-instance slot. Starts and
restarts remain below 300 per second per account and 100 per second for the
Workflow definition.

**Failure oracle:** Wrapping the full loop in one `step.do`, returning transcript
or Terminal output through Workflow state, keeping an outbound control socket
during passive wait, repeating a write after one step retry, or terminalizing
twice fails this study.

**Unresolved pressure:** Measure the real action/step multiplier, passive-wait
ratio, subrequests, retries, state/event/result bytes, CPU, and regional arrival
rate before choosing any non-default limit or capacity envelope. Confirm the
account's running-instance limit because Cloudflare's table says 50,000 while
nearby prose says 10,000.

## Break-attempt studies

### B01 — The workspace control pane becomes the hottest object

**Mode:** Break attempt

**Persona:** Maya operates a workspace with 100,000 work streams, 5,000 active
in a day, and a burst where 2,000 children change state or attention together.

**Preconditions:** Membership checks, sidebar reads, pin changes, work-stream
creation, and child projection applies all target one unsharded `WorkspaceDO`.

**Flow:**

1. Thousands of clients reconnect after a network incident and request the
   first sidebar page.
2. An automation burst creates and completes many work streams.
3. Each child retries a coalesced summary while people open, pin, and mark
   streams seen.
4. Maya adds a member during the burst.

**Expected user-visible behavior:** Unrelated work streams continue to open and
run; sidebar pages may be slightly stale but converge; membership change does
not wait behind token or child transcript traffic.

**Architecture stress:** One parent isolates child conversations but
centralizes several high-rate, differently prioritized workloads. Coalescing
reduces writes but cannot eliminate admission and read contention.

**Failure oracle:** The design breaks if parent saturation prevents authorized
users from opening otherwise healthy children, if lag grows without bound, or
if retries create a feedback loop that worsens the outage.

**Unresolved pressure:** Establish load thresholds and a sharding design behind
the parent interface, including priority lanes for auth, directory mutation,
sidebar reads, and projection ingestion.

### B02 — Per-person sidebar state becomes a Cartesian product

**Mode:** Break attempt

**Persona:** Maya imports a 10,000-member enterprise workspace with 100,000
historical work streams, while most members interact with fewer than 200.

**Preconditions:** Common projection state exists for every work stream. Seen,
mention, notification, and pin state are logically per person and work stream.

**Flow:**

1. A newly provisioned member opens the workspace for the first time.
2. A team-wide announcement mentions 4,000 people in one work stream.
3. Retention removes 50,000 old work streams.
4. The new member requests later sidebar pages.

**Expected user-visible behavior:** First use does not trigger child fan-out or
materialize one billion default rows. Mention state is correct for addressed
people, pagination stays responsive, and retention removes sparse opinions.

**Architecture stress:** The parent must represent default and sparse
per-person state without `members × workstreams` storage. Mention fan-out can
still be enormous even with sparse seen rows.

**Failure oracle:** Full Cartesian materialization, an O(all work streams) write
when one member joins, or child reads to compute a cold member's first page
breaks the design.

**Unresolved pressure:** Specify sparse defaults, capped mention fan-out,
membership-group representation, and whether unread is calculated from a
per-work-stream baseline or stored per member.

### B03 — Membership is revoked while a child socket is active

**Mode:** Break attempt

**Persona:** Maya removes a contractor while the contractor has an open
work-stream socket, a private chat, and a model run in progress.

**Preconditions:** `WorkspaceDO` owns active membership; `WorkstreamDO` owns
scope, participation, audiences, and live sockets.

**Flow:**

1. The contractor starts a read-only private chat and receives streaming text.
2. Maya removes the contractor in the parent.
3. Before any asynchronous child notification arrives, the contractor sends a
   message and requests an R2 attachment.
4. The running model attempts another tool.

**Expected user-visible behavior:** Revocation has a defined effective point.
After it, new writes, hydration, stream delivery, and tools fail; accepted work
before it has a stable audit outcome. Other users continue normally.

**Architecture stress:** Calling the parent on every child event would recreate
the hot-parent problem, while cached membership creates a revocation window.
Existing session tickets and sockets need an authority epoch or push protocol.

**Failure oracle:** Content or a tool result delivered after the documented
revocation point, a removed user retaining access through a guessed child ID,
or undefined accepted-versus-rejected writes breaks the security boundary.

**Unresolved pressure:** Set capability TTL and socket/run eviction SLOs, define
key rotation, and prove the active-grant child index stays bounded while a
dropped invalidation cannot outlive the documented window.

### B04 — Parent projections arrive late, out of order, and after deletion

**Mode:** Break attempt

**Persona:** Mateo watches one card while a child changes from running to
`needs_input`, is renamed, completes, and is then deleted during parent
unavailability.

**Preconditions:** The child coalesces an outbox and emits monotonic versions per
`common` and `user:<id>` projection key. Network delivery deliberately reorders
and duplicates events across keys.

**Flow:**

1. Common versions 40–43 change running state, title, and completion while Alice
   version 8 adds a mention and Bob version 17 advances seen state.
2. The parent receives common 42, Alice 8, common 40, Bob 17, and common 43,
   with duplicates.
3. The parent records a deletion tombstone that dominates every projection key.
4. Delayed retries of common 42 and Alice 8 arrive.
5. An operator rebuilds the parent's projection from children.

**Expected user-visible behavior:** The card moves monotonically to the newest
committed state and then disappears. A stale update never clears or invents a
mention, rolls back a title, or resurrects the card. Rebuild reaches the same
state.

**Architecture stress:** Per-key cursors prevent unrelated common and personal
patches from suppressing each other. Tombstones and rebuild cursors must dominate
all old projection keys.

**Failure oracle:** Any rollback, lost mention due to unrelated coalescing,
resurrection, or rebuild result different from normal delivery breaks the
projection contract.

**Unresolved pressure:** Define cursor initialization and garbage collection for
removed members and how a parent discovers every child needed for a complete
rebuild.

### B05 — The parent is unavailable but a child is healthy

**Mode:** Break attempt

**Persona:** Mateo has a healthy work-stream connection while the
`WorkspaceDO` repeatedly fails to wake for ten minutes.

**Preconditions:** The client has a recent workspace snapshot and a valid
regional session. The child and run host remain reachable.

**Flow:**

1. Mateo follows a direct work-stream link.
2. He posts a message, receives streaming output, and is mentioned.
3. Another member tries to join the work stream.
4. Both clients return to the sidebar.

**Expected user-visible behavior:** The product has an explicit degradation
policy. It may permit already-authorized activity under bounded credentials or
fail closed, but it must not claim current membership or sidebar state it cannot
verify. The stale sidebar is visibly labelled.

**Architecture stress:** The parent is both a convenient query owner and a
potential workspace-wide availability dependency. Child autonomy conflicts
with parent-owned membership and directory truth.

**Failure oracle:** Silent use of indefinitely stale authorization, partial
membership changes, unlabelled stale sidebar data, or automatic fan-out to all
children as a fallback breaks the design.

**Unresolved pressure:** Define fail-open/fail-closed behavior by operation and
the maximum age and scope of any parent-issued capability.

### B06 — Two clients submit the same idempotency key with different bodies

**Mode:** Break attempt

**Persona:** Mateo edits an offline draft on two devices derived from the same
client message ID.

**Preconditions:** Device A holds "deploy now" and device B holds "do not
deploy" under the same client-generated idempotency key.

**Flow:**

1. Both devices reconnect concurrently and submit their version.
2. A third message arrives from Samantha during the conflict.
3. Avalon is already waiting to resume an interrupted run.

**Expected user-visible behavior:** Exactly one body may bind the idempotency
key. The conflicting request receives a specific error and preserves its local
draft for manual resolution. Samantha's unrelated message still commits in a
deterministic order.

**Architecture stress:** Idempotency must compare a canonical payload hash, not
only return the first part with the key. One object serializes admission but
cannot decide that contradictory content is an innocent retry.

**Failure oracle:** Silent last-write-wins, two parts with one client ID, an
acknowledgement for content that was not stored, or a resumed model turn that
omits one accepted message breaks the study.

**Unresolved pressure:** Define conflict responses and whether attachments,
mentions, and normalized whitespace participate in the client payload hash.

### B07 — A crash leaves a tool call without a result

**Mode:** Break attempt

**Persona:** Samantha tries to fork immediately after the assistant emits a
tool call and the owner crashes before recording a result.

**Preconditions:** The call is durable and pending. The external tool may not
have begun, may be running, or may have completed without a receipt.

**Flow:**

1. Samantha requests a fork at the apparent latest sequence.
2. A reconnect tries to project the main feed for another model run.
3. Recovery inspects invocation and provider state.
4. The pending call settles as failed, completed, cancelled, or ambiguous.

**Expected user-visible behavior:** Fork and new inference wait or fail with a
clear retryable state until a complete-turn fence exists. The transcript shows
the tool's real recovery outcome rather than hiding the call.

**Architecture stress:** One sequence makes the incomplete boundary visible,
and the projector refuses malformed best effort. Recovery must still append
exactly one answering result.

**Failure oracle:** A model request with an unanswered inherited call, a fork
that bisects the lifecycle, deletion of the pending call to make projection
pass, or two recovery results breaks the design.

**Unresolved pressure:** Specify who reconciles orphaned pending calls, its
wake-up mechanism, and the age at which an unrecoverable call becomes
`ambiguous` rather than pending forever.

### B08 — Compaction launders private content across audiences

**Mode:** Break attempt

**Persona:** Samantha has owner-only context, then a participant is added and
the work stream's tool policy and model template change.

**Preconditions:** Several completed compactions exist for different
principals, audiences, model families, system templates, and tool policies.

**Flow:**

1. Samantha's private chat compacts a phrase that does not appear in the main
   feed.
2. The main feed compacts at a similar waterline.
3. Mateo joins after both summaries exist.
4. The model family and current system policy change.
5. A crashed compaction has a durable start but no completion.

**Expected user-visible behavior:** Mateo receives only summaries valid for his
visibility. New policy is generated at projection time. The incomplete
compaction removes no history, and a summary built for a different model or
tool policy never governs accidentally.

**Architecture stress:** `projection_key` must fingerprint every material
visibility and rendering input. Membership change can invalidate a principal's
effective audience without rewriting old summaries.

**Failure oracle:** A private phrase in Mateo's prompt, reuse of a summary under
an incompatible policy/template, or history skipped because only
`compaction_start` exists is a critical failure.

**Unresolved pressure:** Define the exact fingerprint inputs and the lifecycle
for old summaries when membership, work-stream scope, attachment permission,
or policy changes.

### B09 — A live document chat changes beneath the owner

**Mode:** Break attempt

**Persona:** Samantha uses a long-running private document chat while the main
feed gains corrections, deletes an attachment, and contains quoted prompt
injection from a provider.

**Preconditions:** `inherit_mode=document` may be live at the projection fence
rather than fixed at chat creation.

**Flow:**

1. Samantha asks a question based on main-feed state A.
2. Mateo posts contradictory state B before the next private-chat turn.
3. An inherited attachment becomes unavailable under retention policy.
4. A provider-authored main part says to ignore system policy.
5. Samantha asks a follow-up without realizing the inherited document changed.

**Expected user-visible behavior:** The chat identifies the main-feed revision
used for each answer and treats inherited content as untrusted evidence. It
does not fabricate missing attachment bytes or allow quoted text to become
policy.

**Architecture stress:** A live document is reproducible only when each model
run records its resolved fence and rendering version. The document renderer
must preserve provenance and trust labels.

**Failure oracle:** An answer that cannot be reproduced, tool execution caused
by inherited untrusted instructions, or the model treating main-agent calls as
its own breaks the design.

**Unresolved pressure:** Decide whether document chats are live by default,
pinned at creation, or visibly offer both modes; nullable
`inherit_fence_seq` alone does not settle the product expectation.

### B10 — Referenced content is huge, corrupted, or unavailable

**Mode:** Break attempt

**Persona:** Mateo attaches a large recording and Avalon produces hundreds of
megabytes of Terminal output.

**Preconditions:** Payloads exceed inline limits and are stored in regional R2
with size, hash, summary, and opaque `content_ref`.

**Flow:**

1. Projection needs only a bounded excerpt and summary for the next run.
2. R2 returns a hash mismatch for the attachment.
3. The Terminal payload is temporarily unavailable during reconnect.
4. An unauthorized user obtains the opaque reference value.
5. Retention removes the bytes while transcript history remains.

**Expected user-visible behavior:** The transcript remains intelligible through
durable summaries and explicit missing/corrupt states. Models and users receive
bounded material, never arbitrary bulk output. The unauthorized read fails.

**Architecture stress:** `content_ref` is identity, not authority or a URL.
Hydration rechecks principal, kind, expected hash, and bounds. Storage cleanup
must not make the canonical part appear never to have existed.

**Failure oracle:** Hash-mismatched bytes reaching a model, unauthorized
hydration, unbounded prompt construction, a secret-bearing signed URL in a
part, or silent data disappearance breaks the design.

**Unresolved pressure:** Define summary generation timing, repair behavior,
maximum durable summary size, and differentiated retention for raw Terminal
output, attachments, and audit receipts.

### B11 — A provider reuses a delivery ID with different bytes

**Mode:** Break attempt

**Persona:** Elena's Slack installation sends one event ID twice with different
payloads while its regional route is being repaired.

**Preconditions:** The shared ingress has verified signatures. The Global
directory contains only the provider account-to-region route.

**Flow:**

1. Payload A claims the delivery and reaches the regional inbox.
2. Payload B arrives with the same provider ID but a different body hash.
3. The route briefly points at an unknown or wrong-region workspace locator.
4. The provider retries payload A after the regional attempt fails.

**Expected user-visible behavior:** Avalon records a sanitized collision and
does not accept payload B as a retry. A bad route fails closed without writing
the body into Global or another region. Payload A can be reclaimed only under
the documented regional lease and remains exactly once in product state.

**Architecture stress:** Deduplication identity includes a body hash and
separates Global envelope verification from regional processing completion.
Routing errors must not turn the Global plane into a quarantine content store.

**Failure oracle:** Cross-region content, silent replacement of A by B,
permanent loss because an ingress receipt was marked complete too early, or two
regional parts breaks the design.

**Unresolved pressure:** Specify ownership of failed verified envelopes when
the route is missing and whether providers should receive success, retry, or a
terminal rejection.

### B12 — Workspace export and deletion require fleet traversal

**Mode:** Break attempt

**Persona:** Priya invokes an EU subject-access export and later deletes a
workspace with 250,000 work streams.

**Preconditions:** Children are independently durable and cannot be enumerated
from a namespace. Some are dormant, some are running, some hold referenced
content, and some are mid-migration.

**Flow:**

1. Priya requests a point-in-time export while users continue to post.
2. The coordinator walks the parent's child directory in bounded pages.
3. Several child calls time out and later retry.
4. Priya requests deletion while one Terminal write is ambiguous.
5. The parent is deleted or evicted before every child confirms cleanup.

**Expected user-visible behavior:** Export states what fence it represents and
eventually provides a complete manifest or a precise list of unresolved items.
Deletion blocks new activity, remains resumable, and exposes progress without
resurrecting the workspace.

**Architecture stress:** One-object-per-work-stream removes a SQL-wide delete
and demands a durable, jurisdictional fan-out coordinator. The parent directory
is the only authoritative inventory and must outlive child cleanup.

**Failure oracle:** Orphaned readable children, missing work streams with no
manifest error, unbounded parallel wake-ups, parent deletion before durable
cleanup state, or Global coordination containing EU metadata breaks the design.

**Unresolved pressure:** Define the coordinator owner, snapshot protocol,
concurrency, legal-hold semantics, maximum completion time, and terminal state
for permanently unavailable content.

### B13 — Cutover collides with every write path

**Mode:** Break attempt

**Persona:** Ren migrates a hot work stream while a desktop post, Slack
follow-up, scheduler alarm, seen-waterline update, and agent tool result arrive.

**Preconditions:** Snapshot import is complete through D1 high-water mark H.
The migration lease is near expiry, and one old client caches the legacy route.

**Flow:**

1. Tail writes H+1 through H+4 arrive from different paths.
2. The final write fence begins.
3. The lease holder pauses, and another migrator attempts to reclaim the lease.
4. The route atomically changes to the `WorkstreamDO`.
5. The stale client sends a legacy write while the provider retries H+2.

**Expected user-visible behavior:** Every accepted semantic action appears once
in one total order. Stale callers are redirected or rejected with a retry path;
they never choose D1 as a continuing authority. A seen update cannot be
mistaken for a conversation tail entry.

**Architecture stress:** Every producer must resolve the same regional
authority and honor the final fence. Snapshot/tail hashing needs a typed event
domain and idempotency across representations.

**Failure oracle:** A write acknowledged by neither or both authorities, two
agent/tool side effects, divergent transcript and sidebar state, or two valid
lease holders breaks the migration.

**Unresolved pressure:** Enumerate all write paths in a machine-checked route
registry and specify the exact atomic primitive that changes authority.

### B14 — EU infrastructure fails and an operator wants Global fallback

**Mode:** Break attempt

**Persona:** Priya is waiting on a critical run when the EU Workflow or model
dependency is unavailable. Ren can restore service by routing it through
Global.

**Preconditions:** Storage objects remain healthy in the EU, but one required
background or subrequest service has no verified EU processing guarantee.

**Flow:**

1. The run fails admission or pauses at a durable safe boundary.
2. An operator attempts to change a routing flag to Global.
3. The client retries, and a scheduled alarm also fires.
4. The EU service later recovers.

**Expected user-visible behavior:** Avalon shows a regional dependency error or
retryable paused state. It does not silently fall back. Recovery resumes from
the durable EU owner without duplicating work.

**Architecture stress:** Region must be encoded in bindings and authority, not
merely request parameters that an operator or generic host can override.

**Failure oracle:** Any EU prompt, output, credential, log, or provider body
processed through Global because of an availability flag is a residency
failure, even if no data rests there afterward.

**Unresolved pressure:** Define which degraded capabilities remain available in
EU, the incident UX, and hard controls that make cross-region fallback
impossible rather than discouraged.

### B15 — A generic target adapter violates the host contract

**Mode:** Break attempt

**Persona:** A developer adds an agent loop for opportunity ranking and assumes
the durable host will make its domain writes safe.

**Preconditions:** The adapter puts raw candidates in Workflow input, appends
results non-idempotently, trusts a model-supplied owner ID, and has no revision
check.

**Flow:**

1. The host retries after inference completes.
2. Membership changes before result persistence.
3. The model returns an owner ID belonging to another workspace.
4. Cancellation arrives between ranking and append.

**Expected user-visible behavior:** The adapter is rejected before deployment
or each unsafe action fails at a typed boundary. No duplicate opportunities,
cross-workspace writes, or sensitive durable host payloads appear.

**Architecture stress:** A shared abstraction concentrates correctness only if
the adapter wire contract and conformance tests enforce opacity, host-derived
authority, idempotent persistence, revision checks, and terminal settlement.

**Failure oracle:** "The adapter should know better" as the only safeguard,
duplicate visible results on retry, or host-level storage of raw domain content
breaks the promised reuse model.

**Unresolved pressure:** Make adapter conformance executable and decide which
properties belong to types, runtime parsing, capability tokens, invariant
tests, and production reconciliation.

### B16 — A sub-agent branch bomb stays within depth four

**Mode:** Break attempt

**Persona:** A model recursively spawns the maximum number of children at every
allowed depth while each child streams output.

**Preconditions:** Depth five is rejected, but no breadth or aggregate budget is
assumed. Every child is technically within its individual tool policy.

**Flow:**

1. The parent spawns 100 children.
2. Each child spawns 100 more through depth four.
3. Thousands of children append checkpointed text toward one
   `WorkstreamDO` sequence and return large results.
4. A participant interrupts the main substream.

**Expected user-visible behavior:** Avalon stops spawning at a visible budget,
keeps the main feed responsive, and returns bounded summaries for work already
completed. The user can interrupt or cancel the branch as a unit.

**Architecture stress:** Depth limits cycles but not exponential breadth.
Serial sequence allocation and part storage make the one `WorkstreamDO` a
bottleneck even if inference executes elsewhere.

**Failure oracle:** Unbounded workflows or cost, starvation of human messages,
storage exhaustion, child results too large to return, or cancellation that
leaves the parent call pending forever breaks the design.

**Unresolved pressure:** Define per-call breadth, per-work-stream active-child
concurrency, aggregate token/tool/storage budgets, backpressure, and partial
result semantics.

### B17 — Tool authority changes during an active run

**Mode:** Break attempt

**Persona:** Maya revokes a workspace connector while Avalon has projected its
tool catalog and is about to perform a write.

**Preconditions:** The run fence is immutable for conversation content, but
connector authority, membership, workspace policy, and credentials can change.

**Flow:**

1. Avalon projects a tool as available.
2. Maya revokes the connector and rotates policy.
3. The model emits the now-stale tool call.
4. The provider credential refresh races with revocation.
5. The run attempts to continue after the rejected call.

**Expected user-visible behavior:** The tool fails with a stable
reconnect/re-authorize explanation and no provider mutation. The transcript
retains the call and failed result; Avalon can reason from the new state or stop
at `needs_input`.

**Architecture stress:** A message fence cannot freeze external authority.
Every tool invocation must derive and recheck current capability at execution,
while projection remains reproducible about what the model was offered.

**Failure oracle:** Use of a revoked credential, a write after policy removal,
deleting the model's stale call from history, or an automatic alternate
connection breaks the trust model.

**Unresolved pressure:** Record the tool-catalog revision with each run and
define which authority changes proactively interrupt inference versus fail only
at invocation.

### B18 — One work stream outgrows one Durable Object

**Mode:** Break attempt

**Persona:** A regulated client keeps a single engagement work stream active for
ten years, with millions of parts, compactions, receipts, forks, private chats,
and referenced payloads.

**Preconditions:** Retention requires raw history; compaction shortens model
input but does not delete canonical parts.

**Flow:**

1. Transcript pagination scans old and new substreams.
2. A new run locates the governing compaction and pinned material.
3. Export traverses the full history.
4. Local storage approaches platform limits or maintenance becomes expensive.

**Expected user-visible behavior:** Recent work remains responsive, old pages
remain readable, and the product warns before a hard storage failure. Export
and retention keep their stated semantics.

**Architecture stress:** One object is an excellent concurrency boundary but
may be a poor indefinite archive boundary. The proposal rejects duplicate
canonical history, so archival or segmenting must preserve one logical order
and projection behavior.

**Failure oracle:** Surprise write refusal, unbounded wake/scan latency, loss of
old audit data, or an archive that cannot reproduce the model-visible array
breaks the lifecycle story.

**Unresolved pressure:** Quantify maximum object size and design an archival or
segment manifest before launch customers can reach it; decide whether "one DO
per work stream" permits cold immutable segments outside the live object.

### B19 — A user asks to move a work stream

**Mode:** Break attempt

**Persona:** Samantha accidentally creates a work stream in the wrong workspace
and later asks to move it into a workspace in another region.

**Preconditions:** Workspace and region are part of authority; object IDs,
credentials, participants, attachments, provider routes, private audiences, and
sidebar projections are scoped to the original workspace.

**Flow:**

1. Samantha requests a same-region move.
2. She then requests a Global-to-EU move.
3. A provider follow-up arrives at the original permanent address.
4. An old work-stream link is opened after the attempted move.

**Expected user-visible behavior:** Because movement is a non-goal, Avalon
refuses clearly and offers an authorized copy/export path if one exists. It
does not partially move content, redirect provider traffic ambiguously, or
claim that changing an ID prefix changes residency.

**Architecture stress:** Parent-child ownership makes a move a copy plus
re-authorization, not a directory edit. Cross-region movement also requires a
new legal and processor boundary.

**Failure oracle:** A half-moved work stream, stale provider writes reaching a
different audience, private content copied without each audience rule, or
same-object cross-jurisdiction resolution breaks the design.

**Unresolved pressure:** Decide whether same-region copy-with-provenance is a
future feature and keep cross-region relocation explicitly separate.

### B20 — One person belongs to Global and EU workspaces

**Mode:** Break attempt

**Persona:** Priya belongs to 60 customer workspaces split between Global and
EU and expects a usable workspace picker after sign-in.

**Preconditions:** Global stores opaque workspace locators and regions but no
workspace names, member lists, sidebar state, or global inbox.

**Flow:**

1. Priya signs in on a new device with no regional cache.
2. The app discovers her workspace locators.
3. It fetches display metadata from the owning regions.
4. One region is unavailable and several memberships were recently revoked.
5. Priya switches rapidly between regions.

**Expected user-visible behavior:** The picker identifies reachable workspaces,
labels unavailable ones honestly, and removes revoked memberships at a defined
point. It never aggregates work-stream unread state into a global inbox.

**Architecture stress:** A truly opaque Global directory cannot render names,
while per-workspace requests create fan-out and leak availability patterns. A
single account spans authorities that intentionally do not share product
metadata.

**Failure oracle:** Workspace names or unread state copied into Global without
review, one request per work stream, stale access after revocation, or failure
of one region blocking every workspace breaks the boundary.

**Unresolved pressure:** Define the minimum global workspace-membership
discovery schema, regional batching endpoint, cache lifetime, and degraded
workspace-picker UX.

### B21 — Sidebar pagination changes while the user is paging

**Mode:** Break attempt

**Persona:** Mateo scrolls a workspace with 20,000 work streams while hundreds
change last activity and Maya reorders pinned items.

**Preconditions:** Sidebar ordering uses mutable fields, and the parent serves
paginated common plus per-person projections.

**Flow:**

1. Mateo fetches page one and receives a cursor.
2. Work streams from later pages become active and move ahead of the cursor.
3. Mateo fetches pages two and three.
4. Offline pin changes reconnect and rewrite the dense pin order.
5. A projection rebuild runs concurrently.

**Expected user-visible behavior:** Mateo sees no missing or endlessly repeated
cards, and pin order has a clear conflict outcome. The UI may announce that the
list changed and refresh from a new snapshot.

**Architecture stress:** One parent can create snapshot-consistent pagination,
but mutable ordering needs cursor versions or stable snapshot epochs. Dense pin
rewrites share the same owner but may conflict across devices.

**Failure oracle:** Permanent omission, duplicate cards that cannot reconcile,
cursor loops, or silent pin loss breaks sidebar usability.

**Unresolved pressure:** Define sidebar sort keys, cursor stability, snapshot
lifetimes, and conflict semantics for simultaneous pin reorders.

### B22 — Human and connector causality disagree with arrival order

**Mode:** Break attempt

**Persona:** Elena replies in Slack at the same time Samantha posts the answer
directly in Avalon.

**Preconditions:** Slack delivers late and supplies a provider timestamp that
predates Samantha's already committed main-feed part.

**Flow:**

1. The direct Avalon message commits first.
2. The earlier Slack reply arrives later through the regional inbox.
3. A repeated Slack delivery arrives after the agent has already responded.
4. The next model projection includes both human-authored facts.

**Expected user-visible behavior:** The transcript has one deterministic
committed order and retains provider event time as provenance. It does not
rewrite history when a late event arrives. The agent can see that the external
reply happened earlier even though it was observed later.

**Architecture stress:** The global work-stream sequence is receipt/commit
order, not a universal wall clock. Provider causality requires explicit source
metadata rather than sequence rewriting.

**Failure oracle:** Renumbering committed parts, duplicate follow-ups,
timestamp-only model ordering, or loss of source-time provenance breaks causal
debugging.

**Unresolved pressure:** Define how late-arrival provenance is rendered to
people and projected to models without compromising provider-valid turn order.

### B23 — Tiny streaming deltas amplify storage and sockets

**Mode:** Break attempt

**Persona:** Mateo watches a provider that emits one-character deltas at high
frequency while several clients are connected.

**Preconditions:** UI delivery is capped at 30 frames per second. Durable active-
tail checkpoints use a measured 250-1000 ms or 4-16 KiB policy plus immediate
tool, steering, reset, and terminal boundaries. The provider emits pathological
boundary hints.

**Flow:**

1. The provider emits thousands of tiny deltas and frequent misleading
   boundary hints.
2. One slow client cannot consume websocket traffic at provider speed.
3. The owner is evicted between two durable checkpoints.
4. The host retries or resumes the attempt.

**Expected user-visible behavior:** Fast clients see smooth-enough output, slow
clients degrade to resumable committed checkpoints, and final replay is exact.
Storage writes follow bounded mutable-tail checkpoints rather than delta or
rendered-frame count; finalization leaves immutable conversation parts.

**Architecture stress:** Semantic boundaries cannot be accepted blindly from a
provider if they defeat cost bounds. Socket backpressure and durable batching
must not block the object's event loop or tool-result persistence.

**Failure oracle:** One row per token/delta, unbounded in-memory buffers,
starvation of human messages, or different final text after replay breaks the
cost model.

**Unresolved pressure:** Select the provider-independent frame/checkpoint
heuristics, mutable chunk size, per-socket backpressure, and replay contract from
the storage-cost and failure-injection measurements.

### B24 — Workspace deletion races a scheduled and running loop

**Mode:** Break attempt

**Persona:** Maya deletes a workspace just as a scheduled automation is due and
a non-work-stream digest inference is running.

**Preconditions:** The regional scheduler, generic run host, `WorkspaceDO`, and
many `WorkstreamDO`s are separate durable authorities.

**Flow:**

1. Deletion closes workspace admission.
2. A scheduler alarm carrying an opaque workspace/run target fires late.
3. A digest host tries to append delivery state.
4. An already-running work-stream tool returns a completed external write.
5. Retry occurs after the parent tombstone exists.

**Expected user-visible behavior:** No new work begins after the deletion fence.
Accepted pre-fence side effects remain audited and settle safely. Late alarms
and adapter retries terminate idempotently rather than recreating the workspace
or children.

**Architecture stress:** Generic execution needs a domain-owned liveness and
authority check at every durable step. Opaque IDs avoid payload leakage but do
not prove the target still exists.

**Failure oracle:** A new post-deletion work stream, delivery to a deleted
destination, loss of an already-executed write receipt, or object recreation by
`getByName` semantics breaks lifecycle safety.

**Unresolved pressure:** Define workspace deletion epochs and ensure every
scheduler, queue, provider route, and target adapter checks them without a
single unbounded fan-out transaction.

### B25 — Operations needs to debug without crossing audience boundaries

**Mode:** Break attempt

**Persona:** Ren investigates a stuck EU sub-agent whose parent tool call is
pending, while support is not authorized to read customer prompts.

**Preconditions:** Global logs contain only allowed opaque routing fields. EU
logs and audit records are regional and content-minimized.

**Flow:**

1. Ren starts from a user-reported work-stream URL and run ID.
2. He traces Global routing, regional request, workspace authorization,
   work-stream sequence, host attempt, child substream, and tool receipt.
3. The child includes owner-only context and an R2 reference.
4. Ren triggers a safe reconciliation without reading the content.

**Expected user-visible behavior:** Support can explain whether the run is
waiting, failed, ambiguous, or recoverable and can perform an authorized
reconciliation. Private text, credentials, and payload bytes remain hidden.

**Architecture stress:** The hierarchy introduces several opaque IDs and
asynchronous boundaries. Correlation must be deliberate, regional, and scoped;
otherwise operators either cannot repair the system or gain excessive content
access.

**Failure oracle:** Requiring routine prompt access to diagnose state,
correlation IDs that expose customer metadata globally, or an untraceable
orphaned tool lifecycle breaks operability or privacy.

**Unresolved pressure:** Define regional correlation manifests, redacted state
inspection, break-glass access, immutable audit, and repair commands for every
terminal and pending state.

### B26 — A steering storm collides with an unsafe Terminal write

**Mode:** Break attempt

**Persona:** Mateo, Samantha, and Maya all react to a four-minute Terminal
operation after realizing its assumptions are wrong.

**Preconditions:** The recorded Terminal call may have an external effect and
cannot be terminated safely. Three clients have different replay cursors, and
one client will retry a steering request after losing its acknowledgement. The
internal executor control WebSocket is deliberately dropped mid-operation.

**Flow:**

1. Mateo queues a follow-up, then Samantha sends a steering correction.
2. Maya sends a second steering correction before the first signal reaches the
   executor; Samantha's client retries its request with the same client ID.
3. Mateo cancels his still-unadmitted queued message from an offline-replay path.
4. The Terminal call settles as `ambiguous` after four minutes.
5. The executor, owner, and clients reconnect in different orders.
6. An operator reconciles the external effect before any new write is allowed.

**Expected user-visible behavior:** The UI honestly remains `Waiting for the
current tool`, shows the two steering messages and Mateo's cancellation once,
and then enters `needs_input` for the ambiguous effect. Steering does not grant
permission to repeat the command. After reconciliation, one deterministic input
batch excludes the cancelled message and includes each steering correction once.

**Architecture stress:** Many steering requests must coalesce into revision and
admission work without spawning replacement runs per request. Client
idempotency, cancellation-before-admission, an unsafe tool result, lost best-
effort run-control channel, durable revision fence, and a later admission cut
must remain independently auditable.

**Failure oracle:** Duplicate Workflows, multiple abort attempts changing tool
outcome, projection of Mateo's cancelled input, blind command retry, one lost
steering correction, or admission before ambiguity is reconciled breaks the
design.

**Unresolved pressure:** Define steering rate limits and coalescing windows, and
whether a queued or steering message can supply reconciliation evidence without
also authorizing the next agent turn.

### B27 — Substreams become a universal bucket for unrelated features

**Mode:** Break attempt

**Persona:** Maya enables several experimental Avalon features built by
different teams against the new conversation API.

**Preconditions:** The storage schema exposes `main`, `chat`, and `agent`, but a
careless service could try to treat kind plus inheritance fields as an extensible
namespace.

**Flow:**

1. A reply UI tries to create one substream per main-feed message.
2. A scheduler tries to store a digest run in an `agent` substream without a
   spawning tool call.
3. A collaboration feature tries to create a workspace-audience group `chat`
   with three owners.
4. Capacity management tries to move old parts into an archive substream.
5. A user supplies a parent ID from another work stream to create a fork.
6. A Workflow retry tries to create a new agent substream for the same origin
   call.

**Expected user-visible behavior:** Each invalid creation fails before writing
conversation state. Replies remain main-feed parts, the digest uses its domain
adapter, group collaboration asks for a work stream rather than weakening
private-chat semantics, storage partitioning stays invisible, the foreign fork
is denied, and the retry resolves the existing child.

**Architecture stress:** Kind, inheritance, audience, owner, origin, and return
mode form a closed validated union. Local foreign keys and unique origin-call
constraints must enforce the policy even when callers bypass the intended UI.

**Failure oracle:** An orphan agent, cross-workstream inherited content,
workspace-visible private chat, substream sidebar card, per-retry child, or
unbounded thread hierarchy means substreams have become an accidental product
and authorization platform.

**Unresolved pressure:** If Avalon later needs a group branch or reply-thread
product, decide whether it is a new work-stream scope or a new explicit
substream kind with migration, retention, attention, and audience semantics;
never enable it by making `chat` validation permissive.

### B28 — Compaction completes after authorization and inherited context change

**Mode:** Break attempt

**Persona:** Samantha is using a live owner-only document chat while Maya changes
access to material summarized from the main feed.

**Preconditions:** A chat compaction starts from main-document source revision 7
and includes an attachment Samantha is currently allowed to read. A control run
of the study changes only the chat's own post-fence tail.

**Flow:**

1. Samantha queues a new chat message after the compaction source fence.
2. In the invalidation run, the main feed advances to document revision 8 and
   Maya revokes the attachment before the summary returns.
3. The old compactor submits a completion, loses its acknowledgement, and
   retries the same completion.
4. A new inference request projects the chat while another compaction request is
   waiting.
5. Repeat as a control with the same queued chat message but no source or
   authorization revision change.

**Expected user-visible behavior:** In the invalidation run, the late summary
never governs and cannot reveal the revoked attachment; projection uses current
authorized raw context or shows `Preparing context`. The duplicate completion is
idempotent and only one replacement compaction may start. In the control run,
the valid summary is reused and Samantha's later admitted message appears once
after it.

**Architecture stress:** The owner must distinguish harmless same-substream tail
growth from changes to the summarized prefix, authorization, or a live inherited
source. Completion validation and one-active-job admission must be atomic.

**Failure oracle:** A revoked phrase in a prompt, missing post-fence message,
waterline advancement by a stale or duplicate completion, two active jobs for
one key, or endless restart on benign tail growth breaks confidentiality,
determinism, or liveness.

**Unresolved pressure:** Define backoff and user-visible terminal behavior when a
high-churn live document repeatedly invalidates compaction faster than a safe
summary can finish.

### B29 — Activity replay crosses every asynchronous boundary

**Mode:** Break attempt

**Persona:** Ren replays one provider event after an activity-consumer defect is
fixed while the destination parent and child are intermittently unavailable.

**Preconditions:** The original webhook was acknowledged, its normalized row is
`failed`, one earlier Queue attempt reached suggested-work batching, and one
native activity-log projection acknowledgement was lost. The exact raw payload
still exists in regional R2.

**Flow:**

1. Ren selects the one failed activity for bounded replay rather than resetting
   the workspace.
2. The provider redelivers the same event while the replay is running.
3. Deterministic automation and route claims are retried; the work-stream
   delivery acknowledgement is lost after the child commit.
4. The child retries a native Avalon event outbox while the provider activity's
   one canonical log event remains owned by the regional activity processor;
   opportunity admission retries its batch result.
5. The `WorkspaceDO` is unavailable while any resulting card projection is sent.
6. All systems recover and reconcile by durable IDs and source hashes.

**Expected user-visible behavior:** At most one automation effect, incorporated
activity/action, activity-log event, and opportunity exists. The relevant card
eventually appears without a duplicate notification. Operators can see every
retry and final disposition without reading raw content by default.

**Architecture stress:** Provider uniqueness, payload hash, activity processing
lease, exclusive claims, route delivery ID, child receipt, log dedupe key,
opportunity source fingerprint, and parent projection versions must compose
across independently retried systems. Canonical producer rules must prevent the
provider and child paths from describing one semantic event twice.

**Failure oracle:** Any duplicate external effect, transcript card, digest item,
or opportunity; a permanently silent failed row; unbounded fleet replay; or a
parent outage causing child rollback demonstrates missing identity or authority.

**Unresolved pressure:** Define one operator-visible causal trace joining the
receipt, activity, claim, batch, opportunity, delivery, child part, log event,
and parent projection without storing sensitive payload in the trace.

### B30 — Personal activity is accidentally admitted as workspace work

**Mode:** Break attempt

**Persona:** Mateo has a personal Gmail connection in a workspace where Maya and
Samantha can otherwise see most work streams.

**Preconditions:** A personal email mentions a workspace project and the same
external person appears in a workspace-scoped Linear event. Admission and ranking
consider both events near the same time.

**Flow:**

1. The personal email and workspace Linear event enter separate normalized
   activities and batch partitions.
2. Identity resolution links the same external address to an Avalon member.
3. A faulty semantic result proposes one combined opportunity and an existing
   workspace work stream.
4. Ranking prepares sets for Mateo and Maya, and a route attempts child delivery.
5. Mateo dismisses his private suggestion; Maya refreshes home and the stream.

**Expected user-visible behavior:** The mixed-audience decision is rejected or
split at the audience boundary. Only Mateo can see content or a suggestion
derived from his personal Gmail connection. Maya may see a Linear-only
opportunity if independently useful, but no title, provenance, identity link,
target, action, digest, or ranking explanation reveals the email.

**Architecture stress:** Audience is a required input to batch partitioning,
admission, provenance nodes, opportunity fingerprints, ranking, display
projection, child delivery, model projection, feedback, and diagnostics—not a
late renderer filter.

**Failure oracle:** A shared fingerprint merges the records, a workspace card
contains a Gmail phrase, a personal provenance node is reachable from Maya's
snapshot, a D1 feedback query teaches across the boundary, or Global sees either
activity's content.

**Unresolved pressure:** Specify whether a user may explicitly promote personal
evidence into a workspace work stream and the review/attribution operation that
makes that a newly authorized disclosure.

### B31 — Suggested-work promotion crashes at every handoff

**Mode:** Break attempt

**Persona:** Maya starts the same suggestion from a laptop and menu bar while
regional services are recovering from an outage.

**Preconditions:** Both clients use the same start idempotency key. The
opportunity is version 7, will expire soon, and references eight authorized
provenance resources. A later ranking pass supersedes the visible set.

**Flow:**

1. Attempt A crashes after D1 moves the opportunity to `starting`.
2. Attempt B crashes after the parent reserves a hidden child.
3. Attempt C crashes after the hidden child writes metadata but before its
   opening part.
4. Attempt D initializes the child and common projection but loses the D1
   finalization response.
5. The second client retries while version 8 is now in Maya's suggested set.
6. Maya loses source-resource access, and a reconciler resumes from all durable
   receipts.

**Expected user-visible behavior:** Maya sees one bounded Starting state. Because
the source epoch changed before the final parent commit, no work stream becomes
visible; the claim terminalizes and the hidden reservation is quarantined or
tombstoned. In a control run with unchanged epochs, one work stream and no
Starting card appear atomically with one complete opening turn.

**Architecture stress:** The promotion saga needs an immutable content snapshot
but current permission at every stage, origin uniqueness, hidden initialization,
one opening-part key, a D1 finalization receipt, one parent-visible commit point,
expiry rules, and repair that knows which authority owns each stage.

**Failure oracle:** Two child IDs, a registered empty child visible forever, two
opening turns, a retry silently using version 8 content, a revoked resource
hydrated after the claim, or a permanently `starting` opportunity breaks
promotion correctness.

**Unresolved pressure:** Set the user-visible timeout and cancellation behavior
for Starting and the retention/repair policy for an initialized but never
published child.

### B32 — Common and personal collection replacements race a scope change

**Mode:** Break attempt

**Persona:** Maya changes a sensitive work stream from workspace-visible to
personal while Mateo is mentioned and several clients page the workspace.

**Preconditions:** A common version marks the stream running; Mateo-specific
versions mark him mentioned and unread; a parent-owned pin exists. Old, new, and
duplicate replacements are held in different outboxes, and deletion will follow
the scope change.

**Flow:**

1. The parent installs the new listing-scope deny floor and masks Mateo's card,
   then the child commits the same scope epoch and removes him.
2. The parent receives the old personal replacement, new common replacement,
   status replacement, and a duplicate old common replacement out of order.
3. Mateo fetches page two with a cursor taken before the change, has home open on
   a connected device, and has an offline device holding an older snapshot.
4. The stream is deleted; its tombstone arrives before one final outbox retry.
5. Parent projection shards, if enabled, recover in a different order.

**Expected user-visible behavior:** Mateo loses the card, pin, mention, unread,
and every collection reference from current server responses and connected
clients as soon as the deny floor applies. An old page cursor resets or omits it,
home and sidebar converge, and no late replacement or shard repair resurrects
it. The server cannot erase already downloaded offline bytes; the offline client
purges them before rendering on its next authenticated contact.

**Architecture stress:** Complete per-key replacement is necessary but not
sufficient: listing eligibility and deletion epochs must dominate lower-epoch
facts across common, personal, parent-local pin, pagination snapshots, client
cursors, and hidden physical shards.

**Failure oracle:** A title-only ghost from a current response, inaccessible
pinned row, You Are Mentioned leak, stale connected-page disclosure,
resurrection after deletion, failure to purge on reconnect, or different
home/sidebar visibility shows that collection cleanup is not one authority-
ordered operation.

**Unresolved pressure:** Define the exact epoch carried by parent-owned pin rows
and cached client snapshots, plus how projection shards receive a synchronous
deny fence without putting ordinary updates through a global lock.

### B33 — A private suggested action is revoked before it is accepted

**Mode:** Break attempt

**Persona:** Mateo receives a suggested action from his personal Gmail in a
workspace-visible release work stream shared with Maya.

**Preconditions:** The action is delivered only to Mateo with version 4, a
ten-minute expiry, and connection/resource authorization epochs. It contains a
private email subject that must not reach shared transcript or model context.

**Flow:**

1. The child inserts the action in its Mateo-audience operational table and adds
   Needs Your Input to Mateo's workspace projection.
2. Maya opens the work stream, exports it, searches it, and runs a compaction.
3. Mateo disconnects Gmail, but the D1 retraction delivery is delayed.
4. Mateo clicks Accept from a stale connected UI while version 5 supersedes the
   classifier result and the original action expires.
5. The retraction arrives twice after the click.

**Expected user-visible behavior:** Maya never sees the pending title in the
transcript, sockets, export, search, digest, compaction, or model prompt. Mateo's
accept fails as expired/revoked before disclosure or effect; the child converges
once on `retracted`, clears Needs Your Input, and duplicate delivery changes
nothing. Explicit sharing would require a fresh authorized confirmation.

**Architecture stress:** Pending actions need principal audience, immutable ID
and version, current source-authorization checks on read and accept, expiry,
idempotent retraction, private realtime/export filtering, and a separate explicit
share operation. `people` visibility alone is insufficient.

**Failure oracle:** Any Gmail phrase reaches Maya or the model, stale acceptance
authors a shared part or external write, the card reappears after retraction, or
the user-specific interest signal remains stuck.

**Unresolved pressure:** Define how much redacted audit evidence remains after a
private source is disconnected and who, if anyone, may inspect it under
break-glass policy.

### B34 — Resource ACL filtering and digest scheduling overload the parent

**Mode:** Break attempt

**Persona:** Elena's 10,000-member workspace has a digest window after a busy
morning across public and private GitHub repositories.

**Preconditions:** Many members can list the same work streams but only small
subsets can read individual private repositories. Provider processing routed
some activities into children, and 5,000 digests become due in one minute.

**Flow:**

1. The regional activity processor writes one canonical event per provider
   activity with work-stream audience plus event-specific resource selector and
   source revision.
2. Child incorporation outboxes retry but must not create a second digestible
   description of those provider events.
3. Digest scheduling jitters and groups due people into bounded workspace
   batches rather than issuing 5,000 simultaneous parent calls.
4. One repository ACL is revoked after events were written but before reads.
5. Parent visibility and regional resource-policy batches filter each candidate;
   one batch times out and fails closed before retry.

**Expected user-visible behavior:** Every member receives at most one authorized
description of an occurrence. Repository titles are omitted for people without
current access, even when they can see the containing work stream. Digests may be
delayed in a visible retry state, but parent authorization and sidebar traffic
remain responsive.

**Architecture stress:** Historical event audience, per-event source revision,
two-layer batched authorization, canonical producer identity, scheduler jitter,
parent capacity lanes, and fail-closed retry all interact at enterprise scale.

**Failure oracle:** A private repository title leaks, provider and child produce
duplicate digest items, unknown authorization is treated as allowed, or digest
fan-out saturates the parent enough to block membership and sidebar operations.

**Unresolved pressure:** Load tests must set batch sizes, jitter windows,
priority lanes, timeout/retry SLOs, and the threshold where authorization work
moves behind transparent workspace projection shards.

### B35 — Queue replay escapes a paused fleet campaign

**Mode:** Break attempt

**Persona:** Ren pauses an online backfill after a canary mismatch while old,
duplicated, reordered, delayed, and DLQ-replayed Queue messages remain in
flight.

**Preconditions:** Jobs A and B target successive slices of one object. Each
Queue message carries a shard wake only; each object command has a stable ID
and request hash. A fixed shard set issues bounded, expiring admission permits.

**Flow:**

1. Queue delivers B before A, duplicates A, and delays a second copy of B.
2. A mismatch crosses the error ceiling and the `RegionalMigrationDO` enters
   `pausing`, advances the desired epoch, and asks every fixed shard to fence.
3. A previously permitted bounded slice settles while the stale delayed wake
   reaches an already fenced shard; only after all permits settle/expire does
   the region acknowledge `paused`.
4. A duplicate command ID arrives with a different request hash.
5. Ren repairs the manifest, resumes under a new epoch, and replays the DLQ.

**Expected user-visible behavior:** Ordinary work-stream traffic remains
available. No new migration slice begins after the `paused` acknowledgement;
the UI distinguishes `pausing` while pre-admitted work drains. Resume continues
from the object-local cursor exactly once rather than assuming Queue order.

**Architecture stress:** A remote control-DO recheck followed by target RPC
cannot linearize pause. Shard-local permit issuance is the admission point, and
regional pause completes only after all shards fence and drain. The object's
migration journal and immutable command receipts, not Queue acknowledgement,
determine outcome.

**Failure oracle:** `paused` acknowledged while a live permit exists, any new
permit after a shard's fence, a target starting with an expired permit, B
applying against the wrong cursor, different content accepted under one command
ID, or a whole batch repeating because one item failed breaks campaign safety.

**Unresolved pressure:** Set the manifest shard count, permit TTL and maximum
slice bound, pause-drain SLO, DLQ repair authorization, and the exact result
returned for an out-of-order but otherwise valid command.

### B36 — The final authority-copy hold overflows around route CAS

**Mode:** Break attempt

**Persona:** Samantha's hot work stream receives thousands of desktop and
provider inputs while authority cutover takes longer than its normal
interactive window.

**Preconditions:** Every legacy writer uses one D1 authority-row transaction.
The row can move `legacy -> holding -> closing_hold -> do`; the target remains
side-effect-free until it receives proof of the committed route.

**Flow:**

1. Held traffic exceeds the expected byte or item budget.
2. The controller enters `closing_hold`, stops acknowledging new ingress, and
   records a final hold sequence.
3. A stale old writer attempts to append directly.
4. The target prepares through the final sequence; the migrator crashes once
   before route CAS and, in a second fault injection, immediately after it.
5. Providers retry backpressured deliveries; the first direct routed request
   opens the prepared target epoch using the route receipt.

**Expected user-visible behavior:** The product applies documented
backpressure rather than acknowledging unbounded held writes. Every command
acknowledged during `holding` is already present once before route CAS; each
unacknowledged `closing_hold` retry lands once after cutover. No release phase
is exposed to the user.

**Architecture stress:** The protocol removes the impossible cross-database
route-plus-release transaction. The D1 gate fences every old writer, a finite
final hold is imported before target preparation, and route CAS publishes only
a matching prepared hash. The target opens from the route receipt.

**Failure oracle:** An acknowledgement without durable hold storage, route CAS
before prepared-hash/final-sequence proof, any required post-route release,
held-input loss/duplication, a stale direct append, target side effects before
route proof, or rollback to old authority after route commit breaks the copy.

**Unresolved pressure:** Define hold capacity, `accepted_pending_migration` and
backpressure UX, maximum closing window, provider retry contracts, and how long
source/hold/route receipts remain after successful cutover.

### B37 — A child gets ahead of its parent contract

**Mode:** Break attempt

**Persona:** Maya's canary workspace experiences a partial deployment and an
operator rollback during a parent-before-child protocol expansion.

**Preconditions:** One child runs N+1 code, its parent reports N support only,
and a different parent has acknowledged N+1. Old child outboxes may be delayed
for days.

**Flow:**

1. The N+1 child attempts to send a new replacement form to the N parent.
2. The parent is upgraded and acknowledges N+1, then its Worker rolls back.
3. A delayed N replacement arrives after a newer N+1 replacement.
4. Cleanup attempts to remove the N parser based only on schema-version counts.

**Expected user-visible behavior:** The sidebar remains correct or shows a
typed temporarily stale state. The child uses only an acknowledged compatible
form; rollback never causes partial parsing, and cleanup remains blocked while
old envelopes can legally exist.

**Architecture stress:** Protocol support, schema version, current code version,
and last acknowledgement are distinct inventory facts. Complete-replacement
semantics prevent a mixed field set but require a durable compatibility floor.

**Failure oracle:** Best-effort parsing, child-side guessing from deployment
version, loss of a personal collection field, old-parser removal before outbox
drain proof, or rollback below the acknowledged floor breaks compatibility.

**Unresolved pressure:** Define the N/N-1 service and socket support window,
rollback gates, acknowledgement invalidation rules, and a typed quarantine for
envelopes outside the window.

### B38 — A stateful deploy reconnects an entire region at once

**Mode:** Break attempt

**Persona:** Mateo and thousands of other users are connected when a stateful
DO deployment restarts workspace and foreground-child sockets without a drain
guarantee.

**Preconditions:** Clients hold last acknowledged parent and child cursors.
Some retained event windows can replay; others require snapshot/reset. Router
and stateful Workers are independently deployable.

**Flow:**

1. The stateful release disconnects a large socket cohort.
2. Clients use jittered retry and `resume_after`, while offline clients pause
   their backoff.
3. A subset reconnects with N-1 socket attachments and envelope versions.
4. Parent projections and active child output advance during reconnect.
5. Some cursors have expired and receive one snapshot/reset at a new cursor.

**Expected user-visible behavior:** Users see a short reconnect state, then the
same sidebar, waterline, and transcript without duplicate final answers.
Clients do not hammer the handshake endpoint or reconnect again because their
ticket expired.

**Architecture stress:** Hibernation does not provide deploy drain. Jitter,
admission limits, N/N-1 constructor/attachment support, replay retention, and
snapshot reset jointly bound the storm. Frequent router releases must not
restart stateful sockets.

**Failure oracle:** A synchronized retry spike above the published envelope,
lost acknowledged messages, regressed seen state, duplicate active/final text,
or repeated reconnect loops fails the release gate.

**Unresolved pressure:** Set regional reconnect cohort limits, jitter/backoff,
ticket issuance capacity, replay bytes/events, reset rate, and canary abort
thresholds from a full-scale deployment rehearsal.

### B39 — Mutable-tail replay crosses a checkpoint crash

**Mode:** Break attempt

**Persona:** Mateo watches a maximum-rate 30-fps stream when the object restarts
between a UI frame and the next 250–1000 ms durable checkpoint.

**Preconditions:** Provisional UI frames carry `(frame_seq,
base_durable_event_seq)`. Durable checkpoint/semantic events carry
`(event_seq, through_frame_seq)`, and the executor retains both lanes beyond the
owner's last durable acknowledgement.

**Flow:**

1. The client renders several provisional frames newer than the durable tail.
2. The object restarts before checkpointing them.
3. Reconnect returns the durable active snapshot, which is briefly shorter than
   the text Mateo saw.
4. The executor replays missing event sequences.
5. A second crash occurs during finalization before the client sees terminal
   state.

**Expected user-visible behavior:** Text may rewind only within the configured
provisional window and then returns exactly. The final transcript contains one
immutable answer and terminal fact; no active-output copy remains.

**Architecture stress:** Thirty UI frames per second and one-to-four durable
checkpoints per second are intentionally independent. The owner may acknowledge
only the transaction that stored all text through `through_frame_seq`; attempt
epoch, active revision, the two durable cursors, and finalization reject
overlapping replay.

**Failure oracle:** A durable cursor ahead of persisted text, executor discard
based on a UI-delivery cursor, rewind beyond the configured interval, missing or
repeated characters, persistence at UI-frame cadence, tool/status loss behind a
timer, or both active and final canonical rows breaks streaming truth.

**Unresolved pressure:** Select the checkpoint policy only after measuring
failure rewind, upstream retention, page amplification, PITR growth, and billed
row/index writes under representative model concurrency.

### B40 — Object PITR is mistaken for fleet rollback

**Mode:** Break attempt

**Persona:** Ren discovers that a destructive campaign corrupted 8,000 objects
after some accepted new writes and a stateful Worker rollback.

**Preconditions:** The regional recovery ledger, outside each target object,
recorded the pre-phase SQLite PITR bookmark and restore generation. Cloudflare
provides object-local restore within its documented window, not an atomic fleet
restore or guaranteed fleet restore rate.

**Flow:**

1. Ren pauses the campaign, deploys compatible repair code, and installs a
   regional route quarantine before any restore.
2. Affected objects have different bookmarks and different post-bookmark
   accepted writes, external receipts, and parent projections.
3. The parent advances authority/listing/deletion floors, denies new grants,
   marks the child restoring, and closes its sockets/runs.
4. Operators restore one canary and force its restored unified alarm to fire
   before the recovery RPC. The alarm's external generation check suppresses
   its stale local due schedule with no product side effect.
5. The recovery RPC reinstalls current
   authority floors, replays a proven complete post-bookmark source, rotates
   grants, and reconciles parent projection before a fenced route reopen.
6. Regional capacity cannot restore every object simultaneously.

**Expected user-visible behavior:** The product reports scoped repair progress
and does not claim that rolling back Worker code restored data. Restored
objects remain unavailable/restoring until they preserve or explicitly
reconcile accepted post-bookmark work and current revocations before returning
to service.

**Architecture stress:** PITR can resurrect stale membership, grants, deletion
floors, receipts, and journals. Fleet inventory selects candidates, but each
restore needs external command/bookmark state, route/parent quarantine, a
complete replay source, current-floor reinstall, verification, and fenced
reopen. The alarm is direct DO ingress, so its first action must consult the
external recovery generation before touching restored work. Without all of them
the only safe outcome is repair-forward.

**Failure oracle:** Treating Worker rollback as storage rollback, recording the
only bookmark inside the restored DB, serving before current revocation floors,
restoring without complete replay proof, losing post-bookmark writes, or
allowing an alarm to run a tool/notification/projection/outbox/compaction/
deletion/retry before reconciliation, or silently routing to an old D1
authority breaks recovery.

**Unresolved pressure:** Measure restore throughput and define quarantine SLO,
complete-replay qualification/retention, workspace-parent recovery evidence,
verification, projection repair, and customer communication for an object-by-
object emergency campaign.

### B41 — Regional directory and Cloudflare namespace disagree

**Mode:** Break attempt

**Persona:** Ren audits a region where D1, parent directories, allocation
receipts, and Cloudflare namespace enumeration disagree after months of mixed
creation and retirement.

**Preconditions:** The Cloudflare API lists only opaque object IDs and whether
they store data; pagination is not a fleet-wide snapshot and may overlap
concurrent object creation/deletion.

**Flow:**

1. D1 references a child absent from its parent's current directory.
2. A parent directory references a child missing from D1.
3. Namespace enumeration finds a stored object with no regional mapping.
4. D1 marks another object retired while its namespace object retains data.
5. Creation and deletion occur during paginated audit passes.

**Expected user-visible behavior:** No product request depends on the account
API, and the audit does not delete or expose an object merely because one pass
cannot explain it. Known discrepancies become typed regional repair cases and
converge over later passes.

**Architecture stress:** The `WorkspaceDO` directory is authoritative for the
parent-child relationship, D1 is the fleet projection/job ledger, allocation
receipts prove intent, and namespace enumeration is only an operator aid.

**Failure oracle:** Treating namespace listing as product truth, guessing a
workspace from an opaque object ID, automatic deletion of an unexplained
stored object, or declaring parity from one changing pagination pass breaks
reconciliation.

**Unresolved pressure:** Define orphan classes, quarantine and retirement
durations, multi-pass convergence, proof needed for cleanup, and operator access
to account credentials outside Worker variables.

### B42 — An optional Container becomes an abuse and cost amplifier

**Mode:** Break attempt

**Persona:** A malformed or adversarial migration manifest repeatedly requests
an unsliceable transform over oversized chunks and expensive egress.

**Preconditions:** The Container path scales to zero but can still incur burst
cost. Queue delivery is at least once, and a process may be retried after losing
its completion response.

**Flow:**

1. Thousands of duplicate opaque jobs attempt to start Containers.
2. A chunk expands far beyond its advertised output size.
3. The process tries unauthorized network egress and to retain a listening
   browser socket.
4. It exits successfully without writing the expected hash or D1 checkpoint.
5. Cost and error ceilings pause the campaign while delayed jobs remain queued.

**Expected user-visible behavior:** User traffic remains isolated. Admission
deduplicates and caps Container concurrency, resources, runtime, output, egress,
and regional cost. The campaign pauses, and idle capacity returns to zero.

**Architecture stress:** Scale-to-zero controls idle cost, not abuse. The
regional job ledger, allowlisted image/entrypoint, least-privilege bindings,
network policy, hashed R2 output, and target verification must bound every run.

**Failure oracle:** A Container reachable as a socket endpoint, authority based
on process exit, unrestricted product bindings/egress, duplicate billable work
for one command, or continued starts after pause breaks the optional path.

**Unresolved pressure:** Define an admission proof that Worker slices are
insufficient, then set image provenance, chunk expansion, CPU/memory/runtime,
egress, concurrency, retry, idle, and campaign-cost limits.

### B43 — A supposedly additive constructor migration bricks a hot object

**Mode:** Break attempt

**Persona:** Mateo reconnects to a large work stream just after a release adds
an index whose SQLite build scans millions of parts under
`blockConcurrencyWhile`.

**Preconditions:** The change was classified as lazy additive without a canary
at the largest supported object size. The object also has a hibernated socket
and an active migration/outbox alarm schedule.

**Flow:**

1. Reconnect wakes the new constructor and starts the index build.
2. Constructor time approaches or exceeds the platform gate while ordinary
   messages and replay wait.
3. The object restarts and encounters the same unapplied migration.
4. Other dormant large objects begin waking after a deployment reconnect wave.

**Expected user-visible behavior:** A safe release gate prevents this rollout.
If encountered in canary, Avalon stops expansion and reclassifies the work as a
restartable online backfill while old-compatible code remains available.

**Architecture stress:** "Additive" describes schema compatibility, not runtime
cost. Constructor DDL must be proven small, idempotent, and compatible with
socket wake; large index population belongs in bounded slices and later commit.

**Failure oracle:** An object trapped in constructor restart, user traffic
blocked by an unbounded scan, fleet-wide wake amplification, or a rollback to
code that cannot read the expanded schema breaks deployment safety.

**Unresolved pressure:** Maintain a tested allowlist of constructor operations
and p99 thresholds by storage bucket, and specify how to build and activate a
large index without making incomplete state queryable.

### B44 — A two-hour coding loop crosses retries, early events, and capacity

**Mode:** Break attempt

**Persona:** Mateo delegates a large coding task whose full agent loop runs for
two hours and twelve minutes, including repeated model iterations, tests,
compaction, several bounded Terminal commands, and passive waits.

**Preconditions:** One Workflow instance drives deterministic model/tool/wait
steps. Bind calls the Daytona-backed Terminal plugin. The owner stores attempt
epochs, next-action cursor, effect intents, settlements, budgets, and terminal
state. No configured `step.do` timeout exceeds thirty minutes, and every
Terminal command is capped at fifteen minutes.

**Flow:**

1. At minute 47, a runtime update terminates an in-progress model step after
   provisional text reached the client but before its durable completion. The
   owner resets that entire incomplete attempt and starts a new attempt epoch
   from the last provider-valid fence.
2. A write-tool response is lost after the external effect and owner receipt;
   the Workflow retries its step.
3. A bounded Daytona Terminal command settles before its Workflow step receives
   the response; the step retries and reconciles the stable command receipt.
4. Mateo steers once during an attached provider request and again while the
   Workflow is passively waiting.
5. Other long loops and a restart burst approach the conservative running-
   instance cap and the account/per-Workflow creation rates while this loop
   approaches its configured Workflow-step and subrequest reserves.
6. The loop reconciles, compacts, resumes, and completes after two hours and
   twelve minutes.

**Expected user-visible behavior:** Mateo may see the entire incomplete model
attempt reset after executor loss, never a false promise that a nondeterministic
stream can be reproduced and never a repeated external write. Early/lost/
duplicate Workflow events cannot strand the task because the durable owner
settlement wins, and a retried Terminal step observes its existing Daytona
receipt. The session shows `Waiting for capacity` when necessary, keeps both
steering messages once, and produces one final answer.

**Architecture stress:** Unlimited Workflow instance lifetime does not solve
retry granularity, active concurrency, creation rate, step/subrequest count, or
state growth. Attempt epochs, effect receipts, owner reconciliation, passive
waits, bounded Terminal commands, and terminalization reserves must keep a rare
multi-hour session recoverable without making Daytona the loop orchestrator.

**Failure oracle:** A one-year monolithic step, replay of all prior model/tools
after the runtime update, duplicate write, reliance on `sendEvent` as settlement
storage, blind repetition of a Terminal command, transcript-sized Workflow
results, step-limit exhaustion without terminalization, subrequest exhaustion,
treating a creation-rate HTTP 429 as an admitted run, or a second final answer
breaks the design.

**Unresolved pressure:** Set launch budgets for elapsed and idle time, model
iterations, tool calls, tokens, cost, bytes, child fan-out, Workflow steps and
subrequests and reserves, plus product queue limits, account-confirmed running
capacity, and admission SLOs derived from the two-to-thirty-minute distribution
and rare two-hour tail.

## Coverage matrix

| Concern | Primary studies | Evidence the design needs |
| --- | --- | --- |
| Normal multiplayer collaboration | S01, B06, B22 | One committed order, participant semantics, explicit source provenance, and idempotent optimistic reconciliation. |
| Sidebar metadata and control pane | S02, S20, B01, B02, B04, B05, B21, B32 | No child fan-out, one common card, derived lifecycle/recency collections, sparse per-person overlays, bounded lag, stable paging, and a sharding threshold. |
| Main-screen work streams of interest | S20, S22, B30, B32, B33 | One item dictionary and snapshot revision shared with the sidebar, deterministic deduplication, and audience-safe personal collection references. |
| Unread, mentions, waterlines, and pins | S02, S20, B02, B04, B21, B32 | Main-feed-only attention, non-regressing waterlines, mention preservation through independently ordered replacements, parent-owned pin conflicts, and epoch-dominant cleanup. |
| Private chats and audience safety | S04, S13, B03, B08, B09, B25, B28 | Storage-level audience enforcement across projection, compaction, export, diagnostics, notification, and hydration. |
| Human forks | S05, B07, B09 | Immutable completed-turn fences, paired historical tool calls/results, and explicit publication rather than implicit merge. |
| Sub-agents | S06, B16, B25 | Exactly-once parent result, no ambient authority, bounded depth and breadth, responsive parent sequence, and repairable child state. |
| Substream semantic boundary | S04, S05, S06, B09, B16, B27 | Closed valid combinations, one local owner, no channel/thread/job/storage overloading, same-substream retry, and explicit publish-back. |
| Message-array fidelity | S01, S05, S08, S18, S19, B07, B08, B09, B22 | Provider-valid roles and tool pairs, deterministic fences and input cuts, reproducible document renderings, and safe compaction selection. |
| Concurrent compaction | S19, B08, B18, B28 | Immutable source fence and hash, non-blocking sends, raw post-fence tail, revision-safe completion, one active job per key, and bounded fallback. |
| Streaming durability and cost | S03, S07, S29, B23, B39, B44 | Immediate first frame, UI batching independent from mutable-tail writes, bounded provisional rewind when the executor survives, explicit whole-attempt reset when it does not, no duplicate final message, and write count independent of token count. |
| Queued and steering input | S07, S08, S18, B06, B26 | Explicit delivery intent, durable arrival before acknowledgement, queue-without-interrupt, safe steering, FIFO admission cuts, reconnect, cancellation, and coalesced revisions. |
| Interruption during inference | S07, S18, B06, B26 | Durable steer-before-signal, revision checks, one active mutating turn, and deterministic coalescing of corrections. |
| Seconds-long tool execution | S08, B17 | Declared cancellation semantics, complete tool lifecycle, current authority at invocation, and quick visible recovery. |
| Terminal p95 and three-to-five-minute tail | S09, B10, B16, B26, B44 | Existing Daytona-backed Bind plugin, honest waiting state, safe cancellation/settlement, fifteen-minute command cap, aggregate budgets, stable command receipts, and no parent token traffic. |
| Full agent-loop lifetime | S17, S31, B15, B24, B44 | One Workflow instance per full loop, deterministic model/tool/reconcile/wait steps, 2–30 minute normal and rare 2+ hour support, Paid-limit budgets for steps/subrequests/state/payloads/creation/concurrency, owner receipts, passive-wait concurrency release, terminalization reserve, and many bounded Terminal calls rather than one multi-hour command. |
| Ambiguous writes | S10, B07, B24 | Record-before-execute, causal effect intent stable across retries, reconciliation, `needs_input`, and no blind replay. |
| Offline and reconnect | S02, S03, S28, B05, B23, B38, B39 | Cursor replay, snapshot reset for expired cursors, monotonic user state, no periodic reconnect, bounded jitter, and explicit stale/degraded UI. |
| Provider ingress | S11, S21, B11, B13, B22, B29, B30, B34 | Global envelope minimization, regional body processing, hash-aware deduplication, audience partitioning, route fencing, and commit-order provenance. |
| Activity ingestion and first-party log | S21, S22, B22, B29, B30, B34 | Regional R2 payloads, normalized D1 activity, opaque queues, deterministic claims, canonical producers, event-specific authorization, idempotent child delivery, ordered log projection, dead letters, and bounded replay. |
| Suggested work | S21, B29, B30, B31 | Stored background ranking, per-person state, source-epoch deny floors, bounded parent display cache, distinct opportunity identity, current authorization, a hidden child gate, and one visible parent promotion commit. |
| Suggested actions in existing work | S22, B29, B30, B32, B33 | D1 routing/feedback authority, child audience-scoped operational authority, version/expiry/retraction, explicit sharing, sparse assignment signals, and disabled-surface enforcement. |
| Scheduled automation | S12, B13, B24 | Stable occurrence identity, one admission, pre-run context, target liveness checks, and safe late alarms. |
| Export and deletion | S13, S14, B10, B12, B24 | Audience-aware point-in-time manifests, resumable fan-out, reference cleanup, deletion epochs, and no resurrection. |
| EU and Global isolation | S11, S15, S27, B11, B12, B14, B20, B25, B35 | Jurisdictional bindings, non-product Global wake schema, product resolution first inside a jurisdictional shard, regional application logs/storage, explicit Cloudflare operational-ID logging review, no Regional-Services subrequest assumption, and hard no-fallback controls. Terminal retains its separate Daytona residency gate. |
| Migration and cutover | S16, S23, S24, S25, S26, S27, B13, B35, B36, B37, B40, B41, B43 | Lazy object creation, journal-authoritative slices, jurisdictional shard admission, compatibility gates, atomic legacy authority-row/hold writes, prepare-before-route CAS, quarantine, forward repair, and reconciled fleet evidence. |
| Lazy additive schema migration | S23, B43 | Idempotent constructor DDL before request service, no dormant-object wake, observed-version reporting, large-fixture canaries, and a proven constructor-time ceiling. |
| Fleet sweep and online backfill | S24, B35, B43 | Regional D1 jobs, campaign Workflow, opaque shard wakes, fixed shard admission permits, visible pause drain, object-local checksummed cursors, bounded slices, and later cleanup. |
| D1/R2-to-DO authority copy | S25, B13, B36, B40 | Immutable regional snapshot/chunks, side-effect-free shadow generation, transactional D1 authority gate/hold, finite final sequence, prepare-before-route CAS, no post-route release, and retained source. |
| Parent-before-child protocol rollout | S26, B04, B37 | N/N-1 receiver expansion, durable acknowledgement, complete replacements, delayed-envelope reconciliation, rollback floor, and inventory proof before contraction. |
| Regional Queue/Workflow dispatch | S27, B14, B35 | Non-product shard wake, Worker with only a jurisdictional-shard binding, product resolution inside that shard, no Regional-Services subrequest claim, shard-local admission, and fail-closed unsupported residency. |
| Realtime socket topology and hibernation | S28, B03, B05, B38 | One parent plus one foreground-child hibernatable socket, zero background application heartbeat, no ticket-rotation reconnect, authorization epochs, and cursor resume. |
| Deploy-induced reconnect | S28, B38 | Stable stateful/router separation, N/N-1 attachments, jittered cohorts, offline-aware backoff, replay/snapshot reset, and a published regional load envelope. |
| Mutable active-tail persistence | S29, B23, B39, B44 | At most 30 provisional UI frames per second, separately measured 250–1000 ms checkpoints, atomic text-through-frame acknowledgement, immediate semantic commits, exact replay only from a surviving executor, failed-attempt reset, and transactional immutable finalization. |
| Object-local PITR | B40 | Externally recorded bookmark/command, route and parent-grant quarantine, alarm generation gate, complete replay proof, restored current deny floors, fenced reopen, capacity-aware repair, and no storage claim from Worker rollback. |
| Directory and namespace reconciliation | S16, B41 | Parent directory as relationship authority, D1 as fleet projection, allocation/retirement receipts, multi-pass opaque namespace audit, quarantine, and proof before cleanup. |
| Optional Cloudflare Container | S30, B42 | Exceptional admission only, regional opaque job and R2 chunks, least privilege, resource/egress/cost ceilings, hashed verification, no socket or authority, and scale to zero. |
| Huge workspaces and hot parents | S16, B01, B02, B21, B34 | Measured eligibility limits, sparse storage, priority lanes, stable pagination, jittered batch authorization, and transparent sharding behind one interface. |
| Huge or hot work streams | B10, B16, B18, B23 | Bounded hydration and streaming, child budgets, archive/segment strategy, and retained logical sequence semantics. |
| Child/parent projection lag | S02, S14, S20, B04, B05, B32 | Complete replacement outbox, clear staleness, per-key versions, collection recomputation, tombstone/epoch dominance, and deterministic rebuild. |
| Non-work-stream agent loops | S17, S31, B15, B24, B44 | Generic durable mechanics plus domain-owned state, full-loop multi-step execution, executable adapter conformance, opaque inputs, and retry-safe output. Coding remains an optional Terminal tool rather than a work-stream-only host assumption. |
| Regional and user lifecycle changes | B03, B14, B17, B19, B20, B24 | Membership and deletion epochs, live authority checks, explicit unsupported movement, and region-aware discovery. |
| Operations and audit | S10, S15, S16, S24, S27, S30, S31, B11, B25, B35, B40, B41, B42, B44 | Content-minimized correlation, regional manifests and journals, observable pause/ambiguity, migration evidence, object-scoped recovery, long-loop and Terminal receipts/budgets, cost ceilings, and authorized repair. |

## Prioritized architectural questions

### P0 — Resolve before implementation can claim correctness

1. **What are the workspace authorization protocol's concrete limits?** Set
   capability TTL, signing/key rotation, open-socket eviction, run cancellation,
   active-grant indexing, and the maximum stale-authority window under a dropped
   fan-out. B03 and B05 make those values release gates.
2. **How do we prove every legacy writer uses the specified D1 authority-row
   gate?** The protocol now makes each old mutation or durable hold insertion
   share one D1 transaction, closes the hold to a finite sequence, prepares the
   side-effect-free target, and then publishes one route CAS with no post-route
   release. Implementation still needs a machine-checked registry covering
   desktop, provider, scheduler, tool-result, attention, export, deletion, and
   repair writers, plus hold capacity/backpressure limits. See S25, B13, B36.
3. **How are incomplete tool turns durably reconciled?** The owner needs a
   wake-up, timeout, provider reconciliation contract, and exactly-one result
   rule for crashes at every point around execution. See S10 and B07.
4. **How is the compaction authorization revision vector canonicalized?** The
   design names principal visibility, membership/scope, tool policy, attachment
   and connector authorization, recursive lineage sources, model family,
   renderer, and system-template revisions; storage encoding, invalidation, and
   old-summary collection need an exact contract before private substreams can
   ship. See B08 and B28.
5. **What background execution and logging configuration satisfies the EU
   promise?** Queue, Workflow, cron, model and tool subrequests, Terminal,
   analytics, support access, and failure behavior must be verified. Migration
   triggers carry only the non-product shard tuple, their Worker binds only a
   jurisdictional shard, and product resolution starts there; Regional Services
   does not localize Worker subrequests. Cloudflare's documented external
   billing/debug logging of opaque DO IDs also needs DPA/SCC, retention, access,
   and legal disposition. Unsupported dependencies fail closed. See S15, S27,
   and B14.
6. **Who durably coordinates whole-workspace export and deletion?** The design
   needs a regional owner, child inventory, snapshot/deletion fence, retry
   manifest, legal-hold policy, and parent lifetime. See B12 and B24.
7. **What exact checkpoint/resume interface makes a full loop durable?** The
   current one-year `run-authorized-bind-loop` step must become deterministic
   model, tool-admit/execute/settle, compaction, reconcile, wait, and terminalize
   boundaries without changing message-array or tool semantics. Define attempt
   epochs, step names, resume state, early/lost event recovery, and conformance
   tests, including stable Daytona Terminal command reconciliation. The suite
   must also enforce Paid-plan state/event/result, step, subrequest, retry,
   creation/restart, queue, and account-confirmed running-instance budgets before
   claiming 30-minute or two-hour loop safety. See S31 and B44.

### P1 — Resolve before broad production rollout

8. **At what measured size or request rate does a workspace require projection
   sharding?** Set limits for child count, member count, projection writes,
   concurrent reads, storage, and lag, with priority lanes and a sharding scheme
   hidden behind the `WorkspaceDO` API. See B01 and B02.
9. **What are sparse per-person sidebar defaults and fan-out limits?** Joining a
   workspace must not create state for every work stream; team mentions,
   attention baselines, and retention need bounded behavior. See B02.
10. **What completes the per-key sidebar consistency contract?** Define update
   SLOs, key initialization and garbage collection, coalescing, tombstone
   precedence, repair, pagination snapshot semantics, and the user-visible stale
   state. See B04, B05, and B21.
11. **What are sub-agent aggregate limits?** Depth four needs breadth,
    concurrency, token, tool, time, part, return-size, and storage budgets plus
    cancellation and partial-result behavior. See S06 and B16.
12. **How does a work stream age beyond one object's practical live-storage
    envelope?** Quantify the limit and design cold segments or archives that
    retain one logical sequence, audience enforcement, projection, export, and
    deletion. See B18.
13. **What makes a generic target adapter safe by construction?** Specify the
    typed runtime protocol and conformance suite for authority derivation,
    opaque inputs, idempotent append/settle, revision checks, cancellation,
    budgets, and reconciliation. See S17 and B15.
14. **What is the exact content-reference lifecycle?** Bound summaries,
    hydration, hash failures, regional placement, retention, garbage
    collection, repair, and export behavior by payload kind. See S13 and B10.
15. **How are streaming retries and socket backpressure represented?** Define
    checkpoint identifiers, attempt overlap, client reconciliation, buffer
    bounds, slow-client policy, and expired cursors. See S03 and B23.
16. **What bounds and UX complete queued and steering input?** Set pending
    message and byte limits, steering rate limits, admission batching and
    authorship rendering, cancellation and edit rules, fairness across people,
    and behavior while a write remains ambiguous. See S18 and B26.
17. **What bounds concurrent compaction under sustained conversation?** Set
    token and part thresholds, one-key coalescing, active-key limits, backoff,
    `Preparing context` latency, raw-tail growth behavior, and the terminal state
    when live-source or authorization churn repeatedly invalidates summaries.
    See S19 and B28.
18. **What is the end-to-end activity delivery and replay contract?** Define
    claim exclusivity, delivery IDs, child and log receipts, retry/dead-letter
    thresholds, event-specific authorization selectors, canonical producers,
    digest batch scheduling, causal tracing, bounded replay authority, and
    retention across R2, D1, child, and parent. See S21, S22, B29, B30, and B34.
19. **What makes opportunity promotion complete or safely repairable?** Specify
    immutable content versus current permission, source epoch revalidation,
    parent origin uniqueness, hidden child initialization, opening-part identity,
    D1 finalization receipt, one parent-visible commit, revocation quarantine,
    and the maximum Starting state. See S21 and B31.
20. **What are the fleet campaign safety envelopes?** Publish allowed
    constructor DDL and p99 limits, fixed shard count, permit TTL/concurrency,
    RPC slice budgets, pause-drain thresholds/SLO, DLQ handling, and the
    evidence required to resume or contract old storage. See S23, S24, B35,
    and B43.
21. **What proves parent/child protocol contraction is safe?** Define durable
    acknowledgement, N/N-1 code and socket floors, rollback gates, maximum old
    outbox age, typed quarantine, and regional inventory predicates before
    removing a form. See S26 and B37.
22. **What is the realtime reconnect envelope?** Measure foreground NAT
    auto-response needs, background parent-socket value, zero-heartbeat behavior,
    replay retention, snapshot/reset capacity, deployment jitter, offline-aware
    backoff, and canary storm thresholds. See S28 and B38.
23. **Which mutable-tail checkpoint policy ships?** Compare 250 ms, 500 ms, and
    one-second policies for row/index writes, fragmentation, PITR growth,
    upstream frame/event retention, atomic text-through-frame acknowledgement,
    prompt reads, finalization, and maximum visible provisional rewind while UI
    batching remains capped independently at 30 fps. See S29 and B39.
24. **What makes emergency object recovery and fleet inventory credible?** Set
    object PITR restore throughput, external command/bookmark durability,
    route/parent-grant quarantine, fail-closed alarm-generation lookup,
    complete post-bookmark replay qualification, current-floor reinstall, and
    fenced reopen; then define directory/
    allocation/namespace discrepancy classes, multi-pass convergence,
    quarantine, and proof before retirement or cleanup. See B40 and B41.
25. **When may a migration use a Cloudflare Container?** Require evidence that
    Worker slices are insufficient and enforce image provenance, regional
    R2-only input/output, least privilege, expansion, CPU/memory/runtime, egress,
    concurrency, retry, idle, and campaign-cost bounds. See S30 and B42.

### P2 — Resolve before promising the corresponding product behavior

26. **Is document inheritance live or frozen?** If both exist, show the mode and
    source fence to users and record every rendered revision for reproducibility.
    See S04 and B09.
27. **How does multi-region workspace discovery remain useful while Global
    stays opaque?** Define the minimal directory, regional batch reads,
    revocation freshness, offline cache, and unavailable-region UX without
    creating a global inbox. See B20.
28. **Will Avalon ever support copying or moving a work stream?** A same-region
    copy with provenance is materially different from cross-region relocation;
    neither should emerge accidentally from a directory update. See B19.
29. **What is the operator repair surface?** Regional correlation and redacted
    state inspection must locate parent, child, substream, run, attempt, tool,
    migration, and provider receipt without routine content access. See B25.
30. **How are late provider events represented?** Preserve immutable commit
    order and provider source time while making the distinction intelligible to
    people and models. See B22.
31. **What is the publish-back operation for private chats and forks?** A useful
    result needs explicit authorship, audience review, attachment handling, and
    one new main-feed part; implicit branch merge should remain impossible. See
    S04 and S05.
32. **Does Avalon need group branches or reply threads?** If research establishes
    that need, choose a new work-stream scope or an explicit new substream kind
    with complete membership, attention, retention, export, and migration
    semantics. Do not obtain it by weakening owner-only `chat`. See B27.
33. **Which suggested actions should Avalon expose?** Re-enabling Suggested
    context requires action types, assignment, expiry, notification, acceptance
    effects, feedback quality thresholds, and a clear boundary between attaching
    or explicitly sharing evidence and authorizing an external write. See S22,
    B30, and B33.
34. **What exact work-stream collections ship?** Decide the In Progress mapping,
    dedicated Error heading, recency timezone, interest-list precedence and
    limits, and unread count cap while retaining the one shared snapshot model.
    See S20 and B32.
