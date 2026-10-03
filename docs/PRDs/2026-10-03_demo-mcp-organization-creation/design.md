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
  │  plus new: scenario store, check
  ▼
Global D1 (demo_operations, demo_scenario_revisions, ...)
DemoPreparationWorkflow → seeder → readiness → Ready
```

New code:

- `apps/demo-mcp/`: Worker, tool registry, deploy script, tests. Copies the
  engineering MCP's skeleton (`index.ts` 404s everything but `/mcp`,
  `createMcpHandler` with `hosted-clients.json` origins, the `tool()` wrapper
  that logs codes only).
- `apps/api/src/demo-administration.ts`: the `DemoAdministration`
  entrypoint, exported from `apps/api/src/index.ts`. Every method takes the
  actor `{ subject, email }` as an argument. The MCP Worker takes it from the
  Access assertion it verified; the entrypoint cannot verify it and trusts the
  binding, exactly as `EngineeringInspectionBridge` trusts its caller. The
  entrypoint answers `demo_region_unsupported` outside Global, like the routes.
- `apps/api/src/services/demo-scenarios.ts`: the revision store and the check
  (including its preview text).
- `packages/contracts/src/demo-administration.ts`: the RPC vocabulary both
  Workers parse with strict schemas.

Changed code:

- `demo-preparation.ts`: every new operation, from Ace or from the MCP,
  built-in scenario or inline pack, stores the pack it starts with as an
  unnamed revision and records that revision's ID. `activeDemoPack()` becomes
  "the pack this operation recorded": the stored revision's `pack_json`, with
  no version comparison. Only rows written before the migration, which have no
  revision, keep today's comparison against the built-in pack and
  `demo_pack_changed`. `startDemoOperation` takes an optional pack (absent
  means the built-in one) and the requester. Its first statement stays the
  replay lookup, before any validation, as the comment there requires.
- `DemoOperationStartRequestSchema` and `DemoOperationStatusSchema` gain the
  new fields as optional. Optional and omitted, never required and nullable,
  so Ace and the API can deploy in either order (the same rule
  [`engineering-mcp.md`](../../engineering-mcp.md#invariants-and-contracts)
  records for mid-rollout strict parsing). Ace keeps sending and reading what
  it does today.
- The pack schema's `superRefine` issues gain stable codes (see
  `check_demo_scenario`). Messages are unchanged.

## Phases

The tools ship in two phases. Phase 1 is the primitive the PRD needs: run any
checked pack, pinned to immutable bytes. Phase 2 adds what is cheap to add
later and costly to take back once people depend on it, and is built when
somebody asks for it.

| Phase | What | Goals |
| --- | --- | --- |
| 1 | Built-in scenarios, check with preview, inline packs stored as unnamed revisions, cast candidates, create, follow, retry, abandon, retire | 1, 2, 3, 4, 6 (names, presenter, cast), 7, 8 |
| 2 | A named, shared scenario library (save, revise, archive) | 5 |
| 2 | Choosing which template connections a demo receives | 6 (connections) |

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
  `path` is a JSON path into the submitted value, with array indexes
  (`steps[4].as`, `expect[0]`). `code` is the Zod issue code or a pack rule
  code (below). `message` is the pack rule's own sentence.
- **Annotations.** Read tools: `readOnlyHint: true, openWorldHint: false`.
  Write tools: `readOnlyHint: false`, with `destructiveHint` and
  `idempotentHint` as listed per tool.
- **Names.** The tools use product nouns (Organization, Channel, Breakout,
  Sidekick) in descriptions. Pack field names stay as the schema spells them
  (`create_workstream`, `create_substream`), and descriptions say what each
  means.
- **Shipped codes.** Every refusal a shipped function already makes keeps its
  shipped code. New codes are only for checks that do not exist yet, and the
  failure table marks them.
- **No limits of our own.** No page size, rate, or pack size is chosen here.
  Lists return everything the D1 statement returns, chunked to the bound
  parameter ceiling as `demo-operations` already is. Platform limits are the
  ceiling and are reported by name when they trip.

## Tool catalog

Order is the order `tools/list` returns, which is also the order a session
usually uses them.

| # | Tool | Phase | Mode | Idempotent | Destructive |
| --- | --- | --- | --- | --- | --- |
| 1 | `list_demo_scenarios` | 1 | read | yes | no |
| 2 | `get_demo_scenario` | 1 | read | yes | no |
| 3 | `check_demo_scenario` | 1 | read | yes | no |
| 4 | `list_demo_cast_candidates` | 1 | read | yes | no |
| 5 | `create_demo_organization` | 1 | write | yes, by `requestKey` | no |
| 6 | `list_demo_operations` | 1 | read | yes | no |
| 7 | `get_demo_operation` | 1 | read | yes | no |
| 8 | `retry_demo_operation` | 1 | write | with `expectedAttempt` | no |
| 9 | `abandon_demo_operation` | 1 | write | yes | yes |
| 10 | `retire_demo_organization` | 1 | write | yes | yes |
| 11 | `save_demo_scenario` | 2 | write | with `expectedRevision` | no |
| 12 | `archive_demo_scenario` | 2 | write | yes | no |
| 13 | `list_template_connections` | 2 | read | yes | no |

Timeouts are the platform's: each tool is one RPC to the entrypoint and
returns when its D1 work does. `create_demo_organization` returns once the
operation row exists and the Workflow is launched; it never waits for Ready.
None of the tools must run serially with respect to each other; operation and
revision rows carry their own fences.

### Types used below

```ts
type ScenarioRef =
  | { scenarioId: "builtin:multiplayer" }        // built-in; revision is its pack version
  | { revisionId: string }                       // a stored revision, from a check or a create
  | { scenarioId: string; revision?: number }    // phase 2: a saved scenario; latest when omitted
  | { pack: DemoPack };                          // inline; stored as an unnamed revision on create

// The shipped DemoCastEntrySchema, unchanged, so Ace and the MCP send the same cast.
type CastEntry =
  | string                    // a colleague's user ID, from list_demo_cast_candidates
  | { name: string };         // a typed name; played by a persona minted for this operation

type DemoPack = /* DemoPackSchema; spelled out under "The pack on the wire" */;
```

### 1. `list_demo_scenarios`

> List the demo scenarios that can be used to create a demo Organization. Use
> `get_demo_scenario` to read one's full content before editing it.

Input: `{}` in phase 1; phase 2 adds `{ includeArchived?: boolean }`.

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
      "summary": { "spaces": 3, "channels": 4, "breakouts": 3, "sidekicks": 1, "uploads": 7, "parts": ["priya", "marcus", "dana"], "seededRuns": 9 }
    }
  ]
}
```

A built-in's `revision` is its version string; a saved scenario's (phase 2) is
an integer, with `savedBy`, `savedAt` and `archivedAt` beside it.
`summary.seededRuns` is the number of seeded runs preparation will start and
wait on one at a time, which is what makes a scenario slow to prepare.

### 2. `get_demo_scenario`

> Read the full content of one scenario as a pack. Edit the returned `pack` and
> pass it to `check_demo_scenario`.

Input: `ScenarioRef` minus the inline form.

Output: `{ scenarioId, revisionId, name, description, revision, contentHash, pack }`.
`pack` is normalized (derived `expect` present). In phase 2, `revision` is what
`save_demo_scenario` takes as `expectedRevision`.

### 3. `check_demo_scenario`

> Check a pack without writing anything, and show it as the presenter will read
> it. Returns either the normalized pack, a summary and a readable preview, or
> every problem with the path of the field and what to change. Fix every issue
> and check again before creating a demo.

Input: `{ pack: unknown, cast?: Record<string, CastEntry> }`. `pack` is
`unknown` on purpose: the tool parses it, so a malformed pack is a list of
issues, not a transport error. `cast` is optional; when given, the shipped cast
checks run too and the preview uses the cast's names.

Output on success:

```json
{
  "ok": true,
  "contentHash": "sha256:…",
  "pack": { "…": "normalized, with the presenter's expect derived" },
  "summary": { "spaces": 2, "channels": 3, "breakouts": 1, "sidekicks": 0, "uploads": 4, "parts": ["priya", "marcus"], "seededRuns": 5 },
  "derived": ["expect[0]"],
  "preview": "## Customer: Northwind\n\n### Evaluation & decision · seated, new\n…"
}
```

**The presenter's `expect` is always derived.** Whatever the pack says for the
presenter, the check replaces it with `demoIdleViewerExpectation`'s answer and
lists that entry's path in `derived`. The presenter never acts, so their flags
have one right answer, and a pack cannot be refused for getting it wrong. An
entry for a cast member, whose flags depend on what they did, is kept as
written and checked by the existing rules.

**`preview`** is Markdown: one section per Space, then per room in the order the
presenter's sidebar will list them, each headed with what the presenter finds
(`seated` or `visible`, `new`, `mentioned`, `waiting on a question`), then each
Sidekick with its schedule in its time zone. `@{role}` becomes the cast name,
or `[<label>]` when no cast is given. It is built from the same planner
(`planDemoSeed`) and room facts (`packRoomFacts`, `visibleRoomsFor`)
preparation uses, so it cannot drift from what is seeded.

Output on failure (`isError: false`, because a refused pack is the normal answer
of a check, not a failed call):

```json
{
  "ok": false,
  "issues": [
    { "path": "steps[4].as", "code": "demo_pack_role_not_in_cast", "message": "Role \"dana\" is not in the cast" }
  ]
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
| `demo_pack_history_live_effects` | A room with `execution: "history"` opens with anything but a `say`, or carries a mention. |
| `demo_pack_sidekick_name_duplicate` | Two Sidekicks share a name (case folded). |
| `demo_pack_viewer_duplicate` / `demo_pack_viewer_not_in_cast` | Each `expect` viewer appears once and is in the cast. |
| `demo_pack_expect_rooms_mismatch` | A viewer's `expect.rooms` is not exactly the rooms visible to them. |

One code is a new rule rather than a name for an existing one:

| Code | Rule |
| --- | --- |
| `demo_pack_personal_room_unsupported` | A `personal` room. The seeder refuses one today with `demo_seed_personal_room_unsupported`, after earlier steps have run; the check reports it before anything is written. |

### 4. `list_demo_cast_candidates`

> List who can present a demo, who can play a part, and the parts a scenario
> needs cast. Use the returned `userId`s in `create_demo_organization`'s
> `presenterUserId` and `cast`, or a `{ name }` for somebody who is not a
> colleague.

Input: `{ scenario?: ScenarioRef }`.

Output: `{ presenters: [{ userId, name, email }], colleagues: [{ userId, name, email }], parts?: [{ role, label }] }`.
`presenters` are active members of `demo-template`; `colleagues` are signed-in
accounts on the company's domain (`listDemoCastCandidates`). `parts` is present
when a scenario is given.

### 5. `create_demo_organization`

> Create a new demo Organization from a scenario and start preparing it. Returns
> at once with the operation's status; call `get_demo_operation` to follow it to
> Ready. Calling again with the same `requestKey` returns the same operation and
> never creates a second Organization.

Input:

```ts
{
  requestKey: string;                         // client-chosen, [a-z0-9-], one per demo you mean
  scenario: ScenarioRef;
  companyName: string;                        // the Organization is named `${companyName}-demo`
  presenterUserId: string;                    // from list_demo_cast_candidates.presenters
  cast: Record<string, CastEntry>;            // every part but presenter
  connections?: ConnectionSelection;          // phase 2; see list_template_connections
}
```

What happens, in order:

1. **Replay first.** The operation ID is derived from
   `(actor.subject, requestKey)`. If that operation exists, its status is
   returned and nothing else runs: no pack is resolved, checked or stored, and
   the inputs are not compared. This is `startDemoOperation`'s shipped rule,
   for its shipped reason: re-checking a repeat against a directory that has
   moved since would refuse a retry of a preparation that is running fine. A
   different `requestKey` is a different demo.
2. The pack is resolved and checked (`check_demo_scenario`'s rules). A failing
   pack is refused with `demo_scenario_invalid` and its issues; nothing is
   written.
3. The shipped start checks run, with their shipped codes (`demo_pack_role_unbound`,
   `demo_pack_role_unknown`, `demo_presenter_cast`, `demo_cast_duplicate`,
   `demo_cast_name_duplicate`, `demo_cast_not_a_colleague`,
   `demo_presenter_not_in_template`).
4. The pack, built-in or inline, is stored as an unnamed revision. Unnamed
   revisions are unique by content hash, so storing the same pack again finds
   the existing row and writes nothing. A create refused in steps 2 or 3 has
   stored nothing.
5. The operation row is written with the revision, the request key and the
   requester, and the Workflow is launched, as today.

Output: the status shape of `get_demo_operation`.

### 6. `list_demo_operations`

> List demo operations, newest first, with their status. Use it to find a demo
> you started earlier.

Input: `{ status?: "running" | "failed" | "ready" | "abandoned" }`.

Output: `{ operations: Status[] }`, as the shipped list returns them.

### 7. `get_demo_operation`

> Read one demo operation's progress. While it is running, call again to follow
> it; the waiting phase's gaps say what has not arrived yet. When it fails,
> `recovery` names the tool that recovers it.

Input: `{ operationId: string }`.

Output (`Status`): the shipped `DemoOperationStatusSchema`, returned as is,
plus optional fields that Ace ignores:

```json
{
  "operationId": "…",
  "companyName": "Northwind",
  "presenterUserId": "…",
  "presenterName": "…",
  "packVersion": "stored:sha256:…",
  "cast": { "presenter": "…", "priya": "…", "marcus": "…", "dana": "…" },
  "castNames": { "presenter": "…", "priya": "…", "marcus": "Sam Lee", "dana": "Dana (persona)" },
  "workspaceId": "…",
  "workspaceName": "Northwind-demo",
  "status": "running",
  "attempt": 1,
  "failedPhase": null,
  "error": null,
  "createdAt": "…",
  "updatedAt": "…",
  "readyAt": null,
  "retiredAt": null,
  "phases": [
    { "phase": "waiting_for_workspace", "status": "running", "attempt": 1, "detail": { "gaps": [ { "viewerUserId": "…", "room": "vendor-selection", "code": "mention_missing", "detail": "…" } ] }, "error": null, "startedAt": "…", "finishedAt": null }
  ],
  "seeding": { "confirmed": 14, "total": 14 },

  "requestKey": "…",
  "scenario": { "source": "stored", "revisionId": "…", "scenarioId": null, "contentHash": "sha256:…" },
  "requestedBy": "…",
  "recovery": null,
  "notices": []
}
```

Everything above the blank line is the shipped shape, unchanged. `packVersion`
is the built-in version for a built-in scenario and `stored:<contentHash>` for a
stored one, so the shipped field stays meaningful without a second one.
Connection results stay where they are today, in the `copying_connections`
phase's `detail`.

The optional fields:

- `recovery`: when `status` is `failed`, the tool that recovers it:
  `retry_demo_operation`, or `abandon_demo_operation` for a seeded run's own
  failure (`demo_seed_run_failed`, `demo_seed_run_outcome_mismatch`), which a
  retry cannot reach. Otherwise `null`.
- `notices` on Ready: `{ code: "presenter_cannot_see_organizations", message }`
  when `multiple-workspaces-enabled` is off for the presenter.

### 8. `retry_demo_operation`

> Start the next attempt of a failed or stalled operation. Every phase resumes
> from what the last attempt finished. A failed seeded run cannot be retried
> into success; for `demo_seed_run_failed`, abandon and create a new demo.

Input: `{ operationId: string, expectedAttempt: number }`. `expectedAttempt` is
the `attempt` the caller read. **New:** if the row's attempt has moved past it,
the call answers `demo_operation_changed` (the shipped code for a retry that
raced) and starts nothing, so a replayed retry does not supersede the driver
the first one started. Otherwise it calls the shipped `retryDemoOperation`.

Output: `Status`.

### 9. `abandon_demo_operation`

> Abandon an unfinished demo and retire its candidate Organization. Cannot be
> undone. Repeat the operation ID in `confirmOperationId`.

Input: `{ operationId: string, confirmOperationId: string }`, as the shipped
abandon request.

Output: `Status` with `status: "abandoned"`. An incomplete retirement answers
the shipped `demo_abandon_incomplete`; calling again resumes it.

### 10. `retire_demo_organization`

> Retire a published demo Organization permanently: it closes for everyone in
> it and cannot be reopened. Only Organizations created by demo preparation can
> be retired here. Repeat the Organization's name in `confirmName`.

Input: `{ organizationId: string, confirmName: string }`.

Output: `{ organizationId, retiredAt, complete: boolean }`. Calling again
resumes an incomplete walk.

### 11. `save_demo_scenario` (phase 2)

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
refused with `invalid_input`. Saving content identical to the latest revision
returns that revision and writes nothing.

Output: `{ scenarioId, revision, revisionId, contentHash }`.

### 12. `archive_demo_scenario` (phase 2)

> Hide a saved scenario from `list_demo_scenarios`. Its revisions stay, and
> demos made from it are unaffected. Archiving twice is harmless.

Input: `{ scenarioId: string }`. Output: `{ scenarioId, archivedAt }`.

### 13. `list_template_connections` (phase 2)

> List the connections in the demo template and whether each can be copied into
> a demo. Use the `connectionId`s of copyable ones in
> `create_demo_organization`'s `connections` to copy only some of them.

Input: `{}`.

Output: `{ connections: [{ connectionId, connectorType, displayName, scope, copyable, skipReason }] }`.
`skipReason` is `null`, `personal_scope` or `shared_grant`. No credential,
account token or provider account identifier is returned.

`create_demo_organization` then accepts:

```ts
type ConnectionSelection =
  | { mode: "all" }                               // the default, and today's behavior
  | { mode: "none" }
  | { mode: "only"; connectionIds: string[] };
```

The copier copies only the selected IDs. A selected ID that is not copyable is
refused in step 3 of the create, before a row is written.

## The pack on the wire

What `get_demo_scenario` returns and what check and create accept. This is
`DemoPackSchema` in `apps/api/src/services/demo-pack.ts` as of this PRD; every
object is strict (unknown keys refused). The MCP advertises the same schema to
clients as JSON Schema generated from the Zod schema with `z.toJSONSchema`, so
the advertised shape cannot drift from the parsed one. The cross-field rules
(who may speak where, one question per conversation, and the rest of the
check's rule table) cannot be stated in JSON Schema, which is why the check
exists.

```ts
type Role = string;      // ^[a-z][a-z0-9-]{0,39}$; "presenter" is the presenter
type Key = string;       // ^[a-z][a-z0-9-]{0,39}$; a room, Breakout or Space key
type StepId = string;    // ^[a-z0-9][a-z0-9-]{0,79}$; unique across the pack
type Text = string;      // 1 to MESSAGE_MAX_CHARACTERS; `@{role}` mentions a cast member

type Turn =                                      // DemoSeedTurnSchema
  | { kind: "say"; text: string }                // 1 to 20,000 characters
  | { kind: "ask"; prompt: string; options: string[] };  // prompt 1 to 4,000; 2 to 8 options of 1 to 200

type Step =
  | { kind: "create_workstream"; id: StepId; room: Key; as: Role; title: string;
      space?: Key; participants: Role[]; scope: "workspace" | "personal";
      openingMessage: Text; assistant: Turn; execution?: "run" | "history" }
  | { kind: "create_substream"; id: StepId; room: Key; substream: Key; as: Role;
      title: string; participants: Role[]; startingContext: string }  // context 1 to 20,000
  | { kind: "message"; id: StepId; room: Key; substream?: Key; as: Role;
      text: Text; assistant?: Turn }              // absent: the line starts no run
  | { kind: "upload"; id: StepId; room: Key; substream?: Key; as: Role; title: string;
      fileName: string; mimeType: "text/markdown" | "text/plain"; content: string }
  | { kind: "sidekick"; id: StepId; as: Role; scope: "personal" | "workspace";
      name: string;                 // 1 to 140
      description: string;          // 1 to 1,200
      overview: string;             // 1 to 3,000
      instructions: string;         // 1 to 12,000
      schedule: { rrule: string; timezone: string /* IANA */; summary: string };
      firstRun?: { kind: "say"; text: string } };

type DemoPack = {
  version: string;                               // a label; stored revisions are identified by hash
  roles: Role[];                                 // unique; includes "presenter"
  roleLabels: Record<Role, string>;              // every role but presenter; 1 to 40
  spaces?: Record<Key, { as: Role; name: string; iconKey: SpaceIconKey; colorKey: SpaceColorKey }>;
  steps: Step[];                                 // at least one
  expect?: Array<{                               // the presenter's entry is derived by the check
    viewer: Role;
    attention: { waitingForYou: number; waitingReason: "mentioned" | "needs_input" | "unseen" | null };
    rooms: Record<Key, { unseen: boolean; hasUnread: boolean; mentioned: boolean }>;
  }>;
};
```

`SpaceIconKey` and `SpaceColorKey` are the enums in
`packages/contracts/src/spaces.ts`; the JSON Schema lists their values. Every
limit above is the existing schema's, not one this PRD sets.

## Discovery and sequencing

Where every input comes from:

| Input | Producer |
| --- | --- |
| `scenarioId`, `revisionId` | `list_demo_scenarios`, `get_demo_scenario`; `revisionId` also from `get_demo_operation.scenario` |
| `pack` | `get_demo_scenario` (edited by the client), or written by the client |
| role tokens for `cast` | `pack.roles` minus `presenter`, or `list_demo_cast_candidates.parts` |
| `userId` | `list_demo_cast_candidates` |
| `requestKey` | the client |
| `operationId` | `create_demo_organization`, `list_demo_operations` |
| `expectedAttempt` | `get_demo_operation.attempt` |
| `organizationId`, its name | `get_demo_operation.workspaceId`, `.workspaceName` |
| `expectedRevision` (phase 2) | `get_demo_scenario.revision`; `null` to create |
| `connectionId` (phase 2) | `list_template_connections` |

Common sequences:

- **Built-in, as is:** `list_demo_cast_candidates({ scenario })` →
  `create_demo_organization` → `get_demo_operation` until `ready` or `failed`.
- **Customized:** `get_demo_scenario` → edit → `check_demo_scenario` (repeat
  until `ok`; `preview` is there for the operator to read) →
  `create_demo_organization({ scenario: { pack } })` → `get_demo_operation`.
- **Recover:** `get_demo_operation` → `recovery` → that tool.
- **Phase 2, save for the team:** … `check_demo_scenario` →
  `save_demo_scenario` (`expectedRevision: null`). Later: `get_demo_scenario` →
  edit → `save_demo_scenario({ scenarioId, expectedRevision })`; on
  `demo_scenario_revision_conflict`, read again and rebuild the edit.

## Failures

`message` below is the exact sentence returned. A shipped code keeps its
shipped HTTP meaning and message text, with the next step appended; it is
marked **shipped**. Structured detail keys are the ones listed; nothing else is
added.

| Code | Origin | Tools | Message | Model should |
| --- | --- | --- | --- | --- |
| `invalid_input` | new | all | "The input does not match this tool's schema at `<path>`. Fix that field and call again." | correct and retry |
| `demo_scenario_invalid` | new | 5 | "The scenario has problems listed in `issues`. Fix every issue, check it with check_demo_scenario, and call again." (`issues`) | correct and retry |
| `demo_scenario_not_found` | new | 2, 4, 5 | "No scenario has this ID or revision. Call list_demo_scenarios for the current ones." | inspect first |
| `demo_scenario_too_large` | new | 5, 11 | "The pack is larger than D1's row limit of `<bytes>` bytes. Shorten uploads or split the scenario." (`limitBytes`) | correct |
| `demo_pack_role_unbound` | shipped | 5 | "Nobody is cast as `<role>`. Give every part a userId or a { name }." | correct and retry |
| `demo_pack_role_unknown` | shipped | 5 | "`<role>` is not a part in this scenario. Remove it from cast." | correct and retry |
| `demo_presenter_cast` | shipped | 5 | "The presenter is chosen by presenterUserId, not in cast. Remove presenter from cast." | correct and retry |
| `demo_cast_duplicate` | shipped | 3, 5 | "One person is cast in two parts. Cast a different person or a typed name in one of them." | correct and retry |
| `demo_cast_name_duplicate` | shipped | 3, 5 | "Two people in this demo share a display name. Use a typed name for one of them." | correct and retry |
| `demo_cast_not_a_colleague` | shipped | 3, 5 | "The person cast in `<role>` is not a signed-in account on the company's domain. Pick one from list_demo_cast_candidates or type a name." | correct and retry |
| `demo_presenter_not_in_template` | shipped | 5 | "The presenter must be a member of the demo template. Pick one from list_demo_cast_candidates.presenters." | correct and retry |
| `demo_preparation_launch_failed` | shipped | 5, 8 | "The preparation could not be started. Call retry_demo_operation for this operation." (`operationId`) | retry once |
| `demo_operation_not_found` | shipped | 7–9 | "No demo operation has this ID. Call list_demo_operations." | inspect first |
| `demo_operation_not_retryable` | shipped | 8 | "A `<status>` demo cannot be retried. Create a new demo instead." | stop |
| `demo_operation_changed` | shipped | 8 | "The operation changed after you read it. Read it again with get_demo_operation before retrying." | re-read |
| `demo_operation_ready` | shipped | 9 | "This demo is already Ready. Use retire_demo_organization to close it." | switch tool |
| `demo_abandon_unconfirmed` | shipped | 9 | "The confirmation does not match. Repeat the operation ID to confirm." | correct, only on the operator's say-so |
| `demo_abandon_incomplete` | shipped | 9 | "Some objects are not retired yet. Call abandon_demo_operation again to resume." | retry once |
| `demo_retire_unconfirmed` | new | 10 | "The confirmation does not match. Repeat the Organization's exact name to confirm." | correct, only on the operator's say-so |
| `demo_not_a_demo_organization` | new | 10 | "This Organization was not created by demo preparation and cannot be retired here." | stop |
| `demo_region_unsupported` | shipped | all | "Demos are prepared only in Global." | stop |
| `demo_preparation_unavailable` | shipped | 5, 8 | "Demo preparation is not available in this deployment." | stop |
| `regional_unavailable` | new | all | "Rally's API did not answer. Try again in a moment." | retry once |
| `demo_scenario_revision_conflict` | new, phase 2 | 11 | "The scenario changed after you read it (now revision `<n>`). Read it again with get_demo_scenario and rebuild the edit." (`currentRevision`) | re-read, rebuild |
| `demo_scenario_name_taken` | new, phase 2 | 11 | "Another live scenario has this name. Choose a different name, or revise that scenario instead." | correct and retry |
| `demo_scenario_builtin_readonly` | new, phase 2 | 11, 12 | "Built-in scenarios change only through the code. Save your edit under a new name." | correct and retry |
| `demo_connection_not_copyable` | new, phase 2 | 5 | "Connection `<id>` cannot be copied (`<reason>`). Leave it out of connections." (`connectionId`, `reason`) | correct and retry |

Phase failures inside a running operation are not tool errors: they arrive in
`get_demo_operation.error` with the shipped codes (`demo_seed_run_failed`,
`demo_seed_run_outcome_mismatch`, `demo_projection_wait_exhausted`,
`demo_template_missing`, `demo_presenter_unknown`, `demo_cast_not_a_colleague`,
…) and `recovery`. Ace's handling of every shipped code is unchanged.

**Ambiguous writes.** If `create_demo_organization`'s response is lost, the
client calls it again with the same `requestKey` and gets the operation. A
retry whose response is lost is repeated with the same `expectedAttempt` and
answers `demo_operation_changed` instead of starting a third attempt. Abandon
and retire resume. No write needs a blind retry.

## Authority and lifecycle

- **Model choice:** the pack, the company name, cast entries, `requestKey`, and
  in phase 2 scenario names and the connection selection.
- **Host-derived:** the actor (from the Access assertion the MCP Worker
  verified), the operation ID, the template, the region, the presenter's
  eligibility, which connections are copyable, every destination ID in the
  demo.
- **Never accepted:** a source workspace ID, a template ID, credential bytes, a
  seed for a single message outside a pack, a timestamp.
- **Cancellation:** closing the client cancels nothing; operations are
  Workflows. Abandon is the only cancel.
- **Truncation:** none. Tool output is whole; a long preview is long.

## Model-usability acceptance

- Schema snapshot tests for every tool's input and output, including each
  refused shape above, and a test that `get_demo_operation`'s output still
  parses with the shipped `DemoOperationStatusSchema` once its optional fields
  are removed.
- Contract tests through the real MCP handler, as
  `apps/engineering-mcp/test/server.test.ts` does, with a double only for the
  regional binding.
- Prompt evaluations on the configured medium fallback model covering:
  discovery from nothing to a Ready demo of the built-in scenario; a customized
  demo from a plain-language request; fixing a pack from check issues; a
  replayed create with a lost response; and stopping on
  `demo_not_a_demo_organization` instead of retrying.
