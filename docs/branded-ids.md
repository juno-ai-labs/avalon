# Branded identifiers

Every identifier in Rally is a UUID string, so the type system on its own
treats a workspace id, a work-stream id, a run id, and a user id as freely
interchangeable. The places they meet are exactly the places a swap is
catastrophic and silent: a Durable Object *name* built from two ids in the
wrong order addresses a different object with no error on either side, and a
run claimed under the wrong coordinate updates somebody else's row. The
transcript-routing incident of 2026-08-20 was a family of exactly these
confusions, found one at a time in production.

## The model

`packages/contracts` defines the brands next to `IdSchema`:

| Type | Cast | Meaning |
| --- | --- | --- |
| `WorkspaceId` | `asWorkspaceId` | A workspace's id |
| `WorkstreamId` | `asWorkstreamId` | A work stream's id |
| `HarnessRunId` | `asHarnessRunId` | A harness run's id |
| `UserId` | `asUserId` | A user's id |
| `SubstreamId` | `asSubstreamId` | `"0"` or a child substream id |
| `BlockId` | `asBlockId` | A HyperSight block's id |

A brand is zod's `.brand<...>()`: zero runtime representation, and the schema
parse is the constructor. The `asX` casts **validate** — they parse, so a
brand is never a lie about shape, only a boundary's explicit claim about
meaning, made in one greppable place.

## The rules

- **Flow, don't cast.** A value that arrived branded — from a parsed schema,
  an `AuthContext`, a workflow input — stays branded through every call. A
  cast where a branded value was already in scope is a defect in review.
- **Cast only at provenance boundaries**: D1 and Durable Object SQL row
  reads, request values not already schema-parsed, external payloads, and
  test fixtures (cast once at the fixture definition). The database column
  is the authority on what its value means; the cast states that in code.
- **Never forge.** `as WorkspaceId` and `as unknown as` are prohibited; the
  validating casts are the only doorway.
- **Malformed input at a boundary is a fall-through, not a throw.** A parse
  guard (`Schema.safeParse(...).data`) belongs where an invalid id means
  "this request is not using this mechanism" — the development auth headers
  are the canonical example; casting there turned a malformed header into a
  500.

## What is branded today

The execution spine: `WorkstreamWorkflowInputSchema`, `AuthContext` /
`IdentityAuthContext`, the four Durable Object name helpers in
`apps/api/src/durable-objects/names.ts`, the DO socket-identity and internal
protocol schemas, `ExecutionPrincipalSchema`, and the service signatures
between them. Fan-in plumbing helpers with broad mixed-provenance call sets
(`publishWorkstreamEvent`, the runtime database routers) cast once internally
— a deliberate compromise recorded here so a later pass can push the brands
through their callers.

## Changelog

### 2026-08-20 — Introduced, and applied through the execution spine

**What changed:** The six brands and their validating casts in contracts;
`WorkstreamWorkflowInputSchema`, the auth contexts, the DO name helpers, DO
protocol schemas, and ~150 files of signatures and boundary casts across the
API; test fixtures migrated to real UUIDs because the casts validate.

**Why:** The 2026-08-20 incident chain was id-confusion shaped: statements
routed by the wrong authority, coordinates crossing layers as bare strings.
During this very refactor the type checker caught a workspace id being cast
as a work-stream id in a test fixture — the mistake class, made by the tool
performing the migration, caught by the migration.

**Considered and rejected:** Branding every id-like schema field in one pass —
the desktop app consumes many contracts schemas, and a full-surface brand
would couple this change to a renderer-wide migration; the spine is where the
danger concentrates. Wrapper classes instead of brands — runtime cost and a
foreign idiom for zod-parsed data.

**Consequences:** A swapped id at any branded seam is now a compile error.
New code touching the spine must accept branded types rather than `string`,
and boundary casts are the visible, greppable places provenance is asserted.
The fan-in helpers' internal casts are the recorded debt.
