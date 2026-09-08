import { partitionSkillCatalog, type SkillSummary } from "@juno-ai/bind/skills";

const DEFAULT_SKILL_CATALOG_TOKENS = 2_500;

export interface RenderPromptSkillCatalogInput {
  activeSkillRefs: ReadonlySet<string>;
  skills: readonly SkillSummary[];
  maxCatalogTokens?: number;
}

function catalogText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\r\n]+/gu, " ");
}

function skillLine(skill: SkillSummary, namesOnly: boolean): string {
  if (namesOnly) return `- ${catalogText(skill.name)}`;
  const hint = skill.whenToUse ? ` — ${catalogText(skill.whenToUse)}` : "";
  return `- ${catalogText(skill.name)}: ${catalogText(skill.description)}${hint}`;
}

/**
 * Render the compact skill directory placed in an agent system prompt.
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
export function renderPromptSkillCatalog(input: RenderPromptSkillCatalogInput): string {
  if (!input.skills.length) return "";

  const { active, loadable, truncated } = partitionSkillCatalog(
    input.activeSkillRefs,
    input.skills,
    {
      tokenBudget: input.maxCatalogTokens ?? DEFAULT_SKILL_CATALOG_TOKENS,
      cost: (summary, detail) =>
        Math.ceil(skillLine(summary, detail === "name_only").length / 4),
    },
  );

  const sections: string[] = [];
  if (active.length) {
    sections.push(`Currently active:\n${active.map((skill) => skillLine(skill, false)).join("\n")}`);
  }
  if (loadable.length) {
    const lines = loadable.map((entry) => skillLine(entry.summary, entry.detail === "name_only"));
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
