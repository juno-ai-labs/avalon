/** The line under a skill's resource list that says how to read one. `escapedName` is already attribute-escaped. */
export function renderSkillResourceHint(escapedName: string): string {
  return `Read a resource with read_skill_resource("${escapedName}", path).`;
}
