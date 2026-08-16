# Gate report — convex

**Verdict: PASS** (operator compliance gate, 2026-08-16) — with two patches
requested before the judge pass.

- Sections: 11/11 present, in order, filled.
- Word cap: ~2,400–2,600 prose words excluding tables (cap 2,800). OK.
- Citations: 6 spot-checked; 5 confirmed exactly (action limits incl. 30-min
  Convex-runtime cap, EU region page, pricing rates, EU launch post with the
  30% uplift and no-included-allowances caveat, realtime snapshot-consistency
  claim). 1 partial — see patch 2.
- Scope: clean toward other candidates' substance; one optional softening —
  the §9 comparative dig at the DO design.
- Hazards: 11/12 addressed; see patch 1. Notably #3 (pull-read amplification)
  is correctly ruled inapplicable — content rides the socket — and #10 is
  verified against the documented 30-minute action cap.
- Required specifics: all present, including both cost points ($675 / ~$10.2k),
  a 10-product-week migration answering both the Hono Worker fate and the
  Electron connection-model change, IaC dashboard/ticket-only disclosures, and
  an honestly-UNKNOWN EU DPA layer over a verified real EU region.

Requested patches (small, before judging):
1. **Hazard #9 is silently skipped.** "Clients can only invoke exported
   functions" answers raw data-plane access, not the actual question: what
   rate-limits an authenticated-but-hostile client per principal — which is
   also a cost exposure at $2/M calls. Add the mechanism (per-principal
   limiter) or argue inapplicability explicitly.
2. **The auth-scoped cache claim reads as cited fact but is an assumption.**
   The cited query-functions page documents cache sharing per identical
   query+args only — it says nothing about auth-scoping. The sentence is
   load-bearing for the revocation section. Tag it inline as assumption A5 /
   UNKNOWN, or find a citation that actually states it.

Optional: state how accumulated streaming delta chunks are compacted at seal
(hazard #2 asks "prices and compacts"); soften the §9 DO comparison.
