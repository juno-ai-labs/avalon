# Ace internal administration

Ace is Avalon's internal administration Worker at
`https://ace.internal.rallywith.ai`. Its first surface manages the four
user-facing Boolean product flags in Cloudflare Flagship. It is intentionally a
skeleton: new internal tools extend the same Hono application and Ace-owned
component library instead of creating another operator site or visual language.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `apps/ace/src/index.ts` | Hono routes, Access admission, same-origin writes, and static assets. |
| `apps/ace/src/access.ts` | Reuses the migration tracker's signed Cloudflare Access assertion verifier. |
| `apps/ace/src/protocol.ts` | The managed flags, safe targeting attributes, all Flagship operators, and Flagship's request limits. |
| `apps/ace/src/directory.ts` | Read-only user and workspace search across both regional D1 databases. |
| `apps/ace/src/flagship.ts` | Flagship reads and writes plus the post-write change notification. |
| `apps/ace/src/queues.ts` | Account-wide workspace enumeration and regional fan-out. |
| `apps/ace/src/client/components/ui.tsx` | Ace's shared controls and panels; future pages extend these components. |
| `apps/ace/src/client/main.tsx`, `styles.css` | Feature-flag application and responsive visual system. |
| `apps/ace/scripts/deploy.mjs` | Idempotent Access, flag, Worker, asset, and secret provisioning. |
| `.github/workflows/deploy-ace.yml` | The complete merge-to-main release transaction. |

## How it works

Cloudflare Access runs before Ace. The Worker independently verifies the signed
`Cf-Access-Jwt-Assertion`, including issuer and Ace's application audience, then
trusts the verified identity. The deploy script creates or updates an
Ace-specific Access application by copying the migration site's policies and
identity-provider settings. Ace therefore follows the same employee rule while
keeping a distinct audience.

`GET /api/flags` reads only `hypersight-enabled`,
`meeting-recording-enabled`, `suggested-work-enabled`, and
`automation-workspace-templates-enabled`. The editor exposes enabled/paused state, default
Boolean value, ordered first-match rules, all eleven operators, nested AND/OR
groups, and sticky percentage rollouts. A person search accepts name or full
email but writes the stable `userPlatformId`; a workspace search accepts name or
slug but writes its opaque `workspaceId`. Exact email targeting therefore works
without storing an address in Flagship. Domains, workspace role, region, age,
member count, slug, and application environment use the same attributes the API
already evaluates.

After Flagship accepts a PUT, Ace places only the flag key on
`avalon-product-feature-flag-changes` after Flagship's documented
[up-to-30-second propagation window](https://developers.cloudflare.com/flagship/concepts/).
Its
consumer keyset-pages every workspace from Global and EU D1, then sends one
key-and-workspace message to the owning regional queue. The regional API
consumer RPCs to that workspace's `WorkspaceDO`. The object evaluates the
complete client flag contract per connected user and privately sends the values
to that user's sockets. A subscribe response performs the same evaluation, so
reconnect is the reconciliation path.

## Invariants

- Product Boolean names end in **Enabled**, and their keys end in `-enabled`, so
  `true` has one unambiguous meaning in Flagship, Ace, logs, and client code.
- The product features default to false in the shared client schema. No network
  response, stale cache, missing field, Flagship error, or older API enables one.
- The account-wide and regional Queue messages never carry a flag value. Values
  are user-specific and are evaluated in the owning WorkspaceDO after Flagship
  propagation; carrying one value would leak one audience's answer to another.
- A pushed value is private to sockets belonging to the evaluated user. It
  never rides a workspace-wide broadcast or durable waterline.
- Full email addresses and names may be used to search D1 but never become
  Flagship attributes. Breaking this sends personal data to the global
  targeting plane on every evaluation.
- Ace is the write authority for its managed product flags. Direct dashboard or
  Wrangler edits do not emit Avalon's Queue notification and leave connected
  clients stale until reconnect.
- Access policy lives in Cloudflare Access. Ace verifies provenance and does not
  duplicate an employee-domain allowlist in application code.

## Boundary

Ace owns internal administration UI and the write workflow for its explicit
managed-flag allowlist. Flagship owns flag configuration, evaluation, and its
changelog. Regional D1 owns identity, membership, and workspace lookup data;
Ace reads it directly and writes none of it. Regional API Workers own their
Durable Object namespaces and the socket protocol.

Ace does not manage agent-model flags or the Control Tower cadence. Those retain
their existing operational paths in [`feature-flags.md`](feature-flags.md).
Adding a new Ace page does not automatically grant it a new Cloudflare API
capability; its route, environment type, credential, and component reuse must be
reviewed as a new boundary.

## Failure modes and limits

- Missing or invalid Access configuration returns 403. The development bypass
  works only with `APP_ENV=development` and `ACE_DEV_AUTH=true`.
- A cross-origin mutation returns 403 before parsing or contacting Flagship.
- A Flagship write failure returns an error and sends no notification. A Queue
  send failure fails the request after Flagship has changed; retrying the same
  save is safe and repairs notification.
- Fan-out and regional delivery are at-least-once. Re-evaluation and socket
  replacement are idempotent, so duplicates cost work but do not change the
  answer.
- Malformed Queue messages are acknowledged as poison; transient D1, Queue, RPC,
  and Flagship failures retry and eventually reach the configured dead-letter
  queue.
- Condition strings are at most 256 characters, descriptions 512 characters,
  nesting is at most five groups, and rollout percentages are 0 through 100.
  The string, description, and nesting limits come from
  [Flagship's platform limits](https://developers.cloudflare.com/flagship/reference/limits/),
  not Ace-chosen defensive bounds.

## Testing

`pnpm --filter @avalon/ace test` covers Access failure, same-origin mutation,
the exact Flagship-and-Queue write contract, the safe attribute vocabulary,
operators, nesting, and regional fan-out. `pnpm --filter @avalon/ace typecheck`
checks both browser and Worker programs; `pnpm --filter @avalon/ace build`
builds the Vite client and performs a Wrangler dry run. API workerd tests cover
the real Queue dispatch and Durable Object WebSocket behavior. Desktop tests
cover the fail-closed product gates and live socket cache replacement.

The Flagship binding is not locally emulated. Tests use a double only for the
external Flagship management and evaluation APIs; D1, Queue dispatch, Durable
Object storage, RPC, and WebSockets use the workerd suite where their runtime
behavior matters.

Ace deliberately has no live local-backend command: a partial Worker without
its two D1 bindings, Queues, Access audience, and Flagship credentials is a
misleading approximation that can accidentally write the shared control plane.
Use the tests and dry-run build for backend changes; use explicit browser
fixtures when visually exercising the component library.

## Regional impact

There is one Ace Worker and one Flagship application for both regions. For an
Access-authorized operator's directory search, Ace reads each regional D1
directly and transiently returns matching names, full email addresses, slugs,
and opaque IDs to that operator's browser. Those lookup fields therefore cross
the EU data-plane boundary into the shared Ace runtime; Ace does not persist
them or write them to Flagship. Fan-out sends only opaque workspace IDs and flag
keys to regional queues, and each regional API alone resolves its Durable
Object namespace. Workspace content, memberships, sockets, and effective flag
values do not cross through Ace. The separately approved Flagship attributes do
cross to the one global evaluation service as documented in
[`feature-flags.md`](feature-flags.md#what-may-become-an-attribute).

## Security and trust model

Ace treats request headers, URL parameters, JSON, directory queries, Flagship
responses, and Queue bodies as untrusted. Cloudflare Access is identity-aware
admission, but the Worker still verifies the signed assertion and its audience.
Mutations require same origin and a fixed managed-key schema.

The deployment credential stays in GitHub Actions. Ace receives a separate
encrypted `CLOUDFLARE_FLAGSHIP_API_TOKEN` secret whose account permission is
Flagship Write only. That credential can change flags but cannot deploy Workers,
change Access policy, read D1, or administer the account. No token is compiled
into the Vite bundle or stored as a Worker variable.

## Operations

A merge to `main` touching Ace or its shared contracts starts
`deploy-ace.yml`. The workflow validates the repository, creates all declared
Queues, clones the migration Access policy, ensures all Enabled-named flags
exist off by default, injects Ace's returned Access audience, deploys the Hono
Worker and assets, installs the dedicated Flagship token as an encrypted secret,
and verifies an unauthenticated request is redirected by Access. The API deploy
and signed desktop release start from their existing `packages/**` and
`apps/desktop/**` triggers in the same merge. There is no per-release manual
command or dashboard step.

The `api-production` GitHub environment must hold the existing
`CLOUDFLARE_ACCOUNT_ID` variable, deployment `CLOUDFLARE_API_TOKEN`, and
Flagship-only `ACE_FLAGSHIP_API_TOKEN`. The deployment token needs Access Apps
and Policies Write in addition to the existing Worker, Queue, D1-binding, and
route permissions. Only `ACE_FLAGSHIP_API_TOKEN` needs Flagship read/write.
These are one-time environment prerequisites, not values committed to the
repository; once present, releases have no per-merge manual step.

When a save succeeds but clients do not change, inspect in order:

1. Flagship's changelog for the enabled-named key.
2. `avalon-product-feature-flag-changes-dead-letter`.
3. The matching regional product-feature-flag dead-letter queue.
4. `product_feature_flag_fanout_failed` and `client_flag_unresolved` logs.
5. A reconnect, which must receive current values on the private subscribe
   response even if a live notification was lost.

## Changelog

### 2026-08-24 — Review hardens live delivery and records Ace's regional exception

**What changed:** Initial desktop reads now fetch immediately despite their
fail-closed render seed; every Electron surface defaults managed Booleans off;
meeting controls consume live socket-backed values; queue batches deduplicate
keys and prove cursor pagination; deployment follows changes to the shared
Access verifier. Misleading partial local-Ace commands were removed, and the
regional section now describes the directory fields Ace transiently reads.

**Why:** Review reproduced stale or fail-open application surfaces and showed
that the earlier residency text contradicted Ace's direct EU D1 binding. It also
found duplicate full-account enumerations and a deployment trigger that could
leave Ace on an older verifier after a merge.

**Considered and rejected:** Routing Ace directory search through a new regional
RPC. The product requirement deliberately makes this internal Access-gated
application the cross-region lookup plane; adding a bridge would change that
boundary rather than fix the inaccurate claim.

**Consequences:** A render seed is never treated as a completed server read,
managed Electron UI remains off until an exact server `true`, one Queue batch
enumerates each region once per distinct key, and regional documentation must
continue to name Ace's narrow operator-search exception.

### 2026-08-24 — Ace manages Suggested Work and workspace template rollouts

**What changed:** Ace now includes Suggested Work Enabled and Automation
Workspace Templates Enabled in its fixed product-flag catalog, and its automatic
deploy provisioner creates both as Boolean flags with an off variation, an on
variation, and an off default.

**Why:** Product managers need to stage these existing application surfaces
through the same ergonomic targeting editor and key-only notification path as
the first two product flags, without dashboard-only configuration that would
bypass connected-client notification.

**Considered and rejected:** A second editor or a separate Flagship application.
Both would duplicate targeting vocabulary and split one global rollout control
plane without introducing a distinct trust or residency boundary.

**Consequences:** Ace's managed set is now four flags. Adding another product
Boolean still requires an Enabled-named key, fail-closed Electron visibility,
automatic provisioning, and inclusion in the shared key schema. These controls
must not change API availability.

### 2026-08-24 — Ace becomes the managed product-flag write path

**What changed:** Ace was introduced as an Access-protected Hono Worker with a
shared component library, D1-backed targeting editor, automated Flagship
provisioning, and a shared-to-regional Queue fan-out that updates connected
desktop clients through WorkspaceDO.

**Why:** Product managers need to stage user-facing features by human concepts
such as a person, workspace, role, or domain without copying opaque IDs or
deploying application code. Connected clients also need a change promptly, but
the effective answer differs per user and Flagship exposes no documented
outbound change notification.

**Considered and rejected:** Polling every desktop makes propagation depend on
every client timer and repeats work forever. Sending one value through the
fan-out is incorrect for targeted rules. Using the Flagship dashboard directly
cannot trigger Avalon's Queue path. Giving Ace the deployment token would make a
runtime compromise an account-administration compromise.

**Consequences:** Managed product flags must be edited through Ace, Queue
payloads remain key-only, reconnect remains the repair path, and future Ace
pages reuse its Access boundary and component library. The Flagship-only runtime
credential is a standing deployment prerequisite.
