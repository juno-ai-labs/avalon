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
| `apps/api/src/durable-objects/workspace-do.ts` | The facade: `canvasCreate`, `canvasDetail`, `canvasRename`, `canvasSetAudience`, `hostedConversationAuthorizationFacts`, every conversation-parent method for a Canvas id, and the Canvas branch of `createScopeInvitations`, `claimScopeInvitations`, `revokeScopeInvitation` and the invitation alarms. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Conversation object migration 83: its root row admits the `canvas` parent kind. |
| `apps/api/src/services/canvas-service.ts` | `createCanvas`: the directory row, then the Chat's object, bootstrapped and provisioned with the creator seated; `CanvasService`, the routes' service. |
| `apps/api/src/routes/canvases.ts` | `POST /canvases`, `GET /canvases/:id`, `PATCH /canvases/:id` (the title), `POST /canvases/:id/audience`, `POST /canvases/:id/pin`. `PUT /workspace/pinned-order` (in `routes/workspace.ts`) orders a Pinned group. |
| `apps/api/src/services/integrations.ts` | `canvasRunContextMessage`: the `CANVAS CONTEXT` message a run in a Canvas's Chat is given. |
| `apps/api/src/services/terminal/authority.ts` | `resolveTerminalPublicationHome` (a Sidekick run publishes into a Canvas) and `canvasArtifactNoter` (a publish tells its Canvas). |
| `apps/api/src/services/conversation-service.ts`, `socket-service.ts` | Opening a Canvas's Chat: admission by the Canvas, the reader seated, and a ticket whose `pk` is `canvas`. |
| `apps/api/src/services/authorization-service.ts` | A Canvas conversation's and its artifacts' canonical read decision, from `hostedConversationAuthorizationFacts`. |
| `apps/desktop/src/renderer/screens/canvases-home.tsx` | `/canvases`: the home page — New Canvas, search, the filter chips, Live now and Recent, and the first-run "Start from a prompt" card. |
| `apps/desktop/src/renderer/screens/canvas.tsx` | `/canvases/:id`: the Chat as a `canvas` conversation in `ConversationSurface`, its header (pill, people present, Share, menu), and opening the newest artifact in the right rail. |
| `apps/desktop/src/renderer/components/canvas-share-dialog.tsx` | Share: who can open it, for a manager; the same audience read-only for anyone else; guests invited by email on Save. |
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
(`canvas_create_member_required`). The client mints the Canvas id and sends it
as `canvasId`, so a retried create answers the Canvas the first made
(`HostedCanvas.create` replays `created: false`) and the prompt's
`clientMessageId` sends the first message once there. The replay is its
creator's alone: somebody else naming the id, or an id another conversation
already anchors in D1's `workstreams`, is refused with `canvas_id_unavailable`. `GET /canvases/:id` is the detail (row,
participants, artifacts at their current versions, whether the reader may
manage it); `POST /canvases/:id/audience` changes who can open it;
`POST /canvases/:id/pin` and `POST /sidekicks/:id/pin` pin. The Chat is opened
through the conversation routes like any conversation.

A Canvas a person makes with no title starts as **Untitled Canvas**, settled
(`canvas_directory.title_status`, migration 149). When the first projection of
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
characters as `canvas_rename_invalid:title:<issue>`, and every Canvas route
refuses a malformed id as `canvas_id_invalid:id:<issue>`, through
`namedZValidator`, each with a sentence the client shows; a well-formed id
that names no Canvas is `canvas_not_found`.

### A Canvas that was a Thread

A Canvas may have been a Thread. `convert_threads_to_canvases`, an operator
operation run once per Organization after the pivot, makes every Thread that
made or linked an artifact a Canvas with the same id
([`workspace-retirement.md`](workspace-retirement.md#converting-threads-that-have-artifacts)
owns it). What it keeps: the id, so `artifact_registry`, search, the D1 anchor
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
renamed to the Canvas's source; and a Sidekick's attachment to its Main. What
it does not keep: its Breakouts, retired as `retire_threads` retires them, and
its unread state, which starts empty. Such a Canvas has no writer Sidekick and
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
Rally for the Chat, the Sidekick for a run. The resource versioning layer
records every version with its run, as it does everywhere; `canvas_artifacts`
records only which resources the Canvas holds. A version somebody else made
since a viewer last read the Chat makes the Canvas's row unread to them, by
the rule a pinned artifact's news uses (a republish or replacement, not their
own or one made on their behalf).

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
Canvas's row, its participants, a Chat's latest message or who is in a Canvas
moves (to every socket, each read for its own viewer), or one person's read of
a Chat or their pins move (to that person's sockets alone). It is its own
event type rather than a third `workspace_sidebar_list` member because a
released client fails a discriminator value it does not know and ignores an
event type it does not know; the sidebar key is optional for the same reason.
Both carry the `canvases` waterline (`workspace_sidebar_list_state`), which the
desktop compares in the same ledger as the Sidekick list
(`applyVersionedSidebarList`).

`WorkspaceDO.canvasListFor` (`CanvasService.list`) answers the same rows with
nobody present, for a caller with no workspace socket, such as the demo
readiness barrier. A row (`canvasSidebarRows`) is the summary plus: `unread`, the Chat's read
state as `sidekick_viewer_reads` projects it against the Chat's latest
attention ordinal (a Canvas never opened is unread to anyone but its creator);
`presentUserIds`, the people whose foreground socket has the Canvas open now;
`pinnedPosition`; `sharedWithMe`, set for a participant who did not make it;
and `artifactKind`, the newest artifact's kind. The home page's groups are
these fields: live now, from Sidekicks (`writerSidekickId`), shared with me,
made by me. The list holds every Canvas the viewer may open as its creator, a
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
([`desktop-shell.md`](desktop-shell.md)).

- **The list** is the `canvases` query the workspace socket fills
  (`workspace_canvas_list`, `applyVersionedSidebarList`), read with
  `useSocketOwnedList`; there is no list route. The home page and the sidebar
  section group it client-side from the row's fields: Live now is a row with
  someone other than the viewer in `presentUserIds`, Made by me is
  `createdByUserId`, Shared with me `sharedWithMe`, From Sidekicks
  `writerSidekickId`. A row's second line names who is there now, else its
  last editor, else who made it.
- **The mark** (`CanvasMark`) is a sheet holding the row's `artifactKind`
  glyph, in a pastel pair through `markColors`, the mechanism a Sidekick's
  hexagon uses. The hue is the Canvas's own, stable for its id
  (`canvasHue`, as a person's accent is chosen), since design.html §1, §2 and
  §5 colour each Canvas individually and a Canvas stores no colour.
- **The home page** is design.html §1's grid of cards, three to a row once the
  pane is the design's 1024px main pane, two below it, one at phone width: each
  card is a 150px shot of the Canvas, a "Live" chip with the faces of the
  people in it now, its title, and who and when. A row carries no picture of
  its artifact, so the shot is a sketch of its `artifactKind` (a file as a
  document's lines, a site as a page in a frame, an archive as a board's
  columns, a Canvas that is only its Chat as its mark on the paper). At phone
  width the sheet's bar is the page's header, so the page draws no second
  title or New Canvas. The sidebar's "All canvases" heading carries a
  Recent/Name sort (the server's recent-activity order, or by title), which is
  not remembered across launches.
- **Making one** is `POST /canvases`, with the "Start from a prompt" card's
  text as `prompt`; the client then opens the new Canvas, whose Chat already
  holds the prompt as the creator's message.
- **An open Canvas** is `ConversationSurface` with `parentKind: "canvas"` and
  substream `"0"`, so the composer, annotations (a Canvas's comments), the
  inspector rail, its resource cards and versions menu, and the
  per-conversation panel restore (`artifact-panel:<canvas id>:0` in
  `lib/desktop-layout.ts`) are the conversation surface's own. With nothing
  saved there, the screen opens the newest artifact of `GET /canvases/:id`
  beside the Chat, through `openResourceState` (`lib/navigation-routes.ts`)
  with `expanded: false`; a link naming an artifact opens it expanded, as a
  pinned artifact's row does. The surface does not close a requested panel
  on the device cache's copy of the conversation, which may list none of its
  artifacts. An artifact whose content was never stored
  (`contentAvailable: false`, or a read answering
  `resource_content_unavailable`) says "Nothing to show yet" in the panel.
  With no artifact, the rail stays closed on the conversation's empty
  state. Closing the panel clears what was saved,
  so the next opening shows the newest artifact again.
- **The header** is a `TitlePillHeader` naming the Canvas, drawn `align="start"`
  as design.html §2 lays it out: the pill right after Back and Forward, then at
  the pane's right edge the face pile of everyone else in it now
  (`workspace_presence`, through the surface's `presentUserIds`), Share, and a
  "⋯" button (`TitlePillMenuAction`). The "⋯" and the pill's menu offer the
  same Pin, Rename…, Share…, Copy link and Copy Canvas ID (for support, and
  kept in the offline and refused states, whose header this is), and, while
  the Canvas has an artifact, **Open artifact**, which opens the panel on the
  newest one beside the Chat, the way back to a panel the person closed; it
  replaces the entry as arrival, Rename… and Share… do, so Back leaves the
  Canvas. A phone keeps only the pill's menu. The pill's title is the detail's, and a change to the list row's
  title (the `workspace_canvas_list` push a rename from anywhere produces) is
  written into the detail's cache entry once the socket has applied the list,
  so the header follows a rename without a refetch. The window is named `<title> · Rally` while it is open
  (`useDocumentTitle`, `lib/document-title.ts`).
- **A link to no Canvas** — a well-formed id that names nothing
  (`canvas_not_found`, 404) or a malformed one (`canvas_id_invalid:id:<issue>`,
  400) — draws the same "This Canvas does not exist." state, the pane's one
  state (`PaneState`) with the shell's Back and Forward above it where the
  host draws them (the desktop app; a browser tab has its own), no dialog over
  it and nothing to try again
  (`isNotFoundError` in `lib/landing.ts`), and a restored route that answers
  either goes to the Canvases home. A Canvas missing from this window's list
  mounts its Chat only once the detail answers, so a link to one that does not
  exist raises no conversation socket failure over that state; one in the list
  opens at once, beside the detail read.
- **No connection.** A conversation socket that cannot open without the
  server saying why is the PRD's offline state, "Live edits resume when Rally
  reconnects.", never "This Canvas is unavailable"; one the server refused
  names the Canvas and keeps its reason behind Connection details. Either
  keeps the Canvas's own header over it (`stateHeader`), its pill, Share and
  "⋯", since the list row already names it. While the Organization socket
  cannot open, the sidebar says so in place of its placeholder rows
  (`SidebarListDown`) and a section home in place of its list
  (`PushedListPending`): every one of these says "Rally can’t reach the server
  right now." (`OFFLINE_TITLE`) and offers the same outlined Try again
  (`OfflineRetry`).
- **Naming.** While a row or the detail says `titleStatus: 'naming'` (a
  Canvas made with no title, waiting for the title its opening message gives
  it), the pill, the sidebar row and the home card draw the `TitleSkeleton`
  placeholder ("Rally is choosing a name" to a screen reader) and the window
  stays "Rally"; the title then arrives through the list push the pill
  already follows. A Canvas made empty is `settled` as "Untitled Canvas" and
  turns `naming` when its first person message lands, so the placeholder
  never waits on a message nobody has sent (v1-F5, v4-F11); the server makes
  that flip, and the client draws only what `titleStatus` says. A missing `titleStatus` (an older server) is settled.
- **Renaming** is `PATCH /canvases/:id`, edited in the pill itself
  (`TitlePillTitleInput`): Rename… in the pill's menu, or in a sidebar row's
  context menu (which offers the pill's Pin, Rename…, Share… and Copy link;
  Share… opens the Canvas on its panel with `SHARE_CANVAS_STATE`), which opens the Canvas with route state
  (`RENAME_CANVAS_STATE`) that starts the edit. Enter saves, Escape cancels,
  leaving the field saves a changed title. The client neither trims nor
  measures the title: an empty or over-long one is the server's to refuse
  (`canvas_rename_invalid:title:<issue>`), and the refusal is a notice titled
  "The Canvas could not be renamed" (`canvasRenameRefusal`: words for
  `too_small` and `too_big`, the server's message otherwise), with the field
  left open on what was typed.
- **Share** offers the three visibilities and a people picker to someone the
  detail says may manage it (`canManage`), and saves with
  `POST /canvases/:id/audience`; anyone else sees the same audience read-only.
  The picker never lists the viewer or the creator, and with "Everyone in the
  Organization" it lists guests only, since members are in already; only the
  chosen guests are sent with that visibility, and its people search shows
  only once there is a guest to find or the guest section is open. Its radios
  and checkboxes are the shared `.choice-control`, the guest invite a
  disclosure with the title menus' chevron, and Cancel and Save sit at the
  dialog's foot, below it. Save is the dialog's one primary action: the
  addresses typed in the guest section are part of the form, and Save sends
  the audience and then invites them through the conversation share's
  `useScopeInvitations` with a `workstream` target naming the Canvas, without
  its waiting-shares list, which has no server route. Only addresses typed
  while the guest section is open are sent. Addresses that do not parse save
  nothing: the app's error notice says why, over the dialog, which keeps what
  was typed.
- **Pinning** is `POST /canvases/:id/pin`, from the pill's menu, a row's
  context menu, or dragging a row into the section's Pinned group
  (`useRowPinDrop`). A pin lands at the end of the group: the order is
  `reorderSidebarPins` in `WorkspaceDO`, which no route exposes yet.

Copying a Canvas's link is the pill menu's **Copy link**, the Canvas form
`/app/<region>/<organization>/cv/<canvas>/` ([`links.md`](links.md)); a
detached artifact window's **Copy link** adds the artifact's segment, and a
link with one opens the Canvas with that artifact in the rail.

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
  viewer may not open is neither pinned nor present.
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
- `canvas-conversation.test.ts` creates a Canvas twice with one `canvasId` and
  gets one Canvas and one prompt, and refuses the id to another person and an
  id another conversation holds.
- `canvas-conversation.test.ts` also runs Rally in a Canvas's Chat against the
  OpenRouter double: the model is given the Canvas's context with its artifact
  and the resource tools.
- `canvas-hosting.test.ts` also claims a share at sign-in for a recipient who
  had no account.
- `apps/api/test/canvas-routes.test.ts` — the routes' validation and the guest
  refusal.
- `apps/desktop/src/renderer/lib/sidebar-list-store.test.ts` — the Canvas list
  orders by its own waterline.
- `apps/desktop/src/renderer/screens/canvases-home.test.tsx` — the home page
  from a socket-fed list: Live now and Recent, the filters and search, the
  prompt card and New Canvas, no create for a guest, and no empty state before
  the list arrives.
- `apps/desktop/src/renderer/screens/canvas.test.tsx` — the open Canvas: a
  `canvas` conversation under its header; the newest artifact opened when
  nothing is saved, the saved panel left to the surface's restore, the rail
  left closed with no artifact; pinning; Share for a manager and read-only for
  anyone else.
- `apps/desktop/src/renderer/components/canvas-sidebar-section.test.tsx` — the
  section's Pinned group and rows, drag to pin, unpin, and the skeleton.
- `apps/api/test/workstream-object-schema.test.ts` — conversation migration 83
  carries a populated v82 root, every column and all nine triggers across the
  rebuild.

## Data model

| Table | Keyed by | Holds |
| --- | --- | --- |
| `canvas_directory` | `canvas_id` | The row: title, creator, times, last editor, writer Sidekick and run, visibility, authority generation, title status (`naming` until a Canvas made with no title is titled from its first message, migration 149). Indexed by recency, by writer Sidekick, and uniquely by `(writer_sidekick_id, writer_run_id)`. |
| `canvas_participants` | `(canvas_id, user_id)` | Whom its managers added (`added`) or a claimed share brought (`invitation`). Indexed by person for "shared with me". |
| `sidekick_children`, `sidekick_child_projections`, `sidekick_child_receipts`, `sidekick_viewer_reads` | `(sidekick_id, …)`, the column holding the Canvas id | The hosted conversation's children, their projections and receipts, and each reader's read of the Chat. |
| `workspace_sidebar_list_state` | `list` | Gains the `canvases` waterline; the table is rebuilt to widen its CHECK. |
| `sidekick_conversation_attachments` | `(automation_id, parent_kind, …)` | Migration 140 widens `parent_kind` to admit `canvas`. |
| `workspace_pins` | `(user_id, item_kind, item_id)` | Migration 141 admits `canvas` and `sidekick`, with no parent. |
| `canvas_artifacts` | `(canvas_id, resource_id)` | Migration 142: the resources the Canvas's conversation generated, written by the publish that attached each (`noteArtifact`); ordered by the resource's own `updated_at`. Its own table because the Thread-era resource-link table's foreign key named a Thread's directory row, which a Canvas has none of. Indexed by resource. |

## Changelog

### 2026-11-08 — The Canvas screens follow design.html

**What changed:** A Canvas's mark is tinted, in a hue stable for its id. The
home page draws the design's card grid, each card's shot sketching what the
Canvas holds, with a Live chip; its copy is the design's, and the sidebar's
list is "All canvases" with a sort. The header puts the pill at the left with
a separate "⋯" button. The Share panel draws its controls from the tokens and
offers only guests to pick when the whole Organization can open the Canvas.
A missing Canvas and an unreachable one are each one in-pane state. A row
reads its age as "2m", "1h", "Tue", a Canvas just made slides into the list,
and its menu matches the pill's. After the second inspection, both header
menus offer **Open artifact** (v1-R2-4), and the Share panel's guest invite
is sent by its Save. Offline, the Canvas keeps its header, and the pane, the
sidebar and a section home say one sentence (v1-R2-8, v4-R2-9).

**Why:** The PRD makes design.html the authority for every screen. The mark
was a grey tile on purpose ("a Canvas has no hue of its own, as a pinned
artifact's tile has none"), carried over from the pinned-artifact tile; the
design draws every Canvas sheet in its own pastel pair and switches it to the
dark pair in dark, and a column of identical grey squares could not be
scanned (v1-F2, v4-F3, v3-G4). The home page was a two-column list of icon
rows where the design draws cards with a thumbnail and a Live chip (v1-F3,
v4-F2), and the header centred the pill, hung its menu off the chevron only,
and moved Share when the artifact panel opened (v1-F8). The Share panel drew
the browser's blue radios and a raw disclosure marker, set its actions above
the guest invite, and listed members, the viewer among them, to pick when
every member was already in (v1-F18, v1-F19, v4-F14, v3-G9). A missing
Canvas raised a dialog over a pane that said something else and offered Try
again for what does not exist, and a blocked connection blamed the Canvas
under endless placeholders (v1-F20, v4-F12, v4-F12b). Closing the artifact
panel left nothing in the Canvas to reopen it, while design §2 always shows the
artifact beside a Canvas that has one (v1-R2-4). The guest invite kept its own
Share button above the dialog's Save, two primary actions in one panel, and
Everyone mode showed a people search over nothing (v1-F18, v4-R2-10, v1-R2-7).
Offline, the pane dropped the Canvas's pill and Share for a bare Back and
Forward and an uncircled "⋯", and one outage read three ways with two button
styles (v1-R2-8, v4-R2-9).

Two choices the design does not settle, made in review and open to the
owner's reversal: the hue is per Canvas from its id rather than per kind,
because the design colours Canvases individually and the hue then needs no
storage; and the shot is a sketch per `artifactKind` with no contract change.
A sketch per MIME type (an `artifactMime` on the row) is a follow-up for the
owner.

**What a future change must respect:** a mark's colours come from
`markColors`, so both appearances stay themed by `themes.css`; a stored
Canvas colour would replace `canvasHue`, not sit beside it.

### 2026-11-08 — A Canvas made with no title is titled from its first message, and a refused retitle names its field

**What changed:** WorkspaceDO migration 149 adds `canvas_directory.title_status`.
A Canvas a person makes with no title is **Untitled Canvas**, settled, until
the first message of its Chat reaches the parent, which sets it `naming` in
the same write and arms a `canvas_naming` entry;
`HostedCanvas.nameFromOpening` titles it on the `workstream_naming` role and
settles it. A retitle settles the row. `PATCH /canvases/:id` and every Canvas
route's id refuse by name (`canvas_rename_invalid:…`, `canvas_id_invalid:…`)
through `namedZValidator`. `CanvasSummary` carries `titleStatus`.

**Why:** The end-to-end pass found every Canvas started from the composer
stayed **Untitled Canvas**, and a refused retitle answered `invalid_request`
"The request is invalid", naming nothing. Titling from the opening message is
the implementer's reading, recorded in the PRD's decision log (2026-11-08) and
open to the product owner's reversal.

**Considered and rejected:** Naming in the conversation object, where the
deleted Thread naming service ran: the title is the parent's row, and a pass in
the parent writes it in the same statement a retitle uses. A lock or a version
check against a concurrent retitle: the retitle settles the row, and the pass
writes only while it is still `naming`, so a person's title wins without one.

A Canvas created `naming` showed the naming skeleton for ever when nobody wrote
in it, since only a message arms the pass, so the flip moved from creation to
the first message; the same change stopped an empty Chat's provisioning
projection from counting as activity.

**What a future change must respect:** only a Canvas still `naming` may be
titled automatically, and every person's retitle must settle it.

### 2026-11-08 — A Canvas is renamed in its own pill, and the pill follows a rename from anywhere

**What changed:** The pill's menu and a sidebar row's menu offer Rename…,
which edits the title in the pill and saves with `PATCH /canvases/:id`. A
change to the list row's title is written into the open Canvas's detail
cache, and the window takes the Canvas's name.

**Why:** The route shipped with the pivot (PRD decision log, 2026-11-07:
anyone the Canvas admits may retitle it) but nothing in the renderer called
it, and the end-to-end pass found every Canvas stuck at "Untitled Canvas".
The same pass found the header keeping the old title after a rename made
elsewhere until a reload: the sidebar and the home read the pushed list,
the header read the detail, and the detail is not pushed. Writing the row's
title through was preferred to invalidating the detail on every push, which
costs a fetch per rename for every window that has the Canvas open.

**What a future change must respect:** the row the socket applied is the
pushed source of a Canvas's title; the detail only mirrors it. Only a change
of the row's title is written through, and only once the socket has applied
the list (`sidebarListApplied`): the device cache seeds the same list
asynchronously, without the waterline ledger, and its row may be older than
a detail the server just answered. A Canvas Rally is still naming draws the
skeleton a Thread being named drew, rather than "Untitled Canvas". The client
does not validate
a title; the server's refusal is what the person reads. The newest artifact
a Canvas opens on arrival opens beside its Chat: it opened expanded, through
the same request a deliberate artifact link makes, and on a first visit the
device cache's empty copy of the conversation closed it again, so the tester
met no panel, then a maximized one after a reload. A malformed Canvas id
in a link reads as a missing one: it names nothing that could exist, and
"The request is invalid" told the person less than the not-found state does.

### 2026-11-08 — A Thread that has artifacts can become a Canvas in place

**What changed:** `HostedCanvas.createFromThread`, beside `create` and sharing
its row insert, writes a Canvas's directory, participant and artifact rows from
a Thread's, for the operator conversion `convert_threads_to_canvases`. The
Canvas keeps the Thread's id.

**Why:** The user decided on 2026-11-08 that Threads with artifacts become
Canvases rather than being deleted. Keeping the id is what makes it cheap:
every row keyed by it (`artifact_registry`, search, the D1 anchor) already
names the Canvas, where a new Canvas with copied content would need each of
them rewritten.

**What a future change must respect:** a Canvas row can name an id that was a
Thread's, with a creation time older than Canvases, participants with no
`added_by_user_id`, and no writer. Nothing may assume a Canvas was made by
`create`.

### 2026-11-07 — Document created: a Canvas is a hosted conversation with its own audience

**What changed:** A Canvas has a directory row in `WorkspaceDO` (migration 139),
keyed by the parent id of its `canvas`-kind conversation, with a participant
list, a creator-only default, an Organization-wide option, guests invited
through the share primitive keyed by the Canvas id, and administrators
admitted to every Canvas. Its Chat is an ordinary conversation object on the
one hosting primitive a Sidekick also uses, `HostedConversation`, and its
artifacts are admitted to whoever opens it. `audienceAdmits` is the one rule
under both `canvasAdmits` and `sidekickAdmits`. Each viewer's Canvas list,
with unread, presence and pins, rides the workspace socket. A Canvas is made
with `POST /canvases`; its Chat's publishes are its artifacts (recorded in
`canvas_artifacts`, migration 142), and a Sidekick run publishes into a Canvas
it makes or one it writes. Rally in the Chat is told the Canvas's artifacts,
and what it learns is the Canvas's memory.

`PATCH /canvases/:id` retitles a Canvas for anyone it admits, and
`PUT /workspace/pinned-order` takes `{ kind, itemIds }` and orders the
Canvases or Sidekicks Pinned group (`reorderSidebarPins`); the Space-era
container order and the All Pinned order it replaced went with the Channel
routes. A Canvas is linked as `/app/<region>/<organization>/cv/<canvas>/`, and
a notification, email or Slack message about its Chat links to the Canvas.
`canvasSetAudience` re-checks presence inside its write, so someone the Canvas
no longer admits leaves its face pile, and a new artifact version is announced
to a Canvas's readers from `canvas_artifacts`.

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

Retitling is open to anyone the Canvas admits rather than only to its managers
because anyone it admits already changes its artifacts from its Chat; the
title is no more protected than what it names (recorded in the PRD's decision
log as open to the product owner's reversal). The order route kept its path,
which the browser's `workspace` route family already forwards. A Canvas
borrowed the Thread link forms until plan step B-5, and those went with
Threads. After the Thread server code was deleted, presence was re-checked
only on socket changes and revocations, so a person removed from a Canvas
stayed listed in it, and the resource-link table the version announcement read
was written only by the retired Thread projection, so a Canvas artifact's new
version reached nobody; the restored runtime suites showed both.

**Considered and rejected:** Keying a Canvas by an artifact: an empty Canvas
has no artifact, and a version with no maker has no provenance. Copying a
Sidekick's audience into a new Canvas: the first build did, and also read it
live, two sources of truth that disagreed as soon as either list changed. A
second host class cloned from `HostedSidekick`: two copies of the receipt and
projection logic. New `canvas_*` child tables: the hosted-conversation tables
are keyed by parent id already, and nothing that scans them across parents
reads them without joining its own directory. The mockup's artifact-first pane
with Chat and Comments tabs: it would have been the one new client primitive
of the pivot (decision log, "An open Canvas reuses the conversation layout").

**Consequences:** A guest is admitted only from a list; the participant list,
not the grant, is the authority for whom managers added; a writer Sidekick's
audience is read live. A new hosted parent kind extends `HostedConversation`
and is dispatched in `WorkspaceDO.hostedConversationParent`. Listing a Canvas's
shares and grants has no route. The client (plan step A-12) draws a Canvas
with the conversation layout: the Chat in `ConversationSurface` and the
artifacts in the existing right rail, with its per-conversation restore; its
home page and sidebar section group the socket's list on the client from the
row's own fields, so no list route was added. Both sidebar sections pass
`reorderable={false}`, so a pin lands at the end of its group. Restoring
someone to a Canvas's audience does not put them back in its face pile until
their window says so.
[`links.md`](links.md) owns the link form; a Canvas's id being its
conversation's parent id is what lets a server mint the link from a
conversation alone.

Design: `docs/PRDs/2026-11-06_canvases-and-sidekicks/prd.md`.
