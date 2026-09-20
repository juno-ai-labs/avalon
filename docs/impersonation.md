# Impersonation

Impersonation is a directed, organization-scoped identity relationship. The demo
sidecar is its first surface, restricted to verified company identities in the
original cast of a published live demo.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `apps/api/src/services/impersonation.ts` | Generic pair provisioning and exact relationship checks; canonical demo/operator eligibility. |
| `packages/db/migrations/0116_impersonation_relationships.sql` | Regional identity delegation records. |

| `apps/api/src/services/demo-sidecar.ts`, `routes/demo-sidecar.ts` | HTTP catalog and message adapter with dual-identity audit. |

## How it works

Provisioning inserts every ordered pair, including self-pairs. Existing records
are retained, including revocations. Demo eligibility reads the original recorded
cast, current membership, trusted regional identity, and publication state.

Catalog reads provision missing original-cast pairs for older demos. Each participant's
Channel/Breakout list uses ordinary parent authority, never transcript reads.
HTTP admission resolves the represented participant, audits before admission, then
calls the ordinary conversation message operation. The conversation independently
rechecks the actual operator session and demo relationship before admitting the
represented turn. Receipts and addressing remain the ordinary path; the sidecar
never observes downstream execution. Retirement revokes demo-provisioned pairs.

## Invariants

- Direction matters: revoking A → B must not remove B → A.
- Provisioning never revives a revoked relationship.
- Company email, demo status, original cast, and current membership are all required;
  a relationship alone must never expose the sidecar in a regular organization.

## Boundary

The relationship is regional control-plane identity authority alongside membership.
The conversation remains the authority for destination access and message admission.
No represented-user credential is issued.

## Testing

`apps/api/test/impersonation.test.ts` exercises real checked-in migrations. Removing
the revocation predicate fails the direction/replay test.

## Failure and recovery

Missing or malformed demo identity/cast denies access. Replaying provisioning
inserts missing pairs and preserves revoked ones.

Product requirements: [impersonation PRD](PRDs/2026-09-19_impersonation-platform/prd.md).

## Changelog

### 2026-09-20 — Audited HTTP messaging for the original demo cast

**What changed:** Added directed relationships, canonical company/original-cast/demo
checks, HTTP catalog and admission routes, operator-session revalidation at the
conversation boundary, and preparation/retirement wiring. Catalogs use visible
Breakout titles; audit records retain both identities, a body digest, request ID,
API version, and the canonical turn reference without storing message text.

**Why:** Live demos need participant sends without issuing another person's
session or permitting represented sends in regular Organizations. HTTP retries
must preserve ordinary message idempotency while sockets remain in Rally's
conversation UI.

**Considered and rejected:** Demo status or client markers cannot replace directed
relationship authority. Direct transcript writes bypass ordinary admission;
checking only initial Worker authorization misses a revoked operator session.
Raw Breakout IDs are unsuitable presenter-facing labels.

**Consequences:** Later surfaces may reuse the generic relationship but must define
their own availability rules. Reprovisioning preserves revocations. Both identities
travel only through authorization and audit; canonical messages and harness inputs
retain the represented participant. Migration 0116 follows main's newly landed
0115 and must be renumbered again if another branch claims it before merge.
