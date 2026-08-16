# Known hazards and verified facts

Distilled from the critical review of the Supabase PRD (see
`docs/PRDs/2026-08-15_supabase-workspace-workstream-conversations/review.md`
on this branch) and vendor documentation verified 2026-08-16. Address the
applicable hazards inside your template sections (§2 constraints, §3 UX, §7
IaC) — do not add a new section. The judge cross-checks briefs against this
list; an unaddressed applicable hazard scores as unknown, and re-asserting a
refuted claim scores worse.

## Verified vendor facts (checked against official docs, 2026-08-16)

Cite-or-contradict these; do not silently assume otherwise. Limits change —
re-verify anything load-bearing for your candidate.

- **Supabase Realtime** evaluates channel authorization at join and caches it
  for the connection; there is no documented bound on a removed user's
  already-joined channel. Rate limits are project-wide (2,500 msg/s at
  Team/Pro-uncapped), raisable only by unpublished support negotiation.
  Billing counts a broadcast as one send **plus one per receiver**.
  `realtime.send` is documented to swallow its own errors — a failed broadcast
  cannot abort its enclosing transaction.
- **Supabase Edge Functions**: 400 s wall / 150 s request-idle / 2 s CPU /
  256 MB. **Supabase Cron**: 1 s minimum interval, ≤8 concurrent jobs
  recommended, ≤10 min per job. **Supabase Auth** is project-scoped; external
  identity federation supports exactly five named vendors (Clerk, Firebase,
  Auth0, Cognito, WorkOS) — no generic OIDC, no Supabase-to-Supabase.
  **Supabase Storage** bytes are outside database backups/PITR. Compute is
  vertical-only, topping at 16XL (64 vCPU / 256 GB, ~$3,730/mo).
- **Cloudflare Workflows** (paid): unlimited step wall time, 1 MiB step
  payloads, 10,000 steps default (to 25,000), 1 GB state; the limits page
  currently contradicts itself on concurrent instances (table 50,000,
  footnote 10,000) — plan on 10,000.
- Today's stack facts advocates for staying put may use: outgoing Durable
  Object WebSocket frames are unbilled; hibernating idle objects cost
  nothing; R2 egress is free.

## Design hazards — provider-neutral, learned the hard way

For each applicable hazard: name your mechanism and its failure mode, or
state why it does not apply to your architecture.

1. **Event-cursor allocation.** Clients recover by "events after N", so N must
   be monotonic per work stream. Allocating under the entity's write lock puts
   streaming checkpoints (2–4 Hz) on the same lock as user writes; allocating
   from a sequence admits late-committing lower numbers that a caught-up
   client will permanently miss. Name your side and its mitigation (e.g. a
   server-attested scanned-through watermark).
2. **Growing-buffer durability.** Re-saving an accumulating text buffer every
   tick is O(n²) in bytes written (log/replication/backup all carry it).
   Standing decision: append-only deltas. Say how your storage engine prices
   and compacts them.
3. **Pull-read amplification.** If your revocation stance forbids content on
   sockets, every viewer is 2–4 authorized reads/sec against the store. Show
   the arithmetic at the decision frame's sizing point.
4. **One authority for the steering revision.** Interrupt state duplicated
   across tables/services diverges exactly when it matters. Name the single
   compare-and-set point that decides whether a stale attempt may commit.
5. **Interrupt latency bound.** When the fast notification path is lost, what
   bounds the time until generation visibly stops — and is that bound a
   number or "next database fence, possibly minutes"?
6. **Sparse per-user state defaults.** Per-person overlays (unread, mentions)
   won't have a row per user × work stream. Define what a missing row means
   and the indexed query shape for "Unread" for a member with no rows.
7. **Append-only tables vs. retention.** Event/activity logs grow forever;
   partitioning retrofitted onto a table with a global unique cursor key is a
   rewrite. Decide the partition/retention scheme up front and state how
   cursor semantics survive it.
8. **Fan-out metering.** State how your realtime layer counts messages
   (send vs. per-receiver), the published ceiling and its scope
   (channel/project/account), and the *published* path past it.
9. **Direct-data-plane abuse.** If clients reach the store without an app
   tier, name what rate-limits an authenticated-but-hostile client per
   principal — statement timeouts alone are not an answer.
10. **The long model turn.** A single streaming inference call can run >6
    minutes and is not resumable by provider reference. Any bounded executor
    (function timeouts, step limits) must either host it whole or name the
    product consequence of aborting it.
11. **Driver dispatch latency.** Per-continuation overhead (poll ticks, queue
    hops, cold starts) × steps-per-loop compounds against the 1–5 s
    time-to-first-token target. Give the per-step overhead of your loop
    driver.
12. **Deploy/migration ordering.** State whether your design has a window
    where old code writes into a new schema (today's stack does — see
    template §7) and how it is closed.

## Required reading by role

- **Every advocate**: this file; `docs/architecture.md` and the invariants in
  `docs/data-model.md` on this branch — the migration plan (§5) is judged
  against what actually exists, and "what happens to the Hono Worker" must be
  answered from knowledge, not guesses.
- **The Supabase advocate**: the full review at
  `docs/PRDs/2026-08-15_supabase-workspace-workstream-conversations/review.md`.
  Your brief inherits its burden — findings there must be resolved, mitigated,
  or conceded, not re-asserted.
- (The former current-stack seat was removed by owner decision — see the
  README's field decision. The measured pains recorded in
  `docs/PRDs/2026-08-12_per-workspace-databases/prd.md`'s Motivation remain
  useful background on why the migration constraint exists.)
