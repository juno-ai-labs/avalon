# Canvas artifact access

A Canvas owns two audiences: editors can read and converse in its Chat and
change its artifacts; artifact users can open and interact with its published
outputs. Editors always have artifact access. Artifact access never grants
conversation access. This module owns the serving projection and propagation;
[Canvases](canvases.md) owns the parent and editor audience,
[live web artifacts](live-web-artifacts.md) owns website execution, and
[access revocation](access-revocation.md) owns identity/session retractions.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/artifact-access.ts` | Versioned snapshots, queue messages, file publication references and stable link response. |
| `packages/contracts/src/canvases.ts` | The two audience settings and optional concurrent-save revision. |
| `apps/api/src/durable-objects/canvas-artifact-access.ts` | Source schema, transactional retry triggers, effective audience compilation and publication discovery. |
| `apps/api/src/durable-objects/hosted-canvas.ts` | Atomic sharing mutations and manager authorization. |
| `apps/api/src/durable-objects/workspace-do.ts` | Source RPCs, membership bootstrap and durable outbox alarm dispatch. |
| `apps/api/src/queues/access-revocation-consumer.ts` | Address-only queue fan-out and full-snapshot delivery. |
| `apps/api/src/durable-objects/artifact-host-do.ts` | Local snapshot, session identity, monotonic application and per-request admission. |
| `apps/api/src/artifacts/index.ts` | The shared gate for website routes, assets and published file bytes. |
| `apps/desktop/src/renderer/components/canvas-share-dialog.tsx` | Production modal adapter and atomic Save of both audiences. |
| `apps/mcp/src/server.ts` | User-facing sharing fields and `get_artifact_link`. |
| `apps/api/src/services/canvas-artifact-audience-tool.ts` | `set_artifact_audience`: a Canvas's Chat sets its own artifact audience as its person. |

## How it works

### Source policy and ownership

`canvas_directory.visibility` and `canvas_participants` remain the editor
policy. `artifact_visibility` is `editors`, `participants`, `workspace` or
`public`; `canvas_artifact_users` holds explicitly selected artifact users.
Organization scope includes active full members and explicitly selected guests.
The editor predicate retains creator, administrator and writer-Sidekick access.
Named artifact users must already have an active Organization relationship.
The existing guest-email invitation grants editor access and is labeled as such;
selecting a guest in the artifact picker grants no editor rights.

A generated resource's `publication_parent_id` is its owning Canvas. Older
publications use their site registry's Canvas owner when available (backfilled
by migration 147), otherwise a single `canvas_artifacts` location. Ambiguous
legacy placements retain attachment-based reads and search until republished
with an explicit owner; references do not acquire a new artifact audience.
Sites keep their artifact UUID;
new file hosts use the resource UUID. Internal Terminal command logs and
checkout backups remain conversation attachments, not Canvas artifact
publications. Migration 147 clears the historical command-log owner column;
their bytes and conversation links are retained. File links use the existing hostname
allocator and route directory, with no change to routing.

`sharing_revision` fences concurrent modal/MCP edits, including changes made by
guest claims or access approvals. Older API clients may omit the fence and the
artifact fields; omitted artifact settings are preserved. A supplied artifact
recipient list replaces that audience. Both policies commit in one transaction.
The MCP tool requires `userIds` explicitly even for artifact-only changes;
clients preserve editors by copying the current `participantUserIds`.
A Canvas's Chat sets the artifact audience with `set_artifact_audience`, as
its person and under Share's manager rule; it changes `artifact_visibility`
alone and never names people. `artifact_visibility_chosen` (migration 148)
records that someone set it: Share saves that send an artifact audience, and
every tool call, mark it, and every Canvas that existed before the migration
counts as chosen. An agent's default (`personAsked: false`) changes only an
unchosen audience, because the audience covers every artifact the Canvas has
published and a later site must not reopen one a manager restricted. Sidekick
runs do not get the tool, and the external MCP sharing tool is not available
to internal agents.

Each generated artifact's card in the Chat also changes `artifact_visibility`
from a menu (`apps/desktop/src/renderer/screens/canvas.tsx`): it resends the
editor audience unchanged, keeps the selected artifact users only for
`workspace`, and sends the same `expectedRevision`. Choosing specific people
opens the Share modal, which owns the person picker.

The Share modal shows the most recently updated artifact's stable link. A link
lookup can fail while publication is still propagating. The modal retains a
loading/retry control so a manager can retrieve the link without closing Share
or losing audience edits.

### Durable propagation

`canvas_artifact_access_state` holds a monotonic projection revision per Canvas.
SQLite triggers increment it and write a `canvas_artifact_access` entry into the
existing `_internal_durable_alarms` outbox in the same source transaction. Inputs
include policy changes, participants, artifact users, publication changes,
membership/role delivery and writer-Sidekick audience changes.

The alarm publishes `canvas_artifact_access_changed` on
`ACCESS_REVOCATION_QUEUE`. It settles only after Queue acceptance. Its due instant
advances when another source mutation arrives, so an older dispatch cannot erase
a newer retry intent. The existing scheduler owns retry and process-cancellation
recovery; no fire-and-forget promise is the only durable record.

The root consumer discovers publications and sends an `artifact_access_sync`
message per artifact. Bodies contain only addresses, avoiding the Queue's 128 KiB
limit for large audiences. Each child consumer fetches the current complete
snapshot from WorkspaceDO, verifies the target still belongs to that Canvas,
and applies it to the artifact host. A consumer failure retries that hop.
Duplicate fan-out and out-of-order delivery are harmless.

The source snapshot compiles editors and artifact users into user IDs plus
membership incarnations, and carries public/archive state and a revision.
Older Organizations bootstrap their sparse local membership directory once from
D1 during background delivery. Thereafter the existing relationship events keep
it current. These background reads/calls are absent from artifact serving.

File delivery also records the published version references in the host and
registers its existing-format hostname. Bytes stay in the payload bucket;
there is no second copy of the file. Source policy and file references are read
together before yielding, and file application requires that exact policy
revision. A delayed file delivery cannot expose newer bytes under older policy.
Site publication initializes the current source snapshot before advancing the
served version; subsequent audience changes continue through the Queue.

### Serving and identity

Every content request goes through `ArtifactHostDO.admitRequest`. The host reads
its local SQLite snapshot and local session record. A session establishes an
identity and membership incarnation; it is not an enduring access grant. The
current snapshot decides each request, including anonymous public requests.
No cross-DO or product D1 authorization call is made while serving. The existing
platform D1 hostname lookup remains unchanged.
Successful site admission also carries the locally stored owning Organization
ID into the app's scoped Sidekick invocation binding.

An absent initial projection on a new host returns 503. Migration 4 seeds only
already-published hosts with their historical public reach at revision 1;
source snapshots start at revision 2 and supersede that bootstrap. This is a
one-time migration, never a public fallback when an authority fails. An archived Canvas returns 404.
Unsigned visitors to restricted content receive 401 (or the existing browser
sign-in handoff for page navigation); an identified but unauthorized visitor
receives 403. Authority failure never falls back to public serving. Existing
fetch-metadata and credential-stripping rules remain in force.

The gate covers files, images, PDFs, archives, static sites, active site routes,
assets and app submissions. Site code may restrict app actions or individual
rows further but cannot admit visitors denied by the platform. Historical
versions consult the current snapshot; history browsing and internal model
representations, error logs and bulk data inspection require editor access.
Resource API reads and search use the owning Canvas's artifact policy rather
than uploader or unrelated-attachment shortcuts. Search has a separate artifact
reader group, so artifact users never acquire the conversation's group.
Full members can discover public Canvas outputs in Organization search; guests
need editor access or explicit artifact selection to discover them. A public
link by itself does not advertise unrelated Canvases to guests. Interactive
reads evaluate only the requester. Complete audience compilation runs only for
propagation; hosts cache the validated audience and an indexed in-memory reader
map, invalidated against the stored revision on each admission.

Snapshots apply only at higher revisions and must retain the same Workspace and
Canvas owner. Archive tombstones cannot be reopened by a delayed access update
or publication. Existing session/membership revocation delivery still retracts
identity sessions independently.
Legacy viewer cookies without a membership incarnation are treated as signed
out, allowing the existing sign-in handoff to create a current identity.

## Invariants

- The Canvas owns both audiences. Copying independently editable ACLs into hosts
  would let them drift; complete monotonic snapshots are the only host input.
- Policy changes and retry intents commit together. Losing the outbox could
  leave a revoked public site exposed indefinitely. Runtime tests read the
  transactional alarm intent and exercise its dispatch.
- Every content path passes local admission. Skipping assets or file downloads
  would expose content even when the main page refuses access; file/site runtime
  requests cover the shared gate.
- A viewer session is identity, not permission. Retaining its old grant would
  let cookies outlive narrowing; runtime tests remove a reader without deleting
  the cookie and assert the next request fails.
- Revisions and owner identity fence projection application. Accepting stale or
  wrong-owner snapshots could reopen content; runtime tests deliver both.

## Boundary

WorkspaceDO owns source policy, effective readers and durable dispatch. Artifact
hosts own replaceable serving projections and identity sessions. Only trusted
queue consumers apply projections; HTTP visitors cannot supply identity headers,
policy revisions or publication references. The serving Worker retains only its
existing routing D1 binding, artifact namespace and payload access. It does not
receive the product DB or WorkspaceDO namespace. Application-level row rules
remain the generated application's responsibility. Identity revocation remains
owned by [access revocation](access-revocation.md).

## Failure modes and limits

Save acknowledges the source transaction, not every serving host. Each host
adopts the policy when its queue delivery completes. Requests admitted before
that application can finish. Open pages become subject to the new policy on
their next network request; previously downloaded content and local computation
cannot be withdrawn. HTTP responses remain `private, no-store` so shared caches
cannot bypass the gate.

WorkspaceDO migration 147 schedules initial propagation for existing Canvases
and preserves public access for Canvases with existing registered publications.
Only new Canvases default artifact access to editors. ArtifactHostDO migration
4 preserves existing published sites' public reach locally, so cold Organizations
do not require a source wake to keep serving. Hosts created after migration
remain closed until policy arrives. Existing hosts without a Canvas owner retain
their historical public bootstrap; new publication requires an owning Canvas and
checks that before writing publication state.

A real membership change invalidates every Canvas because role changes can
affect editor access everywhere. This costs one root delivery per Canvas plus
one child per artifact, and each child compiles the latest audience. Negative
membership-cache placeholders and timestamp-only resource touches do not trigger
this fan-out. Queue failures remain visible through the existing retry and
dead-letter mechanisms.

## Testing

`test-workers/canvas-artifact-access.test.ts` exercises actual WorkspaceDO and
ArtifactHostDO migrations, source policy, durable outbox, background delivery,
file/site serving, artifact-only users, retained cookies, stale snapshots,
archive tombstones, membership delivery and concurrent saves. Serving also runs
with the product membership table removed after propagation. `test-workers/canvas-artifact-access-migration.test.ts` upgrades populated
WorkspaceDO 146 and ArtifactHostDO 3 fixtures in separate events, proving retained
publications, legacy-only public bootstrap, editor defaults for new Canvases,
initial propagation intents and retained null-incarnation sessions. MCP tests
exercise both sharing fields, legacy omission and stable link retrieval.
They also reject a missing editor list before any API update. The desktop's
`screens/canvas.test.tsx` covers retrying a delayed artifact link in the open
modal while preserving its audience draft. `canvas-artifact-access.test.ts` also
drives `set_artifact_audience`: an editor who does not manage the Canvas is
refused, a manager's default serves anonymous visitors without touching the
editor audience, and a default after a Share save leaves the restriction in
place while a call the person asked for changes it. The migration test proves
existing Canvases count as chosen and new ones do not.

## Changelog

### 2026-11-12 — Publishing agents set the artifact audience

**What changed:** A Canvas's Chat gained `set_artifact_audience`, which changes
only `artifact_visibility` as the person typing, under the Share screen's
manager rule. Migration 148 adds `artifact_visibility_chosen`; an agent's
default changes only an audience nobody has chosen. The site skills tell the
agent to choose the most open audience the Canvas's artifacts allow, public by
default, and to ask at the end whether the person wants it changed.

**Why:** New Canvases start with editors-only artifact access, so a site an
agent built for the public stayed private until a manager found Share, and
nothing in the run could fix it. Product decided sites default to public.
Changing the Canvas default was rejected because it would open every Canvas,
including those that publish nothing anyone meant to share; resending the full
`setAudience` update from the tool was rejected because a tool that must echo
the editor list and named recipients can clear them on a stale read. Letting
every publish apply the default was rejected in review: the audience covers
the whole Canvas, so a sign-up page would have reopened a memo a manager had
restricted. Existing Canvases count as chosen because nothing stored says
whether their audience was deliberate. A future change must keep the tool
narrower than Share: no editor changes, no named people, no access for a run
that does not act as a manager, and no default over a chosen audience.

### 2026-11-11 — Canvas-owned artifact audiences with local serving admission

**What changed:** Separate editor and artifact-use audiences propagate through
the existing access Queue as versioned snapshots. Every published output uses
local admission and sessions identify viewers without retaining old permissions.
The production modal and user-facing MCP expose both audiences.

**Why:** Public artifacts need a wider audience than the people allowed to
change them. Per-request source-authority calls were rejected because serving
must stay local; realistic eventual consistency allows durable Queue delivery.
Routing is intentionally unchanged. Delayed and duplicate updates must never
restore old access, and new hosts without projections must never expose content. Existing published
sites retain their prior public reach through a one-time bootstrap to avoid a
deploy-time outage; the source policy supersedes it monotonically.
