/**
 * The skill vocabulary — the *knowledge* sibling of `src/plugins/tool.ts`.
 *
 * A skill is a markdown-shaped procedure or reference module, disclosed to a
 * model in three tiers: a one-line catalog entry it always sees (Tier 1), a
 * body injected into the system prompt once loaded (Tier 2), and bundled
 * resources it may read after loading (Tier 3). That progression is the whole
 * point: a workspace's accumulated know-how does not fit in a context window,
 * and a catalog line costs ~50 tokens where a body costs thousands.
 *
 * Two sources of skill exist and they differ in exactly one way — where the
 * body comes from. A **code skill** is registered from the deployment's own
 * source (see {@link SkillDef}) and its body is a build artifact; an
 * **external skill** is data the host stores and can edit at runtime. The
 * harness owns the first entirely and knows nothing about the second beyond
 * the shape it resolves to, which is why {@link SkillSummary} is the only type
 * both sides share.
 */

/**
 * Where a resolved skill came from.
 *
 * - `platform` — code-registered and unowned: available to every agent.
 * - `plugin` — code-registered and contributed by a tool plugin: available
 *   only to an agent that can load that plugin, since a recipe for tools the
 *   agent cannot call is noise.
 * - `tenant` — authored in the **host's data store** rather than in code. The
 *   name is Monad's (a tenant is its workspace unit) and is kept because it is
 *   the value hosts already persist and render; read it as "host-managed".
 *
 * The order is also the precedence order — see `compareSkillSummaries`.
 */
export type SkillOrigin = "platform" | "plugin" | "tenant";

/** `reference` = inline text the model reads; `asset` = an opaque blob, summarised rather than inlined. */
export type SkillResourceKind = "reference" | "asset";

/**
 * A Tier-3 resource bundled with a code skill. Code-skill resources are static
 * assets of the deploy artifact, so their text is a function rather than a
 * handle: `render()` is called to hash the resource at registration and again
 * to read it. Binary `asset` resources belong to host-stored skills, where
 * there is somewhere to put the bytes.
 */
export interface SkillResourceDef {
  /** Relative path, e.g. `references/spec.md`. Unique within the skill. */
  path: string;
  /** Always `reference` for a code skill — there is no blob store in a build artifact. */
  kind: Extract<SkillResourceKind, "reference">;
  /** MIME type, e.g. `text/markdown`. */
  contentType: string;
  /** The inline text body. Must be deterministic: it feeds the content hash. */
  render: () => string;
}

/**
 * A code-registered skill — what a plugin contributes or a standalone module
 * registers. `render()` must be deterministic for a given build: its output is
 * hashed into the skill's `contentSha`, which is what pins an eval or a replay
 * to the exact instructions a run actually saw.
 */
export interface SkillDef {
  /** Lower-kebab; unique across a registry. */
  name: string;
  /** Tier-1 catalog line: what the skill does. */
  description: string;
  /**
   * Activation hint appended to the catalog line — when to reach for this.
   * Required for a code skill: without it the catalog line says what the skill
   * is but not when it applies, which is the half that decides routing.
   */
  whenToUse: string;
  /**
   * Set for a plugin-contributed skill. Filled by the registration path from
   * the owning plugin's name rather than read from the def — see
   * `createSkillRegistry`.
   */
  ownerPlugin?: string;
  /** The Tier-2 markdown body. */
  render: () => string;
  /** Tier-3 bundled reference resources. */
  resources?: SkillResourceDef[];
}

/**
 * The Tier-1 projection every source resolves to — the analogue of
 * `PluginSummary`. The catalog and the activation set are both built from
 * these, so neither has to know whether a skill came from code or from the
 * host's store.
 */
export interface SkillSummary {
  /**
   * The activation ref: what a host persists as the run's active-skill set.
   * `platform:<name>` for a code skill (see `refs.ts`), the host's own opaque
   * identifier for an external one. One namespaced form spans both sources
   * without ambiguity; the catalog still renders the plain `name`.
   */
  ref: string;
  /** Lower-kebab identifier, unique within the resolved catalog. */
  name: string;
  /** Tier-1 catalog line. */
  description: string;
  /** Optional activation hint, appended to the catalog line. */
  whenToUse: string | null;
  /** Set for a plugin-contributed skill (and for a host skill that shadows one). */
  ownerPlugin: string | null;
  /** Which of the three sources this came from. */
  origin: SkillOrigin;
}

/** A registered code skill, as the registry hands it back. */
export interface RegisteredSkill {
  def: SkillDef;
  /** `platform` (standalone) or `plugin` (contributed). Never `tenant`: code only. */
  origin: Extract<SkillOrigin, "platform" | "plugin">;
  /** The owning plugin's name for a `plugin` skill; null for `platform`. */
  ownerPlugin: string | null;
  /** Content hash over every version-defining input, computed at registration. */
  contentSha: string;
}

/** A Tier-3 resource as the catalog and the wrapper see it — metadata, not bytes. */
export interface SkillResourceRef {
  path: string;
  kind: SkillResourceKind;
  /** Size in bytes. Rendered only for `asset`, which is never inlined. */
  bytes: number;
}

/**
 * A skill body resolved for injection, whatever its source. The host's
 * external source returns these; the registry-backed code path produces them
 * internally.
 */
export interface ResolvedSkillBody {
  name: string;
  ownerPlugin: string | null;
  /**
   * Monotonic revision for a host-stored skill, rendered into the wrapper so
   * the model can cite what it read. `null` for a code skill, whose version
   * history is the deployment's source control rather than a number.
   */
  version: number | null;
  body: string;
  /** The content hash pinned into the run's `loadedSkillShas`. */
  contentSha: string;
  resources: SkillResourceRef[];
}

// ---------------------------------------------------------------------------
// Bounds
//
// Every one of these bounds the *prompt*, not a database. They are defaults: a
// host passes its own where the call takes one. What they must not be is
// absent — an unbounded catalog and an unbounded active set are the two ways a
// skill library silently degrades every run in the deployment rather than
// failing one of them.
// ---------------------------------------------------------------------------

/**
 * Rough token budget for the Tier-1 catalog. Past it the catalog demotes its
 * overflow to names only rather than dropping entries: a name the model can
 * still pass to `load_skill` beats a skill it cannot discover at all.
 */
export const SKILL_CATALOG_TOKEN_BUDGET = 2500;

/**
 * Max skills one session may hold loaded at once. The count half of the active
 * bound — cheap to check before anything is resolved.
 */
export const SKILL_MAX_ACTIVE_PER_SESSION = 12;

/**
 * Combined token budget for all loaded bodies. The other half of the active
 * bound, and the one that actually protects the context window: twelve small
 * skills are fine and three large ones are not, so a count cap alone does not
 * bound the prompt.
 */
export const SKILL_MAX_ACTIVE_BODY_TOKENS = 40_000;

/**
 * Characters per token, for every estimate in this module. Deliberately crude:
 * these budgets choose between "render the line" and "render the name", and a
 * real tokenizer would cost more than the decision is worth.
 */
export const SKILL_CHARS_PER_TOKEN = 4;

/** The module's shared estimator. */
export function estimateSkillTokens(text: string): number {
  return Math.ceil(text.length / SKILL_CHARS_PER_TOKEN);
}

/**
 * Observe something the harness will otherwise carry on past — a name
 * collision, a pinned body that has drifted, an activation of a skill that is
 * not in the catalog. A port rather than a logger because the package has no
 * opinion about where a host's warnings go, and because a test needs to see
 * them without scraping stdout.
 */
export type SkillWarn = (message: string, fields: Record<string, unknown>) => void;
