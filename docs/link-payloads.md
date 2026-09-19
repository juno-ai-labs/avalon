# Link payloads

Opaque tokens for links people receive, and the JSON each one stands for.

A link that spells out what it addresses tells whoever it was forwarded to more
than it tells its recipient. Identifiers in a URL are the server's routing, and
publishing them describes a thing the reader may hold no access to — a workspace
they are not in, a work stream they have not been offered. So the URL carries a
token, a row holds the rest, and the token's prefix says which shape "the rest"
has.

This is the store behind that, shared rather than built per feature: a URL that
should not describe its subject is a recurring shape, not one feature.
[`scope-invitations.md`](scope-invitations.md) owns the first kind, `inv`, and
everything about what an invitation *is*; this document owns the store and the
lifecycle of a row in it. A second kind adds a `defineLinkPayload` call and
nothing else.

## Where the code lives

| Path | What it owns |
| --- | --- |
| `packages/db/src/link-payloads.ts` | `defineLinkPayload`, `issueLinkPayload`, `openLinkPayload`, `discardLinkPayloads`, `purgeExpiredLinkPayloads`. |
| `packages/db/migrations/0114_link_payloads.sql` | The table: token digest, type, JSON payload, created and optional expiry. |
| `apps/api/src/worker-events.ts` | Runs the expiry sweep on the existing scheduled handler. |
| `apps/api/src/services/scope-invitation-link.ts` | The `inv` kind, and the only production caller today. |

## How it works

`defineLinkPayload(prefix, schema)` pairs a token prefix with the shape that
prefix promises. Issuing validates the payload, writes
`{token_hash, type, payload, created_at, expires_at}` and returns
`<prefix>_<43 characters>` — 256 bits of `crypto.getRandomValues`, base64url with
padding stripped, so the token never contains `=` and a reader can split it on
its first `_`. Opening refuses a token whose prefix is not the kind's, reads by
digest *and* type, and validates the JSON on the way out.

Only the digest is stored. The token exists in the link that was sent and
nowhere else, which is what makes a copy of this table a list of what exists
rather than a set of working links — provided no kind puts a presentable secret
in its payload. See **Invariants**.

A row's `expires_at` is the expiry of whatever it addresses, or null where that
thing has none. Rows that carry one are swept twice over: each issue deletes
rows already past their deadline, so a table being written to sweeps itself, and
`purgeExpiredLinkPayloads` runs on the Worker's existing scheduled handler, so a
table nobody is minting into is swept anyway.

`discardLinkPayloads` is the only way a row is reclaimed before its deadline, and
it works in exactly one place: the call that minted the token, while it still
holds it. Nothing else can find the row — it is keyed by a digest of a value
that was never stored — so a caller that mints speculatively, before it knows
whether it will use what it minted, owns cleaning up after itself.

## Invariants

- **A payload is routing, never a credential.** The token that reads a row is
  the only secret in the arrangement; whatever guards the thing a row addresses
  must be checkable against the presented token rather than against a value the
  row carries. A kind that stores a second secret makes a dump of this table
  replayable wherever that secret is accepted, which is how the first revision
  of the `inv` kind shipped and what review caught.
- **The prefix is the type.** The prefix gates the string, the `type` column
  gates the row, and the schema gates the JSON, so a token minted for one kind
  can never be read as another even though every kind shares the table.
- **Only the minter can reclaim a row early.** Nothing that holds the payload —
  not the thing the link addresses, not a later revocation of it — can find the
  row again.
- **A row with no expiry is retained.** Nothing here can know that the thing it
  addresses has been accepted, revoked or forgotten. Reclaiming those means
  deleting on `created_at` age, and that age is a retention number the team sets
  rather than one this module picks.
- **A row that no longer satisfies its schema is our drift, not a forged link.**
  It raises `link_payload_drift_invalid:<prefix>:<path>:<code>` rather than being
  reported as one more unreadable token. The `_invalid:` label is load-bearing:
  it is what `isDiagnosticCode` matches, and without it the code reaches an
  operator as the caller's generic fallback. See
  [`naming-a-schema-failure.md`](naming-a-schema-failure.md).
- **A token is resolvable only in the region that issued it**, because the row
  lives in that region's D1. A link that must survive being opened against
  another deployment needs its own routing; it cannot be found by offering the
  token to every deployment in turn.

## Boundary

This store says what a token stands for. It decides nothing about what the
holder may then do: the authority the payload names — a Durable Object, a route,
a grant ledger — still answers every question the link leads to, and still
refuses a revoked or unknown subject exactly as it would have without a link.

## Failure modes and limits

An unreadable token, a token of another kind, one edited in transit, one another
deployment issued, and one whose row has expired are one answer deliberately:
null. Telling them apart tells a holder something about a link they do not have.
A row that exists but no longer parses is the one case that raises instead, for
the reason in **Invariants**.

No cap on payload size or on rows is invented here; D1's own limits apply. The
prefix has no length ceiling either — only this tree's own `defineLinkPayload`
calls reach it, and a limit on a value nobody outside supplies is a number
invented for nothing.

## Testing

`apps/api/test/scope-invitation-link.test.ts` covers the store against the real
migrations: the round trip, another kind's token, one edited in transit, an
expired row, the issue-time sweep, the scheduled sweep, a payload that no longer
matches its prefix, one that is no longer JSON, and that the drift code survives
`diagnosticErrorCode` rather than reducing to its fallback.
`apps/api/test-workers/scope-invitations.test.ts` covers the store as the `inv`
kind uses it on real workerd, including that a creation which records nothing
takes back the rows it minted.

## Changelog

### 2026-09-19 — Give the emailed-link store its own document

Split out of [`scope-invitations.md`](scope-invitations.md), which is where this
was built and first written down. The store stopped being part of that feature
the moment it was generic: it spans `@rally/db`, a Worker route, a Durable
Object and the scheduled handler, and it owns a lifecycle — mint, open, expire,
sweep, discard — with invariants an outsider can break. The one that matters
most is not inferable from any signature: a payload may not carry a secret,
because the token that reads it is the secret. Leaving that rule in the
invitation's document would have made the next kind's author read a feature
document to find it. Scoped invitations keep everything about what an invitation
is, and both documents say where the split runs.

What a future change has to respect is in **Invariants**, and the retention
question is the open one: a row with no expiry is retained indefinitely, and
nothing here should pick the age at which that stops being true.

PR: [#863](https://github.com/juno-ai-labs/avalon/pull/863).
