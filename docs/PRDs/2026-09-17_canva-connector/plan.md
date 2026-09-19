# Canva implementation plan

Implementation branch: `codex/canva-connector`. Kept separate from PR #838 at the
user's request. Canva ships to every member without a feature flag, using desktop loopback
until server callback approval.

- [x] Read the merged PRD and create an isolated implementation worktree.
- [x] Implement backend-held DCR credentials and authenticated Electron loopback handoff; retain the server callback after allowlisting.
- [x] Wire personal connector discovery, backend refresh and remote revocation, minimal `user_intent`, conservative write authority and provider refusals.
- [x] Store editing transaction identities in durable tool receipts; cancel known open abandoned transactions through post-run settlement. Refuse closed or uncertain transactions and preserve uncertainty without blind replay.
- [x] Implement explicitly selected design watches, complete comment/reply baselines and checkpointed polling through the shared runner.
- [x] Encrypt share-link access material separately from ordinary resource metadata and validate its workspace, connection and design binding.
- [x] Exercise authorization/storage paths, real desktop sockets and real workerd receipts/polling; prove integration tests fail under production mutations.
- [x] Complete final lint, typecheck, full `pnpm test`, API/desktop/site builds, CI Worker build boundaries and desktop release invariants.
- [x] Inspect the desktop connection disclosure and support page in real windows.

## Acceptance evidence — 2026-09-19

The actual Electron listener forwarded a browser authorization code to the local
API, which exchanged it and stored encrypted access/refresh tokens and the DCR
secret. Live discovery returned 34 tools. Invalidating only the local access-token
copy forced the ordinary backend refresh path: discovery recovered and the stored
refresh token rotated. Remote revocation succeeded; a subsequent refresh with
that grant failed as unauthorized. The disposable test grant is now revoked.

Live polling completed a design baseline and five discussion pages covering seven
thread/reply identities without historical notifications. An unchanged editing
session on the existing disposable design opened and cancelled. Provider HTTP is
doubled in the real workerd tests; storage, encryption, object eviction, queue
production and idempotent event ingestion use their actual implementations.

Mutation checks cover authenticated handoff, protected access persistence and
forwarding, migration preservation, native Workers fetch invocation, poll schedule
removal, editing cleanup dispatch and uncertain commit classification. Mutations
were restored before the passing verification runs.

## Sharing decision — 2026-09-19

The requester is responsible for sharing Canva-derived output in the work stream.
No Canva-specific recipient authorization is required. Ordinary Rally permissions,
personal credential ownership and digest visibility remain the access contract.
The previously listed recipient-enforcement engineering gap is removed.

## Remaining launch acceptance

- [ ] Obtain Canva's production approval and clarify the interim desktop-to-backend flow's production eligibility. Loopback remains the fallback while the application is pending.
- [ ] Verify access that depends solely on a collaboration link, including revoking that link, using a separate non-owner Canva account.
- [ ] Exercise design generation, export and Sidekick output end to end through Rally's agent loop; verify real provider entitlement refusals and reported quotas there.
- [ ] Complete the natural-expiry/concurrent-refresh acceptance run. Rejection-driven renewal and durable rotation are verified; a natural four-hour wait was not performed.
- [ ] Resolve a real ambiguous commit through inspected design state. There is no verified Canva transaction-status lookup; the implementation preserves a durable diagnostic and refuses blind cancellation or replay.

DCR is the tested interim identity. Moving to Canva's recommended CIMD requires a
published metadata document and provider acceptance; it does not remove the
redirect-approval gate. No provider account identity is inferred from the MCP
resource URL, and plan eligibility is always decided by Canva.
