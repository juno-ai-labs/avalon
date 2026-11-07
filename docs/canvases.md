# Canvases

A **Canvas** is the shared home for work in Rally: a conversation with Rally
that everyone in the Canvas can read and take part in, and the artifacts that
conversation generates — documents, spreadsheets, images, PDFs, archives and
live sites. A Canvas is a conversation first. Its id is the parent id of its
`canvas`-kind conversation, so one Canvas can generate many artifacts, and a
new Canvas has none until its Chat publishes one.

This document owns a Canvas's identity, who can open it, its directory row,
its participants and guests, and how its artifacts hang off its conversation.
The conversation engine is [`workstream-durable-object.md`](workstream-durable-object.md)'s;
the hosting inside `WorkspaceDO` is [`hosted-conversation-parents.md`](hosted-conversation-parents.md)'s;
what a published artifact becomes is [`live-web-artifacts.md`](live-web-artifacts.md)'s.
The product decisions are in the [Canvases and Sidekicks PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md#decision-log).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/canvases.ts` | The wire shapes: `CanvasIdSchema` (the `WorkstreamId` brand), `CanvasVisibilitySchema`, `CanvasAudienceUpdateSchema`, the summary and detail. |
| `apps/api/src/services/authorization-policy.ts` | `canvasAdmits` and `canvasManages`: the one copy of who opens a Canvas and who changes that. |
| `apps/api/src/durable-objects/canvas-schema.ts` | `WorkspaceDO` migration 139: `canvas_directory`, `canvas_participants`, `canvas_artifacts`, and the `canvases` list waterline. |
| `apps/api/src/durable-objects/hosted-canvas.ts` | `HostedCanvas`: one Canvas's parent state inside `WorkspaceDO`, scoped to a `canvas_id` — creation, the read rule over a row (`canvasReaderAllows`), the audience, and the guest shares. |
| `apps/api/src/durable-objects/workspace-do.ts` | The facade: `canvasCreate`, `canvasDetail`, `canvasSetAudience`, and the Canvas branch of `createScopeInvitations`, `claimScopeInvitations`, `revokeScopeInvitation` and the invitation alarms. |
| `apps/api/src/durable-objects/scope-invitation-service.ts` | The share primitive a Canvas reuses for guests, given the Canvas's own readiness and title. |

## How it works

### Identity

A Canvas id is a conversation-parent id: the same `WorkstreamId` brand a
Thread's or a Sidekick's conversation is named by, so its Chat (substream
`"0"`) is an ordinary conversation object and every conversation route, ticket
and tool takes it unchanged. Its directory row in `WorkspaceDO`
(`canvas_directory`) is what makes the id a Canvas rather than a Thread or a
Sidekick; `WorkspaceDO` asks for that row (`isCanvasParent`) before the Channel
fallback, as it does for a Sidekick.

The row holds the title, the creator, when it was made and last changed, the
last editor (a person, Rally or a Sidekick), the Sidekick that writes it when a
run made it (`writer_sidekick_id`, with the run in `writer_run_id`), its
visibility, and its authority generation.

### Who can open a Canvas

`canvasAdmits` is the rule, and every reader applies it:

- its **creator**;
- anyone on its **participant list** (`canvas_participants`), a guest among
  them;
- anyone its **writer Sidekick** is shared with (`sidekickReaderAllows`), so a
  Sidekick's Canvas is reachable from the Sidekick's conversation by everyone
  in it;
- for a Canvas whose visibility is `workspace`, **every member** of the
  Organization. A guest is never admitted by Organization visibility, only from
  a list.

A new Canvas is `creator`: its creator alone. A Canvas a Sidekick run makes
starts out open to whoever the Sidekick is shared with: an Organization
Sidekick's Canvas is `workspace`, and any other's is `participants` with the
Sidekick's author, the person it runs as and its `people` list copied in
(source `sidekick`).

### Who changes who can open it

`canvasManages`: the creator, the Organization's owners and administrators,
and for a Canvas a Sidekick writes, that Sidekick's managers (its author and
the person it runs as). Everyone else a Canvas admits reads and takes part but
does not change the audience. A manager must be able to open the Canvas first,
so an administrator outside a private Canvas is told it does not exist.

`canvasSetAudience` replaces the participant list with the one given and sets
the visibility. Everyone named must be in the Organization, as a member or a
guest (`canvas_audience_not_member`); a `participants` Canvas names someone
other than its creator (`canvas_audience_participants_empty`).

### Guests

A guest is invited to a Canvas the way one is invited to a Channel: through
`POST /sharing` (`createScopeInvitations`), with the Canvas id as the parent
and one `workstream` target naming it. The same `parent_invitations` rows, the
same encrypted delivery alarm and the same `scope_share_recipients` lookup are
written, keyed by the Canvas id, and a recipient who already has an account
claims the share as it is made; anyone else claims it at their next sign-in
(`claimScopeInvitations`, which `WorkspaceDO` routes to the Canvas). The claim
writes a `parent_grants` row through `ScopeGrantStorage`, and the Canvas's
directory step for that grant (`applyGrant`) adds the guest to
`canvas_participants` with source `invitation` in the same transaction, moving
a `creator` Canvas to `participants`. Only a manager may share
(`sharing_required` otherwise).

## Invariants

- **A Canvas is admitted by `canvasAdmits` and nothing else.** A second rule in
  a reader would let one surface show a Canvas another refuses. Guard: the
  Node policy test (`test/authorization-policy.test.ts`) and
  `test-workers/canvas-hosting.test.ts`.
- **A guest is admitted only from a list.** Organization visibility admits
  members; a guest whose share was never claimed opens nothing. Guard:
  `canvas-hosting.test.ts`'s guest cases.
- **The participant list is the authority; a grant is the share's receipt.**
  Removing someone from the list removes their access even though the grant row
  that brought them stays. Nothing reads `parent_grants` to admit a Canvas
  reader.
- **Every `canvas_*` statement names `canvas_id`.** Without it a write reaches
  every Canvas in the Organization.

## Boundary

This module owns a Canvas's directory row, its audience and its guests. It
does not own the conversation ([`workstream-durable-object.md`](workstream-durable-object.md)),
the share primitive's delivery and claim mechanics
([`scope-invitations.md`](scope-invitations.md)), or what a published artifact
becomes ([`live-web-artifacts.md`](live-web-artifacts.md)).

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| A person the Canvas does not admit asks for it | `canvas_not_found`, the same answer as an id that names nothing. |
| A participant who does not manage it changes its audience or shares it | `canvas_forbidden`; a share answers `sharing_required`. |
| A person named in an audience change is not in the Organization | `canvas_audience_not_member`; nothing is written. |
| An invitation email cannot be sent | The share stays pending and its delivery alarm retries, as a Channel share does. |

## Testing

- `apps/api/test/authorization-policy.test.ts` — `canvasAdmits` and
  `canvasManages` over every case of the rule.
- `apps/api/test-workers/canvas-hosting.test.ts` — on real workerd: a new
  Canvas opens to its creator alone; a participant opens it and does not
  manage it; an Organization-wide Canvas opens to every member and no outside
  guest; a guest invited by email opens it; a non-manager cannot share it. The
  suite's D1 has no schema, so the file declares `workspaces`,
  `workspace_members`, `users` and the share tables; every case uses fresh
  workspace and Canvas ids because an earlier case's delivery alarm can land
  after `reset()`.

## Data model

| Table | Keyed by | Holds |
| --- | --- | --- |
| `canvas_directory` | `canvas_id` | The row: title, creator, times, last editor, writer Sidekick and run, visibility, authority generation. Indexed by recency, by writer Sidekick, and uniquely by `(writer_sidekick_id, writer_run_id)`. |
| `canvas_participants` | `(canvas_id, user_id)` | Who besides the creator opens it, with how they got there (`added`, `invitation`, `sidekick`). Indexed by person for "shared with me". |
| `canvas_artifacts` | `(canvas_id, resource_id)` | The resources the Canvas's conversation generated, written by the publish that attached each one. Indexed by resource. |
| `workspace_sidebar_list_state` | `list` | Gains the `canvases` waterline; the table is rebuilt to widen its CHECK. |

## Changelog

### 2026-11-07 — Document created: a Canvas is a conversation with its own audience

**What changed:** A Canvas has a directory row in `WorkspaceDO`
(migration 139), keyed by the parent id of its conversation, with a
participant list, a creator-only default, an Organization-wide option and
guests invited through the Channel share primitive keyed by the Canvas id.
`canvasAdmits` and `canvasManages` are the rule.

**Why:** The Canvases and Sidekicks decisions: a Canvas is identified by its
conversation and starts empty, so it can generate many artifacts; it has its
own participant list, creator-only by default, with guests; and only its
creator and the Organization's owners and administrators change who can open
it. A Sidekick's Canvas starts open to the Sidekick's audience so everyone in
the Sidekick's conversation reaches it. The share primitive was re-keyed
rather than copied because it already owns delivery, the sign-in claim and
the guest relationship; a second invitation path would have been a second
place for those to drift. Keying a Canvas by an artifact was rejected: an
empty Canvas has no artifact, and a version with no maker has no provenance.

**What a future change has to respect:** a guest is admitted only from a list;
the participant list, not the grant, is the authority.
