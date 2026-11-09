import {
  SKILL_CATALOG_TOKEN_BUDGET,
  estimateSkillTokens,
  type SkillOrigin,
  type SkillSummary,
} from "./types";

/**
 * The Tier-1 catalog — what the model sees for every skill on every turn,
 * whether or not it ever loads one.
 *
 * This module returns **data, not prose**, exactly as `partitionPluginCatalog`
 * does and for the same two reasons: catalog wording is a product surface with
 * the host's voice, and it sits in the cacheable system prefix, where the host
 * needs byte-identical output for unchanged inputs or it loses the provider's
 * prompt cache for everything below it. What is genuinely shared is the
 * *ordering* and the *budget*, and both are here.
 */

/**
 * Origin precedence. Deployment-owned knowledge is described before
 * plugin-specific recipes, and both before what the workspace wrote — so the
 * general instruction is read before the specialization, and so the tail that
 * a budget demotes is the tail that grows without bound.
 */
const ORIGIN_RANK: Record<SkillOrigin, number> = {
  platform: 0,
  plugin: 1,
  tenant: 2,
};

/**
 * Total order over summaries: origin, then name, then ref.
 *
 * A **total** order, not just a stable one: `ref` is the unique tiebreak so two
 * skills that collide on name still sort deterministically. Both the catalog
 * and the injected instruction bodies use this comparator, which is what keeps
 * the system prompt byte-stable across a fresh run and a resumed one — the
 * active set is persisted in load order, and rendering in *that* order would
 * shift the prefix on every resume.
 */
export function compareSkillSummaries(a: SkillSummary, b: SkillSummary): number {
  return (
    ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] ||
    a.name.localeCompare(b.name) ||
    a.ref.localeCompare(b.ref)
  );
}

/** How much of a skill's catalog entry survived the budget. */
export type SkillCatalogDetail = "full" | "name_only";

export interface SkillCatalogEntry {
  summary: SkillSummary;
  detail: SkillCatalogDetail;
}

export interface SkillCatalogPartition {
  /** Already loaded. Always rendered in full — the body's cost is already paid. */
  active: SkillSummary[];
  /** Loadable, each marked with the detail the budget allows. */
  loadable: SkillCatalogEntry[];
  /** How many loadable entries were demoted to `name_only`. */
  truncated: number;
}

export interface SkillCatalogOptions {
  /** Defaults to {@link SKILL_CATALOG_TOKEN_BUDGET}. */
  tokenBudget?: number;
  /**
   * Cost of one entry at a given detail, in tokens. Defaults to an estimate of
   * `- name: description — whenToUse`.
   *
   * A host that renders a different line should pass its own: the budget is
   * only as honest as its measurement, and a default that under-counts a
   * verbose format silently overruns the prefix it was meant to protect.
   */
  cost?: (summary: SkillSummary, detail: SkillCatalogDetail) => number;
}

function defaultCost(summary: SkillSummary, detail: SkillCatalogDetail): number {
  if (detail === "name_only") return estimateSkillTokens(`- ${summary.name}`);
  const hint = summary.whenToUse ? ` — ${summary.whenToUse}` : "";
  return estimateSkillTokens(`- ${summary.name}: ${summary.description}${hint}`);
}

/**
 * Split the catalog into active and loadable, demoting the loadable tail to
 * names only once the budget is spent.
 *
 * **Demote, never drop.** A skill the model cannot see is a skill it cannot
 * ask for, and a workspace's library grows past any budget worth setting. A
 * bare name still routes: it is enough for the model to call `load_skill` and
 * read the real description. The host is expected to say so in the line it
 * renders for the truncated tail — `truncated` is there to let it.
 *
 * The active set is charged against the budget but never demoted: those bodies
 * are already in the prompt, so shortening their catalog lines would save
 * nothing that matters while hiding what the agent is currently working from.
 */
export function partitionSkillCatalog(
  activeSkills: ReadonlySet<string>,
  available: readonly SkillSummary[],
  options: SkillCatalogOptions = {},
): SkillCatalogPartition {
  const budget = options.tokenBudget ?? SKILL_CATALOG_TOKEN_BUDGET;
  const cost = options.cost ?? defaultCost;

  const ordered = [...available].sort(compareSkillSummaries);
  const active = ordered.filter((summary) => activeSkills.has(summary.ref));
  const loadableSummaries = ordered.filter((summary) => !activeSkills.has(summary.ref));

  let spent = active.reduce((total, summary) => total + cost(summary, "full"), 0);
  let truncated = 0;
  const loadable = loadableSummaries.map<SkillCatalogEntry>((summary) => {
    const full = cost(summary, "full");
    if (spent + full <= budget) {
      spent += full;
      return { summary, detail: "full" };
    }
    truncated += 1;
    return { summary, detail: "name_only" };
  });

  return { active, loadable, truncated };
}
