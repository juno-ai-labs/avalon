import { partitionSkillCatalog, type SkillSummary } from "@juno-ai/bind/skills";
import {
  DEFAULT_SKILL_CATALOG_TOKENS,
  renderSkillCatalogSections,
  skillCatalogLineCost,
} from "@rally/prompts/harness/skill-catalog";

export interface RenderPromptSkillCatalogInput {
  activeSkillRefs: ReadonlySet<string>;
  skills: readonly (SkillSummary & { recommended?: boolean })[];
  maxCatalogTokens?: number;
}

/**
 * The skill catalog section's body: Bind decides which entries fit the budget,
 * and the prompt package words them.
 */
export function renderPromptSkillCatalog(input: RenderPromptSkillCatalogInput): string {
  if (!input.skills.length) return "";
  const recommended = new Set(input.skills.filter((skill) => skill.recommended).map((skill) => skill.ref));
  const { active, loadable, truncated } = partitionSkillCatalog(input.activeSkillRefs, input.skills, {
    tokenBudget: input.maxCatalogTokens ?? DEFAULT_SKILL_CATALOG_TOKENS,
    cost: (summary, detail) => skillCatalogLineCost(summary, detail, recommended.has(summary.ref)),
  });
  return renderSkillCatalogSections({ active, loadable, truncated, recommended });
}
