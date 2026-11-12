/** The fields of a skill the catalog renders; Bind's `SkillSummary` satisfies it. */
export interface CatalogSkill {
  ref: string;
  name: string;
  description: string;
  whenToUse: string | null;
}

export const DEFAULT_SKILL_CATALOG_TOKENS = 2_500;

function catalogText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\r\n]+/gu, " ");
}

function skillLine(skill: CatalogSkill, namesOnly: boolean, recommended = false): string {
  const badge = recommended ? " [Recommended]" : "";
  if (namesOnly) return `- ${catalogText(skill.name)}${badge}`;
  const hint = skill.whenToUse ? ` — ${catalogText(skill.whenToUse)}` : "";
  return `- ${catalogText(skill.name)}${badge}: ${catalogText(skill.description)}${hint}`;
}

/** What one entry costs at a given detail, in tokens: the budget Bind's partition spends. */
export function skillCatalogLineCost(skill: CatalogSkill, detail: "full" | "name_only", recommended: boolean): number {
  return Math.ceil(skillLine(skill, detail === "name_only", recommended).length / 4);
}

/**
 * Render the compact skill directory placed in an agent system prompt, from
 * the partition the harness computed with Bind's `partitionSkillCatalog`.
 *
 * The active/loadable split and the budget belong to Bind
 * (`partitionSkillCatalog`); the wording belongs here, because this text sits
 * in the stable system prefix that Avalon re-renders on every activation and
 * that must come out byte-identical for unchanged inputs.
 *
 * Overflow is demoted to names only rather than dropped: unlike the plugin
 * catalog, there is no `search_skills` to recover a hidden entry from, so a
 * name the model can still pass to `load_skill` is the whole fallback.
 */
export function renderSkillCatalogSections<Skill extends CatalogSkill>(input: {
  active: readonly Skill[];
  loadable: readonly { summary: Skill; detail: "full" | "name_only" }[];
  truncated: number;
  recommended: ReadonlySet<string>;
}): string {
  const { active, loadable, truncated, recommended } = input;
  const sections: string[] = [];
  if (recommended.size) sections.push("Recommended skills were selected for this conversation. Prefer them when relevant; call load_skill to use their instructions.");
  if (active.length) {
    sections.push(`Currently active:\n${active.map((skill) => skillLine(skill, false, recommended.has(skill.ref))).join("\n")}`);
  }
  if (loadable.length) {
    const lines = loadable.map((entry) => skillLine(entry.summary, entry.detail === "name_only", recommended.has(entry.summary.ref)));
    if (truncated > 0) {
      // `partitionSkillCatalog` returns demoted entries inside `loadable` with
      // `detail: "name_only"`, and every one is already rendered above as a bare
      // name — `truncated` counts those, not additional hidden skills. Saying "N
      // more" would tell the model half the catalog is withheld, inverting the
      // demote-never-drop property this fallback exists to provide.
      lines.push(
        `- (${truncated} of the entries above are shown by name only; call load_skill with the exact name to read the full description.)`,
      );
    }
    sections.push(`Available to load:\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}
