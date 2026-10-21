import { shouldNudge, type Answer, type EvalCase, type EvalResult } from "./evaluation";
import { needsCompletionVerification } from "../../src/completion-verification";
export { completionVerificationPrompt as verificationPrompt } from "../../src/completion-verification";

export const policies = ["strict", "uncertainty_fallback", "verify_once"] as const;
export type Policy = (typeof policies)[number];

/** A verification turn is not an instruction to replay side effects. The host
 * must persist its one-use marker per logical activation before injecting it. */

export function shouldReprompt(policy: Policy, example: Pick<EvalCase, "lifecycle" | "state">, answer: Answer | null, threshold = 0.5): boolean {
  if (policy === "strict") return shouldNudge(example, answer, threshold);
  // Unknown lifecycle is different from unavailable/uncertain JEV: the host
  // still has to establish that it has not already spent this recovery.
  if (example.lifecycle !== "ready") return false;
  if (policy === "verify_once") return true;
  return needsCompletionVerification(example.state, answer, threshold);
}

export function comparePolicies(results: EvalResult[], threshold = 0.5) {
  return Object.fromEntries(policies.map((policy) => {
    const checked = results.filter((r) => shouldReprompt(policy, r, r.answer, threshold));
    const positives = results.filter((r) => r.expectedNudge).length;
    const caught = checked.filter((r) => r.expectedNudge).length;
    return [policy, {
      cases: results.length, needsContinuation: positives, totalReprompts: checked.length,
      caught, missed: positives - caught, extraVerificationTurns: checked.length - caught,
      recall: positives ? caught / positives : null,
      bySuite: Object.fromEntries([...new Set(results.map((r) => r.suite))].map((suite) => {
        const selected = results.filter((r) => r.suite === suite);
        const checks = checked.filter((r) => r.suite === suite);
        const needed = selected.filter((r) => r.expectedNudge).length;
        const recovered = checks.filter((r) => r.expectedNudge).length;
        return [suite, { cases: selected.length, needsContinuation: needed, caught: recovered,
          missed: needed - recovered, extraVerificationTurns: checks.length - recovered }];
      })),
      bySplit: Object.fromEntries(["development", "holdout"].map((split) => {
        const selected = results.filter((r) => r.split === split);
        const checks = checked.filter((r) => r.split === split);
        const needed = selected.filter((r) => r.expectedNudge).length;
        const recovered = checks.filter((r) => r.expectedNudge).length;
        return [split, { cases: selected.length, needsContinuation: needed, caught: recovered,
          missed: needed - recovered, extraVerificationTurns: checks.length - recovered }];
      })),
    }];
  }));
}

/** Descriptive replay, not threshold selection on a fresh holdout. Higher
 * thresholds make strict less willing to reprompt, but fallback more willing. */
export function sweepConfidence(results: EvalResult[], thresholds: readonly number[]) {
  return thresholds.map((threshold) => ({ threshold, policies: comparePolicies(results, threshold) }));
}
