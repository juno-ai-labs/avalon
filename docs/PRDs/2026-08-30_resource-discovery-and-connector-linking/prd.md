# Resource discovery and connector linking

> Created 2026-08-30.
>
> A person tells a project which connected folders and files it may use, by
> browsing and searching those sources, instead of prompting Rally to rediscover
> them on every run. Companion: [state](state.md). Sibling:
> [Projects](../2026-08-26_projects/prd.md). Subsystem references:
> [connectors](../../connectors.md), [projects](../../projects.md),
> [agent attachments](../../agent-attachments.md),
> [agent tools](../../agent-tools.md),
> [using company brand icons](../../using-company-brand-icons.md).
> Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).

## Summary

A person opening a project's **Default resources** list, or a work stream's
**Add a resource** picker, can see the sources they have connected — Google
Drive, Slack, GitHub, Granola, and the rest — search and browse them live, pick
a file or a folder, and link that object to the project. The link persists as
an ordinary project default: every work stream in the project receives it, and
Rally does not have to be asked to find the folder again.

The change is a shift in what Resources *means*. Today the picker lists
workspace `resources` rows Rally has already ingested — things a previous run,
upload, or origin attachment happened to create. After this change, the picker
answers “what should this project have access to?” by talking to the connected
provider in the person's own session, then resolving the chosen object through
the existing `POST /resources/resolve` path.

## Motivation

The concrete job, raised as a current product problem in #product on
2026-08-30, is: **connect this Google Drive folder to this project.** People
already try to do that. Rally has no person-facing way to do it, so they ask
the agent. The agent then loads the Google plugin, calls `google_drive_search`,
hopes the name matches, and still cannot list what is inside a folder even if
it finds one — `drive.search` accepts `fileType: "folder"` but has no parent
filter, and the Google adapter's own comment records that there is no tool that
reads a folder's children. Each of those calls is latency, a plugin-activity
row, and screen clutter on the way to a setup step that is not work.

Two surfaces already pretend to be this picker and are not:

- The work-stream **Add a resource** modal (`apps/desktop/src/renderer/screens/workstream.tsx`)
  searches `GET /resources?q=`, which is a `LIKE` over titles of rows that
  already exist in WorkspaceDO. Its empty state says “Resources discovered by
  connected services will appear here.” Its search placeholder talks about
  repositories, files, issues, and pull requests — GitHub-shaped copy over an
  inventory that is not live GitHub.
- The project-space **Add resource** modal
  (`apps/desktop/src/renderer/screens/project-space.tsx`) loads up to 100 of
  those same inventory rows, with no search, no source filter, and no way to
  reach a Drive folder that has never been a Rally resource.

Projects already do the persistence half. [The Projects PRD](../2026-08-26_projects/prd.md)
ships default resources that attach to every member work stream, and the
2026-08-18 product ideation and 2026-08-25 projects debrief treated those
defaults as load-bearing (“Projects without default resources = just folders”).
What they assumed, and what the current UI implements, is that the person
already has a Rally resource id to attach. The missing step is getting a
provider object that Rally has never seen into that list without running an
agent turn.

Leaving this alone keeps the cost on every new project: extra tool calls, a
folder that is not a durable handle, and a Resources surface that teaches the
wrong model of the product.

## Goals

1. A person can link a connected Google Drive folder or file to a project from
   the project space, without prompting the agent, and the link is a project
   default that every work stream in the project receives.
2. The same picker, used from a work stream's inspector rail, can attach that
   same object to one work stream.
3. The picker shows a visible row of sources the person can actually use —
   Rally (already-known resources and uploads), then each connected provider
   they have a usable connection for: Google Drive, Slack, GitHub, Granola,
   Linear, Notion, and the rest of the Connections catalogue.
4. **Add from connector** is a first-class action, not a by-product of a
   previous agent run. Choosing a source that is not connected offers
   **Connect**, using the existing Connections OAuth flow.
5. Search is live against the selected source. Drive search matches names and
   indexed contents the way `drive.search` already does for the agent. An empty
   query on Drive browses the current folder.
6. A linked folder is a durable Rally resource of a folder type (`drive_folder`,
   and the existing `granola_folder`, Slack channel, GitHub repository, and
   equivalent containers). Rally does not bulk-ingest the folder's children at
   link time.
7. Once a folder is linked, a run can list and search inside it. The person does
   not re-prompt Rally to locate the folder, and the agent does not start from a
   workspace-wide Drive search to rediscover it.
8. Linking uses the existing resolve-then-attach path: `POST /resources/resolve`
   then `addProjectDefaultResource` or `POST /workstreams/:id/resources`. A
   second link of the same provider object reuses the canonical resource rather
   than creating a duplicate.

## Non-goals

1. **Global Rally search is rejected.** The implementation brief organises
   Rally around work streams, not a global search product. Search in this PRD
   is scoped to the selected connected source (or to already-known Rally
   resources). It does not search transcripts, people, or other projects.
2. **Mirroring a provider into Rally is rejected.** Linking a Drive folder does
   not copy, crawl, or continuously sync its children into WorkspaceDO. The
   folder is a handle; children are listed live when a person browses or an
   agent searches. Bulk ingestion would invent a second copy of Drive with no
   freshness story.
3. **Automatic watching is deferred.** Linking does not turn on
   `resource_watches`. Watching remains the explicit inspector-rail action
   [resource versioning](../2026-08-27_resource-versioning/prd.md) already
   defines. A later change can offer “notify this work stream when this folder
   changes” as a separate control.
4. **A full provider client is deferred.** The picker is a chooser: search,
   folder navigation, multi-select, and **Add**. It is not Drive/Slack/GitHub
   with sharing dialogs, move, rename, or preview-as-the-product.
5. **Granting provider access to other participants is rejected.** Rally
   cannot make a private Drive folder readable to a project member who does not
   have it on Google. The existing Projects audience-containment rule still
   applies to Rally-side visibility; Google's ACL stays at Google. This PRD
   surfaces that gap; it does not invent Rally-side per-resource ACLs (the
   2026-08-25 decision that project resources are all-or-nothing on Rally's
   side stands).
6. **Prompting the agent to attach resources is not replaced, and is not the
   setup path.** A run may still load Google and search Drive for work in
   progress. This PRD stops using that path as the way a project is given its
   standing inputs.
7. **Gmail threads, calendar events, and X posts as project defaults are
   deferred.** They remain attachable when they already exist as Rally
   resources. They are not live-browse sources in this picker. The first
   complete live-browse sources are Drive (files and folders), Slack (channels),
   GitHub (repositories), and Granola (folders).
8. **Project-specific instructions, memory, or prompt context remain out of
   scope**, as in Projects non-goal 5. A linked folder is a resource, not a
   memory scope.
9. **Changing how default resources fan out to work streams is out of scope.**
   Propagation, Queue application, deduplication, and the rule that leaving a
   project does not remove already-attached resources stay as the Projects PRD
   specified them.

## Product behavior

### Where this lives

Two existing controls open one shared picker:

- Project space → **Default resources** → **Add resource**. Copy under the
  heading stays “Resources added here are attached to every work stream in this
  project.”
- Work-stream inspector rail → **Add resource**. Upload remains available here,
  as it is today.

The picker is a modal. It is not a new sidebar section, not a Settings page, and
not an agent elicitation.

### Source row

Across the top of the picker, a horizontal row of source chips:

1. **Rally** — already-known workspace resources the caller may see, plus
   **Upload file** on the work-stream instance of the picker (unchanged upload
   path). This is the inventory `GET /resources` already serves.
2. One chip per Connections catalogue entry the person can use, in the same
   order Settings uses: **Google Drive**, **GitHub**, **Granola**, **Linear**,
   **Notion**, **Slack**, and the others. The chip uses that source's existing
   brand mark, imported per [`using-company-brand-icons.md`](../../using-company-brand-icons.md).
   Google Drive is the **Google Drive + Docs + Sheets** preset, not Mail +
   Calendar; a workspace that only connected mail does not show a Drive chip as
   connected.

A chip is in one of three states:

- **Selected.** The list below is that source.
- **Connected.** The person (or the workspace, for a workspace connection they
  are allowed to use) has a non-disabled connection with the browse capability
  for that source.
- **Not connected.** The chip is visible. Activating it does not search; it
  offers **Connect {source}**, which starts the existing Connections OAuth flow
  for that preset. On success the picker selects that source and loads its
  browse view.

A source the current user cannot use — for example a workspace-only connection
they are not permitted to operate — does not appear as a live-browse chip. It
may still appear under **Rally** if inventory rows from it are visible to them.

### Search

A single search field sits under the source row. Its accessible name is
**Search {source}**. The placeholder names the selected source: **Search Google
Drive**, **Search Slack channels**, **Search repositories**, **Search Rally
resources**.

- **Rally selected.** The field filters `GET /resources?q=` as today. An
  empty query lists recent inventory. The empty state is **No matching
  resources** / **No resources yet**, with **Upload file** on the work-stream
  picker and **Add from connector** as a control that focuses the first
  connected source chip. It never says resources will “appear” from connected
  services.
- **A live source selected.** The field searches that provider through a
  person-facing browse endpoint on the regional Worker, using the caller's
  authorized connection. It does not start a work-stream run and does not
  appear as a plugin-activity row. An empty query lists the current folder (Drive)
  or the source's container list (Slack channels, GitHub repositories, Granola
  folders).

Search is scoped to the selected chip. There is no “search everything Rally
knows” mode.

### Browsing and selecting

**Google Drive.** The list is files and folders the connection can see. Folders
are visually distinct from files. Clicking a folder **opens** it and the
heading becomes a breadcrumb (My Drive / … / the folder). A row also has an
explicit **Add** control (and checkbox, on the project picker, which already
multi-selects). Adding the open folder itself is a button in the header:
**Add this folder**. Files add as `drive_file` / `google_doc` / `google_sheet`
according to the type the adapter already returns. Folders add as
`drive_folder`.

**Slack.** The list is channels the connection can see. Adding a channel creates
or reuses a `slack_channel` resource. Messages, threads, and files are not
browsed here; they remain attachable from inventory if Rally has already seen
them.

**GitHub.** The list is repositories the connection can see. Adding a
repository creates or reuses a `github_repository` resource. Files inside a
repository are not a tree in this picker.

**Granola.** The list is folders the connection can see. Adding one creates or
reuses a `granola_folder` resource.

Each row shows the object title, a small type label, and the provider mark.
Loading, next-page, and error states match the current work-stream picker:
a loading label, **Load more** when the provider returns a continuation, and an
inline error that leaves already-loaded rows in place. Offline, live browse is
disabled and the Rally inventory remains available if it was already loaded.

Confirming the selection:

- **Project picker.** **Add resources** resolves each selected provider object,
  then adds each as a project default. Already-default ids are skipped. The
  modal closes. The Default resources list shows the new titles. Fan-out to
  member work streams is the existing Queue path.
- **Work-stream picker.** Choosing a row attaches it immediately, as today, and
  the modal may stay open for another add.

A provider object Rally has already resolved is the existing resource. The
picker may show it in both **Rally** and the live source; adding it twice is
deduplicated by the canonical `(connection, provider, provider_resource_id)`
identity `resolve` already uses.

### What a linked folder means

A linked folder is one resource on the project (or work stream). The right rail
and `workstream_list_resources` show it as a folder, with its provider and
title. Rally does not expand it into one resource per child.

During a run, the folder's provider id is the search scope for that source. The
agent searches or lists inside it rather than asking the person where the folder
went. Children the agent actually reads become ordinary resources through the
existing hydrate/resolve paths, the same way they do today when a tool returns
them.

### Permission disclosure

When the chosen object comes from a **personal** connection, the picker warns
before adding:

**This {folder/file} is on your {source} account. Other people in the project
need their own access there to read it. Rally cannot grant it.**

The add still proceeds. Rally-side visibility still follows Projects: a resource
the rest of the project cannot see as a Rally object cannot become a default.
A Drive folder the linker can see and the rest of the project cannot see *on
Google* is still linkable; the warning is the product's statement of that
limit. A later run that fails on a missing Google grant surfaces the provider
error to the person, as the 2026-08-26 projects sync agreed, rather than failing
silently.

### Empty, loading, error

| State | What the picker shows |
| --- | --- |
| No connections at all | Source row with **Rally** and disconnected chips. Selecting a disconnected chip offers **Connect**. Body: **Connect a source to add files and folders to this project.** |
| Connected source, empty query, empty folder | **This folder is empty.** Breadcrumb still lets the person go up. |
| Connected source, query, no hits | **No matching results in {source}.** |
| Provider 401 after reconnect recovery fails | **Reconnect {source}**, which starts the existing reconnect flow. |
| Provider rate limit or timeout | Inline error; **Try again**. No agent turn is started as a fallback. |
| Flag off | Today's inventory-only picker, including its current empty copy, so a rollback is the previous product. |

## Impact on the product contract

None — this refines behavior within the existing contract. A work stream remains
the unit of conversation, resources, and execution. A project remains the
optional grouping that supplies default resources. Search introduced here is
source-scoped connector browse, not global Rally search, and does not add a
global inbox or activity feed.

The agent still uses typed, authorized tools. The picker is a person-facing
Worker API, not a new way for the model to grant itself access.

## Decision log

None yet.

## Key design decisions

1. **The picker talks to the provider; it does not run an agent.** The whole
   cost of the current workaround is an agent turn used as a file dialog.
   Browse and search are a regional REST endpoint that goes through
   `withAuthorizedConnection` and the adapter, the same door tools use, and
   they produce no transcript rows. Rejected: driving the picker by starting a
   hidden run, which would keep the latency and clutter this PRD exists to
   remove.
2. **A folder is a handle, not a snapshot of its children.** Materialising every
   child at link time would invent a Drive copy, go stale immediately, and
   collide with [resource versioning](../2026-08-27_resource-versioning/prd.md)'s
   re-fetch model. The folder resource is enough for persistence and for
   scoping later reads. Rejected: “add folder means attach all current files.”
3. **`drive.search` gains an optional parent folder id rather than a new list
   tool.** The adapter already notes that finding a folder without listing
   inside it is a dead end. A second `drive.list` tool would duplicate browse
   and teach the model two names for one provider call. The same parent filter
   is what the person-facing browse endpoint uses. Rejected: leaving the agent
   unable to use a linked folder, which would make goal 7 false.
4. **Live browse ships complete for Drive, Slack channels, GitHub repositories,
   and Granola folders in this PRD, not Drive-only with a fake source row.**
   The #product request named the row of sources as part of the experience. A
   chip that only filters inventory recreates the current bug under a new
   label. Sources without a container type (Gmail, Calendar, X) stay off the
   live row until a later PRD.
5. **Personal-connection warning, not a hard block.** The 2026-08-25 discussion
   wanted proactive permission checks where the provider allows them. Drive
   sharing is not something Rally can query completely for every project
   member's Google identity. Blocking the add would prevent the person who owns
   the folder from linking it at all. The warning tells the truth; a failed
   later read is visible.

## Data model

No new authority. WorkspaceDO already owns `resources` and
`project_default_resources`. Linking a never-seen provider object is
`resolveConnectorResource` followed by the existing default-resource or
work-stream attachment write.

Google's manifest `resourceTypes` today are
`gmail_thread`, `calendar_event`, `drive_file`, `google_doc`, `google_sheet`.
This change adds **`drive_folder`**. A Drive folder's `provider_resource_id` is
the Drive file id; its `canonical_url` is the folder's `webViewLink`. Resolve
rejects a folder typed as `drive_file`.

Slack channels, GitHub repositories, and Granola folders already have resource
types. The picker resolves those types; it does not add new ones for them.

No backfill. Folders Rally has never linked do not need rows. A Drive file
already stored as `drive_file` that is actually a folder is not rewritten in
this PRD; a future resolve of that id as `drive_folder` follows whatever
canonical-identity rule `resolveConnectorResource` already uses for type
mismatches, and any ambiguity is an implementation decision recorded in
[`assumptions.md`](../../assumptions.md) rather than a product fork.

## Regional impact

Browse and resolve run in the workspace's region, on that region's Worker,
against credentials already stored on that region's WorkspaceDO. Nothing
crosses the Global/EU boundary. A Drive listing is provider data in flight; it
is not written to D1 or to another region. Only the objects the person actually
adds become `resources` rows, as today.

EU workspaces keep using their EU Google app registration
([`provider-apps.md`](../../provider-apps.md)). The picker does not add a
hostname or a new OAuth client.

## Security and trust model

- The picker is a person-authenticated desktop call. It uses the caller's
  existing connection. It cannot use another member's personal Google
  connection. A work-stream participant still does not expose their personal
  connections by joining, per [`connectors.md`](../../connectors.md).
- Credentials are decrypted only for the browse/search call, through
  `withAuthorizedConnection`, and are not stored on the resource.
- The renderer never receives an access token. Browse results are titles, ids,
  types, and canonical URLs — the same shape `GET /resources` already returns.
- Connecting a disconnected chip reuses the existing OAuth deep-link flow;
  this PRD does not add a new redirect or a token in a query string.
- Provider listing payloads are untrusted. The Worker validates and bounds them
  the way `drive.search` already does before they reach the desktop.

## Agent behavior

This PRD changes one existing Google tool and the model-facing meaning of a
linked folder. It does not add a plugin, change plugin ids, or add a write
tool.

### Plugin contract

Unchanged. Canonical plugin id remains the connection's `connection:<uuid>`;
the model-facing name remains `plugin_google` (or `plugin_google_2`, …).
Loading the plugin still does not start a picker session, does not persist a
folder link, and does not authorize the desktop browse endpoint. Person-facing
browse is available whether or not a run has loaded the plugin.

### Tool catalog change

`drive.search` (`google_drive_search` on the wire for the first Google
connection) remains `drive.read`, `read`, `safe`. The only schema change is one
optional argument:

| Property | Required | Meaning |
| --- | --- | --- |
| `query` | optional | Unchanged. Plain text against names and indexed contents. Omit to browse. |
| `fileType` | optional | Unchanged, including `folder`. |
| `modifiedAfter` | optional | Unchanged. |
| `orderBy` | optional | Unchanged. |
| `maxResults` | optional | Unchanged, 1–100. |
| `pageToken` | optional | Unchanged. |
| `folderId` | optional | Drive file id of a folder. Results are restricted to **direct children** of that folder (`'{folderId}' in parents`). Not a Drive query expression. |

`additionalProperties` remains false. A `folderId` that is not a folder fails
as the existing `wrong_id_family` with `expected: "folder"` and the actual type,
and the model-visible sentence names `drive.search` with `fileType: "folder"`
as the way to find a folder id. A missing or unauthorized folder is the
provider's not-found/forbidden, recovered through `withProviderReauthorization`
exactly as today's Drive calls are.

Successful output is unchanged: the same bounded file list, including `id`,
`name`, `mimeType`, `webUrl`, and `parents`.

No other Google tool changes. `drive.get_metadata`, `drive.download`, and
`drive.export` still take a file id and still refuse a folder as
`wrong_id_family` where they already do. There is still no tool whose job is
“read a folder as a document”; listing children *is* the read.

### Discovery and sequencing

The folder id for `folderId` comes from, in order a small model can follow:

1. `workstream_list_resources` — a linked `drive_folder` row carries the
   provider id.
2. `drive.search` with `fileType: "folder"` and no `folderId`, which is how a
   run finds a folder that is not yet linked.
3. Never from guessing, from a document id, or from a URL the model invented.

A common sequence after this PRD: list resources → see the project-linked
Drive folder → `drive.search` with that `folderId` (and optional `query`) →
`docs.read_document` / `drive.download` on a child. The person-facing picker is
not in this sequence.

### What loading and linking do not do

Attaching a `drive_folder` does not load the Google plugin, does not start a
watch, and does not hydrate children. The first run in a work stream that
inherited the folder still has to `load_plugin` to search inside it, the same
way it does for any Google resource. What it must not do is search the whole
Drive for the folder's name.

### Prompt guidance

The Google plugin's high-salience guidance gains one clause: when
`workstream_list_resources` lists a `drive_folder`, search and browse inside it
with `drive.search` and `folderId` set to that folder; do not rediscover the
folder by name. The person-facing picker is not mentioned to the model.

### Failure and self-healing

| Failure | Model-visible next action |
| --- | --- |
| `folderId` names a Doc/Sheet/file | `wrong_id_family`. Search with `fileType: "folder"` or use the linked folder's id from `workstream_list_resources`. |
| `folderId` omitted and the work stream already has a linked folder | Not an error. Prompt guidance is what prevents the wasted workspace-wide search. |
| Provider 403 on a linked folder | The connection cannot read that folder. Tell the person. Do not invent a different folder id. |

### Authority, safety, lifecycle

`folderId` is model-supplied and authorized only as “this connection can read
this Drive id,” the same as `fileId` on `drive.get_metadata`. It is not a Rally
resource id and is not a grant to another connection. Cancellation, timeout,
truncation, and replay are unchanged from today's `drive.search`.

### Next-step outputs

Each hit still returns the Drive file id and `webUrl` a follow-up read needs.
A folder hit in a `fileType: "folder"` search is a legal `folderId` for a
subsequent call. Linked folders also appear in `workstream_list_resources`
with their provider id.

### Model-usability acceptance

Schema snapshot tests cover `folderId` optional, forbidden unknown fields, and
`wrong_id_family` when the id is not a folder. Prompt/tool evaluations on the
configured medium fallback model cover: (1) a work stream with a linked
`drive_folder` leads to `drive.search` with that `folderId` rather than a name
search; (2) a missing folder id with `fileType: "folder"` still works; (3) a
Doc id passed as `folderId` fails recoverably; (4) no loop of workspace-wide
searches after the folder is already in the resource list.

## Provider configuration

No new Google, Slack, GitHub, or Granola app settings. Drive browse uses the
existing Drive read grant on the **Google Drive + Docs + Sheets** preset. A
connection that lacks `drive.read` cannot select the Drive chip as connected.
Slack channel listing, GitHub repository listing, and Granola folder listing
use the grants those Connections already require for their matching agent
tools.

## Rollout

The person-facing picker is a fail-closed client feature flag, registered in
`client-feature-flags.ts` per [`feature-flags.md`](../../feature-flags.md). Off
(the default, and the Flagship-outage default) keeps today's inventory-only
modals. On, both the project-space and work-stream pickers use the shared
source-row picker.

`drive.search`'s `folderId` argument can ship independently of the flag: an
unused optional field does not change current successful calls. The prompt
clause that tells the model to prefer a linked folder ships with the resource
type, not behind the desktop flag.

Turning the flag off after it has been on leaves already-linked `drive_folder`
defaults in place; only the picker reverts. Runs can still search inside those
folders.

## Acceptance

1. A person with Google Drive connected, on a project with no defaults, opens
   **Add resource**, sees **Google Drive** in the source row, browses to a
   folder they have never attached in Rally, and adds it. The Default
   resources list shows the folder. A new work stream in that project lists
   that folder in the inspector rail before the first send.
2. Repeating the add of the same folder does not create a second resource or a
   second default.
3. From a work stream in that project, the agent (medium fallback) searches
   inside the folder with `folderId` and does not first search Drive for the
   folder's name.
4. A person with no Drive connection sees the Drive chip disconnected, connects
   through the existing OAuth flow from the picker, and lands on a live Drive
   listing without leaving the modal to Settings.
5. A personal Drive folder add shows the access warning and still adds.
6. Slack / GitHub / Granola chips list channels, repositories, and folders live,
   and adding one persists as the matching existing resource type.
7. With the flag off, both pickers match today's inventory-only behavior,
   including the work-stream empty copy.
8. Keyboard: source chips, search, folder open, **Add this folder**, and confirm
   are reachable without a pointer. The Drive breadcrumb is a named navigation
   path.

## Open questions

1. **Should the Drive chip use a workspace Drive connection when both a personal
   and a workspace Drive connection exist?** Using personal matches “my folder.”
   Using workspace matches “the company's Drive.” The answer changes which
   files the picker lists and whose OAuth grant later runs execute as. This
   does not block Drive-personal, which is the reported job; it does block
   shipping a silent picker when both connections exist. Default proposal:
   prefer the personal connection the caller owns, and offer a switch when a
   workspace Drive connection is also usable.
2. **Does **Add this folder** also select currently listed children?** Goal 6
   says no. Confirming that with the requester is cheap and would reverse
   decision 2 if they wanted a one-shot snapshot.
3. **Are Linear project/team containers and Notion databases in the first live
   row, or do they wait?** Goal 3 shows them as chips; goal 7's first complete
   live-browse list omitted them. If they ship as inventory-only chips they
   violate decision 4. Prefer: live-browse those containers in the same change
   if the adapters already list them for the agent; otherwise omit the chip
   until they can.
