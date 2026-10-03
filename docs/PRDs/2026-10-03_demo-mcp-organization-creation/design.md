# Rally Demo MCP: design

> Companion to [prd.md](prd.md). The tool catalog, wire shapes, sequencing and
> failures a model needs to use the server without reading its code, and the
> shape of the Worker and its bridge.

## Shape of the system

```
MCP client (Claude, ChatGPT, Cursor)
  │  OAuth via Cloudflare Access (Managed OAuth, own application + audience)
  ▼
apps/demo-mcp  (Worker rally-demo-mcp, demo-mcp.internal.rallywith.ai/mcp)
  │  verifies Cf-Access-Jwt-Assertion with the shared verifier
  │  stateless McpServer per request, as apps/engineering-mcp
  │  service binding DEMO_ADMINISTRATION
  ▼
avalon-api-global  →  DemoAdministration (WorkerEntrypoint, no HTTP route)
  │  calls the same service functions as /internal/demos:
  │  startDemoOperation, retryDemoOperation, abandonDemoOperation,
  │  demoTemplate, listDemoCastCandidates, retirement walk
  │  plus new: scenario store, check, preview
  ▼
Global D1 (demo_operations, demo_scenarios, demo_scenario_revisions, ...)
DemoPreparationWorkflow → seeder → readiness → Ready
```

New code:

- `apps/demo-mcp/`: Worker, tool registry, deploy script, tests. Copies the
  engineering MCP's skeleton (`index.ts` 404s everything but `/mcp`,
  `createMcpHandler` with `hosted-clients.json` origins, the `tool()` wrapper
  that logs codes only).
- `apps/api/src/demo-administration.ts`: the `DemoAdministration`
  entrypoint, exported from `apps/api/src/index.ts`. Every method takes the
  actor `{ subject, email }` from the MCP Worker, which got it from the verified
  Access assertion. The entrypoint answers `demo_region_unsupported` outside
  Global, like the routes.
- `apps/api/src/services/demo-scenarios.ts`: the scenario store, check and
  preview.
- `packages/contracts/src/demo-administration.ts`: the RPC vocabulary both
  Workers parse with strict schemas.

Changed code:

- `demo-preparation.ts`: `activeDemoPack()` becomes "the pack this operation
  recorded": the built-in pack by version for `builtin` rows (today's
  behavior, `demo_pack_changed` included), or the stored revision's
  `pack_json` for `stored` rows (no version comparison). The start path takes
  `organizationName` and `connectionSelection`.
- `demo-connection-copy.ts`: copies only the selected IDs when a selection is
  given. A selected ID that is not copyable fails `checking_template` with the
  reason, before anything is written.
- `DemoOperationStartRequestSchema` and `DemoOperationStatusSchema` gain the
  new optional fields. Optional and omitted, never required and nullable, so
  Ace and the API can deploy in either order (the same rule
  [`engineering-mcp.md`](../../engineering-mcp.md#invariants-and-contracts)
  records for mid-rollout strict parsing).

## Conventions every tool follows

- **Result envelope.** Success is MCP text content holding pretty JSON, as the
  engineering MCP's `jsonResult`. Failure is the same with `isError: true`
  and a JSON body `{ "code": string, "message": string, "issues"?: Issue[] }`.
  The `message` is the sentence the model acts on, and always says the next
  step.
- **Strict input.** Every input schema is a strict object. Unknown keys are
  refused with `invalid_input` naming the key path (declared shape only; a key
  the caller invented is reported as `unrecognized_keys` at its parent path,
  without echoing the key, per
  [naming a schema failure](../../naming-a-schema-failure.md)).
- **Issue shape.** `{ "path": string, "code": string, "message": string }`.
  `path` is a JSON path into the submitted value (`steps[4].as`). `code` is
  the Zod issue code or a pack rule code (below). `message` is the pack rule's
  own sentence.
- **Annotations.** Read tools: `readOnlyHint: true, openWorldHint: false`.
  Write tools: `readOnlyHint: false`, with `destructiveHint` and
  `idempotentHint` as listed per tool.
- **Names.** The tools use product nouns (Organization, Channel, Breakout,
  Sidekick) in descriptions. Pack field names stay as the schema spells them
  (`create_workstream`, `create_substream`), and descriptions say what each
  means.
- **No limits of our own.** No page size, rate, or pack size is chosen here.
  Lists return everything the D1 statement returns, chunked to the bound
  parameter ceiling as `demo-operations` already is. Platform limits are the
  ceiling and are reported by name when they trip.

## Tool catalog

Order is the order `tools/list` returns, which is also the order a session
usually uses them.

| # | Tool | Mode | Idempotent | Destructive |
| --- | --- | --- | --- | --- |
| 1 | `list_demo_scenarios` | read | yes | no |
| 2 | `get_demo_scenario` | read | yes | no |
| 3 | `check_demo_scenario` | read | yes | no |
| 4 | `preview_demo_scenario` | read | yes | no |
| 5 | `save_demo_scenario` | write | with `expectedRevision` | no |
| 6 | `archive_demo_scenario` | write | yes | no |
| 7 | `list_demo_cast_candidates` | read | yes | no |
| 8 | `list_template_connections` | read | yes | no |
| 9 | `create_demo_organization` | write | yes, by `requestKey` | no |
| 10 | `list_demo_operations` | read | yes | no |
| 11 | `get_demo_operation` | read | yes | no |
| 12 | `retry_demo_operation` | write | yes, by attempt | no |
| 13 | `abandon_demo_operation` | write | yes | yes |
| 14 | `retire_demo_organization` | write | yes | yes |

Timeouts are the platform's: each tool is one RPC to the entrypoint and
returns when its D1 work does. `create_demo_organization` returns once the
operation row exists and the Workflow is launched; it never waits for Ready.
None of the tools must run serially with respect to each other; operation and
revision rows carry their own fences.

### Types used below

```ts
type ScenarioRef =
  | { scenarioId: string; revision?: number }   // saved; latest live revision when omitted
  | { scenarioId: "builtin:multiplayer" }        // built-in; revision is its pack version
  | { pack: DemoPack };                          // inline; stored as an unnamed revision

type CastEntry =
  | { userId: string }        // a colleague's account, from list_demo_cast_candidates
  | { email: string }         // a colleague by address; must resolve to exactly one account
  | { name: string };         // a typed name; played by a persona minted for this operation

type ConnectionSelection =
  | { mode: "all" }                               // default: every copyable connection
  | { mode: "none" }
  | { mode: "only"; connectionIds: string[] };    // from list_template_connections

type DemoPack = /* exactly DemoPackSchema in apps/api/src/services/demo-pack.ts */;
```

### 1. `list_demo_scenarios`

> List the demo scenarios that can be used to create a demo Organization: the
> built-in one and every saved one. Use `get_demo_scenario` to read a scenario's
> full content before editing it.

Input: `{ includeArchived?: boolean }` (default `false`).

Output:

```json
{
  "scenarios": [
    {
      "scenarioId": "builtin:multiplayer",
      "source": "builtin",
      "name": "Multiplayer",
      "description": "Acme proposal, vendor selection, Acme demo follow-up, Sales demo reviews.",
      "revision": "multiplayer-2026-09",
      "summary": { "spaces": 3, "channels": 4, "breakouts": 3, "sidekicks": 1, "uploads": 7, "parts": ["priya", "marcus", "dana"], "seededRuns": 9 },
      "savedBy": null,
      "savedAt": null,
      "archivedAt": null
    }
  ]
}
```

A built-in's `revision` is its version string; a saved scenario's is an
integer. `summary.seededRuns` is the number of seeded runs preparation will
start and wait on one at a time, which is what makes a scenario slow to
prepare.

### 2. `get_demo_scenario`

> Read the full content of one scenario revision as a pack. Edit the returned
> `pack` and pass it to `check_demo_scenario`. Keep `revision` if you intend to
> save the edit back to the same scenario.

Input: `ScenarioRef` minus the inline form.

Output: `{ scenarioId, name, description, revision, contentHash, pack }`.
`pack` is normalized (derived `expect` present). For a saved scenario,
`revision` is what `save_demo_scenario` takes as `expectedRevision`.

### 3. `check_demo_scenario`

> Check a pack without writing anything. Returns either the normalized pack and
> a summary, or every problem with the path of the field and what to change.
> Fix every issue and check again before saving or creating a demo.

Input: `{ pack: unknown, cast?: Record<string, CastEntry> }`. `pack` is
`unknown` on purpose: the tool parses it, so a malformed pack is a list of
issues, not a transport error. `cast` is optional; when given, the cast checks
(duplicate person, duplicate display name, not a colleague) run too.

Output on success:

```json
{
  "ok": true,
  "contentHash": "sha256:…",
  "pack": { "…": "normalized, with derived presenter expect" },
  "summary": { "spaces": 2, "channels": 3, "breakouts": 1, "sidekicks": 0, "uploads": 4, "parts": ["priya", "marcus"], "seededRuns": 5 },
  "derived": ["expect[presenter]"]
}
```

Output on failure (`isError: false`, because a refused pack is the normal answer
of a check, not a failed call):

```json
{
  "ok": false,
  "issues": [
    { "path": "steps[4].as", "code": "demo_pack_role_not_in_cast", "message": "Role \"dana\" is not in the cast. Add it to roles and roleLabels, or change who speaks." },
    { "path": "expect[0]", "code": "demo_pack_presenter_expect_mismatch", "message": "The presenter's expectation differs from what their flags derive to. Remove the presenter's entry to have it derived." }
  ],
  "derivedPresenterExpect": { "…": "present only for the mismatch issue" }
}
```

The pack rules in `DemoPackSchema.superRefine` are `custom` issues with only a
message today. This change gives each a stable code and keeps its message:

| Code | Rule today |
| --- | --- |
| `demo_pack_role_not_in_cast` | A speaker, participant, Space creator, mention, or a role named in Rally's turn, a Sidekick's prose or a starting context is not in `roles`. |
| `demo_pack_role_label_missing` / `demo_pack_role_label_unused` | Every cast role has a label, and only those. |
| `demo_pack_role_duplicate` | `roles` are unique. |
| `demo_pack_step_id_duplicate` | Step IDs are unique. |
| `demo_pack_space_not_declared` | A room names a Space not in `spaces`. |
| `demo_pack_room_created_twice` / `demo_pack_substream_created_twice` | One creation step per room and per Breakout. |
| `demo_pack_room_not_created` | A step uses a room or Breakout before it is created. |
| `demo_pack_substream_wrong_room` | A step names a Breakout under a room it does not belong to. |
| `demo_pack_already_seated` | A room's `participants` lists its author, or a Breakout's lists its creator. |
| `demo_pack_speaker_not_seated` | Somebody speaks in a conversation they are not in. |
| `demo_pack_substream_mention_not_member` | A mention in a Breakout names somebody not in it. |
| `demo_pack_personal_substream_outsider` | A Breakout of a personal room adds somebody not in the room. |
| `demo_pack_after_question` | A step follows an `ask` in the same conversation. |
| `demo_pack_history_mention` | A room with `execution: "history"` carries mentions, which prepared history cannot apply. |
| `demo_pack_sidekick_name_duplicate` | Two Sidekicks share a name (case folded). |
| `demo_pack_viewer_duplicate` / `demo_pack_viewer_not_in_cast` | Each `expect` viewer appears once and is in the cast. |
| `demo_pack_expect_rooms_mismatch` | A viewer's `expect.rooms` is not exactly the rooms visible to them. |

Two codes are new rules rather than names for existing ones:

| Code | Rule |
| --- | --- |
| `demo_pack_personal_room_unsupported` | A `personal` room. The seeder refuses one today with `demo_seed_personal_room_unsupported`, after earlier steps have run; the check reports it before anything is written. |
| `demo_pack_presenter_expect_mismatch` | See prd.md, **The readiness block is derived, not written**. |

### 4. `preview_demo_scenario`

> Show a scenario as the presenter will read it: rooms in sidebar order, who
> says what, Rally's turns, documents, Breakouts and Sidekicks, with each part's
> name filled in. Use it to review a scenario with the operator before creating
> a demo.

Input: `{ scenario: ScenarioRef, cast?: Record<string, CastEntry> }`.

Output: `{ contentHash, markdown }`. `markdown` is one section per Space, then
per room in the order the presenter's sidebar will list them, each headed with
what the presenter finds (`seated`, `visible`, `new`, `mentioned`,
`waiting on a question`), then each Sidekick with its schedule in its time zone.
`@{role}` becomes the cast name, or `[<label>]` when no cast is given. The
preview is built from the same planner (`planDemoSeed`) and room facts
(`packRoomFacts`, `visibleRoomsFor`) preparation uses, so it cannot drift from
what is seeded. The pack is checked first; an invalid pack answers with the
check's issues.

### 5. `save_demo_scenario`

> Save a checked pack as a named scenario, or as a new revision of one. Pass
> `expectedRevision: null` to create a new scenario, or the revision you read
> to revise it. Built-in scenarios cannot be saved over; save an edit of one
> under a new name.

Input:

```ts
{
  scenarioId?: string;               // omitted: create
  expectedRevision: number | null;   // null: create-only; number: the revision read
  name: string;                      // unique among live scenarios
  description: string;
  pack: unknown;                     // checked exactly as check_demo_scenario
}
```

`scenarioId` present with `expectedRevision: null`, or absent with a number, is
refused with `invalid_input`.

Output: `{ scenarioId, revision, contentHash }`.

Saving identical content to the latest revision returns that revision and
writes nothing, so a replayed save does not make a new revision.

### 6. `archive_demo_scenario`

> Hide a saved scenario from `list_demo_scenarios`. Its revisions stay, and
> demos made from it are unaffected. Archiving twice is harmless.

Input: `{ scenarioId: string }`. Output: `{ scenarioId, archivedAt }`.

### 7. `list_demo_cast_candidates`

> List who can present a demo, who can play a part, and the parts a scenario
> needs cast. Use the returned `userId`s in `create_demo_organization`'s
> `presenterUserId` and `cast`.

Input: `{ scenario?: ScenarioRef }`.

Output: `{ presenters: [{ userId, name, email }], colleagues: [{ userId, name, email }], parts?: [{ role, label }] }`.
`presenters` are active members of `demo-template`; `colleagues` are signed-in
accounts on the company's domain (`listDemoCastCandidates`). `parts` is present
when a scenario is given.

### 8. `list_template_connections`

> List the connections in the demo template and whether each can be copied into
> a demo. Use the `connectionId`s of copyable ones in
> `create_demo_organization`'s `connections` to copy only some of them.

Input: `{}`.

Output: `{ connections: [{ connectionId, connectorType, displayName, scope, copyable, skipReason }] }`.
`skipReason` is `null`, `personal_scope` or `shared_grant`. No credential,
account token or provider account identifier is returned.

### 9. `create_demo_organization`

> Create a new demo Organization from a scenario and start preparing it. Returns
> at once with the operation's status; call `get_demo_operation` to follow it to
> Ready. Calling again with the same `requestKey` returns the same operation and
> never creates a second Organization.

Input:

```ts
{
  requestKey: string;                         // client-chosen, [a-z0-9-], unique per demo you mean
  scenario: ScenarioRef;
  companyName: string;
  organizationName?: string;                  // default `${companyName}-demo`
  presenterUserId: string;                    // from list_demo_cast_candidates.presenters
  cast: Record<string, CastEntry>;            // every part but presenter
  connections?: ConnectionSelection;          // default { mode: "all" }
}
```

What happens, in order:

1. The pack is resolved (stored inline packs become an unnamed revision) and
   checked. A failing pack is refused with `demo_scenario_invalid` and its
   issues; nothing is written.
2. The operation ID is derived from `(actor.subject, requestKey)`. If a row
   exists, its status is returned unchanged, **unless** its recorded inputs
   differ from this call's, which is refused with
   `demo_request_key_reused` naming the differing field.
3. The shipped start checks run (cast complete, no duplicate person or name,
   presenter in the template, colleagues on the domain), plus connection
   selection against the template.
4. The row is written with the scenario revision, the requester, and the
   selection; the Workflow is launched.

Output: the status shape of `get_demo_operation`.

### 10. `list_demo_operations`

> List demo operations, newest first, with their status. Use it to find a demo
> you started earlier.

Input: `{ status?: "running" | "failed" | "ready" | "abandoned"; mine?: boolean }`.
`mine` filters to the caller's Access subject.

Output: `{ operations: Status[] }` with each operation's latest phase only.

### 11. `get_demo_operation`

> Read one demo operation's progress. While it is running, call again to follow
> it; the gaps in `waiting_for_workspace` say what has not arrived yet. When
> it fails, `error.next` names the tool that recovers it.

Input: `{ operationId: string }`.

Output (`Status`), extending `DemoOperationStatusSchema`:

```json
{
  "operationId": "…",
  "requestKey": "…",
  "status": "running",
  "scenario": { "scenarioId": "…", "name": "Northwind logistics", "revision": 3, "contentHash": "sha256:…" },
  "companyName": "Northwind",
  "organization": { "id": "…", "name": "Northwind-demo" },
  "presenter": { "userId": "…", "name": "…" },
  "attempt": 1,
  "phases": [ { "phase": "seeding_conversations", "status": "running", "detail": { "confirmed": 6, "total": 14 } } ],
  "connections": { "copied": ["Google Drive"], "skipped": [ { "displayName": "Linear", "reason": "shared_grant" } ] },
  "gaps": [ { "viewer": "presenter", "kind": "mention_missing", "room": "vendor-selection" } ],
  "error": null,
  "notices": [],
  "readyAt": null,
  "retiredAt": null,
  "requestedBy": "…@rallywith.ai"
}
```

`error`, when present: `{ phase, code, message, next }` where `next` is
`"retry_demo_operation"`, `"abandon_demo_operation"` or `null`. `notices` on
Ready may include `{ code: "presenter_cannot_see_organizations", message }`
when `multiple-workspaces-enabled` is off for the presenter.

### 12. `retry_demo_operation`

> Start the next attempt of a failed or stalled operation. Every phase resumes
> from what the last attempt finished. A failed seeded run cannot be retried
> into success; for `demo_seed_run_failed`, abandon and create a new demo.

Input: `{ operationId: string, attempt: number }`. `attempt` is the attempt the
caller read; a retry against an attempt the row has moved past returns the
current status and starts nothing, so a replayed retry does not launch a
second driver.

Output: `Status`.

### 13. `abandon_demo_operation`

> Abandon an unfinished demo and retire its candidate Organization. Cannot be
> undone. Repeat the operation ID in `confirmOperationId`.

Input: `{ operationId: string, confirmOperationId: string }`.

Output: `Status` with `status: "abandoned"` and whether retirement finished. An
incomplete retirement is answered with `demo_abandon_incomplete`; calling again
resumes it.

### 14. `retire_demo_organization`

> Retire a published demo Organization permanently: it closes for everyone in
> it and cannot be reopened. Only Organizations created by demo preparation can
> be retired here. Repeat the Organization's name in `confirmName`.

Input: `{ organizationId: string, confirmName: string }`.

Output: `{ organizationId, retiredAt, complete: boolean }`. Calling again
resumes an incomplete walk.

## Discovery and sequencing

Where every input comes from:

| Input | Producer |
| --- | --- |
| `scenarioId`, `revision` | `list_demo_scenarios`, `get_demo_scenario`, `save_demo_scenario` |
| `pack` | `get_demo_scenario` (edited by the client), or written by the client |
| `expectedRevision` | `get_demo_scenario.revision`; `null` to create |
| role tokens for `cast` | `pack.roles` minus `presenter`, or `list_demo_cast_candidates.parts` |
| `userId` | `list_demo_cast_candidates` |
| `connectionId` | `list_template_connections` |
| `requestKey` | the client |
| `operationId` | `create_demo_organization`, `list_demo_operations` |
| `attempt` | `get_demo_operation.attempt` |
| `organizationId`, its name | `get_demo_operation.organization` |

Common sequences:

- **Built-in, as is:** `list_demo_cast_candidates({ scenario })` →
  `create_demo_organization` → `get_demo_operation` until `ready` or `failed`.
- **Customized:** `get_demo_scenario` → edit → `check_demo_scenario` (repeat
  until `ok`) → `preview_demo_scenario` → operator confirms →
  `create_demo_organization({ scenario: { pack } })` → `get_demo_operation`.
- **Save for the team:** … `check_demo_scenario` → `save_demo_scenario`
  (`expectedRevision: null`). Later: `get_demo_scenario` → edit →
  `save_demo_scenario({ scenarioId, expectedRevision })`; on
  `demo_scenario_revision_conflict`, read again and rebuild the edit.
- **Recover:** `get_demo_operation` → `error.next` → that tool.

## Failures

`message` below is the exact sentence returned. Structured detail keys are the
ones listed; nothing else is added.

| Code | Tools | Message | Model should |
| --- | --- | --- | --- |
| `invalid_input` | all | "The input does not match this tool's schema at `<path>`. Fix that field and call again." | correct and retry |
| `demo_scenario_invalid` | 5, 9 | "The scenario has problems listed in `issues`. Fix every issue, check it with check_demo_scenario, and call again." (`issues`) | correct and retry |
| `demo_scenario_not_found` | 2, 4, 5, 6, 7, 9 | "No scenario has this ID and revision. Call list_demo_scenarios for the current ones." | inspect first |
| `demo_scenario_revision_conflict` | 5 | "The scenario changed after you read it (now revision `<n>`). Read it again with get_demo_scenario and rebuild the edit." (`currentRevision`) | re-read, rebuild |
| `demo_scenario_name_taken` | 5 | "Another live scenario has this name. Choose a different name, or revise that scenario instead." | correct and retry |
| `demo_scenario_builtin_readonly` | 5, 6 | "Built-in scenarios change only through the code. Save your edit under a new name." | correct and retry |
| `demo_scenario_too_large` | 5, 9 | "The pack is larger than D1's row limit of `<bytes>` bytes. Shorten uploads or split the scenario." (`limitBytes`) | correct |
| `demo_request_key_reused` | 9 | "This requestKey already started a demo with a different `<field>`. Use a new requestKey for a different demo, or call get_demo_operation for that one." (`operationId`, `field`) | stop or new key |
| `demo_cast_incomplete` | 9 | "Part `<role>` has nobody cast. Give every part in the scenario a userId, email or name." (`role`) | correct and retry |
| `demo_cast_duplicate` | 3, 9 | "One person is cast in two parts (`<role>`, `<role>`). Cast a different person or a typed name in one of them." | correct and retry |
| `demo_cast_name_duplicate` | 3, 9 | "Two people in this demo share the display name of part `<role>`. Use a typed name for one of them." | correct and retry |
| `demo_cast_not_a_colleague` | 3, 9 | "The person cast in `<role>` is not a signed-in account on the company's domain. Pick one from list_demo_cast_candidates or type a name." | correct and retry |
| `demo_cast_email_ambiguous` | 3, 9 | "The email for `<role>` matches no single colleague. Use a userId from list_demo_cast_candidates." | correct and retry |
| `demo_presenter_not_in_template` | 9 | "The presenter must be a member of the demo template. Pick one from list_demo_cast_candidates.presenters." | correct and retry |
| `demo_connection_not_copyable` | 9 | "Connection `<id>` cannot be copied (`<reason>`). Leave it out of connections." (`connectionId`, `reason`) | correct and retry |
| `demo_operation_not_found` | 11–13 | "No demo operation has this ID. Call list_demo_operations." | inspect first |
| `demo_operation_ready` | 13 | "This demo is already Ready. Use retire_demo_organization to close it." | switch tool |
| `demo_confirmation_mismatch` | 13, 14 | "The confirmation does not match. Repeat the operation ID (or the Organization's exact name) to confirm." | correct, only on the operator's say-so |
| `demo_not_a_demo_organization` | 14 | "This Organization was not created by demo preparation and cannot be retired here." | stop |
| `demo_abandon_incomplete` | 13 | "Some objects are not retired yet. Call abandon_demo_operation again to resume." | retry once |
| `demo_region_unsupported` | all | "Demos are prepared only in Global." | stop |
| `demo_preparation_unavailable` | 9, 12 | "Demo preparation is not available in this deployment." | stop |
| `regional_unavailable` | all | "Rally's API did not answer. Try again in a moment." | retry once |

Phase failures inside a running operation are not tool errors: they arrive in
`get_demo_operation.error` with the shipped codes (`demo_seed_run_failed`,
`demo_seed_run_outcome_mismatch`, `demo_projection_wait_exhausted`,
`demo_cast_not_a_colleague`, …) and `next`.

**Ambiguous writes.** If `create_demo_organization`'s response is lost, the
client calls it again with the same `requestKey` and gets the operation. If
`save_demo_scenario`'s is lost, saving the same content again returns the
existing revision. Abandon and retire resume. No write needs a blind retry.

## Authority and lifecycle

- **Model choice:** the pack, scenario names, cast entries, company and
  Organization names, connection selection, `requestKey`.
- **Host-derived:** the actor (from the verified Access assertion only), the
  operation ID, the template, the region, the presenter's eligibility, which
  connections are copyable, every destination ID in the demo.
- **Never accepted:** a source workspace ID, a template ID, credential bytes, a
  seed for a single message outside a pack, a timestamp.
- **Cancellation:** closing the client cancels nothing; operations are
  Workflows. Abandon is the only cancel.
- **Truncation:** none. Tool output is whole; a long preview is long.

## Model-usability acceptance

- Schema snapshot tests for every tool's input and output, including each
  refused shape above.
- Contract tests through the real MCP handler, as
  `apps/engineering-mcp/test/server.test.ts` does, with a double only for the
  regional binding.
- Prompt evaluations on the configured medium fallback model covering:
  discovery from nothing to a Ready demo of the built-in scenario; a customized
  demo from a plain-language request; fixing a pack from check issues; a
  revision conflict; a replayed create with a lost response; and stopping on
  `demo_not_a_demo_organization` instead of retrying.
