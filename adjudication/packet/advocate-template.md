# Advocate brief template — one candidate substrate

Fill every section, in order, within the caps. A section you cannot fill with
cited facts gets "UNKNOWN — <what would resolve it>", which scores better than
confident vagueness. Total cap: 2,500 words excluding tables. You may not
argue about the conversation model (it ships regardless) or about other
candidates (that's the rebuttal round).

## 1. The stack, named exactly (≤150 words)

Every service/product with its exact name and pricing page URL: database,
realtime fan-out, job queue, loop driver (durable execution), blob storage,
search/vector, auth, and what runs the API tier. If a piece is "we build it,"
say so — it counts against simplicity, not against honesty.

## 2. Hard constraints (table, one row each)

For each of the nine constraints in cost brief §6 (as adjusted by the decision
frame): the mechanism that satisfies it, and a citation to official docs.
"Postgres row locks" or "DO single-threading" level of specificity.

## 3. UX proxies (the seven, one short paragraph each)

Mechanism-level answers per the decision frame. For proxy 1 and 5, give
numbers with worst cases. State which revocation stance (immediate vs bounded
staleness) your numbers assume, and give the other stance's delta.

## 4. Cost (two numbers + a table)

Monthly platform cost at the 10k-user point (S≈20) and at S=300, per the cost
brief's demand model and assumptions register. Itemized: base plans, compute,
fan-out/messages, storage, egress, durable execution, auth MAU, fixed add-ons
(backups/PITR-equivalent, staging). List-price citations for every rate. State
what is included allowance vs metered vs "contact sales".

## 5. Migration plan (≤400 words + a week count)

From today's stack (per-region Cloudflare Worker + D1 + R2 + Durable Objects +
Workflows, Electron client): what is rewritten, what is kept, the cutover shape
at ~zero users, and a **product-weeks estimate of velocity freeze** with the
assumptions behind it. The API-tier question must be answered explicitly: what
happens to the existing Hono Worker surface?

## 6. Operations at team-size-small (≤200 words)

What pages at 2am; how many distinct technologies must someone understand to
debug end-to-end; what the inspection story is (can you query production state
with SQL or equivalent?); backup/restore drill effort.

## 7. Top three risks (one paragraph each)

Including at least one "this assumption might be false" risk with its
probability and blast radius. Every dependency on undocumented behavior,
private beta, or negotiation ("contact support to raise limits") must appear
here.

## 8. What breaks first (≤150 words)

At growing S, name the first binding constraint and whether the fix is money,
configuration, or architecture. A candidate that hides its dead end loses to
one that names it.

## 9. Tripwires (3–5 bullets)

Measurable triggers that should reopen this decision if your candidate wins.

## 10. Assumptions register

Every number you introduced that isn't a cited list price.
