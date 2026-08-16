# Gate report — supabase

**Verdict: PASS** (operator compliance gate, 2026-08-16) — one §7 fix
requested before judging.

- Sections: 11/11 present, in order, filled. ~1,840 prose words (cap 2,800).
- Citations: 6/6 spot-checks confirmed (Realtime limits and billing counting,
  Cloudflare Workflows limits, WorkOS third-party auth doc, pricing page
  rates, compute-resize downtime note). Cost arithmetic reproduces from the
  brief's own assumptions with the corrected send-plus-per-receiver counting.
- Scope: clean; explicitly disclaims conversation-model credit.
- Hazards: 12/12 addressed; consistent with every verified vendor fact.
- Review-findings coverage (this candidate's extra burden): all six
  Blocker/High findings handled — auth federation **resolved by switching to
  WorkOS AuthKit**; EU long-model-turn conceded via fail-closed (no 400 s
  Edge driver ships); Realtime quota named, budgeted (S≈278 crossing point),
  and tripwired at 60%; O(n²) checkpoints resolved with append-only deltas;
  read amplification budgeted at both sizing points; the backend-rewrite
  scope conceded explicitly ("a backend re-platform, not a database URL
  change") with the Hono Worker retained as the API surface.
- Honest unknowns: seven properly formed UNKNOWN-with-resolver statements.

Requested fix (small, before the judge pass):
1. §7's IaC coverage table names compute resizes as dashboard-only but omits
   **Realtime msg/s quota raises as support-ticket-only residue** (disclosed
   in §8/§9, but the template requires it in the §7 table). Add the row.

Notes for rebuttal round (not defects): the combined "Workers + D1 +
Workflows $28/$453" cost line rolls three metered products into one figure
with only partial derivation in §11; the ~$100 PITR row is unverified.
