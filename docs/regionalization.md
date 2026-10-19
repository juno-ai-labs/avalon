# Deployment regions

A region is a configured Rally deployment and storage boundary. It is an
internal identifier, independent of geographical placement. Global is the only
configured deployment. Future enterprise deployments reuse the same mechanism;
this change does not provision them or add an enterprise management service.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `config/regions.json` | Configured identifiers, endpoints, binding prefixes, and physical placement. |
| `packages/contracts/src/regions.ts` | Shared identifier schema and configuration lookup. |
| `apps/api/src/lib/regional-bindings.ts` | Typed access to existing private bridge bindings. |
| `apps/api/src/services/platform-onboarding-service.ts` | Global identity, discovery, activation, and workspace creation. |
| `apps/api/src/lib/durable-object-namespace.ts` | Existing object namespace and placement resolution. |
| `apps/api/wrangler.global.jsonc` | Infrastructure bindings and resource identities. |
| `scripts/regions.mjs` | The same configuration for local and operational scripts. |

## How it works

Global remains the identity endpoint and ordinary workspace-creation destination.
Users choose a workspace, not a geographical region. The workspace's region stays
in its session, routing records, links, provider OAuth state, and background
messages, including a scoped invitation's emailed link, which is the
conversation's addressed path. An email-only identity does not cross
deployments, so if a second deployment serves Organizations, that link's
sign-in has to happen there ([`scope-invitations.md`](scope-invitations.md)). It does not change when a client switches workspaces.

Discovery visits configured deployments through the existing named RPC bridges.
The browser client opens other deployments over the same bridge
([`browser-client.md`](browser-client.md#other-deployments)).
Provider ingresses use their existing opaque route directories to select a
configured binding. Product repositories continue using the deployment's bound
storage. Configuration lookup replaces special cases; it does not add an
additional authentication or authorization system.

`bindingPrefix` names deployment bindings. API-to-deployment bridges use
`REGION_<prefix>_<capability>_BRIDGE`; administrative and dedicated ingress
bindings keep their existing `<prefix>_<capability>` convention. Global's
existing bindings and resources retain their names.

Physical placement is separate configuration: jurisdiction, initial affinities,
and the longitude split used to select from a west/east affinity pair at creation. Global retains
its current jurisdiction and persisted placement. Changing placement is not a
method for relocating an existing object hierarchy. The application validates the
region/affinity pairing against configuration; SQLite preserves placement immutability
without embedding a second copy of deployment configuration.

The per-isolate workspace placement cache holds only successfully resolved
affinity strings. In-flight D1 reads belong to their initiating request and
must never be shared through module scope: if that request is cancelled, its
promise can remain unresolved and block unrelated requests that reuse it.
Concurrent cold lookups perform their own reads; later lookups reuse the
immutable value. Raced completions for one key consume one slot and evict at
most one warm entry. Failed reads and local development fallbacks are not cached.

## Invariants

- Existing Global resource and object identities remain unchanged so a release
  opens the same stored data.
- Workspace region remains immutable. Switching a workspace selects its existing
  credential and endpoint.
- An unconfigured destination is unavailable; its records are not reassigned.
- Existing lower-level authentication, membership checks, and typed RPC contracts
  remain responsible for access control.
- **Exception: GitHub delivery bytes rest in Global before they are routed.**
  The shared GitHub receiver runs in Global and queues each verified delivery on
  Global's activity Queue; a body too large for a message is staged in Global's
  `PAYLOADS` under `global/github-ingress/`. The consumer deletes it once every
  connected deployment has taken the delivery (or none has the installation),
  and the receiver deletes it if the message could not be sent. A message that
  exhausts its retries leaves its body there, and so does a failed cleanup
  delete, so for a delivery bound for another deployment that deployment's
  GitHub content stays in Global until an operator clears it
  ([runbook](runbook.md#github-delivery-dead-letters)). No lifecycle rule
  expires that prefix yet; its age is a decision still to be made. Adding a
  second deployment has to accept this or move the consumer
  ([`connectors.md`](connectors.md#github-app)).

## Boundary

Wrangler files remain the source of truth for infrastructure. The region map is
not a resource provisioner or a deployment generator. Adding a deployment
requires configuration, resource provisioning, and the corresponding bindings;
application routing should not need another region-specific branch.

Enterprise assignment is an operator concern. A new provisioning API and moving
existing workspaces between deployments are outside this change.

## Failure modes and limits

Actionable onboarding requests validate configured membership; persisted identifiers
remain representable after retirement. Missing configuration or a required bridge
makes that destination unavailable.
Existing service error handling, delivery receipts, and retry behavior apply.
This mechanism introduces no new limits or approval flows.

## Testing

Existing routing tests use a synthetic enterprise deployment to exercise the
same code with another identifier. Schema tests apply forward migrations and
check row preservation. Local startup and ordinary smoke checks run Global.
Visible onboarding changes are inspected in Electron.

## Operations

Deployment workflows and the desktop release planner include the shared region map
as an input, so configuration-only edits are shipped.

Use the configured region list for local startup and health checks. Preserve
resource IDs when editing Wrangler configuration. Retirement stops a workspace's
activity but retains its rows; removing a deployment requires a separate,
explicit cleanup of its owned infrastructure and external resources.

### 2026-10-19 — Cache routing values after the request-owned read completes

A thread creation stopped after reserving its D1 create receipt, while resolving
its Organization's placement. The cache held pending D1 promises, letting a
later request inherit the initiating request's cancelled I/O and wait forever.
The cache now stores only resolved immutable affinities. Sharing cold reads
was rejected because saving one lookup cannot justify coupling independent
request lifetimes; keep both in-flight promises and failure fallbacks out of
this cache. Creation retries must retain the original thread and client-message
IDs so a reserved request can finish without duplicating the thread.

### 2026-09-14 — Keep deployment isolation without a geographical product choice

The product now has one configured deployment and no region picker. Endpoint and
bridge selection use a small region configuration instead of a fixed pair of
geographical branches. Workspace and session region fields remain in place so
enterprise isolation can reuse the existing routing mechanism. Global object
identities and physical placement are preserved. A deployment generator and
enterprise provisioning API were excluded because neither is needed for this
removal.
