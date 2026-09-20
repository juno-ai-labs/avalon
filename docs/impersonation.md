# Impersonation

Impersonation is a directed, organization-scoped identity relationship. The demo
sidecar is its first surface, restricted to verified company identities in the
original cast of a published live demo.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `apps/api/src/services/impersonation.ts` | Generic pair provisioning and exact relationship checks; canonical demo/operator eligibility. |
| `packages/db/migrations/0115_impersonation_relationships.sql` | Regional identity delegation records. |

## How it works

Provisioning inserts every ordered pair, including self-pairs. Existing records
are retained, including revocations. Demo eligibility reads the original recorded
cast, current membership, trusted regional identity, and publication state.

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

## Changelog

### 2026-09-20 — Directed authority for the internal demo sidecar

**What changed:** Added organization-scoped directed relationships and canonical
company/original-cast/demo checks.

**Why:** A live demo needs participant sends without issuing another person's
session or permitting represented sends in regular organizations.

**Considered and rejected:** Demo status alone cannot identify who may represent
whom; a role or client marker cannot replace canonical relationship authority.

**Consequences:** Later surfaces may reuse the generic relationship but must define
their own availability rules. Reprovisioning must preserve revocation.

Product requirements: [impersonation PRD](PRDs/2026-09-19_impersonation-platform/prd.md).
