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
| `packages/db/baselines/b_<nnnn>_<text>.sql` | A generated snapshot. Named after the migration it stands through. Several may exist. Never edited by hand. |
| `packages/db/baselines/manifest.json` | Every baseline: which migrations each subsumes, their digest, the volatile columns, and the object and row counts. The one place a reader learns what a file claims. |
| `packages/db/baselines/production-fingerprint.json` | Per-object digests recorded from the hosted databases, plus the migration they were recorded `through` and the regions read, so the parity result stays enforced offline against the chain as it stood at that point. |
| `scripts/d1-baseline.mjs` | The library: boundary selection, the staleness digest, snapshotting, volatile-column detection, SQL rendering, fingerprints, and the shared "which tables are internal" rule. |
| `scripts/create-d1-baseline.mjs` | `pnpm db:baseline:create <through-migration.sql>` — generates the file and the manifest. |
| `scripts/check-d1-baseline-against-remote.mjs` | `pnpm db:baseline:verify` — compares the migration chain against every discovered hosted database, and them against each other. `-- --record` refreshes the fingerprint. |
| `scripts/migrate-d1.mjs` | The one migrate script — every region, local or hosted. Discovers regions, plans, then hands over to Wrangler. |

## How it works

### Generating one

`pnpm db:baseline:create 0090_drop_legacy_product_tables.sql` applies every
migration sorted at or below that file into an in-memory SQLite database, reads
the resulting schema and seeded rows back out, and renders them as one file.

The boundary is a **file name**, ordered the way Wrangler orders migrations —
`compareMigrationPaths` replicates its comparator, which parses the leading
integer and compares numerically, falling back to a string compare only when the
numbers tie. That fallback is what keeps the six doubled sequence numbers in this
repository together; the numeric half is what stops an unpadded name from landing
on the wrong side of a boundary. Sorting as plain strings agrees with Wrangler for
every zero-padded name and disagrees the moment one is not, which is a divergence
nothing else in the tooling can see.

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

### Choosing one

There may be several baselines, and which one a database gets is **calculated**,
never named. `selectBaseline` keeps only those that still describe the chain —
the files a baseline claims to subsume must be exactly the files at or below its
boundary today, and still hash to its recorded digest — and picks the one whose
boundary is highest. Everything above that boundary is applied on top, so a new
migration does not invalidate a baseline; it just means one more thing to apply
after it.

A baseline the chain has moved underneath is skipped rather than fatal. The
chain is always there to fall back to, and a setup command that refused to run
because a *cache* was stale would be a bad trade. The staleness is still a test
failure, so it is loud in CI and quiet in your terminal.

The two manifest states a bad merge produces — an entry whose `.sql` was never
staged, and a boundary claimed twice with no way to tell which snapshot is right
— are also skipped, but `loadCatalog` reports them and `pnpm db:migrate` prints
them before it plans. Both otherwise end as a full chain replay, which from the
outside is indistinguishable from an ordinary slow first run, and so is exactly
the kind of breakage nobody investigates.

### Applying one

`pnpm db:migrate` runs `scripts/migrate-d1.mjs`, which discovers the regions,
asks each database what it holds, and plans:

| The database | The plan |
| --- | --- |
| No user tables, no ledger rows, a usable baseline | **`baseline`** — the snapshot, then the migrations above its boundary |
| No user tables, no ledger rows, no usable baseline | **`migrate`** — the whole chain |
| Has tables, or has ledger rows | **`migrate`** — Wrangler applies what is pending |
| Nothing pending | **`up-to-date`** |
| Hosted (`--remote`) | **`migrate`**, always — see the invariant below |

A database with tables never has its ledger read: it is not getting a baseline
whatever the ledger says, and reading it costs a Wrangler start-up per region on
the path setup takes every session. The plan then carries `pending: null` rather
than a count nobody computed, and says so.

The generated file also refuses a non-empty database itself, through a named
`CHECK` — the same shape migration 0090 uses, because a D1 file is a flat
statement sequence with nowhere to put an `if`. The two checks are not redundant:
the script's exists so a warm container continues quietly, and the guard exists
so the file cannot be misapplied by hand.

### Adding a region

Nothing here lists regions. `discoverRegions` reads `apps/api/wrangler.*.jsonc`
and treats a config as a region when its D1 binding declares `migrations_dir`.
Adding a region is adding its config and its `.dev.vars`; `wrangler.test.jsonc`
binds D1 *without* a `migrations_dir` and is correctly not a region.


### Verifying one

`pnpm db:baseline:verify` reads `sqlite_schema` from every discovered region and
compares the **migration chain** against each, and the regions against each
other. It never reads a row of production data. With `-- --record` it writes
`production-fingerprint.json`, which `scripts/d1-baseline.test.mjs` compares
against on every run — so the answer stays enforced without credentials.

That offline comparison replays the chain **truncated at the migration the
recording names**, not the whole chain. Recording needs Cloudflare credentials
and needs the migration to already be live, so fingerprinting everything on disk
would redden `pnpm test:scripts` on every migration pull request with no repair
short of merging and deploying it first. What the recording covers stays
enforced; what production has not been given yet is not asserted about. The
recording may lag the chain, but it may never name a migration this checkout no
longer has, and the regions it lists must still be the regions discovered — both
are separate assertions in that suite.

The chain rather than a baseline, deliberately. A baseline describes its own
boundary, so once a migration lands above it, comparing the baseline to
production would report that migration as drift. The baselines are tied in
separately and offline: `baseline + everything after it` reproduces the chain,
asserted for **every** baseline in `packages/db/test/baseline-migration.test.ts`.
Chain equals production here, baseline equals chain there, so baseline equals
production by composition — and each half is checked where it can be.

## Invariants

- **A baseline only ever applies to an empty database.** It carries no migration
  history of its own, so applying it over existing tables would merge two schemas
  with no record explaining either, and applying it over a partially migrated
  database would record every subsumed migration as applied when some had not
  been. Both are unrecoverable without dropping the database.
- **The migration chain stays authoritative and complete.** Deleting a migration
  because a baseline subsumes it would leave every hosted database that has not
  run it with no description of how to get there. A baseline is an addition.
- **Hosted databases never apply a baseline.** The migrate script passes
  `allowBaseline: false` for `--remote`, so the plan cannot be `baseline` — one
  line, stated once, rather than a rule living in whichever script you ran. If a
  baseline ever reached production it would collide with the schema already
  present, and the guard would refuse it — loudly, mid-deploy.
- **A baseline is chosen by calculation, never by name.** Anything that reaches
  for "the baseline" — a hardcoded filename, `baselines[0]`, the manifest's only
  entry — breaks the moment a second one exists, and breaks silently, by using a
  snapshot that stops short of where it could have reached.
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

Nothing outside `scripts/migrate-d1.mjs` decides whether a baseline
applies, and nothing but Wrangler ever applies a migration or writes a ledger row
for one.

## Failure modes and limits

- **Seeded rows are inserted in foreign-key order, and a cycle is refused.**
  `sqlite_schema` order is alphabetical, which has nothing to do with what
  references what, so a child whose name sorts before its parent's was inserted
  first and the file died on `FOREIGN KEY constraint failed` — naming no table,
  and partway through, leaving a database with schema, no ledger, and no way
  forward but a manual drop. Only seeded tables are ordered; an empty parent
  constrains nothing. A cycle among seeded tables has no working order, since D1
  does not allow `PRAGMA defer_foreign_keys`, so generation stops.
- **Volatility is decided by value, and BLOBs are compared by content.** SQLite
  returns a fresh `Uint8Array` per read, so `!==` reported every seeded blob as
  moving in every row — and the generator refused, citing a `datetime('now')`
  that was not there. Any future value type read back as an object needs the
  same treatment.
- **A generated column is never inserted, and a wide integer never crashes.**
  `SELECT *` returns `GENERATED ALWAYS AS` columns and `INSERT` rejects them, so
  the column list comes from `pragma_table_xinfo` with the generated ones
  removed; SQLite recomputes them. Rows are read as BigInt and narrowed back to
  numbers where that is exact, so an id beyond 2^53 survives instead of throwing
  from inside the reader.
- **A value's storage class is preserved, not just its JavaScript value.**
  There is one number type in JavaScript, so `2.0` and `2` render the same and
  SQLite stores the result as an INTEGER. A declared `REAL` column is rescued by
  affinity; a typeless or STRICT `ANY` column is not, and `typeof()` filters
  change underneath. `sqlLiteral` takes SQLite's own `typeof()` and emits `2.0`
  where it must.
- **Text `wrangler d1 execute --file` would rewrite is refused.** Its
  `trimSqlQuery` is a substring test: any file containing `BEGIN TRANSACTION`
  has its first `BEGIN TRANSACTION;` **and its first `COMMIT;`** deleted —
  wherever they sit, including inside a comment, a trigger body, or a seeded
  string — and a second occurrence is a hard error. Both routes reach a baseline,
  since SQLite keeps comments written inside a `CREATE` body and seeded rows are
  copied verbatim, so the generator stops rather than let a database be quietly
  edited on the way in.
- **The guard fires.** The command fails with
  `CHECK constraint failed: baseline_requires_empty_database` and nothing of the
  baseline's schema is created. The database is left as it was — apart from the
  guard table and an empty `d1_migrations`, both inert. The ledger is created
  before the guard runs, so a database that had tables but no ledger keeps one
  afterwards; it holds no rows and changes no decision, because the wrapper
  gates on the table count. D1 rejects `CREATE TEMP TABLE`
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
  normalizes comments and whitespace away first.
- **That normalization does not protect quoted literals, knowingly.** It runs
  regular expressions over the whole statement, so it cannot tell a comment from
  the characters `--` inside a string literal, nor significant whitespace inside
  one from trivia between tokens: `DEFAULT '--a'` and `DEFAULT '--b'`
  fingerprint identically, as do `'a  b'` and `'a b'`. When it bites,
  `pnpm db:baseline:verify` reports `match` on a drifted database and `--record`
  writes that drift in as the new truth — and there is no second comparator
  behind this one, since the PRAGMA suite covers baseline-versus-chain rather
  than baseline-versus-production. It is accepted because reaching it needs
  production to have drifted from the migrations at all, *and* for that drift to
  sit exclusively inside a quoted literal; anything else is still caught. A
  lexer that copies quoted tokens verbatim is the fix, written and reverted as
  more machinery than that residue of risk warranted. Nothing in the schema
  triggers it today — a CHECK enumerating a value containing `--`, or a default
  with a doubled space, would be the first, and is the point to reconsider.
  `packages/db` pins the collision in a test named for it, so the limitation
  fails loudly if someone silently fixes it.
- **`pnpm db:baseline:verify` needs Cloudflare credentials** and is not a CI
  gate. The recorded fingerprint is what keeps its result enforced.
- **Ordering is Wrangler's, not JavaScript's.** Anything that compares migration
  names with `<`, `>` or a bare `.sort()` is wrong for an unpadded filename:
  `89_backfill.sql` is below `0090_boundary.sql` for Wrangler and above it for a
  string compare. When those two disagree, the subsumed set never changes, so the
  manifest digest never changes, the baseline stays "usable", and the database
  silently differs from a replay — the digest cannot be the backstop for a
  hazard it cannot see. Use `compareMigrationPaths`.
- **State the chain leaves that is not schema and not a row still has to be
  reproduced.** `sqlite_sequence` is the live example: AUTOINCREMENT never
  reissues an id, so re-inserting the surviving rows leaves the counter at the
  highest *surviving* id and a baselined database hands out ids the chain
  retired. It is snapshotted explicitly, because it is excluded from the object
  list as internal.
- **A migration inserted below what a database already ran gives it a different
  schema.** Wrangler applies whatever is missing in sort order without regard to
  what ran before, so a file added below an applied one runs late on an old
  database and early on a fresh one. It is silent where the file only `ALTER`s —
  the column lands in a different position, both migrations succeed, and only
  the column order differs — and a hard failure where it creates something a
  later migration already used. A baseline does not cause this but makes it
  easier to meet: a baselined database is fresh by construction, so it takes the
  fresh ordering while production takes the late one. `planMigration` reports it
  as `outOfOrder` and the migrate script prints it; it is not refused, because
  the repair is a decision about migrations — renumber, or accept — that the
  tooling cannot make.
- **Volatility detection has a one-second window.** The two replays are
  separated by 1.1s, so anything coarser than a second — `date('now')`, a
  month or billing-period stamp, a truncated day — is identical across both runs
  and frozen into the file as a literal. Widening the gap does not fix it: the
  detector can only see what changes between two runs. A seeded column whose
  value is derived from a coarse clock has to be recognised by the person
  writing the migration, not by the generator.
- **A volatile column must be within ten minutes of generation.** The renderer
  writes one expression, `datetime('now')`, and the `YYYY-MM-DD HH:MM:SS` shape
  does not distinguish that from `datetime('now', '+1 day')` — so the value is
  also required to *be* roughly now, and a modifier coarse enough to matter
  stops generation by name. An offset smaller than that window stays
  undetectable, for the same reason as the item above.
- **A manifest state only a bad merge produces is skipped, not resolved.** A
  boundary appearing twice — both branches regenerated, the merge kept both —
  has no right answer, and the comparator never returns 0 for equal boundaries,
  so which one "won" was a sort artifact that flipped with input order. Both are
  dropped and the chain runs. A manifest entry whose `.sql` is not on disk (the
  hunk merged, the file never staged) is dropped for the same reason.
- **A region may not declare its own `migrations_table`.** Wrangler reads the
  ledger from `migrations_table || "d1_migrations"`, while the baseline
  hardcodes `d1_migrations` in its guard and its ledger rows — and one baseline
  serves every region, so a per-region ledger cannot be represented at all.
  `discoverRegions` refuses a config that sets it to anything else.
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

The **warm** path pays for the question rather than the answer, and it is the one
setup takes on every session after the first. Asking a database what it holds
costs one `wrangler d1 execute` start-up per region, so `pnpm db:migrate` on an
already-migrated pair went from about 8.6s to about 13.7s on the sandbox. The
ledger count is deliberately skipped once a database has tables — it cannot
change the answer there, and counting it anyway roughly tripled the warm path
instead of adding to it. Anything that adds a third query to this path is
spending that budget again.

## Testing

| Suite | Covers |
| --- | --- |
| `scripts/d1-baseline.test.mjs` (`pnpm test:scripts`) | Boundary and naming rules, the staleness digest, volatile-column detection, SQL literals, rendering order, the internal-table rule, wrangler output parsing, and parity with the recorded production fingerprint. |
| `scripts/migrate-d1.test.mjs` (`pnpm test:scripts`) | Selection, planning, region discovery, and the CLI — but mostly **behaviour**: it builds real migration chains, generates real baselines from them, applies the resulting plan to real SQLite, and asserts the database matches a full replay. |
| `packages/db/test/baseline-migration.test.ts` (`pnpm --filter @rally/db test`) | What the file does when executed: equivalence against a real chain replay, the guard, the ledger, volatile stamping, and a migration applied on top. |

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
pnpm test:scripts && pnpm --filter @rally/db test
```

Delete the previous baseline file in the same change — there is one at a time,
because a second would be a dead file that still has to pass the equivalence
suite.

If `pnpm db:baseline:verify` reports a mismatch, a hosted database differs from
the migrations. That is an incident in the schema, not in the baseline; do not
regenerate to make it pass.

## Changelog

### 2026-08-22 — The digest is now the only guard on a subsumed migration

**What changed:** `packages/db/test/migrations.test.ts` was deleted, so the
manifest digest and `baseline-migration.test.ts` are what stand behind the
subsumed chain. The "considered and rejected" note above no longer cites that
file as a reason squashing is unsafe; the manifest pins the same filenames.

**Why:** a per-migration assertion cannot catch a change to an immutable file
that the digest does not catch first. See the entry in
[`data-model.md`](data-model.md#changelog) for the full reasoning.

**What a future change has to respect:** moving the boundary is now the only way
a migration stops being covered *and* stops being digest-guarded at the same
time. Regenerating the baseline is still never the fix for a failing baseline
test.

### 2026-08-22 — Hold the config and the seeded clock to what they actually claim

**What changed:** `stripJsonComments` drops trailing commas, so the JSONC
Wrangler accepts is the JSONC discovery accepts. A region whose `migrations_dir`
resolves anywhere but the shared chain is refused, the way a custom
`migrations_table` already was. A volatile column must hold a value that *is*
roughly the generation time, not merely one shaped like a timestamp. And both D1
scripts launch pnpm through `pnpmExecutable()`, which is `pnpm.cmd` on Windows.

**Why:** each was a valid input the tooling rejected, or an invalid one it
accepted. Discovery parses every `wrangler.*.jsonc` before choosing a region, so
one trailing comma anywhere failed local migration, hosted migration and
baseline verification for every region at once — and a trailing comma is not a
mistake in a file Wrangler reads with a real JSONC parser. `migrations_dir` was
read only as the marker that a binding is migratable and then discarded, while
everything downstream planned against `packages/db/migrations`: a region naming
a different directory would have been handed this chain's baseline and ledger
rows and then had another chain applied on top, with each half internally
consistent and nothing to compare them. The volatile check was the worst of the
three, because the shape `YYYY-MM-DD HH:MM:SS` does not distinguish
`datetime('now')` from `datetime('now', '+1 day')`: detection found the column,
the renderer wrote back the wrong expression, and the equivalence suite strips
volatile columns from both sides before comparing, so nothing offline could see
a value a day out.

**Considered and rejected:** *requiring an explicit supported expression per
volatile column*, declared in the manifest. That is the thorough fix and it adds
a surface someone has to maintain in step with the migrations. Comparing the
observed value against the actual generation time needs no declaration and
cannot fall out of date: the snapshot was taken seconds earlier, so any modifier
coarse enough to matter puts the value far outside the window.

**Consequences:** a volatile column is now required to be within ten minutes of
generation, so a seed computed with a modifier stops the generator by name
rather than being silently rewritten — but an offset *smaller* than that window
is still undetectable, alongside the coarse-clock limitation the 1.1-second
replay gap already has. Both are recorded under failure modes. `discoverRegions`
takes a `migrationsDirectory` so a test can build a throwaway `apps/api`; the
repository's own configs are held to the real directory by their own test.

### 2026-08-22 — Keep every gate repairable, and make the diagnostics reachable

**What changed:** the offline production-parity assertions replay the chain
truncated at the migration `production-fingerprint.json` was recorded through,
and treat that migration as a floor rather than an equality; the recorded region
list is now asserted against the discovered one. `manifest.objectCounts` and
`seededRowCounts` are asserted against a snapshot-only database rather than
against baseline-plus-later-migrations. `inspectDatabase` reads the ledger
whenever it exists, including on a database that already has tables, and the
hosted inspection warns rather than throwing. Four latent defects are fixed:
`stripJsonComments` stepping over escapes instead of looking one character back,
`sqlite_sequence` read with `setReadBigInts`, `sqlLiteral` not appending `.0` to
an exponent-form REAL, and a refusal for seeded TEXT that SQLite hands back
truncated at an embedded NUL.

**Why:** two of these gates had no reachable repair. Pinning the fingerprint to
the newest migration on disk meant any pull request adding `0091_*.sql` reddened
four assertions whose only sanctioned fix — `pnpm db:baseline:verify -- --record`
— needs credentials *and* needs that migration already deployed, which cannot
happen before its own pull request merges. The manifest counts describe the
snapshot file, so measuring them against a database that also has the migrations
above the boundary applied fails the day one adds a table: verified at 43 tables
against a recorded 42. Neither failure says anything about whether a baseline is
correct, and a gate that goes red for a reason nobody can act on gets suppressed
rather than read. Separately, `outOfOrder` and `unknownApplied` were written for
established databases and production, and both were unreachable there because
the ledger was skipped whenever user tables existed.

**Considered and rejected:** *unifying the region set inside `sync-dev-env.mjs`*,
which discovery made inconsistent with the env files it writes. That script
carries per-region ports and `_GLOBAL`/`_EU` key suffixes a discovered region has
no answer for, and it is on every developer's first command of the day; a
precondition in the migrate script that names the missing file and the reason
removes the obscure failure at a fraction of the risk. Unifying them is the real
fix and is still owed. Also *keeping the ledger read off the warm path* for its
one wrangler start-up: the command already spends several, and the alternative
was two checks that could never fire.

Manifest anomalies that force a chain replay — a baseline file missing from
disk, a boundary claimed twice — are now reported rather than only dropped,
because their symptom is a slow setup rather than an error.

**Consequences:** `production-fingerprint.json` is now re-recorded on its own
schedule rather than as a step in a migration's pull request, and a migration
merged but not yet deployed is legitimately outside what the offline check
asserts. Anything comparing a manifest count must say which database it means —
the snapshot, or the snapshot plus what followed. A hosted `pnpm db:migrate` no
longer fails when the pre-flight inspection does, so a silent inspection warning
in `deploy-api.yml` is expected output rather than a problem; the apply itself
still fails loudly. Generation now refuses two more shapes it cannot render
faithfully, and both refusals exist because the alternative was a file that
applies cleanly and is wrong.

### 2026-08-22 — Order migrations as Wrangler does, and reproduce the state a snapshot was losing

**What changed:** `compareMigrationPaths` replicates Wrangler's own comparator
and is used everywhere migration names are ordered or compared. Seeded rows are
emitted in foreign-key order and a cycle among them is refused. `sqlite_sequence`
is snapshotted and restored. Volatility compares BLOBs by content. Virtual tables
stop generation instead of being rendered alongside the shadow tables they create
for themselves. `packages/db/test/baseline-migration.test.ts` re-derives the same
comparator rather than importing it — the suite exists to check the generator
from independent evidence — and asserts that the set its own copy puts below a
boundary is the set the manifest records, so the two cannot drift apart in
silence.

**Why:** an adversarial pass over the generator found five ways an ordinary
migration produces a wrong or unappliable database, none of which any test or
guard caught. The worst was the ordering: this tooling compared names as strings
while Wrangler compares the leading integer first, so a single unpadded filename
sits below a boundary for Wrangler and above it for us. The subsumed set does not
change, so the manifest digest does not change, so the baseline stays usable and
the database silently diverges from a replay — and the `outOfOrder` check written
for exactly that hazard missed it because it compared as strings too. Two
docstrings claimed protection that did not exist: the digest's "however that file
sorts", and `assertEveryObjectRenderable` naming migrations 0036/0037 and
claiming the generator stops on FTS5. It did not; it rendered them.

**Considered and rejected:** *enforcing zero-padded filenames* instead of
matching Wrangler's order. That polices one shape of the divergence rather than
removing it, leaves the tooling and Wrangler disagreeing in principle, and would
reject a name Wrangler handles perfectly well. Matching the comparator makes the
two agree by construction. Also *refusing when a table uses AUTOINCREMENT*
rather than snapshotting `sqlite_sequence` — D1 permits writing that table
directly (verified against local D1), so refusing would block a legitimate
feature to avoid work that turned out to be four lines.

**Consequences:** the generator's job includes knowing what `wrangler d1 execute`
will do to the file afterwards, not only what SQLite will do with it — the
`BEGIN TRANSACTION` refusal exists because Wrangler edits the text it is given.
Nothing may compare migration names with `<`, `>` or a bare
`.sort()`; `compareMigrationPaths` is the only ordering, and it is a copy of
Wrangler's, so if Wrangler changes its comparator this has to follow rather than
be argued with. Anything the chain leaves behind that is neither schema nor a
table row — `sqlite_sequence` today — has to be snapshotted explicitly, because
the internal-table filter hides exactly that class from the object list. Values
read back as objects need content comparison, not `!==`. The current baseline is
byte-identical after all five fixes: every one of these was latent, and the
tests, not the artifact, are what changed.


### 2026-08-21 — One migrate script, discovered regions, and a calculated baseline

**What changed:** `scripts/migrate-local-region.mjs` and the raw Wrangler remote
aliases became one script, `scripts/migrate-d1.mjs`, covering every region local
or hosted. Regions are discovered from `apps/api/wrangler.*.jsonc` rather than
listed. The manifest holds a list of baselines, and which one a database gets is
calculated — the highest boundary still describing the chain — with everything
above it applied on top. The hosted "never baseline" rule became a parameter
rather than a separate code path.

**Why:** the first version hardcoded `["global", "eu"]` in one script and named
one baseline out of a manifest that could only hold one. Adding a third region
meant editing a list plus four package aliases; adding a second baseline was not
possible at all, and the code that would have had to choose between them did not
exist. Both are things this repository will do — a baseline is only worth having
if it can move forward — and neither would have failed loudly: a missing region
is a database nobody migrated, and a wrongly chosen baseline is a slow setup, not
an error.

**Considered and rejected:**

- *Keeping the local and hosted scripts separate*, on the grounds that the
  hosted path must never baseline. That rule is better served by being visible:
  as two scripts it lived in which command you happened to run, and as
  `allowBaseline: false` it is one line with a test on it.
- *Having the script compute pending migrations for `--list` too.* The deploy
  workflow pipes that output into `classify-pending-d1-migrations.mjs`, which
  reads every migration filename it sees as pending and gates a production
  deploy on the answer. `--list` delegates to Wrangler verbatim so that gate
  keeps keying off Wrangler's own answer rather than a reimplementation of it.
- *Replacing the older baseline when a new one is generated.* Keeping both costs
  a file and lets `selectBaseline` fall back when the newest is invalidated by a
  migration inserted below its boundary — which is exactly when a fallback is
  worth having.

**Consequences:** a migration inserted below one a database already applied is
reported (`outOfOrder`) rather than refused, and anything that starts treating
that as an error has to answer what a developer mid-branch is supposed to do
about it. Nothing may reach for "the baseline" by name, index, or
"the only entry" — `selectBaseline` is the only way to choose one, and anything
else silently uses a snapshot that stops short of where it could reach. A region
is defined by a Wrangler config whose D1 binding declares `migrations_dir`; a
config that binds D1 without one is deliberately not a region, so
`wrangler.test.jsonc` stays out. The plan reports `pending: null` when the ledger
was not read, and callers must not render that as zero — an earlier version
filled it in as "every migration is pending", which read as alarming nonsense on
a fully migrated database. Remote verification compares the *chain* to
production, not a baseline, so it stays correct once migrations land above a
boundary.

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
  names, the manifest pins those filenames and their digest, the
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

**Consequences:** Schema comparison knowingly does not protect quoted literals —
see **Failure modes and limits**, and reconsider it the first time a migration
puts `--` or a doubled space inside one. The generator refuses rather than
guesses in two places, and
both are load-bearing: an object type it cannot render (a view) would otherwise
vanish from the baseline with nothing offline to catch it, and a volatile column
`datetime('now')` could not have produced would be silently retyped, since every
downstream check either strips volatile columns before comparing or reads schema
without rows. A new object type or a control row seeded with another expression
is a generator that stops and a person who teaches it, not a baseline that is
quietly wrong. `packages/db/baselines/` is generated output — regenerate it,
never edit it, and never regenerate it to make a failing test pass. Anything that
decides whether a database is "empty" must use `internalTableExclusionSql()`
rather than writing its own predicate, or the wrapper and the guard will
eventually disagree and the disagreement will only appear against a real local
database. A migration added at or below the current boundary — `0084_*.sql` is
the live example, since the sequence skips it — fails the digest test on purpose;
the fix is a new boundary and a regenerated baseline, not a suppressed
assertion. The baseline must be regenerated and re-verified whenever the boundary
moves. `production-fingerprint.json` is re-recorded on its own schedule — after a
deploy, when it is worth re-establishing that production still matches the chain,
and necessarily when a region is added or removed — never as a step in a
migration's own pull request, which cannot have the credentials or the deployed
migration that recording requires.

Shipped in the pull request for `claude/local-sandbox-migration-tboqdg`.
