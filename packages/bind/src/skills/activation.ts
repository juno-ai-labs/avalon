import type { ResolvedSkillInstructions } from "./resolve";
import type { SkillSummary, SkillWarn } from "./types";

/**
 * Progressive knowledge disclosure — the skill half of `plugins/activation.ts`.
 *
 * The controller does one thing and refuses to do a second: it adds refs to the
 * run's active set, resolves the bodies, records the hash pin, and hands the
 * full resolved set back. It **never touches the transcript**. The system
 * message is a pure render of run state, so a host re-renders it from the
 * instructions it is given rather than splicing a marker or mutating a string
 * in place — the difference shows up the first time a run is resumed and the
 * spliced text is already there twice.
 */

/**
 * The skill read path, injectable. The other half of the source — the Tier-1
 * catalog — is the `availableSkills` array, so a host customizes both
 * independently: an in-memory store for a test, an isolated one-skill store for
 * an always-on persona, the real registry plus its database for a live run.
 */
export interface SkillStore {
  resolveActiveInstructions(activeRefs: string[]): Promise<ResolvedSkillInstructions>;
}

export interface SkillActivation {
  /**
   * Activate skills for this run: admit the refs that are in the catalog,
   * resolve the bodies for the **whole** active set, pin their hashes, and hand
   * the instructions to `applyInstructions`.
   *
   * Resolution covers the whole set rather than the delta because the caller
   * re-renders one section from the result; a delta would make it the caller's
   * job to concatenate in the right order, which is the ordering guarantee the
   * resolver exists to own. A call that admits nothing new is a no-op.
   */
  activateSkills(refs: Iterable<string>): Promise<void>;
}

export interface SkillActivationParams {
  /** This run's Tier-1 catalog — the set a ref must be in to be activatable. */
  availableSkills: readonly SkillSummary[];
  /**
   * Caller-owned active-ref set, mutated in place.
   *
   * Owned by the caller because two other things read it: conversation assembly
   * seeds it before the first turn (it is what the initial catalog renders as
   * active), and the host persists it when the run ends.
   */
  activeSkills: Set<string>;
  /**
   * Caller-owned ref → `contentSha` pin, grown on each activation.
   *
   * Also caller-owned, and for a sharper reason: a host hoists it above the try
   * block so the terminal-path catch can still persist what the run had loaded.
   * A pin the controller owned would be lost on exactly the failed runs an eval
   * most wants to reproduce.
   */
  loadedSkillShas: Record<string, string>;
  store: SkillStore;
  /**
   * Called after each activation that changed the set, with the freshly
   * resolved bodies for the full active set.
   */
  applyInstructions: (instructions: string[]) => void;
  onWarn?: SkillWarn;
}

export function createSkillActivation(params: SkillActivationParams): SkillActivation {
  const { activeSkills, loadedSkillShas, store, applyInstructions } = params;
  const availableRefs = new Set(params.availableSkills.map((summary) => summary.ref));

  return {
    async activateSkills(refs) {
      const admitted: string[] = [];
      for (const ref of refs) {
        // The catalog is the authorization boundary for reading a skill: it is
        // already gated on the agent's plugins and the host's scope, so a ref
        // outside it is refused here rather than resolved and then filtered.
        if (!availableRefs.has(ref)) {
          params.onWarn?.("refusing to activate unavailable skill", { ref });
          continue;
        }
        if (!activeSkills.has(ref) && !admitted.includes(ref)) admitted.push(ref);
      }
      if (admitted.length === 0) return;

      // Resolve against the *would-be* set, and commit only if that succeeds.
      //
      // Adding first is the obvious order and it is wrong. A store that throws
      // — a database blip, an external source that times out — would leave the
      // caller's set claiming the skill is active while `applyInstructions`
      // never ran, so the body is not in the prompt. The retry then finds
      // nothing new to admit and returns early, and the run finishes with a
      // catalog that lists a skill as loaded whose instructions the model never
      // saw. Failing cleanly is what makes a retry able to fix it.
      const next = new Set(activeSkills);
      for (const ref of admitted) next.add(ref);

      const { instructions, shas } = await store.resolveActiveInstructions([...next]);
      for (const ref of admitted) activeSkills.add(ref);
      Object.assign(loadedSkillShas, shas);
      applyInstructions(instructions);
    },
  };
}
