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
publications with exactly one `canvas_artifacts` location use that location.
References do not create a second owner. Sites keep their artifact UUID;
new file hosts use the resource UUID. File links use the existing hostname
allocator and route directory, with no change to routing.

`sharing_revision` fences concurrent modal/MCP edits, including changes made by
guest claims or access approvals. Older API clients may omit the fence and the
artifact fields; omitted artifact settings are preserved. A supplied artifact
recipient list replaces that audience. Both policies commit in one transaction.

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

An absent initial projection returns 503. An archived Canvas returns 404.
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

WorkspaceDO migration 147 schedules initial propagation for existing Canvases.
Both existing and new Canvases default artifact access to editors. Previously
public website URLs therefore require editor access until a manager explicitly
sets public artifact access. Hosts fail closed while their first snapshot is
pending. Deploy serving and API changes together; source migrations run when
objects initialize, and cold Organizations must be woken through the existing
forced-migration mechanism before their source outboxes can deliver snapshots.

## Testing

`test-workers/canvas-artifact-access.test.ts` exercises actual WorkspaceDO and
ArtifactHostDO migrations, source policy, durable outbox, background delivery,
file/site serving, artifact-only users, retained cookies, stale snapshots,
archive tombstones, membership delivery and concurrent saves. Serving also runs
with the product membership table removed after propagation. MCP tests exercise
both sharing fields, legacy omission and stable link retrieval.

## Changelog

### 2026-11-11 — Canvas-owned artifact audiences with local serving admission

**What changed:** Separate editor and artifact-use audiences propagate through
the existing access Queue as versioned snapshots. Every published output uses
local admission and sessions identify viewers without retaining old permissions.
The production modal and user-facing MCP expose both audiences.

**Why:** Public artifacts need a wider audience than the people allowed to
change them. Per-request source-authority calls were rejected because serving
must stay local; realistic eventual consistency allows durable Queue delivery.
Routing is intentionally unchanged. Delayed and duplicate updates must never
restore old access, and missing projections must never expose content.
