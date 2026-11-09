/**
 * Activation refs.
 *
 * A run persists which skills are loaded, and the set spans two sources whose
 * identifiers cannot be told apart by shape — a code skill has a name, a
 * host-stored skill has whatever id the host mints. Namespacing the code side
 * makes the union unambiguous with one string comparison and no lookup, which
 * matters because the resolver has to route every ref before it knows whether
 * either source has it.
 *
 * The prefix is part of the persisted format. Changing it strands every stored
 * active-skill set and every `loadedSkillShas` pin recorded against one.
 */

/** The namespace every code-registered skill's ref carries. */
export const PLATFORM_SKILL_REF_PREFIX = "platform:";

/** Build the activation ref for a code-registered skill name. */
export function codeSkillRef(name: string): string {
  return `${PLATFORM_SKILL_REF_PREFIX}${name}`;
}

/** True if a ref points at a code-registered skill rather than a host-stored one. */
export function isCodeSkillRef(ref: string): boolean {
  return ref.startsWith(PLATFORM_SKILL_REF_PREFIX);
}

/** Extract the skill name from a code-skill ref (`platform:foo` → `foo`). */
export function codeSkillNameFromRef(ref: string): string {
  return ref.slice(PLATFORM_SKILL_REF_PREFIX.length);
}
