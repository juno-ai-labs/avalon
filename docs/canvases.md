# Canvases

A **Canvas** is the shared home for work in Rally: a conversation with Rally
that everyone in the Canvas can read and take part in, and the artifacts that
conversation generates — documents, spreadsheets, images, PDFs, archives and
reactive sites. A Canvas is a conversation first. Its id is the parent id of its
`canvas`-kind conversation, so one Canvas can generate many artifacts, and a
new Canvas has none until its Chat publishes one.

This document owns a Canvas's identity, who can open it, its directory row,
its participants and guests, and how its artifacts hang off its conversation.
The conversation engine is [`workstream-durable-object.md`](workstream-durable-object.md)'s;
the hosting inside `WorkspaceDO` is [`hosted-conversation-parents.md`](hosted-conversation-parents.md)'s;
what a published artifact becomes is [`reactive-web-artifacts.md`](reactive-web-artifacts.md)'s.
The product decisions are in the [Canvases and Sidekicks PRD](PRDs/2026-11-06_canvases-and-sidekicks/prd.md#decision-log).

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/canvases.ts` | The wire shapes: `CanvasIdSchema` (the `WorkstreamId` brand), `CanvasVisibilitySchema`, `CanvasAudienceUpdateSchema`, the summary and detail. |
| `packages/contracts/src/conversation-parent.ts` | `ConversationParentKindSchema` gains `canvas`. |
| `apps/api/src/services/authorization-policy.ts` | `audienceAdmits`, the one audience rule, which `canvasAdmits` and `sidekickAdmits` apply over their own facts; `canvasManages`. |
| `apps/api/src/durable-objects/canvas-schema.ts` | `WorkspaceDO` migration 137, the Canvas schema (`canvas_directory`, `canvas_participants`, `canvas_artifacts`, the `canvases` list waterline, and the copies that admit a Canvas among a Sidekick's conversation attachments, the pins and the retirement graph). |
| `apps/api/src/durable-objects/hosted-conversation.ts` | `HostedConversation`: the conversation-parent contract one hosted conversation answers — authority, the viewer check, children, the children's effects, and each reader's read of `"0"`. A Canvas and a Sidekick both extend it. |
| `apps/api/src/durable-objects/canvas-sharing-defaults.ts` | `WorkspaceDO` migration 149: the Organization's one `canvas_sharing_defaults` row, the audiences a new Canvas starts with, read by `HostedCanvas.create`. Served at `GET`/`PUT /workspace/canvas-sharing-defaults` (only an administrator saves) and shown under Settings → Organization preferences (`components/canvas-sharing-defaults-setting.tsx`). |
| `apps/api/src/durable-objects/hosted-canvas.ts` | `HostedCanvas`: one Canvas's parent state inside `WorkspaceDO`, scoped to a `canvas_id` — creation, the read rule over a row (`canvasReaderAllows`), the audience, guest shares and authorization facts. |
| `apps/api/src/durable-objects/workspace-do.ts` | The facade: `canvasCreate`, `canvasDetail`, `canvasUpdate` (the title and the appearance), `canvasSetAudience`, `hostedConversationAuthorizationFacts`, every conversation-parent method for a Canvas id, and the Canvas branch of `createScopeInvitations`, `claimScopeInvitations`, `revokeScopeInvitation` and the invitation alarms. |
| `apps/api/src/durable-objects/workstream-object-schema.ts` | Conversation object migration 83: its root row admits the `canvas` parent kind. |
| `apps/api/src/services/canvas-service.ts` | `createCanvas`: the directory row, then the Chat's object, bootstrapped and provisioned with the creator seated; `CanvasService`, the routes' service. |
| `apps/api/src/routes/canvases.ts` | `GET /canvases` (the reader's list, as their sidebar socket sends it, for a client with no socket such as the [MCP server](rally-mcp.md)), `POST /canvases`, `GET /canvases/:id`, `PATCH /canvases/:id` (the title and the appearance), `POST /canvases/:id/audience`, `POST /canvases/:id/pin`, `POST /canvases/:id/archive`, `POST /canvases/:id/discard` (delete one its creator left blank), `PUT /canvases/:id/notifications` (the viewer's channels for this Canvas's notices, `[]` to mute, `null` to follow Settings) and `POST /canvases/:id/join` (a member joins an Organization-wide Canvas to get its notices; [`push-notifications.md`](push-notifications.md#canvas-notices)), `POST /canvases/:id/artifacts` (a person publishing a file or static site made elsewhere; [`rally-mcp.md`](rally-mcp.md#publishing)). `PUT /canvases/pinned-order` orders personal Canvas pins for members and guests. |
| `apps/api/src/services/integrations.ts` | `canvasRunContextMessage`: the `CANVAS CONTEXT` message a run in a Canvas's Chat is given. |
| `apps/api/src/services/terminal/authority.ts` | `resolveTerminalPublicationHome` (a Sidekick run publishes into a Canvas) and `canvasArtifactNoter` (a publish tells its Canvas). |
| `apps/api/src/services/conversation-service.ts`, `socket-service.ts` | Opening a Canvas's Chat: admission by the Canvas, the reader seated, and a ticket whose `pk` is `canvas`. |
| `apps/api/src/services/authorization-service.ts` | A Canvas conversation's and its artifacts' canonical read decision, from `hostedConversationAuthorizationFacts`. |
| `apps/desktop/src/renderer/screens/canvases-home.tsx` | `/canvases`: the home page — New Canvas, search, the Reactive, Data and authorship filters, the Recent list, and the first-run "Start from a prompt" card. |
| `apps/desktop/src/renderer/screens/canvas.tsx` | `/canvases/:id`: the Chat as a `canvas` conversation in `ConversationSurface`, its header (pill, people present, Share, menu), and opening the newest artifact in the right rail. |
| `apps/desktop/src/renderer/components/canvas-share-dialog.tsx` | Share: who can open it, for a manager; the same audience read-only for anyone else; guests invited by email on Save. |
| `apps/desktop/src/renderer/components/canvas-mark.tsx` | `CanvasMark` and `canvasMark`: the chosen icon and colour, else the unchosen glyph (`PanelsTopLeft`) and `canvasHue`, field by field. |
| `apps/desktop/src/renderer/components/canvas-sidebar-section.tsx` | The Canvases sidebar section: a Pinned group and every Canvas by recent activity. |
| `apps/desktop/src/renderer/components/canvas-creation-notices.tsx` | Shell-owned failure notices and navigation back to a pending Canvas's recovery controls. |
| `apps/desktop/src/renderer/lib/canvases.ts` | The list as the socket keeps it (`useCanvasList`), routes and Canvas creation. |

## How it works

### Running helpers above the composer

`canvas-agent-activity.ts` derives `runningActivity` from the existing
version-fenced `sidekick_child_projections`. The Canvas detail and sidebar row
carry counts of background agents rooted in its Chat and distinct attached
Sidekicks doing work. Both the wizard (including unpublished drafts) and
activation runs count, along with their background workers. Overlapping wizard
and run activity still counts as one Sidekick, and it stays counted until neither
is working. Idle, completed, failed, cancelled, archived and input-waiting
conversations do not count. A live lifecycle alone is not execution.

Child execution transitions advance the Canvas list waterline through a separate
execution hook, without changing the Sidekick library. WorkspaceDO migration
145 adds a partial index containing only live child projections; completed history
is retained but not scanned for counts. Each publish shares computed counts across
viewers of the same Canvas, within that synchronous publish only.

The workspace socket sends viewer-authorized rows. An open Canvas outside the
sidebar page refreshes its detail on list changes, cancelling older reads first;
inactive and failed detail queries are left alone. Its last counts remain visible
during a background refresh. A reconnect clears them until a new read completes.
Desktop and web share the rolling-number animation, shimmer and reduced-motion
fallback. A continuously mounted, visually hidden status region announces the
current label; animated outgoing digits are hidden from assistive technology.
Zero or unknown counts occupy no layout space, and the current connection must
have delivered its sidebar before counts are shown.

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
Canvas's row and audience. The Canvas takes the date of the latest saved
Chat message from `lastMessageAt` in the common projection. This includes
human and Sidekick posts and saved Rally text, including a reply before a
tool call. The unread cursor is projected separately.

The Chat is an `AgentLoopDO` like every other conversation; its root row says
`parent_kind = 'canvas'` (conversation migration 83 widened the CHECK). Opening
it is the conversation route's ordinary admission: `resolveHostedParent`
answers `canvas` and the Canvas's viewer decision in one call, the admitted
reader is seated in the conversation (`admitParticipant`, which a hosted
parent's conversation accepts), and the socket ticket's `pk` is `canvas`.
Canvas admission publishes viewer read state. It leaves the common Chat
projection and the Canvas's `updated_at` alone, even if the converted
directory has an earlier date than the Chat. The Chat's effects reach
`HostedCanvas.receiveChildEffects`
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

A new Canvas, whether a person or a Sidekick run makes it, starts with the
Organization's **Default Editor Audience**: `workspace` (Everyone in the
Organization) unless an administrator chose `creator` under Settings →
Organization preferences. A run's Canvas also admits its writer Sidekick's
audience. Its artifact audience starts at the editors, which
`canvasArtifactVisibilityFloor` raises to `workspace` for an Organization-wide
Canvas, and stays unchosen, so a publishing agent's `set_artifact_audience`
default (public for a site) still applies
([Canvas artifact access](canvas-artifact-access.md)).

The defaults live in `canvas_sharing_defaults`, one row in the Organization's
own object, so `create` reads them in its transaction with no extra round trip.
A column left null was never chosen and reads as
`DEFAULT_CANVAS_SHARING_DEFAULTS`. The **Default Artifact Audience** (Editors
only, Everyone in the Organization, Anyone with a link; default Anyone with a
link) is stored and shown but changes nothing yet: it is the audience Rally
will suggest for a Canvas's artifacts.

The conversation viewer check reads the person's role from their Organization
relationship (a guest asks with `requireGrantAuthority`); only an active
member has a role, so somebody suspended or with no relationship is never
admitted by Organization visibility. Resource
authorization, and so `ArtifactOpenService`, decides a Canvas's artifact from
the same facts: an artifact generated in the Chat is attached to it, so a
person who may open the Canvas may open the artifact; additional artifact-only users are decided by the separate artifact audience
(`hostedConversationAuthorizationFacts`, one call for a Sidekick or a Canvas).

### Who changes who can open it

The sharing modal has two independent audiences: **Who can edit** (the Chat
and publication) and **Who can interact with artifacts** (published output).
Editors always have artifact access. With Organization editors the artifact
audience is at least the Organization (`canvasArtifactVisibilityFloor` in
`@rally/contracts/canvases`, applied by `setAudience` and on create).
A manager saves both in one transaction;
artifact hosts receive the changed policy through the existing Cloudflare Queue.
[Canvas artifact access](canvas-artifact-access.md) owns propagation and serving.

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
the visibility. For an Organization-wide Canvas the sharing dialog names only
its guests, since every member is admitted already, so a save from it, a
narrowing one included, keeps the members who joined it themselves (below)
rather than dropping them. A later save from the narrowed Canvas lists them
and can remove them. Everyone named must be in the Organization, as a member or a
guest (`assertAudienceInOrganization`, the check a Sidekick's audience uses;
`canvas_audience_not_member`); a `participants` Canvas names someone other than
its creator (`canvas_audience_participants_empty`). Narrowing the audience
backgrounds the presence of anyone it no longer admits and re-sends presence to
the people still in the Canvas, before the one Canvas list the write sends, and
closes the open Chat feed of each person it took away through the
access-revocation Queue ([`access-revocation.md`](access-revocation.md)).

A member an Organization-wide Canvas admits may add themselves to its
participant list (`canvasJoin`, `POST /canvases/:id/join`), so its notices
reach them ([Canvas notices](PRDs/2026-11-14_canvas-notices/prd.md)). A join
is an `added` row whose `added_by_user_id` is the person themselves, which is
how a join is told from a manager's add. Only Organization visibility admits
a join (`canvas_join_requires_organization_visibility` otherwise): a
participant row admits whatever the visibility, so a join through a writer
Sidekick's audience or an administrator's role would outlast that admission.
Someone the Canvas does not admit is told it does not exist.

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
in the Chat through the message port (`saidMessages`, `peopleOnly`), asks `canvasTitleFromOpening` (the `resource_naming` role,
reasoning off, metered as `channel_naming`) for a title and an icon from the
shared catalog, and writes the title in one
statement guarded by `title_status = 'naming'`, which also settles it, so the
list and the detail move as a retitle moves them. A retitle settles the row
first, so a person's title always wins over a pass still in flight; a model
that fails or answers nothing settles the row as it is, logged
`canvas_naming_failed` with its code. In the same transaction the chosen icon
fills `appearance_json.icon` only while it is still null, read after the
model's await, so an icon a person picked in the meantime stands; the colour is
left alone. A key off the menu drops the icon and keeps the title. A Canvas a Sidekick run makes, or one
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

One Canvas is made by nobody typing: the guide a new Organization is given,
which `seedCanvas` makes through `createCanvas` with the owner as its creator
([`canvas-seeds.md`](canvas-seeds.md)).

### Choosing what a Canvas looks like

A Canvas may carry an icon and a colour somebody chose, the same two keys a
Sidekick stores and parsed by the same `WorkstreamAppearanceSchema`
([`automation-lifecycle.md`](automation-lifecycle.md#choosing-what-a-sidekick-looks-like)
owns the catalog and the ring). They live on the directory row as
`appearance_json` (migration 137), null until someone chooses, and the
summary carries them as `appearance` on the list row, the detail and a
Sidekick's Canvases, each field null while unchosen. An unchosen icon draws one
fixed placeholder (`PanelsTopLeft`), never a glyph read from the Canvas's
artifacts: only the naming pass or a person sets the icon. An unchosen colour
is the hue the id gives it (`canvasHue`).

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

A Canvas's artifacts come from two producers. Most are resources its
conversation generated: Rally's `publish_resource` from the Chat publishes
under the identity it always has, `terminal:<conversation>:<path>`, and the
conversation is now the Canvas. The first publish of a path is a new resource,
version 1; a later publish of the same path is a new version of it; a different
path is another artifact. A file of any kind, or a directory that becomes a
site or an archive, as [`reactive-web-artifacts.md`](reactive-web-artifacts.md) decides.

A person can also publish a file or a static site made elsewhere, through
`POST /canvases/:id/artifacts` (`CanvasPublicationService`, used by the
[MCP server](rally-mcp.md#publishing) and any other client). It needs only the
right to take part in the Canvas, and lands through the same writes as Rally's
publish, with the person as the version's author and the Canvas's last editor.
Its identity is `canvas:<canvasId>:<name>`, so publishing the same name again
is a new version of it. The two namespaces never meet: a name Rally published
from the Chat and the same name published by a person are two artifacts. A
component or project site is built first, in the Canvas's own Terminal sandbox
(`services/canvas-build/`), which every participant's runs share
([`terminal-workspaces.md`](terminal-workspaces.md),
[`security.md`](security.md#shared-canvas-sandbox)).
`artifact_registry.workstream_id` holds the Canvas id, which is the
conversation's parent id, so no column changes meaning. After each publish the
Terminal's resource bridge tells the Canvas (`canvasArtifactNoter`,
`WorkspaceDO.canvasNoteArtifact`), from a publish that returned and from one
`reconcilePublishedResource` recovers as `landed` (the attempt that wrote it
may have died before its note), which records the resource in
`canvas_artifacts`, advances the Canvas's `updated_at` to the version's date,
and names its last editor:
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

The workspace's resource-version ledger also advances recency when an
already linked artifact is published or replaced. Renames and connector
refetches refresh artifact previews and leave the Canvas date intact. The date
comes from the saved version, so a retried note preserves it.

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
Its first publish creates the run's Canvas: the person the run acts as is its
creator, or the Sidekick's author when it acts as the Sidekick itself, the Sidekick its writer, the publish's `displayName` its title, and
whoever the Sidekick is shared with can open it. Every later publish of the
run finds that Canvas (`canvasForSidekickRun`; `HostedCanvas.create` answers a
second create for the same run with the first Canvas), and the create attaches
the Canvas to the Sidekick. A run asked to update a
Canvas names it with `publish_resource`'s `canvas` argument, which must be a
Canvas attached to this Sidekick (`canvas_not_attached_to_sidekick` otherwise);
anything but a Sidekick run naming one is refused (`canvas_argument_unsupported`).
For a run a schedule or an event started the attachment is enough: it
publishes as the Sidekick itself. A run a person asked for, from the Run
button or by a message, publishes only where that person can open the Canvas
now (`canvas_access_denied`), and so does a background agent's conversation,
which is no run
([who a run acts as](automation-lifecycle.md#who-a-run-acts-as)).
A run that acts as the Sidekick itself and has no Canvas of its own yet needs
somebody to create one as. That is the Sidekick's author. When the Sidekick's
directory row names no author, the first publish that names no `canvas` is
refused `canvas_creator_unavailable`
(`apps/api/src/services/terminal/authority.ts`), and the refusal tells the
run to publish into a Canvas from `ATTACHED CANVASES` by naming it in
`canvas`. A publish into an attached Canvas needs no creator and is not
refused.
The run's own conversation is attached too, so the run can read back what it
published. "The Canvases it writes to" is `canvasesWrittenBy`, a join from the
Sidekick's attachments to the directory, on the Sidekick's detail as
`canvases`, filtered to what the reader may open.

### Sidekicks attached to a Canvas

Zero or more Sidekicks are attached to a Canvas, each by one row of
`sidekick_conversation_attachments`
([`automation-lifecycle.md`](automation-lifecycle.md#attached-conversations)
owns the row and what it grants). An attached Sidekick's runs read and post in
the Chat, publish new versions of the Canvas's artifacts, and write rows into
an artifact that stores data. A person's own Canvas, with no writer Sidekick,
is updated this way.

Attaching changes who can open nothing. The Canvas admits who it admitted, and
the Sidekick's audience is its own; `writer_sidekick_id` alone carries a
Sidekick's audience into a Canvas, and only for a Canvas a run made.

`POST /canvases/:id/sidekicks` (`CanvasService.addSidekick`) makes one for the
Canvas on behalf of a client that is not its Chat, the
[MCP server](rally-mcp.md#sidekicks-for-a-canvas) first: the Sidekick is made
attached, as the Chat's `create_sidekick` makes it, and the request's
instructions go to its wizard as the person's edit. `POST /canvases` takes the
same as `sidekick`, after the Canvas and its prompt. A guest makes none
(`canvas_sidekick_member_required`).

The Canvas list row carries the same list, and an open Canvas's menu reads it
from the row, which the socket keeps current, rather than from the detail it
opened with. A Sidekick's directory write pushes the Canvas list when its
name, state or appearance moved (`noteAttachedSidekickFace`).

Selecting an openable Sidekick in the Canvas command pill opens its conversation
and details in the existing right panel, preserving the Canvas chat and route.
The panel has close and expand controls; its run selection stays local.
[`desktop-shell.md`](desktop-shell.md#one-right-slot) owns the panel behavior.

`GET /canvases/:id` lists them as `sidekicks` (`HostedCanvas.sidekicks`): id,
name, state, appearance, and `madeHere` for one this Canvas's Chat made. Every
reader of the Canvas sees the list; attaching a Sidekick is the consent to show
its name and state there. An archived Sidekick is not listed.

A Sidekick the Canvas's Chat made
([`automation-lifecycle.md`](automation-lifecycle.md#a-sidekick-made-in-a-canvas))
is managed by everyone the Canvas admits, who change or archive it by asking
the Chat (the title menu lists it and offers no archive), and **archiving the Canvas archives it** in the same
transaction (`archiveMadeSidekicks`). A Sidekick only attached here keeps
running; its next write to the archived Canvas is refused.

### Rally in a Canvas Chat

A message in a Canvas's Chat reaches Rally through the conversation's
addressing: alone in the Canvas, every message is for Rally; with others there,
the addressing classifier (`classifyWorkstreamMessage`) decides whether a
message is for Rally or for the people. The run has the agents plugin, with which it makes a Sidekick for this Canvas
and archives one it made
([`agent-communication.md`](agent-communication.md#in-a-canvass-chat)), the resource tools
(`list_resources`, `read_resource`, `view_resource`, the artifact data tools
keyed by the Canvas id) and the Terminal's `publish_resource`, which publishes
into the Canvas. One of the data tools writes: `write_artifact_data` changes
rows in a stateful site linked to the Canvas without republishing it
([reactive web artifacts](reactive-web-artifacts.md#writing-rows-from-a-run)). It has no conversation tools; those serve a Sidekick
([`conversation-tools.md`](conversation-tools.md)).

Rally is told about the Canvas in a host-provided message, `CANVAS CONTEXT`
(`canvasRunContextMessage`, from `WorkspaceDO.canvasContext`): the Canvas's
title, its artifacts at their current versions (each with the `filePath` a
publish names and whether it stores data, `HostedCanvas.agentArtifacts`), the
Sidekicks attached to it, and that republishing a path
is a new version attributed to Rally while a new path adds an artifact. It is a
derived user message, as a Sidekick run's activation context is, not system
prompt text, because the system prompt prefix is byte-stable and cached and
the artifact list changes with every publish; it is keyed on the message that
woke the run, under its own source kind (`canvas_context`), so it never shares
an identity with another derived message keyed on that same message. A replay
keeps the context the run started with
([`agent-harness.md`](agent-harness.md)).

A Chat can open with Rally's own message: a seeded Canvas's does. A provider
conversation must begin with a user turn, and Gemini, the fallback model,
refuses one that begins with the model's. So `projectModelProtocolTranscript`
hands an agent message that would be the first thing the model is given (the
first in the projection, with no compaction checkpoint in front of it) over
as a `user` message under the header `RALLY'S OWN EARLIER MESSAGE IN THIS
CONVERSATION. CONTEXT, NOT A REQUEST` (`projectLeadingAssistantMessage`),
the way an imported assistant reply is handed over, and every later agent
message as an `assistant` turn.

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

A row (`canvasSidebarRows`) is the summary plus: `sidekicks`, the Sidekicks
attached to it as its detail lists them, read for every listed Canvas in one
statement over the attachments; `unread`, the Chat's read
state as `sidekick_viewer_reads` projects it against the Chat's latest
attention ordinal (a Canvas never opened is unread to anyone but its creator);
`presentUserIds`, the people whose foreground socket has the Canvas open now;
`pinnedPosition`; `sharedWithMe`, set for a participant who did not make it;
`artifactKind`, the newest artifact's kind; `hasStoredData`, whether any listed
artifact has its own database (`artifact_registry.stateful = 1`); and
`lastWrittenBy`, the run
whose publish made the newest version (`sidekickId`, `runId`, its
`runNumber` counted as the run's own row counts it, oldest first, and the
Sidekick's `sidekickName`), null when the newest version is no run's or its
Sidekick was deleted, and absent from an older Worker. This field and its query
joins are retained for released clients that display run attribution; the current
renderer no longer consumes it. Removing that legacy projection is a follow-up. The list holds every Canvas the viewer may open as its
creator, a participant, a member of an Organization-wide one or someone its writer
Sidekick is shared with, most recently active first, at most 250, the bound
the Sidekick list already has; an owner's or administrator's list does not add
every private Canvas they could open. **Recent** sorts by the Canvas's
`updatedAt` and displays that same date. It starts at creation (or the old
Thread's last activity on conversion). New Chat messages, artifact publishes,
and artifact replacements advance it. Opening, reading, renaming, sharing,
and changing the Canvas's appearance leave its date intact.

The Pinned group mechanism, shared with Sidekicks, is
[`pinning.md`](pinning.md)'s. What is particular to a Canvas: it is pinned with
`POST /canvases/:id/pin` and its row carries `pinnedPosition`; a pin must be of
a Canvas the viewer may open (its audience), so a Canvas that narrows out a
viewer drops off their Pinned group; and a guest may pin a Canvas shared with
them but not reorder the group, since the order route is on the member-only
mount, which has to be decided before drag-to-reorder lands in the client.

### Shared from another Organization

A Canvas shared with a person (`sharedWithMe`) also appears in the list of
every other Organization they open, with that Organization's initial on its top
right, unless they turned it off (Settings › Account › Preferences). The server
sends these rows on the workspace socket (`workspace_shared_canvases`); how a
share is published, held in the person's inbox and pushed is
[`canvas-share-federation.md`](canvas-share-federation.md)'s. Here it costs a
`share_revision` column, the outbox triggers on `canvas_participants` and
`canvas_directory`, and three RPCs, one of which answers another Organization's
list, for one person and only about Canvases shared with them. In the client a shared row has no menu, drag
or pin and opens in its own Organization.

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
section records only what the code decides. The home shares its responsive
card grid with Sidekicks; the shared layout is described in
[`desktop-shell.md`](desktop-shell.md#section-dashboards).

- **The list** is the `canvases` query the workspace socket fills
  (`workspace_canvas_list`, `applyVersionedSidebarList`), read with
  `useSocketOwnedList`; there is no list route. The home page keeps activity
  order and filters client-side from the row's own fields: Reactive uses the same
  active automatic-trigger rule as the **Reactive** badge, Data is `hasStoredData`,
  Made by me `createdByUserId`, and Shared with me `sharedWithMe`. The second
  line of sidebar rows and home cards shows sharing with the Share panel's
  icons: a lock for **Only you** / **Only the creator**, people for **Specific
  people**, and a building for **Everyone in the Organization**. A writer
  Sidekick adds **and the Sidekick's audience** to creator and participants
  labels, with a people icon instead of a lock. Home cards retain their viewer
  facepiles and timestamps. Viewer presence
  is shown separately from **Data backed**, which means the Canvas holds a
  listed database-backed artifact. **Reactive** means an active attached
  Sidekick has a schedule or event trigger; invocation-only, manual-only, paused
  and draft Sidekicks do not qualify. App invocation handles submitted work and
  does not by itself mean the Canvas updates automatically. Trigger kinds travel
  in the Canvas projection so readers who cannot open the Sidekick still see this state. The projection
  uses the same definition query as the Sidekick directory, and refreshes when
  its trigger kinds change, including draft changes; instruction-only edits
  do not refresh it.
  The attached Sidekick facepile names each mark on hover and lists hidden
  names on its hexagonal overflow count. Clicking it opens the Canvas; the title link's
  accessible description carries the indicators and stack name.
- **The mark** (`CanvasMark`) holds the chosen icon, else the unchosen
  placeholder, in a pastel pair through `markColors`: the chosen
  colour, else a hue stable for the id (`canvasHue`). The home card's preview
  fills its entire background with that tint and centers the glyph vertically
  and horizontally, with no icon repeated in the title row. The ink applies
  only to the glyph so the Data badge keeps the page's text colour. Appearance
  is chosen from the pill's mark or the menu's **Change appearance** with the
  Sidekick's `AppearancePicker`, a popup rather than a
  submenu (a submenu has no room beside a phone-width menu); each click saves
  through `PATCH /canvases/:id`.
- **Making one** opens `/canvases/:id` under its final client-minted id before
  `POST /canvases` answers. The shared browser/Electron composer accepts typing
  and recording immediately; Send and Enter wait for creation and the first live
  snapshot. A display-only empty detail keeps that composer mounted without
  seeding canonical socket caches. The submitted opening prompt stays visible;
  a failed prompt can be edited before retry. Unchanged retries reuse both ids;
  an edited prompt gets a new message receipt under the same Canvas id.
  Window-local `canvas-creations` state is scoped by account and Organization
  and retained across navigation until the
  first live snapshot clears its entry. The shell reports failures even away
  from the Canvas, with **Open Canvas** restoring its recovery controls and
  draft. Recovery metadata does not survive a reload; ordinary draft persistence
  is unchanged. A pending New Canvas click returns to that attempt; completion
  never navigates. Recoverable detail-read failures keep recording mounted and
  offer **Retry loading Canvas details**; definitive access refusals retain the
  normal unavailable states.
- **An open Canvas** is `ConversationSurface` with `parentKind: "canvas"` and
  substream `"0"`, so the composer, annotations (a Canvas's comments), the
  inspector rail, its resource cards and versions menu, and the
  per-conversation panel restore (`artifact-panel:<canvas id>:0`) are the
  surface's own. With nothing saved, the screen opens the newest artifact of
  `GET /canvases/:id` beside the Chat (`openResourceState`, `expanded: false`);
  a link naming an artifact opens it expanded. The surface does not close a
  requested panel on the device cache's copy of the conversation, which may
  list none of its artifacts. Closing the panel clears what was saved, and the
  command menu's **Open artifact** is the way back to it. While the conversation
  is visible, a newly attached artifact opens the right panel at an even split,
  including after a person closed it. `useOpenAttachedArtifact` follows the
  conversation's live resource list. Replacement socket snapshots establish
  the baseline, so a refreshed retained cache cannot override a saved panel or
  explicit artifact link. Automatic reveals leave keyboard focus where it was.
  A refresh or new version of an existing artifact does not reopen the panel,
  nor does an ordinary source attachment. If several artifacts arrive together,
  the newest attachment opens. Hidden conversations do not take the panel from
  the conversation on screen. The shared surface applies this to Sidekick
  conversations too. An arrival replaces the current right-panel content,
  including the browser, and uses the existing full-pane layout in narrow windows.
- **The header** is a centred `TitlePillHeader` naming the Canvas,
  with the face pile of everyone else in it now and Share at the right.
  The pill's menu starts with four action tiles, using the artifact menu's
  shared primitives: Share, Open artifact, Copy link and Pin (Unpin when pinned).
  Open artifact is disabled until the Canvas has an artifact and while its
  artifact panel is already open; closing the panel enables it again. A tooltip
  explains either disabled state on hover or keyboard focus. Rename… and
  Change appearance follow as rows, then the **Sidekicks** section, then,
  while the Canvas sends notices, a **Notifications** section
  (`CanvasNoticesMenuSection`): **Get notifications** for a member not listed
  on an Organization-wide Canvas, else **Mute notifications**, or **Turn on
  notifications** while none reach the viewer. The menu closes on a choice,
  so a failure shows on the Canvas screen. **Archive canvas** is last,
  separated and in danger styling, for a manager. It confirms before writing
  and returns to Canvases after success; a failure keeps the Canvas and
  confirmation open.
  On an Organization-wide Canvas that sends notices, a member who is not
  listed sees a banner under the title (`CanvasNoticesJoinBanner`), in its
  own row of the screen's grid, with **Get notifications** and **Not now**,
  which hides it for this Canvas on this device.
  The pill's title is
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
- **Share** offers one of three audience choices and a people picker to
  someone the detail says may manage it (`canManage`). Other viewers see the
  audience read-only. A Canvas a Sidekick writes says it is also open to the
  Sidekick's audience. The picker omits the viewer and creator. With
  **Everyone in the Organization**, members and guests remain searchable.
  Active members show checked, disabled boxes, invited rows show their pending
  status, and guests remain selectable. Save sends the audience through
  `POST /canvases/:id/audience`, then invites the typed guest addresses through
  `useScopeInvitations` with a `workstream` target naming the Canvas. For a
  decider, a **Requests** section lists `pendingAccessRequests` with
  `AccessDecisionActions`, the component the Activity row uses; an approval
  made while the panel is open joins its choice of people, and the visibility
  the server moved to replaces the panel's, so a following Save does not take
  back the access just given.
- **Pinning** is `POST /canvases/:id/pin`, from the pill's menu, a row's
  context menu, or dragging a row into the section's Pinned group
  (`useCanvasPinDrag`), including the left rail; both surfaces share one order,
  and support drag or Alt + Up/Down reordering
  ([`pinning.md`](pinning.md)).

Copying a Canvas's link is **Copy link**, the form
`/app/<region>/<organization>/cv/<canvas>/` ([`links.md`](links.md)); a
detached artifact window's **Copy link** adds the artifact's segment.

## Invariants

- **An active Canvas is admitted by `canvasAdmits` and nothing else, and it is the
  rule a Sidekick's audience is.** A second rule in a reader would let one
  surface show a Canvas another refuses. Guard: the Node policy test
  (`test/authorization-policy.test.ts`), `test-workers/canvas-hosting.test.ts`
  and `test-workers/canvas-conversation.test.ts`.
- **Archiving is terminal and retains content.** Archived Canvases leave active
  discovery, reject admission and late publication, and cannot be recreated by
  retrying creation. The timestamp and retained relationships survive retries.
  Guards: `test-workers/canvas-hosting.test.ts`, `test-workers/canvas-conversation.test.ts`,
  `test-workers/conversation-audience-revocation.test.ts` and the migration-142
  case in `test/workspace-canvas-schema-migration.test.ts`.
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
becomes ([`reactive-web-artifacts.md`](reactive-web-artifacts.md)).

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

- `apps/desktop/src/renderer/screens/canvas-creation.test.tsx` — immediate opening
  on both hosts, send readiness, prompt visibility and correction, recovery away
  from the route, pending relaunch, first-snapshot cleanup, detail-read failures
  during recording, and stable draft/composer identity. Network and audio
  boundaries are held independently.
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
  viewer may not open is neither pinned nor present. The same file covers
  `hasStoredData` on pushed rows and its registry and listing conditions.
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
  from a socket-fed list: activity order and the Data filter, facepiles
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
- `apps/desktop/src/renderer/lib/use-open-attached-artifact.test.tsx` — new
  artifacts open a dismissible panel, including after closing it; initial
  resources, source uploads, existing artifact refreshes and hidden
  conversations leave it alone; replacement snapshots reset the baseline,
  preserving saved panels and explicit links on a revisit. Run with `pnpm --filter @rally/desktop exec vitest run
  src/renderer/lib/use-open-attached-artifact.test.tsx`.
- `apps/desktop/src/renderer/lib/use-workstream-socket.test.tsx` — batches two
  live attachment frames through the real client handler and opens the newest;
  unmounts and revisits with retained queries, then replaces the snapshot and
  preserves the restored panel before opening a later live attachment.
- `canvases-home.test.tsx`, `canvas-sidebar-section.test.tsx` and
  `components/navigation-sidebar.test.tsx` (the Activity section) — each mark
  in the chosen icon and colour, and an unchosen one in the placeholder and its hue.
- `apps/desktop/src/renderer/components/canvas-sidebar-section.test.tsx` — the
  section's Pinned group and rows, drag to pin, unpin, and the skeleton.
- `apps/api/test/workstream-object-schema.test.ts` — conversation migration 83
  carries a populated v81 root, every column and all nine triggers across the
  rebuild.

### Archiving

`POST /canvases/:id/archive` delegates through `CanvasService` and
`WorkspaceDO.canvasArchive` to `HostedCanvas.archive`. A manager
(`canvasManages`: creator, writer Sidekick manager, owner or administrator)
may archive for everyone. A participant who cannot manage is refused with
`canvas_archive_forbidden`; a person the Canvas never admitted sees
`canvas_not_found`. The transaction writes `archived_at` once and settles any
pending naming state. A retry by a manager succeeds without changing the
timestamp. No unarchive operation is offered.

The directory row, participants, Chat and artifacts stay stored. Active lists
omit archived rows; parent authority reports archived, new admission and
artifact authorization refuse them, and a late child projection or artifact
notice cannot make them active again. A create replay cannot recreate an
archived Canvas. Writer Sidekicks cannot select an archived Canvas for another
publication, whether selected explicitly or reused implicitly for the same run.
The transaction also marks memory digest copies for withdrawal, advances each
Activity recipient's waterline, and saves one alarm entry per Chat child and
reactive artifact. Those entries stop the child loop and cancel its timers, publish
Chat revocations through the existing access-revocation Queue, and withdraw
artifact viewer sessions. Failed deliveries retain their original targets behind
the alarm store's retry gate; retrying the archive never needs to reconstruct an
audience the tombstone already removed. The ordinary Canvas and Activity
waterline pushes remove their rows and unseen counts from open windows.

Migration 142 also records a publication's parent on `resources` and fences
resource mutations and artifact-registry writes against that parent's tombstone
inside SQLite. A publisher which prepared bytes or cached its destination before
archive cannot advance the retained content afterwards. Canvas-owned artifacts check the tombstone before uploader ownership; standalone
artifacts retain their own ownership. Existing generated-resource search rows are
requeued so Canvas-owned artifacts lose their independent publisher audience,
and archive queues their search withdrawal.
Artifact hosts retain a
Canvas tombstone of their own (migration 3), so delayed pointer writes or open
code minting cannot undo archive delivery. Existing anonymous public-site reads
retain their publication policy; authenticated sessions are withdrawn.

### Discarding a blank Canvas

Leaving a blank Canvas deletes it, so pressing New Canvas and going elsewhere
does not leave an **Untitled Canvas** behind. Sharing still at the
Organization's default does not make a Canvas used; sharing somebody changed
does. Until a Canvas holds something, Organization-wide sharing does not list
it for anyone but its creator (`canvasSidebarRows`). What blank means is the query in
`HostedCanvas.discardIfBlank`; the client (`screens/canvas.tsx`, from
`ConversationSurface`'s `onBlankChange`) only skips the request for a Canvas it
knows is in use, and reports blank only once the history, the saved draft and
the saved attachments have all loaded.

`CanvasService.discardIfBlank` runs in this order, because the parent's
projection of the Chat can lag a message the Chat already holds:

1. The Organization object judges the Canvas, deleting nothing.
2. The Chat seals itself against new messages if it holds none and no other
   client has it open (`AgentLoopDO.sealBlankConversation`). The leaving
   client names its own socket by the ticket it opened with, since that socket
   may still be closing.
3. The Organization object judges again and deletes its rows. That commit is
   the delete. If the Canvas changed in between, the Chat is reopened.
4. The Chat erases its storage; it refuses if it is not sealed. Step 3 commits
   an alarm entry (`CANVAS_DISCARD_ERASE_ALARM`) that runs the erase and
   retries it until it lands, so an interrupted erase never leaves the Chat's
   storage for good. A retry after a success finds no identity and wipes the
   empty schema it opened.

Only the id stays, in D1's `workstreams` anchor and `workstream_authority_routes`
row: migration 0079's `workstreams_reject_post_cutover_delete` trigger refuses
any anchor delete, and routing and audit foreign keys point at it.

A Canvas's row is always written before its Chat exists, so
`WorkspaceDO.receiveChildEffects` treats a Chat effect for a Canvas with no row
as one sent before a delete: it is acknowledged unapplied and logged as
`canvas_effect_for_deleted_canvas`, not retried into the dead-letter queue.

## Data model

| Table | Keyed by | Holds |
| --- | --- | --- |
| `canvas_directory` | `canvas_id` | The row: title, creator, times, last editor, writer Sidekick and run, visibility, authority generation, title status (`naming` until a Canvas made with no title is titled from its first message, migration 137), the chosen icon and colour (`appearance_json`, `WorkstreamAppearanceSchema` JSON, null until chosen, migration 137), and the run whose publish made the newest version (`last_writer_run_id`, migration 137). Its CHECK admits a run only beside a `sidekick` last editor, so a future writer that moves `last_editor_kind` without writing this column in the same statement fails its write. Migration 142 adds nullable `archived_at`: null is active; a timestamp retains the archived Canvas without admitting or listing it. Indexed by recency, by writer Sidekick, and uniquely by `(writer_sidekick_id, writer_run_id)`. |
| `canvas_participants` | `(canvas_id, user_id)` | Whom its managers added (`added`), a claimed share brought (`invitation`) or an approved access request let in (`request`, migration 137). Indexed by person for "shared with me". |
| `sidekick_children`, `sidekick_child_projections`, `sidekick_child_receipts`, `sidekick_viewer_reads` | `(sidekick_id, …)`, the column holding the Canvas id | The hosted conversation's children, their projections and receipts, and each reader's read of the Chat. |
| `workspace_sidebar_list_state` | `list` | Gains the `canvases` waterline; the table is rebuilt to widen its CHECK. |
| `sidekick_conversation_attachments` | `(automation_id, parent_kind, …)` | Migration 137 widens `parent_kind` to admit `canvas`. |
| `workspace_pins` | `(user_id, item_kind, item_id)` | Migration 137 admits `canvas` and `sidekick`, with no parent. |
| `canvas_notice_registrations` | `canvas_id` | Migration 150: whether the Canvas sends notices, the sentence saying what about (`purpose`), who turned them on (Rally or a Sidekick, by name), the `revision` each register call writes, the Chat's record of it (`record_message_id`, null until it lands) and `updated_at`, which the record carries as `recordedAt` ([`push-notifications.md`](push-notifications.md#canvas-notices)). |
| `canvas_notice_operations` | `operation_id` | Migration 150: the revision each register call wrote, keyed on the call's operation, so a retry finds it. Indexed by Canvas. |
| `canvas_notification_choices` | `(canvas_id, user_id)` | Migration 150: one person's channels for this Canvas's notices, `[]` for muted; no row follows Settings. Discarding a Canvas deletes all three tables' rows. |
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
are deleted. What survives: the `resource_naming` model role, which titles a
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

### 2026-11-16 — Shared Canvases federate to every Organization a person opens

**What changed:** Each Canvas publishes who it is shared with through an outbox
(`share_revision` and triggers on `canvas_participants` and `canvas_directory`,
WorkspaceDO migration 150), and answers `canvasShareState` for one person.
Every other Organization the person opens lists those Canvases, badged with
their Organization; [`canvas-share-federation.md`](canvas-share-federation.md)
owns the mechanism.

**Why:** A guest in a partner's Organization, or a member of several, had to
switch Organization to find what was shared with them.

**Considered and rejected:** Having each client read every other Organization's
list, which this branch built first and removed: three clients each doing the
work, and lists only as fresh as the last window focus.

**Consequences:** Anything that adds a way to share a Canvas must write
`canvas_participants`, or the share will not federate. A rename, re-icon or
archive publishes to everyone it is shared with; activity alone does not.

### 2026-11-15 — A person the Canvas admits can join its participant list

**What changed:** `canvasJoin` lists a member an Organization-wide Canvas
admits, as an `added` row they added themselves. A sharing save from an
Organization-wide Canvas, narrowing included, keeps those rows.

**Why:** Canvas notices go to a Canvas's listed participants, and a member
admitted only by Organization visibility had no way onto the list but a
manager's add. The sharing dialog names only guests for such a Canvas, so
without the keep rule any save would have removed every member who joined.

**Considered and rejected:** A `self` participant source, which needs the
table rebuilt with its six triggers restated; `added_by_user_id = user_id`
already tells a join apart. A save that sends adds and removes: the
`sharing_revision` fence already refuses a save from a dialog opened before
the join.

**Consequences:** Narrowing an Organization-wide Canvas keeps whoever joined
it. Joining is refused through any other admission, a writer Sidekick's
audience or an administrator's role, because a participant row admits
whatever the visibility and would outlast the admission it relied on (found
in review).

### 2026-11-13 — New Canvases open to the Organization by default

**What changed:** A new Canvas, a Sidekick run's included, now opens to
everyone in the Organization. Administrators choose the default under Organization preferences
(**Default Editor Audience**: Creator or Everyone in the Organization), stored
in WorkspaceDO migration 149's `canvas_sharing_defaults`. A second setting,
**Default Artifact Audience**, is stored and shown but not applied yet. An
untouched Canvas (its default title, no Chat message, no artifact) lists only
for its creator until it holds something, though a member with its link can
open it. A blank Canvas whose audience is still the default is discarded when
its creator leaves it; one whose sharing somebody changed is kept.

**Why:** Product decided a Canvas is shared work by default. The default sits in
the Organization's object rather than the D1 `workspaces` row beside the
timezone, because `create` runs in that object and a D1 read would add a round
trip to opening every new Canvas. Sidekick-run Canvases follow the same
default; keeping them `creator` was considered and rejected by product, so an
Organization that wants a personal Sidekick's output private chooses `creator`.
The blank check had required `creator`; left alone, every new Canvas would
have counted as used and pressing New Canvas would have left an Untitled
Canvas behind again. Without the list rule, every press would have pushed an
Untitled Canvas into every member's sidebar, left there for good if its
creator quit before the discard ran, and a teammate who opened it from the
list could have had it deleted under them. Creating as `creator` and applying
the default on first use was rejected: it needs a second "chosen" flag for the
editor audience to tell a person's `creator` from the pending default.
Sharing an empty Canvas exactly as the default already does is
indistinguishable from not sharing it, so that Canvas is discarded too.
Everyone a Canvas admits manages the Sidekicks its Chat made, so with
Organization-wide Canvases every member can edit, pause, delete or re-share a
Sidekick made in one, including one that runs as its author. Limiting that to
the Canvas's named people was built in review and reverted: product accepts
the risk to keep one rule, "access to the Canvas manages its Sidekicks", until
it proves to be a problem. A future change that applies the artifact default must
respect `artifact_visibility_chosen` the way `set_artifact_audience` does.

### 2026-11-12 — Delete a Canvas left blank

**What changed:** Leaving a blank Canvas deletes it. See
[Discarding a blank Canvas](#discarding-a-blank-canvas).

**Why:** New Canvas makes the Canvas at once, before anything is typed, so
every abandoned click left an Untitled Canvas in the list. A blank Canvas holds
nothing worth keeping.

**Considered and rejected:** Archiving it: it kept a tombstone and a Chat
object for every abandoned click. Judging blank on the client alone, or from
the parent's projection alone: both miss a message the Chat already holds, or
a second window still open on it, and a delete that removes real content
is a failure nobody would notice. Deferring creation until the first message:
it puts creation latency back before the first keystroke, which the 2026-11-11
entry removed. Deleting the D1 anchor too: migration 0079 fences anchors
against deletion, and lifting that fence is a separate decision.

**Consequences:** Anything a future change lets a person put into a Canvas
must join the blank query, or leaving would delete it. A table that starts
keeping a row per Canvas must join `CANVAS_DISCARD_STATEMENTS`. Treating a
Chat effect for a missing Canvas as one for a deleted Canvas depends on
`createCanvas` writing the row before bootstrapping the Chat. The Chat's erase
runs from an alarm entry the delete commits, so `eraseBlankConversation` must
stay safe to run again on an object it already erased.

### 2026-11-12 — The naming pass chooses a Canvas's icon again

Every Canvas showed the same layout glyph, in its id's hue, because nothing
ever set its icon: Thread naming chose one beside the name, and the Canvas
titling that replaced it carried the title forward and dropped the icon. The
title call now also returns a key from the shared icon catalog, and the pass
writes it only when the icon is unchosen. It rides the same model call rather
than a second one, since one more key costs no latency. The client no longer
reads an icon from the newest artifact's kind: an unchosen icon is one fixed
placeholder, so the icon is only ever the model's choice or a person's. The colour stays the
id-derived default, so two Canvases with the same icon still differ. A future
change must keep the write conditional on an unchosen icon, so the pass never
overrides a person's pick.

### 2026-11-12 — Organization editors set a floor on the artifact audience

Picking Everyone in the Organization under Who can edit left the artifact
audience on Editors only, so the Canvas read as if its artifacts were private
and a manager had to pick the Organization twice. The artifact audience is now
never stored narrower than Organization editors: the Canvas Durable Object
raises Editors only and Specific people to the Organization on every write, so
an MCP or API caller cannot store the pair. It raises rather than rejects
because released desktop builds send that pair. A raise from Editors only drops
artifact recipients left over from an earlier choice, which grant nothing under
Editors only but would grant access under the Organization; a raise from
Specific people keeps them.

The stored raise is one-way: moving editors off the Organization keeps it, since
the row cannot tell a raise from a choice. The MCP tool tells callers to send
the artifact audience when narrowing. The sharing form avoids the problem by
keeping the manager's own choice in its draft and applying the floor only to
what it shows and saves, so leaving Organization editors restores the earlier
choice. Rows stored before the rule are not raised on read: reads report what
access checks enforce, which differs for guests named as artifact users.

### 2026-11-11 — App invocation does not imply automatic upkeep

The Live updating badge and Live filter require an active Sidekick with a
schedule or external-event trigger. Dedicated app Sidekicks respond to app
submissions, so their invocation trigger alone does not qualify. A Sidekick
with invocation alongside a schedule or event still qualifies through that
automatic trigger.

### 2026-11-11 — Open a new Canvas before its create request answers

**What changed:** The shared browser/Electron screen mounts its composer under
its final id immediately, creates asynchronously, and enables sending after the
live snapshot. Pending and failed attempts stay recoverable across navigation;
opening prompts remain visible and editable after rejection. The first snapshot
removes optimistic state, and transient detail failures preserve active recording.

**Why:** Creation and chat admission kept people waiting before their first
keystroke. Navigation moved ahead of the network, which also means its launcher
cannot own failure reporting or prompt recovery. Keeping those with the shell
and retaining one mounted composer prevents lost drafts and interrupted audio.

**Considered and rejected:** Waiting to navigate until success puts latency back
before composition. Writing an invented detail into canonical caches would let
optimistic presentation masquerade as an admitted conversation.

**Consequences:** Stable draft identity and replay-safe unchanged retries must
survive future opening states. Editing a rejected prompt creates a new message
receipt: if the earlier request landed, its original message is not undone.

### 2026-11-11 — Show sharing in Canvas list subtitles

**What changed:** Sidebar rows and home cards show their sharing setting and
matching icon. Writer Sidekick audiences are included. The sidebar presence
line and green dot, and the home card's run link, were removed; home cards keep
presence facepiles and timestamps.

**Why:** The requested second line is a stable place to check sharing while
browsing. Keeping presence or run attribution on that line would displace the
sharing setting again. The Share panel's inherited Sidekick audience must be
reflected here so a run-created Canvas never claims it is private to its creator.

**Consequences:** Both surfaces share one status component. The unused
`lastWrittenBy` projection remains for older clients; removing its wire field
and query joins is a follow-up.

Pull request [#1559](https://github.com/juno-ai-labs/avalon/pull/1559).

### 2026-11-10 — Find Canvases by automatic upkeep

**What changed:** The home page's Live filter replaces From Sidekicks and
selects Canvases marked **Live updating**.

**Why:** Sidekick authorship identifies who made a Canvas, but does not tell
someone whether it continues to update automatically. A Canvas made by a person
can have an active scheduled or event-driven Sidekick, while a Sidekick-made
Canvas can have no automatic updates.

**Considered and rejected:** Keeping From Sidekicks as another filter. The
requested filter set removes authorship by a Sidekick in favour of automatic
upkeep; Made by me and Shared with me remain.

**Consequences:** The filter and badge share `isLiveUpdating`; future changes
must keep their eligibility identical. Manual-only, paused and draft Sidekicks
do not qualify.

Pull request [#1553](https://github.com/juno-ai-labs/avalon/pull/1553).

### 2026-11-10 — Explain a card's Sidekicks and automatic updates

Canvas cards now identify attached Sidekicks and distinguish automatic updates
from data-backed content. Trigger kinds travel in the Canvas projection because
a second client lookup would miss Sidekicks whose own page the Canvas reader
cannot open. The shared trigger query also drives refresh detection, keeping
draft projections current without publishing unchanged cards after
instruction-only edits.

### 2026-11-10 — Keep delegated work visible in a Canvas

The composer again shows running background-agent and Sidekick counts. The
Thread retirement removed both consumers and their old publishers, leaving a
Canvas looking idle while its helpers built an artifact. Counts now derive
from the hosted children's existing projections and travel on the Canvas list;
a second subscription or polling loop would duplicate state the Organization
already owns. Keep authoring distinct from lifecycle: an unsaved Sidekick can
be working, and an active one can be idle. Counts remain scoped to the Canvas,
version-fenced and hidden until the current connection has fresh state. A partial
index over live projections avoids scanning retained history, and counts are
shared only within each publish rather than maintained in another activity table.

### 2026-11-10 — Open an artifact as it joins the conversation

**What changed:** The conversation surface follows additions in its existing live
resource feed and opens the newest attached artifact at an even split without
taking keyboard focus. Socket snapshots establish the baseline; live additions
follow the snapshot's newest-first ordering.

**Why:** The initial Canvas detail opened an artifact only when the Canvas was opened, leaving a newly
generated artifact behind a closed panel until someone clicked its card.
Watching the Canvas detail or every version update was rejected: the former can
lag the conversation and the latter would undo an intentional close. A retained
detail from a previous visit must not turn a replacement snapshot into an
attachment and overwrite the saved or explicitly requested panel; automatic
reveals must not interrupt someone typing a follow-up.

**Consequences:** Initial restoration, explicit
artifact links and refreshes keep their existing behavior; only a new attachment
in the visible conversation opens the panel again.


### 2026-11-10 — A Canvas holds attached Sidekicks, and its archive takes the ones it made

**What changed:** A Canvas's detail lists the Sidekicks attached to it, a run
publishes into any Canvas attached to its Sidekick rather than only one it
wrote, and archiving a Canvas archives the Sidekicks its Chat made.

**Why:** So a schedule or a stream of events can keep a person's Canvas up to
date. The reasoning, and the tighter design that was built and rejected, are in
[`automation-lifecycle.md`](automation-lifecycle.md#2026-11-10--a-sidekicks-canvas-attachment-is-the-publish-grant-and-a-canvas-makes-sidekicks-it-steers).

**Considered and rejected:** Leaving a Canvas-made Sidekick running after its
Canvas is archived: each trigger would start a run with nowhere to write. And
listing them for the archiver to choose, which the owner declined.

**Consequences:** A Canvas archive now writes Sidekick rows in its
transaction, so anything added to `HostedCanvas.archive` runs beside a
Sidekick lifecycle write. `canvasAdmits` is unchanged and must stay so: an
attachment never admits a Sidekick's audience to a Canvas.

Design: `docs/PRDs/2026-11-10_sidekicks-attached-to-canvases/prd.md`.

### 2026-11-09 — Date Canvases by saved messages and artifact versions

**What changed** — Opening publishes viewer read state. The recency date
comes from saved Chat messages and artifact publishes or replacements.
Canvas metadata mutations leave that date intact.

**Why** — Opening a converted Canvas sent its first projection to the
Organization. Its historical attention ordinal looked new to the directory,
which stamped the Canvas with the receipt time and moved it above recent work.
Using the unread ordinal also missed saved Rally text without a mention or
final response.

**Considered and rejected** — Using the Chat's activity time alone still let
admission move a converted Canvas with an earlier directory date. Keeping
recency on the publish note alone would miss updates by other artifact producers.

**Consequences** — Recency can advance on delayed delivery of newer content.
Authorization evidence tracks audience facts independently of the recency date.
The change applies as updates arrive and has no historical backfill.

Pull request [#1519](https://github.com/juno-ai-labs/avalon/pull/1519).

### 2026-11-09 — Put Canvas commands and manager-only archival in the title menu

The Chat header centres its title pill and keeps Share and presence at the right.
Share, Open artifact, Copy link and Pin use the artifact menu's shared action
tiles, with Rename and Change appearance below. Open artifact stays visible but
disabled until an artifact exists and while its panel is already open, with a
tooltip explaining why. The duplicate header overflow menu and Copy
Canvas ID action are removed. This restores the familiar artifact-menu shortcuts
and gives the Canvas one place for commands without pulling its title to the
left; future commands should extend that menu rather than add another trigger.

Archive Canvas adds the missing lifecycle operation, through a manager-only
route and WorkspaceDO migration 142's nullable `archived_at` tombstone. It
removes active discovery, Activity, memory and admission, and keeps content stored.
Archive cleanup is committed as per-target entries in the existing alarm store:
one failed Queue send must not strand access after admission already narrowed.
Resource writes check the tombstone in their own SQLite commit, while children
stop their loops and timers and artifact hosts withdraw viewer sessions. Deleting the directory row was rejected because
retained conversations and writer-run identities still refer to it, and a
late effect, publication, or create replay must not bring an archived Canvas back.
The original archive audience must survive retries, and a writer/run identity
must never be reused to recreate its archived Canvas.

### 2026-11-09 — Separate viewer presence from database-backed artifacts

**What changed:** The home card shows current viewers as a top-left facepile.
Its Data badge and filter use `hasStoredData`, derived from listed artifacts
joined to the existing registry's `stateful` flag in WorkspaceDO. The list
keeps activity order across all Canvases.

**Why:** The Data badge needs to identify an artifact with a database even
when nobody is viewing it; presence answers a separate question.

**Considered and rejected:** Inferring Data from the newest artifact's kind:
a static site has no database, and a newer file does not remove an older
database-backed artifact from its Canvas. Fetching each artifact's manifest
would add work to every dashboard opening when the registry already knows.
A separate Data group would put old trackers ahead of recent work even
though the filter and badge already make them discoverable.

**Consequences:** Presence and stored data can coexist independently; neither
changes a Canvas's position in the Recent list.

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
