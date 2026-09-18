import { createHash } from "node:crypto";

/**
 * Which split a case belongs to, decided by its id and nothing else.
 *
 * Deterministic and content-free so the split cannot move:
 * `docs/jev-best-practices.md` requires the development and holdout sets to be
 * fixed *before* tuning, and a split derived from a shuffle, a timestamp, or an
 * index would quietly follow whatever the corpus did next. Hashing the id means
 * adding a case never moves an existing one, and the same case is in the same
 * split on every machine.
 *
 * **An even split.** Half the corpus tunes and half is held out, which on 130
 * cases is about 65 each. The tuning half has to be big enough that a recurring
 * error class is visible as a class rather than as two cases — a boundary rule
 * inferred from two examples is a patch — and the held-out half has to be big
 * enough that a few points of difference is not one case changing its mind. At 65
 * apiece, one case is 1.5 points on either side, which is the resolution this
 * corpus honestly has: it can separate a large effect from nothing, and it cannot
 * adjudicate a two-point difference. The report says so rather than implying
 * otherwise.
 */
export function splitOf(caseId: string): "dev" | "holdout" {
  const digest = createHash("sha256").update(caseId).digest();
  return digest[0]! % 2 === 0 ? "dev" : "holdout";
}
