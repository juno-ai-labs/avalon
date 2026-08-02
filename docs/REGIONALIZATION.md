# Regionalization

## V1 boundary

Every user signs in once through the Global Avalon identity endpoint. After authentication, the Global control plane uses an authenticated named Worker RPC binding to discover workspace memberships and email-bound pending invitations in Global and EU. An existing member activates that workspace immediately. A user with invitations may accept or decline them. Only a user with no workspace and no invitations sees organization setup, where they choose `Global` or `European Union`. A workspace persists that selection and it is immutable in V1.

The initial identity-only Global bootstrap session cannot access workspace data. Activation, creation, or invitation acceptance mints a fresh session in the workspace's owning region, commits an opaque Global workspace binding, and revokes the bootstrap session. The desktop then stores that regional API base URL and does not query the other region for ordinary workspace requests. Invitation acceptance remains email-bound, expiring, single-use, idempotent, and server-authorized; no second regional Google OAuth flow exists.

## Deployments

The same Worker source is deployed twice:

| Binding | Global | European Union |
| --- | --- | --- |
| Worker | `avalon-api-global` | `avalon-api-eu` |
| API | `api.with-avalon.com` | `eu.api.with-avalon.com` |
| D1 | global database | EU-jurisdiction database |
| R2 | global bucket | EU-jurisdiction bucket |
| Durable Objects | global namespace calls | namespace calls pinned with `jurisdiction("eu")` |
| Secrets | global key set | independent EU key set |
| Identity onboarding | canonical platform identity and opaque workspace binding | regional membership/invitation operations exposed only by named Worker RPC |
| GitHub App ingress | signature verification and installation-to-region directory | exact signed delivery forwarded through named Worker RPC only when connected in EU |
| Work-stream email registry | one authoritative, case-insensitive reservation table for every region | no local allocator; reservations and status changes use the Global named RPC binding |

Queues and Workflows carry region plus opaque record IDs, never sensitive payload bodies. Every service receives a fixed regional dependency container; repositories cannot choose a region from user-controlled object IDs.

## Operational checks

- Deployment configuration must fail when `AVALON_REGION` and the selected Wrangler environment disagree.
- Identity OAuth and desktop-ticket redemption occur only through the Global endpoint and yield an identity-only bootstrap session.
- The EU regional identity bridge is a named service entrypoint, not a public HTTP route.
- The GitHub smart ingress is host-gated at `github.with-avalon.com`; it verifies GitHub's signature before parsing or routing and never exposes its EU bridge as HTTP.
- GitHub OAuth callbacks, connector credentials, raw payload persistence, resources, activities, and automation processing stay in the connected workspace region. The shared ingress necessarily receives webhook bytes transiently before regional routing.
- Resend Receiving terminates at the Global ingress because a receiving domain has one catch-all webhook. Global retains only the friendly-address route and delivery receipt. EU message bodies are retrieved with the EU Worker and persisted only in EU R2/D1.
- Work-stream email names have one Global reservation registry for all regions. Global reserves locally; every non-Global Worker must call the named Global router and fails closed without it. Regional D1 is never an allocation fallback, and disabled/deleted names remain Global tombstones forever.
- A bootstrap session has no workspace ID and cannot authorize workspace data access.
- At most one active platform workspace binding may exist for an identity; simultaneous memberships in both regions fail closed for operator reconciliation.
- Pending cross-region operations are idempotent and fail closed after ambiguous RPC outcomes. Their diagnostic deadline never authorizes automatic reuse: later discovery reconciles a committed regional membership, while a genuinely orphaned reservation requires operator verification and cleanup.
- Session claims and workspace rows must agree on region.
- A target-region session replaces the Global bootstrap session after activation, creation, or invitation acceptance.
- All WorkstreamRoom and WorkspaceScheduler call sites select the namespace through the shared region helper; EU IDs are created and resolved with `jurisdiction("eu")`.
- Connector and harness records remain in the workspace region even when their providers process data elsewhere.
- Logs include the region without copying content.

## Caveat

This prototype provides logical routing and storage isolation. It is not marketed as a guarantee that every byte is processed exclusively in the EU. The Global identity control plane retains the platform identity/profile needed for login and an opaque EU workspace locator, and transiently receives minimal EU membership and invitation summaries during onboarding; it does not receive EU workspace content. Complete regional assurance requires verifying Cloudflare Queue/Workflow/observability behavior, applying applicable Regional Services and metadata controls, confirming LLM/connector provider commitments, and establishing contractual processing terms.

Enterprise-dedicated Workers, databases, buckets, keys, retention, and observability remain an extension point in the repository/service interfaces, not a V1 feature.
