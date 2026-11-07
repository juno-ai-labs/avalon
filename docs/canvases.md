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
| `packages/contracts/src/conversation-parent.ts` | `ConversationParentKindSchema` gains `canvas`. |
| `apps/api/src/services/authorization-policy.ts` | `audienceAdmits`, the one audience rule, which `canvasAdmits` and `sidekickAdmits` apply over their own facts; `canvasManages`. |
| `apps/api/src/durable-objects/canvas-schema.ts` | `WorkspaceDO` migration 139 (`canvas_directory`, `canvas_participants`, the `canvases` list waterline) and 140 (a Sidekick's conversation attachments admit a Canvas). |
| `apps/api/src/durable-objects/hosted-conversation.ts` | `HostedConversation`: the conversation-parent contract one hosted conversation answers — authority, the viewer check, children, the children's effects, and each reader's read of `"0"`. A Canvas and a Sidekick both extend it. |
| `apps/api/src/durable-objects/hosted-canvas.ts` | `HostedCanvas`: one Canvas's parent state inside `WorkspaceDO`, scoped to a `canvas_id` — creation, the read rule over a row (`canvasReaderAllows`), the audience, guest shares and authorization facts. |
| `apps/api/src/durable-objects/workspace-do.ts` | The facade: `canvasCreate`, `canvasDetail`, `canvasSetAudience`, `hostedConversationAuthorizationFacts`, every conversation-parent method for a Canvas id, and the Canvas branch of `createScopeInvitations`, `claimScopeInvitations`, `revokeScopeInvitation` and the invitation alarms. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Conversation object migration 83: its root row admits the `canvas` parent kind. |
| `apps/api/src/services/canvas-service.ts` | `createCanvas`: the directory row, then the Chat's object, bootstrapped and provisioned with the creator seated. |
| `apps/api/src/services/conversation-service.ts`, `socket-service.ts` | Opening a Canvas's Chat: admission by the Canvas, the reader seated, and a ticket whose `pk` is `canvas`. |
| `apps/api/src/services/authorization-service.ts` | A Canvas conversation's and its artifacts' canonical read decision, from `hostedConversationAuthorizationFacts`. |

## How it works

### Identity

A Canvas id is a conversation-parent id: the same `WorkstreamId` brand a
Thread's or a Sidekick's conversation is named by, so its Chat (substream
`"0"`) is an ordinary conversation object and every conversation route, ticket
and tool takes it. Its directory row in `WorkspaceDO` (`canvas_directory`) is
what makes the id a Canvas rather than a Thread or a Sidekick; `WorkspaceDO`
asks for that row (`isCanvasParent`) after a Sidekick's and before the Channel
fallback.

The row holds the title, the creator, when it was made and last changed, the
last editor (a person, Rally or a Sidekick), the Sidekick that writes it when a
run made it (`writer_sidekick_id`, with the run in `writer_run_id`), its
visibility, and its authority generation.

### One hosting primitive

A Canvas and a Sidekick are the same kind of parent: a shared conversation
(`"0"`) and any children, whose parent state lives in `WorkspaceDO`, keyed by
the parent id. `HostedConversation` is that parent: authority, the viewer
check, child reservation and registry, the children's `directory_common`
projections, receipts, and each reader's read of `"0"` (its `directory_user`
report). It keeps them in the four hosted-conversation tables a Sidekick
already had — `sidekick_children`, `sidekick_child_projections`,
`sidekick_child_receipts` and `sidekick_viewer_reads` — keyed by the parent id
in their `sidekick_id` column, which keeps its released name. `HostedSidekick`
adds a Sidekick's definition, triggers and runs; `HostedCanvas` adds the
Canvas's row and audience. A new message in the Chat moves the Canvas's
`updated_at`, so it rises in the recency list.

The Chat is a `SubstreamAgent` like every other conversation; its root row says
`parent_kind = 'canvas'` (conversation migration 83 widened the CHECK). Opening
it is the conversation route's ordinary admission: `resolveHostedParent`
answers `canvas` and the Canvas's viewer decision in one call, the admitted
reader is seated in the conversation (`admitParticipant`, which a Channel
refuses and a hosted parent's conversation accepts), and the socket ticket's
`pk` is `canvas`. The Chat's effects reach `HostedCanvas.receiveChildEffects`
through the same Queue every conversation's do.

### Who can open a Canvas

`canvasAdmits` is the rule, and every reader applies it; it is `audienceAdmits`,
the same rule a Sidekick's audience is, over a Canvas's facts:

- its **creator**;
- anyone on its **participant list** (`canvas_participants`), a guest among
  them;
- anyone its **writer Sidekick** is shared with, read live from the Sidekick
  (`sidekickReaderAllows`) every time, so a Sidekick's Canvas is reachable by
  everyone in the Sidekick's conversation and by whoever joins it later;
  nothing copies that list into the Canvas;
- for a Canvas whose visibility is `workspace`, **every member** of the
  Organization. A guest is never admitted by Organization visibility, only from
  a list;
- the Organization's **owners and administrators**, who manage every Canvas's
  audience and so can open every Canvas; a creator who leaves does not strand
  one.

A new Canvas is `creator`: its creator alone, and its writer Sidekick's
audience when a run made it.

The conversation viewer check reads the person's role from their Organization
relationship (a guest asks with `requireGrantAuthority`). Resource
authorization, and so `ArtifactOpenService`, decides a Canvas's artifact from
the same facts: an artifact generated in the Chat is attached to it, so a
person who may open the Canvas may open the artifact and nobody else may
(`hostedConversationAuthorizationFacts`, one call for a Sidekick or a Canvas).

### Who changes who can open it

`canvasManages`: the creator, the Organization's owners and administrators,
and for a Canvas a Sidekick writes, that Sidekick's managers
(`sidekickManagerAllows`). Everyone else a Canvas admits reads and takes part
but does not change the audience; someone it does not admit is told it does
not exist.

`canvasSetAudience` replaces the participant list with the one given and sets
the visibility. Everyone named must be in the Organization, as a member or a
guest (`assertAudienceInOrganization`, the check a Sidekick's audience uses;
`canvas_audience_not_member`); a `participants` Canvas names someone other than
its creator (`canvas_audience_participants_empty`).

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
(`sharing_required` otherwise). Creating, claiming and revoking a share, and
its delivery and index alarms, are routed for a Canvas id; listing a Canvas's
shares and grants (`listScopeInvitations`, `scopeSharingOptions`,
`listManagedScopeGrants`, `mutateScopeGrant`) is not yet, and still answers
`scope_not_found`.

## Invariants

- **A Canvas is admitted by `canvasAdmits` and nothing else, and it is the
  rule a Sidekick's audience is.** A second rule in a reader would let one
  surface show a Canvas another refuses. Guard: the Node policy test
  (`test/authorization-policy.test.ts`), `test-workers/canvas-hosting.test.ts`
  and `test-workers/canvas-conversation.test.ts`.
- **A guest is admitted only from a list.** Organization visibility admits
  members; a guest whose share was never claimed opens nothing. Guard: the
  guest cases of both workers files.
- **A writer Sidekick's audience is read live, never copied.** A copy would be
  a second source of truth that disagrees as soon as either list changes.
- **The participant list is the authority for whom managers added; a grant is
  the share's receipt.** Removing someone from the list removes their access
  even though the grant row that brought them stays. Nothing reads
  `parent_grants` to admit a Canvas reader.
- **Every `canvas_*` statement names `canvas_id`, and every hosted-conversation
  statement names the parent id.** Without it a write reaches every Canvas or
  every Sidekick in the Organization.

## Boundary

This module owns a Canvas's directory row, its audience, its guests and its
parent state. It does not own the conversation
([`workstream-durable-object.md`](workstream-durable-object.md)), the hosting
mechanics it shares with a Sidekick
([`hosted-conversation-parents.md`](hosted-conversation-parents.md)), the share
primitive's delivery and claim mechanics
([`scope-invitations.md`](scope-invitations.md)), or what a published artifact
becomes ([`live-web-artifacts.md`](live-web-artifacts.md)).

## Failure modes and limits

| Condition | Behavior |
| --- | --- |
| A person the Canvas does not admit asks for it, or opens its Chat | `canvas_not_found` from the Canvas's own reads, `conversation_not_found` from the conversation route: the same answer as an id that names nothing. |
| A participant who does not manage it changes its audience or shares it | `canvas_forbidden`; a share answers `sharing_required`. |
| A person named in an audience change is not in the Organization | `canvas_audience_not_member`; nothing is written. |
| An invitation email cannot be sent | The share stays pending and its delivery alarm retries, as a Channel share does. |
| A second create for the same Sidekick run under another Canvas id | Fails on `canvas_directory_run_idx`; a caller looks the run's Canvas up first. |

## Testing

- `apps/api/test/authorization-policy.test.ts` — `audienceAdmits`,
  `canvasAdmits` and `canvasManages`.
- `apps/api/test-workers/canvas-hosting.test.ts` — on real workerd: a new
  Canvas opens to its creator alone; a participant opens it and does not
  manage it; an administrator opens and manages a private one; an
  Organization-wide Canvas opens to every member and no outside guest; a guest
  invited by email opens it; a non-manager cannot share it. The suite's D1 has
  no schema, so the file declares `workspaces`, `workspace_members`, `users`
  and the share tables; every case uses fresh workspace and Canvas ids because
  an earlier case's delivery alarm can land after `reset()`.
- `apps/api/test-workers/canvas-conversation.test.ts` — the Chat through the
  conversation route: who it admits, the `canvas` ticket, the Chat's effects in
  the Canvas's hosted-conversation rows, and an artifact attached to the Chat
  admitted to exactly whoever opens the Canvas.
- `apps/api/test/workstream-object-schema.test.ts` — conversation migration 83
  carries a populated v82 root, every column and all nine triggers across the
  rebuild.

## Data model

| Table | Keyed by | Holds |
| --- | --- | --- |
| `canvas_directory` | `canvas_id` | The row: title, creator, times, last editor, writer Sidekick and run, visibility, authority generation. Indexed by recency, by writer Sidekick, and uniquely by `(writer_sidekick_id, writer_run_id)`. |
| `canvas_participants` | `(canvas_id, user_id)` | Whom its managers added (`added`) or a claimed share brought (`invitation`). Indexed by person for "shared with me". |
| `sidekick_children`, `sidekick_child_projections`, `sidekick_child_receipts`, `sidekick_viewer_reads` | `(sidekick_id, …)`, the column holding the Canvas id | The hosted conversation's children, their projections and receipts, and each reader's read of the Chat. |
| `workspace_sidebar_list_state` | `list` | Gains the `canvases` waterline; the table is rebuilt to widen its CHECK. |
| `sidekick_conversation_attachments` | `(automation_id, parent_kind, …)` | Migration 140 widens `parent_kind` to admit `canvas`. |

## Changelog

### 2026-11-07 — Document created: a Canvas is a hosted conversation with its own audience

**What changed:** A Canvas has a directory row in `WorkspaceDO` (migration 139),
keyed by the parent id of its `canvas`-kind conversation, with a participant
list, a creator-only default, an Organization-wide option, guests invited
through the Channel share primitive keyed by the Canvas id, and administrators
admitted to every Canvas. Its Chat is an ordinary conversation object on the
one hosting primitive a Sidekick also uses, `HostedConversation`, and its
artifacts are admitted to whoever opens it. `audienceAdmits` is the one rule
under both `canvasAdmits` and `sidekickAdmits`.

**Why:** The Canvases and Sidekicks decisions: a Canvas is identified by its
conversation and starts empty, so it can generate many artifacts; it has its
own participant list, creator-only by default, with guests; only its creator
and the Organization's owners and administrators change who can open it, and
an administrator can open every Canvas because they manage it (a creator who
leaves would otherwise strand one); a Sidekick's Canvas admits the Sidekick's
audience as it stands. The share primitive was re-keyed rather than copied
because it already owns delivery, the sign-in claim and the guest
relationship. The hosting was generalized from the Sidekick's rather than
cloned, so the effect receipts, projections and read state have one
implementation.

**Considered and rejected:** Keying a Canvas by an artifact: an empty Canvas
has no artifact, and a version with no maker has no provenance. Copying a
Sidekick's audience into a new Canvas: the first build did, and also read it
live, two sources of truth that disagreed as soon as either list changed. A
second host class cloned from `HostedSidekick`: two copies of the receipt and
projection logic. New `canvas_*` child tables: the hosted-conversation tables
are keyed by parent id already, and nothing that scans them across parents
reads them without joining its own directory.

**Consequences:** A guest is admitted only from a list; the participant list,
not the grant, is the authority for whom managers added; a writer Sidekick's
audience is read live. A new hosted parent kind extends `HostedConversation`
and is dispatched in `WorkspaceDO.hostedConversationParent`. Listing a Canvas's
shares and grants is not routed yet.

Design: `docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`.
