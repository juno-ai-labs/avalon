# Bounding Avalon's agent chains with `@juno-ai/bind`

Applying Monad's orchestration learnings to Avalon's harness-run graph.

Written against Avalon `d99a127` and **`@juno-ai/bind@6.0.0`**.

Supersedes an earlier draft of this file that planned a phase-by-phase swap of
harness *internals* (watchdog, deadline, schema sanitizer). That work is still
worth doing and is tracked separately in [`MONAD_REUSE.md`](./MONAD_REUSE.md);
it is not what this document is about. This one is about orchestration: what
starts a run, what a run is allowed to start, and what stops the graph running
away.

---

## The finding

**Avalon has run lineage with no bound on it, and a feedback cycle that nothing
counts.**

`harness_runs` already carries `parent_harness_run_id`
(`packages/db/migrations/0001_initial.sql:288`) and `launchHarness` already
accepts a parent (`apps/api/src/services/workstream-service.ts:627`). What is
missing is everything that makes a parent pointer useful: no depth, no chain
root, no admission check anywhere. A `grep` for depth/chain/spawn concepts
across `apps/` and `packages/` returns nothing.

That would be latent if runs could only be started by people. They cannot. The
cycle is:

```
harness run
  → agent calls a connector WRITE tool     (github.issues.create, linear.create_comment,
                                            notion.create_comment, google.gmail.send, …)
  → provider emits a webhook               (github.issue.opened, github.issue_comment.created, …)
  → Avalon records an activity             (activities row, processing_status='pending')
  → activity-consumer matches automations  (connector_activity / semantic_activity triggers)
  → WORKSTREAM_LOOP_WORKFLOW.create        (apps/api/src/queues/activity-consumer.ts:596)
  → harness run
```

Every arrow exists today. The write tools and the emitted event types line up
one-to-one on every major connector — `github.issues.create` produces
`github.issue.opened`; `linear.create_comment` produces a Linear comment
webhook; `notion.create_comment` produces a Notion comment activity;
`google.gmail.send` produces a Gmail message activity. `connector_activity` and
`semantic_activity` triggers exist to watch exactly those
(`activity-consumer.ts:457`, `:468`).

Nothing in that loop counts hops. The only guard on the activity path is
`dedupe_key` / `raw_content_hash` (`integrations.ts:1424-1474`), which prevents
the *same* activity being processed twice — it says nothing about a genuinely
new activity the agent itself just caused. Each new comment is a new activity
with a new hash.

**Status of this claim:** the cycle is structurally reachable in the default
configuration — Avalon contributes every granted tool of every healthy workspace
connector to every work stream, so the write tools are present whenever the
connector is. I am reporting a verified structural cycle, not an observed
incident. Before building anything, run the query in "Phase 0" to find out
whether it has already happened.

## Why the cheap fix does not work

The obvious mitigation is echo suppression: `activities.actor_json` exists
(`0001_initial.sql:112`), so drop any activity whose actor is Avalon.

**It cannot be made to work, and the reason is worth stating because it is the
argument for doing the chain properly.** Avalon does not have its own identity
at the provider. Connector writes go through per-connection stored OAuth
credentials — the *user's* grant. The agent's Linear comment is authored by the
user's Linear account and is byte-identical in `actor_json` to the same user
typing that comment by hand. Suppressing by actor suppresses the user's genuine
actions, which is a worse bug than the one it fixes.

You cannot filter the cycle by who. You have to bound it by how far.

---

## What Monad learned, and how each piece maps

Monad's chains are internal — a run spawns a run, and the spawn site knows its
parent. Avalon's cycle leaves the process, goes through a third party, and comes
back. That difference changes one thing (§3 below) and nothing else: the graph
is the same graph, and `admitChildRun` judges it the same way.

**`6.0.0` is the first release that can express Avalon's rules.** `5.0.0` shipped
four `ChainRule` kinds; `6.0.0` adds `pair_seen` and `tenant_rate`, which are
precisely the two Avalon needs — repeat-pair suppression and a workspace-level
rate ceiling on the human-triggered case. Pin `6.0.0` exactly, not `^6.0.0`:
bind's version stamps the *next major* of the public mirror, so a major bump
carries no breakage signal and semver ranges are uninformative.

### 1. Lineage is three columns, not one

Monad carries `chain_depth`, `chain_root_run_id`, `chain_parent_run_id`. Avalon
has only the parent, and **the parent alone cannot bound a chain — only a hop.**

The rule that is easy to get backwards, and which `descendChain` encodes:
**null means me.** A root run's root and parent are both `null`, because a
chain's origin has no id to point at until its own row exists. Read any chain's
root as `rootRunId ?? runId`. Adopting the *parent's* id as the root at every
level instead makes each generation its own chain, and every per-chain bound
then counts the wrong set and silently never fires. Monad states this as an
invariant because getting it wrong produces a system that looks bounded and is
not.

### 2. Admit before the run exists, never after

> *A chain bounded only once its runs are on the queue is not bounded, it is
> billed.*

`admitChildRun` judges counts the host supplies and returns a decision; it does
no I/O. In Avalon it goes **before** the `INSERT INTO harness_runs` in
`launchHarness` (`workstream-service.ts:633`) and **before**
`WORKSTREAM_LOOP_WORKFLOW.create` in the activity consumer
(`activity-consumer.ts:596`).

### 3. The Avalon-only problem: the parent link is not automatic

This is the one place Monad's design does not transfer directly. In Monad the
spawning code knows the parent run. In Avalon, by the time the webhook comes
back the causal link is gone — the activity knows which provider resource
changed, and nothing knows which run changed it.

So the chain needs a **provenance carry**: when a connector write succeeds,
record `(provider, provider_resource_id) → harness_run_id`, and have the
activity consumer look up that mapping to find the parent run before it starts a
new one. The hook already exists — `tool_invocations.provider_operation_id`
(`0001_initial.sql:310`) is written on every tool invocation and is where the
provider's resource identifier belongs.

Without this, every automation-started run looks like a root and every chain
bound reads depth 0 forever. **This phase is load-bearing: the admission checks
in §2 are decoration until provenance works.** It is also the phase most likely
to be partially correct — a provider that reports a different resource id on the
webhook than it returned on the write breaks the join for that connector alone,
silently. Build it connector by connector with a test per connector, and treat
an unresolvable parent as depth 0 plus a metric, not as an error.

### 4. Omit-vs-sentinel: two failures that must not be conflated

- A rule whose measurement came back **broken** (`NaN`, negative) **refuses** —
  every comparison is false against `NaN`, so the naive reading of a broken
  count is an unbounded chain.
- A rule the host **could not measure at all** (the D1 query threw) is expressed
  by **omitting it from the array**, which admits.

Passing `NaN` to mean "unknown" collapses the two and turns a transient D1 blip
into every agent in the workspace refusing to run. The judgement is the host's:
decide it in the `catch` at each call site by choosing whether to append the
rule. Monad's tenant rate limit fails open this way, with a test pinning it.

### 5. `retryable` is worth more in Avalon than it is in Monad

`admitChildRun` returns `rule` (which bound fired) and `retryable` (whether
waiting could change the answer). Monad **drops** `retryable` — nothing
downstream of its activation pipeline waits, so the field has no reader there.

Avalon is different, and this is a genuine improvement rather than a port.
Cloudflare Queues retry with a delay, and the activity consumer already uses it:
`message.retry({ delaySeconds: 30 })` at `activity-consumer.ts:199`. So the
mapping is direct and useful:

| Refusal | Rules | Queue action |
|---|---|---|
| `retryable: true` | `pair_cooldown`, `tenant_rate`, `tenant_ceiling` | `message.retry({ delaySeconds })` — the bound clears on its own |
| `retryable: false` | `depth`, `chain_budget`, `pair_seen` | ack and record; retrying burns the budget for no chance of success |

Retrying a non-retryable refusal is the failure mode to avoid: a `depth` refusal
retried every 30 s costs a queue slot forever and can never succeed.

### 6. The depth-0 case is unbounded and needs its own rule

Monad's depth, pair, and budget rules only guard `chain_depth > 0`. The
human-triggered case — a message flood, a single mention fanning out — was
unbounded until a separate per-tenant rate limit was added. Avalon's equivalent
is `tenant_rate` over the workspace: count every harness run the workspace
created in a rolling window and refuse new depth-0 starts past a ceiling
generous enough to trip only on a runaway.

### 7. Human input resets the chain

A human message resets the chain to depth 0, so people can always re-engage
after a chain is capped. Avalon can already express this: `launchHarness` takes
an `origin`, and `human_message` / `opening_message` / `elicitation_answer` are
exactly the origins that should reset, while automation origins descend.

### 8. The decision is the harness's; the measurement is the host's

Monad's `circuit-breakers.ts` is now a pure measurement layer — it runs the
queries and hands `admitChildRun` a `ChainRule[]`. Avalon's equivalent runs D1
queries and does the same. Keep the comparisons out of it; that is the whole
point.

---

## Mistakes Monad made — do not re-make them

These are all bugs Monad shipped and has since fixed. Each is cheap to avoid up
front and expensive to find later.

**One decider, from day one.** Monad ended up with the same depth comparison
hand-rolled at *three* entry points, free to drift, and nothing noticed until a
review. Avalon has two entry points today (`launchHarness`, the activity
consumer) and §3 adds a third code path. Route all of them through
`admitChildRun` immediately — the cost of consolidating later is a review that
finds it.

**Ordering becomes load-bearing the moment you derive a span.** Monad's
cooldown query used an unordered `LIMIT 1`. That was harmless while the query
only tested *existence*, and became wrong the instant `msSinceLastSpawn` was
derived from the returned row — an arbitrary match reports the wrong elapsed
time, and it errs toward **admitting**, because an older row inside the window
looks like more time has passed. Any Avalon cooldown query needs
`ORDER BY created_at DESC, id DESC` — the id breaks a same-timestamp tie so the
pick is total.

**Sample the clock once.** Monad took `Date.now()` twice — once for the window
bound, once for the elapsed span. A row that barely satisfied
`created_at >= cutoff` could, milliseconds later, evaluate as outside the window
and admit. One `now`, used for both.

**Decide the free rule before spending queries — and mind the cleanup path.**
Monad's refactor lost a short-circuit: depth was decided before any query, and
after the change a throw in a *later* count aborted the whole call instead of
returning the refusal, which skipped the caller's cleanup and stranded a
pre-created run in `pending` until a reaper found it. Avalon has the identical
shape: `launchHarness` inserts the row, then starts the workflow, with a `catch`
that marks it `failed` (`workstream-service.ts:658-661`). Evaluate the DB-free
depth rule first and return on it.

**Depth 0 is not depth `-1`.** `admitChildRun` counts from the *parent*, so a
host that stores the child's depth passes `depth - 1`. At depth 0 that is `-1`,
which trips the negative-measurement guard and refuses **every root run**. Omit
the depth rule entirely at depth 0 rather than inventing a parent. Monad shipped
this and caught it only because a test ran against a real database — the
in-memory path hid it.

**Refusal strings reach people.** Monad's original pair-cooldown message
interpolated both agents' user ids and the thread id, and that string surfaced
to every member who could read the thread. `bind`'s refusals are worded without
identifiers for this reason. Whatever Avalon does with `admission.reason`,
assume a person reads it — and branch on `admission.rule`, never on the prose.

---

## Phases

### Phase 0 — measure before building

Do not skip this. It decides how much of the rest is urgent.

```sql
-- How deep do existing chains actually go?
WITH RECURSIVE chain(id, root, depth) AS (
  SELECT id, id, 0 FROM harness_runs WHERE parent_harness_run_id IS NULL
  UNION ALL
  SELECT r.id, c.root, c.depth + 1
    FROM harness_runs r JOIN chain c ON r.parent_harness_run_id = c.id
)
SELECT depth, COUNT(*) FROM chain GROUP BY depth ORDER BY depth DESC;

-- Automation-started runs per workspace per hour — the depth-0 ceiling's input.
SELECT workspace_id, substr(created_at, 1, 13) AS hour, COUNT(*)
  FROM harness_runs WHERE origin NOT IN ('human_message','opening_message','elicitation_answer')
 GROUP BY 1, 2 HAVING COUNT(*) > 20 ORDER BY 3 DESC;
```

The first tells you whether chains exist at all today (they may not, since
nothing sets the parent except elicitation answers). The second sizes
`tenant_rate` from real traffic instead of a guess. **Set every limit from these
numbers, not from Monad's** — Monad's 5 / 500 / 100-per-30 s were tuned against
a different workload.

### Phase 1 — lineage columns

One migration, `0025_harness_run_chain_lineage.sql` (next free prefix; `0024` is
the highest committed). Keep it to **one file** — the columns, the backfill, and
the index are one coherent change and belong in one transaction.

```sql
ALTER TABLE harness_runs ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE harness_runs ADD COLUMN chain_root_run_id TEXT REFERENCES harness_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS harness_runs_chain_idx ON harness_runs(chain_root_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS harness_runs_workspace_created_idx ON harness_runs(workspace_id, created_at DESC);
```

Idempotency: SQLite has no `ADD COLUMN IF NOT EXISTS`, so guard each `ALTER` on
`pragma_table_info` or accept that the runner records applied migrations and
never re-runs one. Existing rows correctly default to depth 0 with a null root —
"null means me" makes that the right reading of history rather than a lie.

Wire `descendChain` / `rootChain` from `@juno-ai/bind/run` into `launchHarness`
so the three columns are written together and cannot disagree.

### Phase 2 — admission at both entry points

A measurement module (`apps/api/src/services/chain-safety.ts`) that runs D1
counts and returns `admitChildRun(rules)`. Both `launchHarness` and the activity
consumer call it before creating anything.

Rules, in evaluation order (first refusal wins, so this order chooses which
reason a person sees):

| Rule | Measurement | Refuses when |
|---|---|---|
| `depth` | `chain_depth - 1` (omit at depth 0) | the chain has gone as many hops as allowed |
| `pair_seen` | a prior run in this chain with the same `(automation, workstream)` | this pair already ran once in this chain |
| `chain_budget` | `COUNT(*)` over `chain_root_run_id` | the chain has spent its total run budget |
| `pair_cooldown` | `now - most recent matching run` | the same pair ran within the cooldown |

Per §4, each measurement's `catch` decides omit-or-refuse explicitly.

### Phase 3 — provenance carry

The load-bearing one (§3). Record the provider resource id on write, resolve it
on the way back in, use it as `parent_harness_run_id`. Per connector, with a
test per connector, and an unresolvable parent means depth 0 plus a metric —
never a thrown error.

### Phase 4 — workspace rate ceiling

`tenant_rate` over the workspace, sized from Phase 0's second query, on the
depth-0 path only. Fails **open** (§4): a D1 error omits the rule.

### Phase 5 — refusal → queue disposition

Map `retryable` onto `message.retry` vs ack (§5), and surface `rule` in the
work-stream event so a person sees why the agent stopped rather than silence.

**Ordering.** Phase 0 gates everything. Phases 1 → 2 are strictly sequential.
Phase 3 can be built in parallel with 2 but makes 2 *effective*, so neither is
finished without the other. Phases 4 and 5 are independent of 3.

---

## Open questions

1. **Do chains exist in production today?** Phase 0's first query answers it. If
   the answer is "only elicitation answers", the cycle is real but cold, and
   this becomes preventive work with a calmer schedule rather than a fix.
2. **Does every write connector return a resource id that matches the one its
   webhook reports?** Phase 3 is only as good as that join. Unknown per
   connector until tested; assume at least one does not.
3. **What should a refused automation run look like to a person?** Monad posts
   the message and suppresses only the trigger. Avalon's equivalent — show the
   activity, skip the run, say why — needs a product decision before Phase 5.
4. **Should the provenance model flow back into `bind`?** Avalon's cycle through
   a third party is a shape Monad does not have. If Phase 3's
   `(provider, resource) → run` resolution generalizes, it is a candidate
   contribution — `bind` currently assumes the spawn site knows its parent.
