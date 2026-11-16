# Agent loop types

Every kind of agent loop Rally runs, how the host tells them apart, and the
gates that already treat them differently. **Read it before adding or
changing a tool, a plugin, a prompt, or any behavior that depends on which
loop is running, and give every row below an answer.** A gate written for the
loops its author had in mind is how a wizard's wake-up once woke with the
wizard's artifact access and none of its other tools, and how a run's
worker's wake-up was refused as a run that did not exist (see the
[changelog](#changelog)).

The tool design rules are [`agent-tools.md`](agent-tools.md)'s; the harness
mechanics are [`agent-harness.md`](agent-harness.md)'s; what a Sidekick is
and how its runs start is [`automation-lifecycle.md`](automation-lifecycle.md)'s.
This document owns only the catalogue and the matrix.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/index.ts` | `WorkstreamWorkflowInput`, the one input every turn carries. Its fields are what a gate reads. |
| `packages/contracts/src/conversation-parent.ts` | `parentKind`: `canvas` or `automation` (a Sidekick). There is no third. |
| `apps/api/src/lib/loop-authority.ts` | `loopAuthority`, the one answer to "whose authority does this loop act with": a Canvas's Chat, a Sidekick's wizard or a run, the root's for a background agent. `canvasChatAuthority` and `actsAsSidekickWizard` are its two common questions. |
| `apps/api/src/durable-objects/agent-loop-do.ts` | `claimPersistentLoopExecution`, which builds most turns from a pending input and sets `sidekickWizard`, `backgroundAgent`, `automationRun`, `automationContinuation`, `automationDelegation` and `agentExchange`. |
| `apps/api/src/services/workstream-service.ts` | `fireWorkstreamWakeup` and `launchWorkstreamHarness`, the wake-up path, which derives the woken turn's loop kind as the claim does for any input. |
| `apps/api/src/services/sidekick-run-provisioning.ts` | A run's first activation; `reason` is its trigger kind. |
| `apps/api/src/durable-objects/workstream-object-product.ts` | Admission (`reason` is the admission's `origin`) and Retry. |
| `apps/api/src/services/agent-model-flags.ts` | `conversationModelRole`: `canvas`, `sidekick_wizard` or `sidekick_run`. |
| `apps/api/src/services/integrations.ts` | `loadHarnessTools` and the per-plugin gates (`asksForSources`, `routesAnswersToAgent`, the agents plugin variants). |
| `apps/api/src/services/conversation-tools.ts` | `conversationToolAccess`, the conversation-tool scope per loop. |
| `apps/api/src/services/workstream-artifact-data-wiring.ts` | The `write_artifact_data` gate per loop. |

## How it works

### The fields that identify a loop

A gate decides from these fields of `WorkstreamWorkflowInput`, all set by
the host and none chosen by the model:

| Field | Means |
| --- | --- |
| `parentKind`, `parentId`, `substreamId` | Whose conversation: a Canvas or a Sidekick, and which child. `"0"` is a Canvas's Chat or a Sidekick's shared conversation; a run child's substream is its run id. |
| `sidekickWizard` | A turn in a Sidekick's shared conversation that the Sidekick routed to its wizard. |
| `automationRun` | A Sidekick run. |
| `automationContinuation` | Input that continued a waiting run, beside `automationRun`. |
| `backgroundAgent` | A background agent's own conversation. |
| `backgroundAgentRootReason` | Beside `backgroundAgent`: the `reason` of the turn that started the agent's root, `sidekick_review` for one the self-review started (or a turn `reviewOwnsThisTurn` claims for it). Absent for an agent started before it was recorded. |
| `automationDelegation` | A background agent whose root is a run: it carries the run's authority, not its instructions. |
| `agentExchange` | Another agent's message started this turn. |
| `scheduledWakeupId` | A due wake-up started this turn. |
| `slackOrigin` | A reply in a Slack thread bound to a run started this turn. |
| `executionPrincipal` | Who the turn acts as: a person (`user`) or the Organization (`workspace`), for a Sidekick that runs as itself. |
| `reason` | What admitted the turn: `human_message`, `elicitation_answer`, `resource_authorization`, `manual_retry`, `agent_message`, `scheduled_wakeup`, `sidekick_review`, `external_conversation_binding`, or a run's trigger kind. |

### The loops

**1. A Canvas's Chat.** `parentKind` `canvas`, conversation `"0"`, normally
with a user principal. It acts as the person and belongs to its own Canvas.

| Variant | Started by | A person is driving |
| --- | --- | --- |
| Person | `human_message`, `elicitation_answer`, `resource_authorization`, `manual_retry` | Yes |
| Agent exchange | `agent_message` with `agentExchange` | No |
| Wake-up | `scheduled_wakeup` with `scheduledWakeupId` | Counted as yes |

**2. A Sidekick's wizard.** `parentKind` `automation`, substream `"0"`, no
`automationRun`, `sidekickWizard: true`. A person's message there is the
wizard's only when it is a manager's edit (`edit_sidekick`) or an answer to
the wizard; any other message starts a run (loop 3). It reaches the
Sidekick's attached Canvases.

| Variant | Started by | Acts as | A person is driving |
| --- | --- | --- | --- |
| Person | A manager's edit, `elicitation_answer`, `resource_authorization`, `manual_retry` | That person | Yes |
| Agent exchange | `agent_message`, only when the principal manages the Sidekick | The principal | No |
| Self-review | `sidekick_review`: Rally's review notice after enough runs | An eligible coordinator delegate | No |
| Wake-up | `scheduled_wakeup`, only while the principal manages the Sidekick | The principal | Counted as yes |

`reviewOwnsThisTurn` also claims the later turns that the review's own
workers wake, so the review can record its submission.

**3. A Sidekick run.** `automationRun` present, not a background agent, in
the run child. `reason` is the trigger: `schedule`, `external_event` (a
connector event the source and trigger judges admitted), `manual` (Run now,
or a person's message in the Sidekick's conversation), or `invocation` (an
artifact binding). `inbound_email` is only read for old rows. It acts as the
coordinator delegate, or as the Organization when there is none; a run a
message started with no delegate acts as the sender. Nobody is driving it.
It reaches the Sidekick's attached Canvases and makes its own on first
publish ([`canvases.md`](canvases.md)).

**4. A run's continuation.** `automationRun` and `automationContinuation`:
input to a waiting run that `continueSidekickRun` approved. The input is a
member's message, an elicitation answer, another agent's message, a reply in a
bound Slack thread (`external_conversation_binding`, `slackOrigin`), or a
wake-up. It acts as the run's principal, whoever sent the input.

**5. A background agent.** `backgroundAgent: true`, started by `start_agent`.
It acts as its starter's principal and nobody is driving it. Its root is the
conversation that started it (or that conversation's root, for a worker
started by a worker), stored as `root_substream_id`; that column is not on
the input, so a gate tells the roots apart this way:

| Root | Identified by |
| --- | --- |
| A Canvas's Chat | `parentKind` `canvas` |
| A Sidekick's wizard | `parentKind` `automation`, no `automationDelegation` |
| A Sidekick run (a delegation worker) | `automationDelegation` present, with the run's principal |

A wizard-rooted agent started by the self-review is told from one a person's
wizard turn started by `backgroundAgentRootReason`, from
`background_agent.root_reason`, which `start_agent` writes and a worker
started by a worker inherits.

#### A background agent acts with its root's authority

**A background agent is offered every tool its root is offered,** and each
of those tools admits it as it admits the root. It already runs as its root's
principal and does its root's work; a gate that offers a tool to "the Chat
itself" only makes the agent the Chat delegated to weaker than the Chat, so
the Chat has to take the work back or tell the person it cannot be done. A
gate about what a loop *may do* asks `loopAuthority(input)`, never
`backgroundAgent` or `substreamId`.

The one tool that stays with the root is `report_outcome`: it is a run's own
report of how it ended, so a worker calling it would end its run. A question
for a person is not an exception: a background agent is offered the question
tools, and they refuse because no person reads its conversation, naming the
root as where to ask (rule 14 of [`agent-tools.md`](agent-tools.md)). A tool
added to that list is a decision and needs a reason here.

The root's admission rule comes with its tools. A wizard turn runs only for a
principal who manages the Sidekick, so a wizard-rooted agent's turn is checked
the same way before it runs (`agent-loop-do.ts`, `wizardRootedAgent`) and is
refused with `sidekick_edit_requires_manager` otherwise. A run's worker already
re-asks its run's authority on every turn.

**A wake-up is not a loop of its own either.** It continues the loop that
scheduled it: the same conversation, the same flags the claim would derive
for an input there (a run's continuation, a worker's root authority, the
wizard's `sidekickWizard` after the manager check). Which turn scheduled it
is not recorded, so a gate that must tell a person's turn from another
agent's or the self-review's cannot do it for a wake-up; none needs to
today. [`agent-harness.md`](agent-harness.md#scheduled-wake-ups) owns the
mechanism.

**Retry** is not a loop of its own. It replays the failed turn's stored
context with `reason` `manual_retry` and the person retrying as the
principal, so it takes the row of the turn it retries.

### Not loops

These run a model without being a harness loop, have no tools, and need no
row: the memory sweep (`runStructuredInference`), the addressing classifier
(`classifyMessageAdmission`), the completion-verification judge, the
semantic trigger and source-condition judge, Canvas title naming, pasted-text
and attachment summaries. Code Mode programs and `sidekick_tool_test` run
inside the calling loop as tool calls. An MCP client is not a loop: it
calls routes as a person, and gets only what [`rally-mcp.md`](rally-mcp.md)
lists.

### The matrix

The rows a new tool or behavior answers. Copy this table into the PRD or the
module document that owns the tool, fill each cell, and say why for any row
that differs from its neighbours:

| Loop | Variant |
| --- | --- |
| Canvas's Chat | Person |
| Canvas's Chat | Agent exchange |
| Canvas's Chat | Wake-up |
| Sidekick's wizard | Person |
| Sidekick's wizard | Agent exchange |
| Sidekick's wizard | Self-review |
| Sidekick's wizard | Wake-up |
| Sidekick run | Schedule, event, Run now, message, invocation |
| Run continuation | Any input |
| Background agent | Rooted in a Canvas's Chat |
| Background agent | Rooted in a Sidekick's wizard |
| Background agent | Rooted in a run |
| MCP client | Not a loop; say whether a route is needed |

Then name the principal the behavior needs. A Sidekick that runs as itself
has a `workspace` principal and no person, and a rule that checks "the person
this loop acts as" fails there.

### Gates that already distinguish loops

| Gate | Where | Offered to |
| --- | --- | --- |
| Source tools (`asksForSources`) | `integrations.ts` | Ask from a person's turn, a wake-up in a Chat or a wizard, and a wizard turn a person-started Canvas Chat turn messaged (`fromPersonTurn`). Every other loop holds them and refuses by name ([`sidekick-sources.md`](sidekick-sources.md)). |
| Elicitation and connection cards | `integrations.ts` (`routesAnswersToAgent`) | Asked by every loop but background agents and a Sidekick turn with `agentExchange` (unless a person-started Canvas Chat turn sent it); those hold them and refuse with where to send the question. |
| Authoring tools | `integrations.ts` (`actsAsSidekickWizard`) | Wizard turns (`sidekickWizard`) and their background agents. |
| Conversation tools | `conversation-tools.ts` | Wizard (with `attach`) and runs (without), and each one's background agents. Not a Canvas's Chat. |
| `write_artifact_data` | `workstream-artifact-data-wiring.ts` | Canvas's Chat and wizard under a user principal; runs; each one's background agents. |
| `set_artifact_audience` | `integrations.ts` (`canvasChatAuthority`) | Canvas's Chat under a user principal, and its background agents. |
| Canvas Sidekick tools (`archive_sidekick`, the Canvas's `sidekicks_list` and `create_sidekick`) | `agent-communication-service.ts` (`canvasChatAuthority`) | Canvas's Chat under a user principal, and its background agents. |
| `request_sidekick_change` | `agent-communication-plugin.ts` | Runs and their delegation workers. |
| `sidekick_report_outcome` | `sidekick-task-outcome.ts` | Runs only, not their workers ([the one exception](#a-background-agent-acts-with-its-roots-authority)). |
| Run reading | `sidekick-run-tools.ts` | The wizard and its background agents. |
| Model route | `agent-model-flags.ts` | `canvas`, `sidekick_wizard` (wizard and its background agents), `sidekick_run` (runs and delegation workers). |
| Notifications (`rally:notifications`, proposed) | [Canvas notices PRD](PRDs/2026-11-14_canvas-notices/prd.md) | Its own matrix. |

## Invariants

- **Every row is answered.** A tool or behavior keyed on these fields says
  what each row of [the matrix](#the-matrix) gets. A row left out gets
  whatever the gate's default falls through to, which is how the wake-up
  disagreement below arose. No automated guard; reviewers check the matrix.
- **The loop kind is host-derived.** No field above is a tool argument or
  model choice. A gate that reads a model-supplied value to decide which
  loop it is in lets content choose its own tools.
- **Content does not act in a person's name without a person's say.** A run
  and its delegation workers are handed an event's content, so a behavior
  that speaks for a person is refused to them. Agent exchange, self-review
  and background agents are content- or host-driven too, and a source request
  is refused to all of them (`asksForSources`); a behavior says which rows it
  allows. A refused behavior is offered and refuses by name
  ([`agent-tools.md`](agent-tools.md) rule 14). Guard:
  `connector-tool-selection.test.ts`.
- **A wake-up continues the loop that scheduled it.** A derivation the claim
  path makes for an input belongs in `fireWorkstreamWakeup` too, or the woken
  turn is a different loop from the one that asked for it. Guard: the firing
  tests in `workstream-wakeup.test.ts`.
- **A background agent gets its root's tools.** The three background-agent
  rows of [the matrix](#the-matrix) answer as their roots do, apart from
  `report_outcome`. Guard: the tool-parity test in
  `connector-tool-selection.test.ts`, which loads each root's tools and its
  agent's, built as the host builds them, and fails on any difference.
- **A new field or `reason` adds a row here** in the same change, with each
  existing gate's answer for it.

## Boundary

This document owns the catalogue of loop kinds, how they are identified, and
the matrix. It does not own what any one tool does with a row (the tool's own
document), how a Sidekick run is started or authorized
([`automation-lifecycle.md`](automation-lifecycle.md)), background agents and
agent exchange ([`agent-communication.md`](agent-communication.md)), or the
harness ([`agent-harness.md`](agent-harness.md)).

## Failure modes and limits

A gate that misses a row fails silently: the loop gets a tool it should not
have, or lacks one it needs, and nothing errors. The catalogue cannot prevent
that; it makes the omission visible in review.

## Testing

Each gate is tested in its own suite (`apps/api/test/` for the tool-loading
gates). A new gate's test covers every row of the matrix it distinguishes,
with the input built as the host builds it, not with fields set by hand that
the host would never combine.

## Open questions

1. **A retried run under the Organization principal** keeps `automationRun`
   but runs as the person retrying. Whether that is intended is not
   recorded.

## Changelog

### 2026-11-15 — A background agent acts with its root's authority

**What changed:** One function, `loopAuthority`, decides whose authority a
loop acts with, and a background agent gets its root's. Its agents now get
`write_artifact_data` and `set_artifact_audience` (a Canvas's Chat), the
authoring and conversation tools (a wizard), and the conversation tools and
`request_sidekick_change` (a run). `isCanvasChat` is gone; every gate that
used it was about authority.

**Why:** A Canvas's Chat delegated a podcast feed to a background agent. The
agent could neither read nor change who opens the Canvas's artifacts, and
could not write the reader's rows, so it reported a hosting blocker that the
Chat then passed to the person as one. The agent already ran as the Chat's
person; the gates asked "is this the Chat itself?" when the question was
"whose authority is this?". The owner set the rule: a background agent has
the permissions of the agent that started it. Why background agents were
excluded at first was not recorded.

**Considered and rejected:** Setting the root's flags (`sidekickWizard`) on a
background agent's input, which would also change prompts and the
self-review's ownership test that read those flags for other reasons. Keeping
the per-gate checks and adding background agents one gate at a time, which
is how the gates drifted apart.

**Consequences:** A new gate about what a loop may do calls
`loopAuthority`; the tool-parity test fails a gate that does not. A root's
admission rule moves with its tools: review found a wizard-rooted agent held
the authoring tools without the wizard's manager check, which its turn now
meets. A tool
that stays with the root is named in
[the rule](#a-background-agent-acts-with-its-roots-authority) with its
reason.

### 2026-11-14 — Document created

**What changed:** A catalogue of every loop kind, the fields that identify
each, the gates that already tell them apart, and the matrix a new tool
answers.

**Why:** Designing `rally:notifications` turned up loop kinds that were not
in anyone's head at the start: the self-review, a background agent's root,
a run's delegation worker, wake-ups. Each existing gate had been written
against its own list, and three of them already disagree about wake-ups. The
owner asked for one list so every new tool covers the whole matrix.

Writing it found two wake-up gaps, fixed in the same change
([`agent-harness.md`](agent-harness.md#changelog)): a wizard's wake-up woke
without `sidekickWizard`, and a run's worker's wake-up asked about its own id
as a run. The owner set the rule that fixed both: a wake-up continues the
loop as it was.

**Considered and rejected:** Extending [`agent-harness.md`](agent-harness.md),
which owns the harness's mechanics, not the product's loop kinds; the matrix
would be lost in it.

**Consequences:** A new loop field or `reason` adds a row here, and a new
tool fills the matrix in its own PRD or document.
