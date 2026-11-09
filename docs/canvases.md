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
| `apps/api/src/durable-objects/canvas-schema.ts` | `WorkspaceDO` migration 137, the Canvas schema (`canvas_directory`, `canvas_participants`, `canvas_artifacts`, the `canvases` list waterline, and the copies that admit a Canvas among a Sidekick's conversation attachments, the pins and the retirement graph). |
| `apps/api/src/durable-objects/hosted-conversation.ts` | `HostedConversation`: the conversation-parent contract one hosted conversation answers — authority, the viewer check, children, the children's effects, and each reader's read of `"0"`. A Canvas and a Sidekick both extend it. |
| `apps/api/src/durable-objects/hosted-canvas.ts` | `HostedCanvas`: one Canvas's parent state inside `WorkspaceDO`, scoped to a `canvas_id` — creation, the read rule over a row (`canvasReaderAllows`), the audience, guest shares and authorization facts. |
| `apps/api/src/durable-objects/workspace-do.ts` | The facade: `canvasCreate`, `canvasDetail`, `canvasUpdate` (the title and the appearance), `canvasSetAudience`, `hostedConversationAuthorizationFacts`, every conversation-parent method for a Canvas id, and the Canvas branch of `createScopeInvitations`, `claimScopeInvitations`, `revokeScopeInvitation` and the invitation alarms. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Conversation object migration 83: its root row admits the `canvas` parent kind. |
| `apps/api/src/services/canvas-service.ts` | `createCanvas`: the directory row, then the Chat's object, bootstrapped and provisioned with the creator seated; `CanvasService`, the routes' service. |
| `apps/api/src/routes/canvases.ts` | `POST /canvases`, `GET /canvases/:id`, `PATCH /canvases/:id` (the title and the appearance), `POST /canvases/:id/audience`, `POST /canvases/:id/pin`. `PUT /workspace/pinned-order` (in `routes/workspace.ts`) orders a Pinned group. |
| `apps/api/src/services/integrations.ts` | `canvasRunContextMessage`: the `CANVAS CONTEXT` message a run in a Canvas's Chat is given. |
| `apps/api/src/services/terminal/authority.ts` | `resolveTerminalPublicationHome` (a Sidekick run publishes into a Canvas) and `canvasArtifactNoter` (a publish tells its Canvas). |
| `apps/api/src/services/conversation-service.ts`, `socket-service.ts` | Opening a Canvas's Chat: admission by the Canvas, the reader seated, and a ticket whose `pk` is `canvas`. |
| `apps/api/src/services/authorization-service.ts` | A Canvas conversation's and its artifacts' canonical read decision, from `hostedConversationAuthorizationFacts`. |
| `apps/desktop/src/renderer/screens/canvases-home.tsx` | `/canvases`: the home page — New Canvas, search, the filter chips, Data and Recent, and the first-run "Start from a prompt" card. |
| `apps/desktop/src/renderer/screens/canvas.tsx` | `/canvases/:id`: the Chat as a `canvas` conversation in `ConversationSurface`, its header (pill, people present, Share, menu), and opening the newest artifact in the right rail. |
| `apps/desktop/src/renderer/components/canvas-share-dialog.tsx` | Share: who can open it, for a manager; the same audience read-only for anyone else; guests invited by email on Save. |
| `apps/desktop/src/renderer/components/canvas-mark.tsx` | `CanvasMark` and `canvasMark`: the chosen icon and colour, else the kind's glyph and `canvasHue`, field by field. |
| `apps/desktop/src/renderer/components/canvas-sidebar-section.tsx` | The Canvases sidebar section: a Pinned group and every Canvas by recent activity. |
| `apps/desktop/src/renderer/lib/canvases.ts` | The list as the socket keeps it (`useCanvasList`), the routes, a row's second line, and creating a Canvas. |

## How it works

### Identity

A Canvas id is a conversation-parent id: the same `WorkstreamId` brand a
Sidekick's conversation is named by, so its Chat (substream `"0"`) is an
ordinary conversation object and every conversation route, ticket and tool
takes it. Its directory row in `WorkspaceDO` (`canvas_directory`) is what makes
the id a Canvas rather than a Sidekick; `WorkspaceDO.hostedConversationParent`
asks for a Sidekick's row first and then for that one (`isCanvasParent`), and
an id that is neither is no conversation parent at all
(`conversation_parent_not_found`).

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

The Chat is an `AgentLoopDO` like every other conversation; its root row says
`parent_kind = 'canvas'` (conversation migration 83 widened the CHECK). Opening
it is the conversation route's ordinary admission: `resolveHostedParent`
answers `canvas` and the Canvas's viewer decision in one call, the admitted
reader is seated in the conversation (`admitParticipant`, which a hosted
parent's conversation accepts), and the socket ticket's
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
relationship (a guest asks with `requireGrantAuthority`); only an active
member has a role, so somebody suspended or with no relationship is never
admitted by Organization visibility. Resource
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

A member it does not admit may ask to be let in; the request, who decides it
and what an approval does are [`canvas-access-requests.md`](canvas-access-requests.md)'s.
An approval adds the requester with source `request`, and an audience change
that admits a person settles their waiting request.

`canvasSetAudience` replaces the participant list with the one given and sets
the visibility. Everyone named must be in the Organization, as a member or a
guest (`assertAudienceInOrganization`, the check a Sidekick's audience uses;
`canvas_audience_not_member`); a `participants` Canvas names someone other than
its creator (`canvas_audience_participants_empty`). Narrowing the audience
backgrounds the presence of anyone it no longer admits and re-sends presence to
the people still in the Canvas, before the one Canvas list the write sends, and
closes the open Chat feed of each person it took away through the
access-revocation Queue ([`access-revocation.md`](access-revocation.md)).

### Guests

A guest is invited to a Canvas through the share primitive
([`scope-invitations.md`](scope-invitations.md)): `POST /sharing`
(`createScopeInvitations`), with the Canvas id as the parent
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
its delivery and index alarms, are routed for a Canvas id. Listing a Canvas's
shares and grants has no route: `POST /sharing` and
`DELETE /sharing/:parentId/:invitationId` are the share routes, and the list,
options and grant routes went with the Channel share code.

### Making a Canvas

`POST /canvases` (`CanvasService.create`, `createCanvas`) writes the directory
row, then bootstraps and provisions the Chat with its creator seated, and
answers with the Canvas id; the Canvas has no artifacts, which the client shows
as the PRD's empty state. With `prompt`, the "Start from a prompt" card's first
message is sent to the Chat as the creator's, through the ordinary message
admission, and the answer names its turn. A guest makes no Canvas
(`canvas_create_member_required`). The client mints the Canvas id and the
prompt's `clientMessageId` once per attempt series (`useCreateCanvas`) and
sends the id as `canvasId`: a second press while one is in flight answers
with that one, and a retry of the same prompt after a failure resends both,
so a create that landed but lost its answer is answered with the Canvas the
first made (`HostedCanvas.create` replays `created: false`) and the first
message is sent once. A success ends the series. The replay is its
creator's alone: somebody else naming the id, or an id another conversation
already anchors in D1's `workstreams`, is refused with `canvas_id_unavailable`. `GET /canvases/:id` is the detail (row,
participants, artifacts at their current versions, whether the reader may
manage it); `POST /canvases/:id/audience` changes who can open it;
`POST /canvases/:id/pin` and `POST /sidekicks/:id/pin` pin. The Chat is opened
through the conversation routes like any conversation.

A Canvas a person makes with no title starts as **Untitled Canvas**, settled
(`canvas_directory.title_status`, migration 137). When the first projection of
its Chat that carries a message reaches the parent (`onChildProjection`,
`latestAttentionOrdinal` moving from 0 to at least 1), the same write sets it
`naming` — only while it is still settled as **Untitled Canvas** and no
Sidekick run wrote it, so a person's retitle is never undone — and the Canvas
arms a `canvas_naming` alarm entry keyed by its id. An empty Canvas therefore
reads as its title, never as a naming skeleton waiting for a message that may
not come; and the provisioning projection of an empty Chat (no ordinal before,
0 now) is not activity, so it does not move the Canvas up the recency list.
The entry's handler,
`HostedCanvas.nameFromOpening`, reads the oldest text message a person sent
in the Chat through the message port (`saidMessages`, `peopleOnly`), asks `canvasTitleFromOpening` (the `workstream_naming` role,
reasoning off, metered as `channel_naming`) and writes the title in one
statement guarded by `title_status = 'naming'`, which also settles it, so the
list and the detail move as a retitle moves them. A retitle settles the row
first, so a person's title always wins over a pass still in flight; a model
that fails or answers nothing settles the row as it is, logged
`canvas_naming_failed` with its code. A Canvas a Sidekick run makes, or one
made with a title, is never `naming`. A first message that carries
only attachments has no text to read, so the Canvas stays `naming` until a
person's text message arrives, which arms the entry again.

`PATCH /canvases/:id` refuses a title that is empty, blank or over 300
characters as `canvas_rename_invalid:title:<issue>`, an icon or colour outside
the storable vocabulary as `canvas_rename_invalid:appearance.<field>:<issue>`,
and a body that changes nothing (no title, and no appearance field) as
`canvas_rename_invalid:-root-:custom` (the object itself refuses an empty update as `canvas_update_empty`), all under the rename's released label
with one sentence true of each, and every Canvas route
refuses a malformed id as `canvas_id_invalid:id:<issue>`, through
`namedZValidator`, each with a sentence the client shows; a well-formed id
that names no Canvas is `canvas_not_found`.

### Choosing what a Canvas looks like

A Canvas may carry an icon and a colour somebody chose, the same two keys a
Sidekick stores and parsed by the same `WorkstreamAppearanceSchema`
([`automation-lifecycle.md`](automation-lifecycle.md#choosing-what-a-sidekick-looks-like)
owns the catalog and the ring). They live on the directory row as
`appearance_json` (migration 137), null until someone chooses, and the
summary carries them as `appearance` on the list row, the detail and a
Sidekick's Canvases, each field null while unchosen. An unchosen icon draws the
glyph of the newest artifact's kind and an unchosen colour the hue the id
gives it (`canvasHue`), so a Canvas nobody dressed looks as it always has.

`PATCH /canvases/:id` with `appearance` sets them, beside or instead of a
title, by anyone the Canvas admits, the rule renaming has, and
`canvas_not_found` to anyone else. The choice is partial and merged field by
field into what is stored, as a Sidekick's is, so two people picking at once
each keep their field, and a null field goes back to the default. Choosing is
not activity: `updated_at` stays, so the Canvas keeps its place in the recency
list, and the write advances the `canvases` waterline, so every open list
redraws the mark. A stored choice that no longer parses (a key retired past
what is storable) reads as unchosen, logged
`canvas_directory_appearance_invalid` with its field and reason
(`parsedAppearance`, the Sidekick list's own), so one bad row never fails a
list, and the next choice overwrites it.

### A Canvas that was a Thread

A Canvas may have been a Thread. `convert_threads_to_canvases`, an operator
operation run once in every Organization after the pivot and removed once it
had, made every Thread that made or linked an artifact a Canvas with the same
id ([`workspace-retirement.md`](workspace-retirement.md#converting-threads-that-have-artifacts)
records it). What it kept: the id, so `artifact_registry`, search, the D1 anchor
and the route already name the Canvas; the Thread's Main as the Chat, its
conversation object's stored parent kind rewritten to `canvas`; its title, its
creator (or its earliest viewer), its creation time and its last activity;
Organization visibility for a Workspace-scoped Thread and participants for a
personal one; as `added` participants, every viewer of a personal Thread
(their row is what admitted them, so copying it keeps their access) and only
the viewers marked participants of a Workspace-scoped one (anyone who merely
listed it is admitted by the Organization visibility, and a participant row
would outlive a later narrowing); every artifact it
made or linked, in `canvas_artifacts`; the memory facts learned in its Main,
renamed to the Canvas's source; and a Sidekick's attachment to its Main.

**A Thread becomes one Canvas, Breakouts included.** An artifact a Breakout
attached, private Breakout or not, is carried into the Chat before the
Breakout is retired, so every reader of the Canvas opens it as they open an
artifact the Chat made; the Canvas lists it either way. This widens access:
a private Breakout's members chose a smaller audience, and the conversion
opens those artifacts' content, not only their titles, to every reader of
the Canvas, which for an Organization-wide Thread is the whole Organization.
That is the implementer's reading of the conversion rule, open to the owner,
not the owner's call. Listing it while only
its uploader could open it was the rejected half: a reader saw a title they
could not open, from a conversation that no longer exists. Dropping it from
`canvas_artifacts` was the other option, rejected because the conversion's
point is to keep a Thread's artifacts. Only the Canvas's artifacts move; any
other resource a Breakout attached stays with the retired Breakout.

What it did not keep: its Breakouts, retired as `retire_threads` retired the
rest, and its unread state, which starts empty. Such a Canvas has no writer Sidekick and
no last editor until its Chat next publishes. A creator who had stopped being
one of the Thread's viewers opens the Canvas again, as its creator.

### Artifacts and versions

A Canvas's artifacts are resources its conversation generated: Rally's
`publish_resource` from the Chat publishes under the identity it always has,
`(conversation, path)`, and the conversation is now the Canvas. The first
publish of a path is a new resource, version 1; a later publish of the same
path is a new version of it; a different path is another artifact. A file of
any kind, or a directory that becomes a site or an archive, as
[`live-web-artifacts.md`](live-web-artifacts.md) decides.
`artifact_registry.workstream_id` holds the Canvas id, which is the
conversation's parent id, so no column changes meaning. After each publish the
Terminal's resource bridge tells the Canvas (`canvasArtifactNoter`,
`WorkspaceDO.canvasNoteArtifact`), from a publish that returned and from one
`reconcilePublishedResource` recovers as `landed` (the attempt that wrote it
may have died before its note), which records the resource in
`canvas_artifacts`, moves the Canvas's `updated_at`, and names its last editor:
Rally for the Chat, the Sidekick for a run. A run's note also names the run
(its substream id, which is the run id), stored as
`canvas_directory.last_writer_run_id` (migration 137); any note that is not a
run's clears it, so it always names the run whose publish made the newest
version or nothing. It is not `writer_run_id`, the run that created the
Canvas: a Sidekick writing one Canvas across runs moves this and not that.
Nothing was backfilled: a Canvas a run wrote before migration 137 reads as
written by no run until its next publish. The resource versioning layer
records every version with its run, as it does everywhere; `canvas_artifacts`
records only which resources the Canvas holds. A version somebody else made
since a viewer last read the Chat makes the Canvas's row unread to them, by
the rule a pinned artifact's news uses (a republish or replacement, not their
own or one made on their behalf).

By the same rule, a new version tells everyone who **pinned** the Canvas:
the note reads the resource's newest version and, when it is news, records
one `artifact_updated` intent and Activity row per pinner other than its
author (`tellCanvasPinners`), whose push opens the Canvas onto that artifact
([`push-notifications.md`](push-notifications.md#a-pinned-canvass-new-version)).
Only a version whose publish notes the Canvas does: one written by another
producer (an image edit, a connector refetch) tells nobody until the next
publish of the Canvas, which covers what the pinner cares about here, the
Canvas's own work.

### From a Sidekick run

A Sidekick run (a child of the Sidekick, whose substream id is the run id)
publishes into a Canvas, the Sidekick's output (`resolveTerminalPublicationHome`).
Its first publish creates the run's Canvas: the run's principal is its
creator, the Sidekick its writer, the publish's `displayName` its title, and
whoever the Sidekick is shared with can open it. Every later publish of the
run finds that Canvas (`canvasForSidekickRun`; `HostedCanvas.create` answers a
second create for the same run with the first Canvas). A run asked to update a
Canvas names it with `publish_resource`'s `canvas` argument, which must be a
Canvas this Sidekick writes (`canvas_not_written_by_sidekick` otherwise);
anything but a Sidekick run naming one is refused (`canvas_argument_unsupported`).
The run's own conversation is attached too, so the run can read back what it
published. "The Canvases it writes to" is `canvasesWrittenBy`, a query on the
directory by writer, on the Sidekick's detail as `canvases`, filtered to what
the reader may open.

### Rally in a Canvas Chat

A message in a Canvas's Chat reaches Rally through the conversation's
addressing: alone in the Canvas, every message is for Rally; with others there,
the addressing classifier (`classifyWorkstreamMessage`) decides whether a
message is for Rally or for the people. The run has the resource tools
(`list_resources`, `read_resource`, `view_resource`, the artifact data tools
keyed by the Canvas id) and the Terminal's `publish_resource`, which publishes
into the Canvas. It has no conversation tools; those serve a Sidekick
([`conversation-tools.md`](conversation-tools.md)).

Rally is told about the Canvas in a host-provided message, `CANVAS CONTEXT`
(`canvasRunContextMessage`, from `WorkspaceDO.canvasContext`): the Canvas's
title, its artifacts at their current versions, and that republishing a path
is a new version attributed to Rally while a new path adds an artifact. It is a
derived user message, as a Sidekick run's activation context is, not system
prompt text, because the system prompt prefix is byte-stable and cached and
the artifact list changes with every publish; it is keyed on the message that
woke the run, so a recovered execution renders the same context, under its own
source kind (`canvas_context`), so it never shares an identity with another
derived message keyed on that same message.

Memory a Canvas's Chat learns is sourced `canvas:<canvasId>` and filed under
the stored subject kind `thread` with the Canvas id (`memory-review-service.ts`
maps a `canvas` subject to it): the `memory_facts` CHECK still names the
Thread-era kinds, and renaming one means rebuilding that table, which has not
been done. Who may read such a fact is the Canvas's
audience (`canvasReaderAllows` for a person, Organization-wide for
`workspace` visibility or an Organization Sidekick's Canvas).

### The Canvas list

The workspace socket carries each viewer's Canvas list: `canvases` on the
subscribe payload's sidebar, and a `workspace_canvas_list` push whenever a
Canvas's row, its participants, a Chat's latest message, who is in a Canvas,
or who the Sidekick that writes it admits moves (to every socket, each read
for its own viewer). For the last, `HostedSidekick.touchDirectory`, which
every write of a Sidekick's directory row ends with, hands the host the
inputs of the reader rule (scope, lifecycle, executor, `people` list) when the
Sidekick writes any Canvas, and the host marks the list only when they differ
from what it last saw, so a run's own touches push nothing; a Sidekick call
and a Sidekick alarm end with the same publish a Canvas write does, or one person's read of
a Chat or their pins move (to that person's sockets alone). A push that cannot be read or fails its own
schema is not sent and is logged as `workspace_canvas_list_unpublished` with a
code naming the failing field (`sidebarListFrame`, which the Activity list
shares as `workspace_activity_list_unpublished`); only a socket closing as it
is sent is ignored, since a reconnect brings the whole list. It is its own
event type rather than a third `workspace_sidebar_list` member because a
released client fails a discriminator value it does not know and ignores an
event type it does not know; the sidebar key is optional for the same reason.
Both carry the `canvases` waterline (`workspace_sidebar_list_state`), which the
desktop compares in the same ledger as the Sidekick list
(`applyVersionedSidebarList`).

A row (`canvasSidebarRows`) is the summary plus: `unread`, the Chat's read
state as `sidekick_viewer_reads` projects it against the Chat's latest
attention ordinal (a Canvas never opened is unread to anyone but its creator);
`presentUserIds`, the people whose foreground socket has the Canvas open now;
`pinnedPosition`; `sharedWithMe`, set for a participant who did not make it;
`artifactKind`, the newest artifact's kind; `hasLiveArtifact`, whether any listed
artifact has its own database (`artifact_registry.stateful = 1`); and
`lastWrittenBy`, the run
whose publish made the newest version (`sidekickId`, `runId`, its
`runNumber` counted as the run's own row counts it, oldest first, and the
Sidekick's `sidekickName`), null when the newest version is no run's or its
Sidekick was deleted, and absent from an older Worker. Deleting a Sidekick
moves only the Sidekick list's waterline, so a connected client keeps
"<Sidekick> · run #N" on the card until its next Canvas list frame. It is read by joining
`sidekick_runs` on its primary key, so the list pays one probe per Canvas a
run wrote last. The home page's groups are
these fields: Data (`hasLiveArtifact`), from Sidekicks (`writerSidekickId`),
shared with me, made by me. The list holds every Canvas the viewer may open as its creator, a
participant, a member of an Organization-wide one or someone its writer
Sidekick is shared with, most recently active first, at most 250, the bound
the Sidekick list already has; an owner's or administrator's list does not add
every private Canvas they could open.

The Pinned group mechanism, shared with Sidekicks, is
[`pinning.md`](pinning.md)'s. What is particular to a Canvas: it is pinned with
`POST /canvases/:id/pin` and its row carries `pinnedPosition`; a pin must be of
a Canvas the viewer may open (its audience), so a Canvas that narrows out a
viewer drops off their Pinned group; and a guest may pin a Canvas shared with
them but not reorder the group, since the order route is on the member-only
mount, which has to be decided before drag-to-reorder lands in the client.

### Presence

A Canvas id is a conversation-parent id, so `set_presence` already carries it
as `foregroundWorkstreamId`, and `workspace_presence` fans out per
conversation. The presence path admits a Canvas the viewer may open
(`canvasVisible`, which asks `canvasReaderAllows`), so the face pile inside a
Canvas is everyone in it now. A Canvas the viewer may not open yet (one still
being created, or a link from elsewhere) is held as the socket's pending
foreground and promoted when the list that names it arrives, rather than
refused, because refusing would close the Organization socket for good. A
change to who is in any Canvas advances the
`canvases` waterline and republishes the Canvas list, whose rows carry
`presentUserIds`; a push at the same waterline would be dropped by the
desktop, which applies only a newer one. Presence decides from the
socket's access class, not the person's role, so an owner or administrator who
opens a private Canvas they are not otherwise in does not appear in its face
pile.

### In the client

The desktop renderer, which the browser host also mounts, draws a Canvas from
what the server already exposes; nothing in it is a new primitive. Canvases is
the rail's first section and `/canvases` the landing route
([`desktop-shell.md`](desktop-shell.md)). Layout, sizes and copy follow
`docs/PRDs/2026-11-06_canvases-and-sidekicks/design.html` (§1 the home, §2 an
open Canvas, §5 the marks), which is the authority for every measurement; this
section records only what the code decides.

- **The list** is the `canvases` query the workspace socket fills
  (`workspace_canvas_list`, `applyVersionedSidebarList`), read with
  `useSocketOwnedList`; there is no list route. The home page groups and filters
  it client-side from the row's own fields. The filters are All, Data, Made by
  me, Shared with me and From Sidekicks, in that order. Data is `hasLiveArtifact`,
  Made by me `createdByUserId`, Shared with me `sharedWithMe`, From Sidekicks
  `writerSidekickId`. A home card whose
  newest version a run wrote names that run, "<Sidekick> · run #N"
  (`canvasWrittenByRun`), and opens the Sidekick's conversation at it
  (`?run=`); the link carries the run's number in its route state, so the run's
  pill is numbered before the shared conversation has loaded. Viewer presence
  is a facepile at the preview's top left; the independent **Data** badge at
  its top right uses the Stored data pop-out row's `IconDatabase` and means
  the Canvas holds a listed database-backed artifact.
  A static site has no Data badge. `hasLiveArtifact` is absent from an older
  Worker, which the client treats as false. Both indicators can appear together.
- **The mark** (`CanvasMark`) holds the chosen icon, else the row's
  `artifactKind` glyph, in a pastel pair through `markColors`: the chosen
  colour, else a hue stable for the id (`canvasHue`). The home card's preview
  fills its entire background with that tint and centers the glyph vertically
  and horizontally, with no icon repeated in the title row. The ink applies
  only to the glyph so the Data badge keeps the page's text colour. Appearance
  is chosen from the pill's mark or the menu's **Change appearance** with the
  Sidekick's `AppearancePicker`, a popup rather than a
  submenu (a submenu has no room beside a phone-width menu); each click saves
  through `PATCH /canvases/:id`.
- **Making one** is `POST /canvases`, with the "Start from a prompt" card's
  text as `prompt`; the client opens the new Canvas, whose Chat already holds
  the prompt as the creator's message. `useCreateCanvas` holds one attempt
  series and guards the in-flight call, so a double click or a retry after a
  lost answer reaches the server's replay rather than making a second Canvas.
- **An open Canvas** is `ConversationSurface` with `parentKind: "canvas"` and
  substream `"0"`, so the composer, annotations (a Canvas's comments), the
  inspector rail, its resource cards and versions menu, and the
  per-conversation panel restore (`artifact-panel:<canvas id>:0`) are the
  surface's own. With nothing saved, the screen opens the newest artifact of
  `GET /canvases/:id` beside the Chat (`openResourceState`, `expanded: false`);
  a link naming an artifact opens it expanded. The surface does not close a
  requested panel on the device cache's copy of the conversation, which may
  list none of its artifacts. Closing the panel clears what was saved, and the
  menus' **Open artifact** is the way back to it.
- **The header** is a `TitlePillHeader` naming the Canvas (`align="start"`),
  with the face pile of everyone else in it now, Share, and a "⋯" whose menu
  matches the pill's: Pin, Rename…, Change appearance, Share…, Copy link, Copy
  Canvas ID and, while there is an artifact, Open artifact. The pill's title is
  the detail's, and a change to the list row's title is written into the
  detail's cache once the socket has applied the list, so the header follows a
  rename from anywhere without a refetch.
- **A link to no Canvas** (`canvas_not_found`, or a malformed id,
  `canvas_id_invalid:id:<issue>`) draws one in-pane "This Canvas does not
  exist." state with nothing to try again (`isNotFoundError`), and a restored
  route that answers either goes to the Canvases home. A well-formed id that
  answers 404 is asked about once more (`GET /canvases/:id/access`) first. A
  Canvas missing from this window's list mounts its Chat only once the detail
  answers, so a missing one raises no socket failure over that state.
- **A Canvas you cannot open.** When the access read answers `requestable`
  (never the title), the pane offers **Request access**
  (`CanvasAccessRequestPane`), then shows "Request sent" while pending and
  "Request declined" with the button again after a denial
  ([`canvas-access-requests.md`](canvas-access-requests.md)). A restored route
  on such a Canvas stays. The grant reopens the pane into the Canvas without a
  refresh: the detail is refetched when the Canvas joins the person's list or
  their `access_granted` Activity row arrives, and at once on an
  `already_participant` answer or a 409 `canvas_access_open`.
- **No connection.** A conversation socket that cannot open without a reason
  is the PRD's offline state, "This Canvas opens when Rally reconnects.", with
  the Canvas's own header kept over it (`stateHeader`); one the server refused
  names the Canvas and keeps its reason behind Connection details. While the
  Organization socket cannot open, the sidebar (`SidebarListDown`) and a
  section home (`PushedListPending`) say so with one Try again.
- **Naming.** While `titleStatus` is `naming`, the pill, the row and the card
  draw the `TitleSkeleton` placeholder and the window stays "Rally"; the title
  arrives through the list push. The server makes the flip on the first
  person message; the client draws only what `titleStatus` says, and a missing
  `titleStatus` (an older server) is settled.
- **Renaming** is `PATCH /canvases/:id`, edited in the pill
  (`TitlePillTitleInput`) from the pill's menu or a sidebar row's (which opens
  the Canvas with `RENAME_CANVAS_STATE`). The client neither trims nor measures
  the title: the server refuses an empty or over-long one
  (`canvas_rename_invalid:title:<issue>`), and the notice
  (`canvasRenameRefusal`) leaves the field open on what was typed. Leaving the
  field saves only a title that differs from the one last sent.
- **Share** offers the three visibilities and a people picker to someone the
  detail says may manage it (`canManage`), saving with
  `POST /canvases/:id/audience`; anyone else sees the audience read-only. A
  Canvas a Sidekick writes says it is also open to the Sidekick's audience. The
  picker never lists the viewer or the creator, and with the Organization
  visibility lists guests only. Save is the dialog's one primary action: it
  sends the audience, then invites the typed guest addresses through
  `useScopeInvitations` with a `workstream` target naming the Canvas. For a
  decider, a **Requests** section lists `pendingAccessRequests` with
  `AccessDecisionActions`, the component the Activity row uses; an approval
  made while the panel is open joins its choice of people, and the visibility
  the server moved to replaces the panel's, so a following Save does not take
  back the access just given.
- **Pinning** is `POST /canvases/:id/pin`, from the pill's menu, a row's
  context menu, or dragging a row into the section's Pinned group
  (`useRowPinDrop`); a pin lands at the end of the group
  ([`pinning.md`](pinning.md)).

Copying a Canvas's link is **Copy link**, the form
`/app/<region>/<organization>/cv/<canvas>/` ([`links.md`](links.md)); a
detached artifact window's **Copy link** adds the artifact's segment.

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
| An invitation email cannot be sent | The share stays pending and its delivery alarm retries ([`scope-invitations.md`](scope-invitations.md)). |
| A second create for the same Sidekick run under another Canvas id | Answers the run's first Canvas (`created: false`); `canvas_directory_run_idx` is the index that finds it. |
| A create names a `canvasId` that is somebody else's Canvas, or another conversation's id | `canvas_id_unavailable` (409); nothing is written. |
| A publish lands but its note to the Canvas cannot run (the Organization object fails, or holds no such Canvas) | The publish still succeeds and `canvas_artifact_note_failed` is logged with the reason. The artifact is missing from the Canvas until the path is published again or a retried attempt recovers it as `landed`, each of which notes it again; nothing else repairs it. |

## Testing

- `apps/api/test/authorization-policy.test.ts` — `audienceAdmits`,
  `canvasAdmits` and `canvasManages`.
- `apps/api/test-workers/canvas-artifact-notices.test.ts` — on real workerd:
  a version noted to a Canvas tells the pinner who did not make it and not
  its author, its row collapses while unseen and clears on a read of the
  Chat, and the push opens onto the artifact. Proved to fail with the
  author's exclusion removed.
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
- `apps/api/test-workers/canvas-conversation.test.ts` also opens real
  workspace sockets: the list lists a Canvas to whoever may open it and unread
  to a participant who has not opened it; a member's `set_presence` reaches the
  creator's row and face pile, at a waterline newer than the subscribe
  payload's, as the client applies it; a pin moves only its owner's row; a Canvas the
  viewer may not open is neither pinned nor present. The artifact-status case
  proves that a database-backed artifact sets `hasLiveArtifact` on pushed
  rows even when a newer artifact is a file, while static sites, unlisted
  artifacts and another Canvas's database do not.
- `canvas-conversation.test.ts` publishes through the Terminal's resource
  bridge: the first publish is version 1 by Rally, a republish a new version
  of the same artifact, another path another artifact; and a Sidekick run's
  publish makes a Canvas its Sidekick's audience opens, read live, listed on
  the Sidekick's detail, refusing a Canvas the Sidekick does not write; a
  `canvas` argument anywhere but a run is `canvas_argument_unsupported`; a
  publish recovered as `landed` after its attempt died before the note is
  noted; another person's new version marks a viewer's row unread while the
  publisher's own does not.
- `canvas-conversation.test.ts` retitles a Canvas as a participant, seen on
  the creator's open list, and refuses the retitle to someone it does not
  admit as `canvas_not_found`; it orders one viewer's pinned Canvases, keeping
  a pin the request left out after the named ones.
- `canvas-conversation.test.ts` chooses a Canvas's icon and colour as a
  participant and then its colour alone as the creator, read on the detail
  and the creator's open list with the icon kept and `updatedAt` unchanged,
  refused to someone it does not admit as `canvas_not_found`, unchosen
  before; and reads a stored appearance outside the vocabulary as unchosen on
  the detail and the list, repaired by the next choice. Proved to fail with
  the appearance write dropped.
- `canvas-conversation.test.ts` creates a Canvas twice with one `canvasId` and
  gets one Canvas and one prompt, and refuses the id to another person and an
  id another conversation holds.
- `canvas-conversation.test.ts` also runs Rally in a Canvas's Chat against the
  OpenRouter double: the model is given the Canvas's context with its artifact
  and the resource tools.
- `canvas-hosting.test.ts` also claims a share at sign-in for a recipient who
  had no account.
- `apps/api/test/canvas-routes.test.ts` — the routes' validation and the guest
  refusal, an appearance outside the catalog and a body that changes nothing
  refused by field.
- `apps/desktop/src/renderer/lib/sidebar-list-store.test.ts` — the Canvas list
  orders by its own waterline.
- `apps/desktop/src/renderer/screens/canvases-home.test.tsx` — the home page
  from a socket-fed list: database-backed Data and Recent, facepiles
  independent of Data badges, the filters and search, the
  prompt card and New Canvas, no create for a guest, and no empty state before
  the list arrives.
- `apps/desktop/src/renderer/screens/canvas.test.tsx` — the open Canvas: a
  `canvas` conversation under its header; the newest artifact opened when
  nothing is saved, the saved panel left to the surface's restore, the rail
  left closed with no artifact; pinning; Share for a manager and read-only for
  anyone else; Change appearance and the pill's mark opening the palette,
  saving through the route, the pill drawing the answer, and the pill
  following a choice the list push carries.
- `canvases-home.test.tsx`, `canvas-sidebar-section.test.tsx` and
  `components/navigation-sidebar.test.tsx` (the Activity section) — each mark
  in the chosen icon and colour, and an unchosen one in its kind and hue.
- `apps/desktop/src/renderer/components/canvas-sidebar-section.test.tsx` — the
  section's Pinned group and rows, drag to pin, unpin, and the skeleton.
- `apps/api/test/workstream-object-schema.test.ts` — conversation migration 83
  carries a populated v81 root, every column and all nine triggers across the
  rebuild.

## Data model

| Table | Keyed by | Holds |
| --- | --- | --- |
| `canvas_directory` | `canvas_id` | The row: title, creator, times, last editor, writer Sidekick and run, visibility, authority generation, title status (`naming` until a Canvas made with no title is titled from its first message, migration 137), the chosen icon and colour (`appearance_json`, `WorkstreamAppearanceSchema` JSON, null until chosen, migration 137), and the run whose publish made the newest version (`last_writer_run_id`, migration 137). Its CHECK admits a run only beside a `sidekick` last editor, so a future writer that moves `last_editor_kind` without writing this column in the same statement fails its write. Indexed by recency, by writer Sidekick, and uniquely by `(writer_sidekick_id, writer_run_id)`. |
| `canvas_participants` | `(canvas_id, user_id)` | Whom its managers added (`added`), a claimed share brought (`invitation`) or an approved access request let in (`request`, migration 137). Indexed by person for "shared with me". |
| `sidekick_children`, `sidekick_child_projections`, `sidekick_child_receipts`, `sidekick_viewer_reads` | `(sidekick_id, …)`, the column holding the Canvas id | The hosted conversation's children, their projections and receipts, and each reader's read of the Chat. |
| `workspace_sidebar_list_state` | `list` | Gains the `canvases` waterline; the table is rebuilt to widen its CHECK. |
| `sidekick_conversation_attachments` | `(automation_id, parent_kind, …)` | Migration 137 widens `parent_kind` to admit `canvas`. |
| `workspace_pins` | `(user_id, item_kind, item_id)` | Migration 137 admits `canvas` and `sidekick`, with no parent. |
| `canvas_artifacts` | `(canvas_id, resource_id)` | Migration 137: the resources the Canvas's conversation generated, written by the publish that attached each (`noteArtifact`); ordered by the resource's own `updated_at`. Its own table because the Thread-era resource-link table's foreign key named a Thread's directory row, which a Canvas has none of. Indexed by resource. |

## Retired documents

Removed from `docs/`; the last text and changelog are recoverable as
[`architecture.md`](architecture.md#retired-documents) describes. They are
recorded here because a Canvas's title from its opening message carried Thread
naming forward.

**`workstream-naming.md`: Naming a work stream (retired 2026-11-07).** A Thread
was created with a placeholder title and named a moment later by a model pass
over its opening and transcript, with an icon chosen beside the name.
`workstream-naming-service.ts` and the harness's `prompts/workstream-name.ts`
are deleted. What survives: the `workstream_naming` model role, which titles a
Canvas from its opening message ([Making a Canvas](#making-a-canvas)) and titles pasted text
(`pasted-text-service.ts`), and the `title_status` column. Its changelog is the
record of the grace window, the provisional title and the injection boundary.

**`workstream-descriptions.md`: Work-stream descriptions (retired
2026-11-07).** A Thread's description started as the first line of its opening
message and was rewritten by a model pass after each run, behind a rest
window, a novelty threshold and generalization guards. A Canvas carries no
model-written description, so `workstream-description-service.ts` and its
prompt are deleted and the `workstream_description` model role and its
Flagship key retired ([`feature-flags.md`](feature-flags.md)). The
`description_refresh_state` table remains in conversation-object SQLite. Its
changelog is the record of why a proposal is repaired before it is judged and
why the refresh lease shares the owning object's transaction.

## Changelog

### 2026-11-09 — Separate viewer presence from database-backed artifacts

**What changed:** The home card shows current viewers as a top-left facepile.
Its Data badge and Data group use `hasLiveArtifact`, derived from listed
artifacts joined to the existing registry's `stateful` flag in WorkspaceDO.

**Why:** The Data badge needs to identify an artifact with a database even
when nobody is viewing it; presence answers a separate question.

**Considered and rejected:** Inferring Data from the newest artifact's kind:
a static site has no database, and a newer file does not remove an older
database-backed artifact from its Canvas. Fetching each artifact's manifest
would add work to every dashboard opening when the registry already knows.

**Consequences:** Presence and Live status can coexist independently. A row
from an older Worker omits the new field and shows no Data badge.

### 2026-11-09 — Document created: a Canvas is a hosted conversation with its own audience

**What changed:** A Canvas is a conversation first: a `canvas_directory` row in
`WorkspaceDO` keyed by the parent id of its `canvas`-kind conversation, whose
Chat is an ordinary `AgentLoopDO` object on the `HostedConversation` primitive a
Sidekick also uses, and whose artifacts are what that Chat, or a Sidekick run
writing into it, publishes (`canvas_artifacts`). It has a participant list,
creator-only by default, an Organization-wide option, guests invited through the
share primitive re-keyed to the Canvas, and owners and administrators admitted
to every Canvas; `canvasAdmits` and `sidekickAdmits` are both `audienceAdmits`.
Each viewer's list, with unread, presence and pins, rides the workspace socket.
A Canvas made with no title is titled from its first message; anyone it admits
may retitle it and choose its icon and colour, with the Sidekick's own picker
and schema; its row names the Sidekick run that wrote its newest version; a new
version tells its pinners; and a member it does not admit may ask to be let in
([`canvas-access-requests.md`](canvas-access-requests.md)). A Thread that holds
artifacts becomes a Canvas under its own id (`HostedCanvas.createFromThread`).

**Why:** The pivot's decisions: a Canvas is identified by its conversation and
starts empty, so it can generate many artifacts; only its creator and the
Organization's owners and administrators change who can open it, and an
administrator can open every Canvas so a creator who leaves cannot strand one; a
Sidekick's Canvas admits the Sidekick's audience as it stands. The share
primitive was re-keyed rather than copied because it already owns delivery, the
sign-in claim and the guest relationship, and the hosting was generalized from
the Sidekick's so receipts, projections and read state have one implementation.
Retitling and appearance are open to anyone admitted because anyone admitted
already changes the artifacts (the PRD's decision log, open to the owner's
reversal), and titling from the opening message answered the end-to-end pass
finding every Canvas stuck at **Untitled Canvas**. The run on the row is stored
from the publish note because `writer_run_id` names the run that created the
Canvas, and deriving it from versions would cost every list read a join across
every artifact version. A converted Thread keeps its id so that
`artifact_registry`, search and the D1 anchor already name the Canvas.

**Considered and rejected:** Keying a Canvas by an artifact: an empty Canvas has
none. Copying a Sidekick's audience into a new Canvas, which the first build did
while also reading it live, two sources that disagreed as soon as either list
changed. A second host class cloned from `HostedSidekick`, or new `canvas_*`
child tables. The mockup's artifact-first pane with Chat and Comments tabs,
which would have been the pivot's one new client primitive. Naming in the
conversation object, where the deleted Thread naming ran: the title is the
parent's row, written by the statement a retitle uses. Recording pinner news
from the resource-version ledger's drain, which runs outside any entry point and
cannot enqueue a push durably.

**Consequences:** A guest is admitted only from a list. A writer Sidekick's
audience is read live, so any input to the Sidekick's reader rule must reach the
Canvas list; the mark sits in `touchDirectory` (`noteWriterReaders`) so a new
input is covered. Only a Canvas still `naming` may be titled automatically, and
every person's retitle settles it. An unchosen appearance field draws the
default and must never be filled with it on the server, and the icon catalog and
ring are shared with Sidekicks. A Canvas row can name an id that was a Thread's,
with an older creation time, participants with no `added_by_user_id` and no
writer, so nothing may assume a Canvas was made by `create`, and every artifact
a Canvas lists must open through its Chat. The socket's list row is the source
of a Canvas's title; the detail only mirrors it. A new hosted parent kind
extends `HostedConversation` and is dispatched in
`WorkspaceDO.hostedConversationParent`. Listing a Canvas's shares and grants has
no route, and the client offers no pin reorder. [`links.md`](links.md) owns the
link form.

Shipped in juno-ai-labs/avalon#1490. Design:
`docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`.
