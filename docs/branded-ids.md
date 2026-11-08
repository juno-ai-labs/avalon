# Branded identifiers

Rally's entity identifiers are UUID strings, so the type system on its own
treats a workspace id, a conversation id, a run id, and a user id as freely
interchangeable. Transcript turn IDs are the deliberate exception: participant
turns currently use UUIDs, while assistant turns derive an opaque stable key
from the durable loop and turn ordinal. `TranscriptTurnIdSchema` owns that
shared string contract; consumers must not narrow it back to `IdSchema`.

The places identifiers meet are exactly the places a swap is
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
| `WorkstreamId` | `asWorkstreamId` | A conversation's id |
| `HarnessRunId` | `asHarnessRunId` | A harness run's id |
| `UserId` | `asUserId` | A user's id |
| `SubstreamId` | `asSubstreamId` | `"0"` or a child substream id |

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

### 2026-08-29 — Transcript turn identity is explicitly opaque

**What changed:** `TranscriptTurnIdSchema` is the shared contract for canonical
message IDs, transcript turns, admission receipts, stream checkpoints,
background-task references, and terminal outcomes. It accepts the existing
UUID participant IDs and structured durable-loop assistant IDs.

**Why:** Assistant turns have long used a stable `<loop>:turn:<ordinal>` key,
but `MessageSchema.id` still required a UUID. Terminal settlement therefore
failed while reloading a correctly persisted assistant turn and never reached
external result delivery.

**Considered and rejected:** Replacing assistant turn keys with generated UUIDs.
The structured key is already the durable retry identity across provider
attempts and recovery; adding a second identifier would create a translation
table without improving authority. Also rejected: weakening generic `IdSchema`,
which would discard UUID validation for actual entities.

**Consequences:** Entity brands remain UUID-backed. Any field whose meaning is
"canonical transcript turn" uses the named opaque schema, even when its current
producer happens to emit a UUID. The schema does not impose an invented length
ceiling on an opaque key; storage uses `TEXT`, and producer-specific bounds stay
at the producer boundary.

### 2026-08-26 — Connector processing removes its external Workflow ID

**What changed:** New connector events use a generated internal processing-owner
UUID carried by the existing regional Queue instead of constructing a
Cloudflare Workflow instance ID. The now-unused Workflow-ID constructor, brand,
and example-specific tests are removed. The legacy Workflow input remains
string-shaped only so already-created instances can finish.

**Why:** Native Queue retry removes the external identifier boundary entirely.
Keeping a constructor with no production caller would advertise a template that
new code should not use and preserve a correctness obligation the architecture
no longer needs.

**Considered and rejected:** Retaining the constructor for hypothetical future
Workflow call sites. A future external-ID boundary should define and test the
platform contract it actually needs rather than inherit a connector-specific
artifact.

**Consequences:** Internal processing ownership is an ordinary validated UUID
and is logged directly. The historical entry below explains why the constructor
was correct while per-event Workflows existed; it is not current guidance.

### 2026-08-25 — Workflow instance IDs are valid by construction

**What changed:** `cloudflareWorkflowInstanceId` hashes a typed identity tuple
behind the fixed `wf_` prefix, validates the resulting 67-character value
against Cloudflare's user-supplied Workflow ID contract, and returns a branded
`CloudflareWorkflowInstanceId`. Connector-event Workflow creation now accepts
provider and Rally identifiers only as hash input.

**Why:** A colon-delimited internal idempotency key crossed unchanged into
Cloudflare's stricter external identifier boundary. The Workflow test double
accepted the malformed string, so tests asserted the mistake instead of
exercising the platform contract. Fixed-alphabet digest construction makes
validity independent of provider content or delimiter choice.

**Considered and rejected:** Sanitizing arbitrary templates, because two
different inputs can sanitize to the same value and every new call site has to
remember the rule. Testing one hand-written example, because it proves only that
example. Letting Cloudflare generate the ID, because connector Queue replay
needs deterministic instance identity to converge on the already-running
Workflow.

**Consequences:** Code that needs a deterministic external Workflow ID should
derive it through the constructor rather than interpolate internal identifiers.
Logs carry the unhashed opaque Rally/provider IDs separately, so correlation
does not depend on making the external ID human-readable.

### 2026-08-20 — Introduced, and applied through the execution spine

**What changed:** The six brands and their validating casts in contracts;
`WorkstreamWorkflowInputSchema`, the auth contexts, the DO name helpers, DO
protocol schemas, and ~150 files of signatures and boundary casts across the
API; test fixtures migrated to real UUIDs because the casts validate.

**Why:** The 2026-08-20 incident chain was id-confusion shaped: statements
routed by the wrong authority, coordinates crossing layers as bare strings.
During this very refactor the type checker caught a workspace id being cast
as a conversation id in a test fixture — the mistake class, made by the tool
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
