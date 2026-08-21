# D1 baseline migrations

A **baseline** is a checked-in snapshot of the regional D1 schema as of one
migration, applied to an empty local database in place of replaying the chain
that produced it. Setting up a fresh checkout applies one file instead of
ninety-five, which takes about four seconds per region instead of about
forty-three.

A baseline is a derived artifact and nothing else. `packages/db/migrations/` is
still the authoritative schema, hosted databases still replay it in full, and
every property that makes the derivation safe to trust is enforced by a test
rather than by care. Read this before generating a baseline, moving the
boundary, or changing how a local database is created.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `packages/db/baselines/b_<nnnn>_<text>.sql` | The generated snapshot. Named after the migration it stands through. Never edited by hand. |
| `packages/db/baselines/manifest.json` | Which migrations the baseline subsumes, their digest, the volatile columns, and the object and row counts. The one place a reader learns what the file claims. |
| `packages/db/baselines/production-fingerprint.json` | Per-object digests recorded from the hosted databases, so the parity result stays enforced offline. |
| `scripts/d1-baseline.mjs` | The library: boundary selection, the staleness digest, snapshotting, volatile-column detection, SQL rendering, fingerprints, and the shared "which tables are internal" rule. |
| `scripts/create-d1-baseline.mjs` | `pnpm db:baseline:create <through-migration.sql>` — generates the file and the manifest. |
| `scripts/check-d1-baseline-against-remote.mjs` | `pnpm db:baseline:verify` — compares the baseline against both hosted databases and them against each other. `-- --record` refreshes the fingerprint. |
| `scripts/migrate-local-region.mjs` | What `pnpm db:migrate` runs per region: decides whether the baseline applies, then hands over to Wrangler. |

## How it works

### Generating one

`pnpm db:baseline:create 0090_drop_legacy_product_tables.sql` applies every
migration sorted at or below that file into an in-memory SQLite database, reads
the resulting schema and seeded rows back out, and renders them as one file.

The boundary is a **file name, not a number**. Six sequence numbers in this
repository carry two files each, so a numeric comparison would take one of a pair
and leave the other pending forever on a baselined database while production ran
both.

The chain is applied **twice, about a second apart**. Two control rows are seeded
with `datetime('now')`, and comparing two independent replays is how a column the
chain recomputes is told from one it hardcodes, without parsing SQL for every
spelling of "now". Those columns are re-derived in the generated file;
everything else is frozen as a literal. `datetime('now')` has one-second
resolution, so the gap is the mechanism rather than politeness.

Statement order in the generated file is load-bearing, and is the order SQLite's
own `.dump` uses: tables, then seeded rows, then indexes, then triggers, then the
ledger rows. Several triggers in this schema `RAISE(ABORT)` on writes they
consider out of phase, so creating them before the inserts would abort the file
partway through. The ledger claim — "these migrations have run" — is written last
of all, once the schema it describes exists.

### Applying one

`pnpm db:migrate` runs `scripts/migrate-local-region.mjs` for each region. It
asks the local database how many user tables it has and how many migrations its
ledger claims. Both must be zero for the baseline to be applied; then Wrangler
runs as it always did, finds every subsumed migration already recorded, and
applies only what came after. Anything else skips the baseline and is migrated
the ordinary way.

The generated file also refuses a non-empty database itself, through a named
`CHECK` — the same shape migration 0090 uses, because a D1 file is a flat
statement sequence with nowhere to put an `if`. The two checks are not redundant:
the wrapper's exists so a warm container continues quietly, and the guard exists
so the file cannot be misapplied by hand.

### Verifying one

`pnpm db:baseline:verify` reads `sqlite_schema` from both hosted databases and
compares the baseline against each, and the two regions against each other. It
never reads a row of production data. With `-- --record` it writes
`production-fingerprint.json`, which `scripts/d1-baseline.test.mjs` then compares
against on every run — so the answer stays enforced without credentials.

## Invariants

- **A baseline only ever applies to an empty database.** It carries no migration
  history of its own, so applying it over existing tables would merge two schemas
  with no record explaining either, and applying it over a partially migrated
  database would record every subsumed migration as applied when some had not
  been. Both are unrecoverable without dropping the database.
- **The migration chain stays authoritative and complete.** Deleting a migration
  because a baseline subsumes it would leave every hosted database that has not
  run it with no description of how to get there. A baseline is an addition.
- **Hosted databases never apply a baseline.** `db:migrate:remote` replays the
  full chain. If a baseline ever reached production it would collide with the
  schema already present, and the guard would refuse it — loudly, mid-deploy.
- **The manifest's file list and digest describe the migrations on disk
  exactly.** This is what makes staleness loud. Editing a subsumed migration or
  inserting one below the boundary changes the digest and fails the suite. The
  sequence has a hole at 0084, so a later `0084_*.sql` would sort *below* the
  0090 boundary — recorded as applied on every baselined database, and still
  pending on production. That case is why the digest covers the file list and not
  only the contents.
- **A failing baseline test is never fixed by regenerating.** Regenerating
  encodes whatever changed into the artifact and removes the evidence. Find out
  whether a migration was edited or a file was inserted first.
- **Both regions share one baseline, which requires that they be identical.**
  `pnpm db:baseline:verify` checks Global against EU for exactly this reason;
  "both are migrated" and "both are the same" are different claims.

## Boundary

This document owns how a baseline is generated, applied, and verified. It does
not own the schema — [`data-model.md`](data-model.md) owns what the tables mean
and the rule that deployed migration files are immutable, which is what makes a
baseline safe to derive at all. It does not own how migrations are run against
hosted databases; that is [`runbook.md`](runbook.md). Local setup is
[`dev-environment.md`](dev-environment.md), which points here rather than
restating any of it.

Nothing outside `scripts/migrate-local-region.mjs` decides whether a baseline
applies, and nothing but Wrangler ever applies a migration or writes a ledger row
for one.

## Failure modes and limits

- **The guard fires.** The command fails with
  `CHECK constraint failed: baseline_requires_empty_database` and nothing of the
  baseline's schema is created. The database is left as it was — apart from the
  guard table itself, which is empty and inert. D1 rejects `CREATE TEMP TABLE`
  with `SQLITE_AUTH`, so the guard has to be a real table, and the `DROP` that
  would remove it is the statement after the `INSERT` that aborts. Every
  emptiness check excludes it by name, so a database that refused once can still
  be baselined after the reason is gone; the next attempt's
  `DROP TABLE IF EXISTS` clears it.
- **The two D1 runtimes disagree about their own internal tables.** A hosted
  database carries `_cf_KV`; a local Miniflare one carries `_cf_METADATA`. The
  `_cf_` prefix is matched rather than the individual names, because an exact
  list built from production passes every offline test and then refuses every
  real local database.
- **A hosted database returns DDL with its comments stripped.** Comparing raw
  text reports `telemetry_eu_events` as different on every run; all comparison
  normalizes comments and whitespace away first. That normalization **lexes**
  rather than running regular expressions over the statement, because a regex
  cannot tell a comment from the characters `--` inside a string literal: it
  would collapse `DEFAULT '--a'` and `DEFAULT '--b'` to the same text and hash
  them equal. Quoted tokens — string literals and `"`, `` ` ``, `[` identifiers
  — are compared byte for byte. Nothing in the schema relies on that today; a
  CHECK enumerating a value containing `--`, or a default with a doubled space,
  would.
- **`pnpm db:baseline:verify` needs Cloudflare credentials** and is not a CI
  gate. The recorded fingerprint is what keeps its result enforced.
- **Regenerating is not free of judgement.** The generator will happily produce a
  baseline from a chain that no longer matches production. Verify against remote
  before recording a new fingerprint.
- **A baseline does not rescue an already-broken local database.** A database
  seeded before the boundary is not empty, so it skips the baseline and meets the
  chain exactly as before — including migration 0090's refusal to retire a
  populated region whose authority is not open. The fix is still to delete
  `apps/api/.wrangler/state/<region>` and re-run `pnpm db:migrate`; the baseline
  only makes that cost four seconds instead of forty-three. Automatic recovery is
  deliberately not attempted, because "your database looks wrong, may I drop it"
  is not a decision a setup script should make silently.

Numbers as of the 0090 baseline: 95 migrations subsumed, 42 tables, 61 indexes,
26 triggers, 2 seeded control rows, one 45 KB file. Applying it takes about four
seconds per region against about forty-three for the chain.

## Testing

| Suite | Covers |
| --- | --- |
| `scripts/d1-baseline.test.mjs` (`pnpm test:scripts`) | Boundary and naming rules, the staleness digest, volatile-column detection, SQL literals, rendering order, the internal-table rule, wrangler output parsing, and parity with the recorded production fingerprint. |
| `scripts/migrate-local-region.test.mjs` (`pnpm test:scripts`) | The apply-or-skip decision and its reporting, with Wrangler injected. |
| `packages/db/test/baseline-migration.test.ts` (`pnpm --filter @avalon/db test`) | What the file does when executed: equivalence against a real chain replay, the guard, the ledger, volatile stamping, and a migration applied on top. |

The two levels are deliberately independent. The `packages/db` suite does **not**
import `scripts/d1-baseline.mjs`; it re-derives its expectations through `PRAGMA`
introspection — columns with their types, defaults and nullability, index
membership and uniqueness, foreign-key edges, trigger bodies — rather than by
comparing SQL text the way the library does. A generator bug would have to fool
two comparators built on different evidence to survive both.

Traps worth knowing before adding to either:

- Comparing schema as raw SQL text produces a false positive on
  `telemetry_eu_events`. Normalize first, or assert through `PRAGMA`.
- A test that applies the baseline twice in the same second cannot tell a
  re-derived timestamp from a frozen one. Assert that the file's text does not
  contain the value it produced, which is what
  `does not contain a frozen copy of a volatile value` does.
- `beforeAll` builds one chain database and one baseline database for the
  equivalence block because applying 95 migrations costs about a second. Every
  assertion there is read-only; anything that writes opens its own database.

## Operations

Moving the baseline forward, after a batch of migrations is deployed everywhere:

```bash
pnpm db:baseline:verify                  # the chain still describes production
pnpm db:baseline:create <through.sql>    # regenerate at the new boundary
pnpm db:baseline:verify -- --record      # re-record the fingerprint
pnpm test:scripts && pnpm --filter @avalon/db test
```

Delete the previous baseline file in the same change — there is one at a time,
because a second would be a dead file that still has to pass the equivalence
suite.

If `pnpm db:baseline:verify` reports a mismatch, a hosted database differs from
the migrations. That is an incident in the schema, not in the baseline; do not
regenerate to make it pass.

## Changelog

### 2026-08-21 — Local D1 starts from a checked-in baseline at migration 0090

**What changed:** `pnpm db:migrate` now applies a snapshot of the schema as of
`0090_drop_legacy_product_tables.sql` to an empty local database and lets
Wrangler continue from there, instead of replaying all 95 migrations. Generation,
remote verification, and the local apply decision are new scripts; the chain,
the remote migrate path, and every migration file are untouched.

**Why:** Replaying the chain took about 43 seconds per region and was the slowest
part of setting up a sandbox, on every session, for a schema that has not changed
below 0090 and cannot — deployed migrations are immutable. The prompting failure
was worse than slow, though: the chain no longer applies cleanly to a database
that was seeded before 0090 landed. Migration 0090 refuses a populated region
whose authority is not open, and `pnpm db:open-authority` refuses to open it
while a legacy seeded `harness_run` sits in `running` — a deadlock that wedged
the sandbox on every session and had no documented way out. Starting fresh
databases from a snapshot removes the replay, and the emptiness guard makes the
wedged state fail immediately and legibly instead of halfway through migration 90
of 95.

**Considered and rejected:**

- *Squashing 0001–0090 into a single migration file.* This is the obvious version
  of the idea and it is unsafe: hosted databases have already recorded those 95
  names, `packages/db/test/migrations.test.ts` pins specific filenames, the
  deploy workflow keys its Worker-first barrier off the remote pending ledger,
  and any database mid-chain would lose the only description of how to finish.
  Keeping the chain and adding a derived artifact costs one generated file and
  nothing else.
- *Keeping the baseline in `packages/db/migrations/`.* Wrangler applies every
  `.sql` file it finds there, so the baseline would be applied as the next
  migration on every database including production. A test demonstrates that
  failure rather than asserting a path string.
- *Freezing the seeded `datetime('now')` timestamps as literals.* Simpler to
  generate, but it stamps every future local database with the generation date
  and makes equivalence against a chain replay permanently unprovable — two
  replays do not agree either. Detecting the volatile columns by replaying twice
  costs a one-second sleep in a script that runs rarely.
- *A `CREATE TEMP TABLE` guard*, so a refusal leaves nothing behind. D1 rejects
  it with `SQLITE_AUTH`. The leftover is instead excluded from every emptiness
  check by name.

**Consequences:** Schema comparison must keep lexing rather than pattern-matching
SQL: two different schemas hashing equal is the one failure the fingerprint
exists to detect, and it is worse than no check because `db:baseline:verify` is
trusted. `packages/db/baselines/` is generated output — regenerate it,
never edit it, and never regenerate it to make a failing test pass. Anything that
decides whether a database is "empty" must use `internalTableExclusionSql()`
rather than writing its own predicate, or the wrapper and the guard will
eventually disagree and the disagreement will only appear against a real local
database. A migration added at or below the current boundary — `0084_*.sql` is
the live example, since the sequence skips it — fails the digest test on purpose;
the fix is a new boundary and a regenerated baseline, not a suppressed
assertion. The baseline must be regenerated and re-verified whenever the boundary
moves, and `production-fingerprint.json` re-recorded with it, or the offline
parity test is asserting against a schema nobody runs.

Shipped in the pull request for `claude/local-sandbox-migration-tboqdg`.
