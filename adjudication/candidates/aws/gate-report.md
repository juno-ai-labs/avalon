# Gate report — aws

**Verdict: PASS** (operator compliance gate, 2026-08-16)

- Sections: 11/11 present, in order, filled. Per-section caps hold.
- Word cap: ~1,790 prose words excluding tables (cap 2,800). OK.
- Citations: 6/6 spot-checked URLs exist and support their claims (AppSync
  pricing and invalidation semantics, Aurora pricing, Lambda durable
  invocations, Cognito pricing, Data API writer limitation).
- Scope: clean — no cross-candidate attacks, no conversation-model claiming.
- Hazards: 12/12 addressed; no contradiction of verified vendor facts.
- Required specifics: all present, including both revocation stances priced at
  both sizing points, a 12-product-week migration estimate answering the Hono
  Worker question, and dashboard/ticket-only IaC disclosures (Service Quotas
  approvals, fixed invalidation quota, Cognito console consent).
- Honest-unknowns: nine explicit UNKNOWNs with resolutions. Strong.

Cosmetic defects (fix optional, not blocking; may be raised in rebuttals):
1. §4 prose totals ($945 / $13,340) disagree with table totals ($943 /
   $13,339) by rounding — make them agree.
2. §2 row 1 asserts streaming checkpoints coalesce *before* user commands
   queue behind them at overload, but no mechanism gives user commands
   priority on the shared row lock; either name the mechanism or soften the
   claim.
