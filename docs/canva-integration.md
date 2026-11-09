# Canva integration

Canva is a personal hosted MCP connector. The API holds provider credentials and
makes MCP calls; Electron owns only the temporary loopback listener used while
Rally's server callback awaits provider approval. Canva is available to every
member without an availability flag.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/connectors/src/canva.ts` | Personal adapter, OAuth, live tools and renewal |
| `packages/connectors/src/canva-polling.ts` | Explicit design and discussion scan checkpoints |
| `apps/api/src/services/connection-service.ts` | Sealed OAuth attempts and authenticated redemption |
| `apps/desktop/src/main/canva-loopback.ts` | Temporary native callback listener |
| `apps/api/src/services/canva-transaction-cleanup.ts` | Durable post-run cancellation and uncertainty |
| `apps/api/src/services/canva-resource-access.ts` | Encryption and identity binding for access URLs |

## How it works

The API registers a DCR client, retains its credentials and PKCE verifier in a
sealed OAuth attempt, and returns an authorization URL. Electron supplies an ephemeral
`http://127.0.0.1:<port>/callback` URL. Main receives the code and forwards it with
the current Rally session. Both member and workspace must still match the
initiator. Public callback requests cannot consume a loopback attempt.

Without a supplied loopback redirect, the same adapter uses the configured API callback. Successful
redemption stores encrypted provider credentials through the existing connection
service. Refresh uses Canva's exact resource identifier and persists rotated tokens
through the shared credential lifecycle. Disconnect attempts RFC 7009 revocation
at the discovered, origin-validated endpoint with the refresh token, then clears
local credentials even if Canva refuses revocation. Live acceptance confirmed the advertised endpoint accepts revocation and rejects
a subsequent refresh of the revoked grant.

Tools are discovered live. Provider annotations do not grant read-only authority.
Rally supplies a deterministic operation description as `user_intent`, excluding
conversation text. Resource hydration parses the fields it consumes; it does not
store returned navigation or thumbnail URLs.

An explicit resource watch selects one design. A Sidekick evaluator must also name a design; registration creates its poll schedule, and removal disables it. Generation checks prevent a stale registration from re-enabling a removed schedule. Metadata timestamps detect newer
observed designs. Discussion scans visit all thread pages and each thread's reply
pages, preserving progress between polls. The first complete scan establishes a
baseline. Later scans deduplicate by thread/reply identity, without relying on
ordering or parent timestamps. Events contain identities rather than discussion
bodies. Both event types declare `digestible: true` ([what that field still means](connectors.md#declaring-what-a-digest-may-read)) and target the connection's owner under the ordinary visibility rules.

Changing a watch target establishes a fresh baseline; it cannot reuse the old
design’s timestamp or discussion identities.

The post-run settlement lane cancels known open editing transactions using their
durable start receipts. It refuses a transaction owned by another run and records
cleanup intent before dispatch. Completed commits and cancellations are closed;
uncertain commits and cleanup responses are retained for reconciliation and never
blindly cancelled or replayed. Canva has no verified transaction-status lookup,
so unresolved outcomes remain a durable settlement diagnostic.

## Invariants

- Codes remain in Electron main; provider tokens and PKCE remain in the API.
  Renderer exposure would bypass the existing credential isolation boundary.
- Public callbacks cannot redeem desktop attempts, including denials; otherwise
  the authenticated handoff could be bypassed.
- Design identity and access material are separate. `resources.protected_access_json`
  holds a versioned encrypted envelope bound to workspace, connection and design;
  `canonical_url` is clean. Copying the envelope to another identity fails decryption.
- Connecting alone never selects designs for polling. Account-wide enumeration
  would turn authorization into unrequested monitoring.
- A failed page cannot replace its checkpoint. Lost progress would hide comments
  or repeatedly announce old activity.

## Boundary

The connector uses the shared hosted MCP transport, authorization service and
polling runner. The requester is responsible for sharing resulting content with
the conversation. Recipients do not need separate Canva authorization to see that
output; ordinary Rally permissions apply. Remaining live acceptance cases are
tracked in the PRD implementation plan.

## Failure modes and limits

The listener expires with the existing ten-minute OAuth attempt. Polls use the
PRD's ten-minute floor and one discussion page per poll; large designs therefore
take multiple intervals to baseline or rescan. Thread pages request Canva's
documented maximum of 100. Existing shared MCP response/time bounds and the poll
workflow's cursor bound apply; no independent numeric ceilings are introduced.
Provider refusals and malformed consumed data fail the operation. Access revocation
requires reconnection; neither plan eligibility nor refresh-token lifetime is inferred.

## Testing

Connector tests use provider HTTP doubles. Desktop tests open a real Node loopback
socket. A populated workerd migration test verifies existing installations and OAuth
connection pointers survive widening the provider vocabulary. The API handoff regression exercises stored OAuth state and has been
mutation-proven by removing the authentication boundary. Resource-envelope tests
verify encryption and identity binding; inventory tests exercise the new column
and replacement through real workerd. On 2026-09-19 the real Electron loopback completed authorization into the local
Worker; its encrypted credential row contained access and refresh tokens plus the
DCR client secret. Live discovery returned 34 tools. Replacing only the local
access-token copy with an invalid value forced the normal backend refresh path:
discovery succeeded again and the stored refresh token changed. The live polling adapter completed a design baseline and five discussion pages
covering seven thread/reply IDs without emitting historical events. An unchanged
editing session on that existing test design opened and cancelled successfully;
its transaction ID is preserved as the start tool receipt's provider operation ID.
Tokens and design content were not printed or copied into test evidence. This proves rejection-driven renewal, not
waiting through a natural four-hour expiry. Remote revocation succeeded and the same refresh grant was then rejected. Real
workerd cleanup tests exercise encrypted credentials, provider cancellation and
durable no-replay receipts; mutation checks prove cancellation dispatch and
uncertain-commit classification are covered. The service polling test forwards a
protected reference, survives object eviction, persists its cursor, deduplicates
real event ingestion and stops provider calls for a paused watch.

## Changelog

### 2026-09-19 — Personal Canva with native login and explicit observation

The product decision places responsibility for sharing Canva content on the
member who requests it in a work stream. The extra recipient-eligibility gate
was therefore removed instead of requiring every viewer to connect Canva.
Polling no longer withholds otherwise digestible events for that gate; existing
owner-targeted visibility and personal credential ownership remain unchanged.

The server callback is awaiting Canva approval, so the interim listener forwards
only a code to the API instead of storing desktop provider credentials. Shared
links can carry access rights, which requires encrypted access storage separate
from navigation metadata. Polling uses complete discussion scans because replies
do not reliably advance parent timestamps; a sorted top-ID watermark would miss
activity. Canva is available to everyone without a feature flag; the tested
loopback flow is the fallback until Canva approves the server callback.
Availability must not depend on that pending approval.
